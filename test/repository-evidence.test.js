import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BINARY_SNIFF_BYTES,
  LIST_MAX_PATHS,
  MAX_QUERIES_PER_RUN,
  READ_MAX_BYTES,
  compileEvidencePattern,
  findInvalidOperatorGlob,
  matchEvidenceGlob,
  parseEvidenceGlob,
  patternMatchesLine,
  resolveEvidenceTurn,
  sanitizeRequestRecord,
} from '../dist/core/repository-evidence.js';
import { nodeFileAccess } from '../dist/handlers/research-evidence-source.js';

// ---------------------------------------------------------------------------
// Fixture: a real temporary directory driven through a fake tracked snapshot
// (no git needed — the snapshot IS the membership boundary, §4.2).
// ---------------------------------------------------------------------------

let tmpDir;
let root;

const TRACKED = [
  'README.md',
  'src/a.ts',
  'src/nested/b.ts',
  'srcfoo.ts',
  'src-old/legacy.ts',
  '.env',
  'secrets/deploy.pem',
  'link.ts',
  'bin/blob.bin',
  'generated/lock.json',
  'token.ts',
  'deleted.ts',
];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'repo-evidence-test-'));
  root = join(tmpDir, 'repo');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  mkdirSync(join(root, 'src-old'), { recursive: true });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'generated'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# readme\nsecond line\nthird line\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport function needleFn() {}\n');
  writeFileSync(join(root, 'src', 'nested', 'b.ts'), 'export const b = 2;\n// NEEDLEFN reference\n');
  writeFileSync(join(root, 'srcfoo.ts'), 'export const foo = 3;\n');
  writeFileSync(join(root, 'src-old', 'legacy.ts'), 'export const legacy = 4;\n');
  writeFileSync(join(root, '.env'), 'SECRET=do-not-serve\n');
  writeFileSync(join(root, 'secrets', 'deploy.pem'), 'PEM CONTENT\n');
  symlinkSync(join(root, 'src', 'a.ts'), join(root, 'link.ts'));
  writeFileSync(join(root, 'bin', 'blob.bin'), Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from('binary')]));
  writeFileSync(join(root, 'generated', 'lock.json'), '{"lock":true}\n');
  writeFileSync(join(root, 'token.ts'), 'const t = "ghp_abcdefghij0123456789abcdefghij";\n');
  writeFileSync(join(root, 'untracked.ts'), 'never listed\n');
  // deleted.ts is tracked but absent from the worktree.
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDeps(overrides = {}) {
  const fileAccess = nodeFileAccess();
  return {
    snapshot: { list: () => TRACKED, snapshotAt: '2026-01-01T00:00:00.000Z', scope: 'tracked-worktree' },
    fileAccess,
    anchor: fileAccess.resolveRoot(root),
    generatedGlobs: ['generated/**'],
    budget: { queriesRun: 0, bytesServedRun: 0, runStartedAt: Date.now(), turnStartedAt: Date.now() },
    now: () => Date.now(),
    ...overrides,
  };
}

function resolveOne(query, overrides = {}) {
  return resolveEvidenceTurn([{ kind: 'query', query }], makeDeps(overrides))[0];
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  test('root scope returns tracked paths only, sorted, excluding sensitive/generated/symlinks as counts', () => {
    const r = resolveOne({ id: 'q1', op: 'list' });
    expect(r.status).toBe('ok');
    expect(r.paths).toEqual([...r.paths].sort());
    expect(r.paths).toContain('src/a.ts');
    expect(r.paths).toContain('README.md');
    expect(r.paths).not.toContain('untracked.ts');
    expect(r.paths).not.toContain('.env');
    expect(r.paths).not.toContain('secrets/deploy.pem');
    expect(r.paths).not.toContain('link.ts');
    expect(r.paths).not.toContain('generated/lock.json');
    expect(r.pathsExcludedSensitive).toBeGreaterThanOrEqual(2);
    expect(r.pathsExcludedGenerated).toBe(1);
    expect(r.pathsExcludedSymlink).toBe(1);
  });

  test('explicit "." and "./" are the same root scope, never a denial (§4.1 rule 4)', () => {
    const implicit = resolveOne({ id: 'q1', op: 'list' });
    for (const path of ['.', './']) {
      const r = resolveOne({ id: 'q1', op: 'list', path });
      expect(r.status).toBe('ok');
      expect(r.paths).toEqual(implicit.paths);
    }
  });

  test('directory prefix scopes to strict indexed descendants on a segment boundary (§4.0)', () => {
    const r = resolveOne({ id: 'q1', op: 'list', path: 'src' });
    expect(r.status).toBe('ok');
    expect(r.paths).toEqual(['src/a.ts', 'src/nested/b.ts']);
    const trailing = resolveOne({ id: 'q1', op: 'list', path: 'src/' });
    expect(trailing.paths).toEqual(r.paths);
  });

  test('prefix matching is exact-bytes: siblings, case variants, absent dirs are not-tracked (§4.0 rule 2)', () => {
    for (const path of ['srcfoo', 'SRC', 'nope/deeper']) {
      const r = resolveOne({ id: 'q1', op: 'list', path });
      expect(r.status).toBe('denied');
      expect(r.reason).toBe('not-tracked');
    }
  });

  test('a prefix whose descendants are all excluded is an empty admitted result, not a denial (§4.0 rule 4)', () => {
    const r = resolveOne({ id: 'q1', op: 'list', path: 'secrets' });
    expect(r.status).toBe('ok');
    expect(r.paths).toEqual([]);
    expect(r.pathsExcludedSensitive).toBe(1);
  });

  test('glob filters in-process; includeGenerated re-admits generated paths', () => {
    const r = resolveOne({ id: 'q1', op: 'list', glob: 'src/**/*.ts' });
    expect(r.paths).toEqual(['src/a.ts', 'src/nested/b.ts']);
    const gen = resolveOne({ id: 'q1', op: 'list', path: 'generated', includeGenerated: true });
    expect(gen.paths).toEqual(['generated/lock.json']);
  });

  test('rejected glob denies the query with a rule name and is never re-run unfiltered (§3.4)', () => {
    const r = resolveOne({ id: 'q1', op: 'list', glob: '/abs/*' });
    expect(r.status).toBe('denied');
    expect(r.reason).toBe('glob-rejected');
    expect(r.detail).toBe('glob-absolute');
    expect(JSON.stringify(r)).not.toContain('/abs/*');
  });
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe('read', () => {
  test('whole small file: exact content, exact totalLines', () => {
    const r = resolveOne({ id: 'q1', op: 'read', path: 'README.md' });
    expect(r.status).toBe('ok');
    expect(r.content).toBe('# readme\nsecond line\nthird line\n');
    expect(r.totalLines).toBe(3);
    expect(r.totalLinesExact).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.scope).toBe('tracked-worktree');
    expect(r.contentSource).toBe('worktree');
  });

  test('mid-file line window is 1-based inclusive', () => {
    const r = resolveOne({ id: 'q1', op: 'read', path: 'README.md', startLine: 2, endLine: 2 });
    expect(r.content).toBe('second line\n');
    expect(r.firstLine).toBe(2);
    expect(r.lastLine).toBe(2);
  });

  test('window past EOF is clamped, not an error', () => {
    const r = resolveOne({ id: 'q1', op: 'read', path: 'README.md', startLine: 100, endLine: 200 });
    expect(r.status).toBe('ok');
    expect(r.content).toBe('');
    expect(r.totalLinesExact).toBe(true);
  });

  test('read over READ_MAX_BYTES serves a bounded prefix with truncated:true and null totalLines', () => {
    const big = 'x'.repeat(200) + '\n';
    writeFileSync(join(root, 'src', 'a.ts'), big.repeat(1000)); // ~201 KB
    const r = resolveOne({ id: 'q1', op: 'read', path: 'src/a.ts', startLine: 1, endLine: 1000 });
    expect(r.status).toBe('ok');
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(r.totalLines).toBe(null);
    expect(r.totalLinesExact).toBe(false);
    expect(r.totalBytes).toBe(Buffer.byteLength(big) * 1000);
  });

  test('absolute and traversal paths fail closed', () => {
    expect(resolveOne({ id: 'q1', op: 'read', path: '/etc/passwd' }).reason).toBe('absolute-path');
    expect(resolveOne({ id: 'q1', op: 'read', path: '../../etc/passwd' }).reason).toBe('outside-root');
    expect(resolveOne({ id: 'q1', op: 'read', path: 'src/../../escape' }).reason).toBe('outside-root');
  });

  test('missing path on a repo read is invalid-query (§4.0)', () => {
    const r = resolveOne({ id: 'q1', op: 'read' });
    expect(r.reason).toBe('invalid-query');
  });

  test('tracked symlink is symlink-rejected and its target content never appears', () => {
    const r = resolveOne({ id: 'q1', op: 'read', path: 'link.ts' });
    expect(r.status).toBe('denied');
    expect(r.reason).toBe('symlink-rejected');
    expect(JSON.stringify(r)).not.toContain('needleFn');
  });

  test('untracked file is not-tracked; tracked-but-deleted is not-found', () => {
    expect(resolveOne({ id: 'q1', op: 'read', path: 'untracked.ts' }).reason).toBe('not-tracked');
    expect(resolveOne({ id: 'q1', op: 'read', path: 'deleted.ts' }).reason).toBe('not-found');
  });

  test('deny floor beats tracked-ness; operator denyGlobs are additive (§4.7)', () => {
    expect(resolveOne({ id: 'q1', op: 'read', path: '.env' }).reason).toBe('denied-sensitive');
    expect(resolveOne({ id: 'q1', op: 'read', path: 'secrets/deploy.pem' }).reason).toBe('denied-sensitive');
    const r = resolveOne({ id: 'q1', op: 'read', path: 'src-old/legacy.ts' }, { denyGlobs: ['src-old/**'] });
    expect(r.reason).toBe('denied-sensitive');
  });

  test('an invalid operator deny glob fails the query closed, never silently dropped (§4.7)', () => {
    // 'src-old/**/' is rejected by the §3.4 grammar; dropping it would make
    // src-old/legacy.ts readable against the operator's configured intent.
    const r = resolveOne({ id: 'q1', op: 'read', path: 'src-old/legacy.ts' }, { denyGlobs: ['src-old/**/'] });
    expect(r.status).toBe('denied');
    expect(r.reason).toBe('resolver-error');
    expect(r.detail).toBe('operator-glob-invalid');
    expect(JSON.stringify(r)).not.toContain('src-old/**/');
  });

  test('an invalid generatedGlobs entry also fails closed in list and search', () => {
    for (const op of ['list', 'search']) {
      const query = op === 'search' ? { id: 'q1', op, pattern: 'readme' } : { id: 'q1', op };
      const r = resolveOne(query, { generatedGlobs: ['/abs/**'] });
      expect(r.status).toBe('denied');
      expect(r.reason).toBe('resolver-error');
      expect(r.detail).toBe('operator-glob-invalid');
    }
  });

  test('binary read returns a bounded prefix digest, never content (§4.5)', () => {
    const bytes = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from('binary')]);
    const r = resolveOne({ id: 'q1', op: 'read', path: 'bin/blob.bin' });
    expect(r.status).toBe('denied');
    expect(r.reason).toBe('binary');
    expect(r.content).toBeUndefined();
    expect(r.totalBytes).toBe(bytes.length);
    expect(r.digestAlgorithm).toBe('sha256-prefix');
    expect(r.digestBytes).toBe(Math.min(BINARY_SNIFF_BYTES, bytes.length));
    expect(r.digestPrefixSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  test('generated path is readable by exact path (§4.6)', () => {
    const r = resolveOne({ id: 'q1', op: 'read', path: 'generated/lock.json' });
    expect(r.status).toBe('ok');
    expect(r.content).toContain('"lock"');
  });

  test('token-shaped literal is redacted with redacted:true (§4.8)', () => {
    const r = resolveOne({ id: 'q1', op: 'read', path: 'token.ts' });
    expect(r.status).toBe('ok');
    expect(r.content).not.toContain('ghp_abcdefghij0123456789abcdefghij');
    expect(r.content).toContain('[redacted]');
    expect(r.redacted).toBe(true);
  });

  test('read "." is not-tracked, never a directory enumeration (§4.1 rule 4)', () => {
    const r = resolveOne({ id: 'q1', op: 'read', path: '.' });
    expect(r.reason).toBe('not-tracked');
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('search', () => {
  test('fixed-string search returns repo-relative path and 1-based line', () => {
    const r = resolveOne({ id: 'q1', op: 'search', pattern: 'needleFn' });
    expect(r.status).toBe('ok');
    expect(r.matches).toEqual([{ path: 'src/a.ts', line: 2, text: 'export function needleFn() {}' }]);
  });

  test('ignoreCase folds pattern against content', () => {
    const r = resolveOne({ id: 'q1', op: 'search', pattern: 'needlefn', ignoreCase: true });
    expect(r.matches.map((m) => m.path).sort()).toEqual(['src/a.ts', 'src/nested/b.ts']);
  });

  test('search skips binary, denied, generated and symlinked files without naming them', () => {
    const r = resolveOne({ id: 'q1', op: 'search', pattern: 'e' });
    const paths = r.matches.map((m) => m.path);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('secrets/deploy.pem');
    expect(paths).not.toContain('bin/blob.bin');
    expect(paths).not.toContain('generated/lock.json');
    expect(paths).not.toContain('link.ts');
    expect(r.filesSkippedBinary).toBe(1);
    expect(r.filesExcludedSensitive).toBeGreaterThanOrEqual(2);
  });

  test('admitted regex subset matches like a reference engine on the fixture', () => {
    const r = resolveOne({ id: 'q1', op: 'search', pattern: 'needle\\w+\\(', kind: 'regex' });
    expect(r.matches.map((m) => m.path)).toEqual(['src/a.ts']);
  });

  test('rejected patterns name the failing rule and are never downgraded to fixed (§3.3.1)', () => {
    const cases = [
      // Capturing groups are rejected outright, so the classic backtracking
      // bombs fail admission before their quantifier is even reached; the
      // non-capturing spelling fails on the quantified-group rule itself.
      ['^(a+)+$', 'capture-group-unsupported'],
      ['(a|a)*', 'capture-group-unsupported'],
      ['(?:ab)*c', 'quantified-group'],
      ['(?=x)y', 'lookaround-unsupported'],
      ['(x)y', 'capture-group-unsupported'],
      ['a{5000}', 'repeat-too-large'],
    ];
    for (const [pattern, rule] of cases) {
      const r = resolveOne({ id: 'q1', op: 'search', pattern, kind: 'regex' });
      expect(r.status).toBe('denied');
      expect(r.reason).toBe('pattern-rejected');
      expect(r.detail).toBe(rule);
      expect(JSON.stringify(r)).not.toContain(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// regex subset unit behaviour
// ---------------------------------------------------------------------------

describe('regex subset', () => {
  test('admitted patterns agree with a reference RegExp', () => {
    const patterns = ['a+b', '^export', 'needle.*\\(', '[a-z]{2,4}', 'foo|bar|baz', '\\bconst\\b', 'x?y'];
    const lines = ['export const a = 1;', 'aaab', 'needleFn()', 'foo', 'xy', 'y', 'zzz'];
    for (const p of patterns) {
      const compiled = compileEvidencePattern(p);
      expect(compiled.ok).toBe(true);
      const ref = new RegExp(p);
      for (const line of lines) {
        expect(patternMatchesLine(compiled.nfa, line)).toBe(ref.test(line));
      }
    }
  });

  test('quantifier and structure bounds are enforced with per-rule names', () => {
    expect(compileEvidencePattern('a*'.repeat(9)).rule).toBe('too-many-quantifiers');
    expect(compileEvidencePattern(Array(17).fill('a').join('|')).rule).toBe('too-many-branches');
    expect(compileEvidencePattern('\\1').rule).toBe('backreference-unsupported');
    expect(compileEvidencePattern('a{3,2}').rule).toBe('repeat-range-invalid');
    expect(compileEvidencePattern('a{600}b{600}').rule).toBe('nfa-too-large');
    expect(compileEvidencePattern('x'.repeat(201)).rule).toBe('pattern-too-long');
  });

  test('pathological input completes fast: the guarantee is structural, not a timeout (§3.3.1 part 2)', () => {
    const compiled = compileEvidencePattern('a*a*a*a*b');
    expect(compiled.ok).toBe(true);
    const line = 'a'.repeat(100_000);
    const started = Date.now();
    expect(patternMatchesLine(compiled.nfa, line)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// glob subset unit behaviour
// ---------------------------------------------------------------------------

describe('glob subset', () => {
  test('admitted subset matches whole repo-relative paths (§3.4)', () => {
    const cases = [
      ['*.md', 'README.md', true],
      ['*.md', 'docs/x.md', false],
      ['src/*.ts', 'src/a.ts', true],
      ['src/*.ts', 'src/nested/b.ts', false],
      ['src/**/*.ts', 'src/a.ts', true],
      ['src/**/*.ts', 'src/nested/b.ts', true],
      ['**/b.ts', 'src/nested/b.ts', true],
      ['src/?.ts', 'src/a.ts', true],
      ['src/*.TS', 'src/a.ts', false], // case-sensitive, exact-bytes (rule 6)
    ];
    for (const [glob, path, expected] of cases) {
      const parsed = parseEvidenceGlob(glob);
      expect(parsed.ok).toBe(true);
      expect(matchEvidenceGlob(parsed.segments, path)).toBe(expected);
    }
  });

  test('rejected forms each name their own failing rule (§3.4 part 1)', () => {
    const cases = [
      ['/abs/*', 'glob-absolute'],
      ['C:/x/*', 'glob-absolute'],
      ['../*', 'glob-traversal'],
      ['src/../a.ts', 'glob-traversal'],
      ['src//a.ts', 'glob-empty-segment'],
      ['src/', 'glob-trailing-slash'],
      ['**.ts', 'glob-starstar-not-whole-segment'],
      ['[a-z]*.ts', 'glob-class-unsupported'],
      ['{a,b}/*', 'glob-class-unsupported'],
      ['!src/*', 'glob-class-unsupported'],
      ['a/' + '*a'.repeat(17), 'glob-too-many-wildcards'],
      ['**/a/**/b/**', 'glob-too-many-starstar'],
    ];
    for (const [glob, rule] of cases) {
      const parsed = parseEvidenceGlob(glob);
      expect(parsed.ok).toBe(false);
      expect(parsed.rule).toBe(rule);
    }
  });

  test('findInvalidOperatorGlob validates the lowercased form and reports index and rule, never the glob text', () => {
    expect(findInvalidOperatorGlob([])).toBe(null);
    expect(findInvalidOperatorGlob(['src/**', '**/*.PEM'])).toBe(null);
    expect(findInvalidOperatorGlob(['src/**', 'private/**/'])).toEqual({ index: 1, rule: 'glob-trailing-slash' });
    expect(findInvalidOperatorGlob(['/abs/**'])).toEqual({ index: 0, rule: 'glob-absolute' });
  });
});

// ---------------------------------------------------------------------------
// Budgets and the sanitized request record
// ---------------------------------------------------------------------------

describe('budgets and record sanitization', () => {
  test('a query past a spent run budget is budget-exhausted; earlier results are kept (§5)', () => {
    const deps = makeDeps();
    deps.budget.queriesRun = MAX_QUERIES_PER_RUN;
    const results = resolveEvidenceTurn([
      { kind: 'query', query: { id: 'q1', op: 'read', path: 'README.md' } },
    ], deps);
    expect(results[0].reason).toBe('budget-exhausted');
  });

  test('maxResults is clamped to LIST_MAX_PATHS', () => {
    const r = resolveOne({ id: 'q1', op: 'list', maxResults: LIST_MAX_PATHS + 500 });
    expect(r.paths.length).toBeLessThanOrEqual(LIST_MAX_PATHS);
  });

  test('denied free-text fields are stored as length+sha256, admitted safe values verbatim (§9.1)', () => {
    const entries = [
      { kind: 'query', query: { id: 'q1', op: 'read', path: '/etc/passwd' } },
      { kind: 'query', query: { id: 'q2', op: 'read', path: 'README.md' } },
    ];
    const deps = makeDeps();
    const results = resolveEvidenceTurn(entries, deps);
    const records = sanitizeRequestRecord(entries, results, [root]);
    expect(records[0].verdict).toBe('absolute-path');
    expect(records[0].path).toEqual({
      length: '/etc/passwd'.length,
      sha256: createHash('sha256').update('/etc/passwd', 'utf8').digest('hex'),
    });
    expect(records[1].path).toBe('README.md');
    expect(JSON.stringify(records)).not.toContain('/etc/passwd');
  });

  test('an ADMITTED absolute-path-shaped pattern is served but recorded unsafeToSerialize (§9.1)', () => {
    const pattern = '/srv/checkout/src';
    const entries = [{ kind: 'query', query: { id: 'q1', op: 'search', pattern } }];
    const deps = makeDeps();
    const results = resolveEvidenceTurn(entries, deps);
    expect(results[0].status).toBe('ok'); // served, never denied for shape
    const records = sanitizeRequestRecord(entries, results, [root]);
    expect(records[0].pattern.unsafeToSerialize).toBe(true);
    expect(JSON.stringify(records)).not.toContain(pattern);
  });
});
