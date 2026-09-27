/**
 * Agent profile refresh planning (issue #914,
 * docs/agent-runtime-profiles-contract.md §11.6) — the pure comparison behind
 * `admin agent-profile refresh`.
 *
 * What these pin, against the contract's own claims:
 *
 *   - **Preview semantics** — a plan is a change exactly when it removes a
 *     redundant override; stale overrides, operator additions, and advisory
 *     findings alone never produce a write.
 *   - **The settings-preservation invariant** — every proposed overlay's
 *     effective catalog carries the same digest as the current one, so a
 *     refresh can never silently alter an active provider setting.
 *   - **Operator intent is preserved** — values that differ from the
 *     recommendation, profiles the release does not declare, and whole
 *     providers the release does not declare survive verbatim.
 *   - **Inventory sourcing** — a live model listing flags removals across the
 *     effective catalog, but only for the profiles its own binary would run
 *     (one executable's inventory says nothing about another's), and only
 *     when the listing is exhaustive: a truncated listing proves nothing
 *     absent, so it flags no model as removed. Everything
 *     else falls back to the bundled recommended catalog with the source
 *     reported, and the newest discovered name is never proposed as a value.
 *   - **The §11.6 provenance record** — schema-validated, tool-written,
 *     excluded from the digest.
 */
import {
  AGENT_PROFILE_REFRESH_FINDING_KINDS,
  BUILT_IN_AGENT_PROFILE_CATALOG,
  buildEffectiveAgentProfileCatalog,
  parseAgentProfileCatalogDocument,
  planAgentProfileRefresh,
} from '../dist/index.js';

const NOW = '2026-09-11T00:00:00.000Z';

function plan(overlay, extra = {}) {
  return planAgentProfileRefresh({ overlay, now: NOW, ...extra });
}

function overlayDoc(providers) {
  return { schemaVersion: 1, providers };
}

describe('planAgentProfileRefresh — no-change paths', () => {
  test('no overlay: nothing to change, bundled sources, no file proposed', () => {
    const result = plan(undefined);
    expect(result.changed).toBe(false);
    expect(result.proposedOverlay).toBeUndefined();
    expect(result.refreshRecord).toBeUndefined();
    expect(result.changes).toEqual([]);
    expect(result.updateSource).toBe('bundled');
    expect(result.recommendedCatalogVersion).toBe(BUILT_IN_AGENT_PROFILE_CATALOG.catalogVersion);
    expect(result.providerReports.map((r) => r.provider)).toEqual(['anthropic', 'google', 'openai']);
    for (const report of result.providerReports) {
      expect(report.modelInventory.source).toBe('bundled');
    }
    expect(result.currentDigest).toBe(buildEffectiveAgentProfileCatalog(undefined).digest);
  });

  test('an overlay of purely operator values is stale/preserved, never a change', () => {
    const overlay = overlayDoc({
      anthropic: {
        profiles: { 'claude-strong': { model: 'fable' } },
        qualityBindings: { light: 'claude-normal' },
      },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(false);
    expect(result.proposedOverlay).toBeUndefined();
    const kinds = result.findings.map((f) => [f.kind, f.disposition, f.target]);
    expect(kinds).toContainEqual([
      'stale-override',
      'preserved',
      'providers.anthropic.profiles.claude-strong.model',
    ]);
    expect(kinds).toContainEqual([
      'stale-override',
      'preserved',
      'providers.anthropic.qualityBindings.light',
    ]);
    // "fable" is a recommended model (claude-maximum carries it), so pinning it
    // on another profile is not a removed model.
    expect(result.findings.filter((f) => f.kind === 'removed-model')).toEqual([]);
  });

  test('the planner is deterministic for the same input', () => {
    const overlay = overlayDoc({
      anthropic: { profiles: { 'claude-strong': { model: 'opus', budget: '11' } } },
    });
    expect(plan(overlay)).toEqual(plan(overlay));
  });
});

describe('planAgentProfileRefresh — redundant overrides are the tool-managed set', () => {
  test('a field identical to the recommendation is removed and the emptied containers pruned', () => {
    const overlay = overlayDoc({
      anthropic: { profiles: { 'claude-strong': { model: 'opus' } } },
      openai: { qualityBindings: { normal: 'codex-high' } },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(true);
    const removals = result.changes.filter((c) => c.op === 'remove');
    expect(removals.map((c) => c.target).sort()).toEqual([
      'providers.anthropic.profiles.claude-strong.model',
      'providers.openai.qualityBindings.normal',
    ]);
    // The record change is present and last.
    expect(result.changes[result.changes.length - 1].op).toBe('record');
    // Both providers' entries emptied, so the proposed overlay keeps neither.
    expect(result.proposedOverlay.providers).toEqual({});
    expect(result.proposedOverlay.schemaVersion).toBe(1);
    // The invariant, stated by the plan itself: nothing resolved changes.
    expect(result.proposedDigest).toBe(result.currentDigest);
  });

  test('a mixed profile keeps the operator field and drops the redundant one', () => {
    const overlay = overlayDoc({
      anthropic: { profiles: { 'claude-strong': { model: 'opus', budget: '25' } } },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(true);
    expect(result.changes.filter((c) => c.op === 'remove').map((c) => c.target)).toEqual([
      'providers.anthropic.profiles.claude-strong.model',
    ]);
    expect(result.proposedOverlay.providers.anthropic.profiles['claude-strong']).toEqual({
      budget: '25',
    });
    expect(result.proposedDigest).toBe(result.currentDigest);
    const kinds = result.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(['redundant-override', 'stale-override']);
  });

  test('a null unset of a field the recommendation does not set is redundant; one that shadows a value is kept', () => {
    const overlay = overlayDoc({
      openai: { profiles: { 'codex-high': { model: null } } },
      anthropic: { profiles: { 'claude-light': { model: null } } },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(true);
    expect(result.changes.filter((c) => c.op === 'remove').map((c) => c.target)).toEqual([
      'providers.openai.profiles.codex-high.model',
    ]);
    // The meaningful unset survives, verbatim.
    expect(result.proposedOverlay.providers.anthropic.profiles['claude-light']).toEqual({
      model: null,
    });
    expect(
      result.findings.find(
        (f) => f.target === 'providers.anthropic.profiles.claude-light.model',
      ),
    ).toMatchObject({ kind: 'stale-override', disposition: 'preserved' });
    expect(result.proposedDigest).toBe(result.currentDigest);
  });

  test('an empty override of a recommended profile and an identical capability list are both removable', () => {
    const overlay = overlayDoc({
      anthropic: { profiles: { 'claude-light': {} } },
      openai: { capabilities: { effort: ['low', 'medium', 'high'] } },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(true);
    expect(result.changes.filter((c) => c.op === 'remove').map((c) => c.target).sort()).toEqual([
      'providers.anthropic.profiles.claude-light',
      'providers.openai.capabilities.effort',
    ]);
    expect(result.proposedOverlay.providers).toEqual({});
    expect(result.proposedDigest).toBe(result.currentDigest);
  });

  test('an order-different capability list is NOT removable (the declaration participates verbatim)', () => {
    const overlay = overlayDoc({
      openai: { capabilities: { effort: ['high', 'medium', 'low'] } },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(['stale-override']);
  });

  test('the proposed overlay carries the §11.6 provenance record and re-validates', () => {
    const overlay = overlayDoc({
      google: { profiles: { 'agy-strong': { providerOptions: { printTimeout: '15m' } } } },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(true);
    expect(result.refreshRecord).toEqual({
      refreshedAt: NOW,
      updateSource: 'bundled',
      recommendedCatalogVersion: BUILT_IN_AGENT_PROFILE_CATALOG.catalogVersion,
    });
    expect(result.proposedOverlay.refresh).toEqual(result.refreshRecord);
    // The written document round-trips through the closed-schema gate, and the
    // record does not perturb the digest.
    const reparsed = parseAgentProfileCatalogDocument(
      JSON.parse(JSON.stringify(result.proposedOverlay)),
    );
    expect(buildEffectiveAgentProfileCatalog(reparsed).digest).toBe(result.currentDigest);
  });

  test('an operator catalogVersion label is preserved through an apply', () => {
    const overlay = {
      schemaVersion: 1,
      catalogVersion: 'ops-2026-09-01',
      providers: { anthropic: { profiles: { 'claude-normal': { effort: 'high' } } } },
    };
    const result = plan(overlay);
    expect(result.changed).toBe(true);
    expect(result.proposedOverlay.catalogVersion).toBe('ops-2026-09-01');
    expect(result.proposedDigest).toBe(result.currentDigest);
  });
});

describe('planAgentProfileRefresh — operator additions are preserved and inspected', () => {
  test('a dated operator profile pinning a model the release no longer recommends is flagged, not touched', () => {
    const overlay = overlayDoc({
      anthropic: {
        profiles: { 'claude-strong-2025-01-01': { model: 'claude-2', effort: 'high' } },
      },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(false);
    const byKind = Object.fromEntries(
      AGENT_PROFILE_REFRESH_FINDING_KINDS.map((k) => [k, result.findings.filter((f) => f.kind === k)]),
    );
    expect(byKind['operator-addition']).toHaveLength(1);
    expect(byKind['operator-addition'][0].disposition).toBe('preserved');
    expect(byKind['removed-model']).toHaveLength(1);
    expect(byKind['removed-model'][0]).toMatchObject({
      disposition: 'advisory',
      target: 'providers.anthropic.profiles.claude-strong-2025-01-01.model',
    });
    expect(byKind['removed-model'][0].message).toContain('"claude-2"');
  });

  test('an effort outside the release descriptor is advisory, on the descriptor and on the profile', () => {
    const overlay = overlayDoc({
      openai: {
        capabilities: { effort: ['low', 'medium', 'high', 'xhigh'] },
        profiles: { 'codex-xhigh': { effort: 'xhigh' } },
        qualityBindings: { maximum: 'codex-xhigh' },
      },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(false);
    const unsupported = result.findings.filter((f) => f.kind === 'unsupported-effort');
    expect(unsupported.map((f) => f.target).sort()).toEqual([
      'providers.openai.capabilities.effort',
      'providers.openai.profiles.codex-xhigh.effort',
    ]);
    for (const finding of unsupported) expect(finding.disposition).toBe('advisory');
    // The custom binding to the operator profile is preserved and reported.
    expect(
      result.findings.find((f) => f.target === 'providers.openai.qualityBindings.maximum'),
    ).toMatchObject({ kind: 'stale-override', disposition: 'preserved' });
  });

  test('a whole provider the release does not declare is preserved verbatim', () => {
    const overlay = overlayDoc({
      mistral: {
        capabilities: { model: 'free' },
        profiles: { 'mistral-normal': { model: 'mistral-large' } },
        qualityBindings: {
          light: 'mistral-normal',
          normal: 'mistral-normal',
          strong: 'mistral-normal',
          maximum: 'mistral-normal',
        },
      },
      anthropic: { profiles: { 'claude-strong': { effort: 'high' } } },
    });
    const result = plan(overlay);
    expect(result.changed).toBe(true); // the anthropic effort override is redundant
    expect(result.proposedOverlay.providers.mistral).toEqual(overlay.providers.mistral);
    expect(
      result.findings.find((f) => f.target === 'providers.mistral'),
    ).toMatchObject({ kind: 'operator-addition', disposition: 'preserved' });
    // No inventory report and no removed-model scan for a provider the release
    // does not declare.
    expect(result.providerReports.map((r) => r.provider)).toEqual([
      'anthropic',
      'google',
      'openai',
    ]);
    expect(result.proposedDigest).toBe(result.currentDigest);
  });
});

describe('planAgentProfileRefresh — model inventories', () => {
  test('a live listing flags every configured model it does not contain, across the effective catalog', () => {
    const overlay = overlayDoc({
      google: { profiles: { 'agy-strong': { model: 'Old Model' } } },
    });
    const result = plan(overlay, {
      discovery: {
        google: {
          modelsByBinary: {
            agy: { status: 'listed', models: ['Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)'] },
          },
          profileBinaries: { 'agy-strong': 'agy' },
        },
      },
    });
    const google = result.providerReports.find((r) => r.provider === 'google');
    expect(google.modelInventory.source).toBe('live');
    expect(google.modelInventory.models).toEqual(['Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)']);
    expect(result.updateSource).toBe('mixed');
    const removed = result.findings.filter((f) => f.kind === 'removed-model');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      target: 'providers.google.profiles.agy-strong.model',
      disposition: 'advisory',
    });
    // Advisory only: the overlay value is preserved and nothing is proposed
    // from the listing — a discovered name is never a recommendation.
    expect(result.changed).toBe(false);
    for (const change of result.changes) {
      expect(change.op).not.toBe('record');
    }
  });

  test('a configured model the live listing contains is not flagged', () => {
    const overlay = overlayDoc({
      google: { profiles: { 'agy-strong': { model: 'Gemini 3.1 Pro (Low)' } } },
    });
    const result = plan(overlay, {
      discovery: {
        google: {
          modelsByBinary: { agy: { status: 'listed', models: ['Gemini 3.1 Pro (Low)'] } },
          profileBinaries: { 'agy-strong': 'agy' },
        },
      },
    });
    expect(result.findings.filter((f) => f.kind === 'removed-model')).toEqual([]);
  });

  test('a truncated listing is never treated as exhaustive: absence from it flags nothing', () => {
    // The probe interpreter bounds a chatty CLI's answer and says so. A
    // configured model listed past that bound is absent from the carried
    // prefix while being explicitly listed by the CLI, so no removed-model
    // finding may rest on the prefix — and none on the bundled fallback
    // either, which would manufacture the same false finding through a
    // different door (issue #914 review).
    const overlay = overlayDoc({
      google: { profiles: { 'agy-strong': { model: 'The 65th Model' } } },
    });
    const result = plan(overlay, {
      discovery: {
        google: {
          modelsByBinary: {
            agy: {
              status: 'listed',
              models: ['Gemini 3.1 Pro (Low)'],
              truncated: true,
              detail: 'only the first 64 listed models were kept',
            },
          },
          profileBinaries: { 'agy-strong': 'agy' },
        },
      },
    });
    expect(result.findings.filter((f) => f.kind === 'removed-model')).toEqual([]);
    // The incompleteness is preserved for the operator, never silently eaten:
    // the inventory stays live and its reason carries the interpreter's
    // warning together with its consequence.
    const google = result.providerReports.find((r) => r.provider === 'google');
    expect(google.modelInventory.source).toBe('live');
    expect(google.modelInventory.reason).toContain('only the first 64 listed models were kept');
    expect(google.modelInventory.reason).toContain('not exhaustive');
  });

  test('a listing answers only for the profiles its own binary would run', () => {
    const overlay = overlayDoc({
      google: {
        profiles: {
          'agy-light': { model: 'Model A' },
          'agy-strong': { model: 'Model B' },
          'agy-maximum': { model: 'Gone Model' },
        },
      },
    });
    const result = plan(overlay, {
      discovery: {
        google: {
          modelsByBinary: {
            'agy-a': { status: 'listed', models: ['Model A'] },
            'agy-b': { status: 'listed', models: ['Model B'] },
          },
          profileBinaries: { 'agy-light': 'agy-a', 'agy-strong': 'agy-b', 'agy-maximum': 'agy-b' },
        },
      },
    });
    // 'Model B' is missing from binary A's listing, but the profile it is
    // configured on runs binary B, which offers it — no finding. Only the
    // model its own executable does not list is flagged.
    const removed = result.findings.filter((f) => f.kind === 'removed-model');
    expect(removed.map((f) => f.target)).toEqual([
      'providers.google.profiles.agy-maximum.model',
    ]);
    expect(removed[0].message).toContain('"agy-b"');
    const google = result.providerReports.find((r) => r.provider === 'google');
    expect(google.modelInventory.source).toBe('live');
    expect(google.modelInventory.models).toEqual(['Model A', 'Model B']);
  });

  test('a profile served by a binary that did not list falls back to the bundled comparison', () => {
    const overlay = overlayDoc({
      google: {
        profiles: {
          'agy-light': { model: 'Model A' },
          'agy-strong': { model: 'Model B' },
        },
      },
    });
    const result = plan(overlay, {
      discovery: {
        google: {
          modelsByBinary: {
            'agy-a': { status: 'listed', models: ['Model A'] },
            'agy-b': { status: 'undiscovered', detail: 'no models subcommand' },
          },
          profileBinaries: { 'agy-light': 'agy-a', 'agy-strong': 'agy-b' },
        },
      },
    });
    // agy-strong has no live listing of its own, so its overlay model gets
    // the bundled recommended comparison — never binary A's inventory.
    const removed = result.findings.filter((f) => f.kind === 'removed-model');
    expect(removed.map((f) => f.target)).toEqual([
      'providers.google.profiles.agy-strong.model',
    ]);
    expect(removed[0].message).toContain("release's recommended models");
    const google = result.providerReports.find((r) => r.provider === 'google');
    expect(google.modelInventory.source).toBe('live');
    expect(google.modelInventory.reason).toContain('fall back to the bundled recommended catalog');
    // The partially-bundled provider keeps the aggregate source honest.
    expect(result.updateSource).toBe('mixed');
  });

  test('a profile with no known executable is never judged by another binary\'s listing', () => {
    const overlay = overlayDoc({
      google: { profiles: { 'agy-strong-2025-01-01': { model: 'Pinned Old' } } },
    });
    const result = plan(overlay, {
      discovery: {
        google: {
          modelsByBinary: { agy: { status: 'listed', models: ['Gemini 3.1 Pro (Low)'] } },
          profileBinaries: {},
        },
      },
    });
    // The operator profile is not in the profile→binary map, so the live scan
    // says nothing about it; the bundled comparison still applies.
    const removed = result.findings.filter((f) => f.kind === 'removed-model');
    expect(removed.map((f) => f.target)).toEqual([
      'providers.google.profiles.agy-strong-2025-01-01.model',
    ]);
    expect(removed[0].message).toContain("release's recommended models");
  });

  test('an unreadable or skipped listing degrades to the bundled source and says so', () => {
    const undiscovered = plan(undefined, {
      discovery: {
        google: {
          modelsByBinary: { agy: { status: 'undiscovered', detail: 'no models subcommand' } },
        },
      },
    });
    const g1 = undiscovered.providerReports.find((r) => r.provider === 'google');
    expect(g1.modelInventory.source).toBe('bundled');
    expect(g1.modelInventory.reason).toContain('could not be read');
    expect(g1.modelInventory.reason).toContain('no models subcommand');

    const skipped = plan(undefined, {
      discovery: { google: { modelsSkipped: '--offline: live discovery skipped' } },
    });
    const g2 = skipped.providerReports.find((r) => r.provider === 'google');
    expect(g2.modelInventory.source).toBe('bundled');
    expect(g2.modelInventory.reason).toContain('--offline');
    expect(skipped.updateSource).toBe('bundled');

    const indeterminate = plan(undefined, {
      discovery: { google: { modelsByBinary: { agy: { status: 'indeterminate' } } } },
    });
    expect(
      indeterminate.providerReports.find((r) => r.provider === 'google').modelInventory.reason,
    ).toContain('transiently');
  });

  test('providers with no listing interface report the bundled catalog as the comparison source', () => {
    const result = plan(undefined);
    const anthropic = result.providerReports.find((r) => r.provider === 'anthropic');
    expect(anthropic.modelInventory.source).toBe('bundled');
    expect(anthropic.modelInventory.reason).toContain('no bounded, non-interactive model listing');
  });
});

describe('the §11.6 refresh record in the catalog schema', () => {
  test('a valid record parses and an unknown member refuses closed', () => {
    const parsed = parseAgentProfileCatalogDocument({
      schemaVersion: 1,
      refresh: {
        refreshedAt: NOW,
        updateSource: 'bundled',
        recommendedCatalogVersion: 'builtin-2026-09-07',
      },
    });
    expect(parsed.refresh.updateSource).toBe('bundled');

    expect(() =>
      parseAgentProfileCatalogDocument({
        schemaVersion: 1,
        refresh: { refreshedAt: NOW, updateSource: 'bundled', recommendedCatalogVersion: 'x', extra: 1 },
      }),
    ).toThrow(/unknown key "extra"/);
  });

  test('a malformed updateSource or timestamp refuses as catalog-invalid', () => {
    expect(() =>
      parseAgentProfileCatalogDocument({
        schemaVersion: 1,
        refresh: { refreshedAt: NOW, updateSource: 'network', recommendedCatalogVersion: 'x' },
      }),
    ).toThrow(/updateSource must be one of live, bundled, mixed/);
    expect(() =>
      parseAgentProfileCatalogDocument({
        schemaVersion: 1,
        refresh: { refreshedAt: 'yesterday-ish', updateSource: 'live', recommendedCatalogVersion: 'x' },
      }),
    ).toThrow(/refreshedAt must be an ISO 8601 timestamp/);
  });

  test('the record does not perturb the effective digest', () => {
    const bare = buildEffectiveAgentProfileCatalog(
      parseAgentProfileCatalogDocument({ schemaVersion: 1, providers: {} }),
    );
    const stamped = buildEffectiveAgentProfileCatalog(
      parseAgentProfileCatalogDocument({
        schemaVersion: 1,
        refresh: { refreshedAt: NOW, updateSource: 'mixed', recommendedCatalogVersion: 'x' },
        providers: {},
      }),
    );
    expect(stamped.digest).toBe(bare.digest);
  });
});
