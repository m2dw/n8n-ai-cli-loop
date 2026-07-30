/**
 * Runner-side evidence sources (issue #806, contract §13 S3): the concrete
 * `TrackedFileSource` and `FileAccess` implementations injected into the pure
 * resolver core (src/core/repository-evidence.ts).
 *
 * The only child process spawned anywhere in the evidence boundary is
 * `git ls-files -z --cached` with fixed argv, no shell, and zero agent-derived
 * arguments (§8.3). Query path/glob/pattern values never reach any process.
 */

import { spawn } from "child_process";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "fs";
import { join } from "path";
import {
  EvidenceSnapshotError,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_PATHS,
  SNAPSHOT_MS,
} from "../core/repository-evidence.js";
import type {
  ComponentCheck,
  EvidenceSnapshotReason,
  FileAccess,
  RootAnchor,
  TrackedFileSource,
} from "../core/repository-evidence.js";

// ---------------------------------------------------------------------------
// Tracked-file snapshot (§4.2, §4.2.1)
// ---------------------------------------------------------------------------

/**
 * Capture the tracked-file snapshot for one turn: `git ls-files -z --cached`
 * against `root`, with stdout consumed incrementally so the child is killed
 * at the FIRST exceeded bound — bytes (SNAPSHOT_MAX_BYTES), entries
 * (SNAPSHOT_MAX_PATHS), or wall clock (SNAPSHOT_MS) — and a whole over-bound
 * listing is never buffered in the runner. Overflow is a failure, not a
 * truncation (§4.2.1): a partial list is never returned, there is no
 * filesystem-walk fallback, and the error carries the entry and byte counts
 * actually consumed at abort. The root identity (realpath + dev/ino) is
 * captured with the snapshot (§4.3 step 1) so the caller can bind the path
 * list to the directory it was captured from.
 */
export async function gitTrackedFileSource(root: string): Promise<TrackedFileSource> {
  let rootAnchor: RootAnchor;
  try {
    const realPath = realpathSync.native(root);
    const st = lstatSync(realPath);
    rootAnchor = { realPath, dev: st.dev, ino: st.ino };
  } catch {
    throw new EvidenceSnapshotError("snapshot-failed", 0, 0);
  }
  return new Promise<TrackedFileSource>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["ls-files", "-z", "--cached"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths: string[] = [];
    let carry: Buffer | null = null;
    let bytesConsumed = 0;
    let settled = false;

    const fail = (reason: EvidenceSnapshotReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectPromise(new EvidenceSnapshotError(reason, paths.length, bytesConsumed));
    };

    const timer = setTimeout(() => fail("snapshot-timeout"), SNAPSHOT_MS);

    child.on("error", () => fail("snapshot-failed"));

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytesConsumed += chunk.length;
      // Inclusive ceiling (§14.2 case 34c): exactly at the bound is a legal
      // repository; only past it is a failure — detected on the chunk that
      // crosses the bound, before the rest of the stream is consumed.
      if (bytesConsumed > SNAPSHOT_MAX_BYTES) {
        fail("snapshot-too-large");
        return;
      }
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0) continue;
        if (i > start) {
          // Entry bound checked per entry as the stream is split, so the
          // child dies at the first excess entry, not after full buffering.
          if (paths.length >= SNAPSHOT_MAX_PATHS) {
            fail("snapshot-too-large");
            return;
          }
          paths.push(buf.subarray(start, i).toString("utf8"));
        }
        start = i + 1;
      }
      carry = start < buf.length ? buf.subarray(start) : null;
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal !== null || code !== 0) {
        fail("snapshot-failed");
        return;
      }
      if (carry && carry.length > 0) {
        // `-z` output NUL-terminates every record, so a trailing fragment
        // means the stream was cut; refuse it like any partial snapshot.
        fail("snapshot-failed");
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        list: () => paths,
        snapshotAt: new Date().toISOString(),
        scope: "tracked-worktree",
        root: rootAnchor,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// File access (§4.3, §4.4)
// ---------------------------------------------------------------------------

/**
 * O_NONBLOCK is mandatory (§4.4): opening a FIFO O_RDONLY blocks until a
 * writer connects, which would hang the query, the phase, and the issue
 * worktree lock it holds; with O_NONBLOCK the open returns and the descriptor
 * fstat classifies the path `not-regular-file`. The flag has no effect on
 * regular-file reads.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK;

export function nodeFileAccess(): FileAccess {
  return {
    resolveRoot(root: string): RootAnchor {
      const realPath = realpathSync.native(root);
      const st = lstatSync(realPath);
      return { realPath, dev: st.dev, ino: st.ino };
    },

    verifyRoot(anchor: RootAnchor): boolean {
      // §4.3 step 1: the anchor must still name the directory it was resolved
      // from — a root moved, replaced, or removed since then fails the check.
      try {
        const st = lstatSync(anchor.realPath);
        return st.dev === anchor.dev && st.ino === anchor.ino;
      } catch {
        return false;
      }
    },

    lstatComponents(anchor: RootAnchor, relPath: string): ComponentCheck {
      // Diagnostic pre-check (§4.3 step 2) — a passing walk is never
      // permission to read; the boundary is verifyChain below.
      let current = anchor.realPath;
      try {
        for (const segment of relPath.split("/")) {
          current = join(current, segment);
          const st = lstatSync(current);
          if (st.isSymbolicLink()) return "symlink";
        }
        return "ok";
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
      }
    },

    openRead(anchor: RootAnchor, relPath: string): { fd: number } | { errorClass: string } {
      try {
        return { fd: openSync(join(anchor.realPath, relPath), OPEN_FLAGS) };
      } catch (err) {
        return { errorClass: (err as NodeJS.ErrnoException).code ?? "UNKNOWN" };
      }
    },

    fstatFd(fd: number): { isFile: boolean; dev: number; ino: number; size: number } {
      const st = fstatSync(fd);
      return { isFile: st.isFile(), dev: st.dev, ino: st.ino, size: st.size };
    },

    verifyChain(anchor: RootAnchor, relPath: string, dev: number, ino: number): boolean {
      // §4.3 step 5: with the descriptor still open and before the first read,
      // realpath the requested path again and require (a) byte-for-byte
      // equality with anchor + relPath — not merely root-descendancy — and
      // (b) that the resolved path's identity matches the descriptor actually
      // held. Any mismatch or failure is a rejection.
      try {
        const expected = join(anchor.realPath, relPath);
        const resolved = realpathSync.native(expected);
        if (resolved !== expected) return false;
        const st = lstatSync(resolved);
        return st.dev === dev && st.ino === ino;
      } catch {
        return false;
      }
    },

    readAt(fd: number, buffer: Buffer, position: number): number {
      return readSync(fd, buffer, 0, buffer.length, position);
    },

    close(fd: number): void {
      try {
        closeSync(fd);
      } catch {
        // Already closed or invalid — nothing to release.
      }
    },
  };
}
