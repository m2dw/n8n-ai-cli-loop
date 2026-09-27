/**
 * The out-of-database ChatOps dispatch epoch witness
 * (`docs/chatops-execution-ledger-contract.md` §9.2).
 *
 * Marker evidence has one hole a provider cannot close: an administrator can
 * delete a comment, marker included. A database restore combined with a deleted
 * claim marker would make an already-dispatched comment look brand new to both
 * the ledger and the reconciler. The witness closes it without depending on the
 * provider at all — a small file under the session's `artifactRoot`, which
 * `docs/retention-backup-contract.md` §8's restore procedure replaces nothing
 * of (a restore swaps the DB file and its `-wal`/`-shm` sidecars, never the
 * artifact tree).
 *
 * The write order is database-then-witness, deliberately. A crash in the gap
 * can only leave the witness *behind*, which is benign and self-heals; the
 * dangerous direction — a database with less dispatch history than the
 * filesystem witnessed — has no benign cause, so it fences. Reversing the order
 * would make every crash indistinguishable from a restore and fence the session
 * constantly, training operators to clear fences reflexively.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";

/** Where the witness lives, relative to a session's resolved `artifactRoot`. */
export function chatOpsEpochWitnessPath(artifactRoot: string): string {
  return join(artifactRoot, "chatops", "epoch-witness.json");
}

/**
 * What a witness read produced.
 *
 * `absent` and `unreadable` are kept apart on purpose. Absent has a documented
 * benign cause (a fresh session, or a repointed `artifactRoot`) that
 * `assessChatOpsLedgerEpoch` already reasons about against `dbEpoch`. Unreadable
 * — present but corrupt or nonsensical — has none: something wrote a file this
 * code did not write, and reading that as "absent" would hand the benign branch
 * to a case that has not earned it. The caller fences instead.
 */
export type ChatOpsWitnessRead =
  | { kind: "present"; epoch: number }
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string };

interface WitnessFile {
  epoch?: unknown;
}

/** Read the witness. Never throws: an unreadable witness is a verdict, not a crash. */
export function readChatOpsEpochWitness(path: string): ChatOpsWitnessRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return { kind: "absent" };
    return {
      kind: "unreadable",
      detail: `witness could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: WitnessFile;
  try {
    parsed = JSON.parse(raw) as WitnessFile;
  } catch {
    return { kind: "unreadable", detail: "witness is not valid JSON" };
  }
  const epoch = parsed?.epoch;
  if (!Number.isInteger(epoch) || (epoch as number) < 0) {
    return { kind: "unreadable", detail: "witness carries no non-negative integer epoch" };
  }
  return { kind: "present", epoch: epoch as number };
}

/**
 * Write the witness atomically (temp file + rename), returning whether it
 * landed.
 *
 * A torn witness is worse than none: a half-written file reads as `unreadable`
 * and fences the session, so the rename is what keeps an ordinary crash during
 * the mirror write in the benign `witness-behind` branch instead.
 *
 * Never throws. A failed witness write aborts the dispatch attempt *before* any
 * external call (§9.2), which the caller handles as a routine outcome — an
 * effect whose epoch was never witnessed is an effect a future restore could
 * not detect, so it must not be allowed to happen at all.
 */
export function writeChatOpsEpochWitness(
  path: string,
  epoch: number,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(epoch) || epoch < 0) {
    return { ok: false, error: `witness epoch must be a non-negative integer, got ${epoch}` };
  }
  const temp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ epoch })}\n`, "utf8");
    renameSync(temp, path);
    return { ok: true };
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Best effort: a leftover temp file is inert (the witness itself is only
      // ever read from `path`) and must not mask the real failure below.
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
