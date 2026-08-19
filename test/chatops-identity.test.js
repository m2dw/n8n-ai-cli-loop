/**
 * Contract tests for ChatOps provider identity and state namespace
 * (issue #780) — docs/chatops-identity-contract.md.
 *
 * These pin the acceptance criteria: two sessions never share state solely
 * because issue numbers match, equivalent Gitea endpoints canonicalize to
 * the same identity, different repos/providers never collide, and
 * unsupported/incomplete provider config fails closed rather than producing
 * a partial identity.
 */
import {
  GITHUB_ISSUES_PROVIDER_ENDPOINT,
  canonicalizeGiteaEndpoint,
  deriveChatOpsProviderIdentity,
  chatOpsIdentityKey,
  chatOpsCursorKey,
  chatOpsLedgerKey,
} from '../dist/core/chatops-identity.js';

function githubSession(overrides = {}) {
  return {
    sessionId: 'session-a',
    workItemProvider: { provider: 'github-issues' },
    githubOwner: 'acme',
    githubName: 'widgets',
    ...overrides,
  };
}

function giteaSession(overrides = {}) {
  return {
    sessionId: 'session-a',
    workItemProvider: {
      provider: 'gitea-issues',
      gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'widgets' },
    },
    githubOwner: '',
    githubName: '',
    ...overrides,
  };
}

describe('canonicalizeGiteaEndpoint', () => {
  const canonical = 'https://gitea.example.com';

  test.each([
    ['https://gitea.example.com', canonical],
    ['https://gitea.example.com/', canonical],
    ['https://GITEA.Example.com', canonical],
    ['HTTPS://gitea.example.com', canonical],
    ['https://gitea.example.com:443', canonical],
    ['https://gitea.example.com:443/', canonical],
    ['https://gitea.example.com/base', 'https://gitea.example.com/base'],
    ['https://gitea.example.com/base/', 'https://gitea.example.com/base'],
    ['http://gitea.example.com:80', 'http://gitea.example.com'],
  ])('%s canonicalizes to %s', (input, expected) => {
    expect(canonicalizeGiteaEndpoint(input)).toBe(expected);
  });

  test('a non-default port is preserved', () => {
    expect(canonicalizeGiteaEndpoint('https://gitea.example.com:8080')).toBe(
      'https://gitea.example.com:8080',
    );
  });

  test('rejects a malformed URL', () => {
    expect(() => canonicalizeGiteaEndpoint('not a url')).toThrow(/valid URL/);
  });

  test('rejects a non-http(s) scheme', () => {
    expect(() => canonicalizeGiteaEndpoint('ftp://gitea.example.com')).toThrow(/http\(s\)/);
  });

  test('rejects embedded credentials', () => {
    expect(() => canonicalizeGiteaEndpoint('https://user:pass@gitea.example.com')).toThrow(
      /credentials/,
    );
  });

  test('rejects a query string', () => {
    expect(() => canonicalizeGiteaEndpoint('https://gitea.example.com?x=1')).toThrow(
      /query string/,
    );
  });

  test('rejects a fragment', () => {
    expect(() => canonicalizeGiteaEndpoint('https://gitea.example.com#frag')).toThrow(
      /fragment/,
    );
  });

  test('rejects a bare trailing query delimiter', () => {
    expect(() => canonicalizeGiteaEndpoint('https://gitea.example.com/base?')).toThrow(
      /query string/,
    );
  });

  test('rejects a bare trailing fragment delimiter', () => {
    expect(() => canonicalizeGiteaEndpoint('https://gitea.example.com/base#')).toThrow(
      /fragment/,
    );
  });
});

describe('deriveChatOpsProviderIdentity — github-issues', () => {
  test('derives the fixed endpoint and owner/repo from the session', () => {
    expect(deriveChatOpsProviderIdentity(githubSession())).toEqual({
      sessionId: 'session-a',
      provider: 'github-issues',
      providerEndpoint: GITHUB_ISSUES_PROVIDER_ENDPOINT,
      providerOwner: 'acme',
      providerRepo: 'widgets',
    });
  });

  test('throws when githubOwner is missing', () => {
    expect(() => deriveChatOpsProviderIdentity(githubSession({ githubOwner: '' }))).toThrow(
      /githubOwner/,
    );
  });

  test('throws when sessionId is missing', () => {
    expect(() => deriveChatOpsProviderIdentity(githubSession({ sessionId: '' }))).toThrow(
      /sessionId/,
    );
  });
});

describe('deriveChatOpsProviderIdentity — gitea-issues', () => {
  test('derives a canonicalized endpoint and owner/repo from the gitea config', () => {
    expect(deriveChatOpsProviderIdentity(giteaSession())).toEqual({
      sessionId: 'session-a',
      provider: 'gitea-issues',
      providerEndpoint: 'https://gitea.example.com',
      providerOwner: 'acme',
      providerRepo: 'widgets',
    });
  });

  test('equivalent baseUrl spellings resolve to the same identity', () => {
    const a = deriveChatOpsProviderIdentity(giteaSession());
    const b = deriveChatOpsProviderIdentity(
      giteaSession({
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://GITEA.example.com:443/', owner: 'acme', repo: 'widgets' },
        },
      }),
    );
    expect(a).toEqual(b);
  });

  test('throws when the gitea connection block is missing', () => {
    expect(() =>
      deriveChatOpsProviderIdentity(
        giteaSession({ workItemProvider: { provider: 'gitea-issues' } }),
      ),
    ).toThrow(/gitea connection config/);
  });

  test('throws when baseUrl is invalid', () => {
    expect(() =>
      deriveChatOpsProviderIdentity(
        giteaSession({
          workItemProvider: {
            provider: 'gitea-issues',
            gitea: { baseUrl: 'not a url', owner: 'acme', repo: 'widgets' },
          },
        }),
      ),
    ).toThrow(/valid URL/);
  });

  test('throws when gitea owner is empty', () => {
    expect(() =>
      deriveChatOpsProviderIdentity(
        giteaSession({
          workItemProvider: {
            provider: 'gitea-issues',
            gitea: { baseUrl: 'https://gitea.example.com', owner: '', repo: 'widgets' },
          },
        }),
      ),
    ).toThrow(/owner\/repo/);
  });

  test('throws when gitea repo is empty', () => {
    expect(() =>
      deriveChatOpsProviderIdentity(
        giteaSession({
          workItemProvider: {
            provider: 'gitea-issues',
            gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: '' },
          },
        }),
      ),
    ).toThrow(/owner\/repo/);
  });

  test('throws when sessionId is missing', () => {
    expect(() => deriveChatOpsProviderIdentity(giteaSession({ sessionId: '' }))).toThrow(
      /sessionId/,
    );
  });
});

describe('deriveChatOpsProviderIdentity — unsupported providers', () => {
  test.each(['jira', 'azure-devops', 'bitbucket', 'github'])(
    'throws for provider kind %s',
    (provider) => {
      expect(() =>
        deriveChatOpsProviderIdentity(githubSession({ workItemProvider: { provider } })),
      ).toThrow(/ChatOps identity is undefined/);
    },
  );
});

describe('key derivation — collision resistance', () => {
  test('two sessions never collide solely because issue numbers match', () => {
    const identityA = deriveChatOpsProviderIdentity(githubSession({ sessionId: 'session-a' }));
    const identityB = deriveChatOpsProviderIdentity(githubSession({ sessionId: 'session-b' }));
    expect(chatOpsCursorKey(identityA, 42)).not.toBe(chatOpsCursorKey(identityB, 42));
  });

  test('different repositories never collide', () => {
    const identityA = deriveChatOpsProviderIdentity(githubSession({ githubName: 'widgets' }));
    const identityB = deriveChatOpsProviderIdentity(githubSession({ githubName: 'gadgets' }));
    expect(chatOpsIdentityKey(identityA)).not.toBe(chatOpsIdentityKey(identityB));
  });

  test('different providers on the same owner/repo string never collide', () => {
    const githubIdentity = deriveChatOpsProviderIdentity(
      githubSession({ githubOwner: 'acme', githubName: 'widgets' }),
    );
    const giteaIdentity = deriveChatOpsProviderIdentity(
      giteaSession({
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'widgets' },
        },
      }),
    );
    expect(chatOpsIdentityKey(githubIdentity)).not.toBe(chatOpsIdentityKey(giteaIdentity));
  });

  test('two gitea instances with the same owner/repo but different hosts never collide', () => {
    const identityA = deriveChatOpsProviderIdentity(
      giteaSession({
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://gitea-one.example.com', owner: 'acme', repo: 'widgets' },
        },
      }),
    );
    const identityB = deriveChatOpsProviderIdentity(
      giteaSession({
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://gitea-two.example.com', owner: 'acme', repo: 'widgets' },
        },
      }),
    );
    expect(chatOpsIdentityKey(identityA)).not.toBe(chatOpsIdentityKey(identityB));
  });

  test('cursor key and ledger key differ from the bare identity key', () => {
    const identity = deriveChatOpsProviderIdentity(githubSession());
    const identityKey = chatOpsIdentityKey(identity);
    const cursorKey = chatOpsCursorKey(identity, 7);
    const ledgerKey = chatOpsLedgerKey(identity, 7, '123');
    expect(new Set([identityKey, cursorKey, ledgerKey]).size).toBe(3);
  });

  test('ledger keys for two different comments on the same issue differ', () => {
    const identity = deriveChatOpsProviderIdentity(githubSession());
    expect(chatOpsLedgerKey(identity, 7, '123')).not.toBe(chatOpsLedgerKey(identity, 7, '124'));
  });

  test('key derivation is stable across calls', () => {
    const identity = deriveChatOpsProviderIdentity(githubSession());
    expect(chatOpsCursorKey(identity, 7)).toBe(chatOpsCursorKey(identity, 7));
  });

  test.each([NaN, Infinity, -Infinity, 1.5])(
    'chatOpsCursorKey rejects non-finite-integer issueNumber %p',
    (issueNumber) => {
      const identity = deriveChatOpsProviderIdentity(githubSession());
      expect(() => chatOpsCursorKey(identity, issueNumber)).toThrow(/issueNumber/);
    },
  );

  test.each([NaN, Infinity, -Infinity, 1.5])(
    'chatOpsLedgerKey rejects non-finite-integer issueNumber %p',
    (issueNumber) => {
      const identity = deriveChatOpsProviderIdentity(githubSession());
      expect(() => chatOpsLedgerKey(identity, issueNumber, '123')).toThrow(/issueNumber/);
    },
  );
});
