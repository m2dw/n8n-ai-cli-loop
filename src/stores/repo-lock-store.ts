import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_LOCK_DIR = join(
  homedir(),
  ".local",
  "state",
  "n8n-ai-cli-loop",
  "locks",
);

// Conservative TTL: 24 hours. There is no heartbeat, so the TTL must exceed
// the maximum expected child workflow run time. Anything older than this is
// treated as a crashed process that will never release the lock.
const DEFAULT_STALE_TTL_MS = 24 * 60 * 60 * 1000;

// Takeover sidecars are written and deleted within a single synchronous acquire
// call. Any sidecar with a timestamp older than this is treated as an orphan
// (the owning process was killed before its finally block ran).
const SIDECAR_TTL_MS = 5 * 60 * 1000;

interface LockRecord {
  contextId: string;
  sessionId: string;
  startedAt: string;
}

interface SidecarRecord {
  startedAt: string;
}

export type AcquireResult =
  | { ok: true; locked: true; contextId: string; sessionId: string }
  | { ok: true; locked: false; reason: "lock_held"; ownerContextId: string; ownerStartedAt: string };

export type ReleaseResult =
  | { ok: true; released: true }
  | { ok: true; released: false; reason: "not_owner" | "no_lock" };

export interface InspectResult {
  locked: boolean;
  contextId: string | null;
  startedAt: string | null;
  ageMs: number | null;
  stale: boolean | null;
  lockPath: string;
}

export type ForceReleaseResult =
  | { ok: true; released: true; wasStale: boolean; ownerContextId: string }
  | { ok: true; released: false; reason: "no_lock" | "owner_mismatch"; ownerContextId?: string };

export class RepoLockStore {
  readonly #lockDir: string;
  readonly #staleTtlMs: number;

  constructor(lockDir?: string, staleTtlMs?: number) {
    this.#lockDir = lockDir ?? DEFAULT_LOCK_DIR;
    this.#staleTtlMs = staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  }

  acquire(contextId: string, sessionId: string, now = new Date().toISOString()): AcquireResult {
    mkdirSync(this.#lockDir, { recursive: true });
    const path = this.#lockPath(sessionId);
    const record: LockRecord = { contextId, sessionId, startedAt: now };
    const data = JSON.stringify(record, null, 2) + "\n";

    // Attempt atomic exclusive create. O_EXCL guarantees at most one writer wins
    // even when two processes race through an ENOENT check simultaneously.
    try {
      writeFileSync(path, data, { encoding: "utf8", flag: "wx" });
      return { ok: true, locked: true, contextId, sessionId };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // File exists — read it to check for staleness.
    let existing!: LockRecord;
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Lock vanished between exclusive-open attempt and read; retry once.
      try {
        writeFileSync(path, data, { encoding: "utf8", flag: "wx" });
        return { ok: true, locked: true, contextId, sessionId };
      } catch (retryErr: unknown) {
        if ((retryErr as NodeJS.ErrnoException).code !== "EEXIST") throw retryErr;
      }
      existing = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
    }

    const ownerAge = new Date(now).getTime() - new Date(existing.startedAt).getTime();
    if (ownerAge < this.#staleTtlMs) {
      return {
        ok: true,
        locked: false,
        reason: "lock_held",
        ownerContextId: existing.contextId,
        ownerStartedAt: existing.startedAt,
      };
    }

    // Stale lock detected. Use a per-session sidecar file to serialize recovery:
    // only one process may hold the sidecar at a time (O_EXCL), so the
    // read-verify → rmSync → writeFileSync(wx) sequence on the main lock is
    // protected from concurrent interleaving. The sidecar carries a startedAt
    // timestamp so orphaned sidecars (process killed before finally ran) can be
    // detected and recovered on the next attempt.
    const takeoverPath = path + ".takeover";
    const sidecarData = JSON.stringify({ startedAt: now } as SidecarRecord) + "\n";

    // Acquire the sidecar, recovering an orphaned one on the first attempt.
    let sidecarAcquired = false;
    try {
      writeFileSync(takeoverPath, sidecarData, { encoding: "utf8", flag: "wx" });
      sidecarAcquired = true;
    } catch (firstErr: unknown) {
      if ((firstErr as NodeJS.ErrnoException).code !== "EEXIST") throw firstErr;
      // Determine whether the existing sidecar is an orphan: no valid timestamp
      // or a timestamp older than SIDECAR_TTL_MS.
      let sidecarIsOrphan = true;
      try {
        const sidecar = JSON.parse(readFileSync(takeoverPath, "utf8")) as SidecarRecord;
        const age = new Date(now).getTime() - new Date(sidecar.startedAt).getTime();
        // Non-finite age (missing/invalid startedAt) is treated as orphaned.
        sidecarIsOrphan = !Number.isFinite(age) || age > SIDECAR_TTL_MS;
      } catch {
        // Unreadable or missing after EEXIST — treat as orphan.
      }
      if (sidecarIsOrphan) {
        // Remove the orphaned sidecar and retry once.
        try { rmSync(takeoverPath); } catch { /* ignore */ }
        try {
          writeFileSync(takeoverPath, sidecarData, { encoding: "utf8", flag: "wx" });
          sidecarAcquired = true;
        } catch (retryErr: unknown) {
          if ((retryErr as NodeJS.ErrnoException).code !== "EEXIST") throw retryErr;
          // A live process acquired the sidecar after we cleared the orphan.
        }
      }
    }

    if (!sidecarAcquired) {
      // Another process is actively recovering the stale lock; treat as held.
      return {
        ok: true,
        locked: false,
        reason: "lock_held",
        ownerContextId: existing.contextId,
        ownerStartedAt: existing.startedAt,
      };
    }

    try {
      // Under the takeover sidecar, re-read the main lock to confirm it is still
      // the same stale record; a concurrent winner may have claimed it first.
      let current: LockRecord | undefined;
      try {
        current = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // Main lock vanished between initial read and sidecar acquisition;
        // fall through to claim it directly.
      }

      if (current !== undefined) {
        if (
          current.contextId !== existing.contextId ||
          current.startedAt !== existing.startedAt
        ) {
          // A different process claimed the lock before we acquired the sidecar.
          return {
            ok: true,
            locked: false,
            reason: "lock_held",
            ownerContextId: current.contextId,
            ownerStartedAt: current.startedAt,
          };
        }
        // Same stale record confirmed; remove it before claiming.
        try {
          rmSync(path);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }

      // Write our new lock. If a contender raced through the top-level wx path
      // in the gap between stale removal and this write, catch EEXIST and treat
      // it as normal contention rather than letting it propagate as an error.
      try {
        writeFileSync(path, data, { encoding: "utf8", flag: "wx" });
        return { ok: true, locked: true, contextId, sessionId };
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // A contender acquired the lock in the gap; read its record and report.
        let winner: LockRecord;
        try {
          winner = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
        } catch {
          throw err;
        }
        return {
          ok: true,
          locked: false,
          reason: "lock_held",
          ownerContextId: winner.contextId,
          ownerStartedAt: winner.startedAt,
        };
      }
    } finally {
      try {
        rmSync(takeoverPath);
      } catch {
        // Best-effort sidecar cleanup; ignore errors.
      }
    }
  }

  peek(sessionId: string, now = new Date().toISOString()):
    | { held: true; contextId: string; startedAt: string }
    | { held: false } {
    const path = this.#lockPath(sessionId);
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
      const ownerAge = new Date(now).getTime() - new Date(record.startedAt).getTime();
      if (ownerAge < this.#staleTtlMs) {
        return { held: true, contextId: record.contextId, startedAt: record.startedAt };
      }
      return { held: false };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { held: false };
      }
      throw err;
    }
  }

  inspect(sessionId: string, now = new Date().toISOString()): InspectResult {
    const path = this.#lockPath(sessionId);
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
      const ageMs = new Date(now).getTime() - new Date(record.startedAt).getTime();
      const stale = !Number.isFinite(ageMs) || ageMs >= this.#staleTtlMs;
      return {
        locked: !stale,
        contextId: record.contextId,
        startedAt: record.startedAt,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
        stale,
        lockPath: path,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { locked: false, contextId: null, startedAt: null, ageMs: null, stale: null, lockPath: path };
      }
      throw err;
    }
  }

  forceRelease(sessionId: string, contextId?: string): ForceReleaseResult {
    const path = this.#lockPath(sessionId);
    let record: LockRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, released: false, reason: "no_lock" };
      }
      throw err;
    }

    if (contextId !== undefined && record.contextId !== contextId) {
      return { ok: true, released: false, reason: "owner_mismatch", ownerContextId: record.contextId };
    }

    // Atomically claim the file via rename before deleting, so a concurrent
    // stale-recovery or normal release/reacquire cannot replace the lock
    // between our ownership check and the rmSync.
    const tmpPath = `${path}.force-releasing.${process.pid}.${Date.now()}`;
    try {
      renameSync(path, tmpPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { ok: true, released: false, reason: "no_lock" };
    }

    let rawContent: string;
    let claimed: LockRecord;
    try {
      rawContent = readFileSync(tmpPath, "utf8");
      claimed = JSON.parse(rawContent) as LockRecord;
    } catch {
      try { rmSync(tmpPath); } catch { /* ignore */ }
      throw new Error("repo lock file is unreadable or corrupt");
    }

    if (contextId !== undefined && claimed.contextId !== contextId) {
      // Conditionally restore the displaced lock via link+unlink. linkSync
      // creates a hard link atomically and throws EEXIST if another worker
      // acquired the lock in the gap between our renameSync and now. Using
      // an unconditional rename here would overwrite the new acquirer's lock,
      // breaking the single-worker invariant.
      try {
        linkSync(tmpPath, path);
        rmSync(tmpPath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          // Another worker won the gap — discard displaced copy, preserve new lock.
          try { rmSync(tmpPath); } catch { /* ignore */ }
        } else if (code !== "ENOENT") {
          throw err;
        }
        // ENOENT: tmpPath vanished concurrently — nothing to restore.
      }
      return { ok: true, released: false, reason: "owner_mismatch", ownerContextId: claimed.contextId };
    }

    const ageMs = Date.now() - new Date(claimed.startedAt).getTime();
    const wasStale = !Number.isFinite(ageMs) || ageMs >= this.#staleTtlMs;

    rmSync(tmpPath);
    return { ok: true, released: true, wasStale, ownerContextId: claimed.contextId };
  }

  release(contextId: string, sessionId: string): ReleaseResult {
    const path = this.#lockPath(sessionId);

    // Read ownership data first, without touching the lock file. Renaming
    // before the ownership check would create a gap in the public lock path
    // that a concurrent acquire could exploit; the subsequent restore would
    // then overwrite that new owner's lock via POSIX rename semantics.
    let preview: LockRecord;
    try {
      preview = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, released: false, reason: "no_lock" };
      }
      throw new Error("repo lock file is unreadable or corrupt");
    }

    if (preview.contextId !== contextId) {
      return { ok: true, released: false, reason: "not_owner" };
    }

    // Confirmed owner. Atomically take the file via rename to prevent a
    // concurrent stale-recovery from replacing the lock between our preview
    // read and the rmSync.
    const tmpPath = `${path}.releasing.${process.pid}.${Date.now()}`;
    try {
      renameSync(path, tmpPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { ok: true, released: false, reason: "no_lock" };
    }

    let rawContent: string;
    let claimed: LockRecord;
    try {
      rawContent = readFileSync(tmpPath, "utf8");
      claimed = JSON.parse(rawContent) as LockRecord;
    } catch {
      try { rmSync(tmpPath); } catch { /* ignore */ }
      throw new Error("repo lock file is unreadable or corrupt");
    }

    if (claimed.contextId !== contextId) {
      // A stale-recovery replaced the lock between our preview read and the
      // rename. Restore using exclusive create so we never overwrite a lock
      // that a concurrent acquire wrote during the gap.
      try {
        writeFileSync(path, rawContent, { encoding: "utf8", flag: "wx" });
      } catch {
        // EEXIST: a new acquire won the gap — that lock takes priority.
      }
      try { rmSync(tmpPath); } catch { /* ignore */ }
      return { ok: true, released: false, reason: "not_owner" };
    }

    rmSync(tmpPath);
    return { ok: true, released: true };
  }

  #lockPath(sessionId: string): string {
    // Encode so IDs containing '/' or other path-special characters cannot
    // escape the lock directory via path.join traversal.
    return join(this.#lockDir, `${encodeURIComponent(sessionId)}.lock`);
  }
}
