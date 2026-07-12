import { GhWorkItemProvider, GhRepoHostProvider, ghRunnerFromCommandRunner } from '../dist/index.js';

// A gh executor fake: records args and returns a queued result per call.
function fakeGh(results) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(args, opts) {
      const result = results[i] ?? { exitCode: 1, stdout: '', stderr: 'unexpected call' };
      calls.push({ args, opts, result });
      i++;
      return result;
    },
  };
}

const REPO = 'm2dw/test-repo';
const CWD = '/repo';

// ---------------------------------------------------------------------------
// GhRepoHostProvider
// ---------------------------------------------------------------------------

describe('GhRepoHostProvider — findPullRequestForWorkItem', () => {
  test('derives the head branch and returns the open PR', () => {
    const pr = { number: 5, url: 'https://github.com/m2dw/test-repo/pull/5', headRefName: 'ai/issue-42', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
    const gh = fakeGh([{ exitCode: 0, stdout: JSON.stringify([pr]), stderr: '' }]);
    const host = new GhRepoHostProvider(gh, REPO, CWD);

    const result = host.findPullRequestForWorkItem(42);

    expect(result).toEqual({ kind: 'found', pullRequest: pr });
    // Head branch derived from the issue number (ai/issue-<n>) — callers never build it.
    expect(gh.calls[0].args).toContain('ai/issue-42');
    expect(gh.calls[0].args.slice(0, 2)).toEqual(['pr', 'list']);
    expect(gh.calls[0].opts).toEqual({ cwd: CWD });
  });

  test('returns kind:none when no open PR exists', () => {
    const gh = fakeGh([{ exitCode: 0, stdout: '[]', stderr: '' }]);
    const host = new GhRepoHostProvider(gh, REPO, CWD);
    expect(host.findPullRequestForWorkItem(42)).toEqual({ kind: 'none' });
  });

  test('returns kind:failed on a non-zero exit', () => {
    const gh = fakeGh([{ exitCode: 1, stdout: '', stderr: 'auth error' }]);
    const host = new GhRepoHostProvider(gh, REPO, CWD);
    const result = host.findPullRequestForWorkItem(42);
    expect(result.kind).toBe('failed');
    expect(result.error).toMatch(/gh pr list failed/);
  });

  test('returns kind:failed on non-JSON output', () => {
    const gh = fakeGh([{ exitCode: 0, stdout: 'not json', stderr: '' }]);
    const host = new GhRepoHostProvider(gh, REPO, CWD);
    const result = host.findPullRequestForWorkItem(42);
    expect(result.kind).toBe('failed');
    expect(result.error).toMatch(/non-JSON/);
  });
});

describe('GhRepoHostProvider — createPullRequest', () => {
  test('opens a PR and derives the number from the printed URL', () => {
    const gh = fakeGh([{ exitCode: 0, stdout: 'https://github.com/m2dw/test-repo/pull/7\n', stderr: '' }]);
    const host = new GhRepoHostProvider(gh, REPO, CWD);

    const result = host.createPullRequest({ title: 't', body: 'b', head: 'ai/issue-7', base: 'main' });

    expect(result).toEqual({ ok: true, value: { number: 7, url: 'https://github.com/m2dw/test-repo/pull/7', headRefName: 'ai/issue-7', baseRefName: 'main' } });
    expect(gh.calls[0].args).toEqual(['pr', 'create', '--repo', REPO, '--title', 't', '--body', 'b', '--head', 'ai/issue-7', '--base', 'main']);
  });

  test('returns ok:false on failure', () => {
    const gh = fakeGh([{ exitCode: 1, stdout: '', stderr: 'gh: auth error' }]);
    const host = new GhRepoHostProvider(gh, REPO, CWD);
    const result = host.createPullRequest({ title: 't', body: 'b', head: 'h', base: 'main' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/gh pr create failed/);
  });
});

describe('GhRepoHostProvider — getPullRequest', () => {
  test('reads the PR state, base ref and mergeability', () => {
    const pr = { number: 9, url: 'u', headRefName: 'h', state: 'OPEN', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
    const gh = fakeGh([{ exitCode: 0, stdout: JSON.stringify(pr), stderr: '' }]);
    const host = new GhRepoHostProvider(gh, REPO, CWD);
    expect(host.getPullRequest('99')).toEqual({ ok: true, value: pr });
    // `state` is requested so the fix-mode fallback can verify a recorded PR is open (issue #455 review).
    expect(gh.calls[0].args).toEqual(['pr', 'view', '99', '--repo', REPO, '--json', 'number,url,headRefName,state,baseRefName,mergeable,mergeStateStatus,isCrossRepository']);
  });
});

// ---------------------------------------------------------------------------
// GhWorkItemProvider
// ---------------------------------------------------------------------------

describe('GhWorkItemProvider', () => {
  test('listCandidateItems flattens labels to strings', () => {
    const issues = [{ number: 1, title: 'T', url: 'u', labels: [{ name: 'a' }, { name: 'b' }], body: 'x' }];
    const gh = fakeGh([{ exitCode: 0, stdout: JSON.stringify(issues), stderr: '' }]);
    const provider = new GhWorkItemProvider(gh, REPO, CWD);
    expect(provider.listCandidateItems(50)).toEqual([{ number: 1, title: 'T', url: 'u', labels: ['a', 'b'], body: 'x' }]);
  });

  test('getItem returns the label set', () => {
    const gh = fakeGh([{ exitCode: 0, stdout: JSON.stringify({ labels: [{ name: 'status:needs-review' }] }), stderr: '' }]);
    const provider = new GhWorkItemProvider(gh, REPO, CWD);
    expect(provider.getItem(3)).toEqual({ ok: true, value: { labels: ['status:needs-review'] } });
    expect(gh.calls[0].args).toEqual(['issue', 'view', '3', '--repo', REPO, '--json', 'labels']);
  });

  test('getItem returns ok:false on failure', () => {
    const gh = fakeGh([{ exitCode: 1, stdout: '', stderr: 'boom' }]);
    const provider = new GhWorkItemProvider(gh, REPO, CWD);
    expect(provider.getItem(3).ok).toBe(false);
  });

  test('getDependencies maps blockedBy nodes and throws on GraphQL errors', async () => {
    const ok = fakeGh([{ exitCode: 0, stdout: JSON.stringify({ data: { repository: { issue: { blockedBy: { nodes: [{ number: 11, state: 'CLOSED' }, { number: 12, state: 'OPEN' }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), stderr: '' }]);
    const provider = new GhWorkItemProvider(ok, 'm2dw/test-repo', CWD);
    await expect(provider.getDependencies(112)).resolves.toEqual([
      { issueNumber: 11, state: 'closed' },
      { issueNumber: 12, state: 'open' },
    ]);
    expect(ok.calls[0].args).toContain('owner=m2dw');
    expect(ok.calls[0].args).toContain('number=112');

    const bad = fakeGh([{ exitCode: 0, stdout: JSON.stringify({ errors: [{ message: 'field missing' }] }), stderr: '' }]);
    const failing = new GhWorkItemProvider(bad, REPO, CWD);
    await expect(failing.getDependencies(1)).rejects.toThrow(/field missing/);
  });

  test('commentItem posts to the issue comments endpoint', () => {
    const gh = fakeGh([{ exitCode: 0, stdout: '', stderr: '' }]);
    const provider = new GhWorkItemProvider(gh, 'org/repo', CWD);
    expect(provider.commentItem(10, 'hello')).toEqual({ ok: true });
    expect(gh.calls[0].args).toEqual(['api', 'repos/org/repo/issues/10/comments', '--method', 'POST', '--field', 'body=hello']);
  });

  test('transitionItem add-label posts to the labels endpoint', () => {
    const gh = fakeGh([{ exitCode: 0, stdout: '', stderr: '' }]);
    const provider = new GhWorkItemProvider(gh, 'org/repo', CWD);
    expect(provider.transitionItem(10, { kind: 'add-label', label: 'ai:active' })).toEqual({ ok: true });
    expect(gh.calls[0].args).toEqual(['api', 'repos/org/repo/issues/10/labels', '--method', 'POST', '--field', 'labels[]=ai:active']);
  });

  test('transitionItem remove-label tolerates a 404 (label already absent)', () => {
    const gh = fakeGh([{ exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' }]);
    const provider = new GhWorkItemProvider(gh, 'org/repo', CWD);
    expect(provider.transitionItem(10, { kind: 'remove-label', label: 'ai:blocked' })).toEqual({ ok: true });
    expect(gh.calls[0].args[1]).toBe('repos/org/repo/issues/10/labels/ai%3Ablocked');
  });

  test('transitionItem remove-label fails on a non-404 error', () => {
    const gh = fakeGh([{ exitCode: 1, stdout: '', stderr: 'HTTP 500' }]);
    const provider = new GhWorkItemProvider(gh, 'org/repo', CWD);
    expect(provider.transitionItem(10, { kind: 'remove-label', label: 'x' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ghRunnerFromCommandRunner adapter
// ---------------------------------------------------------------------------

describe('ghRunnerFromCommandRunner', () => {
  test('forwards argv to the CommandRunner under the gh command, preserving cwd', () => {
    const calls = [];
    const commandRunner = {
      run(cmd, args, opts) {
        calls.push({ cmd, args, opts });
        return { stdout: 'out', stderr: '', exitCode: 0 };
      },
    };
    const gh = ghRunnerFromCommandRunner(commandRunner);
    const result = gh.run(['pr', 'list'], { cwd: CWD });
    expect(result).toEqual({ exitCode: 0, stdout: 'out', stderr: '' });
    expect(calls[0]).toEqual({ cmd: 'gh', args: ['pr', 'list'], opts: { cwd: CWD } });
  });
});
