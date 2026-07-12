/**
 * Per-issue worktree execution-context resolver (issue #438).
 *
 * Covers:
 *   - worktree-disabled sessions resolve to `{ enabled: false }` with NO git side
 *     effect (no worktree directory is ever created);
 *   - the default non-mutating mode reports the deterministic id + path with NO
 *     git side effect (no worktree dir, no `ai/issue-<n>` branch registered), so
 *     repo-working handlers in the canonical checkout cannot collide with it;
 *   - `create: true` creates the deterministic issue worktree on first use
 *     (`created: true`) and reports its stable id + path;
 *   - a second `create: true` resolve reuses the same worktree (`created: false`,
 *     same path);
 *   - the session `worktrees.root` override is honored;
 *   - a relative/invalid root is surfaced as a typed error (fail closed).
 */
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  resolveWorktreeExecutionContext,
  issueWorktreePath,
  issueWorktreeId,
} from '../dist/index.js';

let tmpDir;
let repoRoot;
let worktreeRoot;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function makeSession(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    repoKey: 'repo',
    repoRoot,
    githubRepo: 'org/repo',
    artifactDir: '.artifacts',
    artifactRoot: join(repoRoot, '.artifacts'),
    githubOwner: 'org',
    githubName: 'repo',
    baseBranch: 'main',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'a', blocked: 'b', readyForHuman: 'r' },
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'worktree-ctx-test-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  git(['add', '-A'], repoRoot);
  // A repo needs at least one commit so `git worktree add -b <branch> <path> main`
  // has a start point to branch from.
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'initial'], {
    cwd: repoRoot,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveWorktreeExecutionContext — disabled', () => {
  test('a session without a worktrees block resolves to enabled:false and touches no git', () => {
    const r = resolveWorktreeExecutionContext({ session: makeSession(), issueNumber: 7 });
    expect(r).toEqual({ ok: true, context: { enabled: false } });
    // No worktree directory was created.
    expect(existsSync(worktreeRoot)).toBe(false);
  });

  test('worktrees.enabled:false resolves to enabled:false', () => {
    const session = makeSession({ worktrees: { enabled: false, root: worktreeRoot } });
    const r = resolveWorktreeExecutionContext({ session, issueNumber: 7 });
    expect(r).toEqual({ ok: true, context: { enabled: false } });
    expect(existsSync(worktreeRoot)).toBe(false);
  });
});

describe('resolveWorktreeExecutionContext — enabled, non-mutating default', () => {
  test('computes the deterministic id + path with NO git side effect (no create flag)', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    const r = resolveWorktreeExecutionContext({ session, issueNumber: 7, env: {} });

    expect(r.ok).toBe(true);
    expect(r.context.enabled).toBe(true);
    // Nothing was created in the default mode.
    expect(r.context.created).toBe(false);
    expect(r.context.branch).toBe('ai/issue-7');
    expect(r.context.worktreeId).toBe(issueWorktreeId('addon-dev', 7));
    expect(r.context.worktreePath).toBe(issueWorktreePath(worktreeRoot, 'addon-dev', 7));

    // No worktree directory was materialized and no branch was registered against
    // the canonical repo, so a later repo-working handler in the canonical checkout
    // cannot collide with an already-created `ai/issue-7` worktree.
    expect(existsSync(worktreeRoot)).toBe(false);
    const list = git(['worktree', 'list', '--porcelain'], repoRoot);
    expect(list).not.toContain('branch refs/heads/ai/issue-7');
  });

  test('still validates the configured root before reporting (relative root fails closed)', () => {
    const session = makeSession({ worktrees: { enabled: true, root: 'relative/worktrees' } });
    const r = resolveWorktreeExecutionContext({ session, issueNumber: 7, env: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/absolute path/);
  });

  test('fails closed when an absolute root lives inside the canonical checkout (non-mutating path)', () => {
    // An absolute root *inside* repoRoot passes the relative-root guard but would
    // plant any later worktree under committed source. The mutating path already
    // rejects this; the non-mutating default must apply the same outside-checkout
    // validation rather than reporting an unusable in-repo worktree identity.
    const insideRoot = join(repoRoot, 'worktrees');
    const session = makeSession({ worktrees: { enabled: true, root: insideRoot } });
    const r = resolveWorktreeExecutionContext({ session, issueNumber: 7, env: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must live outside the canonical checkout/);
    // No in-repo worktree path was reported and nothing was materialized.
    expect(existsSync(insideRoot)).toBe(false);
  });
});

describe('resolveWorktreeExecutionContext — enabled, create:true', () => {
  test('creates the deterministic issue worktree on first use', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    const r = resolveWorktreeExecutionContext({ session, issueNumber: 7, env: {}, create: true });

    expect(r.ok).toBe(true);
    expect(r.context.enabled).toBe(true);
    expect(r.context.created).toBe(true);
    expect(r.context.branch).toBe('ai/issue-7');
    expect(r.context.worktreeId).toBe(issueWorktreeId('addon-dev', 7));

    const expectedPath = issueWorktreePath(worktreeRoot, 'addon-dev', 7);
    // The returned path is canonicalized (symlinks resolved), so compare suffix.
    expect(r.context.worktreePath.endsWith(join('addon-dev', 'issue-7', 'repo'))).toBe(true);
    expect(existsSync(expectedPath)).toBe(true);

    // The branch was registered against the canonical repo's worktree list.
    const list = git(['worktree', 'list', '--porcelain'], repoRoot);
    expect(list).toContain('branch refs/heads/ai/issue-7');
  });

  test('reuses the existing worktree on a later resolve (created:false, same path)', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    const first = resolveWorktreeExecutionContext({ session, issueNumber: 7, env: {}, create: true });
    expect(first.context.created).toBe(true);

    const second = resolveWorktreeExecutionContext({ session, issueNumber: 7, env: {}, create: true });
    expect(second.ok).toBe(true);
    expect(second.context.enabled).toBe(true);
    expect(second.context.created).toBe(false);
    expect(second.context.worktreePath).toBe(first.context.worktreePath);
    expect(second.context.worktreeId).toBe(first.context.worktreeId);
  });

  test('honors the N8N_AI_WORKTREE_ROOT env override when no session root is set', () => {
    const session = makeSession({ worktrees: { enabled: true } });
    const r = resolveWorktreeExecutionContext({
      session,
      issueNumber: 9,
      env: { N8N_AI_WORKTREE_ROOT: worktreeRoot },
      create: true,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(issueWorktreePath(worktreeRoot, 'addon-dev', 9))).toBe(true);
  });

  test('fails closed with a typed error when the configured root is relative', () => {
    const session = makeSession({ worktrees: { enabled: true, root: 'relative/worktrees' } });
    const r = resolveWorktreeExecutionContext({ session, issueNumber: 7, env: {}, create: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/absolute path/);
    expect(existsSync(worktreeRoot)).toBe(false);
  });
});
