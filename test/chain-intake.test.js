/**
 * Candidate-scoped chain-intake decisions (issue #790) — the pure layer.
 *
 * No database, no provider: one observation in, one verdict out, mirroring
 * chain-sync.test.js. The end-to-end path through `runIntake` (stores, outbox
 * effects, atomic freeze) is covered by github-intake-chain.test.js.
 */
import {
  buildFrozenPrefix,
  chainIntakeRefusalFingerprint,
  formatChainIntakeErrorComment,
  frozenPrefixChainIntakeRefusal,
  planChainIntake,
  resolveChainIntakeTarget,
  structuralChainIntakeRefusal,
} from '../dist/index.js';

function planInput(overrides = {}) {
  return {
    issueNumber: 9,
    observedBlockers: [],
    target: { kind: 'create' },
    frozenSnapshots: [],
    ownership: [],
    providerErrors: [],
    ...overrides,
  };
}

/** A registered chain: 1 (head) -> 2 -> 3. */
function linearTarget(overrides = {}) {
  return {
    kind: 'extend',
    chainId: 'chain_1',
    headIssueNumber: 1,
    members: [
      { issueNumber: 1, role: 'head' },
      { issueNumber: 2, role: 'node' },
      { issueNumber: 3, role: 'node' },
    ],
    edges: [
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      { blockerIssueNumber: 2, blockedIssueNumber: 3 },
    ],
    ...overrides,
  };
}

describe('resolveChainIntakeTarget', () => {
  test('no involved chain resolves to create', () => {
    expect(
      resolveChainIntakeTarget({
        issueNumber: 9,
        candidateChainIds: [],
        blockerChainIds: [{ issueNumber: 7, chainIds: [] }],
      }),
    ).toEqual({ kind: 'create' });
  });

  test('one chain — via the candidate or any blocker — resolves to extend', () => {
    expect(
      resolveChainIntakeTarget({
        issueNumber: 9,
        candidateChainIds: [],
        blockerChainIds: [
          { issueNumber: 7, chainIds: ['chain_1'] },
          { issueNumber: 8, chainIds: ['chain_1'] },
        ],
      }),
    ).toEqual({ kind: 'extend', chainId: 'chain_1' });
    expect(
      resolveChainIntakeTarget({
        issueNumber: 9,
        candidateChainIds: ['chain_1'],
        blockerChainIds: [],
      }),
    ).toEqual({ kind: 'extend', chainId: 'chain_1' });
  });

  test('two involved chains resolve to multi_chain with an ascending id list', () => {
    expect(
      resolveChainIntakeTarget({
        issueNumber: 9,
        candidateChainIds: ['chain_2'],
        blockerChainIds: [{ issueNumber: 7, chainIds: ['chain_1'] }],
      }),
    ).toEqual({ kind: 'multi_chain', chainIds: ['chain_1', 'chain_2'] });
  });
});

describe('planChainIntake — registrations', () => {
  test('a standalone candidate creates a one-member chain headed by itself', () => {
    const plan = planChainIntake(planInput());
    expect(plan).toMatchObject({
      action: 'register',
      mode: 'create',
      headIssueNumber: 9,
      members: [{ issueNumber: 9, role: 'head' }],
      edges: [],
    });
    expect(plan.canonical.fingerprint).toMatch(/^sha256:/);
  });

  test('a create with observed blockers registers them as members with incoming edges', () => {
    const plan = planChainIntake(planInput({ observedBlockers: [8, 7, 8] }));
    expect(plan.action).toBe('register');
    expect(plan.members.map((m) => m.issueNumber).sort((a, b) => a - b)).toEqual([7, 8, 9]);
    expect(plan.edges).toEqual([
      { blockerIssueNumber: 7, blockedIssueNumber: 9 },
      { blockerIssueNumber: 8, blockedIssueNumber: 9 },
    ]);
  });

  test('an extend carries the target graph forward and adds only the candidate and its edges', () => {
    const plan = planChainIntake(
      planInput({ issueNumber: 4, observedBlockers: [3], target: linearTarget() }),
    );
    expect(plan).toMatchObject({ action: 'register', mode: 'extend', chainId: 'chain_1', headIssueNumber: 1 });
    expect(plan.members.map((m) => m.issueNumber)).toEqual([1, 2, 3, 4]);
    expect(plan.edges).toContainEqual({ blockerIssueNumber: 1, blockedIssueNumber: 2 });
    expect(plan.edges).toContainEqual({ blockerIssueNumber: 2, blockedIssueNumber: 3 });
    expect(plan.edges).toContainEqual({ blockerIssueNumber: 3, blockedIssueNumber: 4 });
  });

  test('fan-in at a new downstream issue adds every incoming edge without touching existing ones', () => {
    const plan = planChainIntake(
      planInput({ issueNumber: 4, observedBlockers: [2, 3], target: linearTarget() }),
    );
    expect(plan.action).toBe('register');
    expect(plan.edges).toEqual(
      expect.arrayContaining([
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 3 },
        { blockerIssueNumber: 2, blockedIssueNumber: 4 },
        { blockerIssueNumber: 3, blockedIssueNumber: 4 },
      ]),
    );
    expect(plan.edges).toHaveLength(4);
  });

  test('an already-registered candidate re-derives only its own incoming edges', () => {
    // Issue 3's observed blocker moved from 2 to 1: the 2->3 edge is dropped,
    // 1->3 added, everything else carried forward.
    const plan = planChainIntake(
      planInput({ issueNumber: 3, observedBlockers: [1], target: linearTarget() }),
    );
    expect(plan.action).toBe('register');
    expect(plan.edges).toEqual([
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      { blockerIssueNumber: 1, blockedIssueNumber: 3 },
    ]);
  });
});

describe('planChainIntake — refusals', () => {
  test('a provider error refuses as transient and judges nothing', () => {
    const plan = planChainIntake(
      planInput({ providerErrors: [{ issueNumber: 9, error: 'boom' }] }),
    );
    expect(plan).toMatchObject({ action: 'refuse', kind: 'provider_error', transient: true });
  });

  test('blockers spanning two chains refuse as structural (no merge)', () => {
    const plan = planChainIntake(
      planInput({ target: { kind: 'multi_chain', chainIds: ['chain_1', 'chain_2'] } }),
    );
    expect(plan).toMatchObject({ action: 'refuse', kind: 'structural', transient: false });
    expect(plan.message).toContain('chain_1, chain_2');
  });

  test('an observed relationship that closes a cycle refuses as structural with the cycle finding', () => {
    // Head 1 observed as blocked by 2 while the chain records 1 -> 2.
    const plan = planChainIntake(
      planInput({ issueNumber: 1, observedBlockers: [2], target: linearTarget() }),
    );
    expect(plan).toMatchObject({ action: 'refuse', kind: 'structural', transient: false });
    expect(plan.diagnostics.map((d) => d.code)).toContain('cycle');
  });

  test('a change under a frozen prefix refuses as frozen_prefix and reports the violations', () => {
    // Issue 3 started: its prefix (1 -> 2 -> 3) is frozen. The observed
    // relationships then move its incoming edge from 2 to 1.
    const target = linearTarget();
    const frozen = buildFrozenPrefix({
      sessionId: 's',
      issueNumber: 3,
      chainId: 'chain_1',
      graph: { members: target.members, edges: target.edges },
      graphRevision: 1,
      graphFingerprint: 'sha256:aaaa',
      base: { kind: 'default', baseRef: 'main' },
      frozenAt: '2026-08-01T00:00:00.000Z',
    });
    const plan = planChainIntake(
      planInput({
        issueNumber: 3,
        observedBlockers: [1],
        target,
        frozenSnapshots: [frozen],
      }),
    );
    expect(plan).toMatchObject({ action: 'refuse', kind: 'frozen_prefix', transient: false });
    expect(plan.violations.length).toBeGreaterThan(0);
    expect(plan.violations.map((v) => v.code)).toContain('incoming_edge_removed');
  });
});

describe('refusal fingerprint and comment', () => {
  const refusal = structuralChainIntakeRefusal(9, []);

  test('the fingerprint is deterministic and changes with the failure content', () => {
    const input = { issueNumber: 9, observedBlockers: [7, 8], refusal };
    const a = chainIntakeRefusalFingerprint(input);
    expect(a).toBe(chainIntakeRefusalFingerprint({ ...input, observedBlockers: [8, 7, 7] }));
    expect(a).toMatch(/^sha256:/);
    expect(
      chainIntakeRefusalFingerprint({ ...input, observedBlockers: [7] }),
    ).not.toBe(a);
    expect(
      chainIntakeRefusalFingerprint({
        ...input,
        refusal: frozenPrefixChainIntakeRefusal(9, { message: 'pinned' }),
      }),
    ).not.toBe(a);
  });

  test('the comment states observed and expected relationships, findings, remediation, and the fingerprint', () => {
    const fingerprint = chainIntakeRefusalFingerprint({ issueNumber: 5, observedBlockers: [3], refusal });
    const body = formatChainIntakeErrorComment({
      issueNumber: 5,
      observedBlockers: [3],
      expectedBlockers: [2],
      refusal,
      fingerprint,
    });
    expect(body).toContain('Dependency chain registration blocked');
    expect(body).toContain('Observed `blocked by` relationships: #3');
    expect(body).toContain('Expected by the accepted chain graph: #2');
    expect(body).toContain(refusal.message);
    expect(body).toContain(refusal.remediation);
    expect(body).toContain(fingerprint);
    // Deterministic: no timestamps or run identifiers may leak in.
    expect(body).toBe(
      formatChainIntakeErrorComment({
        issueNumber: 5,
        observedBlockers: [3],
        expectedBlockers: [2],
        refusal,
        fingerprint,
      }),
    );
  });
});
