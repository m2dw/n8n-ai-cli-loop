import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  parseIssueDiscussArgs,
  runIssueDiscussPreview,
  parseIssueDiscussPostArgs,
  runIssueDiscussPost,
  computeFingerprint,
  buildIsolatedEnv,
  WRITE_ENABLING_ENV_KEYS,
  CWD_BEARING_ENV_KEYS,
} from '../dist/cli/issue-discuss.js';

const ADMIN_CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let repoRoot;
let sessionsPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'issue-discuss-test-'));
  repoRoot = join(tmpDir, 'repo');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeFileSync(sessionsPath, JSON.stringify({
    sessions: [{
      sessionId: 'addon-dev',
      repoKey: 'demo-repo',
      repoRoot,
      githubRepo: 'm2dw/demo-repo',
      artifactDir: '.n8n-artifacts',
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
      verification: {},
      labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    }],
  }));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// A read-only fake provider that records every method invoked on it. The
// interface exposes only readIssue, so there is no write surface to exercise.
function makeReader(issue) {
  const calls = [];
  return {
    calls,
    readIssue(repo, issueNumber) {
      calls.push({ method: 'readIssue', repo, issueNumber });
      return { number: issueNumber, ...issue };
    },
  };
}

const SAMPLE_ISSUE = {
  title: 'Add rate limiting to login',
  body: 'We should add a rate limiter to the login endpoint.',
  state: 'OPEN',
  labels: ['enhancement', 'agent:claude'],
  comments: [
    { author: 'alice', body: 'I think token bucket is best.', createdAt: '2026-01-01T00:00:00Z' },
    { author: 'bob', body: 'Agreed, but what about bursts?', createdAt: '2026-01-02T00:00:00Z' },
  ],
};

async function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(chunks.join('').trim());
}

function runAdmin(...args) {
  try {
    const stdout = execFileSync(process.execPath, [ADMIN_CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

describe('issue-discuss preview — argument parsing', () => {
  test('missing --session-id is rejected', () => {
    const parsed = parseIssueDiscussArgs(['--issue-number', '5']);
    expect(parsed).toMatchObject({ error: expect.stringContaining('session-id') });
  });

  test('missing --issue-number is rejected', () => {
    const parsed = parseIssueDiscussArgs(['--session-id', 'addon-dev']);
    expect(parsed).toMatchObject({ error: expect.stringContaining('issue-number') });
  });

  test('non-numeric --issue-number is rejected', () => {
    const parsed = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', 'abc']);
    expect(parsed).toMatchObject({ error: expect.stringContaining('issue-number') });
  });

  test('valid args parse with default comment limit', () => {
    const parsed = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '5']);
    expect(parsed).toMatchObject({ sessionId: 'addon-dev', issueNumber: 5, commentLimit: 10 });
  });

  test('--comment-limit is clamped to the max', () => {
    const parsed = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '5', '--comment-limit', '999']);
    expect(parsed.commentLimit).toBe(50);
  });
});

describe('issue-discuss preview — local artifact contract', () => {
  test('writes prompt + context artifacts and emits JSON with paths', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));

    expect(out).toMatchObject({
      ok: true,
      sessionId: 'addon-dev',
      repo: 'm2dw/demo-repo',
      issueNumber: 42,
      issueState: 'OPEN',
      posted: false,
    });
    expect(existsSync(out.artifacts.prompt)).toBe(true);
    expect(existsSync(out.artifacts.context)).toBe(true);
    expect(out.artifactDir).toContain('issue-42');
  });

  test('prompt includes title, state, labels, body, and comments', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));
    const prompt = readFileSync(out.artifacts.prompt, 'utf8');

    expect(prompt).toContain('Add rate limiting to login');
    expect(prompt).toContain('OPEN');
    expect(prompt).toContain('agent:claude');
    expect(prompt).toContain('rate limiter to the login endpoint');
    expect(prompt).toContain('token bucket');
    expect(prompt).toContain('what about bursts');
    // The prompt instructs the preview to never post or mutate.
    expect(prompt).toContain('PREVIEW ONLY');
    expect(prompt).toContain('Do NOT post');
  });

  test('context JSON captures bounded issue data', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));
    const context = JSON.parse(readFileSync(out.artifacts.context, 'utf8'));

    expect(context).toMatchObject({
      sessionId: 'addon-dev',
      repo: 'm2dw/demo-repo',
      issueNumber: 42,
      issueState: 'OPEN',
      labels: ['enhancement', 'agent:claude'],
      commentsIncluded: 2,
      commentsOmitted: 0,
      bodyTruncated: false,
    });
    expect(context.comments).toHaveLength(2);
  });

  test('the reader is only ever asked to read — no write methods exist', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    await capture(() => runIssueDiscussPreview(args, reader));

    expect(reader.calls).toEqual([{ method: 'readIssue', repo: 'm2dw/demo-repo', issueNumber: 42 }]);
    // The reader contract exposes a single read method; there is no post/label/state surface.
    expect(Object.keys(reader).filter((k) => k !== 'calls')).toEqual(['readIssue']);
  });

  test('a long body is truncated to a bounded size', async () => {
    const reader = makeReader({ ...SAMPLE_ISSUE, body: 'x'.repeat(20000) });
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '7', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));
    const context = JSON.parse(readFileSync(out.artifacts.context, 'utf8'));

    expect(out.bodyTruncated).toBe(true);
    expect(context.bodyTruncated).toBe(true);
    expect(context.body.length).toBeLessThan(20000);
    expect(context.body).toContain('truncated');
  });

  test('comments are bounded to the most recent N', async () => {
    const comments = Array.from({ length: 30 }, (_, i) => ({
      author: `user${i}`, body: `comment ${i}`, createdAt: `2026-01-${(i % 28) + 1}T00:00:00Z`,
    }));
    const reader = makeReader({ ...SAMPLE_ISSUE, comments });
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '9', '--comment-limit', '5', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));
    const context = JSON.parse(readFileSync(out.artifacts.context, 'utf8'));

    expect(out.commentsIncluded).toBe(5);
    expect(out.commentsOmitted).toBe(25);
    // Most-recent retained: comment 29 present, comment 0 dropped.
    expect(context.comments[context.comments.length - 1].body).toBe('comment 29');
    expect(context.comments.find((c) => c.body === 'comment 0')).toBeUndefined();
  });
});

describe('issue-discuss preview — admin CLI integration', () => {
  test('appears in admin help output', () => {
    const r = runAdmin('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('issue-discuss preview');
  });

  test('"help issue-discuss preview" documents required flags', () => {
    const r = runAdmin('help', 'issue-discuss', 'preview');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--session-id');
    expect(r.stdout).toContain('--issue-number');
  });

  test('missing --session-id exits non-zero', () => {
    const r = runAdmin('issue-discuss', 'preview', '--issue-number', '5', '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('missing --issue-number exits non-zero', () => {
    const r = runAdmin('issue-discuss', 'preview', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('unknown issue-discuss action exits non-zero', () => {
    const r = runAdmin('issue-discuss', 'bogus');
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });
});

describe('issue-discuss — isolation model (issue #245)', () => {
  // buildIsolatedEnv — unit tests proving the helper strips write-enabling vars.

  test('buildIsolatedEnv strips all WRITE_ENABLING_ENV_KEYS', () => {
    const dirty = {};
    for (const key of WRITE_ENABLING_ENV_KEYS) dirty[key] = 'secret-value';
    dirty['PATH'] = '/usr/bin';
    dirty['HOME'] = '/home/user';

    const clean = buildIsolatedEnv(dirty);

    for (const key of WRITE_ENABLING_ENV_KEYS) {
      expect(clean[key]).toBeUndefined();
    }
  });

  test('buildIsolatedEnv preserves non-write env vars', () => {
    const env = {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/user',
      LANG: 'en_US.UTF-8',
      GH_TOKEN: 'should-be-gone',
    };

    const clean = buildIsolatedEnv(env);

    expect(clean['PATH']).toBe('/usr/local/bin:/usr/bin');
    // HOME is redirected to an isolated temp dir to block the stored-credential
    // fallback path — it is intentionally not preserved.
    expect(clean['HOME']).not.toBe('/home/user');
    expect(clean['HOME']).toBeDefined();
    expect(clean['LANG']).toBe('en_US.UTF-8');
    expect(clean['GH_TOKEN']).toBeUndefined();
  });

  test('buildIsolatedEnv does not mutate the input env', () => {
    const env = { GH_TOKEN: 'secret', PATH: '/usr/bin' };
    buildIsolatedEnv(env);
    expect(env['GH_TOKEN']).toBe('secret');
  });

  test('buildIsolatedEnv sets GH_CONFIG_DIR to an empty temp directory', () => {
    const env = { PATH: '/usr/bin', HOME: '/home/user', GH_TOKEN: 'secret' };
    const clean = buildIsolatedEnv(env);

    expect(typeof clean['GH_CONFIG_DIR']).toBe('string');
    expect(clean['GH_CONFIG_DIR'].length).toBeGreaterThan(0);
    // Must be a real directory so gh cannot fall back to any other config path.
    expect(existsSync(clean['GH_CONFIG_DIR'])).toBe(true);
    // The dir must be empty — no hosts.yml or other credential files.
    expect(readdirSync(clean['GH_CONFIG_DIR'])).toHaveLength(0);
  });

  test('buildIsolatedEnv removes XDG_CONFIG_HOME to close secondary credential store path', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      XDG_CONFIG_HOME: '/home/user/.config',
      GH_TOKEN: 'secret',
    };
    const clean = buildIsolatedEnv(env);

    expect(clean['XDG_CONFIG_HOME']).toBeUndefined();
    // GH_CONFIG_DIR override must still be present.
    expect(clean['GH_CONFIG_DIR']).toBeDefined();
  });

  test('buildIsolatedEnv blocks stored-credential paths even when HOME is inherited', () => {
    // Simulate an env where HOME points at a real home dir (stored credentials live there).
    // A prompt-injected agent could override GH_CONFIG_DIR=$HOME/.config/gh or unset
    // GH_CONFIG_DIR before invoking gh, falling back to stored credentials under HOME.
    // Redirecting HOME to an empty temp dir closes that fallback path.
    const env = { HOME: process.env.HOME ?? '/root', PATH: '/usr/bin' };
    const clean = buildIsolatedEnv(env);

    // HOME must be redirected away from the caller's home directory.
    expect(clean['HOME']).not.toBe(env['HOME']);
    expect(clean['HOME']).toBeDefined();
    expect(clean['GH_CONFIG_DIR']).toBeDefined();
    expect(clean['GH_CONFIG_DIR']).not.toContain('.config/gh');
    // HOME and GH_CONFIG_DIR point to the same isolated temp dir so the
    // $HOME/.config/gh fallback also resolves to an empty directory.
    expect(clean['GH_CONFIG_DIR']).toBe(clean['HOME']);
  });

  test('buildIsolatedEnv strips inherited cwd-bearing env vars', () => {
    // PWD/INIT_CWD/OLDPWD inherited from a checkout would let untrusted issue
    // text instruct the tool-capable agent to `cd "$PWD"` back into the repo,
    // escaping the isolated temp cwd. They must be removed.
    const env = {
      PATH: '/usr/bin',
      PWD: '/home/user/checkout',
      OLDPWD: '/home/user',
      INIT_CWD: '/home/user/checkout',
    };
    const clean = buildIsolatedEnv(env);

    for (const key of CWD_BEARING_ENV_KEYS) {
      expect(clean[key]).toBeUndefined();
    }
    // Non-cwd vars are preserved.
    expect(clean['PATH']).toBe('/usr/bin');
  });

  test('CWD_BEARING_ENV_KEYS covers PWD and the npm-injected cwd vars', () => {
    const keys = [...CWD_BEARING_ENV_KEYS];
    expect(keys).toContain('PWD');
    expect(keys).toContain('INIT_CWD');
    expect(keys).toContain('OLDPWD');
  });

  test('WRITE_ENABLING_ENV_KEYS covers primary gh CLI token vars', () => {
    const keys = [...WRITE_ENABLING_ENV_KEYS];
    expect(keys).toContain('GH_TOKEN');
    expect(keys).toContain('GITHUB_TOKEN');
    expect(keys).toContain('GH_ENTERPRISE_TOKEN');
    expect(keys).toContain('ACTIONS_RUNTIME_TOKEN');
  });

  // Structural proof that the reader interface has no write surface.

  test('reader interface exposes only readIssue — no write surface exists', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    await capture(() => runIssueDiscussPreview(args, reader));

    const readMethods = Object.keys(reader).filter((k) => k !== 'calls');
    expect(readMethods).toEqual(['readIssue']);
    // Every call the reader received must be a read (readIssue), never a write.
    const nonReadCalls = reader.calls.filter((c) => c.method !== 'readIssue');
    expect(nonReadCalls).toHaveLength(0);
  });

  // Isolation metadata is present in both stdout and context artifact.

  test('stdout output includes isolation field with model and writeEnvKeysStripped', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));

    expect(out.isolation).toBeDefined();
    expect(out.isolation.model).toBe('token-stripped-agent-env');
    expect(Array.isArray(out.isolation.writeEnvKeysStripped)).toBe(true);
    expect(out.isolation.writeEnvKeysStripped).toContain('GH_TOKEN');
    expect(out.isolation.writeEnvKeysStripped).toContain('GITHUB_TOKEN');
    expect(out.isolation.readerMode).toBe('read-only-by-construction');
  });

  test('context artifact includes isolation field', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));
    const context = JSON.parse(readFileSync(out.artifacts.context, 'utf8'));

    expect(context.isolation).toBeDefined();
    expect(context.isolation.model).toBe('token-stripped-agent-env');
    expect(context.isolation.posted).toBe(false);
    expect(context.isolation.writeEnvKeysStripped).toContain('GH_TOKEN');
    expect(context.isolation.readerMode).toBe('read-only-by-construction');
  });

  test('posted is always false — generated output is never auto-posted', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '99', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));

    expect(out.posted).toBe(false);
    const context = JSON.parse(readFileSync(out.artifacts.context, 'utf8'));
    expect(context.isolation.posted).toBe(false);
  });

  test('failure to read issue is fail-closed and reported as JSON', async () => {
    const throwingReader = {
      readIssue() {
        throw new Error('simulated network failure');
      },
    };
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '7', '--sessions-path', sessionsPath]);

    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    let exitCode = null;
    const origExit = process.exit.bind(process);
    process.exit = (code) => { exitCode = code; throw new Error('process.exit intercepted'); };
    try {
      await runIssueDiscussPreview(args, throwingReader);
    } catch {
      // expected — we intercepted process.exit
    } finally {
      process.stdout.write = orig;
      process.exit = origExit;
    }

    const output = JSON.parse(chunks.join('').trim());
    expect(output.ok).toBe(false);
    expect(output.error).toContain('simulated network failure');
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// issue-discuss preview — fingerprint emitted
// ---------------------------------------------------------------------------

describe('issue-discuss preview — fingerprint', () => {
  test('preview emits a fingerprint and stores it in the context JSON', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));

    expect(typeof out.fingerprint).toBe('string');
    expect(out.fingerprint).toHaveLength(64); // SHA-256 hex

    const context = JSON.parse(readFileSync(out.artifacts.context, 'utf8'));
    expect(context.fingerprint).toBe(out.fingerprint);
  });

  test('fingerprint changes when issue state changes', () => {
    const base = { sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 42, title: 'T', labels: [], body: 'B', comments: [] };
    const fp1 = computeFingerprint({ ...base, issueState: 'OPEN' });
    const fp2 = computeFingerprint({ ...base, issueState: 'CLOSED' });
    expect(fp1).not.toBe(fp2);
  });

  test('fingerprint is stable regardless of label insertion order', () => {
    const base = { sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 42, issueState: 'OPEN', title: 'T', body: 'B', comments: [] };
    const fp1 = computeFingerprint({ ...base, labels: ['b', 'a'] });
    const fp2 = computeFingerprint({ ...base, labels: ['a', 'b'] });
    expect(fp1).toBe(fp2);
  });

  test('fingerprint changes when comments change', () => {
    const base = { sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 42, issueState: 'OPEN', title: 'T', labels: [], body: 'B' };
    const fp1 = computeFingerprint({ ...base, comments: [] });
    const fp2 = computeFingerprint({ ...base, comments: [{ author: 'alice', body: 'hi', createdAt: '2026-01-01T00:00:00Z' }] });
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// issue-discuss post — argument parsing (pure function, no process.exit risk)
// ---------------------------------------------------------------------------

describe('issue-discuss post — argument parsing', () => {
  test('missing --session-id is rejected', () => {
    const r = parseIssueDiscussPostArgs(['--issue-number', '5', '--artifact', '/a.json', '--approve', 'tok']);
    expect(r).toMatchObject({ error: expect.stringContaining('session-id') });
  });

  test('missing --issue-number is rejected', () => {
    const r = parseIssueDiscussPostArgs(['--session-id', 'addon-dev', '--artifact', '/a.json', '--approve', 'tok']);
    expect(r).toMatchObject({ error: expect.stringContaining('issue-number') });
  });

  test('missing --artifact is rejected', () => {
    const r = parseIssueDiscussPostArgs(['--session-id', 'addon-dev', '--issue-number', '5', '--approve', 'tok']);
    expect(r).toMatchObject({ error: expect.stringContaining('artifact') });
  });

  test('missing --approve is rejected', () => {
    const r = parseIssueDiscussPostArgs(['--session-id', 'addon-dev', '--issue-number', '5', '--artifact', '/a.json']);
    expect(r).toMatchObject({ error: expect.stringContaining('approve') });
  });

  test('valid args parse correctly', () => {
    const r = parseIssueDiscussPostArgs([
      '--session-id', 'addon-dev', '--issue-number', '42', '--artifact', '/path/ctx.json', '--approve', 'abc123',
    ]);
    expect(r).toMatchObject({ sessionId: 'addon-dev', issueNumber: 42, artifactPath: '/path/ctx.json', approveToken: 'abc123' });
  });
});

// ---------------------------------------------------------------------------
// issue-discuss post — unit tests
//
// die() calls process.exit(), which would kill Jest. We replace process.exit
// with a throwing stub for the duration of each test in these describe blocks
// and restore it afterwards. Capturing stdout before the throw lets us inspect
// the JSON error payload that die() emits before exiting.
// ---------------------------------------------------------------------------

// Fake poster that records calls without hitting GitHub.
function makePoster() {
  const calls = [];
  return {
    calls,
    postComment(repo, issueNumber, body) {
      calls.push({ repo, issueNumber, body });
    },
  };
}

// Captures stdout emitted by fn() whether it succeeds or dies (process.exit
// replaced with a throw). Returns { output, threw } so tests can assert both.
async function captureRun(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  } finally {
    process.stdout.write = orig;
  }
  const raw = chunks.join('').trim();
  const output = raw ? JSON.parse(raw) : null;
  return { threw, output };
}

// Build a full preview + optional draft for a given issue, returning the
// context path, fingerprint, and a helper to run the post step.
async function setupPost({ issueForPreview, issueForPost, approveOverride, draftContent, poster }) {
  const reader = makeReader(issueForPreview);
  const previewArgs = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
  const { output: previewOut } = await captureRun(() => runIssueDiscussPreview(previewArgs, reader));

  const contextPath = previewOut.artifacts.context;
  const draftPath = previewOut.artifacts.draft;
  if (draftContent !== undefined) {
    writeFileSync(draftPath, draftContent, 'utf8');
  }

  const postArgs = parseIssueDiscussPostArgs([
    '--session-id', 'addon-dev',
    '--issue-number', '42',
    '--artifact', contextPath,
    '--approve', approveOverride ?? previewOut.fingerprint,
    '--sessions-path', sessionsPath,
  ]);

  const liveReader = issueForPost !== undefined ? makeReader(issueForPost) : reader;
  return { previewOut, postArgs, draftPath, run: () => captureRun(() => runIssueDiscussPost(postArgs, liveReader, poster)) };
}

describe('issue-discuss post — successful post', () => {
  let exitSpy;
  beforeEach(() => { exitSpy = jest.spyOn(process, 'exit').mockImplementation((c) => { throw new Error(`exit(${c})`); }); });
  afterEach(() => { exitSpy.mockRestore(); });

  test('posts the draft and emits ok:true', async () => {
    const poster = makePoster();
    const { run } = await setupPost({ issueForPreview: SAMPLE_ISSUE, draftContent: '# Draft\n\nReviewed.', poster });
    const { threw, output } = await run();

    expect(threw).toBe(false);
    expect(output).toMatchObject({ ok: true, posted: true, sessionId: 'addon-dev', issueNumber: 42 });
    expect(typeof output.fingerprint).toBe('string');
    expect(output.fingerprint).toHaveLength(64);
    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]).toMatchObject({ repo: 'm2dw/demo-repo', issueNumber: 42, body: '# Draft\n\nReviewed.' });
  });

  test('draft is posted verbatim and trimmed of surrounding whitespace', async () => {
    const poster = makePoster();
    const { run } = await setupPost({ issueForPreview: SAMPLE_ISSUE, draftContent: '  Hello world.  \n', poster });
    const { threw } = await run();

    expect(threw).toBe(false);
    expect(poster.calls[0].body).toBe('Hello world.');
  });

  test('does not re-invoke any agent: poster records exactly one call', async () => {
    const poster = makePoster();
    const { run } = await setupPost({ issueForPreview: SAMPLE_ISSUE, draftContent: 'Draft.', poster });
    await run();
    expect(poster.calls).toHaveLength(1);
  });
});

describe('issue-discuss post — stale issue detection', () => {
  let exitSpy;
  beforeEach(() => { exitSpy = jest.spyOn(process, 'exit').mockImplementation((c) => { throw new Error(`exit(${c})`); }); });
  afterEach(() => { exitSpy.mockRestore(); });

  test('refuses when issue state changed since preview', async () => {
    const poster = makePoster();
    const { run } = await setupPost({
      issueForPreview: SAMPLE_ISSUE,
      issueForPost: { ...SAMPLE_ISSUE, state: 'CLOSED' },
      draftContent: 'Draft.',
      poster,
    });
    const { threw, output } = await run();
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });

  test('refuses when issue body changed since preview', async () => {
    const poster = makePoster();
    const { run } = await setupPost({
      issueForPreview: SAMPLE_ISSUE,
      issueForPost: { ...SAMPLE_ISSUE, body: 'Body was edited after preview.' },
      draftContent: 'Draft.',
      poster,
    });
    const { threw, output } = await run();
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });

  test('refuses when a new comment appeared since preview', async () => {
    const poster = makePoster();
    const extraComment = { author: 'carol', body: 'New comment.', createdAt: '2026-02-01T00:00:00Z' };
    const { run } = await setupPost({
      issueForPreview: SAMPLE_ISSUE,
      issueForPost: { ...SAMPLE_ISSUE, comments: [...SAMPLE_ISSUE.comments, extraComment] },
      draftContent: 'Draft.',
      poster,
    });
    const { threw, output } = await run();
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });

  test('refuses when labels changed since preview', async () => {
    const poster = makePoster();
    const { run } = await setupPost({
      issueForPreview: SAMPLE_ISSUE,
      issueForPost: { ...SAMPLE_ISSUE, labels: [...SAMPLE_ISSUE.labels, 'new-label'] },
      draftContent: 'Draft.',
      poster,
    });
    const { threw, output } = await run();
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });
});

describe('issue-discuss post — artifact / session mismatch', () => {
  let exitSpy;
  beforeEach(() => { exitSpy = jest.spyOn(process, 'exit').mockImplementation((c) => { throw new Error(`exit(${c})`); }); });
  afterEach(() => { exitSpy.mockRestore(); });

  test('refuses when artifact issueNumber does not match --issue-number', async () => {
    const poster = makePoster();
    // Preview for issue 42, but post with --issue-number 99.
    const reader = makeReader(SAMPLE_ISSUE);
    const previewArgs = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const { output: previewOut } = await captureRun(() => runIssueDiscussPreview(previewArgs, reader));

    writeFileSync(previewOut.artifacts.draft, 'Draft.', 'utf8');

    const postArgs = parseIssueDiscussPostArgs([
      '--session-id', 'addon-dev', '--issue-number', '99',
      '--artifact', previewOut.artifacts.context,
      '--approve', previewOut.fingerprint,
      '--sessions-path', sessionsPath,
    ]);
    const { threw, output } = await captureRun(() => runIssueDiscussPost(postArgs, reader, poster));
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false, error: expect.stringContaining('mismatch') });
    expect(poster.calls).toHaveLength(0);
  });

  test('refuses when artifact sessionId does not match --session-id', async () => {
    const poster = makePoster();
    const reader = makeReader(SAMPLE_ISSUE);
    const previewArgs = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const { output: previewOut } = await captureRun(() => runIssueDiscussPreview(previewArgs, reader));

    // Tamper the context JSON to a different sessionId.
    const ctx = JSON.parse(readFileSync(previewOut.artifacts.context, 'utf8'));
    ctx.sessionId = 'other-session';
    writeFileSync(previewOut.artifacts.context, JSON.stringify(ctx), 'utf8');

    writeFileSync(previewOut.artifacts.draft, 'Draft.', 'utf8');

    const postArgs = parseIssueDiscussPostArgs([
      '--session-id', 'addon-dev', '--issue-number', '42',
      '--artifact', previewOut.artifacts.context,
      '--approve', previewOut.fingerprint,
      '--sessions-path', sessionsPath,
    ]);
    const { threw, output } = await captureRun(() => runIssueDiscussPost(postArgs, reader, poster));
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false, error: expect.stringContaining('mismatch') });
    expect(poster.calls).toHaveLength(0);
  });

  test('refuses when --approve token does not match the stored fingerprint', async () => {
    const poster = makePoster();
    const { run } = await setupPost({
      issueForPreview: SAMPLE_ISSUE,
      approveOverride: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      draftContent: 'Draft.',
      poster,
    });
    const { threw, output } = await run();
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false, error: expect.stringContaining('fingerprint') });
    expect(poster.calls).toHaveLength(0);
  });
});

describe('issue-discuss post — missing or empty draft', () => {
  let exitSpy;
  beforeEach(() => { exitSpy = jest.spyOn(process, 'exit').mockImplementation((c) => { throw new Error(`exit(${c})`); }); });
  afterEach(() => { exitSpy.mockRestore(); });

  test('refuses when the fingerprint-namespaced draft file does not exist', async () => {
    const poster = makePoster();
    const { run } = await setupPost({ issueForPreview: SAMPLE_ISSUE, poster }); // no draftContent
    const { threw, output } = await run();
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });

  test('refuses when draft file exists but is blank', async () => {
    const poster = makePoster();
    const { run } = await setupPost({ issueForPreview: SAMPLE_ISSUE, draftContent: '   \n  ', poster });
    const { threw, output } = await run();
    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// issue-discuss post — admin CLI integration (subprocess, no GitHub needed)
// ---------------------------------------------------------------------------

describe('issue-discuss post — admin CLI integration', () => {
  test('"issue-discuss post" appears in admin help output', () => {
    const r = runAdmin('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('issue-discuss post');
  });

  test('"help issue-discuss post" documents --artifact and --approve', () => {
    const r = runAdmin('help', 'issue-discuss', 'post');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--artifact');
    expect(r.stdout).toContain('--approve');
    expect(r.stdout).toContain('--session-id');
    expect(r.stdout).toContain('--issue-number');
  });

  test('missing --artifact exits non-zero with descriptive error', () => {
    const r = runAdmin('issue-discuss', 'post',
      '--session-id', 'addon-dev', '--issue-number', '5', '--approve', 'tok',
      '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('artifact') });
  });

  test('missing --approve exits non-zero with descriptive error', () => {
    const r = runAdmin('issue-discuss', 'post',
      '--session-id', 'addon-dev', '--issue-number', '5', '--artifact', '/x.json',
      '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('approve') });
  });

  test('wrong --approve token exits non-zero (fails before GitHub)', () => {
    // Build a real context.json manually with a known fingerprint.
    const fingerprint = computeFingerprint({
      sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 42,
      issueState: 'OPEN', title: 'T', labels: [], body: 'B', comments: [],
    });
    const contextPath = join(tmpDir, 'ctx.json');
    writeFileSync(contextPath, JSON.stringify({
      sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 42,
      issueState: 'OPEN', title: 'T', labels: [], body: 'B',
      commentLimit: 10, comments: [], fingerprint,
      generatedAt: new Date().toISOString(),
    }), 'utf8');

    const r = runAdmin('issue-discuss', 'post',
      '--session-id', 'addon-dev', '--issue-number', '42',
      '--artifact', contextPath,
      '--approve', 'wrong-token',
      '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('fingerprint') });
  });

  test('unknown issue-discuss action still rejects', () => {
    const r = runAdmin('issue-discuss', 'bogus');
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });
});

// ---------------------------------------------------------------------------
// issue-discuss post — draft bound to fingerprint (P1 safety)
// ---------------------------------------------------------------------------

describe('issue-discuss post — draft bound to preview fingerprint', () => {
  let exitSpy;
  beforeEach(() => { exitSpy = jest.spyOn(process, 'exit').mockImplementation((c) => { throw new Error(`exit(${c})`); }); });
  afterEach(() => { exitSpy.mockRestore(); });

  test('preview emits draft path in artifacts and it is fingerprint-namespaced', async () => {
    const reader = makeReader(SAMPLE_ISSUE);
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssueDiscussPreview(args, reader));

    expect(out.artifacts.draft).toBeDefined();
    expect(out.artifacts.draft).toContain(out.fingerprint);
    expect(out.artifacts.draft).toContain('issue-discuss-draft-');
  });

  test('refuses to use a stale draft from an earlier preview run', async () => {
    const poster = makePoster();
    const args = parseIssueDiscussArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);

    // First preview: write a draft for its fingerprint
    const reader1 = makeReader(SAMPLE_ISSUE);
    const { output: preview1 } = await captureRun(() => runIssueDiscussPreview(args, reader1));
    writeFileSync(preview1.artifacts.draft, 'Stale draft from first preview.', 'utf8');

    // Second preview with changed issue state (produces a different fingerprint)
    const changedIssue = { ...SAMPLE_ISSUE, state: 'CLOSED' };
    const reader2 = makeReader(changedIssue);
    const { output: preview2 } = await captureRun(() => runIssueDiscussPreview(args, reader2));
    expect(preview1.fingerprint).not.toBe(preview2.fingerprint);

    // Post with the second preview's approve token — no draft exists for fp2
    const postArgs = parseIssueDiscussPostArgs([
      '--session-id', 'addon-dev', '--issue-number', '42',
      '--artifact', preview2.artifacts.context,
      '--approve', preview2.fingerprint,
      '--sessions-path', sessionsPath,
    ]);
    const { threw, output } = await captureRun(() => runIssueDiscussPost(postArgs, reader2, poster));

    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// issue-discuss post — fingerprint covers untruncated content (P2 safety)
// ---------------------------------------------------------------------------

describe('issue-discuss post — fingerprint covers full untruncated content', () => {
  let exitSpy;
  beforeEach(() => { exitSpy = jest.spyOn(process, 'exit').mockImplementation((c) => { throw new Error(`exit(${c})`); }); });
  afterEach(() => { exitSpy.mockRestore(); });

  test('refuses when issue body was edited beyond the truncation boundary since preview', async () => {
    const poster = makePoster();
    // Body exceeds MAX_BODY_CHARS (8000). The suffix beyond the limit is edited.
    const prefix = 'A'.repeat(8000);
    const issueForPreview = { ...SAMPLE_ISSUE, body: prefix + ' original tail' };
    const issueForPost   = { ...SAMPLE_ISSUE, body: prefix + ' EDITED tail' };

    const { run } = await setupPost({ issueForPreview, issueForPost, draftContent: 'Draft.', poster });
    const { threw, output } = await run();

    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });

  test('refuses when a comment body was edited beyond the truncation boundary since preview', async () => {
    const poster = makePoster();
    // Comment body exceeds MAX_COMMENT_CHARS (2000). The suffix is edited.
    const commentPrefix = 'C'.repeat(2000);
    const issueForPreview = {
      ...SAMPLE_ISSUE,
      comments: [{ author: 'alice', body: commentPrefix + ' original', createdAt: '2026-01-01T00:00:00Z' }],
    };
    const issueForPost = {
      ...SAMPLE_ISSUE,
      comments: [{ author: 'alice', body: commentPrefix + ' EDITED', createdAt: '2026-01-01T00:00:00Z' }],
    };

    const { run } = await setupPost({ issueForPreview, issueForPost, draftContent: 'Draft.', poster });
    const { threw, output } = await run();

    expect(threw).toBe(true);
    expect(output).toMatchObject({ ok: false });
    expect(poster.calls).toHaveLength(0);
  });
});
