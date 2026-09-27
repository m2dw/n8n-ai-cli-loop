/**
 * ChatOps result kinds, public outcomes, and acknowledgement rendering
 * (issue #785, `docs/chatops-result-contract.md`).
 *
 * This module is the *presentation* layer of the ChatOps chain: given a
 * disposition the execution ledger (#782) has reached — or a refusal that
 * happened before any ledger row existed — decide which of the five
 * `ChatOpsResultKind` values describes it, which closed `reason` code it
 * carries, and what bounded, sanitized text a requester may be shown.
 *
 * Everything here is pure: no I/O, no clock, no store access, no provider
 * call. Rendering a comment body is a string transformation; *posting* it is
 * the runtime's job (`src/handlers/chatops-pass.ts`).
 *
 * Two structural rules the contract turns on, both enforced here rather than
 * left to a caller's discipline:
 *
 * - **A marker comment carries the canonical body and nothing else** (§5.1).
 *   `chatOpsMarkerBody` is the only place a marker string is built, and the
 *   summary is a *separate* comment whose leading line is the pinned,
 *   grammar-ineligible {@link CHATOPS_SUMMARY_HEADER}. A body that merely
 *   contains a marker fails #777 §7's exact-match authentication and could
 *   never become reconciliation evidence, so the two must never be merged.
 * - **`dispatched` is read off the row, never inferred from the kind** (§4.3).
 *   Five handoff reasons and every row-21 resolution occur at both values, so
 *   every constructor here takes `attempts` (or an explicit `dispatched`)
 *   rather than deriving it from the disposition.
 */

import type { ChatOpsMarkerOutcome } from "./chatops-command.js";
import type { ChatOpsLedgerHandoffReason, ChatOpsLedgerRow } from "./chatops-execution-ledger.js";
import {
  escapeRawHtml,
  neutralizeClosingKeywords,
  redactApiKeys,
  redactTokens,
  sanitizeBody,
} from "./text-sanitize.js";
import { enforceCommentVisibility } from "./outbox-visibility.js";
import { OPERATION_SUMMARY_MAX_CHARS } from "./operation-port.js";
import type { OperationResult } from "./operation-port.js";

// ---------------------------------------------------------------------------
// §3 The result kind
// ---------------------------------------------------------------------------

/** The five terminal-for-automation dispositions a ChatOps command can reach (§3). */
export type ChatOpsResultKind =
  | "success"
  | "rejection"
  | "retryable-failure"
  | "ambiguous-execution"
  | "human-handoff";

/** The closed five-member set as a value, for validation and docs pinning. */
export const CHATOPS_RESULT_KINDS: readonly ChatOpsResultKind[] = Object.freeze([
  "success",
  "rejection",
  "retryable-failure",
  "ambiguous-execution",
  "human-handoff",
]);

/**
 * The nine reasons a command is refused before any dispatch is attempted
 * (§4.1). All nine land in ledger state `rejected`; the ledger's own coarser
 * `ChatOpsRefusalReason` cannot tell six of them apart, which is why the audit
 * record (§9.1) — not the row — is their durable carrier.
 */
export const CHATOPS_UNDISPATCHED_REASONS = Object.freeze([
  "unauthorized-author",
  "malformed",
  "ambiguous-edit",
  "unsupported-command",
  "unsupported-operation",
  "invalid-argument",
  "bootstrap-backlog",
  "chatops-disabled",
  "marker-comment",
] as const);

export type ChatOpsUndispatchedReason = (typeof CHATOPS_UNDISPATCHED_REASONS)[number];

/**
 * Handoff reasons whose `ambiguous` disposition means *execution status is
 * undecidable* (§2, §4.2) rather than *the disposition is known but
 * unpublished*.
 */
const EXECUTION_UNCERTAIN_HANDOFF_REASONS: readonly ChatOpsLedgerHandoffReason[] = Object.freeze([
  "dispatch-crash-unresolved",
  "reconcile-inconclusive",
  "conflicting-evidence",
  "ledger-regression",
  "restore-detected",
  "witness-missing",
]);

/**
 * The three reasons that are reachable only through ledger rows 9, 11, and 13,
 * each of which requires a prior `begin-dispatch` — so `attempts >= 1` always
 * holds and `dispatched` needs no branch (§4.2).
 */
const ALWAYS_DISPATCHED_HANDOFF_REASONS: readonly ChatOpsLedgerHandoffReason[] = Object.freeze([
  "dispatch-crash-unresolved",
  "reconcile-inconclusive",
  "conflicting-evidence",
]);

// ---------------------------------------------------------------------------
// §5.1, §7.1 Pinned, grammar-ineligible headers
// ---------------------------------------------------------------------------

/**
 * The summary comment's leading line (§5.1), pinned by exact value.
 *
 * `docs/chatops-command-grammar-contract.md` §2 requires a candidate line to
 * begin with `/`; this literal does not, so no choice of supported verbs and no
 * `OperationResult.summary` — untrusted prose that may itself begin with
 * `/grant` — can ever make the summary comment recognizable as a command. The
 * guarantee is structural, not incidental, which is why the exact string lives
 * here and is pinned by a docs test rather than left to a caller.
 */
export const CHATOPS_SUMMARY_HEADER = "ChatOps automated comment — not a command";

/** The handoff correction comment's leading line (§7.1), pinned for the identical reason. */
export const CHATOPS_HANDOFF_CORRECTION_HEADER = "ChatOps automated correction — not a command";

// ---------------------------------------------------------------------------
// §7 The public outcome
// ---------------------------------------------------------------------------

/** The bounded, sanitized projection a requester is ever shown (§7). */
export interface ChatOpsPublicOutcome {
  kind: ChatOpsResultKind;
  /** Whether a port attempt began — never whether a handler executed (§4.3). */
  dispatched: boolean;
  /** Drawn from the closed domain its `(kind, dispatched)` pair selects (§7.2). */
  reason: string | null;
  /** Bounded and sanitized (§6); never a comment echo, never `OperationResult.data`. */
  summary: string;
}

/** The durable audit record that carries the closed `reason` across a restart (§9, §9.1). */
export interface ChatOpsAuditRecord {
  /** #783 §9.1's per-invocation id; `null` whenever `dispatched` is false. */
  requestId: string | null;
  surface: "chatops";
  actorId: string;
  /** `null` for any of §4.1's nine undispatched reasons; known once mapping succeeded. */
  operationId: string | null;
  ledgerScope: {
    /** `chatOpsIdentityKey(identity)` — the opaque scope key, never a session alias. */
    identity: string;
    issueNumber: number;
    commentId: string;
  };
  /** The applied contract §7 row, or `CHATOPS_NO_CONTRACT_ROW` (0) pre-ledger. */
  row: number;
  kind: ChatOpsResultKind;
  dispatched: boolean;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// §6 Visibility and redaction
// ---------------------------------------------------------------------------

/**
 * Apply §6's pipeline to one string headed for a public outcome's `summary`.
 *
 * Order is fixed by the contract: path stripping, credential redaction,
 * closing-keyword neutralization, raw-HTML escaping, then the bound. The bound
 * is `OPERATION_SUMMARY_MAX_CHARS` rather than `DEFAULT_COMMENT_MAX_CHARS`
 * because every source this pipeline sees is already an operation summary or a
 * fixed template of comparable size — bounding twice is defense in depth, not
 * a second policy.
 *
 * `configuredPaths` is **mandatory in practice**: `sanitizeBody`'s built-in
 * heuristics only recognize a fixed set of path prefixes, so a deployment whose
 * `repoRoot`/`artifactRoot` lives under a non-standard top-level directory is
 * invisible to them. Callers pass `sessionRedactionPaths(session)`; §6 calls a
 * render that omits it a contract violation, not a permissible default.
 */
export function sanitizeChatOpsPublicText(text: string, configuredPaths: readonly string[]): string {
  const paths = [...configuredPaths];
  let out = sanitizeBody(text, paths);
  out = redactTokens(out);
  out = redactApiKeys(out);
  out = neutralizeClosingKeywords(out);
  out = escapeRawHtml(out);
  return enforceCommentVisibility("work-item", out, {
    configuredPaths: paths,
    maxChars: OPERATION_SUMMARY_MAX_CHARS,
  });
}

// ---------------------------------------------------------------------------
// §7.1 Fixed templates
// ---------------------------------------------------------------------------

/**
 * The per-reason template for every §4.1 undispatched refusal, and for a
 * zero-attempt `human-handoff` that never left `ambiguous` (§7.1).
 *
 * Each names only the reason. None quotes the comment body: echoing untrusted
 * text back into the thread is exactly what §6 exists to prevent, and a
 * recognition refusal carries no free-form detail to quote in the first place
 * (#777 §4 defines none).
 */
const UNDISPATCHED_TEMPLATES: Readonly<Record<ChatOpsUndispatchedReason, string>> = Object.freeze({
  "unauthorized-author": "This command was not run: its author is not on this session's ChatOps allowlist.",
  malformed: "This command was not run: it did not match the ChatOps command grammar.",
  "ambiguous-edit":
    "This command was not run: the comment was edited after it was posted, so which version was intended is ambiguous.",
  "unsupported-command": "This command was not run: its verb is not a supported ChatOps command.",
  "unsupported-operation": "This command was not run: its verb maps to no supported operation.",
  "invalid-argument": "This command was not run: its arguments did not satisfy the command's parameter policy.",
  "bootstrap-backlog":
    "This command was not run: it predates ChatOps being enabled for this work item, and pre-existing commands are never replayed.",
  "chatops-disabled": "This command was not run: ChatOps is not enabled for this session.",
  "marker-comment": "This comment is an automated ChatOps marker, not a command.",
});

/** The per-reason handoff template for a dispatched row that never produced an `OperationResult` (§7.1). */
const HANDOFF_TEMPLATES: Readonly<Record<ChatOpsLedgerHandoffReason, string>> = Object.freeze({
  "dispatch-crash-unresolved":
    "This command was dispatched but its execution status could not be determined; an operator must decide what happened.",
  "reconcile-inconclusive":
    "This command was dispatched and repeated reconciliation could not determine its outcome; an operator must decide what happened.",
  "ledger-regression":
    "This command's execution record disagrees with what the work item shows; automation is fenced until an operator resolves it.",
  "restore-detected":
    "This session's execution history was restored from an earlier state; automation is fenced until an operator resolves it.",
  "witness-missing":
    "This session's dispatch witness is missing, so a restore cannot be ruled out; automation is fenced until an operator resolves it.",
  "conflicting-evidence":
    "This command carries acknowledgement markers that disagree about its outcome; an operator must decide what happened.",
  "ack-publication-abandoned":
    "This command's outcome is known locally but its acknowledgement marker could not be published; an operator must record it.",
  "operator-escalation": "An operator escalated this command; its disposition is settled outside automation.",
});

/** Row 10's fixed sentence (§7.1) — reconciliation adopted a marker already on the provider. */
export const CHATOPS_RECONCILED_FROM_MARKER_SUMMARY =
  "This command's outcome was recovered from a provider-visible marker after an interruption; no operation result was ever retained locally.";

/** Row 16's fixed sentence (§7.1) — the automatic retry budget ran out before the operation ever started. */
export const CHATOPS_RETRY_BUDGET_EXHAUSTED_SUMMARY =
  "Automatic retries exhausted before this command's operation is known to have run; no operation result was ever produced.";

/** Row 21's fixed sentence (§7.1) — an operator recorded the outcome directly. */
export const CHATOPS_OPERATOR_RESOLVED_SUMMARY =
  "An operator resolved this command's outcome directly; no operation result was produced.";

// ---------------------------------------------------------------------------
// §4 The total mapping
// ---------------------------------------------------------------------------

/** Which kind a three-valued marker outcome selects for an `acknowledged` row (§4.2). */
function kindForOutcome(outcome: ChatOpsMarkerOutcome): ChatOpsResultKind {
  if (outcome === "executed") return "success";
  if (outcome === "rejected") return "rejection";
  return "retryable-failure";
}

/** The `(kind, dispatched)` pair a terminal-for-automation ledger row projects onto (§4.2). */
export interface ChatOpsLedgerDisposition {
  kind: ChatOpsResultKind;
  dispatched: boolean;
  /** The handoff reason an `ambiguous`/abandoned row cites, or `null`. */
  handoffReason: ChatOpsLedgerHandoffReason | null;
}

/**
 * Project one ledger row onto §4.2's table, or `null` when the row has not yet
 * reached a terminal-for-automation disposition (`claimed`, `dispatching`,
 * `retry_scheduled`, or `awaiting_ack` — still mid-flight).
 *
 * `dispatched` is read off `attempts` for every row, never inferred from the
 * state or the handoff reason: row 21 can resolve a row that never left
 * `claimed`, and five of the eight handoff reasons occur at both values (§4.3,
 * invariant 9).
 */
export function chatOpsLedgerDisposition(row: ChatOpsLedgerRow): ChatOpsLedgerDisposition | null {
  const dispatched = row.attempts >= 1;
  if (row.state === "acknowledged") {
    if (row.ackPublication === "abandoned") {
      return { kind: "human-handoff", dispatched, handoffReason: "ack-publication-abandoned" };
    }
    // A row whose outcome is somehow absent is not projectable; the caller
    // treats that as a defect rather than inventing a disposition for it.
    if (row.outcome === null) return null;
    return { kind: kindForOutcome(row.outcome), dispatched, handoffReason: null };
  }
  if (row.state === "rejected") {
    // Every §4.1 reason. The fine-grained reason lives in the audit record, not
    // the row (§7.2), so this projection reports only the pair.
    return { kind: "rejection", dispatched: false, handoffReason: null };
  }
  if (row.state !== "ambiguous") return null;
  const reason = row.handoff?.reason ?? "operator-escalation";
  if (ALWAYS_DISPATCHED_HANDOFF_REASONS.includes(reason)) {
    return { kind: "ambiguous-execution", dispatched: true, handoffReason: reason };
  }
  if (EXECUTION_UNCERTAIN_HANDOFF_REASONS.includes(reason)) {
    return dispatched
      ? { kind: "ambiguous-execution", dispatched: true, handoffReason: reason }
      : { kind: "human-handoff", dispatched: false, handoffReason: reason };
  }
  // `operator-escalation` and `ack-publication-abandoned`: the disposition is
  // already known or explicitly abandoned, so it is a handoff at both values.
  return { kind: "human-handoff", dispatched, handoffReason: reason };
}

// ---------------------------------------------------------------------------
// §7.1 Outcome constructors, one per summary source
// ---------------------------------------------------------------------------

function outcome(
  kind: ChatOpsResultKind,
  dispatched: boolean,
  reason: string | null,
  summary: string,
  configuredPaths: readonly string[],
): ChatOpsPublicOutcome {
  return { kind, dispatched, reason, summary: sanitizeChatOpsPublicText(summary, configuredPaths) };
}

/** §7.1 source 2 — a §4.1 refusal that never reached the operation port. */
export function chatOpsUndispatchedOutcome(
  reason: ChatOpsUndispatchedReason,
  configuredPaths: readonly string[],
  detail?: string,
): ChatOpsPublicOutcome {
  const template = UNDISPATCHED_TEMPLATES[reason];
  // #784's `detail` is eligible but never trusted as pre-sanitized (§6); it
  // rides the identical pipeline as an operation summary.
  const text = detail === undefined || detail.trim() === "" ? template : `${template} ${detail.trim()}`;
  return outcome("rejection", false, reason, text, configuredPaths);
}

/**
 * §7.1 source 1 — ledger row 8: the operation returned a definite result.
 *
 * `dispatched` is `true` by construction: row 8 fires only from `dispatching`,
 * which requires a prior write-ahead.
 */
export function chatOpsDispatchResultOutcome(
  result: OperationResult,
  configuredPaths: readonly string[],
): ChatOpsPublicOutcome {
  if (result.status === "executed") {
    return outcome("success", true, null, result.summary, configuredPaths);
  }
  if (result.status === "rejected") {
    return outcome("rejection", true, result.reason, result.summary, configuredPaths);
  }
  return outcome("retryable-failure", true, result.reason, result.summary, configuredPaths);
}

/** §7.1 source 4 — ledger row 16: the automatic retry budget ran out. */
export function chatOpsRetryBudgetExhaustedOutcome(
  configuredPaths: readonly string[],
): ChatOpsPublicOutcome {
  return outcome(
    "retryable-failure",
    true,
    "retry-budget-exhausted",
    CHATOPS_RETRY_BUDGET_EXHAUSTED_SUMMARY,
    configuredPaths,
  );
}

/** §7.1 source 4 — ledger row 21: an operator recorded the outcome directly. */
export function chatOpsOperatorResolvedOutcome(
  resolved: ChatOpsMarkerOutcome,
  attempts: number,
  configuredPaths: readonly string[],
): ChatOpsPublicOutcome {
  return outcome(
    kindForOutcome(resolved),
    attempts >= 1,
    resolved === "executed" ? null : "operator-resolved",
    CHATOPS_OPERATOR_RESOLVED_SUMMARY,
    configuredPaths,
  );
}

/** §7.1 source 4 — ledger row 10: reconciliation adopted a marker already on the provider. */
export function chatOpsReconciledFromMarkerOutcome(
  adopted: ChatOpsMarkerOutcome,
  configuredPaths: readonly string[],
): ChatOpsPublicOutcome {
  return outcome(
    kindForOutcome(adopted),
    // Row 10 is reachable only from `dispatching`, so it has no zero-attempt path.
    true,
    adopted === "executed" ? null : "reconciled-from-marker",
    CHATOPS_RECONCILED_FROM_MARKER_SUMMARY,
    configuredPaths,
  );
}

/**
 * §7.1 source 3 — a dispatched row that reached `ambiguous` without ever
 * passing through `awaiting_ack`, so no `OperationResult` and no
 * ledger-synthesized sentence exists to preserve.
 *
 * A zero-attempt row takes the undispatched template instead, per §7.1's
 * carve-out: no operation was ever called for it either.
 */
export function chatOpsHandoffOutcome(
  reason: ChatOpsLedgerHandoffReason,
  attempts: number,
  configuredPaths: readonly string[],
): ChatOpsPublicOutcome {
  const dispatched = attempts >= 1;
  const kind: ChatOpsResultKind =
    dispatched && EXECUTION_UNCERTAIN_HANDOFF_REASONS.includes(reason)
      ? "ambiguous-execution"
      : "human-handoff";
  return outcome(kind, dispatched, reason, HANDOFF_TEMPLATES[reason], configuredPaths);
}

// ---------------------------------------------------------------------------
// §7.2 Reason domains
// ---------------------------------------------------------------------------

const OPERATION_REJECTION_REASONS: readonly string[] = Object.freeze([
  "unknown-operation",
  "invalid-request",
  "invalid-context",
  "not-permitted",
  "precondition-failed",
  "conflict",
]);

const OPERATION_FAILURE_REASONS: readonly string[] = Object.freeze([
  "unavailable",
  "timeout",
  "internal",
]);

/**
 * Check a public outcome against §7.2's per-`(kind, dispatched)` reason domain.
 *
 * Returns a defect message, or `null` when well formed. A reason outside its
 * domain is not a stylistic problem: it means a consumer that switches on the
 * closed set has met a value it has no branch for, which is the same posture
 * `operation-port.ts` takes for its own two reason sets.
 */
export function validateChatOpsPublicOutcome(value: ChatOpsPublicOutcome): string | null {
  if (!CHATOPS_RESULT_KINDS.includes(value.kind)) {
    return `unknown chatops result kind ${JSON.stringify(value.kind)}`;
  }
  if (typeof value.dispatched !== "boolean") return "dispatched must be a boolean";
  if (typeof value.summary !== "string" || value.summary.trim() === "") {
    return "summary is required for every disposition";
  }
  const reason = value.reason;
  const undispatchedRejection: readonly string[] = CHATOPS_UNDISPATCHED_REASONS;
  switch (value.kind) {
    case "success":
      return reason === null ? null : `success carries no reason, got ${JSON.stringify(reason)}`;
    case "rejection": {
      const domain = value.dispatched
        ? [...OPERATION_REJECTION_REASONS, "operator-resolved", "reconciled-from-marker"]
        : [...undispatchedRejection, "operator-resolved"];
      return reason !== null && domain.includes(reason)
        ? null
        : `rejection (dispatched=${value.dispatched}) reason ${JSON.stringify(reason)} is outside its domain`;
    }
    case "retryable-failure": {
      const domain = value.dispatched
        ? [
            ...OPERATION_FAILURE_REASONS,
            "retry-budget-exhausted",
            "operator-resolved",
            "reconciled-from-marker",
          ]
        : ["operator-resolved"];
      return reason !== null && domain.includes(reason)
        ? null
        : `retryable-failure (dispatched=${value.dispatched}) reason ${JSON.stringify(reason)} is outside its domain`;
    }
    case "ambiguous-execution":
      if (!value.dispatched) return "ambiguous-execution is never reported at dispatched=false";
      return reason !== null && EXECUTION_UNCERTAIN_HANDOFF_REASONS.includes(reason as ChatOpsLedgerHandoffReason)
        ? null
        : `ambiguous-execution reason ${JSON.stringify(reason)} is outside its domain`;
    case "human-handoff": {
      const domain: readonly string[] = value.dispatched
        ? ["operator-escalation", "ack-publication-abandoned"]
        : [
            "operator-escalation",
            "ledger-regression",
            "restore-detected",
            "witness-missing",
            "ack-publication-abandoned",
          ];
      return reason !== null && domain.includes(reason)
        ? null
        : `human-handoff (dispatched=${value.dispatched}) reason ${JSON.stringify(reason)} is outside its domain`;
    }
  }
}

// ---------------------------------------------------------------------------
// §5, §5.1 Rendering
// ---------------------------------------------------------------------------

/**
 * Build a canonical marker body (#777 §7, §5.1).
 *
 * Nothing is ever appended: a marker whose trimmed body is not *exactly* one
 * of the two canonical forms fails authentication, and an unauthenticated
 * marker can never become reconciliation evidence — which would silently
 * disarm every restore detector built on it.
 */
export function chatOpsMarkerBody(commentId: string, ackOutcome?: ChatOpsMarkerOutcome): string {
  return ackOutcome === undefined
    ? `<!-- chatops-claimed:${commentId} -->`
    : `<!-- chatops-ack:${commentId}:${ackOutcome} -->`;
}

/**
 * Render the summary comment (§5.1): the pinned header, a blank line, then the
 * sanitized summary and, where present, the closed reason code in prose.
 *
 * The header — never the summary — is the comment's first surviving non-blank
 * line, which is what makes the whole body grammar-ineligible regardless of
 * what an operation's prose happens to start with (§5.1, invariant 14).
 */
export function renderChatOpsSummaryComment(value: ChatOpsPublicOutcome): string {
  const reasonLine = value.reason === null ? "" : `\n\nReason: \`${value.reason}\``;
  return `${CHATOPS_SUMMARY_HEADER}\n\n${value.summary}${reasonLine}`;
}

/**
 * Render the handoff correction comment (§7.1).
 *
 * Scheduled only when a row already in `awaiting_ack` is escalated or fenced:
 * that row's summary was rendered — and possibly delivered — while it still
 * read `success`/`rejection`/`retryable-failure`, and this comment is what
 * keeps the requester from being left with a superseded outcome. It never
 * replaces the preserved summary (invariant 11).
 */
export function renderChatOpsHandoffCorrectionComment(
  reason: ChatOpsLedgerHandoffReason,
  configuredPaths: readonly string[],
): string {
  const sentence = sanitizeChatOpsPublicText(HANDOFF_TEMPLATES[reason], configuredPaths);
  return `${CHATOPS_HANDOFF_CORRECTION_HEADER}\n\n${sentence}\n\nReason: \`${reason}\``;
}
