/**
 * Chain-aware progressive Issue refinement — the bounded predecessor snapshot
 * (issue #868, docs/issue-refinement-contract.md §4, §5, §6).
 *
 * Pins the §4 ordered guard list, the two usable predecessor shapes and every
 * way they fail closed, the §5 bounds and truncation record, and the §6
 * fingerprint — including the two inputs it deliberately excludes.
 */

import {
  DEFAULT_REFINEMENT_MARKER_LABEL,
  IMPLEMENTATION_STATUS_LABEL,
  ISSUE_REFINEMENT_DEFAULT_LIMITS,
  REFINEMENT_MAX_COMMENT_IDENTITY_BYTES,
  REFINEMENT_MAX_PR_IDENTITY_BYTES,
  REFINEMENT_MAX_TARGET_LABELS,
  REFINEMENT_MAX_TARGET_LABEL_BYTES,
  REFINEMENT_PREDECESSOR_HOLD_REASONS,
  REFINEMENT_PREDECESSOR_SHAPES,
  REFINEMENT_SNAPSHOT_VERSION,
  boundSnapshotText,
  buildRefinementSnapshot,
  classifyPredecessorUsability,
  computePredecessorFingerprint,
  refinementPredecessorRecords,
  refinementSnapshotByteBudget,
} from '../dist/index.js';

const STACK_READY = 'status:stack-ready';
const NOW = '2026-08-10T00:00:00.000Z';
const LANE_LABELS = {
  marker: DEFAULT_REFINEMENT_MARKER_LABEL,
  implementationStatus: IMPLEMENTATION_STATUS_LABEL,
};

// ---------------------------------------------------------------------------
// A fake provider. Every method is a read; the port offers nothing else, which
// is how "no Issue body mutation, no relationship mutation, no activation" is
// enforced rather than asserted.
// ---------------------------------------------------------------------------

function sha(seed) {
  return String(seed).repeat(40).slice(0, 40);
}

/** A usable open stack-ready predecessor, overridable field by field. */
function predecessor(n, overrides = {}) {
  const { issue: issueOverride, pr: prOverride, ...rest } = overrides;
  return {
    issue: {
      number: n,
      state: 'open',
      title: `Predecessor ${n}`,
      body: `Predecessor ${n} body`,
      labels: [STACK_READY, 'agent:claude'],
      ...issueOverride,
    },
    pr:
      prOverride === null
        ? null
        : {
            number: 900 + n,
            state: 'open',
            headRefName: `ai/issue-${n}`,
            headSha: sha(n),
            title: `PR for ${n}`,
            body: `PR ${n} body`,
            ...prOverride,
          },
    comments: [
      { id: `c${n}-1`, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', body: `comment ${n}-1` },
    ],
    paths: [{ path: `src/p${n}.ts`, added: 3, removed: 1 }],
    review: { outcome: 'success' },
    ...rest,
  };
}

function target(overrides = {}) {
  return {
    number: 500,
    state: 'open',
    title: 'Downstream Issue',
    body: 'Downstream body',
    labels: ['agent:claude', DEFAULT_REFINEMENT_MARKER_LABEL],
    ...overrides,
  };
}

/**
 * Build the port. Any per-issue field may be a function of the call index for
 * that issue, so a predecessor can be made to MOVE between the capture read and
 * the verification read.
 */
function makeSource(world, opts = {}) {
  const calls = [];
  const counts = new Map();
  const nth = (n) => {
    const i = counts.get(n) ?? 0;
    counts.set(n, i + 1);
    return i;
  };
  const resolve = (value, i) => (typeof value === 'function' ? value(i) : value);
  const entry = (n) => {
    const e = world[n];
    if (!e) throw new Error(`test fixture has no issue #${n}`);
    return e;
  };

  const port = {
    // The relationship set is read more than once — at the top of the capture
    // and again before the snapshot is sealed — so, like every per-issue field
    // here, it may be a function of the call index and MOVE between the two.
    async getBlockedBy(n) {
      calls.push(['getBlockedBy', n]);
      const i = nth('blockedBy');
      const thrown = resolve(opts.blockedByThrows, i);
      if (thrown) throw new Error(thrown);
      return resolve(opts.blockedBy ?? [], i);
    },
    async readIssue(n) {
      calls.push(['readIssue', n]);
      if (opts.readIssueThrows) throw new Error(opts.readIssueThrows);
      return resolve(entry(n).issue, nth(`issue:${n}`));
    },
    async readPullRequest(n) {
      calls.push(['readPullRequest', n]);
      if (opts.readPullRequestThrows) throw new Error(opts.readPullRequestThrows);
      const pr = resolve(entry(n).pr, nth(`pr:${n}`));
      if (pr === null) return { kind: 'none' };
      if (pr && pr.ambiguous) return { kind: 'ambiguous', detail: 'two open PRs' };
      return { kind: 'found', pullRequest: pr };
    },
    async readChangedPaths(prNumber, limit) {
      calls.push(['readChangedPaths', prNumber, limit]);
      const owner = Object.values(world).find((e) => e.pr && e.pr.number === prNumber);
      if (!owner) return [];
      // A compliant adapter honours the caller-supplied limit exactly; the
      // default fake ignores it, which is the over-eager adapter the core caps
      // again for.
      const paths = opts.honorChangedPathLimit ? owner.paths.slice(0, limit) : owner.paths;
      // `changedPathsComplete` picks the listing form of the port's return type:
      // the adapter reports whether the response is the whole set instead of
      // leaving the core to assume it is a page.
      return opts.changedPathsComplete === undefined
        ? paths
        : { paths, complete: opts.changedPathsComplete };
    },
    async readIssueComments(n, limit) {
      calls.push(['readIssueComments', n, limit]);
      return entry(n).comments;
    },
    async readReviewSummary(n) {
      calls.push(['readReviewSummary', n]);
      return entry(n).review;
    },
    async readIssuePlan(n) {
      calls.push(['readIssuePlan', n]);
      if (opts.issuePlanThrows) throw new Error(opts.issuePlanThrows);
      return opts.issuePlan ?? null;
    },
  };
  if (opts.chainAgreement || opts.chainAgreementThrows) {
    port.readChainAgreement = async (n, observed) => {
      calls.push(['readChainAgreement', n, [...observed]]);
      const i = nth('chainAgreement');
      if (opts.chainAgreementThrows) throw new Error(opts.chainAgreementThrows);
      return resolve(opts.chainAgreement, i);
    };
  }
  return { port, calls };
}

async function build(world, opts = {}) {
  const { port, calls } = makeSource(world, opts);
  const result = await buildRefinementSnapshot({
    target: opts.target ?? target(),
    source: port,
    limits: { ...ISSUE_REFINEMENT_DEFAULT_LIMITS, ...(opts.limits ?? {}) },
    laneLabels: LANE_LABELS,
    stackReadyLabel: STACK_READY,
    now: opts.now ?? NOW,
  });
  return { result, calls };
}

/** `blocked by` edges for the given predecessor numbers. */
function edges(...numbers) {
  return numbers.map((n) => ({ issueNumber: n, state: 'open' }));
}

// ---------------------------------------------------------------------------
// §4 — the ordered guard list; the first match wins
// ---------------------------------------------------------------------------

describe('issue-refinement snapshot — §4 structural guards', () => {
  test('row 7: a chainless Issue is refused, not refined', async () => {
    const { result } = await build({}, { blockedBy: [] });
    expect(result).toEqual({
      kind: 'handoff',
      reason: 'not_chain_scoped',
      predecessorIssueNumbers: [],
    });
  });

  test('row 5: more direct predecessors than the fan-in cap hands off', async () => {
    const world = { 1: predecessor(1), 2: predecessor(2), 3: predecessor(3), 4: predecessor(4), 5: predecessor(5) };
    const { result } = await build(world, { blockedBy: edges(1, 2, 3, 4, 5) });
    expect(result.kind).toBe('handoff');
    expect(result.reason).toBe('fan_in_exceeded');
    expect(result.predecessorIssueNumbers).toEqual([1, 2, 3, 4, 5]);
  });

  test('the fan-in handoff wins over an unready predecessor — waiting never fixes it', async () => {
    const world = {
      1: predecessor(1),
      2: predecessor(2),
      3: predecessor(3),
      4: predecessor(4),
      5: predecessor(5, { pr: null }),
    };
    const { result, calls } = await build(world, { blockedBy: edges(1, 2, 3, 4, 5) });
    expect(result.reason).toBe('fan_in_exceeded');
    // Decided from the edge set alone: no predecessor was read at all.
    expect(calls.filter((c) => c[0] === 'readIssue')).toHaveLength(0);
  });

  test('row 6: a chain registry that disagrees hands off before any predecessor read', async () => {
    const world = { 1: predecessor(1) };
    const { result, calls } = await build(world, {
      blockedBy: edges(1),
      chainAgreement: { kind: 'disagrees', detail: 'accepted revision has #7' },
    });
    expect(result.kind).toBe('handoff');
    expect(result.reason).toBe('chain_disagreement');
    expect(result.detail).toBe('accepted revision has #7');
    expect(calls.filter((c) => c[0] === 'readIssue')).toHaveLength(0);
  });

  test('the chain cross-check is optional: no registry wired is not a disagreement', async () => {
    const world = { 1: predecessor(1) };
    const { result, calls } = await build(world, { blockedBy: edges(1) });
    expect(result.kind).toBe('captured');
    expect(calls.some((c) => c[0] === 'readChainAgreement')).toBe(false);
  });

  test('an Issue the registry does not know takes no side', async () => {
    const world = { 1: predecessor(1) };
    const { result, calls } = await build(world, {
      blockedBy: edges(1),
      chainAgreement: { kind: 'unregistered' },
    });
    expect(result.kind).toBe('captured');
    expect(calls).toContainEqual(['readChainAgreement', 500, [1]]);
  });

  test('duplicate edges are collapsed rather than inflating the fan-in', async () => {
    const world = { 1: predecessor(1) };
    const { result } = await build(world, {
      blockedBy: [...edges(1), ...edges(1), ...edges(1), ...edges(1), ...edges(1)],
    });
    expect(result.kind).toBe('captured');
    expect(result.snapshot.predecessors.map((p) => p.issueNumber)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Provider failures — transient, never read as "no blockers"
// ---------------------------------------------------------------------------

describe('issue-refinement snapshot — provider failures fail closed', () => {
  test('a relationship query that throws is a failure, never an empty predecessor set', async () => {
    const { result } = await build({}, { blockedByThrows: 'graphql exploded' });
    expect(result).toEqual({
      kind: 'failed',
      stage: 'blocked_by',
      issueNumber: 500,
      error: 'graphql exploded',
    });
  });

  test('a chain lookup that errors stops the capture', async () => {
    const { result } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      chainAgreementThrows: 'registry unavailable',
    });
    expect(result.kind).toBe('failed');
    expect(result.stage).toBe('chain_agreement');
  });

  test('an issue-plan read that throws stops the capture rather than recording "absent"', async () => {
    const { result } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      issuePlanThrows: 'EIO',
    });
    expect(result.kind).toBe('failed');
    expect(result.stage).toBe('issue_plan');
  });

  test('a failure message is scrubbed of credentials before it is reported', async () => {
    const { result } = await build({}, {
      blockedByThrows: 'auth failed for ghp_abcdefghijklmnopqrstuvwxyz012345',
    });
    expect(result.error).toBe('auth failed for [redacted]');
  });
});

// ---------------------------------------------------------------------------
// §4 condition 4 — the two usable shapes, and every way they fail closed
// ---------------------------------------------------------------------------

describe('issue-refinement snapshot — §4 predecessor usability', () => {
  test('the two shapes and the hold reasons are closed sets', () => {
    expect([...REFINEMENT_PREDECESSOR_SHAPES]).toEqual(['open_stack_ready', 'merged']);
    expect([...REFINEMENT_PREDECESSOR_HOLD_REASONS]).toEqual([
      'no_pull_request',
      'ambiguous_pull_request',
      'not_stack_ready',
      'missing_head_ref',
      'missing_head_sha',
      'missing_merge_commit',
      'pull_request_not_usable',
      'changed_during_capture',
    ]);
  });

  test('one predecessor: an open stack-ready head captures the whole §5 list', async () => {
    const world = { 1: predecessor(1) };
    const { result } = await build(world, { blockedBy: edges(1) });
    expect(result.kind).toBe('captured');
    const snap = result.snapshot;
    expect(snap.version).toBe(REFINEMENT_SNAPSHOT_VERSION);
    expect(snap.target).toMatchObject({
      issueNumber: 500,
      title: 'Downstream Issue',
      body: 'Downstream body',
      sourceBody: 'Downstream body',
      managedRegion: 'absent',
      labelsCapped: false,
      issuePlan: null,
    });
    expect(snap.target.labels).toEqual(['agent:claude', DEFAULT_REFINEMENT_MARKER_LABEL].sort());
    expect(snap.predecessors).toHaveLength(1);
    expect(snap.predecessors[0]).toMatchObject({
      issueNumber: 1,
      issueState: 'open',
      title: 'Predecessor 1',
      body: 'Predecessor 1 body',
      stackReady: true,
      shape: 'open_stack_ready',
      reviewOutcome: 'success',
      disputeLineages: null,
      changedPathsCapped: false,
    });
    expect(snap.predecessors[0].pullRequest).toEqual({
      number: 901,
      state: 'open',
      headRefName: 'ai/issue-1',
      headSha: sha(1),
      mergeCommitSha: null,
      title: 'PR for 1',
      body: 'PR 1 body',
    });
    expect(snap.predecessors[0].changedPaths).toEqual([{ path: 'src/p1.ts', added: 3, removed: 1 }]);
    expect(snap.predecessors[0].comments).toEqual([
      { id: 'c1-1', updatedAt: '2026-08-01T00:00:00Z', body: 'comment 1-1' },
    ]);
    expect(snap.predecessorFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a merged predecessor is usable WITHOUT the stack-ready marker', async () => {
    const world = {
      1: predecessor(1, {
        issue: { state: 'closed', labels: ['agent:claude'] },
        pr: { state: 'merged', mergeCommitSha: sha(9) },
      }),
    };
    const { result } = await build(world, { blockedBy: edges(1) });
    expect(result.kind).toBe('captured');
    expect(result.snapshot.predecessors[0]).toMatchObject({
      issueState: 'closed',
      stackReady: false,
      shape: 'merged',
    });
    expect(result.snapshot.predecessors[0].pullRequest).toMatchObject({
      state: 'merged',
      mergeCommitSha: sha(9),
    });
  });

  test('a merged PR with no merge commit SHA is ambiguous identity, not a result', async () => {
    const world = { 1: predecessor(1, { pr: { state: 'merged' } }) };
    const { result } = await build(world, { blockedBy: edges(1) });
    expect(result.kind).toBe('hold');
    expect(result.reason).toBe('predecessor_not_ready');
    expect(result.holds).toEqual([{ issueNumber: 1, reason: 'missing_merge_commit' }]);
  });

  test('a missing PR holds; an ambiguous one holds too, and neither is guessed at', async () => {
    const noPr = await build({ 1: predecessor(1, { pr: null }) }, { blockedBy: edges(1) });
    expect(noPr.result.holds).toEqual([{ issueNumber: 1, reason: 'no_pull_request' }]);

    const ambiguous = await build({ 1: predecessor(1, { pr: { ambiguous: true } }) }, { blockedBy: edges(1) });
    expect(ambiguous.result.holds).toEqual([
      { issueNumber: 1, reason: 'ambiguous_pull_request', detail: 'two open PRs' },
    ]);
  });

  test('a missing head SHA or head ref holds — the identity the snapshot is built on', async () => {
    const noSha = await build({ 1: predecessor(1, { pr: { headSha: '' } }) }, { blockedBy: edges(1) });
    expect(noSha.result.holds).toEqual([{ issueNumber: 1, reason: 'missing_head_sha' }]);

    const noRef = await build({ 1: predecessor(1, { pr: { headRefName: '' } }) }, { blockedBy: edges(1) });
    expect(noRef.result.holds).toEqual([{ issueNumber: 1, reason: 'missing_head_ref' }]);
  });

  test('an open PR without the stack-ready marker holds', async () => {
    const world = { 1: predecessor(1, { issue: { labels: ['agent:claude'] } }) };
    const { result } = await build(world, { blockedBy: edges(1) });
    expect(result.holds).toEqual([{ issueNumber: 1, reason: 'not_stack_ready' }]);
  });

  test('stale stack-ready metadata: the marker outlives the PR it stood for', async () => {
    // The Issue still carries `status:stack-ready`, but the PR it was applied for
    // was closed unmerged. §13: that predecessor holds, it does not proceed.
    const closed = await build({ 1: predecessor(1, { pr: { state: 'closed' } }) }, { blockedBy: edges(1) });
    expect(closed.result.kind).toBe('hold');
    expect(closed.result.holds[0]).toMatchObject({
      issueNumber: 1,
      reason: 'pull_request_not_usable',
      detail: 'state=closed',
    });

    // …and the same when the marker is stale against a head that no longer merges,
    // which is exactly what the Gate 2 resolver refuses.
    const conflicting = await build(
      { 1: predecessor(1, { pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } }) },
      { blockedBy: edges(1) },
    );
    expect(conflicting.result.holds[0]).toMatchObject({
      issueNumber: 1,
      reason: 'pull_request_not_usable',
    });

    // …and the same when the PR vanished entirely while the marker stayed.
    const gone = await build({ 1: predecessor(1, { pr: null }) }, { blockedBy: edges(1) });
    expect(gone.result.holds).toEqual([{ issueNumber: 1, reason: 'no_pull_request' }]);
  });

  test('classifyPredecessorUsability is the pure decision behind all of it', () => {
    const issue = { number: 7, state: 'open', title: 't', body: 'b', labels: [STACK_READY] };
    const pr = { number: 70, state: 'open', headRefName: 'ai/issue-7', headSha: sha(7), title: 'p', body: 'q' };
    expect(classifyPredecessorUsability(issue, { kind: 'found', pullRequest: pr }, STACK_READY).kind).toBe(
      'usable',
    );
    expect(classifyPredecessorUsability(issue, { kind: 'none' }, STACK_READY)).toEqual({
      kind: 'unusable',
      hold: { issueNumber: 7, reason: 'no_pull_request' },
    });
    // A session that renamed the marker is honoured; the default no longer confirms.
    expect(
      classifyPredecessorUsability(issue, { kind: 'found', pullRequest: pr }, 'status:ready-to-stack').kind,
    ).toBe('unusable');
  });
});

// ---------------------------------------------------------------------------
// Fan-in
// ---------------------------------------------------------------------------

describe('issue-refinement snapshot — multiple predecessors', () => {
  test('a fan-in of one merged and one open stack-ready predecessor is eligible', async () => {
    const world = {
      3: predecessor(3),
      1: predecessor(1, {
        issue: { state: 'closed', labels: [] },
        pr: { state: 'merged', mergeCommitSha: sha(4) },
      }),
    };
    const { result } = await build(world, { blockedBy: edges(3, 1) });
    expect(result.kind).toBe('captured');
    // Ascending Issue number (§5, §6), whatever order the provider listed them in.
    expect(result.snapshot.predecessors.map((p) => p.issueNumber)).toEqual([1, 3]);
    expect(result.snapshot.predecessors.map((p) => p.shape)).toEqual(['merged', 'open_stack_ready']);
    expect(result.snapshot.manifest.predecessorCount).toBe(2);
  });

  test('partial readiness holds the whole Issue, and every unready predecessor is named', async () => {
    const world = {
      1: predecessor(1),
      2: predecessor(2, { issue: { labels: [] } }),
      3: predecessor(3, { pr: null }),
    };
    const { result } = await build(world, { blockedBy: edges(1, 2, 3) });
    expect(result.kind).toBe('hold');
    expect(result.reason).toBe('predecessor_not_ready');
    expect(result.predecessorIssueNumbers).toEqual([1, 2, 3]);
    expect(result.holds).toEqual([
      { issueNumber: 2, reason: 'not_stack_ready' },
      { issueNumber: 3, reason: 'no_pull_request' },
    ]);
  });

  test('the §15 projection carries numbers and SHAs only', async () => {
    const world = {
      1: predecessor(1),
      2: predecessor(2, { pr: { state: 'merged', mergeCommitSha: sha(8) } }),
    };
    const { result } = await build(world, { blockedBy: edges(1, 2) });
    expect(refinementPredecessorRecords(result.snapshot)).toEqual([
      { issueNumber: 1, prNumber: 901, headSha: sha(1), state: 'open' },
      { issueNumber: 2, prNumber: 902, headSha: sha(2), state: 'merged' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// A predecessor that MOVES during construction
// ---------------------------------------------------------------------------

describe('issue-refinement snapshot — changed during construction', () => {
  test('a new head SHA between capture and verification holds, it does not ship', async () => {
    const moving = predecessor(1);
    const world = {
      1: {
        ...moving,
        pr: (i) => ({ ...moving.pr, headSha: i === 0 ? sha(1) : sha(2) }),
      },
    };
    const { result } = await build(world, { blockedBy: edges(1) });
    expect(result.kind).toBe('hold');
    expect(result.holds).toEqual([{ issueNumber: 1, reason: 'changed_during_capture' }]);
  });

  test('a predecessor that merges mid-capture holds, and is re-snapshotted next poll', async () => {
    const moving = predecessor(1);
    const world = {
      1: {
        ...moving,
        pr: (i) => (i === 0 ? moving.pr : { ...moving.pr, state: 'merged', mergeCommitSha: sha(3) }),
      },
    };
    const { result } = await build(world, { blockedBy: edges(1) });
    expect(result.holds).toEqual([{ issueNumber: 1, reason: 'changed_during_capture' }]);
  });

  test('a predecessor whose marker is withdrawn mid-capture holds, naming what it became', async () => {
    const moving = predecessor(1);
    const world = {
      1: {
        ...moving,
        issue: (i) => ({ ...moving.issue, labels: i === 0 ? moving.issue.labels : [] }),
      },
    };
    const { result } = await build(world, { blockedBy: edges(1) });
    expect(result.holds).toEqual([
      { issueNumber: 1, reason: 'changed_during_capture', detail: 'not_stack_ready' },
    ]);
  });

  test('a predecessor that stands still is captured, not held', async () => {
    const { result } = await build({ 1: predecessor(1) }, { blockedBy: edges(1) });
    expect(result.kind).toBe('captured');
  });

  // The predecessor SET is an eligibility input of its own, read at the top of a
  // capture that is many provider reads long. Re-reading only the predecessors
  // it already knew about would let a `captured` snapshot omit a direct
  // predecessor the refiner must see — or keep one the Issue no longer has.
  test('a `blocked by` edge added during capture holds, it does not ship', async () => {
    const world = { 1: predecessor(1), 2: predecessor(2) };
    const { result } = await build(world, {
      blockedBy: (i) => (i === 0 ? edges(1) : edges(1, 2)),
    });
    expect(result.kind).toBe('hold');
    expect(result.reason).toBe('predecessor_not_ready');
    // The set this attempt was made against, as for every other hold…
    expect(result.predecessorIssueNumbers).toEqual([1]);
    // …and the hold names what changed, and in which direction.
    expect(result.holds).toEqual([
      { issueNumber: 2, reason: 'changed_during_capture', detail: 'predecessor_added' },
    ]);
  });

  test('a `blocked by` edge removed during capture holds, it does not ship', async () => {
    const world = { 1: predecessor(1), 2: predecessor(2) };
    const { result } = await build(world, {
      blockedBy: (i) => (i === 0 ? edges(1, 2) : edges(1)),
    });
    expect(result.kind).toBe('hold');
    expect(result.predecessorIssueNumbers).toEqual([1, 2]);
    expect(result.holds).toEqual([
      { issueNumber: 2, reason: 'changed_during_capture', detail: 'predecessor_removed' },
    ]);
  });

  // Last, on purpose: the window this check cannot cover is the one after its
  // own read, and running it after the per-predecessor verification makes that
  // window as short as the module can make it.
  test('the relationship set is re-read after every other read, immediately before the seal', async () => {
    const { result, calls } = await build({ 1: predecessor(1) }, { blockedBy: edges(1) });
    expect(result.kind).toBe('captured');
    const methods = calls.map((c) => c[0]);
    expect(methods.filter((m) => m === 'getBlockedBy')).toHaveLength(2);
    expect(methods.lastIndexOf('getBlockedBy')).toBe(methods.length - 1);
  });

  test('a chain that disagrees only after capture hands off rather than shipping', async () => {
    const { result } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      chainAgreement: (i) =>
        i === 0 ? { kind: 'agrees' } : { kind: 'disagrees', detail: 'accepted revision moved' },
    });
    expect(result).toEqual({
      kind: 'handoff',
      reason: 'chain_disagreement',
      predecessorIssueNumbers: [1],
      detail: 'accepted revision moved',
    });
  });

  test('a failed re-read of the relationship set fails closed, it does not ship', async () => {
    const { result } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      blockedByThrows: (i) => (i === 0 ? undefined : 'relationship API 502'),
    });
    expect(result).toEqual({
      kind: 'failed',
      stage: 'blocked_by',
      issueNumber: 500,
      error: 'relationship API 502',
    });
  });
});

// ---------------------------------------------------------------------------
// §5 bounds
// ---------------------------------------------------------------------------

describe('issue-refinement snapshot — §5 bounded content', () => {
  test('every text field is truncated to the cap and the truncation is recorded', async () => {
    const long = 'x'.repeat(5000);
    const world = {
      1: predecessor(1, {
        issue: { title: long, body: long },
        pr: { title: long, body: long },
        comments: [{ id: 'c1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', body: long }],
      }),
    };
    const { result } = await build(world, {
      blockedBy: edges(1),
      limits: { maxSnapshotTextBytes: 100 },
      target: target({ title: long, body: long }),
      issuePlan: long,
    });
    const snap = result.snapshot;
    expect(snap.target.title).toHaveLength(100);
    expect(snap.target.body).toHaveLength(100);
    expect(snap.target.issuePlan).toHaveLength(100);
    expect(snap.predecessors[0].body).toHaveLength(100);
    expect(snap.predecessors[0].pullRequest.body).toHaveLength(100);
    expect(snap.predecessors[0].comments[0].body).toHaveLength(100);
    expect(snap.manifest.truncatedFields).toEqual([
      'target.title',
      'target.body',
      'target.sourceBody',
      'target.issuePlan',
      'predecessor.1.comment.c1.body',
      'predecessor.1.title',
      'predecessor.1.body',
      'predecessor.1.pr.title',
      'predecessor.1.pr.body',
    ]);
  });

  test('an over-cap field is truncated, never dropped and never kept in full', async () => {
    const { result } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      limits: { maxSnapshotTextBytes: 4 },
    });
    expect(result.snapshot.predecessors[0].body).toBe('Pred');
    expect(result.snapshot.predecessors[0].body.length).toBeGreaterThan(0);
  });

  test('the total is bounded, and the manifest states the bound it is under', async () => {
    const long = 'y'.repeat(9000);
    const world = {
      1: predecessor(1, { issue: { body: long }, pr: { body: long } }),
      2: predecessor(2, { issue: { body: long }, pr: { body: long } }),
    };
    const { result } = await build(world, { blockedBy: edges(1, 2), issuePlan: long });
    const m = result.snapshot.manifest;
    expect(m.totalTextBytes).toBeLessThanOrEqual(m.maxTotalTextBytes);
    expect(m.maxTotalTextBytes).toBe(
      refinementSnapshotByteBudget(ISSUE_REFINEMENT_DEFAULT_LIMITS, 2),
    );
    expect(m.capturedAt).toBe(NOW);
    expect(m.limits).toEqual(ISSUE_REFINEMENT_DEFAULT_LIMITS);
  });

  // The manifest defines its total as the bytes of every text field placed in
  // the snapshot's content — so the state literals stored directly beside the
  // captured prose (Issue/PR states, the §4 shape, review outcomes, dispute
  // lineage states, the managed-region shape, the version tag, the fingerprint)
  // are counted too, and the published bound has a term for each. A total that
  // skipped them would leave a snapshot at its caps over a bound it claimed.
  test('every text field in the snapshot content is charged to the manifest', async () => {
    const long = 'y'.repeat(9000);
    const withLineages = (n) =>
      predecessor(n, {
        issue: { body: long },
        pr: { body: long },
        review: {
          outcome: 'needs_fix',
          disputeLineages: [
            { state: 'resolved_fixed', count: 2 },
            { state: 'escalated_human', count: 1 },
          ],
        },
      });
    const { result } = await build(
      { 1: withLineages(1), 2: predecessor(2, { pr: { state: 'merged', mergeCommitSha: sha(7) } }) },
      { blockedBy: edges(1, 2), issuePlan: long },
    );
    const snapshot = result.snapshot;
    const { manifest, ...content } = snapshot;

    let counted = 0;
    const walk = (value) => {
      if (typeof value === 'string') counted += Buffer.byteLength(value, 'utf8');
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(content);

    expect(manifest.totalTextBytes).toBe(counted);
    expect(manifest.totalTextBytes).toBeLessThanOrEqual(manifest.maxTotalTextBytes);
  });

  // §11 of the dispute contract lists each state once, so two rows for one
  // state are one count reported in parts — merged rather than stored twice,
  // which is what keeps the stored literal list inside the byte budget's
  // per-predecessor term.
  test('duplicate dispute lineage rows are merged into one row per state', async () => {
    const { result } = await build(
      {
        1: predecessor(1, {
          review: {
            outcome: 'success',
            disputeLineages: [
              { state: 'resolved_fixed', count: 2 },
              { state: 'escalated_human', count: 1 },
              { state: 'resolved_fixed', count: 3 },
            ],
          },
        }),
      },
      { blockedBy: edges(1) },
    );
    expect(result.snapshot.predecessors[0].disputeLineages).toEqual([
      { state: 'resolved_fixed', count: 5 },
      { state: 'escalated_human', count: 1 },
    ]);
  });

  test('the comment window keeps the most recent, oldest first, whatever order the provider used', async () => {
    const comment = (id, at) => ({ id, createdAt: at, updatedAt: at, body: `body ${id}` });
    const world = {
      1: predecessor(1, {
        comments: [
          comment('e', '2026-08-05T00:00:00Z'),
          comment('a', '2026-08-01T00:00:00Z'),
          comment('d', '2026-08-04T00:00:00Z'),
          comment('b', '2026-08-02T00:00:00Z'),
          comment('c', '2026-08-03T00:00:00Z'),
        ],
      }),
    };
    const { result } = await build(world, {
      blockedBy: edges(1),
      limits: { maxCommentsPerPredecessor: 2 },
    });
    expect(result.snapshot.predecessors[0].comments.map((c) => c.id)).toEqual(['d', 'e']);
  });

  // A zero cap is a supported setting, and the byte budget allots no comment
  // bytes under it — so the window must be empty even when the adapter hands
  // back a full comment list regardless of the limit it was asked for.
  test('a zero comment cap captures no comments from an adapter that ignores it', async () => {
    const world = {
      1: predecessor(1, {
        comments: [
          { id: 'a', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', body: 'x'.repeat(400) },
          { id: 'b', createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z', body: 'y'.repeat(400) },
        ],
      }),
    };
    const { result } = await build(world, {
      blockedBy: edges(1),
      limits: { maxCommentsPerPredecessor: 0 },
    });
    expect(result.snapshot.predecessors[0].comments).toEqual([]);
    const m = result.snapshot.manifest;
    expect(m.totalTextBytes).toBeLessThanOrEqual(m.maxTotalTextBytes);
  });

  const unsortedPaths = [
    { path: 'src/z.ts', added: 1, removed: 0 },
    { path: 'src/a.ts', added: 2, removed: 3 },
    { path: 'src/m.ts', added: 0, removed: 4 },
  ];

  test('changed paths are sorted and carry counts only', async () => {
    const { result } = await build({ 1: predecessor(1, { paths: unsortedPaths }) }, {
      blockedBy: edges(1),
      limits: { maxChangedPathsPerPredecessor: 3 },
    });
    expect(result.snapshot.predecessors[0].changedPaths).toEqual([
      { path: 'src/a.ts', added: 2, removed: 3 },
      { path: 'src/m.ts', added: 0, removed: 4 },
      { path: 'src/z.ts', added: 1, removed: 0 },
    ]);
    expect(result.snapshot.predecessors[0].changedPathsCapped).toBe(false);
  });

  // Past the cap the surviving SUBSET is decided by the listing, not by the
  // core's sort — so a canonical listing keeps its first paths…
  test('an over-cap canonical listing keeps its first paths and records the cap', async () => {
    const { result } = await build(
      { 1: predecessor(1, { paths: [...unsortedPaths].sort((a, b) => (a.path < b.path ? -1 : 1)) }) },
      { blockedBy: edges(1), limits: { maxChangedPathsPerPredecessor: 2 } },
    );
    expect(result.snapshot.predecessors[0].changedPaths).toEqual([
      { path: 'src/a.ts', added: 2, removed: 3 },
      { path: 'src/m.ts', added: 0, removed: 4 },
    ]);
    expect(result.snapshot.predecessors[0].changedPathsCapped).toBe(true);
  });

  // …and a provider-ordered one is refused, because two adapters paging the same
  // PR in different orders would otherwise capture different subsets of it and
  // fingerprint the same PR contents differently.
  test('an over-cap non-canonical listing fails closed instead of capturing a provider-ordered subset', async () => {
    const { result } = await build({ 1: predecessor(1, { paths: unsortedPaths }) }, {
      blockedBy: edges(1),
      limits: { maxChangedPathsPerPredecessor: 2 },
    });
    expect(result.kind).toBe('failed');
    expect(result.stage).toBe('changed_paths');
    expect(result.issueNumber).toBe(1);
    expect(result.error).toContain('ascending by path');
  });

  // A listing that says it is COMPLETE chose no subset, so the provider's order
  // decides nothing: sorting and capping it lands on the PR's first paths from
  // any order. An adapter that returns whole lists must not have to sort them —
  // and must not lose refinement on every PR wider than the cap.
  test('an over-cap listing declared complete is sorted and capped instead of refused', async () => {
    const { result } = await build({ 1: predecessor(1, { paths: unsortedPaths }) }, {
      blockedBy: edges(1),
      limits: { maxChangedPathsPerPredecessor: 2 },
      changedPathsComplete: true,
    });
    expect(result.kind).toBe('captured');
    expect(result.snapshot.predecessors[0].changedPaths).toEqual([
      { path: 'src/a.ts', added: 2, removed: 3 },
      { path: 'src/m.ts', added: 0, removed: 4 },
    ]);
    expect(result.snapshot.predecessors[0].changedPathsCapped).toBe(true);
  });

  // The listing form is a claim, not a bypass: an adapter that reports a PAGE
  // still owes the canonical order past the cap.
  test('an over-cap listing that reports itself incomplete still fails closed', async () => {
    const { result } = await build({ 1: predecessor(1, { paths: unsortedPaths }) }, {
      blockedBy: edges(1),
      limits: { maxChangedPathsPerPredecessor: 2 },
      changedPathsComplete: false,
    });
    expect(result.kind).toBe('failed');
    expect(result.stage).toBe('changed_paths');
    expect(result.error).toContain('ascending by path');
  });

  // Two adapters reading the same PR — one sorting its page, one declaring its
  // provider-ordered list complete — must capture the same paths, so the same PR
  // contents cannot fingerprint two ways depending on which adapter is wired.
  test('a sorted page and a complete provider-ordered listing agree, paths and fingerprint', async () => {
    const limits = { maxChangedPathsPerPredecessor: 2 };
    const sorted = await build(
      { 1: predecessor(1, { paths: [...unsortedPaths].sort((a, b) => (a.path < b.path ? -1 : 1)) }) },
      { blockedBy: edges(1), limits },
    );
    const declared = await build({ 1: predecessor(1, { paths: unsortedPaths }) }, {
      blockedBy: edges(1),
      limits,
      changedPathsComplete: true,
    });
    expect(declared.result.snapshot.predecessors[0].changedPaths).toEqual(
      sorted.result.snapshot.predecessors[0].changedPaths,
    );
    expect(declared.result.snapshot.predecessorFingerprint).toBe(
      sorted.result.snapshot.predecessorFingerprint,
    );
  });

  test('a hostile head ref is bounded and charged like any other captured text', async () => {
    const longRef = `ai/${'r'.repeat(REFINEMENT_MAX_PR_IDENTITY_BYTES + 500)}`;
    const { result } = await build({ 1: predecessor(1, { pr: { headRefName: longRef } }) }, {
      blockedBy: edges(1),
    });
    const snap = result.snapshot;
    expect(snap.predecessors[0].pullRequest.headRefName).toHaveLength(
      REFINEMENT_MAX_PR_IDENTITY_BYTES,
    );
    expect(snap.manifest.truncatedFields).toContain('predecessor.1.pr.headRefName');
    // Charged to the ledger, so the published bound still covers the snapshot —
    // which is the whole point of routing it through the capture at all.
    expect(snap.manifest.totalTextBytes).toBeLessThanOrEqual(snap.manifest.maxTotalTextBytes);
  });

  // A comment's id and stamp are provider text on the same footing as the PR
  // identity strings, and they are agent-visible: left uncharged they would push
  // the snapshot past the total the manifest publishes.
  test('a hostile comment id and stamp are bounded and charged like any other captured text', async () => {
    const longId = 'i'.repeat(REFINEMENT_MAX_COMMENT_IDENTITY_BYTES + 500);
    const world = {
      1: predecessor(1, {
        comments: [
          {
            id: longId,
            createdAt: '2026-08-01T00:00:00Z',
            updatedAt: 'z'.repeat(REFINEMENT_MAX_COMMENT_IDENTITY_BYTES + 500),
            body: 'comment body',
          },
        ],
      }),
    };
    const { result } = await build(world, { blockedBy: edges(1) });
    const snap = result.snapshot;
    const captured = snap.predecessors[0].comments[0];
    expect(captured.id).toHaveLength(REFINEMENT_MAX_COMMENT_IDENTITY_BYTES);
    expect(captured.updatedAt).toHaveLength(REFINEMENT_MAX_COMMENT_IDENTITY_BYTES);
    // The id record is keyed by window position, because a truncated id cannot
    // name its own record; everything keyed BY the id uses the bounded one, so
    // the key never carries bytes the snapshot does not.
    expect(snap.manifest.truncatedFields).toContain('predecessor.1.comment.0.id');
    expect(snap.manifest.truncatedFields).toContain(
      `predecessor.1.comment.${captured.id}.updatedAt`,
    );
    expect(snap.manifest.totalTextBytes).toBeLessThanOrEqual(snap.manifest.maxTotalTextBytes);
  });

  // The identity strings are bounded by their own constant, deliberately not by
  // the prose cap: a truncated head SHA is not a shorter SHA, it is a wrong one,
  // and §15 persists these values as the predecessor's identity.
  test('a lowered prose cap bounds prose without corrupting the PR identity', async () => {
    const { result } = await build(
      { 1: predecessor(1, { pr: { state: 'merged', mergeCommitSha: sha(5) } }) },
      { blockedBy: edges(1), limits: { maxSnapshotTextBytes: 8 } },
    );
    const snap = result.snapshot;
    expect(snap.predecessors[0].pullRequest.headSha).toBe(sha(1));
    expect(snap.predecessors[0].pullRequest.mergeCommitSha).toBe(sha(5));
    expect(snap.predecessors[0].pullRequest.headRefName).toBe('ai/issue-1');
    expect(snap.predecessors[0].body).toHaveLength(8);
    // Same argument, same treatment for the comment identity strings: the prose
    // cap must not rewrite the id §5 keys a comment body by.
    expect(snap.predecessors[0].comments[0].id).toBe('c1-1');
    expect(snap.predecessors[0].comments[0].updatedAt).toBe('2026-08-01T00:00:00Z');
    expect(snap.manifest.totalTextBytes).toBeLessThanOrEqual(snap.manifest.maxTotalTextBytes);
  });

  // An adapter that honours the caller-supplied limit returns exactly the cap
  // both for a PR with `cap` paths and for one with more, so the core asks for
  // one extra as a truncation probe. Without it, a partial list would be
  // recorded — and hashed — as complete.
  test('a limit-honouring adapter still reports a truncated changed-path list', async () => {
    const paths = (...names) => names.map((path) => ({ path, added: 1, removed: 0 }));
    const kept = [
      { path: 'src/a.ts', added: 1, removed: 0 },
      { path: 'src/b.ts', added: 1, removed: 0 },
    ];

    const exact = await build({ 1: predecessor(1, { paths: paths('src/a.ts', 'src/b.ts') }) }, {
      blockedBy: edges(1),
      limits: { maxChangedPathsPerPredecessor: 2 },
      honorChangedPathLimit: true,
    });
    expect(exact.result.snapshot.predecessors[0].changedPaths).toEqual(kept);
    expect(exact.result.snapshot.predecessors[0].changedPathsCapped).toBe(false);

    const over = await build(
      { 1: predecessor(1, { paths: paths('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts') }) },
      {
        blockedBy: edges(1),
        limits: { maxChangedPathsPerPredecessor: 2 },
        honorChangedPathLimit: true,
      },
    );
    expect(over.result.snapshot.predecessors[0].changedPaths).toEqual(kept);
    expect(over.result.snapshot.predecessors[0].changedPathsCapped).toBe(true);
    expect(over.result.snapshot.predecessorFingerprint).not.toBe(
      exact.result.snapshot.predecessorFingerprint,
    );
  });

  test('local paths and credentials never reach the snapshot', async () => {
    const world = {
      1: predecessor(1, {
        issue: { body: 'built under /Users/someone/repo with key sk-abcdefghijklmnopqrstuvwx' },
      }),
    };
    const { result } = await build(world, { blockedBy: edges(1) });
    const body = result.snapshot.predecessors[0].body;
    expect(body).toBe('built under <path> with key [redacted]');
    // …and the head SHA, which is also a 40-hex run, survives untouched.
    expect(result.snapshot.predecessors[0].pullRequest.headSha).toBe(sha(1));
  });

  test('keyword-introduced credentials are redacted wherever untrusted text is captured', async () => {
    const secret = 'Authorization: Bearer abcdefghij0123456789 and token s3cr3t-value-here';
    const world = {
      1: predecessor(1, {
        issue: { body: secret },
        pr: { body: secret },
        comments: [
          { id: 'c1-1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', body: secret },
        ],
      }),
    };
    const { result } = await build(world, {
      blockedBy: edges(1),
      target: target({ body: secret }),
      issuePlan: secret,
    });
    const snap = result.snapshot;
    const redacted = 'Authorization: Bearer [redacted] and token [redacted]';
    for (const captured of [
      snap.target.body,
      snap.target.sourceBody,
      snap.target.issuePlan,
      snap.predecessors[0].body,
      snap.predecessors[0].pullRequest.body,
      snap.predecessors[0].comments[0].body,
    ]) {
      expect(captured).toBe(redacted);
    }
    // The 40-hex exception the whole snapshot is built on still holds: a bare
    // commit SHA carries no introducing keyword and survives in prose too.
    const { result: shaRun } = await build(
      { 1: predecessor(1, { issue: { body: `merged as ${sha(1)}` } }) },
      { blockedBy: edges(1) },
    );
    expect(shaRun.snapshot.predecessors[0].body).toBe(`merged as ${sha(1)}`);
  });

  test('the target label set is bounded by count and by length, and the cap is recorded', async () => {
    const many = Array.from({ length: REFINEMENT_MAX_TARGET_LABELS + 5 }, (_, i) =>
      `area:${String(i).padStart(3, '0')}`,
    );
    const { result } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      target: target({ labels: [...many, 'z'.repeat(REFINEMENT_MAX_TARGET_LABEL_BYTES + 50)] }),
    });
    const snap = result.snapshot;
    expect(snap.target.labels).toHaveLength(REFINEMENT_MAX_TARGET_LABELS);
    expect(snap.target.labels).toEqual(many.slice(0, REFINEMENT_MAX_TARGET_LABELS));
    expect(snap.target.labelsCapped).toBe(true);
    // Labels are inside the published bound, not alongside it.
    expect(snap.manifest.totalTextBytes).toBeLessThanOrEqual(snap.manifest.maxTotalTextBytes);
  });

  test('an over-long label is truncated and recorded like any other captured field', async () => {
    const long = 'l'.repeat(REFINEMENT_MAX_TARGET_LABEL_BYTES + 10);
    const { result } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      target: target({ labels: [long] }),
    });
    const snap = result.snapshot;
    expect(snap.target.labels).toEqual(['l'.repeat(REFINEMENT_MAX_TARGET_LABEL_BYTES)]);
    expect(snap.target.labelsCapped).toBe(true);
    expect(snap.manifest.truncatedFields).toContain('target.label.0');
  });

  // §6 excludes the two lane-owned labels from the hashed set by matching the
  // literal, and `MAX_SNAPSHOT_TEXT_BYTES` may be lowered to as little as 1 (§8).
  // A lane label cut down by that cap would no longer match, and step 5 of §11 —
  // the lane removing its own marker and adding the implementation status —
  // would invalidate the very snapshot it is applying.
  test('a lane-owned label is not cut by a lowered prose cap; every other label is', async () => {
    const cap = 20;
    const longArea = `area:${'x'.repeat(40)}`;
    expect(DEFAULT_REFINEMENT_MARKER_LABEL.length).toBeGreaterThan(cap);
    expect(IMPLEMENTATION_STATUS_LABEL.length).toBeGreaterThan(cap);
    // The two lane labels only diverge at byte 13, so a cap above that is what
    // makes their truncated forms differ — and the bug detectable.
    const run = (laneLabel) =>
      build({ 1: predecessor(1) }, {
        blockedBy: edges(1),
        limits: { maxSnapshotTextBytes: cap },
        target: target({ labels: [longArea, laneLabel] }),
      });
    const before = (await run(DEFAULT_REFINEMENT_MARKER_LABEL)).result.snapshot;
    const after = (await run(IMPLEMENTATION_STATUS_LABEL)).result.snapshot;
    expect(before.target.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
    expect(after.target.labels).toContain(IMPLEMENTATION_STATUS_LABEL);
    // The exception is scoped to the two labels §6 excludes: ordinary provider
    // text is still cut by the prose cap.
    expect(before.target.labels).toContain(longArea.slice(0, cap));
    // …and so the lane's own label transition is not a fingerprint change.
    expect(after.predecessorFingerprint).toBe(before.predecessorFingerprint);
  });

  // Two distinct over-long labels can share their retained prefix, and only one
  // of them survives the collapse. The manifest's byte total is documented as
  // the bytes of the fields placed in the snapshot, so the discarded one must
  // not be charged to it.
  test('a label discarded by a truncation collision is not charged to the manifest', async () => {
    const long = (suffix) => `${'l'.repeat(REFINEMENT_MAX_TARGET_LABEL_BYTES)}${suffix}`;
    const run = (labels) =>
      build({ 1: predecessor(1) }, { blockedBy: edges(1), target: target({ labels }) });
    const one = (await run([long('a')])).result.snapshot;
    const two = (await run([long('a'), long('b')])).result.snapshot;
    // Both retain the same single 256-byte prefix…
    expect(two.target.labels).toEqual(one.target.labels);
    expect(two.target.labels).toHaveLength(1);
    // …so the manifest reports the same total: it counts the bytes placed in the
    // snapshot, not the bytes offered to it.
    expect(two.manifest.totalTextBytes).toBe(one.manifest.totalTextBytes);
    expect(two.manifest.truncatedFields.filter((f) => f.startsWith('target.label.'))).toEqual([
      'target.label.0',
    ]);
    // The loss is still reported — a truncation is what caused the collapse.
    expect(two.target.labelsCapped).toBe(true);
  });

  test('a label set inside both bounds is not reported as capped', async () => {
    const { result } = await build({ 1: predecessor(1) }, { blockedBy: edges(1) });
    expect(result.snapshot.target.labelsCapped).toBe(false);
    expect(result.snapshot.manifest.truncatedFields).not.toContain('target.label.0');
  });

  test('boundSnapshotText never splits a code point', () => {
    // "😀" is four UTF-8 bytes; a five-byte cap must yield exactly one of them.
    expect(boundSnapshotText('😀😀', 5)).toEqual({ text: '😀', truncated: true });
    expect(boundSnapshotText('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(boundSnapshotText('abc', 0)).toEqual({ text: '', truncated: true });
  });
});

// ---------------------------------------------------------------------------
// §6 the fingerprint
// ---------------------------------------------------------------------------

describe('issue-refinement snapshot — §6 fingerprint', () => {
  const world = () => ({ 1: predecessor(1), 2: predecessor(2) });
  const capture = async (opts = {}) => {
    const { result } = await build(opts.world ?? world(), { blockedBy: edges(1, 2), ...opts });
    expect(result.kind).toBe('captured');
    return result.snapshot;
  };

  test('generation is deterministic: identical inputs give an identical snapshot', async () => {
    const a = await capture();
    const b = await capture();
    expect(b.predecessorFingerprint).toBe(a.predecessorFingerprint);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test('the wall clock is not an input', async () => {
    const a = await capture();
    const b = await capture({ now: '2027-01-01T00:00:00.000Z' });
    expect(b.predecessorFingerprint).toBe(a.predecessorFingerprint);
  });

  test('provider listing order is not an input', async () => {
    const paths = [
      { path: 'src/a.ts', added: 1, removed: 0 },
      { path: 'src/b.ts', added: 2, removed: 4 },
    ];
    const ordered = { 1: predecessor(1, { paths }), 2: predecessor(2) };
    const shuffled = { 1: predecessor(1, { paths: [...paths].reverse() }), 2: predecessor(2) };
    const a = await build(ordered, { blockedBy: edges(1, 2) });
    const b = await build(shuffled, { blockedBy: edges(2, 1) });
    expect(a.result.kind).toBe('captured');
    expect(b.result.snapshot.predecessorFingerprint).toBe(
      a.result.snapshot.predecessorFingerprint,
    );
  });

  // Comments are an ordered capture window; dispute lineages are state/count
  // summaries, so their array order carries no review evidence and must not
  // carry a fingerprint either.
  test('a re-ordered dispute lineage report is not a change', async () => {
    const lineages = [
      { state: 'resolved_fixed', count: 2 },
      { state: 'escalated_human', count: 1 },
    ];
    const withLineages = (order) => ({
      1: predecessor(1, { review: { outcome: 'success', disputeLineages: order } }),
    });
    const ordered = await capture({ world: withLineages(lineages), blockedBy: edges(1) });
    const shuffled = await capture({
      world: withLineages([...lineages].reverse()),
      blockedBy: edges(1),
    });
    expect(shuffled.predecessorFingerprint).toBe(ordered.predecessorFingerprint);
    // Stored in the protocol's own state order, not the provider's.
    expect(shuffled.predecessors[0].disputeLineages).toEqual(lineages);
  });

  test('the fingerprint is recomputable from the stored snapshot', async () => {
    const snap = await capture();
    expect(computePredecessorFingerprint(snap.target, snap.predecessors, LANE_LABELS)).toBe(
      snap.predecessorFingerprint,
    );
  });

  test.each([
    ['a predecessor head SHA', { 1: predecessor(1, { pr: { headSha: sha(6) } }), 2: predecessor(2) }],
    [
      'a predecessor merging',
      { 1: predecessor(1, { pr: { state: 'merged', mergeCommitSha: sha(5) } }), 2: predecessor(2) },
    ],
    ['a predecessor Issue body', { 1: predecessor(1, { issue: { body: 'rewritten' } }), 2: predecessor(2) }],
    ['a predecessor Issue title', { 1: predecessor(1, { issue: { title: 'renamed' } }), 2: predecessor(2) }],
    ['a predecessor PR body', { 1: predecessor(1, { pr: { body: 'rewritten' } }), 2: predecessor(2) }],
    ['a changed-path count', { 1: predecessor(1, { paths: [{ path: 'src/p1.ts', added: 4, removed: 1 }] }), 2: predecessor(2) }],
    ['a review outcome', { 1: predecessor(1, { review: { outcome: 'needs_fix' } }), 2: predecessor(2) }],
    [
      'a dispute lineage count',
      { 1: predecessor(1, { review: { outcome: 'success', disputeLineages: [{ state: 'resolved_fixed', count: 2 }] } }), 2: predecessor(2) },
    ],
    [
      'an edited comment',
      {
        1: predecessor(1, {
          comments: [
            { id: 'c1-1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z', body: 'comment 1-1' },
          ],
        }),
        2: predecessor(2),
      },
    ],
    ['a predecessor dropping out', { 1: predecessor(1) }],
  ])('%s moves the fingerprint', async (_name, changed) => {
    const base = await capture();
    const { result } = await build(changed, { blockedBy: edges(...Object.keys(changed).map(Number)) });
    expect(result.kind).toBe('captured');
    expect(result.snapshot.predecessorFingerprint).not.toBe(base.predecessorFingerprint);
  });

  test('the target Issue title, body, labels, and issue-plan all participate', async () => {
    const base = await capture();
    const moved = await Promise.all([
      capture({ target: target({ title: 'Renamed' }) }),
      capture({ target: target({ body: 'Rewritten' }) }),
      capture({ target: target({ labels: ['agent:claude', DEFAULT_REFINEMENT_MARKER_LABEL, 'complexity:high'] }) }),
      capture({ issuePlan: 'decision: use the injected seam' }),
    ]);
    for (const snap of moved) {
      expect(snap.predecessorFingerprint).not.toBe(base.predecessorFingerprint);
    }
    expect(new Set(moved.map((s) => s.predecessorFingerprint)).size).toBe(4);
  });

  // The captured evidence is identical in both runs; only the "there was more"
  // flag moves. It is agent-visible, so it has to move the fingerprint too —
  // otherwise a draft written when the list was complete stays valid after the
  // list silently became partial.
  test('a changed-path list that grows past its cap moves the fingerprint', async () => {
    const paths = [
      { path: 'src/a.ts', added: 1, removed: 0 },
      { path: 'src/b.ts', added: 2, removed: 4 },
    ];
    const limits = { maxChangedPathsPerPredecessor: 2 };
    const uncapped = await capture({
      world: { 1: predecessor(1, { paths }) },
      limits,
      blockedBy: edges(1),
    });
    const capped = await capture({
      world: { 1: predecessor(1, { paths: [...paths, { path: 'src/z.ts', added: 9, removed: 9 }] }) },
      limits,
      blockedBy: edges(1),
    });
    expect(capped.predecessors[0].changedPaths).toEqual(uncapped.predecessors[0].changedPaths);
    expect(uncapped.predecessors[0].changedPathsCapped).toBe(false);
    expect(capped.predecessors[0].changedPathsCapped).toBe(true);
    expect(capped.predecessorFingerprint).not.toBe(uncapped.predecessorFingerprint);
  });

  test('a label set that grows past its cap moves the fingerprint', async () => {
    const labels = Array.from({ length: REFINEMENT_MAX_TARGET_LABELS }, (_, i) =>
      `area:${String(i).padStart(3, '0')}`,
    );
    const uncapped = await capture({ target: target({ labels }) });
    const capped = await capture({ target: target({ labels: [...labels, 'zzz:overflow'] }) });
    expect(capped.target.labels).toEqual(uncapped.target.labels);
    expect(uncapped.target.labelsCapped).toBe(false);
    expect(capped.target.labelsCapped).toBe(true);
    expect(capped.predecessorFingerprint).not.toBe(uncapped.predecessorFingerprint);
  });

  test('a lowered truncation cap is itself a fingerprint change', async () => {
    const base = await capture();
    const lowered = await capture({ limits: { maxSnapshotTextBytes: 8 } });
    expect(lowered.predecessorFingerprint).not.toBe(base.predecessorFingerprint);
  });

  test('the two lane-owned labels are excluded — step 5 cannot invalidate the attempt', async () => {
    const base = await capture();
    const afterTransition = await capture({
      target: target({ labels: ['agent:claude', IMPLEMENTATION_STATUS_LABEL] }),
    });
    expect(afterTransition.predecessorFingerprint).toBe(base.predecessorFingerprint);
  });

  test('the managed region is excluded — the lane’s own body write cannot invalidate it', async () => {
    const withRegion = (inner) =>
      target({
        body: [
          'Downstream body',
          '',
          '<!-- ai-refinement:begin fingerprint=abc123abc123 -->',
          inner,
          '<!-- ai-refinement:end -->',
        ].join('\n'),
      });
    const plain = await capture();
    const first = await capture({ target: withRegion('### Refined contract\nfirst') });
    const second = await capture({ target: withRegion('### Refined contract\nsecond') });

    // Appending a region for the first time does not move it, and rewriting the
    // region does not move it either.
    expect(first.predecessorFingerprint).toBe(plain.predecessorFingerprint);
    expect(second.predecessorFingerprint).toBe(plain.predecessorFingerprint);
    // …but the agents still see the current body and the region's state (§5).
    expect(second.target.managedRegion).toBe('present');
    expect(second.target.body).toContain('second');
    expect(second.target.sourceBody).toBe('Downstream body');
  });

  test('an edit OUTSIDE the region still moves it', async () => {
    const base = await capture({
      target: target({
        body: 'Downstream body\n\n<!-- ai-refinement:begin fingerprint=abc123abc123 -->\nr\n<!-- ai-refinement:end -->',
      }),
    });
    const edited = await capture({
      target: target({
        body: 'Downstream body, amended\n\n<!-- ai-refinement:begin fingerprint=abc123abc123 -->\nr\n<!-- ai-refinement:end -->',
      }),
    });
    expect(edited.predecessorFingerprint).not.toBe(base.predecessorFingerprint);
  });

  test('a malformed region is reported, never repaired', async () => {
    const snap = await capture({
      target: target({ body: 'Downstream body\n<!-- ai-refinement:end -->' }),
    });
    expect(snap.target.managedRegion).toBe('malformed');
  });

  // A malformed body is stored UNELIDED, and the §5 cut can leave behind a
  // prefix that reads as one well-formed region. The digest is taken over the
  // source body as stored, never by scanning it a second time — a second
  // elision would drop bytes the agents were handed, and edits to them would
  // stop moving the fingerprint the staleness check depends on.
  test('content the agents received inside a truncated malformed region still moves it', async () => {
    const region = (content) =>
      [
        '<!-- ai-refinement:begin fingerprint=abc123abc123 -->',
        content,
        '<!-- ai-refinement:end -->',
      ].join('\n');
    // Two begin markers: malformed, so the whole body is the source body…
    const body = (content) =>
      [
        'Downstream body',
        region(content),
        '<!-- ai-refinement:begin fingerprint=def456def456 -->',
      ].join('\n');
    // …and the cap lands exactly after the first region's end marker, so what
    // survives the cut is a single well-formed-looking region.
    const kept = (content) => ['Downstream body', region(content)].join('\n');
    const first = 'AGENT VISIBLE CONTENT';
    const second = 'AGENT VISIBLE REWRITE';
    const maxSnapshotTextBytes = Buffer.byteLength(kept(first), 'utf8');
    expect(Buffer.byteLength(kept(second), 'utf8')).toBe(maxSnapshotTextBytes);

    const run = (content) =>
      capture({ target: target({ body: body(content) }), limits: { maxSnapshotTextBytes } });
    const a = await run(first);
    const b = await run(second);

    expect(a.target.managedRegion).toBe('malformed');
    // The agents see the region's content, so §6 must cover it.
    expect(a.target.sourceBody).toBe(kept(first));
    expect(b.target.sourceBody).toBe(kept(second));
    expect(b.predecessorFingerprint).not.toBe(a.predecessorFingerprint);
  });
});

// ---------------------------------------------------------------------------
// The lane's prohibitions
// ---------------------------------------------------------------------------

describe('issue-refinement snapshot — read-only by construction', () => {
  test('capture touches reads only: no AI call, no body write, no relationship edit', async () => {
    const { result, calls } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      chainAgreement: { kind: 'agrees' },
    });
    expect(result.kind).toBe('captured');
    const methods = new Set(calls.map((c) => c[0]));
    expect([...methods].sort()).toEqual([
      'getBlockedBy',
      'readChainAgreement',
      'readChangedPaths',
      'readIssue',
      'readIssueComments',
      'readIssuePlan',
      'readPullRequest',
      'readReviewSummary',
    ]);
  });

  test('the changed-path read is capped at the source, not only after it', async () => {
    const { calls } = await build({ 1: predecessor(1) }, {
      blockedBy: edges(1),
      limits: { maxChangedPathsPerPredecessor: 7, maxCommentsPerPredecessor: 3 },
    });
    // One over the cap: the extra entry is the truncation probe, never captured.
    expect(calls).toContainEqual(['readChangedPaths', 901, 8]);
    expect(calls).toContainEqual(['readIssueComments', 1, 3]);
  });
});
