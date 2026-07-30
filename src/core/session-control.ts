import type { TaskPhase } from "./task.js";

/**
 * Session-level pause / circuit-breaker / run-ledger contracts (issue #531).
 *
 * The loop has per-run controls (agent budgets, review-loop caps) but until
 * this module had no session-level stop switch: repeated failures, quota
 * windows, or lock bugs burned cycles until a human stopped n8n by hand. The
 * pieces here give automation a deliberate stop:
 *
 * - a runner-owned pause state per session (stored in SQLite, never in GitHub
 *   labels) that `run-one-phase` checks BEFORE claiming work;
 * - a lightweight per-run result ledger (session, issue, phase, outcome,
 *   duration, agent/model/effort and cost metadata when known);
 * - a circuit-breaker policy over that ledger ("pause after N consecutive
 *   failed outcomes in a session" / "after N consecutive failed outcomes for
 *   the same issue+phase") so the loop pauses itself instead of waiting for a
 *   human to notice.
 *
 * Everything in this file is pure logic and type contracts; the SQLite
 * implementation lives in stores/sqlite-session-control-store.ts.
 */

/** A session that is currently paused: no new work is claimed or executed. */
export interface SessionPauseRecord {
  paused: true;
  /** Operator- or breaker-supplied reason, shown in status output. */
  reason?: string;
  pausedAt?: string;
  /** Who paused: an operator identity or `circuit-breaker`. */
  pausedBy?: string;
  /** How the pause originated. */
  source?: "operator" | "circuit_breaker";
}

export type SessionPauseState = { paused: false } | SessionPauseRecord;

/**
 * Result of a phase run as recorded in the ledger. Mirrors the phase-runner's
 * handler result values plus `delayed` (quota/rate-limit release-and-retry).
 */
export type RunLedgerOutcome =
  | "success"
  | "needs_fix"
  | "conflict"
  | "blocked"
  | "tool_request"
  | "delayed"
  | "failed";

/** Outcomes the circuit breaker counts as failures. Quota delays (`delayed`)
 * are deliberately excluded: they are provider windows, not broken work, and
 * already have their own notBefore backoff. */
export function isFailureOutcome(outcome: RunLedgerOutcome): boolean {
  return outcome === "failed";
}

/**
 * One per-run result row, usable by the circuit breaker and by operators
 * auditing where cycles went. Agent/model/effort and cost metadata are
 * best-effort — recorded when the handler surfaced them, absent otherwise.
 */
export interface RunLedgerEntryInput {
  sessionId: string;
  issueNumber: number;
  phase: TaskPhase;
  outcome: RunLedgerOutcome;
  runId?: string;
  durationMs?: number;
  agent?: string;
  model?: string;
  effort?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: string;
}

export interface RunLedgerEntry extends RunLedgerEntryInput {
  /** Monotonic row id assigned by the store; higher = more recent. */
  id: number;
}

/**
 * Runner-owned session control state: pause flag plus the per-run result
 * ledger. Stored in SQLite (stores/sqlite-session-control-store.ts) — never in
 * GitHub labels — so pausing a session needs no GitHub round-trip and survives
 * n8n restarts.
 */
export interface SessionControlStore {
  getPauseState(sessionId: string): Promise<SessionPauseState>;
  /**
   * Pause a session. Overwrites an existing pause (an explicit operator pause
   * may update the reason) unless `onlyIfUnpaused` is set, in which case an
   * already-paused session is left untouched — the circuit breaker uses this
   * so an automatic trip never clobbers an operator's pause reason. The
   * check-and-write is atomic. `alreadyPaused` reports whether the session
   * was paused before this call; `changed` whether a write occurred.
   */
  pauseSession(
    sessionId: string,
    options?: {
      reason?: string;
      pausedBy?: string;
      source?: "operator" | "circuit_breaker";
      now?: string;
      onlyIfUnpaused?: boolean;
    },
  ): Promise<{ changed: boolean; alreadyPaused: boolean; state: SessionPauseRecord }>;
  /**
   * Resume a paused session. A session that is not paused is a safe no-op
   * (`changed: false`). `previous` carries the pause record that was cleared.
   */
  resumeSession(
    sessionId: string,
    options?: { now?: string },
  ): Promise<{ changed: boolean; previous?: SessionPauseRecord }>;
  /**
   * Append one per-run result row to the ledger and return the stored row
   * with its assigned id, so callers can anchor follow-up reads at exactly
   * that row (see {@link recordRunAndEvaluate}).
   */
  recordRun(entry: RunLedgerEntryInput): Promise<RunLedgerEntry>;
  /**
   * Most recent ledger rows for a session, newest first. When `maxId` is
   * given, only rows with `id <= maxId` are returned — a consistent
   * as-of-that-row snapshot that concurrent later inserts cannot perturb.
   */
  listRecentRuns(sessionId: string, limit?: number, maxId?: number): Promise<RunLedgerEntry[]>;
  /**
   * Most recent ledger rows for one issue+phase within a session, newest
   * first. The circuit breaker's same-issue+phase rule evaluates over this
   * dedicated window — never over an issue-filtered slice of the session-wide
   * window — so a failure streak survives any amount of interleaved activity
   * for other issues (review on issue #531). `maxId` bounds the window to
   * rows with `id <= maxId`, as in {@link listRecentRuns}.
   */
  listRecentIssuePhaseRuns(
    sessionId: string,
    issueNumber: number,
    phase: TaskPhase,
    limit?: number,
    maxId?: number,
  ): Promise<RunLedgerEntry[]>;
}

// ---------------------------------------------------------------------------
// Circuit-breaker policy
// ---------------------------------------------------------------------------

export interface CircuitBreakerPolicy {
  /**
   * Pause the session after this many consecutive failed outcomes across the
   * whole session. 0 disables the rule.
   */
  maxConsecutiveFailures: number;
  /**
   * Pause the session after this many consecutive failed outcomes for the
   * SAME issue+phase (runs for other issues in between do not reset the
   * count). 0 disables the rule.
   */
  maxIssuePhaseFailures: number;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
export const DEFAULT_MAX_ISSUE_PHASE_FAILURES = 3;

/**
 * Minimum number of recent session-wide ledger rows the breaker inspects when
 * evaluating a trip. Bounded so evaluation cost stays flat regardless of
 * ledger size. This window serves the session-consecutive-failures rule (and
 * the filter fallback in {@link evaluateCircuitBreaker} for callers without
 * store access); the same-issue+phase rule is NOT bounded by it — it evaluates
 * over a dedicated per-issue+phase query (see
 * {@link fetchCircuitBreakerWindows}) so interleaved runs of other issues can
 * never push a streak out of view. When an operator configures a threshold
 * above this floor, the fetch window grows to match — see
 * {@link circuitBreakerEvalWindow} — so a valid threshold can always be
 * reached.
 */
export const CIRCUIT_BREAKER_EVAL_WINDOW = 50;

/**
 * Session-wide ledger rows to fetch for a breaker evaluation under `policy`:
 * at least {@link CIRCUIT_BREAKER_EVAL_WINDOW}, and never fewer than the
 * largest configured threshold — otherwise a threshold above the fixed window
 * could never accumulate enough rows to trip (e.g. 51 consecutive failures
 * with a threshold of 51 would only ever see the newest 50).
 */
export function circuitBreakerEvalWindow(policy: CircuitBreakerPolicy): number {
  return Math.max(
    CIRCUIT_BREAKER_EVAL_WINDOW,
    policy.maxConsecutiveFailures,
    policy.maxIssuePhaseFailures,
  );
}

function parseThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  // 0 is a valid explicit "disable this rule"; anything non-integer or
  // negative is ignored so a typo can never silently disable the breaker.
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/**
 * Resolve the circuit-breaker thresholds from the environment so operators can
 * tune (or disable, with 0) each rule without code changes:
 *
 *   CIRCUIT_BREAKER_SESSION_FAILURES     — consecutive session-wide failures (default 5)
 *   CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES — consecutive same-issue+phase failures (default 3)
 *
 * Invalid values are ignored and the default applies (mirrors
 * resolveQuotaRetryDelayMs in quota-classifier.ts).
 */
export function resolveCircuitBreakerPolicy(
  env: NodeJS.ProcessEnv = process.env,
): CircuitBreakerPolicy {
  return {
    maxConsecutiveFailures: parseThreshold(
      env["CIRCUIT_BREAKER_SESSION_FAILURES"],
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
    ),
    maxIssuePhaseFailures: parseThreshold(
      env["CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES"],
      DEFAULT_MAX_ISSUE_PHASE_FAILURES,
    ),
  };
}

export type CircuitBreakerRule = "session_consecutive_failures" | "issue_phase_failures";

export type CircuitBreakerDecision =
  | { trip: false }
  | { trip: true; rule: CircuitBreakerRule; count: number; threshold: number; reason: string };

/**
 * Count consecutive failed outcomes from the newest entry backwards. Any
 * non-failure outcome (including `delayed`) ends the streak: a success or a
 * quota window between failures means the loop is not uniformly wasting
 * cycles.
 */
export function countConsecutiveFailures(recentRuns: readonly RunLedgerEntry[]): number {
  let count = 0;
  for (const run of recentRuns) {
    if (!isFailureOutcome(run.outcome)) break;
    count += 1;
  }
  return count;
}

/**
 * Evaluate the circuit breaker over the most recent ledger rows (newest
 * first). The newest entry is the run just recorded; nothing trips unless that
 * run itself failed, so the breaker fires exactly once per failing run rather
 * than re-tripping on every later success.
 *
 * Rules (each disabled by a 0 threshold):
 * - `session_consecutive_failures`: the newest N outcomes in the session are
 *   all failures.
 * - `issue_phase_failures`: restricted to entries for the SAME issue+phase as
 *   the newest entry, the newest N of those are all failures — interleaved
 *   runs of other issues neither reset nor count toward this streak.
 *
 * `issuePhaseRuns` carries the newest-first rows for that issue+phase from a
 * dedicated store query (see {@link fetchCircuitBreakerWindows}); callers with
 * store access must pass it so the streak is never truncated by the
 * session-wide row cap of `recentRuns`. When omitted (pure-logic callers), the
 * rule falls back to filtering `recentRuns`, which can only see as far back as
 * that window reaches.
 */
export function evaluateCircuitBreaker(
  recentRuns: readonly RunLedgerEntry[],
  policy: CircuitBreakerPolicy,
  issuePhaseRuns?: readonly RunLedgerEntry[],
): CircuitBreakerDecision {
  const head = recentRuns[0];
  if (!head || !isFailureOutcome(head.outcome)) return { trip: false };

  if (policy.maxConsecutiveFailures > 0) {
    const count = countConsecutiveFailures(recentRuns);
    if (count >= policy.maxConsecutiveFailures) {
      return {
        trip: true,
        rule: "session_consecutive_failures",
        count,
        threshold: policy.maxConsecutiveFailures,
        reason:
          `Circuit breaker: ${count} consecutive failed run(s) in session ${head.sessionId} ` +
          `(threshold ${policy.maxConsecutiveFailures}). Last failure: issue #${head.issueNumber} ` +
          `(${head.phase}).`,
      };
    }
  }

  if (policy.maxIssuePhaseFailures > 0) {
    const samePhase =
      issuePhaseRuns ??
      recentRuns.filter(
        (run) => run.issueNumber === head.issueNumber && run.phase === head.phase,
      );
    const count = countConsecutiveFailures(samePhase);
    if (count >= policy.maxIssuePhaseFailures) {
      return {
        trip: true,
        rule: "issue_phase_failures",
        count,
        threshold: policy.maxIssuePhaseFailures,
        reason:
          `Circuit breaker: ${count} consecutive failed ${head.phase} run(s) for issue ` +
          `#${head.issueNumber} in session ${head.sessionId} (threshold ${policy.maxIssuePhaseFailures}).`,
      };
    }
  }

  return { trip: false };
}

/**
 * Fetch the ledger windows a breaker evaluation needs: the session-wide recent
 * window (session-consecutive-failures rule) plus, when the issue-phase rule
 * is enabled and the ledger is non-empty, a dedicated newest-first window for
 * the newest entry's issue+phase. Querying that issue+phase separately (review
 * on issue #531) means its failure streak is evaluated over its own history
 * rather than whatever survives the session-wide row cap — three failures
 * separated by dozens of interleaved runs of other issues still reach the
 * configured threshold. Fetching exactly `maxIssuePhaseFailures` rows is
 * sufficient: the rule trips only when the newest N matching rows are ALL
 * failures, so any older row can never change the decision.
 *
 * `anchorId` pins both windows to rows with `id <= anchorId`, i.e. the ledger
 * exactly as of that row. {@link recordRunAndEvaluate} passes the id of the
 * run it just recorded (review on issue #531): without the anchor, a run for
 * another issue finishing between the insert and these reads would become the
 * newest row, dethrone the just-recorded failure as `recent[0]`, and make
 * {@link evaluateCircuitBreaker} skip a trip that had reached its threshold.
 */
export async function fetchCircuitBreakerWindows(
  control: SessionControlStore,
  sessionId: string,
  policy: CircuitBreakerPolicy,
  anchorId?: number,
): Promise<{ recent: RunLedgerEntry[]; issuePhaseRuns?: RunLedgerEntry[] }> {
  const recent = await control.listRecentRuns(
    sessionId,
    circuitBreakerEvalWindow(policy),
    anchorId,
  );
  const head = recent[0];
  if (!head || policy.maxIssuePhaseFailures <= 0) return { recent };
  const issuePhaseRuns = await control.listRecentIssuePhaseRuns(
    sessionId,
    head.issueNumber,
    head.phase,
    policy.maxIssuePhaseFailures,
    anchorId,
  );
  return { recent, issuePhaseRuns };
}

/** Best-effort agent/model/effort and cost metadata for a ledger row. */
export interface RunMetadata {
  agent?: string;
  model?: string;
  effort?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Best-effort agent/model/effort and cost metadata extraction from a handler
 * result context. Handlers already persist a `resolvedProfile`
 * (agentId/model/effort) for audit; cost/token fields are read from well-known
 * top-level keys when a handler surfaces them. Unknown shapes yield an empty
 * object — recording a ledger row must never fail on context shape.
 */
export function extractRunMetadata(context: Record<string, unknown> | undefined): RunMetadata {
  const out: RunMetadata = {};
  if (!context) return out;
  const profile = context["resolvedProfile"];
  if (profile && typeof profile === "object") {
    const p = profile as Record<string, unknown>;
    if (typeof p["agentId"] === "string") out.agent = p["agentId"];
    if (typeof p["model"] === "string") out.model = p["model"];
    if (typeof p["effort"] === "string") out.effort = p["effort"];
  }
  const costUsd = finiteNumber(context["costUsd"]);
  if (costUsd !== undefined) out.costUsd = costUsd;
  const inputTokens = finiteNumber(context["inputTokens"]);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  const outputTokens = finiteNumber(context["outputTokens"]);
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  return out;
}

/**
 * Outcome of {@link recordRunAndEvaluate}: whether the just-recorded run
 * tripped the breaker, and whether that trip actually paused the session now
 * (`pausedNow: false` with `tripped: true` means the session was already
 * paused — e.g. by an operator — and the existing pause was left untouched).
 */
export interface RecordRunEvaluation {
  tripped: boolean;
  pausedNow: boolean;
  decision: CircuitBreakerDecision;
  pauseState?: SessionPauseRecord;
}

/**
 * Record one run in the ledger, then evaluate the circuit breaker and pause
 * the session when a rule trips. This is the single wiring point
 * `run-one-phase` calls from the phase-runner's `recordRunResult` hook, kept
 * here (pure orchestration over the store interface) so it is directly
 * testable without a CLI process.
 *
 * The pause uses `onlyIfUnpaused` so an automatic trip never overwrites an
 * operator's pause reason.
 *
 * Concurrent phases run in separate processes, so between the insert and the
 * window reads another run can land newer ledger rows. The evaluation is
 * therefore anchored at the just-inserted row's id: the breaker judges the
 * ledger exactly as of this run, and a concurrently recorded success can
 * never mask a failure streak that reached its threshold (review on issue
 * #531).
 */
export async function recordRunAndEvaluate(
  control: SessionControlStore,
  entry: RunLedgerEntryInput,
  policy: CircuitBreakerPolicy,
): Promise<RecordRunEvaluation> {
  const recorded = await control.recordRun(entry);
  if (!isFailureOutcome(entry.outcome)) {
    return { tripped: false, pausedNow: false, decision: { trip: false } };
  }
  const { recent, issuePhaseRuns } = await fetchCircuitBreakerWindows(
    control,
    entry.sessionId,
    policy,
    recorded.id,
  );
  const decision = evaluateCircuitBreaker(recent, policy, issuePhaseRuns);
  if (!decision.trip) return { tripped: false, pausedNow: false, decision };
  const paused = await control.pauseSession(entry.sessionId, {
    reason: decision.reason,
    pausedBy: "circuit-breaker",
    source: "circuit_breaker",
    now: entry.createdAt,
    onlyIfUnpaused: true,
  });
  return {
    tripped: true,
    pausedNow: paused.changed,
    decision,
    pauseState: paused.state,
  };
}
