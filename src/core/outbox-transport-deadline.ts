/**
 * Outbox transport deadlines (issue #1064).
 *
 * Every external call an outbox dispatch attempt makes — a `gh` subprocess, a
 * GitHub App token exchange, a Slack webhook request and the reading of its
 * response body — used to be unbounded. A single hung call therefore stalled the
 * whole run: the dispatcher drains rows sequentially, so a later *eligible* row
 * was never attempted, and (because the `gh` path is synchronous and blocks the
 * event loop) the claim-renewal timer that keeps a row's lease alive could not
 * fire either.
 *
 * This module holds the policy half of the fix, as pure values and pure
 * functions: the deadlines themselves, the per-attempt budget that keeps a
 * sequence of calls inside one lease, and the sanitized diagnostic a timed-out
 * attempt records. The mechanisms that actually cancel a call live with the
 * transports (`providers/github/gh-runner.ts`, `providers/github/github-app-auth.ts`)
 * and the dispatcher (`handlers/gh-dispatcher.ts`).
 *
 * Two bounds, deliberately, rather than one:
 *
 *  - a PER-CALL bound, so no single request can sit forever on a socket; and
 *  - a PER-ATTEMPT budget spanning every call one row's dispatch makes, because
 *    several provider operations run per row (the dedupe-marker history scan
 *    pages through the comment history before the POST it guards) and a per-call
 *    bound alone multiplies by the number of calls.
 *
 * The attempt budget is what aligns deadlines with claim handling: it is
 * validated to leave {@link OUTBOX_ATTEMPT_LEASE_MARGIN_MS} of the claim lease
 * ({@link OUTBOX_CLAIM_STALE_MS}) unspent, so a synchronous attempt that blocks
 * the renewal timer for its whole duration still cannot outlive the lease it was
 * claimed under. Without that, a concurrent dispatcher's staleness check could
 * reclaim a row whose first attempt is still in flight and duplicate its
 * external effect.
 */

import { OUTBOX_CLAIM_STALE_MS } from "./outbox.js";
import { boundedExcerpt, redactTokens, sanitizeBody } from "./text-sanitize.js";

// ---------------------------------------------------------------------------
// Policy values
// ---------------------------------------------------------------------------

/**
 * Wall-clock bound on one `gh` invocation (including the GitHub App
 * token-injecting variant). Generous relative to a healthy API call — the point
 * is to bound a hang, not to fail a slow-but-live request.
 */
export const OUTBOX_GH_CALL_DEADLINE_MS = 60_000;

/**
 * Wall-clock bound on one Slack webhook delivery, covering the request AND the
 * consumption of its response body. Slicing a body after reading it does not
 * bound that read, so both halves share this one deadline.
 */
export const OUTBOX_SLACK_REQUEST_DEADLINE_MS = 15_000;

/**
 * Wall-clock bound on one row's whole dispatch attempt, across every external
 * call it makes.
 *
 * Well under {@link OUTBOX_CLAIM_STALE_MS} by construction (see
 * {@link OUTBOX_ATTEMPT_LEASE_MARGIN_MS}): the claim is stamped immediately
 * before the attempt starts, so an attempt that fits in this budget always
 * releases (via `markSent`/`markFailed`) while its own claim is still active,
 * whether or not the renewal timer ever got a chance to run.
 */
export const OUTBOX_ATTEMPT_DEADLINE_MS = 4 * 60_000;

/**
 * How much of the claim lease an attempt budget must leave unspent.
 *
 * Covers the work that brackets the external calls but is not measured by the
 * budget: the claim write itself, provider construction, JSON parsing of the
 * last response, and the fenced `markSent`/`markFailed` that releases the claim.
 * A budget that consumed the lease exactly would leave that tail outside it.
 */
export const OUTBOX_ATTEMPT_LEASE_MARGIN_MS = 60_000;

/** Bound on the GitHub App installation-token exchange (both transports). */
export const OUTBOX_GITHUB_APP_TOKEN_EXCHANGE_DEADLINE_MS = 15_000;

/** The resolved, validated set of deadlines a dispatch run operates under. */
export interface OutboxTransportDeadlines {
  /** Budget for one row's entire dispatch attempt. */
  attemptMs: number;
  /** Bound on a single `gh` invocation. */
  ghCallMs: number;
  /** Bound on a single Slack request plus its response-body read. */
  slackRequestMs: number;
}

/** Caller-supplied overrides; anything omitted keeps the default above. */
export type OutboxTransportDeadlineOverrides = Partial<OutboxTransportDeadlines>;

/**
 * A deadline configuration that cannot be honoured — a non-positive or
 * non-finite bound, a per-call bound larger than the attempt budget it must fit
 * inside, or an attempt budget that would run past the claim lease.
 *
 * Raised before a dispatch run claims anything, so a misconfiguration is a setup
 * failure with no external side effect rather than a run that silently
 * dispatches under bounds it cannot keep. Never clamped silently: a bound that
 * is quietly reduced is a bound nobody can reason about from the configuration.
 */
export class OutboxTransportDeadlineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxTransportDeadlineConfigError";
  }
}

function requirePositiveMs(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new OutboxTransportDeadlineConfigError(
      `outbox transport deadline ${label} must be a finite positive number of milliseconds, got: ${String(value)}`,
    );
  }
}

/**
 * Resolve and validate the deadlines for a dispatch run.
 *
 * Total: every input either yields a usable set or raises
 * {@link OutboxTransportDeadlineConfigError}. The invariants checked here are
 * the ones the rest of the mechanism assumes — a per-call bound that exceeded
 * the attempt budget would never be reached, and an attempt budget that outran
 * the claim lease would reintroduce exactly the reclaim-and-duplicate race the
 * budget exists to close.
 */
export function resolveOutboxTransportDeadlines(
  overrides: OutboxTransportDeadlineOverrides = {},
): OutboxTransportDeadlines {
  const resolved: OutboxTransportDeadlines = {
    attemptMs: overrides.attemptMs ?? OUTBOX_ATTEMPT_DEADLINE_MS,
    ghCallMs: overrides.ghCallMs ?? OUTBOX_GH_CALL_DEADLINE_MS,
    slackRequestMs: overrides.slackRequestMs ?? OUTBOX_SLACK_REQUEST_DEADLINE_MS,
  };
  requirePositiveMs("attemptMs", resolved.attemptMs);
  requirePositiveMs("ghCallMs", resolved.ghCallMs);
  requirePositiveMs("slackRequestMs", resolved.slackRequestMs);

  const maxAttemptMs = OUTBOX_CLAIM_STALE_MS - OUTBOX_ATTEMPT_LEASE_MARGIN_MS;
  if (resolved.attemptMs > maxAttemptMs) {
    throw new OutboxTransportDeadlineConfigError(
      `outbox attempt deadline ${resolved.attemptMs}ms would run past the dispatch claim lease ` +
        `(${OUTBOX_CLAIM_STALE_MS}ms minus a ${OUTBOX_ATTEMPT_LEASE_MARGIN_MS}ms margin = ${maxAttemptMs}ms)`,
    );
  }
  for (const [label, value] of [
    ["ghCallMs", resolved.ghCallMs],
    ["slackRequestMs", resolved.slackRequestMs],
  ] as const) {
    if (value > resolved.attemptMs) {
      throw new OutboxTransportDeadlineConfigError(
        `outbox transport deadline ${label} (${value}ms) exceeds the attempt budget (${resolved.attemptMs}ms)`,
      );
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Per-attempt budget
// ---------------------------------------------------------------------------

/**
 * The remaining-time view a single row's dispatch attempt hands to its
 * transports. One instance per attempt, started immediately after the row is
 * claimed.
 */
export interface OutboxAttemptBudget {
  /** Milliseconds consumed since the attempt started. */
  elapsedMs(): number;
  /** Milliseconds left before the attempt budget expires; never negative. */
  remainingMs(): number;
  /** Whether the budget is spent — the next call must not be started at all. */
  expired(): boolean;
  /**
   * The deadline for the next call: the smaller of its own per-call bound and
   * what is left of the attempt. `0` means the attempt is already over, which
   * the transport reports as a timeout without issuing the call.
   */
  callTimeoutMs(perCallMs: number): number;
  /** The attempt budget this was started with, for diagnostics. */
  readonly attemptMs: number;
}

/**
 * Start an attempt budget. `now` is injectable so tests can drive expiry
 * deterministically rather than by sleeping.
 */
export function startOutboxAttemptBudget(
  attemptMs: number,
  now: () => number = Date.now,
): OutboxAttemptBudget {
  const startedAt = now();
  const elapsedMs = (): number => Math.max(0, now() - startedAt);
  const remainingMs = (): number => Math.max(0, attemptMs - elapsedMs());
  return {
    attemptMs,
    elapsedMs,
    remainingMs,
    expired: () => remainingMs() <= 0,
    callTimeoutMs: (perCallMs: number) => Math.min(perCallMs, remainingMs()),
  };
}

// ---------------------------------------------------------------------------
// Sanitized timeout diagnostics
// ---------------------------------------------------------------------------

/**
 * Stable leading text of every deadline diagnostic this module builds. Callers
 * (and operators grepping `admin outbox list`) match on this rather than on the
 * variable tail.
 */
export const OUTBOX_TRANSPORT_TIMEOUT_PREFIX = "outbox transport deadline exceeded";

/** Which transport a deadline was enforced against. */
export type OutboxTransportKind = "gh" | "slack" | "github-app-token";

/**
 * Where in the call the deadline landed. `attempt-budget` means the attempt had
 * already spent its budget and the call was refused before being issued — the
 * only stage that performs no external I/O at all, and therefore the only one
 * whose remote outcome is never in doubt.
 */
export type OutboxTransportTimeoutStage = "request" | "response-body" | "attempt-budget";

export interface OutboxTransportTimeoutFacts {
  transport: OutboxTransportKind;
  stage: OutboxTransportTimeoutStage;
  /** The bound that was actually applied to this call. */
  limitMs: number;
  /** The attempt budget the call ran inside. */
  attemptMs: number;
  /** Measured duration of the call, when the transport reported one. */
  elapsedMs?: number;
  /** The runner had to escalate to `SIGKILL` to get the child back. */
  escalated?: boolean;
  /** Outcome of the post-kill process-group sweep, when one ran. */
  processGroupTerminated?: boolean;
  /**
   * Whether a remote state change may have been applied despite the timeout —
   * the fact a retry has to be reconciled against, and the reason a timed-out
   * write is never replayed blindly.
   *
   * True whenever a request was issued and its result never came back: that
   * write may well have landed. False only when the outcome is genuinely
   * settled — nothing was issued at all (the attempt budget was already spent),
   * or the remote already answered and only the trailing body read was cut off.
   */
  outcomeUnknown: boolean;
  /** Whatever the transport itself said, appended verbatim (then sanitized). */
  detail?: string;
}

/** Cap on the transport-supplied tail of a diagnostic. */
const TIMEOUT_DETAIL_MAX_CHARS = 200;

/**
 * Render a timeout as the row's `lastError`.
 *
 * Built from typed facts rather than from captured output: the message has to
 * survive being persisted and shown to an operator, so it must not carry local
 * paths, tokens, or a child's arbitrary stderr. The one free-form part
 * (`detail`) is passed through the same sanitizer chain the outbox store applies
 * to `lastError`, so the text is already safe before it is handed over — the
 * store's own pass then stays a defense in depth rather than the only guard.
 */
export function describeOutboxTransportTimeout(facts: OutboxTransportTimeoutFacts): string {
  const parts: string[] = [
    `${OUTBOX_TRANSPORT_TIMEOUT_PREFIX}: ${facts.transport} ${facts.stage} bounded at ${facts.limitMs}ms`,
    `attempt budget ${facts.attemptMs}ms`,
  ];
  if (facts.elapsedMs !== undefined) parts.push(`elapsed ${facts.elapsedMs}ms`);
  if (facts.escalated) parts.push("child force-killed after ignoring the deadline signal");
  if (facts.processGroupTerminated !== undefined) {
    parts.push(
      facts.processGroupTerminated
        ? "child process group terminated"
        : "child process group NOT confirmed terminated",
    );
  }
  parts.push(
    facts.outcomeUnknown
      ? "remote outcome unknown — not replayed blindly"
      : "no external side effect was left in doubt",
  );
  const head = parts.join("; ");
  const detail = facts.detail === undefined ? "" : sanitizeTimeoutDetail(facts.detail);
  return detail === "" ? head : `${head} — ${detail}`;
}

/** The sanitizer applied to any transport-supplied text before it is persisted. */
export function sanitizeTimeoutDetail(detail: string): string {
  return boundedExcerpt(redactTokens(sanitizeBody(detail)), TIMEOUT_DETAIL_MAX_CHARS).trim();
}

/**
 * Whether a recorded error came from a transport deadline (issue #1064). Lets a
 * caller — an operator tool, a test — tell a bounded hang apart from an ordinary
 * provider failure without re-deriving the wording.
 */
export function isOutboxTransportTimeout(error: string | undefined): boolean {
  return error !== undefined && error.includes(OUTBOX_TRANSPORT_TIMEOUT_PREFIX);
}
