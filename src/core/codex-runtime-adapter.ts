// ---------------------------------------------------------------------------
// The Codex runtime profile adapter (issue #908).
//
// Slice B3 of docs/agent-runtime-profiles-contract.md §14.1 splits into a
// provider-neutral boundary (issue #906, src/core/agent-runtime-adapter.ts) and
// one adapter per provider. This module is the second of those adapters: the
// `openai` entry of the catalog, serving the Codex CLI, alongside the
// `anthropic` one issue #907 landed.
//
// What it owns, and nothing else:
//
//   - **The provider key and the default binary.** Adapters register under the
//     catalog's provider keys (§3), never under an agent id, so every agent the
//     injected agent→provider mapping places on `openai` is served by this one
//     adapter.
//   - **The §8.1 layer-1 break-glass variables** this provider honors —
//     `CODEX_MODEL` and `CODEX_EFFORT`. The boundary validates each of them
//     against the provider's capability descriptor before any billable run;
//     this module only declares which variable break-glasses which setting.
//     There is deliberately no binary override: every shipped Codex lane runs a
//     fixed `codex` (§1.2), and an operator who needs another executable sets
//     `binary` on a catalog profile, which is validated like any other setting
//     rather than trusted from the ambient environment. There is no budget
//     variable either, because the Codex CLI has no per-run budget cap flag on
//     any lane — an asymmetry this adapter declares (§7 rule 1) rather than
//     hides.
//   - **The lane table** — the Codex invocation shapes this loop actually runs
//     today, one entry per lane, as data: which subcommand the lane runs, the
//     sandbox/approval flags it pins, whether it names a base branch, which
//     run-owned output paths it can splice, and whether it has a place for an
//     operator-configured context-mode form. The settings a phase run resolved
//     are spliced into that shape; the shape itself is a safety property of the
//     lane and is never derived from a profile.
//   - **One argument-ordering rule, applied once.** `--model` and `--profile`
//     are GLOBAL Codex options and must precede the subcommand; `-c` overrides
//     are accepted after it, effort first and the operator's context-mode
//     entries after. Splicing a global after `exec`/`review` makes the CLI fail
//     argument parsing before the run starts, which is why every shipped Codex
//     lane already follows this rule and why it lives in one function here.
//   - **A pre-invocation validation pass** over every concrete value the
//     resolution produced and every lane input the caller supplied (§12.1's
//     resolution-time gate). A value the Codex CLI would misparse — a
//     flag-shaped model, an effort carrying whitespace, a context-mode override
//     that is not `key=value` — refuses with a §12.2 reason naming the setting
//     and the source it came from, before a single billable token is spent. So
//     does a context-mode override that names a setting this adapter itself
//     emits: because Codex takes the last `-c` value and context-mode entries
//     come last, honoring one would let it replace the resolved, capability-
//     checked value from below the §8.1 precedence ladder. Run-owned output
//     paths are validated as paths rather than as tokens — each is its own argv
//     element, so a space in one is a valid character and is preserved verbatim.
//
// Four properties this module deliberately does NOT have:
//
//   - **It names no model and no reasoning-effort value** (§14.3). Every
//     provider-tracked value arrives as a `string` the catalog already validated
//     against its capability descriptor. This is what retires the obsolete
//     common-code assumption that this provider's reasoning effort stops at the
//     third of three tiers: the accepted values are the descriptor's list, so an
//     installation whose Codex/model combination accepts a further tier declares
//     it in `agent-profiles.json` and binds a quality level to it — a data edit,
//     with no source change and no new TypeScript union member (§6.2).
//   - **It never clamps.** A resolved effort the provider does not declare was
//     already refused by the boundary or the catalog validator; nothing here
//     inspects a value, decides the CLI would not take it, and substitutes a
//     nearby one. That substitution — the `xhigh`/`max` → third-tier mapping the
//     shipped per-lane chains still perform — is exactly what §12.3 forbids, and
//     it is not reproduced behind this adapter.
//   - **It re-derives nothing** (§7 rule 2). It consults no label, no session
//     block, and no default of its own: the resolved profile, the lane, and the
//     lane's own inputs are its entire input. In particular the operator's
//     context-mode form is *resolved by the caller* (session config is the
//     handler layer's to read) and passed in already resolved, so this module
//     never guesses a context-mode key — the invariant issue #376 pinned.
//   - **It spawns nothing.** Building an invocation is pure. The caller keeps
//     its runner seam, its cwd, its timeout, its isolation bracket, and its
//     artifact machinery; a plan is data it hands to those.
//
// Wiring it up is one call at a composition root:
//
//   createAgentRuntimeAdapterRegistry({
//     adapters: [CLAUDE_RUNTIME_ADAPTER, CODEX_RUNTIME_ADAPTER],
//     providerForAgent,          // src/handlers/codex-context-mode.ts
//   })
//
// and then `planAgentInvocation(registry, codexInvocationRequest({ agentId,
// lane, quality, catalog, prompt }, { baseBranch, contextMode }))`. No lane is
// cut over to that call yet: each lane's cutover carries its own §10.3
// before/after table, and for this provider the difference is already known and
// recorded (§9.2 divergence 2) — an unlabelled run resolves `normal`, whose
// built-in binding carries a weaker effort than the shipped Codex lanes' own
// no-label default. That is a binding decision with an operator-visible cost
// consequence, not a mechanical rewrite. Landing this adapter therefore changes
// no invocation.
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
  RuntimeSettingSource,
} from "./agent-runtime-adapter.js";
import { AgentRuntimeAdapterError, AgentRuntimeContractViolationError } from "./agent-runtime-adapter.js";

// ---------------------------------------------------------------------------
// Provider identity and break-glass variables
// ---------------------------------------------------------------------------

/**
 * The catalog provider key this adapter serves. The catalog is keyed by
 * provider, not by agent id (§3), so every agent the injected mapping places on
 * this provider resolves through this one adapter and one set of profiles.
 */
export const CODEX_PROVIDER = "openai";

/**
 * The binary that runs when the resolved profile names none — today's fixed
 * `codex` (§1.2). Recorded with source `default` (§13.2).
 */
export const CODEX_DEFAULT_BINARY = "codex";

/**
 * The §8.1 layer-1 bindings, unchanged from the chains inventoried in §1.2: the
 * two variables an operator already reaches for during a provider incident keep
 * breaking the glass on exactly the field they name, and each is still validated
 * against the provider's capability descriptor before it is honored (§12.3 — a
 * break-glass override may replace a value, never widen what the provider
 * accepts).
 *
 * Precedence, restated so it is documented where it is declared: a variable here
 * outranks a task pin, a session pin, and the quality binding, and it overrides
 * **one field only** — setting `CODEX_EFFORT` leaves the model resolving
 * normally.
 *
 * `CODEX_MODEL` reaching the boundary as a *validated* override is the whole of
 * this provider's explicit model selection: the descriptor declares `model` as
 * `"free"` (§6.2), the loop never maintains a list of model names, and whether
 * the named model exists is the Codex CLI's answer at run time.
 */
export const CODEX_ENV_OVERRIDES: readonly AgentRuntimeEnvOverride[] = Object.freeze([
  Object.freeze({ setting: "model", variable: "CODEX_MODEL" } as AgentRuntimeEnvOverride),
  Object.freeze({ setting: "effort", variable: "CODEX_EFFORT" } as AgentRuntimeEnvOverride),
]);

// ---------------------------------------------------------------------------
// Subcommand shapes — the safety half of a lane, never a profile's business
// ---------------------------------------------------------------------------

/**
 * The Codex config key carrying reasoning effort. A key, not a value: the value
 * itself is whatever the catalog's capability descriptor declares and the
 * resolution chose, and this module never enumerates one (§14.3).
 */
const REASONING_EFFORT_KEY = "model_reasoning_effort";

/** The Codex config key carrying the model, for the same reason as above. */
const MODEL_CONFIG_KEY = "model";

/** The `-c key=value` flag every Codex lane passes its config overrides with. */
const CONFIG_FLAG = "-c";

/**
 * The Codex config keys this adapter owns, mapped to the setting each one
 * carries. A `-c` entry naming one of these does not merely duplicate the
 * resolution — Codex takes the last value on the command line, and the adapter
 * emits its own overrides *before* the operator's context-mode entries (the
 * ordering rule below), so such an entry silently wins over the value the
 * resolution chose. That value reached argv having been validated against the
 * provider's capability descriptor and having recorded a source (§13.2); a
 * context-mode entry is checked against neither, so honoring one would let an
 * operator's context-mode form outrank the §8.1 break-glass variable that
 * exists for exactly this and reintroduce, one layer down, the unvalidated
 * effort §12.3 forbids. These entries therefore refuse.
 *
 * The keys are the ones an entry can name directly. What an operator's own
 * `config.toml` profile carries under `--profile` is deliberately not policed
 * here: this module reads no file, and a check that covered some of that
 * surface and not the rest would read as a guarantee it cannot make.
 */
type AdapterOwnedSetting = "model" | "effort";

const ADAPTER_OWNED_CONFIG_KEYS: ReadonlyMap<string, AdapterOwnedSetting> = new Map<string, AdapterOwnedSetting>([
  [MODEL_CONFIG_KEY, "model"],
  [REASONING_EFFORT_KEY, "effort"],
]);

/** The §8.1 variable an operator breaks the glass on a given setting with. */
function breakGlassVariableFor(setting: AdapterOwnedSetting): string | undefined {
  return CODEX_ENV_OVERRIDES.find((override) => override.setting === setting)?.variable;
}

/**
 * The implementation lane's subcommand: plain `codex exec`, running under the
 * sandbox and approval posture the operator's own Codex configuration sets. The
 * lane edits the checkout, so it pins no read-only sandbox — the containment
 * question is the grant tiers contract's (#697), never a runtime profile's.
 */
export const CODEX_EXEC_ARGS: readonly string[] = Object.freeze(["exec"]);

/**
 * The read-bounded exec posture: no file writes and no network, on top of
 * whatever throwaway cwd and credential-stripped environment the caller's
 * isolation bracket already provides.
 *
 *   - `--sandbox read-only` is the Codex half of a read-only boundary. It is
 *     NEVER a no-tools boundary: it bounds writes and network while leaving
 *     reads available (docs/review-dispute-contract.md §17.5), and a lane that
 *     needs the stronger claim does not get it from this flag.
 *   - `--skip-git-repo-check` is required because that cwd is deliberately not a
 *     git checkout — `codex exec` refuses to start outside one without it.
 *   - `--ignore-user-config` refuses a `config.toml` under CODEX_HOME, which
 *     could otherwise reintroduce MCP servers or hooks around the boundary,
 *     while leaving CODEX_HOME's auth reachable.
 *
 * One list, one owner: the lanes below compose this constant rather than
 * restating it, because a second literal list under a second name is how two
 * lanes end up pinning different postures while both claim the same rule.
 */
export const CODEX_READ_BOUNDED_EXEC_ARGS: readonly string[] = Object.freeze([
  "exec",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
  "--ignore-user-config",
]);

/**
 * The read-bounded posture plus `--json`, for the lanes that read their answer
 * from the CLI's own event stream and its final-message file rather than from
 * free-form stdout.
 */
export const CODEX_STRUCTURED_EXEC_ARGS: readonly string[] = Object.freeze([
  ...CODEX_READ_BOUNDED_EXEC_ARGS,
  "--json",
]);

/** The review subcommand. `--base <branch>` is spliced from the lane's input. */
export const CODEX_REVIEW_ARGS: readonly string[] = Object.freeze(["review"]);

// ---------------------------------------------------------------------------
// The lane table
// ---------------------------------------------------------------------------

/**
 * The Codex invocation lanes this adapter serves. An unrecognized lane refuses
 * (§12.3) rather than falling back to the least-restricted shape — a lane whose
 * sandbox posture nobody declared must never inherit one that permits writes.
 *
 * `structured_exec` is one lane, not two: the structured review runner and the
 * reviewer's read-bounded reconsideration turn invoke the same read-bounded
 * posture with the same event stream and the same final-message file, and they
 * differ only in the prompt their runner writes and the schema one of them pins,
 * which is a lane input rather than a second shape.
 *
 * There is deliberately no `conflict_resolution` entry: no shipped lane invokes
 * Codex for it, and inventing an invocation here would be this module deciding
 * which agent owns a phase — the assignment profile's decision (§4.2), not the
 * adapter's.
 */
export const CODEX_LANES = ["implementation", "review", "structured_exec", "read_bounded"] as const;

export type CodexLane = (typeof CODEX_LANES)[number];

const CODEX_LANE_SET: ReadonlySet<string> = new Set<string>(CODEX_LANES);

/** True when a string names a lane this adapter can build an invocation for. */
export function isCodexLane(value: unknown): value is CodexLane {
  return typeof value === "string" && CODEX_LANE_SET.has(value);
}

/** Which run-owned output paths a lane can splice, in the order it splices them. */
export type CodexLaneOutputPaths = "none" | "last-message" | "last-message-and-schema";

/**
 * One lane's invocation shape. Everything here is a safety or capability
 * property of the lane itself; the resolved profile contributes only the
 * concrete model and effort values spliced into it.
 */
export interface CodexLaneSpec {
  readonly lane: CodexLane;
  /**
   * The subcommand and the flags the lane pins, emitted immediately after the
   * global options and before any run-owned path or resolved setting, so a
   * pinned sandbox flag can never be displaced by a setting that happens to be
   * absent.
   */
  readonly subcommandArgs: readonly string[];
  /** True when the lane names the PR base branch (`--base <branch>`). */
  readonly requiresBaseBranch: boolean;
  /** Which run-owned output paths this lane has a place for. */
  readonly outputPaths: CodexLaneOutputPaths;
  /**
   * Whether this lane has a place for an operator-configured context-mode form
   * (issue #376). A lane that does not refuses one rather than accepting it and
   * emitting nothing — an operator who configured context-mode meant it to run.
   */
  readonly acceptsContextMode: boolean;
  /**
   * Whether this lane can express a per-run budget cap. Every Codex lane
   * reports `not-applicable`: the CLI has no budget flag, which is a declared
   * asymmetry (§7 rule 1) recorded in the plan and visible in the audit record,
   * never a budget dropped in silence.
   */
  readonly budget: BudgetApplication;
}

/**
 * Today's four Codex invocation shapes. Read against the shipped handlers, the
 * argv each produces is unchanged:
 *
 *   implementation   `[--model M] exec -c <effort> [-c ctx…]`
 *   review           `[--model M] [--profile P] review --base B -c <effort> [-c ctx…]`
 *   structured_exec  `[--model M] [--profile P] exec --sandbox read-only
 *                     --skip-git-repo-check --ignore-user-config --json
 *                     [--output-last-message P] [--output-schema P]
 *                     -c <effort> [-c ctx…]`
 *   read_bounded     `[--model M] exec --sandbox read-only --skip-git-repo-check
 *                     --ignore-user-config -c <effort>`
 *
 * with one deliberate correction the cutover carries: the shipped
 * implementation lane splices a context-mode `--profile` *after* `exec`, where
 * every other shipped Codex lane — and the ordering rule they all document —
 * puts that global option before the subcommand. A global after the subcommand
 * makes the CLI fail argument parsing, so reproducing that placement here would
 * be preserving a defect rather than a behavior; the lane's before/after table
 * records the fix when it is cut over.
 */
export const CODEX_LANE_SPECS: Readonly<Record<CodexLane, CodexLaneSpec>> = Object.freeze({
  implementation: Object.freeze({
    lane: "implementation",
    subcommandArgs: CODEX_EXEC_ARGS,
    requiresBaseBranch: false,
    outputPaths: "none",
    acceptsContextMode: true,
    budget: "not-applicable",
  } as CodexLaneSpec),
  review: Object.freeze({
    lane: "review",
    subcommandArgs: CODEX_REVIEW_ARGS,
    requiresBaseBranch: true,
    outputPaths: "none",
    acceptsContextMode: true,
    budget: "not-applicable",
  } as CodexLaneSpec),
  structured_exec: Object.freeze({
    lane: "structured_exec",
    subcommandArgs: CODEX_STRUCTURED_EXEC_ARGS,
    requiresBaseBranch: false,
    outputPaths: "last-message-and-schema",
    acceptsContextMode: true,
    budget: "not-applicable",
  } as CodexLaneSpec),
  read_bounded: Object.freeze({
    lane: "read_bounded",
    subcommandArgs: CODEX_READ_BOUNDED_EXEC_ARGS,
    requiresBaseBranch: false,
    outputPaths: "none",
    // The refinement critic reads no session context-mode form today, and a
    // lane with no place for one must say so rather than swallow it.
    acceptsContextMode: false,
    budget: "not-applicable",
  } as CodexLaneSpec),
});

// ---------------------------------------------------------------------------
// Lane inputs — what the lane owns and the runtime contract does not
// ---------------------------------------------------------------------------

/**
 * An operator-configured context-mode form (issue #376), already resolved by
 * the caller from `session.codex.contextMode` and the environment. It arrives
 * resolved because the invocation form is ALWAYS operator-supplied — this
 * module must never guess a context-mode config key — and because session
 * config is the handler layer's to read: `core/` takes no runtime dependency on
 * `handlers/`.
 */
export interface CodexContextModeForm {
  /** `--profile <name>`, a GLOBAL option spliced before the subcommand. */
  readonly profile?: string;
  /** `-c key=value` overrides, spliced after the subcommand and after effort. */
  readonly config?: readonly string[];
}

/**
 * The lane-owned inputs of one Codex invocation: values that belong to the run
 * rather than to the runtime profile. A path here is a local artifact location,
 * a base branch is a fact about the PR, and a context-mode form is operator
 * configuration — none of them is a setting a catalog profile may carry, and
 * none of them is something this adapter may derive.
 */
export interface CodexLaneInputs {
  /** `--base <branch>` for the review lane. Required there, refused elsewhere. */
  readonly baseBranch?: string;
  /** The resolved context-mode form, for the lanes that have a place for one. */
  readonly contextMode?: CodexContextModeForm;
  /** `--output-last-message <path>`, for the lanes that read a final message. */
  readonly lastMessagePath?: string;
  /**
   * `--output-schema <path>`. Spliced only when the caller supplies it: the
   * capability is off by default in the shipped structured review runner, and
   * this adapter does not get to promote it.
   */
  readonly outputSchemaPath?: string;
}

/**
 * A boundary invocation request carrying this provider's lane inputs. The
 * boundary passes the request through to the adapter unchanged, so an adapter
 * may widen it; nothing in the common contract reads the extra key.
 */
export interface CodexInvocationRequest extends AgentInvocationRequest {
  readonly codex?: CodexLaneInputs;
}

/**
 * Attach lane inputs to a boundary request. Callers use this rather than an
 * object literal so the widened request is a value of a declared type — passing
 * it to `planAgentInvocation` needs no cast, and a typo in a lane input is a
 * compile error rather than an ignored key.
 */
export function codexInvocationRequest(
  request: AgentInvocationRequest,
  inputs: CodexLaneInputs,
): CodexInvocationRequest {
  return { ...request, codex: inputs };
}

// ---------------------------------------------------------------------------
// Pre-invocation validation (§12.1's resolution-time gate)
// ---------------------------------------------------------------------------

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
 * Codex CLI itself needs: a value that is present, carries no whitespace the
 * flag or the `-c` override cannot hold, and is not flag-shaped — a value
 * beginning with `-` would be parsed as another option and silently change the
 * invocation.
 *
 * The whitespace rules restate, per setting, exactly what the boundary already
 * applies to an env override of that setting, so a value cannot pass one gate
 * and fail the other: `effort` is a single token, `model` may carry a plain
 * space, and `binary` may be a path containing one (the runner spawns argv
 * directly, so nothing is ever shell-split).
 */
function requireCliSafeValue(
  setting: "model" | "effort" | "binary",
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
  const badWhitespace = setting === "effort" ? /\s/ : /[^\S ]/;
  if (badWhitespace.test(value)) {
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

/** Where a lane-input defect is reported from, so a message names its origin. */
const CONTRACT_PATH = "codex lane inputs";

/**
 * The part of lane-input validation both kinds share: present, non-blank, free
 * of control characters, and not flag-shaped. These values are caller-supplied
 * rather than operator-configured, so a bad one is a defect at the call site
 * (`AgentRuntimeContractViolationError`), not unsupported configuration.
 */
function requireCliSafeLaneValue(what: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentRuntimeContractViolationError(
      `${what} must be a non-empty string (got ${JSON.stringify(value)})`,
      CONTRACT_PATH,
    );
  }
  if (hasControlCharacter(value)) {
    throw new AgentRuntimeContractViolationError(
      `${what} ${JSON.stringify(value)} carries control characters the CLI cannot take in one token`,
      CONTRACT_PATH,
    );
  }
  return value;
}

/** Reject a value the CLI would read as another option rather than as an operand. */
function requireNotFlagShaped(what: string, value: string): string {
  if (value.startsWith("-")) {
    throw new AgentRuntimeContractViolationError(
      `${what} ${JSON.stringify(value)} starts with "-"; the CLI would parse it as another option`,
      CONTRACT_PATH,
    );
  }
  return value;
}

/**
 * Validate a lane-owned git ref — today only the review lane's base branch. A
 * ref is a single token by construction (git forbids whitespace in one), so
 * whitespace here is a malformed ref rather than an awkward one, and the value
 * is trimmed because surrounding whitespace on a ref is never meaningful.
 */
function requireCliSafeBranch(what: string, value: unknown): string {
  const checked = requireCliSafeLaneValue(what, value).trim();
  if (/\s/.test(checked)) {
    throw new AgentRuntimeContractViolationError(
      `${what} ${JSON.stringify(value)} carries whitespace, which a git ref cannot hold`,
      CONTRACT_PATH,
    );
  }
  return requireNotFlagShaped(what, checked);
}

/**
 * Validate a run-owned output path. Unlike a ref, a path is *not* a restricted
 * token: every one of these is passed as its own argv element to a runner that
 * spawns argv directly, so nothing is ever shell-split and an interior space is
 * an ordinary character of a valid path — `/tmp/review files/final-message.txt`
 * is a path the shipped structured reviewer already hands through verbatim.
 * Refusing or trimming one would reject valid callers and, worse, quietly
 * rename the file the run then fails to read, so the path is preserved exactly
 * as supplied and only what would stop naming a file at all is refused: a blank
 * value, a control character, and a leading "-" the CLI reads as an option.
 */
function requireCliSafePath(what: string, value: unknown): string {
  return requireNotFlagShaped(what, requireCliSafeLaneValue(what, value));
}

/** A `-c` override must look like `key=value`, with a non-empty key and value. */
const CONFIG_ENTRY = /^[^=\s]+=.+$/;

/**
 * Validate the operator's resolved context-mode form. Unlike a base branch this
 * IS operator configuration, so a malformed entry refuses with a §12.2 reason
 * an operator can act on rather than as a caller defect. The shape rules are the
 * ones the shipped resolver already applies, restated here because a form may
 * reach this adapter from any caller.
 */
function contextModeArgs(
  form: CodexContextModeForm | undefined,
  spec: CodexLaneSpec,
): { profile?: string; config: readonly string[] } {
  const rawProfile = form?.profile;
  const profile = typeof rawProfile === "string" ? rawProfile.trim() : "";
  const rawConfig: readonly unknown[] = Array.isArray(form?.config) ? (form?.config ?? []) : [];
  const config = rawConfig
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  if (profile.length === 0 && config.length === 0) return { config: [] };

  if (!spec.acceptsContextMode) {
    throw new AgentRuntimeAdapterError(
      "unsupported-setting",
      `the Codex "${spec.lane}" lane has no place for a context-mode form; the operator configured one, so it must not be dropped in silence`,
    );
  }
  if (profile.length > 0) {
    if (hasControlCharacter(profile) || /\s/.test(profile) || profile.startsWith("-")) {
      throw new AgentRuntimeAdapterError(
        "unsupported-value",
        `the context-mode profile ${JSON.stringify(profile)} is not a value the CLI can take in one token after --profile`,
      );
    }
  }
  for (const entry of config) {
    if (!CONFIG_ENTRY.test(entry) || hasControlCharacter(entry)) {
      throw new AgentRuntimeAdapterError(
        "unsupported-value",
        `the context-mode override ${JSON.stringify(entry)} is not a key=value the CLI accepts after -c`,
      );
    }
    const owned = ADAPTER_OWNED_CONFIG_KEYS.get(entry.slice(0, entry.indexOf("=")).toLowerCase());
    if (owned !== undefined) {
      const variable = breakGlassVariableFor(owned);
      throw new AgentRuntimeAdapterError(
        "unsupported-setting",
        `the context-mode override ${JSON.stringify(entry)} sets the ${owned}, which the runtime profile resolves and this adapter emits; ` +
          `a context-mode entry is emitted after it and would silently replace it without any capability check` +
          `${variable === undefined ? "" : `, so change the profile's ${owned} or break the glass with ${variable} instead`}`,
      );
    }
  }
  return { ...(profile.length > 0 ? { profile } : {}), config };
}

// ---------------------------------------------------------------------------
// Discovery — interpretation input only, never a gate and never a catalog feed
// ---------------------------------------------------------------------------

/**
 * How a caller asks the installed Codex CLI what it is. The caller runs
 * `<resolved binary> --version` through its own probe seam and hands the typed
 * outcome to `interpretDiscoveryProbe`, which preserves issue #897's
 * determinate/transient split. Nothing here feeds the catalog (§11.3): a version
 * banner is operator-facing detail, never a capability descriptor — which
 * matters most for exactly this provider, where the temptation to infer "this
 * build accepts a further reasoning tier" from a version string is what put an
 * obsolete ceiling in source in the first place.
 */
export const CODEX_DISCOVERY: AgentRuntimeDiscoverySpec = Object.freeze({
  args: Object.freeze(["--version"]) as readonly string[],
  parse(stdout: string): { version?: string } {
    const match = /\b\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?\b/.exec(stdout);
    return match ? { version: match[0] } : {};
  },
});

/**
 * The operator-facing summary of one resolved Codex runtime: what will run, and
 * where each value came from (§13.2), plus the installed CLI's version when a
 * caller has probed for it. An absent model or effort stays absent with its
 * `cli-default` source (§13.3) — never the string "default", and never a value
 * this module invented.
 */
export interface CodexRuntimeDescription {
  readonly provider: string;
  readonly binary: string;
  readonly binarySource: RuntimeSettingSource;
  readonly model?: string;
  readonly modelSource: RuntimeSettingSource;
  readonly effort?: string;
  readonly effortSource: RuntimeSettingSource;
  /** The installed CLI's version, when discovery established one. */
  readonly cliVersion?: string;
  /** What discovery established about the installed CLI, when it ran. */
  readonly cliStatus?: AgentRuntimeDiscovery["status"];
}

/**
 * Project a resolution (and an optional discovery answer) into that summary.
 * Pure projection: it adds nothing the resolution did not already decide, which
 * is what keeps the audit record and the operator-facing line the same fact.
 */
export function describeCodexRuntime(
  resolved: ResolvedAgentRuntime,
  discovery?: AgentRuntimeDiscovery,
): CodexRuntimeDescription {
  // `indeterminate` is a fact about the host at one moment, not about the CLI
  // (§7.1), so it contributes a status and never a version.
  const version =
    discovery?.status === "available" && typeof discovery.version === "string" && discovery.version.length > 0
      ? discovery.version
      : undefined;
  return Object.freeze({
    provider: resolved.provider,
    binary: resolved.binary.value,
    binarySource: resolved.binary.source,
    ...(resolved.model.value !== undefined ? { model: resolved.model.value } : {}),
    modelSource: resolved.model.source,
    ...(resolved.effort.value !== undefined ? { effort: resolved.effort.value } : {}),
    effortSource: resolved.effort.source,
    ...(version !== undefined ? { cliVersion: version } : {}),
    ...(discovery !== undefined ? { cliStatus: discovery.status } : {}),
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function buildCodexInvocation(
  request: AgentInvocationRequest,
  resolved: ResolvedAgentRuntime,
): AgentInvocationPlan {
  const lane = typeof request.lane === "string" ? request.lane.trim() : "";
  if (!isCodexLane(lane)) {
    throw new AgentRuntimeAdapterError(
      "unsupported-setting",
      `the Codex adapter has no invocation for lane "${lane}" (serves: ${CODEX_LANES.join(", ")})`,
    );
  }
  const spec = CODEX_LANE_SPECS[lane];
  const profileName = resolved.profileName;
  const inputs = (request as CodexInvocationRequest).codex ?? {};

  // The Codex invocation takes no catalog-declared provider option today. An
  // option that reached here was declared in a capability descriptor an operator
  // widened, and honoring the profile while ignoring the option is exactly the
  // accepted-and-silently-dropped setting §12.3 forbids. Context-mode is not
  // that: it is a lane input the caller resolved from session config, not a
  // catalog setting.
  const optionKeys = Object.keys(resolved.providerOptions ?? {});
  if (optionKeys.length > 0) {
    throw new AgentRuntimeAdapterError(
      "unsupported-setting",
      `profile "${profileName}" carries provider options (${optionKeys.sort().join(", ")}) that the Codex adapter has no invocation for`,
    );
  }

  requireCliSafeValue("binary", resolved.binary.value, resolved.binary.source, profileName);
  const contextMode = contextModeArgs(inputs.contextMode, spec);

  // --- global options: everything before the subcommand ---------------------
  // `--model` and `--profile` are GLOBAL Codex options. Splicing either after
  // the subcommand makes the CLI fail argument parsing before the run starts.
  const args: string[] = [];
  const model = resolved.model.value;
  if (model !== undefined) {
    requireCliSafeValue("model", model, resolved.model.source, profileName);
    args.push("--model", model);
  }
  if (contextMode.profile !== undefined) {
    args.push("--profile", contextMode.profile);
  }

  // --- the subcommand and the flags the lane pins ---------------------------
  args.push(...spec.subcommandArgs);
  if (spec.requiresBaseBranch) {
    if (inputs.baseBranch === undefined) {
      throw new AgentRuntimeContractViolationError(
        `the Codex "${lane}" lane names the PR base branch; supply it as codex.baseBranch`,
        CONTRACT_PATH,
      );
    }
    args.push("--base", requireCliSafeBranch(`the "${lane}" lane's base branch`, inputs.baseBranch));
  } else if (inputs.baseBranch !== undefined) {
    throw new AgentRuntimeContractViolationError(
      `the Codex "${lane}" lane has no --base option; only the review lane names a base branch`,
      CONTRACT_PATH,
    );
  }

  // --- run-owned output paths ----------------------------------------------
  // Absent paths are the sanitized form a resolved profile records: a local temp
  // path is not a fact about the run's result, so the lane may build the same
  // argv with and without them.
  if (inputs.lastMessagePath !== undefined) {
    if (spec.outputPaths === "none") {
      throw new AgentRuntimeContractViolationError(
        `the Codex "${lane}" lane reads no final-message file; it has no --output-last-message option`,
        CONTRACT_PATH,
      );
    }
    args.push(
      "--output-last-message",
      requireCliSafePath(`the "${lane}" lane's final-message path`, inputs.lastMessagePath),
    );
  }
  if (inputs.outputSchemaPath !== undefined) {
    if (spec.outputPaths !== "last-message-and-schema") {
      throw new AgentRuntimeContractViolationError(
        `the Codex "${lane}" lane pins no response schema; it has no --output-schema option`,
        CONTRACT_PATH,
      );
    }
    args.push(
      "--output-schema",
      requireCliSafePath(`the "${lane}" lane's schema path`, inputs.outputSchemaPath),
    );
  }

  // --- `-c` overrides: accepted only after the subcommand -------------------
  // An absent effort passes no override at all, so a profile that unsets it
  // returns the Codex CLI to its own configured default (§6.1) rather than
  // resolving to an effort this module picked.
  const effort = resolved.effort.value;
  if (effort !== undefined) {
    requireCliSafeValue("effort", effort, resolved.effort.source, profileName);
    args.push(CONFIG_FLAG, `${REASONING_EFFORT_KEY}=${effort}`);
  }
  for (const entry of contextMode.config) {
    args.push(CONFIG_FLAG, entry);
  }

  // Every Codex lane delivers its prompt on stdin — the argv stays free of
  // prompt content, which is what lets a resolved profile be logged verbatim.
  const prompt = request.prompt;
  return {
    command: resolved.binary.value,
    args,
    promptDelivery: prompt === undefined ? "none" : "stdin",
    ...(prompt === undefined ? {} : { stdin: prompt }),
    // Declared exactly when a budget resolved (§7 rule 1). No Codex lane can
    // express one, so this is always the declared asymmetry rather than a flag —
    // and it is reported, never dropped.
    ...(resolved.budget.value === undefined ? {} : { budgetApplied: spec.budget }),
  };
}

/**
 * Build the adapter serving {@link CODEX_PROVIDER}. Pure and stateless — the
 * returned object holds no environment, no catalog, and no session, so a caller
 * may build one per process or reuse {@link CODEX_RUNTIME_ADAPTER}.
 */
export function createCodexRuntimeAdapter(): AgentRuntimeAdapter {
  return Object.freeze({
    provider: CODEX_PROVIDER,
    defaultBinary: CODEX_DEFAULT_BINARY,
    envOverrides: CODEX_ENV_OVERRIDES,
    buildInvocation: buildCodexInvocation,
    discovery: CODEX_DISCOVERY,
  });
}

/** The shared instance a composition root registers. */
export const CODEX_RUNTIME_ADAPTER: AgentRuntimeAdapter = createCodexRuntimeAdapter();

/** True when a string carries a C0/C7F control character. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
