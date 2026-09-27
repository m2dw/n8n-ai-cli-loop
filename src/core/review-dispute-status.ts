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
import {
  REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY,
  REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD,
  parseReconsiderationLineageRecord,
} from "./review-dispute-reconsiderations.js";
import type { DisputeEvidenceRoundStatus } from "./review-dispute-evidence-state.js";
import {
  REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY,
  projectEvidenceRoundStatus,
} from "./review-dispute-evidence-state.js";

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

/**
 * The LAST reviewer sub-turn this task took, as an operator surface may state it
 * (issue #1085; contract §17.6 D2, §17.16).
 *
 * One field here is a protocol fact rather than provenance, and it is the reason
 * this projection exists: `toolPolicy`. A lineage decided under `read-bounded`
 * was decided by an agent that could read outside the runner-supplied bundle, and
 * §17.6 requires that to stay visible — so it is surfaced beside the debate
 * rather than only inside the §10.2 record artifact, which an operator reading
 * `dispute status` does not have in front of them.
 *
 * Read tolerantly and never defaulted: an unreadable or absent value reports
 * `null`, which says "this task has no reviewer run on record" — it never says
 * `no-tools`. Inventing the stricter posture for a record that does not state it
 * is exactly the misreading the separate literal exists to prevent.
 *
 * Single-valued, like the summary it projects: a task that disputed two findings
 * takes two reviewer runs and this describes the later one. `lineageId` is what
 * says which — and {@link DisputeTaskStatus.reconsiderationsByLineage} is what
 * keeps the EARLIER one's posture readable, since D2's guarantee is about a
 * lineage rather than about a task's most recent run.
 */
export interface DisputeReconsiderationStatus {
  lineageId: string | null;
  version: number;
  /** The agent that actually ran, as its own run recorded it. */
  agentId: string | null;
  /** The posture that run ENFORCED, verbatim. `null` when the record omits it. */
  toolPolicy: string | null;
  timedOut: boolean;
  /** The invocation failure kind, when the run did not produce a record. */
  failure: string | null;
}

/**
 * One lineage's OWN reviewer run, from the per-lineage record (issue #1085
 * review, P2).
 *
 * {@link DisputeReconsiderationStatus} is single-valued and therefore describes
 * the LAST reviewer run a task took. A task that disputed two findings takes two
 * reviewer runs, and on the second one the first lineage's posture and agent
 * disappear from that summary entirely — which is precisely the association
 * §17.6's D2 row requires to survive: a lineage decided under `read-bounded` must
 * stay identifiable as such after a later lineage was decided under something
 * else.
 *
 * So the posture is projected here per lineage as well, out of
 * `reviewDisputeReconsiderations` — the record each reviewer run merges its own
 * entry into rather than overwriting. `toolPolicy` is reported exactly as that
 * run recorded it, or `null` for a run that recorded none (a debate from before
 * the field, or a run that resolved no profile). Never defaulted to `no-tools`.
 */
export interface DisputeLineageReconsiderationStatus {
  lineageId: string;
  /** The §2.1 version that run answered. */
  version: number;
  agentId: string | null;
  /** The posture that run ENFORCED, verbatim. `null` when it recorded none. */
  toolPolicy: string | null;
}

export interface DisputeTaskStatus {
  reviewStructure: string | null;
  pendingReReview: boolean;
  resolvedWithoutChanges: boolean;
  lineages: DisputeLineageStatus[];
  routing: DisputeRoutingStatus | null;
  /**
   * §7.1's bounded evidence round, per lineage that has one (issue #956).
   *
   * Empty for every task that has collected no evidence, which is most of them —
   * the record exists only between the two evidence-collection runs and only
   * while a lineage is in `evidence_requested`. It is the one part of the debate
   * whose stall is invisible in the lineage record itself: a lineage waiting for
   * its second party and a lineage nothing has dispatched for look identical
   * from §10.1, and this is what tells them apart.
   *
   * Counts and literals only. The admitted references, their digests, and the
   * §10.2 artifact names stay in the record and in the artifacts — an operator
   * surface is one comment away from being a publication surface (§11).
   */
  evidenceCollection: DisputeEvidenceRoundStatus[];
  /**
   * The last §4.1 reviewer run, or `null` for a task that has taken none — which
   * is most of them, and every task from before issue #1085.
   */
  lastReconsideration: DisputeReconsiderationStatus | null;
  /**
   * Every lineage that has taken a §4.1 reviewer run, with the posture that run
   * enforced — ordered by lineage id, and empty for a task that has taken none.
   *
   * This is what keeps an EARLIER lineage's posture readable after a later
   * reviewer run rewrote {@link lastReconsideration} (issue #1085 review, P2).
   */
  reconsiderationsByLineage: DisputeLineageReconsiderationStatus[];
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
 * Project the reviewer sub-turn summary an operator surface may state.
 *
 * Tolerant on every field for the reason every reader of task context here is:
 * the value is persisted JSON that a stale or hand-edited task may carry in any
 * shape. What it must never do is SUPPLY a posture — `toolPolicy` is reported
 * exactly as recorded or as `null`, because "this run enforced no-tools" is a
 * claim only the run that made it can make (issue #1085).
 */
function readReconsideration(value: unknown): DisputeReconsiderationStatus | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const profile = asRecord(raw["profile"]);
  const failure = asRecord(raw["failure"]);
  return {
    lineageId: asStringOrNull(raw["lineageId"]),
    version: asCount(raw["version"]),
    agentId: profile === null ? null : asStringOrNull(profile["agentId"]),
    toolPolicy: profile === null ? null : asStringOrNull(profile["toolPolicy"]),
    timedOut: raw["timedOut"] === true,
    failure: failure === null ? null : asStringOrNull(failure["kind"]),
  };
}

/**
 * Project the PER-LINEAGE reviewer runs, ordered by lineage id.
 *
 * Reads the same record every later sub-turn resolves against, through the same
 * parser — so a malformed entry is dropped here exactly as it is there, and the
 * operator surface cannot show a reviewer run a dispatch would refuse to use. No
 * field is defaulted: an entry with no `toolPolicy` reports `null` (issue #1085).
 */
function readReconsiderationsByLineage(value: unknown): DisputeLineageReconsiderationStatus[] {
  const record = parseReconsiderationLineageRecord(value);
  return Object.keys(record.lineages)
    .sort()
    .map((lineageId) => {
      const entry = record.lineages[lineageId];
      return {
        lineageId,
        version: entry.version,
        agentId: entry.agentId ?? null,
        toolPolicy: entry.toolPolicy ?? null,
      };
    });
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
        `No automated action is authorized: §7.1 selected the \`${undispatched}\` turn and this run ` +
        "could not answer it, so the task parked for a human with the lineage left exactly where its " +
        "last transition put it. No counter was spent. Every §7.1 turn has a dispatcher, so this is a " +
        "fail-closed stop and not a missing feature: the run could not read what the turn needs — a " +
        "§10.2 record it cannot locate in this checkout, a persisted round record it cannot parse, or " +
        "a party whose agent identity it cannot name. Read the sub-turn summary for the specific " +
        "reason. Requeuing the task repeats the same stop until that input is available, and " +
        "requeuing it into an ordinary review is worse — such a run cannot discharge the open lineage " +
        "and would finish the task with the dispute unresolved.",
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
    // Read from the raw context value, tolerantly, for the same reason the block
    // is: the round an operator most needs to see is the one a dispatch refused.
    evidenceCollection: projectEvidenceRoundStatus(task.context?.[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]),
    // The posture the last reviewer run enforced, beside the debate it decided
    // (issue #1085). Read from the raw context value on the same terms.
    lastReconsideration: readReconsideration(task.context?.[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY]),
    // And the same posture per lineage, which is what the single-valued summary
    // above cannot express once a task has debated two findings: the second
    // reviewer run rewrites it, and the first lineage's posture would otherwise
    // be readable only from that run's artifact directory (issue #1085 review, P2).
    reconsiderationsByLineage: readReconsiderationsByLineage(
      task.context?.[REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD],
    ),
    // §6.4 applies to a terminal lineage that does not already carry the flag.
    // An `escalated_human` lineage is excluded: it is already with a human, and a
    // request to reopen it would re-escalate what is already escalated.
    reopenEligibleLineageIds: lineages
      .filter((l) => l.terminal && l.state !== "escalated_human" && !l.reopenRequested)
      .map((l) => l.lineageId),
    nextAction: disputeNextAction({ task, lineages, routing }),
  };
}
