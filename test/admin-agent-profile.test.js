/**
 * `admin agent-profile list|show|validate` (issue #913) — the read-only
 * operator surface of docs/agent-runtime-profiles-contract.md §11.4/§13.4.
 *
 * These cases pin the three things the issue asks for and the contract makes
 * load-bearing:
 *
 *   1. **Both output modes.** All three commands are human-readable by default
 *      and emit the stable JSON payload with `--json`.
 *   2. **Built-in versus overridden is visible**, for a binding, for a single
 *      setting, and for an explicitly unset one (§9.4) — and the commands work
 *      with no `agent-profiles.json` present at all (§9.2).
 *   3. **Refusals surface here rather than mid-run** (§12.2/§12.3): a binding
 *      naming an undeclared profile, an env override outside a provider's
 *      declared list, and a session pin the catalog does not declare are all
 *      reported before any agent is invoked — while capability discovery
 *      (§7.1, §11.3) stays informational and never invalidates a profile.
 *
 * Strict option parsing is exercised too, because "an invalid abbreviated flag
 * fails rather than being ignored" is the shared admin CLI guarantee of
 * docs/admin-cli-contract.md, not something each command may re-decide.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAdmin } from './helpers/admin-cli.js';

let tmpDir;
let sessionsPath;
let catalogPath;

/**
 * Every run starts from a clean environment for the variables this surface
 * reads, so an ambient `CLAUDE_MODEL` on a developer's machine cannot change a
 * resolution a case is asserting on.
 */
const CLEAN_ENV = {
  AGENT_PROFILES_FILE: undefined,
  CLAUDE_MODEL: undefined,
  CLAUDE_EFFORT: undefined,
  CLAUDE_MAX_BUDGET_USD: undefined,
  CODEX_MODEL: undefined,
  CODEX_EFFORT: undefined,
  ANTIGRAVITY_BIN: undefined,
};

function run(args, env = {}) {
  return runAdmin(args, { env: { ...CLEAN_ENV, ...env } });
}

function writeSessions(agentRuntime) {
  const sessions = {
    sessions: [
      {
        sessionId: 'addon-dev',
        repoKey: 'test-repo',
        repoRoot: join(tmpDir, 'repo'),
        githubRepo: 'm2dw/test-repo',
        artifactDir: '.n8n-artifacts',
        baseBranch: 'main',
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        verification: { test: 'true' },
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        ...(agentRuntime ? { agentRuntime } : {}),
      },
    ],
  };
  writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

function writeCatalog(document, path = catalogPath) {
  writeFileSync(path, JSON.stringify(document, null, 2));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-agent-profile-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  catalogPath = join(tmpDir, 'agent-profiles.json');
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// agent-profile list
// ---------------------------------------------------------------------------

describe('admin agent-profile list', () => {
  test('works with no catalog file and reports the built-in defaults', async () => {
    const res = await run(['agent-profile', 'list', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.catalog.source).toBe('builtin');
    expect(payload.catalog.path).toBe(catalogPath);
    expect(payload.catalog.pathSource).toBe('default');
    expect(payload.catalog.schemaVersion).toBe(1);
    expect(payload.catalog.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.providers.map((p) => p.provider)).toEqual(['anthropic', 'google', 'openai']);

    const anthropic = payload.providers.find((p) => p.provider === 'anthropic');
    expect(anthropic.agents).toEqual(['claude']);
    expect(anthropic.adapter).toBe('registered');
    expect(anthropic.defaultBinary).toBe('claude');
    // All four levels are bound and every value comes from the built-in layer.
    expect(anthropic.qualityBindings.map((b) => [b.level, b.profileName, b.source])).toEqual([
      ['light', 'claude-light', 'catalog-builtin'],
      ['normal', 'claude-normal', 'catalog-builtin'],
      ['strong', 'claude-strong', 'catalog-builtin'],
      ['maximum', 'claude-maximum', 'catalog-builtin'],
    ]);
    const strong = anthropic.profiles.find((p) => p.name === 'claude-strong');
    expect(strong.settings).toEqual([
      { setting: 'model', value: 'opus', source: 'catalog-builtin' },
      { setting: 'effort', value: 'high', source: 'catalog-builtin' },
      { setting: 'budget', value: '10', source: 'catalog-builtin' },
    ]);
    expect(strong.boundLevels).toEqual(['strong']);
  });

  test('reports a declared shared binding as configuration, not a downgrade', async () => {
    const res = await run(['agent-profile', 'list', '--sessions-path', sessionsPath, '--json']);
    const payload = JSON.parse(res.stdout);
    const openai = payload.providers.find((p) => p.provider === 'openai');
    const maximum = openai.qualityBindings.find((b) => b.level === 'maximum');
    expect(maximum.profileName).toBe('codex-high');
    expect(maximum.sharedWithQualityLevels).toEqual(['normal', 'strong']);
    // The three-value effort ceiling is data, not a TypeScript union (§6.2).
    const effort = openai.capabilities.find((c) => c.setting === 'effort');
    expect(effort.declaration).toEqual(['low', 'medium', 'high']);
    // Codex declares no budget setting at all, which is why a budget on that
    // provider is `not-applicable` rather than dropped in silence.
    expect(openai.capabilities.map((c) => c.setting)).not.toContain('budget');
  });

  test('labels an overlay-supplied value overridden and keeps the untouched ones built-in', async () => {
    writeCatalog({
      schemaVersion: 1,
      catalogVersion: 'test-overlay',
      providers: {
        anthropic: {
          profiles: { 'claude-strong': { model: 'fable', budget: null } },
          qualityBindings: { maximum: 'claude-strong' },
        },
      },
    });
    const res = await run(['agent-profile', 'list', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.catalog.source).toBe('file');
    expect(payload.catalog.catalogVersion).toBe('test-overlay');
    expect(payload.catalog.catalogVersionSource).toBe('catalog-overlay');

    const anthropic = payload.providers.find((p) => p.provider === 'anthropic');
    const strong = anthropic.profiles.find((p) => p.name === 'claude-strong');
    // The overlay retargeted the model and explicitly unset the budget; the
    // effort it never mentioned keeps its built-in value and its built-in label.
    expect(strong.settings).toEqual([
      { setting: 'model', value: 'fable', source: 'catalog-overlay' },
      { setting: 'effort', value: 'high', source: 'catalog-builtin' },
    ]);
    expect(strong.unsetByOverlay).toEqual(['budget']);
    expect(strong.boundLevels).toEqual(['strong', 'maximum']);
    const maximum = anthropic.qualityBindings.find((b) => b.level === 'maximum');
    expect(maximum.source).toBe('catalog-overlay');
    expect(maximum.sharedWithQualityLevels).toEqual(['strong']);
  });

  test('human output is the default and names the built-in/overridden layer', async () => {
    const res = await run(['agent-profile', 'list', '--sessions-path', sessionsPath]);
    expect(res.code).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow();
    expect(res.stdout).toContain('built-in defaults (no catalog file at');
    expect(res.stdout).toContain('anthropic (built-in) — agents: claude — adapter registered');
    expect(res.stdout).toMatch(/maximum -> codex-high \(built-in, shared with normal, strong\)/);
    expect(res.stdout).toContain('model=opus (built-in)');
  });

  test('reads the catalog path from the session when it configures one', async () => {
    const configured = join(tmpDir, 'elsewhere.json');
    writeCatalog(
      {
        schemaVersion: 1,
        providers: { anthropic: { profiles: { 'claude-normal': { model: 'session-model' } } } },
      },
      configured,
    );
    writeSessions({ profilesPath: configured });
    const res = await run([
      'agent-profile',
      'list',
      '--session-id',
      'addon-dev',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.catalog.path).toBe(configured);
    expect(payload.catalog.pathSource).toBe('session-config');
    const normal = payload.providers
      .find((p) => p.provider === 'anthropic')
      .profiles.find((p) => p.name === 'claude-normal');
    expect(normal.settings).toContainEqual({
      setting: 'model',
      value: 'session-model',
      source: 'catalog-overlay',
    });
  });
});

// ---------------------------------------------------------------------------
// agent-profile show
// ---------------------------------------------------------------------------

describe('admin agent-profile show', () => {
  test('answers which model and effort one agent and quality will use', async () => {
    const res = await run([
      'agent-profile',
      'show',
      'claude',
      '--quality',
      'strong',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.agent).toBe('claude');
    expect(payload.provider).toBe('anthropic');
    expect(payload.quality).toEqual({ level: 'strong', source: 'option' });
    // All four levels are always reported, whichever one is selected.
    expect(payload.levels.map((l) => l.level)).toEqual(['light', 'normal', 'strong', 'maximum']);
    expect(payload.levels.filter((l) => l.selected).map((l) => l.level)).toEqual(['strong']);

    const strong = payload.levels.find((l) => l.level === 'strong');
    expect(strong.binding.profileName).toBe('claude-strong');
    expect(strong.resolved.profileName).toBe('claude-strong');
    expect(strong.resolved.profileSource).toBe('catalog-builtin');
    expect(strong.resolved.model).toEqual({ value: 'opus', source: 'catalog-builtin' });
    expect(strong.resolved.effort).toEqual({ value: 'high', source: 'catalog-builtin' });
    expect(strong.resolved.budget).toEqual({ value: '10', source: 'catalog-builtin' });
    expect(strong.resolved.binary).toEqual({ value: 'claude', source: 'default' });
    expect(strong.refusal).toBeNull();
  });

  test('an unset setting is an absence with its reason, never a model named default', async () => {
    const res = await run(['agent-profile', 'show', 'gemini', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    const normal = payload.levels.find((l) => l.level === 'normal');
    // Antigravity's built-in profiles name no model: the CLI's own default
    // applies and the absence carries that source rather than a value.
    expect(normal.resolved.model).toEqual({ source: 'cli-default' });
    // ... while effort is absent for a different reason: `google` declares no
    // effort setting at all, because it folds the tier into the model name.
    expect(normal.resolved.effort).toEqual({ source: 'not-applicable' });
    expect(normal.resolved.binary).toEqual({ value: 'agy', source: 'default' });
    expect(normal.resolved.providerOptions).toEqual([
      { key: 'printTimeout', value: '15m', source: 'catalog-builtin' },
    ]);
  });

  test('a break-glass environment override is reported with source env', async () => {
    const res = await run(
      ['agent-profile', 'show', 'claude', '--sessions-path', sessionsPath, '--json'],
      { CLAUDE_MODEL: 'sonnet-test', CLAUDE_MAX_BUDGET_USD: '3' },
    );
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    for (const level of payload.levels) {
      expect(level.resolved.model).toEqual({ value: 'sonnet-test', source: 'env' });
      expect(level.resolved.budget).toEqual({ value: '3', source: 'env' });
      // Layer 1 is field-level: the effort each level resolves is untouched.
      expect(level.resolved.effort.source).toBe('catalog-builtin');
    }
  });

  test('an env override outside the declared list refuses per level instead of clamping', async () => {
    const res = await run(
      ['agent-profile', 'show', 'codex', '--sessions-path', sessionsPath, '--json'],
      { CODEX_EFFORT: 'xhigh' },
    );
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    for (const level of payload.levels) {
      expect(level.resolved).toBeNull();
      expect(level.refusal.reason).toBe('invalid-override');
      expect(level.refusal.message).toContain('CODEX_EFFORT');
      // Never lowered to the highest declared value (§12.3).
      expect(level.refusal.message).not.toMatch(/using high/);
    }
  });

  test('a flag-shaped env override refuses here, exactly as it would mid-run', async () => {
    // `model` is declared `free`, so §8.1 resolution accepts any non-empty
    // value and only the provider adapter knows the Claude CLI would parse
    // this one as another option. Reporting `ok` because the ladder resolved
    // would approve a configuration the very next run refuses.
    const res = await run(
      ['agent-profile', 'show', 'claude', '--sessions-path', sessionsPath, '--json'],
      { CLAUDE_MODEL: '--help' },
    );
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    for (const level of payload.levels) {
      expect(level.resolved).toBeNull();
      expect(level.refusal.reason).toBe('unsupported-value');
      expect(level.refusal.message).toContain('"--help"');
      // The refusal points at the variable to change, not at the resolution.
      expect(level.refusal.message).toContain('set in the operator environment');
    }
  });

  test('an overlay value the provider CLI cannot take refuses per level', async () => {
    // The same gate, one layer down: the catalog accepts this model (whether a
    // model name exists is the provider's answer, never a shape rule) and the
    // ladder resolves it, so only the adapter can refuse it.
    writeCatalog({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-normal': { model: '--model' } } } },
    });
    const res = await run(['agent-profile', 'show', 'claude', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    const normal = payload.levels.find((l) => l.level === 'normal');
    expect(normal.resolved).toBeNull();
    expect(normal.refusal.reason).toBe('unsupported-value');
    expect(normal.refusal.message).toContain('agent-profiles.json overlay');
    // Only the profile the overlay touched is affected — the other three
    // levels still resolve, so the report stays per level.
    expect(payload.levels.find((l) => l.level === 'strong').refusal).toBeNull();
  });

  test('a session pin replaces the binding lookup for every level', async () => {
    writeSessions({ defaultQuality: 'maximum', pins: { claude: 'claude-light' } });
    const res = await run([
      'agent-profile',
      'show',
      'claude',
      '--session-ref',
      'addon-dev',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.sessionPinnedProfile).toBe('claude-light');
    // The session's default quality is what an unlabelled run would request.
    expect(payload.quality).toEqual({ level: 'maximum', source: 'session-config' });
    for (const level of payload.levels) {
      // The declared binding is still reported — a pin does not rewrite the
      // catalog — while every resolution goes through the pinned profile.
      expect(level.binding.profileName).toBe(`claude-${level.level}`);
      expect(level.resolved.profileName).toBe('claude-light');
      expect(level.resolved.profileSource).toBe('session-config');
      expect(level.resolved.model).toEqual({ value: 'sonnet', source: 'catalog-builtin' });
    }
  });

  test('a session pin naming an undeclared profile refuses rather than falling back', async () => {
    writeSessions({ pins: { claude: 'claude-nonexistent' } });
    const res = await run([
      'agent-profile',
      'show',
      'claude',
      '--session-id',
      'addon-dev',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.levels.every((l) => l.refusal.reason === 'unknown-profile')).toBe(true);
  });

  test('human output names the selected level, the profile, and each value source', async () => {
    const res = await run([
      'agent-profile',
      'show',
      'claude',
      '--quality',
      'maximum',
      '--sessions-path',
      sessionsPath,
    ]);
    expect(res.code).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow();
    expect(res.stdout).toContain('Agent claude (provider anthropic) — quality maximum (option)');
    expect(res.stdout).toContain('maximum (selected) — binds claude-maximum (built-in)');
    expect(res.stdout).toContain('model: fable (built-in)');
    expect(res.stdout).toContain('budget (USD): 20 (built-in)');
    expect(res.stdout).toContain('binary: claude (adapter default)');
  });

  test('an unknown agent refuses fail-closed', async () => {
    const res = await run(['agent-profile', 'show', 'nope', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('unknown-provider');
  });

  test('requires the agent positional and rejects a second one', async () => {
    const missing = await run(['agent-profile', 'show', '--sessions-path', sessionsPath, '--json']);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).error).toContain('agent is required');

    const extra = await run([
      'agent-profile',
      'show',
      'claude',
      'codex',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(extra.code).toBe(1);
    expect(JSON.parse(extra.stdout).error).toContain('Unexpected argument: codex');
  });

  test('an unrecognized quality level is refused, not resolved to the nearest one', async () => {
    const res = await run([
      'agent-profile',
      'show',
      'claude',
      '--quality',
      'xhigh',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toContain(
      '--quality must be one of: light, normal, strong, maximum',
    );
  });
});

// ---------------------------------------------------------------------------
// agent-profile validate
// ---------------------------------------------------------------------------

describe('admin agent-profile validate', () => {
  test('the built-in catalog validates with no file present', async () => {
    const res = await run(['agent-profile', 'validate', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.candidate).toBe(false);
    expect(payload.findings).toEqual([]);
    expect(payload.catalog.source).toBe('builtin');
    expect(payload.checked.providers).toBe(3);
    expect(payload.checked.bindings).toBe(12);
    expect(payload.checked.agents).toEqual(['claude', 'codex', 'gemini']);
    expect(payload.defaultQuality).toEqual({ level: 'normal', source: 'default' });
    // Discovery is opt-in and, when it did not run, says so rather than
    // implying every CLI was found.
    expect(payload.capabilityDiscovery).toEqual({ probed: false, results: [] });
  });

  test('a binding naming an undeclared profile is reported with its refusal reason', async () => {
    writeCatalog({
      schemaVersion: 1,
      providers: { openai: { qualityBindings: { maximum: 'codex-xhigh' } } },
    });
    const res = await run(['agent-profile', 'validate', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.catalog).toBeNull();
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0].severity).toBe('error');
    expect(payload.findings[0].scope).toBe('catalog');
    expect(payload.findings[0].reason).toBe('unknown-profile');
    expect(payload.findings[0].message).toContain('codex-xhigh');
  });

  test('a catalog written for a newer schema is refused whole, not partially applied', async () => {
    writeCatalog({
      schemaVersion: 99,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'fable' } } } },
    });
    const res = await run(['agent-profile', 'validate', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.findings[0].reason).toBe('catalog-schema-unsupported');
    // Refused whole: no effective catalog is reported for a document this
    // binary does not understand.
    expect(payload.catalog).toBeNull();
  });

  test('an unreadable catalog is a refusal, never a silent fall-through to the built-in', async () => {
    writeFileSync(catalogPath, '{ not json');
    const res = await run(['agent-profile', 'validate', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.findings[0].reason).toBe('catalog-unreadable');
  });

  test('an env override outside a provider capability is reported once, naming its levels', async () => {
    const res = await run(
      ['agent-profile', 'validate', '--sessions-path', sessionsPath, '--json'],
      { CODEX_EFFORT: 'xhigh' },
    );
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    const codex = payload.findings.filter((f) => f.target.startsWith('codex'));
    expect(codex).toHaveLength(1);
    expect(codex[0].reason).toBe('invalid-override');
    expect(codex[0].target).toBe('codex (quality light, normal, strong, maximum)');
    // The other agents are unaffected and produce no finding of their own.
    expect(payload.findings).toHaveLength(1);
  });

  test('a value the ladder resolves but the provider CLI refuses is an error, not an ok', async () => {
    // The regression this pins: §12.1 has two pre-invocation gates, and a
    // pre-adoption check that ran only the first would report `ok: true` for a
    // configuration `planAgentInvocation` refuses as `unsupported-value` the
    // moment a phase starts.
    const res = await run(
      ['agent-profile', 'validate', '--sessions-path', sessionsPath, '--json'],
      { CLAUDE_MODEL: '--help' },
    );
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0].scope).toBe('agent');
    expect(payload.findings[0].reason).toBe('unsupported-value');
    // Identical across all four levels, so it is reported once naming them.
    expect(payload.findings[0].target).toBe('claude (quality light, normal, strong, maximum)');
    expect(payload.findings[0].message).toContain('"--help"');
  });

  test('a provider option the provider has no invocation for is reported', async () => {
    // An operator widened the descriptor and set the option. The catalog and
    // the ladder both accept it — only the adapter knows the Claude invocation
    // has no place for it, and §12.3 forbids honoring the profile while
    // dropping the option.
    writeCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: {
          capabilities: { providerOptions: ['thinkingBudget'] },
          profiles: { 'claude-strong': { providerOptions: { thinkingBudget: '4096' } } },
        },
      },
    });
    const res = await run(['agent-profile', 'validate', '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    const claude = payload.findings.filter((f) => f.target.startsWith('claude'));
    expect(claude).toHaveLength(1);
    expect(claude[0].reason).toBe('unsupported-setting');
    expect(claude[0].target).toBe('claude (quality strong)');
    expect(claude[0].message).toContain('thinkingBudget');
  });

  test('human failure output names an adapter refusal the same way as a ladder refusal', async () => {
    const res = await run(['agent-profile', 'validate', '--sessions-path', sessionsPath], {
      CLAUDE_MODEL: '--help',
    });
    expect(res.code).toBe(1);
    expect(() => JSON.parse(res.stdout)).toThrow();
    expect(res.stdout).toContain('Agent profile catalog: 1 error.');
    expect(res.stdout).toContain(
      'error: [unsupported-value] claude (quality light, normal, strong, maximum):',
    );
  });

  test('--file validates a candidate without adopting it', async () => {
    // The configured location holds a catalog that would fail; the candidate is
    // the one being judged, so the command must read the candidate alone.
    writeCatalog({ schemaVersion: 1, providers: { openai: { qualityBindings: { light: 'nope' } } } });
    const candidate = join(tmpDir, 'candidate.json');
    writeCatalog(
      {
        schemaVersion: 1,
        catalogVersion: 'candidate-1',
        providers: { anthropic: { profiles: { 'claude-strong': { model: 'fable' } } } },
      },
      candidate,
    );
    const res = await run([
      'agent-profile',
      'validate',
      '--file',
      candidate,
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.candidate).toBe(true);
    expect(payload.catalog.path).toBe(candidate);
    expect(payload.catalog.pathSource).toBe('candidate');
    expect(payload.catalog.catalogVersion).toBe('candidate-1');
    // Read-only: the candidate file is not copied over the configured one.
    expect(JSON.parse(readFileSync(catalogPath, 'utf8')).providers.openai.qualityBindings.light).toBe(
      'nope',
    );
  });

  test('a candidate that does not exist refuses with catalog-unreadable', async () => {
    const res = await run([
      'agent-profile',
      'validate',
      '--file',
      join(tmpDir, 'missing.json'),
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).findings[0].reason).toBe('catalog-unreadable');
  });

  test('capability discovery is informational: an unavailable CLI is not an invalid profile', async () => {
    // Every level of every provider is rebound to one profile naming a binary
    // that does not exist, so the probe answer is deterministic on any host.
    const binding = (name) => ({ light: name, normal: name, strong: name, maximum: name });
    writeCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: {
          profiles: { 'probe-test': { binary: join(tmpDir, 'no-such-claude') } },
          qualityBindings: binding('probe-test'),
        },
        openai: {
          // `binary` is not a built-in `openai` capability; declaring it is the
          // data edit §6.2 exists for, and the validator accepts it.
          capabilities: { binary: 'free' },
          profiles: { 'probe-test': { binary: join(tmpDir, 'no-such-codex') } },
          qualityBindings: binding('probe-test'),
        },
        google: {
          profiles: { 'probe-test': { binary: join(tmpDir, 'no-such-agy') } },
          qualityBindings: binding('probe-test'),
        },
      },
    });
    const res = await run([
      'agent-profile',
      'validate',
      '--probe',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.findings).toEqual([]);
    expect(payload.capabilityDiscovery.probed).toBe(true);
    expect(payload.capabilityDiscovery.results.map((r) => r.provider).sort()).toEqual([
      'anthropic',
      'google',
      'openai',
    ]);
    for (const entry of payload.capabilityDiscovery.results) {
      expect(entry.status).toBe('unavailable');
      expect(entry.version).toBeNull();
    }
  }, 30_000);

  test('human output separates the verdict from capability discovery', async () => {
    const res = await run(['agent-profile', 'validate', '--sessions-path', sessionsPath]);
    expect(res.code).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow();
    expect(res.stdout).toContain('Agent profile catalog: OK.');
    expect(res.stdout).toContain('checked: 3 provider(s)');
    expect(res.stdout).toContain('capability discovery: not probed');
  });

  test('human failure output names the reason and the offending target', async () => {
    writeCatalog({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-strong': { effort: 'turbo' } } } },
    });
    const res = await run(['agent-profile', 'validate', '--sessions-path', sessionsPath]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('error: [unsupported-value]');
    expect(res.stdout).toContain('turbo');
  });
});

// ---------------------------------------------------------------------------
// Shared CLI contract
// ---------------------------------------------------------------------------

describe('admin agent-profile option and dispatch contract', () => {
  test.each([
    ['list', ['agent-profile', 'list', '--dry-ru', 'x']],
    ['show', ['agent-profile', 'show', 'claude', '--quali', 'strong']],
    ['validate', ['agent-profile', 'validate', '--prob']],
  ])('%s rejects an unknown or abbreviated option instead of ignoring it', async (_name, args) => {
    const res = await run([...args, '--sessions-path', sessionsPath, '--json']);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toContain('Unknown option:');
  });

  test('a value flag missing its value is rejected', async () => {
    const res = await run([
      'agent-profile',
      'show',
      'claude',
      '--quality',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toContain('--quality requires a value');
  });

  test('--session-id and --session-ref are mutually exclusive', async () => {
    const res = await run([
      'agent-profile',
      'list',
      '--session-id',
      'addon-dev',
      '--session-ref',
      'addon-dev',
      '--sessions-path',
      sessionsPath,
      '--json',
    ]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toContain(
      'Provide only one of --session-id or --session-ref, not both',
    );
  });

  test('an unknown action names the four that exist', async () => {
    const res = await run(['agent-profile', 'bogus']);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toBe(
      'Unknown agent-profile action: bogus. Expected: list | show | validate | refresh',
    );
  });

  test('a missing action reports (none)', async () => {
    const res = await run(['agent-profile']);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toContain('Unknown agent-profile action: (none)');
  });

  test('all three commands are read-only', async () => {
    writeCatalog({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'fable' } } } },
    });
    const catalogBefore = readFileSync(catalogPath, 'utf8');
    const sessionsBefore = readFileSync(sessionsPath, 'utf8');
    await run(['agent-profile', 'list', '--sessions-path', sessionsPath]);
    await run(['agent-profile', 'show', 'claude', '--sessions-path', sessionsPath]);
    await run(['agent-profile', 'validate', '--sessions-path', sessionsPath]);
    expect(readFileSync(catalogPath, 'utf8')).toBe(catalogBefore);
    expect(readFileSync(sessionsPath, 'utf8')).toBe(sessionsBefore);
  });

  test('every command appears in admin help with its options', async () => {
    const res = await run(['help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('agent-profile list');
    expect(res.stdout).toContain('agent-profile show');
    expect(res.stdout).toContain('agent-profile validate');

    const one = await run(['help', 'agent-profile show']);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain('--quality <level>');
  });
});
