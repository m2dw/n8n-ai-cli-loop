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

import type { AiTask, TaskEvent } from "./task.js";
import type { ManagedRegionShape, RefinementState } from "./issue-refinement.js";
import {
  REFINEMENT_CONTEXT_KEY,
  TERMINAL_REFINEMENT_STATES,
  isRefinementHandoffReason,
  isRefinementState,
} from "./issue-refinement.js";
import type { RefinementProgressStatus } from "./issue-refinement-progress-status.js";
import {
  renderRefinementProgressLines,
  summarizeRefinementProgress,
} from "./issue-refinement-progress-status.js";

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

/**
 * §5.2 (issue #1003): the required-evidence gate as an operator sees it.
 *
 * Literals and counters, exactly as the block records them — the gap list is
 * what tells an operator WHICH declared selection to fix, and it is the only
 * surface that says so without opening the run's artifact directory.
 */
export interface RefinementEvidenceStatus {
  declared: number | null;
  captured: number | null;
  optionalGaps: number | null;
  gaps: Array<{
    index: number | null;
    reason: string | null;
    requirement: string | null;
    predecessorIssueNumber: number | null;
  }>;
  /** The local artifact file name carrying the full record; never a path. */
  artifact: string | null;
}

/**
 * §15 (issue #1176): the critic's block as an operator sees it — the human
 * blocker the `critique_blocked` handoff names, and the objection literals it
 * rests on. Literals only, exactly as the block records them.
 */
export interface RefinementCriticBlockStatus {
  round: number | null;
  blockReason: string | null;
  objections: Array<{ field: string | null; kind: string | null }>;
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
  /** §5.2: present only on an attempt the required-evidence preflight stopped. */
  evidence: RefinementEvidenceStatus | null;
  /** §15: present only on an attempt the critic blocked (`critique_blocked`). */
  criticBlock: RefinementCriticBlockStatus | null;
  /**
   * Issue #977: the normalized §15 progress view — the one model `admin
   * task-status` (human and `--json`) and the admin UI both render. `null`
   * exactly when no `events` were supplied, which is the caller saying "I did
   * not read the event log", never "there is no progress".
   */
  progress: RefinementProgressStatus | null;
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
export function summarizeRefinementStatus(
  task: AiTask,
  events?: readonly TaskEvent[],
  now?: string,
): RefinementTaskStatus | null {
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
  const gateRaw = block["evidenceGate"];
  const gate =
    gateRaw && typeof gateRaw === "object" && !Array.isArray(gateRaw) ? record(gateRaw) : null;
  const criticBlockRaw = block["criticBlock"];
  const criticBlock =
    criticBlockRaw && typeof criticBlockRaw === "object" && !Array.isArray(criticBlockRaw)
      ? record(criticBlockRaw)
      : null;

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
    evidence: gate
      ? {
          declared: num(gate["declared"]),
          captured: num(gate["captured"]),
          optionalGaps: num(gate["optionalGaps"]),
          gaps: (Array.isArray(gate["gaps"]) ? (gate["gaps"] as unknown[]) : []).map((g) => {
            const entry = record(g);
            return {
              index: num(entry["index"]),
              reason: str(entry["reason"]),
              requirement: str(entry["requirement"]),
              predecessorIssueNumber: num(entry["predecessorIssueNumber"]),
            };
          }),
          artifact: str(gate["artifact"]),
        }
      : null,
    criticBlock: criticBlock
      ? {
          round: num(criticBlock["round"]),
          blockReason: str(criticBlock["blockReason"]),
          objections: (Array.isArray(criticBlock["objections"])
            ? (criticBlock["objections"] as unknown[])
            : []
          ).map((o) => {
            const entry = record(o);
            return { field: str(entry["field"]), kind: str(entry["kind"]) };
          }),
        }
      : null,
    // Issue #977. Derived from the task row and the persisted
    // `refinement.progress.milestone` events only — never from a GitHub
    // comment, an outbox row, or a re-reading of the `refinement.*` audit log.
    progress: events !== undefined ? summarizeRefinementProgress(task, events, now) : null,
  };
}

/**
 * §15 (issue #1176): the line naming the human blocker behind a
 * `critique_blocked` handoff. Shared by `admin task-status` and the admin UI so
 * the two surfaces cannot name different blockers.
 */
export function renderRefinementCriticBlockLine(
  criticBlock: RefinementCriticBlockStatus,
  indent = "",
): string {
  const objections = criticBlock.objections
    .map((o) => `${o.field ?? "-"}:${o.kind ?? "-"}`)
    .join(", ");
  return `${indent}critic block: blockReason=${criticBlock.blockReason ?? "(none named)"}`
    + ` round=${criticBlock.round ?? "-"} objections=${objections.length > 0 ? objections : "(none)"}`;
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
  if (summary.evidence) {
    // §5.2: the one line that tells an operator which declared selection to
    // fix. Entry INDEXES and omission literals only — the declared paths stay
    // in the local artifact this line names.
    const e = summary.evidence;
    lines.push(
      `${indent}  evidence: declared=${e.declared ?? "-"} captured=${e.captured ?? "-"}`
      + ` optionalGaps=${e.optionalGaps ?? "-"} artifact=${e.artifact ?? "-"}`,
    );
    for (const gap of e.gaps) {
      lines.push(
        `${indent}    gap[${gap.index ?? "-"}]: ${gap.reason ?? "-"} (${gap.requirement ?? "-"})`
        + (gap.predecessorIssueNumber === null ? "" : ` predecessor=#${gap.predecessorIssueNumber}`),
      );
    }
  }
  if (summary.criticBlock) {
    lines.push(renderRefinementCriticBlockLine(summary.criticBlock, `${indent}  `));
  }
  if (summary.activation) {
    const a = summary.activation;
    lines.push(
      `${indent}  activation: ${a.targetStatus ?? "-"}/${a.targetPhase ?? "-"}`
      + ` impl=${a.implementationAgent ?? "-"} agentLabel=${a.agentLabel ?? "-"}`
      + ` labels=-${a.markerLabel ?? "-"} +${a.implementationStatusLabel ?? "-"}`,
    );
  }
  // Issue #977: the normalized progress view, rendered through the same helper
  // the admin UI calls — so the two surfaces cannot disagree about a round, a
  // deadline, or whether a human has to act.
  if (summary.progress) {
    lines.push(...renderRefinementProgressLines(summary.progress, `${indent}  `));
  }
  return lines;
}
