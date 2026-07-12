import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Tests for ecosystem preset commands (issue #513):
//   admin session preset list
//   admin session preset show <name>
//   admin session-init --preset <name>
//   admin session-doctor suggestions when environmentPrepare/verification are absent

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let sessionsPath;
let repoRoot;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'preset-test-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

function initRepo() {
  mkdirSync(repoRoot, { recursive: true });
  const git = (...a) =>
    execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repoRoot, 'README.md'), '# test\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
}

function writeSession(overrides = {}) {
  const session = {
    sessionId: 'test-session',
    repoKey: 'test-repo',
    repoRoot,
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
}

// ---------------------------------------------------------------------------
// session preset list
// ---------------------------------------------------------------------------

test('session preset list returns known presets', () => {
  const r = run('--json', 'session', 'preset', 'list');
  expect(r.code).toBe(0);
  const out = parse(r);
  expect(out.ok).toBe(true);
  expect(Array.isArray(out.presets)).toBe(true);
  const names = out.presets.map((p) => p.name);
  expect(names).toContain('javascript-npm');
  expect(names).toContain('php-composer');
  expect(names).toContain('rust-cargo');
  expect(names).toContain('go-mod');
  expect(names).toContain('javascript-pnpm');
  expect(names).toContain('python-uv');
  // Each entry has a description
  for (const p of out.presets) {
    expect(typeof p.description).toBe('string');
    expect(p.description.length).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// session preset show
// ---------------------------------------------------------------------------

test('session preset show javascript-npm returns full preset details', () => {
  const r = run('--json', 'session', 'preset', 'show', 'javascript-npm');
  expect(r.code).toBe(0);
  const out = parse(r);
  expect(out.ok).toBe(true);
  expect(out.preset.name).toBe('javascript-npm');
  expect(out.preset.environmentPrepare.command).toBe('npm ci --ignore-scripts');
  expect(out.preset.environmentPrepare.cacheKeyFiles).toContain('package-lock.json');
  expect(typeof out.preset.verificationSuggestions).toBe('object');
  expect(out.preset.verificationSuggestions.test).toBe('npm test');
});

test('session preset show php-composer returns composer preset', () => {
  const r = run('--json', 'session', 'preset', 'show', 'php-composer');
  expect(r.code).toBe(0);
  const out = parse(r);
  expect(out.preset.environmentPrepare.command).toBe('composer install --no-interaction --no-scripts');
  expect(out.preset.environmentPrepare.cacheKeyFiles).toContain('composer.lock');
  expect(out.preset.verificationSuggestions.test).toBe('vendor/bin/phpunit');
});

test('session preset show rust-cargo returns cargo preset', () => {
  const r = run('--json', 'session', 'preset', 'show', 'rust-cargo');
  expect(r.code).toBe(0);
  const out = parse(r);
  expect(out.preset.environmentPrepare.command).toBe('cargo fetch');
  expect(out.preset.verificationSuggestions.test).toBe('cargo test');
});

test('session preset show unknown-preset exits non-zero with helpful message', () => {
  const r = run('--json', 'session', 'preset', 'show', 'unknown-ecosystem');
  expect(r.code).not.toBe(0);
  const out = parse(r);
  expect(out.ok).toBe(false);
  expect(out.error).toMatch(/Unknown preset/);
  expect(out.error).toMatch(/unknown-ecosystem/);
});

test('session preset show with no name exits non-zero', () => {
  const r = run('--json', 'session', 'preset', 'show');
  expect(r.code).not.toBe(0);
  const out = parse(r);
  expect(out.ok).toBe(false);
  expect(out.error).toMatch(/preset name is required/);
});

// ---------------------------------------------------------------------------
// session-init --preset
// ---------------------------------------------------------------------------

test('session-init --preset javascript-npm writes environmentPrepare and verification to session', () => {
  initRepo();
  const r = run(
    '--json',
    'session-init',
    '--sessions-path', sessionsPath,
    '--session-id', 'npm-session',
    '--repo-key', 'npm-repo',
    '--repo-root', repoRoot,
    '--github-repo', 'm2dw/npm-repo',
    '--artifact-dir', '.n8n-artifacts',
    '--implementation-agent', 'claude',
    '--review-agent', 'claude',
    '--preset', 'javascript-npm',
  );
  expect(r.code).toBe(0);
  const out = parse(r);
  expect(out.ok).toBe(true);
  // environmentPrepare populated from preset
  expect(out.session.environmentPrepare).toBeDefined();
  expect(out.session.environmentPrepare.enabled).toBe(true);
  expect(out.session.environmentPrepare.command).toBe('npm ci --ignore-scripts');
  expect(out.session.environmentPrepare.cacheKeyFiles).toContain('package-lock.json');
  // verification populated from preset suggestions
  expect(out.session.verification.test).toBe('npm test');
  // Written to file
  const file = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  const saved = file.sessions.find((s) => s.sessionId === 'npm-session');
  expect(saved.environmentPrepare.command).toBe('npm ci --ignore-scripts');
  expect(saved.verification.test).toBe('npm test');
});

test('session-init --preset php-composer writes composer environmentPrepare', () => {
  initRepo();
  const r = run(
    '--json',
    'session-init',
    '--sessions-path', sessionsPath,
    '--session-id', 'composer-session',
    '--repo-key', 'php-repo',
    '--repo-root', repoRoot,
    '--github-repo', 'm2dw/php-repo',
    '--artifact-dir', '.n8n-artifacts',
    '--implementation-agent', 'claude',
    '--review-agent', 'claude',
    '--preset', 'php-composer',
  );
  expect(r.code).toBe(0);
  const out = parse(r);
  expect(out.session.environmentPrepare.command).toBe('composer install --no-interaction --no-scripts');
  expect(out.session.verification.test).toBe('vendor/bin/phpunit');
});

test('session-init --preset with explicit --verification-json overrides preset verification', () => {
  initRepo();
  const r = run(
    '--json',
    'session-init',
    '--sessions-path', sessionsPath,
    '--session-id', 'custom-session',
    '--repo-key', 'custom-repo',
    '--repo-root', repoRoot,
    '--github-repo', 'm2dw/custom-repo',
    '--artifact-dir', '.n8n-artifacts',
    '--implementation-agent', 'claude',
    '--review-agent', 'claude',
    '--preset', 'javascript-npm',
    '--verification-json', JSON.stringify({ test: 'jest --ci', lint: 'eslint .' }),
  );
  expect(r.code).toBe(0);
  const out = parse(r);
  // Explicit verification overrides preset
  expect(out.session.verification.test).toBe('jest --ci');
  expect(out.session.verification.lint).toBe('eslint .');
  // environmentPrepare still comes from preset
  expect(out.session.environmentPrepare.command).toBe('npm ci --ignore-scripts');
});

test('session-init with unknown --preset exits non-zero', () => {
  initRepo();
  const r = run(
    '--json',
    'session-init',
    '--sessions-path', sessionsPath,
    '--session-id', 'bad-session',
    '--repo-key', 'bad-repo',
    '--repo-root', repoRoot,
    '--github-repo', 'm2dw/bad-repo',
    '--artifact-dir', '.n8n-artifacts',
    '--implementation-agent', 'claude',
    '--review-agent', 'claude',
    '--preset', 'not-a-real-ecosystem',
  );
  expect(r.code).not.toBe(0);
  const out = parse(r);
  expect(out.ok).toBe(false);
  expect(out.error).toMatch(/Unknown preset/);
});

test('session-init without --preset stores no environmentPrepare block', () => {
  initRepo();
  const r = run(
    '--json',
    'session-init',
    '--sessions-path', sessionsPath,
    '--session-id', 'plain-session',
    '--repo-key', 'plain-repo',
    '--repo-root', repoRoot,
    '--github-repo', 'm2dw/plain-repo',
    '--artifact-dir', '.n8n-artifacts',
    '--implementation-agent', 'claude',
    '--review-agent', 'claude',
  );
  expect(r.code).toBe(0);
  const out = parse(r);
  expect(out.session.environmentPrepare).toBeUndefined();
});

// ---------------------------------------------------------------------------
// session-doctor suggestions
// ---------------------------------------------------------------------------

test('session-doctor includes suggestions when environmentPrepare and verification are absent', () => {
  initRepo();
  writeSession();
  const r = run(
    '--json',
    'session-doctor',
    '--session-id', 'test-session',
    '--sessions-path', sessionsPath,
  );
  // Doctor may fail checks (gh auth etc.) but still returns structured output
  const out = parse(r);
  expect(out.ok).toBe(true);
  expect(Array.isArray(out.suggestions)).toBe(true);
  const msgs = out.suggestions.join(' ');
  expect(msgs).toMatch(/environmentPrepare/);
  expect(msgs).toMatch(/admin session preset list/);
  expect(msgs).toMatch(/verification/);
});

test('session-doctor omits environmentPrepare suggestion when it is already configured', () => {
  initRepo();
  writeSession({
    environmentPrepare: { enabled: true, command: 'npm ci', cacheKeyFiles: ['package-lock.json'] },
    verification: { test: 'npm test' },
  });
  const r = run(
    '--json',
    'session-doctor',
    '--session-id', 'test-session',
    '--sessions-path', sessionsPath,
  );
  const out = parse(r);
  expect(out.ok).toBe(true);
  const msgs = out.suggestions.join(' ');
  expect(msgs).not.toMatch(/environmentPrepare is not configured/);
  expect(msgs).not.toMatch(/No verification commands/);
});
