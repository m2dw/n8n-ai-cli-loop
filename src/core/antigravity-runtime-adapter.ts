// ---------------------------------------------------------------------------
// The Gemini/Antigravity runtime profile adapter (issue #909).
//
// Slice B3 of docs/agent-runtime-profiles-contract.md §14.1 splits into a
// provider-neutral boundary (issue #906, src/core/agent-runtime-adapter.ts) and
// one adapter per provider. This module is the last of those three: the
// `google` entry of the catalog, serving the Antigravity (`agy`) CLI, alongside
// the `anthropic` one issue #907 landed and the `openai` one issue #908 landed.
//
// What it owns, and nothing else:
//
//   - **The provider key and the default binary.** Adapters register under the
//     catalog's provider keys (§3), never under an agent id, so every agent the
//     injected agent→provider mapping places on `google` — today `gemini` — is
//     served by this one adapter.
//   - **The §8.1 layer-1 break-glass variable** this provider honors:
//     `ANTIGRAVITY_BIN`, the one variable §1.2 inventories for it, and the only
//     provider whose inventoried variable names the *binary* rather than a model
//     or an effort. It keeps its meaning and its precedence, and the boundary
//     still validates it against the provider's capability descriptor before any
//     billable run. There is deliberately no model variable and no effort
//     variable: no shipped Antigravity lane reads one (the research lane's model
//     comes from session config, which this contract replaces with a catalog
//     profile), and inventing a break-glass variable here would be this module
//     writing §8.1 policy rather than implementing it.
//   - **The invocation shape** — `<binary> [--model M] [--print-timeout T]
//     --print <operand>`, one order for every lane. `--print` is what puts the
//     CLI in non-interactive mode, and the pinned `agy` build parses it as a
//     flag that MUST have a value, so the operand is part of the shape rather
//     than an optional tail.
//   - **The two prompt transports the shipped lanes use**, and the rule for
//     which lane may ask for which. By default the prompt reaches the CLI on
//     BOTH channels — as the `--print` operand and on stdin — because some `agy`
//     builds read the prompt only from the operand and ignore stdin, so a
//     stdin-only delivery would silently run the phase on no prompt at all. The
//     research lane's repository-evidence loop is the one path that needs the
//     other transport: from its second turn onward the prompt has grown with
//     evidence content and must not reach execve's argument area, so it delivers
//     the prompt on stdin only and satisfies the parser with a fixed,
//     content-free operand.
//   - **Effort as a provider fact, declared once.** The `google` capability
//     descriptor declares no `effort` key at all, because Antigravity folds
//     effort into the model *display name* — "Gemini 3.1 Pro (Low)" is one model
//     string, not a model plus a tier. So this adapter emits no effort flag,
//     requires no effort field, and refuses an effort that somehow resolved
//     rather than dropping it in silence: a value nobody can express is a
//     configuration mistake to surface, and an adapter that quietly ignored one
//     would let an operator believe a tier was applied.
//   - **The `printTimeout` provider option.** The catalog validates that a
//     profile only names options the descriptor declares, but not their values,
//     so the adapter validates this one against the same parser the session
//     registry and the research handler already use (issue #861) before it
//     becomes argv. Any other provider option refuses (`unsupported-setting`)
//     rather than being accepted and ignored.
//   - **A pre-invocation validation pass** over every concrete value (§12.1's
//     resolution-time gate), with the shape rule that fits the value: a model is
//     a display name that legitimately carries plain spaces and parentheses, so
//     it is NOT treated as a single token — only what would stop naming a model
//     at all is refused (empty, control characters, exotic whitespace, or a
//     leading "-" the CLI would parse as another option).
//
// Four properties this module deliberately does NOT have:
//
//   - **It names no model** (§14.3). Every model value arrives as a `string` the
//     catalog already validated against its `"free"` descriptor; the loop keeps
//     no list of Antigravity display names, and a model refresh is a catalog
//     edit. It names no effort value either — there is no effort vocabulary for
//     this provider to name, which is the point.
//   - **It never lets discovery become a gate or a catalog feed** (§11.3).
//     Optional capability discovery through `agy models` is bounded and
//     informational: what it lists is operator-facing detail, never a list a
//     configured model is checked against, and a *discovery* failure is reported
//     in its own vocabulary so it can never be read as "the agent is
//     unavailable" — that determinate answer comes only from the `--version`
//     probe, through the boundary's own {@link interpretDiscoveryProbe}.
//   - **It re-derives nothing** (§7 rule 2). It consults no label, no session
//     block, and no default of its own: the resolved profile, the lane, and the
//     lane's own inputs are its entire input.
//   - **It spawns nothing.** Building an invocation is pure, and so is
//     interpreting a probe outcome the caller obtained. The caller keeps its
//     runner seam, its cwd, its isolation bracket, its restricted environment,
//     and its workspace-settings machinery; a plan is data it hands to those.
//     In particular the `--print-timeout` value here is the CLI's own print-mode
//     deadline, never a runner deadline — the shipped research lane passes the
//     command runner no timeout at all precisely so a runner deadline can never
//     be shorter than this one.
//
// Wiring it up is one call at a composition root:
//
//   createAgentRuntimeAdapterRegistry({
//     adapters: [CLAUDE_RUNTIME_ADAPTER, CODEX_RUNTIME_ADAPTER, ANTIGRAVITY_RUNTIME_ADAPTER],
//     providerForAgent,          // src/handlers/codex-context-mode.ts
//   })
//
// and then `planAgentInvocation(registry, antigravityInvocationRequest({
// agentId, lane, quality, catalog, prompt }, { stdinOnlyPrompt }))`. No lane is
// cut over to that call yet: each lane's cutover carries its own §10.3
// before/after table, and for this provider the difference is already known —
// every built-in `google` profile carries a `printTimeout`, so a lane that
// passes none today (implementation, review, and both content lanes) would gain
// `--print-timeout` at cutover, raising Antigravity's own five-minute print-mode
// default for phases that have always run under it. That is an operator-visible
// change in when a run is cut off, not a mechanical rewrite. Landing this
// adapter therefore changes no invocation.
// ---------------------------------------------------------------------------

import type {
  AgentInvocationPlan,
  AgentInvocationRequest,
  AgentRuntimeAdapter,
  AgentRuntimeDiscovery,
  AgentRuntimeDiscoverySpec,
  AgentRuntimeEnvOverride,
  BudgetApplication,
  ResolvedAgentRuntime,
  RuntimeProfileSource,
  RuntimeSettingSource,
} from "./agent-runtime-adapter.js";
import {
  AgentRuntimeAdapterError,
  AgentRuntimeContractViolationError,
} from "./agent-runtime-adapter.js";
import type { QualityLevel } from "./agent-profile-catalog.js";
import type { EffectiveQualitySource, QualitySource } from "./agent-quality.js";
import { parseAntigravityPrintTimeout } from "./antigravity-print-timeout.js";
import type { CliProbeOutcome } from "./cli-probe.js";
import { MAX_PROBE_DETAIL_CHARS } from "./cli-probe.js";

// ---------------------------------------------------------------------------
// Provider identity and break-glass variables
// ---------------------------------------------------------------------------

/**
 * The catalog provider key this adapter serves. The catalog is keyed by
 * provider, not by agent id (§3), so the `gemini` agent — and any other agent an
 * installation's mapping places on this provider — resolves through this one
 * adapter and one set of profiles.
 */
export const ANTIGRAVITY_PROVIDER = "google";

/**
 * The binary that runs when neither `ANTIGRAVITY_BIN` nor the resolved profile
 * names one — today's `agy` (§1.2). Recorded with source `default` (§13.2).
 */
export const ANTIGRAVITY_DEFAULT_BINARY = "agy";

/**
 * The §8.1 layer-1 binding, unchanged from the chains inventoried in §1.2. This
 * is the one provider whose inventoried break-glass variable names the binary:
 * `ANTIGRAVITY_BIN` already selects the executable on every shipped Antigravity
 * lane, so honoring it here preserves an established operator affordance rather
 * than trusting a new one from the ambient environment. It is still validated
 * against the provider's capability descriptor before it is honored (§12.3 — a
 * break-glass override may replace a value, never widen what the provider
 * accepts), which is also what turns today's `process.env["ANTIGRAVITY_BIN"] ??
 * "agy"` into a refusal when the variable is set but empty, instead of a spawn
 * of the empty string.
 *
 * Precedence, restated so it is documented where it is declared: a variable here
 * outranks a task pin, a session pin, and the quality binding, and it overrides
 * **one field only**.
 *
 * There is deliberately no model variable: §8.1 inventories none for this
 * provider, the model is a profile setting the catalog validates, and adding one
 * here would be this module deciding §8.1's contents.
 */
export const ANTIGRAVITY_ENV_OVERRIDES: readonly AgentRuntimeEnvOverride[] = Object.freeze([
  Object.freeze({ setting: "binary", variable: "ANTIGRAVITY_BIN" } as AgentRuntimeEnvOverride),
]);

// ---------------------------------------------------------------------------
// The invocation shape
// ---------------------------------------------------------------------------

/**
 * The flag that puts the Antigravity CLI in non-interactive print mode, and —
 * on the pinned build — a flag that MUST have a value: invoking it bare fails
 * argument parsing ("flag needs an argument: -print") before the child ever
 * reads stdin.
 */
const PRINT_FLAG = "--print";

/** `--model <display name>`; absent when the profile names no model. */
const MODEL_FLAG = "--model";

/** `--print-timeout <duration>`; absent when the profile carries no option. */
const PRINT_TIMEOUT_FLAG = "--print-timeout";

/**
 * The one provider option this adapter has an invocation for. The catalog's
 * `google` descriptor declares it, so a profile may carry it; the catalog checks
 * the *key* against that descriptor but not the value, which is why the value is
 * validated here before it becomes argv.
 */
export const ANTIGRAVITY_PRINT_TIMEOUT_OPTION = "printTimeout";

/**
 * The fixed, content-free `--print` operand used by the stdin-only transport
 * (issue #813). It exists solely to satisfy a parser that requires `--print` to
 * have a value while the prompt itself arrives on stdin; it is never the prompt,
 * never agent-influenced, and does not grow with turn count or prompt size, so
 * it does not reopen the ARG_MAX risk that transport exists to close. Pinned
 * equal to the research evidence transport's own operand by test rather than
 * imported, so the two cannot drift apart silently.
 */
export const ANTIGRAVITY_PRINT_OPERAND = "-";

// ---------------------------------------------------------------------------
// The lane table
// ---------------------------------------------------------------------------

/**
 * The Antigravity invocation lanes this adapter serves — the shipped paths that
 * invoke `agy` today. An unrecognized lane refuses (§12.3) rather than
 * inheriting a shape nobody declared for it; in particular there is no
 * `conflict_resolution` entry, because no shipped lane invokes Antigravity for
 * it and inventing one here would be this module deciding which agent owns a
 * phase — the assignment profile's decision (§4.2), not the adapter's.
 *
 * Unlike the other two providers, every entry below carries the same invocation
 * shape: `agy` has one non-interactive mode, one model flag, and one print
 * timeout, and none of them varies by lane. The table is still a table — a lane
 * a caller mistypes must refuse rather than resolve, the served set must be
 * readable in one place, and the one property that DOES vary per lane (which
 * prompt transport a lane may ask for) needs somewhere to live.
 */
export const ANTIGRAVITY_LANES = [
  "implementation",
  "review",
  "research",
  "content_draft",
  "content_review",
] as const;

export type AntigravityLane = (typeof ANTIGRAVITY_LANES)[number];

const ANTIGRAVITY_LANE_SET: ReadonlySet<string> = new Set<string>(ANTIGRAVITY_LANES);

/** True when a string names a lane this adapter can build an invocation for. */
export function isAntigravityLane(value: unknown): value is AntigravityLane {
  return typeof value === "string" && ANTIGRAVITY_LANE_SET.has(value);
}

/**
 * One lane's invocation shape. Everything here is a safety or capability
 * property of the lane itself; the resolved profile contributes only the
 * concrete model and print timeout spliced into it.
 */
export interface AntigravityLaneSpec {
  readonly lane: AntigravityLane;
  /**
   * Whether this lane may deliver the prompt on stdin ALONE, satisfying
   * `--print` with {@link ANTIGRAVITY_PRINT_OPERAND}. This is a property of the
   * lane and never of a profile, because getting it wrong is silent: some `agy`
   * builds read the prompt only from the `--print` operand and ignore stdin, so
   * a lane that asked for the stdin-only transport without having been designed
   * for it would run the phase on a one-character prompt and report success.
   * Only the research lane's repository-evidence loop needs it, and only from
   * its second turn onward, where the prompt has grown with evidence content
   * and must not reach execve's argument area.
   */
  readonly acceptsStdinOnlyPrompt: boolean;
  /**
   * Whether this lane can express a per-run budget cap. Every Antigravity lane
   * reports `not-applicable`: the CLI has no budget flag, which is a declared
   * asymmetry (§7 rule 1) recorded in the plan and visible in the audit record,
   * never a budget dropped in silence.
   */
  readonly budget: BudgetApplication;
}

/**
 * Today's Antigravity invocation shapes. Read against the shipped handlers, the
 * argv each produces is unchanged wherever the resolved profile carries the same
 * settings the handler resolves today:
 *
 *   implementation   `--print <prompt>`                       (src/handlers/implementation.ts)
 *   review           `--print <prompt>`                       (src/handlers/review.ts)
 *   research         `[--model M] --print-timeout T --print <prompt>`
 *                                                             (src/handlers/research.ts)
 *   content_draft    `[--model M] --print <prompt>`           (src/handlers/content-draft.ts)
 *   content_review   `[--model M] --print <prompt>`           (src/handlers/content-review.ts)
 *
 * with the one difference this provider's cutover carries: every built-in
 * `google` profile declares a `printTimeout`, so the four lanes that pass none
 * today would gain `--print-timeout` and stop running under Antigravity's own
 * five-minute print-mode default. That is a change in when a run is cut off,
 * visible to an operator, and it belongs to the lane's before/after table
 * (§10.3) rather than to this adapter.
 */
export const ANTIGRAVITY_LANE_SPECS: Readonly<Record<AntigravityLane, AntigravityLaneSpec>> =
  Object.freeze({
    implementation: Object.freeze({
      lane: "implementation",
      acceptsStdinOnlyPrompt: false,
      budget: "not-applicable",
    } as AntigravityLaneSpec),
    review: Object.freeze({
      lane: "review",
      acceptsStdinOnlyPrompt: false,
      budget: "not-applicable",
    } as AntigravityLaneSpec),
    research: Object.freeze({
      lane: "research",
      // The repository-evidence loop (issue #806, §6.3.1) is the one shipped
      // path that keeps a grown prompt out of argv.
      acceptsStdinOnlyPrompt: true,
      budget: "not-applicable",
    } as AntigravityLaneSpec),
    content_draft: Object.freeze({
      lane: "content_draft",
      acceptsStdinOnlyPrompt: false,
      budget: "not-applicable",
    } as AntigravityLaneSpec),
    content_review: Object.freeze({
      lane: "content_review",
      acceptsStdinOnlyPrompt: false,
      budget: "not-applicable",
    } as AntigravityLaneSpec),
  });

// ---------------------------------------------------------------------------
// Lane inputs — what the lane owns and the runtime contract does not
// ---------------------------------------------------------------------------

/**
 * The lane-owned inputs of one Antigravity invocation: values that belong to the
 * run rather than to the runtime profile. Which prompt transport a turn uses is
 * a fact about that turn — the evidence loop's first turn carries the real
 * prompt positionally and its later turns do not — so it can never be a setting
 * a catalog profile carries.
 */
export interface AntigravityLaneInputs {
  /**
   * Deliver the prompt on stdin ONLY, with {@link ANTIGRAVITY_PRINT_OPERAND} as
   * the `--print` operand. Refused on a lane whose spec does not accept it.
   * Absent (the default) means the prompt reaches the CLI on both channels,
   * which is what every shipped Antigravity invocation does today.
   */
  readonly stdinOnlyPrompt?: boolean;
}

/**
 * A boundary invocation request carrying this provider's lane inputs. The
 * boundary passes the request through to the adapter unchanged, so an adapter
 * may widen it; nothing in the common contract reads the extra key.
 */
export interface AntigravityInvocationRequest extends AgentInvocationRequest {
  readonly antigravity?: AntigravityLaneInputs;
}

/**
 * Attach lane inputs to a boundary request. Callers use this rather than an
 * object literal so the widened request is a value of a declared type — passing
 * it to `planAgentInvocation` needs no cast, and a typo in a lane input is a
 * compile error rather than an ignored key.
 */
export function antigravityInvocationRequest(
  request: AgentInvocationRequest,
  inputs: AntigravityLaneInputs,
): AntigravityInvocationRequest {
  return { ...request, antigravity: inputs };
}

// ---------------------------------------------------------------------------
// Pre-invocation validation (§12.1's resolution-time gate)
// ---------------------------------------------------------------------------

/** Where a lane-input defect is reported from, so a message names its origin. */
const CONTRACT_PATH = "antigravity lane inputs";

/**
 * Where an operator has to go to fix a value, phrased from its recorded source
 * (§13.2) so a refusal message points at the file or the variable rather than at
 * the resolution.
 */
function sourceHint(source: RuntimeSettingSource, profileName: string): string {
  switch (source) {
    case "env":
      return "set in the operator environment";
    case "catalog-overlay":
      return `set by profile "${profileName}" in the agent-profiles.json overlay`;
    case "catalog-builtin":
      return `set by the built-in profile "${profileName}"`;
    case "default":
      return "the adapter's compiled-in default";
    default:
      return `resolved for profile "${profileName}"`;
  }
}

/**
 * Validate one concrete value before it becomes argv. The catalog validated it
 * against the provider's capability descriptor at load and the boundary
 * validated any env override at resolution, so what is left is the shape the
 * Antigravity CLI itself needs: present, free of control characters, free of
 * whitespace the flag cannot hold, and not flag-shaped — a value beginning with
 * `-` would be parsed as another option and silently change the invocation.
 *
 * Neither value is a single token, and that is deliberate for the model: an
 * Antigravity model is a *display name* whose effort tier is part of the name
 * ("Gemini 3.1 Pro (Low)"), so refusing a plain space would refuse exactly the
 * values this provider is configured with. A binary may likewise be a path
 * containing a space; the runner spawns argv directly, so nothing is ever
 * shell-split. Only whitespace no single argv element should carry — tabs,
 * newlines — is refused, which restates exactly what the boundary already
 * applies to an env override of the same setting.
 */
function requireCliSafeValue(
  setting: "model" | "binary",
  value: string,
  source: RuntimeSettingSource,
  profileName: string,
): void {
  const where = sourceHint(source, profileName);
  if (value.length === 0) {
    throw new AgentRuntimeAdapterError(
      "unsupported-value",
      `the resolved ${setting} is empty (${where}); give it a value or unset it to let the CLI's own default apply`,
    );
  }
  if (hasControlCharacter(value)) {
    throw new AgentRuntimeAdapterError(
      "unsupported-value",
      `the resolved ${setting} contains control characters (${where})`,
    );
  }
  if (/[^\S ]/.test(value)) {
    throw new AgentRuntimeAdapterError(
      "unsupported-value",
      `the resolved ${setting} ${JSON.stringify(value)} carries whitespace the CLI cannot take in one token (${where})`,
    );
  }
  if (value.startsWith("-")) {
    throw new AgentRuntimeAdapterError(
      "unsupported-value",
      `the resolved ${setting} ${JSON.stringify(value)} starts with "-" (${where}); the CLI would parse it as another option`,
    );
  }
}

/**
 * Resolve the `--print-timeout` value from the profile's provider options, and
 * refuse every option this invocation has no place for.
 *
 * The catalog checks a profile's option KEYS against the provider's descriptor
 * but not their values (§6.1 — `providerOptions` is an open string map), so a
 * malformed duration would otherwise reach argv and fail the CLI's own argument
 * parsing after the phase had already started. It is validated with the same
 * parser the session registry and the research handler use (issue #861), so one
 * duration format is accepted everywhere and a bound applies everywhere.
 */
function resolvePrintTimeout(resolved: ResolvedAgentRuntime): string | undefined {
  const options = resolved.providerOptions ?? {};
  const unsupported = Object.keys(options)
    .filter((key) => key !== ANTIGRAVITY_PRINT_TIMEOUT_OPTION)
    .sort();
  if (unsupported.length > 0) {
    throw new AgentRuntimeAdapterError(
      "unsupported-setting",
      `profile "${resolved.profileName}" carries provider options (${unsupported.join(", ")}) that the Antigravity adapter has no invocation for`,
    );
  }
  const raw: string | undefined = options[ANTIGRAVITY_PRINT_TIMEOUT_OPTION];
  if (raw === undefined) return undefined;
  const source: RuntimeSettingSource =
    resolved.providerOptionSources[ANTIGRAVITY_PRINT_TIMEOUT_OPTION] ?? "catalog-builtin";
  try {
    return parseAntigravityPrintTimeout(raw).raw;
  } catch (err) {
    throw new AgentRuntimeAdapterError(
      "unsupported-value",
      `the resolved ${ANTIGRAVITY_PRINT_TIMEOUT_OPTION} ${JSON.stringify(raw)} ${err instanceof Error ? err.message : String(err)} (${sourceHint(source, resolved.profileName)})`,
    );
  }
}

/**
 * Refuse a reasoning effort rather than dropping it. The `google` descriptor
 * declares no `effort` key, so a resolution normally reports it
 * `not-applicable` and this never fires. It fires when an operator widened the
 * descriptor and set the field — at which point silently emitting nothing would
 * leave them believing a tier was applied. The message says where the tier
 * actually lives for this provider, because "effort is part of the model name"
 * is the fact that makes the setting unnecessary rather than merely unsupported.
 */
function refuseResolvedEffort(resolved: ResolvedAgentRuntime): void {
  const effort = resolved.effort.value;
  if (effort === undefined) return;
  throw new AgentRuntimeAdapterError(
    "unsupported-setting",
    `profile "${resolved.profileName}" resolved a reasoning effort (${JSON.stringify(effort)}, ${sourceHint(resolved.effort.source, resolved.profileName)}), but the Antigravity CLI exposes no effort flag: this provider folds the tier into the model display name, so set it there instead`,
  );
}

// ---------------------------------------------------------------------------
// Discovery — availability, and the separate question of capabilities
// ---------------------------------------------------------------------------

/**
 * How a caller asks the installed Antigravity CLI whether it is there. The
 * caller runs `<resolved binary> --version` through its own probe seam and hands
 * the typed outcome to the boundary's `interpretDiscoveryProbe`, which preserves
 * issue #897's determinate/transient split. **This is the only probe that may
 * answer `unavailable`**: a determinate failure of `--version` is a fact about
 * the installed binary, whereas a failed capability listing is not (see
 * {@link interpretAntigravityModelsProbe}). Nothing here feeds the catalog
 * (§11.3): a version banner is operator-facing detail, never a capability
 * descriptor.
 */
export const ANTIGRAVITY_DISCOVERY: AgentRuntimeDiscoverySpec = Object.freeze({
  args: Object.freeze(["--version"]) as readonly string[],
  parse(stdout: string): { version?: string } {
    const match = /\b\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?\b/.exec(stdout);
    return match ? { version: match[0] } : {};
  },
});

/**
 * How a caller asks the installed CLI which models it offers. Deliberately NOT
 * an {@link AgentRuntimeDiscoverySpec}: the boundary's interpreter maps a
 * determinate probe failure to `unavailable`, and that answer would be wrong
 * here — a build with no `models` subcommand, or one that exits non-zero
 * listing them, is a perfectly available CLI whose capabilities this loop simply
 * could not read. Giving the capability probe its own type, its own interpreter,
 * and its own vocabulary is what makes the two failures impossible to conflate.
 */
export interface AntigravityModelProbeSpec {
  /** argv (after the binary) that lists the available models. */
  readonly args: readonly string[];
  /**
   * The deadline the caller must apply to this probe. Discovery is
   * informational and never a gate, so it must never hold a phase open: a CLI
   * that has not answered within this budget is treated as not answering, which
   * the caller's probe seam reports as a timeout and this module reads as
   * `indeterminate` — a fact about the host at one moment, never about the CLI.
   */
  readonly timeoutMs: number;
}

/**
 * The bound on the capability probe. Ten seconds is far longer than listing
 * local model metadata should take and far shorter than any phase deadline, so
 * a hung CLI costs the run a bounded pause and an `indeterminate` answer rather
 * than the phase.
 */
export const ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS = 10_000;

/** Upper bound on how many listed names are carried, so a chatty CLI cannot flood a record. */
export const ANTIGRAVITY_MAX_DISCOVERED_MODELS = 64;

/** Upper bound on one carried name, for the same reason. */
const MAX_DISCOVERED_MODEL_CHARS = 200;

/**
 * The capability probe: `agy models`, bounded by
 * {@link ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS}. Used "when available" in the
 * literal sense — a caller may run it, and every answer including "could not
 * read it" is a valid outcome that changes no resolution.
 */
export const ANTIGRAVITY_MODELS_PROBE: AntigravityModelProbeSpec = Object.freeze({
  args: Object.freeze(["models"]) as readonly string[],
  timeoutMs: ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS,
});

/**
 * What a capability probe established. Three answers, none of which is a claim
 * about whether the CLI is installed:
 *
 *   - `listed` — the CLI answered and at least one model name was read.
 *   - `undiscovered` — the CLI ran and this loop could not read a list from it:
 *     no `models` subcommand on this build, a non-zero exit, or output with no
 *     names in it. **Not** `unavailable`; that word belongs to the `--version`
 *     probe alone.
 *   - `indeterminate` — a transient host condition (issue #897), including the
 *     probe deadline above. MUST NOT be recorded as a property of the CLI.
 */
export const ANTIGRAVITY_MODEL_DISCOVERY_STATUSES = [
  "listed",
  "undiscovered",
  "indeterminate",
] as const;

export type AntigravityModelDiscoveryStatus =
  (typeof ANTIGRAVITY_MODEL_DISCOVERY_STATUSES)[number];

export interface AntigravityModelDiscovery {
  readonly status: AntigravityModelDiscoveryStatus;
  /**
   * The display names read from the banner, verbatim and opaque (§14.3). These
   * are operator-facing detail ONLY: no configured model is ever checked against
   * them, because the catalog declares `model` as `"free"` and whether a model
   * exists is the CLI's answer at run time (§6.2, §11.3). A list that is stale,
   * partial, or misparsed therefore cannot refuse a run.
   */
  readonly models?: readonly string[];
  /**
   * True when the CLI printed more names than
   * {@link ANTIGRAVITY_MAX_DISCOVERED_MODELS} and `models` is the bounded
   * prefix that was kept. A typed fact, not only a `detail` sentence, because
   * a consumer must be able to act on it: a truncated listing can prove a
   * name present but never absent, so nothing may treat it as exhaustive
   * (issue #914 — a configured model listed past the bound must not be
   * reported as removed).
   */
  readonly truncated?: boolean;
  /** Bounded operator-facing detail from the probe. */
  readonly detail?: string;
}

/**
 * Interpret a typed `agy models` probe outcome (the caller ran
 * `<resolved binary> models` through its own seam, under
 * {@link ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS}).
 *
 * The parse is deliberately forgiving — one trimmed non-blank line per name,
 * bounded in count and length — because it may not refuse anything: an
 * unreadable banner degrades to `undiscovered`, which is the same non-answer as
 * a build with no `models` subcommand, and neither one is allowed to look like
 * an unavailable agent.
 */
export function interpretAntigravityModelsProbe(
  outcome: CliProbeOutcome,
): AntigravityModelDiscovery {
  if (!outcome.ok) {
    return {
      status: outcome.transient ? "indeterminate" : "undiscovered",
      detail: boundedDetail(
        outcome.output.length > 0
          ? outcome.output
          : `${outcome.status} — the CLI listed no models; this says nothing about whether it is installed`,
      ),
    };
  }
  const models: string[] = [];
  let truncated = false;
  for (const line of outcome.output.split("\n")) {
    const name = line.trim();
    if (name.length === 0 || name.length > MAX_DISCOVERED_MODEL_CHARS) continue;
    if (hasControlCharacter(name)) continue;
    if (models.length >= ANTIGRAVITY_MAX_DISCOVERED_MODELS) {
      truncated = true;
      break;
    }
    models.push(name);
  }
  if (models.length === 0) {
    return { status: "undiscovered", detail: "the CLI answered but listed no model names" };
  }
  return {
    status: "listed",
    models: Object.freeze(models) as readonly string[],
    ...(truncated
      ? {
          truncated: true,
          detail: `only the first ${ANTIGRAVITY_MAX_DISCOVERED_MODELS} listed models were kept`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The reported resolution (§13.2)
// ---------------------------------------------------------------------------

/**
 * The operator-facing summary of one resolved Antigravity runtime: what quality
 * was asked for, which profile answered, what will run, and where each value
 * came from (§13.2), plus what a caller's probes established about the installed
 * CLI. An absent model stays absent with its `cli-default` source (§13.3) —
 * never the string "default", and never a value this module invented.
 *
 * The requested quality is carried alongside the concrete values on purpose: a
 * provider whose four levels bind to four profiles with identical settings (as
 * the built-in `google` entry does today) would otherwise leave an operator
 * unable to see that their `quality:maximum` request was honored at all (§6.3).
 */
export interface AntigravityRuntimeDescription {
  readonly provider: string;
  /** The level this run asked for, before any escalation floor was applied. */
  readonly requestedQuality: QualityLevel;
  readonly requestedQualitySource: QualitySource;
  /** The level that actually resolved, after escalation. */
  readonly effectiveQuality: QualityLevel;
  readonly effectiveQualitySource: EffectiveQualitySource;
  readonly profileName: string;
  readonly profileSource: RuntimeProfileSource;
  /** The other levels declared to resolve to the same profile (§6.3). */
  readonly sharedWithQualityLevels: readonly QualityLevel[];
  readonly catalogDigest: string;
  readonly binary: string;
  readonly binarySource: RuntimeSettingSource;
  readonly model?: string;
  readonly modelSource: RuntimeSettingSource;
  readonly printTimeout?: string;
  readonly printTimeoutSource: RuntimeSettingSource;
  /** The installed CLI's version, when the `--version` probe established one. */
  readonly cliVersion?: string;
  /** What the `--version` probe established about the installed CLI, when it ran. */
  readonly cliStatus?: AgentRuntimeDiscovery["status"];
  /** What the `agy models` probe established, when it ran — never an availability claim. */
  readonly modelDiscoveryStatus?: AntigravityModelDiscoveryStatus;
}

export interface DescribeAntigravityRuntimeProbes {
  /** The `--version` answer, from the boundary's `interpretDiscoveryProbe`. */
  readonly discovery?: AgentRuntimeDiscovery;
  /** The `agy models` answer, from {@link interpretAntigravityModelsProbe}. */
  readonly models?: AntigravityModelDiscovery;
}

/**
 * Project a resolution (and any probe answers) into that summary. Pure
 * projection: it adds nothing the resolution did not already decide, which is
 * what keeps the audit record and the operator-facing line the same fact.
 */
export function describeAntigravityRuntime(
  resolved: ResolvedAgentRuntime,
  probes: DescribeAntigravityRuntimeProbes = {},
): AntigravityRuntimeDescription {
  // `indeterminate` is a fact about the host at one moment, not about the CLI,
  // so it contributes a status and never a version.
  const discovery = probes.discovery;
  const version =
    discovery?.status === "available" &&
    typeof discovery.version === "string" &&
    discovery.version.length > 0
      ? discovery.version
      : undefined;
  const printTimeout: string | undefined =
    resolved.providerOptions[ANTIGRAVITY_PRINT_TIMEOUT_OPTION];
  // An absent option means the CLI's own print-mode default applies — recorded
  // as an absence with a source, never as a value this module invented (§13.3).
  const printTimeoutSource: RuntimeSettingSource =
    printTimeout === undefined
      ? "cli-default"
      : (resolved.providerOptionSources[ANTIGRAVITY_PRINT_TIMEOUT_OPTION] ?? "catalog-builtin");
  return Object.freeze({
    provider: resolved.provider,
    requestedQuality: resolved.quality.requested.quality,
    requestedQualitySource: resolved.quality.requested.source,
    effectiveQuality: resolved.quality.quality,
    effectiveQualitySource: resolved.quality.source,
    profileName: resolved.profileName,
    profileSource: resolved.profileSource,
    sharedWithQualityLevels: resolved.sharedWithQualityLevels,
    catalogDigest: resolved.catalogDigest,
    binary: resolved.binary.value,
    binarySource: resolved.binary.source,
    ...(resolved.model.value !== undefined ? { model: resolved.model.value } : {}),
    modelSource: resolved.model.source,
    ...(printTimeout !== undefined ? { printTimeout } : {}),
    printTimeoutSource,
    ...(version !== undefined ? { cliVersion: version } : {}),
    ...(discovery !== undefined ? { cliStatus: discovery.status } : {}),
    ...(probes.models !== undefined ? { modelDiscoveryStatus: probes.models.status } : {}),
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function buildAntigravityInvocation(
  request: AgentInvocationRequest,
  resolved: ResolvedAgentRuntime,
): AgentInvocationPlan {
  const lane = typeof request.lane === "string" ? request.lane.trim() : "";
  if (!isAntigravityLane(lane)) {
    throw new AgentRuntimeAdapterError(
      "unsupported-setting",
      `the Antigravity adapter has no invocation for lane "${lane}" (serves: ${ANTIGRAVITY_LANES.join(", ")})`,
    );
  }
  const spec = ANTIGRAVITY_LANE_SPECS[lane];
  const profileName = resolved.profileName;
  const inputs = (request as AntigravityInvocationRequest).antigravity ?? {};

  // `--print` must have a value, so an invocation with no prompt is not
  // expressible at all — a caller defect rather than unsupported configuration.
  const prompt = request.prompt;
  if (prompt === undefined) {
    throw new AgentRuntimeContractViolationError(
      `the Antigravity "${lane}" lane parses ${PRINT_FLAG} as a flag that must have a value, so an invocation with no prompt cannot be built`,
      CONTRACT_PATH,
    );
  }

  refuseResolvedEffort(resolved);
  requireCliSafeValue("binary", resolved.binary.value, resolved.binary.source, profileName);
  const printTimeout = resolvePrintTimeout(resolved);

  // `--model` and `--print-timeout` precede `--print`, because `--print` takes
  // the next argv element as its value: anything spliced after it would be read
  // as the prompt. That is the whole ordering rule for this provider, and it is
  // the order the shipped research lane already emits.
  const args: string[] = [];
  const model = resolved.model.value;
  if (model !== undefined) {
    requireCliSafeValue("model", model, resolved.model.source, profileName);
    args.push(MODEL_FLAG, model);
  }
  if (printTimeout !== undefined) {
    args.push(PRINT_TIMEOUT_FLAG, printTimeout);
  }
  args.push(PRINT_FLAG);

  if (inputs.stdinOnlyPrompt === true) {
    if (!spec.acceptsStdinOnlyPrompt) {
      throw new AgentRuntimeContractViolationError(
        `the Antigravity "${lane}" lane must deliver its prompt as the ${PRINT_FLAG} operand as well as on stdin; some agy builds ignore stdin, so a stdin-only turn would run this lane on a content-free prompt`,
        CONTRACT_PATH,
      );
    }
    if (prompt === ANTIGRAVITY_PRINT_OPERAND) {
      // Degenerate, but it would otherwise put the prompt in argv under a
      // delivery that declares no argument channel, which the boundary's
      // sanitation gate reports as an adapter defect.
      throw new AgentRuntimeContractViolationError(
        `the prompt is exactly the fixed ${PRINT_FLAG} operand ${JSON.stringify(ANTIGRAVITY_PRINT_OPERAND)}, so the stdin-only transport cannot keep it out of argv`,
        CONTRACT_PATH,
      );
    }
    args.push(ANTIGRAVITY_PRINT_OPERAND);
    return {
      command: resolved.binary.value,
      args,
      promptDelivery: "stdin",
      stdin: prompt,
      ...(resolved.budget.value === undefined ? {} : { budgetApplied: spec.budget }),
    };
  }

  // The default transport: the prompt is the `--print` operand AND stdin. Both
  // channels carry it verbatim because some agy builds read only one of them.
  args.push(prompt);
  return {
    command: resolved.binary.value,
    args,
    promptDelivery: "stdin-and-argument",
    stdin: prompt,
    // Declared exactly when a budget resolved (§7 rule 1). No Antigravity lane
    // can express one, so this is always the declared asymmetry rather than a
    // flag — and it is reported, never dropped.
    ...(resolved.budget.value === undefined ? {} : { budgetApplied: spec.budget }),
  };
}

/**
 * Build the adapter serving {@link ANTIGRAVITY_PROVIDER}. Pure and stateless —
 * the returned object holds no environment, no catalog, and no session, so a
 * caller may build one per process or reuse {@link ANTIGRAVITY_RUNTIME_ADAPTER}.
 */
export function createAntigravityRuntimeAdapter(): AgentRuntimeAdapter {
  return Object.freeze({
    provider: ANTIGRAVITY_PROVIDER,
    defaultBinary: ANTIGRAVITY_DEFAULT_BINARY,
    envOverrides: ANTIGRAVITY_ENV_OVERRIDES,
    buildInvocation: buildAntigravityInvocation,
    discovery: ANTIGRAVITY_DISCOVERY,
  });
}

/** The shared instance a composition root registers. */
export const ANTIGRAVITY_RUNTIME_ADAPTER: AgentRuntimeAdapter = createAntigravityRuntimeAdapter();

function boundedDetail(value: string): string {
  return value.trim().slice(0, MAX_PROBE_DETAIL_CHARS);
}

/** True when a string carries a C0/C7F control character. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
