/**
 * The Claude runtime profile adapter (issue #907) — the `anthropic` provider
 * adapter of slice B3 of docs/agent-runtime-profiles-contract.md §14.1.
 *
 * The boundary these plug into is pinned by test/agent-runtime-adapter.test.js
 * (#906); what is pinned here is the provider half:
 *
 *   - the four quality levels resolve through the `anthropic` bindings, and two
 *     levels bound to one profile is a declared configuration, not a downgrade;
 *   - the four Claude lanes produce exactly the argv the shipped handlers
 *     produce today, with the safety flags (permission mode, allowlist, the
 *     read-only boundary) a property of the lane and never of a profile;
 *   - the three break-glass variables override one field each, in the
 *     documented order, and are still capability-checked;
 *   - an absent model or effort passes no flag at all, and a budget a lane
 *     cannot express is declared `not-applicable`, never dropped;
 *   - every value the Claude CLI would misparse refuses BEFORE a billable run;
 *   - with no agent-profiles.json present the built-in catalog reproduces
 *     today's Claude implementation and review resolutions, and the two
 *     divergences the cutover still owes a before/after table are pinned as
 *     divergences rather than left to be discovered.
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  CLAUDE_CONFLICT_RESOLUTION_ALLOWED_TOOLS,
  CLAUDE_DEFAULT_BINARY,
  CLAUDE_DISCOVERY,
  CLAUDE_ENV_OVERRIDES,
  CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS,
  CLAUDE_LANES,
  CLAUDE_LANE_SPECS,
  CLAUDE_NO_TOOLS_ARGS,
  CLAUDE_PROVIDER,
  CLAUDE_RUNTIME_ADAPTER,
  QUALITY_LEVELS,
  buildEffectiveAgentProfileCatalog,
  createAgentRuntimeAdapterRegistry,
  createClaudeRuntimeAdapter,
  interpretDiscoveryProbe,
  isAgentRuntimeConfigurationError,
  isClaudeLane,
  planAgentInvocation,
  resolveAgentRuntime,
} from '../dist/index.js';
import { ARBITER_CLAUDE_NO_TOOLS_ARGS } from '../dist/core/review-arbiter-profile.js';
import { RECONSIDERATION_NO_TOOLS_ARGS } from '../dist/handlers/review-reconsideration.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The effective built-in catalog — exactly what a phase start with no overlay sees. */
const CATALOG = buildEffectiveAgentProfileCatalog(undefined);

/** The agent→provider mapping a composition root injects, in its fail-open shape. */
function providerForAgent(agentId) {
  if (agentId === 'claude') return 'anthropic';
  if (agentId === 'codex') return 'openai';
  if (agentId === 'gemini') return 'google';
  return agentId;
}

const REGISTRY = createAgentRuntimeAdapterRegistry({
  adapters: [CLAUDE_RUNTIME_ADAPTER],
  providerForAgent,
});

function quality(level, source = 'default') {
  return { quality: level, source, requested: { quality: level, source } };
}

function plan(overrides = {}) {
  return planAgentInvocation(REGISTRY, {
    agentId: 'claude',
    lane: 'implementation',
    quality: quality('normal'),
    catalog: CATALOG,
    env: {},
    ...overrides,
  });
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

/** A catalog whose anthropic profile carries one hand-planted setting value. */
function catalogWithAnthropicProfile(profileName, settings) {
  return buildEffectiveAgentProfileCatalog({
    schemaVersion: 1,
    providers: { anthropic: { profiles: { [profileName]: settings } } },
  });
}

describe('claude runtime adapter — provider identity (§3, §7.1)', () => {
  test('registers under the catalog provider key, never under an agent id', () => {
    expect(CLAUDE_PROVIDER).toBe('anthropic');
    expect(CLAUDE_RUNTIME_ADAPTER.provider).toBe('anthropic');
    expect(REGISTRY.providers).toEqual(['anthropic']);
    expect(REGISTRY.adapterForAgent('claude')).toBe(CLAUDE_RUNTIME_ADAPTER);
    expect(REGISTRY.hasAdapterForAgent('claude')).toBe(true);
  });

  test('the default binary is the fixed claude the shipped lanes run', () => {
    expect(CLAUDE_DEFAULT_BINARY).toBe('claude');
    expect(CLAUDE_RUNTIME_ADAPTER.defaultBinary).toBe('claude');
    const { resolved, invocation } = plan();
    expect(resolved.binary).toEqual({ value: 'claude', source: 'default' });
    expect(invocation.command).toBe('claude');
  });

  test('createClaudeRuntimeAdapter builds an independent frozen adapter', () => {
    const built = createClaudeRuntimeAdapter();
    expect(built).not.toBe(CLAUDE_RUNTIME_ADAPTER);
    expect(built.provider).toBe(CLAUDE_RUNTIME_ADAPTER.provider);
    expect(Object.isFrozen(built)).toBe(true);
  });

  test('an agent this adapter does not back still fails closed at the registry', () => {
    const err = captureError(() => plan({ agentId: 'codex' }));
    expect(err.name).toBe('AgentRuntimeAdapterError');
    expect(err.reason).toBe('unknown-provider');
    const echoed = captureError(() => plan({ agentId: 'acme-agent' }));
    expect(echoed.reason).toBe('unknown-provider');
  });
});

describe('claude runtime adapter — the quality bindings (§5, §6.3)', () => {
  test('all four levels resolve through the anthropic bindings', () => {
    const resolvedByLevel = Object.fromEntries(
      QUALITY_LEVELS.map((level) => [
        level,
        resolveAgentRuntime(CLAUDE_RUNTIME_ADAPTER, {
          agentId: 'claude',
          quality: quality(level),
          catalog: CATALOG,
          env: {},
        }),
      ]),
    );
    for (const level of QUALITY_LEVELS) {
      expect(resolvedByLevel[level].provider).toBe('anthropic');
      expect(resolvedByLevel[level].profileName).toBe(
        CATALOG.providers.anthropic.qualityBindings[level].profileName,
      );
      // Each level's request survives into the record beside what it bought.
      expect(resolvedByLevel[level].quality.quality).toBe(level);
    }
    // Four distinct profiles today — the shared-binding case below is what the
    // contract permits, not what the built-in catalog does.
    expect(new Set(QUALITY_LEVELS.map((l) => resolvedByLevel[l].profileName)).size).toBe(4);
  });

  test('two levels may intentionally bind to one Claude profile, and the record says so', () => {
    const shared = buildEffectiveAgentProfileCatalog({
      schemaVersion: 1,
      providers: { anthropic: { qualityBindings: { maximum: 'claude-strong' } } },
    });
    const resolved = resolveAgentRuntime(CLAUDE_RUNTIME_ADAPTER, {
      agentId: 'claude',
      quality: quality('maximum', 'label'),
      catalog: shared,
      env: {},
    });
    expect(resolved.profileName).toBe('claude-strong');
    // The request is not rewritten to `strong`: the record reports what was
    // asked for alongside the profile that answered it (§6.3, §13.2).
    expect(resolved.quality.quality).toBe('maximum');
    expect([...resolved.sharedWithQualityLevels]).toEqual(['strong']);
  });

  test('the resolution carries the catalog revision it read (§13.2)', () => {
    const { resolved } = plan();
    expect(resolved.catalogSource).toBe('builtin');
    expect(resolved.catalogDigest).toBe(CATALOG.digest);
    expect(resolved.catalogVersion).toBe(CATALOG.catalogVersion);
  });
});

describe('claude runtime adapter — the lane table (§7)', () => {
  test('the lane vocabulary is closed and recognized by isClaudeLane', () => {
    expect([...CLAUDE_LANES]).toEqual([
      'implementation',
      'conflict_resolution',
      'review',
      'no_tools',
    ]);
    for (const lane of CLAUDE_LANES) expect(isClaudeLane(lane)).toBe(true);
    for (const other of ['research', 'Implementation', '', undefined, 7]) {
      expect(isClaudeLane(other)).toBe(false);
    }
  });

  test('a lane the adapter does not serve refuses before any invocation', () => {
    expectRefusal(() => plan({ lane: 'research' }), 'unsupported-setting', /lane "research"/);
  });

  test('the implementation lane reproduces the shipped argv verbatim', () => {
    const { invocation, resolved } = plan({ prompt: 'do the work' });
    expect([...invocation.args]).toEqual([
      '-p',
      '--model', 'sonnet',
      '--effort', 'high',
      '--permission-mode', 'acceptEdits',
      '--max-budget-usd', '5',
      '--allowedTools', CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS,
    ]);
    expect(invocation.budgetApplied).toBe('applied');
    expect(resolved.budget).toEqual({ value: '5', source: 'catalog-builtin' });
  });

  test('the conflict-resolution lane keeps its own narrower allowlist', () => {
    const { invocation } = plan({ lane: 'conflict_resolution', prompt: 'resolve' });
    expect([...invocation.args]).toEqual([
      '-p',
      '--model', 'sonnet',
      '--effort', 'high',
      '--permission-mode', 'acceptEdits',
      '--max-budget-usd', '5',
      '--allowedTools', CLAUDE_CONFLICT_RESOLUTION_ALLOWED_TOOLS,
    ]);
    expect(CLAUDE_CONFLICT_RESOLUTION_ALLOWED_TOOLS).not.toBe(CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS);
    // The verification commands belong to the implementation lane only.
    expect(CLAUDE_CONFLICT_RESOLUTION_ALLOWED_TOOLS).not.toContain('npm test');
    expect(CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS).toContain('Bash(npm test)');
  });

  test('the review lane grants no permission mode and no allowlist', () => {
    const { invocation } = plan({ lane: 'review', prompt: 'review this' });
    expect([...invocation.args]).toEqual(['-p', '--model', 'sonnet', '--effort', 'high']);
    expect(invocation.args).not.toContain('--permission-mode');
    expect(invocation.args).not.toContain('--allowedTools');
  });

  test('the no-tools lane pins the read-only boundary ahead of every setting', () => {
    const { invocation } = plan({ lane: 'no_tools', quality: quality('strong'), prompt: 'judge' });
    expect([...invocation.args]).toEqual([
      '-p',
      ...CLAUDE_NO_TOOLS_ARGS,
      '--model', 'opus',
      '--effort', 'high',
    ]);
    for (const flag of [
      '--tools',
      '--allowedTools',
      '--disallowedTools',
      '--strict-mcp-config',
      '--safe-mode',
      '--no-session-persistence',
    ]) {
      expect([...CLAUDE_NO_TOOLS_ARGS]).toContain(flag);
    }
  });

  test('the arbiter and reconsideration runners alias one no-tools boundary', () => {
    expect([...ARBITER_CLAUDE_NO_TOOLS_ARGS]).toEqual([...CLAUDE_NO_TOOLS_ARGS]);
    expect([...RECONSIDERATION_NO_TOOLS_ARGS]).toEqual([...CLAUDE_NO_TOOLS_ARGS]);
  });

  test('only the write-capable lanes declare a permission mode or an allowlist', () => {
    expect(CLAUDE_LANE_SPECS.implementation.permissionMode).toBe('acceptEdits');
    expect(CLAUDE_LANE_SPECS.conflict_resolution.permissionMode).toBe('acceptEdits');
    expect(CLAUDE_LANE_SPECS.review.permissionMode).toBeUndefined();
    expect(CLAUDE_LANE_SPECS.review.allowedTools).toBeUndefined();
    expect(CLAUDE_LANE_SPECS.no_tools.permissionMode).toBeUndefined();
    expect(CLAUDE_LANE_SPECS.no_tools.allowedTools).toBeUndefined();
  });
});

describe('claude runtime adapter — prompts and budget (§7 rule 1, §7.1)', () => {
  test('every lane delivers the prompt on stdin, verbatim, never in argv', () => {
    const prompt = 'line one\nline two\twith a tab';
    for (const lane of CLAUDE_LANES) {
      const { invocation } = plan({ lane, prompt });
      expect(invocation.promptDelivery).toBe('stdin');
      expect(invocation.stdin).toBe(prompt);
      expect(invocation.args).not.toContain(prompt);
    }
  });

  test('a lane invoked with no prompt declares no delivery at all', () => {
    const { invocation } = plan({ lane: 'review' });
    expect(invocation.promptDelivery).toBe('none');
    expect(invocation.stdin).toBeUndefined();
  });

  test('a budget the review lane cannot express is declared, never dropped', () => {
    const { resolved, invocation } = plan({ lane: 'review', prompt: 'review' });
    // The profile carries a budget; the lane has no mechanism for it.
    expect(resolved.budget.value).toBe('5');
    expect(invocation.budgetApplied).toBe('not-applicable');
    expect(invocation.args).not.toContain('--max-budget-usd');
  });

  test('the no-tools lane reports the same declared asymmetry', () => {
    const { invocation } = plan({ lane: 'no_tools', prompt: 'judge' });
    expect(invocation.budgetApplied).toBe('not-applicable');
  });

  test('a profile with no budget passes no flag and declares nothing', () => {
    const noBudget = catalogWithAnthropicProfile('claude-normal', { budget: null });
    const { resolved, invocation } = plan({ catalog: noBudget, prompt: 'work' });
    expect(resolved.budget).toEqual({ source: 'cli-default' });
    expect(invocation.args).not.toContain('--max-budget-usd');
    expect(invocation.budgetApplied).toBeUndefined();
  });
});

describe('claude runtime adapter — absence is absence (§6.1, §13.3)', () => {
  test('an unset model passes no --model flag at all', () => {
    const noModel = catalogWithAnthropicProfile('claude-normal', { model: null });
    const { resolved, invocation } = plan({ catalog: noModel });
    expect(resolved.model).toEqual({ source: 'cli-default' });
    expect(invocation.args).not.toContain('--model');
    // Never the literal string "default" standing in for a model name.
    expect(invocation.args).not.toContain('default');
  });

  test('an unset effort passes no --effort flag at all', () => {
    const noEffort = catalogWithAnthropicProfile('claude-normal', { effort: null });
    const { resolved, invocation } = plan({ catalog: noEffort });
    expect(resolved.effort).toEqual({ source: 'cli-default' });
    expect(invocation.args).not.toContain('--effort');
    expect([...invocation.args]).toEqual([
      '-p',
      '--model', 'sonnet',
      '--permission-mode', 'acceptEdits',
      '--max-budget-usd', '5',
      '--allowedTools', CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS,
    ]);
  });

  test('the lane boundary still precedes the settings when both are absent', () => {
    const bare = catalogWithAnthropicProfile('claude-normal', { model: null, effort: null });
    const { invocation } = plan({ lane: 'no_tools', catalog: bare, prompt: 'judge' });
    expect([...invocation.args]).toEqual(['-p', ...CLAUDE_NO_TOOLS_ARGS]);
  });
});

describe('claude runtime adapter — break-glass environment overrides (§8.1 layer 1)', () => {
  test('the three documented variables each break the glass on one field', () => {
    expect([...CLAUDE_ENV_OVERRIDES]).toEqual([
      { setting: 'model', variable: 'CLAUDE_MODEL' },
      { setting: 'effort', variable: 'CLAUDE_EFFORT' },
      { setting: 'budget', variable: 'CLAUDE_MAX_BUDGET_USD' },
    ]);
  });

  test('CLAUDE_EFFORT overrides effort and leaves model and budget resolving normally', () => {
    const { resolved, invocation } = plan({ env: { CLAUDE_EFFORT: 'xhigh' } });
    expect(resolved.effort).toEqual({ value: 'xhigh', source: 'env' });
    expect(resolved.model).toEqual({ value: 'sonnet', source: 'catalog-builtin' });
    expect(resolved.budget).toEqual({ value: '5', source: 'catalog-builtin' });
    expect([...invocation.args]).toEqual([
      '-p',
      '--model', 'sonnet',
      '--effort', 'xhigh',
      '--permission-mode', 'acceptEdits',
      '--max-budget-usd', '5',
      '--allowedTools', CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS,
    ]);
  });

  test('an env override outranks a pinned profile, one field at a time', () => {
    const { resolved } = plan({
      env: { CLAUDE_MODEL: 'operator-choice' },
      taskPinnedProfile: 'claude-light',
      sessionPinnedProfile: 'claude-maximum',
    });
    // The pin still chooses the profile; the variable still wins the one field.
    expect(resolved.profileName).toBe('claude-light');
    expect(resolved.profileSource).toBe('task-pin');
    expect(resolved.model).toEqual({ value: 'operator-choice', source: 'env' });
    expect(resolved.effort).toEqual({ value: 'low', source: 'catalog-builtin' });
  });

  test('CLAUDE_MAX_BUDGET_USD reaches the flag on a lane that can express it', () => {
    const { invocation } = plan({ env: { CLAUDE_MAX_BUDGET_USD: '42.50' } });
    expect([...invocation.args]).toContain('42.50');
    expect(invocation.budgetApplied).toBe('applied');
  });

  test('a break-glass override is still capability-checked, never widened', () => {
    expectRefusal(
      () => plan({ env: { CLAUDE_EFFORT: 'ludicrous' } }),
      'invalid-override',
      /CLAUDE_EFFORT/,
    );
    expectRefusal(
      () => plan({ env: { CLAUDE_MAX_BUDGET_USD: '0' } }),
      'invalid-override',
      /CLAUDE_MAX_BUDGET_USD/,
    );
    expectRefusal(() => plan({ env: { CLAUDE_MODEL: '  ' } }), 'invalid-override', /CLAUDE_MODEL/);
  });

  test('there is no environment override for the binary', () => {
    expect(CLAUDE_ENV_OVERRIDES.some((o) => o.setting === 'binary')).toBe(false);
    const { resolved } = plan({ env: { CLAUDE_BIN: '/tmp/evil', CLAUDE_BINARY: '/tmp/evil' } });
    expect(resolved.binary).toEqual({ value: 'claude', source: 'default' });
  });

  test('a catalog profile may still name a binary, and it is validated like any setting', () => {
    const relocated = catalogWithAnthropicProfile('claude-normal', { binary: '/opt/bin/claude' });
    const { resolved, invocation } = plan({ catalog: relocated });
    expect(resolved.binary).toEqual({ value: '/opt/bin/claude', source: 'catalog-overlay' });
    expect(invocation.command).toBe('/opt/bin/claude');
  });
});

describe('claude runtime adapter — validation before a billable run (§12)', () => {
  test('a flag-shaped model refuses rather than becoming another option', () => {
    const flagShaped = catalogWithAnthropicProfile('claude-normal', { model: '--dangerous' });
    expectRefusal(() => plan({ catalog: flagShaped }), 'unsupported-value', /starts with "-"/);
  });

  test('a flag-shaped binary refuses too', () => {
    const flagShaped = catalogWithAnthropicProfile('claude-normal', { binary: '-rf' });
    expectRefusal(() => plan({ catalog: flagShaped }), 'unsupported-value', /binary/);
  });

  test('an effort carrying whitespace refuses — the flag takes one token', () => {
    const spaced = catalogWithAnthropicProfile('claude-normal', { model: 'a model name' });
    // A plain space is legal in a model name, as the boundary already allows.
    expect(plan({ catalog: spaced }).resolved.model.value).toBe('a model name');
    expectRefusal(
      () => plan({ env: { CLAUDE_EFFORT: 'very high' } }),
      'invalid-override',
      /CLAUDE_EFFORT/,
    );
  });

  test('a budget that is not a positive amount refuses before it reaches the flag', () => {
    // The catalog gate and the env gate both pin the amount's shape already, so
    // this last check is defense in depth: the adapter is asked directly, with a
    // resolution neither gate could have produced, because "it cannot happen" is
    // not a reason to hand a malformed value to a billable CLI.
    const request = {
      agentId: 'claude',
      lane: 'implementation',
      quality: quality('normal'),
      catalog: CATALOG,
      env: {},
    };
    const resolved = resolveAgentRuntime(CLAUDE_RUNTIME_ADAPTER, request);
    const err = captureError(() =>
      CLAUDE_RUNTIME_ADAPTER.buildInvocation(request, {
        ...resolved,
        budget: { value: 'free', source: 'catalog-overlay' },
      }),
    );
    expect(err.name).toBe('AgentRuntimeAdapterError');
    expect(err.reason).toBe('unsupported-value');
    expect(err.message).toMatch(/positive USD amount/);
  });

  test('a refusal names where the value came from so it is actionable', () => {
    const overlaid = catalogWithAnthropicProfile('claude-normal', { model: '-x' });
    const err = expectRefusal(() => plan({ catalog: overlaid }), 'unsupported-value');
    expect(err.message).toMatch(/claude-normal/);
    expect(err.message).toMatch(/overlay/);
  });

  test('a provider option the Claude adapter cannot express refuses, never ignored', () => {
    const withOptions = buildEffectiveAgentProfileCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: {
          capabilities: { providerOptions: ['printTimeout'] },
          profiles: { 'claude-normal': { providerOptions: { printTimeout: '15m' } } },
        },
      },
    });
    expectRefusal(
      () => plan({ catalog: withOptions }),
      'unsupported-setting',
      /printTimeout/,
    );
  });

  test('every refusal is configuration, never a transient execution failure', () => {
    for (const build of [
      () => plan({ lane: 'research' }),
      () => plan({ env: { CLAUDE_EFFORT: 'ludicrous' } }),
      () => plan({ catalog: catalogWithAnthropicProfile('claude-normal', { model: '-x' }) }),
      () => plan({ taskPinnedProfile: 'claude-nonexistent' }),
    ]) {
      const err = captureError(build);
      expect(err).toBeDefined();
      expect(isAgentRuntimeConfigurationError(err)).toBe(true);
    }
  });
});

describe('claude runtime adapter — behavior with no agent-profiles.json (§9.2, §10.3)', () => {
  const CASES = [
    { level: 'light', model: 'sonnet', effort: 'low', budget: '2' },
    { level: 'normal', model: 'sonnet', effort: 'high', budget: '5' },
    { level: 'strong', model: 'opus', effort: 'high', budget: '10' },
    { level: 'maximum', model: 'fable', effort: 'xhigh', budget: '20' },
  ];

  test.each(CASES)(
    'the implementation lane at $level reproduces the shipped complexity mapping',
    ({ level, model, effort, budget }) => {
      const { invocation } = plan({ quality: quality(level, 'compat-label'), prompt: 'work' });
      expect([...invocation.args]).toEqual([
        '-p',
        '--model', model,
        '--effort', effort,
        '--permission-mode', 'acceptEdits',
        '--max-budget-usd', budget,
        '--allowedTools', CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS,
      ]);
    },
  );

  test('an unlabeled review reproduces the shipped review argv', () => {
    // Today: no review label -> sonnet, effort "high".
    const { invocation } = plan({ lane: 'review', quality: quality('normal'), prompt: 'review' });
    expect([...invocation.args]).toEqual(['-p', '--model', 'sonnet', '--effort', 'high']);
  });

  test('review:high and review:low reproduce the shipped review argv', () => {
    expect([...plan({ lane: 'review', quality: quality('strong', 'compat-label') }).invocation.args])
      .toEqual(['-p', '--model', 'opus', '--effort', 'high']);
    expect([...plan({ lane: 'review', quality: quality('light', 'compat-label') }).invocation.args])
      .toEqual(['-p', '--model', 'sonnet', '--effort', 'low']);
  });

  test('an explicit review:medium is the one divergence the cutover still owes a table', () => {
    // Today the Claude review lane resolves `medium` effort for an explicit
    // `review:medium`; `normal` binds to the profile carrying `high`. B1
    // recorded this divergence and no lane resolves through the adapter yet, so
    // it is pinned HERE as a known difference rather than discovered at cutover.
    const { invocation } = plan({
      lane: 'review',
      quality: quality('normal', 'compat-label'),
    });
    expect([...invocation.args]).toEqual(['-p', '--model', 'sonnet', '--effort', 'high']);
    expect(invocation.args).not.toContain('medium');
  });

  test('the review-loop escalation floor buys the strong profile, model included', () => {
    // The second divergence: today `escalatedEffort` raises effort only. The
    // provider-neutral floor is a quality level, and `strong` carries a
    // different model as well — a binding decision the cutover records.
    const escalated = {
      quality: 'strong',
      source: 'escalation',
      requested: { quality: 'normal', source: 'default' },
      escalationFloor: 'strong',
    };
    const { resolved, invocation } = plan({ quality: escalated });
    expect(resolved.profileName).toBe('claude-strong');
    expect(resolved.quality.requested.quality).toBe('normal');
    expect([...invocation.args]).toContain('opus');
  });
});

describe('claude runtime adapter — discovery is informational (§7.1, §11.3)', () => {
  test('a version banner parses into a version, and never into a capability', () => {
    const discovery = interpretDiscoveryProbe(CLAUDE_DISCOVERY, {
      ok: true,
      status: 'available',
      output: '2.0.5 (Claude Code)',
      transient: false,
    });
    expect(discovery.status).toBe('available');
    expect(discovery.version).toBe('2.0.5');
    expect(discovery.capabilities).toBeUndefined();
  });

  test('an unrecognized banner still means available', () => {
    const discovery = interpretDiscoveryProbe(CLAUDE_DISCOVERY, {
      ok: true,
      status: 'available',
      output: 'something else entirely',
      transient: false,
    });
    expect(discovery.status).toBe('available');
    expect(discovery.version).toBeUndefined();
  });

  test('a transiently unprobeable host is indeterminate, never unavailable', () => {
    expect(
      interpretDiscoveryProbe(CLAUDE_DISCOVERY, {
        ok: false,
        status: 'spawn-error',
        output: 'EAGAIN',
        transient: true,
      }).status,
    ).toBe('indeterminate');
    expect(
      interpretDiscoveryProbe(CLAUDE_DISCOVERY, {
        ok: false,
        status: 'not-found',
        output: 'ENOENT',
        transient: false,
      }).status,
    ).toBe('unavailable');
  });

  test('the probe asks only for a version banner', () => {
    expect([...CLAUDE_DISCOVERY.args]).toEqual(['--version']);
  });
});

describe('claude runtime adapter — §14.3, no provider catalog in the type system', () => {
  const source = readFileSync(resolve(ROOT, 'src/core/claude-runtime-adapter.ts'), 'utf8');

  test('the adapter source spells no model name', () => {
    for (const modelName of ['sonnet', 'opus', 'fable', 'haiku']) {
      expect(source.toLowerCase()).not.toContain(modelName);
    }
  });

  test('the adapter declares no effort vocabulary of its own', () => {
    // The capability descriptor in the catalog is the only place a provider's
    // accepted effort values live; a list here would be the union §14.3 retires.
    expect(source).not.toMatch(/"xhigh"/);
    expect(source).not.toMatch(/\["low", "medium", "high"/);
  });

  test('the adapter re-derives nothing from labels or the session (§7 rule 2)', () => {
    expect(source).not.toMatch(/complexity:/);
    expect(source).not.toMatch(/review:high/);
    expect(source).not.toMatch(/labelsToComplexity/);
    expect(source).not.toMatch(/complexityProfiles/);
  });

  test('the adapter imports no process, filesystem, or network machinery', () => {
    const imports = [...source.matchAll(/from "([^"]+)";/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(new Set(imports)).toEqual(new Set(['./agent-runtime-adapter.js']));
    expect(source).not.toMatch(/execFile|execSync|spawnSync|require\(/);
  });
});
