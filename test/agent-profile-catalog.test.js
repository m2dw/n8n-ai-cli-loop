/**
 * Agent runtime profile catalog — schema, built-in defaults, overlay merge,
 * loader, validator (issue #904, slice B1 of
 * docs/agent-runtime-profiles-contract.md §14.1).
 *
 * The slice adds no runtime behavior: no lane resolves through the catalog
 * yet. What these cover is therefore the data contract itself — that a missing
 * file, a complete file, and a partial override all produce the effective
 * catalog §9.4 describes; that every §12.2 load-time refusal fires before a
 * billable agent invocation could be built from it; that each effective value
 * carries the provenance §13.2's audit record needs; and that the built-in
 * catalog reproduces today's shipped complexity mapping so the eventual cutover
 * (B3) starts from behavior parity.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  AGENT_PROFILES_FILENAME,
  AGENT_PROFILES_FILE_ENV,
  AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
  AGENT_PROFILE_REFUSAL_REASONS,
  AGENT_PROFILE_SETTING_KEYS,
  AgentProfileCatalogError,
  BUILT_IN_AGENT_PROFILE_CATALOG,
  DEFAULT_SESSIONS_PATH,
  QUALITY_LEVELS,
  buildEffectiveAgentProfileCatalog,
  defaultAgentProfilesDir,
  loadAgentProfileCatalog,
  lookupQualityBinding,
  parseAgentProfileCatalogDocument,
  providerCatalogFor,
  resolveAgentProfilesPath,
} from '../dist/index.js';
import { labelsToComplexity } from '../dist/core/github-intake.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SESSIONS_PATH = '/cfg/n8n-ai-cli-loop/sessions.json';
const CATALOG_PATH = '/cfg/n8n-ai-cli-loop/agent-profiles.json';

/** Loads with a stub reader so no test touches the operator's real config dir. */
function load(fileContents, options = {}) {
  return loadAgentProfileCatalog({
    env: {},
    sessionsPath: SESSIONS_PATH,
    readCatalogFile: () => fileContents,
    ...options,
  });
}

/** Loads an overlay object, serialized exactly as an operator file would be. */
function loadOverlay(overlay, options = {}) {
  return load(JSON.stringify(overlay), options);
}

function refusal(fn) {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof AgentProfileCatalogError)) throw err;
    return err;
  }
  throw new Error('expected an AgentProfileCatalogError, but the call succeeded');
}

// ---------------------------------------------------------------------------

describe('agent-profile-catalog — missing file (§9.2 built-in defaults)', () => {
  test('no catalog file at the default location falls back to the built-in catalog', () => {
    const catalog = load(undefined);
    expect(catalog.catalogSource).toBe('builtin');
    expect(catalog.pathSource).toBe('default');
    expect(catalog.catalogPath).toBe(CATALOG_PATH);
    expect(catalog.schemaVersion).toBe(AGENT_PROFILE_CATALOG_SCHEMA_VERSION);
    expect(catalog.catalogVersionSource).toBe('catalog-builtin');
  });

  test('the built-in catalog binds all four levels for all three providers', () => {
    const catalog = load(undefined);
    expect(Object.keys(catalog.providers).sort()).toEqual(['anthropic', 'google', 'openai']);
    for (const provider of Object.keys(catalog.providers)) {
      for (const level of QUALITY_LEVELS) {
        const { binding, profile } = lookupQualityBinding(catalog, provider, level);
        expect(binding.source).toBe('catalog-builtin');
        expect(profile.name).toBe(binding.profileName);
        expect(profile.source).toBe('catalog-builtin');
      }
    }
  });

  test('anthropic reproduces the shipped complexity mapping (behavior preservation)', () => {
    const catalog = load(undefined);
    const cases = [
      { labels: ['complexity:low'], level: 'light' },
      { labels: [], level: 'normal' },
      { labels: ['complexity:high'], level: 'strong' },
      { labels: ['complexity:xhigh'], level: 'maximum' },
    ];
    for (const { labels, level } of cases) {
      const { profile } = lookupQualityBinding(catalog, 'anthropic', level);
      // The shipped resolution site, not a restated table: if labelsToComplexity
      // moves, this fails rather than the catalog silently diverging from it.
      expect({
        model: profile.settings.model,
        effort: profile.settings.effort,
        budget: profile.settings.budget,
      }).toEqual(labelsToComplexity(labels));
    }
  });

  test('openai declares no model and no budget — Codex compatibility mode is an absence', () => {
    const catalog = load(undefined);
    const openai = providerCatalogFor(catalog, 'openai');
    expect(openai.capabilities.budget).toBeUndefined();
    for (const profile of Object.values(openai.profiles)) {
      expect(profile.settings.model).toBeUndefined();
      expect(profile.settings.budget).toBeUndefined();
      expect(profile.settings.effort).toBeDefined();
    }
    expect(openai.capabilities.effort).toEqual(['low', 'medium', 'high']);
  });

  test('openai binds strong and maximum to one profile and declares the sharing (§6.3)', () => {
    const catalog = load(undefined);
    const openai = providerCatalogFor(catalog, 'openai');
    expect(openai.qualityBindings.maximum.profileName).toBe(
      openai.qualityBindings.strong.profileName,
    );
    expect(openai.qualityBindings.maximum.sharedWithQualityLevels).toEqual(['normal', 'strong']);
    expect(openai.qualityBindings.strong.sharedWithQualityLevels).toEqual(['normal', 'maximum']);
    expect(openai.qualityBindings.normal.sharedWithQualityLevels).toEqual(['strong', 'maximum']);
    // A level with its own profile shares with nobody.
    expect(openai.qualityBindings.light.sharedWithQualityLevels).toEqual([]);
  });

  test('google declares no effort key at all — Antigravity folds effort into the model', () => {
    const catalog = load(undefined);
    const google = providerCatalogFor(catalog, 'google');
    expect(google.capabilities.effort).toBeUndefined();
    expect(google.capabilities.providerOptions).toEqual(['printTimeout']);
    for (const level of QUALITY_LEVELS) {
      const { profile } = lookupQualityBinding(catalog, 'google', level);
      // Today's single default print timeout, under four retargetable names.
      expect(profile.settings.providerOptions).toEqual({ printTimeout: '15m' });
    }
  });

  test('the built-in catalog itself passes the operator-file validator', () => {
    expect(() =>
      parseAgentProfileCatalogDocument(BUILT_IN_AGENT_PROFILE_CATALOG, '<built-in>'),
    ).not.toThrow();
  });
});

describe('agent-profile-catalog — complete file (§9.4 overlay)', () => {
  const complete = {
    schemaVersion: 1,
    catalogVersion: '2026-10-01',
    providers: {
      anthropic: {
        capabilities: { model: 'free', effort: ['low', 'high'], budget: 'free', binary: 'free' },
        profiles: {
          'claude-light': { model: 'haiku', effort: 'low', budget: '1' },
          'claude-normal': { model: 'sonnet', effort: 'high', budget: '4' },
          'claude-strong': { model: 'opus', effort: 'high', budget: '9' },
          'claude-maximum': { model: 'fable', effort: 'high', budget: '40' },
        },
        qualityBindings: {
          light: 'claude-light',
          normal: 'claude-normal',
          strong: 'claude-strong',
          maximum: 'claude-maximum',
        },
      },
    },
  };

  test('a complete provider block replaces every value and records the overlay as its source', () => {
    const catalog = loadOverlay(complete);
    expect(catalog.catalogSource).toBe('file');
    expect(catalog.catalogVersion).toBe('2026-10-01');
    expect(catalog.catalogVersionSource).toBe('catalog-overlay');

    const { profile, binding } = lookupQualityBinding(catalog, 'anthropic', 'maximum');
    expect(profile.settings).toEqual({ model: 'fable', effort: 'high', budget: '40' });
    expect(profile.settingSources).toEqual({
      model: 'catalog-overlay',
      effort: 'catalog-overlay',
      budget: 'catalog-overlay',
    });
    expect(binding.source).toBe('catalog-overlay');
  });

  test('a provider the file does not mention keeps its built-in entry entirely', () => {
    const catalog = loadOverlay(complete);
    const builtinOnly = load(undefined);
    expect(catalog.providers.openai).toEqual(builtinOnly.providers.openai);
    expect(catalog.providers.google).toEqual(builtinOnly.providers.google);
  });

  test('a capability list replaces per key, so a value it drops is refused, not lowered', () => {
    // The built-in anthropic effort list accepts xhigh; this file's does not,
    // and claude-maximum below still asks for it.
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { capabilities: { effort: ['low', 'medium', 'high'] } } },
      }),
    );
    expect(err.reason).toBe('unsupported-value');
    expect(err.message).toMatch(/effort "xhigh" is not accepted by provider "anthropic"/);
    expect(err.message).toMatch(/declared: low, medium, high/);
  });
});

describe('agent-profile-catalog — partial override (§9.4)', () => {
  test('a profile merges field by field and keeps its untouched built-in fields', () => {
    const catalog = loadOverlay({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'fable' } } } },
    });
    const { profile } = lookupQualityBinding(catalog, 'anthropic', 'strong');
    expect(profile.settings).toEqual({ model: 'fable', effort: 'high', budget: '10' });
    expect(profile.settingSources).toEqual({
      model: 'catalog-overlay',
      effort: 'catalog-builtin',
      budget: 'catalog-builtin',
    });
  });

  test('a field set to null is explicitly unset and stays visible as an operator decision', () => {
    const catalog = loadOverlay({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-normal': { model: null } } } },
    });
    const { profile } = lookupQualityBinding(catalog, 'anthropic', 'normal');
    expect(profile.settings.model).toBeUndefined();
    expect(profile.settingSources.model).toBeUndefined();
    expect(profile.unsetByOverlay).toEqual(['model']);
    // The other fields are untouched — null unsets one field, never the profile.
    expect(profile.settings.effort).toBe('high');
  });

  test('a binding replaces one level and leaves the other three alone', () => {
    const catalog = loadOverlay({
      schemaVersion: 1,
      providers: {
        openai: {
          profiles: { 'codex-xhigh': { effort: 'high' } },
          qualityBindings: { maximum: 'codex-xhigh' },
        },
      },
    });
    const openai = providerCatalogFor(catalog, 'openai');
    expect(openai.qualityBindings.maximum).toMatchObject({
      profileName: 'codex-xhigh',
      source: 'catalog-overlay',
      sharedWithQualityLevels: [],
    });
    expect(openai.qualityBindings.strong).toMatchObject({
      profileName: 'codex-high',
      source: 'catalog-builtin',
      // With `maximum` retargeted away, `strong` still shares `codex-high`
      // with the built-in `normal` binding (issue #911's data edit).
      sharedWithQualityLevels: ['normal'],
    });
    expect(openai.qualityBindings.light.profileName).toBe('codex-light');
    expect(openai.qualityBindings.normal.profileName).toBe('codex-high');
    // The built-in profile the binding used to name is still declared: an
    // overlay adds and retargets, it never deletes.
    expect(openai.profiles['codex-high']).toBeDefined();
  });

  test('the documented smallest override file is valid when the profile it names is declared', () => {
    const smallest = {
      schemaVersion: 1,
      providers: { openai: { qualityBindings: { maximum: 'codex-xhigh' } } },
    };
    const err = refusal(() => loadOverlay(smallest));
    expect(err.reason).toBe('unknown-profile');

    smallest.providers.openai.profiles = { 'codex-xhigh': { effort: 'high' } };
    expect(
      providerCatalogFor(loadOverlay(smallest), 'openai').qualityBindings.maximum.profileName,
    ).toBe('codex-xhigh');
  });

  test('providerOptions merge by key, with null unsetting exactly one option', () => {
    const catalog = loadOverlay({
      schemaVersion: 1,
      providers: {
        google: {
          capabilities: { providerOptions: ['printTimeout', 'sandbox'] },
          profiles: {
            'agy-maximum': { providerOptions: { printTimeout: '30m', sandbox: 'strict' } },
            'agy-light': { providerOptions: { printTimeout: null } },
          },
        },
      },
    });
    const google = providerCatalogFor(catalog, 'google');
    expect(google.profiles['agy-maximum'].settings.providerOptions).toEqual({
      printTimeout: '30m',
      sandbox: 'strict',
    });
    expect(google.profiles['agy-maximum'].providerOptionSources).toEqual({
      printTimeout: 'catalog-overlay',
      sandbox: 'catalog-overlay',
    });
    expect(google.profiles['agy-light'].settings.providerOptions).toBeUndefined();
    expect(google.profiles['agy-light'].unsetByOverlay).toEqual(['providerOptions.printTimeout']);
    // Untouched profiles keep the built-in option and its provenance.
    expect(google.profiles['agy-normal'].providerOptionSources).toEqual({
      printTimeout: 'catalog-builtin',
    });
  });

  test('an overlay may add a provider the built-in catalog never declared', () => {
    const catalog = loadOverlay({
      schemaVersion: 1,
      providers: {
        'acme-ai': {
          capabilities: { model: 'free' },
          profiles: { fast: { model: 'acme-1' }, slow: { model: 'acme-2' } },
          qualityBindings: { light: 'fast', normal: 'fast', strong: 'slow', maximum: 'slow' },
        },
      },
    });
    const acme = providerCatalogFor(catalog, 'acme-ai');
    expect(acme.source).toBe('catalog-overlay');
    expect(acme.qualityBindings.maximum.sharedWithQualityLevels).toEqual(['strong']);
    // The built-in providers survive alongside it.
    expect(Object.keys(catalog.providers).sort()).toEqual([
      'acme-ai',
      'anthropic',
      'google',
      'openai',
    ]);
  });
});

describe('agent-profile-catalog — schema version (§11.1)', () => {
  test('an absent schemaVersion is refused', () => {
    const err = refusal(() => loadOverlay({ providers: {} }));
    expect(err.reason).toBe('catalog-schema-unsupported');
    expect(err.message).toMatch(/schemaVersion is required/);
  });

  test('a non-integral schemaVersion is refused', () => {
    expect(refusal(() => loadOverlay({ schemaVersion: 1.5, providers: {} })).reason).toBe(
      'catalog-schema-unsupported',
    );
    expect(refusal(() => loadOverlay({ schemaVersion: '1', providers: {} })).reason).toBe(
      'catalog-schema-unsupported',
    );
  });

  test('a newer schemaVersion is refused whole, before its unknown keys are reported', () => {
    const err = refusal(() =>
      loadOverlay({ schemaVersion: 2, providers: {}, somethingNewInV2: true }),
    );
    expect(err.reason).toBe('catalog-schema-unsupported');
    expect(err.message).toMatch(/newer than this binary supports/);
    // Refused for its version, never as a pile of unknown keys.
    expect(err.message).not.toMatch(/unknown key/);
  });
});

describe('agent-profile-catalog — closed schema (§11.2)', () => {
  test('an unknown top-level key is refused', () => {
    const err = refusal(() => loadOverlay({ schemaVersion: 1, provider: {} }));
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/unknown key "provider"/);
  });

  test('a singular qualityBinding typo is refused rather than silently ignored', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { openai: { qualityBinding: { maximum: 'codex-high' } } },
      }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/unknown key "qualityBinding"/);
  });

  test('an unknown profile setting is refused', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { profiles: { 'claude-light': { temperature: '0.2' } } } },
      }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/unknown key "temperature"/);
  });

  test('a phase key, an agent id key, and a credential key are all refused (§6.1)', () => {
    for (const [forbidden, block] of [
      ['phase', { schemaVersion: 1, phase: 'review', providers: {} }],
      [
        'agentId',
        { schemaVersion: 1, providers: { anthropic: { agentId: 'claude' } } },
      ],
      [
        'token',
        { schemaVersion: 1, providers: { anthropic: { profiles: { 'claude-light': { token: 'x' } } } } },
      ],
    ]) {
      const err = refusal(() => loadOverlay(block));
      expect(err.reason).toBe('catalog-invalid');
      expect(err.message).toMatch(new RegExp(`"${forbidden}" may never appear in the catalog`));
    }
  });

  test('keying the catalog by an agent id instead of a provider is refused', () => {
    const err = refusal(() =>
      loadOverlay({ schemaVersion: 1, providers: { claude: { profiles: {} } } }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/"claude" is an agent id, not a provider/);
  });

  test('a profile cannot be deleted and a level cannot be unbound (§9.4)', () => {
    const removeProfile = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { profiles: { 'claude-light': null } } },
      }),
    );
    expect(removeProfile.reason).toBe('catalog-invalid');
    expect(removeProfile.message).toMatch(/a profile cannot be removed/);

    const unbind = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { qualityBindings: { light: null } } },
      }),
    );
    expect(unbind.reason).toBe('catalog-invalid');
    expect(unbind.message).toMatch(/a quality level cannot be unbound/);
  });

  test('a level outside the four is not a quality level', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { qualityBindings: { xhigh: 'claude-maximum' } } },
      }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/"xhigh" is not a quality level/);
  });
});

describe('agent-profile-catalog — malformed settings fail before a billable invocation (§12)', () => {
  test('a malformed budget is refused', () => {
    for (const budget of ['', ' ', 'ten', '-5', '0', '1.005', 5]) {
      const err = refusal(() =>
        loadOverlay({
          schemaVersion: 1,
          providers: { anthropic: { profiles: { 'claude-light': { budget } } } },
        }),
      );
      expect(err.reason).toBe('catalog-invalid');
      expect(err.path).toBe(`${CATALOG_PATH}.providers.anthropic.profiles.claude-light.budget`);
    }
  });

  test('an empty model is refused; a display name with spaces is not (§6.2)', () => {
    expect(
      refusal(() =>
        loadOverlay({
          schemaVersion: 1,
          providers: { anthropic: { profiles: { 'claude-light': { model: '  ' } } } },
        }),
      ).message,
    ).toMatch(/model must not be empty/);

    // Antigravity names its models by display name, spaces and all. Whether the
    // name exists is the provider's answer, not a shape rule here.
    const catalog = loadOverlay({
      schemaVersion: 1,
      providers: { google: { profiles: { 'agy-light': { model: 'Gemini 3.1 Pro (Low)' } } } },
    });
    expect(lookupQualityBinding(catalog, 'google', 'light').profile.settings.model).toBe(
      'Gemini 3.1 Pro (Low)',
    );

    // A no-break space is a paste artifact, not a display name. The literal
    // below carries a real U+00A0 between "Gemini" and "3.1"; if an editor ever
    // normalizes it to a plain space the model becomes acceptable and this
    // expectation fails loudly rather than passing for the wrong reason.
    expect(
      refusal(() =>
        loadOverlay({
          schemaVersion: 1,
          providers: { google: { profiles: { 'agy-light': { model: 'Gemini 3.1 Pro' } } } },
        }),
      ).message,
    ).toMatch(/model must not contain whitespace other than a plain space/);
  });

  test('an effort value with internal whitespace is refused', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { profiles: { 'claude-light': { effort: 'very high' } } } },
      }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/effort must not contain whitespace/);
    expect(err.path).toBe(`${CATALOG_PATH}.providers.anthropic.profiles.claude-light.effort`);
  });

  test('a reference to an Object.prototype member is not a declared profile', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { openai: { qualityBindings: { normal: 'toString' } } },
      }),
    );
    expect(err.reason).toBe('unknown-profile');
    expect(err.message).toMatch(/which provider "openai" does not declare/);
    expect(err.path).toBe(`${CATALOG_PATH}.providers.openai.qualityBindings.normal`);
  });

  test('a provider name that is an Object.prototype member is unknown, not inherited', () => {
    const catalog = load(undefined);
    const err = refusal(() => providerCatalogFor(catalog, 'constructor'));
    expect(err.reason).toBe('unknown-provider');
    expect(err.path).toBe('providers.constructor');
  });

  test('a setting the provider does not declare is refused, not ignored', () => {
    const effortOnGoogle = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { google: { profiles: { 'agy-strong': { effort: 'high' } } } },
      }),
    );
    expect(effortOnGoogle.reason).toBe('unsupported-setting');
    expect(effortOnGoogle.message).toMatch(/provider "google" does not accept the setting "effort"/);

    const budgetOnCodex = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { openai: { profiles: { 'codex-high': { budget: '10' } } } },
      }),
    );
    expect(budgetOnCodex.reason).toBe('unsupported-setting');
  });

  test('an enumerated value outside the declared list is refused, never lowered (§12.3)', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { openai: { profiles: { 'codex-high': { effort: 'xhigh' } } } },
      }),
    );
    expect(err.reason).toBe('unsupported-value');
    expect(err.message).toMatch(/effort "xhigh" is not accepted by provider "openai"/);
  });

  test('a provider option the capability descriptor declares is accepted whatever its spelling', () => {
    // The capability descriptor is the only constraint on provider option keys
    // (§6.1), so a provider-native name such as Codex's `-c
    // model_reasoning_summary` stays representable.
    const catalog = loadOverlay({
      schemaVersion: 1,
      providers: {
        openai: {
          capabilities: { providerOptions: ['model_reasoning_summary'] },
          profiles: { 'codex-high': { providerOptions: { model_reasoning_summary: 'detailed' } } },
        },
      },
    });
    const openai = providerCatalogFor(catalog, 'openai');
    expect(openai.profiles['codex-high'].settings.providerOptions).toEqual({
      model_reasoning_summary: 'detailed',
    });
    expect(openai.profiles['codex-high'].providerOptionSources).toEqual({
      model_reasoning_summary: 'catalog-overlay',
    });
  });

  test('a provider option name no descriptor could name back is refused', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: {
          google: {
            capabilities: { providerOptions: 'free' },
            profiles: { 'agy-light': { providerOptions: { 'print timeout': '15m' } } },
          },
        },
      }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/is not a valid provider option name/);
  });

  test('an undeclared provider option is refused', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { google: { profiles: { 'agy-light': { providerOptions: { sandbox: 'off' } } } } },
      }),
    );
    expect(err.reason).toBe('unsupported-setting');
    expect(err.message).toMatch(/does not declare the provider option "sandbox"/);
  });

  test('a profile no binding reaches is validated too', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { openai: { profiles: { 'codex-future': { effort: 'ultra' } } } },
      }),
    );
    expect(err.reason).toBe('unsupported-value');
  });

  test('an empty capability list is refused — "free" is how any value is accepted', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { openai: { capabilities: { effort: [] } } },
      }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/must list at least one accepted value/);
  });

  test('an enumerated model capability is refused — model names are always "free" (§6.2)', () => {
    // A model allowlist would refuse a retargeted profile locally, before the
    // provider CLI ever judges the name. §6.2 reserves that answer for the CLI,
    // so the descriptor is rejected at load rather than narrowing later runs.
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { capabilities: { model: ['sonnet', 'opus', 'fable'] } } },
      }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/the "model" capability must be "free"/);
    expect(err.path).toBe(`${CATALOG_PATH}.providers.anthropic.capabilities.model`);
  });

  test('a single-value model capability is refused too — an allowlist of one is still an allowlist', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { openai: { capabilities: { model: ['gpt-5-codex'] } } },
      }),
    );
    expect(err.reason).toBe('catalog-invalid');
    expect(err.message).toMatch(/the "model" capability must be "free"/);
  });

  test('a model capability of "free" is accepted, and a new model name needs no source change', () => {
    const catalog = loadOverlay({
      schemaVersion: 1,
      providers: {
        anthropic: {
          capabilities: { model: 'free' },
          profiles: { 'claude-strong': { model: 'a-model-released-tomorrow' } },
        },
      },
    });
    const anthropic = providerCatalogFor(catalog, 'anthropic');
    expect(anthropic.capabilities.model).toBe('free');
    expect(anthropic.profiles['claude-strong'].settings.model).toBe('a-model-released-tomorrow');
  });
});

describe('agent-profile-catalog — references and bindings (§6.4, §12.2)', () => {
  test('a binding naming an undeclared profile is unknown-profile', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { qualityBindings: { strong: 'claude-strogn' } } },
      }),
    );
    expect(err.reason).toBe('unknown-profile');
    expect(err.message).toMatch(/which provider "anthropic" does not declare/);
  });

  test('a profile declared under another provider does not satisfy a binding', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { openai: { qualityBindings: { maximum: 'claude-maximum' } } },
      }),
    );
    expect(err.reason).toBe('unknown-profile');
  });

  test('a binding that names another quality level is refused as the alias it is not', () => {
    // The schema has no alias indirection: a binding names a profile in exactly
    // one hop, so a binding cycle cannot be expressed. A file that tries reads
    // as a name no profile declares, and says so.
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { qualityBindings: { maximum: 'strong' } } },
      }),
    );
    expect(err.reason).toBe('unknown-profile');
    expect(err.message).toMatch(/which is a quality level rather than a profile/);
    expect(err.message).toMatch(/bindings name profiles directly and never other bindings/);
  });

  test('a mutually-referencing pair of bindings is still just two unknown profiles', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: { anthropic: { qualityBindings: { strong: 'maximum', maximum: 'strong' } } },
      }),
    );
    expect(err.reason).toBe('unknown-profile');
  });

  test('a new provider that binds only some levels is unbound-quality', () => {
    const err = refusal(() =>
      loadOverlay({
        schemaVersion: 1,
        providers: {
          'acme-ai': {
            capabilities: { model: 'free' },
            profiles: { fast: { model: 'acme-1' } },
            qualityBindings: { light: 'fast', normal: 'fast' },
          },
        },
      }),
    );
    expect(err.reason).toBe('unbound-quality');
    expect(err.message).toMatch(/does not bind quality level "strong"/);
  });

  test('a provider the catalog never declared is unknown-provider, not a default invocation', () => {
    const err = refusal(() => providerCatalogFor(load(undefined), 'mistral'));
    expect(err.reason).toBe('unknown-provider');
  });
});

describe('agent-profile-catalog — path resolution (§9.1)', () => {
  test('the default location is beside sessions.json', () => {
    expect(
      resolveAgentProfilesPath({ env: {}, sessionsPath: '/srv/cfg/sessions.json' }),
    ).toEqual({ path: '/srv/cfg/agent-profiles.json', source: 'default', required: false });
  });

  test('the default config dir matches the session registry default', () => {
    // core/ cannot import registries/, so the two defaults are pinned equal
    // here rather than shared through an import. The home variables are passed
    // explicitly so a stray AGENT_PROFILES_FILE in the operator's environment
    // cannot decide this assertion.
    const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    expect(defaultAgentProfilesDir(env)).toBe(dirname(DEFAULT_SESSIONS_PATH));
    expect(resolveAgentProfilesPath({ env }).path).toBe(
      join(dirname(DEFAULT_SESSIONS_PATH), AGENT_PROFILES_FILENAME),
    );
  });

  test('AGENT_PROFILES_FILE outranks session config, which outranks the default', () => {
    const env = { [AGENT_PROFILES_FILE_ENV]: '/env/catalog.json' };
    expect(
      resolveAgentProfilesPath({ env, sessionProfilesPath: '/sess/catalog.json', sessionsPath: SESSIONS_PATH }),
    ).toEqual({ path: '/env/catalog.json', source: 'env', required: true });
    expect(
      resolveAgentProfilesPath({ env: {}, sessionProfilesPath: '/sess/catalog.json', sessionsPath: SESSIONS_PATH }),
    ).toEqual({ path: '/sess/catalog.json', source: 'session-config', required: true });
    // A blank value is not a configured path.
    expect(
      resolveAgentProfilesPath({ env: { [AGENT_PROFILES_FILE_ENV]: '  ' }, sessionsPath: SESSIONS_PATH }).source,
    ).toBe('default');
  });

  test('a relative configured path is refused rather than resolved against the cwd', () => {
    const err = refusal(() =>
      resolveAgentProfilesPath({ env: { [AGENT_PROFILES_FILE_ENV]: 'catalog.json' } }),
    );
    expect(err.reason).toBe('catalog-unreadable');
    expect(err.message).toMatch(/must be an absolute path/);
  });

  test('a configured path that does not exist is a refusal, never a silent fall-through', () => {
    const err = refusal(() =>
      loadAgentProfileCatalog({
        env: { [AGENT_PROFILES_FILE_ENV]: '/env/catalog.json' },
        readCatalogFile: () => undefined,
      }),
    );
    expect(err.reason).toBe('catalog-unreadable');
    expect(err.path).toBe('/env/catalog.json');
    expect(err.message).toMatch(/does not exist/);
  });

  test('a file that is not valid JSON is a refusal', () => {
    const err = refusal(() => load('{ "schemaVersion": 1,'));
    expect(err.reason).toBe('catalog-unreadable');
    expect(err.message).toMatch(/not valid JSON/);
  });

  test('a catalog that is not a JSON object is refused', () => {
    expect(refusal(() => load('[]')).reason).toBe('catalog-invalid');
    expect(refusal(() => load('"catalog"')).reason).toBe('catalog-invalid');
  });
});

describe('agent-profile-catalog — reload and digest (§9.3, §13.2)', () => {
  test('every invocation re-reads: an edit between calls is picked up without a rebuild', () => {
    let contents = JSON.stringify({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'opus' } } } },
    });
    const options = { env: {}, sessionsPath: SESSIONS_PATH, readCatalogFile: () => contents };

    const before = loadAgentProfileCatalog(options);
    expect(before.providers.anthropic.profiles['claude-strong'].settings.model).toBe('opus');

    contents = JSON.stringify({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'fable' } } } },
    });
    const after = loadAgentProfileCatalog(options);
    expect(after.providers.anthropic.profiles['claude-strong'].settings.model).toBe('fable');
    expect(after.digest).not.toBe(before.digest);
  });

  test('the digest covers effective values, not where they came from', () => {
    const builtin = load(undefined);
    // An overlay that restates a built-in value changes provenance but not the
    // effective catalog, so a run cannot be attributed to a catalog edit.
    const restated = loadOverlay({
      schemaVersion: 1,
      catalogVersion: BUILT_IN_AGENT_PROFILE_CATALOG.catalogVersion,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'opus' } } } },
    });
    expect(restated.digest).toBe(builtin.digest);
    expect(restated.providers.anthropic.profiles['claude-strong'].settingSources.model).toBe(
      'catalog-overlay',
    );
    expect(builtin.providers.anthropic.profiles['claude-strong'].settingSources.model).toBe(
      'catalog-builtin',
    );
    expect(builtin.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('the built-in catalog constant cannot be mutated by a caller', () => {
    expect(() => {
      BUILT_IN_AGENT_PROFILE_CATALOG.providers.anthropic.profiles['claude-strong'].model = 'haiku';
    }).toThrow();
    expect(load(undefined).providers.anthropic.profiles['claude-strong'].settings.model).toBe(
      'opus',
    );
  });

  test('buildEffectiveAgentProfileCatalog validates a candidate without reading a path', () => {
    const effective = buildEffectiveAgentProfileCatalog({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-light': { budget: '3' } } } },
    });
    expect(effective.providers.anthropic.profiles['claude-light'].settings.budget).toBe('3');
    expect(effective.catalogSource).toBe('file');
  });
});

describe('agent-profile-catalog — real filesystem', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-profiles-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('an absent file at the default location leaves an installation on built-ins', () => {
    const catalog = loadAgentProfileCatalog({ env: {}, sessionsPath: join(dir, 'sessions.json') });
    expect(catalog.catalogSource).toBe('builtin');
    // Nothing was created: an existing installation keeps running with no new file.
    expect(() => readFileSync(join(dir, AGENT_PROFILES_FILENAME))).toThrow();
  });

  test('a file beside sessions.json is read, and re-read after an operator edit', () => {
    const path = join(dir, AGENT_PROFILES_FILENAME);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        providers: { openai: { qualityBindings: { maximum: 'codex-normal' } } },
      }),
    );
    const options = { env: {}, sessionsPath: join(dir, 'sessions.json') };
    let catalog = loadAgentProfileCatalog(options);
    expect(catalog.catalogSource).toBe('file');
    expect(catalog.catalogPath).toBe(path);
    expect(catalog.providers.openai.qualityBindings.maximum.profileName).toBe('codex-normal');

    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        providers: { openai: { qualityBindings: { maximum: 'codex-light' } } },
      }),
    );
    catalog = loadAgentProfileCatalog(options);
    expect(catalog.providers.openai.qualityBindings.maximum.profileName).toBe('codex-light');
  });

  test('a path that exists but cannot be read is a refusal, not an absence', () => {
    // A directory where the catalog file should be: readFileSync fails with
    // EISDIR, which must not read as "no file here".
    mkdirSync(join(dir, AGENT_PROFILES_FILENAME));
    const err = refusal(() =>
      loadAgentProfileCatalog({ env: {}, sessionsPath: join(dir, 'sessions.json') }),
    );
    expect(err.reason).toBe('catalog-unreadable');
  });
});

describe('agent-profile-catalog — vocabulary rules (§14.3)', () => {
  const source = readFileSync(resolve(ROOT, 'src/core/agent-profile-catalog.ts'), 'utf8');

  test('the refusal set matches the contract table exactly', () => {
    const doc = readFileSync(resolve(ROOT, 'docs/agent-runtime-profiles-contract.md'), 'utf8');
    const start = doc.indexOf('### 12.2 Refusal reasons');
    const table = doc.slice(start, doc.indexOf('### 12.3', start));
    expect(start).toBeGreaterThan(0);
    const documented = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
    expect(documented.sort()).toEqual([...AGENT_PROFILE_REFUSAL_REASONS].sort());
  });

  test('no exported type is a union of provider catalog values', () => {
    // Model names, effort values, budget amounts, profile names, and per-provider
    // capability lists are `string`; only the provider-neutral vocabularies this
    // contract owns may be unions.
    const allowed = new Set([
      'QualityLevel',
      'AgentProfileSettingKey',
      'AgentProfileRefusalReason',
      'CatalogValueSource',
      'CatalogSource',
      'AgentProfilesPathSource',
      'CapabilityDeclaration',
    ]);
    for (const match of source.matchAll(/^export type (\w+) =([^;]*);/gm)) {
      const [, name, rhs] = match;
      if (!rhs.includes('"')) continue;
      expect(allowed.has(name)).toBe(true);
    }
    // The built-in model names exist only as catalog data, inside the built-in
    // constant — never in a type, a validator, or a lookup table.
    const dataStart = source.indexOf('export const BUILT_IN_AGENT_PROFILE_CATALOG');
    const dataEnd = source.indexOf('\n});', dataStart);
    expect(dataStart).toBeGreaterThan(0);
    expect(dataEnd).toBeGreaterThan(dataStart);
    for (const model of ['sonnet', 'opus', 'fable']) {
      const occurrences = [...source.matchAll(new RegExp(`"${model}"`, 'g'))];
      expect(occurrences.length).toBeGreaterThan(0);
      for (const occurrence of occurrences) {
        expect(occurrence.index).toBeGreaterThan(dataStart);
        expect(occurrence.index).toBeLessThan(dataEnd);
      }
    }
  });

  test('the setting keys are the five the contract declares', () => {
    expect([...AGENT_PROFILE_SETTING_KEYS]).toEqual([
      'model',
      'effort',
      'budget',
      'binary',
      'providerOptions',
    ]);
    expect([...QUALITY_LEVELS]).toEqual(['light', 'normal', 'strong', 'maximum']);
  });
});
