import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteTaskStore,
  resolveIssueWorktree,
  issueWorktreePath,
  canonicalizePath,
} from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let repoRoot;
let worktreeRoot;
let sessionsPath;
let dbPath;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// Run `status` in JSON mode and parse the single-line payload.
function statusJson(...args) {
  const r = run('status', '--json', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, ...args);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout.trim());
}

function writeSessions() {
  const sessions = {
    sessions: [
      {
        sessionId: 'addon-dev',
        repoKey: 'test-repo',
        repoRoot,
        githubRepo: 'm2dw/test-repo',
        artifactDir: '.n8n-artifacts',
        baseBranch: 'main',
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        verification: { test: 'npm test' },
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        worktrees: { root: worktreeRoot },
      },
    ],
  };
  writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

async function enqueue(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'implementation', implementationAgent: 'claude' });
  store.close();
}

// Drive a task into a target status/context for classification tests.
async function transition(issueNumber, fromStatus, patch) {
  const store = new SqliteTaskStore(dbPath);
  const res = await store.transitionTask({ sessionId: 'addon-dev', issueNumber }, { status: fromStatus }, patch);
  store.close();
  if (!res.ok) throw new Error(`transition failed: ${res.code}`);
}

function createIssueWorktree(issueNumber) {
  return resolveIssueWorktree({
    repoRoot,
    sessionId: 'addon-dev',
    issueNumber,
    branch: `ai/issue-${issueNumber}`,
    baseRef: 'main',
    worktreeRoot,
  });
}

function entryFor(payload, issueNumber) {
  return payload.entries.find((e) => e.issueNumber === issueNumber);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-status-test-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin status — worktree present', () => {
  test('reports a clean per-issue worktree and a runnable queued task', async () => {
    await enqueue(101);
    const wt = createIssueWorktree(101);

    const payload = statusJson('--issue-number', '101');
    expect(payload.ok).toBe(true);
    const e = entryFor(payload, 101);
    expect(e.classification).toBe('runnable');
    expect(e.branch.name).toBe('ai/issue-101');
    expect(e.branch.localExists).toBe(true);
    expect(e.worktree.exists).toBe(true);
    expect(e.worktree.registered).toBe(true);
    expect(e.worktree.clean).toBe(true);
    expect(e.worktree.id).toBe('addon-dev/issue-101');
    expect(canonicalizePath(wt.path)).toBe(canonicalizePath(issueWorktreePath(worktreeRoot, 'addon-dev', 101)));
  });
});

describe('admin status — worktree missing', () => {
  test('flags a missing worktree for a queued task', async () => {
    await enqueue(102);
    const payload = statusJson('--issue-number', '102');
    const e = entryFor(payload, 102);
    expect(e.worktree.exists).toBe(false);
    expect(e.worktree.registered).toBe(false);
    expect(e.worktree.clean).toBeNull();
  });
});

describe('admin status — dirty worktree', () => {
  test('reports a dirty per-issue worktree', async () => {
    await enqueue(103);
    const wt = createIssueWorktree(103);
    writeFileSync(join(wt.path, 'scratch.txt'), 'uncommitted\n');

    const payload = statusJson('--issue-number', '103');
    const e = entryFor(payload, 103);
    expect(e.worktree.exists).toBe(true);
    expect(e.worktree.clean).toBe(false);
  });
});

describe('admin status — dirty worktree classification', () => {
  test('dirtyCategory is null for a clean worktree', async () => {
    await enqueue(110);
    createIssueWorktree(110);

    const e = entryFor(statusJson('--issue-number', '110'), 110);
    expect(e.worktree.clean).toBe(true);
    expect(e.worktree.dirtyCategory).toBeNull();
  });

  test('dirtyCategory is null when worktree does not exist', async () => {
    await enqueue(111);
    // No worktree created
    const e = entryFor(statusJson('--issue-number', '111'), 111);
    expect(e.worktree.exists).toBe(false);
    expect(e.worktree.dirtyCategory).toBeNull();
  });

  test('dirtyCategory is action_required for a dirty worktree with no dirtyContinuation marker', async () => {
    await enqueue(112);
    const wt = createIssueWorktree(112);
    writeFileSync(join(wt.path, 'unknown.txt'), 'unexpected dirty\n');

    const e = entryFor(statusJson('--issue-number', '112'), 112);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('action_required');
  });

  test('dirtyCategory is null (not action_required) for a dirty worktree with no dirtyContinuation marker when the task is running', async () => {
    // A live worker may have normal uncommitted edits without any dirtyContinuation marker
    // (the marker is only written after a verification failure). Classifying this as
    // action_required would mislead operators into discarding an active run's worktree.
    await enqueue(123);
    const wt = createIssueWorktree(123);
    writeFileSync(join(wt.path, 'work-in-progress.txt'), 'live worker edits\n');
    // Claim the task to simulate an active worker without a dirtyContinuation marker.
    await transition(123, 'queued', {
      status: 'claimed',
      phase: 'implementation',
      ownerRunId: 'live-run',
      leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const e = entryFor(statusJson('--issue-number', '123'), 123);
    expect(e.worktree.clean).toBe(false);
    expect(e.classification).toBe('running');
    expect(e.worktree.dirtyCategory).toBeNull();
  });

  test('dirtyCategory is continuation_candidate for a dirty worktree with a valid dirtyContinuation marker and queued task', async () => {
    await enqueue(113);
    const wt = createIssueWorktree(113);
    writeFileSync(join(wt.path, 'scratch.txt'), 'prior verification failure edits\n');
    // Create the patch artifact file with the exact content buildUntrackedPatch would produce.
    const artifactDir113 = join(repoRoot, '.n8n-artifacts', 'runs', 'prior-run-113');
    mkdirSync(artifactDir113, { recursive: true });
    writeFileSync(join(artifactDir113, 'implementation-dirty-patch.patch'),
      'diff --git a/scratch.txt b/scratch.txt\nnew file mode 100644\n--- /dev/null\n+++ b/scratch.txt\n@@ -0,0 +1,1 @@\n+prior verification failure edits\n');
    // Simulate a valid dirtyContinuation marker as recorded by the implementation handler
    await transition(113, 'queued', {
      status: 'queued',
      context: {
        dirtyContinuation: {
          issueNumber: 113,
          phase: 'implementation',
          runId: 'prior-run-113',
          branch: 'ai/issue-113',
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['scratch.txt'],
          timestamp: new Date().toISOString(),
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '113'), 113);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('continuation_candidate');
    expect(e.classification).toBe('runnable');
  });

  test('dirtyCategory is continuation_candidate for a non-conventional PR head (prUrl-only handoff, no context.branch)', async () => {
    await enqueue(126);
    // Simulate a non-conventional PR head that does not follow ai/issue-N naming.
    // The implementation resolves this via fixPr.headRefName, not context.branch.
    git(['branch', 'feature/custom-pr-head', 'main'], repoRoot);
    const wt = resolveIssueWorktree({
      repoRoot,
      sessionId: 'addon-dev',
      issueNumber: 126,
      branch: 'feature/custom-pr-head',
      baseRef: 'main',
      worktreeRoot,
    });
    writeFileSync(join(wt.path, 'custom-pr.txt'), 'non-conventional pr work\n');
    const artifactDir126 = join(repoRoot, '.n8n-artifacts', 'runs', 'prior-run-126');
    mkdirSync(artifactDir126, { recursive: true });
    writeFileSync(join(artifactDir126, 'implementation-dirty-patch.patch'),
      'diff --git a/custom-pr.txt b/custom-pr.txt\nnew file mode 100644\n--- /dev/null\n+++ b/custom-pr.txt\n@@ -0,0 +1,1 @@\n+non-conventional pr work\n');
    // Set context with prUrl but no branch — a prUrl-only handoff where the PR head
    // is non-conventional. Status must derive the expected branch from the registered
    // worktree (feature/custom-pr-head) rather than falling back to ai/issue-126.
    await transition(126, 'queued', {
      status: 'queued',
      context: {
        prUrl: 'https://github.com/m2dw/test-repo/pull/999',
        dirtyContinuation: {
          issueNumber: 126,
          phase: 'implementation',
          runId: 'prior-run-126',
          branch: 'feature/custom-pr-head',
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['custom-pr.txt'],
          timestamp: new Date().toISOString(),
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '126'), 126);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('continuation_candidate');
    expect(e.classification).toBe('runnable');
  });

  test('dirtyCategory is continuation_active for a dirty worktree with a valid dirtyContinuation marker and running task', async () => {
    await enqueue(114);
    const wt = createIssueWorktree(114);
    writeFileSync(join(wt.path, 'scratch.txt'), 'in-progress edits\n');
    // Create the patch artifact file with the exact content buildUntrackedPatch would produce.
    const artifactDir114 = join(repoRoot, '.n8n-artifacts', 'runs', 'prior-run-114');
    mkdirSync(artifactDir114, { recursive: true });
    writeFileSync(join(artifactDir114, 'implementation-dirty-patch.patch'),
      'diff --git a/scratch.txt b/scratch.txt\nnew file mode 100644\n--- /dev/null\n+++ b/scratch.txt\n@@ -0,0 +1,1 @@\n+in-progress edits\n');
    await transition(114, 'queued', {
      status: 'claimed',
      phase: 'implementation',
      ownerRunId: 'active-run',
      leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      context: {
        dirtyContinuation: {
          issueNumber: 114,
          phase: 'implementation',
          runId: 'prior-run-114',
          branch: 'ai/issue-114',
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['scratch.txt'],
          timestamp: new Date().toISOString(),
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '114'), 114);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('continuation_active');
    expect(e.classification).toBe('running');
  });

  test('dirtyCategory is action_required for a dirty worktree with a partial dirtyContinuation marker (missing commitSkipped)', async () => {
    await enqueue(118);
    const wt = createIssueWorktree(118);
    writeFileSync(join(wt.path, 'scratch.txt'), 'edits from a failed capture\n');
    // A marker without commitSkipped: true is invalid — the implementation
    // preflight would reject it and the status must not mislead operators.
    await transition(118, 'queued', {
      status: 'queued',
      context: {
        dirtyContinuation: {
          issueNumber: 118,
          phase: 'implementation',
          branch: 'ai/issue-118',
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['scratch.txt'],
          timestamp: new Date().toISOString(),
          // commitSkipped intentionally omitted
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '118'), 118);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('action_required');
  });

  test('dirtyCategory is action_required for a dirty worktree with a partial dirtyContinuation marker (missing patchArtifactFile)', async () => {
    await enqueue(119);
    const wt = createIssueWorktree(119);
    writeFileSync(join(wt.path, 'scratch.txt'), 'edits where patch capture failed\n');
    // A marker without patchArtifactFile means the dirty-state capture failed; the
    // implementation preflight rejects it and the status must reflect that.
    await transition(119, 'queued', {
      status: 'queued',
      context: {
        dirtyContinuation: {
          issueNumber: 119,
          phase: 'implementation',
          branch: 'ai/issue-119',
          commitSkipped: true,
          dirtyFiles: ['scratch.txt'],
          timestamp: new Date().toISOString(),
          // patchArtifactFile intentionally omitted
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '119'), 119);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('action_required');
  });

  test('dirtyCategory is action_required for a dirty worktree with a stale dirtyContinuation marker (wrong branch)', async () => {
    await enqueue(120);
    const wt = createIssueWorktree(120);
    writeFileSync(join(wt.path, 'scratch.txt'), 'edits from a different branch run\n');
    // A marker whose branch does not match the expected worktree branch is stale.
    await transition(120, 'queued', {
      status: 'queued',
      context: {
        dirtyContinuation: {
          issueNumber: 120,
          phase: 'implementation',
          branch: 'ai/issue-999',  // wrong branch
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['scratch.txt'],
          timestamp: new Date().toISOString(),
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '120'), 120);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('action_required');
  });

  test('dirtyCategory is action_required for a dirty worktree with a partial dirtyContinuation marker (missing dirtyFiles)', async () => {
    await enqueue(121);
    const wt = createIssueWorktree(121);
    writeFileSync(join(wt.path, 'scratch.txt'), 'edits where dirtyFiles capture failed\n');
    // A marker without dirtyFiles means the file-set capture did not complete;
    // the implementation preflight fails closed for such markers.
    await transition(121, 'queued', {
      status: 'queued',
      context: {
        dirtyContinuation: {
          issueNumber: 121,
          phase: 'implementation',
          runId: 'prior-run-121',
          branch: 'ai/issue-121',
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          // dirtyFiles intentionally omitted
          timestamp: new Date().toISOString(),
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '121'), 121);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('action_required');
  });

  test('dirtyCategory is action_required for a dirty worktree with a partial dirtyContinuation marker (has patchArtifactFile but missing runId)', async () => {
    await enqueue(122);
    const wt = createIssueWorktree(122);
    writeFileSync(join(wt.path, 'scratch.txt'), 'edits from a run whose id was not recorded\n');
    // A marker with patchArtifactFile but no runId cannot have its patch artifact
    // located; the implementation preflight fails closed in this case.
    await transition(122, 'queued', {
      status: 'queued',
      context: {
        dirtyContinuation: {
          issueNumber: 122,
          phase: 'implementation',
          // runId intentionally omitted
          branch: 'ai/issue-122',
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['scratch.txt'],
          timestamp: new Date().toISOString(),
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '122'), 122);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('action_required');
  });

  test('dirtyCategory is action_required when patch artifact file has been deleted', async () => {
    await enqueue(119);
    const wt = createIssueWorktree(119);
    writeFileSync(join(wt.path, 'scratch.txt'), 'prior verification failure edits\n');
    // Do NOT create the patch artifact file — simulates artifact directory cleanup.
    await transition(119, 'queued', {
      status: 'queued',
      context: {
        dirtyContinuation: {
          issueNumber: 119,
          phase: 'implementation',
          runId: 'prior-run-119',
          branch: 'ai/issue-119',
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['scratch.txt'],
          timestamp: new Date().toISOString(),
        },
      },
    });

    // The marker is structurally valid but the artifact file is absent; the
    // implementation preflight would fail closed, so status must not advertise
    // auto-continuation — it must classify this as action_required.
    const e = entryFor(statusJson('--issue-number', '119'), 119);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('action_required');
  });

  test('dirtyCategory is action_required when context.branch differs from dirtyContinuation.branch (stale marker after PR branch change)', async () => {
    await enqueue(127);
    // Create the worktree on the OLD PR head branch.
    git(['branch', 'feature/old-head-127', 'main'], repoRoot);
    const wt = resolveIssueWorktree({
      repoRoot,
      sessionId: 'addon-dev',
      issueNumber: 127,
      branch: 'feature/old-head-127',
      baseRef: 'main',
      worktreeRoot,
    });
    writeFileSync(join(wt.path, 'old-head.txt'), 'stale dirty edits\n');
    const artifactDir127 = join(repoRoot, '.n8n-artifacts', 'runs', 'prior-run-127');
    mkdirSync(artifactDir127, { recursive: true });
    writeFileSync(join(artifactDir127, 'implementation-dirty-patch.patch'),
      'diff --git a/old-head.txt b/old-head.txt\nnew file mode 100644\n--- /dev/null\n+++ b/old-head.txt\n@@ -0,0 +1,1 @@\n+stale dirty edits\n');
    // The task now records a DIFFERENT target branch (the PR head was updated); the dirty
    // continuation marker still references the old branch. Status must prefer the live
    // recorded context.branch over the worktree's current checkout and classify as
    // action_required rather than advertising auto-continuation that the worker would reject.
    await transition(127, 'queued', {
      status: 'queued',
      context: {
        prUrl: 'https://github.com/m2dw/test-repo/pull/1000',
        branch: 'feature/new-head-127',
        dirtyContinuation: {
          issueNumber: 127,
          phase: 'implementation',
          runId: 'prior-run-127',
          branch: 'feature/old-head-127',
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['old-head.txt'],
          timestamp: new Date().toISOString(),
        },
      },
    });

    const e = entryFor(statusJson('--issue-number', '127'), 127);
    expect(e.worktree.clean).toBe(false);
    expect(e.worktree.dirtyCategory).toBe('action_required');
    expect(e.classification).toBe('runnable');
  });

  test('human output for action_required on non-conventional branch omits worktree discard and suggests prune/remove', async () => {
    await enqueue(128);
    // Simulate a prUrl-only review worktree on a non-conventional head (e.g. ai/pr-*).
    // runWorktreeDiscard expects ai/issue-<n> for such tasks and would refuse the branch,
    // so status must not advertise the discard command.
    git(['branch', 'fix/pr-custom-128', 'main'], repoRoot);
    const wt = resolveIssueWorktree({
      repoRoot,
      sessionId: 'addon-dev',
      issueNumber: 128,
      branch: 'fix/pr-custom-128',
      baseRef: 'main',
      worktreeRoot,
    });
    writeFileSync(join(wt.path, 'custom-dirty.txt'), 'unexpected dirty state\n');
    // prUrl-only task: no context.branch recorded; no dirtyContinuation marker.
    await transition(128, 'queued', {
      status: 'queued',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/1001' },
    });

    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '128');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('operator action required');
    // Must NOT suggest `worktree discard` — the command would refuse the non-conventional branch.
    expect(r.stdout).not.toContain('worktree discard');
    // Must suggest an alternative recovery path.
    expect(r.stdout).toMatch(/worktree prune|git worktree remove/);
  });

  test('human output labels continuation_candidate with descriptive text', async () => {
    await enqueue(115);
    const wt = createIssueWorktree(115);
    writeFileSync(join(wt.path, 'scratch.txt'), 'prior failure edits\n');
    // Create the patch artifact file with the exact content buildUntrackedPatch would produce.
    const artifactDir115 = join(repoRoot, '.n8n-artifacts', 'runs', 'prior-run-115');
    mkdirSync(artifactDir115, { recursive: true });
    writeFileSync(join(artifactDir115, 'implementation-dirty-patch.patch'),
      'diff --git a/scratch.txt b/scratch.txt\nnew file mode 100644\n--- /dev/null\n+++ b/scratch.txt\n@@ -0,0 +1,1 @@\n+prior failure edits\n');
    await transition(115, 'queued', {
      status: 'queued',
      context: {
        dirtyContinuation: {
          issueNumber: 115,
          phase: 'implementation',
          runId: 'prior-run-115',
          branch: 'ai/issue-115',
          commitSkipped: true,
          patchArtifactFile: 'implementation-dirty-patch.patch',
          dirtyFiles: ['scratch.txt'],
          timestamp: new Date().toISOString(),
        },
      },
    });

    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '115');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('continuation candidate');
    expect(r.stdout).toContain('prior verification failure');
    // Suggested action should offer a lock-aware discard command (not worktree prune --force)
    expect(r.stdout).toContain('worktree discard');
    expect(r.stdout).toContain('--yes');
  });

  test('human output labels action_required with descriptive text and discard hint', async () => {
    await enqueue(116);
    const wt = createIssueWorktree(116);
    writeFileSync(join(wt.path, 'unknown.txt'), 'unexpected dirty\n');

    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '116');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('operator action required');
    expect(r.stdout).toContain('no continuation record');
    // Suggested action should offer a lock-aware discard command (not worktree prune --force)
    expect(r.stdout).toContain('worktree discard');
    expect(r.stdout).toContain('--yes');
  });

  test('canonical dirty human output shows fatal label', async () => {
    await enqueue(117);
    writeFileSync(join(repoRoot, 'uncommitted.txt'), 'unstaged in canonical\n');

    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '117');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('canonical checkout:');
    expect(r.stdout).toContain('DIRTY');
    expect(r.stdout).toContain('fatal');
  });
});

describe('admin status — branch-only #404 diagnosis', () => {
  test('failed task with a local branch but no remote/PR/worktree is diagnosed', async () => {
    await enqueue(404);
    // The run failed while trying to create/publish the branch: a local branch
    // exists, but nothing was pushed and no worktree was created.
    git(['branch', 'ai/issue-404', 'main'], repoRoot);
    await transition(404, 'queued', {
      status: 'failed',
      phase: 'implementation',
      lastError: 'git push origin ai/issue-404 failed: no upstream',
    });

    const payload = statusJson('--issue-number', '404');
    const e = entryFor(payload, 404);
    expect(e.classification).toBe('failed');
    expect(e.branch.localExists).toBe(true);
    expect(e.branch.remoteTrackingExists).toBe(false);
    expect(e.pr.exists).toBe(false);
    expect(e.worktree.exists).toBe(false);
    expect(e.suggestedAction).toContain('never pushed');
  });
});

describe('admin status — no task', () => {
  test('an explicit issue with no task is still shown', () => {
    const payload = statusJson('--issue-number', '999');
    expect(payload.count).toBe(1);
    const e = entryFor(payload, 999);
    expect(e.task).toBeNull();
    expect(e.classification).toBe('no_task');
  });
});

describe('admin status — blocked / tool-request / capped classification', () => {
  test('blocked task surfaces open dependency numbers', async () => {
    await enqueue(200);
    await transition(200, 'queued', {
      status: 'blocked',
      phase: 'implementation',
      context: { dependencyRecheck: { blockedBy: [{ issueNumber: 400, state: 'open' }, { issueNumber: 399, state: 'closed' }] } },
    });
    const e = entryFor(statusJson('--issue-number', '200'), 200);
    expect(e.classification).toBe('blocked');
    expect(e.suggestedAction).toContain('#400');
    expect(e.suggestedAction).not.toContain('#399');
  });

  test('pending tool request is classified as waiting_for_tool_request', async () => {
    await enqueue(201);
    await transition(201, 'queued', {
      status: 'ready_for_human',
      phase: 'implementation',
      context: { toolRequest: { command: 'npm install x', resolved: false } },
    });
    const e = entryFor(statusJson('--issue-number', '201'), 201);
    expect(e.classification).toBe('waiting_for_tool_request');
    expect(e.suggestedAction).toContain('tool-request list');
  });

  test('review-loop cap is classified as capped', async () => {
    await enqueue(202);
    await transition(202, 'queued', {
      status: 'ready_for_human',
      phase: 'review',
      context: { reviewLoopCapReached: true },
    });
    const e = entryFor(statusJson('--issue-number', '202'), 202);
    expect(e.classification).toBe('capped');
    expect(e.suggestedAction).toContain('recover-cap-handoff');
  });

  test('review handoff with missing verification commands surfaces them in suggestedAction (issue #622)', async () => {
    await enqueue(203);
    await transition(203, 'queued', {
      status: 'ready_for_human',
      phase: 'review',
      context: { missingVerificationCommands: ['npm run export -- --dry-run', 'npm run lint'] },
    });
    const e = entryFor(statusJson('--issue-number', '203'), 203);
    expect(e.classification).toBe('needs_human');
    expect(e.suggestedAction).toContain('npm run export -- --dry-run');
    expect(e.suggestedAction).toContain('npm run lint');
    expect(e.suggestedAction).toContain('review-verification resolve');
  });
});

describe('admin status — closed tasks hidden by default', () => {
  test('done tasks are hidden in the session view unless --all or explicit issue', async () => {
    await enqueue(300);
    await transition(300, 'queued', { status: 'done', phase: 'implementation' });
    await enqueue(301); // remains queued/visible

    const sessionView = statusJson();
    expect(entryFor(sessionView, 300)).toBeUndefined();
    expect(entryFor(sessionView, 301)).toBeDefined();

    const allView = statusJson('--all');
    expect(entryFor(allView, 300)).toBeDefined();

    // An explicit issue is always shown, even when done.
    const explicit = statusJson('--issue-number', '300');
    expect(entryFor(explicit, 300).classification).toBe('done');
  });
});

describe('admin status — repo not inspectable', () => {
  test('fails loudly when the repo is not a Git checkout instead of reporting misleading state', async () => {
    await enqueue(404);
    // Point the session at a directory that exists but is not a Git checkout, so
    // `git worktree list` fails. The command must surface the setup error rather
    // than emit an ok:true payload where every branch/worktree probe collapses
    // to "no branch / missing worktree".
    writeFileSync(sessionsPath, JSON.stringify({
      sessions: [{
        sessionId: 'addon-dev',
        repoKey: 'test-repo',
        repoRoot: tmpDir, // tmpDir itself is not a git checkout
        githubRepo: 'm2dw/test-repo',
        artifactDir: '.n8n-artifacts',
        baseBranch: 'main',
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        verification: { test: 'npm test' },
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        worktrees: { root: worktreeRoot },
      }],
    }, null, 2));

    const r = run('status', '--json', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '404');
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('Cannot inspect repository worktree state');
  });
});

describe('admin status — output modes', () => {
  test('human-readable by default', async () => {
    await enqueue(500);
    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '500');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Status for session addon-dev, issue #500');
    expect(r.stdout).toContain('RUNNABLE');
    expect(r.stdout).toContain('Repo lock: free');
  });

  test('renders a stale repo lock instead of reporting it free', async () => {
    await enqueue(502);
    // A stale lock file: RepoLockStore.inspect treats a record older than its TTL
    // (24h) as not locking (held=false) but stale=true with owner metadata. The
    // default human view must surface the stale owner rather than print "free".
    const lockDir = join(tmpDir, 'locks');
    mkdirSync(lockDir, { recursive: true });
    const staleStartedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(lockDir, 'addon-dev.lock'),
      JSON.stringify({ contextId: 'ctx-crashed', sessionId: 'addon-dev', startedAt: staleStartedAt }, null, 2) + '\n',
    );

    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '502', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('Repo lock: free\n');
    expect(r.stdout).toContain('Repo lock: free (stale lock');
    expect(r.stdout).toContain('ctx-crashed');
  });

  test('default output never exposes absolute local paths', async () => {
    await enqueue(501);
    createIssueWorktree(501);
    // JSON
    const jsonOut = run('status', '--json', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '501');
    expect(jsonOut.stdout).not.toContain(repoRoot);
    expect(jsonOut.stdout).not.toContain(worktreeRoot);
    // Human
    const humanOut = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '501');
    expect(humanOut.stdout).not.toContain(repoRoot);
    expect(humanOut.stdout).not.toContain(worktreeRoot);
  });

  test('redacts the symlink-resolved worktree root leaked into a task error', async () => {
    // Configure the worktree root as a symlink pointing at a non-standard
    // absolute path. git reports the canonical (resolved) checkout path, so a
    // task error can carry that real path even though the configured root is the
    // symlink. The status output must not leak either form.
    const realTarget = join(tmpDir, 'real-worktree-store');
    mkdirSync(realTarget, { recursive: true });
    const symlinkedRoot = join(tmpDir, 'state', 'worktrees-link');
    mkdirSync(join(tmpDir, 'state'), { recursive: true });
    symlinkSync(realTarget, symlinkedRoot);
    worktreeRoot = symlinkedRoot;
    writeSessions();

    const canonicalRoot = realpathSync(symlinkedRoot);
    expect(canonicalRoot).not.toBe(symlinkedRoot);

    await enqueue(502);
    await transition(502, 'queued', {
      status: 'failed',
      phase: 'implementation',
      lastError: `git worktree add ${join(canonicalRoot, 'addon-dev', 'issue-502')} failed`,
    });

    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '502');
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(canonicalRoot);
    expect(r.stdout).not.toContain(symlinkedRoot);
  });

  test('redacts the symlink-resolved repo root leaked into a task error', async () => {
    // Configure repoRoot as a symlink to a real git checkout under a non-standard
    // top-level directory. git resolves symlinks, so a task error can carry the
    // canonical (real) repo path even though the configured root is the symlink.
    // status promises not to expose absolute local paths, so neither form may leak.
    const realRepo = join(tmpDir, 'real-repo-store');
    execFileSync('git', ['init', '-q', '-b', 'main', realRepo]);
    writeFileSync(join(realRepo, 'README.md'), '# repo\n');
    git(['add', '-A'], realRepo);
    git(['commit', '-q', '-m', 'initial'], realRepo);
    const symlinkedRepo = join(tmpDir, 'repo-link');
    symlinkSync(realRepo, symlinkedRepo);
    repoRoot = symlinkedRepo;
    writeSessions();

    const canonicalRepo = realpathSync(symlinkedRepo);
    expect(canonicalRepo).not.toBe(symlinkedRepo);

    await enqueue(503);
    await transition(503, 'queued', {
      status: 'failed',
      phase: 'implementation',
      lastError: `git -C ${canonicalRepo} checkout -b ai/issue-503 failed`,
    });

    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '503');
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(canonicalRepo);
    expect(r.stdout).not.toContain(symlinkedRepo);
  });

  test('requires a session selector', () => {
    const r = run('status', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(1);
  });
});

describe('admin status — canonical checkout state', () => {
  test('reports canonicalDirty:false in JSON when canonical repo is clean', async () => {
    await enqueue(600);
    const payload = statusJson('--issue-number', '600');
    const e = entryFor(payload, 600);
    expect(e.canonicalDirty).toBe(false);
  });

  test('reports canonicalDirty:true in JSON when canonical repo has uncommitted changes', async () => {
    await enqueue(601);
    writeFileSync(join(repoRoot, 'uncommitted.txt'), 'unstaged changes\n');
    const payload = statusJson('--issue-number', '601');
    const e = entryFor(payload, 601);
    expect(e.canonicalDirty).toBe(true);
  });

  test('human output shows canonical checkout state separately from worktree state', async () => {
    await enqueue(602);
    createIssueWorktree(602);
    const r = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '602');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('canonical checkout:');
    expect(r.stdout).toContain('worktree addon-dev/issue-602:');
  });
});

describe('admin status — stale lock worktree-aware suggestion', () => {
  test('live issue lock in stale task surfaces a force-release hint in suggestedAction', async () => {
    const worktreeLockDir = join(tmpDir, 'wt-locks');
    mkdirSync(worktreeLockDir, { recursive: true });

    await enqueue(603);
    // Drive the task to claimed with an expired lease
    await transition(603, 'queued', {
      status: 'claimed',
      phase: 'implementation',
      ownerRunId: 'old-run',
      leaseExpiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    // Write a LIVE worktree lock (started 60 min ago, well inside the 24h TTL, so
    // held=true / stale=false). `worktree release-lock` refuses a live lock unless
    // `--force` is given, so the status hint must surface `--force` — otherwise the
    // suggested recovery is a no-op for exactly this held-lock case (issue #447 review, P2).
    const lockFile = join(worktreeLockDir, `${encodeURIComponent('addon-dev::issue-603')}.lock`);
    writeFileSync(lockFile, JSON.stringify({
      contextId: 'old-ctx',
      sessionId: 'addon-dev',
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }) + '\n');

    const r = run(
      'status',
      '--json',
      '--session-id', 'addon-dev',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--issue-number', '603',
      '--worktree-lock-dir', worktreeLockDir,
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    const e = entryFor(payload, 603);
    expect(e.classification).toBe('stale');
    expect(e.issueLock.held).toBe(true);
    expect(e.issueLock.stale).toBe(false);
    expect(e.suggestedAction).toContain('release-lock');
    expect(e.suggestedAction).toContain('worktree');
    // The live-lock branch must include the required `--force` (and the caution around it).
    expect(e.suggestedAction).toContain('--force');
    expect(e.suggestedAction).toContain('live');
    // `worktree release-lock` previews by default, so the hint must also carry `--yes`;
    // otherwise the suggested force-release exits 0 without releasing the lock (issue #447 review, P2).
    expect(e.suggestedAction).toContain('--yes');
    // A non-default `--worktree-lock-dir` must be threaded into the release-lock hint so the
    // follow-up command inspects the SAME lock dir status reported on, not the default one
    // (issue #447 review, P2).
    expect(e.suggestedAction).toContain(`--lock-dir ${worktreeLockDir}`);
  });

  test('truly stale issue lock in stale task suggests plain release-lock without --force', async () => {
    const worktreeLockDir = join(tmpDir, 'wt-locks-stale');
    mkdirSync(worktreeLockDir, { recursive: true });

    await enqueue(605);
    await transition(605, 'queued', {
      status: 'claimed',
      phase: 'implementation',
      ownerRunId: 'old-run',
      leaseExpiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    // Write a STALE worktree lock (started 25h ago, past the 24h TTL, so held=false /
    // stale=true). `worktree release-lock` releases a stale lock without `--force`, so
    // the plain command is the correct recovery here.
    const lockFile = join(worktreeLockDir, `${encodeURIComponent('addon-dev::issue-605')}.lock`);
    writeFileSync(lockFile, JSON.stringify({
      contextId: 'old-ctx',
      sessionId: 'addon-dev',
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    }) + '\n');

    const r = run(
      'status',
      '--json',
      '--session-id', 'addon-dev',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--issue-number', '605',
      '--worktree-lock-dir', worktreeLockDir,
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    const e = entryFor(payload, 605);
    expect(e.classification).toBe('stale');
    expect(e.issueLock.held).toBe(false);
    expect(e.issueLock.stale).toBe(true);
    expect(e.suggestedAction).toContain('release the stale worktree lock');
    expect(e.suggestedAction).toContain('release-lock');
    // The stale-lock branch must NOT append `--force`; a stale lock releases without it.
    expect(e.suggestedAction).not.toContain('--force');
    // But it must still carry `--yes`, since `worktree release-lock` previews by default —
    // without it the suggested recovery is a no-op even for a stale lock (issue #447 review, P2).
    expect(e.suggestedAction).toContain('--yes');
    expect(e.suggestedAction).toContain(`--lock-dir ${worktreeLockDir}`);
  });

  test('default worktree lock dir omits --lock-dir from the release-lock hint', async () => {
    // With no `--worktree-lock-dir`, `admin worktree release-lock` already targets the
    // default lock dir, so the hint must NOT append a redundant `--lock-dir` (issue #447
    // review, P2). Point the child's HOME at tmpDir so the default lock dir resolves under
    // it and the lock can be written without touching the real home.
    const defaultLockDir = join(tmpDir, '.local', 'state', 'n8n-ai-cli-loop', 'worktree-locks');
    mkdirSync(defaultLockDir, { recursive: true });

    await enqueue(604);
    await transition(604, 'queued', {
      status: 'claimed',
      phase: 'implementation',
      ownerRunId: 'old-run',
      leaseExpiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    const lockFile = join(defaultLockDir, `${encodeURIComponent('addon-dev::issue-604')}.lock`);
    writeFileSync(lockFile, JSON.stringify({
      contextId: 'old-ctx',
      sessionId: 'addon-dev',
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }) + '\n');

    const stdout = execFileSync(
      process.execPath,
      [CLI, 'status', '--json', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath, '--issue-number', '604'],
      { encoding: 'utf8', env: { ...process.env, HOME: tmpDir } },
    );
    const payload = JSON.parse(stdout.trim());
    const e = entryFor(payload, 604);
    expect(e.classification).toBe('stale');
    expect(e.issueLock.held).toBe(true);
    expect(e.suggestedAction).toContain('release-lock');
    // Live lock ⇒ the hint carries `--force` and `--yes`, but no redundant `--lock-dir`
    // under the default dir.
    expect(e.suggestedAction).toContain('--force');
    expect(e.suggestedAction).toContain('--yes');
    expect(e.suggestedAction).not.toContain('--lock-dir');
  });
});

describe('admin status — session pause (issue #531)', () => {
  test('an unpaused session reports sessionPause.paused=false', async () => {
    await enqueue(300);
    const payload = statusJson();
    expect(payload.sessionPause).toEqual({ paused: false });
  });

  test('a paused session surfaces the reason in JSON and human output', async () => {
    await enqueue(301);
    const pause = run(
      'session', 'pause',
      '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--reason', 'ops hold', '--json',
    );
    expect(pause.code).toBe(0);

    const payload = statusJson();
    expect(payload.sessionPause).toMatchObject({ paused: true, reason: 'ops hold', source: 'operator' });

    const human = run('status', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('SESSION PAUSED');
    expect(human.stdout).toContain('ops hold');
    expect(human.stdout).toContain('admin session resume --session-id addon-dev');
  });
});

describe('admin status — tolerates non-object session entries (issue #823 review fix)', () => {
  test('a leading null entry does not prevent status from finding the valid session', async () => {
    const sessions = {
      sessions: [
        null,
        {
          sessionId: 'addon-dev',
          repoKey: 'test-repo',
          repoRoot,
          githubRepo: 'm2dw/test-repo',
          artifactDir: '.n8n-artifacts',
          baseBranch: 'main',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: { test: 'npm test' },
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
          worktrees: { root: worktreeRoot },
        },
      ],
    };
    writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));

    await enqueue(303);
    const payload = statusJson('--issue-number', '303');
    expect(payload.ok).toBe(true);
    const e = entryFor(payload, 303);
    expect(e).toBeDefined();
  });
});
