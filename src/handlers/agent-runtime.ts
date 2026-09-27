// ---------------------------------------------------------------------------
// Agent runtime resolution (issues #911, #912).
//
// This is the handler-side composition root of the B3 cutover: first for the
// phases that may modify repositories — `implementation` (both orchestration
// modes, including fix/requeue) and `conflict_resolution` (issue #911) — and,
// since issue #912, for the read-only lanes too: `review` (all three
// providers), the reviewer's reconsideration and the arbiter (`no_tools` /
// `structured_exec`), the refinement critic (`no_tools` / `read_bounded`),
// `research`, and the content lanes. It is the module that actually resolves
// an invocation through the runtime boundary of
// docs/agent-runtime-profiles-contract.md — everything below it (#904–#910)
// was landed as pure machinery.
//
// What it owns, and nothing else:
//
//   - **The registry composition.** All three provider adapters are registered
//     under the catalog's provider keys, with the shipped fail-open
//     `providerForAgent` mapping injected exactly as §7.1 prescribes (the
//     registry compensates for its fail-open echo).
//   - **The per-run resolution order of §9.3.** The catalog is read once at
//     phase start; the quality request resolves from the task's persisted
//     snapshot (with pins read live and the escalation floor applied per run);
//     the §8.1 ladder then resolves the concrete settings, and the adapter's
//     lane table turns them into sanitized invocation data.
//   - **The §13 audit pieces.** One record per resolution, projected by slice
//     B4's builder, with the appended task-context trail, the task-event
//     payload, and the run-artifact bytes prepared here so a handler persists
//     the same fact on every surface.
//   - **The configuration/transient split at the handler seam.** Every refusal
//     the boundary raises is deterministic, pre-invocation, and
//     human-actionable (issue #906); it is surfaced as the handler's ordinary
//     `{ error }` failure shape — the same path an unsupported assignment
//     takes — and never classified or retried as an agent execution failure.
//   - **The legacy source projection.** One mapping from the §13.2 source
//     vocabulary into the `modelSource`/`effortSource` vocabulary the shipped
//     run-metadata consumers read, shared by every cut-over handler so two
//     phases cannot attribute the same resolution differently.
//
// What it deliberately does NOT do: it spawns nothing (handlers keep their
// runner seams, cwd, timeouts, isolation brackets, and artifact machinery), it
// re-derives no setting from labels or session config (§7 rule 2 — the
// per-lane default chains this cutover deletes are deleted, not layered
// under), and it reads no lane input of its own (the Codex context-mode form
// is still resolved by the caller from session config, issue #376, and the
// per-spawn lane inputs — a base branch, run-owned output paths, the research
// loop's stdin-only transport — stay with the lane that owns them).
// ---------------------------------------------------------------------------

import type {
  EffectiveAgentProfileCatalog,
  QualityLevel,
} from "../core/agent-profile-catalog.js";
import { loadAgentProfileCatalog } from "../core/agent-profile-catalog.js";
import type { EffectiveQuality } from "../core/agent-quality.js";
import { qualityForPhase } from "../core/agent-quality.js";
import type {
  AgentInvocationRequest,
  AgentRuntimeAdapterRegistry,
  PlannedAgentInvocation,
  ResolvedAgentRuntime,
  ResolvedRuntimeSetting,
} from "../core/agent-runtime-adapter.js";
import {
  createAgentRuntimeAdapterRegistry,
  isAgentRuntimeConfigurationError,
  planAgentInvocation,
  readRuntimeProfilePin,
  sessionPinnedProfileFor,
} from "../core/agent-runtime-adapter.js";
import type { AgentRuntimeAuditRecord } from "../core/agent-runtime-audit.js";
import {
  AGENT_RUNTIME_AUDIT_CONTEXT_KEY,
  AGENT_RUNTIME_RESOLVED_EVENT,
  agentRuntimeAuditEventData,
  appendAgentRuntimeAuditRecord,
  buildAgentRuntimeAuditRecord,
} from "../core/agent-runtime-audit.js";
import type {
  AntigravityInvocationRequest,
  AntigravityLaneInputs,
} from "../core/antigravity-runtime-adapter.js";
import {
  ANTIGRAVITY_RUNTIME_ADAPTER,
  antigravityInvocationRequest,
} from "../core/antigravity-runtime-adapter.js";
import { CLAUDE_RUNTIME_ADAPTER } from "../core/claude-runtime-adapter.js";
import type { CodexInvocationRequest, CodexLaneInputs } from "../core/codex-runtime-adapter.js";
import { CODEX_RUNTIME_ADAPTER, codexInvocationRequest } from "../core/codex-runtime-adapter.js";
import type { PhaseHandlerEvent, PhaseHandlerResult } from "../core/phase-runner.js";
import type { ResolvedSession } from "../core/session.js";
import type { AiTask, TaskPhase } from "../core/task.js";
import { providerForAgent } from "./codex-context-mode.js";

/**
 * Build the fail-closed registry serving the cut-over lanes. All three
 * shipped provider adapters are registered; which of them a run reaches is the
 * persisted assignment's decision (`context.assignment` via `agentForPhase`),
 * never this module's.
 */
export function createAgentRuntimeRegistry(): AgentRuntimeAdapterRegistry {
  return createAgentRuntimeAdapterRegistry({
    adapters: [CLAUDE_RUNTIME_ADAPTER, CODEX_RUNTIME_ADAPTER, ANTIGRAVITY_RUNTIME_ADAPTER],
    providerForAgent,
  });
}

/**
 * The placeholder prompt used for the prompt-free argv preview below. The
 * Antigravity shape has no promptless invocation (§7.4 — `--print` must have a
 * value), so the preview plans with this stand-in and strips it back out of
 * argv; adapters never branch on prompt content, so the remaining elements are
 * exactly the argv the real prompt will ride with.
 */
const ARGV_PREVIEW_PROMPT = "[agent-runtime argv preview]";

/** One resolved phase runtime, ready to plan per-spawn invocations. */
export interface AgentPhaseRuntime {
  readonly registry: AgentRuntimeAdapterRegistry;
  readonly catalog: EffectiveAgentProfileCatalog;
  readonly quality: EffectiveQuality;
  readonly resolved: ResolvedAgentRuntime;
  /** The boundary request without a prompt; each spawn re-plans with its own. */
  readonly request: AgentInvocationRequest;
  /** The executable every plan of this run will name. */
  readonly command: string;
  /**
   * Prompt-free argv preview for run metadata — the sanitized plan's argv with
   * the preview stand-in removed, so recorded argv never carries prompt bytes.
   */
  readonly argv: readonly string[];
  /** The §13 record of this resolution (one per attempt). */
  readonly record: AgentRuntimeAuditRecord;
  /** The appended trail to persist under {@link AGENT_RUNTIME_AUDIT_CONTEXT_KEY}. */
  readonly auditContextValue: unknown;
  /** The `agent.runtime.resolved` event carrying the whole record (§13.4). */
  readonly auditEvent: PhaseHandlerEvent;
}

export interface ResolveAgentPhaseRuntimeOptions {
  readonly task: AiTask;
  readonly session: ResolvedSession;
  /** The phase whose run this is; also picks the §10.2 phase class. */
  readonly phase: TaskPhase;
  /** The adapter lane to invoke (e.g. `implementation`, `review`, `no_tools`). */
  readonly lane: string;
  /** The agent the persisted assignment (or dispute-party record) resolved. */
  readonly agentId: string;
  /** A review-loop escalation floor for this run only (§8.2, §10.3). */
  readonly escalationFloor?: QualityLevel;
  /**
   * The sessions-registry file this run resolved `session` from, when the
   * caller knows it. §9.1's default catalog location is `agent-profiles.json`
   * beside `sessions.json` — beside the file actually loaded, so a run
   * started with a custom `--sessions-path` reads the catalog next to it
   * rather than the home-directory default. Absent, the loader falls back to
   * the default sessions location.
   */
  readonly sessionsPath?: string;
  /**
   * The catalog snapshot a phase's FIRST resolution loaded, when this call is
   * that same phase resolving a second lane mid-run (the review handler's
   * `structured_exec` re-resolution). §9.3 reads the catalog once per phase
   * execution and never re-reads it mid-run — so a catalog edit landing
   * between the two resolutions must not make the invoked lane describe a
   * different file state than the recorded profile. Absent, the catalog is
   * loaded here (the phase-start read).
   */
  readonly catalog?: EffectiveAgentProfileCatalog;
  /** Codex lane inputs the caller resolved (context-mode form, base branch…). */
  readonly codex?: CodexLaneInputs;
  /** Antigravity lane inputs the caller resolved (issue #912). */
  readonly antigravity?: AntigravityLaneInputs;
  /** Environment for §8.1 layer 1 and the catalog path. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** ISO timestamp recorded on the audit record; defaults to the wall clock. */
  readonly resolvedAt?: string;
}

export type AgentPhaseRuntimeResolution =
  | { readonly runtime: AgentPhaseRuntime }
  | { readonly error: string };

/**
 * Resolve one run's runtime, fail-closed and pre-invocation.
 *
 * Everything the runtime contract can refuse — an unreadable catalog, a
 * malformed quality request, an invalid override, an undeclared pin, a lane
 * the provider's adapter does not serve — surfaces here as `{ error }`, before
 * any billable process is spawned, so handlers keep their existing
 * fail-with-artifact shape. Anything else thrown is a defect and propagates.
 */
export function resolveAgentPhaseRuntime(
  options: ResolveAgentPhaseRuntimeOptions,
): AgentPhaseRuntimeResolution {
  try {
    const env = options.env ?? process.env;
    // §9.3: the catalog is read once at phase start and never re-read mid-run;
    // every plan of this run consumes this one object. A caller resolving a
    // second lane for the same phase passes the first resolution's snapshot.
    const catalog =
      options.catalog
      ?? loadAgentProfileCatalog({
        env,
        sessionsPath: options.sessionsPath,
        sessionProfilesPath: options.session.agentRuntime?.profilesPath,
      });
    const quality = qualityForPhase(options.task, options.session, options.phase, {
      escalationFloor: options.escalationFloor,
    });
    const registry = createAgentRuntimeRegistry();
    const base: AgentInvocationRequest = {
      agentId: options.agentId,
      lane: options.lane,
      quality,
      catalog,
      env,
      taskPinnedProfile: readRuntimeProfilePin(options.task, options.agentId),
      sessionPinnedProfile: sessionPinnedProfileFor(options.session, options.agentId),
    };
    const withCodex =
      options.codex !== undefined ? codexInvocationRequest(base, options.codex) : base;
    const request =
      options.antigravity !== undefined
        ? antigravityInvocationRequest(withCodex, options.antigravity)
        : withCodex;

    // Plan once up front so every lane-level refusal (an unserved lane, a
    // provider option with no invocation, a malformed context-mode form) fires
    // before the handler does any git or worktree work, and so the run's
    // metadata records the exact argv shape its spawns will use.
    const preview = planAgentInvocation(registry, { ...request, prompt: ARGV_PREVIEW_PROMPT });
    const argv = preview.invocation.args.filter((arg) => arg !== ARGV_PREVIEW_PROMPT);

    const record = buildAgentRuntimeAuditRecord({
      resolved: preview.resolved,
      phase: options.phase,
      lane: options.lane,
      plan: preview.invocation,
      resolvedAt: options.resolvedAt ?? new Date().toISOString(),
    });
    // Computed here, inside the fail-closed gate: a persisted trail nobody can
    // read refuses before any billable run, alongside the other refusals.
    const auditContextValue = appendAgentRuntimeAuditRecord(
      options.task.context[AGENT_RUNTIME_AUDIT_CONTEXT_KEY],
      record,
    );

    return {
      runtime: {
        registry,
        catalog,
        quality,
        resolved: preview.resolved,
        request,
        command: preview.invocation.command,
        argv: Object.freeze(argv),
        record,
        auditContextValue,
        auditEvent: {
          type: AGENT_RUNTIME_RESOLVED_EVENT,
          data: agentRuntimeAuditEventData(record),
        },
      },
    };
  } catch (err) {
    if (isAgentRuntimeConfigurationError(err)) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    throw err;
  }
}

/**
 * Project the resolved binary's §13.2 source into the `cmdSource` vocabulary
 * that run metadata and the diagnostics boundary share
 * (`AgentDiagnosticOptions.cmdSource`). The adapter's compiled-in binary
 * default reads as the legacy `cli-default`; `env` and the catalog layers
 * pass through so quota classification can withhold stderr trust from an
 * operator-supplied executable — for every provider, not just the ones with a
 * legacy env override (issue #911 review).
 */
export function runtimeCmdSource(
  resolved: ResolvedAgentRuntime,
): "env" | "cli-default" | "catalog-builtin" | "catalog-overlay" {
  const source = resolved.binary.source;
  return source === "env" || source === "catalog-builtin" || source === "catalog-overlay"
    ? source
    : "cli-default";
}

/**
 * The legacy source vocabulary of the cut-over handlers' run metadata,
 * extended with the §8.1 layers the runtime boundary can now report: a profile
 * chosen by an operator pin or supplied by the `agent-profiles.json` overlay
 * is attributed to that layer instead of being folded into `default`.
 */
export type LegacyRuntimeSource =
  | "env"
  | "escalation"
  | "session-config"
  | "label"
  | "default"
  | "task-pin"
  | "catalog-overlay";

/**
 * Project one resolved setting's §13.2 source into the legacy vocabulary. A
 * catalog-supplied value is attributed to the layer that chose the profile —
 * an operator pin, the overlay file, or the quality request the labels (or
 * the review loop's escalation floor) resolved — so the recorded source keeps
 * answering the question it always has: "why did this value run?".
 */
export function legacyRuntimeSettingSource(
  setting: ResolvedRuntimeSetting,
  resolved: ResolvedAgentRuntime,
  quality: EffectiveQuality,
): LegacyRuntimeSource {
  if (setting.source === "env") return "env";
  if (setting.source !== "catalog-builtin" && setting.source !== "catalog-overlay") {
    // `cli-default`, `not-applicable`, and the adapter's compiled-in binary
    // default all read as the pre-cutover `default`.
    return "default";
  }
  if (resolved.profileSource === "task-pin") return "task-pin";
  if (resolved.profileSource === "session-config") return "session-config";
  // The overlay can override at either layer: writing the setting itself, or
  // rebinding the quality level to a different (builtin-valued) profile. Both
  // are operator overrides, so either one attributes the value to the overlay
  // before the quality request is consulted.
  if (setting.source === "catalog-overlay" || resolved.profileSource === "catalog-overlay") {
    return "catalog-overlay";
  }
  switch (quality.source) {
    case "escalation":
      return "escalation";
    case "label":
    case "compat-label":
      return "label";
    case "session-config":
      return "session-config";
    case "task-pin":
      return "task-pin";
    default:
      return "default";
  }
}

/**
 * Per-spawn lane inputs a plan may add over the resolution's own. A run-owned
 * output path exists only once its attempt's artifact file does, and the
 * research loop's stdin-only transport begins on its second turn — neither is
 * known at resolution time, so they merge over the resolved request here,
 * still upstream of the same sanitation gate every plan passes.
 */
export interface AgentPhaseLaneInputs {
  readonly codex?: CodexLaneInputs;
  readonly antigravity?: AntigravityLaneInputs;
}

/**
 * Plan one spawn's invocation: the resolution above, re-planned with the
 * actual prompt (and, when the lane owns per-spawn inputs, those inputs laid
 * over the resolved request's). Pure and deterministic — same catalog object,
 * same resolved settings — so the only thing that varies between the preview
 * and a spawn (or between a run's main and repair spawns) is the prompt and
 * the spawn-owned lane inputs.
 */
export function planAgentPhaseInvocation(
  runtime: AgentPhaseRuntime,
  prompt: string,
  laneInputs?: AgentPhaseLaneInputs,
): PlannedAgentInvocation {
  let request: AgentInvocationRequest = { ...runtime.request, prompt };
  if (laneInputs?.codex !== undefined) {
    const existing = (runtime.request as CodexInvocationRequest).codex;
    request = codexInvocationRequest(request, { ...existing, ...laneInputs.codex });
  }
  if (laneInputs?.antigravity !== undefined) {
    const existing = (runtime.request as AntigravityInvocationRequest).antigravity;
    request = antigravityInvocationRequest(request, { ...existing, ...laneInputs.antigravity });
  }
  return planAgentInvocation(runtime.registry, request);
}

/**
 * Fold the resolution's audit pieces into a handler result: the appended
 * context trail on every outcome, and the `agent.runtime.resolved` event on
 * the outcomes whose events the phase runner commits (a `failed` result
 * carries no handler-authored events by contract — the context trail and the
 * run artifact still record the attempt).
 */
export function withAgentRuntimeAudit(
  result: PhaseHandlerResult,
  runtime: AgentPhaseRuntime | undefined,
): PhaseHandlerResult {
  if (runtime === undefined) return result;
  const context: Record<string, unknown> = {
    ...(result.context ?? {}),
    [AGENT_RUNTIME_AUDIT_CONTEXT_KEY]: runtime.auditContextValue,
  };
  if (result.result === "failed") {
    return { ...result, context };
  }
  return {
    ...result,
    context,
    extraEvents: [...(result.extraEvents ?? []), runtime.auditEvent],
  };
}
