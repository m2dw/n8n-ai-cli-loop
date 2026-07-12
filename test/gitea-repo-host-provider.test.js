import {
  GiteaRepoHostProvider,
  GhRepoHostProvider,
  createGiteaClient,
  resolveRepoHostProvider,
  defaultGiteaClientBuilder,
} from '../dist/index.js';

// A Gitea client fake: records each request and returns a queued response per
// call. Mirrors the fakeGh helper used for the GitHub provider tests.
function fakeGitea(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    request(req) {
      const response = responses[i] ?? { status: 599, body: 'unexpected call' };
      calls.push(req);
      i++;
      return response;
    },
  };
}

const OWNER = 'acme';
const REPO = 'code';

// ---------------------------------------------------------------------------
// GiteaRepoHostProvider — findPullRequestForWorkItem
// ---------------------------------------------------------------------------

describe('GiteaRepoHostProvider — findPullRequestForWorkItem', () => {
  test('lists open PRs and matches the head-branch convention client-side', () => {
    const prs = [
      { number: 3, html_url: 'https://gitea.example.com/acme/code/pulls/3', head: { ref: 'ai/issue-99' }, base: { ref: 'main' }, mergeable: true },
      { number: 5, html_url: 'https://gitea.example.com/acme/code/pulls/5', head: { ref: 'ai/issue-42' }, base: { ref: 'main' }, mergeable: true },
    ];
    const client = fakeGitea([{ status: 200, body: JSON.stringify(prs) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.findPullRequestForWorkItem(42);

    expect(result).toEqual({
      kind: 'found',
      pullRequest: { number: 5, url: 'https://gitea.example.com/acme/code/pulls/5', headRefName: 'ai/issue-42', baseRefName: 'main', mergeable: 'MERGEABLE' },
    });
    // Gitea has no `head` list filter — the request lists open PRs, not a filtered
    // set — and pages explicitly (page 1 here, since the match is on the first page).
    expect(client.calls[0]).toEqual({
      method: 'GET',
      path: '/repos/acme/code/pulls',
      query: { state: 'open', limit: 50, page: 1 },
    });
    // A match on the first page is returned without requesting a second page.
    expect(client.calls).toHaveLength(1);
  });

  test('pages through open PRs to find a match beyond the first page', () => {
    // A full first page (50 PRs, none matching) forces a second request; the match
    // lives on page 2. Without pagination the lookup would wrongly report none and
    // the workflow could create a duplicate PR.
    const firstPage = Array.from({ length: 50 }, (_, k) => ({
      number: 1000 + k,
      head: { ref: `ai/issue-${1000 + k}` },
      base: { ref: 'main' },
      mergeable: true,
    }));
    const secondPage = [
      { number: 7, html_url: 'https://gitea.example.com/acme/code/pulls/7', head: { ref: 'ai/issue-42' }, base: { ref: 'main' }, mergeable: true },
    ];
    const client = fakeGitea([
      { status: 200, body: JSON.stringify(firstPage) },
      { status: 200, body: JSON.stringify(secondPage) },
    ]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.findPullRequestForWorkItem(42);

    expect(result).toEqual({
      kind: 'found',
      pullRequest: { number: 7, url: 'https://gitea.example.com/acme/code/pulls/7', headRefName: 'ai/issue-42', baseRefName: 'main', mergeable: 'MERGEABLE' },
    });
    expect(client.calls.map((c) => c.query.page)).toEqual([1, 2]);
  });

  test('stops paging at the first short page and returns kind:none', () => {
    // A full first page with no match, then a short (<limit) second page: the short
    // page is the last page, so the scan ends with none instead of looping forever.
    const firstPage = Array.from({ length: 50 }, (_, k) => ({
      number: 2000 + k,
      head: { ref: `ai/issue-${2000 + k}` },
      base: { ref: 'main' },
      mergeable: true,
    }));
    const client = fakeGitea([
      { status: 200, body: JSON.stringify(firstPage) },
      { status: 200, body: JSON.stringify([{ number: 9, head: { ref: 'ai/issue-99' }, base: { ref: 'main' }, mergeable: true }]) },
    ]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    expect(host.findPullRequestForWorkItem(42)).toEqual({ kind: 'none' });
    expect(client.calls.map((c) => c.query.page)).toEqual([1, 2]);
  });

  test('returns kind:none when no open PR matches the head branch', () => {
    const prs = [{ number: 3, head: { ref: 'ai/issue-99' }, base: { ref: 'main' }, mergeable: true }];
    const client = fakeGitea([{ status: 200, body: JSON.stringify(prs) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect(host.findPullRequestForWorkItem(42)).toEqual({ kind: 'none' });
  });

  test('returns kind:none on an empty open-PR list', () => {
    const client = fakeGitea([{ status: 200, body: '[]' }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect(host.findPullRequestForWorkItem(42)).toEqual({ kind: 'none' });
  });

  test('returns kind:failed on a non-2xx status', () => {
    const client = fakeGitea([{ status: 401, body: '{"message":"token required"}' }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    const result = host.findPullRequestForWorkItem(42);
    expect(result.kind).toBe('failed');
    expect(result.error).toMatch(/gitea pulls list failed \(HTTP 401\)/);
  });

  test('returns kind:failed on non-JSON output', () => {
    const client = fakeGitea([{ status: 200, body: 'not json' }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    const result = host.findPullRequestForWorkItem(42);
    expect(result.kind).toBe('failed');
    expect(result.error).toMatch(/non-JSON/);
  });
});

// ---------------------------------------------------------------------------
// GiteaRepoHostProvider — createPullRequest
// ---------------------------------------------------------------------------

describe('GiteaRepoHostProvider — createPullRequest', () => {
  test('POSTs to the pulls endpoint and maps the created PR', () => {
    const created = { number: 7, html_url: 'https://gitea.example.com/acme/code/pulls/7', head: { ref: 'ai/issue-7' }, base: { ref: 'main' }, mergeable: true };
    const client = fakeGitea([{ status: 201, body: JSON.stringify(created) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.createPullRequest({ title: 't', body: 'b', head: 'ai/issue-7', base: 'main' });

    expect(result).toEqual({
      ok: true,
      value: { number: 7, url: 'https://gitea.example.com/acme/code/pulls/7', headRefName: 'ai/issue-7', baseRefName: 'main', mergeable: 'MERGEABLE' },
    });
    expect(client.calls[0]).toEqual({
      method: 'POST',
      path: '/repos/acme/code/pulls',
      body: { title: 't', body: 'b', head: 'ai/issue-7', base: 'main' },
    });
  });

  test('returns ok:false on a non-2xx status', () => {
    const client = fakeGitea([{ status: 422, body: '{"message":"head already exists"}' }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    const result = host.createPullRequest({ title: 't', body: 'b', head: 'h', base: 'main' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/gitea pulls create failed \(HTTP 422\)/);
  });
});

// ---------------------------------------------------------------------------
// GiteaRepoHostProvider — getPullRequest (mergeability degradation)
// ---------------------------------------------------------------------------

describe('GiteaRepoHostProvider — getPullRequest', () => {
  test('reads a PR by index and maps mergeable=true to MERGEABLE without mergeStateStatus', () => {
    const pr = { number: 9, html_url: 'u', head: { ref: 'ai/issue-9' }, base: { ref: 'main' }, mergeable: true };
    const client = fakeGitea([{ status: 200, body: JSON.stringify(pr) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.getPullRequest('9');

    expect(result).toEqual({
      ok: true,
      value: { number: 9, url: 'u', headRefName: 'ai/issue-9', baseRefName: 'main', mergeable: 'MERGEABLE' },
    });
    // Gitea has no GitHub-equivalent merge-state status, so it is never set.
    expect('mergeStateStatus' in result.value).toBe(false);
    expect(client.calls[0]).toEqual({ method: 'GET', path: '/repos/acme/code/pulls/9' });
  });

  test('degrades mergeable=false to CONFLICTING', () => {
    const pr = { number: 9, html_url: 'u', head: { ref: 'h' }, base: { ref: 'main' }, mergeable: false };
    const client = fakeGitea([{ status: 200, body: JSON.stringify(pr) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect(host.getPullRequest('9').value.mergeable).toBe('CONFLICTING');
  });

  test('degrades a missing mergeable field to UNKNOWN (fails closed for the review gate)', () => {
    const pr = { number: 9, html_url: 'u', head: { ref: 'h' }, base: { ref: 'main' } };
    const client = fakeGitea([{ status: 200, body: JSON.stringify(pr) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect(host.getPullRequest('9').value.mergeable).toBe('UNKNOWN');
  });

  // Issue #455 review (P2): the fix-mode fallback verifies a recorded PR is open, so
  // the provider must surface the PR state. Gitea reports "open"/"closed".
  test('maps the Gitea PR state so the open-only fix fallback can verify it', () => {
    const pr = { number: 9, html_url: 'u', state: 'closed', head: { ref: 'h' }, base: { ref: 'main' }, mergeable: true };
    const client = fakeGitea([{ status: 200, body: JSON.stringify(pr) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect(host.getPullRequest('9').value.state).toBe('closed');
  });

  test('omits state when Gitea does not report one (degrades to the lenient path)', () => {
    const pr = { number: 9, html_url: 'u', head: { ref: 'h' }, base: { ref: 'main' }, mergeable: true };
    const client = fakeGitea([{ status: 200, body: JSON.stringify(pr) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect('state' in host.getPullRequest('9').value).toBe(false);
  });

  // Issue #456 review (P2): a forked PR head lives in a different repo than the base,
  // so the worktree fix path must be able to refuse it. Derive `isCrossRepository` by
  // comparing head/base repo identity.
  test('flags a forked head as cross-repository when head/base repos differ', () => {
    const pr = {
      number: 9, html_url: 'u', head: { ref: 'patch-1', repo: { full_name: 'contributor/code' } },
      base: { ref: 'main', repo: { full_name: 'acme/code' } }, mergeable: true,
    };
    const client = fakeGitea([{ status: 200, body: JSON.stringify(pr) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect(host.getPullRequest('9').value.isCrossRepository).toBe(true);
  });

  test('flags a same-repo head as not cross-repository', () => {
    const pr = {
      number: 9, html_url: 'u', head: { ref: 'feature/custom', repo: { full_name: 'acme/code' } },
      base: { ref: 'main', repo: { full_name: 'acme/code' } }, mergeable: true,
    };
    const client = fakeGitea([{ status: 200, body: JSON.stringify(pr) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect(host.getPullRequest('9').value.isCrossRepository).toBe(false);
  });

  test('omits isCrossRepository when Gitea does not report head/base repo identity', () => {
    const pr = { number: 9, html_url: 'u', head: { ref: 'h' }, base: { ref: 'main' }, mergeable: true };
    const client = fakeGitea([{ status: 200, body: JSON.stringify(pr) }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    expect('isCrossRepository' in host.getPullRequest('9').value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GiteaRepoHostProvider — commentPullRequest
// ---------------------------------------------------------------------------

describe('GiteaRepoHostProvider — commentPullRequest', () => {
  test('posts to the issues/{index}/comments endpoint (a PR shares its index)', () => {
    const client = fakeGitea([{ status: 201, body: '{"id":1}' }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    expect(host.commentPullRequest('7', 'hello')).toEqual({ ok: true });
    expect(client.calls[0]).toEqual({
      method: 'POST',
      path: '/repos/acme/code/issues/7/comments',
      body: { body: 'hello' },
    });
  });

  test('returns ok:false on a non-2xx status', () => {
    const client = fakeGitea([{ status: 403, body: 'forbidden' }]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);
    const result = host.commentPullRequest('7', 'hello');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/gitea pr comment failed \(HTTP 403\)/);
  });
});

// ---------------------------------------------------------------------------
// GiteaRepoHostProvider — upsertStickyPrComment (ownership-aware)
// ---------------------------------------------------------------------------

describe('GiteaRepoHostProvider — upsertStickyPrComment', () => {
  const MARKER = '<!-- pr-summary-marker -->';

  test('PATCHes the marker comment when owned by the resolved bot identity', () => {
    const existingComments = [
      { id: 42, body: `${MARKER}\nold content`, user: { login: 'bot-acme' } },
    ];
    const client = fakeGitea([
      { status: 200, body: JSON.stringify({ login: 'bot-acme' }) },       // GET /user
      { status: 200, body: JSON.stringify(existingComments) },            // GET comments page 1
      { status: 200, body: '{"id":42}' },                                 // PATCH comment
    ]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.upsertStickyPrComment(7, MARKER, 'new content');
    expect(result).toEqual({ ok: true });
    expect(client.calls[0]).toMatchObject({ method: 'GET', path: '/user' });
    expect(client.calls[2]).toMatchObject({
      method: 'PATCH',
      path: '/repos/acme/code/issues/comments/42',
      body: { body: 'new content' },
    });
  });

  test('creates a new comment when the marker comment is owned by a different user', () => {
    const existingComments = [
      { id: 10, body: `${MARKER}\nold content`, user: { login: 'other-user' } },
    ];
    const client = fakeGitea([
      { status: 200, body: JSON.stringify({ login: 'bot-acme' }) },       // GET /user
      { status: 200, body: JSON.stringify(existingComments) },            // GET comments page 1 (short page)
      { status: 201, body: '{"id":11}' },                                 // POST new comment
    ]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.upsertStickyPrComment(7, MARKER, 'new content');
    expect(result).toEqual({ ok: true });
    // Must not PATCH the unowned comment — third call should be a POST
    expect(client.calls[2]).toMatchObject({
      method: 'POST',
      path: '/repos/acme/code/issues/7/comments',
    });
  });

  test('falls back to creating a new comment when PATCH returns a non-2xx status', () => {
    const existingComments = [
      { id: 42, body: `${MARKER}\nold`, user: { login: 'bot-acme' } },
    ];
    const client = fakeGitea([
      { status: 200, body: JSON.stringify({ login: 'bot-acme' }) },       // GET /user
      { status: 200, body: JSON.stringify(existingComments) },            // GET comments
      { status: 403, body: 'forbidden' },                                 // PATCH rejected
      { status: 201, body: '{"id":99}' },                                 // POST fallback
    ]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.upsertStickyPrComment(7, MARKER, 'new content');
    expect(result).toEqual({ ok: true });
    expect(client.calls[3]).toMatchObject({
      method: 'POST',
      path: '/repos/acme/code/issues/7/comments',
      body: { body: 'new content' },
    });
  });

  test('creates a new comment when identity lookup fails (skips all existing marker comments)', () => {
    const existingComments = [
      { id: 10, body: `${MARKER}\nold`, user: { login: 'bot-acme' } },
    ];
    const client = fakeGitea([
      { status: 401, body: 'unauthorized' },                              // GET /user fails
      { status: 200, body: JSON.stringify(existingComments) },            // GET comments (short page)
      { status: 201, body: '{"id":11}' },                                 // POST new comment
    ]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.upsertStickyPrComment(7, MARKER, 'new content');
    expect(result).toEqual({ ok: true });
    // Should POST, not PATCH, because botLogin is unknown
    expect(client.calls[2]).toMatchObject({
      method: 'POST',
      path: '/repos/acme/code/issues/7/comments',
    });
  });

  test('creates a new comment when no marker comment exists', () => {
    const client = fakeGitea([
      { status: 200, body: JSON.stringify({ login: 'bot-acme' }) },       // GET /user
      { status: 200, body: JSON.stringify([]) },                          // GET comments (empty)
      { status: 201, body: '{"id":1}' },                                  // POST new comment
    ]);
    const host = new GiteaRepoHostProvider(client, OWNER, REPO);

    const result = host.upsertStickyPrComment(7, MARKER, 'initial content');
    expect(result).toEqual({ ok: true });
    expect(client.calls[2]).toMatchObject({
      method: 'POST',
      path: '/repos/acme/code/issues/7/comments',
      body: { body: 'initial content' },
    });
  });
});

// ---------------------------------------------------------------------------
// createGiteaClient — URL / auth / header assembly (token-in-header, never argv)
// ---------------------------------------------------------------------------

describe('createGiteaClient', () => {
  test('builds the URL with the default API path and authenticates with the token', () => {
    const seen = [];
    const http = (req) => {
      seen.push(req);
      return { status: 200, body: '[]' };
    };
    const client = createGiteaClient({ baseUrl: 'https://gitea.example.com/', token: 'secret-tok', http });

    client.request({ method: 'GET', path: '/repos/acme/code/pulls', query: { state: 'open', limit: 50 } });

    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toBe('https://gitea.example.com/api/v1/repos/acme/code/pulls?state=open&limit=50');
    expect(seen[0].headers.Authorization).toBe('token secret-tok');
    expect(seen[0].headers.Accept).toBe('application/json');
    expect(seen[0].body).toBeUndefined();
  });

  test('honors a custom apiPath and serializes a JSON body with a content-type', () => {
    const seen = [];
    const http = (req) => {
      seen.push(req);
      return { status: 201, body: '{}' };
    };
    const client = createGiteaClient({ baseUrl: 'https://gitea.example.com', apiPath: '/custom/v2', token: 't', http });

    client.request({ method: 'POST', path: '/repos/acme/code/pulls', body: { title: 'x' } });

    expect(seen[0].url).toBe('https://gitea.example.com/custom/v2/repos/acme/code/pulls');
    expect(seen[0].headers['Content-Type']).toBe('application/json');
    expect(seen[0].body).toBe('{"title":"x"}');
  });
});

// ---------------------------------------------------------------------------
// resolveRepoHostProvider — selection by session config
// ---------------------------------------------------------------------------

describe('resolveRepoHostProvider — provider selection', () => {
  const ghRunner = { run: () => ({ exitCode: 0, stdout: '[]', stderr: '' }) };

  test('selects the GitHub provider for a github repo-host config', () => {
    const provider = resolveRepoHostProvider(
      { provider: 'github', auth: { mode: 'gh' } },
      { cwd: '/repo', githubRepo: 'm2dw/test-repo', ghRunner },
    );
    expect(provider).toBeInstanceOf(GhRepoHostProvider);
  });

  test('selects the Gitea provider for a gitea repo-host config and routes through the built client', () => {
    const client = fakeGitea([{ status: 200, body: '[]' }]);
    const builderCalls = [];
    const giteaClient = (gitea, auth) => {
      builderCalls.push({ gitea, auth });
      return client;
    };

    const provider = resolveRepoHostProvider(
      {
        provider: 'gitea',
        auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' },
      },
      { cwd: '/repo', githubRepo: 'm2dw/test-repo', ghRunner, giteaClient },
    );

    expect(provider).toBeInstanceOf(GiteaRepoHostProvider);
    // The builder receives the connection block and auth so it can resolve the token.
    expect(builderCalls[0].gitea.owner).toBe('acme');
    expect(builderCalls[0].auth).toEqual({ mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' });

    // The selected provider actually talks to the Gitea client, addressing acme/code.
    provider.findPullRequestForWorkItem(1);
    expect(client.calls[0].path).toBe('/repos/acme/code/pulls');
  });

  test('throws on a gitea config missing its connection block (never silently falls back to GitHub)', () => {
    expect(() =>
      resolveRepoHostProvider(
        { provider: 'gitea', auth: { mode: 'api-token', tokenEnv: 'T' } },
        { cwd: '/repo', githubRepo: 'm2dw/test-repo', ghRunner, giteaClient: () => fakeGitea([]) },
      ),
    ).toThrow(/requires a gitea connection block/);
  });

  test('throws on an unsupported repo-host provider kind', () => {
    expect(() =>
      resolveRepoHostProvider(
        { provider: 'bitbucket', auth: { mode: 'gh' } },
        { cwd: '/repo', githubRepo: 'm2dw/test-repo', ghRunner },
      ),
    ).toThrow(/Unsupported repo-host provider: bitbucket/);
  });
});

// ---------------------------------------------------------------------------
// defaultGiteaClientBuilder — token resolution by indirection
// ---------------------------------------------------------------------------

describe('defaultGiteaClientBuilder', () => {
  const gitea = { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' };

  test('resolves the token from the named environment variable', () => {
    const builder = defaultGiteaClientBuilder({ env: { GITEA_TOK: 'abc' } });
    const client = builder(gitea, { mode: 'api-token', tokenEnv: 'GITEA_TOK' });
    expect(typeof client.request).toBe('function');
  });

  test('throws when the referenced environment variable is unset', () => {
    const builder = defaultGiteaClientBuilder({ env: {} });
    expect(() => builder(gitea, { mode: 'api-token', tokenEnv: 'MISSING' })).toThrow(/"MISSING" is not set/);
  });

  test('rejects a non api-token auth mode', () => {
    const builder = defaultGiteaClientBuilder({ env: {} });
    expect(() => builder(gitea, { mode: 'gh' })).toThrow(/requires api-token auth/);
  });

  test('resolves the token from a credential key when a resolver is supplied', () => {
    const builder = defaultGiteaClientBuilder({ resolveKey: (k) => (k === 'gitea/tok' ? 'xyz' : '') });
    const client = builder(gitea, { mode: 'api-token', tokenKey: 'gitea/tok' });
    expect(typeof client.request).toBe('function');
  });
});
