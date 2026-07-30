import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";
import type {
  RunLedgerEntry,
  RunLedgerEntryInput,
  RunLedgerOutcome,
  SessionControlStore,
  SessionPauseRecord,
  SessionPauseState,
} from "../core/session-control.js";

const DEFAULT_DB_PATH = join(
  homedir(),
  ".config",
  "n8n-ai-cli-loop",
  "dev_loop.db",
);

/**
 * Session pause state + per-run result ledger (issue #531), sharing the same
 * SQLite file as the task store so pausing a session and its circuit-breaker
 * evidence live in the runner-owned state store — never in GitHub labels.
 * CREATE TABLE IF NOT EXISTS keeps construction order safe regardless of which
 * store class opens the database first (same pattern as maintenance_lock in
 * sqlite-task-store.ts).
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS session_control (
  session_id   TEXT PRIMARY KEY,
  paused       INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  pause_source TEXT,
  paused_by    TEXT,
  paused_at    TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  phase         TEXT NOT NULL,
  run_id        TEXT,
  outcome       TEXT NOT NULL,
  duration_ms   INTEGER,
  agent         TEXT,
  model         TEXT,
  effort        TEXT,
  cost_usd      REAL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS run_ledger_session_idx ON run_ledger(session_id, id);
CREATE INDEX IF NOT EXISTS run_ledger_issue_phase_idx
  ON run_ledger(session_id, issue_number, phase, id);
`;

interface RawControlRow {
  session_id: string;
  paused: number;
  pause_reason: string | null;
  pause_source: string | null;
  paused_by: string | null;
  paused_at: string | null;
  updated_at: string;
}

interface RawLedgerRow {
  id: number;
  session_id: string;
  issue_number: number;
  phase: string;
  run_id: string | null;
  outcome: string;
  duration_ms: number | null;
  agent: string | null;
  model: string | null;
  effort: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

function rowToPauseRecord(row: RawControlRow): SessionPauseRecord {
  return {
    paused: true,
    ...(row.pause_reason !== null ? { reason: row.pause_reason } : {}),
    ...(row.paused_at !== null ? { pausedAt: row.paused_at } : {}),
    ...(row.paused_by !== null ? { pausedBy: row.paused_by } : {}),
    ...(row.pause_source === "operator" || row.pause_source === "circuit_breaker"
      ? { source: row.pause_source }
      : {}),
  };
}

function rowToLedgerEntry(row: RawLedgerRow): RunLedgerEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    issueNumber: row.issue_number,
    phase: row.phase as RunLedgerEntry["phase"],
    outcome: row.outcome as RunLedgerOutcome,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.agent !== null ? { agent: row.agent } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.effort !== null ? { effort: row.effort } : {}),
    ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    createdAt: row.created_at,
  };
}

const DEFAULT_RECENT_LIMIT = 50;

export class SqliteSessionControlStore implements SessionControlStore {
  readonly #db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? DEFAULT_DB_PATH;
    mkdirSync(join(resolved, ".."), { recursive: true });
    this.#db = new Database(resolved);
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  async getPauseState(sessionId: string): Promise<SessionPauseState> {
    const row = this.#db
      .prepare("SELECT * FROM session_control WHERE session_id = ?")
      .get(sessionId) as RawControlRow | undefined;
    if (!row || row.paused === 0) return { paused: false };
    return rowToPauseRecord(row);
  }

  async pauseSession(
    sessionId: string,
    options?: {
      reason?: string;
      pausedBy?: string;
      source?: "operator" | "circuit_breaker";
      now?: string;
      onlyIfUnpaused?: boolean;
    },
  ): Promise<{ changed: boolean; alreadyPaused: boolean; state: SessionPauseRecord }> {
    const now = options?.now ?? new Date().toISOString();
    // Immediate transaction so the already-paused check and the write are
    // atomic: BEGIN IMMEDIATE takes the write lock before the read, so a
    // circuit-breaker pause with `onlyIfUnpaused` racing an operator pause
    // waits (busy_timeout) instead of failing with SQLITE_BUSY_SNAPSHOT after
    // both connections read an unpaused row under a deferred begin.
    const pause = this.#db.transaction(
      (): { changed: boolean; alreadyPaused: boolean; state: SessionPauseRecord } => {
        const existing = this.#db
          .prepare("SELECT * FROM session_control WHERE session_id = ?")
          .get(sessionId) as RawControlRow | undefined;
        const alreadyPaused = existing !== undefined && existing.paused !== 0;
        if (alreadyPaused && options?.onlyIfUnpaused) {
          return { changed: false, alreadyPaused: true, state: rowToPauseRecord(existing as RawControlRow) };
        }
        this.#db
          .prepare(
            `INSERT INTO session_control (session_id, paused, pause_reason, pause_source, paused_by, paused_at, updated_at)
             VALUES (?, 1, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               paused = 1,
               pause_reason = excluded.pause_reason,
               pause_source = excluded.pause_source,
               paused_by = excluded.paused_by,
               paused_at = excluded.paused_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            sessionId,
            options?.reason ?? null,
            options?.source ?? null,
            options?.pausedBy ?? null,
            now,
            now,
          );
        const state: SessionPauseRecord = {
          paused: true,
          ...(options?.reason !== undefined ? { reason: options.reason } : {}),
          pausedAt: now,
          ...(options?.pausedBy !== undefined ? { pausedBy: options.pausedBy } : {}),
          ...(options?.source !== undefined ? { source: options.source } : {}),
        };
        return { changed: true, alreadyPaused, state };
      },
    );
    return pause.immediate();
  }

  async resumeSession(
    sessionId: string,
    options?: { now?: string },
  ): Promise<{ changed: boolean; previous?: SessionPauseRecord }> {
    const now = options?.now ?? new Date().toISOString();
    // Immediate for the same reason as pauseSession: the paused check and the
    // clearing write must not start from a deferred read snapshot.
    const resume = this.#db.transaction((): { changed: boolean; previous?: SessionPauseRecord } => {
      const existing = this.#db
        .prepare("SELECT * FROM session_control WHERE session_id = ?")
        .get(sessionId) as RawControlRow | undefined;
      if (!existing || existing.paused === 0) return { changed: false };
      this.#db
        .prepare(
          `UPDATE session_control
           SET paused = 0, pause_reason = NULL, pause_source = NULL,
               paused_by = NULL, paused_at = NULL, updated_at = ?
           WHERE session_id = ?`,
        )
        .run(now, sessionId);
      return { changed: true, previous: rowToPauseRecord(existing) };
    });
    return resume.immediate();
  }

  async recordRun(entry: RunLedgerEntryInput): Promise<RunLedgerEntry> {
    const info = this.#db
      .prepare(
        `INSERT INTO run_ledger (
           session_id, issue_number, phase, run_id, outcome, duration_ms,
           agent, model, effort, cost_usd, input_tokens, output_tokens, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.sessionId,
        entry.issueNumber,
        entry.phase,
        entry.runId ?? null,
        entry.outcome,
        entry.durationMs ?? null,
        entry.agent ?? null,
        entry.model ?? null,
        entry.effort ?? null,
        entry.costUsd ?? null,
        entry.inputTokens ?? null,
        entry.outputTokens ?? null,
        entry.createdAt,
      );
    const row = this.#db
      .prepare("SELECT * FROM run_ledger WHERE id = ?")
      .get(info.lastInsertRowid) as RawLedgerRow;
    return rowToLedgerEntry(row);
  }

  async listRecentRuns(
    sessionId: string,
    limit?: number,
    maxId?: number,
  ): Promise<RunLedgerEntry[]> {
    // `id <= maxId` gives an as-of-that-row snapshot: rows inserted by
    // concurrent runs after the anchor row carry higher ids and are excluded.
    const rows = (
      maxId !== undefined
        ? this.#db
            .prepare(
              "SELECT * FROM run_ledger WHERE session_id = ? AND id <= ? ORDER BY id DESC LIMIT ?",
            )
            .all(sessionId, maxId, limit ?? DEFAULT_RECENT_LIMIT)
        : this.#db
            .prepare(
              "SELECT * FROM run_ledger WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            )
            .all(sessionId, limit ?? DEFAULT_RECENT_LIMIT)
    ) as RawLedgerRow[];
    return rows.map(rowToLedgerEntry);
  }

  async listRecentIssuePhaseRuns(
    sessionId: string,
    issueNumber: number,
    phase: RunLedgerEntry["phase"],
    limit?: number,
    maxId?: number,
  ): Promise<RunLedgerEntry[]> {
    const rows = (
      maxId !== undefined
        ? this.#db
            .prepare(
              `SELECT * FROM run_ledger
               WHERE session_id = ? AND issue_number = ? AND phase = ? AND id <= ?
               ORDER BY id DESC LIMIT ?`,
            )
            .all(sessionId, issueNumber, phase, maxId, limit ?? DEFAULT_RECENT_LIMIT)
        : this.#db
            .prepare(
              `SELECT * FROM run_ledger
               WHERE session_id = ? AND issue_number = ? AND phase = ?
               ORDER BY id DESC LIMIT ?`,
            )
            .all(sessionId, issueNumber, phase, limit ?? DEFAULT_RECENT_LIMIT)
    ) as RawLedgerRow[];
    return rows.map(rowToLedgerEntry);
  }
}
