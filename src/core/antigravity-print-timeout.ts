// ---------------------------------------------------------------------------
// Antigravity print-mode timeout (issue #861)
//
// `agy --print` applies its own headless-mode timeout, printed by `agy --help`
// as `--print-timeout  Timeout for print mode wait (default 5m0s)`. A large
// but valid research task can exceed five minutes; when it does, the CLI exits
// non-zero after emitting only a partial response and the research phase is
// classified as a command failure — indistinguishable, without cross-checking
// elapsed time, from a genuine agent error.
//
// This module owns the accepted duration format and its bounds so the value
// is validated once, before it ever reaches command argv, and the same parser
// backs both session-config validation (json-session-registry.ts) and the
// handler's own defensive re-validation (research.ts).
// ---------------------------------------------------------------------------

/**
 * Default `--print-timeout` applied when a session does not configure one.
 * Three times Antigravity's own five-minute CLI default, chosen to give large
 * structured research tasks headroom without an effectively unbounded run
 * (issue #861: the observed incident's failed runs both cut off within
 * seconds of the 5-minute CLI default; the preceding successful run on the
 * same task took 3m39s).
 */
export const ANTIGRAVITY_PRINT_TIMEOUT_DEFAULT = "15m";

/**
 * Upper bound on the resolved duration. Chosen to comfortably exceed any
 * observed research run while still rejecting an effectively unbounded
 * configuration value (e.g. an operator typo like "15h" instead of "15m").
 */
export const ANTIGRAVITY_PRINT_TIMEOUT_MAX_MS = 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

const DURATION_SEGMENT_RE = /(\d+(?:\.\d+)?)(h|m|s)/g;

export interface ResolvedAntigravityPrintTimeout {
  /** The trimmed duration string, passed through verbatim as the `--print-timeout` value. */
  raw: string;
  /** The same duration expressed in milliseconds, for bounds checks and diagnostics. */
  ms: number;
}

/**
 * Parses and validates a Go-`time.ParseDuration`-shaped string (the format
 * `agy --print-timeout` itself accepts): one or more `<number><unit>`
 * segments using `h`, `m`, or `s`, e.g. `"15m"`, `"90s"`, `"1h30m"`.
 *
 * Rejects empty/whitespace-only input, malformed input (unrecognized
 * characters, a repeated unit, a bare negative sign — none of which form a
 * valid segment sequence), a total duration that is zero or negative, and a
 * total that exceeds {@link ANTIGRAVITY_PRINT_TIMEOUT_MAX_MS}. Throws
 * `Error` with a message describing the violation; callers prefix it with
 * the offending config path.
 */
export function parseAntigravityPrintTimeout(raw: string): ResolvedAntigravityPrintTimeout {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error('must be a non-empty duration string (e.g. "15m", "90s", "1h30m")');
  }
  const trimmed = raw.trim();
  DURATION_SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let consumed = 0;
  let totalMs = 0;
  const seenUnits = new Set<string>();
  while ((match = DURATION_SEGMENT_RE.exec(trimmed)) !== null) {
    if (match.index !== consumed) {
      throw new Error(
        `is not a valid duration (expected a value like "15m", "90s", or "1h30m"): unexpected characters at position ${consumed}`,
      );
    }
    const [full, numStr, unit] = match;
    if (seenUnits.has(unit)) {
      throw new Error(`is not a valid duration: unit "${unit}" is repeated`);
    }
    seenUnits.add(unit);
    totalMs += parseFloat(numStr) * UNIT_MS[unit];
    consumed += full.length;
  }
  if (consumed === 0 || consumed !== trimmed.length) {
    throw new Error('is not a valid duration (expected a value like "15m", "90s", or "1h30m")');
  }
  if (totalMs <= 0) {
    throw new Error("must be greater than zero");
  }
  if (totalMs > ANTIGRAVITY_PRINT_TIMEOUT_MAX_MS) {
    throw new Error(`must not exceed ${ANTIGRAVITY_PRINT_TIMEOUT_MAX_MS / 60_000} minutes`);
  }
  return { raw: trimmed, ms: totalMs };
}
