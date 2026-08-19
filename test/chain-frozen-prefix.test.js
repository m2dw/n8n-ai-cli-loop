/**
 * Frozen dependency prefixes (issue #891): what a freeze records, and which
 * later graph edits it refuses.
 *
 * The rule every test below is a case of: a candidate may change anything
 * wholly downstream of every started Issue, and nothing at or above one.
 */
import {
  FROZEN_PREFIX_VIOLATION_CODES,
  buildFrozenPrefix,
  canonicalFrozenPrefixText,
  chainBaseDecisionsEqual,
  checkFrozenPrefixes,
  computeChainPrefix,
  frozenPrefixFingerprint,
  isChainBaseDecision,
  isFrozenPrefixViolationCode,
  validateFrozenPrefixSnapshot,
} from '../dist/index.js';

const NOW = '2026-08-08T10:00:00.000Z';
const DEFAULT_BASE = { kind: 'default', baseRef: 'origin/main' };

/** 1 -> 2 -> 3 -> 4, with 4 the started Issue in most tests. */
const LINEAR = {
  members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }, { issueNumber: 3 }, { issueNumber: 4 }],
  edges: [
    { blockerIssueNumber: 1, blockedIssueNumber: 2 },
    { blockerIssueNumber: 2, blockedIssueNumber: 3 },
    { blockerIssueNumber: 3, blockedIssueNumber: 4 },
  ],
};

function graph(members, edges) {
  return {
    members: members.map((issueNumber, index) =>
      index === 0 ? { issueNumber, role: 'head' } : { issueNumber },
    ),
    edges: edges.map(([blockerIssueNumber, blockedIssueNumber]) => ({
      blockerIssueNumber,
      blockedIssueNumber,
    })),
  };
}

function freeze(issueNumber, source, overrides = {}) {
  return buildFrozenPrefix({
    sessionId: 's1',
    issueNumber,
    chainId: 'chain_1',
    graph: source,
    graphRevision: 2,
    graphFingerprint: 'sha256:accepted',
    base: DEFAULT_BASE,
    frozenAt: NOW,
    ...overrides,
  });
}

/** Codes reported for `candidate`, in the guard's own order. */
function codes(snapshots, candidate, options = {}) {
  const verdict = checkFrozenPrefixes({ candidate, snapshots, ...options });
  return verdict.ok ? [] : verdict.violations.map((v) => `${v.issueNumber}:${v.code}`);
}

/* ---------------------------------------------------------------------
 * Prefix computation
 * ------------------------------------------------------------------ */

test('a linear chain freezes every direct and transitive blocker, in order', () => {
  const prefix = computeChainPrefix(LINEAR, 4);

  expect(prefix).toEqual({
    issueNumber: 4,
    ancestors: [1, 2, 3],
    predecessors: [3],
    edges: [
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      { blockerIssueNumber: 2, blockedIssueNumber: 3 },
      { blockerIssueNumber: 3, blockedIssueNumber: 4 },
    ],
    order: [1, 2, 3, 4],
  });
});

test('fan-in freezes every incoming edge, not just one predecessor', () => {
  // 1 -> 4, 2 -> 4, 3 -> 4
  const prefix = computeChainPrefix(graph([1, 2, 3, 4], [[1, 4], [2, 4], [3, 4]]), 4);

  expect(prefix.ancestors).toEqual([1, 2, 3]);
  expect(prefix.predecessors).toEqual([1, 2, 3]);
  expect(prefix.edges).toHaveLength(3);
  expect(prefix.order).toEqual([1, 2, 3, 4]);
});

test('fan-out freezes only the branch above the started issue', () => {
  // 1 blocks 2, 3, and 4; the freeze on 2 must not drag in its siblings.
  const prefix = computeChainPrefix(graph([1, 2, 3, 4], [[1, 2], [1, 3], [1, 4]]), 2);

  expect(prefix.ancestors).toEqual([1]);
  expect(prefix.edges).toEqual([{ blockerIssueNumber: 1, blockedIssueNumber: 2 }]);
  expect(prefix.order).toEqual([1, 2]);
});

test('an issue with no blockers freezes an empty prefix', () => {
  expect(computeChainPrefix(LINEAR, 1)).toEqual({
    issueNumber: 1,
    ancestors: [],
    predecessors: [],
    edges: [],
    order: [1],
  });
});

test('an edge naming a non-member is not read as ancestry', () => {
  // #890 refuses this graph outright; the prefix must not read the orphaned
  // edge as a blocker the freeze should have covered.
  const orphaned = {
    members: [{ issueNumber: 4, role: 'head' }],
    edges: [{ blockerIssueNumber: 3, blockedIssueNumber: 4 }],
  };

  expect(computeChainPrefix(orphaned, 4).ancestors).toEqual([]);
});

test('a cycle through the started issue terminates and does not make it its own ancestor', () => {
  const cyclic = graph([1, 2, 3], [[1, 2], [2, 3], [3, 1]]);

  expect(computeChainPrefix(cyclic, 3).ancestors).toEqual([1, 2]);
});

test('a cycle among the blockers leaves the prefix with no order at all', () => {
  // 1 and 2 block each other, 2 blocks 3, 3 blocks 4.
  const cyclic = graph([1, 2, 3, 4], [[1, 2], [2, 1], [2, 3], [3, 4]]);
  const prefix = computeChainPrefix(cyclic, 4);

  expect(prefix.ancestors).toEqual([1, 2, 3]);
  // No topological order exists, and the prefix says so rather than inventing
  // one. #890 refuses such a graph anyway; this layer must not hang on it.
  expect(prefix.order).toEqual([]);
});

/* ---------------------------------------------------------------------
 * Snapshot identity and idempotency
 * ------------------------------------------------------------------ */

test('a first freeze records ancestry, incoming edges, revision, fingerprint, and base', () => {
  const snapshot = freeze(4, LINEAR, { source: 'intake' });

  expect(snapshot).toMatchObject({
    sessionId: 's1',
    issueNumber: 4,
    chainId: 'chain_1',
    graphRevision: 2,
    graphFingerprint: 'sha256:accepted',
    ancestors: [1, 2, 3],
    predecessors: [3],
    order: [1, 2, 3, 4],
    base: DEFAULT_BASE,
    source: 'intake',
    frozenAt: NOW,
  });
  expect(snapshot.edges).toHaveLength(3);
  expect(snapshot.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(validateFrozenPrefixSnapshot(snapshot)).toBeUndefined();
});

test('the same contract fingerprints identically however the graph was ordered', () => {
  const shuffled = {
    members: [...LINEAR.members].reverse(),
    edges: [...LINEAR.edges].reverse(),
  };

  expect(freeze(4, shuffled).fingerprint).toBe(freeze(4, LINEAR).fingerprint);
});

test('the fingerprint ignores provenance, so a re-freeze from a later revision is the same freeze', () => {
  // The accepted revision moved on because something downstream was accepted.
  // Re-freezing the same contract must stay recognizable as the same freeze,
  // otherwise the one operation required to be idempotent becomes a conflict.
  const first = freeze(4, LINEAR);
  const later = freeze(4, LINEAR, {
    graphRevision: 9,
    graphFingerprint: 'sha256:later',
    frozenAt: '2026-08-09T00:00:00.000Z',
  });

  expect(later.fingerprint).toBe(first.fingerprint);
  expect(canonicalFrozenPrefixText(later)).toBe(canonicalFrozenPrefixText(first));
});

test('the fingerprint separates a reorder from the same edges in a different order', () => {
  const reordered = graph([1, 2, 3, 4], [[2, 1], [1, 3], [3, 4]]);

  expect(freeze(4, reordered).fingerprint).not.toBe(freeze(4, LINEAR).fingerprint);
});

test('the fingerprint separates two different base decisions', () => {
  const stacked = freeze(4, LINEAR, {
    base: { kind: 'stacked', baseRef: 'ai/issue-3', baseIssueNumber: 3 },
  });

  expect(stacked.fingerprint).not.toBe(freeze(4, LINEAR).fingerprint);
});

test('a base ref containing the separator cannot collide with another decision', () => {
  const a = { kind: 'default', baseRef: 'refs/x" 7' };
  const b = { kind: 'default', baseRef: 'refs/x' };

  expect(freeze(4, LINEAR, { base: a }).fingerprint).not.toBe(
    freeze(4, LINEAR, { base: b }).fingerprint,
  );
});

test('a snapshot whose fingerprint does not describe its own contract is refused', () => {
  const tampered = { ...freeze(4, LINEAR), ancestors: [1, 2] };

  expect(validateFrozenPrefixSnapshot(tampered)).toMatch(/fingerprint does not match/);
});

test.each([
  ['sessionId', { sessionId: '' }, /sessionId is required/],
  ['issueNumber', { issueNumber: 0 }, /issueNumber must be a positive integer/],
  ['chainId', { chainId: 'not-a-chain' }, /malformed chain id/],
  ['graphRevision', { graphRevision: 0 }, /graphRevision must be a positive integer/],
  ['graphFingerprint', { graphFingerprint: '' }, /graphFingerprint is required/],
  ['base', { base: { kind: 'stacked', baseRef: 'ai/issue-3' } }, /well-formed base decision/],
  ['frozenAt', { frozenAt: '' }, /frozenAt is required/],
])('a snapshot with a malformed %s is refused', (_field, override, expected) => {
  expect(validateFrozenPrefixSnapshot({ ...freeze(4, LINEAR), ...override })).toMatch(expected);
});

test('a stacked base must name the issue it stacks on, and a default base must not', () => {
  expect(isChainBaseDecision({ kind: 'stacked', baseRef: 'ai/issue-3', baseIssueNumber: 3 })).toBe(true);
  expect(isChainBaseDecision({ kind: 'stacked', baseRef: 'ai/issue-3' })).toBe(false);
  expect(isChainBaseDecision({ kind: 'default', baseRef: 'main', baseIssueNumber: 3 })).toBe(false);
  expect(isChainBaseDecision({ kind: 'rebased', baseRef: 'main' })).toBe(false);
  expect(isChainBaseDecision({ kind: 'default', baseRef: '' })).toBe(false);
  expect(chainBaseDecisionsEqual(DEFAULT_BASE, { kind: 'default', baseRef: 'origin/main' })).toBe(true);
});

/* ---------------------------------------------------------------------
 * Allowed downstream edits
 * ------------------------------------------------------------------ */

test('appending downstream of a started issue stays valid', () => {
  const snapshot = freeze(4, LINEAR);
  // 4 now blocks a brand new 5.
  const appended = graph([1, 2, 3, 4, 5], [[1, 2], [2, 3], [3, 4], [4, 5]]);

  expect(checkFrozenPrefixes({ candidate: appended, snapshots: [snapshot] })).toEqual({
    ok: true,
    evaluated: 1,
  });
});

test('editing a sibling branch below a shared blocker stays valid', () => {
  // 1 blocks both 2 (started) and 3; re-pointing 3's own downstream is not 2's
  // business.
  const snapshot = freeze(2, graph([1, 2, 3], [[1, 2], [1, 3]]));
  const edited = graph([1, 2, 3, 7], [[1, 2], [1, 3], [3, 7]]);

  expect(codes([snapshot], edited)).toEqual([]);
});

test('an unrelated chain fragment can be added freely', () => {
  const snapshot = freeze(4, LINEAR);
  const grown = graph([1, 2, 3, 4, 8, 9], [[1, 2], [2, 3], [3, 4], [8, 9]]);

  expect(codes([snapshot], grown)).toEqual([]);
});

test('snapshots frozen against another chain are not evaluated', () => {
  const other = freeze(4, LINEAR, { chainId: 'chain_2' });
  const prepended = graph([9, 1, 2, 3, 4], [[9, 1], [1, 2], [2, 3], [3, 4]]);

  expect(codes([other], prepended, { chainId: 'chain_1' })).toEqual([]);
  expect(checkFrozenPrefixes({ candidate: prepended, snapshots: [other], chainId: 'chain_1' }))
    .toEqual({ ok: true, evaluated: 0 });
});

/* ---------------------------------------------------------------------
 * Refused mutations
 * ------------------------------------------------------------------ */

test('prepending a blocker above a started issue is a frozen_prefix_conflict', () => {
  const snapshot = freeze(4, LINEAR);
  const prepended = graph([9, 1, 2, 3, 4], [[9, 1], [1, 2], [2, 3], [3, 4]]);

  const verdict = checkFrozenPrefixes({ candidate: prepended, snapshots: [snapshot] });
  expect(verdict.ok).toBe(false);
  expect(verdict.code).toBe('frozen_prefix_conflict');
  expect(verdict.violations.map((v) => v.code)).toEqual([
    'ancestor_added',
    'prefix_edge_added',
    'order_changed',
  ]);
  expect(verdict.violations[0]).toMatchObject({
    sessionId: 's1',
    issueNumber: 4,
    chainId: 'chain_1',
    issues: [9],
  });
  expect(verdict.violations[1].observedEdges).toEqual([
    { blockerIssueNumber: 9, blockedIssueNumber: 1 },
  ]);
  expect(verdict.violations[2]).toMatchObject({
    expectedOrder: [1, 2, 3, 4],
    observedOrder: [9, 1, 2, 3, 4],
  });
});

test('inserting a blocker directly in front of a started issue is refused', () => {
  const snapshot = freeze(4, LINEAR);
  // 3 -> 4 becomes 3 -> 9 -> 4.
  const inserted = graph([1, 2, 3, 9, 4], [[1, 2], [2, 3], [3, 9], [9, 4]]);

  expect(codes([snapshot], inserted)).toEqual([
    '4:ancestor_added',
    '4:incoming_edge_added',
    '4:incoming_edge_removed',
    '4:prefix_edge_added',
    '4:order_changed',
  ]);
});

test('reordering two frozen blockers is refused even though the ancestor set is identical', () => {
  const snapshot = freeze(4, LINEAR);
  // 1 -> 2 -> 3 becomes 2 -> 1 -> 3: same members, same incoming edge to 4.
  const swapped = graph([1, 2, 3, 4], [[2, 1], [1, 3], [3, 4]]);

  const verdict = checkFrozenPrefixes({ candidate: swapped, snapshots: [snapshot] });
  expect(verdict.ok).toBe(false);
  const byCode = Object.fromEntries(verdict.violations.map((v) => [v.code, v]));
  expect(Object.keys(byCode).sort()).toEqual([
    'order_changed',
    'prefix_edge_added',
    'prefix_edge_removed',
  ]);
  expect(byCode.order_changed).toMatchObject({
    expectedOrder: [1, 2, 3, 4],
    observedOrder: [2, 1, 3, 4],
  });
});

test('splitting a frozen blocker into two issues is refused', () => {
  const snapshot = freeze(4, LINEAR);
  // 2 becomes 2 + 5, both above 3.
  const split = graph([1, 2, 5, 3, 4], [[1, 2], [1, 5], [2, 3], [5, 3], [3, 4]]);

  expect(codes([snapshot], split)).toEqual([
    '4:ancestor_added',
    '4:prefix_edge_added',
    '4:order_changed',
  ]);
});

test('merging two frozen blockers into one is refused', () => {
  const snapshot = freeze(4, graph([1, 2, 3, 4], [[1, 3], [2, 3], [3, 4]]));
  // 2 is folded into 1.
  const merged = graph([1, 3, 4], [[1, 3], [3, 4]]);

  expect(codes([snapshot], merged)).toEqual([
    '4:ancestor_removed',
    '4:prefix_edge_removed',
    '4:order_changed',
  ]);
});

test('dropping a frozen incoming edge is refused', () => {
  const snapshot = freeze(4, LINEAR);
  const detached = graph([1, 2, 3, 4], [[1, 2], [2, 3]]);

  // Detaching 4 does not merely drop one edge: everything above it stops being
  // its ancestry, so the whole frozen prefix is reported as lost.
  expect(codes([snapshot], detached)).toEqual([
    '4:ancestor_removed',
    '4:incoming_edge_removed',
    '4:prefix_edge_removed',
    '4:order_changed',
  ]);
});

test('removing the started issue from the chain is reported once, not as four consequences', () => {
  const snapshot = freeze(4, LINEAR);
  const removed = graph([1, 2, 3], [[1, 2], [2, 3]]);

  const verdict = checkFrozenPrefixes({ candidate: removed, snapshots: [snapshot] });
  expect(verdict.violations).toHaveLength(1);
  expect(verdict.violations[0]).toMatchObject({
    code: 'frozen_issue_missing',
    issueNumber: 4,
    issues: [4],
  });
});

test('a base decision that moved is refused, with both decisions in the finding', () => {
  const snapshot = freeze(4, LINEAR, {
    base: { kind: 'stacked', baseRef: 'ai/issue-3', baseIssueNumber: 3 },
  });

  const verdict = checkFrozenPrefixes({
    candidate: LINEAR,
    snapshots: [snapshot],
    baseDecisions: [{ issueNumber: 4, base: { kind: 'default', baseRef: 'origin/main' } }],
  });

  expect(verdict.ok).toBe(false);
  expect(verdict.violations).toHaveLength(1);
  expect(verdict.violations[0]).toMatchObject({
    code: 'base_changed',
    issueNumber: 4,
    issues: [3, 4],
    expectedBase: { kind: 'stacked', baseRef: 'ai/issue-3', baseIssueNumber: 3 },
    observedBase: { kind: 'default', baseRef: 'origin/main' },
  });
});

test('a base decision that is not restated is not checked', () => {
  // A topology edit says nothing about bases; inventing an answer would either
  // refuse every edit or bless a base move nobody declared.
  const snapshot = freeze(4, LINEAR, {
    base: { kind: 'stacked', baseRef: 'ai/issue-3', baseIssueNumber: 3 },
  });

  expect(codes([snapshot], LINEAR)).toEqual([]);
  expect(
    codes([snapshot], LINEAR, {
      baseDecisions: [{ issueNumber: 4, base: { kind: 'stacked', baseRef: 'ai/issue-3', baseIssueNumber: 3 } }],
    }),
  ).toEqual([]);
});

/* ---------------------------------------------------------------------
 * Several started issues in one DAG
 * ------------------------------------------------------------------ */

test('multiple frozen issues are each evaluated, and one cannot excuse another', () => {
  // 1 -> 2 -> 3 -> 4, with both 3 and 4 started.
  const three = freeze(3, LINEAR);
  const four = freeze(4, LINEAR);
  const prepended = graph([9, 1, 2, 3, 4], [[9, 1], [1, 2], [2, 3], [3, 4]]);

  const verdict = checkFrozenPrefixes({ candidate: prepended, snapshots: [four, three] });
  expect(verdict.evaluated).toBe(2);
  // Grouped by the started Issue, ascending, whatever order the snapshots came
  // in — an operator reads one block per started task.
  expect(verdict.violations.map((v) => `${v.issueNumber}:${v.code}`)).toEqual([
    '3:ancestor_added',
    '3:prefix_edge_added',
    '3:order_changed',
    '4:ancestor_added',
    '4:prefix_edge_added',
    '4:order_changed',
  ]);
});

test('an edit inside one frozen prefix leaves the other frozen issue silent', () => {
  // 1 -> 2 (started) and 5 -> 6 (started) are independent branches of one DAG.
  const dag = graph([1, 2, 5, 6], [[1, 2], [5, 6]]);
  const two = freeze(2, dag);
  const six = freeze(6, dag);
  const edited = graph([1, 2, 5, 6, 7], [[1, 2], [7, 5], [5, 6]]);

  expect(codes([two, six], edited)).toEqual([
    '6:ancestor_added',
    '6:prefix_edge_added',
    '6:order_changed',
  ]);
});

test('a fan-in issue frozen with three predecessors refuses losing one of them', () => {
  const fanIn = graph([1, 2, 3, 4], [[1, 4], [2, 4], [3, 4]]);
  const snapshot = freeze(4, fanIn);
  const narrowed = graph([1, 2, 3, 4], [[1, 4], [2, 4]]);

  const verdict = checkFrozenPrefixes({ candidate: narrowed, snapshots: [snapshot] });
  const removed = verdict.violations.find((v) => v.code === 'incoming_edge_removed');
  expect(removed.expectedEdges).toEqual([{ blockerIssueNumber: 3, blockedIssueNumber: 4 }]);
  expect(removed.observedEdges).toEqual([]);
});

test('the guard is deterministic: the same inputs produce the same list twice', () => {
  const snapshot = freeze(4, LINEAR);
  const mangled = graph([9, 1, 2, 3, 4], [[9, 2], [1, 2], [3, 4]]);

  const first = checkFrozenPrefixes({ candidate: mangled, snapshots: [snapshot] });
  const second = checkFrozenPrefixes({ candidate: mangled, snapshots: [snapshot] });
  expect(second).toEqual(first);
});

test('every violation code is a member of the declared closed list', () => {
  const snapshot = freeze(4, LINEAR);
  const mangled = graph([9, 1, 2, 3, 4], [[9, 2], [1, 2], [3, 4]]);
  const verdict = checkFrozenPrefixes({
    candidate: mangled,
    snapshots: [snapshot],
    baseDecisions: [{ issueNumber: 4, base: { kind: 'default', baseRef: 'other' } }],
  });

  for (const violation of verdict.violations) {
    expect(isFrozenPrefixViolationCode(violation.code)).toBe(true);
    expect(FROZEN_PREFIX_VIOLATION_CODES).toContain(violation.code);
    expect(typeof violation.message).toBe('string');
  }
  expect(isFrozenPrefixViolationCode('nope')).toBe(false);
});

test('a message never echoes an unbounded base ref back into a log', () => {
  const long = 'x'.repeat(200);
  const snapshot = freeze(4, LINEAR, { base: { kind: 'default', baseRef: long } });
  const verdict = checkFrozenPrefixes({
    candidate: LINEAR,
    snapshots: [snapshot],
    baseDecisions: [{ issueNumber: 4, base: { kind: 'default', baseRef: 'origin/main' } }],
  });

  expect(verdict.violations[0].message).toContain('…');
  expect(verdict.violations[0].message.length).toBeLessThan(200);
  // The full value is still available structurally, just not in the message.
  expect(verdict.violations[0].expectedBase.baseRef).toBe(long);
});

test('no snapshots means nothing to guard', () => {
  expect(checkFrozenPrefixes({ candidate: LINEAR, snapshots: [] })).toEqual({
    ok: true,
    evaluated: 0,
  });
});
