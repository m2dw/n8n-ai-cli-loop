/**
 * Runtime wiring for the Gitea work-item provider (issue #382):
 *   - intake lists/enqueues eligible Gitea issues through the provider over a
 *     fake HTTP layer (no live Gitea server);
 *   - outbox dispatch routes provider-neutral `workitem:*` rows to Gitea while
 *     `repohost:*` PR comments stay on the GitHub repo host;
 *   - the API token is resolved by indirection and never leaks into gh argv.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore, SqliteTaskStore } from '../dist/index.js';
import { runIntake } from '../dist/cli/github-intake.js';
import { main as dispatchMain } from '../dist/cli/dispatch-outbox.js';

let tmpDir;
let sessionsPath;
let dbPath;

function giteaSession() {
  return {
    sessionId: 'gitea-dev',
    repoKey: 'gitea-work',
    repoRoot: tmpDir, // exists, so dispatch cwd validation passes
    githubRepo: 'm2dw/public-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    workItemProvider: {
      provider: 'gitea-issues',
      auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
      gitea: { baseUrl: 'https://gitea.example.com', owner: 'ai-private', repo: 'work-items' },
    },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
  };
}

// Capture the single JSON object the CLI emits to stdout.
async function captureOutput(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('').trim();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gitea-runtime-test-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'test.db');
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [giteaSession()] }), 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

function giteaIntakeHttp(issues, deps = {}) {
  const calls = [];
  // Model real Gitea pagination: the data fits on the first page and any later
  // page is empty. The provider pages until an empty page proves exhaustion (a
  // short page is not assumed final, since the server can clamp the page size), so
  // a fake that returned the same list for every page would loop to the page cap.
  const pageOf = (req) => {
    const m = req.url.match(/[?&]page=(\d+)/);
    return m ? Number(m[1]) : 1;
  };
  const fn = (req) => {
    calls.push(req);
    const depMatch = req.url.match(/\/issues\/(\d+)\/dependencies/);
    if (depMatch) {
      const list = pageOf(req) <= 1 ? deps[depMatch[1]] ?? [] : [];
      return { status: 200, statusText: 'OK', body: JSON.stringify(list) };
    }
    if (/\/issues(\?|$)/.test(req.url)) {
      const list = pageOf(req) <= 1 ? issues : [];
      return { status: 200, statusText: 'OK', body: JSON.stringify(list) };
    }
    return { status: 599, statusText: 'unexpected', body: req.url };
  };
  fn.calls = calls;
  return fn;
}

function intakeArgs() {
  return {
    sessionId: 'gitea-dev',
    sessionsPath,
    dbPath,
    limit: 100,
    dryRun: false,
    supportedPhases: ['implementation', 'review', 'research'],
    contextId: undefined,
  };
}

describe('gitea intake', () => {
  test('enqueues eligible Gitea issues, excludes PRs and non-matching issues', async () => {
    const issues = [
      {
        number: 5,
        title: 'Impl A',
        html_url: 'https://gitea.example.com/ai-private/work-items/issues/5',
        labels: [{ id: 1, name: 'agent:claude' }, { id: 2, name: 'status:needs-implementation' }],
        body: 'do A',
      },
      // A pull request entry returned by the issues index — must be excluded.
      { number: 6, title: 'A PR', html_url: 'u6', labels: [], pull_request: { merged: false } },
      // No intake-matching label.
      { number: 7, title: 'No match', html_url: 'u7', labels: [{ id: 3, name: 'bug' }] },
    ];
    const giteaHttp = giteaIntakeHttp(issues);

    const out = await captureOutput(async () => {
      await runIntake(intakeArgs(), undefined, undefined, undefined, {
        giteaHttp,
        env: { GITEA_TOKEN: 'tok-secret' },
      });
    });
    const result = JSON.parse(out);
    expect(result).toMatchObject({ ok: true, enqueued: 1, candidates: 1 });

    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'gitea-dev', issueNumber: 5 });
    const pr = await store.getTask({ sessionId: 'gitea-dev', issueNumber: 6 });
    store.close();
    expect(task).toBeDefined();
    expect(task.phase).toBe('implementation');
    expect(pr).toBeUndefined();
    // No raw secret storage: the API token never lands in persisted task state.
    expect(JSON.stringify(task)).not.toContain('tok-secret');

    // The issue list was read from Gitea over HTTP with the token in the header.
    const listCall = giteaHttp.calls.find(
      (c) => c.method === 'GET' && /\/issues\?/.test(c.url) && !/dependencies/.test(c.url),
    );
    expect(listCall).toBeDefined();
    expect(listCall.headers.Authorization).toBe('token tok-secret');
  });

  test('holds a Gitea issue whose native dependency is an open blocker (fail closed)', async () => {
    const issues = [
      {
        number: 8,
        title: 'Blocked',
        html_url: 'u8',
        labels: [{ id: 1, name: 'agent:claude' }, { id: 2, name: 'status:needs-implementation' }],
      },
    ];
    const giteaHttp = giteaIntakeHttp(issues, { 8: [{ number: 99, state: 'open' }] });

    const out = await captureOutput(async () => {
      await runIntake(intakeArgs(), undefined, undefined, undefined, {
        giteaHttp,
        env: { GITEA_TOKEN: 'tok-secret' },
      });
    });
    const result = JSON.parse(out);
    expect(result).toMatchObject({ ok: true, enqueued: 0, candidates: 0 });
  });

  test('reactivating a blocked task clears the blocked label on Gitea, not GitHub', async () => {
    // Pre-seed a dependency-blocked implementation task: it sits in `blocked`
    // status at the implementation phase (the handler returned blocked) and the
    // private Gitea issue still carries the ai:blocked label.
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'gitea-dev', issueNumber: 8, phase: 'implementation', now: '2026-06-07T09:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'gitea-dev', issueNumber: 8 },
      { status: 'queued' },
      { status: 'blocked', phase: 'implementation' },
    );
    store.close();

    const issues = [
      {
        number: 8,
        title: 'Reactivate me',
        html_url: 'u8',
        labels: [{ id: 1, name: 'agent:claude' }, { id: 2, name: 'status:needs-implementation' }],
      },
    ];
    const giteaHttp = giteaIntakeHttp(issues);

    const out = await captureOutput(async () => {
      await runIntake(intakeArgs(), undefined, undefined, undefined, {
        giteaHttp,
        env: { GITEA_TOKEN: 'tok-secret' },
      });
    });
    const result = JSON.parse(out);
    expect(result).toMatchObject({ ok: true, enqueued: 1 });
    expect(result.results.find((r) => r.issueNumber === 8)).toMatchObject({ action: 'reactivated' });

    const pendingRows = await pending();
    // The blocked-label cleanup is a provider-neutral workitem:transition routed
    // to the Gitea work-item repo — never a GitHub gh:label:remove against the
    // repo host, which would strand the label on the private Gitea issue.
    const transition = pendingRows.find((e) => e.topic === 'workitem:transition');
    expect(transition).toBeDefined();
    expect(transition.payload).toMatchObject({
      provider: 'gitea-issues',
      owner: 'ai-private',
      repo: 'work-items',
      issueNumber: 8,
      transition: { kind: 'remove-label', label: 'ai:blocked' },
    });
    // No legacy GitHub label removal was enqueued for this gitea-issues session.
    expect(pendingRows.some((e) => e.topic === 'gh:label:remove')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Outbox dispatch
// ---------------------------------------------------------------------------

function giteaDispatchHttp() {
  const calls = [];
  const fn = (req) => {
    calls.push(req);
    if (req.method === 'GET' && /\/repos\/[^/]+\/[^/]+\/labels(\?|$)/.test(req.url)) {
      return { status: 200, statusText: 'OK', body: JSON.stringify([{ id: 7, name: 'ai:active' }]) };
    }
    if (req.method === 'POST' && /\/issues\/\d+\/labels$/.test(req.url)) {
      return { status: 200, statusText: 'OK', body: '[]' };
    }
    if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(req.url)) {
      return { status: 201, statusText: 'Created', body: '{}' };
    }
    return { status: 599, statusText: 'unexpected', body: req.url };
  };
  fn.calls = calls;
  return fn;
}

function recordingGhRunner() {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

async function enqueueGiteaRows() {
  const store = new SqliteOutboxStore(dbPath);
  await store.enqueue({
    idempotencyKey: 'c1',
    topic: 'workitem:comment',
    payload: { topic: 'workitem:comment', provider: 'gitea-issues', owner: 'ai-private', repo: 'work-items', issueNumber: 5, body: 'phase complete' },
  });
  await store.enqueue({
    idempotencyKey: 't1',
    topic: 'workitem:transition',
    payload: { topic: 'workitem:transition', provider: 'gitea-issues', owner: 'ai-private', repo: 'work-items', issueNumber: 5, transition: { kind: 'add-label', label: 'ai:active' } },
  });
  await store.enqueue({
    idempotencyKey: 'pr1',
    topic: 'repohost:pr-comment',
    payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'm2dw', repo: 'public-repo', prNumber: 42, body: 'review passed' },
  });
  store.close();
}

describe('gitea outbox dispatch', () => {
  test('routes workitem rows to Gitea and the repohost PR comment to GitHub', async () => {
    await enqueueGiteaRows();
    const giteaHttp = giteaDispatchHttp();
    const ghRunner = recordingGhRunner();

    const out = await captureOutput(async () => {
      await dispatchMain(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'gitea-dev'],
        ghRunner,
        { env: { GITEA_TOKEN: 'topsecrettoken' } },
        giteaHttp,
      );
    });
    const result = JSON.parse(out);
    expect(result).toMatchObject({ ok: true, dispatched: 3, failed: 0 });

    // Work-item comment + label transition went to Gitea over HTTP.
    const comment = giteaHttp.calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/5/comments'));
    expect(comment).toBeDefined();
    expect(JSON.parse(comment.body)).toEqual({ body: 'phase complete' });
    expect(comment.headers.Authorization).toBe('token topsecrettoken');
    const addLabel = giteaHttp.calls.find((c) => c.method === 'POST' && /\/issues\/5\/labels$/.test(c.url));
    expect(JSON.parse(addLabel.body)).toEqual({ labels: [7] });

    // The public PR comment went to GitHub via the gh runner, never to Gitea.
    expect(ghRunner.calls).toEqual([['pr', 'comment', '42', '--repo', 'm2dw/public-repo', '--body', 'review passed']]);
    // The Gitea token never appears in any gh argv (no cross-provider leak).
    expect(JSON.stringify(ghRunner.calls)).not.toContain('topsecrettoken');
    expect(await pending()).toHaveLength(0);
  });

  test('an unresolved Gitea token keeps workitem rows pending without falling back to GitHub', async () => {
    await enqueueGiteaRows();
    const giteaHttp = giteaDispatchHttp();
    const ghRunner = recordingGhRunner();

    const out = await captureOutput(async () => {
      // GITEA_TOKEN intentionally unset.
      await dispatchMain(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'gitea-dev'],
        ghRunner,
        { env: {} },
        giteaHttp,
      );
    });
    const result = JSON.parse(out);
    // The repohost PR comment still dispatches; both Gitea rows fail (stay pending).
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.errors[0].error).toMatch(/Gitea work-item provider unavailable/);
    // Gitea HTTP was never touched, and the work-item rows were never sent to GitHub.
    expect(giteaHttp.calls).toHaveLength(0);
    expect(ghRunner.calls).toEqual([['pr', 'comment', '42', '--repo', 'm2dw/public-repo', '--body', 'review passed']]);

    const stillPending = await pending();
    expect(stillPending.map((e) => e.topic).sort()).toEqual(['workitem:comment', 'workitem:transition']);
  });
});

async function pending() {
  const store = new SqliteOutboxStore(dbPath);
  try {
    return await store.listPending();
  } finally {
    store.close();
  }
}
