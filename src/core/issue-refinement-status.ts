/**
 * The OPERATOR view of the chain-aware refinement lane (issue #867,
 * docs/issue-refinement-contract.md §15, §18).
 *
 * A pure projection of the one thing a task already carries — the §15
 * `context.refinement` block — into the shape `admin task-status` renders. It
 * reads nothing else: no artifact, no event, no GitHub state. That is what keeps
 * the operator surface honest about what this slice actually persists.
 *
 * The block is read TOLERANTLY, not validated. `admin task-status` is the
 * command an operator runs when something is wrong, and a block that has drifted
 * from the current shape is exactly such a case; refusing to render it would
 * hide the state at the moment it is most needed. What the reader will not do is
 * invent: a field it cannot read as the right type is reported absent rather
 * than defaulted to a plausible value.
 */

import type { AiTask } from "./task.js";
import type { ManagedRegionShape, RefinementState } from "./issue-refinement.js";
import {
  REFINEMENT_CONTEXT_KEY,
  TERMINAL_REFINEMENT_STATES,
  isRefinementHandoffReason,
  isRefinementState,
} from "./issue-refinement.js";

export interface RefinementCounterStatus {
  rounds: number | null;
  malformedRefiner: number | null;
  malformedCritic: number | null;
  agentFailuresRefiner: number | null;
  agentFailuresCritic: number | null;
  staleRestarts: number | null;
}

export interface RefinementActivationStatus {
  targetPhase: string | null;
  targetStatus: string | null;
  implementationAgent: string | null;
  agentLabel: string | null;
  markerLabel: string | null;
  implementationStatusLabel: string | null;
  /** §11's ordered step literals, read back as written. */
  steps: string[];
}

export interface RefinementTaskStatus {
  state: RefinementState;
  /** §1: `activated` and `escalated_human` are terminal. */
  terminal: boolean;
  /** §15, present only on an escalated attempt. */
  handoffReason: string | null;
  /** §6; `null` until the bounded snapshot is captured. */
  predecessorFingerprint: string | null;
  /** §6 target-Issue inputs only — the half computable at admission. */
  sourceFingerprint: string | null;
  /** §10 shape of the Issue body observed at admission. */
  managedRegion: ManagedRegionShape | null;
  /** §15 predecessor Issue numbers; empty until predecessor resolution. */
  predecessors: number[];
  counters: RefinementCounterStatus;
  refinerAgent: string | null;
  criticAgent: string | null;
  /** §14: the deferred implementation activation, or `null` when none is recorded. */
  activation: RefinementActivationStatus | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Project a task's §15 refinement block, or `null` for a task that carries none.
 *
 * `null` is the ordinary answer — a task from any other lane, or from a session
 * with `issueRefinement.enabled: false`, which never writes a block — and it
 * renders nothing at all, so existing output stays byte-identical for every
 * such task.
 */
export function summarizeRefinementStatus(task: AiTask): RefinementTaskStatus | null {
  const raw = task.context?.[REFINEMENT_CONTEXT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  const state = block["state"];
  if (!isRefinementState(state)) return null;

  const counters = record(block["counters"]);
  const malformed = record(counters["malformedAttempts"]);
  const failures = record(counters["agentFailures"]);
  const roles = record(block["roles"]);
  const plan = block["activationPlan"];
  const activation = plan && typeof plan === "object" && !Array.isArray(plan)
    ? record(plan)
    : null;
  const region = block["managedRegion"];

  return {
    state,
    terminal: TERMINAL_REFINEMENT_STATES.has(state),
    handoffReason: isRefinementHandoffReason(block["handoffReason"])
      ? (block["handoffReason"] as string)
      : null,
    predecessorFingerprint: str(block["predecessorFingerprint"]),
    sourceFingerprint: str(block["sourceFingerprint"]),
    managedRegion:
      region === "absent" || region === "present" || region === "malformed"
        ? (region as ManagedRegionShape)
        : null,
    predecessors: Array.isArray(block["predecessors"])
      ? (block["predecessors"] as unknown[])
          .map((p) => num(record(p)["issueNumber"]))
          .filter((n): n is number => n !== null)
      : [],
    counters: {
      rounds: num(counters["rounds"]),
      malformedRefiner: num(malformed["refiner"]),
      malformedCritic: num(malformed["critic"]),
      agentFailuresRefiner: num(failures["refiner"]),
      agentFailuresCritic: num(failures["critic"]),
      staleRestarts: num(counters["staleRestarts"]),
    },
    refinerAgent: str(roles["refinerAgent"]),
    criticAgent: str(roles["criticAgent"]),
    activation: activation
      ? {
          targetPhase: str(activation["targetPhase"]),
          targetStatus: str(activation["targetStatus"]),
          implementationAgent: str(activation["implementationAgent"]),
          agentLabel: str(activation["agentLabel"]),
          markerLabel: str(activation["markerLabel"]),
          implementationStatusLabel: str(activation["implementationStatusLabel"]),
          steps: Array.isArray(activation["steps"])
            ? (activation["steps"] as unknown[]).filter((s): s is string => typeof s === "string")
            : [],
        }
      : null,
  };
}

/** Render the projection for `admin task-status`. */
export function renderRefinementLines(summary: RefinementTaskStatus, indent = ""): string[] {
  const lines: string[] = [];
  lines.push(
    `${indent}refinement: state=${summary.state}${summary.terminal ? " (terminal)" : ""}`
    + (summary.handoffReason ? ` handoff=${summary.handoffReason}` : ""),
  );
  const c = summary.counters;
  lines.push(
    `${indent}  rounds=${c.rounds ?? "-"}`
    + ` malformed=refiner:${c.malformedRefiner ?? "-"}/critic:${c.malformedCritic ?? "-"}`
    + ` agentFailures=refiner:${c.agentFailuresRefiner ?? "-"}/critic:${c.agentFailuresCritic ?? "-"}`
    + ` staleRestarts=${c.staleRestarts ?? "-"}`,
  );
  lines.push(
    `${indent}  roles: refiner=${summary.refinerAgent ?? "-"} critic=${summary.criticAgent ?? "-"}`,
  );
  lines.push(
    `${indent}  predecessors: ${
      summary.predecessors.length > 0 ? summary.predecessors.map((n) => `#${n}`).join(", ") : "(unresolved)"
    }`,
  );
  if (summary.activation) {
    const a = summary.activation;
    lines.push(
      `${indent}  activation: ${a.targetStatus ?? "-"}/${a.targetPhase ?? "-"}`
      + ` impl=${a.implementationAgent ?? "-"} agentLabel=${a.agentLabel ?? "-"}`
      + ` labels=-${a.markerLabel ?? "-"} +${a.implementationStatusLabel ?? "-"}`,
    );
  }
  return lines;
}
