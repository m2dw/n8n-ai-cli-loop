// ---------------------------------------------------------------------------
// The agent runtime audit record (issue #910).
//
// This is slice B4 of docs/agent-runtime-profiles-contract.md §14.1: the §13
// observability half of the provider-centric runtime profile contract. B1–B3
// answered "which concrete settings does this run get?"; this module answers
// "and can anyone tell, afterwards, what was asked for and what actually ran?"
//
// One shape, every provider. The three provider adapters each carry a
// provider-shaped operator summary (`describeCodexRuntime`,
// `describeAntigravityRuntime`) whose fields differ because the providers
// differ — one folds effort into the model name, another has no budget flag.
// That asymmetry is right for a provider-facing line and wrong for an audit
// trail: a reader comparing two runs across two providers cannot compare
// records that do not have the same fields. {@link AgentRuntimeAuditRecord} is
// therefore built by ONE provider-neutral projection from
// {@link ResolvedAgentRuntime}, so "emitted consistently across Claude, Codex,
// and Gemini/Antigravity" is a structural property of the type rather than a
// discipline each adapter has to remember.
//
// What the record is, and what it deliberately is not:
//
//   - **Both halves, always** (§13.1). The semantic request (`light` …
//     `maximum`, and what asked for it) and the concrete settings (model,
//     effort, budget, binary, provider options, each with its own source) are
//     recorded together. Quality alone hides what ran; settings alone hide
//     what was asked for, and it is precisely that pairing that makes a
//     declared shared binding (§6.3) auditable instead of suspicious — a
//     `maximum` request answered by a provider's high-only profile says so,
//     naming the profile and the levels that share it, and never re-labels the
//     run with an effort tier the provider never accepted.
//   - **Absence is absence** (§13.3). An unset model is a missing field with a
//     `cli-default` source, never the string "default", and no consumer may
//     read one as proof that two runs used different models. That holds however
//     the absence was spelled: a profile whose model IS one of §13.3's
//     unresolved tokens records the source alone, so nothing downstream reads a
//     token as a model identity.
//   - **It is a projection, not a decision.** Nothing here re-derives, clamps,
//     or defaults a setting; every value comes from the resolution that
//     already happened. A record that disagrees with the invocation would be
//     worse than no record at all.
//   - **It carries no prompt, no environment, and no credential.** The type has
//     no field one could reach: not the lane's prompt, not the process
//     environment (an override contributes the SOURCE `env`, never the
//     variable's value), and not the isolation layer's credentials. Public
//     summaries additionally drop the resolved binary, which an operator's
//     break-glass variable may legitimately point at an absolute local path.
//   - **Persisting it never fails on history.** The append path treats already
//     persisted entries as opaque, so a record written by another build of
//     this loop can neither block a run nor be silently reinterpreted as this
//     version's facts. The strict reader — for operator surfaces, off the
//     critical path — is where a malformed block refuses loudly.
//
// This module writes nothing: it builds the record, the persisted projection,
// the task-event payload, the artifact bytes, and the bounded public line, and
// leaves every side effect to its caller. No lane resolves through the runtime
// boundary yet, so nothing produces a record in the shipped tree today; a lane
// cutover (§14.1 B3) is what makes these surfaces live.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import type { CatalogSource, QualityLevel } from "./agent-profile-catalog.js";
import { QUALITY_LEVELS } from "./agent-profile-catalog.js";
import type { EffectiveQualitySource, PhaseClass, QualitySource } from "./agent-quality.js";
import { PHASE_CLASSES, QUALITY_SOURCES, isQualityLevel, phaseClassForPhase } from "./agent-quality.js";
import type {
  AgentInvocationPlan,
  AgentRuntimeDiscovery,
  AgentRuntimeDiscoveryStatus,
  BudgetApplication,
  ResolvedAgentRuntime,
  RuntimeProfileSource,
  RuntimeSettingSource,
} from "./agent-runtime-adapter.js";
import {
  AGENT_RUNTIME_DISCOVERY_STATUSES,
  AgentRuntimeAdapterError,
  AgentRuntimeContractViolationError,
  BUDGET_APPLICATIONS,
  RUNTIME_PROFILE_SOURCES,
  RUNTIME_SETTING_SOURCES,
} from "./agent-runtime-adapter.js";
import { knownModel } from "./review-arbiter-profile.js";
import type { AiTask, TaskPhase } from "./task.js";
import { redactApiKeys, redactTokens, sanitizeBody } from "./text-sanitize.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The record shape's own version, independent of the catalog's schema version.
 * A record carrying a different one was written by another build of this loop:
 * it is preserved, counted, and never reinterpreted as this version's fields.
 */
export const AGENT_RUNTIME_AUDIT_RECORD_VERSION = 1;

/** Task-context key under which the bounded audit trail lives. */
export const AGENT_RUNTIME_AUDIT_CONTEXT_KEY = "agentRuntimeAudit";

/** One task event per resolved runtime (§13.4). Free-form `TaskEvent.type`. */
export const AGENT_RUNTIME_RESOLVED_EVENT = "agent.runtime.resolved";

/**
 * The run-artifact file name (§13.4: "alongside the resolved assignment").
 * Callers write it under the run's artifact directory; this module only
 * produces the bytes.
 */
export const AGENT_RUNTIME_AUDIT_ARTIFACT_FILENAME = "agent-runtime.json";

/**
 * How many records the task context keeps. Task context is replicated into
 * every backup and every restore, so the trail is bounded — but unlike the
 * append-only amendment chain of issue #1038, an audit trail's oldest entry is
 * the one worth losing, so the bound trims instead of refusing. What it trims
 * is counted in `dropped`, because a silently shortened history reads as a
 * complete one. The full record of every run also lives in the task events and
 * the run artifact, neither of which this bound touches.
 */
export const MAX_AGENT_RUNTIME_AUDIT_RECORDS = 20;

/** Bound on any single recorded string (profile, model, effort, option value). */
export const MAX_AGENT_RUNTIME_AUDIT_VALUE_CHARS = 200;

/** Bound on a discovered CLI version banner, which comes from a CLI's stdout. */
export const MAX_AGENT_RUNTIME_CLI_VERSION_CHARS = 64;

/** Bound on the sanitized public one-liner (§13.4's status-comment surface). */
export const MAX_AGENT_RUNTIME_PUBLIC_SUMMARY_CHARS = 400;

/** Bound on how many provider options one record carries. */
export const MAX_AGENT_RUNTIME_AUDIT_PROVIDER_OPTIONS = 32;

// ---------------------------------------------------------------------------
// The record (§13.2)
// ---------------------------------------------------------------------------

/**
 * What one billable agent execution resolved: the request, the profile that
 * answered it, every concrete value with its own source, the catalog revision
 * that was read, what the installed CLI turned out to be, and when the
 * resolution happened.
 *
 * The quality half is spelled out in two pairs on purpose. `requestedQuality`
 * / `requestedQualitySource` is what the TASK asked for and keeps asking for;
 * `effectiveQuality` / `effectiveQualitySource` is what this RUN resolved,
 * which differs only when a review-loop escalation floor raised it — and then
 * the run's source is `escalation` while the task's request stays exactly as it
 * was admitted (§8.2, §10.3). Collapsing the two would make "the labels asked
 * for this" and "the loop pushed this run up" the same sentence.
 */
export interface AgentRuntimeAuditRecord {
  readonly recordVersion: number;
  readonly agentId: string;
  readonly provider: string;
  /** The phase this run belongs to, when the caller named one. */
  readonly phase?: TaskPhase;
  /** Derived from `phase` via §10.2's map; never supplied independently. */
  readonly phaseClass?: PhaseClass;
  /** The adapter lane that was invoked, when the caller named one. */
  readonly lane?: string;

  /** The task's persisted request — never rewritten by an escalation. */
  readonly requestedQuality: QualityLevel;
  readonly requestedQualitySource: QualitySource;
  /** The label that decided the request; only for `label` / `compat-label`. */
  readonly requestedQualityLabel?: string;

  /** What this run resolved, after any escalation floor. */
  readonly effectiveQuality: QualityLevel;
  readonly effectiveQualitySource: EffectiveQualitySource;
  /** The floor the run was offered, whether or not it raised anything. */
  readonly escalationFloor?: QualityLevel;

  readonly profileName: string;
  readonly profileSource: RuntimeProfileSource;
  /**
   * The OTHER quality levels this provider declares against the same profile
   * (§6.3) — the run's own level is excluded, since a profile answering the
   * level it is bound to is not a shared binding. Non-empty is what makes an
   * intentional provider alias visible: a `maximum` request answered by a
   * profile the provider also binds to `strong` says so here.
   */
  readonly sharedWithQualityLevels: readonly QualityLevel[];

  readonly catalogSchemaVersion: number;
  readonly catalogVersion?: string;
  readonly catalogSource: CatalogSource;
  /** `sha256:…` over the effective catalog's values after overlay (§13.2). */
  readonly catalogDigest: string;

  readonly model?: string;
  readonly modelSource: RuntimeSettingSource;
  readonly effort?: string;
  readonly effortSource: RuntimeSettingSource;
  readonly budget?: string;
  readonly budgetSource: RuntimeSettingSource;
  /**
   * Whether the lane could express a resolved budget (§7 rule 1). Present
   * exactly when a budget resolved AND the caller supplied the invocation
   * plan: a provider CLI with no budget flag records `not-applicable` rather
   * than leaving a reader to assume the cap was in force.
   */
  readonly budgetApplied?: BudgetApplication;
  readonly binary: string;
  readonly binarySource: RuntimeSettingSource;
  readonly providerOptions: Readonly<Record<string, string>>;
  readonly providerOptionSources: Readonly<Record<string, RuntimeSettingSource>>;

  /** The installed CLI's version, when discovery established one. */
  readonly cliVersion?: string;
  /**
   * What discovery established about the installed CLI, when it ran.
   * `indeterminate` is a fact about the host at one moment and never a
   * property of the CLI (§7.1), so it contributes a status and no version.
   */
  readonly cliStatus?: AgentRuntimeDiscoveryStatus;

  /** ISO timestamp of the resolution, supplied by the caller's clock. */
  readonly resolvedAt: string;
  /** How long resolution took, when the run measured it. */
  readonly resolutionDurationMs?: number;
}

export interface BuildAgentRuntimeAuditRecordInput {
  /** The §8.1 resolution this record describes. */
  readonly resolved: ResolvedAgentRuntime;
  /** The phase whose run this is; supplies `phase` and derives `phaseClass`. */
  readonly phase?: TaskPhase;
  /** The adapter lane that was invoked. */
  readonly lane?: string;
  /**
   * The plan the adapter built, read for one field only: whether the lane
   * could express a resolved budget (§7 rule 1). Nothing else about the
   * invocation — argv, stdin, environment additions — reaches the record.
   */
  readonly plan?: Pick<AgentInvocationPlan, "budgetApplied">;
  /** An optional discovery answer from {@link interpretDiscoveryProbe}. */
  readonly discovery?: AgentRuntimeDiscovery;
  /** ISO timestamp of the resolution. */
  readonly resolvedAt: string;
  /** Measured resolution duration, when the run has one. */
  readonly resolutionDurationMs?: number;
}

/**
 * Project one resolution into the audit record.
 *
 * Pure and additive: every value comes from the resolution, the plan's one
 * budget-application flag, or the caller's clock. A malformed input is a
 * caller defect and throws {@link AgentRuntimeContractViolationError} — this
 * runs after the resolution gates, so anything malformed here was built by
 * code, not configured by an operator.
 */
export function buildAgentRuntimeAuditRecord(
  input: BuildAgentRuntimeAuditRecordInput,
): AgentRuntimeAuditRecord {
  const resolved = input?.resolved;
  if (!resolved || typeof resolved !== "object") {
    throw new AgentRuntimeContractViolationError("the audit record needs a resolved runtime");
  }
  const path = "agent runtime audit record";
  const agentId = requireIdentifier(resolved.agentId, "agentId", path);
  const provider = requireIdentifier(resolved.provider, "provider", path);
  const quality = resolved.quality;
  if (!quality || typeof quality !== "object" || !quality.requested) {
    throw new AgentRuntimeContractViolationError(
      "the resolved runtime carries no quality with its request intact",
      path,
    );
  }
  const effectiveQuality = requireQualityLevel(quality.quality, "effectiveQuality", path);
  const requestedQuality = requireQualityLevel(
    quality.requested.quality,
    "requestedQuality",
    path,
  );

  const phase = input.phase;
  const phaseClass = phase === undefined ? undefined : phaseClassOf(phase);
  if (phase !== undefined && phaseClass === undefined) {
    throw new AgentRuntimeContractViolationError(
      `"${String(phase)}" does not name a task phase`,
      path,
    );
  }
  const lane = input.lane === undefined ? undefined : requireIdentifier(input.lane, "lane", path);
  const resolvedAt = requireNonEmptyString(input.resolvedAt, "resolvedAt", path);
  const durationMs = input.resolutionDurationMs;
  if (
    durationMs !== undefined &&
    (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)
  ) {
    throw new AgentRuntimeContractViolationError(
      `resolutionDurationMs must be a non-negative number (got ${JSON.stringify(durationMs)})`,
      path,
    );
  }

  const budgetApplied = input.plan?.budgetApplied;
  if (budgetApplied !== undefined && !BUDGET_APPLICATIONS.includes(budgetApplied)) {
    throw new AgentRuntimeContractViolationError(
      `"${String(budgetApplied)}" is not a budget application (expected one of ${BUDGET_APPLICATIONS.join(", ")})`,
      path,
    );
  }

  // `indeterminate` is a fact about the host, not the CLI (§7.1): it
  // contributes a status and never a version.
  const discovery = input.discovery;
  const cliVersion =
    discovery?.status === "available" && typeof discovery.version === "string"
      ? sanitizeCliVersion(discovery.version)
      : undefined;
  const cliStatus =
    discovery !== undefined && AGENT_RUNTIME_DISCOVERY_STATUSES.includes(discovery.status)
      ? discovery.status
      : undefined;
  if (discovery !== undefined && cliStatus === undefined) {
    throw new AgentRuntimeContractViolationError(
      `"${String(discovery.status)}" is not a discovery status (expected one of ${AGENT_RUNTIME_DISCOVERY_STATUSES.join(", ")})`,
      path,
    );
  }

  const providerOptions = emptyDict<string>();
  const providerOptionSources = emptyDict<RuntimeSettingSource>();
  const optionKeys = Object.keys(resolved.providerOptions ?? {}).sort();
  if (optionKeys.length > MAX_AGENT_RUNTIME_AUDIT_PROVIDER_OPTIONS) {
    throw new AgentRuntimeContractViolationError(
      `a profile carries ${optionKeys.length} provider options; the record holds at most ${MAX_AGENT_RUNTIME_AUDIT_PROVIDER_OPTIONS}`,
      path,
    );
  }
  for (const key of optionKeys) {
    const value = resolved.providerOptions?.[key];
    if (typeof value !== "string") continue;
    providerOptions[key] = boundedValue(value);
    providerOptionSources[key] = requireSettingSource(
      resolved.providerOptionSources?.[key] ?? "catalog-builtin",
      `providerOptionSources.${key}`,
      path,
    );
  }

  const model = resolvedModelSetting(resolved.model, path);
  const effort = resolvedSetting(resolved.effort, "effort", path);
  const budget = resolvedSetting(resolved.budget, "budget", path);

  const record: AgentRuntimeAuditRecord = {
    recordVersion: AGENT_RUNTIME_AUDIT_RECORD_VERSION,
    agentId,
    provider,
    ...(phase !== undefined && phaseClass !== undefined ? { phase, phaseClass } : {}),
    ...(lane !== undefined ? { lane } : {}),

    requestedQuality,
    requestedQualitySource: requireQualitySource(
      quality.requested.source,
      "requestedQualitySource",
      path,
    ),
    ...(typeof quality.requested.label === "string" && quality.requested.label.length > 0
      ? { requestedQualityLabel: boundedValue(quality.requested.label) }
      : {}),

    effectiveQuality,
    effectiveQualitySource: requireEffectiveQualitySource(
      quality.source,
      "effectiveQualitySource",
      path,
    ),
    ...(quality.escalationFloor !== undefined
      ? { escalationFloor: requireQualityLevel(quality.escalationFloor, "escalationFloor", path) }
      : {}),

    profileName: boundedValue(requireNonEmptyString(resolved.profileName, "profileName", path)),
    profileSource: requireProfileSource(resolved.profileSource, "profileSource", path),
    sharedWithQualityLevels: sharedLevelsExcluding(
      resolved.sharedWithQualityLevels,
      effectiveQuality,
      path,
    ),

    catalogSchemaVersion: requireInteger(
      resolved.catalogSchemaVersion,
      "catalogSchemaVersion",
      path,
    ),
    ...(resolved.catalogVersion !== undefined
      ? { catalogVersion: boundedValue(String(resolved.catalogVersion)) }
      : {}),
    catalogSource: requireCatalogSource(resolved.catalogSource, "catalogSource", path),
    catalogDigest: boundedValue(requireNonEmptyString(resolved.catalogDigest, "catalogDigest", path)),

    // An unset value is an ABSENT field with a source, never the string
    // "default" and never a value this module invented (§13.3).
    ...(model.value !== undefined ? { model: model.value } : {}),
    modelSource: model.source,
    ...(effort.value !== undefined ? { effort: effort.value } : {}),
    effortSource: effort.source,
    ...(budget.value !== undefined ? { budget: budget.value } : {}),
    budgetSource: budget.source,
    ...(budgetApplied !== undefined && budget.value !== undefined ? { budgetApplied } : {}),
    binary: boundedValue(requireNonEmptyString(resolved.binary?.value, "binary", path)),
    binarySource: requireSettingSource(resolved.binary?.source, "binarySource", path),
    providerOptions: Object.freeze(providerOptions),
    providerOptionSources: Object.freeze(providerOptionSources),

    ...(cliVersion !== undefined ? { cliVersion } : {}),
    ...(cliStatus !== undefined ? { cliStatus } : {}),

    resolvedAt,
    ...(durationMs !== undefined ? { resolutionDurationMs: durationMs } : {}),
  };
  return Object.freeze(record);
}

function resolvedSetting(
  setting: { value?: string; source: RuntimeSettingSource } | undefined,
  key: string,
  path: string,
): { value?: string; source: RuntimeSettingSource } {
  const source = requireSettingSource(setting?.source, `${key}Source`, path);
  const value = setting?.value;
  return typeof value === "string" && value.length > 0
    ? { value: boundedValue(value), source }
    : { source };
}

/**
 * The model, with §13.3's unresolved tokens read as the absence they are.
 *
 * A profile may spell "no model was selected" as a literal string rather than
 * by omitting the field — an accepted overlay setting `model: "default"`, or a
 * lane recording `cli-default` because the CLI's own configuration decides.
 * §13.3 names {@link knownModel}'s vocabulary (`cli-default`, `n/a`, `unknown`,
 * `default`, `unset`) as authoritative for exactly this: those strings are not
 * model names, and recording one as `model` would publish an absence as a model
 * identity — which is also what would let a later reader take two
 * differently-spelled absences as proof of two different models, the inference
 * §13.5 keeps forbidden.
 *
 * Only the token is dropped. The provenance survives untouched, so a record
 * still says whether the absence came from the built-in catalog, an accepted
 * overlay, or an operator's variable, and the public line prints the source's
 * "provider default" rather than a value.
 */
function resolvedModelSetting(
  setting: { value?: string; source: RuntimeSettingSource } | undefined,
  path: string,
): { value?: string; source: RuntimeSettingSource } {
  const projected = resolvedSetting(setting, "model", path);
  const value = unresolvedModelAsAbsence(projected.value);
  return value !== undefined ? { value, source: projected.source } : { source: projected.source };
}

/** A model string, or `undefined` when it is one of §13.3's absence tokens. */
function unresolvedModelAsAbsence(value: string | undefined): string | undefined {
  return value !== undefined && knownModel(value) === null ? undefined : value;
}

/**
 * §10.2's phase-to-class map, read as a lookup that can miss. The map is a
 * total record over `TaskPhase`, so its return type says a class always
 * exists — which is true for a phase the type system vouched for, and not for
 * a string that came off a persisted record or a JavaScript caller. The answer
 * is checked against the closed class vocabulary rather than for truthiness,
 * so an inherited property name (`constructor`) cannot masquerade as a class.
 */
function phaseClassOf(phase: TaskPhase): PhaseClass | undefined {
  const resolved = phaseClassForPhase(phase) as unknown;
  return (PHASE_CLASSES as readonly string[]).includes(resolved as string)
    ? (resolved as PhaseClass)
    : undefined;
}

/**
 * The §6.3 shared levels, minus the run's own level and in the contract's
 * ordering. The resolution engine reports the pin path's list including the
 * run's level and the binding path's list excluding it; recording one
 * normalized answer keeps "this level shares a profile with those levels" a
 * single fact rather than one that depends on which §8.1 layer chose it.
 */
function sharedLevelsExcluding(
  raw: readonly QualityLevel[] | undefined,
  level: QualityLevel,
  path: string,
): readonly QualityLevel[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    throw new AgentRuntimeContractViolationError(
      "sharedWithQualityLevels must be an array of quality levels",
      path,
    );
  }
  const present = new Set<string>();
  for (const value of raw) {
    if (!isQualityLevel(value)) {
      throw new AgentRuntimeContractViolationError(
        `sharedWithQualityLevels carries ${JSON.stringify(value)}, which is not a quality level`,
        path,
      );
    }
    if (value !== level) present.add(value);
  }
  return Object.freeze(QUALITY_LEVELS.filter((candidate) => present.has(candidate)));
}

// ---------------------------------------------------------------------------
// Task events and run artifacts (§13.4)
// ---------------------------------------------------------------------------

/**
 * The `TaskEvent.data` payload for {@link AGENT_RUNTIME_RESOLVED_EVENT}: the
 * whole record, which is internal metadata and may stay whole (§13.4). It is
 * already free of prompts, environment values, and credentials by
 * construction, so nothing is dropped here that an operator would want.
 */
export function agentRuntimeAuditEventData(
  record: AgentRuntimeAuditRecord,
): Record<string, unknown> {
  return { ...record } as Record<string, unknown>;
}

/** The run-artifact bytes for {@link AGENT_RUNTIME_AUDIT_ARTIFACT_FILENAME}. */
export function serializeAgentRuntimeAuditRecord(record: AgentRuntimeAuditRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Persistence on the task
// ---------------------------------------------------------------------------

/** The persisted block written under {@link AGENT_RUNTIME_AUDIT_CONTEXT_KEY}. */
export interface PersistedAgentRuntimeAuditLog {
  /**
   * Newest last. Entries are opaque to the append path: a record written by
   * another build of this loop is carried forward untouched rather than being
   * reinterpreted or discarded.
   */
  readonly records: readonly unknown[];
  /** How many entries the bound has trimmed over this task's life. */
  readonly dropped: number;
}

/** The strict reader's answer, for operator surfaces (never a run's path). */
export interface AgentRuntimeAuditLog {
  /** Fully validated records at this binary's {@link AGENT_RUNTIME_AUDIT_RECORD_VERSION}. */
  readonly records: readonly AgentRuntimeAuditRecord[];
  /** How many entries the bound has trimmed over this task's life. */
  readonly dropped: number;
  /**
   * Entries written at another record version. They are preserved in context
   * and counted here rather than being presented as this version's facts — an
   * older or newer build's record is history, not a reading this binary can
   * vouch for.
   */
  readonly unreadable: number;
}

export interface AppendAgentRuntimeAuditRecordOptions {
  /** Override the persisted bound; defaults to {@link MAX_AGENT_RUNTIME_AUDIT_RECORDS}. */
  readonly limit?: number;
}

/**
 * Append one record to the persisted trail and return the value to write back
 * under {@link AGENT_RUNTIME_AUDIT_CONTEXT_KEY}.
 *
 * `existing` is the raw context value, read as written. Absent starts a fresh
 * trail; a block whose shape does not parse refuses (`invalid-override`),
 * because something explicit wrote it and silently replacing it would discard
 * the very history this key exists to keep. Individual entries are NOT parsed:
 * appending must never fail because a previous build wrote a record this one
 * does not understand.
 */
export function appendAgentRuntimeAuditRecord(
  existing: unknown,
  record: AgentRuntimeAuditRecord,
  options: AppendAgentRuntimeAuditRecordOptions = {},
): PersistedAgentRuntimeAuditLog {
  const limit = options.limit ?? MAX_AGENT_RUNTIME_AUDIT_RECORDS;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgentRuntimeContractViolationError(
      `the audit trail bound must be a positive integer (got ${JSON.stringify(options.limit)})`,
    );
  }
  const block = rawAuditBlock(existing);
  const records = [...block.records, record];
  const overflow = Math.max(0, records.length - limit);
  return Object.freeze({
    records: Object.freeze(records.slice(overflow)) as readonly unknown[],
    dropped: block.dropped + overflow,
  });
}

/**
 * Read the persisted trail strictly, for an operator-facing surface. Absence
 * is the normal case and reads as `undefined`; a malformed block refuses, for
 * the same reason a malformed quality snapshot does — something wrote a record
 * nobody can read, and reporting it as an empty history would be the silent
 * answer §12.3 forbids.
 */
export function readAgentRuntimeAuditLog(task: AiTask): AgentRuntimeAuditLog | undefined {
  const raw = task?.context?.[AGENT_RUNTIME_AUDIT_CONTEXT_KEY];
  if (raw === undefined || raw === null) return undefined;
  const block = rawAuditBlock(raw);
  const path = `context.${AGENT_RUNTIME_AUDIT_CONTEXT_KEY}`;
  const records: AgentRuntimeAuditRecord[] = [];
  let unreadable = 0;
  block.records.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AgentRuntimeAdapterError(
        "invalid-override",
        `records[${index}] must be an object`,
        path,
      );
    }
    const version = (entry as { recordVersion?: unknown }).recordVersion;
    if (version !== AGENT_RUNTIME_AUDIT_RECORD_VERSION) {
      unreadable += 1;
      return;
    }
    records.push(parseAuditRecord(entry as Record<string, unknown>, `${path}.records[${index}]`));
  });
  return Object.freeze({
    records: Object.freeze(records) as readonly AgentRuntimeAuditRecord[],
    dropped: block.dropped,
    unreadable,
  });
}

/** The most recent readable record, when the task carries one. */
export function latestAgentRuntimeAuditRecord(task: AiTask): AgentRuntimeAuditRecord | undefined {
  const log = readAgentRuntimeAuditLog(task);
  if (!log || log.records.length === 0) return undefined;
  return log.records[log.records.length - 1];
}

function rawAuditBlock(raw: unknown): { records: readonly unknown[]; dropped: number } {
  const path = `context.${AGENT_RUNTIME_AUDIT_CONTEXT_KEY}`;
  if (raw === undefined || raw === null) return { records: [], dropped: 0 };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      "must be an object with a records array",
      path,
    );
  }
  const records = (raw as { records?: unknown }).records;
  if (!Array.isArray(records)) {
    throw new AgentRuntimeAdapterError("invalid-override", "records must be an array", path);
  }
  const dropped = (raw as { dropped?: unknown }).dropped;
  if (dropped !== undefined && (!Number.isInteger(dropped) || (dropped as number) < 0)) {
    throw new AgentRuntimeAdapterError(
      "invalid-override",
      "dropped must be a non-negative integer",
      path,
    );
  }
  return { records: records as readonly unknown[], dropped: (dropped as number | undefined) ?? 0 };
}

function parseAuditRecord(raw: Record<string, unknown>, path: string): AgentRuntimeAuditRecord {
  const refuse = (message: string): never => {
    throw new AgentRuntimeAdapterError("invalid-override", message, path);
  };
  const text = (key: string, required: boolean): string | undefined => {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (required) refuse(`${key} must be a non-empty string`);
      return undefined;
    }
    if (typeof value !== "string" || value.length === 0) refuse(`${key} must be a non-empty string`);
    return value as string;
  };
  const level = (key: string, required: boolean): QualityLevel | undefined => {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (required) refuse(`${key} must be one of ${QUALITY_LEVELS.join(", ")}`);
      return undefined;
    }
    if (!isQualityLevel(value)) refuse(`${key} must be one of ${QUALITY_LEVELS.join(", ")}`);
    return value as QualityLevel;
  };
  const member = <T extends string>(
    key: string,
    vocabulary: readonly T[],
    required: boolean,
  ): T | undefined => {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (required) refuse(`${key} must be one of ${vocabulary.join(", ")}`);
      return undefined;
    }
    if (typeof value !== "string" || !(vocabulary as readonly string[]).includes(value)) {
      refuse(`${key} must be one of ${vocabulary.join(", ")}`);
    }
    return value as T;
  };
  const count = (key: string, required: boolean): number | undefined => {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (required) refuse(`${key} must be a non-negative number`);
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      refuse(`${key} must be a non-negative number`);
    }
    return value as number;
  };

  const effectiveQuality = level("effectiveQuality", true) as QualityLevel;
  const shared = raw["sharedWithQualityLevels"];
  if (shared !== undefined && !Array.isArray(shared)) {
    refuse("sharedWithQualityLevels must be an array");
  }
  for (const entry of (shared as readonly unknown[] | undefined) ?? []) {
    if (!isQualityLevel(entry)) {
      refuse(`sharedWithQualityLevels carries ${JSON.stringify(entry)}, which is not a quality level`);
    }
  }
  const phase = raw["phase"] as TaskPhase | undefined;
  const phaseClass = phase === undefined ? undefined : phaseClassOf(phase);
  if (phase !== undefined && phaseClass === undefined) {
    refuse(`phase "${String(phase)}" does not name a task phase`);
  }
  const options = raw["providerOptions"];
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    refuse("providerOptions must be an object");
  }
  const optionSources = raw["providerOptionSources"];
  if (
    optionSources !== undefined &&
    (typeof optionSources !== "object" || optionSources === null || Array.isArray(optionSources))
  ) {
    refuse("providerOptionSources must be an object");
  }

  const providerOptions = emptyDict<string>();
  const providerOptionSources = emptyDict<RuntimeSettingSource>();
  for (const [key, value] of Object.entries((options as Record<string, unknown>) ?? {})) {
    if (typeof value !== "string") refuse(`providerOptions.${key} must be a string`);
    providerOptions[key] = value as string;
    const source = ((optionSources as Record<string, unknown>) ?? {})[key];
    if (!(RUNTIME_SETTING_SOURCES as readonly string[]).includes(source as string)) {
      refuse(`providerOptionSources.${key} must be one of ${RUNTIME_SETTING_SOURCES.join(", ")}`);
    }
    providerOptionSources[key] = source as RuntimeSettingSource;
  }

  // §13.3 once more on the way back out: a version-1 record another build wrote
  // may still spell an absence as a token, and this binary hands out no record
  // that presents one as a model identity. The persisted entry is untouched —
  // only this reading drops the token, keeping its source.
  const model = unresolvedModelAsAbsence(text("model", false));
  const effort = text("effort", false);
  const budget = text("budget", false);
  const budgetApplied = member("budgetApplied", BUDGET_APPLICATIONS, false);
  const cliVersion = text("cliVersion", false);
  const cliStatus = member("cliStatus", AGENT_RUNTIME_DISCOVERY_STATUSES, false);
  const catalogVersion = text("catalogVersion", false);
  const lane = text("lane", false);
  const requestedQualityLabel = text("requestedQualityLabel", false);
  const escalationFloor = level("escalationFloor", false);
  const duration = count("resolutionDurationMs", false);

  return Object.freeze({
    recordVersion: AGENT_RUNTIME_AUDIT_RECORD_VERSION,
    agentId: text("agentId", true) as string,
    provider: text("provider", true) as string,
    ...(phase !== undefined && phaseClass !== undefined ? { phase, phaseClass } : {}),
    ...(lane !== undefined ? { lane } : {}),
    requestedQuality: level("requestedQuality", true) as QualityLevel,
    requestedQualitySource: member("requestedQualitySource", QUALITY_SOURCES, true) as QualitySource,
    ...(requestedQualityLabel !== undefined ? { requestedQualityLabel } : {}),
    effectiveQuality,
    effectiveQualitySource: member(
      "effectiveQualitySource",
      EFFECTIVE_QUALITY_SOURCES,
      true,
    ) as EffectiveQualitySource,
    ...(escalationFloor !== undefined ? { escalationFloor } : {}),
    profileName: text("profileName", true) as string,
    profileSource: member("profileSource", RUNTIME_PROFILE_SOURCES, true) as RuntimeProfileSource,
    sharedWithQualityLevels: sharedLevelsExcluding(
      (shared as readonly QualityLevel[] | undefined) ?? [],
      effectiveQuality,
      path,
    ),
    catalogSchemaVersion: count("catalogSchemaVersion", true) as number,
    ...(catalogVersion !== undefined ? { catalogVersion } : {}),
    catalogSource: member("catalogSource", CATALOG_SOURCES, true) as CatalogSource,
    catalogDigest: text("catalogDigest", true) as string,
    ...(model !== undefined ? { model } : {}),
    modelSource: member("modelSource", RUNTIME_SETTING_SOURCES, true) as RuntimeSettingSource,
    ...(effort !== undefined ? { effort } : {}),
    effortSource: member("effortSource", RUNTIME_SETTING_SOURCES, true) as RuntimeSettingSource,
    ...(budget !== undefined ? { budget } : {}),
    budgetSource: member("budgetSource", RUNTIME_SETTING_SOURCES, true) as RuntimeSettingSource,
    ...(budgetApplied !== undefined ? { budgetApplied } : {}),
    binary: text("binary", true) as string,
    binarySource: member("binarySource", RUNTIME_SETTING_SOURCES, true) as RuntimeSettingSource,
    providerOptions: Object.freeze(providerOptions),
    providerOptionSources: Object.freeze(providerOptionSources),
    ...(cliVersion !== undefined ? { cliVersion } : {}),
    ...(cliStatus !== undefined ? { cliStatus } : {}),
    resolvedAt: text("resolvedAt", true) as string,
    ...(duration !== undefined ? { resolutionDurationMs: duration } : {}),
  });
}

/** §8.2's task-level sources plus the one that exists only for a run (§10.3). */
const EFFECTIVE_QUALITY_SOURCES: readonly EffectiveQualitySource[] = [
  ...QUALITY_SOURCES,
  "escalation",
];

const CATALOG_SOURCES: readonly CatalogSource[] = ["builtin", "file"];

// ---------------------------------------------------------------------------
// The public summary (§13.4)
// ---------------------------------------------------------------------------

export interface PublicAgentRuntimeSummaryOptions {
  /** Bound on the returned line; defaults to {@link MAX_AGENT_RUNTIME_PUBLIC_SUMMARY_CHARS}. */
  readonly maxChars?: number;
}

/**
 * The bounded, sanitized line a public status comment carries (§13.4), so a
 * reviewer sees both halves — what was asked for and what actually ran —
 * without reading internal state.
 *
 * Four rules make this safe to publish and honest to read:
 *
 *   1. **Concrete settings are quoted, never translated.** The line prints the
 *      effort the provider resolved, never a word derived from the quality
 *      level. A `maximum` request answered by a provider profile that tops out
 *      at `high` therefore reads as `maximum` requested and `high` effort, with
 *      the shared binding named — it can never be presented as an `xhigh` run
 *      the provider never performed.
 *   2. **A pin is described as a pin, never as a binding.** The shared-binding
 *      sentence is the catalog's claim, so it is only made about a profile the
 *      catalog chose. A pinned profile is named as pinned, and the levels the
 *      provider binds to it are reported without folding this run's level in —
 *      pinning `claude-light` for a `normal` run does not make the provider
 *      bind `normal` to `claude-light`.
 *   3. **An absence stays an absence.** A setting the provider CLI defaulted
 *      reads as "provider default"; a setting the provider does not accept at
 *      all is omitted entirely. Neither is ever rendered as a value (§13.3).
 *   4. **Nothing local, nothing secret.** The resolved binary is omitted — a
 *      break-glass variable may point it at an absolute local path — and every
 *      value that IS printed passes through the shared path/token/key
 *      redactors before the line is bounded.
 */
export function publicAgentRuntimeSummary(
  record: AgentRuntimeAuditRecord,
  options: PublicAgentRuntimeSummaryOptions = {},
): string {
  const maxChars = options.maxChars ?? MAX_AGENT_RUNTIME_PUBLIC_SUMMARY_CHARS;
  const parts: string[] = [`agent ${record.agentId} (${record.provider})`];

  const requested = `quality: ${record.requestedQuality} requested ${requestPhrase(record)}`;
  parts.push(
    record.effectiveQualitySource === "escalation"
      ? `${requested}, raised to ${record.effectiveQuality} by the review-loop floor`
      : requested,
  );

  parts.push(`profile ${record.profileName}${profileClause(record)}`);

  const settings = [
    settingPhrase("model", record.model, record.modelSource),
    settingPhrase("effort", record.effort, record.effortSource),
    budgetPhrase(record),
  ].filter((phrase): phrase is string => phrase !== undefined);
  if (settings.length > 0) parts.push(settings.join(", "));

  return boundedLine(sanitizePublicText(parts.join(" — ")), maxChars);
}

/**
 * One line, never more: the summary rides inside a status comment, so a value
 * carrying a newline may not restructure the comment around it, and the bound
 * includes the ellipsis rather than being exceeded by it.
 */
function boundedLine(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new AgentRuntimeContractViolationError(
      `the public summary bound must be a positive integer (got ${JSON.stringify(maxChars)})`,
    );
  }
  if (single.length <= maxChars) return single;
  return `${single.slice(0, maxChars - 1).trimEnd()}…`;
}

function requestPhrase(record: AgentRuntimeAuditRecord): string {
  switch (record.requestedQualitySource) {
    case "task-pin":
      return "by an operator pin";
    case "label":
    case "compat-label":
      return record.requestedQualityLabel !== undefined
        ? `by label ${record.requestedQualityLabel}`
        : "by a label";
    case "session-config":
      return "by the session default";
    default:
      return "by default";
  }
}

/**
 * What follows the profile name, and it depends on which §8.1 layer chose the
 * profile — because only one of them says anything about a *binding*.
 *
 * When the CATALOG chose it, the run's level is bound to that profile by
 * definition, so naming the run's level alongside the other levels that share
 * it is the §6.3 fact a reviewer needs: a `maximum` request answered by a
 * profile the provider also binds to `strong` reads as exactly that.
 *
 * When an operator PINNED it, no binding chose it, and the run's level may bind
 * somewhere else entirely. Adding the run's level to the shared list there
 * would state a binding the catalog does not declare — a `normal` run pinned to
 * `claude-light` would read as "this provider binds normal and light to the
 * same profile" while `normal` in fact binds to `claude-normal`. The pin is
 * therefore named as a pin, and whatever levels the catalog *does* bind to the
 * pinned profile are reported separately, as the catalog's own fact.
 */
function profileClause(record: AgentRuntimeAuditRecord): string {
  const shared = record.sharedWithQualityLevels;
  const pin = pinPhrase(record.profileSource);
  if (pin !== undefined) {
    return shared.length > 0
      ? ` (${pin}; this provider binds ${shared.join(" and ")} to it)`
      : ` (${pin})`;
  }
  return shared.length > 0
    ? ` (this provider binds ${[record.effectiveQuality, ...shared].join(" and ")} to the same profile)`
    : "";
}

/** Names the pin that chose the profile, or `undefined` for a catalog binding. */
function pinPhrase(source: RuntimeProfileSource): string | undefined {
  switch (source) {
    case "task-pin":
      return "pinned by an operator";
    case "session-config":
      return "pinned by the session default";
    default:
      return undefined;
  }
}

function settingPhrase(
  key: string,
  value: string | undefined,
  source: RuntimeSettingSource,
): string | undefined {
  // A setting the provider does not declare at all is not a fact about this
  // run; printing "not applicable" would only invite the reader to wonder
  // which value was suppressed.
  if (source === "not-applicable") return undefined;
  if (value === undefined) return `${key}: provider default`;
  return `${key} ${value}${source === "env" ? " (operator override)" : ""}`;
}

function budgetPhrase(record: AgentRuntimeAuditRecord): string | undefined {
  const phrase = settingPhrase("budget", record.budget, record.budgetSource);
  if (phrase === undefined || record.budget === undefined) return phrase;
  const amount = `budget $${record.budget}${record.budgetSource === "env" ? " (operator override)" : ""}`;
  // §7 rule 1: a cap the lane could not express is stated, never implied to
  // have been in force.
  return record.budgetApplied === "not-applicable"
    ? `${amount} (this CLI has no budget flag; not applied)`
    : amount;
}

function sanitizePublicText(text: string): string {
  return redactApiKeys(redactTokens(sanitizeBody(text)));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, key: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentRuntimeContractViolationError(
      `${key} must be a non-empty string (got ${JSON.stringify(value)})`,
      path,
    );
  }
  return value.trim();
}

function requireIdentifier(value: unknown, key: string, path: string): string {
  const text = requireNonEmptyString(value, key, path);
  if (hasControlCharacter(text)) {
    throw new AgentRuntimeContractViolationError(`${key} must not contain control characters`, path);
  }
  return boundedValue(text);
}

function requireInteger(value: unknown, key: string, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AgentRuntimeContractViolationError(
      `${key} must be a non-negative integer (got ${JSON.stringify(value)})`,
      path,
    );
  }
  return value;
}

function requireQualityLevel(value: unknown, key: string, path: string): QualityLevel {
  if (!isQualityLevel(value)) {
    throw new AgentRuntimeContractViolationError(
      `${key} must be one of ${QUALITY_LEVELS.join(", ")} (got ${JSON.stringify(value)})`,
      path,
    );
  }
  return value;
}

function requireQualitySource(value: unknown, key: string, path: string): QualitySource {
  if (typeof value !== "string" || !(QUALITY_SOURCES as readonly string[]).includes(value)) {
    throw new AgentRuntimeContractViolationError(
      `${key} must be one of ${QUALITY_SOURCES.join(", ")} (got ${JSON.stringify(value)})`,
      path,
    );
  }
  return value as QualitySource;
}

function requireEffectiveQualitySource(
  value: unknown,
  key: string,
  path: string,
): EffectiveQualitySource {
  if (typeof value !== "string" || !(EFFECTIVE_QUALITY_SOURCES as readonly string[]).includes(value)) {
    throw new AgentRuntimeContractViolationError(
      `${key} must be one of ${EFFECTIVE_QUALITY_SOURCES.join(", ")} (got ${JSON.stringify(value)})`,
      path,
    );
  }
  return value as EffectiveQualitySource;
}

function requireSettingSource(value: unknown, key: string, path: string): RuntimeSettingSource {
  if (typeof value !== "string" || !(RUNTIME_SETTING_SOURCES as readonly string[]).includes(value)) {
    throw new AgentRuntimeContractViolationError(
      `${key} must be one of ${RUNTIME_SETTING_SOURCES.join(", ")} (got ${JSON.stringify(value)})`,
      path,
    );
  }
  return value as RuntimeSettingSource;
}

function requireCatalogSource(value: unknown, key: string, path: string): CatalogSource {
  if (typeof value !== "string" || !(CATALOG_SOURCES as readonly string[]).includes(value)) {
    throw new AgentRuntimeContractViolationError(
      `${key} must be one of ${CATALOG_SOURCES.join(", ")} (got ${JSON.stringify(value)})`,
      path,
    );
  }
  return value as CatalogSource;
}

function requireProfileSource(value: unknown, key: string, path: string): RuntimeProfileSource {
  if (typeof value !== "string" || !(RUNTIME_PROFILE_SOURCES as readonly string[]).includes(value)) {
    throw new AgentRuntimeContractViolationError(
      `${key} must be one of ${RUNTIME_PROFILE_SOURCES.join(", ")} (got ${JSON.stringify(value)})`,
      path,
    );
  }
  return value as RuntimeProfileSource;
}

/**
 * Bound one recorded value without silently changing what ran.
 *
 * The bound exists because the trail is replicated into every backup and every
 * restore, not because a long value is untrustworthy — so a value over the
 * bound may not simply be replaced by its prefix. Two accepted `ANTIGRAVITY_BIN`
 * paths that differ only after character 200 would then record the same binary,
 * and neither recorded string would name the executable that actually ran: a
 * presentation bound would have quietly rewritten a runtime identity, which is
 * the one thing this record exists to preserve.
 *
 * A value over the bound is therefore recorded as its prefix PLUS a marker
 * carrying the original length and a SHA-256 of the whole value. The record
 * says out loud that it is truncated, distinct values keep distinct records,
 * and a reader holding a candidate path can confirm or refute it by hashing.
 * Resolution already refused control characters, so the prefix needs no
 * further sanitation.
 */
function boundedValue(value: string): string {
  if (value.length <= MAX_AGENT_RUNTIME_AUDIT_VALUE_CHARS) return value;
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
  const marker = `…[truncated: ${value.length} chars, sha256:${digest}]`;
  const keep = Math.max(0, MAX_AGENT_RUNTIME_AUDIT_VALUE_CHARS - marker.length);
  let prefix = value.slice(0, keep);
  // Never end the prefix on half a surrogate pair: a lone half is not a
  // character, and it would make the recorded prefix unprintable.
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}

/**
 * A version banner comes from a CLI's stdout rather than from the catalog, so
 * it is the one recorded value this module treats as untrusted text: bounded,
 * stripped of control characters, and passed through the shared redactors
 * before it is persisted anywhere.
 */
function sanitizeCliVersion(value: string): string | undefined {
  const stripped = Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  if (stripped.length === 0) return undefined;
  const safe = sanitizePublicText(stripped);
  return safe.length > MAX_AGENT_RUNTIME_CLI_VERSION_CHARS
    ? safe.slice(0, MAX_AGENT_RUNTIME_CLI_VERSION_CHARS)
    : safe;
}

/** A dictionary with no prototype, so persisted keys cannot alias `Object.prototype`. */
function emptyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** True when a string carries a C0/C7F control character. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
