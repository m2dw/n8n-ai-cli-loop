/**
 * Shared maintenance-lock read used by every outbox/task *mutating* path
 * (issue #818, docs/retention-backup-contract.md §9).
 *
 * The maintenance lock (`stores/sqlite-maintenance-lock.ts`) exists so a
 * `prune`/`restore` pass can select, delete, or wholesale replace rows without
 * another process moving those rows underneath it. §9 requires that exclusion
 * to be *atomic*: the lock read and the mutation it guards must be two
 * operations inside the SAME SQLite transaction on the SAME file, serialized
 * against a concurrent `acquire()` by SQLite's writer lock — not an
 * independently-timed pre-check followed by a separate write, which always
 * leaves a check-to-act gap. Every caller therefore invokes this from *inside*
 * an already-open (IMMEDIATE) transaction rather than before starting one.
 *
 * `claimNextTask` (`sqlite-task-store.ts`) has done this for phase startup
 * since issue #611; this module is the same check factored out for the outbox
 * paths issue #818 adds — enqueue, PR-summary supersede, dispatch claim,
 * operator retry/cancel — plus the transactional phase-completion/cancellation
 * enqueues (`completePhaseWithEffects` / `cancelTaskWithEffects`, issue #701).
 *
 * Deliberately NOT guarded (issue #818): `markSent` / `markFailed` /
 * `renewClaim`. Those do not start new work — they resolve or keep alive a
 * dispatch attempt that was already claimed *before* the lock was acquired,
 * whose external side effect may already have been published. Refusing them
 * would strand a claimed row (or let a concurrent dispatcher reclaim and
 * duplicate its side effect) without protecting anything: `acquire()` already
 * refuses while any non-stale claim exists, so a lock can only coexist with an
 * in-flight attempt whose claim has gone stale, and recording that attempt's
 * outcome is strictly safer than losing it.
 */

import Database from "better-sqlite3";

/**
 * Whether a maintenance lock is currently held on this connection's database
 * file. Call inside the same transaction as the mutation being guarded.
 *
 * Tolerates a database with no `maintenance_lock` table at all (returns
 * `false`): every store that calls this creates the table in its own schema,
 * so this only matters for an exotic connection that never ran either schema —
 * and a file with no lock table has no lock holder either.
 */
export function isMaintenanceLockHeld(db: Database.Database): boolean {
  try {
    return db.prepare("SELECT 1 FROM maintenance_lock WHERE id = 1").get() !== undefined;
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (!message.includes("no such table")) throw err;
    return false;
  }
}

/**
 * Thrown by an outbox mutation that a held maintenance lock refused (issue
 * #818).
 *
 * Enqueue paths throw rather than returning a falsy result because
 * `OutboxStore.enqueue` already uses `{ enqueued: false }` to mean "duplicate
 * idempotency key — safe no-op", and nearly every caller ignores the return
 * value entirely. Reusing that shape for a refusal would silently drop a real
 * side effect (a comment, a label change, a Slack notification) and report
 * success. Throwing a *typed* error instead keeps the refusal loud and
 * distinguishable: the effect is not persisted, the caller fails, and the work
 * is retried once maintenance releases the lock.
 *
 * Paths that already carry a structured refusal channel do not throw:
 * `retryEntry`/`cancelEntry` return `reason: "maintenance_locked"`,
 * `claimForDispatch` returns `false` (nothing was mutated, the row stays
 * pending), and `completePhaseWithEffects`/`cancelTaskWithEffects` return
 * `{ ok: false, code: "maintenance_locked" }`.
 */
export class MaintenanceLockedError extends Error {
  /** Stable, machine-readable discriminator for CLI/JSON outcome mapping. */
  readonly code = "maintenance_locked" as const;

  constructor(operation: string) {
    super(
      `Refusing ${operation}: a maintenance lock is held on this database ` +
        `(see \`admin maintenance-lock status\`); retry once maintenance releases it.`,
    );
    this.name = "MaintenanceLockedError";
  }
}
