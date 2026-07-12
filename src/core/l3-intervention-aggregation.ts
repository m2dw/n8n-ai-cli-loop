/**
 * L3 intervention aggregation from SQLite events (issue #588).
 *
 * Aggregates L3 human-rescue signals from the local SQLite `events` and `tasks`
 * tables for a session. This module is strictly read-only and never writes to
 * the database.
 *
 * Observable L3 signals (from the events table):
 *   - human_review_return: `human_review_return` / `github_app_review_return` events
 *   - tool_request_resolution: `tool_request_resolved` / `tool_request_grant_executed`
 *     / `tool_request_grant_failed` events; also inferred from task.context.toolRequest
 *     when no resolution event exists (legacy / partial history without event emission).
 *
 * Signals NOT observable from SQLite events (no events emitted by these commands):
 *   - admin_recover: the recover command mutates the task row but emits no event.
 *   - quarantine: quarantine status/clear emit no events.
 *   - task_recreation: no event.
 *   - manual_db_repair: no event.
 *
 * Absent signals are surfaced in `L3AggregationResult.unobservableSignals` so
 * consumers can explain gaps rather than silently reporting false zero-counts.
 */

import type Database from "better-sqlite3";
import type { InterventionSignalKind } from "./intervention-taxonomy.js";
import { classifyIntervention, INTERVENTION_L3 } from "./intervention-taxonomy.js";

// ---------------------------------------------------------------------------
// Event type → signal mapping
// ---------------------------------------------------------------------------

/**
 * Maps raw SQLite event.type to the canonical L3 InterventionSignalKind.
 *
 * Only event types that unambiguously indicate a human L3 rescue action belong
 * here. Unknown, ambiguous, or planned-gate event types must NOT be added —
 * over-classifying violates the acceptance criterion "unknown or legacy events
 * are not over-classified".
 */
export const L3_EVENT_TYPE_MAP: Readonly<Record<string, InterventionSignalKind>> = {
  human_review_return: "human_review_return",
  github_app_review_return: "human_review_return",
  tool_request_resolved: "tool_request_resolution",
  tool_request_grant_executed: "tool_request_resolution",
  tool_request_grant_failed: "tool_request_resolution",
};

// ---------------------------------------------------------------------------
// Unobservable signals
// ---------------------------------------------------------------------------

/**
 * L3 signal kinds defined in the taxonomy that have no corresponding SQLite
 * event source. Listed so consumers can explain the gap rather than implying
 * zero counts for signals that simply cannot be observed from events.
 */
export const UNOBSERVABLE_L3_SIGNALS: readonly InterventionSignalKind[] = Object.freeze([
  "admin_recover",
  "quarantine",
  "task_recreation",
  "manual_db_repair",
] as InterventionSignalKind[]);

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** L3 intervention counts for a single issue within a session. */
export interface IssueL3Interventions {
  sessionId: string;
  issueNumber: number;
  /** L3 event counts keyed by InterventionSignalKind. */
  bySignal: Partial<Record<InterventionSignalKind, number>>;
  /** Sum of all signal counts for this issue. */
  total: number;
}

/**
 * Aggregated L3 intervention report for a session and optional date/issue scope.
 *
 * Designed to be consumed by `admin interventions` and future admin report
 * commands (issue #585). The `unobservableSignals` field explicitly names which
 * L3 signals cannot be counted from SQLite.
 */
export interface L3AggregationResult {
  sessionId: string;
  /** Lower bound (inclusive) on event.created_at, if supplied. */
  since?: string;
  /** Upper bound (exclusive) on event.created_at, if supplied. */
  until?: string;
  /** Per-issue breakdown, sorted by issueNumber ascending. */
  byIssue: IssueL3Interventions[];
  /** Total L3 event counts across all issues, keyed by signal kind. */
  bySignal: Partial<Record<InterventionSignalKind, number>>;
  /** Total L3 events across all issues in the queried scope. */
  total: number;
  /**
   * L3 signal kinds from the taxonomy with no SQLite event source.
   * Consumers should treat these as "not tracked from events", not zero.
   */
  unobservableSignals: readonly InterventionSignalKind[];
}

// ---------------------------------------------------------------------------
// SQL queries (built once at module load from the event-type map)
// ---------------------------------------------------------------------------

// The IN clause is constructed from L3_EVENT_TYPE_MAP keys so adding a new
// mapping automatically extends the query. Keys are module-internal string
// constants — not user input — so string interpolation is safe here.
const EVENT_TYPE_SQL_LIST = Object.keys(L3_EVENT_TYPE_MAP)
  .map((t) => `'${t}'`)
  .join(", ");

// Optional filters use (? IS NULL OR col = ?) so the binding list is always
// the same length regardless of which filters are active. SQLite evaluates
// `NULL IS NULL` as true, effectively bypassing the filter.
const EVENT_QUERY = `
  SELECT issue_number, type
  FROM events
  WHERE session_id = ?
    AND type IN (${EVENT_TYPE_SQL_LIST})
    AND (? IS NULL OR issue_number = ?)
    AND (? IS NULL OR created_at >= ?)
    AND (? IS NULL OR created_at < ?)
  ORDER BY issue_number ASC, id ASC
`;

const TASK_QUERY = `
  SELECT issue_number, context
  FROM tasks
  WHERE session_id = ?
    AND (? IS NULL OR issue_number = ?)
`;

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface RawEvent {
  issue_number: number;
  type: string;
}

interface RawTask {
  issue_number: number;
  context: string;
}

/**
 * Aggregate L3 interventions for a session from an open SQLite database.
 *
 * The `db` connection is NOT closed by this function. The caller is responsible
 * for lifecycle management and should open it with `{ readonly: true }` when
 * possible.
 *
 * The function degrades gracefully when the `events` or `tasks` table is absent
 * (empty / brand-new database) — it returns an empty result rather than throwing.
 */
export function aggregateL3Interventions(
  db: Database.Database,
  sessionId: string,
  opts: { issueNumber?: number; since?: string; until?: string } = {},
): L3AggregationResult {
  const { issueNumber } = opts;

  // Normalize time bounds to canonical UTC ISO strings so they compare
  // correctly against `created_at` values stored as `toISOString()` output.
  // An ISO string with a timezone offset (e.g. +09:00) would otherwise
  // sort incorrectly against UTC strings in SQLite's lexical comparison.
  const since = opts.since !== undefined ? new Date(opts.since).toISOString() : undefined;
  const until = opts.until !== undefined ? new Date(opts.until).toISOString() : undefined;

  const issueFilter = issueNumber !== undefined ? issueNumber : null;
  const sinceFilter = since !== undefined ? since : null;
  const untilFilter = until !== undefined ? until : null;

  // Query L3 events. Bindings are always 7 positionals (see EVENT_QUERY).
  const eventBindings: (string | number | null)[] = [
    sessionId,
    issueFilter, issueFilter,
    sinceFilter, sinceFilter,
    untilFilter, untilFilter,
  ];

  let eventRows: RawEvent[];
  try {
    eventRows = db.prepare(EVENT_QUERY).all(...eventBindings) as RawEvent[];
  } catch (err) {
    // Suppress only the "no such table" error that occurs when the events table
    // has not been created yet (brand-new database). All other SQLite errors
    // (corrupt file, schema mismatch, etc.) must propagate so callers are not
    // misled into treating a broken data source as "zero interventions".
    const msg = (err as Error).message ?? "";
    if (!msg.includes("no such table")) {
      throw err;
    }
    eventRows = [];
  }

  // Group event-based signals by issue number.
  const issueSignals = new Map<number, Partial<Record<InterventionSignalKind, number>>>();

  for (const row of eventRows) {
    const signal = L3_EVENT_TYPE_MAP[row.type];
    if (!signal) continue;
    // Defensive: verify this is actually L3 so the map cannot drift to other levels.
    if (classifyIntervention(signal).level !== INTERVENTION_L3) continue;

    let bySig = issueSignals.get(row.issue_number);
    if (!bySig) {
      bySig = {};
      issueSignals.set(row.issue_number, bySig);
    }
    bySig[signal] = (bySig[signal] ?? 0) + 1;
  }

  // Task-context fallback: detect toolRequest flag on tasks where no
  // tool_request_* events exist (legacy / partial history). Applied only when
  // no resolution event is present to avoid double-counting.
  const taskBindings: (string | number | null)[] = [sessionId, issueFilter, issueFilter];

  let taskRows: RawTask[];
  try {
    taskRows = db.prepare(TASK_QUERY).all(...taskBindings) as RawTask[];
  } catch {
    taskRows = [];
  }

  for (const row of taskRows) {
    const bySig = issueSignals.get(row.issue_number);
    if ((bySig?.["tool_request_resolution"] ?? 0) > 0) continue;

    let ctx: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.context) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        ctx = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore corrupt context JSON
    }

    const toolRequest = ctx["toolRequest"];
    const toolRequestResolved =
      toolRequest !== undefined &&
      toolRequest !== null &&
      toolRequest !== false &&
      typeof toolRequest === "object" &&
      (toolRequest as Record<string, unknown>)["resolved"] === true;

    if (toolRequestResolved) {
      // Apply the same time window as the event query so date-bounded reports
      // are not inflated by legacy context resolved outside the window.
      if (since !== undefined || until !== undefined) {
        const resolution = (toolRequest as Record<string, unknown>)["resolution"];
        const resolvedAt =
          resolution !== null &&
          resolution !== undefined &&
          typeof resolution === "object" &&
          typeof (resolution as Record<string, unknown>)["resolvedAt"] === "string"
            ? ((resolution as Record<string, unknown>)["resolvedAt"] as string)
            : typeof (toolRequest as Record<string, unknown>)["resolvedAt"] === "string"
              ? ((toolRequest as Record<string, unknown>)["resolvedAt"] as string)
              : undefined;
        // If there is no resolvable timestamp we cannot place the resolution in
        // the window, so skip it for bounded queries rather than over-count.
        if (resolvedAt === undefined) continue;
        if (since !== undefined && resolvedAt < since) continue;
        if (until !== undefined && resolvedAt >= until) continue;
      }
      const entry = bySig ?? {};
      entry["tool_request_resolution"] = (entry["tool_request_resolution"] ?? 0) + 1;
      if (!bySig) issueSignals.set(row.issue_number, entry);
    }
  }

  // Build per-issue results sorted by issue number.
  const byIssue: IssueL3Interventions[] = Array.from(issueSignals.entries())
    .sort(([a], [b]) => a - b)
    .map(([n, bySig]) => ({
      sessionId,
      issueNumber: n,
      bySignal: bySig,
      total: Object.values(bySig).reduce((s, c) => s + c, 0),
    }));

  // Aggregate across all issues.
  const bySignal: Partial<Record<InterventionSignalKind, number>> = {};
  for (const issue of byIssue) {
    for (const [sig, count] of Object.entries(issue.bySignal)) {
      const k = sig as InterventionSignalKind;
      bySignal[k] = (bySignal[k] ?? 0) + count;
    }
  }
  const total = Object.values(bySignal).reduce((s, c) => s + c, 0);

  return {
    sessionId,
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    byIssue,
    bySignal,
    total,
    unobservableSignals: UNOBSERVABLE_L3_SIGNALS,
  };
}
