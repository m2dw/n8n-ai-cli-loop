/**
 * Post-create PR reconciliation decision (issue #998).
 *
 * The pure half of "the PR already exists": given the open pull requests the
 * repo host reports for the exact head this run pushed, may the run adopt one
 * and continue through the normal success transition? Every check here fails
 * closed — adopting the wrong PR would attach this run's commits to someone
 * else's review — and none of them reads the host's human-facing error prose.
 */
import { reconcileExistingPullRequest, repoSlugFromPrUrl } from '../dist/index.js';
import { adoptExistingPrForHead } from '../dist/handlers/pr-helpers.js';

const EXPECTED = {
  issueNumber: 975,
  head: 'ai/issue-975',
  base: 'main',
  repo: 'm2dw/n8n-ai-cli-loop-ai',
};

// The reproduction case: PR #997, open on `ai/issue-975` into `main`.
const LIVE_PR = {
  number: 997,
  url: 'https://github.com/m2dw/n8n-ai-cli-loop-ai/pull/997',
  headRefName: 'ai/issue-975',
  state: 'OPEN',
  baseRefName: 'main',
};

describe('reconcileExistingPullRequest — adoption', () => {
  test('adopts the single matching open PR on the expected head and base', () => {
    expect(reconcileExistingPullRequest([LIVE_PR], EXPECTED)).toEqual({
      kind: 'adopt',
      url: LIVE_PR.url,
      headRefName: 'ai/issue-975',
      number: 997,
    });
  });

  test('accepts a lowercase provider state (Gitea reports "open", GitHub "OPEN")', () => {
    const decision = reconcileExistingPullRequest(
      [{ ...LIVE_PR, state: 'open', url: 'https://gitea.example.com/m2dw/n8n-ai-cli-loop-ai/pulls/997' }],
      EXPECTED,
    );
    expect(decision.kind).toBe('adopt');
    expect(decision.url).toBe('https://gitea.example.com/m2dw/n8n-ai-cli-loop-ai/pulls/997');
  });

  test('an explicitly same-repository head (isCrossRepository:false) is adoptable', () => {
    expect(reconcileExistingPullRequest([{ ...LIVE_PR, isCrossRepository: false }], EXPECTED).kind).toBe('adopt');
  });

  test('trims the recorded URL and omits a number the provider did not report', () => {
    const decision = reconcileExistingPullRequest([{ ...LIVE_PR, number: 0, url: `  ${LIVE_PR.url}  ` }], EXPECTED);
    expect(decision).toEqual({ kind: 'adopt', url: LIVE_PR.url, headRefName: 'ai/issue-975' });
  });
});

describe('reconcileExistingPullRequest — fails closed', () => {
  const refusal = (candidates, expected = EXPECTED) => reconcileExistingPullRequest(candidates, expected);

  test('no candidates → no-match (the ordinary "creation genuinely failed" case)', () => {
    const decision = refusal([]);
    expect(decision.kind).toBe('refuse');
    expect(decision.reason).toBe('no-match');
  });

  test('two open PRs on the same head → ambiguous, naming both URLs', () => {
    const decision = refusal([LIVE_PR, { ...LIVE_PR, number: 998, url: 'https://github.com/m2dw/n8n-ai-cli-loop-ai/pull/998' }]);
    expect(decision.reason).toBe('ambiguous');
    expect(decision.message).toMatch(/pull\/997/);
    expect(decision.message).toMatch(/pull\/998/);
  });

  test('a different head → head-mismatch', () => {
    const decision = refusal([{ ...LIVE_PR, headRefName: 'ai/issue-974' }]);
    expect(decision.reason).toBe('head-mismatch');
    expect(decision.message).toMatch(/ai\/issue-974/);
  });

  test('a closed or merged PR → not-open', () => {
    expect(refusal([{ ...LIVE_PR, state: 'CLOSED' }]).reason).toBe('not-open');
    expect(refusal([{ ...LIVE_PR, state: 'MERGED' }]).reason).toBe('not-open');
  });

  test('an unreported state is NOT treated as open', () => {
    const decision = refusal([{ ...LIVE_PR, state: undefined }]);
    expect(decision.reason).toBe('not-open');
    expect(decision.message).toMatch(/unconfirmed state/);
  });

  test('a fork head → cross-repository', () => {
    expect(refusal([{ ...LIVE_PR, isCrossRepository: true }]).reason).toBe('cross-repository');
  });

  test('a PR URL in another repository → repository-mismatch', () => {
    const decision = refusal([{ ...LIVE_PR, url: 'https://github.com/someone/fork/pull/997' }]);
    expect(decision.reason).toBe('repository-mismatch');
    expect(decision.message).toMatch(/someone\/fork/);
  });

  test('a missing or unrecognizable URL → unusable-url', () => {
    expect(refusal([{ ...LIVE_PR, url: undefined }]).reason).toBe('unusable-url');
    expect(refusal([{ ...LIVE_PR, url: '   ' }]).reason).toBe('unusable-url');
    expect(refusal([{ ...LIVE_PR, url: 'https://github.com/m2dw/n8n-ai-cli-loop-ai/issues/975' }]).reason).toBe('unusable-url');
  });

  test('a PR targeting the wrong base → base-mismatch, naming the configured base', () => {
    const decision = refusal([{ ...LIVE_PR, baseRefName: 'develop' }]);
    expect(decision.reason).toBe('base-mismatch');
    expect(decision.message).toMatch(/develop/);
    expect(decision.message).toMatch(/"main"/);
  });

  test('an unreported base is NOT assumed to be the configured one', () => {
    expect(refusal([{ ...LIVE_PR, baseRefName: undefined }]).reason).toBe('base-mismatch');
  });

  test('a non-default configured base is honored', () => {
    const expected = { ...EXPECTED, base: 'develop' };
    expect(refusal([LIVE_PR], expected).reason).toBe('base-mismatch');
    expect(refusal([{ ...LIVE_PR, baseRefName: 'develop' }], expected).kind).toBe('adopt');
  });

  test('every refusal message names the issue, head and base so an operator can act', () => {
    for (const candidates of [[], [{ ...LIVE_PR, state: 'CLOSED' }], [{ ...LIVE_PR, baseRefName: 'develop' }]]) {
      const decision = refusal(candidates);
      expect(decision.message).toMatch(/issue #975/);
      expect(decision.message).toMatch(/ai\/issue-975/);
      expect(decision.message).toMatch(/main/);
    }
  });
});

describe('repoSlugFromPrUrl', () => {
  test('reads the owner/name slug from GitHub and Gitea PR URLs', () => {
    expect(repoSlugFromPrUrl('https://github.com/m2dw/test-repo/pull/7')).toBe('m2dw/test-repo');
    expect(repoSlugFromPrUrl('https://gitea.example.com/acme/code/pulls/7')).toBe('acme/code');
  });

  test('returns undefined for a non-PR URL', () => {
    expect(repoSlugFromPrUrl('https://github.com/m2dw/test-repo/issues/7')).toBeUndefined();
    expect(repoSlugFromPrUrl('nonsense')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// adoptExistingPrForHead — the provider-facing wrapper
// ---------------------------------------------------------------------------

function fakeHost(listing) {
  const calls = [];
  return {
    calls,
    findOpenPullRequestsByHead(head) {
      calls.push(head);
      return listing;
    },
  };
}

describe('adoptExistingPrForHead', () => {
  test('queries the EXACT expected head and adopts the single live PR', () => {
    const host = fakeHost({ ok: true, value: [LIVE_PR] });
    expect(adoptExistingPrForHead(host, EXPECTED)).toEqual({
      kind: 'adopted',
      url: LIVE_PR.url,
      headRefName: 'ai/issue-975',
      number: 997,
    });
    expect(host.calls).toEqual(['ai/issue-975']);
  });

  test('a lookup failure is a refusal — never read as "no PR exists"', () => {
    const host = fakeHost({ ok: false, error: 'gh pr list failed (exit 1): auth error' });
    const result = adoptExistingPrForHead(host, EXPECTED);
    expect(result.kind).toBe('refused');
    expect(result.reason).toBe('lookup-failed');
    expect(result.error).toMatch(/auth error/);
  });

  test('carries the pure decision refusal reason through unchanged', () => {
    const host = fakeHost({ ok: true, value: [{ ...LIVE_PR, state: 'CLOSED' }] });
    const result = adoptExistingPrForHead(host, EXPECTED);
    expect(result.kind).toBe('refused');
    expect(result.reason).toBe('not-open');
  });
});
