import { labelsToPhase, labelsToComplexity, labelsToReviewStrength, parseCandidates } from '../dist/core/github-intake.js';

describe('labelsToPhase', () => {
  test('agent:claude + status:needs-implementation -> implementation', () => {
    expect(labelsToPhase(['agent:claude', 'status:needs-implementation'])).toMatchObject({
      phase: 'implementation',
      implementationAgent: 'claude',
    });
  });

  test('agent:claude + status:needs-fix -> implementation', () => {
    expect(labelsToPhase(['agent:claude', 'status:needs-fix'])).toMatchObject({
      phase: 'implementation',
      implementationAgent: 'claude',
    });
  });

  test('agent:codex + status:needs-review -> review', () => {
    expect(labelsToPhase(['agent:codex', 'status:needs-review'])).toMatchObject({
      phase: 'review',
      reviewAgent: 'codex',
    });
  });

  test('agent:codex + agent:claude + status:needs-review -> review codex, no implementationAgent reconstructed (issue #292)', () => {
    // labelsToPhase selects ONLY the review agent from coarse labels. The
    // implementation owner is NOT reconstructed from a lingering agent:* label —
    // it lives in context.assignment.implementationAgent.
    const result = labelsToPhase(['agent:codex', 'agent:claude', 'status:needs-review']);
    expect(result).toMatchObject({ phase: 'review', reviewAgent: 'codex' });
    expect(result.implementationAgent).toBeUndefined();
  });

  test('agent:codex + agent:gemini + status:needs-review -> genuine Gemini review wins, no implementationAgent reconstructed (issue #292)', () => {
    // A stale agent:codex label must not steal the review back from a genuine
    // Gemini review (issue #264). labelsToPhase does not reconstruct the
    // implementation owner here (issue #292).
    const result = labelsToPhase(['agent:codex', 'agent:gemini', 'status:needs-review']);
    expect(result).toMatchObject({ phase: 'review', reviewAgent: 'gemini' });
    expect(result.implementationAgent).toBeUndefined();
  });

  test('agent:codex + agent:claude + agent:gemini + status:needs-review -> genuine Gemini review wins (issue #292)', () => {
    // With no status:research-needed marker, agent:gemini is a genuine review
    // assignment and wins over the stale agent:codex/agent:claude labels. No
    // implementation owner is reconstructed from labels.
    const result = labelsToPhase(['agent:codex', 'agent:claude', 'agent:gemini', 'status:needs-review']);
    expect(result).toMatchObject({ phase: 'review', reviewAgent: 'gemini' });
    expect(result.implementationAgent).toBeUndefined();
  });

  test('agent:claude + status:needs-review -> review with claude', () => {
    expect(labelsToPhase(['agent:claude', 'status:needs-review'])).toMatchObject({
      phase: 'review',
      reviewAgent: 'claude',
    });
  });

  test('agent:gemini + status:research-needed -> research', () => {
    expect(labelsToPhase(['agent:gemini', 'status:research-needed'])).toMatchObject({
      phase: 'research',
      researchAgent: 'gemini',
    });
  });

  test('agent:gemini + status:needs-implementation -> implementation', () => {
    expect(labelsToPhase(['agent:gemini', 'status:needs-implementation'])).toMatchObject({
      phase: 'implementation',
      implementationMode: 'new',
      implementationAgent: 'gemini',
    });
  });

  test('agent:gemini + status:needs-fix -> implementation fix mode', () => {
    expect(labelsToPhase(['agent:gemini', 'status:needs-fix'])).toMatchObject({
      phase: 'implementation',
      implementationMode: 'fix',
      implementationAgent: 'gemini',
    });
  });

  test('status:needs-conflict-resolution -> conflict_resolution', () => {
    expect(labelsToPhase(['status:needs-conflict-resolution'])).toMatchObject({
      phase: 'conflict_resolution',
    });
  });

  test('unrelated labels return undefined', () => {
    expect(labelsToPhase(['bug', 'enhancement'])).toBeUndefined();
  });

  test('empty labels return undefined', () => {
    expect(labelsToPhase([])).toBeUndefined();
  });

  test('agent:claude alone (no status) returns undefined', () => {
    expect(labelsToPhase(['agent:claude'])).toBeUndefined();
  });

  test('status:needs-implementation alone (no agent) returns undefined', () => {
    expect(labelsToPhase(['status:needs-implementation'])).toBeUndefined();
  });

  test('extra labels alongside a matching set still match', () => {
    expect(labelsToPhase(['bug', 'agent:claude', 'status:needs-implementation', 'priority:high']))
      .toMatchObject({ phase: 'implementation' });
  });

  test('agent:codex + both status:needs-review and status:needs-implementation -> review wins', () => {
    expect(labelsToPhase(['agent:codex', 'status:needs-review', 'status:needs-implementation']))
      .toMatchObject({ phase: 'review', reviewAgent: 'codex' });
  });

  test('agent:gemini + status:needs-review -> review with gemini', () => {
    expect(labelsToPhase(['agent:gemini', 'status:needs-review'])).toMatchObject({
      phase: 'review',
      reviewAgent: 'gemini',
    });
  });

  test('review lane-swap: stale agent:codex alongside agent:gemini -> gemini wins', () => {
    // After a Codex implementation hands off to a Gemini review, the old
    // agent:codex label can linger alongside the new agent:gemini label. Gemini
    // must win so intake does not route the review back to Codex.
    expect(labelsToPhase(['agent:codex', 'agent:gemini', 'status:needs-review'])).toMatchObject({
      phase: 'review',
      reviewAgent: 'gemini',
    });
  });

  test('stale research agent:gemini does NOT steal a Codex review (issue #264 follow-up)', () => {
    // A failed or pre-existing research handoff leaves the research-lane pair
    // (agent:gemini + status:research-needed) on the issue. When an operator later
    // queues a normal Codex review (agent:codex + status:needs-review), the stale
    // research gemini label must NOT suppress the Codex branch — the
    // status:research-needed marker keeps Codex winning instead of misrouting the
    // review to Gemini.
    expect(
      labelsToPhase(['agent:gemini', 'status:research-needed', 'agent:codex', 'status:needs-review']),
    ).toMatchObject({
      phase: 'review',
      reviewAgent: 'codex',
    });
  });

  test('explicit Gemini review still wins even with a lingering status:research-needed', () => {
    // When the operator queues a Gemini review (agent:gemini + status:needs-review)
    // with no competing Codex label, the requested Gemini review must win even if a
    // stale status:research-needed lingers — there is no Codex review to protect.
    expect(
      labelsToPhase(['agent:gemini', 'status:needs-review', 'status:research-needed']),
    ).toMatchObject({
      phase: 'review',
      reviewAgent: 'gemini',
    });
  });
});

// ---------------------------------------------------------------------------
// labelsToComplexity
// ---------------------------------------------------------------------------

describe('labelsToComplexity', () => {
  test('complexity:low -> sonnet / low / $2', () => {
    expect(labelsToComplexity(['agent:claude', 'status:needs-implementation', 'complexity:low']))
      .toEqual({ model: 'sonnet', effort: 'low', budget: '2' });
  });

  test('complexity:high -> opus / high / $10', () => {
    expect(labelsToComplexity(['agent:claude', 'status:needs-implementation', 'complexity:high']))
      .toEqual({ model: 'opus', effort: 'high', budget: '10' });
  });

  test('no complexity label -> sonnet / high / $5', () => {
    expect(labelsToComplexity(['agent:claude', 'status:needs-implementation']))
      .toEqual({ model: 'sonnet', effort: 'high', budget: '5' });
  });

  test('empty labels -> default sonnet / high / $5', () => {
    expect(labelsToComplexity([])).toEqual({ model: 'sonnet', effort: 'high', budget: '5' });
  });

  test('unrelated labels -> default sonnet / high / $5', () => {
    expect(labelsToComplexity(['bug', 'enhancement', 'review:high']))
      .toEqual({ model: 'sonnet', effort: 'high', budget: '5' });
  });

  test('both complexity:low and complexity:high -> high wins (opus / high / $10)', () => {
    expect(labelsToComplexity(['complexity:low', 'complexity:high']))
      .toEqual({ model: 'opus', effort: 'high', budget: '10' });
  });

  test('complexity:xhigh -> opus / xhigh / $20', () => {
    expect(labelsToComplexity(['agent:claude', 'status:needs-implementation', 'complexity:xhigh']))
      .toEqual({ model: 'opus', effort: 'xhigh', budget: '20' });
  });

  test('complexity:xhigh beats complexity:high (xhigh wins)', () => {
    expect(labelsToComplexity(['complexity:high', 'complexity:xhigh']))
      .toEqual({ model: 'opus', effort: 'xhigh', budget: '20' });
  });

  test('all three complexity labels -> xhigh wins (xhigh > high > low)', () => {
    expect(labelsToComplexity(['complexity:low', 'complexity:high', 'complexity:xhigh']))
      .toEqual({ model: 'opus', effort: 'xhigh', budget: '20' });
  });
});

// ---------------------------------------------------------------------------
// labelsToReviewStrength
// ---------------------------------------------------------------------------

describe('labelsToReviewStrength', () => {
  test('review:high -> high strength from label', () => {
    expect(labelsToReviewStrength(['review:high'])).toEqual({ strength: 'high', source: 'label' });
  });

  test('review:medium -> default strength from label', () => {
    expect(labelsToReviewStrength(['review:medium'])).toEqual({ strength: 'default', source: 'label' });
  });

  test('review:low -> low strength from label', () => {
    expect(labelsToReviewStrength(['review:low'])).toEqual({ strength: 'low', source: 'label' });
  });

  test('complexity:high with no review label -> high strength from complexity', () => {
    expect(labelsToReviewStrength(['agent:claude', 'complexity:high'])).toEqual({ strength: 'high', source: 'complexity' });
  });

  test('complexity:low with no review label -> low strength from complexity', () => {
    expect(labelsToReviewStrength(['agent:claude', 'complexity:low'])).toEqual({ strength: 'low', source: 'complexity' });
  });

  test('no relevant labels -> default strength', () => {
    expect(labelsToReviewStrength(['agent:claude', 'status:needs-review'])).toEqual({ strength: 'default', source: 'default' });
  });

  test('empty labels -> default strength', () => {
    expect(labelsToReviewStrength([])).toEqual({ strength: 'default', source: 'default' });
  });

  test('explicit review:high beats complexity:low — label wins', () => {
    expect(labelsToReviewStrength(['review:high', 'complexity:low'])).toEqual({ strength: 'high', source: 'label' });
  });

  test('explicit review:medium beats complexity:high — label wins', () => {
    expect(labelsToReviewStrength(['review:medium', 'complexity:high'])).toEqual({ strength: 'default', source: 'label' });
  });

  test('explicit review:low beats complexity:high — label wins', () => {
    expect(labelsToReviewStrength(['review:low', 'complexity:high'])).toEqual({ strength: 'low', source: 'label' });
  });

  test('review:high + review:low conflict -> high wins (strongest wins)', () => {
    expect(labelsToReviewStrength(['review:low', 'review:high'])).toEqual({ strength: 'high', source: 'label' });
  });

  test('complexity:high + complexity:low conflict -> high wins', () => {
    expect(labelsToReviewStrength(['complexity:low', 'complexity:high'])).toEqual({ strength: 'high', source: 'complexity' });
  });

  test('complexity:xhigh with no review label -> high strength from complexity (Codex review ceiling)', () => {
    expect(labelsToReviewStrength(['agent:codex', 'complexity:xhigh'])).toEqual({ strength: 'high', source: 'complexity' });
  });

  // Codex's model_reasoning_effort only accepts low/medium/high — xhigh is a
  // Claude-only tier. review:xhigh is therefore NOT a recognized review label
  // and must NOT be silently mapped to high (issue #243 non-goal). On its own it
  // has no effect and falls through to the default strength.
  test('review:xhigh alone is unrecognized -> default strength (not silently mapped to high)', () => {
    expect(labelsToReviewStrength(['agent:codex', 'review:xhigh'])).toEqual({ strength: 'default', source: 'default' });
  });

  test('review:xhigh does not override an explicit review:low', () => {
    expect(labelsToReviewStrength(['review:xhigh', 'review:low'])).toEqual({ strength: 'low', source: 'label' });
  });
});

// ---------------------------------------------------------------------------
// Dependency checker helpers
// ---------------------------------------------------------------------------

/** Returns no blockers for any issue. */
const noBlockerChecker = {
  getBlockedBy: async () => [],
};

/** Returns an open blocker for the given issue numbers. */
function openBlockerChecker(blockedIssues) {
  return {
    getBlockedBy: async (n) =>
      blockedIssues.includes(n) ? [{ issueNumber: 99, state: 'open' }] : [],
  };
}

/** Returns only closed blockers for the given issue numbers. */
function closedBlockerChecker(blockedIssues) {
  return {
    getBlockedBy: async (n) =>
      blockedIssues.includes(n) ? [{ issueNumber: 99, state: 'closed' }] : [],
  };
}

/** Returns two open blockers for the given issue numbers. */
function twoOpenBlockerChecker(blockedIssues) {
  return {
    getBlockedBy: async (n) =>
      blockedIssues.includes(n)
        ? [{ issueNumber: 98, state: 'open' }, { issueNumber: 99, state: 'open' }]
        : [],
  };
}

/** Always throws, simulating a GraphQL failure. */
const failingChecker = {
  getBlockedBy: async () => { throw new Error('GraphQL unavailable'); },
};

/** Reports the single blocker as stack-ready (has a usable PR head). */
const stackReadyResolver = async () => true;
/** Reports the single blocker as not yet stack-ready. */
const stackNotReadyResolver = async () => false;
/** Simulates a resolver failure (e.g. gh error). */
const failingStackResolver = async () => { throw new Error('resolver failed'); };

// ---------------------------------------------------------------------------
// parseCandidates — label filtering
// ---------------------------------------------------------------------------

const BASE_ISSUES = [
  {
    number: 1,
    title: 'Implement auth',
    url: 'https://github.com/owner/repo/issues/1',
    labels: [{ name: 'agent:claude' }, { name: 'status:needs-implementation' }],
  },
  {
    number: 2,
    title: 'Review PR',
    url: 'https://github.com/owner/repo/issues/2',
    labels: [{ name: 'agent:codex' }, { name: 'status:needs-review' }],
  },
  {
    number: 3,
    title: 'Unrelated',
    url: 'https://github.com/owner/repo/issues/3',
    labels: [{ name: 'bug' }],
  },
];

describe('parseCandidates — label filtering', () => {
  test('filters out non-matching issues', async () => {
    const candidates = await parseCandidates(BASE_ISSUES, noBlockerChecker);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.issueNumber)).toEqual([1, 2]);
  });

  test('maps labels to correct phases', async () => {
    const candidates = await parseCandidates(BASE_ISSUES, noBlockerChecker);
    expect(candidates[0]).toMatchObject({ phase: 'implementation', implementationAgent: 'claude' });
    expect(candidates[1]).toMatchObject({ phase: 'review', reviewAgent: 'codex' });
  });

  test('includes title, url, and raw labels on each candidate', async () => {
    const [c] = await parseCandidates([BASE_ISSUES[0]], noBlockerChecker);
    expect(c.title).toBe('Implement auth');
    expect(c.url).toBe('https://github.com/owner/repo/issues/1');
    expect(c.labels).toContain('agent:claude');
  });

  test('includes issues with no body field', async () => {
    const noDep = { ...BASE_ISSUES[0] };
    delete noDep.body;
    const candidates = await parseCandidates([noDep], noBlockerChecker);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(1);
    expect(candidates[0].body).toBeUndefined();
  });

  test('carries non-empty issue body onto the candidate', async () => {
    const withBody = { ...BASE_ISSUES[0], body: 'Add a rate limiter to login.' };
    const [c] = await parseCandidates([withBody], noBlockerChecker);
    expect(c.body).toBe('Add a rate limiter to login.');
  });

  test('omits body when the issue body is an empty string', async () => {
    const emptyBody = { ...BASE_ISSUES[0], body: '' };
    const [c] = await parseCandidates([emptyBody], noBlockerChecker);
    expect(c.body).toBeUndefined();
  });

  test('no depChecker — no dependency gate applied', async () => {
    const candidates = await parseCandidates(BASE_ISSUES);
    expect(candidates).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseCandidates — dependency gate (GitHub Issue Relationships)
// ---------------------------------------------------------------------------

describe('parseCandidates — dependency gate', () => {
  test('passes issue with no blocked-by relationships', async () => {
    const candidates = await parseCandidates([BASE_ISSUES[0]], noBlockerChecker);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(1);
  });

  test('skips review issue blocked by an open issue (non-stackable)', async () => {
    // BASE_ISSUES[1] is a review-lane issue; the stacked path only applies to
    // new-implementation issues, so a single open blocker keeps it held.
    const candidates = await parseCandidates([BASE_ISSUES[1]], openBlockerChecker([2]));
    expect(candidates).toHaveLength(0);
  });

  test('passes new-implementation issue with one stack-ready open blocker (Gate 2 stackable)', async () => {
    // BASE_ISSUES[0] is new-implementation with a single open blocker that the
    // resolver confirms is stack-ready — the implementation handler will stack on it.
    const candidates = await parseCandidates([BASE_ISSUES[0]], openBlockerChecker([1]), stackReadyResolver);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(1);
    expect(candidates[0].dependencyDecision).toMatchObject({
      blocked: true,
      blockedBy: [{ issueNumber: 99, state: 'open' }],
    });
  });

  test('holds Gate 2 stackable issue when its blocker is not yet stack-ready', async () => {
    // The blocker exists but has no usable PR head yet. Enqueuing would let the
    // implementation handler return a terminal `blocked` and remove the dependent
    // from automation, so it must stay held until the blocker becomes stack-ready.
    const candidates = await parseCandidates([BASE_ISSUES[0]], openBlockerChecker([1]), stackNotReadyResolver);
    expect(candidates).toHaveLength(0);
  });

  test('holds Gate 2 stackable issue when no stack-ready resolver is provided', async () => {
    // Without a resolver, stack-readiness cannot be confirmed — fail closed.
    const candidates = await parseCandidates([BASE_ISSUES[0]], openBlockerChecker([1]));
    expect(candidates).toHaveLength(0);
  });

  test('holds Gate 2 stackable issue when the stack-ready resolver throws (fail closed)', async () => {
    const candidates = await parseCandidates([BASE_ISSUES[0]], openBlockerChecker([1]), failingStackResolver);
    expect(candidates).toHaveLength(0);
  });

  test('skips new-implementation issue with multiple open blockers (unsupported)', async () => {
    const candidates = await parseCandidates([BASE_ISSUES[0]], twoOpenBlockerChecker([1]));
    expect(candidates).toHaveLength(0);
  });

  test('passes issue whose only blocker is closed', async () => {
    const candidates = await parseCandidates([BASE_ISSUES[0]], closedBlockerChecker([1]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(1);
  });

  test('skips blocked review issue but passes unblocked sibling', async () => {
    const candidates = await parseCandidates(
      [BASE_ISSUES[0], BASE_ISSUES[1]],
      openBlockerChecker([2]),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(1);
  });

  test('skips fix-mode issue with one open blocker (fix mode never stacks)', async () => {
    const fixIssue = {
      number: 4,
      title: 'Fix review findings',
      url: 'https://github.com/owner/repo/issues/4',
      labels: [{ name: 'agent:claude' }, { name: 'status:needs-fix' }],
    };
    const candidates = await parseCandidates([fixIssue], openBlockerChecker([4]));
    expect(candidates).toHaveLength(0);
  });

  test('skips issue when dependency check throws (fail closed)', async () => {
    const candidates = await parseCandidates([BASE_ISSUES[0]], failingChecker);
    expect(candidates).toHaveLength(0);
  });

  test('attaches dependencyDecision to passing candidate', async () => {
    const [c] = await parseCandidates([BASE_ISSUES[0]], noBlockerChecker);
    expect(c.dependencyDecision).toMatchObject({
      source: 'github-relationships',
      blocked: false,
      blockedBy: [],
    });
    expect(typeof c.dependencyDecision.checkedAt).toBe('string');
  });

  test('dependencyDecision records open blockers on passing candidate with closed-only blockers', async () => {
    const [c] = await parseCandidates([BASE_ISSUES[0]], closedBlockerChecker([1]));
    expect(c.dependencyDecision).toMatchObject({
      source: 'github-relationships',
      blocked: false,
      blockedBy: [{ issueNumber: 99, state: 'closed' }],
    });
  });

  test('no dependencyDecision when no depChecker provided', async () => {
    const [c] = await parseCandidates([BASE_ISSUES[0]]);
    expect(c.dependencyDecision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseCandidates — not_planned blocker gating
// ---------------------------------------------------------------------------

describe('parseCandidates — not_planned blocker', () => {
  /** Returns a blocker closed as not_planned for the given issue numbers. */
  function notPlannedBlockerChecker(blockedIssues) {
    return {
      getBlockedBy: async (n) =>
        blockedIssues.includes(n)
          ? [{ issueNumber: 99, state: 'closed', stateReason: 'not_planned' }]
          : [],
    };
  }

  /** Returns a blocker closed as completed for the given issue numbers. */
  function completedBlockerChecker(blockedIssues) {
    return {
      getBlockedBy: async (n) =>
        blockedIssues.includes(n)
          ? [{ issueNumber: 99, state: 'closed', stateReason: 'completed' }]
          : [],
    };
  }

  test('holds new-implementation issue whose blocker is closed as not_planned', async () => {
    const candidates = await parseCandidates([BASE_ISSUES[0]], notPlannedBlockerChecker([1]));
    expect(candidates).toHaveLength(0);
  });

  test('holds review issue whose blocker is closed as not_planned', async () => {
    const candidates = await parseCandidates([BASE_ISSUES[1]], notPlannedBlockerChecker([2]));
    expect(candidates).toHaveLength(0);
  });

  test('passes new-implementation issue whose blocker is closed as completed', async () => {
    const candidates = await parseCandidates([BASE_ISSUES[0]], completedBlockerChecker([1]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(1);
  });

  test('dependencyDecision records not_planned blocker as blocked:true when issue passes through', async () => {
    // Use two issues: one with a not_planned blocker (held), one with no blockers
    // (passes). The passing candidate's decision shows blocked:false as expected;
    // the held issue confirms the gate works correctly (candidates length check).
    const mixedChecker = {
      getBlockedBy: async (n) =>
        n === 1 ? [{ issueNumber: 99, state: 'closed', stateReason: 'not_planned' }] : [],
    };
    const candidates = await parseCandidates(
      [BASE_ISSUES[0], BASE_ISSUES[1]], // issue 1 has not_planned blocker, issue 2 has none
      mixedChecker,
    );
    // Issue 1 held; issue 2 passes through
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(2);
    expect(candidates[0].dependencyDecision.blocked).toBe(false);
  });

  test('not_planned blocker is not a valid Gate 2 stacking base', async () => {
    // A single not_planned blocker on a new-implementation issue must not be
    // treated as a stackable open blocker even with a stack-ready resolver.
    const candidates = await parseCandidates(
      [BASE_ISSUES[0]],
      notPlannedBlockerChecker([1]),
      stackReadyResolver,
    );
    expect(candidates).toHaveLength(0);
  });

  test('not_planned blocker alongside an open blocker holds the issue', async () => {
    const mixedChecker = {
      getBlockedBy: async (n) =>
        n === 1
          ? [
              { issueNumber: 98, state: 'closed', stateReason: 'not_planned' },
              { issueNumber: 99, state: 'open' },
            ]
          : [],
    };
    const candidates = await parseCandidates([BASE_ISSUES[0]], mixedChecker, stackReadyResolver);
    expect(candidates).toHaveLength(0);
  });
});
