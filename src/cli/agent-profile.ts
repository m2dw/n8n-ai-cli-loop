/**
 * `admin agent-profile list|show|validate` (issue #913): the read-only operator
 * surface docs/agent-runtime-profiles-contract.md §11.4 and §13.4 reserve for
 * slice B4 — "editing a catalog should never require running a task to find out
 * what changed" — plus `admin agent-profile refresh` (issue #914, §11.6): the
 * one command here that may write, and only the overlay file, only with the
 * admin CLI's established `--yes` confirmation, and only after backing the
 * previous file up.
 *
 * The three read-only commands answer three different questions, and none of
 * them writes anything anywhere:
 *
 *   - **`list`** — what does the *effective* catalog say, after the operator
 *     overlay was merged over the built-in one (§9.4)? Every value carries the
 *     layer that supplied it, so "built-in" and "overridden" are distinguishable
 *     at a glance rather than by diffing a file against a compiled-in constant.
 *   - **`show <agent> [--quality <level>]`** — which concrete model, effort,
 *     budget, and binary would a run of that agent resolve? All four quality
 *     levels are reported with their bound profile *and* the settings the §8.1
 *     ladder resolves for them, so the shared bindings §6.3 permits are visible
 *     as the declared configuration they are rather than as a surprise in a
 *     run's audit record.
 *   - **`validate`** — would the current (or a candidate) catalog actually
 *     resolve here, for every agent and every level, under this environment and
 *     this session's pins? This is the check that turns a `catalog-invalid`,
 *     `unknown-profile`, or `invalid-override` refusal from a phase failure
 *     mid-run into a message the operator reads before spending a token.
 *
 * Three boundaries this module keeps:
 *
 *   1. **It re-derives nothing.** The catalog gate (`agent-profile-catalog.ts`),
 *      the §8.1 resolution engine and the adapter's own pre-invocation gate
 *      (both `agent-runtime-adapter.ts`, reached through `planAgentInvocation`
 *      exactly as a run reaches them), and the fail-closed provider registry
 *      (`handlers/agent-runtime.ts`) are the same ones a phase run goes through,
 *      so what these commands print is what a run would resolve — and a
 *      configuration reported as valid here is one that builds an invocation,
 *      not merely one that resolves. Nothing is spawned: planning is pure, and
 *      the plan is discarded. What a *task* asks for (its persisted quality
 *      snapshot and its task-level pin, §8.1 layer 2 / §8.2 layer 1) is out of
 *      scope: these commands address a catalog and a session, never one task.
 *   2. **Capability discovery is never a verdict** (§7.1, §11.3). `--probe`
 *      runs each provider's declared version probe and reports `available`,
 *      `unavailable`, or `indeterminate` in a section of its own; a CLI that is
 *      missing or could not be probed never makes a profile invalid, and no
 *      discovered value is ever checked against the catalog.
 *   3. **No secret and no environment is printed.** A break-glass variable
 *      contributes the *source* `env` and its resolved setting (a model name, an
 *      effort, a budget, a binary — never a credential), exactly as §13.2's
 *      record does; nothing here reads or reports any other variable.
 */

import type {
  AgentProfileCatalogDocument,
  AgentProfileRefusalReason,
  AgentProfilesPathResolution,
  AgentProfilesPathSource,
  CapabilityDeclaration,
  CatalogSource,
  CatalogValueSource,
  EffectiveAgentProfileCatalog,
  EffectiveProviderCatalog,
  QualityLevel,
} from "../core/agent-profile-catalog.js";
import {
  AGENT_PROFILES_FILENAME,
  AgentProfileCatalogError,
  QUALITY_LEVELS,
  buildEffectiveAgentProfileCatalog,
  loadAgentProfileCatalog,
  parseAgentProfileCatalogDocument,
  providerCatalogFor,
  resolveAgentProfilesPath,
} from "../core/agent-profile-catalog.js";
import type {
  AgentProfileModelInventorySource,
  AgentProfileRefreshChange,
  AgentProfileRefreshDiscoveryFacts,
  AgentProfileRefreshDisposition,
  AgentProfileRefreshFindingKind,
  AgentProfileRefreshModelListing,
} from "../core/agent-profile-refresh.js";
import { planAgentProfileRefresh } from "../core/agent-profile-refresh.js";
import type { AntigravityModelDiscovery } from "../core/antigravity-runtime-adapter.js";
import {
  ANTIGRAVITY_MODELS_PROBE,
  ANTIGRAVITY_RUNTIME_ADAPTER,
  interpretAntigravityModelsProbe,
} from "../core/antigravity-runtime-adapter.js";
import { DEFAULT_REQUESTED_QUALITY, isQualityLevel, resolveRequestedQuality } from "../core/agent-quality.js";
import type { EffectiveQuality } from "../core/agent-quality.js";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeAdapterRegistry,
  AgentRuntimeDiscovery,
  ResolvedAgentRuntime,
  ResolvedRuntimeSetting,
  RuntimeProfileSource,
  RuntimeSettingSource,
} from "../core/agent-runtime-adapter.js";
import {
  interpretDiscoveryProbe,
  isAgentProfileRefusalReason,
  isAgentRuntimeConfigurationError,
  planAgentInvocation,
  sessionPinnedProfileFor,
} from "../core/agent-runtime-adapter.js";
import type { ResolvedSession } from "../core/session.js";
import type { AgentId } from "../core/task.js";
import { createAgentRuntimeRegistry } from "../handlers/agent-runtime.js";
import { probe, spawnEnv } from "../handlers/command-runner.js";
import { describeUnresolvedSessionId, JsonSessionRegistry } from "../registries/json-session-registry.js";
import { parseCommonOptions, resolveSessionSelector } from "./admin-command.js";
import type { OutputMode } from "./cli-io.js";
import { die, report } from "./cli-io.js";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { isAbsolute, resolve as resolvePath } from "path";

/**
 * The agent ids these commands enumerate. Spelled as a total map over
 * {@link AgentId} rather than as an array so adding an agent is a compile error
 * here — an agent silently missing from `list` and `validate` is exactly the
 * unchecked gap this surface exists to close.
 */
const KNOWN_AGENTS: Readonly<Record<AgentId, true>> = { claude: true, codex: true, gemini: true };

const AGENT_IDS: readonly AgentId[] = Object.freeze(
  (Object.keys(KNOWN_AGENTS) as AgentId[]).sort(),
);

// ---------------------------------------------------------------------------
// Shared option parsing
// ---------------------------------------------------------------------------

interface CommonAgentProfileArgs {
  sessionId: string | undefined;
  sessionsPath: string;
  args: Record<string, string>;
  flags: Set<string>;
  positionals: string[];
}

/**
 * Parse the options every `agent-profile` command shares. The session selector
 * is optional — the catalog resolves and the built-in defaults apply with no
 * session at all (§9.2) — so it is declared as extra value flags and resolved
 * by hand, the same shape `admin chain list` uses for its optional selector.
 */
function parseAgentProfileArgs(
  argv: string[],
  extra: { booleanFlags?: readonly string[]; valueFlags?: readonly string[]; allowPositionals?: boolean } = {},
): CommonAgentProfileArgs | { error: string } {
  const parsed = parseCommonOptions(argv, {
    session: "none",
    booleanFlags: extra.booleanFlags ?? [],
    valueFlags: ["session-id", "session-ref", "sessions-path", ...(extra.valueFlags ?? [])],
    ...(extra.allowPositionals ? { allowPositionals: true } : {}),
  });
  if ("error" in parsed) return { error: parsed.error };

  let sessionId: string | undefined;
  if (parsed.args["session-id"] !== undefined || parsed.args["session-ref"] !== undefined) {
    const selector = resolveSessionSelector(parsed.args);
    if ("error" in selector) return { error: selector.error };
    sessionId = selector.sessionId;
  }

  return {
    sessionId,
    sessionsPath: parsed.sessionsPath,
    args: parsed.args,
    flags: parsed.flags,
    positionals: parsed.positionals,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The §12.2 reason a refusal carries, when it carries one. */
function refusalReason(err: unknown): AgentProfileRefusalReason | undefined {
  const reason = (err as { reason?: unknown } | undefined)?.reason;
  return isAgentProfileRefusalReason(reason) ? reason : undefined;
}

/**
 * A refusal rendered for an operator: the closed §12.2 reason first, so the
 * message names the rule that fired rather than only the symptom.
 */
function refusalText(err: unknown): string {
  const reason = refusalReason(err);
  return reason === undefined ? errorMessage(err) : `${reason}: ${errorMessage(err)}`;
}

/** Load the session named by `--session-id`/`--session-ref`, or nothing. */
async function loadSession(
  sessionId: string | undefined,
  sessionsPath: string,
): Promise<ResolvedSession | undefined> {
  if (sessionId === undefined) return undefined;
  let registry: JsonSessionRegistry | undefined;
  let registryError: unknown;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    registryError = err;
  }
  if (registry === undefined) {
    die(`Failed to load sessions file (${sessionsPath}): ${errorMessage(registryError)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  return session;
}

/**
 * Read the effective catalog the way a phase run does (§9.1 path resolution,
 * §9.4 overlay merge, §12.1 load-time validation), and die with the §12.2
 * reason when the gate refuses. `list` and `show` have nothing to print without
 * it; `validate` deliberately does NOT come through here — reporting that
 * refusal as a finding is its whole job.
 */
function loadCatalogOrDie(
  session: ResolvedSession | undefined,
  sessionsPath: string,
  env: NodeJS.ProcessEnv,
): EffectiveAgentProfileCatalog {
  try {
    return loadAgentProfileCatalog({
      env,
      sessionsPath,
      ...(session?.agentRuntime?.profilesPath !== undefined
        ? { sessionProfilesPath: session.agentRuntime.profilesPath }
        : {}),
    });
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) die(refusalText(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared views
// ---------------------------------------------------------------------------

interface CatalogView {
  path: string;
  /**
   * Which of §9.1's steps produced the path, or `candidate` for a file named by
   * `--file` — a document being inspected before adoption, which by definition
   * did not come from the resolution order at all.
   */
  pathSource: AgentProfilesPathSource | "candidate";
  source: CatalogSource;
  schemaVersion: number;
  catalogVersion: string | null;
  catalogVersionSource: CatalogValueSource | null;
  digest: string;
}

function catalogView(
  catalog: EffectiveAgentProfileCatalog,
  pathSource: AgentProfilesPathSource | "candidate" = catalog.pathSource,
): CatalogView {
  return {
    path: catalog.catalogPath,
    pathSource,
    source: catalog.catalogSource,
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion ?? null,
    catalogVersionSource: catalog.catalogVersionSource ?? null,
    digest: catalog.digest,
  };
}

/** "built-in" vs "overridden" — the distinction §9.4's merge exists to keep. */
function catalogSourceWord(source: CatalogValueSource): string {
  return source === "catalog-overlay" ? "overridden" : "built-in";
}

function renderCatalogView(view: CatalogView): string[] {
  const origin =
    view.pathSource === "candidate"
      ? `candidate file ${view.path} merged over the built-in catalog`
      : view.source === "file"
        ? `overlay file ${view.path}`
        : `built-in defaults (no catalog file at ${view.path})`;
  const version =
    view.catalogVersion === null
      ? "(none)"
      : `${view.catalogVersion} (${catalogSourceWord(view.catalogVersionSource ?? "catalog-builtin")})`;
  return [
    `Catalog: ${origin}`,
    `  path source: ${view.pathSource}  schema: ${view.schemaVersion}  version: ${version}`,
    `  digest: ${view.digest}`,
  ];
}

function declarationText(declaration: CapabilityDeclaration): string {
  return declaration === "free" ? "free" : `[${declaration.join(", ")}]`;
}

/** How a resolved setting's §13.2 source reads for a person. */
function settingSourceWord(source: RuntimeSettingSource): string {
  switch (source) {
    case "env":
      return "env override";
    case "catalog-overlay":
      return "overridden";
    case "catalog-builtin":
      return "built-in";
    case "cli-default":
      return "provider CLI default";
    case "default":
      return "adapter default";
    case "not-applicable":
      return "not applicable";
  }
}

function profileSourceWord(source: RuntimeProfileSource): string {
  switch (source) {
    case "task-pin":
      return "task pin";
    case "session-config":
      return "session pin";
    case "catalog-overlay":
      return "overridden binding";
    case "catalog-builtin":
      return "built-in binding";
  }
}

/**
 * One resolved setting, rendered. An absent value is rendered as an absence
 * carrying its reason (§13.3) and never as a model named "default": the two
 * absences a provider can produce — "the CLI's own default applies" and "this
 * provider has no such setting" — read differently on purpose.
 */
function renderSetting(label: string, setting: ResolvedRuntimeSetting): string {
  if (setting.value === undefined) {
    const why =
      setting.source === "not-applicable"
        ? "provider declares no such setting"
        : "provider CLI default applies";
    return `${label}: (unset — ${why})`;
  }
  return `${label}: ${setting.value} (${settingSourceWord(setting.source)})`;
}

/**
 * The catalog entry for one provider, or a refusal. Unreachable for the three
 * shipped providers — an overlay cannot delete a built-in provider (§9.4) — but
 * a provider the effective catalog does not declare must refuse rather than be
 * served from another provider's profiles (§12.3), here as much as in a run.
 */
function providerCatalogOrDie(
  catalog: EffectiveAgentProfileCatalog,
  provider: string,
): EffectiveProviderCatalog {
  try {
    return providerCatalogFor(catalog, provider);
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) die(refusalText(err));
    throw err;
  }
}

/** The adapter serving one agent, or the fail-closed refusal that says why not. */
function adapterForAgent(
  registry: AgentRuntimeAdapterRegistry,
  agentId: string,
): { adapter: AgentRuntimeAdapter } | { error: string; reason: AgentProfileRefusalReason | undefined } {
  try {
    return { adapter: registry.adapterForAgent(agentId) };
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) {
      return { error: errorMessage(err), reason: refusalReason(err) };
    }
    throw err;
  }
}

/**
 * The lane every provider's adapter serves and that owns no run-supplied lane
 * input (no base branch, no output path, no context-mode form), so planning it
 * exercises the adapter's own value checks and nothing a *run* would have
 * contributed. It is a stand-in for "would this configuration build an
 * invocation at all", not a claim about which lane an agent runs.
 */
const PREFLIGHT_LANE = "implementation";

/**
 * The placeholder prompt the preflight plan carries, mirroring the prompt-free
 * argv preview `handlers/agent-runtime.ts` builds: one Antigravity lane shape
 * has no promptless invocation (`--print` must have a value), and adapters
 * never branch on prompt content, so a stand-in plans exactly the argv a real
 * prompt would ride with. Nothing is spawned and the plan is discarded.
 */
const PREFLIGHT_PROMPT = "[agent-profile preflight]";

/**
 * Resolve one (agent, level) pair through the same §8.1 ladder a run uses, and
 * then through the same adapter gate. The synthetic quality request carries the
 * level and nothing else: which level a *task* would ask for is §8.2's answer,
 * and these commands address no task — the level is the operator's question,
 * stated on the command line or defaulted from the session.
 *
 * The plan goes through `planAgentInvocation` rather than `resolveAgentRuntime`
 * alone because §8.1 resolution is only the first of §12.1's two pre-invocation
 * gates. The adapter's own checks — a value the CLI would parse as another flag
 * (`CLAUDE_MODEL=--help`), a budget that is not a USD amount, a provider option
 * the provider has no invocation for — fire in `buildInvocation`, and a
 * pre-adoption check that skipped them would report `ok` for a configuration the
 * very next run refuses as `unsupported-value`. Planning is pure: it spawns
 * nothing, so the plan itself is thrown away and only its refusal matters.
 */
function resolveLevel(
  registry: AgentRuntimeAdapterRegistry,
  input: {
    agentId: string;
    level: QualityLevel;
    catalog: EffectiveAgentProfileCatalog;
    env: NodeJS.ProcessEnv;
    sessionPinnedProfile: string | undefined;
  },
): { resolved: ResolvedAgentRuntime } | { error: string; reason: AgentProfileRefusalReason | undefined } {
  // Only `quality.quality` reaches the ladder; the request beside it exists so
  // the shape is the one every run passes, not a second entry point.
  const quality: EffectiveQuality = {
    quality: input.level,
    source: "default",
    requested: { quality: input.level, source: "default" },
  };
  try {
    const planned = planAgentInvocation(registry, {
      agentId: input.agentId,
      lane: PREFLIGHT_LANE,
      prompt: PREFLIGHT_PROMPT,
      quality,
      catalog: input.catalog,
      env: input.env,
      ...(input.sessionPinnedProfile !== undefined
        ? { sessionPinnedProfile: input.sessionPinnedProfile }
        : {}),
    });
    return { resolved: planned.resolved };
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) {
      return { error: errorMessage(err), reason: refusalReason(err) };
    }
    throw err;
  }
}

/**
 * The session's pin for one agent (§8.1 layer 3). A malformed pin record is a
 * refusal rather than an absence — something explicit wrote it — so the caller
 * gets the message instead of a silently unpinned resolution.
 */
function sessionPin(
  session: ResolvedSession | undefined,
  agentId: string,
): { profileName: string | undefined } | { error: string; reason: AgentProfileRefusalReason | undefined } {
  try {
    return { profileName: sessionPinnedProfileFor(session, agentId) };
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) {
      return { error: errorMessage(err), reason: refusalReason(err) };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// `admin agent-profile list`
// ---------------------------------------------------------------------------

interface SettingEntry {
  setting: string;
  value: string;
  source: CatalogValueSource;
}

interface ProfileEntry {
  name: string;
  source: CatalogValueSource;
  /** The quality levels this provider binds to this profile (empty for none). */
  boundLevels: QualityLevel[];
  settings: SettingEntry[];
  providerOptions: SettingEntry[];
  /** Fields an overlay explicitly unset with `null` (§9.4). */
  unsetByOverlay: string[];
}

interface BindingEntry {
  level: QualityLevel;
  profileName: string;
  source: CatalogValueSource;
  sharedWithQualityLevels: QualityLevel[];
}

interface ProviderEntry {
  provider: string;
  source: CatalogValueSource;
  agents: string[];
  adapter: "registered" | "missing";
  defaultBinary: string | null;
  envOverrides: Array<{ variable: string; setting: string; active: boolean }>;
  capabilities: Array<{ setting: string; declaration: CapabilityDeclaration; source: CatalogValueSource }>;
  profiles: ProfileEntry[];
  qualityBindings: BindingEntry[];
}

interface ListPayload {
  ok: true;
  catalog: CatalogView;
  sessionId: string | null;
  providers: ProviderEntry[];
}

function profileEntries(entry: EffectiveProviderCatalog): ProfileEntry[] {
  return Object.keys(entry.profiles)
    .sort()
    .map((name) => {
      const profile = entry.profiles[name];
      const settings: SettingEntry[] = [];
      for (const setting of ["model", "effort", "budget", "binary"] as const) {
        const value = profile.settings[setting];
        if (value === undefined) continue;
        settings.push({
          setting,
          value,
          source: profile.settingSources[setting] ?? "catalog-builtin",
        });
      }
      const options = profile.settings.providerOptions ?? {};
      const providerOptions: SettingEntry[] = Object.keys(options)
        .sort()
        .map((key) => ({
          setting: key,
          value: options[key],
          source: profile.providerOptionSources[key] ?? "catalog-builtin",
        }));
      return {
        name,
        source: profile.source,
        boundLevels: QUALITY_LEVELS.filter(
          (level) => entry.qualityBindings[level]?.profileName === name,
        ),
        settings,
        providerOptions,
        unsetByOverlay: [...profile.unsetByOverlay],
      };
    });
}

function buildProviderEntries(
  catalog: EffectiveAgentProfileCatalog,
  registry: AgentRuntimeAdapterRegistry,
  env: NodeJS.ProcessEnv,
): ProviderEntry[] {
  const agentsByProvider = new Map<string, string[]>();
  for (const agentId of AGENT_IDS) {
    const resolved = adapterForAgent(registry, agentId);
    if ("error" in resolved) continue;
    const list = agentsByProvider.get(resolved.adapter.provider) ?? [];
    list.push(agentId);
    agentsByProvider.set(resolved.adapter.provider, list);
  }

  return Object.keys(catalog.providers)
    .sort()
    .map((provider) => {
      const entry = catalog.providers[provider];
      let adapter: AgentRuntimeAdapter | undefined;
      try {
        adapter = registry.adapterForProvider(provider);
      } catch {
        adapter = undefined;
      }
      return {
        provider,
        source: entry.source,
        agents: agentsByProvider.get(provider) ?? [],
        adapter: adapter === undefined ? ("missing" as const) : ("registered" as const),
        defaultBinary: adapter?.defaultBinary ?? null,
        envOverrides: (adapter?.envOverrides ?? []).map((override) => ({
          variable: override.variable,
          setting: override.setting,
          // Only whether the break-glass variable is set — never its value, and
          // never any other variable (§13.2: an override contributes a source).
          active: env[override.variable] !== undefined,
        })),
        capabilities: Object.keys(entry.capabilities)
          .sort()
          .map((setting) => ({
            setting,
            declaration: entry.capabilities[setting],
            source: entry.capabilitySources[setting] ?? "catalog-builtin",
          })),
        profiles: profileEntries(entry),
        qualityBindings: QUALITY_LEVELS.map((level) => {
          const binding = entry.qualityBindings[level];
          return {
            level,
            profileName: binding.profileName,
            source: binding.source,
            sharedWithQualityLevels: [...binding.sharedWithQualityLevels],
          };
        }),
      };
    });
}

function renderList(payload: ListPayload, mode: OutputMode): string {
  const lines: string[] = [];
  if (!mode.quiet) lines.push(...renderCatalogView(payload.catalog));
  for (const provider of payload.providers) {
    lines.push("");
    const agents = provider.agents.length > 0 ? provider.agents.join(", ") : "(none)";
    const adapter =
      provider.adapter === "registered"
        ? `adapter registered (default binary ${provider.defaultBinary})`
        : "no runtime adapter registered";
    lines.push(
      `${provider.provider} (${catalogSourceWord(provider.source)}) — agents: ${agents} — ${adapter}`,
    );
    lines.push(
      `  capabilities: ${
        provider.capabilities.length === 0
          ? "(none declared)"
          : provider.capabilities
              .map((c) => `${c.setting}=${declarationText(c.declaration)} (${catalogSourceWord(c.source)})`)
              .join(", ")
      }`,
    );
    if (provider.envOverrides.length > 0) {
      lines.push(
        `  break-glass: ${provider.envOverrides
          .map((o) => `${o.variable} -> ${o.setting} (${o.active ? "set" : "unset"})`)
          .join(", ")}`,
      );
    }
    lines.push("  profiles:");
    for (const profile of provider.profiles) {
      const bound = profile.boundLevels.length > 0 ? ` [${profile.boundLevels.join(", ")}]` : " [unbound]";
      const settings = [
        ...profile.settings.map((s) => `${s.setting}=${s.value} (${catalogSourceWord(s.source)})`),
        ...profile.providerOptions.map(
          (s) => `providerOptions.${s.setting}=${s.value} (${catalogSourceWord(s.source)})`,
        ),
      ];
      lines.push(
        `    ${profile.name} (${catalogSourceWord(profile.source)})${bound}  ${
          settings.length === 0 ? "(no settings — provider CLI defaults apply)" : settings.join("  ")
        }`,
      );
      if (profile.unsetByOverlay.length > 0) {
        lines.push(`      unset by overlay: ${profile.unsetByOverlay.join(", ")}`);
      }
    }
    lines.push("  quality bindings:");
    for (const binding of provider.qualityBindings) {
      const shared =
        binding.sharedWithQualityLevels.length > 0
          ? `, shared with ${binding.sharedWithQualityLevels.join(", ")}`
          : "";
      lines.push(
        `    ${binding.level.padEnd(7)} -> ${binding.profileName} (${catalogSourceWord(binding.source)}${shared})`,
      );
    }
  }
  return lines.join("\n");
}

export async function runAgentProfileList(argv: string[]): Promise<void> {
  const parsed = parseAgentProfileArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const env = process.env;
  const session = await loadSession(parsed.sessionId, parsed.sessionsPath);
  const catalog = loadCatalogOrDie(session, parsed.sessionsPath, env);
  const registry = createAgentRuntimeRegistry();

  const payload: ListPayload = {
    ok: true,
    catalog: catalogView(catalog),
    sessionId: parsed.sessionId ?? null,
    providers: buildProviderEntries(catalog, registry, env),
  };
  report(payload as unknown as Record<string, unknown>, (mode) => renderList(payload, mode));
}

// ---------------------------------------------------------------------------
// `admin agent-profile show <agent> [--quality <level>]`
// ---------------------------------------------------------------------------

interface ResolvedLevelView {
  profileName: string;
  profileSource: RuntimeProfileSource;
  sharedWithQualityLevels: QualityLevel[];
  model: ResolvedRuntimeSetting;
  effort: ResolvedRuntimeSetting;
  budget: ResolvedRuntimeSetting;
  binary: { value: string; source: RuntimeSettingSource };
  providerOptions: Array<{ key: string; value: string; source: RuntimeSettingSource }>;
}

interface LevelEntry {
  level: QualityLevel;
  selected: boolean;
  binding: BindingEntry;
  resolved: ResolvedLevelView | null;
  refusal: { reason: AgentProfileRefusalReason | null; message: string } | null;
}

interface ShowPayload {
  ok: boolean;
  agent: string;
  provider: string;
  catalog: CatalogView;
  sessionId: string | null;
  /** The level this view treats as selected, and why it was chosen. */
  quality: { level: QualityLevel; source: "option" | "session-config" | "default" };
  sessionPinnedProfile: string | null;
  levels: LevelEntry[];
}

function resolvedLevelView(resolved: ResolvedAgentRuntime): ResolvedLevelView {
  return {
    profileName: resolved.profileName,
    profileSource: resolved.profileSource,
    sharedWithQualityLevels: [...resolved.sharedWithQualityLevels],
    model: resolved.model,
    effort: resolved.effort,
    budget: resolved.budget,
    binary: resolved.binary,
    providerOptions: Object.keys(resolved.providerOptions)
      .sort()
      .map((key) => ({
        key,
        value: resolved.providerOptions[key],
        source: resolved.providerOptionSources[key] ?? "catalog-builtin",
      })),
  };
}

function renderShow(payload: ShowPayload, mode: OutputMode): string {
  const lines: string[] = [];
  if (!mode.quiet) {
    lines.push(
      `Agent ${payload.agent} (provider ${payload.provider}) — quality ${payload.quality.level} (${payload.quality.source})`,
    );
    lines.push(...renderCatalogView(payload.catalog));
    if (payload.sessionId !== null) {
      lines.push(
        `  session: ${payload.sessionId}  pinned profile: ${payload.sessionPinnedProfile ?? "(none)"}`,
      );
    }
  }
  for (const entry of payload.levels) {
    lines.push("");
    const shared =
      entry.binding.sharedWithQualityLevels.length > 0
        ? `, shared with ${entry.binding.sharedWithQualityLevels.join(", ")}`
        : "";
    lines.push(
      `${entry.selected ? "> " : "  "}${entry.level}${entry.selected ? " (selected)" : ""} — binds ${entry.binding.profileName} (${catalogSourceWord(entry.binding.source)}${shared})`,
    );
    if (entry.refusal !== null) {
      const reason = entry.refusal.reason === null ? "" : `[${entry.refusal.reason}] `;
      lines.push(`    refused: ${reason}${entry.refusal.message}`);
      continue;
    }
    const resolved = entry.resolved;
    if (resolved === null) continue;
    lines.push(`    profile: ${resolved.profileName} (${profileSourceWord(resolved.profileSource)})`);
    lines.push(`    ${renderSetting("model", resolved.model)}`);
    lines.push(`    ${renderSetting("effort", resolved.effort)}`);
    lines.push(`    ${renderSetting("budget (USD)", resolved.budget)}`);
    lines.push(`    binary: ${resolved.binary.value} (${settingSourceWord(resolved.binary.source)})`);
    if (resolved.providerOptions.length > 0) {
      lines.push(
        `    providerOptions: ${resolved.providerOptions
          .map((o) => `${o.key}=${o.value} (${settingSourceWord(o.source)})`)
          .join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

export async function runAgentProfileShow(argv: string[]): Promise<void> {
  const parsed = parseAgentProfileArgs(argv, { valueFlags: ["quality"], allowPositionals: true });
  if ("error" in parsed) die(parsed.error);
  if (parsed.positionals.length === 0) {
    die(`agent is required, e.g. admin agent-profile show claude (known agents: ${AGENT_IDS.join(", ")})`);
  }
  if (parsed.positionals.length > 1) die(`Unexpected argument: ${parsed.positionals[1]}`);
  const agentId = parsed.positionals[0];

  const rawQuality = parsed.args["quality"];
  let requestedQuality: QualityLevel | undefined;
  if (rawQuality !== undefined) {
    if (!isQualityLevel(rawQuality)) {
      die(`--quality must be one of: ${QUALITY_LEVELS.join(", ")}, got: ${rawQuality}`);
    }
    requestedQuality = rawQuality;
  }

  const env = process.env;
  const session = await loadSession(parsed.sessionId, parsed.sessionsPath);
  const catalog = loadCatalogOrDie(session, parsed.sessionsPath, env);
  const registry = createAgentRuntimeRegistry();

  const adapter = adapterForAgent(registry, agentId);
  if ("error" in adapter) {
    die(adapter.reason === undefined ? adapter.error : `${adapter.reason}: ${adapter.error}`);
  }

  // Which level a run would ask for absent any label, in this session (§8.2
  // layers 4–5). An explicit `--quality` states the question directly and wins.
  const sessionDefault = resolveSessionDefaultQuality(session);
  const selected: { level: QualityLevel; source: "option" | "session-config" | "default" } =
    requestedQuality !== undefined
      ? { level: requestedQuality, source: "option" }
      : sessionDefault;

  const pin = sessionPin(session, agentId);
  if ("error" in pin) die(`${pin.reason ?? "invalid-override"}: ${pin.error}`);

  const providerEntry = providerCatalogOrDie(catalog, adapter.adapter.provider);
  const levels: LevelEntry[] = QUALITY_LEVELS.map((level) => {
    const binding = providerEntry.qualityBindings[level];
    const outcome = resolveLevel(registry, {
      agentId,
      level,
      catalog,
      env,
      sessionPinnedProfile: pin.profileName,
    });
    return {
      level,
      selected: level === selected.level,
      binding: {
        level,
        profileName: binding.profileName,
        source: binding.source,
        sharedWithQualityLevels: [...binding.sharedWithQualityLevels],
      },
      resolved: "error" in outcome ? null : resolvedLevelView(outcome.resolved),
      refusal:
        "error" in outcome ? { reason: outcome.reason ?? null, message: outcome.error } : null,
    };
  });

  const payload: ShowPayload = {
    ok: levels.every((entry) => entry.refusal === null),
    agent: agentId,
    provider: adapter.adapter.provider,
    catalog: catalogView(catalog),
    sessionId: parsed.sessionId ?? null,
    quality: selected,
    sessionPinnedProfile: pin.profileName ?? null,
    levels,
  };
  report(payload as unknown as Record<string, unknown>, (mode) => renderShow(payload, mode));
  if (!payload.ok) process.exitCode = 1;
}

/**
 * The quality request a run of this session would carry with no labels and no
 * task pin: `session.agentRuntime.defaultQuality` when set, otherwise the
 * built-in `normal` (§8.2 layers 4–5). Both phase classes agree absent labels,
 * so one answer covers the pair.
 */
function resolveSessionDefaultQuality(
  session: ResolvedSession | undefined,
): { level: QualityLevel; source: "session-config" | "default" } {
  try {
    const resolved = resolveRequestedQuality({ session, now: new Date().toISOString() });
    return resolved.implementation.source === "session-config"
      ? { level: resolved.implementation.quality, source: "session-config" }
      : { level: resolved.implementation.quality, source: "default" };
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) die(refusalText(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// `admin agent-profile validate`
// ---------------------------------------------------------------------------

interface Finding {
  severity: "error" | "warning";
  scope: "catalog" | "provider" | "agent" | "session";
  target: string;
  reason: AgentProfileRefusalReason | null;
  message: string;
}

interface DiscoveryEntry {
  provider: string;
  binary: string;
  status: AgentRuntimeDiscovery["status"];
  version: string | null;
  detail: string | null;
}

interface ValidatePayload {
  ok: boolean;
  /** True when `--file` named a candidate rather than the configured catalog. */
  candidate: boolean;
  catalog: CatalogView | null;
  sessionId: string | null;
  defaultQuality: { level: QualityLevel; source: "session-config" | "default" } | null;
  checked: {
    providers: number;
    profiles: number;
    bindings: number;
    agents: string[];
  };
  findings: Finding[];
  capabilityDiscovery: { probed: boolean; results: DiscoveryEntry[] };
}

/**
 * Read a candidate catalog named by `--file` and merge it exactly as the loader
 * would (§9.4), so "does this file work" is answered against the same effective
 * document a run would build from it. `--file` bypasses §9.1's path resolution
 * on purpose: the point is to inspect a file BEFORE adopting it, which is
 * precisely the case where it is not yet the configured one.
 */
function loadCandidateCatalog(path: string): EffectiveAgentProfileCatalog {
  // A relative `--file` is resolved against the working directory the operator
  // typed it in, which is safe here for the reason §9.1 refuses a relative
  // *configured* path: this one is not stored anywhere and names a file for
  // exactly one invocation.
  const absolute = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
  let contents: string;
  try {
    contents = readFileSync(absolute, "utf8");
  } catch (err) {
    throw new AgentProfileCatalogError(
      "catalog-unreadable",
      `cannot read the candidate catalog (${(err as NodeJS.ErrnoException).code ?? errorMessage(err)})`,
      absolute,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (err) {
    throw new AgentProfileCatalogError(
      "catalog-unreadable",
      `the candidate catalog is not valid JSON (${errorMessage(err)})`,
      absolute,
    );
  }
  const document = parseAgentProfileCatalogDocument(parsed, absolute);
  return buildEffectiveAgentProfileCatalog(document, { catalogPath: absolute });
}

function renderValidate(payload: ValidatePayload, mode: OutputMode): string {
  const lines: string[] = [];
  const errors = payload.findings.filter((f) => f.severity === "error").length;
  const warnings = payload.findings.length - errors;
  const headline = payload.ok
    ? `Agent profile catalog: OK${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.`
    : `Agent profile catalog: ${errors} error${errors === 1 ? "" : "s"}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`;
  lines.push(headline);
  if (payload.catalog !== null && !mode.quiet) lines.push(...renderCatalogView(payload.catalog));
  if (!mode.quiet) {
    lines.push(
      `  checked: ${payload.checked.providers} provider(s), ${payload.checked.profiles} profile(s), ${payload.checked.bindings} binding(s), agents ${
        payload.checked.agents.length > 0 ? payload.checked.agents.join(", ") : "(none)"
      }`,
    );
    if (payload.defaultQuality !== null) {
      lines.push(
        `  default quality: ${payload.defaultQuality.level} (${payload.defaultQuality.source})`,
      );
    }
  }
  for (const finding of payload.findings) {
    const reason = finding.reason === null ? "" : `[${finding.reason}] `;
    lines.push(`  ${finding.severity}: ${reason}${finding.target}: ${finding.message}`);
  }
  // Capability discovery is reported apart from the findings above and never
  // contributes to the verdict (§7.1, §11.3): a CLI that is missing, or that
  // this host could not probe right now, says nothing about whether a profile
  // is valid.
  if (!payload.capabilityDiscovery.probed) {
    lines.push("  capability discovery: not probed (pass --probe to run each provider's version probe)");
  } else if (payload.capabilityDiscovery.results.length === 0) {
    lines.push("  capability discovery: no binary resolved to probe");
  } else {
    lines.push("  capability discovery (informational — never a verdict on a profile):");
    for (const entry of payload.capabilityDiscovery.results) {
      const version = entry.version !== null ? ` version ${entry.version}` : "";
      const detail = entry.detail !== null ? ` — ${entry.detail}` : "";
      lines.push(`    ${entry.provider}: ${entry.binary} ${entry.status}${version}${detail}`);
    }
  }
  return lines.join("\n");
}

export async function runAgentProfileValidate(argv: string[]): Promise<void> {
  const parsed = parseAgentProfileArgs(argv, { booleanFlags: ["probe"], valueFlags: ["file"] });
  if ("error" in parsed) die(parsed.error);

  const env = process.env;
  const session = await loadSession(parsed.sessionId, parsed.sessionsPath);
  const registry = createAgentRuntimeRegistry();
  const candidatePath = parsed.args["file"];
  const findings: Finding[] = [];

  let catalog: EffectiveAgentProfileCatalog | undefined;
  try {
    catalog =
      candidatePath !== undefined
        ? loadCandidateCatalog(candidatePath)
        : loadAgentProfileCatalog({
            env,
            sessionsPath: parsed.sessionsPath,
            ...(session?.agentRuntime?.profilesPath !== undefined
              ? { sessionProfilesPath: session.agentRuntime.profilesPath }
              : {}),
          });
  } catch (err) {
    if (!isAgentRuntimeConfigurationError(err)) throw err;
    findings.push({
      severity: "error",
      scope: "catalog",
      target:
        (err as { path?: string }).path ?? candidatePath ?? AGENT_PROFILES_FILENAME,
      reason: refusalReason(err) ?? null,
      message: errorMessage(err),
    });
  }

  let defaultQuality: ValidatePayload["defaultQuality"] = null;
  if (catalog !== undefined) {
    try {
      const resolved = resolveRequestedQuality({ session, now: new Date().toISOString() });
      defaultQuality = {
        level: resolved.implementation.quality,
        source: resolved.implementation.source === "session-config" ? "session-config" : "default",
      };
    } catch (err) {
      if (!isAgentRuntimeConfigurationError(err)) throw err;
      findings.push({
        severity: "error",
        scope: "session",
        target: "session.agentRuntime.defaultQuality",
        reason: refusalReason(err) ?? null,
        message: errorMessage(err),
      });
      defaultQuality = { level: DEFAULT_REQUESTED_QUALITY, source: "default" };
    }
  }

  const discovery: DiscoveryEntry[] = [];
  let providers = 0;
  let profiles = 0;
  let bindings = 0;

  if (catalog !== undefined) {
    for (const provider of Object.keys(catalog.providers).sort()) {
      providers += 1;
      const entry = catalog.providers[provider];
      profiles += Object.keys(entry.profiles).length;
      bindings += QUALITY_LEVELS.filter((level) =>
        Object.prototype.hasOwnProperty.call(entry.qualityBindings, level),
      ).length;
      try {
        registry.adapterForProvider(provider);
      } catch (err) {
        // A provider an overlay added but no adapter serves cannot resolve for
        // any agent. It is a warning rather than an error: the catalog itself is
        // well-formed, and the agents that DO resolve are unaffected.
        findings.push({
          severity: "warning",
          scope: "provider",
          target: `providers.${provider}`,
          reason: refusalReason(err) ?? null,
          message: errorMessage(err),
        });
      }
    }

    // Per agent: the pin it would resolve through, then every level, so an
    // operator learns before a run that (say) CODEX_EFFORT names a tier this
    // provider does not declare. Identical refusals across levels are reported
    // once, naming the levels they affect.
    const binariesByProvider = new Map<string, Set<string>>();
    for (const agentId of AGENT_IDS) {
      const adapter = adapterForAgent(registry, agentId);
      if ("error" in adapter) {
        findings.push({
          severity: "error",
          scope: "agent",
          target: agentId,
          reason: adapter.reason ?? null,
          message: adapter.error,
        });
        continue;
      }
      const pin = sessionPin(session, agentId);
      if ("error" in pin) {
        findings.push({
          severity: "error",
          scope: "session",
          target: `session.agentRuntime.pins.${agentId}`,
          reason: pin.reason ?? null,
          message: pin.error,
        });
        continue;
      }

      const refusals = new Map<string, { reason: AgentProfileRefusalReason | null; levels: QualityLevel[] }>();
      for (const level of QUALITY_LEVELS) {
        const outcome = resolveLevel(registry, {
          agentId,
          level,
          catalog,
          env,
          sessionPinnedProfile: pin.profileName,
        });
        if ("error" in outcome) {
          const seen = refusals.get(outcome.error);
          if (seen) seen.levels.push(level);
          else refusals.set(outcome.error, { reason: outcome.reason ?? null, levels: [level] });
          continue;
        }
        const set = binariesByProvider.get(adapter.adapter.provider) ?? new Set<string>();
        set.add(outcome.resolved.binary.value);
        binariesByProvider.set(adapter.adapter.provider, set);
      }
      for (const [message, refusal] of refusals) {
        findings.push({
          severity: "error",
          scope: "agent",
          target: `${agentId} (quality ${refusal.levels.join(", ")})`,
          reason: refusal.reason,
          message,
        });
      }
    }

    if (parsed.flags.has("probe")) {
      for (const provider of [...binariesByProvider.keys()].sort()) {
        let adapter: AgentRuntimeAdapter;
        try {
          adapter = registry.adapterForProvider(provider);
        } catch {
          continue;
        }
        const spec = adapter.discovery;
        if (spec === undefined) continue;
        for (const binary of [...(binariesByProvider.get(provider) ?? new Set<string>())].sort()) {
          const answer = interpretDiscoveryProbe(spec, probe(binary, [...spec.args]));
          discovery.push({
            provider,
            binary,
            status: answer.status,
            version: answer.version ?? null,
            detail: answer.detail ?? null,
          });
        }
      }
    }
  }

  const payload: ValidatePayload = {
    ok: findings.every((finding) => finding.severity !== "error"),
    candidate: candidatePath !== undefined,
    catalog:
      catalog === undefined
        ? null
        : catalogView(catalog, candidatePath !== undefined ? "candidate" : catalog.pathSource),
    sessionId: parsed.sessionId ?? null,
    defaultQuality,
    // Nothing was checked against a catalog that would not load, so the agent
    // list stays empty rather than implying three resolutions that never ran.
    checked: {
      providers,
      profiles,
      bindings,
      agents: catalog === undefined ? [] : [...AGENT_IDS],
    },
    findings,
    capabilityDiscovery: { probed: parsed.flags.has("probe"), results: discovery },
  };
  report(payload as unknown as Record<string, unknown>, (mode) => renderValidate(payload, mode));
  if (!payload.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// `admin agent-profile refresh [--offline] [--yes]` (issue #914, §11.6)
// ---------------------------------------------------------------------------

interface RefreshFindingView {
  kind: AgentProfileRefreshFindingKind;
  disposition: AgentProfileRefreshDisposition;
  provider: string;
  target: string;
  message: string;
}

interface RefreshChangeView {
  op: "remove" | "record";
  provider: string | null;
  target: string;
  before: string | null;
  note: string;
}

interface RefreshPayload {
  ok: true;
  catalog: CatalogView;
  sessionId: string | null;
  offline: boolean;
  recommendedCatalogVersion: string;
  updateSource: "live" | "bundled" | "mixed";
  modelInventory: Array<{
    provider: string;
    source: AgentProfileModelInventorySource;
    reason: string;
    models: string[] | null;
  }>;
  capabilityDiscovery: { probed: boolean; results: DiscoveryEntry[] };
  findings: RefreshFindingView[];
  changes: RefreshChangeView[];
  changed: boolean;
  applied: boolean;
  backupPath: string | null;
  refreshRecord: {
    refreshedAt: string;
    updateSource: "live" | "bundled" | "mixed";
    recommendedCatalogVersion: string;
  } | null;
  digest: { current: string; proposed: string | null };
}

/**
 * Read the raw overlay document from the §9.1-resolved path, with exactly the
 * loader's fail-closed semantics: only "no file at the default location" is an
 * absence; a configured path that is missing, unreadable, or unparseable is a
 * `catalog-unreadable` refusal. The refresh needs the raw document — it is the
 * thing being diffed and rewritten — so it cannot go through
 * {@link loadAgentProfileCatalog}, which returns only the merged result. The
 * raw bytes are returned alongside so an apply can verify the file it is
 * about to replace is still the one this read planned against.
 */
function readOverlayDocumentOrDie(
  session: ResolvedSession | undefined,
  sessionsPath: string,
  env: NodeJS.ProcessEnv,
): {
  resolution: AgentProfilesPathResolution;
  overlay: AgentProfileCatalogDocument | undefined;
  contents: string | undefined;
} {
  let resolution: AgentProfilesPathResolution;
  try {
    resolution = resolveAgentProfilesPath({
      env,
      sessionsPath,
      ...(session?.agentRuntime?.profilesPath !== undefined
        ? { sessionProfilesPath: session.agentRuntime.profilesPath }
        : {}),
    });
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) die(refusalText(err));
    throw err;
  }
  let contents: string | undefined;
  try {
    contents = readFileSync(resolution.path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      die(
        `catalog-unreadable: ${resolution.path}: cannot read the agent profile catalog (${code ?? errorMessage(err)})`,
      );
    }
    contents = undefined;
  }
  if (contents === undefined) {
    if (resolution.required) {
      die(
        `catalog-unreadable: ${resolution.path}: the configured agent profile catalog does not exist; remove the setting to use the built-in catalog`,
      );
    }
    return { resolution, overlay: undefined, contents: undefined };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(contents) as unknown;
  } catch (err) {
    die(
      `catalog-unreadable: ${resolution.path}: the agent profile catalog is not valid JSON (${errorMessage(err)})`,
    );
  }
  try {
    return {
      resolution,
      overlay: parseAgentProfileCatalogDocument(parsedJson, resolution.path),
      contents,
    };
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) die(refusalText(err));
    throw err;
  }
}

/**
 * An apply-path refusal composed while the refresh lock is held. The locked
 * region must not call {@link die} — the process sink's exit never runs the
 * `finally` that releases the lock file — so refusals unwind as this marker
 * and `die` fires after the release, with the message used verbatim.
 */
class RefreshApplyRefusal extends Error {}

/** First free path of the shape `<base>`, `<base>-2`, `<base>-3`, ... */
function unusedPath(base: string): string {
  if (!existsSync(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// ACL preservation for the refresh apply (issue #914 review)
//
// Mode bits and uid/gid do not describe access control lists: a 0644 catalog
// with a `user:nobody deny read` entry, or an `allow` entry granting a reader
// its class bits never named, loses exactly that rule when a staged file that
// only copied mode and ownership is renamed over it. Node exposes no ACL API,
// so the platform's own tools carry the entries — read from the catalog under
// the apply lock, re-created on the staged replacement and the backup while
// each is still owner-only, and verified by re-reading the result. The
// inverse leak is closed the same way: a fresh file is not born entry-free —
// a macOS directory ACE carrying `file_inherit`, or a POSIX default ACL,
// lands on every file created in the directory regardless of its open mode —
// so each file is created empty, its inherited entries are removed, the
// catalog's own entries (if any) are re-created, and only then are the
// document's bytes written; at no instant do catalog contents sit behind a
// grant the catalog itself did not carry. Everything
// here fails closed: an ACL that cannot be read, re-created, removed, or
// verified refuses the apply (`catalog-acl`) with the previous catalog
// untouched. On
// platforms with neither ACL model (Windows has its own, out of scope for
// this CLI's catalog files) there is nothing to carry and nothing runs.
// ---------------------------------------------------------------------------

/** Bound on each helper the ACL work spawns, so a hung tool cannot hold the apply lock open. */
const ACL_TOOL_TIMEOUT_MS = 10_000;

/** The catalog's extended ACL, in evaluation order, in the platform tool's own spelling. */
type CatalogAclCapture =
  | { readonly platform: "darwin"; readonly entries: readonly string[] }
  | { readonly platform: "linux"; readonly text: string };

/**
 * Run one ACL helper. Spawn env is passed explicitly for the reason
 * `spawnEnv()` documents (issue #1018): the in-process admin harness hands
 * this module a copy of `process.env`, and a spawn site that relied on the
 * implicit default would resolve tools against the host instead of the
 * caller. `missing` distinguishes "the tool is not installed" (an `ENOENT`
 * spawn failure) from a tool that ran and refused.
 */
function runAclTool(
  cmd: string,
  args: string[],
  input?: string,
): { ok: true; stdout: string } | { ok: false; missing: boolean; reason: string } {
  // `input: ""` for the tools that read nothing keeps stdin a closed pipe
  // rather than this process's own — none of these helpers may wait on a tty.
  const result = spawnSync(cmd, args, {
    env: spawnEnv(),
    encoding: "utf8",
    timeout: ACL_TOOL_TIMEOUT_MS,
    input: input ?? "",
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      missing: code === "ENOENT",
      reason: `${cmd}: ${code ?? errorMessage(result.error)}`,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return {
      ok: false,
      missing: false,
      reason: `${cmd} exited ${result.status ?? `on signal ${result.signal ?? "?"}`}${stderr.length > 0 ? `: ${stderr}` : ""}`,
    };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

/** The indexed ACE lines of macOS `ls -lde` output (` 0: user:nobody deny read`), in order. */
function parseDarwinAclEntries(lsOutput: string): string[] {
  const entries: string[] = [];
  for (const line of lsOutput.split("\n")) {
    const match = /^ *\d+: (.*\S) *$/.exec(line);
    if (match !== null) entries.push(match[1]);
  }
  return entries;
}

/** Whether a `getfacl --omit-header` line is an extended entry rather than a mode-bit base entry. */
function isExtendedPosixAclLine(line: string): boolean {
  if (line.startsWith("default:") || line.startsWith("mask:")) return true;
  return /^(?:user|group):[^:]/.test(line);
}

/** POSIX ACL text normalized for comparison: trimmed entry lines, comments and blanks dropped. */
function normalizePosixAclText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
}

/** Whether `getfacl --omit-header` output holds any extended entry. */
function hasExtendedPosixAclEntries(text: string): boolean {
  return text
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#") && isExtendedPosixAclLine(line));
}

/**
 * Detection-only fallback for a Linux host without the acl tools: GNU `ls`
 * prints a `+` after the mode bits of a file carrying an ACL. `undefined`
 * when even `ls` cannot say — callers treat that as "assume there is one"
 * and fail closed.
 */
function lsSaysPosixAcl(path: string): boolean | undefined {
  const ls = runAclTool("ls", ["-ld", path]);
  if (!ls.ok) return undefined;
  const mode = ls.stdout.trimStart().split(/\s/, 1)[0] ?? "";
  return mode.endsWith("+");
}

/**
 * Read the catalog's extended ACL, or `undefined` when it carries none — the
 * common case, which runs no further command on either file. macOS detection
 * reads the ACE lines of `ls -lde` directly, deliberately not the `+` suffix
 * of `ls -l`: macOS prints `@` (extended attributes) in preference to `+`, so
 * a catalog carrying both would hide its ACL from that column. Linux reads
 * `getfacl`; a host without the acl tools falls back to GNU `ls`'s `+` mode
 * suffix for detection alone, and refuses only when that detector says there
 * IS an ACL the missing tools cannot carry.
 */
function captureCatalogAcl(path: string): CatalogAclCapture | undefined {
  if (process.platform === "darwin") {
    const listed = runAclTool("/bin/ls", ["-lde", path]);
    if (!listed.ok) {
      throw new RefreshApplyRefusal(
        `catalog-acl: ${path}: cannot read the catalog's access control list (${listed.reason}); nothing was written`,
      );
    }
    const entries = parseDarwinAclEntries(listed.stdout);
    return entries.length > 0 ? { platform: "darwin", entries } : undefined;
  }
  if (process.platform === "linux") {
    const listed = runAclTool("getfacl", ["--omit-header", path]);
    if (listed.ok) {
      return hasExtendedPosixAclEntries(listed.stdout)
        ? { platform: "linux", text: listed.stdout }
        : undefined;
    }
    if (listed.missing) {
      if (lsSaysPosixAcl(path) === false) return undefined;
      throw new RefreshApplyRefusal(
        `catalog-acl: ${path}: the catalog carries an access control list but getfacl/setfacl are not available to preserve it; nothing was written — install the acl tools or remove the ACL, then re-run`,
      );
    }
    throw new RefreshApplyRefusal(
      `catalog-acl: ${path}: cannot read the catalog's access control list (${listed.reason}); nothing was written`,
    );
  }
  return undefined;
}

/**
 * Remove the ACL entries a just-created file inherited from its directory.
 * An exclusive create with `mode: 0o600` governs only the mode bits: a macOS
 * directory ACE carrying `file_inherit` lands on every file born inside the
 * directory, and a POSIX default ACL does the same on Linux, so the staged
 * replacement and the backup can each open with an `allow` grant the catalog
 * itself never carried — one no later chmod removes, and one nothing restores
 * away when the catalog has no ACL to re-create. Called right after each
 * exclusive create, while the file is still empty: the inherited entries are
 * removed before any document bytes exist for them to expose, and only then
 * are the catalog's own captured entries re-created. Fails closed like the
 * rest of the ACL work: entries that cannot be read or removed refuse the
 * apply (`catalog-acl`) with the previous catalog untouched.
 */
function stripInheritedAcl(path: string): void {
  const refuse = (reason: string): never => {
    throw new RefreshApplyRefusal(
      `catalog-acl: ${path}: cannot remove the access control entries inherited from the directory (${reason}); nothing was written — the previous catalog is untouched`,
    );
  };
  if (process.platform === "darwin") {
    const listed = runAclTool("/bin/ls", ["-lde", path]);
    if (!listed.ok) refuse(listed.reason);
    else if (parseDarwinAclEntries(listed.stdout).length > 0) {
      const cleared = runAclTool("/bin/chmod", ["-N", path]);
      if (!cleared.ok) refuse(cleared.reason);
      const relisted = runAclTool("/bin/ls", ["-lde", path]);
      if (!relisted.ok) refuse(relisted.reason);
      else if (parseDarwinAclEntries(relisted.stdout).length > 0) {
        refuse(
          `entries remain after clearing: [${parseDarwinAclEntries(relisted.stdout).join("; ")}]`,
        );
      }
    }
    return;
  }
  if (process.platform === "linux") {
    const listed = runAclTool("getfacl", ["--omit-header", path]);
    if (listed.ok) {
      if (!hasExtendedPosixAclEntries(listed.stdout)) return;
      const cleared = runAclTool("setfacl", ["-b", path]);
      if (!cleared.ok) refuse(cleared.reason);
      const relisted = runAclTool("getfacl", ["--omit-header", path]);
      if (!relisted.ok) refuse(relisted.reason);
      else if (hasExtendedPosixAclEntries(relisted.stdout)) refuse("entries remain after clearing");
      return;
    }
    if (listed.missing) {
      if (lsSaysPosixAcl(path) === false) return;
      refuse(
        "the file inherited the directory's default ACL but getfacl/setfacl are not available to remove it — install the acl tools or remove the default ACL, then re-run",
      );
    }
    refuse(listed.reason);
  }
}

/**
 * Rewrite a captured macOS ACL entry whose principal `ls -lde` rendered as a
 * bare UUID into a spelling chmod's entry parser accepts, or `undefined` for
 * an entry that needs no rewrite. The lister falls back to the raw uppercase
 * UUID whenever the system cannot translate the principal's UUID back to a
 * name — current macOS does this for plain POSIX principals such as
 * `user:nobody` — but chmod resolves a principal by NAME only, so replaying
 * the displayed string verbatim fails (`Unable to translate ... to a UUID`)
 * and every catalog carrying such an entry wrongly refused the apply. The
 * two Libinfo compatibility namespaces those principals live in carry the
 * POSIX id in their last eight hex digits, so the id is recovered from the
 * UUID itself and the name from the user/group database; chmod then derives
 * the identical UUID from that name again, and the verifying re-read still
 * sees the captured spelling. A UUID outside both namespaces belongs to a
 * directory principal whose record is gone — no name can re-create it, so
 * the caller refuses rather than dropping or reassigning the entry.
 */
function chmodSpellingForDarwinAclEntry(
  entryText: string,
): { ok: true; text: string } | { ok: false; reason: string } | undefined {
  const uuidWho = /^([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}) ((?:allow|deny)\b.*)$/.exec(
    entryText,
  );
  if (uuidWho === null) return undefined;
  const uuid = uuidWho[1].toUpperCase();
  const rest = uuidWho[2];
  const asUser = /^FFFFEEEE-DDDD-CCCC-BBBB-AAAA([0-9A-F]{8})$/.exec(uuid);
  if (asUser !== null) {
    const uid = Number.parseInt(asUser[1], 16);
    const named = runAclTool("/usr/bin/id", ["-un", String(uid)]);
    const name = named.ok ? named.stdout.trim() : "";
    if (name.length === 0) {
      return {
        ok: false,
        reason: `the principal displays as its compatibility UUID but no user record resolves uid ${uid}${named.ok ? "" : ` (${named.reason})`}`,
      };
    }
    return { ok: true, text: `user:${name} ${rest}` };
  }
  const asGroup = /^ABCDEFAB-CDEF-ABCD-EFAB-CDEF([0-9A-F]{8})$/.exec(uuid);
  if (asGroup !== null) {
    const gid = Number.parseInt(asGroup[1], 16);
    const listed = runAclTool("/usr/bin/dscacheutil", ["-q", "group", "-a", "gid", String(gid)]);
    const name = listed.ok ? /^name: (.*\S) *$/m.exec(listed.stdout)?.[1] : undefined;
    if (name === undefined) {
      return {
        ok: false,
        reason: `the principal displays as its compatibility UUID but no group record resolves gid ${gid}${listed.ok ? "" : ` (${listed.reason})`}`,
      };
    }
    return { ok: true, text: `group:${name} ${rest}` };
  }
  return {
    ok: false,
    reason: `the principal displays as UUID ${uuid}, which is outside both POSIX compatibility namespaces and has no resolvable name for chmod to re-create`,
  };
}

/**
 * Re-create the captured ACL on a file the apply just made. Called after the
 * catalog's uid/gid are back in place, after `stripInheritedAcl` left the
 * file with no entries at all, and before the catalog's mode bits go on:
 * a `deny` entry lands before anyone but the owner could read the file at
 * all, and an `allow` entry grants exactly the principals the catalog itself
 * already granted. The result is re-read and compared so a tool that silently
 * dropped or reordered entries refuses the apply instead of finishing it with
 * different access rules.
 */
/**
 * Canonical form of a captured or re-listed macOS ACL entry, for comparison
 * only. Resolving a bare-UUID principal's name touches Directory Services
 * (`id`/`dscacheutil`) — the same lookup `applyCatalogAcl` performs before
 * handing the entry to `chmod` — and that lookup can warm a cache entry
 * `ls -lde` itself consults, flipping its rendering of the SAME principal
 * from the UUID form to the name form (or back) between the original
 * capture and the post-apply re-listing even though the ACL never changed.
 * Comparing raw text across that call is therefore unstable; both sides are
 * routed through this function so a cache-driven spelling flip cannot
 * register as a mismatch and wrongly refuse an apply that actually
 * succeeded.
 */
function canonicalDarwinAclEntry(entry: string): string {
  const inheritedMarker = /(?<= )inherited (?=(?:allow|deny)\b)/;
  const inherited = inheritedMarker.test(entry);
  const displayed = inherited ? entry.replace(inheritedMarker, "") : entry;
  const respelled = chmodSpellingForDarwinAclEntry(displayed);
  const canonical = respelled !== undefined && respelled.ok ? respelled.text : displayed;
  return inherited ? canonical.replace(/\b(allow|deny)\b/, "inherited $1") : canonical;
}

function applyCatalogAcl(path: string, capture: CatalogAclCapture): void {
  const refuse = (reason: string): never => {
    throw new RefreshApplyRefusal(
      `catalog-acl: ${path}: cannot re-create the catalog's access control list (${reason}); nothing was written — the previous catalog keeps its ACL`,
    );
  };
  if (capture.platform === "darwin") {
    // `chmod +a# <index>` inserts at an explicit position, preserving the
    // catalog's evaluation order; the canonicalizing `+a` would not. An entry
    // the catalog inherited from its directory needs one more translation:
    // `ls -lde` spells it `group:everyone inherited allow read`, but chmod
    // accepts no `inherited` token inside an entry (`Unknown tag type`) — the
    // marker is carried by the inherited-entry mode instead, `+ai#` with the
    // token dropped from the entry text. A principal the lister rendered as
    // a bare UUID needs `chmodSpellingForDarwinAclEntry`'s rewrite besides.
    // The verification below compares the captured and re-listed spellings
    // canonicalized through the same rewrite, not raw — see
    // `canonicalDarwinAclEntry`.
    const inheritedMarker = /(?<= )inherited (?=(?:allow|deny)\b)/;
    for (let index = 0; index < capture.entries.length; index += 1) {
      const entry = capture.entries[index];
      const inherited = inheritedMarker.test(entry);
      const displayed = inherited ? entry.replace(inheritedMarker, "") : entry;
      const respelled = chmodSpellingForDarwinAclEntry(displayed);
      if (respelled !== undefined && !respelled.ok) {
        refuse(`entry ${JSON.stringify(entry)}: ${respelled.reason}`);
      }
      const added = runAclTool("/bin/chmod", [
        inherited ? "+ai#" : "+a#",
        String(index),
        respelled !== undefined && respelled.ok ? respelled.text : displayed,
        path,
      ]);
      if (!added.ok) refuse(`entry ${JSON.stringify(entry)}: ${added.reason}`);
    }
    const listed = runAclTool("/bin/ls", ["-lde", path]);
    if (!listed.ok) refuse(listed.reason);
    else {
      const entries = parseDarwinAclEntries(listed.stdout);
      if (
        entries.length !== capture.entries.length ||
        !entries.every(
          (entry, index) =>
            canonicalDarwinAclEntry(entry) === canonicalDarwinAclEntry(capture.entries[index]),
        )
      ) {
        refuse(
          `the re-created entries [${entries.join("; ")}] do not match the catalog's [${capture.entries.join("; ")}]`,
        );
      }
    }
    return;
  }
  const applied = runAclTool("setfacl", ["--set-file=-", path], capture.text);
  if (!applied.ok) refuse(applied.reason);
  const listed = runAclTool("getfacl", ["--omit-header", path]);
  if (!listed.ok) refuse(listed.reason);
  else if (normalizePosixAclText(listed.stdout) !== normalizePosixAclText(capture.text)) {
    refuse("the re-created access control list does not match the catalog's");
  }
}

function renderRefresh(payload: RefreshPayload, mode: OutputMode): string {
  const lines: string[] = [];
  if (payload.applied) {
    lines.push(
      `Agent profile refresh: applied ${payload.changes.length} change(s) to ${payload.catalog.path}.`,
    );
    lines.push(`  backup of the previous file: ${payload.backupPath}`);
    lines.push("  rollback: restore the backup over the catalog path; the next run picks it up.");
  } else if (payload.changed) {
    lines.push(
      `Agent profile refresh: preview — ${payload.changes.length} change(s) proposed (pass --yes to apply).`,
    );
  } else {
    lines.push(
      payload.catalog.source === "builtin"
        ? "Agent profile refresh: no changes — no catalog file is present, so the built-in defaults already apply unchanged."
        : "Agent profile refresh: no changes — every tool-managed value already matches the release recommendation.",
    );
  }
  if (!mode.quiet) {
    lines.push(...renderCatalogView(payload.catalog));
    lines.push(
      `  recommended catalog: ${payload.recommendedCatalogVersion}  comparison source: ${payload.updateSource}${payload.offline ? " (--offline)" : ""}`,
    );
    lines.push("  model inventory:");
    for (const entry of payload.modelInventory) {
      lines.push(`    ${entry.provider}: ${entry.source} — ${entry.reason}`);
    }
  }
  if (!payload.capabilityDiscovery.probed) {
    lines.push("  cli discovery: skipped (--offline)");
  } else if (payload.capabilityDiscovery.results.length === 0) {
    lines.push("  cli discovery: no binary resolved to probe");
  } else {
    lines.push("  cli discovery (informational — never a verdict on a profile):");
    for (const entry of payload.capabilityDiscovery.results) {
      const version = entry.version !== null ? ` version ${entry.version}` : "";
      const detail = entry.detail !== null ? ` — ${entry.detail}` : "";
      lines.push(`    ${entry.provider}: ${entry.binary} ${entry.status}${version}${detail}`);
    }
  }
  if (payload.findings.length > 0) {
    lines.push("  findings:");
    for (const finding of payload.findings) {
      lines.push(`    [${finding.kind}/${finding.disposition}] ${finding.target}: ${finding.message}`);
    }
  }
  if (payload.changes.length > 0) {
    lines.push(payload.applied ? "  applied changes:" : "  proposed changes:");
    for (const change of payload.changes) {
      lines.push(
        change.op === "remove"
          ? `    - remove ${change.target} (was ${change.before ?? "?"}) — ${change.note}`
          : `    - ${change.note}`,
      );
    }
  }
  if (!payload.applied && !payload.changed && payload.findings.length === 0) {
    lines.push("  nothing to do.");
  }
  return lines.join("\n");
}

/**
 * `admin agent-profile refresh` — compare the configured overlay against this
 * release's recommended catalog and the installed provider CLIs, and propose
 * the tool-managed cleanup (§11.6). Non-mutating by default; `--yes` applies
 * the previewed changes after backing up the previous file. The command can
 * never change a resolved setting: the planner enforces digest equality between
 * the current and the proposed effective catalog, so what `--yes` rewrites is
 * provenance and redundancy, never behavior. Nor can it overwrite a concurrent
 * edit: the whole check-and-replace runs under an exclusive lock file that
 * serializes refresh applies, and under that lock — after every staging and
 * backup step, immediately before the replacement — the apply re-reads the
 * file and refuses (`refresh-conflict`) when it no longer holds the bytes the
 * plan was computed from. The replacement and the backup both carry the
 * previous catalog's exact permission bits, ownership, and extended ACL; each
 * starts owner-only and is widened only after the catalog's uid/gid and
 * access control entries are back in place, so neither file is ever readable
 * by a principal the catalog itself did not name — and an ACL that cannot be
 * read or re-created refuses the apply (`catalog-acl`) rather than replacing
 * the catalog with a file that lost it.
 */
export async function runAgentProfileRefresh(argv: string[]): Promise<void> {
  const parsed = parseAgentProfileArgs(argv, { booleanFlags: ["yes", "offline"] });
  if ("error" in parsed) die(parsed.error);

  const env = process.env;
  const offline = parsed.flags.has("offline");
  const session = await loadSession(parsed.sessionId, parsed.sessionsPath);
  const { resolution, overlay, contents: overlayContents } = readOverlayDocumentOrDie(
    session,
    parsed.sessionsPath,
    env,
  );

  // The same load-time gate a run passes: an overlay that does not validate is
  // repaired by hand (with `validate` naming the problem), never refreshed.
  let catalog: EffectiveAgentProfileCatalog;
  try {
    catalog = buildEffectiveAgentProfileCatalog(overlay, {
      catalogPath: resolution.path,
      pathSource: resolution.source,
    });
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) die(refusalText(err));
    throw err;
  }

  const registry = createAgentRuntimeRegistry();
  const discovery: DiscoveryEntry[] = [];
  const facts: Record<string, AgentProfileRefreshDiscoveryFacts> = {};
  const googleProvider = ANTIGRAVITY_RUNTIME_ADAPTER.provider;

  if (offline) {
    facts[googleProvider] = { modelsSkipped: "--offline: live discovery skipped" };
  } else {
    // Which binaries would actually run: the §8.1 ladder's answer per provider,
    // under this environment, asked once per declared profile rather than once
    // per quality level. A profile no binding references is still reachable
    // through a pin, and an inventory keyed only to the bound profiles would
    // never probe a pinned profile's executable and would judge its model
    // against the bundled fallback while the very binary that runs it answers.
    // The pin layer of the same ladder names each profile (the level beside it
    // is inert once a pin decides), so every profile's binary resolves exactly
    // as a pinned run would resolve it. A profile that refuses contributes no
    // binary; refusals themselves are `validate`'s report, not this command's.
    const binariesByProvider = new Map<string, Set<string>>();
    const profileBinariesByProvider = new Map<string, Record<string, string>>();
    for (const agentId of AGENT_IDS) {
      const adapter = adapterForAgent(registry, agentId);
      if ("error" in adapter) continue;
      const provider = adapter.adapter.provider;
      let providerEntry: EffectiveProviderCatalog;
      try {
        providerEntry = providerCatalogFor(catalog, provider);
      } catch {
        continue;
      }
      for (const profileName of Object.keys(providerEntry.profiles).sort()) {
        const outcome = resolveLevel(registry, {
          agentId,
          level: DEFAULT_REQUESTED_QUALITY,
          catalog,
          env,
          sessionPinnedProfile: profileName,
        });
        if ("error" in outcome) continue;
        const set = binariesByProvider.get(provider) ?? new Set<string>();
        set.add(outcome.resolved.binary.value);
        binariesByProvider.set(provider, set);
        const profileBinaries = profileBinariesByProvider.get(provider) ?? {};
        profileBinaries[outcome.resolved.profileName] = outcome.resolved.binary.value;
        profileBinariesByProvider.set(provider, profileBinaries);
      }
    }
    for (const provider of [...binariesByProvider.keys()].sort()) {
      let adapter: AgentRuntimeAdapter;
      try {
        adapter = registry.adapterForProvider(provider);
      } catch {
        continue;
      }
      const binaries = [...(binariesByProvider.get(provider) ?? new Set<string>())].sort();
      const spec = adapter.discovery;
      if (spec !== undefined) {
        for (const binary of binaries) {
          const answer = interpretDiscoveryProbe(spec, probe(binary, [...spec.args]));
          discovery.push({
            provider,
            binary,
            status: answer.status,
            version: answer.version ?? null,
            detail: answer.detail ?? null,
          });
        }
      }
      // The one bounded, non-interactive model listing a shipped provider
      // offers (§7.4). Its own interpreter keeps "could not read the list"
      // distinct from "unavailable", and its own deadline keeps a hung CLI a
      // bounded pause. Every resolved binary is queried once and its answer
      // recorded against its own name — profiles bound to different
      // executables are compared only against the inventory of the binary
      // that would run them, never against another executable's answer. A
      // listing that never arrives degrades that binary's profiles to the
      // bundled catalog with the reason recorded.
      if (provider === googleProvider && binaries.length > 0) {
        const modelsByBinary: Record<string, AgentProfileRefreshModelListing> = {};
        for (const binary of binaries) {
          const answer: AntigravityModelDiscovery = interpretAntigravityModelsProbe(
            probe(binary, [...ANTIGRAVITY_MODELS_PROBE.args], undefined, {
              timeoutMs: ANTIGRAVITY_MODELS_PROBE.timeoutMs,
            }),
          );
          modelsByBinary[binary] = {
            status: answer.status,
            ...(answer.models !== undefined ? { models: [...answer.models] } : {}),
            // The completeness fact rides along with the names: a truncated
            // listing must reach the planner as "not exhaustive", not as a
            // sentence buried in `detail`, or a model listed past the bound
            // would be flagged as removed (issue #914 review).
            ...(answer.truncated === true ? { truncated: true } : {}),
            ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
          };
        }
        facts[provider] = {
          modelsByBinary,
          profileBinaries: profileBinariesByProvider.get(provider) ?? {},
        };
      }
    }
    if (facts[googleProvider] === undefined && !binariesByProvider.has(googleProvider)) {
      facts[googleProvider] = { modelsSkipped: "no binary resolved to probe" };
    }
  }

  const plan = planAgentProfileRefresh({
    overlay,
    discovery: facts,
    now: new Date().toISOString(),
  });

  let applied = false;
  let backupPath: string | null = null;
  // The apply narrows on `overlayContents` too: the planner builds
  // `proposedOverlay` only from a parsed overlay document, and a parsed
  // overlay implies the bytes it was parsed from — checked here rather than
  // asserted, so a planner regression surfaces as "not applied" instead of an
  // undefined write.
  if (
    parsed.flags.has("yes") &&
    plan.changed &&
    plan.proposedOverlay !== undefined &&
    overlayContents !== undefined
  ) {
    // The plan was computed from the bytes read before the discovery probes
    // ran, which leaves a window for a concurrent edit. An apply may only
    // replace the exact document it diffed, so the whole check-and-replace
    // below is one critical section: an exclusive lock file serializes
    // refresh applies (a second refresh refuses rather than queueing), the
    // staging and backup paths are allocated under that lock and created
    // exclusively, and the conflict re-read runs under it too — after every
    // staging and backup step, immediately before the replacement, with no
    // write of this transaction after it — so another refresh can never
    // interleave, and a foreign edit is caught up to the last instant before
    // the rename. An edit landing while the backup was being prepared is
    // included: a re-read taken any earlier would verify stale bytes and let
    // the rename silently overwrite the newer document.
    // The configured path may itself be a symlink to a shared catalog. Every
    // write-side step below — the lock, the stat, the staging and backup
    // files, the re-read, and the final rename — acts on the resolved target,
    // so the apply rewrites the document the reads followed instead of
    // severing the link by renaming a regular file over it, and two refreshes
    // reaching one target through different links contend on one lock. A path
    // that fails to resolve falls through unresolved; the stat inside the
    // critical section turns that into a refusal with the catalog untouched.
    let applyPath = resolution.path;
    try {
      if (lstatSync(resolution.path).isSymbolicLink()) {
        applyPath = realpathSync(resolution.path);
      }
    } catch {
      // Resolution failures are re-encountered and reported just below.
    }
    const lockPath = `${applyPath}.refresh-lock`;
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
        { flag: "wx" },
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        die(
          `refresh-conflict: another agent-profile refresh is already applying to ${resolution.path}; nothing was written — re-run once it finishes, and delete ${lockPath} first only if it was left by an interrupted run`,
        );
      }
      die(
        `failed to apply the refresh: cannot create the lock file ${lockPath} (${code ?? errorMessage(err)}) (the previous catalog is untouched)`,
      );
    }
    const conflictRefusal = () =>
      new RefreshApplyRefusal(
        `refresh-conflict: ${resolution.path} changed while the refresh was being planned; nothing was written — re-run agent-profile refresh against the current file`,
      );
    const bytes = JSON.stringify(plan.proposedOverlay, null, 2) + "\n";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    let failure: string | undefined;
    let stagedPath: string | undefined;
    let backupCreated = false;
    try {
      backupPath = unusedPath(`${applyPath}.bak-${stamp}`);
      stagedPath = unusedPath(`${applyPath}.tmp-${stamp}`);
      // Stage, back up, re-check, then rename: the catalog file is replaced
      // atomically and holds either the old or the new document at every
      // instant. A failure before the rename leaves the previous catalog
      // untouched, never a default location silently falling through to the
      // built-ins mid-write. The staged file is created exclusively with
      // owner-only permissions and then given the catalog's exact mode bits —
      // a chmod, deliberately not an open-mode the umask would mask — so the
      // replacement neither widens nor narrows who can read the catalog.
      // Mode bits alone name classes, not principals: a staged file keeps
      // this process's owner and default group, which would rebind who a
      // group-scoped catalog grants, so a differing uid/gid is put back
      // explicitly and an ownership that cannot be retained refuses the
      // apply instead of completing it with different readers. Ownership
      // goes back before the mode bits — a chown after the chmod could
      // strip a setuid/setgid bit the 0o7777 capture means to keep. And mode
      // bits with ownership still do not describe an access control list, so
      // the catalog's extended ACL entries are captured here and re-created
      // on both files while each is still owner-only: a replacement that
      // dropped a `deny` entry — or an `allow` entry existing readers depend
      // on — would silently change who can read the catalog even though every
      // bit and both ids matched. The staged file and the backup are each
      // created EMPTY for the same reason: `mode: 0o600` governs only the
      // mode bits, and a directory ACE carrying `file_inherit` (or a POSIX
      // default ACL) lands on every file born in the directory — a grant no
      // chmod removes and, when the catalog has no ACL of its own, nothing
      // would restore away. So each file's inherited entries are stripped
      // and its exact intended ACL established first, and the document's
      // bytes are written only after that — never readable, even briefly,
      // under access rules the catalog itself did not carry. An ACL that
      // cannot be read, re-created, or removed refuses the apply
      // (`catalog-acl`) rather than completing it with different access
      // rules.
      let catalogMode: number;
      let catalogUid: number;
      let catalogGid: number;
      try {
        const catalogStat = statSync(applyPath);
        catalogMode = catalogStat.mode & 0o7777;
        catalogUid = catalogStat.uid;
        catalogGid = catalogStat.gid;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === "ENOENT") throw conflictRefusal();
        throw statErr;
      }
      const catalogAcl = captureCatalogAcl(applyPath);
      writeFileSync(stagedPath, "", { flag: "wx", mode: 0o600 });
      const stagedStat = statSync(stagedPath);
      if (stagedStat.uid !== catalogUid || stagedStat.gid !== catalogGid) {
        try {
          chownSync(stagedPath, catalogUid, catalogGid);
        } catch (chownErr) {
          const code = (chownErr as NodeJS.ErrnoException).code;
          throw new RefreshApplyRefusal(
            `catalog-ownership: ${resolution.path}: the replacement cannot retain the catalog's owner and group (uid ${catalogUid}, gid ${catalogGid}: ${code ?? errorMessage(chownErr)}); nothing was written — adjust the catalog's ownership or re-run as a user that can preserve it`,
          );
        }
      }
      stripInheritedAcl(stagedPath);
      if (catalogAcl !== undefined) applyCatalogAcl(stagedPath, catalogAcl);
      // `r+`, not `w`: the empty file the exclusive create made — now carrying
      // its exact intended ACL — must already exist for the bytes to land in.
      writeFileSync(stagedPath, bytes, { flag: "r+" });
      chmodSync(stagedPath, catalogMode);
      // The backup is written, not copied: a copy carries the catalog's mode
      // bits from its first instant under this process's owner and default
      // group, which for a group-scoped catalog grants the contents to a
      // group the catalog never named. So the backup follows the staged
      // file's exact sequence — created empty and exclusively with owner-only
      // permissions, handed the catalog's uid/gid back, stripped of any
      // directory-inherited ACL entries, given the catalog's own entries,
      // handed its contents, and only then the catalog's mode bits —
      // ownership before mode for the same setuid/setgid reason as the
      // staged file above. It holds the bytes the plan was computed from,
      // which the re-read below verifies are still the catalog's before
      // anything replaces them.
      writeFileSync(backupPath, "", { flag: "wx", mode: 0o600 });
      backupCreated = true;
      const backupStat = statSync(backupPath);
      if (backupStat.uid !== catalogUid || backupStat.gid !== catalogGid) {
        try {
          chownSync(backupPath, catalogUid, catalogGid);
        } catch (chownErr) {
          const code = (chownErr as NodeJS.ErrnoException).code;
          throw new RefreshApplyRefusal(
            `catalog-ownership: ${resolution.path}: the backup cannot retain the catalog's owner and group (uid ${catalogUid}, gid ${catalogGid}: ${code ?? errorMessage(chownErr)}); nothing was written — adjust the catalog's ownership or re-run as a user that can preserve it`,
          );
        }
      }
      stripInheritedAcl(backupPath);
      if (catalogAcl !== undefined) applyCatalogAcl(backupPath, catalogAcl);
      writeFileSync(backupPath, overlayContents, { flag: "r+" });
      chmodSync(backupPath, catalogMode);
      // The conflict re-read is the LAST step before the rename, after every
      // staging and backup write: a check taken any earlier — before the
      // backup work in particular — would let an edit landing while the
      // backup was prepared be verified against stale bytes and then
      // silently overwritten, absent from the catalog and the backup alike.
      let liveContents: string | undefined;
      try {
        liveContents = readFileSync(applyPath, "utf8");
      } catch (readErr) {
        const code = (readErr as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw new RefreshApplyRefusal(
            `catalog-unreadable: ${resolution.path}: cannot re-read the agent profile catalog before applying (${code ?? errorMessage(readErr)})`,
          );
        }
        liveContents = undefined;
      }
      if (liveContents === undefined || liveContents !== overlayContents) throw conflictRefusal();
      renameSync(stagedPath, applyPath);
      applied = true;
    } catch (err) {
      failure =
        err instanceof RefreshApplyRefusal
          ? err.message
          : `failed to apply the refresh: ${errorMessage(err)} (the previous catalog is untouched)`;
    } finally {
      if (!applied && stagedPath !== undefined) {
        try {
          unlinkSync(stagedPath);
        } catch {
          // Best-effort cleanup of the staged file; the failure (if any) is the news.
        }
      }
      if (!applied && backupCreated && backupPath !== null) {
        try {
          unlinkSync(backupPath);
        } catch {
          // Best-effort cleanup of the backup; the catalog itself is untouched.
        }
        backupPath = null;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // A lock that cannot be removed surfaces on the next refresh apply.
      }
    }
    if (failure !== undefined) die(failure);
  }

  const changeView = (change: AgentProfileRefreshChange): RefreshChangeView => ({
    op: change.op,
    provider: change.provider ?? null,
    target: change.target,
    before: change.before ?? null,
    note: change.note,
  });

  const payload: RefreshPayload = {
    ok: true,
    catalog: catalogView(catalog),
    sessionId: parsed.sessionId ?? null,
    offline,
    recommendedCatalogVersion: plan.recommendedCatalogVersion,
    updateSource: plan.updateSource,
    modelInventory: plan.providerReports.map((entry) => ({
      provider: entry.provider,
      source: entry.modelInventory.source,
      reason: entry.modelInventory.reason,
      models: entry.modelInventory.models !== undefined ? [...entry.modelInventory.models] : null,
    })),
    capabilityDiscovery: { probed: !offline, results: discovery },
    findings: plan.findings.map((finding) => ({ ...finding })),
    changes: plan.changes.map(changeView),
    changed: plan.changed,
    applied,
    backupPath,
    refreshRecord: plan.refreshRecord !== undefined ? { ...plan.refreshRecord } : null,
    digest: { current: plan.currentDigest, proposed: plan.proposedDigest ?? null },
  };
  report(payload as unknown as Record<string, unknown>, (mode) => renderRefresh(payload, mode));
}
