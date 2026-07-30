/**
 * SQLite online backup and restore (issue #611, docs/retention-backup-contract.md §8).
 *
 * Backup uses `better-sqlite3`'s Backup API (`db.backup(path)`), never
 * `VACUUM INTO` — only the Backup API supports the same-transaction,
 * same-snapshot verification sequence §8 requires: a deferred read
 * transaction on the source connection issues the row-count read first, then
 * the backup as the next statement on that same transaction, so SQLite's
 * snapshot isolation guarantees the count and the backup describe the
 * identical database state under concurrent writers.
 */

import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import {
  ARTIFACT_DIR_CONTEXT_FIELDS,
  ARTIFACT_DIR_PENDING_CONTEXT_FIELD,
  isSafeArtifactDirAfterRun,
} from "../handlers/artifact-dir.js";
import { seedMaintenanceLock } from "./sqlite-maintenance-lock.js";

export const DEFAULT_BACKUP_DIR = join(homedir(), ".config", "n8n-ai-cli-loop", "backups");

/** §8: at least the 3 most recent verified backups per dbPath are retained. */
export const BACKUP_RETENTION_FLOOR = 3;

export interface BackupManifestEntry {
  id: string;
  dbPath: string;
  backupPath: string;
  createdAt: string;
  verified: true;
  taskCount: number;
  sizeBytes: number;
  /**
   * §8/issue #611 review: the set of holder tokens currently relying on this
   * backup as a `prune run`'s recovery point. Backup creation deliberately
   * never takes the maintenance lock (§11 — backups must be takeable
   * concurrently with normal operation), so ordinary rotation could otherwise
   * remove the very backup a concurrently-running prune is relying on,
   * leaving no usable recovery point for rows the prune already deleted
   * before that rotation happened. An entry with a non-empty `pinnedBy` is
   * never selected for rotation regardless of age/count, no matter how many
   * newer backups are created while it's held.
   *
   * Refcounted by holder rather than a single boolean (issue #611 review,
   * second pass): two `prune run` invocations can both select the same fresh
   * backup and both pin it before one of them loses the maintenance-lock
   * race. If pinning were a plain boolean, the loser's unconditional unpin in
   * its `finally` would clear the pin out from under the winner, which is
   * still mid-prune and still relying on it. Each holder only ever removes
   * its own token, so the entry stays pinned as long as any holder needs it.
   */
  pinnedBy?: string[];
}

interface Manifest {
  entries: BackupManifestEntry[];
}

function manifestPath(backupDir: string): string {
  return join(backupDir, "manifest.json");
}

function readManifest(backupDir: string): Manifest {
  const p = manifestPath(backupDir);
  if (!existsSync(p)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Manifest;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

/** Atomic (write-tmp-then-rename) so a concurrent reader never observes a partial write. */
function writeManifest(backupDir: string, manifest: Manifest): void {
  const p = manifestPath(backupDir);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, p);
}

const MANIFEST_LOCK_STALE_MS = 30_000;
const MANIFEST_LOCK_RETRY_MS = 50;
const MANIFEST_LOCK_TIMEOUT_MS = 10_000;

function manifestLockPath(backupDir: string): string {
  return join(backupDir, "manifest.lock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Interprocess mutual exclusion around a read-modify-write of the backup
 * manifest (issue #611 review): two `createBackup` calls sharing a
 * `backupDir` can otherwise both read the same manifest, append their own
 * entry, and write it back, with the second writer's `writeFileSync`
 * silently discarding the first writer's entry. Uses the same atomic
 * O_EXCL-create lock-file primitive as `stores/repo-lock-store.ts`, scoped
 * to just this manifest so it never contends with any other lock in the
 * process. A lock file older than `MANIFEST_LOCK_STALE_MS` is assumed to be
 * left behind by a crashed holder and is reclaimed rather than blocking
 * forever.
 */
async function withManifestLock<T>(backupDir: string, fn: () => T): Promise<T> {
  const lockPath = manifestLockPath(backupDir);
  const deadline = Date.now() + MANIFEST_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let staleReclaimed = false;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > MANIFEST_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          staleReclaimed = true;
        }
      } catch {
        // Lock file vanished between the EEXIST and this stat (the holder
        // released it) — fall through and retry immediately.
        staleReclaimed = true;
      }
      if (staleReclaimed) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for backup manifest lock at ${lockPath}`);
      }
      await sleep(MANIFEST_LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * §11: refuse to start rather than fail midway when free space at the
 * destination is insufficient. Sized off `(dbPath + dbPath-wal) * 1.5` since
 * an uncheckpointed WAL sidecar can hold pages not yet folded into the main
 * file, checked against the filesystem that will actually receive the bytes
 * (the backup destination), not `dbPath`'s filesystem. Best-effort: Node's
 * `fs.statfsSync` is feature-detected, and a failed probe never blocks a
 * backup — only a confirmed shortfall does.
 */
function checkBackupDiskSpace(dbPath: string, destDir: string): { ok: true } | { ok: false; error: string } {
  // Feature-detected: fs.statfsSync landed in Node 18.15/19.6. A Node version
  // without it means this check is simply unavailable — best-effort only, so
  // absence never blocks a backup, only a confirmed shortfall does.
  if (typeof statfsSync !== "function") return { ok: true };
  try {
    const dbSize = existsSync(dbPath) ? statSync(dbPath).size : 0;
    const walPath = `${dbPath}-wal`;
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    const needed = (dbSize + walSize) * 1.5;
    const stat = statfsSync(destDir);
    const available = Number(stat.bavail) * Number(stat.bsize);
    if (available < needed) {
      return {
        ok: false,
        error: `Insufficient free space for backup at ${destDir}: need ~${Math.ceil(needed / 1e6)}MB, have ~${Math.floor(available / 1e6)}MB free`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/**
 * Re-verify a manifest entry against the backup file it points at (§8): the
 * manifest only records that a backup passed verification at creation time,
 * not that the file is still present or still intact. A caller that trusts
 * `verified: true` alone (e.g. a prune precondition gate) can be fooled by a
 * since-deleted or since-corrupted backup file, so anything that treats a
 * manifest entry as "a usable recovery point exists" must call this first.
 */
export function verifyBackupEntry(entry: BackupManifestEntry): { ok: true } | { ok: false; error: string } {
  if (!existsSync(entry.backupPath)) {
    return { ok: false, error: `Backup file missing on disk: ${entry.backupPath}` };
  }
  return verifyBackupFile(entry.backupPath, entry.taskCount);
}

function verifyBackupFile(path: string, expectedTaskCount: number): { ok: true } | { ok: false; error: string } {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { ok: false, error: `Backup file could not be opened: ${(err as Error).message}` };
  }
  try {
    const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const integrityOk = integrity.length === 1 && integrity[0].integrity_check === "ok";
    if (!integrityOk) {
      return { ok: false, error: `Backup failed PRAGMA integrity_check: ${JSON.stringify(integrity)}` };
    }
    const row = db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
    if (row.c !== expectedTaskCount) {
      return {
        ok: false,
        error: `Backup task-row count mismatch: source snapshot had ${expectedTaskCount}, backup has ${row.c}`,
      };
    }
    return { ok: true };
  } finally {
    db.close();
  }
}

/**
 * dbPath-scoped: never rotates a verified backup for a different dbPath.
 * Pinned entries (see {@link BackupManifestEntry.pinnedBy}) are always
 * retained and never counted as rotation candidates — only the remaining
 * unpinned entries are trimmed down to the retention floor, reduced by
 * however many pinned entries already exist so total retained count stays
 * meaningful.
 */
function rotateEntries(
  entries: BackupManifestEntry[],
  dbPath: string,
): { retained: BackupManifestEntry[]; rotatedOut: BackupManifestEntry[] } {
  const forThisDb = entries
    .filter((e) => e.dbPath === dbPath)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const others = entries.filter((e) => e.dbPath !== dbPath);
  const pinned = forThisDb.filter((e) => e.pinnedBy && e.pinnedBy.length > 0);
  const unpinned = forThisDb.filter((e) => !e.pinnedBy || e.pinnedBy.length === 0);
  const keepCount = Math.max(0, BACKUP_RETENTION_FLOOR - pinned.length);
  if (unpinned.length <= keepCount) {
    return { retained: entries, rotatedOut: [] };
  }
  const rotatedOut = unpinned.slice(0, unpinned.length - keepCount);
  const keptUnpinned = unpinned.slice(unpinned.length - keepCount);
  return { retained: [...others, ...pinned, ...keptUnpinned], rotatedOut };
}

/**
 * Pin a verified backup so ordinary rotation (§8, `rotateEntries` above)
 * cannot remove it while it's in use as a `prune run`'s recovery point
 * (issue #611 review) — see {@link BackupManifestEntry.pinnedBy}.
 * `holder` must be a token unique to this specific run (e.g.
 * `prune:<pid>:<random>`); passing the same holder twice is idempotent, but
 * two different runs pinning the same backup each get their own entry in
 * `pinnedBy`, so one run's {@link unpinBackup} can never release the other's
 * pin.
 */
export async function pinBackup(
  dbPath: string,
  backupId: string,
  holder: string,
  backupDir: string = DEFAULT_BACKUP_DIR,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withManifestLock(backupDir, () => {
    const manifest = readManifest(backupDir);
    const entry = manifest.entries.find((e) => e.id === backupId && e.dbPath === dbPath);
    if (!entry) return { ok: false, error: `Unknown backup id "${backupId}" for ${dbPath}` };
    const holders = entry.pinnedBy ?? [];
    if (!holders.includes(holder)) {
      entry.pinnedBy = [...holders, holder];
      writeManifest(backupDir, manifest);
    }
    return { ok: true };
  });
}

/**
 * Release the pin taken by {@link pinBackup} for this specific `holder`.
 * Always call this from a `finally` around the pinned run, passing the same
 * holder token used to pin it — the entry stays pinned as long as any other
 * holder still references it. An unpinned-but-abandoned holder token simply
 * never rotates out until the next `createBackup` call notices it's stale,
 * so leaking one is safe but should still be avoided.
 */
export async function unpinBackup(
  dbPath: string,
  backupId: string,
  holder: string,
  backupDir: string = DEFAULT_BACKUP_DIR,
): Promise<void> {
  await withManifestLock(backupDir, () => {
    const manifest = readManifest(backupDir);
    const entry = manifest.entries.find((e) => e.id === backupId && e.dbPath === dbPath);
    if (entry?.pinnedBy?.includes(holder)) {
      const remaining = entry.pinnedBy.filter((h) => h !== holder);
      if (remaining.length > 0) {
        entry.pinnedBy = remaining;
      } else {
        delete entry.pinnedBy;
      }
      writeManifest(backupDir, manifest);
    }
  });
}

export interface CreateBackupResult {
  ok: boolean;
  entry?: BackupManifestEntry;
  error?: string;
  rotatedOut?: string[];
}

/**
 * Derive a collision-resistant id/path and claim it under the manifest lock
 * (issue #611 review, second pass): a plain `now`-derived id lets two
 * `createBackup` calls that start within the same millisecond compute the
 * identical id and `backupPath`, so both append manifest entries pointing at
 * one physical file — rotation can then unlink that shared file while
 * selecting one of the (possibly pinned) duplicate entries, silently
 * dropping the actual verified-backup count below the retention floor. The
 * random suffix makes a genuine id collision negligible, and reserving the
 * path (touching an empty placeholder file) while holding the manifest lock
 * closes the remaining window between choosing the id and either process
 * writing to it.
 */
function reserveBackupId(dbPath: string, backupDir: string, now: string): Promise<{ id: string; backupPath: string }> {
  return withManifestLock(backupDir, () => {
    for (;;) {
      const id = `${now.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
      const backupPath = join(backupDir, `${basename(dbPath)}.${id}.backup`);
      if (existsSync(backupPath)) continue;
      writeFileSync(backupPath, "");
      return { id, backupPath };
    }
  });
}

export async function createBackup(
  dbPath: string,
  backupDir: string = DEFAULT_BACKUP_DIR,
  now: string = new Date().toISOString(),
): Promise<CreateBackupResult> {
  if (!existsSync(dbPath)) return { ok: false, error: `Database file not found: ${dbPath}` };
  mkdirSync(backupDir, { recursive: true });

  const spaceCheck = checkBackupDiskSpace(dbPath, backupDir);
  if (!spaceCheck.ok) return { ok: false, error: spaceCheck.error };

  const { id, backupPath } = await reserveBackupId(dbPath, backupDir, now);

  const srcDb = new Database(dbPath, { fileMustExist: true });
  let taskCount = 0;
  try {
    srcDb.pragma("busy_timeout = 5000");
    srcDb.exec("BEGIN DEFERRED");
    try {
      const row = srcDb.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
      taskCount = row.c;
      // Next statement on the same open transaction: the Backup API reads
      // from this connection's current snapshot, so the count above and the
      // backup describe the identical database state (§8).
      await srcDb.backup(backupPath);
      srcDb.exec("COMMIT");
    } catch (err) {
      try {
        srcDb.exec("ROLLBACK");
      } catch {
        // best-effort
      }
      throw err;
    }
  } catch (err) {
    srcDb.close();
    try {
      rmSync(backupPath, { force: true });
    } catch {
      // best-effort cleanup of a partial/failed backup file
    }
    return { ok: false, error: `Backup failed: ${(err as Error).message}` };
  }
  srcDb.close();

  const verify = verifyBackupFile(backupPath, taskCount);
  if (!verify.ok) {
    try {
      rmSync(backupPath, { force: true });
    } catch {
      // best-effort
    }
    return { ok: false, error: verify.error };
  }

  const entry: BackupManifestEntry = {
    id,
    dbPath,
    backupPath,
    createdAt: now,
    verified: true,
    taskCount,
    sizeBytes: statSync(backupPath).size,
  };

  const { rotatedOut } = await withManifestLock(backupDir, () => {
    const manifest = readManifest(backupDir);
    manifest.entries.push(entry);
    const rotated = rotateEntries(manifest.entries, dbPath);
    manifest.entries = rotated.retained;
    writeManifest(backupDir, manifest);
    return rotated;
  });

  for (const stale of rotatedOut) {
    try {
      rmSync(stale.backupPath, { force: true });
    } catch {
      // best-effort
    }
  }

  return { ok: true, entry, rotatedOut: rotatedOut.map((e) => e.backupPath) };
}

export function listBackups(dbPath: string, backupDir: string = DEFAULT_BACKUP_DIR): BackupManifestEntry[] {
  return readManifest(backupDir)
    .entries.filter((e) => e.dbPath === dbPath)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface RestoreResult {
  ok: boolean;
  error?: string;
  restoredFrom?: string;
  preRestorePath?: string;
}

/**
 * Validate every artifact-directory context field referenced by the
 * restored snapshot's task rows against `artifactRoot` (§8 point 5, issue
 * #611 review), directly on the not-yet-live temporary DB connection. A
 * field that is missing, or that no longer resolves to a real,
 * non-symlinked directory inside `artifactRoot`, means completing this
 * restore would resurrect a task row pointing at an artifact that was since
 * deleted or redirected — so restore must fail before the replacement file
 * is ever renamed into place, not after.
 *
 * This is a scoped, interim check: the contract's full point-5 design keys
 * validation off a durable `session_id -> artifactRoot` mapping (that part
 * does not exist yet — separate, larger follow-up surface). It does,
 * however, honor `ARTIFACT_DIR_PENDING_CONTEXT_FIELD` (issue #611 review):
 * a handler sets that marker on `artifactDir` whenever it returns before
 * ever reaching its own `mkdirSync`/`isSafeArtifactDirAfterRun` sequence
 * (admission, repo-host-resolve, or agent-assignment failures), so a
 * present-but-never-created `artifactDir` no longer fails this check —
 * only a field that names a real path the handler actually reached
 * creation for, and that path is now missing or unsafe, does. Only runs
 * when a caller supplies `artifactRoot`; omitting it preserves this
 * function's pre-existing behavior of restoring without an
 * artifact-consistency check.
 *
 * `artifactRoot` is resolved for a single session (or supplied directly by
 * the caller with no session in mind at all), never for the whole database.
 * A shared database can hold multiple sessions that each use a different
 * artifact root, so when `sessionId` is given this only validates that
 * session's rows against `artifactRoot` — otherwise a session-B row with a
 * perfectly valid artifactDir under session B's own root would be checked
 * against session A's root and rejected (issue #611 review). Omitting
 * `sessionId` preserves the pre-existing all-rows behavior for callers that
 * pass an explicit `--artifact-root` with no session in mind.
 */
function validateRestoredArtifactReferences(
  tmpDb: Database.Database,
  artifactRoot: string,
  sessionId?: string,
): { ok: true } | { ok: false; error: string } {
  const tableExists =
    tmpDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() !== undefined;
  if (!tableExists) return { ok: true };

  const rows = (
    sessionId !== undefined
      ? tmpDb.prepare("SELECT issue_number, context FROM tasks WHERE session_id = ?").all(sessionId)
      : tmpDb.prepare("SELECT issue_number, context FROM tasks").all()
  ) as Array<{
    issue_number: number;
    context: string;
  }>;
  for (const row of rows) {
    let ctx: unknown;
    try {
      ctx = JSON.parse(row.context);
    } catch {
      continue;
    }
    if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) continue;
    const ctxObj = ctx as Record<string, unknown>;
    for (const field of ARTIFACT_DIR_CONTEXT_FIELDS) {
      const dir = ctxObj[field];
      if (typeof dir !== "string" || dir.length === 0) continue;
      if (field === "artifactDir" && ctxObj[ARTIFACT_DIR_PENDING_CONTEXT_FIELD] === true) continue;
      if (!isSafeArtifactDirAfterRun(artifactRoot, dir)) {
        return {
          ok: false,
          error:
            `Restore aborted: task #${row.issue_number}'s ${field} ("${dir}") is missing, or is no longer a ` +
            `real directory inside artifactRoot ${artifactRoot} — restoring this snapshot would resurrect a ` +
            "dangling artifact reference.",
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Restore `dbPath` from a previously verified backup (§8). Callers must hold
 * the maintenance lock (`SqliteMaintenanceLock`) for the duration of this
 * call — restore never acquires it itself, since it needs to run after the
 * caller has re-verified quiescence under that same lock.
 *
 * Never opens the backup file for writing: a fresh copy is made to
 * `<dbPath>.restore-tmp` and every subsequent step operates on that copy.
 * The live `dbPath` is preserved under a `.pre-restore-<timestamp>` suffix
 * rather than deleted, so a failed restore is recoverable by hand — but it
 * is preserved with a hard link, not a rename (issue #611 review): renaming
 * `dbPath` away first, then renaming the replacement in, leaves a window
 * where `dbPath` does not exist on disk at all, and a process that opens it
 * during that window (e.g. `SqliteTaskStore`'s constructor) creates a brand
 * new empty database there instead of failing, silently discarding any
 * concurrent enqueue/outbox write. Linking `preRestorePath` to the same
 * inode keeps `dbPath` addressable the whole time; the final `renameSync`
 * then replaces its content atomically in one filesystem operation, so
 * `dbPath` only ever resolves to the pre-restore content or the restored
 * content, never to nothing. The `-wal`/`-shm` sidecars, if present, are
 * still moved aside with a plain rename — a later connection re-opening
 * `dbPath` mid-swap must not replay them against the wrong generation of
 * the file, and (unlike the main path) their absence never causes a fresh
 * database to be created. If any step in that swap fails partway through,
 * everything already moved is rolled back before returning, so `dbPath` is
 * never left absent or pointing at half-applied state.
 */
export async function restoreBackup(
  dbPath: string,
  backupId: string,
  backupDir: string = DEFAULT_BACKUP_DIR,
  now: string = new Date().toISOString(),
  opts: {
    carryLock?: { holder: string; acquiredAt: string };
    artifactRoot?: string;
    artifactRootSessionId?: string;
  } = {},
): Promise<RestoreResult> {
  const manifest = readManifest(backupDir);
  const entry = manifest.entries.find((e) => e.id === backupId && e.dbPath === dbPath);
  if (!entry) return { ok: false, error: `Unknown backup id "${backupId}" for ${dbPath}` };

  const verify = verifyBackupEntry(entry);
  if (!verify.ok) return { ok: false, error: `Backup failed re-verification before restore: ${verify.error}` };

  const tmpPath = `${dbPath}.restore-tmp`;
  copyFileSync(entry.backupPath, tmpPath);

  // Force the replacement out of WAL mode so a bare rename below can never
  // leave a `-wal`/`-shm` sidecar for a later connection to (mis)replay (§8
  // item 3). While this connection is open, also (a) seed the caller's held
  // maintenance lock into the replacement file so the live file is never
  // without it (issue #611 review), and (b) validate artifact-directory
  // references — both must happen before the file is renamed into place.
  const tmpDb = new Database(tmpPath);
  let artifactCheckError: string | undefined;
  try {
    tmpDb.pragma("journal_mode = DELETE");
    if (opts.carryLock) {
      seedMaintenanceLock(tmpDb, opts.carryLock.holder, opts.carryLock.acquiredAt);
    }
    if (opts.artifactRoot) {
      const check = validateRestoredArtifactReferences(tmpDb, opts.artifactRoot, opts.artifactRootSessionId);
      if (!check.ok) artifactCheckError = check.error;
    }
  } finally {
    tmpDb.close();
  }

  if (artifactCheckError) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup of the rejected temporary file
    }
    return { ok: false, error: artifactCheckError };
  }

  const suffix = now.replace(/[:.]/g, "-");
  let preRestorePath: string | undefined;
  let linkedPreRestore = false;
  const movedSidecars: Array<{ from: string; to: string }> = [];
  try {
    if (existsSync(dbPath)) {
      preRestorePath = `${dbPath}.pre-restore-${suffix}`;
      // Hard-link, not rename: `dbPath` must never be briefly absent (see
      // the doc comment above / issue #611 review).
      linkSync(dbPath, preRestorePath);
      linkedPreRestore = true;
      for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(sidecar)) {
          const sidecarDest = `${sidecar}.pre-restore-${suffix}`;
          renameSync(sidecar, sidecarDest);
          movedSidecars.push({ from: sidecarDest, to: sidecar });
        }
      }
    }
    // Atomically replaces `dbPath`'s content; `dbPath` itself is never
    // unlinked, so there is no instant where the path resolves to nothing.
    renameSync(tmpPath, dbPath);
  } catch (err) {
    // Roll back whatever this swap already moved. `dbPath` was only ever
    // hard-linked aside (never unlinked), so it still holds the pre-restore
    // content on its own — only the sidecars, moved with a plain rename,
    // need to move back.
    for (const { from, to } of movedSidecars) {
      try {
        if (!existsSync(to) && existsSync(from)) {
          renameSync(from, to);
        }
      } catch {
        // best-effort
      }
    }
    if (linkedPreRestore && preRestorePath !== undefined) {
      try {
        rmSync(preRestorePath, { force: true });
      } catch {
        // best-effort cleanup of the now-unneeded extra link
      }
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup of the not-yet-installed replacement file
    }
    return { ok: false, error: `Restore failed while swapping the database into place: ${(err as Error).message}` };
  }

  return { ok: true, restoredFrom: entry.backupPath, preRestorePath };
}
