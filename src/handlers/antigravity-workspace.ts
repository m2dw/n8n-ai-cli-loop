/**
 * Runner-owned preparation of the bounded Antigravity workspace settings
 * (issue #826; reconciled with real `agy` 1.1.9 by issue #830,
 * docs/antigravity-workspace-settings.md).
 *
 * This module owns every effect the settings layer has: the installed-CLI
 * version probe, the git probes, the ignore registration, the `O_NOFOLLOW`
 * write, the read-back verification, the optional exact-workspace trust
 * registration, and the locked, journalled lifecycle of the runner-owned
 * permission overlay in the global CLI settings. The documents themselves are
 * built and validated by the pure core
 * (src/core/antigravity-workspace-settings.ts).
 *
 * Preparation is trusted orchestration code: it is never reached from an npm
 * lifecycle script, a repository-owned helper, or anything the agent can
 * influence, and it never merges repository-provided settings — the file is
 * regenerated whole before every headless invocation.
 */

import { execFileSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import type { Stats } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import {
  ANTIGRAVITY_SETTINGS_SCHEMA_PIN,
  AntigravityWorkspaceSettingsError,
  RESEARCH_ALLOWED_TOOLS,
  RESEARCH_DENIED_TOOLS,
  RESEARCH_TOOL_SURFACE_CORE,
  RESEARCH_TOOL_SURFACE_EXCLUDE,
  SUSPENDED_GLOBAL_SURFACE_KEYS,
  WORKSPACE_SETTINGS_DIR,
  WORKSPACE_SETTINGS_FILENAME,
  WORKSPACE_SETTINGS_POLICY_VERSION,
  WORKSPACE_SETTINGS_RELATIVE_PATH,
  applyPermissionOverlay,
  assertSupportedCliVersion,
  buildGlobalPermissionOverlay,
  buildResearchWorkspaceSettings,
  canonicalJson,
  detectSurfaceHandoffDrift,
  evaluateWorkspaceTrust,
  renderWorkspaceSettings,
  revertPermissionOverlay,
  withExactWorkspaceTrust,
  workspaceSettingsSha256,
} from "../core/antigravity-workspace-settings.js";
import type {
  AntigravityWorkspaceSettings,
  OverlayClaim,
  OverlayJournalCore,
  RunnerPermissionOverlay,
  TrustRepresentation,
  WorkspaceTrustStatus,
} from "../core/antigravity-workspace-settings.js";

// ---------------------------------------------------------------------------
// Git probe (read-only, fixed argv)
// ---------------------------------------------------------------------------

/**
 * The read-only git questions preparation needs. Injectable so handler tests can
 * script them; the default implementation spawns `git` with fixed argv, no
 * shell, and no agent-derived arguments.
 */
export interface WorkspaceGitProbe {
  /** Whether `relPath` is in the index. */
  isTracked(root: string, relPath: string): boolean;
  /** Whether `relPath` is excluded by any ignore rule. */
  isIgnored(root: string, relPath: string): boolean;
  /**
   * Absolute path of the repository's COMMON git directory. In a linked
   * worktree `.git/worktrees/<name>/info/exclude` is not consulted by git, so
   * the exclude entry has to go to the common directory to take effect.
   */
  gitDir(root: string): string;
  /** Porcelain status limited to `relPath` (empty when clean). */
  status(root: string, relPath: string): string;
}

function git(root: string, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { stdout, status: 0 };
  } catch (err) {
    const status = (err as { status?: number }).status;
    // `git check-ignore` and `git ls-files --error-unmatch` answer "no" with a
    // nonzero exit, so a numeric status is an answer, not a probe failure. Only
    // a missing binary or a signal (no numeric status) is a failure.
    if (typeof status !== "number") {
      throw new AntigravityWorkspaceSettingsError("git-probe-failed", `git ${args[0] ?? ""} could not be executed`);
    }
    return { stdout: typeof (err as { stdout?: string }).stdout === "string" ? (err as { stdout: string }).stdout : "", status };
  }
}

export function nodeWorkspaceGitProbe(): WorkspaceGitProbe {
  return {
    isTracked(root, relPath) {
      return git(root, ["ls-files", "--error-unmatch", "--", relPath]).status === 0;
    },
    isIgnored(root, relPath) {
      return git(root, ["check-ignore", "-q", "--", relPath]).status === 0;
    },
    gitDir(root) {
      const res = git(root, ["rev-parse", "--git-common-dir"]);
      if (res.status !== 0 || !res.stdout.trim()) {
        throw new AntigravityWorkspaceSettingsError("git-probe-failed", "the research workspace is not a git repository");
      }
      // `--git-common-dir` answers relative to the cwd it ran in (commonly
      // `.git`), so anchor it back to the workspace root.
      const dir = res.stdout.trim();
      return isAbsolute(dir) ? dir : resolve(root, dir);
    },
    status(root, relPath) {
      const res = git(root, ["status", "--porcelain", "--", relPath]);
      if (res.status !== 0) {
        throw new AntigravityWorkspaceSettingsError("git-probe-failed", "git status could not be read");
      }
      return res.stdout;
    },
  };
}

// ---------------------------------------------------------------------------
// Trust store location
// ---------------------------------------------------------------------------

/**
 * The one global settings file the installed CLI actually loads: `agy` resolves
 * it from the home directory itself and offers no documented way of being
 * pointed at another one.
 *
 * `$HOME` is read before `homedir()` rather than after: that is the precedence
 * Node itself applies on POSIX, so a real run resolves the identical path, but
 * `homedir()` reads the *process* environment through libuv while a spawned
 * child — and a test — only ever sees `process.env`. Deriving from the variable
 * keeps the home this code answers with the same one anything downstream would
 * observe, instead of one that cannot be redirected.
 */
export function canonicalGlobalSettingsPath(): string {
  const home = process.env["HOME"];
  const base = home && home.trim().length > 0 ? home : homedir();
  return join(base, ".gemini", "antigravity-cli", "settings.json");
}

/**
 * Global Antigravity CLI settings file for this run.
 *
 * `ANTIGRAVITY_CLI_SETTINGS` names a *different* store, which is only ever
 * useful to a fixture run that never launches the CLI: it does not redirect
 * `agy`, so a real invocation pointed at it would prepare one file while the
 * agent ran under another. Preparation refuses that combination outright
 * (`assertStoreIsTheOneTheCliLoads`), so the override cannot silently decide
 * what the agent may do.
 */
export function defaultGlobalSettingsPath(): string {
  const override = process.env["ANTIGRAVITY_CLI_SETTINGS"];
  if (override && override.trim().length > 0) return override;
  return canonicalGlobalSettingsPath();
}

// ---------------------------------------------------------------------------
// Installed-CLI version probe (issue #830)
// ---------------------------------------------------------------------------

/** Returns whatever the installed CLI printed for `--version`. */
export type CliVersionProbe = () => string;

/**
 * Ask the installed CLI for its version by executing the binary the run is
 * about to launch.
 *
 * There is deliberately no environment override (issue #830 review). A value
 * left set from an earlier session would keep answering the gate after the
 * binary was upgraded or replaced, and the run would then install a profile the
 * CLI that actually starts may ignore or read differently — precisely the
 * failure the gate exists to catch. Fixture runs that must not execute a binary
 * inject `probeCliVersion` instead, which is also what tells preparation this
 * invocation launches no CLI at all.
 */
export function nodeCliVersionProbe(bin: string): CliVersionProbe {
  return () => {
    try {
      return execFileSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // Some builds print the banner and exit nonzero; a captured stdout is
      // still an answer. Nothing captured is not.
      const stdout = (err as { stdout?: string }).stdout;
      if (typeof stdout === "string" && stdout.trim().length > 0) return stdout;
      throw new AntigravityWorkspaceSettingsError(
        "cli-version-unreadable",
        "the Antigravity CLI could not be executed to report its version",
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Global settings store: locking, atomic writes, and overlay journals (§2.5)
// ---------------------------------------------------------------------------

/** Advisory lock guarding every read-modify-write of the global settings file.
 * It lives beside the store, so two runners sharing a store share the lock. */
const LOCK_SUFFIX = ".n8n-ai-cli-loop.lock";

/** Where the runner-owned overlay journals live: beside the store, so a crashed
 * run's entries can be reclaimed by whoever touches the store next, from any
 * session and any repository. */
const OVERLAY_DIR_NAME = "n8n-ai-cli-loop-overlays";

/** Marker serializing the unlink of an abandoned lock, so two contenders cannot
 * both declare the same lock stale and have the loser delete the winner's
 * replacement (issue #830 review). */
const TAKEOVER_SUFFIX = ".takeover";

const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;
/** A held lock older than this belonged to a process that died inside the
 * critical section; the write itself is atomic, so taking it over is safe. */
const LOCK_STALE_MS = 60_000;
/**
 * When a takeover marker counts as abandoned. It guards a handful of syscalls,
 * so anything this old outlived its owner — but the window is deliberately
 * longer than a full acquisition timeout, so a marker cannot be reaped out from
 * under a contender that is still inside its own acquisition loop. The cost of
 * the leaked-marker case is bounded and narrow: normal acquisition is
 * unaffected, only the takeover of an *already abandoned* lock is delayed.
 */
const TAKEOVER_STALE_MS = 3 * LOCK_ACQUIRE_TIMEOUT_MS;
/**
 * How old an overlay has to be before its liveness is *reported* as suspect.
 *
 * It is deliberately NOT a reclaim trigger (issue #830 review). A research run
 * that outlives it is still an agent operating under the rules its journal
 * names, so retiring the overlay on age would let the next preparation install
 * a *different* workspace's grants underneath a live agent — exactly the
 * one-workspace-at-a-time contract this layer exists to hold. The owning
 * process is the authority. Age only sharpens the contention diagnostic for the
 * one case that authority can be wrong — an owning pid reused by an unrelated
 * process — so an operator is told which journal to remove instead of reading
 * `global-overlay-contended` forever.
 */
const JOURNAL_TTL_MS = 12 * 60 * 60 * 1_000;
/**
 * How long overlay installation waits for another *workspace's* overlay to be
 * released before failing closed (§2.5). The global permission set is shared, so
 * two workspaces cannot hold grants at the same time; they take turns.
 *
 * Deliberately the same order as the store's own acquisition timeout rather than
 * something research-run-sized: a headless invocation runs for minutes, so a
 * genuinely concurrent workspace is not going to free the permission set within
 * any wait worth blocking a worker for. Refusing quickly and letting the phase
 * be retried is the honest answer, and no wait at all is ever spent running an
 * agent under another workspace's grants.
 */
const OVERLAY_EXCLUSIVE_WAIT_MS = LOCK_ACQUIRE_TIMEOUT_MS;
const OVERLAY_CONTENTION_POLL_MS = 250;

/** Block the current thread briefly. Preparation is synchronous by design (it
 * is the last statement before the CLI is spawned), so the lock wait is too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Run `fn` while holding the store's advisory lock.
 *
 * `O_CREAT | O_EXCL` is the acquisition, so two runners cannot both believe
 * they hold it. A lock whose holder is *demonstrably gone* is taken over rather
 * than waited out forever — a crash between acquisition and release must not
 * wedge every later run — but a live holder keeps it for as long as it runs, so
 * a slow critical section is waited on, never interrupted. The lock is always
 * released in a `finally`, and only by the holder that still owns it, and the
 * critical section only ever ends in an atomic rename, so a takeover can never
 * observe a half-written store.
 */
function withGlobalSettingsLock<T>(globalSettingsPath: string, fn: () => T): T {
  const lockPath = `${globalSettingsPath}${LOCK_SUFFIX}`;
  const token = randomBytes(8).toString("hex");
  const fd = acquireGlobalSettingsLock(lockPath);
  let owned = false;
  try {
    try {
      writeSync(fd, Buffer.from(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token })}\n`, "utf8"));
      owned = true;
    } catch {
      // The lock's contents are diagnostic only; failing to record them must
      // not fail the run that already holds it. Ownership then cannot be
      // proven on release, so the lock is removed unconditionally — the same
      // behaviour as before tokens existed.
    }
    return fn();
  } finally {
    closeSync(fd);
    releaseGlobalSettingsLock(lockPath, owned ? token : null);
  }
}

/**
 * Remove the lock, but only while it is still ours.
 *
 * A holder that was (rightly or wrongly) declared abandoned must not delete the
 * replacement holder's lock on its way out: that would put a third process into
 * the critical section alongside the second and defeat the serialization the
 * lock exists for. The token written at acquisition identifies the holder, so a
 * lock that has since been taken over is left alone.
 */
function releaseGlobalSettingsLock(lockPath: string, token: string | null): void {
  try {
    if (token !== null && readLockHolder(lockPath).token !== token) return;
    rmSync(lockPath, { force: true });
  } catch {
    // A lock we cannot remove ages out as stale; the run itself succeeded.
  }
}

/** The holder recorded inside a lock file; nulls when it cannot be read. */
function readLockHolder(lockPath: string): { pid: number | null; token: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; token?: unknown };
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      token: typeof parsed.token === "string" ? parsed.token : null,
    };
  } catch {
    return { pid: null, token: null };
  }
}

/** Create the lock file exclusively, taking over a demonstrably abandoned one
 * and giving up with `global-settings-locked` after the acquisition timeout. */
function acquireGlobalSettingsLock(lockPath: string): number {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      return openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    } catch (err) {
      if (err instanceof AntigravityWorkspaceSettingsError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new AntigravityWorkspaceSettingsError(
          "global-settings-write-failed",
          "the settings lock could not be created",
        );
      }
      if (takeOverStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new AntigravityWorkspaceSettingsError(
          "global-settings-locked",
          "another process held the Antigravity settings lock for longer than the acquisition timeout",
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

/**
 * Remove a lock whose holder is demonstrably gone. Returns whether the caller
 * should retry the acquisition immediately.
 *
 * "Demonstrably gone" is a dead pid, or — only when the file names no pid at
 * all — an mtime older than `LOCK_STALE_MS`. Age alone is deliberately NOT
 * enough for a named, running holder: a critical section that outlives the
 * staleness window (blocked or slow filesystem I/O) is still a critical
 * section, and evicting it would admit a second writer. Waiting it out and
 * failing with `global-settings-locked` is the fail-closed answer.
 *
 * The removal itself is tied to the inode that was inspected, so a lock a new
 * holder created since the liveness check is never the one unlinked.
 */
function takeOverStaleLock(lockPath: string): boolean {
  let stats: Stats;
  try {
    stats = lstatSync(lockPath);
  } catch {
    // Released between the failed create and this check — retry.
    return true;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AntigravityWorkspaceSettingsError(
      "global-settings-write-failed",
      "the settings lock path is not a regular file",
    );
  }
  const holder = readLockHolder(lockPath).pid;
  if (holder !== null) {
    if (processAlive(holder)) return false;
  } else if (Date.now() - stats.mtimeMs <= LOCK_STALE_MS) {
    // No pid recorded yet: the holder may be between the exclusive create and
    // writing its identity. Only age can settle it.
    return false;
  }
  return removeInspectedLock(lockPath, stats);
}

/**
 * Unlink the abandoned lock, and only ever the file that was inspected.
 *
 * A bare `rmSync(lockPath)` is not the same operation as "remove the lock I
 * just found stale" (issue #830 review): two contenders can both declare the
 * same lock abandoned, and the second one's unlink would then delete the lock
 * the first one had already replaced it with — putting both inside the critical
 * section the lock exists to serialize.
 *
 * Node exposes no inode-checked unlink, so the identity is enforced in two
 * layers instead. A short-lived, exclusively created takeover file makes at most
 * one process eligible to unlink at a time, so the only file that can appear at
 * `lockPath` while a takeover is in progress is one a *new holder* created after
 * the old one was removed; and inside that window the path is re-inspected and
 * the unlink is skipped unless it still names the inspected dev/ino. A takeover
 * file left behind by a process killed inside those few syscalls is aged out, so
 * a crash cannot wedge reclaim permanently.
 */
function removeInspectedLock(lockPath: string, inspected: Stats): boolean {
  const takeoverPath = `${lockPath}${TAKEOVER_SUFFIX}`;
  let fd: number;
  try {
    fd = openSync(takeoverPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    reapAbandonedTakeover(takeoverPath);
    // Another contender is mid-takeover: let it finish and re-evaluate on the
    // next poll rather than racing it.
    return false;
  }
  try {
    let current: Stats;
    try {
      current = lstatSync(lockPath);
    } catch {
      // Already gone — whoever removed it did the work; retry the acquisition.
      return true;
    }
    if (current.dev !== inspected.dev || current.ino !== inspected.ino) {
      // A different file now sits at the path: a new holder acquired it after
      // the liveness check. It is not ours to remove.
      return false;
    }
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
    try {
      rmSync(takeoverPath, { force: true });
    } catch {
      // A marker we cannot remove ages out on a later pass; the lock itself is
      // unaffected either way.
    }
  }
}

/** Drop a takeover marker whose owner died inside the takeover window. It only
 * ever guards a handful of syscalls, so anything older than the grace period is
 * abandoned by definition. */
function reapAbandonedTakeover(takeoverPath: string): void {
  try {
    if (Date.now() - lstatSync(takeoverPath).mtimeMs <= TAKEOVER_STALE_MS) return;
    rmSync(takeoverPath, { force: true });
  } catch {
    // Nothing to reap, or not removable: the next poll tries again.
  }
}

interface GlobalStoreSnapshot {
  /** Raw bytes as found, or null when the store does not exist yet. */
  raw: string | null;
  document: Record<string, unknown>;
}

function readGlobalStore(path: string): GlobalStoreSnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // A missing global store is "nothing recorded", not a broken store.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { raw: null, document: {} };
    throw new AntigravityWorkspaceSettingsError("trust-store-unreadable", "the global settings file could not be read");
  }
  if (raw.trim().length === 0) return { raw, document: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return { raw, document: parsed as Record<string, unknown> };
  } catch {
    // Never replace or repair a store the runner cannot parse — unrelated user
    // settings (and, in a commented store, unrelated user intent) live there.
    throw new AntigravityWorkspaceSettingsError("trust-store-unreadable", "the global settings file is not a JSON object");
  }
}

/**
 * Re-render the global document in the formatting it was found in.
 *
 * Key order comes from the document object, which every core helper builds by
 * spreading the original, so untouched settings keep their position. Matching
 * the original indent and trailing newline is what makes an unrelated store
 * come back byte-for-byte once the runner's entries are released.
 */
function renderGlobalDocument(document: Record<string, unknown>, raw: string | null): string {
  let indent: string | number = 2;
  let trailingNewline = true;
  if (raw !== null && raw.length > 0) {
    const match = /\n([ \t]+)"/.exec(raw);
    if (match) {
      indent = match[1] as string;
    } else if (!raw.trimEnd().includes("\n")) {
      // A store written on one line is minified. Expanding it would rewrite
      // every byte of an operator's file for the duration of the run, and the
      // release would then have only the expanded form to restore from (issue
      // #830 review).
      indent = 0;
    }
    trailingNewline = raw.endsWith("\n");
  }
  return JSON.stringify(document, null, indent) + (trailingNewline ? "\n" : "");
}

/**
 * The bytes to write for `document`, preferring a recorded original.
 *
 * Installation has to re-render the store in order to add its entries, and
 * `JSON.stringify` cannot reproduce every formatting a *valid* store may be
 * written in — escaped non-ASCII, unusual spacing, anything the style probe
 * above does not model. Release renders from the already re-rendered bytes, so
 * without this the operator's file could never come back (issue #830 review).
 * An installation that could not render its store back to itself therefore
 * recorded the original bytes in its journal, and they are written verbatim the
 * moment the document is semantically back to what they hold — which is exactly
 * when byte-for-byte restoration is what the caller means.
 */
function renderGlobalDocumentRestoring(
  document: Record<string, unknown>,
  raw: string | null,
  baselines: readonly string[],
): string {
  const canonical = canonicalJson(document);
  for (const baseline of baselines) {
    const parsed = parseBaseline(baseline);
    if (parsed !== undefined && canonicalJson(parsed) === canonical) return baseline;
  }
  return renderGlobalDocument(document, raw);
}

/** A recorded baseline as a document, or `undefined` when it does not parse.
 * It was recorded from a store that parsed once, so that is not expected;
 * ignoring it means rendering instead of restoring, which is the safe half. */
function parseBaseline(baseline: string): unknown {
  try {
    return JSON.parse(baseline);
  } catch {
    return undefined;
  }
}

// Order-insensitive JSON identity — for deciding whether a document has come
// back to a recorded baseline, and (issue #832) whether a surface key still
// holds what this run installed. Key order is irrelevant to both questions;
// the implementation lives in the pure core module, which needs it too.

/**
 * The original store bytes an installation must record to be able to restore
 * them, or `undefined` when it does not need to.
 *
 * Recording copies the operator's global settings — which can carry tokens —
 * into a second file, so it is done only when that copy is the only way to keep
 * the byte-for-byte guarantee: a store that renders back to itself is
 * reproduced by the release path without any copy, which is the ordinary case.
 * The journal is written `0600` in the same directory as the store it copies,
 * and is removed when the overlay it describes is; nothing from it reaches a
 * published comment or a bounded artifact (§8).
 *
 * `document` is the store as this attempt has just left it — after its reclaims
 * and supersedes — which is the state release has to come back to, and
 * `inherited` holds the originals the overlays it reverted had recorded.
 * Reclaiming a crashed run is the one case where the bytes on disk are NOT the
 * restore target (they still carry that run's rules); there, the operator's
 * formatting survives only in the baseline that run recorded, so it is adopted
 * and carried forward.
 */
function baselineToRecord(
  snapshot: GlobalStoreSnapshot,
  document: Record<string, unknown>,
  inherited: readonly string[],
): string | undefined {
  const canonical = canonicalJson(document);
  for (const candidate of inherited) {
    const parsed = parseBaseline(candidate);
    if (parsed !== undefined && canonicalJson(parsed) === canonical) return candidate;
  }
  if (snapshot.raw === null) return undefined;
  // An empty file holds no document to come back to, so a copy of it could
  // never be matched; rendering is all there is.
  if (snapshot.raw.trim().length === 0) return undefined;
  // Nothing was reverted, so the bytes that were found are the ones to restore.
  if (canonicalJson(snapshot.document) !== canonical) return undefined;
  return renderGlobalDocument(snapshot.document, snapshot.raw) === snapshot.raw ? undefined : snapshot.raw;
}

/** The baselines recorded by a set of journals, in the order they were given. */
function recordedBaselines(journals: readonly StoredOverlayJournal[]): string[] {
  return journals
    .map((journal) => journal.baseline)
    .filter((baseline): baseline is string => typeof baseline === "string");
}

/** The original bytes recorded by the earliest journal in a set that recorded
 * any. Journals are read oldest first (`scanOverlayJournals`) and every filter
 * applied to them preserves that order, so the first is the oldest — the one
 * whose bytes predate every overlay still installed. */
function oldestRecordedBaseline(journals: readonly StoredOverlayJournal[]): string | undefined {
  return recordedBaselines(journals)[0];
}

/**
 * The regular file the store's pathname designates.
 *
 * An operator whose dotfiles are a repository commonly symlinks this store
 * somewhere else, and `renameSync(tmp, path)` onto a symlink replaces the LINK:
 * the run would silently break the operator's setup and orphan the real
 * settings file (issue #830 review). The link is therefore resolved first and
 * the write goes to its target, so the link itself survives every mutation.
 *
 * Anything that is not a symlink to a regular file is refused rather than
 * guessed at: a dangling link names a file the runner would be *creating* at an
 * unexamined location, and a link to a directory or a device is not a settings
 * store at all. Containment (`assertGlobalSettingsOutsideWorkspace`) is already
 * checked against the fully resolved path, so a link into the workspace is
 * rejected before this runs.
 */
function resolveGlobalStoreTarget(path: string): string {
  let link: Stats;
  try {
    link = lstatSync(path);
  } catch (err) {
    // Not there yet: the store is created at this pathname, no link involved.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw new AntigravityWorkspaceSettingsError(
      "global-settings-write-failed",
      "the global settings path could not be inspected",
    );
  }
  if (!link.isSymbolicLink()) return path;
  let target: string;
  try {
    target = realpathSync.native(path);
  } catch {
    throw new AntigravityWorkspaceSettingsError(
      "global-settings-write-failed",
      "the global settings path is a symlink whose target could not be resolved",
    );
  }
  let resolved: Stats;
  try {
    resolved = lstatSync(target);
  } catch {
    throw new AntigravityWorkspaceSettingsError(
      "global-settings-write-failed",
      "the global settings symlink target could not be inspected",
    );
  }
  if (!resolved.isFile()) {
    throw new AntigravityWorkspaceSettingsError(
      "global-settings-write-failed",
      "the global settings path is a symlink to something other than a regular file",
    );
  }
  return target;
}

/**
 * The single pathname every part of the lifecycle keys off.
 *
 * Two runners can name the same store differently — one through a symlink, one
 * through the link's target, one through an unnormalised path. The write
 * resolves the link, so those runs mutate the SAME file while taking DIFFERENT
 * lock files and writing journals into DIFFERENT directories: neither sees the
 * other's live overlay, and both could install their own workspace root into the
 * one global permission set the agents share (issue #830 review). Resolving
 * once, here, before anything derives a lock path, a journal directory, a read
 * or a write from it, is what collapses those aliases into one identity.
 *
 * A store that does not exist yet still has to canonicalise to one name for
 * every runner about to create it, so resolution walks up to the nearest
 * existing ancestor and re-attaches the missing components literally — the same
 * shape `assertGlobalSettingsOutsideWorkspace` uses to decide containment.
 */
function resolveGlobalStoreIdentity(path: string): string {
  const absolute = resolve(path);
  const trailing: string[] = [];
  let probe = dirname(absolute);
  for (;;) {
    try {
      return resolveGlobalStoreTarget(join(realpathSync.native(probe), ...trailing, basename(absolute)));
    } catch (err) {
      if (err instanceof AntigravityWorkspaceSettingsError) throw err;
      const parent = dirname(probe);
      // The filesystem root always resolves; this only guards a pathological
      // loop. Components that do not exist yet are re-appended literally,
      // because a store nothing has created yet has no other name.
      if (parent === probe) return resolveGlobalStoreTarget(absolute);
      trailing.unshift(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Refuse to prepare a store the CLI that is about to run does not load.
 *
 * `globalSettingsPath` (session configuration) and `ANTIGRAVITY_CLI_SETTINGS`
 * both name a store for the *runner*; neither redirects `agy`, which resolves
 * its own store from the home directory. Preparing an alternate file for a run
 * that then launches the CLI is the #826 failure mode again in a new place: the
 * runner would report a verified profile while the agent ran under whatever the
 * real store happened to carry, or without the grant it needs (issue #830
 * review). Only a fixture run — one that answers the version probe instead of
 * executing a binary, so no CLI starts — may point elsewhere.
 *
 * The detail names no path: it reaches a bounded artifact (§8).
 */
function assertStoreIsTheOneTheCliLoads(resolvedPath: string, launchesCli: boolean): void {
  if (!launchesCli) return;
  if (resolvedPath === resolveGlobalStoreIdentity(canonicalGlobalSettingsPath())) return;
  throw new AntigravityWorkspaceSettingsError(
    "global-settings-not-canonical",
    "the configured Antigravity settings store is not the file the installed CLI loads; unset "
    + "ANTIGRAVITY_CLI_SETTINGS and research.antigravity.workspaceSettings.globalSettingsPath so the "
    + "runner prepares the store the agent will actually read",
  );
}

/** Replace the store atomically: a temp file in the same directory, then a
 * rename. A reader (including `agy` itself) sees either the old or the new
 * document, never a truncated one, and a crash mid-write leaves the old one.
 * The rename targets the resolved file, so a symlinked store keeps its link. */
function writeGlobalStoreAtomically(path: string, content: string): void {
  const target = resolveGlobalStoreTarget(path);
  const tmp = `${target}.n8n-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    let mode = 0o600;
    try {
      mode = statSync(target).mode & 0o777;
    } catch {
      // New store: keep the restrictive default.
    }
    writeFileSync(tmp, content, { encoding: "utf8", mode });
    renameSync(tmp, target);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort; the temp file is named so it can be identified.
    }
    throw new AntigravityWorkspaceSettingsError(
      "global-settings-write-failed",
      "the global settings file could not be replaced atomically",
    );
  }
}

// ---------------------------------------------------------------------------
// Overlay journals
// ---------------------------------------------------------------------------

/** On-disk form of one installed overlay. Every field is runner-owned; nothing
 * here is read from, or written to, the CLI's own configuration. */
interface StoredOverlayJournal extends OverlayJournalCore {
  version: 1;
  workspaceRoot: string;
  pid: number;
  createdAt: string;
  /**
   * The store's exact bytes as this installation found them, present only when
   * re-rendering the parsed document does not reproduce them (`baselineToRecord`).
   * Absent means "renders back to itself", which is also how a journal written
   * before this field existed reads.
   */
  baseline?: string;
  /**
   * Set when the claim this journal records is over but the file itself could
   * not be unlinked (issue #830 review). It still names the rules it installed,
   * so a later pass can revert them, but it no longer reads as live: nothing
   * waits on it and no release holds rules in place for it.
   */
  retired?: true;
  /**
   * Set alongside `retired` when the entries this journal names are already back
   * out of the store — a release that completed, or an installation whose store
   * write never landed — and only the file outlived them (issue #830 review).
   * A later pass therefore *deletes* such a journal instead of reverting it: the
   * revert already happened, and doing it a second time would take out an
   * identical rule the operator has added since.
   */
  settled?: true;
  /** Absolute path of this journal file — filled in on read, not persisted. */
  path: string;
}

/** A journal as it is written: everything but the path it was read from. */
type OverlayJournalRecord = Omit<StoredOverlayJournal, "path">;

/** The persistable half of a journal read from disk. */
function journalRecord(journal: StoredOverlayJournal): OverlayJournalRecord {
  const record: Record<string, unknown> = { ...journal };
  delete record.path;
  return record as OverlayJournalRecord;
}

function overlayDir(globalSettingsPath: string): string {
  return join(dirname(globalSettingsPath), OVERLAY_DIR_NAME);
}

function journalFileName(workspaceRoot: string): string {
  const key = createHash("sha256").update(workspaceRoot, "utf8").digest("hex").slice(0, 16);
  return `${key}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
}

/** What one pass over the overlay directory found. */
interface OverlayJournalScan {
  /** Complete, well-formed journals, oldest first. */
  journals: StoredOverlayJournal[];
  /**
   * Paths of `.json` files in the directory that are NOT well-formed journals.
   * Never treated as absent and never deleted: see `scanOverlayJournals`.
   */
  damaged: string[];
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRuleLists(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const lists = value as { allow?: unknown; deny?: unknown };
  return isStringList(lists.allow) && isStringList(lists.deny);
}

/**
 * Whether a parsed `containers` block is one the revert path can act on.
 *
 * All three flags are checked, as booleans (issue #830 review). They decide
 * whether the restored document keeps or drops the `permissions` container and
 * its lists, and an absent or non-boolean flag reads as "the operator had no
 * such container" — so a journal with `containers: {}` would make the runner
 * delete a permission container the operator owns, on the strength of a file
 * that was never written in a shape the runner produces. Failing closed hands it
 * to the damaged path instead.
 */
function isContainerState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const containers = value as Record<string, unknown>;
  return (
    typeof containers["permissionsWasAbsent"] === "boolean"
    && typeof containers["allowWasAbsent"] === "boolean"
    && typeof containers["denyWasAbsent"] === "boolean"
  );
}

/**
 * Whether a parsed file is a journal the runner can act on.
 *
 * Every field the revert path dereferences is checked, because a journal that
 * validates here is one the runner will *use*: a half-shaped `claim` accepted
 * on trust would crash the release it is supposed to make deterministic.
 * Everything else is reported as damaged and fails closed.
 */
function isStoredJournal(value: unknown): value is StoredOverlayJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Partial<StoredOverlayJournal>;
  if (
    journal.version !== 1
    || typeof journal.workspaceRoot !== "string"
    || typeof journal.pid !== "number"
    || typeof journal.createdAt !== "string"
    || !isRuleLists(journal.claim)
    || !isRuleLists(journal.foreign)
    || !isContainerState(journal.containers)
  ) return false;
  // A baseline that is not a string is not one the restore path can write out;
  // absent is the ordinary case (see `baselineToRecord`).
  const baseline: unknown = journal.baseline;
  if (baseline !== undefined && typeof baseline !== "string") return false;
  // `retired` is written only as the literal `true`; anything else is a file the
  // runner did not write in a shape it can act on, and guessing at whether such
  // a journal is live is exactly what the damaged path exists to refuse.
  const retired: unknown = journal.retired;
  if (retired !== undefined && retired !== true) return false;
  // Same rule for `settled`, and it is only ever written together with
  // `retired`: a file claiming its entries are already out while still reading
  // as a live claim is not a shape the runner writes, and acting on it would
  // leave rules nothing ever reverts.
  const settled: unknown = journal.settled;
  if (settled !== undefined && (settled !== true || retired !== true)) return false;
  // Written before the field existed, or written by a build that has it: an
  // absent list restores nothing, which never widens anything.
  const suspended: unknown = journal.suspended;
  if (suspended !== undefined) {
    if (!suspended || typeof suspended !== "object" || !isStringList((suspended as { allow?: unknown }).allow)) {
      return false;
    }
  }
  // Same rule for the tool-surface record (issue #832): absent is a journal from
  // a build that installed no surface, and restores nothing.
  return isSurfaceRecord(journal.surface);
}

/**
 * Whether a parsed tool-surface record is one the restore path can act on.
 *
 * A malformed record is not "no surface": the overlay that wrote it replaced the
 * operator's `tools`, `mcpServers`, and `autoAccept` keys, and only this record
 * says what they held. Failing closed hands the file to the damaged path, which
 * refuses rather than leaving the runner's read-only registration installed with
 * nothing able to remove it.
 */
function isSurfaceRecord(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { installed?: unknown; suspended?: unknown };
  const installed = record.installed;
  if (!installed || typeof installed !== "object" || Array.isArray(installed)) return false;
  if (!Array.isArray(record.suspended)) return false;
  // The record must account for *every* suspended key, exactly once, with the
  // value this overlay installed for it (issue #832 review). A well-formed but
  // incomplete record — `{ "installed": {}, "suspended": [] }` at the limit —
  // would otherwise read as an intact journal while describing none of the keys
  // the overlay replaced: launch verification would check nothing, the release
  // would restore nothing, and the runner's `tools`, `mcpServers`, and
  // `autoAccept` registration would stay in the operator's global store. Only a
  // record that can undo the whole installation is acted on; anything less is
  // damaged, and the damaged path refuses rather than leaving that behind.
  const keys = new Set(SUSPENDED_GLOBAL_SURFACE_KEYS);
  const values = installed as Record<string, unknown>;
  if (Object.keys(values).length !== keys.size || record.suspended.length !== keys.size) return false;
  const seen = new Set<string>();
  for (const entry of record.suspended) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const key: unknown = (entry as { key?: unknown }).key;
    if (typeof key !== "string" || !keys.has(key) || seen.has(key)) return false;
    if (!Object.prototype.hasOwnProperty.call(values, key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * The live-claim record `revertPermissionOverlay` reads for one journal.
 *
 * The tool surface is released by the last overlay holding it, which is not the
 * last permission claim (issue #832 review): a journal from before #832 carries
 * rules but no surface, so it must not suppress a releasing run's restoration —
 * it has nothing of its own to put back. Damaged journals are the unknown case
 * and are synthesized elsewhere without this flag, which reads as "holding".
 */
function liveClaimOf(journal: StoredOverlayJournal): OverlayClaim {
  return { ...journal.claim, holdsSurface: journal.surface !== undefined };
}

/**
 * Read every overlay journal beside the store, oldest first, and report the
 * files that are not journals the runner can act on.
 *
 * A journal that cannot be parsed is NOT skipped (issue #830 review). It is the
 * only record of rules that may already be installed in the global store, and
 * discarding it discards the claim: `reclaimDeadOverlays` would then never
 * remove those entries, and the TTL cannot help — the TTL is read *from* the
 * journal. The workspace read grants would simply persist. Damaged files are
 * therefore surfaced to the caller, which fails closed on them
 * (`global-overlay-journal-damaged`) and leaves them on disk for the operator,
 * rather than silently taking them out of the bookkeeping.
 *
 * Journals are installed by an atomic rename (`writeJournalDurably`), so a
 * damaged file cannot come from a torn write of this runner's own; anything the
 * scan reports is a store an operator or another tool has disturbed.
 */
function scanOverlayJournals(globalSettingsPath: string): OverlayJournalScan {
  const dir = overlayDir(globalSettingsPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { journals: [], damaged: [] };
  }
  const journals: StoredOverlayJournal[] = [];
  const damaged: string[] = [];
  for (const name of names) {
    // Temp files of an in-flight installation are deliberately not `.json`, so
    // a concurrent writer is never mistaken for a damaged journal.
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      damaged.push(path);
      continue;
    }
    if (!isStoredJournal(parsed)) {
      damaged.push(path);
      continue;
    }
    journals.push({ ...parsed, path });
  }
  journals.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return { journals, damaged };
}

/**
 * Write a journal so that it is on disk, whole, before the store update it
 * describes can become durable.
 *
 * Both halves matter. The rename makes the file appear atomically, so a crash
 * mid-write leaves an ignored temp file rather than a half-journal; the fsync
 * makes the bytes durable before the caller replaces the store, so a power loss
 * cannot leave the store's new rules on disk with an empty or partial journal
 * naming them (issue #830 review).
 */
function writeJournalDurably(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  mkdirSync(dir, { recursive: true });
  const fd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    const bytes = Buffer.from(content, "utf8");
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written, written);
    }
    fsyncSync(fd);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // A temp file the runner cannot remove is never read: it is not `.json`.
    }
    throw err;
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // See above: an unremovable temp file is inert, not a journal.
    }
    throw err;
  }
  syncDirectory(dir);
}

/** Make a directory entry durable. Best effort: not every platform or
 * filesystem permits fsync on a directory, and the rename above is already
 * atomic with respect to readers. */
function syncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Ignored deliberately; see above.
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether a journal still describes a run that could be using its grants.
 *
 * The owning process is the authority, and nothing overrides it while it is
 * alive (issue #830 review). A headless invocation that runs longer than any
 * timeout the runner picked is still an agent holding these grants; reclaiming
 * its overlay would hand the shared permission set to another workspace while
 * that agent is mid-run, which is the isolation failure the exclusivity rule
 * exists to prevent. Only a vanished workspace or a pid that no longer answers
 * ends a journal's claim — age is reported (`journalIsPastTtl`), never acted on.
 *
 * The one exception is a journal the runner itself retired: its owner has
 * already given the claim up and only the file outlived it (`retireJournalAt`).
 */
function journalIsLive(journal: StoredOverlayJournal): boolean {
  if (journal.retired === true) return false;
  if (!existsSync(journal.workspaceRoot)) return false;
  return processAlive(journal.pid);
}

/** Whether a still-live-looking journal is old enough that a recycled pid is a
 * plausible explanation for it. Only ever used to make a refusal actionable —
 * see `JOURNAL_TTL_MS`. An unparseable `createdAt` compares false, so it reads
 * as "not suspect", which never removes anything. */
function journalIsPastTtl(journal: StoredOverlayJournal, now: number): boolean {
  return now - Date.parse(journal.createdAt) > JOURNAL_TTL_MS;
}

/** Unlink a journal file. Reports whether it is gone — a caller whose
 * correctness depends on the claim disappearing must not assume it did (issue
 * #830 review). */
function removeJournalFile(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite a journal in place as retired, for the case where its file cannot be
 * unlinked at all (an ACL or an immutable flag changed under the run).
 *
 * This is the "reclaimable, non-live" fallback the removal path needs. Deleting
 * the record is not an option — it is the only handle on rules that may still be
 * in the store — but leaving it *live* is worse than useless: liveness follows
 * the owning process, so a leftover journal of this very process keeps reading
 * as a concurrent claimant, and every later release would hold its rules in
 * place for a claim nobody owns while reporting a clean release. Retiring keeps
 * the record and drops the claim, so the next pass reverts whatever it names and
 * tries the removal again.
 *
 * `settled` says the entries are already out of the store, which turns that next
 * pass from a second revert into a plain deletion — see `settleJournalFile`.
 */
function retireJournalAt(path: string, journal: OverlayJournalRecord, settled = false): boolean {
  const retired = { ...journal, retired: true as const, ...(settled ? { settled: true as const } : {}) };
  try {
    writeJournalDurably(path, JSON.stringify(retired, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop a journal whose entries the store no longer carries.
 *
 * Deleting the file is the whole of it when it works. When it does not, the
 * record is retired *and marked settled*, because the rules it names have
 * already been taken back out: a later pass that reverted it a second time
 * would remove an identical workspace-scoped rule the operator has added in the
 * meantime, silently undoing their edit (issue #830 review). A settled journal
 * is only ever deleted from then on.
 *
 * False means neither worked, so the claim it records still reads as live and a
 * caller whose correctness depends on it being gone must fail closed.
 */
function settleJournalFile(journal: StoredOverlayJournal): boolean {
  if (removeJournalFile(journal.path)) return true;
  return retireJournalAt(journal.path, journalRecord(journal), true);
}

/**
 * Revert every overlay whose owning run is gone, and return the surviving
 * journals plus the reverted document.
 *
 * This is the crash-safe half of the lifecycle: a run killed between
 * installation and release leaves its rules in the global store, and the next
 * run to take the lock removes them. Liveness is deliberately conservative — a
 * dead pid or a workspace that no longer exists, and nothing else — so a
 * concurrent live run is never stripped of its grants, however long it runs.
 *
 * Nothing is written here, journal files included: the dead journals are handed
 * back so the caller can settle them *after* the store update that carries their
 * revert commits (issue #830 review). Settling them in this loop would be a
 * guess in both directions — a commit that never happens would drop the only
 * record of installed rules, and a file whose removal is refused (a sticky
 * overlay directory, say) would keep reading as an unsettled claim and be
 * reverted again by every later pass, deleting an identical rule an operator
 * added after the first reclaim.
 */
function reclaimDeadOverlays(
  document: Record<string, unknown>,
  journals: readonly StoredOverlayJournal[],
): {
  document: Record<string, unknown>;
  live: StoredOverlayJournal[];
  /** Journals whose claim this pass gave up on; settle once the store commits. */
  dead: StoredOverlayJournal[];
  reclaimed: number;
  /** Original store bytes the reverted overlays recorded, oldest first. */
  baselines: string[];
} {
  const live: StoredOverlayJournal[] = [];
  const dead: StoredOverlayJournal[] = [];
  for (const journal of journals) {
    (journalIsLive(journal) ? live : dead).push(journal);
  }
  let next = document;
  let reclaimed = 0;
  for (const journal of dead) {
    // A settled journal is not an overlay to reclaim — its own release already
    // took these entries out and only its file survived (`settleJournalFile`).
    // Reverting it again would remove a matching workspace-scoped rule the
    // operator has added since that release, so all that is left is the
    // deletion that failed at the time (issue #830 review).
    if (journal.settled !== true) {
      // Only *live* claims hold a rule in place. A rule another dead journal
      // also claims is removed here and its own revert becomes a no-op, and no
      // dead journal can be holding a user-owned rule that a second dead
      // journal recorded as foreign: whoever installed second would have
      // reclaimed the first before recording anything.
      next = revertPermissionOverlay(next, journal, live.map(liveClaimOf));
      reclaimed += 1;
    }
  }
  return { document: next, live, dead, reclaimed, baselines: recordedBaselines(dead) };
}

/**
 * Retire the journals of claims a committed store update has just taken back
 * out, so no later pass reverts them a second time.
 *
 * Called only after the write that removed their entries, and never on a path
 * that failed to write: a settled journal says "these rules are already out of
 * the store", which is only true once the bytes are on disk. Deletion is the
 * ordinary outcome; a file that resists it is retired as settled, which is what
 * keeps a later pass from reverting the same claim a second time and taking an
 * identical rule the operator has added since (issue #830 review).
 *
 * A file that resists even the rewrite is left for the next pass rather than
 * failing the run: nothing is lost — it still names its rules and is already
 * non-live — and the store is committed either way, so refusing here would only
 * strand this run's own overlay behind a leftover nobody can edit. That is the
 * same floor the release path documents; the case it leaves open (a journal
 * neither removable nor rewritable, whose claim a later pass re-applies) needs
 * an overlay directory the runner can no longer write to at all.
 */
function settleCommittedJournals(journals: readonly StoredOverlayJournal[]): void {
  for (const journal of journals) settleJournalFile(journal);
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

export interface PrepareWorkspaceSettingsInput {
  /** The exact research workspace root (the run's cwd for the agent). */
  workspaceRoot: string;
  /** Provenance of the research binary; only the vetted default is prepared for. */
  cmdSource: "env" | "cli-default";
  denyGlobs?: readonly string[] | undefined;
  generatedGlobs?: readonly string[] | undefined;
  /**
   * Absolute path of the global CLI settings file; defaults to the store the
   * installed CLI loads. A path other than that store is only accepted for a
   * fixture run — one that also injects `probeCliVersion`, and therefore
   * launches no CLI — because nothing here can redirect where `agy` reads from.
   */
  globalSettingsPath?: string | undefined;
  /** Register the exact workspace in the trust store when it is not trusted. Default false. */
  registerTrust?: boolean | undefined;
  git?: WorkspaceGitProbe;
  /** Binary asked for its version; only the vetted default is ever prepared for. */
  cliBin?: string | undefined;
  /**
   * Version probe seam. Supplying it means no binary is executed, which is only
   * ever true of a fixture run: preparation therefore treats it as the
   * declaration that this invocation launches no CLI, and relaxes the
   * canonical-store requirement accordingly (issue #830 review).
   */
  probeCliVersion?: CliVersionProbe | undefined;
}

export interface PreparedWorkspaceSettings {
  policyVersion: string;
  schemaPin: string;
  /** Workspace-relative path of the generated file — never an absolute path. */
  relativePath: string;
  settingsSha256: string;
  settingsBytes: number;
  allowedTools: string[];
  deniedTools: string[];
  /**
   * The registration lists installed into the global store (§2.6, issue #832):
   * the read-only tools the CLI may offer, and the write/command/network/memory
   * tools it may not — both under every spelling the pinned schema accepts.
   */
  toolSurface: { core: string[]; exclude: string[] };
  allowRuleCount: number;
  denyRuleCount: number;
  /** How the file is excluded: by a repository ignore rule, or by the runner-owned git exclude. */
  gitIgnored: "repository" | "runner-exclude";
  trust: {
    status: WorkspaceTrustStatus;
    containerPresent: boolean;
    entryCount: number;
    registered: boolean;
    representation: TrustRepresentation;
  };
  /** Version the installed CLI reported, gated against the reconciled range. */
  cliVersion: string;
  /** The runner-owned permission entries installed into the global store (§2.5). */
  globalOverlay: {
    installed: boolean;
    allowRuleCount: number;
    denyRuleCount: number;
    /**
     * Whether the read-only tool registration was installed into the global
     * store alongside the rules (issue #832). Always true for a successful
     * preparation; recorded so an artifact from a run that predates the surface
     * is not mistaken for one that had it.
     */
    toolSurfaceInstalled: boolean;
    /** Overlays of crashed or finished runs reverted while taking the lock. */
    reclaimed: number;
  };
  /**
   * Local-only handle the release step needs. Absolute paths live here and
   * nowhere else in the record, so the bounded artifact can copy the fields
   * above verbatim.
   */
  releaseHandle: {
    globalSettingsPath: string;
    journalPath: string;
    /**
     * Whether this preparation is for a run that will actually launch the CLI,
     * and therefore had to prepare the one store `agy` loads
     * (`assertStoreIsTheOneTheCliLoads`). Launch-time verification re-derives
     * that store and refuses a store identity that has moved since (issue #830
     * review); a fixture run, which launches nothing, legitimately points
     * elsewhere and is exempt.
     */
    launchesCli: boolean;
  } | null;
}

const EXCLUDE_MARKER = "# n8n-ai-cli-loop: runner-owned Antigravity research settings (issue #826)";

/** Repo-root-anchored exclude entry for the generated file. */
const EXCLUDE_ENTRY = `/${WORKSPACE_SETTINGS_RELATIVE_PATH}`;

function assertNotSymlink(path: string, reason: "settings-dir-symlink" | "settings-symlink"): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new AntigravityWorkspaceSettingsError(reason);
    }
  } catch (err) {
    if (err instanceof AntigravityWorkspaceSettingsError) throw err;
    // ENOENT: nothing is there yet. ENOTDIR: an ancestor is not a directory, so
    // there is no link at this path either — the directory creation below
    // reports that case with its own, accurate reason.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw new AntigravityWorkspaceSettingsError(reason, "the path could not be inspected");
  }
}

/**
 * Make the generated file Git-ignored without changing a tracked file.
 *
 * A repository that already ignores it is left alone. Otherwise the entry is
 * appended to the repository's own `info/exclude`, which is local, untracked,
 * and invisible to `git status` — so preparation never adds a tracked change and
 * never edits a committed `.gitignore`. The result is re-probed; if the file is
 * still not ignored the run is refused rather than left dirtying the worktree.
 */
function ensureIgnored(root: string, probe: WorkspaceGitProbe): "repository" | "runner-exclude" {
  const excludePath = join(probe.gitDir(root), "info", "exclude");
  let current = "";
  try {
    current = readFileSync(excludePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AntigravityWorkspaceSettingsError("settings-not-ignored", "the repository exclude file could not be read");
    }
  }
  const runnerEntryPresent = current.split("\n").some((line) => line.trim() === EXCLUDE_ENTRY);
  if (probe.isIgnored(root, WORKSPACE_SETTINGS_RELATIVE_PATH)) {
    // Reported honestly across runs: once the runner has written the exclude
    // entry, later runs must not claim the repository is doing the ignoring.
    return runnerEntryPresent ? "runner-exclude" : "repository";
  }
  if (!runnerEntryPresent) {
    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    try {
      mkdirSync(dirname(excludePath), { recursive: true });
      writeFileSync(excludePath, `${current}${prefix}${EXCLUDE_MARKER}\n${EXCLUDE_ENTRY}\n`, "utf8");
    } catch {
      throw new AntigravityWorkspaceSettingsError("settings-not-ignored", "the repository exclude file could not be written");
    }
  }
  if (!probe.isIgnored(root, WORKSPACE_SETTINGS_RELATIVE_PATH)) {
    throw new AntigravityWorkspaceSettingsError("settings-not-ignored");
  }
  return "runner-exclude";
}

/** A settings directory pinned by descriptor, with the inode identity the write
 * re-checks the path against. */
interface PinnedDirectory {
  fd: number;
  dev: number;
  ino: number;
}

/**
 * Open the settings directory itself, refusing to traverse a symlink at its
 * final component, and pin the inode the write is allowed to land in.
 *
 * `O_NOFOLLOW | O_DIRECTORY` is the atomic half of the containment: a `.gemini`
 * that has become a symlink (or is not a directory at all) fails the open
 * outright rather than being followed. The recorded dev/ino is the other half —
 * it is what `assertPinnedDirectory` re-checks the path against, so a swap
 * performed after this point is still detected.
 */
function pinSettingsDirectory(settingsDir: string): PinnedDirectory {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | fsConstants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(settingsDir, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP (Linux/macOS) and EMLINK (some BSDs) are O_NOFOLLOW's "this is a
    // symlink" answer; ENOTDIR means the path does not name a directory.
    if (code === "ELOOP" || code === "EMLINK" || code === "ENOTDIR") {
      throw new AntigravityWorkspaceSettingsError("settings-dir-symlink");
    }
    throw new AntigravityWorkspaceSettingsError(
      "settings-write-verification-failed",
      `the settings directory could not be opened (${code ?? "unknown"})`,
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) {
      throw new AntigravityWorkspaceSettingsError("settings-dir-symlink", "the settings path does not name a directory");
    }
    return { fd, dev: st.dev, ino: st.ino };
  } catch (err) {
    closeSync(fd);
    if (err instanceof AntigravityWorkspaceSettingsError) throw err;
    throw new AntigravityWorkspaceSettingsError("settings-write-verification-failed", "the settings directory could not be inspected");
  }
}

/** Re-check that `settingsDir` still names the pinned inode and is still a real
 * directory rather than a link planted since it was pinned. */
function assertPinnedDirectory(pinned: PinnedDirectory, settingsDir: string): void {
  let st: Stats;
  try {
    st = lstatSync(settingsDir);
  } catch {
    throw new AntigravityWorkspaceSettingsError("settings-dir-symlink", "the settings directory could not be re-inspected");
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== pinned.dev || st.ino !== pinned.ino) {
    throw new AntigravityWorkspaceSettingsError("settings-dir-symlink", "the settings directory was replaced during preparation");
  }
}

/**
 * Write `content` into the pinned directory and verify it from the same
 * descriptor, without ever following a symlink and without trusting the path a
 * second time.
 *
 * The ordering is what makes this race-safe. `O_NOFOLLOW` protects only the
 * final component, so on its own it would still let a `.gemini` swapped for a
 * symlink redirect the write onto an arbitrary external `settings.json`. Here
 * the file is opened *without* `O_TRUNC`, so at the point the containment is
 * re-checked nothing has been destroyed yet: only after the directory is
 * confirmed to still be the pinned inode, and the opened descriptor is
 * confirmed to be the very file that path names, is the descriptor truncated
 * and written. A swap after the open fails the directory check; a swap before
 * it (even one reverted immediately after) makes the descriptor's identity
 * disagree with the path's, because two distinct files cannot share a dev/ino.
 * Either way the external file is left untouched.
 *
 * The read-back reads that same descriptor, so it verifies the bytes at the
 * inode that was actually written instead of whatever the path resolves to
 * afterwards.
 *
 * The one effect the post-open verification cannot undo is `O_CREAT` having
 * created an empty file through an already-swapped directory, so the pin is
 * re-checked once more immediately before the open. Node has no `openat`, so
 * that window cannot be closed entirely; it can only ever produce an empty
 * file, never disclose or destroy content.
 */
function writeContainedSettings(
  pinned: PinnedDirectory,
  settingsDir: string,
  settingsPath: string,
  content: string,
): void {
  // Narrow the O_CREAT window: if the directory has already been swapped, the
  // open must not run at all, because creating the file is the one effect the
  // post-open verification cannot undo from inside the workspace.
  assertPinnedDirectory(pinned, settingsDir);
  let fd: number;
  try {
    fd = openSync(settingsPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new AntigravityWorkspaceSettingsError("settings-symlink");
    throw new AntigravityWorkspaceSettingsError("settings-write-verification-failed", `settings file could not be opened (${code ?? "unknown"})`);
  }
  try {
    assertPinnedDirectory(pinned, settingsDir);
    const opened = fstatSync(fd);
    let named: Stats;
    try {
      named = lstatSync(settingsPath);
    } catch {
      throw new AntigravityWorkspaceSettingsError("settings-write-verification-failed", "the settings file could not be re-inspected");
    }
    if (named.isSymbolicLink()) throw new AntigravityWorkspaceSettingsError("settings-symlink");
    if (!opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
      throw new AntigravityWorkspaceSettingsError("settings-write-verification-failed", "the settings file changed while it was being opened");
    }

    const bytes = Buffer.from(content, "utf8");
    try {
      ftruncateSync(fd, 0);
      writeSync(fd, bytes, 0, bytes.length, 0);
    } catch {
      throw new AntigravityWorkspaceSettingsError("settings-write-verification-failed", "settings file could not be written");
    }

    // One byte of slack so a longer-than-expected file reads as a mismatch
    // rather than as a prefix match.
    const verify = Buffer.alloc(bytes.length + 1);
    let read = 0;
    try {
      let n = 0;
      do {
        n = readSync(fd, verify, read, verify.length - read, read);
        read += n;
      } while (n > 0 && read < verify.length);
    } catch {
      throw new AntigravityWorkspaceSettingsError("settings-write-verification-failed", "the settings file could not be read back");
    }
    if (read !== bytes.length || !verify.subarray(0, read).equals(bytes)) {
      throw new AntigravityWorkspaceSettingsError("settings-write-verification-failed", "the settings file changed between write and verification");
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Refuse a global CLI settings store that lives inside the research workspace.
 *
 * The generated profile grants `read_file(<workspace>/**)`, so a store placed
 * under the workspace would be readable by the headless agent — private global
 * CLI configuration (trust entries for other repositories, unrelated user
 * settings) disclosed through the very boundary this layer exists to draw. In
 * the special case where the override *is* `<workspace>/.gemini/settings.json`
 * the two also collide outright: opt-in trust registration would write the trust
 * document to the exact path the workspace profile then overwrites, so trust
 * would never persist and every run would re-register it.
 *
 * Containment is checked on the resolved path — the store itself when it exists,
 * otherwise its nearest existing ancestor with the not-yet-created components
 * re-anchored — so a symlinked ancestor cannot smuggle the store back inside.
 * `workspaceRoot` is already a real path when this runs.
 */
function assertGlobalSettingsOutsideWorkspace(globalSettingsPath: string, workspaceRoot: string): void {
  const inside = (path: string): boolean => path === workspaceRoot || path.startsWith(`${workspaceRoot}/`);
  const lexical = resolve(globalSettingsPath);
  if (inside(lexical)) {
    throw new AntigravityWorkspaceSettingsError("trust-store-inside-workspace");
  }
  // The store need not exist yet (opt-in registration creates it), so walk up to
  // the nearest existing ancestor and re-attach the components below it.
  let probe = lexical;
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      if (inside(trailing.length === 0 ? real : join(real, ...trailing))) {
        throw new AntigravityWorkspaceSettingsError("trust-store-inside-workspace");
      }
      return;
    } catch (err) {
      if (err instanceof AntigravityWorkspaceSettingsError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new AntigravityWorkspaceSettingsError("trust-store-unreadable", "the global settings path could not be resolved");
      }
      const parent = dirname(probe);
      // The filesystem root always resolves, so this only guards a pathological
      // loop; nothing above it can be inside the workspace anyway.
      if (parent === probe) return;
      trailing.unshift(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Prepare the workspace for exactly one headless `agy` invocation and return the
 * bounded record of what was written.
 *
 * Order matters: every refusal is checked before anything is created, the file
 * is written whole (never merged), and the result is verified by reading it
 * back and by confirming the worktree is still clean.
 */
export function prepareAntigravityWorkspaceSettings(
  input: PrepareWorkspaceSettingsInput,
): PreparedWorkspaceSettings {
  // The permission profile is pinned to the vetted CLI's schema (§6.1). An
  // operator-overridden binary may speak a different settings dialect, so the
  // runner refuses rather than writing a profile it cannot vouch for — the same
  // provenance seam the quota (#671) and denial (#804) classifiers use.
  if (input.cmdSource !== "cli-default") {
    throw new AntigravityWorkspaceSettingsError("unvetted-cli-binary");
  }

  // Which store this run works on is settled first, and by ONE resolved
  // pathname: every lock, journal directory, read and write below is derived
  // from it, so two runners that name the same file differently cannot serialise
  // against different locks while mutating the same global permission set. A run
  // that will launch the CLI is then held to the store that CLI loads — an
  // injected version probe is what marks a run as launching none, because only a
  // fixture answers the probe instead of executing the binary (issue #830
  // review).
  const launchesCli = input.probeCliVersion === undefined;
  const globalSettingsPath = resolveGlobalStoreIdentity(
    input.globalSettingsPath ?? defaultGlobalSettingsPath(),
  );
  assertStoreIsTheOneTheCliLoads(globalSettingsPath, launchesCli);

  // The compatibility gate #826 lacked (issue #830): the pin is confronted with
  // the binary that will actually run, before anything is written, so a CLI
  // whose configuration loading or trust schema this module was never
  // reconciled against fails closed instead of running under a profile it
  // silently ignores.
  const cliVersion = assertSupportedCliVersion(
    (input.probeCliVersion ?? nodeCliVersionProbe(input.cliBin ?? "agy"))(),
  );

  const probe = input.git ?? nodeWorkspaceGitProbe();

  // 1. Resolve the exact workspace root. Rules are scoped to the *real* path so
  //    a symlinked root cannot widen the scope to its parent.
  const requested = input.workspaceRoot;
  if (!requested.startsWith("/")) {
    throw new AntigravityWorkspaceSettingsError("workspace-root-not-absolute");
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync.native(requested);
    if (!statSync(workspaceRoot).isDirectory()) {
      throw new AntigravityWorkspaceSettingsError("workspace-root-unresolvable", "the workspace root is not a directory");
    }
  } catch (err) {
    if (err instanceof AntigravityWorkspaceSettingsError) throw err;
    throw new AntigravityWorkspaceSettingsError("workspace-root-unresolvable");
  }

  // 2. The settings path must stay strictly inside the resolved root.
  const settingsDir = join(workspaceRoot, WORKSPACE_SETTINGS_DIR);
  const settingsPath = join(settingsDir, WORKSPACE_SETTINGS_FILENAME);
  if (
    resolve(settingsPath) !== settingsPath
    || !settingsPath.startsWith(`${workspaceRoot}/`)
    || !settingsDir.startsWith(`${workspaceRoot}/`)
  ) {
    throw new AntigravityWorkspaceSettingsError("settings-path-escapes-workspace");
  }

  // 3. Refuse symlinked containers or targets before creating anything, and
  //    re-check the directory's real path so a pre-existing `.gemini` that
  //    resolves elsewhere cannot host the file.
  assertNotSymlink(settingsDir, "settings-dir-symlink");
  assertNotSymlink(settingsPath, "settings-symlink");
  if (existsSync(settingsDir)) {
    let realDir: string;
    try {
      realDir = realpathSync.native(settingsDir);
    } catch {
      throw new AntigravityWorkspaceSettingsError("settings-path-escapes-workspace", "the settings directory could not be resolved");
    }
    if (realDir !== settingsDir) {
      throw new AntigravityWorkspaceSettingsError("settings-path-escapes-workspace");
    }
  }

  // 4. A tracked settings file is repository-owned. Overwriting it would both
  //    merge the runner into repository content and dirty the worktree.
  if (probe.isTracked(workspaceRoot, WORKSPACE_SETTINGS_RELATIVE_PATH)) {
    throw new AntigravityWorkspaceSettingsError("settings-tracked-by-git");
  }

  // 5. Build and validate the complete profile BEFORE anything is mutated. The
  //    construction is pure, but its refusals (an over-budget operator glob
  //    configuration, an unrepresentable root, schema drift) are configuration
  //    errors — a run that fails them must leave no persistent trace, so it has
  //    to fail before the trust store is touched and before the runner-owned
  //    exclude entry is appended.
  const settings = buildResearchWorkspaceSettings({
    workspaceRoot,
    denyGlobs: input.denyGlobs,
    generatedGlobs: input.generatedGlobs,
  });
  const rendered = renderWorkspaceSettings(settings);

  // 6. Trust: verify the exact workspace, and register only the exact workspace
  //    when the operator opted in. A parent-directory grant is never written.
  //    The store must live outside the workspace the profile makes readable.
  //    Its pathname was resolved and vetted at the top of this function;
  //    containment needs the root step 1 resolved, so it is checked here —
  //    still before the store is read, so a misplaced store is never opened
  //    and, with registration opted in, never written.
  assertGlobalSettingsOutsideWorkspace(globalSettingsPath, workspaceRoot);
  let trust = evaluateWorkspaceTrust(readGlobalStore(globalSettingsPath).document, workspaceRoot);
  let registered = false;
  if (trust.status === "distrusted") {
    throw new AntigravityWorkspaceSettingsError("workspace-distrusted");
  }
  if (trust.status === "untrusted") {
    if (input.registerTrust !== true) {
      throw new AntigravityWorkspaceSettingsError("workspace-not-trusted");
    }
    // Re-read AND re-evaluate under the lock. Re-reading keeps a concurrent
    // run's registration or overlay intact; re-evaluating is what makes the
    // decision honest (issue #830 review). The read above is unlocked, so an
    // operator can revoke this workspace — a legacy `DO_NOT_TRUST` entry, say —
    // between it and this lock. Appending to `trustedWorkspaces` regardless
    // would overwrite that revocation with a grant and launch the run under it,
    // which is exactly what "distrust wins wherever it appears" (§3.1) forbids.
    // The locked document therefore decides: distrust refuses, and a workspace
    // somebody else trusted in the meantime is left exactly as they wrote it
    // rather than gaining a duplicate runner-owned entry.
    const outcome = withGlobalSettingsLock(globalSettingsPath, () => {
      const snapshot = readGlobalStore(globalSettingsPath);
      const current = evaluateWorkspaceTrust(snapshot.document, workspaceRoot);
      if (current.status === "distrusted") {
        throw new AntigravityWorkspaceSettingsError("workspace-distrusted");
      }
      if (current.status !== "untrusted") return { trust: current, registered: false };
      const updated = withExactWorkspaceTrust(snapshot.document, workspaceRoot);
      writeGlobalStoreAtomically(globalSettingsPath, renderGlobalDocument(updated, snapshot.raw));
      return { trust: current, registered: true };
    });
    trust = outcome.trust;
    registered = outcome.registered;
  }

  // 7. Ignore registration BEFORE the write, so the file never exists as an
  //    untracked, unignored path even momentarily.
  const gitIgnored = ensureIgnored(workspaceRoot, probe);

  // 8. Write the profile. Any pre-existing file — stale runner output, a
  //    malformed document, or a repository-provided one — is replaced whole;
  //    nothing from it is read or merged. The directory is pinned by descriptor
  //    immediately before the write and re-checked against that pin inside it,
  //    so the earlier path-based checks cannot be raced by a `.gemini` swapped
  //    for a symlink in the meantime. The write verifies itself from its own
  //    descriptor.
  try {
    mkdirSync(settingsDir, { recursive: true });
  } catch {
    throw new AntigravityWorkspaceSettingsError("settings-write-verification-failed", "the settings directory could not be created");
  }
  const pinned = pinSettingsDirectory(settingsDir);
  try {
    assertNotSymlink(settingsPath, "settings-symlink");
    writeContainedSettings(pinned, settingsDir, settingsPath, rendered);
  } finally {
    closeSync(pinned.fd);
  }

  // 9. Confirm the worktree is still clean.
  if (probe.status(workspaceRoot, WORKSPACE_SETTINGS_RELATIVE_PATH).trim().length > 0) {
    throw new AntigravityWorkspaceSettingsError("workspace-dirty-after-write");
  }

  // 10. Install the runner-owned permission overlay AND the read-only tool
  //     registration into the global store — the layer `agy` 1.1.9 actually
  //     consults for both (§2.5, §2.6). This is the LAST
  //     mutation, so every refusal above still leaves the operator's global
  //     configuration untouched, and it is journalled so the entries can be
  //     removed deterministically on release or reclaimed after a crash.
  const overlay = installGlobalOverlay(globalSettingsPath, workspaceRoot, settings);

  return {
    policyVersion: WORKSPACE_SETTINGS_POLICY_VERSION,
    schemaPin: ANTIGRAVITY_SETTINGS_SCHEMA_PIN,
    relativePath: WORKSPACE_SETTINGS_RELATIVE_PATH,
    settingsSha256: workspaceSettingsSha256(rendered),
    settingsBytes: Buffer.byteLength(rendered, "utf8"),
    allowedTools: [...RESEARCH_ALLOWED_TOOLS],
    deniedTools: [...RESEARCH_DENIED_TOOLS],
    toolSurface: { core: [...RESEARCH_TOOL_SURFACE_CORE], exclude: [...RESEARCH_TOOL_SURFACE_EXCLUDE] },
    allowRuleCount: settings.permissions.allow.length,
    denyRuleCount: settings.permissions.deny.length,
    gitIgnored,
    trust: {
      status: registered ? "trusted-exact" : trust.status,
      containerPresent: trust.containerPresent,
      entryCount: trust.entryCount + (registered ? 1 : 0),
      registered,
      representation: registered ? "trustedWorkspaces" : trust.representation,
    },
    cliVersion,
    globalOverlay: {
      installed: true,
      allowRuleCount: overlay.allowRuleCount,
      denyRuleCount: overlay.denyRuleCount,
      toolSurfaceInstalled: overlay.toolSurfaceInstalled,
      reclaimed: overlay.reclaimed,
    },
    releaseHandle: { globalSettingsPath, journalPath: overlay.journalPath, launchesCli },
  };
}

/**
 * Install the runner-owned permission entries into the global store and record
 * the journal that makes their removal deterministic.
 *
 * Everything happens under the store's lock: the reclaim of dead overlays, the
 * read, the merge, the atomic replacement, and the journal write. The journal
 * is written *before* the store so a crash between the two leaves a journal
 * claiming rules that were never installed — reverting those is a no-op —
 * rather than installed rules nothing claims.
 *
 * Overlays for *different* workspaces are mutually exclusive (issue #830
 * review). The store's permission set is global: whatever is installed while an
 * agent runs is what that agent may do, so two workspaces overlapping there
 * would let each one's agent read the other's tree by absolute path. The store
 * lock cannot express that — it is held for a read-modify-write, not for the
 * agent's whole lifetime — so the *journals* do: a live overlay naming another
 * workspace makes installation wait for its release, and the run fails closed
 * with `global-overlay-contended` if it never comes.
 *
 * The same wait covers a co-tenant on *this* workspace whose journal no longer
 * accounts for the global tool-surface keys (issue #832 review): installing on
 * top of it would discard an operator edit that nothing could restore, so the
 * run waits for the co-tenant's release — which leaves the edit in place — and
 * fails closed the same way if it never comes.
 */
function installGlobalOverlay(
  globalSettingsPath: string,
  workspaceRoot: string,
  settings: AntigravityWorkspaceSettings,
): InstalledOverlay {
  const overlay = buildGlobalPermissionOverlay(settings, workspaceRoot);
  const deadline = Date.now() + OVERLAY_EXCLUSIVE_WAIT_MS;
  for (;;) {
    const attempt = withGlobalSettingsLock(globalSettingsPath, () =>
      tryInstallGlobalOverlay(globalSettingsPath, workspaceRoot, overlay),
    );
    if (attempt.installed !== null) return attempt.installed;
    if (Date.now() >= deadline) {
      throw new AntigravityWorkspaceSettingsError("global-overlay-contended", contentionDetail(attempt.contention));
    }
    sleepSync(OVERLAY_CONTENTION_POLL_MS);
  }
}

/**
 * The refusal text for an installation that never got the permission set to
 * itself.
 *
 * A blocker whose overlay is past the TTL is called out by name, because that
 * is the shape a *reused pid* takes: liveness follows the owning process and
 * nothing else (`journalIsLive`), so a journal an unrelated process has
 * inherited the pid of would otherwise block every later run with no way for an
 * operator to tell it apart from a genuinely long research run. Journal file
 * names only, never their directory: this reaches a bounded artifact (§8).
 *
 * A tool-surface handoff refusal names the changed keys instead of the
 * workspaces, because the actionable fact is different: nothing is wrong with
 * the other run, the operator's edit is simply not something this installation
 * could put back (issue #832 review).
 */
function contentionDetail(contention: OverlayContention): string {
  const changed = contention.changedSurfaceKeys ?? [];
  const base = changed.length > 0
    ? "the global tool-surface keys were changed while another research run for this workspace held them, and they "
      + `stayed that way for the whole wait; installing over them would discard that change (${changed.join(", ")}), `
      + `so it was refused instead (${contention.journalNames.join(", ")})`
    : "another research workspace's runner-owned permission entries were installed for the whole wait; "
      + `the global permission set cannot carry two workspaces at once (${contention.journalNames.join(", ")})`;
  if (!contention.stale) return base;
  return `${base}; one of them is older than the overlay TTL, so its owning process id may have been reused — if no `
    + `other research run is in flight, remove that journal from the ${OVERLAY_DIR_NAME} directory beside the global `
    + `settings file and retry`;
}

interface InstalledOverlay {
  allowRuleCount: number;
  denyRuleCount: number;
  /** Whether the read-only tool registration went in with the rules (issue #832). */
  toolSurfaceInstalled: boolean;
  reclaimed: number;
  journalPath: string;
}

/** Why an attempt backed off: the live overlays holding the shared permission
 * set right now — those of *other* workspaces, or a co-tenant of this one whose
 * journal no longer accounts for the tool-surface keys. */
interface OverlayContention {
  /** File names of the blocking journals — never their paths (§8). */
  journalNames: string[];
  /** At least one blocker is past the TTL; see `contentionDetail`. */
  stale: boolean;
  /**
   * Set when the back-off is a tool-surface handoff this run refused rather than
   * a workspace-exclusivity one (issue #832 review): the global surface keys
   * something else changed while a co-tenant overlay held them.
   */
  changedSurfaceKeys?: string[];
}

type InstallAttempt =
  | { installed: InstalledOverlay; contention?: undefined }
  | { installed: null; contention: OverlayContention };

/**
 * One attempt at installing the overlay, under the store's lock. Reports
 * contention — "try again later" — when another workspace's overlay is still
 * live.
 */
function tryInstallGlobalOverlay(
  globalSettingsPath: string,
  workspaceRoot: string,
  overlay: RunnerPermissionOverlay,
): InstallAttempt {
  const scan = scanOverlayJournals(globalSettingsPath);
  // Fail closed before anything is mutated. A journal the runner cannot parse
  // may name rules that are installed right now, and neither this installation
  // nor any later reclaim can remove them without it — so the honest answer is
  // to refuse and tell the operator which file to look at, not to install more
  // grants on top of a claim nobody can account for (issue #830 review).
  if (scan.damaged.length > 0) {
    // The detail names the file, never its directory: the bounded artifact this
    // reaches must not carry an absolute path (§8).
    throw new AntigravityWorkspaceSettingsError(
      "global-overlay-journal-damaged",
      `${scan.damaged.length} journal(s) in the ${OVERLAY_DIR_NAME} directory beside the global settings file could `
      + `not be parsed and may name permission entries that are still installed; inspect the store's permission `
      + `entries and then remove them (first: ${basename(scan.damaged[0] as string)})`,
    );
  }
  const snapshot = readGlobalStore(globalSettingsPath);

  // The trust decision is made again here, on the locked document, and it is
  // this one that gates the run (issue #830 review). The evaluation in step 6
  // reads the store without the lock, so an operator can revoke this workspace
  // between it and this transaction: either by writing an explicit `DO_NOT_TRUST`
  // entry, or by deleting the grant the run was relying on — which leaves the
  // workspace merely `untrusted`, not `distrusted`. Both revocations would
  // otherwise be preserved by the merge below and ignored by the run:
  // preparation would report success and `agy` would be invoked against a
  // workspace nobody trusts. A trusted parent still passes, exactly as in step 6.
  // Refusing here happens before anything is written, so the store is left
  // exactly as the revoking operator wrote it.
  const trust = evaluateWorkspaceTrust(snapshot.document, workspaceRoot).status;
  if (trust === "distrusted") {
    throw new AntigravityWorkspaceSettingsError("workspace-distrusted");
  }
  if (trust === "untrusted") {
    throw new AntigravityWorkspaceSettingsError("workspace-not-trusted");
  }

  const reclaim = reclaimDeadOverlays(snapshot.document, scan.journals);

  // Preparation runs once per headless invocation, so this process may already
  // hold an overlay from a previous turn. Superseding it — revert, then
  // reinstall — keeps exactly one journal per process, so a long-lived runner
  // never accumulates claims that only a later run could reclaim. Every journal
  // of this process qualifies, not just this workspace's: exclusivity means a
  // live overlay for another workspace cannot be a concurrent invocation of this
  // same process, so it is a leak from a run whose release failed — precisely
  // the entries the worker's long-lived pid would otherwise keep looking live
  // for as long as the worker runs, since age never retires an overlay.
  const superseded = reclaim.live.filter((journal) => journal.pid === process.pid);
  const live = reclaim.live.filter((journal) => !superseded.includes(journal));
  let document = reclaim.document;
  for (const journal of superseded) {
    document = revertPermissionOverlay(document, journal, live.map(liveClaimOf));
  }
  // The superseded journal files are NOT removed yet: until the replacement
  // journal and the new store are both on disk, they are the only record of
  // what this process already installed. Removing them first would, on a
  // failed write below, leave those entries in the store with nothing naming
  // them — unreleasable and unreclaimable.
  //
  // They are *retired* here instead, before anything is written. A retired
  // journal still names its rules, so the crash-safety argument above is
  // unchanged, but it no longer reads as live — which is what the rest of the
  // lifecycle depends on (issue #830 review). These journals carry this very
  // process's pid, so one that survives (its removal below can be refused by an
  // ACL or an immutable flag) would keep answering "alive" for as long as the
  // worker runs: installation would see a phantom claimant, and this run's own
  // release would hold its overlay's rules in place for it while reporting a
  // clean release. Retiring cannot be worked around, so a journal that resists
  // even the rewrite fails the run closed, with the store still untouched.
  for (const journal of superseded) {
    if (!retireJournalAt(journal.path, journalRecord(journal))) {
      // File name only, never its directory: this reaches a bounded artifact (§8).
      throw new AntigravityWorkspaceSettingsError(
        "global-settings-write-failed",
        `a superseded overlay journal of this process could not be retired, so its permission entries would keep `
        + `reading as claimed by a live run (${basename(journal.path)})`,
      );
    }
  }

  // Originals recorded by the overlays this attempt reverted: the store's own
  // bytes are no longer the restore target once anything has been taken out of
  // it, so a formatting only they hold is carried forward through them.
  const inherited = [...reclaim.baselines, ...recordedBaselines(superseded)];

  // Exclusivity check. Another run on the SAME workspace is not contention: its
  // grants are this run's grants, scoped to the same tree, and the claim
  // bookkeeping already releases each rule with the last claim on it.
  const foreign = live.filter((journal) => journal.workspaceRoot !== workspaceRoot);
  if (foreign.length > 0) {
    // Commit whatever the reclaim and the supersede removed before backing off,
    // so the store never carries entries no journal claims, and only then drop
    // the superseded journals.
    commitReclaimOnly(globalSettingsPath, document, snapshot, inherited);
    // The commit above took these entries back out, so a file that resists
    // removal is marked settled: the next pass deletes it rather than
    // reverting rules that are already gone. The reclaimed journals settle here
    // too, and only here — before the commit their claims are still the store's
    // (issue #830 review).
    settleCommittedJournals([...reclaim.dead, ...superseded]);
    const now = Date.now();
    return {
      installed: null,
      contention: {
        journalNames: foreign.map((journal) => basename(journal.path)),
        stale: foreign.some((journal) => journalIsPastTtl(journal, now)),
      },
    };
  }

  // Tool-surface handoff (issue #832 review). A co-tenant's journal is where the
  // operator's own `tools` / `mcpServers` / `autoAccept` values live while an
  // overlay is installed, and this installation inherits them from it rather
  // than re-reading a document that already carries the runner's registration.
  // A key something else wrote since that co-tenant went in is therefore
  // accounted for by nobody: installing over it now would leave whichever run is
  // last out restoring the value from before the edit and discarding it — the
  // very preservation `restoreSurface` guarantees when a single overlay is
  // involved.
  //
  // Backing off resolves it without a lost edit: the co-tenant's own release
  // leaves a key it no longer recognizes exactly as found, so the retry after it
  // records the operator's real values. Reported as contention, because that is
  // what it is — the wait ends when the co-tenant releases.
  const changedSurfaceKeys = detectSurfaceHandoffDrift(document, live);
  if (changedSurfaceKeys.length > 0) {
    // Same commit-then-back-off order as the exclusivity refusal above: whatever
    // the reclaim and the supersede took out is committed first, so the store
    // never carries entries no journal claims.
    commitReclaimOnly(globalSettingsPath, document, snapshot, inherited);
    settleCommittedJournals([...reclaim.dead, ...superseded]);
    const now = Date.now();
    return {
      installed: null,
      contention: {
        journalNames: live.map((journal) => basename(journal.path)),
        stale: live.some((journal) => journalIsPastTtl(journal, now)),
        changedSurfaceKeys,
      },
    };
  }

  const applied = applyPermissionOverlay(document, overlay, live);

  const dir = overlayDir(globalSettingsPath);
  const journalPath = join(dir, journalFileName(workspaceRoot));
  // Recorded before the store is replaced, because the replacement is what
  // makes the original bytes unreachable to every later step.
  //
  // A live co-tenant — another run on this very workspace, which exclusivity
  // permits — may hold the only copy of the operator's original bytes, and its
  // journal goes away when it releases, which can happen before this run's does
  // (issue #830 review). Its baseline is therefore carried into this journal so
  // that whichever run is last out still has the bytes to restore. It wins over
  // anything derived from the store as it stands, because the store as it
  // stands already carries that co-tenant's entries whereas its baseline
  // predates every overlay; the oldest is the one furthest from them all.
  const baseline = oldestRecordedBaseline(live) ?? baselineToRecord(snapshot, document, inherited);
  const journal = {
    version: 1 as const,
    workspaceRoot,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...(baseline === undefined ? {} : { baseline }),
    ...applied.journal,
  };
  try {
    writeJournalDurably(journalPath, JSON.stringify(journal, null, 2) + "\n");
  } catch {
    throw new AntigravityWorkspaceSettingsError(
      "global-settings-write-failed",
      "the runner-owned overlay journal could not be written",
    );
  }
  try {
    writeGlobalStoreAtomically(globalSettingsPath, renderGlobalDocument(applied.document, snapshot.raw));
  } catch (err) {
    // The journal names entries this failed write never installed. Leaving it
    // live would make every later pass hold those rules in place for a claim
    // nothing owns, so an unremovable one is retired instead — and settled,
    // because the store was replaced atomically or not at all: there is nothing
    // here for a later pass to revert.
    if (!removeJournalFile(journalPath)) retireJournalAt(journalPath, journal, true);
    throw err;
  }
  // Both writes committed: the superseded and reclaimed journals now describe
  // entries the store no longer carries on their behalf, so they can go. A crash
  // in this window leaves them behind, and reverting them is harmless — the
  // replacement journal is live, so every rule it claims is held in place.
  //
  // The superseded ones were retired before the writes above, so removal is the
  // tidy-up, not the guarantee: a file that resists it is already non-live, and
  // marking it settled keeps the next pass from reverting entries this run has
  // just reinstalled under its own journal. The reclaimed ones are settled for
  // the same reason, and only now that their revert is on disk.
  settleCommittedJournals([...reclaim.dead, ...superseded]);
  return {
    installed: {
      allowRuleCount: overlay.allow.length,
      denyRuleCount: overlay.deny.length,
      toolSurfaceInstalled: true,
      reclaimed: reclaim.reclaimed,
      journalPath,
    },
  };
}

/**
 * Persist a document that only *lost* runner-owned entries (a reclaim, a
 * supersede) without installing anything. The reverted overlays' recorded
 * originals are offered, so a store an earlier installation had to re-render
 * comes back in its own formatting. Skipped when the result is byte-identical
 * to what was found, so a store nobody touched is never rewritten.
 */
function commitReclaimOnly(
  globalSettingsPath: string,
  document: Record<string, unknown>,
  snapshot: GlobalStoreSnapshot,
  baselines: readonly string[],
): void {
  if (snapshot.raw === null && Object.keys(document).length === 0) return;
  const rendered = renderGlobalDocumentRestoring(document, snapshot.raw, baselines);
  if (rendered === snapshot.raw) return;
  writeGlobalStoreAtomically(globalSettingsPath, rendered);
}

/**
 * Remove the runner-owned permission entries this run installed.
 *
 * Deterministic and idempotent: the journal names exactly what was added, a
 * rule any other still-installed overlay claims is left in place, and a
 * missing journal (already released, or reclaimed by another run) is a no-op.
 * A journal that is *present but unparseable* is not the same thing as a
 * missing one, so this run's own damaged journal is reported rather than
 * counted as a release that removed nothing (issue #830 review).
 * The rules the operator already had — suspended at install time and recorded
 * in the journal — are put back by the last overlay out, so an unrelated store
 * comes back as it was found.
 *
 * The research handler calls this in a `finally`, so the entries do not outlive
 * the invocation on either the success or the failure path; if the process dies
 * before it runs, the journal is reclaimed by the next run to take the lock.
 */
export function releaseAntigravityWorkspaceSettings(prepared: PreparedWorkspaceSettings): void {
  const handle = prepared.releaseHandle;
  // Absent as well as null: a preparer seam substituted in a test may report a
  // profile it never installed, and releasing nothing is the correct no-op.
  if (!handle) return;
  withGlobalSettingsLock(handle.globalSettingsPath, () => {
    const scan = scanOverlayJournals(handle.globalSettingsPath);
    const ours = scan.journals.find((journal) => journal.path === handle.journalPath);
    if (ours === undefined) {
      // Our own journal being the unparseable one is the one case release
      // cannot work around: the entries it names are installed and nothing
      // else on the machine can identify them. Fail loudly (the research
      // handler retries and then fails the phase) instead of reporting a
      // release that did not happen.
      if (scan.damaged.includes(handle.journalPath)) {
        throw new AntigravityWorkspaceSettingsError(
          "global-overlay-journal-damaged",
          `this run's overlay journal could not be parsed, so its permission entries could not be removed `
          + `from the global settings (${basename(handle.journalPath)})`,
        );
      }
      return;
    }
    // Already released once, and only the file outlived it (`settleJournalFile`).
    // Reverting a second time would remove a matching rule the operator has
    // added since, so this pass just retries the deletion that failed then.
    if (ours.settled === true) {
      removeJournalFile(ours.path);
      return;
    }
    const snapshot = readGlobalStore(handle.globalSettingsPath);
    const others = scan.journals.filter((journal) => journal !== ours && journalIsLive(journal));
    // A damaged journal counts as an unidentifiable live claim. Its rules are
    // unknown, so nothing can be held in place for it — but it does suppress
    // the "last overlay out" restoration of the operator's suspended `allow`
    // rules, which is the fail-closed direction: re-admitting them while some
    // other overlay may still be installed would widen that run's grants. It
    // suppresses the tool-surface restoration for the same reason, by leaving
    // `holdsSurface` unset: the record it would have to be read from is exactly
    // what could not be parsed (issue #832 review).
    const unknown = scan.damaged.map(() => ({ allow: [] as string[], deny: [] as string[] }));
    const reverted = revertPermissionOverlay(
      snapshot.document,
      ours,
      [...others.map(liveClaimOf), ...unknown],
    );
    writeGlobalStoreAtomically(
      handle.globalSettingsPath,
      // This run's own recorded original, if it had to record one: the store it
      // found is what "restored" means, and the bytes in it are the only copy of
      // a formatting installation could not reproduce (issue #830 review).
      renderGlobalDocumentRestoring(reverted, snapshot.raw, recordedBaselines([ours])),
    );
    // The entries are out of the store, but the journal must stop reading as a
    // live claim too: it carries this process's pid, so a leftover would make a
    // long-lived worker's next release hold rules in place for a run that is
    // over. Retiring it as settled is enough (it is then dead for every later
    // pass, and no pass reverts a release that already happened); a file that
    // resists even that is reported rather than counted as released.
    if (!settleJournalFile(ours)) {
      throw new AntigravityWorkspaceSettingsError(
        "global-overlay-release-failed",
        `the run's overlay journal could neither be removed nor retired, so it would keep reading as a live claim `
        + `on runner-owned permission entries (${basename(handle.journalPath)})`,
      );
    }
  });
}

/**
 * Re-verify, at the last possible moment before the CLI is launched, that the
 * settings *pathname* still names the profile preparation generated.
 *
 * `writeContainedSettings` verifies the descriptor it opened, which proves what
 * was written but says nothing about what the path resolves to afterwards. `agy`
 * resolves `<workspace>/.gemini/settings.json` itself at startup, so anything
 * able to write inside the workspace between preparation and launch could rename
 * the generated file away and drop a broader regular file in its place — the
 * agent would then run under a profile the runner never authored, while the
 * bounded artifact still recorded the generated hash.
 *
 * This closes that window by re-resolving the pathname the CLI will resolve and
 * comparing the bytes behind it, by descriptor, to the prepared size and hash.
 * The check runs immediately before the invocation (and again before every later
 * evidence turn's invocation), so a replacement can only land inside the
 * remaining sub-millisecond gap; anything earlier fails the run closed rather
 * than launching under an unverified profile. It is read-only: a mismatch is
 * never "repaired" in place, because the safe response to an unexplained profile
 * is to refuse, not to overwrite whatever else the workspace now holds.
 */
export function verifyPreparedWorkspaceSettings(
  workspaceRoot: string,
  prepared: PreparedWorkspaceSettings,
): void {
  // Resolve exactly as preparation did, so both agree on the pathname the CLI
  // will load — a root swapped for a link to another tree fails here.
  let root: string;
  try {
    root = realpathSync.native(workspaceRoot);
    if (!statSync(root).isDirectory()) {
      throw new AntigravityWorkspaceSettingsError("workspace-root-unresolvable", "the workspace root is not a directory");
    }
  } catch (err) {
    if (err instanceof AntigravityWorkspaceSettingsError) throw err;
    throw new AntigravityWorkspaceSettingsError("workspace-root-unresolvable");
  }

  const settingsDir = join(root, WORKSPACE_SETTINGS_DIR);
  const settingsPath = join(settingsDir, WORKSPACE_SETTINGS_FILENAME);
  if (resolve(settingsPath) !== settingsPath || !settingsPath.startsWith(`${root}/`)) {
    throw new AntigravityWorkspaceSettingsError("settings-path-escapes-workspace");
  }
  // `.gemini` is the only component below the resolved root, so a link check
  // plus a real-path comparison covers the whole remaining path.
  assertNotSymlink(settingsDir, "settings-dir-symlink");
  let realDir: string;
  try {
    realDir = realpathSync.native(settingsDir);
  } catch {
    throw new AntigravityWorkspaceSettingsError("settings-replaced-before-launch", "the settings directory could not be resolved");
  }
  if (realDir !== settingsDir) {
    throw new AntigravityWorkspaceSettingsError("settings-path-escapes-workspace");
  }

  let fd: number;
  try {
    fd = openSync(settingsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new AntigravityWorkspaceSettingsError("settings-symlink");
    throw new AntigravityWorkspaceSettingsError(
      "settings-replaced-before-launch",
      `the settings file could not be opened for verification (${code ?? "unknown"})`,
    );
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== prepared.settingsBytes) {
      throw new AntigravityWorkspaceSettingsError("settings-replaced-before-launch", "the settings file is not the generated file");
    }
    // Read from the descriptor, not the path: the bytes compared are the bytes
    // behind the name the CLI just resolved.
    const buf = Buffer.alloc(prepared.settingsBytes);
    let read = 0;
    try {
      let n = 0;
      do {
        n = readSync(fd, buf, read, buf.length - read, read);
        read += n;
      } while (n > 0 && read < buf.length);
    } catch {
      throw new AntigravityWorkspaceSettingsError("settings-replaced-before-launch", "the settings file could not be read back");
    }
    if (read !== prepared.settingsBytes || workspaceSettingsSha256(buf.toString("utf8")) !== prepared.settingsSha256) {
      throw new AntigravityWorkspaceSettingsError("settings-replaced-before-launch", "the settings file content no longer matches the generated profile");
    }
  } finally {
    closeSync(fd);
  }

  verifyGlobalOverlayInstalled(prepared);
}

/**
 * Re-verify that the global overlay is still exactly what preparation installed.
 *
 * The workspace document is only half the profile now: the rules the CLI applies
 * live in the global store (§2.5), which anything on the machine may edit. If
 * this run's journal is gone, or any rule it claims is no longer in the store,
 * the agent would run under a permission set the runner cannot state — the same
 * condition `settings-replaced-before-launch` already covers for the workspace
 * file, so it fails the same way. Like that check it is read-only: a mismatch is
 * refused, never repaired in place.
 */
function verifyGlobalOverlayInstalled(prepared: PreparedWorkspaceSettings): void {
  const handle = prepared.releaseHandle;
  if (!handle) return;
  assertHandleStillNamesTheStoreTheCliLoads(handle);
  const scan = scanOverlayJournals(handle.globalSettingsPath);
  // Installation refuses while any journal is unparseable, so one here appeared
  // after preparation: the store may carry entries no readable claim accounts
  // for, and this run's own bookkeeping may be among them. That is the same
  // "the profile is no longer what was prepared" condition as below.
  if (scan.damaged.length > 0) {
    throw new AntigravityWorkspaceSettingsError(
      "settings-replaced-before-launch",
      "a runner-owned overlay journal became unparseable after preparation",
    );
  }
  const journals = scan.journals;
  const ours = journals.find((journal) => journal.path === handle.journalPath);
  if (ours === undefined) {
    throw new AntigravityWorkspaceSettingsError(
      "settings-replaced-before-launch",
      "the runner-owned overlay journal was removed after preparation",
    );
  }
  // A retired journal is the same condition by another name: the claim was
  // given up (a later preparation superseded it, or a release could not unlink
  // it) and only the record outlived it, so the rules it names are no longer
  // held for this run.
  if (ours.retired === true) {
    throw new AntigravityWorkspaceSettingsError(
      "settings-replaced-before-launch",
      "the runner-owned overlay journal was retired after preparation",
    );
  }
  const document = readGlobalStore(handle.globalSettingsPath).document;
  const container = document["permissions"];
  const installed = (key: "allow" | "deny"): Set<string> => {
    if (!container || typeof container !== "object" || Array.isArray(container)) return new Set();
    const value = (container as Record<string, unknown>)[key];
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((entry): entry is string => typeof entry === "string"));
  };
  for (const key of ["allow", "deny"] as const) {
    const present = installed(key);
    if (ours.claim[key].some((rule) => !present.has(rule))) {
      throw new AntigravityWorkspaceSettingsError(
        "settings-replaced-before-launch",
        `the runner-owned ${key} entries are no longer installed in the global settings`,
      );
    }
  }
  // The other half of the isolation guarantee: preparation suspended every
  // allow rule the operator had, so at launch the store may grant nothing but
  // what a runner overlay for THIS workspace claims. An allow rule that
  // reappeared in the window would be inherited by this invocation — possibly a
  // write or command capability, or a read grant on another workspace's tree —
  // so it fails closed rather than launching under it. Restricting the accepted
  // claims to this workspace's journals is what enforces the exclusivity
  // installation established (issue #830 review) at the moment it matters:
  // whatever the store carries when the agent starts is what the agent may do.
  // Claims of same-workspace journals whose run has since died count here: their
  // entries are reclaimed by the next holder of the lock, they grant nothing
  // this run is not already granted, and a crashed peer must not fail this run.
  const claimed = new Set(
    journals
      .filter((journal) => journal.workspaceRoot === ours.workspaceRoot)
      .flatMap((journal) => journal.claim.allow),
  );
  if ([...installed("allow")].some((rule) => !claimed.has(rule))) {
    throw new AntigravityWorkspaceSettingsError(
      "settings-replaced-before-launch",
      "the global settings carry an allow entry no runner overlay installed",
    );
  }
  // The tool surface is verified the same way and for the same reason (issue
  // #832): it is what decides which tools the CLI registers, so a `tools`,
  // `mcpServers`, or `autoAccept` key that changed after preparation would launch
  // the agent with a tool set the runner cannot state — including, in the case
  // this issue is about, a command-capable one.
  const surface = ours.surface;
  if (surface !== undefined) {
    for (const key of Object.keys(surface.installed)) {
      const current = Object.prototype.hasOwnProperty.call(document, key) ? document[key] : undefined;
      if (canonicalJson(current) !== canonicalJson(surface.installed[key])) {
        throw new AntigravityWorkspaceSettingsError(
          "settings-replaced-before-launch",
          `the runner-owned read-only tool surface is no longer installed in the global settings (${key})`,
        );
      }
    }
  }
}

/**
 * Re-derive the store `agy` will load and refuse unless it is still the file
 * this run's overlay lives in (issue #830 review).
 *
 * The canonical pathname may be a symlink, and preparation keyed everything —
 * lock, journal directory, reads, writes — off the target it resolved to at the
 * time. Repointing that link afterwards is a supported operator action, and it
 * moves the store *without touching a single byte the checks below inspect*: the
 * old target still carries this run's journal and its rules, so every one of
 * them passes, while the CLI about to start reads the new target and runs under
 * whatever permissions it happens to carry — possibly the broad set preparation
 * exists to suspend. Resolving the canonical path again here is what ties the
 * verification to the file the agent will actually read.
 *
 * A fixture run answers the version probe instead of executing a binary and
 * launches no CLI, so it is allowed to name another store — the same exemption
 * `assertStoreIsTheOneTheCliLoads` makes at preparation time.
 */
function assertHandleStillNamesTheStoreTheCliLoads(
  handle: NonNullable<PreparedWorkspaceSettings["releaseHandle"]>,
): void {
  if (!handle.launchesCli) return;
  let current: string;
  try {
    current = resolveGlobalStoreIdentity(canonicalGlobalSettingsPath());
  } catch {
    // Unresolvable now (a dangling link, an inaccessible ancestor) is the same
    // answer as "not the store prepared": nothing can vouch for what the CLI
    // will read. The detail names no path — it reaches a bounded artifact (§8).
    throw new AntigravityWorkspaceSettingsError(
      "settings-replaced-before-launch",
      "the global Antigravity settings store the CLI loads could not be resolved before launch",
    );
  }
  if (current !== handle.globalSettingsPath) {
    throw new AntigravityWorkspaceSettingsError(
      "settings-replaced-before-launch",
      "the global Antigravity settings store the CLI loads is no longer the file this run's permission overlay "
      + "was installed in",
    );
  }
}

/** The preparer seam the research handler injects (tests substitute a fake). */
export type WorkspaceSettingsPreparer = (
  input: PrepareWorkspaceSettingsInput,
) => PreparedWorkspaceSettings;

/** The launch-time verification seam, injected alongside the preparer. */
export type WorkspaceSettingsVerifier = (
  workspaceRoot: string,
  prepared: PreparedWorkspaceSettings,
) => void;

/** The end-of-run release seam (issue #830), injected alongside the preparer. */
export type WorkspaceSettingsReleaser = (prepared: PreparedWorkspaceSettings) => void;
