/**
 * Per-event L3 intervention entries (issue #611, docs/retention-backup-contract.md §6).
 *
 * `aggregateL3Interventions` (l3-intervention-aggregation.ts) reports totals.
 * A retention rollup needs individual, replayable records so counts survive
 * raw-row pruning — this module lists the same L3 signals at
 * `(issueNumber, kind, eventTimestamp, eventId)` granularity, and provides the
 * shared window-filter/aggregate/merge logic used both to populate a rollup
 * and to answer `admin interventions` from a mix of surviving raw rows and
 * persisted rollup rows.
 *
 * Strictly read-only; never writes to the database.
 */

import type Database from "better-sqlite3";
import type { InterventionSignalKind } from "./intervention-taxonomy.js";
import { L3_EVENT_TYPE_MAP } from "./l3-intervention-aggregation.js";
import type { IssueL3Interventions } from "./l3-intervention-aggregation.js";

export interface L3InterventionEntry {
  sessionId: string;
  issueNumber: number;
  kind: InterventionSignalKind;
  /** null = unresolved-timestamp sentinel (task-context fallback only, §6). */
  eventTimestamp: string | null;
  /** `events.id` (as text) for an event-derived entry; the task's own
   * `session_id` for a task-context-fallback entry (§6). */
  eventId: string;
  source: "event" | "task_fallback";
}

const EVENT_TYPE_SQL_LIST = Object.keys(L3_EVENT_TYPE_MAP)
  .map((t) => `'${t}'`)
  .join(", ");

function tableMissing(err: unknown): boolean {
  return ((err as Error).message ?? "").includes("no such table");
}

/**
 * List every L3 intervention entry for a session at per-event granularity —
 * unbounded (no since/until): callers apply {@link filterL3EntriesByWindow}
 * afterward so a rollup generated once can be read back correctly under any
 * later query window (§6's reconstruction rule).
 *
 * Unlike `aggregateL3Interventions`, a task-context-fallback entry is always
 * emitted for every task with `context.toolRequest.resolved === true` —
 * never suppressed here by the presence of an event-derived entry. Whether a
 * fallback entry is ultimately counted depends on the *queried window*, not
 * on whether an event exists anywhere in the task's full history (§6); that
 * decision is made by {@link aggregateL3EntriesForWindow}, not here.
 */
export function listL3InterventionEntries(
  db: Database.Database,
  sessionId: string,
  opts: { issueNumber?: number } = {},
): L3InterventionEntry[] {
  const issueFilter = opts.issueNumber ?? null;
  const entries: L3InterventionEntry[] = [];

  try {
    const rows = db
      .prepare(
        `SELECT id, issue_number, type, created_at FROM events
         WHERE session_id = ? AND type IN (${EVENT_TYPE_SQL_LIST})
           AND (? IS NULL OR issue_number = ?)
         ORDER BY issue_number ASC, id ASC`,
      )
      .all(sessionId, issueFilter, issueFilter) as Array<{
      id: number;
      issue_number: number;
      type: string;
      created_at: string;
    }>;
    for (const row of rows) {
      const kind = L3_EVENT_TYPE_MAP[row.type];
      if (!kind) continue;
      entries.push({
        sessionId,
        issueNumber: row.issue_number,
        kind,
        eventTimestamp: row.created_at,
        eventId: String(row.id),
        source: "event",
      });
    }
  } catch (err) {
    if (!tableMissing(err)) throw err;
  }

  try {
    const taskRows = db
      .prepare(
        `SELECT issue_number, context FROM tasks
         WHERE session_id = ? AND (? IS NULL OR issue_number = ?)`,
      )
      .all(sessionId, issueFilter, issueFilter) as Array<{ issue_number: number; context: string }>;

    for (const row of taskRows) {
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
      const resolved =
        toolRequest !== undefined &&
        toolRequest !== null &&
        typeof toolRequest === "object" &&
        (toolRequest as Record<string, unknown>)["resolved"] === true;
      if (!resolved) continue;

      const resolution = (toolRequest as Record<string, unknown>)["resolution"];
      const resolvedAt =
        resolution !== null &&
        resolution !== undefined &&
        typeof resolution === "object" &&
        typeof (resolution as Record<string, unknown>)["resolvedAt"] === "string"
          ? ((resolution as Record<string, unknown>)["resolvedAt"] as string)
          : typeof (toolRequest as Record<string, unknown>)["resolvedAt"] === "string"
            ? ((toolRequest as Record<string, unknown>)["resolvedAt"] as string)
            : null;

      entries.push({
        sessionId,
        issueNumber: row.issue_number,
        kind: "tool_request_resolution",
        eventTimestamp: resolvedAt,
        eventId: sessionId,
        source: "task_fallback",
      });
    }
  } catch (err) {
    if (!tableMissing(err)) throw err;
  }

  return entries;
}

/**
 * List persisted rollup entries for a session from the
 * `retention_rollup_entries` table (populated by the archive/rollup command,
 * `stores/sqlite-retention-store.ts`). Degrades to an empty list when the
 * table does not exist yet (no rollup has ever been generated).
 */
export function listRollupL3Entries(
  db: Database.Database,
  sessionId: string,
  opts: { issueNumber?: number } = {},
): L3InterventionEntry[] {
  const issueFilter = opts.issueNumber ?? null;
  try {
    const rows = db
      .prepare(
        `SELECT issue_number, kind, event_timestamp, event_id, source FROM retention_rollup_entries
         WHERE session_id = ? AND (? IS NULL OR issue_number = ?)`,
      )
      .all(sessionId, issueFilter, issueFilter) as Array<{
      issue_number: number;
      kind: string;
      event_timestamp: string | null;
      event_id: string;
      source: string;
    }>;
    return rows.map((r) => ({
      sessionId,
      issueNumber: r.issue_number,
      kind: r.kind as InterventionSignalKind,
      eventTimestamp: r.event_timestamp,
      eventId: r.event_id,
      source: r.source === "task_fallback" ? "task_fallback" : "event",
    }));
  } catch (err) {
    if (!tableMissing(err)) throw err;
    return [];
  }
}

/**
 * Merge raw (surviving) entries with persisted rollup entries, deduplicating
 * on the full `(issueNumber, kind, eventTimestamp, eventId)` tuple so a row
 * that exists in both (rollup generated before its covered window's raw rows
 * were pruned) is counted once, not twice (§6's reader-merge requirement).
 */
export function listMergedL3Entries(
  db: Database.Database,
  sessionId: string,
  opts: { issueNumber?: number } = {},
): L3InterventionEntry[] {
  const raw = listL3InterventionEntries(db, sessionId, opts);
  const rollup = listRollupL3Entries(db, sessionId, opts);
  const seen = new Set<string>();
  const merged: L3InterventionEntry[] = [];
  for (const entry of [...raw, ...rollup]) {
    const key = `${entry.issueNumber}:${entry.kind}:${entry.eventTimestamp ?? "∅"}:${entry.eventId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/**
 * Apply the same window-scoped suppression the live aggregator applies to
 * the task-context fallback: an entry with a null (unresolved) timestamp
 * only survives an unbounded query; a bounded query excludes it (§6).
 */
export function filterL3EntriesByWindow(
  entries: L3InterventionEntry[],
  since?: string,
  until?: string,
): L3InterventionEntry[] {
  if (since === undefined && until === undefined) return entries;
  const sinceIso = since !== undefined ? new Date(since).toISOString() : undefined;
  const untilIso = until !== undefined ? new Date(until).toISOString() : undefined;
  return entries.filter((e) => {
    if (e.eventTimestamp === null) return false;
    if (sinceIso !== undefined && e.eventTimestamp < sinceIso) return false;
    if (untilIso !== undefined && e.eventTimestamp >= untilIso) return false;
    return true;
  });
}

export interface L3EntryAggregationResult {
  sessionId: string;
  since?: string;
  until?: string;
  byIssue: IssueL3Interventions[];
  bySignal: Partial<Record<InterventionSignalKind, number>>;
  total: number;
}

/**
 * Filter a flat entry list to a query window and aggregate into the same
 * shape `aggregateL3Interventions` returns (minus `unobservableSignals`,
 * which callers attach from the static taxonomy list).
 *
 * Applies the §6 reconstruction rule for `tool_request_resolution`: within
 * the filtered (in-window) set, an event-derived entry for an issue always
 * wins over that issue's task-context-fallback entry, regardless of whether
 * the fallback entry also happened to survive the filter — the two represent
 * the same real-world intervention.
 */
export function aggregateL3EntriesForWindow(
  entries: L3InterventionEntry[],
  sessionId: string,
  since?: string,
  until?: string,
): L3EntryAggregationResult {
  const filtered = filterL3EntriesByWindow(entries, since, until);

  const issuesWithEventDerivedResolution = new Set(
    filtered
      .filter((e) => e.kind === "tool_request_resolution" && e.source === "event")
      .map((e) => e.issueNumber),
  );
  const deduped = filtered.filter(
    (e) =>
      !(
        e.kind === "tool_request_resolution" &&
        e.source === "task_fallback" &&
        issuesWithEventDerivedResolution.has(e.issueNumber)
      ),
  );

  const issueSignals = new Map<number, Partial<Record<InterventionSignalKind, number>>>();
  for (const e of deduped) {
    let bySig = issueSignals.get(e.issueNumber);
    if (!bySig) {
      bySig = {};
      issueSignals.set(e.issueNumber, bySig);
    }
    bySig[e.kind] = (bySig[e.kind] ?? 0) + 1;
  }

  const byIssue: IssueL3Interventions[] = Array.from(issueSignals.entries())
    .sort(([a], [b]) => a - b)
    .map(([n, bySig]) => ({
      sessionId,
      issueNumber: n,
      bySignal: bySig,
      total: Object.values(bySig).reduce((s, c) => s + c, 0),
    }));

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
    ...(since !== undefined ? { since: new Date(since).toISOString() } : {}),
    ...(until !== undefined ? { until: new Date(until).toISOString() } : {}),
    byIssue,
    bySignal,
    total,
  };
}
