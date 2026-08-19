/**
 * GitHub-to-registry synchronization rules (issue #892): the pure decision
 * `admin chain sync` makes before it writes anything — may the observed graph
 * become the chain's accepted graph, and if not, which side has to move?
 */
import { planChainSync, buildFrozenPrefix, CHAIN_SYNC_REFUSAL_KINDS, isChainSyncRefusalKind } from '../dist/index.js';

const NOW = '2026-08-08T10:00:00.000Z';
const CHAIN_ID = 'chain_777';

function observation(overrides = {}) {
  const members = overrides.members ?? [
    { issueNumber: 777, role: 'head' },
    { issueNumber: 778, role: 'node' },
  ];
  return {
    chainId: CHAIN_ID,
    headIssueNumber: 777,
    registry: { members, edges: overrides.registryEdges ?? [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }] },
    observed: { members, edges: overrides.observedEdges ?? [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }] },
    providerErrors: overrides.providerErrors ?? [],
    frozenSnapshots: overrides.frozenSnapshots ?? [],
    ownership: overrides.ownership ?? [],
  };
}

describe('planChainSync', () => {
  test('imports a graph that matches the registry, reporting no drift', () => {
    const plan = planChainSync(observation());
    expect(plan.action).toBe('import');
    expect(plan.drift.equivalent).toBe(true);
    expect(plan.drift.diagnostics).toEqual([]);
    expect(plan.canonical.fingerprint).toEqual(plan.drift.observedFingerprint);
  });

  test('imports a graph GitHub has moved on, reporting the drift it carries', () => {
    const plan = planChainSync(observation({ registryEdges: [] }));
    expect(plan.action).toBe('import');
    expect(plan.drift.equivalent).toBe(false);
    const edgeMismatch = plan.drift.diagnostics.find((d) => d.code === 'edge_mismatch');
    expect(edgeMismatch).toBeDefined();
    expect(edgeMismatch.observedEdges).toEqual([{ blockerIssueNumber: 778, blockedIssueNumber: 777 }]);
    expect(edgeMismatch.expectedEdges).toEqual([]);
  });

  test('a member that could not be read refuses the import as transient, judging nothing else', () => {
    // The observed graph would look perfectly valid — it is simply missing
    // every edge into #778, which is exactly why it must not be imported.
    const plan = planChainSync(
      observation({
        observedEdges: [],
        providerErrors: [{ issueNumber: 778, error: 'HTTP 403: Resource not accessible' }],
      }),
    );
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('provider_error');
    expect(plan.transient).toBe(true);
    expect(plan.providerErrors).toEqual([{ issueNumber: 778, error: 'HTTP 403: Resource not accessible' }]);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.violations).toEqual([]);
    expect(plan.message).toContain('#778');
    expect(plan.remediation).toContain('Nothing in the registry was changed');
  });

  test('a cycle observed on GitHub is a structural refusal naming the edges to remove', () => {
    const plan = planChainSync(
      observation({
        observedEdges: [
          { blockerIssueNumber: 778, blockedIssueNumber: 777 },
          { blockerIssueNumber: 777, blockedIssueNumber: 778 },
        ],
      }),
    );
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('structural');
    expect(plan.transient).toBe(false);
    const cycle = plan.diagnostics.find((d) => d.code === 'cycle');
    expect(cycle).toBeDefined();
    expect(cycle.observedEdges.length).toBeGreaterThan(0);
    expect(plan.remediation).toContain('break the cycle');
    expect(plan.remediation).toContain('Direction: GitHub -> registry');
  });

  test('a blocker GitHub names that the chain never declared is a structural refusal', () => {
    const plan = planChainSync(
      observation({
        members: [{ issueNumber: 777, role: 'head' }],
        registryEdges: [],
        observedEdges: [{ blockerIssueNumber: 999, blockedIssueNumber: 777 }],
      }),
    );
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('structural');
    const missing = plan.diagnostics.find((d) => d.code === 'missing_member');
    expect(missing.issues).toContain(999);
    expect(plan.remediation).toContain('register it as a member');
  });

  test('an identity that cannot be resolved is a structural refusal', () => {
    const plan = planChainSync(
      observation({
        members: [
          { issueNumber: 777, role: 'head' },
          { issueNumber: 778, role: 'head' },
        ],
      }),
    );
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('structural');
    const ambiguous = plan.diagnostics.find((d) => d.code === 'ambiguous_identity');
    expect(ambiguous.issues).toEqual([777, 778]);
    expect(plan.remediation).toContain('one identity');
  });

  test('a member another chain already owns is a structural refusal naming that chain', () => {
    const plan = planChainSync(observation({ ownership: [{ issueNumber: 778, chainId: 'chain_500' }] }));
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('structural');
    const duplicate = plan.diagnostics.find((d) => d.code === 'duplicate_ownership');
    expect(duplicate).toBeDefined();
    expect(duplicate.chains).toContain('chain_500');
    expect(plan.remediation).toContain('already belong to another chain');
  });

  test('a graph contradicting a frozen prefix is refused with the pinned edges', () => {
    const members = [
      { issueNumber: 777, role: 'head' },
      { issueNumber: 778, role: 'node' },
    ];
    const frozen = buildFrozenPrefix({
      sessionId: 'addon-dev',
      issueNumber: 777,
      chainId: CHAIN_ID,
      graph: { members, edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }] },
      graphRevision: 1,
      graphFingerprint: 'sha256:whatever',
      base: { kind: 'default', baseRef: 'main' },
      frozenAt: NOW,
    });
    // GitHub has dropped the frozen ancestor edge.
    const plan = planChainSync(observation({ observedEdges: [], frozenSnapshots: [frozen] }));
    expect(plan.action).toBe('refuse');
    expect(plan.kind).toBe('frozen_prefix');
    expect(plan.transient).toBe(false);
    expect(plan.violations.some((v) => v.code === 'ancestor_removed')).toBe(true);
    // The pinned edge the candidate dropped is named as expected-but-absent,
    // which is the "expected vs observed edges" an operator repairs from.
    const removed = plan.violations.find((v) => v.code === 'incoming_edge_removed');
    expect(removed.expectedEdges).toContainEqual({ blockerIssueNumber: 778, blockedIssueNumber: 777 });
    expect(removed.observedEdges).toEqual([]);
    expect(plan.remediation).toContain('Direction: GitHub -> registry');
  });

  test('a frozen snapshot belonging to another chain is not evaluated against this one', () => {
    const members = [
      { issueNumber: 777, role: 'head' },
      { issueNumber: 778, role: 'node' },
    ];
    const frozen = buildFrozenPrefix({
      sessionId: 'addon-dev',
      issueNumber: 777,
      chainId: 'chain_other',
      graph: { members, edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }] },
      graphRevision: 1,
      graphFingerprint: 'sha256:whatever',
      base: { kind: 'default', baseRef: 'main' },
      frozenAt: NOW,
    });
    const plan = planChainSync(observation({ observedEdges: [], frozenSnapshots: [frozen] }));
    expect(plan.action).toBe('import');
  });

  test('structural findings outrank frozen-prefix findings: a cyclic graph has no prefix to judge', () => {
    const members = [
      { issueNumber: 777, role: 'head' },
      { issueNumber: 778, role: 'node' },
    ];
    const frozen = buildFrozenPrefix({
      sessionId: 'addon-dev',
      issueNumber: 777,
      chainId: CHAIN_ID,
      graph: { members, edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }] },
      graphRevision: 1,
      graphFingerprint: 'sha256:whatever',
      base: { kind: 'default', baseRef: 'main' },
      frozenAt: NOW,
    });
    const plan = planChainSync(
      observation({
        observedEdges: [
          { blockerIssueNumber: 778, blockedIssueNumber: 777 },
          { blockerIssueNumber: 777, blockedIssueNumber: 778 },
        ],
        frozenSnapshots: [frozen],
      }),
    );
    expect(plan.kind).toBe('structural');
  });

  test('a provider failure outranks a structural one: an incomplete graph is not judged as a graph', () => {
    const plan = planChainSync(
      observation({
        observedEdges: [{ blockerIssueNumber: 999, blockedIssueNumber: 777 }],
        providerErrors: [{ issueNumber: 778, error: 'boom' }],
      }),
    );
    expect(plan.kind).toBe('provider_error');
    expect(plan.diagnostics).toEqual([]);
  });

  test('every refusal carries a non-empty remediation direction', () => {
    const plans = [
      planChainSync(observation({ providerErrors: [{ issueNumber: 778, error: 'boom' }] })),
      planChainSync(
        observation({
          observedEdges: [
            { blockerIssueNumber: 778, blockedIssueNumber: 777 },
            { blockerIssueNumber: 777, blockedIssueNumber: 778 },
          ],
        }),
      ),
    ];
    for (const plan of plans) {
      expect(plan.action).toBe('refuse');
      expect(typeof plan.remediation).toBe('string');
      expect(plan.remediation.length).toBeGreaterThan(0);
      expect(isChainSyncRefusalKind(plan.kind)).toBe(true);
    }
    expect(CHAIN_SYNC_REFUSAL_KINDS).toEqual(['provider_error', 'structural', 'frozen_prefix']);
  });
});
