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

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * Reads one `<digits>[.<digits>]<unit>` segment starting exactly at `start`,
 * or `undefined` when none starts there. A single forward scan (issue #1200):
 * a global regex resumed after junk rescans a long digit run once per start
 * position, which is quadratic in the input length.
 */
function readSegment(text: string, start: number): { numStr: string; unit: string; end: number } | undefined {
  let i = start;
  while (isDigit(text[i])) i += 1;
  if (i === start) return undefined;
  if (text[i] === "." && isDigit(text[i + 1])) {
    i += 1;
    while (isDigit(text[i])) i += 1;
  }
  const unit = text[i];
  if (unit !== "h" && unit !== "m" && unit !== "s") return undefined;
  return { numStr: text.slice(start, i), unit, end: i + 1 };
}

/**
 * Whether any segment starts at or after `from`. Every segment ends in a digit
 * immediately followed by its unit, and a digit followed by a unit is itself a
 * segment, so this is a linear scan for that pair.
 */
function segmentStartsAtOrAfter(text: string, from: number): boolean {
  for (let i = from; i + 1 < text.length; i += 1) {
    const next = text[i + 1];
    if (isDigit(text[i]) && (next === "h" || next === "m" || next === "s")) return true;
  }
  return false;
}

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
  let consumed = 0;
  let totalMs = 0;
  const seenUnits = new Set<string>();
  while (consumed < trimmed.length) {
    const segment = readSegment(trimmed, consumed);
    if (segment === undefined) {
      // Junk followed by a later segment is reported by position; trailing
      // junk (or no segment at all) falls through to the generic message.
      if (segmentStartsAtOrAfter(trimmed, consumed)) {
        throw new Error(
          `is not a valid duration (expected a value like "15m", "90s", or "1h30m"): unexpected characters at position ${consumed}`,
        );
      }
      break;
    }
    const { numStr, unit, end } = segment;
    if (seenUnits.has(unit)) {
      throw new Error(`is not a valid duration: unit "${unit}" is repeated`);
    }
    seenUnits.add(unit);
    totalMs += parseFloat(numStr) * UNIT_MS[unit];
    consumed = end;
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
