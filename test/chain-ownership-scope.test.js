/**
 * Repository-scoped Issue identity for the chain registry (issue #1045).
 *
 * The unit under test is the derivation that turns "the chain I am judging"
 * into "every session whose chains name Issues from the same repository". Its
 * whole job is to be exact in both directions: two repositories that number an
 * Issue the same must not be conflated, and two sessions on one repository must
 * not be separated.
 */
import {
  deriveChainRepositoryIdentity,
  chainRepositoryKey,
  formatChainRepository,
  resolveChainOwnershipScope,
  resolveChainOwnershipScopeFor,
} from '../dist/index.js';

const github = (sessionId, owner, name) => ({
  sessionId,
  githubOwner: owner,
  githubName: name,
  workItemProvider: { provider: 'github-issues' },
});

const gitea = (sessionId, baseUrl, owner, repo) => ({
  sessionId,
  githubOwner: 'unused',
  githubName: 'unused',
  workItemProvider: { provider: 'gitea-issues', gitea: { baseUrl, owner, repo } },
});

describe('deriving a repository identity', () => {
  test('a GitHub session is identified by github.com plus its owner/name', () => {
    expect(deriveChainRepositoryIdentity(github('s1', 'm2dw', 'yoda_form_js'))).toEqual({
      provider: 'github-issues',
      endpoint: 'github.com',
      owner: 'm2dw',
      repo: 'yoda_form_js',
    });
  });

  test('a session with no work-item provider is the GitHub default, not an unknown', () => {
    expect(
      deriveChainRepositoryIdentity({ sessionId: 's1', githubOwner: 'm2dw', githubName: 'repo' }),
    ).toEqual({
      provider: 'github-issues',
      endpoint: 'github.com',
      owner: 'm2dw',
      repo: 'repo',
    });
  });

  test('a Gitea session is identified by its canonicalized instance endpoint', () => {
    const identity = deriveChainRepositoryIdentity(
      gitea('s1', 'https://Git.Example.COM:443/', 'm2dw', 'repo'),
    );
    expect(identity).toEqual({
      provider: 'gitea-issues',
      endpoint: 'https://git.example.com',
      owner: 'm2dw',
      repo: 'repo',
    });
    // Two spellings of one instance are one identity; two instances are two.
    expect(chainRepositoryKey(identity)).toBe(
      chainRepositoryKey(deriveChainRepositoryIdentity(gitea('s2', 'https://git.example.com', 'm2dw', 'repo'))),
    );
    expect(chainRepositoryKey(identity)).not.toBe(
      chainRepositoryKey(deriveChainRepositoryIdentity(gitea('s3', 'https://other.example.com', 'm2dw', 'repo'))),
    );
  });

  test('a slug typed in a different case is the same repository, and keeps its own spelling', () => {
    // GitHub resolves `M2DW/Repo` and `m2dw/repo` to one repository, so they are
    // one Issue-number space: comparing them byte for byte would let both
    // sessions claim #697 (issue #1045 review).
    const shouty = deriveChainRepositoryIdentity(github('s1', 'M2DW', 'Yoda_Form_JS'));
    const quiet = deriveChainRepositoryIdentity(github('s2', 'm2dw', 'yoda_form_js'));
    expect(chainRepositoryKey(shouty)).toBe(chainRepositoryKey(quiet));
    // Same for a self-hosted instance, whose slugs resolve the same way.
    expect(
      chainRepositoryKey(deriveChainRepositoryIdentity(gitea('s3', 'https://git.example.com', 'M2DW', 'Repo'))),
    ).toBe(chainRepositoryKey(deriveChainRepositoryIdentity(gitea('s4', 'https://git.example.com', 'm2dw', 'repo'))));
    // The fold is confined to the key: an operator is shown what the session says.
    expect(shouty.owner).toBe('M2DW');
    expect(formatChainRepository(shouty)).toBe('M2DW/Yoda_Form_JS');
    // And it does not collapse genuinely different repositories.
    expect(chainRepositoryKey(shouty)).not.toBe(
      chainRepositoryKey(deriveChainRepositoryIdentity(github('s5', 'm2dw', 'yoda-form-js'))),
    );
  });

  test('two sessions spelling one slug differently share one scope', () => {
    const scope = resolveChainOwnershipScope('shouty', [
      github('shouty', 'M2DW', 'Shared'),
      github('quiet', 'm2dw', 'shared'),
      github('elsewhere', 'm2dw', 'other'),
    ]);
    expect(scope.sessionIds).toEqual(['quiet', 'shouty']);
    expect(scope.filter).toEqual({ sessionIds: ['quiet', 'shouty'] });
  });

  test('an incomplete or unqualifiable binding is undefined rather than a partial identity', () => {
    expect(deriveChainRepositoryIdentity({ sessionId: 's1', githubOwner: '', githubName: '' })).toBeUndefined();
    expect(
      deriveChainRepositoryIdentity({
        sessionId: 's1',
        workItemProvider: { provider: 'gitea-issues' },
      }),
    ).toBeUndefined();
    expect(
      deriveChainRepositoryIdentity(gitea('s1', 'not a url', 'm2dw', 'repo')),
    ).toBeUndefined();
    // A reserved provider kind has no defined endpoint to compare two of by.
    expect(
      deriveChainRepositoryIdentity({
        sessionId: 's1',
        githubOwner: 'm2dw',
        githubName: 'repo',
        workItemProvider: { provider: 'jira' },
      }),
    ).toBeUndefined();
  });

  test('a self-hosted repository renders with its endpoint, GitHub without one', () => {
    expect(formatChainRepository(deriveChainRepositoryIdentity(github('s1', 'm2dw', 'repo')))).toBe(
      'm2dw/repo',
    );
    expect(
      formatChainRepository(deriveChainRepositoryIdentity(gitea('s1', 'https://git.example.com', 'm2dw', 'repo'))),
    ).toBe('https://git.example.com/m2dw/repo');
  });
});

describe('resolving the ownership scope', () => {
  const sessions = [
    github('yoda-form-js', 'm2dw', 'yoda_form_js'),
    github('ai-cli-loop', 'm2dw', 'n8n-ai-cli-loop-ai'),
    github('ai-cli-loop-mirror', 'm2dw', 'n8n-ai-cli-loop-ai'),
  ];

  test('a repository with one session scopes to that session alone', () => {
    const scope = resolveChainOwnershipScope('yoda-form-js', sessions);
    expect(scope.sessionIds).toEqual(['yoda-form-js']);
    expect(scope.repository.repo).toBe('yoda_form_js');
    // The key travels with the scope, so the edit lock claims its Issues under
    // the same repository the ownership check was widened by (issue #1045).
    expect(scope.repositoryKey).toBe(chainRepositoryKey(scope.repository));
    // Expressed on the older single-session field, which every store already
    // understands — a one-session scope needs no list.
    expect(scope.filter).toEqual({ sessionId: 'yoda-form-js' });
  });

  test('two sessions on one repository share one Issue-number space', () => {
    const scope = resolveChainOwnershipScope('ai-cli-loop', sessions);
    expect(scope.sessionIds).toEqual(['ai-cli-loop', 'ai-cli-loop-mirror']);
    expect(scope.filter).toEqual({ sessionIds: ['ai-cli-loop', 'ai-cli-loop-mirror'] });
    // The mapping a diagnostic names the conflicting repository from.
    expect(scope.repositoryBySessionId.get('ai-cli-loop-mirror')).toBe('m2dw/n8n-ai-cli-loop-ai');
    expect(scope.repositoryBySessionId.get('yoda-form-js')).toBe('m2dw/yoda_form_js');
  });

  test('an unknown session falls back to its own scope rather than widening', () => {
    const scope = resolveChainOwnershipScope('deleted-session', sessions);
    expect(scope.sessionIds).toEqual(['deleted-session']);
    expect(scope.repository).toBeUndefined();
    // No repository, no repository-scoped claim: the edit stays session-scoped.
    expect(scope.repositoryKey).toBeUndefined();
    expect(scope.filter).toEqual({ sessionId: 'deleted-session' });
  });

  test('a session whose binding cannot be qualified is never grouped with another', () => {
    const unqualifiable = { sessionId: 'jira-dev', workItemProvider: { provider: 'jira' } };
    const scope = resolveChainOwnershipScope('jira-dev', [...sessions, unqualifiable]);
    expect(scope.sessionIds).toEqual(['jira-dev']);
    expect(scope.repository).toBeUndefined();
    expect(scope.repositoryBySessionId.has('jira-dev')).toBe(false);
  });

  test('the anchor is in its own scope even when the session file has dropped it', () => {
    const scope = resolveChainOwnershipScope('gone', []);
    expect(scope.anchorSessionId).toBe('gone');
    expect(scope.sessionIds).toEqual(['gone']);
  });
});

describe('resolving against a session source', () => {
  test('it reads the sessions the source lists', async () => {
    const source = {
      listSessions: async () => [
        github('a', 'm2dw', 'shared'),
        github('b', 'm2dw', 'shared'),
      ],
    };
    const scope = await resolveChainOwnershipScopeFor('a', source);
    expect(scope.sessionIds).toEqual(['a', 'b']);
  });

  test('an absent or unreadable source narrows the scope instead of failing the command', async () => {
    // The widening half of the check being unavailable must not stop a chain
    // command: the fallback is the session-only scope, which is narrower.
    expect((await resolveChainOwnershipScopeFor('a', undefined)).sessionIds).toEqual(['a']);
    const broken = {
      listSessions: async () => {
        throw new Error('sessions.json is not readable');
      },
    };
    const scope = await resolveChainOwnershipScopeFor('a', broken);
    expect(scope.sessionIds).toEqual(['a']);
    expect(scope.filter).toEqual({ sessionId: 'a' });
  });
});
