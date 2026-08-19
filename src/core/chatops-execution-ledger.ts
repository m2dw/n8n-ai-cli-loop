/**
 * ChatOps execution ledger and crash/restore replay decisions (issue #782).
 *
 * This module is the *decision* layer: given a durable ledger row, the
 * authenticated evidence a complete scan of the issue produced, and an
 * epoch witness, decide which contract transition applies — and refuse
 * everything else. It never fetches anything, never persists anything, and
 * never invokes an operation; see `docs/chatops-execution-ledger-contract.md`
 * for the full contract, including what is deliberately *not* here (the
 * callable operation-dispatch port, polling, the SQLite schema, task routing
 * — tracked by issues #783-#785, #697, #915-#919, #722).
 *
 * It builds directly on:
 * - `src/core/chatops-identity.ts` (#780) for the ledger scope a row is keyed
 *   by — this module never re-derives identity.
 * - `src/core/chatops-comment-cursor.ts` (#781) for the total comment order
 *   and the complete scan window evidence is only ever read from.
 * - `src/core/chatops-command.ts` (#777) for marker parsing and the author
 *   half of marker authentication.
 *
 * Every exported function is pure and total over its documented input shape:
 * no I/O, no clock, no randomness, no store access. `nowMs` is injected where
 * elapsed time matters (contract §10.4) so a crash-recovery decision is
 * reproducible from the inputs that produced it — which is what lets an
 * operator re-run a reconciliation and get the same verdict.
 *
 * The single rule every function here serves: **the ledger prefers not
 * running a command over possibly running it twice** (contract §4). There is
 * no code path that dispatches on unresolved ambiguity.
 */

import { isAuthenticatedChatOpsMarker, parseChatOpsMarkerBody } from "./chatops-command.js";
import type { ChatOpsMarkerOutcome } from "./chatops-command.js";
import {
  CHATOPS_SCAN_SINCE_MARGIN_MS,
  compareChatOpsCommentOrderKeys,
  deriveChatOpsCommentOrderKey,
  parseChatOpsTimestamp,
} from "./chatops-comment-cursor.js";
import type { ChatOpsObservedComment } from "./chatops-comment-cursor.js";

// ---------------------------------------------------------------------------
// Bounds (contract §13, §14)
// ---------------------------------------------------------------------------

/**
 * Dispatch attempts one comment may ever begin automatically (contract §13.1).
 *
 * Exhausting it is a *definite* outcome, not an ambiguous one — every attempt
 * counted here was proven to have produced no external effect (§10.4) — so
 * row 16 acknowledges it with outcome `error` rather than escalating.
 */
export const CHATOPS_MAX_DISPATCH_ATTEMPTS = 3;

/** Acknowledgement-marker publication attempts before row 19 abandons it. */
export const CHATOPS_MAX_ACK_PUBLICATION_ATTEMPTS = 5;

/**
 * Inconclusive reconciliation passes a `dispatching` row tolerates before it
 * surfaces to an operator (contract §11.3, rows 12 and 13).
 *
 * Bounded rather than unbounded because a scope that can never reconcile is
 * not losing anything (nothing dispatches), but it is not executing anything
 * either, and that is a human-visible condition.
 */
export const CHATOPS_MAX_RECONCILE_ATTEMPTS = 3;

/**
 * How long after a write-ahead the *absence* of a claim marker may be read as
 * proof that the operation never began (contract §10.4).
 *
 * Neither supported provider documents a read-after-write visibility
 * guarantee, so a marker posted moments before a crash may not be visible to
 * the very next read. Treating a too-fresh absence as proof would convert
 * read lag into duplicate execution.
 */
export const CHATOPS_EVIDENCE_QUIESCENCE_MS = 60_000;

/** Evidence refs retained per row (contract §14). Counts stay exact regardless. */
export const CHATOPS_MAX_EVIDENCE_REFS = 8;

/** Operator-facing detail strings are truncated to this many characters (contract §14). */
export const CHATOPS_LEDGER_DETAIL_MAX_CHARS = 500;

// ---------------------------------------------------------------------------
// States and rows (contract §5, §6)
// ---------------------------------------------------------------------------

/**
 * The durable execution state of one comment (contract §6).
 *
 * `rejected` and `acknowledged` are both terminal and are deliberately not
 * interchangeable: `rejected` asserts *no operation ever ran*, `acknowledged`
 * asserts *an operation ran and this was its outcome*.
 */
export type ChatOpsLedgerState =
  | "claimed"
  | "dispatching"
  | "awaiting_ack"
  | "retry_scheduled"
  | "rejected"
  | "acknowledged"
  | "ambiguous";

/** States no automatic path ever leaves (contract §6). */
export const CHATOPS_TERMINAL_LEDGER_STATES: readonly ChatOpsLedgerState[] = Object.freeze([
  "rejected",
  "acknowledged",
  "ambiguous",
]);

/**
 * States that are terminal *and* closed to every event, including an operator
 * one. `ambiguous` is terminal for automation but re-openable by rows 21/22.
 */
export const CHATOPS_CLOSED_LEDGER_STATES: readonly ChatOpsLedgerState[] = Object.freeze([
  "rejected",
  "acknowledged",
]);

/** Publication state of the acknowledgement marker (contract §5). */
export type ChatOpsAckPublication = "not-required" | "pending" | "published" | "abandoned";

/** Why a row was handed to an operator (contract §14 — a closed set, never free text). */
export type ChatOpsLedgerHandoffReason =
  | "dispatch-crash-unresolved"
  | "reconcile-inconclusive"
  | "ledger-regression"
  | "restore-detected"
  | "witness-missing"
  | "conflicting-evidence"
  | "ack-publication-abandoned"
  | "operator-escalation";

/** The operator-facing handoff carried by every `ambiguous` row (contract §13.3). */
export interface ChatOpsLedgerHandoff {
  reason: ChatOpsLedgerHandoffReason;
  /** Bounded detail (contract §14). Never a comment body. */
  detail: string | null;
  /** True when the whole fence scope is fenced, not just this row. */
  fenceScope: boolean;
}

/** One authenticated marker, as retained on a row (contract §14). */
export interface ChatOpsEvidenceRef {
  /** Id of the marker comment itself — never the id it targets. */
  markerCommentId: string;
  kind: "claimed" | "ack";
  /** Present only for `ack` markers. */
  outcome: ChatOpsMarkerOutcome | null;
  /** The marker comment's creation timestamp, verbatim. */
  createdAt: string;
}

/**
 * The durable ledger row for one ledger scope
 * (`docs/chatops-identity-contract.md` §6) — contract §5.
 *
 * It deliberately stores no copy of the comment's body, author, or
 * timestamps: that is the first-seen record's job (#781 §9), that record is
 * write-once, and a second copy of a fact that must have exactly one is how
 * the two drift apart.
 */
export interface ChatOpsLedgerRow {
  commentId: string;
  state: ChatOpsLedgerState;
  /** Known only once a dispatch produced one, or an operator supplied one. */
  outcome: ChatOpsMarkerOutcome | null;
  /**
   * Dispatch attempts *begun* — incremented in the write-ahead transaction,
   * before any external effect, never after (contract §8, T2).
   *
   * Load-bearing, not diagnostic: contract §11.1 compares it against how many
   * claim markers the provider shows, and that comparison is the whole
   * restore detector.
   */
  attempts: number;
  /** Epoch stamped by the last write-ahead (contract §9.2), `null` before the first. */
  epoch: number | null;
  /** Instant of the last write-ahead, in epoch ms — the quiescence anchor (§10.4). */
  attemptStartedAtMs: number | null;
  ackPublication: ChatOpsAckPublication;
  ackAttempts: number;
  reconcileAttempts: number;
  /** Bounded, additive evidence (contract §10.5, §14). */
  evidence: readonly ChatOpsEvidenceRef[];
  /** True when more markers existed than {@link CHATOPS_MAX_EVIDENCE_REFS} retained. */
  evidenceTruncated: boolean;
  /** Exact counts, never truncated — §11.1's predicate depends on them. */
  evidenceClaims: number;
  evidenceAcks: number;
  /** Set exactly when `state` is `ambiguous` (contract §13.3). */
  handoff: ChatOpsLedgerHandoff | null;
  /** Bounded operator-facing detail (contract §14). */
  detail: string | null;
}

/** A fresh row for a newly claimed or refused comment (contract rows 1 and 2). */
function newRow(commentId: string, state: ChatOpsLedgerState): ChatOpsLedgerRow {
  return {
    commentId,
    state,
    outcome: null,
    attempts: 0,
    epoch: null,
    attemptStartedAtMs: null,
    // No dispatch has happened, so there is nothing to acknowledge yet; a
    // dispatch result (row 8) is what moves this to "pending".
    ackPublication: "not-required",
    ackAttempts: 0,
    reconcileAttempts: 0,
    evidence: [],
    evidenceTruncated: false,
    evidenceClaims: 0,
    evidenceAcks: 0,
    handoff: null,
    detail: null,
  };
}

/** Truncate an operator-facing detail string to its documented bound (contract §14). */
export function boundChatOpsDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  if (detail.length <= CHATOPS_LEDGER_DETAIL_MAX_CHARS) return detail;
  return `${detail.slice(0, CHATOPS_LEDGER_DETAIL_MAX_CHARS)}… (truncated)`;
}

// ---------------------------------------------------------------------------
// Events and transitions (contract §7)
// ---------------------------------------------------------------------------

/** Why a candidate is refused before ever dispatching (contract row 2). */
export type ChatOpsRefusalReason =
  | "recognition-refused"
  | "bootstrap-backlog"
  | "chatops-disabled"
  | "marker-comment";

/** The verdict a reconciliation pass reached for one row (contract §11, rows 9-13). */
export type ChatOpsReconcileVerdict =
  | { kind: "no-effect" }
  | { kind: "acked"; outcome: ChatOpsMarkerOutcome }
  | { kind: "claim-only" }
  | { kind: "inconclusive"; detail?: string };

/** Every event the ledger accepts (contract §7). Anything else is not expressible. */
export type ChatOpsLedgerEvent =
  | { kind: "claim" }
  | { kind: "refuse"; reason: ChatOpsRefusalReason; detail?: string }
  | { kind: "begin-dispatch"; epoch: number; nowMs: number }
  | { kind: "dispatch-result"; outcome: ChatOpsMarkerOutcome }
  | { kind: "reconciled"; verdict: ChatOpsReconcileVerdict }
  | { kind: "ack-published" }
  | { kind: "ack-publish-failed"; detail?: string }
  | { kind: "fence"; reason: ChatOpsLedgerHandoffReason; detail?: string }
  | { kind: "escalate"; reason: ChatOpsLedgerHandoffReason; detail?: string }
  | { kind: "operator-resolve"; outcome: ChatOpsMarkerOutcome; operator: string; detail?: string }
  /**
   * The sole sanctioned replay path (contract §13.2), so both halves of the
   * record it requires — *who* authorized it and *why* — are mandatory, not
   * optional. A retry nobody is named for is exactly the silent replay the
   * rest of this module refuses.
   */
  | { kind: "operator-retry"; operator: string; reason: string };

/** Why a transition was refused (contract §7 — a refusal is recorded, never ignored). */
export type ChatOpsLedgerRefusalReason =
  | "scope-fenced"
  | "terminal-row"
  | "illegal-transition"
  | "dispatch-in-flight"
  | "attempt-cap-reached"
  /** An operator transition arrived without the identity/reason it must record (§13.2). */
  | "operator-record-required"
  | "no-row";

export interface ChatOpsLedgerRefusal {
  reason: ChatOpsLedgerRefusalReason;
  detail: string;
}

/**
 * Row number reported when no contract §7 row applies at all — a caller
 * defect, such as an event that needs an existing row being sent without one.
 * Contract rows are numbered from 1, so 0 can never collide with one.
 */
export const CHATOPS_NO_CONTRACT_ROW = 0;

/**
 * The result of applying one event.
 *
 * `row` is the contract's numbered transition row (§7), present on both
 * outcomes: a refusal cites the row that refused it, so an operator asking
 * "why did nothing happen" gets an answer, not silence.
 */
export type ChatOpsLedgerTransition =
  | {
      applied: true;
      /** Contract §7 row number. */
      row: number;
      next: ChatOpsLedgerRow;
      /** Observability event name (contract §14). */
      event: string;
    }
  | {
      applied: false;
      row: number;
      refusal: ChatOpsLedgerRefusal;
      event: "chatops.ledger.refused";
    };

/** Context a transition needs but does not own (contract §7, §12). */
export interface ChatOpsLedgerContext {
  /** True when the fence scope is fenced (contract §12). Defaults to false. */
  fenced?: boolean;
}

function applied(
  row: number,
  next: ChatOpsLedgerRow,
  event: string,
): ChatOpsLedgerTransition {
  return { applied: true, row, next, event };
}

function refused(
  row: number,
  reason: ChatOpsLedgerRefusalReason,
  detail: string,
): ChatOpsLedgerTransition {
  return {
    applied: false,
    row,
    refusal: { reason, detail: boundChatOpsDetail(detail) ?? detail },
    event: "chatops.ledger.refused",
  };
}

/** A required operator field, trimmed — `null` when it carries no content. */
function nonblank(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Keep the derived record *and* the operator's own words (contract §14).
 *
 * The supplied detail is additional context, never a replacement for the
 * identity half — dropping the latter would leave the durable row unable to
 * name who made the decision.
 */
function composeOperatorDetail(record: string, supplied: string | undefined): string {
  const extra = nonblank(supplied);
  return extra === null ? record : `${record}: ${extra}`;
}

function toAmbiguous(
  current: ChatOpsLedgerRow,
  reason: ChatOpsLedgerHandoffReason,
  detail: string | undefined,
  fenceScope: boolean,
): ChatOpsLedgerRow {
  return {
    ...current,
    state: "ambiguous",
    handoff: { reason, detail: boundChatOpsDetail(detail ?? null), fenceScope },
    detail: boundChatOpsDetail(detail ?? current.detail),
  };
}

/**
 * Apply one event to one ledger row, per contract §7's transition table.
 *
 * `current` is `null` for a comment with no row yet. Every legal transition is
 * a numbered row of that table; everything else is refused with the row that
 * refused it. There is no default branch, no "assume it failed", and no path
 * from `dispatching` back into a fresh dispatch — that path is precisely the
 * silent replay the contract forbids.
 */
export function applyChatOpsLedgerEvent(
  current: ChatOpsLedgerRow | null,
  event: ChatOpsLedgerEvent,
  commentId: string,
  context: ChatOpsLedgerContext = {},
): ChatOpsLedgerTransition {
  const fenced = context.fenced === true;

  // --- No row yet: rows 1, 2, 3 -------------------------------------------
  if (!current) {
    if (event.kind === "claim") {
      // Row 3: a fenced scope writes no new claims — a claim is a promise to
      // dispatch, and a fenced scope may not.
      if (fenced) {
        return refused(3, "scope-fenced", `claim refused for comment ${commentId}: scope is fenced`);
      }
      return applied(1, newRow(commentId, "claimed"), "chatops.ledger.claimed");
    }
    if (event.kind === "refuse") {
      const row = newRow(commentId, "rejected");
      return applied(
        2,
        { ...row, detail: boundChatOpsDetail(event.detail ?? event.reason) },
        "chatops.ledger.rejected",
      );
    }
    return refused(
      CHATOPS_NO_CONTRACT_ROW,
      "no-row",
      `event ${event.kind} requires an existing ledger row for comment ${commentId}`,
    );
  }

  // --- Fully closed terminal rows: rows 5 and 23 ---------------------------
  if (CHATOPS_CLOSED_LEDGER_STATES.includes(current.state)) {
    const row = event.kind === "claim" ? 5 : 23;
    return refused(
      row,
      "terminal-row",
      `comment ${commentId} is ${current.state}; no event re-opens a terminal row`,
    );
  }

  // --- Fence: row 20 ------------------------------------------------------
  if (event.kind === "fence") {
    if (current.state === "ambiguous") {
      return refused(
        20,
        "illegal-transition",
        `comment ${commentId} is already ambiguous`,
      );
    }
    return applied(
      20,
      toAmbiguous(current, event.reason, event.detail, true),
      "chatops.ledger.fenced",
    );
  }

  switch (current.state) {
    // --- claimed: rows 4, 6, 7 --------------------------------------------
    case "claimed": {
      if (event.kind === "claim") {
        // Row 4: rediscovery after a restart is idempotent, never a second row.
        return applied(4, current, "chatops.ledger.claim-noop");
      }
      if (event.kind === "begin-dispatch") {
        if (fenced) {
          return refused(
            3,
            "scope-fenced",
            `dispatch refused for comment ${commentId}: scope is fenced`,
          );
        }
        return applied(6, beginDispatch(current, event.epoch, event.nowMs), "chatops.ledger.dispatching");
      }
      if (event.kind === "escalate") {
        return applied(
          7,
          toAmbiguous(current, event.reason, event.detail, false),
          "chatops.ledger.escalated",
        );
      }
      return refused(
        7,
        "illegal-transition",
        `event ${event.kind} is not legal from claimed (comment ${commentId})`,
      );
    }

    // --- dispatching: rows 8, 9, 10, 11, 12, 13, 14 ------------------------
    case "dispatching": {
      if (event.kind === "dispatch-result") {
        return applied(
          8,
          {
            ...current,
            state: "awaiting_ack",
            outcome: event.outcome,
            ackPublication: "pending",
            reconcileAttempts: 0,
          },
          "chatops.ledger.dispatch-result",
        );
      }
      if (event.kind === "begin-dispatch") {
        // Row 14: re-entering dispatch without a verdict is the silent replay
        // this contract exists to forbid.
        return refused(
          14,
          "dispatch-in-flight",
          `comment ${commentId} is already dispatching; reconcile before attempting again`,
        );
      }
      if (event.kind === "reconciled") {
        return reconcileDispatching(current, event.verdict, commentId);
      }
      if (event.kind === "escalate") {
        return applied(
          7,
          toAmbiguous(current, event.reason, event.detail, false),
          "chatops.ledger.escalated",
        );
      }
      return refused(
        14,
        "illegal-transition",
        `event ${event.kind} is not legal from dispatching (comment ${commentId})`,
      );
    }

    // --- awaiting_ack: rows 17, 18, 19 -------------------------------------
    case "awaiting_ack": {
      if (event.kind === "ack-published") {
        return applied(
          17,
          { ...current, state: "acknowledged", ackPublication: "published" },
          "chatops.ledger.acknowledged",
        );
      }
      if (event.kind === "ack-publish-failed") {
        const ackAttempts = current.ackAttempts + 1;
        if (ackAttempts < CHATOPS_MAX_ACK_PUBLICATION_ATTEMPTS) {
          // Row 18: the outcome is already durable locally; only its
          // publication is retried.
          return applied(
            18,
            { ...current, ackAttempts, detail: boundChatOpsDetail(event.detail ?? current.detail) },
            "chatops.ledger.ack-retry",
          );
        }
        // Row 19: terminal, and an operator handoff is raised anyway — a row
        // with no published ack is invisible to every future reconciliation.
        return applied(
          19,
          {
            ...current,
            state: "acknowledged",
            ackAttempts,
            ackPublication: "abandoned",
            handoff: {
              reason: "ack-publication-abandoned",
              detail: boundChatOpsDetail(event.detail ?? null),
              fenceScope: false,
            },
            detail: boundChatOpsDetail(event.detail ?? current.detail),
          },
          "chatops.ledger.ack-abandoned",
        );
      }
      if (event.kind === "escalate") {
        return applied(
          7,
          toAmbiguous(current, event.reason, event.detail, false),
          "chatops.ledger.escalated",
        );
      }
      return refused(
        19,
        "illegal-transition",
        `event ${event.kind} is not legal from awaiting_ack (comment ${commentId})`,
      );
    }

    // --- retry_scheduled: rows 15, 16 --------------------------------------
    case "retry_scheduled": {
      if (event.kind === "begin-dispatch") {
        if (fenced) {
          return refused(
            3,
            "scope-fenced",
            `retry refused for comment ${commentId}: scope is fenced`,
          );
        }
        if (current.attempts >= CHATOPS_MAX_DISPATCH_ATTEMPTS) {
          // Row 16: exhaustion is a definite negative outcome — the operation
          // provably never ran — so it is acknowledged, not left ambiguous.
          return applied(
            16,
            {
              ...current,
              state: "awaiting_ack",
              outcome: "error",
              ackPublication: "pending",
              detail: boundChatOpsDetail(
                `dispatch attempt cap (${CHATOPS_MAX_DISPATCH_ATTEMPTS}) reached; the operation never ran`,
              ),
            },
            "chatops.ledger.attempts-exhausted",
          );
        }
        return applied(15, beginDispatch(current, event.epoch, event.nowMs), "chatops.ledger.dispatching");
      }
      if (event.kind === "escalate") {
        return applied(
          7,
          toAmbiguous(current, event.reason, event.detail, false),
          "chatops.ledger.escalated",
        );
      }
      return refused(
        15,
        "illegal-transition",
        `event ${event.kind} is not legal from retry_scheduled (comment ${commentId})`,
      );
    }

    // --- ambiguous: rows 21, 22 -------------------------------------------
    case "ambiguous": {
      if (event.kind === "operator-resolve") {
        const operator = nonblank(event.operator);
        if (operator === null) {
          return refused(
            21,
            "operator-record-required",
            `comment ${commentId} cannot be resolved without a recorded operator identity`,
          );
        }
        // Row 21: the decision is definite, so it lands where every other
        // definite outcome lands — `awaiting_ack`, with a marker still owed.
        // Making it terminal here would strand `ackPublication` at "pending"
        // or "not-required" with no transition left that could ever publish
        // it, leaving a resolved command with no provider-visible evidence
        // for a later restore to reconcile against (§6, §11.4).
        return applied(
          21,
          {
            ...current,
            state: "awaiting_ack",
            outcome: event.outcome,
            // The operator authorizes a fresh publication budget: whatever
            // exhausted the previous one is not this decision's fault.
            ackPublication: "pending",
            ackAttempts: 0,
            handoff: null,
            detail: boundChatOpsDetail(
              composeOperatorDetail(
                `resolved by ${operator} as ${event.outcome}`,
                event.detail,
              ),
            ),
          },
          "chatops.ledger.operator-resolved",
        );
      }
      if (event.kind === "operator-retry") {
        // Row 22: the only path by which a command that *may* have executed is
        // ever dispatched again. Because it is the sole intentional replay
        // path, it is refused unless it durably records both who authorized it
        // and why (contract §13.2); neither half is inferable afterwards.
        const operator = nonblank(event.operator);
        const reason = nonblank(event.reason);
        if (operator === null || reason === null) {
          return refused(
            22,
            "operator-record-required",
            `comment ${commentId} cannot be retried without a recorded operator identity and reason`,
          );
        }
        // `attempts` is preserved so §11's evidence comparison stays honest
        // afterwards.
        return applied(
          22,
          {
            ...current,
            state: "retry_scheduled",
            handoff: null,
            reconcileAttempts: 0,
            detail: boundChatOpsDetail(`retry authorized by ${operator}: ${reason}`),
          },
          "chatops.ledger.operator-retry",
        );
      }
      return refused(
        21,
        "illegal-transition",
        `comment ${commentId} is ambiguous; only a recorded operator decision moves it`,
      );
    }

    default:
      return refused(
        CHATOPS_NO_CONTRACT_ROW,
        "illegal-transition",
        `unhandled ledger state for comment ${commentId}`,
      );
  }
}

/** T2's write-ahead (contract §8, §9.1): attempts and epoch move before the effect. */
function beginDispatch(current: ChatOpsLedgerRow, epoch: number, nowMs: number): ChatOpsLedgerRow {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`ChatOps ledger epoch must be a non-negative integer, got ${epoch}`);
  }
  if (!Number.isFinite(nowMs)) {
    throw new Error(`ChatOps ledger write-ahead needs a finite instant, got ${nowMs}`);
  }
  return {
    ...current,
    state: "dispatching",
    attempts: current.attempts + 1,
    epoch,
    attemptStartedAtMs: nowMs,
    reconcileAttempts: 0,
  };
}

/** Rows 9-13: the entire crash-recovery surface for a row caught mid-dispatch. */
function reconcileDispatching(
  current: ChatOpsLedgerRow,
  verdict: ChatOpsReconcileVerdict,
  commentId: string,
): ChatOpsLedgerTransition {
  switch (verdict.kind) {
    case "no-effect":
      // Row 9: the only automatic path into retry, and it requires positive
      // proof that the operation never began (contract §10.4).
      return applied(
        9,
        { ...current, state: "retry_scheduled", reconcileAttempts: 0 },
        "chatops.ledger.retry-scheduled",
      );
    case "acked":
      // Row 10: the world already carries both the effect and its record.
      return applied(
        10,
        {
          ...current,
          state: "acknowledged",
          outcome: verdict.outcome,
          ackPublication: "published",
        },
        "chatops.ledger.acknowledged",
      );
    case "claim-only":
      // Row 11: the operation may have run, partially or fully. Never retried.
      return applied(
        11,
        toAmbiguous(
          current,
          "dispatch-crash-unresolved",
          `comment ${commentId} has a claim marker but no acknowledgement; execution status is undecidable`,
          false,
        ),
        "chatops.ledger.escalated",
      );
    case "inconclusive": {
      const reconcileAttempts = current.reconcileAttempts + 1;
      if (reconcileAttempts < CHATOPS_MAX_RECONCILE_ATTEMPTS) {
        // Row 12: unchanged state; the scan is simply retried.
        return applied(
          12,
          { ...current, reconcileAttempts, detail: boundChatOpsDetail(verdict.detail ?? current.detail) },
          "chatops.ledger.reconcile-inconclusive",
        );
      }
      // Row 13: bounded, then surfaced. Reconciliation never loops forever.
      return applied(
        13,
        {
          ...toAmbiguous(current, "reconcile-inconclusive", verdict.detail, false),
          reconcileAttempts,
        },
        "chatops.ledger.escalated",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The epoch witness (contract §9.2)
// ---------------------------------------------------------------------------

/**
 * How the database's dispatch epoch compares to the witness mirrored outside
 * it (contract §9.2).
 *
 * The asymmetry is deliberate: the write order is database-then-witness, so a
 * crash in the gap can only produce `witness-behind`, which is safe to
 * self-heal, while the dangerous direction (`restore-detected`) has no benign
 * cause. The reverse write order would make every crash indistinguishable
 * from a restore and fence the session constantly — which would train
 * operators to clear fences reflexively.
 */
export type ChatOpsEpochVerdict =
  | "consistent"
  | "witness-behind"
  | "restore-detected"
  | "witness-missing";

export interface ChatOpsEpochAssessment {
  verdict: ChatOpsEpochVerdict;
  /** Whether every scope for this session must be fenced (contract §12). */
  fence: boolean;
  /** Whether the witness must be rolled forward to the database's value. */
  healWitness: boolean;
  /** Set when `fence` is true, for the handoff every fenced row carries. */
  handoffReason: ChatOpsLedgerHandoffReason | null;
  detail: string;
}

/**
 * Compare the database's dispatch epoch with the out-of-database witness
 * (contract §9.2).
 *
 * `witnessEpoch` is `null` when the witness file is absent — a fresh session,
 * a repointed `artifactRoot` (`docs/retention-backup-contract.md` §8), or a
 * retention sweep that should not have touched it. Absent-with-no-dispatches
 * is benign; absent after a dispatch is not, because the backstop against a
 * restore whose markers were deleted is exactly what has gone missing.
 */
export function assessChatOpsLedgerEpoch(
  dbEpoch: number,
  witnessEpoch: number | null,
): ChatOpsEpochAssessment {
  if (!Number.isInteger(dbEpoch) || dbEpoch < 0) {
    throw new Error(`ChatOps ledger db epoch must be a non-negative integer, got ${dbEpoch}`);
  }
  if (witnessEpoch !== null && (!Number.isInteger(witnessEpoch) || witnessEpoch < 0)) {
    throw new Error(
      `ChatOps ledger witness epoch must be a non-negative integer or null, got ${witnessEpoch}`,
    );
  }
  if (witnessEpoch === null) {
    if (dbEpoch === 0) {
      return {
        verdict: "consistent",
        fence: false,
        healWitness: true,
        handoffReason: null,
        detail: "no witness and no dispatch history: nothing to protect yet",
      };
    }
    return {
      verdict: "witness-missing",
      fence: true,
      healWitness: false,
      handoffReason: "witness-missing",
      detail: `witness absent while the ledger records ${dbEpoch} dispatch epoch(s); re-seed it deliberately before dispatching`,
    };
  }
  if (dbEpoch === witnessEpoch) {
    return {
      verdict: "consistent",
      fence: false,
      healWitness: false,
      handoffReason: null,
      detail: `epoch ${dbEpoch} agrees with the witness`,
    };
  }
  if (dbEpoch > witnessEpoch) {
    return {
      verdict: "witness-behind",
      fence: false,
      healWitness: true,
      handoffReason: null,
      detail: `witness at ${witnessEpoch} trails the ledger at ${dbEpoch}: a crash between the write-ahead and the mirror write, rolled forward`,
    };
  }
  return {
    verdict: "restore-detected",
    fence: true,
    healWitness: false,
    handoffReason: "restore-detected",
    detail: `ledger epoch ${dbEpoch} is below the witness at ${witnessEpoch}: the database has less dispatch history than the filesystem witnessed`,
  };
}

// ---------------------------------------------------------------------------
// Evidence collection (contract §10)
// ---------------------------------------------------------------------------

/** Why an authenticated marker failed payload or ordering validation (contract §10.1). */
export type ChatOpsEvidenceDefectReason =
  | "unknown-target"
  | "evidence-precedes-target"
  | "conflicting-outcome";

export interface ChatOpsEvidenceDefect {
  reason: ChatOpsEvidenceDefectReason;
  /** The marker comment, or `null` for a defect about a target as a whole. */
  markerCommentId: string | null;
  targetCommentId: string;
  detail: string;
}

/** What the collected evidence says about one target comment (contract §10). */
export interface ChatOpsTargetEvidence {
  targetCommentId: string;
  /** Exact count of authenticated, validated claim markers. */
  claims: number;
  /** Exact count of authenticated, validated ack markers. */
  acks: number;
  /** The single ack outcome, or `null` when there is none or they conflict. */
  outcome: ChatOpsMarkerOutcome | null;
  /** True when two ack markers named this target with different outcomes. */
  conflicting: boolean;
  /** Bounded refs (contract §14); counts above stay exact. */
  refs: readonly ChatOpsEvidenceRef[];
  refsTruncated: boolean;
}

/** Internal accumulator — the exported shape keeps `refs` readonly. */
type MutableTargetEvidence = Omit<ChatOpsTargetEvidence, "refs"> & { refs: ChatOpsEvidenceRef[] };

export interface ChatOpsExecutionEvidence {
  byTarget: ReadonlyMap<string, ChatOpsTargetEvidence>;
  /** Ids of the marker comments themselves, so a caller can exclude them from candidacy. */
  markerCommentIds: ReadonlySet<string>;
  defects: readonly ChatOpsEvidenceDefect[];
}

/** How a caller resolves a marker's target to something orderable (contract §10.1). */
export type ChatOpsEvidenceTargetResolver = (
  commentId: string,
) => { createdAt: string } | null;

/**
 * Build a target resolver from a window's comments plus an optional first-seen
 * lookup (contract §10.1).
 *
 * A reconciliation window is bounded below by the earliest open write-ahead
 * (§10.5), so a marker's target is frequently *below* the window — it is
 * resolved from the first-seen table instead. Keeping resolution injected is
 * what lets this module stay pure.
 */
export function chatOpsEvidenceTargetResolver(
  comments: readonly ChatOpsObservedComment[],
  firstSeen?: (commentId: string) => { createdAt: string } | null,
): ChatOpsEvidenceTargetResolver {
  const index = new Map<string, { createdAt: string }>();
  for (const comment of comments) index.set(comment.id, { createdAt: comment.createdAt });
  return (commentId) => index.get(commentId) ?? firstSeen?.(commentId) ?? null;
}

/**
 * Collect the authenticated markers in a set of comments as *evidence about
 * ledger rows* (contract §10.1).
 *
 * Authentication (#777 §7 — exact canonical body, automation author) is
 * necessary but not sufficient. A marker becomes evidence only when its
 * embedded id names a comment this scope knows and its own order key sorts
 * strictly above that target's: a marker cannot precede the comment it
 * acknowledges. Everything else is a defect, reported rather than silently
 * dropped.
 *
 * Unlike `indexAuthenticatedChatOpsMarkers` (#781 §5.1), which reports
 * existence, this reports **multiplicity** — contract §11.1 compares the claim
 * count against the row's `attempts`, and that comparison is the whole restore
 * detector, so collapsing it into a boolean would disarm it.
 *
 * A look-alike marker from a non-automation author is not collected at all, so
 * it can neither acknowledge a row nor fence a scope (§10.3). The second
 * property matters as much as the first: a fence an untrusted commenter could
 * trigger would be a denial of service.
 */
export function collectChatOpsExecutionEvidence(
  comments: readonly ChatOpsObservedComment[],
  automationLogins: readonly string[],
  resolveTarget: ChatOpsEvidenceTargetResolver,
): ChatOpsExecutionEvidence {
  const byTarget = new Map<string, MutableTargetEvidence>();
  const markerCommentIds = new Set<string>();
  const defects: ChatOpsEvidenceDefect[] = [];

  for (const comment of comments) {
    if (!isAuthenticatedChatOpsMarker(comment, automationLogins)) continue;
    const marker = parseChatOpsMarkerBody(comment.body);
    if (!marker) continue;
    markerCommentIds.add(comment.id);

    const target = resolveTarget(marker.commentId);
    if (!target) {
      defects.push({
        reason: "unknown-target",
        markerCommentId: comment.id,
        targetCommentId: marker.commentId,
        detail: `marker ${comment.id} names comment ${marker.commentId}, which this scope has no record of`,
      });
      continue;
    }

    const markerKey = deriveChatOpsCommentOrderKey(comment);
    const targetKey = {
      createdAtMs: parseChatOpsTimestamp(target.createdAt, "createdAt"),
      commentId: marker.commentId,
    };
    if (compareChatOpsCommentOrderKeys(markerKey, targetKey) <= 0) {
      defects.push({
        reason: "evidence-precedes-target",
        markerCommentId: comment.id,
        targetCommentId: marker.commentId,
        detail: `marker ${comment.id} does not sort above its target ${marker.commentId}`,
      });
      continue;
    }

    const entry: MutableTargetEvidence = byTarget.get(marker.commentId) ?? {
      targetCommentId: marker.commentId,
      claims: 0,
      acks: 0,
      outcome: null,
      conflicting: false,
      refs: [],
      refsTruncated: false,
    };
    const refs = entry.refs;
    const ref: ChatOpsEvidenceRef = {
      markerCommentId: comment.id,
      kind: marker.kind === "claimed" ? "claimed" : "ack",
      outcome: marker.kind === "ack" ? marker.outcome : null,
      createdAt: comment.createdAt,
    };
    if (refs.length < CHATOPS_MAX_EVIDENCE_REFS) refs.push(ref);
    else entry.refsTruncated = true;

    if (marker.kind === "claimed") {
      entry.claims += 1;
    } else {
      entry.acks += 1;
      if (entry.outcome === null && !entry.conflicting) entry.outcome = marker.outcome;
      else if (entry.outcome !== marker.outcome) {
        // Never resolved by preferring one: both markers are authentic, and
        // the conflict means something upstream went wrong (contract §10.2).
        entry.conflicting = true;
        entry.outcome = null;
        defects.push({
          reason: "conflicting-outcome",
          markerCommentId: comment.id,
          targetCommentId: marker.commentId,
          detail: `comment ${marker.commentId} carries acknowledgement markers with differing outcomes`,
        });
      }
    }
    byTarget.set(marker.commentId, entry);
  }

  return { byTarget, markerCommentIds, defects };
}

/**
 * Merge freshly collected evidence into a row's persisted evidence
 * (contract §10.5).
 *
 * Additive by construction: counts only ever rise. A marker deleted between
 * two passes must not lower a count, or deletion would become a way to
 * un-fence a scope.
 */
export function mergeChatOpsEvidence(
  row: ChatOpsLedgerRow,
  observed: ChatOpsTargetEvidence | undefined,
): ChatOpsLedgerRow {
  if (!observed) return row;
  const seen = new Set(row.evidence.map((ref) => ref.markerCommentId));
  const refs = [...row.evidence];
  let truncated = row.evidenceTruncated || observed.refsTruncated;
  for (const ref of observed.refs) {
    if (seen.has(ref.markerCommentId)) continue;
    if (refs.length >= CHATOPS_MAX_EVIDENCE_REFS) {
      truncated = true;
      continue;
    }
    refs.push(ref);
    seen.add(ref.markerCommentId);
  }
  return {
    ...row,
    evidence: refs,
    evidenceTruncated: truncated,
    evidenceClaims: Math.max(row.evidenceClaims, observed.claims),
    evidenceAcks: Math.max(row.evidenceAcks, observed.acks),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation (contract §11)
// ---------------------------------------------------------------------------

/**
 * The `since` bound a reconciliation pass must scan from (contract §10.5).
 *
 * One second below the earliest write-ahead among the scope's non-terminal
 * rows — the same margin, for the same second-precision reason, that #781
 * §6.1 gives for the cursor's own bound. A discovery window starts above the
 * cursor and would therefore miss markers that have since fallen below it,
 * and absence is exactly what row 9 reads as proof.
 *
 * Returns the cursor's own bound (via `cursorBound`) when no row is open,
 * because a scope with no open attempt has nothing to widen the scan for.
 */
export function chatOpsReconciliationSinceBound(
  rows: readonly ChatOpsLedgerRow[],
  cursorBound: string | null,
  marginMs: number = CHATOPS_SCAN_SINCE_MARGIN_MS,
): string | null {
  if (!Number.isInteger(marginMs) || marginMs < 0) {
    throw new Error(`ChatOps reconciliation margin must be a non-negative integer, got ${marginMs}`);
  }
  let earliest: number | null = null;
  for (const row of rows) {
    if (CHATOPS_TERMINAL_LEDGER_STATES.includes(row.state)) continue;
    if (row.attemptStartedAtMs === null) continue;
    if (earliest === null || row.attemptStartedAtMs < earliest) earliest = row.attemptStartedAtMs;
  }
  if (earliest === null) return cursorBound;
  const floored = Math.floor((earliest - marginMs) / 1000) * 1000;
  return new Date(Math.max(0, floored)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Per-comment reconciliation outcome (contract §11). */
export interface ChatOpsRowReconciliation {
  commentId: string;
  /** True when the world records more execution than this row does (§11.1). */
  regressed: boolean;
  /** The verdict to feed `applyChatOpsLedgerEvent`, for a `dispatching` row. */
  verdict: ChatOpsReconcileVerdict;
  /** The row with freshly observed evidence merged in (§10.5). */
  row: ChatOpsLedgerRow;
}

/** The scope-level result of one reconciliation pass (contract §11). */
export interface ChatOpsScopeReconciliation {
  /** True when the fence scope must be fenced (contract §12). */
  fence: boolean;
  fenceReason: ChatOpsLedgerHandoffReason | null;
  /** Bounded, operator-facing explanation of the fence. */
  fenceDetail: string | null;
  rows: readonly ChatOpsRowReconciliation[];
  /** Evidence naming comments with no ledger row at all (contract row 24). */
  orphanEvidence: readonly string[];
}

export interface ChatOpsScopeReconciliationInput {
  rows: readonly ChatOpsLedgerRow[];
  evidence: ChatOpsExecutionEvidence;
  /**
   * Whether the scan that produced `evidence` proved a complete window
   * (#781 §5). An incomplete window proves nothing about absence, so every
   * open row's verdict is `inconclusive` (contract §11.3).
   */
  windowComplete: boolean;
  /** Injected clock, for the quiescence delay (contract §10.4). */
  nowMs: number;
  /**
   * Raise-only override of the quiescence delay; defaults to
   * {@link CHATOPS_EVIDENCE_QUIESCENCE_MS}.
   *
   * A *lower* value is not a tuning knob, it is a correctness hole: it lets a
   * `no-effect` verdict be reached before a just-posted claim marker could
   * become visible, and that verdict authorizes a second execution. Values
   * below the constant — or non-finite ones — are rejected, not clamped, so a
   * caller that meant to loosen the guard learns it cannot.
   */
  quiescenceMs?: number;
}

/**
 * Resolve the quiescence delay a reconciliation pass must honor (§10.4).
 *
 * @throws when the override is non-finite or below
 * {@link CHATOPS_EVIDENCE_QUIESCENCE_MS}.
 */
function resolveQuiescenceMs(override: number | undefined): number {
  if (override === undefined) return CHATOPS_EVIDENCE_QUIESCENCE_MS;
  if (!Number.isFinite(override) || override < CHATOPS_EVIDENCE_QUIESCENCE_MS) {
    throw new Error(
      `ChatOps quiescence delay may only be raised above ${CHATOPS_EVIDENCE_QUIESCENCE_MS}ms, got ${override}`,
    );
  }
  return override;
}

/**
 * Reconcile one fence scope's ledger rows against the evidence a scan
 * produced (contract §11).
 *
 * This runs **before any dispatch in the scope** and is the only place a
 * restore is detected from provider evidence. It decides nothing about rows
 * beyond producing the verdict `applyChatOpsLedgerEvent` will consume — the
 * transition table (§7) stays the single place state changes.
 *
 * Regression fences the *entire* scope, not just the row that tripped it: a
 * restore does not roll back one row, it rolls back everything committed after
 * the backup, so the one comment whose markers happened to survive is a
 * sample, not the extent of the damage.
 */
export function reconcileChatOpsLedgerScope(
  input: ChatOpsScopeReconciliationInput,
): ChatOpsScopeReconciliation {
  const quiescenceMs = resolveQuiescenceMs(input.quiescenceMs);
  if (!Number.isFinite(input.nowMs)) {
    throw new Error(`ChatOps reconciliation needs a finite instant, got ${input.nowMs}`);
  }
  const known = new Set(input.rows.map((row) => row.commentId));
  const rows: ChatOpsRowReconciliation[] = [];
  let fenceReason: ChatOpsLedgerHandoffReason | null = null;
  let fenceDetail: string | null = null;

  for (const row of input.rows) {
    const observed = input.evidence.byTarget.get(row.commentId);
    const merged = mergeChatOpsEvidence(row, observed);
    const claims = merged.evidenceClaims;
    const acks = merged.evidenceAcks;

    // §11.1 — one-directional: the ledger being *ahead* of the world is safe
    // (a failed marker post, or a marker deleted after the fact); the world
    // being ahead of the ledger is not.
    const regressed = claims > merged.attempts || (acks > 0 && merged.attempts === 0);
    if (regressed && !fenceReason) {
      fenceReason = "ledger-regression";
      fenceDetail = boundChatOpsDetail(
        `comment ${row.commentId}: ${claims} claim marker(s) and ${acks} acknowledgement marker(s) against ${merged.attempts} recorded attempt(s)`,
      );
    }

    rows.push({
      commentId: row.commentId,
      regressed,
      verdict: verdictFor(merged, observed, input, quiescenceMs),
      row: merged,
    });
  }

  // Row 24 — evidence naming a comment the ledger has never heard of.
  const orphanEvidence: string[] = [];
  for (const targetId of input.evidence.byTarget.keys()) {
    if (known.has(targetId)) continue;
    orphanEvidence.push(targetId);
    if (!fenceReason) {
      fenceReason = "ledger-regression";
      fenceDetail = boundChatOpsDetail(
        `comment ${targetId} carries execution evidence but has no ledger row`,
      );
    }
  }

  return {
    fence: fenceReason !== null,
    fenceReason,
    fenceDetail,
    rows,
    orphanEvidence,
  };
}

/**
 * The ack outcome a row's persisted refs agree on (contract §10.5).
 *
 * Persisted evidence answers when this pass saw nothing — a marker deleted
 * between two passes must not read as "the attempt never happened". `null`
 * when the refs disagree or carry no ack.
 */
function persistedAckOutcome(row: ChatOpsLedgerRow): ChatOpsMarkerOutcome | null {
  let outcome: ChatOpsMarkerOutcome | null = null;
  for (const ref of row.evidence) {
    if (ref.kind !== "ack" || ref.outcome === null) continue;
    if (outcome === null) outcome = ref.outcome;
    else if (outcome !== ref.outcome) return null;
  }
  return outcome;
}

/** Which of rows 9-13 the evidence supports for one row (contract §11, §10.4). */
function verdictFor(
  row: ChatOpsLedgerRow,
  observed: ChatOpsTargetEvidence | undefined,
  input: ChatOpsScopeReconciliationInput,
  quiescenceMs: number,
): ChatOpsReconcileVerdict {
  if (!input.windowComplete) {
    return {
      kind: "inconclusive",
      detail: "scan window incomplete: absence of a marker proves nothing",
    };
  }
  if (observed?.conflicting) {
    return {
      kind: "inconclusive",
      detail: "acknowledgement markers disagree about the outcome",
    };
  }
  // `row` here is the merged row (§10.5), so these counts are the monotonic
  // ones: what this pass saw, or what an earlier pass persisted, whichever is
  // larger. A deleted marker therefore lowers nothing.
  if (row.evidenceAcks > 0) {
    const outcome = observed?.outcome ?? persistedAckOutcome(row);
    if (outcome !== null) return { kind: "acked", outcome };
    return {
      kind: "inconclusive",
      detail: "an acknowledgement marker is recorded but its outcome is not recoverable",
    };
  }
  if (row.evidenceClaims > 0) {
    return { kind: "claim-only" };
  }
  // Absence is proof only after quiescence (contract §10.4).
  const startedAt = row.attemptStartedAtMs;
  if (startedAt === null) {
    return { kind: "inconclusive", detail: "no write-ahead recorded for this row" };
  }
  if (input.nowMs - startedAt < quiescenceMs) {
    return {
      kind: "inconclusive",
      detail: `quiescence delay of ${quiescenceMs}ms has not elapsed since the write-ahead`,
    };
  }
  return { kind: "no-effect" };
}

// ---------------------------------------------------------------------------
// Login separation (contract §10.3)
// ---------------------------------------------------------------------------

/**
 * Verify that command authors and automation identities are disjoint
 * (contract §10.3).
 *
 * #777 §5 keeps the two lists separate in *meaning* but does not forbid
 * overlap. Once markers become evidence that can mark a row terminal and fence
 * a scope, an overlapping login would let a human command author post markers
 * that authenticate — a forgery path this layer would otherwise open. This
 * changes no recognition behavior; it only closes that path.
 *
 * Comparison is case-insensitive, matching how #777 compares logins.
 *
 * @returns the offending logins, empty when the lists are disjoint.
 */
export function validateChatOpsLoginSeparation(
  authorAllowlist: readonly string[],
  automationLogins: readonly string[],
): readonly string[] {
  const automation = new Set(automationLogins.map((login) => login.trim().toLowerCase()));
  const overlap: string[] = [];
  for (const login of authorAllowlist) {
    const normalized = login.trim().toLowerCase();
    if (automation.has(normalized) && !overlap.includes(normalized)) overlap.push(normalized);
  }
  return overlap;
}
