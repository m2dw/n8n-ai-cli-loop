/**
 * Unit tests for text-sanitize helpers (extracted from outbox-effects.ts,
 * issue #605, to break the outbox effects/visibility circular dependency).
 */
import { boundedExcerpt, sanitizeBody, redactTokens } from '../dist/core/text-sanitize.js';

describe('boundedExcerpt', () => {
  test('returns text unchanged when within maxChars', () => {
    expect(boundedExcerpt('hello', 10)).toBe('hello');
  });

  test('returns text unchanged when exactly maxChars', () => {
    expect(boundedExcerpt('hello', 5)).toBe('hello');
  });

  test('truncates and appends an ellipsis marker when over maxChars', () => {
    expect(boundedExcerpt('hello world', 5)).toBe('hello\n\n…(truncated)');
  });
});

describe('sanitizeBody', () => {
  test('redacts absolute Unix paths under known top-level roots', () => {
    expect(sanitizeBody('see /Users/jane/project/file.ts for details')).toBe(
      'see <path> for details',
    );
  });

  test('redacts file:// URLs', () => {
    expect(sanitizeBody('open file:///tmp/artifact/log.txt now')).toBe('open <path> now');
  });

  test('redacts Windows absolute paths', () => {
    expect(sanitizeBody('see C:\\Users\\jane\\file.txt then retry')).toBe(
      'see <path> then retry',
    );
  });

  test('redacts explicitly configured absolute paths and their sub-paths', () => {
    expect(sanitizeBody('root at /customroot/sub/dir', ['/customroot'])).toBe('root at <path>');
  });

  test('does not redact an unconfigured, non-standard absolute path', () => {
    expect(sanitizeBody('root at /customroot/sub/dir')).toBe('root at /customroot/sub/dir');
  });

  test('leaves text with no paths unchanged', () => {
    expect(sanitizeBody('nothing to redact here')).toBe('nothing to redact here');
  });
});

describe('redactTokens', () => {
  test('redacts a GitHub App/PAT-style token', () => {
    expect(redactTokens('auth failed: ghp_abcdefghijklmnopqrst1234')).toBe('auth failed: [redacted]');
  });

  test('redacts a github_pat_ token', () => {
    expect(redactTokens('token github_pat_11ABCDEFG0123456789abcdefghijklmnop')).toBe('token [redacted]');
  });

  test('redacts a 40-char hex token (e.g. Gitea access token)', () => {
    expect(redactTokens(`key: ${'a'.repeat(40)}`)).toBe('key: [redacted]');
  });

  test('redacts a 40-char uppercase/mixed-case hex token', () => {
    expect(redactTokens(`key: ${'A'.repeat(40)}`)).toBe('key: [redacted]');
    expect(redactTokens(`key: ${'aB3f'.repeat(10)}`)).toBe('key: [redacted]');
  });

  test('redacts a Bearer header value', () => {
    expect(redactTokens('Authorization: Bearer abcdef123456789xyz')).toBe('Authorization: Bearer [redacted]');
  });

  test('leaves text with no tokens unchanged', () => {
    expect(redactTokens('gh api failed: 404 not found')).toBe('gh api failed: 404 not found');
  });
});
