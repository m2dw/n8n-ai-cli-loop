/**
 * The Gemini/Antigravity runtime profile adapter (issue #909) — the `google`
 * provider adapter of slice B3 of docs/agent-runtime-profiles-contract.md §14.1.
 *
 * The boundary these plug into is pinned by test/agent-runtime-adapter.test.js
 * (#906) and the sibling provider adapters by test/claude-runtime-adapter.test.js
 * (#907) and test/codex-runtime-adapter.test.js (#908); what is pinned here is
 * this provider's half:
 *
 *   - the four quality levels resolve through the `google` bindings, and the
 *     requested level is reported alongside the concrete values, because this
 *     provider's four built-in profiles carry identical settings;
 *   - each served lane produces the argv the shipped runners produce today —
 *     `[--model M] [--print-timeout T] --print <prompt>` — with `--print` last
 *     because it takes the next argv element as its value;
 *   - an Antigravity model is a DISPLAY NAME whose effort tier is part of the
 *     name, so a value like "Gemini 3.1 Pro (Low)" survives verbatim and no
 *     separate effort field is required — and an effort that somehow resolved
 *     refuses rather than being silently dropped;
 *   - an unconfigured model passes no `--model` at all, leaving the CLI's own
 *     default (§13.3 — never the string "default");
 *   - `ANTIGRAVITY_BIN` breaks the glass on the binary and stays
 *     capability-checked, and a variable set but empty refuses rather than
 *     spawning the empty string;
 *   - the prompt reaches the CLI on BOTH channels by default, and only the
 *     research lane may ask for the stdin-only transport the evidence loop needs;
 *   - `printTimeout` is validated with the same parser issue #861 already uses,
 *     and any other provider option refuses;
 *   - capability discovery through `agy models` is bounded, and its failure is
 *     reported in a vocabulary that CANNOT be read as an unavailable agent —
 *     that answer comes only from the `--version` probe.
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  ANTIGRAVITY_DEFAULT_BINARY,
  ANTIGRAVITY_DISCOVERY,
  ANTIGRAVITY_ENV_OVERRIDES,
  ANTIGRAVITY_LANES,
  ANTIGRAVITY_LANE_SPECS,
  ANTIGRAVITY_MAX_DISCOVERED_MODELS,
  ANTIGRAVITY_MODELS_PROBE,
  ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS,
  ANTIGRAVITY_MODEL_DISCOVERY_STATUSES,
  ANTIGRAVITY_PRINT_OPERAND,
  ANTIGRAVITY_PRINT_TIMEOUT_OPTION,
  ANTIGRAVITY_PROVIDER,
  ANTIGRAVITY_RUNTIME_ADAPTER,
  CLAUDE_RUNTIME_ADAPTER,
  CODEX_RUNTIME_ADAPTER,
  QUALITY_LEVELS,
  antigravityInvocationRequest,
  buildEffectiveAgentProfileCatalog,
  createAgentRuntimeAdapterRegistry,
  createAntigravityRuntimeAdapter,
  describeAntigravityRuntime,
  interpretAntigravityModelsProbe,
  interpretDiscoveryProbe,
  isAgentRuntimeConfigurationError,
  isAntigravityLane,
  planAgentInvocation,
  resolveAgentRuntime,
} from '../dist/index.js';
import { ANTIGRAVITY_PRINT_TIMEOUT_DEFAULT } from '../dist/core/antigravity-print-timeout.js';
import { EVIDENCE_TRANSPORTS } from '../dist/core/research-evidence-protocol.js';

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
  adapters: [CLAUDE_RUNTIME_ADAPTER, CODEX_RUNTIME_ADAPTER, ANTIGRAVITY_RUNTIME_ADAPTER],
  providerForAgent,
});

function quality(level, source = 'default') {
  return { quality: level, source, requested: { quality: level, source } };
}

const PROMPT = 'Review the diff.\n\nIt spans two paragraphs.';

/** One planned invocation. `antigravity` carries this provider's lane inputs. */
function plan({ antigravity, ...overrides } = {}) {
  const request = {
    agentId: 'gemini',
    lane: 'review',
    quality: quality('normal'),
    catalog: CATALOG,
    env: {},
    prompt: PROMPT,
    ...overrides,
  };
  return planAgentInvocation(
    REGISTRY,
    antigravity ? antigravityInvocationRequest(request, antigravity) : request,
  );
}

function argsOf(overrides) {
  return [...plan(overrides).invocation.args];
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

function expectContractViolation(fn, match) {
  const err = captureError(fn);
  expect(err).toBeDefined();
  expect(err.name).toBe('AgentRuntimeContractViolationError');
  expect(isAgentRuntimeConfigurationError(err)).toBe(true);
  if (match) expect(err.message).toMatch(match);
  return err;
}

/**
 * A catalog whose google profile carries hand-planted settings, bound to
 * `normal`. The profile name is new, so nothing is inherited from the built-in
 * catalog: a profile declaring no `printTimeout` carries none, which is how the
 * bare `--print` shape the shipped lanes run today is reproduced here.
 */
function catalogWithGoogleProfile(profileName, settings, capabilities) {
  return buildEffectiveAgentProfileCatalog({
    schemaVersion: 1,
    providers: {
      google: {
        ...(capabilities ? { capabilities } : {}),
        profiles: { [profileName]: settings },
        qualityBindings: { normal: profileName },
      },
    },
  });
}

describe('antigravity runtime adapter — provider identity (§3, §7.1)', () => {
  test('registers under the catalog provider key, never under an agent id', () => {
    expect(ANTIGRAVITY_PROVIDER).toBe('google');
    expect(ANTIGRAVITY_RUNTIME_ADAPTER.provider).toBe('google');
    expect(REGISTRY.providers).toEqual(['anthropic', 'google', 'openai']);
    expect(REGISTRY.adapterForAgent('gemini')).toBe(ANTIGRAVITY_RUNTIME_ADAPTER);
    expect(REGISTRY.hasAdapterForAgent('gemini')).toBe(true);
  });

  test('registering the adapter under the agent id is a composition-root defect', () => {
    const err = captureError(() =>
      createAgentRuntimeAdapterRegistry({
        adapters: [{ ...ANTIGRAVITY_RUNTIME_ADAPTER, provider: 'gemini' }],
        providerForAgent,
      }),
    );
    expect(err).toBeDefined();
    expect(err.name).toBe('AgentRuntimeContractViolationError');
    expect(err.message).toMatch(/"gemini" is an agent id, not a provider/);
  });

  test('the default binary is the agy every shipped Antigravity lane runs', () => {
    expect(ANTIGRAVITY_DEFAULT_BINARY).toBe('agy');
    const { resolved, invocation } = plan();
    expect(resolved.binary).toEqual({ value: 'agy', source: 'default' });
    expect(invocation.command).toBe('agy');
  });

  test('createAntigravityRuntimeAdapter builds an independent frozen adapter', () => {
    const built = createAntigravityRuntimeAdapter();
    expect(built).not.toBe(ANTIGRAVITY_RUNTIME_ADAPTER);
    expect(Object.isFrozen(built)).toBe(true);
    expect(built.provider).toBe(ANTIGRAVITY_RUNTIME_ADAPTER.provider);
  });
});

describe('antigravity runtime adapter — the quality bindings (§5, §6.3)', () => {
  test('all four levels resolve to their own declared profile', () => {
    const names = QUALITY_LEVELS.map((level) => {
      const resolved = resolveAgentRuntime(ANTIGRAVITY_RUNTIME_ADAPTER, {
        agentId: 'gemini',
        quality: quality(level),
        catalog: CATALOG,
        env: {},
      });
      // Four distinct profiles, so no level is declared to share one (§6.3).
      expect([...resolved.sharedWithQualityLevels]).toEqual([]);
      return resolved.profileName;
    });
    expect(names).toEqual(['agy-light', 'agy-normal', 'agy-strong', 'agy-maximum']);
    expect(new Set(names).size).toBe(4);
  });

  test('no built-in profile names a model, so the CLI default applies (§13.3)', () => {
    for (const level of QUALITY_LEVELS) {
      const resolved = resolveAgentRuntime(ANTIGRAVITY_RUNTIME_ADAPTER, {
        agentId: 'gemini',
        quality: quality(level),
        catalog: CATALOG,
        env: {},
      });
      expect(resolved.model.value).toBeUndefined();
      expect(resolved.model.source).toBe('cli-default');
    }
    expect(argsOf()).not.toContain('--model');
  });

  test('the provider declares neither effort nor budget, so both are not-applicable', () => {
    const resolved = resolveAgentRuntime(ANTIGRAVITY_RUNTIME_ADAPTER, {
      agentId: 'gemini',
      quality: quality('maximum'),
      catalog: CATALOG,
      env: {},
    });
    // "not-applicable" is the descriptor saying the provider has no such
    // setting, distinct from "cli-default" (declared, but nothing set it).
    expect(resolved.effort).toEqual({ source: 'not-applicable' });
    expect(resolved.budget).toEqual({ source: 'not-applicable' });
  });

  test('every built-in profile carries the shipped print timeout, not an invented ladder', () => {
    for (const level of QUALITY_LEVELS) {
      const resolved = resolveAgentRuntime(ANTIGRAVITY_RUNTIME_ADAPTER, {
        agentId: 'gemini',
        quality: quality(level),
        catalog: CATALOG,
        env: {},
      });
      expect(resolved.providerOptions[ANTIGRAVITY_PRINT_TIMEOUT_OPTION]).toBe(
        ANTIGRAVITY_PRINT_TIMEOUT_DEFAULT,
      );
    }
  });
});

describe('antigravity runtime adapter — the lane table (§7)', () => {
  test('the served lanes are the shipped paths that invoke agy', () => {
    expect([...ANTIGRAVITY_LANES]).toEqual([
      'implementation',
      'review',
      'research',
      'content_draft',
      'content_review',
    ]);
    for (const lane of ANTIGRAVITY_LANES) {
      expect(ANTIGRAVITY_LANE_SPECS[lane].lane).toBe(lane);
      expect(isAntigravityLane(lane)).toBe(true);
    }
    // No lane invokes agy for conflict resolution today, so the adapter must not
    // invent one — which agent owns a phase is the assignment profile's call.
    expect(isAntigravityLane('conflict_resolution')).toBe(false);
    expect(isAntigravityLane('no_tools')).toBe(false);
  });

  test('an unrecognized lane refuses rather than inheriting a shape nobody declared', () => {
    expectRefusal(
      () => plan({ lane: 'reviw' }),
      'unsupported-setting',
      /no invocation for lane "reviw"/,
    );
  });

  test('every lane emits the same shape, with --print last so it takes the prompt', () => {
    for (const lane of ANTIGRAVITY_LANES) {
      const args = argsOf({ lane });
      expect(args).toEqual(['--print-timeout', '15m', '--print', PROMPT]);
      // `--print` consumes the NEXT argv element, so nothing may follow the
      // prompt and no flag may sit between the two.
      expect(args[args.length - 2]).toBe('--print');
    }
  });

  test('a profile with no print timeout emits the bare shape the shipped lanes run today', () => {
    const catalog = catalogWithGoogleProfile('agy-bare', {});
    expect(argsOf({ catalog })).toEqual(['--print', PROMPT]);
  });

  test('no Antigravity lane can express a budget, and one that resolved is declared', () => {
    const catalog = catalogWithGoogleProfile(
      'agy-budgeted',
      { budget: '10' },
      { budget: 'free' },
    );
    const { resolved, invocation } = plan({ catalog });
    expect(resolved.budget).toEqual({ value: '10', source: 'catalog-overlay' });
    // §7 rule 1: reported as an asymmetry, never dropped in silence.
    expect(invocation.budgetApplied).toBe('not-applicable');
    expect(invocation.args).not.toContain('10');
    for (const lane of ANTIGRAVITY_LANES) {
      expect(ANTIGRAVITY_LANE_SPECS[lane].budget).toBe('not-applicable');
    }
  });
});

describe('antigravity runtime adapter — effort lives in the model name (§6.2)', () => {
  test('a model display name carrying its tier survives verbatim, spaces and all', () => {
    // This is the whole reason the model is not treated as a single token: the
    // effort suffix is part of the display name a session already configures.
    const catalog = catalogWithGoogleProfile('agy-named', {
      model: 'Gemini 3.1 Pro (Low)',
    });
    expect(argsOf({ catalog })).toEqual(['--model', 'Gemini 3.1 Pro (Low)', '--print', PROMPT]);
  });

  test('no separate effort field is required, and none is emitted', () => {
    const args = argsOf();
    expect(args).not.toContain('--effort');
    expect(args.some((arg) => arg.includes('reasoning_effort'))).toBe(false);
  });

  test('an effort an operator widened the descriptor to set refuses, never drops', () => {
    // Silently emitting nothing would leave the operator believing a tier
    // applied; the refusal says where the tier actually lives for this provider.
    const catalog = catalogWithGoogleProfile(
      'agy-effortful',
      { effort: 'thorough' },
      { effort: ['thorough'] },
    );
    expectRefusal(
      () => plan({ catalog }),
      'unsupported-setting',
      /Antigravity CLI exposes no effort flag.*folds the tier into the model display name/s,
    );
  });

  test('the other providers keep their own effort vocabularies untouched (§5 rule 2)', () => {
    // Nothing shared may assume this provider speaks Codex or Claude effort.
    const codexArgs = [
      ...planAgentInvocation(REGISTRY, {
        agentId: 'codex',
        lane: 'implementation',
        quality: quality('normal'),
        catalog: CATALOG,
        env: {},
        prompt: PROMPT,
      }).invocation.args,
    ];
    expect(codexArgs).toContain('model_reasoning_effort=high');
    expect(argsOf()).not.toContain('high');
  });
});

describe('antigravity runtime adapter — the print timeout provider option', () => {
  test('an operator-retargeted timeout reaches argv with its overlay provenance', () => {
    const catalog = catalogWithGoogleProfile('agy-slow', {
      providerOptions: { printTimeout: '30m' },
    });
    expect(argsOf({ catalog })).toEqual(['--print-timeout', '30m', '--print', PROMPT]);
    const { resolved } = plan({ catalog });
    expect(describeAntigravityRuntime(resolved).printTimeoutSource).toBe('catalog-overlay');
  });

  test('a malformed duration refuses before it can fail the CLI mid-phase', () => {
    // The catalog validates the option KEY against the descriptor but not its
    // value, so this is the adapter's gate — and it is issue #861's parser, so
    // one duration format is accepted everywhere.
    const catalog = catalogWithGoogleProfile('agy-typo', {
      providerOptions: { printTimeout: '15 minutes' },
    });
    expectRefusal(
      () => plan({ catalog }),
      'unsupported-value',
      /printTimeout "15 minutes" is not a valid duration/,
    );
  });

  test('an out-of-bounds duration refuses with the same parser bound', () => {
    const catalog = catalogWithGoogleProfile('agy-forever', {
      providerOptions: { printTimeout: '15h' },
    });
    expectRefusal(() => plan({ catalog }), 'unsupported-value', /must not exceed 60 minutes/);
  });

  test('a provider option the invocation has no place for refuses, never drops', () => {
    const catalog = catalogWithGoogleProfile(
      'agy-extra',
      { providerOptions: { thinkingBudget: '4096' } },
      { providerOptions: ['printTimeout', 'thinkingBudget'] },
    );
    expectRefusal(
      () => plan({ catalog }),
      'unsupported-setting',
      /provider options \(thinkingBudget\) that the Antigravity adapter has no invocation for/,
    );
  });
});

describe('antigravity runtime adapter — break-glass variables (§8.1 layer 1)', () => {
  test('the one declared variable is the binary variable §1.2 inventoried', () => {
    expect(ANTIGRAVITY_ENV_OVERRIDES.map((o) => [o.setting, o.variable])).toEqual([
      ['binary', 'ANTIGRAVITY_BIN'],
    ]);
  });

  test('ANTIGRAVITY_BIN replaces the binary and nothing else', () => {
    const { resolved, invocation } = plan({ env: { ANTIGRAVITY_BIN: '/opt/agy/bin/agy' } });
    expect(resolved.binary).toEqual({ value: '/opt/agy/bin/agy', source: 'env' });
    expect(invocation.command).toBe('/opt/agy/bin/agy');
    expect(resolved.model.value).toBeUndefined();
  });

  test('a variable set but empty refuses rather than spawning the empty string', () => {
    // Today's `process.env["ANTIGRAVITY_BIN"] ?? "agy"` keeps the empty string;
    // the boundary refuses it with the variable named.
    expectRefusal(
      () => plan({ env: { ANTIGRAVITY_BIN: '  ' } }),
      'invalid-override',
      /ANTIGRAVITY_BIN is set but empty/,
    );
  });

  test('no model or effort break-glass variable is declared for this provider', () => {
    const settings = ANTIGRAVITY_ENV_OVERRIDES.map((o) => o.setting);
    expect(settings).not.toContain('model');
    expect(settings).not.toContain('effort');
    expect(settings).not.toContain('budget');
  });

  test('a pinned profile the provider does not declare refuses, never falls through', () => {
    expectRefusal(
      () => plan({ taskPinnedProfile: 'agy-turbo' }),
      'unknown-profile',
      /which provider "google" does not declare/,
    );
  });
});

describe('antigravity runtime adapter — pre-invocation validation (§12.1)', () => {
  test('a flag-shaped model refuses before a billable run, naming where it came from', () => {
    const catalog = catalogWithGoogleProfile('agy-flag', {
      model: '--print',
    });
    expectRefusal(
      () => plan({ catalog }),
      'unsupported-value',
      /starts with "-" \(set by profile "agy-flag" in the agent-profiles\.json overlay\)/,
    );
  });

  test('a model carrying exotic whitespace never reaches the adapter at all', () => {
    // The adapter's whitespace rule restates the catalog's, so a value cannot
    // pass one gate and fail the other; here the catalog is simply the first of
    // the two to see it, and it refuses at LOAD rather than at resolution.
    const err = captureError(() =>
      catalogWithGoogleProfile('agy-multiline', { model: 'Gemini 3.1\nPro' }),
    );
    expect(err).toBeDefined();
    expect(err.name).toBe('AgentProfileCatalogError');
    expect(isAgentRuntimeConfigurationError(err)).toBe(true);
  });

  test('a flag-shaped binary refuses', () => {
    expectRefusal(
      () => plan({ env: { ANTIGRAVITY_BIN: '--version' } }),
      'unsupported-value',
      /the resolved binary "--version" starts with "-"/,
    );
  });
});

describe('antigravity runtime adapter — the two prompt transports', () => {
  test('by default the prompt reaches the CLI as the --print operand AND on stdin', () => {
    // Some agy builds read only the operand and ignore stdin, so both channels
    // carry it verbatim — the shipped contract on every lane today.
    const { invocation } = plan();
    expect(invocation.promptDelivery).toBe('stdin-and-argument');
    expect(invocation.stdin).toBe(PROMPT);
    expect(invocation.args[invocation.args.length - 1]).toBe(PROMPT);
  });

  test('the research lane may deliver on stdin only, with the fixed content-free operand', () => {
    const { invocation } = plan({ lane: 'research', antigravity: { stdinOnlyPrompt: true } });
    expect(invocation.promptDelivery).toBe('stdin');
    expect(invocation.stdin).toBe(PROMPT);
    expect(invocation.args).toEqual(['--print-timeout', '15m', '--print', ANTIGRAVITY_PRINT_OPERAND]);
    expect(invocation.args).not.toContain(PROMPT);
  });

  test('the fixed operand is the one the research evidence transport already uses', () => {
    // Pinned rather than imported so the adapter stays free of the evidence
    // protocol, but the two cannot drift into different operands.
    expect(ANTIGRAVITY_PRINT_OPERAND).toBe(EVIDENCE_TRANSPORTS.gemini.stdinOperand);
  });

  test('a lane not designed for the stdin-only transport refuses it', () => {
    for (const lane of ['implementation', 'review', 'content_draft', 'content_review']) {
      expect(ANTIGRAVITY_LANE_SPECS[lane].acceptsStdinOnlyPrompt).toBe(false);
      expectContractViolation(
        () => plan({ lane, antigravity: { stdinOnlyPrompt: true } }),
        /some agy builds ignore stdin, so a stdin-only turn would run this lane on a content-free prompt/,
      );
    }
    expect(ANTIGRAVITY_LANE_SPECS.research.acceptsStdinOnlyPrompt).toBe(true);
  });

  test('an explicit stdinOnlyPrompt:false keeps the both-channels transport', () => {
    const { invocation } = plan({ lane: 'research', antigravity: { stdinOnlyPrompt: false } });
    expect(invocation.promptDelivery).toBe('stdin-and-argument');
  });

  test('an invocation with no prompt is not expressible: --print must have a value', () => {
    expectContractViolation(
      () => plan({ prompt: undefined }),
      /parses --print as a flag that must have a value/,
    );
  });

  test('a prompt equal to the fixed operand refuses instead of leaking into argv', () => {
    expectContractViolation(
      () => plan({ lane: 'research', prompt: '-', antigravity: { stdinOnlyPrompt: true } }),
      /the stdin-only transport cannot keep it out of argv/,
    );
  });
});

describe('antigravity runtime adapter — availability vs capability discovery (§7.1, §11.3)', () => {
  test('the availability probe asks only for a version banner', () => {
    expect([...ANTIGRAVITY_DISCOVERY.args]).toEqual(['--version']);
    expect(ANTIGRAVITY_RUNTIME_ADAPTER.discovery).toBe(ANTIGRAVITY_DISCOVERY);
    const answer = interpretDiscoveryProbe(ANTIGRAVITY_DISCOVERY, {
      ok: true,
      status: 'available',
      transient: false,
      output: 'agy version 1.1.9',
    });
    expect(answer).toEqual({ status: 'available', version: '1.1.9' });
  });

  test('a determinate --version failure is the ONE answer that says unavailable', () => {
    const answer = interpretDiscoveryProbe(ANTIGRAVITY_DISCOVERY, {
      ok: false,
      status: 'not-found',
      transient: false,
      output: 'agy: command not found',
      code: 'ENOENT',
    });
    expect(answer.status).toBe('unavailable');
  });

  test('the capability probe is `agy models` under a bounded deadline', () => {
    expect([...ANTIGRAVITY_MODELS_PROBE.args]).toEqual(['models']);
    expect(ANTIGRAVITY_MODELS_PROBE.timeoutMs).toBe(ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS);
    expect(ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    // Informational, so it must never hold a phase open for long.
    expect(ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  test('a listing parses into opaque display names', () => {
    const answer = interpretAntigravityModelsProbe({
      ok: true,
      status: 'available',
      transient: false,
      output: 'Gemini 3.1 Pro (Low)\n\nGemini 3.1 Pro (High)\n',
    });
    expect(answer.status).toBe('listed');
    expect([...answer.models]).toEqual(['Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)']);
    // A listing the bound never cut carries no truncation mark.
    expect(answer.truncated).toBeUndefined();
  });

  test('a chatty CLI cannot flood the record', () => {
    const answer = interpretAntigravityModelsProbe({
      ok: true,
      status: 'available',
      transient: false,
      output: Array.from({ length: 500 }, (_, i) => `model-${i}`).join('\n'),
    });
    expect(answer.models.length).toBe(ANTIGRAVITY_MAX_DISCOVERED_MODELS);
    expect(answer.detail).toMatch(/only the first/);
    // The completeness fact is typed, not only prose: a consumer that must
    // suppress absence-based checks on a truncated inventory cannot be made
    // to parse `detail` for it (issue #914 review).
    expect(answer.truncated).toBe(true);
  });

  test('a capability-probe failure is UNDISCOVERED, never unavailable', () => {
    // The distinction the acceptance criteria turns on: a build with no
    // `models` subcommand is a perfectly installed CLI whose capabilities this
    // loop simply could not read.
    const answer = interpretAntigravityModelsProbe({
      ok: false,
      status: 'non-zero-exit',
      transient: false,
      output: 'unknown command "models"',
      exitCode: 2,
    });
    expect(answer.status).toBe('undiscovered');
    expect(ANTIGRAVITY_MODEL_DISCOVERY_STATUSES).not.toContain('unavailable');
    expect(answer.detail).toMatch(/unknown command "models"/);
  });

  test('a CLI that answers with no names is undiscovered, not an empty capability list', () => {
    const answer = interpretAntigravityModelsProbe({
      ok: true,
      status: 'available',
      transient: false,
      output: '   \n\n',
    });
    expect(answer.status).toBe('undiscovered');
    expect(answer.models).toBeUndefined();
  });

  test('a transiently unprobeable host is indeterminate on both probes', () => {
    const transient = {
      ok: false,
      status: 'spawn-error',
      transient: true,
      output: 'EAGAIN',
      code: 'EAGAIN',
    };
    expect(interpretDiscoveryProbe(ANTIGRAVITY_DISCOVERY, transient).status).toBe('indeterminate');
    expect(interpretAntigravityModelsProbe(transient).status).toBe('indeterminate');
    // The probe deadline lands in the same bucket: a fact about the host.
    expect(
      interpretAntigravityModelsProbe({
        ok: false,
        status: 'timeout',
        transient: true,
        output: '',
        code: 'ETIMEDOUT',
      }).status,
    ).toBe('indeterminate');
  });

  test('a listed model is never a gate: an unlisted model still resolves', () => {
    // §11.3 / §6.2 — the descriptor declares `model` as "free" and the CLI is
    // the judge at run time, so discovery cannot refuse a configured model.
    const catalog = catalogWithGoogleProfile('agy-unlisted', {
      model: 'Gemini 9 Ultra (Max)',
    });
    expect(argsOf({ catalog })).toContain('Gemini 9 Ultra (Max)');
  });
});

describe('antigravity runtime adapter — the reported resolution (§13.2)', () => {
  test('the report names the requested quality, the profile, and each value’s source', () => {
    const { resolved } = plan({ quality: quality('maximum', 'label') });
    const report = describeAntigravityRuntime(resolved);
    expect(report).toMatchObject({
      provider: 'google',
      requestedQuality: 'maximum',
      requestedQualitySource: 'label',
      effectiveQuality: 'maximum',
      effectiveQualitySource: 'label',
      profileName: 'agy-maximum',
      profileSource: 'catalog-builtin',
      binary: 'agy',
      binarySource: 'default',
      modelSource: 'cli-default',
      printTimeout: '15m',
      printTimeoutSource: 'catalog-builtin',
    });
    expect(report.model).toBeUndefined();
    expect(report.catalogDigest).toBe(resolved.catalogDigest);
    expect([...report.sharedWithQualityLevels]).toEqual([]);
  });

  test('an escalated run keeps the request it was asked for alongside the level that ran', () => {
    const escalated = {
      quality: 'strong',
      source: 'escalation',
      requested: { quality: 'normal', source: 'default' },
      escalationFloor: 'strong',
    };
    const report = describeAntigravityRuntime(plan({ quality: escalated }).resolved);
    expect(report.requestedQuality).toBe('normal');
    expect(report.effectiveQuality).toBe('strong');
    expect(report.effectiveQualitySource).toBe('escalation');
    expect(report.profileName).toBe('agy-strong');
  });

  test('an unprobed CLI adds nothing, and an indeterminate probe adds no version', () => {
    const { resolved } = plan();
    const bare = describeAntigravityRuntime(resolved);
    expect(bare.cliStatus).toBeUndefined();
    expect(bare.cliVersion).toBeUndefined();
    expect(bare.modelDiscoveryStatus).toBeUndefined();

    const probed = describeAntigravityRuntime(resolved, {
      discovery: { status: 'indeterminate', detail: 'EAGAIN' },
      models: { status: 'undiscovered', detail: 'unknown command' },
    });
    expect(probed.cliStatus).toBe('indeterminate');
    expect(probed.cliVersion).toBeUndefined();
    // Recorded as its own answer, so a failed listing can never be read back as
    // an unavailable agent.
    expect(probed.modelDiscoveryStatus).toBe('undiscovered');
  });

  test('an absent print timeout is reported as the CLI default, never as a value', () => {
    const catalog = catalogWithGoogleProfile('agy-bare', {});
    const report = describeAntigravityRuntime(plan({ catalog }).resolved);
    expect(report.printTimeout).toBeUndefined();
    expect(report.printTimeoutSource).toBe('cli-default');
  });
});

describe('antigravity runtime adapter — §14.3, no provider catalog in the type system', () => {
  const file = readFileSync(resolve(ROOT, 'src/core/antigravity-runtime-adapter.ts'), 'utf8');
  /**
   * The pins below are about what the CODE does, so comments are stripped
   * first: the module deliberately explains itself with a model display name
   * and with the environment chain it replaces, and prose that names a thing is
   * the opposite of source that depends on it.
   */
  const source = file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('the adapter names no model, so a model refresh stays a catalog edit', () => {
    expect(source).not.toMatch(/["'`]Gemini[^"'`]*["'`]/);
    expect(source).not.toMatch(/MODELS\s*[:=]\s*\[/);
    // The one place a model reaches argv is verbatim, straight from the
    // resolution — never through a table, a normalizer, or an alias.
    expect(source).toMatch(/args\.push\(MODEL_FLAG, model\)/);
  });

  test('the adapter declares no reasoning-effort vocabulary — this provider has none', () => {
    for (const effort of ['"low"', '"medium"', '"high"', '"xhigh"', '"max"']) {
      expect(source).not.toContain(effort);
    }
    // It refuses a resolved effort rather than mapping or defaulting one.
    expect(source).not.toMatch(/effort\s*\?\?/);
    expect(source).toMatch(/refuseResolvedEffort\(resolved\)/);
  });

  test('the adapter re-derives nothing from labels or the session (§7 rule 2)', () => {
    expect(source).not.toMatch(/complexity:/);
    expect(source).not.toMatch(/review:high/);
    expect(source).not.toMatch(/session\./);
    expect(source).not.toMatch(/AntigravityResearchConfig|ResolvedSession/);
  });

  test('the adapter imports no process, filesystem, or network machinery', () => {
    const imports = [...source.matchAll(/from "([^"]+)";/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(
      new Set([
        './agent-runtime-adapter.js',
        './agent-profile-catalog.js',
        './agent-quality.js',
        './antigravity-print-timeout.js',
        './cli-probe.js',
      ]),
    );
    expect(source).not.toMatch(/execFile|execSync|spawnSync|require\(/);
    // The binary is resolved by the boundary from the injected environment; the
    // adapter reads no ambient variable of its own.
    expect(source).not.toMatch(/process\.env/);
  });
});
