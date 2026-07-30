import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createContentDraftHandler } from '../dist/handlers/content-draft.js';
import { SqliteTaskStore } from '../dist/index.js';
import { runNextPhase } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let artifactRoot;
let researchArtifactDir;

const SESSION = (overrides = {}) => ({
  sessionId: 'content-dev',
  repoKey: 'test-repo',
  repoRoot,
  githubRepo: 'm2dw/test-repo',
  artifactDir: '.n8n-artifacts',
  artifactRoot,
  githubOwner: 'm2dw',
  githubName: 'test-repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  ...overrides,
});

const CONTEXT = (overrides = {}) => ({
  session: SESSION(),
  runId: 'run-draft-1',
  workerId: 'worker-draft',
  ...overrides,
});

function writeResearchArtifacts(dir, { outcome = 'valid', success = true, content = 'Research findings: performance tuning tips.' } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'content-research-result.json'),
    JSON.stringify({ outcome, success, issueNumber: 77, sessionId: 'content-dev', runId: 'run-research-1' }),
    'utf8',
  );
  writeFileSync(join(dir, 'content-research-output.md'), content, 'utf8');
  // validated brief is only present when the research outcome is valid/success
  if (outcome === 'valid' && success) {
    writeFileSync(join(dir, 'content-research-validated-brief.md'), content, 'utf8');
  }
}

const fakeOk = (stdout = 'Draft content: here is the article.\n\n## Self-Review\nNo issues found.') => ({
  run: (_cmd, _args, opts) => ({
    stdout,
    stderr: '',
    exitCode: 0,
    calledWith: { cwd: opts.cwd },
  }),
});

const fakeFail = (stderr = 'agy: command not found') => ({
  run: (_cmd, _args, opts) => ({
    stdout: '',
    stderr,
    exitCode: 127,
    calledWith: { cwd: opts.cwd },
  }),
});

function spyRunner(result = { stdout: 'draft ok', stderr: '', exitCode: 0 }) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return result;
    },
  };
}

function makeTask(overrides = {}) {
  return {
    sessionId: 'content-dev',
    issueNumber: 77,
    status: 'running',
    phase: 'content_draft',
    priority: 'normal',
    researchAgent: 'gemini',
    attempts: {},
    context: {
      title: 'Write a blog post about performance tuning',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:gemini', 'status:content-needed'],
      artifactDir: researchArtifactDir,
    },
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'content-draft-handler-test-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  researchArtifactDir = join(artifactRoot, 'runs', 'run-research-1');
  writeResearchArtifacts(researchArtifactDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Artifact paths
// ---------------------------------------------------------------------------

describe('content-draft handler — artifacts', () => {
  test('creates artifact dir under artifactRoot/runs/<runId>', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-draft-1'))).toBe(true);
  });

  test('writes content-draft-prompt.md, content-draft-output.md, content-draft-result.json', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk('the draft\n\n## Self-Review\nno issues'));
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-draft-1');
    expect(existsSync(join(dir, 'content-draft-prompt.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-draft-output.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-draft-result.json'))).toBe(true);
  });

  test('writes content-draft-context.json (pre-run audit)', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-draft-1');
    expect(existsSync(join(dir, 'content-draft-context.json'))).toBe(true);
  });

  test('content-draft-context.json contains resolvedProfile with phase content_draft and agentId', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'content_draft', agentId: 'gemini' });
  });

  test('content-draft-context.json exists even on agent failure (pre-run audit)', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-context.json'))).toBe(true);
  });

  test('artifacts are written even on command failure', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-draft-1');
    expect(existsSync(join(dir, 'content-draft-output.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-draft-result.json'))).toBe(true);
  });

  test('content-draft-output.md contains command stdout', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk('the article draft content here'));
    await handler(makeTask());
    const output = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-output.md'), 'utf8');
    expect(output).toContain('the article draft content here');
  });

  test('a successful run with stderr warnings keeps stderr out of content-draft-output.md', async () => {
    const runner = {
      run: (_cmd, _args, opts) => ({
        stdout: 'the article draft content here',
        stderr: 'warning: deprecated flag used',
        exitCode: 0,
        calledWith: { cwd: opts.cwd },
      }),
    };
    const handler = createContentDraftHandler(CONTEXT(), runner);
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-draft-1');
    const output = readFileSync(join(dir, 'content-draft-output.md'), 'utf8');
    expect(output).toBe('the article draft content here');
    expect(output).not.toContain('warning: deprecated flag used');
    const diagnostic = readFileSync(join(dir, 'content-draft-diagnostic.md'), 'utf8');
    expect(diagnostic).toContain('warning: deprecated flag used');
  });
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe('content-draft handler — prompt construction', () => {
  test('content-draft-prompt.md includes issue number and title', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-prompt.md'), 'utf8');
    expect(prompt).toContain('77');
    expect(prompt).toContain('Write a blog post about performance tuning');
  });

  test('content-draft-prompt.md includes research findings delimited section', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-prompt.md'), 'utf8');
    expect(prompt).toMatch(/begin:research-brief-input/);
    expect(prompt).toMatch(/end:research-brief-input/);
    expect(prompt).toContain('Research findings: performance tuning tips.');
  });

  test('content-draft-prompt.md includes issue body as bounded delimited input', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask({
      context: {
        title: 'Write a blog post',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: [],
        body: 'This body text must appear in the draft prompt.',
        artifactDir: researchArtifactDir,
      },
    }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-prompt.md'), 'utf8');
    expect(prompt).toContain('This body text must appear');
    expect(prompt).toMatch(/begin:issue-body-input/);
    expect(prompt).toMatch(/end:issue-body-input/);
  });

  test('content-draft-prompt.md includes phase contract guardrails', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-prompt.md'), 'utf8');
    expect(prompt).toContain('Do NOT modify any files');
    expect(prompt).toContain('uncertain claims');
    expect(prompt).toContain('human editor');
  });

  test('content-draft-prompt.md requests title suggestions, summary, and main body', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-prompt.md'), 'utf8');
    expect(prompt).toContain('Title suggestions');
    expect(prompt).toContain('Summary');
    expect(prompt).toContain('Main body');
  });

  test('does NOT include research stderr in the prompt (sanitization)', async () => {
    // The validated brief contains only clean stdout; output.md may contain stderr.
    // Verify the prompt uses only the validated brief, not the raw output.
    writeFileSync(
      join(researchArtifactDir, 'content-research-validated-brief.md'),
      'clean research content',
      'utf8',
    );
    writeFileSync(
      join(researchArtifactDir, 'content-research-output.md'),
      'clean research content\n--- stderr ---\nsecret error token=ghp_SECRET',
      'utf8',
    );
    const spy = spyRunner();
    const handler = createContentDraftHandler(CONTEXT(), spy);
    await handler(makeTask());
    const promptArg = spy.calls[0].args[spy.calls[0].args.length - 1];
    expect(promptArg).toContain('clean research content');
    expect(promptArg).not.toContain('secret error token=ghp_SECRET');
    expect(promptArg).not.toContain('--- stderr ---');
  });

  test('body is truncated at BODY_CHAR_LIMIT characters', async () => {
    const longBody = 'x'.repeat(5000);
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask({
      context: {
        title: 'T',
        url: null,
        labels: [],
        body: longBody,
        artifactDir: researchArtifactDir,
      },
    }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-prompt.md'), 'utf8');
    expect(prompt).toContain('body truncated');
  });

  test('includes Previous Review Feedback section when reviewFixFeedback is in context', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask({
      context: {
        title: 'Write a blog post',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: [],
        artifactDir: researchArtifactDir,
        reviewFixFeedback: 'BLOCKING: The claim about 10x speed is unsupported.',
      },
    }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-prompt.md'), 'utf8');
    expect(prompt).toContain('Previous Review Feedback');
    expect(prompt).toContain('BLOCKING: The claim about 10x speed is unsupported.');
    expect(prompt).toMatch(/begin:review-fix-feedback-input/);
  });

  test('does NOT include Previous Review Feedback section when reviewFixFeedback absent', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-prompt.md'), 'utf8');
    expect(prompt).not.toContain('Previous Review Feedback');
    expect(prompt).not.toContain('review-fix-feedback-input');
  });
});

// ---------------------------------------------------------------------------
// Research brief input validation (input_invalid)
// ---------------------------------------------------------------------------

describe('content-draft handler — research brief validation', () => {
  test('returns failed with input_invalid when task has no artifactDir in context', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask({ context: { title: 'T', labels: [] } }));
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/input_invalid/);
  });

  test('returns failed with input_invalid when research result artifact is missing', async () => {
    rmSync(join(researchArtifactDir, 'content-research-result.json'));
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/input_invalid/);
  });

  test('returns failed with input_invalid when research result artifact is malformed JSON', async () => {
    writeFileSync(join(researchArtifactDir, 'content-research-result.json'), 'not json', 'utf8');
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/input_invalid/);
  });

  test('returns failed with input_invalid when research outcome is not valid', async () => {
    writeFileSync(
      join(researchArtifactDir, 'content-research-result.json'),
      JSON.stringify({ outcome: 'malformed', success: false }),
      'utf8',
    );
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/input_invalid/);
  });

  test('returns failed with input_invalid when research validated brief is missing', async () => {
    rmSync(join(researchArtifactDir, 'content-research-validated-brief.md'));
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/input_invalid/);
  });

  test('returns failed with input_invalid when research validated brief is empty', async () => {
    writeFileSync(join(researchArtifactDir, 'content-research-validated-brief.md'), '   ', 'utf8');
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/input_invalid/);
  });

  test('writes content-draft-result.json with input_invalid outcome before returning', async () => {
    rmSync(join(researchArtifactDir, 'content-research-validated-brief.md'));
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const resultPath = join(artifactRoot, 'runs', 'run-draft-1', 'content-draft-result.json');
    expect(existsSync(resultPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(artifact.outcome).toBe('input_invalid');
    expect(artifact.success).toBe(false);
  });

  test('context includes outcome:input_invalid on research validation failure', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask({ context: { title: 'T', labels: [] } }));
    expect(result.context?.outcome).toBe('input_invalid');
  });

  test('agent is NOT invoked when research brief is invalid', async () => {
    const spy = spyRunner();
    const handler = createContentDraftHandler(CONTEXT(), spy);
    await handler(makeTask({ context: { title: 'T', labels: [] } }));
    expect(spy.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Isolated cwd — the agent does NOT run in session.repoRoot
// ---------------------------------------------------------------------------

describe('content-draft handler — isolated execution cwd', () => {
  test('does NOT pass session.repoRoot as cwd to the command runner', async () => {
    const spy = spyRunner();
    const handler = createContentDraftHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].opts.cwd).not.toBe(repoRoot);
  });

  test('uses the per-run artifact directory as the agent cwd', async () => {
    const spy = spyRunner();
    const handler = createContentDraftHandler(CONTEXT(), spy);
    await handler(makeTask());
    const cwd = spy.calls[0].opts.cwd;
    const expectedArtifactDir = join(artifactRoot, 'runs', 'run-draft-1');
    expect(cwd).toBe(expectedArtifactDir);
  });
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

describe('content-draft handler — command execution', () => {
  test('uses ANTIGRAVITY_BIN env var when set', async () => {
    const spy = spyRunner();
    process.env['ANTIGRAVITY_BIN'] = '/usr/local/bin/custom-agy';
    try {
      const handler = createContentDraftHandler(CONTEXT(), spy);
      await handler(makeTask());
      expect(spy.calls[0].cmd).toBe('/usr/local/bin/custom-agy');
    } finally {
      delete process.env['ANTIGRAVITY_BIN'];
    }
  });

  test('falls back to "agy" when ANTIGRAVITY_BIN is not set', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentDraftHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].cmd).toBe('agy');
  });

  test('passes --print as first arg', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentDraftHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].args[0]).toBe('--print');
  });

  test('passes the prompt as the final positional arg and via stdin', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentDraftHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].args).toHaveLength(2);
    expect(spy.calls[0].args[0]).toBe('--print');
    expect(spy.calls[0].args[1]).toContain('Content Draft Task');
    expect(typeof spy.calls[0].opts.stdin).toBe('string');
    expect(spy.calls[0].opts.stdin).toContain('Content Draft Task');
  });

  test('configured model: passes --model before --print', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const session = SESSION({ research: { antigravity: { model: 'Gemini 3.1 Pro (Low)' } } });
    const handler = createContentDraftHandler(CONTEXT({ session }), spy);
    await handler(makeTask());
    expect(spy.calls[0].args[0]).toBe('--model');
    expect(spy.calls[0].args[1]).toBe('Gemini 3.1 Pro (Low)');
    expect(spy.calls[0].args[2]).toBe('--print');
  });
});

// ---------------------------------------------------------------------------
// Result states
// ---------------------------------------------------------------------------

describe('content-draft handler — PhaseHandlerResult', () => {
  test('returns success on exit code 0 with non-empty output', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk('the draft\n\n## Self-Review\nno issues'));
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
  });

  test('returns failed on non-zero exit', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeFail('network error'));
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
  });

  test('success result includes artifactDir in context', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(result.context?.artifactDir).toContain('run-draft-1');
  });

  test('success result includes contentDraftAgentUsed in context', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(result.context?.contentDraftAgentUsed).toBe('gemini');
  });
});

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

describe('content-draft handler — outcome classification', () => {
  const dir = () => join(artifactRoot, 'runs', 'run-draft-1');

  test('outcome is "draft_complete" when exit 0 and non-empty output', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk('draft content\n\n## Self-Review\nno issues'));
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'content-draft-result.json'), 'utf8'));
    expect(result.outcome).toBe('draft_complete');
    expect(result.success).toBe(true);
  });

  test('outcome is "draft_failed" when exit 0 but empty output', async () => {
    const runner = { run: () => ({ stdout: '', stderr: '', exitCode: 0 }) };
    const handler = createContentDraftHandler(CONTEXT(), runner);
    const phaseResult = await handler(makeTask());
    expect(phaseResult.result).toBe('failed');
    const artifact = JSON.parse(readFileSync(join(dir(), 'content-draft-result.json'), 'utf8'));
    expect(artifact.outcome).toBe('draft_failed');
    expect(artifact.success).toBe(false);
  });

  test('outcome is "draft_failed" when exit non-zero', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeFail('error'));
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'content-draft-result.json'), 'utf8'));
    expect(result.outcome).toBe('draft_failed');
    expect(result.success).toBe(false);
  });

  test('outcome is "draft_failed" (delayed) for quota signal', async () => {
    const quotaRunner = {
      run: () => ({
        stdout: '',
        stderr: 'Error: Resource exhausted: Quota exceeded for quota',
        exitCode: 1,
      }),
    };
    const handler = createContentDraftHandler(CONTEXT(), quotaRunner);
    const phaseResult = await handler(makeTask());
    expect(phaseResult.result).toBe('delayed');
    // Category and retry metadata survive onto the handler result (issue #672).
    expect(phaseResult.category).toBe('usage_quota');
    expect(phaseResult.context.category).toBe('usage_quota');
    const artifact = JSON.parse(readFileSync(join(dir(), 'content-draft-result.json'), 'utf8'));
    expect(artifact.outcome).toBe('draft_failed');
    expect(artifact.success).toBe(false);
    expect(artifact.delayed).toBe(true);
  });

  test('delayed context preserves research artifactDir and stores draft path under draftArtifactDir', async () => {
    const quotaRunner = {
      run: () => ({
        stdout: '',
        stderr: 'Error: Resource exhausted: Quota exceeded for quota',
        exitCode: 1,
      }),
    };
    const handler = createContentDraftHandler(CONTEXT(), quotaRunner);
    const phaseResult = await handler(makeTask());
    expect(phaseResult.result).toBe('delayed');
    // research artifact dir must be preserved so resolveResearchBrief succeeds on retry
    expect(phaseResult.context?.artifactDir).toBe(researchArtifactDir);
    // draft run dir is stored separately — not mixed into the research path
    expect(phaseResult.context?.draftArtifactDir).toContain('run-draft-1');
    expect(phaseResult.context?.draftArtifactDir).not.toBe(researchArtifactDir);
  });

  test('invalid output never leaves the artifact marked successful', async () => {
    const runner = { run: () => ({ stdout: '   ', stderr: '', exitCode: 0 }) };
    const handler = createContentDraftHandler(CONTEXT(), runner);
    await handler(makeTask());
    const artifact = JSON.parse(readFileSync(join(dir(), 'content-draft-result.json'), 'utf8'));
    expect(artifact.success).toBe(false);
  });

  test('content-draft-result.json includes resolvedProfile on success', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'content-draft-result.json'), 'utf8'));
    expect(result.resolvedProfile).toMatchObject({ phase: 'content_draft', agentId: 'gemini' });
  });
});

// ---------------------------------------------------------------------------
// Public-safe errors — raw stderr never in result.error
// ---------------------------------------------------------------------------

describe('content-draft handler — public-safe errors', () => {
  test('failed result.error does not contain raw stderr', async () => {
    const secretStderr = 'secret_token=ghp_XXXXXXXXXXX and error: internal path /home/user/secret';
    const runner = {
      run: () => ({ stdout: '', stderr: secretStderr, exitCode: 1 }),
    };
    const handler = createContentDraftHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).not.toContain('secret_token');
    expect(result.error).not.toContain('ghp_XXXXXXXXXXX');
    expect(result.error).not.toContain('/home/user/secret');
  });

  test('secret-looking stderr is retained only in local diagnostic artifact, not the validated draft output', async () => {
    const secretStderr = 'token: ghp_ABCDEF12345 at /private/runs/xyz';
    const runner = {
      run: () => ({ stdout: '', stderr: secretStderr, exitCode: 1 }),
    };
    const handler = createContentDraftHandler(CONTEXT(), runner);
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-draft-1');
    const output = readFileSync(join(dir, 'content-draft-output.md'), 'utf8');
    expect(output).not.toContain(secretStderr);
    const diagnostic = readFileSync(join(dir, 'content-draft-diagnostic.md'), 'utf8');
    expect(diagnostic).toContain(secretStderr);
  });

  test('command-failure result.error is a fixed public-safe message', async () => {
    const handler = createContentDraftHandler(CONTEXT(), fakeFail('crash dump with secrets'));
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).not.toContain('crash dump with secrets');
    expect(result.error).toMatch(/failed \(exit code/i);
  });
});

// ---------------------------------------------------------------------------
// Agent selection
// ---------------------------------------------------------------------------

describe('content-draft handler — agent selection', () => {
  test('falls back to session.defaults.researchAgent when task has none', async () => {
    const spy = spyRunner();
    const handler = createContentDraftHandler(CONTEXT(), spy);
    await handler(makeTask({ researchAgent: undefined }));
    expect(spy.calls).toHaveLength(1);
  });

  test('returns failed result for unsupported agent', async () => {
    const spy = spyRunner();
    const ctx = CONTEXT({
      session: SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'claude' } }),
    });
    const handler = createContentDraftHandler(ctx, spy);
    const result = await handler(makeTask({ researchAgent: 'claude' }));
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Unsupported content draft agent/);
  });
});

// ---------------------------------------------------------------------------
// Phase transition through runNextPhase
// ---------------------------------------------------------------------------

describe('content-draft handler — phase transition', () => {
  let store;
  let storePath;

  beforeEach(() => {
    storePath = join(tmpDir, 'test.db');
    store = new SqliteTaskStore(storePath);
  });

  afterEach(() => {
    store.close();
  });

  test('content_draft success transitions task to queued/content_review', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_draft',
      researchAgent: 'gemini',
      context: { artifactDir: researchArtifactDir },
      now: '2026-07-15T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-draft-1', now: '2026-07-15T00:01:00.000Z' },
      handlers: {
        content_draft: createContentDraftHandler(CONTEXT(), fakeOk()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('queued');
    expect(outcome.task.phase).toBe('content_review');
  });

  test('content_draft command failure transitions task to failed', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_draft',
      researchAgent: 'gemini',
      context: { artifactDir: researchArtifactDir },
      now: '2026-07-15T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-draft-1', now: '2026-07-15T00:01:00.000Z' },
      handlers: {
        content_draft: createContentDraftHandler(CONTEXT(), fakeFail('network error')),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('failed');
  });

  test('content_draft input_invalid transitions task to failed', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_draft',
      researchAgent: 'gemini',
      context: {},
      now: '2026-07-15T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-draft-1', now: '2026-07-15T00:01:00.000Z' },
      handlers: {
        content_draft: createContentDraftHandler(CONTEXT(), fakeOk()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('failed');
  });
});
