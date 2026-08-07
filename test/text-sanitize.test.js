/**
 * Unit tests for text-sanitize helpers (extracted from outbox-effects.ts,
 * issue #605, to break the outbox effects/visibility circular dependency).
 */
import {
  boundedExcerpt,
  escapeRawHtml,
  redactApiKeys,
  redactTokens,
  sanitizeBody,
} from '../dist/core/text-sanitize.js';

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

// ---------------------------------------------------------------------------
// redactApiKeys (issue #834): the standalone vendor shapes redactTokens misses,
// for text an agent composed rather than a CLI emitted — a key read out of a
// config file can be named in a sentence with no `token`/`Bearer` introducer.
// ---------------------------------------------------------------------------

describe('redactApiKeys', () => {
  test('redacts a standalone OpenAI-style key with no introducing keyword', () => {
    expect(redactApiKeys('the worker reads sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 at boot')).toBe(
      'the worker reads [redacted] at boot',
    );
    // The shape redactTokens leaves untouched, which is why this helper exists.
    expect(redactTokens('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    );
  });

  test('redacts other well-known vendor key shapes', () => {
    expect(redactApiKeys('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted]');
    expect(redactApiKeys('AIzaSyD-abcdefghijklmnopqrstuvwxyz12345')).toBe('[redacted]');
    expect(redactApiKeys('xoxb-1234567890-abcdefghijkl')).toBe('[redacted]');
    expect(redactApiKeys('glpat-abcdefghijklmnopqrst')).toBe('[redacted]');
    expect(redactApiKeys('sk_live_abcdefghij0123456789')).toBe('[redacted]');
    expect(redactApiKeys(`npm_${'a'.repeat(36)}`)).toBe('[redacted]');
    expect(redactApiKeys('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('[redacted]');
  });

  test('redacts the value of an assignment whose left-hand side names a secret', () => {
    expect(redactApiKeys('api_key = "vT7bQ2xLp9Kd"')).toBe('api_key = "[redacted]"');
    expect(redactApiKeys('client-secret: vT7bQ2xLp9Kd')).toBe('client-secret: [redacted]');
    expect(redactApiKeys('password=hunter2hunter2')).toBe('password=[redacted]');
  });

  test('leaves ordinary prose and repository paths unchanged', () => {
    expect(redactApiKeys('the risk-assessment task-runner was rewritten')).toBe(
      'the risk-assessment task-runner was rewritten',
    );
    expect(redactApiKeys('src/core/api-keys.ts:42')).toBe('src/core/api-keys.ts:42');
    expect(redactApiKeys('the secret is stored in the vault')).toBe('the secret is stored in the vault');
  });
});

// ---------------------------------------------------------------------------
// escapeRawHtml (issue #834): the HTML half of the guarantee closeOpenMarkdownFences
// gives for code fences — untrusted text embedded in a runner-composed document
// must not be able to restructure or hide what the runner appends after it.
// ---------------------------------------------------------------------------

describe('escapeRawHtml', () => {
  test('escapes an unclosed HTML comment so it cannot comment out later sections', () => {
    expect(escapeRawHtml('findings <!-- everything after this is hidden')).toBe(
      'findings &lt;!-- everything after this is hidden',
    );
  });

  test('escapes HTML tags, leaving `>` as ordinary text', () => {
    expect(escapeRawHtml('<div style="display:none">gone</div>')).toBe(
      '&lt;div style="display:none">gone&lt;/div>',
    );
  });

  test('leaves block quotes and comparisons readable', () => {
    // `&lt;` renders as a literal `<`, so prose is unchanged in the reader's view.
    expect(escapeRawHtml('> quoted: a < b')).toBe('> quoted: a &lt; b');
  });

  test('leaves inline code spans as written', () => {
    expect(escapeRawHtml('use `<div>` for layout, not <div>')).toBe(
      'use `<div>` for layout, not &lt;div>',
    );
    expect(escapeRawHtml('``a ` <b>`` then <c>')).toBe('``a ` <b>`` then &lt;c>');
  });

  test('treats an unmatched backtick run as literal text and keeps escaping', () => {
    expect(escapeRawHtml('half `open <b>')).toBe('half `open &lt;b>');
  });

  test('leaves fenced code blocks as written', () => {
    expect(escapeRawHtml('```html\n<div>x</div>\n```\nafter <span>')).toBe(
      '```html\n<div>x</div>\n```\nafter &lt;span>',
    );
    expect(escapeRawHtml('~~~\n<!-- code -->\n~~~')).toBe('~~~\n<!-- code -->\n~~~');
  });

  test('an unterminated fence protects the rest of the field, which the fence repair then closes', () => {
    expect(escapeRawHtml('```\n<!-- inert inside the block')).toBe('```\n<!-- inert inside the block');
  });

  test('leaves text with no angle brackets unchanged', () => {
    expect(escapeRawHtml('nothing to escape here')).toBe('nothing to escape here');
  });
});
