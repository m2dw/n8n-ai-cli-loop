/**
 * `SqliteChainRegistryStore.retireChain` and the tolerated-owner claim (issue
 * #893): the two registry primitives a merge stands on.
 *
 * What is pinned: retirement is one transaction that keeps every handle the
 * retired chain ever had resolvable — its ID and its aliases all answer the
 * surviving chain afterwards, deterministically — while its graph, members,
 * and revision records go away; its frozen-prefix snapshots survive against
 * the surviving chain with their contract fingerprints recomputed; and the
 * exclusive member claim of `putChainGraph` can tolerate exactly the chains a
 * merge names while still refusing any third claimant inside the write's own
 * transaction.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteChainRegistryStore,
  buildFrozenPrefix,
  chainGraphFingerprint,
} from '../dist/index.js';

const NOW = '2026-08-09T10:00:00.000Z';
const SESSION = 'addon-dev';

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chain-registry-retire-test-'));
  store = new SqliteChainRegistryStore(join(tmpDir, 'dev_loop.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createLine(head, issues, extra = {}) {
  const members = issues.map((n) => ({ issueNumber: n, role: n === head ? 'head' : 'node' }));
  const edges = issues.slice(1).map((n, i) => ({ blockerIssueNumber: issues[i], blockedIssueNumber: n }));
  const created = await store.createChain({
    sessionId: SESSION,
    headIssueNumber: head,
    members,
    edges,
    now: NOW,
    ...extra,
  });
  if (!created.ok) throw new Error(`createChain failed: ${created.code}`);
  return created.value.chain;
}

describe('retireChain', () => {
  test('every handle of the retired chain resolves to the survivor', async () => {
    const source = await createLine(12, [11, 12], { alias: 'feature-x' });
    const target = await createLine(2, [1, 2]);

    const retired = await store.retireChain({
      chainId: source.chainId,
      intoChainId: target.chainId,
      expectedRev: source.rev,
      reason: 'retired by admin chain merge into chain_2',
      now: NOW,
    });
    expect(retired.ok).toBe(true);
    expect(retired.value.movedAliases).toEqual(['feature-x']);

    // The retired ID and its alias both answer the survivor.
    expect(await store.resolveChainHandle(source.chainId)).toBe(target.chainId);
    expect(await store.resolveChainHandle('feature-x')).toBe(target.chainId);
    // The chain itself is gone, graph and history rows included.
    expect(await store.getChain(source.chainId)).toBeUndefined();
    expect(await store.listChainRevisions(source.chainId)).toEqual([]);
    // The survivor carries both alias rows, the retired ID's with the reason.
    const aliases = await store.listChainAliases(target.chainId);
    expect(aliases.map((a) => a.alias).sort()).toEqual([source.chainId, 'feature-x'].sort());
    expect(aliases.find((a) => a.alias === source.chainId).reason).toContain('admin chain merge');
  });

  test('frozen-prefix snapshots survive against the survivor with recomputed fingerprints', async () => {
    const source = await createLine(12, [11, 12]);
    const target = await createLine(2, [1, 2]);
    const graph = {
      members: [
        { issueNumber: 11, role: 'node' },
        { issueNumber: 12, role: 'head' },
      ],
      edges: [{ blockerIssueNumber: 11, blockedIssueNumber: 12 }],
    };
    const frozen = await store.putFrozenPrefix(
      buildFrozenPrefix({
        sessionId: SESSION,
        issueNumber: 12,
        chainId: source.chainId,
        graph,
        graphRevision: 1,
        graphFingerprint: chainGraphFingerprint(graph),
        base: { kind: 'default', baseRef: 'main' },
        frozenAt: NOW,
      }),
    );
    expect(frozen.ok).toBe(true);

    const retired = await store.retireChain({
      chainId: source.chainId,
      intoChainId: target.chainId,
      now: NOW,
    });
    expect(retired.ok).toBe(true);
    expect(retired.value.movedFrozenPrefixes).toBe(1);

    expect(await store.listFrozenPrefixes({ chainId: source.chainId })).toEqual([]);
    const migrated = await store.listFrozenPrefixes({ chainId: target.chainId });
    expect(migrated.map((s) => s.issueNumber)).toEqual([12]);
    // The contract is carried over byte for byte; only the chain handle — and
    // therefore the identity fingerprint — changes.
    const expected = buildFrozenPrefix({
      sessionId: SESSION,
      issueNumber: 12,
      chainId: target.chainId,
      graph,
      graphRevision: 1,
      graphFingerprint: chainGraphFingerprint(graph),
      base: { kind: 'default', baseRef: 'main' },
      frozenAt: NOW,
    });
    expect(migrated[0].ancestors).toEqual([11]);
    expect(migrated[0].fingerprint).toBe(expected.fingerprint);
  });

  test('a lost compare-and-set, an absent operand, and a self-retirement all refuse whole', async () => {
    const source = await createLine(12, [11, 12], { alias: 'feature-x' });
    const target = await createLine(2, [1, 2]);

    const conflicted = await store.retireChain({
      chainId: source.chainId,
      intoChainId: target.chainId,
      expectedRev: source.rev + 5,
      now: NOW,
    });
    expect(conflicted.ok).toBe(false);
    expect(conflicted.code).toBe('conflict');
    // Nothing moved: the chain still resolves to itself, alias intact.
    expect(await store.resolveChainHandle(source.chainId)).toBe(source.chainId);
    expect(await store.resolveChainHandle('feature-x')).toBe(source.chainId);

    const missingSource = await store.retireChain({ chainId: 'chain_999', intoChainId: target.chainId, now: NOW });
    expect(missingSource.ok).toBe(false);
    expect(missingSource.code).toBe('not_found');

    const missingTarget = await store.retireChain({ chainId: source.chainId, intoChainId: 'chain_999', now: NOW });
    expect(missingTarget.ok).toBe(false);
    expect(missingTarget.code).toBe('not_found');

    const self = await store.retireChain({ chainId: source.chainId, intoChainId: source.chainId, now: NOW });
    expect(self.ok).toBe(false);
    expect(self.code).toBe('invalid_input');
  });
});

describe('putChainGraph tolerateOwnerChainIds', () => {
  test('the exclusive claim tolerates named chains and still refuses a third', async () => {
    const source = await createLine(12, [11, 12]);
    const target = await createLine(2, [1, 2]);
    const third = await createLine(31, [30, 31]);

    const merged = {
      chainId: target.chainId,
      headIssueNumber: 12,
      members: [1, 2, 11, 12].map((n) => ({ issueNumber: n, role: n === 12 ? 'head' : 'node' })),
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 11 },
        { blockerIssueNumber: 11, blockedIssueNumber: 12 },
      ],
      now: NOW,
    };

    // Without tolerance, the source's own membership refuses the merge write.
    const refused = await store.putChainGraph({ ...merged, exclusiveMemberScope: { sessionId: SESSION } });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('conflict');
    expect(refused.owners.map((o) => o.chainId)).toContain(source.chainId);

    // Tolerating the source lets the combined graph in.
    const written = await store.putChainGraph({
      ...merged,
      exclusiveMemberScope: { sessionId: SESSION },
      tolerateOwnerChainIds: [source.chainId],
    });
    expect(written.ok).toBe(true);

    // A THIRD chain's claim is never tolerated by naming the source.
    const withThird = {
      ...merged,
      members: [...merged.members, { issueNumber: 30, role: 'node' }],
      edges: [...merged.edges, { blockerIssueNumber: 12, blockedIssueNumber: 30 }],
    };
    const stillRefused = await store.putChainGraph({
      ...withThird,
      exclusiveMemberScope: { sessionId: SESSION },
      tolerateOwnerChainIds: [source.chainId],
    });
    expect(stillRefused.ok).toBe(false);
    expect(stillRefused.owners.map((o) => o.chainId)).toContain(third.chainId);
  });
});
