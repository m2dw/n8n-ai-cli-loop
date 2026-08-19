/**
 * `core/chain-advanced.ts` (issue #893): the pure decision half of
 * `admin chain fork|merge`.
 *
 * What is pinned here is the DOMAIN CONTRACT: a fork extracts only a
 * contiguous unfrozen segment and bridges the gap it leaves; a merge preserves
 * the target's identity and draws exactly one boundary relationship; frozen
 * prefixes can be neither split, reordered, prepended to, nor merged into; a
 * re-run of an interrupted operation converges instead of double-writing; and
 * the read-back refuses a state GitHub was never observed to hold — including
 * a removal that did not take effect, which the linear commands never had to
 * ask about.
 */
import {
  planChainFork,
  planChainMerge,
  verifyAdvancedChainReadBack,
  buildFrozenPrefix,
  chainGraphFingerprint,
} from '../dist/index.js';

const NOW = '2026-08-09T10:00:00.000Z';
const SESSION = 'addon-dev';

/** A linear chain `issues[0] -> ... -> issues[n]` with the last as head. */
function line(chainId, issues, overrides = {}) {
  const head = issues[issues.length - 1];
  return {
    chainId,
    headIssueNumber: head,
    members: issues.map((n) => ({ issueNumber: n, role: n === head ? 'head' : 'node' })),
    edges: issues.slice(1).map((n, i) => ({ blockerIssueNumber: issues[i], blockedIssueNumber: n })),
    graphRevision: 1,
    acceptedRevision: 1,
    ...overrides,
  };
}

function keys(edges) {
  return edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).sort();
}

function edge(blocker, blocked) {
  return { blockerIssueNumber: blocker, blockedIssueNumber: blocked };
}

/** GitHub agreeing with the chain(s), give or take explicit adjustments. */
function observation(chains, { add = [], drop = [] } = {}) {
  const dropKeys = new Set(keys(drop));
  const seen = new Set();
  const observedEdges = [];
  for (const chain of chains) {
    for (const e of chain.edges) {
      const key = `${e.blockerIssueNumber}->${e.blockedIssueNumber}`;
      if (seen.has(key) || dropKeys.has(key)) continue;
      seen.add(key);
      observedEdges.push({ ...e });
    }
  }
  observedEdges.push(...add);
  const observedIssues = [
    ...new Set(chains.flatMap((c) => c.members.map((m) => m.issueNumber))),
  ].sort((a, b) => a - b);
  return { observedEdges, observedIssues };
}

function freeze(chain, issueNumber) {
  const graph = { members: chain.members, edges: chain.edges };
  return buildFrozenPrefix({
    sessionId: SESSION,
    issueNumber,
    chainId: chain.chainId,
    graph,
    graphRevision: chain.graphRevision,
    graphFingerprint: chainGraphFingerprint(graph),
    base: { kind: 'default', baseRef: 'main' },
    frozenAt: NOW,
  });
}

function forkPlan(target, startIssueNumber, overrides = {}) {
  const obs = observation([target]);
  return planChainFork({
    target,
    startIssueNumber,
    observedEdges: obs.observedEdges,
    observedIssues: obs.observedIssues,
    frozenSnapshots: [],
    ownership: [],
    providerErrors: [],
    ...overrides,
  });
}

function mergePlan(target, source, position, overrides = {}) {
  const obs = observation([target, source]);
  return planChainMerge({
    target,
    source,
    position,
    observedEdges: obs.observedEdges,
    observedIssues: obs.observedIssues,
    frozenSnapshots: [],
    ownership: [],
    providerErrors: [],
    ...overrides,
  });
}

describe('planChainFork', () => {
  test('extracts a mid-chain segment, severing the boundary and bridging the gap', () => {
    const target = line('chain_5', [1, 2, 3, 4, 5]);
    const plan = forkPlan(target, 3, { length: 2 });
    expect(plan.action).toBe('apply');
    expect(plan.segmentIssues).toEqual([3, 4]);
    expect(plan.detach).toBe(false);
    expect(keys(plan.boundaryEdges)).toEqual(['2->3', '4->5']);
    expect(keys(plan.bridgeEdges)).toEqual(['2->5']);
    expect(keys(plan.edgeAdditions)).toEqual(['2->5']);
    expect(keys(plan.edgeRemovals)).toEqual(['2->3', '4->5']);
    // The remaining chain keeps its head and its order; the segment becomes a
    // line of its own with the downstream end as head.
    expect(plan.remaining.headIssueNumber).toBe(5);
    expect(keys(plan.remaining.edges)).toEqual(['1->2', '2->5']);
    expect(plan.segment.headIssueNumber).toBe(4);
    expect(keys(plan.segment.edges)).toEqual(['3->4']);
    expect(plan.affectedIssues).toEqual([2, 3, 4, 5]);
  });

  test('an omitted length forks through the downstream end and hands the head off', () => {
    const target = line('chain_5', [1, 2, 3, 4, 5]);
    const plan = forkPlan(target, 4);
    expect(plan.action).toBe('apply');
    expect(plan.segmentIssues).toEqual([4, 5]);
    // The head left with the segment, so the remaining chain's head falls to
    // the segment's single predecessor.
    expect(plan.remaining.headIssueNumber).toBe(3);
    expect(keys(plan.boundaryEdges)).toEqual(['3->4']);
    expect(plan.bridgeEdges).toEqual([]);
    expect(keys(plan.remaining.edges)).toEqual(['1->2', '2->3']);
    const headRoles = plan.remaining.members.filter((m) => m.role === 'head');
    expect(headRoles.map((m) => m.issueNumber)).toEqual([3]);
  });

  test('a root segment needs no bridge', () => {
    const target = line('chain_5', [1, 2, 3, 4, 5]);
    const plan = forkPlan(target, 1, { length: 2 });
    expect(plan.action).toBe('apply');
    expect(keys(plan.boundaryEdges)).toEqual(['2->3']);
    expect(plan.bridgeEdges).toEqual([]);
    expect(plan.remaining.headIssueNumber).toBe(5);
    expect(keys(plan.remaining.edges)).toEqual(['3->4', '4->5']);
  });

  test('length 1 without a name detaches the Issue with no new chain identity', () => {
    const target = line('chain_5', [1, 2, 3, 4, 5]);
    const detached = forkPlan(target, 3, { length: 1 });
    expect(detached.action).toBe('apply');
    expect(detached.detach).toBe(true);
    expect(keys(detached.bridgeEdges)).toEqual(['2->4']);

    // A name is the explicit request for an identity, even for one Issue.
    const named = forkPlan(target, 3, { length: 1, newChainName: 'solo' });
    expect(named.action).toBe('apply');
    expect(named.detach).toBe(false);
  });

  test('fan-in and fan-out at the segment boundary survive as bridges', () => {
    // 1 and 2 both block 3; 4 blocks 5 and 6. Extracting [3,4] must keep every
    // ordering constraint: each predecessor bridged to each successor.
    const target = {
      chainId: 'chain_6',
      headIssueNumber: 6,
      members: [1, 2, 3, 4, 5, 6].map((n) => ({ issueNumber: n, role: n === 6 ? 'head' : 'node' })),
      edges: [edge(1, 3), edge(2, 3), edge(3, 4), edge(4, 5), edge(4, 6)],
      graphRevision: 1,
      acceptedRevision: 1,
    };
    const plan = forkPlan(target, 3, { length: 2 });
    expect(plan.action).toBe('apply');
    expect(keys(plan.boundaryEdges)).toEqual(['1->3', '2->3', '4->5', '4->6']);
    expect(keys(plan.bridgeEdges)).toEqual(['1->5', '1->6', '2->5', '2->6']);
    expect(keys(plan.remaining.edges)).toEqual(['1->5', '1->6', '2->5', '2->6']);
    expect(plan.affectedIssues).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('a fork point strictly inside the segment is refused by name', () => {
    const target = {
      chainId: 'chain_4',
      headIssueNumber: 4,
      members: [1, 2, 3, 4].map((n) => ({ issueNumber: n, role: n === 4 ? 'head' : 'node' })),
      edges: [edge(1, 2), edge(2, 3), edge(2, 4)],
      graphRevision: 1,
      acceptedRevision: 1,
    };
    const plan = forkPlan(target, 1, { length: 3 });
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('structural');
    expect(plan.message).toContain('cannot continue past #2');
  });

  test('a merge point strictly inside the segment is refused by name', () => {
    const target = {
      chainId: 'chain_4',
      headIssueNumber: 4,
      members: [1, 2, 3, 4].map((n) => ({ issueNumber: n, role: n === 4 ? 'head' : 'node' })),
      edges: [edge(1, 3), edge(2, 3), edge(3, 4)],
      graphRevision: 1,
      acceptedRevision: 1,
    };
    const plan = forkPlan(target, 1, { length: 2 });
    expect(plan.action).toBe('refuse');
    expect(plan.message).toContain('cannot continue into #3');
  });

  test('a length running past the chain end, the whole chain, and a non-member all refuse', () => {
    const target = line('chain_3', [1, 2, 3]);
    const past = forkPlan(target, 2, { length: 5 });
    expect(past.action).toBe('refuse');
    expect(past.message).toContain('past the chain');

    const whole = forkPlan(target, 1);
    expect(whole.action).toBe('refuse');
    expect(whole.message).toContain('whole of chain chain_3');

    const missing = forkPlan(target, 9);
    expect(missing.action).toBe('refuse');
    expect(missing.message).toContain('#9 is not a member');
    // The interrupted-fork recovery is named where an operator will hit it.
    expect(missing.remediation).toContain('admin chain new');
  });

  test('an unaccepted candidate graph is never forked', () => {
    const target = line('chain_3', [1, 2, 3], { graphRevision: 2, acceptedRevision: 1 });
    const plan = forkPlan(target, 2, { length: 1 });
    expect(plan.action).toBe('refuse');
    expect(plan.message).toContain('accepted');
  });

  test('an Issue a third chain owns refuses with duplicate ownership', () => {
    const target = line('chain_3', [1, 2, 3]);
    const plan = forkPlan(target, 2, {
      length: 1,
      ownership: [{ issueNumber: 2, chainId: 'chain_77' }],
    });
    expect(plan.action).toBe('refuse');
    expect(plan.diagnostics.map((d) => d.code)).toContain('duplicate_ownership');
  });

  test('an observed relationship the plan does not account for refuses', () => {
    const target = line('chain_3', [1, 2, 3]);
    const obs = observation([target], { add: [edge(9, 2)] });
    const plan = forkPlan(target, 2, { length: 1, ...obs });
    expect(plan.action).toBe('refuse');
    expect(plan.message).toContain('9->2');
  });

  test('a recorded relationship GitHub does not hold refuses instead of being re-created', () => {
    const target = line('chain_3', [1, 2, 3]);
    const obs = observation([target], { drop: [edge(1, 2)] });
    const plan = forkPlan(target, 3, { length: 1, ...obs });
    expect(plan.action).toBe('refuse');
    expect(plan.message).toContain('GitHub does not hold');
    expect(plan.message).toContain('1->2');
  });

  test('a frozen Issue inside the segment refuses: the segment must be unfrozen', () => {
    const target = line('chain_5', [1, 2, 3, 4, 5]);
    const plan = forkPlan(target, 3, { length: 2, frozenSnapshots: [freeze(target, 3)] });
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('frozen_prefix');
    expect(plan.message).toContain('#3');
  });

  test("extracting a started Issue's ancestor refuses as the ancestry rewrite it is", () => {
    const target = line('chain_5', [1, 2, 3, 4, 5]);
    // #5 has started: its ancestry {1,2,3,4} is pinned, and the segment [3,4]
    // sits inside it.
    const plan = forkPlan(target, 3, { length: 2, frozenSnapshots: [freeze(target, 5)] });
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('frozen_prefix');
    expect(plan.violations.map((v) => v.code)).toContain('ancestor_removed');
  });

  test('a frozen Issue wholly upstream of the segment does not block the fork', () => {
    const target = line('chain_5', [1, 2, 3, 4, 5]);
    const plan = forkPlan(target, 4, { frozenSnapshots: [freeze(target, 1)] });
    expect(plan.action).toBe('apply');
  });

  test('a retry against an already-forked GitHub state converges with nothing left to write', () => {
    const target = line('chain_5', [1, 2, 3, 4, 5]);
    // The interrupted run already removed both boundary edges and wrote the
    // bridge; the registry still holds the pre-fork graph.
    const obs = observation([target], {
      drop: [edge(2, 3), edge(4, 5)],
      add: [edge(2, 5)],
    });
    const plan = forkPlan(target, 3, { length: 2, ...obs });
    expect(plan.action).toBe('apply');
    expect(plan.edgeAdditions).toEqual([]);
    expect(plan.edgeRemovals).toEqual([]);
    // The suspension scope must not shrink with the work left: the retry still
    // owns the Issues the interrupted run suspended.
    expect(plan.affectedIssues).toEqual([2, 3, 4, 5]);
  });

  test('a provider read failure refuses as transient', () => {
    const target = line('chain_3', [1, 2, 3]);
    const plan = forkPlan(target, 2, {
      length: 1,
      providerErrors: [{ issueNumber: 2, error: 'boom' }],
    });
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('provider_error');
    expect(plan.transient).toBe(true);
  });
});

describe('planChainMerge', () => {
  test('append draws head->root, moves the head, and keeps the target chain ID', () => {
    const target = line('chain_2', [1, 2]);
    const source = line('chain_12', [11, 12]);
    const plan = mergePlan(target, source, 'append');
    expect(plan.action).toBe('apply');
    expect(plan.chainId).toBe('chain_2');
    expect(plan.sourceChainId).toBe('chain_12');
    expect(plan.boundaryEdge).toEqual(edge(2, 11));
    expect(plan.merged.headIssueNumber).toBe(12);
    expect(keys(plan.merged.edges)).toEqual(['1->2', '11->12', '2->11']);
    expect(keys(plan.edgeAdditions)).toEqual(['2->11']);
    // Every source member changes chains; the target contributes only the
    // boundary end.
    expect(plan.affectedIssues).toEqual([2, 11, 12]);
    expect(plan.resumeRetirement).toBe(false);
    const heads = plan.merged.members.filter((m) => m.role === 'head');
    expect(heads.map((m) => m.issueNumber)).toEqual([12]);
  });

  test('prepend draws source-head->target-root and leaves the head in place', () => {
    const target = line('chain_2', [1, 2]);
    const source = line('chain_12', [11, 12]);
    const plan = mergePlan(target, source, 'prepend');
    expect(plan.action).toBe('apply');
    expect(plan.boundaryEdge).toEqual(edge(12, 1));
    expect(plan.merged.headIssueNumber).toBe(2);
    expect(keys(plan.edgeAdditions)).toEqual(['12->1']);
    expect(plan.affectedIssues).toEqual([1, 11, 12]);
  });

  test('a frozen source refuses append (its members would gain ancestors) but survives prepend', () => {
    const target = line('chain_2', [1, 2]);
    const source = line('chain_12', [11, 12]);
    const frozen = [freeze(source, 12)];
    const refused = mergePlan(target, source, 'append', { frozenSnapshots: frozen });
    expect(refused.action).toBe('refuse');
    expect(refused.kind).toBe('frozen_prefix');
    expect(refused.violations.map((v) => v.code)).toContain('ancestor_added');

    const allowed = mergePlan(target, source, 'prepend', { frozenSnapshots: frozen });
    expect(allowed.action).toBe('apply');
  });

  test('a frozen target refuses prepend: nothing may be prepended above a pinned ancestry', () => {
    const target = line('chain_2', [1, 2]);
    const source = line('chain_12', [11, 12]);
    const plan = mergePlan(target, source, 'prepend', { frozenSnapshots: [freeze(target, 2)] });
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('frozen_prefix');
  });

  test('append needs a single source root and a target head that is a genuine downstream end', () => {
    const target = line('chain_2', [1, 2]);
    const twoRoots = {
      chainId: 'chain_12',
      headIssueNumber: 12,
      members: [
        { issueNumber: 11, role: 'node' },
        { issueNumber: 12, role: 'head' },
      ],
      edges: [],
      graphRevision: 1,
      acceptedRevision: 1,
    };
    const rootless = mergePlan(target, twoRoots, 'append');
    expect(rootless.action).toBe('refuse');
    expect(rootless.message).toContain('2 roots');

    // The head already blocks an Issue no chain has registered — visible only
    // through the observation, and disqualifying all the same.
    const source = line('chain_12', [11, 12]);
    const obs = observation([target, source], { add: [edge(2, 99)] });
    const midGraph = mergePlan(target, source, 'append', obs);
    expect(midGraph.action).toBe('refuse');
    expect(midGraph.message).toContain('not the chain\'s downstream end');
  });

  test('prepend needs a single target root', () => {
    const twoRoots = {
      chainId: 'chain_2',
      headIssueNumber: 2,
      members: [
        { issueNumber: 1, role: 'node' },
        { issueNumber: 2, role: 'head' },
      ],
      edges: [],
      graphRevision: 1,
      acceptedRevision: 1,
    };
    const source = line('chain_12', [11, 12]);
    const plan = mergePlan(twoRoots, source, 'prepend');
    expect(plan.action).toBe('refuse');
    expect(plan.message).toContain('2 roots');
  });

  test('a partial member overlap and a self-merge both refuse', () => {
    const target = line('chain_3', [1, 2, 3]);
    const overlapping = line('chain_12', [3, 12]);
    const overlap = mergePlan(target, overlapping, 'append');
    expect(overlap.action).toBe('refuse');
    expect(overlap.message).toContain('belong to both chains');

    const self = mergePlan(target, target, 'append');
    expect(self.action).toBe('refuse');
    expect(self.message).toContain('itself');
  });

  test('unaccepted operands refuse in either role', () => {
    const accepted = line('chain_2', [1, 2]);
    const candidate = line('chain_12', [11, 12], { graphRevision: 3, acceptedRevision: 2 });
    expect(mergePlan(candidate, accepted, 'append').action).toBe('refuse');
    expect(mergePlan(accepted, candidate, 'append').action).toBe('refuse');
  });

  test('an interrupted merge resumes with only the retirement left', () => {
    // The target already accepted the combined graph; the source still records
    // its members. Nothing is left to plan against GitHub.
    const target = {
      chainId: 'chain_2',
      headIssueNumber: 12,
      members: [1, 2, 11, 12].map((n) => ({ issueNumber: n, role: n === 12 ? 'head' : 'node' })),
      edges: [edge(1, 2), edge(2, 11), edge(11, 12)],
      graphRevision: 2,
      acceptedRevision: 2,
    };
    const source = line('chain_12', [11, 12]);
    const obs = observation([target]);
    const plan = planChainMerge({
      target,
      source,
      position: 'append',
      observedEdges: obs.observedEdges,
      observedIssues: obs.observedIssues,
      frozenSnapshots: [],
      ownership: [],
      providerErrors: [],
    });
    expect(plan.action).toBe('apply');
    expect(plan.resumeRetirement).toBe(true);
    expect(plan.edgeAdditions).toEqual([]);
    expect(plan.boundaryEdge).toBeUndefined();
    expect(plan.affectedIssues).toEqual([11, 12]);
  });

  test('a third chain owning a member refuses; the operands owning their own members does not', () => {
    const target = line('chain_2', [1, 2]);
    const source = line('chain_12', [11, 12]);
    const plan = mergePlan(target, source, 'append', {
      ownership: [{ issueNumber: 11, chainId: 'chain_77' }],
    });
    expect(plan.action).toBe('refuse');
    expect(plan.diagnostics.map((d) => d.code)).toContain('duplicate_ownership');
  });
});

describe('verifyAdvancedChainReadBack', () => {
  const post = [edge(1, 2), edge(2, 5)];
  const removed = [edge(2, 3), edge(4, 5)];
  const scope = [1, 2, 3, 4, 5];

  test('accepts exactly the planned post-state', () => {
    const verdict = verifyAdvancedChainReadBack({
      operation: 'fork',
      postEdges: post,
      removedEdges: removed,
      observedEdges: post,
      observedIssues: scope,
      providerErrors: [],
    });
    expect(verdict.ok).toBe(true);
  });

  test('a missing addition refuses', () => {
    const verdict = verifyAdvancedChainReadBack({
      operation: 'fork',
      postEdges: post,
      removedEdges: removed,
      observedEdges: [edge(1, 2)],
      observedIssues: scope,
      providerErrors: [],
    });
    expect(verdict.action).toBe('refuse');
    expect(verdict.message).toContain('2->5');
  });

  test('a removal still present refuses as the failed write it is', () => {
    const verdict = verifyAdvancedChainReadBack({
      operation: 'fork',
      postEdges: post,
      removedEdges: removed,
      observedEdges: [...post, edge(2, 3)],
      observedIssues: scope,
      providerErrors: [],
    });
    expect(verdict.action).toBe('refuse');
    expect(verdict.message).toContain('still held');
    expect(verdict.message).toContain('2->3');
  });

  test('a relationship gained mid-operation refuses as a concurrent edit', () => {
    const verdict = verifyAdvancedChainReadBack({
      operation: 'merge',
      postEdges: post,
      removedEdges: [],
      observedEdges: [...post, edge(9, 2)],
      observedIssues: scope,
      providerErrors: [],
    });
    expect(verdict.action).toBe('refuse');
    expect(verdict.message).toContain('gained');
    expect(verdict.message).toContain('9->2');
  });

  test('an unreadable read-back refuses as transient', () => {
    const verdict = verifyAdvancedChainReadBack({
      operation: 'merge',
      postEdges: post,
      removedEdges: [],
      observedEdges: [],
      observedIssues: scope,
      providerErrors: [{ issueNumber: 2, error: 'boom' }],
    });
    expect(verdict.action).toBe('refuse');
    expect(verdict.kind).toBe('provider_error');
    expect(verdict.transient).toBe(true);
  });
});
