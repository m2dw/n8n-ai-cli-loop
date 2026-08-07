/**
 * Research-handler integration for the bounded Antigravity workspace settings
 * (issue #826, corrected by #830; docs/antigravity-workspace-settings.md §1,
 * §2.5, §8, §10).
 *
 * The fixture is a constrained stand-in for `agy`: it consults the permission
 * rules the way the installed CLI does — from the GLOBAL settings store, which
 * is the layer #830 established as the effective one — and auto-denies anything
 * they do not allow. That reproduces the `permission-denied/read` failure when
 * no profile is installed, and shows the same run succeeding once one is,
 * without granting anything beyond read-only access inside the resolved
 * workspace.
 *
 * A stand-in is not evidence that the real CLI honours the profile; that is
 * what the opt-in test/antigravity-cli-smoke.test.js exists for (§11.1).
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createResearchHandler as createResearchHandlerImpl } from '../dist/handlers/research.js';
import {
  EVIDENCE_REQUEST_MARKER,
  EVIDENCE_REQUEST_END_MARKER,
} from '../dist/core/research-evidence-protocol.js';
import { AntigravityWorkspaceSettingsError } from '../dist/core/antigravity-workspace-settings.js';
import { prepareAntigravityWorkspaceSettings } from '../dist/handlers/antigravity-workspace.js';
import { stubResearchWorktree } from './helpers/research-worktree-stub.js';

/**
 * The fixture seam for the installed-CLI version gate (§6.3).
 *
 * There is no environment override any more (issue #830 review): a stale
 * `ANTIGRAVITY_CLI_VERSION` would have kept answering the gate for a binary
 * nobody probed. Tests inject the answer instead, and that injection is also
 * what tells preparation this run launches no CLI — which is what lets it use
 * the temporary global store below rather than the operator's real one.
 */
const withProbedVersion = (prepare) => (input) =>
  prepare({ ...input, probeCliVersion: () => '1.1.9' });

/**
 * `createResearchHandler` with the fixture version probe threaded in, and the
 * issue #855 worktree seams stubbed: preparation hands back the fixture
 * `repoRoot` as the research workspace root, so the profile these tests inspect
 * is generated against the same real git repository they set up.
 */
function createResearchHandler(context, runner, evidenceRuntime, prepareWorkspace, verifyWorkspace, releaseWorkspace) {
  const stub = stubResearchWorktree();
  return createResearchHandlerImpl(
    context,
    runner,
    evidenceRuntime,
    withProbedVersion(prepareWorkspace ?? prepareAntigravityWorkspaceSettings),
    verifyWorkspace,
    releaseWorkspace,
    { runtime: stub.runtime, issueLock: stub.issueLock },
  );
}

const WORKSPACE_ARTIFACT = 'research-workspace-settings.json';
const RUN_ID = 'run-workspace-1';

let tmpDir;
let repoRoot;
let realRoot;
let artifactRoot;
let globalSettingsPath;
/** The operator's store exactly as the run found it. */
let globalSettingsBefore;

function git(args, cwd = repoRoot) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function initRepo() {
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'evidence.ts'), 'export const finding = "committed-evidence";\n');
  writeFileSync(join(repoRoot, 'README.md'), '# fixture repository\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
}

const SESSION = (workspaceSettings, evidence) => ({
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
  research: {
    ...(workspaceSettings ? { antigravity: { workspaceSettings: { globalSettingsPath, ...workspaceSettings } } } : {}),
    ...(evidence ? { evidence } : {}),
  },
});

const CONTEXT = (session) => ({ session, runId: RUN_ID, workerId: 'worker-test' });

const makeTask = () => ({
  sessionId: 'addon-dev',
  issueNumber: 449,
  status: 'running',
  phase: 'research',
  priority: 'normal',
  researchAgent: 'gemini',
  attempts: {},
  context: { title: 'Investigate the committed evidence', labels: ['agent:gemini'] },
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
});

const artifactPath = (name) => join(artifactRoot, 'runs', RUN_ID, name);
const readArtifact = (name) => JSON.parse(readFileSync(artifactPath(name), 'utf8'));
const settingsPath = () => join(repoRoot, '.gemini', 'settings.json');

// ---------------------------------------------------------------------------
// A permission oracle over the emitted profile: deny wins, and anything the
// profile does not explicitly allow is denied, which is exactly how the
// headless CLI behaves.
// ---------------------------------------------------------------------------

function ruleMatches(rule, tool, path) {
  const match = /^([a-z_]+)(?:\((.*)\))?$/.exec(rule);
  if (!match || match[1] !== tool) return false;
  if (match[2] === undefined) return true;
  // Split on the cross-segment wildcard first so the single-segment expansion
  // below can never rewrite half of it.
  const pattern = match[2]
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(path);
}

function permissionOracle() {
  // The installed CLI applies the GLOBAL store's rules (issue #830), so the
  // stand-in reads them from there rather than from the workspace document.
  if (!existsSync(globalSettingsPath)) return null;
  const settings = JSON.parse(readFileSync(globalSettingsPath, 'utf8'));
  const permissions = settings.permissions;
  if (!permissions || !Array.isArray(permissions.allow)) return null;
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  return (tool, path = '') => {
    if (deny.some((rule) => ruleMatches(rule, tool, path))) return 'denied';
    if (permissions.allow.some((rule) => ruleMatches(rule, tool, path))) return 'allowed';
    return 'denied';
  };
}

const DENIAL_RESULT = {
  stdout: '',
  stderr: 'Requesting tool: read_file\npermission denied (headless mode)\nAborting.',
  exitCode: 0,
};

/**
 * Runner that behaves like the headless CLI: it tries to read repository
 * evidence, and can only produce findings when the workspace profile allows it.
 */
function constrainedAgentRunner(extraCalls = []) {
  const attempted = [];
  return {
    attempted,
    calls: [],
    run(cmd, args, opts) {
      this.calls.push({ cmd, args, opts });
      const oracle = permissionOracle();
      if (!oracle) return DENIAL_RESULT;
      const record = (tool, path) => {
        const verdict = oracle(tool, path);
        attempted.push({ tool, path, verdict });
        return verdict;
      };
      if (record('read_file', join(realRoot, 'src', 'evidence.ts')) !== 'allowed') return DENIAL_RESULT;
      record('list_directory', realRoot);
      record('search_file_content', join(realRoot, 'src'));
      for (const [tool, path] of extraCalls) record(tool, path);
      return {
        stdout: '## Findings\n\nThe committed evidence names `committed-evidence`.\n',
        stderr: '',
        exitCode: 0,
      };
    },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'research-workspace-settings-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  globalSettingsPath = join(tmpDir, 'antigravity-cli-settings.json');
  mkdirSync(repoRoot, { recursive: true });
  realRoot = realpathSync.native(repoRoot);
  initRepo();
  globalSettingsBefore = JSON.stringify({ theme: 'dark', trustedWorkspaces: [realRoot] }, null, 2) + '\n';
  writeFileSync(globalSettingsPath, globalSettingsBefore);
  delete process.env['ANTIGRAVITY_BIN'];
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The reproduction, and the fix
// ---------------------------------------------------------------------------

describe('research handler — workspace settings reproduction (issue #826)', () => {
  test('without preparation the run reproduces the permission-denied/read failure', async () => {
    const handler = createResearchHandler(CONTEXT(SESSION(null)), constrainedAgentRunner());
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(result.context?.outcome).toBe('permission-denied/read');
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(artifactPath(WORKSPACE_ARTIFACT))).toBe(false);
  });

  test('with preparation the same run produces findings without repository changes', async () => {
    const runner = constrainedAgentRunner();
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner);
    const result = await handler(makeTask());

    expect(result.result).toBe('success');
    expect(result.context?.outcome).toBe('valid');
    expect(readFileSync(artifactPath('research-output.md'), 'utf8')).toContain('committed-evidence');
    expect(runner.attempted.filter((a) => a.verdict === 'allowed').map((a) => a.tool))
      .toEqual(['read_file', 'list_directory', 'search_file_content']);
    // No repository change: the profile is ignored locally and nothing is staged.
    expect(git(['status', '--porcelain'])).toBe('');
    expect(git(['ls-files', '--', '.gemini'])).toBe('');
  });

  test('the prepared profile denies writes, commands, Git mutation, and out-of-workspace reads', async () => {
    const runner = constrainedAgentRunner([
      ['write_file', join(realRoot, 'src', 'evidence.ts')],
      ['replace', join(realRoot, 'README.md')],
      ['run_shell_command', 'git commit -am wip'],
      ['web_fetch', 'https://example.invalid/'],
      ['read_file', '/etc/passwd'],
      ['read_file', join(tmpDir, 'outside.txt')],
      ['read_file', join(realRoot, '.env')],
      ['list_directory', '/'],
    ]);
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner);
    await handler(makeTask());

    const verdicts = Object.fromEntries(runner.attempted.map((a) => [`${a.tool}:${a.path}`, a.verdict]));
    expect(verdicts[`write_file:${join(realRoot, 'src', 'evidence.ts')}`]).toBe('denied');
    expect(verdicts[`replace:${join(realRoot, 'README.md')}`]).toBe('denied');
    expect(verdicts['run_shell_command:git commit -am wip']).toBe('denied');
    expect(verdicts['web_fetch:https://example.invalid/']).toBe('denied');
    expect(verdicts['read_file:/etc/passwd']).toBe('denied');
    expect(verdicts[`read_file:${join(tmpDir, 'outside.txt')}`]).toBe('denied');
    expect(verdicts[`read_file:${join(realRoot, '.env')}`]).toBe('denied');
    expect(verdicts['list_directory:/']).toBe('denied');
  });

  test('a denial the profile does not cover still classifies as a structured outcome', async () => {
    const runner = {
      run: () => ({ stdout: '', stderr: 'run_shell_command: permission denied in non-interactive mode', exitCode: 0 }),
    };
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner);
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(result.context?.outcome).toBe('permission-denied/command');
    expect(existsSync(artifactPath('research-permission-denial.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The read-only tool surface (issue #832)
//
// The #830 fix got the grants into the layer the CLI reads and the acceptance
// run still produced nothing: the CLI registered its whole default tool set,
// the model selected a command tool, and headless mode auto-denied it. These
// drive a stand-in that models tool *registration* — it can only select tools
// the global store registers — which is where that failure lives.
// ---------------------------------------------------------------------------

/** The tools the global store registers for a run, as the CLI would resolve them. */
function registeredTools() {
  if (!existsSync(globalSettingsPath)) return null;
  const settings = JSON.parse(readFileSync(globalSettingsPath, 'utf8'));
  const tools = settings.tools;
  if (!tools || !Array.isArray(tools.core)) return null;
  const exclude = Array.isArray(tools.exclude) ? tools.exclude : [];
  return tools.core.filter((tool) => !exclude.includes(tool));
}

const COMMAND_DENIAL_RESULT = {
  stdout: '',
  stderr: 'jetski: no output produced - a tool required the "run_shell_command" permission that headless '
    + 'mode cannot prompt for, so it was auto-denied.',
  exitCode: 0,
};

/**
 * A stand-in whose model prefers a shell — the behaviour the real run showed.
 *
 * If the store registers a command tool it selects one and the run dies on the
 * headless denial; if it does not, it falls back to the read-only tools and
 * produces findings. Nothing else about it changes between the two cases, so the
 * registration is the only variable.
 */
function shellSeekingAgentRunner() {
  return {
    calls: [],
    run(cmd, args, opts) {
      this.calls.push({ cmd, args, opts });
      const registered = registeredTools();
      if (registered === null || registered.includes('run_shell_command')) return COMMAND_DENIAL_RESULT;
      const oracle = permissionOracle();
      if (!oracle || oracle('read_file', join(realRoot, 'src', 'evidence.ts')) !== 'allowed') return DENIAL_RESULT;
      return {
        stdout: '## Findings\n\nThe committed evidence names `committed-evidence`.\n',
        stderr: '',
        exitCode: 0,
      };
    },
  };
}

describe('research handler — read-only tool surface (issue #832)', () => {
  test('an unregistered surface reproduces the permission-denied/command failure', async () => {
    // No profile: the store registers whatever the CLI defaults to, so a
    // command tool is available for selection.
    const handler = createResearchHandler(CONTEXT(SESSION(null)), shellSeekingAgentRunner());
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(result.context?.outcome).toBe('permission-denied/command');
  });

  test('with the registration installed the same run produces findings instead', async () => {
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), shellSeekingAgentRunner());
    const result = await handler(makeTask());

    expect(result.result).toBe('success');
    expect(result.context?.outcome).toBe('valid');
    expect(readFileSync(artifactPath('research-output.md'), 'utf8')).toContain('committed-evidence');
    expect(existsSync(artifactPath('research-tool-surface-violation.json'))).toBe(false);
  });

  test('the registration reaches the store the CLI reads, not only the workspace document', async () => {
    let registeredDuringRun = null;
    let storeDuringRun = null;
    const runner = {
      calls: [],
      run() {
        registeredDuringRun = registeredTools();
        storeDuringRun = JSON.parse(readFileSync(globalSettingsPath, 'utf8'));
        return { stdout: '## Findings\n\nok\n', stderr: '', exitCode: 0 };
      },
    };
    await createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner)(makeTask());

    expect(registeredDuringRun).toContain('read_file');
    expect(registeredDuringRun).toContain('search_file_content');
    for (const tool of ['run_shell_command', 'ShellTool', 'write_file', 'replace', 'web_fetch']) {
      expect(registeredDuringRun).not.toContain(tool);
    }
    // The legacy key spelling carries the same registration, so a build that
    // reads that pair instead is bounded identically.
    expect(storeDuringRun.coreTools).toEqual(storeDuringRun.tools.core);
    expect(storeDuringRun.excludeTools).toEqual(storeDuringRun.tools.exclude);
  });

  test('an operator tool source is suspended for the run and restored afterwards', async () => {
    const operatorStore = {
      theme: 'dark',
      trustedWorkspaces: [realRoot],
      autoAccept: true,
      mcpServers: { helper: { command: '/usr/local/bin/helper-server' } },
      tools: { core: ['run_shell_command'], discoveryCommand: 'list-tools.sh' },
      coreTools: ['run_shell_command'],
    };
    writeFileSync(globalSettingsPath, JSON.stringify(operatorStore, null, 2) + '\n');

    let duringRun = null;
    const runner = {
      calls: [],
      run() {
        duringRun = JSON.parse(readFileSync(globalSettingsPath, 'utf8'));
        return { stdout: '## Findings\n\nok\n', stderr: '', exitCode: 0 };
      },
    };
    const result = await createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner)(makeTask());

    expect(result.result).toBe('success');
    // A subprocess-backed tool source and a blanket auto-approval are both
    // capabilities of the research invocation while they sit in this file.
    expect(duringRun.mcpServers).toEqual({});
    expect(duringRun.autoAccept).toBe(false);
    expect(duringRun.tools.core).not.toContain('run_shell_command');
    expect(duringRun.coreTools).not.toContain('run_shell_command');
    expect(duringRun.tools.discoveryCommand).toBeUndefined();
    // Released on the way out, with the operator's own configuration intact.
    expect(JSON.parse(readFileSync(globalSettingsPath, 'utf8'))).toEqual(operatorStore);
  });

  test('a CLI that ignores the registration produces an actionable diagnostic, not a grant', async () => {
    // The registration is installed and honoured by nothing: the stand-in asks
    // for a command permission regardless.
    const runner = { calls: [], run() { return COMMAND_DENIAL_RESULT; } };
    const result = await createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner)(makeTask());

    expect(result.result).toBe('failed');
    expect(result.context?.outcome).toBe('permission-denied/command');
    expect(result.context?.toolSurfaceViolation).toBe(true);
    // Public-safe, and it names the actual next step rather than a local
    // permission policy that is already correct.
    expect(result.error).toContain('read-only tool registration');
    expect(result.error).toContain('antigravity-cli/settings@3');
    expect(result.error).not.toContain(realRoot);
    expect(result.error).not.toContain(globalSettingsPath);

    const violation = readArtifact('research-tool-surface-violation.json');
    expect(violation.deniedOperation).toBe('command');
    expect(violation.toolSurfaceInstalled).toBe(true);
    expect(violation.cliVersion).toBe('1.1.9');
    expect(violation.toolSurface.exclude).toContain('run_shell_command');
    expect(violation.commandCapableToolNames).toEqual(['run_shell_command', 'ShellTool']);
    expect(violation.operatorHint).toContain('never the remedy');
    expect(JSON.stringify(violation)).not.toContain(realRoot);

    const result_json = readArtifact('research-result.json');
    expect(result_json.permissionDenial.toolSurfaceViolation).toBe(true);
    expect(result_json.permissionDenial.toolSurfaceArtifact).toBe('research-tool-surface-violation.json');
    // The operator's store is still released: a violation is not a leak.
    expect(JSON.parse(readFileSync(globalSettingsPath, 'utf8')))
      .toEqual(JSON.parse(globalSettingsBefore));
  });

  test('a read-class denial is not reported as a tool-surface violation', async () => {
    const runner = { calls: [], run() { return DENIAL_RESULT; } };
    const result = await createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner)(makeTask());

    expect(result.context?.outcome).toBe('permission-denied/read');
    expect(result.context?.toolSurfaceViolation).toBeUndefined();
    expect(existsSync(artifactPath('research-tool-surface-violation.json'))).toBe(false);
  });

  test('the prompt states the read-only tool surface and forbids command attempts', async () => {
    await createResearchHandler(CONTEXT(SESSION({ enabled: true })), constrainedAgentRunner())(makeTask());
    const prompt = readFileSync(artifactPath('research-prompt.md'), 'utf8');

    expect(prompt).toContain('read-only tool profile');
    expect(prompt).toContain('read_file, read_many_files, search_file_content');
    expect(prompt).toContain('Do NOT attempt to run shell commands');
    // Runner-owned: the boundary is stated in the Instructions section, after
    // the delimited Issue body, never inside untrusted GitHub content.
    expect(prompt.indexOf('## Instructions')).toBeLessThan(prompt.indexOf('read-only tool profile'));
  });

  test('a run without the profile keeps its previous prompt', async () => {
    await createResearchHandler(CONTEXT(SESSION(null)), constrainedAgentRunner())(makeTask());
    const prompt = readFileSync(artifactPath('research-prompt.md'), 'utf8');

    expect(prompt).not.toContain('read-only tool profile');
    expect(prompt).toContain('Do NOT implement fixes');
  });
});

// ---------------------------------------------------------------------------
// Artifacts and public reporting
// ---------------------------------------------------------------------------

describe('research handler — workspace settings artifacts (issue #826)', () => {
  test('records the policy version and hash locally, without absolute paths or contents', async () => {
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), constrainedAgentRunner());
    await handler(makeTask());

    const artifact = readArtifact(WORKSPACE_ARTIFACT);
    expect(artifact.policyVersion).toBe('research-readonly/3');
    expect(artifact.schemaPin).toBe('antigravity-cli/settings@3');
    expect(artifact.relativePath).toBe('.gemini/settings.json');
    expect(artifact.settingsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.preparations).toBe(1);
    expect(artifact.released).toBe(true);
    expect(artifact.trust.status).toBe('trusted-exact');
    expect(artifact.trust.registered).toBe(false);
    expect(artifact.trust.representation).toBe('trustedWorkspaces');
    expect(artifact.cliVersion).toBe('1.1.9');
    expect(artifact.globalOverlay).toEqual({
      installed: true,
      allowRuleCount: expect.any(Number),
      denyRuleCount: expect.any(Number),
      toolSurfaceInstalled: true,
      reclaimed: 0,
    });
    // The registration is part of the record (issue #832): the read-only tools
    // the CLI may offer, and the command/write/network tools it may not.
    expect(artifact.toolSurface.core).toContain('read_file');
    expect(artifact.toolSurface.core).not.toContain('run_shell_command');
    expect(artifact.toolSurface.exclude).toContain('run_shell_command');
    expect(artifact.toolSurface.exclude).toContain('ShellTool');

    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(realRoot);
    expect(serialized).not.toContain(repoRoot);
    expect(serialized).not.toContain(globalSettingsPath);
    // The rendered rules embed the workspace root, so they stay out of the record.
    expect(serialized).not.toContain('read_file(');
    expect(serialized).not.toContain('run_shell_command(');

    const result = readArtifact('research-result.json');
    expect(result.workspaceSettings).toEqual({
      policyVersion: 'research-readonly/3',
      settingsSha256: artifact.settingsSha256,
      preparations: 1,
      artifact: WORKSPACE_ARTIFACT,
    });
  });

  test('a refusal fails the run with a public-safe message and a detailed local artifact', async () => {
    // Track the settings file so preparation must refuse it.
    mkdirSync(join(repoRoot, '.gemini'), { recursive: true });
    writeFileSync(settingsPath(), '{"repositoryOwned": true}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'repository-owned settings']);

    const runner = constrainedAgentRunner();
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner);
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('reason: settings-tracked-by-git');
    expect(result.error).not.toContain(realRoot);
    expect(result.error).not.toContain(repoRoot);
    expect(result.context?.workspaceSettings).toEqual({ enabled: true, refusalReason: 'settings-tracked-by-git' });
    // The agent is never invoked under an unverified profile, and the
    // repository-owned file is left exactly as committed.
    expect(runner.calls).toHaveLength(0);
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{"repositoryOwned": true}\n');

    const artifact = readArtifact(WORKSPACE_ARTIFACT);
    expect(artifact.refusal.reason).toBe('settings-tracked-by-git');
    expect(artifact.preparations).toBe(0);
  });

  test('an invalid operator glob refuses even with evidence disabled, before any profile is written', async () => {
    // The same denyGlobs/generatedGlobs feed the generated profile, so the
    // enable-time grammar gate belongs to this mode too: a traversal glob would
    // otherwise be emitted as a lexical `<workspace>/../private/**` deny rule
    // that passes the profile's string-prefix scope check.
    for (const field of ['denyGlobs', 'generatedGlobs']) {
      const runner = constrainedAgentRunner();
      const handler = createResearchHandler(
        CONTEXT(SESSION({ enabled: true }, { enabled: false, [field]: ['src/**', '../private/**'] })),
        runner,
      );
      const result = await handler(makeTask());

      expect(result.result).toBe('failed');
      expect(result.error).toBe(
        `Research cannot run: session.research.evidence.${field}[1] is not a valid evidence glob (glob-traversal)`,
      );
      expect(result.error).not.toContain('private');
      expect(runner.calls).toHaveLength(0);
      expect(existsSync(settingsPath())).toBe(false);
    }
  });

  test('an operator-overridden binary refuses instead of writing an unvetted profile', async () => {
    process.env['ANTIGRAVITY_BIN'] = '/usr/local/bin/custom-agy';
    try {
      const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), constrainedAgentRunner());
      const result = await handler(makeTask());
      expect(result.result).toBe('failed');
      expect(result.error).toContain('reason: unvetted-cli-binary');
      expect(existsSync(settingsPath())).toBe(false);
    } finally {
      delete process.env['ANTIGRAVITY_BIN'];
    }
  });

  test('disabled by default: nothing is written into the workspace', async () => {
    const handler = createResearchHandler(
      CONTEXT(SESSION(null)),
      { run: () => ({ stdout: 'Findings.', stderr: '', exitCode: 0 }) },
    );
    const result = await handler(makeTask());

    expect(result.result).toBe('success');
    expect(existsSync(join(repoRoot, '.gemini'))).toBe(false);
    expect(existsSync(artifactPath(WORKSPACE_ARTIFACT))).toBe(false);
    expect(readArtifact('research-result.json').workspaceSettings).toBeUndefined();
    expect(git(['status', '--porcelain'])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Global overlay lifecycle across the run (§2.5, issue #830)
// ---------------------------------------------------------------------------

describe('research handler — global overlay lifecycle (issue #830)', () => {
  test('the grants exist only while the agent runs, and the store is restored after', async () => {
    let duringRun = null;
    const runner = {
      calls: [],
      run(cmd, args, opts) {
        this.calls.push({ cmd, args, opts });
        duringRun = JSON.parse(readFileSync(globalSettingsPath, 'utf8'));
        return { stdout: '## Findings\n\nDone.\n', stderr: '', exitCode: 0 };
      },
    };
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner);
    const result = await handler(makeTask());

    expect(result.result).toBe('success');
    // While the CLI runs, the workspace-scoped read rules are installed.
    expect(duringRun.permissions.allow).toContain(`read_file(${realRoot}/**)`);
    // Afterwards the operator's store is exactly as it was found.
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(globalSettingsBefore);
  });

  test('a failing run still leaves no runner-owned entry behind', async () => {
    const runner = { run: () => ({ stdout: '', stderr: 'boom', exitCode: 2 }) };
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner);
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(globalSettingsBefore);
  });

  test('a release that does not succeed fails the phase instead of reporting a result', async () => {
    // The entries are machine-wide read grants on this workspace, and the
    // journal naming them carries the worker's long-lived pid — nothing else
    // reclaims them until the TTL, so every `agy` invocation sharing the store
    // would inherit them in the meantime (issue #830 review). Reporting a normal
    // research result on top of that would hide it.
    const runner = { run: () => ({ stdout: '## Findings\n\nDone.\n', stderr: '', exitCode: 0 }) };
    let attempts = 0;
    const handler = createResearchHandler(
      CONTEXT(SESSION({ enabled: true })),
      runner,
      undefined,
      undefined,
      undefined,
      () => {
        attempts++;
        throw new AntigravityWorkspaceSettingsError('global-settings-locked', 'held by another process');
      },
    );
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('reason: global-overlay-release-failed');
    expect(result.context.workspaceSettings).toEqual({
      enabled: true,
      refusalReason: 'global-overlay-release-failed',
    });
    // Retried before giving up: the usual cause is transient lock contention.
    expect(attempts).toBe(2);
    // The local record names what is still installed and why it could not go.
    const artifact = readArtifact(WORKSPACE_ARTIFACT);
    expect(artifact.released).toBe(false);
    expect(artifact.releaseFailure).toEqual({
      reason: 'global-settings-locked',
      detail: 'held by another process',
    });
    // The run's own capture is still kept for the operator.
    expect(readFileSync(artifactPath('research-output.md'), 'utf8')).toContain('Findings');
    // And the leak the failure is reporting is real: the grants are still there.
    expect(JSON.parse(readFileSync(globalSettingsPath, 'utf8')).permissions.allow)
      .toContain(`read_file(${realRoot}/**)`);
  });

  test('a refusal after an earlier successful turn releases what that turn installed', async () => {
    const { prepareAntigravityWorkspaceSettings } = await import('../dist/handlers/antigravity-workspace.js');
    let turn = 0;
    const request = [
      EVIDENCE_REQUEST_MARKER,
      JSON.stringify({ queries: [{ id: 'q1', op: 'list', glob: '**/*.ts' }] }),
      EVIDENCE_REQUEST_END_MARKER,
    ].join('\n');
    const handler = createResearchHandler(
      CONTEXT(SESSION({ enabled: true }, { enabled: true, maxTurns: 2 })),
      { run: () => ({ stdout: request, stderr: '', exitCode: 0 }) },
      undefined,
      (input) => {
        // The second preparation refuses, standing in for a workspace that
        // changed underneath the run.
        if (turn++ > 0) throw new AntigravityWorkspaceSettingsError('settings-tracked-by-git');
        return prepareAntigravityWorkspaceSettings(input);
      },
    );
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('reason: settings-tracked-by-git');
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(globalSettingsBefore);
    expect(readArtifact(WORKSPACE_ARTIFACT).released).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Publication withholding (§5) and launch-time verification (§1)
// ---------------------------------------------------------------------------

describe('research handler — enabling the profile withholds raw output (issue #826)', () => {
  test('the success context omits researchOutput even with no body and no evidence', async () => {
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), constrainedAgentRunner());
    const result = await handler(makeTask());

    // The task carries a title only, so bodyIncluded is false and evidence is
    // off: without the profile's own withholding condition, everything the
    // agent read directly would be published verbatim.
    expect(result.result).toBe('success');
    expect(result.context?.bodyIncluded).toBe(false);
    expect(result.context?.evidenceEnabled).toBeUndefined();
    expect(result.context?.workspaceSettingsEnabled).toBe(true);
    expect(result.context?.researchOutput).toBeUndefined();
    // Still available locally.
    expect(readFileSync(artifactPath('research-output.md'), 'utf8')).toContain('committed-evidence');
  });

  test('a nonzero exit does not interpolate agent output into the public failure', async () => {
    const runner = {
      run: () => ({ stdout: 'read /repo/.env: SECRET_TOKEN=abcd', stderr: 'boom', exitCode: 2 }),
    };
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), runner);
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('Output withheld');
    expect(result.error).toContain('a workspace read-only permission profile was enabled for the run');
    expect(result.error).not.toContain('SECRET_TOKEN');
    expect(result.error).not.toContain('boom');
  });

  test('with the profile disabled the excerpt behaviour is unchanged', async () => {
    const handler = createResearchHandler(
      CONTEXT(SESSION(null)),
      { run: () => ({ stdout: 'Findings.', stderr: '', exitCode: 0 }) },
    );
    const result = await handler(makeTask());

    expect(result.result).toBe('success');
    expect(result.context?.researchOutput).toBe('Findings.');
    expect(result.context?.workspaceSettingsEnabled).toBeUndefined();
  });
});

describe('research handler — launch-time profile verification (issue #826)', () => {
  test('a profile replaced between preparation and launch fails the run closed', async () => {
    // Stand in for another process writing inside the workspace: preparation
    // succeeds and verifies its own descriptor, then the pathname the CLI will
    // resolve is replaced with a broader regular file.
    const { prepareAntigravityWorkspaceSettings } = await import('../dist/handlers/antigravity-workspace.js');
    const runner = constrainedAgentRunner();
    const handler = createResearchHandler(
      CONTEXT(SESSION({ enabled: true })),
      runner,
      undefined,
      (input) => {
        const prepared = prepareAntigravityWorkspaceSettings(input);
        rmSync(settingsPath());
        writeFileSync(settingsPath(), JSON.stringify({
          autoAccept: true,
          permissions: { allow: ['run_shell_command', 'write_file'], deny: [] },
        }));
        return prepared;
      },
    );
    const result = await handler(makeTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('reason: settings-replaced-before-launch');
    expect(result.error).not.toContain(realRoot);
    expect(result.context?.workspaceSettings).toEqual({
      enabled: true,
      refusalReason: 'settings-replaced-before-launch',
    });
    // The agent never runs under the profile the runner did not author.
    expect(runner.calls).toHaveLength(0);
    expect(readArtifact(WORKSPACE_ARTIFACT).refusal.reason).toBe('settings-replaced-before-launch');
  });

  test('a verified run records one verification per preparation', async () => {
    const handler = createResearchHandler(CONTEXT(SESSION({ enabled: true })), constrainedAgentRunner());
    const result = await handler(makeTask());

    expect(result.result).toBe('success');
    const artifact = readArtifact(WORKSPACE_ARTIFACT);
    expect(artifact.verifications).toBe(artifact.preparations);
    expect(artifact.verifications).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regeneration across evidence turns
// ---------------------------------------------------------------------------

describe('research handler — regeneration before every invocation (issue #826)', () => {
  test('the profile is regenerated for each evidence turn, so a broader file cannot persist', async () => {
    const request = [
      EVIDENCE_REQUEST_MARKER,
      JSON.stringify({ queries: [{ id: 'q1', op: 'list', glob: '**/*.ts' }] }),
      EVIDENCE_REQUEST_END_MARKER,
    ].join('\n');
    let call = 0;
    const runner = {
      calls: [],
      run(cmd, args, opts) {
        this.calls.push({ cmd, args, opts });
        // Between turns, something replaces the profile with a broader one; the
        // next preparation must overwrite it before the agent runs again.
        if (call === 0) {
          writeFileSync(settingsPath(), JSON.stringify({ autoAccept: true, permissions: { allow: ['run_shell_command'] } }));
          call++;
          return { stdout: request, stderr: '', exitCode: 0 };
        }
        return { stdout: '## Findings\n\nDone.\n', stderr: '', exitCode: 0 };
      },
    };

    const handler = createResearchHandler(
      CONTEXT(SESSION({ enabled: true }, { enabled: true, maxTurns: 2 })),
      runner,
    );
    const result = await handler(makeTask());

    expect(result.result).toBe('success');
    expect(runner.calls.length).toBeGreaterThan(1);
    const artifact = readArtifact(WORKSPACE_ARTIFACT);
    expect(artifact.preparations).toBe(runner.calls.length);
    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(settings.autoAccept).toBe(false);
    expect(settings.permissions.allow).not.toContain('run_shell_command');
    expect(git(['status', '--porcelain'])).toBe('');
  });
});
