/**
 * The agent runtime audit record (issue #910) — slice B4 of
 * docs/agent-runtime-profiles-contract.md §14.1, the §13 observability half of
 * the provider-centric runtime profile contract.
 *
 * The resolution engine and the three provider adapters are pinned by
 * test/agent-runtime-adapter.test.js (#906), test/claude-runtime-adapter.test.js
 * (#907), test/codex-runtime-adapter.test.js (#908), and
 * test/antigravity-runtime-adapter.test.js (#909). What is pinned here is what a
 * run leaves behind:
 *
 *   - ONE record shape for every provider, so two runs on two providers are
 *     comparable — the anthropic, openai, and google resolutions produce the
 *     same fields, differing only in which optional values are absent;
 *   - both halves together (§13.1): the semantic request with what asked for
 *     it, and every concrete setting with its own source, so a built-in
 *     binding, a catalog overlay, an operator break-glass variable, and a
 *     CLI default are distinguishable at a glance;
 *   - a declared shared binding (§6.3) is visible rather than silent: a
 *     `maximum` request answered by the provider's high-only profile records
 *     the profile, records `strong` as sharing it, and is NEVER presented as
 *     an `xhigh` run the provider never performed — while an operator PIN is
 *     published as a pin, never as a binding the catalog does not declare;
 *   - a per-value bound is a presentation limit, not a rewrite: a value over it
 *     records its prefix WITH the original length and a digest of the whole
 *     value, so two binaries differing past the bound stay two records;
 *   - an absence stays an absence (§13.3) — an unset model is a missing field
 *     with a `cli-default` source, never the string "default";
 *   - a review-loop escalation is a property of the RUN: the task's request
 *     stays as it was admitted and the run records `escalation`;
 *   - nothing published carries a prompt, an environment value, a credential,
 *     or an absolute local path, and the public line is bounded and single-line;
 *   - persistence is bounded, counts what it trimmed, and never fails on a
 *     record another build of this loop wrote.
 */
import { createHash } from 'crypto';
import {
  AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
  AGENT_RUNTIME_AUDIT_ARTIFACT_FILENAME,
  AGENT_RUNTIME_AUDIT_CONTEXT_KEY,
  AGENT_RUNTIME_AUDIT_RECORD_VERSION,
  AGENT_RUNTIME_RESOLVED_EVENT,
  ANTIGRAVITY_RUNTIME_ADAPTER,
  CLAUDE_RUNTIME_ADAPTER,
  CODEX_RUNTIME_ADAPTER,
  MAX_AGENT_RUNTIME_AUDIT_RECORDS,
  MAX_AGENT_RUNTIME_AUDIT_VALUE_CHARS,
  MAX_AGENT_RUNTIME_CLI_VERSION_CHARS,
  MAX_AGENT_RUNTIME_PUBLIC_SUMMARY_CHARS,
  agentRuntimeAuditEventData,
  antigravityInvocationRequest,
  appendAgentRuntimeAuditRecord,
  buildAgentRuntimeAuditRecord,
  buildEffectiveAgentProfileCatalog,
  createAgentRuntimeAdapterRegistry,
  describeAntigravityRuntime,
  describeCodexRuntime,
  interpretDiscoveryProbe,
  isAgentRuntimeConfigurationError,
  latestAgentRuntimeAuditRecord,
  planAgentInvocation,
  publicAgentRuntimeSummary,
  readAgentRuntimeAuditLog,
  resolveAgentRuntime,
  serializeAgentRuntimeAuditRecord,
} from '../dist/index.js';

/** The effective built-in catalog — exactly what a phase start with no overlay sees. */
const CATALOG = buildEffectiveAgentProfileCatalog(undefined);

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

const ADAPTERS = {
  claude: CLAUDE_RUNTIME_ADAPTER,
  codex: CODEX_RUNTIME_ADAPTER,
  gemini: ANTIGRAVITY_RUNTIME_ADAPTER,
};

const NOW = '2026-09-10T04:05:06.000Z';

/** One quality answer, as `qualityForPhaseClass` (#905) hands it to the boundary. */
function quality(level, source = 'default', extra = {}) {
  return {
    quality: level,
    source,
    requested: { quality: level, source, ...(extra.label ? { label: extra.label } : {}) },
    ...(extra.escalationFloor ? { escalationFloor: extra.escalationFloor } : {}),
  };
}

/** A run the review loop raised: the task keeps its request, the run records the floor. */
function escalated(requested, requestedSource, floor, label) {
  return {
    quality: floor,
    source: 'escalation',
    requested: {
      quality: requested,
      source: requestedSource,
      ...(label ? { label } : {}),
    },
    escalationFloor: floor,
  };
}

function resolveFor(agentId, options = {}) {
  return resolveAgentRuntime(ADAPTERS[agentId], {
    agentId,
    quality: options.quality ?? quality('normal'),
    catalog: options.catalog ?? CATALOG,
    env: options.env ?? {},
    ...(options.taskPinnedProfile ? { taskPinnedProfile: options.taskPinnedProfile } : {}),
    ...(options.sessionPinnedProfile
      ? { sessionPinnedProfile: options.sessionPinnedProfile }
      : {}),
  });
}

function recordFor(agentId, options = {}) {
  return buildAgentRuntimeAuditRecord({
    resolved: resolveFor(agentId, options),
    resolvedAt: NOW,
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.lane ? { lane: options.lane } : {}),
    ...(options.plan ? { plan: options.plan } : {}),
    ...(options.discovery ? { discovery: options.discovery } : {}),
    ...(options.resolutionDurationMs !== undefined
      ? { resolutionDurationMs: options.resolutionDurationMs }
      : {}),
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

function taskWith(contextValue) {
  return {
    sessionId: 's',
    issueNumber: 910,
    status: 'queued',
    phase: 'implementation',
    priority: 'normal',
    attempts: {},
    context: contextValue === undefined ? {} : { [AGENT_RUNTIME_AUDIT_CONTEXT_KEY]: contextValue },
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
  };
}

/**
 * The fields every record carries whatever the provider — the ones that make
 * two runs on two providers comparable. The provider-shaped part is the set of
 * VALUES that may be absent (§13.3), never the set of fields.
 */
const ALWAYS_PRESENT_FIELDS = [
  'recordVersion',
  'agentId',
  'provider',
  'requestedQuality',
  'requestedQualitySource',
  'effectiveQuality',
  'effectiveQualitySource',
  'profileName',
  'profileSource',
  'sharedWithQualityLevels',
  'catalogSchemaVersion',
  'catalogVersion',
  'catalogSource',
  'catalogDigest',
  'modelSource',
  'effortSource',
  'budgetSource',
  'binary',
  'binarySource',
  'providerOptions',
  'providerOptionSources',
  'resolvedAt',
];

/** Fields whose presence says a value exists, and whose absence IS the value. */
const OPTIONAL_FIELDS = [
  'phase',
  'phaseClass',
  'lane',
  'requestedQualityLabel',
  'escalationFloor',
  'model',
  'effort',
  'budget',
  'budgetApplied',
  'cliVersion',
  'cliStatus',
  'resolutionDurationMs',
];

describe('agent runtime audit record — one shape for every provider (§13.1)', () => {
  test('every provider records the same fields, differing only in absent values', () => {
    for (const agentId of ['claude', 'codex', 'gemini']) {
      const keys = Object.keys(recordFor(agentId));
      for (const field of ALWAYS_PRESENT_FIELDS) {
        expect(keys).toContain(field);
      }
      // Nothing provider-specific may creep into the shape.
      expect(keys.filter((key) => !ALWAYS_PRESENT_FIELDS.includes(key)).sort()).toEqual(
        keys.filter((key) => OPTIONAL_FIELDS.includes(key)).sort(),
      );
    }
    // The providers differ in which VALUES resolved, not in the record's shape:
    // anthropic carries all three settings, openai has no budget flag and no
    // model, google folds effort into the model name.
    expect(Object.keys(recordFor('claude'))).toContain('budget');
    expect(Object.keys(recordFor('codex'))).not.toContain('budget');
    expect(Object.keys(recordFor('gemini'))).not.toContain('effort');
  });

  test('every provider records both halves: the request and the concrete settings', () => {
    for (const agentId of ['claude', 'codex', 'gemini']) {
      const record = recordFor(agentId, {
        quality: quality('strong', 'compat-label', { label: 'complexity:high' }),
      });
      expect(record).toMatchObject({
        recordVersion: AGENT_RUNTIME_AUDIT_RECORD_VERSION,
        agentId,
        provider: providerForAgent(agentId),
        requestedQuality: 'strong',
        requestedQualitySource: 'compat-label',
        requestedQualityLabel: 'complexity:high',
        effectiveQuality: 'strong',
        effectiveQualitySource: 'compat-label',
        catalogSchemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
        catalogSource: 'builtin',
        resolvedAt: NOW,
      });
      // Every concrete setting carries its own source, present or absent.
      expect(typeof record.modelSource).toBe('string');
      expect(typeof record.effortSource).toBe('string');
      expect(typeof record.budgetSource).toBe('string');
      expect(typeof record.binary).toBe('string');
      expect(record.catalogDigest).toMatch(/^sha256:/);
      expect(record.catalogVersion).toBe(CATALOG.catalogVersion);
    }
  });

  test('the record carries no prompt, no environment, and no credential field', () => {
    const planned = planAgentInvocation(REGISTRY, {
      agentId: 'claude',
      lane: 'implementation',
      quality: quality('strong'),
      catalog: CATALOG,
      env: { CLAUDE_MODEL: 'opus', ANTHROPIC_API_KEY: 'sk-ant-0123456789012345678901234' },
      prompt: 'Implement issue #910. Do not leak this text.',
    });
    const record = buildAgentRuntimeAuditRecord({
      resolved: planned.resolved,
      plan: planned.invocation,
      lane: 'implementation',
      phase: 'implementation',
      resolvedAt: NOW,
    });
    const serialized = serializeAgentRuntimeAuditRecord(record);
    expect(serialized).not.toContain('Do not leak this text');
    expect(serialized).not.toContain('sk-ant-');
    expect(Object.keys(record)).not.toContain('env');
    expect(Object.keys(record)).not.toContain('prompt');
    expect(Object.keys(record)).not.toContain('args');
    // The variable's VALUE never appears; only the fact that a variable decided
    // the field, which is what makes a break-glass override auditable.
    expect(record.modelSource).toBe('env');
    expect(record.model).toBe('opus');
  });

  test('the record agrees with the provider-shaped operator summaries it does not replace', () => {
    // The adapters expose their own summaries, whose fields differ because the
    // providers differ (#908, #909). Where the two overlap they must be the
    // same fact, or an operator reading one surface would be misled by the
    // other.
    const codexResolved = resolveFor('codex', { quality: quality('strong') });
    const codexRecord = buildAgentRuntimeAuditRecord({ resolved: codexResolved, resolvedAt: NOW });
    const codexDescription = describeCodexRuntime(codexResolved);
    expect(codexRecord.effort).toBe(codexDescription.effort);
    expect(codexRecord.effortSource).toBe(codexDescription.effortSource);
    expect(codexRecord.modelSource).toBe(codexDescription.modelSource);
    expect(codexRecord.binary).toBe(codexDescription.binary);

    const geminiResolved = resolveFor('gemini', { quality: quality('strong') });
    const geminiRecord = buildAgentRuntimeAuditRecord({ resolved: geminiResolved, resolvedAt: NOW });
    const geminiDescription = describeAntigravityRuntime(geminiResolved);
    expect(geminiRecord.requestedQuality).toBe(geminiDescription.requestedQuality);
    expect(geminiRecord.effectiveQuality).toBe(geminiDescription.effectiveQuality);
    expect(geminiRecord.profileName).toBe(geminiDescription.profileName);
    expect(geminiRecord.catalogDigest).toBe(geminiDescription.catalogDigest);
    expect(geminiRecord.providerOptions.printTimeout).toBe(geminiDescription.printTimeout);
  });

  test('a phase supplies its §10.2 class and a bad one refuses', () => {
    expect(recordFor('claude', { phase: 'review' })).toMatchObject({
      phase: 'review',
      phaseClass: 'review-class',
    });
    expect(recordFor('claude', { phase: 'implementation' }).phaseClass).toBe('implementation-class');
    const err = captureError(() =>
      buildAgentRuntimeAuditRecord({ resolved: resolveFor('claude'), phase: 'nope', resolvedAt: NOW }),
    );
    expect(err?.name).toBe('AgentRuntimeContractViolationError');
    expect(isAgentRuntimeConfigurationError(err)).toBe(true);
  });

  test('resolution timing is recorded when the run measured it', () => {
    expect(recordFor('claude', { resolutionDurationMs: 12 }).resolutionDurationMs).toBe(12);
    expect(recordFor('claude')).not.toHaveProperty('resolutionDurationMs');
    const err = captureError(() =>
      buildAgentRuntimeAuditRecord({
        resolved: resolveFor('claude'),
        resolvedAt: NOW,
        resolutionDurationMs: -1,
      }),
    );
    expect(err?.name).toBe('AgentRuntimeContractViolationError');
  });
});

describe('agent runtime audit record — where each value came from (§13.2)', () => {
  test('a built-in binding records catalog-builtin for every value it supplied', () => {
    const record = recordFor('claude', { quality: quality('strong') });
    expect(record).toMatchObject({
      profileName: 'claude-strong',
      profileSource: 'catalog-builtin',
      model: 'opus',
      modelSource: 'catalog-builtin',
      effort: 'high',
      effortSource: 'catalog-builtin',
      budget: '10',
      budgetSource: 'catalog-builtin',
      binarySource: 'default',
      catalogSource: 'builtin',
    });
  });

  test('an overlay records catalog-overlay, a file catalog source, and its own version', () => {
    const catalog = buildEffectiveAgentProfileCatalog({
      schemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
      catalogVersion: 'ops-2026-09-10',
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'opus-4.8' } } } },
    });
    const record = recordFor('claude', { catalog, quality: quality('strong') });
    expect(record).toMatchObject({
      model: 'opus-4.8',
      modelSource: 'catalog-overlay',
      // The overlay changed one field; the others keep their built-in origin.
      effortSource: 'catalog-builtin',
      catalogSource: 'file',
      catalogVersion: 'ops-2026-09-10',
    });
    expect(record.catalogDigest).not.toBe(
      recordFor('claude', { quality: quality('strong') }).catalogDigest,
    );
  });

  test('a break-glass variable is distinguishable from a catalog binding at a glance', () => {
    const record = recordFor('claude', {
      quality: quality('strong'),
      env: { CLAUDE_EFFORT: 'max', CLAUDE_MAX_BUDGET_USD: '25' },
    });
    expect(record).toMatchObject({
      effort: 'max',
      effortSource: 'env',
      budget: '25',
      budgetSource: 'env',
      model: 'opus',
      modelSource: 'catalog-builtin',
    });
  });

  test('a task-pinned profile records task-pin while its fields keep catalog provenance', () => {
    const record = recordFor('claude', { taskPinnedProfile: 'claude-light' });
    expect(record).toMatchObject({
      profileName: 'claude-light',
      profileSource: 'task-pin',
      model: 'sonnet',
      modelSource: 'catalog-builtin',
    });
  });

  test('an unset setting is an absence with a source, never the string "default" (§13.3)', () => {
    // Codex declares no model in any built-in profile: the CLI's own default
    // applies and no `model` field exists to be mistaken for one.
    const codex = recordFor('codex');
    expect(codex).not.toHaveProperty('model');
    expect(codex.modelSource).toBe('cli-default');
    expect(JSON.parse(serializeAgentRuntimeAuditRecord(codex)).model).toBeUndefined();

    // Codex declares no `budget` capability at all — a different absence.
    expect(codex).not.toHaveProperty('budget');
    expect(codex.budgetSource).toBe('not-applicable');

    // Antigravity folds effort into the model display name.
    const gemini = recordFor('gemini');
    expect(gemini).not.toHaveProperty('effort');
    expect(gemini.effortSource).toBe('not-applicable');
  });

  test('a model spelled as an unresolved token is recorded as the absence it is (§13.3)', () => {
    // The catalog's `model` capability is free-form, so an accepted overlay may
    // spell "no model was selected" as a literal token rather than by omitting
    // the field. Every token in §13.3's authoritative vocabulary is an absence.
    for (const token of ['default', 'cli-default', 'unknown', 'n/a', 'unset', '  DEFAULT  ']) {
      const catalog = buildEffectiveAgentProfileCatalog({
        schemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
        providers: {
          openai: {
            profiles: { 'codex-normal': { model: token } },
            // The built-in `normal` binding targets `codex-high` since the
            // write-capable cutover (issue #911); retarget it so the overlaid
            // profile is the one this `normal` resolution reads.
            qualityBindings: { normal: 'codex-normal' },
          },
        },
      });
      const record = recordFor('codex', { catalog });
      expect(record).not.toHaveProperty('model');
      expect(JSON.parse(serializeAgentRuntimeAuditRecord(record)).model).toBeUndefined();
      // The provenance survives: the record still says an overlay decided it.
      expect(record.modelSource).toBe('catalog-overlay');
      // And the public line prints the absence, never the token as a model.
      // (`model: provider default` is the absence; `model <value>` is a value.)
      const summary = publicAgentRuntimeSummary(record);
      expect(summary).toContain('model: provider default');
      expect(summary).not.toContain(`model ${token.trim()}`);
    }

    // A real model name is untouched, including one that merely contains a token.
    const named = buildEffectiveAgentProfileCatalog({
      schemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
      providers: {
        openai: {
          profiles: { 'codex-normal': { model: 'gpt-5-default' } },
          qualityBindings: { normal: 'codex-normal' },
        },
      },
    });
    expect(recordFor('codex', { catalog: named }).model).toBe('gpt-5-default');
  });

  test('a persisted token model is not read back as a model identity (§13.3)', () => {
    const written = recordFor('claude', { quality: quality('strong') });
    const task = taskWith({
      records: [{ ...written, model: 'cli-default', modelSource: 'catalog-overlay' }],
      dropped: 0,
    });
    const read = latestAgentRuntimeAuditRecord(task);
    expect(read).not.toHaveProperty('model');
    expect(read.modelSource).toBe('catalog-overlay');
    // The persisted entry itself is untouched — only this reading drops it.
    expect(task.context[AGENT_RUNTIME_AUDIT_CONTEXT_KEY].records[0].model).toBe('cli-default');
  });

  test('provider options are recorded with their per-key sources', () => {
    const gemini = recordFor('gemini');
    expect(gemini.providerOptions).toEqual({ printTimeout: '15m' });
    expect(gemini.providerOptionSources).toEqual({ printTimeout: 'catalog-builtin' });
    expect(recordFor('codex').providerOptions).toEqual({});
  });

  test('a budget the lane cannot express is recorded, never dropped in silence (§7 rule 1)', () => {
    const applied = planAgentInvocation(REGISTRY, {
      agentId: 'claude',
      lane: 'implementation',
      quality: quality('strong'),
      catalog: CATALOG,
      env: {},
      prompt: 'go',
    });
    expect(
      buildAgentRuntimeAuditRecord({
        resolved: applied.resolved,
        plan: applied.invocation,
        resolvedAt: NOW,
      }).budgetApplied,
    ).toBe('applied');

    const notApplicable = planAgentInvocation(REGISTRY, {
      agentId: 'claude',
      lane: 'review',
      quality: quality('strong'),
      catalog: CATALOG,
      env: {},
      prompt: 'go',
    });
    const record = buildAgentRuntimeAuditRecord({
      resolved: notApplicable.resolved,
      plan: notApplicable.invocation,
      resolvedAt: NOW,
    });
    expect(record.budget).toBe('10');
    expect(record.budgetApplied).toBe('not-applicable');
    expect(publicAgentRuntimeSummary(record)).toContain('no budget flag');
  });

  test('with no budget resolved there is nothing to declare applied', () => {
    const planned = planAgentInvocation(REGISTRY, {
      agentId: 'codex',
      lane: 'implementation',
      quality: quality('normal'),
      catalog: CATALOG,
      env: {},
      prompt: 'go',
    });
    const record = buildAgentRuntimeAuditRecord({
      resolved: planned.resolved,
      plan: planned.invocation,
      resolvedAt: NOW,
    });
    expect(record).not.toHaveProperty('budgetApplied');
  });
});

describe('agent runtime audit record — declared shared bindings stay visible (§6.3)', () => {
  test('a maximum request answered by a high-only profile is explicit, never xhigh', () => {
    const record = recordFor('codex', {
      quality: quality('maximum', 'compat-label', { label: 'complexity:xhigh' }),
    });
    expect(record).toMatchObject({
      requestedQuality: 'maximum',
      requestedQualityLabel: 'complexity:xhigh',
      effectiveQuality: 'maximum',
      profileName: 'codex-high',
      effort: 'high',
      effortSource: 'catalog-builtin',
      // `normal` joined the share when the write-capable cutover retargeted it
      // to `codex-high` (issue #911).
      sharedWithQualityLevels: ['normal', 'strong'],
    });
    const summary = publicAgentRuntimeSummary(record);
    expect(summary).toContain('maximum');
    expect(summary).toContain('codex-high');
    expect(summary).toContain('effort high');
    expect(summary).toContain('binds maximum and normal and strong to the same profile');
    // The provider never accepted a fourth reasoning tier, so nothing may
    // report the run as one: the label that ASKED for `xhigh` may appear, the
    // effort that RAN may not.
    expect(summary).not.toContain('effort xhigh');
    expect(record.effort).toBe('high');
  });

  test('the strong half of the same shared binding names the other levels, not itself', () => {
    const record = recordFor('codex', { quality: quality('strong') });
    expect(record.profileName).toBe('codex-high');
    expect(record.sharedWithQualityLevels).toEqual(['normal', 'maximum']);
  });

  test('a level that binds to a profile of its own shares with nothing', () => {
    expect(recordFor('claude', { quality: quality('maximum') })).toMatchObject({
      profileName: 'claude-maximum',
      model: 'fable',
      effort: 'xhigh',
      sharedWithQualityLevels: [],
    });
  });

  test('a pinned profile reports the same shared levels a binding would', () => {
    // The resolution engine reports the pin path INCLUDING the run's own level;
    // the record normalizes to "the other levels", so the fact does not depend
    // on which §8.1 layer chose the profile.
    const pinned = recordFor('codex', {
      quality: quality('maximum'),
      taskPinnedProfile: 'codex-high',
    });
    expect(pinned.profileSource).toBe('task-pin');
    expect(pinned.sharedWithQualityLevels).toEqual(['normal', 'strong']);
  });

  test('a pin outside its quality binding is published as a pin, never as a binding', () => {
    // `normal` binds to `claude-normal`. Pinning `claude-light` does not make
    // the provider bind `normal` to `claude-light`, so the public line may not
    // say it does — the pin is named as a pin and the catalog's own bindings
    // are reported separately.
    const record = recordFor('claude', {
      quality: quality('normal'),
      taskPinnedProfile: 'claude-light',
    });
    expect(record).toMatchObject({
      effectiveQuality: 'normal',
      profileName: 'claude-light',
      profileSource: 'task-pin',
      sharedWithQualityLevels: ['light'],
    });
    const summary = publicAgentRuntimeSummary(record);
    expect(summary).toContain(
      'profile claude-light (pinned by an operator; this provider binds light to it)',
    );
    expect(summary).not.toContain('normal and light');
    expect(summary).not.toContain('to the same profile');
  });

  test('a session pin whose profile answers its own level claims no shared binding', () => {
    const record = recordFor('claude', {
      quality: quality('strong'),
      sessionPinnedProfile: 'claude-strong',
    });
    expect(record.profileSource).toBe('session-config');
    expect(record.sharedWithQualityLevels).toEqual([]);
    expect(publicAgentRuntimeSummary(record)).toContain(
      'profile claude-strong (pinned by the session default)',
    );
  });
});

describe('agent runtime audit record — a bound may not rewrite a runtime identity', () => {
  /** Longer than the per-value bound, differing only in its final segment. */
  const longBinary = (suffix) => `/opt/${'a'.repeat(240)}/${suffix}`;

  test('a value inside the bound is recorded verbatim', () => {
    const binary = recordFor('gemini').binary;
    expect(binary.length).toBeLessThanOrEqual(MAX_AGENT_RUNTIME_AUDIT_VALUE_CHARS);
    expect(binary).not.toContain('truncated');
  });

  test('two binaries that differ only past the bound keep two different records', () => {
    const first = recordFor('gemini', { env: { ANTIGRAVITY_BIN: longBinary('agy-one') } });
    const second = recordFor('gemini', { env: { ANTIGRAVITY_BIN: longBinary('agy-two') } });
    expect(first.binarySource).toBe('env');
    expect(first.binary).not.toBe(second.binary);
  });

  test('truncation is explicit and carries a verifiable digest of the whole value', () => {
    const value = longBinary('antigravity');
    const record = recordFor('gemini', { env: { ANTIGRAVITY_BIN: value } });
    const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
    expect(record.binary.length).toBeLessThanOrEqual(MAX_AGENT_RUNTIME_AUDIT_VALUE_CHARS);
    expect(record.binary).toContain(`truncated: ${value.length} chars`);
    expect(record.binary).toContain(`sha256:${digest}`);
    expect(record.binary.startsWith(value.slice(0, 100))).toBe(true);
    // The marker survives every internal surface, so no reader of the event or
    // the artifact sees a prefix presented as the executable that ran.
    expect(agentRuntimeAuditEventData(record).binary).toBe(record.binary);
    expect(serializeAgentRuntimeAuditRecord(record)).toContain(`sha256:${digest}`);
  });
});

describe('agent runtime audit record — escalation is a property of the run (§10.3)', () => {
  test('the task keeps its request while the run records the floor', () => {
    const record = recordFor('claude', {
      quality: escalated('normal', 'compat-label', 'strong', 'complexity:low'),
    });
    expect(record).toMatchObject({
      requestedQuality: 'normal',
      requestedQualitySource: 'compat-label',
      requestedQualityLabel: 'complexity:low',
      effectiveQuality: 'strong',
      effectiveQualitySource: 'escalation',
      escalationFloor: 'strong',
      profileName: 'claude-strong',
    });
    const summary = publicAgentRuntimeSummary(record);
    expect(summary).toContain('normal requested by label complexity:low');
    expect(summary).toContain('raised to strong by the review-loop floor');
  });

  test('a floor that raised nothing is still recorded, with the request intact', () => {
    const record = recordFor('claude', {
      quality: quality('maximum', 'label', { label: 'quality:maximum', escalationFloor: 'strong' }),
    });
    expect(record.effectiveQualitySource).toBe('label');
    expect(record.escalationFloor).toBe('strong');
    expect(record.requestedQuality).toBe('maximum');
  });
});

describe('agent runtime audit record — CLI discovery (§7.1, §13.3)', () => {
  test('a version is recorded only when discovery was determinate', () => {
    const available = interpretDiscoveryProbe(CLAUDE_RUNTIME_ADAPTER.discovery, {
      ok: true,
      status: 'available',
      output: '2.4.1 (Claude Code)',
      transient: false,
    });
    const record = recordFor('claude', { discovery: available });
    expect(record.cliStatus).toBe('available');
    expect(record.cliVersion).toBe('2.4.1');
  });

  test('a transiently unprobeable host contributes a status and never a version', () => {
    const indeterminate = interpretDiscoveryProbe(CLAUDE_RUNTIME_ADAPTER.discovery, {
      ok: false,
      status: 'spawn-error',
      output: 'EAGAIN',
      transient: true,
    });
    const record = recordFor('claude', { discovery: indeterminate });
    expect(record.cliStatus).toBe('indeterminate');
    expect(record).not.toHaveProperty('cliVersion');
  });

  test('a version banner is untrusted text: bounded, redacted, and control-free', () => {
    const record = buildAgentRuntimeAuditRecord({
      resolved: resolveFor('claude'),
      resolvedAt: NOW,
      discovery: {
        status: 'available',
        version: `1.0.0 built at /Users/someone/src\tby token abcdefghijklmnop ${'x'.repeat(200)}`,
      },
    });
    expect(record.cliVersion).not.toContain('/Users/someone');
    expect(record.cliVersion).not.toContain('abcdefghijklmnop');
    expect(record.cliVersion).not.toContain('\t');
    expect(record.cliVersion.length).toBeLessThanOrEqual(MAX_AGENT_RUNTIME_CLI_VERSION_CHARS);
  });

  test('no discovery at all records neither a status nor a version', () => {
    const record = recordFor('claude');
    expect(record).not.toHaveProperty('cliStatus');
    expect(record).not.toHaveProperty('cliVersion');
  });
});

describe('agent runtime audit record — the public summary (§13.4)', () => {
  test('names the agent, both quality halves, the profile, and the concrete settings', () => {
    const summary = publicAgentRuntimeSummary(
      recordFor('claude', {
        quality: quality('strong', 'compat-label', { label: 'complexity:high' }),
      }),
    );
    expect(summary).toBe(
      'agent claude (anthropic) — quality: strong requested by label complexity:high — profile claude-strong — model opus, effort high, budget $10',
    );
  });

  test('an absent setting reads as a provider default and an undeclared one is omitted', () => {
    const summary = publicAgentRuntimeSummary(recordFor('codex'));
    expect(summary).toContain('model: provider default');
    expect(summary).toContain('effort high');
    expect(summary).not.toContain('budget');
    expect(summary).not.toContain('not applicable');
  });

  test('an operator override is named as one', () => {
    const summary = publicAgentRuntimeSummary(
      recordFor('claude', { quality: quality('strong'), env: { CLAUDE_MODEL: 'fable' } }),
    );
    expect(summary).toContain('model fable (operator override)');
  });

  test('the resolved binary never reaches the public line, path or not', () => {
    const record = recordFor('gemini', { env: { ANTIGRAVITY_BIN: '/Users/someone/bin/agy' } });
    expect(record.binary).toBe('/Users/someone/bin/agy');
    expect(record.binarySource).toBe('env');
    const summary = publicAgentRuntimeSummary(record);
    expect(summary).not.toContain('/Users/someone');
    expect(summary).not.toContain('bin/agy');
  });

  test('the line is single-line and bounded', () => {
    const summary = publicAgentRuntimeSummary(recordFor('claude'), { maxChars: 40 });
    expect(summary.length).toBeLessThanOrEqual(40);
    expect(summary).not.toContain('\n');
    expect(publicAgentRuntimeSummary(recordFor('claude')).length).toBeLessThanOrEqual(
      MAX_AGENT_RUNTIME_PUBLIC_SUMMARY_CHARS,
    );
  });

  test('every provider produces a summary that names its own concrete settings', () => {
    const antigravity = antigravityInvocationRequest(
      {
        agentId: 'gemini',
        lane: 'review',
        quality: quality('strong'),
        catalog: buildEffectiveAgentProfileCatalog({
          schemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
          providers: { google: { profiles: { 'agy-strong': { model: 'Gemini 3.1 Pro (High)' } } } },
        }),
        env: {},
        prompt: 'review',
      },
      {},
    );
    const planned = planAgentInvocation(REGISTRY, antigravity);
    const summary = publicAgentRuntimeSummary(
      buildAgentRuntimeAuditRecord({
        resolved: planned.resolved,
        plan: planned.invocation,
        resolvedAt: NOW,
      }),
    );
    expect(summary).toContain('agent gemini (google)');
    expect(summary).toContain('model Gemini 3.1 Pro (High)');
  });
});

describe('agent runtime audit record — persistence and surfaces', () => {
  test('the event payload and the artifact bytes are the same record', () => {
    const record = recordFor('claude', { phase: 'implementation', lane: 'implementation' });
    expect(agentRuntimeAuditEventData(record)).toEqual({ ...record });
    expect(JSON.parse(serializeAgentRuntimeAuditRecord(record))).toEqual({ ...record });
    expect(AGENT_RUNTIME_RESOLVED_EVENT).toBe('agent.runtime.resolved');
    expect(AGENT_RUNTIME_AUDIT_ARTIFACT_FILENAME).toBe('agent-runtime.json');
  });

  test('appending starts a trail, keeps order, and reads back', () => {
    const first = recordFor('claude', { phase: 'implementation' });
    const second = recordFor('codex', { phase: 'review' });
    const block = appendAgentRuntimeAuditRecord(
      appendAgentRuntimeAuditRecord(undefined, first),
      second,
    );
    expect(block.dropped).toBe(0);
    const log = readAgentRuntimeAuditLog(taskWith(JSON.parse(JSON.stringify(block))));
    expect(log.records.map((entry) => entry.agentId)).toEqual(['claude', 'codex']);
    expect(log.unreadable).toBe(0);
    expect(latestAgentRuntimeAuditRecord(taskWith(JSON.parse(JSON.stringify(block)))).agentId).toBe(
      'codex',
    );
  });

  test('the trail is bounded, and what it trims is counted rather than hidden', () => {
    let block;
    for (let index = 0; index < MAX_AGENT_RUNTIME_AUDIT_RECORDS + 3; index += 1) {
      block = appendAgentRuntimeAuditRecord(block, recordFor('claude'));
    }
    expect(block.records).toHaveLength(MAX_AGENT_RUNTIME_AUDIT_RECORDS);
    expect(block.dropped).toBe(3);
    const bounded = appendAgentRuntimeAuditRecord(undefined, recordFor('claude'), { limit: 1 });
    expect(appendAgentRuntimeAuditRecord(bounded, recordFor('codex'), { limit: 1 })).toMatchObject({
      dropped: 1,
    });
  });

  test('appending never fails on a record another build wrote', () => {
    const foreign = { recordVersion: 99, agentId: 'claude', whatever: true };
    const block = appendAgentRuntimeAuditRecord(
      { records: [foreign], dropped: 2 },
      recordFor('claude'),
    );
    expect(block.records[0]).toEqual(foreign);
    expect(block.dropped).toBe(2);
    const log = readAgentRuntimeAuditLog(taskWith(JSON.parse(JSON.stringify(block))));
    // Counted, never presented as this version's facts.
    expect(log.unreadable).toBe(1);
    expect(log.records).toHaveLength(1);
  });

  test('an absent trail reads as absent, and a malformed one refuses', () => {
    expect(readAgentRuntimeAuditLog(taskWith(undefined))).toBeUndefined();
    expect(latestAgentRuntimeAuditRecord(taskWith(undefined))).toBeUndefined();
    for (const malformed of ['nope', [], { records: 'nope' }, { records: [], dropped: -1 }]) {
      const err = captureError(() => readAgentRuntimeAuditLog(taskWith(malformed)));
      expect(err?.name).toBe('AgentRuntimeAdapterError');
      expect(err.reason).toBe('invalid-override');
      expect(
        captureError(() => appendAgentRuntimeAuditRecord(malformed, recordFor('claude'))),
      ).toBeDefined();
    }
  });

  test('a record claiming this version but failing it refuses rather than reading as truth', () => {
    const record = { ...recordFor('claude'), effectiveQuality: 'turbo' };
    const err = captureError(() =>
      readAgentRuntimeAuditLog(taskWith({ records: [record], dropped: 0 })),
    );
    expect(err?.name).toBe('AgentRuntimeAdapterError');
    expect(isAgentRuntimeConfigurationError(err)).toBe(true);
  });

  test('a persisted record round-trips through JSON with every field intact', () => {
    const planned = planAgentInvocation(REGISTRY, {
      agentId: 'claude',
      lane: 'review',
      quality: escalated('normal', 'session-config', 'strong'),
      catalog: CATALOG,
      env: { CLAUDE_EFFORT: 'max' },
      prompt: 'review',
    });
    const record = buildAgentRuntimeAuditRecord({
      resolved: planned.resolved,
      plan: planned.invocation,
      phase: 'review',
      lane: 'review',
      resolvedAt: NOW,
      resolutionDurationMs: 7,
      discovery: { status: 'available', version: '2.4.1' },
    });
    const block = JSON.parse(JSON.stringify(appendAgentRuntimeAuditRecord(undefined, record)));
    expect(readAgentRuntimeAuditLog(taskWith(block)).records[0]).toEqual({ ...record });
  });
});
