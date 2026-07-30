import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createContentResearchHandler } from '../dist/handlers/content-research.js';
import { SqliteTaskStore } from '../dist/index.js';
import { runNextPhase } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let artifactRoot;

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
  runId: 'run-content-1',
  workerId: 'worker-content',
  ...overrides,
});

const fakeOk = (stdout = 'Content research findings: all good.') => ({
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

function spyRunner(result = { stdout: 'ok', stderr: '', exitCode: 0 }) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return result;
    },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'content-research-handler-test-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(overrides = {}) {
  return {
    sessionId: 'content-dev',
    issueNumber: 77,
    status: 'running',
    phase: 'content_research',
    priority: 'normal',
    researchAgent: 'gemini',
    attempts: {},
    context: {
      title: 'Write a blog post about performance tuning',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:gemini', 'status:content-needed'],
    },
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Artifact paths
// ---------------------------------------------------------------------------

describe('content-research handler — artifacts', () => {
  test('creates artifact dir under artifactRoot/runs/<runId>', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-content-1'))).toBe(true);
  });

  test('writes content-research-prompt.md, content-research-output.md, content-research-result.json', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk('findings here'));
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-content-1');
    expect(existsSync(join(dir, 'content-research-prompt.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-research-output.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-research-result.json'))).toBe(true);
  });

  test('writes content-research-brief.json and content-research-context.json', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-content-1');
    expect(existsSync(join(dir, 'content-research-brief.json'))).toBe(true);
    expect(existsSync(join(dir, 'content-research-context.json'))).toBe(true);
  });

  test('writes content-research-validated-brief.md on valid outcome', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk('validated findings'));
    await handler(makeTask());
    const briefPath = join(artifactRoot, 'runs', 'run-content-1', 'content-research-validated-brief.md');
    expect(existsSync(briefPath)).toBe(true);
    expect(readFileSync(briefPath, 'utf8')).toContain('validated findings');
  });

  test('does NOT write content-research-validated-brief.md on command failure', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    const briefPath = join(artifactRoot, 'runs', 'run-content-1', 'content-research-validated-brief.md');
    expect(existsSync(briefPath)).toBe(false);
  });

  test('content-research-prompt.md includes issue number and title', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-content-1', 'content-research-prompt.md'), 'utf8');
    expect(prompt).toContain('77');
    expect(prompt).toContain('Write a blog post about performance tuning');
  });

  test('content-research-prompt.md includes phase contract guardrails', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-content-1', 'content-research-prompt.md'), 'utf8');
    expect(prompt).toContain('Do NOT modify any files');
    expect(prompt).toContain('findings, key themes');
    expect(prompt).toContain('uncertain claims');
  });

  test('content-research-prompt.md includes issue body as bounded delimited input', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask({
      context: {
        title: 'Write a blog post',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: [],
        body: 'This body text must appear in the prompt.',
      },
    }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-content-1', 'content-research-prompt.md'), 'utf8');
    expect(prompt).toContain('This body text must appear');
    expect(prompt).toMatch(/begin:issue-body-input/);
    expect(prompt).toMatch(/end:issue-body-input/);
  });

  test('content-research-output.md contains command stdout', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk('detailed content findings'));
    await handler(makeTask());
    const output = readFileSync(join(artifactRoot, 'runs', 'run-content-1', 'content-research-output.md'), 'utf8');
    expect(output).toContain('detailed content findings');
  });

  test('artifacts are written even on command failure', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-content-1');
    expect(existsSync(join(dir, 'content-research-output.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-research-result.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Isolated cwd — the agent does NOT run in session.repoRoot
// ---------------------------------------------------------------------------

describe('content-research handler — isolated execution cwd', () => {
  test('does NOT pass session.repoRoot as cwd to the command runner', async () => {
    const spy = spyRunner();
    const handler = createContentResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].opts.cwd).not.toBe(repoRoot);
  });

  test('uses the per-run artifact directory as the agent cwd', async () => {
    const spy = spyRunner();
    const handler = createContentResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    const cwd = spy.calls[0].opts.cwd;
    const expectedArtifactDir = join(artifactRoot, 'runs', 'run-content-1');
    expect(cwd).toBe(expectedArtifactDir);
  });

  test('content-research-brief.json records cwdPolicy as artifact-dir', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const brief = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-content-1', 'content-research-brief.json'), 'utf8'));
    expect(brief.cwdPolicy).toBe('artifact-dir');
  });
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

describe('content-research handler — command execution', () => {
  test('uses ANTIGRAVITY_BIN env var when set', async () => {
    const spy = spyRunner();
    process.env['ANTIGRAVITY_BIN'] = '/usr/local/bin/custom-agy';
    try {
      const handler = createContentResearchHandler(CONTEXT(), spy);
      await handler(makeTask());
      expect(spy.calls[0].cmd).toBe('/usr/local/bin/custom-agy');
    } finally {
      delete process.env['ANTIGRAVITY_BIN'];
    }
  });

  test('falls back to "agy" when ANTIGRAVITY_BIN is not set', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].cmd).toBe('agy');
  });

  test('passes --print as first arg', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].args[0]).toBe('--print');
  });

  test('passes the prompt as the final positional arg and via stdin', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].args).toHaveLength(2);
    expect(spy.calls[0].args[0]).toBe('--print');
    expect(spy.calls[0].args[1]).toContain('Content Research Task');
    expect(typeof spy.calls[0].opts.stdin).toBe('string');
    expect(spy.calls[0].opts.stdin).toContain('Content Research Task');
  });

  test('configured model: passes --model before --print', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const session = SESSION({ research: { antigravity: { model: 'Gemini 3.1 Pro (Low)' } } });
    const handler = createContentResearchHandler(CONTEXT({ session }), spy);
    await handler(makeTask());
    expect(spy.calls[0].args[0]).toBe('--model');
    expect(spy.calls[0].args[1]).toBe('Gemini 3.1 Pro (Low)');
    expect(spy.calls[0].args[2]).toBe('--print');
  });
});

// ---------------------------------------------------------------------------
// Result states
// ---------------------------------------------------------------------------

describe('content-research handler — PhaseHandlerResult', () => {
  test('returns success on exit code 0 with non-empty output', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk('some findings'));
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
  });

  test('returns failed on non-zero exit', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeFail('network error'));
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
  });

  test('success result includes artifactDir in context', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(result.context?.artifactDir).toContain('run-content-1');
  });

});

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

describe('content-research handler — outcome classification', () => {
  const dir = () => join(artifactRoot, 'runs', 'run-content-1');

  test('outcome is "valid" when exit 0 and non-empty output', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk('findings'));
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'content-research-result.json'), 'utf8'));
    expect(result.outcome).toBe('valid');
    expect(result.success).toBe(true);
  });

  test('outcome is "malformed" when exit 0 but empty output', async () => {
    const runner = { run: () => ({ stdout: '', stderr: '', exitCode: 0 }) };
    const handler = createContentResearchHandler(CONTEXT(), runner);
    const phaseResult = await handler(makeTask());
    expect(phaseResult.result).toBe('failed');
    const artifact = JSON.parse(readFileSync(join(dir(), 'content-research-result.json'), 'utf8'));
    expect(artifact.outcome).toBe('malformed');
    expect(artifact.success).toBe(false);
  });

  test('outcome is "command-failure" when exit non-zero', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeFail('error'));
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'content-research-result.json'), 'utf8'));
    expect(result.outcome).toBe('command-failure');
    expect(result.success).toBe(false);
  });

  test('outcome is "quota/rate-limit" for quota signal', async () => {
    const quotaRunner = {
      run: () => ({
        stdout: '',
        stderr: 'Error: Resource exhausted: Quota exceeded for quota',
        exitCode: 1,
      }),
    };
    const handler = createContentResearchHandler(CONTEXT(), quotaRunner);
    const phaseResult = await handler(makeTask());
    expect(phaseResult.result).toBe('delayed');
    // Category and retry metadata survive onto the handler result (issue #672).
    expect(phaseResult.category).toBe('usage_quota');
    expect(phaseResult.context.category).toBe('usage_quota');
    const artifact = JSON.parse(readFileSync(join(dir(), 'content-research-result.json'), 'utf8'));
    expect(artifact.outcome).toBe('quota/rate-limit');
    expect(artifact.success).toBe(false);
  });

  test('invalid output never leaves the artifact marked successful', async () => {
    // malformed case
    const runner = { run: () => ({ stdout: '   ', stderr: '', exitCode: 0 }) };
    const handler = createContentResearchHandler(CONTEXT(), runner);
    await handler(makeTask());
    const artifact = JSON.parse(readFileSync(join(dir(), 'content-research-result.json'), 'utf8'));
    expect(artifact.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Public-safe errors — raw stderr never in result.error
// ---------------------------------------------------------------------------

describe('content-research handler — public-safe errors', () => {
  test('failed result.error does not contain raw stderr', async () => {
    const secretStderr = 'secret_token=ghp_XXXXXXXXXXX and error: internal path /home/user/secret';
    const runner = {
      run: () => ({ stdout: '', stderr: secretStderr, exitCode: 1 }),
    };
    const handler = createContentResearchHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    // The raw stderr must NOT appear in the public result.error
    expect(result.error).not.toContain('secret_token');
    expect(result.error).not.toContain('ghp_XXXXXXXXXXX');
    expect(result.error).not.toContain('/home/user/secret');
  });

  test('secret-looking stderr is retained only in local diagnostic artifact', async () => {
    const secretStderr = 'token: ghp_ABCDEF12345 at /private/runs/xyz';
    const runner = {
      run: () => ({ stdout: '', stderr: secretStderr, exitCode: 1 }),
    };
    const handler = createContentResearchHandler(CONTEXT(), runner);
    await handler(makeTask());
    // Raw content is in the local artifact
    const output = readFileSync(join(artifactRoot, 'runs', 'run-content-1', 'content-research-output.md'), 'utf8');
    expect(output).toContain(secretStderr);
  });

  test('malformed result.error is a fixed public-safe message', async () => {
    const runner = { run: () => ({ stdout: '', stderr: '', exitCode: 0 }) };
    const handler = createContentResearchHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    // Should be a fixed structured message, not raw agent output
    expect(result.error).toMatch(/no usable output/i);
  });

  test('command-failure result.error is a fixed public-safe message', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeFail('crash dump with secrets'));
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).not.toContain('crash dump with secrets');
    expect(result.error).toMatch(/failed \(exit code/i);
  });
});

// ---------------------------------------------------------------------------
// Artifact contract
// ---------------------------------------------------------------------------

describe('content-research handler — brief artifact', () => {
  const dir = () => join(artifactRoot, 'runs', 'run-content-1');

  test('content-research-brief.json records inputs.title, inputs.url, inputs.labels', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask({
      context: {
        title: 'Write a blog post about performance tuning',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:gemini', 'status:content-needed'],
      },
    }));
    const brief = JSON.parse(readFileSync(join(dir(), 'content-research-brief.json'), 'utf8'));
    expect(brief.inputs.title).toBe('Write a blog post about performance tuning');
    expect(brief.inputs.url).toBe('https://github.com/m2dw/test-repo/issues/77');
    expect(brief.inputs.labels).toEqual(['agent:gemini', 'status:content-needed']);
  });

  test('content-research-brief.json records bodyBounded:true when body is present', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask({ context: { title: 'T', url: null, labels: [], body: 'some content' } }));
    const brief = JSON.parse(readFileSync(join(dir(), 'content-research-brief.json'), 'utf8'));
    expect(brief.inputs.bodyBounded).toBe(true);
  });

  test('content-research-brief.json lists body in inputsExcluded when absent from context', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask({ context: { title: 'T', url: null, labels: [] } }));
    const brief = JSON.parse(readFileSync(join(dir(), 'content-research-brief.json'), 'utf8'));
    expect(Array.isArray(brief.inputsExcluded)).toBe(true);
    expect(brief.inputsExcluded).toContain('body');
  });

  test('content-research-brief.json is written before agent runs (present on failure)', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    expect(existsSync(join(dir(), 'content-research-brief.json'))).toBe(true);
  });

  test('title falls back to Issue #N when context has no title', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask({ context: {} }));
    const brief = JSON.parse(readFileSync(join(dir(), 'content-research-brief.json'), 'utf8'));
    expect(brief.inputs.title).toBe('Issue #77');
  });
});

// ---------------------------------------------------------------------------
// Context artifact
// ---------------------------------------------------------------------------

describe('content-research handler — context artifact', () => {
  const dir = () => join(artifactRoot, 'runs', 'run-content-1');

  test('content-research-context.json contains resolvedProfile with phase and agentId', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'content-research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'content_research', agentId: 'gemini' });
  });

  test('content-research-context.json exists even on agent failure (pre-run audit)', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    expect(existsSync(join(dir(), 'content-research-context.json'))).toBe(true);
  });

  test('content-research-result.json includes resolvedProfile on success', async () => {
    const handler = createContentResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'content-research-result.json'), 'utf8'));
    expect(result.resolvedProfile).toMatchObject({ phase: 'content_research', agentId: 'gemini' });
  });
});

// ---------------------------------------------------------------------------
// Agent selection
// ---------------------------------------------------------------------------

describe('content-research handler — agent selection', () => {
  test('falls back to session.defaults.researchAgent when task has none', async () => {
    const spy = spyRunner();
    const handler = createContentResearchHandler(CONTEXT(), spy);
    await handler(makeTask({ researchAgent: undefined }));
    expect(spy.calls).toHaveLength(1);
  });

  test('returns failed result for unsupported agent', async () => {
    const spy = spyRunner();
    const ctx = CONTEXT({
      session: SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'claude' } }),
    });
    const handler = createContentResearchHandler(ctx, spy);
    const result = await handler(makeTask({ researchAgent: 'claude' }));
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Unsupported content research agent/);
  });
});

// ---------------------------------------------------------------------------
// Phase transition through runNextPhase
// ---------------------------------------------------------------------------

describe('content-research handler — phase transition', () => {
  let store;
  let storePath;

  beforeEach(() => {
    storePath = join(tmpDir, 'test.db');
    store = new SqliteTaskStore(storePath);
  });

  afterEach(() => {
    store.close();
  });

  test('content_research success transitions task to queued/content_draft', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_research',
      researchAgent: 'gemini',
      now: '2026-06-07T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-content-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: {
        content_research: createContentResearchHandler(CONTEXT(), fakeOk()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('queued');
    expect(outcome.task.phase).toBe('content_draft');
  });

  test('content_research command failure transitions task to failed', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_research',
      researchAgent: 'gemini',
      now: '2026-06-07T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-content-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: {
        content_research: createContentResearchHandler(CONTEXT(), fakeFail('network error')),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('failed');
  });
});
