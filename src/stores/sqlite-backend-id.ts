/**
 * Backend identity for SQLite-backed stores (issue #818 review follow-up).
 *
 * A task store and an outbox store opened on the SAME database file share one
 * transaction domain: a write committed through either is atomic against the
 * other, and `completePhaseWithEffects` can commit a task transition together
 * with its outbox rows. Opened on different files (or backed by memory) they
 * share nothing, and a caller holding both has no cross-store transaction to
 * lean on — it must order its writes so a failure leaves a retryable state
 * rather than a half-applied one (see `runNextPhase` in core/phase-runner.ts).
 *
 * `backendId` is how a core caller tells those two cases apart without
 * importing the store layer: equal, defined ids mean one shared backend.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Absolute, symlink-free spelling of `dbPath`.
 *
 * `resolve()` alone is not enough: two spellings of the SAME database file that
 * differ only by a symlinked component would produce different ids, and a caller
 * comparing them would wrongly conclude it holds two independent backends —
 * writing outbox rows ahead of, and independently of, the transition they belong
 * to (see the header note and `runNextPhase`).
 *
 * The file usually does not exist yet at construction time, so `realpathSync`
 * would throw: resolve the deepest ancestor that DOES exist and re-attach the
 * remaining segments literally. Any component that cannot be read (missing,
 * permission-denied, symlink loop) is left as written, which can only ever
 * over-report distinctness — the safe direction, costing a redundant
 * idempotency-keyed write rather than a lost one.
 */
function canonicalize(dbPath: string): string {
  const absolute = resolve(dbPath);
  const trailing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length === 0 ? real : join(real, ...trailing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute; // hit the root with nothing resolvable
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Stable identity of the database file `dbPath` opens, or `undefined` when the
 * connection has no shareable durable backend.
 *
 * The path is canonicalized, so any two spellings that reach the same file
 * through symlinks yield the same id.
 *
 * In-memory databases deliberately return `undefined`: every `:memory:` (or
 * anonymous `""`) connection is its OWN private database, so two stores opened
 * that way share nothing at all despite the identical path string. Reporting
 * them as shared would let a caller skip a write it still needs to make.
 * A `file::memory:` URI with a `cache=shared` parameter is genuinely shared,
 * but it is not a shape this codebase opens, so it is treated conservatively as
 * private too — the cost is a redundant, idempotency-keyed write, never a lost
 * one.
 */
export function sqliteBackendId(dbPath: string): string | undefined {
  if (dbPath === "" || dbPath === ":memory:" || dbPath.startsWith("file::memory:")) return undefined;
  return `sqlite:${canonicalize(dbPath)}`;
}
