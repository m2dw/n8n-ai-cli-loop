import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";
import type {
  AiTask,
  ClaimNextTaskRequest,
  EnqueueTaskInput,
  StoreResult,
  TaskAttempts,
  TaskContext,
  TaskEvent,
  TaskExpected,
  TaskKey,
  TaskPatch,
  TaskPhase,
} from "../core/task.js";
import { applyTaskPatch, isClaimExpired, isRunnable, leaseExpiry, priorityRank } from "../core/transitions.js";
import { ASSIGNMENT_CONTEXT_KEY } from "../core/assignment.js";
import { hasUnresolvedToolRequest } from "../core/tool-request.js";
import type { OutboxEffect, PhaseCompletionTransition, TaskStore } from "../core/task-store.js";
import type { OutboxEnqueueInput } from "../core/outbox.js";
import { migrateOutboxTable, migrateOutboxRetryColumns } from "./outbox-migration.js";

const DEFAULT_LEASE_MS = 30 * 60 * 1000;

const DEFAULT_DB_PATH = join(
  homedir(),
  ".config",
  "n8n-ai-cli-loop",
  "dev_loop.db",
);

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS repositories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  session_id              TEXT NOT NULL,
  issue_number            INTEGER NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'queued',
  phase                   TEXT NOT NULL,
  priority                TEXT NOT NULL DEFAULT 'normal',
  implementation_agent    TEXT,
  review_agent            TEXT,
  research_agent          TEXT,
  owner_run_id            TEXT,
  lease_expires_at        TEXT,
  not_before              TEXT,
  attempts                TEXT NOT NULL DEFAULT '{}',
  context                 TEXT NOT NULL DEFAULT '{}',
  last_error              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  revision                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, issue_number)
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  worker_id   TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  type         TEXT NOT NULL,
  run_id       TEXT,
  message      TEXT,
  data         TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key   TEXT NOT NULL UNIQUE,
  topic             TEXT NOT NULL,
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  sent_at           TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TEXT,
  dead_letter_at    TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- issue #611: whole-file maintenance lock (retention/prune). Created here (not
-- only by stores/sqlite-maintenance-lock.ts) so claimNextTask can reference it
-- atomically regardless of which store class opens the connection first —
-- CREATE TABLE IF NOT EXISTS makes either construction order safe.
CREATE TABLE IF NOT EXISTS maintenance_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  holder      TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
`;

/**
 * Add the `not_before` column to an existing `tasks` table (issue #25).
 *
 * CREATE TABLE IF NOT EXISTS never alters an existing table, so a database
 * created before delayed-retry support lacks this column. Adding a nullable
 * column via ALTER TABLE is safe and idempotent-guarded by the PRAGMA probe;
 * existing rows get NULL (no delay), preserving today's claim behavior.
 */
function migrateTasksNotBefore(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table absent — SCHEMA already created it with the column
  if (cols.some((c) => c.name === "not_before")) return; // already migrated
  db.exec("ALTER TABLE tasks ADD COLUMN not_before TEXT");
}

/**
 * Add the `revision` column to an existing `tasks` table (issue #622 review,
 * P2): a monotonic write counter used as the CAS token instead of
 * `updated_at`, which can collide across writers whose clocks land in the
 * same millisecond. Existing rows default to 0, matching a freshly created
 * table.
 */
function migrateTasksRevision(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table absent — SCHEMA already created it with the column
  if (cols.some((c) => c.name === "revision")) return; // already migrated
  db.exec("ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
}

export class SqliteTaskStore implements TaskStore {
  readonly #db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? DEFAULT_DB_PATH;
    mkdirSync(join(resolved, ".."), { recursive: true });
    this.#db = new Database(resolved);
    migrateOutboxTable(this.#db);
    this.#db.exec(SCHEMA);
    migrateOutboxRetryColumns(this.#db);
    migrateTasksNotBefore(this.#db);
    migrateTasksRevision(this.#db);
  }

  close(): void {
    this.#db.close();
  }

  async enqueueTask(input: EnqueueTaskInput): Promise<StoreResult<AiTask>> {
    const now = input.now ?? new Date().toISOString();

    // IMMEDIATE prevents SQLITE_CONSTRAINT_PRIMARYKEY being thrown when two
    // connections race to enqueue the same (session_id, issue_number): the
    // second blocks on lock acquisition, then reads the already-inserted row
    // and returns already_exists cleanly.
    const enqueue = this.#db.transaction((): StoreResult<AiTask> => {
      const existing = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(input.sessionId, input.issueNumber) as RawTask | undefined;

      if (existing) {
        const existingTask = rawToTask(existing);
        // Re-enqueue dependency-held implementation tasks (issue #224). A task
        // that was blocked by an unresolved dependency lands in `blocked` status
        // at the implementation phase (not `ready_for_human`), keeping the
        // implementation-lane labels on the GitHub issue so intake can find it
        // again. When the blocker becomes stack-ready, intake calls enqueueTask
        // again; treat that as a re-activation rather than already_exists so the
        // task can proceed normally. Fresh intake context (title, labels, body,
        // dependencyDecision) is merged over the retained context.
        //
        // The same hold-and-reactivate shape applies to a conflict_resolution
        // task rejected by the report-only admission gate (issue #532 review):
        // it lands in `blocked` at the conflict_resolution phase with its
        // `status:needs-conflict-resolution` label intact, so once report-only
        // mode is disabled the next intake scan re-derives phase
        // `conflict_resolution` from that label and reactivates it here.
        if (
          existingTask.status === "blocked" &&
          (existingTask.phase === "implementation" || existingTask.phase === "conflict_resolution")
        ) {
          const freshContext = { ...existingTask.context, ...(input.context ?? {}) };
          // The assignment was pinned when the task was first created and must
          // stay immutable for the life of the task. Reactivation merges fresh
          // intake context (which carries a newly resolved assignment) over the
          // retained context, so reconcile the assignment to keep a later intake
          // pass from silently re-assigning agents after sessions.json or labels
          // changed (issue #259).
          if (existingTask.context[ASSIGNMENT_CONTEXT_KEY] !== undefined) {
            // Restore the originally pinned assignment.
            freshContext[ASSIGNMENT_CONTEXT_KEY] = existingTask.context[ASSIGNMENT_CONTEXT_KEY];
          } else {
            // Legacy task created before assignment persistence existed: it has
            // no pinned assignment, so its agent columns remain the authority.
            // Drop the freshly resolved intake assignment so agentForPhase keeps
            // following the original columns instead of preferring a new
            // context.assignment derived from the changed config.
            delete freshContext[ASSIGNMENT_CONTEXT_KEY];
          }
          this.#db
            .prepare(
              `UPDATE tasks
               SET status = 'queued', phase = ?,
                   implementation_agent = ?, review_agent = ?, research_agent = ?,
                   owner_run_id = NULL, lease_expires_at = NULL,
                   context = ?, last_error = NULL, updated_at = ?,
                   revision = revision + 1
               WHERE session_id = ? AND issue_number = ?`,
            )
            .run(
              input.phase,
              input.implementationAgent ?? existingTask.implementationAgent ?? null,
              input.reviewAgent ?? existingTask.reviewAgent ?? null,
              input.researchAgent ?? existingTask.researchAgent ?? null,
              JSON.stringify(freshContext),
              now,
              input.sessionId,
              input.issueNumber,
            );
          const updated = this.#db
            .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
            .get(input.sessionId, input.issueNumber) as RawTask;
          return { ok: true, value: rawToTask(updated), reactivated: true };
        }
        return { ok: false, code: "already_exists", current: existingTask };
      }

      this.#db
        .prepare(
          `INSERT INTO tasks
            (session_id, issue_number, status, phase, priority,
             implementation_agent, review_agent, research_agent,
             attempts, context, created_at, updated_at)
           VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          input.issueNumber,
          input.phase,
          input.priority ?? "normal",
          input.implementationAgent ?? null,
          input.reviewAgent ?? null,
          input.researchAgent ?? null,
          JSON.stringify(input.context ?? {}),
          now,
          now,
        );

      const row = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(input.sessionId, input.issueNumber) as RawTask;
      return { ok: true, value: rawToTask(row) };
    });

    return enqueue.immediate();
  }

  async getTask(key: TaskKey): Promise<AiTask | undefined> {
    const row = this.#db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
      .get(key.sessionId, key.issueNumber) as RawTask | undefined;
    return row ? rawToTask(row) : undefined;
  }

  listTasks(sessionId: string, issueNumber?: number): AiTask[] {
    if (issueNumber !== undefined) {
      const row = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(sessionId, issueNumber) as RawTask | undefined;
      return row ? [rawToTask(row)] : [];
    }
    const rows = this.#db
      .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY issue_number ASC")
      .all(sessionId) as RawTask[];
    return rows.map(rawToTask);
  }

  async claimNextTask(request: ClaimNextTaskRequest): Promise<AiTask | undefined> {
    const now = request.now ?? new Date().toISOString();
    const leaseMs = request.leaseMs ?? DEFAULT_LEASE_MS;

    // IMMEDIATE acquires the write lock before any read, so a second
    // concurrent worker blocks (up to busy_timeout) rather than reading a
    // stale snapshot and crashing with SQLITE_BUSY_SNAPSHOT.
    const claim = this.#db.transaction(() => {
      // issue #611: a held maintenance lock and a task claim are two
      // conditional operations against the same underlying SQLite file,
      // serialized by SQLite's writer lock — this check runs inside the same
      // IMMEDIATE transaction as the claim below, so it is atomic with
      // respect to a concurrent maintenance-lock acquisition rather than an
      // independently-timed pre-check (docs/retention-backup-contract.md §9).
      const lockHeld = this.#db.prepare("SELECT 1 FROM maintenance_lock WHERE id = 1").get();
      if (lockHeld) return undefined;

      const rows = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ?")
        .all(request.sessionId) as RawTask[];

      const candidate = rows
        .map(rawToTask)
        .filter((t) => isRunnable(t, now))
        .filter((t) => !request.supportedPhases || request.supportedPhases.includes(t.phase))
        // issue #677: a live (unresolved) implementation Tool Request handoff must
        // never be run through review, no matter how the row reached `queued`/
        // `review` (a stale row predating this guard, a direct DB write, a future
        // caller that forgets to route through `recoverHandoff`). Refusing the
        // claim here — before `running`/review is ever recorded — means the
        // handler-level backstop in review.ts never actually fires in production,
        // so it can never overwrite the `ready_for_human`/`implementation` handoff
        // with a synthetic `failed` result. The task simply stays put and remains
        // resolvable exactly as `admin tool-request resolve`/`grant` expect.
        .filter((t) => !(t.phase === "review" && hasUnresolvedToolRequest(t.context)))
        .sort((a, b) => {
          const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
          if (byPriority !== 0) return byPriority;
          return Date.parse(a.createdAt) - Date.parse(b.createdAt);
        })[0];

      if (!candidate) return undefined;

      const claimed = applyTaskPatch(candidate, {
        status: "claimed",
        ownerRunId: request.runId,
        leaseExpiresAt: leaseExpiry(now, leaseMs),
        now,
        context: { workerId: request.workerId },
      });

      // Clear not_before on claim: the task was eligible (its delay window has
      // passed), so the stale timestamp must not linger and re-gate a future
      // re-queue at the same phase (issue #25).
      this.#db
        .prepare(
          `UPDATE tasks
           SET status = ?, owner_run_id = ?, lease_expires_at = ?,
               not_before = NULL, context = ?, updated_at = ?, revision = ?
           WHERE session_id = ? AND issue_number = ?`,
        )
        .run(
          claimed.status,
          claimed.ownerRunId ?? null,
          claimed.leaseExpiresAt ?? null,
          JSON.stringify(claimed.context),
          claimed.updatedAt,
          claimed.revision,
          claimed.sessionId,
          claimed.issueNumber,
        );

      return claimed;
    });

    return claim.immediate();
  }

  async transitionTask(
    key: TaskKey,
    expected: TaskExpected,
    patch: TaskPatch,
  ): Promise<StoreResult<AiTask>> {
    const transition = this.#db.transaction((): StoreResult<AiTask> => {
      return this.#applyTransition(key, expected, patch);
    });

    // IMMEDIATE prevents SQLITE_BUSY_SNAPSHOT when two connections race on
    // the same row: the second blocks on lock acquisition rather than crashing
    // after reading a stale snapshot.
    return transition.immediate();
  }

  /**
   * Atomically commit a phase completion — the task transition, its
   * `phase.completed` event, and every outbox effect the completion produced —
   * in a single SQLite transaction on this store's own connection (issue #701).
   * The `outbox` table lives in this same file/connection (see SCHEMA above),
   * so no cross-connection coordination with a separate `SqliteOutboxStore` is
   * needed; a `SqliteOutboxStore` opened on the same `dbPath` simply sees these
   * rows once this transaction commits. Any failure — a CAS conflict or a
   * thrown error while writing an effect — rolls back the whole transaction,
   * so the task never transitions without its effects (or vice versa).
   */
  async completePhaseWithEffects(
    transition: PhaseCompletionTransition,
    effects: OutboxEffect[],
  ): Promise<StoreResult<AiTask>> {
    const run = this.#db.transaction((): StoreResult<AiTask> => {
      const result = this.#applyTransition(transition.key, transition.expected, transition.patch);
      if (!result.ok) return result;

      this.#insertEvent(transition.event);
      for (const effect of effects) {
        if (effect.kind === "enqueue") {
          this.#insertOutboxEnqueue(effect.input);
        } else {
          this.#insertOutboxReplacePendingPrSummary(effect.input, effect.key);
        }
      }

      return result;
    });

    return run.immediate();
  }

  #applyTransition(key: TaskKey, expected: TaskExpected, patch: TaskPatch): StoreResult<AiTask> {
    const row = this.#db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
      .get(key.sessionId, key.issueNumber) as RawTask | undefined;

    if (!row) return { ok: false, code: "not_found" };

    const current = rawToTask(row);
    if (!matchesExpected(current, expected)) {
      return { ok: false, code: "conflict", current };
    }

    const updated = applyTaskPatch(current, patch);
    this.#db
      .prepare(
        `UPDATE tasks
         SET status = ?, phase = ?, priority = ?,
             implementation_agent = ?, review_agent = ?, research_agent = ?,
             owner_run_id = ?, lease_expires_at = ?, not_before = ?,
             attempts = ?, context = ?, last_error = ?, updated_at = ?, revision = ?
         WHERE session_id = ? AND issue_number = ?`,
      )
      .run(
        updated.status,
        updated.phase,
        updated.priority,
        updated.implementationAgent ?? null,
        updated.reviewAgent ?? null,
        updated.researchAgent ?? null,
        updated.ownerRunId ?? null,
        updated.leaseExpiresAt ?? null,
        updated.notBefore ?? null,
        JSON.stringify(updated.attempts),
        JSON.stringify(updated.context),
        updated.lastError ?? null,
        updated.updatedAt,
        updated.revision,
        key.sessionId,
        key.issueNumber,
      );

    return { ok: true, value: updated };
  }

  #insertEvent(event: TaskEvent): void {
    this.#db
      .prepare(
        `INSERT INTO events (session_id, issue_number, type, run_id, message, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.task.sessionId,
        event.task.issueNumber,
        event.type,
        event.runId ?? null,
        event.message ?? null,
        event.data ? JSON.stringify(event.data) : null,
        event.createdAt,
      );
  }

  #insertOutboxEnqueue(input: OutboxEnqueueInput): void {
    const now = input.now ?? new Date().toISOString();
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO outbox (idempotency_key, topic, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.idempotencyKey, input.topic, JSON.stringify(input.payload), now);
  }

  #insertOutboxReplacePendingPrSummary(
    input: OutboxEnqueueInput,
    key: { owner: string; repo: string; prNumber: number; marker: string },
  ): void {
    const now = input.now ?? new Date().toISOString();
    // Mirrors SqliteOutboxStore.replacePendingPrSummary: insert first so a
    // duplicate idempotency key is detected before any rows are deleted, and
    // exclude dead-lettered rows (`dead_letter_at IS NULL`) from the delete so
    // exhausted-retry failure history survives a fresh summary for the same PR.
    const insertResult = this.#db
      .prepare(
        `INSERT OR IGNORE INTO outbox (idempotency_key, topic, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.idempotencyKey, input.topic, JSON.stringify(input.payload), now);
    if (insertResult.changes > 0) {
      this.#db
        .prepare(
          `DELETE FROM outbox
           WHERE topic = 'repohost:pr-summary'
             AND sent_at IS NULL
             AND dead_letter_at IS NULL
             AND idempotency_key != ?
             AND json_extract(payload, '$.owner') = ?
             AND json_extract(payload, '$.repo') = ?
             AND json_extract(payload, '$.prNumber') = ?
             AND json_extract(payload, '$.marker') = ?`,
        )
        .run(input.idempotencyKey, key.owner, key.repo, key.prNumber, key.marker);
    }
  }

  async releaseClaim(
    key: TaskKey,
    ownerRunId: string,
    now = new Date().toISOString(),
  ): Promise<StoreResult<AiTask>> {
    return this.transitionTask(
      key,
      { ownerRunId },
      { status: "queued", ownerRunId: undefined, leaseExpiresAt: undefined, now },
    );
  }

  async listSessionTasks(sessionId: string): Promise<AiTask[]> {
    const rows = this.#db
      .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY issue_number ASC")
      .all(sessionId) as RawTask[];
    return rows.map(rawToTask);
  }

  async recoverTask(
    key: TaskKey,
    options: { phase?: TaskPhase; now?: string } = {},
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();

    const recover = this.#db.transaction((): StoreResult<AiTask> => {
      const row = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(key.sessionId, key.issueNumber) as RawTask | undefined;

      if (!row) return { ok: false, code: "not_found" };

      const current = rawToTask(row);
      const RECOVERABLE: AiTask["status"][] = ["failed", "claimed", "running"];
      if (!RECOVERABLE.includes(current.status)) {
        return { ok: false, code: "conflict", current };
      }
      if (
        (current.status === "claimed" || current.status === "running") &&
        !isClaimExpired(current, now)
      ) {
        return { ok: false, code: "conflict", current };
      }

      const phase = options.phase ?? current.phase;
      this.#db
        .prepare(
          `UPDATE tasks
           SET status = 'queued', phase = ?, owner_run_id = NULL,
               lease_expires_at = NULL, last_error = NULL, updated_at = ?,
               revision = revision + 1
           WHERE session_id = ? AND issue_number = ?`,
        )
        .run(phase, now, key.sessionId, key.issueNumber);

      const updated = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(key.sessionId, key.issueNumber) as RawTask;
      return { ok: true, value: rawToTask(updated) };
    });

    return recover.immediate();
  }

  async recoverHandoff(
    key: TaskKey,
    options: { fromStatus: AiTask["status"]; phase: TaskPhase; now?: string },
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();

    const recover = this.#db.transaction((): StoreResult<AiTask> => {
      const row = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(key.sessionId, key.issueNumber) as RawTask | undefined;

      if (!row) return { ok: false, code: "not_found" };

      const current = rawToTask(row);
      if (current.status !== options.fromStatus) {
        return { ok: false, code: "conflict", current };
      }
      // issue #677: a live (unresolved) implementation Tool Request handoff must be
      // resolved through the dedicated `tool-request resolve` / `tool-request grant`
      // flows — never through this generic requeue. Those flows carry their own
      // dirty/ahead-of-origin safeguards and correctly record how the handoff was
      // closed; blindly moving the task to another phase (e.g. an operator running
      // `admin recover --from ready_for_human --phase review`) would start that
      // phase (and its branch/worktree side effects) with no PR/implementation-complete
      // handoff behind it while leaving the Tool Request itself stuck unresolved.
      if (hasUnresolvedToolRequest(current.context)) {
        return { ok: false, code: "tool_request_unresolved", current };
      }

      this.#db
        .prepare(
          `UPDATE tasks
           SET status = 'queued', phase = ?, owner_run_id = NULL,
               lease_expires_at = NULL, last_error = NULL, updated_at = ?,
               revision = revision + 1
           WHERE session_id = ? AND issue_number = ?`,
        )
        .run(options.phase, now, key.sessionId, key.issueNumber);

      const updated = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(key.sessionId, key.issueNumber) as RawTask;
      return { ok: true, value: rawToTask(updated) };
    });

    return recover.immediate();
  }

  async recoverCapHandoff(
    key: TaskKey,
    options: { phase?: TaskPhase; now?: string } = {},
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();

    const recover = this.#db.transaction((): StoreResult<AiTask> => {
      const row = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(key.sessionId, key.issueNumber) as RawTask | undefined;

      if (!row) return { ok: false, code: "not_found" };

      const current = rawToTask(row);
      if (current.status !== "ready_for_human") {
        return { ok: false, code: "conflict", current };
      }
      if (!current.context["reviewLoopCapReached"]) {
        return { ok: false, code: "conflict", current };
      }

      const phase = options.phase ?? "review";
      const { reviewLoopCapReached: _, escalatedEffort: __, ...contextWithoutCap } = current.context;
      const updatedContext = { ...contextWithoutCap, reviewCycles: 0 };

      this.#db
        .prepare(
          `UPDATE tasks
           SET status = 'queued', phase = ?, owner_run_id = NULL,
               lease_expires_at = NULL, last_error = NULL,
               context = ?, updated_at = ?, revision = revision + 1
           WHERE session_id = ? AND issue_number = ?`,
        )
        .run(phase, JSON.stringify(updatedContext), now, key.sessionId, key.issueNumber);

      const updated = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(key.sessionId, key.issueNumber) as RawTask;
      return { ok: true, value: rawToTask(updated) };
    });

    return recover.immediate();
  }

  /**
   * Clear the not_before delay on a queued task so it becomes immediately
   * eligible for the next worker run (issue #584). Refuses non-queued tasks.
   * Returns `ok: false, code: "not_found"` when no task exists, or
   * `ok: false, code: "conflict"` when the task is not queued.
   */
  async clearTaskDelay(key: TaskKey, options: { now?: string } = {}): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();

    const clear = this.#db.transaction((): StoreResult<AiTask> => {
      const row = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(key.sessionId, key.issueNumber) as RawTask | undefined;

      if (!row) return { ok: false, code: "not_found" };

      const current = rawToTask(row);
      if (current.status !== "queued") {
        return { ok: false, code: "conflict", current };
      }

      this.#db
        .prepare(
          `UPDATE tasks SET not_before = NULL, updated_at = ?, revision = revision + 1
           WHERE session_id = ? AND issue_number = ?`,
        )
        .run(now, key.sessionId, key.issueNumber);

      const updated = this.#db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
        .get(key.sessionId, key.issueNumber) as RawTask;
      return { ok: true, value: rawToTask(updated) };
    });

    return clear.immediate();
  }

  /**
   * Cancel a task (issue #608). See {@link TaskStore.cancelTask} for the full
   * contract. Wrapped in the same `IMMEDIATE` transaction pattern as
   * `claimNextTask`/`#applyTransition` so a cancellation racing a concurrent
   * claim or requeue on another connection is serialized by SQLite's write
   * lock rather than interleaved.
   */
  async cancelTask(
    key: TaskKey,
    options: { reason?: string; now?: string } = {},
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();
    const cancel = this.#db.transaction((): StoreResult<AiTask> => this.#applyCancel(key, options, now));
    return cancel.immediate();
  }

  /**
   * Atomically commit a cancellation — the transition, its `task.cancelled`
   * event, and every outbox effect it produced — in a single transaction on
   * this store's own connection (issue #608 review; mirrors
   * `completePhaseWithEffects`, issue #701). See {@link TaskStore.cancelTaskWithEffects}.
   */
  async cancelTaskWithEffects(
    key: TaskKey,
    options: { reason?: string; now?: string } = {},
    event: TaskEvent,
    effects: OutboxEffect[],
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();

    const run = this.#db.transaction((): StoreResult<AiTask> => {
      const result = this.#applyCancel(key, options, now);
      if (!result.ok) return result;

      this.#insertEvent(event);
      for (const effect of effects) {
        if (effect.kind === "enqueue") {
          this.#insertOutboxEnqueue(effect.input);
        } else {
          this.#insertOutboxReplacePendingPrSummary(effect.input, effect.key);
        }
      }

      return result;
    });

    return run.immediate();
  }

  #applyCancel(
    key: TaskKey,
    options: { reason?: string; now?: string },
    now: string,
  ): StoreResult<AiTask> {
    const row = this.#db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
      .get(key.sessionId, key.issueNumber) as RawTask | undefined;

    if (!row) return { ok: false, code: "not_found" };

    const current = rawToTask(row);
    if (current.status === "cancelled") {
      return { ok: false, code: "already_cancelled", current };
    }
    if (current.status === "done" || current.status === "failed") {
      return { ok: false, code: "conflict", current };
    }

    const updatedContext = {
      ...current.context,
      cancelledAt: now,
      ...(options.reason !== undefined ? { cancelReason: options.reason } : {}),
    };

    this.#db
      .prepare(
        `UPDATE tasks
         SET status = 'cancelled', owner_run_id = NULL, lease_expires_at = NULL,
             not_before = NULL, last_error = NULL, context = ?, updated_at = ?,
             revision = revision + 1
         WHERE session_id = ? AND issue_number = ?`,
      )
      .run(JSON.stringify(updatedContext), now, key.sessionId, key.issueNumber);

    const updated = this.#db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND issue_number = ?")
      .get(key.sessionId, key.issueNumber) as RawTask;
    return { ok: true, value: rawToTask(updated) };
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    this.#insertEvent(event);
  }

  async listEvents(key: TaskKey): Promise<TaskEvent[]> {
    const rows = this.#db
      .prepare(
        "SELECT * FROM events WHERE session_id = ? AND issue_number = ? ORDER BY id ASC",
      )
      .all(key.sessionId, key.issueNumber) as RawEvent[];
    return rows.map(rawToEvent);
  }
}

// ---------------------------------------------------------------------------
// Raw DB row types and converters
// ---------------------------------------------------------------------------

interface RawTask {
  session_id: string;
  issue_number: number;
  status: string;
  phase: string;
  priority: string;
  implementation_agent: string | null;
  review_agent: string | null;
  research_agent: string | null;
  owner_run_id: string | null;
  lease_expires_at: string | null;
  not_before: string | null;
  attempts: string;
  context: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface RawEvent {
  id: number;
  session_id: string;
  issue_number: number;
  type: string;
  run_id: string | null;
  message: string | null;
  data: string | null;
  created_at: string;
}

function rawToTask(row: RawTask): AiTask {
  return {
    sessionId: row.session_id,
    issueNumber: row.issue_number,
    status: row.status as AiTask["status"],
    phase: row.phase as AiTask["phase"],
    priority: row.priority as AiTask["priority"],
    implementationAgent: (row.implementation_agent ?? undefined) as AiTask["implementationAgent"],
    reviewAgent: (row.review_agent ?? undefined) as AiTask["reviewAgent"],
    researchAgent: (row.research_agent ?? undefined) as AiTask["researchAgent"],
    ownerRunId: row.owner_run_id ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    notBefore: row.not_before ?? undefined,
    attempts: JSON.parse(row.attempts) as TaskAttempts,
    context: JSON.parse(row.context) as TaskContext,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision ?? 0,
  };
}

function rawToEvent(row: RawEvent): TaskEvent {
  return {
    task: { sessionId: row.session_id, issueNumber: row.issue_number },
    type: row.type,
    runId: row.run_id ?? undefined,
    message: row.message ?? undefined,
    data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
  };
}

function matchesExpected(task: AiTask, expected: TaskExpected): boolean {
  return Object.entries(expected).every(
    ([field, value]) => task[field as keyof TaskExpected] === value,
  );
}
