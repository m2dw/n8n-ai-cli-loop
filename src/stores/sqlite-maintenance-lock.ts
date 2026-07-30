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
import { migrateOutboxCancelColumn, migrateOutboxClaimColumn } from "./outbox-migration.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS maintenance_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  holder      TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
`;

export type AcquireMaintenanceLockResult =
  | { ok: true }
  | { ok: false; reason: "already_held"; holder: string; acquiredAt: string }
  | { ok: false; reason: "phase_active"; activeCount: number }
  | { ok: false; reason: "outbox_claim_active"; activeCount: number };

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
  db.prepare(
    `INSERT INTO maintenance_lock (id, holder, acquired_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at`,
  ).run(holder, acquiredAt);
}

export class SqliteMaintenanceLock {
  readonly #db: Database.Database;
  #held = false;
  #holder: string | undefined;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { fileMustExist: true });
    this.#db.pragma("busy_timeout = 5000");
    this.#db.exec(SCHEMA);
    // Defensive: a DB touched only by SqliteTaskStore (never SqliteOutboxStore)
    // has an `outbox` table without `cancelled_at`/`claimed_at` — those columns
    // are added by SqliteOutboxStore's own migration chain, which may never
    // have run against this file. The outbox-claim check below needs
    // `claimed_at` to exist regardless of construction order.
    migrateOutboxCancelColumn(this.#db);
    migrateOutboxClaimColumn(this.#db);
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
        const activePhase = this.#db
          .prepare(
            `SELECT COUNT(*) AS c FROM tasks
             WHERE status IN ('claimed', 'running')
               AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
          )
          .get(now) as { c: number };
        if (activePhase.c > 0) {
          return { ok: false, reason: "phase_active", activeCount: activePhase.c };
        }

        const staleBefore = new Date(Date.parse(now) - OUTBOX_CLAIM_STALE_MS).toISOString();
        let activeOutboxClaims: { c: number };
        try {
          activeOutboxClaims = this.#db
            .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE claimed_at IS NOT NULL AND claimed_at > ?`)
            .get(staleBefore) as { c: number };
        } catch (err) {
          if (!((err as Error).message ?? "").includes("no such table")) throw err;
          activeOutboxClaims = { c: 0 };
        }
        if (activeOutboxClaims.c > 0) {
          return { ok: false, reason: "outbox_claim_active", activeCount: activeOutboxClaims.c };
        }
      }

      this.#db
        .prepare("INSERT INTO maintenance_lock (id, holder, acquired_at) VALUES (1, ?, ?)")
        .run(holder, now);
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
    const existing = this.#db
      .prepare("SELECT holder, acquired_at FROM maintenance_lock WHERE id = 1")
      .get() as { holder: string; acquired_at: string } | undefined;
    if (!existing) return { held: false };
    return { held: true, holder: existing.holder, acquiredAt: existing.acquired_at };
  }
}
