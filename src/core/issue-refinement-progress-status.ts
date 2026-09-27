/**
 * Issue #977: the OPERATOR view of refinement progress
 * (docs/issue-refinement-contract.md §15, §18).
 *
 * Issue #975 made progress a persisted contract — eight bounded milestone
 * boundaries, a deterministic id, a durable dedupe ledger, committed with the
 * authoritative task transition. Issue #976 published each of them as one
 * append-only GitHub comment. Neither answered the question an operator
 * actually asks: *where is this Issue right now, and is it moving?* Answering
 * it from the comment history would make GitHub a source of truth, and
 * answering it from the fine-grained `refinement.*` audit events would rebuild
 * the very second state machine §15 exists to prevent.
 *
 * So this module derives ONE normalized view from exactly two authoritative
 * inputs — the task row (status, phase, `notBefore`) and the persisted
 * `refinement.progress.milestone` events — and every operator surface renders
 * it: `admin task-status` (human and `--json`) and the admin UI. Three
 * properties carry the design:
 *
 *  - **The task row decides the disposition, not the projection.** Whether the
 *    Issue is running, queued, delayed, activated, failed, or waiting for a
 *    human is a fact about the authoritative row; milestones only sharpen the
 *    two terminal cases the row deliberately blurs (§18 records a non-retryable
 *    refinement failure as `ready_for_human`, so `failed` and `human_handoff`
 *    are otherwise indistinguishable from the row alone).
 *  - **It fails closed.** A milestone event from a `schemaVersion` this build
 *    does not implement, or carrying a `kind` outside the closed eight, is
 *    REFUSED and counted — never coerced into a plausible-looking boundary. If
 *    a refused record is newer than the newest readable one, the readable one
 *    stops informing the disposition, which falls back to the row: an operator
 *    is told what is certain plus how much this build could not read, rather
 *    than a confident answer derived from a stale milestone.
 *  - **The retry deadline is the persisted one, verbatim.** `retryNotBefore` is
 *    the exact string #975's committing layer stamped from the task `notBefore`
 *    it actually wrote. JSON output carries it unmodified; nothing here
 *    re-derives, re-formats, or rounds it.
 *
 * What this module does NOT do: read a GitHub comment, inspect the outbox,
 * open a run artifact, mutate anything, or re-interpret a single `refinement.*`
 * audit event.
 */

import type { AiTask, TaskEvent } from "./task.js";
import { isDelayed } from "./transitions.js";
import type { RefinementState } from "./issue-refinement.js";
import {
  REFINEMENT_CONTEXT_KEY,
  isRefinementHandoffReason,
  isRefinementState,
} from "./issue-refinement.js";
import type {
  RefinementProgressMilestoneKind,
  RefinementProgressNextAction,
  RefinementProgressRole,
} from "./issue-refinement-progress.js";
import {
  REFINEMENT_PROGRESS_EVENT_TYPE,
  REFINEMENT_PROGRESS_MILESTONE_KINDS,
  REFINEMENT_PROGRESS_NEXT_ACTIONS,
  REFINEMENT_PROGRESS_ROLES,
  REFINEMENT_PROGRESS_SCHEMA_VERSION,
} from "./issue-refinement-progress.js";
import { REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT } from "./issue-refinement-progress-publication.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * What the lane is DOING, in the six words an operator triages by.
 *
 * Deliberately not the task status and not the refinement state: `queued` at
 * phase `refinement` with a future `notBefore` and `queued` with none are the
 * same row status and completely different operator situations, and a §18
 * non-retryable failure and a §13 handoff are the same `ready_for_human` row
 * and completely different next steps.
 */
export const REFINEMENT_PROGRESS_DISPOSITIONS = [
  /** Claimed or running right now — a worker holds it. */
  "running",
  /** Claimable and waiting for a worker turn (includes the §4 `blocked` hold). */
  "queued",
  /** A committed delay is in force; `retryNotBefore` says until when. */
  "delayed",
  /** §1 terminal success: the refinement was applied and implementation activated. */
  "activated",
  /** Ended non-retryably; no automatic retry follows. */
  "failed",
  /** §13 terminal handoff, or any row parked for a human. */
  "awaiting_human",
] as const;

export type RefinementProgressDisposition =
  (typeof REFINEMENT_PROGRESS_DISPOSITIONS)[number];

/** One role's published identity, exactly as the milestone bounded it (§15). */
export interface RefinementProgressStatusAgent {
  agentId: string;
  provider: string;
  model: string | null;
  effort: string | null;
}

/**
 * The last progress boundary this build could read.
 *
 * Every field is the persisted one or `null` — there is no default, no
 * inferred value, and no field a prompt, transcript, artifact path, or
 * credential could travel in, because #975's milestone has none either.
 */
export interface RefinementProgressMilestoneView {
  milestoneId: string;
  kind: RefinementProgressMilestoneKind;
  /** The refinement state literal at that boundary. */
  state: RefinementState | null;
  round: number | null;
  role: RefinementProgressRole | null;
  attempt: number | null;
  agent: RefinementProgressStatusAgent | null;
  durationMs: number | null;
  result: string | null;
  reason: string | null;
  failureClass: string | null;
  nextAction: RefinementProgressNextAction | null;
  /** The exact committed `notBefore`, verbatim; present on `retry_scheduled`. */
  retryNotBefore: string | null;
  humanActionRequired: boolean;
  /** Absolute ISO-8601 UTC, as persisted. */
  occurredAt: string | null;
}

/**
 * The one normalized refinement-progress model every operator surface renders.
 *
 * `admin task-status --json` serializes it field-for-field, and the human
 * renderer and the admin UI both format THIS object — so the three surfaces
 * cannot disagree about a round, a deadline, or whether a human has to act.
 */
export interface RefinementProgressStatus {
  /** The milestone schema version this build implements, for a JSON reader. */
  schemaVersion: number;
  /** The authoritative task row's phase and status, carried for context. */
  phase: string;
  taskStatus: string;
  /** §15 refinement sub-state — the block's own, read back as written. */
  refinementState: RefinementState;
  terminal: boolean;
  disposition: RefinementProgressDisposition;
  round: number | null;
  attempt: number | null;
  /** The role of the last readable boundary — who the lane last heard from. */
  role: RefinementProgressRole | null;
  refinerAgent: string | null;
  criticAgent: string | null;
  lastMilestone: RefinementProgressMilestoneView | null;
  nextAction: RefinementProgressNextAction | null;
  /**
   * The authoritative retry deadline: the exact persisted `retryNotBefore` of
   * the last `retry_scheduled` boundary while that delay is still the current
   * situation, else the row's own `notBefore`. Never re-derived or reformatted.
   */
  retryNotBefore: string | null;
  /** Bounded classification of the last failure, or `null`. */
  failureClass: string | null;
  /** §13 closed-set handoff reason, from the block or the terminal boundary. */
  handoffReason: string | null;
  humanActionRequired: boolean;
  /** How many milestone events this build read successfully. */
  milestonesRecorded: number;
  /**
   * How many persisted milestone events this build REFUSED — an unsupported
   * `schemaVersion` or a `kind` outside the closed eight. Non-zero is an
   * honest "there is progress here I cannot show you", never a silent gap.
   */
  unreadableMilestones: number;
  /**
   * Whether a refused record is newer than {@link lastMilestone}. When true the
   * last readable boundary is history rather than the current position, so it
   * informs nothing but its own row.
   */
  staleAfterUnreadable: boolean;
  /**
   * #976 diagnostics on this task: committed milestones whose public comment
   * could not be projected. Surfaced because a missing comment is otherwise
   * invisible — the outbox never saw a row to dead-letter.
   */
  unpublishableComments: number;
}

// ---------------------------------------------------------------------------
// Tolerant, non-inventing field reads
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function memberOf<T extends string>(value: unknown, set: readonly T[]): T | null {
  return typeof value === "string" && (set as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readAgent(value: unknown): RefinementProgressStatusAgent | null {
  const agent = record(value);
  const agentId = str(agent["agentId"]);
  if (agentId === null) return null;
  return {
    agentId,
    provider: str(agent["provider"]) ?? "unknown",
    model: str(agent["model"]),
    effort: str(agent["effort"]),
  };
}

/**
 * Read one persisted milestone event, or `null` when this build must refuse it.
 *
 * The two refusals mirror #976's publication refusals exactly, and for the same
 * reason: a `schemaVersion` this build does not implement may have re-used a
 * field for something else, and a `kind` outside the closed eight has no
 * meaning here to render. Both are things a NEWER producer knows and this
 * reader does not, and guessing at either would put a fabricated position in
 * front of the operator who is trying to find out what actually happened.
 */
function readMilestoneEvent(event: TaskEvent): RefinementProgressMilestoneView | null {
  const data = record(event.data);
  if (data["schemaVersion"] !== REFINEMENT_PROGRESS_SCHEMA_VERSION) return null;
  const kind = memberOf(data["kind"], REFINEMENT_PROGRESS_MILESTONE_KINDS);
  if (kind === null) return null;
  const milestoneId = str(data["milestoneId"]);
  if (milestoneId === null) return null;
  const state = data["state"];
  return {
    milestoneId,
    kind,
    state: isRefinementState(state) ? state : null,
    round: counter(data["round"]),
    role: memberOf(data["role"], REFINEMENT_PROGRESS_ROLES),
    attempt: counter(data["attempt"]),
    agent: readAgent(data["agent"]),
    durationMs: counter(data["durationMs"]),
    result: str(data["result"]),
    reason: str(data["reason"]),
    failureClass: str(data["failureClass"]),
    nextAction: memberOf(data["nextAction"], REFINEMENT_PROGRESS_NEXT_ACTIONS),
    retryNotBefore: str(data["retryNotBefore"]),
    humanActionRequired: data["humanActionRequired"] === true,
    occurredAt: str(data["occurredAt"]) ?? str(event.createdAt),
  };
}

// ---------------------------------------------------------------------------
// The disposition
// ---------------------------------------------------------------------------

/**
 * Classify what the lane is doing.
 *
 * The ROW decides, in its own order, and the milestone is consulted only where
 * the row genuinely cannot answer. That ordering is not stylistic. A task an
 * operator recovered after a hard failure is queued again while its milestone
 * log still ends at `failed`; a milestone-first classifier would report a dead
 * Issue that is in fact running, which is the one mistake this view must never
 * make. The row is the state; the milestones are where it has been.
 *
 * The two places the block or the last `kind` earns a say — and both only
 * AFTER the row's own status has been honoured:
 *
 *  - `activated` on a row still sitting in the §11 step 6 park
 *    (`blocked`/phase `implementation`), a shape indistinguishable from an
 *    ordinary dependency hold without the refinement block or the boundary that
 *    produced it. The park is the whole qualification: §12 row 33 has ordinary
 *    intake reactivate that row to `queued` at phase `implementation` while the
 *    block keeps `state: "activated"` for good, and a reactivated row is a
 *    normal implementation task waiting for its next worker — reporting it
 *    `activated` would hide that it is moving again. The same guard is what
 *    keeps a retained terminal state from overriding a recovered row;
 *  - `failed` under a `ready_for_human` row — §18 requires the lane to record a
 *    terminal refinement process failure as `ready_for_human` rather than
 *    `failed`, so under that disposition a hard failure and a §13 handoff read
 *    identically from the row while the operator's next step differs.
 *
 * `now` is optional. With it, a `notBefore` that has already passed is a task
 * merely waiting for a worker turn (`queued`) rather than one still under a
 * delay; without it, a row carrying any `notBefore` is reported `delayed`,
 * which is the reading that never claims a delay has expired when it may not
 * have.
 *
 * That comparison is the scheduler's own `isDelayed`, not a string compare.
 * Both timestamps are ISO-8601 UTC but not necessarily in the same
 * representation — a persisted `notBefore` may omit milliseconds, and
 * `2026-08-22T00:00:00Z` sorts after `2026-08-22T00:00:00.000Z`
 * lexicographically while naming the same instant. Comparing parsed instants,
 * through the exact predicate the claim path uses, is what keeps this view from
 * reporting a delay on a task the scheduler is already willing to hand out.
 */
function classifyDisposition(
  task: AiTask,
  state: RefinementState,
  kind: RefinementProgressMilestoneKind | null,
  now: string | undefined,
): RefinementProgressDisposition {
  if (task.status === "claimed" || task.status === "running") return "running";
  if (task.status === "failed" || task.status === "cancelled") return "failed";
  if (task.status === "done") return "activated";
  if (task.status === "ready_for_human") return kind === "failed" ? "failed" : "awaiting_human";
  // The two parks a `blocked` row can be sitting in beyond the ordinary §4
  // hold. Both are read from the park the row is STILL in, never from a
  // terminal state a row that has since moved on happens to keep carrying.
  if (task.status === "blocked") {
    if (task.phase === "implementation" && (state === "activated" || kind === "activated")) {
      return "activated";
    }
    if (state === "escalated_human") return "awaiting_human";
  }
  if (task.notBefore && (now === undefined || isDelayed(task, now))) return "delayed";
  return "queued";
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * Project the normalized operator view for a refinement task, or `null` for a
 * task that carries no §15 block at all.
 *
 * `null` is the ordinary answer — every task outside this lane — and it renders
 * nothing, so operator output for every other task is byte-identical to what it
 * was. `events` is optional: without it the block-derived half (state, agents,
 * handoff reason, disposition) still renders in full, and only the
 * milestone-derived half is reported absent rather than guessed.
 */
export function summarizeRefinementProgress(
  task: AiTask,
  events?: readonly TaskEvent[],
  now?: string,
): RefinementProgressStatus | null {
  const block = record(task.context?.[REFINEMENT_CONTEXT_KEY]);
  // The same admission test `summarizeRefinementStatus` applies, deliberately:
  // the two projections must agree about which tasks are refinement tasks, or a
  // surface could render a progress view beside "no refinement state".
  const rawState = block["state"];
  if (!isRefinementState(rawState)) return null;
  const state: RefinementState = rawState;
  const roles = record(block["roles"]);
  const counters = record(block["counters"]);

  let last: RefinementProgressMilestoneView | null = null;
  let lastRetry: RefinementProgressMilestoneView | null = null;
  let milestonesRecorded = 0;
  let unreadableMilestones = 0;
  let staleAfterUnreadable = false;
  let unpublishableComments = 0;
  for (const event of events ?? []) {
    if (event.type === REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT) {
      unpublishableComments += 1;
      continue;
    }
    if (event.type !== REFINEMENT_PROGRESS_EVENT_TYPE) continue;
    const milestone = readMilestoneEvent(event);
    if (milestone === null) {
      unreadableMilestones += 1;
      // Everything readable so far is now behind an unreadable record, so it
      // describes where the Issue WAS, not where it is.
      staleAfterUnreadable = true;
      continue;
    }
    milestonesRecorded += 1;
    staleAfterUnreadable = false;
    last = milestone;
    if (milestone.kind === "retry_scheduled") lastRetry = milestone;
  }

  const trusted = staleAfterUnreadable ? null : last;
  const disposition = classifyDisposition(task, state, trusted?.kind ?? null, now);
  // The persisted deadline is authoritative only while the delay it describes
  // is still the situation; a retry that has since been superseded by another
  // boundary must not keep advertising a wake-up time that no longer applies.
  const retryNotBefore =
    disposition === "delayed"
      ? (trusted?.kind === "retry_scheduled" ? lastRetry?.retryNotBefore : null)
        ?? str(task.notBefore)
      : null;
  const blockHandoff = block["handoffReason"];

  return {
    schemaVersion: REFINEMENT_PROGRESS_SCHEMA_VERSION,
    phase: task.phase,
    taskStatus: task.status,
    refinementState: state,
    terminal: state === "activated" || state === "escalated_human",
    disposition,
    round: trusted?.round ?? counter(counters["rounds"]),
    attempt: trusted?.attempt ?? null,
    role: trusted?.role ?? null,
    refinerAgent: str(roles["refinerAgent"]),
    criticAgent: str(roles["criticAgent"]),
    lastMilestone: last,
    nextAction: trusted?.nextAction ?? null,
    retryNotBefore,
    failureClass: trusted?.failureClass ?? null,
    handoffReason: isRefinementHandoffReason(blockHandoff)
      ? blockHandoff
      : trusted?.kind === "human_handoff"
        ? trusted.reason
        : null,
    // Derived from the disposition rather than read off the last milestone, so
    // the two can never contradict each other. A milestone's own
    // `humanActionRequired` is a fact about the boundary it recorded, not about
    // now: an operator who recovered a failed refinement has already acted, and
    // a flag that still demanded action would be asking for it twice. It stays
    // visible, unmodified, on `lastMilestone`.
    humanActionRequired: disposition === "failed" || disposition === "awaiting_human",
    milestonesRecorded,
    unreadableMilestones,
    staleAfterUnreadable,
    unpublishableComments,
  };
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

/** One line per disposition, in the words an operator triages by. */
export const REFINEMENT_PROGRESS_DISPOSITION_PHRASES: Record<
  RefinementProgressDisposition,
  string
> = {
  running: "a worker is running it now",
  queued: "waiting for a worker turn",
  delayed: "delayed until the retry deadline below",
  activated: "applied; implementation activated",
  failed: "ended non-retryably — no automatic retry follows",
  awaiting_human: "stopped; waiting for a human",
};

function agentCell(agent: RefinementProgressStatusAgent): string {
  return (
    agent.agentId
    + `/${agent.provider}`
    + (agent.model ? ` model=${agent.model}` : "")
    + (agent.effort ? ` effort=${agent.effort}` : "")
  );
}

/**
 * Render the normalized view for a text surface.
 *
 * Timestamps are the exact persisted UTC instants, printed as they are stored:
 * the retry deadline is the one number an operator acts on, and a reformatted
 * copy of it is a second value to reconcile against the row. An absent field
 * contributes no line rather than a `-` placeholder for something that has no
 * value yet.
 */
export function renderRefinementProgressLines(
  progress: RefinementProgressStatus,
  indent = "",
): string[] {
  const lines: string[] = [];
  lines.push(
    `${indent}progress: ${progress.disposition}`
    + ` (${REFINEMENT_PROGRESS_DISPOSITION_PHRASES[progress.disposition]})`
    + (progress.humanActionRequired ? " — HUMAN ACTION REQUIRED" : ""),
  );
  const m = progress.lastMilestone;
  lines.push(
    `${indent}  last milestone: ${m ? m.kind : "(none recorded)"}`
    + (m?.occurredAt ? ` at ${m.occurredAt}` : "")
    + (m?.result ? ` result=${m.result}` : "")
    + (progress.staleAfterUnreadable ? " (superseded by an unreadable record)" : ""),
  );
  const position = [
    `round=${progress.round ?? "-"}`,
    `attempt=${progress.attempt ?? "-"}`,
    `role=${progress.role ?? "-"}`,
    `next=${progress.nextAction ?? "-"}`,
  ].join(" ");
  lines.push(`${indent}  ${position}`);
  if (m?.agent) lines.push(`${indent}  agent: ${agentCell(m.agent)}`);
  if (progress.retryNotBefore) {
    lines.push(`${indent}  retry not before: ${progress.retryNotBefore} (UTC)`);
  }
  if (progress.failureClass || progress.handoffReason) {
    lines.push(
      `${indent}  failure=${progress.failureClass ?? "-"} handoff=${progress.handoffReason ?? "-"}`,
    );
  }
  lines.push(
    `${indent}  milestones: ${progress.milestonesRecorded} recorded`
    + (progress.unreadableMilestones > 0
      ? `, ${progress.unreadableMilestones} unreadable by this build`
      : "")
    + (progress.unpublishableComments > 0
      ? `, ${progress.unpublishableComments} not published as a comment`
      : ""),
  );
  return lines;
}
