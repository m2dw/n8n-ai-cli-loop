/**
 * Unit tests for the quota/rate-limit classifier and retry-delay resolution
 * (issue #25, provenance-gated per issue #671).
 *
 * `classifyQuotaExhaustion` no longer accepts raw combined output — it only
 * consumes an `AgentFailureDiagnostic` (see agent-diagnostics.test.js for the
 * adapters that build one). These tests exercise the category/signal-matching
 * logic directly against hand-built trusted diagnostics.
 */
import {
  classifyQuotaExhaustion,
  resolveQuotaRetryDelayMs,
  DEFAULT_QUOTA_RETRY_DELAY_MS,
  resolveTransientRetryDelayMs,
  DEFAULT_TRANSIENT_RETRY_DELAY_MS,
  resolveRetryDelayMsForCategory,
  resolveRetryDelayOverrideMsForCategory,
  describeFailureCategory,
} from '../dist/index.js';

function diag(text, agentId, source = 'stderr') {
  return { agentId, source, text, exitCode: 1 };
}

describe('classifyQuotaExhaustion', () => {
  test('detects generic rate-limit / quota signals from a trusted diagnostic', () => {
    const samples = [
      'Error: rate limit exceeded',
      'HTTP 429 Too Many Requests',
      'You have exceeded your quota for this period',
      'usage limit reached for your plan',
      'RESOURCE_EXHAUSTED: quota',
      'The model is overloaded right now',
    ];
    for (const s of samples) {
      const c = classifyQuotaExhaustion(diag(s));
      expect(c.isQuotaExhaustion).toBe(true);
      expect(typeof c.signal).toBe('string');
      expect(c.category).not.toBe('ordinary_failure');
    }
  });

  test('detects quota output for each supported agent', () => {
    expect(classifyQuotaExhaustion(diag('Claude usage limit reached. Your limit will reset at 5pm.', 'claude')).isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion(diag("You've hit your usage limit. Try again later.", 'codex')).isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion(diag('Error: Resource has been exhausted (e.g. check quota).', 'gemini')).isQuotaExhaustion).toBe(true);
  });

  test('matching is case-insensitive', () => {
    expect(classifyQuotaExhaustion(diag('RATE LIMIT EXCEEDED')).isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion(diag('Quota Exceeded', 'gemini')).isQuotaExhaustion).toBe(true);
  });

  test('does NOT classify ordinary errors / non-quota output as quota', () => {
    const samples = [
      'TypeError: cannot read property foo of undefined',
      'git reset --hard failed: pathspec did not match',
      'compilation error in src/index.ts',
      'exited 1: tests failed',
    ];
    for (const s of samples) {
      expect(classifyQuotaExhaustion(diag(s)).isQuotaExhaustion).toBe(false);
    }
    // No diagnostic at all (no trusted source found) is the common case for an
    // ordinary failure — also not quota exhaustion.
    expect(classifyQuotaExhaustion(undefined)).toEqual({ isQuotaExhaustion: false, category: 'ordinary_failure' });
    expect(classifyQuotaExhaustion(diag('', 'claude')).isQuotaExhaustion).toBe(false);
  });

  test('does NOT treat a bare 429 in unrelated output as quota (issue #25 review)', () => {
    const samples = [
      'Fixes #429: refactor the parser',
      'AssertionError at line 429 in src/index.ts',
      'expected 429 but received 200',
      // A generic `error` token before 429 must not count as quota context:
      // this is an ordinary assertion failure, not rate-limit exhaustion.
      'Error: expected 429 but received 200',
      'processed 429 records',
    ];
    for (const s of samples) {
      expect(classifyQuotaExhaustion(diag(s)).isQuotaExhaustion).toBe(false);
    }
  });

  test('detects HTTP 429 only with rate-limit / status context', () => {
    expect(classifyQuotaExhaustion(diag('Error: HTTP 429 returned')).isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion(diag('status code 429 received from API')).isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion(diag('429 too many requests')).isQuotaExhaustion).toBe(true);
  });

  test('returns the first matched signal for diagnostics', () => {
    const c = classifyQuotaExhaustion(diag('boom: too many requests'));
    expect(c.signal).toBe('too many requests');
  });

  test('category precedence: usage_quota > rate_limit > provider_capacity (issue #671)', () => {
    expect(classifyQuotaExhaustion(diag('usage limit reached', 'claude')).category).toBe('usage_quota');
    expect(classifyQuotaExhaustion(diag('HTTP 429 too many requests')).category).toBe('rate_limit');
    expect(classifyQuotaExhaustion(diag('the model is overloaded right now')).category).toBe('provider_capacity');
  });

  test('generic transient phrasing alone is ordinary_failure without adapter-specific evidence (issue #672)', () => {
    // No agent adapter has vetted "try again later"/"try again in" as
    // decisive on its own (docs/phase-contracts.md "Category precedence") —
    // an unrelated tool/subprocess failure can write the same wording to a
    // trusted stderr channel, so it must not be silently upgraded to a
    // retryable category, with or without a known agentId.
    for (const agentId of [undefined, 'claude', 'codex', 'gemini', 'some-other-agent']) {
      const c = classifyQuotaExhaustion(diag('please try again later', agentId));
      expect(c.isQuotaExhaustion).toBe(false);
      expect(c.category).toBe('ordinary_failure');
    }
    expect(classifyQuotaExhaustion(diag('the server said try again in 30s', 'claude')).category).toBe(
      'ordinary_failure',
    );
  });

  test('generic transient phrasing never wins over an explicit category signal (issue #672)', () => {
    // Explicit usage-exhaustion wording still takes precedence even when the
    // same trusted diagnostic also contains generic transient phrasing.
    const c = classifyQuotaExhaustion(diag('usage limit reached, try again later', 'claude'));
    expect(c.category).toBe('usage_quota');
  });

  test('a machine-readable structured code is classifiable the same as text', () => {
    const c = classifyQuotaExhaustion({ agentId: 'claude', source: 'structured', code: 'usage_limit_reached', exitCode: 1 });
    expect(c.isQuotaExhaustion).toBe(true);
    expect(c.category).toBe('usage_quota');
  });
});

describe('resolveQuotaRetryDelayMs', () => {
  test('defaults to 2 hours', () => {
    expect(resolveQuotaRetryDelayMs({})).toBe(DEFAULT_QUOTA_RETRY_DELAY_MS);
    expect(DEFAULT_QUOTA_RETRY_DELAY_MS).toBe(2 * 60 * 60 * 1000);
  });

  test('QUOTA_RETRY_DELAY_HOURS overrides the default', () => {
    expect(resolveQuotaRetryDelayMs({ QUOTA_RETRY_DELAY_HOURS: '2' })).toBe(2 * 60 * 60 * 1000);
  });

  test('QUOTA_RETRY_DELAY_MS takes precedence over hours', () => {
    expect(
      resolveQuotaRetryDelayMs({ QUOTA_RETRY_DELAY_MS: '1000', QUOTA_RETRY_DELAY_HOURS: '99' }),
    ).toBe(1000);
  });

  test('invalid / non-positive values fall back to the default', () => {
    expect(resolveQuotaRetryDelayMs({ QUOTA_RETRY_DELAY_MS: 'abc' })).toBe(DEFAULT_QUOTA_RETRY_DELAY_MS);
    expect(resolveQuotaRetryDelayMs({ QUOTA_RETRY_DELAY_HOURS: '0' })).toBe(DEFAULT_QUOTA_RETRY_DELAY_MS);
    expect(resolveQuotaRetryDelayMs({ QUOTA_RETRY_DELAY_HOURS: '-3' })).toBe(DEFAULT_QUOTA_RETRY_DELAY_MS);
  });
});

describe('resolveTransientRetryDelayMs (issue #671)', () => {
  test('defaults to 5 minutes', () => {
    expect(resolveTransientRetryDelayMs({})).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
    expect(DEFAULT_TRANSIENT_RETRY_DELAY_MS).toBe(5 * 60 * 1000);
  });

  test('TRANSIENT_RETRY_DELAY_MS overrides the default', () => {
    expect(resolveTransientRetryDelayMs({ TRANSIENT_RETRY_DELAY_MS: '1000' })).toBe(1000);
  });

  test('invalid / non-positive values fall back to the default', () => {
    expect(resolveTransientRetryDelayMs({ TRANSIENT_RETRY_DELAY_MS: 'abc' })).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
    expect(resolveTransientRetryDelayMs({ TRANSIENT_RETRY_DELAY_MS: '0' })).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
  });

  test('is much shorter than the usage_quota delay', () => {
    expect(DEFAULT_TRANSIENT_RETRY_DELAY_MS).toBeLessThan(DEFAULT_QUOTA_RETRY_DELAY_MS);
  });
});

describe('resolveRetryDelayMsForCategory (issue #671 review — category-specific retry policy)', () => {
  test('usage_quota gets the long, reset-oriented delay', () => {
    expect(resolveRetryDelayMsForCategory('usage_quota', {})).toBe(DEFAULT_QUOTA_RETRY_DELAY_MS);
    expect(resolveRetryDelayMsForCategory('usage_quota', { QUOTA_RETRY_DELAY_MS: '9999' })).toBe(9999);
  });

  test('rate_limit and provider_capacity get the short transient backoff, not the quota delay', () => {
    expect(resolveRetryDelayMsForCategory('rate_limit', {})).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
    expect(resolveRetryDelayMsForCategory('provider_capacity', {})).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
    expect(resolveRetryDelayMsForCategory('rate_limit', { TRANSIENT_RETRY_DELAY_MS: '4242' })).toBe(4242);
    // A long QUOTA_RETRY_DELAY_MS override must not leak into the transient
    // categories (the P1 review bug this guards against).
    expect(
      resolveRetryDelayMsForCategory('rate_limit', { QUOTA_RETRY_DELAY_MS: String(DEFAULT_QUOTA_RETRY_DELAY_MS) }),
    ).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
  });

  test('a trusted HTTP 429 diagnostic resolves to the short transient delay end-to-end', () => {
    const c = classifyQuotaExhaustion({ agentId: 'claude', source: 'stderr', text: 'HTTP 429 too many requests', exitCode: 1 });
    expect(c.category).toBe('rate_limit');
    expect(resolveRetryDelayMsForCategory(c.category, {})).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
  });
});

describe('resolveRetryDelayOverrideMsForCategory (issue #672 review — preserve the runner-level quota override)', () => {
  test('usage_quota resolves to undefined so handlers never override the runner-level quotaRetryDelayMs', () => {
    expect(resolveRetryDelayOverrideMsForCategory('usage_quota', {})).toBeUndefined();
    expect(resolveRetryDelayOverrideMsForCategory('usage_quota', { QUOTA_RETRY_DELAY_MS: '9999' })).toBeUndefined();
  });

  test('rate_limit and provider_capacity still resolve to the short transient backoff', () => {
    expect(resolveRetryDelayOverrideMsForCategory('rate_limit', {})).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
    expect(resolveRetryDelayOverrideMsForCategory('provider_capacity', {})).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
    expect(resolveRetryDelayOverrideMsForCategory('rate_limit', { TRANSIENT_RETRY_DELAY_MS: '4242' })).toBe(4242);
  });
});

describe('describeFailureCategory (issue #672 — category-appropriate wording)', () => {
  test('produces a distinct, human-readable label per category', () => {
    expect(describeFailureCategory('usage_quota')).toBe('usage quota');
    expect(describeFailureCategory('rate_limit')).toBe('rate limit');
    expect(describeFailureCategory('provider_capacity')).toBe('provider capacity');
  });

  test('provider_capacity is never worded as usage quota exhaustion (issue #672)', () => {
    // The whole point of a distinct label: a provider_capacity failure must
    // never be described using the word "quota", or a public comment/task
    // event would falsely claim the caller exhausted their own usage window.
    expect(describeFailureCategory('provider_capacity')).not.toMatch(/quota/i);
    expect(describeFailureCategory('rate_limit')).not.toMatch(/quota/i);
  });
});
