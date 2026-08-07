/**
 * Cursor-key derivation tests (issue #819).
 *
 * The persisted outbox scan cursors are addressed by a derived `scan_key`. A
 * collision between two keys is not a cosmetic bug: one dispatch identity would
 * read another's cursor and permanently skip its own older pending rows via
 * `id > afterId`. These tests pin the two injectivity claims of
 * docs/outbox-scan-cursor-contract.md §4 and the byte-level compatibility claim
 * of §11.
 */
import {
  OUTBOX_SCAN_CURSOR_ROLES,
  deriveOwnershipScanCursorKey,
  deriveScanCursorKey,
  isDerivedScanCursorKey,
  scanCursorKeysFor,
} from '../dist/core/outbox-scan-cursor.js';

describe('deriveScanCursorKey — role keys', () => {
  test('floor is the dispatch identity verbatim', () => {
    expect(deriveScanCursorKey('session-a', 'floor')).toBe('session-a');
  });

  test('fwd and bulk are length-prefixed and role-suffixed', () => {
    expect(deriveScanCursorKey('session-a', 'fwd')).toBe('9:session-a:fwd');
    expect(deriveScanCursorKey('session-a', 'bulk')).toBe('9:session-a:bulk');
  });

  test('the three roles produce three distinct keys', () => {
    const keys = OUTBOX_SCAN_CURSOR_ROLES.map((role) => deriveScanCursorKey('s', role));
    expect(new Set(keys).size).toBe(3);
  });

  test('scanCursorKeysFor returns the same keys as the per-role derivation', () => {
    expect(scanCursorKeysFor('s')).toEqual({
      floor: deriveScanCursorKey('s', 'floor'),
      fwd: deriveScanCursorKey('s', 'fwd'),
      bulk: deriveScanCursorKey('s', 'bulk'),
    });
  });

  test('derivation is stable across calls', () => {
    expect(deriveScanCursorKey('x:y:z', 'bulk')).toBe(deriveScanCursorKey('x:y:z', 'bulk'));
  });
});

describe('deriveScanCursorKey — collision resistance', () => {
  // The adversarial pair that motivated the length prefix: with a plain
  // suffix, `foo`'s fwd key (`foo::fwd`) would equal `foo::fwd`'s own floor
  // key, so the second identity would read the first identity's cursor.
  test('an identity that looks like another identity plus a role suffix does not collide', () => {
    const victim = deriveScanCursorKey('foo', 'fwd');
    const attacker = deriveScanCursorKey('foo::fwd', 'floor');
    expect(victim).not.toBe(attacker);
  });

  test('every (identity, role) pair over adversarial identities yields a distinct key', () => {
    const identities = [
      'foo',
      'foo:',
      'foo::',
      'foo::fwd',
      'foo::bulk',
      '3:foo:fw',
      '01:x:fwd',
      'fo',
      'fooo',
      ':',
      'session-a',
      'session-a:',
      JSON.stringify(['s', 'o', 'r', null, null, null]),
      JSON.stringify(['s', 'o', 'r', 'go', 'gr', 'https://g.example']),
    ];
    const keys = identities.flatMap((identity) =>
      OUTBOX_SCAN_CURSOR_ROLES.map((role) => deriveScanCursorKey(identity, role)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Without this rejection, identity `3:foo:fwd` would own the same persisted
  // row as identity `foo`'s fwd cursor — a floor key is the identity verbatim,
  // so its key space is otherwise "any string".
  test('an identity that already has the derived-key shape is rejected, for every role', () => {
    for (const bad of ['3:foo:fwd', '3:foo:bulk', '0::fwd', '10:0123456789:bulk']) {
      for (const role of OUTBOX_SCAN_CURSOR_ROLES) {
        expect(() => deriveScanCursorKey(bad, role)).toThrow(/derived-key shape/);
      }
    }
  });

  test('an empty identity is rejected', () => {
    expect(() => deriveScanCursorKey('', 'floor')).toThrow(/nonempty/);
  });

  test('isDerivedScanCursorKey recognizes exactly what the derivation produces', () => {
    for (const identity of ['a', 'a:b', 'foo::fwd', '[]', '5:x:fwd:']) {
      expect(isDerivedScanCursorKey(deriveScanCursorKey(identity, 'fwd'))).toBe(true);
      expect(isDerivedScanCursorKey(deriveScanCursorKey(identity, 'bulk'))).toBe(true);
    }
    // Not producible by the derivation, so not a collision risk.
    for (const other of ['foo', '3:foo:other', '3:fooo:fwd', '4:foo:fwd', '01:x:fwd', ':x:fwd', 'x:fwd']) {
      expect(isDerivedScanCursorKey(other)).toBe(false);
    }
  });

  test('a derived key is recoverable: the length prefix delimits the identity', () => {
    // Injectivity restated operationally — the identity can be read back out of
    // the derived key without knowing where it ends, which is exactly what a
    // plain suffix cannot offer.
    for (const identity of ['a', 'a:b', '5:x:fwd:', 'foo::fwd']) {
      for (const role of ['fwd', 'bulk']) {
        const key = deriveScanCursorKey(identity, role);
        const colon = key.indexOf(':');
        const len = Number(key.slice(0, colon));
        expect(key.slice(colon + 1, colon + 1 + len)).toBe(identity);
        expect(key.slice(colon + 1 + len)).toBe(`:${role}`);
      }
    }
  });
});

describe('deriveOwnershipScanCursorKey — ownership scope', () => {
  const base = { sessionId: 's', githubOwner: 'org', githubName: 'repo' };

  test('is byte-identical to the pre-#819 inline tuple encoding', () => {
    // Compatibility claim of §11: existing persisted cursor rows must keep
    // resolving, which they only do while this encoding is unchanged.
    expect(deriveOwnershipScanCursorKey(base)).toBe(
      JSON.stringify(['s', 'org', 'repo', null, null, null]),
    );
    expect(
      deriveOwnershipScanCursorKey({
        ...base,
        gitea: { owner: 'gorg', repo: 'grepo', baseUrl: 'https://gitea.example.com' },
      }),
    ).toBe(JSON.stringify(['s', 'org', 'repo', 'gorg', 'grepo', 'https://gitea.example.com']));
  });

  test('changing any scope component changes the key', () => {
    const scopes = [
      base,
      { ...base, sessionId: 's2' },
      { ...base, githubOwner: 'org2' },
      { ...base, githubName: 'repo2' },
      { ...base, gitea: { owner: 'g', repo: 'r', baseUrl: 'https://a.example' } },
      { ...base, gitea: { owner: 'g', repo: 'r', baseUrl: 'https://b.example' } },
      { ...base, gitea: { owner: 'g', repo: 'r2', baseUrl: 'https://a.example' } },
      { ...base, gitea: { owner: 'g2', repo: 'r', baseUrl: 'https://a.example' } },
    ];
    const keys = scopes.map(deriveOwnershipScanCursorKey);
    expect(new Set(keys).size).toBe(scopes.length);
  });

  test('components containing quotes, commas or brackets cannot forge another scope', () => {
    const a = deriveOwnershipScanCursorKey({ ...base, sessionId: 's","org' });
    const b = deriveOwnershipScanCursorKey({ ...base, sessionId: 's', githubOwner: '","org' });
    expect(a).not.toBe(b);
    const c = deriveOwnershipScanCursorKey({ ...base, sessionId: '["s","org","repo"]' });
    expect(c).not.toBe(deriveOwnershipScanCursorKey(base));
  });

  test('a missing gitea block is distinct from a gitea block of literal "null" strings', () => {
    expect(deriveOwnershipScanCursorKey(base)).not.toBe(
      deriveOwnershipScanCursorKey({ ...base, gitea: { owner: 'null', repo: 'null', baseUrl: 'null' } }),
    );
  });

  test('the same scope always derives the same key', () => {
    expect(deriveOwnershipScanCursorKey({ ...base })).toBe(deriveOwnershipScanCursorKey({ ...base }));
  });
});

describe('cross-role key spaces are disjoint for supported ownership scopes', () => {
  // §4.5: a floor key is an ownership identity verbatim (a JSON array, first
  // byte `[`); a derived key always starts with a decimal digit. So no floor
  // key of any supported scope can ever equal any other scope's fwd/bulk key.
  const scopes = [
    { sessionId: 's', githubOwner: 'org', githubName: 'repo' },
    { sessionId: '3:s:fwd', githubOwner: 'org', githubName: 'repo' },
    {
      sessionId: 's',
      githubOwner: 'org',
      githubName: 'repo',
      gitea: { owner: 'g', repo: 'r', baseUrl: 'https://gitea.example.com' },
    },
  ];

  test('ownership identities start with "[" and derived keys start with a digit', () => {
    for (const scope of scopes) {
      const identity = deriveOwnershipScanCursorKey(scope);
      expect(identity.startsWith('[')).toBe(true);
      expect(deriveScanCursorKey(identity, 'fwd')).toMatch(/^[0-9]/);
      expect(deriveScanCursorKey(identity, 'bulk')).toMatch(/^[0-9]/);
    }
  });

  test('all keys across all supported scopes and roles are distinct', () => {
    const keys = scopes.flatMap((scope) => {
      const identity = deriveOwnershipScanCursorKey(scope);
      return OUTBOX_SCAN_CURSOR_ROLES.map((role) => deriveScanCursorKey(identity, role));
    });
    expect(new Set(keys).size).toBe(keys.length);
  });
});
