/**
 * Event-derived review-dispute metrics (issue #849, docs/review-dispute-contract.md
 * §10.3; docs/review-dispute-operations.md).
 *
 * A read-only projection over the bounded `review.dispute.transition` task
 * events the #840 transition layer commits alongside each phase completion. It
 * is deliberately the ONLY thing this module reads:
 *
 *  - not §10.2 artifacts — those hold arbiter reasoning, rebuttal prose and
 *    evidence excerpts, none of which may leave the local audit trail;
 *  - not public GitHub comments — §11 output is a rendering of these same
 *    events, so counting it would count the same fact twice and would require a
 *    network call from a reporting command;
 *  - not `task.context.reviewDispute` — the persisted block holds the CURRENT
 *    state of each lineage, not the path it took, so it cannot answer "how many
 *    rebuttals were rejected" at all.
 *
 * Everything here is pure. The caller supplies the events; this module folds
 * them into one closed-shape record whose every key is always present, so the
 * `--json` payload of `admin dispute metrics` has a stable schema whether the
 * session ran one dispute or none.
 *
 * Two properties the aggregation is built around:
 *
 *  - **Idempotence.** A transition is counted once per `transitionKey` (#840's
 *    `<lineageId>@<version>#<runId>` digest), and an entry the transition layer
 *    already marked `replayed` is never counted at all. A duplicate decision
 *    delivery, a worker retry, an outbox replay, or a re-read of the same event
 *    stream after a process restart therefore all produce identical counts.
 *  - **No counterfactuals.** Nothing here claims a review loop was "prevented".
 *    {@link DisputeMetrics.lineagesResolvedWithoutHuman} is an OBSERVABLE proxy
 *    with a documented definition (see its doc comment), not a saving.
 */

import type { TaskEvent } from "./task.js";
import type { DisputeAuditEvent, LineageState, TerminalLineageState } from "./review-dispute.js";
import { DISPUTE_AUDIT_EVENTS, TERMINAL_LINEAGE_STATES, isLineageState, isTerminalLineageState } from "./review-dispute.js";
import { DISPUTE_TRANSITION_KINDS, DISPUTE_TRANSITION_REASONS } from "./review-dispute-transition.js";
import type { DisputeTransitionKind, DisputeTransitionReason } from "./review-dispute-transition.js";
import { REVIEW_DISPUTE_TRANSITION_EVENT } from "./review-dispute-commit.js";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** An inclusive `[from, to]` bound on `TaskEvent.createdAt`; either end may be open. */
export interface DisputeMetricsWindow {
  from: string | null;
  to: string | null;
}

/** Per-lineage terminal-outcome tallies, keyed by the §11 outcome literal. */
export type TerminalOutcomeCounts = Record<TerminalLineageState, number>;

export interface DisputeMetrics {
  sessionId: string;
  window: DisputeMetricsWindow;

  /** Tasks whose event stream was read (the session's tasks, after any filter). */
  tasksScanned: number;
  /** Tasks that contributed at least one in-window transition event. */
  tasksWithDisputeActivity: number;

  /** In-window `review.dispute.transition` events read. */
  transitionEvents: number;
  /** Distinct transitions counted (deduplicated by `transitionKey`). */
  transitionsApplied: number;
  /**
   * Transition entries NOT counted because they were re-deliveries: either the
   * transition layer marked them `replayed`, or this fold had already seen the
   * same `transitionKey`. A non-zero value is normal (a retried worker), not a
   * fault; it exists so an operator can tell a real second decision from a
   * duplicate delivery of the first.
   */
  transitionsDeduplicated: number;
  /** §12 decisions the transition layer refused, across all in-window events. */
  decisionsRefused: number;
  /** #847 typed non-row failures recorded by an arbitration turn. */
  operationalFailures: number;

  /** §2.2 lineages opened at version 1 by an admitted structured finding. */
  findingsOpened: number;
  /**
   * §3.2 disputes admitted against a finding version — counted from the
   * `rebuttals` counter each transition moved, NOT from an audit-event literal.
   * A human-gated dispute (§7 rows 3/7) consumes its rebuttal slot and reports
   * `dispute.escalated.human`, so counting the literal would undercount exactly
   * the disputes an operator most wants to see.
   */
  rebuttalsRecorded: number;
  /** §12: a rebuttal the protocol rejected without changing any state. */
  rebuttalsRejected: number;
  /**
   * §4.1 reviewer reconsiderations recorded, from the `reconsiderations`
   * counter. Same reason as above: `withdraw` reports `dispute.resolved` and
   * `revise` reports its materiality, so only `uphold` names itself.
   */
  reconsiderations: number;

  /** §5 revision classifications, by the materiality the runner computed. */
  revisions: {
    material: number;
    nonMaterial: number;
    ambiguous: number;
  };

  arbitration: {
    /**
     * §8.1 verdicts admitted, decisive or not — one per arbitration pass spent.
     * Rows 13–18 all spend a pass because the arbiter answered; row 19 (no
     * acceptable candidate) spends nothing because it never ran.
     */
    verdicts: number;
    /** §12 malformed arbiter answers, at or below the §6.1 cap (rows 20/21). */
    malformedAttempts: number;
  };

  evidence: {
    /** Row 16: a bounded evidence round requested. */
    requested: number;
    /** Row 22: a requested round's attachments recorded, from the counter. */
    recorded: number;
  };

  /** §11 outcome literals stamped on lineages that became terminal in-window. */
  terminalOutcomes: TerminalOutcomeCounts;
  /** §9 escalations (the `escalated_human` half of `terminalOutcomes`, by event). */
  humanEscalations: number;
  /** §6.4 operator reopen requests recorded against a terminal lineage. */
  reopenRequests: number;

  /** Distinct lineages observed reaching ANY terminal state in-window. */
  lineagesReachedTerminal: number;
  /**
   * Distinct lineages observed reaching a terminal state OTHER than
   * `escalated_human`, and never observed escalating or carrying a §6.4 reopen
   * request in-window.
   *
   * This is an observable proxy, not a saving: it counts disagreements the
   * protocol closed by itself in the window that was read. It says nothing
   * about what would have happened without the protocol, and a lineage whose
   * escalation falls outside the window is counted here — widen the window
   * rather than reading this as a guarantee.
   */
  lineagesResolvedWithoutHuman: number;
  /**
   * Tasks that reached at least one terminal lineage in-window with no
   * escalation and no reopen request among ANY of their in-window lineages.
   * Same proxy caveat as {@link lineagesResolvedWithoutHuman}.
   */
  tasksResolvedWithoutHuman: number;
  /** Tasks with at least one in-window escalation or reopen request. */
  tasksEscalatedToHuman: number;

  /** §10.3 audit-event tallies. Every literal in the vocabulary is present. */
  auditEvents: Record<DisputeAuditEvent, number>;
  /** Which already-approved decision produced each counted transition. */
  decisionKinds: Record<DisputeTransitionKind, number>;
  /** The bounded reason literal each counted transition carried. */
  reasons: Record<DisputeTransitionReason, number>;
}

// ---------------------------------------------------------------------------
// Tolerant readers
//
// Events are read back out of a durable store, so every field is treated as
// unknown. A payload this module cannot read contributes nothing rather than
// throwing: a metrics report must never be the reason an operator cannot see
// the rest of a session.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * One counter's movement, as a non-negative integer.
 *
 * A counter never decreases (§6.1 — the transition layer refuses a negative
 * delta before writing it), so anything else in a persisted payload is a value
 * this reader cannot trust and contributes nothing.
 */
function asDelta(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function asAuditEvent(value: unknown): DisputeAuditEvent | null {
  return typeof value === "string" && (DISPUTE_AUDIT_EVENTS as readonly string[]).includes(value)
    ? (value as DisputeAuditEvent)
    : null;
}

function asReason(value: unknown): DisputeTransitionReason | null {
  return typeof value === "string" && (DISPUTE_TRANSITION_REASONS as readonly string[]).includes(value)
    ? (value as DisputeTransitionReason)
    : null;
}

function asKind(value: unknown): DisputeTransitionKind | null {
  return typeof value === "string" && (DISPUTE_TRANSITION_KINDS as readonly string[]).includes(value)
    ? (value as DisputeTransitionKind)
    : null;
}

function asState(value: unknown): LineageState | null {
  return isLineageState(value) ? value : null;
}

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;
  return out;
}

/** An empty report. Same closed shape as a populated one — every key present. */
export function emptyDisputeMetrics(sessionId: string, window: DisputeMetricsWindow): DisputeMetrics {
  return {
    sessionId,
    window,
    tasksScanned: 0,
    tasksWithDisputeActivity: 0,
    transitionEvents: 0,
    transitionsApplied: 0,
    transitionsDeduplicated: 0,
    decisionsRefused: 0,
    operationalFailures: 0,
    findingsOpened: 0,
    rebuttalsRecorded: 0,
    rebuttalsRejected: 0,
    reconsiderations: 0,
    revisions: { material: 0, nonMaterial: 0, ambiguous: 0 },
    arbitration: { verdicts: 0, malformedAttempts: 0 },
    evidence: { requested: 0, recorded: 0 },
    terminalOutcomes: zeroed(TERMINAL_LINEAGE_STATES as readonly TerminalLineageState[]),
    humanEscalations: 0,
    reopenRequests: 0,
    lineagesReachedTerminal: 0,
    lineagesResolvedWithoutHuman: 0,
    tasksResolvedWithoutHuman: 0,
    tasksEscalatedToHuman: 0,
    auditEvents: zeroed(DISPUTE_AUDIT_EVENTS),
    decisionKinds: zeroed(DISPUTE_TRANSITION_KINDS),
    reasons: zeroed(DISPUTE_TRANSITION_REASONS),
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One task's in-window event stream, as the caller read it from the store. */
export interface DisputeMetricsTaskInput {
  issueNumber: number;
  events: readonly TaskEvent[];
}

export interface DisputeMetricsInput {
  sessionId: string;
  tasks: readonly DisputeMetricsTaskInput[];
  /** Inclusive `createdAt` bounds. Omitted ends are open. */
  window?: { from?: string | undefined; to?: string | undefined };
}

/**
 * Is this event inside the window?
 *
 * ISO-8601 UTC timestamps compare correctly as strings, which is the same
 * property the stores' own `createdAt` ordering relies on; comparing strings
 * keeps the filter free of a timezone-dependent `Date` round trip. An event
 * with an unreadable `createdAt` is IN a report with no window and OUT of a
 * bounded one — a bound the reader cannot evaluate is not satisfied.
 */
function inWindow(event: TaskEvent, window: DisputeMetricsWindow): boolean {
  if (window.from === null && window.to === null) return true;
  const at = event.createdAt;
  if (typeof at !== "string" || at.length === 0) return false;
  if (window.from !== null && at < window.from) return false;
  if (window.to !== null && at > window.to) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** Per-lineage facts accumulated while folding, for the task-level rollups. */
interface LineageTally {
  terminal: TerminalLineageState | null;
  escalated: boolean;
  reopenRequested: boolean;
}

/**
 * Fold a session's `review.dispute.transition` events into one report.
 *
 * Deterministic: the result depends only on the SET of distinct transitions the
 * events carry, never on their order or on how many times a given event was
 * delivered.
 */
export function aggregateDisputeMetrics(input: DisputeMetricsInput): DisputeMetrics {
  const window: DisputeMetricsWindow = {
    from: input.window?.from ?? null,
    to: input.window?.to ?? null,
  };
  const metrics = emptyDisputeMetrics(input.sessionId, window);
  metrics.tasksScanned = input.tasks.length;

  // Distinct across the whole session: a lineage id is minted from the task and
  // the finding, so two tasks cannot share one, and keying the dedupe globally
  // costs nothing while making a caller that hands the same task twice harmless.
  const seenTransitions = new Set<string>();

  for (const task of input.tasks) {
    const lineages = new Map<string, LineageTally>();
    let taskHadActivity = false;

    for (const event of task.events) {
      if (event.type !== REVIEW_DISPUTE_TRANSITION_EVENT) continue;
      if (!inWindow(event, window)) continue;
      const data = asRecord(event.data);
      if (data === null) continue;
      taskHadActivity = true;
      metrics.transitionEvents += 1;

      const kind = asKind(data["decision"]);
      metrics.decisionsRefused += asArray(data["refused"]).length;
      if (asRecord(data["operational"]) !== null) metrics.operationalFailures += 1;

      for (const rawEntry of asArray(data["applied"])) {
        const entry = asRecord(rawEntry);
        if (entry === null) continue;
        const key = entry["transitionKey"];
        // A re-delivery, by either of the two ways one can present itself: the
        // transition layer recognized it against the lineage's own ledger, or
        // this fold has already counted the identical key from another event.
        if (entry["replayed"] === true || (typeof key === "string" && seenTransitions.has(key))) {
          metrics.transitionsDeduplicated += 1;
          continue;
        }
        if (typeof key === "string") seenTransitions.add(key);
        metrics.transitionsApplied += 1;
        if (kind !== null) metrics.decisionKinds[kind] += 1;

        const auditEvent = asAuditEvent(entry["auditEvent"]);
        if (auditEvent !== null) metrics.auditEvents[auditEvent] += 1;
        const reason = asReason(entry["reason"]);
        if (reason !== null) metrics.reasons[reason] += 1;

        const lineageId = typeof entry["lineageId"] === "string" ? entry["lineageId"] : null;
        const tally: LineageTally = lineageId === null
          ? { terminal: null, escalated: false, reopenRequested: false }
          : lineages.get(lineageId) ?? { terminal: null, escalated: false, reopenRequested: false };
        if (lineageId !== null) lineages.set(lineageId, tally);

        // The §6.1 counters a transition MOVED are the honest count of what the
        // debate spent: every one of them is bounded by the contract, and each
        // is incremented by exactly the transitions that consume it, whatever
        // audit-event literal the destination made that transition report.
        const delta: Record<string, unknown> = asRecord(entry["counterDelta"]) ?? {};
        metrics.rebuttalsRecorded += asDelta(delta["rebuttals"]);
        metrics.reconsiderations += asDelta(delta["reconsiderations"]);
        metrics.arbitration.verdicts += asDelta(delta["arbitrationPasses"]);
        metrics.arbitration.malformedAttempts += asDelta(delta["malformedArbiterAttempts"]);
        metrics.evidence.recorded += asDelta(delta["evidenceRoundsUsed"]);

        // Everything with no counter of its own is read off §10.3's literal.
        switch (auditEvent) {
          case "dispute.finding.opened":
            metrics.findingsOpened += 1;
            break;
          case "dispute.rebuttal.rejected":
            metrics.rebuttalsRejected += 1;
            break;
          case "dispute.revision.material":
            metrics.revisions.material += 1;
            break;
          case "dispute.revision.non_material":
            metrics.revisions.nonMaterial += 1;
            break;
          case "dispute.revision.ambiguous":
            metrics.revisions.ambiguous += 1;
            break;
          case "dispute.reopen.requested":
            metrics.reopenRequests += 1;
            tally.reopenRequested = true;
            break;
          case "dispute.escalated.human":
            metrics.humanEscalations += 1;
            tally.escalated = true;
            break;
          default:
            break;
        }
        // §10.3: the one evidence-subject literal covers BOTH ends of the
        // bounded round, so the row that asked for it is separated from the row
        // that recorded it by the reason — row 16 asks, row 22 (counted above,
        // through `evidenceRoundsUsed`) records.
        if (reason === "insufficient-evidence") metrics.evidence.requested += 1;

        // §11's outcome literal IS the terminal state the transition wrote, so
        // it is read off `toState` rather than off a second field that could
        // disagree with it.
        const toState = asState(entry["toState"]);
        const fromState = asState(entry["fromState"]);
        if (
          toState !== null
          && isTerminalLineageState(toState)
          && !(fromState !== null && isTerminalLineageState(fromState))
        ) {
          metrics.terminalOutcomes[toState] += 1;
          tally.terminal = toState;
        }
      }
    }

    if (taskHadActivity) metrics.tasksWithDisputeActivity += 1;

    let terminalLineages = 0;
    let resolvedWithoutHuman = 0;
    let humanTouched = false;
    for (const tally of lineages.values()) {
      if (tally.escalated || tally.reopenRequested) humanTouched = true;
      if (tally.terminal === null) continue;
      terminalLineages += 1;
      if (tally.terminal !== "escalated_human" && !tally.escalated && !tally.reopenRequested) {
        resolvedWithoutHuman += 1;
      }
    }
    metrics.lineagesReachedTerminal += terminalLineages;
    metrics.lineagesResolvedWithoutHuman += resolvedWithoutHuman;
    if (humanTouched) metrics.tasksEscalatedToHuman += 1;
    else if (terminalLineages > 0) metrics.tasksResolvedWithoutHuman += 1;
  }

  return metrics;
}
