import {
  parseRepoChangeAction,
  parsePorcelainStatus,
  isIgnoredPath,
  matchesExpected,
  classifyChangedFiles,
  planRepoChange,
  summarizeClassification,
} from '../dist/index.js';

// Issue #419 — pure repository-change handling for the guided Tool Request flow.

describe('parseRepoChangeAction', () => {
  test('accepts each known action, case/space-insensitively', () => {
    expect(parseRepoChangeAction('commit')).toBe('commit');
    expect(parseRepoChangeAction('  KEEP ')).toBe('keep');
    expect(parseRepoChangeAction('Discard')).toBe('discard');
    expect(parseRepoChangeAction('reject')).toBe('reject');
    expect(parseRepoChangeAction('abort')).toBe('abort');
  });

  test('returns undefined for an unknown action (caller fails fast)', () => {
    expect(parseRepoChangeAction('push')).toBeUndefined();
    expect(parseRepoChangeAction('')).toBeUndefined();
    expect(parseRepoChangeAction('commit --force')).toBeUndefined();
  });
});

describe('parsePorcelainStatus', () => {
  test('parses modified, added, deleted and untracked lines', () => {
    const out = ' M package.json\nA  src/new.ts\n D old.ts\n?? build/out.js';
    expect(parsePorcelainStatus(out)).toEqual([
      { path: 'package.json', index: ' ', worktree: 'M' },
      { path: 'src/new.ts', index: 'A', worktree: ' ' },
      { path: 'old.ts', index: ' ', worktree: 'D' },
      { path: 'build/out.js', index: '?', worktree: '?' },
    ]);
  });

  test('keeps both sides of a rename (destination as path, source as origPath)', () => {
    const out = 'R  old/name.ts -> new/name.ts';
    expect(parsePorcelainStatus(out)).toEqual([
      { path: 'new/name.ts', origPath: 'old/name.ts', index: 'R', worktree: ' ' },
    ]);
  });

  test('ignores blank and malformed lines', () => {
    expect(parsePorcelainStatus('')).toEqual([]);
    expect(parsePorcelainStatus('\n\nx')).toEqual([]);
  });

  test('decodes a C-quoted path back to its real on-disk name', () => {
    // Git quotes paths with unusual characters; a tab is escaped as \t inside
    // double quotes. The parser must decode it so matching/staging use the real path.
    const out = ' M "a\\tb.txt"\nA  "src/\\303\\251.ts"';
    expect(parsePorcelainStatus(out)).toEqual([
      { path: 'a\tb.txt', index: ' ', worktree: 'M' },
      { path: 'src/é.ts', index: 'A', worktree: ' ' },
    ]);
  });

  test('decodes both sides of a quoted rename, keeping both paths', () => {
    const out = 'R  "old name.ts" -> "new name.ts"';
    expect(parsePorcelainStatus(out)).toEqual([
      { path: 'new name.ts', origPath: 'old name.ts', index: 'R', worktree: ' ' },
    ]);
  });

  test('leaves an unquoted path with a space verbatim', () => {
    const out = ' M a b.txt';
    expect(parsePorcelainStatus(out)).toEqual([
      { path: 'a b.txt', index: ' ', worktree: 'M' },
    ]);
  });
});

describe('isIgnoredPath', () => {
  test('matches the prefix itself and descendants on segment boundaries', () => {
    expect(isIgnoredPath('.n8n-artifacts', ['.n8n-artifacts'])).toBe(true);
    expect(isIgnoredPath('.n8n-artifacts/run/x.json', ['.n8n-artifacts'])).toBe(true);
    expect(isIgnoredPath('./.n8n-artifacts/x', ['.n8n-artifacts'])).toBe(true);
  });

  test('does not match a sibling sharing a name prefix', () => {
    expect(isIgnoredPath('.n8n-artifacts-backup/x', ['.n8n-artifacts'])).toBe(false);
    expect(isIgnoredPath('package.json', ['.n8n-artifacts'])).toBe(false);
  });

  test('tolerates a trailing slash on the configured prefix', () => {
    expect(isIgnoredPath('.n8n-artifacts/x', ['.n8n-artifacts/'])).toBe(true);
  });
});

describe('matchesExpected', () => {
  test('matches by exact path, suffix path, and basename', () => {
    expect(matchesExpected('package.json', ['package.json'])).toBe(true);
    expect(matchesExpected('packages/a/package-lock.json', ['package-lock.json'])).toBe(true);
    expect(matchesExpected('src/foo.ts', ['src/foo.ts'])).toBe(true);
  });

  test('does not match an unrelated file', () => {
    expect(matchesExpected('src/bar.ts', ['package.json'])).toBe(false);
    expect(matchesExpected('README.md', [])).toBe(false);
  });

  test('does not treat an arbitrary untracked directory as a directory expected entry', () => {
    // Git reports an untracked dir as `tmp/`; a directory-style expected entry is
    // `dist/`. Their basenames are both empty, so empty-basename matching would
    // wrongly classify tmp/ as expected (issue #419 review). It must not.
    expect(matchesExpected('tmp/', ['dist/'])).toBe(false);
    expect(matchesExpected('node_modules/', ['dist/'])).toBe(false);
  });

  test('still matches a directory expected entry by exact path despite a trailing slash', () => {
    expect(matchesExpected('dist/', ['dist/'])).toBe(true);
    expect(matchesExpected('dist', ['dist/'])).toBe(true);
    expect(matchesExpected('packages/a/dist/', ['dist'])).toBe(true);
  });
});

describe('classifyChangedFiles', () => {
  const files = parsePorcelainStatus(
    ' M package.json\n M package-lock.json\n?? src/unexpected.ts\n?? .n8n-artifacts/run.json',
  );

  test('splits expected, unexpected and artifact files', () => {
    const c = classifyChangedFiles(files, ['package.json', 'package-lock.json'], ['.n8n-artifacts']);
    expect(c.expected.map((f) => f.path)).toEqual(['package.json', 'package-lock.json']);
    expect(c.unexpected.map((f) => f.path)).toEqual(['src/unexpected.ts']);
    expect(c.ignored.map((f) => f.path)).toEqual(['.n8n-artifacts/run.json']);
  });

  test('treats everything non-artifact as unexpected when no expected files given', () => {
    const c = classifyChangedFiles(files, [], ['.n8n-artifacts']);
    expect(c.expected).toEqual([]);
    expect(c.unexpected.map((f) => f.path)).toEqual([
      'package.json',
      'package-lock.json',
      'src/unexpected.ts',
    ]);
    expect(c.ignored.map((f) => f.path)).toEqual(['.n8n-artifacts/run.json']);
  });
});

function classify(expected = [], unexpected = [], ignored = []) {
  return {
    expected: expected.map((p) => ({ path: p, index: ' ', worktree: 'M' })),
    unexpected: unexpected.map((p) => ({ path: p, index: ' ', worktree: 'M' })),
    ignored: ignored.map((p) => ({ path: p, index: '?', worktree: '?' })),
  };
}

const baseInput = {
  currentBranch: 'ai/issue-1',
  expectedBranch: 'ai/issue-1',
  baseBranch: 'main',
  confirmDiscard: false,
  allowUnexpected: false,
};

describe('planRepoChange — commit', () => {
  test('allows commit + push for expected-only changes on the issue branch', () => {
    const plan = planRepoChange({ ...baseInput, action: 'commit', classification: classify(['package.json']) });
    expect(plan).toEqual({ ok: true, action: 'commit', commit: true, push: true, discard: false });
  });

  test('refuses commit on the base branch', () => {
    const plan = planRepoChange({
      ...baseInput,
      action: 'commit',
      currentBranch: 'main',
      classification: classify(['package.json']),
    });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('base-branch');
  });

  test('refuses commit when HEAD is on the wrong branch', () => {
    const plan = planRepoChange({
      ...baseInput,
      action: 'commit',
      currentBranch: 'ai/issue-2',
      classification: classify(['package.json']),
    });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('wrong-branch');
  });

  test('refuses commit with unexpected files unless allowed', () => {
    const refused = planRepoChange({
      ...baseInput,
      action: 'commit',
      classification: classify(['package.json'], ['src/x.ts']),
    });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('unexpected-files');

    const allowed = planRepoChange({
      ...baseInput,
      action: 'commit',
      allowUnexpected: true,
      classification: classify(['package.json'], ['src/x.ts']),
    });
    expect(allowed).toEqual({ ok: true, action: 'commit', commit: true, push: true, discard: false });
  });

  test('refuses commit when only artifact files changed', () => {
    const plan = planRepoChange({
      ...baseInput,
      action: 'commit',
      classification: classify([], [], ['.n8n-artifacts/run.json']),
    });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('nothing-to-do');
  });
});

describe('planRepoChange — discard', () => {
  test('refuses without confirmation', () => {
    const plan = planRepoChange({ ...baseInput, action: 'discard', classification: classify(['package.json']) });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('needs-confirmation');
  });

  test('allows a confirmed discard', () => {
    const plan = planRepoChange({
      ...baseInput,
      action: 'discard',
      confirmDiscard: true,
      classification: classify(['package.json']),
    });
    expect(plan).toEqual({ ok: true, action: 'discard', commit: false, push: false, discard: true });
  });

  test('refuses a confirmed discard with nothing to discard', () => {
    const plan = planRepoChange({
      ...baseInput,
      action: 'discard',
      confirmDiscard: true,
      classification: classify([], [], ['.n8n-artifacts/x']),
    });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('nothing-to-do');
  });
});

describe('planRepoChange — keep/reject/abort', () => {
  for (const action of ['keep', 'reject', 'abort']) {
    test(`${action} is always safe and mutates nothing here`, () => {
      const plan = planRepoChange({ ...baseInput, action, classification: classify(['package.json'], ['x.ts']) });
      expect(plan).toEqual({ ok: true, action, commit: false, push: false, discard: false });
    });
  }
});

describe('summarizeClassification', () => {
  test('reports counts only (public-safe)', () => {
    const s = summarizeClassification(classify(['package.json'], ['x.ts'], ['.n8n-artifacts/y']));
    expect(s).toBe('1 expected, 1 unexpected, 1 artifact file(s)');
  });
});
