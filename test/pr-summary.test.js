/**
 * Tests for PR change summary rendering and sticky-comment dispatch (issue #506).
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderPrSummary, PR_SUMMARY_MARKER } from '../dist/core/pr-summary.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { dispatchOutbox } from '../dist/handlers/gh-dispatcher.js';
import { enqueuePrSummaryEffect } from '../dist/core/outbox-effects.js';

// ---------------------------------------------------------------------------
// renderPrSummary — summary rendering
// ---------------------------------------------------------------------------

const DIFF_CLASS_WITH_CI_DELETE = {
  added: ['src/core/pr-summary.ts'],
  modified: ['src/core/outbox.ts'],
  deleted: ['.github/workflows/ci.yml'],
  renamed: [],
  guardrail: {
    added: [],
    modified: [],
    deleted: ['.github/workflows/ci.yml'],
    renamed: [],
  },
};

const DIFF_CLASS_CLEAN = {
  added: ['src/foo.ts'],
  modified: ['src/bar.ts'],
  deleted: [],
  renamed: [],
  guardrail: {
    added: [],
    modified: [],
    deleted: [],
    renamed: [],
  },
};

describe('renderPrSummary — marker and structure', () => {
  test('output starts with the HTML comment marker', () => {
    const body = renderPrSummary({
      issueNumber: 42,
      phase: 'implementation',
      phaseResult: 'success',
      runId: 'run-abc',
    });
    expect(body.startsWith(PR_SUMMARY_MARKER)).toBe(true);
  });

  test('includes issue number in header', () => {
    const body = renderPrSummary({
      issueNumber: 99,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-xyz',
    });
    expect(body).toContain('Issue #99');
  });

  test('includes issue title when provided', () => {
    const body = renderPrSummary({
      issueNumber: 10,
      issueTitle: 'Fix the login bug',
      phase: 'review',
      phaseResult: 'needs_fix',
      runId: 'r1',
    });
    expect(body).toContain('Fix the login bug');
  });

  test('includes phase and result in footer', () => {
    const body = renderPrSummary({
      issueNumber: 10,
      phase: 'review',
      phaseResult: 'needs_fix',
      runId: 'r1',
    });
    expect(body).toContain('Phase: review');
    expect(body).toContain('Result: needs_fix');
    expect(body).toContain('Run: r1');
  });
});

describe('renderPrSummary — file changes', () => {
  test('lists added, modified, deleted files from diffClassification', () => {
    const body = renderPrSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_CLASS_WITH_CI_DELETE,
    });
    expect(body).toContain('Added (1)');
    expect(body).toContain('src/core/pr-summary.ts');
    expect(body).toContain('Modified (1)');
    expect(body).toContain('src/core/outbox.ts');
    expect(body).toContain('Deleted (1)');
    expect(body).toContain('.github/workflows/ci.yml');
  });

  test('shows unavailable message when diffClassification is absent', () => {
    const body = renderPrSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('Not available');
  });

  test('caps added file list at 10 and shows overflow count', () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
    const body = renderPrSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: {
        added: manyFiles,
        modified: [],
        deleted: [],
        renamed: [],
        guardrail: { added: [], modified: [], deleted: [], renamed: [] },
      },
    });
    expect(body).toContain('Added (15)');
    expect(body).toContain('+5 more');
    expect(body).toContain('src/file0.ts');
    // file10 and beyond are truncated
    expect(body).not.toContain('src/file10.ts');
  });
});

describe('renderPrSummary — guardrail changes', () => {
  test('calls out deleted guardrail file with warning', () => {
    const body = renderPrSummary({
      issueNumber: 506,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_CLASS_WITH_CI_DELETE,
    });
    // Must explicitly call out deleted CI workflow
    expect(body).toContain('.github/workflows/ci.yml');
    expect(body).toContain('requires justification');
  });

  test('shows None when no guardrail files are touched', () => {
    const body = renderPrSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_CLASS_CLEAN,
    });
    expect(body).toContain('None.');
  });

  test('guardrail section appears before files-changed section', () => {
    const body = renderPrSummary({
      issueNumber: 506,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_CLASS_WITH_CI_DELETE,
    });
    const guardrailIdx = body.indexOf('### Guardrail / Tooling Changes');
    const filesIdx = body.indexOf('### Files Changed');
    expect(guardrailIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeGreaterThan(-1);
    expect(guardrailIdx).toBeLessThan(filesIdx);
  });
});

describe('renderPrSummary — scope concerns', () => {
  test('includes scope concern for deleted guardrail file', () => {
    const body = renderPrSummary({
      issueNumber: 506,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_CLASS_WITH_CI_DELETE,
    });
    expect(body).toContain('Scope Concerns');
    expect(body).toContain('Guardrail file(s) deleted');
    expect(body).toContain('.github/workflows/ci.yml');
  });

  test('no scope concerns section when no guardrail deletions', () => {
    const body = renderPrSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_CLASS_CLEAN,
    });
    expect(body).not.toContain('Scope Concerns');
  });
});

describe('renderPrSummary — verification', () => {
  test('shows verification passed', () => {
    const body = renderPrSummary({
      issueNumber: 1,
      phase: 'implementation',
      phaseResult: 'success',
      runId: 'r',
      verificationNames: ['npm test'],
      verificationPassed: true,
    });
    expect(body).toContain('npm test');
    expect(body).toContain('✅ passed');
  });

  test('shows unknown when verification not recorded', () => {
    const body = renderPrSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('Unknown');
  });
});

describe('renderPrSummary — CI status', () => {
  test('states CI status unknown', () => {
    const body = renderPrSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('CI / Checks Status');
    expect(body).toContain('Unknown');
  });
});

// ---------------------------------------------------------------------------
// dispatchOutbox — repohost:pr-summary creates comment when none exists
// ---------------------------------------------------------------------------

let tmpDir;
let dbPath;
let store;

const CWD = '/tmp';

function okResult(stdout = '') { return { exitCode: 0, stdout, stderr: '' }; }
function failResult(stderr = 'error') { return { exitCode: 1, stdout: '', stderr }; }

function makeRunner(steps) {
  let idx = 0;
  const calls = [];
  return {
    calls,
    run(args, opts) {
      const r = steps[idx] ?? { exitCode: 1, stdout: '', stderr: 'unexpected call' };
      calls.push({ args, opts });
      idx++;
      return r;
    },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pr-summary-test-'));
  dbPath = join(tmpDir, 'test.db');
  store = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const PR_SUMMARY_PAYLOAD = {
  topic: 'repohost:pr-summary',
  provider: 'github',
  owner: 'org',
  repo: 'repo',
  prNumber: 42,
  marker: PR_SUMMARY_MARKER,
  body: `${PR_SUMMARY_MARKER}\n## PR Change Summary\ntest body`,
};

describe('dispatchOutbox — repohost:pr-summary creates when no existing comment', () => {
  test('lists comments then posts new comment when marker not found', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    // First call: gh api /user — resolve bot identity
    // Second call: list comments (returns empty array)
    // Third call: gh pr comment (creates new comment)
    const runner = makeRunner([
      okResult('{"login":"test-bot"}'),  // gh api /user — bot identity
      okResult('[]'),                    // list comments — none found
      okResult(),                        // gh pr comment — create new
    ]);

    const result = await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    // First call must be the whoami API call
    expect(runner.calls[0].args).toEqual(['api', '/user']);
    // Second call must be the list-comments API call (with pagination fields)
    expect(runner.calls[1].args).toEqual(['api', '--method', 'GET', 'repos/org/repo/issues/42/comments', '--field', 'per_page=100', '--field', 'page=1']);
    // Third call must be gh pr comment
    expect(runner.calls[2].args[0]).toBe('pr');
    expect(runner.calls[2].args[1]).toBe('comment');
  });
});

describe('dispatchOutbox — repohost:pr-summary edits existing comment when marker found', () => {
  test('lists comments and PATCHes when marker is present', async () => {
    await store.enqueue({ idempotencyKey: 'k2', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    // Existing comment with the marker, owned by the bot
    const existingComments = JSON.stringify([
      { id: 999, body: `${PR_SUMMARY_MARKER}\n## PR Change Summary\nold body`, user: { login: 'test-bot' } },
    ]);

    const runner = makeRunner([
      okResult('{"login":"test-bot"}'),  // gh api /user — bot identity
      okResult(existingComments),        // list comments — marker found
      okResult(),                        // PATCH edit
    ]);

    const result = await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    // Third call must be the PATCH edit
    expect(runner.calls[2].args).toContain('PATCH');
    expect(runner.calls[2].args.some(a => a.includes('comments/999'))).toBe(true);
  });

  test('does not post a new comment when editing existing one', async () => {
    await store.enqueue({ idempotencyKey: 'k3', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    const existingComments = JSON.stringify([
      { id: 777, body: `${PR_SUMMARY_MARKER}\nold summary`, user: { login: 'test-bot' } },
    ]);

    const runner = makeRunner([
      okResult('{"login":"test-bot"}'),  // gh api /user — bot identity
      okResult(existingComments),        // list comments
      okResult(),                        // PATCH edit
    ]);

    await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    // Three calls: whoami + list + edit (no fourth "create" call)
    expect(runner.calls).toHaveLength(3);
  });

  test('creates new comment when marked comment is owned by another user', async () => {
    await store.enqueue({ idempotencyKey: 'k4', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    // Comment has the marker but is owned by a different user
    const existingComments = JSON.stringify([
      { id: 888, body: `${PR_SUMMARY_MARKER}\ncopied by human`, user: { login: 'some-human' } },
    ]);

    const runner = makeRunner([
      okResult('{"login":"test-bot"}'),  // gh api /user — bot identity
      okResult(existingComments),        // list comments — marker found but unowned
      okResult(),                        // gh pr comment — create new (not PATCH)
    ]);

    const result = await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    // Third call must be a create (gh pr comment), not a PATCH
    expect(runner.calls[2].args[0]).toBe('pr');
    expect(runner.calls[2].args[1]).toBe('comment');
    expect(runner.calls[2].args).not.toContain('PATCH');
  });
});

describe('dispatchOutbox — repohost:pr-summary GitHub App auth (no botLogin)', () => {
  test('PATCHes existing Bot-type comment when /user returns no login', async () => {
    await store.enqueue({ idempotencyKey: 'k5', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    // GitHub App installation tokens: /user returns 200 but no login field
    const existingComments = JSON.stringify([
      { id: 555, body: `${PR_SUMMARY_MARKER}\nold bot summary`, user: { login: 'my-app[bot]', type: 'Bot' } },
    ]);

    const runner = makeRunner([
      okResult('{}'),              // gh api /user — installation token, no login
      okResult(existingComments), // list comments — Bot-type marker found
      okResult(),                  // PATCH edit
    ]);

    const result = await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    // Must PATCH the existing comment, not create a new one
    expect(runner.calls[2].args).toContain('PATCH');
    expect(runner.calls[2].args.some(a => a.includes('comments/555'))).toBe(true);
    expect(runner.calls).toHaveLength(3);
  });

  test('creates new comment when /user returns no login and no Bot comment exists', async () => {
    await store.enqueue({ idempotencyKey: 'k6', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    const runner = makeRunner([
      okResult('{}'),  // gh api /user — no login
      okResult('[]'),  // list comments — none
      okResult(),      // gh pr comment — create new
    ]);

    await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    expect(runner.calls[2].args[0]).toBe('pr');
    expect(runner.calls[2].args[1]).toBe('comment');
    expect(runner.calls[2].args).not.toContain('PATCH');
  });

  test('does not PATCH a non-Bot marker comment when /user returns no login', async () => {
    await store.enqueue({ idempotencyKey: 'k7', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    // A human copied the marker into their own comment — must not be PATCHed
    const existingComments = JSON.stringify([
      { id: 444, body: `${PR_SUMMARY_MARKER}\ncopied by human`, user: { login: 'some-human', type: 'User' } },
    ]);

    const runner = makeRunner([
      okResult('{}'),              // gh api /user — no login
      okResult(existingComments), // list comments — non-Bot marker comment
      okResult(),                  // gh pr comment — create new (not PATCH)
    ]);

    await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    expect(runner.calls[2].args[0]).toBe('pr');
    expect(runner.calls[2].args[1]).toBe('comment');
    expect(runner.calls[2].args).not.toContain('PATCH');
  });

  test('skips foreign-bot comment and PATCHes own newer sticky comment — no spam', async () => {
    await store.enqueue({ idempotencyKey: 'k8', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    // PR has two Bot-authored marker comments: an older foreign-bot comment (id 100)
    // and our own sticky comment created on a prior run (id 200, higher = newer).
    // The function must try newest-first, find id 200 is editable, and PATCH it only —
    // not create a third comment, which would happen every run if it stopped at id 100.
    const existingComments = JSON.stringify([
      { id: 100, body: `${PR_SUMMARY_MARKER}\nforeign bot summary`, user: { type: 'Bot' } },
      { id: 200, body: `${PR_SUMMARY_MARKER}\nour sticky summary`, user: { type: 'Bot' } },
    ]);

    const runner = makeRunner([
      okResult('{}'),              // gh api /user — no login (GitHub App path)
      okResult(existingComments), // list comments — two Bot-type marker comments
      okResult(),                  // PATCH comment 200 (newest, ours) — succeeds
    ]);

    const result = await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    // Must PATCH comment 200 (our sticky), not 100 (foreign bot)
    expect(runner.calls[2].args).toContain('PATCH');
    expect(runner.calls[2].args.some(a => a.includes('comments/200'))).toBe(true);
    // No fourth call (no new comment created)
    expect(runner.calls).toHaveLength(3);
  });

  test('falls back to create new when all Bot-type candidates are foreign-owned', async () => {
    await store.enqueue({ idempotencyKey: 'k9', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });

    // One Bot-authored marker comment owned by a different bot
    const existingComments = JSON.stringify([
      { id: 300, body: `${PR_SUMMARY_MARKER}\nforeign bot only`, user: { type: 'Bot' } },
    ]);

    const runner = makeRunner([
      okResult('{}'),                                      // gh api /user — no login
      okResult(existingComments),                          // list comments — one Bot candidate
      failResult('HTTP 403: Must have push access'),       // PATCH 403 — foreign ownership
      okResult(),                                          // gh pr comment — create new
    ]);

    const result = await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    // call[2] = attempted PATCH (403), call[3] = create new comment
    expect(runner.calls[2].args).toContain('PATCH');
    expect(runner.calls[3].args[0]).toBe('pr');
    expect(runner.calls[3].args[1]).toBe('comment');
    expect(runner.calls[3].args).not.toContain('PATCH');
    expect(runner.calls).toHaveLength(4);
  });
});

describe('dispatchOutbox — repohost:pr-summary idempotency', () => {
  test('duplicate key not re-enqueued', async () => {
    const r1 = await store.enqueue({ idempotencyKey: 'dup', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });
    const r2 = await store.enqueue({ idempotencyKey: 'dup', topic: 'repohost:pr-summary', payload: PR_SUMMARY_PAYLOAD });
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(false);
    expect(await store.listPending()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// enqueuePrSummaryEffect — enqueue gating
// ---------------------------------------------------------------------------

function makeSession(overrides = {}) {
  return {
    sessionId: 'sess',
    repoRoot: '/tmp/repo',
    artifactRoot: '/tmp/artifacts',
    githubOwner: 'org',
    githubName: 'repo',
    githubRepo: 'org/repo',
    verification: { 'npm test': 'npm test' },
    repoHostProvider: { provider: 'github' },
    workItemProvider: { provider: 'github-issues' },
    labels: {},
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    sessionId: 'sess',
    issueNumber: 10,
    status: 'running',
    phase: 'review',
    context: { title: 'Test issue', prUrl: 'https://github.com/org/repo/pull/42' },
    ...overrides,
  };
}

function makeStore() {
  const entries = [];
  return {
    enqueued: entries,
    enqueue(input) {
      const dup = entries.some(e => e.idempotencyKey === input.idempotencyKey);
      if (!dup) entries.push(input);
      return Promise.resolve({ enqueued: !dup });
    },
    replacePendingPrSummary(input, key) {
      // Remove any existing pending entry for the same PR+marker group
      const toRemove = entries.filter(
        e =>
          e.topic === 'repohost:pr-summary' &&
          e.payload?.owner === key.owner &&
          e.payload?.repo === key.repo &&
          e.payload?.prNumber === key.prNumber &&
          e.payload?.marker === key.marker,
      );
      for (const e of toRemove) entries.splice(entries.indexOf(e), 1);
      const dup = entries.some(e => e.idempotencyKey === input.idempotencyKey);
      if (!dup) entries.push(input);
      return Promise.resolve({ enqueued: !dup });
    },
    listPending() { return Promise.resolve([]); },
    markSent() { return Promise.resolve(); },
  };
}

describe('enqueuePrSummaryEffect — phase/result gating', () => {
  test('enqueues for implementation success', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask({ phase: 'implementation' }),
      'implementation',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run1', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].topic).toBe('repohost:pr-summary');
  });

  test('enqueues for review success', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run2', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].topic).toBe('repohost:pr-summary');
  });

  test('enqueues for review needs_fix', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'needs_fix', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run3', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
  });

  test('enqueues for review blocked', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'blocked', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run4', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
  });

  test('enqueues for review blocked when prUrl is on task context only (dirty-worktree handoff)', async () => {
    // Simulates the case where a blocked review transitions with a result context that
    // omits prUrl (e.g. dirty-worktree cleanup handoff replaces context). The pre-transition
    // task still carries prUrl so the effect must fall back to task.context.prUrl.
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(),
      makeTask({ context: { title: 'Test issue', prUrl: 'https://github.com/org/repo/pull/42' } }),
      'review',
      { result: 'blocked', context: {} },
      'run4b', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].topic).toBe('repohost:pr-summary');
  });

  test('does not enqueue for review failed', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'failed', error: 'oops', context: {} },
      'run5', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });

  test('does not enqueue for implementation failed', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask({ phase: 'implementation' }),
      'implementation',
      { result: 'failed', error: 'build failed', context: {} },
      'run6', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });

  test('does not enqueue for implementation blocked', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask({ phase: 'implementation' }),
      'implementation',
      { result: 'blocked', message: 'dependency blocked', context: {} },
      'run7', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });

  test('does not enqueue when no PR URL available', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask({ context: { title: 'Test', body: '', labels: [] } }),
      'review',
      { result: 'success', context: {} },
      'run8', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });
});

describe('enqueuePrSummaryEffect — summary body content', () => {
  test('rendered body contains the PR_SUMMARY_MARKER', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'runX', new Date().toISOString(),
    );
    const payload = s.enqueued[0].payload;
    expect(payload.body).toContain(PR_SUMMARY_MARKER);
  });

  test('rendered body for CI deletion includes deleted file warning', async () => {
    const s = makeStore();
    await enqueuePrSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      {
        result: 'needs_fix',
        context: {
          prUrl: 'https://github.com/org/repo/pull/42',
          diffClassification: DIFF_CLASS_WITH_CI_DELETE,
        },
      },
      'runY', new Date().toISOString(),
    );
    const payload = s.enqueued[0].payload;
    expect(payload.body).toContain('.github/workflows/ci.yml');
    expect(payload.body).toContain('requires justification');
  });

  test('omits issue title when work-item provider is not github-issues (split-provider)', async () => {
    const s = makeStore();
    // Gitea work-item provider + GitHub repo host: title must not appear on the public PR.
    const session = makeSession({ workItemProvider: { provider: 'gitea-issues' } });
    const task = makeTask({ context: { title: 'Private Gitea issue title', prUrl: 'https://github.com/org/repo/pull/42' } });
    await enqueuePrSummaryEffect(
      s, session, task,
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run-split', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].payload.body).not.toContain('Private Gitea issue title');
  });

  test('includes issue title when work-item provider is github-issues (same public surface)', async () => {
    const s = makeStore();
    const session = makeSession({ workItemProvider: { provider: 'github-issues' } });
    const task = makeTask({ context: { title: 'Public GitHub issue title', prUrl: 'https://github.com/org/repo/pull/42' } });
    await enqueuePrSummaryEffect(
      s, session, task,
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run-same', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].payload.body).toContain('Public GitHub issue title');
  });

  test('second run supersedes first run pending entry for same PR', async () => {
    const s = makeStore();
    const task = makeTask();
    const session = makeSession();
    const ctx = { prUrl: 'https://github.com/org/repo/pull/42' };

    await enqueuePrSummaryEffect(s, session, task, 'review', { result: 'success', context: ctx }, 'run-A', '2026-01-01T00:00:00Z');
    await enqueuePrSummaryEffect(s, session, task, 'review', { result: 'success', context: ctx }, 'run-B', '2026-01-01T00:01:00Z');

    // Second run supersedes the first: only the latest pending entry survives
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].idempotencyKey).toContain('run-B');
  });
});

// ---------------------------------------------------------------------------
// SqliteOutboxStore — replacePendingPrSummary stale coalescing
// ---------------------------------------------------------------------------

describe('SqliteOutboxStore.replacePendingPrSummary — coalescing', () => {
  const SUMMARY_KEY = { owner: 'org', repo: 'repo', prNumber: 42, marker: PR_SUMMARY_MARKER };

  function makePayload(body) {
    return {
      topic: 'repohost:pr-summary',
      provider: 'github',
      owner: 'org',
      repo: 'repo',
      prNumber: 42,
      marker: PR_SUMMARY_MARKER,
      body,
    };
  }

  test('deletes pending entry for same PR before inserting new one', async () => {
    // Enqueue run-A directly (bypassing replacePendingPrSummary, as if it were an older entry)
    await store.enqueue({ idempotencyKey: 'run-a', topic: 'repohost:pr-summary', payload: makePayload('old body') });
    expect(await store.listPending()).toHaveLength(1);

    // run-B supersedes run-A
    await store.replacePendingPrSummary(
      { idempotencyKey: 'run-b', topic: 'repohost:pr-summary', payload: makePayload('new body') },
      SUMMARY_KEY,
    );

    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotencyKey).toBe('run-b');
    expect(pending[0].payload.body).toContain('new body');
  });

  test('does not delete already-sent entry for same PR', async () => {
    // run-A was dispatched successfully (sentAt is set)
    await store.enqueue({ idempotencyKey: 'run-a', topic: 'repohost:pr-summary', payload: makePayload('old body') });
    await store.markSent((await store.listPending())[0].id, '2026-01-01T00:00:00Z');

    // run-B should be inserted without disturbing the sent row
    await store.replacePendingPrSummary(
      { idempotencyKey: 'run-b', topic: 'repohost:pr-summary', payload: makePayload('new body') },
      SUMMARY_KEY,
    );

    // Only run-B is pending; run-A stays sent (not deleted)
    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotencyKey).toBe('run-b');
  });

  test('is a no-op when called again with the same idempotency key', async () => {
    await store.replacePendingPrSummary(
      { idempotencyKey: 'run-a', topic: 'repohost:pr-summary', payload: makePayload('body') },
      SUMMARY_KEY,
    );
    const r2 = await store.replacePendingPrSummary(
      { idempotencyKey: 'run-a', topic: 'repohost:pr-summary', payload: makePayload('body') },
      SUMMARY_KEY,
    );
    expect(r2.enqueued).toBe(false);
    expect(await store.listPending()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// dispatchOutbox — stale summary not dispatched after newer entry superseded it
// ---------------------------------------------------------------------------

describe('dispatchOutbox — repohost:pr-summary stale prevention via coalescing', () => {
  test('only the superseding entry is dispatched when older pending was replaced', async () => {
    // run-A enqueued then replaced by run-B
    await store.enqueue({ idempotencyKey: 'run-a', topic: 'repohost:pr-summary', payload: { ...PR_SUMMARY_PAYLOAD, body: `${PR_SUMMARY_MARKER}\nold body` } });
    await store.replacePendingPrSummary(
      { idempotencyKey: 'run-b', topic: 'repohost:pr-summary', payload: { ...PR_SUMMARY_PAYLOAD, body: `${PR_SUMMARY_MARKER}\nnew body` } },
      { owner: 'org', repo: 'repo', prNumber: 42, marker: PR_SUMMARY_MARKER },
    );

    const runner = makeRunner([
      okResult('{"login":"bot"}'),  // gh api /user
      okResult('[]'),               // list comments — none
      okResult(),                   // gh pr comment — create
    ]);

    const result = await dispatchOutbox(store, runner, { cwd: CWD, repoHostRunner: runner });

    // Only 1 entry dispatched (run-B; run-A was superseded before dispatch)
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    // The comment body passed to gh pr comment must contain the new body
    const commentCall = runner.calls[2];
    expect(commentCall.args[0]).toBe('pr');
    expect(commentCall.args[1]).toBe('comment');
    // Body is passed via --body flag
    const bodyFlagIdx = commentCall.args.indexOf('--body');
    expect(bodyFlagIdx).not.toBe(-1);
    expect(commentCall.args[bodyFlagIdx + 1]).toContain('new body');
    expect(commentCall.args[bodyFlagIdx + 1]).not.toContain('old body');
  });
});

// ---------------------------------------------------------------------------
// enqueuePrSummaryEffect — verification failure reports only the failed command
// ---------------------------------------------------------------------------

describe('enqueuePrSummaryEffect — verification failure with multiple commands', () => {
  test('summary body names only the failed command, not the unrun subsequent command', async () => {
    const s = makeStore();
    // Two verification commands configured; the first one fails.
    const session = makeSession({
      verification: { 'npm test': 'npm test', 'npm run package': 'npm run package' },
    });
    await enqueuePrSummaryEffect(
      s, session, makeTask(),
      'review',
      {
        result: 'blocked',
        context: {
          prUrl: 'https://github.com/org/repo/pull/42',
          verificationFailure: { name: 'npm test', exitCode: 1 },
        },
      },
      'run-vf', new Date().toISOString(),
    );

    expect(s.enqueued).toHaveLength(1);
    const body = s.enqueued[0].payload.body;
    // The failed command must appear in the summary.
    expect(body).toContain('npm test');
    // The unrun subsequent command must NOT appear in the summary.
    expect(body).not.toContain('npm run package');
  });
});
