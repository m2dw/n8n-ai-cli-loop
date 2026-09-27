import { execFileSync, spawn, spawnSync } from "child_process";
import type {
  ExecFileSyncOptionsWithStringEncoding,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TRANSIENT_SPAWN_RETRY_BACKOFF_MS,
  classifyProbeFailure,
  isRetryableProbeFailure,
  probeSucceeded,
} from "../core/cli-probe.js";
import type { CliProbeOutcome } from "../core/cli-probe.js";

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * A RUNNER-synthesized diagnostic for a spawn-level failure (timeout, buffer
   * overflow, `ENOENT`) — bytes the child process never wrote.
   *
   * A runner that sets this MUST also have appended it VERBATIM to the end of
   * `stderr`, so every caller that only reads `stderr` keeps seeing the
   * diagnostic exactly as before. It exists for the callers that promise to
   * persist only child-authored output — the reviewer-reconsideration raw
   * transcript (issue #838, contract §10.2) may hold the agent's bytes and
   * nothing else — which strip precisely this suffix rather than guessing which
   * trailing bytes the child did not write.
   */
  spawnError?: string;
  /**
   * The spawn-level failure above was the RUNNER's own deadline (`opts.timeout`)
   * expiring, not the child refusing.
   *
   * Reported as a typed fact rather than left to be read out of `spawnError`'s
   * text: a caller that must route a deadline differently from a nonzero exit —
   * the reviewer reconsideration turn does, contract §12 (issue #953) — would
   * otherwise have to match on Node's own rendering of an `ETIMEDOUT` error, and
   * a phrasing change upstream would silently reclassify every timeout as an
   * ordinary agent failure. Absent means "not a deadline", which is the
   * conservative direction: an unrecognized spawn error stays the run failure it
   * already was.
   */
  timedOut?: boolean;
  /**
   * The signal that terminated the child, when one did (`SIGTERM` from the
   * runner's own deadline, `SIGKILL` from an OOM killer, …).
   *
   * A signalled child has NO exit status of its own — the `exitCode: 1` above is
   * the runner's stand-in, not something the command said. Without this field a
   * killed process is indistinguishable from a command that ran and reported
   * failure, which is exactly how a killed `npm ci` came to be read as a broken
   * package tree (issue #1060).
   */
  signal?: string;
  /**
   * The errno of a spawn-level failure (`ETIMEDOUT`, `ENOENT`, `ENOBUFS`,
   * `EACCES`, …), preserved rather than reduced to prose. Absent when the child
   * started and exited on its own.
   */
  spawnErrorCode?: string;
  /** Wall-clock milliseconds from the spawn attempt to the runner regaining control. */
  durationMs?: number;
  /** OS pid of the spawned child, when one was created. */
  pid?: number;
  /**
   * The external deadline watchdog had to `SIGKILL` the child's process group
   * because the child outlived the `SIGTERM` its own deadline sent
   * (see {@link startDeadlineWatchdog}).
   *
   * Doubles as the only unambiguous proof the deadline actually elapsed: the
   * watchdog records itself only after finding the child still alive past
   * `opts.timeout` + {@link DEADLINE_ESCALATION_GRACE_MS}.
   */
  deadlineEscalated?: boolean;
  /**
   * What the runner did about the child's own descendants after having to kill
   * it. Present only when `isolateProcessGroup` was requested and a kill
   * happened; see {@link terminateProcessTree}.
   */
  processTreeCleanup?: ProcessTreeCleanup;
}

/**
 * The record of a post-kill process-tree sweep (issue #1060).
 *
 * The synchronous child APIs signal only the DIRECT child when `opts.timeout`
 * expires. Anything that child spawned — an `npm ci` fetch pool, a package
 * manager daemon — is reparented to init and keeps running, keeps holding the
 * cache locks the next attempt will block on, and is invisible to the next run's
 * diagnostics. This records what was actually reached, so an operator reading
 * the artifact can tell "the tree was cleaned up" from "cleanup could not be
 * attempted on this host".
 */
export interface ProcessTreeCleanup {
  /** The direct child the sweep was anchored on. */
  pid: number;
  /**
   * The child ran in its own process group and that group is CONFIRMED gone —
   * it had already exited by the end of the grace period, the sweep successfully
   * delivered it a `SIGKILL`, which nothing can ignore, or the process table
   * shows no live member of it left.
   *
   * This is the only mechanism that reaches grandchildren the dying child
   * already orphaned: once the direct child exits, its children are reparented
   * and no longer discoverable through it, but they stay in its process group.
   *
   * `false` therefore means "not confirmed", never "confirmed clean": a group
   * that still has live members after the sweep was refused permission to signal
   * it is reported here as an unsuccessful cleanup, with the errno in
   * {@link processGroupSignalError}, because those processes may still be running
   * and still holding the cache locks the next attempt will block on.
   */
  processGroupTerminated: boolean;
  /**
   * The errno that stopped the sweep from signalling a group the process table
   * still shows live members of (`EPERM` on a group that is not ours to signal,
   * …).
   *
   * Present only alongside `processGroupTerminated: false`, and it is what
   * separates the two ways that flag can be false: no group left to signal —
   * the ordinary, benign case — versus a live group the sweep could not reach.
   */
  processGroupSignalError?: string;
  /**
   * The sweep could NOT confirm the tree is gone: descendants may still be
   * running (issue #1106). Set on every platform's unsuccessful path — beside
   * {@link processGroupSignalError} on POSIX, and on Windows when `taskkill`
   * could not be launched or did not terminate the tree, where no errno exists.
   * Absent on success and on the benign "no group left to signal" case.
   */
  terminationUnconfirmed?: true;
  /** Descendants still parented to `pid` that had to be signalled individually. */
  terminatedDescendants: number[];
  /** Of those, the ones that ignored `SIGTERM` and needed `SIGKILL`. */
  forceKilled: number[];
  /** Why the sweep could do nothing, or less than everything, when that is the case. */
  note?: string;
}

export interface CommandRunOptions {
  cwd: string;
  /** When provided, written to the process stdin. */
  stdin?: string;
  /**
   * The child's environment. Defaults to the runner's own (see {@link spawnEnv});
   * supply it only to run a command under a DIFFERENT environment than this
   * process's — e.g. the isolated, credential-stripped env the read-only
   * reviewer-reconsideration invocation spawns its agent with (issue #838).
   */
  env?: NodeJS.ProcessEnv;
  /** Maximum time in milliseconds the command is allowed to run. */
  timeout?: number;
  /** Maximum bytes allowed in the combined stdout+stderr buffer. */
  maxBuffer?: number;
  /**
   * Run the child in its own process group and, when the runner has to kill it,
   * terminate that whole group instead of the direct child alone (issue #1060).
   *
   * Opt-in rather than the default: it changes how the child sits in the
   * process hierarchy, and only the callers that spawn a *tree* — a package
   * manager that forks a fetch pool — need it. A caller that runs `git` or `gh`
   * has nothing to sweep and should not pay for the behaviour change.
   */
  isolateProcessGroup?: boolean;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts: CommandRunOptions): CommandRunResult;
}

/**
 * The environment children are spawned with. This is the same value both
 * `execFileSync` and `spawnSync` already default to, but that default is read
 * from the *real* process object, while a test sandbox hands this module a copy
 * of `process.env`: without passing it explicitly, a child (and its `PATH`
 * lookup) silently uses the real environment instead of the one the caller can
 * observe — e.g. the host's `agy` rather than the stub a test put on `PATH`.
 * Mirrors src/cli/session-audit.ts, which passes it for the same reason.
 *
 * Exported so the spawn sites that do not go through a {@link CommandRunner} —
 * `admin`'s `probe()` and the default `gh` executor — can state the same thing
 * once instead of restating the rationale at each call (issue #1018).
 */
export function spawnEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/** The signal `child_process` sends a child that outran `opts.timeout`. */
const TIMEOUT_KILL_SIGNAL = "SIGTERM";

/** Grace period between the tree's `SIGTERM` and the `SIGKILL` that follows it. */
export const PROCESS_TREE_KILL_GRACE_MS = 250;

/** Budget for the helper commands (`ps`, `taskkill`) the sweep itself spawns. */
const PROCESS_TREE_HELPER_TIMEOUT_MS = 5_000;

function errnoCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * The typed facts about how a child stopped, read from whichever shape the
 * synchronous child API produced.
 *
 * Two shapes must be accepted. `spawnSync` hands back the errno error itself, so
 * `code` is on it directly. `execFileSync` re-wraps: it throws a generic Error
 * carrying the whole `spawnSync` result as properties, which puts the original
 * errno error one level down under `error` and leaves the thrown object's own
 * `code` undefined. Reading only the top-level `code` — as this module did
 * before issue #1060 — silently loses every `execFileSync` timeout.
 *
 * The `SIGTERM`-without-status fallback mirrors `core/cli-probe.ts`'s
 * `classifyProbeFailure`: older Node shapes surface only the signal
 * `child_process` sent. It is applied only when the deadline is known to have
 * ELAPSED — not merely to have been configured. Environment preparation always
 * configures one, so "a timeout exists" is no evidence at all: a child that
 * `SIGTERM`s itself, or that an operator or supervisor terminates a second into
 * a five-minute budget, produces exactly this shape and would otherwise be
 * reported as having reached a deadline it never came near
 * (see {@link deadlineHasExpired}).
 */
function readTerminationFacts(
  raw: unknown,
  deadlineExpired: boolean,
): { spawnErrorCode?: string; signal?: string; timedOut?: boolean; pid?: number } {
  const e = (typeof raw === "object" && raw !== null ? raw : {}) as {
    error?: unknown;
    status?: unknown;
    signal?: unknown;
    pid?: unknown;
  };
  const code = errnoCode(raw) ?? errnoCode(e.error);
  const signal = typeof e.signal === "string" && e.signal !== "" ? e.signal : undefined;
  const exitCode = typeof e.status === "number" ? e.status : undefined;
  const timedOut =
    code === "ETIMEDOUT" ||
    // Only when NO errno survived at all: a buffer overflow also kills the child
    // with `SIGTERM` and no exit status, so an `ENOBUFS` that IS reported must
    // stay a spawn error rather than be relabelled as a deadline.
    (code === undefined &&
      deadlineExpired &&
      exitCode === undefined &&
      signal === TIMEOUT_KILL_SIGNAL);
  return {
    ...(code === undefined ? {} : { spawnErrorCode: code }),
    ...(signal === undefined ? {} : { signal }),
    ...(timedOut ? { timedOut: true } : {}),
    ...(typeof e.pid === "number" && e.pid > 0 ? { pid: e.pid } : {}),
  };
}

/** Is this pid still around? A failed signal-0 means it is not ours to reach. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to someone else.
    return errnoCode(err) === "EPERM";
  }
}

/**
 * Send a signal and report whether it was actually delivered, keeping the errno
 * of a refusal.
 *
 * The errno is what separates the refusals: `ESRCH` means the target is already
 * gone, while `EPERM` means the signal was not ours to send — and a sweep that
 * reports the second as a successful cleanup can be claiming to have released
 * locks that are still held (issue #1060 review, P2). For a process GROUP that
 * errno is not conclusive on its own; see {@link liveProcessGroupMembers}.
 */
function signalOutcome(
  target: number,
  signal: NodeJS.Signals,
): { delivered: boolean; code?: string } {
  try {
    process.kill(target, signal);
    return { delivered: true };
  } catch (err: unknown) {
    return { delivered: false, code: errnoCode(err) };
  }
}

function signalQuietly(target: number, signal: NodeJS.Signals): boolean {
  // ESRCH (already gone) and EPERM (not ours) are both "nothing more to do"
  // for the callers that only need to know whether the signal landed.
  return signalOutcome(target, signal).delivered;
}

/**
 * Every process still parented — directly or transitively — to `pid`.
 *
 * A single `ps` snapshot rather than a walk per level: the tree must be read
 * from one consistent view, and each extra spawn is another chance for the
 * hierarchy to shift underneath the sweep.
 */
export function listDescendantPids(pid: number): number[] {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    timeout: PROCESS_TREE_HELPER_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (ps.error || typeof ps.stdout !== "string") return [];

  const childrenOf = new Map<number, number[]>();
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const child = Number(match[1]);
    const parent = Number(match[2]);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(child);
    else childrenOf.set(parent, [child]);
  }

  // Breadth-first from `pid` only, so the walk can never climb toward our own
  // process; `seen` also stops a recycled-pid cycle from looping forever.
  const descendants: number[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    for (const child of childrenOf.get(next) ?? []) {
      if (child <= 1 || child === process.pid || seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * The live (non-zombie) members of process group `pgid`, or `undefined` when the
 * host would not answer — "`ps` told us nothing" must never be read as "nothing
 * is left".
 *
 * This exists because the errno of a refused GROUP signal cannot answer the only
 * question the sweep cares about. A group id is not a process: macOS reports
 * `EPERM` when a group signal could not be delivered to any member, and a group
 * whose last member is an unreaped zombie has no member to deliver to — which is
 * exactly the state a just-terminated group is in while the runner is still
 * inside this synchronous sweep and has not run its event loop to reap. That
 * errno therefore covers both "not ours to signal" and "nothing left to signal",
 * and only a direct look at the process table separates them.
 *
 * Zombies are excluded deliberately: one holds no lock and is about to
 * disappear, so counting it would report survivors that no longer exist.
 */
function liveProcessGroupMembers(pgid: number): number[] | undefined {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], {
    encoding: "utf8",
    timeout: PROCESS_TREE_HELPER_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (ps.error || typeof ps.stdout !== "string") return undefined;

  const members: number[] = [];
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const memberPid = Number(match[1]);
    const memberPgid = Number(match[2]);
    if (!Number.isInteger(memberPid) || memberPgid !== pgid) continue;
    if (memberPid <= 1 || memberPid === process.pid) continue;
    if (match[3].startsWith("Z")) continue;
    members.push(memberPid);
  }
  return members;
}

/**
 * Terminate `pid`'s process tree after the runner had to kill it (issue #1060).
 *
 * Two mechanisms, because neither alone is sufficient:
 *
 *  1. **Process group.** When the child was spawned with `isolateProcessGroup`
 *     it is its own group leader, so signalling `-pid` reaches every descendant
 *     — including the ones already orphaned by the child's own death, which no
 *     parent-walk can find any more. Probed first with signal 0: if no such
 *     group exists the child was not isolated, and `-pid` cannot name our own
 *     group by accident (a group id equals its leader's pid, and this pid's
 *     leader is us).
 *  2. **Parent walk.** For a child that outlived the kill signal — one that traps
 *     `SIGTERM`, or a host where group isolation is unavailable — descendants are
 *     still reachable through it, so they are swept individually, deepest first
 *     so killing a parent cannot hide its children from the same pass.
 *
 * Best-effort throughout: this runs on a path that has already failed, and a
 * host that will not let us enumerate or signal is recorded in `note` rather
 * than turned into a second failure.
 */
export function terminateProcessTree(pid: number): ProcessTreeCleanup {
  const cleanup: ProcessTreeCleanup = {
    pid,
    processGroupTerminated: false,
    terminatedDescendants: [],
    forceKilled: [],
  };
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    cleanup.note = "no usable child pid to sweep";
    return cleanup;
  }

  if (process.platform === "win32") {
    // Windows has no process groups to signal; taskkill walks the tree itself
    // and reports no per-pid detail, so all the sweep can record is what taskkill
    // itself reported.
    const killed = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      timeout: PROCESS_TREE_HELPER_TIMEOUT_MS,
      stdio: "ignore",
    });
    // `error` is set only when taskkill could not be LAUNCHED. It launching and
    // then refusing — the leader already gone so its tree can no longer be
    // walked, access denied, a descendant that could not be terminated — is a
    // nonzero status with no `error` at all, and reading only `error` reported
    // every one of those as a cleaned-up tree.
    const terminated = !killed.error && killed.status === 0;
    cleanup.processGroupTerminated = terminated;
    if (!terminated) cleanup.terminationUnconfirmed = true;
    cleanup.note = killed.error
      ? `taskkill unavailable: ${String(killed.error)}`
      : terminated
        ? "tree terminated via taskkill /t /f"
        : `taskkill did not terminate the tree (${
            killed.status === null || killed.status === undefined
              ? `killed with ${killed.signal ?? "an unknown signal"}`
              : `exit ${killed.status}`
          }); descendants may still be running`;
    return cleanup;
  }

  const groupReachable = pidAlive(-pid);
  if (groupReachable) {
    const term = signalOutcome(-pid, "SIGTERM");
    sleepSync(PROCESS_TREE_KILL_GRACE_MS);
    // Termination is claimed only on evidence: the group is no longer there once
    // the grace period is up, a `SIGKILL` was accepted for it — which no process
    // can ignore, so delivery is death — or the process table shows no live
    // member left. A `SIGTERM` that was merely accepted proves none of those, and
    // a group that refuses every signal while live members remain in it proves
    // the opposite: those processes outlive the sweep still holding their locks.
    if (!pidAlive(-pid)) {
      cleanup.processGroupTerminated = true;
    } else {
      const force = signalOutcome(-pid, "SIGKILL");
      const refusal = force.delivered ? undefined : (force.code ?? term.code ?? "unknown");
      if (refusal === undefined || refusal === "ESRCH") {
        // A delivered `SIGKILL` nothing can ignore, or `ESRCH` — the group having
        // exited between the probe and the signal, which is a race with the very
        // departure the sweep wanted, so it confirms it.
        cleanup.processGroupTerminated = true;
      } else {
        // Any other refusal is ambiguous on its own (see liveProcessGroupMembers),
        // so it is settled against the process table rather than against the
        // errno. Live members are signalled by pid first: a positive pid names a
        // single process, so its signal answers where a group id cannot.
        let survivors = liveProcessGroupMembers(pid);
        if (survivors !== undefined && survivors.length > 0) {
          for (const member of survivors) signalQuietly(member, "SIGKILL");
          sleepSync(PROCESS_TREE_KILL_GRACE_MS);
          survivors = liveProcessGroupMembers(pid);
        }
        if (survivors !== undefined && survivors.length === 0) {
          cleanup.processGroupTerminated = true;
          cleanup.note = `the child's process group refused a group signal (${refusal}), but no live process remains in it`;
        } else {
          cleanup.processGroupSignalError = refusal;
          cleanup.terminationUnconfirmed = true;
          cleanup.note = `the child's process group could not be signalled (${refusal}); processes in it may still be running and holding locks`;
        }
      }
    }
  } else {
    // Ambiguous by construction, and honestly reported as such: either nothing
    // in the child's group outlived it (the good case) or the child never became
    // a group leader, leaving only descendants still parented to it reachable.
    cleanup.note =
      "no process group remained to signal; only descendants still parented to the child could be swept";
  }

  const descendants = listDescendantPids(pid);
  if (descendants.length > 0) {
    const deepestFirst = [...descendants].reverse();
    for (const descendant of deepestFirst) signalQuietly(descendant, "SIGTERM");
    sleepSync(PROCESS_TREE_KILL_GRACE_MS);
    for (const descendant of deepestFirst) {
      if (pidAlive(descendant) && signalQuietly(descendant, "SIGKILL")) {
        cleanup.forceKilled.push(descendant);
      }
    }
    cleanup.terminatedDescendants = descendants;
  }
  return cleanup;
}

// ---------------------------------------------------------------------------
// External deadline watchdog (issue #1060 review, P1)
//
// `opts.timeout` on a SYNCHRONOUS child API is only half a deadline. Node arms a
// timer, sends the child `SIGTERM` when it expires — and then keeps waiting for
// the child to exit, because that is what a synchronous API does. A child that
// traps or ignores `SIGTERM` (a shell with `trap '' TERM`, a package manager
// draining a network pool in a handler) therefore keeps the call blocked past
// its deadline, with no escalation possible: the runner's only thread is inside
// the call, so no timer of ours can fire and, worse, the child's pid is not
// known until the call returns.
//
// The escalation is therefore delegated to a process OUTSIDE this one, armed
// before the spawn and disarmed after it. It waits out the deadline plus a
// grace period and, if the child is still there, `SIGKILL`s its process group —
// which no child can ignore, so the synchronous call returns and the ordinary
// classification and tree sweep below run as they always did.
//
// Windows is exempt by construction rather than by omission: `ChildProcess.kill`
// there is `TerminateProcess`, which the child cannot trap, so the synchronous
// call always returns on its own deadline.
// ---------------------------------------------------------------------------

/** Grace between the runner's deadline `SIGTERM` and the watchdog's `SIGKILL`. */
export const DEADLINE_ESCALATION_GRACE_MS = 5_000;

/**
 * Slack allowed when reading a measured elapsed time as proof the deadline
 * expired. Both ends come from the same clock and the timer is armed after
 * `startedAt` is taken, so the measurement can only run long — except by the
 * few milliseconds of timer granularity this absorbs.
 */
const DEADLINE_CLOCK_SLACK_MS = 50;

/**
 * Did the run actually reach its deadline?
 *
 * Deliberately not "was a deadline configured": every environment-prepare run
 * configures one, so that question is answered `true` for a child terminated a
 * second into a five-minute budget, which is a signal termination and not a
 * timeout at all (issue #1060 review, P2).
 */
function deadlineHasExpired(
  timeoutMs: number | undefined,
  elapsedMs: number | undefined,
  escalated: boolean,
): boolean {
  if (escalated) return true;
  if (timeoutMs === undefined || elapsedMs === undefined) return false;
  return elapsedMs >= timeoutMs - DEADLINE_CLOCK_SLACK_MS;
}

/**
 * The watchdog body, as POSIX shell.
 *
 * Its target set is deliberately the narrowest one that needs no pid the
 * watchdog cannot have: the runner's own DIRECT children that are their own
 * process-group leaders — which is exactly what `detached: true` produces, and
 * which the runner creates only for the call this watchdog was armed for. That
 * call blocks the runner's only thread until it returns, so no second such child
 * can exist while the watchdog is armed. The watchdog is itself one, hence the
 * `$$` exclusion.
 *
 * The marker is written BEFORE the kill and renamed into place, so its existence
 * is proof that the deadline elapsed with the child still running — read back by
 * {@link stopDeadlineWatchdog} as {@link CommandRunResult.deadlineEscalated}.
 */
const DEADLINE_WATCHDOG_SOURCE = [
  'runner="$1"; wait_seconds="$2"; marker="$3"; me=$$',
  'sleep "$wait_seconds"',
  'targets=$(ps -A -o pid=,ppid=,pgid= 2>/dev/null | ' +
    "awk -v r=\"$runner\" -v me=\"$me\" '$2 == r && $1 == $3 && $1 != me { print $1 }')",
  '[ -n "$targets" ] || exit 0',
  'printf %s "$targets" > "$marker.tmp" 2>/dev/null && mv "$marker.tmp" "$marker" 2>/dev/null',
  'for target in $targets; do',
  '  kill -KILL "-$target" 2>/dev/null || kill -KILL "$target" 2>/dev/null',
  "done",
  "exit 0",
].join("\n");

interface DeadlineWatchdog {
  /** The watchdog's own pid; it is a group leader, so `-pid` disarms it whole. */
  pid: number;
  markerPath: string;
  dir: string;
}

/**
 * Arm the escalation described above, for the calls that need it: a deadline to
 * escalate, and a process group to escalate against. Best-effort — a host
 * without `sh`/`ps`/`awk` keeps exactly the pre-existing behaviour rather than
 * failing the run.
 */
function startDeadlineWatchdog(opts: CommandRunOptions): DeadlineWatchdog | undefined {
  if (opts.timeout === undefined || !opts.isolateProcessGroup) return undefined;
  if (process.platform === "win32") return undefined;
  const waitSeconds = Math.ceil((opts.timeout + DEADLINE_ESCALATION_GRACE_MS) / 1000);
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "ai-deadline-watchdog-"));
    const markerPath = join(dir, "escalated");
    const child = spawn(
      "sh",
      [
        "-c",
        DEADLINE_WATCHDOG_SOURCE,
        "ai-deadline-watchdog",
        String(process.pid),
        String(waitSeconds),
        markerPath,
      ],
      // `detached` so it outlives nothing in particular but is disarmed as a
      // group; `ignore` so it never holds the pipes the run is capturing.
      { detached: true, stdio: "ignore" },
    );
    // An unlistened `error` on a ChildProcess is an unhandled exception, and this
    // one would surface long after the run — the runner's thread is blocked when
    // it fires. A host that cannot spawn the watchdog must not take the run down.
    child.on("error", () => {});
    child.unref();
    if (typeof child.pid !== "number" || child.pid <= 1) {
      rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
    return { pid: child.pid, markerPath, dir };
  } catch {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a leftover empty temp dir is not worth failing a run over.
      }
    }
    return undefined;
  }
}

/**
 * Kill a watchdog that did not have to fire.
 *
 * The group signal is the one that matters — it takes the `sleep` the watchdog
 * shell is blocked in along with the shell itself — but it cannot be the only
 * attempt: `detached` makes the watchdog a group leader by having the CHILD call
 * `setsid()`, which happens after the parent's spawn returns. A run that finishes
 * within that window signals a group id nothing holds yet, gets `ESRCH`, and — if
 * that were the end of it — would leave a watchdog armed against whatever the
 * NEXT isolated run spawns. So the pid itself is the fallback, and the pair is
 * retried once after the same grace the tree sweep uses, by which point the
 * group reliably exists.
 */
function killDisarmedWatchdog(pid: number): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signalQuietly(-pid, "SIGKILL") || signalQuietly(pid, "SIGKILL")) return;
    if (!pidAlive(pid)) return; // Already gone: nothing is left armed.
    sleepSync(PROCESS_TREE_KILL_GRACE_MS);
  }
}

/**
 * Disarm the watchdog and report whether it fired first.
 *
 * A watchdog that has NOT fired is killed as a group. One that HAS is left to
 * finish: it is already inside its kill loop, and cutting it short there could
 * strand the very tree it was armed to remove — it exits on its own immediately
 * afterwards.
 */
function stopDeadlineWatchdog(watchdog: DeadlineWatchdog | undefined): boolean {
  if (watchdog === undefined) return false;
  let escalated = false;
  try {
    escalated = readFileSync(watchdog.markerPath, "utf8").trim() !== "";
  } catch {
    escalated = false; // No marker: the run finished inside its deadline.
  }
  if (!escalated) killDisarmedWatchdog(watchdog.pid);
  try {
    rmSync(watchdog.dir, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
  return escalated;
}

/**
 * The shared tail of both runners' failure paths: read the typed termination
 * facts and, when the runner itself had to kill the child, sweep the tree it
 * left behind.
 */
function terminationResultFields(
  raw: unknown,
  opts: CommandRunOptions,
  deadlineExpired: boolean,
  escalated = false,
): Pick<
  CommandRunResult,
  "spawnErrorCode" | "signal" | "timedOut" | "pid" | "processTreeCleanup" | "deadlineEscalated"
> {
  const facts = readTerminationFacts(raw, deadlineExpired);
  const escalation = escalated ? { deadlineEscalated: true, timedOut: true } : {};
  const killedByRunner = facts.timedOut === true || escalated || facts.signal !== undefined;
  if (!opts.isolateProcessGroup || !killedByRunner || facts.pid === undefined) {
    return { ...facts, ...escalation };
  }
  const processTreeCleanup = terminateProcessTree(facts.pid);
  if (escalated) {
    // The group is gone because the watchdog took it, which the sweep above can
    // only see as an absence. Recording that absence as "no process group
    // remained to signal" would read as a cleanup that found nothing to do.
    //
    // Unless the sweep found a live group it was refused: that is direct
    // evidence against the watchdog having removed it, and the honest reading
    // of contradictory evidence on a cleanup path is the unconfirmed one.
    if (processTreeCleanup.terminationUnconfirmed !== true) {
      processTreeCleanup.processGroupTerminated = true;
    }
    processTreeCleanup.note =
      "process group force-killed by the deadline watchdog after the command outlived its deadline signal" +
      (processTreeCleanup.note === undefined ? "" : `; ${processTreeCleanup.note}`);
  }
  return { ...facts, ...escalation, processTreeCleanup };
}

/**
 * The options both runners hand to their child API.
 *
 * `detached` is typed only on the asynchronous `spawn` options even though both
 * synchronous APIs forward it to the same libuv flag, so the one cast lives here
 * rather than at each call site.
 */
function childProcessOptions(opts: CommandRunOptions): Record<string, unknown> {
  return {
    cwd: opts.cwd,
    env: opts.env ?? spawnEnv(),
    encoding: "utf8",
    input: opts.stdin,
    stdio: opts.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    ...(opts.isolateProcessGroup ? { detached: true } : {}),
  };
}

export const defaultCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    const watchdog = startDeadlineWatchdog(opts);
    const startedAt = Date.now();
    try {
      const stdout = execFileSync(
        cmd,
        args,
        childProcessOptions(opts) as unknown as ExecFileSyncOptionsWithStringEncoding,
      );
      const durationMs = Date.now() - startedAt;
      stopDeadlineWatchdog(watchdog);
      return { stdout, stderr: "", exitCode: 0, durationMs };
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const escalated = stopDeadlineWatchdog(watchdog);
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode: e.status ?? 1,
        durationMs,
        ...terminationResultFields(
          err,
          opts,
          deadlineHasExpired(opts.timeout, durationMs, escalated),
          escalated,
        ),
      };
    }
  },
};

/**
 * Like {@link defaultCommandRunner} but captures BOTH stdout and stderr on every
 * exit code, including success. `execFileSync` discards the stderr it buffered
 * once the command exits 0 (it only returns stdout), so a command that succeeds
 * while writing diagnostics to stderr loses them. The Tool Request grant artifact
 * contract (issue #301) records stdout/stderr/exit code for the granted command
 * regardless of outcome, so that path uses this `spawnSync`-based runner.
 */
export const bothStreamsCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    const watchdog = startDeadlineWatchdog(opts);
    const startedAt = Date.now();
    // The watchdog is disarmed in a `finally`: leaving one armed would let it
    // outlive this call and reach the NEXT run's isolated child.
    let escalated = false;
    const result: SpawnSyncReturns<string> = (() => {
      try {
        return spawnSync(
          cmd,
          args,
          childProcessOptions(opts) as unknown as SpawnSyncOptionsWithStringEncoding,
        );
      } finally {
        escalated = stopDeadlineWatchdog(watchdog);
      }
    })();
    const durationMs = Date.now() - startedAt;
    // A spawn-level failure (e.g. timeout, buffer overflow, ENOENT) surfaces via
    // `error`; report it as nonzero with the message on stderr so callers don't
    // mistake it for a clean success. It is also reported separately, as the
    // suffix it is, for callers that must not attribute it to the child (see
    // {@link CommandRunResult.spawnError}).
    if (result.error) {
      const spawnError = String(result.error);
      return {
        stdout: result.stdout ?? "",
        stderr: (result.stderr ? result.stderr : "") + spawnError,
        exitCode: typeof result.status === "number" ? result.status : 1,
        spawnError,
        durationMs,
        ...terminationResultFields(
          result,
          opts,
          deadlineHasExpired(opts.timeout, durationMs, escalated),
          escalated,
        ),
      };
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      // A process killed by a signal has a null status; treat it as nonzero.
      exitCode: result.status ?? 1,
      durationMs,
      // A signal kill with no `error` (an external SIGKILL, an OOM killer) is
      // still a terminated process, not a command that reported failure.
      //
      // `deadlineExpired: false` here, always — deliberately not
      // `deadlineHasExpired(...)`: `spawnSync` reports its OWN deadline through
      // `error`, handled above, so nothing that reaches here was `opts.timeout`
      // expiring on its own terms. `deadlineHasExpired`'s slack allowance is
      // sized against a REAL deadline; fed a short one (issue #1089 review, P2:
      // `timeout: 40`, a 6ms `SIGTERM` self-kill) it can't tell "elapsed is near
      // the deadline" from "the deadline was too short to out-slack", and
      // reports every ordinary signal kill on this path as a timeout.
      //
      // `escalated` is NOT always false, though, and is forwarded regardless:
      // the escalation watchdog's SIGKILL (issue #1060) is external to
      // `spawnSync` — a child that ignored the deadline's `SIGTERM` and had to
      // be force-killed lands here with no `error` at all, and discarding the
      // watchdog's own verdict would silently misreport that escalation as an
      // ordinary signal kill. `terminationResultFields` already sets `timedOut`
      // (and `deadlineEscalated`) from `escalated` alone, so the `false` above
      // costs it nothing — a live distinction for the reviewer-reconsideration
      // turn, which routes the two differently (issue #953).
      ...terminationResultFields(result, opts, false, escalated),
    };
  },
};

// ---------------------------------------------------------------------------
// Classified probes (issue #897), shared by every surface that drives an
// operation core (issue #1031)
// ---------------------------------------------------------------------------

/** Block the calling thread; {@link probe} is synchronous, so a promise is no use here. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a command and classify what happened (issue #897).
 *
 * Returns the full {@link CliProbeOutcome} rather than a bare boolean: the
 * `ok`/`output` pair every pre-#897 caller reads is still there, but a caller
 * that must not confuse "the binary is missing" with "this host could not fork
 * right now" can read `status`/`transient`/`code` instead. Reducing the
 * distinction away too early is what let a loaded machine be reported as an
 * uninstalled CLI.
 *
 * Lives here rather than in `src/cli/admin.ts` (issue #1031) because it is the
 * `ToolRequestRunExecPort.probe` / `ToolRequestResolveExecPort.probe`
 * implementation, and the admin CLI is no longer the only surface that drives
 * those cores: the ChatOps composition root builds the same operation contexts.
 * An entrypoint module cannot be imported by one — it has top-level side effects
 * — so a second copy of this function would be the only alternative, and two
 * copies of a git probe is exactly how the two surfaces would drift apart on
 * what "origin does not have this branch" means.
 */
export function probe(
  cmd: string,
  args: string[],
  cwd?: string,
  opts: {
    /**
     * A tighter deadline than the default, for probes whose spec declares one
     * (e.g. the Antigravity capability probe's
     * `ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS`, issue #909/#914). Never raises the
     * default: a probe that declares no bound keeps the generous one below.
     */
    timeoutMs?: number;
  } = {},
): CliProbeOutcome {
  // Attempt 0 is the normal path; the retries exist only for a host that could
  // not fork, and are spaced so the contended resource has a chance to free up.
  const backoffMs = TRANSIENT_SPAWN_RETRY_BACKOFF_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd,
        // Explicit for the reason spawnEnv() documents: this is the value
        // execFileSync already defaults to, but that default is read from the
        // REAL process object while a test sandbox hands this module a copy of
        // `process.env` — so without it a probe resolves `gh`/`claude`/`agy`
        // against the host's PATH instead of the caller's (issue #1018).
        env: spawnEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // Generous enough to tolerate a loaded host: these calls include network
        // ops (fetch/pull/ls-remote) whose latency is outside our control, and a
        // spurious timeout here is misread as "could not fetch origin" even
        // though the command actually completed.
        timeout: Math.min(opts.timeoutMs ?? 60_000, 60_000),
      }) as string;
      return probeSucceeded(stdout);
    } catch (err: unknown) {
      const outcome = classifyProbeFailure(err);
      if (attempt < backoffMs.length && isRetryableProbeFailure(outcome)) {
        sleepSync(backoffMs[attempt]);
        continue;
      }
      return outcome;
    }
  }
}

/**
 * Determine whether origin has `branch`, distinguishing a positively-absent
 * branch from an ambiguous lookup failure (issue #316 review). `git ls-remote
 * --exit-code` exits 2 only when the lookup succeeded but matched no ref; any
 * other non-zero status (network, auth, timeout) is ambiguous and must NOT be
 * read as "branch absent" — doing so could create a base-derived branch that
 * misses the existing PR head's changes.
 */
export function remoteHasBranch(repoRoot: string, branch: string): "yes" | "no" | "unknown" {
  // With no `origin` remote configured the branch is definitively local-only: the
  // remote cannot hold it, so this is a determinate "no", not the ambiguous
  // "unknown" reserved for a configured remote whose lookup failed (network/auth).
  // Conflating the two would steer a genuinely local-only stale branch away from
  // cleanup and toward recreate.
  try {
    execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "no";
  }
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return "yes";
  } catch (err: unknown) {
    return (err as { status?: number }).status === 2 ? "no" : "unknown";
  }
}
