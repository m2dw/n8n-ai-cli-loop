import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

// Stand the task up in the shape the implementation handler's tool_request
// handoff leaves it: ready_for_human on the implementation phase with the
// structured request stored under context.toolRequest.
async function seedToolRequestTask(issueNumber, toolRequestExtra = {}) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'implementation', implementationAgent: 'claude' });
  await store.transitionTask(
    { sessionId: 'addon-dev', issueNumber },
    { status: 'queued' },
    {
      status: 'ready_for_human',
      phase: 'implementation',
      context: {
        labels: ['ai:ready-for-human', 'status:needs-implementation', 'agent:claude'],
        toolRequest: {
          command: 'npm install left-pad --token=SECRET123',
          displayCommand: 'npm install left-pad --token=***',
          reason: 'The fix depends on left-pad which is not a dependency yet.',
          expectedFiles: ['package.json', 'package-lock.json'],
          necessity: 'required',
          suggestedAction: 'dependencySync',
          requestedBy: 'claude',
          mode: 'new',
          requestedAt: '2026-06-07T00:00:00.000Z',
          resolved: false,
          ...toolRequestExtra,
        },
      },
    },
  );
  store.close();
}

// Stand up a real git checkout at repoRoot so the manual-done requeue path can
// probe `git status --porcelain`. With dirty: true a tracked file is left
// modified to mimic an operator's repo-mutating command (e.g. `npm install`).
// With withRemote: true an `origin` is wired up and `main` pushed so the
// local-base-ahead probe (`git rev-list origin/main..main`) has a tracking ref;
// baseAhead: true then adds a *committed* but unpushed change to mimic an operator
// who committed the requested changes locally (clean worktree, base ahead).
function initRepo({ dirty, withRemote, baseAhead } = {}) {
  mkdirSync(repoRoot, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"x"}\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('branch', '-M', 'main');
  if (withRemote || baseAhead) {
    const remotePath = join(tmpDir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', remotePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('remote', 'add', 'origin', remotePath);
    git('push', '-q', '-u', 'origin', 'main');
  }
  if (baseAhead) {
    // Operator committed the requested change locally but never pushed it.
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    git('commit', '-q', '-am', 'add left-pad');
  }
  if (dirty) {
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
  }
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
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-tr-test-'));
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

describe('admin CLI — tool-request: discoverability', () => {
  test('list and resolve appear in "help" listing', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tool-request list');
    expect(r.stdout).toContain('tool-request resolve');
  });

  test('"help tool-request resolve" shows its options', () => {
    const r = run('help', 'tool-request resolve');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--action');
    expect(r.stdout).toContain('--issue-number');
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request list', () => {
  test('missing --session-id exits non-zero', () => {
    const r = run('tool-request', 'list');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('lists unresolved tool requests with structured metadata', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.count).toBe(1);
    expect(out.toolRequests[0]).toMatchObject({
      issueNumber: 123,
      status: 'ready_for_human',
      phase: 'implementation',
      command: 'npm install left-pad --token=SECRET123',
      displayCommand: 'npm install left-pad --token=***',
      necessity: 'required',
      suggestedAction: 'dependencySync',
      resolved: false,
    });
    expect(out.toolRequests[0].expectedFiles).toEqual(['package.json', 'package-lock.json']);
  });

  test('excludes resolved tool requests by default but includes them with --all', async () => {
    writeSession();
    await seedToolRequestTask(123, { resolved: true, resolution: { action: 'reject', resolvedAt: '2026-06-07T01:00:00.000Z' } });

    const def = parse(run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath));
    expect(def.count).toBe(0);

    const all = parse(run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath, '--all'));
    expect(all.count).toBe(1);
    expect(all.toolRequests[0].resolved).toBe(true);
  });

  test('ignores tasks without a tool request', async () => {
    writeSession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 5, phase: 'implementation' });
    store.close();
    const out = parse(run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath));
    expect(out.count).toBe(0);
  });

  // Regression (issue #379 review): the handoff snapshots the agent's
  // uncommitted partial work to `partial-implementation.patch` in the run's
  // artifact dir and records both the filename (on the tool request) and the
  // artifact dir (in context). The operator must be able to locate that patch
  // through the documented CLI path, otherwise the manual-done recovery that
  // tells them to reapply it points at a directory they cannot identify.
  test('exposes the preserved partial-work patch and its artifact dir', async () => {
    writeSession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 61, phase: 'implementation', implementationAgent: 'claude' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 61 },
      { status: 'queued' },
      {
        status: 'ready_for_human',
        phase: 'implementation',
        context: {
          labels: ['ai:ready-for-human'],
          artifactDir: '.n8n-artifacts/runs/impl-issue-61-1234',
          toolRequest: {
            command: 'npm install tldts',
            reason: 'psl.ts depends on tldts which is not a dependency yet.',
            expectedFiles: ['package.json', 'package-lock.json'],
            necessity: 'required',
            suggestedAction: 'dependencySync',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-07T00:00:00.000Z',
            resolved: false,
            partialDiffArtifact: 'partial-implementation.patch',
          },
        },
      },
    );
    store.close();

    const out = parse(run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath));
    expect(out.count).toBe(1);
    expect(out.toolRequests[0]).toMatchObject({
      issueNumber: 61,
      partialDiffArtifact: 'partial-implementation.patch',
      artifactDir: '.n8n-artifacts/runs/impl-issue-61-1234',
    });
  });

  // A tool request without preserved partial work (e.g. an agent that emitted
  // the request before touching the tree) reports null rather than omitting the
  // fields, so consumers can rely on their presence.
  test('reports null patch fields when no partial work was preserved', async () => {
    writeSession();
    await seedToolRequestTask(124);
    const out = parse(run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath));
    expect(out.count).toBe(1);
    expect(out.toolRequests[0].partialDiffArtifact).toBeNull();
    expect(out.toolRequests[0].artifactDir).toBeNull();
  });

  // Issue #390: when capture failed the handoff keeps the issue branch as the
  // continuation point instead of writing a patch. `list` must surface that so an
  // operator sees where the work went (a branch, not a patch).
  test('surfaces the preserved branch and capture-failure reason (issue #390)', async () => {
    writeSession();
    await seedToolRequestTask(125, {
      preservedBranch: 'ai/issue-125',
      preservedBranchPushed: true,
      partialDiffCaptureFailed: 'git diff --cached --binary HEAD failed (exit 128)',
    });
    const out = parse(run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath));
    expect(out.count).toBe(1);
    expect(out.toolRequests[0]).toMatchObject({
      issueNumber: 125,
      preservedBranch: 'ai/issue-125',
      preservedBranchPushed: true,
      partialDiffArtifact: null,
      noPriorDiff: false,
    });
    expect(out.toolRequests[0].partialDiffCaptureFailed).toContain('exit 128');
  });

  // Issue #390: when the agent produced no diff the handoff records noPriorDiff so
  // operators know there is no patch to look for.
  test('surfaces noPriorDiff when the agent produced no file changes (issue #390)', async () => {
    writeSession();
    await seedToolRequestTask(126, { noPriorDiff: true });
    const out = parse(run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath));
    expect(out.toolRequests[0]).toMatchObject({ issueNumber: 126, noPriorDiff: true, partialDiffArtifact: null });
  });
});

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request resolve', () => {
  test('rejects an unknown --action', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'bogus', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--action') });
  });

  test('reject requires --message', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'reject', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('message') });
  });

  test('reject redacts an operator --message worktree path under a non-standard root', async () => {
    // Regression (issue #400 review follow-up): the published resolution comment
    // must run through sessionRedactionPaths, which includes the session worktree
    // root. A root under a non-standard top-level directory is NOT caught by
    // sanitizeBody's generic absolute-path heuristic, so without the worktree root
    // in the redaction set an operator-supplied path would leak into the public
    // comment.
    writeSession({ worktrees: { enabled: true, root: '/n8nwt/worktrees' } });
    await seedToolRequestTask(123);
    const leakedPath = '/n8nwt/worktrees/addon-dev/issue-123/repo';
    const r = run(
      'tool-request', 'resolve',
      '--session-id', 'addon-dev', '--issue-number', '123',
      '--action', 'reject', '--message', `Already handled in ${leakedPath} manually.`,
      '--db-path', dbPath, '--sessions-path', sessionsPath,
    );
    expect(r.code).toBe(0);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('rejected by operator');
    expect(comment.payload.body).not.toContain(leakedPath);
    expect(comment.payload.body).not.toContain('/n8nwt/worktrees');
    expect(comment.payload.body).toContain('<path>');
  });

  test('errors when there is no tool request to resolve', async () => {
    writeSession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 7, phase: 'implementation' });
    store.close();
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '7', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no Tool Request') });
  });

  test('manual-done requeues the task to implementation and marks the request resolved', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', status: 'queued', phase: 'implementation', requeued: true });

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(task.context.toolRequest.resolution.action).toBe('manual-done');

    // Public comment + label swap back to the implementation lane.
    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('manually completed');
    expect(comment.payload.body).not.toContain('approved');
    expect(comment.payload.body).toContain('does not approve the command for future automated runs');
    // Resolution comment must use the redacted display command, never the secret.
    expect(comment.payload.body).not.toContain('SECRET123');
    expect(comment.payload.body).toContain('--token=***');
    const removed = outbox.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(removed).toContain('ai:ready-for-human');
    expect(added).toContain('status:needs-implementation');
    expect(added).toContain('agent:claude');
  });

  test('manual-done requeues a fix-mode request under the needs-fix label, not needs-implementation', async () => {
    // Regression (issue #291 review follow-up): a Tool Request recorded from fix mode
    // (mode: "fix") must re-advertise the fix-lane status on requeue. Adding
    // status:needs-implementation would present the resolved request as fresh
    // implementation work instead of the fix it actually is.
    writeSession();
    await seedToolRequestTask(123, {
      mode: 'fix',
      requestedBy: 'claude',
    });
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);

    const outbox = await getOutbox();
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).toContain('status:needs-fix');
    expect(added).not.toContain('status:needs-implementation');
    expect(added).toContain('agent:claude');
  });

  test('manual-done treats preserved review feedback as a fix-mode request', async () => {
    // A request whose stored mode is absent but whose task still carries review
    // feedback is an automatic fix-mode requeue and must relabel to the fix lane.
    writeSession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 123, phase: 'implementation', implementationAgent: 'claude' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 123 },
      { status: 'queued' },
      {
        status: 'ready_for_human',
        phase: 'implementation',
        context: {
          labels: ['ai:ready-for-human', 'status:needs-fix', 'agent:claude'],
          reviewFeedback: 'Address the blocking finding before merge.',
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'Needs left-pad.',
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'fix',
            requestedAt: '2026-06-07T00:00:00.000Z',
            resolved: false,
          },
        },
      },
    );
    store.close();

    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);

    const outbox = await getOutbox();
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).toContain('status:needs-fix');
    expect(added).not.toContain('status:needs-implementation');
  });

  test('manual-done relabels with the session default agent when no assignment is persisted', async () => {
    // Regression (issue #291 review follow-up): a legacy/manually enqueued task with
    // no persisted assignment and no implementationAgent column must relabel with the
    // session default implementation agent (codex here), not the hardcoded agent:claude
    // fallback — otherwise GitHub labels misroute label-driven recovery/intake.
    writeSession({ defaults: { implementationAgent: 'codex', reviewAgent: 'gemini' } });
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 123, phase: 'implementation' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 123 },
      { status: 'queued' },
      {
        status: 'ready_for_human',
        phase: 'implementation',
        context: {
          labels: ['ai:ready-for-human', 'status:needs-implementation', 'agent:codex'],
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'Needs left-pad.',
            necessity: 'required',
            requestedBy: 'codex',
            mode: 'new',
            requestedAt: '2026-06-07T00:00:00.000Z',
            resolved: false,
          },
        },
      },
    );
    store.close();

    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);

    const outbox = await getOutbox();
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).toContain('agent:codex');
    expect(added).not.toContain('agent:claude');
  });

  test('reject records the decision, keeps the human handoff, and never requeues', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'reject', '--message', 'Avoid this dependency change.', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'reject', status: 'ready_for_human', requeued: false });

    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(task.context.toolRequest.resolution).toMatchObject({ action: 'reject', message: 'Avoid this dependency change.' });

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('rejected');
    expect(comment.payload.body).toContain('Avoid this dependency change.');
    // No label re-add to the implementation lane on reject.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).not.toContain('status:needs-implementation');
  });

  test('refuses to resolve an already-resolved request', async () => {
    writeSession();
    await seedToolRequestTask(123, { resolved: true, resolution: { action: 'manual-done', resolvedAt: '2026-06-07T01:00:00.000Z' } });
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'reject', '--message', 'x', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('already resolved') });
  });

  test('manual-done refuses to requeue when the session checkout is dirty', async () => {
    // Regression (issue #291 review follow-up): the requested command commonly
    // mutates repo files (npm install rewriting package.json/lockfiles). If the
    // operator runs it and leaves the edits uncommitted, requeueing would mark the
    // request resolved while the implementation preflight aborts every retry as
    // dirty — a dead end. Refuse up front instead.
    writeSession();
    initRepo({ dirty: true });
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain('dirty');
    // Names the expected changed files so the operator knows what to land.
    expect(out.error).toContain('package.json');

    // The task is left untouched — still a human handoff, request unresolved.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(await getOutbox()).toHaveLength(0);
  });

  test('manual-done requeues when the session checkout is a clean git tree', async () => {
    writeSession();
    initRepo({ dirty: false });
    // Issue #379: a usable continuation point must exist to requeue. With no
    // origin configured, a local issue branch carrying the landed side effects is
    // a sufficient resume point — the dirty-tree guard must still pass cleanly.
    execFileSync('git', ['checkout', '-q', '-b', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    execFileSync('git', ['commit', '-q', '-am', 'land tool request change'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', status: 'queued', requeued: true });
    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.context.toolRequest.resolved).toBe(true);
  });

  test('manual-done records the issue branch as the implementation resume point when it exists locally', async () => {
    // Issue #316 review: a Tool Request grant (or the operator) can land the side
    // effects on `ai/issue-<n>` before manual-done. If that branch already exists,
    // the requeued implementation run must resume from it — recreating it with
    // `git checkout -b` would collide and strand the changes. Record the branch.
    writeSession();
    initRepo({ dirty: false });
    // Operator landed the changes on the issue branch, then returned to main.
    execFileSync('git', ['checkout', '-q', '-b', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    execFileSync('git', ['commit', '-q', '-am', 'land tool request change'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot, encoding: 'utf8' });

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', requeued: true });
    const task = await getTask(123);
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });

  test('manual-done refuses when the local issue branch is not pushed to origin', async () => {
    // Issue #316 review (P2): when manual-done finds the issue branch only in this
    // checkout, recording it as the resume point is unsafe if its commits were not
    // pushed. A later Tool Request handoff deletes the branch with `git branch -D`
    // (the non-fix cleanup), dropping the only ref to those side-effect commits.
    // With origin configured, require the branch to exist on origin before
    // requeueing; refuse a local-only branch.
    writeSession();
    initRepo({ withRemote: true });
    // Operator committed the side effects on the issue branch locally but never
    // pushed it; origin has no ai/issue-123.
    execFileSync('git', ['checkout', '-q', '-b', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    execFileSync('git', ['commit', '-q', '-am', 'land tool request change'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot, encoding: 'utf8' });

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain("exists only in this checkout");
    expect(out.error).toContain("git branch -D");
    // Fail closed: request left unresolved, task untouched, nothing emitted.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestResumeBranch).toBeUndefined();
    expect(await getOutbox()).toHaveLength(0);
  });

  test('manual-done refuses when the local issue branch is ahead of its pushed origin counterpart', async () => {
    // Issue #316 review (P2): the branch can be on origin yet still carry unpushed
    // local commits (the operator pushed once, then committed more side effects).
    // Those extra commits are the only ref locally and a later `git branch -D`
    // would lose them, so refuse until the branch is fully pushed.
    writeSession();
    initRepo({ withRemote: true });
    execFileSync('git', ['checkout', '-q', '-b', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    execFileSync('git', ['commit', '-q', '-am', 'land tool request change'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['push', '-q', 'origin', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    // A further unpushed commit leaves the local branch ahead of origin.
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0","ms":"^2.1.3"}}\n', 'utf8');
    execFileSync('git', ['commit', '-q', '-am', 'more tool request changes'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot, encoding: 'utf8' });

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain("ahead of origin/ai/issue-123");
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestResumeBranch).toBeUndefined();
  });

  test('manual-done records the resume point when the local issue branch is pushed and not ahead', async () => {
    // Issue #316 review (P2): a fully pushed local issue branch is a safe resume
    // point — a later `git branch -D` cannot lose commits that are already on
    // origin — so it is still recorded.
    writeSession();
    initRepo({ withRemote: true });
    execFileSync('git', ['checkout', '-q', '-b', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    execFileSync('git', ['commit', '-q', '-am', 'land tool request change'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['push', '-q', 'origin', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot, encoding: 'utf8' });

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', requeued: true });
    const task = await getTask(123);
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });

  test('manual-done refuses to requeue branchlessly with no preserved issue state (issue #379)', async () => {
    // Regression (issue #379): in a real git checkout with no issue branch (local
    // or on origin), no PR, and the requested command's side effects committed
    // nowhere, requeueing would branch a fresh implementation run from `main` with
    // NONE of the prior work — reproducing the same blocker and re-emitting the same
    // Tool Request (a loop). manual-done must fail closed and explain the recovery
    // requirement instead of resolving the request into a dead loop.
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain('no usable continuation point');
    expect(out.error).toContain("issue branch 'ai/issue-123'");
    // The recovery names the preserved partial-implementation patch and forbids
    // pushing the base branch.
    expect(out.error).toContain('partial-implementation.patch');
    expect(out.error).toContain("never the base branch 'main'");
    // Fail closed: request left unresolved, task untouched, nothing emitted, and no
    // resume point is invented.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestResumeBranch).toBeUndefined();
    expect(await getOutbox()).toHaveLength(0);
  });

  // Issue #390: when the prior attempt produced NO implementation diff there is no
  // patch to reapply. The refusal must say so explicitly rather than telling the
  // operator to look for a nonexistent partial-implementation.patch.
  test('manual-done refusal does not point at a patch when no diff was produced (issue #390)', async () => {
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, { noPriorDiff: true });
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.error).toContain('no usable continuation point');
    expect(out.error).toContain('no implementation diff');
    expect(out.error).toContain('NO partial-implementation');
    // It must NOT use the "apply the preserved ... patch ... if present" wording.
    expect(out.error).not.toContain('if present');
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
  });

  // Issue #390: when capture failed (a diff may have existed but no patch was
  // written), the refusal explains that and surfaces the recorded reason instead
  // of implying a patch exists.
  test('manual-done refusal explains a capture failure and surfaces its reason (issue #390)', async () => {
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, { partialDiffCaptureFailed: 'git diff --cached --binary HEAD failed (exit 128)' });
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.error).toContain('no usable continuation point');
    expect(out.error).toContain('partial-diff capture failed');
    expect(out.error).toContain('exit 128');
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
  });

  test('manual-done does not requeue off a stale resume branch when this request lands no issue branch (issue #379)', async () => {
    // Issue #379: a task may already carry toolRequestResumeBranch from an EARLIER
    // Tool Request that no longer exists. manual-done must not blindly trust that
    // stale value to requeue: it recomputes the continuation point for THIS request
    // and, finding no issue branch (local or on origin), fails closed rather than
    // resuming from a branch that is gone. The task is left untouched for recovery.
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123);
    // Inject a stale resume branch from a prior Tool Request.
    {
      const store = new SqliteTaskStore(dbPath);
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 123 },
        { status: 'ready_for_human' },
        { status: 'ready_for_human', phase: 'implementation', context: { toolRequestResumeBranch: 'ai/issue-123-stale' } },
      );
      store.close();
    }
    expect((await getTask(123)).context.toolRequestResumeBranch).toBe('ai/issue-123-stale');

    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false });
    expect(parse(r).error).toContain('no usable continuation point');
    const task = await getTask(123);
    // Fail closed: request stays unresolved; nothing was requeued off the stale ref.
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(await getOutbox()).toHaveLength(0);
  });

  test('manual-done records the resume point when the issue branch was pushed but is not local', async () => {
    // Issue #316 review: the manual-done guidance tells operators to commit/push
    // the issue branch, which they may do from another clone — leaving
    // `ai/issue-<n>` on origin but absent from this checkout. The local-only probe
    // would miss it and branch fresh from base, discarding the pushed side effects.
    // Probe origin too so the pushed branch still requeues with a resume point.
    writeSession();
    initRepo({ withRemote: true });
    // Operator landed + pushed the issue branch from another clone, so it lives on
    // origin only; mimic that by pushing then deleting the local branch here.
    execFileSync('git', ['checkout', '-q', '-b', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    execFileSync('git', ['commit', '-q', '-am', 'land tool request change'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['push', '-q', 'origin', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['branch', '-q', '-D', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', requeued: true });
    const task = await getTask(123);
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });

  test('manual-done refuses when the issue-branch origin lookup is inconclusive', async () => {
    // Issue #316 review (P2): when the branch is absent locally, a transient
    // ls-remote failure must NOT be read as "branch absent". Collapsing unknown to
    // false would leave the resume point unset and requeue a run that branches from
    // base, discarding side effects the operator pushed from another clone. With
    // origin configured but unreachable, the lookup is inconclusive and the resolve
    // must refuse so the operator retries.
    writeSession();
    initRepo({ withRemote: true });
    // No local ai/issue-123 branch; point origin at a path that does not exist so
    // ls-remote fails with a non-2 (ambiguous) status.
    execFileSync('git', ['remote', 'set-url', 'origin', join(tmpDir, 'does-not-exist.git')], { cwd: repoRoot, encoding: 'utf8' });

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain("could not determine whether origin has the issue branch 'ai/issue-123'");
    // Fail closed: request left unresolved, task untouched, nothing emitted.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(await getOutbox()).toHaveLength(0);
  });

  test('manual-done refuses to requeue when the local base branch is ahead of origin', async () => {
    // Regression (issue #291 review follow-up): an operator who *commits* the
    // requested change leaves a clean worktree but a local base branch ahead of
    // origin. The implementation preflight branches each issue off that local base,
    // so the unpushed commit would leak into this and later issue branches. Refuse
    // until the base is pushed.
    writeSession();
    initRepo({ baseAhead: true });
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain('ahead of origin/main');
    // Issue #316: the recovery must move/drop the base-branch commits onto the
    // issue branch — never push the base branch.
    expect(out.error).toContain("do NOT push 'main'");
    expect(out.error).toContain("issue branch 'ai/issue-123'");
    expect(out.error).not.toContain("Push 'main'");

    // The task is left untouched — still a human handoff, request unresolved.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(await getOutbox()).toHaveLength(0);
  });

  test('manual-done requeues when the base is clean and in sync with origin', async () => {
    // Clean worktree AND base level with origin: the operator pushed the change, so
    // the requeued run resumes from the pushed issue branch. The ahead-of-origin
    // guard must not false-positive here.
    writeSession();
    initRepo({ withRemote: true });
    // Issue #379: a usable continuation point must exist — land + push the side
    // effects on the issue branch so the requeue has a pushed resume point.
    execFileSync('git', ['checkout', '-q', '-b', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    execFileSync('git', ['commit', '-q', '-am', 'land tool request change'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['push', '-q', 'origin', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', status: 'queued', requeued: true });
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });

  test('reject is not blocked by a local base branch ahead of origin', async () => {
    // reject never requeues, so the base-contamination concern does not apply.
    writeSession();
    initRepo({ baseAhead: true });
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'reject', '--message', 'No.', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'reject', requeued: false });
  });

  test('reject is not blocked by a dirty session checkout', async () => {
    // reject never requeues, so the implementation dirty-preflight concern does
    // not apply — a dirty tree must not stop the operator recording the decision.
    writeSession();
    initRepo({ dirty: true });
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'reject', '--message', 'No.', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'reject', requeued: false });
  });

  test('--dry-run does not mutate the task', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--dry-run', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, dryRun: true });
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(await getOutbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Worktree-enabled sessions (issue #454)
//
// When `session.worktrees.enabled` is true the implementation phase ran in the
// per-issue worktree and left `ai/issue-<n>` checked out THERE, and a Tool
// Request handoff (grant or manual run) left the command's side effects in that
// worktree — never in the canonical checkout. The requeued implementation run's
// dirty preflight runs in that same worktree, so `manual-done` must validate
// cleanliness against the issue worktree, not the canonical checkout: probing
// only `session.repoRoot` would pass a dirty issue worktree and requeue straight
// into a worktree-dirty preflight failure (resolved request, stuck task), and
// would also wrongly refuse when only unrelated canonical dirt exists.
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request resolve: worktree-enabled sessions', () => {
  // Deterministic per-issue worktree layout: <root>/<session>/issue-<n>/repo.
  function worktreeRoot() {
    return join(tmpDir, 'wt');
  }
  function issueWorktreePath(issueNumber) {
    return join(worktreeRoot(), 'addon-dev', `issue-${issueNumber}`, 'repo');
  }
  // Register the per-issue worktree against the canonical checkout, with
  // `ai/issue-<n>` checked out THERE and a committed change standing in for the
  // partial work a Tool Request handoff lands on the issue branch.
  function addIssueWorktree(issueNumber) {
    const wtPath = issueWorktreePath(issueNumber);
    mkdirSync(join(worktreeRoot(), 'addon-dev', `issue-${issueNumber}`), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', `ai/issue-${issueNumber}`, wtPath, 'main'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const wgit = (...a) => execFileSync('git', a, { cwd: wtPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(join(wtPath, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    wgit('commit', '-q', '-am', 'land tool request change');
    return wtPath;
  }

  test('manual-done requeues when the issue worktree is clean even if the canonical checkout is dirty', async () => {
    writeSession({ worktrees: { enabled: true, root: worktreeRoot() } });
    // Canonical checkout carries unrelated dirt; the issue worktree is clean.
    initRepo({ dirty: true });
    const wtPath = addIssueWorktree(123);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()).not.toBe('');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf8' }).trim()).toBe('');

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', status: 'queued', requeued: true });
    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.context.toolRequest.resolved).toBe(true);
    // No origin configured: the local issue branch in the worktree is a sufficient
    // resume point, so the requeued run continues from the landed side effects.
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });

  test('manual-done refuses when the issue worktree is dirty', async () => {
    writeSession({ worktrees: { enabled: true, root: worktreeRoot() } });
    initRepo({ dirty: false });
    const wtPath = addIssueWorktree(123);
    // Leave the requested command's output uncommitted in the issue worktree.
    writeFileSync(join(wtPath, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0","right-pad":"^1.0.0"}}\n', 'utf8');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain('dirty');
    // The refusal names the issue worktree (not the canonical checkout) as dirty.
    expect(out.error).toContain('issue worktree');
    expect(out.error).toContain(wtPath);

    // The task is left untouched — still a human handoff, request unresolved.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(await getOutbox()).toHaveLength(0);
  });

  test('manual-done requeues from the issue worktree even when the canonical base is ahead of origin', async () => {
    // Issue #455 review: the requeued implementation runs in the per-issue worktree
    // and starts from origin/<base> or the recorded resume branch — it never branches
    // off the canonical checkout's local base. So an unrelated local commit on the
    // canonical `main` cannot leak into the issue branch, and the base-ahead guard
    // (which compares the shared `origin/main..main`) must be skipped in worktree mode
    // rather than refuse an otherwise-valid requeue.
    writeSession({ worktrees: { enabled: true, root: worktreeRoot() } });
    initRepo({ withRemote: true });
    const wtPath = addIssueWorktree(123);
    // Push the issue branch so the resume-branch confirmation finds it on origin.
    execFileSync('git', ['push', '-q', 'origin', 'ai/issue-123'], { cwd: wtPath, encoding: 'utf8' });
    // An unrelated, unpushed commit advances the canonical `main` past origin/main.
    writeFileSync(join(repoRoot, 'README.md'), 'unrelated local change\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['commit', '-q', '-m', 'unrelated local main commit'], { cwd: repoRoot, encoding: 'utf8' });
    expect(execFileSync('git', ['rev-list', '--count', 'origin/main..main'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('1');
    // The issue worktree itself is clean.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf8' }).trim()).toBe('');

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', status: 'queued', requeued: true });
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(true);
    // Resumes from the pushed issue branch, unaffected by the canonical base commit.
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });

  test('manual-done refuses with no usable continuation when worktrees are enabled but the issue branch is absent everywhere', async () => {
    // Regression (issue #379) in worktree mode: with no per-issue worktree registered
    // and no issue branch locally or on origin, requeueing would branch a fresh
    // implementation run from the base with none of the prior work. The fail-closed
    // guard must fire even when worktrees are enabled, not only in shared-checkout mode.
    writeSession({ worktrees: { enabled: true, root: worktreeRoot() } });
    initRepo({ withRemote: true });
    // No addIssueWorktree — no worktree registered, no issue branch created anywhere.

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'manual-done', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain('no usable continuation point');
    expect(out.error).toContain("issue branch 'ai/issue-123'");
    // Fail closed: request left unresolved, task untouched, nothing emitted.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestResumeBranch).toBeUndefined();
    expect(await getOutbox()).toHaveLength(0);
  });

  test('reject is not blocked by a dirty issue worktree', async () => {
    // reject never requeues, so the implementation dirty-preflight concern does not
    // apply — a dirty issue worktree must not stop the operator recording the decision.
    writeSession({ worktrees: { enabled: true, root: worktreeRoot() } });
    initRepo({ dirty: false });
    const wtPath = addIssueWorktree(123);
    // Leave the requested command's output uncommitted in the issue worktree.
    writeFileSync(join(wtPath, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0","right-pad":"^1.0.0"}}\n', 'utf8');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf8' }).trim()).not.toBe('');

    await seedToolRequestTask(123);
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--issue-number', '123', '--action', 'reject', '--message', 'No.', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'reject', requeued: false });
  });
});
