/**
 * Pure dependency-chain registry helpers (issue #788): deterministic ID
 * allocation, handle validation, referential-integrity checks, and graph
 * fingerprinting. No database is involved here — these are the rules a
 * backing store applies, tested independently of how it stores anything.
 */
import {
  CHAIN_ID_PREFIX,
  MAX_CHAIN_ALIAS_LENGTH,
  allocateChainId,
  canonicalChainGraphText,
  chainGraphFingerprint,
  chainIdCandidate,
  checkChainGraphIntegrity,
  defaultChainId,
  isChainMemberRole,
  isChainRevisionState,
  isChainSyncStatus,
  isValidChainAlias,
  isValidChainId,
  isValidIssueNumber,
} from '../dist/index.js';

describe('chain id derivation', () => {
  test('the default id is the head issue number behind the chain prefix', () => {
    expect(CHAIN_ID_PREFIX).toBe('chain_');
    expect(defaultChainId(777)).toBe('chain_777');
  });

  test('collision suffixes start at _2 and follow the ordinal exactly', () => {
    expect(chainIdCandidate(777, 1)).toBe('chain_777');
    expect(chainIdCandidate(777, 2)).toBe('chain_777_2');
    expect(chainIdCandidate(777, 3)).toBe('chain_777_3');
    expect(chainIdCandidate(777, 12)).toBe('chain_777_12');
  });

  test('a non-positive or non-integer head issue number is rejected outright', () => {
    expect(() => chainIdCandidate(0, 1)).toThrow(RangeError);
    expect(() => chainIdCandidate(-3, 1)).toThrow(RangeError);
    expect(() => chainIdCandidate(7.5, 1)).toThrow(RangeError);
    expect(() => chainIdCandidate(777, 0)).toThrow(RangeError);
  });

  test('allocation returns the bare default when nothing is taken', () => {
    expect(allocateChainId(777, () => false)).toBe('chain_777');
  });

  test('allocation walks the fixed sequence and is deterministic for the same taken set', () => {
    const taken = new Set(['chain_777', 'chain_777_2', 'chain_777_3']);
    expect(allocateChainId(777, (id) => taken.has(id))).toBe('chain_777_4');
    // Same inputs, same answer — two operators resolving the same collision
    // on the same registry must land on the same handle.
    expect(allocateChainId(777, (id) => taken.has(id))).toBe('chain_777_4');
  });

  test('allocation skips a candidate an alias already claims', () => {
    // Aliases and chain ids share one namespace, so an alias occupying
    // `chain_777` must push allocation on rather than produce an ambiguous
    // handle.
    const aliases = new Set(['chain_777']);
    expect(allocateChainId(777, (id) => aliases.has(id))).toBe('chain_777_2');
  });

  test('allocation gives up rather than inventing a non-derived id', () => {
    expect(allocateChainId(777, () => true, 5)).toBeUndefined();
  });
});

describe('handle validation', () => {
  test('accepts default and suffixed chain ids', () => {
    expect(isValidChainId('chain_777')).toBe(true);
    expect(isValidChainId('chain_777_2')).toBe(true);
    expect(isValidChainId('chain_1_10')).toBe(true);
  });

  test('rejects malformed chain ids, including the never-allocated _1 suffix', () => {
    for (const bad of [
      'chain_777_1', // ordinal 1 is spelled without a suffix
      'chain_0',
      'chain_',
      'chain_07',
      'chain_777_0',
      '777',
      'chain-777',
      'CHAIN_777',
      '',
      null,
      undefined,
      777,
    ]) {
      expect(isValidChainId(bad)).toBe(false);
    }
  });

  test('accepts shell- and url-safe aliases up to the length bound', () => {
    expect(isValidChainAlias('release-train')).toBe(true);
    expect(isValidChainAlias('v2.rollout_1')).toBe(true);
    expect(isValidChainAlias('a'.repeat(MAX_CHAIN_ALIAS_LENGTH))).toBe(true);
  });

  test('rejects empty, oversized, or unsafe aliases', () => {
    for (const bad of [
      '',
      'a'.repeat(MAX_CHAIN_ALIAS_LENGTH + 1),
      '-leading-dash',
      'has space',
      'semi;colon',
      'quote"mark',
      null,
      42,
    ]) {
      expect(isValidChainAlias(bad)).toBe(false);
    }
  });

  test('issue numbers must be positive integers', () => {
    expect(isValidIssueNumber(1)).toBe(true);
    expect(isValidIssueNumber(0)).toBe(false);
    expect(isValidIssueNumber(-1)).toBe(false);
    expect(isValidIssueNumber(1.5)).toBe(false);
    expect(isValidIssueNumber('7')).toBe(false);
  });

  test('enum guards accept only the documented values', () => {
    expect(isChainMemberRole('head')).toBe(true);
    expect(isChainMemberRole('node')).toBe(true);
    expect(isChainMemberRole('root')).toBe(false);

    expect(isChainSyncStatus('unknown')).toBe(true);
    expect(isChainSyncStatus('in_sync')).toBe(true);
    expect(isChainSyncStatus('stale')).toBe(true);
    expect(isChainSyncStatus('error')).toBe(true);
    expect(isChainSyncStatus('synced')).toBe(false);

    expect(isChainRevisionState('candidate')).toBe(true);
    expect(isChainRevisionState('accepted')).toBe(true);
    expect(isChainRevisionState('superseded')).toBe(true);
    expect(isChainRevisionState('rejected')).toBe(true);
    expect(isChainRevisionState('frozen')).toBe(false);
  });
});

describe('graph integrity', () => {
  const linear = {
    headIssueNumber: 1,
    members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }, { issueNumber: 3 }],
    edges: [
      { blockerIssueNumber: 1, blockedIssueNumber: 2 },
      { blockerIssueNumber: 2, blockedIssueNumber: 3 },
    ],
  };

  test('a linear chain is clean', () => {
    expect(checkChainGraphIntegrity(linear)).toEqual([]);
  });

  test('fan-out and fan-in are both representable', () => {
    expect(
      checkChainGraphIntegrity({
        headIssueNumber: 1,
        members: [1, 2, 3, 4].map((issueNumber) => ({ issueNumber })),
        edges: [
          { blockerIssueNumber: 1, blockedIssueNumber: 2 },
          { blockerIssueNumber: 1, blockedIssueNumber: 3 },
          { blockerIssueNumber: 2, blockedIssueNumber: 4 },
          { blockerIssueNumber: 3, blockedIssueNumber: 4 },
        ],
      }),
    ).toEqual([]);
  });

  test('an empty member list is refused', () => {
    expect(checkChainGraphIntegrity({ headIssueNumber: 1, members: [], edges: [] })).toEqual([
      { code: 'empty_members' },
      { code: 'head_not_member', issueNumber: 1 },
    ]);
  });

  test('the head must be a member', () => {
    expect(
      checkChainGraphIntegrity({ headIssueNumber: 9, members: [{ issueNumber: 1 }], edges: [] }),
    ).toEqual([{ code: 'head_not_member', issueNumber: 9 }]);
  });

  test('duplicate members are reported once, on the repeat', () => {
    expect(
      checkChainGraphIntegrity({
        headIssueNumber: 1,
        members: [{ issueNumber: 1 }, { issueNumber: 1 }],
        edges: [],
      }),
    ).toEqual([{ code: 'duplicate_member', issueNumber: 1 }]);
  });

  test('an edge endpoint that is not a member of this chain is refused', () => {
    expect(
      checkChainGraphIntegrity({
        headIssueNumber: 1,
        members: [{ issueNumber: 1 }],
        edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 42 }],
      }),
    ).toEqual([{ code: 'unknown_edge_endpoint', issueNumber: 42 }]);
  });

  test('a self-edge is refused as the one shape no later graph policy could repair', () => {
    expect(
      checkChainGraphIntegrity({
        headIssueNumber: 1,
        members: [{ issueNumber: 1 }],
        edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 1 }],
      }),
    ).toEqual([{ code: 'self_edge', issueNumber: 1 }]);
  });

  test('a longer cycle is NOT refused here — cycle detection belongs to #890', () => {
    expect(
      checkChainGraphIntegrity({
        headIssueNumber: 1,
        members: [{ issueNumber: 1 }, { issueNumber: 2 }],
        edges: [
          { blockerIssueNumber: 1, blockedIssueNumber: 2 },
          { blockerIssueNumber: 2, blockedIssueNumber: 1 },
        ],
      }),
    ).toEqual([]);
  });

  test('a repeated edge is refused', () => {
    expect(
      checkChainGraphIntegrity({
        headIssueNumber: 1,
        members: [{ issueNumber: 1 }, { issueNumber: 2 }],
        edges: [
          { blockerIssueNumber: 1, blockedIssueNumber: 2 },
          { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        ],
      }),
    ).toEqual([{ code: 'duplicate_edge', blockerIssueNumber: 1, blockedIssueNumber: 2 }]);
  });

  test('malformed issue numbers and roles are reported', () => {
    expect(
      checkChainGraphIntegrity({
        headIssueNumber: 1,
        members: [{ issueNumber: 1 }, { issueNumber: 0 }, { issueNumber: 2, role: 'root' }],
        edges: [],
      }),
    ).toEqual([
      { code: 'invalid_issue_number', issueNumber: 0 },
      { code: 'invalid_role', issueNumber: 2, role: 'root' },
    ]);
  });

  test('every violation is reported, not just the first', () => {
    const errors = checkChainGraphIntegrity({
      headIssueNumber: 9,
      members: [{ issueNumber: 1 }, { issueNumber: 1 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 1 }],
    });
    expect(errors).toEqual([
      { code: 'duplicate_member', issueNumber: 1 },
      { code: 'head_not_member', issueNumber: 9 },
      { code: 'self_edge', issueNumber: 1 },
    ]);
  });
});

describe('graph fingerprinting', () => {
  const members = [{ issueNumber: 2 }, { issueNumber: 1, role: 'head' }];
  const edges = [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }];

  test('input order does not change the fingerprint', () => {
    const reversed = {
      members: [...members].reverse(),
      edges: [...edges].reverse(),
    };
    expect(chainGraphFingerprint({ members, edges })).toBe(chainGraphFingerprint(reversed));
  });

  test('canonical text sorts members and edges', () => {
    expect(canonicalChainGraphText({ members, edges })).toBe(
      'members\n1:head\n2:node\nedges\n1->2\n',
    );
  });

  test('an added edge changes the fingerprint', () => {
    const more = {
      members: [...members, { issueNumber: 3 }],
      edges: [...edges, { blockerIssueNumber: 2, blockedIssueNumber: 3 }],
    };
    expect(chainGraphFingerprint(more)).not.toBe(chainGraphFingerprint({ members, edges }));
  });

  test('a changed role changes the fingerprint', () => {
    expect(chainGraphFingerprint({ members: [{ issueNumber: 1, role: 'head' }], edges: [] })).not.toBe(
      chainGraphFingerprint({ members: [{ issueNumber: 1, role: 'node' }], edges: [] }),
    );
  });

  test('edge direction is part of the fingerprint', () => {
    expect(
      chainGraphFingerprint({
        members,
        edges: [{ blockerIssueNumber: 2, blockedIssueNumber: 1 }],
      }),
    ).not.toBe(chainGraphFingerprint({ members, edges }));
  });

  test('the fingerprint is a labelled sha256 digest', () => {
    expect(chainGraphFingerprint({ members, edges })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
