/**
 * Retention preview, archival rollup, and prune (issue #611,
 * docs/retention-backup-contract.md §5-§9).
 *
 * Scope: `tasks`/`events` only. Outbox and context-record pruning are
 * excluded outright — the contract itself requires this (§12): outbox rows
 * have no persisted `session_id` to scope a session-level prune by (§10, the
 * migration is #13 item 3a, not implemented here), and context records have
 * no persisted association to the tasks that use them (§4), so neither can
 * be classified safely from the current schema. Every prune/preview call in
 * this store is session-scoped for exactly this reason — there is no
 * whole-file sweep here.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import type { AiTask } from "../core/task.js";
import {
  CANCELLED_RETENTION_FLOOR_MS,
  TERMINAL_RETENTION_FLOOR_MS,
  evaluateTaskRetention,
  type PruneIneligibleReason,
} from "../core/retention.js";
import { UNOBSERVABLE_L3_SIGNALS } from "../core/l3-intervention-aggregation.js";
import { listL3InterventionEntries } from "../core/l3-intervention-entries.js";
import { ARTIFACT_DIR_CONTEXT_FIELDS, isSafeArtifactDirAfterRun } from "../handlers/artifact-dir.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS retention_rollup_coverage (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           TEXT NOT NULL,
  data_class           TEXT NOT NULL,
  since                TEXT,
  until                TEXT NOT NULL,
  unobservable_signals TEXT NOT NULL,
  generated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retention_rollup_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  coverage_id     INTEGER NOT NULL REFERENCES retention_rollup_coverage(id),
  session_id      TEXT NOT NULL,
  issue_number    INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  event_timestamp TEXT,
  event_id        TEXT NOT NULL,
  source          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retention_prune_watermark (
  session_id        TEXT NOT NULL,
  data_class        TEXT NOT NULL,
  status            TEXT NOT NULL,
  last_issue_number INTEGER,
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, data_class)
);

-- §7/§8: a prune pass makes an artifact directory eligible for deletion, but
-- may not \`rmSync\` it while a currently retained backup was taken before the
-- owning row was deleted and could therefore still reference it if restored.
-- Rows here persist that gate durably so it survives a crash between DB
-- deletion and the deferred \`rmSync\`, and so a later prune pass (once the
-- referenced backup has rotated out) can find and complete it.
CREATE TABLE IF NOT EXISTS retention_pending_artifact_deletions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  dir          TEXT NOT NULL,
  backup_id    TEXT,
  requested_at TEXT NOT NULL
);

-- issue #611 review: \`issue-plan evaluate-history\` derives finality,
-- attempts, review outcomes, and difficulty from a task's raw \`tasks\`/
-- \`events\` rows. Prune deletes those rows, so before deleting them it
-- persists this per-issue snapshot durably in the same file — enough for
-- \`SqliteHistoryStore.readHistory\` (src/cli/issue-plan-history.ts) to
-- reconstruct an equivalent history when the live rows are gone. \`gh:comment\`
-- outbox rows (also read by that history) are never pruned, so they need no
-- rollup here.
CREATE TABLE IF NOT EXISTS retention_issue_history_rollup (
  session_id    TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  task_snapshot TEXT NOT NULL,
  events        TEXT NOT NULL,
  archived_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, issue_number)
);
`;

/** Table name for {@link SCHEMA}'s \`retention_issue_history_rollup\`, exported so the history reader (issue-plan-history.ts) can query it without duplicating the literal. */
export const ISSUE_HISTORY_ROLLUP_TABLE = "retention_issue_history_rollup";

const TASKS_DATA_CLASS = "tasks";

interface RawTaskRow {
  session_id: string;
  issue_number: number;
  status: string;
  phase: string;
  not_before: string | null;
  context: string;
  created_at: string;
  updated_at: string;
}

function rawToMinimalTask(row: RawTaskRow): AiTask {
  return {
    sessionId: row.session_id,
    issueNumber: row.issue_number,
    status: row.status as AiTask["status"],
    phase: row.phase as AiTask["phase"],
    priority: "normal",
    attempts: {},
    context: JSON.parse(row.context) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notBefore: row.not_before ?? undefined,
    revision: 0,
  };
}

export interface PruneCandidate {
  issueNumber: number;
  bucket: "terminal" | "cancelled";
  updatedAt: string;
  ageMs: number;
}

export interface PreviewResult {
  sessionId: string;
  now: string;
  eligible: PruneCandidate[];
  excluded: Partial<Record<PruneIneligibleReason, number>>;
  rollupCovered: boolean;
  rollupCoverageReason?: string;
}

export interface RollupGenerationResult {
  coverageId: number;
  sessionId: string;
  since?: string;
  until: string;
  entriesWritten: number;
  unobservableSignals: readonly string[];
}

export interface CoverageWindow {
  id: number;
  sessionId: string;
  since: string | null;
  until: string;
  generatedAt: string;
}

export type PruneRunStatus = "no_candidates" | "complete" | "backup_precondition_failed" | "rollup_coverage_missing";

export interface PruneRunResult {
  status: PruneRunStatus;
  sessionId: string;
  batches: number;
  tasksDeleted: number;
  eventsDeleted: number;
  artifactsDeleted: string[];
  artifactsSkipped: string[];
  /**
   * Artifact directories made eligible by this (or an earlier) run but not
   * yet removed because a currently retained backup predates their owning
   * row's deletion and could still reference them if restored (§7/§8). They
   * remain durably recorded in `retention_pending_artifact_deletions` and are
   * swept on a later prune run once that backup has rotated out.
   */
  artifactsPending: string[];
  watermark: { status: string; lastIssueNumber: number | null } | null;
  reason?: string;
}

export class SqliteRetentionStore {
  readonly #db: Database.Database;

  /**
   * `opts.readonly` (issue #611 review): `maintenance preview` must never
   * mutate the database, but the default constructor path opens read-write
   * and runs {@link SCHEMA}, which `CREATE TABLE IF NOT EXISTS`-creates five
   * `retention_*` tables on an otherwise untouched file — a side effect on a
   * command documented as read-only, and a hard failure for an operator who
   * only has read access to `dbPath`. Readonly mode opens the connection
   * read-only and skips schema initialization entirely; every read method
   * used by preview tolerates the resulting tables being absent.
   */
  constructor(dbPath: string, opts: { readonly?: boolean } = {}) {
    this.#db = new Database(dbPath, opts.readonly ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
    this.#db.pragma("busy_timeout = 5000");
    if (!opts.readonly) {
      this.#db.exec(SCHEMA);
    }
  }

  #tableExists(name: string): boolean {
    return (
      this.#db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
    );
  }

  close(): void {
    this.#db.close();
  }

  // -------------------------------------------------------------------
  // Preview (§9: preview-by-default, no mutation)
  // -------------------------------------------------------------------

  previewTaskPruneCandidates(sessionId: string, now: string = new Date().toISOString()): PreviewResult {
    const rows = this.#db
      .prepare(`SELECT * FROM tasks WHERE session_id = ? ORDER BY issue_number ASC`)
      .all(sessionId) as RawTaskRow[];

    const eligible: PruneCandidate[] = [];
    const excluded: Partial<Record<PruneIneligibleReason, number>> = {};

    for (const row of rows) {
      const task = rawToMinimalTask(row);
      const evaluation = evaluateTaskRetention(task, now);
      if (evaluation.eligible) {
        eligible.push({ issueNumber: task.issueNumber, bucket: evaluation.bucket, updatedAt: task.updatedAt, ageMs: evaluation.ageMs });
      } else {
        excluded[evaluation.reason] = (excluded[evaluation.reason] ?? 0) + 1;
      }
    }

    const coverage = this.checkRollupCoverageForCandidates(sessionId, eligible);

    return {
      sessionId,
      now,
      eligible,
      excluded,
      rollupCovered: coverage.covered,
      ...(coverage.covered ? {} : { rollupCoverageReason: coverage.reason }),
    };
  }

  // -------------------------------------------------------------------
  // Archive / rollup (§6)
  // -------------------------------------------------------------------

  /**
   * Generate an intervention rollup covering `[since, until)` (default: all
   * history up to `now`) and persist it durably in this same SQLite file —
   * never a `.n8n-artifacts/` filesystem artifact (§6). Read-only against the
   * stores it summarizes; needs no backup precondition (only prune does).
   */
  generateInterventionRollup(
    sessionId: string,
    opts: { since?: string } = {},
    now: string = new Date().toISOString(),
  ): RollupGenerationResult {
    const until = now;
    const entries = listL3InterventionEntries(this.#db, sessionId);
    const inWindow = entries.filter((e) => {
      if (opts.since !== undefined && e.eventTimestamp !== null && e.eventTimestamp < opts.since) return false;
      return true;
    });

    const insertCoverage = this.#db.prepare(
      `INSERT INTO retention_rollup_coverage (session_id, data_class, since, until, unobservable_signals, generated_at)
       VALUES (?, 'intervention', ?, ?, ?, ?)`,
    );
    const insertEntry = this.#db.prepare(
      `INSERT INTO retention_rollup_entries (coverage_id, session_id, issue_number, kind, event_timestamp, event_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const run = this.#db.transaction((): number => {
      const info = insertCoverage.run(sessionId, opts.since ?? null, until, JSON.stringify(UNOBSERVABLE_L3_SIGNALS), now);
      const coverageId = Number(info.lastInsertRowid);
      for (const e of inWindow) {
        insertEntry.run(coverageId, sessionId, e.issueNumber, e.kind, e.eventTimestamp, e.eventId, e.source);
      }
      return coverageId;
    });

    const coverageId = run.immediate();

    return {
      coverageId,
      sessionId,
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      until,
      entriesWritten: inWindow.length,
      unobservableSignals: UNOBSERVABLE_L3_SIGNALS,
    };
  }

  listRollupCoverage(sessionId: string): CoverageWindow[] {
    // Readonly/preview stores never ran `SCHEMA`, so this table may not
    // exist yet — that's equivalent to "no rollup coverage recorded", the
    // same result a freshly-schema'd but empty table would give.
    if (!this.#tableExists("retention_rollup_coverage")) return [];
    const rows = this.#db
      .prepare(
        `SELECT id, session_id, since, until, generated_at FROM retention_rollup_coverage
         WHERE session_id = ? AND data_class = 'intervention' ORDER BY generated_at DESC`,
      )
      .all(sessionId) as Array<{ id: number; session_id: string; since: string | null; until: string; generated_at: string }>;
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, since: r.since, until: r.until, generatedAt: r.generated_at }));
  }

  /**
   * §6's coverage check: a prune pass must verify a rollup's recorded
   * coverage window is a superset of the rows it is about to delete, not
   * merely that a rollup exists. Coverage is satisfied when some rollup's
   * `[since, until)` fully contains `[minTs, maxTs]`, where `minTs`/`maxTs`
   * span both the candidates' own `updated_at` values *and* the timestamps
   * of every L3 event those candidates own (issue #611 review): a
   * `--since`-limited rollup excludes any event whose `eventTimestamp`
   * predates `since` even when the owning task's `updated_at` still falls
   * inside the window, so checking `updated_at` alone would let that older
   * event be deleted with no rollup entry ever recorded for it —
   * permanently undercounting it in `admin interventions`.
   */
  checkRollupCoverageForCandidates(
    sessionId: string,
    candidates: PruneCandidate[],
  ): { covered: true } | { covered: false; reason: string } {
    if (candidates.length === 0) return { covered: true };
    const candidateIssueNumbers = new Set(candidates.map((c) => c.issueNumber));
    const timestamps = candidates.map((c) => c.updatedAt);
    for (const entry of listL3InterventionEntries(this.#db, sessionId)) {
      if (entry.eventTimestamp === null) continue;
      if (!candidateIssueNumbers.has(entry.issueNumber)) continue;
      timestamps.push(entry.eventTimestamp);
    }
    timestamps.sort();
    const minTs = timestamps[0];
    const maxTs = timestamps[timestamps.length - 1];

    const windows = this.listRollupCoverage(sessionId);
    const covering = windows.find((w) => (w.since === null || w.since <= minTs) && w.until > maxTs);
    if (!covering) {
      return {
        covered: false,
        reason:
          windows.length === 0
            ? "no intervention rollup exists for this session yet — run `admin archive rollup` first"
            : `no rollup covers the full candidate window [${minTs}, ${maxTs}] — run \`admin archive rollup\` again`,
      };
    }
    return { covered: true };
  }

  // -------------------------------------------------------------------
  // Prune (§5, §7, §9)
  // -------------------------------------------------------------------

  getWatermark(sessionId: string): { status: string; lastIssueNumber: number | null } | undefined {
    const row = this.#db
      .prepare(`SELECT status, last_issue_number FROM retention_prune_watermark WHERE session_id = ? AND data_class = ?`)
      .get(sessionId, TASKS_DATA_CLASS) as { status: string; last_issue_number: number | null } | undefined;
    return row ? { status: row.status, lastIssueNumber: row.last_issue_number } : undefined;
  }

  /**
   * Batched, resumable prune of terminal/cancelled task rows past their
   * retention floor (§5), their `events`, and their orphaned run-artifact
   * directories (§7) — for one session only. Callers are responsible for the
   * backup precondition (§8) and holding the maintenance lock (§9) for the
   * duration of this call; this method itself only re-verifies rollup
   * coverage (§6) since that check must be revalidated per batch against
   * whatever the batch is actually about to delete.
   */
  pruneTasks(
    sessionId: string,
    now: string,
    opts: {
      batchSize?: number;
      artifactRoot?: string;
      /**
       * Id of the fresh, verified backup a caller (e.g. `admin prune run`)
       * confirmed before invoking this prune (§8's precondition). Recorded
       * against every artifact directory this run makes eligible so its
       * `rmSync` can be deferred until that specific backup rotates out of
       * `retainedBackupIds`. Omit only when no backup precondition applies —
       * doing so removes the deferral gate entirely for dirs made eligible
       * by this run.
       */
      backupId?: string;
      /** Ids of every backup currently retained for this dbPath (§8), used to resolve the deferral gate above. */
      retainedBackupIds?: readonly string[];
    } = {},
  ): PruneRunResult {
    const batchSize = opts.batchSize ?? 200;
    const artifactRoot = opts.artifactRoot;

    const existingWatermark = this.getWatermark(sessionId);
    let cursor = 0;
    if (existingWatermark && existingWatermark.status === "in_progress" && existingWatermark.lastIssueNumber !== null) {
      cursor = existingWatermark.lastIssueNumber;
    } else {
      // Fresh run (no prior watermark, or the last run completed): reset so
      // rows that newly aged into eligibility since the last run are found.
      this.#db
        .prepare(`DELETE FROM retention_prune_watermark WHERE session_id = ? AND data_class = ?`)
        .run(sessionId, TASKS_DATA_CLASS);
    }

    let tasksDeleted = 0;
    let eventsDeleted = 0;
    let batches = 0;
    const artifactsDeleted: string[] = [];
    const artifactsSkipped: string[] = [];

    for (;;) {
      // issue #611 review: this SELECT must apply the exact same predicates
      // as the conditional DELETE below (including the unresolved-Tool-
      // Request exclusion), not just the status/age floor — otherwise a row
      // this SELECT includes but the DELETE would never touch still gets fed
      // into the coverage check just below, and an old, ineligible row
      // lacking coverage can block an otherwise-eligible batch from pruning
      // at all.
      const candidateIds = this.#db
        .prepare(
          `SELECT issue_number, updated_at FROM tasks
           WHERE session_id = ? AND issue_number > ?
             AND (
               (status IN ('done', 'failed') AND updated_at < ?)
               OR (status = 'cancelled' AND updated_at < ?)
             )
             AND (
               json_extract(context, '$.toolRequest') IS NULL
               OR json_extract(context, '$.toolRequest.resolved') = 1
             )
           ORDER BY issue_number ASC
           LIMIT ?`,
        )
        .all(
          sessionId,
          cursor,
          new Date(Date.parse(now) - TERMINAL_RETENTION_FLOOR_MS).toISOString(),
          new Date(Date.parse(now) - CANCELLED_RETENTION_FLOOR_MS).toISOString(),
          batchSize,
        ) as Array<{ issue_number: number; updated_at: string }>;

      if (candidateIds.length === 0) break;

      // §6: revalidate rollup coverage against exactly what this batch is
      // about to delete, not what an earlier preview observed.
      const batchCandidates: PruneCandidate[] = candidateIds.map((c) => ({
        issueNumber: c.issue_number,
        bucket: "terminal",
        updatedAt: c.updated_at,
        ageMs: 0,
      }));
      const coverage = this.checkRollupCoverageForCandidates(sessionId, batchCandidates);
      if (!coverage.covered) {
        this.#writeWatermark(sessionId, "in_progress", cursor, now);
        const sweep = this.#sweepPendingArtifactDeletions(sessionId, opts.retainedBackupIds ?? []);
        artifactsDeleted.push(...sweep.swept);
        return {
          status: "rollup_coverage_missing",
          sessionId,
          batches,
          tasksDeleted,
          eventsDeleted,
          artifactsDeleted,
          artifactsSkipped,
          artifactsPending: sweep.stillPending,
          watermark: { status: "in_progress", lastIssueNumber: cursor },
          reason: coverage.reason,
        };
      }

      const maxIssueNumber = candidateIds[candidateIds.length - 1].issue_number;
      const issueList = candidateIds.map((c) => c.issue_number);
      const placeholders = issueList.map(() => "?").join(", ");

      // Single atomic conditional DELETE re-validating every exclusion
      // predicate (status bucket, age floor, no unresolved Tool Request) at
      // commit time (§9's second compliant race-closure option) — a row
      // mutated between selection and this statement (requeued, recovered,
      // its Tool Request resolved) simply no longer matches and survives.
      const deleteTasks = this.#db.transaction((): Array<{ issue_number: number; context: string }> => {
        const deleted = this.#db
          .prepare(
            `DELETE FROM tasks
             WHERE session_id = ? AND issue_number IN (${placeholders})
               AND (
                 (status IN ('done', 'failed') AND updated_at < ?)
                 OR (status = 'cancelled' AND updated_at < ?)
               )
               AND (
                 json_extract(context, '$.toolRequest') IS NULL
                 OR json_extract(context, '$.toolRequest.resolved') = 1
               )
             RETURNING issue_number, status, phase, attempts, context, last_error, updated_at`,
          )
          .all(
            sessionId,
            ...issueList,
            new Date(Date.parse(now) - TERMINAL_RETENTION_FLOOR_MS).toISOString(),
            new Date(Date.parse(now) - CANCELLED_RETENTION_FLOOR_MS).toISOString(),
          ) as Array<{
          issue_number: number;
          status: string;
          phase: string;
          attempts: string;
          context: string;
          last_error: string | null;
          updated_at: string;
        }>;

        for (const row of deleted) {
          const eventRows = this.#db
            .prepare(`DELETE FROM events WHERE session_id = ? AND issue_number = ? RETURNING type, message, data, created_at`)
            .all(sessionId, row.issue_number) as Array<{
            type: string;
            message: string | null;
            data: string | null;
            created_at: string;
          }>;
          eventsDeleted += eventRows.length;

          // issue #611 review: persist enough of this row (and its events) to
          // reconstruct issue-plan-history's finality/attempts/review-outcome/
          // difficulty classification after it's gone — see
          // `retention_issue_history_rollup` above.
          this.#db
            .prepare(
              `INSERT INTO ${ISSUE_HISTORY_ROLLUP_TABLE} (session_id, issue_number, task_snapshot, events, archived_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (session_id, issue_number) DO UPDATE SET
                 task_snapshot = excluded.task_snapshot, events = excluded.events, archived_at = excluded.archived_at`,
            )
            .run(
              sessionId,
              row.issue_number,
              JSON.stringify({
                status: row.status,
                phase: row.phase,
                attempts: row.attempts,
                context: row.context,
                lastError: row.last_error,
                updatedAt: row.updated_at,
              }),
              JSON.stringify(
                eventRows.map((e) => ({ type: e.type, message: e.message, data: e.data, createdAt: e.created_at })),
              ),
              now,
            );
        }

        this.#writeWatermark(sessionId, "in_progress", maxIssueNumber, now);
        return deleted;
      });

      const deletedRows = deleteTasks.immediate();
      tasksDeleted += deletedRows.length;
      batches++;
      cursor = maxIssueNumber;

      if (deletedRows.length > 0) {
        const referenced = this.#collectReferencedArtifactDirs(sessionId);
        for (const row of deletedRows) {
          const dirs = this.#extractArtifactDirs(row.context);
          for (const dir of dirs) {
            if (referenced.has(dir)) {
              artifactsSkipped.push(dir);
              continue;
            }
            if (!artifactRoot || !existsSync(dir)) continue;
            if (!isSafeArtifactDirAfterRun(artifactRoot, dir)) {
              artifactsSkipped.push(dir);
              continue;
            }
            // §7/§8: the row that referenced this directory is already
            // committed-deleted, but the fresh backup taken to satisfy this
            // run's precondition (if any) predates that deletion and may
            // still reference it — defer the actual `rmSync` durably rather
            // than run it here, so it survives a crash and is only performed
            // once that backup has rotated out (see #sweepPendingArtifactDeletions).
            this.#db
              .prepare(
                `INSERT INTO retention_pending_artifact_deletions (session_id, issue_number, dir, backup_id, requested_at)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(sessionId, row.issue_number, dir, opts.backupId ?? null, now);
          }
        }
      }

      if (candidateIds.length < batchSize) break;
    }

    this.#writeWatermark(sessionId, "complete", cursor, now);

    const sweep = this.#sweepPendingArtifactDeletions(sessionId, opts.retainedBackupIds ?? []);
    artifactsDeleted.push(...sweep.swept);

    return {
      status: tasksDeleted === 0 && batches === 0 ? "no_candidates" : "complete",
      sessionId,
      batches,
      tasksDeleted,
      eventsDeleted,
      artifactsDeleted,
      artifactsSkipped,
      artifactsPending: sweep.stillPending,
      watermark: { status: "complete", lastIssueNumber: cursor },
    };
  }

  /**
   * Sweep every durably recorded pending artifact deletion for this session
   * (§7/§8). **Automatic deletion is disabled** (issue #611 review): a
   * pending row's directory was only ever checked against
   * `#collectReferencedArtifactDirs`, which reads `tasks.context` — an
   * `outbox` row can carry a run reference too, but has no queryable
   * `run_id` column today (§10/§13 item 3a), so an artifact directory a live
   * outbox row still needs can never be confirmed live by this check. Every
   * row therefore stays pending (never `rmSync`'d) until outbox references
   * are migrated/backfilled with a queryable `run_id` and folded into the
   * liveness check above — at which point this can resume performing the
   * `rmSync` it used to. `retainedBackupIds` is accepted for API
   * compatibility with callers but is unused while deletion stays disabled.
   */
  #sweepPendingArtifactDeletions(
    sessionId: string,
    _retainedBackupIds: readonly string[],
  ): { swept: string[]; stillPending: string[] } {
    const rows = this.#db
      .prepare(`SELECT dir FROM retention_pending_artifact_deletions WHERE session_id = ?`)
      .all(sessionId) as Array<{ dir: string }>;
    return { swept: [], stillPending: rows.map((r) => r.dir) };
  }

  /** Diagnostic read of every artifact directory still awaiting a backup rotation before it can be removed (§7/§8). */
  listPendingArtifactDeletions(sessionId: string): Array<{ dir: string; backupId: string | null; requestedAt: string }> {
    const rows = this.#db
      .prepare(
        `SELECT dir, backup_id, requested_at FROM retention_pending_artifact_deletions
         WHERE session_id = ? ORDER BY requested_at ASC`,
      )
      .all(sessionId) as Array<{ dir: string; backup_id: string | null; requested_at: string }>;
    return rows.map((r) => ({ dir: r.dir, backupId: r.backup_id, requestedAt: r.requested_at }));
  }

  #writeWatermark(sessionId: string, status: string, lastIssueNumber: number, now: string): void {
    this.#db
      .prepare(
        `INSERT INTO retention_prune_watermark (session_id, data_class, status, last_issue_number, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, data_class) DO UPDATE SET
           status = excluded.status, last_issue_number = excluded.last_issue_number, updated_at = excluded.updated_at`,
      )
      .run(sessionId, TASKS_DATA_CLASS, status, lastIssueNumber, now, now);
  }

  #extractArtifactDirs(contextJson: string): string[] {
    let ctx: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(contextJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ctx = parsed as Record<string, unknown>;
    } catch {
      return [];
    }
    const dirs: string[] = [];
    for (const field of ARTIFACT_DIR_CONTEXT_FIELDS) {
      const value = ctx[field];
      if (typeof value === "string" && value.length > 0) dirs.push(value);
    }
    return dirs;
  }

  #collectReferencedArtifactDirs(sessionId: string): Set<string> {
    const rows = this.#db.prepare(`SELECT context FROM tasks WHERE session_id = ?`).all(sessionId) as Array<{ context: string }>;
    const referenced = new Set<string>();
    for (const row of rows) {
      for (const dir of this.#extractArtifactDirs(row.context)) referenced.add(dir);
    }
    return referenced;
  }
}
