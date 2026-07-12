import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore } from '../dist/index.js';
import { runGithubAppReviewReturn } from '../dist/cli/admin.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

// Capture a single emit() from an in-process command run with an injected reader.
// Only safe for paths that emit (never die → process.exit).
async function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(chunks.join('').trim());
}

// GitHub App (identity-separated) session — the only mode that enables this path.
const APP_AUTH = {
  provider: 'github',
  auth: {
    mode: 'github-app',
    appIdEnv: 'GH_APP_ID',
    installationIdEnv: 'GH_INSTALLATION_ID',
    privateKeyPathEnv: 'GH_APP_PEM',
  },
};

function writeSession(overrides = {}) {
  const session = {
    sessionId: 'addon-dev',
    repoKey: 'some-repo',
    repoRoot,
    githubRepo: 'm2dw/some-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    repoHostProvider: APP_AUTH,
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
}

function makeReader(data = {}) {
  return {
    calls: [],
    readPrReviews(repo, selector) {
      this.calls.push({ repo, selector });
      return {
        prNumber: data.prNumber ?? 42,
        prUrl: data.prUrl ?? 'https://github.com/m2dw/some-repo/pull/42',
        reviews: data.reviews ?? [],
        comments: data.comments ?? [],
      };
    },
  };
}

function changesRequested(overrides = {}) {
  return {
    id: '500',
    author: 'maintainer',
    authorType: 'User',
    state: 'CHANGES_REQUESTED',
    body: 'Please add a null check in parseConfig().',
    submittedAt: '2026-02-01T00:00:00Z',
    url: 'https://github.com/m2dw/some-repo/pull/42#pullrequestreview-500',
    ...overrides,
  };
}

async function seedReadyForHumanTask(issueNumber, contextExtra = {}) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'review' });
  await store.transitionTask(
    { sessionId: 'addon-dev', issueNumber },
    { status: 'queued' },
    {
      status: 'ready_for_human',
      context: {
        prUrl: 'https://github.com/m2dw/some-repo/pull/42',
        branch: 'ai/issue-' + issueNumber,
        labels: ['ai:ready-for-human', 'status:needs-review', 'agent:codex'],
        ...contextExtra,
      },
    },
  );
  store.close();
}

async function getTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  const tasks = store.listTasks('addon-dev', issueNumber);
  store.close();
  return tasks[0];
}

async function getOutbox() {
  const store = new SqliteOutboxStore(dbPath);
  const entries = await store.listPending();
  store.close();
  return entries;
}

function baseArgs(issueNumber) {
  return [
    '--session-id', 'addon-dev',
    '--issue-number', String(issueNumber),
    '--db-path', dbPath,
    '--sessions-path', sessionsPath,
  ];
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-garr-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('github-app-review-return: discoverability + validation', () => {
  test('appears in "help" listing', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('github-app-review-return');
  });

  test('missing --session-id exits non-zero', () => {
    const r = run('github-app-review-return', '--issue-number', '1');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('GitHub App disabled session (default gh auth) refuses the automatic path', async () => {
    writeSession({ repoHostProvider: undefined });
    await seedReadyForHumanTask(1);
    const r = run('github-app-review-return', ...baseArgs(1));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('GitHub App') });
    // Did not requeue.
    const task = await getTask(1);
    expect(task.status).toBe('ready_for_human');
    expect(await getOutbox()).toHaveLength(0);
  });

  test('missing task fails clearly and does not requeue', () => {
    writeSession();
    const r = run('github-app-review-return', ...baseArgs(999));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('Task not found') });
  });
});

describe('github-app-review-return: requeue behavior', () => {
  test('a human CHANGES_REQUESTED review requeues implementation with reviewFeedback', async () => {
    writeSession();
    await seedReadyForHumanTask(20);
    const reader = makeReader({ reviews: [changesRequested()] });
    const out = await capture(() =>
      runGithubAppReviewReturn(baseArgs(20), reader),
    );
    expect(out).toMatchObject({
      ok: true,
      requeued: true,
      status: 'queued',
      phase: 'implementation',
      previousStatus: 'ready_for_human',
      reviewFeedbackSource: 'github-app-review',
      reviewAuthor: 'maintainer',
    });

    const task = await getTask(20);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context.reviewFeedback).toContain('null check');
    expect(task.context.reviewFeedbackSource).toBe('github-app-review');
    expect(typeof task.context.reviewFeedbackRecordedAt).toBe('string');
    expect(task.context.implementationMode).toBe('fix');
    expect(task.context.reviewFeedbackMeta).toMatchObject({
      source: 'github-app-review',
      reviewId: '500',
      reviewAuthor: 'maintainer',
    });
  });

  test('folds inline comments into the stored feedback', async () => {
    writeSession();
    await seedReadyForHumanTask(25);
    const reader = makeReader({
      reviews: [changesRequested({ id: '77', body: 'Summary.' })],
      comments: [
        { reviewId: '77', author: 'maintainer', authorType: 'User', body: 'rename helper', path: 'src/x.ts' },
      ],
    });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(25), reader));
    expect(out.requeued).toBe(true);
    expect(out.inlineComments).toBe(1);
    const task = await getTask(25);
    expect(task.context.reviewFeedback).toContain('Summary.');
    expect(task.context.reviewFeedback).toContain('src/x.ts: rename helper');
  });

  test('moves the issue to the fix lane via the outbox', async () => {
    writeSession();
    await seedReadyForHumanTask(30);
    const reader = makeReader({ reviews: [changesRequested()] });
    await capture(() => runGithubAppReviewReturn(baseArgs(30), reader));

    const entries = await getOutbox();
    const adds = entries.filter((e) => e.topic === 'gh:label:add').map((e) => e.payload.label);
    const removes = entries.filter((e) => e.topic === 'gh:label:remove').map((e) => e.payload.label);
    expect(adds).toContain('status:needs-fix');
    expect(adds).toContain('agent:claude');
    expect(removes).toContain('ai:ready-for-human');
    expect(removes).toContain('status:needs-review');
    expect(removes).toContain('agent:codex');
  });

  test('never echoes the raw review feedback into the public comment', async () => {
    writeSession();
    await seedReadyForHumanTask(35);
    const reader = makeReader({
      reviews: [changesRequested({ body: 'SECRET-FEEDBACK-MARKER do the fix' })],
    });
    await capture(() => runGithubAppReviewReturn(baseArgs(35), reader));
    const comments = (await getOutbox()).filter((e) => e.topic === 'gh:comment');
    expect(comments.length).toBeGreaterThan(0);
    for (const c of comments) {
      expect(c.payload.body).not.toContain('SECRET-FEEDBACK-MARKER');
    }
  });

  test('redacts local/artifact paths from the stored feedback', async () => {
    writeSession();
    await seedReadyForHumanTask(36);
    const reader = makeReader({
      reviews: [changesRequested({ body: 'See /Users/moto/git/secret/file.ts for the bug' })],
    });
    await capture(() => runGithubAppReviewReturn(baseArgs(36), reader));
    const task = await getTask(36);
    expect(task.context.reviewFeedback).not.toContain('/Users/moto');
    expect(task.context.reviewFeedback).toContain('<path>');
  });
});

describe('github-app-review-return: non-requeue outcomes', () => {
  test('approved-only review does not requeue', async () => {
    writeSession();
    await seedReadyForHumanTask(40);
    const reader = makeReader({ reviews: [changesRequested({ state: 'APPROVED', body: '' })] });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(40), reader));
    expect(out).toMatchObject({ ok: true, requeued: false });

    const task = await getTask(40);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.reviewFeedback).toBeUndefined();
    expect(await getOutbox()).toHaveLength(0);
  });

  test('comment-only review does not requeue', async () => {
    writeSession();
    await seedReadyForHumanTask(41);
    const reader = makeReader({ reviews: [changesRequested({ state: 'COMMENTED' })] });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(41), reader));
    expect(out.requeued).toBe(false);
    expect((await getTask(41)).status).toBe('ready_for_human');
  });

  test('bot CHANGES_REQUESTED review is ignored', async () => {
    writeSession();
    await seedReadyForHumanTask(42);
    const reader = makeReader({
      reviews: [changesRequested({ author: 'codex[bot]', authorType: 'Bot' })],
    });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(42), reader));
    expect(out.requeued).toBe(false);
    expect((await getTask(42)).status).toBe('ready_for_human');
    expect(await getOutbox()).toHaveLength(0);
  });

  test('a review already processed by a prior return is not requeued again', async () => {
    writeSession();
    // Task is back at ready_for_human after a fix cycle and still carries the
    // metadata of the review it already returned from. GitHub keeps reporting that
    // same review as the reviewer's latest active state, so a re-poll must skip it.
    await seedReadyForHumanTask(50, {
      reviewFeedbackMeta: {
        source: 'github-app-review',
        reviewId: '500',
        reviewSubmittedAt: '2026-02-01T00:00:00Z',
      },
    });
    const reader = makeReader({ reviews: [changesRequested()] });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(50), reader));
    expect(out).toMatchObject({ ok: true, requeued: false });
    expect(out.reason).toMatch(/already processed/i);

    const task = await getTask(50);
    expect(task.status).toBe('ready_for_human');
    expect(await getOutbox()).toHaveLength(0);
  });

  test('a newer review requeues even when an older one was already processed', async () => {
    writeSession();
    await seedReadyForHumanTask(51, {
      reviewFeedbackMeta: {
        source: 'github-app-review',
        reviewId: '500',
        reviewSubmittedAt: '2026-02-01T00:00:00Z',
      },
    });
    // A later CHANGES_REQUESTED review from the same reviewer (new id + timestamp).
    const reader = makeReader({
      reviews: [
        changesRequested({ id: '600', submittedAt: '2026-03-01T00:00:00Z', body: 'New issue found.' }),
      ],
    });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(51), reader));
    expect(out).toMatchObject({ ok: true, requeued: true });

    const task = await getTask(51);
    expect(task.status).toBe('queued');
    expect(task.context.reviewFeedbackMeta).toMatchObject({ reviewId: '600' });
  });

  test('a different active review with an older timestamp still requeues (multi-reviewer)', async () => {
    writeSession();
    // Bob's newer request (id 600) was processed first; the task carries its
    // metadata. Bob then approves, leaving Alice's older — but never processed —
    // CHANGES_REQUESTED (id 500, earlier timestamp) as the active request. A
    // distinct id must not be suppressed by the submit-timestamp fallback.
    await seedReadyForHumanTask(52, {
      reviewFeedbackMeta: {
        source: 'github-app-review',
        reviewId: '600',
        reviewSubmittedAt: '2026-03-01T00:00:00Z',
      },
    });
    const reader = makeReader({
      reviews: [
        changesRequested({
          id: '500',
          author: 'alice',
          submittedAt: '2026-02-01T00:00:00Z',
          body: "Alice's request still needs fixing.",
        }),
      ],
    });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(52), reader));
    expect(out).toMatchObject({ ok: true, requeued: true });

    const task = await getTask(52);
    expect(task.status).toBe('queued');
    expect(task.context.reviewFeedbackMeta).toMatchObject({ reviewId: '500' });
  });

  test('aggregates all active change requests when several reviewers request changes', async () => {
    writeSession();
    await seedReadyForHumanTask(53);
    // Two reviewers both hold active CHANGES_REQUESTED reviews. Both must be
    // surfaced in one requeue so the older reviewer's feedback is not skipped once
    // the newest review is recorded as processed.
    const reader = makeReader({
      reviews: [
        changesRequested({ id: '500', author: 'alice', submittedAt: '2026-02-01T00:00:00Z', body: 'Alice: fix the parser.' }),
        changesRequested({ id: '600', author: 'bob', submittedAt: '2026-03-01T00:00:00Z', body: 'Bob: tighten the types.' }),
      ],
    });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(53), reader));
    expect(out).toMatchObject({ ok: true, requeued: true, reviewCount: 2 });

    const task = await getTask(53);
    expect(task.context.reviewFeedback).toContain('Alice: fix the parser.');
    expect(task.context.reviewFeedback).toContain('Bob: tighten the types.');
    // Dedup keys on the full aggregated id set (not just the newest contributor).
    expect(task.context.reviewFeedbackMeta).toMatchObject({
      reviewId: '600',
      reviewIds: ['500', '600'],
      reviewCount: 2,
    });
  });

  test('does not re-surface an older active request once both reviewers were aggregated', async () => {
    writeSession();
    // Prior return already aggregated both reviewers (recording the full id set).
    // Both are still active, so a re-poll must skip — Alice was already surfaced.
    await seedReadyForHumanTask(54, {
      reviewFeedbackMeta: {
        source: 'github-app-review',
        reviewId: '600',
        reviewIds: ['500', '600'],
        reviewSubmittedAt: '2026-03-01T00:00:00Z',
        reviewCount: 2,
      },
    });
    const reader = makeReader({
      reviews: [
        changesRequested({ id: '500', author: 'alice', submittedAt: '2026-02-01T00:00:00Z', body: 'Alice: fix the parser.' }),
        changesRequested({ id: '600', author: 'bob', submittedAt: '2026-03-01T00:00:00Z', body: 'Bob: tighten the types.' }),
      ],
    });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(54), reader));
    expect(out).toMatchObject({ ok: true, requeued: false });
    expect(out.reason).toMatch(/already processed/i);
    expect((await getTask(54)).status).toBe('ready_for_human');
  });

  test('does not re-surface an already-aggregated request after the newest reviewer clears theirs', async () => {
    writeSession();
    // Prior return aggregated both Alice (500) and Bob (600), recording the full
    // id set. Bob then approves, so only Alice's older — but already forwarded —
    // request is active. Keying dedup on the newest representative id alone would
    // see id 500 != stored 600 and wrongly requeue Alice's stale feedback again;
    // comparing the full set correctly recognizes 500 as already processed.
    await seedReadyForHumanTask(55, {
      reviewFeedbackMeta: {
        source: 'github-app-review',
        reviewId: '600',
        reviewIds: ['500', '600'],
        reviewSubmittedAt: '2026-03-01T00:00:00Z',
        reviewCount: 2,
      },
    });
    const reader = makeReader({
      reviews: [
        changesRequested({ id: '500', author: 'alice', submittedAt: '2026-02-01T00:00:00Z', body: 'Alice: fix the parser.' }),
        // Bob cleared his earlier change request.
        { id: '600', author: 'bob', authorType: 'User', state: 'APPROVED', body: '', submittedAt: '2026-04-01T00:00:00Z' },
      ],
    });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(55), reader));
    expect(out).toMatchObject({ ok: true, requeued: false });
    expect(out.reason).toMatch(/already processed/i);
    expect((await getTask(55)).status).toBe('ready_for_human');
    expect(await getOutbox()).toHaveLength(0);
  });

  test('a brand-new reviewer requeues even when previously aggregated reviews are unchanged', async () => {
    writeSession();
    // Alice (500) and Bob (600) were already aggregated and forwarded. Carol then
    // adds a fresh CHANGES_REQUESTED (700) — a new id not in the prior set — so the
    // aggregate must requeue to surface Carol's feedback.
    await seedReadyForHumanTask(56, {
      reviewFeedbackMeta: {
        source: 'github-app-review',
        reviewId: '600',
        reviewIds: ['500', '600'],
        reviewSubmittedAt: '2026-03-01T00:00:00Z',
        reviewCount: 2,
      },
    });
    const reader = makeReader({
      reviews: [
        changesRequested({ id: '500', author: 'alice', submittedAt: '2026-02-01T00:00:00Z', body: 'Alice: fix the parser.' }),
        changesRequested({ id: '600', author: 'bob', submittedAt: '2026-03-01T00:00:00Z', body: 'Bob: tighten the types.' }),
        changesRequested({ id: '700', author: 'carol', submittedAt: '2026-04-01T00:00:00Z', body: 'Carol: handle the empty case.' }),
      ],
    });
    const out = await capture(() => runGithubAppReviewReturn(baseArgs(56), reader));
    expect(out).toMatchObject({ ok: true, requeued: true, reviewCount: 3 });

    const task = await getTask(56);
    expect(task.context.reviewFeedback).toContain('Carol: handle the empty case.');
    expect(task.context.reviewFeedbackMeta).toMatchObject({ reviewId: '700', reviewIds: ['500', '600', '700'] });
  });

  test('--dry-run previews without writing to the database or outbox', async () => {
    writeSession();
    await seedReadyForHumanTask(43);
    const reader = makeReader({ reviews: [changesRequested()] });
    const out = await capture(() =>
      runGithubAppReviewReturn([...baseArgs(43), '--dry-run'], reader),
    );
    expect(out).toMatchObject({ ok: true, dryRun: true, requeued: false });

    const task = await getTask(43);
    expect(task.status).toBe('ready_for_human');
    expect(await getOutbox()).toHaveLength(0);
  });
});
