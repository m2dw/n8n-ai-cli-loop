// ---------------------------------------------------------------------------
// Provider-owned structured agent failure diagnostics (issue #671)
//
// See docs/phase-contracts.md — "Agent Diagnostic Provenance and Retry
// Classification" for the authoritative contract this module implements.
//
// Summary: raw agent stdout is untrusted for automatic retry classification
// because an agent's own output can quote, reproduce, or synthesize a
// provider error string verbatim (a transcript, a reviewed diff, a test
// fixture) — the bytes are indistinguishable from a genuine provider
// diagnostic. Automatic classification must therefore consume only a
// bounded, provider-owned `AgentFailureDiagnostic` that an agent-specific
// adapter constructs from a source it can show originated from the
// provider/CLI process itself, never from agent-authored or agent-quoted
// content. Raw stdout, stderr, and exitCode remain available separately on
// the caller's command result for artifacts/debugging; adapters only decide
// what is trusted for classification.
// ---------------------------------------------------------------------------

import type { AgentId } from "./task.js";

/** Normalized failure category. Exactly one applies per classification. */
export type AgentFailureKind =
  | "usage_quota"
  | "rate_limit"
  | "provider_capacity"
  | "ordinary_failure";

/**
 * Where a diagnostic's text/code was extracted from. Only these sources are
 * ever eligible for trusted classification — raw stdout is deliberately not
 * a member of this type.
 *
 * - `structured` — a machine-readable provider result (a documented error
 *   code, a typed field, a documented exit-code convention): provenance is
 *   established by construction because the adapter is reading a channel the
 *   provider contractually controls.
 * - `stderr` — the bounded, provider-owned stderr channel a provider adapter
 *   has explicitly declared for a given agent CLI.
 */
export type AgentDiagnosticSource = "structured" | "stderr";

/**
 * A provider-owned, bounded failure diagnostic. Constructing one of these IS
 * the trust boundary: an adapter must only build one from a source it can
 * show originated from the provider/CLI process's own diagnostic output for
 * this invocation. This type is intentionally provider-neutral — it carries
 * only what an adapter has vetted as trustworthy for automatic retry
 * classification, not the raw combined output.
 */
export interface AgentFailureDiagnostic {
  /** The agent/provider this diagnostic was extracted for. */
  agentId: AgentId | string;
  /** Trusted source the text/code was extracted from. */
  source: AgentDiagnosticSource;
  /**
   * Bounded diagnostic text (see MAX_DIAGNOSTIC_TEXT_LENGTH) — the trusted
   * channel's tail, never the full unbounded capture.
   */
  text?: string;
  /** A stable, documented provider error code, when the source exposes one. */
  code?: string;
  /** The process exit code this diagnostic was extracted alongside, for context. */
  exitCode?: number;
}

/**
 * Bounded retention window applied to trusted diagnostic text
 * (docs/phase-contracts.md: "a fixed-size window, e.g. the final few KB").
 * This keeps a long transcript that happens to scroll through a trusted
 * channel from being retained wholesale.
 */
export const MAX_DIAGNOSTIC_TEXT_LENGTH = 4000;

/** Trusted-channel bounded tail used for diagnostic text. */
function boundedTail(text: string): string {
  return text.length > MAX_DIAGNOSTIC_TEXT_LENGTH
    ? text.slice(text.length - MAX_DIAGNOSTIC_TEXT_LENGTH)
    : text;
}

/** The minimal raw command output shape every adapter consumes. */
export interface AgentCommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Provenance of the invocation itself, threaded in by the caller alongside
 * the raw command output. Some agent CLIs (Gemini/Antigravity via
 * `ANTIGRAVITY_BIN`) can be pointed at an operator-supplied executable path
 * instead of the vetted CLI binary. When that override is in effect, this
 * module has no way to show that a given invocation's stderr originated from
 * the provider CLI's own diagnostic output rather than a wrapper script's own
 * errors or its relayed/echoed subprocess output — the same provenance gap
 * the contract already closes off for a verbose/debug mode that echoes the
 * agent transcript to stderr (docs/phase-contracts.md "Stderr: a bounded,
 * provider-owned diagnostic channel"). `cmdSource: "env"` therefore withholds
 * trust from stderr for that invocation; `"cli-default"` (or omitting the
 * option entirely, for adapters with no override mechanism) trusts it as
 * before.
 */
export interface AgentDiagnosticOptions {
  cmdSource?: "env" | "cli-default";
}

/**
 * Build a bounded, stderr-sourced diagnostic. Stderr is a provider-owned
 * diagnostic channel only because this module explicitly declares it so for
 * the agent CLIs below (docs/phase-contracts.md "Stderr: a bounded,
 * provider-owned diagnostic channel") — it is not automatically trusted for
 * every caller. Raw stdout is never read here. Returns undefined for empty
 * stderr since there is nothing to classify.
 */
function stderrDiagnostic(
  agentId: AgentId | string,
  result: AgentCommandOutput,
): AgentFailureDiagnostic | undefined {
  const trimmed = result.stderr.trim();
  if (!trimmed) return undefined;
  return { agentId, source: "stderr", text: boundedTail(trimmed), exitCode: result.exitCode };
}

/**
 * Claude CLI adapter. The Claude CLI invocations in this codebase
 * (`claude -p ...`) do not currently request a structured/JSON output mode,
 * so this falls back to the bounded stderr channel. If a future invocation
 * adds a documented machine-readable error surface, extend this adapter to
 * prefer it over the stderr fallback (see the module contract above).
 */
export function extractClaudeDiagnostic(result: AgentCommandOutput): AgentFailureDiagnostic | undefined {
  return stderrDiagnostic("claude", result);
}

/**
 * Codex CLI adapter. Same rationale as Claude above: the `codex review`
 * invocation used by this codebase does not request structured output, so
 * classification falls back to the bounded stderr channel.
 */
export function extractCodexDiagnostic(result: AgentCommandOutput): AgentFailureDiagnostic | undefined {
  return stderrDiagnostic("codex", result);
}

/**
 * Gemini/Antigravity CLI adapter. Same rationale: `agy --print ...` does not
 * request structured output, so classification falls back to the bounded
 * stderr channel — but only when the invocation actually ran the vetted `agy`
 * binary. When the caller reports `cmdSource: "env"` (the operator pointed
 * `ANTIGRAVITY_BIN` at a different executable), that process's stderr is not
 * provably the provider CLI's own diagnostic output — it could be a wrapper
 * script's own errors, or content the wrapper relays/echoes from elsewhere —
 * so this adapter withholds trust and yields no diagnostic rather than
 * classifying it.
 */
export function extractGeminiDiagnostic(
  result: AgentCommandOutput,
  options?: AgentDiagnosticOptions,
): AgentFailureDiagnostic | undefined {
  if (options?.cmdSource === "env") return undefined;
  return stderrDiagnostic("gemini", result);
}

const ADAPTERS: Record<
  string,
  (result: AgentCommandOutput, options?: AgentDiagnosticOptions) => AgentFailureDiagnostic | undefined
> = {
  claude: extractClaudeDiagnostic,
  codex: extractCodexDiagnostic,
  gemini: extractGeminiDiagnostic,
};

/**
 * Dispatch to the agent-specific adapter for `agentId`. Per the provenance
 * contract (docs/phase-contracts.md "Boundary"), stderr is only a trusted
 * diagnostic channel once a provider-specific adapter has explicitly
 * declared it so for that agent CLI. A missing or unrecognized agent id has
 * no such adapter, so it yields no diagnostic at all rather than falling
 * back to the bounded-stderr policy — trusting arbitrary stderr for an
 * unregistered agent would reintroduce the untrusted-text-matching problem
 * this module exists to close off. `options` carries invocation provenance
 * (e.g. whether the binary path was operator-overridden) through to the
 * adapter so it can withhold trust when that provenance cannot be shown.
 */
export function extractAgentFailureDiagnostic(
  agentId: AgentId | string | undefined,
  result: AgentCommandOutput,
  options?: AgentDiagnosticOptions,
): AgentFailureDiagnostic | undefined {
  const adapter = typeof agentId === "string" ? ADAPTERS[agentId] : undefined;
  return adapter ? adapter(result, options) : undefined;
}
