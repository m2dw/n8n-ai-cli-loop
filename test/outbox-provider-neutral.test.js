import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { dispatchOutbox } from '../dist/handlers/gh-dispatcher.js';
import {
  enqueueWorkItemComment,
  enqueueWorkItemTransition,
  enqueueRepoHostPrComment,
  enforceCommentVisibility,
} from '../dist/core/outbox-visibility.js';

let tmpDir;
let dbPath;
let store;

const CWD = '/tmp';

function okResult() { return { exitCode: 0, stdout: '', stderr: '' }; }
function failResult(stderr = 'error') { return { exitCode: 1, stdout: '', stderr }; }

// A gh executor fake that records every argv it is asked to run.
function fakeGh(results) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(args, opts) {
      const result = results[i] ?? okResult();
      calls.push({ args, opts });
      i++;
      return result;
    },
  };
}

// A runner that must never be invoked (provider-neutral fake-provider path).
const forbiddenRunner = {
  run() { throw new Error('gh runner must not be called for a fake provider'); },
};

// A WorkItemProvider / RepoHostProvider fake that records calls, plus a factory
// that hands it out for a given kind.
function fakeProviderFactory({ workItemResult = { ok: true }, repoHostResult = { ok: true } } = {}) {
  const calls = [];
  const workItem = {
    commentItem(issueNumber, body) { calls.push({ method: 'commentItem', issueNumber, body }); return workItemResult; },
    transitionItem(issueNumber, transition) { calls.push({ method: 'transitionItem', issueNumber, transition }); return workItemResult; },
  };
  const repoHost = {
    commentPullRequest(selector, body) { calls.push({ method: 'commentPullRequest', selector, body }); return repoHostResult; },
  };
  const factory = {
    builds: [],
    workItem(provider, repo, cwd, runner) {
      this.builds.push({ role: 'workItem', provider, repo, cwd, runner });
      return workItem;
    },
    repoHost(provider, repo, cwd, runner) {
      this.builds.push({ role: 'repoHost', provider, repo, cwd, runner });
      return repoHost;
    },
  };
  return { calls, factory };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'outbox-neutral-test-'));
  dbPath = join(tmpDir, 'test.db');
  store = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Provider-neutral dispatch through a fake provider
// ---------------------------------------------------------------------------

describe('dispatchOutbox — provider-neutral work-item comment (fake provider)', () => {
  test('routes workitem:comment through the configured WorkItemProvider', async () => {
    await store.enqueue({
      idempotencyKey: 'wc1',
      topic: 'workitem:comment',
      payload: { topic: 'workitem:comment', provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7, body: 'hi' },
    });
    const { calls, factory } = fakeProviderFactory();
    const result = await dispatchOutbox(store, forbiddenRunner, { cwd: CWD, providers: factory });

    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls).toEqual([{ method: 'commentItem', issueNumber: 7, body: 'hi' }]);
    // The provider is built from the payload's kind and an owner/repo string.
    expect(factory.builds[0]).toMatchObject({ role: 'workItem', provider: 'github-issues', repo: 'org/repo', cwd: CWD });
    expect(await store.listPending()).toHaveLength(0);
  });

  test('routes workitem:transition through transitionItem', async () => {
    await store.enqueue({
      idempotencyKey: 'wt1',
      topic: 'workitem:transition',
      payload: {
        topic: 'workitem:transition', provider: 'github-issues', owner: 'org', repo: 'repo',
        issueNumber: 7, transition: { kind: 'add-label', label: 'ai:active' },
      },
    });
    const { calls, factory } = fakeProviderFactory();
    const result = await dispatchOutbox(store, forbiddenRunner, { cwd: CWD, providers: factory });

    expect(result.dispatched).toBe(1);
    expect(calls).toEqual([{ method: 'transitionItem', issueNumber: 7, transition: { kind: 'add-label', label: 'ai:active' } }]);
  });

  test('routes repohost:pr-comment through the RepoHostProvider (PR selector is a string)', async () => {
    await store.enqueue({
      idempotencyKey: 'pr1',
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
    });
    const { calls, factory } = fakeProviderFactory();
    const result = await dispatchOutbox(store, forbiddenRunner, { cwd: CWD, providers: factory });

    expect(result.dispatched).toBe(1);
    expect(calls).toEqual([{ method: 'commentPullRequest', selector: '42', body: 'review passed' }]);
    expect(factory.builds[0]).toMatchObject({ role: 'repoHost', provider: 'github', repo: 'org/repo' });
  });

  test('a provider failure leaves the entry pending (retryable)', async () => {
    await store.enqueue({
      idempotencyKey: 'wc-fail',
      topic: 'workitem:comment',
      payload: { topic: 'workitem:comment', provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7, body: 'hi' },
    });
    const { factory } = fakeProviderFactory({ workItemResult: { ok: false, error: 'boom' } });
    const result = await dispatchOutbox(store, forbiddenRunner, { cwd: CWD, providers: factory });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toBe('boom');
    expect(await store.listPending()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unsupported provider kinds stay pending (fail safe, not dropped)
// ---------------------------------------------------------------------------

describe('dispatchOutbox — unsupported provider kind', () => {
  test('an unimplemented work-item provider is a retryable failure, not a drop', async () => {
    await store.enqueue({
      idempotencyKey: 'gitea1',
      topic: 'workitem:comment',
      payload: { topic: 'workitem:comment', provider: 'gitea', owner: 'org', repo: 'repo', issueNumber: 7, body: 'hi' },
    });
    // Default factory: only GitHub is wired, so `gitea` is unsupported.
    const result = await dispatchOutbox(store, forbiddenRunner, { cwd: CWD });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toMatch(/Unsupported work-item provider: gitea/);
    // Row stays pending so enabling the provider later drains it.
    expect(await store.listPending()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Split-auth runner routing — repo-host rows dispatch with repo-host credentials
// (resolved from repoHostProvider.auth), never the work-item runner. Each auth
// domain's runner is resolved lazily and only when a row of its domain is
// pending, so a single-domain drain never resolves (or token-exchanges) the
// other domain's credentials.
// ---------------------------------------------------------------------------

const WORK_ITEM_ROW = {
  idempotencyKey: 'wi',
  topic: 'workitem:comment',
  payload: { topic: 'workitem:comment', provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7, body: 'hi' },
};
const REPO_HOST_ROW = {
  idempotencyKey: 'rh',
  topic: 'repohost:pr-comment',
  payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
};

describe('dispatchOutbox — split-auth runner routing', () => {
  test('repo-host rows build their provider with repoHostRunner; work-item rows with runner', async () => {
    await store.enqueue(WORK_ITEM_ROW);
    await store.enqueue(REPO_HOST_ROW);
    // Two distinct runner identities — the work-item one must never reach the
    // repo-host provider (that is exactly the split-auth credential mix-up).
    const workItemRunner = { id: 'work-item', run() { throw new Error('fake provider must not invoke runner'); } };
    const repoHostRunner = { id: 'repo-host', run() { throw new Error('fake provider must not invoke runner'); } };
    const { factory } = fakeProviderFactory();

    const result = await dispatchOutbox(store, workItemRunner, { cwd: CWD, providers: factory, repoHostRunner });

    expect(result.dispatched).toBe(2);
    const workItemBuild = factory.builds.find((b) => b.role === 'workItem');
    const repoHostBuild = factory.builds.find((b) => b.role === 'repoHost');
    expect(workItemBuild.runner).toBe(workItemRunner);
    expect(repoHostBuild.runner).toBe(repoHostRunner);
  });

  test('repoHostRunner defaults to runner when omitted (single-auth behavior preserved)', async () => {
    await store.enqueue(REPO_HOST_ROW);
    const runner = { id: 'only-runner', run() { throw new Error('fake provider must not invoke runner'); } };
    const { factory } = fakeProviderFactory();

    const result = await dispatchOutbox(store, runner, { cwd: CWD, providers: factory });

    expect(result.dispatched).toBe(1);
    expect(factory.builds.find((b) => b.role === 'repoHost').runner).toBe(runner);
  });

  test('repoHostRunner factory is not resolved when no repo-host row is pending', async () => {
    await store.enqueue(WORK_ITEM_ROW);
    const { factory } = fakeProviderFactory();
    let repoHostResolved = false;
    const repoHostRunner = async () => { repoHostResolved = true; return forbiddenRunner; };

    const result = await dispatchOutbox(store, forbiddenRunner, { cwd: CWD, providers: factory, repoHostRunner });

    expect(result.dispatched).toBe(1);
    expect(repoHostResolved).toBe(false);
  });

  test('work-item runner factory is not resolved when only repo-host rows are pending', async () => {
    await store.enqueue(REPO_HOST_ROW);
    const { factory } = fakeProviderFactory();
    let workItemResolved = false;
    const workItemRunner = async () => { workItemResolved = true; return forbiddenRunner; };

    const result = await dispatchOutbox(store, workItemRunner, { cwd: CWD, providers: factory, repoHostRunner: forbiddenRunner });

    expect(result.dispatched).toBe(1);
    expect(workItemResolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Legacy PR-comment rows (upgrade path). PR comments queued by the pre-split-auth
// code have topic `gh:comment` with a `:pr` idempotency-key suffix and the PR
// number in `payload.issueNumber`. They must be classified into the repo-host
// auth domain so an already-queued public PR comment is dispatched with the
// repo-host runner — not posted under the work-item identity (or stranded for a
// non-GitHub work-item session). These rows still dispatch through the
// `gh:comment` case; only the auth domain is reclassified.
// ---------------------------------------------------------------------------

const LEGACY_PR_COMMENT_ROW = {
  idempotencyKey: 'sess:42:run-abc:gh:comment:review:success:pr',
  topic: 'gh:comment',
  payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 42, body: 'review passed' },
};
const LEGACY_ISSUE_COMMENT_ROW = {
  idempotencyKey: 'sess:10:run-abc:gh:comment:implementation:success',
  topic: 'gh:comment',
  payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 10, body: 'done' },
};

// A gh executor fake that records argv and returns success.
function recordingRunner(id) {
  const calls = [];
  return { id, calls, run(args) { calls.push(args); return okResult(); } };
}

describe('dispatchOutbox — legacy PR-comment rows route to the repo-host domain', () => {
  test('a legacy gh:comment :pr row dispatches under repoHostRunner, never the work-item runner', async () => {
    await store.enqueue(LEGACY_PR_COMMENT_ROW);
    const workItemRunner = recordingRunner('work-item');
    const repoHostRunner = recordingRunner('repo-host');

    const result = await dispatchOutbox(store, workItemRunner, { cwd: CWD, repoHostRunner });

    expect(result.dispatched).toBe(1);
    // The public PR comment posts under repo-host credentials only.
    expect(workItemRunner.calls).toHaveLength(0);
    expect(repoHostRunner.calls).toEqual([[
      'api', 'repos/org/repo/issues/42/comments', '--method', 'POST', '--field', 'body=review passed',
    ]]);
    expect(await store.listPending()).toHaveLength(0);
  });

  test('a plain gh:comment issue row still dispatches under the work-item runner', async () => {
    await store.enqueue(LEGACY_ISSUE_COMMENT_ROW);
    const workItemRunner = recordingRunner('work-item');
    const repoHostRunner = { id: 'repo-host', run() { throw new Error('issue comment must not use the repo-host runner'); } };

    const result = await dispatchOutbox(store, workItemRunner, { cwd: CWD, repoHostRunner });

    expect(result.dispatched).toBe(1);
    expect(workItemRunner.calls).toEqual([[
      'api', 'repos/org/repo/issues/10/comments', '--method', 'POST', '--field', 'body=done',
    ]]);
  });

  test('only a legacy PR row pending resolves repoHostRunner, not the work-item runner', async () => {
    await store.enqueue(LEGACY_PR_COMMENT_ROW);
    let workItemResolved = false;
    const workItemRunner = async () => { workItemResolved = true; return forbiddenRunner; };
    const repoHostRunner = recordingRunner('repo-host');

    const result = await dispatchOutbox(store, workItemRunner, { cwd: CWD, repoHostRunner });

    expect(result.dispatched).toBe(1);
    // The legacy PR row is repo-host work, so the work-item runner is never resolved.
    expect(workItemResolved).toBe(false);
    expect(repoHostRunner.calls).toHaveLength(1);
  });

  test('a legacy PR row with a raw reason/excerpt is rebuilt to a public-safe summary before dispatch', async () => {
    // Simulate a PR-timeline row queued by the OLD code: the same body the issue
    // comment used, so it carries the raw `Reason:` line and the review-findings
    // `<details>` excerpt the visibility policy now keeps off public PR comments.
    const leakyBody = [
      '🔄 **Review found blocking findings for issue #42 — automatically requeuing to fix mode.**',
      '',
      "Reason: Verification 'npm test' failed (exit 1): leaked raw stack trace",
      '',
      '<details>',
      '<summary>Review findings excerpt</summary>',
      '',
      '```',
      '[P1] secret internal detail',
      '```',
      '</details>',
      '',
      '<details>',
      '<summary>Run metadata</summary>',
      '',
      '- Phase: review',
      '- Run ID: run-abc',
      '- Duration: 5s',
      '',
      '</details>',
    ].join('\n');
    await store.enqueue({
      idempotencyKey: 'sess:42:run-abc:gh:comment:review:needs_fix:pr',
      topic: 'gh:comment',
      payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 42, body: leakyBody },
    });
    const workItemRunner = recordingRunner('work-item');
    const repoHostRunner = recordingRunner('repo-host');

    const result = await dispatchOutbox(store, workItemRunner, { cwd: CWD, repoHostRunner });

    expect(result.dispatched).toBe(1);
    expect(workItemRunner.calls).toHaveLength(0);
    expect(repoHostRunner.calls).toHaveLength(1);
    const argv = repoHostRunner.calls[0];
    const bodyField = argv[argv.length - 1];
    expect(bodyField.startsWith('body=')).toBe(true);
    // Public-safe headline (and the public-safe Run metadata block) survive...
    expect(bodyField).toContain('Review found blocking findings for issue #42');
    expect(bodyField).toContain('Run metadata');
    // ...but the raw reason and the review-findings excerpt are stripped.
    expect(bodyField).not.toContain('Reason:');
    expect(bodyField).not.toContain('leaked raw stack trace');
    expect(bodyField).not.toContain('Review findings excerpt');
    expect(bodyField).not.toContain('[P1] secret internal detail');
  });
});

// ---------------------------------------------------------------------------
// GitHub compatibility: the provider-neutral path produces the SAME gh argv as
// the legacy gh:* path for the github-issues / github kinds.
// ---------------------------------------------------------------------------

describe('dispatchOutbox — github-issues kind preserves legacy gh argv', () => {
  test('workitem:comment matches the legacy gh:comment argv', async () => {
    await store.enqueue({
      idempotencyKey: 'compat-c',
      topic: 'workitem:comment',
      payload: { topic: 'workitem:comment', provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 10, body: 'test body' },
    });
    const gh = fakeGh([okResult()]);
    // No `providers` override → default factory builds a real GhWorkItemProvider.
    const result = await dispatchOutbox(store, gh, { cwd: CWD });

    expect(result.dispatched).toBe(1);
    expect(gh.calls[0].args).toEqual([
      'api',
      'repos/org/repo/issues/10/comments',
      '--method', 'POST',
      '--field', 'body=test body',
    ]);
    expect(gh.calls[0].opts).toEqual({ cwd: CWD });
  });

  test('workitem:transition add-label matches the legacy gh:label:add argv', async () => {
    await store.enqueue({
      idempotencyKey: 'compat-la',
      topic: 'workitem:transition',
      payload: {
        topic: 'workitem:transition', provider: 'github-issues', owner: 'org', repo: 'repo',
        issueNumber: 10, transition: { kind: 'add-label', label: 'ai:active' },
      },
    });
    const gh = fakeGh([okResult()]);
    await dispatchOutbox(store, gh, { cwd: CWD });

    expect(gh.calls[0].args).toEqual([
      'api',
      'repos/org/repo/issues/10/labels',
      '--method', 'POST',
      '--field', 'labels[]=ai:active',
    ]);
  });

  test('workitem:transition remove-label matches the legacy gh:label:remove argv (404 ok)', async () => {
    await store.enqueue({
      idempotencyKey: 'compat-lr',
      topic: 'workitem:transition',
      payload: {
        topic: 'workitem:transition', provider: 'github-issues', owner: 'org', repo: 'repo',
        issueNumber: 10, transition: { kind: 'remove-label', label: 'ai:blocked' },
      },
    });
    const gh = fakeGh([{ exitCode: 1, stdout: '', stderr: '404 not found' }]);
    const result = await dispatchOutbox(store, gh, { cwd: CWD });

    // Remove treats a 404 as success, exactly like the legacy path.
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(gh.calls[0].args).toEqual([
      'api',
      'repos/org/repo/issues/10/labels/ai%3Ablocked',
      '--method', 'DELETE',
    ]);
  });

  test('repohost:pr-comment with github kind uses gh pr comment', async () => {
    await store.enqueue({
      idempotencyKey: 'compat-pr',
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
    });
    const gh = fakeGh([okResult()]);
    await dispatchOutbox(store, gh, { cwd: CWD });

    expect(gh.calls[0].args).toEqual([
      'pr', 'comment', '42', '--repo', 'org/repo', '--body', 'review passed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Enqueue helpers + visibility enforcement
// ---------------------------------------------------------------------------

describe('enqueueWorkItemComment / enqueueRepoHostPrComment — persisted payload', () => {
  test('work-item comment persists a provider-neutral payload', async () => {
    const { enqueued } = await enqueueWorkItemComment(store, {
      provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7,
      idempotencyKey: 'h1', body: 'phase complete',
    });
    expect(enqueued).toBe(true);
    const [entry] = await store.listPending();
    expect(entry.topic).toBe('workitem:comment');
    expect(entry.payload).toMatchObject({ topic: 'workitem:comment', provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7 });
  });

  test('a duplicate idempotency key is not re-enqueued', async () => {
    await enqueueWorkItemComment(store, { provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7, idempotencyKey: 'dup', body: 'a' });
    const second = await enqueueWorkItemComment(store, { provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7, idempotencyKey: 'dup', body: 'b' });
    expect(second.enqueued).toBe(false);
    expect(await store.listPending()).toHaveLength(1);
  });

  test('transition helper persists the transition payload', async () => {
    await enqueueWorkItemTransition(store, {
      provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7,
      idempotencyKey: 't1', transition: { kind: 'remove-label', label: 'ai:active' },
    });
    const [entry] = await store.listPending();
    expect(entry.payload).toMatchObject({ topic: 'workitem:transition', transition: { kind: 'remove-label', label: 'ai:active' } });
  });
});

describe('visibility policy — sanitization is enforced on published comments', () => {
  test('Tier 2 PR comment strips a raw local artifact path before persistence', async () => {
    await enqueueRepoHostPrComment(store, {
      provider: 'github', owner: 'org', repo: 'repo', prNumber: 42, idempotencyKey: 'v1',
      body: 'See log at /Users/moto/git/proj/.n8n-artifacts/run-1/output.log for details.',
    });
    const [entry] = await store.listPending();
    expect(entry.payload.body).not.toContain('/Users/moto');
    expect(entry.payload.body).not.toContain('.n8n-artifacts');
    expect(entry.payload.body).toContain('<path>');
  });

  test('work-item comment redacts explicitly configured non-standard roots', async () => {
    await enqueueWorkItemComment(store, {
      provider: 'github-issues', owner: 'org', repo: 'repo', issueNumber: 7, idempotencyKey: 'v2',
      body: 'Clone is at /myrepo/checkout and artifacts at /myrepo/checkout/.art',
      configuredPaths: ['/myrepo/checkout'],
    });
    const [entry] = await store.listPending();
    expect(entry.payload.body).not.toContain('/myrepo/checkout');
    expect(entry.payload.body).toContain('<path>');
  });

  test('enforceCommentVisibility bounds an over-long body and keeps the truncation marker', () => {
    const long = 'x'.repeat(500);
    const out = enforceCommentVisibility('repo-host-pr', long, { maxChars: 100 });
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('…(truncated)');
  });

  test('enforceCommentVisibility leaves a clean public summary unchanged', () => {
    const summary = '✅ Review passed for PR #42.';
    expect(enforceCommentVisibility('repo-host-pr', summary)).toBe(summary);
  });
});
