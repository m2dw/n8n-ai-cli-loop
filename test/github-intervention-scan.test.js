/**
 * Tests for GitHub-derived L1/L2 intervention signal detection (issue #589).
 */
import {
  scanIssueComments,
  scanPrComments,
  scanPrReviews,
  scanPrCommits,
  scanIssue,
  scanSession,
  looksLikeGuidance,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function comment(overrides = {}) {
  return {
    id: 'c1',
    author: 'alice',
    authorType: 'User',
    body: 'Please clarify the requirements.',
    createdAt: '2026-03-10T10:00:00Z',
    url: 'https://github.com/o/r/issues/42#issuecomment-1',
    ...overrides,
  };
}

function commit(overrides = {}) {
  return {
    sha: 'abc1234567890',
    authorLogin: 'alice',
    authorType: 'User',
    committedAt: '2026-03-10T11:00:00Z',
    ...overrides,
  };
}

const QUEUED_AT = '2026-03-10T09:00:00Z';
const BEFORE_QUEUED = '2026-03-10T08:00:00Z';
const AFTER_QUEUED = '2026-03-10T10:00:00Z';

const NO_AUTOMATION = {};
const WITH_ACTOR = { actorLogins: ['bot-agent'] };

// ---------------------------------------------------------------------------
// scanIssueComments — L1 detection
// ---------------------------------------------------------------------------

describe('scanIssueComments — L1 comment detection', () => {
  test('human comment after queuedAt produces unknown/candidate signal (not countable — semantic intent left to aggregation layer)', () => {
    const signals = scanIssueComments(42, [comment({ createdAt: AFTER_QUEUED })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
    expect(signals[0].issueNumber).toBe(42);
    expect(signals[0].author).toBe('alice');
    expect(signals[0].detectedAt).toBe(AFTER_QUEUED);
  });

  test('comment AT queuedAt timestamp is excluded (not after queue entry)', () => {
    const signals = scanIssueComments(42, [comment({ createdAt: QUEUED_AT })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('comment BEFORE queuedAt is excluded', () => {
    const signals = scanIssueComments(42, [comment({ createdAt: BEFORE_QUEUED })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('multiple human comments each produce a separate signal', () => {
    const comments = [
      comment({ id: 'c1', createdAt: AFTER_QUEUED }),
      comment({ id: 'c2', createdAt: '2026-03-10T12:00:00Z', author: 'bob' }),
    ];
    const signals = scanIssueComments(42, comments, QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(2);
  });

  test('context field contains issue number and author login', () => {
    const [signal] = scanIssueComments(42, [comment({ createdAt: AFTER_QUEUED })], QUEUED_AT, NO_AUTOMATION);
    expect(signal.context).toContain('42');
    expect(signal.context).toContain('alice');
  });

  test('context field does not contain local filesystem paths', () => {
    const [signal] = scanIssueComments(42, [comment({ createdAt: AFTER_QUEUED })], QUEUED_AT, NO_AUTOMATION);
    expect(signal.context).not.toMatch(/\/Users\/|\/home\/|\/worktrees?\//);
  });

  test('returns empty array when there are no comments', () => {
    expect(scanIssueComments(1, [], QUEUED_AT, NO_AUTOMATION)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanIssueComments — automation actor exclusion
// ---------------------------------------------------------------------------

describe('scanIssueComments — automation actor exclusion', () => {
  test('bot by [bot] login suffix is excluded', () => {
    const signals = scanIssueComments(
      1,
      [comment({ author: 'my-app[bot]', authorType: 'User', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(0);
  });

  test('bot by authorType=Bot is excluded', () => {
    const signals = scanIssueComments(
      1,
      [comment({ author: 'ci-bot', authorType: 'Bot', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(0);
  });

  test('configured actorLogin is excluded (case-insensitive)', () => {
    const config = { actorLogins: ['BOT-AGENT'] };
    const signals = scanIssueComments(
      1,
      [comment({ author: 'bot-agent', authorType: 'User', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(0);
  });

  test('unknown author (empty string) is excluded (fail-safe)', () => {
    const signals = scanIssueComments(
      1,
      [comment({ author: '', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(0);
  });

  test('non-bot, non-excluded author still produces a signal', () => {
    const config = { actorLogins: ['bot-agent'] };
    const signals = scanIssueComments(
      1,
      [comment({ author: 'alice', authorType: 'User', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scanIssueComments — sharedIdentity comment preservation (P2)
// ---------------------------------------------------------------------------

describe('scanIssueComments — sharedIdentity preserves comments as ambiguous candidates', () => {
  test('sharedIdentity=true: comment from shared login is emitted as unknown/candidate with identityAmbiguous=true', () => {
    const config = { sharedIdentity: true, actorLogins: ['shared-account'] };
    const signals = scanIssueComments(
      42,
      [comment({ author: 'shared-account', authorType: 'User', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
    expect(signals[0].identityAmbiguous).toBe(true);
    expect(signals[0].author).toBe('shared-account');
  });

  test('sharedIdentity=true: without actorLogins, non-bot comment is emitted as normal candidate (no ambiguity flag)', () => {
    const config = { sharedIdentity: true };
    const signals = scanIssueComments(
      42,
      [comment({ author: 'alice', authorType: 'User', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].identityAmbiguous).toBeUndefined();
  });

  test('sharedIdentity=false: comment from actorLogin is still excluded', () => {
    const config = { sharedIdentity: false, actorLogins: ['bot-agent'] };
    const signals = scanIssueComments(
      42,
      [comment({ author: 'bot-agent', authorType: 'User', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scanPrComments — L1 PR comment detection
// ---------------------------------------------------------------------------

describe('scanPrComments — L1 PR comment detection', () => {
  test('human PR comment after queuedAt produces unknown/candidate signal (not countable — semantic intent left to aggregation layer)', () => {
    const signals = scanPrComments(42, [comment()], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
  });

  test('PR comment at or before queuedAt is excluded (post-queue boundary applied)', () => {
    const signals = scanPrComments(42, [comment({ createdAt: BEFORE_QUEUED })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('bot comment on PR is excluded', () => {
    const signals = scanPrComments(42, [comment({ author: 'ci[bot]' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('configured automation actor PR comment is excluded', () => {
    const signals = scanPrComments(42, [comment({ author: 'codex-agent' })], QUEUED_AT, { actorLogins: ['codex-agent'] });
    expect(signals).toHaveLength(0);
  });

  test('returns empty array when no comments', () => {
    expect(scanPrComments(1, [], QUEUED_AT, NO_AUTOMATION)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// looksLikeGuidance — body classification
// ---------------------------------------------------------------------------

describe('looksLikeGuidance — guidance body detection', () => {
  test('imperative "please" comment is guidance', () => {
    expect(looksLikeGuidance('Please clarify the requirements.')).toBe(true);
  });

  test('directive to fix something is guidance', () => {
    expect(looksLikeGuidance('Fix the null-check in the parser.')).toBe(true);
  });

  test('comment with "should" is guidance', () => {
    expect(looksLikeGuidance('This should use the existing helper.')).toBe(true);
  });

  test('comment redirecting approach is guidance', () => {
    expect(looksLikeGuidance("Don't use a loop here; use map() instead.")).toBe(true);
  });

  test('simple "LGTM" is not guidance', () => {
    expect(looksLikeGuidance('LGTM')).toBe(false);
  });

  test('"Thanks!" is not guidance', () => {
    expect(looksLikeGuidance('Thanks!')).toBe(false);
  });

  test('"Looks good to me." is not guidance', () => {
    expect(looksLikeGuidance('Looks good to me.')).toBe(false);
  });

  test('"Approved" is not guidance', () => {
    expect(looksLikeGuidance('Approved')).toBe(false);
  });

  test('empty body is not guidance', () => {
    expect(looksLikeGuidance('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Comment classification — guidance vs non-guidance body
// ---------------------------------------------------------------------------

describe('scanIssueComments — guidance body classification', () => {
  test('non-guidance acknowledgement is classified as unknown/candidate, not L1', () => {
    const signals = scanIssueComments(
      42,
      [comment({ body: 'Looks good to me.', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
  });

  test('LGTM merge-approval comment is classified as unknown/candidate, not L1', () => {
    const signals = scanIssueComments(
      42,
      [comment({ body: 'LGTM', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
  });

  test('comment with imperative language is classified as unknown/candidate (keyword heuristic does not make it countable)', () => {
    const signals = scanIssueComments(
      42,
      [comment({ body: 'Please add error handling for the empty case.', createdAt: AFTER_QUEUED })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
  });
});

describe('scanPrComments — sharedIdentity preserves comments as ambiguous candidates', () => {
  test('sharedIdentity=true: PR comment from shared login is emitted as unknown/candidate with identityAmbiguous=true', () => {
    const config = { sharedIdentity: true, actorLogins: ['shared-account'] };
    const signals = scanPrComments(
      42,
      [comment({ author: 'shared-account', authorType: 'User' })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].identityAmbiguous).toBe(true);
    expect(signals[0].author).toBe('shared-account');
  });

  test('sharedIdentity=false: PR comment from actorLogin is excluded', () => {
    const config = { sharedIdentity: false, actorLogins: ['bot-agent'] };
    const signals = scanPrComments(
      42,
      [comment({ author: 'bot-agent', authorType: 'User' })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(0);
  });
});

describe('scanPrComments — body classification', () => {
  test('non-guidance acknowledgement is classified as unknown/candidate', () => {
    const signals = scanPrComments(
      42,
      [comment({ body: 'Thanks, looks good.' })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
  });

  test('redirecting PR comment is classified as unknown/candidate (keyword heuristic does not make it countable)', () => {
    const signals = scanPrComments(
      42,
      [comment({ body: 'Could you revert the change to config.ts?' })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanPrCommits — L2 commit detection
// ---------------------------------------------------------------------------

describe('scanPrCommits — L2 human commit detection', () => {
  test('human commit with GitHub login produces human_commit_on_ai_branch (L2)', () => {
    const signals = scanPrCommits(42, [commit()], NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('human_commit_on_ai_branch');
    expect(signals[0].classification.level).toBe('l2');
    expect(signals[0].classification.countsAsIntervention).toBe(true);
    expect(signals[0].author).toBe('alice');
    expect(signals[0].identityAmbiguous).toBeUndefined();
  });

  test('context contains issue number and short SHA', () => {
    const [signal] = scanPrCommits(42, [commit({ sha: 'abc1234abcdef' })], NO_AUTOMATION);
    expect(signal.context).toContain('42');
    expect(signal.context).toContain('abc1234');
  });

  test('context does not contain local filesystem paths', () => {
    const [signal] = scanPrCommits(42, [commit()], NO_AUTOMATION);
    expect(signal.context).not.toMatch(/\/Users\/|\/home\/|\/worktrees?\//);
  });
});

describe('scanPrCommits — automation actor exclusion', () => {
  test('bot commit by [bot] login suffix is excluded', () => {
    const signals = scanPrCommits(1, [commit({ authorLogin: 'claude[bot]' })], NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('bot commit by authorType=Bot is excluded', () => {
    const signals = scanPrCommits(1, [commit({ authorLogin: 'ci-runner', authorType: 'Bot' })], NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('configured actorLogin is excluded (case-insensitive)', () => {
    const config = { actorLogins: ['Claude-Agent'] };
    const signals = scanPrCommits(1, [commit({ authorLogin: 'claude-agent', authorType: 'User' })], config);
    expect(signals).toHaveLength(0);
  });

  test('configured actorEmail excludes email-only commit', () => {
    const config = { actorEmails: ['bot@example.com'] };
    const signals = scanPrCommits(
      1,
      [commit({ authorLogin: undefined, authorEmail: 'bot@example.com' })],
      config,
    );
    expect(signals).toHaveLength(0);
  });

  test('actorEmail exclusion is case-insensitive', () => {
    const config = { actorEmails: ['BOT@EXAMPLE.COM'] };
    const signals = scanPrCommits(
      1,
      [commit({ authorLogin: undefined, authorEmail: 'bot@example.com' })],
      config,
    );
    expect(signals).toHaveLength(0);
  });
});

describe('scanPrCommits — ambiguous identity', () => {
  test('commit with email only (no login) is marked identityAmbiguous=true, classified as unknown/candidate, and email is not exposed in author', () => {
    const signals = scanPrCommits(
      42,
      [commit({ authorLogin: undefined, authorEmail: 'alice@example.com' })],
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
    expect(signals[0].identityAmbiguous).toBe(true);
    // Raw email must not appear in public output — commit metadata is untrusted
    // and could contain local artifact paths.
    expect(signals[0].author).toBeUndefined();
  });

  test('commit with no identity info is marked identityAmbiguous=true and classified as unknown/candidate', () => {
    const signals = scanPrCommits(
      42,
      [commit({ authorLogin: undefined, authorEmail: undefined })],
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].identityAmbiguous).toBe(true);
    expect(signals[0].author).toBeUndefined();
  });

  test('sharedIdentity=true marks all commits as unknown/candidate regardless of login', () => {
    const config = { sharedIdentity: true };
    const signals = scanPrCommits(
      42,
      [commit({ authorLogin: 'alice', authorType: 'User' })],
      config,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].identityAmbiguous).toBe(true);
  });

  test('sharedIdentity=true still excludes bot commits — bots are always identifiable', () => {
    // Even when sharedIdentity is true, a clearly identifiable bot commit must be
    // excluded rather than emitted as a candidate intervention. Bots are excluded
    // before the sharedIdentity check so they never inflate candidate metrics.
    const config = { sharedIdentity: true };
    const signals = scanPrCommits(
      42,
      [commit({ authorLogin: 'myapp[bot]', authorType: 'Bot' })],
      config,
    );
    expect(signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scanIssue — combined per-issue scan
// ---------------------------------------------------------------------------

describe('scanIssue — combined per-issue scan', () => {
  test('combines issue comments, PR comments, and commits into one result', () => {
    const input = {
      issueNumber: 10,
      queuedAt: QUEUED_AT,
      issueComments: [comment({ createdAt: AFTER_QUEUED })],
      prComments: [comment({ author: 'bob' })],
      prCommits: [commit({ authorLogin: 'charlie' })],
    };
    const { signals, closedUnmergedOutcomes, warnings } = scanIssue(input, NO_AUTOMATION);
    expect(signals).toHaveLength(3);
    expect(closedUnmergedOutcomes).toHaveLength(0);
    expect(warnings).toHaveLength(0);

    const levels = signals.map((s) => s.classification.signal);
    // Comments are candidate/unknown — keyword heuristic does not produce countable L1.
    expect(levels.filter((s) => s === 'unknown')).toHaveLength(2);
    expect(levels).toContain('human_commit_on_ai_branch');
  });

  test('closed-unmerged PR is recorded as outcome, not as a signal', () => {
    const input = {
      issueNumber: 11,
      queuedAt: QUEUED_AT,
      prOutcome: 'closed_unmerged',
    };
    const { signals, closedUnmergedOutcomes } = scanIssue(input, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
    expect(closedUnmergedOutcomes).toHaveLength(1);
    expect(closedUnmergedOutcomes[0].issueNumber).toBe(11);
    expect(closedUnmergedOutcomes[0].outcome).toBe('closed_unmerged');
  });

  test('merged PR does not produce a closed-unmerged outcome', () => {
    const { closedUnmergedOutcomes } = scanIssue(
      { issueNumber: 12, queuedAt: QUEUED_AT, prOutcome: 'merged' },
      NO_AUTOMATION,
    );
    expect(closedUnmergedOutcomes).toHaveLength(0);
  });

  test('open PR does not produce a closed-unmerged outcome', () => {
    const { closedUnmergedOutcomes } = scanIssue(
      { issueNumber: 13, queuedAt: QUEUED_AT, prOutcome: 'open' },
      NO_AUTOMATION,
    );
    expect(closedUnmergedOutcomes).toHaveLength(0);
  });

  test('sharedIdentity=true emits a warning for issues with commits', () => {
    const input = {
      issueNumber: 20,
      queuedAt: QUEUED_AT,
      prCommits: [commit()],
    };
    const { warnings } = scanIssue(input, { sharedIdentity: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('20');
    expect(warnings[0]).toContain('shared');
  });

  test('sharedIdentity=true does NOT emit a warning when there are no commits', () => {
    const input = {
      issueNumber: 21,
      queuedAt: QUEUED_AT,
      issueComments: [comment({ createdAt: AFTER_QUEUED })],
    };
    const { warnings } = scanIssue(input, { sharedIdentity: true });
    expect(warnings).toHaveLength(0);
  });

  test('issue with no data produces empty result', () => {
    const { signals, closedUnmergedOutcomes, warnings } = scanIssue(
      { issueNumber: 99, queuedAt: QUEUED_AT },
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(0);
    expect(closedUnmergedOutcomes).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scanSession — multi-issue batch scan
// ---------------------------------------------------------------------------

describe('scanSession — multi-issue batch scan', () => {
  test('aggregates signals across multiple issues', () => {
    const inputs = [
      {
        issueNumber: 1,
        queuedAt: QUEUED_AT,
        issueComments: [comment({ createdAt: AFTER_QUEUED })],
      },
      {
        issueNumber: 2,
        queuedAt: QUEUED_AT,
        prCommits: [commit({ authorLogin: 'bob' })],
      },
    ];
    const { signals } = scanSession(inputs, NO_AUTOMATION);
    expect(signals).toHaveLength(2);
    expect(signals.find((s) => s.issueNumber === 1)?.classification.signal).toBe('unknown');
    expect(signals.find((s) => s.issueNumber === 2)?.classification.signal).toBe('human_commit_on_ai_branch');
  });

  test('aggregates closed-unmerged outcomes across issues', () => {
    const inputs = [
      { issueNumber: 1, queuedAt: QUEUED_AT, prOutcome: 'closed_unmerged' },
      { issueNumber: 2, queuedAt: QUEUED_AT, prOutcome: 'merged' },
      { issueNumber: 3, queuedAt: QUEUED_AT, prOutcome: 'closed_unmerged' },
    ];
    const { closedUnmergedOutcomes } = scanSession(inputs, NO_AUTOMATION);
    expect(closedUnmergedOutcomes).toHaveLength(2);
    expect(closedUnmergedOutcomes.map((o) => o.issueNumber).sort()).toEqual([1, 3]);
  });

  test('aggregates warnings across issues with sharedIdentity', () => {
    const inputs = [
      { issueNumber: 5, queuedAt: QUEUED_AT, prCommits: [commit()] },
      { issueNumber: 6, queuedAt: QUEUED_AT, prCommits: [commit()] },
    ];
    const { warnings } = scanSession(inputs, { sharedIdentity: true });
    expect(warnings).toHaveLength(2);
  });

  test('returns empty result for empty input', () => {
    const result = scanSession([], NO_AUTOMATION);
    expect(result.signals).toHaveLength(0);
    expect(result.closedUnmergedOutcomes).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('automation actors configured at session level are excluded across all issues', () => {
    const config = { actorLogins: ['ci-bot'] };
    const inputs = [
      {
        issueNumber: 1,
        queuedAt: QUEUED_AT,
        issueComments: [comment({ author: 'ci-bot', authorType: 'User', createdAt: AFTER_QUEUED })],
      },
      {
        issueNumber: 2,
        queuedAt: QUEUED_AT,
        prCommits: [commit({ authorLogin: 'ci-bot', authorType: 'User' })],
      },
    ];
    const { signals } = scanSession(inputs, config);
    expect(signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scanPrReviews — L1 PR review signal detection
// ---------------------------------------------------------------------------

function review(overrides = {}) {
  return {
    id: 'r1',
    author: 'alice',
    authorType: 'User',
    state: 'CHANGES_REQUESTED',
    body: 'Please fix the null check.',
    submittedAt: '2026-03-10T12:00:00Z',
    url: 'https://github.com/o/r/pull/7#pullrequestreview-1',
    ...overrides,
  };
}

function reviewComment(overrides = {}) {
  return {
    id: 'rc1',
    author: 'alice',
    authorType: 'User',
    body: 'This should use the helper.',
    createdAt: '2026-03-10T12:01:00Z',
    url: 'https://github.com/o/r/pull/7#discussion_r1',
    ...overrides,
  };
}

describe('scanPrReviews — CHANGES_REQUESTED detection', () => {
  test('CHANGES_REQUESTED review from human produces pr_comment_guidance (L1)', () => {
    const signals = scanPrReviews(42, [review()], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('pr_comment_guidance');
    expect(signals[0].classification.level).toBe('l1');
    expect(signals[0].classification.countsAsIntervention).toBe(true);
    expect(signals[0].author).toBe('alice');
    expect(signals[0].issueNumber).toBe(42);
  });

  test('CHANGES_REQUESTED with empty body still emits L1 (state alone is guidance)', () => {
    const signals = scanPrReviews(42, [review({ body: '' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('pr_comment_guidance');
    expect(signals[0].classification.level).toBe('l1');
  });

  test('context field contains issue number and author login', () => {
    const [signal] = scanPrReviews(42, [review()], QUEUED_AT, NO_AUTOMATION);
    expect(signal.context).toContain('42');
    expect(signal.context).toContain('alice');
  });

  test('context field does not contain local filesystem paths', () => {
    const [signal] = scanPrReviews(42, [review()], QUEUED_AT, NO_AUTOMATION);
    expect(signal.context).not.toMatch(/\/Users\/|\/home\/|\/worktrees?\//);
  });

  test('review at or before queuedAt is excluded (post-queue boundary applied)', () => {
    const signals = scanPrReviews(
      42,
      [review({ submittedAt: BEFORE_QUEUED })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(0);
  });
});

describe('scanPrReviews — APPROVED review exclusion', () => {
  test('APPROVED review from human is excluded (planned gate, not intervention)', () => {
    const signals = scanPrReviews(42, [review({ state: 'APPROVED' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('APPROVED review with inline comments still emits signals for inline comments', () => {
    const r = review({
      state: 'APPROVED',
      comments: [reviewComment()],
    });
    const signals = scanPrReviews(42, [r], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
  });
});

describe('scanPrReviews — PENDING review exclusion', () => {
  test('PENDING review with a body is ignored (unsubmitted draft, not an intervention signal)', () => {
    const signals = scanPrReviews(42, [review({ state: 'PENDING', body: 'Please fix this.' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('PENDING review with inline comments is ignored entirely', () => {
    const r = review({ state: 'PENDING', body: '', comments: [reviewComment()] });
    const signals = scanPrReviews(42, [r], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });
});

describe('scanPrReviews — COMMENTED and DISMISSED body classification', () => {
  test('COMMENTED review with any non-empty body produces unknown/candidate (keyword heuristic does not make it countable)', () => {
    const signals = scanPrReviews(42, [review({ state: 'COMMENTED', body: 'Please update the docs.' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
  });

  test('COMMENTED review with non-guidance body produces unknown/candidate', () => {
    const signals = scanPrReviews(42, [review({ state: 'COMMENTED', body: 'LGTM' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
  });

  test('COMMENTED review with empty body and no inline comments emits no signal', () => {
    const signals = scanPrReviews(42, [review({ state: 'COMMENTED', body: '' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('DISMISSED review with non-empty body produces unknown/candidate (treated same as COMMENTED)', () => {
    const signals = scanPrReviews(42, [review({ state: 'DISMISSED', body: 'Closing as stale.' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].classification.level).toBe('candidate');
    expect(signals[0].classification.countsAsIntervention).toBe(false);
    expect(signals[0].author).toBe('alice');
  });

  test('DISMISSED review with empty body and no inline comments emits no signal', () => {
    const signals = scanPrReviews(42, [review({ state: 'DISMISSED', body: '' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('DISMISSED review with inline comments still emits signals for inline comments', () => {
    const r = review({ state: 'DISMISSED', body: '', comments: [reviewComment()] });
    const signals = scanPrReviews(42, [r], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].author).toBe('alice');
  });

  test('DISMISSED review from bot is excluded (body non-empty)', () => {
    const signals = scanPrReviews(
      42,
      [review({ state: 'DISMISSED', body: 'Stale.', author: 'ci[bot]', authorType: 'User' })],
      QUEUED_AT,
      NO_AUTOMATION,
    );
    expect(signals).toHaveLength(0);
  });
});

describe('scanPrReviews — automation actor exclusion', () => {
  test('CHANGES_REQUESTED review from bot ([bot] suffix) is excluded', () => {
    const signals = scanPrReviews(42, [review({ author: 'ci[bot]', authorType: 'User' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('CHANGES_REQUESTED review from bot (authorType=Bot) is excluded', () => {
    const signals = scanPrReviews(42, [review({ author: 'ci-runner', authorType: 'Bot' })], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('CHANGES_REQUESTED review from configured actorLogin is excluded (case-insensitive)', () => {
    const config = { actorLogins: ['Code-Agent'] };
    const signals = scanPrReviews(42, [review({ author: 'code-agent', authorType: 'User' })], QUEUED_AT, config);
    expect(signals).toHaveLength(0);
  });
});

describe('scanPrReviews — sharedIdentity preserves reviews as ambiguous candidates', () => {
  test('sharedIdentity=true: CHANGES_REQUESTED review from shared login is emitted as unknown/candidate with identityAmbiguous=true', () => {
    const config = { sharedIdentity: true, actorLogins: ['shared-account'] };
    const signals = scanPrReviews(
      42,
      [review({ author: 'shared-account', authorType: 'User' })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].identityAmbiguous).toBe(true);
    expect(signals[0].author).toBe('shared-account');
  });

  test('sharedIdentity=true: inline comment from shared login is emitted as unknown/candidate with identityAmbiguous=true', () => {
    const config = { sharedIdentity: true, actorLogins: ['shared-account'] };
    const r = review({
      author: 'human-reviewer',
      state: 'COMMENTED',
      body: '',
      comments: [reviewComment({ author: 'shared-account' })],
    });
    const signals = scanPrReviews(42, [r], QUEUED_AT, config);
    expect(signals).toHaveLength(1);
    expect(signals[0].identityAmbiguous).toBe(true);
    expect(signals[0].author).toBe('shared-account');
  });

  test('sharedIdentity=false: review from actorLogin is excluded', () => {
    const config = { sharedIdentity: false, actorLogins: ['code-agent'] };
    const signals = scanPrReviews(
      42,
      [review({ author: 'code-agent', authorType: 'User' })],
      QUEUED_AT,
      config,
    );
    expect(signals).toHaveLength(0);
  });
});

describe('scanPrReviews — inline review comment detection', () => {
  test('inline review comment produces unknown/candidate (keyword heuristic does not make it countable)', () => {
    const r = review({ state: 'COMMENTED', body: '', comments: [reviewComment()] });
    const signals = scanPrReviews(42, [r], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('unknown');
    expect(signals[0].author).toBe('alice');
    expect(signals[0].detectedAt).toBe('2026-03-10T12:01:00Z');
  });

  test('inline review comment with any body produces unknown/candidate', () => {
    const r = review({ state: 'CHANGES_REQUESTED', comments: [reviewComment({ body: 'ok' })] });
    const signals = scanPrReviews(42, [r], QUEUED_AT, NO_AUTOMATION);
    // one for the CHANGES_REQUESTED review + one for the inline comment
    const inlineSignal = signals.find((s) => s.detectedAt === '2026-03-10T12:01:00Z');
    expect(inlineSignal?.classification.signal).toBe('unknown');
  });

  test('inline review comment from bot is excluded', () => {
    const r = review({
      state: 'COMMENTED',
      body: '',
      comments: [reviewComment({ author: 'ci[bot]', authorType: 'User' })],
    });
    const signals = scanPrReviews(42, [r], QUEUED_AT, NO_AUTOMATION);
    expect(signals).toHaveLength(0);
  });

  test('inline review comment from configured actor is excluded', () => {
    const config = { actorLogins: ['code-agent'] };
    const r = review({
      state: 'COMMENTED',
      body: '',
      comments: [reviewComment({ author: 'code-agent' })],
    });
    const signals = scanPrReviews(42, [r], QUEUED_AT, config);
    expect(signals).toHaveLength(0);
  });

  test('automation-authored review with human inline comment emits unknown/candidate for inline comment', () => {
    // Review author is automation → review-level signal skipped.
    // Inline comment author is human → inline signal emitted as candidate.
    const config = { actorLogins: ['code-agent'] };
    const r = review({
      author: 'code-agent',
      state: 'CHANGES_REQUESTED',
      comments: [reviewComment({ author: 'alice' })],
    });
    const signals = scanPrReviews(42, [r], QUEUED_AT, config);
    expect(signals).toHaveLength(1);
    expect(signals[0].author).toBe('alice');
    expect(signals[0].classification.signal).toBe('unknown');
  });

  test('returns empty array when no reviews', () => {
    expect(scanPrReviews(1, [], QUEUED_AT, NO_AUTOMATION)).toEqual([]);
  });
});

describe('scanIssue — prReviews included in combined scan', () => {
  test('CHANGES_REQUESTED review is included in combined scanIssue result', () => {
    const input = {
      issueNumber: 55,
      queuedAt: QUEUED_AT,
      prReviews: [review()],
    };
    const { signals } = scanIssue(input, NO_AUTOMATION);
    expect(signals).toHaveLength(1);
    expect(signals[0].classification.signal).toBe('pr_comment_guidance');
  });

  test('combines issue comments, PR comments, PR reviews, and commits into one result', () => {
    const input = {
      issueNumber: 56,
      queuedAt: QUEUED_AT,
      issueComments: [comment({ createdAt: AFTER_QUEUED })],
      prComments: [comment({ author: 'bob' })],
      prReviews: [review({ author: 'carol' })],
      prCommits: [commit({ authorLogin: 'dave' })],
    };
    const { signals } = scanIssue(input, NO_AUTOMATION);
    expect(signals).toHaveLength(4);
    const kinds = signals.map((s) => s.classification.signal);
    // Comments and reviews without CHANGES_REQUESTED are candidate/unknown.
    expect(kinds.filter((s) => s === 'unknown')).toHaveLength(2);
    // CHANGES_REQUESTED review is still a structural L1 signal.
    expect(kinds).toContain('pr_comment_guidance');
    expect(kinds).toContain('human_commit_on_ai_branch');
  });
});

// ---------------------------------------------------------------------------
// scanSession — date range filtering
// ---------------------------------------------------------------------------

describe('scanSession — date range filtering', () => {
  const RANGE_START = '2026-03-10T10:00:00Z';
  const RANGE_END   = '2026-03-10T20:00:00Z';
  const BEFORE_RANGE = '2026-03-10T09:00:00Z';
  const WITHIN_RANGE = '2026-03-10T15:00:00Z';
  const AFTER_RANGE  = '2026-03-10T21:00:00Z';

  test('signals within range are emitted', () => {
    const inputs = [{
      issueNumber: 1,
      queuedAt: '2026-03-10T08:00:00Z',
      prCommits: [commit({ committedAt: WITHIN_RANGE })],
    }];
    const { signals } = scanSession(inputs, NO_AUTOMATION, { start: RANGE_START, end: RANGE_END });
    expect(signals).toHaveLength(1);
  });

  test('signals before range start are excluded', () => {
    const inputs = [{
      issueNumber: 1,
      queuedAt: '2026-03-10T08:00:00Z',
      prCommits: [commit({ committedAt: BEFORE_RANGE })],
    }];
    const { signals } = scanSession(inputs, NO_AUTOMATION, { start: RANGE_START, end: RANGE_END });
    expect(signals).toHaveLength(0);
  });

  test('signals after range end are excluded', () => {
    const inputs = [{
      issueNumber: 1,
      queuedAt: '2026-03-10T08:00:00Z',
      prCommits: [commit({ committedAt: AFTER_RANGE })],
    }];
    const { signals } = scanSession(inputs, NO_AUTOMATION, { start: RANGE_START, end: RANGE_END });
    expect(signals).toHaveLength(0);
  });

  test('range bounds are inclusive — signal at range start is emitted', () => {
    const inputs = [{
      issueNumber: 1,
      queuedAt: '2026-03-10T08:00:00Z',
      prCommits: [commit({ committedAt: RANGE_START })],
    }];
    const { signals } = scanSession(inputs, NO_AUTOMATION, { start: RANGE_START });
    expect(signals).toHaveLength(1);
  });

  test('range bounds are inclusive — signal at range end is emitted', () => {
    const inputs = [{
      issueNumber: 1,
      queuedAt: '2026-03-10T08:00:00Z',
      prCommits: [commit({ committedAt: RANGE_END })],
    }];
    const { signals } = scanSession(inputs, NO_AUTOMATION, { end: RANGE_END });
    expect(signals).toHaveLength(1);
  });

  test('open-ended start-only range excludes older signals', () => {
    const inputs = [{
      issueNumber: 2,
      queuedAt: '2026-03-10T08:00:00Z',
      prCommits: [
        commit({ sha: 'aaa', committedAt: BEFORE_RANGE }),
        commit({ sha: 'bbb', committedAt: WITHIN_RANGE }),
      ],
    }];
    const { signals } = scanSession(inputs, NO_AUTOMATION, { start: RANGE_START });
    expect(signals).toHaveLength(1);
    expect(signals[0].detectedAt).toBe(WITHIN_RANGE);
  });

  test('mixed-period issue: only in-range signals emitted', () => {
    const inputs = [{
      issueNumber: 3,
      queuedAt: '2026-03-10T08:00:00Z',
      issueComments: [
        comment({ createdAt: BEFORE_RANGE }),
        comment({ createdAt: WITHIN_RANGE }),
      ],
    }];
    const { signals } = scanSession(inputs, NO_AUTOMATION, { start: RANGE_START, end: RANGE_END });
    expect(signals).toHaveLength(1);
    expect(signals[0].detectedAt).toBe(WITHIN_RANGE);
  });

  test('closed-unmerged outcomes are not filtered by range', () => {
    const inputs = [{ issueNumber: 4, queuedAt: QUEUED_AT, prOutcome: 'closed_unmerged' }];
    const { closedUnmergedOutcomes } = scanSession(inputs, NO_AUTOMATION, { start: RANGE_START, end: RANGE_END });
    expect(closedUnmergedOutcomes).toHaveLength(1);
  });

  test('no range — all signals pass through (backwards compatible)', () => {
    const inputs = [{
      issueNumber: 5,
      queuedAt: '2026-03-10T08:00:00Z',
      prCommits: [
        commit({ sha: 'ccc', committedAt: BEFORE_RANGE }),
        commit({ sha: 'ddd', committedAt: WITHIN_RANGE }),
        commit({ sha: 'eee', committedAt: AFTER_RANGE }),
      ],
    }];
    const { signals } = scanSession(inputs, NO_AUTOMATION);
    expect(signals).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// All produced signals carry a non-empty reason
// ---------------------------------------------------------------------------

describe('signal reason completeness', () => {
  test('every signal kind used by the scanner has a non-empty reason', () => {
    const inputs = [
      {
        issueNumber: 1,
        queuedAt: QUEUED_AT,
        issueComments: [comment({ createdAt: AFTER_QUEUED })],
        prComments: [comment()],
        prCommits: [
          commit(),
          commit({ authorLogin: undefined, authorEmail: 'x@example.com' }),
          commit({ authorLogin: undefined, authorEmail: undefined }),
        ],
      },
    ];
    const { signals } = scanSession(inputs, { sharedIdentity: false });
    for (const s of signals) {
      expect(typeof s.classification.reason).toBe('string');
      expect(s.classification.reason.length).toBeGreaterThan(0);
    }
  });
});
