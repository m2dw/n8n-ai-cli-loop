/**
 * Issue #848: the OPERATOR view of the review-dispute protocol
 * (docs/review-dispute-contract.md §9, §10.1, §10.3).
 *
 * A pure projection of two things a task already carries — the persisted §10.1
 * block and the bounded §10.3 transition events — into the shape `admin
 * task-status` and the admin UI render. It reads nothing else. In particular it
 * never opens a §10.2 artifact, so the arbiter's reasoning and confidence, the
 * rebuttal prose, and the evidence excerpts are not merely omitted from operator
 * output: they are not reachable from here, which is what keeps the operator
 * surface honest about what the protocol actually persists.
 *
 * Two design points that matter more than they look:
 *
 *  - The block is read TOLERANTLY, not validated. `admin task-status` is the
 *    command an operator runs when something is wrong, and a block that fails
 *    §6.1 validation is exactly such a case; refusing to render it would hide
 *    the state at the moment it is most needed. What the reader will not do is
 *    invent: a field it cannot read as the right type is reported absent rather
 *    than defaulted to a plausible number.
 *  - The next action is a CLOSED classification, and "no automated action is
 *    authorized" is a first-class answer rather than a fallback. §9's handoffs
 *    are, with one exception, terminal for automation: the contract defines no
 *    transition that carries a human's verdict back into the debate, and
 *    inventing one here would be inventing protocol. Where that is the case the
 *    projection says so, names the exact stop reason, and points at the existing
 *    recovery path — see {@link DisputeNextAction}.
 */

import type { AiTask, TaskEvent } from "./task.js";
import type { LineageState, LineageCounters, FindingSeverity } from "./review-dispute.js";
import { isLineageState, isTerminalLineageState } from "./review-dispute.js";
import { REVIEW_DISPUTE_CONTEXT_KEY, REVIEW_DISPUTE_TRANSITION_EVENT } from "./review-dispute-commit.js";

/** One lineage, exactly as §10.1 persists it. */
export interface DisputeLineageStatus {
  lineageId: string;
  version: number;
  state: LineageState | null;
  /** The §11 outcome literal, present only on a terminal lineage. */
  outcome: string | null;
  terminal: boolean;
  severity: FindingSeverity | null;
  /** Admission-normalized and repository-relative (§2.1); never an absolute path. */
  affectedBoundary: string | null;
  humanGate: boolean;
  reopenRequested: boolean;
  counters: LineageCounters;
}

/** The §7.1 routing intent of the last committed transition, from its §10.3 event. */
export interface DisputeRoutingStatus {
  rule: number | null;
  outcome: string | null;
  turn: string | null;
  nextPhase: string | null;
  readyForHuman: boolean;
  /**
   * The §7.1 turn this runner could not dispatch, when the #840 commit parked
   * the task for that reason. This is the one stop reason that is invisible in
   * the lineage records themselves — the lineage stays exactly where it was —
   * so it has to come from the event.
   *
   * Typed `string` rather than `DisputeTaskTurn`: it is read back out of a
   * persisted event payload, and a value that is not in today's vocabulary is
   * reported as it was written rather than dropped or coerced.
   */
  undispatchedTurn: string | null;
  escalatedLineageIds: string[];
  reopenRequestedLineageIds: string[];
  at: string | null;
}

/**
 * What an operator may do next.
 *
 * `authorized: false` is not an error state. It is the contract's answer for
 * every §9 handoff that has no defined transition back into automation, and the
 * `reason` token is the machine-readable stop reason a caller should key on
 * rather than parsing `description`.
 */
export type DisputeNextAction =
  | {
      authorized: true;
      /**
       * A closed token; `command` is the exact non-interactive form when one
       * applies, and is absent when the supported action is "wait".
       *
       * §6.4's reopen request is deliberately NOT one of these: it is available
       * whenever a resolved lineage exists, independently of what the task is
       * waiting on, so it is reported as {@link DisputeTaskStatus.reopenEligibleLineageIds}
       * rather than as the single next action. Folding it in here would have a
       * running task's "next action" read as "flag a resolution", which is not
       * what an operator should do next.
       */
      action: "await_automation" | "recover_cap_handoff";
      description: string;
      command?: string[];
    }
  | {
      authorized: false;
      reason:
        | "undispatched_turn"
        | "lineage_escalated_human"
        | "human_handoff"
        | "task_terminal";
      description: string;
    };

export interface DisputeTaskStatus {
  reviewStructure: string | null;
  pendingReReview: boolean;
  resolvedWithoutChanges: boolean;
  lineages: DisputeLineageStatus[];
  routing: DisputeRoutingStatus | null;
  /**
   * Terminal lineages an operator may still flag under §6.4. The ONE
   * contract-defined operator-initiated transition, and deliberately narrow: it
   * records a request on a resolution, it does not overturn one.
   */
  reopenEligibleLineageIds: string[];
  nextAction: DisputeNextAction;
}

// ---------------------------------------------------------------------------
// Tolerant readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function readCounters(value: unknown): LineageCounters {
  const raw = asRecord(value) ?? {};
  return {
    rebuttals: asCount(raw["rebuttals"]),
    reconsiderations: asCount(raw["reconsiderations"]),
    arbitrationPasses: asCount(raw["arbitrationPasses"]),
    malformedArbiterAttempts: asCount(raw["malformedArbiterAttempts"]),
    evidenceRoundsUsed: asCount(raw["evidenceRoundsUsed"]),
  };
}

function readLineage(lineageId: string, value: unknown): DisputeLineageStatus {
  const raw = asRecord(value) ?? {};
  // Bound to locals before narrowing: an element access on an index signature is
  // not a narrowable reference everywhere, and a field that fails its check is
  // reported ABSENT rather than defaulted — an operator reading "(unreadable
  // state)" is being told the truth, whereas a defaulted `open` would not be.
  const rawState = raw["state"];
  const state: LineageState | null = isLineageState(rawState) ? rawState : null;
  const rawSeverity = raw["severity"];
  const severity: FindingSeverity | null =
    rawSeverity === "P1" || rawSeverity === "P2" ? rawSeverity : null;
  return {
    lineageId,
    version: asCount(raw["version"]),
    state,
    outcome: asStringOrNull(raw["outcome"]),
    terminal: state !== null && isTerminalLineageState(state),
    severity,
    affectedBoundary: asStringOrNull(raw["affectedBoundary"]),
    humanGate: raw["humanGate"] === true,
    reopenRequested: raw["reopenRequested"] === true,
    counters: readCounters(raw["counters"]),
  };
}

/**
 * The last committed §10.3 transition event, or null when the task has none.
 *
 * "Last" by array order rather than by timestamp: both stores append events in
 * commit order, and two transitions committed inside the same millisecond would
 * otherwise be ordered arbitrarily by a timestamp comparison.
 */
function lastTransitionEvent(events: readonly TaskEvent[] | undefined): TaskEvent | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === REVIEW_DISPUTE_TRANSITION_EVENT) return events[i];
  }
  return null;
}

function readRouting(events: readonly TaskEvent[] | undefined): DisputeRoutingStatus | null {
  const event = lastTransitionEvent(events);
  if (event === null) return null;
  const data = asRecord(event.data) ?? {};
  const routing = asRecord(data["routing"]) ?? {};
  const rawRule = routing["rule"];
  return {
    rule: typeof rawRule === "number" ? rawRule : null,
    outcome: asStringOrNull(routing["outcome"]),
    turn: asStringOrNull(routing["turn"]),
    nextPhase: asStringOrNull(routing["nextPhase"]),
    readyForHuman: routing["readyForHuman"] === true,
    undispatchedTurn: asStringOrNull(data["undispatchedTurn"]),
    escalatedLineageIds: asIdList(routing["escalatedLineageIds"]),
    reopenRequestedLineageIds: asIdList(routing["reopenRequestedLineageIds"]),
    at: asStringOrNull(event.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Next action
// ---------------------------------------------------------------------------

/**
 * The non-interactive form of the §6.4 request, so CLI and UI cannot drift.
 *
 * `dbPath` and `sessionsPath` carry the store and registry the caller is itself
 * reading, and both must survive into the printed command: `dispute reopen`
 * resolves the session from the registry to get the §6.1 limits it validates the
 * stored block against, so a command that drops a custom `--sessions-path` would
 * be run against the default registry — where the session may be missing
 * entirely, or where a different session shares the id and supplies limits the
 * stored block was never produced under. Omit either only when the caller is
 * genuinely on the default.
 *
 * What is passed is the caller's choice: an interactive surface passes the real
 * paths so the line is copy/paste-ready, while a surface whose output may be
 * forwarded or recorded passes a `<SESSIONS_PATH>`-style placeholder to keep
 * absolute local paths out of it. Either way the flag is present, so the
 * operator cannot silently inherit the wrong registry.
 */
export function disputeReopenArgv(input: {
  sessionId: string;
  issueNumber: number;
  lineageId: string;
  version: number;
  dbPath?: string;
  sessionsPath?: string;
}): string[] {
  return [
    "dispute",
    "reopen",
    "--session-id",
    input.sessionId,
    "--issue-number",
    String(input.issueNumber),
    "--lineage-id",
    input.lineageId,
    "--version",
    String(input.version),
    ...(input.dbPath ? ["--db-path", input.dbPath] : []),
    ...(input.sessionsPath ? ["--sessions-path", input.sessionsPath] : []),
  ];
}

/**
 * Classify the one supported next action, in contract precedence order.
 *
 * The order is not cosmetic — each rule shadows the ones below it for a reason:
 *
 *  1. The review-loop cap handoff (§6.3/§9) is a TASK-level outcome with no
 *     lineage state behind it, and it has a real, long-standing continuation
 *     (`recover-cap-handoff`) that resets the cycle counter. It comes first
 *     because a capped task may also carry lineages that look actionable, and
 *     requeuing it any other way trips the cap again immediately.
 *  2. The undispatched-turn park (§9) means the protocol WANTED to keep running
 *     and this runner could not take the turn. There is nothing for an operator
 *     to decide: no lineage moved, no counter was spent, and the debate resumes
 *     by itself once the dispatcher exists (#849). Requeuing it manually would
 *     hand a `disputed`/`arbitration_pending` lineage to an ordinary review run,
 *     which is precisely the wrong-handler discharge #840 parks to prevent — so
 *     no automated action is offered, and the stop reason is stated instead.
 *  3. A lineage in `escalated_human` on a parked task is §9's core case:
 *     contract ambiguity, low arbiter confidence, human-gated risk, an
 *     unavailable arbiter, a `blocked` disposition. The contract defines NO
 *     transition that returns one to automation — gap G1 in
 *     docs/review-dispute-contract.md §15 — so this fails closed rather than
 *     inventing a human verdict that patches the block directly. It is gated on
 *     the task being parked: §7.1 rule 1 always parks a task carrying an
 *     escalated lineage, so a task that is somehow still runnable is one
 *     automation owns, and telling an operator to act on it would be wrong.
 *  4. Any other `ready_for_human` task is a plain handoff, handled by the
 *     existing recovery commands and not by anything dispute-specific.
 *  5. A live task needs no operator action at all; naming the turn automation
 *     holds is more useful than a command.
 */
export function disputeNextAction(input: {
  task: AiTask;
  lineages: readonly DisputeLineageStatus[];
  routing: DisputeRoutingStatus | null;
}): DisputeNextAction {
  const { task, lineages, routing } = input;

  if (task.status === "ready_for_human" && task.context?.["reviewLoopCapReached"] === true) {
    return {
      authorized: true,
      action: "recover_cap_handoff",
      description:
        "The review-loop cap was reached with lineages still in flight (§6.3). No lineage changed " +
        "state and no public comment was posted. Restart the review cycle with `admin " +
        "recover-cap-handoff`, which clears the cap counters the generic recover would leave behind.",
      command: [
        "recover-cap-handoff",
        "--session-id",
        task.sessionId,
        "--issue-number",
        String(task.issueNumber),
      ],
    };
  }

  const undispatched = routing?.undispatchedTurn ?? null;
  if (task.status === "ready_for_human" && undispatched !== null) {
    return {
      authorized: false,
      reason: "undispatched_turn",
      description:
        `No automated action is authorized: §7.1 selected the \`${undispatched}\` turn, whose run this ` +
        "runner does not dispatch yet, so the task parked for a human with the lineage left exactly " +
        "where its last transition put it. No counter was spent. Do not requeue it into review — an " +
        "ordinary review run cannot discharge the open lineage and would finish the task with the " +
        "dispute unresolved. The debate resumes on its own once the dispatcher lands.",
    };
  }

  const escalated = lineages.filter((l) => l.state === "escalated_human");
  if (task.status === "ready_for_human" && escalated.length > 0) {
    return {
      authorized: false,
      reason: "lineage_escalated_human",
      description:
        `No automated action is authorized: ${escalated.length} lineage(s) reached \`escalated_human\` ` +
        `(${escalated.map((l) => l.lineageId).join(", ")}), which §9 reserves for a human decision — ` +
        "contract ambiguity, low arbiter confidence, human-gated risk, exhausted evidence, or an " +
        "unavailable arbiter. The contract defines no transition that carries a human verdict back " +
        "into the debate, so the decision is made on the PR itself; the lineage record stays as the " +
        "audit trail of how it got here.",
    };
  }

  if (task.status === "ready_for_human") {
    return {
      authorized: false,
      reason: "human_handoff",
      description:
        "No dispute-specific action is authorized: the task is parked for a human but no lineage is " +
        "escalated. Use the ordinary handoff paths (`admin human-review-return`, or `admin recover " +
        "--from ready_for_human --phase <phase>`); neither touches the protocol block.",
    };
  }

  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
    return {
      authorized: false,
      reason: "task_terminal",
      description: `No action is authorized: the task is ${task.status}. The lineage records remain as audit history.`,
    };
  }

  const turn = routing?.turn ?? null;
  const nextPhase = routing?.nextPhase ?? null;
  const held =
    turn === null
      ? ""
      : ` (\`${turn}\`${nextPhase === null ? "" : ` at phase \`${nextPhase}\``})`;
  return {
    authorized: true,
    action: "await_automation",
    description:
      `No operator action is required: the task is ${task.status} and automation holds the next turn${held}.`,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Project a task's persisted dispute state, or `null` when it has none.
 *
 * `null` is the legacy answer and it is load-bearing: a task from before the
 * protocol — or from a session with `reviewDispute.enabled: false`, which never
 * writes a block — produces no dispute output at all, so every existing
 * human-readable line and `--json` field stays exactly as it was.
 *
 * `events` is optional. Without it the lineage state, counters, and flags are
 * still complete (they live in the context block); only the §7.1 routing intent
 * and the undispatched-turn stop reason are unavailable, both of which are
 * event-only facts.
 */
export function summarizeDisputeStatus(
  task: AiTask,
  events?: readonly TaskEvent[],
): DisputeTaskStatus | null {
  const block = asRecord(task.context?.[REVIEW_DISPUTE_CONTEXT_KEY]);
  if (block === null) return null;

  const rawLineages = asRecord(block["lineages"]) ?? {};
  const lineages = Object.keys(rawLineages)
    .sort()
    .map((lineageId) => readLineage(lineageId, rawLineages[lineageId]));

  const routing = readRouting(events);

  return {
    reviewStructure: asStringOrNull(block["reviewStructure"]),
    pendingReReview: block["pendingReReview"] === true,
    resolvedWithoutChanges: block["resolvedWithoutChanges"] === true,
    lineages,
    routing,
    // §6.4 applies to a terminal lineage that does not already carry the flag.
    // An `escalated_human` lineage is excluded: it is already with a human, and a
    // request to reopen it would re-escalate what is already escalated.
    reopenEligibleLineageIds: lineages
      .filter((l) => l.terminal && l.state !== "escalated_human" && !l.reopenRequested)
      .map((l) => l.lineageId),
    nextAction: disputeNextAction({ task, lineages, routing }),
  };
}
