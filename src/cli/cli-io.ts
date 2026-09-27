/**
 * admin CLI output contract (issue #308).
 *
 * Commands fall into two classes:
 *
 *   - Operator-facing commands (task-status, list-stuck, recover,
 *     recover-cap-handoff, ...) default to human-readable text on stdout and
 *     switch to structured JSON only when `--json` is passed.
 *   - Machine/structured commands (context create, repo-lock, ...) default to
 *     JSON so existing n8n workflow / script callers keep parsing stdout.
 *
 * The active mode is resolved once in main() via {@link resolveOutputMode} and
 * stored process-wide via {@link setOutputMode}. emit()/report()/die() then read
 * it so individual command handlers do not need to thread the mode through.
 *
 * Stream conventions:
 *   - stdout carries command results (human text or JSON).
 *   - stderr carries warnings, progress, and human-mode error messages.
 *   - In JSON mode, errors stay on stdout as `{ ok: false, error }` so machine
 *     callers that parse stdout continue to work.
 */

export interface OutputMode {
  /** Emit structured JSON on stdout instead of human-readable text. */
  json: boolean;
  /** Suppress nonessential human text (headers, summaries) where useful. */
  quiet: boolean;
  /** Include extra diagnostics in human output where useful. */
  verbose: boolean;
}

/**
 * The three process-level effects every admin command has: writing stdout,
 * writing stderr, and terminating with an exit code (issue #1018).
 *
 * Production binds this to the real process. The in-process test harness
 * (test/helpers/admin-cli.js) binds it to buffers plus a throwing `exit`, so a
 * behavioural case can drive the same dispatcher the executable drives without
 * paying for a fresh Node process. Nothing else in the CLI touches
 * `process.stdout` / `process.stderr` / `process.exit` directly, so swapping
 * this sink captures the whole output contract.
 */
export interface CliIoSink {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  /**
   * Ends the run and must not return: the process sink calls `process.exit()`,
   * a test sink throws {@link CliExit}.
   */
  exit(code: number): void;
}

/**
 * The unwind a non-process sink throws in place of `process.exit()`.
 *
 * Exported so the CLI's top-level failure contract can tell "the command
 * decided to exit" apart from "something threw", and re-raise the former instead
 * of relabelling it an unexpected error.
 */
export class CliExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`admin CLI exited with code ${code}`);
    this.name = "CliExit";
    this.code = code;
  }
}

const PROCESS_SINK: CliIoSink = {
  stdout(chunk) {
    process.stdout.write(chunk);
  },
  stderr(chunk) {
    process.stderr.write(chunk);
  },
  exit(code) {
    process.exit(code);
  },
};

let sink: CliIoSink = PROCESS_SINK;

/**
 * The exit code of the first {@link die}/{@link exitProcess} call of the current
 * run, once one has happened.
 *
 * Only ever set while a non-process sink is installed. It matters only when the
 * sink unwinds by throwing: an intervening `catch` in a command handler can
 * swallow that throw, and without this latch the handler would carry on and emit
 * a *second*, contradictory result. Recording the first decision lets
 * emit/report/warn/die suppress everything after it, so captured output matches
 * what a real process would have flushed before exiting.
 *
 * Under the process sink the latch stays permanently unset — see
 * {@link latchesExit}.
 */
let pendingExitCode: number | undefined;

/**
 * Whether the installed sink terminates by unwinding rather than by ending the
 * process, and therefore needs the {@link pendingExitCode} latch.
 *
 * The process sink must never latch. `process.exit()` really does end the run in
 * production, so the latch would be dead weight — but several test files replace
 * `process.exit` with a throwing stub to exercise `die()` in-process. Under those
 * stubs `terminate()` returns control to the caller, and a latch set here would
 * survive past the individual test (the module is shared for the file's whole
 * lifetime) and silently mute `emit()` for every later case.
 */
function latchesExit(): boolean {
  return sink !== PROCESS_SINK;
}

/**
 * Install a sink. Also clears the exit latch, so each harness run starts clean.
 * Production never calls this.
 */
export function setCliIoSink(next: CliIoSink): void {
  sink = next;
  pendingExitCode = undefined;
}

/** Restore the real-process sink and clear the exit latch. */
export function resetCliIoSink(): void {
  sink = PROCESS_SINK;
  pendingExitCode = undefined;
}

/** Write pre-rendered text to stdout verbatim (no trailing-newline fixup). */
export function writeOut(text: string): void {
  if (pendingExitCode !== undefined) return;
  sink.stdout(text);
}

/**
 * Hand control to the sink's terminator and never come back.
 *
 * The trailing throw is what makes the `never` return type sound: it is reached
 * only if a sink returned instead of ending the run, which no correct sink does.
 */
function terminate(code: number): never {
  sink.exit(code);
  throw new CliExit(code);
}

/**
 * Terminate with `code` without emitting a message. Used by the few call sites
 * that have already written their own output (e.g. the non-TTY `admin ui` help).
 */
export function exitProcess(code: number): never {
  const decided = pendingExitCode ?? code;
  if (latchesExit()) pendingExitCode = decided;
  return terminate(decided);
}

// Default to JSON so any handler invoked without main() resolving a mode (direct
// imports, older call sites) keeps the historical machine-readable behaviour.
let currentMode: OutputMode = { json: true, quiet: false, verbose: false };

export function setOutputMode(mode: OutputMode): void {
  currentMode = mode;
}

export function getOutputMode(): OutputMode {
  return currentMode;
}

/**
 * Pull the global output flags (--json, --quiet, --verbose) out of argv and
 * return them alongside argv with those flags removed. Per-command parsers treat
 * arguments positionally as `--flag value` pairs, so the global boolean flags are
 * stripped here before the rest is handed to a command parser.
 *
 * `json` is `undefined` when the flag was not passed so the caller can fall back
 * to the command's default mode.
 */
export function extractOutputFlags(argv: string[]): {
  json: boolean | undefined;
  quiet: boolean;
  verbose: boolean;
  rest: string[];
} {
  let json: boolean | undefined;
  let quiet = false;
  let verbose = false;
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--verbose") verbose = true;
    else rest.push(arg);
  }
  return { json, quiet, verbose, rest };
}

/**
 * Resolve the effective output mode for a command. When `--json` is not passed,
 * `defaultJson` decides the mode (true for machine/structured commands, false for
 * operator-facing commands).
 */
export function resolveOutputMode(
  flags: { json: boolean | undefined; quiet: boolean; verbose: boolean },
  defaultJson: boolean,
): OutputMode {
  return {
    json: flags.json ?? defaultJson,
    quiet: flags.quiet,
    verbose: flags.verbose,
  };
}

/** Write a structured JSON object to stdout. Always JSON, regardless of mode. */
export function emit(payload: Record<string, unknown>): void {
  if (pendingExitCode !== undefined) return;
  sink.stdout(JSON.stringify(payload) + "\n");
}

/**
 * Dual-mode command result. In JSON mode writes the structured payload to stdout;
 * otherwise writes the human-readable rendering produced by `render` to stdout.
 * The current {@link OutputMode} is passed to `render` so it can honour
 * quiet/verbose.
 */
export function report(
  payload: Record<string, unknown>,
  render: (mode: OutputMode) => string,
): void {
  if (currentMode.json) {
    emit(payload);
    return;
  }
  if (pendingExitCode !== undefined) return;
  const text = render(currentMode);
  if (text.length > 0) {
    sink.stdout(text.endsWith("\n") ? text : text + "\n");
  }
}

/** Write a warning/progress line to stderr. Suppressed in quiet mode. */
export function warn(message: string): void {
  if (pendingExitCode !== undefined) return;
  if (!currentMode.quiet) {
    sink.stderr(message.endsWith("\n") ? message : message + "\n");
  }
}

export function die(message: string, code = 1): never {
  const alreadyDecided = pendingExitCode;
  if (alreadyDecided !== undefined) {
    // An earlier die()/exitProcess already decided this run's outcome and its
    // unwind was swallowed by an intervening catch. Re-raise the original
    // decision rather than emitting a second, contradictory error.
    return terminate(alreadyDecided);
  }
  if (currentMode.json) {
    // Machine contract: structured error on stdout for callers that parse it.
    emit({ ok: false, error: message });
  } else {
    sink.stderr(`error: ${message}\n`);
  }
  if (latchesExit()) pendingExitCode = code;
  return terminate(code);
}
