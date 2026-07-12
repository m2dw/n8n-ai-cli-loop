import {
  selectChangesRequestedFeedback,
  isBotAuthor,
} from '../dist/core/github-app-review.js';

function review(overrides = {}) {
  return {
    id: '1',
    author: 'alice',
    authorType: 'User',
    state: 'CHANGES_REQUESTED',
    body: 'Please fix the null check.',
    submittedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/o/r/pull/5#pullrequestreview-1',
    ...overrides,
  };
}

describe('isBotAuthor', () => {
  test('detects the GitHub User.type === "Bot" flag', () => {
    expect(isBotAuthor('my-app', 'Bot')).toBe(true);
  });
  test('detects the [bot] login suffix', () => {
    expect(isBotAuthor('my-app[bot]')).toBe(true);
  });
  test('treats empty/unknown login as bot (never human feedback)', () => {
    expect(isBotAuthor('')).toBe(true);
  });
  test('treats a normal human login as non-bot', () => {
    expect(isBotAuthor('alice', 'User')).toBe(false);
  });
});

describe('selectChangesRequestedFeedback', () => {
  test('selects a human CHANGES_REQUESTED review body as feedback', () => {
    const sel = selectChangesRequestedFeedback([review()], []);
    expect(sel.found).toBe(true);
    expect(sel.feedback).toContain('null check');
    expect(sel.review.author).toBe('alice');
    expect(sel.inlineCommentCount).toBe(0);
  });

  test('folds inline comments (matched by review id) into the feedback', () => {
    const reviews = [review({ id: '99', body: 'Summary issue.' })];
    const comments = [
      { reviewId: '99', author: 'alice', authorType: 'User', body: 'rename foo', path: 'src/a.ts' },
      { reviewId: '99', author: 'alice', authorType: 'User', body: 'guard against null' },
      // Belongs to a different review — must not be folded in.
      { reviewId: '7', author: 'alice', authorType: 'User', body: 'unrelated' },
    ];
    const sel = selectChangesRequestedFeedback(reviews, comments);
    expect(sel.found).toBe(true);
    expect(sel.inlineCommentCount).toBe(2);
    expect(sel.feedback).toContain('Summary issue.');
    expect(sel.feedback).toContain('src/a.ts: rename foo');
    expect(sel.feedback).toContain('guard against null');
    expect(sel.feedback).not.toContain('unrelated');
  });

  test('does NOT requeue on approval-only reviews', () => {
    const sel = selectChangesRequestedFeedback([review({ state: 'APPROVED' })], []);
    expect(sel.found).toBe(false);
  });

  test('does NOT requeue on comment-only reviews', () => {
    const sel = selectChangesRequestedFeedback([review({ state: 'COMMENTED' })], []);
    expect(sel.found).toBe(false);
  });

  test('ignores bot CHANGES_REQUESTED reviews (User.type Bot)', () => {
    const sel = selectChangesRequestedFeedback(
      [review({ author: 'codex-bot', authorType: 'Bot' })],
      [],
    );
    expect(sel.found).toBe(false);
  });

  test('ignores bot reviews by [bot] login suffix', () => {
    const sel = selectChangesRequestedFeedback(
      [review({ author: 'ai-loop[bot]', authorType: undefined })],
      [],
    );
    expect(sel.found).toBe(false);
  });

  test('excludes the AI actor login passed via excludeAuthors', () => {
    const sel = selectChangesRequestedFeedback([review({ author: 'ai-actor' })], [], {
      excludeAuthors: ['AI-Actor'],
    });
    expect(sel.found).toBe(false);
  });

  test('a later approval by the same reviewer supersedes the change request', () => {
    const reviews = [
      review({ id: '1', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' }),
      review({ id: '2', state: 'APPROVED', submittedAt: '2026-01-02T00:00:00Z', body: '' }),
    ];
    const sel = selectChangesRequestedFeedback(reviews, []);
    expect(sel.found).toBe(false);
  });

  test('an earlier approval does NOT cancel a later change request', () => {
    const reviews = [
      review({ id: '1', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z', body: '' }),
      review({ id: '2', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-02T00:00:00Z', body: 'regressed' }),
    ];
    const sel = selectChangesRequestedFeedback(reviews, []);
    expect(sel.found).toBe(true);
    expect(sel.feedback).toContain('regressed');
  });

  test('a later comment-only review does NOT clear an active change request', () => {
    const reviews = [
      review({ id: '1', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z', body: 'fix the null check' }),
      review({ id: '2', state: 'COMMENTED', submittedAt: '2026-01-02T00:00:00Z', body: 'any update?' }),
    ];
    const sel = selectChangesRequestedFeedback(reviews, []);
    expect(sel.found).toBe(true);
    expect(sel.review.id).toBe('1');
    expect(sel.feedback).toContain('fix the null check');
  });

  test('a comment-only review then an approval clears the change request', () => {
    const reviews = [
      review({ id: '1', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' }),
      review({ id: '2', state: 'COMMENTED', submittedAt: '2026-01-02T00:00:00Z', body: 'thanks' }),
      review({ id: '3', state: 'APPROVED', submittedAt: '2026-01-03T00:00:00Z', body: '' }),
    ];
    const sel = selectChangesRequestedFeedback(reviews, []);
    expect(sel.found).toBe(false);
  });

  test('a dismissed change request followed by a comment does not requeue', () => {
    const reviews = [
      review({ id: '1', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' }),
      review({ id: '2', state: 'DISMISSED', submittedAt: '2026-01-02T00:00:00Z', body: '' }),
      review({ id: '3', state: 'COMMENTED', submittedAt: '2026-01-03T00:00:00Z', body: 'note' }),
    ];
    const sel = selectChangesRequestedFeedback(reviews, []);
    expect(sel.found).toBe(false);
  });

  test('aggregates all active change requests when several humans request changes', () => {
    const reviews = [
      review({ id: '1', author: 'alice', submittedAt: '2026-01-01T00:00:00Z', body: 'alice change' }),
      review({ id: '2', author: 'bob', submittedAt: '2026-01-03T00:00:00Z', body: 'bob change' }),
    ];
    const sel = selectChangesRequestedFeedback(reviews, []);
    expect(sel.found).toBe(true);
    // Both reviewers' feedback is surfaced, not just the latest, so an older active
    // request is never skipped after the latest is recorded as processed.
    expect(sel.feedback).toContain('alice change');
    expect(sel.feedback).toContain('bob change');
    expect(sel.feedback).toContain('@alice requested changes:');
    expect(sel.feedback).toContain('@bob requested changes:');
    expect(sel.reviewCount).toBe(2);
    // The representative review (used for dedup keying) is the newest contributor.
    expect(sel.review.author).toBe('bob');
    // The full contributed id set (oldest→newest) is exposed so the caller can
    // record it and avoid re-surfacing an already-aggregated request.
    expect(sel.reviewIds).toEqual(['1', '2']);
  });

  test('aggregates inline comments from every active reviewer', () => {
    const reviews = [
      review({ id: '1', author: 'alice', submittedAt: '2026-01-01T00:00:00Z', body: '' }),
      review({ id: '2', author: 'bob', submittedAt: '2026-01-03T00:00:00Z', body: 'bob summary' }),
    ];
    const comments = [
      { reviewId: '1', author: 'alice', authorType: 'User', body: 'alice inline', path: 'src/a.ts' },
      { reviewId: '2', author: 'bob', authorType: 'User', body: 'bob inline' },
    ];
    const sel = selectChangesRequestedFeedback(reviews, comments);
    expect(sel.found).toBe(true);
    expect(sel.reviewCount).toBe(2);
    expect(sel.inlineCommentCount).toBe(2);
    expect(sel.feedback).toContain('src/a.ts: alice inline');
    expect(sel.feedback).toContain('bob inline');
  });

  test('a reviewer with no usable text does not count toward the aggregate', () => {
    const reviews = [
      // Empty body, no inline comments → contributes nothing.
      review({ id: '1', author: 'alice', submittedAt: '2026-01-01T00:00:00Z', body: '' }),
      review({ id: '2', author: 'bob', submittedAt: '2026-01-03T00:00:00Z', body: 'bob change' }),
    ];
    const sel = selectChangesRequestedFeedback(reviews, []);
    expect(sel.found).toBe(true);
    expect(sel.reviewCount).toBe(1);
    // Only one contributor → no per-reviewer attribution header, output unchanged.
    expect(sel.feedback).toBe('bob change');
    expect(sel.review.author).toBe('bob');
  });

  test('single active change request keeps the un-attributed feedback shape', () => {
    const sel = selectChangesRequestedFeedback([review({ body: 'only feedback' })], []);
    expect(sel.found).toBe(true);
    expect(sel.reviewCount).toBe(1);
    expect(sel.feedback).toBe('only feedback');
  });

  test('a change request with no body and no usable comments does not requeue', () => {
    const reviews = [review({ id: '5', body: '' })];
    const comments = [
      // Only a bot inline comment for this review — excluded.
      { reviewId: '5', author: 'tool[bot]', body: 'auto' },
    ];
    const sel = selectChangesRequestedFeedback(reviews, comments);
    expect(sel.found).toBe(false);
  });

  test('returns found:false with a reason when there are no human reviews', () => {
    const sel = selectChangesRequestedFeedback([], []);
    expect(sel.found).toBe(false);
    expect(typeof sel.reason).toBe('string');
  });
});
