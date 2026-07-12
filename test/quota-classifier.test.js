/**
 * Unit tests for the quota/rate-limit classifier and retry-delay resolution
 * (issue #25).
 */
import {
  classifyQuotaExhaustion,
  resolveQuotaRetryDelayMs,
  DEFAULT_QUOTA_RETRY_DELAY_MS,
} from '../dist/index.js';

describe('classifyQuotaExhaustion', () => {
  test('detects generic rate-limit / quota signals', () => {
    const samples = [
      'Error: rate limit exceeded',
      'HTTP 429 Too Many Requests',
      'You have exceeded your quota for this period',
      'usage limit reached for your plan',
      'please try again later',
      'RESOURCE_EXHAUSTED: quota',
      'The model is overloaded right now',
    ];
    for (const s of samples) {
      const c = classifyQuotaExhaustion(s);
      expect(c.isQuotaExhaustion).toBe(true);
      expect(typeof c.signal).toBe('string');
    }
  });

  test('detects quota output for each supported agent', () => {
    // One realistic message per agent, including agent-specific phrasing.
    expect(classifyQuotaExhaustion('Claude usage limit reached. Your limit will reset at 5pm.', 'claude').isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion("You've hit your usage limit. Try again later.", 'codex').isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion('Error: Resource has been exhausted (e.g. check quota).', 'gemini').isQuotaExhaustion).toBe(true);
  });

  test('matching is case-insensitive', () => {
    expect(classifyQuotaExhaustion('RATE LIMIT EXCEEDED').isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion('Quota Exceeded', 'gemini').isQuotaExhaustion).toBe(true);
  });

  test('does NOT classify ordinary errors / non-quota output as quota', () => {
    const samples = [
      '',
      undefined,
      'TypeError: cannot read property foo of undefined',
      'git reset --hard failed: pathspec did not match',
      'compilation error in src/index.ts',
      'exited 1: tests failed',
    ];
    for (const s of samples) {
      expect(classifyQuotaExhaustion(s).isQuotaExhaustion).toBe(false);
    }
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
      expect(classifyQuotaExhaustion(s).isQuotaExhaustion).toBe(false);
    }
  });

  test('detects HTTP 429 only with rate-limit / status context', () => {
    expect(classifyQuotaExhaustion('Error: HTTP 429 returned').isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion('status code 429 received from API').isQuotaExhaustion).toBe(true);
    expect(classifyQuotaExhaustion('429 too many requests').isQuotaExhaustion).toBe(true);
  });

  test('returns the first matched signal for diagnostics', () => {
    const c = classifyQuotaExhaustion('boom: too many requests');
    expect(c.signal).toBe('too many requests');
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
