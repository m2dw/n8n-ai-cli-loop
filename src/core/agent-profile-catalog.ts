// ---------------------------------------------------------------------------
// Agent runtime profile catalog — schema, built-in defaults, overlay merge,
// load-time validation (issue #904).
//
// This is slice B1 of docs/agent-runtime-profiles-contract.md §14.1: "Catalog
// schema, loader, overlay merge, validator, built-in catalog — pure core
// module. No handler reads it yet; behavior unchanged." Nothing in this file
// is wired into a lane, so landing it changes no invocation: the resolution
// sites inventoried in §1.2 of the contract keep resolving model/effort/budget
// exactly as they do today. What it adds is the *data* those sites will read
// once B2 (quality resolution) and B3 (adapters) land.
//
// The contract is authoritative for policy; this module implements it and
// never restates or extends it. The load-time decisions it owns:
//
//   - **Where the catalog lives** (§9.1) — `AGENT_PROFILES_FILE` >
//     session-configured path > `agent-profiles.json` beside `sessions.json` >
//     no file at all. A *configured* path that is missing or unparseable is a
//     `catalog-unreadable` refusal, never a silent fall-through to the
//     built-in: an operator who named a file meant to use it. Only the default
//     location may be absent.
//   - **Built-in defaults** (§9.2) — the loop runs correctly with no file
//     present. See BUILT_IN_AGENT_PROFILE_CATALOG for the behavior-preservation
//     ledger, including the two known divergences B3 must reconcile.
//   - **Overlay merge** (§9.4) — providers merge by key, profiles merge field
//     by field, `null` unsets one field, bindings replace, capability
//     descriptors replace per key, `providerOptions` merges by key. There is no
//     deletion and no block replacement, so the effective catalog always
//     declares every built-in provider.
//   - **Validation** (§11.2, §12) — closed schema, versioned, fail-closed. All
//     of it runs before any billable agent invocation, because the catalog is
//     read at phase start (§9.3) and a bad edit fails the phase rather than
//     resolving to "something nearby".
//   - **Provenance** — every effective value records whether it came from the
//     built-in catalog or the operator overlay, which is what lets B4's audit
//     record (§13.2) distinguish `catalog-overlay` from `catalog-builtin`
//     without re-reading the file.
//
// Three properties this module deliberately does NOT have:
//
//   - **No cache.** `loadAgentProfileCatalog()` reads the file on every call.
//     A CLI or phase invocation is stateless, so an operator edit takes effect
//     on the next invocation without rebuilding or restarting anything. A phase
//     that has already begun never re-reads (the caller loads once at phase
//     start; §9.3), so an edit cannot disturb work in flight.
//   - **No model-name unions.** Per §14.3, model names, effort values, budget
//     amounts, profile names, and per-provider capability lists are `string`
//     validated against the catalog's own capability descriptors.
//     `QualityLevel`, the setting keys, the provenance sources, and the refusal
//     reasons are the only closed vocabularies here, and all four are
//     provider-neutral vocabularies this contract owns.
//   - **No alias indirection, therefore no alias cycle.** A quality binding
//     names a runtime profile declared under the same provider, in exactly one
//     hop; a profile carries settings and never references another profile.
//     A binding that names anything other than a declared profile — including
//     another quality level, which is the shape an alias cycle would need — is
//     an `unknown-profile` refusal, so a cycle is unrepresentable rather than
//     merely unreached. `assertNoBindingIndirection` states that invariant
//     where a future schema change would have to confront it.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { resolveHomeDir } from "./home-dir.js";

// ---------------------------------------------------------------------------
// Vocabularies (§14.3 — the closed, provider-neutral ones only)
// ---------------------------------------------------------------------------

/** The four provider-neutral quality levels, weakest to strongest (§5). */
export const QUALITY_LEVELS = ["light", "normal", "strong", "maximum"] as const;

/**
 * A *request* for how much quality work deserves — never a model name and
 * never a provider effort value (§5 rule 1). The ordering is within a
 * provider, not across providers (§5 rule 2).
 */
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

/** The setting keys a runtime profile may carry (§6.1). */
export const AGENT_PROFILE_SETTING_KEYS = [
  "model",
  "effort",
  "budget",
  "binary",
  "providerOptions",
] as const;

export type AgentProfileSettingKey = (typeof AGENT_PROFILE_SETTING_KEYS)[number];

/**
 * The closed refusal set of §12.2. Adding a member is a change to the contract
 * document first. This module raises the load-time subset; `unknown-provider`
 * is raised by {@link providerCatalogFor}, `invalid-quality-request` by slice
 * B2's resolution-time gate (`AgentQualityError`, src/core/agent-quality.ts),
 * and `invalid-override` is reserved for the env/pin checks B3 adds there.
 */
export const AGENT_PROFILE_REFUSAL_REASONS = [
  "catalog-unreadable",
  "catalog-schema-unsupported",
  "catalog-invalid",
  "unknown-provider",
  "unbound-quality",
  "unknown-profile",
  "unsupported-setting",
  "unsupported-value",
  "invalid-quality-request",
  "invalid-override",
] as const;

export type AgentProfileRefusalReason = (typeof AGENT_PROFILE_REFUSAL_REASONS)[number];

/**
 * Where an effective value came from: the compiled-in built-in catalog, or the
 * operator's overlay file. These are the two `profileSource` values §13.2
 * records for a catalog-resolved profile.
 */
export type CatalogValueSource = "catalog-builtin" | "catalog-overlay";

/** Whether an overlay file participated in the effective catalog at all (§13.2 `catalogSource`). */
export type CatalogSource = "builtin" | "file";

/** Which of §9.1's steps produced the catalog path that was consulted. */
export type AgentProfilesPathSource = "env" | "session-config" | "default";

/**
 * A refusal from the catalog gate. `reason` is one of §12.2's closed set;
 * `path` is the config path or file path the refusal points at, so an operator
 * message names the offending key rather than the whole document.
 */
export class AgentProfileCatalogError extends Error {
  readonly reason: AgentProfileRefusalReason;
  readonly path?: string;

  constructor(reason: AgentProfileRefusalReason, message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "AgentProfileCatalogError";
    this.reason = reason;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Document shape (§6.1) — what a catalog file may contain
// ---------------------------------------------------------------------------

/**
 * A capability declaration for one setting key (§6.2): `"free"` (any string is
 * accepted; the provider CLI is the real judge) or an explicit list of accepted
 * values. A key absent from the descriptor is a setting the provider does not
 * accept at all, which is how Antigravity refuses `effort` and Codex refuses
 * `budget` without a line of provider-specific source.
 */
export type CapabilityDeclaration = "free" | readonly string[];

/**
 * The settings a named runtime profile carries. Every field is optional; an
 * omitted field means the provider's own default applies and is recorded as an
 * absence, never as a model named "default" (§6.1, §13.3). `null` is meaningful
 * only in an overlay, where it explicitly unsets a built-in field (§9.4).
 */
export interface AgentProfileSettingsDocument {
  model?: string | null;
  effort?: string | null;
  budget?: string | null;
  binary?: string | null;
  providerOptions?: Record<string, string | null>;
}

export interface AgentProfileProviderDocument {
  capabilities?: Record<string, CapabilityDeclaration>;
  profiles?: Record<string, AgentProfileSettingsDocument>;
  qualityBindings?: Partial<Record<QualityLevel, string>>;
}

/**
 * Where the values a refresh compared against came from (issue #914, §11.6):
 * a provider's bounded non-interactive listing (`live`), the release's bundled
 * recommended catalog (`bundled`), or some of each (`mixed`).
 */
export const AGENT_PROFILE_REFRESH_SOURCES = ["live", "bundled", "mixed"] as const;

export type AgentProfileRefreshSource = (typeof AGENT_PROFILE_REFRESH_SOURCES)[number];

/**
 * The provenance record `admin agent-profile refresh` writes into the overlay
 * when it applies changes (issue #914, §11.6): when the refresh ran, which
 * source supplied the facts it compared against, and which recommended catalog
 * revision it compared to. Metadata only — it names no setting, participates in
 * no resolution, and is excluded from the effective catalog's digest, so two
 * catalogs with the same values stay the same catalog whether or not one was
 * refreshed. The built-in catalog never carries one.
 */
export interface AgentProfileRefreshRecord {
  refreshedAt: string;
  updateSource: AgentProfileRefreshSource;
  recommendedCatalogVersion: string;
}

/** A parsed, shape-validated catalog document — either the built-in or an operator overlay. */
export interface AgentProfileCatalogDocument {
  schemaVersion: number;
  catalogVersion?: string;
  refresh?: AgentProfileRefreshRecord;
  providers: Record<string, AgentProfileProviderDocument>;
}

// ---------------------------------------------------------------------------
// Effective catalog (post-overlay) — values plus their provenance
// ---------------------------------------------------------------------------

export interface EffectiveProfileSettings {
  model?: string;
  effort?: string;
  budget?: string;
  binary?: string;
  providerOptions?: Record<string, string>;
}

export interface EffectiveRuntimeProfile {
  /** Operator-facing profile name, scoped to its provider (§6.1). */
  readonly name: string;
  /** The concrete settings, with unset fields absent rather than nulled. */
  readonly settings: EffectiveProfileSettings;
  /** Per-field provenance for every field present in `settings`. */
  readonly settingSources: Partial<Record<AgentProfileSettingKey, CatalogValueSource>>;
  /** Per-key provenance for every entry of `settings.providerOptions`. */
  readonly providerOptionSources: Record<string, CatalogValueSource>;
  /**
   * Fields the overlay explicitly unset with `null` (§9.4), as `"model"` or
   * `"providerOptions.printTimeout"`. An explicit unset and a never-set field
   * both resolve to absence, but only the first is an operator decision, so it
   * stays visible in the effective catalog.
   */
  readonly unsetByOverlay: readonly string[];
  /** Whether the overlay declared this profile name at all. */
  readonly source: CatalogValueSource;
}

export interface EffectiveQualityBinding {
  readonly level: QualityLevel;
  readonly profileName: string;
  readonly source: CatalogValueSource;
  /**
   * The other quality levels this provider binds to the same profile (§6.3).
   * A declared shared binding is configuration, not a runtime clamp, and this
   * is the field that makes it auditable in §13.2's record.
   */
  readonly sharedWithQualityLevels: readonly QualityLevel[];
}

export interface EffectiveProviderCatalog {
  readonly provider: string;
  readonly capabilities: Record<string, CapabilityDeclaration>;
  readonly capabilitySources: Record<string, CatalogValueSource>;
  readonly profiles: Record<string, EffectiveRuntimeProfile>;
  readonly qualityBindings: Record<QualityLevel, EffectiveQualityBinding>;
  /** `catalog-overlay` only for a provider the built-in catalog never declared. */
  readonly source: CatalogValueSource;
}

export interface EffectiveAgentProfileCatalog {
  readonly schemaVersion: number;
  readonly catalogVersion?: string;
  readonly catalogVersionSource?: CatalogValueSource;
  /** `file` when an overlay was read and merged, `builtin` when none was present. */
  readonly catalogSource: CatalogSource;
  /** The path that was consulted, whether or not a file existed there. */
  readonly catalogPath: string;
  readonly pathSource: AgentProfilesPathSource;
  readonly providers: Record<string, EffectiveProviderCatalog>;
  /**
   * `sha256:...` over the effective catalog's *values* after overlay (§13.2), so
   * two runs that resolved differently can be attributed to a catalog edit.
   * Provenance is deliberately excluded: the same values reached by a different
   * route are the same catalog as far as a resolution is concerned.
   */
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// Built-in catalog (§9.2)
// ---------------------------------------------------------------------------

/**
 * The only schema version this binary understands. A file declaring a newer one
 * is refused whole (§11.1) rather than partially parsed.
 */
export const AGENT_PROFILE_CATALOG_SCHEMA_VERSION = 1;

/** Catalog file name, resolved beside `sessions.json` by default (§9.1). */
export const AGENT_PROFILES_FILENAME = "agent-profiles.json";

/** Operator environment variable naming an absolute catalog path (§9.1 step 1). */
export const AGENT_PROFILES_FILE_ENV = "AGENT_PROFILES_FILE";

/**
 * The compiled-in catalog. It must let the loop run correctly with no file
 * present, and at cutover (slice B3) reproduce today's resolutions for today's
 * inputs (§9.2, §10.3).
 *
 * Behavior-preservation ledger, checked against the shipped resolution sites:
 *
 *   - **anthropic** reproduces `labelsToComplexity` exactly — `complexity:low`
 *     to sonnet/low/$2, no label to sonnet/high/$5, `complexity:high` to
 *     opus/high/$10, `complexity:xhigh` to fable/xhigh/$20 (issues #748, #857).
 *     The Claude review lane's model choice (opus for `review:high`, sonnet
 *     otherwise) falls out of the same bindings; its lack of a budget mechanism
 *     is the adapter's `budgetApplied: "not-applicable"` (§7 rule 1), not a
 *     missing catalog value.
 *   - **openai** declares no `budget` key at all, because Codex has no per-run
 *     budget cap flag, and declares the three-value `effort` list the shipped
 *     lanes resolve today. That list is a *declaration about a stock install*,
 *     not a claim that this provider's `model_reasoning_effort` can never accept
 *     a further tier: it was a TypeScript union (`ReviewStrength`) and a
 *     comment, and it is data now, so an installation whose Codex/model
 *     combination accepts a stronger tier adds the value and rebinds `maximum`
 *     in `agent-profiles.json` — an operator edit, with no source change here
 *     and none in the adapter that consumes it (§6.2, issue #908). No profile
 *     sets `model`, which preserves today's compatibility mode where no
 *     `--model` flag is passed (issue #609) and is recorded as an absence,
 *     never as `"default"`.
 *   - **google** carries no `effort` key, because Antigravity folds effort into
 *     the model display name, and no `model`, matching the review lane that
 *     never passes one. All four profiles carry today's single default print
 *     timeout (`ANTIGRAVITY_PRINT_TIMEOUT_DEFAULT`); they are deliberately
 *     identical values under four retargetable names rather than an invented
 *     per-quality timeout ladder.
 *
 * Divergence ledger (§9.2, §10.3). The write-capable cutover (issue #911)
 * closed the no-label divergence by the data edit this comment's earlier
 * revision predicted: `openai`'s `normal` binding targets `codex-high`, so an
 * unlabeled run keeps resolving today's `high` effort on both shipped Codex
 * lanes. What remains diverges only for the review class, which no lane
 * resolves through this catalog yet:
 *
 *   1. An explicit `review:medium` maps to `normal`, which for anthropic
 *      carries `high` effort where today's Claude review lane resolves
 *      `medium`.
 *   2. The same explicit `review:medium` maps to `normal` for openai too,
 *      which now carries `high` effort where today's Codex review lane
 *      resolves `medium`.
 *
 * A single provider-level binding cannot honor both an explicit `review:medium`
 * and an unlabeled default that today resolve to different efforts on the same
 * provider; #911 preserved the unlabeled default (the case every write-capable
 * run hits) and left the explicit `review:medium` difference to the review
 * cutover's own §10.3 before/after table. Recording the remainder here keeps
 * the choice explicit rather than silent; closing it is a data edit in this
 * constant, not a code change.
 */
export const BUILT_IN_AGENT_PROFILE_CATALOG = deepFreeze<AgentProfileCatalogDocument>({
  schemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
  catalogVersion: "builtin-2026-09-07",
  providers: {
    anthropic: {
      capabilities: {
        model: "free",
        effort: ["low", "medium", "high", "xhigh", "max"],
        budget: "free",
        binary: "free",
      },
      profiles: {
        "claude-light": { model: "sonnet", effort: "low", budget: "2" },
        "claude-normal": { model: "sonnet", effort: "high", budget: "5" },
        "claude-strong": { model: "opus", effort: "high", budget: "10" },
        "claude-maximum": { model: "fable", effort: "xhigh", budget: "20" },
      },
      qualityBindings: {
        light: "claude-light",
        normal: "claude-normal",
        strong: "claude-strong",
        maximum: "claude-maximum",
      },
    },
    openai: {
      capabilities: {
        model: "free",
        effort: ["low", "medium", "high"],
      },
      profiles: {
        "codex-light": { effort: "low" },
        "codex-normal": { effort: "medium" },
        "codex-high": { effort: "high" },
      },
      // `normal`, `strong`, and `maximum` share one profile: a declared
      // binding, visible before any run and reported as
      // `sharedWithQualityLevels` (§6.3), not a runtime downgrade. `normal`
      // targets `codex-high` because today's Codex lanes resolve `high` effort
      // for an unlabeled run, and the write-capable cutover (issue #911)
      // preserves that resolution rather than silently weakening it; the
      // moment the Codex CLI gains a stronger tier, rebinding `maximum` is a
      // one-line overlay edit. `codex-normal` stays declared so an operator
      // can rebind or pin the CLI's documented medium tier without restating
      // it.
      qualityBindings: {
        light: "codex-light",
        normal: "codex-high",
        strong: "codex-high",
        maximum: "codex-high",
      },
    },
    google: {
      capabilities: {
        model: "free",
        binary: "free",
        providerOptions: ["printTimeout"],
      },
      profiles: {
        "agy-light": { providerOptions: { printTimeout: "15m" } },
        "agy-normal": { providerOptions: { printTimeout: "15m" } },
        "agy-strong": { providerOptions: { printTimeout: "15m" } },
        "agy-maximum": { providerOptions: { printTimeout: "15m" } },
      },
      qualityBindings: {
        light: "agy-light",
        normal: "agy-normal",
        strong: "agy-strong",
        maximum: "agy-maximum",
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Path resolution (§9.1)
// ---------------------------------------------------------------------------

export interface AgentProfilesPathResolution {
  /** The absolute path that will be consulted. */
  path: string;
  source: AgentProfilesPathSource;
  /**
   * True when an operator named this path explicitly. A named path that does
   * not exist is a refusal; the default location may simply be absent (§9.1).
   */
  required: boolean;
}

export interface AgentProfilesPathOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * The `sessions.json` path this run resolved against; the catalog's default
   * location is its directory. Defaults to the same
   * `<home>/.config/n8n-ai-cli-loop/sessions.json` the session registry does
   * (pinned equal by test rather than imported, because `core/` does not depend
   * on `registries/`).
   */
  sessionsPath?: string;
  /**
   * `session.agentRuntime.profilesPath` — trusted session config, supplied by
   * the caller. It is passed in rather than read here because the rest of that
   * block (`defaultQuality`, per-agent `pins`) belongs to slice B2, and a
   * half-declared config block is worse than none.
   */
  sessionProfilesPath?: string;
}

/** The default configuration directory the catalog is resolved from when no path is configured. */
export function defaultAgentProfilesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHomeDir(env), ".config", "n8n-ai-cli-loop");
}

/**
 * Resolves which catalog path to consult, per §9.1: `AGENT_PROFILES_FILE` >
 * session-configured path > `agent-profiles.json` beside `sessions.json`.
 *
 * A configured path that is not absolute is refused as `catalog-unreadable`
 * rather than resolved against the process cwd: a stateless CLI or phase
 * invocation runs from whatever directory it was started in, so a relative
 * catalog path names a different file each time, which is exactly the silent
 * fall-through §9.1 forbids.
 */
export function resolveAgentProfilesPath(
  options: AgentProfilesPathOptions = {},
): AgentProfilesPathResolution {
  const env = options.env ?? process.env;

  const configured: Array<{ raw: unknown; source: AgentProfilesPathSource; label: string }> = [
    { raw: env[AGENT_PROFILES_FILE_ENV], source: "env", label: AGENT_PROFILES_FILE_ENV },
    {
      raw: options.sessionProfilesPath,
      source: "session-config",
      label: "session.agentRuntime.profilesPath",
    },
  ];

  for (const entry of configured) {
    const value = typeof entry.raw === "string" ? entry.raw.trim() : "";
    if (value.length === 0) continue;
    if (!isAbsolute(value)) {
      throw new AgentProfileCatalogError(
        "catalog-unreadable",
        `${entry.label} must be an absolute path to a catalog file (got "${value}")`,
      );
    }
    return { path: value, source: entry.source, required: true };
  }

  const sessionsPath =
    typeof options.sessionsPath === "string" && options.sessionsPath.trim().length > 0
      ? options.sessionsPath.trim()
      : join(defaultAgentProfilesDir(env), "sessions.json");

  return {
    path: join(dirname(sessionsPath), AGENT_PROFILES_FILENAME),
    source: "default",
    required: false,
  };
}

// ---------------------------------------------------------------------------
// Loading (§9.3 — fresh on every call, never cached)
// ---------------------------------------------------------------------------

export interface LoadAgentProfileCatalogOptions extends AgentProfilesPathOptions {
  /**
   * File reader seam. Returns the file contents, or `undefined` when no file
   * exists at that path. Tests inject a fake; production reads the filesystem.
   */
  readCatalogFile?: (path: string) => string | undefined;
}

function defaultReadCatalogFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Only "there is no file here" may fall through to the built-in catalog.
    // A file that exists but cannot be read (permissions, a directory in its
    // place) is an operator-visible failure, not an absence.
    if (code === "ENOENT") return undefined;
    throw new AgentProfileCatalogError(
      "catalog-unreadable",
      `cannot read the agent profile catalog (${code ?? (err as Error).message})`,
      path,
    );
  }
}

/**
 * Reads, validates, and merges the effective catalog. Called once at the start
 * of a phase run or a stateless CLI invocation; never cached, so an operator
 * edit is picked up by the next invocation with no rebuild (§9.3, §11.5).
 *
 * Throws {@link AgentProfileCatalogError} for every §12.2 load-time refusal, so
 * a malformed catalog fails before any billable agent invocation.
 */
export function loadAgentProfileCatalog(
  options: LoadAgentProfileCatalogOptions = {},
): EffectiveAgentProfileCatalog {
  const resolution = resolveAgentProfilesPath(options);
  const read = options.readCatalogFile ?? defaultReadCatalogFile;
  const contents = read(resolution.path);

  if (contents === undefined) {
    if (resolution.required) {
      throw new AgentProfileCatalogError(
        "catalog-unreadable",
        "the configured agent profile catalog does not exist; remove the setting to use the built-in catalog",
        resolution.path,
      );
    }
    return buildEffectiveAgentProfileCatalog(undefined, {
      catalogPath: resolution.path,
      pathSource: resolution.source,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (err) {
    throw new AgentProfileCatalogError(
      "catalog-unreadable",
      `the agent profile catalog is not valid JSON (${(err as Error).message})`,
      resolution.path,
    );
  }

  const overlay = parseAgentProfileCatalogDocument(parsed, resolution.path);
  return buildEffectiveAgentProfileCatalog(overlay, {
    catalogPath: resolution.path,
    pathSource: resolution.source,
  });
}

export interface BuildEffectiveCatalogOptions {
  catalogPath?: string;
  pathSource?: AgentProfilesPathSource;
}

/**
 * Merges an overlay document over the built-in catalog and validates the
 * result. Exposed separately from {@link loadAgentProfileCatalog} so the
 * operator commands §11.4 defers to slice B4 can show or diff a candidate
 * catalog without touching the configured path.
 *
 * Both documents go through {@link parseAgentProfileCatalogDocument} here.
 * Re-parsing an already-parsed document is idempotent, and it means a caller
 * that hand-built an overlay — or reached this entry point from JavaScript,
 * where the parameter type is not enforced — cannot skip the shape gate and
 * reach the merge with a document the closed schema would have refused.
 */
export function buildEffectiveAgentProfileCatalog(
  overlayDocument: AgentProfileCatalogDocument | undefined,
  options: BuildEffectiveCatalogOptions = {},
): EffectiveAgentProfileCatalog {
  // The built-in goes through the same validator as an operator file: a
  // built-in that could not be written by an operator is a built-in whose
  // rules the validator does not really enforce.
  const builtin = parseAgentProfileCatalogDocument(
    BUILT_IN_AGENT_PROFILE_CATALOG,
    "<built-in catalog>",
  );
  const overlay =
    overlayDocument === undefined
      ? undefined
      : parseAgentProfileCatalogDocument(
          overlayDocument,
          options.catalogPath ?? AGENT_PROFILES_FILENAME,
        );

  const providers = emptyDict<EffectiveProviderCatalog>();
  const providerNames = new Set<string>([
    ...Object.keys(builtin.providers),
    ...Object.keys(overlay?.providers ?? {}),
  ]);
  for (const provider of [...providerNames].sort()) {
    providers[provider] = mergeProvider(
      provider,
      ownValue(builtin.providers, provider),
      ownValue(overlay?.providers, provider),
    );
  }

  const catalogVersion = overlay?.catalogVersion ?? builtin.catalogVersion;
  const catalogVersionSource: CatalogValueSource =
    overlay?.catalogVersion !== undefined ? "catalog-overlay" : "catalog-builtin";
  const catalog: EffectiveAgentProfileCatalog = {
    schemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
    ...(catalogVersion !== undefined ? { catalogVersion, catalogVersionSource } : {}),
    catalogSource: overlay ? "file" : "builtin",
    catalogPath: options.catalogPath ?? join(defaultAgentProfilesDir(), AGENT_PROFILES_FILENAME),
    pathSource: options.pathSource ?? "default",
    providers,
    digest: effectiveCatalogDigest(providers, catalogVersion),
  };

  validateEffectiveCatalog(catalog);
  return catalog;
}

// ---------------------------------------------------------------------------
// Document parsing and shape validation (§11.2 closed schema)
// ---------------------------------------------------------------------------

const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// `providerOptions` is an open string map (§6.1): its keys are constrained by
// the capability descriptor, not by a name pattern here, so a provider-native
// key such as Codex's `model_reasoning_summary` stays representable. The only
// shapes refused outright are ones no descriptor could name back: an empty key,
// or one carrying whitespace or control characters.
const MALFORMED_PROVIDER_OPTION_KEY = /\s/;
// A budget is a plain USD amount, the shape `--max-budget-usd` already takes.
const BUDGET_AMOUNT = /^\d+(?:\.\d{1,2})?$/;

const CATALOG_TOP_LEVEL_KEYS = new Set(["schemaVersion", "catalogVersion", "refresh", "providers"]);
const REFRESH_RECORD_KEYS = new Set(["refreshedAt", "updateSource", "recommendedCatalogVersion"]);
const REFRESH_SOURCE_SET = new Set<string>(AGENT_PROFILE_REFRESH_SOURCES);
const PROVIDER_KEYS = new Set(["capabilities", "profiles", "qualityBindings"]);
const SETTING_KEYS = new Set<string>(AGENT_PROFILE_SETTING_KEYS);
const QUALITY_LEVEL_SET = new Set<string>(QUALITY_LEVELS);

/**
 * Agent ids, which are never catalog keys: the catalog is keyed by *provider*
 * (§3, §4.3), so `{"providers": {"claude": ...}}` is an operator mistake that
 * would otherwise surface much later as `unknown-provider` for the agent whose
 * provider is `anthropic`.
 */
const KNOWN_AGENT_IDS = new Set(["claude", "codex", "gemini"]);

/**
 * Keys a catalog may never carry anywhere in the document (§6.1): a phase
 * selector (the matrix stays provider x quality, §4.3), an agent id (assignment
 * profiles own agent selection, §4.2), or anything credential-shaped (a profile
 * names settings and never holds a credential).
 */
const FORBIDDEN_CATALOG_KEYS = new Set([
  "phase",
  "phases",
  "phaseClass",
  "agent",
  "agentId",
  "agents",
  "assignment",
  "assignmentProfiles",
  "auth",
  "apiKey",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
]);

/**
 * Parses and shape-validates one catalog document (the built-in or an overlay)
 * without cross-checking references — that happens on the merged catalog, since
 * an overlay may legitimately bind a level to a profile the built-in declares.
 */
export function parseAgentProfileCatalogDocument(
  raw: unknown,
  path = "agent-profiles.json",
): AgentProfileCatalogDocument {
  const root = requireObject(raw, path, "the catalog must be a JSON object");

  // Version first, and before any other key is looked at: a document written
  // for a newer schema is refused whole rather than reported as a pile of
  // unknown keys (§11.1).
  const schemaVersion = root["schemaVersion"];
  if (schemaVersion === undefined) {
    throw new AgentProfileCatalogError(
      "catalog-schema-unsupported",
      "schemaVersion is required",
      `${path}.schemaVersion`,
    );
  }
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new AgentProfileCatalogError(
      "catalog-schema-unsupported",
      `schemaVersion must be an integer (got ${JSON.stringify(schemaVersion)})`,
      `${path}.schemaVersion`,
    );
  }
  if (schemaVersion > AGENT_PROFILE_CATALOG_SCHEMA_VERSION) {
    throw new AgentProfileCatalogError(
      "catalog-schema-unsupported",
      `schemaVersion ${schemaVersion} is newer than this binary supports (${AGENT_PROFILE_CATALOG_SCHEMA_VERSION}); upgrade before using this catalog`,
      `${path}.schemaVersion`,
    );
  }
  if (schemaVersion < AGENT_PROFILE_CATALOG_SCHEMA_VERSION) {
    throw new AgentProfileCatalogError(
      "catalog-schema-unsupported",
      `schemaVersion ${schemaVersion} is not a supported schema version (expected ${AGENT_PROFILE_CATALOG_SCHEMA_VERSION})`,
      `${path}.schemaVersion`,
    );
  }

  assertKnownKeys(root, CATALOG_TOP_LEVEL_KEYS, path);

  const document: AgentProfileCatalogDocument = {
    schemaVersion,
    providers: emptyDict(),
  };

  if (root["catalogVersion"] !== undefined) {
    document.catalogVersion = requireLabel(
      root["catalogVersion"],
      `${path}.catalogVersion`,
      "catalogVersion",
    );
  }

  if (root["refresh"] !== undefined) {
    document.refresh = parseRefreshRecord(root["refresh"], `${path}.refresh`);
  }

  const providers = root["providers"];
  if (providers === undefined) {
    // An overlay that changes only `catalogVersion` is degenerate but legal;
    // an absent `providers` block simply supplies no override.
    return document;
  }

  const providersObj = requireObject(
    providers,
    `${path}.providers`,
    "providers must be a JSON object keyed by provider",
  );
  for (const [provider, value] of Object.entries(providersObj)) {
    const providerPath = `${path}.providers.${provider}`;
    assertNotForbiddenKey(provider, `${path}.providers`);
    if (!PROVIDER_NAME.test(provider)) {
      throw new AgentProfileCatalogError(
        "catalog-invalid",
        `"${provider}" is not a valid provider name (lowercase letters, digits, and hyphens)`,
        providerPath,
      );
    }
    if (KNOWN_AGENT_IDS.has(provider)) {
      throw new AgentProfileCatalogError(
        "catalog-invalid",
        `"${provider}" is an agent id, not a provider; the catalog is keyed by provider (e.g. "anthropic", "openai", "google")`,
        providerPath,
      );
    }
    document.providers[provider] = parseProviderDocument(value, providerPath);
  }

  return document;
}

/**
 * The §11.6 refresh provenance record, validated closed like everything else:
 * it is tool-written, so any malformed member is evidence of a hand edit or a
 * truncated write, and refusing it names the problem now rather than letting a
 * later refresh trust a record that says nothing true.
 */
function parseRefreshRecord(raw: unknown, path: string): AgentProfileRefreshRecord {
  const obj = requireObject(raw, path, "refresh must be a JSON object");
  assertKnownKeys(obj, REFRESH_RECORD_KEYS, path);

  const refreshedAt = requireLabel(obj["refreshedAt"], `${path}.refreshedAt`, "refreshedAt");
  if (Number.isNaN(Date.parse(refreshedAt))) {
    throw new AgentProfileCatalogError(
      "catalog-invalid",
      `refreshedAt must be an ISO 8601 timestamp (got ${JSON.stringify(refreshedAt)})`,
      `${path}.refreshedAt`,
    );
  }
  const updateSource = requireLabel(obj["updateSource"], `${path}.updateSource`, "updateSource");
  if (!REFRESH_SOURCE_SET.has(updateSource)) {
    throw new AgentProfileCatalogError(
      "catalog-invalid",
      `updateSource must be one of ${AGENT_PROFILE_REFRESH_SOURCES.join(", ")} (got ${JSON.stringify(updateSource)})`,
      `${path}.updateSource`,
    );
  }
  return {
    refreshedAt,
    updateSource: updateSource as AgentProfileRefreshSource,
    recommendedCatalogVersion: requireLabel(
      obj["recommendedCatalogVersion"],
      `${path}.recommendedCatalogVersion`,
      "recommendedCatalogVersion",
    ),
  };
}

function parseProviderDocument(raw: unknown, path: string): AgentProfileProviderDocument {
  const obj = requireObject(raw, path, "a provider entry must be a JSON object");
  assertKnownKeys(obj, PROVIDER_KEYS, path);

  const entry: AgentProfileProviderDocument = {};

  if (obj["capabilities"] !== undefined) {
    const capabilities = requireObject(
      obj["capabilities"],
      `${path}.capabilities`,
      "capabilities must be a JSON object keyed by setting name",
    );
    const parsedCapabilities = emptyDict<CapabilityDeclaration>();
    for (const [key, value] of Object.entries(capabilities)) {
      assertSettingKey(key, `${path}.capabilities`);
      parsedCapabilities[key] = parseCapabilityDeclaration(
        value,
        `${path}.capabilities.${key}`,
        key,
      );
    }
    entry.capabilities = parsedCapabilities;
  }

  if (obj["profiles"] !== undefined) {
    const profiles = requireObject(
      obj["profiles"],
      `${path}.profiles`,
      "profiles must be a JSON object keyed by profile name",
    );
    const parsedProfiles = emptyDict<AgentProfileSettingsDocument>();
    for (const [name, value] of Object.entries(profiles)) {
      const profilePath = `${path}.profiles.${name}`;
      assertNotForbiddenKey(name, `${path}.profiles`);
      if (!PROFILE_NAME.test(name)) {
        throw new AgentProfileCatalogError(
          "catalog-invalid",
          `"${name}" is not a valid profile name (letters, digits, dot, dash, underscore)`,
          profilePath,
        );
      }
      if (value === null) {
        throw new AgentProfileCatalogError(
          "catalog-invalid",
          "a profile cannot be removed; unset individual fields with null instead",
          profilePath,
        );
      }
      parsedProfiles[name] = parseProfileSettings(value, profilePath);
    }
    entry.profiles = parsedProfiles;
  }

  if (obj["qualityBindings"] !== undefined) {
    const bindings = requireObject(
      obj["qualityBindings"],
      `${path}.qualityBindings`,
      "qualityBindings must be a JSON object keyed by quality level",
    );
    const parsedBindings: Partial<Record<QualityLevel, string>> = {};
    for (const [level, value] of Object.entries(bindings)) {
      const bindingPath = `${path}.qualityBindings.${level}`;
      if (!QUALITY_LEVEL_SET.has(level)) {
        throw new AgentProfileCatalogError(
          "catalog-invalid",
          `"${level}" is not a quality level (expected one of ${QUALITY_LEVELS.join(", ")})`,
          bindingPath,
        );
      }
      if (value === null) {
        throw new AgentProfileCatalogError(
          "catalog-invalid",
          "a quality level cannot be unbound; bind it to a profile name instead",
          bindingPath,
        );
      }
      const name = requireLabel(value, bindingPath, "a quality binding");
      if (!PROFILE_NAME.test(name)) {
        throw new AgentProfileCatalogError(
          "catalog-invalid",
          `"${name}" is not a valid profile name (letters, digits, dot, dash, underscore)`,
          bindingPath,
        );
      }
      parsedBindings[level as QualityLevel] = name;
    }
    entry.qualityBindings = parsedBindings;
  }

  return entry;
}

function parseCapabilityDeclaration(
  raw: unknown,
  path: string,
  key: string,
): CapabilityDeclaration {
  if (raw === "free") return "free";
  if (key === "model") {
    // §6.2: model names are always "free". An enumerated model descriptor would
    // be a local allowlist that refuses a retargeted profile before the provider
    // CLI ever sees the name, so it is rejected at parse time rather than
    // surfacing later as `unsupported-value`.
    throw new AgentProfileCatalogError(
      "catalog-invalid",
      'the "model" capability must be "free"; the loop never maintains a list of valid model names, so an enumerated model descriptor is refused',
      path,
    );
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new AgentProfileCatalogError(
        "catalog-invalid",
        'an enumerated capability must list at least one accepted value (use "free" to accept any)',
        path,
      );
    }
    const values: string[] = [];
    raw.forEach((value, index) => {
      const parsed = requireLabel(value, `${path}[${index}]`, "an accepted value");
      if (values.includes(parsed)) {
        throw new AgentProfileCatalogError(
          "catalog-invalid",
          `duplicate accepted value "${parsed}"`,
          `${path}[${index}]`,
        );
      }
      values.push(parsed);
    });
    return values;
  }
  throw new AgentProfileCatalogError(
    "catalog-invalid",
    'a capability must be "free" or an array of accepted values',
    path,
  );
}

function parseProfileSettings(raw: unknown, path: string): AgentProfileSettingsDocument {
  const obj = requireObject(raw, path, "a profile must be a JSON object");
  assertKnownKeys(obj, SETTING_KEYS, path);

  const settings: AgentProfileSettingsDocument = {};

  for (const key of ["model", "effort", "binary"] as const) {
    const rawValue = obj[key];
    if (rawValue === undefined) continue;
    if (rawValue === null) {
      settings[key] = null;
      continue;
    }
    const value = requireLabel(rawValue, `${path}.${key}`, key);
    // A binary may be an absolute path and a model may be a provider's display
    // name — Antigravity's "Gemini 3.1 Pro (Low)" — so both legitimately carry
    // internal spaces. Whether a model name exists is the capability descriptor's
    // and then the provider CLI's answer (§6.2), never a shape rule here. An
    // effort value is a CLI flag argument, so internal whitespace there is a typo
    // that would be passed verbatim.
    if (key === "effort" && /\s/.test(value)) {
      throw new AgentProfileCatalogError(
        "catalog-invalid",
        `${key} must not contain whitespace (got ${JSON.stringify(value)})`,
        `${path}.${key}`,
      );
    }
    // A space is the only whitespace a display name needs; a no-break space or
    // line separator is an invisible paste artifact, not a model name.
    if (key === "model" && /[^\S ]/.test(value)) {
      throw new AgentProfileCatalogError(
        "catalog-invalid",
        `model must not contain whitespace other than a plain space (got ${JSON.stringify(value)})`,
        `${path}.${key}`,
      );
    }
    settings[key] = value;
  }

  if (obj["budget"] !== undefined) {
    if (obj["budget"] === null) {
      settings.budget = null;
    } else {
      const value = requireLabel(obj["budget"], `${path}.budget`, "budget");
      if (!BUDGET_AMOUNT.test(value) || Number(value) <= 0) {
        throw new AgentProfileCatalogError(
          "catalog-invalid",
          `budget must be a positive USD amount as a string (e.g. "10", "2.50"); got ${JSON.stringify(value)}`,
          `${path}.budget`,
        );
      }
      settings.budget = value;
    }
  }

  if (obj["providerOptions"] !== undefined) {
    if (obj["providerOptions"] === null) {
      throw new AgentProfileCatalogError(
        "catalog-invalid",
        "providerOptions cannot be nulled as a block; unset individual options with null",
        `${path}.providerOptions`,
      );
    }
    const options = requireObject(
      obj["providerOptions"],
      `${path}.providerOptions`,
      "providerOptions must be a JSON object of string values",
    );
    const parsedOptions = emptyDict<string | null>();
    for (const [key, value] of Object.entries(options)) {
      const optionPath = `${path}.providerOptions.${key}`;
      assertNotForbiddenKey(key, `${path}.providerOptions`);
      if (key.length === 0 || MALFORMED_PROVIDER_OPTION_KEY.test(key) || hasControlCharacter(key)) {
        throw new AgentProfileCatalogError(
          "catalog-invalid",
          `"${key}" is not a valid provider option name (a non-empty name without whitespace or control characters)`,
          optionPath,
        );
      }
      parsedOptions[key] = value === null ? null : requireLabel(value, optionPath, "a provider option");
    }
    settings.providerOptions = parsedOptions;
  }

  return settings;
}

// ---------------------------------------------------------------------------
// Overlay merge (§9.4)
// ---------------------------------------------------------------------------

function mergeProvider(
  provider: string,
  builtin: AgentProfileProviderDocument | undefined,
  overlay: AgentProfileProviderDocument | undefined,
): EffectiveProviderCatalog {
  // Capability descriptors replace per key; keys the overlay does not mention
  // keep their built-in declaration.
  const capabilities = emptyDict<CapabilityDeclaration>();
  const capabilitySources = emptyDict<CatalogValueSource>();
  for (const [key, value] of Object.entries(builtin?.capabilities ?? {})) {
    capabilities[key] = value;
    capabilitySources[key] = "catalog-builtin";
  }
  for (const [key, value] of Object.entries(overlay?.capabilities ?? {})) {
    capabilities[key] = value;
    capabilitySources[key] = "catalog-overlay";
  }

  // Profiles merge by name, field by field. A name only the overlay declares is
  // added; a name only the built-in declares survives untouched, because an
  // overlay cannot delete (§9.4).
  const profiles = emptyDict<EffectiveRuntimeProfile>();
  const profileNames = new Set<string>([
    ...Object.keys(builtin?.profiles ?? {}),
    ...Object.keys(overlay?.profiles ?? {}),
  ]);
  for (const name of [...profileNames].sort()) {
    profiles[name] = mergeProfile(
      name,
      ownValue(builtin?.profiles, name),
      ownValue(overlay?.profiles, name),
    );
  }

  // Bindings replace one level at a time; the other three keep the built-in.
  const qualityBindings = {} as Record<QualityLevel, EffectiveQualityBinding>;
  const bound: Array<{ level: QualityLevel; profileName: string; source: CatalogValueSource }> = [];
  for (const level of QUALITY_LEVELS) {
    const overlayName = overlay?.qualityBindings?.[level];
    const builtinName = builtin?.qualityBindings?.[level];
    const profileName = overlayName ?? builtinName;
    if (profileName === undefined) continue;
    bound.push({
      level,
      profileName,
      source: overlayName !== undefined ? "catalog-overlay" : "catalog-builtin",
    });
  }
  for (const entry of bound) {
    qualityBindings[entry.level] = {
      level: entry.level,
      profileName: entry.profileName,
      source: entry.source,
      sharedWithQualityLevels: bound
        .filter((other) => other.level !== entry.level && other.profileName === entry.profileName)
        .map((other) => other.level),
    };
  }

  return {
    provider,
    capabilities,
    capabilitySources,
    profiles,
    qualityBindings,
    source: builtin ? "catalog-builtin" : "catalog-overlay",
  };
}

function mergeProfile(
  name: string,
  builtin: AgentProfileSettingsDocument | undefined,
  overlay: AgentProfileSettingsDocument | undefined,
): EffectiveRuntimeProfile {
  const settings: EffectiveProfileSettings = {};
  const settingSources: Partial<Record<AgentProfileSettingKey, CatalogValueSource>> = {};
  const unsetByOverlay: string[] = [];

  for (const key of ["model", "effort", "budget", "binary"] as const) {
    const overlayValue = overlay?.[key];
    if (overlayValue === null) {
      // An explicit unset restores "the provider CLI's own default applies".
      unsetByOverlay.push(key);
      continue;
    }
    if (overlayValue !== undefined) {
      settings[key] = overlayValue;
      settingSources[key] = "catalog-overlay";
      continue;
    }
    const builtinValue = builtin?.[key];
    if (typeof builtinValue === "string") {
      settings[key] = builtinValue;
      settingSources[key] = "catalog-builtin";
    }
  }

  // `providerOptions` merges by key, with null unsetting one option.
  const providerOptions = emptyDict<string>();
  const providerOptionSources = emptyDict<CatalogValueSource>();
  for (const [key, value] of Object.entries(builtin?.providerOptions ?? {})) {
    if (typeof value !== "string") continue;
    providerOptions[key] = value;
    providerOptionSources[key] = "catalog-builtin";
  }
  for (const [key, value] of Object.entries(overlay?.providerOptions ?? {})) {
    if (value === null) {
      delete providerOptions[key];
      delete providerOptionSources[key];
      unsetByOverlay.push(`providerOptions.${key}`);
      continue;
    }
    providerOptions[key] = value;
    providerOptionSources[key] = "catalog-overlay";
  }
  if (Object.keys(providerOptions).length > 0) {
    settings.providerOptions = providerOptions;
    settingSources.providerOptions = Object.values(providerOptionSources).some(
      (source) => source === "catalog-overlay",
    )
      ? "catalog-overlay"
      : "catalog-builtin";
  }

  return {
    name,
    settings,
    settingSources,
    providerOptionSources,
    unsetByOverlay,
    source: overlay !== undefined ? "catalog-overlay" : "catalog-builtin",
  };
}

// ---------------------------------------------------------------------------
// Cross-validation of the effective catalog (§12.1 load-time gate)
// ---------------------------------------------------------------------------

function validateEffectiveCatalog(catalog: EffectiveAgentProfileCatalog): void {
  for (const provider of Object.keys(catalog.providers)) {
    const entry = catalog.providers[provider];
    // Same file-qualified prefix the shape gate uses: a load-time refusal names
    // the file an operator edits, not a bare pointer into an anonymous document.
    const path = `${catalog.catalogPath}.providers.${provider}`;

    // Capability conformance, per profile. Checked for every declared profile,
    // not only the four a binding reaches, so a profile an operator is about to
    // pin fails on the edit rather than on the pinned run.
    for (const profile of Object.values(entry.profiles)) {
      validateProfileAgainstCapabilities(profile, entry, `${path}.profiles.${profile.name}`);
    }

    // Every level bound (§6.4) — no fallback level, no nearest-lower binding.
    for (const level of QUALITY_LEVELS) {
      const binding = entry.qualityBindings[level];
      if (!binding) {
        throw new AgentProfileCatalogError(
          "unbound-quality",
          `provider "${provider}" does not bind quality level "${level}"; all of ${QUALITY_LEVELS.join(", ")} must name a declared profile`,
          `${path}.qualityBindings.${level}`,
        );
      }
      // Own-property only: a binding to `toString` names a profile the provider
      // does not declare, however friendly `Object.prototype` is about it.
      if (ownValue(entry.profiles, binding.profileName) === undefined) {
        assertNoBindingIndirection(provider, binding, `${path}.qualityBindings.${level}`);
        throw new AgentProfileCatalogError(
          "unknown-profile",
          `quality level "${level}" names profile "${binding.profileName}", which provider "${provider}" does not declare`,
          `${path}.qualityBindings.${level}`,
        );
      }
    }
  }
}

function validateProfileAgainstCapabilities(
  profile: EffectiveRuntimeProfile,
  provider: EffectiveProviderCatalog,
  path: string,
): void {
  for (const key of AGENT_PROFILE_SETTING_KEYS) {
    const value = profile.settings[key];
    if (value === undefined) continue;

    const declaration = ownValue(provider.capabilities, key);
    if (declaration === undefined) {
      throw new AgentProfileCatalogError(
        "unsupported-setting",
        `provider "${provider.provider}" does not accept the setting "${key}"`,
        `${path}.${key}`,
      );
    }

    if (key === "providerOptions") {
      for (const optionKey of Object.keys(value as Record<string, string>)) {
        if (declaration !== "free" && !declaration.includes(optionKey)) {
          throw new AgentProfileCatalogError(
            "unsupported-setting",
            `provider "${provider.provider}" does not declare the provider option "${optionKey}" (declared: ${declaration.join(", ")})`,
            `${path}.providerOptions.${optionKey}`,
          );
        }
      }
      continue;
    }

    if (declaration !== "free" && !declaration.includes(value as string)) {
      // Never lowered to the nearest declared value: §12.3's governing rule is
      // that a resolved setting is refused, not substituted.
      throw new AgentProfileCatalogError(
        "unsupported-value",
        `${key} "${value as string}" is not accepted by provider "${provider.provider}" (declared: ${declaration.join(", ")})`,
        `${path}.${key}`,
      );
    }
  }
}

/**
 * Guards the one-hop rule that makes an alias cycle unrepresentable: a quality
 * binding names a runtime profile, never another quality level and never
 * another binding. If a future schema ever adds indirection, this is where the
 * cycle check has to be written; today an indirect-looking binding is simply a
 * name no profile declares, and this reports it as such with the reason stated.
 */
function assertNoBindingIndirection(
  provider: string,
  binding: EffectiveQualityBinding,
  path: string,
): void {
  if (!QUALITY_LEVEL_SET.has(binding.profileName)) return;
  throw new AgentProfileCatalogError(
    "unknown-profile",
    `quality level "${binding.level}" names "${binding.profileName}", which is a quality level rather than a profile declared by provider "${provider}"; bindings name profiles directly and never other bindings`,
    path,
  );
}

// ---------------------------------------------------------------------------
// Reading the effective catalog
// ---------------------------------------------------------------------------

/**
 * The catalog entry for a resolved agent's provider. Throws `unknown-provider`
 * rather than serving another provider's profiles or a settings-free default
 * invocation (§12.3).
 */
export function providerCatalogFor(
  catalog: EffectiveAgentProfileCatalog,
  provider: string,
): EffectiveProviderCatalog {
  const entry = ownValue(catalog.providers, provider);
  if (!entry) {
    throw new AgentProfileCatalogError(
      "unknown-provider",
      `the effective agent profile catalog declares no provider "${provider}"`,
      `providers.${provider}`,
    );
  }
  return entry;
}

/**
 * The profile a provider binds to a quality level, with the binding's
 * provenance. Pure catalog reading: *which* quality level a phase requests is
 * slice B2's decision, not this module's.
 */
export function lookupQualityBinding(
  catalog: EffectiveAgentProfileCatalog,
  provider: string,
  level: QualityLevel,
): { binding: EffectiveQualityBinding; profile: EffectiveRuntimeProfile } {
  const entry = providerCatalogFor(catalog, provider);
  const binding = entry.qualityBindings[level];
  const profile = binding ? ownValue(entry.profiles, binding.profileName) : undefined;
  if (!binding || !profile) {
    // Unreachable for a validated catalog; kept so a caller that hand-built one
    // still fails closed with a §12.2 reason instead of dereferencing undefined.
    throw new AgentProfileCatalogError(
      "unbound-quality",
      `provider "${provider}" does not bind quality level "${level}"`,
      `providers.${provider}.qualityBindings.${level}`,
    );
  }
  return { binding, profile };
}

// ---------------------------------------------------------------------------
// Digest (§13.2)
// ---------------------------------------------------------------------------

function effectiveCatalogDigest(
  providers: Record<string, EffectiveProviderCatalog>,
  catalogVersion: string | undefined,
): string {
  const canonical = {
    schemaVersion: AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
    catalogVersion: catalogVersion ?? null,
    providers: Object.keys(providers)
      .sort()
      .map((provider) => {
        const entry = providers[provider];
        return {
          provider,
          capabilities: Object.keys(entry.capabilities)
            .sort()
            .map((key) => [key, entry.capabilities[key]]),
          profiles: Object.keys(entry.profiles)
            .sort()
            .map((name) => {
              const profile = entry.profiles[name];
              const options = profile.settings.providerOptions;
              return [
                name,
                {
                  model: profile.settings.model ?? null,
                  effort: profile.settings.effort ?? null,
                  budget: profile.settings.budget ?? null,
                  binary: profile.settings.binary ?? null,
                  providerOptions: options
                    ? Object.keys(options)
                        .sort()
                        .map((key) => [key, options[key]])
                    : [],
                },
              ];
            }),
          qualityBindings: QUALITY_LEVELS.map((level) => [
            level,
            entry.qualityBindings[level]?.profileName ?? null,
          ]),
        };
      }),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

/**
 * A dictionary with no prototype. Every map this module builds from document
 * keys uses one, so a key that happens to name an `Object.prototype` member —
 * `toString`, `constructor` — is absent unless the catalog declared it, and a
 * reference to it resolves against declared entries only (§6.1).
 */
function emptyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Reads `key` only when `record` declares it as an own property. Used for every
 * lookup whose key comes from catalog data, including on the public readers
 * below, where the caller may hand in a catalog this module did not build.
 */
function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (record[key] as T | undefined)
    : undefined;
}

function requireObject(raw: unknown, path: string, message: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentProfileCatalogError("catalog-invalid", message, path);
  }
  return raw as Record<string, unknown>;
}

/** True when a string carries a C0/C7F control character, which no catalog value may. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A single-line, non-empty string value: a model name, an effort value, a
 * profile name, a provider option. Trimmed, because a trailing space in a
 * hand-edited JSON string would otherwise reach a CLI verbatim.
 */
function requireLabel(raw: unknown, path: string, what: string): string {
  if (typeof raw !== "string") {
    throw new AgentProfileCatalogError(
      "catalog-invalid",
      `${what} must be a string (got ${raw === null ? "null" : typeof raw})`,
      path,
    );
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new AgentProfileCatalogError("catalog-invalid", `${what} must not be empty`, path);
  }
  if (hasControlCharacter(value)) {
    throw new AgentProfileCatalogError(
      "catalog-invalid",
      `${what} must not contain control characters`,
      path,
    );
  }
  return value;
}

function assertKnownKeys(obj: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(obj)) {
    assertNotForbiddenKey(key, path);
    if (!allowed.has(key)) {
      throw new AgentProfileCatalogError(
        "catalog-invalid",
        `unknown key "${key}" (expected one of ${[...allowed].sort().join(", ")})`,
        `${path}.${key}`,
      );
    }
  }
}

function assertSettingKey(key: string, path: string): void {
  assertNotForbiddenKey(key, path);
  if (!SETTING_KEYS.has(key)) {
    throw new AgentProfileCatalogError(
      "catalog-invalid",
      `"${key}" is not a runtime setting (expected one of ${AGENT_PROFILE_SETTING_KEYS.join(", ")})`,
      `${path}.${key}`,
    );
  }
}

function assertNotForbiddenKey(key: string, path: string): void {
  if (FORBIDDEN_CATALOG_KEYS.has(key)) {
    throw new AgentProfileCatalogError(
      "catalog-invalid",
      `"${key}" may never appear in the catalog: it carries no phase selector, no agent id, and no credential`,
      `${path}.${key}`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
