import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createResearchHandler } from '../dist/handlers/research.js';
import { SqliteTaskStore } from '../dist/index.js';
import { runNextPhase } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let artifactRoot;
let sessionsJson;
let dbPath;

const SESSION = (overrides = {}) => ({
  sessionId: 'addon-dev',
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
  runId: 'run-test-1',
  workerId: 'worker-test',
  ...overrides,
});

// Fake runner that succeeds with given stdout
const fakeOk = (stdout = 'Research findings: looks good.') => ({
  run: (_cmd, _args, opts) => ({
    stdout,
    stderr: '',
    exitCode: 0,
    calledWith: { cwd: opts.cwd },
  }),
});

// Fake runner that fails
const fakeFail = (stderr = 'agy: command not found') => ({
  run: (_cmd, _args, opts) => ({
    stdout: '',
    stderr,
    exitCode: 127,
    calledWith: { cwd: opts.cwd },
  }),
});

// Spy runner — records invocation
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

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'research-handler-test-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal task fixture
// ---------------------------------------------------------------------------

function makeTask(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: 42,
    status: 'running',
    phase: 'research',
    priority: 'normal',
    researchAgent: 'gemini',
    attempts: {},
    context: {
      title: 'Investigate memory leak',
      url: 'https://github.com/m2dw/test-repo/issues/42',
      labels: ['agent:gemini', 'status:research-needed'],
    },
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: artifact paths
// ---------------------------------------------------------------------------

describe('research handler — artifacts', () => {
  test('creates artifact dir under artifactRoot/runs/<runId>', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());

    const dir = join(artifactRoot, 'runs', 'run-test-1');
    expect(existsSync(dir)).toBe(true);
  });

  test('writes research-prompt.md, research-output.md, research-result.json', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk('findings here'));
    await handler(makeTask());

    const dir = join(artifactRoot, 'runs', 'run-test-1');
    expect(existsSync(join(dir, 'research-prompt.md'))).toBe(true);
    expect(existsSync(join(dir, 'research-output.md'))).toBe(true);
    expect(existsSync(join(dir, 'research-result.json'))).toBe(true);
  });

  test('research-prompt.md includes issue number, title, and repo root', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());

    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-test-1', 'research-prompt.md'), 'utf8');
    expect(prompt).toContain('42');
    expect(prompt).toContain('Investigate memory leak');
    expect(prompt).toContain(repoRoot);
  });

  test('research-prompt.md includes phase contract guardrails', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());

    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-test-1', 'research-prompt.md'), 'utf8');
    expect(prompt).toContain('Do NOT implement fixes');
    expect(prompt).toContain('findings, options, recommendation, risks, and open questions');
    expect(prompt).toContain('uncertain claims');
  });

  test('research-output.md contains command stdout', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk('detailed findings'));
    await handler(makeTask());

    const output = readFileSync(join(artifactRoot, 'runs', 'run-test-1', 'research-output.md'), 'utf8');
    expect(output).toContain('detailed findings');
  });

  test('research-result.json is valid JSON with expected fields', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());

    const raw = readFileSync(join(artifactRoot, 'runs', 'run-test-1', 'research-result.json'), 'utf8');
    const result = JSON.parse(raw);
    expect(result).toMatchObject({ issueNumber: 42, runId: 'run-test-1', success: true });
  });
});

// ---------------------------------------------------------------------------
// Tests: cwd and command invocation
// ---------------------------------------------------------------------------

describe('research handler — command execution', () => {
  test('passes session.repoRoot as cwd to the command runner', async () => {
    const spy = spyRunner();
    const handler = createResearchHandler(CONTEXT(), spy);
    await handler(makeTask());

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].opts.cwd).toBe(repoRoot);
  });

  test('uses ANTIGRAVITY_BIN env var when set', async () => {
    const spy = spyRunner();
    process.env['ANTIGRAVITY_BIN'] = '/usr/local/bin/custom-agy';
    try {
      const handler = createResearchHandler(CONTEXT(), spy);
      await handler(makeTask());
      expect(spy.calls[0].cmd).toBe('/usr/local/bin/custom-agy');
    } finally {
      delete process.env['ANTIGRAVITY_BIN'];
    }
  });

  test('falls back to "agy" when ANTIGRAVITY_BIN is not set', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].cmd).toBe('agy');
  });

  test('passes --print as first arg to the runner', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].args[0]).toBe('--print');
  });

  test('passes the prompt as the --print argument and via stdin', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    // --print followed by the prompt string, matching: agy --print "$(cat "$PROMPT")"
    expect(spy.calls[0].args).toHaveLength(2);
    expect(spy.calls[0].args[0]).toBe('--print');
    expect(spy.calls[0].args[1]).toContain('Research Task');
    expect(typeof spy.calls[0].opts.stdin).toBe('string');
    expect(spy.calls[0].opts.stdin).toContain('Research Task');
  });

  test('ANTIGRAVITY_BIN is honoured and --print is still first arg', async () => {
    const spy = spyRunner();
    process.env['ANTIGRAVITY_BIN'] = '/opt/custom-agy';
    try {
      const handler = createResearchHandler(CONTEXT(), spy);
      await handler(makeTask());
      expect(spy.calls[0].cmd).toBe('/opt/custom-agy');
      expect(spy.calls[0].args[0]).toBe('--print');
    } finally {
      delete process.env['ANTIGRAVITY_BIN'];
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: agent selection
// ---------------------------------------------------------------------------

describe('research handler — agent selection', () => {
  test('uses task.researchAgent over session default', async () => {
    const spy = spyRunner();
    // session default is gemini but task overrides to gemini (same — just verify no crash)
    const handler = createResearchHandler(CONTEXT(), spy);
    await handler(makeTask({ researchAgent: 'gemini' }));
    expect(spy.calls).toHaveLength(1);
  });

  test('falls back to session.defaults.researchAgent when task has none', async () => {
    const spy = spyRunner();
    const handler = createResearchHandler(CONTEXT(), spy);
    await handler(makeTask({ researchAgent: undefined }));
    expect(spy.calls).toHaveLength(1);
  });

  test('returns failed result for unsupported agent', async () => {
    const spy = spyRunner();
    const ctx = CONTEXT({ session: SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'claude' } }) });
    const handler = createResearchHandler(ctx, spy);
    const result = await handler(makeTask({ researchAgent: 'claude' }));
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Unsupported research agent/);
  });
});

// ---------------------------------------------------------------------------
// Tests: success / failure results
// ---------------------------------------------------------------------------

describe('research handler — PhaseHandlerResult', () => {
  test('returns success result on exitCode 0', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
  });

  test('returns failed result on non-zero exit', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeFail('agy: auth error'));
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/agy: auth error/);
  });

  test('success result includes artifactDir in context', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(result.context?.artifactDir).toContain('run-test-1');
  });

  test('artifacts are written even on command failure', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-test-1', 'research-result.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: phase transition through runNextPhase + SqliteTaskStore
// ---------------------------------------------------------------------------

describe('research handler — phase transition', () => {
  let store;
  let storePath;

  beforeEach(() => {
    storePath = join(tmpDir, 'test.db');
    store = new SqliteTaskStore(storePath);
  });

  afterEach(() => {
    store.close();
  });

  test('research success transitions task to ready_for_human', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 42,
      phase: 'research',
      researchAgent: 'gemini',
      now: '2026-06-07T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'worker-test', runId: 'run-test-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: {
        research: createResearchHandler(CONTEXT(), fakeOk()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');
    expect(outcome.task.phase).toBe('research');
  });

  test('research command failure transitions task to failed', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 42,
      phase: 'research',
      researchAgent: 'gemini',
      now: '2026-06-07T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'worker-test', runId: 'run-test-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: {
        research: createResearchHandler(CONTEXT(), fakeFail('network error')),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('failed');
    expect(outcome.task.lastError).toMatch(/network error/);
  });

  test('research handler is selected for a queued research task', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 55,
      phase: 'research',
      now: '2026-06-07T00:00:00.000Z',
    });

    const spy = spyRunner();
    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'worker-test', runId: 'run-55', now: '2026-06-07T00:01:00.000Z' },
      handlers: {
        research: createResearchHandler(CONTEXT({ runId: 'run-55' }), spy),
      },
    });

    // Handler was invoked (not the missing-handler path)
    expect(outcome.status).toBe('completed');
    expect(spy.calls).toHaveLength(1);
  });

  test('non-research task is unaffected by research handler presence', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 99,
      phase: 'implementation',
      now: '2026-06-07T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'worker-test', runId: 'run-99', now: '2026-06-07T00:01:00.000Z' },
      handlers: {
        research: createResearchHandler(CONTEXT({ runId: 'run-99' }), fakeOk()),
        // no implementation handler
      },
    });

    // Missing handler path fires for implementation
    expect(outcome.status).toBe('phase_missing');
    expect(outcome.task.status).toBe('ready_for_human');
  });
});

// ---------------------------------------------------------------------------
// Resolved agent profile metadata
// ---------------------------------------------------------------------------

describe('research handler — resolved profile metadata', () => {
  const dir = () => join(artifactRoot, 'runs', 'run-test-1');

  test('writes research-context.json before invoking the research agent', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    expect(existsSync(join(dir(), 'research-context.json'))).toBe(true);
  });

  test('research-context.json contains resolvedProfile with phase and agentId', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'research', agentId: 'gemini' });
  });

  test('research-context.json resolvedProfile records modelSource as cli-default', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.modelSource).toBe('cli-default');
  });

  test('cmdSource is cli-default when ANTIGRAVITY_BIN is not set', async () => {
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.cmdSource).toBe('cli-default');
    expect(ctx.resolvedProfile.cmd).toBe('agy');
  });

  test('cmdSource is env when ANTIGRAVITY_BIN is set', async () => {
    process.env['ANTIGRAVITY_BIN'] = '/usr/local/bin/my-agy';
    try {
      const handler = createResearchHandler(CONTEXT(), fakeOk());
      await handler(makeTask());
    } finally {
      delete process.env['ANTIGRAVITY_BIN'];
    }
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.cmdSource).toBe('env');
    expect(ctx.resolvedProfile.cmd).toBe('/usr/local/bin/my-agy');
  });

  test('research-context.json resolvedProfile argv excludes prompt content', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.argv).toEqual(['--print']);
  });

  test('research-context.json exists even on agent failure (pre-run audit)', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    expect(existsSync(join(dir(), 'research-context.json'))).toBe(true);
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'research', agentId: 'gemini' });
  });

  test('research-result.json includes resolvedProfile on success', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeOk());
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'research-result.json'), 'utf8'));
    expect(result.resolvedProfile).toMatchObject({ phase: 'research', agentId: 'gemini' });
  });

  test('research-result.json includes resolvedProfile on failure', async () => {
    const handler = createResearchHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'research-result.json'), 'utf8'));
    expect(result.resolvedProfile).toMatchObject({ phase: 'research', agentId: 'gemini' });
  });
});

// ---------------------------------------------------------------------------
// Antigravity model configuration (issue #493)
// ---------------------------------------------------------------------------

describe('research handler — Antigravity model configuration', () => {
  const dir = () => join(artifactRoot, 'runs', 'run-test-1');

  test('no configured model: uses agy --print (default behavior unchanged)', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].cmd).toBe('agy');
    expect(spy.calls[0].args[0]).toBe('--print');
    expect(spy.calls[0].args).not.toContain('--model');
  });

  test('configured model: passes --model <model> before --print', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const session = SESSION({ research: { antigravity: { model: 'Gemini 3.1 Pro (Low)' } } });
    const handler = createResearchHandler(CONTEXT({ session }), spy);
    await handler(makeTask());
    expect(spy.calls[0].cmd).toBe('agy');
    expect(spy.calls[0].args[0]).toBe('--model');
    expect(spy.calls[0].args[1]).toBe('Gemini 3.1 Pro (Low)');
    expect(spy.calls[0].args[2]).toBe('--print');
  });

  test('configured model: prompt still appended after --print', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const session = SESSION({ research: { antigravity: { model: 'Gemini 3.1 Pro (Low)' } } });
    const handler = createResearchHandler(CONTEXT({ session }), spy);
    await handler(makeTask());
    // args: ['--model', 'Gemini 3.1 Pro (Low)', '--print', <prompt>]
    expect(spy.calls[0].args).toHaveLength(4);
    expect(spy.calls[0].args[3]).toContain('Research Task');
  });

  test('configured model: resolvedProfile records modelSource as session-config', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const session = SESSION({ research: { antigravity: { model: 'Gemini 3.1 Pro (Low)' } } });
    const handler = createResearchHandler(CONTEXT({ session }), spy);
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.modelSource).toBe('session-config');
    expect(ctx.resolvedProfile.model).toBe('Gemini 3.1 Pro (Low)');
  });

  test('configured model: resolvedProfile argv reflects --model flag', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const session = SESSION({ research: { antigravity: { model: 'Gemini 3.5 Flash (Medium)' } } });
    const handler = createResearchHandler(CONTEXT({ session }), spy);
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.argv).toEqual(['--model', 'Gemini 3.5 Flash (Medium)', '--print']);
  });

  test('no configured model: resolvedProfile has no model field and argv is [--print]', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createResearchHandler(CONTEXT(), spy);
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'research-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.modelSource).toBe('cli-default');
    expect(ctx.resolvedProfile.model).toBeUndefined();
    expect(ctx.resolvedProfile.argv).toEqual(['--print']);
  });

  test('configured model: research-result.json includes model and modelSource', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const session = SESSION({ research: { antigravity: { model: 'Claude Opus 4.6 (Thinking)' } } });
    const handler = createResearchHandler(CONTEXT({ session }), spy);
    await handler(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'research-result.json'), 'utf8'));
    expect(result.resolvedProfile.modelSource).toBe('session-config');
    expect(result.resolvedProfile.model).toBe('Claude Opus 4.6 (Thinking)');
  });
});
