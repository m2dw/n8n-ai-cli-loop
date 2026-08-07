/**
 * Research runs in a detached per-run Issue worktree (issue #855).
 *
 * These tests use real git repositories — a bare `origin`, the canonical
 * checkout, and a second clone that pushes ahead of it — because the bug being
 * fixed is precisely about the relationship between those three. A stub cannot
 * demonstrate that a run observed the freshly fetched remote commit rather than
 * the stale local one.
 *
 * The agent itself is a spy runner: what matters here is which directory it was
 * launched in, what that directory contained, and whether it was launched at all
 * when workspace preparation failed.
 */
import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createResearchHandler } from '../dist/handlers/research.js';
import { defaultCommandRunner } from '../dist/handlers/command-runner.js';
import {
  prepareResearchWorkspace,
  releaseResearchWorkspace,
} from '../dist/handlers/research-worktree.js';
import { IssueWorktreeLock } from '../dist/handlers/worktree.js';

// Every case here spawns several real git subprocesses (init, clone, fetch,
// worktree add/remove); the 5s default is not enough under the parallel run.
jest.setTimeout(30_000);

const RUN_ID = 'run-855-1';
const ISSUE = 42;

let tmpDir;
let originPath;
let repoRoot;
let otherClone;
let artifactRoot;
let worktreeRoot;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

const SESSION = (overrides = {}) => ({
  sessionId: 'addon-dev',
  repoKey: 'test-repo',
  repoRoot,
  githubRepo: 'm2dw/test-repo',
  artifactDir: '.n8n-artifacts',
  artifactRoot,
  baseBranch: 'main',
  githubOwner: 'm2dw',
  githubName: 'test-repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  worktrees: { root: worktreeRoot },
  ...overrides,
});

const CONTEXT = (overrides = {}) => ({
  session: SESSION(overrides.session ?? {}),
  runId: RUN_ID,
  workerId: 'worker-test',
});

function makeTask(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: ISSUE,
    status: 'running',
    phase: 'research',
    priority: 'normal',
    researchAgent: 'gemini',
    attempts: {},
    context: { title: 'Analyse the dataset', labels: [] },
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Spy agent runner. It inspects the workspace AT INVOCATION TIME — the worktree
 * is removed again before the handler returns, so anything a test wants to know
 * about the tree the agent saw has to be captured here.
 */
function spyAgent(result = { stdout: '## Findings\n\nAll good.', stderr: '', exitCode: 0 }) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) {
      let head;
      try {
        head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: opts.cwd, encoding: 'utf8' }).trim();
      } catch {
        head = null;
      }
      calls.push({
        cmd,
        args,
        opts,
        head,
        files: existsSync(opts.cwd)
          ? execFileSync('git', ['ls-files'], { cwd: opts.cwd, encoding: 'utf8' }).split('\n').filter(Boolean)
          : [],
      });
      return result;
    },
  };
}

/** A lock that never blocks, so tests do not touch the real lock directory. */
function freeLock() {
  return {
    acquire: () => ({ locked: true, ownerContextId: RUN_ID, ownerStartedAt: '2026-08-07T00:00:00.000Z' }),
    release: () => ({ released: true }),
  };
}

const artifactRunDir = () => join(artifactRoot, 'runs', RUN_ID);
const researchWorktreePath = (runId = RUN_ID) =>
  join(worktreeRoot, 'addon-dev', `issue-${ISSUE}`, `research-${runId}`);

function handler(runner, opts = {}) {
  return createResearchHandler(
    CONTEXT(opts.context ?? {}),
    runner,
    undefined,
    undefined,
    undefined,
    undefined,
    { issueLock: opts.issueLock ?? freeLock(), ...(opts.runtime ? { runtime: opts.runtime } : {}) },
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'research-worktree-test-'));
  originPath = join(tmpDir, 'origin.git');
  repoRoot = join(tmpDir, 'repo');
  otherClone = join(tmpDir, 'other');
  artifactRoot = join(tmpDir, 'artifacts');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originPath]);
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
  git(['remote', 'add', 'origin', originPath], repoRoot);
  git(['push', '-q', 'origin', 'main'], repoRoot);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Push a commit to origin from a second clone, leaving the canonical checkout's
 * local `main` behind — the incident's shape: the dependency's data was merged
 * remotely while the shared checkout still predated it.
 */
function advanceOrigin(fileName = 'dataset.txt', content = 'transcribed rows\n') {
  execFileSync('git', ['clone', '-q', originPath, otherClone]);
  writeFileSync(join(otherClone, fileName), content, 'utf8');
  git(['add', '-A'], otherClone);
  git(['commit', '-q', '-m', 'add dataset'], otherClone);
  git(['push', '-q', 'origin', 'main'], otherClone);
  return git(['rev-parse', 'HEAD'], otherClone);
}

describe('research worktree — freshness', () => {
  test('a canonical checkout behind origin still researches the fetched remote base', async () => {
    const remoteSha = advanceOrigin();
    const localSha = git(['rev-parse', 'HEAD'], repoRoot);
    expect(localSha).not.toBe(remoteSha);

    const spy = spyAgent();
    const result = await handler(spy)(makeTask());

    expect(result.result).toBe('success');
    expect(spy.calls).toHaveLength(1);
    // The agent ran in the research worktree, not the canonical checkout.
    expect(spy.calls[0].opts.cwd).not.toBe(repoRoot);
    // …and that worktree was at the commit the canonical checkout lacks, which
    // is the whole point: the stale run reported the data as still missing.
    expect(spy.calls[0].head).toBe(remoteSha);
  });

  test('the research worktree contains the file only the newer remote base has', async () => {
    advanceOrigin('dataset.txt', 'rows\n');
    const spy = spyAgent();
    await handler(spy)(makeTask());
    expect(spy.calls[0].files).toContain('dataset.txt');
    // The canonical checkout is still without it — it was never updated.
    expect(existsSync(join(repoRoot, 'dataset.txt'))).toBe(false);
  });
});

describe('research worktree — the canonical checkout is untouched', () => {
  test('a dirty canonical working tree and its branch survive byte-for-byte', async () => {
    advanceOrigin();
    // Operator work in progress: an uncommitted edit and an untracked file on a
    // locally managed branch.
    git(['checkout', '-q', '-b', 'operator/manual'], repoRoot);
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n\nlocal edit\n', 'utf8');
    writeFileSync(join(repoRoot, 'scratch.txt'), 'do not touch\n', 'utf8');
    const beforeStatus = git(['status', '--porcelain'], repoRoot);
    const beforeBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const beforeHead = git(['rev-parse', 'HEAD'], repoRoot);

    const result = await handler(spyAgent())(makeTask());

    expect(result.result).toBe('success');
    expect(git(['status', '--porcelain'], repoRoot)).toBe(beforeStatus);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)).toBe(beforeBranch);
    expect(git(['rev-parse', 'HEAD'], repoRoot)).toBe(beforeHead);
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('# repo\n\nlocal edit\n');
    expect(readFileSync(join(repoRoot, 'scratch.txt'), 'utf8')).toBe('do not touch\n');
  });

  test('no ai/issue-<n> branch is created for a read-only research run', async () => {
    await handler(spyAgent())(makeTask());
    const branches = git(['for-each-ref', '--format=%(refname)', 'refs/heads'], repoRoot);
    expect(branches).not.toContain(`refs/heads/ai/issue-${ISSUE}`);
  });

  test('the worktree is detached, not on a branch', async () => {
    let detached;
    const observing = {
      run(cmd, args, opts) {
        const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
        const record = porcelain
          .split('\n\n')
          .find((block) => block.includes(`research-${RUN_ID}`));
        detached = record !== undefined && record.includes('detached');
        return { stdout: 'findings', stderr: '', exitCode: 0 };
      },
    };
    await handler(observing)(makeTask());
    expect(detached).toBe(true);
  });
});

describe('research worktree — preparation failures stop before the agent', () => {
  test('an unfetchable base fails the run and never invokes the agent', async () => {
    git(['remote', 'set-url', 'origin', join(tmpDir, 'no-such-remote.git')], repoRoot);
    const spy = spyAgent();

    const result = await handler(spy)(makeTask());

    expect(result.result).toBe('failed');
    expect(spy.calls).toHaveLength(0);
    expect(result.error).toContain("base branch 'main' could not be fetched");
    expect(result.error).toContain('no research workspace was prepared');
    // Public-safe: the git text (which names local paths) stays local.
    expect(result.error).not.toContain(tmpDir);

    const failure = JSON.parse(
      readFileSync(join(artifactRunDir(), 'research-workspace-failure.json'), 'utf8'),
    );
    expect(failure.stage).toBe('fetch-base');
    expect(failure.agentInvoked).toBe(false);
    expect(failure.baseBranch).toBe('main');
  });

  test('a base branch that does not exist on origin fails before the agent', async () => {
    const spy = spyAgent();
    const missingBase = createResearchHandler(
      { session: { ...SESSION(), baseBranch: 'release' }, runId: 'run-855-2', workerId: 'worker-test' },
      spy,
      undefined,
      undefined,
      undefined,
      undefined,
      { issueLock: freeLock() },
    );
    const failed = await missingBase(makeTask());
    expect(failed.result).toBe('failed');
    expect(failed.error).toContain("'release'");
    expect(spy.calls).toHaveLength(0);
  });

  test('an occupied worktree path fails the run and never invokes the agent', async () => {
    // A foreign directory git knows nothing about must never be deleted, so
    // preparation fails closed instead of clearing the path.
    const occupied = researchWorktreePath();
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'someone-elses-file.txt'), 'keep me\n', 'utf8');
    const spy = spyAgent();

    const result = await handler(spy)(makeTask());

    expect(result.result).toBe('failed');
    expect(spy.calls).toHaveLength(0);
    const failure = JSON.parse(
      readFileSync(join(artifactRunDir(), 'research-workspace-failure.json'), 'utf8'),
    );
    expect(failure.stage).toBe('worktree-create');
    expect(readFileSync(join(occupied, 'someone-elses-file.txt'), 'utf8')).toBe('keep me\n');
  });

  test('a relative worktree root fails closed instead of resolving against the cwd', () => {
    // Same contract `resolveIssueWorktree` enforces: a relative root would be
    // canonicalized against the process cwd, planting the managed checkout
    // somewhere the caller never named — and passing the "outside repoRoot"
    // check while doing it. No git work may happen first.
    const runner = {
      calls: [],
      run(cmd, args, opts) {
        runner.calls.push(args);
        return defaultCommandRunner.run(cmd, args, opts);
      },
    };

    const prepared = prepareResearchWorkspace({
      repoRoot,
      sessionId: 'addon-dev',
      issueNumber: ISSUE,
      runId: RUN_ID,
      baseBranch: 'main',
      worktreeRoot: 'relative-worktrees',
      runner,
    });

    expect(prepared.ok).toBe(false);
    expect(prepared.stage).toBe('worktree-root');
    expect(prepared.error).toContain('absolute path');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(join(process.cwd(), 'relative-worktrees'))).toBe(false);
  });
});

describe('research worktree — recorded metadata', () => {
  test('context and result artifacts record the exact base ref and commit', async () => {
    const remoteSha = advanceOrigin();
    await handler(spyAgent())(makeTask());

    const ctx = JSON.parse(readFileSync(join(artifactRunDir(), 'research-context.json'), 'utf8'));
    expect(ctx.workspace).toMatchObject({
      scope: 'issue-research-worktree',
      detached: true,
      branchCreated: false,
      baseBranch: 'main',
      baseRef: 'refs/remotes/origin/main',
      baseSha: remoteSha,
      worktreeId: `addon-dev/issue-${ISSUE}/research-${RUN_ID}`,
    });

    const res = JSON.parse(readFileSync(join(artifactRunDir(), 'research-result.json'), 'utf8'));
    expect(res.workspace.baseSha).toBe(remoteSha);
    expect(res.workspace.baseRef).toBe('refs/remotes/origin/main');
    expect(res.workspace.release).toBe('removed');

    const brief = JSON.parse(readFileSync(join(artifactRunDir(), 'research-brief.json'), 'utf8'));
    expect(brief.cwdPolicy).toBe('issue-research-worktree');
  });

  test('the success context carries the base commit and no absolute worktree path', async () => {
    const remoteSha = advanceOrigin();
    const result = await handler(spyAgent())(makeTask());
    expect(result.context.researchWorkspace.baseSha).toBe(remoteSha);
    expect(JSON.stringify(result.context.researchWorkspace)).not.toContain(worktreeRoot);
  });
});

describe('research worktree — cleanup', () => {
  test('the worktree is removed after the run while artifacts survive', async () => {
    const result = await handler(spyAgent())(makeTask());
    expect(result.result).toBe('success');

    expect(existsSync(researchWorktreePath())).toBe(false);
    const porcelain = git(['worktree', 'list', '--porcelain'], repoRoot);
    expect(porcelain).not.toContain(`research-${RUN_ID}`);

    // Run artifacts live outside the worktree and are untouched by its removal.
    expect(existsSync(join(artifactRunDir(), 'research-output.md'))).toBe(true);
    expect(existsSync(join(artifactRunDir(), 'research-result.json'))).toBe(true);
  });

  test('a failing agent run still removes the worktree and keeps the capture', async () => {
    const failing = spyAgent({ stdout: '', stderr: 'agy: boom', exitCode: 3 });
    const result = await handler(failing)(makeTask());

    expect(result.result).toBe('failed');
    expect(existsSync(researchWorktreePath())).toBe(false);
    expect(existsSync(join(artifactRunDir(), 'research-output.md'))).toBe(true);
  });

  test('an artifact root configured inside the worktree retains it instead of deleting artifacts', async () => {
    // A session may place `artifactRoot` inside the managed worktree tree
    // (issue #629). Removal would then destroy the run's own diagnostics, so the
    // checkout is retained and the retention is recorded.
    artifactRoot = join(researchWorktreePath(), '.n8n-artifacts');
    const result = await handler(spyAgent())(makeTask());

    expect(result.result).toBe('success');
    expect(existsSync(join(artifactRoot, 'runs', RUN_ID, 'research-result.json'))).toBe(true);
    const res = JSON.parse(
      readFileSync(join(artifactRoot, 'runs', RUN_ID, 'research-result.json'), 'utf8'),
    );
    expect(res.workspace.release).toBe('retained-artifacts-inside');
  });
});

/**
 * `refs/remotes/origin/<base>` is shared by every issue in the session, but the
 * lock this phase takes is issue-scoped — so two research runs for different
 * issues legitimately overlap, and git makes one of them lose the ref update
 * when the base advances between them. That loser must not fail the run.
 */
describe('research worktree — concurrent base-ref refresh', () => {
  // What git prints to the loser of a remote-tracking ref update race.
  const REF_LOCK_STDERR =
    "error: cannot lock ref 'refs/remotes/origin/main': is at "
    + '1111111111111111111111111111111111111111 but expected '
    + '2222222222222222222222222222222222222222\n'
    + ' ! [new branch]      main -> origin/main  (unable to update local ref)\n';

  /**
   * Real git for everything except the first `failures` fetches, which report
   * the race the way the losing updater sees it. Standing in for the concurrent
   * run is the only way to make this deterministic — two real fetches racing
   * would collide only by luck.
   */
  function contendedFetchRunner(failures, stderr = REF_LOCK_STDERR, exitCode = 1) {
    const fetches = [];
    return {
      fetches,
      run(cmd, args, opts) {
        if (args[0] === 'fetch') {
          fetches.push(args);
          if (fetches.length <= failures) return { stdout: '', stderr, exitCode };
        }
        return defaultCommandRunner.run(cmd, args, opts);
      },
    };
  }

  const prepare = (runner) =>
    prepareResearchWorkspace({
      repoRoot,
      sessionId: 'addon-dev',
      issueNumber: ISSUE,
      runId: RUN_ID,
      baseBranch: 'main',
      worktreeRoot,
      runner,
    });

  test('a lost ref-update race is retried and the run still gets the fetched base', () => {
    const remoteSha = advanceOrigin();
    const runner = contendedFetchRunner(1);

    const prepared = prepare(runner);

    expect(prepared.ok).toBe(true);
    expect(runner.fetches).toHaveLength(2);
    // The retry fetched for real, so the worktree is at the remote commit — the
    // freshness guarantee survives the contention.
    expect(prepared.workspace.baseSha).toBe(remoteSha);
    expect(git(['rev-parse', 'HEAD'], prepared.workspace.path)).toBe(remoteSha);

    releaseResearchWorkspace({ repoRoot, workspace: prepared.workspace });
  });

  test('contention that never clears fails closed after a bounded number of attempts', () => {
    const runner = contendedFetchRunner(Number.MAX_SAFE_INTEGER);

    const prepared = prepare(runner);

    expect(prepared.ok).toBe(false);
    expect(prepared.stage).toBe('fetch-base');
    expect(prepared.error).toContain('4 attempts');
    // Bounded: a permanently contended ref must not retry forever.
    expect(runner.fetches).toHaveLength(4);
    expect(existsSync(researchWorktreePath())).toBe(false);
  });

  test('a fetch failure that is not a ref race is not retried', () => {
    const runner = contendedFetchRunner(
      Number.MAX_SAFE_INTEGER,
      'fatal: could not read from remote repository.\n',
      128,
    );

    const prepared = prepare(runner);

    expect(prepared.ok).toBe(false);
    expect(prepared.stage).toBe('fetch-base');
    expect(runner.fetches).toHaveLength(1);
    expect(prepared.error).not.toContain('attempts');
  });
});

describe('research worktree — issue lock reuse', () => {
  test('the run takes the issue-scoped worktree lock and releases it', async () => {
    const lockDir = join(tmpDir, 'locks');
    const lock = new IssueWorktreeLock(lockDir);
    const result = await handler(spyAgent(), { issueLock: lock })(makeTask());

    expect(result.result).toBe('success');
    // Released: a second acquisition by a different owner succeeds.
    expect(lock.acquire('other-run', 'addon-dev', ISSUE).locked).toBe(true);
  });

  test('a lock held by another execution blocks the run before any git work', async () => {
    const lockDir = join(tmpDir, 'locks');
    const lock = new IssueWorktreeLock(lockDir);
    expect(lock.acquire('someone-else', 'addon-dev', ISSUE).locked).toBe(true);

    const spy = spyAgent();
    const result = await handler(spy, { issueLock: lock })(makeTask());

    expect(result.result).toBe('blocked');
    expect(result.message).toContain('worktree lock');
    expect(spy.calls).toHaveLength(0);
    expect(existsSync(researchWorktreePath())).toBe(false);
  });
});
