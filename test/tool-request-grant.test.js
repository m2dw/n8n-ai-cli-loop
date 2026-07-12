import {
  normalizeCommand,
  hashCommand,
  createToolRequestGrant,
  grantStatus,
  grantMatches,
  GRANT_DEFAULT_MAX_USES,
  GRANT_DEFAULT_TTL_MS,
} from '../dist/index.js';

// Issue #301 — scoped Tool Request grants. These cover the pure grant logic:
// creation, exact-command hashing/matching, and expiry/reuse prevention.

const NOW = '2026-06-20T00:00:00.000Z';

function baseGrant(overrides = {}) {
  return createToolRequestGrant({
    sessionId: 'addon-dev',
    issueNumber: 123,
    phase: 'implementation',
    repoRoot: '/repo',
    command: 'npm install left-pad',
    displayCommand: 'npm install left-pad',
    grantedBy: 'admin',
    now: NOW,
    ...overrides,
  });
}

function candidate(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: 123,
    phase: 'implementation',
    repoRoot: '/repo',
    command: 'npm install left-pad',
    ...overrides,
  };
}

describe('tool-request-grant — normalize & hash', () => {
  test('normalizeCommand trims and collapses internal whitespace', () => {
    expect(normalizeCommand('  npm   install    left-pad  ')).toBe('npm install left-pad');
  });

  test('hashCommand is stable across insignificant whitespace differences', () => {
    expect(hashCommand('npm  install   left-pad')).toBe(hashCommand('npm install left-pad'));
  });

  test('hashCommand differs for a different command (even a superset)', () => {
    expect(hashCommand('npm install left-pad')).not.toBe(hashCommand('npm install left-pad --save-dev'));
  });

  test('normalizeCommand preserves whitespace inside quoted arguments', () => {
    // Only insignificant (unquoted, token-separating) whitespace is collapsed;
    // whitespace inside quotes is part of the argument value and must survive.
    expect(normalizeCommand('  printf   "a    b"  ')).toBe('printf "a    b"');
    expect(normalizeCommand("echo   'x   y'")).toBe("echo 'x   y'");
  });

  test('normalizeCommand preserves backslash-escaped whitespace', () => {
    expect(normalizeCommand('printf  a\\ b')).toBe('printf a\\ b');
  });

  test('normalizeCommand keeps an escaped double quote inside double quotes', () => {
    // `\"` is a literal quote, not the end of the quoted region, so the spaces
    // after it stay inside the quotes and are preserved verbatim. Reading the
    // `\"` as a close quote would collapse them as unquoted separators.
    expect(normalizeCommand('printf "a\\"    b"')).toBe('printf "a\\"    b"');
    // A real close quote followed by unquoted whitespace still collapses.
    expect(normalizeCommand('printf "a"   b')).toBe('printf "a" b');
  });

  test('hashCommand keeps quoted-whitespace-sensitive commands distinct', () => {
    // Without quote-aware normalization these would collapse to the same hash,
    // letting an operator-supplied --command match a different exact command.
    expect(hashCommand('printf "a    b"')).not.toBe(hashCommand('printf "a b"'));
    // An escaped quote must not let differing in-quote whitespace collapse to the
    // same hash (the spaces reach `/bin/sh -c` as part of the argument value).
    expect(hashCommand('printf "a\\"    b"')).not.toBe(hashCommand('printf "a\\" b"'));
  });

  test('normalizeCommand preserves unquoted newlines as command separators', () => {
    // `/bin/sh -c` parses an unquoted newline as a command terminator, so a
    // two-command script must not normalize to a single-command line.
    expect(normalizeCommand('cmd1\ncmd2')).toBe('cmd1\ncmd2');
    // Surrounding space/tab still collapses, but the newline itself survives.
    expect(normalizeCommand('cmd1 \t cmd2')).toBe('cmd1 cmd2');
  });

  test('hashCommand keeps newline-separated commands distinct from space-joined', () => {
    // `cmd1\ncmd2` runs two commands; `cmd1 cmd2` runs one. Collapsing the
    // newline would let an operator-supplied --command whose newlines were
    // stripped match a materially different command, defeating exact scoping.
    expect(hashCommand('cmd1\ncmd2')).not.toBe(hashCommand('cmd1 cmd2'));
  });
});

describe('tool-request-grant — creation', () => {
  test('builds an unused, scoped, time-boxed grant from the approved command', () => {
    const g = baseGrant();
    expect(g).toMatchObject({
      sessionId: 'addon-dev',
      issueNumber: 123,
      phase: 'implementation',
      repoRoot: '/repo',
      command: 'npm install left-pad',
      displayCommand: 'npm install left-pad',
      grantedBy: 'admin',
      grantedAt: NOW,
      uses: 0,
      maxUses: GRANT_DEFAULT_MAX_USES,
    });
    expect(g.commandHash).toBe(hashCommand('npm install left-pad'));
    expect(new Date(g.expiresAt).getTime()).toBe(new Date(NOW).getTime() + GRANT_DEFAULT_TTL_MS);
  });

  test('honors a custom ttlMs and maxUses', () => {
    const g = baseGrant({ ttlMs: 5000, maxUses: 3 });
    expect(g.maxUses).toBe(3);
    expect(new Date(g.expiresAt).getTime()).toBe(new Date(NOW).getTime() + 5000);
  });

  test('clamps an out-of-range maxUses to the ceiling and a bad ttl to a floor', () => {
    const g = baseGrant({ maxUses: 9999, ttlMs: -1 });
    expect(g.maxUses).toBeLessThanOrEqual(10);
    expect(new Date(g.expiresAt).getTime()).toBeGreaterThan(new Date(NOW).getTime());
  });
});

describe('tool-request-grant — status', () => {
  test('active before expiry and use', () => {
    expect(grantStatus(baseGrant(), NOW)).toBe('active');
  });

  test('expired once now passes expiresAt', () => {
    const g = baseGrant({ ttlMs: 1000 });
    expect(grantStatus(g, '2026-06-20T01:00:00.000Z')).toBe('expired');
  });

  test('exhausted once uses reaches maxUses', () => {
    const g = { ...baseGrant(), uses: 1, maxUses: 1 };
    expect(grantStatus(g, NOW)).toBe('exhausted');
  });
});

describe('tool-request-grant — matching', () => {
  test('authorizes a candidate that matches every scope field', () => {
    expect(grantMatches(baseGrant(), candidate(), NOW)).toEqual({ ok: true });
  });

  test('tolerates insignificant whitespace in the candidate command', () => {
    expect(grantMatches(baseGrant(), candidate({ command: 'npm   install  left-pad' }), NOW)).toEqual({ ok: true });
  });

  test.each([
    ['different session', { sessionId: 'other' }],
    ['different issue', { issueNumber: 999 }],
    ['different phase', { phase: 'review' }],
    ['different repo root', { repoRoot: '/other-repo' }],
    ['different command', { command: 'npm install left-pad --save-dev' }],
  ])('rejects a %s as scope-mismatch', (_label, override) => {
    const r = grantMatches(baseGrant(), candidate(override), NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('scope-mismatch');
  });

  test('rejects an expired grant (reuse over time prevented)', () => {
    const g = baseGrant({ ttlMs: 1000 });
    const r = grantMatches(g, candidate(), '2026-06-20T01:00:00.000Z');
    expect(r).toMatchObject({ ok: false, reason: 'expired' });
  });

  test('rejects an exhausted grant (cannot be reused indefinitely)', () => {
    const g = { ...baseGrant(), uses: 1, maxUses: 1 };
    const r = grantMatches(g, candidate(), NOW);
    expect(r).toMatchObject({ ok: false, reason: 'exhausted' });
  });

  test('reports scope-mismatch before lifetime for a non-matching expired grant', () => {
    const g = baseGrant({ ttlMs: 1000 });
    const r = grantMatches(g, candidate({ issueNumber: 999 }), '2026-06-20T01:00:00.000Z');
    expect(r).toMatchObject({ ok: false, reason: 'scope-mismatch' });
  });
});
