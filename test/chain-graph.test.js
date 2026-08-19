/**
 * Dependency-chain graph validation (issue #890): canonical fingerprints,
 * accepted shapes, the refusals, deterministic diagnostics, and comparison.
 * Pure — no database, no provider, no CLI.
 */
import {
  CHAIN_GRAPH_DIAGNOSTIC_CODES,
  chainGraphFingerprint,
  chainGraphTopologicalOrder,
  compareChainGraphs,
  formatChainGraphEdge,
  isChainGraphDiagnosticCode,
  validateChainGraph,
} from '../dist/index.js';

const HEAD = { issueNumber: 1, role: 'head' };

/** Every diagnostic code a verdict reported, in the order it reported them. */
function codes(validation) {
  expect(validation.ok).toBe(false);
  return validation.diagnostics.map((d) => d.code);
}

function findDiagnostic(validation, code) {
  expect(validation.ok).toBe(false);
  const match = validation.diagnostics.filter((d) => d.code === code);
  expect(match).toHaveLength(1);
  return match[0];
}

function linear() {
  return {
    chainId: 'chain_1',
    headIssueNumber: 1,
    members: [HEAD, { issueNumber: 2 }, { issueNumber: 3 }],
    edges: [
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      { blockerIssueNumber: 2, blockedIssueNumber: 3 },
    ],
  };
}

describe('accepted graph shapes', () => {
  test('a linear chain validates and canonicalizes', () => {
    const result = validateChainGraph(linear());
    expect(result.ok).toBe(true);
    expect(result.graph.chainId).toBe('chain_1');
    expect(result.graph.headIssueNumber).toBe(1);
    expect(result.graph.members).toEqual([
      { issueNumber: 1, role: 'head' },
      { issueNumber: 2, role: 'node' },
      { issueNumber: 3, role: 'node' },
    ]);
    expect(result.graph.topologicalOrder).toEqual([1, 2, 3]);
  });

  test('fan-out is a legitimate shape', () => {
    // One blocker, several blocked Issues.
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }, { issueNumber: 3 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 1, blockedIssueNumber: 3 },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.graph.topologicalOrder).toEqual([1, 2, 3]);
  });

  test('fan-in is a legitimate shape', () => {
    // Several blockers, one blocked Issue.
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }, { issueNumber: 3 }, { issueNumber: 4 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 1, blockedIssueNumber: 3 },
        { blockerIssueNumber: 2, blockedIssueNumber: 4 },
        { blockerIssueNumber: 3, blockedIssueNumber: 4 },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.graph.topologicalOrder).toEqual([1, 2, 3, 4]);
  });

  test('a one-issue chain with no edges is valid', () => {
    const result = validateChainGraph({ headIssueNumber: 7, members: [{ issueNumber: 7 }], edges: [] });
    expect(result.ok).toBe(true);
    expect(result.graph.edges).toEqual([]);
    expect(result.graph.topologicalOrder).toEqual([7]);
  });

  test('a chain with no chain id validates — intake has no chain yet', () => {
    const result = validateChainGraph({ headIssueNumber: 7, members: [{ issueNumber: 7 }], edges: [] });
    expect(result.ok).toBe(true);
    expect(result.graph.chainId).toBeUndefined();
  });
});

describe('canonical fingerprints', () => {
  test('equivalent graphs supplied in different orders fingerprint identically', () => {
    const forwards = validateChainGraph(linear());
    const backwards = validateChainGraph({
      chainId: 'chain_1',
      headIssueNumber: 1,
      members: [{ issueNumber: 3 }, { issueNumber: 2 }, HEAD],
      edges: [
        { blockerIssueNumber: 2, blockedIssueNumber: 3 },
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      ],
    });
    expect(forwards.ok && backwards.ok).toBe(true);
    expect(backwards.graph.fingerprint).toBe(forwards.graph.fingerprint);
    expect(backwards.graph.text).toBe(forwards.graph.text);
    expect(backwards.graph.members).toEqual(forwards.graph.members);
    expect(backwards.graph.edges).toEqual(forwards.graph.edges);
  });

  test('the canonical fingerprint matches what the storage layer computes', () => {
    // Canonicalization must not shift the fingerprint out from under #788's
    // store, which hashes the caller's members and edges directly.
    const candidate = linear();
    const result = validateChainGraph(candidate);
    expect(result.ok).toBe(true);
    expect(result.graph.fingerprint).toBe(
      chainGraphFingerprint({ members: candidate.members, edges: candidate.edges }),
    );
  });

  test('the chain the graph belongs to is not part of its fingerprint', () => {
    const here = validateChainGraph({ ...linear(), chainId: 'chain_1' });
    const there = validateChainGraph({ ...linear(), chainId: 'chain_2' });
    expect(here.ok && there.ok).toBe(true);
    expect(there.graph.fingerprint).toBe(here.graph.fingerprint);
  });

  test('a different edge direction is a different graph', () => {
    const reversed = validateChainGraph({
      ...linear(),
      edges: [
        { blockerIssueNumber: 2, blockedIssueNumber: 1 },
        { blockerIssueNumber: 2, blockedIssueNumber: 3 },
      ],
    });
    const straight = validateChainGraph(linear());
    expect(reversed.ok && straight.ok).toBe(true);
    expect(reversed.graph.fingerprint).not.toBe(straight.graph.fingerprint);
  });
});

describe('cycles', () => {
  test('a cycle is rejected and named as a path', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }, { issueNumber: 3 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 3 },
        { blockerIssueNumber: 3, blockedIssueNumber: 1 },
      ],
    });
    expect(codes(result)).toEqual(['cycle']);
    const cycle = findDiagnostic(result, 'cycle');
    expect(cycle.issues).toEqual([1, 2, 3]);
    expect(cycle.message).toContain('1 -> 2 -> 3 -> 1');
    expect(cycle.observedEdges).toEqual([
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      { blockerIssueNumber: 2, blockedIssueNumber: 3 },
      { blockerIssueNumber: 3, blockedIssueNumber: 1 },
    ]);
    // The repair is a removal, so no replacement edge set is implied.
    expect(cycle.expectedEdges).toEqual([]);
  });

  test('a two-issue cycle is rejected', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 1 },
      ],
    });
    expect(codes(result)).toEqual(['cycle']);
    expect(findDiagnostic(result, 'cycle').message).toContain('1 -> 2 -> 1');
  });

  test('two independent cycles are reported separately', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }, { issueNumber: 3 }, { issueNumber: 4 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 1 },
        { blockerIssueNumber: 3, blockedIssueNumber: 4 },
        { blockerIssueNumber: 4, blockedIssueNumber: 3 },
      ],
    });
    expect(codes(result)).toEqual(['cycle', 'cycle']);
    expect(result.diagnostics.map((d) => d.issues)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('the reported cycle path is the shortest through the smallest issue', () => {
    // 2 -> 3 -> 2 is the short way round; 2 -> 4 -> 5 -> 2 the long one.
    const result = validateChainGraph({
      headIssueNumber: 2,
      members: [{ issueNumber: 2 }, { issueNumber: 3 }, { issueNumber: 4 }, { issueNumber: 5 }],
      edges: [
        { blockerIssueNumber: 2, blockedIssueNumber: 3 },
        { blockerIssueNumber: 3, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 4 },
        { blockerIssueNumber: 4, blockedIssueNumber: 5 },
        { blockerIssueNumber: 5, blockedIssueNumber: 2 },
      ],
    });
    expect(findDiagnostic(result, 'cycle').message).toContain('2 -> 3 -> 2');
  });

  test('a diamond is not a cycle', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }, { issueNumber: 3 }, { issueNumber: 4 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 1, blockedIssueNumber: 3 },
        { blockerIssueNumber: 2, blockedIssueNumber: 4 },
        { blockerIssueNumber: 3, blockedIssueNumber: 4 },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test('a long linear chain does not overflow the traversal', () => {
    // The traversals are iterative precisely so chain length cannot become
    // call-stack depth.
    const members = [];
    const edges = [];
    for (let issueNumber = 1; issueNumber <= 20_000; issueNumber += 1) {
      members.push({ issueNumber, role: issueNumber === 1 ? 'head' : 'node' });
      if (issueNumber > 1) {
        edges.push({ blockerIssueNumber: issueNumber - 1, blockedIssueNumber: issueNumber });
      }
    }
    const result = validateChainGraph({ headIssueNumber: 1, members, edges });
    expect(result.ok).toBe(true);
    expect(result.graph.topologicalOrder).toHaveLength(20_000);
  }, 30_000);
});

describe('membership and identity refusals', () => {
  test('an edge naming a non-member is rejected with the edges that name it', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 9 },
      ],
    });
    expect(codes(result)).toEqual(['missing_member']);
    const missing = findDiagnostic(result, 'missing_member');
    expect(missing.issues).toEqual([9]);
    expect(missing.observedEdges).toEqual([{ blockerIssueNumber: 2, blockedIssueNumber: 9 }]);
  });

  test('a chain with no members is rejected', () => {
    const result = validateChainGraph({ headIssueNumber: 1, members: [], edges: [] });
    expect(codes(result)).toEqual(['empty_members', 'head_not_member']);
  });

  test('a head outside the membership is rejected', () => {
    const result = validateChainGraph({ headIssueNumber: 9, members: [{ issueNumber: 1 }], edges: [] });
    expect(codes(result)).toEqual(['head_not_member']);
    expect(findDiagnostic(result, 'head_not_member').issues).toEqual([9]);
  });

  test('one issue listed with conflicting roles is an ambiguous identity', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 1, role: 'node' }],
      edges: [],
    });
    expect(codes(result)).toEqual(['ambiguous_identity']);
    expect(findDiagnostic(result, 'ambiguous_identity').issues).toEqual([1]);
  });

  test('two issues claiming the head role is an ambiguous identity', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2, role: 'head' }],
      edges: [],
    });
    expect(codes(result)).toEqual(['ambiguous_identity']);
    expect(findDiagnostic(result, 'ambiguous_identity').issues).toEqual([1, 2]);
  });

  test('a declared head the roles disagree with is an ambiguous identity', () => {
    const result = validateChainGraph({
      headIssueNumber: 2,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2, role: 'node' }],
      edges: [],
    });
    expect(codes(result)).toEqual(['ambiguous_identity']);
    expect(findDiagnostic(result, 'ambiguous_identity').issues).toEqual([1, 2]);
  });

  test('a head declared without any member carrying the head role is accepted', () => {
    // Roles are optional; silence is agreement, not disagreement.
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [{ issueNumber: 1 }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
    });
    expect(result.ok).toBe(true);
  });

  test('an exact duplicate member is rejected as redundancy, not ambiguity', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }, { issueNumber: 2 }],
      edges: [],
    });
    expect(codes(result)).toEqual(['duplicate_member']);
  });

  test('a duplicated edge reports the observed copies against the single expected one', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 2 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      ],
    });
    expect(codes(result)).toEqual(['duplicate_edge']);
    const duplicate = findDiagnostic(result, 'duplicate_edge');
    expect(duplicate.observedEdges).toHaveLength(2);
    expect(duplicate.expectedEdges).toEqual([{ blockerIssueNumber: 1, blockedIssueNumber: 2 }]);
  });

  test('a self-edge is rejected', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 1 }],
    });
    expect(codes(result)).toEqual(['self_edge']);
  });

  test('malformed issue numbers, roles, and chain ids are rejected without echoing payloads', () => {
    const result = validateChainGraph({
      chainId: 'not a chain id',
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 0 }, { issueNumber: 2, role: 'captain' }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: -4 }],
    });
    expect(codes(result)).toEqual([
      'invalid_chain_id',
      'invalid_issue_number',
      'invalid_issue_number',
      'invalid_role',
    ]);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message.length).toBeLessThan(160);
    }
  });

  test('a long malformed value is clipped in the message', () => {
    const result = validateChainGraph({
      headIssueNumber: 1,
      members: [HEAD, { issueNumber: 'x'.repeat(500) }],
      edges: [],
    });
    const invalid = findDiagnostic(result, 'invalid_issue_number');
    expect(invalid.message).toContain('…');
    expect(invalid.message.length).toBeLessThan(120);
  });
});

describe('duplicate chain ownership', () => {
  test('a member another chain already owns is rejected, grouped by that chain', () => {
    const result = validateChainGraph(
      {
        chainId: 'chain_1',
        headIssueNumber: 1,
        members: [HEAD, { issueNumber: 2 }, { issueNumber: 3 }],
        edges: [
          { blockerIssueNumber: 1, blockedIssueNumber: 2 },
          { blockerIssueNumber: 2, blockedIssueNumber: 3 },
        ],
      },
      {
        ownership: [
          { issueNumber: 3, chainId: 'chain_9' },
          { issueNumber: 2, chainId: 'chain_9' },
        ],
      },
    );
    expect(codes(result)).toEqual(['duplicate_ownership']);
    const duplicate = findDiagnostic(result, 'duplicate_ownership');
    expect(duplicate.issues).toEqual([2, 3]);
    expect(duplicate.chains).toEqual(['chain_9']);
  });

  test('the chain re-declaring its own members is not duplicate ownership', () => {
    const result = validateChainGraph(
      { chainId: 'chain_1', headIssueNumber: 1, members: [HEAD], edges: [] },
      { ownership: [{ issueNumber: 1, chainId: 'chain_1' }] },
    );
    expect(result.ok).toBe(true);
  });

  test('two foreign chains produce one finding each', () => {
    const result = validateChainGraph(
      {
        chainId: 'chain_1',
        headIssueNumber: 1,
        members: [HEAD, { issueNumber: 2 }],
        edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      },
      {
        ownership: [
          { issueNumber: 2, chainId: 'chain_9' },
          { issueNumber: 1, chainId: 'chain_5' },
        ],
      },
    );
    expect(result.diagnostics.map((d) => d.chains)).toEqual([['chain_5'], ['chain_9']]);
  });

  test('ownership claims about non-members are ignored', () => {
    const result = validateChainGraph(
      { chainId: 'chain_1', headIssueNumber: 1, members: [HEAD], edges: [] },
      { ownership: [{ issueNumber: 42, chainId: 'chain_9' }] },
    );
    expect(result.ok).toBe(true);
  });
});

describe('deterministic diagnostics', () => {
  const scrambled = {
    chainId: 'chain_1',
    headIssueNumber: 4,
    members: [
      { issueNumber: 3, role: 'head' },
      { issueNumber: 2 },
      { issueNumber: 2 },
      { issueNumber: 4 },
    ],
    edges: [
      { blockerIssueNumber: 4, blockedIssueNumber: 9 },
      { blockerIssueNumber: 2, blockedIssueNumber: 3 },
      { blockerIssueNumber: 3, blockedIssueNumber: 2 },
      { blockerIssueNumber: 4, blockedIssueNumber: 4 },
    ],
  };

  test('input order does not change the diagnostics or their order', () => {
    const forwards = validateChainGraph(scrambled, {
      ownership: [{ issueNumber: 2, chainId: 'chain_9' }],
    });
    const backwards = validateChainGraph(
      {
        ...scrambled,
        members: [...scrambled.members].reverse(),
        edges: [...scrambled.edges].reverse(),
      },
      { ownership: [{ issueNumber: 2, chainId: 'chain_9' }] },
    );
    expect(backwards.diagnostics).toEqual(forwards.diagnostics);
  });

  test('diagnostics come back in the declared code order', () => {
    const result = validateChainGraph(scrambled, {
      ownership: [{ issueNumber: 2, chainId: 'chain_9' }],
    });
    const order = result.diagnostics.map((d) => CHAIN_GRAPH_DIAGNOSTIC_CODES.indexOf(d.code));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(codes(result)).toEqual([
      'duplicate_member',
      'ambiguous_identity',
      'missing_member',
      'self_edge',
      'cycle',
      'duplicate_ownership',
    ]);
  });

  test('every reported code belongs to the declared vocabulary', () => {
    const result = validateChainGraph(scrambled, {
      ownership: [{ issueNumber: 2, chainId: 'chain_9' }],
    });
    for (const diagnostic of result.diagnostics) {
      expect(isChainGraphDiagnosticCode(diagnostic.code)).toBe(true);
    }
    expect(isChainGraphDiagnosticCode('not_a_code')).toBe(false);
  });
});

describe('topological order', () => {
  test('fan-out resolves to one canonical order, smallest ready issue first', () => {
    const order = chainGraphTopologicalOrder(
      [1, 2, 3, 4],
      [
        { blockerIssueNumber: 1, blockedIssueNumber: 3 },
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      ],
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  test('blockers always come before what they block', () => {
    const order = chainGraphTopologicalOrder(
      [10, 20, 30],
      [
        { blockerIssueNumber: 30, blockedIssueNumber: 10 },
        { blockerIssueNumber: 10, blockedIssueNumber: 20 },
      ],
    );
    expect(order).toEqual([30, 10, 20]);
  });

  test('a cyclic graph has no order', () => {
    expect(
      chainGraphTopologicalOrder(
        [1, 2],
        [
          { blockerIssueNumber: 1, blockedIssueNumber: 2 },
          { blockerIssueNumber: 2, blockedIssueNumber: 1 },
        ],
      ),
    ).toBeUndefined();
  });
});

describe('comparison', () => {
  const persisted = {
    members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
    edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
  };

  test('the same graph in a different order is equivalent', () => {
    const comparison = compareChainGraphs(persisted, {
      members: [{ issueNumber: 2, role: 'node' }, { issueNumber: 1, role: 'head' }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
    });
    expect(comparison.equivalent).toBe(true);
    expect(comparison.diagnostics).toEqual([]);
    expect(comparison.observedFingerprint).toBe(comparison.expectedFingerprint);
  });

  test('a differing edge set reports expected against observed', () => {
    const comparison = compareChainGraphs(persisted, {
      members: persisted.members,
      edges: [{ blockerIssueNumber: 2, blockedIssueNumber: 1 }],
    });
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diagnostics.map((d) => d.code)).toEqual(['edge_mismatch']);
    const mismatch = comparison.diagnostics[0];
    expect(mismatch.expectedEdges).toEqual([{ blockerIssueNumber: 1, blockedIssueNumber: 2 }]);
    expect(mismatch.observedEdges).toEqual([{ blockerIssueNumber: 2, blockedIssueNumber: 1 }]);
    expect(mismatch.issues).toEqual([1, 2]);
  });

  test('a differing membership or role is reported', () => {
    const comparison = compareChainGraphs(persisted, {
      members: [{ issueNumber: 1, role: 'node' }, { issueNumber: 2 }, { issueNumber: 3 }],
      edges: persisted.edges,
    });
    expect(comparison.diagnostics.map((d) => d.code)).toEqual(['member_mismatch']);
    expect(comparison.diagnostics[0].issues).toEqual([1, 3]);
  });

  test('a duplicate member in the observed snapshot is reported, not normalized away', () => {
    const comparison = compareChainGraphs(persisted, {
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }, { issueNumber: 2 }],
      edges: persisted.edges,
    });
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diagnostics.map((d) => d.code)).toEqual(['duplicate_member']);
    expect(comparison.diagnostics[0].issues).toEqual([2]);
    expect(comparison.diagnostics[0].message).toBe(
      'observed graph lists issue 2 as a member more than once',
    );
  });

  test('a malformed expected snapshot is named on its own side', () => {
    const comparison = compareChainGraphs(
      {
        members: [...persisted.members, { issueNumber: 2 }],
        edges: persisted.edges,
      },
      persisted,
    );
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diagnostics[0].message).toBe(
      'expected graph lists issue 2 as a member more than once',
    );
  });

  test('an unknown observed role is reported rather than read as a node', () => {
    const comparison = compareChainGraphs(persisted, {
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2, role: 'branch' }],
      edges: persisted.edges,
    });
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diagnostics.map((d) => d.code)).toEqual(['invalid_role', 'member_mismatch']);
    expect(comparison.diagnostics[0].message).toBe(
      'observed member issue 2 carries an unknown member role: "branch"',
    );
    expect(comparison.observedFingerprint).not.toBe(comparison.expectedFingerprint);
  });

  test('conflicting observed roles for one issue are ambiguous, not first-wins', () => {
    const comparison = compareChainGraphs(persisted, {
      members: [
        { issueNumber: 1, role: 'head' },
        { issueNumber: 2, role: 'node' },
        { issueNumber: 2, role: 'head' },
      ],
      edges: persisted.edges,
    });
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diagnostics.map((d) => d.code)).toEqual(['ambiguous_identity']);
    expect(comparison.diagnostics[0].issues).toEqual([2]);
  });

  test('a duplicate observed edge is reported, not collapsed', () => {
    const comparison = compareChainGraphs(persisted, {
      members: persisted.members,
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      ],
    });
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diagnostics.map((d) => d.code)).toEqual(['duplicate_edge']);
    expect(comparison.diagnostics[0].observedEdges).toEqual([
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
    ]);
    expect(comparison.diagnostics[0].expectedEdges).toEqual([
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
    ]);
  });

  test('an observed entry that is not an issue number at all is reported', () => {
    const comparison = compareChainGraphs(persisted, {
      members: [...persisted.members, { issueNumber: 0 }],
      edges: [...persisted.edges, { blockerIssueNumber: 1, blockedIssueNumber: -3 }],
    });
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diagnostics.map((d) => d.message)).toEqual([
      'observed edge endpoint is not a positive integer: -3',
      'observed member issue number is not a positive integer: 0',
    ]);
  });

  test('comparison judges neither side — a cyclic observed graph still compares', () => {
    const comparison = compareChainGraphs(persisted, {
      members: persisted.members,
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 1 },
      ],
    });
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diagnostics.map((d) => d.code)).toEqual(['edge_mismatch']);
  });
});

describe('rendering', () => {
  test('an edge renders in its reading direction', () => {
    expect(formatChainGraphEdge({ blockerIssueNumber: 12, blockedIssueNumber: 34 })).toBe('12 -> 34');
  });
});
