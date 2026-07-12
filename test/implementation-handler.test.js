import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createImplementationHandler } from '../dist/handlers/implementation.js';
import { SqliteTaskStore, runNextPhase, TOOL_REQUEST_OPEN, TOOL_REQUEST_CLOSE } from '../dist/index.js';

const CLI = new URL('../dist/cli/run-one-phase.js', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let artifactRoot;

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
  runId: 'run-impl-1',
  workerId: 'worker-test',
  ...overrides,
});

function makeTask(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: 77,
    status: 'running',
    phase: 'implementation',
    priority: 'normal',
    implementationAgent: 'claude',
    attempts: {},
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:claude', 'status:needs-implementation'],
    },
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Multi-step runner: each call to run() consumes one result from the queue.
// Simulates the full orchestration: claude -> git diff -> git checkout ->
// git ls-files -> git add -> git commit -> git push -> gh pr create
// ---------------------------------------------------------------------------
function sequenceRunner(steps) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(cmd, args, opts) {
      const result = steps[i] ?? { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      calls.push({ cmd, args, opts, result });
      i++;
      return result;
    },
  };
}

// Happy-path runner reflecting the new orchestration order:
// status -> checkout base -> pull -> rev-parse HEAD -> checkout -b -> claude -> diff -> verification -> ls-files -> add -> commit -> push -> gh pr
function happyRunner(prUrl = 'https://github.com/m2dw/test-repo/pull/99', stageableOutput = 'src/foo.ts\0', baseBranch = 'main') {
  return sequenceRunner([
    { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean)
    { stdout: '', stderr: '', exitCode: 0 },                      // git checkout <base>
    { stdout: '', stderr: '', exitCode: 0 },                      // git pull --ff-only
    { stdout: baseBranch, stderr: '', exitCode: 0 },              // git rev-parse --abbrev-ref HEAD (== base)
    { stdout: '', stderr: '', exitCode: 0 },                      // git checkout -b <branch> <base>
    { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
    { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
    { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification (npm test)
    { stdout: stageableOutput, stderr: '', exitCode: 0 },         // git ls-files -z
    { stdout: '', stderr: '', exitCode: 0 },                      // git add -- <paths>
    { stdout: '', stderr: '', exitCode: 0 },                      // git commit
    { stdout: '', stderr: '', exitCode: 0 },                      // git push
    { stdout: prUrl, stderr: '', exitCode: 0 },                   // gh pr create
  ]);
}

// Fails on the claude step — preflight steps (incl. HEAD verification) succeed
function fakeFail(stderr = 'claude: auth error') {
  return sequenceRunner([
    { stdout: '', stderr: '', exitCode: 0 },     // git status — clean
    { stdout: '', stderr: '', exitCode: 0 },     // git checkout main
    { stdout: '', stderr: '', exitCode: 0 },     // git pull --ff-only
    { stdout: 'main', stderr: '', exitCode: 0 }, // git rev-parse --abbrev-ref HEAD (== main)
    { stdout: '', stderr: '', exitCode: 0 },     // git checkout -b
    { stdout: '', stderr, exitCode: 1 },         // claude — fails
  ]);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'impl-handler-test-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Per-issue worktree fixtures (issue #454)
//
// In worktree mode the shared-checkout base reset + branch creation (checkout
// base, pull, rev-parse HEAD, checkout -b) are skipped because the worktree
// manager already checked out `ai/issue-<n>`. The base ref is still refreshed in
// the canonical repo before branching (issue #454 review: `git fetch origin
// <base>:refs/remotes/origin/<base>`), and on success the per-issue worktree is
// removed in the canonical repo to free `ai/issue-<n>` for the downstream review
// checkout (issue #454 review P1), so the git command sequence is:
//   fetch base (canonical) -> status -> claude -> diff -> verification -> ls-files -> add -> commit -> push -> gh -> worktree remove (canonical)
// ---------------------------------------------------------------------------
function worktreeHappyRunner(prUrl = 'https://github.com/m2dw/test-repo/pull/99', stageableOutput = 'src/foo.ts\0') {
  return sequenceRunner([
    { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin main:refs/remotes/origin/main (refresh base) — canonical repo
    { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (canonical — CLEAN)
    { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean) — in the worktree
    { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
    { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
    { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification (npm test)
    { stdout: stageableOutput, stderr: '', exitCode: 0 },         // git ls-files -z
    { stdout: '', stderr: '', exitCode: 0 },                      // git add -- <paths>
    { stdout: '', stderr: '', exitCode: 0 },                      // git commit
    { stdout: '', stderr: '', exitCode: 0 },                      // git push
    { stdout: prUrl, stderr: '', exitCode: 0 },                   // gh pr create
    { stdout: '', stderr: '', exitCode: 0 },                      // git worktree remove --force --force <wt> (free branch) — canonical repo
  ]);
}

// Records every resolveWorktree() input and returns a fixed worktree path, so the
// handler's cwd switch can be exercised without driving real `git worktree` ops
// through the mock command runner.
// `branchReused` tracks whether the resolver REUSED an existing `ai/issue-<n>` branch,
// independently of whether the worktree PATH was created (issue #455). It defaults to
// `!created` so the common cases stay intuitive — a fresh `created: true` worktree
// creates the branch (not reused); a `created: false` reused worktree reuses it — but
// can be set explicitly to model the recoverable delayed-run case where the branch
// survives while its pruned worktree dir is recreated (`created: true, branchReused: true`).
function fakeWorktreeResolver(worktreePath, { created = true, branchReused = !created } = {}) {
  const calls = [];
  const resolve = (input) => {
    calls.push(input);
    return {
      ok: true,
      path: worktreePath,
      worktreeId: `${input.sessionId}/issue-${input.issueNumber}`,
      branch: input.branch,
      // `created: false` models a REUSED branch — e.g. the delayed retry after a
      // quota discard kept `ai/issue-<n>` and its worktree (issue #454 review).
      created,
      branchReused,
    };
  };
  return { calls, resolve };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe('implementation handler — artifacts', () => {
  test('creates artifact dir under artifactRoot/runs/<runId>', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-impl-1'))).toBe(true);
  });

  test('writes implementation-prompt.md, -output.md, -result.json', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-impl-1');
    expect(existsSync(join(dir, 'implementation-prompt.md'))).toBe(true);
    expect(existsSync(join(dir, 'implementation-output.md'))).toBe(true);
    expect(existsSync(join(dir, 'implementation-result.json'))).toBe(true);
  });

  test('prompt includes issue number, title, and repoRoot', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('77');
    expect(prompt).toContain('Add login rate limiting');
    expect(prompt).toContain(repoRoot);
  });

  test('prompt includes the issue body under an Issue Description heading', async () => {
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-implementation'],
        body: 'Throttle login attempts to 5 per minute per IP address.',
      },
    });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('## Issue Description');
    expect(prompt).toContain('Throttle login attempts to 5 per minute per IP address.');
  });

  test('prompt omits the Issue Description heading when no body is present', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).not.toContain('## Issue Description');
  });

  test('prompt does NOT instruct Claude to run git or gh', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    // Claude is told not to run git/gh — those are handled by the handler
    expect(prompt.toLowerCase()).toContain('do not run git');
  });

  test('prompt includes phase contract guardrails', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('Keep the change scoped to the issue');
    expect(prompt).toContain('avoid unrelated refactors');
    expect(prompt).toContain('Do not bump package');
    expect(prompt).toContain('existing project patterns');
  });

  // Issue #510: configured verification commands must be named in the prompt so
  // agents know not to request them as Tool Requests.
  test('prompt names configured verification commands and forbids Tool Requests for them', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('## Configured Verification Commands');
    expect(prompt).toContain('`test`: `npm test`');
    expect(prompt).toContain('Do NOT request these as');
    expect(prompt).toContain('Tool Requests');
  });

  test('prompt omits verification section when no verification commands are configured', async () => {
    await createImplementationHandler(CONTEXT({ session: SESSION({ verification: {} }) }), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).not.toContain('## Configured Verification Commands');
  });

  // Issue #422: when a prior Tool Request was resolved by the operator, the next
  // implementation prompt must replay it + the operator response so the agent
  // reacts to the human instead of re-emitting the same request on an unchanged repo.
  function taskWithResolvedToolRequest(resolution) {
    return makeTask({
      context: {
        ...makeTask().context,
        toolRequest: {
          command: 'npm run typecheck && npm test && npm run build',
          displayCommand: 'npm run typecheck && npm test && npm run build',
          reason: 'Verify the change before opening a PR.',
          expectedFiles: ['dist/index.js'],
          necessity: 'required',
          requestedBy: 'worker-1',
          mode: 'new',
          requestedAt: '2026-06-07T00:00:00.000Z',
          resolved: true,
          resolution,
        },
      },
    });
  }

  test('prompt replays a manual-done operator response for a resolved Tool Request', async () => {
    const task = taskWithResolvedToolRequest({ action: 'manual-done', resolvedAt: '2026-06-08T01:00:00.000Z' });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('## Operator Response To Previous Tool Request');
    expect(prompt).toContain('npm run typecheck && npm test && npm run build');
    expect(prompt).toContain('The operator responded: manual-done');
    expect(prompt).toContain('Do not repeat the same Tool Request');
  });

  test('prompt replays a reject operator response with the operator note', async () => {
    const task = taskWithResolvedToolRequest({
      action: 'reject',
      message: 'We do not run the build here.',
      resolvedAt: '2026-06-08T02:00:00.000Z',
    });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('The operator responded: reject');
    expect(prompt).toContain('We do not run the build here.');
  });

  test('prompt has no operator-response section when there is no prior Tool Request', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).not.toContain('## Operator Response To Previous Tool Request');
  });

  test('prompt has no operator-response section when the prior Tool Request is unresolved', async () => {
    const task = makeTask({
      context: {
        ...makeTask().context,
        toolRequest: { command: 'npm test', resolved: false },
      },
    });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).not.toContain('## Operator Response To Previous Tool Request');
  });

  test('result.json contains prUrl and branch on success', async () => {
    const pr = 'https://github.com/m2dw/test-repo/pull/99';
    await createImplementationHandler(CONTEXT(), happyRunner(pr))(makeTask());
    const raw = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8');
    const r = JSON.parse(raw);
    expect(r).toMatchObject({ success: true, prUrl: pr, branch: expect.stringContaining('77') });
  });

  test('artifacts written even on claude failure', async () => {
    await createImplementationHandler(CONTEXT(), fakeFail())(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

describe('implementation handler — command execution', () => {
  // Claude is now calls[5]: status(0) checkout-main(1) pull(2) rev-parse(3) checkout-b(4) claude(5) ...
  const CLAUDE_IDX = 5;

  test('passes prompt via stdin, not as a positional argv arg', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const claudeCall = runner.calls[CLAUDE_IDX];
    expect(claudeCall.cmd).toBe('claude');
    expect(typeof claudeCall.opts.stdin).toBe('string');
    expect(claudeCall.opts.stdin).toContain('77');
    expect(claudeCall.args).not.toContain(claudeCall.opts.stdin);
  });

  test('uses session.repoRoot as cwd for all commands', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    for (const call of runner.calls) {
      expect(call.opts.cwd).toBe(repoRoot);
    }
  });

  test('invokes "claude" for claude agent with -p flag', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const claudeCall = runner.calls[CLAUDE_IDX];
    expect(claudeCall.cmd).toBe('claude');
    expect(claudeCall.args).toContain('-p');
    expect(claudeCall.args).toContain('--permission-mode');
    expect(claudeCall.args).toContain('acceptEdits');
    expect(claudeCall.args).toContain('--allowedTools');
  });

  test('allowedTools includes read-only git inspection commands', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const { args } = runner.calls[CLAUDE_IDX];
    const tools = args[args.indexOf('--allowedTools') + 1];
    expect(tools).toContain('Bash(git status *)');
    expect(tools).toContain('Bash(git diff *)');
    expect(tools).toContain('Bash(git log *)');
    expect(tools).toContain('Bash(git show *)');
  });

  test('allowedTools does not include git write operations', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const { args } = runner.calls[CLAUDE_IDX];
    const tools = args[args.indexOf('--allowedTools') + 1];
    for (const writeOp of ['commit', 'push', 'checkout', 'reset', 'merge', 'rebase', 'add', 'restore', 'clean']) {
      expect(tools).not.toContain(`Bash(git ${writeOp}`);
    }
  });

  test('includes model/effort/budget flags', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args).toContain('--model');
    expect(args).toContain('--effort');
    expect(args).toContain('--max-budget-usd');
  });

  test('respects CLAUDE_MODEL / CLAUDE_EFFORT / CLAUDE_MAX_BUDGET_USD env vars', async () => {
    process.env['CLAUDE_MODEL'] = 'opus';
    process.env['CLAUDE_EFFORT'] = 'high';
    process.env['CLAUDE_MAX_BUDGET_USD'] = '20';
    const runner = happyRunner();
    try {
      await createImplementationHandler(CONTEXT(), runner)(makeTask());
    } finally {
      delete process.env['CLAUDE_MODEL'];
      delete process.env['CLAUDE_EFFORT'];
      delete process.env['CLAUDE_MAX_BUDGET_USD'];
    }
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('20');
  });

  test('complexity:low label -> sonnet / low / $2', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:claude', 'status:needs-implementation', 'complexity:low'] } });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('2');
  });

  test('complexity:high label -> opus / high / $10', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:claude', 'status:needs-implementation', 'complexity:high'] } });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('10');
  });

  test('no complexity label -> sonnet / high / $5', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('5');
  });

  test('complexity:xhigh label -> opus / xhigh / $20', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:claude', 'status:needs-implementation', 'complexity:xhigh'] } });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('20');
  });

  test('complexity:xhigh beats complexity:high (xhigh > high)', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:claude', 'status:needs-implementation', 'complexity:high', 'complexity:xhigh'] } });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('20');
  });

  test('env vars override complexity label defaults', async () => {
    process.env['CLAUDE_MODEL'] = 'haiku';
    process.env['CLAUDE_EFFORT'] = 'medium';
    process.env['CLAUDE_MAX_BUDGET_USD'] = '3';
    const runner = happyRunner();
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:claude', 'status:needs-implementation', 'complexity:high'] } });
    try {
      await createImplementationHandler(CONTEXT(), runner)(task);
    } finally {
      delete process.env['CLAUDE_MODEL'];
      delete process.env['CLAUDE_EFFORT'];
      delete process.env['CLAUDE_MAX_BUDGET_USD'];
    }
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('3');
  });

  test('escalatedEffort promotes effort when label effort is low', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-implementation', 'complexity:low'],
        escalatedEffort: 'high',
      },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CLAUDE_IDX];
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  test('escalatedEffort is ignored when label effort is already high', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-implementation'],
        escalatedEffort: 'high',
      },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CLAUDE_IDX];
    // effort is already high from label defaults — escalation is a no-op
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  test('escalatedEffort never downgrades complexity:xhigh to high', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-implementation', 'complexity:xhigh'],
        escalatedEffort: 'high',
      },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CLAUDE_IDX];
    // xhigh outranks the 'high' escalation target — escalation must not downgrade it
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
  });

  test('preflight order: status -> checkout main -> pull -> rev-parse HEAD -> checkout -b -> claude -> diff -> verification -> ls-files -> add -> commit -> push -> gh', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const calls = runner.calls;
    expect(calls[0]).toMatchObject({ cmd: 'git', args: ['status', '--porcelain'] });
    expect(calls[1]).toMatchObject({ cmd: 'git', args: ['checkout', 'main'] });
    expect(calls[2]).toMatchObject({ cmd: 'git', args: ['pull', '--ff-only'] });
    expect(calls[3]).toMatchObject({ cmd: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'] });  // verify HEAD is at base
    expect(calls[4]).toMatchObject({ cmd: 'git', args: expect.arrayContaining(['checkout', '-b']) });
    expect(calls[5].cmd).toBe('claude');   // claude runs AFTER branch is created
    expect(calls[6]).toMatchObject({ cmd: 'git', args: ['diff', '--stat', 'HEAD'] });
    expect(calls[7]).toMatchObject({ cmd: 'npm', args: ['test'] });  // verification runs before staging
    expect(calls[8]).toMatchObject({ cmd: 'git', args: ['ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z'] });
    expect(calls[9]).toMatchObject({ cmd: 'git', args: ['add', '--', 'src/foo.ts'] });
    expect(calls[10]).toMatchObject({ cmd: 'git', args: expect.arrayContaining(['commit']) });
    expect(calls[11]).toMatchObject({ cmd: 'git', args: expect.arrayContaining(['push']) });
    expect(calls[12].cmd).toBe('gh');
  });

  test('new-impl branch is created explicitly from the base branch', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(runner.calls[4]).toMatchObject({ cmd: 'git', args: ['checkout', '-b', 'ai/issue-77', 'main'] });
  });

  test('aborts before branch creation when HEAD is not at the base branch after checkout/pull', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                 // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                 // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                 // git pull --ff-only
      { stdout: 'ai/issue-202', stderr: '', exitCode: 0 },     // rev-parse — wrong branch!
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/Expected HEAD to be on base branch 'main'/);
    expect(r.error).toMatch(/ai\/issue-202/);
    // Must NOT have created a branch
    expect(runner.calls.some((c) => c.args.includes('-b'))).toBe(false);
  });

  test('uses session.baseBranch when set instead of main', async () => {
    const runner = happyRunner(undefined, undefined, 'develop');
    await createImplementationHandler(CONTEXT({ session: SESSION({ baseBranch: 'develop' }) }), runner)(makeTask());
    expect(runner.calls[1]).toMatchObject({ cmd: 'git', args: ['checkout', 'develop'] });
  });

  test('defaults to main when session.baseBranch is not set', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(runner.calls[1]).toMatchObject({ cmd: 'git', args: ['checkout', 'main'] });
  });

  test('gh pr create includes --base with session.baseBranch', async () => {
    const runner = happyRunner(undefined, undefined, 'develop');
    await createImplementationHandler(CONTEXT({ session: SESSION({ baseBranch: 'develop' }) }), runner)(makeTask());
    const ghCall = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    expect(ghCall.args).toContain('--base');
    expect(ghCall.args).toContain('develop');
  });

  test('gh pr create includes --base main by default', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const ghCall = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    expect(ghCall.args).toContain('--base');
    expect(ghCall.args).toContain('main');
  });

  test('gh pr create --title includes issue number and title', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const ghCall = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    const titleIdx = ghCall.args.indexOf('--title');
    const title = ghCall.args[titleIdx + 1];
    expect(title).toContain('77');
    expect(title).toContain('Add login rate limiting');
  });

  test('gh pr create --title falls back to issue number when no title in context', async () => {
    const runner = happyRunner();
    const task = makeTask({ context: { labels: ['agent:claude', 'status:needs-implementation'] } });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const ghCall = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    const titleIdx = ghCall.args.indexOf('--title');
    const title = ghCall.args[titleIdx + 1];
    expect(title).toBeTruthy();
    expect(title).toContain('77');
  });

  test('git add uses explicit paths and excludes artifact dir when artifactRoot is inside repoRoot', async () => {
    const inRepoArtifactRoot = join(repoRoot, '.n8n-artifacts');
    const session = SESSION({ artifactRoot: inRepoArtifactRoot });
    const runner = happyRunner('https://github.com/m2dw/test-repo/pull/99', 'src/foo.ts\0.n8n-artifacts/runs/1/output.md\0');
    await createImplementationHandler(CONTEXT({ session }), runner)(makeTask());
    const addCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'add');
    expect(addCall.cmd).toBe('git');
    expect(addCall.args).toEqual(['add', '--', 'src/foo.ts']);
  });

  test('git add uses explicit paths when artifactRoot is outside repoRoot', async () => {
    // Default SESSION has artifactRoot = join(tmpDir, 'artifacts'), outside repoRoot
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const addCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'add');
    expect(addCall.cmd).toBe('git');
    expect(addCall.args).toEqual(['add', '--', 'src/foo.ts']);
  });

  test('gh pr create receives --repo session.githubRepo', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const ghCall = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    expect(ghCall.cmd).toBe('gh');
    expect(ghCall.args).toContain('--repo');
    expect(ghCall.args).toContain('m2dw/test-repo');
  });
});

// ---------------------------------------------------------------------------
// PR body content
// ---------------------------------------------------------------------------

describe('implementation handler — per-issue worktree execution (issue #454)', () => {
  const worktreePath = () => join(tmpDir, 'wt', 'addon-dev', 'issue-77', 'repo');

  test('runs every git working-tree command in the issue worktree cwd', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    // Preflight + diff/stage/commit/push all run inside the worktree. The git
    // commands that target the canonical checkout are the read-only base-ref refresh
    // (`git fetch`), the canonical-dirty preflight (`git status --porcelain`), and the
    // post-success `git worktree remove` that frees `ai/issue-<n>` for review —
    // all operate on the canonical repo without mutating its working tree (issue #454,
    // issue #571).
    const canonicalFetch = runner.calls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'fetch' && c.opts.cwd === repoRoot,
    );
    expect(canonicalFetch).toHaveLength(1);
    for (const call of runner.calls.filter(
      (c) =>
        c.cmd === 'git' &&
        c.args[0] !== 'fetch' &&
        c.args[0] !== 'worktree' &&
        !(c.args[0] === 'status' && c.opts.cwd === repoRoot),
    )) {
      expect(call.opts.cwd).toBe(wt);
    }
    // The post-success worktree removal frees the issue branch from the canonical
    // repo so the review phase can check it out there (issue #454 review P1).
    const worktreeRemove = runner.calls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    expect(worktreeRemove).toHaveLength(1);
    expect(worktreeRemove[0].args).toEqual(['worktree', 'remove', '--force', '--force', wt]);
    expect(worktreeRemove[0].opts.cwd).toBe(repoRoot);
    // The agent itself runs in the worktree too.
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude');
    expect(claudeCall.opts.cwd).toBe(wt);
  });

  test('resolves the worktree for ai/issue-<n> from origin/<base> in the canonical repo', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true, root: '/abs/worktrees' } });
    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({
      repoRoot,                     // resolved against the canonical checkout
      sessionId: 'addon-dev',
      issueNumber: 77,
      branch: 'ai/issue-77',
      baseRef: 'origin/main',
      worktreeRoot: '/abs/worktrees',
    });
  });

  test('skips the shared-checkout base reset and branch creation in worktree mode', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    // No `git checkout <base>` / `git pull --ff-only` / `git checkout -b` / HEAD verify.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('-b'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'pull')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('--abbrev-ref'))).toBe(false);
    // First git call is the canonical base-ref refresh; then the canonical-dirty
    // preflight; then the worktree dirty preflight; then the agent (issue #454,
    // issue #571).
    expect(runner.calls[0]).toMatchObject({ cmd: 'git', args: ['fetch', 'origin', '+main:refs/remotes/origin/main'] });
    expect(runner.calls[0].opts.cwd).toBe(repoRoot);
    expect(runner.calls[1]).toMatchObject({ cmd: 'git', args: ['status', '--porcelain'] });
    expect(runner.calls[1].opts.cwd).toBe(repoRoot);
    expect(runner.calls[2]).toMatchObject({ cmd: 'git', args: ['status', '--porcelain'] });
    expect(runner.calls[2].opts.cwd).toBe(wt);
    expect(runner.calls[3].cmd).toBe('claude');
  });

  test('dirty canonical checkout blocks implementation even with a clean issue worktree (issue #571)', async () => {
    // A dirty canonical checkout must fail the run regardless of issue-worktree state.
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch (canonical)
      { stdout: ' M README.md', stderr: '', exitCode: 0 },  // git status --porcelain (canonical — DIRTY)
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Canonical checkout is dirty/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
    // The status check ran against the canonical checkout; the issue worktree
    // was never checked (run aborted before reaching it).
    const statusCalls = runner.calls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'status' && c.args.includes('--porcelain'),
    );
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0].opts.cwd).toBe(repoRoot);
  });

  test('a dirty issue worktree still blocks implementation', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main:refs/remotes/origin/main (refresh base) — canonical repo
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY) — in the worktree
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
    // The blocking status check inspected the worktree after the canonical clean check.
    expect(runner.calls[2]).toMatchObject({ cmd: 'git', args: ['status', '--porcelain'] });
    expect(runner.calls[2].opts.cwd).toBe(wt);
  });

  test('a worktree resolution failure fails the phase without running the agent', async () => {
    const runner = worktreeHappyRunner();
    const session = SESSION({ worktrees: { enabled: true } });
    const failingResolver = () => ({ ok: false, error: 'branch ai/issue-77 diverged from origin' });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, failingResolver,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Failed to prepare issue #77 worktree/);
    expect(result.error).toMatch(/diverged from origin/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('worktrees disabled keeps the shared canonical checkout and never resolves a worktree', async () => {
    const runner = happyRunner();
    const resolver = fakeWorktreeResolver(worktreePath());
    // No worktrees block at all (default SESSION) -> shared checkout behavior.
    const result = await createImplementationHandler(
      CONTEXT(), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    expect(resolver.calls).toHaveLength(0);
    // Shared-checkout choreography is intact and runs in the canonical checkout.
    expect(runner.calls[1]).toMatchObject({ cmd: 'git', args: ['checkout', 'main'] });
    for (const call of runner.calls) {
      expect(call.opts.cwd).toBe(repoRoot);
    }
  });

  test('worktrees enabled: false keeps the shared canonical checkout', async () => {
    const runner = happyRunner();
    const resolver = fakeWorktreeResolver(worktreePath());
    const session = SESSION({ worktrees: { enabled: false } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls[1]).toMatchObject({ cmd: 'git', args: ['checkout', 'main'] });
  });

  // Issue #454 review (P1): a worktree-originated implementation leaves
  // `ai/issue-<n>` checked out in the per-issue worktree, so the next needs-fix run
  // for that same PR must reuse that worktree. Falling back to the shared checkout
  // would run `git checkout ai/issue-<n>`, which Git rejects because the branch is
  // already checked out in the worktree — breaking every review/fix cycle.
  test('fix mode on the conventional issue branch runs the followup in the issue worktree (issue #454 review)', async () => {
    const wt = worktreePath();
    // The PR head is the conventional `ai/issue-77` branch (issue 77), so this fix
    // followup is the case the worktree holds. Order: early PR lookup (gh pr list) →
    // local-branch probe (the branch EXISTS here, so no PR-head fetch) →
    // worktree dirty preflight → worktree branch fast-forward → agent →
    // diff/verify/stage/commit/push. There is NO pre-resolveWorktree `git fetch origin
    // ai/issue-77`: with the local branch present, refreshing the remote-tracking ref
    // before the resolver's divergence guard would reject a merely fast-forwardable PR
    // head; the `git pull --ff-only` below performs the reconciliation instead (issue
    // #454 review).
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },              // gh pr list (early fix-mode PR lookup)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },             // git rev-parse --verify refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (clean) — worktree
      { stdout: '', stderr: '', exitCode: 0 },                        // git pull origin ai/issue-77 --ff-only — worktree
      { stdout: 'Applied review feedback.', stderr: '', exitCode: 0 },// claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },          // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                    // verification (npm test)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },            // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                        // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                        // git commit
      { stdout: '', stderr: '', exitCode: 0 },                        // git push
      { stdout: '', stderr: '', exitCode: 0 },                        // git worktree remove --force --force <wt> (free branch) — canonical repo
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    // The worktree was resolved for the issue's own `ai/issue-77` branch, opting into
    // fast-forward tolerance so a behind-origin PR head reaches the `--ff-only` pull
    // instead of failing the resolver's containment guard (issue #454 review P2).
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({
      issueNumber: 77,
      branch: 'ai/issue-77',
      allowFastForward: true,
    });
    // No `git checkout ai/issue-77` — the regression. The branch is the worktree's
    // own HEAD; reconciliation is a `git pull --ff-only` inside the worktree instead.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout')).toBe(false);
    const pull = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'pull');
    expect(pull.args).toEqual(['pull', 'origin', 'ai/issue-77', '--ff-only']);
    expect(pull.opts.cwd).toBe(wt);
    // With the local branch present there is no pre-resolveWorktree fetch (the
    // regression that rejected fast-forwardable PR heads). The only canonical-repo git
    // ops are the read-only local-branch probe and the post-success `git worktree
    // remove` that frees the branch for review; every working-tree git op runs in the
    // worktree (issue #454 review).
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(false);
    const worktreeRemove = runner.calls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    expect(worktreeRemove).toHaveLength(1);
    expect(worktreeRemove[0].args).toEqual(['worktree', 'remove', '--force', '--force', wt]);
    expect(worktreeRemove[0].opts.cwd).toBe(repoRoot);
    // Canonical-repo git ops: the local-branch probe (rev-parse), the canonical-dirty
    // preflight (status --porcelain), and the worktree remove. None mutate the canonical
    // working tree (issue #454, issue #571).
    const canonicalGit = runner.calls.filter((c) => c.cmd === 'git' && c.opts.cwd === repoRoot);
    expect(canonicalGit.map((c) => c.args[0])).toEqual(['rev-parse', 'status', 'worktree']);
    for (const call of runner.calls.filter(
      (c) =>
        c.cmd === 'git' &&
        c.args[0] !== 'worktree' &&
        c.args[0] !== 'rev-parse' &&
        !(c.args[0] === 'status' && c.opts.cwd === repoRoot),
    )) {
      expect(call.opts.cwd).toBe(wt);
    }
    expect(runner.calls.find((c) => c.cmd === 'claude').opts.cwd).toBe(wt);
  });

  test('a dirty issue worktree still blocks a fix-mode followup', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },     // gh pr list (early fix-mode PR lookup)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },    // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS) — canonical
      { stdout: '', stderr: '', exitCode: 0 },               // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },  // git status --porcelain (DIRTY) — worktree
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
    // The blocking status check is the second status call (worktree); the first
    // ran against the canonical checkout and passed.
    const statusCalls = runner.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'status');
    expect(statusCalls).toHaveLength(2);
    expect(statusCalls[0].opts.cwd).toBe(repoRoot);
    expect(statusCalls[1].opts.cwd).toBe(wt);
  });

  // Issue #454 review (P2): on a fresh/single-branch clone the local `ai/issue-77`
  // branch can be absent even though findOpenPr located the PR head, and
  // `refs/remotes/origin/ai/issue-77` is absent too. Without fetching the PR head,
  // resolveWorktree would create `ai/issue-77` fresh from `origin/main`; if the base
  // advanced after the PR branch was cut, the later `git pull origin ai/issue-77
  // --ff-only` cannot fast-forward and strands a stale worktree/local branch that
  // blocks every retry. The handler must fetch the PR head into its remote-tracking
  // ref BEFORE materializing the worktree so the resolver recovers the branch from
  // origin and the `--ff-only` reconciliation is a clean no-op.
  test('fix mode with no local issue branch fetches the PR head before materializing the worktree (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },              // gh pr list (early fix-mode PR lookup)
      { stdout: '', stderr: 'not a valid ref', exitCode: 1 },         // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH ABSENT) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git fetch origin ai/issue-77:refs/remotes/origin/ai/issue-77 — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (clean) — worktree
      { stdout: '', stderr: '', exitCode: 0 },                        // git pull origin ai/issue-77 --ff-only — worktree
      { stdout: 'Applied review feedback.', stderr: '', exitCode: 0 },// claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },          // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                    // verification (npm test)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },            // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                        // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                        // git commit
      { stdout: '', stderr: '', exitCode: 0 },                        // git push
      { stdout: '', stderr: '', exitCode: 0 },                        // git worktree remove --force --force <wt> (free branch) — canonical repo
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    // The PR head was fetched into its remote-tracking ref, in the canonical repo,
    // BEFORE resolveWorktree ran — so the resolver recovers `ai/issue-77` from origin.
    const fetch = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetch.args).toEqual(['fetch', 'origin', 'ai/issue-77:refs/remotes/origin/ai/issue-77']);
    expect(fetch.opts.cwd).toBe(repoRoot);
    const fetchIdx = runner.calls.indexOf(fetch);
    const statusIdx = runner.calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'status');
    expect(fetchIdx).toBeLessThan(statusIdx);
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({ branch: 'ai/issue-77', allowFastForward: true });
    // The fast-forward reconciliation still runs inside the worktree afterward.
    const pull = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'pull');
    expect(pull.args).toEqual(['pull', 'origin', 'ai/issue-77', '--ff-only']);
    expect(pull.opts.cwd).toBe(wt);
  });

  test('fix mode with no local issue branch fails closed when the PR-head fetch fails (issue #454 review)', async () => {
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },              // gh pr list (early fix-mode PR lookup)
      { stdout: '', stderr: 'not a valid ref', exitCode: 1 },         // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH ABSENT) — canonical
      { stdout: '', stderr: 'fatal: couldn\'t find remote ref', exitCode: 1 }, // git fetch origin ai/issue-77:... — FAILS
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/materialize fix worktree from PR head/);
    // Failing before materializing leaves the worktree untouched — no resolver call,
    // no working-tree side effects.
    expect(resolver.calls).toHaveLength(0);
  });

  // Issue #455: a fix followup on a NON-CONVENTIONAL PR head (an externally-created
  // PR whose branch is not `ai/issue-<n>`) now runs in the per-issue worktree too —
  // the worktree checks out, edits, and pushes the LIVE PR head discovered from the
  // PR, not blindly `ai/issue-<n>`. With the local branch present there is no
  // pre-resolveWorktree fetch (a more-advanced remote-tracking ref would only feed
  // the resolver's divergence guard); the `git pull --ff-only` reconciles instead.
  test('fix mode on a non-conventional PR head runs the followup in the issue worktree (issue #455)', async () => {
    const wt = worktreePath();
    // Production reality (issue #455 review): the conventional lookup lists
    // `--head ai/issue-77` and finds NOTHING for an externally-created PR whose head
    // is `feature/custom`. The PR identity is carried in the task context (prUrl), so
    // the handler resolves it with `gh pr view <pr#>` (the PR number extracted from
    // the recorded URL — a provider-neutral selector), which matches any head name.
    const externalPrView = JSON.stringify(
      { number: 44, url: 'https://github.com/m2dw/test-repo/pull/44', headRefName: 'feature/custom', state: 'OPEN' },
    );
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },                      // gh pr list --head ai/issue-77 (conventional lookup) — NONE
      { stdout: externalPrView, stderr: '', exitCode: 0 },           // gh pr view <pr#> (recorded non-conventional PR) — found, open
      { stdout: 'feature/custom', stderr: '', exitCode: 0 },         // git rev-parse --verify refs/heads/feature/custom (LOCAL EXISTS) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (clean) — worktree
      { stdout: '', stderr: '', exitCode: 0 },                        // git pull origin feature/custom --ff-only — worktree
      { stdout: 'Applied review feedback.', stderr: '', exitCode: 0 },// claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },          // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                    // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },            // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                        // git add
      { stdout: '', stderr: '', exitCode: 0 },                        // git commit
      { stdout: '', stderr: '', exitCode: 0 },                        // git push
      { stdout: '', stderr: '', exitCode: 0 },                        // git worktree remove --force --force <wt> — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
        // PR identity recorded by the review handoff for the externally-created PR.
        prUrl: 'https://github.com/m2dw/test-repo/pull/44',
        branch: 'feature/custom',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    // The worktree was resolved for the LIVE PR head (the non-conventional branch),
    // opting into fast-forward tolerance like every fix followup.
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({
      issueNumber: 77,
      branch: 'feature/custom',
      allowFastForward: true,
    });
    // The non-conventional head was resolved by `gh pr view <pr#>`, not the
    // conventional `gh pr list --head ai/issue-77` (which returned NONE). The selector
    // is the PR number extracted from the recorded URL (provider-neutral), not the
    // raw URL (which Gitea's `getPullRequest` could not resolve) — issue #455 review.
    const prView = runner.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view');
    expect(prView.args).toContain('44');
    expect(prView.args).not.toContain('https://github.com/m2dw/test-repo/pull/44');
    // No `git checkout` — the branch is the worktree's own HEAD; reconciliation is a
    // `git pull --ff-only` inside the worktree, and the push targets the live head.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout')).toBe(false);
    const pull = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'pull');
    expect(pull.args).toEqual(['pull', 'origin', 'feature/custom', '--ff-only']);
    expect(pull.opts.cwd).toBe(wt);
    const push = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
    expect(push.args).toEqual(['push', 'origin', 'feature/custom']);
    expect(push.opts.cwd).toBe(wt);
    // Local branch present → no pre-resolveWorktree fetch. The canonical-repo git
    // ops are the read-only branch probe, the preflight dirty check, and the
    // post-success worktree removal.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(false);
    const canonicalGit = runner.calls.filter((c) => c.cmd === 'git' && c.opts.cwd === repoRoot);
    expect(canonicalGit.map((c) => c.args[0])).toEqual(['rev-parse', 'status', 'worktree']);
    expect(runner.calls.find((c) => c.cmd === 'claude').opts.cwd).toBe(wt);
    // The shared fix path's own `gh pr list` is not reached; only the conventional
    // early lookup ran.
    expect(runner.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'list')).toHaveLength(1);
  });

  // Issue #455 review (P2): the conventional lookup is `--state open`, but the
  // non-conventional fallback resolves a recorded PR in ANY state. A recorded prUrl
  // pointing at a CLOSED/merged PR must NOT be adopted as the active fix target —
  // it would push to a dead PR's head. The fallback verifies the PR is open and
  // otherwise fails closed like the conventional path's "no open PR".
  test('fix mode rejects a recorded non-conventional PR that is closed (issue #455 review)', async () => {
    // The conventional lookup finds nothing; the recorded PR resolves but is CLOSED.
    const closedPrView = JSON.stringify(
      { number: 44, url: 'https://github.com/m2dw/test-repo/pull/44', headRefName: 'feature/custom', state: 'CLOSED' },
    );
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },                      // gh pr list --head ai/issue-77 (conventional lookup) — NONE
      { stdout: closedPrView, stderr: '', exitCode: 0 },             // gh pr view <pr#> (recorded PR) — found, but CLOSED
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
        prUrl: 'https://github.com/m2dw/test-repo/pull/44',
        branch: 'feature/custom',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/not open/i);
    // Fails BEFORE materializing the worktree or running the agent.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  // Issue #455: a non-conventional PR head with NO local branch in this clone fetches
  // the live PR head into its remote-tracking ref BEFORE materializing the worktree,
  // so the resolver recovers the branch from origin (not from `origin/<base>`).
  test('fix mode on a non-conventional PR head with no local branch fetches the PR head first (issue #455)', async () => {
    const wt = worktreePath();
    const externalPrView = JSON.stringify(
      { number: 44, url: 'https://github.com/m2dw/test-repo/pull/44', headRefName: 'feature/custom', state: 'OPEN' },
    );
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },                      // gh pr list --head ai/issue-77 (conventional lookup) — NONE
      { stdout: externalPrView, stderr: '', exitCode: 0 },           // gh pr view <pr#> (recorded non-conventional PR) — found, open
      { stdout: '', stderr: 'not a valid ref', exitCode: 1 },         // git rev-parse refs/heads/feature/custom (ABSENT) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git fetch origin feature/custom:refs/remotes/origin/feature/custom — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (clean) — worktree
      { stdout: '', stderr: '', exitCode: 0 },                        // git pull origin feature/custom --ff-only — worktree
      { stdout: 'Applied review feedback.', stderr: '', exitCode: 0 },// claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },          // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                    // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },            // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                        // git add
      { stdout: '', stderr: '', exitCode: 0 },                        // git commit
      { stdout: '', stderr: '', exitCode: 0 },                        // git push
      { stdout: '', stderr: '', exitCode: 0 },                        // git worktree remove --force --force <wt> — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
        // PR identity recorded by the review handoff for the externally-created PR.
        prUrl: 'https://github.com/m2dw/test-repo/pull/44',
        branch: 'feature/custom',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    const fetch = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetch.args).toEqual(['fetch', 'origin', 'feature/custom:refs/remotes/origin/feature/custom']);
    expect(fetch.opts.cwd).toBe(repoRoot);
    const fetchIdx = runner.calls.indexOf(fetch);
    const statusIdx = runner.calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'status');
    expect(fetchIdx).toBeLessThan(statusIdx);
    expect(resolver.calls[0]).toMatchObject({ branch: 'feature/custom', allowFastForward: true });
  });

  // Issue #456 review (P2): a worktree fix followup for a FORKED PR — recorded by the
  // worktree review as a `prUrl`-only handoff (no `branch`, because the head is not an
  // `origin` branch, it lives on the contributor's fork) — must FAIL CLOSED. Its head
  // cannot be pushed back: the only ref that materializes a forked head is
  // `pull/<n>/head`, but the followup's `git push origin <branch>` would push to the
  // BASE repo, creating/advancing an unrelated base-repo branch while the real PR on
  // the fork stays untouched — and the returned context would then route review onto
  // code that is NOT in the PR. Refuse it until the head repo/remote is carried through.
  // The fork is identified by the provider's confirmed `isCrossRepository` flag, NOT by
  // the missing `branch` (a same-repo non-conventional head can also arrive prUrl-only).
  test('worktree fix on a forked PR (prUrl-only handoff) fails closed instead of pushing to the base repo (issue #456 review)', async () => {
    const wt = worktreePath();
    // A forked PR head is the contributor's fork branch name (`patch-1`); there is no
    // `origin/patch-1` branch in this repo, and the provider flags it cross-repository.
    const forkedPrView = JSON.stringify(
      { number: 44, url: 'https://github.com/m2dw/test-repo/pull/44', headRefName: 'patch-1', state: 'OPEN', isCrossRepository: true },
    );
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },                      // gh pr list --head ai/issue-77 (conventional lookup) — NONE
      { stdout: forkedPrView, stderr: '', exitCode: 0 },             // gh pr view 44 (recorded forked PR) — found, open
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
        // Forked-PR handoff records ONLY the prUrl — there is no origin branch to record.
        prUrl: 'https://github.com/m2dw/test-repo/pull/44',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/PR #44/);
    expect(result.error).toMatch(/forked PR|fork/i);
    // It must refuse BEFORE materializing a worktree, fetching, running the agent, or
    // (the actual bug) pushing the fork head to the base repo's origin.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  // Issue #456 review (P2): a SAME-repository non-conventional PR head can also reach
  // the `prUrl`-only handoff shape (no recorded `branch`) — e.g. when a worktree review
  // materialized the head from `prUrl` and the subsequent needs_fix context left
  // `branch` undefined. Its head IS an `origin` branch (`feature/custom`), so fetching
  // and pushing it on origin works. The fix must NOT refuse it as if it were a fork:
  // detection is the provider's confirmed `isCrossRepository` flag, not the missing
  // `branch`. This is the valid fix cycle the prior heuristic wrongly blocked.
  test('worktree fix on a SAME-repo non-conventional PR with a prUrl-only handoff proceeds (issue #456 review)', async () => {
    const wt = worktreePath();
    // Same-repo PR: head `feature/custom` lives on origin; isCrossRepository is false.
    const sameRepoPrView = JSON.stringify(
      { number: 44, url: 'https://github.com/m2dw/test-repo/pull/44', headRefName: 'feature/custom', state: 'OPEN', isCrossRepository: false },
    );
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },                      // gh pr list --head ai/issue-77 (conventional lookup) — NONE
      { stdout: sameRepoPrView, stderr: '', exitCode: 0 },           // gh pr view 44 (recorded prUrl-only PR) — found, open, same-repo
      { stdout: '', stderr: 'not a valid ref', exitCode: 1 },         // git rev-parse refs/heads/feature/custom (ABSENT) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git fetch origin feature/custom:refs/remotes/origin/feature/custom — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (clean) — worktree
      { stdout: '', stderr: '', exitCode: 0 },                        // git pull origin feature/custom --ff-only — worktree
      { stdout: 'Applied review feedback.', stderr: '', exitCode: 0 },// claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },          // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                    // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },            // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                        // git add
      { stdout: '', stderr: '', exitCode: 0 },                        // git commit
      { stdout: '', stderr: '', exitCode: 0 },                        // git push
      { stdout: '', stderr: '', exitCode: 0 },                        // git worktree remove --force --force <wt> — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
        // prUrl-only handoff: the recorded context carries NO `branch`.
        prUrl: 'https://github.com/m2dw/test-repo/pull/44',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    // Not refused: it runs the agent and pushes the resolved head on origin.
    expect(result.result).toBe('success');
    const fetch = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch' && c.args[1] === 'origin' && c.args[2] && c.args[2].startsWith('feature/custom'));
    expect(fetch.args).toEqual(['fetch', 'origin', 'feature/custom:refs/remotes/origin/feature/custom']);
    expect(resolver.calls[0]).toMatchObject({ branch: 'feature/custom', allowFastForward: true });
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(true);
  });

  // Issue #454 review (P3): worktree mode skips the shared `git checkout <base> &&
  // git pull --ff-only`, so it must still refresh the base ref before branching —
  // otherwise a stale `origin/<base>` would start fresh issue branches behind base.
  test('refreshes the base ref in the canonical repo before resolving the worktree (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    // The base refresh is the very first git op and runs in the canonical repo.
    expect(runner.calls[0]).toMatchObject({ cmd: 'git', args: ['fetch', 'origin', '+main:refs/remotes/origin/main'] });
    expect(runner.calls[0].opts.cwd).toBe(repoRoot);
  });

  test('a failed base-ref refresh fails the phase before resolving the worktree or running the agent (issue #454 review)', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: 'fatal: unable to access origin', exitCode: 1 }, // git fetch origin main:refs/remotes/origin/main — fails
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/git fetch origin main \(refresh worktree base\) failed/);
    // Fail closed before materializing the worktree or running the agent.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  // Issue #454 review (P1): a quota/rate-limit delay in worktree mode must NOT reach
  // the shared `git checkout -f <base>` / `git branch -D` cleanup — the base is held
  // by the canonical repo and `ai/issue-<n>` is the durable worktree branch the
  // delayed retry re-materializes. Reset the worktree in place and keep the branch.
  test('quota exhaustion in worktree mode resets the worktree in place and never drops the issue branch (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                     // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (worktree, clean)
      { stdout: '', stderr: 'Error: HTTP 429 rate limit exceeded, try again later', exitCode: 1 }, // claude — quota
      { stdout: '', stderr: '', exitCode: 0 },                     // git add -A (capture partial diff)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },                     // git reset --hard HEAD (worktree-native restore)
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('delayed');
    // Worktree-native reset, not a base checkout, and the durable branch is kept.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'reset' && c.args.includes('--hard'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-f'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
    // Every cleanup git op ran in the worktree, never the canonical checkout.
    // (The preflight `git status --porcelain` on the canonical root is excluded —
    // it is a read-only dirty check, not a cleanup or write op.)
    for (const call of runner.calls.filter((c) => c.cmd === 'git' && c.args[0] !== 'fetch' && c.args[0] !== 'status')) {
      expect(call.opts.cwd).toBe(wt);
    }
  });

  // Issue #454 review (P2): a quota/rate-limit discard keeps `ai/issue-<n>` and its
  // worktree, so the delayed retry REUSES that branch and resolveWorktree ignores the
  // refreshed `origin/<base>` start point. When the discard happened before any commit
  // the branch is an empty placeholder still rooted at the old base; if base advanced
  // during the delay the retry must rebase it onto the just-fetched base — otherwise
  // the retry (and its PR) builds on stale base, unlike the shared-checkout path.
  test('delayed-retry reuse of an empty worktree branch resets it onto the refreshed base (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin main:refs/remotes/origin/main (refresh base) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean) — worktree
      { stdout: '0', stderr: '', exitCode: 0 },                     // git rev-list --count --right-only --cherry-pick origin/main...ai/issue-77 (empty branch)
      { stdout: '', stderr: '', exitCode: 0 },                      // git reset --hard origin/main (refresh empty branch)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // git add
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                      // git worktree remove --force --force <wt> (free branch) — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    // The empty reused branch was probed against the refreshed base and reset onto it,
    // in the worktree — so the retry builds on current base, matching the shared path.
    // The probe uses the cherry-pick symmetric-difference form so a rewritten start ref
    // cannot mask an empty placeholder as having work (issue #458 review).
    const revList = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'rev-list');
    expect(revList.args).toEqual(['rev-list', '--count', '--right-only', '--cherry-pick', 'origin/main...ai/issue-77']);
    expect(revList.opts.cwd).toBe(wt);
    const reset = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'reset' && c.args.includes('origin/main'));
    expect(reset.args).toEqual(['reset', '--hard', 'origin/main']);
    expect(reset.opts.cwd).toBe(wt);
  });

  // Issue #455 review (P2): the recoverable delayed-run variant. A prior delayed/quota
  // run leaves an empty `ai/issue-<n>` branch, but its worktree dir/registration is
  // later removed or pruned, so resolveIssueWorktree RECREATES the checkout from that
  // surviving branch and reports `created: true`. The branch is still reused, so the
  // refresh must still fire — keyed off the resolver's `branchReused` flag, not
  // `created`. Without it the retry would build on the stale old base.
  test('delayed-retry where the branch survives but its pruned worktree is recreated still refreshes onto the base (issue #455 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin main:refs/remotes/origin/main (refresh base) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean) — worktree
      { stdout: '0', stderr: '', exitCode: 0 },                     // git rev-list --count --right-only --cherry-pick origin/main...ai/issue-77 (empty branch)
      { stdout: '', stderr: '', exitCode: 0 },                      // git reset --hard origin/main (refresh empty branch)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // git add
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                      // git worktree remove --force --force <wt> (free branch) — canonical
    ]);
    // created: true (worktree PATH recreated after prune) BUT branchReused: true (the
    // empty ai/issue-77 branch survived the prune and was checked back out).
    const resolver = fakeWorktreeResolver(wt, { created: true, branchReused: true });
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    // The refresh fired despite `created: true`, because `branchReused` is true.
    const revList = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'rev-list');
    expect(revList.args).toEqual(['rev-list', '--count', '--right-only', '--cherry-pick', 'origin/main...ai/issue-77']);
    expect(revList.opts.cwd).toBe(wt);
    const reset = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'reset' && c.args.includes('origin/main'));
    expect(reset.args).toEqual(['reset', '--hard', 'origin/main']);
    expect(reset.opts.cwd).toBe(wt);
  });

  // The complement: a reused branch that already carries work beyond base (the agent
  // committed before the delay, or a fresh `created: true` branch) must NOT be reset —
  // doing so would discard committed work / re-root real progress (issue #454 review).
  test('delayed-retry reuse of a worktree branch with commits is NOT reset to base (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin main:refs/remotes/origin/main — canonical
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean) — worktree
      { stdout: '3', stderr: '', exitCode: 0 },                     // git rev-list --count --right-only --cherry-pick origin/main...ai/issue-77 (has issue commits)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // git add
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                      // git worktree remove --force --force <wt> (free branch) — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    // Probed, found commits beyond base, so the branch was left untouched.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'rev-list')).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'reset')).toBe(false);
  });

  // A freshly created worktree branch (`created: true`) already starts at the
  // just-fetched base, so the new-impl command sequence must stay exactly as before —
  // no extra rev-list/reset probe (issue #454 review).
  test('fresh worktree branch does not run the delayed-retry base-refresh probe (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt); // created: true (fresh)
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'rev-list')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'reset')).toBe(false);
  });

  // Issue #454 review (P1): a Tool Request handoff in worktree mode must preserve
  // `ai/issue-<n>` as the durable continuation point — commit the partial work onto
  // it and push, never `git checkout -f <base>` / `git branch -D`.
  test('a Tool Request handoff in worktree mode commits + pushes the issue branch and never drops it (issue #454 review)', async () => {
    const wt = worktreePath();
    const BLOCK = toolRequestBlock([
      'command: npm install left-pad',
      'reason: The fix depends on left-pad which is not a dependency yet.',
      'expected_files: package.json, package-lock.json',
      'suggested_action: dependencySync',
    ]);
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                     // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (worktree, clean)
      { stdout: BLOCK, stderr: '', exitCode: 0 },                  // claude — emits Tool Request
      { stdout: '', stderr: '', exitCode: 0 },                     // git add -A (capture partial diff)
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n', stderr: '', exitCode: 0 }, // git diff --cached --binary HEAD (work present)
      { stdout: '', stderr: '', exitCode: 0 },                     // git commit --no-verify (preserve onto issue branch)
      { stdout: '', stderr: '', exitCode: 0 },                     // git push origin ai/issue-77
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('tool_request');
    // The durable worktree branch is preserved as the resume point.
    expect(result.context.toolRequest.preservedBranch).toBe('ai/issue-77');
    expect(result.context.toolRequest.preservedBranchPushed).toBe(true);
    expect(result.context.toolRequest.partialDiffArtifact).toBeDefined();
    // The partial work was committed onto the branch and pushed, in the worktree.
    const commit = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'commit');
    expect(commit).toBeDefined();
    expect(commit.opts.cwd).toBe(wt);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(true);
    // Never the shared destructive cleanup.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-f'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
  });

  // Issue #459 review (P2): a Tool Request handoff from a worktree fix that was found
  // from a `prUrl`-only, NON-conventional PR head must PERSIST the resolved live head as
  // `context.branch`. `admin tool-request run/resolve` derives the work branch from
  // `task.context.branch` and otherwise falls back to `ai/issue-<n>`; without persisting
  // it, the granted command would move the issue worktree off the real PR branch and
  // commit/push to the wrong branch.
  test('a Tool Request handoff from a prUrl-only non-conventional fix persists the resolved branch (issue #459 review)', async () => {
    const wt = worktreePath();
    const BLOCK = toolRequestBlock([
      'command: npm install left-pad',
      'reason: The fix depends on left-pad which is not a dependency yet.',
      'expected_files: package.json, package-lock.json',
      'suggested_action: dependencySync',
    ]);
    // Same-repo PR whose head is non-conventional (`feature/custom`), recorded with a
    // prUrl only — no `branch` in context, so the head is resolved live from the PR.
    const sameRepoPrView = JSON.stringify(
      { number: 44, url: 'https://github.com/m2dw/test-repo/pull/44', headRefName: 'feature/custom', state: 'OPEN', isCrossRepository: false },
    );
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },                      // gh pr list --head ai/issue-77 (conventional lookup) — NONE
      { stdout: sameRepoPrView, stderr: '', exitCode: 0 },           // gh pr view 44 — found, open, same-repo
      { stdout: '', stderr: 'not a valid ref', exitCode: 1 },         // git rev-parse refs/heads/feature/custom (ABSENT) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git fetch origin feature/custom:refs/remotes/origin/feature/custom — canonical
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (clean) — worktree
      { stdout: '', stderr: '', exitCode: 0 },                        // git pull origin feature/custom --ff-only — worktree
      { stdout: BLOCK, stderr: '', exitCode: 0 },                    // claude — emits Tool Request
      { stdout: '', stderr: '', exitCode: 0 },                        // git add -A (capture partial diff)
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n', stderr: '', exitCode: 0 }, // git diff --cached --binary HEAD (work present)
      { stdout: '', stderr: '', exitCode: 0 },                        // git commit --no-verify (preserve onto the live head)
      { stdout: '', stderr: '', exitCode: 0 },                        // git push origin feature/custom
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please add a unit test for the limiter.',
        // prUrl-only handoff: NO `branch` recorded — the head is resolved from the PR.
        prUrl: 'https://github.com/m2dw/test-repo/pull/44',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('tool_request');
    // The resolved live head is persisted as the work branch, NOT dropped to the
    // `ai/issue-<n>` fallback — so a later grant lands on the real PR branch.
    expect(result.context.branch).toBe('feature/custom');
    // And it is the same branch the partial work was preserved + pushed onto.
    expect(result.context.toolRequest.preservedBranch).toBe('feature/custom');
    expect(result.context.toolRequest.preservedBranchPushed).toBe(true);
    const push = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
    expect(push.args).toEqual(['push', 'origin', 'feature/custom']);
  });

  // Issue #454 review (P2): a requeued worktree run whose context records a
  // toolRequestResumeBranch must honor it — reconcile the branch and treat a correct
  // no-op (the work is already committed) as a resumed success, not a fresh no-op
  // failure (issue #404).
  test('honors a recorded resume branch in worktree mode: a no-op over committed work succeeds (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // 0  git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// 1  git rev-parse --verify (canonical: local branch present → keep origin/main start point)
      { stdout: '', stderr: '', exitCode: 0 },                      // 2  git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // 3  git status --porcelain (worktree, clean)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// 3  git rev-parse --verify (resume branch exists, in worktree)
      { stdout: '', stderr: '', exitCode: 0 },                      // 4  git checkout ai/issue-77 (no-op in worktree)
      { stdout: 'origin/ai/issue-77', stderr: '', exitCode: 0 },    // 5  git ls-remote --exit-code (origin has it)
      { stdout: '', stderr: '', exitCode: 0 },                      // 6  git fetch origin ai/issue-77
      { stdout: '', stderr: '', exitCode: 0 },                      // 7  git merge --ff-only FETCH_HEAD
      { stdout: '0', stderr: '', exitCode: 0 },                     // 8  git rev-list --count FETCH_HEAD..HEAD (not ahead)
      { stdout: '', stderr: '', exitCode: 0 },                      // 9  claude — no new changes
      { stdout: '', stderr: '', exitCode: 0 },                      // 10 git diff --stat HEAD (empty)
      { stdout: '', stderr: '', exitCode: 0 },                      // 11 git ls-files --others (no untracked)
      { stdout: '', stderr: '', exitCode: 1 },                      // 12 git diff --quiet origin/main...HEAD (has committed changes)
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // 13 verification (npm test)
      { stdout: '', stderr: '', exitCode: 0 },                      // 14 git ls-files --modified... -z (nothing stageable)
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },            // 15 gh pr list (reuse existing PR)
      { stdout: '', stderr: '', exitCode: 0 },                      // 16 git worktree remove --force --force <wt> (free branch) — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-implementation'],
        toolRequestResumeBranch: 'ai/issue-77',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    expect(result.context.resumedNoChanges).toBe(true);
    expect(result.context.prUrl).toBe(EXISTING_PR_URL);
    // The recorded branch was reconciled with origin inside the worktree.
    const ffMerge = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'merge' && c.args.includes('--ff-only'),
    );
    expect(ffMerge).toBeDefined();
    expect(ffMerge.opts.cwd).toBe(wt);
    // The committed-changes probe compared against the FETCHED `origin/<base>`, not
    // the local `baseBranch`. Worktree mode skips the shared checkout's
    // `git checkout <base> && git pull`, so a stale local `main` could make a branch
    // with only upstream base commits look non-empty and wrongly pass the no-op
    // check; comparing against the just-fetched `origin/main` avoids that (issue #454
    // review).
    const diffQuiet = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('--quiet'),
    );
    expect(diffQuiet.args).toEqual(['diff', '--quiet', 'origin/main...HEAD']);
    // No new commit/push: the branch already carries the committed work.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);
  });

  // Issue #454 review (P2): a recorded resume branch that exists ONLY on origin
  // (operator pushed it from another clone, or the local ref was pruned) must
  // become the worktree start point. Otherwise the worktree is branched from
  // `origin/<base>` and the later resume reconciliation can only fast-forward onto
  // the pushed resume head — which fails outright once `<base>` advanced after the
  // resume branch was pushed, dropping a valid recovery point.
  test('origin-only resume branch becomes the worktree start point (not origin/<base>) (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // 0  git fetch origin main:refs/remotes/origin/main (canonical, refresh base)
      { stdout: '', stderr: '', exitCode: 1 },                      // 1  git rev-parse --verify (canonical: local branch ABSENT)
      { stdout: '', stderr: '', exitCode: 0 },                      // 2  git fetch origin ai/issue-77:refs/remotes/... (recover resume head)
      { stdout: '', stderr: '', exitCode: 0 },                      // 3  git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // 4  git status --porcelain (worktree, clean)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// 4  git rev-parse --verify (worktree: branch now present)
      { stdout: '', stderr: '', exitCode: 0 },                      // 5  git checkout ai/issue-77 (no-op in worktree)
      { stdout: 'origin/ai/issue-77', stderr: '', exitCode: 0 },    // 6  git ls-remote --exit-code (origin has it)
      { stdout: '', stderr: '', exitCode: 0 },                      // 7  git fetch origin ai/issue-77
      { stdout: '', stderr: '', exitCode: 0 },                      // 8  git merge --ff-only FETCH_HEAD (no-op: worktree already at resume head)
      { stdout: '0', stderr: '', exitCode: 0 },                     // 9  git rev-list --count FETCH_HEAD..HEAD (not ahead)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // 10 claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // 11 git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // 12 verification (npm test)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // 13 git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // 14 git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                      // 15 git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // 16 git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // 17 gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                      // 18 git worktree remove --force --force <wt> (free branch) — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-implementation'],
        toolRequestResumeBranch: 'ai/issue-77',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    // The canonical clone was probed for the local branch (absent), then the
    // recorded resume branch was fetched into its remote-tracking ref with an
    // explicit refspec so the worktree manager recovers the pushed resume head.
    const localProbe = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'rev-parse' && c.opts.cwd === repoRoot,
    );
    expect(localProbe.args).toEqual(['rev-parse', '--verify', '--quiet', 'refs/heads/ai/issue-77']);
    const resumeFetch = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'fetch' && c.opts.cwd === repoRoot
        && c.args[2] && c.args[2].includes(':refs/remotes/origin/')
        // Exclude the canonical base refresh, which now uses a `+<base>:refs/...`
        // refspec (issue #457 review P2); the resume recovery fetch has no `+`.
        && !c.args[2].startsWith('+'),
    );
    expect(resumeFetch.args).toEqual(['fetch', 'origin', 'ai/issue-77:refs/remotes/origin/ai/issue-77']);
    // The worktree start point is the pushed resume head, NOT origin/<base>.
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({ branch: 'ai/issue-77', baseRef: 'origin/ai/issue-77' });
  });

  // The recovery fetch must fail closed rather than fall through to `origin/<base>`
  // and silently discard the pushed Tool Request side effects (issue #454 review).
  test('a failed origin-only resume fetch fails the phase before resolving the worktree or running the agent (issue #454 review)', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                          // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 1 },                          // git rev-parse --verify (local branch absent)
      { stdout: '', stderr: 'fatal: couldn\'t find remote ref', exitCode: 1 }, // git fetch origin ai/issue-77:refs/... — fails
    ]);
    const resolver = fakeWorktreeResolver(worktreePath());
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-implementation'],
        toolRequestResumeBranch: 'ai/issue-77',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/recover origin-only Tool Request resume branch/);
    // Fail closed before materializing the worktree or running the agent.
    expect(resolver.calls).toHaveLength(0);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  // A recorded resume branch that ALREADY exists locally must keep the existing
  // behavior: no extra remote-tracking-ref fetch, and the worktree start point
  // stays `origin/<base>` (the worktree manager checks out the existing branch).
  test('a recorded resume branch present locally keeps origin/<base> as the start point (no recovery fetch) (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // 0  git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// 1  git rev-parse --verify (canonical: local branch PRESENT)
      { stdout: '', stderr: '', exitCode: 0 },                      // 2  git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // 3  git status --porcelain (worktree, clean)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// 3  git rev-parse --verify (worktree)
      { stdout: '', stderr: '', exitCode: 0 },                      // 4  git checkout ai/issue-77
      { stdout: 'origin/ai/issue-77', stderr: '', exitCode: 0 },    // 5  git ls-remote --exit-code
      { stdout: '', stderr: '', exitCode: 0 },                      // 6  git fetch origin ai/issue-77
      { stdout: '', stderr: '', exitCode: 0 },                      // 7  git merge --ff-only FETCH_HEAD
      { stdout: '0', stderr: '', exitCode: 0 },                     // 8  git rev-list --count FETCH_HEAD..HEAD
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // 9  claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // 10 git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // 11 verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // 12 git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // 13 git add
      { stdout: '', stderr: '', exitCode: 0 },                      // 14 git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // 15 git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // 16 gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                      // 17 git worktree remove --force --force <wt> (free branch) — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-implementation'],
        toolRequestResumeBranch: 'ai/issue-77',
      },
    });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    // No remote-tracking-ref recovery fetch for the issue branch when it already exists locally.
    const recoveryFetch = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'fetch' && c.args[2] && c.args[2].includes(':refs/remotes/origin/')
        // Exclude the canonical base refresh (`+<base>:refs/...`, issue #457 review P2);
        // a real recovery fetch uses a non-`+` refspec.
        && !c.args[2].startsWith('+'),
    );
    expect(recoveryFetch).toBeUndefined();
    // Start point stays origin/<base>; the worktree manager checks out the local branch.
    expect(resolver.calls[0]).toMatchObject({ branch: 'ai/issue-77', baseRef: 'origin/main' });
    // But the resolver MUST opt into fast-forward tolerance for a recorded resume
    // branch (issue #454 review P2). If the operator pushed the Tool Request side
    // effects from another clone and this clone already fetched — advancing
    // origin/ai/issue-77 past the local branch — the resolver's strict containment
    // guard would reject the fast-forwardable local branch before
    // resumeFromToolRequestBranch could `git merge --ff-only` it, stranding the
    // resolved request. Genuine divergence is still rejected by the resolver and by
    // the --ff-only reconciliation.
    expect(resolver.calls[0].allowFastForward).toBe(true);
  });

  // Issue #454 review (P1): a successful worktree run leaves `ai/issue-<n>` checked
  // out in the per-issue worktree; the downstream review phase checks out that branch
  // in the canonical checkout, which Git refuses while the worktree holds it. If the
  // post-success `git worktree remove` cannot free the branch, fail the phase with a
  // clear error rather than report success and leave review to die on the held branch.
  test('a failed worktree removal fails the phase so review is not left to break on the held branch (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (worktree, clean)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // git add
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
      { stdout: '', stderr: 'fatal: cannot remove a locked working tree', exitCode: 1 }, // git worktree remove — FAILS
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/freeing the issue worktree/);
    expect(result.error).toMatch(/ai\/issue-77/);
    // The work was still committed and pushed before the removal was attempted, so the
    // failure is recoverable — the PR carries the implementation.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(true);
  });

  // Issue #454 review (P2): only the fix-followup path (which reconciles with a later
  // `git pull --ff-only`) opts into the resolver's fast-forward tolerance. A new
  // implementation keeps the strict containment guard so a leftover diverged ref still
  // fails closed.
  test('new implementation does not opt into the resolver fast-forward tolerance (issue #454 review)', async () => {
    const wt = worktreePath();
    const runner = worktreeHappyRunner();
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0].allowFastForward).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-issue worktree branch-start parity (issue #455)
//
// #454 ran the simple non-stacked NEW path and the conventional fix followup in the
// worktree. #455 brings the remaining shared-checkout branch-start semantics into
// worktree mode: a dependency-stacked new implementation starts the worktree branch
// from the blocker PR head (not the base), and the delayed-retry refresh of an empty
// reused branch uses that same blocker head. (Non-conventional / live PR head fix
// followups are covered in the #454 worktree describe above.)
// ---------------------------------------------------------------------------
describe('implementation handler — per-issue worktree branch-start parity (issue #455)', () => {
  const worktreePath = () => join(tmpDir, 'wt', 'addon-dev', 'issue-77', 'repo');
  const BLOCKER_HEAD = 'ai/issue-50';
  const BLOCKER_PR_URL = 'https://github.com/m2dw/test-repo/pull/55';
  const BLOCKER_PR = {
    number: 55, url: BLOCKER_PR_URL, headRefName: BLOCKER_HEAD,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  };
  const STACK_READY_LABEL = 'status:stack-ready';
  const oneOpenBlockerDepChecker = {
    async getBlockedBy() { return [{ issueNumber: 50, state: 'open' }]; },
  };
  const issueViewJson = (labels) => JSON.stringify({ labels: labels.map((name) => ({ name })) });

  // A dependency-stacked NEW implementation runs in the worktree, branching
  // `ai/issue-77` from the blocker PR head (issue #455 AC: "can start from a
  // dependency PR head when the issue is unblocked by a ready blocker PR").
  test('dependency-stacked new implementation starts the worktree branch from the blocker PR head', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify([BLOCKER_PR]), stderr: '', exitCode: 0 },        // gh pr list (dep check — first)
      { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 },  // gh issue view (dep check)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git fetch origin +ai/issue-50:refs/remotes/origin/ai/issue-50 — canonical (blocker start point)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status --porcelain (clean) — worktree
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },              // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },                   // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                              // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },                      // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                  // git add
      { stdout: '', stderr: '', exitCode: 0 },                                  // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                  // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                                  // git worktree remove --force --force <wt> — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, oneOpenBlockerDepChecker, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    // The worktree branch is `ai/issue-77` but its START POINT is the blocker head.
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({
      issueNumber: 77,
      branch: 'ai/issue-77',
      baseRef: `origin/${BLOCKER_HEAD}`,
    });
    // The blocker head is fetched into its remote-tracking ref (explicit,
    // force-updating `+` refspec so a force-pushed blocker head does not reject as
    // non-fast-forward) in the canonical repo BEFORE the worktree is resolved; the
    // base is NOT fetched.
    const fetch = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetch.args).toEqual([
      'fetch', 'origin', `+${BLOCKER_HEAD}:refs/remotes/origin/${BLOCKER_HEAD}`,
    ]);
    expect(fetch.opts.cwd).toBe(repoRoot);
    expect(runner.calls.some(
      (c) => c.cmd === 'git' && c.args[0] === 'fetch' && c.args[1] === 'origin' && c.args[2] === 'main',
    )).toBe(false);
    // The worktree manager owns branch setup, so there is no `git checkout -b`.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('-b'))).toBe(false);
    // The agent + push run inside the worktree, on the conventional issue branch.
    expect(runner.calls.find((c) => c.cmd === 'claude').opts.cwd).toBe(wt);
    const push = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
    expect(push.args).toEqual(['push', 'origin', 'ai/issue-77']);
    expect(push.opts.cwd).toBe(wt);
    // The dependent PR still targets the session base branch, NOT the blocker head.
    const ghCreate = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    expect(ghCreate.args[ghCreate.args.indexOf('--base') + 1]).toBe('main');
    expect(ghCreate.args).not.toContain(BLOCKER_HEAD);
    // Dependency base metadata is recorded as in the shared path.
    expect(result.context?.dependencyBase).toMatchObject({
      baseIssueNumber: 50, basePrNumber: 55, baseHeadRefName: BLOCKER_HEAD, basePrUrl: BLOCKER_PR_URL,
    });
  });

  // A quota/rate-limit discard keeps the stacked `ai/issue-77` worktree, so the
  // delayed retry REUSES the branch; an empty (pre-commit) reuse must reset onto the
  // refreshed BLOCKER head — not `origin/<base>` — so the dependency start point is
  // not bypassed on retry (issue #455).
  test('delayed-retry reuse of an empty stacked worktree branch resets onto the refreshed blocker head', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify([BLOCKER_PR]), stderr: '', exitCode: 0 },        // gh pr list (dep check)
      { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 },  // gh issue view (dep check)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git fetch origin ai/issue-50:... — canonical
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status --porcelain (clean) — worktree
      { stdout: '0', stderr: '', exitCode: 0 },                                 // git rev-list --count --right-only --cherry-pick origin/ai/issue-50...ai/issue-77 (empty)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git reset --hard origin/ai/issue-50 (worktree)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },              // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },                   // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                              // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },                      // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                  // git add
      { stdout: '', stderr: '', exitCode: 0 },                                  // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                  // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                                  // git worktree remove --force --force <wt> — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, oneOpenBlockerDepChecker, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    // The emptiness probe and the reset both use the blocker head, not the base.
    const revList = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'rev-list');
    expect(revList.args).toEqual([
      'rev-list', '--count', '--right-only', '--cherry-pick', `origin/${BLOCKER_HEAD}...ai/issue-77`,
    ]);
    const reset = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'reset');
    expect(reset.args).toEqual(['reset', '--hard', `origin/${BLOCKER_HEAD}`]);
    expect(reset.opts.cwd).toBe(wt);
    expect(runner.calls.some(
      (c) => c.cmd === 'git' && c.args[0] === 'reset' && c.args.includes('origin/main'),
    )).toBe(false);
  });

  // Issue #458 review (P2): the blocker PR head was force-pushed / rebased during the
  // delay, so the refreshed `origin/<blocker>` is a new lineage while the empty
  // placeholder `ai/issue-77` still sits on the OLD blocker head. A plain two-dot
  // `origin/<blocker>..ai/issue-77` count would report those old blocker commits as work
  // "ahead" of the new start point and SKIP the reset, leaving the retry stacked on stale
  // blocker code. The `--right-only --cherry-pick` symmetric-difference probe cancels the
  // rebased blocker commits (patch-equivalent on both sides), reports 0, and the reset
  // fires onto the refreshed blocker head — restoring parity with the shared path.
  test('delayed-retry of an empty stacked branch resets even when the blocker head was force-pushed (issue #458 review)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: JSON.stringify([BLOCKER_PR]), stderr: '', exitCode: 0 },        // gh pr list (dep check)
      { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 },  // gh issue view (dep check)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git fetch origin +ai/issue-50:... (force-updating refspec) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status --porcelain (clean) — worktree
      // The placeholder still holds the OLD blocker commits, but they are patch-equivalent
      // to the rebased blocker head, so the cherry-pick probe reports 0 issue commits.
      { stdout: '0', stderr: '', exitCode: 0 },                                 // git rev-list --count --right-only --cherry-pick origin/ai/issue-50...ai/issue-77
      { stdout: '', stderr: '', exitCode: 0 },                                  // git reset --hard origin/ai/issue-50 (worktree)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },              // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },                   // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                              // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },                      // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                  // git add
      { stdout: '', stderr: '', exitCode: 0 },                                  // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                  // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                                  // git worktree remove --force --force <wt> — canonical
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, oneOpenBlockerDepChecker, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    // The probe uses the cherry-pick symmetric-difference form against the refreshed
    // blocker head; despite the placeholder carrying old blocker commits it reports empty,
    // so the reset fires onto the refreshed blocker head (not the base).
    const revList = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'rev-list');
    expect(revList.args).toEqual([
      'rev-list', '--count', '--right-only', '--cherry-pick', `origin/${BLOCKER_HEAD}...ai/issue-77`,
    ]);
    const reset = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'reset');
    expect(reset.args).toEqual(['reset', '--hard', `origin/${BLOCKER_HEAD}`]);
    expect(reset.opts.cwd).toBe(wt);
  });
});

// ---------------------------------------------------------------------------
// Issue #470 (supersedes #442 / PR #468): rebuild the implementation cleanup
// worktree-native on top of the completed #454-#459 split stack. The cleanup
// helpers (failAfterBranch / restoreWorktreeToBase / discardEditsToBase /
// handoffCleanup) and the success-path `git worktree remove` were made
// worktree-aware as a necessary part of running implementation INSIDE the
// per-issue worktree (#454/#455), so the code lives above. What the earlier
// worktree tests assert is that the durable BRANCH is preserved and the
// destructive SHARED-checkout ops (`git checkout -f <base>`, `git branch -D`)
// never run in worktree mode. They do not yet pin the other half of #470's
// acceptance criteria: that the issue WORKTREE DIRECTORY itself survives a
// Tool Request handoff and a quota/rate-limit delayed retry — i.e. the
// success-only `git worktree remove` (which frees the branch for review) is
// NOT invoked on a continuation-preservation path, so a later grant / delayed
// retry re-enters the same durable worktree instead of re-materializing it.
// These tests lock that in explicitly.
// ---------------------------------------------------------------------------
describe('implementation handler — worktree-native cleanup continuation preservation (issue #470)', () => {
  const worktreePath = () => join(tmpDir, 'wt', 'addon-dev', 'issue-77', 'repo');

  const worktreeRemoveCalls = (runner) =>
    runner.calls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove',
    );

  test('a Tool Request handoff in worktree mode preserves the issue worktree (never `git worktree remove`)', async () => {
    const wt = worktreePath();
    const BLOCK = toolRequestBlock([
      'command: npm install left-pad',
      'reason: The fix depends on left-pad which is not a dependency yet.',
      'expected_files: package.json, package-lock.json',
      'suggested_action: dependencySync',
    ]);
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                     // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (worktree, clean)
      { stdout: BLOCK, stderr: '', exitCode: 0 },                  // claude — emits Tool Request
      { stdout: '', stderr: '', exitCode: 0 },                     // git add -A (capture partial diff)
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n', stderr: '', exitCode: 0 }, // git diff --cached --binary HEAD (work present)
      { stdout: '', stderr: '', exitCode: 0 },                     // git commit --no-verify (preserve onto issue branch)
      { stdout: '', stderr: '', exitCode: 0 },                     // git push origin ai/issue-77
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('tool_request');
    // The issue worktree materialized for this run is the durable resume point:
    // the success-only branch-freeing `git worktree remove` must NOT run, so a
    // later grant re-enters the SAME worktree with the preserved partial work.
    expect(worktreeRemoveCalls(runner)).toHaveLength(0);
    // The branch is likewise kept (belt-and-suspenders with the #454 handoff test).
    expect(result.context.toolRequest.preservedBranch).toBe('ai/issue-77');
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
  });

  test('a quota/rate-limit delayed retry in worktree mode preserves the issue worktree (never `git worktree remove`)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                     // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (worktree, clean)
      { stdout: '', stderr: 'Error: HTTP 429 rate limit exceeded, try again later', exitCode: 1 }, // claude — quota
      { stdout: '', stderr: '', exitCode: 0 },                     // git add -A (capture partial diff)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },                     // git reset --hard HEAD (worktree-native restore)
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('delayed');
    // The delayed retry re-queues the SAME implementation run, which re-enters
    // this durable worktree — so the branch-freeing `git worktree remove` must
    // NOT run here, and neither must the shared destructive cleanup ops.
    expect(worktreeRemoveCalls(runner)).toHaveLength(0);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-f'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
  });

  test('a late (post-branch) failure in worktree mode preserves the worktree and never quarantines', async () => {
    const wt = worktreePath();
    // Fail at `gh pr create` — a late step reached only after commit + push, so
    // the shared-checkout path would restore-to-base or quarantine. In worktree
    // mode the durable worktree is the continuation point: no worktree removal,
    // no base restore, no quarantine marker (a shared-checkout backstop only).
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                     // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                     // git status --porcelain (worktree, clean)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 }, // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },      // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                 // verification (npm test)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },         // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                     // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                     // git commit
      { stdout: '', stderr: '', exitCode: 0 },                     // git push
      { stdout: '', stderr: 'gh: could not create pull request', exitCode: 1 }, // gh pr create — FAILS
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('failed');
    // The isolated worktree stays intact as the continuation point: no removal,
    // and none of the shared-checkout restore-to-base / branch-drop cleanup.
    expect(worktreeRemoveCalls(runner)).toHaveLength(0);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-f'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('main'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
    // The quarantine marker is a shared-checkout backstop only — never written in
    // worktree mode, so a later run does not fail closed on a phantom quarantine.
    expect(existsSync(join(artifactRoot, 'implementation-quarantine.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verification-failure dirty state recording in per-issue worktrees (issue #568)
//
// When verification fails before commit/push in a per-issue worktree the handler
// records a structured dirtyContinuation marker in the returned context so that
// the next phase attempt can distinguish "dirty from a known prior failure" from
// "dirty for an unknown reason".  A patch artifact is also written for operator
// inspection.  The canonical/shared-checkout path must remain unaffected.
// ---------------------------------------------------------------------------
describe('implementation handler — verification-failure dirty state recording (issue #568)', () => {
  const worktreePath = () => join(tmpDir, 'wt', 'addon-dev', 'issue-77', 'repo');

  // Runner steps up to (and including) the second failed verification in worktree
  // mode.  Two more steps follow in each test: git status --porcelain -z (dirty state
  // capture) and git diff HEAD (patch).
  function worktreeUpToVerificationFailure(firstVerResult, repairVerResult) {
    return [
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (clean) — worktree preflight
      { stdout: 'done', stderr: '', exitCode: 0 },          // claude (initial agent)
      { stdout: '1 file changed', stderr: '', exitCode: 0 }, // git diff --stat HEAD
      firstVerResult,                                        // npm test — first verification (fails)
      { stdout: 'repaired', stderr: '', exitCode: 0 },      // claude (repair agent)
      repairVerResult,                                       // npm test — second verification (still fails)
    ];
  }

  test('records dirtyContinuation in context when verification fails in worktree mode', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      ...worktreeUpToVerificationFailure(
        { stdout: 'FAIL: assertion x', stderr: '', exitCode: 1 },
        { stdout: 'FAIL: assertion x', stderr: '', exitCode: 1 },
      ),
      { stdout: ' M src/foo.ts\0 M src/bar.ts\0', stderr: '', exitCode: 0 }, // git status --porcelain -z (dirty)
      { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+added\n', stderr: '', exitCode: 0 }, // git diff HEAD
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.context?.dirtyContinuation).toMatchObject({
      issueNumber: 77,
      phase: 'implementation',
      runId: 'run-impl-1',
      branch: 'ai/issue-77',
      worktreeId: 'addon-dev/issue-77',
      verificationName: 'test',
      verificationExitCode: 1,
      commitSkipped: true,
    });
    expect(result.context.dirtyContinuation.dirtyFiles).toContain('src/foo.ts');
    expect(result.context.dirtyContinuation.dirtyFiles).toContain('src/bar.ts');
    expect(result.context.dirtyContinuation.patchArtifactFile).toBe('implementation-dirty-patch.patch');
    expect(typeof result.context.dirtyContinuation.timestamp).toBe('string');
  });

  test('writes a patch artifact to the artifact dir when verification fails in worktree mode', async () => {
    const wt = worktreePath();
    const patchContent = 'diff --git a/src/foo.ts b/src/foo.ts\n+added line\n';
    const runner = sequenceRunner([
      ...worktreeUpToVerificationFailure(
        { stdout: 'FAIL', stderr: '', exitCode: 1 },
        { stdout: 'FAIL', stderr: '', exitCode: 1 },
      ),
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 }, // git status --porcelain -z (dirty)
      { stdout: patchContent, stderr: '', exitCode: 0 },      // git diff HEAD (patch)
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    const patchPath = join(artifactRoot, 'runs', 'run-impl-1', 'implementation-dirty-patch.patch');
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, 'utf8')).toBe(patchContent);
  });

  test('dirty state git commands target the worktree cwd, not the canonical checkout', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      ...worktreeUpToVerificationFailure(
        { stdout: 'FAIL', stderr: '', exitCode: 1 },
        { stdout: 'FAIL', stderr: '', exitCode: 1 },
      ),
      { stdout: '', stderr: '', exitCode: 0 }, // git status --porcelain -z
      { stdout: '', stderr: '', exitCode: 0 }, // git diff HEAD
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    // Three status --porcelain calls: canonical-clean check (index 0, cwd=repoRoot),
    // worktree preflight (index 1, cwd=wt), and dirty-capture (index 2, cwd=wt).
    const statusCalls = runner.calls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'status' && c.args.includes('--porcelain'),
    );
    expect(statusCalls).toHaveLength(3);
    expect(statusCalls[2].opts.cwd).toBe(wt);
    // The dirty-capture call must use -z (NUL-delimited) so quoted paths (spaces,
    // non-ASCII) are never mangled, and --untracked-files=all so files inside newly
    // created directories are listed individually rather than as "?? dir/".
    expect(statusCalls[2].args).toContain('-z');
    expect(statusCalls[2].args).toContain('--untracked-files=all');

    const diffHeadCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'diff' && c.args[1] === 'HEAD' && c.args.length === 2,
    );
    expect(diffHeadCall).toBeDefined();
    expect(diffHeadCall.opts.cwd).toBe(wt);
  });

  test('includes untracked files in the patch artifact when verification fails in worktree mode', async () => {
    const wt = worktreePath();
    // Write an untracked file so readFileSync can read it when building the patch.
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'new-feature.ts'), 'export const x = 1;\n', 'utf8');
    const runner = sequenceRunner([
      ...worktreeUpToVerificationFailure(
        { stdout: 'FAIL', stderr: '', exitCode: 1 },
        { stdout: 'FAIL', stderr: '', exitCode: 1 },
      ),
      { stdout: '?? src/new-feature.ts\0', stderr: '', exitCode: 0 }, // git status --porcelain -z (untracked only)
      { stdout: '', stderr: '', exitCode: 0 },                         // git diff HEAD (empty — no tracked changes)
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    const patchPath = join(artifactRoot, 'runs', 'run-impl-1', 'implementation-dirty-patch.patch');
    expect(existsSync(patchPath)).toBe(true);
    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('diff --git a/src/new-feature.ts b/src/new-feature.ts');
    expect(patchContent).toContain('+export const x = 1;');
  });

  test('includes files inside newly created directories in the patch artifact', async () => {
    // Regression test: when a failed implementation creates a brand-new directory,
    // `git status --porcelain` (without --untracked-files=all) reports only "?? dir/"
    // instead of "?? dir/file.ts". The handler must use --untracked-files=all so
    // individual files are enumerated and their contents appear in the patch artifact.
    const wt = worktreePath();
    mkdirSync(join(wt, 'src', 'generated'), { recursive: true });
    writeFileSync(join(wt, 'src', 'generated', 'foo.ts'), 'export const foo = 42;\n', 'utf8');
    const runner = sequenceRunner([
      ...worktreeUpToVerificationFailure(
        { stdout: 'FAIL', stderr: '', exitCode: 1 },
        { stdout: 'FAIL', stderr: '', exitCode: 1 },
      ),
      // Simulates what --untracked-files=all returns: individual file, not the directory.
      { stdout: '?? src/generated/foo.ts\0', stderr: '', exitCode: 0 }, // git status --porcelain -z --untracked-files=all
      { stdout: '', stderr: '', exitCode: 0 },                           // git diff HEAD (empty)
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });
    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask());

    const patchPath = join(artifactRoot, 'runs', 'run-impl-1', 'implementation-dirty-patch.patch');
    expect(existsSync(patchPath)).toBe(true);
    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('diff --git a/src/generated/foo.ts b/src/generated/foo.ts');
    expect(patchContent).toContain('+export const foo = 42;');
  });

  test('dirtyContinuation is absent from context when verification fails in shared-checkout mode', async () => {
    // Non-worktree (shared checkout) verification failure — existing behavior must be
    // byte-for-byte unchanged: no extra git calls and no dirtyContinuation in context.
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git status (clean)
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },          // git rev-parse HEAD
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout -b
      { stdout: 'done', stderr: '', exitCode: 0 },          // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 }, // git diff --stat HEAD
      { stdout: 'FAIL', stderr: '', exitCode: 1 },          // npm test (first verification fails)
      { stdout: 'repair', stderr: '', exitCode: 0 },        // repair claude
      { stdout: 'FAIL', stderr: '', exitCode: 1 },          // npm test (second verification fails)
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('failed');
    expect(result.context?.dirtyContinuation).toBeUndefined();
    // No git status or diff HEAD called beyond the initial preflight
    const statusCalls = runner.calls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'status' && c.args.includes('--porcelain'),
    );
    expect(statusCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dirty continuation in per-issue worktrees (issue #571)
//
// When a previous implementation run recorded a dirtyContinuation marker after a
// verification failure, the next attempt is allowed to continue from the existing
// uncommitted edits rather than aborting on a dirty tree. The safety checks must
// still reject unrecognized dirty state (no marker, mismatched issue/branch/worktree,
// or missing patch artifact). The implementation prompt must include the prior
// verification failure context so the agent knows what to fix.
// ---------------------------------------------------------------------------
describe('implementation handler — dirty continuation in per-issue worktrees (issue #571)', () => {
  const worktreePath = () => join(tmpDir, 'wt', 'addon-dev', 'issue-77', 'repo');

  // Patch content stored by a prior run — used in the content drift check.
  // Both the stored artifact file and the runner's git diff HEAD response must
  // return this exact content for the safe-continuation path to pass.
  const DIRTY_CONTINUATION_PATCH = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' export function foo() {',
    '+  // prior unfinished edit',
    '   return 42;',
    ' }',
    '',
  ].join('\n');

  // Create the prior run's artifact directory and patch file before each test so
  // the content drift check can read the stored patch when it needs to.
  beforeEach(() => {
    const priorDir = join(artifactRoot, 'runs', 'run-prev-1');
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, 'implementation-dirty-patch.patch'), DIRTY_CONTINUATION_PATCH, 'utf8');
  });

  // A valid dirtyContinuation marker as recorded by the issue #568 handler.
  function makeDirtyContinuation(overrides = {}) {
    return {
      issueNumber: 77,
      phase: 'implementation',
      runId: 'run-prev-1',
      branch: 'ai/issue-77',
      worktreeId: 'addon-dev/issue-77',
      verificationName: 'test',
      verificationExitCode: 1,
      dirtyFiles: ['src/foo.ts'],
      patchArtifactFile: 'implementation-dirty-patch.patch',
      timestamp: '2026-01-01T00:00:00.000Z',
      commitSkipped: true,
      ...overrides,
    };
  }

  // Task with dirtyContinuation in context (simulates next attempt after a
  // verification-failure run recorded it).
  function makeDirtyTask(dirtyCtxOverrides = {}) {
    return makeTask({
      context: {
        ...makeTask().context,
        verificationFailure: { name: 'test', exitCode: 1 },
        verificationFeedback: 'FAIL: 1 test failed\n  ● my test',
        dirtyContinuation: makeDirtyContinuation(dirtyCtxOverrides),
      },
    });
  }

  // Runner for a successful dirty-continuation new-impl run in worktree mode.
  // Step 1 returns DIRTY; the handler allows it via dirtyContinuation and skips
  // the empty-branch reset probe (activeDirtyContinuation guards it).
  function dirtyContinuationRunner(prUrl = 'https://github.com/m2dw/test-repo/pull/99') {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                              // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                              // git status --porcelain (canonical — CLEAN, required by #571)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },                 // git status --porcelain (DIRTY — allowed via dirtyContinuation)
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 },               // git status --porcelain -z --untracked-files=all (drift check — file set unchanged)
      { stdout: DIRTY_CONTINUATION_PATCH, stderr: '', exitCode: 0 },        // git diff HEAD (content drift check — matches stored patch)
      { stdout: 'Continued edits.', stderr: '', exitCode: 0 },              // claude (runs with dirty tree)
      { stdout: '1 file changed', stderr: '', exitCode: 0 },                // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                          // npm test (verification passes this time)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },                  // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                              // git add
      { stdout: '', stderr: '', exitCode: 0 },                              // git commit
      { stdout: '', stderr: '', exitCode: 0 },                              // git push
      { stdout: prUrl, stderr: '', exitCode: 0 },                           // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                              // git worktree remove (canonical)
    ]);
  }

  test('safe dirty continuation allows implementation to proceed (agent runs)', async () => {
    const wt = worktreePath();
    const runner = dirtyContinuationRunner();
    // branchReused: true because the prior run left the branch in place
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeDirtyTask());

    expect(result.result).toBe('success');
    // Agent ran despite the dirty tree.
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(true);
    // The empty-branch reset probe (rev-list → reset --hard) must NOT have run;
    // it would discard the dirty continuation edits (issue #571).
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'rev-list')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'reset')).toBe(false);
  });

  test('continuation prompt includes a Continuation Context section', async () => {
    const wt = worktreePath();
    const runner = dirtyContinuationRunner();
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });

    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeDirtyTask());

    const prompt = readFileSync(
      join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8',
    );
    expect(prompt).toContain('## Continuation Context');
    expect(prompt).toContain('prior implementation attempt');
    expect(prompt).toContain('existing changes');
  });

  test('continuation prompt includes prior verification failure name, exit code, and output', async () => {
    const wt = worktreePath();
    const runner = dirtyContinuationRunner();
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });

    await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeDirtyTask());

    const prompt = readFileSync(
      join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8',
    );
    expect(prompt).toContain('Prior Verification Failure: test (exit 1)');
    expect(prompt).toContain('FAIL: 1 test failed');
    expect(prompt).toContain('● my test');
  });

  test('dirty worktree without dirtyContinuation still fails (regression guard)', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY, no marker)
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const session = SESSION({ worktrees: { enabled: true } });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeTask()); // plain task: no dirtyContinuation

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('issue number mismatch in dirtyContinuation fails closed', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    // dirtyContinuation for a DIFFERENT issue
    const task = makeDirtyTask({ issueNumber: 999 });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('branch mismatch in dirtyContinuation fails closed', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    // dirtyContinuation for a different branch name
    const task = makeDirtyTask({ branch: 'ai/issue-999' });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('missing patchArtifactFile in dirtyContinuation fails closed', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    // dirtyContinuation without patchArtifactFile (capture failed)
    const task = makeTask({
      context: {
        ...makeTask().context,
        dirtyContinuation: {
          issueNumber: 77, phase: 'implementation', runId: 'run-prev-1',
          branch: 'ai/issue-77', worktreeId: 'addon-dev/issue-77',
          verificationName: 'test', verificationExitCode: 1,
          dirtyFiles: ['src/foo.ts'],
          // patchArtifactFile deliberately absent
          timestamp: '2026-01-01T00:00:00.000Z',
          commitSkipped: true,
        },
      },
    });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('patchArtifactFile present but runId missing in dirtyContinuation fails closed', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY)
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 }, // git status -z (file set drift check — matches)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    // patchArtifactFile is present (so isValidDirtyContinuation passes) but runId is absent
    const task = makeDirtyTask({ runId: undefined });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/patchArtifactFile.*no valid runId|no valid runId.*patchArtifactFile/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('commitSkipped: false in dirtyContinuation fails closed', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeDirtyTask({ commitSkipped: false });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
  });

  test('worktreeId mismatch in dirtyContinuation fails closed', async () => {
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    // dirtyContinuation with a different worktreeId
    const task = makeDirtyTask({ worktreeId: 'other-session/issue-77' });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('dirtyContinuation file set drifted from recorded dirtyFiles fails closed', async () => {
    // Simulate a file being added to the worktree after the dirtyContinuation marker
    // was recorded. The drift check must detect the mismatch and fail closed rather
    // than silently staging the extra file in the next implementation commit.
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts\n?? src/extra.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY — extra file)
      // git status -z drift check: returns BOTH files — mismatches dirtyFiles: ['src/foo.ts']
      { stdout: ' M src/foo.ts\0?? src/extra.ts\0', stderr: '', exitCode: 0 },
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeDirtyTask()); // marker has dirtyFiles: ['src/foo.ts'] only

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/drifted from the recorded dirtyContinuation marker/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('dirtyContinuation content drifted from recorded patch fails closed', async () => {
    // File paths match the marker but a file was edited after the marker was recorded.
    // The content drift check compares current git diff HEAD + untracked patch against
    // the stored patch artifact; any difference must fail closed.
    const wt = worktreePath();
    const DIFFERENT_PATCH = 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1,2 @@\n existing\n+a different edit made after the marker was recorded\n';
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                        // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                        // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },           // git status --porcelain (DIRTY — same path as marker)
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 },         // git status --porcelain -z (path set matches marker)
      { stdout: DIFFERENT_PATCH, stderr: '', exitCode: 0 },           // git diff HEAD (content DRIFTED from stored patch)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeDirtyTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/dirty content has drifted from the recorded dirtyContinuation patch/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('dirtyContinuation missing dirtyFiles field fails closed', async () => {
    // A marker without dirtyFiles cannot be drift-checked; fail closed to be safe.
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        ...makeTask().context,
        dirtyContinuation: {
          issueNumber: 77, phase: 'implementation', runId: 'run-prev-1',
          branch: 'ai/issue-77', worktreeId: 'addon-dev/issue-77',
          verificationName: 'test', verificationExitCode: 1,
          // dirtyFiles deliberately absent
          patchArtifactFile: 'implementation-dirty-patch.patch',
          timestamp: '2026-01-01T00:00:00.000Z',
          commitSkipped: true,
        },
      },
    });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/missing dirtyFiles/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('skipped untracked binary file in dirty continuation fails closed', async () => {
    // When the current untracked file set includes a binary file, buildUntrackedPatch
    // cannot produce a reliable content fingerprint (placeholder contains only name and
    // size; a different binary of the same size produces the same placeholder). The drift
    // check must fail closed rather than letting through potentially unrelated changes.
    const wt = worktreePath();
    // Create a real binary file on disk so lstatSync / readFileSync detect it.
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'artifact.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                              // git fetch origin main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                              // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts\n?? artifact.bin', stderr: '', exitCode: 0 }, // git status --porcelain (DIRTY)
      // -z drift check — file set matches marker (both files present)
      { stdout: ' M src/foo.ts\0?? artifact.bin\0', stderr: '', exitCode: 0 },
      // git diff HEAD — tracked patch matches stored artifact (only content check blocks)
      { stdout: DIRTY_CONTINUATION_PATCH, stderr: '', exitCode: 0 },
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    // Marker lists both files so the path-set check passes; the content check must block.
    const task = makeDirtyTask({ dirtyFiles: ['artifact.bin', 'src/foo.ts'] });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/cannot be content-verified/);
    expect(result.error).toContain('artifact.bin');
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('shared-checkout (non-worktree) dirty state still aborts even with dirtyContinuation', async () => {
    // canonical checkout dirty — shared mode must always fail regardless of any marker.
    const runner = sequenceRunner([
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 }, // git status (DIRTY — no fetch in shared mode)
    ]);
    // session with worktrees DISABLED
    const result = await createImplementationHandler(
      CONTEXT(), runner,
    )(makeDirtyTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Working tree is dirty before implementation/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('dirty canonical checkout aborts dirty continuation (fails closed)', async () => {
    // Canonical checkout dirty — must fail before even checking the issue worktree.
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git fetch origin main (canonical)
      { stdout: ' M README.md', stderr: '', exitCode: 0 },  // git status --porcelain (canonical — DIRTY, blocks immediately)
      // worktree status never reached
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(makeDirtyTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Canonical checkout is dirty/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('dirty continuation fix-mode: remote head advanced past local HEAD fails closed (issue #571 review)', async () => {
    // In worktree fix mode with an active dirtyContinuation the --ff-only pull is
    // skipped (dirty files block it), but the remote-tracking ref was already updated
    // by Step 0.6. If the remote head advanced since the previous verification failure,
    // continue would repair against stale files and the eventual push would fail
    // non-fast-forward. Fail closed instead.
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },             // gh pr list (early fix-mode PR lookup)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },            // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                       // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },          // git status --porcelain (worktree DIRTY — allowed via dirtyContinuation)
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 },        // git status --porcelain -z --untracked-files=all (drift check — file set unchanged)
      { stdout: DIRTY_CONTINUATION_PATCH, stderr: '', exitCode: 0 }, // git diff HEAD (content drift check — matches stored patch)
      { stdout: '', stderr: '', exitCode: 0 },                       // git fetch origin ai/issue-77 (refresh remote-tracking ref before divergence check)
      { stdout: 'aaabbbcccddd1234', stderr: '', exitCode: 0 },       // git rev-parse HEAD (local)
      { stdout: 'dddcccbbbfff5678', stderr: '', exitCode: 0 },       // git rev-parse refs/remotes/origin/ai/issue-77 (remote AHEAD)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please fix the failing test.',
        verificationFailure: { name: 'test', exitCode: 1 },
        verificationFeedback: 'FAIL: 1 test failed\n  ● my test',
        dirtyContinuation: makeDirtyContinuation(),
      },
    });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/dirty continuation aborted/);
    expect(result.error).toMatch(/origin\/ai\/issue-77 has advanced/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('dirty continuation fix-mode: remote head matches local HEAD allows agent to run (issue #571 review)', async () => {
    // When origin/<prHeadFetchSource> equals local HEAD, no remote commit was pushed
    // after the prior verification failure; the dirty continuation proceeds safely.
    const wt = worktreePath();
    const SHA = 'abc123def456abc123def456abc123def456abc12';
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },             // gh pr list (early fix-mode PR lookup)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },            // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                       // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },          // git status --porcelain (worktree DIRTY — allowed)
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 },        // git status --porcelain -z --untracked-files=all (drift check — file set unchanged)
      { stdout: DIRTY_CONTINUATION_PATCH, stderr: '', exitCode: 0 }, // git diff HEAD (content drift check — matches stored patch)
      { stdout: '', stderr: '', exitCode: 0 },                       // git fetch origin ai/issue-77 (refresh remote-tracking ref before divergence check)
      { stdout: SHA, stderr: '', exitCode: 0 },                      // git rev-parse HEAD (local)
      { stdout: SHA, stderr: '', exitCode: 0 },                      // git rev-parse refs/remotes/origin/ai/issue-77 (remote SAME — no divergence)
      { stdout: 'Continued edits.', stderr: '', exitCode: 0 },       // claude (runs despite dirty tree)
      { stdout: '1 file changed', stderr: '', exitCode: 0 },         // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                   // npm test (verification passes)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },           // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                       // git add
      { stdout: '', stderr: '', exitCode: 0 },                       // git commit
      { stdout: '', stderr: '', exitCode: 0 },                       // git push
      { stdout: '', stderr: '', exitCode: 0 },                       // git worktree remove (canonical)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please fix the failing test.',
        verificationFailure: { name: 'test', exitCode: 1 },
        verificationFeedback: 'FAIL: 1 test failed\n  ● my test',
        dirtyContinuation: makeDirtyContinuation(),
      },
    });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(true);
    // No --ff-only pull (dirty worktree cannot be pulled over)
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'pull')).toBe(false);
    // The rev-parse checks ran in the worktree
    const revParseHead = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'rev-parse' && c.args[1] === 'HEAD',
    );
    expect(revParseHead).toBeDefined();
    expect(revParseHead.opts.cwd).toBe(wt);
  });

  test('dirty continuation fix-mode: fetch failure before divergence check fails closed (issue #571 review)', async () => {
    // If `git fetch origin <prHeadFetchSource>` fails (network error, unknown ref, etc.),
    // the remote-tracking ref cannot be trusted. Fail closed rather than proceeding on
    // potentially stale data.
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },             // gh pr list (early fix-mode PR lookup)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },            // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                       // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },          // git status --porcelain (worktree DIRTY — allowed via dirtyContinuation)
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 },        // git status --porcelain -z --untracked-files=all (drift check — file set unchanged)
      { stdout: DIRTY_CONTINUATION_PATCH, stderr: '', exitCode: 0 }, // git diff HEAD (content drift check — matches stored patch)
      { stdout: '', stderr: 'fatal: unable to access remote', exitCode: 128 }, // git fetch origin ai/issue-77 FAILS
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please fix the failing test.',
        verificationFailure: { name: 'test', exitCode: 1 },
        verificationFeedback: 'FAIL: 1 test failed\n  ● my test',
        dirtyContinuation: makeDirtyContinuation(),
      },
    });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/dirty continuation aborted/);
    expect(result.error).toMatch(/git fetch origin/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('dirty continuation fix-mode: tracking ref absent but FETCH_HEAD matches — uses fallback (issue #571 review)', async () => {
    // In narrow-clone configurations, `git fetch origin <branch>` only updates FETCH_HEAD
    // and leaves refs/remotes/origin/<branch> absent (exitCode !== 0). The code should
    // fall back to FETCH_HEAD for the divergence check rather than proceeding blindly.
    const wt = worktreePath();
    const SHA = 'abc123def456abc123def456abc123def456abc12';
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },             // gh pr list (early fix-mode PR lookup)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },            // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                       // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },          // git status --porcelain (worktree DIRTY — allowed)
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 },        // git status --porcelain -z --untracked-files=all (drift check — file set unchanged)
      { stdout: DIRTY_CONTINUATION_PATCH, stderr: '', exitCode: 0 }, // git diff HEAD (content drift check — matches stored patch)
      { stdout: '', stderr: '', exitCode: 0 },                       // git fetch origin ai/issue-77
      { stdout: SHA, stderr: '', exitCode: 0 },                      // git rev-parse HEAD (local)
      { stdout: '', stderr: 'fatal: unknown revision', exitCode: 128 }, // git rev-parse refs/remotes/origin/ai/issue-77 (ABSENT — narrow clone)
      { stdout: SHA, stderr: '', exitCode: 0 },                      // git rev-parse FETCH_HEAD (fallback — SAME as local)
      { stdout: 'Continued edits.', stderr: '', exitCode: 0 },       // claude (runs despite dirty tree)
      { stdout: '1 file changed', stderr: '', exitCode: 0 },         // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                   // npm test (verification passes)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },           // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                       // git add
      { stdout: '', stderr: '', exitCode: 0 },                       // git commit
      { stdout: '', stderr: '', exitCode: 0 },                       // git push
      { stdout: '', stderr: '', exitCode: 0 },                       // git worktree remove (canonical)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please fix the failing test.',
        verificationFailure: { name: 'test', exitCode: 1 },
        verificationFeedback: 'FAIL: 1 test failed\n  ● my test',
        dirtyContinuation: makeDirtyContinuation(),
      },
    });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('success');
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(true);
    // FETCH_HEAD fallback was used (rev-parse FETCH_HEAD call present)
    const fetchHeadCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'rev-parse' && c.args[1] === 'FETCH_HEAD',
    );
    expect(fetchHeadCall).toBeDefined();
    expect(fetchHeadCall.opts.cwd).toBe(wt);
  });

  test('dirty continuation fix-mode: tracking ref absent and FETCH_HEAD unresolvable fails closed (issue #571 review)', async () => {
    // When fetch succeeds but neither the tracking ref nor FETCH_HEAD can be resolved,
    // the remote PR head cannot be validated. Fail closed to preserve fail-closed behaviour.
    const wt = worktreePath();
    const SHA = 'abc123def456abc123def456abc123def456abc12';
    const runner = sequenceRunner([
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },             // gh pr list (early fix-mode PR lookup)
      { stdout: 'ai/issue-77', stderr: '', exitCode: 0 },            // git rev-parse refs/heads/ai/issue-77 (LOCAL BRANCH EXISTS) — canonical
      { stdout: '', stderr: '', exitCode: 0 },                       // git status --porcelain (canonical — CLEAN)
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },          // git status --porcelain (worktree DIRTY — allowed)
      { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 },        // git status --porcelain -z --untracked-files=all (drift check — file set unchanged)
      { stdout: DIRTY_CONTINUATION_PATCH, stderr: '', exitCode: 0 }, // git diff HEAD (content drift check — matches stored patch)
      { stdout: '', stderr: '', exitCode: 0 },                       // git fetch origin ai/issue-77
      { stdout: SHA, stderr: '', exitCode: 0 },                      // git rev-parse HEAD (local)
      { stdout: '', stderr: 'fatal: unknown revision', exitCode: 128 }, // git rev-parse refs/remotes/origin/ai/issue-77 (ABSENT)
      { stdout: '', stderr: 'fatal: unknown revision', exitCode: 128 }, // git rev-parse FETCH_HEAD (ABSENT — both unresolvable)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({ worktrees: { enabled: true } });
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: 'Please fix the failing test.',
        verificationFailure: { name: 'test', exitCode: 1 },
        verificationFeedback: 'FAIL: 1 test failed\n  ● my test',
        dirtyContinuation: makeDirtyContinuation(),
      },
    });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/dirty continuation aborted/);
    expect(result.error).toMatch(/could not resolve remote head/);
    expect(result.error).toMatch(/tracking ref absent/);
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(false);
  });

  test('dirty continuation: untracked continuation files are not suppressed by envPrepareBaseline when environmentPrepare is enabled (issue #571)', async () => {
    const wt = worktreePath();
    // Create the worktree directory and the untracked continuation file so
    // buildUntrackedPatch can read it during the content drift check.
    mkdirSync(join(wt, 'src'), { recursive: true });
    const NEW_FEATURE_CONTENT = 'export const newFeature = 1;\n';
    writeFileSync(join(wt, 'src', 'new-feature.ts'), NEW_FEATURE_CONTENT, 'utf8');

    // Stored patch: empty tracked diff + untracked content for src/new-feature.ts.
    // Must exactly match what buildUntrackedPatch() produces for this content.
    const STORED_PATCH =
      'diff --git a/src/new-feature.ts b/src/new-feature.ts\n' +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      '+++ b/src/new-feature.ts\n' +
      '@@ -0,0 +1,1 @@\n' +
      '+export const newFeature = 1;\n';
    // Overwrite the prior-run patch artifact (created in beforeEach) with the
    // untracked-only patch for this test.
    const priorDir = join(artifactRoot, 'runs', 'run-prev-1');
    writeFileSync(join(priorDir, 'implementation-dirty-patch.patch'), STORED_PATCH, 'utf8');

    const prUrl = 'https://github.com/m2dw/test-repo/pull/100';
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                               // git fetch origin main:refs/remotes/origin/main (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                                               // git status --porcelain (canonical — CLEAN)
      { stdout: '?? src/new-feature.ts', stderr: '', exitCode: 0 },                         // git status --porcelain (worktree DIRTY — untracked continuation file)
      { stdout: '?? src/new-feature.ts\0', stderr: '', exitCode: 0 },                       // git status --porcelain -z --untracked-files=all (file-set drift check)
      { stdout: '', stderr: '', exitCode: 0 },                                               // git diff HEAD (empty tracked diff; untracked content read by buildUntrackedPatch)
      { stdout: 'src/new-feature.ts\0', stderr: '', exitCode: 0 },                          // git ls-files --others --exclude-standard -z (pre-prepare snapshot)
      { stdout: '', stderr: '', exitCode: 0 },                                               // make install (environmentPrepare command)
      { stdout: 'node_modules/some-dep.js\0src/new-feature.ts\0', stderr: '', exitCode: 0 },// git ls-files --others --exclude-standard -z (post-prepare baseline)
      { stdout: 'Continued edits.', stderr: '', exitCode: 0 },                               // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },                                 // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                                           // npm test (verification passes)
      { stdout: 'src/new-feature.ts\0', stderr: '', exitCode: 0 },                          // git ls-files --modified --deleted --others... -z (stageable)
      { stdout: '', stderr: '', exitCode: 0 },                                               // git add
      { stdout: '', stderr: '', exitCode: 0 },                                               // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                               // git push
      { stdout: prUrl, stderr: '', exitCode: 0 },                                            // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                                               // git worktree remove (canonical)
    ]);
    const resolver = fakeWorktreeResolver(wt, { created: false });
    const session = SESSION({
      worktrees: { enabled: true },
      environmentPrepare: { enabled: true, command: 'make install' },
    });
    // dirtyContinuation marker for an untracked file; override default dirtyFiles
    const task = makeDirtyTask({ dirtyFiles: ['src/new-feature.ts'] });

    const result = await createImplementationHandler(
      CONTEXT({ session }), runner, undefined, resolver.resolve,
    )(task);

    // Without the fix, src/new-feature.ts would be captured in the post-prepare
    // envPrepareBaseline and excluded from stageablePaths, causing a no-diff failure.
    expect(result.result).toBe('success');
    // The git add call must include the continuation untracked file — it must NOT
    // be suppressed as a prepare artifact despite appearing in the post-prepare snapshot.
    const addCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall.args).toContain('src/new-feature.ts');
    // The prepare artifact must NOT be staged — it should remain excluded by the baseline.
    expect(addCall.args.join(' ')).not.toContain('node_modules');
  });
});

describe('implementation handler — PR body', () => {
  function ghBodyArg(runner) {
    const ghCall = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    const idx = ghCall.args.indexOf('--body');
    return ghCall.args[idx + 1];
  }

  test('PR body is non-empty', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(ghBodyArg(runner).length).toBeGreaterThan(10);
  });

  test('PR body includes Closes #<issueNumber>', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(ghBodyArg(runner)).toContain('Closes #77');
  });

  test('PR body includes issue title when present', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(ghBodyArg(runner)).toContain('Add login rate limiting');
  });

  test('PR body includes bounded issue body excerpt when body is present', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: { ...makeTask().context, body: 'Throttle login attempts to 5 per minute per IP address.' },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    expect(ghBodyArg(runner)).toContain('Throttle login attempts');
  });

  test('PR body truncates long issue body with ellipsis', async () => {
    const runner = happyRunner();
    const longBody = 'X'.repeat(600);
    const task = makeTask({ context: { ...makeTask().context, body: longBody } });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const body = ghBodyArg(runner);
    expect(body).toContain('X'.repeat(10));
    expect(body).not.toContain(longBody);
    expect(body).toContain('…');
  });

  test('PR body neutralizes closing keywords in issue body excerpt', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: {
        ...makeTask().context,
        body: 'This fixes #99 and also closes owner/repo#200.',
      },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const body = ghBodyArg(runner);
    // Explicit Closes for this issue must still be present
    expect(body).toContain('Closes #77');
    // Closing keywords from issue text must be neutralized
    expect(body).not.toMatch(/\bfixes\s+#99\b/i);
    expect(body).not.toMatch(/\bcloses\s+owner\/repo#200\b/i);
  });

  test('PR body neutralizes closing keywords in issue title', async () => {
    const runner = happyRunner();
    const task = makeTask({
      context: { ...makeTask().context, title: 'Fixes #55 regression in login' },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const body = ghBodyArg(runner);
    // Explicit Closes for this issue must still be present
    expect(body).toContain('Closes #77');
    // Closing keyword in the issue title must be neutralized
    expect(body).not.toMatch(/\bfixes\s+#55\b/i);
  });

  test('PR body does not include repoRoot or artifactRoot paths', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const body = ghBodyArg(runner);
    expect(body).not.toContain(repoRoot);
    expect(body).not.toContain(artifactRoot);
  });

  test('PR body includes implementation mode indicator', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(ghBodyArg(runner)).toContain('new');
  });

  test('PR body includes verification command name when configured', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(ghBodyArg(runner)).toContain('test');
  });

  test('PR body omits verification section when no verification commands are configured', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },  // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'done', stderr: '', exitCode: 0 },
      { stdout: '1 file changed', stderr: '', exitCode: 0 },
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'https://github.com/m2dw/test-repo/pull/7', stderr: '', exitCode: 0 },
    ]);
    const ctx = CONTEXT({ session: SESSION({ verification: {} }) });
    await createImplementationHandler(ctx, runner)(makeTask());
    const body = ghBodyArg(runner);
    expect(body).not.toContain('Verification');
    expect(body).toContain('Closes #77');
  });
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

describe('implementation handler — failure cases', () => {
  test('returns failed for unsupported agent without spawning', async () => {
    const runner = happyRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask({ implementationAgent: 'gpt4' }));
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Unsupported implementation agent/);
    expect(result.error).toContain('claude, codex, gemini');
    expect(runner.calls).toHaveLength(0);
  });

  test('returns failed when claude exits non-zero', async () => {
    const r = await createImplementationHandler(CONTEXT(), fakeFail('compile error'))(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/compile error/);
  });

  test('returns failed when working tree is dirty before starting', async () => {
    const runner = sequenceRunner([
      { stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 }, // git status — dirty
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/dirty/);
    // Claude must NOT have been called
    expect(runner.calls).toHaveLength(1);
  });

  test('returns failed when claude produces no diff', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },          // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout -b
      { stdout: '', stderr: '', exitCode: 0 },              // claude — succeeds
      { stdout: '', stderr: '', exitCode: 0 },              // git diff — empty
      { stdout: '', stderr: '', exitCode: 0 },              // git ls-files --others (untracked check)
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/no file changes/);
  });

  test('returns failed when git push fails, then restores HEAD to base', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git status
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },          // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout -b
      { stdout: 'done', stderr: '', exitCode: 0 },          // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 }, // git diff
      { stdout: 'PASS', stderr: '', exitCode: 0 },          // verification (npm test)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },  // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },              // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },              // git commit
      { stdout: '', stderr: 'push rejected', exitCode: 1 }, // git push — fails
      { stdout: '', stderr: '', exitCode: 0 },              // cleanup: git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },              // cleanup: git checkout main
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/push rejected/);
    // Cleanup returns the checkout to the base branch (no quarantine note)
    const lastCheckout = [...runner.calls].reverse().find((c) => c.cmd === 'git' && c.args[0] === 'checkout');
    expect(lastCheckout).toMatchObject({ cmd: 'git', args: ['checkout', 'main'] });
    expect(r.error).not.toMatch(/quarantined/);
  });

  test('returns failed when gh pr create fails, then restores HEAD to base', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },          // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'done', stderr: '', exitCode: 0 },
      { stdout: '1 file changed', stderr: '', exitCode: 0 },
      { stdout: 'PASS', stderr: '', exitCode: 0 },          // verification (npm test)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'gh: auth error', exitCode: 1 }, // gh pr create — fails
      { stdout: '', stderr: '', exitCode: 0 },              // cleanup: git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },              // cleanup: git checkout main
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/gh: auth error/);
  });
});

// ---------------------------------------------------------------------------
// Pre-push verification (issue #175)
// ---------------------------------------------------------------------------

describe('implementation handler — pre-push verification', () => {
  // Order through the diff check: status(0) checkout-main(1) pull(2) rev-parse(3)
  // checkout-b(4) claude(5) diff(6) then verification(7) ...
  function upToVerification(verificationResult) {
    return [
      { stdout: '', stderr: '', exitCode: 0 },              // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },          // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout -b
      { stdout: 'done', stderr: '', exitCode: 0 },          // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 }, // git diff --stat HEAD
      verificationResult,                                    // verification (npm test)
    ];
  }

  test('runs verification before git add/commit/push and gh pr create', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const npmIdx = runner.calls.findIndex((c) => c.cmd === 'npm' && c.args[0] === 'test');
    const addIdx = runner.calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'add');
    const pushIdx = runner.calls.findIndex((c) => c.cmd === 'git' && c.args.includes('push'));
    const ghIdx = runner.calls.findIndex((c) => c.cmd === 'gh' && c.args.includes('create'));
    expect(npmIdx).toBeGreaterThanOrEqual(0);
    expect(npmIdx).toBeLessThan(addIdx);
    expect(npmIdx).toBeLessThan(pushIdx);
    expect(npmIdx).toBeLessThan(ghIdx);
  });

  test('verification command runs with a large maxBuffer so verbose passing output is not truncated', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const verCall = runner.calls.find((c) => c.cmd === 'npm' && c.args[0] === 'test');
    expect(verCall).toBeDefined();
    // Must exceed Node's 1 MiB execFileSync default so a verbose-but-passing
    // run cannot throw before the output is bounded.
    expect(verCall.opts.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  test('verification failure (after bounded repair) returns failed without committing or pushing', async () => {
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL: 1 test failed', stderr: '', exitCode: 1 }), // verification fails
      { stdout: 'repaired', stderr: '', exitCode: 0 },      // repair claude
      { stdout: 'FAIL: still failing', stderr: '', exitCode: 1 }, // verification still fails
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/Verification 'test' failed/);
    // No staging/commit/push or PR creation happened
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'add')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('commit'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args.includes('create'))).toBe(false);
  });

  test('failure context includes verification command name, exit code, and bounded output', async () => {
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL: assertion x', stderr: '', exitCode: 2 }),
      { stdout: 'repaired', stderr: '', exitCode: 0 },
      { stdout: 'FAIL: assertion x', stderr: '', exitCode: 2 },
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.context?.verificationFailure).toEqual({ name: 'test', exitCode: 2 });
    expect(r.context?.verificationFeedback).toContain('FAIL: assertion x');
  });

  test('bounded repair: re-runs the agent once with verification feedback, then succeeds', async () => {
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL: 1 test failed', stderr: '', exitCode: 1 }), // verification fails
      { stdout: 'repaired', stderr: '', exitCode: 0 },      // repair claude
      { stdout: 'PASS', stderr: '', exitCode: 0 },          // verification passes
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },  // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },              // git add
      { stdout: '', stderr: '', exitCode: 0 },              // git commit
      { stdout: '', stderr: '', exitCode: 0 },              // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/5', stderr: '', exitCode: 0 }, // gh pr create
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('success');
    // claude ran exactly twice (initial + one repair)
    expect(runner.calls.filter((c) => c.cmd === 'claude')).toHaveLength(2);
    const repairClaude = runner.calls.filter((c) => c.cmd === 'claude')[1];
    expect(repairClaude.opts.stdin).toContain('Verification Repair Task');
    expect(repairClaude.opts.stdin).toContain('FAIL: 1 test failed');
  });

  test('repair loop is bounded: agent runs at most twice on persistent failure', async () => {
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL', stderr: '', exitCode: 1 }),
      { stdout: 'repaired', stderr: '', exitCode: 0 },      // repair claude
      { stdout: 'FAIL', stderr: '', exitCode: 1 },          // verification still fails
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(runner.calls.filter((c) => c.cmd === 'claude')).toHaveLength(2);
    expect(runner.calls.filter((c) => c.cmd === 'npm')).toHaveLength(2);
  });

  test('repair agent error returns failed without committing', async () => {
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL', stderr: '', exitCode: 1 }),
      { stdout: '', stderr: 'claude crashed', exitCode: 1 }, // repair claude errors
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/repair exited 1/);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'add')).toBe(false);
  });

  test('repair prompt instructs the agent how to emit a Tool Request block', async () => {
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL: 1 test failed', stderr: '', exitCode: 1 }),
      { stdout: 'repaired', stderr: '', exitCode: 0 },        // repair claude
      { stdout: 'PASS', stderr: '', exitCode: 0 },            // verification passes
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },    // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                // git add
      { stdout: '', stderr: '', exitCode: 0 },                // git commit
      { stdout: '', stderr: '', exitCode: 0 },                // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/9', stderr: '', exitCode: 0 }, // gh pr create
    ]);
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    const repairClaude = runner.calls.filter((c) => c.cmd === 'claude')[1];
    expect(repairClaude.opts.stdin).toContain(TOOL_REQUEST_OPEN);
    expect(repairClaude.opts.stdin).toContain('When You Need A Disallowed Command');
  });

  test('a Tool Request from the repair agent becomes a human handoff (issue #291)', async () => {
    const block = toolRequestBlock([
      'command: npm install left-pad',
      'reason: The failing test imports left-pad which is not a dependency.',
      'expected_files: package.json, package-lock.json',
      'suggested_action: dependencySync',
    ]);
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL: cannot find module left-pad', stderr: '', exitCode: 1 }),
      { stdout: block, stderr: '', exitCode: 0 },  // repair claude emits a Tool Request
      { stdout: '', stderr: '', exitCode: 0 },     // git add -A (capture partial diff, issue #379)
      { stdout: '', stderr: '', exitCode: 0 },     // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },     // git checkout -f main (handoff cleanup)
      { stdout: '', stderr: '', exitCode: 0 },     // git clean -fd
      { stdout: '', stderr: '', exitCode: 0 },     // git branch -D <branch>
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('tool_request');
    expect(r.context.toolRequest).toMatchObject({
      command: 'npm install left-pad',
      displayCommand: 'npm install left-pad',
      mode: 'new',
      resolved: false,
    });
    // Issue #472 review (P1): a shared-checkout new implementation that hands off a
    // Tool Request BEFORE any PR exists must NOT persist the conventional
    // `ai/issue-<n>` name as `context.branch`. handoffCleanup just deleted that branch
    // (`git branch -D <branch>` above), and recording it would make
    // `admin tool-request grant` treat it as a recorded PR head (`fromRecordedPr`),
    // so moveToToolRequestBranch would refuse to recreate it from base and the grant
    // could never run. resolveToolRequestWorkBranch derives the same name via its
    // fallback, so omitting the key keeps `fromRecordedPr` false.
    expect(r.context.branch).toBeUndefined();
    // The requested command is never run, and nothing is committed/pushed.
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args.includes('create'))).toBe(false);
    // Verification is not re-run after the handoff (only the initial failing run).
    expect(runner.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'test')).toHaveLength(1);
  });

  test('a repair-agent Tool Request with a nonzero exit still becomes a handoff (issue #291)', async () => {
    const block = toolRequestBlock([
      'command: npm install left-pad',
      'reason: The failing test imports left-pad which is not a dependency.',
      'expected_files: package.json, package-lock.json',
      'suggested_action: dependencySync',
    ]);
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL: cannot find module left-pad', stderr: '', exitCode: 1 }),
      // Repair agent emits a valid Tool Request but exits nonzero — must be
      // detected before the nonzero-exit failure branch.
      { stdout: block, stderr: 'blocked: disallowed command', exitCode: 1 },
      { stdout: '', stderr: '', exitCode: 0 },     // git add -A (capture partial diff, issue #379)
      { stdout: '', stderr: '', exitCode: 0 },     // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },     // git checkout -f main (handoff cleanup)
      { stdout: '', stderr: '', exitCode: 0 },     // git clean -fd
      { stdout: '', stderr: '', exitCode: 0 },     // git branch -D <branch>
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('tool_request');
    expect(r.context.toolRequest).toMatchObject({ command: 'npm install left-pad', resolved: false });
    expect(r.error).toBeUndefined();
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
  });

  test('initial-agent quota exhaustion delays the retry and restores the checkout (issue #25 review)', async () => {
    // The agent exits nonzero with a quota message after the issue branch was
    // created. The task must be re-queued as `delayed`, but only after the
    // checkout is restored to base and the freshly-created branch is dropped —
    // otherwise the delayed retry's preflight hard-fails on a dirty worktree or
    // a `checkout -b` collision with the existing branch.
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                     // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                     // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                     // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                 // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },                     // git checkout -b <branch>
      { stdout: '', stderr: 'Error: HTTP 429 rate limit exceeded, try again later', exitCode: 1 }, // claude — quota
      { stdout: '', stderr: '', exitCode: 0 },                     // git add -A (capture partial diff, issue #379)
      { stdout: '', stderr: '', exitCode: 0 },                     // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },                     // git checkout -f main (restore)
      { stdout: '', stderr: '', exitCode: 0 },                     // git clean -fd
      { stdout: '', stderr: '', exitCode: 0 },                     // git branch -D <branch>
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('delayed');
    // Checkout restored to base and the new-impl branch dropped before re-queueing.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-f'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(true);
    // Nothing committed or pushed.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
  });

  test('repair-agent quota exhaustion delays the retry and restores the checkout (issue #25 review)', async () => {
    const runner = sequenceRunner([
      ...upToVerification({ stdout: 'FAIL: 1 test failed', stderr: '', exitCode: 1 }), // verification fails
      { stdout: '', stderr: 'usage limit reached. Your limit will reset at 5pm.', exitCode: 1 }, // repair claude — quota
      { stdout: '', stderr: '', exitCode: 0 },     // git add -A (capture partial diff, issue #379)
      { stdout: '', stderr: '', exitCode: 0 },     // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },     // git checkout -f main (restore)
      { stdout: '', stderr: '', exitCode: 0 },     // git clean -fd
      { stdout: '', stderr: '', exitCode: 0 },     // git branch -D <branch>
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('delayed');
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-f'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
  });

  test('empty verification config skips verification and commits normally', async () => {
    // No verification command is run, so the sequence has no npm step.
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },          // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout -b
      { stdout: 'done', stderr: '', exitCode: 0 },          // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 }, // git diff
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },  // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },              // git add
      { stdout: '', stderr: '', exitCode: 0 },              // git commit
      { stdout: '', stderr: '', exitCode: 0 },              // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/7', stderr: '', exitCode: 0 }, // gh pr create
    ]);
    const ctx = CONTEXT({ session: SESSION({ verification: {} }) });
    const r = await createImplementationHandler(ctx, runner)(makeTask());
    expect(r.result).toBe('success');
    expect(runner.calls.some((c) => c.cmd === 'npm')).toBe(false);
  });

  test('verification also runs in fix mode before pushing to the existing PR', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                 // git status
      { stdout: '', stderr: '', exitCode: 0 },                 // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                 // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },             // rev-parse — HEAD at base
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },       // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },                 // git checkout <branch>
      { stdout: '', stderr: '', exitCode: 0 },                 // git pull origin <branch>
      { stdout: 'done', stderr: '', exitCode: 0 },             // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },   // git diff
      { stdout: 'FAIL', stderr: '', exitCode: 1 },             // verification fails
      { stdout: 'repaired', stderr: '', exitCode: 0 },         // repair claude
      { stdout: 'FAIL', stderr: '', exitCode: 1 },             // verification still fails
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/Verification 'test' failed/);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler-owned dependency sync (issue #290)
// ---------------------------------------------------------------------------

describe('implementation handler — dependency sync', () => {
  const DEP_SYNC = {
    enabled: true,
    triggerPaths: ['package.json'],
    expectedOutputs: ['package-lock.json'],
    command: 'npm install --package-lock-only --ignore-scripts',
    timeoutMs: 120000,
  };
  const depSession = (overrides = {}) => SESSION({ dependencySync: DEP_SYNC, ...overrides });

  test('runs the configured sync command when package.json changed, before verification and commit', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                          // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                                          // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                                      // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout -b
      { stdout: 'edited package.json', stderr: '', exitCode: 0 },                       // claude
      { stdout: ' M package.json', stderr: '', exitCode: 0 },                           // git diff --stat HEAD
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                         // dep-sync git status (before)
      { stdout: 'updated lockfile', stderr: '', exitCode: 0 },                          // npm install ...
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },   // dep-sync git status (after)
      { stdout: 'PASS', stderr: '', exitCode: 0 },                                      // verification npm test
      { stdout: 'package.json\0package-lock.json\0', stderr: '', exitCode: 0 },         // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                          // git add
      { stdout: '', stderr: '', exitCode: 0 },                                          // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                          // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/3', stderr: '', exitCode: 0 },  // gh pr create
    ]);
    const r = await createImplementationHandler(CONTEXT({ session: depSession() }), runner)(makeTask());
    expect(r.result).toBe('success');

    const npmInstall = runner.calls.find((c) => c.cmd === 'npm' && c.args.includes('install'));
    expect(npmInstall).toBeDefined();
    expect(npmInstall.args).toEqual(['install', '--package-lock-only', '--ignore-scripts']);
    expect(npmInstall.opts.timeout).toBe(120000);

    // Sync runs before verification, staging, and push.
    const installIdx = runner.calls.indexOf(npmInstall);
    const testIdx = runner.calls.findIndex((c) => c.cmd === 'npm' && c.args[0] === 'test');
    const addIdx = runner.calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'add');
    const pushIdx = runner.calls.findIndex((c) => c.cmd === 'git' && c.args.includes('push'));
    expect(installIdx).toBeLessThan(testIdx);
    expect(installIdx).toBeLessThan(addIdx);
    expect(installIdx).toBeLessThan(pushIdx);

    // Success metadata is surfaced in context and the result artifact.
    expect(r.context.dependencySync).toMatchObject({
      ran: true,
      passed: true,
      changedTriggerPaths: ['package.json'],
      producedExpectedOutputs: ['package-lock.json'],
    });
    const result = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8'));
    expect(result.dependencySync).toMatchObject({ ran: true, passed: true });
  });

  test('does not run the sync command when no trigger path changed', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                          // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                                          // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                                      // rev-parse
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout -b
      { stdout: 'edited source', stderr: '', exitCode: 0 },                             // claude
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },                             // git diff --stat HEAD
      { stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 },                           // dep-sync git status (before) — no trigger
      { stdout: 'PASS', stderr: '', exitCode: 0 },                                      // verification npm test
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },                              // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                          // git add
      { stdout: '', stderr: '', exitCode: 0 },                                          // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                          // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/4', stderr: '', exitCode: 0 },  // gh pr create
    ]);
    const r = await createImplementationHandler(CONTEXT({ session: depSession() }), runner)(makeTask());
    expect(r.result).toBe('success');
    // No sync command ran, and no dependencySync metadata is attached.
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
    expect(r.context.dependencySync).toBeUndefined();
  });

  test('sync is a no-op when the session does not configure dependencySync', async () => {
    const runner = happyRunner();
    const r = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(r.result).toBe('success');
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
    expect(r.context.dependencySync).toBeUndefined();
  });

  test('sync failure stops with actionable feedback and does not commit or push', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                                  // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                                  // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                              // rev-parse
      { stdout: '', stderr: '', exitCode: 0 },                                  // git checkout -b
      { stdout: 'edited package.json', stderr: '', exitCode: 0 },               // claude
      { stdout: ' M package.json', stderr: '', exitCode: 0 },                   // git diff --stat HEAD
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                 // dep-sync git status (before)
      { stdout: '', stderr: 'npm ERR! 404 Not Found: no-such-pkg', exitCode: 1 }, // npm install — fails
    ]);
    const r = await createImplementationHandler(CONTEXT({ session: depSession() }), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/Dependency sync failed/);
    expect(r.error).toMatch(/package\.json/);
    expect(r.context.dependencySyncFeedback).toContain('404 Not Found');
    expect(r.context.dependencySync).toMatchObject({ ran: true, passed: false });
    // Verification never ran; nothing was staged, committed, or pushed.
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args[0] === 'test')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'add')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('commit'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args.includes('create'))).toBe(false);
    // The failure is recorded in the result artifact.
    const result = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8'));
    expect(result).toMatchObject({ success: false, step: 'dependency-sync' });
  });

  test('npm install is not added to Claude allowedTools by default', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT({ session: depSession() }), runner)(makeTask());
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude');
    const tools = claudeCall.args[claudeCall.args.indexOf('--allowedTools') + 1];
    expect(tools).not.toContain('npm install');
    expect(tools).not.toContain('Bash(npm install');
    expect(tools).not.toContain('Bash(npm *)');
    expect(tools).not.toContain('Bash(npm run *)');
  });

  test('refuses a lifecycle-running command in safe mode without committing or pushing', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                    // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                    // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                    // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                // rev-parse
      { stdout: '', stderr: '', exitCode: 0 },                    // git checkout -b
      { stdout: 'edited package.json', stderr: '', exitCode: 0 }, // claude
      { stdout: ' M package.json', stderr: '', exitCode: 0 },     // git diff --stat HEAD
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },   // dep-sync git status (before)
      // No npm install — the command is refused before it can run.
    ]);
    // `npm install` (no --ignore-scripts) is a lifecycle-running command and the
    // session has not opted into allowLifecycleScripts.
    const session = depSession({ dependencySync: { ...DEP_SYNC, command: 'npm install' } });
    const r = await createImplementationHandler(CONTEXT({ session }), runner)(makeTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/Dependency sync refused/);
    expect(r.context.dependencySync).toMatchObject({ ran: false, passed: false });
    expect(r.context.dependencySync.failure.kind).toBe('unsafe-command');
    // The unsafe command never ran; nothing was verified, staged, committed, or pushed.
    expect(runner.calls.some((c) => c.cmd === 'npm')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'add')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
    const result = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8'));
    expect(result).toMatchObject({ success: false, step: 'dependency-sync' });
  });

  test('re-runs dependency sync after a verification repair changes the manifest', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                          // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                                          // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                                      // rev-parse
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout -b
      { stdout: 'edited package.json', stderr: '', exitCode: 0 },                       // claude (initial)
      { stdout: ' M package.json', stderr: '', exitCode: 0 },                           // git diff --stat HEAD
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                         // dep-sync status (initial, before)
      { stdout: 'updated lockfile', stderr: '', exitCode: 0 },                          // npm install (initial)
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },   // dep-sync status (initial, after)
      { stdout: 'FAIL: 1 test failed', stderr: '', exitCode: 1 },                       // verification — fails
      { stdout: 'repaired package.json', stderr: '', exitCode: 0 },                     // repair claude
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                         // dep-sync status (repair, before)
      { stdout: 'updated lockfile again', stderr: '', exitCode: 0 },                    // npm install (repair re-sync)
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },   // dep-sync status (repair, after)
      { stdout: 'PASS', stderr: '', exitCode: 0 },                                      // verification — passes
      { stdout: 'package.json\0package-lock.json\0', stderr: '', exitCode: 0 },         // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                          // git add
      { stdout: '', stderr: '', exitCode: 0 },                                          // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                          // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/9', stderr: '', exitCode: 0 },  // gh pr create
    ]);
    const r = await createImplementationHandler(CONTEXT({ session: depSession() }), runner)(makeTask());
    expect(r.result).toBe('success');

    // npm install ran twice: once initially, then again after the repair so the
    // lockfile is regenerated for the repaired manifest before re-verification.
    const installs = runner.calls.filter((c) => c.cmd === 'npm' && c.args.includes('install'));
    expect(installs).toHaveLength(2);

    // The second sync runs after the repair agent and before the final verification.
    const secondInstallIdx = runner.calls.lastIndexOf(installs[1]);
    const repairClaudeIdx = runner.calls.map((c) => c.cmd).lastIndexOf('claude');
    const finalTestIdx = runner.calls.map((c) => `${c.cmd} ${c.args[0]}`).lastIndexOf('npm test');
    expect(secondInstallIdx).toBeGreaterThan(repairClaudeIdx);
    expect(secondInstallIdx).toBeLessThan(finalTestIdx);
  });
});

// ---------------------------------------------------------------------------
// Agent selection
// ---------------------------------------------------------------------------

describe('implementation handler — agent selection', () => {
  test('uses task.implementationAgent over session default', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask({ implementationAgent: 'claude' }));
    expect(runner.calls[5].cmd).toBe('claude');
  });

  test('falls back to session.defaults.implementationAgent when task has none', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask({ implementationAgent: undefined }));
    expect(runner.calls[5].cmd).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// PhaseHandlerResult and context
// ---------------------------------------------------------------------------

describe('implementation handler — result', () => {
  test('returns success on full happy path', async () => {
    const r = await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    expect(r.result).toBe('success');
  });

  test('success context includes prUrl and branch', async () => {
    const pr = 'https://github.com/m2dw/test-repo/pull/42';
    const r = await createImplementationHandler(CONTEXT(), happyRunner(pr))(makeTask());
    expect(r.result).toBe('success');
    expect(r.context?.prUrl).toBe(pr);
    expect(r.context?.branch).toMatch(/77/);
  });

  test('branch name is ai/issue-<issueNumber> (no runId, no sessionId, no agent)', () => {
    const pr = 'https://github.com/m2dw/test-repo/pull/42';
    return createImplementationHandler(CONTEXT(), happyRunner(pr))(makeTask()).then((r) => {
      expect(r.result).toBe('success');
      expect(r.context?.branch).toBe('ai/issue-77');
      // Must not contain run id, session id, or agent name
      expect(r.context?.branch).not.toContain('run-');
      expect(r.context?.branch).not.toContain('addon-dev');
      expect(r.context?.branch).not.toContain('claude');
    });
  });

  test('artifact dir still contains runId', async () => {
    const r = await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    expect(r.context?.artifactDir).toContain('run-impl-1');
  });
});

// ---------------------------------------------------------------------------
// Phase transition through runNextPhase + SqliteTaskStore
// ---------------------------------------------------------------------------

describe('implementation handler — phase transition', () => {
  let store;

  beforeEach(() => {
    store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
  });

  test('implementation success transitions to queued review', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 77, phase: 'implementation',
      implementationAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-impl-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { implementation: createImplementationHandler(CONTEXT(), happyRunner()) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'review' });
    expect(outcome.result.context?.prUrl).toMatch(/pull\/99/);
  });

  test('implementation failure (claude error) transitions to failed', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 77, phase: 'implementation',
      implementationAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-impl-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { implementation: createImplementationHandler(CONTEXT(), fakeFail('compile error')) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'failed' });
    expect(outcome.task.lastError).toMatch(/compile error/);
  });

  test('implementation blocked (dependency) transitions to blocked status — NOT ready_for_human (issue #224)', async () => {
    // A dep-blocked implementation task must land in `blocked` status so that
    // intake can re-enqueue it when the blocker becomes stack-ready. Transitioning
    // to ready_for_human would remove the implementation-lane labels from GitHub
    // and permanently dequeue the issue from automation.
    const blockedDepChecker = {
      async getBlockedBy() { return [{ issueNumber: 50, state: 'open' }]; },
    };
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 77, phase: 'implementation',
      implementationAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
    });
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },  // gh pr list (dep check — no open PR → blocked)
    ]);
    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-impl-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { implementation: createImplementationHandler(CONTEXT(), runner, blockedDepChecker) },
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'blocked', phase: 'implementation' });
    expect(outcome.result.result).toBe('blocked');
  });

  test('implementation failure (no diff) transitions to failed', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 77, phase: 'implementation',
      implementationAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
    });

    const noDiffRunner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },      // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },      // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },      // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },  // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },      // git checkout -b
      { stdout: '', stderr: '', exitCode: 0 },      // claude
      { stdout: '', stderr: '', exitCode: 0 },      // git diff — empty
      { stdout: '', stderr: '', exitCode: 0 },      // git ls-files --others (untracked check)
    ]);

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'addon-dev', workerId: 'w', runId: 'run-impl-1', now: '2026-06-07T00:01:00.000Z' },
      handlers: { implementation: createImplementationHandler(CONTEXT(), noDiffRunner) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('failed');
    expect(outcome.task.lastError).toMatch(/no file changes/);
  });
});

// ---------------------------------------------------------------------------
// CLI — supported phase gating
// ---------------------------------------------------------------------------

describe('run-one-phase CLI — implementation gating', () => {
  let sessionsPath;
  let dbPath;

  const SESSION_OBJ = {
    sessionId: 'addon-dev',
    repoKey: 'test-repo',
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  };

  function runCli(...args) {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ANTIGRAVITY_BIN: join(tmpDir, 'fake-agy'),
          PATH: `${join(tmpDir, 'bin')}:${process.env.PATH}`,
        },
      });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status ?? 1, stdout: err.stdout ?? '' };
    }
  }

  beforeEach(() => {
    sessionsPath = join(tmpDir, 'sessions.json');
    dbPath = join(tmpDir, 'cli.db');
    const binDir = join(tmpDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    // Fake claude: reads stdin, exits 0, prints stub output
    const fakeClaude = join(binDir, 'claude');
    writeFileSync(fakeClaude, '#!/bin/sh\ncat > /dev/null\necho "claude done"\nexit 0\n', 'utf8');
    chmodSync(fakeClaude, 0o755);

    // Fake npm: verification command (npm test) succeeds
    const fakeNpm = join(binDir, 'npm');
    writeFileSync(fakeNpm, '#!/bin/sh\necho "npm test PASS"\nexit 0\n', 'utf8');
    chmodSync(fakeNpm, 0o755);

    // Fake git: clean status, succeeds on all subcommands, stubs diff output
    const fakeGit = join(binDir, 'git');
    writeFileSync(fakeGit,
      '#!/bin/sh\n' +
      'if [ "$1" = "status" ]; then exit 0; fi\n' +         // clean working tree
      'if [ "$1" = "rev-parse" ]; then echo "main"; exit 0; fi\n' + // HEAD is at base
      'if [ "$1" = "diff" ]; then echo "1 file changed"; fi\n' +
      'if [ "$1" = "ls-files" ]; then printf "src/foo.ts\\0"; fi\n' +
      'exit 0\n',
      'utf8');
    chmodSync(fakeGit, 0o755);

    // Fake gh: returns empty blockedBy JSON for GraphQL calls; stub PR URL otherwise
    const fakeGh = join(binDir, 'gh');
    writeFileSync(fakeGh,
      '#!/bin/sh\n' +
      'if [ "$1" = "api" ]; then\n' +
      '  echo \'{"data":{"repository":{"issue":{"blockedBy":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\'\n' +
      '  exit 0\n' +
      'fi\n' +
      'echo "https://github.com/m2dw/test-repo/pull/1"\n' +
      'exit 0\n',
      'utf8');
    chmodSync(fakeGh, 0o755);

    // Fake agy
    const fakeAgy = join(tmpDir, 'fake-agy');
    writeFileSync(fakeAgy, '#!/bin/sh\necho "agy done"\nexit 0\n', 'utf8');
    chmodSync(fakeAgy, 0o755);

    const session = { ...SESSION_OBJ, repoRoot, artifactDir: '.n8n-artifacts' };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  });

  test('implementation task stays queued with default --supported-phases (research only)', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 100, phase: 'implementation',
      now: '2026-06-07T00:00:00.000Z',
    });
    store.close();

    const r = runCli('--session-id', 'addon-dev', '--run-id', 'r1', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: true, outcome: 'idle' });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 100 });
    store2.close();
    expect(task?.status).toBe('queued');
  });

  test('implementation task processed with --supported-phases implementation, transitions to queued review', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 101, phase: 'implementation',
      implementationAgent: 'claude', now: '2026-06-07T00:00:00.000Z',
    });
    store.close();

    const r = runCli(
      '--session-id', 'addon-dev', '--run-id', 'r2',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'implementation',
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({ ok: true, outcome: 'completed', task: { issueNumber: 101 } });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    store2.close();
    // PR was "created" by fake gh; task should now be queued for review
    expect(task).toMatchObject({ status: 'queued', phase: 'review' });
  });
});

// ---------------------------------------------------------------------------
// Fix mode (status:needs-fix)
// ---------------------------------------------------------------------------

// Helpers for fix-mode runners.
// Fix orchestration order:
//   status(0) checkout-main(1) pull-main(2) gh-pr-list(3) git-checkout-branch(4)
//   git-pull-branch(5) claude(6) diff(7) verification(8) ls-files(9) add(10) commit(11) push(12)
//   (no gh pr create)

const EXISTING_PR_URL = 'https://github.com/m2dw/test-repo/pull/44';
const EXISTING_BRANCH = 'ai/issue-77';
const PR_LIST_JSON = JSON.stringify([
  { number: 44, url: EXISTING_PR_URL, headRefName: EXISTING_BRANCH },
]);

function happyFixRunner() {
  return sequenceRunner([
    { stdout: '', stderr: '', exitCode: 0 },                 // git status — clean
    { stdout: '', stderr: '', exitCode: 0 },                 // git checkout main
    { stdout: '', stderr: '', exitCode: 0 },                 // git pull --ff-only
    { stdout: 'main', stderr: '', exitCode: 0 },             // rev-parse — HEAD at base
    { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },       // gh pr list
    { stdout: '', stderr: '', exitCode: 0 },                 // git checkout <branch>
    { stdout: '', stderr: '', exitCode: 0 },                 // git pull origin <branch>
    { stdout: 'Applied review feedback.', stderr: '', exitCode: 0 }, // claude
    { stdout: '1 file changed', stderr: '', exitCode: 0 },  // git diff --stat HEAD
    { stdout: 'PASS', stderr: '', exitCode: 0 },            // verification (npm test)
    { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },    // git ls-files -z
    { stdout: '', stderr: '', exitCode: 0 },                 // git add -- <paths>
    { stdout: '', stderr: '', exitCode: 0 },                 // git commit
    { stdout: '', stderr: '', exitCode: 0 },                 // git push
  ]);
}

const REVIEW_FEEDBACK = '[P1] Null pointer in auth handler — fix the null check on line 42 of auth.ts';

function makeFixTask(overrides = {}) {
  return makeTask({
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:claude', 'status:needs-fix'],
      reviewFeedback: REVIEW_FEEDBACK,
    },
    ...overrides,
  });
}

// Task with reviewFeedback but no status:needs-fix label (auto-requeue path)
function makeAutoRequeueTask(overrides = {}) {
  return makeTask({
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:claude', 'status:needs-review'],  // original review labels
      reviewFeedback: REVIEW_FEEDBACK,
      prUrl: EXISTING_PR_URL,
    },
    ...overrides,
  });
}

describe('implementation handler — Tool Request grant resume branch (issue #316)', () => {
  // A Tool Request grant during initial implementation can land dependency/Tool
  // Request changes on `ai/issue-<n>` before the run is requeued. manual-done records
  // that branch as `toolRequestResumeBranch`; the requeued NEW-impl run must check it
  // out and continue from there instead of `git checkout -b` (which would collide).
  function happyResumeRunner(branchExists, baseBranch = 'main') {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout <base>
      { stdout: '', stderr: '', exitCode: 0 },                      // git pull --ff-only
      { stdout: baseBranch, stderr: '', exitCode: 0 },              // git rev-parse --abbrev-ref HEAD (== base)
      branchExists
        ? { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 } // git rev-parse --verify (exists)
        : { stdout: '', stderr: '', exitCode: 1 },                      // git rev-parse --verify (absent)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout (<branch> resume) OR (-b <branch> <base>)
      { stdout: 'origin/ai/issue-77', stderr: '', exitCode: 0 },    // git ls-remote --exit-code (origin has it)
      { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin <branch>
      { stdout: '', stderr: '', exitCode: 0 },                      // git merge --ff-only FETCH_HEAD
      { stdout: '0', stderr: '', exitCode: 0 },                     // git rev-list --count FETCH_HEAD..HEAD (not ahead)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
    ]);
  }

  function makeResumeTask() {
    return makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-implementation'],
        toolRequestResumeBranch: 'ai/issue-77',
      },
    });
  }

  test('resumes the recorded issue branch instead of recreating it when it exists', async () => {
    const runner = happyResumeRunner(true);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeResumeTask());
    expect(result.result).toBe('success');

    // The branch existence was probed, then the existing branch was checked out
    // WITHOUT -b (no collision). No `git checkout -b` anywhere in the run.
    const verifyCall = runner.calls[4];
    expect(verifyCall.cmd).toBe('git');
    expect(verifyCall.args).toEqual(['rev-parse', '--verify', '--quiet', 'refs/heads/ai/issue-77']);
    const checkoutCall = runner.calls[5];
    expect(checkoutCall.args).toContain('checkout');
    expect(checkoutCall.args).toContain('ai/issue-77');
    expect(checkoutCall.args).not.toContain('-b');
    const checkoutBCall = runner.calls.find((c) => c.cmd === 'git' && c.args.includes('-b'));
    expect(checkoutBCall).toBeUndefined();

    // The stale local branch is reconciled with origin: probe origin (tri-state),
    // then fetch + fast-forward so any side effects pushed from another clone are
    // included before the run continues (issue #316 review).
    const lsRemoteCall = runner.calls[6];
    expect(lsRemoteCall.args).toEqual(['ls-remote', '--exit-code', '--heads', 'origin', 'ai/issue-77']);
    const fetchCall = runner.calls[7];
    expect(fetchCall.args).toEqual(['fetch', 'origin', 'ai/issue-77']);
    const ffCall = runner.calls[8];
    expect(ffCall.args).toEqual(['merge', '--ff-only', 'FETCH_HEAD']);
  });

  // `git merge --ff-only FETCH_HEAD` is a no-op (exit 0) when the local branch is
  // ahead of origin, leaving unpushed commits in place. The resume path must check
  // `FETCH_HEAD..HEAD` and fail closed rather than continue from — and later push or
  // delete — commits that were never confirmed pushed (issue #316 review).
  test('fails closed when the local resume branch is ahead of origin', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout <base>
      { stdout: '', stderr: '', exitCode: 0 },                      // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                  // git rev-parse --abbrev-ref HEAD (== base)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// git rev-parse --verify (exists)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout ai/issue-77
      { stdout: 'origin/ai/issue-77', stderr: '', exitCode: 0 },    // git ls-remote --exit-code (origin has it)
      { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin <branch>
      { stdout: '', stderr: '', exitCode: 0 },                      // git merge --ff-only FETCH_HEAD (no-op: local ahead)
      { stdout: '2', stderr: '', exitCode: 0 },                     // git rev-list --count FETCH_HEAD..HEAD (ahead by 2)
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeResumeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toContain('ahead of origin/ai/issue-77');
    // It must not proceed to the implementation step (claude) on the unpushed branch.
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude' || (c.cmd && c.cmd.includes('claude')));
    expect(claudeCall).toBeUndefined();
  });

  // origin positively lacks the branch (grant created it locally, never pushed):
  // ls-remote exits 2 → keep the local branch as-is, no fetch/merge.
  test('keeps the local resume branch when origin lacks it (ls-remote exit 2)', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout <base>
      { stdout: '', stderr: '', exitCode: 0 },                      // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                  // git rev-parse --abbrev-ref HEAD (== base)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// git rev-parse --verify (exists)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout ai/issue-77
      { stdout: '', stderr: '', exitCode: 2 },                      // git ls-remote --exit-code (no match)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeResumeTask());
    expect(result.result).toBe('success');
    // No fetch/merge after the ls-remote no-match — the local branch is the source.
    const fetchCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetchCall).toBeUndefined();
    const mergeCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'merge');
    expect(mergeCall).toBeUndefined();
  });

  // A transient ls-remote failure (exit code other than 0/2) must NOT be read as
  // "origin lacks the branch" and skip the fast-forward — the run fails closed so
  // it never continues on a possibly-stale local branch (issue #316 review).
  test('fails closed when the resume branch origin lookup is inconclusive', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout <base>
      { stdout: '', stderr: '', exitCode: 0 },                      // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                  // git rev-parse --abbrev-ref HEAD (== base)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// git rev-parse --verify (exists)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout ai/issue-77
      { stdout: '', stderr: 'could not read from remote', exitCode: 128 }, // git ls-remote (transient failure)
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeResumeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toContain('git ls-remote origin ai/issue-77');
    // It must not proceed to run claude on the stale branch.
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude');
    expect(claudeCall).toBeUndefined();
  });

  // The recorded resume branch is absent locally because the operator committed and
  // pushed the Tool Request side effects from another clone — it lives only on
  // origin (manual-done records the branch when origin has it; issue #316 review).
  // The requeued run must fetch and continue from origin, NOT branch fresh from base
  // (which would silently discard the pushed dependency/Tool Request changes).
  function originResumeRunner(fetchOk) {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout <base>
      { stdout: '', stderr: '', exitCode: 0 },                      // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                  // git rev-parse --abbrev-ref HEAD (== base)
      { stdout: '', stderr: '', exitCode: 1 },                      // git rev-parse --verify (absent locally)
      fetchOk
        ? { stdout: '', stderr: '', exitCode: 0 }                   // git fetch origin <branch>
        : { stdout: '', stderr: 'could not read from remote', exitCode: 1 },
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout -B <branch> FETCH_HEAD
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
    ]);
  }

  test('fetches the recorded branch from origin when it is absent locally', async () => {
    const runner = originResumeRunner(true);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeResumeTask());
    expect(result.result).toBe('success');

    // Branch absent locally → fetch it from origin and check it out, NEVER branch
    // fresh from base. No `git checkout -b <branch> <base>` anywhere.
    const fetchCall = runner.calls[5];
    expect(fetchCall.cmd).toBe('git');
    expect(fetchCall.args).toEqual(['fetch', 'origin', 'ai/issue-77']);
    const checkoutCall = runner.calls[6];
    expect(checkoutCall.args).toContain('checkout');
    expect(checkoutCall.args).toContain('-B');
    expect(checkoutCall.args).toContain('ai/issue-77');
    expect(checkoutCall.args).toContain('FETCH_HEAD');
    const checkoutBCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-b'),
    );
    expect(checkoutBCall).toBeUndefined();
  });

  test('fails closed when the recorded branch cannot be fetched from origin', async () => {
    const runner = originResumeRunner(false);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeResumeTask());
    // A transient origin fetch failure must NOT fall through to branching from base
    // and discarding the pushed side effects — the run fails closed instead.
    expect(result.result).toBe('failed');
    expect(result.error).toContain('git fetch origin ai/issue-77');
    const checkoutBCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-b'),
    );
    expect(checkoutBCall).toBeUndefined();
  });

  test('a normal new-impl task never probes for a resume branch', async () => {
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    // No `toolRequestResumeBranch` in context → the rev-parse --verify probe is
    // never issued, so the command sequence matches the original new-impl path.
    const verifyCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args.includes('--verify'),
    );
    expect(verifyCall).toBeUndefined();
    const checkoutBCall = runner.calls.find((c) => c.cmd === 'git' && c.args.includes('-b'));
    expect(checkoutBCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Resumed-branch no-op success (issue #404)
//
// After a Tool Request / manual-done recovery the issue implementation is already
// committed on `ai/issue-<n>`. A requeued implementation run that resumes that
// branch may correctly produce no NEW file changes (the agent confirms the work is
// already done). That must succeed when `base..HEAD` already carries committed
// changes — but a fresh branch with no committed changes must still fail.
// ---------------------------------------------------------------------------

describe('implementation handler — resumed-branch no-op success (issue #404)', () => {
  // Resume an existing local `ai/issue-77` that is reconciled with origin, then the
  // agent makes no new edits. `diffQuietExit` models `git diff --quiet base...HEAD`:
  // exit 1 = the branch already has committed changes; exit 0 = the branch is empty.
  function resumedNoopRunner(diffQuietExit) {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // 0  git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                      // 1  git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                      // 2  git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                  // 3  git rev-parse --abbrev-ref HEAD (== base)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// 4  git rev-parse --verify (exists)
      { stdout: '', stderr: '', exitCode: 0 },                      // 5  git checkout ai/issue-77 (resume)
      { stdout: 'origin/ai/issue-77', stderr: '', exitCode: 0 },    // 6  git ls-remote --exit-code (origin has it)
      { stdout: '', stderr: '', exitCode: 0 },                      // 7  git fetch origin <branch>
      { stdout: '', stderr: '', exitCode: 0 },                      // 8  git merge --ff-only FETCH_HEAD
      { stdout: '0', stderr: '', exitCode: 0 },                     // 9  git rev-list --count FETCH_HEAD..HEAD (not ahead)
      { stdout: '', stderr: '', exitCode: 0 },                      // 10 claude — no new changes
      { stdout: '', stderr: '', exitCode: 0 },                      // 11 git diff --stat HEAD (empty)
      { stdout: '', stderr: '', exitCode: 0 },                      // 12 git ls-files --others (no untracked)
      { stdout: '', stderr: '', exitCode: diffQuietExit },          // 13 git diff --quiet base...HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // 14 verification (npm test)
      { stdout: '', stderr: '', exitCode: 0 },                      // 15 git ls-files -z (nothing stageable)
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },            // 16 gh pr list (reuse existing PR)
    ]);
  }

  function makeResumeTask() {
    return makeTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-implementation'],
        toolRequestResumeBranch: 'ai/issue-77',
      },
    });
  }

  test('existing issue branch has committed changes + agent no-op -> success', async () => {
    const runner = resumedNoopRunner(1); // base...HEAD has committed changes
    const result = await createImplementationHandler(CONTEXT(), runner)(makeResumeTask());
    expect(result.result).toBe('success');

    // The committed-changes probe was issued against the base branch.
    const diffQuietCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('--quiet'),
    );
    expect(diffQuietCall).toBeDefined();
    expect(diffQuietCall.args).toEqual(['diff', '--quiet', 'main...HEAD']);

    // No new commit/push: the branch is already committed and pushed.
    const commitCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'commit');
    expect(commitCall).toBeUndefined();
    const pushCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
    expect(pushCall).toBeUndefined();

    // Review can proceed normally: branch + the reused existing PR url are carried.
    expect(result.context.branch).toBe('ai/issue-77');
    expect(result.context.prUrl).toBe(EXISTING_PR_URL);
    expect(result.context.resumedNoChanges).toBe(true);
  });

  test('existing issue branch has no committed changes + agent no-op -> failure', async () => {
    const runner = resumedNoopRunner(0); // base...HEAD is empty
    const result = await createImplementationHandler(CONTEXT(), runner)(makeResumeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/no file changes/);
  });

  // Dependency-start-point mode (issue #404 review): the resumed issue branch is
  // built ON TOP OF the blocker PR head. Comparing against the base branch would
  // count the blocker PR's commits as this issue's implementation, letting a
  // requeued no-op succeed with only the dependency changes. The probe must
  // exclude the blocker head — fetch it and compare against FETCH_HEAD instead.
  const DEP_BLOCKER_HEAD = 'ai/issue-50';
  const DEP_BLOCKER_PR = {
    number: 55, url: 'https://github.com/m2dw/test-repo/pull/55', headRefName: DEP_BLOCKER_HEAD,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  };
  const depResumeChecker = {
    async getBlockedBy() { return [{ issueNumber: 50, state: 'open' }]; },
  };

  // Resume an existing `ai/issue-77` stacked on the blocker head, then the agent
  // makes no new edits. `blockerDiffQuietExit` models
  // `git diff --quiet FETCH_HEAD...HEAD` (FETCH_HEAD = blocker head): exit 1 = the
  // branch has issue-specific commits beyond the blocker; exit 0 = it carries only
  // the blocker's commits.
  function depResumedNoopRunner(blockerDiffQuietExit, extraSteps = []) {
    return sequenceRunner([
      { stdout: JSON.stringify([DEP_BLOCKER_PR]), stderr: '', exitCode: 0 },         // 0  gh pr list (dep check)
      { stdout: JSON.stringify({ labels: [{ name: 'status:stack-ready' }] }), stderr: '', exitCode: 0 }, // 1  gh issue view (dep check)
      { stdout: '', stderr: '', exitCode: 0 },                      // 2  git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                      // 3  git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                      // 4  git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                  // 5  git rev-parse --abbrev-ref HEAD (== base)
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },// 6  git rev-parse --verify (resume branch exists)
      { stdout: '', stderr: '', exitCode: 0 },                      // 7  git checkout ai/issue-77 (resume)
      { stdout: 'origin/ai/issue-77', stderr: '', exitCode: 0 },    // 8  git ls-remote --exit-code (origin has it)
      { stdout: '', stderr: '', exitCode: 0 },                      // 9  git fetch origin <branch>
      { stdout: '', stderr: '', exitCode: 0 },                      // 10 git merge --ff-only FETCH_HEAD
      { stdout: '0', stderr: '', exitCode: 0 },                     // 11 git rev-list --count FETCH_HEAD..HEAD (not ahead)
      { stdout: '', stderr: '', exitCode: 0 },                      // 12 claude — no new changes
      { stdout: '', stderr: '', exitCode: 0 },                      // 13 git diff --stat HEAD (empty)
      { stdout: '', stderr: '', exitCode: 0 },                      // 14 git ls-files --others (no untracked)
      { stdout: '', stderr: '', exitCode: 0 },                      // 15 git fetch origin <blocker head>
      { stdout: '', stderr: '', exitCode: blockerDiffQuietExit },   // 16 git diff --quiet FETCH_HEAD...HEAD
      ...extraSteps,
    ]);
  }

  test('dependency-start-point resume: blocker-only commits + agent no-op -> failure', async () => {
    // The branch carries ONLY the blocker PR's commits (diff beyond the blocker
    // head is empty). A no-op resume must NOT be marked successful.
    const runner = depResumedNoopRunner(0);
    const result = await createImplementationHandler(CONTEXT(), runner, depResumeChecker)(makeResumeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/no file changes/);
    // The probe excluded the dependency start point: it fetched the blocker head
    // and compared FETCH_HEAD...HEAD, never base...HEAD.
    const diffQuietCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('--quiet'),
    );
    expect(diffQuietCall.args).toEqual(['diff', '--quiet', 'FETCH_HEAD...HEAD']);
    const blockerFetch = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'fetch' && c.args.includes(DEP_BLOCKER_HEAD),
    );
    expect(blockerFetch).toBeDefined();
  });

  test('dependency-start-point resume: issue commits beyond blocker + agent no-op -> success', async () => {
    // The branch has issue-specific commits ON TOP OF the blocker head (diff
    // beyond the blocker head is non-empty), so the no-op resume succeeds.
    const runner = depResumedNoopRunner(1, [
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // 17 verification (npm test)
      { stdout: '', stderr: '', exitCode: 0 },                      // 18 git ls-files -z (nothing stageable)
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },            // 19 gh pr list (reuse existing PR)
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner, depResumeChecker)(makeResumeTask());
    expect(result.result).toBe('success');
    const diffQuietCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('--quiet'),
    );
    expect(diffQuietCall.args).toEqual(['diff', '--quiet', 'FETCH_HEAD...HEAD']);
    expect(result.context.branch).toBe('ai/issue-77');
    expect(result.context.resumedNoChanges).toBe(true);
  });

  test('fresh new-impl no-op remains a failure and never probes base...HEAD', async () => {
    // No toolRequestResumeBranch → the fresh branch path. A no-op must still fail,
    // and the committed-changes probe must never run for a fresh implementation.
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },              // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },              // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },          // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },              // git checkout -b
      { stdout: '', stderr: '', exitCode: 0 },              // claude — succeeds, no edits
      { stdout: '', stderr: '', exitCode: 0 },              // git diff --stat HEAD (empty)
      { stdout: '', stderr: '', exitCode: 0 },              // git ls-files --others (no untracked)
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/no file changes/);
    const diffQuietCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('--quiet'),
    );
    expect(diffQuietCall).toBeUndefined();
  });
});

describe('implementation handler — fix mode (status:needs-fix)', () => {
  test('checks out existing branch instead of creating a new one', async () => {
    const runner = happyFixRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    // calls[4] = gh pr list, calls[5] = git checkout <existing branch> (no -b flag)
    const checkoutCall = runner.calls[5];
    expect(checkoutCall.cmd).toBe('git');
    expect(checkoutCall.args).toContain('checkout');
    expect(checkoutCall.args).not.toContain('-b');
    expect(checkoutCall.args).toContain(EXISTING_BRANCH);
  });

  test('does not call gh pr create', async () => {
    const runner = happyFixRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    const ghPrCreateCalls = runner.calls.filter(
      (c) => c.cmd === 'gh' && c.args.includes('create'),
    );
    expect(ghPrCreateCalls).toHaveLength(0);
  });

  test('pushes to the existing PR branch', async () => {
    const runner = happyFixRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    const pushCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args.includes('push'),
    );
    expect(pushCall).toBeDefined();
    expect(pushCall.args).toContain(EXISTING_BRANCH);
  });

  test('returns success with existing prUrl and branch in context', async () => {
    const runner = happyFixRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    expect(result.result).toBe('success');
    expect(result.context?.prUrl).toBe(EXISTING_PR_URL);
    expect(result.context?.branch).toBe(EXISTING_BRANCH);
  });

  test('dirty worktree guard still applies in fix mode', async () => {
    const runner = sequenceRunner([
      { stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 }, // dirty
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/dirty/);
    expect(runner.calls).toHaveLength(1);
  });

  test('fails clearly when no open PR exists for the issue', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },          // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },          // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },          // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },      // rev-parse — HEAD at base
      { stdout: '[]', stderr: '', exitCode: 0 },        // gh pr list — empty
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/No open PR found/);
    expect(result.error).toMatch(/77/);
  });

  test('fails when gh pr list itself errors', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },           // rev-parse — HEAD at base
      { stdout: '', stderr: 'gh: auth error', exitCode: 1 }, // gh pr list fails
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/gh pr list failed/);
  });

  test('fix mode: new impl task (needs-implementation) still creates branch and PR', async () => {
    // Confirm normal task (not fix) still goes through the original path
    const runner = happyRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('success');
    const checkoutBCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args.includes('-b'),
    );
    expect(checkoutBCall).toBeDefined();
    const ghCreateCall = runner.calls.find(
      (c) => c.cmd === 'gh' && c.args.includes('create'),
    );
    expect(ghCreateCall).toBeDefined();
  });

  test('fix mode prompt includes Review Feedback section with captured findings', async () => {
    const runner = happyFixRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    const claudeCall = runner.calls.find((c) => c.cmd === 'claude');
    expect(claudeCall).toBeDefined();
    expect(claudeCall.opts.stdin).toContain('Review Feedback To Address');
    expect(claudeCall.opts.stdin).toContain(REVIEW_FEEDBACK);
    expect(claudeCall.opts.stdin).toContain('Fix Task');
  });

  test('fix mode triggered by reviewFeedback alone (auto-requeue path, no status:needs-fix label)', async () => {
    const runner = happyFixRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeAutoRequeueTask());
    expect(result.result).toBe('success');
    // Should NOT have called git checkout -b (fix mode, not new-impl)
    const checkoutBCall = runner.calls.find(
      (c) => c.cmd === 'git' && c.args.includes('-b'),
    );
    expect(checkoutBCall).toBeUndefined();
    // Should NOT have called gh pr create
    const ghCreateCall = runner.calls.find(
      (c) => c.cmd === 'gh' && c.args.includes('create'),
    );
    expect(ghCreateCall).toBeUndefined();
  });

  test('fails clearly when fix mode is active but reviewFeedback is missing', async () => {
    const runner = sequenceRunner([]); // no calls expected
    const taskNoFeedback = makeFixTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-fix'],
        // reviewFeedback intentionally absent
      },
    });
    const result = await createImplementationHandler(CONTEXT(), runner)(taskNoFeedback);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Fix mode requires review feedback/);
    // Claude must NOT have been called
    expect(runner.calls).toHaveLength(0);
  });

  test('fails clearly when reviewFeedback is empty string', async () => {
    const runner = sequenceRunner([]);
    const taskEmptyFeedback = makeFixTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:claude', 'status:needs-fix'],
        reviewFeedback: '   ', // whitespace-only
      },
    });
    const result = await createImplementationHandler(CONTEXT(), runner)(taskEmptyFeedback);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Fix mode requires review feedback/);
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dependency recheck gate (new implementation only)
// ---------------------------------------------------------------------------

describe('implementation handler — dependency recheck gate', () => {
  const blockedDepChecker = {
    async getBlockedBy() { return [{ issueNumber: 50, state: 'open' }]; },
  };
  const failingDepChecker = {
    async getBlockedBy() { throw new Error('GraphQL error: field not found'); },
  };
  const clearedDepChecker = {
    async getBlockedBy() { return [{ issueNumber: 49, state: 'closed' }]; },
  };
  // Mix of one closed and one open blocker: the plan blocks on the open one but
  // the recheck snapshot must still record the full relationship list.
  const mixedDepChecker = {
    async getBlockedBy() { return [{ issueNumber: 49, state: 'closed' }, { issueNumber: 50, state: 'open' }]; },
  };

  // Dep check now runs BEFORE any git/local-preflight commands (issue #224).
  // The plan resolver only issues gh CLI calls; no checkout state is needed.

  // A single gh pr list call — the dep check result when one open blocker is found
  // and the plan resolver looks up its PR (and returns no PR / blocked).
  function depCheckPrList(prListResult) {
    return sequenceRunner([
      prListResult,  // gh pr list (blocker PR lookup) — first and only runner call for blocked case
    ]);
  }

  test('returns blocked when the single open blocker has no usable PR', async () => {
    const runner = depCheckPrList({ stdout: '[]', stderr: '', exitCode: 0 });
    const result = await createImplementationHandler(CONTEXT(), runner, blockedDepChecker)(makeTask());
    expect(result.result).toBe('blocked');
    // No git commands ran (dep check short-circuited before any local preflight)
    expect(runner.calls.some((c) => c.cmd === 'git')).toBe(false);
    // No branch created
    expect(runner.calls.some((c) => c.args.includes('-b'))).toBe(false);
  });

  test('blocked message names the blocker issue number', async () => {
    const runner = depCheckPrList({ stdout: '[]', stderr: '', exitCode: 0 });
    const result = await createImplementationHandler(CONTEXT(), runner, blockedDepChecker)(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toContain('50');
  });

  test('blocked result includes dependencyRecheck snapshot in context', async () => {
    const runner = depCheckPrList({ stdout: '[]', stderr: '', exitCode: 0 });
    const result = await createImplementationHandler(CONTEXT(), runner, blockedDepChecker)(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.context?.dependencyRecheck).toMatchObject({
      blocked: true,
      source: 'github-relationships',
      blockedBy: [{ issueNumber: 50, state: 'open' }],
    });
    expect(typeof result.context?.dependencyRecheck?.checkedAt).toBe('string');
  });

  test('blocked recheck snapshot records the full relationship list (open + closed)', async () => {
    const runner = depCheckPrList({ stdout: '[]', stderr: '', exitCode: 0 });
    const result = await createImplementationHandler(CONTEXT(), runner, mixedDepChecker)(makeTask());
    expect(result.result).toBe('blocked');
    // blockedBy must include the closed blocker too, not just the open one.
    expect(result.context?.dependencyRecheck?.blockedBy).toEqual([
      { issueNumber: 49, state: 'closed' },
      { issueNumber: 50, state: 'open' },
    ]);
  });

  test('fail-closed: returns blocked when depChecker throws — no git/gh commands run', async () => {
    // depChecker.getBlockedBy throws before the plan resolver issues any runner
    // call, so the runner receives zero calls (issue #224: dep check runs before
    // any local preflight).
    const runner = sequenceRunner([]);
    const result = await createImplementationHandler(CONTEXT(), runner, failingDepChecker)(makeTask());
    expect(result.result).toBe('blocked');
    expect(runner.calls).toHaveLength(0);
  });

  test('proceeds normally when depChecker returns only closed blockers', async () => {
    const runner = happyRunner();
    const result = await createImplementationHandler(CONTEXT(), runner, clearedDepChecker)(makeTask());
    expect(result.result).toBe('success');
  });

  test('proceeds normally when no depChecker is provided', async () => {
    const runner = happyRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('success');
  });

  test('skips dependency recheck in fix mode even when depChecker would block', async () => {
    const runner = happyFixRunner();
    const result = await createImplementationHandler(CONTEXT(), runner, blockedDepChecker)(makeFixTask());
    expect(result.result).toBe('success');
  });

  // ---------------------------------------------------------------------------
  // Regression: issue #217 — task with stored dependencyDecision.blocked = true
  // reaching the handler while the worktree is dirty must not fail with a
  // dirty-worktree error; instead the dep check fires first and returns blocked.
  // ---------------------------------------------------------------------------

  test('#217 regression: dirty worktree does not cause failed when task already has dependencyDecision.blocked=true', async () => {
    // The depChecker confirms the blocker is still open. The runner would return
    // a dirty worktree if git status were called — but it must NOT be called.
    const dirtyRunner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },             // gh pr list (dep check)
      { stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 }, // git status — dirty (must NOT be reached)
    ]);
    const taskWithStoredDecision = makeTask({
      context: {
        ...makeTask().context,
        dependencyDecision: {
          checkedAt: '2026-06-01T00:00:00.000Z',
          source: 'github-relationships',
          blockedBy: [{ issueNumber: 216, state: 'open' }],
          blocked: true,
        },
      },
    });
    const result = await createImplementationHandler(CONTEXT(), dirtyRunner, blockedDepChecker)(taskWithStoredDecision);
    expect(result.result).toBe('blocked');
    // The dirty-worktree git status call must NOT have been reached
    expect(dirtyRunner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'status')).toBe(false);
    // Error message must NOT mention dirty worktree
    expect(result.error ?? '').not.toMatch(/dirty/);
  });

  test('#217 regression: task with dependencyDecision.blocked=true but now-cleared blockers proceeds normally', async () => {
    // The stored context says blocked, but the depChecker now reports the blocker closed.
    // The dep check returns plan.kind === "none" → proceed to implementation.
    const runner = happyRunner();
    const taskWithStaleDecision = makeTask({
      context: {
        ...makeTask().context,
        dependencyDecision: {
          checkedAt: '2026-06-01T00:00:00.000Z',
          source: 'github-relationships',
          blockedBy: [{ issueNumber: 216, state: 'open' }],
          blocked: true,
        },
      },
    });
    const result = await createImplementationHandler(CONTEXT(), runner, clearedDepChecker)(taskWithStaleDecision);
    expect(result.result).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Dependency-aware branch start point (issue #208, #242)
//
// When the dependent issue's single open blocker already has a usable PR, the
// dependent branch is CREATED FROM the blocker PR head instead of the base
// branch (so the code compiles against the blocker changes), but the dependent
// PR still TARGETS the session base branch (`main`) — branch start point and PR
// target are deliberately different concepts (issue #242).
// ---------------------------------------------------------------------------

describe('implementation handler — dependency-aware start point (issue #208, #242)', () => {
  const BLOCKER_HEAD = 'ai/issue-50';
  const BLOCKER_PR_URL = 'https://github.com/m2dw/test-repo/pull/55';
  const BLOCKER_PR = {
    number: 55, url: BLOCKER_PR_URL, headRefName: BLOCKER_HEAD,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  };
  const READY_LABEL = 'ai:ready-for-human';
  // The blocker is a usable stacking base only when its review PASSED, signalled
  // by the success-specific stack-ready marker. readyForHuman is no longer
  // accepted because it is also applied to escalated reviews (issue #208).
  const STACK_READY_LABEL = 'status:stack-ready';

  const oneOpenBlockerDepChecker = {
    async getBlockedBy() { return [{ issueNumber: 50, state: 'open' }]; },
  };
  const twoOpenBlockersDepChecker = {
    async getBlockedBy() { return [{ issueNumber: 50, state: 'open' }, { issueNumber: 60, state: 'open' }]; },
  };
  const noBlockerDepChecker = {
    async getBlockedBy() { return []; },
  };

  function issueViewJson(labels) {
    return JSON.stringify({ labels: labels.map((name) => ({ name })) });
  }

  // Full happy stacked sequence. Dep check runs FIRST (before any git ops) per
  // issue #224. Calls:
  // gh-pr-list(0) gh-issue-view(1)           ← dep check (no git needed)
  // status(2) checkout-main(3) pull(4) rev-parse(5)   ← git preflight
  // git-fetch(6) checkout-b-FETCH_HEAD(7) claude(8) diff(9) verification(10)
  // ls-files(11) add(12) commit(13) push(14) gh-pr-create(15)
  function stackedHappyRunner(prUrl = 'https://github.com/m2dw/test-repo/pull/99') {
    return sequenceRunner([
      { stdout: JSON.stringify([BLOCKER_PR]), stderr: '', exitCode: 0 }, // gh pr list (dep check — first!)
      { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 }, // gh issue view (dep check)
      { stdout: '', stderr: '', exitCode: 0 },                          // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                          // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                          // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                      // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },                          // git fetch origin <head>
      { stdout: '', stderr: '', exitCode: 0 },                          // git checkout -b <branch> FETCH_HEAD
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },      // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },           // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                      // verification (npm test)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },              // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                          // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                          // git commit
      { stdout: '', stderr: '', exitCode: 0 },                          // git push
      { stdout: prUrl, stderr: '', exitCode: 0 },                       // gh pr create
    ]);
  }

  test('no dependency: branches from the base branch and targets the base in the PR', async () => {
    const runner = happyRunner();
    const result = await createImplementationHandler(CONTEXT(), runner, noBlockerDepChecker)(makeTask());
    expect(result.result).toBe('success');
    // Branch created explicitly from main, not via fetch/FETCH_HEAD
    const checkoutB = runner.calls.find((c) => c.cmd === 'git' && c.args.includes('-b'));
    expect(checkoutB.args).toEqual(['checkout', '-b', 'ai/issue-77', 'main']);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(false);
    const ghCreate = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    expect(ghCreate.args[ghCreate.args.indexOf('--base') + 1]).toBe('main');
    // No dependency base metadata recorded for the no-dependency case
    expect(result.context?.dependencyBase).toBeUndefined();
  });

  test('one usable blocker PR: command order fetches blocker head then branches from FETCH_HEAD', async () => {
    const runner = stackedHappyRunner();
    const result = await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    expect(result.result).toBe('success');
    const calls = runner.calls;
    // Dep check (gh pr list + gh issue view) now runs BEFORE any git preflight
    expect(calls[0]).toMatchObject({ cmd: 'gh', args: expect.arrayContaining(['pr', 'list']) });
    expect(calls[6]).toMatchObject({ cmd: 'git', args: ['fetch', 'origin', BLOCKER_HEAD] });
    expect(calls[7]).toMatchObject({ cmd: 'git', args: ['checkout', '-b', 'ai/issue-77', 'FETCH_HEAD'] });
    expect(calls[8].cmd).toBe('claude');
  });

  test('one usable blocker PR: dependent branch is not created from stale main', async () => {
    const runner = stackedHappyRunner();
    await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    // The branch-creating checkout -b must use FETCH_HEAD, never the base branch.
    const checkoutB = runner.calls.find((c) => c.cmd === 'git' && c.args.includes('-b'));
    expect(checkoutB.args).toEqual(['checkout', '-b', 'ai/issue-77', 'FETCH_HEAD']);
    expect(checkoutB.args).not.toContain('main');
  });

  test('one usable blocker PR: dependent PR targets the session base branch, NOT the blocker head (issue #242)', async () => {
    // The branch START POINT is the blocker head (FETCH_HEAD), but the PR must
    // still target the session base branch (`main`) so the dependent issue's
    // mainline delivery stays visible. There is no retargeting step.
    const runner = stackedHappyRunner();
    await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    const ghCreate = runner.calls.find((c) => c.cmd === 'gh' && c.args.includes('create'));
    expect(ghCreate.args).toContain('--base');
    expect(ghCreate.args[ghCreate.args.indexOf('--base') + 1]).toBe('main');
    expect(ghCreate.args).not.toContain(BLOCKER_HEAD);
  });

  test('one usable blocker PR: task context records dependency base metadata', async () => {
    const runner = stackedHappyRunner();
    const result = await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    expect(result.context?.dependencyBase).toEqual({
      baseIssueNumber: 50,
      basePrNumber: 55,
      baseHeadRefName: BLOCKER_HEAD,
      basePrUrl: BLOCKER_PR_URL,
    });
  });

  test('one usable blocker PR: dependency base metadata is persisted to result.json', async () => {
    const runner = stackedHappyRunner();
    await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    const result = JSON.parse(
      readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8'),
    );
    expect(result.dependencyBase).toEqual({
      baseIssueNumber: 50,
      basePrNumber: 55,
      baseHeadRefName: BLOCKER_HEAD,
      basePrUrl: BLOCKER_PR_URL,
    });
  });

  test('fresh/single-branch clone: uses git fetch + FETCH_HEAD and never a remote-tracking ref', async () => {
    const runner = stackedHappyRunner();
    await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    // The head is fetched explicitly so a missing origin/<head> ref is irrelevant.
    const fetchCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetchCall.args).toEqual(['fetch', 'origin', BLOCKER_HEAD]);
    // Nothing references a remote-tracking ref like origin/ai/issue-50.
    for (const call of runner.calls) {
      expect(call.args).not.toContain(`origin/${BLOCKER_HEAD}`);
    }
  });

  test('one usable blocker PR + recorded resume branch: resumes the issue branch, never recreates from the blocker head (issue #316 review)', async () => {
    // A Tool Request grant raised during dependency-start-point implementation
    // landed the side effects on `ai/issue-77` (created from the blocker head) and
    // manual-done recorded it as the resume branch. The next run still sees the
    // dependency as ready (depBase set), but it must resume from `ai/issue-77`
    // rather than fetch the blocker head and `git checkout -b` (which would collide
    // with the existing branch or discard the granted changes).
    const runner = sequenceRunner([
      { stdout: JSON.stringify([BLOCKER_PR]), stderr: '', exitCode: 0 },        // gh pr list (dep check)
      { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 },  // gh issue view (dep check)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                                  // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                                  // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                              // rev-parse — HEAD at base
      { stdout: 'refs/heads/ai/issue-77', stderr: '', exitCode: 0 },            // rev-parse --verify (resume branch exists locally)
      { stdout: '', stderr: '', exitCode: 0 },                                  // git checkout ai/issue-77 (resume)
      { stdout: '', stderr: '', exitCode: 2 },                                  // ls-remote --exit-code (origin lacks it; keep local)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },              // claude
      { stdout: '2 files changed', stderr: '', exitCode: 0 },                   // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                              // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },                      // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                  // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                                  // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                  // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
    ]);
    const task = makeTask({ context: { ...makeTask().context, toolRequestResumeBranch: 'ai/issue-77' } });
    const result = await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(task);
    expect(result.result).toBe('success');

    // The recorded resume branch was checked out WITHOUT -b, and the blocker head
    // was never fetched or used as a branch start point.
    const verifyCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'rev-parse' && c.args.includes('--verify'));
    expect(verifyCall.args).toEqual(['rev-parse', '--verify', '--quiet', 'refs/heads/ai/issue-77']);
    const checkoutB = runner.calls.find((c) => c.cmd === 'git' && c.args.includes('-b'));
    expect(checkoutB).toBeUndefined();
    const fetchCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'fetch');
    expect(fetchCall).toBeUndefined();
    const checkoutResume = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('ai/issue-77'));
    expect(checkoutResume.args).toEqual(['checkout', 'ai/issue-77']);
  });

  test('unsupported multiple open blockers: returns blocked without any runner calls', async () => {
    // Two open blockers — dep check short-circuits before the resolver issues any
    // runner call (no gh pr list needed). Since dep check now runs BEFORE git
    // preflight, zero commands are issued (issue #224).
    const runner = sequenceRunner([]);
    const result = await createImplementationHandler(CONTEXT(), runner, twoOpenBlockersDepChecker)(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/only one is supported/i);
    expect(runner.calls).toHaveLength(0);
  });

  test('blocker PR missing: returns blocked — dep check fires before any git op', async () => {
    // Dep check runs first: gh pr list returns no open PR → blocked. No git
    // commands run (issue #224).
    const runner = sequenceRunner([
      { stdout: '[]', stderr: '', exitCode: 0 },  // gh pr list (dep check) — no open PR
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/no open PR/i);
    expect(runner.calls.some((c) => c.cmd === 'git')).toBe(false);
    expect(runner.calls.some((c) => c.args.includes('-b'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(false);
  });

  test('blocker PR conflicted: returns blocked — dep check fires before any git op', async () => {
    const conflicted = { ...BLOCKER_PR, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    const runner = sequenceRunner([
      { stdout: JSON.stringify([conflicted]), stderr: '', exitCode: 0 },  // gh pr list (dep check)
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/CONFLICTING|DIRTY/);
    expect(runner.calls.some((c) => c.cmd === 'git')).toBe(false);
    expect(runner.calls.some((c) => c.args.includes('-b'))).toBe(false);
  });

  test('failed git fetch of blocker head returns failed without creating a PR', async () => {
    // Dep check succeeds (blocker PR is usable), then git preflight runs, then
    // git fetch of the blocker head fails.
    const runner = sequenceRunner([
      { stdout: JSON.stringify([BLOCKER_PR]), stderr: '', exitCode: 0 },  // gh pr list (dep check)
      { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 },  // gh issue view (dep check)
      { stdout: '', stderr: '', exitCode: 0 },                            // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                            // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                            // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                        // rev-parse — HEAD at base
      { stdout: '', stderr: 'fatal: couldn\'t find remote ref', exitCode: 1 }, // git fetch — fails
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner, oneOpenBlockerDepChecker)(makeTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/git fetch origin/);
    expect(runner.calls.some((c) => c.args.includes('-b'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args.includes('create'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resolved agent profile metadata
// ---------------------------------------------------------------------------

describe('implementation handler — resolved profile metadata', () => {
  const dir = () => join(artifactRoot, 'runs', 'run-impl-1');

  test('writes implementation-context.json before invoking claude', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    expect(existsSync(join(dir(), 'implementation-context.json'))).toBe(true);
  });

  test('implementation-context.json contains resolvedProfile with phase and agentId', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'implementation', agentId: 'claude', cmd: 'claude' });
  });

  test('implementation-context.json exists even on claude failure (pre-run audit)', async () => {
    await createImplementationHandler(CONTEXT(), fakeFail())(makeTask());
    expect(existsSync(join(dir(), 'implementation-context.json'))).toBe(true);
  });

  test('no complexity label -> default model/effort/budget with source=default', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({
      model: 'sonnet', modelSource: 'default',
      effort: 'high', effortSource: 'default',
      maxBudgetUsd: '5', budgetSource: 'default',
    });
  });

  test('complexity:low label records label-sourced profile', async () => {
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:claude', 'status:needs-implementation', 'complexity:low'] } });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({
      model: 'sonnet', modelSource: 'label',
      effort: 'low', effortSource: 'label',
      maxBudgetUsd: '2', budgetSource: 'label',
    });
  });

  test('complexity:high label records label-sourced profile', async () => {
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:claude', 'status:needs-implementation', 'complexity:high'] } });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({
      model: 'opus', modelSource: 'label',
      effort: 'high', effortSource: 'label',
      maxBudgetUsd: '10', budgetSource: 'label',
    });
  });

  test('complexity:xhigh label records label-sourced profile (effort=xhigh, $20)', async () => {
    const task = makeTask({ context: { ...makeTask().context, labels: ['agent:claude', 'status:needs-implementation', 'complexity:xhigh'] } });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({
      model: 'opus', modelSource: 'label',
      effort: 'xhigh', effortSource: 'label',
      maxBudgetUsd: '20', budgetSource: 'label',
    });
  });

  test('env vars record source=env in resolved profile', async () => {
    process.env['CLAUDE_MODEL'] = 'opus';
    process.env['CLAUDE_EFFORT'] = 'high';
    process.env['CLAUDE_MAX_BUDGET_USD'] = '20';
    try {
      await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    } finally {
      delete process.env['CLAUDE_MODEL'];
      delete process.env['CLAUDE_EFFORT'];
      delete process.env['CLAUDE_MAX_BUDGET_USD'];
    }
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({
      model: 'opus', modelSource: 'env',
      effort: 'high', effortSource: 'env',
      maxBudgetUsd: '20', budgetSource: 'env',
    });
  });

  test('escalatedEffort records source=escalation in resolved profile', async () => {
    const task = makeTask({
      context: {
        ...makeTask().context,
        labels: ['agent:claude', 'status:needs-implementation', 'complexity:low'],
        escalatedEffort: 'high',
      },
    });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ effort: 'high', effortSource: 'escalation' });
  });

  test('implementation-result.json includes resolvedProfile on success', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'implementation-result.json'), 'utf8'));
    expect(result.resolvedProfile).toMatchObject({ phase: 'implementation', agentId: 'claude' });
  });

  test('implementation-result.json includes resolvedProfile on claude failure', async () => {
    await createImplementationHandler(CONTEXT(), fakeFail())(makeTask());
    const result = JSON.parse(readFileSync(join(dir(), 'implementation-result.json'), 'utf8'));
    expect(result.resolvedProfile).toMatchObject({ phase: 'implementation', agentId: 'claude' });
  });

  test('implementation-context.json records the persisted resolved assignment', async () => {
    const task = makeTask({
      context: {
        ...makeTask().context,
        assignment: {
          flow: 'docs',
          implementationAgent: 'claude',
          reviewAgent: 'codex',
          conflictResolutionAgent: 'claude',
          resolvedAt: '2026-06-17T00:00:00.000Z',
          source: 'session-config',
        },
      },
    });
    await createImplementationHandler(CONTEXT(), happyRunner())(task);
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.assignment).toMatchObject({
      flow: 'docs',
      implementationAgent: 'claude',
      reviewAgent: 'codex',
      conflictResolutionAgent: 'claude',
      source: 'session-config',
    });
  });

  test('implementation-context.json omits assignment when none is persisted', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    expect(ctx.assignment).toBeUndefined();
  });

  test('resolved profile argv does not contain prompt content', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const ctx = JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8'));
    const argv = ctx.resolvedProfile.argv;
    // argv should contain flags but not the prompt text (prompt goes via stdin)
    expect(argv).toContain('--model');
    expect(argv).toContain('--effort');
    expect(argv).toContain('--max-budget-usd');
    const argvStr = argv.join(' ');
    expect(argvStr).not.toContain('Implementation Task');
    expect(argvStr).not.toContain('Issue Description');
  });
});

// ---------------------------------------------------------------------------
// Contamination guard (issue #211)
//
// Regression coverage for the superseded PR #207 incident: issue #202 committed
// but failed at gh pr create, then issue #199's branch picked up #202's commit.
// ---------------------------------------------------------------------------

describe('implementation handler — contamination guard (issue #211)', () => {
  const QUARANTINE = () => join(artifactRoot, 'implementation-quarantine.json');

  // status, checkout base, pull, rev-parse(main), checkout -b, claude, diff,
  // verification, ls-files, add, commit, push, gh pr create (fails), then
  // cleanup status (clean) + checkout base.
  function commitThenPrCreateFails() {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },           // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'done', stderr: '', exitCode: 0 },
      { stdout: '1 file changed', stderr: '', exitCode: 0 },
      { stdout: 'PASS', stderr: '', exitCode: 0 },
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },               // add
      { stdout: '', stderr: '', exitCode: 0 },               // commit
      { stdout: '', stderr: '', exitCode: 0 },               // push
      { stdout: '', stderr: 'gh: rate limited', exitCode: 1 }, // gh pr create — fails
      { stdout: '', stderr: '', exitCode: 0 },               // cleanup status (clean)
      { stdout: '', stderr: '', exitCode: 0 },               // cleanup checkout base
    ]);
  }

  test('issue A late PR-create failure does not leak its commit into issue B branch base', async () => {
    // Run A: issue #202 commits, then gh pr create fails. Cleanup restores HEAD
    // to the base branch and does NOT quarantine (worktree was clean).
    const runnerA = commitThenPrCreateFails();
    const rA = await createImplementationHandler(CONTEXT(), runnerA)(makeTask({ issueNumber: 202 }));
    expect(rA.result).toBe('failed');
    expect(rA.error).toMatch(/gh: rate limited/);
    expect(rA.error).not.toMatch(/quarantined/);
    expect(existsSync(QUARANTINE())).toBe(false);
    const restoreCheckout = [...runnerA.calls].reverse().find((c) => c.cmd === 'git' && c.args[0] === 'checkout');
    expect(restoreCheckout).toMatchObject({ cmd: 'git', args: ['checkout', 'main'] });

    // Run B: issue #199 starts later. HEAD is verified to be at base and the new
    // branch is created explicitly from base — never from ai/issue-202.
    const runnerB = happyRunner();
    const rB = await createImplementationHandler(CONTEXT(), runnerB)(makeTask({ issueNumber: 199 }));
    expect(rB.result).toBe('success');
    const checkoutB = runnerB.calls.find((c) => c.cmd === 'git' && c.args.includes('-b'));
    expect(checkoutB.args).toEqual(['checkout', '-b', 'ai/issue-199', 'main']);
  });

  test('late failure that cannot be safely restored quarantines and blocks the next run', async () => {
    // Run A: commit fails leaving a dirty worktree, so cleanup cannot return to
    // the base branch and must quarantine.
    const runnerA = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                // status (clean)
      { stdout: '', stderr: '', exitCode: 0 },                // checkout base
      { stdout: '', stderr: '', exitCode: 0 },                // pull
      { stdout: 'main', stderr: '', exitCode: 0 },            // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },                // checkout -b
      { stdout: 'done', stderr: '', exitCode: 0 },            // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },  // diff
      { stdout: 'PASS', stderr: '', exitCode: 0 },            // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },    // ls-files
      { stdout: '', stderr: '', exitCode: 0 },                // add
      { stdout: '', stderr: 'commit failed', exitCode: 1 },   // commit fails
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },   // cleanup status — DIRTY
    ]);
    const rA = await createImplementationHandler(CONTEXT(), runnerA)(makeTask({ issueNumber: 202 }));
    expect(rA.result).toBe('failed');
    expect(rA.error).toMatch(/quarantined/);
    // The public-facing error must not embed the local artifact root path.
    expect(rA.error).not.toContain(artifactRoot);
    expect(existsSync(QUARANTINE())).toBe(true);

    // Run B: must fail closed in preflight because the quarantine marker exists.
    const runnerB = happyRunner();
    const rB = await createImplementationHandler(CONTEXT(), runnerB)(makeTask({ issueNumber: 199 }));
    expect(rB.result).toBe('failed');
    expect(rB.error).toMatch(/quarantined/);
    expect(rB.error).not.toContain(artifactRoot);
    // Refused before running any git command (not even the dirty check).
    expect(runnerB.calls).toHaveLength(0);
  });

  test('quarantine marker records diagnostic context without public artifact paths', async () => {
    const runnerA = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'done', stderr: '', exitCode: 0 },
      { stdout: '1 file changed', stderr: '', exitCode: 0 },
      { stdout: 'PASS', stderr: '', exitCode: 0 },
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },               // add
      { stdout: '', stderr: '', exitCode: 0 },               // commit
      { stdout: '', stderr: 'push rejected', exitCode: 1 },  // push fails
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },  // cleanup status — DIRTY
    ]);
    await createImplementationHandler(CONTEXT(), runnerA)(makeTask({ issueNumber: 202 }));
    const marker = JSON.parse(readFileSync(QUARANTINE(), 'utf8'));
    expect(marker).toMatchObject({ issueNumber: 202, branch: 'ai/issue-202', runId: 'run-impl-1' });
    expect(typeof marker.quarantinedAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Gemini/Antigravity implementation agent
// ---------------------------------------------------------------------------

// Gemini happy path: same orchestration order as Claude but using agy/ANTIGRAVITY_BIN.
// status(0) checkout-main(1) pull(2) rev-parse(3) checkout-b(4) agy(5) diff(6)
// verification(7) ls-files(8) add(9) commit(10) push(11) gh-pr-create(12)
function happyGeminiRunner(prUrl = 'https://github.com/m2dw/test-repo/pull/99') {
  return sequenceRunner([
    { stdout: '', stderr: '', exitCode: 0 },                                      // git status — clean
    { stdout: '', stderr: '', exitCode: 0 },                                      // git checkout main
    { stdout: '', stderr: '', exitCode: 0 },                                      // git pull --ff-only
    { stdout: 'main', stderr: '', exitCode: 0 },                                  // git rev-parse — HEAD at base
    { stdout: '', stderr: '', exitCode: 0 },                                      // git checkout -b
    { stdout: 'Implemented changes via Gemini.', stderr: '', exitCode: 0 },       // agy
    { stdout: '2 files changed', stderr: '', exitCode: 0 },                       // git diff --stat HEAD
    { stdout: 'PASS', stderr: '', exitCode: 0 },                                  // verification (npm test)
    { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },                          // git ls-files -z
    { stdout: '', stderr: '', exitCode: 0 },                                      // git add -- <paths>
    { stdout: '', stderr: '', exitCode: 0 },                                      // git commit
    { stdout: '', stderr: '', exitCode: 0 },                                      // git push
    { stdout: prUrl, stderr: '', exitCode: 0 },                                   // gh pr create
  ]);
}

// Fix mode with Gemini: same as happyFixRunner but agy at calls[7].
// status(0) checkout-main(1) pull-main(2) rev-parse(3) gh-pr-list(4)
// git-checkout-branch(5) git-pull-branch(6) agy(7) diff(8) verification(9)
// ls-files(10) add(11) commit(12) push(13)
function happyGeminiFixRunner() {
  return sequenceRunner([
    { stdout: '', stderr: '', exitCode: 0 },                                   // git status — clean
    { stdout: '', stderr: '', exitCode: 0 },                                   // git checkout main
    { stdout: '', stderr: '', exitCode: 0 },                                   // git pull --ff-only
    { stdout: 'main', stderr: '', exitCode: 0 },                               // rev-parse — HEAD at base
    { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },                         // gh pr list
    { stdout: '', stderr: '', exitCode: 0 },                                   // git checkout <branch>
    { stdout: '', stderr: '', exitCode: 0 },                                   // git pull origin <branch>
    { stdout: 'Applied review feedback via Gemini.', stderr: '', exitCode: 0 }, // agy
    { stdout: '1 file changed', stderr: '', exitCode: 0 },                    // git diff --stat HEAD
    { stdout: 'PASS', stderr: '', exitCode: 0 },                              // verification (npm test)
    { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },                      // git ls-files -z
    { stdout: '', stderr: '', exitCode: 0 },                                   // git add -- <paths>
    { stdout: '', stderr: '', exitCode: 0 },                                   // git commit
    { stdout: '', stderr: '', exitCode: 0 },                                   // git push
  ]);
}

function makeGeminiTask(overrides = {}) {
  return makeTask({
    implementationAgent: 'gemini',
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:gemini', 'status:needs-implementation'],
    },
    ...overrides,
  });
}

function makeGeminiFixTask(overrides = {}) {
  return makeGeminiTask({
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:gemini', 'status:needs-fix'],
      reviewFeedback: REVIEW_FEEDBACK,
    },
    ...overrides,
  });
}

describe('implementation handler — Gemini/Antigravity agent', () => {
  // agy is at calls[5] in the new-impl happy path (same index as claude)
  const AGY_IDX = 5;

  beforeEach(() => { delete process.env['ANTIGRAVITY_BIN']; });
  afterEach(() => { delete process.env['ANTIGRAVITY_BIN']; });

  test('new implementation with Gemini succeeds end-to-end', async () => {
    const runner = happyGeminiRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    expect(result.result).toBe('success');
    expect(result.context?.prUrl).toContain('pull/99');
    expect(result.context?.branch).toMatch(/77/);
  });

  test('uses ANTIGRAVITY_BIN env var when set', async () => {
    process.env['ANTIGRAVITY_BIN'] = '/opt/custom-agy';
    const runner = happyGeminiRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    expect(runner.calls[AGY_IDX].cmd).toBe('/opt/custom-agy');
  });

  test('falls back to "agy" when ANTIGRAVITY_BIN is not set', async () => {
    const runner = happyGeminiRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    expect(runner.calls[AGY_IDX].cmd).toBe('agy');
  });

  test('passes prompt as positional --print arg, matching research lane contract', async () => {
    const runner = happyGeminiRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    const agyCall = runner.calls[AGY_IDX];
    // Contract: agy --print "<prompt>", mirroring the research handler
    expect(agyCall.args[0]).toBe('--print');
    expect(agyCall.args[1]).toContain('Implementation Task');
    expect(agyCall.args[1]).toContain('77');
  });

  test('passes prompt via both --print arg and stdin', async () => {
    const runner = happyGeminiRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    const agyCall = runner.calls[AGY_IDX];
    expect(typeof agyCall.opts.stdin).toBe('string');
    expect(agyCall.opts.stdin).toContain('77');
    // Prompt appears as positional arg after --print (research lane contract)
    expect(agyCall.args).toEqual(['--print', agyCall.opts.stdin]);
  });

  test('uses session.repoRoot as cwd', async () => {
    const runner = happyGeminiRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    expect(runner.calls[AGY_IDX].opts.cwd).toBe(repoRoot);
  });

  test('fix mode with Gemini checks out existing branch and does not create a new PR', async () => {
    const runner = happyGeminiFixRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeGeminiFixTask());
    expect(result.result).toBe('success');
    expect(result.context?.prUrl).toBe(EXISTING_PR_URL);
    expect(result.context?.branch).toBe(EXISTING_BRANCH);
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args.includes('create'))).toBe(false);
  });

  test('fix mode prompt includes Review Feedback section', async () => {
    const runner = happyGeminiFixRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiFixTask());
    const agyCall = runner.calls[7]; // agy is at index 7 in fix mode
    expect(agyCall.opts.stdin).toContain('Review Feedback To Address');
    expect(agyCall.opts.stdin).toContain(REVIEW_FEEDBACK);
  });

  test('fails when Gemini exits non-zero', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                        // git status — clean
      { stdout: '', stderr: '', exitCode: 0 },                        // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                        // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                    // rev-parse — HEAD at base
      { stdout: '', stderr: '', exitCode: 0 },                        // git checkout -b
      { stdout: '', stderr: 'agy: auth error', exitCode: 1 },         // agy — fails
    ]);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/agy: auth error/);
  });

  test('implementation-context.json records Gemini resolvedProfile with cmdSource=env', async () => {
    process.env['ANTIGRAVITY_BIN'] = '/usr/local/bin/my-agy';
    const runner = happyGeminiRunner();
    try {
      await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    } finally {
      delete process.env['ANTIGRAVITY_BIN'];
    }
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({
      phase: 'implementation',
      agentId: 'gemini',
      cmd: '/usr/local/bin/my-agy',
      cmdSource: 'env',
      argv: ['--print'],
    });
  });

  test('cmdSource is cli-default when ANTIGRAVITY_BIN is not set', async () => {
    const runner = happyGeminiRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.cmdSource).toBe('cli-default');
    expect(ctx.resolvedProfile.cmd).toBe('agy');
  });

  test('resolved profile argv does not contain prompt content', async () => {
    const runner = happyGeminiRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile.argv).toEqual(['--print']);
    const argvStr = ctx.resolvedProfile.argv.join(' ');
    expect(argvStr).not.toContain('Implementation Task');
    expect(argvStr).not.toContain('77');
  });

  test('follows the same branch and commit orchestration order as Claude', async () => {
    const runner = happyGeminiRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    const calls = runner.calls;
    expect(calls[0]).toMatchObject({ cmd: 'git', args: ['status', '--porcelain'] });
    expect(calls[1]).toMatchObject({ cmd: 'git', args: ['checkout', 'main'] });
    expect(calls[4]).toMatchObject({ cmd: 'git', args: expect.arrayContaining(['checkout', '-b']) });
    expect(calls[AGY_IDX].cmd).toBe('agy');
    expect(calls[6]).toMatchObject({ cmd: 'git', args: ['diff', '--stat', 'HEAD'] });
    expect(calls[7]).toMatchObject({ cmd: 'npm', args: ['test'] });   // verification
    expect(calls[11]).toMatchObject({ cmd: 'git', args: expect.arrayContaining(['push']) });
    expect(calls[12].cmd).toBe('gh');                                  // gh pr create
  });

  test('implementation-context.json exists even on Gemini failure (pre-run audit)', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'agy: command not found', exitCode: 127 },
    ]);
    await createImplementationHandler(CONTEXT(), runner)(makeGeminiTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'))).toBe(true);
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'implementation', agentId: 'gemini' });
  });
});

// Codex implementation agent (issue #260)
// ---------------------------------------------------------------------------

describe('implementation handler — codex agent', () => {
  // Codex new-implementation sequence mirrors Claude's at the same indexes:
  // status(0) checkout-main(1) pull(2) rev-parse(3) checkout-b(4) codex(5)
  // diff(6) verification(7) ls-files(8) add(9) commit(10) push(11) gh-pr-create(12)
  const CODEX_AGENT_IDX = 5;

  function makeCodexTask(overrides = {}) {
    return makeTask({
      implementationAgent: 'codex',
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:codex', 'status:needs-implementation'],
      },
      ...overrides,
    });
  }

  function happyCodexRunner(prUrl = 'https://github.com/m2dw/test-repo/pull/99') {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git status (clean)
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                      // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                  // git rev-parse --abbrev-ref HEAD
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout -b <branch>
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // codex
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification (npm test)
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },         // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                      // git add -- <paths>
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: prUrl, stderr: '', exitCode: 0 },                   // gh pr create
    ]);
  }

  test('invokes "codex" command for codex agent', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    expect(runner.calls[CODEX_AGENT_IDX].cmd).toBe('codex');
  });

  test('passes prompt via stdin, not as positional argv', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    const codexCall = runner.calls[CODEX_AGENT_IDX];
    expect(typeof codexCall.opts.stdin).toBe('string');
    expect(codexCall.opts.stdin).toContain('77');
    expect(codexCall.args).not.toContain(codexCall.opts.stdin);
  });

  test('codex argv uses exec subcommand (not -q or --approval-mode)', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    const { args } = runner.calls[CODEX_AGENT_IDX];
    expect(args[0]).toBe('exec');
    expect(args).not.toContain('-q');
    expect(args).not.toContain('--approval-mode');
  });

  test('default effort (no complexity label) -> model_reasoning_effort=high', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    const { args } = runner.calls[CODEX_AGENT_IDX];
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe('model_reasoning_effort=high');
  });

  test('complexity:low label -> model_reasoning_effort=low', async () => {
    const runner = happyCodexRunner();
    const task = makeCodexTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:codex', 'status:needs-implementation', 'complexity:low'],
      },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CODEX_AGENT_IDX];
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe('model_reasoning_effort=low');
  });

  test('complexity:xhigh maps to model_reasoning_effort=high (Codex has no xhigh tier)', async () => {
    const runner = happyCodexRunner();
    const task = makeCodexTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:codex', 'status:needs-implementation', 'complexity:xhigh'],
      },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const { args } = runner.calls[CODEX_AGENT_IDX];
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe('model_reasoning_effort=high');
  });

  test('CODEX_EFFORT=low env var overrides label effort', async () => {
    process.env['CODEX_EFFORT'] = 'low';
    const runner = happyCodexRunner();
    try {
      await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    } finally {
      delete process.env['CODEX_EFFORT'];
    }
    const { args } = runner.calls[CODEX_AGENT_IDX];
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe('model_reasoning_effort=low');
  });

  test('CODEX_EFFORT env var overrides complexity label', async () => {
    process.env['CODEX_EFFORT'] = 'high';
    const runner = happyCodexRunner();
    const task = makeCodexTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:codex', 'status:needs-implementation', 'complexity:low'],
      },
    });
    try {
      await createImplementationHandler(CONTEXT(), runner)(task);
    } finally {
      delete process.env['CODEX_EFFORT'];
    }
    const { args } = runner.calls[CODEX_AGENT_IDX];
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe('model_reasoning_effort=high');
  });

  test('codex argv does not include --model, --max-budget-usd, or --allowedTools', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    const { args } = runner.calls[CODEX_AGENT_IDX];
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--max-budget-usd');
    expect(args).not.toContain('--allowedTools');
  });

  test('codex success returns success with prUrl and branch', async () => {
    const pr = 'https://github.com/m2dw/test-repo/pull/99';
    const r = await createImplementationHandler(CONTEXT(), happyCodexRunner(pr))(makeCodexTask());
    expect(r.result).toBe('success');
    expect(r.context?.prUrl).toBe(pr);
    expect(r.context?.branch).toMatch(/77/);
  });

  test('codex exit non-zero returns failed with agent output in error', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'codex: not authenticated', exitCode: 1 },
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/codex: not authenticated/);
  });

  test('missing codex CLI (exit 127) returns failed without dirty worktree', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'codex: command not found', exitCode: 127 },
    ]);
    const r = await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/127/);
    // No commit or push happened — tree was never dirtied past the agent step
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('commit'))).toBe(false);
  });

  test('implementation-context.json records codex resolvedProfile with cli-default model and n/a budget', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({
      phase: 'implementation',
      agentId: 'codex',
      cmd: 'codex',
      model: 'cli-default',
      modelSource: 'default',
      maxBudgetUsd: 'n/a',
      budgetSource: 'default',
    });
  });

  test('implementation-context.json records codex effort and effortSource', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ effort: 'high', effortSource: 'default' });
  });

  test('codex resolvedProfile argv does not contain prompt content', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    const argvStr = ctx.resolvedProfile.argv.join(' ');
    expect(argvStr).not.toContain('Implementation Task');
    expect(argvStr).not.toContain('Issue Description');
  });

  test('CODEX_EFFORT records effortSource=env in resolvedProfile', async () => {
    process.env['CODEX_EFFORT'] = 'low';
    const runner = happyCodexRunner();
    try {
      await createImplementationHandler(CONTEXT(), runner)(makeCodexTask());
    } finally {
      delete process.env['CODEX_EFFORT'];
    }
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ effort: 'low', effortSource: 'env' });
  });

  test('escalatedEffort records effortSource=escalation for codex', async () => {
    const runner = happyCodexRunner();
    const task = makeCodexTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:codex', 'status:needs-implementation', 'complexity:low'],
        escalatedEffort: 'high',
      },
    });
    await createImplementationHandler(CONTEXT(), runner)(task);
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ effort: 'high', effortSource: 'escalation' });
  });

  // Fix-mode sequence for codex:
  // status(0) checkout-main(1) pull(2) rev-parse(3) gh-pr-list(4)
  // git-checkout-branch(5) git-pull-branch(6) codex(7) diff(8)
  // verification(9) ls-files(10) add(11) commit(12) push(13)
  test('fix mode: codex checks out existing branch and does not create a new PR', async () => {
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'main', stderr: '', exitCode: 0 },
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'Applied review feedback.', stderr: '', exitCode: 0 },
      { stdout: '1 file changed', stderr: '', exitCode: 0 },
      { stdout: 'PASS', stderr: '', exitCode: 0 },
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
    ]);
    const fixTask = makeCodexTask({
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:codex', 'status:needs-fix'],
        reviewFeedback: REVIEW_FEEDBACK,
      },
    });
    const r = await createImplementationHandler(CONTEXT(), runner)(fixTask);
    expect(r.result).toBe('success');
    expect(r.context?.prUrl).toBe(EXISTING_PR_URL);
    expect(r.context?.branch).toBe(EXISTING_BRANCH);
    // codex ran, not claude
    const codexCall = runner.calls.find((c) => c.cmd === 'codex');
    expect(codexCall).toBeDefined();
    expect(codexCall.opts.stdin).toContain('Review Feedback To Address');
    // No new PR created
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args.includes('create'))).toBe(false);
  });

  test('unsupported agent error lists all supported implementation agents', async () => {
    const runner = happyRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask({ implementationAgent: 'gpt4' }));
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Unsupported implementation agent/);
    expect(result.error).toContain('claude, codex, gemini');
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool Request handoff (issue #291)
// ---------------------------------------------------------------------------

function toolRequestBlock(lines) {
  return [TOOL_REQUEST_OPEN, ...lines, TOOL_REQUEST_CLOSE].join('\n');
}

// new-impl sequence up to the agent, agent emits a Tool Request block (exit 0),
// then the handler cleans up: git checkout -f <base>, git clean -fd, git branch -D <branch>.
function toolRequestRunner(blockText) {
  return sequenceRunner([
    { stdout: '', stderr: '', exitCode: 0 },         // git status --porcelain (clean)
    { stdout: '', stderr: '', exitCode: 0 },         // git checkout main
    { stdout: '', stderr: '', exitCode: 0 },         // git pull --ff-only
    { stdout: 'main', stderr: '', exitCode: 0 },     // git rev-parse --abbrev-ref HEAD
    { stdout: '', stderr: '', exitCode: 0 },         // git checkout -b <branch>
    { stdout: blockText, stderr: '', exitCode: 0 },  // claude — emits Tool Request
    { stdout: '', stderr: '', exitCode: 0 },         // git add -A (capture partial diff, issue #379)
    { stdout: '', stderr: '', exitCode: 0 },         // git diff --cached --binary HEAD (no partial work)
    { stdout: '', stderr: '', exitCode: 0 },         // git checkout -f main (cleanup)
    { stdout: '', stderr: '', exitCode: 0 },         // git clean -fd (cleanup, removes untracked edits)
    { stdout: '', stderr: '', exitCode: 0 },         // git branch -D <branch> (cleanup)
  ]);
}

describe('implementation handler — tool request handoff', () => {
  const BLOCK = toolRequestBlock([
    'command: npm install left-pad',
    'reason: The fix depends on left-pad which is not a dependency yet.',
    'expected_files: package.json, package-lock.json',
    'suggested_action: dependencySync',
  ]);

  test('prompt instructs the agent how to emit a Tool Request block', async () => {
    await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain(TOOL_REQUEST_OPEN);
    expect(prompt).toContain('When You Need A Disallowed Command');
  });

  test('returns a tool_request result with structured metadata', async () => {
    const result = await createImplementationHandler(CONTEXT(), toolRequestRunner(BLOCK))(makeTask());
    expect(result.result).toBe('tool_request');
    expect(result.context.toolRequest).toMatchObject({
      command: 'npm install left-pad',
      displayCommand: 'npm install left-pad',
      reason: 'The fix depends on left-pad which is not a dependency yet.',
      expectedFiles: ['package.json', 'package-lock.json'],
      necessity: 'required',
      suggestedAction: 'dependencySync',
      requestedBy: 'claude',
      mode: 'new',
      resolved: false,
    });
    expect(typeof result.context.toolRequest.requestedAt).toBe('string');
  });

  test('clears dependencyBase on the handoff when no dependency start point applies (issue #316 review)', async () => {
    // Issue #316 review (P2): a no-dependency Tool Request handoff must write
    // dependencyBase EXPLICITLY as undefined, not omit it. Omitting it would let the
    // phase runner's context merge preserve a stale dependencyBase from an earlier
    // handoff, and runToolRequestGrant would then rebuild the issue branch from an
    // obsolete blocker head instead of the current base.
    const result = await createImplementationHandler(CONTEXT(), toolRequestRunner(BLOCK))(makeTask());
    expect(result.result).toBe('tool_request');
    // The key is present (so the merge overwrites/clears) and carries no start point.
    expect('dependencyBase' in result.context).toBe(true);
    expect(result.context.dependencyBase).toBeUndefined();
  });

  // Issue #477 review (P1): a Tool Request handoff during a FRESH initial
  // implementation (no PR exists yet) must NOT persist `context.branch`. The work
  // branch here is only the conventional `ai/issue-<n>`; recording it would make
  // `admin tool-request grant` treat it as a recorded PR head (`fromRecordedPr`)
  // and refuse to (re)create the branch when it is absent on origin — exactly the
  // normal fresh Tool Request path after branch cleanup / a no-diff handoff. The
  // grant falls back to `ai/issue-<n>` via resolveToolRequestWorkBranch regardless,
  // so the key must be omitted (contrast the non-conventional fix case at issue #459
  // review, which DOES persist the live PR head).
  test('does NOT persist context.branch for a fresh initial-implementation handoff (issue #477 review)', async () => {
    const result = await createImplementationHandler(CONTEXT(), toolRequestRunner(BLOCK))(makeTask());
    expect(result.result).toBe('tool_request');
    expect('branch' in result.context).toBe(false);
    expect(result.context.branch).toBeUndefined();
  });

  test('does NOT run the requested command, commit, push, or create a PR', async () => {
    const runner = toolRequestRunner(BLOCK);
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    // No npm install (the requested command) was ever run.
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
    // No commit / push / PR creation.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'gh' && c.args.includes('create'))).toBe(false);
  });

  test('restores the checkout to base and drops the issue branch', async () => {
    const runner = toolRequestRunner(BLOCK);
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args.includes('-f') && c.args.includes('main'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(true);
  });

  test('cleans untracked edits so the shared checkout returns to a safe base', async () => {
    const runner = toolRequestRunner(BLOCK);
    await createImplementationHandler(CONTEXT(), runner)(makeTask());
    // git clean removes untracked files git checkout -f leaves behind, which
    // would otherwise trip the next run's dirty-tree preflight.
    const cleanCall = runner.calls.find((c) => c.cmd === 'git' && c.args[0] === 'clean');
    expect(cleanCall).toBeDefined();
    expect(cleanCall.args).toEqual(expect.arrayContaining(['-fd']));
    // The artifact dir (untracked but holding this run's audit records) is excluded.
    if (cleanCall.args.includes('-e')) {
      const excluded = cleanCall.args[cleanCall.args.indexOf('-e') + 1];
      expect(excluded.startsWith('..')).toBe(false);
    }
  });

  test('records the tool request in implementation-result.json', async () => {
    await createImplementationHandler(CONTEXT(), toolRequestRunner(BLOCK))(makeTask());
    const raw = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8');
    const r = JSON.parse(raw);
    expect(r).toMatchObject({ success: false, step: 'tool-request' });
    expect(r.toolRequest.command).toBe('npm install left-pad');
  });

  test('a normal output without a Tool Request block is unaffected (happy path still succeeds)', async () => {
    const result = await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
    expect(result.result).toBe('success');
  });

  // Regression (issue #291): the agent may emit a valid Tool Request and STILL
  // exit nonzero (e.g. it treats the blocked/disallowed-command stop as an
  // unsuccessful run). The block must be detected BEFORE the nonzero-exit check,
  // so the run becomes a clean tool_request handoff rather than a generic failure.
  function toolRequestRunnerNonzero(stdout, stderr) {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },     // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },     // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },     // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 }, // git rev-parse --abbrev-ref HEAD
      { stdout: '', stderr: '', exitCode: 0 },     // git checkout -b <branch>
      { stdout, stderr, exitCode: 1 },             // claude — emits Tool Request but exits nonzero
      { stdout: '', stderr: '', exitCode: 0 },     // git add -A (capture partial diff, issue #379)
      { stdout: '', stderr: '', exitCode: 0 },     // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },     // git checkout -f main (cleanup)
      { stdout: '', stderr: '', exitCode: 0 },     // git clean -fd (cleanup)
      { stdout: '', stderr: '', exitCode: 0 },     // git branch -D <branch> (cleanup)
    ]);
  }

  test('a Tool Request emitted with a nonzero exit still becomes a handoff, not a failure', async () => {
    const runner = toolRequestRunnerNonzero(BLOCK, 'blocked: disallowed command');
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');
    expect(result.context.toolRequest).toMatchObject({
      command: 'npm install left-pad',
      resolved: false,
    });
    // The nonzero exit must NOT have been surfaced as a generic phase failure.
    expect(result.error).toBeUndefined();
    // The requested command is never run and nothing is committed/pushed.
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
  });

  test('a Tool Request on stderr (nonzero exit) is detected as a handoff', async () => {
    const runner = toolRequestRunnerNonzero('', BLOCK);
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');
    expect(result.context.toolRequest.command).toBe('npm install left-pad');
  });

  // Regression (issue #379): a new-implementation agent that produced real partial
  // work (new files, edits) before emitting a Tool Request must NOT have that work
  // silently discarded by the handoff cleanup. The cleanup still returns the
  // checkout to a safe base, but the partial diff is first captured into a patch
  // artifact so it is recoverable. Uses a real git checkout (with a bare origin so
  // the `git pull --ff-only` preflight succeeds) and intercepts only the agent
  // command — the agent writes a new file, then emits the Tool Request block.
  test('preserves the agent partial diff as a patch artifact instead of discarding it silently', async () => {
    mkdirSync(repoRoot, { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x"}\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    git('branch', '-M', 'main');
    const remotePath = join(tmpDir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', remotePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('remote', 'add', 'origin', remotePath);
    git('push', '-q', '-u', 'origin', 'main');

    // Hybrid runner: real git, but the agent step writes a partial implementation
    // file (src/psl.ts) and then emits the Tool Request block.
    const runner = {
      calls: [],
      run(cmd, args, opts) {
        this.calls.push({ cmd, args, opts });
        if (cmd === 'claude') {
          mkdirSync(join(repoRoot, 'src'), { recursive: true });
          writeFileSync(join(repoRoot, 'src', 'psl.ts'), 'export const PSL_MARKER = "partial-work";\n', 'utf8');
          return { stdout: BLOCK, stderr: '', exitCode: 0 };
        }
        try {
          const stdout = execFileSync(cmd, args, {
            cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            ...(opts.stdin !== undefined ? { input: opts.stdin } : {}),
          });
          return { stdout, stderr: '', exitCode: 0 };
        } catch (e) {
          return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? String(e), exitCode: e.status ?? 1 };
        }
      },
    };

    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');

    // The partial work is recorded on the stored request as a relative artifact
    // name (never an absolute path) and the patch file exists with the new file.
    expect(result.context.toolRequest.partialDiffArtifact).toBe('partial-implementation.patch');
    const patchPath = join(artifactRoot, 'runs', 'run-impl-1', 'partial-implementation.patch');
    expect(existsSync(patchPath)).toBe(true);
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toContain('src/psl.ts');
    expect(patch).toContain('PSL_MARKER');

    // The checkout is still returned to a safe base: the partial file is gone from
    // the worktree (so the next run starts clean) and the issue branch is dropped —
    // but the work is recoverable from the captured patch, not lost.
    expect(existsSync(join(repoRoot, 'src', 'psl.ts'))).toBe(false);
    const branches = execFileSync('git', ['branch', '--list', 'ai/issue-77'], { cwd: repoRoot, encoding: 'utf8' });
    expect(branches.trim()).toBe('');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    expect(status.trim()).toBe('');

    // The handoff never ran the requested command, committed, or pushed.
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Issue #390: when partial-diff capture FAILS (a diff may exist but cannot be
  // snapshotted) the handoff must NOT delete the new-impl issue branch — the only
  // continuation point once no patch was written and no PR exists. Instead it
  // commits the partial work onto the issue branch and keeps it (pushing
  // best-effort), recording the preservation on the stored request.
  // -------------------------------------------------------------------------

  // new-impl sequence where the partial-diff capture step (git diff --cached
  // --binary HEAD) fails, so the handler preserves the branch via commit (+push).
  function captureFailureRunner({ pushExitCode = 0 } = {}) {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },         // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },         // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },     // git rev-parse --abbrev-ref HEAD
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout -b <branch>
      { stdout: BLOCK, stderr: '', exitCode: 0 },      // claude — emits Tool Request
      { stdout: '', stderr: '', exitCode: 0 },         // git add -A (stages partial work)
      { stdout: '', stderr: 'fatal: simulated capture failure', exitCode: 128 }, // git diff --cached --binary HEAD (FAILS)
      { stdout: '', stderr: '', exitCode: 0 },         // git commit --no-verify (preserve partial work)
      { stdout: '', stderr: '', exitCode: pushExitCode }, // git push origin <branch>
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout -f main (restore worktree)
      { stdout: '', stderr: '', exitCode: 0 },         // git clean -fd
    ]);
  }

  test('capture failure preserves the issue branch (commit + push) instead of deleting it (issue #390)', async () => {
    const runner = captureFailureRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');

    // The branch is recorded as the preserved continuation point, pushed to origin.
    expect(result.context.toolRequest.preservedBranch).toBe('ai/issue-77');
    expect(result.context.toolRequest.preservedBranchPushed).toBe(true);
    // A capture-failure reason is recorded, and crucially NO patch is claimed and
    // the handler does NOT pretend there was no diff.
    expect(typeof result.context.toolRequest.partialDiffCaptureFailed).toBe('string');
    expect(result.context.toolRequest.partialDiffArtifact).toBeUndefined();
    expect(result.context.toolRequest.noPriorDiff).toBeUndefined();

    // The partial work is committed onto the issue branch and pushed; the branch is
    // never deleted (the regression #390 fixes).
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit' && c.args.includes('--no-verify'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push' && c.args.includes('ai/issue-77'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
    // The requested command is still never run.
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
  });

  test('capture failure with a failed push keeps the local branch and flags it unpushed (issue #390)', async () => {
    const runner = captureFailureRunner({ pushExitCode: 1 });
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');
    expect(result.context.toolRequest.preservedBranch).toBe('ai/issue-77');
    expect(result.context.toolRequest.preservedBranchPushed).toBe(false);
    // Still never deletes the branch — the local commit is the only continuation point.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
  });

  // new-impl sequence where BOTH the partial-diff capture AND the preservation
  // commit fail. The branch's state after the worktree restore is decided by the
  // `git rev-list --count <base>..<branch>` probe: `aheadStdout`/`aheadExitCode`
  // drive whether the handler proves the branch empty (delete) or keeps it.
  function commitFailureRunner({ aheadStdout = '0', aheadExitCode = 0, pushExitCode = 0 } = {}) {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },         // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },         // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },     // git rev-parse --abbrev-ref HEAD
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout -b <branch>
      { stdout: BLOCK, stderr: '', exitCode: 0 },      // claude — emits Tool Request
      { stdout: '', stderr: '', exitCode: 0 },         // git add -A (stages partial work)
      { stdout: '', stderr: 'fatal: simulated capture failure', exitCode: 128 }, // git diff --cached --binary HEAD (FAILS)
      { stdout: '', stderr: 'nothing to commit', exitCode: 1 }, // git commit --no-verify (FAILS)
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout -f main (restore worktree)
      { stdout: '', stderr: '', exitCode: 0 },         // git clean -fd
      { stdout: aheadStdout, stderr: '', exitCode: aheadExitCode }, // git rev-list --count main..<branch>
      { stdout: '', stderr: '', exitCode: pushExitCode }, // git branch -D OR git push origin <branch>
    ]);
  }

  test('capture+commit failure on an empty branch deletes it and does NOT advertise it as preserved (issue #390 review)', async () => {
    // The dangerous case the review flags: capture failed, the preservation commit
    // also failed (nothing was committed), and the worktree restore discarded the
    // index. The branch now only points at base, so it preserves nothing — it must
    // be dropped, never advertised as a continuation point.
    const runner = commitFailureRunner({ aheadStdout: '0' });
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');

    // No false continuation point: the empty branch is not advertised.
    expect(result.context.toolRequest.preservedBranch).toBeUndefined();
    expect(result.context.toolRequest.preservedBranchPushed).toBeUndefined();
    // But the capture failure is still recorded so admin guidance routes to the
    // reconstruct-from-artifacts recovery rather than claiming a patch exists.
    expect(typeof result.context.toolRequest.partialDiffCaptureFailed).toBe('string');
    expect(result.context.toolRequest.partialDiffArtifact).toBeUndefined();
    expect(result.context.toolRequest.noPriorDiff).toBeUndefined();

    // The empty branch is deleted, and it is NEVER pushed (pushing an empty ref
    // would let admin resolve falsely resume from it and lose the work).
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);
  });

  test('capture+commit failure keeps a branch that already carries committed work (issue #390 review)', async () => {
    // A resumed `ai/issue-<n>` already holds earlier commits. Even when this run's
    // capture and preservation commit both fail, that branch is a real continuation
    // point and must be kept + advertised (and pushed best-effort), never deleted.
    const runner = commitFailureRunner({ aheadStdout: '2' });
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');

    expect(result.context.toolRequest.preservedBranch).toBe('ai/issue-77');
    expect(result.context.toolRequest.preservedBranchPushed).toBe(true);
    expect(typeof result.context.toolRequest.partialDiffCaptureFailed).toBe('string');

    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push' && c.args.includes('ai/issue-77'))).toBe(true);
  });

  test('capture+commit failure with an unprovable branch state fails closed and keeps the branch (issue #390 review)', async () => {
    // If the `git rev-list` probe itself fails we cannot prove the branch is empty,
    // so the handler must NOT delete it — fail closed and keep the only potential
    // continuation point.
    const runner = commitFailureRunner({ aheadStdout: '', aheadExitCode: 1 });
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');

    expect(result.context.toolRequest.preservedBranch).toBe('ai/issue-77');
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
  });

  test('no implementation diff drops the branch and records noPriorDiff with no patch (issue #390)', async () => {
    // The #365-shaped case where the agent emitted its Tool Request without
    // producing any file changes: the empty-diff capture proves there is nothing
    // to preserve, so the branch is safely dropped — but the handoff records that
    // explicitly so operators are not told to look for a nonexistent patch.
    const runner = toolRequestRunner(BLOCK); // add=0, diff=0 (empty) → proven no diff
    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');
    expect(result.context.toolRequest.noPriorDiff).toBe(true);
    expect(result.context.toolRequest.partialDiffArtifact).toBeUndefined();
    expect(result.context.toolRequest.preservedBranch).toBeUndefined();
    expect(result.context.toolRequest.partialDiffCaptureFailed).toBeUndefined();
    // No diff means the branch is genuinely safe to drop.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
  });

  // Fix mode reaches the Tool Request handoff with an EXISTING PR branch already
  // checked out. When partial-diff capture fails there, the repair edits are
  // discarded with no patch written — the existing branch is kept regardless, so
  // there is no continuation point to protect, but the stored request must still
  // record WHY there is no patch (partialDiffCaptureFailed) rather than looking
  // like it simply had no diff (issue #390 review).
  function fixCaptureFailureRunner() {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },           // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },           // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },           // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },       // git rev-parse --abbrev-ref HEAD
      { stdout: PR_LIST_JSON, stderr: '', exitCode: 0 }, // gh pr list
      { stdout: '', stderr: '', exitCode: 0 },           // git checkout <existing branch>
      { stdout: '', stderr: '', exitCode: 0 },           // git pull origin <branch>
      { stdout: BLOCK, stderr: '', exitCode: 0 },        // claude — emits Tool Request
      { stdout: '', stderr: '', exitCode: 0 },           // git add -A (stages partial work)
      { stdout: '', stderr: 'fatal: simulated capture failure', exitCode: 128 }, // git diff --cached --binary HEAD (FAILS)
      { stdout: '', stderr: '', exitCode: 0 },           // git checkout -f main (restore worktree)
      { stdout: '', stderr: '', exitCode: 0 },           // git clean -fd
    ]);
  }

  test('fix mode capture failure records the failure reason (issue #390 review)', async () => {
    const runner = fixCaptureFailureRunner();
    const result = await createImplementationHandler(CONTEXT(), runner)(makeFixTask());
    expect(result.result).toBe('tool_request');
    expect(result.context.toolRequest.mode).toBe('fix');

    // The capture-failure reason is recorded so admin guidance does not point the
    // operator at a nonexistent patch; no patch is claimed and the handler does
    // NOT pretend there was no diff.
    expect(typeof result.context.toolRequest.partialDiffCaptureFailed).toBe('string');
    expect(result.context.toolRequest.partialDiffArtifact).toBeUndefined();
    expect(result.context.toolRequest.noPriorDiff).toBeUndefined();

    // Fix mode keeps the existing PR branch (its work is already there), so the
    // handler neither commits a preservation WIP nor deletes the branch.
    expect(result.context.toolRequest.preservedBranch).toBeUndefined();
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(false);
    // The requested command is still never run.
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
  });

  // End-to-end with a real git checkout: capture is forced to fail, and the real
  // commit + push to a bare origin proves the agent's partial work survives on the
  // issue branch (recoverable) rather than being discarded (issue #390).
  test('capture failure preserves the agent partial work on origin (real git, issue #390)', async () => {
    mkdirSync(repoRoot, { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x"}\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    git('branch', '-M', 'main');
    const remotePath = join(tmpDir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', remotePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('remote', 'add', 'origin', remotePath);
    git('push', '-q', '-u', 'origin', 'main');

    // Hybrid runner: real git, but the agent writes a partial file and the
    // partial-diff capture (git diff --cached --binary HEAD) is forced to fail.
    const runner = {
      calls: [],
      run(cmd, args, opts) {
        this.calls.push({ cmd, args, opts });
        if (cmd === 'claude') {
          mkdirSync(join(repoRoot, 'src'), { recursive: true });
          writeFileSync(join(repoRoot, 'src', 'psl.ts'), 'export const PSL_MARKER = "partial-work";\n', 'utf8');
          return { stdout: BLOCK, stderr: '', exitCode: 0 };
        }
        if (cmd === 'git' && args[0] === 'diff' && args.includes('--cached') && args.includes('--binary')) {
          return { stdout: '', stderr: 'fatal: simulated capture failure', exitCode: 128 };
        }
        try {
          const stdout = execFileSync(cmd, args, {
            cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            ...(opts.stdin !== undefined ? { input: opts.stdin } : {}),
          });
          return { stdout, stderr: '', exitCode: 0 };
        } catch (e) {
          return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? String(e), exitCode: e.status ?? 1 };
        }
      },
    };

    const result = await createImplementationHandler(CONTEXT(), runner)(makeTask());
    expect(result.result).toBe('tool_request');
    expect(result.context.toolRequest.preservedBranch).toBe('ai/issue-77');
    expect(result.context.toolRequest.preservedBranchPushed).toBe(true);

    // The issue branch exists on origin and its tip contains the partial work — the
    // continuation point is real, not discarded.
    const lsRemote = execFileSync('git', ['ls-remote', '--heads', 'origin', 'ai/issue-77'], { cwd: repoRoot, encoding: 'utf8' });
    expect(lsRemote).toContain('refs/heads/ai/issue-77');
    const showFile = execFileSync('git', ['show', 'ai/issue-77:src/psl.ts'], { cwd: repoRoot, encoding: 'utf8' });
    expect(showFile).toContain('PSL_MARKER');

    // The shared checkout is returned to a clean base, and the command was never run.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    expect(status.trim()).toBe('');
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('install'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trusted dependency-update routing (issue #302)
//
// A dependency-install Tool Request (e.g. `npm install left-pad@^1.3.0`) is
// routed through the trusted dependency-sync path when the session configures
// dependencySync: the handler edits the manifest as data and runs the session
// sync command, then continues to commit — instead of a repeated generic handoff.
// ---------------------------------------------------------------------------
describe('implementation handler — dependency-update routing (issue #302)', () => {
  const DEP_SYNC = {
    enabled: true,
    triggerPaths: ['package.json'],
    expectedOutputs: ['package-lock.json'],
    command: 'npm install --package-lock-only --ignore-scripts',
    timeoutMs: 120000,
  };
  const depSession = (overrides = {}) => SESSION({ dependencySync: DEP_SYNC, ...overrides });
  const depContext = (overrides = {}) => CONTEXT({ session: depSession(), ...overrides });

  const DEP_BLOCK = toolRequestBlock([
    'command: npm install left-pad@^1.3.0',
    'reason: The fix imports left-pad which is not a dependency yet.',
    'expected_files: package.json, package-lock.json',
    'suggested_action: dependencySync',
  ]);

  function writeRepoManifest(manifest) {
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }
  function readRepoManifest() {
    return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  }

  // new-impl preflight → claude emits dep-install request → dep-sync (status,
  // npm, status) → diff → verification → ls-files → add → commit → push → gh pr.
  function depUpdateSuccessRunner(prUrl = 'https://github.com/m2dw/test-repo/pull/99') {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                          // git status (clean)
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                                          // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                                      // git rev-parse HEAD
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout -b
      { stdout: DEP_BLOCK, stderr: '', exitCode: 0 },                                   // claude — dep-install request
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                         // dep-sync git status (before)
      { stdout: 'updated lockfile', stderr: '', exitCode: 0 },                          // npm install --package-lock-only
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },   // dep-sync git status (after)
      { stdout: '2 files changed', stderr: '', exitCode: 0 },                           // git diff --stat HEAD
      { stdout: 'PASS', stderr: '', exitCode: 0 },                                      // verification npm test
      { stdout: 'package.json\0package-lock.json\0', stderr: '', exitCode: 0 },         // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                          // git add
      { stdout: '', stderr: '', exitCode: 0 },                                          // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                          // git push
      { stdout: prUrl, stderr: '', exitCode: 0 },                                       // gh pr create
    ]);
  }

  test('prompt tells the agent to edit the manifest when dependencySync is enabled', async () => {
    writeRepoManifest({ name: 'p' });
    await createImplementationHandler(depContext(), happyRunner())(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('Adding Or Updating A Dependency');
    expect(prompt).toContain('package.json');
  });

  test('prompt does NOT add the dependency section when dependencySync is absent', async () => {
    const prompt0 = await (async () => {
      await createImplementationHandler(CONTEXT(), happyRunner())(makeTask());
      return readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8');
    })();
    expect(prompt0).not.toContain('Adding Or Updating A Dependency');
  });

  // Extracts just the "Adding Or Updating A Dependency" section so assertions
  // don't pick up the generic disallowed-command section (which legitimately
  // mentions `npm install <pkg>` as an ecosystem-neutral placeholder example).
  function depSection(prompt) {
    const start = prompt.indexOf('## Adding Or Updating A Dependency');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = prompt.slice(start + 1);
    const end = rest.indexOf('\n## ');
    return end >= 0 ? prompt.slice(start, start + 1 + end) : prompt.slice(start);
  }

  test('dependency section uses ecosystem-specific examples for a non-npm (Cargo) sync session', async () => {
    const cargoSync = { ...DEP_SYNC, triggerPaths: ['Cargo.toml'], expectedOutputs: ['Cargo.lock'] };
    const ctx = CONTEXT({ session: depSession({ dependencySync: cargoSync }) });
    await createImplementationHandler(ctx, happyRunner())(makeTask());
    const section = depSection(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8'));
    expect(section).toContain('Cargo.toml');
    expect(section).toContain('cargo add');
    // npm/package.json guidance must not leak into a Cargo session.
    expect(section).not.toContain('npm install');
    expect(section).not.toContain('package.json');
  });

  test('dependency section falls back to ecosystem-neutral guidance for an unrecognized manifest', async () => {
    const customSync = { ...DEP_SYNC, triggerPaths: ['deps.yaml'], expectedOutputs: ['deps.lock'] };
    const ctx = CONTEXT({ session: depSession({ dependencySync: customSync }) });
    await createImplementationHandler(ctx, happyRunner())(makeTask());
    const section = depSection(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8'));
    expect(section).toContain('deps.yaml');
    expect(section).not.toContain('npm install');
    expect(section).not.toContain('left-pad');
  });

  // Only npm install requests are auto-applied by the trusted path (issue #302
  // review): the prompt must not advertise auto-apply for ecosystems whose install
  // requests actually fall back to a human handoff.
  test('npm dependency section promises auto-apply for the install Tool Request', async () => {
    writeRepoManifest({ name: 'p' });
    await createImplementationHandler(depContext(), happyRunner())(makeTask());
    const section = depSection(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8'));
    expect(section).toContain('the workflow will apply it for you');
    expect(section).not.toContain('human reviewer');
  });

  test('non-npm dependency section does NOT promise auto-apply (Cargo handoff)', async () => {
    const cargoSync = { ...DEP_SYNC, triggerPaths: ['Cargo.toml'], expectedOutputs: ['Cargo.lock'] };
    const ctx = CONTEXT({ session: depSession({ dependencySync: cargoSync }) });
    await createImplementationHandler(ctx, happyRunner())(makeTask());
    const section = depSection(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8'));
    expect(section).not.toContain('the workflow will apply it for you');
    expect(section).toContain('a human reviewer will pick it up and apply it');
  });

  test('unrecognized-manifest dependency section does NOT promise auto-apply', async () => {
    const customSync = { ...DEP_SYNC, triggerPaths: ['deps.yaml'], expectedOutputs: ['deps.lock'] };
    const ctx = CONTEXT({ session: depSession({ dependencySync: customSync }) });
    await createImplementationHandler(ctx, happyRunner())(makeTask());
    const section = depSection(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-prompt.md'), 'utf8'));
    expect(section).not.toContain('the workflow will apply it for you');
    expect(section).toContain('a human reviewer will pick it up and apply it');
  });

  test('applies the requested update via the session sync command and succeeds', async () => {
    writeRepoManifest({ name: 'p', dependencies: { existing: '^1.0.0' } });
    const runner = depUpdateSuccessRunner();
    const result = await createImplementationHandler(depContext(), runner)(makeTask());

    expect(result.result).toBe('success');
    expect(result.context.dependencyUpdate).toMatchObject({
      manager: 'npm',
      manifestPath: 'package.json',
      packages: [{ name: 'left-pad', version: '^1.3.0', section: 'dependencies' }],
    });
    expect(result.context.dependencySync).toMatchObject({ ran: true, passed: true });
    // The manifest reflects the requested update (durable result).
    expect(readRepoManifest().dependencies['left-pad']).toBe('^1.3.0');
  });

  test('runs the EXACT session command, never the agent install, and commits', async () => {
    writeRepoManifest({ name: 'p' });
    const runner = depUpdateSuccessRunner();
    await createImplementationHandler(depContext(), runner)(makeTask());

    // The agent's `npm install left-pad@^1.3.0` is never executed; the only npm
    // install that runs is the session's lockfile-only command (the other npm call
    // is the `npm test` verification).
    const npmInstalls = runner.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'install');
    expect(npmInstalls).toHaveLength(1);
    expect(npmInstalls[0].args).toEqual(['install', '--package-lock-only', '--ignore-scripts']);
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('left-pad@^1.3.0'))).toBe(false);
    // It is a real implementation, not a handoff: it commits and pushes.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(true);
  });

  test('records the applied update in implementation-result.json', async () => {
    writeRepoManifest({ name: 'p' });
    await createImplementationHandler(depContext(), depUpdateSuccessRunner())(makeTask());
    const r = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8'));
    expect(r).toMatchObject({ success: true });
    expect(r.dependencyUpdate.packages[0]).toMatchObject({ name: 'left-pad', version: '^1.3.0' });
  });

  // new-impl preflight → claude emits request → unchanged (no sync) → handoff cleanup.
  function depUpdateUnchangedRunner() {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },         // git status (clean)
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },         // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },     // git rev-parse HEAD
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout -b
      { stdout: DEP_BLOCK, stderr: '', exitCode: 0 },  // claude — dep-install request (already satisfied)
      { stdout: '', stderr: '', exitCode: 0 },         // git add -A (capture partial diff, issue #379)
      { stdout: '', stderr: '', exitCode: 0 },         // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout -f main (cleanup)
      { stdout: '', stderr: '', exitCode: 0 },         // git clean -fd (cleanup)
      { stdout: '', stderr: '', exitCode: 0 },         // git branch -D (cleanup)
    ]);
  }

  test('hands off (without looping) when the dependency is already satisfied', async () => {
    writeRepoManifest({ name: 'p', dependencies: { 'left-pad': '^1.3.0' } });
    const runner = depUpdateUnchangedRunner();
    const result = await createImplementationHandler(depContext(), runner)(makeTask());

    expect(result.result).toBe('tool_request');
    expect(result.context.dependencyUpdate.failure.kind).toBe('unchanged');
    expect(result.context.toolRequest.command).toBe('npm install left-pad@^1.3.0');
    // No sync command and nothing committed: the already-satisfied state is surfaced.
    expect(runner.calls.some((c) => c.cmd === 'npm')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    // The result records the dependency-update step for the operator.
    const r = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8'));
    expect(r.step).toBe('dependency-update');
  });

  // A re-processed dependency handoff must carry the same duplicate-suppression
  // signal the generic handoff uses (issue #302 review): otherwise outbox-effects
  // would re-post the dependency comment every run instead of suppressing it.
  test('a repeated dependency handoff is flagged unresolved-duplicate', async () => {
    writeRepoManifest({ name: 'p', dependencies: { 'left-pad': '^1.3.0' } });
    const task = makeTask({
      context: {
        ...makeTask().context,
        toolRequest: { command: 'npm install left-pad@^1.3.0', resolved: false },
      },
    });
    const result = await createImplementationHandler(depContext(), depUpdateUnchangedRunner())(task);

    expect(result.result).toBe('tool_request');
    expect(result.context.dependencyUpdate.failure.kind).toBe('unchanged');
    expect(result.context.toolRequestRepeatKind).toBe('unresolved-duplicate');
  });

  test('a manual-done dependency handoff repeat is flagged resolved-duplicate', async () => {
    writeRepoManifest({ name: 'p', dependencies: { 'left-pad': '^1.3.0' } });
    const task = makeTask({
      context: {
        ...makeTask().context,
        toolRequest: {
          command: 'npm install left-pad@^1.3.0',
          resolved: true,
          resolution: { action: 'manual-done' },
        },
      },
    });
    const result = await createImplementationHandler(depContext(), depUpdateUnchangedRunner())(task);

    expect(result.result).toBe('tool_request');
    expect(result.context.toolRequestRepeatKind).toBe('resolved-duplicate');
  });

  test('a versionless install request falls back to the generic Tool Request handoff', async () => {
    writeRepoManifest({ name: 'p' });
    const block = toolRequestBlock([
      'command: npm install left-pad',
      'reason: needs left-pad',
      'suggested_action: dependencySync',
    ]);
    // Generic handoff cleanup is identical to toolRequestRunner.
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },         // git status (clean)
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },         // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },     // git rev-parse HEAD
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout -b
      { stdout: block, stderr: '', exitCode: 0 },      // claude — versionless request
      { stdout: '', stderr: '', exitCode: 0 },         // git add -A (capture partial diff, issue #379)
      { stdout: '', stderr: '', exitCode: 0 },         // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },         // git checkout -f main (cleanup)
      { stdout: '', stderr: '', exitCode: 0 },         // git clean -fd (cleanup)
      { stdout: '', stderr: '', exitCode: 0 },         // git branch -D (cleanup)
    ]);
    const result = await createImplementationHandler(depContext(), runner)(makeTask());
    expect(result.result).toBe('tool_request');
    // No dependency-update metadata — it followed the generic path.
    expect(result.context.dependencyUpdate).toBeUndefined();
    expect(result.context.toolRequest.command).toBe('npm install left-pad');
    const r = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-impl-1', 'implementation-result.json'), 'utf8'));
    expect(r.step).toBe('tool-request');
  });

  // new-impl preflight → claude emits request → manifest edit + sync fails → handoff.
  function depUpdateSyncFailRunner() {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                       // git status (clean)
      { stdout: '', stderr: '', exitCode: 0 },                                       // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                                       // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                                   // git rev-parse HEAD
      { stdout: '', stderr: '', exitCode: 0 },                                       // git checkout -b
      { stdout: DEP_BLOCK, stderr: '', exitCode: 0 },                                // claude — dep-install request
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                      // dep-sync git status (before)
      { stdout: '', stderr: 'npm ERR! 404 Not Found', exitCode: 1 },                 // npm install — fails
      { stdout: '', stderr: '', exitCode: 0 },                                       // git add -A (capture partial diff, issue #379)
      { stdout: '', stderr: '', exitCode: 0 },                                       // git diff --cached --binary HEAD (no partial work)
      { stdout: '', stderr: '', exitCode: 0 },                                       // git checkout -f main (cleanup)
      { stdout: '', stderr: '', exitCode: 0 },                                       // git clean -fd (cleanup)
      { stdout: '', stderr: '', exitCode: 0 },                                       // git branch -D (cleanup)
    ]);
  }

  test('hands off with a sync-failed reason when the session command fails', async () => {
    writeRepoManifest({ name: 'p' });
    const runner = depUpdateSyncFailRunner();
    const result = await createImplementationHandler(depContext(), runner)(makeTask());

    expect(result.result).toBe('tool_request');
    expect(result.context.dependencyUpdate.failure.kind).toBe('sync-failed');
    expect(result.context.dependencyUpdate.failure.message).toContain('404 Not Found');
    // Nothing committed; the branch is cleaned up.
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args.includes('-D'))).toBe(true);
  });

  // A verification-repair agent emits a dep-install request and exits NONZERO to
  // signal the blocked command. The trusted path applies the manifest+lockfile and
  // the run must continue to re-verification — not fail on the nonzero exit.
  test('satisfies a repair-agent dependency request that exits nonzero, then commits', async () => {
    writeRepoManifest({ name: 'p' });
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                          // git status (clean)
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                                          // git pull --ff-only
      { stdout: 'main', stderr: '', exitCode: 0 },                                      // git rev-parse HEAD
      { stdout: '', stderr: '', exitCode: 0 },                                          // git checkout -b
      { stdout: 'edited source', stderr: '', exitCode: 0 },                             // claude (initial) — no dep request
      { stdout: ' M src/foo.ts', stderr: '', exitCode: 0 },                             // git diff --stat HEAD
      { stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 },                           // dep-sync status (initial, no trigger → no-op)
      { stdout: 'FAIL: cannot find module left-pad', stderr: '', exitCode: 1 },         // verification — fails
      // Repair agent emits the dep-install request and exits NONZERO.
      { stdout: DEP_BLOCK, stderr: 'blocked: disallowed command', exitCode: 1 },        // repair claude
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                         // trusted dep-sync status (before)
      { stdout: 'updated lockfile', stderr: '', exitCode: 0 },                          // npm install --package-lock-only
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },   // trusted dep-sync status (after)
      { stdout: 'PASS', stderr: '', exitCode: 0 },                                      // verification — passes
      { stdout: 'package.json\0package-lock.json\0src/foo.ts\0', stderr: '', exitCode: 0 }, // git ls-files -z
      { stdout: '', stderr: '', exitCode: 0 },                                          // git add
      { stdout: '', stderr: '', exitCode: 0 },                                          // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                          // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/12', stderr: '', exitCode: 0 }, // gh pr create
    ]);
    const result = await createImplementationHandler(depContext(), runner)(makeTask());

    // The nonzero repair exit was the agent signaling the blocked command, not a
    // failure: the dependency was applied and the run continued to a successful PR.
    expect(result.result).toBe('success');
    expect(result.context.dependencyUpdate).toMatchObject({ manager: 'npm', manifestPath: 'package.json' });
    expect(readRepoManifest().dependencies['left-pad']).toBe('^1.3.0');
    // The trusted sync ran exactly once (reused for the re-verification, not re-run);
    // the agent's own `npm install left-pad@^1.3.0` was never executed.
    const npmInstalls = runner.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'install');
    expect(npmInstalls).toHaveLength(1);
    expect(runner.calls.some((c) => c.cmd === 'npm' && c.args.includes('left-pad@^1.3.0'))).toBe(false);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(true);
    expect(runner.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gitea work-item provider auth (issue #382)
//
// A `gitea-issues` session authenticates the work-item provider by api-token,
// which the GitHub `resolveGhRunner` rejects. The implementation handler must NOT
// resolve a GitHub work-item runner for such a session — otherwise every Gitea
// implementation task fails immediately at auth resolution before it can start.
// Dependency relationships are read through the injected (Gitea-aware) depChecker
// instead, and the repo host stays GitHub.
// ---------------------------------------------------------------------------

describe('implementation handler — gitea-issues work-item auth', () => {
  const giteaSession = () =>
    SESSION({
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { baseUrl: 'https://gitea.example.com', owner: 'ai-private', repo: 'work-items' },
      },
      repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    });

  test('starts implementation instead of failing on api-token auth resolution', async () => {
    const noBlockers = { getBlockedBy: async () => [] };
    const runner = happyRunner();
    const r = await createImplementationHandler(
      CONTEXT({ session: giteaSession() }),
      runner,
      noBlockers,
    )(makeTask());

    // The task ran to completion: it was never short-circuited at GitHub auth.
    expect(r.result).toBe('success');
    // The agent actually executed — proof the task started rather than failing
    // before any git/agent step.
    expect(runner.calls.some((c) => c.cmd === 'claude')).toBe(true);
    // No GitHub work-item runner was resolved for the api-token auth.
    expect(JSON.stringify(r)).not.toMatch(/api-token|Failed to resolve GitHub provider auth/);
  });

  test('an open native Gitea blocker fails closed as blocked without resolving a GitHub work-item runner', async () => {
    // gh pr list (repo-host PR lookup) returns no PR for the blocker → blocked.
    const noPrRunner = sequenceRunner([{ stdout: '[]', stderr: '', exitCode: 0 }]);
    const openBlocker = { getBlockedBy: async () => [{ issueNumber: 99, state: 'open' }] };
    const r = await createImplementationHandler(
      CONTEXT({ session: giteaSession() }),
      noPrRunner,
      openBlocker,
    )(makeTask());

    expect(r.result).toBe('blocked');
    // Failing closed, not throwing on the api-token work-item auth mode.
    expect(JSON.stringify(r)).not.toMatch(/api-token|Failed to resolve GitHub provider auth/);
    // No git preflight ran: the dependency gate short-circuited before it.
    expect(noPrRunner.calls.some((c) => c.cmd === 'git')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex context-mode (issue #376)
// ---------------------------------------------------------------------------

describe('implementation handler — codex context-mode', () => {
  const CODEX_IDX = 5; // status checkout pull rev-parse checkout-b codex(5)
  const dir = () => join(artifactRoot, 'runs', 'run-impl-1');

  function codexSession(overrides = {}) {
    return SESSION({ defaults: { implementationAgent: 'codex', reviewAgent: 'codex' }, ...overrides });
  }

  function makeCodexTask() {
    return makeTask({
      implementationAgent: 'codex',
      context: {
        title: 'Add login rate limiting',
        url: 'https://github.com/m2dw/test-repo/issues/77',
        labels: ['agent:codex', 'status:needs-implementation'],
      },
    });
  }

  function happyCodexRunner() {
    return sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                      // git status
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout main
      { stdout: '', stderr: '', exitCode: 0 },                      // git pull
      { stdout: 'main', stderr: '', exitCode: 0 },                  // git rev-parse
      { stdout: '', stderr: '', exitCode: 0 },                      // git checkout -b
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // codex
      { stdout: '2 files changed', stderr: '', exitCode: 0 },       // git diff --stat
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // verification
      { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 },          // git ls-files
      { stdout: '', stderr: '', exitCode: 0 },                      // git add
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }, // gh pr create
    ]);
  }

  function readProfile() {
    return JSON.parse(readFileSync(join(dir(), 'implementation-context.json'), 'utf8')).resolvedProfile;
  }

  test('no codex config: argv has only model_reasoning_effort, metadata records unset', async () => {
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT({ session: codexSession() }), runner)(makeCodexTask());
    const { args } = runner.calls[CODEX_IDX];
    expect(args).not.toContain('--profile');
    expect(args).not.toContain('context_mode=on');
    expect(readProfile()).toMatchObject({
      agentId: 'codex',
      provider: 'openai',
      contextMode: 'unset',
      contextModeSource: 'default',
    });
  });

  test('enabled with config override: codex exec receives -c context_mode=on', async () => {
    const session = codexSession({ codex: { contextMode: { enabled: true, config: ['context_mode=on'] } } });
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT({ session }), runner)(makeCodexTask());
    const { args } = runner.calls[CODEX_IDX];
    expect(args).toContain('context_mode=on');
    // The pre-existing effort override is preserved alongside context-mode.
    expect(args).toContain('model_reasoning_effort=high');
    expect(readProfile()).toMatchObject({
      contextMode: 'enabled',
      contextModeSource: 'session',
      contextModeConfig: ['context_mode=on'],
    });
  });

  test('enabled with profile: codex exec receives --profile', async () => {
    const session = codexSession({ codex: { contextMode: { enabled: true, profile: 'ctx', config: ['context_mode=on'] } } });
    const runner = happyCodexRunner();
    await createImplementationHandler(CONTEXT({ session }), runner)(makeCodexTask());
    const { args } = runner.calls[CODEX_IDX];
    const pIdx = args.indexOf('--profile');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(args[pIdx + 1]).toBe('ctx');
    expect(readProfile().contextModeConfig).toEqual(['profile=ctx', 'context_mode=on']);
  });

  test('invalid config override fails before running codex', async () => {
    const session = codexSession({ codex: { contextMode: { enabled: true, config: ['bogus'] } } });
    const runner = happyCodexRunner();
    const r = await createImplementationHandler(CONTEXT({ session }), runner)(makeCodexTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/context-mode config override/i);
    expect(runner.calls.find(c => c.cmd === 'codex')).toBeUndefined();
  });

  test('enabled with no invocation form fails with a clear error', async () => {
    const session = codexSession({ codex: { contextMode: { enabled: true } } });
    const runner = happyCodexRunner();
    const r = await createImplementationHandler(CONTEXT({ session }), runner)(makeCodexTask());
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/no invocation form is configured/i);
    expect(runner.calls.find(c => c.cmd === 'codex')).toBeUndefined();
  });

  test('CODEX_CONTEXT_MODE=on with no configured form fails clearly', async () => {
    process.env['CODEX_CONTEXT_MODE'] = 'on';
    const runner = happyCodexRunner();
    let r;
    try {
      r = await createImplementationHandler(CONTEXT({ session: codexSession() }), runner)(makeCodexTask());
    } finally {
      delete process.env['CODEX_CONTEXT_MODE'];
    }
    expect(r.result).toBe('failed');
    expect(r.error).toMatch(/no invocation form is configured/i);
  });

  test('claude implementation is unaffected by codex context-mode config', async () => {
    const session = SESSION({ codex: { contextMode: { enabled: true, config: ['context_mode=on'] } } });
    const runner = happyRunner();
    await createImplementationHandler(CONTEXT({ session }), runner)(makeTask());
    const claudeCall = runner.calls[5];
    expect(claudeCall.cmd).toBe('claude');
    expect(claudeCall.args).not.toContain('context_mode=on');
    expect(readProfile()).toMatchObject({ agentId: 'claude', provider: 'anthropic', contextMode: 'n/a' });
  });
});

// ---------------------------------------------------------------------------
// environmentPrepare baseline exclusion (issue #511)
//
// Files materialised by the prepare command before the agent runs (e.g.
// vendor/, node_modules/ in repos without matching .gitignore entries) must
// not be counted as agent-produced changes in the no-diff check (Step 5) or
// committed as implementation output in the staging list (Step 6).
// ---------------------------------------------------------------------------
describe('implementation handler — environmentPrepare baseline exclusion (issue #511)', () => {
  const worktreePath = () => join(tmpDir, 'wt', 'addon-dev', 'issue-77', 'repo');
  const PREPARE_SESSION = (extra = {}) =>
    SESSION({
      worktrees: { enabled: true },
      environmentPrepare: { enabled: true, command: 'echo ok' },
      ...extra,
    });

  test('prepare-created untracked files are excluded from the no-diff check so a no-op agent is still a failure', async () => {
    // Scenario: `echo ok` creates vendor/foo.go (not gitignored). The agent
    // produces no diff. Without the baseline exclusion, hasUntracked would
    // see vendor/foo.go and report the agent as having produced changes.
    // With the fix, vendor/foo.go is in the baseline → excluded → failure.
    const wt = worktreePath();
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                   // git fetch origin +main:... (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                   // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                   // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                   // echo ok (prepare)
      { stdout: 'vendor/foo.go\0', stderr: '', exitCode: 0 },    // git ls-files --others -z (baseline — prepare created vendor/foo.go)
      { stdout: '', stderr: '', exitCode: 0 },                   // claude (no changes)
      { stdout: '', stderr: '', exitCode: 0 },                   // git diff --stat HEAD (no diff)
      { stdout: 'vendor/foo.go', stderr: '', exitCode: 0 },      // git ls-files --others (untracked check — vendor/foo.go still untracked)
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const result = await createImplementationHandler(
      CONTEXT({ session: PREPARE_SESSION() }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/no file changes/);
  });

  test('prepare-created files are not staged in the implementation commit', async () => {
    // Scenario: `echo ok` creates vendor/foo.go (not gitignored). The agent
    // edits src/feature.ts. git ls-files reports both paths as stageable.
    // Without the baseline exclusion, vendor/foo.go would be passed to
    // `git add` and committed. With the fix it is excluded.
    const wt = worktreePath();
    // Create the worktree .git dir so the prepare sentinel can be written;
    // this makes the second ensureEnvironmentPrepared call (after dep sync)
    // see a valid sentinel and skip — no extra prepare runner call needed.
    mkdirSync(join(wt, '.git'), { recursive: true });

    const prUrl = 'https://github.com/m2dw/test-repo/pull/99';
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },                                      // git fetch origin +main:... (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                                      // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                                      // git status --porcelain (clean)
      { stdout: '', stderr: '', exitCode: 0 },                                      // echo ok (prepare)
      { stdout: 'vendor/foo.go\0', stderr: '', exitCode: 0 },                       // git ls-files --others -z (baseline — prepare created vendor/foo.go)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },                  // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },                        // git diff --stat HEAD (has diff — skip untracked check)
      // dep sync: no dependencySync configured → no-op, no runner call
      // second ensureEnvironmentPrepared: stamp + sentinel valid → skips, no runner call
      { stdout: 'PASS', stderr: '', exitCode: 0 },                                  // npm test (verification)
      { stdout: 'src/feature.ts\0vendor/foo.go\0', stderr: '', exitCode: 0 },       // git ls-files -z (stageable — baseline filters vendor/foo.go)
      { stdout: '', stderr: '', exitCode: 0 },                                      // git add -- src/feature.ts
      { stdout: '', stderr: '', exitCode: 0 },                                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                                      // git push
      { stdout: prUrl, stderr: '', exitCode: 0 },                                   // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                                      // git worktree remove (canonical)
    ]);
    const resolver = fakeWorktreeResolver(wt);
    const result = await createImplementationHandler(
      CONTEXT({ session: PREPARE_SESSION() }), runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    const addCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall.args).toContain('src/feature.ts');
    expect(addCall.args).not.toContain('vendor/foo.go');
  });

  // issue #522: post-sync prepare baseline refresh
  //
  // When dep sync regenerates a lockfile listed in cacheKeyFiles, the post-sync
  // ensureEnvironmentPrepared call sees a new hash and re-runs prepare, which may
  // materialise additional untracked files (e.g. vendor/new.go). The baseline must
  // be refreshed at that point so those runner-created files are excluded from the
  // stageable-paths filter and are never committed as agent output.

  test('post-sync prepare baseline refresh excludes newly materialized files from staging', async () => {
    const wt = worktreePath();
    // Create .git dir and pre-write the lockfile so the initial prepare computes a
    // stable hash (H1). The dep sync step will overwrite it with new content (H2),
    // triggering a re-run of prepare whose new files are then excluded via refresh.
    mkdirSync(join(wt, '.git'), { recursive: true });
    writeFileSync(join(wt, 'package-lock.json'), 'v1-lock');

    const prUrl = 'https://github.com/m2dw/test-repo/pull/99';

    // Runner with side-effect support: the dep sync step writes new lockfile content
    // so that the post-sync ensureEnvironmentPrepared call sees a different hash.
    const steps = [
      { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin +main:... (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (preflight)
      { stdout: '', stderr: '', exitCode: 0 },                      // echo ok (initial prepare — H1, writes stamp+sentinel)
      { stdout: 'vendor/old.go\0', stderr: '', exitCode: 0 },       // git ls-files --others -z (initial baseline)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude
      { stdout: '1 file changed', stderr: '', exitCode: 0 },        // git diff --stat HEAD
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },     // git status (dep sync changedBefore — package.json changed)
      {
        stdout: '', stderr: '', exitCode: 0,
        // Side effect: overwrite lockfile so next cacheKeyFilesHash differs from H1,
        // causing ensureEnvironmentPrepared to re-run the prepare command.
        _sideEffect: () => writeFileSync(join(wt, 'package-lock.json'), 'v2-lock'),
      },                                                             // npm install --package-lock-only --ignore-scripts (dep sync)
      { stdout: ' M package-lock.json\n', stderr: '', exitCode: 0 }, // git status (dep sync changedAfter)
      { stdout: '', stderr: '', exitCode: 0 },                      // echo ok (post-sync prepare — H2, re-runs)
      { stdout: 'vendor/old.go\0vendor/new.go\0', stderr: '', exitCode: 0 }, // git ls-files --others -z (baseline refresh)
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // npm test (verification)
      { stdout: 'src/feature.ts\0package.json\0package-lock.json\0vendor/old.go\0vendor/new.go\0', stderr: '', exitCode: 0 }, // git ls-files -z (stageable)
      { stdout: '', stderr: '', exitCode: 0 },                      // git add -- src/feature.ts package.json package-lock.json
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: prUrl, stderr: '', exitCode: 0 },                   // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                      // git worktree remove
    ];
    let stepIdx = 0;
    const calls = [];
    const runner = {
      calls,
      run(cmd, args, opts) {
        const step = steps[stepIdx] ?? { stdout: '', stderr: 'unexpected call', exitCode: 1 };
        calls.push({ cmd, args, opts, result: step });
        if (step._sideEffect) step._sideEffect();
        stepIdx++;
        return { stdout: step.stdout, stderr: step.stderr, exitCode: step.exitCode };
      },
    };

    const resolver = fakeWorktreeResolver(wt);
    const result = await createImplementationHandler(
      CONTEXT({ session: PREPARE_SESSION({
        environmentPrepare: { enabled: true, command: 'echo ok', cacheKeyFiles: ['package-lock.json'] },
        dependencySync: {
          enabled: true,
          command: 'npm install --package-lock-only --ignore-scripts',
          triggerPaths: ['package.json'],
          expectedOutputs: ['package-lock.json'],
        },
      }) }),
      runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    const addCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall.args).toContain('src/feature.ts');
    // Vendor files materialised by the post-sync prepare must be excluded from the
    // commit even though they appear in git ls-files output.
    expect(addCall.args).not.toContain('vendor/old.go');
    expect(addCall.args).not.toContain('vendor/new.go');
    // Two prepare calls: one before the agent (H1) and one after dep sync (H2).
    const prepareCalls = runner.calls.filter(c => c.cmd === 'echo' && c.args[0] === 'ok');
    expect(prepareCalls).toHaveLength(2);
  });

  // issue #522: repair-loop prepare baseline refresh
  //
  // When the verification repair loop triggers a re-prepare (because the repair
  // agent or repair dep sync changed a cacheKeyFiles entry), the baseline must be
  // refreshed so newly materialised prepare files are excluded from the final commit.

  test('repair-loop prepare baseline refresh excludes newly materialized files from staging', async () => {
    const wt = worktreePath();
    mkdirSync(join(wt, '.git'), { recursive: true });
    writeFileSync(join(wt, 'package-lock.json'), 'v1-lock');

    const prUrl = 'https://github.com/m2dw/test-repo/pull/99';

    // The repair agent step writes new lockfile content as a side effect, causing
    // the unconditional post-repair ensureEnvironmentPrepared call to re-run prepare.
    const steps = [
      { stdout: '', stderr: '', exitCode: 0 },                      // git fetch origin +main:... (canonical)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (canonical — CLEAN)
      { stdout: '', stderr: '', exitCode: 0 },                      // git status --porcelain (preflight)
      { stdout: '', stderr: '', exitCode: 0 },                      // echo ok (initial prepare — H1)
      { stdout: 'vendor/old.go\0', stderr: '', exitCode: 0 },       // git ls-files --others -z (initial baseline)
      { stdout: 'Implemented changes.', stderr: '', exitCode: 0 },  // claude (implementation)
      { stdout: '1 file changed', stderr: '', exitCode: 0 },        // git diff --stat HEAD
      // No dep sync configured — no changedPaths or sync runner calls.
      // Post-sync ensureEnvironmentPrepared: H1 unchanged → skips (stamp+sentinel valid).
      { stdout: '', stderr: '', exitCode: 1 },                      // npm test (verification 1 — FAILS)
      // Repair loop (repair=0):
      {
        stdout: 'Repaired.', stderr: '', exitCode: 0,
        // Repair agent overwrites lockfile → H2, invalidating the existing stamp.
        _sideEffect: () => writeFileSync(join(wt, 'package-lock.json'), 'v2-lock'),
      },                                                             // claude (repair)
      // No dep sync in repair loop (not configured).
      { stdout: '', stderr: '', exitCode: 0 },                      // echo ok (repair prepare — H2, re-runs)
      { stdout: 'vendor/old.go\0vendor/new.go\0', stderr: '', exitCode: 0 }, // git ls-files --others -z (repair baseline refresh)
      { stdout: 'PASS', stderr: '', exitCode: 0 },                  // npm test (verification 2 — passes)
      { stdout: 'src/feature.ts\0vendor/old.go\0vendor/new.go\0', stderr: '', exitCode: 0 }, // git ls-files -z (stageable)
      { stdout: '', stderr: '', exitCode: 0 },                      // git add -- src/feature.ts
      { stdout: '', stderr: '', exitCode: 0 },                      // git commit
      { stdout: '', stderr: '', exitCode: 0 },                      // git push
      { stdout: prUrl, stderr: '', exitCode: 0 },                   // gh pr create
      { stdout: '', stderr: '', exitCode: 0 },                      // git worktree remove
    ];
    let stepIdx = 0;
    const calls = [];
    const runner = {
      calls,
      run(cmd, args, opts) {
        const step = steps[stepIdx] ?? { stdout: '', stderr: 'unexpected call', exitCode: 1 };
        calls.push({ cmd, args, opts, result: step });
        if (step._sideEffect) step._sideEffect();
        stepIdx++;
        return { stdout: step.stdout, stderr: step.stderr, exitCode: step.exitCode };
      },
    };

    const resolver = fakeWorktreeResolver(wt);
    const result = await createImplementationHandler(
      CONTEXT({ session: PREPARE_SESSION({
        environmentPrepare: { enabled: true, command: 'echo ok', cacheKeyFiles: ['package-lock.json'] },
      }) }),
      runner, undefined, resolver.resolve,
    )(makeTask());

    expect(result.result).toBe('success');
    const addCall = runner.calls.find(c => c.cmd === 'git' && c.args[0] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall.args).toContain('src/feature.ts');
    // vendor/new.go was materialised by the repair prepare and must be excluded
    // from the commit; vendor/old.go was in the initial baseline and must also be excluded.
    expect(addCall.args).not.toContain('vendor/old.go');
    expect(addCall.args).not.toContain('vendor/new.go');
    // Two actual prepare runner calls: initial (H1) and repair (H2).
    // The post-sync prepare check skips (sentinel+stamp still valid for H1 before repair).
    const prepareCalls = runner.calls.filter(c => c.cmd === 'echo' && c.args[0] === 'ok');
    expect(prepareCalls).toHaveLength(2);
  });
});
