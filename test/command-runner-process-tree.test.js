/**
 * Process-termination diagnostics and process-tree cleanup (issue #1060).
 *
 * These tests spawn REAL processes rather than stubbing the runner: the whole
 * point of the change is what Node's synchronous child APIs actually report and
 * actually kill, and a stub can only restate the assumption being fixed.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  defaultCommandRunner,
  listDescendantPids,
  terminateProcessTree,
} from '../dist/handlers/command-runner.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const posixTest = process.platform === 'win32' ? test.skip : test;

/**
 * A command that (a) leaves a two-deep process tree behind it, (b) writes
 * partial diagnostics to stderr, and (c) never exits — the shape of a package
 * manager that prints deprecation warnings on its way to a deadline.
 *
 * A POSIX shell rather than `node -e`: the deadline these tests put the runner
 * under is measured in a second or two, and a Node runtime asked to cold-start
 * on a machine already running the rest of this suite can still be booting when
 * that deadline expires. That reports as "the command produced no output at
 * all", which measures the host's load rather than the runner. `sh` has run its
 * first line before a boot is even measurable.
 *
 * The descendants get `/dev/null` for stdio deliberately: a descendant holding
 * the inherited stderr pipe is a different failure mode than the one under test.
 *
 * The marker is renamed into place rather than written in place, so a reader
 * that sees the path can never see a half-written pid.
 */
const FORKING_HANG_SOURCE = [
  "printf 'npm warn deprecated left-pad@1.3.0\\n' >&2",
  // The middle process stays alive so that the `sleep` it backgrounds is a
  // *transitive* descendant, rather than one orphaned onto init immediately.
  `sh -c 'sleep 300 & printf %s "$!" > "$1.tmp"; mv "$1.tmp" "$1"; sleep 300' sh "$1" >/dev/null 2>&1 &`,
  'sleep 300 >/dev/null 2>&1',
].join('\n');

/** The `[command, args]` pair that runs {@link FORKING_HANG_SOURCE}. */
function forkingHangCommand(markerPath) {
  return ['/bin/sh', ['-c', FORKING_HANG_SOURCE, 'sh', markerPath]];
}

/**
 * The `[command, args]` pair for "write `boom` to stderr, then exit `code`" — the
 * ordinary command failure the classification must leave alone.
 *
 * A POSIX shell wherever there is one, for the reason FORKING_HANG_SOURCE gives:
 * this suite runs its files in parallel, and a Node runtime cold-starting on a
 * host already saturated by the rest of them can take longer to print its first
 * byte than any deadline these tests would sensibly configure. A run that hits
 * the deadline reports the runner's stand-in `exitCode: 1` instead of the exit
 * status under test, which measures the host rather than the classification.
 * Windows, which has no `/bin/sh`, keeps the Node fixture: it is not the platform
 * this suite runs saturated on.
 */
function exitAfterStderrCommand(code) {
  return process.platform === 'win32'
    ? [process.execPath, ['-e', `process.stderr.write("boom\\n"); process.exit(${code});`]]
    : ['/bin/sh', ['-c', `printf 'boom\\n' >&2; exit ${code}`]];
}

/** The `[command, args]` pair for "print `ok` to stdout and succeed". */
function printOkCommand() {
  return process.platform === 'win32'
    ? [process.execPath, ['-e', 'process.stdout.write("ok")']]
    : ['/bin/sh', ['-c', 'printf %s ok']];
}

/**
 * A deadline far enough out that a loaded host cannot reach it. The tests below
 * assert a run is NOT a timeout, so the budget is only there to keep the runner
 * on its ordinary path — not a value under test.
 */
const NON_BINDING_TIMEOUT_MS = 60_000;

/**
 * A command that ignores the deadline's `SIGTERM` outright, prints partial
 * diagnostics, and then hangs — the shape `opts.timeout` alone cannot stop,
 * because a synchronous child API sends that signal and then goes on waiting for
 * an exit that never comes.
 */
const SIGTERM_PROOF_HANG_SOURCE = [
  "trap '' TERM",
  "printf 'npm warn deprecated left-pad@1.3.0\\n' >&2",
  'sleep 300',
].join('\n');

/**
 * Direct children of this process that lead their own process group — the exact
 * signature of a `detached: true` spawn, and therefore of an armed deadline
 * watchdog. Used to prove a watchdog that did not have to fire is disarmed
 * rather than left running against the next run's child.
 */
function detachedChildPids() {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
  if (typeof ps.stdout !== 'string') return [];
  const pids = [];
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, stat] = match;
    // A killed-but-unreaped zombie still has a row of its own; it holds nothing
    // and is about to disappear, so it is not a watchdog that is still armed.
    if (stat.startsWith('Z')) continue;
    if (Number(ppid) === process.pid && pid === pgid) pids.push(Number(pid));
  }
  return pids;
}

/**
 * The process group `pid` belongs to, read from the process table, or undefined
 * once it is no longer there. A live process whose group id is its own pid is
 * the observable form of "this process leads its own group".
 */
function processGroupOf(pid) {
  const ps = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  if (typeof ps.stdout !== 'string') return undefined;
  const pgid = Number(ps.stdout.trim());
  return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
}

/** The pid recorded in `markerPath`, or undefined until there is a usable one. */
function readMarkerPid(markerPath) {
  if (!existsSync(markerPath)) return undefined;
  const pid = Number(readFileSync(markerPath, 'utf8').trim());
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but is not ours to signal.
    return err.code === 'EPERM';
  }
}

async function waitUntil(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/**
 * Wait for the leader to record its grandchild's pid.
 *
 * Returns the pid, or throws with what became of the leader — one that died on
 * its first line and one that is merely slow both arrive here as a bare
 * `undefined`, and only the leader's own fate tells them apart. The `error`
 * listener is part of that: an unlistened `error` on a child process takes the
 * whole test file down with it, losing the very diagnosis this is here for.
 */
async function waitForGrandchildPid(leader, markerPath) {
  let fate;
  leader.on('error', (err) => {
    fate = `leader could not be spawned: ${err.message}`;
  });
  leader.on('exit', (code, signal) => {
    fate = `leader exited: code=${code} signal=${signal}`;
  });
  await waitUntil(() => readMarkerPid(markerPath) !== undefined || fate !== undefined);
  const pid = readMarkerPid(markerPath);
  if (pid === undefined) {
    throw new Error(`no grandchild pid recorded (${fate ?? 'leader still running'})`);
  }
  return pid;
}

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'command-runner-tree-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

posixOnly('terminateProcessTree', () => {
  test('kills the whole process group, including a grandchild the leader orphans', async () => {
    const marker = join(tmpDir, 'grandchild.pid');
    const [cmd, args] = forkingHangCommand(marker);
    // `detached` puts the leader in its own process group, which is what makes
    // the grandchild reachable after the leader itself is gone.
    const leader = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    try {
      const grandchildPid = await waitForGrandchildPid(leader, marker);
      expect(alive(grandchildPid)).toBe(true);

      const cleanup = terminateProcessTree(leader.pid);

      expect(cleanup.pid).toBe(leader.pid);
      expect(cleanup.processGroupTerminated).toBe(true);
      // The grandchild is the process the old direct-child-only kill left behind.
      expect(await waitUntil(() => !alive(grandchildPid))).toBe(true);
    } finally {
      try {
        process.kill(-leader.pid, 'SIGKILL');
      } catch {
        // Already gone — that is the expected state.
      }
    }
  }, 30_000);

  test('finds transitive descendants of a live process', async () => {
    const marker = join(tmpDir, 'descendant.pid');
    const [cmd, args] = forkingHangCommand(marker);
    const leader = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    try {
      const grandchildPid = await waitForGrandchildPid(leader, marker);
      expect(listDescendantPids(leader.pid)).toContain(grandchildPid);
    } finally {
      try {
        process.kill(-leader.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }, 30_000);

  test('a group that cannot be signalled is reported as unsuccessful cleanup, not as terminated', async () => {
    // A REAL live process group — the survivor the sweep must refuse to write off
    // — that no signal can reach. Only the permission half is simulated:
    // `process.kill` is the single syscall the sweep uses, so refusing it with
    // EPERM for this pid and its group id is exactly what a host would do for a
    // group that is not ours, and nothing inside this suite can produce a live
    // process it is genuinely forbidden to signal.
    //
    // A bare `sleep` rather than a shell running one: with no children of its
    // own, the group's survival is exactly this process's survival, and there is
    // no shell in the middle that would exit once the sweep killed something
    // under it.
    const leader = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    leader.on('error', () => {});
    const pid = leader.pid;
    // `detached` sets the new group id in the CHILD, so the parent can hold the
    // pid a moment before the group exists: wait for it, or the sweep would be
    // probing a group id that is not yet anyone's.
    expect(await waitUntil(() => processGroupOf(pid) === pid)).toBe(true);

    const realKill = process.kill.bind(process);
    process.kill = (target, signal) => {
      if (target !== -pid && target !== pid) return realKill(target, signal);
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    };
    try {
      const cleanup = terminateProcessTree(pid);

      // The processes are still there holding whatever they hold; claiming the
      // group was terminated would send the operator past the real cause.
      expect(cleanup.processGroupTerminated).toBe(false);
      expect(cleanup.processGroupSignalError).toBe('EPERM');
      expect(cleanup.terminationUnconfirmed).toBe(true);
      expect(cleanup.note).toMatch(/could not be signalled/i);
      expect(cleanup.note).toMatch(/still be running/i);
      // Read from the process table rather than through the patched `kill`: the
      // leader really did outlive the sweep, which is what makes the report above
      // the honest one.
      expect(processGroupOf(pid)).toBe(pid);
    } finally {
      process.kill = realKill;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone — that is the expected state.
      }
    }
  }, 30_000);

  test('a refused group signal with nothing left in the group is still a terminated group', () => {
    // The same refusal as the test above, with the opposite evidence behind it,
    // and therefore the opposite verdict. This is what a real host produces on
    // the sweep's own success path: a group signal reports on delivery, so a
    // group whose last member is a zombie the runner has not reaped yet — the
    // state every group is in while this synchronous sweep still holds the
    // thread — refuses the signal with nothing alive left to hold a lock.
    //
    // 999_999 is above the pid ceiling, so no process on the host can be in this
    // group and the process-table check has one honest answer.
    const pid = 999_999;
    const realKill = process.kill.bind(process);
    process.kill = (target, signal) => {
      if (target !== -pid) return realKill(target, signal);
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    };
    try {
      const cleanup = terminateProcessTree(pid);

      expect(cleanup.processGroupTerminated).toBe(true);
      expect(cleanup.processGroupSignalError).toBeUndefined();
      expect(cleanup.terminationUnconfirmed).toBeUndefined();
      expect(cleanup.note).toMatch(/no live process remains/i);
    } finally {
      process.kill = realKill;
    }
  }, 30_000);

  test('reports rather than throws when there is no usable pid to sweep', () => {
    const cleanup = terminateProcessTree(0);
    expect(cleanup.processGroupTerminated).toBe(false);
    expect(cleanup.terminatedDescendants).toEqual([]);
    expect(cleanup.note).toMatch(/no usable child pid/i);
  });
});

describe('defaultCommandRunner — classified process termination', () => {
  // POSIX-only for its fixture's sake, not the runner's: see forkingHangCommand.
  posixTest(
    'a command killed on its deadline is reported as a timeout, with its partial stderr',
    () => {
      const marker = join(tmpDir, 'timeout-grandchild.pid');
      const [cmd, args] = forkingHangCommand(marker);
      const result = defaultCommandRunner.run(cmd, args, {
        cwd: tmpDir,
        timeout: 1_500,
        isolateProcessGroup: true,
      });

      // The deadline — not the deprecation warning that happens to be the tail
      // of the captured output — is what stopped this run.
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe('SIGTERM');
      expect(result.stderr).toContain('npm warn deprecated');
      expect(result.durationMs).toBeGreaterThanOrEqual(1_000);
      expect(result.pid).toBeGreaterThan(0);
      // Cleanup was attempted and anchored on the right process.
      expect(result.processTreeCleanup).toBeDefined();
      expect(result.processTreeCleanup.pid).toBe(result.pid);
      // The direct child never survives the runner regaining control.
      expect(alive(result.pid)).toBe(false);

      // Belt and braces: a host where the sweep could reach nothing must not
      // leak the rest of the tree into the rest of the suite.
      try {
        process.kill(-result.pid, 'SIGKILL');
      } catch {
        // Already gone — the expected state.
      }
      const grandchildPid = readMarkerPid(marker);
      if (grandchildPid !== undefined) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // Already gone — the expected state.
        }
      }
    },
    30_000,
  );

  // POSIX-only: on Windows `kill()` is `TerminateProcess`, which a child cannot
  // trap, so the deadline always returns on its own and there is nothing to
  // escalate — see startDeadlineWatchdog.
  posixTest(
    'a command that ignores the deadline signal is force-killed rather than left running',
    async () => {
      const started = Date.now();
      const result = defaultCommandRunner.run('/bin/sh', ['-c', SIGTERM_PROOF_HANG_SOURCE], {
        cwd: tmpDir,
        timeout: 1_500,
        isolateProcessGroup: true,
      });

      // The whole point: the call RETURNED. Before the watchdog it would still
      // be blocked inside execFileSync, deadline or no deadline.
      expect(result.deadlineEscalated).toBe(true);
      expect(result.timedOut).toBe(true);
      // Escalation waits out the deadline plus its grace period, so this cannot
      // have come from the deadline signal being honoured.
      expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
      expect(result.stderr).toContain('npm warn deprecated');
      expect(result.processTreeCleanup).toBeDefined();
      expect(result.processTreeCleanup.processGroupTerminated).toBe(true);
      expect(result.processTreeCleanup.note).toMatch(/watchdog/i);
      expect(await waitUntil(() => !alive(result.pid))).toBe(true);
    },
    40_000,
  );

  posixTest(
    'a signal that arrives long before the deadline is not reported as a timeout',
    async () => {
      // Terminates itself a few milliseconds into a 30-second budget: the shape
      // an operator's `kill`, a supervisor, or an OOM killer produces, and the
      // one a "a timeout was configured" test would misread as a deadline.
      const result = defaultCommandRunner.run('/bin/sh', ['-c', 'kill -TERM $$'], {
        cwd: tmpDir,
        timeout: 30_000,
        isolateProcessGroup: true,
      });

      expect(result.signal).toBe('SIGTERM');
      expect(result.timedOut).toBeUndefined();
      expect(result.deadlineEscalated).toBeUndefined();
      expect(result.durationMs).toBeLessThan(30_000);

      // The watchdog armed for that 30-second budget is disarmed on the way out;
      // one left running would reach the next isolated child instead.
      expect(await waitUntil(() => detachedChildPids().length === 0)).toBe(true);
    },
    40_000,
  );

  test('an ordinary non-zero exit stays a plain command failure', () => {
    const [cmd, args] = exitAfterStderrCommand(3);
    const result = defaultCommandRunner.run(cmd, args, {
      cwd: tmpDir,
      timeout: NON_BINDING_TIMEOUT_MS,
      isolateProcessGroup: true,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
    expect(result.timedOut).toBeUndefined();
    expect(result.signal).toBeUndefined();
    expect(result.spawnErrorCode).toBeUndefined();
    expect(result.processTreeCleanup).toBeUndefined();
    // Budgeted past NON_BINDING_TIMEOUT_MS: a run that somehow did reach that
    // deadline blocks inside the synchronous call regardless, and jest cutting in
    // first would report an opaque test timeout instead of the classified result
    // that says which of these expectations broke.
  }, 90_000);

  test('a missing binary carries its errno rather than looking like a command failure', () => {
    const result = defaultCommandRunner.run(join(tmpDir, 'definitely-not-a-binary'), [], {
      cwd: tmpDir,
      timeout: 20_000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.spawnErrorCode).toBe('ENOENT');
    expect(result.timedOut).toBeUndefined();
  }, 30_000);

  test('a successful command is unchanged apart from carrying its duration', () => {
    const [cmd, args] = printOkCommand();
    const result = defaultCommandRunner.run(cmd, args, {
      cwd: tmpDir,
      timeout: NON_BINDING_TIMEOUT_MS,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBeUndefined();
    expect(result.signal).toBeUndefined();
    expect(typeof result.durationMs).toBe('number');
  }, 90_000);
});
