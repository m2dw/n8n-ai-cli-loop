// ---------------------------------------------------------------------------
// Quota / rate-limit classifier (issue #25, provenance-gated per issue #671)
//
// Agent CLIs (Claude, Codex, Gemini/Antigravity) can fail for reasons that are
// not about the task at all: a fixed-rate or subscription usage window is
// temporarily exhausted, a provider rate limit was hit, or the upstream API is
// transiently overloaded. Those failures are recoverable on their own once the
// quota window resets — the task should be retried after a delay rather than
// permanently failed or handed to a human.
//
// This classifier no longer inspects raw combined stdout/stderr. Per
// docs/phase-contracts.md ("Agent Diagnostic Provenance and Retry
// Classification"), text-only analysis cannot distinguish a genuine provider
// diagnostic from an identical string quoted inside a transcript, diff, or
// test fixture — the bytes are the same either way. Classification therefore
// consumes only a `AgentFailureDiagnostic` (see ./agent-diagnostics.ts) that a
// provider adapter has already vetted as trustworthy; raw stdout is never
// scanned here. Signals are matched case-insensitively. Most signals are
// generic across providers; a few are agent-specific where the phrasing only
// appears for one CLI. Keep this conservative: a false positive turns a
// genuine task failure into a silent delayed retry, so only well-known quota
// phrases are listed (e.g. plain "reset" is intentionally excluded because it
// collides with unrelated output such as "git reset").
// ---------------------------------------------------------------------------

import type { AgentFailureDiagnostic, AgentFailureKind } from "./agent-diagnostics.js";

type RecoverableKind = Exclude<AgentFailureKind, "ordinary_failure">;

/** Category precedence order: explicit usage-exhaustion wording wins over
 *  generic retry wording (docs/phase-contracts.md "Category precedence"). */
const CATEGORY_PRECEDENCE: RecoverableKind[] = ["usage_quota", "rate_limit", "provider_capacity"];

/** Generic (cross-provider) literal signals, keyed by the category they imply. */
const GENERIC_CATEGORY_SIGNALS: Record<RecoverableKind, string[]> = {
  usage_quota: ["usage limit", "usage-limit", "usage_limit", "insufficient_quota"],
  rate_limit: ["rate limit", "rate-limit", "ratelimit", "rate_limit", "too many requests"],
  provider_capacity: ["overloaded", "resource exhausted", "resource_exhausted"],
};

/**
 * Generic transient phrasing with no explicit category on its own. Per
 * docs/phase-contracts.md: "Generic transient phrasing such as 'try again
 * later' on its own ... must not be upgraded to usage_quota; it is only
 * decisive when it is the only trusted signal available and an adapter maps
 * it to rate_limit or provider_capacity, never to usage_quota by itself."
 */
const GENERIC_TRANSIENT_SIGNALS: string[] = ["try again later", "try again in"];

/**
 * Per-agent opt-in for the generic transient signals above (issue #672
 * review). "An adapter maps it" means a specific agent CLI's adapter has
 * vetted that, for that CLI, bare "try again later"/"try again in" wording
 * reliably indicates a rate-limit or capacity condition — not that the
 * classifier may assume this for any trusted diagnostic. The stderr adapters
 * in agent-diagnostics.ts currently do nothing more than bound and wrap raw
 * stderr; they have not established any such evidence for their CLIs. An
 * unrelated subprocess, linter, or tool failure can write this exact wording
 * to the same trusted stderr channel for a genuine `ordinary_failure`, so
 * this map intentionally starts empty. Populate an entry only once an
 * adapter has concrete, documented evidence that its own CLI's transient
 * message uses this generic phrasing and nothing more specific.
 */
const AGENT_GENERIC_TRANSIENT_CATEGORY: Partial<Record<string, RecoverableKind>> = {};

/**
 * Regex signals for cases a bare substring would over-match, keyed by
 * category. The HTTP 429 status is only treated as a rate-limit signal when
 * it appears with explicit status-code wording (e.g. "status code 429",
 * "http error 429") or alongside rate-limit phrasing — a plain "429" elsewhere
 * in the output (an issue reference, line number, test value, or a URL such
 * as `http://x/429`) must not defer an unrelated failure for hours. A bare
 * `http`/`https` token counts as status context (e.g. "HTTP 429 returned"),
 * but the URL-scheme form `http://` / `https://` is deliberately excluded via
 * a negative lookahead, so a 429 inside a URL path is not mistaken for an
 * HTTP 429 response (issue #25 review). A generic `error`/`err` token is
 * deliberately NOT accepted as context: an ordinary assertion such as
 * `Error: expected 429 but received 200` is a real failure, not quota
 * exhaustion, and must surface rather than be silently re-queued.
 *
 * The bare word `quota` is likewise too generic: a file path such as
 * `src/core/quota-classifier.ts` or a TypeScript error that merely mentions
 * the word would otherwise defer a genuine failure for hours. So `quota` is
 * only a signal when paired with exhaustion/limit context on either side
 * (issue #25 review).
 */
const CATEGORY_REGEX_SIGNALS: Record<RecoverableKind, RegExp[]> = {
  usage_quota: [
    /\bquota\b[^\n]{0,32}\b(?:exceed(?:ed|s)?|exhaust(?:ed)?|limit(?:ed)?|reached|remaining|left|depleted|insufficient|unavailable|throttl|run\s?out|ran\s?out)\b/,
    /\b(?:exceed(?:ed|s|ing)?|exhaust(?:ed)?|insufficient|out\s?of|ran\s?out\s?of|reached|remaining|depleted|low\s?on|hit)\b[^\n]{0,32}\bquota\b/,
  ],
  rate_limit: [
    /\b(?:status code|status_code|statuscode|status|http status|http error|http response|https?(?!:\/\/))\b[^\n]{0,24}\b429\b/,
    /\b429\b[^\n]{0,24}(?:too many requests|rate.?limit|quota|throttl|retry|try again|exhaust)/,
  ],
  provider_capacity: [],
};

/**
 * Agent-specific literal signals layered on top of the generic set, keyed by
 * agent then category. Keep these to phrasing that is genuinely unique to one
 * CLI so the classifier stays precise.
 */
const AGENT_CATEGORY_SIGNALS: Record<string, Partial<Record<RecoverableKind, string[]>>> = {
  claude: {
    usage_quota: ["usage limit reached", "5-hour limit", "your limit will reset"],
    provider_capacity: ["overloaded_error"],
  },
  codex: {
    usage_quota: ["you've hit your usage limit", "you have hit your usage limit", "weekly limit"],
  },
  gemini: {
    usage_quota: ["quota exceeded", "check quota"],
    provider_capacity: ["resource has been exhausted"],
  },
};

function scanCategory(
  haystack: string,
  agentId: string | undefined,
): { category: AgentFailureKind; signal?: string } {
  const agentSignals = agentId ? AGENT_CATEGORY_SIGNALS[agentId] : undefined;
  for (const category of CATEGORY_PRECEDENCE) {
    const literals = [...(agentSignals?.[category] ?? []), ...GENERIC_CATEGORY_SIGNALS[category]];
    for (const signal of literals) {
      if (haystack.includes(signal)) return { category, signal };
    }
    for (const regex of CATEGORY_REGEX_SIGNALS[category]) {
      const match = regex.exec(haystack);
      if (match) return { category, signal: match[0] };
    }
  }
  const genericCategory = agentId ? AGENT_GENERIC_TRANSIENT_CATEGORY[agentId] : undefined;
  if (genericCategory) {
    for (const signal of GENERIC_TRANSIENT_SIGNALS) {
      if (haystack.includes(signal)) return { category: genericCategory, signal };
    }
  }
  return { category: "ordinary_failure" };
}

export interface QuotaClassification {
  /** True when the diagnostic looks like a recoverable quota/rate-limit failure. */
  isQuotaExhaustion: boolean;
  /** The matched signal, for diagnostics/event payloads. Bounded to the matched text only. */
  signal?: string;
  /** The normalized failure category (issue #671). */
  category: AgentFailureKind;
}

/**
 * Classify a trusted agent failure diagnostic as quota/rate-limit exhaustion
 * (or not).
 *
 * Unlike the pre-#671 API, this does not accept raw combined output — it only
 * consumes an `AgentFailureDiagnostic` that a provider adapter has already
 * established provenance for (see ./agent-diagnostics.ts
 * `extractAgentFailureDiagnostic`). A transcript, diff, or quoted log line
 * containing the exact same phrases never reaches this function because it is
 * never wrapped in a diagnostic in the first place — ambiguous markerless
 * stdout produces no diagnostic and therefore no trusted retry
 * classification.
 */
export function classifyQuotaExhaustion(
  diagnostic: AgentFailureDiagnostic | undefined,
): QuotaClassification {
  if (!diagnostic) return { isQuotaExhaustion: false, category: "ordinary_failure" };
  const haystack = `${diagnostic.code ?? ""} ${diagnostic.text ?? ""}`.toLowerCase().trim();
  if (!haystack) return { isQuotaExhaustion: false, category: "ordinary_failure" };
  const agentId = typeof diagnostic.agentId === "string" ? diagnostic.agentId : undefined;
  const { category, signal } = scanCategory(haystack, agentId);
  return { isQuotaExhaustion: category !== "ordinary_failure", signal, category };
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

/**
 * Short transient backoff for `rate_limit` / `provider_capacity` (issue
 * #671, docs/phase-contracts.md "Retry policy by category": a brief backoff,
 * not the multi-hour quota delay). Configurable via env so operators can
 * tune it without code changes:
 *
 *   TRANSIENT_RETRY_DELAY_MS — explicit delay in milliseconds
 *
 * Invalid/non-positive values are ignored and the default applies.
 */
export const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 5 * 60 * 1000;

export function resolveTransientRetryDelayMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const ms = parsePositiveNumber(env["TRANSIENT_RETRY_DELAY_MS"]);
  if (ms !== undefined) return ms;
  return DEFAULT_TRANSIENT_RETRY_DELAY_MS;
}

/**
 * Resolve the retry delay for a classified failure category (issue #671).
 * `usage_quota` gets the long, reset-oriented delay; `rate_limit` and
 * `provider_capacity` get the short transient backoff — both are
 * "recoverable quickly", independent of any usage window
 * (docs/phase-contracts.md "Retry policy by category"). Not meaningful for
 * `ordinary_failure`, which callers must not route through the quota-delay
 * path at all.
 */
export function resolveRetryDelayMsForCategory(
  category: AgentFailureKind,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return category === "usage_quota" ? resolveQuotaRetryDelayMs(env) : resolveTransientRetryDelayMs(env);
}

/**
 * Handler-level `retryAfterMs` override for a classified category (issue
 * #672 review). `runNextPhase` resolves the delay as
 * `result.retryAfterMs ?? options.quotaRetryDelayMs ?? resolveQuotaRetryDelayMs()`
 * (see phase-runner.ts), so a handler-supplied value always wins over a
 * caller's configured `quotaRetryDelayMs`. For `usage_quota` this function
 * returns `undefined` so handlers omit the override entirely and defer to the
 * runner's own quota-delay resolution — preserving a caller's configured
 * override instead of silently replacing it with the environment/default
 * delay. `rate_limit` and `provider_capacity` still need a handler override
 * (the runner has no separate "transient" option), so those get the short
 * transient backoff as before.
 */
export function resolveRetryDelayOverrideMsForCategory(
  category: AgentFailureKind,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return category === "usage_quota" ? undefined : resolveTransientRetryDelayMs(env);
}

/**
 * Human-readable label for a normalized failure category (issue #672), used
 * to build category-appropriate task-event messages and public comments so a
 * `provider_capacity` failure is never worded as if the caller exhausted
 * their own usage quota (and a `rate_limit` failure is never worded as
 * "quota exhausted" either).
 */
const CATEGORY_LABELS: Record<Exclude<AgentFailureKind, "ordinary_failure">, string> = {
  usage_quota: "usage quota",
  rate_limit: "rate limit",
  provider_capacity: "provider capacity",
};

export function describeFailureCategory(category: AgentFailureKind): string {
  return category === "ordinary_failure" ? "failure" : CATEGORY_LABELS[category];
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}
