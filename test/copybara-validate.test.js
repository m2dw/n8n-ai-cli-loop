import {
  walkFiles,
  scanFileContent,
  scanPath,
  scanTree,
  main,
  CONTENT_RULES,
  FORBIDDEN_PATH_RULES,
  DEPENDENCY_MANIFEST,
  checkDependencyManifest,
} from '../scripts/copybara-validate.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP = join(tmpdir(), `copybara-validate-test-${process.pid}`);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// walkFiles
// ---------------------------------------------------------------------------

describe('walkFiles', () => {
  test('finds files recursively and skips .git/node_modules', () => {
    const dir = join(TMP, 'walk');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), '');
    writeFileSync(join(dir, 'sub', 'b.txt'), '');
    writeFileSync(join(dir, '.git', 'HEAD'), '');
    writeFileSync(join(dir, 'node_modules', 'pkg.js'), '');

    const found = walkFiles(dir).map(p => p.replace(dir, ''));
    expect(found.some(p => p.endsWith('a.txt'))).toBe(true);
    expect(found.some(p => p.endsWith('b.txt'))).toBe(true);
    expect(found.some(p => p.includes('.git'))).toBe(false);
    expect(found.some(p => p.includes('node_modules'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanFileContent — content rules
// ---------------------------------------------------------------------------

describe('scanFileContent', () => {
  test('flags a personal Unix absolute path', () => {
    const findings = scanFileContent('README.md', 'run node /Users/alice/git/repo/dist/cli/run.js');
    expect(findings.some(f => f.rule === 'personal-path-unix')).toBe(true);
  });

  test('does not flag a genericized path placeholder', () => {
    const findings = scanFileContent('README.md', 'run node /path/to/repo/dist/cli/run.js');
    expect(findings).toHaveLength(0);
  });

  test('flags a personal Windows absolute path', () => {
    const findings = scanFileContent('README.md', 'C:\\Users\\bob\\repo\\file.txt');
    expect(findings.some(f => f.rule === 'personal-path-windows')).toBe(true);
  });

  test('flags an embedded private key block', () => {
    const findings = scanFileContent('key.txt', '-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----');
    expect(findings.some(f => f.rule === 'credential-private-key')).toBe(true);
  });

  test('flags a GitHub personal access token', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const findings = scanFileContent('notes.md', `token: ${token}`);
    expect(findings.some(f => f.rule === 'credential-github-token')).toBe(true);
  });

  test('flags an AWS access key ID', () => {
    const findings = scanFileContent('notes.md', 'AKIAABCDEFGHIJKLMNOP');
    expect(findings.some(f => f.rule === 'credential-aws-key')).toBe(true);
  });

  test('flags a generic quoted secret assignment', () => {
    const findings = scanFileContent('config.js', 'apiKey: "sk_live_1234567890abcdef"');
    expect(findings.some(f => f.rule === 'credential-generic-assignment')).toBe(true);
  });

  test('does not flag the word "secret" alone in prose', () => {
    const findings = scanFileContent('docs/note.md', 'Keep the Tool Request secret payload private.');
    expect(findings).toHaveLength(0);
  });

  test('flags the private repository identifier', () => {
    // Built via concatenation rather than a literal so this fixture file's
    // own source text doesn't contain the identifier it exercises — see
    // the same rationale on the rule definition in copybara-validate.mjs.
    const privateRepoRef = 'clone git@github.com:m2dw/n8n-ai-cli-loop' + '-ai.git';
    const findings = scanFileContent('README.md', privateRepoRef);
    expect(findings.some(f => f.rule === 'internal-repo-identifier')).toBe(true);
  });

  test('does not flag the public repository name', () => {
    const findings = scanFileContent('README.md', 'clone git@github.com:m2dw/n8n-ai-cli-loop.git');
    expect(findings).toHaveLength(0);
  });

  test('reports the correct 1-based line number', () => {
    const findings = scanFileContent('f.md', 'line one\nline two /Users/alice/x\nline three');
    expect(findings.find(f => f.rule === 'personal-path-unix').line).toBe(2);
  });

  test('reports every occurrence on repeated custom rule set', () => {
    const rule = { id: 'custom', description: 'digit', pattern: /\d/g };
    const findings = scanFileContent('f.txt', '1 2 3', [rule]);
    expect(findings).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// scanPath — forbidden path rules
// ---------------------------------------------------------------------------

describe('scanPath', () => {
  test('flags .n8n-artifacts contents', () => {
    const findings = scanPath('.n8n-artifacts/runs/1/log.txt');
    expect(findings.some(f => f.rule === 'forbidden-artifacts-dir')).toBe(true);
  });

  test('flags .env files', () => {
    expect(scanPath('.env').some(f => f.rule === 'forbidden-env-file')).toBe(true);
    expect(scanPath('.env.local').some(f => f.rule === 'forbidden-env-file')).toBe(true);
  });

  test('flags key material files', () => {
    expect(scanPath('id_rsa').some(f => f.rule === 'forbidden-key-file')).toBe(true);
    expect(scanPath('certs/server.pem').some(f => f.rule === 'forbidden-key-extension')).toBe(true);
  });

  test('flags internal-only docs by path (defense in depth for copy.bara.sky drift)', () => {
    expect(scanPath('docs/DOMAIN.md').some(f => f.rule === 'forbidden-internal-doc')).toBe(true);
    expect(scanPath('docs/design/plan.md').some(f => f.rule === 'forbidden-internal-design-dir')).toBe(true);
  });

  test('does not flag an ordinary public doc', () => {
    expect(scanPath('docs/install.md')).toHaveLength(0);
  });

  test('flags the handlers extraction plan and its structural test (issue #811)', () => {
    expect(scanPath('docs/handlers-extraction-plan.md').some(f => f.rule === 'forbidden-handlers-extraction-plan')).toBe(true);
    expect(scanPath('test/docs-handlers-extraction-plan.test.js').some(f => f.rule === 'forbidden-handlers-extraction-plan-test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkDependencyManifest (issue #811 dependency closure)
// ---------------------------------------------------------------------------

describe('checkDependencyManifest', () => {
  test('is silent when no dependent path is present', () => {
    const present = new Set(['README.md', 'docs/install.md']);
    expect(checkDependencyManifest(present)).toHaveLength(0);
  });

  test('is silent when a dependent is present alongside everything it requires', () => {
    const present = new Set([
      'docs/handlers-extraction-plan.md',
      'test/docs-handlers-extraction-plan.test.js',
      'docs/DOMAIN.md',
      'docs/design/handlers-responsibility-inventory.md',
    ]);
    expect(checkDependencyManifest(present)).toHaveLength(0);
  });

  test('flags a dependent present without its required paths', () => {
    const present = new Set(['docs/handlers-extraction-plan.md']);
    const findings = checkDependencyManifest(present);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.match === 'docs/DOMAIN.md')).toBe(true);
    expect(findings.some(f => f.match === 'docs/design/handlers-responsibility-inventory.md')).toBe(true);
  });

  test('flags only the missing requirement when one of two requirements is present', () => {
    const present = new Set(['test/docs-handlers-extraction-plan.test.js', 'docs/DOMAIN.md']);
    const findings = checkDependencyManifest(present);
    expect(findings.some(f => f.match === 'docs/design/handlers-responsibility-inventory.md')).toBe(true);
    expect(findings.some(f => f.match === 'docs/DOMAIN.md')).toBe(false);
  });

  test('every manifest rule id is unique', () => {
    const ids = DEPENDENCY_MANIFEST.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// scanTree — end-to-end
// ---------------------------------------------------------------------------

describe('scanTree', () => {
  test('returns ok:true for a clean tree', () => {
    const dir = join(TMP, 'clean-tree');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'Hello, this is public-safe.\n');
    const result = scanTree(dir);
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  test('returns ok:false and collects findings across multiple files', () => {
    const dir = join(TMP, 'dirty-tree');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'built at /Users/alice/git/repo\n');
    writeFileSync(join(dir, '.env'), 'SECRET=x\n');
    const result = scanTree(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.some(f => f.file === 'README.md')).toBe(true);
    expect(result.findings.some(f => f.file === '.env')).toBe(true);
  });

  test('skips binary-extension files rather than erroring', () => {
    const dir = join(TMP, 'binary-tree');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const result = scanTree(dir);
    expect(result.ok).toBe(true);
  });

  test('skips files containing NUL bytes without throwing', () => {
    const dir = join(TMP, 'nul-tree');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'data.bin'), Buffer.from('a\u0000b'));
    expect(() => scanTree(dir)).not.toThrow();
  });

  test('exempts test/** from content rules (documented fixture convention)', () => {
    const dir = join(TMP, 'test-fixture-tree');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'path-sanitize.test.js'), 'built at /Users/moto/repo\n');
    const result = scanTree(dir);
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  test('still flags forbidden paths (not just content) under test/**', () => {
    const dir = join(TMP, 'test-fixture-forbidden-path');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', '.env'), 'SECRET=x\n');
    const result = scanTree(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.some(f => f.rule === 'forbidden-env-file')).toBe(true);
  });

  test('exempts documented example files from personal-path rules only', () => {
    const dir = join(TMP, 'docs-example-tree');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'src', 'core'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'idea-to-implementation.md'), 'e.g. /Users/you/.n8n-artifacts/...\n');
    writeFileSync(join(dir, 'src', 'core', 'text-sanitize.ts'), '// e.g. C:\\Users\\Jane Doe\\secret.txt\n');
    const result = scanTree(dir);
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  test('exempted example files still fail on a real credential leak', () => {
    const dir = join(TMP, 'docs-example-credential-tree');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    const token = 'ghp_' + 'a'.repeat(36);
    writeFileSync(join(dir, 'docs', 'idea-to-implementation.md'), `token: ${token}\n`);
    const result = scanTree(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.some(f => f.rule === 'credential-github-token')).toBe(true);
  });

  // Issue #811 regression guard: this is the exact failure mode from public
  // PR m2dw/n8n-ai-cli-loop#1 — a tree that (mis)exports the handlers
  // extraction plan/test without their private-only dependencies must fail
  // validation before it's presented as a clean public snapshot.
  test('fails on a reintroduced dangling handlers-extraction-plan dependency', () => {
    const dir = join(TMP, 'dangling-dependency-tree');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'handlers-extraction-plan.md'), '# plan\n');
    writeFileSync(join(dir, 'test', 'docs-handlers-extraction-plan.test.js'), 'test("x", () => {});\n');
    const result = scanTree(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.some(f => f.rule === 'handlers-extraction-plan-requires-private-only-docs')).toBe(true);
  });

  test('passes when the plan/test are exported alongside their required private-only docs', () => {
    const dir = join(TMP, 'complete-dependency-tree');
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'handlers-extraction-plan.md'), '# plan\n');
    writeFileSync(join(dir, 'test', 'docs-handlers-extraction-plan.test.js'), 'test("x", () => {});\n');
    writeFileSync(join(dir, 'docs', 'DOMAIN.md'), '# domain\n');
    writeFileSync(join(dir, 'docs', 'design', 'handlers-responsibility-inventory.md'), '# inventory\n');
    // The forbidden-path rules still fire independently for these paths
    // (defense in depth); isolate the dependency-manifest check specifically.
    const result = scanTree(dir, { pathRules: [] });
    expect(result.findings.some(f => f.rule === 'handlers-extraction-plan-requires-private-only-docs')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// main — CLI wrapper
// ---------------------------------------------------------------------------

describe('main', () => {
  test('returns 0 for a clean directory', () => {
    const dir = join(TMP, 'cli-clean');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.md'), 'fine\n');
    expect(main([dir])).toBe(0);
  });

  test('returns nonzero for a directory with a finding', () => {
    const dir = join(TMP, 'cli-dirty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.md'), '/Users/alice/secret-path\n');
    expect(main([dir])).toBe(1);
  });

  test('returns 2 when no directory argument is given', () => {
    expect(main([])).toBe(2);
  });

  test('throws when the directory does not exist (fail closed)', () => {
    expect(() => main([join(TMP, 'does-not-exist')])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rule table sanity
// ---------------------------------------------------------------------------

describe('rule tables', () => {
  test('every content rule has a global regex (required for exec-loop scanning)', () => {
    for (const rule of CONTENT_RULES) {
      expect(rule.pattern.global).toBe(true);
    }
  });

  test('every forbidden path rule id is unique', () => {
    const ids = FORBIDDEN_PATH_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
