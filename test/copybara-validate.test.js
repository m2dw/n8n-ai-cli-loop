import {
  walkFiles,
  scanFileContent,
  scanPath,
  scanTree,
  main,
  displayMatch,
  isReadableSemanticValue,
  parseSuppressionMarkers,
  shannonEntropyBitsPerChar,
  CONTENT_RULES,
  FORBIDDEN_PATH_RULES,
  DEPENDENCY_MANIFEST,
  checkDependencyManifest,
  PRIVATE_ONLY_DOC_PATHS,
  PRIVATE_ONLY_DOC_PREFIXES,
  checkUnconditionalPrivateReads,
} from '../scripts/copybara-validate.mjs';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const TMP = join(tmpdir(), `copybara-validate-test-${process.pid}`);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Rule ids only — never the matched text, which for these rules IS the secret. */
const ruleIds = (findings) => findings.map((f) => f.rule);

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
// isReadableSemanticValue — value classification (issue #971)
// ---------------------------------------------------------------------------

describe('isReadableSemanticValue', () => {
  test('accepts readable multi-word semantic literals', () => {
    for (const value of [
      'refinement-handoff',
      'review-dispute',
      'status-needs-review',
      'refinement_handoff_marker',
      'chatops-operation-dispatch',
      'session-handoff',
    ]) {
      expect(isReadableSemanticValue(value)).toBe(true);
    }
  });

  test('rejects values carrying a digit, uppercase letter, or base64 character', () => {
    for (const value of [
      'refinement-handoff2',
      'Refinement-Handoff',
      'refinement-handoff==',
      'refinement.handoff.key',
      'refinement/handoff',
      'refinement handoff',
    ]) {
      expect(isReadableSemanticValue(value)).toBe(false);
    }
  });

  test('rejects a single unseparated blob (no readable word boundary)', () => {
    expect(isReadableSemanticValue('refinementhandoff')).toBe(false);
    expect(isReadableSemanticValue('abcdefghijklmnopq')).toBe(false);
  });

  test('rejects word-list/passphrase shapes of four or more segments', () => {
    expect(isReadableSemanticValue('correct-horse-battery-staple')).toBe(false);
    expect(isReadableSemanticValue('table-window-orange-silver-river')).toBe(false);
  });

  test('rejects hex-alphabet-only values that would otherwise look word-shaped', () => {
    expect(isReadableSemanticValue('deadbeef-cafebabe')).toBe(false);
    expect(isReadableSemanticValue('facade-decade-feed')).toBe(false);
  });

  test('rejects segments with too few vowels', () => {
    expect(isReadableSemanticValue('xkcdqrst-mnpvblwz')).toBe(false);
    expect(isReadableSemanticValue('strngth-handoff')).toBe(false);
  });

  test('rejects segments with a consonant run longer than three', () => {
    // `workflow` has the four-consonant run `rkfl`; its vowel ratio (2/8) is
    // in range, so the run length is the only signal that rejects this one.
    expect(isReadableSemanticValue('handoff-workflow')).toBe(false);
    expect(isReadableSemanticValue('handoff-refinement')).toBe(true);
  });

  test('rejects over-long values and over-long/over-short segments', () => {
    expect(isReadableSemanticValue('refinement-handoff-' + 'a'.repeat(30))).toBe(false);
    expect(isReadableSemanticValue('refinement-superlonguninterrupted')).toBe(false);
    expect(isReadableSemanticValue('re-finement-handoff')).toBe(false);
  });

  test('rejects a long value whose estimated entropy is above the readable band', () => {
    // Word-shaped by every structural signal — lowercase, two separated
    // segments of 11 and 12 characters, per-segment vowel ratios in range,
    // no consonant run longer than three, not hex-only — but 21 distinct
    // characters in 24 is the alphabet spread of random text, not of words.
    // The entropy ceiling is the only signal that rejects this one.
    expect(isReadableSemanticValue('bacedifogun-hyjapkerqizv')).toBe(false);
    // Same length band, ordinary word repetition: accepted.
    expect(isReadableSemanticValue('refinement_handoff_marker')).toBe(true);
  });

  test('shannonEntropyBitsPerChar measures the string\'s own distribution', () => {
    expect(shannonEntropyBitsPerChar('')).toBe(0);
    expect(shannonEntropyBitsPerChar('aaaaaaaa')).toBe(0);
    expect(shannonEntropyBitsPerChar('abcdefgh')).toBeCloseTo(3, 10);
  });

  test('rejects non-string input', () => {
    expect(isReadableSemanticValue(undefined)).toBe(false);
    expect(isReadableSemanticValue(null)).toBe(false);
    expect(isReadableSemanticValue(12345678901234567890)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanFileContent — classified generic assignments (issue #971)
// ---------------------------------------------------------------------------

describe('credential-generic-assignment classification', () => {
  test('does not flag a readable semantic literal bound to a TOKEN-named constant', () => {
    const findings = scanFileContent(
      'src/core/issue-refinement-publication.ts',
      'const REFINEMENT_HANDOFF_KEY_TOKEN = "refinement-handoff";',
    );
    expect(findings).toHaveLength(0);
  });

  test('does not flag readable semantic literals under other credential keywords', () => {
    for (const line of [
      'const REVIEW_DISPUTE_SECRET = "status-needs-review";',
      'apiKey: "refinement-handoff"',
      "const HANDOFF_TOKEN = 'chatops-operation-dispatch';",
    ]) {
      expect(scanFileContent('src/x.ts', line)).toHaveLength(0);
    }
  });

  test('still flags random-looking, mixed-case, and digit-bearing values', () => {
    for (const line of [
      'const TOKEN = "aB3xK9mQ2pL7vN4tR6wZ";',
      'const TOKEN = "abcdefghijklmnopqrst";',
      'secret = "a1b2c3d4e5f6071829ab"',
      'apiKey: "sk_live_1234567890abcdef"',
    ]) {
      expect(ruleIds(scanFileContent('src/x.ts', line))).toContain('credential-generic-assignment');
    }
  });

  test('still flags base64-like and hex-like values, including padded base64', () => {
    for (const line of [
      'const SECRET = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=";',
      'const SECRET = "deadbeefcafebabe0123";',
      'const SECRET = "deadbeef-cafebabe";',
      'token: "ab+cd/ef+gh/ij+kl/mn=="',
    ]) {
      expect(ruleIds(scanFileContent('src/x.ts', line))).toContain('credential-generic-assignment');
    }
  });

  test('still flags JWT-shaped values, including outside an assignment', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(ruleIds(scanFileContent('src/x.ts', `const TOKEN = "${jwt}";`))).toContain('credential-jwt');
    expect(ruleIds(scanFileContent('run.log', `curl -H "Authorization: Bearer ${jwt}"`))).toContain('credential-jwt');
  });

  test('still flags known-prefix credentials assigned to a keyword identifier', () => {
    const gh = 'ghp_' + 'a'.repeat(36);
    const ids = ruleIds(scanFileContent('src/x.ts', `const TOKEN = "${gh}";`));
    expect(ids).toContain('credential-github-token');
    expect(ids).toContain('credential-generic-assignment');
  });

  test('still flags ambiguous word-list/passphrase values (fail closed)', () => {
    const ids = ruleIds(scanFileContent('src/x.ts', 'const TOKEN = "correct-horse-battery-staple";'));
    expect(ids).toContain('credential-generic-assignment');
  });

  test('classification does not weaken any known-format rule', () => {
    // Every known-format credential rule is unconditional: none of them
    // declares a classifier or opts into suppression.
    for (const rule of CONTENT_RULES) {
      if (rule.id === 'credential-generic-assignment') continue;
      expect(rule.classifyValue).toBeUndefined();
      expect(rule.suppressible).toBeUndefined();
    }
  });

  test('a reported generic assignment is still redacted for display', () => {
    const [finding] = scanFileContent('src/x.ts', 'const TOKEN = "aB3xK9mQ2pL7vN4tR6wZ";');
    expect(displayMatch(finding)).toMatch(/^\[REDACTED \d+ chars\]$/);
    expect(displayMatch(finding)).not.toContain('aB3xK9mQ');
  });
});

// ---------------------------------------------------------------------------
// Explicit suppression marker (issue #971)
// ---------------------------------------------------------------------------

const MARKER = (ruleId, key, reason = 'reviewed, semantic literal') =>
  `// copybara-allow-next-line: ${ruleId} ${key} -- ${reason}`;

describe('parseSuppressionMarkers', () => {
  test('parses a well-formed marker into rule -> keys', () => {
    const parsed = parseSuppressionMarkers(MARKER('credential-generic-assignment', 'DEMO_TOKEN'));
    expect(parsed.get('credential-generic-assignment')).toEqual(new Set(['DEMO_TOKEN']));
  });

  test('parses several markers on one line', () => {
    const line = `${MARKER('credential-generic-assignment', 'A_TOKEN')} ${MARKER('credential-generic-assignment', 'B_TOKEN')}`;
    const keys = parseSuppressionMarkers(line).get('credential-generic-assignment');
    expect(keys).toEqual(new Set(['A_TOKEN', 'B_TOKEN']));
  });

  test('does not parse a marker missing its reason, key, or separator', () => {
    for (const line of [
      '// copybara-allow-next-line: credential-generic-assignment DEMO_TOKEN --',
      '// copybara-allow-next-line: credential-generic-assignment DEMO_TOKEN',
      '// copybara-allow-next-line: credential-generic-assignment -- reviewed',
      '// copybara-allow-next-line:',
      '// copybara-allow DEMO_TOKEN -- reviewed',
    ]) {
      expect(parseSuppressionMarkers(line).size).toBe(0);
    }
  });

  test('returns an empty map for empty or non-string input', () => {
    expect(parseSuppressionMarkers('').size).toBe(0);
    expect(parseSuppressionMarkers(undefined).size).toBe(0);
  });

  test('accepts an em dash as the reason separator', () => {
    const line = '# copybara-allow-next-line: credential-generic-assignment DEMO_TOKEN — reviewed';
    expect(parseSuppressionMarkers(line).get('credential-generic-assignment')).toEqual(new Set(['DEMO_TOKEN']));
  });
});

describe('suppression marker scoping', () => {
  const AMBIGUOUS = 'const DEMO_TOKEN = "correct-horse-battery-staple";';

  test('suppresses the finding on the immediately following line', () => {
    const content = [MARKER('credential-generic-assignment', 'DEMO_TOKEN'), AMBIGUOUS].join('\n');
    expect(scanFileContent('src/x.ts', content)).toHaveLength(0);
  });

  test('works in any comment syntax, since only the raw previous line is read', () => {
    for (const comment of ['#', '<!--', '--', '%']) {
      const content = [
        `${comment} copybara-allow-next-line: credential-generic-assignment DEMO_TOKEN -- reviewed`,
        AMBIGUOUS,
      ].join('\n');
      expect(scanFileContent('a.yml', content)).toHaveLength(0);
    }
  });

  test('does not suppress a finding two lines below the marker', () => {
    const content = [MARKER('credential-generic-assignment', 'DEMO_TOKEN'), '', AMBIGUOUS].join('\n');
    expect(ruleIds(scanFileContent('src/x.ts', content))).toEqual(['credential-generic-assignment']);
  });

  test('does not suppress a later, unrelated assignment in the same file', () => {
    const content = [
      MARKER('credential-generic-assignment', 'DEMO_TOKEN'),
      AMBIGUOUS,
      'const OTHER_TOKEN = "correct-horse-battery-staple";',
    ].join('\n');
    const findings = scanFileContent('src/x.ts', content);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  test('does not suppress an assignment under a different identifier', () => {
    const content = [
      MARKER('credential-generic-assignment', 'DEMO_TOKEN'),
      'const OTHER_TOKEN = "correct-horse-battery-staple";',
    ].join('\n');
    expect(ruleIds(scanFileContent('src/x.ts', content))).toEqual(['credential-generic-assignment']);
  });

  test('suppresses only the named assignment when one line carries two', () => {
    const content = [
      MARKER('credential-generic-assignment', 'DEMO_TOKEN'),
      'const DEMO_TOKEN = "correct-horse-battery-staple"; const OTHER_TOKEN = "table-window-orange-silver";',
    ].join('\n');
    const findings = scanFileContent('src/x.ts', content);
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toContain('OTHER_TOKEN');
    expect(findings[0].match).not.toContain('DEMO_TOKEN');
  });

  test('does not suppress when the marker names a different rule id', () => {
    const content = [MARKER('personal-path-unix', 'DEMO_TOKEN'), AMBIGUOUS].join('\n');
    expect(ruleIds(scanFileContent('src/x.ts', content))).toEqual(['credential-generic-assignment']);
  });

  test('does not suppress a rule that has not opted into suppression', () => {
    const gh = 'ghp_' + 'a'.repeat(36);
    const content = [MARKER('credential-github-token', 'DEMO_TOKEN'), `const DEMO_TOKEN = "${gh}";`].join('\n');
    expect(ruleIds(scanFileContent('src/x.ts', content))).toContain('credential-github-token');
  });

  test('a marker on a line of its own suppresses nothing by itself', () => {
    const content = [MARKER('credential-generic-assignment', 'DEMO_TOKEN'), 'const x = 1;', AMBIGUOUS].join('\n');
    expect(scanFileContent('src/x.ts', content)).toHaveLength(1);
  });

  test('the marker never restates the exempted value', () => {
    const marker = MARKER('credential-generic-assignment', 'DEMO_TOKEN');
    expect(marker).not.toContain('correct-horse-battery-staple');
    // ...and the marker line itself is not a finding.
    expect(scanFileContent('src/x.ts', marker)).toHaveLength(0);
  });

  test('scanTree honours the marker end to end', () => {
    const dir = join(TMP, 'suppression-tree');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'demo.ts'),
      [MARKER('credential-generic-assignment', 'DEMO_TOKEN'), AMBIGUOUS, ''].join('\n'),
    );
    expect(scanTree(dir).ok).toBe(true);

    writeFileSync(join(dir, 'src', 'demo.ts'), [AMBIGUOUS, ''].join('\n'));
    expect(scanTree(dir).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// This repository's own sources must survive the scanner (issue #971)
// ---------------------------------------------------------------------------

describe('self-scan', () => {
  // The validator's own source and its documentation are both exported by
  // origin_files and scanned like any other file, so a rule (or a doc example
  // of the suppression marker) that trips on them would break every export.
  test.each([
    'scripts/copybara-validate.mjs',
    'docs/copybara-export-poc.md',
    'src/core/issue-refinement-publication.ts',
  ])('%s produces no credential findings', (rel) => {
    const findings = scanFileContent(rel, readFileSync(resolve(ROOT, rel), 'utf8'))
      .filter((f) => f.rule.startsWith('credential-'))
      // Report location only — never the matched text.
      .map((f) => `${f.rule}:${f.line}`);
    expect(findings).toEqual([]);
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
// checkUnconditionalPrivateReads (issue #973 dependency closure — general form)
// ---------------------------------------------------------------------------

describe('checkUnconditionalPrivateReads', () => {
  test('flags an unconditional read() call when the private path is absent from the tree', () => {
    const content = "const domain = read('docs/DOMAIN.md');";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('unconditional-private-read');
    expect(findings[0].match).toBe('docs/DOMAIN.md');
  });

  test('flags an unconditional readFileSync(resolve(...)) call', () => {
    const content = "const domain = readFileSync(resolve(ROOT, 'docs/DOMAIN.md'), 'utf8');";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings).toHaveLength(1);
  });

  test('is silent for the existsSync-guarded conditional-read pattern', () => {
    const content =
      "const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings).toHaveLength(0);
  });

  // Review follow-up (issue #973): an existsSync guard whose ternary puts the
  // read on the ABSENT-path branch still executes that read against an
  // exported tree — the earlier version of this check only looked for an
  // intervening `;` and mistook this for the safe pattern above.
  test('flags the inverted ternary where the read runs precisely when the path is absent', () => {
    const content =
      "const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? null : read('docs/DOMAIN.md');";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('docs/DOMAIN.md');
  });

  test('is silent when the private path is present in the same tree (the private source tree, not an export)', () => {
    const content = "const domain = read('docs/DOMAIN.md');";
    const findings = checkUnconditionalPrivateReads(
      'test/example.test.js',
      content,
      new Set(['docs/DOMAIN.md']),
    );
    expect(findings).toHaveLength(0);
  });

  test('is silent for a mere string-literal reference that is not a read call', () => {
    const content = "expect(findings.some(f => f.match === 'docs/DOMAIN.md')).toBe(true);";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings).toHaveLength(0);
  });

  test('the default private-only path list includes docs/DOMAIN.md', () => {
    expect(PRIVATE_ONLY_DOC_PATHS).toContain('docs/DOMAIN.md');
  });

  // Review follow-up (issue #973): an existsSync guard for a DIFFERENT path,
  // or one whose result is never used to gate the read, must not suppress
  // the finding — the tree still dangles with ENOENT in both cases.
  test('is not silenced by an existsSync guard on an unrelated path', () => {
    const content = "existsSync('README.md'); const domain = read('docs/DOMAIN.md');";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings).toHaveLength(1);
  });

  test('is not silenced by an existsSync guard on the right path in a discarded earlier statement', () => {
    const content = "existsSync('docs/DOMAIN.md'); const domain = read('docs/DOMAIN.md');";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings).toHaveLength(1);
  });

  // Review follow-up (issue #973, P2): the earlier "no `;` or `:` in between"
  // test only rejected two specific separators, so an `existsSync(path) ||
  // read(path)` guard slipped through as "guarded" even though `||` means the
  // read runs precisely when existsSync is FALSE — the path is absent — which
  // still throws ENOENT in an exported tree.
  test('is not silenced by an existsSync guard joined with || (read runs when the path is absent)', () => {
    const content = "existsSync(resolve(ROOT, 'docs/DOMAIN.md')) || read('docs/DOMAIN.md');";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings).toHaveLength(1);
  });

  // Review follow-up (issue #973, P2): a same-window `existsSync(...)` mention
  // that is only commented-out text, not a live guard, must not be credited
  // as one either — the read below it still executes unconditionally.
  test('is not silenced by an existsSync mention that only appears in a comment', () => {
    const content =
      "// existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null\n" +
      "const domain = read('docs/DOMAIN.md');";
    const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
    expect(findings.some((f) => f.match === 'docs/DOMAIN.md')).toBe(true);
  });

  // Review follow-up (issue #973): this validator's own test file legitimately
  // contains the above patterns as quoted fixture strings (test data for this
  // very function), not as executable calls it would run — scanning them as
  // live code produced a false positive against the real public export tree.
  test('is exempt for this validator\'s own test file, whose source is fixture strings, not live calls', () => {
    const content = "const content = \"const domain = read('docs/DOMAIN.md');\";";
    const findings = checkUnconditionalPrivateReads('test/copybara-validate.test.js', content, new Set());
    expect(findings).toHaveLength(0);
  });

  // Review follow-up (issue #973, P2): copy.bara.sky's PRIVATE_ONLY_PATHS
  // also excludes docs/design/** as a directory glob, not just
  // docs/DOMAIN.md. The default check must cover an unconditional read of
  // any concrete file under docs/design/ — not just the ones enumerated at
  // the time this test was written — or a newly added private design doc
  // reintroduces the exact same public-export ENOENT failure class.
  describe('docs/design/** prefix coverage', () => {
    test('the default private-only prefix list includes docs/design/', () => {
      expect(PRIVATE_ONLY_DOC_PREFIXES).toContain('docs/design/');
    });

    test('flags an unconditional read of a concrete docs/design/ file absent from the tree', () => {
      const content = "const inventory = read('docs/design/handlers-responsibility-inventory.md');";
      const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe('unconditional-private-read');
      expect(findings[0].match).toBe('docs/design/handlers-responsibility-inventory.md');
    });

    test('flags an unconditional read of a docs/design/ file never enumerated by this test file', () => {
      const content = "const contract = readFileSync(resolve(ROOT, 'docs/design/some-future-doc.md'), 'utf8');";
      const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
      expect(findings).toHaveLength(1);
      expect(findings[0].match).toBe('docs/design/some-future-doc.md');
    });

    test('is silent for the existsSync-guarded conditional-read pattern under docs/design/', () => {
      const content =
        "const inventory = existsSync(resolve(ROOT, 'docs/design/handlers-responsibility-inventory.md')) " +
        "? read('docs/design/handlers-responsibility-inventory.md') : null;";
      const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
      expect(findings).toHaveLength(0);
    });

    test('is silent when the docs/design/ file is present in the same tree (the private source tree)', () => {
      const content = "const inventory = read('docs/design/handlers-responsibility-inventory.md');";
      const findings = checkUnconditionalPrivateReads(
        'test/example.test.js',
        content,
        new Set(['docs/design/handlers-responsibility-inventory.md']),
      );
      expect(findings).toHaveLength(0);
    });

    test('does not flag a read of a public docs/ path that merely starts with a similar prefix', () => {
      const content = "const contract = read('docs/design-notes.md');";
      const findings = checkUnconditionalPrivateReads('test/example.test.js', content, new Set());
      expect(findings).toHaveLength(0);
    });
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

  // Issue #973 regression guard: this is the exact failure mode from public
  // CI run m2dw/n8n-ai-cli-loop#actions/runs/32203801983 — a still-exported
  // test that unconditionally reads a private-only path (unlike the #811
  // case above, this file is NOT itself excluded) must fail validation
  // before it's presented as a clean public snapshot, without requiring a
  // new hand-curated DEPENDENCY_MANIFEST entry.
  test('fails on an exported test that reintroduces an unconditional read of a private-only doc', () => {
    const dir = join(TMP, 'unconditional-private-read-tree');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(
      join(dir, 'test', 'docs-chatops-result-contract.test.js'),
      "const domain = read('docs/DOMAIN.md');\n",
    );
    const result = scanTree(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.some(f => f.rule === 'unconditional-private-read')).toBe(true);
  });

  test('passes when the same read is guarded by existsSync, docs/DOMAIN.md absent (the real public export shape)', () => {
    const dir = join(TMP, 'guarded-private-read-tree');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(
      join(dir, 'test', 'docs-chatops-result-contract.test.js'),
      "const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;\n",
    );
    const result = scanTree(dir);
    expect(result.findings.some(f => f.rule === 'unconditional-private-read')).toBe(false);
  });

  // Review follow-up (issue #973): validating the actual public export tree
  // (docs/DOMAIN.md absent) with this validator's own test file present must
  // not flag that file's quoted fixture strings as an unconditional read —
  // this is the exact false positive that blocked the real export.
  test('does not flag this validator\'s own test file for its quoted fixture strings', () => {
    const dir = join(TMP, 'validator-own-test-fixture-tree');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(
      join(dir, 'test', 'copybara-validate.test.js'),
      "const content = \"const domain = read('docs/DOMAIN.md');\";\n" +
        "const guarded = \"const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;\";\n",
    );
    const result = scanTree(dir);
    expect(result.findings.some(f => f.rule === 'unconditional-private-read')).toBe(false);
  });

  test('still flags an unrelated exported test with a genuinely unguarded read alongside the exempt file', () => {
    const dir = join(TMP, 'mixed-exempt-and-real-tree');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(
      join(dir, 'test', 'copybara-validate.test.js'),
      "const content = \"const domain = read('docs/DOMAIN.md');\";\n",
    );
    writeFileSync(
      join(dir, 'test', 'docs-chatops-result-contract.test.js'),
      "const domain = read('docs/DOMAIN.md');\n",
    );
    const result = scanTree(dir);
    expect(result.findings.some(f => f.rule === 'unconditional-private-read' && f.file === 'test/docs-chatops-result-contract.test.js')).toBe(true);
    expect(result.findings.some(f => f.rule === 'unconditional-private-read' && f.file === 'test/copybara-validate.test.js')).toBe(false);
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

  test('exactly one rule opts into classification and suppression (issue #971)', () => {
    expect(CONTENT_RULES.filter(r => r.classifyValue).map(r => r.id)).toEqual(['credential-generic-assignment']);
    expect(CONTENT_RULES.filter(r => r.suppressible).map(r => r.id)).toEqual(['credential-generic-assignment']);
  });

  test('a classifying or suppressible rule declares the capture group it needs', () => {
    for (const rule of CONTENT_RULES) {
      if (rule.classifyValue) expect(typeof rule.valueGroup).toBe('number');
      if (rule.suppressible) expect(typeof rule.suppressionKeyGroup).toBe('number');
    }
  });
});
