import { bothStreamsCommandRunner, type CommandRunResult, type CommandRunner } from "../../handlers/command-runner.js";
import type { OutboxAttemptBudget } from "../../core/outbox-transport-deadline.js";

// ---------------------------------------------------------------------------
// Injectable `gh` executor
//
// The single seam the gh-backed providers depend on: an executor that runs a
// `gh` invocation and returns its exit code / output. Tests inject a fake to
// assert the exact argv and to drive parsing/error branches without a live
// GitHub connection. This is the "command/API runner" injection point referenced
// by the provider interfaces.
// ---------------------------------------------------------------------------

export interface GhRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * The runner's own deadline (`opts.timeout`) expired and it terminated the
   * child (issue #1064). Reported as a typed fact rather than left to be read
   * out of `stderr`: a caller that must route a deadline differently from a
   * command that ran and failed — the outbox dispatcher does, since a timed-out
   * write has an UNKNOWN remote outcome while a non-zero exit does not — would
   * otherwise have to match on Node's rendering of an `ETIMEDOUT`.
   *
   * Optional throughout: every existing fake runner omits it, which reads as
   * "not a deadline" — the conservative direction.
   */
  timedOut?: boolean;
  /** Signal that terminated the child, when one did. */
  signal?: string;
  /** Errno of a spawn-level failure (`ETIMEDOUT`, `ENOENT`, …). */
  spawnErrorCode?: string;
  /** Wall-clock milliseconds the invocation took. */
  durationMs?: number;
  /** The deadline had to be escalated to `SIGKILL` to get the child back. */
  deadlineEscalated?: boolean;
  /**
   * The post-kill sweep confirmed the child's process group is gone. `false`
   * means "not confirmed" (a group the sweep was refused permission to signal),
   * never "confirmed clean"; absent when no kill happened or no sweep ran.
   */
  processGroupTerminated?: boolean;
}

export interface GhRunner {
  run(args: string[], opts: { cwd: string; timeout?: number }): GhRunResult;
}

/**
 * Project a {@link CommandRunResult} onto the gh-facing shape, keeping the typed
 * termination facts the deadline machinery needs (issue #1064).
 */
function fromCommandRunResult(result: CommandRunResult): GhRunResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    ...(result.spawnErrorCode === undefined ? {} : { spawnErrorCode: result.spawnErrorCode }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.deadlineEscalated === undefined ? {} : { deadlineEscalated: result.deadlineEscalated }),
    ...(result.processTreeCleanup === undefined
      ? {}
      : { processGroupTerminated: result.processTreeCleanup.processGroupTerminated }),
  };
}

/**
 * The child-process options a bounded `gh` invocation needs (issue #1064).
 *
 * `isolateProcessGroup` is enabled exactly when a deadline is set. `opts.timeout`
 * on a synchronous child API only ever `SIGTERM`s the DIRECT child and then keeps
 * waiting for it, so a `gh` that traps or ignores the signal — or that has
 * already handed the work to a helper of its own — keeps the call blocked past
 * its deadline. Running the child in its own process group is what lets the
 * runner's watchdog escalate to a `SIGKILL` nothing can ignore, and what lets the
 * post-kill sweep reach anything the child left behind. An unbounded call has no
 * deadline to escalate, so it keeps exactly the process placement it always had.
 */
export function ghChildOptions(opts: { cwd: string; timeout?: number }): {
  cwd: string;
  timeout?: number;
  isolateProcessGroup?: boolean;
} {
  return {
    cwd: opts.cwd,
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout, isolateProcessGroup: true }),
  };
}

/**
 * Default executor: shells out to the real `gh` CLI.
 *
 * Routed through {@link bothStreamsCommandRunner} rather than calling `spawnSync`
 * directly (issue #1064) so a `gh` invocation given a deadline inherits the same
 * cancellation the rest of the runner surface already has: the external watchdog
 * that force-kills a child which outlived its deadline signal, and the
 * process-tree sweep afterwards. The captured streams, environment and exit-code
 * mapping are unchanged — `bothStreamsCommandRunner` is itself `spawnSync` with
 * both streams piped, which is what this did before.
 */
export const defaultGhRunner: GhRunner = {
  run(args, opts) {
    return fromCommandRunResult(bothStreamsCommandRunner.run("gh", args, ghChildOptions(opts)));
  },
};

/**
 * Adapt a generic {@link CommandRunner} into a `gh` executor. Handlers already
 * inject a CommandRunner (used for git too); this wraps it so they can build a
 * gh-backed provider from the same injected runner, keeping a single test seam.
 * The forwarded argv is unchanged, so runner-level argv assertions still hold.
 */
export function ghRunnerFromCommandRunner(runner: CommandRunner): GhRunner {
  return {
    run(args, opts) {
      return fromCommandRunResult(runner.run("gh", args, ghChildOptions(opts)));
    },
  };
}

// ---------------------------------------------------------------------------
// Deadline-bounded `gh` execution (issue #1064)
// ---------------------------------------------------------------------------

/** What a bounded runner reports when it cuts a call short. */
export interface GhDeadlineTimeout {
  /** `attempt-budget` when the call was refused before being issued. */
  stage: "request" | "attempt-budget";
  /** The bound actually applied — the per-call cap or what was left of the attempt. */
  limitMs: number;
  elapsedMs?: number;
  escalated?: boolean;
  processGroupTerminated?: boolean;
  /** Whatever the transport said, unsanitized; the caller sanitizes before persisting. */
  detail?: string;
}

export interface GhDeadlinePolicy {
  /** Bound on a single invocation, before the attempt budget is applied. */
  perCallMs: number;
  /** The attempt this runner's calls belong to. */
  budget: OutboxAttemptBudget;
  /** Invoked once per call that was cut short, in call order. */
  onTimeout: (timeout: GhDeadlineTimeout) => void;
}

/**
 * Thrown by {@link boundedGhRunner} when a deadline cuts a call short, instead of
 * returning the cut-short result to the provider (P2 review follow-up to issue
 * #1064).
 *
 * A deadline is not an answer, and a {@link GhRunResult} is only ever read as
 * one. Two concrete ways a returned result gets mistaken for one:
 *
 *  - a `gh` that handles `SIGTERM` by exiting cleanly produces `exitCode: 0`
 *    alongside `timedOut: true`, which every provider's `exitCode !== 0` check
 *    reads as success — so a row whose write never happened is marked sent; and
 *  - a provider that treats a non-zero exit as "this fact is unavailable" rather
 *    than as a failure falls THROUGH the timeout: `upsertStickyPrComment` reads a
 *    timed-out `gh api /user` as an unresolved identity and goes on to create a
 *    fresh user-owned sticky comment beside the one it could not look up.
 *
 * Unwinding the attempt is the only outcome that both of those cannot swallow.
 * The facts stay attached for the caller that records diagnostics; the message
 * itself is fact-built and carries no child output, so a provider that reports it
 * verbatim leaks nothing.
 */
export class GhTransportTimeoutError extends Error {
  readonly timeout: GhDeadlineTimeout;

  constructor(timeout: GhDeadlineTimeout) {
    super(
      timeout.stage === "attempt-budget"
        ? "gh call refused: the outbox attempt budget was already spent"
        : `gh call exceeded its ${timeout.limitMs}ms outbox transport deadline`,
    );
    this.name = "GhTransportTimeoutError";
    this.timeout = timeout;
  }
}

/**
 * Wrap a `gh` executor so every call it makes is bounded (issue #1064).
 *
 * Wrapping the RUNNER rather than threading a deadline through each provider
 * method is what keeps this bounded and testable without a provider rewrite: a
 * provider builds its argv exactly as before, and every call it makes — including
 * the ones a single dispatch makes implicitly, such as the dedupe-marker history
 * scan's page-by-page walk — is bounded by construction.
 *
 * Two bounds apply, in this order:
 *
 *  1. The attempt budget. Once spent, the call is NOT issued: it is reported as
 *     a failure immediately. This is what stops a paginated read from spending
 *     `perCallMs` per page until the row's claim lease has quietly expired.
 *  2. The per-call cap, clamped down to whatever is left of the attempt, so the
 *     last call of a long attempt cannot overrun it.
 *
 * A caller that already supplied its own `timeout` keeps it, clamped to the
 * remaining budget — its own bound was chosen for a reason, and this only ever
 * tightens it.
 *
 * A deadline that fires ends the whole attempt, not just the one call: it is
 * raised as a {@link GhTransportTimeoutError} rather than returned (see there for
 * why a returned result gets read as an answer), and the wrapper stays latched
 * afterwards so a provider that catches the throw and continues to a fallback
 * still cannot issue the write that fallback would perform.
 */
export function boundedGhRunner(inner: GhRunner, policy: GhDeadlinePolicy): GhRunner {
  // The first deadline this attempt hit, once one has. Latched: every later call
  // is refused with it, whatever the caller did with the throw.
  let expiredWith: GhDeadlineTimeout | undefined;
  return {
    run(args, opts) {
      // Re-raised from the recorded facts, and deliberately WITHOUT a second
      // `onTimeout`: the attempt already reported its root cause, and a provider
      // unwinding through a fallback should not turn one hang into a pile of
      // diagnostics that bury it.
      if (expiredWith !== undefined) throw new GhTransportTimeoutError(expiredWith);
      const requested = opts.timeout ?? policy.perCallMs;
      const timeout = policy.budget.callTimeoutMs(requested);
      if (timeout <= 0) {
        // The attempt is over. Refusing here — rather than issuing a call with a
        // zero deadline — is what keeps this the one timeout stage that touched
        // nothing remote, and so the one whose outcome is not in doubt.
        expiredWith = { stage: "attempt-budget", limitMs: policy.budget.attemptMs };
        policy.onTimeout(expiredWith);
        throw new GhTransportTimeoutError(expiredWith);
      }
      const result = inner.run(args, { ...opts, timeout });
      // `timedOut` is the only trustworthy signal here: the exit code is not one.
      // A child killed by the deadline signal can still exit 0 if it handles the
      // signal, so checking the code first would let exactly the hang this bounds
      // pass for a successful call.
      if (result.timedOut) {
        expiredWith = {
          stage: "request",
          limitMs: timeout,
          ...(result.durationMs === undefined ? {} : { elapsedMs: result.durationMs }),
          ...(result.deadlineEscalated === undefined ? {} : { escalated: result.deadlineEscalated }),
          ...(result.processGroupTerminated === undefined
            ? {}
            : { processGroupTerminated: result.processGroupTerminated }),
          ...(result.stderr === "" ? {} : { detail: result.stderr }),
        };
        policy.onTimeout(expiredWith);
        throw new GhTransportTimeoutError(expiredWith);
      }
      return result;
    },
  };
}
