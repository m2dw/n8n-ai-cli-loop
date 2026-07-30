import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createConflictResolutionHandler as _createConflictResolutionHandler } from '../dist/handlers/conflict-resolution.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let artifactRoot;

// ---------------------------------------------------------------------------
// Worktree + lock fixtures (issue #457/#730: conflict resolution always resolves
// a per-issue worktree and an issue-scoped advisory lock — there is no more
// canonical-checkout path). Shared, module-scope versions so every describe
// block below gets safe defaults without redefining them; the dedicated
// "per-issue worktree" / "phase-runner pre-acquired lock" describe blocks
// further down define their OWN local copies (same shape) which shadow these
// within that block — left untouched since those blocks already correctly
// target worktree mechanics.
// ---------------------------------------------------------------------------

const worktreePath = () => join(tmpDir, 'worktrees', 'addon-dev', 'issue-209');

// Records every resolveWorktree() input and returns a fixed worktree path so the
// handler's cwd switch is exercised without a real `git worktree`.
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
function fakeLock(acquireResult = { ok: true, locked: true, contextId: 'run-conflict-1', sessionId: 'addon-dev' }) {
  const calls = { acquire: [], release: [] };
  return {
    calls,
    acquire(ownerId, sessionId, issueNumber) { calls.acquire.push({ ownerId, sessionId, issueNumber }); return acquireResult; },
    release(ownerId, sessionId, issueNumber) { calls.release.push({ ownerId, sessionId, issueNumber }); return { ok: true, released: true }; },
  };
}

// Every call site historically invoked `createConflictResolutionHandler(context,
// runner)` and relied on the canonical-checkout path. Since #457/#730 removed
// that path, conflict resolution always resolves a per-issue worktree and a real
// IssueWorktreeLock; tests that don't care about worktree/lock mechanics get
// deterministic fakes so `runner` only ever sees the git calls the handler itself
// issues, not `resolveIssueWorktree`'s or `IssueWorktreeLock`'s internals. Tests
// that DO care about worktree resolution or lock behavior pass their own fakes as
// the 3rd/4th args, which this wrapper leaves untouched. `phaseLockOwnerId` (5th)
// is a plain pass-through.
function createConflictResolutionHandler(context, runner, resolveWorktree, issueLock, phaseLockOwnerId) {
  return _createConflictResolutionHandler(
    context,
    runner,
    resolveWorktree ?? fakeWorktreeResolver(worktreePath()).resolve,
    issueLock ?? fakeLock(),
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

const CONTEXT = ({ session, ...overrides } = {}) => ({
  session: SESSION(session),
  runId: 'run-conflict-1',
  workerId: 'worker-test',
  ...overrides,
});

function makeTask(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: 209,
    status: 'running',
    phase: 'conflict_resolution',
    priority: 'normal',
    implementationAgent: 'claude',
    attempts: {},
    context: {
      title: 'Resolve merge conflict',
      url: 'https://github.com/m2dw/test-repo/issues/209',
      labels: ['agent:claude', 'status:needs-conflict-resolution'],
    },
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Multi-step runner: each call to run() consumes one result from the queue.
// ---------------------------------------------------------------------------
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

const PR_LIST_JSON = JSON.stringify([
  { number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-209' },
]);

// Valid agent output that includes a well-formed merge rationale block. Used in
// tests where the agent exits 0 and the resolution proceeds to commitAndPush.
const VALID_AGENT_OUTPUT = [
  'resolved',
  'MERGE_RATIONALE_START',
  '{"preservedIssueIntent":"Issue-side change preserved","preservedMainBehavior":"Main-side change preserved","discardedBehavior":null,"verificationNotes":"npm test passes"}',
  'MERGE_RATIONALE_END',
].join('\n');

// Common prefix steps: gh pr list -> git fetch (canonical) -> git status (worktree,
// clean) -> git reset --hard (pin worktree to PR head).
function setupSteps(extra = []) {
  return [
    { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 }, // gh pr list
    { stdout: '', stderr: '', exitCode: 0 },           // git fetch origin <refspecs> (canonical repo)
    { stdout: '', stderr: '', exitCode: 0 },           // git status --porcelain (worktree, clean)
    { stdout: '', stderr: '', exitCode: 0 },           // git reset --hard refs/remotes/origin/<prBranch>
    ...extra,
  ];
}

// `git ls-files -u` output for a normal text conflict (stages 2 and 3 present)
const TEXT_CONFLICT_LS_FILES =
  '100644 aaa 2\tsrc/foo.ts\n100644 bbb 3\tsrc/foo.ts\n' +
  '100644 ccc 2\tsrc/bar.ts\n100644 ddd 3\tsrc/bar.ts\n';

// modify/delete conflict: stage 2 present, stage 3 absent for src/gone.ts
const MODIFY_DELETE_LS_FILES = '100644 aaa 2\tsrc/gone.ts\n';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'conflict-handler-test-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function findCall(calls, cmd, argMatch) {
  return calls.find((c) => c.cmd === cmd && argMatch(c.args));
}

// ---------------------------------------------------------------------------
// Command order: checkout / fetch / merge setup
// ---------------------------------------------------------------------------

describe('conflict resolution — setup command order', () => {
  test('runs gh pr list, fetch, status, reset --hard, merge in order (clean merge)', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: '', exitCode: 0 }, // git merge --no-commit --no-ff (clean)
      { stdout: '', stderr: 'fatal: Needed a single revision', exitCode: 1 }, // git rev-parse MERGE_HEAD (none → no-op)
      { stdout: '', stderr: '', exitCode: 0 }, // git merge --abort (no-op cleanup)
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('success');
    const seq = runner.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(seq[0]).toContain('gh pr list');
    expect(seq[1]).toContain('git fetch origin');
    expect(seq[2]).toBe('git status --porcelain');
    expect(seq[3]).toContain('git reset --hard refs/remotes/origin/ai/issue-209');
    expect(seq[4]).toContain('git merge --no-commit --no-ff');
  });

  test('already-up-to-date merge aborts the staged merge and returns no-op success', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: '', exitCode: 0 }, // merge (clean)
      { stdout: '', stderr: 'fatal: Needed a single revision', exitCode: 1 }, // rev-parse MERGE_HEAD (none)
      { stdout: '', stderr: '', exitCode: 0 }, // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('success');
    expect(result.context.conflictResolution).toEqual({ clean: true, merged: false });
    // A true no-op must undo the staged merge and not push anything.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
  });

  test('clean base merge that updated the branch is committed and pushed (not discarded)', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: '', exitCode: 0 }, // merge (clean, base ahead)
      { stdout: 'abc123', stderr: '', exitCode: 0 }, // rev-parse MERGE_HEAD (present → real merge)
      { stdout: 'ok', stderr: '', exitCode: 0 }, // npm test (verification passes)
      { stdout: '', stderr: '', exitCode: 0 }, // status --porcelain (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 }, // commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 }, // push origin <branch>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('success');
    expect(result.context.conflictResolution).toEqual({ clean: true, merged: true });
    // The base update is preserved: committed and pushed, never aborted.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit' && a[1] === '--no-edit')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push' && a[2] === 'ai/issue-209')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Fetch behaviour — explicit refspecs (fresh / single-branch clone)
// ---------------------------------------------------------------------------

describe('conflict resolution — fetch refspecs', () => {
  test('fetches base and PR head with explicit refspecs', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: '', exitCode: 0 }, // merge clean
      { stdout: '', stderr: '', exitCode: 1 }, // rev-parse MERGE_HEAD (none → no-op)
      { stdout: '', stderr: '', exitCode: 0 }, // merge --abort
    ]));
    await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    const fetch = findCall(runner.calls, 'git', (a) => a[0] === 'fetch');
    // Leading `+` force-updates remote-tracking refs on non-fast-forward moves.
    expect(fetch.args).toEqual([
      'fetch', 'origin',
      '+main:refs/remotes/origin/main',
      '+ai/issue-209:refs/remotes/origin/ai/issue-209',
    ]);
    // The worktree's held branch is reset to the freshly fetched remote head, never a
    // stale local branch (a `git checkout -B` would fail — the branch is already
    // checked out in the worktree).
    const reset = findCall(runner.calls, 'git', (a) => a[0] === 'reset' && a[1] === '--hard');
    expect(reset.args).toEqual(['reset', '--hard', 'refs/remotes/origin/ai/issue-209']);
    // Merge targets the fetched remote base ref.
    const merge = findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--no-commit');
    expect(merge.args).toContain('refs/remotes/origin/main');
  });

  test('honours a custom baseBranch in the refspecs and merge target', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: '', exitCode: 0 }, // merge clean
      { stdout: '', stderr: '', exitCode: 1 }, // rev-parse MERGE_HEAD (none → no-op)
      { stdout: '', stderr: '', exitCode: 0 }, // merge --abort
    ]));
    const ctx = CONTEXT({ session: { baseBranch: 'develop' } });
    await createConflictResolutionHandler(ctx, runner)(makeTask());

    const fetch = findCall(runner.calls, 'git', (a) => a[0] === 'fetch');
    expect(fetch.args).toContain('+develop:refs/remotes/origin/develop');
    const merge = findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--no-commit');
    expect(merge.args).toContain('refs/remotes/origin/develop');
  });
});

// ---------------------------------------------------------------------------
// Dirty worktree preflight
// ---------------------------------------------------------------------------

describe('conflict resolution — dirty worktree preflight', () => {
  test('blocks before any reset/merge when the worktree is dirty', async () => {
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },        // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },                  // git fetch (canonical)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },     // git status (worktree, dirty)
    ]);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/dirty/i);
    // No merge state was entered: no reset or merge.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'reset')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge')).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Missing PR / missing branch
// ---------------------------------------------------------------------------

describe('conflict resolution — missing PR / branch', () => {
  test('blocks (hand off) when no open PR exists for the issue', async () => {
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 }, // gh pr list — empty
    ]);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/No open PR/i);
    // No git operations attempted after a missing PR.
    expect(runner.calls.every((c) => c.cmd !== 'git')).toBe(true);
  });

  test('fails (not blocked) when gh pr list exits nonzero — transient lookup error', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: 'API rate limit exceeded', exitCode: 1 }, // gh pr list — command failure
    ]);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    // A flaky GitHub CLI/API call must surface as an operator-visible failure,
    // not a human handoff that clears the conflict-resolution lane labels.
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/gh pr list failed/i);
    // No git operations attempted after the lookup failure.
    expect(runner.calls.every((c) => c.cmd !== 'git')).toBe(true);
  });

  test('fails (not blocked) when gh pr list returns non-JSON output', async () => {
    const runner = sequenceRunner([
      { stdout: 'not json at all', stderr: '', exitCode: 0 }, // gh pr list — unparseable
    ]);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/non-JSON/i);
    expect(runner.calls.every((c) => c.cmd !== 'git')).toBe(true);
  });

  test('fails when the worktree cannot be reset to the PR head', async () => {
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },                 // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },                           // git fetch (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                           // git status (worktree, clean)
      { stdout: '', stderr: 'fatal: no such ref', exitCode: 1 },         // git reset --hard (fails)
    ]);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/reset --hard/);
    // Reset failed before merge state — no merge or abort.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge')).toBeFalsy();
  });

  test('fails when git fetch fails', async () => {
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },          // gh pr list
      { stdout: '', stderr: 'network error', exitCode: 1 },       // git fetch (fails)
    ]);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/git fetch/);
  });
});

// ---------------------------------------------------------------------------
// Prompt content and allowed tools
// ---------------------------------------------------------------------------

describe('conflict resolution — prompt content and allowed tools', () => {
  function conflictRunner(agentResult = { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 }) {
    return sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT (content)', exitCode: 1 },        // git merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 },      // git ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },       // git diff --numstat <aaa> <bbb> (foo: text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },        // git diff --numstat <ccc> <ddd> (bar: text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 },  // git diff --cached --name-only (pre-agent baseline)
      { stdout: '', stderr: '', exitCode: 0 },                           // git diff prBranch...baseBranch (main-side changes)
      agentResult,                                                       // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                           // git ls-files -u (verify, resolved)
      { stdout: '', stderr: '', exitCode: 0 },                           // git diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 },  // git diff --cached --name-only (post-agent, no extras)
      { stdout: '', stderr: '', exitCode: 0 },                           // git status --porcelain (worktree clean)
      { stdout: 'ok', stderr: '', exitCode: 0 },                         // npm test (verification passes)
      { stdout: '', stderr: '', exitCode: 0 },                           // git status --porcelain (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                           // git commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                           // git push origin <branch>
    ]));
  }

  test('invokes the claude agent with strictly scoped allowed tools and prompt via stdin', async () => {
    const runner = conflictRunner();
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('success');
    const agentCall = findCall(runner.calls, 'claude', () => true);
    expect(agentCall).toBeTruthy();
    const allowedIdx = agentCall.args.indexOf('--allowedTools');
    const allowed = agentCall.args[allowedIdx + 1];
    // Only conflict-scoped tools are permitted.
    expect(allowed).toContain('Bash(git add -- *)');
    expect(allowed).toContain('Bash(git status *)');
    expect(allowed).toContain('Bash(git ls-files *)');
    // No commit / push / gh / broad git.
    expect(allowed).not.toContain('git commit');
    expect(allowed).not.toContain('git push');
    expect(allowed).not.toContain('gh');
    // Prompt delivered via stdin, never as argv.
    expect(typeof agentCall.opts.stdin).toBe('string');
    expect(agentCall.args.join(' ')).not.toContain('Conflict Resolution Task');
  });

  test('writes a scoped prompt naming issue, PR, branches, and conflicted files', async () => {
    const runner = conflictRunner();
    await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    const promptPath = join(artifactRoot, 'runs', 'run-conflict-1', 'conflict-resolution-prompt.md');
    expect(existsSync(promptPath)).toBe(true);
    const prompt = readFileSync(promptPath, 'utf8');
    expect(prompt).toContain('Issue #209');
    expect(prompt).toContain('PR #99');
    expect(prompt).toContain('https://github.com/m2dw/test-repo/pull/99');
    expect(prompt).toContain('Base branch: main');
    expect(prompt).toContain('PR branch: ai/issue-209');
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('src/bar.ts');
    // Strict conflict-resolution-only instructions.
    expect(prompt).toMatch(/conflict resolution[\s*]*only/i);
    expect(prompt).toContain('Do NOT commit');
    expect(prompt).toContain('Do NOT push');
    expect(prompt).toMatch(/do NOT create or modify any pull request/i);
    // Inspection instructions.
    expect(prompt).toContain('git status --porcelain');
    expect(prompt).toContain('git ls-files -u');
    // Conservative handoff for binary / modify-delete.
    expect(prompt).toMatch(/binary/i);
    expect(prompt).toMatch(/modify\/delete/i);
    // Merge rationale block request present.
    expect(prompt).toContain('## Merge Rationale (required)');
    expect(prompt).toContain('MERGE_RATIONALE_START');
    expect(prompt).toContain('MERGE_RATIONALE_END');
    expect(prompt).toContain('preservedIssueIntent');
    expect(prompt).toContain('preservedMainBehavior');
    expect(prompt).toContain('discardedBehavior');
    expect(prompt).toContain('verificationNotes');
    // Rationale is explicitly described as local-only.
    expect(prompt).toMatch(/never posted to GitHub/i);
  });
});

// ---------------------------------------------------------------------------
// Merge abort / cleanup on blocked or failed paths after merge state entered
// ---------------------------------------------------------------------------

describe('conflict resolution — merge abort / cleanup', () => {
  test('verifies, commits, and pushes the resolved merge after a successful agent run', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat <aaa> <bbb> (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat <ccc> <ddd> (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (verify, resolved)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (no extras)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean)
      { stdout: 'ok', stderr: '', exitCode: 0 },                   // npm test (verification passes)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                     // commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                     // push origin <branch>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('success');
    expect(result.context.conflictedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
    // The resolved merge is committed and pushed — never aborted.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit' && a[1] === '--no-edit')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push' && a[2] === 'ai/issue-209')).toBeTruthy();
  });

  test('fails when push of the resolved merge fails (commit already landed, no abort)', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (verify, resolved)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (no extras)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean)
      { stdout: 'ok', stderr: '', exitCode: 0 },                   // npm test (verification passes)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                     // commit --no-edit
      { stdout: '', stderr: 'rejected', exitCode: 1 },             // push (fails)
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/git push/);
    // Merge was already committed before push, so there is nothing to abort.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeFalsy();
  });

  test('aborts and fails when unmerged paths remain after the agent runs', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: 'partial', stderr: '', exitCode: 0 },              // claude (agent)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u (still unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/unmerged path/i);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // Must not commit an incompletely resolved merge.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
  });

  test('aborts and cleans residue when conflict markers remain in staged files', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: 'resolved', stderr: '', exitCode: 0 },             // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: 'src/foo.ts:12: leftover conflict marker', stderr: '', exitCode: 2 }, // diff --cached --check
      { stdout: '?? scratch.tmp\n', stderr: '', exitCode: 0 },     // status --porcelain (agent residue)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- <residue>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/conflict marker/i);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // merge --abort leaves the agent's untracked residue behind, so the handler
    // must also clean it or the next phase's clean-tree preflight wedges on it.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('scratch.tmp'),
    )).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
  });

  test('does not reject a resolution when --check reports whitespace-only errors (no markers)', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      // --check exits non-zero for trailing whitespace, but there is NO leftover
      // conflict marker — the resolution must not be rejected for this.
      { stdout: 'src/foo.ts:12: trailing whitespace.', stderr: '', exitCode: 2 }, // diff --cached --check
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (no extras)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean)
      { stdout: 'ok', stderr: '', exitCode: 0 },                   // npm test (verification passes)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                     // commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                     // push origin <branch>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    // Whitespace-only --check failures are not conflict markers — succeed.
    expect(result.result).toBe('success');
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit' && a[1] === '--no-edit')).toBeTruthy();
  });

  test('aborts and cleans residue when the agent stages a file outside the conflict set', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: 'resolved', stderr: '', exitCode: 0 },             // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\nsrc/unrelated.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (extra!)
      { stdout: '?? scratch.tmp\n', stderr: '', exitCode: 0 },     // status --porcelain (agent residue)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- <residue>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/outside the conflict set/i);
    expect(result.error).toContain('src/unrelated.ts');
    // Must abort and never commit/push an unrelated staged change.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // merge --abort leaves the agent's untracked residue behind, so the handler
    // must also clean it or the next phase's clean-tree preflight wedges on it.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('scratch.tmp'),
    )).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('aborts and fails when the agent leaves unstaged or untracked changes after resolution', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: 'resolved', stderr: '', exitCode: 0 },             // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '?? scratch.tmp\n M src/foo.ts\n', stderr: '', exitCode: 0 }, // status --porcelain (untracked + unstaged)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- <residue>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/unstaged or untracked/i);
    expect(result.error).toContain('scratch.tmp');
    expect(result.error).toContain('src/foo.ts');
    // A dirty resolution must never be committed/pushed; abort and hand off.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // merge --abort leaves the agent's untracked residue behind, so the handler
    // must also clean it or the next phase's clean-tree preflight wedges on it.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('scratch.tmp'),
    )).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
    // Verification must not run for a dirty worktree (no npm test invoked).
    expect(findCall(runner.calls, 'npm', () => true)).toBeFalsy();
  });

  test('aborts and fails when verification fails before committing the resolved merge', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean)
      { stdout: 'FAIL tests', stderr: '', exitCode: 1 },           // npm test (verification fails)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (no residue from the failed run)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/verification/i);
    // Verification ran (npm test) and gated the commit.
    expect(findCall(runner.calls, 'npm', (a) => a[0] === 'test')).toBeTruthy();
    // A broken merge must never be committed/pushed; abort instead.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('cleans untracked verification artifacts when verification fails after a resolved merge', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean before verification)
      { stdout: 'FAIL tests', stderr: '', exitCode: 1 },           // npm test (fails, but emitted coverage artifacts)
      { stdout: '?? coverage/lcov.info\n', stderr: '', exitCode: 0 }, // status --porcelain (untracked artifacts from the failed run)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- <residue>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/verification/i);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // merge --abort does not remove untracked files, so the artifacts the failed
    // verification emitted must be cleaned or the next phase's clean-tree
    // preflight wedges the shared checkout.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('coverage/lcov.info'),
    )).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('aborts and fails when verification fails on a clean base merge before push', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: '', exitCode: 0 },       // merge (clean, base ahead)
      { stdout: 'abc123', stderr: '', exitCode: 0 }, // rev-parse MERGE_HEAD (present → real merge)
      { stdout: 'FAIL tests', stderr: '', exitCode: 1 }, // npm test (verification fails)
      { stdout: '', stderr: '', exitCode: 0 },       // status --porcelain (no residue from the failed run)
      { stdout: '', stderr: '', exitCode: 0 },       // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/verification/i);
    expect(findCall(runner.calls, 'npm', (a) => a[0] === 'test')).toBeTruthy();
    // The unverified base merge must not be pushed; abort instead.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('aborts the merge and fails when the agent exits non-zero', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: '', stderr: 'agent crashed', exitCode: 1 },        // claude (fails)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (no residue from the failed agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/agent exited 1/);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // No residue → no git clean needed.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'clean')).toBeFalsy();
  });

  test('delays the retry with category metadata when the agent hits a rate limit (issue #672)', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: '', stderr: 'Error: HTTP 429 too many requests', exitCode: 1 }, // claude — rate-limited
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (no residue from the delayed agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('delayed');
    expect(result.category).toBe('rate_limit');
    expect(result.context.category).toBe('rate_limit');
    expect(result.retryAfterMs).toBeLessThan(60 * 60 * 1000);
    expect(result.message).toMatch(/rate limit/i);
    expect(result.message).not.toMatch(/usage quota/i);
  });

  test('cleans agent residue when the agent exits non-zero after creating untracked/unstaged files', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: '', stderr: 'agent crashed', exitCode: 1 },        // claude (fails after writing files)
      { stdout: '?? scratch.tmp\n M src/foo.ts\n', stderr: '', exitCode: 0 }, // status --porcelain (untracked + unstaged residue)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- <residue>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/agent exited 1/);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // merge --abort leaves the agent's untracked residue behind, so the handler
    // must also clean it or the next phase's clean-tree preflight wedges on it.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('scratch.tmp'),
    )).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('restores tracked residue with git checkout -- (not git clean) after aborting', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: 'resolved', stderr: '', exitCode: 0 },             // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      // Worktree residue: an untracked scratch file AND an unrelated tracked edit.
      { stdout: '?? scratch.tmp\n M src/other.ts\n', stderr: '', exitCode: 0 }, // status --porcelain
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git checkout -- src/other.ts
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- scratch.tmp
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // The unrelated tracked edit survives merge --abort, so it must be discarded
    // with `git checkout --` — `git clean` is a no-op for tracked files.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'checkout' && a[1] === '--' && a.includes('src/other.ts'),
    )).toBeTruthy();
    // The untracked file is removed with `git clean`, not checkout.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('scratch.tmp'),
    )).toBeTruthy();
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('src/other.ts'),
    )).toBeFalsy();
  });

  test('aborts and fails (conflict-resolution-failed) for binary conflicts (stage-blob diff) without invoking the agent', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT (content)', exitCode: 1 },   // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u (3 stages present)
      { stdout: '-\t-\t', stderr: '', exitCode: 0 },               // diff --numstat <aaa> <bbb> (foo binary)
      { stdout: '4\t5\t', stderr: '', exitCode: 0 },               // diff --numstat <ccc> <ddd> (bar text)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    // Per the contract a binary conflict is a defined stop condition → failed
    // (status:conflict-resolution-failed), not blocked/ready_for_human.
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/binary/i);
    expect(result.error).toContain('src/foo.ts');
    // The binary file is detected from the stage blobs, and bar.ts stays a text file.
    expect(result.error).not.toContain('src/bar.ts');
    // Agent must not be invoked when a binary conflict is present.
    expect(findCall(runner.calls, 'claude', () => true)).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // Binary detection diffs the stage blobs directly (stage 2 vs stage 3).
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'diff' && a[1] === '--numstat' && a[2] === 'aaa' && a[3] === 'bbb')).toBeTruthy();
  });

  test('aborts and fails (conflict-resolution-failed) for modify/delete conflicts without invoking the agent', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT (modify/delete)', exitCode: 1 }, // merge
      { stdout: MODIFY_DELETE_LS_FILES, stderr: '', exitCode: 0 },     // ls-files -u
      { stdout: '', stderr: '', exitCode: 0 },                         // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    // Per the contract a modify/delete conflict is a defined stop condition →
    // failed (status:conflict-resolution-failed), not blocked/ready_for_human.
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/modify\/delete/i);
    expect(result.error).toContain('src/gone.ts');
    // Agent must not be invoked for human-judgement conflicts.
    expect(findCall(runner.calls, 'claude', () => true)).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
  });

  test('aborts and fails when verification regenerates artifacts, dirtying the worktree', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean before verification)
      { stdout: 'ok', stderr: '', exitCode: 0 },                   // npm test (passes but regenerates artifacts)
      { stdout: '?? dist/workflow.json\n', stderr: '', exitCode: 0 }, // status --porcelain (dirty after verification)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- <residue>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/verification modified the worktree/i);
    expect(result.error).toContain('dist/workflow.json');
    // Verification ran, but the regenerated artifacts must not be silently committed.
    expect(findCall(runner.calls, 'npm', (a) => a[0] === 'test')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // merge --abort leaves untracked regenerated artifacts behind, so the handler
    // must also clean the residue or the next phase's clean-tree preflight wedges.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('dist/workflow.json'),
    )).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('aborts and cleans residue when the agent edits the content of an auto-merged file', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u (foo, bar)
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      // Baseline staged set includes an auto-merged (non-conflicted) file.
      { stdout: 'src/foo.ts\nsrc/bar.ts\nsrc/auto.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '100644 oldsha 0\tsrc/auto.ts\n', stderr: '', exitCode: 0 },        // ls-files --stage -- src/auto.ts (baseline blob)
      { stdout: '', stderr: '', exitCode: 0 },                                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: 'resolved', stderr: '', exitCode: 0 },             // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\nsrc/auto.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (paths unchanged)
      { stdout: '100644 newsha 0\tsrc/auto.ts\n', stderr: '', exitCode: 0 },        // ls-files --stage -- src/auto.ts (content changed!)
      { stdout: '?? scratch.tmp\n', stderr: '', exitCode: 0 },     // status --porcelain (agent residue)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- <residue>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/modified auto-merged file/i);
    expect(result.error).toContain('src/auto.ts');
    // The unrelated content change must never be committed/pushed; abort instead.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // merge --abort leaves the agent's untracked residue behind, so the handler
    // must also clean it or the next phase's clean-tree preflight wedges on it.
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('scratch.tmp'),
    )).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('aborts and cleans residue when the agent recreates an auto-merged deleted file', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u (foo, bar)
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      // Baseline staged set includes a file the base merge auto-staged as a *deletion*.
      { stdout: 'src/foo.ts\nsrc/bar.ts\nsrc/dead.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      // A staged deletion has no stage-0 blob, so captureStagedBlobs records nothing.
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files --stage -- src/dead.ts (baseline: deleted)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: 'resolved', stderr: '', exitCode: 0 },             // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      // The deleted path is still in the allowed staged set, so the path check passes.
      { stdout: 'src/foo.ts\nsrc/bar.ts\nsrc/dead.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (paths unchanged)
      // ...but the agent recreated and re-staged it: it now has a stage-0 blob.
      { stdout: '100644 newsha 0\tsrc/dead.ts\n', stderr: '', exitCode: 0 },        // ls-files --stage -- src/dead.ts (recreated!)
      { stdout: '?? scratch.tmp\n', stderr: '', exitCode: 0 },     // status --porcelain (agent residue)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd -- <residue>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    // Recreating a file the base merge deleted is an unrelated edit; it must be
    // flagged even though the path stays allowed and has no baseline blob.
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/modified auto-merged file/i);
    expect(result.error).toContain('src/dead.ts');
    // The recreated file must never be committed/pushed; abort instead.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    expect(findCall(
      runner.calls,
      'git',
      (a) => a[0] === 'clean' && a.includes('scratch.tmp'),
    )).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('commits/pushes when an auto-merged file is left untouched by the agent', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u (foo, bar)
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\nsrc/auto.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '100644 samesha 0\tsrc/auto.ts\n', stderr: '', exitCode: 0 },       // ls-files --stage -- src/auto.ts (baseline blob)
      { stdout: '', stderr: '', exitCode: 0 },                                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\nsrc/auto.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (paths unchanged)
      { stdout: '100644 samesha 0\tsrc/auto.ts\n', stderr: '', exitCode: 0 },       // ls-files --stage -- src/auto.ts (content unchanged)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean)
      { stdout: 'ok', stderr: '', exitCode: 0 },                   // npm test (passes)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                     // commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                     // push origin <branch>
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('success');
    // An unchanged auto-merged file is not a violation: commit and push proceed.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit' && a[1] === '--no-edit')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push' && a[2] === 'ai/issue-209')).toBeTruthy();
  });

  test('aborts and fails when merge exits non-zero with no unmerged paths', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'fatal: merge error', exitCode: 128 }, // merge (unexpected error)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (empty)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/no unmerged paths/i);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Per-issue worktree conflict resolution (issue #444)
// ---------------------------------------------------------------------------

describe('conflict resolution — per-issue worktree mode (issue #444)', () => {
  const worktreePath = () => join(tmpDir, 'worktrees', 'addon-dev', 'issue-209');

  // Records every resolveWorktree() call and returns a fixed path (or failure).
  function fakeWorktreeResolver(path, override = {}) {
    const calls = [];
    const resolve = (input) => {
      calls.push(input);
      if (override.ok === false) return { ok: false, error: override.error ?? 'resolver failed' };
      return {
        ok: true, path, branch: input.branch,
        worktreeId: `${input.sessionId}/issue-${input.issueNumber}`,
        created: override.created ?? false,
        branchReused: override.branchReused ?? true,
      };
    };
    resolve.calls = calls;
    return resolve;
  }

  // Duck-typed IssueWorktreeLock: records acquire/release and returns configurable results.
  function fakeLock({ alreadyHeld = false, ownerContextId = 'other-run', ownerStartedAt = '2026-01-01T00:00:00.000Z' } = {}) {
    const ops = [];
    return {
      ops,
      acquire(ownerId, sessionId, issueNumber) {
        ops.push({ op: 'acquire', ownerId, sessionId, issueNumber });
        if (alreadyHeld) return { locked: false, ownerContextId, ownerStartedAt };
        return { locked: true };
      },
      release(ownerId, sessionId, issueNumber) {
        ops.push({ op: 'release', ownerId, sessionId, issueNumber });
        return { released: true };
      },
    };
  }

  // Full happy-path sequence for a worktree-mode text-conflict resolution.
  // Differences from canonical: step 4 is `reset --hard` not `checkout -B`.
  function worktreeConflictRunner() {
    return sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },               // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },                         // git fetch origin (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                         // git status (worktree clean)
      { stdout: '', stderr: '', exitCode: 0 },                         // git reset --hard (worktree mode step 4)
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },                 // git merge --no-commit
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 },     // git ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },      // diff --numstat <aaa> <bbb>
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },       // diff --numstat <ccc> <ddd>
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                         // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },          // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                         // git ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                         // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (no extras)
      { stdout: '', stderr: '', exitCode: 0 },                         // git status (worktree clean)
      { stdout: 'ok', stderr: '', exitCode: 0 },                       // npm test
      { stdout: '', stderr: '', exitCode: 0 },                         // git status (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                         // git commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                         // git push origin ai/issue-209
    ]);
  }

  test('runs conflict resolution inside the per-issue worktree, not the canonical checkout', async () => {
    const wt = worktreePath();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const runner = worktreeConflictRunner();
    const session = SESSION({});

    const result = await createConflictResolutionHandler(CONTEXT({ session }), runner, resolver, lock)(makeTask());

    expect(result.result).toBe('success');
    // Resolver was called with the PR branch and the canonical repoRoot.
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0].branch).toBe('ai/issue-209');
    expect(resolver.calls[0].repoRoot).toBe(repoRoot);
    // The setup fetch runs in the canonical repo (shared object store), then all
    // conflict-resolution work runs inside the issue worktree.
    const fetch = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetch.opts.cwd).toBe(repoRoot);
    const gitAfterFetch = runner.calls.filter(
      (c) => c.cmd === 'git' && ['reset', 'merge', 'ls-files', 'diff', 'commit', 'push', 'status'].includes(c.args[0]),
    );
    for (const call of gitAfterFetch) {
      expect(call.opts.cwd).toBe(wt);
    }
    // The agent also runs in the worktree.
    const agentCall = runner.calls.find((c) => c.cmd === 'claude');
    expect(agentCall.opts.cwd).toBe(wt);
  });

  test('uses git reset --hard instead of git checkout -B in worktree mode', async () => {
    const wt = worktreePath();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const runner = worktreeConflictRunner();
    const session = SESSION({});

    await createConflictResolutionHandler(CONTEXT({ session }), runner, resolver, lock)(makeTask());

    const resetCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'reset' && c.args[1] === '--hard');
    expect(resetCall).toBeTruthy();
    expect(resetCall.args).toEqual(['reset', '--hard', 'refs/remotes/origin/ai/issue-209']);
    expect(resetCall.opts.cwd).toBe(wt);
    // checkout -B must not appear in worktree mode.
    expect(runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === '-B')).toBeFalsy();
  });

  test('acquires the issue worktree lock and releases it after completion', async () => {
    const wt = worktreePath();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const runner = worktreeConflictRunner();
    const session = SESSION({});

    await createConflictResolutionHandler(CONTEXT({ session }), runner, resolver, lock)(makeTask());

    expect(lock.ops.filter((o) => o.op === 'acquire')).toHaveLength(1);
    expect(lock.ops.filter((o) => o.op === 'release')).toHaveLength(1);
    expect(lock.ops[0].op).toBe('acquire');
    expect(lock.ops[lock.ops.length - 1].op).toBe('release');
  });

  test('blocks when the issue worktree lock is already held by another execution', async () => {
    const wt = worktreePath();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock({ alreadyHeld: true, ownerContextId: 'other-run-xyz' });
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 }, // gh pr list (needed to get prBranch for lock scope)
    ]);
    const session = SESSION({});

    const result = await createConflictResolutionHandler(CONTEXT({ session }), runner, resolver, lock)(makeTask());

    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/worktree lock/i);
    expect(result.message).toContain('other-run-xyz');
    // No worktree was resolved and no git operations ran after the lock was refused.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls.filter((c) => c.cmd === 'git')).toHaveLength(0);
  });

  test('releases the lock and fails when worktree resolution fails', async () => {
    const resolver = fakeWorktreeResolver('', { ok: false, error: 'worktree diverged from origin' });
    const lock = fakeLock();
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 }, // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },           // git fetch origin <refspecs> (canonical)
    ]);
    const session = SESSION({});

    const result = await createConflictResolutionHandler(CONTEXT({ session }), runner, resolver, lock)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/worktree/i);
    expect(result.error).toContain('worktree diverged from origin');
    // Lock must be released even when the worktree resolution fails.
    expect(lock.ops.filter((o) => o.op === 'release')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe('conflict resolution — artifacts', () => {
  test('creates artifact dir and writes result json on the already-up-to-date path', async () => {
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: '', exitCode: 0 }, // merge clean
      { stdout: '', stderr: '', exitCode: 1 }, // rev-parse MERGE_HEAD (none → no-op)
      { stdout: '', stderr: '', exitCode: 0 }, // merge --abort
    ]));
    await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    const dir = join(artifactRoot, 'runs', 'run-conflict-1');
    expect(existsSync(dir)).toBe(true);
    const resultJson = JSON.parse(readFileSync(join(dir, 'conflict-resolution-result.json'), 'utf8'));
    expect(resultJson.reason).toBe('already-up-to-date');
    expect(resultJson.success).toBe(true);
    expect(resultJson.merged).toBe(false);
  });

  test('persists structured verification failure details in context and artifact after text conflicts are resolved', async () => {
    // Jest-style output with a named failing test to exercise extraction.
    const verOutput = 'FAIL tests/foo.test.ts\n\n  ● MySuite › should always pass\n\nTest Suites: 1 failed\n';
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean)
      { stdout: verOutput, stderr: '', exitCode: 1 },              // npm test (verification fails)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (no residue)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');

    // Context carries structured semanticConflict details.
    const sc = result.context.semanticConflict;
    expect(sc.verificationCommandName).toBe('test');
    expect(sc.verificationCommand).toBe('npm test');
    expect(sc.exitCode).toBe(1);
    // Text conflicts were resolved by the agent before verification ran.
    expect(sc.textConflictsResolved).toBe(true);
    // Jest bullet extracted.
    expect(sc.failedTests).toContain('MySuite › should always pass');
    // Bounded log excerpt present.
    expect(sc.logExcerpt).toContain('FAIL tests/foo.test.ts');
    // Conflicted files surfaced.
    expect(result.context.conflictedFiles).toEqual(expect.arrayContaining(['src/foo.ts', 'src/bar.ts']));

    // Result artifact records the same structured details.
    const dir = join(artifactRoot, 'runs', 'run-conflict-1');
    const resultJson = JSON.parse(readFileSync(join(dir, 'conflict-resolution-result.json'), 'utf8'));
    expect(resultJson.success).toBe(false);
    expect(resultJson.step).toBe('verification:test');
    expect(resultJson.verificationCommandName).toBe('test');
    expect(resultJson.verificationCommand).toBe('npm test');
    expect(resultJson.exitCode).toBe(1);
    expect(resultJson.textConflictsResolved).toBe(true);
    expect(resultJson.failedTests).toContain('MySuite › should always pass');
    expect(resultJson.logExcerpt).toContain('FAIL tests/foo.test.ts');
    expect(resultJson.conflictedFiles).toEqual(expect.arrayContaining(['src/foo.ts', 'src/bar.ts']));
    // Run metadata present in the base artifact.
    expect(resultJson.runId).toBe('run-conflict-1');
    expect(resultJson.sessionId).toBe('addon-dev');
  });
});

// ---------------------------------------------------------------------------
// Per-issue worktree conflict resolution (issue #457)
//
// In worktree mode the resolution runs INSIDE the issue worktree on the PR head
// branch instead of the canonical checkout, under the issue-scoped worktree lock.
// The canonical `git checkout -B <prBranch>` is replaced by a `git reset --hard
// refs/remotes/origin/<prBranch>` in the worktree, because the PR branch is already
// checked out there and Git refuses to check a held branch out a second time.
// ---------------------------------------------------------------------------

describe('conflict resolution — per-issue worktree (issue #457)', () => {
  const worktreePath = () => join(tmpDir, 'worktrees', 'addon-dev', 'issue-209');

  // Records every resolveWorktree() input and returns a fixed worktree path so the
  // handler's cwd switch is exercised without a real `git worktree`.
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
  function fakeLock(acquireResult = { ok: true, locked: true, contextId: 'run-conflict-1', sessionId: 'addon-dev' }) {
    const calls = { acquire: [], release: [] };
    return {
      calls,
      acquire(ownerId, sessionId, issueNumber) { calls.acquire.push({ ownerId, sessionId, issueNumber }); return acquireResult; },
      release(ownerId, sessionId, issueNumber) { calls.release.push({ ownerId, sessionId, issueNumber }); return { ok: true, released: true }; },
    };
  }

  const prListFor = (headRefName) => JSON.stringify([
    { number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName },
  ]);

  // Worktree-mode no-op merge: gh pr list → git fetch (canonical) → git status
  // (worktree, clean) → git reset --hard → git merge (clean) → rev-parse MERGE_HEAD
  // (none) → git merge --abort. No canonical `git checkout -B`.
  function worktreeNoopRunner(headRefName = 'ai/issue-209') {
    return sequenceRunner([
      { stdout: prListFor(headRefName), stderr: '', exitCode: 0 }, // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },                     // git fetch origin <refspecs> (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (worktree, clean)
      { stdout: '', stderr: '', exitCode: 0 },                     // git reset --hard refs/remotes/origin/<prBranch>
      { stdout: '', stderr: '', exitCode: 0 },                     // git merge --no-commit --no-ff (clean)
      { stdout: '', stderr: 'fatal: Needed a single revision', exitCode: 1 }, // rev-parse MERGE_HEAD (none)
      { stdout: '', stderr: '', exitCode: 0 },                     // git merge --abort
    ]);
  }

  // The headline acceptance case: the PR branch is already checked out in the issue
  // worktree, so the resolution runs there and never does a canonical `git checkout -B`.
  test('runs conflict resolution inside the issue worktree and never checks the held branch out canonically', async () => {
    const wt = worktreePath();
    const runner = worktreeNoopRunner();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const session = {};

    const result = await createConflictResolutionHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(makeTask());

    expect(result.result).toBe('success');
    expect(result.context.conflictResolution).toEqual({ clean: true, merged: false });

    // The worktree was resolved for the PR head branch, tolerant of a behind-origin
    // (fast-forwardable) head.
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({
      repoRoot,
      issueNumber: 209,
      branch: 'ai/issue-209',
      allowFastForward: true,
    });

    // The regression guard: NO canonical `git checkout -B` (Git refuses a branch held
    // by another worktree); the held branch is pinned with `git reset --hard` instead.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'checkout')).toBeFalsy();
    const reset = findCall(runner.calls, 'git', (a) => a[0] === 'reset' && a[1] === '--hard');
    expect(reset.args).toEqual(['reset', '--hard', 'refs/remotes/origin/ai/issue-209']);
    expect(reset.opts.cwd).toBe(wt);

    // The fetch runs in the canonical repo (shared object store); the merge and status
    // run INSIDE the worktree.
    const fetch = findCall(runner.calls, 'git', (a) => a[0] === 'fetch');
    expect(fetch.opts.cwd).toBe(repoRoot);
    const merge = findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--no-commit');
    expect(merge.opts.cwd).toBe(wt);
    for (const c of runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'status')) {
      expect(c.opts.cwd).toBe(wt);
    }

    // The issue-scoped worktree lock was held across the resolution and released once.
    expect(lock.calls.acquire).toEqual([{ ownerId: 'run-conflict-1', sessionId: 'addon-dev', issueNumber: 209 }]);
    expect(lock.calls.release).toEqual([{ ownerId: 'run-conflict-1', sessionId: 'addon-dev', issueNumber: 209 }]);
  });

  // Non-conventional PR head: an externally-created PR whose head is not `ai/issue-<n>`.
  // The convention-only `gh pr list --head ai/issue-209` finds NOTHING (the real
  // provider can only ever return the conventional head), so resolution falls back to
  // the PR recorded in the task context (`prUrl`) and reads its live head via `gh pr
  // view`. The worktree, reset, merge, commit, and push all use that live head, not the
  // convention. This guards the issue #457 review finding: without the context fallback
  // `prBranch` would never be the actual non-conventional head and the phase would block.
  test('supports a non-conventional PR head branch (clean base merge committed + pushed in the worktree)', async () => {
    const wt = worktreePath();
    // `gh pr view 99 --json ...` resolves the recorded PR to its non-conventional head.
    const prViewJson = JSON.stringify({
      number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'feature/custom', state: 'OPEN',
    });
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },                        // gh pr list --head ai/issue-209 (none)
      { stdout: prViewJson, stderr: '', exitCode: 0 },                  // gh pr view 99 (recorded PR → feature/custom)
      { stdout: '', stderr: '', exitCode: 0 },                          // git fetch (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                          // git status (worktree, clean)
      { stdout: '', stderr: '', exitCode: 0 },                          // git reset --hard refs/remotes/origin/feature/custom
      { stdout: '', stderr: '', exitCode: 0 },                          // git merge --no-commit --no-ff (clean, base ahead)
      { stdout: 'abc123', stderr: '', exitCode: 0 },                    // rev-parse MERGE_HEAD (present → real merge)
      { stdout: 'ok', stderr: '', exitCode: 0 },                        // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                          // git status --porcelain (post-verification, clean)
      { stdout: '', stderr: '', exitCode: 0 },                          // git commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                          // git push origin feature/custom
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock();
    const session = {};

    // The review handoff records the non-conventional PR's identity in the task context.
    const task = makeTask({
      context: {
        title: 'Resolve merge conflict',
        url: 'https://github.com/m2dw/test-repo/issues/209',
        labels: ['agent:claude', 'status:needs-conflict-resolution'],
        prUrl: 'https://github.com/m2dw/test-repo/pull/99',
      },
    });

    const result = await createConflictResolutionHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(task);

    expect(result.result).toBe('success');
    expect(result.context.conflictResolution).toEqual({ clean: true, merged: true });
    expect(result.context.branch).toBe('feature/custom');

    // The PR head came from the recorded-context by-selector read, not the convention.
    const prView = findCall(runner.calls, 'gh', (a) => a[0] === 'pr' && a[1] === 'view');
    expect(prView).toBeTruthy();
    expect(prView.args).toContain('99');
    // The worktree was materialized on the non-conventional head.
    expect(resolver.calls[0]).toMatchObject({ branch: 'feature/custom' });
    const reset = findCall(runner.calls, 'git', (a) => a[0] === 'reset' && a[1] === '--hard');
    expect(reset.args[2]).toBe('refs/remotes/origin/feature/custom');
    // The base update is committed and pushed to the non-conventional head, from the worktree.
    const commit = findCall(runner.calls, 'git', (a) => a[0] === 'commit' && a[1] === '--no-edit');
    expect(commit.opts.cwd).toBe(wt);
    const push = findCall(runner.calls, 'git', (a) => a[0] === 'push' && a[2] === 'feature/custom');
    expect(push).toBeTruthy();
    expect(push.opts.cwd).toBe(wt);
    expect(lock.calls.release).toHaveLength(1);
  });

  // Forked (cross-repository) PR head: the PR head lives on a contributor's fork, not
  // `origin`. Fetching/pushing it by branch name on origin would touch an unrelated
  // base-repo branch instead of the real PR head, so the worktree path must fail closed
  // BEFORE acquiring the lock, resolving the worktree, or running any git fetch/push
  // (issue #457 review, P2).
  test('fails closed on a forked (cross-repository) PR head before fetching or pushing by branch name', async () => {
    const runner = sequenceRunner([
      // gh pr list --head ai/issue-209 → conventional head, but on a fork.
      { stdout: JSON.stringify([
        { number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-209', isCrossRepository: true },
      ]), stderr: '', exitCode: 0 },
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = {};

    const result = await createConflictResolutionHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('fork');
    expect(result.error).toContain('PR #99');
    expect(result.context.conflictLockScope).toBe('addon-dev::issue-209');

    // Nothing was touched past the PR lookup: no lock acquired, no worktree resolved, no
    // git fetch/reset/push by branch name.
    expect(lock.calls.acquire).toHaveLength(0);
    expect(resolver.calls).toHaveLength(0);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'fetch')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  // Concurrent lock behavior: another execution already holds this issue's worktree
  // lock, so the resolution fails closed to a human without touching anything.
  test('blocks when the issue worktree lock is already held by another execution', async () => {
    const runner = worktreeNoopRunner();
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock({
      ok: true, locked: false, reason: 'lock_held',
      ownerContextId: 'other-run', ownerStartedAt: '2026-06-30T00:00:00.000Z',
    });
    const session = {};

    const result = await createConflictResolutionHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(makeTask());

    expect(result.result).toBe('blocked');
    expect(result.context.conflictLockScope).toBe('addon-dev::issue-209');
    expect(result.context.conflictLockHeldBy).toBe('other-run');
    expect(result.message).toContain('addon-dev::issue-209');

    // Nothing was mutated past the PR lookup: the worktree was never resolved, no merge
    // ran, and the lock we never acquired is not released.
    expect(resolver.calls).toHaveLength(0);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge')).toBeFalsy();
    expect(lock.calls.release).toHaveLength(0);
  });

  // A failed worktree resolution still releases the lock so the issue is not wedged.
  test('releases the lock when worktree resolution fails', async () => {
    const runner = sequenceRunner([
      { stdout: prListFor('ai/issue-209'), stderr: '', exitCode: 0 }, // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },                        // git fetch (canonical)
    ]);
    const resolver = fakeWorktreeResolver(worktreePath(), { ok: false, error: 'diverged from origin' });
    const lock = fakeLock();
    const session = {};

    const result = await createConflictResolutionHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('diverged from origin');
    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
  });

  // A dirty worktree (residue from a prior phase) is escalated to a human rather than
  // silently discarded by the reset.
  test('blocks when the worktree is dirty before resolution', async () => {
    const runner = sequenceRunner([
      { stdout: prListFor('ai/issue-209'), stderr: '', exitCode: 0 },     // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },                            // git fetch (canonical)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },               // git status (worktree, DIRTY)
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const lock = fakeLock();
    const session = {};

    const result = await createConflictResolutionHandler(
      CONTEXT({ session }), runner, resolver.resolve, lock,
    )(makeTask());

    expect(result.result).toBe('blocked');
    expect(result.message).toContain('dirty');
    // No reset/merge ran, and the lock is released.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'reset')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge')).toBeFalsy();
    expect(lock.calls.release).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase-runner pre-acquired lock (issue #524)
//
// When `phaseLockOwnerId` is set the phase runner already holds the issue-scoped
// worktree lock before invoking this handler. The handler must NOT acquire or
// release the lock itself — doing so would see the lock already held (by the phase
// runner) and escalate to a human via `blocked`, bypassing the `lock_contended`
// retry contract that the phase runner enforces for all other worktree phases.
// ---------------------------------------------------------------------------

describe('conflict resolution — phase-runner pre-acquired lock (issue #524)', () => {
  const worktreePath = () => join(tmpDir, 'worktrees', 'addon-dev', 'issue-209');

  function fakeWorktreeResolver(path) {
    const calls = [];
    const resolve = (input) => {
      calls.push(input);
      return { ok: true, path, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true };
    };
    resolve.calls = calls;
    return resolve;
  }

  function fakeLock(acquireResult = { locked: true }) {
    const calls = { acquire: [], release: [] };
    return {
      calls,
      acquire(ownerId, sessionId, issueNumber) { calls.acquire.push({ ownerId, sessionId, issueNumber }); return acquireResult; },
      release(ownerId, sessionId, issueNumber) { calls.release.push({ ownerId, sessionId, issueNumber }); return { released: true }; },
    };
  }

  // Worktree-mode no-op merge: gh pr list → git fetch → git status (clean) →
  // git reset --hard → git merge (clean) → rev-parse MERGE_HEAD (none) → git merge --abort.
  function worktreeNoopRunner() {
    const prListJson = JSON.stringify([
      { number: 99, url: 'https://github.com/m2dw/test-repo/pull/99', headRefName: 'ai/issue-209' },
    ]);
    return sequenceRunner([
      { stdout: prListJson, stderr: '', exitCode: 0 },                          // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },                                  // git fetch origin (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status --porcelain (worktree, clean)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git reset --hard
      { stdout: '', stderr: '', exitCode: 0 },                                  // git merge --no-commit --no-ff (clean)
      { stdout: '', stderr: 'fatal: Needed a single revision', exitCode: 1 },   // rev-parse MERGE_HEAD (none)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git merge --abort
    ]);
  }

  // Regression test for #524: when the phase runner pre-acquires the lock and passes
  // `phaseLockOwnerId`, the handler must skip its own acquire/release entirely and
  // complete normally. Without the fix the handler would call acquire, see the lock
  // held (by the phase runner's owner), and return `blocked`.
  test('skips lock acquisition and succeeds when phase runner pre-acquired the lock', async () => {
    const wt = worktreePath();
    const runner = worktreeNoopRunner();
    const resolver = fakeWorktreeResolver(wt);
    // Lock that would return `blocked` if acquired — simulates the phase runner holding it.
    const lock = fakeLock({ locked: false, ownerContextId: 'phase-runner-owner', ownerStartedAt: '2026-07-05T14:20:42.265Z' });
    const session = {};

    const result = await createConflictResolutionHandler(
      CONTEXT({ session }), runner, resolver, lock, 'phase-runner-owner',
    )(makeTask());

    expect(result.result).toBe('success');
    // The handler must not touch the lock — acquire and release are the phase runner's job.
    expect(lock.calls.acquire).toHaveLength(0);
    expect(lock.calls.release).toHaveLength(0);
  });

  // Confirm the existing behaviour is preserved when phaseLockOwnerId is absent:
  // the handler acquires and releases the lock itself.
  test('still acquires and releases the lock itself when phaseLockOwnerId is not set', async () => {
    const wt = worktreePath();
    const runner = worktreeNoopRunner();
    const resolver = fakeWorktreeResolver(wt);
    const lock = fakeLock({ locked: true });
    const session = {};

    await createConflictResolutionHandler(
      CONTEXT({ session }), runner, resolver, lock,
    )(makeTask());

    expect(lock.calls.acquire).toHaveLength(1);
    expect(lock.calls.release).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// environmentPrepare ordering when dependency/cache-key files are conflicted (issue #523)
//
// When a configured cacheKeyFile (e.g. package-lock.json) is itself among the
// conflicted files, running `environmentPrepare` before the agent would fail
// immediately — the lockfile contains conflict markers. The handler must defer
// prepare until after the agent has resolved the dependency-file conflict.
// `commitAndPush` then runs prepare with the now-well-formed file before
// verification. When NO cacheKeyFile is conflicted, normal pre-agent timing
// applies.
// ---------------------------------------------------------------------------

describe('conflict resolution — environmentPrepare deferred for conflicted cache-key files (issue #523)', () => {
  // package-lock.json (a cacheKeyFile) is among the conflicted files.
  const LOCK_CONFLICT_LS_FILES =
    '100644 aaa 2\tpackage-lock.json\n100644 bbb 3\tpackage-lock.json\n' +
    '100644 ccc 2\tsrc/foo.ts\n100644 ddd 3\tsrc/foo.ts\n';

  const ENV_PREPARE_SESSION = {
    environmentPrepare: {
      enabled: true,
      command: 'npm ci --ignore-scripts',
      cacheKeyFiles: ['package-lock.json'],
    },
  };

  test('defers environmentPrepare when a cacheKeyFile (package-lock.json) is itself conflicted', async () => {
    // package-lock.json is in the conflicted set — running `npm ci` against it
    // would fail immediately. The handler skips pre-agent prepare and lets the
    // agent fix the file first; commitAndPush then runs prepare after resolution.
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },                         // git merge (conflicts)
      { stdout: LOCK_CONFLICT_LS_FILES, stderr: '', exitCode: 0 },             // git ls-files -u
      { stdout: '500\t200\tpackage-lock.json\n', stderr: '', exitCode: 0 },    // diff --numstat aaa bbb (pkg-lock: text)
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },             // diff --numstat ccc ddd (foo: text)
      { stdout: 'package-lock.json\nsrc/foo.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      // No pre-agent npm call — package-lock.json is conflicted.
      { stdout: '', stderr: '', exitCode: 0 },                                  // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },                  // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git ls-files -u (resolved)
      { stdout: '', stderr: '', exitCode: 0 },                                  // diff --cached --check (no markers)
      { stdout: 'package-lock.json\nsrc/foo.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (post-agent)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status (worktree clean)
      // commitAndPush: ensureEnvironmentPrepared deferred to here
      { stdout: '', stderr: '', exitCode: 0 },                                  // npm ci --ignore-scripts (post-agent prepare)
      { stdout: 'ok', stderr: '', exitCode: 0 },                               // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                                  // git push origin ai/issue-209
    ]));
    const result = await createConflictResolutionHandler(
      CONTEXT({ session: ENV_PREPARE_SESSION }), runner,
    )(makeTask());

    expect(result.result).toBe('success');
    const agentCall = findCall(runner.calls, 'claude', () => true);
    expect(agentCall).toBeTruthy();
    const agentIdx = runner.calls.indexOf(agentCall);

    // No npm call before the agent — prepare was deferred.
    const preAgentNpm = runner.calls.slice(0, agentIdx).find((c) => c.cmd === 'npm');
    expect(preAgentNpm).toBeFalsy();

    // After the agent: npm ci --ignore-scripts (prepare) then npm test (verification).
    const postAgentNpm = runner.calls.slice(agentIdx + 1).filter((c) => c.cmd === 'npm');
    expect(postAgentNpm).toHaveLength(2);
    expect(postAgentNpm[0].args).toEqual(['ci', '--ignore-scripts']);
    expect(postAgentNpm[1].args).toEqual(['test']);

    // Resolution committed and pushed.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit' && a[1] === '--no-edit')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeTruthy();
  });

  test('runs environmentPrepare before the agent when no cacheKeyFile is conflicted', async () => {
    // Only source files are conflicted — package-lock.json is not. The handler
    // runs prepare before the agent as normal; the stamp hit in commitAndPush
    // skips the second invocation so prepare runs exactly once pre-agent.
    const runner = sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },                         // git merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 },             // git ls-files -u (foo + bar, no pkg-lock)
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },             // diff --numstat aaa bbb (foo: text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },              // diff --numstat ccc ddd (bar: text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 },        // diff --cached --name-only (baseline)
      // Pre-agent prepare: package-lock.json is NOT conflicted.
      { stdout: '', stderr: '', exitCode: 0 },                                  // npm ci --ignore-scripts
      { stdout: '', stderr: '', exitCode: 0 },                                  // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },                  // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git ls-files -u (resolved)
      { stdout: '', stderr: '', exitCode: 0 },                                  // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 },        // diff --cached --name-only (post-agent)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status (worktree clean)
      // commitAndPush: prepare stamp-hit → skipped (no second npm ci call).
      { stdout: 'ok', stderr: '', exitCode: 0 },                               // npm test (verification)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                                  // git push origin ai/issue-209
    ]));
    const result = await createConflictResolutionHandler(
      CONTEXT({ session: ENV_PREPARE_SESSION }), runner,
    )(makeTask());

    expect(result.result).toBe('success');
    const agentCall = findCall(runner.calls, 'claude', () => true);
    expect(agentCall).toBeTruthy();
    const agentIdx = runner.calls.indexOf(agentCall);

    // npm ci ran BEFORE the agent.
    const preAgentNpm = runner.calls.slice(0, agentIdx).find((c) => c.cmd === 'npm');
    expect(preAgentNpm).toBeTruthy();
    expect(preAgentNpm.args).toEqual(['ci', '--ignore-scripts']);

    // Exactly one npm ci total — the post-agent call is stamp-hit → skipped.
    const allPrepare = runner.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'ci');
    expect(allPrepare).toHaveLength(1);

    // Verification still runs (npm test).
    expect(findCall(runner.calls, 'npm', (a) => a[0] === 'test')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit' && a[1] === '--no-edit')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Repeated conflict-resolution verification failure escalation (issue #536)
//
// When the same failing tests appear across consecutive conflict_resolution
// attempts, the handler escalates to `blocked` (→ ready_for_human) instead of
// retrying indefinitely. An empty failedTests set (e.g. the test runner never
// started — missing node_modules) must never trigger escalation.
// ---------------------------------------------------------------------------

describe('conflict resolution — repeated verification failure escalation (issue #536)', () => {
  // Runner sequence for a text-conflict resolution that reaches verification.
  // `verOutput` controls what the npm test step returns.
  function verificationFailureRunner(verOutput, verExitCode = 1) {
    return sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (clean)
      { stdout: verOutput, stderr: '', exitCode: verExitCode },    // npm test
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (no residue)
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
  }

  test('first failure records attempt count in context and returns failed', async () => {
    const verOutput = 'FAIL tests/foo.test.ts\n\n  ● MySuite › should pass\n\nTest Suites: 1 failed\n';
    const runner = verificationFailureRunner(verOutput);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.context.conflictResolutionVerificationAttempts).toBe(1);
    expect(result.context.semanticConflict.failedTests).toContain('MySuite › should pass');
  });

  test('repeated same-test failure escalates to blocked', async () => {
    const verOutput = 'FAIL tests/foo.test.ts\n\n  ● MySuite › should pass\n\nTest Suites: 1 failed\n';
    const runner = verificationFailureRunner(verOutput);

    // Second run: task carries semanticConflict + attempt count from the prior run.
    const task = makeTask({
      context: {
        ...makeTask().context,
        semanticConflict: {
          verificationCommandName: 'test',
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: ['MySuite › should pass'],
          logExcerpt: 'FAIL tests/foo.test.ts',
          textConflictsResolved: true,
        },
        conflictResolutionVerificationAttempts: 1,
      },
    });
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(task);

    expect(result.result).toBe('blocked');
    expect(result.context.conflictResolutionVerificationCapReached).toBe(true);
    expect(result.context.conflictResolutionVerificationAttempts).toBe(2);
    expect(result.context.conflictResolutionMaxAttempts).toBe(2);
    expect(result.context.semanticConflict.failedTests).toContain('MySuite › should pass');
    expect(result.context.conflictedFiles).toEqual(expect.arrayContaining(['src/foo.ts', 'src/bar.ts']));
    expect(result.message).toMatch(/escalat/i);
  });

  test('different failure does not collapse as identical — returns failed not blocked', async () => {
    // Current run fails with a DIFFERENT test than the prior run recorded.
    const verOutput = 'FAIL tests/bar.test.ts\n\n  ● OtherSuite › new failure\n\nTest Suites: 1 failed\n';
    const runner = verificationFailureRunner(verOutput);

    const task = makeTask({
      context: {
        ...makeTask().context,
        semanticConflict: {
          verificationCommandName: 'test',
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: ['MySuite › should pass'],
          logExcerpt: 'prior failure',
          textConflictsResolved: true,
        },
        conflictResolutionVerificationAttempts: 1,
      },
    });
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(task);

    expect(result.result).toBe('failed');
    expect(result.context.conflictResolutionVerificationCapReached).toBeUndefined();
    // Attempt count incremented but no escalation.
    expect(result.context.conflictResolutionVerificationAttempts).toBe(2);
  });

  test('empty failedTests (dependency-setup failure) does not escalate even on repeated attempts', async () => {
    // No Jest-style bullet points — test runner never started (e.g. missing node_modules).
    const verOutput = 'Error: Cannot find module jest\nnpm ERR! Test failed.\n';
    const runner = verificationFailureRunner(verOutput);

    const task = makeTask({
      context: {
        ...makeTask().context,
        // Prior run also had empty failedTests.
        semanticConflict: {
          verificationCommandName: 'test',
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: [],
          logExcerpt: 'Cannot find module jest',
          textConflictsResolved: true,
        },
        conflictResolutionVerificationAttempts: 1,
      },
    });
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(task);

    // Must not escalate — no named test failures means this is an env setup issue.
    expect(result.result).toBe('failed');
    expect(result.context.conflictResolutionVerificationCapReached).toBeUndefined();
  });

  test('maxAttempts: 1 escalates to blocked on first verification failure', async () => {
    // First run with maxAttempts:1 — no prior semanticConflict in context.
    const verOutput = 'FAIL tests/foo.test.ts\n\n  ● MySuite › should pass\n\nTest Suites: 1 failed\n';
    const runner = verificationFailureRunner(verOutput);
    const session = { conflictResolutionLoop: { maxAttempts: 1 } };
    const result = await createConflictResolutionHandler(CONTEXT({ session }), runner)(makeTask());

    expect(result.result).toBe('blocked');
    expect(result.context.conflictResolutionVerificationCapReached).toBe(true);
    expect(result.context.conflictResolutionVerificationAttempts).toBe(1);
    expect(result.context.conflictResolutionMaxAttempts).toBe(1);
    expect(result.message).toMatch(/escalat/i);
  });

  test('maxAttempts: 1 does not escalate when verFailedTests is empty (env failure)', async () => {
    // No Jest-style bullet points — test runner never started (e.g. missing node_modules).
    const verOutput = 'Error: Cannot find module jest\nnpm ERR! Test failed.\n';
    const runner = verificationFailureRunner(verOutput);
    const session = { conflictResolutionLoop: { maxAttempts: 1 } };
    const result = await createConflictResolutionHandler(CONTEXT({ session }), runner)(makeTask());

    // Must not escalate — no named test failures means this is an env setup issue.
    expect(result.result).toBe('failed');
    expect(result.context.conflictResolutionVerificationCapReached).toBeUndefined();
  });

  test('suite-level "Test suite failed to run" bullet is not treated as a named test failure', async () => {
    // Jest emits "● Test suite failed to run" (not a specific test name) when the suite
    // cannot be imported. Two consecutive setup failures with this generic bullet must not
    // be classified as a repeated semantic-conflict and must not trigger escalation.
    const suiteFailOutput =
      'FAIL tests/foo.test.ts\n\n  ● Test suite failed to run\n\n    Cannot find module \'../src/bar\'\n\nTest Suites: 1 failed\n';
    const runner = verificationFailureRunner(suiteFailOutput);

    const task = makeTask({
      context: {
        ...makeTask().context,
        semanticConflict: {
          verificationCommandName: 'test',
          verificationCommand: 'npm test',
          exitCode: 1,
          // Previous run also had the suite-level bullet filtered to empty.
          failedTests: [],
          logExcerpt: suiteFailOutput,
          textConflictsResolved: true,
        },
        conflictResolutionVerificationAttempts: 1,
      },
    });
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(task);

    // Must not escalate — "Test suite failed to run" is a setup failure, not a named test.
    expect(result.result).toBe('failed');
    expect(result.context.conflictResolutionVerificationCapReached).toBeUndefined();
    // The filtered list should be empty (suite bullet excluded).
    expect(result.context.semanticConflict.failedTests).toEqual([]);
  });

  test('respects configured maxAttempts from session conflictResolutionLoop', async () => {
    // With maxAttempts: 3, two prior failures should NOT yet escalate (only the 3rd would).
    const verOutput = 'FAIL tests/foo.test.ts\n\n  ● MySuite › should pass\n\nTest Suites: 1 failed\n';
    const runner = verificationFailureRunner(verOutput);

    const task = makeTask({
      context: {
        ...makeTask().context,
        semanticConflict: {
          verificationCommandName: 'test',
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: ['MySuite › should pass'],
          logExcerpt: 'FAIL tests/foo.test.ts',
          textConflictsResolved: true,
        },
        conflictResolutionVerificationAttempts: 1,
      },
    });
    // Second failure with maxAttempts=3: currentAttempts=2 < 3 → not yet escalated.
    const session = { conflictResolutionLoop: { maxAttempts: 3 } };
    const result = await createConflictResolutionHandler(CONTEXT({ session }), runner)(task);

    expect(result.result).toBe('failed');
    expect(result.context.conflictResolutionVerificationCapReached).toBeUndefined();
    expect(result.context.conflictResolutionVerificationAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bounded semantic context in conflict-resolution prompt (issue #538)
// ---------------------------------------------------------------------------

describe('conflict resolution — bounded semantic context in prompt (issue #538)', () => {
  // Runner through the full text-conflict path. mainSideDiff controls what the
  // git diff prBranch...baseBranch step returns for main-side context.
  function semanticContextRunner(mainSideDiff = '') {
    return sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // git merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // git ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: mainSideDiff, stderr: '', exitCode: 0 },           // git diff prBranch...baseBranch (main-side changes)
      { stdout: VALID_AGENT_OUTPUT, stderr: '', exitCode: 0 },     // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // git ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (clean)
      { stdout: 'ok', stderr: '', exitCode: 0 },                   // npm test (passes)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                     // git commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                     // git push origin ai/issue-209
    ]));
  }

  test('prompt includes issue title, body excerpt, and main-side diff when all context is available', async () => {
    const mainSideDiff = 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1,2 @@\n+// added by main\n';
    const runner = semanticContextRunner(mainSideDiff);
    const task = makeTask({
      context: {
        ...makeTask().context,
        title: 'Add feature X',
        body: 'This issue adds feature X to the codebase.',
      },
    });
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(task);

    expect(result.result).toBe('success');
    const promptPath = join(artifactRoot, 'runs', 'run-conflict-1', 'conflict-resolution-prompt.md');
    const prompt = readFileSync(promptPath, 'utf8');

    // Issue context section present with the task's title and body.
    expect(prompt).toContain('## Issue Context');
    expect(prompt).toContain('**Title**: Add feature X');
    expect(prompt).toContain('This issue adds feature X to the codebase.');

    // Main-side changes section present with bounded diff content.
    expect(prompt).toContain('## Main-Side Changes (Conflicted Files)');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('added by main');

    // Preserve-both instruction is present.
    expect(prompt).toContain('Preserve **both**');

    // No prior failure section when no prior semanticConflict.
    expect(prompt).not.toContain('## Prior Verification Failure');

    // Context artifact records what was supplied.
    const ctxPath = join(artifactRoot, 'runs', 'run-conflict-1', 'conflict-resolution-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    expect(ctx.promptContext.issueTitleAvailable).toBe(true);
    expect(ctx.promptContext.issueBodyAvailable).toBe(true);
    expect(ctx.promptContext.mainSideChangesAvailable).toBe(true);
    expect(ctx.promptContext.priorFailureAvailable).toBe(false);
  });

  test('prompt marks missing context explicitly when title, body, and main-side diff are absent', async () => {
    const runner = semanticContextRunner(''); // empty → no main-side changes
    const task = makeTask({
      context: {
        // No title or body — only the fields the handler doesn't need for prompt context.
        url: 'https://github.com/m2dw/test-repo/issues/209',
        labels: ['agent:claude', 'status:needs-conflict-resolution'],
      },
    });
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(task);

    expect(result.result).toBe('success');
    const promptPath = join(artifactRoot, 'runs', 'run-conflict-1', 'conflict-resolution-prompt.md');
    const prompt = readFileSync(promptPath, 'utf8');

    // Missing context is marked explicitly, not silently omitted.
    expect(prompt).toContain('**Title**: Not available');
    expect(prompt).toContain('Issue body not available.');
    expect(prompt).toContain('Not available — no changes detected on the base branch for these files.');

    // No prior failure section.
    expect(prompt).not.toContain('## Prior Verification Failure');

    const ctxPath = join(artifactRoot, 'runs', 'run-conflict-1', 'conflict-resolution-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    expect(ctx.promptContext.issueTitleAvailable).toBe(false);
    expect(ctx.promptContext.issueBodyAvailable).toBe(false);
    expect(ctx.promptContext.mainSideChangesAvailable).toBe(false);
    expect(ctx.promptContext.priorFailureAvailable).toBe(false);
  });

  test('prompt includes prior verification failure section when semanticConflict is in task context', async () => {
    const runner = semanticContextRunner('');
    const task = makeTask({
      context: {
        ...makeTask().context,
        // branch matches prBranch → not stale, prior failure context is surfaced.
        branch: 'ai/issue-209',
        semanticConflict: {
          verificationCommandName: 'test',
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: ['MySuite › should pass', 'OtherSuite › other test'],
          logExcerpt: 'FAIL tests/foo.test.ts\n\n  ● MySuite › should pass',
          textConflictsResolved: true,
        },
        conflictResolutionVerificationAttempts: 1,
      },
    });
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(task);

    expect(result.result).toBe('success');
    const promptPath = join(artifactRoot, 'runs', 'run-conflict-1', 'conflict-resolution-prompt.md');
    const prompt = readFileSync(promptPath, 'utf8');

    // Prior failure section is present with the recorded test names and excerpt.
    expect(prompt).toContain('## Prior Verification Failure');
    expect(prompt).toContain('MySuite › should pass');
    expect(prompt).toContain('OtherSuite › other test');
    expect(prompt).toContain('FAIL tests/foo.test.ts');

    const ctxPath = join(artifactRoot, 'runs', 'run-conflict-1', 'conflict-resolution-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    expect(ctx.promptContext.priorFailureAvailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Merge rationale recording (issue #539)
//
// Successful text-conflict runs request a bounded machine-readable rationale
// block from the agent and store it as a local artifact and internal task
// context field. Missing or malformed rationale fails closed. The rationale is
// never posted to GitHub or passed to review prompts.
// ---------------------------------------------------------------------------

describe('conflict resolution — merge rationale recording (issue #539)', () => {
  // Full happy-path sequence for a text-conflict resolution.
  function resolvedRun(agentOutput) {
    return sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: agentOutput, stderr: '', exitCode: 0 },            // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean)
      { stdout: 'ok', stderr: '', exitCode: 0 },                   // npm test (passes)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (clean after verification)
      { stdout: '', stderr: '', exitCode: 0 },                     // commit --no-edit
      { stdout: '', stderr: '', exitCode: 0 },                     // push origin ai/issue-209
    ]));
  }

  // Sequence that reaches the rationale check but returns before commit.
  // The merge is aborted after the rationale check fails; no commit/push step.
  function rationaleFailRunner(agentOutput) {
    return sequenceRunner(setupSteps([
      { stdout: '', stderr: 'CONFLICT', exitCode: 1 },             // merge (conflicts)
      { stdout: TEXT_CONFLICT_LS_FILES, stderr: '', exitCode: 0 }, // ls-files -u
      { stdout: '12\t3\tsrc/foo.ts\n', stderr: '', exitCode: 0 },  // diff --numstat (foo text)
      { stdout: '4\t5\tsrc/bar.ts\n', stderr: '', exitCode: 0 },   // diff --numstat (bar text)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (baseline)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff prBranch...baseBranch (main-side changes)
      { stdout: agentOutput, stderr: '', exitCode: 0 },            // claude (agent)
      { stdout: '', stderr: '', exitCode: 0 },                     // ls-files -u (no unmerged)
      { stdout: '', stderr: '', exitCode: 0 },                     // diff --cached --check (no markers)
      { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '', exitCode: 0 }, // diff --cached --name-only (staged ok)
      { stdout: '', stderr: '', exitCode: 0 },                     // status --porcelain (worktree clean)
      // Rationale check fails here → merge aborted, no commit/push.
      { stdout: '', stderr: '', exitCode: 0 },                     // merge --abort
    ]));
  }

  test('records merge rationale in result context and artifact on successful agent resolution', async () => {
    const runner = resolvedRun(VALID_AGENT_OUTPUT);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('success');
    // Rationale is in the internal task context.
    expect(result.context.mergeRationale).toMatchObject({
      preservedIssueIntent: 'Issue-side change preserved',
      preservedMainBehavior: 'Main-side change preserved',
      discardedBehavior: null,
      verificationNotes: 'npm test passes',
    });
    // Artifact also records the rationale.
    const dir = join(artifactRoot, 'runs', 'run-conflict-1');
    const resultJson = JSON.parse(readFileSync(join(dir, 'conflict-resolution-result.json'), 'utf8'));
    expect(resultJson.mergeRationale).toMatchObject({
      preservedIssueIntent: 'Issue-side change preserved',
      preservedMainBehavior: 'Main-side change preserved',
      discardedBehavior: null,
      verificationNotes: 'npm test passes',
    });
  });

  test('fails closed when agent output is missing the merge rationale block', async () => {
    const runner = rationaleFailRunner('Resolved all conflicts — no rationale block.');
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/rationale/i);
    // Missing rationale aborts the in-progress merge.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    // The merge must never be committed or pushed without an auditable rationale.
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'push')).toBeFalsy();
  });

  test('fails closed when the merge rationale block contains malformed JSON', async () => {
    const malformed = 'resolved\nMERGE_RATIONALE_START\nnot-valid-json\nMERGE_RATIONALE_END';
    const runner = rationaleFailRunner(malformed);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/rationale/i);
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'merge' && a[1] === '--abort')).toBeTruthy();
    expect(findCall(runner.calls, 'git', (a) => a[0] === 'commit')).toBeFalsy();
  });

  test('public output fields do not contain merge rationale content', async () => {
    const runner = resolvedRun(VALID_AGENT_OUTPUT);
    const result = await createConflictResolutionHandler(CONTEXT(), runner)(makeTask());

    expect(result.result).toBe('success');
    // Rationale is stored in the dedicated mergeRationale context field only.
    expect(result.context.mergeRationale.preservedIssueIntent).toBe('Issue-side change preserved');
    // The fields read by outbox-effects.ts for the public conflict_resolution success
    // comment are conflictResolution and conflictedFiles — neither contains rationale
    // content, so the rationale cannot appear in GitHub comments.
    expect(JSON.stringify(result.context.conflictResolution)).not.toContain('Issue-side change preserved');
    expect(JSON.stringify(result.context.conflictedFiles ?? [])).not.toContain('Issue-side change preserved');
    // No public-rationale alias fields exist on the context.
    expect(result.context).not.toHaveProperty('prCommentRationale');
    expect(result.context).not.toHaveProperty('publicMergeRationale');
  });
});
