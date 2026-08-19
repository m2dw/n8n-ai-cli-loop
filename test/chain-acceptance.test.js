/**
 * Accepted-revision service (issue #890) against the real #788 store: what
 * acceptance writes, what it refuses, and the invariant everything else leans
 * on — a replacement that does not complete leaves the previously accepted
 * revision exactly where it was.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteChainRegistryStore,
  acceptChainGraph,
  buildFrozenPrefix,
  collectChainOwnership,
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
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chain-acceptance-'));
  store = new SqliteChainRegistryStore(join(tmpDir, 'dev_loop.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createChain(overrides = {}) {
  const result = await store.createChain({
    sessionId: 's1',
    headIssueNumber: 1,
    now: NOW,
    ...overrides,
  });
  if (!result.ok) throw new Error(`createChain failed: ${result.code} ${result.detail ?? ''}`);
  return result.value.chain.chainId;
}

/** Accept `LINEAR` into `chainId` and insist it landed. */
async function acceptLinear(chainId, overrides = {}) {
  const outcome = await acceptChainGraph(store, {
    chainId,
    ...LINEAR,
    now: NOW,
    ...overrides,
  });
  if (outcome.status !== 'accepted') {
    throw new Error(`expected acceptance, got ${outcome.status}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

/**
 * The acceptance port backed by `store`, with individual methods replaced.
 * The store is a class with private state, so its methods are bound rather
 * than spread.
 */
function instrument(overrides) {
  const bound = {
    getChain: (...args) => store.getChain(...args),
    getChainRecord: (...args) => store.getChainRecord(...args),
    listChainsForIssue: (...args) => store.listChainsForIssue(...args),
    putChainGraph: (...args) => store.putChainGraph(...args),
    setChainRevisionState: (...args) => store.setChainRevisionState(...args),
    setAcceptedRevision: (...args) => store.setAcceptedRevision(...args),
  };
  return { ...bound, ...overrides(bound) };
}

describe('accepting a valid graph', () => {
  test('a linear graph becomes the accepted revision', async () => {
    const chainId = await createChain();
    const outcome = await acceptLinear(chainId);

    expect(outcome.acceptedRevision).toBe(2);
    expect(outcome.previousAcceptedRevision).toBeUndefined();
    expect(outcome.canonical.topologicalOrder).toEqual([1, 2, 3]);
    // The graph reported alongside is the revision that was accepted, pointer
    // and all.
    expect(outcome.graph.chain.graphRevision).toBe(2);
    expect(outcome.graph.chain.acceptedRevision).toBe(2);
    expect(outcome.graph.chain.graphFingerprint).toBe(outcome.fingerprint);

    const record = await store.getChainRecord(chainId);
    expect(record.acceptedRevision).toBe(2);
    expect(record.graphRevision).toBe(2);
    expect(record.graphFingerprint).toBe(outcome.fingerprint);

    const revision = await store.getChainRevision(chainId, 2);
    expect(revision.state).toBe('accepted');
    expect(revision.fingerprint).toBe(outcome.fingerprint);
  });

  test('fan-out and fan-in are accepted', async () => {
    const chainId = await createChain();
    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [
        { issueNumber: 1, role: 'head' },
        { issueNumber: 2 },
        { issueNumber: 3 },
        { issueNumber: 4 },
      ],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 1, blockedIssueNumber: 3 },
        { blockerIssueNumber: 2, blockedIssueNumber: 4 },
        { blockerIssueNumber: 3, blockedIssueNumber: 4 },
      ],
      now: NOW,
    });
    expect(outcome.status).toBe('accepted');
    expect(outcome.canonical.topologicalOrder).toEqual([1, 2, 3, 4]);
  });

  test('the graph a chain was created with is accepted without inventing a revision', async () => {
    const chainId = await createChain();
    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }],
      edges: [],
      now: NOW,
    });
    expect(outcome.status).toBe('accepted');
    expect(outcome.acceptedRevision).toBe(1);
    expect(await store.listChainRevisions(chainId)).toHaveLength(1);
  });

  test('a second graph advances the revision and supersedes its predecessor', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });
    expect(outcome.status).toBe('accepted');
    expect(outcome.acceptedRevision).toBe(3);
    expect(outcome.previousAcceptedRevision).toBe(2);
    expect(outcome.supersededRevision).toBe(2);
    expect(outcome.followUpFailure).toBeUndefined();

    expect((await store.getChainRevision(chainId, 2)).state).toBe('superseded');
    expect((await store.getChainRevision(chainId, 3)).state).toBe('accepted');
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(3);
  });

  test('accepting moves the head when the candidate asks it to', async () => {
    const chainId = await createChain();
    const outcome = await acceptChainGraph(store, {
      chainId,
      headIssueNumber: 2,
      members: [{ issueNumber: 1 }, { issueNumber: 2, role: 'head' }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: NOW,
    });
    expect(outcome.status).toBe('accepted');
    expect((await store.getChainRecord(chainId)).headIssueNumber).toBe(2);
  });

  test('re-accepting the same graph in a different order writes nothing', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    const before = await store.getChainRecord(chainId);

    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [...LINEAR.members].reverse(),
      edges: [...LINEAR.edges].reverse(),
      now: LATER,
    });

    expect(outcome.status).toBe('unchanged');
    expect(outcome.acceptedRevision).toBe(2);
    expect(outcome.fingerprint).toBe(before.graphFingerprint);
    // No revision manufactured, and not even a row touch: `rev` and
    // `updatedAt` are part of the comparison.
    expect(await store.getChainRecord(chainId)).toEqual(before);
    expect(await store.listChainRevisions(chainId)).toHaveLength(2);
  });
});

describe('rejection leaves the last accepted revision alone', () => {
  test('a cycle is refused and nothing is written', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    const before = await store.getChainRecord(chainId);

    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }, { issueNumber: 3 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 3 },
        { blockerIssueNumber: 3, blockedIssueNumber: 1 },
      ],
      now: LATER,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['cycle']);
    expect(outcome.acceptedRevision).toBe(2);
    expect(await store.getChainRecord(chainId)).toEqual(before);
    expect((await store.listChainRevisions(chainId)).map((r) => r.revision)).toEqual([1, 2]);
  });

  test('an edge naming a non-member is refused', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 2, blockedIssueNumber: 99 }],
      now: LATER,
    });
    expect(outcome.status).toBe('rejected');
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['missing_member']);
    expect((await store.getChainRecord(chainId)).graphRevision).toBe(2);
  });

  test('an ambiguous identity is refused', async () => {
    const chainId = await createChain();
    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2, role: 'head' }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: NOW,
    });
    expect(outcome.status).toBe('rejected');
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['ambiguous_identity']);
    expect(outcome.acceptedRevision).toBeUndefined();
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBeUndefined();
  });

  test('an issue another chain already owns is refused', async () => {
    const other = await createChain({ headIssueNumber: 5 });
    const chainId = await createChain({ headIssueNumber: 1 });

    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 5 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 5 }],
      now: NOW,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['duplicate_ownership']);
    expect(outcome.diagnostics[0].issues).toEqual([5]);
    expect(outcome.diagnostics[0].chains).toEqual([other]);
  });

  test('a chain re-declaring its own members is not duplicate ownership', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    // Issues 1-3 are now this chain's, and re-proposing a graph over them
    // must not read as a second claim on the same Issues.
    const outcome = await acceptChainGraph(store, {
      chainId,
      members: LINEAR.members,
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 3 }],
      now: LATER,
    });
    expect(outcome.status).toBe('accepted');
  });

  test('ownership is scoped to the chain session by default', async () => {
    await createChain({ headIssueNumber: 5, sessionId: 'other-session' });
    const chainId = await createChain({ headIssueNumber: 1 });

    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 5 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 5 }],
      now: NOW,
    });
    expect(outcome.status).toBe('accepted');
  });

  test('an unknown chain fails rather than pretending to accept', async () => {
    const outcome = await acceptChainGraph(store, { chainId: 'chain_404', ...LINEAR, now: NOW });
    expect(outcome.status).toBe('failed');
    expect(outcome.code).toBe('not_found');
  });
});

describe('stale and concurrent revisions', () => {
  test('a stale expectedRev is refused without writing', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    const before = await store.getChainRecord(chainId);

    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      expectedRev: before.rev + 7,
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.observedRev).toBe(before.rev);
    expect(outcome.acceptedRevision).toBe(2);
    expect(await store.getChainRecord(chainId)).toEqual(before);
  });

  test('a stale expectedAcceptedRevision is refused without writing', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    const before = await store.getChainRecord(chainId);

    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      // Asserts nothing has been accepted yet, which stopped being true.
      expectedAcceptedRevision: null,
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.acceptedRevision).toBe(2);
    expect(await store.getChainRecord(chainId)).toEqual(before);
  });

  test('expectedAcceptedRevision null passes on a chain that has accepted nothing', async () => {
    const chainId = await createChain();
    const outcome = await acceptLinear(chainId, { expectedAcceptedRevision: null });
    expect(outcome.acceptedRevision).toBe(2);
  });

  test('a graph replaced mid-acceptance is refused and the pointer stays put', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    const before = await store.getChainRecord(chainId);

    let raced = false;
    const wrapped = instrument((bound) => ({
      setChainRevisionState: async (...args) => {
        const result = await bound.setChainRevisionState(...args);
        if (!raced) {
          raced = true;
          // Another writer replaces the graph after our candidate was
          // labelled but before the pointer moves to it.
          await bound.putChainGraph({
            chainId,
            members: [{ issueNumber: 1, role: 'head' }],
            edges: [],
            now: LATER,
          });
        }
        return result;
      },
    }));

    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.detail).toContain('during acceptance');
    expect(outcome.acceptedRevision).toBe(before.acceptedRevision);
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(2);
    // The label was written for a pointer move that never happened, so it came
    // back off: nothing but revision 2 is marked accepted.
    expect((await store.getChainRevision(chainId, 3)).state).toBe('candidate');
    const accepted = (await store.listChainRevisions(chainId)).filter(
      (r) => r.state === 'accepted',
    );
    expect(accepted.map((r) => r.revision)).toEqual([2]);
  });

  test('a candidate that is only accepted elsewhere is refused, not reported unchanged', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    // The race lands after this call read the chain record and while it is
    // still collecting ownership — before it can decide its candidate is the
    // graph already accepted.
    let raced = false;
    const wrapped = instrument((bound) => ({
      listChainsForIssue: async (...args) => {
        const result = await bound.listChainsForIssue(...args);
        if (!raced) {
          raced = true;
          const other = await acceptChainGraph(store, {
            chainId,
            members: [{ issueNumber: 1, role: 'head' }],
            edges: [],
            now: LATER,
          });
          expect(other.status).toBe('accepted');
        }
        return result;
      },
    }));

    const outcome = await acceptChainGraph(wrapped, { chainId, ...LINEAR, now: LATER });

    // Reporting `unchanged` here would tell the caller its candidate is still
    // the accepted graph while the store holds a different one.
    expect(outcome.status).toBe('conflict');
    expect(outcome.detail).toContain('during acceptance');
    expect(outcome.acceptedRevision).toBe(3);
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(3);
    expect((await store.listChainRevisions(chainId)).map((r) => r.revision)).toEqual([1, 2, 3]);
  });

  test('expectedAcceptedRevision is enforced against the pointer this call would overwrite', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    // A second acceptance commits after this call checked `acceptedRevision`
    // and before its own graph write.
    let raced = false;
    const wrapped = instrument((bound) => ({
      putChainGraph: async (...args) => {
        if (!raced) {
          raced = true;
          const other = await acceptChainGraph(store, {
            chainId,
            members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 4 }],
            edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 4 }],
            now: LATER,
          });
          expect(other.acceptedRevision).toBe(3);
        }
        return bound.putChainGraph(...args);
      },
    }));

    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      // True when the call started; the race above made it stale.
      expectedAcceptedRevision: 2,
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.detail).toContain('expected accepted revision 2, found 3');
    // The newer accepted graph was not overwritten by a candidate whose author
    // never saw it.
    expect(outcome.acceptedRevision).toBe(3);
    const record = await store.getChainRecord(chainId);
    expect(record.acceptedRevision).toBe(3);
    expect(record.graphRevision).toBe(4);
    expect((await store.getChainRevision(chainId, 4)).state).toBe('candidate');
    expect((await store.getChainRevision(chainId, 3)).state).toBe('accepted');
  });

  test('a lost pointer compare-and-set takes its accepted label back off', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const wrapped = instrument(() => ({
      setAcceptedRevision: async () => ({ ok: false, code: 'conflict', detail: 'expected rev 4, found 5' }),
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.acceptedRevision).toBe(2);
    expect(outcome.followUpFailure).toBeUndefined();
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(2);
    expect((await store.getChainRevision(chainId, 3)).state).toBe('candidate');
  });

  test('losing the pointer to an identical candidate leaves the winner label alone', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const wrapped = instrument(() => ({
      setAcceptedRevision: async () => {
        // Two calls accepting the same candidate label the same revision; this
        // one loses the pointer to the other, which has just committed it.
        await store.setAcceptedRevision(chainId, 3, { now: LATER });
        return { ok: false, code: 'conflict', detail: 'expected rev 5, found 6' };
      },
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    // Revision 3 is accepted — by the winner — so the loser must not relabel it.
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(3);
    expect((await store.getChainRevision(chainId, 3)).state).toBe('accepted');
  });

  test('a pointer committed mid-retraction is not demoted by the loser', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const wrapped = instrument((bound) => ({
      setAcceptedRevision: async () => ({ ok: false, code: 'conflict', detail: 'expected rev 5, found 6' }),
      setChainRevisionState: async (id, revision, state, options) => {
        if (state === 'candidate') {
          // The winner accepted the same candidate, so it labelled the same
          // revision number — and it commits the pointer here: after this call
          // read the record and decided to retract, before the retraction
          // reaches the store. A read-only guard cannot see this.
          expect((await store.setAcceptedRevision(id, revision, { now: LATER })).ok).toBe(true);
        }
        return bound.setChainRevisionState(id, revision, state, options);
      },
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    // Demoting revision 3 here would leave the accepted pointer naming a
    // `candidate` revision — the mirror of the state retraction exists to
    // prevent, and worse, because the pointer is what readers trust.
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(3);
    expect((await store.getChainRevision(chainId, 3)).state).toBe('accepted');
    // Declining to write is the retraction succeeding, not failing.
    expect(outcome.followUpFailure).toBeUndefined();
  });

  test('a retraction that itself fails is reported rather than swallowed', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const wrapped = instrument((bound) => ({
      setAcceptedRevision: async () => ({ ok: false, code: 'conflict', detail: 'lost the pointer' }),
      setChainRevisionState: async (id, revision, state, options) =>
        state === 'candidate'
          ? { ok: false, code: 'not_found', detail: 'boom' }
          : bound.setChainRevisionState(id, revision, state, options),
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.detail).toBe('lost the pointer');
    expect(outcome.followUpFailure).toEqual({ code: 'not_found', detail: 'boom' });
    // The pointer is what decides, and it never moved.
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(2);
  });

  /**
   * A port whose first ownership query lets two acceptances through: one that
   * replaces the graph, and one that puts the original graph back. The chain
   * ends where it started *as a graph* — same members, same edges, same
   * fingerprint — while its accepted revision and its row revision have each
   * moved twice, which is the one shape a graph comparison cannot detect.
   */
  function acceptedAwayAndBack(chainId) {
    let raced = false;
    return instrument((bound) => ({
      listChainsForIssue: async (...args) => {
        const result = await bound.listChainsForIssue(...args);
        if (!raced) {
          raced = true;
          const away = await acceptChainGraph(store, {
            chainId,
            members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 4 }],
            edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 4 }],
            now: LATER,
          });
          expect(away.acceptedRevision).toBe(3);
          const back = await acceptChainGraph(store, { chainId, ...LINEAR, now: LATER });
          expect(back.acceptedRevision).toBe(4);
        }
        return result;
      },
    }));
  }

  test('an accepted revision that moved away and back is refused, not reported unchanged', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const outcome = await acceptChainGraph(acceptedAwayAndBack(chainId), {
      chainId,
      ...LINEAR,
      // True when the call started; the races above made it stale.
      expectedAcceptedRevision: 2,
      now: LATER,
    });

    // The graph matches the candidate again, so nothing but the expectation can
    // tell the caller that the revision it validated against is gone.
    expect(outcome.status).toBe('conflict');
    expect(outcome.detail).toContain('expected accepted revision 2, found 4');
    expect(outcome.acceptedRevision).toBe(4);
    const record = await store.getChainRecord(chainId);
    expect(record.acceptedRevision).toBe(4);
    expect((await store.listChainRevisions(chainId)).map((r) => r.revision)).toEqual([1, 2, 3, 4]);
  });

  test('a stale expectedRev is refused even when the graph matches the candidate', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    const before = await store.getChainRecord(chainId);

    const outcome = await acceptChainGraph(acceptedAwayAndBack(chainId), {
      chainId,
      ...LINEAR,
      expectedRev: before.rev,
      now: LATER,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.detail).toContain(`expected rev ${before.rev}, found`);
    const record = await store.getChainRecord(chainId);
    expect(outcome.observedRev).toBe(record.rev);
    expect(record.acceptedRevision).toBe(4);
  });

  test('an acceptance returns the graph it committed, not one written after it', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    let raced = false;
    const wrapped = instrument((bound) => ({
      setAcceptedRevision: async (...args) => {
        const result = await bound.setAcceptedRevision(...args);
        if (result.ok && !raced) {
          raced = true;
          // Another acceptance replaces the graph in the window between this
          // call's commit and the read it assembles its answer from.
          const other = await acceptChainGraph(store, {
            chainId,
            members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 4 }],
            edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 4 }],
            now: LATER,
          });
          expect(other.acceptedRevision).toBe(4);
        }
        return result;
      },
    }));

    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });

    // Revision 3 is what this call accepted, so revision 3 is what it describes:
    // reporting revision 4's members beside `acceptedRevision: 3` would be an
    // answer no caller could act on.
    expect(outcome.status).toBe('accepted');
    expect(outcome.acceptedRevision).toBe(3);
    expect(outcome.graph.chain.graphRevision).toBe(3);
    expect(outcome.graph.chain.graphFingerprint).toBe(outcome.fingerprint);
    expect(outcome.graph.chain.acceptedRevision).toBe(3);
    expect(outcome.graph.members.map((m) => m.issueNumber).sort()).toEqual([1, 2]);
    // The store has genuinely moved on; the snapshot is a snapshot, not a claim
    // about what the chain holds now.
    expect((await store.getChainRecord(chainId)).graphRevision).toBe(4);
  });
});

describe('concurrent claims on the same issue', () => {
  /**
   * Two acceptances for different chains, each proposing the same previously
   * unowned issue 9, held so that neither writes until both have taken their
   * ownership snapshot. Both therefore see issue 9 as free, which is exactly
   * the window a pre-check cannot close on its own.
   */
  async function raceForIssueNine() {
    const first = await createChain({ headIssueNumber: 1 });
    const second = await createChain({ headIssueNumber: 2 });

    let arrived = 0;
    let bothArrived;
    const gate = new Promise((resolve) => {
      bothArrived = resolve;
    });
    // Both snapshots are taken by the time the second call reaches its write:
    // acceptance collects ownership before it puts a graph.
    const racing = () =>
      instrument((bound) => ({
        putChainGraph: async (...args) => {
          arrived += 1;
          if (arrived === 2) bothArrived();
          await gate;
          return bound.putChainGraph(...args);
        },
      }));

    const [a, b] = await Promise.all([
      acceptChainGraph(racing(), {
        chainId: first,
        members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 9 }],
        edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 9 }],
        now: NOW,
      }),
      acceptChainGraph(racing(), {
        chainId: second,
        members: [{ issueNumber: 2, role: 'head' }, { issueNumber: 9 }],
        edges: [{ blockerIssueNumber: 2, blockedIssueNumber: 9 }],
        now: NOW,
      }),
    ]);

    expect([a.status, b.status].sort()).toEqual(['accepted', 'rejected']);
    return {
      winner: a.status === 'accepted' ? a : b,
      loser: a.status === 'rejected' ? a : b,
    };
  }

  test('an issue cannot end up owned by two chains that raced for it', async () => {
    const { winner, loser } = await raceForIssueNine();

    expect((await store.listChainsForIssue(9)).map((c) => c.chainId)).toEqual([winner.chainId]);
    expect((await store.getChainRecord(winner.chainId)).acceptedRevision).toBe(
      winner.acceptedRevision,
    );
    expect(loser.diagnostics.map((d) => d.code)).toEqual(['duplicate_ownership']);
    expect(loser.diagnostics[0].issues).toEqual([9]);
    expect(loser.diagnostics[0].chains).toEqual([winner.chainId]);
  });

  test('the acceptance that loses the claim writes nothing', async () => {
    const { loser } = await raceForIssueNine();

    const record = await store.getChainRecord(loser.chainId);
    expect(record.graphRevision).toBe(1);
    expect(record.acceptedRevision).toBeUndefined();
    expect(record.rev).toBe(1);
    expect((await store.listChainRevisions(loser.chainId)).map((r) => r.revision)).toEqual([1]);
  });

  test('accepting a candidate already on record re-asserts its claim', async () => {
    const first = await createChain({ headIssueNumber: 1 });
    const candidate = {
      chainId: first,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 9 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 9 }],
      now: NOW,
    };
    // On record but never accepted — the state a partial write leaves behind,
    // and the one a retried acceptance is supposed to heal.
    expect((await store.putChainGraph(candidate)).ok).toBe(true);

    let second;
    const wrapped = instrument((bound) => ({
      putChainGraph: async (...args) => {
        // A chain claiming issue 9 lands after this call took its ownership
        // snapshot. Creation takes no claim of its own, so nothing refused it.
        second ??= await createChain({
          headIssueNumber: 2,
          members: [{ issueNumber: 2 }, { issueNumber: 9 }],
        });
        return bound.putChainGraph(...args);
      },
    }));

    const outcome = await acceptChainGraph(wrapped, { ...candidate, now: LATER });

    // Recording the candidate claimed nothing, so this acceptance is what
    // claims issue 9 — and issue 9 is taken. Waving it through because the
    // stored graph already matches would point the chain at a revision two
    // chains own.
    expect(outcome.status).toBe('rejected');
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['duplicate_ownership']);
    expect(outcome.diagnostics[0].issues).toEqual([9]);
    expect(outcome.diagnostics[0].chains).toEqual([second]);

    const record = await store.getChainRecord(first);
    expect(record.acceptedRevision).toBeUndefined();
    expect(record.graphRevision).toBe(2);
    expect((await store.getChainRevision(first, 2)).state).toBe('candidate');
  });

  test('a candidate already accepted re-asserts its claim before reporting unchanged', async () => {
    const first = await createChain({ headIssueNumber: 1 });
    const candidate = {
      chainId: first,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 9 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 9 }],
      now: NOW,
    };
    expect((await acceptChainGraph(store, candidate)).status).toBe('accepted');
    const before = await store.getChainRecord(first);

    let second;
    const wrapped = instrument((bound) => ({
      // Only the branch that answers `unchanged` re-reads the graph, so this
      // is the window that branch alone runs in: a chain claiming issue 9
      // lands after the ownership snapshot was taken.
      getChain: async (...args) => {
        second ??= await createChain({
          headIssueNumber: 2,
          members: [{ issueNumber: 2 }, { issueNumber: 9 }],
        });
        return bound.getChain(...args);
      },
    }));

    const outcome = await acceptChainGraph(wrapped, { ...candidate, now: LATER });

    // `unchanged` is an assertion that the candidate is still acceptable, not
    // merely that it matches what is stored. Returning it without taking the
    // claim would be the one outcome that decides duplicate ownership from a
    // read taken before the duplicate existed.
    expect(outcome.status).toBe('rejected');
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['duplicate_ownership']);
    expect(outcome.diagnostics[0].issues).toEqual([9]);
    expect(outcome.diagnostics[0].chains).toEqual([second]);
    // A refusal, so the last known good revision is exactly where it was.
    expect(outcome.acceptedRevision).toBe(before.acceptedRevision);
    expect(await store.getChainRecord(first)).toEqual(before);
  });
});

describe('partial writes retain the last known good revision', () => {
  test('a failure before the pointer moves leaves the predecessor accepted', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const wrapped = instrument(() => ({
      setChainRevisionState: async () => ({ ok: false, code: 'not_found', detail: 'boom' }),
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.code).toBe('not_found');
    expect(outcome.acceptedRevision).toBe(2);

    const record = await store.getChainRecord(chainId);
    expect(record.acceptedRevision).toBe(2);
    // The candidate is on record — that is what makes the retry below a
    // repair rather than a second replacement.
    expect(record.graphRevision).toBe(3);
    expect((await store.getChainRevision(chainId, 3)).state).toBe('candidate');
  });

  test('retrying the same candidate after a partial write heals it', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const failing = instrument(() => ({
      setChainRevisionState: async () => ({ ok: false, code: 'not_found', detail: 'boom' }),
    }));
    const candidate = {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    };
    expect((await acceptChainGraph(failing, candidate)).status).toBe('failed');

    const outcome = await acceptChainGraph(store, candidate);
    expect(outcome.status).toBe('accepted');
    expect(outcome.acceptedRevision).toBe(3);
    expect(outcome.previousAcceptedRevision).toBe(2);
    // No fourth revision: the retry recognized the candidate already on record.
    expect((await store.listChainRevisions(chainId)).map((r) => r.revision)).toEqual([1, 2, 3]);
  });

  test('a failure to supersede the predecessor is reported, not swallowed', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const wrapped = instrument((bound) => ({
      setChainRevisionState: async (id, revision, state, options) =>
        state === 'superseded'
          ? { ok: false, code: 'not_found', detail: 'boom' }
          : bound.setChainRevisionState(id, revision, state, options),
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
      now: LATER,
    });

    // The acceptance committed; only the predecessor's label lagged.
    expect(outcome.status).toBe('accepted');
    expect(outcome.acceptedRevision).toBe(3);
    expect(outcome.supersededRevision).toBeUndefined();
    expect(outcome.followUpFailure).toEqual({ code: 'not_found', detail: 'boom' });
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(3);
  });
});

describe('a commit guard on the pointer move', () => {
  const REPLACEMENT = {
    members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
    edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
  };

  test('a veto refuses the acceptance and leaves the accepted revision alone', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    const before = await store.getChainRecord(chainId);

    const outcome = await acceptChainGraph(store, {
      chainId,
      ...REPLACEMENT,
      commitGuard: () => 'a dependency prefix was frozen while this ran',
      now: LATER,
    });

    expect(outcome.status).toBe('vetoed');
    expect(outcome.detail).toBe('a dependency prefix was frozen while this ran');
    expect(outcome.candidateRevision).toBe(3);
    expect(outcome.acceptedRevision).toBe(2);
    expect(outcome.followUpFailure).toBeUndefined();

    const record = await store.getChainRecord(chainId);
    // The pointer — the only thing that decides which graph is last known
    // good — never moved, and the candidate is labelled what it is.
    expect(record.acceptedRevision).toBe(2);
    expect((await store.getChainRevision(chainId, 3)).state).toBe('candidate');
    expect((await store.getChainRevision(chainId, 2)).state).toBe('accepted');
    // The row this call left behind, so a caller can guard its own follow-up
    // writes with it rather than with the revision it started from.
    expect(outcome.observedRev).toBe(record.rev);
    expect(outcome.observedRev).toBeGreaterThan(before.rev);
  });

  test('the guard reads the constraint rows inside the pointer move, not before it', async () => {
    const chainId = await createChain();
    const first = await acceptLinear(chainId);
    const graph = await store.getChain(chainId);

    // What a caller's own pre-check sees before it starts: nothing frozen.
    expect(await store.listFrozenPrefixes({ chainId })).toEqual([]);

    // And then a task starts, freezing #3's ancestry. Freezing writes no chain
    // row, so `expectedRev` cannot notice it and a caller that already read the
    // snapshots never will — only a read taken inside the transaction that
    // moves the pointer can.
    const frozen = await store.putFrozenPrefix(
      buildFrozenPrefix({
        sessionId: 's1',
        issueNumber: 3,
        chainId,
        graph: { members: graph.members, edges: graph.edges },
        graphRevision: graph.chain.graphRevision,
        graphFingerprint: graph.chain.graphFingerprint,
        base: { kind: 'default', baseRef: 'main' },
        frozenAt: NOW,
      }),
    );
    expect(frozen.ok).toBe(true);

    let seen;
    const outcome = await acceptChainGraph(store, {
      chainId,
      // Drops #3 — exactly what the freeze above pins.
      ...REPLACEMENT,
      commitGuard: ({ frozenPrefixes }) => {
        seen = frozenPrefixes.map((snapshot) => snapshot.issueNumber);
        return frozenPrefixes.length > 0 ? 'a dependency prefix was frozen while this ran' : undefined;
      },
      now: LATER,
    });

    // The guard was handed the freeze the caller could not have seen, so the
    // import is refused rather than committed over a running task's contract.
    expect(seen).toEqual([3]);
    expect(outcome.status).toBe('vetoed');
    expect(outcome.detail).toBe('a dependency prefix was frozen while this ran');

    const record = await store.getChainRecord(chainId);
    expect(record.acceptedRevision).toBe(first.acceptedRevision);
    expect((await store.getChainRevision(chainId, 3)).state).toBe('candidate');
  });

  test('commitGuardChainIds hands the guard the source chain freezes, read in the same transaction', async () => {
    const chainId = await createChain();
    const first = await acceptLinear(chainId);

    // The source chain a merge would retire: two members the target's
    // acceptance is about to take over.
    const sourceId = await createChain({ headIssueNumber: 10 });
    const sourceAccepted = await acceptChainGraph(store, {
      chainId: sourceId,
      members: [{ issueNumber: 10, role: 'head' }, { issueNumber: 11 }],
      edges: [{ blockerIssueNumber: 10, blockedIssueNumber: 11 }],
      now: NOW,
    });
    expect(sourceAccepted.status).toBe('accepted');
    const sourceGraph = await store.getChain(sourceId);

    // After the caller's own re-check, a source Issue starts — the freeze is
    // recorded against the SOURCE chain, so the target's own rows never show
    // it. This is the race an append merge's commit guard must still refuse.
    const frozen = await store.putFrozenPrefix(
      buildFrozenPrefix({
        sessionId: 's1',
        issueNumber: 11,
        chainId: sourceId,
        graph: { members: sourceGraph.members, edges: sourceGraph.edges },
        graphRevision: sourceGraph.chain.graphRevision,
        graphFingerprint: sourceGraph.chain.graphFingerprint,
        base: { kind: 'default', baseRef: 'main' },
        frozenAt: NOW,
      }),
    );
    expect(frozen.ok).toBe(true);

    let seen;
    const outcome = await acceptChainGraph(store, {
      chainId,
      // The combined graph an append merge accepts into the target: the
      // source's members gain the whole target as ancestry.
      members: [...LINEAR.members, { issueNumber: 10 }, { issueNumber: 11 }],
      edges: [
        ...LINEAR.edges,
        { blockerIssueNumber: 3, blockedIssueNumber: 10 },
        { blockerIssueNumber: 10, blockedIssueNumber: 11 },
      ],
      tolerateOwnerChainIds: [sourceId],
      commitGuard: ({ frozenPrefixes }) => {
        seen = frozenPrefixes.map((snapshot) => `${snapshot.chainId}#${snapshot.issueNumber}`);
        return frozenPrefixes.length > 0 ? 'a source Issue started while this ran' : undefined;
      },
      commitGuardChainIds: [sourceId],
      now: LATER,
    });

    // The guard was handed the source chain's freeze, not just the target's
    // (empty) list, and the combined graph is refused rather than accepted
    // over the started Issue's contract.
    expect(seen).toEqual([`${sourceId}#11`]);
    expect(outcome.status).toBe('vetoed');
    expect(outcome.detail).toBe('a source Issue started while this ran');

    const record = await store.getChainRecord(chainId);
    expect(record.acceptedRevision).toBe(first.acceptedRevision);
  });

  test('a veto whose retraction fails is reported rather than swallowed', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const wrapped = instrument((bound) => ({
      setChainRevisionState: async (id, revision, state, options) =>
        state === 'candidate'
          ? { ok: false, code: 'not_found', detail: 'boom' }
          : bound.setChainRevisionState(id, revision, state, options),
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      ...REPLACEMENT,
      commitGuard: () => 'no',
      now: LATER,
    });

    expect(outcome.status).toBe('vetoed');
    expect(outcome.followUpFailure).toEqual({ code: 'not_found', detail: 'boom' });
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(2);
  });

  test('a guard that throws retracts the label and fails rather than propagating', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);
    const before = await store.getChainRecord(chainId);

    const outcome = await acceptChainGraph(store, {
      chainId,
      ...REPLACEMENT,
      // What a frozen-prefix check does when the rows it is judging make no
      // sense to it: it neither vetoes nor passes. The transaction it threw
      // inside rolls back, so the pointer stays where it was.
      commitGuard: () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      },
      now: LATER,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.code).toBe('internal_error');
    expect(outcome.detail).toContain('SQLITE_IOERR: disk I/O error');
    expect(outcome.followUpFailure).toBeUndefined();
    expect(outcome.acceptedRevision).toBe(2);

    const record = await store.getChainRecord(chainId);
    // The label written for a pointer move that did not happen is back to what
    // the revision actually is, so no reader sees a revision marked accepted
    // that `acceptedRevision` does not name.
    expect(record.acceptedRevision).toBe(2);
    expect((await store.getChainRevision(chainId, 3)).state).toBe('candidate');
    expect((await store.getChainRevision(chainId, 2)).state).toBe('accepted');
    expect(record.rev).toBeGreaterThan(before.rev);
  });

  test('a throwing guard whose retraction also throws still answers', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    // The failure that made the check throw usually takes the retraction with
    // it; losing the answer to that second throw would land back in the generic
    // path the first catch exists to avoid.
    const wrapped = instrument((bound) => ({
      setChainRevisionState: async (id, revision, state, options) => {
        if (state === 'candidate') throw new Error('SQLITE_IOERR: disk I/O error');
        return bound.setChainRevisionState(id, revision, state, options);
      },
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      ...REPLACEMENT,
      commitGuard: () => {
        throw new Error('frozen prefixes unreadable');
      },
      now: LATER,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.code).toBe('internal_error');
    expect(outcome.detail).toContain('frozen prefixes unreadable');
    expect(outcome.followUpFailure.code).toBe('internal_error');
    expect(outcome.followUpFailure.detail).toContain('retract the accepted label on revision 3');
    // Reported, not repaired: the pointer is what decides the last known good
    // graph, and it never moved.
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(2);
  });

  test('a guard that passes leaves the acceptance exactly as it was', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    let calls = 0;
    const outcome = await acceptChainGraph(store, {
      chainId,
      ...REPLACEMENT,
      commitGuard: () => {
        calls += 1;
        return undefined;
      },
      now: LATER,
    });

    expect(calls).toBe(1);
    expect(outcome.status).toBe('accepted');
    expect(outcome.acceptedRevision).toBe(3);
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(3);
  });

  test('a refusal decided before the first write never reaches the check', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    let called = false;
    const outcome = await acceptChainGraph(store, {
      chainId,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
      edges: [
        { blockerIssueNumber: 1, blockedIssueNumber: 2 },
        { blockerIssueNumber: 2, blockedIssueNumber: 1 },
      ],
      commitGuard: () => {
        called = true;
        return undefined;
      },
      now: LATER,
    });

    expect(outcome.status).toBe('rejected');
    expect(called).toBe(false);
  });

  test('an unchanged acceptance commits nothing, so nothing consults the check', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    let called = false;
    const outcome = await acceptChainGraph(store, {
      chainId,
      ...LINEAR,
      commitGuard: () => {
        called = true;
        return 'no';
      },
      now: LATER,
    });

    // The accepted graph is the candidate already, so there is no new graph for
    // a late condition to refuse — and vetoing here would refuse a state the
    // chain is simply already in.
    expect(outcome.status).toBe('unchanged');
    expect(called).toBe(false);
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(2);
  });
});

describe('the row revision a caller may guard its own follow-up write on', () => {
  const REPLACEMENT = {
    members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }],
    edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 2 }],
  };

  test("committedRev counts the acceptance's own bookkeeping writes", async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const outcome = await acceptChainGraph(store, { chainId, ...REPLACEMENT, now: LATER });
    expect(outcome.status).toBe('accepted');
    // The predecessor's `superseded` label is written *after* the pointer
    // moves and touches the chain row, so the revision captured at the commit
    // is already stale by the time the call returns. What comes back is the
    // one this acceptance's last write left behind — a caller guarding on
    // anything else would lose a compare-and-set to the acceptance itself.
    expect(outcome.supersededRevision).toBe(2);
    expect(outcome.committedRev).toBe((await store.getChainRecord(chainId)).rev);

    const marked = await store.setChainSyncState(chainId, {
      status: 'in_sync',
      checkedAt: LATER,
      expectedRev: outcome.committedRev,
      now: LATER,
    });
    expect(marked.ok).toBe(true);
  });

  test('a concurrent verdict landing after the commit costs this run the guard', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    let raced = false;
    const wrapped = instrument((bound) => ({
      getChain: async (...args) => {
        // The one read the accepted path takes after its pointer move. A
        // second sync recording a structural failure lands in that window: it
        // bumps the row without touching the graph revision, so the graph read
        // back here cannot tell it happened.
        if (!raced) {
          raced = true;
          await store.setChainSyncState(chainId, {
            status: 'error',
            error: 'cycle: 1 -> 2 -> 1',
            checkedAt: LATER,
            now: LATER,
          });
        }
        return bound.getChain(...args);
      },
    }));
    const outcome = await acceptChainGraph(wrapped, { chainId, ...REPLACEMENT, now: LATER });

    expect(outcome.status).toBe('accepted');
    expect(raced).toBe(true);
    // The graph carries the other run's bump; the pinned revision does not.
    expect(outcome.graph.chain.rev).toBeGreaterThan(outcome.committedRev);

    // So the follow-up write this run wanted to make is refused rather than
    // overwriting a verdict newer than its own.
    const clobber = await store.setChainSyncState(chainId, {
      status: 'in_sync',
      checkedAt: LATER,
      expectedRev: outcome.committedRev,
      now: LATER,
    });
    expect(clobber.ok).toBe(false);
    expect(clobber.code).toBe('conflict');
    const record = await store.getChainRecord(chainId);
    expect(record.syncStatus).toBe('error');
    expect(record.syncError).toBe('cycle: 1 -> 2 -> 1');
  });

  test('a verdict landing before the bookkeeping label costs the label, not the pin', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    let raced = false;
    const wrapped = instrument((bound) => ({
      setChainRevisionState: async (id, revision, state, options) => {
        // The predecessor's `superseded` label is written after the pointer
        // moved. A second sync recording a structural failure lands in that
        // window: it bumps the row without touching the graph revision, so an
        // unpinned label write would apply on top of it and report the sum.
        if (state === 'superseded' && !raced) {
          raced = true;
          await store.setChainSyncState(chainId, {
            status: 'error',
            error: 'cycle: 1 -> 2 -> 1',
            checkedAt: LATER,
            now: LATER,
          });
        }
        return bound.setChainRevisionState(id, revision, state, options);
      },
    }));
    const outcome = await acceptChainGraph(wrapped, { chainId, ...REPLACEMENT, now: LATER });

    // The acceptance itself committed — the pointer move happened before any of
    // this — and only the predecessor's label lagged.
    expect(outcome.status).toBe('accepted');
    expect(raced).toBe(true);
    expect((await store.getChainRecord(chainId)).acceptedRevision).toBe(3);
    expect(outcome.supersededRevision).toBeUndefined();
    expect(outcome.followUpFailure.code).toBe('conflict');

    // Which is the point: `committedRev` still describes the commit, so the
    // follow-up this run wanted to make loses to the other run's verdict
    // instead of overwriting it.
    const clobber = await store.setChainSyncState(chainId, {
      status: 'in_sync',
      checkedAt: LATER,
      expectedRev: outcome.committedRev,
      now: LATER,
    });
    expect(clobber.ok).toBe(false);
    expect(clobber.code).toBe('conflict');
    const record = await store.getChainRecord(chainId);
    expect(record.syncStatus).toBe('error');
    expect(record.syncError).toBe('cycle: 1 -> 2 -> 1');
  });

  test('a verdict landing while a veto retracts its label is not overwritten', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    let raced = false;
    const wrapped = instrument((bound) => ({
      setChainRevisionState: async (id, revision, state, options) => {
        // Between the guard's refusal and the retraction of the label it
        // invalidated, another sync records its own structural failure.
        if (state === 'candidate' && !raced) {
          raced = true;
          await store.setChainSyncState(chainId, {
            status: 'error',
            error: 'cycle: 1 -> 2 -> 1',
            checkedAt: LATER,
            now: LATER,
          });
        }
        return bound.setChainRevisionState(id, revision, state, options);
      },
    }));
    const outcome = await acceptChainGraph(wrapped, {
      chainId,
      ...REPLACEMENT,
      commitGuard: () => 'a dependency prefix was frozen while this ran',
      now: LATER,
    });

    expect(outcome.status).toBe('vetoed');
    expect(raced).toBe(true);
    // The label still comes off — a candidate left marked `accepted` is the
    // state the retraction exists to prevent, whoever else has written since.
    expect((await store.getChainRevision(chainId, 3)).state).toBe('candidate');
    expect(outcome.followUpFailure).toBeUndefined();

    // But the revision handed back is the one this call had pinned, not the row
    // as the other run's verdict and the unpinnable retraction left it.
    const record = await store.getChainRecord(chainId);
    expect(outcome.observedRev).toBeLessThan(record.rev);
    const clobber = await store.setChainSyncState(chainId, {
      status: 'error',
      error: 'a dependency prefix was frozen while this ran',
      checkedAt: LATER,
      expectedRev: outcome.observedRev,
      now: LATER,
    });
    expect(clobber.ok).toBe(false);
    expect(clobber.code).toBe('conflict');
    expect((await store.getChainRecord(chainId)).syncError).toBe('cycle: 1 -> 2 -> 1');
  });

  test('an unchanged answer pins the row its claim write observed', async () => {
    const chainId = await createChain();
    await acceptLinear(chainId);

    const outcome = await acceptChainGraph(store, { chainId, ...LINEAR, now: LATER });
    expect(outcome.status).toBe('unchanged');
    // Nothing moved, and no read stands between that write and the caller.
    expect(outcome.committedRev).toBe((await store.getChainRecord(chainId)).rev);
  });
});

describe('ownership collection', () => {
  test('it reports every chain an issue belongs to, excluding the caller', async () => {
    const first = await createChain({ headIssueNumber: 5 });
    const second = await createChain({ headIssueNumber: 1 });
    await acceptChainGraph(store, {
      chainId: second,
      members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 7 }],
      edges: [{ blockerIssueNumber: 1, blockedIssueNumber: 7 }],
      now: NOW,
    });

    expect(await collectChainOwnership(store, [5, 7])).toEqual([
      { issueNumber: 5, chainId: first },
      { issueNumber: 7, chainId: second },
    ]);
    expect(await collectChainOwnership(store, [5, 7], { excludeChainId: second })).toEqual([
      { issueNumber: 5, chainId: first },
    ]);
  });

  test('repeated and malformed issue numbers are not queried twice or at all', async () => {
    const chainId = await createChain({ headIssueNumber: 5 });
    const asked = [];
    const probe = {
      listChainsForIssue: (issueNumber, filter) => {
        asked.push(issueNumber);
        return store.listChainsForIssue(issueNumber, filter);
      },
    };
    const entries = await collectChainOwnership(probe, [5, 5, 0, -1, 'x']);
    expect(asked).toEqual([5]);
    expect(entries).toEqual([{ issueNumber: 5, chainId }]);
  });
});
