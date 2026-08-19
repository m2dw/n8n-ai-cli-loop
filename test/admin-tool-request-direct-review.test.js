import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore } from '../dist/index.js';

// Issue #722 — direct routing to review after a successful runner-observed
// verification guided run. `docs/unattended-tool-request-contract.md` row 26
// (via `docs/verification-execution-contract.md` §10) is the ONLY
// direct-to-review route; every absent, stale, or ambiguous precondition falls
// back to row 27's shipped implementation continuation. The `grant` alias runs
// the same engine and must produce the identical transition.

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

const PR_URL = 'https://github.com/m2dw/some-repo/pull/42';
const ISSUE = 777;
const BRANCH = `ai/issue-${ISSUE}`;

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;
let lockDir;

function run(...args) {
  if (args[0] === 'tool-request' && (args[1] === 'run' || args[1] === 'grant') && !args.includes('--lock-dir')) {
    args = [...args, '--lock-dir', lockDir];
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function guidedRun(surface = 'run', extra = []) {
  return run('tool-request', surface, '--session-id', 'addon-dev', '--issue-number', String(ISSUE), '--db-path', dbPath, '--sessions-path', sessionsPath, ...extra);
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
    // The configured verification set the guided command must match exactly.
    verification: { test: 'true' },
    labels: {
      active: 'ai:active',
      blocked: 'ai:blocked',
      readyForHuman: 'ai:ready-for-human',
      needsImplementation: 'status:needs-implementation',
      needsReview: 'status:needs-review',
      agentReview: 'agent:codex',
    },
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
}

function git(...a) {
  return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A repository whose issue branch carries committed, pushed work beyond the
 * base — the state a Tool Request handoff leaves behind when the agent stopped
 * to ask for a verification command it could not run itself.
 */
function initRepo({ ignoreArtifacts = true, commitIssueWork = true } = {}) {
  mkdirSync(repoRoot, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"x"}\n', 'utf8');
  writeFileSync(join(repoRoot, '.gitignore'), ignoreArtifacts ? '.n8n-artifacts/\n' : '', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('branch', '-M', 'main');
  const remotePath = join(tmpDir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', remotePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('remote', 'add', 'origin', remotePath);
  git('push', '-q', '-u', 'origin', 'main');

  git('checkout', '-q', '-b', BRANCH);
  if (commitIssueWork) {
    writeFileSync(join(repoRoot, 'feature.txt'), 'issue work\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: issue work');
  }
  git('push', '-q', '-u', 'origin', BRANCH);
  git('checkout', '-q', 'main');
}

async function seedToolRequestTask({ command = 'true', context = {}, request = {} } = {}) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: ISSUE, phase: 'implementation', implementationAgent: 'claude' });
  await store.transitionTask(
    { sessionId: 'addon-dev', issueNumber: ISSUE },
    { status: 'queued' },
    {
      status: 'ready_for_human',
      phase: 'implementation',
      context: {
        labels: ['ai:ready-for-human', 'status:needs-implementation', 'agent:claude'],
        branch: BRANCH,
        prUrl: PR_URL,
        toolRequest: {
          command,
          displayCommand: command,
          reason: 'Needs the configured verification command.',
          expectedFiles: [],
          necessity: 'required',
          suggestedAction: 'guided-run',
          requestedBy: 'claude',
          mode: 'new',
          requestedAt: '2026-08-01T00:00:00.000Z',
          resolved: false,
          ...request,
        },
        ...context,
      },
    },
  );
  store.close();
}

async function getTask() {
  const store = new SqliteTaskStore(dbPath);
  const tasks = store.listTasks('addon-dev', ISSUE);
  store.close();
  return tasks[0];
}

async function getEvents() {
  const store = new SqliteTaskStore(dbPath);
  const events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: ISSUE });
  store.close();
  return events;
}

async function getOutbox() {
  const store = new SqliteOutboxStore(dbPath);
  const entries = await store.listPending();
  store.close();
  return entries;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-trdr-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
  lockDir = join(tmpDir, 'locks');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The eligible case
// ---------------------------------------------------------------------------

describe('admin CLI — direct review after a successful verification guided run', () => {
  test('queues review without another implementation pass', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask();

    const r = guidedRun('run');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'guided-run',
      executed: true,
      exitCode: 0,
      success: true,
      status: 'queued',
      phase: 'review',
      requeued: true,
      continuation: { destination: 'review', reason: 'direct-review' },
    });

    const task = await getTask();
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
    // The request is resolved with its captured output as continuation context.
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(task.context.toolRequest.resolution).toMatchObject({ action: 'guided-run', disposition: 'no-op' });
    // Branch / PR / implementation-complete context survive the transition.
    expect(task.context.branch).toBe(BRANCH);
    expect(task.context.prUrl).toBe(PR_URL);
    // Ownership/error fields are the only ones cleared.
    expect(task.ownerRunId).toBeFalsy();
    expect(task.leaseExpiresAt).toBeFalsy();
    expect(task.lastError).toBeFalsy();
  }, 30_000);

  test('records the continuation phase, reason code and bounded evidence', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask();

    expect(guidedRun('run').code).toBe(0);

    const task = await getTask();
    const continuation = task.context.toolRequestContinuation;
    expect(continuation).toMatchObject({ destination: 'review', reason: 'direct-review', surface: 'guided-run' });
    expect(continuation.evidence.verificationName).toBe('test');
    expect(continuation.evidence.branch).toBe(BRANCH);
    expect(continuation.evidence.failedCheck).toBeUndefined();
    expect(continuation.evidence.checksPassed).toContain('review-admitted');
    // Bounded and path-safe: no local paths, artifact locations, or output.
    const serialized = JSON.stringify(continuation);
    expect(serialized).not.toContain(repoRoot);
    expect(serialized).not.toContain(tmpDir);
    expect(serialized).not.toContain('.n8n-artifacts');

    const routed = (await getEvents()).filter((e) => e.type === 'tool_request_continuation_routed');
    expect(routed).toHaveLength(1);
    expect(routed[0].data).toMatchObject({ destination: 'review', reason: 'direct-review' });
  }, 30_000);

  test('applies the normal implementation-to-review labels and a redacted comment', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask();

    expect(guidedRun('run').code).toBe(0);

    const outbox = await getOutbox();
    const added = outbox.filter((e) => e.topic === 'gh:label:add').map((e) => e.payload.label);
    const removed = outbox.filter((e) => e.topic === 'gh:label:remove').map((e) => e.payload.label);
    expect(added).toEqual(expect.arrayContaining(['status:needs-review', 'agent:codex']));
    expect(added).not.toContain('status:needs-implementation');
    expect(removed).toEqual(expect.arrayContaining(['ai:ready-for-human', 'status:needs-implementation', 'agent:claude']));

    const comment = outbox.find((e) => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('queued for review');
    expect(comment.payload.body).toContain(BRANCH);
    expect(comment.payload.body).not.toContain(repoRoot);
  }, 30_000);

  test('the deprecated grant alias produces the identical transition', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask();

    const r = guidedRun('grant');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'grant',
      status: 'queued',
      phase: 'review',
      requeued: true,
      continuation: { destination: 'review', reason: 'direct-review' },
    });

    const task = await getTask();
    expect(task.phase).toBe('review');
    expect(task.context.toolRequestContinuation).toMatchObject({
      destination: 'review',
      reason: 'direct-review',
      // Only the recorded surface differs between the two operator surfaces.
      surface: 'grant',
    });
    expect(task.context.toolRequestContinuation.evidence.checksPassed).toContain('review-admitted');
  }, 30_000);

  test('a duplicate operator delivery is refused and enqueues no second effect', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask();

    expect(guidedRun('run').code).toBe(0);
    const afterFirst = await getOutbox();

    const second = guidedRun('run');
    expect(second.code).not.toBe(0);

    const task = await getTask();
    expect(task.phase).toBe('review');
    expect(await getOutbox()).toHaveLength(afterFirst.length);
    expect((await getEvents()).filter((e) => e.type === 'tool_request_continuation_routed')).toHaveLength(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Fallback: everything else keeps the implementation continuation
// ---------------------------------------------------------------------------

describe('admin CLI — direct review fallbacks', () => {
  async function expectImplementationFallback(reason) {
    const r = guidedRun('run');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      status: 'queued',
      phase: 'implementation',
      continuation: { destination: 'implementation', reason },
    });
    const task = await getTask();
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequestContinuation).toMatchObject({ destination: 'implementation', reason });
    const routed = (await getEvents()).filter((e) => e.type === 'tool_request_continuation_routed');
    expect(routed[0].data).toMatchObject({ destination: 'implementation', reason });
    return task;
  }

  test('an arbitrary successful command never direct-reviews', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask({ command: 'echo not-a-configured-verification' });

    const task = await expectImplementationFallback('command-not-configured-verification');
    expect(task.context.toolRequestContinuation.evidence.verificationName).toBeUndefined();
  }, 30_000);

  test('unpushed commits on the issue branch never reach the review route', async () => {
    writeSession();
    initRepo();
    // A commit that exists only locally: what review would fetch is not what
    // verification ran on. The shipped preflight refuses to run the command at
    // all in this state, so the direct-review route is never even offered —
    // defense in depth for the `branch-pushed` evidence check.
    git('checkout', '-q', BRANCH);
    writeFileSync(join(repoRoot, 'later.txt'), 'unpushed\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: unpushed');
    git('checkout', '-q', 'main');
    await seedToolRequestTask();

    const r = guidedRun('run');
    expect(r.code).not.toBe(0);
    const task = await getTask();
    expect(task.status).toBe('ready_for_human');
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequestContinuation).toBeUndefined();
  }, 30_000);

  test('a missing PR reference fails closed', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask({ context: { prUrl: undefined } });

    await expectImplementationFallback('pr-not-recorded');
  }, 30_000);

  test('a PR head that is not the branch the command ran on fails closed', async () => {
    writeSession();
    initRepo();
    // No recorded branch: the guided run falls back to the conventional
    // `ai/issue-<n>` name, which the recorded PR head does not identify.
    await seedToolRequestTask({ context: { branch: undefined } });

    await expectImplementationFallback('pr-head-mismatch');
  }, 30_000);

  test('an invalid dependency review base fails closed', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask({ context: { dependencyBase: { baseHeadRefName: 'ai/issue-700' } } });

    await expectImplementationFallback('review-base-missing');
  }, 30_000);

  test('no committed work relative to the review base fails closed', async () => {
    writeSession();
    initRepo({ commitIssueWork: false });
    await seedToolRequestTask();

    await expectImplementationFallback('no-committed-work');
  }, 30_000);

  test('unresolved review feedback fails closed', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask({ context: { reviewFeedback: 'Please guard the null case.' } });

    const task = await expectImplementationFallback('pending-implementation-state');
    expect(task.context.toolRequestContinuation.evidence.pendingMarkers).toContain('review-feedback');
  }, 30_000);

  test('a worktree left dirty outside the change probe fails closed', async () => {
    // The dirtiness probe excludes the session artifact directory; the
    // direct-review clean check does not, so a command that only touched an
    // unignored artifact path still reaches this true-no-op path and is refused
    // review rather than stranding uncommitted bytes review would never see.
    const stray = 'mkdir -p .n8n-artifacts && touch .n8n-artifacts/stray';
    writeSession({ verification: { test: stray } });
    initRepo({ ignoreArtifacts: false });
    await seedToolRequestTask({ command: stray });

    await expectImplementationFallback('worktree-not-clean');
  }, 30_000);

  test('a run that produced repository changes is never direct-reviewed', async () => {
    const writer = 'printf changed > feature.txt';
    writeSession({ verification: { test: writer } });
    initRepo();
    await seedToolRequestTask({ command: writer });

    const r = guidedRun('run', ['--disposition', 'commit']);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ status: 'queued', phase: 'implementation', disposition: 'committed' });

    const task = await getTask();
    expect(task.phase).toBe('implementation');
    // The changed-files route never reaches the continuation decision.
    expect(task.context.toolRequestContinuation).toBeUndefined();
  }, 30_000);

  test('manual-done keeps the implementation continuation', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask();

    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', String(ISSUE), '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const task = await getTask();
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequestContinuation).toBeUndefined();
  }, 30_000);
});
