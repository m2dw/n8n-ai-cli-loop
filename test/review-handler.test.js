import { mkdtempSync, rmSync, readFileSync, existsSync, lstatSync, symlinkSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReviewHandler as _createReviewHandler } from '../dist/handlers/review.js';
import { SqliteTaskStore, runNextPhase } from '../dist/index.js';
import {
  REVIEW_FINDINGS_END_MARKER,
  REVIEW_FINDINGS_MARKER,
} from '../dist/core/review-finding-envelope.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let artifactRoot;

// ---------------------------------------------------------------------------
// Worktree + lock fixtures (issue #456/#699: review always resolves a per-issue
// worktree and an issue-scoped advisory lock — there is no more canonical-
// checkout path). Shared, module-scope versions so every describe block below
// can get safe defaults without redefining them; the dedicated "per-issue
// worktree review (issue #456)" describe block further down defines its OWN
// local copies (same shape) which shadow these within that block — left
// untouched since that block already correctly targets worktree mode.
// ---------------------------------------------------------------------------

// Deterministic fake worktree path used by every test that does not supply its
// own `resolveWorktree` override.
const worktreePath = () => join(tmpDir, 'worktrees', 'addon-dev', 'issue-77');

// Records every resolveWorktree() input and returns a fixed worktree path so the
// handler's cwd switch is exercised without a real `git worktree`. Defaults model
// the common review case: the worktree already exists and is reused on the issue
// branch (created: false, branchReused: true).
function fakeWorktreeResolver(path, { ok = true, error, created = false, branchReused = true } = {}) {
  const calls = [];
  return {
    calls,
    resolve(input) {
      calls.push(input);
      if (!ok) return { ok: false, error: error ?? 'resolve failed' };
      return { ok: true, path, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created, branchReused };
    },
  };
}

// Duck-typed IssueWorktreeLock: records acquire/release and returns a configurable
// acquire result so a held lock (concurrent execution) can be simulated.
function fakeLock(acquireResult = { ok: true, locked: true, contextId: 'run-review-1', sessionId: 'addon-dev' }) {
  const calls = { acquire: [], release: [] };
  return {
    calls,
    acquire(ownerId, sessionId, issueNumber) { calls.acquire.push({ ownerId, sessionId, issueNumber }); return acquireResult; },
    release(ownerId, sessionId, issueNumber) { calls.release.push({ ownerId, sessionId, issueNumber }); return { ok: true, released: true }; },
  };
}

// Every call site historically invoked `createReviewHandler(context, runner)`
// (occasionally with a 3rd/4th arg for a resolveRepoHost or worktree-specific
// test) and relied on the canonical-checkout path. Since #456/#699 removed
// that path, review always resolves a per-issue worktree and a real
// IssueWorktreeLock; tests that don't care about worktree/lock mechanics get
// deterministic fakes so `runner` only ever sees the git calls review.ts
// itself issues, not `resolveIssueWorktree`'s or `IssueWorktreeLock`'s
// internals. Tests that DO care about worktree resolution or lock behavior
// pass their own fakes as the 3rd/4th args, which this wrapper leaves
// untouched. `resolveRepoHost` (5th) and `phaseLockOwnerId` (6th) are plain
// pass-through — the real defaults from review.ts apply when omitted.
function createReviewHandler(context, runner, resolveWorktree, issueLock, resolveRepoHost, phaseLockOwnerId) {
  return _createReviewHandler(
    context,
    runner,
    resolveWorktree ?? fakeWorktreeResolver(worktreePath()).resolve,
    issueLock ?? fakeLock(),
    resolveRepoHost,
    phaseLockOwnerId,
  );
}

const SESSION = (overrides = {}) => ({
  sessionId: 'addon-dev',
  repoKey: 'test-repo',
  repoRoot,
  githubRepo: 'm2dw/test-repo',
  artifactDir: '.n8n-artifacts',
  artifactRoot,
  githubOwner: 'm2dw',
  githubName: 'test-repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  ...overrides,
});

const CONTEXT = (overrides = {}) => ({
  session: SESSION(),
  runId: 'run-review-1',
  workerId: 'worker-test',
  ...overrides,
});

function makeTask(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: 77,
    status: 'running',
    phase: 'review',
    priority: 'normal',
    reviewAgent: 'codex',
    attempts: {},
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      prUrl: 'https://github.com/m2dw/test-repo/pull/99',
      branch: 'ai/issue-77-run-impl-1',
      labels: ['agent:codex', 'status:needs-review'],
    },
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

// Multi-step runner: each call consumes one result.
// Happy-path order (worktree-only, issue #456/#699), for the common case — a
// task with BOTH branch and prUrl recorded, GitHub host, non-cross-repo PR,
// default fake worktree resolver (created: false, branchReused: true),
// session.environmentPrepare NOT configured:
//   gh-pr-view(0) fetch-base(1) rev-parse-branch-exists(2) pull-ff-only(3)
//   rev-list-count(4) status-preflight(5) diff-classification(6) npm-test(7)
//   codex-review(8) status-post-review(9)
function sequenceRunner(steps) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(cmd, args, opts) {
      const result = steps[i] ?? { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      calls.push({ cmd, args, opts, result });
      i++;
      return result;
    },
  };
}

// Default happy-path runner for the default `makeTask()` (branch:
// 'ai/issue-77-run-impl-1', prUrl: pull/99, GitHub host, codex agent).
function happyRunner() {
  return sequenceRunner([
    { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch, issue #447 P2)
    { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main (refresh review base)
    { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse --verify --quiet refs/heads/<branch> (LOCAL BRANCH EXISTS)
    { stdout: '', stderr: '', exitCode: 0 },              // git pull origin <branch> --ff-only (reconcile reused worktree branch with PR head)
    { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD (on the live PR head)
    { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
    { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-verification diff classification, issue #506)
    { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
    { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // codex review
    { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 5.5 post-review) — clean
  ]);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'review-handler-test-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe('review handler — artifacts', () => {
  test('creates artifact dir under artifactRoot/runs/<runId>', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-review-1'))).toBe(true);
  });

  test('writes review-context.json, review-output.md, review-result.json', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-review-1');
    expect(existsSync(join(dir, 'review-context.json'))).toBe(true);
    expect(existsSync(join(dir, 'review-output.md'))).toBe(true);
    expect(existsSync(join(dir, 'review-result.json'))).toBe(true);
  });

  test('writes verification log for each session.verification command', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-review-1');
    expect(existsSync(join(dir, 'review-verification-test.log'))).toBe(true);
  });

  test('review-context.json includes prUrl and branch', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const raw = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-context.json'), 'utf8');
    const ctx = JSON.parse(raw);
    expect(ctx).toMatchObject({ prUrl: 'https://github.com/m2dw/test-repo/pull/99', branch: 'ai/issue-77-run-impl-1' });
  });

  test('review-result.json marks success: true on happy path', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const raw = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-result.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ success: true });
  });

  test('artifacts written even when codex fails', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only (reconcile reused branch)
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test (verification passes)
      { stdout: '', stderr: 'codex error', exitCode: 1 },   // codex fails
    ]);
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-review-1', 'review-result.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Post-review worktree cleanup
// ---------------------------------------------------------------------------

describe('review handler — post-review worktree cleanup', () => {
  function dirtyAfterReviewRunner({ diffOutput = '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new', cleanupExitCode = 0 } = {}) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only (reconcile reused branch)
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status — clean (preflight)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '[P1] Missing null check', stderr: '', exitCode: 0 }, // codex review
      { stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 }, // git status — dirty after review
      { stdout: diffOutput, stderr: '', exitCode: 0 },   // git diff HEAD
      { stdout: '', stderr: '', exitCode: cleanupExitCode }, // git reset --hard HEAD
      { stdout: '', stderr: '', exitCode: 0 },            // git clean -fd
      // recheck: clean tree on successful cleanup, still dirty when cleanup failed
      { stdout: cleanupExitCode === 0 ? '' : ' M src/foo.ts\n', stderr: '', exitCode: 0 }, // git status — recheck
    ]);
  }

  test('runs git status after codex review to detect residue', async () => {
    const runner = dirtyAfterReviewRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const statusCalls = runner.calls.filter(c => c.cmd === 'git' && c.args[0] === 'status');
    expect(statusCalls).toHaveLength(3); // preflight + post-review + post-cleanup recheck
  });

  test('when dirty after review, runs git diff HEAD to capture residue', async () => {
    const runner = dirtyAfterReviewRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const diffCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('HEAD'));
    expect(diffCall).toBeDefined();
    expect(diffCall.args).toContain('HEAD');
  });

  test('when dirty after review, fully resets and cleans the worktree', async () => {
    const runner = dirtyAfterReviewRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const resetCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'reset');
    expect(resetCall).toBeDefined();
    expect(resetCall.args).toEqual(['reset', '--hard', 'HEAD']);
    const cleanCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'clean');
    expect(cleanCall).toBeDefined();
    expect(cleanCall.args).toEqual(['clean', '-fd']);
  });

  test('when dirty after review, writes review-residue.diff artifact', async () => {
    const runner = dirtyAfterReviewRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-review-1', 'review-residue.diff'))).toBe(true);
  });

  test('residue diff is included in needs_fix reviewFeedback', async () => {
    const runner = dirtyAfterReviewRunner({ diffOutput: '--- a/src/foo.ts\n+++ b/src/foo.ts\n-old\n+new' });
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewFeedback).toContain('[P1] Missing null check');
    expect(result.context?.reviewFeedback).toContain('Suggested Changes');
    expect(result.context?.reviewFeedback).toContain('+new');
  });

  test('reviewResidue is present in needs_fix context', async () => {
    const runner = dirtyAfterReviewRunner();
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(typeof result.context?.reviewResidue).toBe('string');
    expect(result.context?.reviewResidue.length).toBeGreaterThan(0);
  });

  test('when cleanup fails, returns blocked with reviewFeedback about dirty tree', async () => {
    const runner = dirtyAfterReviewRunner({ cleanupExitCode: 1 });
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/cleanup failed/);
    expect(result.context?.reviewFeedback).toMatch(/dirty working tree/);
    expect(result.context?.reviewFeedback).toContain('src/foo.ts');
  });

  test('when cleanup fails, returns blocked (not needs_fix) to avoid stuck loop', async () => {
    const runner = dirtyAfterReviewRunner({ cleanupExitCode: 1 });
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('when clean after review (happy path), no cleanup commands are issued', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const resetCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'reset');
    const cleanCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'clean');
    expect(resetCall).toBeUndefined();
    expect(cleanCall).toBeUndefined();
  });

  test('reviewResidue is absent from context when tree is clean after review', async () => {
    const runner = happyRunner();
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.context?.reviewResidue).toBeUndefined();
  });

  // environmentPrepare sentinel lifecycle (issue #522)
  //
  // Review cleanup (git clean -fd) may delete prepare-created untracked files
  // (e.g. node_modules/ not in .gitignore). The worktree-lifetime sentinel must
  // be cleared so the next phase re-runs prepare rather than relying on a stamp
  // that misrepresents the checkout state. When the tree is clean after review
  // (no git clean runs), the sentinel must be preserved so the next phase can skip.

  test('clears prepare sentinel after git clean during dirty review when environmentPrepare is enabled', async () => {
    // Create the WORKTREE's .git dir so the sentinel can be written by
    // ensureEnvironmentPrepared, which runs with cwd = the worktree path in
    // worktree-only mode (issue #699), not session.repoRoot.
    const wt = worktreePath();
    mkdirSync(join(wt, '.git'), { recursive: true });

    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only (reconcile reused branch)
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // echo ok (environmentPrepare — writes sentinel)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: '[P1] Missing null check', stderr: '', exitCode: 0 }, // codex review
      { stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 }, // git status (dirty after review)
      { stdout: '--- a/src/foo.ts\n+++ b/src/foo.ts', stderr: '', exitCode: 0 }, // git diff HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git reset --hard HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git clean -fd (would delete prepare files)
      { stdout: '', stderr: '', exitCode: 0 },              // git status (recheck — clean)
    ]);

    const session = SESSION({ environmentPrepare: { enabled: true, command: 'echo ok' } });
    await createReviewHandler(CONTEXT({ session }), runner)(makeTask());

    // Sentinel must be gone: clearPrepareSentinel was called after git clean so the
    // next phase re-runs prepare instead of skipping on a now-invalid stamp.
    expect(existsSync(join(wt, '.git', 'ai-env-prepared'))).toBe(false);
  });

  test('preserves prepare sentinel when review tree is clean after review', async () => {
    // Create the WORKTREE's .git dir so the sentinel can be written (cwd is the
    // worktree path in worktree-only mode, issue #699).
    const wt = worktreePath();
    mkdirSync(join(wt, '.git'), { recursive: true });

    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only (reconcile reused branch)
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // echo ok (environmentPrepare — writes sentinel)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // codex review — no findings
      { stdout: '', stderr: '', exitCode: 0 },              // git status (clean after review)
    ]);

    const session = SESSION({ environmentPrepare: { enabled: true, command: 'echo ok' } });
    await createReviewHandler(CONTEXT({ session }), runner)(makeTask());

    // Sentinel must still exist: no git clean ran, clearPrepareSentinel was not
    // called, so the next phase can skip prepare cheaply.
    expect(existsSync(join(wt, '.git', 'ai-env-prepared'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

describe('review handler — command execution', () => {
  // Replaces the pre-#456/#699 "uses session.repoRoot as cwd for all commands"
  // test: cwd is NO LONGER uniform across the whole call sequence — the handler
  // switches cwd from session.repoRoot to the per-issue worktree path partway
  // through (issue #456). The equivalent worktree-mode cwd-partitioning
  // assertions already live in the "per-issue worktree review (issue #456)"
  // describe block below (e.g. "runs review inside the per-issue worktree...").

  test('executes worktree-setup preflight in order: gh pr view -> fetch base -> rev-parse -> pull --ff-only -> rev-list -> git status', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(runner.calls[0]).toMatchObject({ cmd: 'gh', args: ['pr', 'view', '99', '--repo', 'm2dw/test-repo', '--json', expect.any(String)] });
    expect(runner.calls[1]).toMatchObject({ cmd: 'git', args: ['fetch', 'origin', '+main:refs/remotes/origin/main'] });
    expect(runner.calls[2]).toMatchObject({ cmd: 'git', args: ['rev-parse', '--verify', '--quiet', 'refs/heads/ai/issue-77-run-impl-1'] });
    expect(runner.calls[3]).toMatchObject({ cmd: 'git', args: ['pull', 'origin', 'ai/issue-77-run-impl-1', '--ff-only'] });
    expect(runner.calls[4]).toMatchObject({ cmd: 'git', args: ['rev-list', '--count', 'FETCH_HEAD..HEAD'] });
    expect(runner.calls[5]).toMatchObject({ cmd: 'git', args: ['status', '--porcelain'] });
  });

  test('uses PR number from prUrl to validate the recorded branch via gh pr view', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const ghCall = runner.calls[0];
    expect(ghCall.cmd).toBe('gh');
    expect(ghCall.args).toContain('99'); // extracted from pull/99
  });

  test('falls back to branch as selector when no prUrl (branch-only PR lookup)', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view <branch> (branch-only PR lookup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status (preflight)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (diff classification)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status (post-review)
    ]);
    const task = makeTask({ context: { branch: 'ai/issue-77-run-impl-1', prUrl: undefined, title: 'T' } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const ghCall = runner.calls[0];
    expect(ghCall.cmd).toBe('gh');
    // Branch is passed as the selector for the branch-only `gh pr view` lookup.
    expect(ghCall.args).toEqual(['pr', 'view', 'ai/issue-77-run-impl-1', '--repo', 'm2dw/test-repo', '--json', expect.any(String)]);
  });

  test('runs each session.verification command after preflight', async () => {
    const session = SESSION({ verification: { test: 'npm test', build: 'npm run build' } });
    const ctx = CONTEXT({ session });
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status (preflight)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'ok', stderr: '', exitCode: 0 }, // npm run build
      { stdout: 'lgtm', stderr: '', exitCode: 0 }, // codex
      { stdout: '', stderr: '', exitCode: 0 },              // git status (post-review)
    ]);
    await createReviewHandler(ctx, runner)(makeTask());
    const cmds = runner.calls.map(c => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds[7]).toContain('test');
    expect(cmds[8]).toContain('build');
  });

  test('invokes codex review with --base origin/main and --title', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const codexCall = runner.calls.find((c) => c.cmd === 'codex');
    expect(codexCall).toBeDefined();
    expect(codexCall.args).toContain('review');
    expect(codexCall.args).toContain('--base');
    // The worktree review diffs against the freshly-fetched origin/<base>, never
    // local main (a worktree session never advances local main; issue #456).
    expect(codexCall.args).toContain('origin/main');
    expect(codexCall.args).toContain('--title');
  });
});

// ---------------------------------------------------------------------------
// Dependency-started PR review base (issue #208, #242, #667)
//
// A dependency-started PR's branch was created from a blocker PR head, but a new
// dependency-started PR targets the session base branch (`main`) like any other
// PR (issue #228/#242) — that PR-merge-target concept is independent from the
// REVIEW DIFF BASE (issue #667): the branch was built on top of the blocker PR
// head, which is typically not yet merged into `main`, so diffing against `main`
// would review the whole cumulative stack (predecessor + current issue) as if it
// were all this issue's change. The review therefore diffs against the recorded
// predecessor head (`dependencyBase.baseHeadSha`), not `main`.
//
// The PR-merge-target safety check is unchanged: to stay safe for a PR created
// under the PRIOR stacked-base flow (whose live GitHub base may still be the
// blocker branch), the handler first queries the live `baseRefName` whenever
// `dependencyBase` metadata is present (Step 0). If the PR still targets the
// blocker branch — or the base cannot be confirmed — the review blocks for a
// human instead of approving a PR that would merge into the blocker branch and
// hide the dependent change from `main` (the #216/#217 trap, issue #242).
// ---------------------------------------------------------------------------

describe('review handler — dependency-started PR (issue #208, #242, #667)', () => {
  const BLOCKER_HEAD_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const DEP_BASE = {
    baseIssueNumber: 50,
    basePrNumber: 88,
    baseHeadRefName: 'ai/issue-50',
    basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
    // The exact predecessor commit the branch was built on (issue #667) — the
    // review diff base.
    baseHeadSha: BLOCKER_HEAD_SHA,
  };

  function stackedTask() {
    return makeTask({
      context: { ...makeTask().context, dependencyBase: DEP_BASE },
    });
  }

  // Happy sequence for a dependency-started PR whose live base is already `main`
  // and whose recorded predecessor head is an ancestor of HEAD. Worktree setup
  // (gh pr view branch-validation, fetch base, rev-parse, pull --ff-only,
  // rev-list) runs first (issue #456); the live-base check (`gh pr view --json
  // baseRefName`, Step 0) runs next, then the Step 1 dirty preflight, then the
  // dependency-review-base ancestry guard (`git cat-file` + `git merge-base
  // --is-ancestor`, Step 3.4), then the pre-verification diff classification,
  // verification, and the review agent.
  function stackedHappyRunner(liveBase = 'main') {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only (reconcile reused branch)
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: JSON.stringify({ baseRefName: liveBase }), stderr: '', exitCode: 0 }, // gh pr view --json baseRefName (Step 0, issue #242)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git cat-file -e <sha>^{commit} (Step 3.4, issue #667)
      { stdout: '', stderr: '', exitCode: 0 },              // git merge-base --is-ancestor <sha> HEAD (Step 3.4, issue #667)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (pre-verification diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
  }

  test('reviews against the recorded predecessor head, not the session base (issue #667)', async () => {
    const runner = stackedHappyRunner();
    await createReviewHandler(CONTEXT(), runner)(stackedTask());
    const codexCall = runner.calls.find(c => c.cmd === 'codex');
    expect(codexCall.args).toContain('--base');
    expect(codexCall.args).toContain(BLOCKER_HEAD_SHA);
    expect(codexCall.args).not.toContain('main');
  });

  test('the diff excludes predecessor commits: diffs <predecessor-head>...HEAD, never <session-base>...HEAD (issue #667)', async () => {
    const runner = stackedHappyRunner();
    await createReviewHandler(CONTEXT(), runner)(stackedTask());
    const diffCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'diff');
    expect(diffCall.args).toEqual(['diff', `${BLOCKER_HEAD_SHA}...HEAD`]);
    expect(diffCall.args).not.toContain('main...HEAD');
  });

  test('the PR still targets the session base even though the review diff base is the predecessor head (issue #667)', async () => {
    const runner = stackedHappyRunner();
    const result = await createReviewHandler(CONTEXT(), runner)(stackedTask());
    expect(result.result).toBe('success');
    // Step 0 confirmed the live PR base is the session base (`main`) — the PR
    // merge target and the review diff base are independently correct.
    const viewCall = runner.calls.find(c => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view');
    expect(viewCall).toBeDefined();
    const codexCall = runner.calls.find(c => c.cmd === 'codex');
    expect(codexCall.args).toContain(BLOCKER_HEAD_SHA);
  });

  test('queries the live PR base before reviewing', async () => {
    // A PR created under the prior stacked-base flow may still target the blocker
    // branch on GitHub. The handler confirms the live base is the session base
    // before reviewing (issue #242). Filter to the Step 0 baseRefName read
    // specifically — a SEPARATE `gh pr view` also runs during worktree setup to
    // validate the recorded branch (issue #456/#447 P2).
    const runner = stackedHappyRunner();
    await createReviewHandler(CONTEXT(), runner)(stackedTask());
    const viewCalls = runner.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('baseRefName'));
    expect(viewCalls).toHaveLength(1);
    expect(viewCalls[0].args).toContain('baseRefName');
    // The lookup must be scoped to the configured repo so a fork clone or a
    // remote/default mismatch cannot query the wrong repository and block a
    // valid dependency-started review as unconfirmable (issue #242 review).
    const repoIdx = viewCalls[0].args.indexOf('--repo');
    expect(repoIdx).toBeGreaterThanOrEqual(0);
    expect(viewCalls[0].args[repoIdx + 1]).toBe('m2dw/test-repo');
  });

  test('passing review returns success (normal handoff, not blocked)', async () => {
    const runner = stackedHappyRunner();
    const result = await createReviewHandler(CONTEXT(), runner)(stackedTask());
    expect(result.result).toBe('success');
  });

  test('blocks when the live PR base still targets the blocker branch', async () => {
    // The #216/#217 trap: a PR created under the prior stacked-base flow still
    // targets the blocker head. Reviewing it against `main` and marking it ready
    // would deliver the merge into the blocker branch and hide it from `main`.
    const runner = stackedHappyRunner('ai/issue-50');
    const result = await createReviewHandler(CONTEXT(), runner)(stackedTask());
    expect(result.result).toBe('blocked');
    expect(result.context?.livePrBase).toBe('ai/issue-50');
    expect(result.message).toContain('ai/issue-50');
    // The review must not proceed to codex once the live base is wrong.
    expect(runner.calls.find(c => c.cmd === 'codex')).toBeUndefined();
  });

  test('blocks when the live PR base cannot be confirmed', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: 'pr not found', exitCode: 1 }, // gh pr view --json baseRefName (Step 0) — fails
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(stackedTask());
    expect(result.result).toBe('blocked');
    expect(runner.calls.find(c => c.cmd === 'codex')).toBeUndefined();
  });

  test('a merge conflict routes to conflict resolution, not a human escalation', async () => {
    // Because the PR targets main, a conflict is a conflict against main, which
    // the conflict_resolution handler resolves by merging main into the PR branch.
    // The review returns `conflict` (routed to the resolver), not `blocked`
    // (issue #242). The review worktree is freed before the conflict handoff
    // (issue #456) so conflict_resolution can check out the branch.
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: JSON.stringify({ baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view --json baseRefName (Step 0)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git cat-file -e <sha>^{commit} (Step 3.4, issue #667)
      { stdout: '', stderr: '', exitCode: 0 },              // git merge-base --is-ancestor <sha> HEAD (Step 3.4, issue #667)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (pre-verification diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git worktree remove --force --force <path> (free review worktree, issue #456)
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(stackedTask());
    expect(result.result).toBe('conflict');
  });

  test('does not query the live PR base or fetch a predecessor ref for a non-dependency PR', async () => {
    // Step 0 (dependency-base live-check) and the Step 3.4 ancestry fallback fetch
    // are dependency-specific; the worktree setup's OWN base-refresh fetch and
    // branch-validation `gh pr view` (issue #456) still run for every review.
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const baseRefViewCalls = runner.calls.filter(c => c.cmd === 'gh' && c.args.includes('baseRefName'));
    expect(baseRefViewCalls).toHaveLength(0);
    const fetchCalls = runner.calls.filter(c => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].args).toEqual(['fetch', 'origin', '+main:refs/remotes/origin/main']);
  });

  test('missing dependencyBase.baseHeadSha blocks before any git or gh call (issue #667)', async () => {
    // Pre-#667 (or otherwise incomplete) dependency-start metadata carries no
    // recorded predecessor SHA. There is no durable start point to reproduce, so
    // the review must fail closed rather than silently fall back to a cumulative
    // diff against the session base.
    const legacyDepBase = {
      baseIssueNumber: 50, basePrNumber: 88,
      baseHeadRefName: 'ai/issue-50',
      basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
    };
    const task = makeTask({ context: { ...makeTask().context, dependencyBase: legacyDepBase } });
    const runner = sequenceRunner([]);
    const result = await createReviewHandler(CONTEXT(), runner)(task);
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/baseHeadSha/);
    expect(runner.calls).toHaveLength(0);
  });

  test('a recorded predecessor head that is not an ancestor of HEAD blocks instead of falling back to the session base (issue #667)', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: JSON.stringify({ baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view --json baseRefName (Step 0)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git cat-file -e <sha>^{commit}
      { stdout: '', stderr: '', exitCode: 1 },              // git merge-base --is-ancestor <sha> HEAD — NOT an ancestor
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(stackedTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toContain(BLOCKER_HEAD_SHA);
    expect(runner.calls.find(c => c.cmd === 'codex')).toBeUndefined();
  });

  test('fetches the recorded predecessor branch as a fallback when the commit is not already present locally (issue #667)', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: JSON.stringify({ baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view --json baseRefName (Step 0)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
      { stdout: '', stderr: 'fatal: not a valid object name', exitCode: 1 }, // git cat-file -e <sha>^{commit} — missing locally
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +ai/issue-50:refs/remotes/origin/ai/issue-50 — fallback
      { stdout: '', stderr: '', exitCode: 0 },              // git merge-base --is-ancestor <sha> HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (pre-verification diff classification)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(stackedTask());
    expect(result.result).toBe('success');
    const fetchCalls = runner.calls.filter(c => c.cmd === 'git' && c.args[0] === 'fetch');
    const fallbackFetch = fetchCalls.find(c => c.args.includes('+ai/issue-50:refs/remotes/origin/ai/issue-50'));
    expect(fallbackFetch).toBeDefined();
    expect(fallbackFetch.args).toEqual(['fetch', 'origin', '+ai/issue-50:refs/remotes/origin/ai/issue-50']);
  });
});

// ---------------------------------------------------------------------------
// Dependency review base — equivalent diff boundary across review agents
// (issue #667)
//
// Codex resolves its diff internally via `--base`; Claude and Gemini instead
// receive the diff text directly (in the prompt / stdin). All three must diff
// against the SAME dependency review base, not just Codex.
// ---------------------------------------------------------------------------

describe('review handler — dependency review base across agents (issue #667)', () => {
  const BLOCKER_HEAD_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const DEP_BASE = {
    baseIssueNumber: 50, basePrNumber: 88,
    baseHeadRefName: 'ai/issue-50',
    basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
    baseHeadSha: BLOCKER_HEAD_SHA,
  };
  function stackedDepTask(overrides = {}) {
    return makeTask({
      context: { ...makeTask().context, dependencyBase: DEP_BASE },
      ...overrides,
    });
  }

  test('claude receives a diff against the recorded predecessor head, not the session base', async () => {
    const session = SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'claude', researchAgent: 'gemini' } });
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: JSON.stringify({ baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view --json baseRefName (Step 0)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git cat-file -e <sha>^{commit} (Step 3.4)
      { stdout: '', stderr: '', exitCode: 0 },              // git merge-base --is-ancestor <sha> HEAD (Step 3.4)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (pre-verification classification)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (full diff for prompt)
      { stdout: 'No issues found.', stderr: '', exitCode: 0 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review cleanup)
    ]);
    const task = stackedDepTask({ reviewAgent: 'claude' });
    const result = await createReviewHandler(CONTEXT({ session }), runner)(task);
    expect(result.result).toBe('success');
    const diffCalls = runner.calls.filter(c => c.cmd === 'git' && c.args[0] === 'diff');
    expect(diffCalls.length).toBeGreaterThan(0);
    for (const call of diffCalls) {
      expect(call.args).toEqual(['diff', `${BLOCKER_HEAD_SHA}...HEAD`]);
    }
  });

  test('gemini receives a diff against the recorded predecessor head, not the session base', async () => {
    const session = SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'gemini', researchAgent: 'gemini' } });
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: JSON.stringify({ baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view --json baseRefName (Step 0)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git cat-file -e <sha>^{commit} (Step 3.4)
      { stdout: '', stderr: '', exitCode: 0 },              // git merge-base --is-ancestor <sha> HEAD (Step 3.4)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (pre-verification classification)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (full diff for prompt)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // agy --print
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review cleanup)
      { stdout: JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), stderr: '', exitCode: 0 }, // gh pr view (live mergeability)
    ]);
    const task = stackedDepTask({ reviewAgent: 'gemini' });
    const result = await createReviewHandler(CONTEXT({ session }), runner)(task);
    expect(result.result).toBe('success');
    const diffCalls = runner.calls.filter(c => c.cmd === 'git' && c.args[0] === 'diff');
    expect(diffCalls.length).toBeGreaterThan(0);
    for (const call of diffCalls) {
      expect(call.args).toEqual(['diff', `${BLOCKER_HEAD_SHA}...HEAD`]);
    }
  });
});

// ---------------------------------------------------------------------------
// Review input — issue/task requirement context (issue #174)
// ---------------------------------------------------------------------------

function titleArgOf(codexCall) {
  const i = codexCall.args.indexOf('--title');
  return i >= 0 ? codexCall.args[i + 1] : undefined;
}

describe('review handler — requirement context in review input', () => {
  test('--title carries the issue body under an Issue Requirements heading', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: { ...makeTask().context, body: 'Acceptance criteria: throttle login to 5 attempts/min per IP.' },
    });
    await createReviewHandler(CONTEXT(), runner)(task);
    const title = titleArgOf(runner.calls.find((c) => c.cmd === 'codex'));
    expect(title).toContain('## Issue Requirements');
    expect(title).toContain('Acceptance criteria: throttle login to 5 attempts/min per IP.');
  });

  test('--title carries issue number, title, url, labels and PR url', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const title = titleArgOf(runner.calls.find((c) => c.cmd === 'codex'));
    expect(title).toContain('Issue #77: Add login rate limiting');
    expect(title).toContain('https://github.com/m2dw/test-repo/issues/77');
    expect(title).toContain('status:needs-review');
    expect(title).toContain('https://github.com/m2dw/test-repo/pull/99');
  });

  test('--title instructs the reviewer to check requirement fit and code quality', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const title = titleArgOf(runner.calls.find((c) => c.cmd === 'codex'));
    expect(title).toMatch(/Requirement fit/i);
    expect(title).toMatch(/acceptance criteri/i);
    expect(title).toMatch(/code quality/i);
  });

  test('--title lists passing verification results', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const title = titleArgOf(runner.calls.find((c) => c.cmd === 'codex'));
    expect(title).toContain('## Verification Results');
    expect(title).toContain('- test: passed');
  });

  test('--title omits Issue Requirements heading when no body present', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const title = titleArgOf(runner.calls.find((c) => c.cmd === 'codex'));
    expect(title).not.toContain('## Issue Requirements');
  });

  test('writes review-prompt.md artifact containing the issue body', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: { ...makeTask().context, body: 'Must support OAuth refresh tokens.' },
    });
    await createReviewHandler(CONTEXT(), runner)(task);
    const promptPath = join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md');
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, 'utf8')).toContain('Must support OAuth refresh tokens.');
  });

  test('bounds an oversized issue body in the review input', async () => {
    const runner = happyRunner();
    const hugeBody = 'B'.repeat(20_000);
    const task = makeTask({ context: { ...makeTask().context, body: hugeBody } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const title = titleArgOf(runner.calls.find((c) => c.cmd === 'codex'));
    expect(title).toContain('…(issue body truncated for review context)');
    expect(title.length).toBeLessThan(hugeBody.length);
  });

  test('a review finding that misses an acceptance criterion is treated as needs_fix', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'The implementation does not satisfy acceptance criterion: per-IP rate limiting is missing.', stderr: '', exitCode: 0 }, // codex review
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.classification).toBe('needs_fix');
    expect(result.context?.hasBlockingFindings).toBe(true);
    expect(result.context?.reviewFeedback).toContain('acceptance criterion');
  });
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

describe('review handler — failure cases', () => {
  test('returns failed for unsupported agent without spawning', async () => {
    const runner = happyRunner();
    const ctx = CONTEXT({
      session: SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'gemini', researchAgent: 'gemini' } }),
    });
    const result = await createReviewHandler(ctx, runner)(makeTask({ reviewAgent: 'gpt4' }));
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Unsupported review agent/);
    expect(runner.calls).toHaveLength(0);
  });

  test('returns blocked when working tree is dirty, with reviewFeedback in context', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 }, // git status — dirty (Step 1 preflight)
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/dirty/);
    expect(result.message).toMatch(/escalating to human/i);
    expect(result.context?.reviewFeedback).toMatch(/uncommitted/);
    expect(result.context?.reviewFeedback).toContain('src/foo.ts');
    expect(runner.calls).toHaveLength(6);
  });

  test('returns failed when the PR head cannot be resolved from prUrl (gh pr view fails)', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: 'not found', exitCode: 1 }, // gh pr view (validate recorded branch) fails
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/not found/);
  });

  test('returns failed when no prUrl and no branch in context', async () => {
    const runner = happyRunner();
    const result = await createReviewHandler(CONTEXT(), runner)(
      makeTask({ context: { title: 'T' } }),
    );
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/No PR URL or branch/);
    // The review-admission preflight (issue #681) fires before any git/gh/agent call.
    expect(runner.calls).toHaveLength(0);
  });

  // issue #677: an unresolved implementation Tool Request handoff is authoritative
  // over whatever queued this review run (a mistaken admin recover, a stale
  // GitHub review label, etc.). This is a backstop — the normal entry points
  // already refuse to move such a task into review — but the review handler
  // must still refuse before touching the repo host, worktree, or agent.
  test('refuses to run review when the task carries an unresolved Tool Request', async () => {
    const runner = happyRunner();
    const result = await createReviewHandler(CONTEXT(), runner)(
      makeTask({
        context: {
          ...makeTask().context,
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-07T00:00:00.000Z',
            resolved: false,
          },
        },
      }),
    );
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/unresolved implementation Tool Request/i);
    // No git/gh/agent call was made — the guard fires before any side effect.
    expect(runner.calls).toHaveLength(0);
  });

  test('an already-resolved Tool Request does not block review', async () => {
    const result = await createReviewHandler(CONTEXT(), happyRunner())(
      makeTask({
        context: {
          ...makeTask().context,
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-07T00:00:00.000Z',
            resolved: true,
            resolution: { action: 'manual-done', resolvedAt: '2026-06-07T00:05:00.000Z' },
          },
        },
      }),
    );
    expect(result.result).not.toBe('failed');
  });

  // Coverage for a dependency-started task (continuation base is another issue's
  // branch/PR, via context.dependencyBase) that also carries an unresolved Tool
  // Request: the Tool Request guard must fire before the dependency-base live
  // check, since neither the repo host nor any dependency metadata should be
  // consulted while the handoff is still unresolved.
  test('refuses a dependency-started task with an unresolved Tool Request before the dependency-base check', async () => {
    const runner = happyRunner();
    const result = await createReviewHandler(CONTEXT(), runner)(
      makeTask({
        context: {
          ...makeTask().context,
          dependencyBase: {
            baseIssueNumber: 50, basePrNumber: 88,
            baseHeadRefName: 'ai/issue-50',
            basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
            baseHeadSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          },
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-07T00:00:00.000Z',
            resolved: false,
          },
        },
      }),
    );
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/unresolved implementation Tool Request/i);
    expect(runner.calls).toHaveLength(0);
  });

  test('returns needs_fix when verification fails, with reviewFeedback in context', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-verification, issue #506)
      { stdout: '', stderr: '3 tests failed', exitCode: 1 }, // npm test fails
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.message).toMatch(/Verification 'test' failed/);
    expect(result.context?.reviewFeedback).toContain("Verification 'test' failed");
    expect(result.context?.reviewFeedback).toContain('3 tests failed');
    expect(result.context?.verificationFailure).toMatchObject({ name: 'test', exitCode: 1 });
    expect(result.context?.verificationFailedStep).toBe('test');
  });

  test('reviewFeedback from verification failure is bounded to 20000 chars', async () => {
    const largeVerOutput = 'Error: ' + 'y'.repeat(25_000);
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-verification, issue #506)
      { stdout: largeVerOutput, stderr: '', exitCode: 1 }, // npm test fails with large output
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewFeedback.length).toBeLessThanOrEqual(20_100);
    expect(result.context?.reviewFeedback).toContain('…(truncated for storage)');
    expect(result.context?.reviewFeedback).toContain("Verification 'test' failed");
  });

  test('returns failed when codex review fails', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: '', stderr: 'codex: timeout', exitCode: 1 }, // codex fails
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/codex: timeout/);
  });
});

// ---------------------------------------------------------------------------
// Review-admission preflight (issue #681)
//
// A single check gates entry into the handler before any side effect — repo-
// host resolve, worktree lock/materialization, artifact writes, or the review
// agent invocation. It requires durable evidence, computable from
// `task.context` alone, that the task is actually ready for review: no
// unresolved Tool Request (issue #677, covered above), a durable PR reference
// with a resolvable head, and — for a dependency-started task — the
// predecessor review-base metadata (issue #667, covered in the
// "dependency-started PR" describe block below with its own
// `missing dependencyBase.baseHeadSha` case). This block covers the
// remaining PR-reference cases plus the "still reaches the handler
// unchanged" happy path.
// ---------------------------------------------------------------------------

describe('review handler — review admission (issue #681)', () => {
  test('fails before any side effect when the recorded PR reference cannot be resolved to a PR number and no branch is recorded', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: { ...makeTask().context, prUrl: 'https://github.com/m2dw/test-repo/not-a-pr-link', branch: undefined },
    });
    const result = await createReviewHandler(CONTEXT(), runner)(task);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/does not resolve to a PR number/);
    expect(runner.calls).toHaveLength(0);
  });

  test('a recorded branch is enough to admit review even when prUrl is absent', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: { ...makeTask().context, prUrl: undefined, branch: 'ai/issue-77' },
    });
    const result = await createReviewHandler(CONTEXT(), runner)(task);
    // Admission passes; the run proceeds into the handler's normal worktree-setup
    // logic exactly as it did before issue #681 and completes the full sequence.
    expect(result.result).toBe('success');
    expect(runner.calls).toHaveLength(10);
  });

  test('a valid implementation-complete PR (prUrl + branch, no unresolved Tool Request) reaches the existing review handler unchanged', async () => {
    const runner = happyRunner();
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('success');
    // The full happy-path sequence (gh pr view, fetch, rev-parse, pull, rev-list,
    // status, diff classification, verification, review agent, post-review status)
    // still runs — admission did not short-circuit a valid task.
    expect(runner.calls).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Quota/rate-limit delay (issue #672 — applies the shared category/retry
// policy to the review handler)
// ---------------------------------------------------------------------------

describe('review handler — quota delay (issue #672)', () => {
  test('a rate-limit diagnostic from the review agent delays the retry with category metadata', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: '', stderr: 'Error: HTTP 429 too many requests', exitCode: 1 }, // codex — rate-limited
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('delayed');
    expect(result.category).toBe('rate_limit');
    expect(result.context.category).toBe('rate_limit');
    expect(result.retryAfterMs).toBeLessThan(60 * 60 * 1000);
    expect(result.message).toMatch(/rate limit/i);
    expect(result.message).not.toMatch(/usage quota/i);
  });

  test('a usage-quota diagnostic gets the long reset-oriented delay and usage-quota wording', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: '', stderr: "You've hit your usage limit. Try again later.", exitCode: 1 }, // codex — usage quota
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('delayed');
    expect(result.category).toBe('usage_quota');
    // usage_quota must NOT set a handler-level retryAfterMs override — doing so
    // would bypass a caller's configured quotaRetryDelayMs at the runner (issue
    // #672 review). The long, reset-oriented delay comes from the runner itself.
    expect(result.retryAfterMs).toBeUndefined();
    expect(result.message).toMatch(/usage quota/i);
  });
});

// ---------------------------------------------------------------------------
// Result and transition
// ---------------------------------------------------------------------------

describe('review handler — result classification', () => {
  // Shared worktree-setup + preflight + pre-verification diff-classification
  // preamble for tests in this block that only care about the review AGENT's
  // output/classification, not the specific worktree-resolution mechanics.
  // Followed by one verification-command result and then the review agent's
  // canned output.
  function codexPreamble() {
    return [
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-verification diff classification, issue #506)
    ];
  }

  // happyRunner codex stdout: 'No P1/P2 findings.' -> classifies as success
  test('clean codex output -> result: success', async () => {
    const result = await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    expect(result.result).toBe('success');
  });

  test('context includes prUrl and artifactDir', async () => {
    const result = await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    expect(result.context?.prUrl).toBe('https://github.com/m2dw/test-repo/pull/99');
    expect(result.context?.artifactDir).toContain('run-review-1');
  });

  test('context includes classification details', async () => {
    const result = await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    expect(result.context?.classification).toBe('success');
    expect(result.context?.hasBlockingFindings).toBe(false);
  });

  test('[P1] finding in codex output -> result: needs_fix with reviewFeedback in context', async () => {
    const runner = sequenceRunner([
      ...codexPreamble(),
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '[P1] Null pointer in auth handler', stderr: '', exitCode: 0 }, // codex review
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    // needs_fix now returns result: "needs_fix" and captures review output
    expect(result.result).toBe('needs_fix');
    expect(result.context?.classification).toBe('needs_fix');
    expect(result.context?.hasBlockingFindings).toBe(true);
    expect(typeof result.context?.reviewFeedback).toBe('string');
    expect(result.context?.reviewFeedback).toContain('[P1] Null pointer in auth handler');
  });

  test('reviewFeedback is bounded to 20000 chars when review output is very large', async () => {
    const largeOutput = '[P1] ' + 'x'.repeat(25_000);
    const runner = sequenceRunner([
      ...codexPreamble(),
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: largeOutput, stderr: '', exitCode: 0 }, // codex review
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(typeof result.context?.reviewFeedback).toBe('string');
    expect(result.context?.reviewFeedback.length).toBeLessThanOrEqual(20_100); // bound + truncation suffix
    expect(result.context?.reviewFeedback).toContain('…(truncated for storage)');
    expect(result.context?.reviewFeedback).toContain('[P1] ');
  });

  test('needs_fix result includes reviewOutputPath', async () => {
    const runner = sequenceRunner([
      ...codexPreamble(),
      { stdout: 'ok', stderr: '', exitCode: 0 }, // npm test
      { stdout: '[P2] Missing input validation', stderr: '', exitCode: 0 }, // codex review
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(typeof result.context?.reviewOutputPath).toBe('string');
    expect(result.context?.reviewOutputPath).toContain('review-output.md');
  });

  test('real Git conflict output -> result: conflict (routes to conflict-resolution lane)', async () => {
    const runner = sequenceRunner([
      ...codexPreamble(),
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git worktree remove --force --force <path> (free review worktree, issue #456)
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    // A real merge conflict routes to the conflict-resolution lane, not a human.
    expect(result.result).toBe('conflict');
    expect(result.context?.classification).toBe('conflict');
    expect(result.context?.hasConflictSignal).toBe(true);
  });

  test('conflict with staged/untracked residue resets+cleans before queuing resolver', async () => {
    // The review agent reports a conflict AND leaves staged + untracked residue.
    // The downstream conflict-resolution handler rejects any dirty worktree, so
    // the cleanup must fully reset and clean before returning `conflict`. The
    // review worktree is then freed before the conflict handoff (issue #456).
    const runner = sequenceRunner([
      ...codexPreamble(),
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // codex review
      { stdout: 'A  staged.ts\n?? untracked.ts\n', stderr: '', exitCode: 0 }, // git status — dirty residue
      { stdout: 'diff --git a/staged.ts', stderr: '', exitCode: 0 }, // git diff HEAD
      { stdout: '', stderr: '', exitCode: 0 },           // git reset --hard HEAD
      { stdout: '', stderr: '', exitCode: 0 },           // git clean -fd
      { stdout: '', stderr: '', exitCode: 0 },           // git status — recheck (clean)
      { stdout: '', stderr: '', exitCode: 0 },           // git worktree remove --force --force <path> (free review worktree, issue #456)
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('conflict');
    const resetCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'reset');
    expect(resetCall?.args).toEqual(['reset', '--hard', 'HEAD']);
    const cleanCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'clean');
    expect(cleanCall?.args).toEqual(['clean', '-fd']);
  });

  test('review output that merely discusses merge conflicts is reviewed normally (issue #168)', async () => {
    const runner = sequenceRunner([
      ...codexPreamble(),
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      {
        stdout: [
          'review handler — result classification › merge conflict in codex output -> result: blocked',
          'Expected: "blocked"',
          'Received: "conflict"',
          'phase: "conflict_resolution"',
          'Otherwise the change looks correct. LGTM.',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    // Generic conflict-related prose must NOT escalate as a real merge conflict.
    expect(result.context?.classification).not.toBe('conflict');
    expect(result.context?.hasConflictSignal).toBe(false);
  });

  test('empty codex output -> result: blocked', async () => {
    const runner = sequenceRunner([
      ...codexPreamble(),
      { stdout: 'ok', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 }, // empty codex output
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('review-result.json persists classification details', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const raw = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-result.json'), 'utf8');
    const r = JSON.parse(raw);
    expect(r).toMatchObject({ classification: 'success', hasBlockingFindings: false, success: true });
  });

  test('[P2] finding persisted in review-result.json', async () => {
    const runner = sequenceRunner([
      ...codexPreamble(),
      { stdout: 'ok', stderr: '', exitCode: 0 }, // npm test
      { stdout: '[P2] missing input validation', stderr: '', exitCode: 0 }, // codex review
    ]);
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const raw = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-result.json'), 'utf8');
    const r = JSON.parse(raw);
    expect(r).toMatchObject({ classification: 'needs_fix', hasBlockingFindings: true });
  });
});

describe('review handler — phase transition', () => {
  let store;

  beforeEach(() => {
    store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
  });

  test('successful review transitions to ready_for_human', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 77, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      // A recorded branch keeps this on the common (non-synthetic) worktree path,
      // matching happyRunner()'s call sequence — matters only for the fixture, not
      // for the phase-transition behavior this test actually pins down.
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/99', branch: 'ai/issue-77-run-impl-1', title: 'T' },
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT(), happyRunner()) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'ready_for_human', phase: 'review' });
  });

  test('needs_fix review transitions task to queued implementation (auto-requeue)', async () => {
    const needsFixRunner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-78', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-78', stderr: '', exitCode: 0 },   // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: '[P1] Critical security vulnerability in auth', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);

    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 78, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/99', branch: 'ai/issue-78', title: 'T' },
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT({ session: SESSION() }), needsFixRunner) },
    });

    expect(outcome.status).toBe('completed');
    // needs_fix -> queued implementation (auto-requeue)
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'implementation' });
    expect(outcome.result.context?.classification).toBe('needs_fix');
    // reviewFeedback captured in task context for the next implementation run
    expect(typeof outcome.task.context?.reviewFeedback).toBe('string');
    expect(outcome.task.context?.reviewFeedback).toContain('[P1]');
  });

  test('task context preserves reviewFeedback for the next implementation run', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 100, url: 'https://github.com/m2dw/test-repo/pull/100', headRefName: 'ai/issue-80', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-80', stderr: '', exitCode: 0 },   // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: '[P1] Null pointer dereference in login()', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);

    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 80, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/100', branch: 'ai/issue-80', title: 'Fix login' },
    });

    await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-r1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT({ session: SESSION() }), runner) },
    });

    // The task is now queued for implementation — fetch it and check context
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 80 });
    expect(task?.status).toBe('queued');
    expect(task?.phase).toBe('implementation');
    expect(task?.context?.reviewFeedback).toContain('[P1] Null pointer dereference');
    // Previous context (prUrl) should still be present
    expect(task?.context?.prUrl).toBe('https://github.com/m2dw/test-repo/pull/100');
  });

  test('conflict review queues the conflict-resolution phase (resolver runs next, not a human)', async () => {
    const conflictRunner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-79', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-79', stderr: '', exitCode: 0 },   // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git worktree remove --force --force <path> (free review worktree, issue #456)
    ]);

    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 79, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/99', branch: 'ai/issue-79', title: 'T' },
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT({ session: SESSION() }), conflictRunner) },
    });

    expect(outcome.status).toBe('completed');
    // conflict -> queued conflict_resolution (the resolver runs next, not a human)
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'conflict_resolution' });
    expect(outcome.result.result).toBe('conflict');
    expect(outcome.result.context?.classification).toBe('conflict');
  });

  test('verification failure transitions task to queued implementation (auto-requeue)', async () => {
    const verFailRunner = sequenceRunner([
      { stdout: JSON.stringify({ number: 101, url: 'https://github.com/m2dw/test-repo/pull/101', headRefName: 'ai/issue-81', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-81', stderr: '', exitCode: 0 },   // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-verification, issue #506)
      { stdout: '', stderr: '5 tests failed\nAssertionError: expected true', exitCode: 1 }, // npm test fails
    ]);

    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 81, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/101', branch: 'ai/issue-81', title: 'Fix auth' },
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-vf', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT({ session: SESSION() }), verFailRunner) },
    });

    expect(outcome.status).toBe('completed');
    // verification failure -> needs_fix -> queued implementation
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'implementation' });
    expect(outcome.result.context?.verificationFailedStep).toBe('test');
    expect(typeof outcome.task.context?.reviewFeedback).toBe('string');
    expect(outcome.task.context?.reviewFeedback).toContain("Verification 'test' failed");
    expect(outcome.task.context?.reviewFeedback).toContain('5 tests failed');
    // Previous context (prUrl) should still be present
    expect(outcome.task.context?.prUrl).toBe('https://github.com/m2dw/test-repo/pull/101');
  });

  test('failed review transitions task to failed status', async () => {
    const failRunner = sequenceRunner([
      { stdout: '', stderr: 'checkout error', exitCode: 1 }, // gh pr view (resolve PR head to materialize the worktree) fails
    ]);

    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 77, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/99', title: 'T' },
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT(), failRunner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'failed' });
    expect(outcome.task.lastError).toMatch(/checkout error/);
  });

  test('dependency-started PR: passing review transitions to ready_for_human (issue #233 — replaces #216/#227 stacked scenario)', async () => {
    // Replacement for the #216/#227 scenario: issue B is dependent on blocker A.
    // B's PR targets main (not the blocker branch). After the live-base check
    // confirms main, the review succeeds and the task becomes ready_for_human.
    // The task must NOT be held blocked merely because dependencyBase is present.
    const DEP_BASE = {
      baseIssueNumber: 50, basePrNumber: 88,
      baseHeadRefName: 'ai/issue-50',
      basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
      baseHeadSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };

    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 91, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/110', branch: 'ai/issue-91', title: 'Dep', dependencyBase: DEP_BASE },
    });

    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 110, url: 'https://github.com/m2dw/test-repo/pull/110', headRefName: 'ai/issue-91', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-91', stderr: '', exitCode: 0 },   // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: JSON.stringify({ baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view --json baseRefName (Step 0, live-base check)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git cat-file -e <sha>^{commit} (Step 3.4, issue #667)
      { stdout: '', stderr: '', exitCode: 0 },              // git merge-base --is-ancestor <sha> HEAD (Step 3.4, issue #667)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (pre-verification diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-dep-review', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT(), runner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'ready_for_human', phase: 'review' });
  });

  test('dependency metadata alone does not suppress ready_for_human — no blocker merge/rebase proof required (issue #233 anti-regression guard)', async () => {
    // Guard against reintroducing VCS-like blocker merge/rebase proof logic.
    // The blocker PR (basePrNumber: 88) is intentionally still open. The system
    // must not gate on its merge status or require ancestry proofs. The
    // sequenceRunner provides exactly the calls for a normal dependency-started
    // review; an extra gh call for blocker state would exhaust the sequence and
    // return exitCode:1, causing the review to fail rather than hand off.
    const DEP_BASE = {
      baseIssueNumber: 50, basePrNumber: 88,
      baseHeadRefName: 'ai/issue-50',
      basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
      baseHeadSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };

    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 92, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/111', branch: 'ai/issue-92', title: 'Dep guard', dependencyBase: DEP_BASE },
    });

    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 111, url: 'https://github.com/m2dw/test-repo/pull/111', headRefName: 'ai/issue-92', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch, worktree setup)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-92', stderr: '', exitCode: 0 },   // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: JSON.stringify({ baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view --json baseRefName (Step 0, live-base check)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (Step 1 preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git cat-file -e <sha>^{commit} (Step 3.4, issue #667)
      { stdout: '', stderr: '', exitCode: 0 },              // git merge-base --is-ancestor <sha> HEAD (Step 3.4, issue #667)
      { stdout: '', stderr: '', exitCode: 0 },              // git diff <sha>...HEAD (pre-verification diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-dep-guard', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT(), runner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');
    // Only two gh calls expected: gh pr view (validate recorded branch) + gh pr
    // view (Step 0 live-base check). Any extra call for blocker merge/ancestry
    // proof would be caught above (failed review, unconsumed sequence slot).
    const ghCalls = runner.calls.filter(c => c.cmd === 'gh');
    expect(ghCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Review loop cap — effort escalation and human handoff
// ---------------------------------------------------------------------------

describe('review handler — review loop cap', () => {
  function needsFixRunner() {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: '[P1] Critical bug in auth handler', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
  }

  test('first needs_fix increments reviewCycles to 1 in result context', async () => {
    const result = await createReviewHandler(CONTEXT(), needsFixRunner())(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewCycles).toBe(1);
  });

  test('ninth needs_fix (reviewCycles=8) sets escalatedEffort: "high" in context (maxCycles=10)', async () => {
    const task = makeTask({ context: { ...makeTask().context, reviewCycles: 8 } });
    const result = await createReviewHandler(CONTEXT(), needsFixRunner())(task);
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewCycles).toBe(9);
    expect(result.context?.escalatedEffort).toBe('high');
  });

  test('tenth needs_fix (reviewCycles=9) hits cap, returns blocked with cap metadata (maxCycles=10)', async () => {
    const task = makeTask({ context: { ...makeTask().context, reviewCycles: 9 } });
    const result = await createReviewHandler(CONTEXT(), needsFixRunner())(task);
    expect(result.result).toBe('blocked');
    expect(result.context?.reviewLoopCapReached).toBe(true);
    expect(result.context?.reviewCycles).toBe(10);
    expect(result.context?.reviewLoopMaxCycles).toBe(10);
  });

  test('cap-reached result message describes cycle count', async () => {
    const task = makeTask({ context: { ...makeTask().context, reviewCycles: 9 } });
    const result = await createReviewHandler(CONTEXT(), needsFixRunner())(task);
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/10\/10/);
    expect(result.message).toMatch(/escalating to human/i);
  });

  test('first needs_fix does NOT set escalatedEffort (below escalation threshold)', async () => {
    const result = await createReviewHandler(CONTEXT(), needsFixRunner())(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.escalatedEffort).toBeUndefined();
  });

  test('custom maxCycles=2 caps on second needs_fix', async () => {
    const session = SESSION({ reviewLoop: { maxCycles: 2 } });
    const ctx = CONTEXT({ session });
    const task = makeTask({ context: { ...makeTask().context, reviewCycles: 1 } });
    const result = await createReviewHandler(ctx, needsFixRunner())(task);
    expect(result.result).toBe('blocked');
    expect(result.context?.reviewLoopCapReached).toBe(true);
    expect(result.context?.reviewCycles).toBe(2);
    expect(result.context?.reviewLoopMaxCycles).toBe(2);
  });

  test('custom maxCycles=2 sets escalatedEffort on first needs_fix', async () => {
    const session = SESSION({ reviewLoop: { maxCycles: 2 } });
    const ctx = CONTEXT({ session });
    const result = await createReviewHandler(ctx, needsFixRunner())(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.escalatedEffort).toBe('high');
    expect(result.context?.reviewCycles).toBe(1);
  });

  test('cap-reached preserves reviewFeedback in context', async () => {
    const task = makeTask({ context: { ...makeTask().context, reviewCycles: 9 } });
    const result = await createReviewHandler(CONTEXT(), needsFixRunner())(task);
    expect(result.result).toBe('blocked');
    expect(typeof result.context?.reviewFeedback).toBe('string');
    expect(result.context?.reviewFeedback).toContain('[P1] Critical bug in auth handler');
  });

  test('cap-reached carries diffClassification in blocked context (issue #506)', async () => {
    const task = makeTask({ context: { ...makeTask().context, reviewCycles: 9 } });
    const result = await createReviewHandler(CONTEXT(), needsFixRunner())(task);
    expect(result.result).toBe('blocked');
    expect(result.context?.reviewLoopCapReached).toBe(true);
    // diffClassification must be present so the human-handoff PR summary can
    // render the file/guardrail sections instead of showing them as unavailable.
    expect(result.context?.diffClassification).toBeDefined();
    expect(typeof result.context?.diffClassification).toBe('object');
  });
});

describe('review handler — loop cap on verification failure', () => {
  function verFailRunner() {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-verification, issue #506)
      { stdout: '', stderr: '5 tests failed', exitCode: 1 }, // verification fails
    ]);
  }

  test('verification failure at cap returns blocked with cap metadata', async () => {
    const task = makeTask({ context: { ...makeTask().context, reviewCycles: 9 } });
    const result = await createReviewHandler(CONTEXT(), verFailRunner())(task);
    expect(result.result).toBe('blocked');
    expect(result.context?.reviewLoopCapReached).toBe(true);
    expect(result.context?.reviewCycles).toBe(10);
  });

  test('verification failure below cap returns needs_fix with incremented reviewCycles', async () => {
    const result = await createReviewHandler(CONTEXT(), verFailRunner())(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewCycles).toBe(1);
  });
});

describe('review handler — phase transition with loop cap', () => {
  let store;

  beforeEach(() => {
    store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
  });

  test('cap-reached blocked result transitions task to ready_for_human', async () => {
    const capRunner = sequenceRunner([
      { stdout: JSON.stringify({ number: 102, url: 'https://github.com/m2dw/test-repo/pull/102', headRefName: 'ai/issue-82', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-82', stderr: '', exitCode: 0 },   // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: '[P1] Still failing after retries', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);

    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 82, phase: 'review',
      reviewAgent: 'codex', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/102', branch: 'ai/issue-82', title: 'Fix', reviewCycles: 9 },
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-cap-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(CONTEXT({ session: SESSION() }), capRunner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'ready_for_human', phase: 'review' });
    expect(outcome.task.context?.reviewLoopCapReached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolved agent profile metadata
// ---------------------------------------------------------------------------

describe('review handler — resolved profile metadata', () => {
  const dir = () => join(artifactRoot, 'runs', 'run-review-1');

  test('review-context.json contains resolvedProfile with phase and agentId', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'review', agentId: 'codex', cmd: 'codex' });
  });

  test('review-context.json resolvedProfile records modelSource as cli-default', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.modelSource).toBe('cli-default');
  });

  test('review-context.json resolvedProfile argv excludes --title value (prompt content)', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    const argv = ctx.resolvedProfile.argv;
    expect(argv).toContain('review');
    expect(argv).toContain('--base');
    // --title value (review brief) must not appear in sanitized argv
    const argvStr = argv.join(' ');
    expect(argvStr).not.toContain('Issue Requirements');
    expect(argvStr).not.toContain('Review Instructions');
  });

  test('resolvedProfile is available on an early worktree-setup failure even though review-context.json is not written yet', async () => {
    // Fail on the very first worktree-setup call (gh pr view, resolving the PR
    // head) — before the worktree materializes and before codex runs. The
    // artifact dir (and review-context.json inside it) is now created AFTER
    // worktree materialization (issue #729 review, P1 — mirrors the
    // implementation handler's issue #732 fix), so an early failure like this
    // one must mark the artifact dir pending rather than pre-create it: doing
    // so eagerly would leave a non-empty directory at the worktree's future
    // path and make `git worktree add` refuse to materialize it on retry. The
    // resolvedProfile is still surfaced via the returned context, not the file.
    const earlyFailRunner = sequenceRunner([
      { stdout: '', stderr: 'no such pr', exitCode: 1 }, // gh pr view — fails
    ]);
    const result = await createReviewHandler(CONTEXT(), earlyFailRunner)(makeTask());
    expect(result.result).toBe('failed');
    expect(result.context?.artifactDirPending).toBe(true);
    expect(existsSync(join(dir(), 'review-context.json'))).toBe(false);
    expect(result.context?.resolvedProfile).toMatchObject({ phase: 'review', agentId: 'codex' });
  });

  test('resolvedProfile includes reviewStrength and reviewStrengthSource', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.reviewStrength).toBeDefined();
    expect(ctx.resolvedProfile.reviewStrengthSource).toBeDefined();
  });

  test('no relevant labels -> reviewStrength: default, reviewStrengthSource: default', async () => {
    await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ reviewStrength: 'default', reviewStrengthSource: 'default' });
  });

  test('complexity:high label -> reviewStrength: high, reviewStrengthSource: complexity', async () => {
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'complexity:high'] } });
    await createReviewHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ reviewStrength: 'high', reviewStrengthSource: 'complexity' });
  });

  test('review:medium label + complexity:high -> reviewStrength: default, reviewStrengthSource: label (label wins)', async () => {
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'complexity:high', 'review:medium'] } });
    await createReviewHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ reviewStrength: 'default', reviewStrengthSource: 'label' });
  });

  // Codex has no xhigh reasoning tier, so complexity:xhigh derives the strongest
  // Codex-supported strength ('high') — the review ceiling, not a silent
  // downgrade of an explicit review label (issue #243).
  test('complexity:xhigh label -> reviewStrength: high, reviewStrengthSource: complexity (Codex ceiling)', async () => {
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'complexity:xhigh'] } });
    await createReviewHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ reviewStrength: 'high', reviewStrengthSource: 'complexity' });
  });

  // review:xhigh is intentionally unsupported (Codex model_reasoning_effort only
  // accepts low/medium/high). It must NOT be silently mapped to high; on its own
  // it has no effect and the strength stays default (issue #243 non-goal).
  test('review:xhigh label alone -> reviewStrength: default (unsupported, not mapped to high)', async () => {
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:xhigh'] } });
    await createReviewHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ reviewStrength: 'default', reviewStrengthSource: 'default' });
  });
});

// ---------------------------------------------------------------------------
// Review strength — Codex CLI argument passthrough
// ---------------------------------------------------------------------------

describe('review handler — review strength Codex CLI args', () => {
  // codex call is always at index 8 in the worktree-only happy-path runner
  // sequence: gh-pr-view(0) fetch(1) rev-parse(2) pull(3) rev-list(4)
  // status(5) diff-classification(6) npm-test(7) codex(8).
  const CODEX_IDX = 8;

  // Issue #609: every review now passes an explicit model_reasoning_effort,
  // independent of the operator's global Codex CLI config. No label -> high,
  // mirroring Claude's own review default (resolveClaudeReviewProfile).
  test('no review or complexity label -> codex receives -c model_reasoning_effort=high (deterministic default)', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const codexCall = runner.calls[CODEX_IDX];
    expect(codexCall.args).toContain('-c');
    expect(codexCall.args.join(' ')).toContain('model_reasoning_effort=high');
  });

  test('complexity:high label -> codex receives -c model_reasoning_effort=high', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'complexity:high'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    const argStr = codexCall.args.join(' ');
    expect(argStr).toContain('-c');
    expect(argStr).toContain('model_reasoning_effort=high');
  });

  test('complexity:low label -> codex receives -c model_reasoning_effort=low', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'complexity:low'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    const argStr = codexCall.args.join(' ');
    expect(argStr).toContain('-c');
    expect(argStr).toContain('model_reasoning_effort=low');
  });

  test('review:high label -> codex receives -c model_reasoning_effort=high', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:high'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    const argStr = codexCall.args.join(' ');
    expect(argStr).toContain('model_reasoning_effort=high');
  });

  test('review:low label -> codex receives -c model_reasoning_effort=low', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:low'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    const argStr = codexCall.args.join(' ');
    expect(argStr).toContain('model_reasoning_effort=low');
  });

  // Issue #609: review:medium now always requests an explicit medium effort
  // instead of silently falling through to the CLI's own global default.
  test('review:medium label -> codex receives -c model_reasoning_effort=medium', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:medium'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    expect(codexCall.args.join(' ')).toContain('model_reasoning_effort=medium');
  });

  test('review:medium + complexity:high -> model_reasoning_effort=medium (label beats complexity)', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:medium', 'complexity:high'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    expect(codexCall.args.join(' ')).toContain('model_reasoning_effort=medium');
  });

  test('review:low + complexity:high -> model_reasoning_effort=low (explicit label overrides complexity)', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:low', 'complexity:high'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    expect(codexCall.args.join(' ')).toContain('model_reasoning_effort=low');
  });

  test('complexity:xhigh -> codex receives model_reasoning_effort=high (never xhigh)', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'complexity:xhigh'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    const argStr = codexCall.args.join(' ');
    expect(argStr).toContain('model_reasoning_effort=high');
    // Codex never receives xhigh — it is not a valid model_reasoning_effort value.
    expect(argStr).not.toContain('model_reasoning_effort=xhigh');
  });

  // review:xhigh alone is still not a recognized review label (unsupported —
  // Codex has no xhigh tier), so it falls through to the no-label default —
  // which issue #609 now resolves explicitly to `high` rather than omitting
  // the flag.
  test('review:xhigh alone -> falls through to the no-label default: model_reasoning_effort=high', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:xhigh'] } });
    await createReviewHandler(CONTEXT(), runner)(task);
    const codexCall = runner.calls[CODEX_IDX];
    expect(codexCall.args.join(' ')).toContain('model_reasoning_effort=high');
  });
});

// ---------------------------------------------------------------------------
// Claude review agent
// ---------------------------------------------------------------------------

describe('review handler — Claude review agent', () => {
  // Happy-path sequence for worktree-only Claude review (issue #456/#699).
  // Call order: gh-pr-view(0) fetch(1) rev-parse(2) pull(3) rev-list(4)
  //             status-preflight(5) diff-classification(6) npm-test(7)
  //             git-diff-for-prompt(8) claude-review(9) status-post-review(10)
  function claudeHappyRunner() {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new code', stderr: '', exitCode: 0 }, // git diff origin/main...HEAD (pre-verification diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new code', stderr: '', exitCode: 0 }, // git diff origin/main...HEAD (full diff for prompt)
      { stdout: 'No blocking issues found. Implementation looks correct.', stderr: '', exitCode: 0 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
  }

  function makeClaudeTask(overrides = {}) {
    return makeTask({ reviewAgent: 'claude', ...overrides });
  }

  function claudeContext(overrides = {}) {
    return CONTEXT({
      session: SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'claude', researchAgent: 'gemini' } }),
      ...overrides,
    });
  }

  test('Claude pass -> result: success', async () => {
    const result = await createReviewHandler(claudeContext(), claudeHappyRunner())(makeClaudeTask());
    expect(result.result).toBe('success');
  });

  test('Claude review invokes claude command with -p flag, not codex', async () => {
    const runner = claudeHappyRunner();
    await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude');
    expect(claudeCall.cmd).toBe('claude');
    expect(claudeCall.args).toContain('-p');
    expect(claudeCall.args).not.toContain('review'); // not the Codex review subcommand
  });

  test('Claude review fetches the PR diff via git diff before invoking claude', async () => {
    const runner = claudeHappyRunner();
    await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    // Two `git diff` calls run for Claude: the pre-verification diff-classification
    // read (issue #506) and the full-diff read for the prompt. Both target the
    // same reviewBase...HEAD range.
    const diffCalls = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'diff');
    expect(diffCalls.length).toBeGreaterThan(0);
    for (const diffCall of diffCalls) {
      // Three-dot notation: diff from merge-base of reviewBase..HEAD to HEAD
      expect(diffCall.args.join(' ')).toContain('main...HEAD');
    }
  });

  test('Claude review passes review brief and diff via stdin', async () => {
    const runner = claudeHappyRunner();
    await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude');
    expect(typeof claudeCall.opts.stdin).toBe('string');
    expect(claudeCall.opts.stdin).toContain('## PR Diff');
    expect(claudeCall.opts.stdin).toContain('diff --git');
  });

  test('Claude review stdin includes review instructions from the review brief', async () => {
    const runner = claudeHappyRunner();
    await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude');
    expect(claudeCall.opts.stdin).toContain('Review Instructions');
    expect(claudeCall.opts.stdin).toContain('Requirement fit');
    expect(claudeCall.opts.stdin).toContain('acceptance criteri');
  });

  test('Claude review includes issue body in stdin when present', async () => {
    const runner = claudeHappyRunner();
    const task = makeClaudeTask({ context: { ...makeTask().context, body: 'Must support token refresh.' } });
    await createReviewHandler(claudeContext(), runner)(task);
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude');
    expect(claudeCall.opts.stdin).toContain('## Issue Requirements');
    expect(claudeCall.opts.stdin).toContain('Must support token refresh.');
  });

  test('[P1] finding in Claude output -> result: needs_fix with reviewFeedback', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/foo.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src/foo.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: '[P1] Null pointer dereference in handler', stderr: '', exitCode: 0 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
    const result = await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.hasBlockingFindings).toBe(true);
    expect(result.context?.reviewFeedback).toContain('[P1] Null pointer dereference');
  });

  test('conflict signal in Claude output -> result: conflict', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/foo.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src/foo.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git worktree remove --force --force <path> (free review worktree, issue #456)
    ]);
    const result = await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    expect(result.result).toBe('conflict');
    expect(result.context?.hasConflictSignal).toBe(true);
  });

  test('Claude execution failure -> result: failed', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/foo.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src/foo.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: '', stderr: 'claude: api error', exitCode: 1 }, // claude -p fails
    ]);
    const result = await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/claude: api error/);
    expect(result.error).toMatch(/Review agent/);
  });

  test('review-context.json resolvedProfile contains claude agent info with model and effort', async () => {
    const runner = claudeHappyRunner();
    await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'review', agentId: 'claude', cmd: 'claude' });
    expect(typeof ctx.resolvedProfile.model).toBe('string');
    expect(typeof ctx.resolvedProfile.effort).toBe('string');
    expect(ctx.resolvedProfile.effortSource).toBeDefined();
  });

  test('Claude resolvedProfile argv excludes prompt content (no stdin text in argv)', async () => {
    const runner = claudeHappyRunner();
    await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-context.json'), 'utf8'));
    const argvStr = ctx.resolvedProfile.argv.join(' ');
    expect(argvStr).not.toContain('Issue Requirements');
    expect(argvStr).not.toContain('Review Instructions');
    expect(argvStr).not.toContain('PR Diff');
  });

  test('Claude resolvedProfile records model and effort for auditability', async () => {
    const savedModel = process.env.CLAUDE_MODEL;
    const savedEffort = process.env.CLAUDE_EFFORT;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_EFFORT;
    try {
      const runner = claudeHappyRunner();
      const task = makeClaudeTask({ context: { ...makeTask().context, labels: ['review:high'] } });
      await createReviewHandler(claudeContext(), runner)(task);
      const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-context.json'), 'utf8'));
      expect(ctx.resolvedProfile.model).toBe('opus');
      expect(ctx.resolvedProfile.effort).toBe('high');
    } finally {
      if (savedModel !== undefined) process.env.CLAUDE_MODEL = savedModel;
      if (savedEffort !== undefined) process.env.CLAUDE_EFFORT = savedEffort;
    }
  });

  test('default labels -> Claude uses sonnet model with high effort (no env overrides)', async () => {
    // Temporarily clear env vars so the test exercises the label-derived defaults.
    const savedModel = process.env.CLAUDE_MODEL;
    const savedEffort = process.env.CLAUDE_EFFORT;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_EFFORT;
    try {
      const runner = claudeHappyRunner();
      await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
      const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-context.json'), 'utf8'));
      expect(ctx.resolvedProfile.model).toBe('sonnet');
      expect(ctx.resolvedProfile.effort).toBe('high');
      expect(ctx.resolvedProfile.modelSource).toBe('default');
      expect(ctx.resolvedProfile.effortSource).toBe('default');
    } finally {
      if (savedModel !== undefined) process.env.CLAUDE_MODEL = savedModel;
      if (savedEffort !== undefined) process.env.CLAUDE_EFFORT = savedEffort;
    }
  });

  test('review:low label -> Claude uses low effort (no env overrides)', async () => {
    // Temporarily clear CLAUDE_EFFORT so the label-derived effort is used.
    const savedEffort = process.env.CLAUDE_EFFORT;
    delete process.env.CLAUDE_EFFORT;
    try {
      const runner = claudeHappyRunner();
      const task = makeClaudeTask({ context: { ...makeTask().context, labels: ['review:low'] } });
      await createReviewHandler(claudeContext(), runner)(task);
      const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-context.json'), 'utf8'));
      expect(ctx.resolvedProfile.effort).toBe('low');
      expect(ctx.resolvedProfile.effortSource).toBe('label');
    } finally {
      if (savedEffort !== undefined) process.env.CLAUDE_EFFORT = savedEffort;
    }
  });

  test('empty Claude output -> result: blocked', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/foo.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src/foo.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: '', stderr: '', exitCode: 0 }, // empty output
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
    const result = await createReviewHandler(claudeContext(), runner)(makeClaudeTask());
    expect(result.result).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// Claude review — phase transitions
// ---------------------------------------------------------------------------

describe('review handler — Claude review phase transitions', () => {
  let store;

  beforeEach(() => {
    store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
  });

  function claudeContext(overrides = {}) {
    return CONTEXT({
      session: SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'claude', researchAgent: 'gemini' } }),
      ...overrides,
    });
  }

  test('Claude pass transitions to ready_for_human', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 200, phase: 'review',
      reviewAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/200', branch: 'ai/issue-200', title: 'T' },
    });

    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 200, url: 'https://github.com/m2dw/test-repo/pull/200', headRefName: 'ai/issue-200', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-200', stderr: '', exitCode: 0 },  // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'diff --git a/src', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: 'No blocking issues. Looks good.', stderr: '', exitCode: 0 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(claudeContext(), runner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'ready_for_human', phase: 'review' });
    expect(outcome.result.context?.reviewAgentUsed).toBe('claude');
  });

  test('Claude needs_fix transitions to queued implementation with reviewFeedback', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 201, phase: 'review',
      reviewAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/201', branch: 'ai/issue-201', title: 'T' },
    });

    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 201, url: 'https://github.com/m2dw/test-repo/pull/201', headRefName: 'ai/issue-201', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-201', stderr: '', exitCode: 0 },  // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: '[P1] Critical bug in authentication handler', stderr: '', exitCode: 0 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(claudeContext(), runner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'implementation' });
    expect(outcome.result.context?.classification).toBe('needs_fix');
    expect(typeof outcome.task.context?.reviewFeedback).toBe('string');
    expect(outcome.task.context?.reviewFeedback).toContain('[P1]');
  });

  test('Claude conflict routes to conflict_resolution phase', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 202, phase: 'review',
      reviewAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/202', branch: 'ai/issue-202', title: 'T' },
    });

    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 202, url: 'https://github.com/m2dw/test-repo/pull/202', headRefName: 'ai/issue-202', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-202', stderr: '', exitCode: 0 },  // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git worktree remove --force --force <path> (free review worktree, issue #456)
    ]);

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(claudeContext(), runner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'conflict_resolution' });
    expect(outcome.result.result).toBe('conflict');
  });

  test('Claude execution failure transitions to failed status', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 203, phase: 'review',
      reviewAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/203', branch: 'ai/issue-203', title: 'T' },
    });

    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 203, url: 'https://github.com/m2dw/test-repo/pull/203', headRefName: 'ai/issue-203', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-203', stderr: '', exitCode: 0 },  // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: '', stderr: 'claude: api error 503', exitCode: 1 }, // claude -p fails
    ]);

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(claudeContext(), runner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'failed' });
    expect(outcome.task.lastError).toMatch(/claude: api error 503/);
  });
});

// ---------------------------------------------------------------------------
// Gemini/Antigravity review agent
// ---------------------------------------------------------------------------

function geminiHappyRunner() {
  return sequenceRunner([
    { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
    { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
    { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
    { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
    { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
    { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
    { stdout: 'diff --git a/src/auth.ts b/src/auth.ts\n-old\n+new', stderr: '', exitCode: 0 }, // git diff origin/main...HEAD (pre-verification diff classification, issue #506)
    { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // verification
    { stdout: 'diff --git a/src/auth.ts b/src/auth.ts\n-old\n+new', stderr: '', exitCode: 0 }, // git diff origin/main...HEAD (full diff for prompt)
    { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // agy --print
    { stdout: '', stderr: '', exitCode: 0 },              // post-review git status --porcelain — clean
    { stdout: JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), stderr: '', exitCode: 0 }, // gh pr view (live mergeability)
  ]);
}

function makeGeminiTask(overrides = {}) {
  return makeTask({
    reviewAgent: 'gemini',
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      prUrl: 'https://github.com/m2dw/test-repo/pull/99',
      branch: 'ai/issue-77-run-impl-1',
      labels: ['agent:gemini', 'status:needs-review'],
    },
    ...overrides,
  });
}

function geminiContext(overrides = {}) {
  return CONTEXT({
    session: SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'gemini', researchAgent: 'gemini' } }),
    ...overrides,
  });
}

describe('review handler — Gemini/Antigravity review agent', () => {
  // agy call is at index 9 in the worktree-only happy-path runner sequence:
  // gh-pr-view(0) fetch(1) rev-parse(2) pull(3) rev-list(4) status(5)
  // diff-classification(6) npm-test(7) diff-full-for-prompt(8) agy(9)
  // post-review-status(10) gh-pr-view-mergeability(11).
  const AGY_IDX = 9;

  beforeEach(() => { delete process.env.ANTIGRAVITY_BIN; });
  afterEach(() => { delete process.env.ANTIGRAVITY_BIN; });

  test('Gemini pass -> result: success', async () => {
    const result = await createReviewHandler(geminiContext(), geminiHappyRunner())(makeGeminiTask());
    expect(result.result).toBe('success');
  });

  test('Gemini review invokes agy --print with the prompt as positional arg and stdin', async () => {
    const runner = geminiHappyRunner();
    await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    const agyCall = runner.calls[AGY_IDX];
    expect(agyCall.cmd).toBe('agy');
    // Antigravity contract: `agy --print "<prompt>"` with the prompt as the
    // positional argument AND on stdin, matching the research lane. Some `agy`
    // builds read only the positional arg, so stdin-only would run without the
    // brief/diff.
    expect(agyCall.args).toHaveLength(2);
    expect(agyCall.args[0]).toBe('--print');
    expect(agyCall.args[1]).toContain('Review Instructions');
    expect(agyCall.args[1]).toContain('## PR Diff');
    expect(agyCall.args[1]).toContain('-old');
    expect(agyCall.opts.stdin).toBe(agyCall.args[1]);
  });

  test('Gemini uses ANTIGRAVITY_BIN when set', async () => {
    process.env.ANTIGRAVITY_BIN = '/usr/local/bin/custom-agy';
    const runner = geminiHappyRunner();
    await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(runner.calls[AGY_IDX].cmd).toBe('/usr/local/bin/custom-agy');
  });

  test('Gemini [P1] finding -> needs_fix with reviewFeedback', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: '[P1] Missing input validation', stderr: '', exitCode: 0 }, // agy --print
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
    const result = await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewFeedback).toContain('[P1] Missing input validation');
  });

  test('Gemini conflict signal -> conflict', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // agy --print
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git worktree remove --force --force <path> (free review worktree, issue #456)
    ]);
    const result = await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(result.result).toBe('conflict');
  });

  test('Gemini nonzero exit -> failed with agent output', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: '', stderr: 'agy: auth error', exitCode: 1 }, // agy --print fails
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
    const result = await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(result.result).toBe('failed');
    expect(result.error).toContain('agy: auth error');
  });

  test('Gemini success with dirty merge state routes to conflict resolution', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // npm test
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // agy --print
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      { stdout: JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), stderr: '', exitCode: 0 }, // gh pr view (live mergeability)
      { stdout: '', stderr: '', exitCode: 0 },              // git worktree remove --force --force <path> (free review worktree, issue #456)
    ]);
    const result = await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(result.result).toBe('conflict');
  });

  // Fail closed: a clean Gemini review only promotes to ready_for_human when
  // GitHub confirms mergeability. When the check is unavailable, the PR must
  // block for a human rather than fall through to success.
  function geminiRunnerWithMergeCheck(mergeCheck) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // verification
      { stdout: 'diff --git a/src/auth.ts', stderr: '', exitCode: 0 }, // git diff (full diff for prompt)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // agy --print
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      mergeCheck,                                           // gh pr view (live mergeability)
    ]);
  }

  test('Gemini pass blocks when gh pr view exits nonzero', async () => {
    const runner = geminiRunnerWithMergeCheck({ stdout: '', stderr: 'gh: not found', exitCode: 1 });
    const result = await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/mergeability could not be confirmed/);
  });

  test('Gemini pass blocks when mergeability JSON is unparsable', async () => {
    const runner = geminiRunnerWithMergeCheck({ stdout: 'not json', stderr: '', exitCode: 0 });
    const result = await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/not valid JSON/);
  });

  test('Gemini pass blocks when mergeability is UNKNOWN', async () => {
    const runner = geminiRunnerWithMergeCheck({
      stdout: JSON.stringify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), stderr: '', exitCode: 0,
    });
    const result = await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/mergeable=UNKNOWN/);
  });

  test('Gemini clean pass over a truncated diff blocks for a human (issue #264)', async () => {
    // A PR diff longer than MAX_REVIEW_DIFF_CHARS is truncated before being shown
    // to Gemini, so any blocking change after the cutoff is never reviewed. A clean
    // agent output therefore cannot certify the full PR — fail closed to a human
    // rather than promoting a partially reviewed PR to ready_for_human. (Unlike the
    // mergeability guards above, this returns before the gh pr view call.)
    const hugeDiff = 'diff --git a/src/big.ts b/src/big.ts\n' + '+x\n'.repeat(30_000); // > 50k chars
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: hugeDiff, stderr: '', exitCode: 0 },        // git diff (pre-verification diff classification, issue #506)
      { stdout: 'ok', stderr: '', exitCode: 0 },            // verification
      { stdout: hugeDiff, stderr: '', exitCode: 0 },        // git diff (oversized, for prompt)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 }, // agy --print (clean)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
    ]);
    const result = await createReviewHandler(geminiContext(), runner)(makeGeminiTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/truncated before review/);
    // The agent must have been given the truncation marker, and the merge check
    // must NOT have run (we block before it). The Step 0 branch-validation `gh
    // pr view` (call 0) is unrelated and still runs to resolve the review
    // worktree; only the live-mergeability query (`--json mergeable,...`) is
    // gated on the truncation check, so assert on its distinctive args rather
    // than any `gh ... view` call.
    expect(runner.calls[AGY_IDX].args[1]).toContain('…(diff truncated)');
    expect(runner.calls.some((c) => c.cmd === 'gh' && (c.args || []).includes('mergeable,mergeStateStatus'))).toBe(false);
  });

  test('Gemini pass transitions to ready_for_human', async () => {
    const store = new SqliteTaskStore(join(tmpDir, 'gemini-review.db'));
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 200, phase: 'review',
      reviewAgent: 'gemini', now: '2026-06-07T00:00:00.000Z',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/200', branch: 'ai/issue-77-run-impl-1', title: 'Gemini test' },
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-review-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { review: createReviewHandler(geminiContext(), geminiHappyRunner()) },
    });

    store.close();
    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'ready_for_human', phase: 'review' });
  });
});

// ---------------------------------------------------------------------------
// Codex context-mode (issue #376)
// ---------------------------------------------------------------------------

describe('review handler — codex context-mode', () => {
  // codex call is at index 8 in the worktree-only happy-path runner sequence:
  // gh-pr-view(0) fetch(1) rev-parse(2) pull(3) rev-list(4) status(5)
  // diff-classification(6) npm-test(7) codex(8).
  const REVIEW_IDX = 8;

  function readReviewProfile() {
    const raw = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-context.json'), 'utf8');
    return JSON.parse(raw).resolvedProfile;
  }

  test('no codex config: argv unchanged, metadata records context-mode unset', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const { args } = runner.calls[REVIEW_IDX];
    expect(args).not.toContain('--profile');
    expect(args).not.toContain('context_mode=on');
    const profile = readReviewProfile();
    expect(profile).toMatchObject({
      agentId: 'codex',
      provider: 'openai',
      contextMode: 'unset',
      contextModeSource: 'default',
    });
    expect(profile.contextModeConfig).toBeUndefined();
  });

  test('enabled with config override: codex review receives -c context_mode=on', async () => {
    const session = SESSION({ codex: { contextMode: { enabled: true, config: ['context_mode=on'] } } });
    const runner = happyRunner();
    await createReviewHandler(CONTEXT({ session }), runner)(makeTask());
    const { args } = runner.calls[REVIEW_IDX];
    const cIdx = args.lastIndexOf('-c');
    expect(args[cIdx + 1]).toBe('context_mode=on');
    const profile = readReviewProfile();
    expect(profile).toMatchObject({
      contextMode: 'enabled',
      contextModeSource: 'session',
      contextModeConfig: ['context_mode=on'],
    });
  });

  test('enabled with profile: codex review receives --profile before the review subcommand', async () => {
    const session = SESSION({ codex: { contextMode: { enabled: true, profile: 'ctx' } } });
    const runner = happyRunner();
    await createReviewHandler(CONTEXT({ session }), runner)(makeTask());
    const { args } = runner.calls[REVIEW_IDX];
    const pIdx = args.indexOf('--profile');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(args[pIdx + 1]).toBe('ctx');
    // `--profile` is a GLOBAL Codex option, not a `codex review` option, so it
    // must precede the `review` subcommand or Codex fails arg parsing before the
    // review starts (issue #376 review follow-up).
    const reviewIdx = args.indexOf('review');
    expect(reviewIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeLessThan(reviewIdx);
    expect(readReviewProfile().contextModeConfig).toContain('profile=ctx');
  });

  test('enabled with profile and config: --profile precedes review, -c overrides follow it', async () => {
    const session = SESSION({ codex: { contextMode: { enabled: true, profile: 'ctx', config: ['context_mode=on'] } } });
    const runner = happyRunner();
    await createReviewHandler(CONTEXT({ session }), runner)(makeTask());
    const { args } = runner.calls[REVIEW_IDX];
    const pIdx = args.indexOf('--profile');
    const reviewIdx = args.indexOf('review');
    const cIdx = args.lastIndexOf('-c');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeLessThan(reviewIdx);
    // The context-mode `-c` override stays after the subcommand.
    expect(cIdx).toBeGreaterThan(reviewIdx);
    expect(args[cIdx + 1]).toBe('context_mode=on');
    expect(readReviewProfile().contextModeConfig).toEqual(['profile=ctx', 'context_mode=on']);
  });

  test('invalid config fails before running codex review with a clear error', async () => {
    const session = SESSION({ codex: { contextMode: { enabled: true, config: ['noequalshere'] } } });
    const runner = happyRunner();
    const r = await createReviewHandler(CONTEXT({ session }), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/context-mode config override/i);
    // No git/codex commands ran — the run failed at command resolution.
    expect(runner.calls.find(c => c.cmd === 'codex')).toBeUndefined();
  });

  test('enabled but no invocation form fails with a clear error', async () => {
    const session = SESSION({ codex: { contextMode: { enabled: true } } });
    const runner = happyRunner();
    const r = await createReviewHandler(CONTEXT({ session }), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/no invocation form is configured/i);
  });

  test('CODEX_CONTEXT_MODE=off disables a session-enabled context-mode', async () => {
    process.env['CODEX_CONTEXT_MODE'] = 'off';
    const session = SESSION({ codex: { contextMode: { enabled: true, config: ['context_mode=on'] } } });
    const runner = happyRunner();
    try {
      await createReviewHandler(CONTEXT({ session }), runner)(makeTask());
    } finally {
      delete process.env['CODEX_CONTEXT_MODE'];
    }
    const { args } = runner.calls[REVIEW_IDX];
    expect(args).not.toContain('context_mode=on');
    expect(readReviewProfile()).toMatchObject({ contextMode: 'unset', contextModeSource: 'env' });
  });
});

// ---------------------------------------------------------------------------
// Codex model selection (issue #609)
// ---------------------------------------------------------------------------

describe('review handler — codex model selection', () => {
  // codex call is at index 8 in the worktree-only happy-path runner sequence:
  // gh-pr-view(0) fetch(1) rev-parse(2) pull(3) rev-list(4) status(5)
  // diff-classification(6) npm-test(7) codex(8).
  const REVIEW_IDX = 8;

  function readReviewProfile() {
    const raw = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-context.json'), 'utf8');
    return JSON.parse(raw).resolvedProfile;
  }

  test('no session.codex.model or CODEX_MODEL: no --model flag, compatibility mode metadata', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const { args } = runner.calls[REVIEW_IDX];
    expect(args).not.toContain('--model');
    const profile = readReviewProfile();
    expect(profile).toMatchObject({ model: 'cli-default', modelSource: 'cli-default' });
  });

  test('session.codex.model: --model precedes the review subcommand, metadata records session-config', async () => {
    const session = SESSION({ codex: { model: 'gpt-5-codex' } });
    const runner = happyRunner();
    await createReviewHandler(CONTEXT({ session }), runner)(makeTask());
    const { args } = runner.calls[REVIEW_IDX];
    const mIdx = args.indexOf('--model');
    const reviewIdx = args.indexOf('review');
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(args[mIdx + 1]).toBe('gpt-5-codex');
    expect(mIdx).toBeLessThan(reviewIdx);
    const profile = readReviewProfile();
    expect(profile).toMatchObject({ model: 'gpt-5-codex', modelSource: 'session-config' });
  });

  test('CODEX_MODEL env var overrides session.codex.model', async () => {
    process.env['CODEX_MODEL'] = 'o1-preview';
    const session = SESSION({ codex: { model: 'gpt-5-codex' } });
    const runner = happyRunner();
    try {
      await createReviewHandler(CONTEXT({ session }), runner)(makeTask());
    } finally {
      delete process.env['CODEX_MODEL'];
    }
    const { args } = runner.calls[REVIEW_IDX];
    const mIdx = args.indexOf('--model');
    expect(args[mIdx + 1]).toBe('o1-preview');
    const profile = readReviewProfile();
    expect(profile).toMatchObject({ model: 'o1-preview', modelSource: 'env' });
  });

  test('CODEX_EFFORT env var overrides review-strength-derived effort', async () => {
    process.env['CODEX_EFFORT'] = 'low';
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:high'] } });
    const runner = happyRunner();
    try {
      await createReviewHandler(CONTEXT(), runner)(task);
    } finally {
      delete process.env['CODEX_EFFORT'];
    }
    const { args } = runner.calls[REVIEW_IDX];
    expect(args.join(' ')).toContain('model_reasoning_effort=low');
    const profile = readReviewProfile();
    expect(profile).toMatchObject({ effort: 'low', effortSource: 'env' });
  });

  test('resolvedProfile records explicit effort/effortSource for the no-label default', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const profile = readReviewProfile();
    expect(profile).toMatchObject({ effort: 'high', effortSource: 'default' });
  });

  test('resolvedProfile records explicit effort/effortSource for review:medium', async () => {
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:codex', 'status:needs-review', 'review:medium'] } });
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(task);
    const profile = readReviewProfile();
    expect(profile).toMatchObject({ effort: 'medium', effortSource: 'label' });
  });
});

// ---------------------------------------------------------------------------
// Per-issue worktree review (issue #456)
// ---------------------------------------------------------------------------

describe('review handler — per-issue worktree review (issue #456)', () => {
  const worktreePath = () => join(tmpDir, 'worktrees', 'addon-dev', 'issue-77');

  // Records every resolveWorktree() input and returns a fixed worktree path so the
  // handler's cwd switch is exercised without a real `git worktree`. Defaults model
  // the common review case: the worktree already exists and is reused on the issue
  // branch (created: false, branchReused: true).
  function fakeWorktreeResolver(path, { ok = true, error, created = false, branchReused = true } = {}) {
    const calls = [];
    return {
      calls,
      resolve(input) {
        calls.push(input);
        if (!ok) return { ok: false, error: error ?? 'resolve failed' };
        return { ok: true, path, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created, branchReused };
      },
    };
  }

  // Duck-typed IssueWorktreeLock: records acquire/release and returns a configurable
  // acquire result so a held lock (concurrent execution) can be simulated.
  function fakeLock(acquireResult = { ok: true, locked: true, contextId: 'run-review-1', sessionId: 'addon-dev' }) {
    const calls = { acquire: [], release: [] };
    return {
      calls,
      acquire(ownerId, sessionId, issueNumber) { calls.acquire.push({ ownerId, sessionId, issueNumber }); return acquireResult; },
      release(ownerId, sessionId, issueNumber) { calls.release.push({ ownerId, sessionId, issueNumber }); return { ok: true, released: true }; },
    };
  }

  // Worktree-mode codex happy path: validate recorded branch (gh pr view) → fetch base →
  // local-branch probe (exists, so no PR-head fetch) → resolveWorktree (injected,
  // branchReused) → pull --ff-only onto the live PR head → preflight → verification →
  // codex. Steps 2 (checkout main + pull) and 3 (gh pr checkout) are skipped — the `gh`
  // call here is only the branch-validation read (issue #447 P2), not a checkout.
  function worktreeHappyRunner() {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch, issue #447 P2)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },       // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin ai/issue-77 --ff-only (reconcile reused branch with PR head)
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD (on the live PR head)
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (Step 1 preflight) — clean
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (Step 5.5 post-review) — clean
    ]);
  }

  const wtTask = () => makeTask({
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      prUrl: 'https://github.com/m2dw/test-repo/pull/99',
      branch: 'ai/issue-77',
      labels: ['agent:codex', 'status:needs-review'],
    },
  });

  // The headline acceptance case: implementation left `ai/issue-77` checked out in
  // the per-issue worktree, so the review must run there instead of checking the
  // held branch out in the canonical checkout (Git would reject that).
  test('runs review inside the per-issue worktree and never checks the held branch out in the canonical checkout', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');

    // The worktree was resolved for the issue's own branch, tolerant of a
    // behind-origin (fast-forwardable) PR head.
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({
      repoRoot,
      issueNumber: 77,
      branch: 'ai/issue-77',
      allowFastForward: true,
    });

    // The regression guard: NO canonical `git checkout` (Step 2) and NO `gh pr
    // checkout` (Step 3) — Git refuses a branch already held by another worktree.
    // A `gh pr view` IS called to validate the recorded branch (issue #447 P2), but
    // not `gh pr checkout`.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'checkout')).toBe(false);

    // The diff base is the freshly-fetched origin/<base> (local main is never
    // advanced in a worktree-only session), and codex diffs against it.
    const fetch = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetch.args).toEqual(['fetch', 'origin', '+main:refs/remotes/origin/main']);
    expect(fetch.opts.cwd).toBe(repoRoot);
    const codex = runner.calls.find((c) => c.cmd === 'codex');
    expect(codex.args).toContain('origin/main');

    // Verification, the agent, and the pre/post-review status checks all run INSIDE
    // the worktree, never the canonical checkout.
    expect(codex.opts.cwd).toBe(wt);
    expect(runner.calls.find((c) => c.cmd === 'npm').opts.cwd).toBe(wt);
    for (const c of runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'status')) {
      expect(c.opts.cwd).toBe(wt);
    }

    // The issue-scoped worktree lock was held across the review and released once.
    expect(lock.calls.acquire).toEqual([{ ownerId: 'run-review-1', sessionId: 'addon-dev', issueNumber: 77 }]);
    expect(lock.calls.release).toEqual([{ ownerId: 'run-review-1', sessionId: 'addon-dev', issueNumber: 77 }]);
  });

  // Concurrent review lock behavior: a different execution already holds this issue's
  // worktree lock, so the review fails closed to a human without touching anything.
  test('blocks when the issue worktree lock is already held by another execution', async () => {
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock({
      ok: true, locked: false, reason: 'lock_held',
      ownerContextId: 'other-run', ownerStartedAt: '2026-06-30T00:00:00.000Z',
    });
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('blocked');
    // The held lock scope + owner are surfaced for the task event / lock diagnostics.
    expect(result.context?.reviewLockScope).toBe('addon-dev::issue-77');
    expect(result.context?.reviewLockHeldBy).toBe('other-run');
    expect(result.message).toContain('addon-dev::issue-77');

    // Nothing was mutated: the worktree was never resolved, no git/agent ran, and the
    // lock we never acquired is not released.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect(lock.calls.release).toHaveLength(0);
  });

  // A failed worktree resolution still releases the lock so the issue is not wedged.
  test('releases the lock when worktree resolution fails', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },             // git fetch origin main
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },  // git rev-parse (branch exists)
    ]);
    const resolver = fakeWorktreeResolver(worktreePath(), { ok: false, error: 'diverged from origin' });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('diverged from origin');
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
  });

  // On a fresh/single-branch clone the local issue branch is absent; the PR head is
  // recovered into its remote-tracking ref so resolveWorktree materializes from it.
  test('fetches the PR head when the local issue branch is absent', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/issue-77 (ABSENT)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin ai/issue-77:refs/remotes/origin/ai/issue-77
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');
    const prHeadFetch = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    // Two fetches: the base refresh and the PR-head recovery.
    expect(prHeadFetch.map((c) => c.args)).toEqual([
      ['fetch', 'origin', '+main:refs/remotes/origin/main'],
      ['fetch', 'origin', 'ai/issue-77:refs/remotes/origin/ai/issue-77'],
    ]);
  });

  // P1: a reused local PR branch may be BEHIND origin/<branch> (another worker/operator
  // pushed a follow-up). resolveWorktree's allowFastForward accepts it but leaves the
  // worktree on the stale local commit, so the handler must fast-forward it onto the
  // live PR head before verifying/reviewing or it could approve a PR against old
  // contents.
  test('fast-forwards the reused worktree branch onto the live PR head before reviewing', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');

    // The reconciliation runs INSIDE the worktree, fetching the live PR head.
    const pull = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'pull' && c.args[1] === 'origin');
    expect(pull).toBeDefined();
    expect(pull.args).toEqual(['pull', 'origin', 'ai/issue-77', '--ff-only']);
    expect(pull.opts.cwd).toBe(wt);

    // It happens before the verification + review agent, so they run on the fresh head.
    const pullIdx = runner.calls.indexOf(pull);
    const verifyIdx = runner.calls.findIndex((c) => c.cmd === 'npm');
    const codexIdx = runner.calls.findIndex((c) => c.cmd === 'codex');
    expect(pullIdx).toBeLessThan(verifyIdx);
    expect(pullIdx).toBeLessThan(codexIdx);
  });

  // P1: a genuinely diverged (non-fast-forwardable) head makes the reconciliation pull
  // fail; the review must fail closed (not review stale/diverged contents) and still
  // release the lock so the issue is not wedged.
  test('fails closed and releases the lock when the worktree branch cannot fast-forward onto the PR head', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },       // git rev-parse (branch exists)
      { stdout: '', stderr: 'not possible to fast-forward', exitCode: 1 }, // git pull --ff-only — diverged
    ]);
    const resolver = fakeWorktreeResolver(worktreePath(), { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('--ff-only');
    expect(result.context?.reviewLockScope).toBe('addon-dev::issue-77');
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
    // The review agent never ran — no review happened against the diverged head.
    expect(runner.calls.some((c) => c.cmd === 'codex')).toBe(false);
  });

  // P2: `git pull --ff-only` is a successful NO-OP when the reused branch is AHEAD of
  // origin/<branch> (local-only commits after a failed/manual local commit or a remote
  // reset). That leaves HEAD past the live PR head, so the review must fail closed
  // rather than approve commits that were never pushed — and still release the lock.
  test('refuses the review and releases the lock when the worktree branch is ahead of the live PR head', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },       // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull --ff-only — no-op (local is ahead)
      { stdout: '2', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD — 2 local-only commits
    ]);
    const resolver = fakeWorktreeResolver(worktreePath(), { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('ahead of the live PR head');
    expect(result.error).toContain('2 commit');
    expect(result.context?.reviewLockScope).toBe('addon-dev::issue-77');
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
    // The review agent never ran — no review happened against the local-ahead head.
    expect(runner.calls.some((c) => c.cmd === 'codex')).toBe(false);
    // The local-ahead guard compared against the freshly-fetched remote head.
    const revList = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'rev-list');
    expect(revList.args).toEqual(['rev-list', '--count', 'FETCH_HEAD..HEAD']);
    expect(revList.opts.cwd).toBe(worktreePath());
  });

  // P2: if the local-ahead probe itself fails (e.g. FETCH_HEAD missing), fail closed
  // rather than assume the worktree is on the live PR head.
  test('fails closed and releases the lock when the local-ahead probe cannot run', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },       // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull --ff-only
      { stdout: '', stderr: 'bad revision FETCH_HEAD', exitCode: 128 }, // git rev-list — fails
    ]);
    const resolver = fakeWorktreeResolver(worktreePath(), { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('FETCH_HEAD..HEAD');
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
    expect(runner.calls.some((c) => c.cmd === 'codex')).toBe(false);
  });

  // P1: a branch the resolver CREATED fresh from origin/<branch> already sits at the PR
  // head, so the reconciliation pull is skipped (only reused branches need it).
  test('does not fast-forward when the worktree branch was created fresh from the PR head', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse (ABSENT)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin ai/issue-77 (recover PR head)
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
    ]);
    const resolver = fakeWorktreeResolver(worktreePath(), { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'pull' && c.args[1] === 'origin')).toBe(false);
  });

  // P2: a supported PR-url-only review task whose PR head is NON-conventional. The
  // worktree path must materialize the PR's ACTUAL head (resolved from the PR metadata),
  // not the assumed `ai/issue-<n>` convention — otherwise it fetches a nonexistent
  // branch or reviews the wrong one (the canonical path supports this by checking out
  // the PR number).
  test('resolves the PR head from prUrl when no branch is recorded (non-conventional head)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN', baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view 99
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/pr-99', stderr: '', exitCode: 0 },          // git rev-parse refs/heads/ai/pr-99 (synthetic per-PR name exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin pull/99/head --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD (on the live PR head)
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt> (synthetic ready-for-human handoff cleanup, issue #459 P2)
    ]);
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
        // no `branch` recorded — the PR head is non-conventional
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    // The PR head was resolved from the PR number (backend-neutral selector).
    const view = runner.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view');
    expect(view).toBeDefined();
    expect(view.args).toContain('99');
    // The worktree targets a SYNTHETIC per-PR branch (`ai/pr-<n>`), not the PR's raw
    // `headRefName` (which for a forked PR is the contributor's branch and can collide
    // with a local branch) and not the `ai/issue-77` convention (issue #459 review, P1).
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    // The reconciliation pulls the PR head by its PR ref (`pull/<n>/head`), not by an
    // assumed origin branch — a PR-url-only head may be a forked PR with no `origin`
    // branch (issue #456 review, P2).
    const pull = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'pull' && c.args[1] === 'origin');
    expect(pull.args).toEqual(['pull', 'origin', 'pull/99/head', '--ff-only']);
    // The resolved synthetic head is persisted into the returned context so a later
    // fix run's Tool Request handoff does not fall back to `ai/issue-77`.
    expect(result.context.branch).toBe('ai/pr-99');
  });

  // P1 (issue #472 review): a SYNTHETIC `ai/pr-<n>` review worktree that is already
  // dirty at the Step 1 preflight must NOT be force-removed on the dirty-tree human
  // handoff. The dirty contents (e.g. leftover output from an interrupted review) are
  // the very reason for the escalation; `git worktree remove --force --force` would
  // delete them before anyone can inspect or recover them. The worktree is preserved
  // in place and its path surfaced for manual cleanup.
  test('preserves a dirty synthetic ai/pr-<n> review worktree on the preflight dirty-tree block', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN', baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view 99
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main
      { stdout: 'ai/pr-99', stderr: '', exitCode: 0 },          // git rev-parse refs/heads/ai/pr-99 (synthetic per-PR name exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin pull/99/head --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD (on the live PR head)
      { stdout: ' M src/foo.ts\n?? leftover.txt\n', stderr: '', exitCode: 0 }, // git status (preflight) — DIRTY
      // No further calls: the handler blocks here and must NOT remove the worktree.
    ]);
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
        // no `branch` recorded — the PR head is non-conventional, so review runs on
        // the SYNTHETIC `ai/pr-99` worktree.
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    // The dirty tree escalates to a human.
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/dirty/);
    expect(result.context?.reviewFeedback).toMatch(/dirty/i);
    // The synthetic review worktree ran on `ai/pr-99` (confirms the synthetic path).
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    // Critically: the dirty synthetic worktree is NOT force-removed — the uncommitted
    // changes are preserved for manual inspection/recovery.
    const removed = runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removed).toBe(false);
    // The preserved worktree's path is surfaced so the leftover work can be found.
    expect(result.message).toContain(wt);
    expect(result.message).toMatch(/left in place/);
    // The advisory lock is still released in the `finally`.
    expect(lock.calls.release.length).toBeGreaterThan(0);
  });

  // P1 (issue #459): a forked PR head (`isCrossRepository: true`) whose
  // `headRefName` collides with a local branch is materialized through a synthetic
  // `ai/pr-<n>` branch fetched from the PR ref, never through the raw fork head name.
  test('materializes a forked PR head through the synthetic ai/pr-<n> path', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'main', state: 'OPEN', baseRefName: 'main', isCrossRepository: true }), stderr: '', exitCode: 0 }, // gh pr view 99 — forked head
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/pr-99 (ABSENT — synthetic name)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin pull/99/head:refs/remotes/origin/ai/pr-99
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt>
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
        // no `branch` recorded — the PR head lives on a fork
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    const fetches = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetches.map((c) => c.args)).toEqual([
      ['fetch', 'origin', '+main:refs/remotes/origin/main'],
      ['fetch', 'origin', 'pull/99/head:refs/remotes/origin/ai/pr-99'],
    ]);
    // The colliding fork branch name was never used as the local worktree branch.
    expect(resolver.calls.some((c) => c.branch === 'main')).toBe(false);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2 (issue #459): a forked PR (`isCrossRepository: true`) reviewed on the synthetic
  // `ai/pr-<n>` path whose review yields blocking findings must NOT auto-queue the
  // implementation-fix phase — that handler refuses forked heads (it cannot push a fix
  // back to the contributor's fork), so a `needs_fix` result would deterministically
  // fail the next phase. The review hands off to a human (`blocked`) instead, carrying
  // the review feedback, and still frees the synthetic worktree.
  test('forked PR with blocking review findings hands off to a human instead of auto-queuing a fix', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'main', state: 'OPEN', baseRefName: 'main', isCrossRepository: true }), stderr: '', exitCode: 0 }, // gh pr view 99 — forked head
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/pr-99 (ABSENT — synthetic name)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin pull/99/head:refs/remotes/origin/ai/pr-99
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: '[P1] Null pointer in auth handler', stderr: '', exitCode: 0 }, // codex review — blocking finding
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt> (synthetic fix handoff cleanup)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
        // no `branch` recorded — the PR head lives on a fork
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    // Human handoff, NOT an auto-queued needs_fix (the fix phase would refuse the fork).
    expect(result.result).toBe('blocked');
    expect(result.message).toContain('forked PR');
    expect(result.message).toContain('#99');
    // The blocking review feedback is preserved for the human handoff.
    expect(result.context?.reviewFeedback).toContain('[P1] Null pointer in auth handler');
    // The synthetic review worktree was still freed, and the lock released.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2 (issue #459): a forked PR whose review finds a merge conflict must NOT auto-queue
  // conflict_resolution — that handler also refuses forked heads (it cannot push the
  // resolution back to the fork). The review hands off to a human (`blocked`) instead.
  test('forked PR with a review-detected conflict hands off to a human instead of auto-queuing conflict resolution', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'main', state: 'OPEN', baseRefName: 'main', isCrossRepository: true }), stderr: '', exitCode: 0 }, // gh pr view 99 — forked head
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/pr-99 (ABSENT)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin pull/99/head:refs/remotes/origin/ai/pr-99
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // codex review — conflict
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt> (conflict handoff cleanup)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    // Human handoff, NOT an auto-queued conflict (conflict_resolution refuses the fork).
    expect(result.result).toBe('blocked');
    expect(result.context?.classification).not.toBe('conflict');
    expect(result.message).toContain('forked PR');
    // The synthetic review worktree was still freed, and the lock released.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(lock.calls.release).toHaveLength(1);
  });

  // Regression: a SAME-repository PR reviewed in worktree mode keeps its auto-queue
  // lanes. The recorded conventional `ai/issue-<n>` branch is validated against the
  // live PR and confirmed as a same-repository head, so `needs_fix` must still route
  // to the implementation-fix phase — the forked-PR handoff must not swallow same-repo
  // blocking outcomes.
  test('same-repo worktree PR with blocking findings still returns needs_fix (auto-queue unchanged)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },       // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin ai/issue-77 --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: '[P1] Null pointer in auth handler', stderr: '', exitCode: 0 }, // codex review — blocking finding
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    // Same-repo head → auto-requeue the implementation-fix phase, not a human handoff.
    expect(result.result).toBe('needs_fix');
    expect(result.context?.classification).toBe('needs_fix');
    expect(result.context?.reviewFeedback).toContain('[P1] Null pointer in auth handler');
    // A same-repo review reuses its worktree for the fix phase, so it is NOT removed.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2: when the PR head cannot be resolved from prUrl (PR read fails), fail closed
  // rather than fall back to the convention and review a possibly-wrong branch.
  test('fails closed and releases the lock when the PR head cannot be resolved from prUrl', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: 'gh: could not resolve PR', exitCode: 1 }, // gh pr view 99 — lookup fails
    ]);
    const resolver = fakeWorktreeResolver(worktreePath(), { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toContain('resolve PR head');
    // No worktree was materialized against a guessed branch, and the lock is released.
    expect(resolver.calls).toHaveLength(0);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2: a PR-url-only review whose non-conventional head is not (or no longer) a branch
  // on `origin` under its name (`isCrossRepository` unset → same-repo, so it is NOT a
  // fork blocked above). The worktree path must recover the head by its PR ref
  // (`pull/<n>/head`) — the ref `gh pr checkout <n>` used on the canonical path — not by
  // `git fetch origin <head>`, which fails when the head branch is absent on `origin`.
  test('fetches a non-origin PR head by its PR ref when the local branch is absent', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN', baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view 99
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/pr-99 (ABSENT — synthetic per-PR name, forked head)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin pull/99/head:refs/remotes/origin/ai/pr-99
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt> (synthetic ready-for-human handoff cleanup, issue #459 P2)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
        // no `branch` recorded — same-repo head not present on `origin` by name
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    // The head was recovered by PR ref into the SYNTHETIC per-PR tracking ref
    // (`origin/ai/pr-<n>`), so a forked PR (no `origin` branch) still materializes the
    // review worktree without reusing the fork's head ref name locally (issue #459, P1).
    const fetches = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetches.map((c) => c.args)).toEqual([
      ['fetch', 'origin', '+main:refs/remotes/origin/main'],
      ['fetch', 'origin', 'pull/99/head:refs/remotes/origin/ai/pr-99'],
    ]);
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
  });

  // P1 (issue #459): a forked PR whose `headRefName` COLLIDES with a branch that already
  // exists locally — commonly `main`. Reusing that raw head ref name as the local
  // worktree branch would make the resolver reuse/detach the base repo's local `main`
  // and fast-forward it to the PR head, leaving the base branch checked out in the issue
  // worktree (and contaminating later phases). The synthetic `ai/pr-<n>` name must be
  // used for the local branch, the rev-parse probe, and the `origin/<branch>` ref so no
  // real local/base ref is ever touched.
  test('never reuses a colliding fork head name (e.g. main) as the local worktree branch', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'main', state: 'OPEN', baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view 99 (forked head named `main`)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/pr-99 (ABSENT — synthetic name, not local `main`)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin pull/99/head:refs/remotes/origin/ai/pr-99
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt> (synthetic ready-for-human handoff cleanup, issue #459 P2)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
        // no `branch` recorded — the PR head lives on a fork and is literally named `main`
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    // The local branch is the synthetic per-PR name, NEVER the colliding `main`.
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    // The rev-parse probe and the PR-ref recovery fetch both target the synthetic ref,
    // so the base repo's local `main` and `origin/main` are never reused or rewritten.
    const revParse = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'rev-parse');
    expect(revParse.args).toContain('refs/heads/ai/pr-99');
    const fetches = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetches.map((c) => c.args)).toEqual([
      ['fetch', 'origin', '+main:refs/remotes/origin/main'],
      ['fetch', 'origin', 'pull/99/head:refs/remotes/origin/ai/pr-99'],
    ]);
    // No fetch ever writes the PR head into `origin/main` (the base-refresh fetch above
    // legitimately updates `origin/main` from the base branch).
    expect(fetches.some((c) => c.args.includes('pull/99/head:refs/remotes/origin/main'))).toBe(false);
  });

  // P1 (issue #459): a forked PR can arrive with BOTH a `prUrl` and a non-conventional
  // recorded `branch` whose name is the contributor's fork head — commonly `main`.
  // Trusting that `branch` would `rev-parse`/`fetch` the local/origin base branch instead
  // of `refs/pull/<n>/head`, reviewing (and promoting) the base branch. The handler reads
  // the PR, sees a confirmed cross-repository head, and reroutes to the synthetic
  // `ai/pr-<n>` path + PR-ref fetch despite the recorded `branch`.
  test('reroutes a forked PR to the synthetic ai/pr-<n> path even when a non-conventional branch is recorded', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'main', state: 'OPEN', baseRefName: 'main', isCrossRepository: true }), stderr: '', exitCode: 0 }, // gh pr view 99 (forked head named `main`)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/pr-99 (ABSENT — synthetic name)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin pull/99/head:refs/remotes/origin/ai/pr-99
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt> (synthetic ready-for-human handoff cleanup, issue #459 P2)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        branch: 'main', // a forked PR head recorded as the contributor's branch name
        labels: ['agent:codex', 'status:needs-review'],
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    // The recorded `branch: 'main'` is NOT trusted: the worktree uses the synthetic
    // per-PR name and the head is recovered by its PR ref, never by `origin/main`.
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    const fetches = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetches.map((c) => c.args)).toEqual([
      ['fetch', 'origin', '+main:refs/remotes/origin/main'],
      ['fetch', 'origin', 'pull/99/head:refs/remotes/origin/ai/pr-99'],
    ]);
    // No fetch ever writes the PR head into `origin/main` (the base-refresh fetch above
    // legitimately updates `origin/main` from the base branch).
    expect(fetches.some((c) => c.args.includes('pull/99/head:refs/remotes/origin/main'))).toBe(false);
  });

  // P1 guard (issue #459): the cross-repository reroute must NOT over-fire. A
  // non-conventional recorded `branch` that the PR confirms is a SAME-repository origin
  // head (a non-conventional head pushed to `origin`) stays authoritative — the review
  // fetches and materializes it by branch name, never via the synthetic PR-ref path.
  test('trusts a recorded non-conventional same-repository branch (no synthetic reroute)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (same-repo head)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/feature/custom (ABSENT)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin feature/custom:refs/remotes/origin/feature/custom
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        branch: 'feature/custom', // a same-repo non-conventional head pushed to origin
        labels: ['agent:codex', 'status:needs-review'],
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    // The same-repo branch is trusted: the worktree uses it directly and the head is
    // fetched by branch name, NOT the synthetic `ai/pr-99` / `pull/99/head` path.
    expect(resolver.calls[0].branch).toBe('feature/custom');
    const fetches = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetches.map((c) => c.args)).toEqual([
      ['fetch', 'origin', '+main:refs/remotes/origin/main'],
      ['fetch', 'origin', 'feature/custom:refs/remotes/origin/feature/custom'],
    ]);
    expect(runner.calls.some((c) => c.args.some((a) => typeof a === 'string' && a.includes('ai/pr-99')))).toBe(false);
  });

  // Even a CONVENTIONAL `ai/issue-<n>` recorded branch is validated against the live PR
  // when `prUrl` is present (issue #447 review, P2): a fork's head branch could
  // coincidentally use the same naming, making it unsafe to bypass the live read. When
  // the PR confirms the conventional branch as the same-repo head the worktree still
  // materializes on `ai/issue-<n>` — the conventional branch is not replaced.
  test('validates the recorded branch against the live PR even for a conventional ai/issue-<n> branch', async () => {
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');
    // A `gh pr view` IS called to validate the recorded branch (issue #447 P2).
    const view = runner.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view');
    expect(view).toBeDefined();
    // The PR confirmed the conventional branch → worktree materializes on it as before.
    expect(resolver.calls[0].branch).toBe('ai/issue-77');
  });

  // A GitHub review whose task context carries a `branch` but NO `prUrl` (issue #447
  // review, P2). The canonical path runs `gh pr checkout <branch>`, which fails when the
  // branch is stale or has no open PR; the worktree path has no PR number to resolve, so
  // without this gate it would fetch `origin/<branch>` and review it, promoting a task to
  // human handoff with no PR. So the recorded branch is first validated against the live PR.
  const wtBranchOnlyTask = () => makeTask({
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      branch: 'ai/issue-77',
      labels: ['agent:codex', 'status:needs-review'],
      // no `prUrl` recorded — a branch-only GitHub selector
    },
  });

  test('validates a branch-only GitHub selector has an open PR before materializing the worktree', async () => {
    // worktreeHappyRunner's first entry is an OPEN PR, consumed here by the branch validation.
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtBranchOnlyTask());

    expect(result.result).toBe('success');
    // The BRANCH — not a PR number — is the selector handed to `gh pr view` for validation.
    const view = runner.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view');
    expect(view).toBeDefined();
    expect(view.args).toContain('ai/issue-77');
    // The open PR is confirmed → the worktree materializes on the recorded branch, and the
    // canonical `gh pr checkout` is still never used.
    expect(resolver.calls[0].branch).toBe('ai/issue-77');
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'checkout')).toBe(false);
  });

  test('fails closed and releases the lock when a branch-only selector has no open PR on GitHub', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: 'no pull requests found for branch "ai/issue-77"', exitCode: 1 }, // gh pr view ai/issue-77 (no PR)
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtBranchOnlyTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/No open PR found for branch 'ai\/issue-77'/);
    // The stale branch is never materialized and nothing beyond the validation read runs —
    // no base fetch, no worktree, no canonical checkout — and the lock is released.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'checkout')).toBe(false);
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
  });

  test('fails closed and releases the lock when a branch-only selector points at a merged (not open) PR', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'MERGED', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view ai/issue-77 (already MERGED)
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtBranchOnlyTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/has a merged PR, not an open one/);
    // A merged/closed PR is treated like a stale branch: nothing is materialized and the
    // lock is released.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(false);
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2 (issue #447): a branch-only GitHub selector whose PR is FORKED (cross-repository).
  // The branch validation read above already reveals `isCrossRepository` and the PR number,
  // but if those were discarded the path would fetch `origin/<branch>` — and a fork's head
  // ref name is the contributor's branch, commonly `main` — so the review would run against
  // (and approve) the BASE repository's branch instead of the fork's PR head. The handler
  // routes the confirmed fork through the same synthetic `ai/pr-<n>` + `pull/<n>/head` path a
  // `prUrl`-only forked PR uses, so the review materializes on the real PR head.
  test('reroutes a branch-only forked PR through the synthetic ai/pr-<n> path', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'main', state: 'OPEN', baseRefName: 'main', isCrossRepository: true }), stderr: '', exitCode: 0 }, // gh pr view main (branch-only selector; forked head named `main`)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/pr-99 (ABSENT — synthetic name, not local `main`)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin pull/99/head:refs/remotes/origin/ai/pr-99
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt> (synthetic ready-for-human handoff cleanup)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        branch: 'main', // the fork's head ref name, recorded with NO prUrl
        labels: ['agent:codex', 'status:needs-review'],
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    // The branch — `main` — is the selector handed to the validation read (there is no PR
    // number to resolve without a prUrl); the read is what reveals the cross-repository head.
    const view = runner.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view');
    expect(view.args).toContain('main');
    // The confirmed fork reroutes to the synthetic per-PR name: the recorded `branch: 'main'`
    // is NOT trusted, so the worktree is materialized on `ai/pr-99` and the head is recovered
    // by its PR ref — the base repo's `origin/main` is never used for the head.
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    const fetches = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetches.map((c) => c.args)).toEqual([
      ['fetch', 'origin', '+main:refs/remotes/origin/main'],
      ['fetch', 'origin', 'pull/99/head:refs/remotes/origin/ai/pr-99'],
    ]);
    // The PR head is recovered into the synthetic tracking ref, never `origin/main`.
    expect(fetches.some((c) => c.args.some((a) => a.startsWith('pull/') && a.endsWith(':refs/remotes/origin/main')))).toBe(false);
    // The synthetic `ai/pr-99` head is persisted as the branch, but on its own that name is
    // not a real PR selector. The resolved PR URL must ALSO be persisted so a successful
    // review's outbox timeline comment and any later `human-review-return` target the actual
    // fork PR (#99) instead of a synthetic branch with no open PR (issue #447 review, P2).
    expect(result.context?.branch).toBe('ai/pr-99');
    expect(result.context?.prUrl).toBe('https://github.com/m2dw/test-repo/pull/99');
  });

  // issue #681: a GitHub worktree review with NEITHER prUrl NOR branch must fail closed
  // with the same `No PR URL or branch` error the canonical `gh` path raises — not fall
  // back to materializing `ai/issue-<n>` by convention (which would promote a task to
  // `ready_for_human` with no PR to hand off). The review-admission preflight now catches
  // this before the worktree lock is even acquired, so neither the lock nor the resolver
  // is ever touched.
  test('fails closed (no PR selector) without materializing the convention branch on GitHub', async () => {
    const runner = sequenceRunner([]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:codex', 'status:needs-review'],
        // neither `prUrl` nor `branch` recorded
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/No PR URL or branch/);
    // The review-admission preflight (issue #681) fires before the worktree lock is
    // acquired, before the resolver runs, and before any git/agent call.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect(lock.calls.acquire).toHaveLength(0);
    expect(lock.calls.release).toHaveLength(0);
  });

  // P2 (issue #447): a NON-GitHub (e.g. Gitea) worktree review of a FORKED
  // (cross-repository) PR must fail closed instead of reviewing the wrong ref. GitHub
  // forked PRs route to the synthetic `ai/pr-<n>` + `pull/<n>/head` path above, but a
  // non-`gh` host has no PR-ref fetch: it resolves a `prUrl`-only head as an ordinary
  // `origin` branch via the head-branch convention, adopting the PR's `headRefName`. A
  // fork's head ref name is the contributor's branch — commonly `main` — so that would
  // fetch/review the BASE repository's branch and mark unrelated code ready. The provider
  // populates `isCrossRepository`, so the handler refuses the review. (The real Gitea
  // provider reads PRs over a synchronous HTTP client that a same-process test server
  // would deadlock, so the repo-host resolver is injected with a fake here.)
  test('fails closed on a non-GitHub (Gitea) forked PR instead of reviewing the base branch', async () => {
    const runner = sequenceRunner([]); // no git/agent call should run — the guard fires first
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = SESSION({
      // A Gitea repo host: no `gh` runner is resolved, so the synthetic PR-ref path never
      // applies and the head-branch convention would otherwise adopt the fork `headRefName`.
      repoHostProvider: {
        provider: 'gitea',
        gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' },
        auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
      },
    });
    // Stand in for the Gitea provider: a cross-repository PR whose head ref name is the
    // contributor's fork branch (`main`), with NO `gh` runner (the non-GitHub host).
    const resolveRepoHost = async () => ({
      kind: 'gitea',
      provider: {
        getPullRequest: () => ({
          ok: true,
          value: { number: 99, url: 'https://gitea.example.com/acme/code/pulls/99', headRefName: 'main', state: 'OPEN', baseRefName: 'main', isCrossRepository: true },
        }),
      },
    });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://gitea.example.com/acme/code/issues/77',
        prUrl: 'https://gitea.example.com/acme/code/pulls/99',
        labels: ['agent:codex', 'status:needs-review'],
        // no `branch` recorded — the PR head is resolved from prUrl and lives on a fork
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock, resolveRepoHost,
    )(task);

    expect(result.result).toBe('failed');
    // The refusal names the fork, the PR, and the branch it would otherwise have reviewed.
    expect(result.error).toMatch(/fork|cross-repository/i);
    expect(result.error).toMatch(/PR #99/);
    expect(result.error).toContain("'main'");
    // Nothing was materialized or fetched — the guard fires before touching any branch —
    // and the issue-scoped lock the worktree path acquired is released.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
  });

  // Conflict handoff (issue #456 review follow-up): a worktree-mode review that
  // detects a merge conflict must FREE the per-issue worktree before returning
  // `conflict`. The downstream conflict_resolution phase runs in the canonical
  // checkout and does `git checkout -B <prBranch>`, which Git refuses while the
  // branch is still held by the review worktree — so a conflicted PR would be
  // queued into a phase that immediately fails unless the worktree is removed.
  function worktreeConflictRunner(removeResult = { stdout: '', stderr: '', exitCode: 0 }) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },       // git rev-parse refs/heads/ai/issue-77 (exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin ai/issue-77 --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD (on PR head)
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (preflight) — clean
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'CONFLICT (content): Merge conflict in src/auth.ts', stderr: '', exitCode: 0 }, // codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (post-review) — clean
      removeResult,                                             // git worktree remove --force --force <wt>
    ]);
  }

  test('frees the per-issue worktree before returning conflict so conflict_resolution can check out the branch', async () => {
    const wt = worktreePath();
    const runner = worktreeConflictRunner();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('conflict');

    // The held branch was released by removing the review worktree, run in the
    // canonical checkout (where conflict_resolution will check the branch out).
    const remove = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(remove).toBeDefined();
    expect(remove.args).toEqual(['worktree', 'remove', '--force', '--force', wt]);
    expect(remove.opts.cwd).toBe(repoRoot);

    // Removal happened before the handler returned (i.e. it was the last git call),
    // and the review agent had already run against the worktree.
    const removeIdx = runner.calls.indexOf(remove);
    const codexIdx = runner.calls.findIndex((c) => c.cmd === 'codex');
    expect(codexIdx).toBeLessThan(removeIdx);

    // The advisory lock is still released independently.
    expect(lock.calls.release).toHaveLength(1);
  });

  test('escalates to a human (not conflict) when freeing the worktree before the conflict handoff fails', async () => {
    const wt = worktreePath();
    const runner = worktreeConflictRunner({ stdout: '', stderr: 'fatal: cannot remove working tree', exitCode: 1 });
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    // A failed removal must NOT queue conflict_resolution against a still-held
    // branch — it blocks for a human and surfaces the worktree path to recover.
    expect(result.result).toBe('blocked');
    expect(result.message).toContain(wt);
    expect(result.message).toContain('conflict_resolution');
    // The removal was still attempted, and the lock is released regardless.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(lock.calls.release).toHaveLength(1);
  });

  // Artifact root inside the worktree is not freed (issue #729 review, P1): when
  // `session.artifactRoot` is configured to live INSIDE the managed issue worktree,
  // freeing that worktree before a `conflict` handoff would delete the artifact tree
  // (including the just-written review-result.json etc.) that `context.artifactDir`
  // still points to. The retained worktree is surfaced as a `blocked` human handoff,
  // NOT a `conflict` auto-queue (issue #729 review, P1 fix): a downstream
  // `conflict_resolution` runs in the canonical checkout and would fail immediately
  // trying to check out the PR branch this worktree still holds.
  test('escalates to a human instead of auto-queuing conflict_resolution when artifactRoot lives inside the worktree', async () => {
    const wt = worktreePath();
    mkdirSync(wt, { recursive: true });
    const inWorktreeArtifactRoot = join(wt, '.n8n-artifacts');
    const runner = worktreeConflictRunner();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const session = SESSION({ artifactRoot: inWorktreeArtifactRoot });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('blocked');
    expect(result.message).toContain('artifactRoot');
    expect(result.message).toContain(wt);
    // `git worktree remove` was never invoked — the worktree (and everything under
    // artifactRoot inside it) is left in place instead of being deleted.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
    expect(existsSync(wt)).toBe(true);
    expect(result.context.artifactDir).toBe(join(inWorktreeArtifactRoot, 'runs', 'run-review-1'));
    expect(existsSync(result.context.artifactDir)).toBe(true);
    expect(existsSync(join(result.context.artifactDir, 'review-result.json'))).toBe(true);
    expect(lock.calls.release).toHaveLength(1);
  });

  // needs_fix handoff for a SYNTHETIC `ai/pr-<n>` review (issue #459 review, P2): a
  // PR-url-only GitHub review materializes the worktree on the synthetic `ai/pr-<n>`
  // branch, but the implementation fix phase resolves the worktree on the PR's real
  // `headRefName` (e.g. `feature/custom`). `resolveIssueWorktree` refuses to reuse the
  // path while it is still on `ai/pr-<n>`, wedging the PR-url-only review/fix cycle —
  // so the review must remove the synthetic worktree before returning `needs_fix`.
  function syntheticNeedsFixRunner(removeResult = { stdout: '', stderr: '', exitCode: 0 }) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN', baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view 99
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/pr-99', stderr: '', exitCode: 0 },          // git rev-parse refs/heads/ai/pr-99 (synthetic name exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin pull/99/head --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD (on PR head)
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (preflight) — clean
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: '[P1] Null pointer in auth handler', stderr: '', exitCode: 0 }, // codex review — blocking finding
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (post-review) — clean
      removeResult,                                             // git worktree remove --force --force <wt>
    ]);
  }

  const prUrlOnlyTask = () => makeTask({
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      prUrl: 'https://github.com/m2dw/test-repo/pull/99',
      labels: ['agent:codex', 'status:needs-review'],
      // no `branch` recorded — the PR head is non-conventional, so the worktree
      // materializes on the synthetic `ai/pr-99` branch.
    },
  });

  test('frees the synthetic ai/pr-<n> worktree before returning needs_fix so the fix phase can re-materialize on the real head', async () => {
    const wt = worktreePath();
    const runner = syntheticNeedsFixRunner();
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(prUrlOnlyTask());

    expect(result.result).toBe('needs_fix');
    // The worktree was materialized on the synthetic per-PR branch (not the real head).
    expect(resolver.calls[0].branch).toBe('ai/pr-99');

    // The synthetic worktree was removed before the handoff so the fix phase can
    // resolve the worktree on the PR's real `headRefName`.
    const remove = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(remove).toBeDefined();
    expect(remove.args).toEqual(['worktree', 'remove', '--force', '--force', wt]);
    expect(remove.opts.cwd).toBe(repoRoot);
    // Removal happened after the review agent ran (i.e. as the final git call).
    const removeIdx = runner.calls.indexOf(remove);
    const codexIdx = runner.calls.findIndex((c) => c.cmd === 'codex');
    expect(codexIdx).toBeLessThan(removeIdx);

    expect(lock.calls.release).toHaveLength(1);
  });

  test('escalates to a human (not needs_fix) when freeing the synthetic worktree before the fix handoff fails', async () => {
    const runner = syntheticNeedsFixRunner({ stdout: '', stderr: 'fatal: cannot remove working tree', exitCode: 1 });
    const resolver = fakeWorktreeResolver(worktreePath(), { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(prUrlOnlyTask());

    // A failed removal must NOT queue a fix phase against a still-held synthetic
    // branch — it blocks for a human and surfaces the worktree path to recover.
    expect(result.result).toBe('blocked');
    expect(result.message).toContain('ai/pr-99');
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2 (issue #459): the synthetic-worktree release must ALSO run on the review-loop cap
  // handoff, not only on a plain `needs_fix`. The cap returns `blocked` for a human who
  // later requeues implementation, which resolves the worktree on the PR's real head —
  // `resolveIssueWorktree` would refuse the path while it is still on `ai/pr-<n>`. So the
  // cap path frees the synthetic worktree before escalating.
  test('frees the synthetic ai/pr-<n> worktree before the review-loop cap handoff', async () => {
    const wt = worktreePath();
    const runner = syntheticNeedsFixRunner();
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});
    // reviewCycles: 9 → this cycle is the 10th, hitting the default maxCycles=10 cap.
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:codex', 'status:needs-review'],
        reviewCycles: 9,
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    // The cap escalates to a human...
    expect(result.result).toBe('blocked');
    expect(result.context?.reviewLoopCapReached).toBe(true);
    expect(result.context?.reviewCycles).toBe(10);
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    // ...but the synthetic worktree is removed first so a later requeue to implementation
    // can re-materialize the worktree on the PR's real head.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(lock.calls.release).toHaveLength(1);
  });

  // Regression: a NON-synthetic worktree review (a recorded `ai/issue-<n>` branch) keeps
  // its worktree on a `needs_fix` — the fix phase resolves the same branch and reuses it,
  // so removing it would force a wasteful re-materialization (issue #459 review, P2).
  test('keeps the worktree on needs_fix when the review ran on the recorded issue branch (non-synthetic)', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },       // git rev-parse refs/heads/ai/issue-77 (exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin ai/issue-77 --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: '[P1] Null pointer in auth handler', stderr: '', exitCode: 0 }, // codex review — blocking finding
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (post-review)
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('needs_fix');
    // The worktree is left in place for the fix phase to reuse on the same branch.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2 (issue #459): a SYNTHETIC `ai/pr-<n>` review that PASSES (or otherwise hands off to
  // a human via `success`/`blocked`) must ALSO free the synthetic worktree, not only the
  // `needs_fix`/cap paths. If a human later returns the ready-for-human task to
  // implementation fixes, that phase resolves the worktree on the PR's real `headRefName`
  // and `resolveIssueWorktree` refuses the path while it is still on `ai/pr-<n>`. So the
  // terminal human-handoff return frees the synthetic worktree first.
  function syntheticSuccessRunner(removeResult = { stdout: '', stderr: '', exitCode: 0 }) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN', baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view 99
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/pr-99', stderr: '', exitCode: 0 },          // git rev-parse refs/heads/ai/pr-99 (synthetic name exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin pull/99/head --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD (on PR head)
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (preflight) — clean
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review — clean pass
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (post-review) — clean
      removeResult,                                             // git worktree remove --force --force <wt>
    ]);
  }

  test('frees the synthetic ai/pr-<n> worktree before the ready-for-human handoff on a passing review', async () => {
    const wt = worktreePath();
    const runner = syntheticSuccessRunner();
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(prUrlOnlyTask());

    expect(result.result).toBe('success');
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    // The synthetic worktree is removed before the handoff so a later human-requested
    // implementation fix can re-materialize the worktree on the PR's real `headRefName`.
    const remove = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(remove).toBeDefined();
    expect(remove.args).toEqual(['worktree', 'remove', '--force', '--force', wt]);
    expect(remove.opts.cwd).toBe(repoRoot);
    // Removal happened after the review agent ran (the final git call).
    const codexIdx = runner.calls.findIndex((c) => c.cmd === 'codex');
    expect(codexIdx).toBeLessThan(runner.calls.indexOf(remove));
    expect(lock.calls.release).toHaveLength(1);
  });

  test('escalates to a human when freeing the synthetic worktree before the ready-for-human handoff fails', async () => {
    const runner = syntheticSuccessRunner({ stdout: '', stderr: 'fatal: cannot remove working tree', exitCode: 1 });
    const resolver = fakeWorktreeResolver(worktreePath(), { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(prUrlOnlyTask());

    // A failed removal must not promote a task whose synthetic worktree still blocks a
    // later fix phase — it blocks for a human and surfaces the worktree to recover.
    expect(result.result).toBe('blocked');
    expect(result.message).toContain('ai/pr-99');
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(lock.calls.release).toHaveLength(1);
  });

  // Regression (issue #459): a NON-synthetic worktree review that PASSES keeps its worktree
  // — a later fix phase resolves the SAME `ai/issue-<n>` branch and reuses the path, so the
  // terminal handoff must not remove it.
  test('keeps the worktree on a passing review that ran on the recorded issue branch (non-synthetic)', async () => {
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');
    expect(resolver.calls[0].branch).toBe('ai/issue-77');
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2 (issue #472): an EARLY `blocked` exit — the Step 0 dependency-base check — can return
  // after the synthetic `ai/pr-<n>` worktree is already materialized but before the
  // post-classification synthetic cleanup. If that early exit leaves the issue path checked
  // out on `ai/pr-<n>`, a later human-requested implementation fix resolves the worktree on
  // the PR's real `headRefName` and `resolveIssueWorktree` refuses the path — wedging the
  // PR-url-only review/fix cycle. So the early blocked exit must free the synthetic worktree
  // first, exactly like the terminal handoffs below.
  const depSyntheticTask = () => makeTask({
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      prUrl: 'https://github.com/m2dw/test-repo/pull/99',
      labels: ['agent:codex', 'status:needs-review'],
      // no `branch` recorded → the PR head is non-conventional, so the worktree
      // materializes on the synthetic `ai/pr-99` branch.
      dependencyBase: {
        baseIssueNumber: 50,
        basePrNumber: 88,
        baseHeadRefName: 'ai/issue-50',
        basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
        baseHeadSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      },
    },
  });

  // Step 0 (dependency-base) runs after the worktree is materialized but before the preflight
  // status check, so a blocked exit here is the earliest one that can strand the synthetic
  // worktree.
  function depSyntheticBlockedRunner(liveBase = 'ai/issue-50', removeResult = { stdout: '', stderr: '', exitCode: 0 }) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN', baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view 99 (head resolution)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: 'ai/pr-99', stderr: '', exitCode: 0 },          // git rev-parse refs/heads/ai/pr-99 (synthetic name exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin pull/99/head --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD (on PR head)
      { stdout: JSON.stringify({ baseRefName: liveBase }), stderr: '', exitCode: 0 }, // gh pr view 99 --json baseRefName (Step 0 live-base check)
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (dirty check inside the early synthetic release — CLEAN, so the worktree is freed)
      removeResult,                                             // git worktree remove --force --force <wt> (early blocked-exit synthetic cleanup, issue #472 P2)
    ]);
  }

  test('frees the synthetic ai/pr-<n> worktree before the early Step 0 dependency-base blocked exit', async () => {
    const wt = worktreePath();
    const runner = depSyntheticBlockedRunner('ai/issue-50');
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(depSyntheticTask());

    // The dependency-base check blocks because the live base still targets the blocker branch.
    expect(result.result).toBe('blocked');
    expect(result.context?.livePrBase).toBe('ai/issue-50');
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    // The review never proceeds to the agent on a wrong live base.
    expect(runner.calls.some((c) => c.cmd === 'codex')).toBe(false);
    // The synthetic worktree is removed before the human handoff so a later requeue to
    // implementation can re-materialize the worktree on the PR's real `headRefName`.
    const remove = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(remove).toBeDefined();
    expect(remove.args).toEqual(['worktree', 'remove', '--force', '--force', wt]);
    expect(remove.opts.cwd).toBe(repoRoot);
    expect(lock.calls.release).toHaveLength(1);
  });

  test('surfaces the leftover synthetic worktree when its removal fails on the early Step 0 blocked exit', async () => {
    const runner = depSyntheticBlockedRunner('ai/issue-50', { stdout: '', stderr: 'fatal: cannot remove working tree', exitCode: 1 });
    const resolver = fakeWorktreeResolver(worktreePath(), { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(depSyntheticTask());

    // Still a human handoff, but the message now names the still-held synthetic worktree so a
    // human can remove it before the task is returned to implementation.
    expect(result.result).toBe('blocked');
    expect(result.context?.livePrBase).toBe('ai/issue-50');
    expect(result.message).toContain('ai/issue-50'); // original dependency-base reason preserved
    expect(result.message).toContain('ai/pr-99');     // appended leftover-worktree note
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2 (issue #472 review): the Step 0 dependency-base block runs BEFORE the Step 1 dirty
  // preflight, so a REUSED synthetic `ai/pr-<n>` worktree that is already dirty (staged/
  // untracked leftovers from an interrupted review) must NOT be force-removed on this early
  // blocked exit. `git worktree remove --force --force` would delete those changes before a
  // human can inspect or recover them. The worktree is preserved and its path surfaced,
  // mirroring the Step 1 dirty-preflight handoff — the dependency-base reason is still kept.
  function depSyntheticDirtyBlockedRunner(liveBase = 'ai/issue-50', dirtyStatus = ' M src/foo.ts\n?? leftover.txt\n') {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN', baseRefName: 'main' }), stderr: '', exitCode: 0 }, // gh pr view 99 (head resolution)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main
      { stdout: 'ai/pr-99', stderr: '', exitCode: 0 },          // git rev-parse refs/heads/ai/pr-99 (synthetic name exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin pull/99/head --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD (on PR head)
      { stdout: JSON.stringify({ baseRefName: liveBase }), stderr: '', exitCode: 0 }, // gh pr view 99 --json baseRefName (Step 0 live-base check → blocks)
      { stdout: dirtyStatus, stderr: '', exitCode: 0 },         // git status --porcelain (dirty check inside the early synthetic release — DIRTY, so worktree is preserved)
      // No `git worktree remove`: the dirty synthetic worktree is left in place.
    ]);
  }

  test('preserves a dirty synthetic ai/pr-<n> worktree on the early Step 0 dependency-base blocked exit', async () => {
    const wt = worktreePath();
    const runner = depSyntheticDirtyBlockedRunner('ai/issue-50');
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(depSyntheticTask());

    // Still a human handoff for the wrong live base.
    expect(result.result).toBe('blocked');
    expect(result.context?.livePrBase).toBe('ai/issue-50');
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    // The review never proceeds to the agent on a wrong live base.
    expect(runner.calls.some((c) => c.cmd === 'codex')).toBe(false);
    // Critically: the DIRTY synthetic worktree is NOT force-removed — the uncommitted
    // changes are preserved for manual inspection/recovery instead of being deleted.
    const removed = runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removed).toBe(false);
    // The original dependency-base reason is preserved AND the leftover worktree path is
    // surfaced so the dirty work can be found and recovered.
    expect(result.message).toContain('ai/issue-50');
    expect(result.message).toContain(wt);
    expect(result.message).toMatch(/holds uncommitted changes and is left in place/);
    // The advisory lock is still released in the `finally`.
    expect(lock.calls.release).toHaveLength(1);
  });

  // P2 (issue #459): a recorded SAME-repository `branch` that the live PR confirms does NOT
  // match the PR's `headRefName` (stale or mistyped) must NOT be trusted — fetching/reviewing
  // that origin branch would promote code that is not in the PR. The handler reroutes to the
  // synthetic `ai/pr-<n>` path and materializes the live PR head by its ref instead.
  test('reroutes to the synthetic ai/pr-<n> path when the recorded same-repo branch does not match the live PR head', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/actual', state: 'OPEN', baseRefName: 'main', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (same-repo head differs from recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main (refresh review base)
      { stdout: '', stderr: '', exitCode: 1 },                  // git rev-parse refs/heads/ai/pr-99 (ABSENT — synthetic name)
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin pull/99/head:refs/remotes/origin/ai/pr-99
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (preflight)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification, issue #506)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review — clean pass
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                  // git worktree remove --force --force <wt> (synthetic handoff cleanup)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: false });
    const lock = fakeLock();
    const session = SESSION({});
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        branch: 'feature/stale', // recorded same-repo branch that no longer matches the PR head
        labels: ['agent:codex', 'status:needs-review'],
      },
    });

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    // The mismatched recorded `branch` is NOT trusted: the worktree uses the synthetic
    // per-PR name and the head is materialized by its PR ref, never `origin/feature/stale`.
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    const fetches = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetches.map((c) => c.args)).toEqual([
      ['fetch', 'origin', '+main:refs/remotes/origin/main'],
      ['fetch', 'origin', 'pull/99/head:refs/remotes/origin/ai/pr-99'],
    ]);
    expect(runner.calls.some((c) => c.args.some((a) => typeof a === 'string' && a.includes('feature/stale')))).toBe(false);
    // The PR was read once to validate the recorded branch against the live head.
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view')).toBe(true);
  });

  // Issue #477: rebuild-of-#443 guard. The review phase must execute on the SAME
  // per-issue worktree contract the current stack (#454–#470) established, NOT the
  // superseded #441/#442/#443 path. This consolidates that contract into one named
  // anti-regression test on the post-#470 stack: the resolver is invoked with the
  // new-stack contract (the issue's own `ai/issue-<n>` branch, diffed against the
  // freshly-fetched `origin/<base>`, fast-forward-tolerant), the review serializes on
  // the shared issue-scoped lock scope `<sessionId>::issue-<n>` (the same scope
  // `admin doctor` / `worktree release-lock` report), and a passing NON-synthetic
  // review preserves the worktree directory — matching #470's cleanup-preservation
  // contract so the downstream implementation phase reuses the same worktree.
  test('review executes on the current-stack per-issue worktree contract, not the superseded #443 path (issue #477)', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');

    // New-stack worktree contract: the resolver owns worktree materialization (the
    // #443 path predated this seam) and is asked for the issue's own branch, based on
    // the fetched `origin/<base>`, tolerant of a fast-forwardable behind-origin head.
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({
      repoRoot,
      sessionId: 'addon-dev',
      issueNumber: 77,
      branch: 'ai/issue-77',
      baseRef: 'origin/main',
      allowFastForward: true,
    });

    // The review serializes on the shared issue-scoped lock scope — the same scope the
    // rest of the stack (implementation, `admin doctor`, `worktree release-lock`) uses,
    // acquired once for this run and released on the success handoff.
    expect(lock.calls.acquire).toEqual([{ ownerId: 'run-review-1', sessionId: 'addon-dev', issueNumber: 77 }]);
    expect(lock.calls.release).toEqual([{ ownerId: 'run-review-1', sessionId: 'addon-dev', issueNumber: 77 }]);

    // #470 cleanup-preservation contract: a passing non-synthetic review leaves the
    // per-issue worktree directory in place (no `git worktree remove`) so the fix phase
    // reuses it on the same branch.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
  });

  // When the canonical repo has node_modules but the worktree doesn't, a symlink is
  // created so npm lifecycle scripts (tsc, jest) resolve without a separate install.
  test('symlinks canonical node_modules into the worktree when absent', async () => {
    const wt = worktreePath();
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(repoRoot, 'node_modules'), { recursive: true });

    // worktreeHappyRunner() doesn't include the git check-ignore entry; use an
    // inline runner so the node_modules gitignore probe doesn't shift subsequent
    // git pull / rev-list slots and cause the ahead-of-remote guard to fire.
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77', state: 'OPEN', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main:refs/remotes/origin/main
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },       // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS)
      { stdout: '', stderr: '', exitCode: 0 },                  // git check-ignore -q node_modules (gitignored → create symlink)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin ai/issue-77 --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (preflight) — clean
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                  // git diff origin/main...HEAD (codex diff classification)
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },// codex review
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (post-review) — clean
    ]);
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');
    const wtNodeModules = join(wt, 'node_modules');
    expect(existsSync(wtNodeModules)).toBe(true);
    expect(lstatSync(wtNodeModules).isSymbolicLink()).toBe(true);
  });

  // When canonical node_modules is also absent, no symlink is created and the review
  // still runs (the try/catch is non-fatal).
  test('does not create a node_modules symlink when canonical root has none', async () => {
    const wt = worktreePath();
    mkdirSync(wt, { recursive: true });
    // No canonical node_modules created

    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('success');
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });

  // Regression for issue #515: run-one-phase acquires the issue-scoped worktree lock
  // via acquirePhaseLock BEFORE invoking the handler. Without phaseLockOwnerId the
  // review handler would try to acquire the same lock, see it held, and return
  // `blocked` — a self-contention that prevented all worktree-enabled reviews.
  // When phaseLockOwnerId is set the handler must proceed without touching the lock.
  test('proceeds without re-acquiring the lock when the phase runner already holds it (phaseLockOwnerId set) — regression for issue #515', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt);
    // fakeLock defaults to locked:true — if the handler were to call acquire() it
    // would succeed here. But passing phaseLockOwnerId must skip acquire entirely.
    const lock = fakeLock();
    const session = SESSION({});

    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock, undefined, 'ctx-exec-id',
    )(wtTask());

    expect(result.result).toBe('success');
    // The handler must not have touched the lock at all — the phase runner owns it.
    expect(lock.calls.acquire).toHaveLength(0);
    expect(lock.calls.release).toHaveLength(0);
  });

  // Confirm that without phaseLockOwnerId a lock held by a DIFFERENT execution still
  // blocks the review — cross-execution isolation is not weakened by issue #515.
  test('still blocks when a different execution holds the lock and phaseLockOwnerId is absent', async () => {
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock({
      ok: true, locked: false, reason: 'lock_held',
      ownerContextId: 'other-run', ownerStartedAt: '2026-07-04T00:00:00.000Z',
    });
    const session = SESSION({});

    // No phaseLockOwnerId → handler acquires the lock itself and must detect contention.
    const result = await createReviewHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(wtTask());

    expect(result.result).toBe('blocked');
    expect(result.context?.reviewLockHeldBy).toBe('other-run');
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(0);
  });

});

// ---------------------------------------------------------------------------
// Diff classification and guardrail context in Claude/Gemini review prompts
// (issue #505)
//
// Claude and Gemini receive the full diff via stdin. The review prompt also
// includes a structured "Diff Classification" section (added/modified/deleted
// files) and a "Guardrail and Tooling Changes" section so the reviewer can
// identify deleted CI workflows, test files, or agent instruction files
// without inferring them from a large patch.
//
// Runner sequence for a Claude review (worktree-only, issue #456/#699):
//   0: gh pr view               (validate recorded branch)
//   1: git fetch origin +main:refs/remotes/origin/main
//   2: git rev-parse --verify --quiet refs/heads/<branch>
//   3: git pull --ff-only
//   4: git rev-list --count FETCH_HEAD..HEAD
//   5: git status --porcelain  (preflight)
//   6: git diff origin/main...HEAD (pre-verification diff classification, issue #506)
//   7: npm test                (Step 4 verification)
//   8: git diff origin/main...HEAD (Step 5 full diff for prompt)
//   9: claude -p               (Step 5 review agent)
//   10: git status --porcelain (Step 5.5 post-review cleanup check)
// ---------------------------------------------------------------------------

describe('review handler — diff classification in Claude prompt (issue #505)', () => {
  const CLAUDE_SESSION = (overrides = {}) => SESSION({
    defaults: { implementationAgent: 'claude', reviewAgent: 'claude', researchAgent: 'gemini' },
    ...overrides,
  });
  const CLAUDE_CONTEXT = (overrides = {}) => CONTEXT({ session: CLAUDE_SESSION(), ...overrides });

  function claudeRunner({ diffOutput = '', reviewOutput = 'No issues found.' } = {}) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: diffOutput, stderr: '', exitCode: 0 },                               // git diff origin/main...HEAD (pre-verification, issue #506)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 },                       // npm test
      { stdout: diffOutput, stderr: '', exitCode: 0 },                               // git diff origin/main...HEAD (full diff for prompt)
      { stdout: reviewOutput, stderr: '', exitCode: 0 },                             // claude -p
      { stdout: '', stderr: '', exitCode: 0 },                                        // git status (post-review)
    ]);
  }

  const DELETED_WORKFLOW_DIFF = [
    'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
    'deleted file mode 100644',
    'index abc1234..0000000',
    '--- a/.github/workflows/ci.yml',
    '+++ /dev/null',
    '@@ -1,5 +0,0 @@',
    '-name: CI',
    '-on: [push, pull_request]',
    '-jobs:',
    '-  test:',
    '-    runs-on: ubuntu-latest',
  ].join('\n');

  const SOURCE_ONLY_DIFF = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index abc1234..def5678 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1,3 +1,3 @@',
    ' const login = () => {};',
    '-const old = 1;',
    '+const updated = 1;',
  ].join('\n');

  test('deleted CI workflow appears in Diff Classification section of review-prompt.md', async () => {
    const runner = claudeRunner({ diffOutput: DELETED_WORKFLOW_DIFF });
    await createReviewHandler(CLAUDE_CONTEXT(), runner)(makeTask({ reviewAgent: 'claude' }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).toContain('## Diff Classification');
    expect(prompt).toContain('.github/workflows/ci.yml');
    expect(prompt).toContain('Deleted');
  });

  test('deleted CI workflow appears in Guardrail and Tooling Changes section', async () => {
    const runner = claudeRunner({ diffOutput: DELETED_WORKFLOW_DIFF });
    await createReviewHandler(CLAUDE_CONTEXT(), runner)(makeTask({ reviewAgent: 'claude' }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).toContain('## Guardrail and Tooling Changes');
    expect(prompt).toContain('**DELETED (1) [requires justification]:** .github/workflows/ci.yml');
    expect(prompt).toContain('[requires justification]');
  });

  test('deleted guardrail includes a note about justification in prompt', async () => {
    const runner = claudeRunner({ diffOutput: DELETED_WORKFLOW_DIFF });
    await createReviewHandler(CLAUDE_CONTEXT(), runner)(makeTask({ reviewAgent: 'claude' }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).toMatch(/unexplained deletion/i);
  });

  test('source-only diff does not include Guardrail and Tooling Changes section', async () => {
    const runner = claudeRunner({ diffOutput: SOURCE_ONLY_DIFF });
    await createReviewHandler(CLAUDE_CONTEXT(), runner)(makeTask({ reviewAgent: 'claude' }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).not.toContain('## Guardrail and Tooling Changes');
  });

  test('source-only diff includes Diff Classification section with modified file', async () => {
    const runner = claudeRunner({ diffOutput: SOURCE_ONLY_DIFF });
    await createReviewHandler(CLAUDE_CONTEXT(), runner)(makeTask({ reviewAgent: 'claude' }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).toContain('## Diff Classification');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('Modified');
  });

  test('review prompt still includes PR Diff section after classification sections', async () => {
    const runner = claudeRunner({ diffOutput: DELETED_WORKFLOW_DIFF });
    await createReviewHandler(CLAUDE_CONTEXT(), runner)(makeTask({ reviewAgent: 'claude' }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).toContain('## PR Diff');
    // Classification sections come before the raw diff
    expect(prompt.indexOf('## Diff Classification')).toBeLessThan(prompt.indexOf('## PR Diff'));
  });

  test('review instructions include guardrail and scope-fit dimensions', async () => {
    const runner = claudeRunner({ diffOutput: SOURCE_ONLY_DIFF });
    await createReviewHandler(CLAUDE_CONTEXT(), runner)(makeTask({ reviewAgent: 'claude' }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).toMatch(/Guardrail and tooling changes/i);
    expect(prompt).toMatch(/Scope fit/i);
  });

  test('Diff Classification file list is capped at 30 per category with (+N more) suffix, but PR Diff includes all files', async () => {
    // Build a diff with 35 modified source files to exceed MAX_CLASSIFICATION_FILES_PER_CATEGORY (30).
    const fileDiff = (i) => [
      `diff --git a/src/file${String(i).padStart(2, '0')}.ts b/src/file${String(i).padStart(2, '0')}.ts`,
      'index abc1234..def5678 100644',
      `--- a/src/file${String(i).padStart(2, '0')}.ts`,
      `+++ b/src/file${String(i).padStart(2, '0')}.ts`,
      '@@ -1,1 +1,1 @@',
      '-const old = 1;',
      '+const updated = 1;',
    ].join('\n');
    const largeDiff = Array.from({ length: 35 }, (_, i) => fileDiff(i + 1)).join('\n');

    const runner = claudeRunner({ diffOutput: largeDiff });
    await createReviewHandler(CLAUDE_CONTEXT(), runner)(makeTask({ reviewAgent: 'claude' }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    // The classification section shows 35 total but only 30 names; excess is "(+5 more)".
    expect(prompt).toContain('Modified (35)');
    expect(prompt).toContain('(+5 more)');
    // First file present in both classification and diff sections.
    expect(prompt).toContain('src/file01.ts');
    // The 31st file is absent from the classification list but present in the full PR Diff.
    expect(prompt).toContain('src/file31.ts');
  });
});

describe('review handler — predecessor context in review brief (issue #505)', () => {
  test('blockedBy in task context surfaces a Predecessor Issues section in all agents', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: {
        ...makeTask().context,
        blockedBy: [{ issueNumber: 42, state: 'closed' }],
      },
    });
    await createReviewHandler(CONTEXT(), runner)(task);
    // For Codex the brief is written to review-prompt.md as the --title artifact.
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).toContain('## Predecessor Issues');
    expect(prompt).toContain('Issue #42');
    expect(prompt).toMatch(/pre-existing baseline/i);
  });

  test('no Predecessor Issues section when blockedBy is absent', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).not.toContain('## Predecessor Issues');
  });
});

// ---------------------------------------------------------------------------
// Conflict-specific review after semantic conflict escalation (issue #540)
// ---------------------------------------------------------------------------

describe('review handler — conflict-specific review (issue #540)', () => {
  // Runner that returns a given review output on the Codex (default) path.
  function codexReviewRunner(reviewOutput) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },                                 // git diff origin/main...HEAD (diff classification)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 },                // npm test (verification)
      { stdout: reviewOutput, stderr: '', exitCode: 0 },                      // codex review
      { stdout: '', stderr: '', exitCode: 0 },                                 // git status (post-review)
      { stdout: '', stderr: '', exitCode: 0 },                                 // git worktree remove --force --force <wt> (free review worktree on conflict, issue #456)
    ]);
  }

  test('post-conflict review prompt includes the Post-Conflict-Resolution Review section', async () => {
    const task = makeTask({
      context: {
        ...makeTask().context,
        postConflictReview: true,
      },
    });
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(task);
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).toContain('## Post-Conflict-Resolution Review');
    expect(prompt).toMatch(/one-sided resolution/i);
    expect(prompt).toMatch(/discarded behavior/i);
  });

  test('post-conflict review prompt is absent when task did not come from conflict_resolution', async () => {
    const runner = happyRunner();
    await createReviewHandler(CONTEXT(), runner)(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');
    expect(prompt).not.toContain('## Post-Conflict-Resolution Review');
  });

  test('one-sided semantic resolution detected by reviewer routes to needs_fix (implementation), not conflict_resolution', async () => {
    // A post-conflict review where the reviewer flags a one-sided resolution with [P1].
    // The [P1] marker makes this needs_fix — it must NOT re-enter conflict_resolution.
    const task = makeTask({
      context: {
        ...makeTask().context,
        postConflictReview: true,
      },
    });
    const reviewOutput = '[P1] The resolution discards the PR\'s rate-limiting feature and only preserves the main-side behavior. Both sides must be preserved.';
    const runner = codexReviewRunner(reviewOutput);
    const result = await createReviewHandler(CONTEXT(), runner)(task);
    expect(result.result).toBe('needs_fix');
    // conflict_resolution is only triggered by the `conflict` result, never `needs_fix`
    expect(result.context?.classification).toBe('needs_fix');
    // Conflict-review tracking is reset so a subsequent implementation→review cycle starts fresh
    expect(result.context?.postConflictReview).toBeNull();
    expect(result.context?.conflictReviewCycles).toBeNull();
  });

  test('ordinary code-review failure routes to needs_fix (implementation) and must not route to conflict_resolution', async () => {
    // An ordinary P1 bug finding — no relationship to conflict resolution.
    const reviewOutput = '[P1] Missing input validation: the login handler does not check for empty username.';
    const runner = codexReviewRunner(reviewOutput);
    const result = await createReviewHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.classification).toBe('needs_fix');
  });

  test('conflict-review loop cap escalates to blocked after repeated conflict signals post-resolution', async () => {
    // Simulate: conflictReviewCycles = 1 (already used one cycle), DEFAULT cap is 2.
    // On this review, completedCycles = 2 >= 2, so capReached = true.
    const task = makeTask({
      context: {
        ...makeTask().context,
        postConflictReview: true,
        conflictReviewCycles: 1,
      },
    });
    // Review output contains structural git conflict markers — would normally route to conflict_resolution.
    const reviewOutput = '<<<<<<< HEAD\nold implementation\n=======\nnew implementation\n>>>>>>> feature-branch';
    const runner = codexReviewRunner(reviewOutput);
    const result = await createReviewHandler(CONTEXT(), runner)(task);
    expect(result.result).toBe('blocked');
    expect(result.context?.conflictReviewLoopCapReached).toBe(true);
    expect(result.context?.conflictReviewCycles).toBe(2);
    expect(result.context?.conflictReviewLoopMaxCycles).toBe(2);
    expect(result.message).toMatch(/conflict-review loop cap/i);
  });

  test('first post-conflict conflict signal does not cap — returns conflict with updated cycle count', async () => {
    // conflictReviewCycles not set yet (first cycle). completedCycles = 1 < 2, so not capped.
    const task = makeTask({
      context: {
        ...makeTask().context,
        postConflictReview: true,
      },
    });
    const reviewOutput = '<<<<<<< HEAD\nold code\n=======\nnew code\n>>>>>>> main';
    const runner = codexReviewRunner(reviewOutput);
    const result = await createReviewHandler(CONTEXT(), runner)(task);
    expect(result.result).toBe('conflict');
    expect(result.context?.conflictReviewCycles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Issue-required verification (issue #542)
// ---------------------------------------------------------------------------

describe('review handler — issue-required verification', () => {
  // Runner for the setup + verification steps without a review agent call.
  // Used when Step 4.5 is expected to block before the review agent runs.
  // Actual order (worktree-only, issue #456/#699): gh pr view → fetch base →
  //               rev-parse branch exists → pull --ff-only → rev-list --count →
  //               git status (preflight) → git diff (pre-classification) →
  //               npm test (verification) [Step 4.5 blocks — no review agent call]
  function preReviewRunner() {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse --verify --quiet refs/heads/<branch>
      { stdout: '', stderr: '', exitCode: 0 },              // git pull origin <branch> --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-classification, issue #506)
      { stdout: '', stderr: '', exitCode: 0 },              // npm test (verification passes)
      // Step 4.5 returns blocked — no review agent call follows
    ]);
  }

  test('all required commands passed — succeeds and includes issueRequiredVerifications in context', async () => {
    // Issue body declares `npm test` as required; session.verification has { test: 'npm test' } — matched.
    const task = makeTask({
      context: {
        ...makeTask().context,
        body: '## Verification\n\n- `npm test`\n',
      },
    });
    const result = await createReviewHandler(CONTEXT(), happyRunner())(task);
    expect(result.result).toBe('success');
    expect(Array.isArray(result.context?.issueRequiredVerifications)).toBe(true);
    const verifications = result.context?.issueRequiredVerifications;
    expect(verifications).toHaveLength(1);
    expect(verifications[0]).toMatchObject({ command: 'npm test', status: 'passed' });
  });

  test('required command not run — returns blocked with missing command listed', async () => {
    // Issue body requires `npm run test:e2e` but session.verification only has `npm test`.
    const task = makeTask({
      context: {
        ...makeTask().context,
        body: '## Verification\n\n```\nnpm run test:e2e\n```\n',
      },
    });
    const result = await createReviewHandler(CONTEXT(), preReviewRunner())(task);
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/npm run test:e2e/);
    expect(result.message).toMatch(/not run/i);
  });

  test('required command not run — context carries issueRequiredVerifications with not_run status', async () => {
    const task = makeTask({
      context: {
        ...makeTask().context,
        body: '## Verification\n\n```\nnpm run test:e2e\n```\n',
      },
    });
    const result = await createReviewHandler(CONTEXT(), preReviewRunner())(task);
    expect(result.result).toBe('blocked');
    const verifications = result.context?.issueRequiredVerifications;
    expect(Array.isArray(verifications)).toBe(true);
    expect(verifications).toHaveLength(1);
    expect(verifications[0]).toMatchObject({ command: 'npm run test:e2e', status: 'not_run' });
  });

  test('required command not run — context carries missingVerificationCommands', async () => {
    const task = makeTask({
      context: {
        ...makeTask().context,
        body: '## Verification\n\n- `npm run test:e2e`\n',
      },
    });
    const result = await createReviewHandler(CONTEXT(), preReviewRunner())(task);
    expect(result.result).toBe('blocked');
    expect(Array.isArray(result.context?.missingVerificationCommands)).toBe(true);
    expect(result.context?.missingVerificationCommands).toContain('npm run test:e2e');
  });

  test('required command failed — existing Step 4 catches it and returns needs_fix', async () => {
    // Issue body requires `npm test` AND session.verification has it, but the command fails.
    const task = makeTask({
      context: {
        ...makeTask().context,
        body: '## Verification\n\n- `npm test`\n',
      },
    });
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99 (validate recorded branch)
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse --verify --quiet refs/heads/<branch>
      { stdout: '', stderr: '', exitCode: 0 },              // git pull origin <branch> --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git diff origin/main...HEAD (pre-classification, issue #506)
      { stdout: '', stderr: 'FAIL src/foo.test.js', exitCode: 1 }, // npm test fails
    ]);
    const result = await createReviewHandler(CONTEXT(), runner)(task);
    expect(result.result).toBe('needs_fix');
    expect(result.context?.verificationFailedStep).toBe('test');
  });

  test('command requires tool approval / human action — returns blocked (not run scenario)', async () => {
    // A command that requires human/tool setup is indistinguishable from "not run"
    // at review time. It must route to blocked so a human can investigate.
    const task = makeTask({
      context: {
        ...makeTask().context,
        body: [
          '## Test Plan',
          '',
          '```bash',
          'npm run build:demo',
          'npm run test:e2e',
          '```',
        ].join('\n'),
      },
    });
    // session.verification only runs `npm test`; the two issue-required commands are not covered.
    const result = await createReviewHandler(CONTEXT(), preReviewRunner())(task);
    expect(result.result).toBe('blocked');
    const missing = result.context?.missingVerificationCommands;
    expect(missing).toContain('npm run build:demo');
    expect(missing).toContain('npm run test:e2e');
  });

  test('no verification section in issue body — no issue-required check, review proceeds normally', async () => {
    // Issue body with no Verification/Test Plan section should not trigger Step 4.5.
    const task = makeTask({
      context: {
        ...makeTask().context,
        body: '## Background\nThis is a login rate limiting feature.\n\n## Implementation\nAdd rate limiting.',
      },
    });
    const result = await createReviewHandler(CONTEXT(), happyRunner())(task);
    expect(result.result).toBe('success');
    expect(result.context?.issueRequiredVerifications).toBeUndefined();
  });

  test('no body in task context — no issue-required check, review proceeds normally', async () => {
    // Task has no body (ctx.body absent) — Step 4.5 is a no-op.
    const result = await createReviewHandler(CONTEXT(), happyRunner())(makeTask());
    expect(result.result).toBe('success');
    expect(result.context?.issueRequiredVerifications).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structured finding envelope (issue #841)
//
// The protocol is gated behind `session.reviewDispute.enabled`. Every existing
// test above runs with it absent, so those assertions are themselves the
// compatibility proof: with the gate off, the review lane is unchanged.
// ---------------------------------------------------------------------------

describe('review handler — structured finding envelope (issue #841)', () => {
  function envelope(body) {
    return `${REVIEW_FINDINGS_MARKER}\n${JSON.stringify(body)}\n${REVIEW_FINDINGS_END_MARKER}`;
  }

  const FINDING = {
    version: 1,
    severity: 'P1',
    violatedContract: 'Acceptance criterion: the fix must reject an unauthenticated caller',
    preconditions: 'A request arrives with no session cookie',
    failureScenario: 'The handler returns 200 and the caller reads another tenant rate-limit state',
    affectedBoundary: 'src/handlers/review.ts',
    requiredOutcome: 'An unauthenticated request must be rejected with 401 before any state read',
    evidenceRefs: [{ kind: 'file', path: 'src/handlers/review.ts', startLine: 10, endLine: 20 }],
  };

  // Claude review call order (see the Claude describe block above), plus the
  // `git ls-files -s` evidence capture this Issue adds — issued lazily, so only a
  // run that actually resolves an evidence reference consumes that step.
  function claudeRunner(reviewOutput, tail = []) {
    return sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin +main:refs/remotes/origin/main
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 }, // git rev-parse (branch exists)
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },             // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new code', stderr: '', exitCode: 0 }, // git diff (classification)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new code', stderr: '', exitCode: 0 }, // git diff (prompt)
      { stdout: reviewOutput, stderr: '', exitCode: 0 },    // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (post-review) — clean
      ...tail,
    ]);
  }

  /** One tracked regular file, in `git ls-files -s` format. */
  const LS_FILES = {
    stdout: '100644 0000000000000000000000000000000000000000 0\tsrc/handlers/review.ts\n',
    stderr: '',
    exitCode: 0,
  };

  // A `file` reference names lines INSIDE a document, so the resolver reads the
  // reviewed checkout — the per-issue worktree — to check them: the cited path has
  // to exist there, with the cited range inside it. 40 lines covers FINDING's 10–20.
  beforeEach(() => {
    mkdirSync(join(worktreePath(), 'src', 'handlers'), { recursive: true });
    writeFileSync(
      join(worktreePath(), 'src', 'handlers', 'review.ts'),
      `${Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`,
      'utf8',
    );
  });

  function claudeContext({ enabled = true, ...overrides } = {}) {
    return CONTEXT({
      session: SESSION({
        defaults: { implementationAgent: 'claude', reviewAgent: 'claude', researchAgent: 'gemini' },
        ...(enabled ? { reviewDispute: { enabled: true } } : {}),
      }),
      ...overrides,
    });
  }

  const claudeTask = (overrides = {}) => makeTask({ reviewAgent: 'claude', ...overrides });

  const promptText = () => readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-prompt.md'), 'utf8');

  // -------------------------------------------------------------------------
  // Gate and prompt
  // -------------------------------------------------------------------------

  test('with the protocol off, the brief carries no output contract and no findings state is written', async () => {
    const result = await createReviewHandler(claudeContext({ enabled: false }), claudeRunner('No blocking issues.'))(claudeTask());
    expect(result.result).toBe('success');
    expect(promptText()).not.toContain(REVIEW_FINDINGS_MARKER);
    expect(result.context?.reviewFindings).toBeUndefined();
    expect(result.context?.reviewDispute).toBeUndefined();
  });

  test('with the protocol on, the brief carries the output contract', async () => {
    await createReviewHandler(claudeContext(), claudeRunner(envelope({ version: 1, status: 'success' })))(claudeTask());
    const prompt = promptText();
    expect(prompt).toContain(REVIEW_FINDINGS_MARKER);
    expect(prompt).toContain(REVIEW_FINDINGS_END_MARKER);
    expect(prompt).toContain('Structured Finding Output (required)');
  });

  test('a review agent that cannot emit the schema takes the explicit compatibility path', async () => {
    // Codex composes its own review report from a `--title` brief, so it is never
    // asked for an envelope and its absence is a configuration fact, not a
    // malformed-output diagnostic. Routing stays exactly today's.
    const context = CONTEXT({ session: SESSION({ reviewDispute: { enabled: true } }) });
    const result = await createReviewHandler(context, happyRunner())(makeTask());
    expect(result.result).toBe('success');
    expect(promptText()).not.toContain(REVIEW_FINDINGS_MARKER);
    expect(result.context?.reviewFindings).toMatchObject({
      mode: 'unsupported',
      agentId: 'codex',
      compatibility: 'prompt-not-agent-authored',
    });
    expect(result.context?.reviewDispute).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Invalid protocol configuration
  // -------------------------------------------------------------------------

  function invalidDisputeContext(reviewDispute) {
    return CONTEXT({
      session: SESSION({
        defaults: { implementationAgent: 'claude', reviewAgent: 'claude', researchAgent: 'gemini' },
        reviewDispute,
      }),
    });
  }

  test('an invalid review-dispute configuration fails the review before the agent is invoked', async () => {
    // Session load rejects an invalid `reviewDispute` block (§6.1), so reaching
    // one here means a hand-built session. It must not degrade to legacy review:
    // an invalid limit would otherwise bypass structured-finding enforcement.
    const runner = claudeRunner(envelope({ version: 1, status: 'success' }));
    const result = await createReviewHandler(
      invalidDisputeContext({ enabled: true, limits: { maxVersionsPerLineage: 0 } }),
      runner,
    )(claudeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toContain('session.reviewDispute');
    expect(result.error).toContain('reviewDispute.limits.maxVersionsPerLineage');
    expect(result.context.reviewDisputeConfigError).toEqual({
      paths: ['reviewDispute.limits.maxVersionsPerLineage'],
      codes: ['below-minimum'],
    });
    // Nothing structured was produced, so nothing structured is persisted.
    expect(result.context.reviewFindings).toBeUndefined();
    expect(result.context.reviewDispute).toBeUndefined();
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
    const artifact = JSON.parse(
      readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-result.json'), 'utf8'),
    );
    expect(artifact).toMatchObject({ success: false, step: 'review-dispute-config:invalid' });
  });

  test('an invalid configuration fails closed even when the protocol is switched off', async () => {
    // `enabled: false` does not make a malformed block benign — a review that
    // passed under it would be a clean success produced by an unresolvable
    // configuration.
    const result = await createReviewHandler(
      invalidDisputeContext({ enabled: false, limits: { maxRebuttalsPerVersion: 9 } }),
      claudeRunner('No blocking issues.'),
    )(claudeTask());
    expect(result.result).toBe('failed');
    expect(result.context.reviewDisputeConfigError.codes).toEqual(['above-default']);
  });

  // -------------------------------------------------------------------------
  // Admitted envelopes
  // -------------------------------------------------------------------------

  test('a findings envelope routes to needs_fix and persists one open version-1 lineage', async () => {
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING] });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewFindings).toMatchObject({
      mode: 'admitted', status: 'findings', admitted: 1, reviewStructure: 'structured',
    });
    const lineages = Object.values(result.context.reviewDispute.lineages);
    expect(lineages).toHaveLength(1);
    expect(lineages[0]).toMatchObject({
      state: 'open', version: 1, severity: 'P1', humanGate: false, affectedBoundary: 'src/handlers/review.ts',
    });
    expect(result.context.reviewDispute.version).toBe(1);
  });

  test('the classifier alone would have passed that review — the envelope is what blocks it', async () => {
    // The severity policy is unchanged, but `"severity": "P1"` inside JSON is not
    // the `[P1]` marker the prose classifier looks for. Without the envelope the
    // same output reads as a clean pass, which is exactly the gap this closes.
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING] });
    const off = await createReviewHandler(claudeContext({ enabled: false }), claudeRunner(output))(claudeTask());
    expect(off.result).toBe('success');
    const on = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(on.result).toBe('needs_fix');
  });

  test('the raw review output stays local while only bounded state reaches task context', async () => {
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING] });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    const dir = join(artifactRoot, 'runs', 'run-review-1');
    // Complete raw output, and the full §10.2 finding records, are artifacts.
    expect(readFileSync(join(dir, 'review-output.md'), 'utf8')).toContain(REVIEW_FINDINGS_MARKER);
    const artifact = JSON.parse(readFileSync(join(dir, 'review-findings.json'), 'utf8'));
    expect(artifact.findings[0].failureScenario).toBe(FINDING.failureScenario);
    expect(artifact.findings[0].reviewerMeta.reviewRunId).toBe('run-review-1');
    // The persisted block carries literals and counters only — no prose, no
    // evidence, no reviewer metadata.
    const lineage = Object.values(result.context.reviewDispute.lineages)[0];
    expect(Object.keys(lineage).sort()).toEqual(
      ['affectedBoundary', 'counters', 'humanGate', 'lineageId', 'rebuttedVersions', 'severity', 'state', 'version'],
    );
  });

  test('multiple findings persist one lineage each', async () => {
    const second = {
      ...FINDING,
      severity: 'P2',
      violatedContract: 'Acceptance criterion: the retry budget must be bounded',
      failureScenario: 'A transient failure retries forever and the worker never yields',
      affectedBoundary: 'src/handlers/review.ts#retry',
    };
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING, second] });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(result.result).toBe('needs_fix');
    expect(Object.keys(result.context.reviewDispute.lineages)).toHaveLength(2);
    expect(result.context.reviewFindings.admitted).toBe(2);
  });

  test('a success envelope passes and records a fully structured review with no lineages', async () => {
    const result = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'success' })),
    )(claudeTask());
    expect(result.result).toBe('success');
    expect(result.context.reviewDispute.lineages).toEqual({});
    expect(result.context.reviewDispute.reviewStructure).toBe('structured');
  });

  test('a blocked envelope escalates to a human', async () => {
    const result = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'blocked', blockedReason: 'insufficient_context' })),
    )(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings).toMatchObject({ status: 'blocked', blockedReason: 'insufficient_context' });
  });

  // -------------------------------------------------------------------------
  // Fail-closed paths
  // -------------------------------------------------------------------------

  test('an invalid envelope persists no lineage and never passes as a clean review', async () => {
    const result = await createReviewHandler(
      claudeContext(),
      claudeRunner(`${REVIEW_FINDINGS_MARKER}\n{"version":1,"status":"findings"\n${REVIEW_FINDINGS_END_MARKER}`),
    )(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewDispute).toBeUndefined();
    expect(result.context.reviewFindings).toMatchObject({ mode: 'rejected' });
    expect(result.context.reviewFindings.rejection.reason).toBe('unparseable');
  });

  test('a duplicated finding id rejects the whole set rather than persisting part of it', async () => {
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING, { ...FINDING }] });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewDispute).toBeUndefined();
    expect(result.context.reviewFindings.rejection.reason).toBe('duplicate-version');
  });

  test('an unresolvable evidence reference rejects the finding', async () => {
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING] });
    // `git ls-files` lists a different file, so the reference resolves to nothing.
    const emptyIndex = { stdout: '100644 0000 0\tsrc/other.ts\n', stderr: '', exitCode: 0 };
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [emptyIndex]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');
  });

  test('a reference to lines the tracked file does not have is refused', async () => {
    // The path is tracked and really on disk; lines 200–210 are not. Tracking is
    // only half the reference, so the range is checked against the file itself
    // rather than admitted because the path checked out.
    const output = envelope({
      version: 1,
      status: 'findings',
      findings: [
        { ...FINDING, evidenceRefs: [{ kind: 'file', path: 'src/handlers/review.ts', startLine: 200, endLine: 210 }] },
      ],
    });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewDispute).toBeUndefined();
    expect(result.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');
  });

  test('a reference to a document section the file does not carry is refused', async () => {
    mkdirSync(join(worktreePath(), 'docs'), { recursive: true });
    writeFileSync(join(worktreePath(), 'docs', 'review-dispute-contract.md'), '# Contract\n\n## §2.1 Findings\n', 'utf8');
    const lsFiles = {
      stdout:
        '100644 0000000000000000000000000000000000000000 0\tdocs/review-dispute-contract.md\n',
      stderr: '',
      exitCode: 0,
    };
    const docRef = (section) => ({
      version: 1,
      status: 'findings',
      findings: [
        { ...FINDING, evidenceRefs: [{ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section }] },
      ],
    });

    const invented = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope(docRef('§9.9 Invented section')), [lsFiles]),
    )(claudeTask());
    expect(invented.result).toBe('blocked');
    expect(invented.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');

    const real = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope(docRef('§2.1 Findings')), [lsFiles]),
    )(claudeTask());
    expect(real.result).toBe('needs_fix');
    expect(real.context.reviewFindings).toMatchObject({ mode: 'admitted', admitted: 1 });
  });

  test('a submodule gitlink is not tracked file evidence', async () => {
    // `git ls-files -s` reports a submodule directory with mode 160000. Its content
    // is not in this checkout's index at all, so a finding cannot cite it as file or
    // document evidence. Readable content is planted at the path so the ONLY reason
    // this reference fails is the index mode: drop the mode filter and it resolves.
    mkdirSync(join(worktreePath(), 'vendor'), { recursive: true });
    writeFileSync(join(worktreePath(), 'vendor', 'dep'), 'one\ntwo\nthree\n', 'utf8');
    const output = envelope({
      version: 1,
      status: 'findings',
      findings: [{ ...FINDING, evidenceRefs: [{ kind: 'file', path: 'vendor/dep', startLine: 1, endLine: 2 }] }],
    });
    const lsFiles = {
      stdout:
        '100644 0000000000000000000000000000000000000000 0\tsrc/handlers/review.ts\n' +
        '160000 1111111111111111111111111111111111111111 0\tvendor/dep\n',
      stderr: '',
      exitCode: 0,
    };
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [lsFiles]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewDispute).toBeUndefined();
    expect(result.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');
  });

  test('a symlink is not tracked file evidence', async () => {
    // Same isolation as the gitlink above: the content is readable, so mode 120000
    // is the only thing standing between this reference and admission.
    writeFileSync(join(worktreePath(), 'link.ts'), 'one\ntwo\nthree\n', 'utf8');
    const output = envelope({
      version: 1,
      status: 'findings',
      findings: [{ ...FINDING, evidenceRefs: [{ kind: 'file', path: 'link.ts', startLine: 1, endLine: 2 }] }],
    });
    const lsFiles = {
      stdout: '120000 2222222222222222222222222222222222222222 0\tlink.ts\n',
      stderr: '',
      exitCode: 0,
    };
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [lsFiles]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');
  });

  // The index capture and the evidence read are two moments. Between them a
  // verification command — or anything else touching the worktree — can swap a
  // tracked regular file for a link out of the checkout. The mode filter saw
  // 100644 and cannot see that, so the read has to refuse it on its own.
  test('a tracked path swapped for a symlink after the index capture is not evidence', async () => {
    const outside = join(tmpDir, 'outside-review.ts');
    writeFileSync(outside, `${Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`, 'utf8');
    const cited = join(worktreePath(), 'src', 'handlers', 'review.ts');
    rmSync(cited);
    symlinkSync(outside, cited);
    // The link target carries lines 10–20, so following it would ADMIT the finding:
    // refusing to follow is the only thing standing between it and admission.
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING] });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');
  });

  test('a tracked path reached through a symlinked parent directory is not evidence', async () => {
    // Same swap one level up: the cited file itself is a regular file, but only
    // because a parent component now points out of the checkout.
    const outsideDir = join(tmpDir, 'outside-handlers');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      join(outsideDir, 'review.ts'),
      `${Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`,
      'utf8',
    );
    const handlers = join(worktreePath(), 'src', 'handlers');
    rmSync(handlers, { recursive: true });
    symlinkSync(outsideDir, handlers, 'dir');
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING] });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');
  });

  test('a finding whose evidence is only a test name is refused, artifact and lineage alike', async () => {
    // Nothing in this run can tell a real test name from an invented one, so the
    // reference does not resolve. The finding must not become an open lineage
    // routed to needs_fix on evidence nobody verified.
    const output = envelope({
      version: 1,
      status: 'findings',
      findings: [{ ...FINDING, evidenceRefs: [{ kind: 'test', name: 'rate limiting rejects an anonymous caller' }] }],
    });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewDispute).toBeUndefined();
    expect(result.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');
    expect(existsSync(join(artifactRoot, 'runs', 'run-review-1', 'review-findings.json'))).toBe(false);
  });

  test('the brief asks only for evidence forms this run can verify', async () => {
    await createReviewHandler(claudeContext(), claudeRunner(envelope({ version: 1, status: 'success' })))(claudeTask());
    const withoutBody = promptText();
    expect(withoutBody).toContain('"kind": "file"');
    // No issue body was captured, so a quote has nothing to resolve against.
    expect(withoutBody).not.toContain('"kind": "issue_quote"');
    // No run can resolve a test reference yet (#842 owns that resolver).
    expect(withoutBody).not.toContain('"kind": "test"');

    await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'success' })),
    )(claudeTask({ context: { ...makeTask().context, body: 'The handler MUST reject an anonymous caller.' } }));
    expect(promptText()).toContain('"kind": "issue_quote"');
  });

  test('the persisted lineages and the artifact backing them are written as a pair', async () => {
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING] });
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    const artifact = JSON.parse(
      readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-findings.json'), 'utf8'),
    );
    // Every persisted lineage has its full record on disk. Serialization happens
    // during admission, so there is no path where one exists without the other.
    expect(artifact.findings.map((f) => f.lineageId).sort()).toEqual(
      Object.keys(result.context.reviewDispute.lineages).sort(),
    );
  });

  test('a rejected envelope does not override a classifier verdict that already blocks', async () => {
    const output = `[P1] Missing null check\n${REVIEW_FINDINGS_MARKER}\n{ not json\n${REVIEW_FINDINGS_END_MARKER}`;
    const result = await createReviewHandler(claudeContext(), claudeRunner(output))(claudeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context.reviewFindings).toMatchObject({ mode: 'rejected' });
    expect(result.context.reviewDispute).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Subsequent reviews of the same task (issue #841 review, P1)
  //
  // Task context is merged SHALLOWLY, so the block a review writes replaces the
  // stored one wholesale. A task re-enters review after every implementation
  // fix, so a block built from this run's findings alone would erase the
  // lineages the previous review opened — including on a plain `success`
  // envelope, whose own lineage map is empty.
  // -------------------------------------------------------------------------

  test('a later success envelope keeps the lineage an earlier review opened', async () => {
    const first = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'findings', findings: [FINDING] }), [LS_FILES]),
    )(claudeTask());
    expect(first.result).toBe('needs_fix');
    const opened = Object.keys(first.context.reviewDispute.lineages);
    expect(opened).toHaveLength(1);

    // The implementation fix ran; this review of the same task passes cleanly.
    const second = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'success' })),
    )(claudeTask({ context: { ...makeTask().context, reviewDispute: first.context.reviewDispute } }));

    expect(second.result).toBe('success');
    // The open lineage survives for the #840 state machine to transition; this
    // Issue neither closes nor rewrites it.
    expect(Object.keys(second.context.reviewDispute.lineages)).toEqual(opened);
    expect(second.context.reviewDispute.lineages[opened[0]]).toMatchObject({ state: 'open', version: 1 });
    expect(second.context.reviewFindings.retainedLineages).toBe(1);
    // The review's own structure is still this run's.
    expect(second.context.reviewDispute.reviewStructure).toBe('structured');
  });

  test('a re-emitted finding attaches to its persisted lineage rather than resetting it', async () => {
    const output = envelope({ version: 1, status: 'findings', findings: [FINDING] });
    const first = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    const [lineageId] = Object.keys(first.context.reviewDispute.lineages);
    // A field only the persisted record can carry, so re-minting it as a fresh
    // version-1 lineage would be visible.
    const prior = {
      ...first.context.reviewDispute,
      lineages: { [lineageId]: { ...first.context.reviewDispute.lineages[lineageId], humanGate: true } },
    };

    const second = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(
      claudeTask({ context: { ...makeTask().context, reviewDispute: prior } }),
    );

    // §2.2: the re-raise attaches to the live lineage instead of opening a second
    // debate about the same defect, and the record already on file wins — resetting
    // whatever state #840 wrote on it would be a transition this Issue does not own.
    expect(second.result).toBe('needs_fix');
    expect(Object.keys(second.context.reviewDispute.lineages)).toEqual([lineageId]);
    expect(second.context.reviewDispute.lineages[lineageId].humanGate).toBe(true);
    expect(second.context.reviewFindings).toMatchObject({
      admitted: 0,
      attachedLineages: [lineageId],
      retainedLineages: 1,
    });
  });

  test('a re-review is shown the open lineage ids, and an echoed one attaches', async () => {
    // The loop this closes (issue #841 review, P1): a reviewer that follows the
    // contract and echoes an id it was shown must not have its whole envelope
    // rejected as `unknown-lineage`.
    const first = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'findings', findings: [FINDING] }), [LS_FILES]),
    )(claudeTask());
    const [lineageId] = Object.keys(first.context.reviewDispute.lineages);

    const second = await createReviewHandler(
      claudeContext(),
      claudeRunner(
        envelope({ version: 1, status: 'findings', findings: [{ ...FINDING, lineageId }] }),
        [LS_FILES],
      ),
    )(claudeTask({ context: { ...makeTask().context, reviewDispute: first.context.reviewDispute } }));

    // The brief named the id the reviewer echoed.
    expect(promptText()).toContain(lineageId);
    expect(second.result).toBe('needs_fix');
    expect(second.context.reviewFindings).toMatchObject({ mode: 'admitted', attachedLineages: [lineageId] });
    expect(Object.keys(second.context.reviewDispute.lineages)).toEqual([lineageId]);
  });

  test('the first review of a task is shown no lineage ids at all', async () => {
    await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'success' })),
    )(claudeTask());
    expect(promptText()).toContain('Do not set `lineageId`, `humanGate`, or `reviewerMeta`');
    expect(promptText()).not.toContain('still open');
  });

  test('an unreadable persisted block fails the review closed instead of being overwritten', async () => {
    const result = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'success' })),
    )(claudeTask({ context: { ...makeTask().context, reviewDispute: { version: 1, lineages: 'not-a-map' } } }));

    // Nothing new is written over a block that cannot be validated, and a review
    // whose findings state could not be carried never passes as clean.
    expect(result.result).toBe('blocked');
    expect(result.context.reviewDispute).toBeUndefined();
    expect(result.context.reviewFindings).toMatchObject({ mode: 'rejected' });
  });

  // -------------------------------------------------------------------------
  // Envelope content is not reviewer prose (issue #841 review, P2)
  // -------------------------------------------------------------------------

  test('a finding that quotes a human-escalation phrase still routes to the fix lane', async () => {
    // The §13 prose rules read free-form reviewer text. A finding that QUOTES
    // user-facing wording is not the reviewer asking for a human, so the
    // classifier is given the residual prose rather than the envelope's JSON.
    const quoting = {
      ...FINDING,
      requiredOutcome: 'The banner must read "manual review required" before the request is dropped',
    };
    const result = await createReviewHandler(
      claudeContext(),
      claudeRunner(envelope({ version: 1, status: 'findings', findings: [quoting] }), [LS_FILES]),
    )(claudeTask());

    expect(result.result).toBe('needs_fix');
    expect(result.context.reviewFindings).toMatchObject({ mode: 'admitted', admitted: 1 });
  });

  test('a conflict marker outside the envelope still wins over an admitted envelope', async () => {
    // Scoping the prose rules to the residual must not lose Git's own evidence:
    // the conflict check still reads the complete output.
    const output = `<<<<<<< HEAD\nlocal\n=======\ntheirs\n>>>>>>> main\n${envelope({ version: 1, status: 'success' })}`;
    const runner = claudeRunner(output, [{ stdout: '', stderr: '', exitCode: 0 }]); // worktree remove
    const result = await createReviewHandler(claudeContext(), runner)(claudeTask());
    expect(result.result).toBe('conflict');
    expect(result.context.hasConflictSignal).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Existing outcomes stay compatible
  // -------------------------------------------------------------------------

  test('legacy reviewer output keeps the existing needs_fix routing and opens no lineage', async () => {
    const result = await createReviewHandler(
      claudeContext(),
      claudeRunner('[P2] Missing input validation in the new handler'),
    )(claudeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context.reviewFindings).toMatchObject({ mode: 'legacy', reviewStructure: 'legacy' });
    expect(result.context.reviewDispute).toBeUndefined();
    expect(result.context.reviewFeedback).toContain('[P2]');
  });

  test('a prose finding alongside an envelope keeps its blocking force and marks the review mixed', async () => {
    const output = `[P1] The retry loop is unbounded\n${envelope({ version: 1, status: 'success' })}`;
    const result = await createReviewHandler(claudeContext(), claudeRunner(output))(claudeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context.reviewDispute.reviewStructure).toBe('mixed');
  });

  test('an explicit request for human judgment is not overruled by the findings', async () => {
    const output = `Human review required for the auth change.\n${envelope({ version: 1, status: 'findings', findings: [FINDING] })}`;
    const result = await createReviewHandler(claudeContext(), claudeRunner(output, [LS_FILES]))(claudeTask());
    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings.admitted).toBe(1);
  });

  test('a merge conflict still routes to the conflict lane regardless of the envelope', async () => {
    const output = `CONFLICT (content): Merge conflict in src/auth.ts\n${envelope({ version: 1, status: 'findings', findings: [FINDING] })}`;
    // The envelope is still parsed (the evidence capture runs), but a structural
    // conflict signal is evidence no envelope can argue with, so it wins.
    const runner = claudeRunner(output, [LS_FILES, { stdout: '', stderr: '', exitCode: 0 }]); // ls-files, worktree remove
    const result = await createReviewHandler(claudeContext(), runner)(claudeTask());
    expect(result.result).toBe('conflict');
    expect(result.context?.hasConflictSignal).toBe(true);
  });

  test('the conflict handoff carries the admitted findings it already wrote to disk', async () => {
    // Routing to conflict_resolution does not un-admit an envelope that validated.
    // Task context is taken from this result, so a conflict handoff that dropped
    // the lineages would leave `review-findings.json` on disk with nothing
    // persisted pointing at it.
    const output = `CONFLICT (content): Merge conflict in src/auth.ts\n${envelope({ version: 1, status: 'findings', findings: [FINDING] })}`;
    const runner = claudeRunner(output, [LS_FILES, { stdout: '', stderr: '', exitCode: 0 }]); // ls-files, worktree remove
    const result = await createReviewHandler(claudeContext(), runner)(claudeTask());
    expect(result.result).toBe('conflict');
    expect(result.context.reviewFindings).toMatchObject({ mode: 'admitted', status: 'findings', admitted: 1 });
    const artifact = JSON.parse(
      readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-findings.json'), 'utf8'),
    );
    expect(artifact.findings.map((f) => f.lineageId).sort()).toEqual(
      Object.keys(result.context.reviewDispute.lineages).sort(),
    );
    expect(Object.values(result.context.reviewDispute.lineages)[0]).toMatchObject({ state: 'open', version: 1 });
  });

  test('the failed synthetic-worktree cleanup handoff carries the findings it already wrote', async () => {
    // A PR-url-only review runs in a SYNTHETIC `ai/pr-<n>` worktree, which is
    // released before the fix handoff. When that release fails, the handoff
    // returns straight from the release helper — before the `needs_fix` context
    // exists — so it has to carry the findings state itself, or the admitted
    // `review-findings.json` is stranded with nothing persisted pointing at it
    // (issue #841 review, P2).
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 }, // gh pr view 99
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch origin main (refresh review base)
      { stdout: 'ai/pr-99', stderr: '', exitCode: 0 },          // git rev-parse refs/heads/ai/pr-99 (synthetic per-PR name exists)
      { stdout: '', stderr: '', exitCode: 0 },                  // git pull origin pull/99/head --ff-only
      { stdout: '0', stderr: '', exitCode: 0 },                 // git rev-list --count FETCH_HEAD..HEAD
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (preflight) — clean
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new code', stderr: '', exitCode: 0 }, // git diff (classification)
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new code', stderr: '', exitCode: 0 }, // git diff (prompt)
      { stdout: envelope({ version: 1, status: 'findings', findings: [FINDING] }), stderr: '', exitCode: 0 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },                  // git status --porcelain (post-review) — clean
      LS_FILES,                                                 // git ls-files -s (evidence index)
      { stdout: '', stderr: 'fatal: cannot remove working tree', exitCode: 1 }, // git worktree remove (FAILS)
    ]);
    const resolver = fakeWorktreeResolver(wt, { branchReused: true });
    const task = claudeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
        labels: ['agent:claude', 'status:needs-review'],
        // no `branch` recorded — the review materializes the synthetic `ai/pr-99`
      },
    });

    const result = await createReviewHandler(claudeContext(), runner, resolver.resolve, fakeLock())(task);

    expect(result.result).toBe('blocked');
    expect(resolver.calls[0].branch).toBe('ai/pr-99');
    // The artifact was written before the cleanup attempt…
    const artifact = JSON.parse(
      readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'review-findings.json'), 'utf8'),
    );
    // …and the human handoff carries the lineages that back it.
    expect(result.context.reviewFindings).toMatchObject({ mode: 'admitted', status: 'findings', admitted: 1 });
    expect(artifact.findings.map((f) => f.lineageId).sort()).toEqual(
      Object.keys(result.context.reviewDispute.lineages).sort(),
    );
  });

  test('a failing review agent still fails the run before any envelope handling', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '0', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new', stderr: '', exitCode: 0 },
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 },
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'claude crashed', exitCode: 1 }, // claude -p
      { stdout: '', stderr: '', exitCode: 0 },              // git status (post-review)
    ]);
    const result = await createReviewHandler(claudeContext(), runner)(claudeTask());
    expect(result.result).toBe('failed');
    expect(result.context?.reviewFindings).toBeUndefined();
  });

  test('a verification failure still blocks before the review agent runs', async () => {
    const runner = sequenceRunner([
      { stdout: JSON.stringify({ number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-77-run-impl-1', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }), stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '0', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+new', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'test failure', exitCode: 1 },  // npm test fails
    ]);
    const result = await createReviewHandler(claudeContext(), runner)(claudeTask());
    expect(result.result).not.toBe('success');
    expect(result.context?.reviewFindings).toBeUndefined();
  });
});
