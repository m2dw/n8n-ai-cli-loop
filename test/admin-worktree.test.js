import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveIssueWorktree, issueWorktreePath, canonicalizePath } from '../dist/index.js';
import { sanitizeBody, sessionRedactionPaths } from '../dist/core/outbox-effects.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let repoRoot;
let worktreeRoot;
let sessionsPath;

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

function writeSessions() {
  const sessions = {
    sessions: [
      {
        sessionId: 'addon-dev',
        repoKey: 'test-repo',
        repoRoot,
        githubRepo: 'm2dw/test-repo',
        artifactDir: '.n8n-artifacts',
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        verification: { test: 'npm test' },
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        worktrees: { enabled: true, root: worktreeRoot },
      },
    ],
  };
  writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-worktree-test-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  sessionsPath = join(tmpDir, 'sessions.json');
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

describe('admin worktree list', () => {
  test('lists the canonical repo and flags managed per-issue worktrees', () => {
    createIssueWorktree(101);
    const r = run('worktree', 'list', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.worktreeRoot).toBe(worktreeRoot);

    const canonical = out.worktrees.find((w) => canonicalizePath(w.path) === canonicalizePath(repoRoot));
    expect(canonical.isCanonical).toBe(true);
    expect(canonical.managed).toBe(false);

    const issuePath = canonicalizePath(issueWorktreePath(worktreeRoot, 'addon-dev', 101));
    const issue = out.worktrees.find((w) => canonicalizePath(w.path) === issuePath);
    expect(issue).toBeDefined();
    expect(issue.managed).toBe(true);
    expect(issue.branch).toBe('refs/heads/ai/issue-101');
  });

  test('requires --session-id', () => {
    const r = run('worktree', 'list', '--sessions-path', sessionsPath);
    expect(r.code).toBe(1);
  });

  // Regression (issue #400): worktree-root resolution moved out of loadSessionInfo
  // so unrelated commands tolerate a bad override — but worktree commands must
  // still reject a relative root rather than silently using one.
  test('rejects a relative N8N_AI_WORKTREE_ROOT override', () => {
    // Session without an absolute worktrees.root so the env override is consulted.
    writeFileSync(sessionsPath, JSON.stringify({
      sessions: [{
        sessionId: 'addon-dev',
        repoKey: 'test-repo',
        repoRoot,
        githubRepo: 'm2dw/test-repo',
        artifactDir: '.n8n-artifacts',
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        verification: {},
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
      }],
    }, null, 2));
    let code = 0;
    try {
      execFileSync(
        process.execPath,
        [CLI, 'worktree', 'list', '--session-id', 'addon-dev', '--sessions-path', sessionsPath],
        { encoding: 'utf8', env: { ...process.env, N8N_AI_WORKTREE_ROOT: 'relative/worktrees' } },
      );
    } catch (err) {
      code = err.status ?? 1;
    }
    expect(code).toBe(1);
  });
});

describe('admin worktree prune', () => {
  test('previews by default, then removes with --yes', () => {
    const wt = createIssueWorktree(101);
    expect(existsSync(wt.path)).toBe(true);

    const preview = run('worktree', 'prune', '--session-id', 'addon-dev', '--issue-number', '101', '--sessions-path', sessionsPath);
    expect(preview.code).toBe(0);
    const previewOut = JSON.parse(preview.stdout.trim());
    expect(previewOut.removed).toBe(false);
    expect(previewOut.wouldRemove).toBe(true);
    expect(existsSync(wt.path)).toBe(true);

    const removed = run('worktree', 'prune', '--session-id', 'addon-dev', '--issue-number', '101', '--yes', '--sessions-path', sessionsPath);
    expect(removed.code).toBe(0);
    const removedOut = JSON.parse(removed.stdout.trim());
    expect(removedOut.removed).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  test('missing worktree is a safe no-op (exit 0)', () => {
    const r = run('worktree', 'prune', '--session-id', 'addon-dev', '--issue-number', '999', '--yes', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.removed).toBe(false);
    expect(out.reason).toBe('not_found');
  });

  test('--force discards a dirty worktree', () => {
    const wt = createIssueWorktree(102);
    writeFileSync(join(wt.path, 'dirty.txt'), 'x');

    const refused = run('worktree', 'prune', '--session-id', 'addon-dev', '--issue-number', '102', '--yes', '--sessions-path', sessionsPath);
    // git refuses to remove a dirty worktree without --force, so the CLI dies non-zero.
    expect(refused.code).toBe(1);
    expect(existsSync(wt.path)).toBe(true);

    const forced = run('worktree', 'prune', '--session-id', 'addon-dev', '--issue-number', '102', '--yes', '--force', '--sessions-path', sessionsPath);
    expect(forced.code).toBe(0);
    expect(existsSync(wt.path)).toBe(false);
  });

  test('unknown worktree action exits non-zero', () => {
    const r = run('worktree', 'bogus', '--session-id', 'addon-dev');
    expect(r.code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Public-comment redaction: a local worktree path must never reach a comment.
// ---------------------------------------------------------------------------

describe('worktree path redaction in published comments', () => {
  const session = {
    repoRoot: '/srv/repo',
    artifactRoot: '/srv/repo/.n8n-artifacts',
    worktrees: { enabled: true, root: '/var/lib/n8n-wt/worktrees' },
  };

  test('sessionRedactionPaths includes the worktree state root', () => {
    expect(sessionRedactionPaths(session)).toContain('/var/lib/n8n-wt/worktrees');
  });

  test('sanitizeBody strips a worktree path from a comment body', () => {
    const body = 'Ran in /var/lib/n8n-wt/worktrees/addon-dev/issue-7/repo and pushed.';
    const cleaned = sanitizeBody(body, sessionRedactionPaths(session));
    expect(cleaned).not.toContain('/var/lib/n8n-wt/worktrees');
    expect(cleaned).toContain('<path>');
  });
});
