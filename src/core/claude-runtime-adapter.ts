// ---------------------------------------------------------------------------
// The Claude runtime profile adapter (issue #907).
//
// Slice B3 of docs/agent-runtime-profiles-contract.md §14.1 splits into a
// provider-neutral boundary (issue #906, src/core/agent-runtime-adapter.ts) and
// one adapter per provider. This module is the first of those adapters: the
// `anthropic` entry of the catalog, serving the Claude CLI.
//
// What it owns, and nothing else:
//
//   - **The provider key and the default binary.** Adapters register under the
//     catalog's provider keys (§3), never under an agent id, so every agent the
//     injected agent→provider mapping places on `anthropic` is served by this
//     one adapter.
//   - **The §8.1 layer-1 break-glass variables** this provider honors —
//     `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_MAX_BUDGET_USD`. The boundary
//     validates each of them against the provider's capability descriptor
//     before any billable run; this module only declares which variable
//     break-glasses which setting. There is deliberately no binary override:
//     the shipped Claude lanes all run a fixed `claude` (§1.2), and an operator
//     who needs another executable sets `binary` on a catalog profile, which is
//     validated like any other setting rather than trusted from the ambient
//     environment.
//   - **The lane table** — the Claude CLI invocation shapes this loop actually
//     runs today, one entry per lane, as data: which tool boundary the lane
//     pins, whether it grants an edit permission mode, which auto-approval
//     allowlist it carries, and whether the lane can express a per-run budget
//     cap at all. The settings a phase run resolved are spliced into that
//     shape; the shape itself is a safety property of the lane and is never
//     derived from a profile.
//   - **A pre-invocation validation pass** over every concrete value the
//     resolution produced (§12.1's resolution-time gate). A value that the
//     Claude CLI would misparse — a flag-shaped model, an effort carrying
//     whitespace, a budget that is not a positive amount — refuses with a §12.2
//     reason naming the setting and the source it came from, before a single
//     billable token is spent.
//
// Three properties this module deliberately does NOT have:
//
//   - **It names no model and no effort value** (§14.3). Every provider-tracked
//     value arrives as a `string` the catalog already validated against its
//     capability descriptor; a model refresh is a catalog edit, never a source
//     change here. A test pins this source against ever spelling one.
//   - **It re-derives nothing** (§7 rule 2). It consults no label, no session
//     block, and no default of its own: the resolved profile and the lane are
//     its entire input. The per-lane default chains inventoried in §1.2 are
//     still live in their handlers and are deleted by their own cutover
//     slices — this adapter does not layer under them.
//   - **It spawns nothing.** Building an invocation is pure. The caller keeps
//     its runner seam, its cwd, its timeout, its isolation bracket, and its
//     artifact machinery; a plan is data it hands to those.
//
// Wiring it up is one call at a composition root:
//
//   createAgentRuntimeAdapterRegistry({
//     adapters: [CLAUDE_RUNTIME_ADAPTER],
//     providerForAgent,          // src/handlers/codex-context-mode.ts
//   })
//
// and then `planAgentInvocation(registry, { agentId, lane, quality, catalog,
// prompt })`. No lane is cut over to that call yet: each lane's cutover carries
// its own §10.3 before/after table, because the two divergences B1 recorded —
// an explicit `review:medium` and the review loop's escalation floor — are
// binding decisions with operator-visible consequences, not mechanical
// rewrites. Landing this adapter therefore changes no invocation.
// ---------------------------------------------------------------------------

import type {
  AgentInvocationPlan,
  AgentInvocationRequest,
  AgentRuntimeAdapter,
  AgentRuntimeDiscoverySpec,
  AgentRuntimeEnvOverride,
  BudgetApplication,
  ResolvedAgentRuntime,
  ResolvedRuntimeSetting,
  RuntimeSettingSource,
} from "./agent-runtime-adapter.js";
import { AgentRuntimeAdapterError } from "./agent-runtime-adapter.js";

// ---------------------------------------------------------------------------
// Provider identity and break-glass variables
// ---------------------------------------------------------------------------

/**
 * The catalog provider key this adapter serves. The catalog is keyed by
 * provider, not by agent id (§3), so every agent the injected mapping places on
 * this provider resolves through this one adapter and one set of profiles.
 */
export const CLAUDE_PROVIDER = "anthropic";

/**
 * The binary that runs when the resolved profile names none — today's fixed
 * `claude` (§1.2). Recorded with source `default` (§13.2).
 */
export const CLAUDE_DEFAULT_BINARY = "claude";

/**
 * The §8.1 layer-1 bindings, unchanged from the chains inventoried in §1.2:
 * the three variables an operator already reaches for during a provider
 * incident keep breaking the glass on exactly the field they name, and each is
 * still validated against the provider's capability descriptor before it is
 * honored (§12.3 — a break-glass override may replace a value, never widen what
 * the provider accepts).
 *
 * Precedence, restated so it is documented where it is declared: a variable
 * here outranks a task pin, a session pin, and the quality binding, and it
 * overrides **one field only** — setting `CLAUDE_EFFORT` leaves model and
 * budget resolving normally.
 */
export const CLAUDE_ENV_OVERRIDES: readonly AgentRuntimeEnvOverride[] = Object.freeze([
  Object.freeze({ setting: "model", variable: "CLAUDE_MODEL" } as AgentRuntimeEnvOverride),
  Object.freeze({ setting: "effort", variable: "CLAUDE_EFFORT" } as AgentRuntimeEnvOverride),
  Object.freeze({ setting: "budget", variable: "CLAUDE_MAX_BUDGET_USD" } as AgentRuntimeEnvOverride),
]);

// ---------------------------------------------------------------------------
// Tool boundaries — the safety half of a lane, never a profile's business
// ---------------------------------------------------------------------------

/**
 * The auto-approval allowlist the implementation lane runs with: read and edit
 * the checkout, plus the bounded read-only shell commands and the two
 * verification commands. A grant tier decides what an agent is *authorized* to
 * run (#697); this list is the CLI-level half the implementation lane has
 * always pinned, and it is a property of the lane, never of a runtime profile.
 */
export const CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash(rg *)",
  "Bash(sed *)",
  "Bash(cat *)",
  "Bash(npm test)",
  "Bash(npm run package)",
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
].join(",");

/**
 * The conflict-resolution lane's allowlist. Narrower than the implementation
 * lane's on purpose: resolving a merge conflict edits and stages files, and
 * never runs the verification commands, which that lane's handler runs itself
 * afterwards.
 */
export const CLAUDE_CONFLICT_RESOLUTION_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash(rg *)",
  "Bash(sed *)",
  "Bash(cat *)",
  "Bash(git status *)",
  "Bash(git ls-files *)",
  "Bash(git add -- *)",
].join(",");

/**
 * Every write- or exec-capable built-in, denied by name for the no-tools lanes.
 * Read tools are denied too: those lanes decide on a bundle the runner
 * resolved, and an agent that reads a file nobody bounded is deciding on
 * evidence nobody bounded.
 */
const CLAUDE_DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillBash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
].join(",");

/**
 * The CLI-level half of the read-only boundary the judging lanes pin, defense
 * in depth:
 *   - `--tools ""` removes every built-in tool from the model's tool set. With
 *     an empty set there is no tool for injected text to invoke, whatever the
 *     allow/deny lists happen to enumerate.
 *   - `--allowedTools ""` empties the auto-approval allowlist.
 *   - `--disallowedTools` denies every write/exec-capable built-in by name.
 *   - `--strict-mcp-config` (with no `--mcp-config`) refuses to load any MCP
 *     server config, so no MCP-backed tool can be reached.
 *   - `--safe-mode` disables user/project customizations (hooks, plugins,
 *     agents, slash commands), which would otherwise run around this boundary.
 *   - `--no-session-persistence` keeps the bundle and the conversation out of
 *     the operator's real config dir; the raw output belongs in the run's own
 *     artifact directory.
 *
 * One list, one owner: the reconsideration and arbitration runners both alias
 * this constant rather than restating it, because a second literal list under a
 * second name is how two lanes end up pinning different boundaries while both
 * claim to implement the same rule.
 */
export const CLAUDE_NO_TOOLS_ARGS: readonly string[] = Object.freeze([
  "--tools",
  "",
  "--allowedTools",
  "",
  "--disallowedTools",
  CLAUDE_DISALLOWED_TOOLS,
  "--strict-mcp-config",
  "--safe-mode",
  "--no-session-persistence",
]);

// ---------------------------------------------------------------------------
// The lane table
// ---------------------------------------------------------------------------

/**
 * The Claude invocation lanes this adapter serves. An unrecognized lane refuses
 * (§12.3) rather than falling back to the least-restricted shape — a lane whose
 * tool boundary nobody declared must never inherit one that grants edits.
 *
 * `no_tools` is one lane, not three: the reviewer's reconsideration, the
 * arbiter, and the refinement critic all invoke the same read-only boundary
 * with the same argv, and they differ only in the prompt their runner writes,
 * which is not this adapter's business.
 */
export const CLAUDE_LANES = [
  "implementation",
  "conflict_resolution",
  "review",
  "no_tools",
] as const;

export type ClaudeLane = (typeof CLAUDE_LANES)[number];

const CLAUDE_LANE_SET: ReadonlySet<string> = new Set<string>(CLAUDE_LANES);

/** True when a string names a lane this adapter can build an invocation for. */
export function isClaudeLane(value: unknown): value is ClaudeLane {
  return typeof value === "string" && CLAUDE_LANE_SET.has(value);
}

/**
 * One lane's invocation shape. Everything here is a safety or capability
 * property of the lane itself; the resolved profile contributes only the
 * concrete model, effort, and budget values spliced into it.
 */
export interface ClaudeLaneSpec {
  readonly lane: ClaudeLane;
  /**
   * Flags pinning the lane's tool boundary, emitted immediately after `-p` and
   * before any resolved setting, so a boundary can never be displaced by a
   * setting that happens to be absent.
   */
  readonly toolBoundaryArgs: readonly string[];
  /** `--permission-mode` value, for the lanes that write to the checkout. */
  readonly permissionMode?: string;
  /** `--allowedTools` value, for the lanes that grant an auto-approval list. */
  readonly allowedTools?: string;
  /**
   * Whether this lane can express a per-run budget cap. `not-applicable` is a
   * declared asymmetry between lanes of the same provider (§7 rule 1), recorded
   * in the plan and visible in the audit record — never a budget dropped in
   * silence.
   */
  readonly budget: BudgetApplication;
}

/** The lanes that pin no tool boundary of their own, sharing one frozen empty. */
const NO_TOOL_BOUNDARY_ARGS: readonly string[] = Object.freeze([]);

/**
 * Today's four Claude invocation shapes, verbatim. Read against the shipped
 * handlers, the argv each produces is unchanged:
 *
 *   implementation      `-p --model M --effort E --permission-mode acceptEdits
 *                        --max-budget-usd B --allowedTools <impl list>`
 *   conflict_resolution the same, with the conflict lane's narrower list
 *   review              `-p --model M --effort E`
 *   no_tools            `-p <no-tools args> --model M --effort E`
 *
 * The review lane carries no budget flag because the Claude review CLI
 * invocation has never had one — that is exactly the `budgetApplied:
 * "not-applicable"` case §7 rule 1 exists for, not a missing catalog value.
 */
export const CLAUDE_LANE_SPECS: Readonly<Record<ClaudeLane, ClaudeLaneSpec>> = Object.freeze({
  implementation: Object.freeze({
    lane: "implementation",
    toolBoundaryArgs: NO_TOOL_BOUNDARY_ARGS,
    permissionMode: "acceptEdits",
    allowedTools: CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS,
    budget: "applied",
  } as ClaudeLaneSpec),
  conflict_resolution: Object.freeze({
    lane: "conflict_resolution",
    toolBoundaryArgs: NO_TOOL_BOUNDARY_ARGS,
    permissionMode: "acceptEdits",
    allowedTools: CLAUDE_CONFLICT_RESOLUTION_ALLOWED_TOOLS,
    budget: "applied",
  } as ClaudeLaneSpec),
  review: Object.freeze({
    lane: "review",
    toolBoundaryArgs: NO_TOOL_BOUNDARY_ARGS,
    budget: "not-applicable",
  } as ClaudeLaneSpec),
  no_tools: Object.freeze({
    lane: "no_tools",
    toolBoundaryArgs: CLAUDE_NO_TOOLS_ARGS,
    budget: "not-applicable",
  } as ClaudeLaneSpec),
});

/** The flag that puts the Claude CLI in non-interactive print mode. */
const PRINT_FLAG = "-p";

// ---------------------------------------------------------------------------
// Pre-invocation validation (§12.1's resolution-time gate)
// ---------------------------------------------------------------------------

/** A plain USD amount — the shape `--max-budget-usd` accepts. */
const BUDGET_AMOUNT = /^\d+(?:\.\d{1,2})?$/;

/**
 * Where an operator has to go to fix a value, phrased from its recorded source
 * (§13.2) so a refusal message points at the file or the variable rather than
 * at the resolution.
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
 * Claude CLI itself needs: a value that is present, carries no whitespace the
 * flag cannot hold, and is not flag-shaped — a value beginning with `-` would
 * be parsed as another option and silently change the invocation.
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

function requireCliSafeBudget(
  budget: ResolvedRuntimeSetting,
  value: string,
  profileName: string,
): void {
  if (!BUDGET_AMOUNT.test(value) || Number(value) <= 0) {
    throw new AgentRuntimeAdapterError(
      "unsupported-value",
      `the resolved budget ${JSON.stringify(value)} is not a positive USD amount (e.g. "10", "2.50") — ${sourceHint(budget.source, profileName)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Discovery — interpretation input only, never a gate and never a catalog feed
// ---------------------------------------------------------------------------

/**
 * How a caller asks the installed Claude CLI what it is. The caller runs
 * `<resolved binary> --version` through its own probe seam and hands the typed
 * outcome to `interpretDiscoveryProbe`, which preserves issue #897's
 * determinate/transient split. Nothing here feeds the catalog (§11.3): a
 * version banner is operator-facing detail, never a capability descriptor.
 */
export const CLAUDE_DISCOVERY: AgentRuntimeDiscoverySpec = Object.freeze({
  args: Object.freeze(["--version"]) as readonly string[],
  parse(stdout: string): { version?: string } {
    const match = /\b\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?\b/.exec(stdout);
    return match ? { version: match[0] } : {};
  },
});

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function buildClaudeInvocation(
  request: AgentInvocationRequest,
  resolved: ResolvedAgentRuntime,
): AgentInvocationPlan {
  const lane = typeof request.lane === "string" ? request.lane.trim() : "";
  if (!isClaudeLane(lane)) {
    throw new AgentRuntimeAdapterError(
      "unsupported-setting",
      `the Claude adapter has no invocation for lane "${lane}" (serves: ${CLAUDE_LANES.join(", ")})`,
    );
  }
  const spec = CLAUDE_LANE_SPECS[lane];
  const profileName = resolved.profileName;

  // The Claude CLI takes no provider-specific options today. An option that
  // reached here was declared in a capability descriptor an operator widened,
  // and honoring the profile while ignoring the option is exactly the
  // accepted-and-silently-dropped setting §12.3 forbids.
  const optionKeys = Object.keys(resolved.providerOptions ?? {});
  if (optionKeys.length > 0) {
    throw new AgentRuntimeAdapterError(
      "unsupported-setting",
      `profile "${profileName}" carries provider options (${optionKeys.sort().join(", ")}) that the Claude adapter has no invocation for`,
    );
  }

  requireCliSafeValue("binary", resolved.binary.value, resolved.binary.source, profileName);

  const args: string[] = [PRINT_FLAG, ...spec.toolBoundaryArgs];

  const model = resolved.model.value;
  if (model !== undefined) {
    requireCliSafeValue("model", model, resolved.model.source, profileName);
    args.push("--model", model);
  }

  const effort = resolved.effort.value;
  if (effort !== undefined) {
    requireCliSafeValue("effort", effort, resolved.effort.source, profileName);
    args.push("--effort", effort);
  }

  if (spec.permissionMode !== undefined) {
    args.push("--permission-mode", spec.permissionMode);
  }

  const budget = resolved.budget.value;
  if (budget !== undefined) {
    requireCliSafeBudget(resolved.budget, budget, profileName);
    if (spec.budget === "applied") {
      args.push("--max-budget-usd", budget);
    }
  }

  if (spec.allowedTools !== undefined) {
    args.push("--allowedTools", spec.allowedTools);
  }

  // Every Claude lane delivers its prompt on stdin — the argv stays free of
  // prompt content, which is what lets a resolved profile be logged verbatim.
  const prompt = request.prompt;
  return {
    command: resolved.binary.value,
    args,
    promptDelivery: prompt === undefined ? "none" : "stdin",
    ...(prompt === undefined ? {} : { stdin: prompt }),
    // Declared exactly when a budget resolved (§7 rule 1): the review and
    // no-tools lanes report "not-applicable" rather than dropping it.
    ...(budget === undefined ? {} : { budgetApplied: spec.budget }),
  };
}

/**
 * Build the adapter serving {@link CLAUDE_PROVIDER}. Pure and stateless — the
 * returned object holds no environment, no catalog, and no session, so a caller
 * may build one per process or reuse {@link CLAUDE_RUNTIME_ADAPTER}.
 */
export function createClaudeRuntimeAdapter(): AgentRuntimeAdapter {
  return Object.freeze({
    provider: CLAUDE_PROVIDER,
    defaultBinary: CLAUDE_DEFAULT_BINARY,
    envOverrides: CLAUDE_ENV_OVERRIDES,
    buildInvocation: buildClaudeInvocation,
    discovery: CLAUDE_DISCOVERY,
  });
}

/** The shared instance a composition root registers. */
export const CLAUDE_RUNTIME_ADAPTER: AgentRuntimeAdapter = createClaudeRuntimeAdapter();

/** True when a string carries a C0/C7F control character. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
