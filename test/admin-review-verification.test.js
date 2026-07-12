import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore } from '../dist/index.js';

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
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
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
        labels: ['ai:ready-for-human'],
        missingVerificationCommands: ['npm run export -- --dry-run'],
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-rvr-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discoverability
// ---------------------------------------------------------------------------

describe('admin CLI — review-verification resolve: discoverability', () => {
  test('appears in "help" listing', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('review-verification');
  });

  test('"help review-verification resolve" shows its options', () => {
    const r = run('help', 'review-verification resolve');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--command');
    expect(r.stdout).toContain('--exit-code');
    expect(r.stdout).toContain('--issue-number');
    expect(r.stdout).toContain('--output');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('admin CLI — review-verification resolve: validation', () => {
  test('missing --session-id exits non-zero', () => {
    const r = run('review-verification', 'resolve', '--issue-number', '1', '--command', 'npm test', '--exit-code', '0');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('missing --issue-number exits non-zero', () => {
    writeSession();
    const r = run('review-verification', 'resolve', '--session-id', 'addon-dev', '--command', 'npm test', '--exit-code', '0');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('missing --command exits non-zero', () => {
    writeSession();
    const r = run('review-verification', 'resolve', '--session-id', 'addon-dev', '--issue-number', '1', '--exit-code', '0');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('command') });
  });

  test('missing --exit-code exits non-zero', () => {
    writeSession();
    const r = run('review-verification', 'resolve', '--session-id', 'addon-dev', '--issue-number', '1', '--command', 'npm test');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('exit-code') });
  });

  test('both --output and --output-file exits non-zero', () => {
    writeSession();
    const r = run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '1',
      '--command', 'npm test',
      '--exit-code', '0',
      '--output', 'some output',
      '--output-file', '/tmp/out.txt',
    );
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('output') });
  });

  test('missing task fails clearly', () => {
    writeSession();
    const r = run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '999',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
    );
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('Task not found') });
  });

  test('refuses to modify an active (claimed) task', async () => {
    writeSession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 5, phase: 'review' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 5 },
      { status: 'queued' },
      { status: 'claimed', ownerRunId: 'run-1', leaseExpiresAt: new Date(Date.now() + 60000).toISOString() },
    );
    store.close();

    const r = run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '5',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
    );
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('claimed') });
  });

  test('unknown review-verification action exits non-zero', () => {
    const r = run('review-verification', 'unknown-action');
    expect(r.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Passing verification (exit 0) — regression coverage for issue #593 / #213-style loop
// ---------------------------------------------------------------------------

describe('admin CLI — review-verification resolve: passing verification (exit 0)', () => {
  test('stores evidence in context and requeues to review (not implementation fix mode)', async () => {
    // Regression: review missing command → operator supplies successful result →
    // task must NOT return to implementation fix mode.
    writeSession();
    await seedReadyForHumanTask(10);

    const r = run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '10',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
      '--output', 'Exported 42 files. Done.',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      action: 'requeue_review',
      status: 'queued',
      phase: 'review',   // must be review, NOT implementation
      previousStatus: 'ready_for_human',
      command: 'npm run export -- --dry-run',
      exitCode: 0,
    });

    const task = await getTask(10);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');   // must be review, NOT implementation
    expect(task.context.implementationMode).toBeUndefined(); // no fix mode set
  });

  test('stores manualVerificationEvidence in task context', async () => {
    writeSession();
    await seedReadyForHumanTask(11);

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '11',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
      '--output', 'Exported 42 files.',
    );

    const task = await getTask(11);
    const evidence = task.context.manualVerificationEvidence;
    expect(Array.isArray(evidence)).toBe(true);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      command: 'npm run export -- --dry-run',
      exitCode: 0,
      source: 'operator_input',
    });
    expect(typeof evidence[0].recordedAt).toBe('string');
  });

  test('accumulates evidence across multiple commands', async () => {
    writeSession();
    await seedReadyForHumanTask(12, {
      missingVerificationCommands: ['npm run export -- --dry-run', 'npm run lint'],
    });

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '12',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
      '--output', 'Exported 42 files.',
    );

    // Second command after task was requeued to review and blocked again
    const store = new SqliteTaskStore(dbPath);
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 12 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );
    store.close();

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '12',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run lint',
      '--exit-code', '0',
      '--output', 'No lint errors.',
    );

    const task = await getTask(12);
    const evidence = task.context.manualVerificationEvidence;
    expect(Array.isArray(evidence)).toBe(true);
    expect(evidence).toHaveLength(2);
    expect(evidence.map((e) => e.command)).toContain('npm run export -- --dry-run');
    expect(evidence.map((e) => e.command)).toContain('npm run lint');
  });

  test('replaces existing evidence for the same command', async () => {
    writeSession();
    await seedReadyForHumanTask(13, {
      manualVerificationEvidence: [{
        command: 'npm run export -- --dry-run',
        exitCode: 0,
        output: 'old output',
        recordedAt: '2026-01-01T00:00:00.000Z',
        source: 'operator_input',
      }],
    });

    const store = new SqliteTaskStore(dbPath);
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 13 },
      { status: 'ready_for_human' },
      { status: 'ready_for_human' },
    );
    store.close();

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '13',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
      '--output', 'new output',
    );

    const task = await getTask(13);
    const evidence = task.context.manualVerificationEvidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0].output).toContain('new output');
  });

  test('--dry-run previews without writing to database or outbox', async () => {
    writeSession();
    await seedReadyForHumanTask(14);

    const r = run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '14',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
      '--dry-run',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, dryRun: true, wouldRequeue: { status: 'queued', phase: 'review' } });

    const task = await getTask(14);
    expect(task.status).toBe('ready_for_human');   // unchanged
    expect(await getOutbox()).toHaveLength(0);       // no outbox entries
  });

  test('enqueues ready-for-human label removal in the outbox', async () => {
    writeSession();
    await seedReadyForHumanTask(15);

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '15',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
    );

    const entries = await getOutbox();
    const removes = entries.filter((e) => e.topic === 'gh:label:remove').map((e) => e.payload.label);
    expect(removes).toContain('ai:ready-for-human');
  });

  test('restores review-lane labels (needs-review + agent) so github-intake can rediscover the task', async () => {
    // Regression for the label gap: blocked-review removes status:needs-review and
    // the reviewer agent label; this path must add them back so github-intake picks
    // up the re-queued review task.
    writeSession();
    await seedReadyForHumanTask(15);

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '15',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
    );

    const entries = await getOutbox();
    const adds = entries.filter((e) => e.topic === 'gh:label:add').map((e) => e.payload.label);
    // Default label names (session has no needsReview / agentReview keys).
    expect(adds).toContain('status:needs-review');
    expect(adds).toContain('agent:codex');
  });

  test('restores custom review-lane labels when session overrides needsReview / agentReview', async () => {
    writeSession({
      labels: {
        active: 'ai:active',
        blocked: 'ai:blocked',
        readyForHuman: 'ai:ready-for-human',
        needsReview: 'custom:needs-review',
        agentReview: 'custom:agent-review',
      },
    });
    await seedReadyForHumanTask(15);

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '15',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
    );

    const entries = await getOutbox();
    const adds = entries.filter((e) => e.topic === 'gh:label:add').map((e) => e.payload.label);
    expect(adds).toContain('custom:needs-review');
    expect(adds).toContain('custom:agent-review');
    // Default labels must NOT be added when session has custom ones.
    expect(adds).not.toContain('status:needs-review');
    expect(adds).not.toContain('agent:codex');
  });

  test('enqueues a status comment in the outbox', async () => {
    writeSession();
    await seedReadyForHumanTask(16);

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '16',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '0',
      '--output', 'Dry run passed.',
    );

    const entries = await getOutbox();
    const comments = entries.filter((e) => e.topic === 'gh:comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].payload.body).toContain('npm run export -- --dry-run');
  });
});

// ---------------------------------------------------------------------------
// Failed verification (exit != 0) — routes to fix mode
// ---------------------------------------------------------------------------

describe('admin CLI — review-verification resolve: failed verification (exit != 0)', () => {
  test('routes to implementation fix mode with failure feedback', async () => {
    writeSession();
    await seedReadyForHumanTask(20);

    const r = run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '20',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '1',
      '--output', 'Error: missing module',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      action: 'fix_mode',
      status: 'queued',
      phase: 'implementation',
      exitCode: 1,
    });

    const task = await getTask(20);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context.implementationMode).toBe('fix');
    expect(task.context.reviewFeedback).toContain('npm run export -- --dry-run');
    expect(task.context.reviewFeedback).toContain('exit 1');
  });

  test('failed verification does not store manualVerificationEvidence (fix mode handles it)', async () => {
    writeSession();
    await seedReadyForHumanTask(21);

    run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '21',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '2',
      '--output', 'ENOENT: file not found',
    );

    const task = await getTask(21);
    // Task went to fix mode; no evidence array needed (fix mode uses reviewFeedback instead)
    expect(task.phase).toBe('implementation');
    expect(task.context.implementationMode).toBe('fix');
  });

  test('--dry-run for failed verification previews fix-mode requeue without writing', async () => {
    writeSession();
    await seedReadyForHumanTask(22);

    const r = run(
      'review-verification', 'resolve',
      '--session-id', 'addon-dev',
      '--issue-number', '22',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--command', 'npm run export -- --dry-run',
      '--exit-code', '1',
      '--dry-run',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      dryRun: true,
      action: 'fix_mode',
      wouldRequeue: { status: 'queued', phase: 'implementation' },
    });

    const task = await getTask(22);
    expect(task.status).toBe('ready_for_human');   // unchanged
    expect(await getOutbox()).toHaveLength(0);
  });
});
