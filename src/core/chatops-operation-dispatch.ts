/**
 * The ChatOps binding of the callable operation-dispatch port (issue #783).
 *
 * `src/core/operation-port.ts` is adapter-agnostic on purpose — the same
 * operation backs the admin CLI, `admin ui`, a future GitHub App, and this
 * surface. This module is the thin, pure seam that joins it to the execution
 * ledger (#782): it builds the *trusted* execution context for one dispatch
 * attempt out of ledger-scope facts, and it decides which ledger event, if
 * any, an {@link OperationResult} justifies.
 *
 * It contains no policy about which verbs exist, which parameters a comment
 * may set, or how an outcome is published — those are issues #784, #785, and
 * #697. See `docs/operation-dispatch-port-contract.md` §9 for the mapping
 * table this module implements and the argument for each row.
 *
 * Everything here is pure: no I/O, no clock, no store access.
 */

import type { ChatOpsLedgerEvent } from "./chatops-execution-ledger.js";
import { chatOpsLedgerKey } from "./chatops-identity.js";
import type { ChatOpsProviderIdentity } from "./chatops-identity.js";
import type { OperationContext, OperationResult } from "./operation-port.js";

/**
 * One dispatch attempt, described entirely by facts the adapter already holds
 * durably: the ledger scope (#780 §6), the first-seen record's author (#781
 * §9), and the write-ahead the ledger just committed (#782 §8, T2).
 *
 * Nothing here is read from the comment body. That is the point: the body
 * produced a verb and a token list (#777 §2), and neither of those may
 * influence *who* is asking or *what* they are allowed to touch.
 */
export interface ChatOpsDispatchAttempt {
  identity: ChatOpsProviderIdentity;
  issueNumber: number;
  commentId: string;
  /**
   * The allowlisted comment author, from the immutable first-seen record —
   * never re-read from a possibly-edited comment.
   */
  authorLogin: string;
  /**
   * `ChatOpsLedgerRow.attempts` *after* the write-ahead that opened this
   * attempt, so the first attempt is 1.
   */
  attempt: number;
  /**
   * Whether this invocation may apply changes. Which commands are ever
   * dispatched confirmed is grant/tier policy (#697) and mapping policy
   * (#784), not this module's decision — so it is an input, never a default.
   */
  confirmed: boolean;
  /** Advisory budget for the invocation, or `null`. */
  deadlineMs?: number | null;
}

/**
 * Check the attempt's own fields, throwing on a defect (contract §9.1).
 *
 * Deliberately a throw rather than a typed result: these fields come from the
 * adapter's durable rows, not from a user, so a bad one is a corrupt ledger
 * row — and nothing external has happened yet that a result would need to
 * describe.
 */
function assertAttempt(attempt: ChatOpsDispatchAttempt): void {
  if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1) {
    throw new Error(
      `chatops dispatch attempt must be a positive integer, got ${JSON.stringify(attempt.attempt)}`,
    );
  }
  if (typeof attempt.authorLogin !== "string" || attempt.authorLogin.trim().length === 0) {
    throw new Error("chatops dispatch attempt requires the first-seen author login");
  }
}

/**
 * The audit/idempotency handle for one attempt: the ledger scope plus the
 * attempt number.
 *
 * Stable for the life of an attempt and never reused by another one — the
 * ledger refuses re-entering `dispatching` without a verdict (#782 row 14), so
 * a given `(scope, attempt)` pair is invoked at most once, which is exactly
 * the property an operation needs if it wants to deduplicate on it.
 */
export function chatOpsOperationRequestId(attempt: ChatOpsDispatchAttempt): string {
  assertAttempt(attempt);
  return `${chatOpsLedgerKey(attempt.identity, attempt.issueNumber, attempt.commentId)}#${attempt.attempt}`;
}

/**
 * Build the trusted execution context for one attempt.
 *
 * `issueNumber` comes from the issue the comment lives on, unconditionally —
 * the grammar deliberately gives a comment no token shape for retargeting
 * another issue (#777 §2), and this is where that promise is kept.
 */
export function chatOpsOperationContext(attempt: ChatOpsDispatchAttempt): OperationContext {
  assertAttempt(attempt);
  return {
    surface: "chatops",
    actor: { kind: "human", id: attempt.authorLogin.trim() },
    sessionId: attempt.identity.sessionId,
    issueNumber: attempt.issueNumber,
    requestId: chatOpsOperationRequestId(attempt),
    confirmed: attempt.confirmed,
    deadlineMs: attempt.deadlineMs ?? null,
  };
}

/**
 * What the ledger should be told about a completed invocation.
 *
 * `reconcile` is not "nothing happened": it means the result is not definite
 * enough to record, so the row stays `dispatching` and #782 §11's
 * reconciliation — which can read the provider's own markers — decides.
 */
export type ChatOpsDispatchDisposition =
  | { kind: "record"; event: ChatOpsLedgerEvent; detail: string }
  | { kind: "reconcile"; detail: string };

/**
 * Map an operation result onto the ledger event it justifies
 * (`docs/operation-dispatch-port-contract.md` §9).
 *
 * The three shapes and why each lands where it does:
 *
 * - `executed` / `rejected` are definite outcomes with a definite verdict, so
 *   they take row 8's `dispatch-result` and become the acknowledged outcome.
 *   Ledger `rejected` (an operation that refused) is not the same as ledger
 *   state `rejected` (a comment that never dispatched) — the marker outcome is
 *   what row 8 records.
 * - `failed` with `effect: "none"` is *also* definite: the operation proved it
 *   changed nothing. A transient reason takes row 9's `reconciled{no-effect}`
 *   so the ledger's own bounded retry (#782 §13.1, capped by `attempts`) can
 *   run; an internal defect is not retried, because re-running code that just
 *   failed deterministically only spends the cap.
 * - `failed` with `effect: "unknown"` records nothing at all. This is the
 *   whole reason {@link OperationResult} carries an effect: the alternative —
 *   guessing "it probably failed" and retrying — is the double execution this
 *   chain exists to prevent.
 */
export function chatOpsDispatchDisposition(result: OperationResult): ChatOpsDispatchDisposition {
  if (result.status === "executed") {
    return {
      kind: "record",
      event: { kind: "dispatch-result", outcome: "executed" },
      detail: result.summary,
    };
  }
  if (result.status === "rejected") {
    return {
      kind: "record",
      event: { kind: "dispatch-result", outcome: "rejected" },
      detail: `${result.reason}: ${result.summary}`,
    };
  }
  if (result.effect === "unknown") {
    return {
      kind: "reconcile",
      detail: `${result.reason}: ${result.summary}`,
    };
  }
  if (result.reason === "internal") {
    return {
      kind: "record",
      event: { kind: "dispatch-result", outcome: "error" },
      detail: `${result.reason}: ${result.summary}`,
    };
  }
  return {
    kind: "record",
    event: { kind: "reconciled", verdict: { kind: "no-effect" } },
    detail: `${result.reason}: ${result.summary}`,
  };
}
