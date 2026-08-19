/**
 * SqliteChainRegistryStore (issue #788): stable chain IDs, DAG persistence,
 * revisions and fingerprints, aliases, synchronization metadata, and the
 * transaction guarantees the port promises.
 */
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteChainRegistryStore,
  buildFrozenPrefix,
  chainGraphFingerprint,
} from '../dist/index.js';

const NOW = '2026-08-08T10:00:00.000Z';
const LATER = '2026-08-08T11:00:00.000Z';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chain-registry-store-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  store = new SqliteChainRegistryStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createChain(overrides = {}) {
  const result = await store.createChain({
    sessionId: 's1',
    headIssueNumber: 777,
    now: NOW,
    ...overrides,
  });
  if (!result.ok) throw new Error(`createChain failed: ${result.code} ${result.detail ?? ''}`);
  return result.value;
}

function rowCounts() {
  const db = new Database(dbPath);
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return {
      chains: count('dependency_chain'),
      members: count('dependency_chain_member'),
      edges: count('dependency_chain_edge'),
      revisions: count('dependency_chain_revision'),
      aliases: count('dependency_chain_alias'),
    };
  } finally {
    db.close();
  }
}

/**
 * Await `promise` and hand back the value it rejected with.
 *
 * `expect(...).rejects.toThrow()` cannot be used for these: better-sqlite3
 * builds `SqliteError` with an ES5-style constructor, so its instances carry
 * no [[ErrorData]] slot and jest's `toThrow` declines to inspect them,
 * reporting "did not throw" for a promise that did in fact reject. Capturing
 * the rejection here keeps the assertion on the message SQLite actually
 * raised.
 */
async function rejectionOf(promise) {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (error) => error,
  );
}

describe('creation and stable identity', () => {
  test('a new chain defaults to the head issue as its id and its only member', async () => {
    const graph = await createChain();

    expect(graph.chain).toEqual({
      chainId: 'chain_777',
      sessionId: 's1',
      originIssueNumber: 777,
      headIssueNumber: 777,
      graphRevision: 1,
      graphFingerprint: chainGraphFingerprint({
        members: [{ issueNumber: 777, role: 'head' }],
        edges: [],
      }),
      syncStatus: 'unknown',
      createdAt: NOW,
      updatedAt: NOW,
      rev: 1,
    });
    expect(graph.members).toEqual([
      { chainId: 'chain_777', issueNumber: 777, role: 'head', addedAt: NOW },
    ]);
    expect(graph.edges).toEqual([]);
  });

  test('a colliding head issue gets the deterministic suffix, not a fresh id', async () => {
    expect((await createChain()).chain.chainId).toBe('chain_777');
    expect((await createChain()).chain.chainId).toBe('chain_777_2');
    expect((await createChain()).chain.chainId).toBe('chain_777_3');
  });

  test('an alias occupying the default id pushes allocation to the next suffix', async () => {
    await createChain({ headIssueNumber: 500 });
    await store.putChainAlias({ alias: 'chain_777', chainId: 'chain_500', now: NOW });

    // The handle namespace is shared, so `chain_777` is not available even
    // though no chain carries that id.
    expect((await createChain()).chain.chainId).toBe('chain_777_2');
  });

  test('an explicitly requested id that is already taken is refused rather than reallocated', async () => {
    await createChain({ chainId: 'chain_900' });
    const again = await store.createChain({
      sessionId: 's1',
      headIssueNumber: 777,
      chainId: 'chain_900',
      now: NOW,
    });
    expect(again).toEqual({
      ok: false,
      code: 'already_exists',
      detail: 'chain id already in use: chain_900',
    });
    expect(rowCounts().chains).toBe(1);
  });

  test('a requested name is registered by the same write that allocates the id', async () => {
    const graph = await createChain({ alias: 'auth-work' });

    expect(graph.chain.chainId).toBe('chain_777');
    expect(await store.resolveChainHandle('auth-work')).toBe('chain_777');
    expect(rowCounts().aliases).toBe(1);
  });

  test('a name taken between a caller\'s check and its write creates no chain at all', async () => {
    // The hazard the atomic claim exists for (issue #791 review): IDs and
    // aliases share one namespace, so a creation for head #500 can take the ID
    // a name asked for. A caller that registered the name afterwards would own
    // an accepted chain that can never carry it; refusing the whole creation
    // leaves a state a retry can leave.
    await createChain({ headIssueNumber: 500 });
    const refused = await store.createChain({
      sessionId: 's1',
      headIssueNumber: 777,
      alias: 'chain_500',
      now: NOW,
    });

    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('alias_taken');
    expect(rowCounts()).toEqual({ chains: 1, members: 1, edges: 0, revisions: 1, aliases: 0 });
    expect(await store.resolveChainHandle('chain_500')).toBe('chain_500');
  });

  test('an alias already registered to another chain refuses the creation too', async () => {
    await createChain({ headIssueNumber: 500 });
    await store.putChainAlias({ alias: 'auth-work', chainId: 'chain_500', now: NOW });

    const refused = await store.createChain({
      sessionId: 's1',
      headIssueNumber: 777,
      alias: 'auth-work',
      now: NOW,
    });
    expect(refused.code).toBe('alias_taken');
    expect(rowCounts().chains).toBe(1);
  });

  test('allocation walks past the name being claimed, so an id never shadows it', async () => {
    // `chain_777` is free, but it is the name this chain is about to carry: an
    // ID equal to its own alias would make the handle ambiguous and leave the
    // alias row unreachable through `resolveChainHandle`.
    const graph = await createChain({ alias: 'chain_777' });

    expect(graph.chain.chainId).toBe('chain_777_2');
    expect(await store.resolveChainHandle('chain_777')).toBe('chain_777_2');
  });

  test('an explicit id equal to the requested name is refused rather than half-registered', async () => {
    const refused = await store.createChain({
      sessionId: 's1',
      headIssueNumber: 777,
      chainId: 'chain_900',
      alias: 'chain_900',
      now: NOW,
    });
    expect(refused.code).toBe('alias_taken');
    expect(rowCounts()).toEqual({ chains: 0, members: 0, edges: 0, revisions: 0, aliases: 0 });
  });

  test('malformed creation input is refused before anything is written', async () => {
    expect((await store.createChain({ sessionId: '', headIssueNumber: 777 })).code).toBe('invalid_input');
    expect((await store.createChain({ sessionId: 's1', headIssueNumber: 0 })).code).toBe('invalid_input');
    expect(
      (await store.createChain({ sessionId: 's1', headIssueNumber: 7, chainId: 'not-a-chain-id' })).code,
    ).toBe('invalid_input');
    expect(
      (await store.createChain({ sessionId: 's1', headIssueNumber: 7, alias: 'not a name' })).code,
    ).toBe('invalid_input');
    expect(rowCounts()).toEqual({ chains: 0, members: 0, edges: 0, revisions: 0, aliases: 0 });
  });

  test('the chain id is a stable handle: moving the head never renumbers it', async () => {
    await createChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
    });

    const moved = await store.updateChainMetadata('chain_777', {
      headIssueNumber: 778,
      now: LATER,
    });

    expect(moved.ok).toBe(true);
    expect(moved.value.chainId).toBe('chain_777');
    expect(moved.value.headIssueNumber).toBe(778);
    // The number the id was derived from stays put, so the derivation is
    // still auditable after the head moves.
    expect(moved.value.originIssueNumber).toBe(777);
  });

  test('the head must name a member of the chain', async () => {
    await createChain();
    const moved = await store.updateChainMetadata('chain_777', { headIssueNumber: 999, now: LATER });
    expect(moved).toEqual({
      ok: false,
      code: 'invalid_graph',
      errors: [{ code: 'head_not_member', issueNumber: 999 }],
    });
  });
});

describe('DAG persistence', () => {
  test('a linear chain round-trips without loss', async () => {
    const graph = await createChain({
      headIssueNumber: 1,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }, { issueNumber: 3 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 3 },
      ],
    });

    const read = await store.getChain(graph.chain.chainId);
    expect(read.members.map((m) => m.issueNumber)).toEqual([1, 2, 3]);
    expect(read.edges.map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  test('fan-out and fan-in round-trip in the same graph', async () => {
    // 1 fans out to 2 and 3; both fan back in to 4.
    const graph = await createChain({
      headIssueNumber: 1,
      members: [1, 2, 3, 4].map((issueNumber) => ({ issueNumber })),
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 1, blockedIssueNumber: 3 },
        { blockerIssueNumber: 2, blockedIssueNumber: 4 },
        { blockerIssueNumber: 3, blockedIssueNumber: 4 },
      ],
    });

    const read = await store.getChain(graph.chain.chainId);
    expect(read.edges.map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])).toEqual([
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 4],
    ]);
    const fanOut = read.edges.filter((e) => e.blockerIssueNumber === 1);
    const fanIn = read.edges.filter((e) => e.blockedIssueNumber === 4);
    expect(fanOut).toHaveLength(2);
    expect(fanIn).toHaveLength(2);
  });

  test('an issue can belong to several chains, and each is listed', async () => {
    await createChain({ headIssueNumber: 10, members: [{ issueNumber: 10 }, { issueNumber: 42 }] });
    await createChain({
      headIssueNumber: 20,
      sessionId: 's2',
      members: [{ issueNumber: 20 }, { issueNumber: 42 }],
    });

    expect((await store.listChainsForIssue(42)).map((c) => c.chainId)).toEqual([
      'chain_10',
      'chain_20',
    ]);
    expect((await store.listChainsForIssue(42, { sessionId: 's2' })).map((c) => c.chainId)).toEqual([
      'chain_20',
    ]);
    expect(await store.listChainsForIssue(999)).toEqual([]);
  });

  test('replacing the graph swaps members and edges wholesale and advances the revision', async () => {
    await createChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
    });

    const replaced = await store.putChainGraph({
      chainId: 'chain_777',
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 779 }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 779 }],
      now: LATER,
    });

    expect(replaced.ok).toBe(true);
    expect(replaced.value.chain.graphRevision).toBe(2);
    expect(replaced.value.members.map((m) => m.issueNumber)).toEqual([777, 779]);
    expect(replaced.value.edges).toHaveLength(1);
    // The dropped member left nothing behind.
    expect(rowCounts().members).toBe(2);
    expect(rowCounts().edges).toBe(1);
  });

  test('re-writing an identical graph is a no-op, not a new revision', async () => {
    await createChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
    });
    const before = await store.getChainRecord('chain_777');

    const again = await store.putChainGraph({
      chainId: 'chain_777',
      // Same graph, different input order.
      members: [{ issueNumber: 778 }, { issueNumber: 777, role: 'head' }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
      now: LATER,
    });

    expect(again.ok).toBe(true);
    expect(again.value.chain).toEqual(before);
    expect(await store.listChainRevisions('chain_777')).toHaveLength(1);
  });

  test('a graph write can move the head in the same transaction', async () => {
    await createChain();
    const written = await store.putChainGraph({
      chainId: 'chain_777',
      members: [{ issueNumber: 777 }, { issueNumber: 778, role: 'head' }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
      headIssueNumber: 778,
      now: LATER,
    });

    expect(written.value.chain.headIssueNumber).toBe(778);
    expect(written.value.chain.graphRevision).toBe(2);
  });

  test('a graph naming a non-member endpoint is refused and nothing is written', async () => {
    await createChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
    });
    const before = rowCounts();

    const refused = await store.putChainGraph({
      chainId: 'chain_777',
      members: [{ issueNumber: 777, role: 'head' }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
      now: LATER,
    });

    expect(refused).toEqual({
      ok: false,
      code: 'invalid_graph',
      errors: [{ code: 'unknown_edge_endpoint', issueNumber: 778 }],
    });
    expect(rowCounts()).toEqual(before);
    expect((await store.getChainRecord('chain_777')).graphRevision).toBe(1);
  });

  test('an exclusive member claim refuses a member another chain already holds', async () => {
    await createChain({ headIssueNumber: 10, members: [{ issueNumber: 10 }, { issueNumber: 42 }] });
    await createChain({ headIssueNumber: 20 });
    const before = rowCounts();

    const refused = await store.putChainGraph({
      chainId: 'chain_20',
      members: [{ issueNumber: 20, role: 'head' }, { issueNumber: 42 }],
      edges: [{ blockerIssueNumber: 20, blockedIssueNumber: 42 }],
      exclusiveMemberScope: {},
      now: LATER,
    });

    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('conflict');
    expect(refused.owners).toEqual([{ issueNumber: 42, chainId: 'chain_10' }]);
    expect(refused.detail).toContain('issue 42 already belongs to chain chain_10');
    // The claim is decided before anything moves, so the loser is untouched.
    expect(rowCounts()).toEqual(before);
    expect((await store.getChainRecord('chain_20')).graphRevision).toBe(1);
  });

  test('an exclusive member claim ignores the writing chain and chains outside its scope', async () => {
    await createChain({
      headIssueNumber: 10,
      sessionId: 's2',
      members: [{ issueNumber: 10 }, { issueNumber: 42 }],
    });
    await createChain({ headIssueNumber: 20, members: [{ issueNumber: 20 }, { issueNumber: 43 }] });

    // 42 belongs to another session's chain and 43 to this one: neither is a
    // competing claim under a session-scoped filter.
    const written = await store.putChainGraph({
      chainId: 'chain_20',
      members: [{ issueNumber: 20, role: 'head' }, { issueNumber: 42 }, { issueNumber: 43 }],
      edges: [],
      exclusiveMemberScope: { sessionId: 's1' },
      headIssueNumber: 20,
      now: LATER,
    });

    expect(written.ok).toBe(true);
    expect(written.value.members.map((m) => m.issueNumber)).toEqual([20, 42, 43]);
  });

  test('an exclusive member claim binds an unchanged re-write too', async () => {
    await createChain({ headIssueNumber: 10, members: [{ issueNumber: 10 }, { issueNumber: 42 }] });
    // Creation takes no claim, so a registry can genuinely hold an overlap
    // that a claim would refuse.
    await createChain({ headIssueNumber: 20, members: [{ issueNumber: 20 }, { issueNumber: 42 }] });
    const before = await store.getChainRecord('chain_10');
    const rowsBefore = rowCounts();

    const again = await store.putChainGraph({
      chainId: 'chain_10',
      members: [{ issueNumber: 10 }, { issueNumber: 42 }],
      edges: [],
      exclusiveMemberScope: {},
      now: LATER,
    });

    // Holding a graph on record is not the same as holding a claim on it: the
    // re-write is how #890 accepts a candidate, and the overlap has to be able
    // to refuse it. Deciding the claim only for a graph-changing write would
    // wave exactly that acceptance through.
    expect(again.ok).toBe(false);
    expect(again.code).toBe('conflict');
    expect(again.owners).toEqual([{ issueNumber: 42, chainId: 'chain_20' }]);
    expect(rowCounts()).toEqual(rowsBefore);
    expect(await store.getChainRecord('chain_10')).toEqual(before);
  });

  test('an exclusive member claim holds for more members than one statement can bind', async () => {
    // Comfortably past the batch size the ownership lookup splits on, so the
    // claim is decided across several statements rather than one. A chain this
    // size is a legitimate graph, and answering it with SQLite's "too many SQL
    // variables" instead of a verdict would make large chains unacceptable.
    const many = Array.from({ length: 1200 }, (_, i) => ({ issueNumber: 1000 + i }));
    await createChain({ headIssueNumber: 10, members: [{ issueNumber: 10 }, ...many] });
    await createChain({ headIssueNumber: 20 });

    const claimed = await store.putChainGraph({
      chainId: 'chain_20',
      members: [{ issueNumber: 20, role: 'head' }, ...many],
      edges: [],
      exclusiveMemberScope: {},
      now: LATER,
    });

    expect(claimed.ok).toBe(false);
    expect(claimed.code).toBe('conflict');
    // Every offender, ascending, across batch boundaries — the order the port
    // promises is over the whole result, not within a batch.
    expect(claimed.owners).toEqual(
      many.map((m) => ({ issueNumber: m.issueNumber, chainId: 'chain_10' })),
    );
  });

  test('an exclusive member claim over an unowned graph of that size is written', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ issueNumber: 1000 + i }));
    await createChain({ headIssueNumber: 20 });

    const written = await store.putChainGraph({
      chainId: 'chain_20',
      members: [{ issueNumber: 20, role: 'head' }, ...many],
      edges: [],
      exclusiveMemberScope: {},
      now: LATER,
    });

    expect(written.ok).toBe(true);
    expect(written.value.members).toHaveLength(1201);
    expect(written.value.chain.graphRevision).toBe(2);
  });

  test('an unchanged re-write stays a no-op once its claim holds', async () => {
    await createChain({ headIssueNumber: 10, members: [{ issueNumber: 10 }, { issueNumber: 42 }] });
    const before = await store.getChainRecord('chain_10');

    const again = await store.putChainGraph({
      chainId: 'chain_10',
      members: [{ issueNumber: 10 }, { issueNumber: 42 }],
      edges: [],
      exclusiveMemberScope: {},
      now: LATER,
    });

    // Nothing else holds these members, so the claim passes and the write is
    // the no-op it always was: no revision bump, no new revision record.
    expect(again.ok).toBe(true);
    expect(again.value.chain).toEqual(before);
  });

  test('a revision state change can be conditioned on the accepted pointer', async () => {
    await createChain({ headIssueNumber: 10 });
    await store.setChainRevisionState('chain_10', 1, 'accepted', { now: LATER });
    await store.setAcceptedRevision('chain_10', 1, { now: LATER });

    // The pointer names revision 1, so a guarded demotion declines to write —
    // leaving an accepted pointer over a `candidate` revision is the one
    // outcome the option exists to rule out.
    const guarded = await store.setChainRevisionState('chain_10', 1, 'candidate', {
      unlessAcceptedRevision: true,
      now: LATER,
    });
    expect(guarded.ok).toBe(true);
    expect(guarded.value.state).toBe('accepted');
    expect((await store.getChainRevision('chain_10', 1)).state).toBe('accepted');

    // Once the pointer moves off it, the same call writes.
    await store.setAcceptedRevision('chain_10', null, { now: LATER });
    const applied = await store.setChainRevisionState('chain_10', 1, 'candidate', {
      unlessAcceptedRevision: true,
      now: LATER,
    });
    expect(applied.ok).toBe(true);
    expect(applied.value.state).toBe('candidate');
  });

  test('a revision state change reports the chain row it left behind', async () => {
    await createChain({ headIssueNumber: 10 });
    const before = await store.getChainRecord('chain_10');

    const moved = await store.setChainRevisionState('chain_10', 1, 'accepted', { now: LATER });
    // Read inside the write's own transaction, which is the only place it can
    // be told apart from a concurrent writer's bump — and what makes "nothing
    // has touched this chain since my last write" a claim a caller can make.
    expect(moved.ok).toBe(true);
    expect(moved.chainRev).toBeGreaterThan(before.rev);
    expect(moved.chainRev).toBe((await store.getChainRecord('chain_10')).rev);

    // The guarded no-op writes nothing, so it reports the row as it found it.
    await store.setAcceptedRevision('chain_10', 1, { now: LATER });
    const pointed = await store.getChainRecord('chain_10');
    const declined = await store.setChainRevisionState('chain_10', 1, 'candidate', {
      unlessAcceptedRevision: true,
      now: LATER,
    });
    expect(declined.ok).toBe(true);
    expect(declined.chainRev).toBe(pointed.rev);
  });

  test('a revision state change can be pinned to the row the caller last saw', async () => {
    await createChain({ headIssueNumber: 10 });
    const before = await store.getChainRecord('chain_10');
    const initialState = (await store.getChainRevision('chain_10', 1)).state;

    const stale = await store.setChainRevisionState('chain_10', 1, 'accepted', {
      expectedRev: before.rev - 1,
      now: LATER,
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('conflict');
    // Refused, not applied: the label a lost pin describes never lands.
    expect((await store.getChainRevision('chain_10', 1)).state).toBe(initialState);

    const pinned = await store.setChainRevisionState('chain_10', 1, 'accepted', {
      expectedRev: before.rev,
      now: LATER,
    });
    expect(pinned.ok).toBe(true);
    expect(pinned.chainRev).toBeGreaterThan(before.rev);
  });

  test('the pin is checked before the accepted-pointer no-op', async () => {
    await createChain({ headIssueNumber: 10 });
    await store.setChainRevisionState('chain_10', 1, 'accepted', { now: LATER });
    await store.setAcceptedRevision('chain_10', 1, { now: LATER });
    const pointed = await store.getChainRecord('chain_10');

    // A caller pinning this write wants a `chainRev` describing nothing but its
    // own effect. The guarded no-op reports the row as the transaction found
    // it, so answering it on a stale pin would hand back precisely the
    // concurrent bump the pin exists to exclude.
    const declined = await store.setChainRevisionState('chain_10', 1, 'candidate', {
      unlessAcceptedRevision: true,
      expectedRev: pointed.rev - 1,
      now: LATER,
    });
    expect(declined.ok).toBe(false);
    expect(declined.code).toBe('conflict');
  });

  test('a graph write against an unknown chain is not_found', async () => {
    expect(
      (await store.putChainGraph({ chainId: 'chain_404', members: [{ issueNumber: 1 }], edges: [] }))
        .code,
    ).toBe('not_found');
  });

  test('expectedRev guards a graph write against a concurrent change', async () => {
    await createChain();
    const stale = (await store.getChainRecord('chain_777')).rev;

    await store.updateChainMetadata('chain_777', { title: 'renamed', now: LATER });

    const refused = await store.putChainGraph({
      chainId: 'chain_777',
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
      expectedRev: stale,
      now: LATER,
    });
    expect(refused.code).toBe('conflict');

    const fresh = (await store.getChainRecord('chain_777')).rev;
    const accepted = await store.putChainGraph({
      chainId: 'chain_777',
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
      expectedRev: fresh,
      now: LATER,
    });
    expect(accepted.ok).toBe(true);
  });
});

describe('revisions and fingerprints', () => {
  test('creation records revision 1 with the graph fingerprint', async () => {
    const graph = await createChain({ source: 'intake' });
    const revisions = await store.listChainRevisions('chain_777');

    expect(revisions).toEqual([
      {
        chainId: 'chain_777',
        revision: 1,
        fingerprint: graph.chain.graphFingerprint,
        state: 'candidate',
        source: 'intake',
        createdAt: NOW,
      },
    ]);
  });

  test('each material graph write appends a candidate revision', async () => {
    await createChain();
    await store.putChainGraph({
      chainId: 'chain_777',
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
      source: 'operator',
      note: 'added 778',
      now: LATER,
    });

    const revisions = await store.listChainRevisions('chain_777');
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revisions[1]).toMatchObject({ state: 'candidate', source: 'operator', note: 'added 778' });
    expect(revisions[1].fingerprint).toBe((await store.getChainRecord('chain_777')).graphFingerprint);
  });

  test('re-inserting a revision with the same fingerprint is idempotent', async () => {
    const graph = await createChain();
    const again = await store.putChainRevision({
      chainId: 'chain_777',
      revision: 1,
      fingerprint: graph.chain.graphFingerprint,
      now: LATER,
    });

    expect(again.ok).toBe(true);
    expect(again.value.createdAt).toBe(NOW);
    expect(await store.listChainRevisions('chain_777')).toHaveLength(1);
  });

  test('reusing a revision number for a different fingerprint is refused', async () => {
    await createChain();
    const clash = await store.putChainRevision({
      chainId: 'chain_777',
      revision: 1,
      fingerprint: 'sha256:different',
      now: LATER,
    });
    expect(clash.code).toBe('already_exists');
  });

  test('a graph write never reuses a revision number already recorded ahead of it', async () => {
    await createChain();
    await store.putChainRevision({
      chainId: 'chain_777',
      revision: 5,
      fingerprint: 'sha256:reserved',
      now: NOW,
    });

    const written = await store.putChainGraph({
      chainId: 'chain_777',
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
      now: LATER,
    });

    expect(written.value.chain.graphRevision).toBe(6);
    expect((await store.getChainRevision('chain_777', 5)).fingerprint).toBe('sha256:reserved');
  });

  test('revision state moves through its own primitive, and the accepted pointer follows', async () => {
    await createChain();
    const moved = await store.setChainRevisionState('chain_777', 1, 'accepted', {
      note: 'reviewed',
      now: LATER,
    });
    expect(moved.value).toMatchObject({ state: 'accepted', note: 'reviewed' });

    const pointed = await store.setAcceptedRevision('chain_777', 1, { now: LATER });
    expect(pointed.value.acceptedRevision).toBe(1);

    const cleared = await store.setAcceptedRevision('chain_777', null, { now: LATER });
    expect(cleared.value.acceptedRevision).toBeUndefined();
  });

  test('the accepted pointer must name a revision that exists', async () => {
    await createChain();
    expect((await store.setAcceptedRevision('chain_777', 9)).code).toBe('not_found');
    expect((await store.setChainRevisionState('chain_777', 9, 'accepted')).code).toBe('not_found');
    expect((await store.putChainRevision({ chainId: 'chain_404', revision: 1, fingerprint: 'x' })).code)
      .toBe('not_found');
  });

  test('a commit guard is evaluated inside the pointer move, against rows read there', async () => {
    const created = await createChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    // Written after the caller could have read the frozen prefixes for itself,
    // and without touching any chain row — so `expectedRev` cannot see it and
    // only the in-transaction read can.
    const frozen = await store.putFrozenPrefix(
      buildFrozenPrefix({
        sessionId: 's1',
        issueNumber: 777,
        chainId: 'chain_777',
        graph: { members: created.members, edges: created.edges },
        graphRevision: created.chain.graphRevision,
        graphFingerprint: created.chain.graphFingerprint,
        base: { kind: 'default', baseRef: 'main' },
        frozenAt: NOW,
      }),
    );
    expect(frozen.ok).toBe(true);

    let seen;
    const refused = await store.setAcceptedRevision('chain_777', 1, {
      now: LATER,
      guard: ({ frozenPrefixes }) => {
        seen = frozenPrefixes;
        return frozenPrefixes.length > 0 ? 'a dependency prefix is frozen' : undefined;
      },
    });

    expect(seen.map((s) => s.issueNumber)).toEqual([777]);
    expect(refused).toEqual({ ok: false, code: 'guard_refused', detail: 'a dependency prefix is frozen' });
    // Refused inside the transaction, so the pointer never moved and the row
    // revision the refusal was decided on is untouched.
    const after = await store.getChainRecord('chain_777');
    expect(after.acceptedRevision).toBeUndefined();
    expect(after.rev).toBe(created.chain.rev);

    // A guard that passes leaves the write exactly as it would have been.
    const pointed = await store.setAcceptedRevision('chain_777', 1, {
      now: LATER,
      guard: () => undefined,
    });
    expect(pointed.value.acceptedRevision).toBe(1);
  });

  test('guardChainIds widens the guard read to another chain, inside the same transaction', async () => {
    await createChain();
    const source = await createChain({ chainId: 'chain_900', headIssueNumber: 900 });
    // A freeze recorded against the SOURCE chain: a merge's acceptance into
    // the target answers for this Issue too, but the row is invisible to a
    // guard handed only the accepted chain's own prefixes.
    const frozen = await store.putFrozenPrefix(
      buildFrozenPrefix({
        sessionId: 's1',
        issueNumber: 900,
        chainId: 'chain_900',
        graph: { members: source.members, edges: source.edges },
        graphRevision: source.chain.graphRevision,
        graphFingerprint: source.chain.graphFingerprint,
        base: { kind: 'default', baseRef: 'main' },
        frozenAt: NOW,
      }),
    );
    expect(frozen.ok).toBe(true);

    // Named alongside the accepted chain, the source's freeze reaches the
    // guard and its refusal holds the pointer.
    let seen;
    const refused = await store.setAcceptedRevision('chain_777', 1, {
      now: LATER,
      guardChainIds: ['chain_900'],
      guard: ({ frozenPrefixes }) => {
        seen = frozenPrefixes.map((s) => `${s.chainId}#${s.issueNumber}`);
        return frozenPrefixes.length > 0 ? 'a source Issue started while this ran' : undefined;
      },
    });
    expect(seen).toEqual(['chain_900#900']);
    expect(refused).toEqual({ ok: false, code: 'guard_refused', detail: 'a source Issue started while this ran' });
    expect((await store.getChainRecord('chain_777')).acceptedRevision).toBeUndefined();

    // Without it, the guard sees only the accepted chain's rows — the gap the
    // option exists to close.
    const unaware = await store.setAcceptedRevision('chain_777', 1, {
      now: LATER,
      guard: ({ frozenPrefixes }) => (frozenPrefixes.length > 0 ? 'refused' : undefined),
    });
    expect(unaware.ok).toBe(true);
    expect(unaware.value.acceptedRevision).toBe(1);
  });

  test('a commit guard that throws rolls the pointer move back', async () => {
    await createChain();
    const err = await rejectionOf(
      store.setAcceptedRevision('chain_777', 1, {
        now: LATER,
        guard: () => {
          throw new Error('unreadable');
        },
      }),
    );

    expect(err.message).toBe('unreadable');
    expect((await store.getChainRecord('chain_777')).acceptedRevision).toBeUndefined();
  });

  test('accepting a revision is pure persistence — no graph policy is applied', async () => {
    // A fingerprint that matches nothing currently persisted is still
    // acceptable here: whether it *should* be accepted is #890's decision.
    await createChain();
    await store.putChainRevision({
      chainId: 'chain_777',
      revision: 2,
      fingerprint: 'sha256:unrelated',
      now: NOW,
    });
    const pointed = await store.setAcceptedRevision('chain_777', 2, { now: LATER });
    expect(pointed.value.acceptedRevision).toBe(2);
    expect(pointed.value.graphRevision).toBe(1);
  });
});

describe('aliases', () => {
  test('an alias resolves to its chain, and so does the chain id itself', async () => {
    await createChain();
    const alias = await store.putChainAlias({
      alias: 'release-train',
      chainId: 'chain_777',
      reason: 'renamed by operator',
      now: LATER,
    });

    expect(alias.value).toEqual({
      alias: 'release-train',
      chainId: 'chain_777',
      reason: 'renamed by operator',
      createdAt: LATER,
    });
    expect(await store.resolveChainHandle('release-train')).toBe('chain_777');
    expect(await store.resolveChainHandle('chain_777')).toBe('chain_777');
    expect(await store.resolveChainHandle('nope')).toBeUndefined();
  });

  test('re-registering an alias to the same chain is idempotent', async () => {
    await createChain();
    await store.putChainAlias({ alias: 'train', chainId: 'chain_777', now: NOW });
    const again = await store.putChainAlias({ alias: 'train', chainId: 'chain_777', now: LATER });

    expect(again.ok).toBe(true);
    expect(again.value.createdAt).toBe(NOW);
    expect(await store.listChainAliases('chain_777')).toHaveLength(1);
  });

  test('an alias cannot be repointed at another chain, or shadow a chain id', async () => {
    await createChain();
    await createChain({ headIssueNumber: 800 });
    await store.putChainAlias({ alias: 'train', chainId: 'chain_777', now: NOW });

    expect((await store.putChainAlias({ alias: 'train', chainId: 'chain_800', now: LATER })).code).toBe(
      'alias_taken',
    );
    expect((await store.putChainAlias({ alias: 'chain_800', chainId: 'chain_777', now: LATER })).code).toBe(
      'alias_taken',
    );
    expect(await store.resolveChainHandle('train')).toBe('chain_777');
  });

  test('a malformed alias or an unknown chain is refused', async () => {
    await createChain();
    expect((await store.putChainAlias({ alias: 'has space', chainId: 'chain_777' })).code).toBe(
      'invalid_input',
    );
    expect((await store.putChainAlias({ alias: 'train', chainId: 'chain_404' })).code).toBe('not_found');
    expect(rowCounts().aliases).toBe(0);
  });

  test('deleting an alias is idempotent', async () => {
    await createChain();
    await store.putChainAlias({ alias: 'train', chainId: 'chain_777', now: NOW });

    expect(await store.deleteChainAlias('train')).toEqual({
      ok: true,
      value: { alias: 'train', deleted: true },
    });
    expect(await store.deleteChainAlias('train')).toEqual({
      ok: true,
      value: { alias: 'train', deleted: false },
    });
    expect(await store.resolveChainHandle('train')).toBeUndefined();
  });

  /**
   * `updateChainMetadata`'s alias claim (issue #791 review). A caller that names
   * a chain and then compare-and-sets on the revision it gets back needs both
   * halves under one guard: registering the alias through its own call bumps the
   * row a second time, and the number carried forward would then describe a
   * concurrent writer's state as much as the caller's.
   */
  describe('naming a chain as part of one guarded write', () => {
    test('registers the alias and the title in a single revision bump', async () => {
      const created = await createChain();
      const named = await store.updateChainMetadata('chain_777', {
        title: 'auth-work',
        alias: 'auth-work',
        expectedRev: created.chain.rev,
        now: LATER,
      });

      expect(named.ok).toBe(true);
      expect(named.value.title).toBe('auth-work');
      // One bump, so the revision it answers with is one the caller can go on
      // to guard its next write with.
      expect(named.value.rev).toBe(created.chain.rev + 1);
      expect(await store.resolveChainHandle('auth-work')).toBe('chain_777');
      expect(rowCounts().aliases).toBe(1);
    });

    test('a lost compare-and-set registers nothing at all', async () => {
      const created = await createChain();
      // Somebody else moves the chain between the caller's read and its write.
      await store.updateChainMetadata('chain_777', { title: 'moved by sync', now: LATER });

      const named = await store.updateChainMetadata('chain_777', {
        title: 'auth-work',
        alias: 'auth-work',
        expectedRev: created.chain.rev,
        now: LATER,
      });

      expect(named.ok).toBe(false);
      expect(named.code).toBe('conflict');
      // The whole patch is one transaction: the name is not left registered
      // against a chain whose title was never written.
      expect(await store.resolveChainHandle('auth-work')).toBeUndefined();
      expect(rowCounts().aliases).toBe(0);
      expect((await store.getChainRecord('chain_777')).title).toBe('moved by sync');
    });

    test('applies the same rules putChainAlias does', async () => {
      await createChain();
      await createChain({ headIssueNumber: 800 });
      await store.putChainAlias({ alias: 'train', chainId: 'chain_800', now: NOW });

      // Another chain's name, a live chain id, and a malformed one.
      expect((await store.updateChainMetadata('chain_777', { alias: 'train' })).code).toBe('alias_taken');
      expect((await store.updateChainMetadata('chain_777', { alias: 'chain_800' })).code).toBe(
        'alias_taken',
      );
      expect((await store.updateChainMetadata('chain_777', { alias: 'has space' })).code).toBe(
        'invalid_input',
      );

      // Re-registering this chain's own name is a no-op for the alias row, and
      // the chain row still advances exactly once for the patch.
      await store.putChainAlias({ alias: 'auth-work', chainId: 'chain_777', now: NOW });
      const before = await store.getChainRecord('chain_777');
      const again = await store.updateChainMetadata('chain_777', {
        title: 'auth-work',
        alias: 'auth-work',
        expectedRev: before.rev,
        now: LATER,
      });
      expect(again.ok).toBe(true);
      expect(again.value.rev).toBe(before.rev + 1);
      expect((await store.listChainAliases('chain_777')).map((a) => a.alias)).toEqual(['auth-work']);
    });
  });

  test('listChainAliases scopes to one chain, or returns all', async () => {
    await createChain();
    await createChain({ headIssueNumber: 800 });
    await store.putChainAlias({ alias: 'a-one', chainId: 'chain_777', now: NOW });
    await store.putChainAlias({ alias: 'b-two', chainId: 'chain_800', now: NOW });

    expect((await store.listChainAliases('chain_777')).map((a) => a.alias)).toEqual(['a-one']);
    expect((await store.listChainAliases()).map((a) => a.alias)).toEqual(['a-one', 'b-two']);
  });
});

describe('synchronization metadata', () => {
  test('an in_sync result records both the attempt and the success', async () => {
    await createChain();
    const synced = await store.setChainSyncState('chain_777', { status: 'in_sync', now: LATER });

    expect(synced.value).toMatchObject({
      syncStatus: 'in_sync',
      syncCheckedAt: LATER,
      syncedAt: LATER,
    });
    expect(synced.value.syncError).toBeUndefined();
  });

  test('a failed attempt records the error without advancing last-known-good', async () => {
    await createChain();
    await store.setChainSyncState('chain_777', { status: 'in_sync', now: LATER });

    const failed = await store.setChainSyncState('chain_777', {
      status: 'error',
      error: 'relationship fetch failed',
      now: '2026-08-08T12:00:00.000Z',
    });

    expect(failed.value).toMatchObject({
      syncStatus: 'error',
      syncError: 'relationship fetch failed',
      syncCheckedAt: '2026-08-08T12:00:00.000Z',
      // Unchanged: a failed check says nothing about when the chain was last
      // actually in sync.
      syncedAt: LATER,
    });
  });

  test('a null error clears a previously recorded one', async () => {
    await createChain();
    await store.setChainSyncState('chain_777', { status: 'error', error: 'boom', now: LATER });
    const cleared = await store.setChainSyncState('chain_777', {
      status: 'stale',
      error: null,
      now: LATER,
    });
    expect(cleared.value.syncError).toBeUndefined();
    expect(cleared.value.syncStatus).toBe('stale');
  });

  test('a later non-error status clears an earlier error even without an explicit null', async () => {
    await createChain();
    await store.setChainSyncState('chain_777', { status: 'error', error: 'boom', now: NOW });

    const recovered = await store.setChainSyncState('chain_777', { status: 'in_sync', now: LATER });
    expect(recovered.value).toMatchObject({ syncStatus: 'in_sync', syncedAt: LATER });
    expect(recovered.value.syncError).toBeUndefined();

    await store.setChainSyncState('chain_777', { status: 'error', error: 'boom again', now: LATER });
    const stale = await store.setChainSyncState('chain_777', { status: 'stale', now: LATER });
    expect(stale.value.syncError).toBeUndefined();

    await store.setChainSyncState('chain_777', { status: 'error', error: 'boom thrice', now: LATER });
    const unknown = await store.setChainSyncState('chain_777', { status: 'unknown', now: LATER });
    expect(unknown.value.syncError).toBeUndefined();
  });

  test('a repeated error status keeps the recorded detail when none is supplied', async () => {
    await createChain();
    await store.setChainSyncState('chain_777', { status: 'error', error: 'boom', now: NOW });

    const again = await store.setChainSyncState('chain_777', { status: 'error', now: LATER });
    expect(again.value).toMatchObject({ syncStatus: 'error', syncError: 'boom', syncCheckedAt: LATER });
  });

  test('an unknown status and an unknown chain are both refused', async () => {
    await createChain();
    expect((await store.setChainSyncState('chain_777', { status: 'synced' })).code).toBe('invalid_input');
    expect((await store.setChainSyncState('chain_404', { status: 'stale' })).code).toBe('not_found');
  });

  test('listChains filters by session and by sync status', async () => {
    await createChain();
    await createChain({ headIssueNumber: 800, sessionId: 's2' });
    await store.setChainSyncState('chain_800', { status: 'stale', now: LATER });

    expect((await store.listChains()).map((c) => c.chainId)).toEqual(['chain_777', 'chain_800']);
    expect((await store.listChains({ sessionId: 's2' })).map((c) => c.chainId)).toEqual(['chain_800']);
    expect((await store.listChains({ syncStatus: 'stale' })).map((c) => c.chainId)).toEqual(['chain_800']);
  });
});

describe('deletion and transaction safety', () => {
  test('deleting a chain cascades to members, edges, revisions, and aliases', async () => {
    await createChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
    });
    await store.putChainAlias({ alias: 'train', chainId: 'chain_777', now: NOW });

    expect(await store.deleteChain('chain_777')).toEqual({
      ok: true,
      value: { chainId: 'chain_777', deleted: true },
    });
    expect(rowCounts()).toEqual({ chains: 0, members: 0, edges: 0, revisions: 0, aliases: 0 });
  });

  test('deleting an absent chain reports deleted:false instead of failing', async () => {
    expect(await store.deleteChain('chain_404')).toEqual({
      ok: true,
      value: { chainId: 'chain_404', deleted: false },
    });
  });

  test('a stale expectedRev refuses the delete and leaves the chain intact', async () => {
    await createChain();
    const refused = await store.deleteChain('chain_777', { expectedRev: 99 });
    expect(refused.code).toBe('conflict');
    expect(await store.getChainRecord('chain_777')).toBeDefined();
  });

  test('a failure part-way through creation rolls the whole chain back', async () => {
    // A trigger that aborts on one edge insert stands in for any mid-write
    // failure: the chain row and its members are written before that edge, so
    // without a transaction they would survive it.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TRIGGER chain_edge_boom BEFORE INSERT ON dependency_chain_edge
      WHEN NEW.blocked_issue_number = 778
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);
    db.close();

    const error = await rejectionOf(
      store.createChain({
        sessionId: 's1',
        headIssueNumber: 777,
        members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
        edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
        now: NOW,
      }),
    );
    expect(String(error?.message)).toMatch(/injected failure/);

    expect(rowCounts()).toEqual({ chains: 0, members: 0, edges: 0, revisions: 0, aliases: 0 });
    expect(await store.getChain('chain_777')).toBeUndefined();
  });

  test('a failure part-way through a graph replacement leaves the previous graph intact', async () => {
    await createChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
    });
    const before = await store.getChain('chain_777');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TRIGGER chain_edge_boom BEFORE INSERT ON dependency_chain_edge
      WHEN NEW.blocked_issue_number = 779
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);
    db.close();

    const error = await rejectionOf(
      store.putChainGraph({
        chainId: 'chain_777',
        members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 779 }],
        edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 779 }],
        now: LATER,
      }),
    );
    expect(String(error?.message)).toMatch(/injected failure/);

    // The delete-then-insert that the replacement performs was rolled back
    // whole: the old members and edges are still there, at the old revision.
    expect(await store.getChain('chain_777')).toEqual(before);
    expect(await store.listChainRevisions('chain_777')).toHaveLength(1);
  });

  test('the database refuses an edge whose endpoints are not members of its chain', async () => {
    await createChain();
    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    try {
      // The pure checks normally catch this first; this pins the storage-level
      // backstop that stands behind them.
      expect(() =>
        db
          .prepare(
            `INSERT INTO dependency_chain_edge
               (chain_id, blocker_issue_number, blocked_issue_number, created_at)
             VALUES ('chain_777', 777, 999, ?)`,
          )
          .run(NOW),
      ).toThrow(/FOREIGN KEY/i);
      // And a self-edge, which no member row could ever satisfy.
      expect(() =>
        db
          .prepare(
            `INSERT INTO dependency_chain_edge
               (chain_id, blocker_issue_number, blocked_issue_number, created_at)
             VALUES ('chain_777', 777, 777, ?)`,
          )
          .run(NOW),
      ).toThrow(/CHECK constraint/i);
    } finally {
      db.close();
    }
  });
});

describe('chain-edit locks (issue #791 review)', () => {
  const FRESH = '2026-08-08T10:00:00.000Z';
  /** Older than the 30-minute staleness window, by hours. */
  const LONG_AGO = '2026-08-08T06:00:00.000Z';

  async function acquire(owner, scopes, now = FRESH) {
    return store.acquireChainEditLocks({
      scopes,
      ownerId: owner,
      operationId: `admin chain new-${owner}`,
      now,
    });
  }

  test('a claim is exclusive, and a contended acquisition claims nothing at all', async () => {
    expect(await acquire('owner-1', ['issue:s1:10', 'issue:s1:11'])).toEqual({
      ok: true,
      scopes: ['issue:s1:10', 'issue:s1:11'],
    });

    const contended = await acquire('owner-2', ['issue:s1:11', 'issue:s1:12']);
    expect(contended.ok).toBe(false);
    expect(contended.scope).toBe('issue:s1:11');
    expect(contended.heldBy).toEqual({
      ownerId: 'owner-1',
      operationId: 'admin chain new-owner-1',
      acquiredAt: FRESH,
    });

    // All-or-nothing: #12 was never claimed by the run that lost, so a third
    // edit that does not overlap is free to take it.
    expect((await acquire('owner-3', ['issue:s1:12'])).ok).toBe(true);
  });

  test('re-acquiring a scope this owner already holds refreshes it instead of contending', async () => {
    expect((await acquire('owner-1', ['issue:s1:10'])).ok).toBe(true);
    expect((await acquire('owner-1', ['issue:s1:10', 'issue:s1:11'], LATER)).ok).toBe(true);
    // Refreshed, not duplicated: the scope is still one exclusive claim.
    const contended = await acquire('owner-2', ['issue:s1:10'], LATER);
    expect(contended.ok).toBe(false);
    expect(contended.heldBy.acquiredAt).toBe(LATER);
  });

  test('release frees only what this owner holds', async () => {
    expect((await acquire('owner-1', ['issue:s1:10'])).ok).toBe(true);

    // A run that never held the scope cannot free it for somebody else.
    expect(await store.releaseChainEditLocks(['issue:s1:10'], 'owner-2')).toEqual({ released: 0 });
    expect((await acquire('owner-2', ['issue:s1:10'])).ok).toBe(false);

    expect(await store.releaseChainEditLocks(['issue:s1:10'], 'owner-1')).toEqual({ released: 1 });
    expect((await acquire('owner-2', ['issue:s1:10'])).ok).toBe(true);
  });

  test('a claim left behind by a crashed edit is taken over once it goes stale', async () => {
    expect((await acquire('crashed', ['issue:s1:10'], LONG_AGO)).ok).toBe(true);

    // Still inside the window: the other edit may simply be slow.
    const tooSoon = await store.acquireChainEditLocks({
      scopes: ['issue:s1:10'],
      ownerId: 'retry',
      operationId: 'admin chain new-retry',
      now: LONG_AGO,
      staleAfterMs: 30 * 60 * 1000,
    });
    expect(tooSoon.ok).toBe(false);

    expect((await acquire('retry', ['issue:s1:10'], FRESH)).ok).toBe(true);
    // And the crashed run's own late release cannot free the retry's claim.
    expect(await store.releaseChainEditLocks(['issue:s1:10'], 'crashed')).toEqual({ released: 0 });
  });

  test('a renewed claim outlives the staleness window, so a slow edit is never superseded', async () => {
    // The same setup as the crashed-edit test above — a claim taken hours ago —
    // except that this owner is still alive and says so. Without the heartbeat
    // an apply slower than the window (many Issues, a rate-limited provider)
    // would have its scopes taken while it was still writing relationships and
    // suspending labels (issue #791 review).
    expect((await acquire('slow', ['issue:s1:10', 'issue:s1:11'], LONG_AGO)).ok).toBe(true);

    expect(
      await store.renewChainEditLocks({
        scopes: ['issue:s1:11', 'issue:s1:10'],
        ownerId: 'slow',
        now: FRESH,
      }),
    ).toEqual({ renewed: ['issue:s1:10', 'issue:s1:11'], lost: [] });

    // Age is now measured from the heartbeat, not from the acquisition.
    const contended = await acquire('other', ['issue:s1:10'], FRESH);
    expect(contended.ok).toBe(false);
    expect(contended.heldBy.acquiredAt).toBe(FRESH);
    // And the operation id the refusal names is still the original edit's: a
    // heartbeat refreshes a claim, it does not re-open it as a new one.
    expect(contended.heldBy.operationId).toBe('admin chain new-slow');
  });

  test('renewal reports a scope this owner has lost instead of taking it back', async () => {
    expect((await acquire('crashed', ['issue:s1:10', 'issue:s1:11'], LONG_AGO)).ok).toBe(true);
    // #10 was declared stale and handed to the run that came after; #11 was
    // released by hand. Neither is this owner's to resurrect.
    expect((await acquire('retry', ['issue:s1:10'], FRESH)).ok).toBe(true);
    expect(await store.releaseChainEditLocks(['issue:s1:11'], 'crashed')).toEqual({ released: 1 });

    expect(
      await store.renewChainEditLocks({
        scopes: ['issue:s1:10', 'issue:s1:11'],
        ownerId: 'crashed',
        now: LATER,
      }),
    ).toEqual({ renewed: [], lost: ['issue:s1:10', 'issue:s1:11'] });

    // The successor still holds #10, at the timestamp IT acquired.
    const probe = await acquire('third', ['issue:s1:10'], FRESH);
    expect(probe.ok).toBe(false);
    expect(probe.heldBy).toEqual({
      ownerId: 'retry',
      operationId: 'admin chain new-retry',
      acquiredAt: FRESH,
    });
    // And a scope nobody holds is not created by renewing it.
    expect((await acquire('third', ['issue:s1:11'], FRESH)).ok).toBe(true);
  });

  test('a claim whose age cannot be established counts as live rather than being broken on a guess', async () => {
    expect((await acquire('owner-1', ['issue:s1:10'])).ok).toBe(true);
    const db = new Database(dbPath);
    try {
      db.prepare("UPDATE dependency_chain_edit_lock SET acquired_at = 'not-a-timestamp'").run();
    } finally {
      db.close();
    }
    expect((await acquire('owner-2', ['issue:s1:10'], LATER)).ok).toBe(false);
  });

  /**
   * The staleness window cannot be made safe by widening it: a `gh` call is a
   * `spawnSync`, so an owner blocked in one fires no heartbeat and can pass any
   * window while it is still writing. The pid is the heartbeat that keeps
   * beating through such a call, so a takeover asks the process, not the clock
   * (issue #791 review).
   */
  describe('a takeover asks whether the owning process is still there', () => {
    /** A pid that has certainly exited: `spawnSync` waits for and reaps it. */
    function deadPid() {
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      expect(child.status).toBe(0);
      return child.pid;
    }

    async function held(overrides) {
      const acquired = await store.acquireChainEditLocks({
        scopes: ['issue:s1:10'],
        ownerId: 'slow',
        operationId: 'admin chain new-10,11',
        now: LONG_AGO,
        ownerHost: hostname(),
        ...overrides,
      });
      expect(acquired.ok).toBe(true);
    }

    test('a claim stale by hours is left alone while its process still answers', async () => {
      await held({ ownerPid: process.pid });

      const contended = await acquire('retry', ['issue:s1:10'], FRESH);
      expect(contended.ok).toBe(false);
      // The refusal names the process, so an operator can check it themselves.
      expect(contended.heldBy.pid).toBe(process.pid);
      expect(contended.heldBy.host).toBe(hostname());
    });

    test('a claim whose process is gone is taken over as soon as it goes stale', async () => {
      await held({ ownerPid: deadPid() });

      expect((await acquire('retry', ['issue:s1:10'], FRESH)).ok).toBe(true);
    });

    test('a live-looking claim is taken over once past the recycled-pid ceiling', async () => {
      await held({ ownerPid: process.pid });

      // A pid the OS reassigned would otherwise hold the scope for good.
      const takeover = await store.acquireChainEditLocks({
        scopes: ['issue:s1:10'],
        ownerId: 'retry',
        operationId: 'admin chain new-retry',
        now: FRESH,
        abandonedAfterMs: 60 * 60 * 1000,
      });
      expect(takeover.ok).toBe(true);
    });

    test('a claim taken on another machine is judged on age alone, as it always was', async () => {
      // A local pid says nothing about a process on a different host, so
      // guessing from it is worse than the window it would override.
      await held({ ownerPid: process.pid, ownerHost: `${hostname()}-elsewhere` });

      expect((await acquire('retry', ['issue:s1:10'], FRESH)).ok).toBe(true);
    });

    test('a row from a build that recorded no pid reports none and is judged on age alone', async () => {
      await held({ ownerHost: undefined });

      const contended = await acquire('retry', ['issue:s1:10'], LONG_AGO);
      expect(contended.ok).toBe(false);
      expect(contended.heldBy).toEqual({
        ownerId: 'slow',
        operationId: 'admin chain new-10,11',
        acquiredAt: LONG_AGO,
      });
      expect((await acquire('retry', ['issue:s1:10'], FRESH)).ok).toBe(true);
    });
  });
});

test('backendId identifies the shared database file', () => {
  expect(store.backendId).toMatch(/^sqlite:/);
  const other = new SqliteChainRegistryStore(dbPath);
  try {
    expect(other.backendId).toBe(store.backendId);
  } finally {
    other.close();
  }
});
