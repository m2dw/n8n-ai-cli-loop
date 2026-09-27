// ---------------------------------------------------------------------------
// Agent runtime adapter contract and provider registry (issue #906).
//
// This is the boundary piece of slice B3 of
// docs/agent-runtime-profiles-contract.md §14.1: the typed contract that turns
// an agent assignment plus a provider-neutral quality into concrete CLI
// invocation data. It lands the contract only — the adapter interface, the
// fail-closed provider registry, the shared §8.1 resolution engine, the
// invocation sanitation gate, and the probe-interpretation vocabulary for
// optional CLI discovery. No adapter for a real provider ships here and no
// lane invokes through the boundary, so landing it changes no invocation:
// every resolution site inventoried in §1.2 of the contract keeps resolving
// model/effort/budget exactly as it does today. The per-provider adapters and
// each lane's cutover (each with its own §10.3 before/after table) are the
// follow-up slices that make this boundary live, one lane at a time — which is
// what lets existing handlers migrate incrementally, with no flag day.
//
// What the boundary owns, and nothing else:
//
//   - **Adapter lookup that fails closed** (§12.3). The shipped agent→provider
//     mapping (`providerForAgent`, src/handlers/codex-context-mode.ts) fails
//     *open* by echoing an unknown agent id back as its provider. It is
//     injected here rather than imported — `core/` takes no runtime dependency
//     on `handlers/` — and the registry compensates for its fail-open shape:
//     a mapping that echoes the id back unchanged is recognized as that
//     fail-open answer, never a real assignment (an agent id is never a
//     provider key), and the lookup refuses it (`unknown-provider`) before
//     consulting the adapter table — where an echoed id colliding with a
//     registered provider key would otherwise resolve to an invocation the
//     assignment never authorized.
//   - **The §8.1 precedence chain for concrete settings.** Field-level
//     environment overrides (layer 1, break-glass) over a task-pinned profile
//     name (layer 2) over a session per-agent pin (layer 3) over the quality
//     binding in the effective catalog (layers 4–5). Layers 2–5 are
//     profile-level: a pin replaces the binding lookup outright, so a pinned
//     profile's omitted field stays omitted; layer 1 overrides one field and
//     leaves the others resolving normally.
//   - **Validation of every override before any billable invocation** (§12.1's
//     resolution-time gate). An env override that is empty, malformed, or
//     outside the provider's capability descriptor is `invalid-override`; a
//     pin naming a profile the provider does not declare is `unknown-profile`.
//     Nothing is clamped to a nearby value (§12.3).
//   - **The §13.2 metadata.** Every concrete value carries its own source, an
//     unset model is an absence and never the string "default" (§13.3), a
//     declared shared binding is visible as `sharedWithQualityLevels`, and the
//     catalog digest ties the resolution to the catalog revision it read.
//   - **A sanitation gate over the invocation data an adapter builds.** The
//     command must be the resolved binary, argv must be control-character
//     free, and the lane's prompt must reach the CLI verbatim on the channel
//     the plan declares — stdin where a lane requires it today. A plan that
//     violates the gate is an adapter defect and refuses loudly.
//   - **The configuration/transient split.** Everything this module throws is
//     deterministic, pre-invocation, and human-actionable — recognized by
//     {@link isAgentRuntimeConfigurationError} — and must never be classified
//     as (or retried like) an agent execution failure. The optional discovery
//     hook reuses the typed probe taxonomy of src/core/cli-probe.ts (issue
//     #897) so a transiently unprobeable CLI is `indeterminate`, never
//     recorded as unavailable.
//
// Three properties this module deliberately does NOT have:
//
//   - **It never spawns a process.** Building an invocation is pure; the
//     caller spawns through its existing runner seam, under the existing
//     isolation, sandbox, permission, timeout, and context-mode machinery.
//     Discovery is interpretation of a probe outcome the caller obtained.
//   - **It names no provider.** Provider names are catalog keys carried by the
//     registered adapters; this contract stays provider-neutral, and a test
//     pins the source against ever mentioning one.
//   - **No model-name or effort unions** (§14.3). Every provider-tracked value
//     is a `string` validated against the catalog's capability descriptors;
//     the only closed vocabularies below are the ones this contract owns.
// ---------------------------------------------------------------------------

import type {
  AgentProfileRefusalReason,
  AgentProfileSettingKey,
  CatalogSource,
  EffectiveAgentProfileCatalog,
  EffectiveProviderCatalog,
  EffectiveRuntimeProfile,
  QualityLevel,
} from "./agent-profile-catalog.js";
import {
  AGENT_PROFILE_REFUSAL_REASONS,
  QUALITY_LEVELS,
  lookupQualityBinding,
  providerCatalogFor,
} from "./agent-profile-catalog.js";
import type { EffectiveQuality } from "./agent-quality.js";
import { isQualityLevel } from "./agent-quality.js";
import type { CliProbeOutcome } from "./cli-probe.js";
import { MAX_PROBE_DETAIL_CHARS } from "./cli-probe.js";
import type { AiTask } from "./task.js";

// ---------------------------------------------------------------------------
// Vocabularies (§14.3 — the closed, provider-neutral ones only)
// ---------------------------------------------------------------------------

/**
 * Where one concrete resolved value came from (§13.2). Distinct from
 * {@link RuntimeProfileSource}: §8.1's layers 2–5 are profile-level, so a
 * pinned profile's fields still carry their catalog provenance — only layer 1
 * is field-level and shows up here as `env`.
 */
export const RUNTIME_SETTING_SOURCES = [
  /** §8.1 layer 1 — a break-glass operator environment override. */
  "env",
  /** The resolved profile's field, supplied by the operator overlay file. */
  "catalog-overlay",
  /** The resolved profile's field, supplied by the built-in catalog. */
  "catalog-builtin",
  /**
   * The provider declares the setting but nothing set it: the provider CLI's
   * own default applies, recorded as an absence (§13.3), never as a value.
   */
  "cli-default",
  /** The adapter's compiled-in default supplied it (the binary only). */
  "default",
  /** The provider's capability descriptor does not declare the setting at all. */
  "not-applicable",
] as const;

export type RuntimeSettingSource = (typeof RUNTIME_SETTING_SOURCES)[number];

/** Which §8.1 layer chose the profile itself (§13.2 `profileSource`). */
export const RUNTIME_PROFILE_SOURCES = [
  "task-pin",
  "session-config",
  "catalog-overlay",
  "catalog-builtin",
] as const;

export type RuntimeProfileSource = (typeof RUNTIME_PROFILE_SOURCES)[number];

/**
 * How a lane's prompt reaches the CLI. Prompts stay on stdin where a lane
 * requires it today; some lanes pass the prompt as one argv element, and one
 * provider's CLI needs both channels because certain builds ignore stdin. The
 * plan declares its channel and the sanitation gate verifies the prompt
 * arrives verbatim on it, so a prompt can never silently migrate.
 */
export const PROMPT_DELIVERIES = ["stdin", "argument", "stdin-and-argument", "none"] as const;

export type PromptDelivery = (typeof PROMPT_DELIVERIES)[number];

/**
 * §7 rule 1: a setting the lane cannot express is recorded as not applicable,
 * never dropped in silence. The gate requires a plan to declare which of the
 * two happened whenever a budget resolved.
 */
export const BUDGET_APPLICATIONS = ["applied", "not-applicable"] as const;

export type BudgetApplication = (typeof BUDGET_APPLICATIONS)[number];

/**
 * What optional CLI discovery established, mapped from the typed probe
 * taxonomy of issue #897: `available` and `unavailable` are determinate facts
 * about the installed CLI; `indeterminate` is a fact about the host at one
 * moment, and MUST NOT be recorded as a property of the CLI.
 */
export const AGENT_RUNTIME_DISCOVERY_STATUSES = [
  "available",
  "unavailable",
  "indeterminate",
] as const;

export type AgentRuntimeDiscoveryStatus = (typeof AGENT_RUNTIME_DISCOVERY_STATUSES)[number];

/**
 * Environment keys an invocation plan may never set. Each is either pinned by
 * the isolation layer when it builds the child environment, or deliberately
 * stripped from it — write-enabling GitHub/Actions credentials and variables
 * that leak the caller's checkout path. `AgentInvocationPlan.env` additions
 * ride into that child environment, so an addition naming one of these would
 * re-open exactly the boundary `buildIsolatedInvocation` exists to close. The
 * stripped names are restated from src/handlers/agent-isolation.ts — handlers
 * may import this list; `core/` never imports theirs — and a contract test
 * pins this list as a superset of the isolation layer's exported strip lists,
 * so the restatement cannot drift. Provider credential variables are not
 * enumerated here (this contract names no provider); the sanitation gate
 * refuses them by shape instead — no addition may carry a credential-shaped
 * name at all.
 */
export const INVOCATION_PROTECTED_ENV_KEYS = [
  // Pinned by the isolation layer when it builds the child environment.
  "HOME",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "PATH",
  // Stripped: credentials that could authenticate a GitHub or Actions write.
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_APP_ID",
  "GH_INSTALLATION_TOKEN",
  "GITHUB_APP_TOKEN",
  "GITHUB_CLIENT_SECRET",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  // Stripped: variables that leak the caller's checkout path.
  "PWD",
  "OLDPWD",
  "INIT_CWD",
  "npm_config_local_prefix",
  "npm_package_json",
] as const;

/**
 * Task-context key under which an explicit operator profile pin lives (§8.1
 * layer 2), keyed by agent id — profile names are provider-scoped, so a pin
 * written for one agent structurally does not apply to a task reassigned to
 * another, rather than being silently reinterpreted. Nothing in this slice
 * writes the key — the operator command that does is slice B4's — but
 * resolution honors it wherever it appears, exactly as B2 treats its
 * `qualityPin`.
 */
export const RUNTIME_PROFILE_PIN_CONTEXT_KEY = "runtimeProfilePin";

// ---------------------------------------------------------------------------
// Errors — unsupported configuration vs adapter defects vs transient failure
// ---------------------------------------------------------------------------

/**
 * A refusal from the runtime boundary's resolution-time gate (§12.1). The
 * `reason` is drawn from §12.2's single closed set, so an operator sees one
 * refusal vocabulary whether the catalog gate, the quality gate, or this
 * boundary fired. Everything raised with this class is *unsupported
 * configuration*: deterministic, pre-invocation, and actionable — never a
 * transient agent execution failure, never retried.
 */
export class AgentRuntimeAdapterError extends Error {
  readonly reason: AgentProfileRefusalReason;
  readonly path?: string;

  constructor(reason: AgentProfileRefusalReason, message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "AgentRuntimeAdapterError";
    this.reason = reason;
    if (path !== undefined) this.path = path;
  }
}

/**
 * A defect in an adapter or its registration, as opposed to operator
 * configuration: a duplicate provider registration, a malformed adapter
 * descriptor, an invocation request no caller should be able to build, or a
 * plan that fails the sanitation gate. Follows the registry rule of
 * src/core/operation-port.ts — a bad descriptor is a programming error at the
 * composition root and must stop loudly, not resolve to something nearby.
 */
export class AgentRuntimeContractViolationError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string, options?: ErrorOptions) {
    super(path ? `${path}: ${message}` : message, options);
    this.name = "AgentRuntimeContractViolationError";
    if (path !== undefined) this.path = path;
  }
}

const CONFIGURATION_ERROR_NAMES = new Set([
  "AgentRuntimeAdapterError",
  "AgentRuntimeContractViolationError",
  // The two upstream gates of §12.1, whose refusals reach a lane through this
  // boundary unchanged.
  "AgentProfileCatalogError",
  "AgentQualityError",
]);

/**
 * True when an error is a pre-invocation refusal of the runtime boundary or
 * of the catalog/quality gates beneath it. Such an error is deterministic and
 * human-actionable: the caller must stop the phase and surface it, never
 * retry it, and never classify it as an agent execution failure. Anything
 * else that surfaces while *running* a CLI belongs to the execution-side
 * classifiers (src/core/cli-probe.ts and the lane's own machinery), where
 * transient host conditions are recognized as such.
 *
 * Matches on the error's `name` rather than `instanceof`, so refusals survive
 * a module-identity split between compiled copies.
 */
export function isAgentRuntimeConfigurationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" && CONFIGURATION_ERROR_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// The adapter contract (§7)
// ---------------------------------------------------------------------------

/** The four field-level settings §8.1 layer 1 can override. */
export type EnvOverridableSettingKey = Exclude<AgentProfileSettingKey, "providerOptions">;

const ENV_OVERRIDABLE_SETTING_KEYS: readonly EnvOverridableSettingKey[] = [
  "model",
  "effort",
  "budget",
  "binary",
];

/**
 * One §8.1 layer-1 binding: which environment variable break-glasses which
 * setting for this adapter's provider. At most one binding per setting. The
 * variable's value is validated against the provider's capability descriptor
 * before it is honored — a break-glass override may replace a value, never
 * widen what the provider accepts (§12.3).
 */
export interface AgentRuntimeEnvOverride {
  readonly setting: EnvOverridableSettingKey;
  /** The variable name, e.g. `CLAUDE_MODEL` or `ANTIGRAVITY_BIN`. */
  readonly variable: string;
}

/**
 * How to ask this adapter's installed CLI what it is, without this module
 * ever spawning it: the caller runs `<resolved binary> <args>` through its
 * own probe seam and hands the typed outcome to
 * {@link interpretDiscoveryProbe} along with this spec.
 */
export interface AgentRuntimeDiscoverySpec {
  /** argv (after the binary) that prints the version banner, e.g. `["--version"]`. */
  readonly args: readonly string[];
  /**
   * Parse a successful probe's stdout into discovery facts. Capability values
   * remain opaque provider-specific strings (§14.3). A parser that throws or
   * returns malformed data degrades to "available, banner unparsed" — the CLI
   * demonstrably ran, and discovery is informational, never a gate.
   */
  parse(stdout: string): { version?: string; capabilities?: Record<string, string> };
}

/**
 * One provider's runtime adapter: the provider-specific knowledge the common
 * boundary composes with the shared resolution engine. Implementations must
 * be pure — no filesystem, no spawn — so tests inject them freely and no real
 * CLI is ever invoked by contract machinery.
 */
export interface AgentRuntimeAdapter {
  /** The catalog provider key this adapter serves (§3 "Provider"). */
  readonly provider: string;
  /**
   * The binary that runs when neither an env override nor the resolved
   * profile names one; recorded with source `default` (§13.2).
   */
  readonly defaultBinary: string;
  /** The §8.1 layer-1 break-glass variables this provider honors. */
  readonly envOverrides: readonly AgentRuntimeEnvOverride[];
  /**
   * Turn one resolved runtime into invocation data for a lane (§7). The
   * adapter consumes the resolved profile and nothing else — it never
   * re-derives a setting from labels, the session, or a default of its own
   * (§7 rule 2). A lane or setting combination the adapter cannot express
   * refuses with {@link AgentRuntimeAdapterError}; the returned plan must
   * pass {@link assertSanitizedInvocationPlan}, which
   * {@link planAgentInvocation} enforces.
   */
  buildInvocation(request: AgentInvocationRequest, resolved: ResolvedAgentRuntime): AgentInvocationPlan;
  /** Optional CLI discovery: how to probe the installed binary's version. */
  readonly discovery?: AgentRuntimeDiscoverySpec;
}

// ---------------------------------------------------------------------------
// The registry — fail-closed adapter lookup
// ---------------------------------------------------------------------------

export interface AgentRuntimeAdapterRegistry {
  /** Registered provider keys, sorted. */
  readonly providers: readonly string[];
  /**
   * The adapter serving one provider. Refuses (`unknown-provider`) for a
   * provider no adapter serves — never a settings-free default invocation.
   */
  adapterForProvider(provider: string): AgentRuntimeAdapter;
  /**
   * The adapter serving one agent, through the injected agent→provider
   * mapping. Fail-closed for unknown and unavailable agents: a blank id, an
   * id the mapping cannot place, and a provider no adapter serves all refuse
   * with `unknown-provider` — including an unknown id the shipped fail-open
   * mapping echoes back as its own provider.
   */
  adapterForAgent(agentId: string): AgentRuntimeAdapter;
  /** True when {@link adapterForAgent} would succeed for this id. */
  hasAdapterForAgent(agentId: string): boolean;
}

export interface CreateAgentRuntimeAdapterRegistryOptions {
  readonly adapters: readonly AgentRuntimeAdapter[];
  /**
   * The agent→provider mapping, injected because the shipped one lives in
   * `handlers/` and `core/` takes no runtime dependency on it. Its fail-open
   * default branch (echoing an unknown id) is compensated by the registry's
   * own fail-closed lookup.
   */
  readonly providerForAgent: (agentId: string) => string;
}

const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;
// A budget is a plain USD amount — the same shape the catalog validator pins.
const BUDGET_AMOUNT = /^\d+(?:\.\d{1,2})?$/;
// The one character no channel may carry; spelled out so the source never
// embeds a raw control byte.
const NUL_CHARACTER = String.fromCharCode(0);

/**
 * Agent ids are never provider keys (§3): the registry is keyed by provider,
 * and registering an adapter under an agent id would let the fail-open
 * mapping's echo of that id look like a served provider.
 */
const KNOWN_AGENT_IDS = new Set(["claude", "codex", "gemini"]);

/**
 * Build the fail-closed registry. Registration defects throw
 * {@link AgentRuntimeContractViolationError} at the composition root;
 * lookup defects refuse with {@link AgentRuntimeAdapterError} per run.
 */
export function createAgentRuntimeAdapterRegistry(
  options: CreateAgentRuntimeAdapterRegistryOptions,
): AgentRuntimeAdapterRegistry {
  if (typeof options.providerForAgent !== "function") {
    throw new AgentRuntimeContractViolationError(
      "the registry needs an injected providerForAgent(agentId) mapping",
    );
  }

  const byProvider = emptyDict<AgentRuntimeAdapter>();
  for (const adapter of options.adapters) {
    validateAdapter(adapter);
    if (ownValue(byProvider, adapter.provider) !== undefined) {
      throw new AgentRuntimeContractViolationError(
        `two adapters are registered for provider "${adapter.provider}"`,
      );
    }
    byProvider[adapter.provider] = adapter;
  }
  const providers = Object.freeze(Object.keys(byProvider).sort());

  function adapterForProvider(provider: string): AgentRuntimeAdapter {
    const key = typeof provider === "string" ? provider.trim() : "";
    if (key.length === 0) {
      throw new AgentRuntimeAdapterError("unknown-provider", "no provider was named");
    }
    const adapter = ownValue(byProvider, key);
    if (!adapter) {
      throw new AgentRuntimeAdapterError(
        "unknown-provider",
        `no runtime adapter is registered for provider "${key}" (registered: ${providers.join(", ") || "none"})`,
      );
    }
    return adapter;
  }

  function resolveProvider(agentId: string): { agentId: string; provider: string } {
    const id = typeof agentId === "string" ? agentId.trim() : "";
    if (id.length === 0) {
      throw new AgentRuntimeAdapterError(
        "unknown-provider",
        "no agent id was resolved for this run; the assignment (context.assignment) decides the agent",
      );
    }
    const mapped = options.providerForAgent(id);
    const provider = typeof mapped === "string" ? mapped.trim() : "";
    if (provider.length === 0) {
      throw new AgentRuntimeAdapterError(
        "unknown-provider",
        `the agent→provider mapping returned nothing for agent "${id}"`,
      );
    }
    if (provider === id) {
      // The shipped mapping's fail-open default echoes an unknown id back as
      // its own provider. An identity answer is therefore never a real
      // assignment (an agent id is never a provider key), and it must refuse
      // HERE: an echoed id that collides with a registered provider key would
      // otherwise pass the adapter lookup below.
      throw new AgentRuntimeAdapterError(
        "unknown-provider",
        `the agent→provider mapping echoed agent "${id}" back as its own provider — its fail-open answer for an id it does not know — so "${id}" does not name a registered agent`,
      );
    }
    return { agentId: id, provider };
  }

  return Object.freeze({
    providers,
    adapterForProvider,
    adapterForAgent(agentId: string): AgentRuntimeAdapter {
      const { agentId: id, provider } = resolveProvider(agentId);
      const adapter = ownValue(byProvider, provider);
      if (!adapter) {
        throw new AgentRuntimeAdapterError(
          "unknown-provider",
          `agent "${id}" resolves to provider "${provider}", which has no registered runtime adapter (registered: ${providers.join(", ") || "none"})`,
        );
      }
      return adapter;
    },
    hasAdapterForAgent(agentId: string): boolean {
      const id = typeof agentId === "string" ? agentId.trim() : "";
      if (id.length === 0) return false;
      const mapped = options.providerForAgent(id);
      const provider = typeof mapped === "string" ? mapped.trim() : "";
      // Same echo rule as resolveProvider: an identity mapping is the
      // fail-open default for an unknown id, not an assignment.
      if (provider.length === 0 || provider === id) return false;
      return ownValue(byProvider, provider) !== undefined;
    },
  });
}

function validateAdapter(adapter: AgentRuntimeAdapter): void {
  const provider = adapter?.provider;
  if (typeof provider !== "string" || !PROVIDER_NAME.test(provider)) {
    throw new AgentRuntimeContractViolationError(
      `"${String(provider)}" is not a valid provider key (lowercase letters, digits, and hyphens)`,
    );
  }
  const path = `adapter "${provider}"`;
  if (KNOWN_AGENT_IDS.has(provider)) {
    throw new AgentRuntimeContractViolationError(
      `"${provider}" is an agent id, not a provider; adapters are registered under the catalog's provider keys`,
      path,
    );
  }
  if (
    typeof adapter.defaultBinary !== "string" ||
    adapter.defaultBinary.trim().length === 0 ||
    hasControlCharacter(adapter.defaultBinary)
  ) {
    throw new AgentRuntimeContractViolationError(
      "defaultBinary must be a non-empty string without control characters",
      path,
    );
  }
  if (typeof adapter.buildInvocation !== "function") {
    throw new AgentRuntimeContractViolationError("buildInvocation must be a function", path);
  }
  if (!Array.isArray(adapter.envOverrides)) {
    throw new AgentRuntimeContractViolationError("envOverrides must be an array", path);
  }
  const seenSettings = new Set<string>();
  const seenVariables = new Set<string>();
  for (const override of adapter.envOverrides) {
    const setting = override?.setting;
    if (!ENV_OVERRIDABLE_SETTING_KEYS.includes(setting as EnvOverridableSettingKey)) {
      throw new AgentRuntimeContractViolationError(
        `"${String(setting)}" is not an env-overridable setting (expected one of ${ENV_OVERRIDABLE_SETTING_KEYS.join(", ")})`,
        path,
      );
    }
    if (typeof override.variable !== "string" || !ENV_VARIABLE_NAME.test(override.variable)) {
      throw new AgentRuntimeContractViolationError(
        `"${String(override?.variable)}" is not a valid environment variable name`,
        path,
      );
    }
    if (seenSettings.has(setting as string)) {
      throw new AgentRuntimeContractViolationError(
        `two env overrides are declared for the setting "${setting as string}"`,
        path,
      );
    }
    if (seenVariables.has(override.variable)) {
      throw new AgentRuntimeContractViolationError(
        `the variable "${override.variable}" is declared for two settings`,
        path,
      );
    }
    seenSettings.add(setting as string);
    seenVariables.add(override.variable);
  }
  if (adapter.discovery !== undefined) {
    const spec = adapter.discovery;
    if (
      !Array.isArray(spec.args) ||
      spec.args.some(
        (arg) => typeof arg !== "string" || arg.length === 0 || hasControlCharacter(arg),
      ) ||
      typeof spec.parse !== "function"
    ) {
      throw new AgentRuntimeContractViolationError(
        "discovery must declare probe args (non-empty strings) and a parse function",
        path,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The §8.1 resolution engine
// ---------------------------------------------------------------------------

/** One concrete resolved value with its §13.2 provenance. An absent `value`
 * means the provider CLI's own default applies (§13.3). */
export interface ResolvedRuntimeSetting {
  readonly value?: string;
  readonly source: RuntimeSettingSource;
}

/** The binary always resolves to a concrete value — the adapter's default
 * guarantees one even for a provider whose descriptor does not declare the
 * `binary` setting. */
export interface ResolvedRuntimeBinary {
  readonly value: string;
  readonly source: RuntimeSettingSource;
}

/**
 * The §13.2 answer for one run: what was asked, which profile answered, every
 * concrete value with its own source, and the catalog revision that was read.
 * This is what the adapter consumes and what slice B4's audit record persists.
 */
export interface ResolvedAgentRuntime {
  readonly agentId: string;
  readonly provider: string;
  /** The per-run quality (escalation already applied), with its request intact. */
  readonly quality: EffectiveQuality;
  readonly profileName: string;
  readonly profileSource: RuntimeProfileSource;
  /** The declared bindings resolving to the same profile (§6.3, §13.2). */
  readonly sharedWithQualityLevels: readonly QualityLevel[];
  /**
   * The catalog SCHEMA version this resolution was read under (§11.1), which
   * is not the operator's `catalogVersion` label: the schema fixes what the
   * document may say, the label names which revision said it. The audit record
   * (§13.2) carries both, so a resolution can be attributed either to a
   * catalog edit or to a binary that understands a different schema.
   */
  readonly catalogSchemaVersion: number;
  readonly catalogVersion?: string;
  readonly catalogSource: CatalogSource;
  readonly catalogDigest: string;
  readonly model: ResolvedRuntimeSetting;
  readonly effort: ResolvedRuntimeSetting;
  readonly budget: ResolvedRuntimeSetting;
  readonly binary: ResolvedRuntimeBinary;
  readonly providerOptions: Readonly<Record<string, string>>;
  readonly providerOptionSources: Readonly<Record<string, RuntimeSettingSource>>;
}

export interface ResolveAgentRuntimeInput {
  readonly agentId: string;
  /** The per-run quality from slice B2's resolution (`qualityForPhaseClass`). */
  readonly quality: EffectiveQuality;
  /** The effective catalog, loaded once at phase start (§9.3). */
  readonly catalog: EffectiveAgentProfileCatalog;
  /** Environment for §8.1 layer 1. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** §8.1 layer 2 — read via {@link readRuntimeProfilePin}. */
  readonly taskPinnedProfile?: string;
  /** §8.1 layer 3 — read via {@link sessionPinnedProfileFor}. */
  readonly sessionPinnedProfile?: string;
}

/**
 * Resolve the concrete runtime for one run, per §8.1, against one adapter's
 * provider. Fail-closed throughout: every refusal is a §12.2 reason with a
 * message naming the offending variable, pin, or profile, raised before any
 * CLI is invoked.
 */
export function resolveAgentRuntime(
  adapter: AgentRuntimeAdapter,
  input: ResolveAgentRuntimeInput,
): ResolvedAgentRuntime {
  const env = input.env ?? process.env;
  const providerEntry = providerCatalogFor(input.catalog, adapter.provider);
  const requestedLevel = input.quality?.quality;
  if (!isQualityLevel(requestedLevel)) {
    throw new AgentRuntimeAdapterError(
      "invalid-quality-request",
      `"${String(requestedLevel)}" does not name a quality level (expected one of ${QUALITY_LEVELS.join(", ")})`,
    );
  }

  const chosen = chooseProfile(input.catalog, providerEntry, requestedLevel, input);

  const model = resolveSetting("model", adapter, providerEntry, chosen.profile, env);
  const effort = resolveSetting("effort", adapter, providerEntry, chosen.profile, env);
  const budget = resolveSetting("budget", adapter, providerEntry, chosen.profile, env);
  const binary = resolveBinary(adapter, providerEntry, chosen.profile, env);

  const providerOptions = emptyDict<string>();
  const providerOptionSources = emptyDict<RuntimeSettingSource>();
  for (const [key, value] of Object.entries(chosen.profile.settings.providerOptions ?? {})) {
    providerOptions[key] = value;
    providerOptionSources[key] = chosen.profile.providerOptionSources[key] ?? "catalog-builtin";
  }

  return {
    agentId: input.agentId,
    provider: adapter.provider,
    quality: input.quality,
    profileName: chosen.profile.name,
    profileSource: chosen.source,
    sharedWithQualityLevels: chosen.sharedWithQualityLevels,
    catalogSchemaVersion: input.catalog.schemaVersion,
    ...(input.catalog.catalogVersion !== undefined
      ? { catalogVersion: input.catalog.catalogVersion }
      : {}),
    catalogSource: input.catalog.catalogSource,
    catalogDigest: input.catalog.digest,
    model,
    effort,
    budget,
    binary,
    providerOptions,
    providerOptionSources,
  };
}

function chooseProfile(
  catalog: EffectiveAgentProfileCatalog,
  providerEntry: EffectiveProviderCatalog,
  level: QualityLevel,
  input: ResolveAgentRuntimeInput,
): {
  profile: EffectiveRuntimeProfile;
  source: RuntimeProfileSource;
  sharedWithQualityLevels: readonly QualityLevel[];
} {
  const pins: Array<{ raw: string | undefined; source: RuntimeProfileSource; what: string }> = [
    { raw: input.taskPinnedProfile, source: "task-pin", what: "the task's runtime profile pin" },
    {
      raw: input.sessionPinnedProfile,
      source: "session-config",
      what: `session.agentRuntime.pins.${input.agentId}`,
    },
  ];
  for (const pin of pins) {
    if (pin.raw === undefined) continue;
    const name = typeof pin.raw === "string" ? pin.raw.trim() : "";
    if (name.length === 0 || !PROFILE_NAME.test(name)) {
      throw new AgentRuntimeAdapterError(
        "invalid-override",
        `${pin.what} is not a valid profile name (got ${JSON.stringify(String(pin.raw))})`,
      );
    }
    const profile = ownValue(providerEntry.profiles, name);
    if (!profile) {
      // A typo, or a name only a previous overlay revision carried — refused,
      // never resolved through the quality binding instead (§12.3).
      throw new AgentRuntimeAdapterError(
        "unknown-profile",
        `${pin.what} names profile "${name}", which provider "${providerEntry.provider}" does not declare (declared: ${Object.keys(providerEntry.profiles).sort().join(", ")})`,
      );
    }
    return {
      profile,
      source: pin.source,
      sharedWithQualityLevels: QUALITY_LEVELS.filter(
        (other) => providerEntry.qualityBindings[other]?.profileName === name,
      ),
    };
  }

  const { binding, profile } = lookupQualityBinding(catalog, providerEntry.provider, level);
  return {
    profile,
    source: binding.source,
    sharedWithQualityLevels: binding.sharedWithQualityLevels,
  };
}

function resolveSetting(
  setting: Exclude<EnvOverridableSettingKey, "binary">,
  adapter: AgentRuntimeAdapter,
  providerEntry: EffectiveProviderCatalog,
  profile: EffectiveRuntimeProfile,
  env: NodeJS.ProcessEnv,
): ResolvedRuntimeSetting {
  const overridden = envOverrideValue(setting, adapter, providerEntry, env);
  if (overridden !== undefined) return { value: overridden, source: "env" };

  const value = profile.settings[setting];
  if (value !== undefined) {
    return { value, source: profile.settingSources[setting] ?? "catalog-builtin" };
  }
  return {
    source: ownValue(providerEntry.capabilities, setting) !== undefined ? "cli-default" : "not-applicable",
  };
}

function resolveBinary(
  adapter: AgentRuntimeAdapter,
  providerEntry: EffectiveProviderCatalog,
  profile: EffectiveRuntimeProfile,
  env: NodeJS.ProcessEnv,
): ResolvedRuntimeBinary {
  const overridden = envOverrideValue("binary", adapter, providerEntry, env);
  if (overridden !== undefined) return { value: overridden, source: "env" };
  const value = profile.settings.binary;
  if (value !== undefined) {
    return { value, source: profile.settingSources.binary ?? "catalog-builtin" };
  }
  return { value: adapter.defaultBinary, source: "default" };
}

/**
 * §8.1 layer 1, validated per §12.2 `invalid-override`: an env override that
 * is empty, malformed, or fails the same capability check a catalog value
 * gets is refused with the variable named — never lowered to a nearby value
 * the provider would accept (§12.3), and never silently treated as unset.
 */
function envOverrideValue(
  setting: EnvOverridableSettingKey,
  adapter: AgentRuntimeAdapter,
  providerEntry: EffectiveProviderCatalog,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const binding = adapter.envOverrides.find((override) => override.setting === setting);
  if (!binding) return undefined;
  const raw = env[binding.variable];
  if (raw === undefined) return undefined;

  const value = raw.trim();
  if (value.length === 0) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      `${binding.variable} is set but empty; unset it to resolve ${setting} from the catalog, or give it a value`,
    );
  }
  if (hasControlCharacter(value)) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      `${binding.variable} must not contain control characters`,
    );
  }
  // The same shape rules the catalog validator applies to these fields.
  if (setting === "effort" && /\s/.test(value)) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      `${binding.variable} must not contain whitespace (got ${JSON.stringify(value)})`,
    );
  }
  if (setting === "model" && /[^\S ]/.test(value)) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      `${binding.variable} must not contain whitespace other than a plain space (got ${JSON.stringify(value)})`,
    );
  }
  if (setting === "budget" && (!BUDGET_AMOUNT.test(value) || Number(value) <= 0)) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      `${binding.variable} must be a positive USD amount (e.g. "10", "2.50"); got ${JSON.stringify(value)}`,
    );
  }

  const declaration = ownValue(providerEntry.capabilities, setting);
  if (declaration === undefined) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      `provider "${providerEntry.provider}" does not accept the setting "${setting}", so ${binding.variable} cannot override it`,
    );
  }
  if (declaration !== "free" && !declaration.includes(value)) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      `${binding.variable}=${JSON.stringify(value)} is not accepted by provider "${providerEntry.provider}" (declared: ${declaration.join(", ")})`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Invocation planning and the sanitation gate
// ---------------------------------------------------------------------------

/**
 * What a lane hands the boundary. The lane keeps everything the runtime
 * contract does not own — its subcommand and pinned sandbox/permission flags
 * (inside the plan the adapter builds for it), its cwd, its timeout, its
 * isolation bracket, and its runner seam.
 */
export interface AgentInvocationRequest extends ResolveAgentRuntimeInput {
  /**
   * The lane being invoked (§7 "the adapter turns (profile, lane) into an
   * invocation") — an open vocabulary the adapter interprets, so a new lane
   * is not a contract change. An adapter refuses a lane it does not serve.
   */
  readonly lane: string;
  /** The lane's prompt, delivered verbatim on the channel the plan declares. */
  readonly prompt?: string;
}

/**
 * Sanitized invocation data: what to run and how the prompt reaches it. Maps
 * directly onto the existing runner seam —
 * `runner.run(plan.command, [...plan.args], { cwd, stdin: plan.stdin, ... })`
 * — leaving cwd, timeout, maxBuffer, and process-group isolation with the
 * lane, and the child environment with the isolation layer (`env` here is
 * additions only — never a key the isolation layer pins or strips, and never
 * a credential-shaped name).
 */
export interface AgentInvocationPlan {
  /** The executable — always the resolved binary, verified by the gate. */
  readonly command: string;
  /** Sanitized argv after the command; the prompt appears only as declared. */
  readonly args: readonly string[];
  readonly promptDelivery: PromptDelivery;
  /** The prompt, verbatim, for the stdin-bearing deliveries. */
  readonly stdin?: string;
  /**
   * Environment *additions*. Callers hand them to the isolation layer as
   * input when it builds the child environment — never layered over its
   * output — so the isolation layer's pins and strips always win; the gate
   * additionally refuses any addition naming a pinned/stripped key or a
   * credential-shaped variable before a caller ever sees the plan.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Required exactly when a budget resolved (§7 rule 1). */
  readonly budgetApplied?: BudgetApplication;
}

export interface PlannedAgentInvocation {
  readonly resolved: ResolvedAgentRuntime;
  readonly invocation: AgentInvocationPlan;
}

/**
 * The boundary entry point: fail-closed adapter lookup, §8.1 resolution,
 * adapter invocation building, then the sanitation gate. Pure — nothing is
 * spawned — and everything it throws satisfies
 * {@link isAgentRuntimeConfigurationError}.
 */
export function planAgentInvocation(
  registry: AgentRuntimeAdapterRegistry,
  request: AgentInvocationRequest,
): PlannedAgentInvocation {
  if (typeof request.lane !== "string" || request.lane.trim().length === 0) {
    throw new AgentRuntimeContractViolationError("the invocation request names no lane");
  }
  if (request.prompt !== undefined && typeof request.prompt !== "string") {
    throw new AgentRuntimeContractViolationError("the invocation request's prompt must be a string");
  }
  const adapter = registry.adapterForAgent(request.agentId);
  const resolved = resolveAgentRuntime(adapter, request);
  let plan: AgentInvocationPlan;
  try {
    plan = adapter.buildInvocation(request, resolved);
  } catch (err) {
    // A typed refusal crosses the boundary unchanged; anything else is an
    // adapter defect — no invocation was built, so it must classify as a
    // configuration-side error, never as an agent execution failure.
    if (isAgentRuntimeConfigurationError(err)) throw err;
    throw new AgentRuntimeContractViolationError(
      `buildInvocation threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      `provider "${resolved.provider}" adapter`,
      { cause: err },
    );
  }
  assertSanitizedInvocationPlan(plan, request, resolved);
  return { resolved, invocation: freezeInvocationPlan(plan) };
}

const PROTECTED_ENV_KEY_SET = new Set<string>(INVOCATION_PROTECTED_ENV_KEYS);
const ENV_ADDITION_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Credential-shaped addition names, refused wholesale: the isolation layer
 * strips every provider credential and restores only the selected provider's,
 * so an addition whose final segment is key/token/secret/password would
 * re-introduce a credential around that strip — including the provider API
 * keys this provider-neutral module cannot enumerate by name.
 */
const CREDENTIAL_SHAPED_ENV_KEY = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|APIKEY|KEY)$/i;

/**
 * The sanitation gate every plan must pass before a caller may spawn it. A
 * violation is an adapter defect (the resolution engine already validated
 * every operator-supplied value), reported loudly rather than spawned:
 *
 *   - the command is exactly the resolved binary;
 *   - argv elements carry no control characters — except the one element that
 *     IS the prompt, under an argument-bearing delivery, which is exempt
 *     because prompts are legitimately multi-line (it must still carry no NUL);
 *   - the prompt reaches the CLI verbatim on the declared channel, and only
 *     the declared channel shape is present — stdin where a lane requires it
 *     today, so a prompt can never silently migrate into argv or be dropped;
 *   - env entries are additions with well-formed names, never a key the
 *     isolation layer pins or strips ({@link INVOCATION_PROTECTED_ENV_KEYS})
 *     and never a credential-shaped name, so an addition can never restore
 *     what the strip removed;
 *   - a resolved budget is declared `applied` or `not-applicable`, never
 *     dropped in silence (§7 rule 1).
 */
export function assertSanitizedInvocationPlan(
  plan: AgentInvocationPlan,
  request: AgentInvocationRequest,
  resolved: ResolvedAgentRuntime,
): void {
  const path = `provider "${resolved.provider}" invocation plan`;
  const violate = (message: string): never => {
    throw new AgentRuntimeContractViolationError(message, path);
  };

  if (!plan || typeof plan !== "object") violate("the adapter returned no plan");
  if (
    typeof plan.command !== "string" ||
    plan.command.trim().length === 0 ||
    hasControlCharacter(plan.command)
  ) {
    violate("command must be a non-empty string without control characters");
  }
  if (plan.command !== resolved.binary.value) {
    violate(
      `command ${JSON.stringify(plan.command)} is not the resolved binary ${JSON.stringify(resolved.binary.value)}; the plan must run what the resolution reported`,
    );
  }

  if (!PROMPT_DELIVERIES.includes(plan.promptDelivery)) {
    violate(
      `"${String(plan.promptDelivery)}" is not a prompt delivery (expected one of ${PROMPT_DELIVERIES.join(", ")})`,
    );
  }
  if (!Array.isArray(plan.args)) violate("args must be an array");

  const prompt = request.prompt;
  if (prompt !== undefined && prompt.includes(NUL_CHARACTER)) {
    violate("the prompt carries a NUL byte");
  }
  const wantsStdin =
    plan.promptDelivery === "stdin" || plan.promptDelivery === "stdin-and-argument";
  const wantsArgument =
    plan.promptDelivery === "argument" || plan.promptDelivery === "stdin-and-argument";
  if (prompt === undefined) {
    if (plan.promptDelivery !== "none") {
      violate(`promptDelivery is "${plan.promptDelivery}" but the request carries no prompt`);
    }
    if (plan.stdin !== undefined) violate("stdin must be absent when the request carries no prompt");
  } else {
    if (plan.promptDelivery === "none") {
      violate('the request carries a prompt but the plan delivers none ("none")');
    }
    if (wantsStdin && plan.stdin !== prompt) {
      violate("stdin must carry the request's prompt verbatim");
    }
    if (!wantsStdin && plan.stdin !== undefined) {
      violate(`stdin must be absent under the "${plan.promptDelivery}" delivery`);
    }
    if (wantsArgument && !plan.args.includes(prompt)) {
      violate("an argument-bearing delivery must carry the prompt as one argv element, verbatim");
    }
    if (!wantsArgument && plan.args.includes(prompt)) {
      violate(
        `an argv element carries the prompt, but the "${plan.promptDelivery}" delivery declares no argument channel; the prompt may reach the CLI only as declared`,
      );
    }
  }

  for (const arg of plan.args) {
    if (typeof arg !== "string") violate("every argv element must be a string");
    if (arg.includes(NUL_CHARACTER)) violate("an argv element carries a NUL byte");
    const isPromptElement = wantsArgument && prompt !== undefined && arg === prompt;
    if (!isPromptElement && hasControlCharacter(arg)) {
      violate(`argv element ${JSON.stringify(arg)} carries control characters`);
    }
  }

  if (plan.env !== undefined) {
    if (typeof plan.env !== "object" || plan.env === null || Array.isArray(plan.env)) {
      violate("env must be an object of string additions");
    }
    for (const [key, value] of Object.entries(plan.env)) {
      if (!ENV_ADDITION_KEY.test(key)) violate(`"${key}" is not a valid environment variable name`);
      if (PROTECTED_ENV_KEY_SET.has(key)) {
        violate(`the plan may not set "${key}"; that key is owned by the isolation layer`);
      }
      if (CREDENTIAL_SHAPED_ENV_KEY.test(key)) {
        violate(
          `the plan may not set "${key}"; a credential-shaped variable reaches the child only through the isolation layer's strip-and-restore`,
        );
      }
      if (typeof value !== "string" || hasControlCharacter(value)) {
        violate(`the value of env addition "${key}" must be a string without control characters`);
      }
    }
  }

  if (resolved.budget.value !== undefined) {
    if (!BUDGET_APPLICATIONS.includes(plan.budgetApplied as BudgetApplication)) {
      violate(
        'a budget resolved for this run; the plan must declare budgetApplied as "applied" or "not-applicable" (§7 rule 1), never drop it in silence',
      );
    }
  } else if (plan.budgetApplied !== undefined) {
    violate("budgetApplied must be absent when no budget resolved");
  }
}

function freezeInvocationPlan(plan: AgentInvocationPlan): AgentInvocationPlan {
  return Object.freeze({
    command: plan.command,
    args: Object.freeze([...plan.args]) as readonly string[],
    promptDelivery: plan.promptDelivery,
    ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}),
    ...(plan.env !== undefined ? { env: Object.freeze({ ...plan.env }) } : {}),
    ...(plan.budgetApplied !== undefined ? { budgetApplied: plan.budgetApplied } : {}),
  });
}

// ---------------------------------------------------------------------------
// Optional CLI discovery — interpretation only, never a spawn
// ---------------------------------------------------------------------------

export interface AgentRuntimeDiscovery {
  readonly status: AgentRuntimeDiscoveryStatus;
  readonly version?: string;
  /** Provider-specific capability values, opaque strings (§14.3). */
  readonly capabilities?: Readonly<Record<string, string>>;
  /** Bounded operator-facing detail from the probe. */
  readonly detail?: string;
}

/**
 * Interpret a typed probe outcome (the caller ran
 * `<resolved binary> <spec.args>` through its own seam) into a discovery
 * answer, preserving issue #897's determinate/transient split: a host that
 * momentarily could not fork yields `indeterminate`, which callers MUST NOT
 * record as a property of the CLI — only `unavailable` is a determinate
 * answer about the installed binary, and only that answer may fail anything
 * closed. Discovery is informational and never substitutes for the catalog's
 * capability descriptors (§11.3 — no auto-discovery feeds the catalog).
 */
export function interpretDiscoveryProbe(
  spec: AgentRuntimeDiscoverySpec,
  outcome: CliProbeOutcome,
): AgentRuntimeDiscovery {
  if (outcome.ok) {
    let parsed: { version?: string; capabilities?: Record<string, string> } | undefined;
    try {
      parsed = spec.parse(outcome.output);
    } catch {
      return { status: "available", detail: "the version banner could not be parsed" };
    }
    const version = typeof parsed?.version === "string" ? parsed.version.trim() : undefined;
    const capabilities = canonicalCapabilities(parsed?.capabilities);
    const malformedVersion =
      parsed?.version !== undefined &&
      (version === undefined || version.length === 0 || hasControlCharacter(version));
    const malformedCapabilities = parsed?.capabilities !== undefined && capabilities === undefined;
    if (malformedVersion || malformedCapabilities) {
      return { status: "available", detail: "the discovery parser returned malformed data" };
    }
    return {
      status: "available",
      ...(version !== undefined && version.length > 0 ? { version } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    };
  }
  return {
    status: outcome.transient ? "indeterminate" : "unavailable",
    detail: boundedDetail(outcome.output.length > 0 ? outcome.output : outcome.status),
  };
}

function canonicalCapabilities(
  raw: Record<string, string> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const capabilities = emptyDict<string>();
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0 || /\s/.test(key) || hasControlCharacter(key)) return undefined;
    if (typeof value !== "string" || hasControlCharacter(value)) return undefined;
    capabilities[key] = value;
  }
  return Object.freeze(capabilities);
}

function boundedDetail(value: string): string {
  return value.trim().slice(0, MAX_PROBE_DETAIL_CHARS);
}

// ---------------------------------------------------------------------------
// Profile pins (§8.1 layers 2–3) — read wherever they appear
// ---------------------------------------------------------------------------

/**
 * Read the task's profile pin for one agent from
 * {@link RUNTIME_PROFILE_PIN_CONTEXT_KEY}. Absent is the normal case; a
 * malformed pin record is a refusal (`invalid-override`) rather than being
 * skipped — something explicit wrote it, and honoring the binding instead
 * would be the silent fall-through §12.3 forbids. An entry keyed by a
 * different agent id simply does not apply to this run.
 */
export function readRuntimeProfilePin(task: AiTask, agentId: string): string | undefined {
  const raw = task.context[RUNTIME_PROFILE_PIN_CONTEXT_KEY];
  if (raw === undefined || raw === null) return undefined;
  const pins = canonicalizeRuntimeProfilePins(raw, `context.${RUNTIME_PROFILE_PIN_CONTEXT_KEY}`);
  return ownValue(pins, agentId);
}

/**
 * Trusted session config this boundary reads for §8.1 layer 3. The session
 * registry accepts `agentRuntime.pins` since the write-capable lane cutover
 * (issue #911) — the slice that made a pin effective opened the session key
 * alongside, exactly so the key was never accepted-and-silently-ignored
 * (§9.1). The registry shape-checks only; whether a pinned name is declared
 * is this boundary's catalog-aware answer (`unknown-profile`).
 */
export interface AgentRuntimeSessionPinsView {
  readonly agentRuntime?: { readonly pins?: unknown } | undefined;
}

/** The session's pinned profile name for one agent, if any (§8.1 layer 3). */
export function sessionPinnedProfileFor(
  session: AgentRuntimeSessionPinsView | undefined,
  agentId: string,
): string | undefined {
  const raw = session?.agentRuntime?.pins;
  if (raw === undefined || raw === null) return undefined;
  const pins = canonicalizeRuntimeProfilePins(raw, "session.agentRuntime.pins");
  return ownValue(pins, agentId);
}

/**
 * Validate a pin record from any source: agent id → profile name, every entry
 * well-formed, and at least one entry — an empty record was written by an
 * explicit action and "pins nothing" is a mistake to surface, exactly as B2
 * treats an empty quality pin.
 */
function canonicalizeRuntimeProfilePins(raw: unknown, path: string): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      "must be an object mapping agent ids to profile names",
      path,
    );
  }
  const pins = emptyDict<string>();
  const entries = Object.entries(raw as Record<string, unknown>);
  for (const [agentId, value] of entries) {
    if (agentId.trim().length === 0) {
      throw new AgentRuntimeAdapterError("invalid-override", "an entry has an empty agent id", path);
    }
    if (typeof value !== "string" || value.trim().length === 0 || !PROFILE_NAME.test(value.trim())) {
      throw new AgentRuntimeAdapterError(
        "invalid-override",
        `"${agentId}" pins ${JSON.stringify(value)}, which is not a valid profile name`,
        path,
      );
    }
    pins[agentId] = value.trim();
  }
  if (entries.length === 0) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      "pins nothing; add an agent id → profile name entry or remove it",
      path,
    );
  }
  return pins;
}

// ---------------------------------------------------------------------------
// Shared helpers (same discipline as the catalog module)
// ---------------------------------------------------------------------------

/** True when a §12.2 reason string is a member of the closed refusal set. */
export function isAgentProfileRefusalReason(value: unknown): value is AgentProfileRefusalReason {
  return (
    typeof value === "string" &&
    (AGENT_PROFILE_REFUSAL_REASONS as readonly string[]).includes(value)
  );
}

/** A dictionary with no prototype, so document-derived keys cannot alias `Object.prototype`. */
function emptyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (record[key] as T | undefined)
    : undefined;
}

/** True when a string carries a C0/C7F control character. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
