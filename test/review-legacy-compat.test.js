/**
 * Unit tests for the issue #842 task-context consumption boundary
 * (src/core/review-legacy-compat.ts).
 *
 * This module adapts legacy free-form `task.context.reviewFeedback` to the
 * issue #836/#841 structured review dispute pipeline without fabricating
 * disputable findings. It is pure and composes the #836 compatibility helper
 * (`legacyFindingFromReviewFeedback`) and the #836 runtime validator
 * (`validateReviewDisputeContext`) — no schema or classifier of its own.
 */
import {
  MAX_LEGACY_FEEDBACK_CHARS,
  emptyReviewDisputeContext,
} from '../dist/core/review-dispute.js';
import {
  REVIEW_COMPAT_MODES,
  resolveReviewCompatContext,
} from '../dist/core/review-legacy-compat.js';

describe('resolveReviewCompatContext — old context snapshots with legacy feedback only', () => {
  test('a pre-#836 context with only reviewFeedback resolves to legacy', () => {
    const context = { reviewFeedback: 'Please add a null check on line 42.' };
    const result = resolveReviewCompatContext(context);
    expect(result.mode).toBe('legacy');
    expect(result.reviewDispute).toBeNull();
    expect(result.legacyFinding).toEqual({
      kind: 'legacy_free_form',
      disputable: false,
      feedback: 'Please add a null check on line 42.',
      truncated: false,
    });
  });

  test('the legacy finding is typed non-disputable', () => {
    const context = { reviewFeedback: 'Fix the parser.' };
    const result = resolveReviewCompatContext(context);
    expect(result.legacyFinding.disputable).toBe(false);
  });

  test('unrelated task-context fields are not read, mutated, or dropped', () => {
    const context = {
      reviewFeedback: 'Fix the parser.',
      prUrl: 'https://github.com/m2dw/test-repo/pull/44',
      branch: 'ai/issue-77',
      implementationMode: 'fix',
      reviewCycles: 2,
      labels: ['agent:claude', 'status:needs-fix'],
    };
    const snapshot = JSON.parse(JSON.stringify(context));
    resolveReviewCompatContext(context);
    expect(context).toEqual(snapshot);
  });
});

describe('resolveReviewCompatContext — absent and whitespace-only feedback', () => {
  test('no reviewFeedback and no reviewDispute resolves to empty', () => {
    const result = resolveReviewCompatContext({});
    expect(result).toEqual({ mode: 'empty', legacyFinding: null, reviewDispute: null });
  });

  test('whitespace-only reviewFeedback resolves to empty, not legacy', () => {
    const result = resolveReviewCompatContext({ reviewFeedback: '   \n\t  ' });
    expect(result.mode).toBe('empty');
    expect(result.legacyFinding).toBeNull();
  });

  test('a non-string reviewFeedback is treated as absent', () => {
    const result = resolveReviewCompatContext({ reviewFeedback: 12345 });
    expect(result.mode).toBe('empty');
  });
});

describe('resolveReviewCompatContext — oversized legacy feedback', () => {
  test('feedback beyond the §13 bound is truncated, not rejected', () => {
    const oversized = 'x'.repeat(MAX_LEGACY_FEEDBACK_CHARS + 500);
    const result = resolveReviewCompatContext({ reviewFeedback: oversized });
    expect(result.mode).toBe('legacy');
    expect(result.legacyFinding.truncated).toBe(true);
    expect(result.legacyFinding.feedback).toHaveLength(MAX_LEGACY_FEEDBACK_CHARS);
  });

  test('feedback at exactly the bound is not marked truncated', () => {
    const exact = 'y'.repeat(MAX_LEGACY_FEEDBACK_CHARS);
    const result = resolveReviewCompatContext({ reviewFeedback: exact });
    expect(result.legacyFinding.truncated).toBe(false);
  });
});

describe('resolveReviewCompatContext — mixed fields and malformed partial structured state', () => {
  test('a valid structured block with no residual prose is authoritative (structured)', () => {
    const reviewDispute = emptyReviewDisputeContext('structured');
    const result = resolveReviewCompatContext({ reviewDispute, reviewFeedback: '' });
    expect(result.mode).toBe('structured');
    expect(result.reviewDispute).toEqual(reviewDispute);
    expect(result.legacyFinding).toBeNull();
  });

  test('structured state stays authoritative even if stale reviewFeedback text is still present', () => {
    const reviewDispute = emptyReviewDisputeContext('structured');
    const result = resolveReviewCompatContext({
      reviewDispute,
      reviewFeedback: 'Leftover prose from an earlier legacy run.',
    });
    expect(result.mode).toBe('structured');
    expect(result.legacyFinding).toBeNull();
    expect(result.reviewDispute).toEqual(reviewDispute);
  });

  test('a valid structured block plus residual prose is mixed: both keep their role', () => {
    const reviewDispute = emptyReviewDisputeContext('mixed');
    const result = resolveReviewCompatContext({
      reviewDispute,
      reviewFeedback: 'This prose is not disputable, but it still blocks.',
    });
    expect(result.mode).toBe('mixed');
    expect(result.reviewDispute).toEqual(reviewDispute);
    expect(result.legacyFinding).not.toBeNull();
    expect(result.legacyFinding.disputable).toBe(false);
  });

  test('malformed reviewDispute (unknown field) fails closed rather than being silently upgraded', () => {
    const malformed = { version: 1, reviewStructure: 'structured', lineages: {}, bogusField: true };
    const result = resolveReviewCompatContext({ reviewDispute: malformed, reviewFeedback: 'Fix it.' });
    expect(result.mode).toBe('malformed');
    expect(result.reviewDispute).toBeNull();
    expect(result.malformedReason).toBeTruthy();
    // Fail closed: legacy prose still flows even though the structured block was rejected.
    expect(result.legacyFinding).not.toBeNull();
  });

  test('malformed reviewDispute (unknown reviewStructure enum) fails closed', () => {
    const malformed = { version: 1, reviewStructure: 'bogus', lineages: {} };
    const result = resolveReviewCompatContext({ reviewDispute: malformed });
    expect(result.mode).toBe('malformed');
    expect(result.reviewDispute).toBeNull();
  });

  test('malformed reviewDispute (wrong version) fails closed', () => {
    const malformed = { version: 2, reviewStructure: 'structured', lineages: {} };
    const result = resolveReviewCompatContext({ reviewDispute: malformed });
    expect(result.mode).toBe('malformed');
  });

  test('a malformed block with no legacy prose at all yields no legacy finding either', () => {
    const malformed = { version: 1, reviewStructure: 'structured', lineages: {}, extra: 1 };
    const result = resolveReviewCompatContext({ reviewDispute: malformed });
    expect(result.mode).toBe('malformed');
    expect(result.legacyFinding).toBeNull();
  });
});

describe('resolveReviewCompatContext — repeated conversion / idempotency', () => {
  test('calling twice against the same context yields byte-identical resolutions', () => {
    const context = {
      reviewFeedback: 'Fix the null check.',
      reviewDispute: emptyReviewDisputeContext('mixed'),
    };
    const first = resolveReviewCompatContext(context);
    const second = resolveReviewCompatContext(context);
    expect(second).toEqual(first);
  });

  test('retrying after a transient failure (context untouched) reproduces the same resolution', () => {
    const context = { reviewFeedback: 'Retry me.' };
    const before = resolveReviewCompatContext(context);
    // Simulate a retry: the same context object is read again by a later attempt.
    const after = resolveReviewCompatContext(context);
    expect(after).toEqual(before);
  });

  test('idempotent across the legacy, mixed, and structured shapes alike', () => {
    const shapes = [
      { reviewFeedback: 'Only prose.' },
      { reviewFeedback: 'Prose plus structure.', reviewDispute: emptyReviewDisputeContext('mixed') },
      { reviewDispute: emptyReviewDisputeContext('structured') },
      { reviewDispute: { version: 1, reviewStructure: 'nope', lineages: {} } },
    ];
    for (const context of shapes) {
      expect(resolveReviewCompatContext(context)).toEqual(resolveReviewCompatContext(context));
    }
  });
});

describe('resolveReviewCompatContext — successful new-review replacement', () => {
  test('a legacy-only context is superseded once a later run persists an admitted structured block', () => {
    const legacyContext = { reviewFeedback: 'Old free-form review output.' };
    const before = resolveReviewCompatContext(legacyContext);
    expect(before.mode).toBe('legacy');

    // Issue #841's admission path replaces `reviewDispute` wholesale on the next
    // review; simulate the task-store merge that produces the new context.
    const nextContext = { ...legacyContext, reviewDispute: emptyReviewDisputeContext('structured') };
    const after = resolveReviewCompatContext(nextContext);
    expect(after.mode).toBe('structured');
    expect(after.legacyFinding).toBeNull();
    expect(after.reviewDispute).toEqual(emptyReviewDisputeContext('structured'));
  });

  test('replacement does not delete unrelated context carried alongside it', () => {
    const nextContext = {
      reviewFeedback: 'Old free-form review output.',
      reviewDispute: emptyReviewDisputeContext('structured'),
      prUrl: 'https://github.com/m2dw/test-repo/pull/44',
      branch: 'ai/issue-77',
    };
    resolveReviewCompatContext(nextContext);
    expect(nextContext.prUrl).toBe('https://github.com/m2dw/test-repo/pull/44');
    expect(nextContext.branch).toBe('ai/issue-77');
  });
});

describe('resolveReviewCompatContext — feature-disabled and rollback-compatible reads', () => {
  test('enabled: false ignores an otherwise-valid structured block entirely', () => {
    const context = {
      reviewFeedback: 'Prose.',
      reviewDispute: emptyReviewDisputeContext('structured'),
    };
    const result = resolveReviewCompatContext(context, { enabled: false });
    expect(result).toEqual({ mode: 'disabled', legacyFinding: null, reviewDispute: null });
  });

  test('enabled: false on a rollback context (structured block from before a rollback) is byte-identical to a fresh disabled read', () => {
    const rolledBack = { reviewDispute: emptyReviewDisputeContext('mixed'), reviewFeedback: 'Some prose.' };
    const untouched = { reviewFeedback: undefined };
    expect(resolveReviewCompatContext(rolledBack, { enabled: false })).toEqual(
      resolveReviewCompatContext(untouched, { enabled: false }),
    );
  });

  test('omitting enabled classifies normally (default behaves as enabled)', () => {
    const context = { reviewDispute: emptyReviewDisputeContext('structured') };
    const result = resolveReviewCompatContext(context);
    expect(result.mode).toBe('structured');
  });
});

describe('resolveReviewCompatContext — mode vocabulary', () => {
  test('every mode the resolver can report is in the closed vocabulary', () => {
    expect(REVIEW_COMPAT_MODES).toEqual(['disabled', 'empty', 'legacy', 'mixed', 'structured', 'malformed']);
  });
});
