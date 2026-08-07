/**
 * Whole-file maintenance lock (issue #611, docs/retention-backup-contract.md
 * §9). Guards prune's row-selection-through-delete-batch work — never backup,
 * which is online/concurrent-safe by design (§8) and must never contend for
 * this lock.
 *
 * State lives in the SQLite file itself (the `maintenance_lock` table, also
 * created by `stores/sqlite-task-store.ts`'s schema so construction order
 * never matters), not a sidecar file: `claimNextTask`
 * (`sqlite-task-store.ts`) checks this same table inside its own IMMEDIATE
 * transaction, which is what makes phase-start-vs-maintenance-acquisition an
 * atomic exclusion point rather than two independently-timed checks.
 */

import Database from "better-sqlite3";
import { OUTBOX_CLAIM_STALE_MS } from "../core/outbox.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS maintenance_lock (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  holder          TEXT NOT NULL,
  acquired_at     TEXT NOT NULL,
  activity_exempt INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Bring a `maintenance_lock` table created before the `activity_exempt`
 * column existed (issue #817 review) up to date. `CREATE TABLE IF NOT
 * EXISTS` never alters an existing table, and the table may equally have
 * been created by `sqlite-task-store.ts`'s own copy of this schema, so this
 * runs unconditionally alongside `SCHEMA` rather than only on a freshly
 * created table. Idempotent, same guarded `PRAGMA table_info` probe pattern
 * as `outbox-migration.ts`. Never called for a `readonly`-opened instance —
 * `status`/release-preview must stay strictly read-only.
 */
function migrateActivityExemptColumn(db: Database.Database): void {
  const probe = () => db.prepare("PRAGMA table_info(maintenance_lock)").all() as Array<{ name: string }>;
  if (probe().length === 0) return; // table doesn't exist yet — SCHEMA above handles it
  db.transaction(() => {
    const cols = probe();
    if (cols.length === 0) return;
    if (!cols.some((c) => c.name === "activity_exempt")) {
      db.exec("ALTER TABLE maintenance_lock ADD COLUMN activity_exempt INTEGER NOT NULL DEFAULT 0");
    }
  }).immediate();
}

export type AcquireMaintenanceLockResult =
  | { ok: true }
  | { ok: false; reason: "already_held"; holder: string; acquiredAt: string }
  | { ok: false; reason: "phase_active"; activeCount: number }
  | { ok: false; reason: "outbox_claim_active"; activeCount: number };

/** Read-only snapshot for `admin maintenance-lock status` (issue #817). */
export interface MaintenanceLockStatus {
  held: boolean;
  holder?: string;
  acquiredAt?: string;
  /**
   * Whether the current holder acquired with `skipActivityChecks` (e.g.
   * `admin archive rollup`) — issue #817 review. Only meaningful when
   * `held` is true. A `true` value means the two activity counts below
   * cannot be trusted as evidence this lock is stranded: this holder kind
   * is expected to show zero of both even while genuinely still running.
   * (P1 review follow-up: the same is also true of ordinary holders like
   * `prune`/`restore`, which is why `admin maintenance-lock release`
   * requires an explicit `--confirm-stranded` for every holder kind, not
   * only this one.)
   */
  activityExempt?: boolean;
  /** Timestamp the activity counts below were computed against. */
  now: string;
  /** Tasks claimed/running with a lease that has not yet expired. */
  phaseActiveCount: number;
  /** Outbox rows with a claim not yet past `OUTBOX_CLAIM_STALE_MS`. */
  outboxClaimActiveCount: number;
}

/**
 * Force-release outcome (issue #817). Ignores the recorded holder — unlike
 * {@link SqliteMaintenanceLock.release}, which only ever deletes a lock this
 * instance itself holds — but reuses the same activity predicates
 * {@link SqliteMaintenanceLock.acquire} refuses on, so a force-release can
 * never clear a lock while the work the lock protects (a live phase, a live
 * outbox dispatch claim) is still in flight.
 *
 * Passing those two predicates is never, by itself, sufficient evidence a
 * holder has actually finished (P1 review follow-up): `prune`/`restore`
 * acquire a normal, non-`activityExempt` lock and then do their own
 * destructive work — a delete batch, a file rename — without ever creating a
 * task lease or outbox claim for it, so a live one of either shows zero of
 * both counts for its entire run, indistinguishable from a genuinely
 * stranded lock. An `activityExempt` holder (`skipActivityChecks`, e.g.
 * `admin archive rollup`) shows zero of both for the same underlying reason.
 * `forceRelease` therefore requires `opts.confirmStranded` before deleting
 * *any* held lock, regardless of holder kind — not only `activityExempt`
 * ones.
 */
export type ForceReleaseMaintenanceLockResult =
  | { ok: true; released: false }
  | { ok: true; released: true; holder: string; acquiredAt: string }
  | { ok: false; reason: "phase_active"; activeCount: number }
  | { ok: false; reason: "outbox_claim_active"; activeCount: number }
  | { ok: false; reason: "confirmation_required"; holder: string; acquiredAt: string; activityExempt: boolean };

/**
 * Seed a lock row directly on an already-open connection to a database file
 * that is not live yet (issue #611 review): restore writes the operator's
 * held lock into the replacement file itself, before it is renamed into
 * place, so the moment the file becomes live it already carries this
 * invocation's lock — there is no window in which a concurrent worker could
 * observe the file as unlocked. Overwrites any lock row the backup snapshot
 * itself may have carried (e.g. one held mid-maintenance when that backup
 * was taken); this invocation's holder always wins.
 */
export function seedMaintenanceLock(db: Database.Database, holder: string, acquiredAt: string): void {
  db.exec(SCHEMA);
  migrateActivityExemptColumn(db);
  db.prepare(
    `INSERT INTO maintenance_lock (id, holder, acquired_at, activity_exempt) VALUES (1, ?, ?, 0)
     ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, activity_exempt = 0`,
  ).run(holder, acquiredAt);
}

export class SqliteMaintenanceLock {
  readonly #db: Database.Database;
  #held = false;
  #holder: string | undefined;

  /**
   * `opts.readonly` (issue #817 review) opens the underlying connection
   * read-only and skips schema creation/migration entirely — for
   * `status`/release-preview, which must never mutate or fail against a
   * legacy database (missing `maintenance_lock`, or an older version of it)
   * or a filesystem-read-only backup. Read methods below tolerate the table
   * or the `activity_exempt` column being absent. Only a non-readonly
   * instance (the default) may call `acquire`/`adopt`/`forceRelease`.
   */
  constructor(dbPath: string, opts: { readonly?: boolean } = {}) {
    this.#db = new Database(dbPath, { fileMustExist: true, readonly: opts.readonly === true });
    this.#db.pragma("busy_timeout = 5000");
    if (!opts.readonly) {
      // `CREATE TABLE IF NOT EXISTS` is a no-op write when the table already
      // exists (the normal case — also created by `SqliteTaskStore`'s
      // schema), so this never issues DDL beyond what a genuinely mutating
      // instance already needs. Deliberately does NOT run the outbox
      // migrations here (issue #817 review): a mutating instance still has
      // no reason to migrate a table it never writes to — `activityCounts`
      // below tolerates a missing `tasks`/`outbox` table or `claimed_at`
      // column instead.
      this.#db.exec(SCHEMA);
      migrateActivityExemptColumn(this.#db);
    }
  }

  close(): void {
    if (this.#held) this.release();
    this.#db.close();
  }

  /**
   * Acquire the lock, refusing while: another maintenance operation already
   * holds it; any session sharing this `dbPath` has a phase actively running
   * (a task claimed/running with a lease that has not yet expired — a stale,
   * crashed claim never blocks maintenance, matching every other lock in
   * this codebase's "recoverable, never assumed live" posture); or any
   * `outbox` row has a non-stale dispatch claim (a live claim may be
   * mid-flight on an external, irreversible side effect).
   *
   * `opts.skipActivityChecks` (issue #611 review) skips the latter two
   * checks — for callers like `admin archive rollup` that only need mutual
   * exclusion against another lock holder (namely `prune run`, so a rollup's
   * read of history can never race a concurrent delete batch) and have no
   * reason to refuse merely because an unrelated task phase or outbox claim
   * is in flight, the way `prune`/`restore` (which do mutate/replace data
   * those checks protect) still must.
   */
  acquire(
    holder: string,
    now = new Date().toISOString(),
    opts: { skipActivityChecks?: boolean } = {},
  ): AcquireMaintenanceLockResult {
    const run = this.#db.transaction((): AcquireMaintenanceLockResult => {
      const existing = this.#db
        .prepare("SELECT holder, acquired_at FROM maintenance_lock WHERE id = 1")
        .get() as { holder: string; acquired_at: string } | undefined;
      if (existing) {
        return { ok: false, reason: "already_held", holder: existing.holder, acquiredAt: existing.acquired_at };
      }

      if (!opts.skipActivityChecks) {
        const refusal = this.#activityRefusal(now);
        if (refusal) return refusal;
      }

      // Persist whether this acquisition bypassed the activity checks (issue
      // #817 review): a holder acquired this way (e.g. `admin archive
      // rollup`) is expected to show zero of both counts below even while
      // genuinely still running, so `forceRelease` cannot treat that as
      // evidence of anything for this holder — it must know which kind of
      // acquisition produced the row it is looking at.
      this.#db
        .prepare("INSERT INTO maintenance_lock (id, holder, acquired_at, activity_exempt) VALUES (1, ?, ?, ?)")
        .run(holder, now, opts.skipActivityChecks ? 1 : 0);
      return { ok: true };
    });

    const result = run.immediate();
    if (result.ok) {
      this.#held = true;
      this.#holder = holder;
    }
    return result;
  }

  /**
   * The same two activity predicates {@link acquire} refuses on, exposed
   * read-only for {@link status} and reused by {@link forceRelease} (issue
   * #817) so a force-release can never clear a lock while the work it
   * protects is still in flight. Kept in sync with `acquire`'s inline checks
   * by construction — both call this method rather than each re-deriving the
   * SQL.
   */
  activityCounts(now = new Date().toISOString()): { phaseActiveCount: number; outboxClaimActiveCount: number } {
    // No `tasks` table at all — a file opened by `SqliteOutboxStore` alone,
    // which since issue #818 creates `maintenance_lock` in its own schema so
    // its mutators can read the lock in-transaction. Such a file carries no
    // task rows, so no phase can be active in it. Tolerated for the same
    // reason as the `outbox` probe below rather than by requiring every
    // caller to have run the task-store schema first.
    const activePhase = this.#countTolerant(
      `SELECT COUNT(*) AS c FROM tasks
       WHERE status IN ('claimed', 'running')
         AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
      now,
    );

    // No `outbox` table at all, or one predating the #607 `claimed_at`
    // migration (never applied here — this class deliberately never migrates,
    // see the constructor). Either way there is no column a dispatch claim
    // could have been recorded in, so zero active claims.
    const staleBefore = new Date(Date.parse(now) - OUTBOX_CLAIM_STALE_MS).toISOString();
    const activeOutboxClaims = this.#countTolerant(
      `SELECT COUNT(*) AS c FROM outbox WHERE claimed_at IS NOT NULL AND claimed_at > ?`,
      staleBefore,
    );

    return { phaseActiveCount: activePhase, outboxClaimActiveCount: activeOutboxClaims };
  }

  /**
   * Run a `COUNT(*)` probe that reports `0` when the table or column it reads
   * is absent from this (never-migrated, possibly partially-initialised)
   * database file, and rethrows anything else. A table that does not exist
   * holds no rows, so "absent" and "zero active" are the same answer for both
   * activity predicates — and neither may fail an `acquire()`/`status()` that
   * a legacy or single-store database would otherwise have no way to run.
   */
  #countTolerant(sql: string, param: string): number {
    try {
      return (this.#db.prepare(sql).get(param) as { c: number }).c;
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (!message.includes("no such table") && !message.includes("no such column")) throw err;
      return 0;
    }
  }

  #activityRefusal(
    now: string,
  ): { ok: false; reason: "phase_active" | "outbox_claim_active"; activeCount: number } | undefined {
    const { phaseActiveCount, outboxClaimActiveCount } = this.activityCounts(now);
    if (phaseActiveCount > 0) return { ok: false, reason: "phase_active", activeCount: phaseActiveCount };
    if (outboxClaimActiveCount > 0) {
      return { ok: false, reason: "outbox_claim_active", activeCount: outboxClaimActiveCount };
    }
    return undefined;
  }

  /**
   * Read the lock row, tolerating a database this instance never migrated:
   * no `maintenance_lock` table at all (a `readonly`-opened instance against
   * a legacy database, or one with none of this schema's tables), or one
   * predating the `activity_exempt` column (issue #817 review) — in the
   * latter case `activity_exempt` defaults to `0`, which is correct: a
   * database old enough to lack the column predates every caller that could
   * have set it.
   */
  #selectLock(): { holder: string; acquired_at: string; activity_exempt: number } | undefined {
    try {
      return this.#db
        .prepare("SELECT holder, acquired_at, activity_exempt FROM maintenance_lock WHERE id = 1")
        .get() as { holder: string; acquired_at: string; activity_exempt: number } | undefined;
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (message.includes("no such table")) return undefined;
      if (!message.includes("no such column")) throw err;
      const legacy = this.#db
        .prepare("SELECT holder, acquired_at FROM maintenance_lock WHERE id = 1")
        .get() as { holder: string; acquired_at: string } | undefined;
      return legacy ? { ...legacy, activity_exempt: 0 } : undefined;
    }
  }

  /**
   * Adopt a lock row this invocation already wrote directly into the file
   * (via {@link seedMaintenanceLock}) rather than through `acquire()` —
   * e.g. restore, which seeds the lock into the replacement file before
   * renaming it into place. Verifies the row's holder still matches before
   * marking it held, so a caller that only ever calls `release()` on a
   * successfully-adopted lock can never delete a lock it does not own.
   */
  adopt(holder: string): { ok: boolean } {
    const existing = this.#db
      .prepare("SELECT holder FROM maintenance_lock WHERE id = 1")
      .get() as { holder: string } | undefined;
    if (!existing || existing.holder !== holder) return { ok: false };
    this.#held = true;
    this.#holder = holder;
    return { ok: true };
  }

  /**
   * Release only a lock this instance actually holds (issue #611 review): an
   * `acquire()`/`adopt()` that never succeeded — or a holder that no longer
   * matches what this instance last observed in the row — must never delete
   * another maintainer's lock. Safe to call unconditionally in a `finally`.
   */
  release(): void {
    if (!this.#held || this.#holder === undefined) return;
    this.#db.prepare("DELETE FROM maintenance_lock WHERE id = 1 AND holder = ?").run(this.#holder);
    this.#held = false;
    this.#holder = undefined;
  }

  inspect(): { held: boolean; holder?: string; acquiredAt?: string } {
    const existing = this.#selectLock();
    if (!existing) return { held: false };
    return { held: true, holder: existing.holder, acquiredAt: existing.acquired_at };
  }

  /**
   * Read-only status for `admin maintenance-lock status` (issue #817):
   * {@link inspect}'s holder/acquiredAt plus the same live-phase and
   * non-stale-outbox-claim counts {@link acquire} refuses acquisition on, so
   * an operator can see not just whether the lock is held but whether the
   * work it exists to protect is still genuinely in flight. Also reports
   * `activityExempt` (review follow-up) so an operator knows when those two
   * counts are not meaningful evidence for this particular holder.
   */
  status(now = new Date().toISOString()): MaintenanceLockStatus {
    const existing = this.#selectLock();
    const { phaseActiveCount, outboxClaimActiveCount } = this.activityCounts(now);
    if (!existing) return { held: false, now, phaseActiveCount, outboxClaimActiveCount };
    return {
      held: true,
      holder: existing.holder,
      acquiredAt: existing.acquired_at,
      activityExempt: existing.activity_exempt === 1,
      now,
      phaseActiveCount,
      outboxClaimActiveCount,
    };
  }

  /**
   * Force-release the lock for `admin maintenance-lock release` (issue
   * #817), ignoring the recorded holder — a stranded lock left behind by a
   * process killed before its `finally`/`close()` path has no holder able to
   * call `release()` — but reusing `acquire()`'s own activity predicates so
   * this can never clear a lock while a live phase or non-stale outbox claim
   * is still in flight (deliberately no TTL/PID-liveness check: this method
   * is the only supported recovery path, and it is always guarded by these
   * two checks plus the explicit confirmation below, never by elapsed time
   * or process liveness). A missing lock is a safe no-op (`released:
   * false`), matching {@link release}'s already-idempotent contract.
   *
   * Refuses *any* held lock unless the caller passes `opts.confirmStranded`
   * (P1 review follow-up — originally scoped to `activityExempt` holders
   * only, which left a live `prune`/`restore` lock exposed): those two
   * activity checks passing is not evidence a holder has actually finished
   * for *any* holder kind, since `prune`/`restore` do their own destructive
   * work — a delete batch, a file rename — without ever creating a task
   * lease or outbox claim for it, exactly like an `activityExempt` holder
   * (`skipActivityChecks`, e.g. `admin archive rollup`) always shows zero of
   * both regardless of whether it is still running. Without this guard
   * `release --yes` alone could delete a live maintenance holder's lock and
   * let a second `prune run --yes`/`restore` start concurrently against it.
   * `confirmStranded` is a deliberate, explicit operator override — not a
   * liveness check this method performs itself — matching the "an operator
   * running `status` first is the one positioned to judge this" posture the
   * rest of this recovery path already follows.
   */
  forceRelease(
    now = new Date().toISOString(),
    opts: { confirmStranded?: boolean } = {},
  ): ForceReleaseMaintenanceLockResult {
    const run = this.#db.transaction((): ForceReleaseMaintenanceLockResult => {
      const existing = this.#selectLock();
      if (!existing) return { ok: true, released: false };

      const refusal = this.#activityRefusal(now);
      if (refusal) return refusal;

      if (!opts.confirmStranded) {
        return {
          ok: false,
          reason: "confirmation_required",
          holder: existing.holder,
          acquiredAt: existing.acquired_at,
          activityExempt: existing.activity_exempt === 1,
        };
      }

      this.#db.prepare("DELETE FROM maintenance_lock WHERE id = 1").run();
      return { ok: true, released: true, holder: existing.holder, acquiredAt: existing.acquired_at };
    });

    const result = run.immediate();
    if (result.ok && result.released && this.#holder === result.holder) {
      this.#held = false;
      this.#holder = undefined;
    }
    return result;
  }
}
