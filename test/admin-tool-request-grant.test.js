import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore, RepoLockStore } from '../dist/index.js';

// Issue #301 — `admin tool-request grant`: scoped, one-shot, handler-owned
// execution of an exact approved command for a Tool Request handoff.

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;
let lockDir;

function run(...args) {
  // Keep the repo lock hermetic to the test's tmp dir (the grant takes the lock
  // around its preflight + execution; the default lock dir is global state).
  if (args[0] === 'tool-request' && args[1] === 'grant' && !args.includes('--lock-dir')) {
    args = [...args, '--lock-dir', lockDir];
  }
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

// Seed a task in the shape the implementation handler's tool_request handoff
// leaves it. `command` is the exact requested command; the granted command must
// equal it (exact-command only).
async function seedToolRequestTask(issueNumber, { command = 'true', branch, dependencyBase, ...extra } = {}) {
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
        // A recorded PR head branch (issue #316): the granted command must run here.
        ...(branch !== undefined ? { branch } : {}),
        // Dependency start point (issue #316 review): when set, a freshly created
        // issue branch must be built on the blocker PR head, not the base branch.
        ...(dependencyBase !== undefined ? { dependencyBase } : {}),
        toolRequest: {
          command,
          displayCommand: command,
          reason: 'Needs the approved command.',
          expectedFiles: ['package.json'],
          necessity: 'required',
          suggestedAction: 'grant-permission',
          requestedBy: 'claude',
          mode: 'new',
          requestedAt: '2026-06-07T00:00:00.000Z',
          resolved: false,
          ...extra,
        },
      },
    },
  );
  store.close();
}

// A real git checkout at repoRoot so the clean-worktree preflight can probe it.
// With withRemote: true an `origin` is wired up and `main` pushed so the
// local-base-ahead probe (`git rev-list origin/main..main`) has a tracking ref.
function initRepo({ dirty, withRemote, gitignoreArtifacts = true } = {}) {
  mkdirSync(repoRoot, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"x"}\n', 'utf8');
  // The artifact root is gitignored in the conventional setup. Some tests exercise
  // the NOT-gitignored case (issue #458): a grant artifact written there is then
  // untracked working-tree dirt that must be probed/cleaned from the canonical
  // checkout so it does not dirty-block the requeued implementation preflight. Keep
  // a committed `.gitignore` either way so the post-init tree is clean.
  writeFileSync(join(repoRoot, '.gitignore'), gitignoreArtifacts ? '.n8n-artifacts/\n' : 'node_modules/\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('branch', '-M', 'main');
  if (withRemote) {
    const remotePath = join(tmpDir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', remotePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('remote', 'add', 'origin', remotePath);
    git('push', '-q', '-u', 'origin', 'main');
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
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-trg-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
  lockDir = join(tmpDir, 'locks');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discoverability
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: discoverability', () => {
  test('appears in "help" listing', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tool-request grant');
  });

  test('"help tool-request grant" shows its options', () => {
    const r = run('help', 'tool-request grant');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--command');
    expect(r.stdout).toContain('--ttl-seconds');
    expect(r.stdout).toContain('--max-uses');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: validation', () => {
  test('missing --session-id exits non-zero', () => {
    const r = run('tool-request', 'grant', '--issue-number', '1');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('missing --issue-number exits non-zero', () => {
    writeSession();
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('errors when there is no tool request to grant', async () => {
    writeSession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 7, phase: 'implementation' });
    store.close();
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '7', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no Tool Request') });
  });

  test('refuses an already-resolved request', async () => {
    writeSession();
    await seedToolRequestTask(123, { resolved: true, resolution: { action: 'reject', resolvedAt: '2026-06-07T01:00:00.000Z' } });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('already resolved') });
  });

  test('rejects a --command that differs from the requested command (exact-command only)', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--command', 'true --force', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('exact-command only') });
    // Untouched: no execution, no resolution.
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(await getOutbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Clean worktree requirement
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: clean worktree', () => {
  test('refuses to execute when the session checkout is dirty', async () => {
    writeSession();
    initRepo({ dirty: true });
    await seedToolRequestTask(123, { command: 'true' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('dirty') });
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant).toBeUndefined();
    expect(await getOutbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: dry-run', () => {
  test('previews the grant without executing or mutating anything', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--dry-run', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, dryRun: true, action: 'grant', wouldExecute: true });
    expect(out.grant).toMatchObject({ phase: 'implementation', maxUses: 1 });
    expect(out.grant.commandHash).toEqual(expect.any(String));

    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant).toBeUndefined();
    expect(await getOutbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Execution: success
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: execution success', () => {
  test('executes the exact command once, resolves the request, and re-queues', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      exitCode: 0,
      success: true,
      status: 'queued',
      phase: 'implementation',
      requeued: true,
    });

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(task.context.toolRequest.resolution.action).toBe('grant');
    // The grant is recorded and consumed (one-shot).
    expect(task.context.toolRequestGrant.uses).toBe(1);
    expect(task.context.toolRequestGrant.maxUses).toBe(1);
    expect(task.context.toolRequestGrant.lastResult.exitCode).toBe(0);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('granted and executed');
    // Public comment must not leak the local repo path.
    expect(comment.payload.body).not.toContain(repoRoot);
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    const removed = outbox.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removed).toContain('ai:ready-for-human');
    expect(added).toContain('status:needs-implementation');
    expect(added).toContain('agent:claude');
  });

  test('captures stderr in the local artifact even when the command exits 0', async () => {
    // The grant contract records stdout/stderr/exit code for the exact command
    // regardless of outcome. A command can succeed (exit 0) while writing
    // diagnostics to stderr; execFileSync would drop that stderr, so the handler
    // must use a runner that captures both streams.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo to-out; echo diag-on-stderr >&2' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, exitCode: 0, success: true });

    const runsDir = join(repoRoot, '.n8n-artifacts', 'runs');
    const runDirs = readdirSync(runsDir).filter(d => d.startsWith('admin-tool-request-grant-'));
    expect(runDirs.length).toBe(1);
    const artifact = JSON.parse(readFileSync(join(runsDir, runDirs[0], 'tool-request-grant.json'), 'utf8'));
    expect(artifact.exitCode).toBe(0);
    expect(artifact.success).toBe(true);
    expect(artifact.stdout).toContain('to-out');
    expect(artifact.stderr).toContain('diag-on-stderr');
  });

  test('a command that modifies the worktree is executed but not auto-requeued', async () => {
    // The primary case (e.g. an install rewriting a manifest) leaves the tree
    // dirty. Re-queueing would dead-end on the implementation dirty preflight, so
    // the grant runs the command but hands back to the operator to commit + push
    // and then resolve manual-done.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'touch generated.txt' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      exitCode: 0,
      success: true,
      requeued: false,
      dirtyAfter: true,
      status: 'ready_for_human',
    });

    const task = await getTask(123);
    // Request stays open (operator finishes via manual-done); grant recorded.
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);

    // Issue #316: the command ran on the issue branch (not main), and its dirty
    // changes are left there for the operator to commit/push.
    const headBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    expect(headBranch).toBe('ai/issue-123');
    expect(existsSync(join(repoRoot, 'generated.txt'))).toBe(true);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('modified the working tree');
    // The path forward names the issue branch, never the base branch.
    expect(comment.payload.body).toContain('ai/issue-123');
    expect(comment.payload.body).not.toMatch(/push `?main`?/i);
    // Not re-queued: no implementation-lane labels added.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).not.toContain('status:needs-implementation');
  });

  test('a command that commits lands the commit on the issue branch, not the base (issue #316)', async () => {
    // A command that commits (e.g. `git commit --allow-empty`) now runs on the
    // issue branch, so the commit lands on `ai/issue-123` and the base branch
    // `main` is left untouched. The change is on the issue branch, so the grant is
    // not auto-requeued: the operator commits/pushes the issue branch then resolves
    // manual-done.
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, { command: 'git commit --allow-empty -q -m work-on-branch' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      exitCode: 0,
      success: true,
      requeued: false,
      dirtyAfter: false,
      committedOnBranch: true,
      branch: 'ai/issue-123',
      status: 'ready_for_human',
    });

    // The commit landed on the issue branch; the base branch did not move.
    const branchCommits = execFileSync('git', ['rev-list', '--count', 'main..ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    expect(branchCommits).toBe('1');
    const baseAhead = execFileSync('git', ['rev-list', '--count', 'origin/main..main'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    expect(baseAhead).toBe('0');

    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('issue branch');
    expect(comment.payload.body).toContain('ai/issue-123');
    expect(comment.payload.body).not.toContain(repoRoot);
    // Recovery never points at the base branch.
    expect(comment.payload.body).not.toMatch(/push `?main`?/i);
    // Not re-queued: no implementation-lane labels added.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).not.toContain('status:needs-implementation');
  });

  test('a command that checks out the base and commits there triggers the base-ahead handoff, not the issue-branch path (issue #316 review)', async () => {
    // Defense-in-depth: the command runs on the issue branch, but it can still
    // `git checkout main && git commit ...` to advance the local base past origin.
    // That moves HEAD, so the naive "changes on issue branch" path would fire and
    // release the repo lock with the base contaminated. The base-ahead handoff must
    // take priority: fail closed, do not re-queue, and tell the operator to move/drop
    // the base commit — never to push the base branch.
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, {
      command: 'git checkout -q main && git commit --allow-empty -q -m base-contamination',
    });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      exitCode: 0,
      success: true,
      requeued: false,
      baseAheadAfter: 1,
      branch: 'ai/issue-123',
      status: 'ready_for_human',
    });

    const task = await getTask(123);
    // Request stays open (operator must resolve the contaminated base) and is NOT
    // re-queued, so a later issue run never branches off the dirty base.
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('ahead of origin');
    expect(comment.payload.body).toContain('ai/issue-123');
    // Recovery moves/drops the base commit and explicitly warns against pushing it.
    expect(comment.payload.body).toMatch(/move the commit/i);
    expect(comment.payload.body).toMatch(/do NOT push `?main`?/i);
    // Not re-queued: no implementation-lane labels added.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).not.toContain('status:needs-implementation');
  });

  test('a command that checks out the base and leaves uncommitted edits fails closed, not labeled as issue-branch work (issue #316 review)', async () => {
    // Defense-in-depth (2): the command runs on the issue branch, but it can
    // `git checkout main` and leave UNCOMMITTED edits there. That dirties the tree
    // without advancing the base (no commit), so `baseAheadCountAfter` stays 0 and the
    // naive "changes on issue branch" path would mislabel base contamination as issue
    // work and release the repo lock with the base dirty. Verifying HEAD must fail it
    // closed: keep the request open, do not re-queue, and tell the operator to move/drop
    // the changes — never to push the base branch.
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, {
      command: 'git checkout -q main && touch base-contamination.txt',
    });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      exitCode: 0,
      success: true,
      requeued: false,
      branch: 'ai/issue-123',
      status: 'ready_for_human',
    });

    const task = await getTask(123);
    // Request stays open (operator must move/drop the off-branch changes) and is NOT
    // re-queued, so a later issue run never branches off a dirty base.
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    // Recovery names the issue branch and explicitly warns against pushing the base.
    expect(comment.payload.body).toContain('not the issue branch');
    expect(comment.payload.body).toContain('ai/issue-123');
    expect(comment.payload.body).toMatch(/do NOT push `?main`?/i);
    // Not re-queued: no implementation-lane labels added.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).not.toContain('status:needs-implementation');
  });

  test('a second grant after a successful one is refused (cannot be reused)', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    expect(run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath).code).toBe(0);

    const second = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(second.code).not.toBe(0);
    expect(parse(second)).toMatchObject({ ok: false, error: expect.stringContaining('already resolved') });
  });
});

// ---------------------------------------------------------------------------
// Guided repository-change handling (issue #419)
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: guided change handling (issue #419)', () => {
  const grant = (...extra) =>
    run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath, ...extra);

  const headBranch = () => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const porcelain = () => execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const branchCommits = (branch) => execFileSync('git', ['rev-list', '--count', `main..${branch}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const remoteHasBranch = (branch) => {
    try {
      execFileSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  };

  test('rejects an unknown --on-changes action (unknown flag fails fast)', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    const r = grant('--on-changes', 'push');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--on-changes') });
  });

  test('rejects --confirm-discard without --on-changes discard', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    const r = grant('--on-changes', 'commit', '--confirm-discard');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--confirm-discard') });
  });

  test('rejects --allow-unexpected without --on-changes commit', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    const r = grant('--on-changes', 'keep', '--allow-unexpected');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--allow-unexpected') });
  });

  test('commit: stages the expected file, commits to the issue branch, and pushes', async () => {
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });
    const r = grant('--on-changes', 'commit');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      success: true,
      requeued: false,
      changeAction: 'commit',
      changeOutcome: 'committed',
      pushed: true,
      branch: 'ai/issue-123',
      status: 'ready_for_human',
    });

    // The change is committed on the issue branch and pushed; the tree is clean.
    expect(headBranch()).toBe('ai/issue-123');
    expect(porcelain()).toBe('');
    expect(branchCommits('ai/issue-123')).toBe('1');
    expect(remoteHasBranch('ai/issue-123')).toBe(true);

    const task = await getTask(123);
    expect(task.context.toolRequestGrant.uses).toBe(1);
    // The chosen disposition is recorded durably in task context (issue #419).
    expect(task.context.toolRequestChangeAction).toMatchObject({ action: 'commit', outcome: 'committed' });

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('committed');
    // Public comment is path-free: counts only.
    expect(comment.payload.body).not.toContain(repoRoot);
  });

  test('commit: never commits an artifact file the granted command pre-staged', async () => {
    // The granted command modifies an expected file AND force-stages an ignored
    // artifact (`git add -f .n8n-artifacts/run.json`). The commit must include the
    // expected change but never the pre-staged artifact: the index is reset before
    // staging only the classified files (review feedback for issue #419).
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, {
      command:
        'mkdir -p .n8n-artifacts && echo run > .n8n-artifacts/run.json && git add -f .n8n-artifacts/run.json && echo updated >> package.json',
    });
    const r = grant('--on-changes', 'commit');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, changeOutcome: 'committed', pushed: true });

    // Exactly one commit, and the artifact is absent from the committed tree.
    expect(branchCommits('ai/issue-123')).toBe('1');
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    expect(tracked).toContain('package.json');
    expect(tracked).not.toContain('.n8n-artifacts/run.json');
    // The ignored artifact stays on disk (untracked/unstaged) for recovery; the
    // tree reports nothing dirty because the path is gitignored.
    expect(existsSync(join(repoRoot, '.n8n-artifacts', 'run.json'))).toBe(true);
    expect(porcelain()).toBe('');
  });

  test('commit: surfaces unexpected files and refuses without --allow-unexpected', async () => {
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, { command: 'echo updated >> package.json && echo extra > unexpected.ts' });
    const r = grant('--on-changes', 'commit');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeOutcome: 'refused',
      refusalCode: 'unexpected-files',
      status: 'ready_for_human',
    });

    // Nothing committed: the produced changes are left in the worktree.
    expect(branchCommits('ai/issue-123')).toBe('0');
    expect(existsSync(join(repoRoot, 'unexpected.ts'))).toBe(true);

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);
  });

  test('commit: --allow-unexpected includes the unexpected file in the commit', async () => {
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, { command: 'echo updated >> package.json && echo extra > unexpected.ts' });
    const r = grant('--on-changes', 'commit', '--allow-unexpected');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, changeOutcome: 'committed', pushed: true });
    expect(porcelain()).toBe('');
    expect(branchCommits('ai/issue-123')).toBe('1');
    // Both files are in the commit (none left dirty/untracked).
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    expect(tracked).toContain('unexpected.ts');
  });

  test('commit: a push failure keeps the local commit for recovery', async () => {
    // No remote configured, so `git push origin ai/issue-123` fails.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });
    const r = grant('--on-changes', 'commit');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeAction: 'commit',
      changeOutcome: 'committed-push-failed',
      pushed: false,
      status: 'ready_for_human',
    });

    // The commit is preserved locally on the issue branch (recoverable).
    expect(branchCommits('ai/issue-123')).toBe('1');
    expect(porcelain()).toBe('');
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toMatch(/push/i);
  });

  test('keep: leaves the changes on the issue branch and records the action', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });
    const r = grant('--on-changes', 'keep');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeAction: 'keep',
      changeOutcome: 'kept',
      status: 'ready_for_human',
    });

    // The change is kept (uncommitted) on the issue branch; request stays open.
    expect(headBranch()).toBe('ai/issue-123');
    expect(porcelain()).not.toBe('');
    expect(branchCommits('ai/issue-123')).toBe('0');
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);
  });

  test('discard: refuses without --confirm-discard, leaving changes in place', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });
    const r = grant('--on-changes', 'discard');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeOutcome: 'refused',
      refusalCode: 'needs-confirmation',
    });
    // The change is untouched (not discarded) until confirmed.
    expect(porcelain()).not.toBe('');
  });

  test('discard: with --confirm-discard drops the changes and leaves a clean tree', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });
    const r = grant('--on-changes', 'discard', '--confirm-discard');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeAction: 'discard',
      changeOutcome: 'discarded',
      status: 'ready_for_human',
    });

    // The worktree is clean again and the file reverted to its committed content.
    expect(porcelain()).toBe('');
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');
    const task = await getTask(123);
    expect(task.context.toolRequestGrant.uses).toBe(1);
  });

  test('discard: removes untracked generated files too', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo generated > generated.txt' });
    const r = grant('--on-changes', 'discard', '--confirm-discard');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, changeOutcome: 'discarded' });
    expect(existsSync(join(repoRoot, 'generated.txt'))).toBe(false);
    expect(porcelain()).toBe('');
  });

  test('discard: preserves a staged artifact the granted command force-added', async () => {
    // The granted command modifies an expected file AND force-stages an ignored
    // artifact (`git add -f .n8n-artifacts/run.json`). Discard must drop the
    // expected change but never delete the artifact — a bare `git reset --hard`
    // would remove the staged artifact before `git clean -e` could protect it
    // (review feedback for issue #419: artifacts are local audit records).
    writeSession();
    initRepo();
    await seedToolRequestTask(123, {
      command:
        'mkdir -p .n8n-artifacts && echo run > .n8n-artifacts/run.json && git add -f .n8n-artifacts/run.json && echo updated >> package.json',
    });
    const r = grant('--on-changes', 'discard', '--confirm-discard');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, changeOutcome: 'discarded' });

    // The expected change is dropped (package.json reverted) and the tree is clean...
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');
    expect(porcelain()).toBe('');
    // ...but the force-staged artifact survives on disk as a local audit record.
    expect(existsSync(join(repoRoot, '.n8n-artifacts', 'run.json'))).toBe(true);
  });

  test('discard: disposition-only retry applies after a correctable refusal', async () => {
    // A discard refused for missing --confirm-discard is correctable: the command
    // already ran and left the changes on disk. Re-running the grant with
    // --confirm-discard must apply the disposition WITHOUT re-executing the
    // command (one-shot preserved) instead of dead-ending on the exhausted-grant
    // or dirty-tree guards (review feedback for issue #419).
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });

    const refused = grant('--on-changes', 'discard');
    expect(refused.code).toBe(0);
    expect(parse(refused)).toMatchObject({ changeOutcome: 'refused', refusalCode: 'needs-confirmation' });
    expect(porcelain()).not.toBe('');

    const retried = grant('--on-changes', 'discard', '--confirm-discard');
    expect(retried.code).toBe(0);
    expect(parse(retried)).toMatchObject({ ok: true, changeAction: 'discard', changeOutcome: 'discarded' });

    // The changes are gone and the grant was NOT consumed a second time (the
    // command never re-ran): uses stays at 1.
    expect(porcelain()).toBe('');
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');
    const task = await getTask(123);
    expect(task.context.toolRequestGrant.uses).toBe(1);
  });

  test('commit: disposition-only retry commits after an unexpected-files refusal', async () => {
    // A commit refused for unexpected files is correctable via --allow-unexpected.
    // The retry must commit the existing changes without re-running the command.
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, { command: 'echo updated >> package.json && echo extra > unexpected.ts' });

    const refused = grant('--on-changes', 'commit');
    expect(refused.code).toBe(0);
    expect(parse(refused)).toMatchObject({ changeOutcome: 'refused', refusalCode: 'unexpected-files' });
    expect(branchCommits('ai/issue-123')).toBe('0');

    const retried = grant('--on-changes', 'commit', '--allow-unexpected');
    expect(retried.code).toBe(0);
    expect(parse(retried)).toMatchObject({ ok: true, changeOutcome: 'committed', pushed: true });

    expect(porcelain()).toBe('');
    expect(branchCommits('ai/issue-123')).toBe('1');
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    expect(tracked).toContain('unexpected.ts');
    const task = await getTask(123);
    expect(task.context.toolRequestGrant.uses).toBe(1);
  });

  test('a non-correctable refusal stays terminal: the grant cannot be reused', async () => {
    // A wrong-branch/base-branch refusal is NOT correctable by a flag, so the
    // one-shot grant must stay exhausted — re-running is refused, not retried.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });
    // keep is a terminal disposition (records 'kept', never 'refused'), so a
    // second grant is rejected as an already-issued one-shot grant.
    const first = grant('--on-changes', 'keep');
    expect(parse(first)).toMatchObject({ changeOutcome: 'kept' });
    const second = grant('--on-changes', 'discard', '--confirm-discard');
    expect(second.code).not.toBe(0);
    expect(parse(second)).toMatchObject({ ok: false, error: expect.stringContaining('one-shot') });
  });

  test('reject: closes the Tool Request and leaves the changes in place', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });
    const r = grant('--on-changes', 'reject');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeAction: 'reject',
      changeOutcome: 'rejected',
      status: 'ready_for_human',
    });

    // The request is resolved as reject; the changes are left for the operator.
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(task.context.toolRequest.resolution.action).toBe('reject');
    expect(porcelain()).not.toBe('');
  });

  test('abort: does nothing and leaves the changes untouched', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });
    const r = grant('--on-changes', 'abort');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeAction: 'abort',
      changeOutcome: 'aborted',
      status: 'ready_for_human',
    });
    expect(porcelain()).not.toBe('');
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Branch discipline (issue #316): side effects land on the issue branch, not main
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: branch discipline (issue #316)', () => {
  test('a granted command on a main checkout runs on a freshly created ai/issue-<n> branch', async () => {
    // No PR exists yet (initial-implementation case). The checkout is on main, but
    // the command must run on ai/issue-123, created from the base — never on main.
    writeSession();
    initRepo();
    // Sanity: the checkout starts on main and ai/issue-123 does not exist yet.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('main');
    await seedToolRequestTask(123, { command: 'touch from-grant.txt' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, dirtyAfter: true, branch: 'ai/issue-123' });

    // The dirty change is on the issue branch; main never saw it.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('ai/issue-123');
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(true);
  });

  test('dependency-start-point: a freshly created issue branch is built on the blocker PR head, not the base (issue #316 review)', async () => {
    // The Tool Request was raised during dependency-start-point implementation, which
    // deleted the temporary `ai/issue-123` branch at handoff and recorded the blocker
    // start point (`dependencyBase`). No PR exists for the dependent issue yet, so the
    // grant must rebuild `ai/issue-123` from the blocker PR head — NOT from `main`,
    // which would miss the blocker's changes.
    writeSession();
    initRepo({ withRemote: true });
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // The blocker PR head lives on origin with a distinguishing file; main lacks it.
    git('checkout', '-q', '-b', 'ai/issue-50');
    writeFileSync(join(repoRoot, 'blocker.txt'), 'lives on the blocker head\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'blocker work');
    git('push', '-q', '-u', 'origin', 'ai/issue-50');
    git('checkout', '-q', 'main');
    git('branch', '-q', '-D', 'ai/issue-50');
    // ai/issue-123 exists nowhere; main lacks the blocker file.
    expect(execFileSync('git', ['branch', '--list', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');
    expect(existsSync(join(repoRoot, 'blocker.txt'))).toBe(false);

    await seedToolRequestTask(123, {
      command: 'touch from-grant.txt',
      dependencyBase: { baseIssueNumber: 50, basePrNumber: 55, baseHeadRefName: 'ai/issue-50', basePrUrl: 'https://github.com/m2dw/some-repo/pull/55' },
    });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, dirtyAfter: true, branch: 'ai/issue-123' });

    // The branch was created from the blocker head (its file is present), so the
    // granted side effects land on top of the blocker — never on a base-derived branch.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('ai/issue-123');
    expect(existsSync(join(repoRoot, 'blocker.txt'))).toBe(true);
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(true);
  });

  test('dependency-start-point: fails closed (never creates from base) when the blocker head cannot be fetched (issue #316 review)', async () => {
    // dependencyBase names a blocker head that no longer exists on origin (e.g.
    // already merged/deleted). Rather than silently fall back to creating the issue
    // branch from `main` — which would miss the blocker's changes — the grant must
    // fail closed without running the command or creating the branch.
    writeSession();
    initRepo({ withRemote: true });
    expect(execFileSync('git', ['branch', '--list', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');

    await seedToolRequestTask(123, {
      command: 'touch from-grant.txt',
      dependencyBase: { baseIssueNumber: 50, basePrNumber: 55, baseHeadRefName: 'ai/issue-50', basePrUrl: 'https://github.com/m2dw/some-repo/pull/55' },
    });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    // The command never ran and no base-derived branch was created.
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(false);
    expect(execFileSync('git', ['branch', '--list', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('main');
  });

  test('a granted command runs on the recorded PR head branch when one exists', async () => {
    writeSession();
    initRepo();
    // An existing PR head branch for the issue, already present locally.
    execFileSync('git', ['checkout', '-q', '-b', 'pr-head-123'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    await seedToolRequestTask(123, { command: 'touch on-pr-branch.txt', branch: 'pr-head-123' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, dirtyAfter: true, branch: 'pr-head-123' });

    // The command ran on the PR head branch, not main or ai/issue-123.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('pr-head-123');
    expect(existsSync(join(repoRoot, 'on-pr-branch.txt'))).toBe(true);

    const comment = (await getOutbox()).find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('pr-head-123');
  });

  test('a stale local PR branch is fast-forwarded from origin before the grant runs', async () => {
    // Issue #316 review: another operator/worker may push updates to the open PR head
    // after this checkout's local branch was last synced. The grant must refresh the
    // local branch (ff-only) from origin before executing, so the command runs against
    // current files — not stale ones based on the wrong commit.
    writeSession();
    initRepo({ withRemote: true });
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // Publish a PR head branch, advance origin one commit, then rewind the LOCAL
    // branch so it sits one commit behind origin (the file from origin is missing
    // locally). Return to main so the grant starts from a clean, unrelated checkout.
    git('checkout', '-q', '-b', 'pr-head-123');
    git('push', '-q', '-u', 'origin', 'pr-head-123');
    writeFileSync(join(repoRoot, 'from-origin.txt'), 'pushed by another worker\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'origin advance');
    git('push', '-q', 'origin', 'pr-head-123');
    git('reset', '-q', '--hard', 'HEAD~1');
    git('checkout', '-q', 'main');
    // Local branch is now behind origin and lacks the pushed file.
    expect(existsSync(join(repoRoot, 'from-origin.txt'))).toBe(false);

    await seedToolRequestTask(123, { command: 'touch from-grant.txt', branch: 'pr-head-123' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, branch: 'pr-head-123' });

    // The branch was fast-forwarded (origin's file is present) AND the command ran on it.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('pr-head-123');
    expect(existsSync(join(repoRoot, 'from-origin.txt'))).toBe(true);
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(true);
  });

  test('a stale work branch already checked out is fast-forwarded from origin before the grant runs', async () => {
    // Issue #316 review: an operator may run the grant while already on the issue/PR
    // branch. If origin has advanced, the prior early return skipped the fast-forward
    // and ran the command against a stale branch. Reconcile with origin on this path
    // too, exactly as when the branch must be checked out.
    writeSession();
    initRepo({ withRemote: true });
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('checkout', '-q', '-b', 'pr-head-123');
    git('push', '-q', '-u', 'origin', 'pr-head-123');
    writeFileSync(join(repoRoot, 'from-origin.txt'), 'pushed by another worker\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'origin advance');
    git('push', '-q', 'origin', 'pr-head-123');
    git('reset', '-q', '--hard', 'HEAD~1');
    // Stay ON pr-head-123 (do not return to main): local is behind origin and lacks the file.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('pr-head-123');
    expect(existsSync(join(repoRoot, 'from-origin.txt'))).toBe(false);

    await seedToolRequestTask(123, { command: 'touch from-grant.txt', branch: 'pr-head-123' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, branch: 'pr-head-123' });

    // The already-checked-out branch was fast-forwarded (origin's file present) AND the command ran on it.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('pr-head-123');
    expect(existsSync(join(repoRoot, 'from-origin.txt'))).toBe(true);
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(true);
  });

  test('a recorded PR head branch present only on origin is fetched and used, not recreated from base', async () => {
    // Issue #316 review (P2): the PR head branch may be absent locally (fresh clone)
    // but live on origin. The grant must positively detect it on origin and fetch it,
    // running the command on the existing PR head — NOT fall through to creating a
    // base-derived branch that would miss the PR's current changes.
    writeSession();
    initRepo({ withRemote: true });
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // Build the PR head branch with a distinguishing file, push it, then delete the
    // LOCAL branch so it exists ONLY on origin. main does not have the file.
    git('checkout', '-q', '-b', 'pr-head-123');
    writeFileSync(join(repoRoot, 'pr-only.txt'), 'lives on the PR head\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'pr head work');
    git('push', '-q', '-u', 'origin', 'pr-head-123');
    git('checkout', '-q', 'main');
    git('branch', '-q', '-D', 'pr-head-123');
    // Branch is gone locally; the PR-only file is absent on main.
    expect(execFileSync('git', ['branch', '--list', 'pr-head-123'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');
    expect(existsSync(join(repoRoot, 'pr-only.txt'))).toBe(false);

    await seedToolRequestTask(123, { command: 'touch from-grant.txt', branch: 'pr-head-123' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, branch: 'pr-head-123' });

    // The command ran on the PR head fetched from origin (the PR-only file is present),
    // not on a base-derived branch.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('pr-head-123');
    expect(existsSync(join(repoRoot, 'pr-only.txt'))).toBe(true);
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(true);
  });

  test('a recorded PR head branch absent locally and on origin fails closed, never recreated from base (issue #316 review)', async () => {
    // Issue #316 review (P2): when workBranch is the task's recorded PR head and the
    // branch exists neither locally nor on origin (the head was deleted, lives in a
    // fork, or is otherwise unavailable under origin), the grant must NOT recreate it
    // from the base — that would run the command on a branch missing the PR's current
    // changes. Base-derived creation is only valid for the conventional no-PR
    // ai/issue-<n> case, so this must fail closed.
    writeSession();
    initRepo({ withRemote: true });
    // origin exists but has no 'pr-head-123' ref (it was never pushed / was deleted),
    // and there is no local 'pr-head-123' branch either.
    expect(execFileSync('git', ['branch', '--list', 'pr-head-123'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');

    await seedToolRequestTask(123, { command: 'touch from-grant.txt', branch: 'pr-head-123' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({
      ok: false,
      error: expect.stringContaining("recorded PR head branch 'pr-head-123' exists neither locally nor on origin"),
    });
    // The command never ran and no base-derived branch was created.
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(false);
    expect(execFileSync('git', ['branch', '--list', 'pr-head-123'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('main');
  });

  test('a recorded PR head present locally but absent on origin fails closed as stale, never run (issue #316 review)', async () => {
    // Issue #316 review (P2): when workBranch is the task's recorded PR head and the
    // branch exists LOCALLY but origin positively lacks it (the head was deleted or is
    // otherwise unavailable), the local copy is stale — it is no longer the PR head.
    // Running the grant on it would apply Tool Request side effects to a branch that is
    // no longer the PR head, bypassing the absent-everywhere fail-closed check just
    // because a local ref survives. The grant must refuse instead.
    writeSession();
    initRepo({ withRemote: true });
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // The recorded PR head exists locally but was never pushed to (reachable) origin.
    git('checkout', '-q', '-b', 'pr-head-123');
    git('checkout', '-q', 'main');
    // origin is configured and reachable, and has no pr-head-123 ref.
    expect(execFileSync('git', ['ls-remote', '--heads', 'origin', 'pr-head-123'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');

    await seedToolRequestTask(123, { command: 'touch from-grant.txt', branch: 'pr-head-123' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({
      ok: false,
      error: expect.stringContaining("recorded PR head branch 'pr-head-123' exists locally but not on origin"),
    });
    // The command never ran.
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(false);
  });

  test('fails closed when the origin lookup for an existing local branch is inconclusive', async () => {
    // Issue #316 review (P2): for an existing local work branch, a transient
    // ls-remote failure must NOT be collapsed to "origin lacks this branch" and
    // skip the fast-forward — that could run the approved command on a stale PR
    // branch. With origin configured but unreachable, ls-remote exits non-2
    // ("unknown"), so the grant must refuse rather than run on possibly-stale state.
    writeSession();
    initRepo();
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // A local PR head branch exists, and origin is configured but points nowhere.
    git('checkout', '-q', '-b', 'pr-head-123');
    git('checkout', '-q', 'main');
    git('remote', 'add', 'origin', join(tmpDir, 'does-not-exist.git'));

    await seedToolRequestTask(123, { command: 'touch from-grant.txt', branch: 'pr-head-123' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining("could not determine whether origin has 'pr-head-123'") });
    // The command never ran: no produced file.
    expect(existsSync(join(repoRoot, 'from-grant.txt'))).toBe(false);
  });

  test('a clean no-op grant requeues and leaves no stray issue branch behind', async () => {
    // `true` produces nothing. The command still runs on ai/issue-123, but because
    // nothing was produced the run tidies up the freshly created branch and requeues
    // so the next implementation run branches cleanly from main.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, requeued: true, branch: 'ai/issue-123' });

    // Back on main with no leftover empty branch.
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('main');
    const branches = execFileSync('git', ['branch', '--list', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    expect(branches).toBe('');
    // No resume branch recorded: the requeued run branches fresh from main.
    const task = await getTask(123);
    expect(task.context.toolRequestResumeBranch).toBeUndefined();
  });

  test('a clean no-op grant on an arbitrary pre-existing local branch does NOT record it as a resume point', async () => {
    // The issue branch already exists ONLY locally (never pushed, not a PR head) —
    // most likely a stale leftover from a prior failed run. A no-op grant produced
    // nothing, so adopting that branch as the requeue resume point would silently
    // fold its leftover contents into the next PR. The grant must leave the resume
    // branch unset so the implementation run's new-branch preflight collides and
    // fails loudly on the unexpected leftover instead of trusting it (issue #316
    // review). The branch is not deleted (the grant did not invent it).
    writeSession();
    initRepo();
    execFileSync('git', ['branch', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' });
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, requeued: true, branch: 'ai/issue-123' });

    // Back on main; the pre-existing branch survives (the grant did not invent it).
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('main');
    const branches = execFileSync('git', ['branch', '--list', 'ai/issue-123'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    expect(branches).toContain('ai/issue-123');
    // No resume branch recorded: a stale local-only branch is not a known resume
    // point, so the requeued run is left to fail loudly on the leftover.
    const task = await getTask(123);
    expect(task.context.toolRequestResumeBranch).toBeUndefined();
  });

  test('a clean no-op grant on a pushed issue branch records it as a resume point', async () => {
    // The issue branch exists on origin (a known, pushed branch / PR head). Its
    // contents are intentional, so a no-op grant safely hands the requeued
    // implementation run a resume point rather than failing loudly (issue #316).
    writeSession();
    initRepo({ withRemote: true });
    const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    git('checkout', '-q', '-b', 'ai/issue-123');
    git('push', '-q', '-u', 'origin', 'ai/issue-123');
    git('checkout', '-q', 'main');
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, requeued: true, branch: 'ai/issue-123' });

    // The pushed branch is a known resume point, so it is recorded.
    const task = await getTask(123);
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });
});

// ---------------------------------------------------------------------------
// Execution: failure
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: execution failure', () => {
  test('a non-zero exit that leaves the tree clean requeues automatically with the failure delivered to the agent (issue #678)', async () => {
    // A failing verification command (e.g. `npm test`) that changes no files is
    // the motivating case for issue #678: the exit code and captured output are
    // diagnostic information for the agent, not by themselves a reason to stop at
    // a human handoff. `false` fails without touching the tree, so nothing is at
    // risk — the failure is folded into the resolution and the task requeues
    // exactly like a true no-op.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'false' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      success: false,
      requeued: true,
      status: 'queued',
      phase: 'implementation',
    });
    expect(out.exitCode).not.toBe(0);

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequest.resolved).toBe(true);
    const resolution = task.context.toolRequest.resolution;
    expect(resolution.action).toBe('grant');
    expect(resolution.disposition).toBe('failed');
    // The captured failure output is the deliverable folded into the next prompt.
    expect(resolution.capturedResult.exitCode).not.toBe(0);
    // The consumed grant is still recorded so the exact command cannot be re-run.
    expect(task.context.toolRequestGrant.uses).toBe(1);
    expect(task.context.toolRequestGrant.lastResult.exitCode).not.toBe(0);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('failed');
    expect(comment.payload.body).toContain('returned to the agent');
    expect(comment.payload.body).not.toContain(repoRoot);
    // Re-queued to the implementation lane, same as a successful guided run.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).toContain('status:needs-implementation');
  });

  test('a non-zero exit that leaves changes behind stays a human handoff, does not requeue, and does not loop', async () => {
    // When the failing command leaves repository state behind, auto-requeueing
    // would immediately fail the implementation preflight's dirty-tree check —
    // repository state cannot be preserved safely (issue #678), so this case is
    // unchanged from before: a human handoff, not resolved, so an operator can act.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'sh -c "echo dirty > leftover.txt; exit 1"' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      success: false,
      requeued: false,
      status: 'ready_for_human',
    });
    expect(out.exitCode).not.toBe(0);

    const task = await getTask(123);
    // Still a human handoff; request stays unresolved so an operator can act.
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    // The failed grant is recorded and consumed.
    expect(task.context.toolRequestGrant.uses).toBe(1);
    expect(task.context.toolRequestGrant.lastResult.exitCode).not.toBe(0);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('failed');
    expect(comment.payload.body).not.toContain(repoRoot);
    // No re-queue to the implementation lane on failure.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).not.toContain('status:needs-implementation');
  });

  test('a failing command that pushes a base-branch mutation to origin stays a human handoff, not an auto-requeue (issue #678 review)', async () => {
    // Defense-in-depth: a failing command can check out the base, commit, and
    // *push* that commit to origin before returning to the issue branch and
    // exiting non-zero. That leaves the tree clean, HEAD back on the issue
    // branch, and `origin/<base>..<base>` at 0 (origin now matches the mutated
    // base) — the ahead-count probe alone would misread this as safe and
    // auto-requeue implementation from the contaminated base. The base-SHA
    // snapshot taken before the command ran must catch this instead.
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, {
      command:
        'sh -c "git checkout -q main && git commit --allow-empty -q -m base-contamination && ' +
        'git push -q origin main && git checkout -q ai/issue-123; exit 1"',
    });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      success: false,
      requeued: false,
      baseAheadAfter: 0,
      baseMovedAfter: true,
      branch: 'ai/issue-123',
      status: 'ready_for_human',
    });

    const task = await getTask(123);
    // Request stays open (operator must resolve the contaminated base) and is
    // NOT re-queued, so a later issue run never branches off the pushed commit.
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('ai/issue-123');
    expect(comment.payload.body).toMatch(/move the commit/i);
    expect(comment.payload.body).toMatch(/do NOT push .*`?main`?/i);
    // Not re-queued: no implementation-lane labels added.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).not.toContain('status:needs-implementation');
  });

  test('a failing command that pushes directly to the remote base via a refspec (without moving local base) stays a human handoff (issue #678 review)', async () => {
    // Defense-in-depth (2): a failing command can move the *remote* base directly
    // via a refspec push (e.g. `git push origin <sha>:main`) without ever
    // checking out or moving the *local* base branch. That leaves the local base
    // SHA unchanged (the local-base-moved check above misses it) and
    // `origin/<base>..<base>` at 0 for the same reason an ordinary base push is
    // missed — Git updates the local `origin/<base>` tracking ref to the new
    // remote tip as a side effect of a successful push, even a refspec-only one
    // that never touches the local branch. Only comparing `origin/<base>` itself
    // before/after the command catches this.
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, {
      command:
        'NEW=$(git commit-tree -p main main^{tree} -m base-contamination) && ' +
        'git push -q origin "$NEW":refs/heads/main; exit 1',
    });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      success: false,
      requeued: false,
      baseAheadAfter: 0,
      baseMovedAfter: false,
      baseRemoteMovedAfter: true,
      branch: 'ai/issue-123',
      status: 'ready_for_human',
    });

    const task = await getTask(123);
    // Request stays open (operator must resolve the contaminated remote base) and
    // is NOT re-queued, so a later issue run never branches off the pushed commit.
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toMatch(/do NOT push .*`?main`?/i);
    // Not re-queued: no implementation-lane labels added.
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).not.toContain('status:needs-implementation');
  });

  test('the same exact command cannot be granted again after a failure that leaves changes behind (one-shot)', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'sh -c "echo dirty > leftover.txt; exit 1"' });
    expect(run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath).code).toBe(0);

    const second = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(second.code).not.toBe(0);
    expect(parse(second)).toMatchObject({ ok: false, error: expect.stringContaining('one-shot') });
  });

  test('the same exact command cannot be granted again after a failure that auto-requeued (already resolved, issue #678)', async () => {
    // A clean-failure grant now resolves and requeues the request (see above), so
    // a second attempt hits the earlier, broader "already resolved" gate instead
    // of the one-shot grant check — delivery stays idempotent either way.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'false' });
    expect(run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath).code).toBe(0);

    const second = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(second.code).not.toBe(0);
    expect(parse(second)).toMatchObject({ ok: false, error: expect.stringContaining('already resolved') });
  });
});

// ---------------------------------------------------------------------------
// Shell semantics: the EXACT command runs through a shell, not a tokenized argv
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: shell semantics', () => {
  test('runs a command using normal shell syntax (leading env assignment)', async () => {
    // `FOO=bar true` is valid shell but is NOT a binary named `FOO=bar`. If the
    // handler tokenized and exec-file'd the first token it would fail to spawn;
    // run through a shell it succeeds, leaving the tree clean → requeued.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'FOO=bar true' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, exitCode: 0, success: true, requeued: true });
  });

  test('runs an && command chain as a single command', async () => {
    // `&&` must chain two commands, not be passed as an argument. Both create a
    // file, so the tree ends dirty (not auto-requeued) but the command succeeds.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'touch a.txt && touch b.txt' });
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, exitCode: 0, success: true, dirtyAfter: true });
    expect(existsSync(join(repoRoot, 'a.txt'))).toBe(true);
    expect(existsSync(join(repoRoot, 'b.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exact-command matching is whitespace-sensitive inside quotes
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: quoted-whitespace exactness', () => {
  test('rejects a --command that differs only in quoted whitespace', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'printf "a b"' });
    // Same tokens, but the quoted argument has different (significant) spacing.
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--command', 'printf "a  b"', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('exact-command only') });
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(await getOutbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Repo lock: a granted command must not run concurrently with an active worker
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: repo lock', () => {
  test('refuses to execute while another context holds the repo lock', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'touch generated.txt' });

    // Simulate an active worker holding the lock for this session.
    const lockStore = new RepoLockStore(lockDir);
    expect(lockStore.acquire('worker-run-1', 'addon-dev').locked).toBe(true);

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('repo lock') });

    // Nothing executed or mutated while the lock was held.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant).toBeUndefined();
    expect(existsSync(join(repoRoot, 'generated.txt'))).toBe(false);
    expect(await getOutbox()).toHaveLength(0);

    lockStore.release('worker-run-1', 'addon-dev');
  });

  test('releases the lock after a successful grant so a later grant can run', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    expect(run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath).code).toBe(0);

    // The grant must have released the lock; a fresh context can acquire it.
    const lockStore = new RepoLockStore(lockDir);
    const acquired = lockStore.acquire('worker-run-2', 'addon-dev');
    expect(acquired.locked).toBe(true);
    lockStore.release('worker-run-2', 'addon-dev');
  });
});

// ---------------------------------------------------------------------------
// Per-issue worktree sessions (issue #454)
//
// The implementation phase runs in the per-issue worktree and leaves
// `ai/issue-<n>` checked out THERE. The grant must run the approved command in
// that worktree, not the canonical checkout: git refuses to check the issue
// branch out a second time in `repoRoot`, so a canonical-only path could no
// longer move onto the branch and the approved command failed before it ran.
// The grant must also isolate its dirty preflight to the issue worktree.
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: per-issue worktree sessions', () => {
  // Deterministic per-issue worktree layout: <root>/<session>/issue-<n>/repo.
  function worktreeRoot() {
    return join(tmpDir, 'wt');
  }
  function issueWorktreePath(issueNumber) {
    return join(worktreeRoot(), 'addon-dev', `issue-${issueNumber}`, 'repo');
  }
  // Register the per-issue worktree against the canonical checkout, with
  // `ai/issue-<n>` checked out there (mirroring what the implementation phase
  // leaves behind). `commitFile` simulates the partial work a Tool Request
  // handoff commits onto the issue branch.
  function addIssueWorktree(issueNumber, { commitFile } = {}) {
    const wtPath = issueWorktreePath(issueNumber);
    mkdirSync(join(worktreeRoot(), 'addon-dev', `issue-${issueNumber}`), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', `ai/issue-${issueNumber}`, wtPath, 'main'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (commitFile) {
      const wgit = (...a) => execFileSync('git', a, { cwd: wtPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      writeFileSync(join(wtPath, commitFile), 'partial\n', 'utf8');
      wgit('add', '-A');
      wgit('commit', '-q', '-m', 'wip: partial implementation');
    }
    return wtPath;
  }
  const canonicalBranch = () =>
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const worktreeBranch = (wtPath) =>
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath, encoding: 'utf8' }).trim();
  // Working-tree status / commit count scoped to a given checkout (canonical or
  // the issue worktree share one object store, but each has its own HEAD/index).
  const porcelainOf = (cwd) =>
    execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim();
  const branchCommitsOf = (cwd, branch) =>
    execFileSync('git', ['rev-list', '--count', `main..${branch}`], { cwd, encoding: 'utf8' }).trim();

  test('runs the granted command in the issue worktree, leaving the canonical checkout untouched', async () => {
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo();
    const wtPath = addIssueWorktree(123, { commitFile: 'wip.txt' });
    await seedToolRequestTask(123, { command: 'touch generated.txt' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      executed: true,
      exitCode: 0,
      success: true,
      requeued: false,
      dirtyAfter: true,
      branch: 'ai/issue-123',
      status: 'ready_for_human',
    });

    // The command ran in the worktree (its produced file lives there) and the
    // canonical checkout was never moved off its branch or dirtied.
    expect(existsSync(join(wtPath, 'generated.txt'))).toBe(true);
    expect(existsSync(join(repoRoot, 'generated.txt'))).toBe(false);
    expect(worktreeBranch(wtPath)).toBe('ai/issue-123');
    expect(canonicalBranch()).toBe('main');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');

    const task = await getTask(123);
    expect(task.context.toolRequestGrant.uses).toBe(1);
    expect(task.context.toolRequestGrant.lastResult.exitCode).toBe(0);
  });

  // Does origin have the issue branch? (the bare remote is at <tmpDir>/origin.git)
  const originHasBranch = (branch) =>
    execFileSync('git', ['ls-remote', '--heads', join(tmpDir, 'origin.git'), branch], { cwd: repoRoot, encoding: 'utf8' }).trim() !== '';

  test('a dirty canonical checkout does not block the grant when the issue worktree is clean', async () => {
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo({ dirty: true, withRemote: true });
    const wtPath = addIssueWorktree(123, { commitFile: 'wip.txt' });
    await seedToolRequestTask(123, { command: 'true' });

    // The canonical checkout carries unrelated dirt; the issue worktree is clean.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()).not.toBe('');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf8' }).trim()).toBe('');
    // The worktree branch is committed locally but not yet on origin.
    expect(originHasBranch('ai/issue-123')).toBe(false);

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    // A clean no-op in the worktree re-queues for implementation; the canonical
    // dirt never entered the dirty preflight.
    expect(parse(r)).toMatchObject({ ok: true, executed: true, exitCode: 0, success: true, requeued: true });

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(task.context.toolRequestGrant.uses).toBe(1);
    // The no-op tidy-up never tried to move the worktree off its issue branch.
    expect(worktreeBranch(wtPath)).toBe('ai/issue-123');
    // The worktree branch is pushed to origin before requeueing so the resumed
    // implementation's PR creation (`--head ai/issue-123`) can find it, then it is
    // recorded as the resume point to continue from the committed work instead of
    // failing the no-op diff check (issue #454 review).
    expect(originHasBranch('ai/issue-123')).toBe(true);
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });

  test('a no-op grant does NOT resume from an unpushed worktree branch when the push cannot reach origin', async () => {
    // No origin remote: the prior handoff committed partial work onto the local
    // worktree branch but it was never pushed. Recording it as the resume point
    // would let the requeued implementation accept the committed no-op, skip the
    // push (nothing to stage), then fail at `gh pr create --head ai/issue-123`
    // because origin lacks the branch. Refuse instead (issue #454 review).
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo();
    const wtPath = addIssueWorktree(123, { commitFile: 'wip.txt' });
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, exitCode: 0, success: true, requeued: true });

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(worktreeBranch(wtPath)).toBe('ai/issue-123');
    // The branch could not be pushed, so it is not adopted as the resume point —
    // the requeued implementation's new-branch preflight fails loudly instead of
    // stranding at PR creation, matching the shared-checkout gate.
    expect(task.context.toolRequestResumeBranch).toBeUndefined();
  });

  test('a dirty issue worktree still blocks the grant', async () => {
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo();
    const wtPath = addIssueWorktree(123, { commitFile: 'wip.txt' });
    // Dirty the issue worktree (not the canonical checkout).
    writeFileSync(join(wtPath, 'wip.txt'), 'uncommitted edit\n', 'utf8');
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('dirty') });

    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant).toBeUndefined();
    expect(await getOutbox()).toHaveLength(0);
  });

  test('a canonical base ahead of origin does not block the grant when it runs in the issue worktree', async () => {
    // Issue #455 review: the grant runs in the per-issue worktree and the requeued
    // implementation starts from origin/<base> or the recorded resume branch — never
    // off the canonical checkout's local base. The pre-flight base-ahead guard reads
    // the shared `origin/main..main`, so leaving it active in worktree mode would
    // refuse valid grants solely because the canonical checkout's base is ahead, even
    // though no unpushed canonical commit can leak into the issue branch.
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo({ withRemote: true });
    const wtPath = addIssueWorktree(123, { commitFile: 'wip.txt' });
    // An unrelated, unpushed commit advances the canonical `main` past origin/main.
    writeFileSync(join(repoRoot, 'README.md'), 'unrelated local change\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync('git', ['commit', '-q', '-m', 'unrelated local main commit'], { cwd: repoRoot, encoding: 'utf8' });
    expect(execFileSync('git', ['rev-list', '--count', 'origin/main..main'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('1');
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    // The base-ahead guard is skipped in worktree mode, so the clean no-op re-queues.
    expect(parse(r)).toMatchObject({ ok: true, executed: true, exitCode: 0, success: true, requeued: true });

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(true);
    expect(worktreeBranch(wtPath)).toBe('ai/issue-123');
    // The canonical base commit is left where it was — never pushed by the grant.
    expect(execFileSync('git', ['rev-list', '--count', 'origin/main..main'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('1');
  });

  test('a no-op grant removes the canonical artifact and leaves both trees clean when .n8n-artifacts/ is NOT gitignored', async () => {
    // The command runs in the issue worktree, but the grant artifact is still written
    // under the CANONICAL artifact root. With `.n8n-artifacts/` not gitignored that
    // artifact is untracked dirt in the canonical checkout (never the worktree), so it
    // must be probed/cleaned from the canonical checkout before requeue — otherwise it
    // would dirty-block the next phase even though the worktree itself is clean
    // (issue #458).
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo({ gitignoreArtifacts: false });
    const wtPath = addIssueWorktree(123, { commitFile: 'wip.txt' });
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, exitCode: 0, success: true, requeued: true });

    // The artifact lived under the canonical artifact root, not the worktree...
    expect(existsSync(join(wtPath, '.n8n-artifacts'))).toBe(false);
    // ...and was removed from the canonical checkout before requeue, so neither tree
    // is left dirty for the next preflight.
    const runsDir = join(repoRoot, '.n8n-artifacts', 'runs');
    const lingering = existsSync(runsDir)
      ? readdirSync(runsDir).filter((d) => d.startsWith('admin-tool-request-grant-'))
      : [];
    expect(lingering).toEqual([]);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf8' }).trim()).toBe('');

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Guided disposition (--on-changes) in worktree mode (issue #472).
  //
  // The shared-checkout disposition paths are covered by the issue #419 block
  // above; these repeat commit/discard/keep/push-failure for worktree-enabled
  // sessions to prove each disposition operates on the ISSUE WORKTREE only,
  // never the canonical checkout. The routing is inherited (the grant runs all
  // working-tree git ops in `grantRepoCwd`, which resolves to the worktree),
  // so these lock the behavior the acceptance criteria require.
  // -------------------------------------------------------------------------
  const grant = (...extra) =>
    run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath, ...extra);

  test('commit: commits to the issue branch in the worktree and pushes, canonical untouched', async () => {
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo({ withRemote: true });
    const wtPath = addIssueWorktree(123);
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });

    const r = grant('--on-changes', 'commit');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'grant',
      executed: true,
      success: true,
      requeued: false,
      changeAction: 'commit',
      changeOutcome: 'committed',
      pushed: true,
      branch: 'ai/issue-123',
      status: 'ready_for_human',
    });

    // The commit landed on the issue branch IN the worktree and was pushed; the
    // worktree tree is clean and stays on its branch.
    expect(worktreeBranch(wtPath)).toBe('ai/issue-123');
    expect(porcelainOf(wtPath)).toBe('');
    expect(branchCommitsOf(wtPath, 'ai/issue-123')).toBe('1');
    expect(originHasBranch('ai/issue-123')).toBe(true);

    // The canonical checkout never moved off main, was never dirtied, and its
    // copy of the file is untouched.
    expect(canonicalBranch()).toBe('main');
    expect(porcelainOf(repoRoot)).toBe('');
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');

    const task = await getTask(123);
    expect(task.context.toolRequestGrant.uses).toBe(1);
    expect(task.context.toolRequestChangeAction).toMatchObject({ action: 'commit', outcome: 'committed' });
  });

  test('keep: leaves the changes uncommitted in the worktree, canonical untouched', async () => {
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo();
    const wtPath = addIssueWorktree(123);
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });

    const r = grant('--on-changes', 'keep');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeAction: 'keep',
      changeOutcome: 'kept',
      status: 'ready_for_human',
    });

    // The change is kept (uncommitted) on the issue branch in the worktree.
    expect(worktreeBranch(wtPath)).toBe('ai/issue-123');
    expect(porcelainOf(wtPath)).not.toBe('');
    expect(branchCommitsOf(wtPath, 'ai/issue-123')).toBe('0');

    // The canonical checkout is untouched.
    expect(canonicalBranch()).toBe('main');
    expect(porcelainOf(repoRoot)).toBe('');

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);
  });

  test('discard: drops the worktree changes (tracked and untracked), canonical untouched', async () => {
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo();
    const wtPath = addIssueWorktree(123);
    await seedToolRequestTask(123, { command: 'echo updated >> package.json && echo gen > generated.txt' });

    const r = grant('--on-changes', 'discard', '--confirm-discard');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeAction: 'discard',
      changeOutcome: 'discarded',
      status: 'ready_for_human',
    });

    // The worktree is clean again: the tracked edit is reverted and the
    // untracked generated file removed.
    expect(porcelainOf(wtPath)).toBe('');
    expect(readFileSync(join(wtPath, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');
    expect(existsSync(join(wtPath, 'generated.txt'))).toBe(false);

    // The canonical checkout was never dirtied by the discard.
    expect(canonicalBranch()).toBe('main');
    expect(porcelainOf(repoRoot)).toBe('');

    const task = await getTask(123);
    expect(task.context.toolRequestGrant.uses).toBe(1);
  });

  test('commit: a push failure keeps the local commit in the worktree for recovery', async () => {
    // No origin remote, so `git push origin ai/issue-123` from the worktree fails.
    writeSession({ worktrees: { root: worktreeRoot() } });
    initRepo();
    const wtPath = addIssueWorktree(123);
    await seedToolRequestTask(123, { command: 'echo updated >> package.json' });

    const r = grant('--on-changes', 'commit');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      changeAction: 'commit',
      changeOutcome: 'committed-push-failed',
      pushed: false,
      status: 'ready_for_human',
    });

    // The commit is preserved locally on the issue branch in the worktree.
    expect(worktreeBranch(wtPath)).toBe('ai/issue-123');
    expect(branchCommitsOf(wtPath, 'ai/issue-123')).toBe('1');
    expect(porcelainOf(wtPath)).toBe('');

    // The canonical checkout is untouched.
    expect(canonicalBranch()).toBe('main');
    expect(porcelainOf(repoRoot)).toBe('');

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant.uses).toBe(1);

    const outbox = await getOutbox();
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toMatch(/push/i);
  });
});

// ---------------------------------------------------------------------------
// Canonical artifact cleanup when `.n8n-artifacts/` is NOT gitignored (issue #458)
// ---------------------------------------------------------------------------
// When the target repo does not gitignore the artifact root, this run's grant
// artifact (`tool-request-grant.json`) lands as an untracked file in the working
// tree. A bare `git status --porcelain` would then (a) misread the no-op command as
// having produced changes — the `:(exclude)` pathspec on the post-run probe drops
// the artifact so the true no-op is still recognised — and (b) leave the artifact
// behind to dirty-block the requeued implementation preflight, which runs a plain
// status. The no-op requeue path removes this run's artifact subtree only when git
// reports it as a working-tree change (i.e. the dir is not gitignored).
describe('admin CLI — tool-request grant: canonical artifact cleanup (issue #458)', () => {
  const grantArtifactDirs = () => {
    const runsDir = join(repoRoot, '.n8n-artifacts', 'runs');
    return existsSync(runsDir)
      ? readdirSync(runsDir).filter((d) => d.startsWith('admin-tool-request-grant-'))
      : [];
  };

  test('a no-op grant removes its canonical artifact and requeues when .n8n-artifacts/ is NOT gitignored', async () => {
    writeSession();
    initRepo({ gitignoreArtifacts: false });
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    // The artifact does NOT make the no-op look like produced changes: it is excluded
    // from the dirtiness probe, so the run is still recognised as a no-op and requeued.
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, requeued: true, branch: 'ai/issue-123' });

    // The artifact subtree was written under .n8n-artifacts/runs but removed before
    // requeue, leaving the canonical checkout clean for the next implementation
    // preflight (a plain `git status --porcelain`).
    expect(grantArtifactDirs()).toEqual([]);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(true);
  });

  test('a no-op grant PRESERVES its canonical artifact when .n8n-artifacts/ IS gitignored', async () => {
    // Contrast case: a gitignored artifact root is never working-tree dirt, so the
    // local audit record is kept (the cleanup probe reports nothing to remove) while
    // the no-op still requeues and the tree stays clean.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });

    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, executed: true, success: true, requeued: true, branch: 'ai/issue-123' });

    // The artifact survives on disk as a local audit record (gitignored, so it never
    // dirties the tree).
    expect(grantArtifactDirs()).toHaveLength(1);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Fresh repeated Tool Request with the same command (issue #490)
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request grant: fresh repeated Tool Request (issue #490)', () => {
  test('a fresh Tool Request with the same command can be granted after the prior grant was consumed', async () => {
    // Scenario from issue #490: agent emits TR1, operator runs guided-run
    // (succeeds, no changes, requeues), agent makes another fix pass and emits TR2
    // with the same command. The second guided-run must be allowed — the stored
    // (exhausted) grant was for TR1, not TR2.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });

    // First guided-run: succeeds, requeues.
    const first = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(first.code).toBe(0);
    expect(parse(first)).toMatchObject({ ok: true, requeued: true });

    // Read the task to get the consumed grant's grantedAt timestamp.
    const taskAfterFirst = await getTask(123);
    expect(taskAfterFirst.context.toolRequestGrant.uses).toBe(1);
    const grantedAt = taskAfterFirst.context.toolRequestGrant.grantedAt;

    // Simulate the agent emitting a fresh Tool Request with the same command but a
    // requestedAt that is AFTER the prior grantedAt — a new request instance.
    const freshRequestedAt = new Date(new Date(grantedAt).getTime() + 60_000).toISOString();
    const store = new SqliteTaskStore(dbPath);
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 123 },
      { status: taskAfterFirst.status },
      {
        status: 'ready_for_human',
        phase: 'implementation',
        context: {
          toolRequest: {
            command: 'true',
            displayCommand: 'true',
            reason: 'Needs the approved command again.',
            expectedFiles: ['package.json'],
            necessity: 'required',
            suggestedAction: 'grant-permission',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: freshRequestedAt,
            resolved: false,
          },
        },
      },
    );
    store.close();

    // Second guided-run for the fresh Tool Request: must succeed, not be blocked
    // by the one-shot guard that applies to the consumed first grant.
    const second = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(second.code).toBe(0);
    expect(parse(second)).toMatchObject({ ok: true, executed: true, exitCode: 0, requeued: true });

    // Confirm the second grant was a fresh one-shot (uses=1 again, not 2).
    const taskAfterSecond = await getTask(123);
    expect(taskAfterSecond.context.toolRequestGrant.uses).toBe(1);
  });

  test('retrying the same already-consumed Tool Request instance is still refused (one-shot preserved)', async () => {
    // The same Tool Request instance (same requestedAt, BEFORE grantedAt) must
    // never bypass the one-shot guard — only a genuinely fresh request (requestedAt
    // AFTER grantedAt) is allowed through.
    writeSession();
    initRepo();
    // Use a command that fails AND leaves changes behind (issue #678: a clean
    // failure now auto-resolves and requeues) so the task stays ready_for_human
    // with the same resolved=false Tool Request, keeping requestedAt < grantedAt.
    await seedToolRequestTask(123, { command: 'sh -c "echo dirty > leftover.txt; exit 1"' });

    // First grant: runs but fails — grant consumed (uses=1), task not requeued.
    const first = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(first.code).toBe(0);
    expect(parse(first)).toMatchObject({ ok: true, executed: true, exitCode: expect.any(Number), requeued: false });

    // Retrying the same request (requestedAt unchanged, still before grantedAt):
    // must be refused — not a fresh Tool Request instance.
    const second = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(second.code).not.toBe(0);
    expect(parse(second)).toMatchObject({ ok: false, error: expect.stringContaining('one-shot') });
  });
});
