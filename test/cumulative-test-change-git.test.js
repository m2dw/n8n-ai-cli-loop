// Issue #1153 — Stage 1 changed-file selection against real Git repositories
// (docs/changed-file-verification-contract.md §4.1 and §4.2).
//
// Exact file sets for the cumulative net change of an Issue: across two
// implementation runs (committed, staged, unstaged, untracked, ignored and
// restored content), on a branch stacked on a predecessor Issue branch, through
// a rename, a deletion and a mode-only change (also under core.fileMode=false),
// through an untracked-in-place symlink and an unmerged index, and with an Issue
// base absent from the object store. The runnable-file report stands in for the project
// tooling: every `*.test.js` under `test/` in the worktree, ignored or not.
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import {
  readCumulativeChange,
  readIssueBranchStart,
  resolveIssueBase,
  selectStage1TestFiles,
} from '../dist/index.js';
import { defaultCommandRunner } from '../dist/handlers/command-runner.js';

const TIMEOUT = 30_000;

let tmpDir;
let repo;

function git(args, cwd = repo) {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function write(path, content) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function commitAll(message) {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

/** The stand-in runnable-file report: every `*.test.js` under `test/`, as ids. */
function inventory() {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const id = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${id}/`);
      else if (entry.name.endsWith('.test.js')) files.push(id);
    }
  };
  walk(join(repo, 'test'), 'test/');
  return { kind: 'readable', files };
}

const noRetained = { kind: 'readable', files: [] };

function selectedFiles(selection) {
  expect(selection.status).toBe('known');
  return selection.files.map((entry) => entry.file);
}

function selectAt(issueBase, retained = noRetained) {
  const change =
    issueBase.status === 'resolved'
      ? readCumulativeChange(defaultCommandRunner, { cwd: repo, base: issueBase.base.sha })
      : { kind: 'unreadable', reason: 'no base' };
  return selectStage1TestFiles({ issueBase, change, inventory: inventory(), retained });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cumulative-test-change-'));
  repo = join(tmpDir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(['config', 'core.fileMode', 'true']);
  write('.gitignore', 'test/ignored.test.js\n');
  write('src/x.js', 'export const x = 1;\n');
  write('test/a.test.js', "test('a', () => {});\n");
  write('test/b.test.js', "test('b', () => {});\n");
  write('test/c.test.js', "test('c', () => {});\n");
  const initial = commitAll('initial');
  // The session base branch's remote-tracking ref, as a fetch left it.
  git(['update-ref', 'refs/remotes/origin/main', initial]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('cumulative Issue-relative selection', () => {
  test('two implementation runs select the exact cumulative set from a fixed base', () => {
    const start = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'ai/issue-1']);

    // Implementation run 1: committed work.
    write('test/a.test.js', "test('a changed', () => {});\n");
    write('test/new.test.js', "test('new', () => {});\n");
    write('src/x.js', 'export const x = 2;\n');
    commitAll('run 1');

    const first = resolveIssueBase({
      dependencyBase: { missing: false },
      readBranchStart: () => readIssueBranchStart(defaultCommandRunner, { cwd: repo, baseBranch: 'main' }),
    });
    expect(first).toEqual({ status: 'resolved', base: { sha: start, source: 'branch-start' }, firstResolution: true });
    expect(selectedFiles(selectAt(first))).toEqual(['test/a.test.js', 'test/new.test.js']);

    // The base branch moves on after run 1; the recorded base does not.
    git(['checkout', '-q', 'main']);
    write('test/main-only.test.js', "test('main', () => {});\n");
    git(['update-ref', 'refs/remotes/origin/main', commitAll('main moves')]);
    git(['checkout', '-q', 'ai/issue-1']);
    const recorded = resolveIssueBase({
      recorded: first.base,
      dependencyBase: { missing: false },
      readBranchStart: () => {
        throw new Error('a recorded base is never recomputed');
      },
    });
    expect(recorded.base).toEqual(first.base);

    // Implementation run 2: uncommitted work of every kind.
    write('test/staged.test.js', "test('staged', () => {});\n");
    git(['add', 'test/staged.test.js']);
    write('test/b.test.js', "test('b unstaged edit', () => {});\n");
    write('test/untracked.test.js', "test('untracked', () => {});\n");
    write('test/ignored.test.js', "test('ignored', () => {});\n");
    write('test/c.test.js', "test('c edited', () => {});\n");
    write('test/c.test.js', "test('c', () => {});\n"); // restored to its base content
    write('src/y.js', 'export const y = 1;\n');

    const second = selectAt(recorded);
    expect(selectedFiles(second)).toEqual([
      'test/a.test.js',
      'test/b.test.js',
      'test/new.test.js',
      'test/staged.test.js',
      'test/untracked.test.js',
    ]);
    expect(second.files.every((entry) => entry.reasons.join() === 'changed')).toBe(true);
    expect(second.issueBase).toEqual({ sha: start, source: 'branch-start' });
  }, TIMEOUT);

  test('a branch stacked on a predecessor Issue selects only its own changes', () => {
    const start = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'ai/issue-10']);
    write('test/p.test.js', "test('predecessor', () => {});\n");
    write('test/a.test.js', "test('a from predecessor', () => {});\n");
    const predecessorHead = commitAll('predecessor');

    git(['checkout', '-q', '-b', 'ai/issue-11']);
    write('test/q.test.js', "test('successor', () => {});\n");
    commitAll('successor');
    write('test/b.test.js', "test('b successor edit', () => {});\n");

    const issueBase = resolveIssueBase({
      dependencyBase: { base: { sha: predecessorHead }, missing: false },
      readBranchStart: () => {
        throw new Error('a dependency-started Issue never reads the branch start');
      },
    });
    expect(issueBase.base).toEqual({ sha: predecessorHead, source: 'dependency-base' });
    expect(selectedFiles(selectAt(issueBase))).toEqual(['test/b.test.js', 'test/q.test.js']);

    // Measured from the base branch instead, the predecessor's files would leak in.
    expect(readIssueBranchStart(defaultCommandRunner, { cwd: repo, baseBranch: 'main' })).toEqual({
      kind: 'readable',
      sha: start,
    });
    const fromBranchStart = selectAt({ status: 'resolved', base: { sha: start, source: 'branch-start' }, firstResolution: true });
    expect(selectedFiles(fromBranchStart)).toEqual([
      'test/a.test.js',
      'test/b.test.js',
      'test/p.test.js',
      'test/q.test.js',
    ]);
  }, TIMEOUT);

  test('a rename selects the new path, a deletion nothing, a mode change the file, and a gone retained file stays unresolved', () => {
    const start = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'ai/issue-2']);
    git(['mv', 'test/a.test.js', 'test/a-renamed.test.js']);
    git(['rm', '-q', 'test/b.test.js']);
    commitAll('rename and delete');
    chmodSync(join(repo, 'test/c.test.js'), 0o755);

    const change = readCumulativeChange(defaultCommandRunner, { cwd: repo, base: start });
    expect(change).toEqual({
      kind: 'readable',
      base: start,
      entries: [
        { path: 'test/a-renamed.test.js', change: 'added' },
        { path: 'test/a.test.js', change: 'deleted' },
        { path: 'test/b.test.js', change: 'deleted' },
        { path: 'test/c.test.js', change: 'modified' },
      ],
    });

    const issueBase = { status: 'resolved', base: { sha: start, source: 'branch-start' }, firstResolution: false };
    const selection = selectAt(issueBase, {
      kind: 'readable',
      files: [{ file: 'test/b.test.js', addedBy: '1/review/final/0' }],
    });
    expect(selection).toMatchObject({
      status: 'known',
      files: [
        { file: 'test/a-renamed.test.js', reasons: ['changed'] },
        { file: 'test/c.test.js', reasons: ['changed'] },
      ],
      unresolvedRetained: ['test/b.test.js'],
    });
  }, TIMEOUT);

  test('a base file untracked in place is unchanged until its content or mode differs', () => {
    const start = git(['rev-parse', 'HEAD']);
    git(['rm', '-q', '--cached', 'test/a.test.js', 'test/b.test.js', 'test/c.test.js']);
    write('test/b.test.js', "test('b edited while untracked', () => {});\n");
    chmodSync(join(repo, 'test/c.test.js'), 0o755);

    expect(readCumulativeChange(defaultCommandRunner, { cwd: repo, base: start })).toEqual({
      kind: 'readable',
      base: start,
      entries: [
        { path: 'test/b.test.js', change: 'modified' },
        { path: 'test/c.test.js', change: 'modified' },
      ],
    });
  }, TIMEOUT);

  test('an untracked base executable reads its mode from the owner-execute bit alone, as Git does', () => {
    chmodSync(join(repo, 'test/a.test.js'), 0o755);
    chmodSync(join(repo, 'test/b.test.js'), 0o755);
    const start = commitAll('executables');
    git(['rm', '-q', '--cached', 'test/a.test.js', 'test/b.test.js']);
    // Group/world execute without owner execute: Git would index this as 100644.
    chmodSync(join(repo, 'test/a.test.js'), 0o654);
    // Owner execute alone: still 100755, so unchanged.
    chmodSync(join(repo, 'test/b.test.js'), 0o744);

    expect(readCumulativeChange(defaultCommandRunner, { cwd: repo, base: start })).toEqual({
      kind: 'readable',
      base: start,
      entries: [{ path: 'test/a.test.js', change: 'modified' }],
    });
  }, TIMEOUT);

  test('a mode-only change is read even when the repository sets core.fileMode=false', () => {
    const start = git(['rev-parse', 'HEAD']);
    git(['config', 'core.fileMode', 'false']);
    chmodSync(join(repo, 'test/a.test.js'), 0o755);

    expect(readCumulativeChange(defaultCommandRunner, { cwd: repo, base: start })).toEqual({
      kind: 'readable',
      base: start,
      entries: [{ path: 'test/a.test.js', change: 'modified' }],
    });
  }, TIMEOUT);

  test('a path the index hides from git diff is compared from its worktree entry', () => {
    const start = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'ai/issue-4']);
    write('test/new.test.js', "test('new', () => {});\n");
    write('test/sparse.test.js', "test('sparse', () => {});\n");
    commitAll('branch work');
    git(['update-index', '--assume-unchanged', 'test/a.test.js', 'test/c.test.js', 'test/new.test.js', 'src/x.js']);
    git(['update-index', '--skip-worktree', 'test/b.test.js', 'test/sparse.test.js', '.gitignore']);
    write('test/a.test.js', "test('a edited while assumed unchanged', () => {});\n");
    write('test/b.test.js', "test('b edited while skip-worktree', () => {});\n");
    write('test/c.test.js', "test('c edited', () => {});\n");
    write('test/c.test.js', "test('c', () => {});\n"); // restored to its base content
    unlinkSync(join(repo, 'src/x.js'));
    // Not materialized by sparse checkout: each index entry stands in for its file.
    unlinkSync(join(repo, 'test/sparse.test.js'));
    unlinkSync(join(repo, '.gitignore'));

    // The index hides both edits from git diff itself.
    expect(git(['diff', '--name-only', start, '--', 'test/a.test.js', 'test/b.test.js'])).toBe('');
    expect(readCumulativeChange(defaultCommandRunner, { cwd: repo, base: start })).toEqual({
      kind: 'readable',
      base: start,
      entries: [
        { path: 'src/x.js', change: 'deleted' },
        { path: 'test/a.test.js', change: 'modified' },
        { path: 'test/b.test.js', change: 'modified' },
        { path: 'test/new.test.js', change: 'added' },
        { path: 'test/sparse.test.js', change: 'added' },
      ],
    });
  }, TIMEOUT);

  test('many index-hidden paths are read from the base in a batched lookup, not one command per path', () => {
    const paths = Array.from({ length: 300 }, (_, i) => `test/many/f${String(i).padStart(3, '0')}.test.js`);
    for (const path of paths) write(path, `test('${path}', () => {});\n`);
    const start = commitAll('many');
    git(['update-index', '--skip-worktree', ...paths]);
    // Sparse checkout left most unmaterialized; one is edited in the worktree.
    for (const path of paths.slice(1)) unlinkSync(join(repo, path));
    write(paths[0], "test('edited while skip-worktree', () => {});\n");

    const lsTreeCalls = [];
    const countingRunner = {
      run: (cmd, args, opts) => {
        if (args.includes('ls-tree')) lsTreeCalls.push(args);
        return defaultCommandRunner.run(cmd, args, opts);
      },
    };
    expect(readCumulativeChange(countingRunner, { cwd: repo, base: start })).toEqual({
      kind: 'readable',
      base: start,
      entries: [{ path: paths[0], change: 'modified' }],
    });
    expect(lsTreeCalls).toHaveLength(1);
  }, TIMEOUT);

  test('an untracked symlink in place of its base entry is unchanged until its target differs', () => {
    symlinkSync('a.test.js', join(repo, 'test/same-link.test.js'));
    symlinkSync('b.test.js', join(repo, 'test/moved-link.test.js'));
    const start = commitAll('links');
    git(['rm', '-q', '--cached', 'test/same-link.test.js', 'test/moved-link.test.js']);
    unlinkSync(join(repo, 'test/moved-link.test.js'));
    symlinkSync('c.test.js', join(repo, 'test/moved-link.test.js'));

    expect(readCumulativeChange(defaultCommandRunner, { cwd: repo, base: start })).toEqual({
      kind: 'readable',
      base: start,
      entries: [{ path: 'test/moved-link.test.js', change: 'modified' }],
    });
  }, TIMEOUT);

  test('an unmerged index entry is unreadable even though git diff lists it as modified', () => {
    const start = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'ai/issue-3']);
    write('test/a.test.js', "test('a on the branch', () => {});\n");
    commitAll('branch edit');
    git(['checkout', '-q', 'main']);
    write('test/a.test.js', "test('a on main', () => {});\n");
    commitAll('main edit');
    expect(() => git(['merge', '-q', 'ai/issue-3'])).toThrow();

    const change = readCumulativeChange(defaultCommandRunner, { cwd: repo, base: start });
    expect(change).toMatchObject({ kind: 'unreadable' });
    expect(change.reason).toContain('test/a.test.js is unmerged');
  }, TIMEOUT);

  test('an absent base or a subdirectory is unreadable, and the selection is unavailable rather than empty', () => {
    const absent = 'f'.repeat(40);
    const change = readCumulativeChange(defaultCommandRunner, { cwd: repo, base: absent });
    expect(change).toMatchObject({ kind: 'unreadable' });
    expect(change.reason).toContain('not a commit');

    const selection = selectAt({ status: 'resolved', base: { sha: absent, source: 'dependency-base' }, firstResolution: true });
    expect(selection).toMatchObject({ status: 'unavailable', reason: 'cumulative-change' });

    const head = git(['rev-parse', 'HEAD']);
    expect(readCumulativeChange(defaultCommandRunner, { cwd: join(repo, 'test'), base: head })).toMatchObject({
      kind: 'unreadable',
    });
    expect(readIssueBranchStart(defaultCommandRunner, { cwd: repo, baseBranch: 'no-such-branch' })).toMatchObject({
      kind: 'unreadable',
    });
  }, TIMEOUT);

  test('a base branch value with revision syntax is not a branch name, even where Git would resolve it', () => {
    write('src/x.js', 'export const x = 2;\n');
    const second = commitAll('second');
    git(['update-ref', 'refs/remotes/origin/main', second]);
    // Git itself resolves each of these to some commit of origin/main.
    expect(git(['rev-parse', '--verify', '-q', 'refs/remotes/origin/main~1'])).not.toBe('');

    expect(readIssueBranchStart(defaultCommandRunner, { cwd: repo, baseBranch: 'main' })).toEqual({
      kind: 'readable',
      sha: second,
    });
    for (const baseBranch of ['main~1', 'main^', 'main@{1}', 'main^{commit}']) {
      expect(readIssueBranchStart(defaultCommandRunner, { cwd: repo, baseBranch })).toEqual({
        kind: 'unreadable',
        reason: 'the session base branch is not a branch name',
      });
    }
  }, TIMEOUT);
});
