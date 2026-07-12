import { classifyDiffFromUnified, isGuardrailFile } from '../dist/core/review-diff-context.js';

// ---------------------------------------------------------------------------
// isGuardrailFile
// ---------------------------------------------------------------------------

describe('isGuardrailFile — CI/CD workflows', () => {
  test('.github/workflows/ci.yml is a guardrail file', () => {
    expect(isGuardrailFile('.github/workflows/ci.yml')).toBe(true);
  });

  test('.github/workflows/release.yml is a guardrail file', () => {
    expect(isGuardrailFile('.github/workflows/release.yml')).toBe(true);
  });

  test('other .github/ files are guardrail files', () => {
    expect(isGuardrailFile('.github/CODEOWNERS')).toBe(true);
    expect(isGuardrailFile('.github/dependabot.yml')).toBe(true);
  });
});

describe('isGuardrailFile — agent instruction files', () => {
  test('CLAUDE.md is a guardrail file', () => {
    expect(isGuardrailFile('CLAUDE.md')).toBe(true);
  });

  test('AGENTS.md is a guardrail file', () => {
    expect(isGuardrailFile('AGENTS.md')).toBe(true);
  });

  test('.clinerules is a guardrail file', () => {
    expect(isGuardrailFile('.clinerules')).toBe(true);
  });
});

describe('isGuardrailFile — test files', () => {
  test('*.test.ts is a guardrail file', () => {
    expect(isGuardrailFile('src/auth.test.ts')).toBe(true);
  });

  test('*.spec.js is a guardrail file', () => {
    expect(isGuardrailFile('src/login.spec.js')).toBe(true);
  });

  test('file under test/ directory is a guardrail file', () => {
    expect(isGuardrailFile('test/review.test.js')).toBe(true);
  });

  test('file under __tests__/ directory is a guardrail file', () => {
    expect(isGuardrailFile('src/__tests__/auth.js')).toBe(true);
  });
});

describe('isGuardrailFile — package manifests and lockfiles', () => {
  test('package.json is a guardrail file', () => {
    expect(isGuardrailFile('package.json')).toBe(true);
  });

  test('package-lock.json is a guardrail file', () => {
    expect(isGuardrailFile('package-lock.json')).toBe(true);
  });

  test('pnpm-lock.yaml is a guardrail file', () => {
    expect(isGuardrailFile('pnpm-lock.yaml')).toBe(true);
  });

  test('yarn.lock is a guardrail file', () => {
    expect(isGuardrailFile('yarn.lock')).toBe(true);
  });

  test('go.mod is a guardrail file', () => {
    expect(isGuardrailFile('go.mod')).toBe(true);
  });

  test('requirements.txt is a guardrail file', () => {
    expect(isGuardrailFile('requirements.txt')).toBe(true);
  });
});

describe('isGuardrailFile — non-guardrail files', () => {
  test('regular TypeScript source file is not a guardrail file', () => {
    expect(isGuardrailFile('src/auth.ts')).toBe(false);
  });

  test('README.md is not a guardrail file', () => {
    expect(isGuardrailFile('README.md')).toBe(false);
  });

  test('src/index.ts is not a guardrail file', () => {
    expect(isGuardrailFile('src/index.ts')).toBe(false);
  });

  test('docs/api.md is not a guardrail file', () => {
    expect(isGuardrailFile('docs/api.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyDiffFromUnified
// ---------------------------------------------------------------------------

describe('classifyDiffFromUnified — empty input', () => {
  test('empty string returns all-empty classification', () => {
    const dc = classifyDiffFromUnified('');
    expect(dc.added).toHaveLength(0);
    expect(dc.modified).toHaveLength(0);
    expect(dc.deleted).toHaveLength(0);
    expect(dc.renamed).toHaveLength(0);
    expect(dc.guardrail.added).toHaveLength(0);
    expect(dc.guardrail.modified).toHaveLength(0);
    expect(dc.guardrail.deleted).toHaveLength(0);
    expect(dc.guardrail.renamed).toHaveLength(0);
  });

  test('whitespace-only string returns all-empty classification', () => {
    const dc = classifyDiffFromUnified('   \n   ');
    expect(dc.added).toHaveLength(0);
    expect(dc.modified).toHaveLength(0);
    expect(dc.deleted).toHaveLength(0);
  });
});

describe('classifyDiffFromUnified — added files', () => {
  const addedDiff = [
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    'index 0000000..abc1234',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,3 @@',
    '+const x = 1;',
    '+const y = 2;',
  ].join('\n');

  test('new file is in the added list', () => {
    const dc = classifyDiffFromUnified(addedDiff);
    expect(dc.added).toContain('src/new.ts');
  });

  test('new file is not in modified or deleted', () => {
    const dc = classifyDiffFromUnified(addedDiff);
    expect(dc.modified).toHaveLength(0);
    expect(dc.deleted).toHaveLength(0);
  });
});

describe('classifyDiffFromUnified — modified files', () => {
  const modifiedDiff = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index abc1234..def5678 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1,3 +1,3 @@',
    ' unchanged',
    '-old line',
    '+new line',
  ].join('\n');

  test('modified file is in the modified list', () => {
    const dc = classifyDiffFromUnified(modifiedDiff);
    expect(dc.modified).toContain('src/auth.ts');
  });

  test('modified file is not in added or deleted', () => {
    const dc = classifyDiffFromUnified(modifiedDiff);
    expect(dc.added).toHaveLength(0);
    expect(dc.deleted).toHaveLength(0);
  });
});

describe('classifyDiffFromUnified — deleted files (source only)', () => {
  const deletedSourceDiff = [
    'diff --git a/src/old.ts b/src/old.ts',
    'deleted file mode 100644',
    'index abc1234..0000000',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-const x = 1;',
  ].join('\n');

  test('deleted source file is in the deleted list', () => {
    const dc = classifyDiffFromUnified(deletedSourceDiff);
    expect(dc.deleted).toContain('src/old.ts');
  });

  test('deleted source file is not in guardrail.deleted', () => {
    const dc = classifyDiffFromUnified(deletedSourceDiff);
    expect(dc.guardrail.deleted).toHaveLength(0);
  });

  test('deleted source file has no guardrail classification', () => {
    const dc = classifyDiffFromUnified(deletedSourceDiff);
    expect(dc.guardrail.added).toHaveLength(0);
    expect(dc.guardrail.modified).toHaveLength(0);
    expect(dc.guardrail.deleted).toHaveLength(0);
  });
});

describe('classifyDiffFromUnified — deleted guardrail file (CI workflow)', () => {
  const deletedWorkflowDiff = [
    'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
    'deleted file mode 100644',
    'index abc1234..0000000',
    '--- a/.github/workflows/ci.yml',
    '+++ /dev/null',
    '@@ -1,10 +0,0 @@',
    '-name: CI',
    '-on: [push, pull_request]',
    '-jobs:',
    '-  test:',
    '-    runs-on: ubuntu-latest',
  ].join('\n');

  test('deleted CI workflow is in the deleted list', () => {
    const dc = classifyDiffFromUnified(deletedWorkflowDiff);
    expect(dc.deleted).toContain('.github/workflows/ci.yml');
  });

  test('deleted CI workflow is also in guardrail.deleted', () => {
    const dc = classifyDiffFromUnified(deletedWorkflowDiff);
    expect(dc.guardrail.deleted).toContain('.github/workflows/ci.yml');
  });

  test('no false positives in other guardrail buckets', () => {
    const dc = classifyDiffFromUnified(deletedWorkflowDiff);
    expect(dc.guardrail.added).toHaveLength(0);
    expect(dc.guardrail.modified).toHaveLength(0);
    expect(dc.guardrail.renamed).toHaveLength(0);
  });
});

describe('classifyDiffFromUnified — renamed files', () => {
  const renamedDiff = [
    'diff --git a/src/old.ts b/src/renamed.ts',
    'similarity index 90%',
    'rename from src/old.ts',
    'rename to src/renamed.ts',
    'index abc..def 100644',
    '--- a/src/old.ts',
    '+++ b/src/renamed.ts',
    '@@ -1 +1 @@',
    ' same content',
  ].join('\n');

  test('renamed file is in the renamed list with correct from/to', () => {
    const dc = classifyDiffFromUnified(renamedDiff);
    expect(dc.renamed).toHaveLength(1);
    expect(dc.renamed[0]).toMatchObject({ from: 'src/old.ts', to: 'src/renamed.ts' });
  });

  test('renamed file is not in added, modified, or deleted', () => {
    const dc = classifyDiffFromUnified(renamedDiff);
    expect(dc.added).toHaveLength(0);
    expect(dc.modified).toHaveLength(0);
    expect(dc.deleted).toHaveLength(0);
  });
});

describe('classifyDiffFromUnified — mixed diff (source-only, no guardrail)', () => {
  const sourceOnlyDiff = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index abc..def 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
    'diff --git a/src/helper.ts b/src/helper.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/helper.ts',
    '@@ -0,0 +1 @@',
    '+export const helper = () => {};',
  ].join('\n');

  test('source-only diff has no guardrail files in any bucket', () => {
    const dc = classifyDiffFromUnified(sourceOnlyDiff);
    expect(dc.guardrail.added).toHaveLength(0);
    expect(dc.guardrail.modified).toHaveLength(0);
    expect(dc.guardrail.deleted).toHaveLength(0);
    expect(dc.guardrail.renamed).toHaveLength(0);
  });

  test('source-only diff classifies all files correctly', () => {
    const dc = classifyDiffFromUnified(sourceOnlyDiff);
    expect(dc.modified).toContain('src/auth.ts');
    expect(dc.added).toContain('src/helper.ts');
  });
});

describe('classifyDiffFromUnified — mixed diff with guardrail deletion', () => {
  const mixedDiff = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index abc..def 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1 @@',
    '+content',
    '',
    'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
    'deleted file mode 100644',
    '--- a/.github/workflows/ci.yml',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-name: CI',
  ].join('\n');

  test('all files are classified into the correct buckets', () => {
    const dc = classifyDiffFromUnified(mixedDiff);
    expect(dc.modified).toContain('src/auth.ts');
    expect(dc.added).toContain('src/new.ts');
    expect(dc.deleted).toContain('.github/workflows/ci.yml');
  });

  test('CI workflow deletion is flagged in guardrail.deleted', () => {
    const dc = classifyDiffFromUnified(mixedDiff);
    expect(dc.guardrail.deleted).toContain('.github/workflows/ci.yml');
  });

  test('source files are not in any guardrail bucket', () => {
    const dc = classifyDiffFromUnified(mixedDiff);
    expect(dc.guardrail.added).toHaveLength(0);
    expect(dc.guardrail.modified).toHaveLength(0);
    expect(dc.guardrail.renamed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// classifyDiffFromUnified — binary / mode-only diffs (no ---/+++ lines)
// ---------------------------------------------------------------------------

describe('classifyDiffFromUnified — binary file deletion falls back to diff header', () => {
  // Binary diffs do not emit ---/+++ hunk headers. The classifier must fall
  // back to parsing the `diff --git a/... b/...` header line.
  const binaryDeletedDiff = [
    'diff --git a/test/fixtures/image.png b/test/fixtures/image.png',
    'deleted file mode 100644',
    'index abc1234..0000000',
    'Binary files a/test/fixtures/image.png and /dev/null differ',
  ].join('\n');

  test('binary deleted file is in the deleted list', () => {
    const dc = classifyDiffFromUnified(binaryDeletedDiff);
    expect(dc.deleted).toContain('test/fixtures/image.png');
  });

  test('binary deleted guardrail file appears in guardrail.deleted', () => {
    const dc = classifyDiffFromUnified(binaryDeletedDiff);
    expect(dc.guardrail.deleted).toContain('test/fixtures/image.png');
  });

  test('binary deleted file is not in added or modified', () => {
    const dc = classifyDiffFromUnified(binaryDeletedDiff);
    expect(dc.added).toHaveLength(0);
    expect(dc.modified).toHaveLength(0);
  });
});

describe('classifyDiffFromUnified — mode-only change falls back to diff header', () => {
  // Mode-only diffs (e.g. chmod) have no content hunks and no ---/+++ lines.
  const modeOnlyDiff = [
    'diff --git a/scripts/deploy.sh b/scripts/deploy.sh',
    'old mode 100644',
    'new mode 100755',
  ].join('\n');

  test('mode-only changed file is in the modified list', () => {
    const dc = classifyDiffFromUnified(modeOnlyDiff);
    expect(dc.modified).toContain('scripts/deploy.sh');
  });

  test('mode-only changed file is not in added or deleted', () => {
    const dc = classifyDiffFromUnified(modeOnlyDiff);
    expect(dc.added).toHaveLength(0);
    expect(dc.deleted).toHaveLength(0);
  });
});

describe('classifyDiffFromUnified — binary new file falls back to diff header', () => {
  const binaryAddedDiff = [
    'diff --git a/assets/logo.png b/assets/logo.png',
    'new file mode 100644',
    'index 0000000..abc1234',
    'Binary files /dev/null and b/assets/logo.png differ',
  ].join('\n');

  test('binary new file is in the added list', () => {
    const dc = classifyDiffFromUnified(binaryAddedDiff);
    expect(dc.added).toContain('assets/logo.png');
  });

  test('binary new file is not in modified or deleted', () => {
    const dc = classifyDiffFromUnified(binaryAddedDiff);
    expect(dc.modified).toHaveLength(0);
    expect(dc.deleted).toHaveLength(0);
  });
});
