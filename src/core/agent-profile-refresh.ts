// ---------------------------------------------------------------------------
// Agent profile refresh planning (issue #914) — the pure comparison behind
// `admin agent-profile refresh` (docs/agent-runtime-profiles-contract.md §11.6).
//
// The planner answers one question: how does the operator's overlay relate to
// this release's recommended catalog (the compiled-in
// BUILT_IN_AGENT_PROFILE_CATALOG) and to what the installed provider CLIs
// report, and which part of the answer may the tool act on? It produces:
//
//   - **Findings** — removed models, efforts the release does not declare,
//     overrides identical to the recommendation, overrides shadowing a
//     different recommendation, and operator-created additions. Every finding
//     names a document path an operator can edit.
//   - **A proposed overlay** — the current overlay with exactly the
//     tool-managed values changed: overrides identical to the recommendation
//     removed (so future recommendations flow through), emptied containers
//     pruned, and the §11.6 refresh record set. Nothing else. In particular:
//
//       * **Operator intent is preserved.** A profile the release does not
//         declare, a binding that names a different profile, a field pinned to
//         a different value, and an explicit `null` unset that shadows a
//         recommended value are all kept verbatim, however stale the planner
//         believes them to be. They are reported, never rewritten — there is
//         deliberately no force/replace mode.
//       * **The newest model is never assumed preferred.** The only source of
//         a recommendation is the release's bundled catalog; a live model
//         listing can flag a configured model as no longer offered, but no
//         discovered name is ever proposed as a value (§11.3).
//       * **Settings preservation is enforced, not hoped for.** The proposed
//         overlay's effective catalog must produce the same digest as the
//         current one — the refresh record is excluded from the digest by
//         design — and the planner throws rather than return a plan that would
//         alter any resolved setting. "A refresh cannot silently alter active
//         provider settings" is a checked invariant.
//
// The planner is pure: it spawns nothing and reads no file. Discovery facts —
// what each queried executable's bounded, non-interactive model listing
// reported (keyed by the binary that produced it, with the executable each
// profile resolves to alongside), or why none ran — are injected by the
// caller, and their absence degrades to the bundled catalog with the source
// stated, never to a guess.
// ---------------------------------------------------------------------------

import type {
  AgentProfileCatalogDocument,
  AgentProfileProviderDocument,
  AgentProfileRefreshRecord,
  AgentProfileRefreshSource,
  AgentProfileSettingsDocument,
  CapabilityDeclaration,
  QualityLevel,
} from "./agent-profile-catalog.js";
import {
  AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
  BUILT_IN_AGENT_PROFILE_CATALOG,
  QUALITY_LEVELS,
  buildEffectiveAgentProfileCatalog,
  parseAgentProfileCatalogDocument,
} from "./agent-profile-catalog.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The closed set of things a refresh can notice. */
export const AGENT_PROFILE_REFRESH_FINDING_KINDS = [
  /** A configured model the current model inventory does not contain. */
  "removed-model",
  /** An effort value (or widened effort descriptor) the release does not declare. */
  "unsupported-effort",
  /** An overlay value identical to the release recommendation — removal proposed. */
  "redundant-override",
  /** An overlay value shadowing a *different* recommendation — kept, reported. */
  "stale-override",
  /** An operator-created provider or profile the release does not declare — kept. */
  "operator-addition",
] as const;

export type AgentProfileRefreshFindingKind =
  (typeof AGENT_PROFILE_REFRESH_FINDING_KINDS)[number];

/**
 * What the plan does about a finding: `proposed` findings have a matching
 * change in the plan; `advisory` ones need an operator decision the tool may
 * not make; `preserved` ones record that an operator value was deliberately
 * left alone.
 */
export type AgentProfileRefreshDisposition = "proposed" | "advisory" | "preserved";

export interface AgentProfileRefreshFinding {
  readonly kind: AgentProfileRefreshFindingKind;
  readonly disposition: AgentProfileRefreshDisposition;
  readonly provider: string;
  /** Document path inside the overlay/effective catalog, e.g. `providers.openai.profiles.codex-high.effort`. */
  readonly target: string;
  readonly message: string;
}

export interface AgentProfileRefreshChange {
  readonly op: "remove" | "record";
  readonly provider?: string;
  readonly target: string;
  /** The overlay value a `remove` drops, rendered for the diff. */
  readonly before?: string;
  readonly note: string;
}

/** Which inventory answered "does this model still exist?" for one provider. */
export type AgentProfileModelInventorySource = "live" | "bundled";

export interface AgentProfileRefreshModelListing {
  readonly status: "listed" | "undiscovered" | "indeterminate";
  readonly models?: readonly string[];
  /**
   * True when `models` is a bounded prefix of a longer answer (the probe
   * interpreter kept only its first N names). A truncated listing can prove a
   * name present but never absent, so the planner derives no absence-based
   * finding from it: a configured model the CLI listed past the bound is not
   * "removed".
   */
  readonly truncated?: boolean;
  readonly detail?: string;
}

/**
 * Per-provider discovery facts, injected by the caller (the planner spawns
 * nothing). `modelsByBinary` holds one bounded, non-interactive model listing
 * per executable that was queried, keyed by the binary that produced it, and
 * `profileBinaries` names the executable each catalog profile resolves to —
 * so a profile is only ever compared against the listing of the binary that
 * would run it, never against another executable's inventory. A profile
 * absent from `profileBinaries`, or served by a binary whose listing never
 * arrived, gets the bundled comparison instead. `modelsSkipped` says why no
 * listing ran at all, when the caller knows (e.g. `--offline`). Everything
 * absent means the provider offers no such interface.
 */
export interface AgentProfileRefreshDiscoveryFacts {
  readonly modelsByBinary?: Readonly<Record<string, AgentProfileRefreshModelListing>>;
  readonly profileBinaries?: Readonly<Record<string, string>>;
  readonly modelsSkipped?: string;
}

export interface AgentProfileRefreshProviderReport {
  readonly provider: string;
  readonly modelInventory: {
    readonly source: AgentProfileModelInventorySource;
    readonly reason: string;
    /** The live listing, when that is what answered. */
    readonly models?: readonly string[];
  };
}

export interface PlanAgentProfileRefreshInput {
  /** The operator overlay as parsed from the configured file, or undefined when no file exists. */
  readonly overlay: AgentProfileCatalogDocument | undefined;
  /** Injected per-provider discovery facts (see {@link AgentProfileRefreshDiscoveryFacts}). */
  readonly discovery?: Readonly<Record<string, AgentProfileRefreshDiscoveryFacts>>;
  /** ISO timestamp the refresh record would carry. Injected so the planner stays pure. */
  readonly now: string;
}

export interface AgentProfileRefreshPlan {
  /** True when applying would rewrite the overlay file. */
  readonly changed: boolean;
  readonly findings: readonly AgentProfileRefreshFinding[];
  readonly changes: readonly AgentProfileRefreshChange[];
  /** The overlay applying would write. Present exactly when `changed`. */
  readonly proposedOverlay?: AgentProfileCatalogDocument;
  /** The §11.6 provenance record applying would embed. Present exactly when `changed`. */
  readonly refreshRecord?: AgentProfileRefreshRecord;
  readonly providerReports: readonly AgentProfileRefreshProviderReport[];
  /** The aggregate of the per-provider inventory sources. */
  readonly updateSource: AgentProfileRefreshSource;
  /** The bundled recommended catalog's own revision label. */
  readonly recommendedCatalogVersion: string;
  /** Digest of the current effective catalog. */
  readonly currentDigest: string;
  /** Digest of the proposed overlay's effective catalog — equal to `currentDigest` by invariant. */
  readonly proposedDigest?: string;
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/** One executable's answer, with whether it may prove a model absent. */
interface BinaryModelListing {
  readonly models: ReadonlySet<string>;
  /**
   * False when the listing was truncated to a bound: it still proves every
   * carried name present, but a name outside the set may simply have been
   * listed past the bound, so no absence-based finding may rest on it.
   */
  readonly exhaustive: boolean;
}

interface ModelInventory {
  readonly source: AgentProfileModelInventorySource;
  readonly reason: string;
  /** The listings that arrived, keyed by the executable that produced each. */
  readonly listedByBinary: ReadonlyMap<string, BinaryModelListing>;
  /** Which executable each catalog profile resolves to, per the caller. */
  readonly profileBinaries: Readonly<Record<string, string>>;
  /** True when some queried binary listed and another did not — the latter's profiles use the bundled fallback. */
  readonly partiallyListed: boolean;
  /** The models the release's recommended profiles carry, for the bundled fallback. */
  readonly recommended: ReadonlySet<string>;
  readonly listedModels?: readonly string[];
}

export function planAgentProfileRefresh(
  input: PlanAgentProfileRefreshInput,
): AgentProfileRefreshPlan {
  // Both documents go through the shape gate, for the reason
  // buildEffectiveAgentProfileCatalog re-parses: a caller reaching this from
  // JavaScript cannot hand the comparison a document the schema would refuse.
  const recommended = parseAgentProfileCatalogDocument(
    BUILT_IN_AGENT_PROFILE_CATALOG,
    "<recommended catalog>",
  );
  const overlay =
    input.overlay === undefined
      ? undefined
      : parseAgentProfileCatalogDocument(input.overlay, "<overlay>");

  const current = buildEffectiveAgentProfileCatalog(overlay);
  const recommendedCatalogVersion = recommended.catalogVersion ?? "(unversioned)";

  const findings: AgentProfileRefreshFinding[] = [];
  const changes: AgentProfileRefreshChange[] = [];
  const providerReports: AgentProfileRefreshProviderReport[] = [];
  const sourcesSeen = new Set<AgentProfileModelInventorySource>();

  // Inventory + removed-model scan, per recommended provider. The live branch
  // checks every model the CURRENT EFFECTIVE catalog resolves (built-in and
  // overlay alike — a recommended model this install's CLI no longer offers is
  // exactly as worth flagging), but only against the listing of the executable
  // that would run each profile: one binary's inventory says nothing about
  // another's. A profile with no live-listed binary of its own, and every
  // profile when nothing listed, gets the bundled comparison — which can only
  // compare against the release's own recommended models, so it checks
  // overlay-supplied models during the overlay walk below.
  const inventories = new Map<string, ModelInventory>();
  for (const provider of Object.keys(recommended.providers).sort()) {
    const inventory = buildModelInventory(
      provider,
      recommended.providers[provider],
      input.discovery?.[provider],
    );
    inventories.set(provider, inventory);
    sourcesSeen.add(inventory.source);
    if (inventory.partiallyListed) sourcesSeen.add("bundled");
    providerReports.push({
      provider,
      modelInventory: {
        source: inventory.source,
        reason: inventory.reason,
        ...(inventory.listedModels !== undefined ? { models: inventory.listedModels } : {}),
      },
    });

    if (inventory.listedByBinary.size > 0) {
      const entry = current.providers[provider];
      if (entry !== undefined) {
        for (const name of Object.keys(entry.profiles).sort()) {
          const model = entry.profiles[name].settings.model;
          if (model === undefined) continue;
          const binary = inventory.profileBinaries[name];
          const listed = binary === undefined ? undefined : inventory.listedByBinary.get(binary);
          if (listed === undefined || listed.models.has(model)) continue;
          // A truncated listing is not exhaustive: the configured model may
          // sit past the bound the interpreter kept, so its absence from the
          // carried prefix proves nothing and flags nothing (the inventory
          // reason reports the truncation instead).
          if (!listed.exhaustive) continue;
          findings.push({
            kind: "removed-model",
            disposition: "advisory",
            provider,
            target: `providers.${provider}.profiles.${name}.model`,
            message: `model ${JSON.stringify(model)} is not among the ${listed.models.size} model(s) the installed CLI ${JSON.stringify(binary)} lists — it may have been removed; verify it before the next run`,
          });
        }
      }
    }
  }

  // The overlay walk: findings for every override, and the proposed document
  // with the tool-managed removals applied.
  let proposedProviders: Record<string, AgentProfileProviderDocument> | undefined;
  if (overlay !== undefined) {
    proposedProviders = {};
    for (const provider of Object.keys(overlay.providers)) {
      const overlayEntry = overlay.providers[provider];
      const recEntry = hasOwn(recommended.providers, provider)
        ? recommended.providers[provider]
        : undefined;
      if (recEntry === undefined) {
        findings.push({
          kind: "operator-addition",
          disposition: "preserved",
          provider,
          target: `providers.${provider}`,
          message:
            "the release's recommended catalog does not declare this provider; the operator-created entry is preserved unchanged",
        });
        proposedProviders[provider] = deepCopy(overlayEntry);
        continue;
      }
      const proposedEntry = refreshProvider(
        provider,
        overlayEntry,
        recEntry,
        inventories.get(provider),
        findings,
        changes,
      );
      if (proposedEntry !== undefined) proposedProviders[provider] = proposedEntry;
    }
  }

  // The plan is a change exactly when it removes something: every change op so
  // far is a `remove`, and a walk that removed nothing rebuilt the same
  // document. Cosmetic differences (key order) never trigger a write.
  const changed = changes.length > 0;
  sortFindings(findings);
  sortChanges(changes);

  let proposedOverlay: AgentProfileCatalogDocument | undefined;
  let refreshRecord: AgentProfileRefreshRecord | undefined;
  let proposedDigest: string | undefined;
  if (changed && overlay !== undefined && proposedProviders !== undefined) {
    refreshRecord = {
      refreshedAt: input.now,
      updateSource: aggregateSource(sourcesSeen),
      recommendedCatalogVersion,
    };
    changes.push({
      op: "record",
      target: "refresh",
      note: `record the refresh provenance (refreshedAt ${input.now}, updateSource ${refreshRecord.updateSource}, recommended catalog ${recommendedCatalogVersion})`,
    });
    proposedOverlay = {
      schemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
      ...(overlay.catalogVersion !== undefined ? { catalogVersion: overlay.catalogVersion } : {}),
      refresh: refreshRecord,
      providers: proposedProviders,
    };

    // The checked invariant: applying may not alter any resolved setting. The
    // digest covers the effective values (and excludes the refresh record), so
    // digest equality IS "no active provider setting changed".
    const proposed = buildEffectiveAgentProfileCatalog(
      parseAgentProfileCatalogDocument(proposedOverlay, "<proposed overlay>"),
    );
    if (proposed.digest !== current.digest) {
      throw new Error(
        `agent-profile refresh planner bug: the proposed overlay would change the effective catalog (current ${current.digest}, proposed ${proposed.digest}); refusing to propose it`,
      );
    }
    proposedDigest = proposed.digest;
  }

  return {
    changed,
    findings,
    changes,
    ...(proposedOverlay !== undefined ? { proposedOverlay } : {}),
    ...(refreshRecord !== undefined ? { refreshRecord } : {}),
    providerReports,
    updateSource: aggregateSource(sourcesSeen),
    recommendedCatalogVersion,
    currentDigest: current.digest,
    ...(proposedDigest !== undefined ? { proposedDigest } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-provider walk
// ---------------------------------------------------------------------------

function refreshProvider(
  provider: string,
  overlayEntry: AgentProfileProviderDocument,
  recEntry: AgentProfileProviderDocument,
  inventory: ModelInventory | undefined,
  findings: AgentProfileRefreshFinding[],
  changes: AgentProfileRefreshChange[],
): AgentProfileProviderDocument | undefined {
  const base = `providers.${provider}`;
  const proposed: AgentProfileProviderDocument = {};

  // Capability descriptors — replace per key (§9.4), so each overlay key is
  // compared whole against the release's declaration for that key.
  if (overlayEntry.capabilities !== undefined) {
    const kept: Record<string, CapabilityDeclaration> = {};
    for (const key of Object.keys(overlayEntry.capabilities)) {
      const declared = overlayEntry.capabilities[key];
      const recDeclared = hasOwn(recEntry.capabilities ?? {}, key)
        ? (recEntry.capabilities as Record<string, CapabilityDeclaration>)[key]
        : undefined;
      const target = `${base}.capabilities.${key}`;
      if (recDeclared !== undefined && capabilityEquals(declared, recDeclared)) {
        findings.push({
          kind: "redundant-override",
          disposition: "proposed",
          provider,
          target,
          message: `the capability declaration ${renderCapability(declared)} is identical to the release recommendation; removing it lets future recommendations apply`,
        });
        changes.push({
          op: "remove",
          provider,
          target,
          before: renderCapability(declared),
          note: "identical to the release recommendation",
        });
        continue;
      }
      kept[key] = declared;
      if (recDeclared === undefined) {
        findings.push({
          kind: key === "effort" ? "unsupported-effort" : "stale-override",
          disposition: key === "effort" ? "advisory" : "preserved",
          provider,
          target,
          message:
            key === "effort"
              ? `the release declares no effort setting for provider "${provider}"; the widened descriptor is kept — verify the installed CLI accepts an effort at all`
              : `the release declares no "${key}" capability for provider "${provider}"; the operator declaration is kept`,
        });
        continue;
      }
      if (key === "effort" && declared !== "free" && recDeclared !== "free") {
        const extras = declared.filter((value) => !recDeclared.includes(value));
        if (extras.length > 0) {
          findings.push({
            kind: "unsupported-effort",
            disposition: "advisory",
            provider,
            target,
            message: `effort value(s) ${extras.map((v) => JSON.stringify(v)).join(", ")} are not declared by the release for provider "${provider}"; kept — verify the installed CLI accepts them`,
          });
          continue;
        }
      }
      findings.push({
        kind: "stale-override",
        disposition: "preserved",
        provider,
        target,
        message: `the overlay declares ${renderCapability(declared)} where the release recommends ${renderCapability(recDeclared)}; kept`,
      });
    }
    if (Object.keys(kept).length > 0) proposed.capabilities = kept;
    else if (Object.keys(overlayEntry.capabilities).length === 0) proposed.capabilities = {};
  }

  // Profiles — merge field by field (§9.4), so redundancy is a per-field fact.
  if (overlayEntry.profiles !== undefined) {
    const kept: Record<string, AgentProfileSettingsDocument> = {};
    for (const name of Object.keys(overlayEntry.profiles)) {
      const overlayProfile = overlayEntry.profiles[name];
      const recProfile = hasOwn(recEntry.profiles ?? {}, name)
        ? (recEntry.profiles as Record<string, AgentProfileSettingsDocument>)[name]
        : undefined;
      const profilePath = `${base}.profiles.${name}`;
      if (recProfile === undefined) {
        findings.push({
          kind: "operator-addition",
          disposition: "preserved",
          provider,
          target: profilePath,
          message:
            "the release's recommended catalog does not declare this profile; the operator-created profile is preserved unchanged",
        });
        inspectOperatorProfile(provider, name, overlayProfile, recEntry, inventory, findings);
        kept[name] = deepCopy(overlayProfile);
        continue;
      }
      const keptProfile = refreshProfileFields(
        provider,
        name,
        profilePath,
        overlayProfile,
        recProfile,
        recEntry,
        inventory,
        findings,
        changes,
      );
      if (Object.keys(overlayProfile).length === 0) {
        // A declared-but-empty override of a recommended profile changes no
        // value; it only relabels provenance, so it is tool-removable.
        findings.push({
          kind: "redundant-override",
          disposition: "proposed",
          provider,
          target: profilePath,
          message: "the override declares no field and changes nothing; removing it",
        });
        changes.push({
          op: "remove",
          provider,
          target: profilePath,
          before: "{}",
          note: "an empty override of a recommended profile",
        });
        continue;
      }
      if (keptProfile !== undefined) kept[name] = keptProfile;
    }
    if (Object.keys(kept).length > 0) proposed.profiles = kept;
    else if (Object.keys(overlayEntry.profiles).length === 0) proposed.profiles = {};
  }

  // Quality bindings — replace one level at a time (§9.4).
  if (overlayEntry.qualityBindings !== undefined) {
    const kept: Partial<Record<QualityLevel, string>> = {};
    let keptAny = false;
    for (const level of QUALITY_LEVELS) {
      const overlayName = overlayEntry.qualityBindings[level];
      if (overlayName === undefined) continue;
      const recName = recEntry.qualityBindings?.[level];
      const target = `${base}.qualityBindings.${level}`;
      if (overlayName === recName) {
        findings.push({
          kind: "redundant-override",
          disposition: "proposed",
          provider,
          target,
          message: `the binding to "${overlayName}" is identical to the release recommendation; removing it lets future recommendations apply`,
        });
        changes.push({
          op: "remove",
          provider,
          target,
          before: overlayName,
          note: "identical to the release recommendation",
        });
        continue;
      }
      kept[level] = overlayName;
      keptAny = true;
      findings.push({
        kind: "stale-override",
        disposition: "preserved",
        provider,
        target,
        message:
          recName === undefined
            ? `the release recommends no binding for "${level}"; the custom binding to "${overlayName}" is kept`
            : `the release recommends binding "${level}" to "${recName}"; the custom binding to "${overlayName}" is kept`,
      });
    }
    if (keptAny) proposed.qualityBindings = kept;
    else if (Object.keys(overlayEntry.qualityBindings).length === 0) proposed.qualityBindings = {};
  }

  // A recommended provider whose entry the plan emptied contributes nothing
  // any more; dropping it keeps the overlay minimal (§9.4 — an overlay is
  // never a full copy). Blocks the operator wrote empty are not the plan's to
  // remove, so they keep the entry alive above — and an entry the operator
  // wrote empty in the first place is preserved verbatim, not dropped.
  if (Object.keys(proposed).length > 0) return proposed;
  return Object.keys(overlayEntry).length === 0 ? {} : undefined;
}

/**
 * Field-level walk of one overlay profile that overrides a recommended one.
 * Returns the fields to keep, or undefined when every field was removed.
 */
function refreshProfileFields(
  provider: string,
  profileName: string,
  profilePath: string,
  overlayProfile: AgentProfileSettingsDocument,
  recProfile: AgentProfileSettingsDocument,
  recEntry: AgentProfileProviderDocument,
  inventory: ModelInventory | undefined,
  findings: AgentProfileRefreshFinding[],
  changes: AgentProfileRefreshChange[],
): AgentProfileSettingsDocument | undefined {
  const kept: AgentProfileSettingsDocument = {};

  for (const field of ["model", "effort", "budget", "binary"] as const) {
    const overlayValue = overlayProfile[field];
    if (overlayValue === undefined) continue;
    const recValue = typeof recProfile[field] === "string" ? (recProfile[field] as string) : undefined;
    const target = `${profilePath}.${field}`;

    if (overlayValue === null) {
      if (recValue === undefined) {
        findings.push({
          kind: "redundant-override",
          disposition: "proposed",
          provider,
          target,
          message: `the explicit unset (null) matches the release recommendation, which sets no ${field}; removing it`,
        });
        changes.push({
          op: "remove",
          provider,
          target,
          before: "null",
          note: "unsets a field the release recommendation does not set",
        });
      } else {
        kept[field] = null;
        findings.push({
          kind: "stale-override",
          disposition: "preserved",
          provider,
          target,
          message: `the overlay unsets ${field} where the release recommends ${JSON.stringify(recValue)}; kept`,
        });
      }
      continue;
    }

    if (overlayValue === recValue) {
      findings.push({
        kind: "redundant-override",
        disposition: "proposed",
        provider,
        target,
        message: `${field} ${JSON.stringify(overlayValue)} is identical to the release recommendation; removing it lets future recommendations apply`,
      });
      changes.push({
        op: "remove",
        provider,
        target,
        before: overlayValue,
        note: "identical to the release recommendation",
      });
      continue;
    }

    kept[field] = overlayValue;
    findings.push({
      kind: "stale-override",
      disposition: "preserved",
      provider,
      target,
      message:
        recValue === undefined
          ? `the release recommendation sets no ${field}; the operator value ${JSON.stringify(overlayValue)} is kept`
          : `the release recommends ${field} ${JSON.stringify(recValue)}; the operator value ${JSON.stringify(overlayValue)} is kept`,
    });
    if (field === "model") {
      reportBundledRemovedModel(provider, profileName, target, overlayValue, inventory, findings);
    }
    if (field === "effort") {
      reportUnsupportedEffort(provider, target, overlayValue, recEntry, findings);
    }
  }

  if (overlayProfile.providerOptions !== undefined) {
    const keptOptions: Record<string, string | null> = {};
    for (const key of Object.keys(overlayProfile.providerOptions)) {
      const overlayValue = overlayProfile.providerOptions[key];
      const recValue =
        typeof recProfile.providerOptions?.[key] === "string"
          ? (recProfile.providerOptions?.[key] as string)
          : undefined;
      const target = `${profilePath}.providerOptions.${key}`;
      if (overlayValue === null ? recValue === undefined : overlayValue === recValue) {
        findings.push({
          kind: "redundant-override",
          disposition: "proposed",
          provider,
          target,
          message:
            overlayValue === null
              ? `the explicit unset (null) matches the release recommendation, which sets no ${key}; removing it`
              : `${key} ${JSON.stringify(overlayValue)} is identical to the release recommendation; removing it lets future recommendations apply`,
        });
        changes.push({
          op: "remove",
          provider,
          target,
          before: overlayValue === null ? "null" : overlayValue,
          note: "identical to the release recommendation",
        });
        continue;
      }
      keptOptions[key] = overlayValue;
      findings.push({
        kind: "stale-override",
        disposition: "preserved",
        provider,
        target,
        message:
          overlayValue === null
            ? `the overlay unsets ${key} where the release recommends ${JSON.stringify(recValue)}; kept`
            : recValue === undefined
              ? `the release recommendation sets no ${key}; the operator value ${JSON.stringify(overlayValue)} is kept`
              : `the release recommends ${key} ${JSON.stringify(recValue)}; the operator value ${JSON.stringify(overlayValue)} is kept`,
      });
    }
    if (Object.keys(keptOptions).length > 0) kept.providerOptions = keptOptions;
  }

  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Inventory checks for an operator-created profile (a name the release does
 * not declare): its model and effort still deserve the removed/unsupported
 * scans — the §9.3 append-only dated-profile convention is exactly where an
 * old pinned model lives — but nothing in it is ever proposed for change.
 */
function inspectOperatorProfile(
  provider: string,
  name: string,
  profile: AgentProfileSettingsDocument,
  recEntry: AgentProfileProviderDocument,
  inventory: ModelInventory | undefined,
  findings: AgentProfileRefreshFinding[],
): void {
  const profilePath = `providers.${provider}.profiles.${name}`;
  if (typeof profile.model === "string") {
    reportBundledRemovedModel(provider, name, `${profilePath}.model`, profile.model, inventory, findings);
  }
  if (typeof profile.effort === "string") {
    reportUnsupportedEffort(provider, `${profilePath}.effort`, profile.effort, recEntry, findings);
  }
}

/**
 * The bundled removed-model check: an overlay-supplied model that is not among
 * the release's recommended models may have been removed by the provider. It
 * runs exactly where no live listing answers for THIS profile — for a profile
 * whose own executable listed, the effective-catalog scan in the planner
 * already covered its model, and reporting the same model twice from two
 * inventories would read as two problems. A binary whose listing arrived
 * truncated still counts as having answered: the CLI may well list the
 * configured model past the bound, so falling back to the bundled comparison
 * would manufacture the very false `removed-model` finding the truncation
 * guard exists to prevent.
 */
function reportBundledRemovedModel(
  provider: string,
  profileName: string,
  target: string,
  model: string,
  inventory: ModelInventory | undefined,
  findings: AgentProfileRefreshFinding[],
): void {
  if (inventory === undefined) return;
  const binary = inventory.profileBinaries[profileName];
  if (binary !== undefined && inventory.listedByBinary.has(binary)) return;
  if (inventory.recommended.has(model)) return;
  const recommendedNote =
    inventory.recommended.size === 0
      ? "the release recommends no explicit model for this provider (the CLI's own default applies)"
      : `the release's recommended models are ${[...inventory.recommended].sort().map((m) => JSON.stringify(m)).join(", ")}`;
  findings.push({
    kind: "removed-model",
    disposition: "advisory",
    provider,
    target,
    message: `model ${JSON.stringify(model)} is not among the release's recommended models — it may be outdated or removed (${recommendedNote}); verify it is still available`,
  });
}

function reportUnsupportedEffort(
  provider: string,
  target: string,
  effort: string,
  recEntry: AgentProfileProviderDocument,
  findings: AgentProfileRefreshFinding[],
): void {
  const declared = hasOwn(recEntry.capabilities ?? {}, "effort")
    ? (recEntry.capabilities as Record<string, CapabilityDeclaration>)["effort"]
    : undefined;
  if (declared === "free") return;
  if (declared !== undefined && declared.includes(effort)) return;
  findings.push({
    kind: "unsupported-effort",
    disposition: "advisory",
    provider,
    target,
    message:
      declared === undefined
        ? `the release declares no effort setting for provider "${provider}"; effort ${JSON.stringify(effort)} is kept — verify the installed CLI accepts an effort at all`
        : `effort ${JSON.stringify(effort)} is not declared by the release for provider "${provider}" (declared: ${declared.join(", ")}); kept — verify the installed CLI accepts it`,
  });
}

// ---------------------------------------------------------------------------
// Inventories and helpers
// ---------------------------------------------------------------------------

function buildModelInventory(
  provider: string,
  recEntry: AgentProfileProviderDocument,
  facts: AgentProfileRefreshDiscoveryFacts | undefined,
): ModelInventory {
  const recommendedModels = new Set<string>();
  for (const profile of Object.values(recEntry.profiles ?? {})) {
    if (typeof profile.model === "string") recommendedModels.add(profile.model);
  }
  const profileBinaries = facts?.profileBinaries ?? {};
  const byBinary = facts?.modelsByBinary ?? {};
  const binaries = Object.keys(byBinary).sort();

  const listedByBinary = new Map<string, BinaryModelListing>();
  const listedModels: string[] = [];
  const seenModels = new Set<string>();
  const parts: string[] = [];
  for (const binary of binaries) {
    const listing = byBinary[binary];
    if (listing.status === "listed" && listing.models !== undefined) {
      const exhaustive = listing.truncated !== true;
      listedByBinary.set(binary, { models: new Set(listing.models), exhaustive });
      const detailSuffix = listing.detail !== undefined ? ` (${listing.detail})` : "";
      // A truncated listing keeps its warning: it is preserved in the reason
      // an operator reads, and the incompleteness is stated together with its
      // consequence — the prefix proves nothing absent, so it flags nothing
      // as removed.
      parts.push(
        exhaustive
          ? `${binary} listed ${listing.models.length} model(s)${detailSuffix}`
          : `${binary} listed ${listing.models.length} model(s)${detailSuffix}; the truncated listing is not exhaustive, so no configured model is flagged as removed by it`,
      );
      for (const model of listing.models) {
        if (!seenModels.has(model)) {
          seenModels.add(model);
          listedModels.push(model);
        }
      }
      continue;
    }
    const detail = listing.detail !== undefined ? ` (${listing.detail})` : "";
    parts.push(
      listing.status === "indeterminate"
        ? `${binary}: the model listing was transiently unanswerable${detail}`
        : `${binary}: the installed CLI's model listing could not be read${detail}`,
    );
  }

  if (listedByBinary.size > 0) {
    const partiallyListed = listedByBinary.size < binaries.length;
    return {
      source: "live",
      reason: partiallyListed
        ? `${parts.join("; ")}; profiles served by a binary that did not list fall back to the bundled recommended catalog`
        : parts.join("; "),
      listedByBinary,
      profileBinaries,
      partiallyListed,
      listedModels,
      recommended: recommendedModels,
    };
  }
  let reason: string;
  if (binaries.length > 0) {
    reason = `${parts.join("; ")}; falling back to the bundled recommended catalog`;
  } else if (facts?.modelsSkipped !== undefined) {
    reason = `${facts.modelsSkipped}; falling back to the bundled recommended catalog`;
  } else {
    reason = "this provider offers no bounded, non-interactive model listing; the bundled recommended catalog is the comparison source";
  }
  return {
    source: "bundled",
    reason,
    listedByBinary,
    profileBinaries,
    partiallyListed: false,
    recommended: recommendedModels,
  };
}

function aggregateSource(seen: ReadonlySet<AgentProfileModelInventorySource>): AgentProfileRefreshSource {
  if (seen.has("live") && seen.has("bundled")) return "mixed";
  if (seen.has("live")) return "live";
  return "bundled";
}

function capabilityEquals(a: CapabilityDeclaration, b: CapabilityDeclaration): boolean {
  if (a === "free" || b === "free") return a === b;
  // Order-sensitive on purpose: the declaration array participates verbatim in
  // the effective catalog (and its digest), so only a byte-identical
  // declaration is safely removable.
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function renderCapability(declaration: CapabilityDeclaration): string {
  return declaration === "free" ? '"free"' : `[${declaration.join(", ")}]`;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deterministic report order: provider, then path, then kind. */
function sortFindings(findings: AgentProfileRefreshFinding[]): void {
  findings.sort(
    (x, y) =>
      x.provider.localeCompare(y.provider) ||
      x.target.localeCompare(y.target) ||
      x.kind.localeCompare(y.kind),
  );
}

/** Deterministic diff order. Only `remove` ops exist when this runs; the `record` op is appended after. */
function sortChanges(changes: AgentProfileRefreshChange[]): void {
  changes.sort(
    (x, y) => (x.provider ?? "").localeCompare(y.provider ?? "") || x.target.localeCompare(y.target),
  );
}
