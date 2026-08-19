import type { AgentId, AiTask } from "./task.js";
import type { AssignmentProfile, FlowRule, ResolvedSession } from "./session.js";
import { refinementRoleFallbacks } from "./issue-refinement.js";

/** Task-context key under which the resolved assignment is persisted. */
export const ASSIGNMENT_CONTEXT_KEY = "assignment";

/** Built-in flow name used when no assignment config is present. */
export const DEFAULT_FLOW = "code";

/**
 * Build the preserved built-in `code` profile from the session defaults. This is
 * the profile used when a session declares no `assignmentProfiles`, keeping
 * today's behavior (Claude implements, Codex reviews, Claude resolves conflicts).
 */
function builtInCodeProfile(session: ResolvedSession): AssignmentProfile {
  return {
    implementation: session.defaults.implementationAgent,
    review: session.defaults.reviewAgent,
    conflict_resolution: session.defaults.implementationAgent,
    ...(session.defaults.researchAgent ? { research: session.defaults.researchAgent } : {}),
  };
}

/**
 * The assignment resolved for a task at intake / creation time and persisted
 * into task context. Once persisted it is the authority for phase handlers, so
 * later edits to sessions.json never silently change an existing task's agents.
 *
 * `source` records whether the assignment came from a configured assignment
 * block (`session-config`) or from the preserved defaults (`default`).
 */
export interface ResolvedAssignment {
  flow: string;
  implementationAgent: AgentId;
  reviewAgent: AgentId;
  conflictResolutionAgent: AgentId;
  researchAgent?: AgentId;
  /**
   * Chain-aware refinement roles (docs/issue-refinement-contract.md §14).
   * Absent when neither the flow profile nor `issueRefinement.agents` names one;
   * the refinement lane refuses to start rather than substituting a default.
   */
  refinementAgent?: AgentId;
  refinementCriticAgent?: AgentId;
  resolvedAt: string;
  source: "session-config" | "default";
}

/** Phase slots a handler can request an agent for. */
export type PhaseAgentKind =
  | "implementation"
  | "review"
  | "conflictResolution"
  | "research"
  | "refinement"
  | "refinementCritic";

/**
 * Explicit per-phase agent overrides derived from issue labels (e.g. `agent:codex`).
 * When present, these take priority over the flow profile defaults so that an
 * explicit label is never silently shadowed by the session's built-in default.
 */
export interface LabelAgentOverrides {
  implementationAgent?: AgentId;
  reviewAgent?: AgentId;
  researchAgent?: AgentId;
}

/**
 * Agents with a conflict-resolution handler implementation. Any profile or
 * session default that resolves to an agent outside this set is clamped to
 * Claude so Codex-routed tasks (via label override or session default) do not
 * hit an unsupported-agent error when they reach the conflict-resolution phase.
 */
const CONFLICT_RESOLUTION_SUPPORTED_AGENTS: ReadonlySet<AgentId> = new Set(["claude"]);

/**
 * Resolve the flow + per-phase agents for an issue from the trusted session
 * config and trusted issue labels. Unset profile fields fall back to the session
 * defaults, so a session without an assignment block preserves current behavior
 * (implementation: claude, review: codex, conflict_resolution: claude, research:
 * existing behavior).
 *
 * When `labelOverrides` are provided (agents derived from explicit issue labels
 * such as `agent:codex`), they take priority over the flow profile for the
 * named slots. Conflict resolution does NOT follow `labelOverrides.implementationAgent`
 * because only a subset of agents support conflict resolution; an unsupported
 * value would cause every merge-conflict path on a Codex-labelled task to fail.
 *
 * The returned value is meant to be persisted verbatim into task context so the
 * decision is auditable and immutable for the life of the task.
 */
export function resolveAssignment(
  session: ResolvedSession,
  labels: string[],
  now: string,
  labelOverrides?: LabelAgentOverrides,
): ResolvedAssignment {
  const configured = session.assignmentProfiles !== undefined || session.flowRules !== undefined;
  const flow = resolveFlow(session.flowRules, labels);
  // Validation guarantees a configured flow has a profile; the built-in `code`
  // flow falls back to the defaults-derived profile when nothing is configured.
  const profile = session.assignmentProfiles?.[flow] ?? builtInCodeProfile(session);
  const researchAgent = labelOverrides?.researchAgent ?? profile.research ?? session.defaults.researchAgent;
  // Conflict resolution: use the profile's explicit setting when present,
  // otherwise the session's implementation default. Label overrides for
  // implementation (e.g. agent:codex) do NOT propagate here.
  //
  // Explicitly configured assignmentProfile settings fail closed: if the
  // operator set conflict_resolution to an unsupported agent, throw rather
  // than silently rerouting to a different agent (audit/ownership contract).
  // Implicit fallbacks — session defaults or the built-in code profile —
  // are clamped to Claude so Codex-default sessions don't fail at intake.
  const explicitConflictAgent = session.assignmentProfiles?.[flow]?.conflict_resolution;
  if (explicitConflictAgent !== undefined && !CONFLICT_RESOLUTION_SUPPORTED_AGENTS.has(explicitConflictAgent)) {
    throw new Error(
      `Assignment profile for flow "${flow}" sets conflict_resolution to "${explicitConflictAgent}", ` +
        `which is not a supported conflict-resolution agent. ` +
        `Supported agents: ${[...CONFLICT_RESOLUTION_SUPPORTED_AGENTS].join(", ")}.`,
    );
  }
  const rawConflictCandidate = profile.conflict_resolution ?? session.defaults.implementationAgent;
  const conflictResolutionAgent: AgentId = CONFLICT_RESOLUTION_SUPPORTED_AGENTS.has(rawConflictCandidate)
    ? rawConflictCandidate
    : "claude";
  // Refinement roles (issue-refinement-contract §14). The flow profile is the
  // source of truth; `issueRefinement.agents.*` is only the session-level
  // fallback. Neither has a built-in default: an unconfigured role stays absent
  // so the refinement lane records `null` and refuses to start, rather than
  // silently handing the Issue's contract to whichever agent the session
  // happens to implement with.
  const refinementFallbacks = refinementRoleFallbacks(session.issueRefinement);
  const refinementAgent = profile.refinement ?? refinementFallbacks.refiner;
  const refinementCriticAgent = profile.refinement_critic ?? refinementFallbacks.critic;
  return {
    flow,
    implementationAgent: labelOverrides?.implementationAgent ?? profile.implementation,
    reviewAgent: labelOverrides?.reviewAgent ?? profile.review,
    conflictResolutionAgent,
    ...(researchAgent ? { researchAgent } : {}),
    ...(refinementAgent ? { refinementAgent } : {}),
    ...(refinementCriticAgent ? { refinementCriticAgent } : {}),
    resolvedAt: now,
    source: configured ? "session-config" : "default",
  };
}

/**
 * Select a flow from the trusted label set. The first rule whose labels are all
 * present wins; otherwise the terminal `default: true` rule. With no configured
 * rules every task resolves to the built-in `code` flow.
 */
function resolveFlow(flowRules: FlowRule[] | undefined, labels: string[]): string {
  if (!flowRules || flowRules.length === 0) return DEFAULT_FLOW;
  const set = new Set(labels);
  for (const rule of flowRules) {
    if (rule.labels && rule.labels.length > 0 && rule.labels.every((l) => set.has(l))) {
      return rule.flow;
    }
  }
  const fallback = flowRules.find((r) => r.default);
  return fallback?.flow ?? DEFAULT_FLOW;
}

/**
 * Read a previously persisted resolved assignment from task context, if present
 * and well-formed. Returns undefined for tasks created before assignment
 * persistence existed (or with malformed context), so callers fall back to
 * legacy resolution.
 */
export function readResolvedAssignment(task: AiTask): ResolvedAssignment | undefined {
  const raw = task.context[ASSIGNMENT_CONTEXT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  if (
    typeof a.implementationAgent !== "string" ||
    typeof a.reviewAgent !== "string" ||
    typeof a.conflictResolutionAgent !== "string"
  ) {
    return undefined;
  }
  return raw as ResolvedAssignment;
}

/**
 * Resolve the agent a phase handler must use at the task/session boundary.
 * Prefers the assignment persisted on the task; falls back to the task's
 * per-phase agent column and finally the session default, preserving behavior
 * for tasks created without a persisted assignment.
 *
 * Returns undefined only for the research slot when no research agent is
 * configured anywhere (matching the existing optional-research behavior).
 */
export function agentForPhase(
  task: AiTask,
  session: ResolvedSession,
  kind: PhaseAgentKind,
): AgentId | undefined {
  const resolved = readResolvedAssignment(task);
  switch (kind) {
    case "implementation":
      return (
        resolved?.implementationAgent ??
        task.implementationAgent ??
        session.defaults.implementationAgent
      );
    case "review":
      return resolved?.reviewAgent ?? task.reviewAgent ?? session.defaults.reviewAgent;
    case "conflictResolution":
      return (
        resolved?.conflictResolutionAgent ??
        task.implementationAgent ??
        session.defaults.implementationAgent
      );
    case "research":
      return resolved?.researchAgent ?? task.researchAgent ?? session.defaults.researchAgent;
    // Refinement roles have NO fallback chain, deliberately: neither the task's
    // per-phase agent columns nor the session defaults name a refiner or a
    // critic, and substituting the implementation agent for either would quietly
    // defeat the critic independence §7.3 requires.
    case "refinement":
      return resolved?.refinementAgent;
    case "refinementCritic":
      return resolved?.refinementCriticAgent;
  }
}
