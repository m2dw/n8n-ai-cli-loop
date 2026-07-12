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
  process.stdout.write(JSON.stringify(payload) + "\n");
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
  const text = render(currentMode);
  if (text.length > 0) {
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }
}

/** Write a warning/progress line to stderr. Suppressed in quiet mode. */
export function warn(message: string): void {
  if (!currentMode.quiet) {
    process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  }
}

export function die(message: string, code = 1): never {
  if (currentMode.json) {
    // Machine contract: structured error on stdout for callers that parse it.
    emit({ ok: false, error: message });
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(code);
}
