/**
 * Agent runtime adapter contract and provider registry (issue #906, the
 * boundary piece of slice B3 of docs/agent-runtime-profiles-contract.md
 * §14.1).
 *
 * The slice lands the contract, not a provider: every adapter below is a test
 * adapter injected through the registry, and no real CLI is ever invoked. So
 * what these cover is the boundary itself — that the registry fails closed
 * for unknown and unavailable agents (compensating for the shipped fail-open
 * agent→provider mapping), that §8.1's precedence chain holds with env
 * overrides field-level and pins profile-level, that every malformed or
 * unsupported override refuses with an actionable §12.2 reason before any
 * invocation, that the §13.2 metadata reports what resolved and why (absence
 * as absence, shared bindings visible, catalog digest attached), that the
 * sanitation gate keeps prompts verbatim on their declared channel and argv
 * control-character free, that discovery preserves issue #897's
 * determinate/transient split, and that unsupported configuration is
 * distinguishable from transient execution failure by type alone.
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  AGENT_RUNTIME_DISCOVERY_STATUSES,
  AGENT_PROFILE_REFUSAL_REASONS,
  AgentProfileCatalogError,
  AgentQualityError,
  AgentRuntimeAdapterError,
  AgentRuntimeContractViolationError,
  BUDGET_APPLICATIONS,
  INVOCATION_PROTECTED_ENV_KEYS,
  PROMPT_DELIVERIES,
  QUALITY_LEVELS,
  QUALITY_PIN_CONTEXT_KEY,
  RUNTIME_PROFILE_PIN_CONTEXT_KEY,
  RUNTIME_PROFILE_SOURCES,
  RUNTIME_SETTING_SOURCES,
  assertSanitizedInvocationPlan,
  buildEffectiveAgentProfileCatalog,
  createAgentRuntimeAdapterRegistry,
  interpretDiscoveryProbe,
  isAgentProfileRefusalReason,
  isAgentRuntimeConfigurationError,
  planAgentInvocation,
  readRuntimeProfilePin,
  resolveAgentRuntime,
  sessionPinnedProfileFor,
} from '../dist/index.js';
import { MAX_PROBE_DETAIL_CHARS } from '../dist/core/cli-probe.js';
import {
  CWD_BEARING_ENV_KEYS,
  WRITE_ENABLING_ENV_KEYS,
} from '../dist/handlers/agent-isolation.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The effective built-in catalog, exactly as a phase-start load with no overlay sees it. */
const CATALOG = buildEffectiveAgentProfileCatalog(undefined);

function quality(level, source = 'default') {
  return { quality: level, source, requested: { quality: level, source } };
}

function claudeStyleAdapter(overrides = {}) {
  return {
    provider: 'anthropic',
    defaultBinary: 'claude',
    envOverrides: [
      { setting: 'model', variable: 'CLAUDE_MODEL' },
      { setting: 'effort', variable: 'CLAUDE_EFFORT' },
      { setting: 'budget', variable: 'CLAUDE_MAX_BUDGET_USD' },
    ],
    buildInvocation(request, resolved) {
      const args = ['-p'];
      if (resolved.model.value !== undefined) args.push('--model', resolved.model.value);
      if (resolved.effort.value !== undefined) args.push('--effort', resolved.effort.value);
      if (resolved.budget.value !== undefined) args.push('--max-budget-usd', resolved.budget.value);
      return {
        command: resolved.binary.value,
        args,
        promptDelivery: request.prompt === undefined ? 'none' : 'stdin',
        ...(request.prompt === undefined ? {} : { stdin: request.prompt }),
        ...(resolved.budget.value !== undefined ? { budgetApplied: 'applied' } : {}),
      };
    },
    ...overrides,
  };
}

function codexStyleAdapter(overrides = {}) {
  return {
    provider: 'openai',
    defaultBinary: 'codex',
    envOverrides: [
      { setting: 'model', variable: 'CODEX_MODEL' },
      { setting: 'effort', variable: 'CODEX_EFFORT' },
    ],
    buildInvocation(request, resolved) {
      // The existing positioning rule: a model is a GLOBAL option spliced
      // before the subcommand; -c overrides go after it. An absent model
      // passes no flag at all (§7).
      const args = [];
      if (resolved.model.value !== undefined) args.push('--model', resolved.model.value);
      args.push('exec');
      if (resolved.effort.value !== undefined) {
        args.push('-c', `model_reasoning_effort=${resolved.effort.value}`);
      }
      return {
        command: resolved.binary.value,
        args,
        promptDelivery: request.prompt === undefined ? 'none' : 'stdin',
        ...(request.prompt === undefined ? {} : { stdin: request.prompt }),
      };
    },
    ...overrides,
  };
}

function agyStyleAdapter(overrides = {}) {
  return {
    provider: 'google',
    defaultBinary: 'agy',
    envOverrides: [{ setting: 'binary', variable: 'ANTIGRAVITY_BIN' }],
    buildInvocation(request, resolved) {
      const args = ['--print'];
      if (resolved.providerOptions.printTimeout !== undefined) {
        args.push('--print-timeout', resolved.providerOptions.printTimeout);
      }
      if (request.prompt !== undefined) args.push(request.prompt);
      return {
        command: resolved.binary.value,
        args,
        // Some builds of this CLI ignore stdin, so the prompt rides both
        // channels — declared, and verified by the gate.
        promptDelivery: request.prompt === undefined ? 'none' : 'stdin-and-argument',
        ...(request.prompt === undefined ? {} : { stdin: request.prompt }),
      };
    },
    ...overrides,
  };
}

/** Mirrors the shipped mapping's shape, including its fail-open default branch. */
function shippedLikeProviderForAgent(agentId) {
  switch (agentId) {
    case 'claude':
      return 'anthropic';
    case 'codex':
      return 'openai';
    case 'gemini':
      return 'google';
    default:
      return agentId;
  }
}

function makeRegistry(extra = {}) {
  return createAgentRuntimeAdapterRegistry({
    adapters: [claudeStyleAdapter(), codexStyleAdapter(), agyStyleAdapter()],
    providerForAgent: shippedLikeProviderForAgent,
    ...extra,
  });
}

function makeRequest(overrides = {}) {
  return {
    agentId: 'claude',
    lane: 'implementation',
    quality: quality('normal'),
    catalog: CATALOG,
    env: {},
    prompt: 'Do the work.',
    ...overrides,
  };
}

function captureError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectRefusal(fn, reason, match) {
  const err = captureError(fn);
  expect(err).toBeDefined();
  expect(err.name).toBe('AgentRuntimeAdapterError');
  expect(err.reason).toBe(reason);
  if (match) expect(err.message).toMatch(match);
  return err;
}

function expectViolation(fn, match) {
  const err = captureError(fn);
  expect(err).toBeDefined();
  expect(err.name).toBe('AgentRuntimeContractViolationError');
  if (match) expect(err.message).toMatch(match);
  return err;
}

describe('vocabularies', () => {
  test('the closed vocabularies are exactly the contract-owned ones', () => {
    expect(RUNTIME_SETTING_SOURCES).toEqual([
      'env',
      'catalog-overlay',
      'catalog-builtin',
      'cli-default',
      'default',
      'not-applicable',
    ]);
    expect(RUNTIME_PROFILE_SOURCES).toEqual([
      'task-pin',
      'session-config',
      'catalog-overlay',
      'catalog-builtin',
    ]);
    expect(PROMPT_DELIVERIES).toEqual(['stdin', 'argument', 'stdin-and-argument', 'none']);
    expect(BUDGET_APPLICATIONS).toEqual(['applied', 'not-applicable']);
    expect(AGENT_RUNTIME_DISCOVERY_STATUSES).toEqual(['available', 'unavailable', 'indeterminate']);
  });

  test('the runtime profile pin key is its own key, beside the quality pin', () => {
    expect(RUNTIME_PROFILE_PIN_CONTEXT_KEY).toBe('runtimeProfilePin');
    expect(RUNTIME_PROFILE_PIN_CONTEXT_KEY).not.toBe(QUALITY_PIN_CONTEXT_KEY);
  });

  test('the protected env keys are the isolation-owned ones', () => {
    expect(INVOCATION_PROTECTED_ENV_KEYS).toEqual([
      // Pinned by the isolation layer.
      'HOME',
      'GH_CONFIG_DIR',
      'XDG_CONFIG_HOME',
      'PATH',
      // Stripped write-enabling credentials.
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'GH_APP_ID',
      'GH_INSTALLATION_TOKEN',
      'GITHUB_APP_TOKEN',
      'GITHUB_CLIENT_SECRET',
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      // Stripped checkout-path variables.
      'PWD',
      'OLDPWD',
      'INIT_CWD',
      'npm_config_local_prefix',
      'npm_package_json',
    ]);
  });

  test('the protected env keys cover every key the isolation layer strips', () => {
    // The names are restated in core/ (the import direction is reserved:
    // handlers import core's list, never the reverse), so this superset pin
    // is what keeps the restatement from drifting as the strip lists grow.
    for (const key of [...WRITE_ENABLING_ENV_KEYS, ...CWD_BEARING_ENV_KEYS]) {
      expect(INVOCATION_PROTECTED_ENV_KEYS).toContain(key);
    }
  });
});

describe('registry — fail-closed adapter lookup', () => {
  test('resolves a known agent through the injected mapping', () => {
    const registry = makeRegistry();
    expect(registry.adapterForAgent('claude').provider).toBe('anthropic');
    expect(registry.adapterForAgent('codex').provider).toBe('openai');
    expect(registry.adapterForAgent('gemini').provider).toBe('google');
    expect(registry.providers).toEqual(['anthropic', 'google', 'openai']);
  });

  test('an unknown agent the fail-open mapping echoes back refuses', () => {
    const registry = makeRegistry();
    const err = expectRefusal(
      () => registry.adapterForAgent('mystery-agent'),
      'unknown-provider',
      /mystery-agent/,
    );
    expect(err.message).toMatch(/echoed/);
    expect(err.message).toMatch(/does not name a registered agent/);
  });

  test('an unknown agent id that collides with a registered provider key still refuses', () => {
    // The fail-open mapping echoes 'openai' back as its own provider, and an
    // adapter IS registered under that key — the echo must refuse before the
    // adapter table is consulted, or the invalid assignment builds an
    // invocation.
    const registry = makeRegistry();
    expectRefusal(() => registry.adapterForAgent('openai'), 'unknown-provider', /echoed/);
    expectRefusal(() => registry.adapterForAgent('anthropic'), 'unknown-provider', /echoed/);
    expect(registry.hasAdapterForAgent('openai')).toBe(false);
    expect(registry.hasAdapterForAgent('anthropic')).toBe(false);
    expect(registry.hasAdapterForAgent('google')).toBe(false);
    expectRefusal(
      () => planAgentInvocation(registry, makeRequest({ agentId: 'openai' })),
      'unknown-provider',
    );
  });

  test('a blank agent id refuses rather than resolving anything', () => {
    const registry = makeRegistry();
    expectRefusal(() => registry.adapterForAgent(''), 'unknown-provider', /assignment/);
    expectRefusal(() => registry.adapterForAgent('   '), 'unknown-provider');
  });

  test('a mapping that returns nothing refuses', () => {
    const registry = makeRegistry({ providerForAgent: () => '' });
    expectRefusal(() => registry.adapterForAgent('claude'), 'unknown-provider', /returned nothing/);
  });

  test('adapterForProvider refuses an unregistered provider and names the registered ones', () => {
    const registry = makeRegistry();
    expectRefusal(
      () => registry.adapterForProvider('acme'),
      'unknown-provider',
      /anthropic, google, openai/,
    );
    expectRefusal(() => registry.adapterForProvider(''), 'unknown-provider');
    expect(registry.adapterForProvider('google').provider).toBe('google');
  });

  test('lookups are own-property only', () => {
    const registry = makeRegistry();
    expectRefusal(() => registry.adapterForProvider('toString'), 'unknown-provider');
    const echoing = makeRegistry({ providerForAgent: () => 'constructor' });
    expectRefusal(() => echoing.adapterForAgent('claude'), 'unknown-provider');
  });

  test('hasAdapterForAgent answers without throwing', () => {
    const registry = makeRegistry();
    expect(registry.hasAdapterForAgent('claude')).toBe(true);
    expect(registry.hasAdapterForAgent('mystery-agent')).toBe(false);
    expect(registry.hasAdapterForAgent('')).toBe(false);
  });

  test('an empty registry refuses every lookup', () => {
    const registry = createAgentRuntimeAdapterRegistry({
      adapters: [],
      providerForAgent: shippedLikeProviderForAgent,
    });
    expectRefusal(() => registry.adapterForAgent('claude'), 'unknown-provider', /none/);
  });

  test('registration defects throw contract violations at the composition root', () => {
    const make = (adapters) =>
      createAgentRuntimeAdapterRegistry({ adapters, providerForAgent: shippedLikeProviderForAgent });

    expectViolation(() => make([claudeStyleAdapter(), claudeStyleAdapter()]), /two adapters/);
    expectViolation(() => make([claudeStyleAdapter({ provider: 'Anthropic' })]), /not a valid provider key/);
    expectViolation(() => make([claudeStyleAdapter({ provider: 'claude' })]), /agent id, not a provider/);
    expectViolation(() => make([claudeStyleAdapter({ defaultBinary: '' })]), /defaultBinary/);
    expectViolation(() => make([claudeStyleAdapter({ buildInvocation: undefined })]), /buildInvocation/);
    expectViolation(
      () =>
        make([
          claudeStyleAdapter({
            envOverrides: [
              { setting: 'model', variable: 'A_MODEL' },
              { setting: 'model', variable: 'B_MODEL' },
            ],
          }),
        ]),
      /two env overrides/,
    );
    expectViolation(
      () =>
        make([
          claudeStyleAdapter({
            envOverrides: [
              { setting: 'model', variable: 'SAME_VAR' },
              { setting: 'effort', variable: 'SAME_VAR' },
            ],
          }),
        ]),
      /declared for two settings/,
    );
    expectViolation(
      () => make([claudeStyleAdapter({ envOverrides: [{ setting: 'model', variable: 'lower_case' }] })]),
      /not a valid environment variable name/,
    );
    expectViolation(
      () =>
        make([claudeStyleAdapter({ envOverrides: [{ setting: 'providerOptions', variable: 'X_OPTS' }] })]),
      /not an env-overridable setting/,
    );
    expectViolation(
      () => make([claudeStyleAdapter({ discovery: { args: [], parse: undefined } })]),
      /discovery/,
    );
    expectViolation(
      () => createAgentRuntimeAdapterRegistry({ adapters: [], providerForAgent: undefined }),
      /injected providerForAgent/,
    );
  });
});

describe('resolution — §8.1 precedence and §13.2 metadata', () => {
  test('the quality binding answers when nothing pins or overrides', () => {
    const resolved = resolveAgentRuntime(claudeStyleAdapter(), {
      agentId: 'claude',
      quality: quality('normal'),
      catalog: CATALOG,
      env: {},
    });
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.profileName).toBe('claude-normal');
    expect(resolved.profileSource).toBe('catalog-builtin');
    expect(resolved.sharedWithQualityLevels).toEqual([]);
    expect(resolved.model).toEqual({ value: 'sonnet', source: 'catalog-builtin' });
    expect(resolved.effort).toEqual({ value: 'high', source: 'catalog-builtin' });
    expect(resolved.budget).toEqual({ value: '5', source: 'catalog-builtin' });
    expect(resolved.binary).toEqual({ value: 'claude', source: 'default' });
    expect(resolved.catalogSource).toBe('builtin');
    expect(resolved.catalogVersion).toBe('builtin-2026-09-07');
    expect(resolved.catalogDigest).toMatch(/^sha256:/);
  });

  test('reproduces the §13.2 record example: a maximum request answered by a shared profile', () => {
    const resolved = resolveAgentRuntime(codexStyleAdapter(), {
      agentId: 'codex',
      quality: quality('maximum', 'compat-label'),
      catalog: CATALOG,
      env: {},
    });
    expect(resolved.profileName).toBe('codex-high');
    expect(resolved.sharedWithQualityLevels).toEqual(['normal', 'strong']);
    // Absence is absence (§13.3): no model value, never the string "default".
    expect(resolved.model.value).toBeUndefined();
    expect(resolved.model.source).toBe('cli-default');
    expect(resolved.effort).toEqual({ value: 'high', source: 'catalog-builtin' });
    expect(resolved.budget.value).toBeUndefined();
    expect(resolved.budget.source).toBe('not-applicable');
    expect(resolved.binary).toEqual({ value: 'codex', source: 'default' });
  });

  test('a provider without an effort capability resolves it not-applicable', () => {
    const resolved = resolveAgentRuntime(agyStyleAdapter(), {
      agentId: 'gemini',
      quality: quality('strong'),
      catalog: CATALOG,
      env: {},
    });
    expect(resolved.effort.source).toBe('not-applicable');
    expect(resolved.providerOptions).toEqual({ printTimeout: '15m' });
    expect(resolved.providerOptionSources.printTimeout).toBe('catalog-builtin');
  });

  test('an env override is field-level: it moves one setting and leaves the rest', () => {
    const resolved = resolveAgentRuntime(claudeStyleAdapter(), {
      agentId: 'claude',
      quality: quality('normal'),
      catalog: CATALOG,
      env: { CLAUDE_EFFORT: 'low' },
    });
    expect(resolved.effort).toEqual({ value: 'low', source: 'env' });
    expect(resolved.model).toEqual({ value: 'sonnet', source: 'catalog-builtin' });
    expect(resolved.budget).toEqual({ value: '5', source: 'catalog-builtin' });
  });

  test('env override values are trimmed before validation', () => {
    const resolved = resolveAgentRuntime(claudeStyleAdapter(), {
      agentId: 'claude',
      quality: quality('normal'),
      catalog: CATALOG,
      env: { CLAUDE_MODEL: '  opus  ' },
    });
    expect(resolved.model).toEqual({ value: 'opus', source: 'env' });
  });

  test('a binary env override wins over the adapter default', () => {
    const resolved = resolveAgentRuntime(agyStyleAdapter(), {
      agentId: 'gemini',
      quality: quality('normal'),
      catalog: CATALOG,
      env: { ANTIGRAVITY_BIN: '/opt/tools/agy nightly' },
    });
    expect(resolved.binary).toEqual({ value: '/opt/tools/agy nightly', source: 'env' });
  });

  test('the escalated per-run level resolves its own binding, request intact', () => {
    const escalated = {
      quality: 'strong',
      source: 'escalation',
      requested: { quality: 'normal', source: 'default' },
      escalationFloor: 'strong',
    };
    const resolved = resolveAgentRuntime(claudeStyleAdapter(), {
      agentId: 'claude',
      quality: escalated,
      catalog: CATALOG,
      env: {},
    });
    expect(resolved.profileName).toBe('claude-strong');
    expect(resolved.quality).toBe(escalated);
  });

  test('an overlay-supplied value is reported as catalog-overlay with a new digest', () => {
    const overlaid = buildEffectiveAgentProfileCatalog({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'fable' } } } },
    });
    const resolved = resolveAgentRuntime(claudeStyleAdapter(), {
      agentId: 'claude',
      quality: quality('strong'),
      catalog: overlaid,
      env: {},
    });
    expect(resolved.model).toEqual({ value: 'fable', source: 'catalog-overlay' });
    expect(resolved.effort).toEqual({ value: 'high', source: 'catalog-builtin' });
    expect(resolved.catalogSource).toBe('file');
    expect(resolved.catalogDigest).not.toBe(CATALOG.digest);
  });

  test('a provider the catalog does not declare refuses through the catalog gate', () => {
    const err = captureError(() =>
      resolveAgentRuntime(claudeStyleAdapter({ provider: 'acme', defaultBinary: 'acme' }), {
        agentId: 'claude',
        quality: quality('normal'),
        catalog: CATALOG,
        env: {},
      }),
    );
    expect(err.name).toBe('AgentProfileCatalogError');
    expect(err.reason).toBe('unknown-provider');
    expect(isAgentRuntimeConfigurationError(err)).toBe(true);
  });

  test('a malformed per-run quality refuses rather than defaulting', () => {
    expectRefusal(
      () =>
        resolveAgentRuntime(claudeStyleAdapter(), {
          agentId: 'claude',
          quality: { quality: 'ultra', source: 'default', requested: { quality: 'ultra', source: 'default' } },
          catalog: CATALOG,
          env: {},
        }),
      'invalid-quality-request',
      /ultra/,
    );
  });
});

describe('resolution — pins (§8.1 layers 2–3)', () => {
  test('a task pin replaces the binding lookup outright', () => {
    const resolved = resolveAgentRuntime(claudeStyleAdapter(), {
      agentId: 'claude',
      quality: quality('normal'),
      catalog: CATALOG,
      env: {},
      taskPinnedProfile: 'claude-maximum',
    });
    expect(resolved.profileName).toBe('claude-maximum');
    expect(resolved.profileSource).toBe('task-pin');
    expect(resolved.model).toEqual({ value: 'fable', source: 'catalog-builtin' });
    expect(resolved.sharedWithQualityLevels).toEqual(['maximum']);
  });

  test('a session pin applies when no task pin does, and loses to a task pin', () => {
    const base = {
      agentId: 'claude',
      quality: quality('normal'),
      catalog: CATALOG,
      env: {},
    };
    const session = resolveAgentRuntime(claudeStyleAdapter(), {
      ...base,
      sessionPinnedProfile: 'claude-light',
    });
    expect(session.profileName).toBe('claude-light');
    expect(session.profileSource).toBe('session-config');

    const both = resolveAgentRuntime(claudeStyleAdapter(), {
      ...base,
      taskPinnedProfile: 'claude-maximum',
      sessionPinnedProfile: 'claude-light',
    });
    expect(both.profileName).toBe('claude-maximum');
    expect(both.profileSource).toBe('task-pin');
  });

  test('an env override still beats a pinned profile, field by field', () => {
    const resolved = resolveAgentRuntime(claudeStyleAdapter(), {
      agentId: 'claude',
      quality: quality('normal'),
      catalog: CATALOG,
      env: { CLAUDE_MODEL: 'opus' },
      taskPinnedProfile: 'claude-light',
    });
    expect(resolved.profileName).toBe('claude-light');
    expect(resolved.model).toEqual({ value: 'opus', source: 'env' });
    expect(resolved.effort).toEqual({ value: 'low', source: 'catalog-builtin' });
  });

  test('a pinned profile shared by declared bindings reports every level that binds it', () => {
    const resolved = resolveAgentRuntime(codexStyleAdapter(), {
      agentId: 'codex',
      quality: quality('light'),
      catalog: CATALOG,
      env: {},
      taskPinnedProfile: 'codex-high',
    });
    expect(resolved.profileName).toBe('codex-high');
    expect(resolved.sharedWithQualityLevels).toEqual(['normal', 'strong', 'maximum']);
  });

  test('a pin naming an undeclared profile refuses and lists the declared ones', () => {
    expectRefusal(
      () =>
        resolveAgentRuntime(claudeStyleAdapter(), {
          agentId: 'claude',
          quality: quality('normal'),
          catalog: CATALOG,
          env: {},
          taskPinnedProfile: 'claude-strong-2020',
        }),
      'unknown-profile',
      /claude-light, claude-maximum, claude-normal, claude-strong/,
    );
  });

  test('a malformed pin refuses instead of falling through to the binding', () => {
    expectRefusal(
      () =>
        resolveAgentRuntime(claudeStyleAdapter(), {
          agentId: 'claude',
          quality: quality('normal'),
          catalog: CATALOG,
          env: {},
          taskPinnedProfile: '   ',
        }),
      'invalid-override',
    );
    expectRefusal(
      () =>
        resolveAgentRuntime(claudeStyleAdapter(), {
          agentId: 'claude',
          quality: quality('normal'),
          catalog: CATALOG,
          env: {},
          sessionPinnedProfile: 'bad name!',
        }),
      'invalid-override',
      /session\.agentRuntime\.pins\.claude/,
    );
  });
});

describe('resolution — env override refusals (§12.2 invalid-override)', () => {
  const resolveWith = (adapter, env, overrides = {}) => () =>
    resolveAgentRuntime(adapter, {
      agentId: 'claude',
      quality: quality('normal'),
      catalog: CATALOG,
      env,
      ...overrides,
    });

  test('an empty override refuses rather than silently unsetting', () => {
    expectRefusal(resolveWith(claudeStyleAdapter(), { CLAUDE_MODEL: '' }), 'invalid-override', /CLAUDE_MODEL/);
    expectRefusal(resolveWith(claudeStyleAdapter(), { CLAUDE_EFFORT: '   ' }), 'invalid-override', /CLAUDE_EFFORT/);
  });

  test('an enumerated override outside the declared list refuses, never lowered (§12.3)', () => {
    const err = expectRefusal(
      resolveWith(codexStyleAdapter(), { CODEX_EFFORT: 'xhigh' }),
      'invalid-override',
      /CODEX_EFFORT/,
    );
    // Actionable: the declared values are in the message.
    expect(err.message).toMatch(/low, medium, high/);
  });

  test('a malformed budget override refuses', () => {
    expectRefusal(resolveWith(claudeStyleAdapter(), { CLAUDE_MAX_BUDGET_USD: 'ten' }), 'invalid-override');
    expectRefusal(resolveWith(claudeStyleAdapter(), { CLAUDE_MAX_BUDGET_USD: '0' }), 'invalid-override');
    expectRefusal(resolveWith(claudeStyleAdapter(), { CLAUDE_MAX_BUDGET_USD: '-5' }), 'invalid-override');
  });

  test('control characters and malformed whitespace refuse', () => {
    expectRefusal(resolveWith(claudeStyleAdapter(), { CLAUDE_MODEL: 'op\tus' }), 'invalid-override');
    expectRefusal(resolveWith(claudeStyleAdapter(), { CLAUDE_EFFORT: 'hi gh' }), 'invalid-override');
  });

  test('an override for a setting the provider does not declare refuses', () => {
    const adapter = codexStyleAdapter({
      envOverrides: [{ setting: 'budget', variable: 'X_CODEX_BUDGET' }],
    });
    expectRefusal(
      resolveWith(adapter, { X_CODEX_BUDGET: '5' }),
      'invalid-override',
      /does not accept the setting "budget"/,
    );
  });

  test('every refusal reason stays inside the closed §12.2 set', () => {
    const err = expectRefusal(resolveWith(claudeStyleAdapter(), { CLAUDE_MODEL: '' }), 'invalid-override');
    expect(isAgentProfileRefusalReason(err.reason)).toBe(true);
    expect(AGENT_PROFILE_REFUSAL_REASONS).toContain(err.reason);
  });
});

describe('invocation planning', () => {
  test('plans a stdin-prompt invocation end to end and freezes the plan', () => {
    const { resolved, invocation } = planAgentInvocation(makeRegistry(), makeRequest());
    expect(invocation.command).toBe('claude');
    expect(invocation.args).toEqual([
      '-p',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--max-budget-usd',
      '5',
    ]);
    expect(invocation.promptDelivery).toBe('stdin');
    expect(invocation.stdin).toBe('Do the work.');
    expect(invocation.budgetApplied).toBe('applied');
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.args)).toBe(true);
    expect(resolved.profileName).toBe('claude-normal');
  });

  test('a compatibility-mode plan passes no model flag at all', () => {
    const { invocation } = planAgentInvocation(
      makeRegistry(),
      makeRequest({ agentId: 'codex', lane: 'implementation' }),
    );
    expect(invocation.command).toBe('codex');
    expect(invocation.args).toEqual(['exec', '-c', 'model_reasoning_effort=high']);
    expect(invocation.budgetApplied).toBeUndefined();
  });

  test('a dual-channel prompt delivery carries the prompt verbatim on both', () => {
    const prompt = 'Line one.\n\nLine two, much longer.';
    const { invocation } = planAgentInvocation(
      makeRegistry(),
      makeRequest({ agentId: 'gemini', prompt }),
    );
    expect(invocation.promptDelivery).toBe('stdin-and-argument');
    expect(invocation.stdin).toBe(prompt);
    expect(invocation.args[invocation.args.length - 1]).toBe(prompt);
  });

  test('a promptless request plans a promptless invocation', () => {
    const { invocation } = planAgentInvocation(makeRegistry(), makeRequest({ prompt: undefined }));
    expect(invocation.promptDelivery).toBe('none');
    expect(invocation.stdin).toBeUndefined();
  });

  test('a lane refusal from the adapter surfaces as the adapter threw it', () => {
    const adapter = claudeStyleAdapter({
      buildInvocation() {
        throw new AgentRuntimeAdapterError('unsupported-setting', 'this adapter serves no such lane');
      },
    });
    const registry = createAgentRuntimeAdapterRegistry({
      adapters: [adapter],
      providerForAgent: shippedLikeProviderForAgent,
    });
    expectRefusal(() => planAgentInvocation(registry, makeRequest()), 'unsupported-setting');
  });

  test('an untyped adapter throw normalizes into a contract violation', () => {
    // No invocation was built, so the failure must classify as
    // configuration-side through the exported classifier — an untyped throw
    // escaping unchanged would be unrecognizable at the boundary.
    const defect = new TypeError('resolved.model.value is not iterable');
    const registry = createAgentRuntimeAdapterRegistry({
      adapters: [
        claudeStyleAdapter({
          buildInvocation() {
            throw defect;
          },
        }),
      ],
      providerForAgent: shippedLikeProviderForAgent,
    });
    const err = expectViolation(
      () => planAgentInvocation(registry, makeRequest()),
      /buildInvocation threw TypeError: resolved\.model\.value is not iterable/,
    );
    expect(isAgentRuntimeConfigurationError(err)).toBe(true);
    expect(err.cause).toBe(defect);
  });

  test('a malformed request is a contract violation', () => {
    expectViolation(() => planAgentInvocation(makeRegistry(), makeRequest({ lane: '' })), /names no lane/);
    expectViolation(() => planAgentInvocation(makeRegistry(), makeRequest({ prompt: 42 })), /prompt/);
  });
});

describe('the sanitation gate', () => {
  function planWith(buildInvocation, requestOverrides = {}) {
    const registry = createAgentRuntimeAdapterRegistry({
      adapters: [claudeStyleAdapter({ buildInvocation })],
      providerForAgent: shippedLikeProviderForAgent,
    });
    return () => planAgentInvocation(registry, makeRequest(requestOverrides));
  }
  const okBase = (request, resolved) => ({
    command: resolved.binary.value,
    args: ['-p'],
    promptDelivery: 'stdin',
    stdin: request.prompt,
    budgetApplied: 'not-applicable',
  });

  test('a well-formed plan passes', () => {
    expect(planWith((request, resolved) => okBase(request, resolved))()).toBeDefined();
  });

  test('the command must be the resolved binary', () => {
    expectViolation(
      planWith((request, resolved) => ({ ...okBase(request, resolved), command: 'bash' })),
      /not the resolved binary/,
    );
    expectViolation(planWith((request, resolved) => ({ ...okBase(request, resolved), command: '' })));
  });

  test('argv control characters refuse — except the declared prompt element', () => {
    expectViolation(
      planWith((request, resolved) => ({ ...okBase(request, resolved), args: ['-p', 'a\nb'] })),
      /control characters/,
    );
    // The same multi-line content is fine when it IS the prompt, declared.
    const prompt = 'multi\nline prompt';
    const plan = planWith(
      (request, resolved) => ({
        command: resolved.binary.value,
        args: ['--print', request.prompt],
        promptDelivery: 'stdin-and-argument',
        stdin: request.prompt,
        budgetApplied: 'not-applicable',
      }),
      { prompt },
    )();
    expect(plan.invocation.args[1]).toBe(prompt);
  });

  test('the prompt cannot be dropped, mutated, or silently migrated', () => {
    expectViolation(
      planWith((request, resolved) => ({ ...okBase(request, resolved), promptDelivery: 'none', stdin: undefined })),
      /delivers none/,
    );
    expectViolation(
      planWith((request, resolved) => ({ ...okBase(request, resolved), stdin: 'a summary of the prompt' })),
      /verbatim/,
    );
    expectViolation(
      planWith((request, resolved) => ({
        ...okBase(request, resolved),
        promptDelivery: 'argument',
        stdin: request.prompt,
      })),
      /stdin must be absent/,
    );
    expectViolation(
      planWith((request, resolved) => ({
        ...okBase(request, resolved),
        promptDelivery: 'argument',
        stdin: undefined,
      })),
      /one argv element/,
    );
    expectViolation(
      planWith((request, resolved) => ({ ...okBase(request, resolved), promptDelivery: 'sideband' })),
      /not a prompt delivery/,
    );
    // Dual-channel in fact, stdin-only on paper: a single-line prompt carries
    // no control characters, so only the channel check can refuse the
    // undeclared argv copy.
    expectViolation(
      planWith((request, resolved) => ({
        ...okBase(request, resolved),
        args: ['-p', request.prompt],
      })),
      /declares no argument channel/,
    );
  });

  test('a promptless request forbids prompt channels', () => {
    expectViolation(
      planWith(
        (request, resolved) => ({
          command: resolved.binary.value,
          args: [],
          promptDelivery: 'stdin',
          stdin: 'invented prompt',
          budgetApplied: 'not-applicable',
        }),
        { prompt: undefined },
      ),
      /carries no prompt/,
    );
  });

  test('env additions are validated and protected keys refuse', () => {
    expectViolation(
      planWith((request, resolved) => ({ ...okBase(request, resolved), env: { HOME: '/tmp/x' } })),
      /owned by the isolation layer/,
    );
    expectViolation(
      planWith((request, resolved) => ({ ...okBase(request, resolved), env: { 'BAD=KEY': 'x' } })),
      /not a valid environment variable name/,
    );
    expectViolation(
      planWith((request, resolved) => ({ ...okBase(request, resolved), env: { GOOD_FLAG: 'a\nb' } })),
      /without control characters/,
    );
    const plan = planWith((request, resolved) => ({
      ...okBase(request, resolved),
      env: { PROVIDER_FLAG: 'on' },
    }))();
    expect(plan.invocation.env).toEqual({ PROVIDER_FLAG: 'on' });
    expect(Object.isFrozen(plan.invocation.env)).toBe(true);
  });

  test('additions naming a stripped credential or checkout-path variable refuse', () => {
    // These are exactly the keys buildIsolatedInvocation deletes from the
    // child environment; an addition layered back in would undo the strip.
    for (const [key, value] of [
      ['GH_TOKEN', 'secret'],
      ['GITHUB_TOKEN', 'secret'],
      ['ACTIONS_RUNTIME_TOKEN', 'secret'],
      ['INIT_CWD', '/real/checkout'],
      ['npm_config_local_prefix', '/real/checkout'],
    ]) {
      expectViolation(
        planWith((request, resolved) => ({ ...okBase(request, resolved), env: { [key]: value } })),
        /owned by the isolation layer/,
      );
    }
  });

  test('credential-shaped additions refuse without being enumerated', () => {
    // Provider API keys are not (and cannot be) named by this
    // provider-neutral module; the shape rule is what refuses them.
    for (const key of [
      'SOME_PROVIDER_API_KEY',
      'MY_AUTH_TOKEN',
      'X_CLIENT_SECRET',
      'DB_PASSWORD',
      'SERVICE_APIKEY',
      'lowercase_api_key',
    ]) {
      expectViolation(
        planWith((request, resolved) => ({ ...okBase(request, resolved), env: { [key]: 'v' } })),
        /credential-shaped/,
      );
    }
    // The final segment decides: KEY inside a word is not a credential shape.
    const plan = planWith((request, resolved) => ({
      ...okBase(request, resolved),
      env: { TURNKEY_MODE: 'on', TURNKEY: 'on' },
    }))();
    expect(plan.invocation.env).toEqual({ TURNKEY_MODE: 'on', TURNKEY: 'on' });
  });

  test('a resolved budget must be declared applied or not-applicable (§7 rule 1)', () => {
    expectViolation(
      planWith((request, resolved) => {
        const plan = okBase(request, resolved);
        delete plan.budgetApplied;
        return plan;
      }),
      /never drop it in silence/,
    );
    // And the inverse: declaring one with no budget resolved is a lie.
    const registry = createAgentRuntimeAdapterRegistry({
      adapters: [
        codexStyleAdapter({
          buildInvocation(request, resolved) {
            return {
              command: resolved.binary.value,
              args: ['exec'],
              promptDelivery: 'stdin',
              stdin: request.prompt,
              budgetApplied: 'applied',
            };
          },
        }),
      ],
      providerForAgent: shippedLikeProviderForAgent,
    });
    expectViolation(
      () => planAgentInvocation(registry, makeRequest({ agentId: 'codex' })),
      /absent when no budget resolved/,
    );
  });

  test('the gate is exported for adapters to test their own plans against', () => {
    const resolved = resolveAgentRuntime(claudeStyleAdapter(), {
      agentId: 'claude',
      quality: quality('normal'),
      catalog: CATALOG,
      env: {},
    });
    const request = makeRequest();
    expect(() =>
      assertSanitizedInvocationPlan(
        {
          command: 'claude',
          args: ['-p'],
          promptDelivery: 'stdin',
          stdin: request.prompt,
          budgetApplied: 'applied',
        },
        request,
        resolved,
      ),
    ).not.toThrow();
  });
});

describe('discovery — probe interpretation (issue #897 split preserved)', () => {
  const spec = {
    args: ['--version'],
    parse(stdout) {
      const version = stdout.trim().split(/\s+/).pop();
      return { version, capabilities: { banner: 'parsed' } };
    },
  };

  test('a successful probe is available, with parsed version and capabilities', () => {
    const discovery = interpretDiscoveryProbe(spec, {
      ok: true,
      status: 'available',
      transient: false,
      output: 'example-cli 2.1.0',
    });
    expect(discovery).toEqual({
      status: 'available',
      version: '2.1.0',
      capabilities: { banner: 'parsed' },
    });
  });

  test('a determinate failure is unavailable', () => {
    for (const status of ['not-found', 'non-zero-exit']) {
      const discovery = interpretDiscoveryProbe(spec, {
        ok: false,
        status,
        transient: false,
        output: 'no such command',
      });
      expect(discovery.status).toBe('unavailable');
      expect(discovery.detail).toBe('no such command');
    }
  });

  test('a transient outcome is indeterminate, never recorded as unavailable', () => {
    for (const status of ['timeout', 'spawn-error']) {
      const discovery = interpretDiscoveryProbe(spec, {
        ok: false,
        status,
        transient: true,
        output: 'spawn EAGAIN',
        code: 'EAGAIN',
      });
      expect(discovery.status).toBe('indeterminate');
    }
  });

  test('detail is bounded', () => {
    const discovery = interpretDiscoveryProbe(spec, {
      ok: false,
      status: 'non-zero-exit',
      transient: false,
      output: 'x'.repeat(MAX_PROBE_DETAIL_CHARS * 2),
    });
    expect(discovery.detail.length).toBe(MAX_PROBE_DETAIL_CHARS);
  });

  test('a throwing or malformed parser degrades to available-without-facts', () => {
    const throwing = interpretDiscoveryProbe(
      { args: ['--version'], parse: () => { throw new Error('nope'); } },
      { ok: true, status: 'available', transient: false, output: 'banner' },
    );
    expect(throwing.status).toBe('available');
    expect(throwing.version).toBeUndefined();
    expect(throwing.detail).toMatch(/could not be parsed/);

    const malformed = interpretDiscoveryProbe(
      { args: ['--version'], parse: () => ({ version: 42 }) },
      { ok: true, status: 'available', transient: false, output: 'banner' },
    );
    expect(malformed.status).toBe('available');
    expect(malformed.version).toBeUndefined();
    expect(malformed.detail).toMatch(/malformed/);
  });
});

describe('profile pin readers', () => {
  const task = (pin) => ({ context: pin === undefined ? {} : { [RUNTIME_PROFILE_PIN_CONTEXT_KEY]: pin } });

  test('reads the entry for this agent and ignores entries for others', () => {
    expect(readRuntimeProfilePin(task({ claude: 'claude-strong' }), 'claude')).toBe('claude-strong');
    expect(readRuntimeProfilePin(task({ claude: 'claude-strong' }), 'codex')).toBeUndefined();
    expect(readRuntimeProfilePin(task(undefined), 'claude')).toBeUndefined();
    expect(readRuntimeProfilePin(task(null), 'claude')).toBeUndefined();
  });

  test('a malformed pin record refuses instead of being skipped', () => {
    expectRefusal(() => readRuntimeProfilePin(task('claude-strong'), 'claude'), 'invalid-override');
    expectRefusal(() => readRuntimeProfilePin(task([]), 'claude'), 'invalid-override');
    expectRefusal(() => readRuntimeProfilePin(task({}), 'claude'), 'invalid-override', /pins nothing/);
    expectRefusal(() => readRuntimeProfilePin(task({ claude: '' }), 'claude'), 'invalid-override');
    expectRefusal(() => readRuntimeProfilePin(task({ claude: 42 }), 'claude'), 'invalid-override');
    expectRefusal(() => readRuntimeProfilePin(task({ claude: 'bad name!' }), 'claude'), 'invalid-override');
    // A sibling entry's corruption fails the whole record, not just its entry.
    expectRefusal(
      () => readRuntimeProfilePin(task({ claude: 'claude-strong', codex: 7 }), 'claude'),
      'invalid-override',
    );
  });

  test('session pins read the same shape under session.agentRuntime.pins', () => {
    expect(sessionPinnedProfileFor({ agentRuntime: { pins: { codex: 'codex-high' } } }, 'codex')).toBe(
      'codex-high',
    );
    expect(sessionPinnedProfileFor({ agentRuntime: {} }, 'codex')).toBeUndefined();
    expect(sessionPinnedProfileFor(undefined, 'codex')).toBeUndefined();
    expectRefusal(
      () => sessionPinnedProfileFor({ agentRuntime: { pins: 'codex-high' } }, 'codex'),
      'invalid-override',
      /session\.agentRuntime\.pins/,
    );
  });
});

describe('unsupported configuration vs transient execution failure', () => {
  test('every boundary error class is a configuration error', () => {
    expect(
      isAgentRuntimeConfigurationError(new AgentRuntimeAdapterError('invalid-override', 'x')),
    ).toBe(true);
    expect(isAgentRuntimeConfigurationError(new AgentRuntimeContractViolationError('x'))).toBe(true);
    expect(
      isAgentRuntimeConfigurationError(new AgentProfileCatalogError('catalog-invalid', 'x')),
    ).toBe(true);
    expect(
      isAgentRuntimeConfigurationError(new AgentQualityError('invalid-quality-request', 'x')),
    ).toBe(true);
  });

  test('execution-shaped failures are not configuration errors', () => {
    expect(isAgentRuntimeConfigurationError(new Error('spawn EAGAIN'))).toBe(false);
    expect(
      isAgentRuntimeConfigurationError(
        Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      ),
    ).toBe(false);
    expect(isAgentRuntimeConfigurationError(undefined)).toBe(false);
    expect(isAgentRuntimeConfigurationError('a string')).toBe(false);
  });

  test('recognition is by name, surviving a module-identity split', () => {
    const foreign = new Error('x');
    foreign.name = 'AgentRuntimeAdapterError';
    expect(isAgentRuntimeConfigurationError(foreign)).toBe(true);
  });
});

describe('module discipline', () => {
  const src = readFileSync(resolve(ROOT, 'src/core/agent-runtime-adapter.ts'), 'utf8');

  // Built from char codes so this test file itself never embeds a raw control
  // byte; tab, LF, and CR are the three that legitimately appear in source.
  function rawControlByteClass() {
    const c = String.fromCharCode;
    return new RegExp(`[${c(0)}-${c(8)}${c(11)}${c(12)}${c(14)}-${c(31)}${c(127)}]`);
  }

  test('the contract module never spawns a process', () => {
    expect(src).not.toMatch(/child_process|spawnSync|execFile|execSync/);
  });

  test('the contract module names no provider and takes no handler dependency', () => {
    expect(src).not.toMatch(/anthropic|openai|google/);
    expect(src).not.toMatch(/from "\.\.\/handlers\//);
  });

  test('the source carries no raw control bytes', () => {
    expect(src).not.toMatch(rawControlByteClass());
  });

  test('quality levels stay the single B1 vocabulary', () => {
    expect(QUALITY_LEVELS).toEqual(['light', 'normal', 'strong', 'maximum']);
  });
});
