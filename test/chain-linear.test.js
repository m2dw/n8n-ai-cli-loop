/**
 * Linear chain construction/editing decisions (issue #791).
 *
 * `planLinearChainEdit` and `verifyLinearChainReadBack` are pure, so everything
 * about WHAT the three commands do — the orientation of the graph they build,
 * which requests they refuse and with what guidance, and which GitHub
 * relationships they consider still missing — is pinned here, without a
 * subprocess or a database. The CLI test covers the ORDER those decisions are
 * carried out in.
 */
import {
  planLinearChainEdit,
  verifyLinearChainReadBack,
  buildFrozenPrefix,
  chainGraphFingerprint,
} from '../dist/index.js';

const NOW = '2026-08-09T10:00:00.000Z';

function plan(overrides = {}) {
  return planLinearChainEdit({
    operation: 'new',
    issueNumbers: [10, 11, 12],
    observedEdges: [],
    observedIssues: [10, 11, 12],
    frozenSnapshots: [],
    ownership: [],
    providerErrors: [],
    ...overrides,
  });
}

/** A chain of 20 -> 21 with 21 as its head, as the registry would hold it. */
function linearTarget(overrides = {}) {
  return {
    chainId: 'chain_21',
    headIssueNumber: 21,
    members: [
      { issueNumber: 20, role: 'node' },
      { issueNumber: 21, role: 'head' },
    ],
    edges: [{ blockerIssueNumber: 20, blockedIssueNumber: 21 }],
    graphRevision: 3,
    acceptedRevision: 3,
    ...overrides,
  };
}

/**
 * A chain that is a valid DAG but not a line: 20 forks to 21 and 22, which
 * merge back into the head 23. `chain sync` imports such a shape from GitHub
 * happily; the linear commands must refuse to extend it.
 */
function branchedTarget(overrides = {}) {
  return {
    chainId: 'chain_23',
    headIssueNumber: 23,
    members: [
      { issueNumber: 20, role: 'node' },
      { issueNumber: 21, role: 'node' },
      { issueNumber: 22, role: 'node' },
      { issueNumber: 23, role: 'head' },
    ],
    edges: [
      { blockerIssueNumber: 20, blockedIssueNumber: 21 },
      { blockerIssueNumber: 20, blockedIssueNumber: 22 },
      { blockerIssueNumber: 21, blockedIssueNumber: 23 },
      { blockerIssueNumber: 22, blockedIssueNumber: 23 },
    ],
    graphRevision: 3,
    acceptedRevision: 3,
    ...overrides,
  };
}

/**
 * An append/prepend plan whose observation agrees with the chain on record —
 * the ordinary case. Overrides replace any field, including `observedEdges`.
 */
function extendPlan(operation, issueNumbers, overrides = {}) {
  const { target = linearTarget(), ...rest } = overrides;
  return planLinearChainEdit({
    operation,
    issueNumbers,
    target,
    observedEdges: target.edges,
    observedIssues: [...target.members.map((m) => m.issueNumber), ...issueNumbers].sort((a, b) => a - b),
    frozenSnapshots: [],
    ownership: [],
    providerErrors: [],
    ...rest,
  });
}

function edgeStrings(edges) {
  return edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`);
}

/** A frozen prefix for `issueNumber` taken from the target chain's graph. */
function freeze(target, issueNumber) {
  const graph = { members: target.members, edges: target.edges };
  return buildFrozenPrefix({
    sessionId: 'addon-dev',
    issueNumber,
    chainId: target.chainId,
    graph,
    graphRevision: target.graphRevision,
    graphFingerprint: chainGraphFingerprint(graph),
    base: { kind: 'default', baseRef: 'main' },
    frozenAt: NOW,
  });
}

describe('planLinearChainEdit — new', () => {
  test('links the Issues in the order given and makes the last one the head', () => {
    const result = plan();
    expect(result.action).toBe('apply');
    expect(result.headIssueNumber).toBe(12);
    expect(edgeStrings(result.edges)).toEqual(['10->11', '11->12']);
    expect(result.members.find((m) => m.issueNumber === 12).role).toBe('head');
    expect(result.members.filter((m) => m.role === 'head')).toHaveLength(1);
  });

  test('a single Issue is a legitimate chain with no edges', () => {
    const result = plan({ issueNumbers: [10], observedIssues: [10] });
    expect(result.action).toBe('apply');
    expect(result.edges).toEqual([]);
    expect(result.edgeAdditions).toEqual([]);
    expect(result.affectedIssues).toEqual([10]);
  });

  test('proposes exactly the relationships GitHub is missing', () => {
    const result = plan({ observedEdges: [{ blockerIssueNumber: 10, blockedIssueNumber: 11 }] });
    expect(edgeStrings(result.edgeAdditions)).toEqual(['11->12']);
    // Still every linked Issue: one whose edge already exists must not become
    // eligible while the rest of the line is being drawn.
    expect(result.affectedIssues).toEqual([10, 11, 12]);
  });

  test('refuses a relationship the plan does not account for', () => {
    const result = plan({ observedEdges: [{ blockerIssueNumber: 99, blockedIssueNumber: 10 }] });
    expect(result.action).toBe('refuse');
    expect(result.kind).toBe('structural');
    expect(result.message).toContain('99->10');
    expect(result.remediation).toContain('admin chain sync');
  });

  test('refuses an Issue that already blocks one outside the chain being created', () => {
    // The outgoing direction of the observation (issue #791 review): #12 would
    // be the new chain's head, and it already blocks #99. Registering it as a
    // downstream end would record a graph GitHub contradicts.
    const result = plan({ observedEdges: [{ blockerIssueNumber: 12, blockedIssueNumber: 99 }] });
    expect(result.action).toBe('refuse');
    expect(result.kind).toBe('structural');
    expect(result.message).toContain('12->99');
    expect(result.remediation).toContain('#893');
  });

  test('refuses an unreadable Issue as transient without judging the graph', () => {
    const result = plan({ providerErrors: [{ issueNumber: 11, error: 'boom' }] });
    expect(result.action).toBe('refuse');
    expect(result.kind).toBe('provider_error');
    expect(result.transient).toBe(true);
    expect(result.providerErrors).toEqual([{ issueNumber: 11, error: 'boom' }]);
  });

  test('refuses an Issue another chain already owns, pointing at #893', () => {
    const result = plan({ ownership: [{ issueNumber: 11, chainId: 'chain_500' }] });
    expect(result.action).toBe('refuse');
    expect(result.kind).toBe('structural');
    expect(result.message).toContain('#11 (chain_500)');
    expect(result.remediation).toContain('#893');
    expect(result.diagnostics[0].code).toBe('duplicate_ownership');
  });
});

describe('planLinearChainEdit — append', () => {
  test('extends past the head, moves the head, and demotes the old one', () => {
    const result = extendPlan('append', [22, 23]);
    expect(result.action).toBe('apply');
    expect(result.headIssueNumber).toBe(23);
    expect(edgeStrings(result.edges).sort()).toEqual(['20->21', '21->22', '22->23']);
    expect(result.members.filter((m) => m.role === 'head').map((m) => m.issueNumber)).toEqual([23]);
    // Only the new edges are drawn — the one the chain already records is
    // already on GitHub and is never rewritten from local state.
    expect(edgeStrings(result.edgeAdditions)).toEqual(['21->22', '22->23']);
    // Only the Issues whose relationships move are suspended — #20 is upstream
    // of the edit and untouched by it.
    expect(result.affectedIssues).toEqual([21, 22, 23]);
  });

  test('a retry that finds the boundary edge already written still suspends the old head', () => {
    // The first run wrote 21->22 and then failed (read-back, or the registry
    // commit). The retry sees that edge on GitHub, so it has nothing to add for
    // #21 — but #21 is suspended by the first run, and an affected set scoped to
    // the additions would never hand its labels back (issue #791 review).
    const target = linearTarget();
    const result = extendPlan('append', [22, 23], {
      target,
      observedEdges: [...target.edges, { blockerIssueNumber: 21, blockedIssueNumber: 22 }],
    });
    expect(result.action).toBe('apply');
    expect(edgeStrings(result.edgeAdditions)).toEqual(['22->23']);
    expect(result.affectedIssues).toEqual([21, 22, 23]);
  });

  test('a fully applied append still names every linked Issue as affected', () => {
    // Nothing left to write at all: the run that failed after the last
    // relationship landed suspended all three, and the retry restores all three.
    const target = linearTarget();
    const result = extendPlan('append', [22, 23], {
      target,
      observedEdges: [
        ...target.edges,
        { blockerIssueNumber: 21, blockedIssueNumber: 22 },
        { blockerIssueNumber: 22, blockedIssueNumber: 23 },
      ],
    });
    expect(result.action).toBe('apply');
    expect(result.edgeAdditions).toEqual([]);
    expect(result.affectedIssues).toEqual([21, 22, 23]);
  });

  test('refuses an Issue already in the chain as a reorder', () => {
    const result = extendPlan('append', [20]);
    expect(result.action).toBe('refuse');
    expect(result.message).toContain('already in chain_21');
    expect(result.remediation).toContain('#893');
  });

  test('refuses a head that is not the chain’s downstream end', () => {
    const target = linearTarget({
      headIssueNumber: 20,
      members: [
        { issueNumber: 20, role: 'head' },
        { issueNumber: 21, role: 'node' },
      ],
    });
    const result = extendPlan('append', [22], { target });
    expect(result.action).toBe('refuse');
    expect(result.message).toContain('already blocks');
    expect(result.remediation).toContain('#893');
  });

  test('refuses a head that blocks an Issue no chain has registered', () => {
    // The live fork the registry cannot show: #21 is the head and blocks #99,
    // which belongs to no chain, so the edge is absent from `target.edges` — and
    // invisible to a read of the members' `blocked by` sets alone. The
    // observation therefore carries BOTH directions, and appending past a head
    // something already depends on is refused rather than quietly drawing a fork
    // (issue #791 review).
    const target = linearTarget();
    const result = extendPlan('append', [22], {
      target,
      observedEdges: [...target.edges, { blockerIssueNumber: 21, blockedIssueNumber: 99 }],
    });
    expect(result.action).toBe('refuse');
    expect(result.kind).toBe('structural');
    expect(result.message).toContain("head #21 already blocks #99");
    expect(result.message).toContain("so it is not the chain's downstream end");
    expect(result.remediation).toContain('#893');
    // The edge this edit is about to draw itself (21->22, seen by a retry's
    // outgoing read) is NOT a fork — that case is the retry test above, which
    // still applies.
  });

  test('refuses a branched chain whose head is nonetheless a downstream end', () => {
    // 20 forks to 21 and 22, which merge back into 23. A perfectly valid #890
    // graph — and its head #23 blocks nothing, so the head check alone would
    // wave this through and quietly extend one topology with another.
    const target = branchedTarget();
    const result = extendPlan('append', [24], { target });
    expect(result.action).toBe('refuse');
    expect(result.kind).toBe('structural');
    expect(result.message).toContain('is not a straight line');
    expect(result.message).toContain('#20 blocks #21, #22');
    expect(result.message).toContain('#23 is blocked by #21, #22');
    expect(result.remediation).toContain('#893');
  });

  test('refuses a chain whose members fall into two disconnected runs', () => {
    // No fork, no merge, and #23 blocks nothing — but #20->#21 and #22->#23 are
    // two lines, and appending would extend one and leave the other dangling.
    const target = linearTarget({
      chainId: 'chain_23',
      headIssueNumber: 23,
      members: [
        { issueNumber: 20, role: 'node' },
        { issueNumber: 21, role: 'node' },
        { issueNumber: 22, role: 'node' },
        { issueNumber: 23, role: 'head' },
      ],
      edges: [
        { blockerIssueNumber: 20, blockedIssueNumber: 21 },
        { blockerIssueNumber: 22, blockedIssueNumber: 23 },
      ],
    });
    const result = extendPlan('append', [24], { target });
    expect(result.action).toBe('refuse');
    expect(result.message).toContain('runs in 2 separate lines');
    expect(result.message).toContain('#20, #22');
    expect(result.remediation).toContain('#893');
  });

  test('stays valid after an upstream Issue has frozen its prefix', () => {
    const target = linearTarget();
    const result = extendPlan('append', [22], { target, frozenSnapshots: [freeze(target, 21)] });
    expect(result.action).toBe('apply');
  });

  test('needs a chain to extend', () => {
    const result = plan({ operation: 'append', issueNumbers: [22], observedIssues: [22] });
    expect(result.action).toBe('refuse');
    expect(result.message).toContain('needs a registered chain');
  });

  test('refuses a chain whose persisted graph was never accepted', () => {
    const target = linearTarget({ graphRevision: 4, acceptedRevision: 3 });
    const result = extendPlan('append', [22], { target });
    expect(result.action).toBe('refuse');
    expect(result.message).toContain('holds revision 4 but has accepted 3');
    expect(result.remediation).toContain('admin chain sync');
  });

  test('will not re-create a recorded relationship GitHub no longer holds', () => {
    // The registry says 20 blocks 21; GitHub does not. Appending must not
    // quietly restore that edge as a side effect.
    const result = extendPlan('append', [22], { observedEdges: [] });
    expect(result.action).toBe('refuse');
    expect(result.message).toContain('GitHub does not hold: 20->21');
    expect(result.remediation).toContain('admin chain sync');
  });
});

describe('planLinearChainEdit — prepend', () => {
  test('attaches ahead of the root and leaves the head alone', () => {
    const result = extendPlan('prepend', [18, 19]);
    expect(result.action).toBe('apply');
    expect(result.headIssueNumber).toBe(21);
    expect(edgeStrings(result.edges).sort()).toEqual(['18->19', '19->20', '20->21']);
    expect(result.members.filter((m) => m.role === 'head').map((m) => m.issueNumber)).toEqual([21]);
    expect(edgeStrings(result.edgeAdditions)).toEqual(['18->19', '19->20']);
    expect(result.affectedIssues).toEqual([18, 19, 20]);
  });

  test('a retry that finds the boundary edge already written still suspends the root', () => {
    // Mirror of the append case: 19->20 landed before the first run failed, so
    // the retry has no addition naming #20 — the chain's root, which the first
    // run suspended.
    const target = linearTarget();
    const result = extendPlan('prepend', [18, 19], {
      target,
      observedEdges: [...target.edges, { blockerIssueNumber: 19, blockedIssueNumber: 20 }],
    });
    expect(result.action).toBe('apply');
    expect(edgeStrings(result.edgeAdditions)).toEqual(['18->19']);
    expect(result.affectedIssues).toEqual([18, 19, 20]);
  });

  test('refuses a chain with more than one root', () => {
    const target = linearTarget({
      members: [
        { issueNumber: 19, role: 'node' },
        { issueNumber: 20, role: 'node' },
        { issueNumber: 21, role: 'head' },
      ],
      edges: [
        { blockerIssueNumber: 19, blockedIssueNumber: 21 },
        { blockerIssueNumber: 20, blockedIssueNumber: 21 },
      ],
    });
    const result = extendPlan('prepend', [18], { target });
    expect(result.action).toBe('refuse');
    expect(result.message).toContain('2 roots');
    expect(result.remediation).toContain('#893');
  });

  test('refuses a chain that branches below its single root', () => {
    // One root (#20), so there IS somewhere to attach — but the chain forks
    // below it, and prepending would make #19 an ancestor of every arm at once.
    const result = extendPlan('prepend', [19], { target: branchedTarget() });
    expect(result.action).toBe('refuse');
    expect(result.kind).toBe('structural');
    expect(result.message).toContain('is not a straight line');
    expect(result.remediation).toContain('#893');
  });

  test('is refused by a frozen prefix it would rewrite', () => {
    const target = linearTarget();
    const result = extendPlan('prepend', [19], { target, frozenSnapshots: [freeze(target, 20)] });
    expect(result.action).toBe('refuse');
    expect(result.kind).toBe('frozen_prefix');
    expect(result.violations.length).toBeGreaterThan(0);
  });

  test('skipFrozenPrefixes hands the check to the caller', () => {
    const target = linearTarget();
    const result = extendPlan('prepend', [19], {
      target,
      frozenSnapshots: [freeze(target, 20)],
      skipFrozenPrefixes: true,
    });
    expect(result.action).toBe('apply');
  });
});

describe('verifyLinearChainReadBack', () => {
  const edges = [
    { blockerIssueNumber: 10, blockedIssueNumber: 11 },
    { blockerIssueNumber: 11, blockedIssueNumber: 12 },
  ];

  test('passes when GitHub holds exactly the planned graph', () => {
    const verdict = verifyLinearChainReadBack({
      operation: 'new',
      edges,
      observedEdges: edges,
      observedIssues: [10, 11, 12],
      providerErrors: [],
    });
    expect(verdict).toEqual({ ok: true });
  });

  test('reports a relationship that never took effect', () => {
    const verdict = verifyLinearChainReadBack({
      operation: 'new',
      edges,
      observedEdges: [edges[0]],
      observedIssues: [10, 11, 12],
      providerErrors: [],
    });
    expect(verdict.action).toBe('refuse');
    expect(verdict.message).toContain('11->12');
    expect(verdict.remediation).toContain('NOT updated');
  });

  test('detects a concurrent edit that added a relationship', () => {
    const verdict = verifyLinearChainReadBack({
      operation: 'new',
      edges,
      observedEdges: [...edges, { blockerIssueNumber: 77, blockedIssueNumber: 12 }],
      observedIssues: [10, 11, 12],
      providerErrors: [],
    });
    expect(verdict.action).toBe('refuse');
    expect(verdict.message).toContain('while `chain new` was being applied');
    expect(verdict.message).toContain('77->12');
  });

  test('an unreadable Issue is transient and blocks the registry update', () => {
    const verdict = verifyLinearChainReadBack({
      operation: 'append',
      edges,
      observedEdges: edges,
      observedIssues: [10, 11, 12],
      providerErrors: [{ issueNumber: 12, error: 'boom' }],
    });
    expect(verdict.action).toBe('refuse');
    expect(verdict.kind).toBe('provider_error');
    expect(verdict.transient).toBe(true);
  });
});
