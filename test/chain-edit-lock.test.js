/**
 * core/chain-edit-lock.ts (issue #791 review): how the exclusive scopes of one
 * linear chain edit are spelled, and what an operator is told about them.
 */
import {
  CHAIN_EDIT_LOCK_ABANDONED_MS,
  CHAIN_EDIT_LOCK_RENEW_MS,
  CHAIN_EDIT_LOCK_STALE_MS,
  chainEditLockIsTakeable,
  chainEditAliasLockScope,
  chainEditIssueLockScope,
  chainEditRepositoryIssueLockScope,
  chainEditLockScopeKind,
  chainEditLockScopes,
  chainRepositoryKey,
  describeChainEditLockScope,
  describeChainEditLockScopes,
} from '../dist/index.js';

test('an issue scope is session-scoped, because execution labels are', () => {
  expect(chainEditIssueLockScope('addon-dev', 11)).toBe('issue:addon-dev:11');
  // The same Issue number in two sessions is two different claims.
  expect(chainEditIssueLockScope('other', 11)).not.toBe(chainEditIssueLockScope('addon-dev', 11));
});

test('a session id containing the separator cannot be read as another issue', () => {
  // Without encoding, `issue:a:11` + issue 12 and `issue:a` + issue "11:12"
  // would be indistinguishable strings.
  expect(chainEditIssueLockScope('a:11', 12)).toBe('issue:a%3A11:12');
  expect(chainEditIssueLockScope('a', 12)).not.toBe(chainEditIssueLockScope('a:11', 12));
});

describe('the repository-scoped issue claim (issue #1045)', () => {
  const key = (owner, repo) =>
    chainRepositoryKey({ provider: 'github-issues', endpoint: 'github.com', owner, repo });

  test('two sessions on one repository claim the same scope', () => {
    // The whole point: their session-scoped claims differ by construction, so
    // without this one they would edit the same GitHub Issue concurrently.
    expect(chainEditRepositoryIssueLockScope(key('m2dw', 'shared'), 697)).toBe(
      chainEditRepositoryIssueLockScope(key('m2dw', 'shared'), 697),
    );
    // Case-insensitively, because GitHub resolves the slug that way.
    expect(chainEditRepositoryIssueLockScope(key('M2DW', 'Shared'), 697)).toBe(
      chainEditRepositoryIssueLockScope(key('m2dw', 'shared'), 697),
    );
  });

  test('the same number in another repository is another claim', () => {
    expect(chainEditRepositoryIssueLockScope(key('m2dw', 'yoda_form_js'), 697)).not.toBe(
      chainEditRepositoryIssueLockScope(key('m2dw', 'n8n-ai-cli-loop-ai'), 697),
    );
  });

  test('a repository key containing the separator cannot be read as another issue', () => {
    expect(chainEditRepositoryIssueLockScope('a:11', 12)).toBe('repo-issue:a%3A11:12');
    expect(chainEditRepositoryIssueLockScope('a', 12)).not.toBe(
      chainEditRepositoryIssueLockScope('a:11', 12),
    );
  });

  test('an edit claims both spellings, so an older build still collides with it', () => {
    const repositoryKey = key('m2dw', 'shared');
    expect(chainEditLockScopes({ sessionId: 'addon-dev', issueNumbers: [11], repositoryKey })).toEqual(
      [
        chainEditIssueLockScope('addon-dev', 11),
        chainEditRepositoryIssueLockScope(repositoryKey, 11),
      ].sort(),
    );
    // Two sessions on one repository overlap on the repository claim...
    const mine = chainEditLockScopes({ sessionId: 'addon-dev', issueNumbers: [11], repositoryKey });
    const theirs = chainEditLockScopes({ sessionId: 'other', issueNumbers: [11], repositoryKey });
    expect(mine.filter((scope) => theirs.includes(scope))).toEqual([
      chainEditRepositoryIssueLockScope(repositoryKey, 11),
    ]);
    // ...and two sessions on different repositories overlap on nothing.
    const elsewhere = chainEditLockScopes({
      sessionId: 'other',
      issueNumbers: [11],
      repositoryKey: key('m2dw', 'elsewhere'),
    });
    expect(mine.filter((scope) => elsewhere.includes(scope))).toEqual([]);
  });

  test('the session spelling is claimed for every session in the repository scope', () => {
    // A rolling upgrade: the older process edits #11 through `other`, and knows
    // only the session spelling. Claiming the anchor's alone would leave the two
    // sets disjoint and let both relabel the Issue at once.
    const repositoryKey = key('m2dw', 'shared');
    const scope = { sessionIds: ['addon-dev', 'other'], repositoryKey };
    const mine = chainEditLockScopes({ sessionId: 'addon-dev', issueNumbers: [11], ...scope });
    expect(mine).toEqual(
      [
        chainEditIssueLockScope('addon-dev', 11),
        chainEditIssueLockScope('other', 11),
        chainEditRepositoryIssueLockScope(repositoryKey, 11),
      ].sort(),
    );
    // The older build's claim — session spelling only — is now inside this set.
    const older = chainEditLockScopes({ sessionId: 'other', issueNumbers: [11] });
    expect(older).toEqual([chainEditIssueLockScope('other', 11)]);
    expect(mine.filter((s) => older.includes(s))).toEqual(older);

    // A session in another repository is in no scope of ours, so still nothing
    // overlaps: the bug this whole module change is scoped by (issue #1045).
    const elsewhere = chainEditLockScopes({
      sessionId: 'yoda-form-js',
      issueNumbers: [11],
      sessionIds: ['yoda-form-js'],
      repositoryKey: key('m2dw', 'elsewhere'),
    });
    expect(mine.filter((s) => elsewhere.includes(s))).toEqual([]);
  });

  test('the anchor session is claimed even when the resolved scope omits it', () => {
    // `sessionIds` always carries the anchor today; the claim does not depend on
    // it, because dropping the anchor's own scope is the one thing that could
    // let an older build of THIS session interleave with it.
    expect(
      chainEditLockScopes({ sessionId: 'addon-dev', issueNumbers: [11], sessionIds: ['other'] }),
    ).toEqual(['issue:addon-dev:11', 'issue:other:11']);
  });

  test('a session with no repository identity claims exactly what it always did', () => {
    expect(chainEditLockScopes({ sessionId: 'addon-dev', issueNumbers: [11] })).toEqual([
      'issue:addon-dev:11',
    ]);
    // A one-session scope — the fallback `resolveChainOwnershipScope` returns —
    // adds nothing either.
    expect(
      chainEditLockScopes({
        sessionId: 'addon-dev',
        issueNumbers: [11],
        sessionIds: ['addon-dev'],
      }),
    ).toEqual(['issue:addon-dev:11']);
  });
});

test('a name scope is global, because chain IDs and aliases share one namespace', () => {
  expect(chainEditAliasLockScope('auth-work')).toBe('alias:auth-work');
});

test('the scope set is deduplicated and ordered, so two edits claim in the same sequence', () => {
  const scopes = chainEditLockScopes({
    sessionId: 'addon-dev',
    issueNumbers: [21, 20, 21, 11],
    name: 'auth-work',
  });
  expect(scopes).toEqual([
    'alias:auth-work',
    'issue:addon-dev:11',
    'issue:addon-dev:20',
    'issue:addon-dev:21',
  ]);
  expect(chainEditLockScopes({ sessionId: 'addon-dev', issueNumbers: [11] })).toEqual([
    'issue:addon-dev:11',
  ]);
});

test('a scope reports what it names, and an unknown shape is passed through verbatim', () => {
  expect(chainEditLockScopeKind('issue:addon-dev:11')).toBe('issue');
  expect(chainEditLockScopeKind('repo-issue:%5B%22a%22%5D:11')).toBe('issue');
  expect(chainEditLockScopeKind('alias:auth-work')).toBe('alias');
  expect(chainEditLockScopeKind('something-else')).toBe('unknown');

  expect(describeChainEditLockScope('issue:addon-dev:11')).toBe('issue #11');
  // Both spellings read the same to an operator: the Issue is claimed either
  // way, and which of the two claims collided is an implementation detail.
  expect(describeChainEditLockScope('repo-issue:%5B%22a%22%5D:11')).toBe('issue #11');
  expect(describeChainEditLockScope('alias:auth-work')).toBe('the chain name "auth-work"');
  expect(describeChainEditLockScope('something-else')).toBe('something-else');
});

test('a set of scopes is phrased once per Issue, not once per claim on it', () => {
  // An Issue is held under both spellings, and both read as "issue #11": the
  // operator is told about the Issue, not about the fence (issue #1045).
  expect(
    describeChainEditLockScopes([
      'issue:addon-dev:11',
      'repo-issue:%5B%22a%22%5D:11',
      'alias:auth-work',
    ]),
  ).toBe('issue #11, the chain name "auth-work"');
});

test('the staleness window is long enough for a slow edit and short enough to retry after a crash', () => {
  expect(CHAIN_EDIT_LOCK_STALE_MS).toBeGreaterThan(60_000);
  expect(CHAIN_EDIT_LOCK_STALE_MS).toBeLessThanOrEqual(60 * 60 * 1000);
});

test('the heartbeat leaves room for missed ticks, so a live owner is never read as stale', () => {
  // Strictly more than one tick of slack: a single starved heartbeat — a
  // blocked event loop, a contended SQLite writer — must not be enough for
  // another edit to take these scopes over while their owner is still writing
  // relationships and suspending labels (issue #791 review).
  expect(CHAIN_EDIT_LOCK_RENEW_MS).toBeGreaterThan(0);
  expect(CHAIN_EDIT_LOCK_RENEW_MS * 2).toBeLessThan(CHAIN_EDIT_LOCK_STALE_MS);
});

/**
 * Who may take a claim (issue #791 review). Age alone cannot answer it: every
 * provider call an edit makes is a `spawnSync`, so no heartbeat fires while one
 * is outstanding and a run can pass the staleness window in the middle of a call
 * it is still making. Checking the claim before each call does not close that —
 * the check passes, the call blocks past the window, and the write lands under a
 * claim that changed hands while it was in flight. The owning process is the one
 * heartbeat that keeps beating through a blocking call, so liveness decides.
 */
describe('when a held scope may be taken over', () => {
  const takeable = (over) =>
    chainEditLockIsTakeable({ ageMs: CHAIN_EDIT_LOCK_STALE_MS * 2, owner: 'gone', ...over });

  test('a claim inside the staleness window is never taken, whoever holds it', () => {
    for (const owner of ['alive', 'gone', 'unknown']) {
      expect(takeable({ ageMs: CHAIN_EDIT_LOCK_STALE_MS - 1, owner })).toBe(false);
    }
  });

  test('a stale claim whose process is gone is taken over — that is what the window is for', () => {
    expect(takeable({ owner: 'gone' })).toBe(true);
  });

  test('a stale claim whose process still answers is left alone, however long it has blocked for', () => {
    // The case a pre-call check cannot cover: an edit blocked in a provider call
    // for hours is still an edit, and taking its scopes would put a second run
    // on the same Issues while the first is mid-mutation.
    expect(takeable({ ageMs: CHAIN_EDIT_LOCK_STALE_MS * 10, owner: 'alive' })).toBe(false);
    expect(takeable({ ageMs: CHAIN_EDIT_LOCK_ABANDONED_MS - 1, owner: 'alive' })).toBe(false);
  });

  test('a live-looking claim is taken over once the recycled-pid ceiling passes', () => {
    // Otherwise a pid the OS handed to an unrelated process would hold these
    // scopes for good, with no way for an operator to get them back.
    expect(takeable({ ageMs: CHAIN_EDIT_LOCK_ABANDONED_MS, owner: 'alive' })).toBe(true);
  });

  test('a ceiling shorter than the staleness window cannot shorten it', () => {
    expect(
      chainEditLockIsTakeable({
        ageMs: CHAIN_EDIT_LOCK_STALE_MS - 1,
        owner: 'alive',
        abandonedAfterMs: 0,
      }),
    ).toBe(false);
  });

  test('an owner nothing is known about falls back to the age-only rule', () => {
    // A row written before pids were recorded, or a lock taken on another
    // machine, where a local pid says nothing about it.
    expect(takeable({ owner: 'unknown' })).toBe(true);
  });

  test('an age that cannot be established counts as live rather than being broken on a guess', () => {
    expect(takeable({ ageMs: NaN, owner: 'gone' })).toBe(false);
  });

  test('the recycled-pid ceiling is far longer than any single provider call could block', () => {
    expect(CHAIN_EDIT_LOCK_ABANDONED_MS).toBeGreaterThan(CHAIN_EDIT_LOCK_STALE_MS * 4);
  });
});
