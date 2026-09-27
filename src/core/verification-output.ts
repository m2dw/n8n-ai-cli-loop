/**
 * Bound for captured verification output.
 *
 * Verification output (e.g. a full `npm test` log) is bounded before it is
 * surfaced in task context or a repair prompt so a verbose run cannot grow the
 * persisted context column without limit. The tail is kept because test runners
 * print the failing assertions and summary at the end of the log.
 *
 * The bound is pure string policy applied by both the Execution layer
 * (`handlers/verification.ts`, which re-exports it unchanged) and the
 * Orchestration layer (`core/tool-request-run.ts` records the guided run's
 * captured stdout/stderr under the same bound), so it lives in `core/` —
 * `core/` may not runtime-import from `handlers/` (DOMAIN.md §2.3).
 */

export const MAX_VERIFICATION_OUTPUT_CHARS = 4000;

export function boundVerificationOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_VERIFICATION_OUTPUT_CHARS) return trimmed;
  return "…(truncated)\n" + trimmed.slice(trimmed.length - MAX_VERIFICATION_OUTPUT_CHARS);
}
