import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createResearchHandler } from '../dist/handlers/research.js';
import {
  EVIDENCE_REQUEST_MARKER,
  EVIDENCE_REQUEST_END_MARKER,
} from '../dist/core/research-evidence-protocol.js';

// ---------------------------------------------------------------------------
// Fixtures — mirrors test/research-handler.test.js, plus a real git repository
// for the evidence-enabled integration cases (contract §14.1/§14.4).
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let artifactRoot;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function initGitRepo() {
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  mkdirSync(join(repoRoot, 'docs'), { recursive: true });
  writeFileSync(join(repoRoot, 'docs', 'evidence.json'), JSON.stringify({ finding: 'committed-json-evidence', count: 3 }, null, 2) + '\n');
  writeFileSync(join(repoRoot, 'notes.md'), '# Notes\n\nThe permission denial classifier lives in core.\n');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
}

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

const EVIDENCE_SESSION = (evidence = { enabled: true }) =>
  SESSION({ research: { evidence } });

const CONTEXT = (session) => ({
  session,
  runId: 'run-evidence-1',
  workerId: 'worker-test',
});

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
      title: 'Analyze committed evidence',
      url: 'https://github.com/m2dw/test-repo/issues/42',
      labels: ['agent:gemini', 'status:research-needed'],
    },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function requestBlock(queries) {
  return [EVIDENCE_REQUEST_MARKER, JSON.stringify({ queries }), EVIDENCE_REQUEST_END_MARKER].join('\n');
}

/** Scripted runner: returns the queued results in order, recording each call. */
function scriptedRunner(outputs) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) {
      const i = calls.length;
      calls.push({ cmd, args: [...args], opts: { cwd: opts.cwd, stdin: opts.stdin } });
      const out = outputs[Math.min(i, outputs.length - 1)];
      return typeof out === 'function' ? out(opts) : out;
    },
  };
}

const artifactDirPath = () => join(artifactRoot, 'runs', 'run-evidence-1');

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'research-evidence-handler-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Evidence disabled (default): byte-identical behaviour (§12.2, cases 47/47a/57d)
// ---------------------------------------------------------------------------

describe('evidence disabled (default)', () => {
  test('exactly one invocation with the prompt as positional argument plus stdin, no evidence artifacts', async () => {
    const runner = scriptedRunner([{ stdout: 'Findings.', stderr: '', exitCode: 0 }]);
    const handler = createResearchHandler(CONTEXT(SESSION()), runner);
    const result = await handler(makeTask({ context: { title: 'T', body: 'Some issue body' } }));
    expect(result.result).toBe('success');
    expect(runner.calls).toHaveLength(1);
    // Argv keeps today's shape: flags plus the positional prompt operand.
    expect(runner.calls[0].args[0]).toBe('--print');
    expect(runner.calls[0].args[runner.calls[0].args.length - 1]).toContain('# Research Task');
    // The disabled run writes no evidence artifact of any kind (§2, case 47a).
    expect(existsSync(join(artifactDirPath(), 'research-issue-body.md'))).toBe(false);
    expect(existsSync(join(artifactDirPath(), 'research-evidence-manifest.json'))).toBe(false);
    expect(existsSync(join(artifactDirPath(), 'research-prompt-turn-0.md'))).toBe(false);
    const resultJson = JSON.parse(readFileSync(join(artifactDirPath(), 'research-result.json'), 'utf8'));
    expect(resultJson.evidence).toBeUndefined();
    expect(result.context.evidenceEnabled).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Evidence enabled: headless Gemini integration fixture (acceptance criterion)
// ---------------------------------------------------------------------------

describe('evidence enabled', () => {
  test('a headless run can enumerate and analyze committed JSON and Markdown evidence and return non-empty findings', async () => {
    initGitRepo();
    const runner = scriptedRunner([
      {
        stdout: 'Investigating.\n' + requestBlock([
          { id: 'q1', op: 'list' },
          { id: 'q2', op: 'read', path: 'docs/evidence.json' },
          { id: 'q3', op: 'read', path: 'notes.md' },
          { id: 'q4', op: 'search', pattern: 'permission denial' },
        ]),
        stderr: '', exitCode: 0,
      },
      {
        stdout: '## Findings\n\nThe committed evidence file records committed-json-evidence with count 3.\n',
        stderr: '', exitCode: 0,
      },
    ]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION()), runner);
    const result = await handler(makeTask());

    expect(result.result).toBe('success');
    expect(result.context.outcome).toBe('valid');
    expect(result.context.evidenceEnabled).toBe(true);
    // §10.1: the excerpt is omitted whenever evidence is enabled.
    expect(result.context.researchOutput).toBeUndefined();
    expect(runner.calls).toHaveLength(2);

    // §6.3.1 (case 57a): stdin-only delivery — argv is exactly the profile
    // flags, with no positional prompt operand, on every turn.
    for (const call of runner.calls) {
      expect(call.args).toEqual(['--print']);
      expect(call.args.join(' ').length).toBeLessThan(1024);
      expect(call.opts.stdin).toContain('# Research Task');
    }
    // No permission-widening flag anywhere (case 60, §8.7).
    const flat = runner.calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('--dangerously-skip-permissions');
    expect(flat).not.toContain('--allowed-tools');

    // Turn 2's prompt carries the served evidence: the agent could actually
    // analyze the committed JSON and Markdown content.
    const secondStdin = runner.calls[1].opts.stdin;
    expect(secondStdin).toContain('## Repository Evidence (turn 1 of 4)');
    expect(secondStdin).toContain('committed-json-evidence');
    expect(secondStdin).toContain('permission denial classifier');
    expect(secondStdin).toContain('docs/evidence.json');

    // Artifacts (§9): manifest, turn record, per-invocation captures.
    const dir = artifactDirPath();
    expect(existsSync(join(dir, 'research-prompt-turn-0.md'))).toBe(true);
    expect(existsSync(join(dir, 'research-prompt-turn-1.md'))).toBe(true);
    expect(existsSync(join(dir, 'research-turn-0-output.md'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, 'research-evidence-manifest.json'), 'utf8'));
    expect(manifest.enabled).toBe(true);
    expect(manifest.transport).toBe('antigravity-stdout-marker');
    expect(manifest.promptDelivery).toBe('stdin');
    expect(manifest.scope).toBe('tracked-worktree');
    expect(manifest.turns).toBe(1);
    expect(manifest.invocations).toBe(2);
    expect(manifest.queries.read).toBe(2);
    expect(manifest.queries.list).toBe(1);
    expect(manifest.queries.search).toBe(1);
    // Structured metadata carries no absolute filesystem path (§9, case 59).
    const turnRecord = readFileSync(join(dir, 'research-evidence-turn-1.json'), 'utf8');
    expect(turnRecord).not.toContain(repoRoot);
    expect(turnRecord).not.toContain(tmpDir);
    expect(JSON.stringify(manifest)).not.toContain(tmpDir);

    // research-result.json gains the bounded evidence block (§9).
    const resultJson = JSON.parse(readFileSync(join(dir, 'research-result.json'), 'utf8'));
    expect(resultJson.evidence).toMatchObject({
      enabled: true,
      transport: 'antigravity-stdout-marker',
      turns: 1,
      invocations: 2,
      budgetExhausted: false,
      manifest: 'research-evidence-manifest.json',
    });
    // The final capture holds the findings (fed from the last invocation).
    expect(readFileSync(join(dir, 'research-output.md'), 'utf8')).toContain('## Findings');
  });

  test('an invalid operator glob refuses the run at enable time, before any invocation (§4.6/§4.7)', async () => {
    initGitRepo();
    const runner = scriptedRunner([{ stdout: 'never reached', stderr: '', exitCode: 0 }]);
    for (const [field, expectedRule] of [['denyGlobs', 'glob-trailing-slash'], ['generatedGlobs', 'glob-absolute']]) {
      const glob = field === 'denyGlobs' ? 'confidential/**/' : '/abs/**';
      const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION({ enabled: true, [field]: ['src/**', glob] })), runner);
      const result = await handler(makeTask());
      expect(result.result).toBe('failed');
      expect(result.error).toBe(`Research cannot run: session.research.evidence.${field}[1] is not a valid evidence glob (${expectedRule})`);
      // Fixed-form and content-free: the glob text itself is never echoed.
      expect(result.error).not.toContain('confidential');
      expect(result.error).not.toContain('/abs');
    }
    expect(runner.calls).toHaveLength(0);
  });

  test('with evidence disabled an invalid denyGlobs entry does not change behaviour (§12.2)', async () => {
    const runner = scriptedRunner([{ stdout: 'Findings.', stderr: '', exitCode: 0 }]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION({ enabled: false, denyGlobs: ['bad/**/'] })), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(runner.calls).toHaveLength(1);
  });

  test('agent that never asks: one invocation, zero turns recorded (case 49)', async () => {
    initGitRepo();
    const runner = scriptedRunner([{ stdout: 'Direct findings.', stderr: '', exitCode: 0 }]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION()), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(runner.calls).toHaveLength(1);
    const resultJson = JSON.parse(readFileSync(join(artifactDirPath(), 'research-result.json'), 'utf8'));
    expect(resultJson.evidence.turns).toBe(0);
    expect(resultJson.evidence.invocations).toBe(1);
  });

  test('soft-denied reads inside the evidence channel produce structured denials, and the run still succeeds', async () => {
    initGitRepo();
    writeFileSync(join(repoRoot, '.env'), 'SECRET=x\n');
    git(['add', '-f', '.env'], repoRoot);
    git(['commit', '-q', '-m', 'add env'], repoRoot);
    const runner = scriptedRunner([
      {
        stdout: requestBlock([
          { id: 'q1', op: 'read', path: '.env' },
          { id: 'q2', op: 'read', path: '../outside.txt' },
          { id: 'q3', op: 'read', path: '/etc/passwd' },
        ]),
        stderr: '', exitCode: 0,
      },
      { stdout: 'Findings: the sensitive file could not be read, as expected.', stderr: '', exitCode: 0 },
    ]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION()), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    const manifest = JSON.parse(readFileSync(join(artifactDirPath(), 'research-evidence-manifest.json'), 'utf8'));
    expect(manifest.denials['denied-sensitive']).toBe(1);
    expect(manifest.denials['outside-root']).toBe(1);
    expect(manifest.denials['absolute-path']).toBe(1);
    // The served response tells the agent WHAT was denied (its own id/reason),
    // and the turn record stores rejected values only as length+sha256 (§9.1).
    const turnRecord = readFileSync(join(artifactDirPath(), 'research-evidence-turn-1.json'), 'utf8');
    expect(turnRecord).not.toContain('/etc/passwd');
    expect(turnRecord).not.toContain('SECRET');
    expect(runner.calls[1].opts.stdin).toContain('denied-sensitive');
    expect(runner.calls[1].opts.stdin).not.toContain('SECRET=x');
  });

  test('budget exhaustion with no findings fails with the fixed evidence outcome (case 51)', async () => {
    initGitRepo();
    const asking = () => ({
      stdout: requestBlock([{ id: 'q1', op: 'list' }]),
      stderr: '', exitCode: 0,
    });
    const runner = scriptedRunner([asking()]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION({ enabled: true, maxTurns: 1 })), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.context.outcome).toBe('evidence/budget-exhausted');
    // 1 evidence turn allowed -> turn 0 + 1 re-invocation, then stop.
    expect(runner.calls).toHaveLength(2);
    // §10: fixed-form public error — outcome and counts only, no repository
    // detail, no local path.
    expect(result.error).toContain('evidence/budget-exhausted');
    expect(result.error).not.toContain(tmpDir);
    expect(result.error).not.toContain('q1');
  });

  test('findings alongside a spent budget are accepted as valid (case 50)', async () => {
    initGitRepo();
    const withFindings = {
      stdout: 'Partial findings so far.\n' + requestBlock([{ id: 'q1', op: 'list' }]),
      stderr: '', exitCode: 0,
    };
    const runner = scriptedRunner([withFindings, withFindings]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION({ enabled: true, maxTurns: 1 })), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(result.context.outcome).toBe('valid');
    const resultJson = JSON.parse(readFileSync(join(artifactDirPath(), 'research-result.json'), 'utf8'));
    expect(resultJson.evidence.budgetExhausted).toBe(true);
  });

  test('two consecutive malformed request blocks with no findings end the run as evidence/protocol-error (case 41)', async () => {
    initGitRepo();
    const malformed = {
      stdout: [EVIDENCE_REQUEST_MARKER, '{oops', EVIDENCE_REQUEST_END_MARKER].join('\n'),
      stderr: '', exitCode: 0,
    };
    const runner = scriptedRunner([malformed, malformed]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION()), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.context.outcome).toBe('evidence/protocol-error');
    expect(runner.calls).toHaveLength(2);
    // The single correction (§6.3) stated the expected form on turn 2's prompt.
    expect(runner.calls[1].opts.stdin).toContain('invalid-query');
  });

  test('snapshot failure (not a git repository) is evidence/unavailable with a content-free error (case 52)', async () => {
    // repoRoot exists but holds no git repository -> `git ls-files` fails.
    const runner = scriptedRunner([
      { stdout: requestBlock([{ id: 'q1', op: 'list' }]), stderr: '', exitCode: 0 },
    ]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION()), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.context.outcome).toBe('evidence/unavailable');
    expect(result.error).toContain('evidence/unavailable');
    expect(result.error).not.toContain(tmpDir);
    expect(result.error).not.toContain(repoRoot);
  });

  test('non-zero exit on a turn short-circuits to command-failure with the withheld fixed-form error (case 53, §10.1)', async () => {
    initGitRepo();
    const runner = scriptedRunner([
      { stdout: '', stderr: 'agy exploded at /secret/local/path', exitCode: 3 },
    ]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION()), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('failed');
    expect(result.context.outcome).toBe('command-failure');
    expect(runner.calls).toHaveLength(1);
    // No stderr interpolation on an evidence-enabled run, even with no body.
    expect(result.error).not.toContain('/secret/local/path');
    expect(result.error).toContain('Output withheld');
  });

  test('oversized issue body is persisted verbatim and pageable through the issue-body source (case 62)', async () => {
    initGitRepo();
    const body = 'line one\n' + 'body content line\n'.repeat(5_000);
    const runner = scriptedRunner([
      { stdout: requestBlock([{ id: 'q1', op: 'read', source: 'issue-body', startLine: 1, endLine: 1 }]), stderr: '', exitCode: 0 },
      { stdout: 'Findings from the body.', stderr: '', exitCode: 0 },
    ]);
    const handler = createResearchHandler(CONTEXT(EVIDENCE_SESSION()), runner);
    const result = await handler(makeTask({ context: { title: 'T', body } }));
    expect(result.result).toBe('success');
    const bodyArtifact = readFileSync(join(artifactDirPath(), 'research-issue-body.md'), 'utf8');
    expect(bodyArtifact).toBe(body); // verbatim, unbounded (§2)
    // The served window came from the artifact, labelled as such.
    expect(runner.calls[1].opts.stdin).toContain('"contentSource":"artifact"');
    expect(runner.calls[1].opts.stdin).toContain('line one');
  });
});
