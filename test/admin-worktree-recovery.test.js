import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveIssueWorktree, removeWorktree, SqliteTaskStore } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let repoRoot;
let worktreeRoot;
let sessionsPath;
let dbPath;
let lockDir;

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

function recoverJson(issueNumber) {
  const args = [
    'worktree', 'recovery', '--json',
    '--session-id', 'addon-dev',
    '--sessions-path', sessionsPath,
    '--db-path', dbPath,
    '--lock-dir', lockDir,
  ];
  if (issueNumber !== undefined) args.push('--issue-number', String(issueNumber));
  const r = run(...args);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout.trim());
}

function assessmentFor(issueNumber) {
  const out = recoverJson(issueNumber);
  expect(out.ok).toBe(true);
  return out.assessments.find((a) => a.issueNumber === issueNumber);
}

// Write a lock file directly (the issue lock scope is `<session>::issue-<n>`) so
// we can simulate an active vs. stale lock without waiting out the real TTL.
function writeLock(issueNumber, startedAt) {
  mkdirSync(lockDir, { recursive: true });
  const scope = `addon-dev::issue-${issueNumber}`;
  const file = join(lockDir, `${encodeURIComponent(scope)}.lock`);
  writeFileSync(file, JSON.stringify({ contextId: 'dead-run', sessionId: scope, startedAt }) + '\n');
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

async function enqueue(issueNumber, context) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber,
      phase: 'implementation',
      context: context ?? {},
    });
  } finally {
    store.close();
  }
}

// Force a task into a given status so we can simulate mid-flight/failed
// (recovery-relevant) and terminal `done` states that enqueueTask cannot set.
async function setStatus(issueNumber, status) {
  const store = new SqliteTaskStore(dbPath);
  try {
    const r = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      {},
      { status },
    );
    if (!r.ok) throw new Error(`setStatus failed: ${r.code}`);
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-wt-recovery-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'loop.db');
  lockDir = join(tmpDir, 'state', 'worktree-locks');
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin worktree recovery', () => {
  // #404 class: local branch only, no commits ahead, no PR, no worktree.
  test('branch-only stale state → cleanup-stale', () => {
    git(['branch', 'ai/issue-401', 'main'], repoRoot);
    const a = assessmentFor(401);
    expect(a.action).toBe('cleanup-stale');
    expect(a.stale).toBe(true);
    expect(a.resume).toBe(false);
  });

  // Branch with commits ahead but no managed worktree → recreate from branch.
  test('branch with work but missing worktree registry entry → recreate-worktree', () => {
    git(['branch', 'ai/issue-402', 'main'], repoRoot);
    git(['checkout', '-q', 'ai/issue-402'], repoRoot);
    writeFileSync(join(repoRoot, 'feature.txt'), 'work\n');
    git(['add', '-A'], repoRoot);
    git(['commit', '-q', '-m', 'feature'], repoRoot);
    git(['checkout', '-q', 'main'], repoRoot);

    const a = assessmentFor(402);
    expect(a.action).toBe('recreate-worktree');
    expect(a.resume).toBe(true);
  });

  // A managed worktree that was created and then pruned, leaving the branch with
  // work behind: the registry entry is gone but the branch must be recreated.
  test('pruned managed worktree with work → recreate-worktree', () => {
    const wt = resolveIssueWorktree({
      repoRoot, sessionId: 'addon-dev', issueNumber: 403, branch: 'ai/issue-403', baseRef: 'main', worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    writeFileSync(join(wt.path, 'feature.txt'), 'work\n');
    git(['add', '-A'], wt.path);
    git(['commit', '-q', '-m', 'feature'], wt.path);
    // Remove the worktree but keep the branch (the registry-drift case).
    expect(removeWorktree(repoRoot, wt.path, { force: true }).ok).toBe(true);

    const a = assessmentFor(403);
    expect(a.action).toBe('recreate-worktree');
  });

  // A managed worktree whose checkout directory was deleted out of band (rm -rf,
  // not `git worktree remove`) still appears in `git worktree list --porcelain`
  // on the issue branch, but flagged `prunable` because its path is gone. It must
  // NOT be treated as a resumable worktree — a resume follow-up would fail on the
  // missing path. It must also NOT be treated as a plain missing worktree: a
  // follow-up `git worktree add <same path> <branch>` fails with "missing but
  // already registered worktree" until the stale registration is pruned. So
  // recovery must recommend prune-then-recreate (executable), not a plain recreate.
  test('managed worktree directory deleted out of band → prune-and-recreate-worktree', () => {
    const wt = resolveIssueWorktree({
      repoRoot, sessionId: 'addon-dev', issueNumber: 414, branch: 'ai/issue-414', baseRef: 'main', worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    writeFileSync(join(wt.path, 'feature.txt'), 'work\n');
    git(['add', '-A'], wt.path);
    git(['commit', '-q', '-m', 'feature'], wt.path);
    // Delete the checkout directory without telling git: the registration in
    // .git/worktrees survives and is reported as prunable.
    rmSync(wt.path, { recursive: true, force: true });

    const a = assessmentFor(414);
    expect(a.action).toBe('prune-and-recreate-worktree');
    expect(a.resume).toBe(true);
    expect(a.guidance).toContain('prune');
  });

  // branch-with-PR recreate state: a recorded PR (prUrl in task context) plus a
  // local branch but no worktree → recreate.
  test('branch with recorded PR but missing worktree → recreate-worktree', async () => {
    git(['branch', 'ai/issue-404', 'main'], repoRoot);
    await enqueue(404, { prUrl: 'https://example.test/pr/404', branch: 'ai/issue-404' });
    const a = assessmentFor(404);
    expect(a.action).toBe('recreate-worktree');
    expect(a.resume).toBe(true);
  });

  // A Tool Request resolved before any PR exists requeues the implementation task
  // with only `context.toolRequestResumeBranch` as its continuation point. When
  // that branch lives only on origin (e.g. committed/pushed from another clone)
  // with no local branch or worktree here, the broad scan must still surface it
  // and recommend recreate-from-remote — not filter it out as "no drift".
  test('Tool Request resume branch present only on origin → recreate-from-remote', async () => {
    const origin = join(tmpDir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git(['remote', 'add', 'origin', origin], repoRoot);
    // Push the resume branch to origin, then drop it locally so it is origin-only
    // with no local branch and no worktree.
    git(['branch', 'ai/issue-420', 'main'], repoRoot);
    git(['push', '-q', 'origin', 'ai/issue-420'], repoRoot);
    git(['branch', '-q', '-D', 'ai/issue-420'], repoRoot);
    await enqueue(420, { toolRequestResumeBranch: 'ai/issue-420' });

    // The broad (no --issue-number) scan must include #420.
    const out = recoverJson();
    const a = out.assessments.find((x) => x.issueNumber === 420);
    expect(a).toBeDefined();
    expect(a.action).toBe('recreate-from-remote');
    expect(a.branch).toBe('ai/issue-420');
  });

  // A task whose context records a non-conventional PR head branch (fix/review/
  // conflict flows preserve `context.branch`, which need not be `ai/issue-<n>`).
  // Recovery must probe that recorded branch and compare the managed worktree
  // against it — synthesizing `ai/issue-415` would compare the worktree (on the
  // recorded branch) against the wrong ref and mis-report a valid resume as a
  // path conflict.
  test('recorded non-canonical PR branch is honored → resume, not path-conflict', async () => {
    const wt = resolveIssueWorktree({
      repoRoot, sessionId: 'addon-dev', issueNumber: 415, branch: 'feature/custom-415', baseRef: 'main', worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    await enqueue(415, { branch: 'feature/custom-415' });

    const a = assessmentFor(415);
    expect(a.branch).toBe('feature/custom-415');
    expect(a.action).toBe('resume');
    expect(a.resume).toBe(true);
  });

  // The managed per-issue path is registered but checked out on a different ref
  // (here: detached), so the registry entry's branch does not match the issue
  // branch. This must report a path conflict — not a recreate that git rejects
  // because the path is already registered.
  test('occupied-but-wrong-branch worktree → resolve-path-conflict', () => {
    const wt = resolveIssueWorktree({
      repoRoot, sessionId: 'addon-dev', issueNumber: 409, branch: 'ai/issue-409', baseRef: 'main', worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    // Detach HEAD inside the managed worktree so its registered branch no longer
    // matches refs/heads/ai/issue-409 while the path stays registered.
    git(['checkout', '-q', '--detach', 'HEAD'], wt.path);

    const a = assessmentFor(409);
    expect(a.action).toBe('resolve-path-conflict');
    expect(a.resume).toBe(false);
    expect(a.guidance).toContain('already registered');
  });

  // The issue branch is checked out in a worktree at a non-managed path (a
  // legacy/shared checkout or a moved worktree root). It is not registered at the
  // managed path, so a naive lookup would recommend recreate-worktree — but
  // `git worktree add <managedPath> ai/issue-411` refuses a branch already checked
  // out elsewhere. Recovery must surface the holder and recommend relocate.
  test('branch checked out at a non-managed worktree path → relocate-worktree', () => {
    const holder = join(tmpDir, 'legacy-checkout');
    git(['branch', 'ai/issue-411', 'main'], repoRoot);
    git(['worktree', 'add', '-q', holder, 'ai/issue-411'], repoRoot);
    writeFileSync(join(holder, 'feature.txt'), 'work\n');
    git(['add', '-A'], holder);
    git(['commit', '-q', '-m', 'feature'], holder);

    const a = assessmentFor(411);
    expect(a.action).toBe('relocate-worktree');
    expect(a.resume).toBe(false);
    expect(a.guidance).toContain('already checked out in another worktree');
    // The holder path is operator-only detail, never embedded in the path-free guidance.
    expect(a.guidance).not.toContain(holder);
  });

  // A task in a recovery-relevant status (failed mid-flight) expects a worktree;
  // with no branch/PR/worktree left it is genuine drift → report-drift.
  test('failed task with no branch/PR/worktree → report-drift', async () => {
    await enqueue(407, {});
    await setStatus(407, 'failed');
    const a = assessmentFor(407);
    expect(a.action).toBe('report-drift');
    expect(a.resume).toBe(false);
  });

  // A normal queued first-run task does not expect an existing worktree, so a
  // missing one is not drift: the broad (no --issue-number) scan must not surface
  // it, and it must not be misclassified as report-drift.
  test('fresh queued first-run task with no worktree context is not drift', async () => {
    await enqueue(408, {});
    const out = recoverJson();
    expect(out.assessments.map((a) => a.issueNumber)).not.toContain(408);
  });

  // Explicitly requesting a healthy queued task with no worktree context must not
  // be misclassified as a stale cleanup candidate ("no task references the
  // issue"). A live task row exists, so the missing worktree is recoverable drift.
  test('explicit --issue-number for a healthy queued task is report-drift, not cleanup-stale', async () => {
    await enqueue(420, {});
    const a = assessmentFor(420);
    expect(a.action).toBe('report-drift');
    expect(a.stale).toBe(false);
    expect(a.guidance).not.toContain('No worktree, branch, PR, or task references');
  });

  // A blocked task (dependency hold) or a ready_for_human task (Tool Request
  // handoff) can be produced before any resumable worktree exists. With no
  // recorded branch/PR context, a missing worktree is a healthy wait, not drift:
  // the broad scan must not surface it as report-drift and advise re-queueing.
  test('blocked task with no worktree context is not drift', async () => {
    await enqueue(409, {});
    await setStatus(409, 'blocked');
    const out = recoverJson();
    expect(out.assessments.map((a) => a.issueNumber)).not.toContain(409);
  });

  test('ready_for_human task with no worktree context is not drift', async () => {
    await enqueue(410, {});
    await setStatus(410, 'ready_for_human');
    const out = recoverJson();
    expect(out.assessments.map((a) => a.issueNumber)).not.toContain(410);
  });

  // A completed task left in SQLite after its worktree was pruned is terminal,
  // not drift: it must not be surfaced by the broad scan either.
  test('completed task whose worktree was pruned is not drift', async () => {
    await enqueue(412, {});
    await setStatus(412, 'done');
    const out = recoverJson();
    expect(out.assessments.map((a) => a.issueNumber)).not.toContain(412);
  });

  // A done task normally retains prUrl/branch context after its PR was created.
  // That retained PR context must not be trusted as evidence of expected-but-
  // missing drift: a legitimately-pruned completed issue must stay suppressed,
  // not be surfaced (and recommended for recreate) by the broad scan.
  test('completed task that still records prUrl/branch context is not drift', async () => {
    await enqueue(413, { prUrl: 'https://example.test/pr/413', branch: 'ai/issue-413' });
    await setStatus(413, 'done');
    const out = recoverJson();
    expect(out.assessments.map((a) => a.issueNumber)).not.toContain(413);
  });

  // Worktree cleanup removes the worktree but not necessarily the local
  // `ai/issue-<n>` branch, so a completed `done` issue can leave its branch
  // behind. The broad scan picks up local branches, but a terminal issue's
  // leftover branch must stay suppressed instead of being re-surfaced as a
  // recreate/cleanup candidate.
  test('completed task whose local branch remains is not drift in broad scan', async () => {
    git(['branch', 'ai/issue-415', 'main'], repoRoot);
    await enqueue(415, { prUrl: 'https://example.test/pr/415', branch: 'ai/issue-415' });
    await setStatus(415, 'done');
    const out = recoverJson();
    expect(out.assessments.map((a) => a.issueNumber)).not.toContain(415);
  });

  // Stale lock: surfaced but does not block a resume.
  test('stale lock is surfaced and does not block recovery', () => {
    const wt = resolveIssueWorktree({
      repoRoot, sessionId: 'addon-dev', issueNumber: 405, branch: 'ai/issue-405', baseRef: 'main', worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    writeLock(405, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

    const a = assessmentFor(405);
    expect(a.action).toBe('resume');
    expect(a.staleLock).toBe(true);
    expect(a.guidance).toContain('worktree release-lock');
  });

  // Active lock: a live run owns the issue → skip.
  test('active lock → skip-locked', () => {
    const wt = resolveIssueWorktree({
      repoRoot, sessionId: 'addon-dev', issueNumber: 406, branch: 'ai/issue-406', baseRef: 'main', worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    writeLock(406, new Date().toISOString());

    const a = assessmentFor(406);
    expect(a.action).toBe('skip-locked');
    expect(a.resume).toBe(false);
  });

  test('worktree + branch present → resume', () => {
    const wt = resolveIssueWorktree({
      repoRoot, sessionId: 'addon-dev', issueNumber: 410, branch: 'ai/issue-410', baseRef: 'main', worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    const a = assessmentFor(410);
    expect(a.action).toBe('resume');
    expect(a.resume).toBe(true);
  });

  test('diagnoses branch-only drift but skips healthy fresh tasks when --issue-number is omitted', async () => {
    git(['branch', 'ai/issue-401', 'main'], repoRoot);
    // A fresh queued first-run task is not drift, so only the branch-only #401
    // case is surfaced.
    await enqueue(407, {});
    const out = recoverJson();
    const issues = out.assessments.map((a) => a.issueNumber).sort((a, b) => a - b);
    expect(issues).toEqual([401]);
  });

  test('human-default output explains the recommended action', () => {
    git(['branch', 'ai/issue-401', 'main'], repoRoot);
    const r = run(
      'worktree', 'recovery',
      '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--lock-dir', lockDir,
      '--issue-number', '401',
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('cleanup-stale');
    expect(r.stdout).toContain('#401');
  });

  test('requires --session-id', () => {
    const r = run('worktree', 'recovery', '--sessions-path', sessionsPath);
    expect(r.code).toBe(1);
  });
});
