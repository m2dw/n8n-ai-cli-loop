/**
 * The Codex runtime profile adapter (issue #908) — the `openai` provider
 * adapter of slice B3 of docs/agent-runtime-profiles-contract.md §14.1.
 *
 * The boundary these plug into is pinned by test/agent-runtime-adapter.test.js
 * (#906) and the sibling provider adapter by test/claude-runtime-adapter.test.js
 * (#907); what is pinned here is this provider's half:
 *
 *   - the four quality levels resolve through the `openai` bindings, and the two
 *     levels bound to one profile are a declared configuration, not a downgrade;
 *   - the four Codex lanes produce the argv the shipped runners produce today,
 *     with the one ordering rule every Codex lane follows — globals before the
 *     subcommand, `-c` overrides after it — applied in one place;
 *   - the sandbox/approval pins and the subcommand are properties of the lane
 *     and never of a profile;
 *   - the accepted reasoning-effort values come from the capability descriptor,
 *     so an installation that accepts a further tier resolves it verbatim and a
 *     high-only installation REFUSES it — the adapter never clamps, which is the
 *     obsolete assumption this slice retires;
 *   - the two break-glass variables override one field each and stay
 *     capability-checked;
 *   - an absent model or effort passes no flag at all, and a budget no Codex
 *     lane can express is declared `not-applicable`, never dropped;
 *   - every value the Codex CLI would misparse refuses BEFORE a billable run;
 *   - context-mode reaches the adapter already resolved by its caller and is
 *     only placed, never guessed (issue #376) — and it may not reach a setting
 *     the adapter itself resolves and emits;
 *   - a run-owned output path is one argv element, so its spaces survive.
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  CLAUDE_RUNTIME_ADAPTER,
  CODEX_DEFAULT_BINARY,
  CODEX_DISCOVERY,
  CODEX_ENV_OVERRIDES,
  CODEX_LANES,
  CODEX_LANE_SPECS,
  CODEX_PROVIDER,
  CODEX_READ_BOUNDED_EXEC_ARGS,
  CODEX_RUNTIME_ADAPTER,
  CODEX_STRUCTURED_EXEC_ARGS,
  QUALITY_LEVELS,
  buildEffectiveAgentProfileCatalog,
  codexInvocationRequest,
  createAgentRuntimeAdapterRegistry,
  createCodexRuntimeAdapter,
  describeCodexRuntime,
  interpretDiscoveryProbe,
  isAgentRuntimeConfigurationError,
  isCodexLane,
  planAgentInvocation,
  resolveAgentRuntime,
} from '../dist/index.js';
import { CODEX_STRUCTURED_REVIEW_EXEC_ARGS } from '../dist/handlers/codex-structured-review.js';
import { RECONSIDERATION_READ_BOUNDED_ARGS } from '../dist/handlers/review-reconsideration.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The effective built-in catalog — exactly what a phase start with no overlay sees. */
const CATALOG = buildEffectiveAgentProfileCatalog(undefined);

/**
 * An overlay declaring a fourth reasoning tier and binding `maximum` to it — the
 * operator edit §6.2 prescribes for an installation whose Codex/model
 * combination accepts one. Nothing in `src/` names the value; it exists here,
 * as catalog data, exactly as it would in an operator's agent-profiles.json.
 */
const XHIGH_CATALOG = buildEffectiveAgentProfileCatalog({
  schemaVersion: 1,
  providers: {
    openai: {
      capabilities: { effort: ['low', 'medium', 'high', 'xhigh'] },
      profiles: { 'codex-xhigh': { effort: 'xhigh' } },
      qualityBindings: { maximum: 'codex-xhigh' },
    },
  },
});

/** The agent→provider mapping a composition root injects, in its fail-open shape. */
function providerForAgent(agentId) {
  if (agentId === 'claude') return 'anthropic';
  if (agentId === 'codex') return 'openai';
  if (agentId === 'gemini') return 'google';
  return agentId;
}

const REGISTRY = createAgentRuntimeAdapterRegistry({
  adapters: [CLAUDE_RUNTIME_ADAPTER, CODEX_RUNTIME_ADAPTER],
  providerForAgent,
});

function quality(level, source = 'default') {
  return { quality: level, source, requested: { quality: level, source } };
}

/** One planned invocation. `codex` carries this provider's lane inputs. */
function plan({ codex, ...overrides } = {}) {
  const request = {
    agentId: 'codex',
    lane: 'implementation',
    quality: quality('normal'),
    catalog: CATALOG,
    env: {},
    ...overrides,
  };
  return planAgentInvocation(REGISTRY, codex ? codexInvocationRequest(request, codex) : request);
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

/** A catalog whose openai profile carries one hand-planted setting value. */
function catalogWithOpenAiProfile(profileName, settings, capabilities) {
  return buildEffectiveAgentProfileCatalog({
    schemaVersion: 1,
    providers: {
      openai: {
        ...(capabilities ? { capabilities } : {}),
        profiles: { [profileName]: settings },
        // The built-in `normal` binding targets `codex-high` since the
        // write-capable cutover (issue #911); retarget it so the hand-planted
        // profile is the one the default `normal` request resolves.
        qualityBindings: { normal: profileName },
      },
    },
  });
}

describe('codex runtime adapter — provider identity (§3, §7.1)', () => {
  test('registers under the catalog provider key, never under an agent id', () => {
    expect(CODEX_PROVIDER).toBe('openai');
    expect(CODEX_RUNTIME_ADAPTER.provider).toBe('openai');
    expect(REGISTRY.providers).toEqual(['anthropic', 'openai']);
    expect(REGISTRY.adapterForAgent('codex')).toBe(CODEX_RUNTIME_ADAPTER);
    expect(REGISTRY.hasAdapterForAgent('codex')).toBe(true);
  });

  test('registering the adapter under the agent id is a composition-root defect', () => {
    const err = captureError(() =>
      createAgentRuntimeAdapterRegistry({
        adapters: [{ ...CODEX_RUNTIME_ADAPTER, provider: 'codex' }],
        providerForAgent,
      }),
    );
    expect(err.name).toBe('AgentRuntimeContractViolationError');
    expect(err.message).toMatch(/is an agent id, not a provider/);
  });

  test('the default binary is the fixed codex every shipped lane runs', () => {
    expect(CODEX_DEFAULT_BINARY).toBe('codex');
    expect(CODEX_RUNTIME_ADAPTER.defaultBinary).toBe('codex');
    const { resolved, invocation } = plan();
    expect(resolved.binary).toEqual({ value: 'codex', source: 'default' });
    expect(invocation.command).toBe('codex');
  });

  test('createCodexRuntimeAdapter builds an independent frozen adapter', () => {
    const built = createCodexRuntimeAdapter();
    expect(built).not.toBe(CODEX_RUNTIME_ADAPTER);
    expect(built.provider).toBe(CODEX_RUNTIME_ADAPTER.provider);
    expect(Object.isFrozen(built)).toBe(true);
  });
});

describe('codex runtime adapter — the quality bindings (§5, §6.3)', () => {
  test('all four levels resolve, and the shared binding is declared, not silent', () => {
    const byLevel = {};
    for (const level of QUALITY_LEVELS) {
      byLevel[level] = resolveAgentRuntime(CODEX_RUNTIME_ADAPTER, {
        agentId: 'codex',
        quality: quality(level),
        catalog: CATALOG,
        env: {},
      });
    }
    expect(byLevel.light.profileName).not.toBe(byLevel.normal.profileName);
    // normal, strong, and maximum share one profile since the write-capable
    // cutover retargeted `normal` to `codex-high` (issue #911): configuration,
    // visible before any run, and reported as such — never a runtime
    // downgrade (§6.3).
    expect(byLevel.normal.profileName).toBe(byLevel.strong.profileName);
    expect(byLevel.maximum.profileName).toBe(byLevel.strong.profileName);
    expect([...byLevel.maximum.sharedWithQualityLevels]).toEqual(['normal', 'strong']);
    expect([...byLevel.strong.sharedWithQualityLevels]).toEqual(['normal', 'maximum']);
    expect([...byLevel.normal.sharedWithQualityLevels]).toEqual(['strong', 'maximum']);
    expect(byLevel.maximum.quality.requested.quality).toBe('maximum');
  });

  test('no built-in profile names a model, so the CLI default applies (§13.3)', () => {
    for (const level of QUALITY_LEVELS) {
      const resolved = resolveAgentRuntime(CODEX_RUNTIME_ADAPTER, {
        agentId: 'codex',
        quality: quality(level),
        catalog: CATALOG,
        env: {},
      });
      // An absence, never the string "default".
      expect(resolved.model).toEqual({ source: 'cli-default' });
      expect(resolved.effort.value).toEqual(expect.any(String));
    }
  });

  test('the provider declares no budget, so a budget is not-applicable, not absent-by-accident', () => {
    const resolved = resolveAgentRuntime(CODEX_RUNTIME_ADAPTER, {
      agentId: 'codex',
      quality: quality('normal'),
      catalog: CATALOG,
      env: {},
    });
    expect(resolved.budget).toEqual({ source: 'not-applicable' });
    expect(plan().invocation.budgetApplied).toBeUndefined();
  });

  test('a budget an operator declared is reported not-applicable, never dropped (§7 rule 1)', () => {
    // An overlay may widen the descriptor; no Codex lane has a budget flag, so
    // the plan must SAY the budget could not be applied.
    const catalog = catalogWithOpenAiProfile('codex-normal', { budget: '10' }, { budget: 'free' });
    for (const lane of CODEX_LANES) {
      const { invocation } = plan({
        lane,
        catalog,
        ...(lane === 'review' ? { codex: { baseBranch: 'main' } } : {}),
      });
      expect(invocation.budgetApplied).toBe('not-applicable');
      expect(invocation.args).not.toContain('10');
    }
  });
});

describe('codex runtime adapter — the lane table (§7, §7.3)', () => {
  test('the served lanes are the four the shipped runners invoke', () => {
    expect([...CODEX_LANES]).toEqual(['implementation', 'review', 'structured_exec', 'read_bounded']);
    for (const lane of CODEX_LANES) {
      expect(isCodexLane(lane)).toBe(true);
      expect(CODEX_LANE_SPECS[lane].lane).toBe(lane);
      // Not one Codex lane can express a per-run budget cap.
      expect(CODEX_LANE_SPECS[lane].budget).toBe('not-applicable');
    }
    expect(isCodexLane('conflict_resolution')).toBe(false);
  });

  test('an unrecognized lane refuses rather than inheriting a less bounded shape', () => {
    expectRefusal(
      () => plan({ lane: 'conflict_resolution' }),
      'unsupported-setting',
      /has no invocation for lane "conflict_resolution"/,
    );
  });

  test('implementation runs plain `codex exec` with effort after the subcommand', () => {
    expect(argsOf()).toEqual(['exec', '-c', expect.stringMatching(/^model_reasoning_effort=/)]);
  });

  test('review runs `codex review --base <branch>`, base branch supplied by the lane', () => {
    const args = argsOf({ lane: 'review', codex: { baseBranch: 'main' } });
    expect(args.slice(0, 3)).toEqual(['review', '--base', 'main']);
    expect(args[3]).toBe('-c');
  });

  test('the review lane needs its base branch, and no other lane may carry one', () => {
    expectContractViolation(() => plan({ lane: 'review' }), /names the PR base branch/);
    expectContractViolation(
      () => plan({ lane: 'implementation', codex: { baseBranch: 'main' } }),
      /has no --base option/,
    );
  });

  test('the read-bounded posture is the one the shipped runners pin, flag for flag', () => {
    // Same list, same order, as the shipped runners' own constants — a second
    // literal list would be two lanes claiming one rule while pinning different
    // postures. The runners import this one rather than restating it.
    expect([...CODEX_STRUCTURED_EXEC_ARGS]).toEqual([...CODEX_STRUCTURED_REVIEW_EXEC_ARGS]);
    expect([...CODEX_STRUCTURED_EXEC_ARGS]).toEqual([...RECONSIDERATION_READ_BOUNDED_ARGS]);
    expect([...CODEX_READ_BOUNDED_EXEC_ARGS]).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
    ]);
    expect(argsOf({ lane: 'read_bounded' }).slice(0, 5)).toEqual([...CODEX_READ_BOUNDED_EXEC_ARGS]);
  });

  test('structured_exec splices its run-owned paths between the subcommand and the overrides', () => {
    const args = argsOf({
      lane: 'structured_exec',
      codex: { lastMessagePath: '/tmp/run/last.txt', outputSchemaPath: '/tmp/run/schema.json' },
    });
    expect(args).toEqual([
      ...CODEX_STRUCTURED_EXEC_ARGS,
      '--output-last-message',
      '/tmp/run/last.txt',
      '--output-schema',
      '/tmp/run/schema.json',
      '-c',
      expect.stringMatching(/^model_reasoning_effort=/),
    ]);
  });

  test('the paths are optional, so the same lane builds the sanitized argv too', () => {
    expect(argsOf({ lane: 'structured_exec' })).toEqual([
      ...CODEX_STRUCTURED_EXEC_ARGS,
      '-c',
      expect.stringMatching(/^model_reasoning_effort=/),
    ]);
  });

  test('a path a lane cannot read refuses instead of being emitted anyway', () => {
    expectContractViolation(
      () => plan({ lane: 'implementation', codex: { lastMessagePath: '/tmp/x' } }),
      /reads no final-message file/,
    );
    expectContractViolation(
      () => plan({ lane: 'read_bounded', codex: { outputSchemaPath: '/tmp/x' } }),
      /pins no response schema/,
    );
  });

  test('a flag-shaped lane input refuses before it can change the invocation', () => {
    expectContractViolation(
      () => plan({ lane: 'review', codex: { baseBranch: '--sandbox' } }),
      /starts with "-"/,
    );
    expectContractViolation(
      () => plan({ lane: 'structured_exec', codex: { lastMessagePath: '--output-schema' } }),
      /starts with "-"/,
    );
    expectContractViolation(
      () => plan({ lane: 'structured_exec', codex: { lastMessagePath: '/tmp/run/last\nx.txt' } }),
      /carries control characters/,
    );
  });

  test('a base branch is a git ref, so whitespace in one is a malformed ref', () => {
    expectContractViolation(
      () => plan({ lane: 'review', codex: { baseBranch: 'release 2' } }),
      /carries whitespace, which a git ref cannot hold/,
    );
    // Surrounding whitespace on a ref is never meaningful, so it is trimmed.
    expect(argsOf({ lane: 'review', codex: { baseBranch: '  main  ' } }).slice(0, 3)).toEqual([
      'review',
      '--base',
      'main',
    ]);
  });

  test('a run-owned path keeps its spaces: each is one argv element, never shell-split', () => {
    // The shipped structured reviewer already passes artifact paths verbatim,
    // and an artifact directory under a path with a space is an ordinary one.
    const lastMessagePath = '/tmp/review files/final-message.txt';
    const outputSchemaPath = '/tmp/review files/schema .json';
    expect(argsOf({ lane: 'structured_exec', codex: { lastMessagePath, outputSchemaPath } })).toEqual([
      ...CODEX_STRUCTURED_EXEC_ARGS,
      '--output-last-message',
      lastMessagePath,
      '--output-schema',
      outputSchemaPath,
      '-c',
      expect.stringMatching(/^model_reasoning_effort=/),
    ]);
    // Preserved exactly: trimming one would rename the file the run then reads.
    const padded = '/tmp/run/last.txt ';
    expect(argsOf({ lane: 'structured_exec', codex: { lastMessagePath: padded } })).toContain(padded);
    // A blank path still names no file at all.
    expectContractViolation(
      () => plan({ lane: 'structured_exec', codex: { lastMessagePath: '   ' } }),
      /must be a non-empty string/,
    );
  });

  test('the sandbox pins are a property of the lane, unreachable from a profile', () => {
    // An overlay may retarget model, effort, and binary; it cannot reach the
    // posture flags, and it cannot displace them from their position.
    const catalog = catalogWithOpenAiProfile('codex-normal', { model: 'operator-choice' });
    const args = argsOf({ lane: 'read_bounded', catalog });
    expect(args.slice(0, 2)).toEqual(['--model', 'operator-choice']);
    expect(args.slice(2, 7)).toEqual([...CODEX_READ_BOUNDED_EXEC_ARGS]);
  });
});

describe('codex runtime adapter — the ordering rule (§7.3)', () => {
  test('--model is a GLOBAL option and precedes the subcommand on every lane', () => {
    const catalog = catalogWithOpenAiProfile('codex-normal', { model: 'operator-choice' });
    for (const lane of CODEX_LANES) {
      const args = argsOf({
        lane,
        catalog,
        ...(lane === 'review' ? { codex: { baseBranch: 'main' } } : {}),
      });
      expect(args.slice(0, 2)).toEqual(['--model', 'operator-choice']);
      expect(args.indexOf('--model')).toBeLessThan(args.indexOf(CODEX_LANE_SPECS[lane].subcommandArgs[0]));
    }
  });

  test('a context-mode profile is global; its -c overrides follow the effort override', () => {
    const args = argsOf({
      lane: 'review',
      codex: {
        baseBranch: 'main',
        contextMode: { profile: 'ctx', config: ['context_mode=on', 'other_key=2'] },
      },
    });
    expect(args).toEqual([
      '--profile',
      'ctx',
      'review',
      '--base',
      'main',
      '-c',
      expect.stringMatching(/^model_reasoning_effort=/),
      '-c',
      'context_mode=on',
      '-c',
      'other_key=2',
    ]);
  });

  test('a lane with no place for a context-mode form refuses one rather than dropping it', () => {
    expectRefusal(
      () => plan({ lane: 'read_bounded', codex: { contextMode: { config: ['context_mode=on'] } } }),
      'unsupported-setting',
      /has no place for a context-mode form/,
    );
    // An empty form is not a configured one, so it is simply absent.
    expect(argsOf({ lane: 'read_bounded', codex: { contextMode: {} } })).toEqual(
      argsOf({ lane: 'read_bounded' }),
    );
  });

  test('a malformed context-mode override refuses with an operator-actionable reason', () => {
    expectRefusal(
      () => plan({ codex: { contextMode: { config: ['context_mode'] } } }),
      'unsupported-value',
      /is not a key=value the CLI accepts after -c/,
    );
    expectRefusal(
      () => plan({ codex: { contextMode: { profile: '--sandbox' } } }),
      'unsupported-value',
      /is not a value the CLI can take in one token after --profile/,
    );
  });

  test('a context-mode override of an adapter-owned setting refuses, never wins by position', () => {
    // Codex takes the last `-c` value and context-mode entries are emitted
    // last, so accepting this would report `high` from the break-glass variable
    // while running `low` — a value that passed no capability check and reached
    // argv from below the §8.1 precedence ladder.
    const effort = expectRefusal(
      () =>
        plan({
          env: { CODEX_EFFORT: 'high' },
          codex: { contextMode: { config: ['model_reasoning_effort=low'] } },
        }),
      'unsupported-setting',
      /sets the effort, which the runtime profile resolves and this adapter emits/,
    );
    expect(effort.message).toMatch(/CODEX_EFFORT/);
    const model = expectRefusal(
      () => plan({ codex: { contextMode: { config: ['model=some-other-model'] } } }),
      'unsupported-setting',
      /sets the model, which the runtime profile resolves and this adapter emits/,
    );
    expect(model.message).toMatch(/CODEX_MODEL/);
    // The key match is case-insensitive: a near-miss spelling fails closed
    // rather than sneaking the same override past the check.
    expectRefusal(
      () => plan({ codex: { contextMode: { config: ['Model_Reasoning_Effort=low'] } } }),
      'unsupported-setting',
      /sets the effort/,
    );
    // A lane that resolved no effort at all is no opening either: the setting
    // is adapter-owned whether or not this resolution emitted a value for it.
    const noEffort = catalogWithOpenAiProfile('codex-normal', { effort: null });
    expectRefusal(
      () => plan({ catalog: noEffort, codex: { contextMode: { config: ['model_reasoning_effort=low'] } } }),
      'unsupported-setting',
      /sets the effort/,
    );
    // Every other context-mode key is still the operator's to set.
    expect(argsOf({ codex: { contextMode: { config: ['model_context_window=1'] } } })).toContain(
      'model_context_window=1',
    );
  });
});

describe('codex runtime adapter — capability descriptors, never a clamp (§6.2, §12.3)', () => {
  test('a high-only installation REFUSES a stronger tier instead of lowering it', () => {
    // The catalog fixture is today's built-in three-value list. The override
    // names a tier it does not declare: refused with the variable named, and
    // never resolved to the strongest declared value.
    const err = expectRefusal(
      () => plan({ env: { CODEX_EFFORT: 'xhigh' } }),
      'invalid-override',
      /CODEX_EFFORT="xhigh" is not accepted by provider "openai"/,
    );
    expect(err.message).toMatch(/declared: low, medium, high/);
  });

  test('an installation that declares the stronger tier resolves it verbatim', () => {
    const { resolved, invocation } = plan({ catalog: XHIGH_CATALOG, env: { CODEX_EFFORT: 'xhigh' } });
    expect(resolved.effort).toEqual({ value: 'xhigh', source: 'env' });
    expect([...invocation.args]).toContain('model_reasoning_effort=xhigh');
  });

  test('a rebound maximum resolves the stronger tier with no env override at all', () => {
    const { resolved, invocation } = plan({ catalog: XHIGH_CATALOG, quality: quality('maximum') });
    expect(resolved.profileName).toBe('codex-xhigh');
    expect(resolved.effort).toEqual({ value: 'xhigh', source: 'catalog-overlay' });
    expect([...invocation.args]).toContain('model_reasoning_effort=xhigh');
    // The overlay rebinding maximum leaves strong where it was: the two are no
    // longer a shared binding.
    expect([...resolved.sharedWithQualityLevels]).toEqual([]);
  });

  test('the same request resolves differently per installation, and nothing is mapped down', () => {
    const highOnly = plan({ quality: quality('maximum') });
    const xhighCapable = plan({ catalog: XHIGH_CATALOG, quality: quality('maximum') });
    expect(highOnly.resolved.effort.value).not.toBe(xhighCapable.resolved.effort.value);
    // Both honored the SAME request; neither substituted a nearby value.
    expect(highOnly.resolved.quality.requested.quality).toBe('maximum');
    expect(xhighCapable.resolved.quality.requested.quality).toBe('maximum');
  });

  test('the two providers keep independent effort vocabularies (§5 rule 2)', () => {
    // The Claude side of the same built-in catalog resolves an effort value the
    // openai descriptor does not declare. Nothing translates between them: the
    // value is simply refused for this provider, and the Claude lane is
    // untouched by this provider's list.
    const claudeMaximum = resolveAgentRuntime(CLAUDE_RUNTIME_ADAPTER, {
      agentId: 'claude',
      quality: quality('maximum'),
      catalog: CATALOG,
      env: {},
    });
    const claudeEffort = claudeMaximum.effort.value;
    expect(claudeEffort).toEqual(expect.any(String));
    expectRefusal(
      () => plan({ env: { CODEX_EFFORT: claudeEffort } }),
      'invalid-override',
      /is not accepted by provider "openai"/,
    );
    // And the other provider's break-glass variable is not this one's.
    expect(argsOf({ env: { CLAUDE_EFFORT: claudeEffort } })).toEqual(argsOf());
  });

  test('an unset effort passes no override, returning the CLI to its own default (§6.1)', () => {
    const catalog = catalogWithOpenAiProfile('codex-normal', { effort: null });
    const { resolved, invocation } = plan({ catalog });
    expect(resolved.effort).toEqual({ source: 'cli-default' });
    expect([...invocation.args]).toEqual(['exec']);
  });
});

describe('codex runtime adapter — break-glass variables (§8.1 layer 1)', () => {
  test('the two declared variables are the ones §1.2 inventoried, one field each', () => {
    expect([...CODEX_ENV_OVERRIDES].map((entry) => [entry.setting, entry.variable])).toEqual([
      ['model', 'CODEX_MODEL'],
      ['effort', 'CODEX_EFFORT'],
    ]);
    // No ambient binary override: another executable is a validated catalog
    // setting, never a trusted environment variable.
    expect([...CODEX_ENV_OVERRIDES].some((entry) => entry.setting === 'binary')).toBe(false);
    expect([...CODEX_ENV_OVERRIDES].some((entry) => entry.setting === 'budget')).toBe(false);
  });

  test('CODEX_MODEL overrides the model and leaves effort resolving normally', () => {
    const { resolved, invocation } = plan({ env: { CODEX_MODEL: 'operator-choice' } });
    expect(resolved.model).toEqual({ value: 'operator-choice', source: 'env' });
    expect(resolved.effort.source).toBe('catalog-builtin');
    expect([...invocation.args].slice(0, 2)).toEqual(['--model', 'operator-choice']);
  });

  test('an empty break-glass variable refuses rather than reading as unset', () => {
    expectRefusal(() => plan({ env: { CODEX_MODEL: '' } }), 'invalid-override', /set but empty/);
  });

  test('a pinned profile the provider does not declare refuses, never falls through', () => {
    expectRefusal(
      () => plan({ sessionPinnedProfile: 'codex-not-a-profile' }),
      'unknown-profile',
      /which provider "openai" does not declare/,
    );
  });
});

describe('codex runtime adapter — pre-invocation validation (§12.1)', () => {
  test('a flag-shaped model refuses before a billable run, naming where it came from', () => {
    const catalog = catalogWithOpenAiProfile('codex-normal', { model: '--sandbox' });
    const err = expectRefusal(() => plan({ catalog }), 'unsupported-value', /starts with "-"/);
    // The message points at the file the value came from, not at the resolution.
    expect(err.message).toMatch(/codex-normal/);
    expect(err.message).toMatch(/overlay/);
  });

  test('a model carrying a newline refuses (the flag cannot hold it)', () => {
    expectRefusal(
      () => plan({ env: { CODEX_MODEL: 'two\nlines' } }),
      'invalid-override',
      /must not contain control characters/,
    );
  });

  test('a flag-shaped binary refuses', () => {
    const catalog = catalogWithOpenAiProfile('codex-normal', { binary: '-x' }, { binary: 'free' });
    expectRefusal(() => plan({ catalog }), 'unsupported-value', /the resolved binary "-x" starts with "-"/);
  });

  test('a provider option the Codex invocation has no place for refuses', () => {
    const catalog = catalogWithOpenAiProfile(
      'codex-normal',
      { providerOptions: { printTimeout: '30m' } },
      { providerOptions: ['printTimeout'] },
    );
    expectRefusal(
      () => plan({ catalog }),
      'unsupported-setting',
      /carries provider options \(printTimeout\) that the Codex adapter has no invocation for/,
    );
  });
});

describe('codex runtime adapter — the prompt reaches the CLI on stdin, verbatim', () => {
  test('every lane delivers the prompt on stdin and never as an argv element', () => {
    const prompt = 'review this\n\nwith a blank line';
    for (const lane of CODEX_LANES) {
      const { invocation } = plan({
        lane,
        prompt,
        ...(lane === 'review' ? { codex: { baseBranch: 'main' } } : {}),
      });
      expect(invocation.promptDelivery).toBe('stdin');
      expect(invocation.stdin).toBe(prompt);
      expect([...invocation.args]).not.toContain(prompt);
    }
  });

  test('a request with no prompt declares no delivery', () => {
    const { invocation } = plan();
    expect(invocation.promptDelivery).toBe('none');
    expect(invocation.stdin).toBeUndefined();
  });
});

describe('codex runtime adapter — discovery and the reported resolution (§7.1, §11.3, §13.2)', () => {
  test('the probe asks only for a version banner', () => {
    expect([...CODEX_DISCOVERY.args]).toEqual(['--version']);
  });

  test('a version banner parses into a version, and never into a capability', () => {
    const discovery = interpretDiscoveryProbe(CODEX_DISCOVERY, {
      ok: true,
      status: 'available',
      output: 'codex-cli 0.48.0',
      transient: false,
    });
    expect(discovery.status).toBe('available');
    expect(discovery.version).toBe('0.48.0');
    expect(discovery.capabilities).toBeUndefined();
  });

  test('a transiently unprobeable host is indeterminate, never unavailable', () => {
    expect(
      interpretDiscoveryProbe(CODEX_DISCOVERY, {
        ok: false,
        status: 'spawn-error',
        output: 'EAGAIN',
        transient: true,
      }).status,
    ).toBe('indeterminate');
    expect(
      interpretDiscoveryProbe(CODEX_DISCOVERY, {
        ok: false,
        status: 'not-found',
        output: 'ENOENT',
        transient: false,
      }).status,
    ).toBe('unavailable');
  });

  test('the reported resolution names the effective model/effort and each value’s source', () => {
    const { resolved } = plan({ env: { CODEX_MODEL: 'operator-choice' } });
    const discovery = interpretDiscoveryProbe(CODEX_DISCOVERY, {
      ok: true,
      status: 'available',
      output: 'codex-cli 0.48.0',
      transient: false,
    });
    expect(describeCodexRuntime(resolved, discovery)).toEqual({
      provider: 'openai',
      binary: 'codex',
      binarySource: 'default',
      model: 'operator-choice',
      modelSource: 'env',
      effort: expect.any(String),
      effortSource: 'catalog-builtin',
      cliVersion: '0.48.0',
      cliStatus: 'available',
    });
  });

  test('an absent model stays absent in the report, and an unprobed CLI adds nothing', () => {
    const report = describeCodexRuntime(plan().resolved);
    expect(report.model).toBeUndefined();
    expect(report.modelSource).toBe('cli-default');
    expect(report.cliVersion).toBeUndefined();
    expect(report.cliStatus).toBeUndefined();
  });

  test('an indeterminate probe contributes a status but never a version', () => {
    const report = describeCodexRuntime(plan().resolved, {
      status: 'indeterminate',
      version: '0.48.0',
    });
    expect(report.cliStatus).toBe('indeterminate');
    expect(report.cliVersion).toBeUndefined();
  });
});

describe('codex runtime adapter — §14.3, no provider catalog in the type system', () => {
  const source = readFileSync(resolve(ROOT, 'src/core/codex-runtime-adapter.ts'), 'utf8');

  test('the adapter declares no reasoning-effort vocabulary of its own', () => {
    // The capability descriptor in the catalog is the only place a provider's
    // accepted effort values live; a list here would be the union §14.3 retires,
    // and the ceiling this slice exists to remove.
    for (const effort of ['"low"', '"medium"', '"high"', '"xhigh"', '"max"']) {
      expect(source).not.toContain(effort);
    }
    expect(source).not.toMatch(/\[\s*"low", "medium", "high"/);
  });

  test('the adapter never maps one effort onto another, and never defaults one', () => {
    // The shipped per-lane chains still map the Claude-only tiers down and
    // default an absent effort; nothing behind the adapter may do either.
    expect(source).not.toMatch(/=== "low" \? "low"/);
    expect(source).not.toMatch(/effort\s*\?\?/);
    // The resolved value is spliced verbatim into the override, once.
    expect(source).toMatch(/\$\{REASONING_EFFORT_KEY\}=\$\{effort\}/);
  });

  test('the adapter re-derives nothing from labels or the session (§7 rule 2)', () => {
    expect(source).not.toMatch(/complexity:/);
    expect(source).not.toMatch(/review:high/);
    expect(source).not.toMatch(/labelsToReviewStrength/);
    // The session resolvers are the caller's; the adapter takes their answer as
    // a lane input and never a session object of its own.
    expect(source).not.toMatch(/resolveCodexContextMode|resolveCodexModel/);
    expect(source).not.toMatch(/CodexConfig/);
  });

  test('the adapter imports no process, filesystem, or network machinery', () => {
    const imports = [...source.matchAll(/from "([^"]+)";/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(new Set(imports)).toEqual(new Set(['./agent-runtime-adapter.js']));
    expect(source).not.toMatch(/execFile|execSync|spawnSync|require\(/);
  });
});
