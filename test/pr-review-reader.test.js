import { describe, test, expect } from '@jest/globals';
import { prReviewReaderFromGhRunner } from '../dist/cli/pr-review-reader.js';

// A GhRunner stub that returns canned stdout per subcommand. `pr view` resolves
// the selector + state; the REST `api` calls are paged one request at a time
// (`&page=N`) and return a flat JSON array per page. The full dataset is served
// on page 1; later pages return `[]` so the reader's loop stops.
function makeRunner({ viewJson, reviews = [], comments = [] }) {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') {
        return { exitCode: 0, stdout: JSON.stringify(viewJson), stderr: '' };
      }
      if (args[0] === 'api') {
        const path = args[1];
        const page = path.includes('/reviews') ? reviews : comments;
        // The reader appends `&page=N`; serve the dataset once, then empty pages.
        const isFirstPage = /[?&]page=1(?:&|$)/.test(path);
        return { exitCode: 0, stdout: JSON.stringify(isFirstPage ? page : []), stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected gh args: ${args.join(' ')}` };
    },
  };
}

describe('prReviewReaderFromGhRunner: PR state guard', () => {
  test('reads reviews when the PR is open', () => {
    const runner = makeRunner({
      viewJson: { number: 42, url: 'https://example/pull/42', state: 'OPEN' },
      reviews: [
        { id: 7, user: { login: 'alice', type: 'User' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-02-01T00:00:00Z' },
      ],
    });
    const reader = prReviewReaderFromGhRunner(runner);
    const data = reader.readPrReviews('owner/name', '42');
    expect(data.prNumber).toBe(42);
    expect(data.reviews).toHaveLength(1);
    expect(data.reviews[0].id).toBe('7');
  });

  test('throws for a closed PR without reading reviews', () => {
    const runner = makeRunner({
      viewJson: { number: 42, url: 'https://example/pull/42', state: 'CLOSED' },
    });
    const reader = prReviewReaderFromGhRunner(runner);
    expect(() => reader.readPrReviews('owner/name', '42')).toThrow(/not open/i);
    // Only `pr view` should have run — no REST review/comment reads.
    expect(runner.calls.every((c) => c[0] === 'pr')).toBe(true);
  });

  test('throws for a merged PR', () => {
    const runner = makeRunner({
      viewJson: { number: 42, url: 'https://example/pull/42', state: 'MERGED' },
    });
    const reader = prReviewReaderFromGhRunner(runner);
    expect(() => reader.readPrReviews('owner/name', '42')).toThrow(/not open/i);
  });

  test('requests the state field from gh pr view', () => {
    const runner = makeRunner({
      viewJson: { number: 42, url: 'https://example/pull/42', state: 'OPEN' },
    });
    prReviewReaderFromGhRunner(runner).readPrReviews('owner/name', '42');
    const viewCall = runner.calls.find((c) => c[0] === 'pr' && c[1] === 'view');
    const jsonIdx = viewCall.indexOf('--json');
    expect(viewCall[jsonIdx + 1]).toContain('state');
  });
});
