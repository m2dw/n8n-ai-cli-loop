/**
 * Chain-aware progressive Issue refinement — state and intake foundation
 * (issue #867, docs/issue-refinement-contract.md).
 *
 * This module owns the contract's **vocabulary**, its **normative limits**
 * (§8), its **admission decision** (§12 rows 1, 2, 47), and the shape of the
 * `task.context.refinement` block (§15). It is deliberately pure: it reads no
 * GitHub state, spawns no agent, and writes no Issue body — the slice that
 * lands here creates and persists refinement state only.
 *
 * Three properties matter more than they look:
 *
 *  - **Admission is a pure label test.** §4 decides condition 1 on
 *    `intake.scanned`, before any task exists and before any relationship
 *    query. That is what lets {@link evaluateRefinementAdmission} be a pure
 *    function of the label set, and what keeps a refusal (rows 2 and 47) from
 *    costing a GitHub read. Conditions 2–5 — the predecessor resolution of
 *    rows 3–7 — are a later slice and are represented here only by the empty
 *    `predecessors` list and the `pending` state the block is created in.
 *  - **Both refusals fail closed.** The marker beside an executable status is
 *    an operator mistake or a half-applied transition, and guessing which one
 *    wins is exactly how a rough Issue reaches implementation (§3). The marker
 *    with no implementation-lane `agent:*` label is refused for the mirror
 *    reason: activation hands the Issue back to ORDINARY intake (§11 step 7),
 *    which routes on the pair `agent:*` + `status:needs-implementation`, so
 *    admitting it would run the whole lane and then park a row nothing could
 *    reactivate.
 *  - **The deferred implementation assignment is data, not labels.** §14 keeps
 *    the target owner in `context.assignment` and records the whole activation
 *    as an explicit {@link RefinementActivationPlan}, so "what happens after
 *    refinement" is inspectable and testable long before any of it runs.
 */

import { createHash } from "crypto";
import type { AgentId, AiTask, TaskPhase, TaskStatus } from "./task.js";
import type { IssueRefinementConfig, IssueRefinementLimitsConfig, SessionLabels } from "./session.js";

// ---------------------------------------------------------------------------
// §1 Canonical vocabulary
//
// These literals are normative: the contract requires them verbatim in code,
// JSON output, audit events, and tests.
// ---------------------------------------------------------------------------

/** §1 refinement states, persisted at `task.context.refinement.state`. */
export const REFINEMENT_STATES = [
  "pending",
  "eligible",
  "drafting",
  "critiquing",
  "accepted",
  "applying",
  "activated",
  "escalated_human",
] as const;

export type RefinementState = (typeof REFINEMENT_STATES)[number];

/** §1: `activated` and `escalated_human` are terminal. */
export const TERMINAL_REFINEMENT_STATES: ReadonlySet<RefinementState> = new Set<RefinementState>([
  "activated",
  "escalated_human",
]);

export function isRefinementState(value: unknown): value is RefinementState {
  return typeof value === "string" && (REFINEMENT_STATES as readonly string[]).includes(value);
}

/** §1 critic verdicts (closed set, exactly three). */
export const REFINEMENT_CRITIC_VERDICTS = ["pass", "revise", "block"] as const;
export type RefinementCriticVerdict = (typeof REFINEMENT_CRITIC_VERDICTS)[number];

/** §1 change classes (closed set, exactly two). */
export const REFINEMENT_CHANGE_CLASSES = ["applicable", "advisory"] as const;
export type RefinementChangeClass = (typeof REFINEMENT_CHANGE_CLASSES)[number];

/** §1 topology-proposal dispositions (closed set, exactly two). */
export const REFINEMENT_TOPOLOGY_DISPOSITIONS = ["advisory", "blocking"] as const;
export type RefinementTopologyDisposition = (typeof REFINEMENT_TOPOLOGY_DISPOSITIONS)[number];

/**
 * §1 refusal reasons (closed set, exactly three). A refusal is recorded by an
 * eligibility evaluation that creates no task or holds the Issue — never a
 * handoff, because there is no task to hand off.
 */
export const REFINEMENT_REFUSAL_REASONS = [
  "conflicting_markers",
  "no_implementation_agent",
  "predecessor_not_ready",
] as const;
export type RefinementRefusalReason = (typeof REFINEMENT_REFUSAL_REASONS)[number];

/** §1 handoff reasons (closed set). Recorded on a task that already exists. */
export const REFINEMENT_HANDOFF_REASONS = [
  "fan_in_exceeded",
  "chain_disagreement",
  "not_chain_scoped",
  "malformed_refiner_output",
  "malformed_critic_output",
  "topology_change_required",
  "no_convergence",
  "critique_blocked",
  "stale_inputs",
  "unexpected_managed_region",
  "malformed_managed_region",
  "managed_region_modified",
  "no_independent_critic",
  "effect_undeliverable",
  "agent_unavailable",
  "marker_precondition_failed",
  "execution_marker_conflict",
] as const;
export type RefinementHandoffReason = (typeof REFINEMENT_HANDOFF_REASONS)[number];

export function isRefinementHandoffReason(value: unknown): value is RefinementHandoffReason {
  return typeof value === "string" && (REFINEMENT_HANDOFF_REASONS as readonly string[]).includes(value);
}

/**
 * §1 executable `status:*` labels — the closed six-member set the intake router
 * (`labelsToPhase`) maps to a runnable phase.
 *
 * The list is normative and complete. `status:needs-fix` in particular is the
 * route the router checks FIRST, so a conflict guard derived from a shorter
 * list would still admit a rough Issue into fix mode — the precise failure §3
 * exists to prevent. `status:needs-refinement` is deliberately not a member.
 */
export const EXECUTABLE_STATUS_LABELS: readonly string[] = [
  "status:needs-fix",
  "status:needs-review",
  "status:research-needed",
  "status:content-needed",
  "status:needs-implementation",
  "status:needs-conflict-resolution",
];

/**
 * §3: the `agent:*` labels the IMPLEMENTATION lane of `labelsToPhase`
 * recognises, in that lane's own precedence order.
 *
 * Which one wins when several are present is deliberately not a refinement-lane
 * decision — this mirrors the new-implementation lane of `labelsToPhase`
 * (claude, then codex, then gemini) rather than re-deciding it, so the owner the
 * refinement lane records is the owner ordinary intake would pick.
 */
export const IMPLEMENTATION_LANE_AGENT_LABELS: ReadonlyArray<{ label: string; agent: AgentId }> = [
  { label: "agent:claude", agent: "claude" },
  { label: "agent:codex", agent: "codex" },
  { label: "agent:gemini", agent: "gemini" },
];

/** §3 default coarse human-facing marker. Overridable via `session.labels`. */
export const DEFAULT_REFINEMENT_MARKER_LABEL = "status:needs-refinement";

/**
 * §11 step 5: the executable status activation adds.
 *
 * NOT session-overridable, and deliberately so: `labelsToPhase` gates pickup on
 * this literal and never on a session's `labels.needsImplementation` alias (the
 * same asymmetry `core/issue-activation.ts` documents for suspend/activate). An
 * activation that added a renamed alias instead would satisfy nobody — ordinary
 * intake (§11 step 7) would not recognise it, and the parked implementation row
 * of step 6 would stay blocked with nothing able to reactivate it.
 */
export const IMPLEMENTATION_STATUS_LABEL = "status:needs-implementation";

/** The two lane-owned labels of §6, resolved for a session. */
export interface RefinementLabels {
  /** §3 `status:needs-refinement` (or the session's override). */
  marker: string;
  /** §11 step 5 `status:needs-implementation`, always the intake-recognized literal. */
  implementationStatus: string;
}

/**
 * Resolve the two lane-owned labels of §6 for a session.
 *
 * The marker is read through the `SessionLabels` index signature exactly as the
 * stack-ready label already is (`session.labels["stackReady"]`), so an operator
 * can rename the human-facing intake signal without a source change and without
 * a second config block. It is only ever READ, so renaming it is safe.
 *
 * The implementation status is not resolved that way, because it is only ever
 * WRITTEN — see {@link IMPLEMENTATION_STATUS_LABEL}. Honouring a session alias
 * here would persist a label into the activation plan that `labelsToPhase`
 * cannot consume.
 */
export function resolveRefinementLabels(labels: SessionLabels | undefined): RefinementLabels {
  return {
    marker: labels?.["needsRefinement"] ?? DEFAULT_REFINEMENT_MARKER_LABEL,
    implementationStatus: IMPLEMENTATION_STATUS_LABEL,
  };
}

// ---------------------------------------------------------------------------
// §8 Bounded refinement: normative limits
// ---------------------------------------------------------------------------

export type IssueRefinementLimitKey =
  | "maxPredecessorsPerRefinement"
  | "maxRefinementRoundsPerIssue"
  | "maxMalformedAttemptsPerRole"
  | "maxAgentFailuresPerRole"
  | "maxStaleRestartsPerIssue"
  | "maxCommentsPerPredecessor"
  | "maxSnapshotTextBytes"
  | "maxChangedPathsPerPredecessor"
  | "maxManagedRegionBytes";

export type IssueRefinementLimits = Record<IssueRefinementLimitKey, number>;

/**
 * The §8 table, verbatim. `default` is the contract MAXIMUM — session config may
 * only lower a limit — and `min` is the floor below which the lane would have a
 * state with no next action.
 *
 * Six limits reject a configured `0`; the other three accept it, because at `0`
 * the stale restart, respectively the comment window, respectively the
 * process-failure retry, is simply unavailable, which is still a defined next
 * action (§8).
 */
export const ISSUE_REFINEMENT_LIMIT_SPECS: Record<
  IssueRefinementLimitKey,
  { constant: string; default: number; min: number }
> = {
  maxPredecessorsPerRefinement: { constant: "MAX_PREDECESSORS_PER_REFINEMENT", default: 4, min: 1 },
  maxRefinementRoundsPerIssue: { constant: "MAX_REFINEMENT_ROUNDS_PER_ISSUE", default: 2, min: 1 },
  maxMalformedAttemptsPerRole: { constant: "MAX_MALFORMED_ATTEMPTS_PER_ROLE", default: 2, min: 1 },
  maxAgentFailuresPerRole: { constant: "MAX_AGENT_FAILURES_PER_ROLE", default: 2, min: 0 },
  maxStaleRestartsPerIssue: { constant: "MAX_STALE_RESTARTS_PER_ISSUE", default: 1, min: 0 },
  maxCommentsPerPredecessor: { constant: "MAX_COMMENTS_PER_PREDECESSOR", default: 5, min: 0 },
  maxSnapshotTextBytes: { constant: "MAX_SNAPSHOT_TEXT_BYTES", default: 8000, min: 1 },
  maxChangedPathsPerPredecessor: { constant: "MAX_CHANGED_PATHS_PER_PREDECESSOR", default: 100, min: 1 },
  maxManagedRegionBytes: { constant: "MAX_MANAGED_REGION_BYTES", default: 16000, min: 1 },
};

export const ISSUE_REFINEMENT_LIMIT_KEYS = Object.keys(
  ISSUE_REFINEMENT_LIMIT_SPECS,
) as IssueRefinementLimitKey[];

/** The §8 defaults, derived from the spec table so the two cannot disagree. */
export const ISSUE_REFINEMENT_DEFAULT_LIMITS: IssueRefinementLimits =
  ISSUE_REFINEMENT_LIMIT_KEYS.reduce((acc, key) => {
    acc[key] = ISSUE_REFINEMENT_LIMIT_SPECS[key].default;
    return acc;
  }, {} as IssueRefinementLimits);

// ---------------------------------------------------------------------------
// §19 Configuration
// ---------------------------------------------------------------------------

/** §7.3 / §14 role selection, resolved and validated. */
export interface ResolvedRefinementAgentPolicy {
  /** Session-level fallback for the `refinementAgent` role; the flow profile wins. */
  refiner?: AgentId;
  /** Session-level fallback for the `refinementCriticAgent` role; the flow profile wins. */
  critic?: AgentId;
  /** §7.3: a same-provider (never same-model) critic is allowed only by explicit opt-in. */
  allowSameProvider: boolean;
}

export interface ResolvedIssueRefinementSettings {
  /** §19: the whole lane is off unless a session opts in. */
  enabled: boolean;
  limits: IssueRefinementLimits;
  agents: ResolvedRefinementAgentPolicy;
}

export type IssueRefinementConfigErrorCode =
  | "not-an-integer"
  | "below-minimum"
  | "above-default"
  | "not-a-boolean"
  | "not-an-agent-id";

export interface IssueRefinementConfigError {
  /** Config path, e.g. `issueRefinement.limits.maxRefinementRoundsPerIssue`. */
  path: string;
  /** The §8 constant name, when the error is about a protocol limit. */
  constant: string | null;
  code: IssueRefinementConfigErrorCode;
  /** Operator-facing message; carries only literals and numbers. */
  message: string;
}

export type IssueRefinementSettingsResolution =
  | { ok: true; settings: ResolvedIssueRefinementSettings }
  | { ok: false; errors: IssueRefinementConfigError[] };

/** The agent ids `issueRefinement.agents.*` may name. */
export const REFINEMENT_CANDIDATE_AGENT_IDS: readonly AgentId[] = ["claude", "codex", "gemini"];

function limitErrors(
  cfg: IssueRefinementLimitsConfig | undefined,
  basePath: string,
): { limits: IssueRefinementLimits; errors: IssueRefinementConfigError[] } {
  const limits: IssueRefinementLimits = { ...ISSUE_REFINEMENT_DEFAULT_LIMITS };
  const errors: IssueRefinementConfigError[] = [];
  if (cfg === undefined) return { limits, errors };
  // Read through an untyped view: the config reaches this function from JSON, so
  // a declared `number` may still be a string at runtime and must be rejected
  // rather than trusted.
  const raw: Record<string, unknown> = { ...cfg };
  for (const key of ISSUE_REFINEMENT_LIMIT_KEYS) {
    const configured = raw[key];
    if (configured === undefined) continue;
    const spec = ISSUE_REFINEMENT_LIMIT_SPECS[key];
    const path = `${basePath}.${key}`;
    if (typeof configured !== "number" || !Number.isInteger(configured)) {
      errors.push({
        path,
        constant: spec.constant,
        code: "not-an-integer",
        message: `${path} (${spec.constant}) must be an integer`,
      });
      continue;
    }
    if (configured < spec.min) {
      errors.push({
        path,
        constant: spec.constant,
        code: "below-minimum",
        message:
          `${path} (${spec.constant}) must not be lower than ${spec.min}`
          + (spec.min > 0
            ? "; a session that wants the lane off sets issueRefinement.enabled: false"
            : ""),
      });
      continue;
    }
    if (configured > spec.default) {
      errors.push({
        path,
        constant: spec.constant,
        code: "above-default",
        message: `${path} (${spec.constant}) may only be lowered; the contract maximum is ${spec.default}`,
      });
      continue;
    }
    limits[key] = configured;
  }
  return { limits, errors };
}

function agentIdErrors(
  value: unknown,
  path: string,
  errors: IssueRefinementConfigError[],
): AgentId | undefined {
  if (value === undefined) return undefined;
  if ((REFINEMENT_CANDIDATE_AGENT_IDS as readonly unknown[]).includes(value)) {
    return value as AgentId;
  }
  errors.push({
    path,
    constant: null,
    code: "not-an-agent-id",
    message: `${path} must be one of: ${REFINEMENT_CANDIDATE_AGENT_IDS.join(", ")}`,
  });
  return undefined;
}

/**
 * Resolve and validate `session.issueRefinement`, failing closed (§8, §19).
 *
 * Every problem is reported rather than clamped: a limit that would leave a
 * state without a next action must stop session load, not silently become the
 * default, because an operator who lowered it meant something by it.
 */
export function resolveIssueRefinementSettings(
  cfg: IssueRefinementConfig | undefined,
  basePath = "issueRefinement",
): IssueRefinementSettingsResolution {
  const errors: IssueRefinementConfigError[] = [];

  if (cfg?.enabled !== undefined && typeof cfg.enabled !== "boolean") {
    errors.push({
      path: `${basePath}.enabled`,
      constant: null,
      code: "not-a-boolean",
      message: `${basePath}.enabled must be a boolean`,
    });
  }
  const enabled = cfg?.enabled === true;

  const { limits, errors: limitProblems } = limitErrors(cfg?.limits, `${basePath}.limits`);
  errors.push(...limitProblems);

  const agentsCfg = cfg?.agents;
  const refiner = agentIdErrors(agentsCfg?.refiner, `${basePath}.agents.refiner`, errors);
  const critic = agentIdErrors(agentsCfg?.critic, `${basePath}.agents.critic`, errors);
  if (agentsCfg?.allowSameProvider !== undefined && typeof agentsCfg.allowSameProvider !== "boolean") {
    errors.push({
      path: `${basePath}.agents.allowSameProvider`,
      constant: null,
      code: "not-a-boolean",
      message: `${basePath}.agents.allowSameProvider must be a boolean`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled,
      limits,
      agents: {
        ...(refiner !== undefined ? { refiner } : {}),
        ...(critic !== undefined ? { critic } : {}),
        allowSameProvider: agentsCfg?.allowSameProvider === true,
      },
    },
  };
}

/**
 * The session-level refiner/critic fallbacks, for the assignment resolver.
 *
 * Throws on an unresolvable agent id rather than ignoring it: `resolveAssignment`
 * already fails closed on an assignment profile that names an unsupported
 * conflict-resolution agent, and an unknown refinement role is the same class of
 * operator error — silently dropping it would persist an assignment that claims
 * no refiner was configured when one was.
 */
export function refinementRoleFallbacks(
  cfg: IssueRefinementConfig | undefined,
): { refiner?: AgentId; critic?: AgentId } {
  const resolved = resolveIssueRefinementSettings(cfg);
  if (!resolved.ok) {
    throw new Error(resolved.errors.map((e) => e.message).join("; "));
  }
  const { refiner, critic } = resolved.settings.agents;
  return {
    ...(refiner !== undefined ? { refiner } : {}),
    ...(critic !== undefined ? { critic } : {}),
  };
}

// ---------------------------------------------------------------------------
// §12 rows 1, 2, 47 — admission
// ---------------------------------------------------------------------------

export type RefinementAdmission =
  /** The Issue carries no marker: not this lane's business at all. */
  | { kind: "not_marked" }
  /**
   * Row 2 (`conflicting_markers`) or row 47 (`no_implementation_agent`). Both
   * refuse admission, create no task, and are re-evaluated on the next poll; the
   * two are repaired by OPPOSITE label edits, which is why they are separate
   * literals rather than one "bad labels" answer.
   */
  | {
      kind: "refused";
      reason: Extract<RefinementRefusalReason, "conflicting_markers" | "no_implementation_agent">;
      /** The executable `status:*` labels observed beside the marker (row 2 only). */
      executableStatusLabels: string[];
    }
  /** Row 1: admit a `refinement`-phase task and resolve `context.assignment`. */
  | { kind: "admit"; implementationAgent: AgentId; agentLabel: string };

/**
 * Decide §4 condition 1 from the label set alone (§12 rows 1, 2, 47).
 *
 * Pure, and deliberately so: this runs on `intake.scanned` before any task
 * exists, so it must not need a relationship query, a PR read, or a chain
 * lookup. Conditions 2–5 (rows 3–7) are evaluated later, at predecessor
 * resolution, against a task this function admitted.
 */
export function evaluateRefinementAdmission(
  labels: readonly string[],
  markerLabel: string = DEFAULT_REFINEMENT_MARKER_LABEL,
): RefinementAdmission {
  const set = new Set(labels);
  if (!set.has(markerLabel)) return { kind: "not_marked" };

  const executableStatusLabels = EXECUTABLE_STATUS_LABELS.filter((l) => set.has(l));
  if (executableStatusLabels.length > 0) {
    return { kind: "refused", reason: "conflicting_markers", executableStatusLabels };
  }

  const owner = implementationLaneAgentLabel(labels);
  if (!owner) {
    return { kind: "refused", reason: "no_implementation_agent", executableStatusLabels: [] };
  }
  return { kind: "admit", implementationAgent: owner.agent, agentLabel: owner.label };
}

/**
 * The implementation-lane `agent:*` label an Issue carries, under the same
 * precedence `labelsToPhase`'s new-implementation lane applies. Returns
 * `undefined` when the Issue carries none.
 */
export function implementationLaneAgentLabel(
  labels: readonly string[],
): { label: string; agent: AgentId } | undefined {
  const set = new Set(labels);
  return IMPLEMENTATION_LANE_AGENT_LABELS.find((entry) => set.has(entry.label));
}

// ---------------------------------------------------------------------------
// §3.1 The marker also stops a task that already exists
//
// Refusing admission (row 2) only decides whether a NEW task is created; it does
// nothing to a task that was created BEFORE the marker appeared, which is the
// ordinary case because a human applies the marker. Without the guard below the
// runner would execute that task against the rough contract the marker says is
// not ready, and §3's fail-closed guarantee would hold for every Issue except
// the half-transitioned ones it exists to protect.
// ---------------------------------------------------------------------------

/** §3.1 the key the suspension record is persisted under, on the SUSPENDED task. */
export const REFINEMENT_EXECUTION_CONFLICT_KEY = "refinementExecutionConflict";

/** §16 audit event for the §3.1 guard. Named in the contract's closed catalogue. */
export const REFINEMENT_EXECUTION_SUSPENDED_EVENT = "refinement.execution.suspended";

/**
 * What the §3.1 guard writes onto the task it stopped.
 *
 * The suspended task belongs to the executable lane and carries no refinement
 * state block — no §12 row can record it, which is exactly why the contract
 * gives the guard its own event and why the reason is persisted here rather
 * than in `context.refinement.handoffReason`.
 */
export interface RefinementExecutionConflictRecord {
  reason: Extract<RefinementHandoffReason, "execution_marker_conflict">;
  /** The marker whose presence stopped the task. */
  markerLabel: string;
  /** The executable `status:*` labels observed beside it; empty when only the marker remains. */
  conflictingLabels: string[];
  /** The status/phase the task was stopped at, so the handoff states what was interrupted. */
  previousStatus: TaskStatus;
  previousPhase: TaskPhase;
  suspendedAt: string;
}

/**
 * §3.1: statuses at which a task can still be claimed and executed.
 *
 * `blocked` and `ready_for_human` are deliberately absent — neither is
 * claimable, so neither can reach an agent process or an outward effect, and
 * suspending them would overwrite a handoff a human is already looking at.
 */
const LIVE_EXECUTION_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "queued",
  "claimed",
  "running",
]);

/**
 * Whether the §3.1 guard applies to this task: it belongs to the executable
 * lane (any phase but `refinement`) and is still live.
 *
 * Deliberately phrased as "not `refinement`" rather than as the §3.1 phase list
 * spelled out: every phase but this lane's own is executable, and a list would
 * silently exempt any phase added later.
 */
export function isSuspendableForRefinement(task: Pick<AiTask, "status" | "phase">): boolean {
  return task.phase !== "refinement" && LIVE_EXECUTION_STATUSES.has(task.status);
}

export function buildRefinementExecutionConflict(input: {
  markerLabel: string;
  conflictingLabels: readonly string[];
  previousStatus: TaskStatus;
  previousPhase: TaskPhase;
  now: string;
}): RefinementExecutionConflictRecord {
  return {
    reason: "execution_marker_conflict",
    markerLabel: input.markerLabel,
    conflictingLabels: [...input.conflictingLabels],
    previousStatus: input.previousStatus,
    previousPhase: input.previousPhase,
    suspendedAt: input.now,
  };
}

/**
 * Read a persisted suspension record, tolerantly — the same discipline
 * {@link readRefinementContextBlock} applies: anything object-shaped carrying
 * the contract's one reason literal is returned as-is, and anything else is
 * reported absent rather than defaulted.
 */
export function readRefinementExecutionConflict(
  context: Record<string, unknown> | undefined,
): RefinementExecutionConflictRecord | undefined {
  const raw = context?.[REFINEMENT_EXECUTION_CONFLICT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if ((raw as Record<string, unknown>)["reason"] !== "execution_marker_conflict") return undefined;
  return raw as RefinementExecutionConflictRecord;
}

/** The human-readable `lastError` the §3.1 handoff parks the task with. */
export function describeRefinementExecutionConflict(
  record: RefinementExecutionConflictRecord,
): string {
  const beside =
    record.conflictingLabels.length > 0
      ? ` beside ${record.conflictingLabels.join(", ")}`
      : "";
  return (
    `execution_marker_conflict: ${record.markerLabel}${beside} — the ${record.previousPhase} task ` +
    `was suspended at ${record.previousStatus} and will not run until an operator resolves the labels.`
  );
}

// ---------------------------------------------------------------------------
// §10 The managed body region — elision only
//
// This slice never RENDERS or WRITES a region. It only needs to recognise one,
// because §6 elides it from the source-body digest, and because the state block
// records what the body looked like at admission.
// ---------------------------------------------------------------------------

export const MANAGED_REGION_BEGIN_PREFIX = "<!-- ai-refinement:begin fingerprint=";
export const MANAGED_REGION_END = "<!-- ai-refinement:end -->";

export type ManagedRegionShape = "absent" | "present" | "malformed";

export interface ManagedRegionScan {
  shape: ManagedRegionShape;
  /**
   * The body with the region elided per §6 — begin marker line through end
   * marker line inclusive, plus the single blank-line separator introduced in
   * front of it when the region was appended, with trailing whitespace
   * stripped. Equal to the trailing-whitespace-stripped body when the shape is
   * `absent`, and to the raw body when it is `malformed` (an undefined elision
   * is never guessed at).
   */
  sourceBody: string;
  /** The fingerprint prefix carried by the begin marker, when well-formed. */
  fingerprintPrefix: string | null;
}

/**
 * Locate the §10 managed region and produce the §6 source body.
 *
 * "Malformed" follows §10 exactly: an unbalanced pair, more than one pair,
 * nested pairs, or an end marker before a begin marker. It is reported rather
 * than repaired — the disposition (`malformed_managed_region`) belongs to the
 * `applying` state, and inventing one at admission would escalate an Issue this
 * lane has not even snapshotted yet.
 */
export function scanManagedRegion(body: string | undefined): ManagedRegionScan {
  const text = body ?? "";
  const lines = text.split("\n");
  const beginIdx: number[] = [];
  const endIdx: number[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(MANAGED_REGION_BEGIN_PREFIX)) beginIdx.push(i);
    else if (trimmed === MANAGED_REGION_END) endIdx.push(i);
  });

  if (beginIdx.length === 0 && endIdx.length === 0) {
    return { shape: "absent", sourceBody: stripTrailingWhitespace(text), fingerprintPrefix: null };
  }
  if (beginIdx.length !== 1 || endIdx.length !== 1 || endIdx[0] < beginIdx[0]) {
    return { shape: "malformed", sourceBody: text, fingerprintPrefix: null };
  }

  const begin = beginIdx[0];
  const end = endIdx[0];
  // Drop the single blank-line separator the append introduced in front of the
  // region, so appending a region for the first time does not change the source
  // body's digest (§6).
  const from = begin > 0 && lines[begin - 1].trim() === "" ? begin - 1 : begin;
  const kept = [...lines.slice(0, from), ...lines.slice(end + 1)];
  const marker = lines[begin].trim();
  const prefix = marker.slice(MANAGED_REGION_BEGIN_PREFIX.length).replace(/-->$/, "").trim();
  return {
    shape: "present",
    sourceBody: stripTrailingWhitespace(kept.join("\n")),
    fingerprintPrefix: prefix.length > 0 ? prefix : null,
  };
}

function stripTrailingWhitespace(text: string): string {
  return text.replace(/\s+$/, "");
}

// ---------------------------------------------------------------------------
// §6 Fingerprints — the target Issue's own inputs
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface IssueSourceFingerprintInput {
  issueNumber: number;
  title: string;
  body?: string | undefined;
  labels: readonly string[];
  /** The two lane-owned labels of §6, excluded from the hash. */
  laneLabels: RefinementLabels;
}

export interface IssueSourceDigestInput {
  issueNumber: number;
  title: string;
  /**
   * The body with the §10 managed region ALREADY elided. Hashed verbatim — this
   * function never scans it for markers.
   */
  sourceBody: string;
  labels: readonly string[];
  /** The two lane-owned labels of §6, excluded from the hash. */
  laneLabels: RefinementLabels;
}

/**
 * §6's canonical serialization of the target-Issue inputs, over a source body
 * the caller has already elided.
 *
 * Split out of {@link computeIssueSourceFingerprint} so a caller holding the
 * elided body it actually handed the agents can hash THAT, rather than sending
 * it back through {@link scanManagedRegion} for a second elision. The second
 * pass is not a no-op in one case that matters: a malformed body is stored
 * unelided (`scanManagedRegion` reports it rather than repairing it), and
 * bounding it can leave behind a region that reads as well-formed — so
 * re-scanning would elide content the agents received, and edits to that content
 * would stop moving the digest.
 */
export function computeIssueSourceDigest(input: IssueSourceDigestInput): string {
  const laneOwned = new Set([input.laneLabels.marker, input.laneLabels.implementationStatus]);
  const labels = [...new Set(input.labels)].filter((l) => !laneOwned.has(l)).sort();
  // A tagged, length-free but structurally unambiguous serialization: every
  // component is a digest or a JSON-encoded scalar, so no field can be confused
  // with another by concatenation.
  const canonical = JSON.stringify([
    "issue-refinement.source.v1",
    input.issueNumber,
    sha256(input.title),
    sha256(input.sourceBody),
    labels,
  ]);
  return sha256(canonical);
}

export interface IssueSourceFingerprint {
  /** {@link computeIssueSourceDigest} over the body with its region elided. */
  digest: string;
  /** What the body carried at capture time (§10). */
  managedRegion: ManagedRegionShape;
}

/**
 * The target-Issue half of §6's `predecessorFingerprint`: Issue number, title
 * digest, source-body digest (managed region elided), sorted label set with the
 * two lane-owned labels removed.
 *
 * Deliberately NOT named `predecessorFingerprint`: that value additionally
 * covers every predecessor's bounded snapshot inputs, which this slice does not
 * capture. Recording the half that is computable now is what lets a restart
 * detect that the Issue itself changed under a `pending` refinement task; the
 * predecessor half is added when the snapshot lands, and `predecessorFingerprint`
 * stays `null` until then rather than holding a value that does not mean what
 * §6 says it means.
 */
export function computeIssueSourceFingerprint(
  input: IssueSourceFingerprintInput,
): IssueSourceFingerprint {
  const region = scanManagedRegion(input.body);
  return {
    digest: computeIssueSourceDigest({
      issueNumber: input.issueNumber,
      title: input.title,
      sourceBody: region.sourceBody,
      labels: input.labels,
      laneLabels: input.laneLabels,
    }),
    managedRegion: region.shape,
  };
}

// ---------------------------------------------------------------------------
// §15 Persistence — the `task.context.refinement` block
// ---------------------------------------------------------------------------

/** Task-context key under which the refinement block is persisted. */
export const REFINEMENT_CONTEXT_KEY = "refinement";

/** §11: the ordered activation steps, as literals a test can pin. */
export const REFINEMENT_ACTIVATION_STEPS = [
  "verify_fingerprint",
  "persist_accepted",
  "update_issue_body",
  "post_audit_comment",
  "transition_labels",
  "park_task_row",
  "reactivate_via_intake",
] as const;
export type RefinementActivationStep = (typeof REFINEMENT_ACTIVATION_STEPS)[number];

/**
 * The deferred implementation activation, resolved at admission (§14) and
 * persisted so it is explicit and testable long before any of it runs.
 *
 * Nothing here is derived from labels at activation time: §14 requires the
 * assignment captured at admission to be carried forward rather than re-resolved
 * from a possibly-edited `sessions.json`, and requires activation to move only
 * the two status labels while leaving the `agent:*` label exactly as the
 * operator applied it.
 */
export interface RefinementActivationPlan {
  /** §11 step 6: the shared task row is parked at this phase… */
  targetPhase: "implementation";
  /** …with this status, so the existing blocked-task reactivation branch applies. */
  targetStatus: "blocked";
  /** §11 step 7: ordinary intake produces a NEW-implementation candidate. */
  implementationMode: "new";
  /** §14: the pinned owner, from `context.assignment`, never re-derived. */
  implementationAgent: AgentId;
  /** The `agent:*` label activation must leave in place (§3, §11 step 5). */
  agentLabel: string;
  /** §11 step 5: removed first… */
  markerLabel: string;
  /**
   * …then added, in that delivery order. Always the intake-recognized literal
   * (see {@link IMPLEMENTATION_STATUS_LABEL}) — step 7 hands the Issue back to
   * ordinary intake, which routes on the pair `agent:*` +
   * `status:needs-implementation` and never on a session's renamed alias.
   */
  implementationStatusLabel: string;
  /** §11's normative step order. */
  steps: readonly RefinementActivationStep[];
  plannedAt: string;
}

/** §8 counters, all bounded. */
export interface RefinementCounters {
  /** §8: a round is one refiner draft plus one critic verdict. */
  rounds: number;
  /** §17: per-role malformed-output attempts. */
  malformedAttempts: { refiner: number; critic: number };
  /** §17: per-role agent PROCESS failures, counted separately from malformed output. */
  agentFailures: { refiner: number; critic: number };
  /** §6: the single counter shared by every stale/region restart. */
  staleRestarts: number;
}

/** §14 role metadata, resolved once at admission. */
export interface RefinementRoles {
  /** The deferred implementation owner (§14). Always resolved at admission. */
  implementationAgent: AgentId;
  /**
   * §7.1/§14 `refinementAgent`. `null` when neither the flow's assignment
   * profile nor `issueRefinement.agents.refiner` names one — the lane cannot
   * start without it, and recording `null` is what makes that visible instead of
   * defaulting to an agent nobody chose.
   */
  refinerAgent: AgentId | null;
  /** §7.2/§14 `refinementCriticAgent`; `null` on the same terms. */
  criticAgent: AgentId | null;
  /** §7.3: whether a same-provider (never same-model) critic is permitted. */
  allowSameProvider: boolean;
}

/**
 * §15 task context. Every field is a literal, a counter, a digest, or a bounded
 * list — never refined prose, snapshot content, agent reasoning, or a local path.
 */
export interface RefinementContextBlock {
  state: RefinementState;
  /**
   * §6. `null` until the bounded snapshot is captured; see
   * {@link computeIssueSourceFingerprint} for why the target-side half is
   * recorded separately rather than under this name.
   */
  predecessorFingerprint: string | null;
  /** §6, stamped on effects enqueued after the body update. `null` until step 2. */
  appliedRegionDigest: string | null;
  /** §6, target-Issue inputs only — the half computable without a snapshot. */
  sourceFingerprint: string;
  /** §10 shape of the body observed at admission. */
  managedRegion: ManagedRegionShape;
  /** §15. Empty until predecessor resolution (rows 3–7). */
  predecessors: RefinementPredecessorRecord[];
  counters: RefinementCounters;
  /** §8 limits in force for this attempt, pinned so a later config edit cannot move a cap mid-lane. */
  limits: IssueRefinementLimits;
  roles: RefinementRoles;
  activationPlan: RefinementActivationPlan;
  /** §3 the marker whose presence admitted this task. */
  markerLabel: string;
  /** §15 the handoff reason when escalated; `null` otherwise. */
  handoffReason: RefinementHandoffReason | null;
  admittedAt: string;
  updatedAt: string;
}

/** §15: Issue numbers, PR numbers, head SHAs — never prose. */
export interface RefinementPredecessorRecord {
  issueNumber: number;
  prNumber: number | null;
  headSha: string | null;
  state: "open" | "merged" | null;
}

export interface BuildRefinementContextInput {
  issueNumber: number;
  title: string;
  body?: string | undefined;
  labels: readonly string[];
  /** From {@link evaluateRefinementAdmission}. */
  agentLabel: string;
  /** §14: the pinned owner, taken from the resolved `context.assignment`. */
  implementationAgent: AgentId;
  refinerAgent?: AgentId | undefined;
  criticAgent?: AgentId | undefined;
  settings: ResolvedIssueRefinementSettings;
  laneLabels: RefinementLabels;
  now: string;
}

/**
 * Build the §15 block for a freshly admitted refinement task (§12 row 1).
 *
 * The block starts at `pending` with empty counters and no predecessors:
 * admission is condition 1 only, and rows 3–7 move it from there.
 */
export function buildRefinementContextBlock(
  input: BuildRefinementContextInput,
): RefinementContextBlock {
  const fingerprint = computeIssueSourceFingerprint({
    issueNumber: input.issueNumber,
    title: input.title,
    body: input.body,
    labels: input.labels,
    laneLabels: input.laneLabels,
  });
  return {
    state: "pending",
    predecessorFingerprint: null,
    appliedRegionDigest: null,
    sourceFingerprint: fingerprint.digest,
    managedRegion: fingerprint.managedRegion,
    predecessors: [],
    counters: {
      rounds: 0,
      malformedAttempts: { refiner: 0, critic: 0 },
      agentFailures: { refiner: 0, critic: 0 },
      staleRestarts: 0,
    },
    limits: { ...input.settings.limits },
    roles: {
      implementationAgent: input.implementationAgent,
      refinerAgent: input.refinerAgent ?? null,
      criticAgent: input.criticAgent ?? null,
      allowSameProvider: input.settings.agents.allowSameProvider,
    },
    activationPlan: {
      targetPhase: "implementation",
      targetStatus: "blocked",
      implementationMode: "new",
      implementationAgent: input.implementationAgent,
      agentLabel: input.agentLabel,
      markerLabel: input.laneLabels.marker,
      implementationStatusLabel: input.laneLabels.implementationStatus,
      steps: [...REFINEMENT_ACTIVATION_STEPS],
      plannedAt: input.now,
    },
    markerLabel: input.laneLabels.marker,
    handoffReason: null,
    admittedAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Read a persisted refinement block, TOLERANTLY.
 *
 * Returns the raw record for anything object-shaped that carries a recognised
 * `state`, so an operator surface can still show a block that has drifted from
 * this shape; callers that need a specific field validate it themselves. A
 * block with no recognised state is reported absent rather than defaulted —
 * inventing `pending` for it would claim a lane that may already have run.
 */
export function readRefinementContextBlock(context: Record<string, unknown> | undefined):
  | RefinementContextBlock
  | undefined {
  const raw = context?.[REFINEMENT_CONTEXT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (!isRefinementState((raw as Record<string, unknown>)["state"])) return undefined;
  return raw as RefinementContextBlock;
}
