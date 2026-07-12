// ---------------------------------------------------------------------------
// Quota / rate-limit classifier (issue #25)
//
// Agent CLIs (Claude, Codex, Gemini/Antigravity) can fail for reasons that are
// not about the task at all: a fixed-rate or subscription usage window is
// temporarily exhausted, a provider rate limit was hit, or the upstream API is
// transiently overloaded. Those failures are recoverable on their own once the
// quota window resets — the task should be retried after a delay rather than
// permanently failed or handed to a human.
//
// This classifier inspects the combined stdout/stderr of an agent command for
// quota/rate-limit signals. Signals are matched case-insensitively. Most signals
// are generic across providers; a few are agent-specific where the phrasing only
// appears for one CLI. Keep this conservative: a false positive turns a genuine
// task failure into a silent delayed retry, so only well-known quota phrases are
// listed (e.g. plain "reset" is intentionally excluded because it collides with
// unrelated output such as "git reset").
// ---------------------------------------------------------------------------

import type { AgentId } from "./task.js";

/** Signals that indicate quota/rate-limit exhaustion for any agent. */
const GENERIC_SIGNALS: string[] = [
  "rate limit",
  "rate-limit",
  "ratelimit",
  "rate_limit",
  "usage limit",
  "usage-limit",
  "usage_limit",
  "too many requests",
  "try again later",
  "try again in",
  "resource exhausted",
  "resource_exhausted",
  "insufficient_quota",
  "overloaded",
];

/**
 * Regex signals for cases a bare substring would over-match. The HTTP 429 status
 * is only treated as a quota signal when it appears with explicit status-code
 * wording (e.g. "status code 429", "http error 429") or alongside rate-limit
 * phrasing — a plain "429" elsewhere in the output (an issue reference, line
 * number, test value, or a URL such as `http://x/429`) must not defer an
 * unrelated failure for hours. A bare `http`/`https` token counts as status
 * context (e.g. "HTTP 429 returned"), but the URL-scheme form `http://` /
 * `https://` is deliberately excluded via a negative lookahead, so a 429 inside
 * a URL path is not mistaken for an HTTP 429 response (issue #25 review). A generic `error`/`err` token
 * is deliberately NOT accepted as context: an ordinary assertion such as
 * `Error: expected 429 but received 200` is a real failure, not quota
 * exhaustion, and must surface rather than be silently re-queued.
 *
 * The bare word `quota` is likewise too generic: a file path such as
 * `src/core/quota-classifier.ts` or a TypeScript error that merely mentions the
 * word would otherwise defer a genuine failure for hours. So `quota` is only a
 * signal when paired with exhaustion/limit context on either side (issue #25
 * review).
 */
const GENERIC_REGEX_SIGNALS: RegExp[] = [
  /\b(?:status code|status_code|statuscode|status|http status|http error|http response|https?(?!:\/\/))\b[^\n]{0,24}\b429\b/,
  /\b429\b[^\n]{0,24}(?:too many requests|rate.?limit|quota|throttl|retry|try again|exhaust)/,
  /\bquota\b[^\n]{0,32}\b(?:exceed(?:ed|s)?|exhaust(?:ed)?|limit(?:ed)?|reached|remaining|left|depleted|insufficient|unavailable|throttl|run\s?out|ran\s?out)\b/,
  /\b(?:exceed(?:ed|s|ing)?|exhaust(?:ed)?|insufficient|out\s?of|ran\s?out\s?of|reached|remaining|depleted|low\s?on|hit)\b[^\n]{0,32}\bquota\b/,
];

/**
 * Agent-specific signals layered on top of the generic set. Keep these to
 * phrasing that is genuinely unique to one CLI so the classifier stays precise.
 */
const AGENT_SIGNALS: Partial<Record<AgentId, string[]>> = {
  claude: [
    "usage limit reached",
    "5-hour limit",
    "your limit will reset",
    "overloaded_error",
  ],
  codex: [
    "you've hit your usage limit",
    "you have hit your usage limit",
    "weekly limit",
  ],
  gemini: [
    "quota exceeded",
    "resource has been exhausted",
    "check quota",
  ],
};

export interface QuotaClassification {
  /** True when the output looks like a recoverable quota/rate-limit failure. */
  isQuotaExhaustion: boolean;
  /** The first matched signal, for diagnostics/event payloads. */
  signal?: string;
}

/**
 * Classify agent command output as quota/rate-limit exhaustion (or not).
 *
 * @param output  Combined stdout/stderr from the agent command.
 * @param agentId Optional agent id so agent-specific phrasing is also matched.
 */
export function classifyQuotaExhaustion(
  output: string | undefined,
  agentId?: AgentId | string,
): QuotaClassification {
  if (!output) return { isQuotaExhaustion: false };
  const haystack = output.toLowerCase();
  const agentSignals =
    typeof agentId === "string" ? AGENT_SIGNALS[agentId as AgentId] ?? [] : [];
  for (const signal of [...GENERIC_SIGNALS, ...agentSignals]) {
    if (haystack.includes(signal)) {
      return { isQuotaExhaustion: true, signal };
    }
  }
  for (const regex of GENERIC_REGEX_SIGNALS) {
    const match = regex.exec(haystack);
    if (match) {
      return { isQuotaExhaustion: true, signal: match[0] };
    }
  }
  return { isQuotaExhaustion: false };
}

// ---------------------------------------------------------------------------
// Retry-delay resolution
//
// When a quota failure is detected the task is released back to `queued` with a
// `notBefore` timestamp so it is not reclaimed until the quota window is likely
// to have reset. The default is 2 hours — quota resets are often observed
// around that mark even when the provider message says "5 hours". Configurable
// via environment so operators can tune it without code changes:
//
//   QUOTA_RETRY_DELAY_MS    — explicit delay in milliseconds (takes precedence)
//   QUOTA_RETRY_DELAY_HOURS — delay in hours (used when *_MS is unset)
//
// Invalid/non-positive values are ignored and the default applies.
// ---------------------------------------------------------------------------

export const DEFAULT_QUOTA_RETRY_DELAY_MS = 2 * 60 * 60 * 1000;

export function resolveQuotaRetryDelayMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const ms = parsePositiveNumber(env["QUOTA_RETRY_DELAY_MS"]);
  if (ms !== undefined) return ms;
  const hours = parsePositiveNumber(env["QUOTA_RETRY_DELAY_HOURS"]);
  if (hours !== undefined) return hours * 60 * 60 * 1000;
  return DEFAULT_QUOTA_RETRY_DELAY_MS;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}
