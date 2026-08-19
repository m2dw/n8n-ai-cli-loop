/**
 * Issue #839: resolve ONE bounded arbiter execution profile for a dispute that
 * #845 has directed toward arbitration (docs/review-dispute-contract.md §8.3).
 *
 * This module answers a single question — *which agent, invoked exactly how, is
 * independent enough to arbitrate this lineage?* — and stops there. It does not
 * invoke the arbiter, render its prompt, read repository evidence, parse a
 * verdict, consume an arbitration pass, or write anything into task context;
 * those are #846's and the routing work that follows it.
 *
 * ## What "independent" means here, and where each fact comes from
 *
 * §8.3 states the policy in terms of PROVIDERS, not vendors: the arbiter should
 * come from a provider different from **both** the implementer and the reviewer.
 * Three sourcing rules make that checkable rather than merely stated:
 *
 *  - **Implementer identity** comes from the persisted assignment
 *    (`context.assignment.implementationAgent`), the assignment source of truth —
 *    never from GitHub agent labels, which are an input to assignment and can
 *    disagree with what the task actually resolved.
 *  - **Reviewer identity** comes from the ACTUAL resolved review-run profile, not
 *    from `session.defaults.reviewAgent`: a label override or a flow profile can
 *    have routed the review elsewhere, and an arbiter proven independent of the
 *    configured default while sharing a provider with the run that actually
 *    produced the finding is not independent at all.
 *  - **Candidate identity** comes from the candidate's own resolved execution
 *    profile. Provider is read off that profile; it is never inferred from a
 *    display name, a label, or an executable filename, because an operator can
 *    point `ANTIGRAVITY_BIN` at any binary and a filename proves nothing about
 *    who bills the tokens.
 *
 * ## Fail closed, in three places
 *
 * §8.3's last sentence is the whole design constraint: "absence of an arbiter
 * never silently converts to 'reviewer wins' or 'implementer wins'". So:
 *
 *  1. a candidate that cannot be RESOLVED (unknown id, no arbiter invocation,
 *     unavailable CLI, unusable model/effort/budget) is rejected with its own
 *     reason code and the next candidate is tried — it is never substituted for;
 *  2. a candidate sharing a provider with either party is acceptable only under
 *     the explicit `allowSameProvider` opt-in AND a model that is PROVABLY
 *     different from both parties' models. Missing model metadata is not proof of
 *     difference, so it rejects (see {@link knownModel} — `cli-default` is an
 *     absence, not a model name);
 *  3. when nothing acceptable remains the result is a typed `human_handoff`
 *     carrying §7 row 19, with the bounded per-candidate reasons. Neither party
 *     wins by default, and the reviewer or the implementer is never quietly
 *     selected as its own judge.
 *
 * Nothing here touches the filesystem, SQLite, GitHub, or a subprocess. CLI
 * availability is an injected FACT, not something this module probes, which is
 * what lets `admin session-doctor` reuse probes it has already run rather than
 * repeating one per candidate.
 */

import type { AgentId } from "./task.js";
import type { AntigravityResearchConfig, CodexConfig } from "./session.js";
import {
  ARBITER_CANDIDATE_AGENT_IDS,
  MAX_MODEL_CHARS,
  type ResolvedArbiterPolicy,
  type ResolvedReviewDisputeSettings,
} from "./review-dispute.js";
import type { RevisionDecision } from "./review-revision-decision.js";
import { providerForAgent, resolveCodexModel } from "../handlers/codex-context-mode.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The two parties an arbiter must be independent of (§8.3). */
export const ARBITER_PARTY_ROLES = ["implementation", "review"] as const;
export type ArbiterPartyRole = (typeof ARBITER_PARTY_ROLES)[number];

/**
 * The agent ids a candidate list may name — the SAME tuple
 * `resolveReviewDisputeSettings` validates against, re-exported rather than
 * restated so the session-load boundary and the selection boundary can never
 * disagree about what counts as an agent id.
 */
export const ARBITER_SUPPORTED_AGENTS: readonly AgentId[] = ARBITER_CANDIDATE_AGENT_IDS;

export function isArbiterAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (ARBITER_SUPPORTED_AGENTS as readonly string[]).includes(value);
}

/** Where a resolved metadata field came from. Recorded so a run is auditable. */
export const ARBITER_METADATA_SOURCES = ["env", "session-config", "cli-default", "default"] as const;
export type ArbiterMetadataSource = (typeof ARBITER_METADATA_SOURCES)[number];

/** Effort tiers this runner accepts, shared with the implementation/review lanes. */
export const ARBITER_EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Why one candidate did not become the arbiter.
 *
 * Every code names a DIFFERENT fact, because the operator remedy differs for
 * each: a misconfigured id is edited, an unsupported role is a runner
 * limitation, an unavailable CLI is installed, an unusable model/effort/budget
 * is corrected, and a provider overlap is a policy decision.
 */
export const ARBITER_REJECTION_REASONS = [
  /** The configured entry is not one of this runner's agent ids. */
  "not-an-agent-id",
  /** The same agent id appears earlier in the list; the first position decides. */
  "duplicate-candidate",
  /** The resolver has no arbiter invocation for this agent (§8.2 no-tools posture). */
  "unsupported-role",
  /** The resolver knows of no such candidate at all. */
  "candidate-not-found",
  /** The candidate's CLI is not available on this host. */
  "cli-unavailable",
  /**
   * The availability probe never answered (timeout / refused fork, issue #897).
   * Distinct from `cli-unavailable` because the remedy differs: nothing is
   * installed or configured differently, the question is simply re-asked.
   */
  "cli-probe-indeterminate",
  /** Its model, effort, or budget could not be resolved to a usable value. */
  "profile-error",
  /** It shares a provider with a party and `allowSameProvider` is not `true`. */
  "same-provider-not-allowed",
  /** Same-provider fallback is open, but some party's or its own model is unknown. */
  "same-provider-model-unknown",
  /** Same-provider fallback is open, but it is the implementer's own model. */
  "same-model-as-implementation",
  /** Same-provider fallback is open, but it is the reviewer's own model. */
  "same-model-as-review",
  /** The configured list is longer than {@link MAX_ARBITER_CANDIDATES}. */
  "candidate-limit-exceeded",
] as const;
export type ArbiterRejectionReason = (typeof ARBITER_REJECTION_REASONS)[number];

/** The subset a candidate RESOLVER may report; the rest are decided by policy here. */
export const ARBITER_CANDIDATE_FAILURES = [
  "unsupported-role",
  "candidate-not-found",
  "cli-unavailable",
  "cli-probe-indeterminate",
  "profile-error",
] as const;
export type ArbiterCandidateFailure = (typeof ARBITER_CANDIDATE_FAILURES)[number];

/** Why no profile was resolved even though arbitration was asked for (§7 row 19). */
export const ARBITER_UNAVAILABLE_REASONS = ["no-candidates", "no-acceptable-candidate"] as const;
export type ArbiterUnavailableReason = (typeof ARBITER_UNAVAILABLE_REASONS)[number];

/** Why this module was not asked for a profile at all. Not a handoff. */
export const ARBITER_NOT_APPLICABLE_REASONS = ["dispute-disabled", "not-arbitration-intent"] as const;
export type ArbiterNotApplicableReason = (typeof ARBITER_NOT_APPLICABLE_REASONS)[number];

/**
 * The §7 row a `human_handoff` instantiates: "no acceptable arbiter
 * configured/available (§8.3) → escalated_human". Named rather than restated so
 * the transition owner routes on the contract's own row number.
 */
export const ARBITER_UNAVAILABLE_ROW = 19;

/**
 * Bound on how many configured candidates are evaluated, and therefore on how
 * many rejection records one resolution can carry. The list names agent ids, of
 * which this runner has three; the bound leaves room for future ones while
 * keeping the audit record a product of constants rather than of config length.
 */
export const MAX_ARBITER_CANDIDATES = 8;

/**
 * Model strings that are an ABSENCE rather than a model name.
 *
 * `cli-default` is what the Codex and Gemini lanes record when no explicit model
 * was selected and the CLI's own configuration decides — the run has a model,
 * but this process does not know which one. Treating that as a name would let a
 * same-provider candidate "prove" it differs from a party whose model string
 * happens to be spelled differently while both resolve to the same CLI default,
 * which is exactly the silent same-model arbitration §8.3 forbids.
 */
export const UNRESOLVED_MODEL_TOKENS = ["cli-default", "n/a", "unknown", "default", "unset"] as const;

/**
 * A model string this module is willing to COMPARE, normalized, or null when the
 * value proves nothing. Null is never equal to anything, including another null:
 * callers must treat it as "cannot prove different", never as "different".
 */
export function knownModel(model: string | undefined | null): string | null {
  if (typeof model !== "string") return null;
  const normalized = model.trim().toLowerCase();
  if (normalized === "") return null;
  return (UNRESOLVED_MODEL_TOKENS as readonly string[]).includes(normalized) ? null : normalized;
}

// ---------------------------------------------------------------------------
// The §8.2 no-tools invocation
// ---------------------------------------------------------------------------

/**
 * Built-in agent tools that must be unreachable while the arbiter reads a bundle
 * assembled from agent-authored prose (§8.2: "the agent is invoked with no tool
 * permissions, and the bundle is the entire input").
 *
 * The same list #838 denies for the reviewer's reconsideration, and for the same
 * reason: read tools are denied too, because a bundle is the entire input and an
 * arbiter that reads a file the runner did not resolve is deciding on evidence
 * nobody bounded.
 */
const ARBITER_DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillBash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
].join(",");

/** The CLI-level half of §8.2's read-only boundary for the Claude CLI. */
export const ARBITER_CLAUDE_NO_TOOLS_ARGS: readonly string[] = [
  "--tools",
  "",
  "--allowedTools",
  "",
  "--disallowedTools",
  ARBITER_DISALLOWED_TOOLS,
  "--strict-mcp-config",
  "--safe-mode",
  "--no-session-persistence",
];

/**
 * Which agents this runner has a DEFINED no-tools invocation for.
 *
 * This is deliberately a capability table rather than a preference: §8.2's
 * enforcement point is the runner, so an agent this runner cannot invoke WITHOUT
 * tools cannot be given an arbitration turn, however independent its provider
 * is. It is not a statement that any vendor makes the best arbiter — the
 * selection policy below never mentions one, and adding a verified no-tools argv
 * for another CLI here makes that agent selectable with no other change. #838
 * draws the same line for the reviewer's reconsideration.
 */
const ARBITER_NO_TOOLS_ARGS: Partial<Record<AgentId, readonly string[]>> = {
  claude: ARBITER_CLAUDE_NO_TOOLS_ARGS,
};

/**
 * Arbitration is a judgement call on a contested finding with no way to gather
 * more evidence, so the Claude lane defaults to its strong tier — as #838's
 * reconsideration does — rather than to the review lane's cheap one.
 */
export const DEFAULT_ARBITER_CLAUDE_MODEL = "opus";
export const DEFAULT_ARBITER_EFFORT = "high";

// ---------------------------------------------------------------------------
// Profiles and identities
// ---------------------------------------------------------------------------

/** Provider-specific configuration the metadata rules read. */
export interface ArbiterAgentConfig {
  /** `session.codex` — supplies the Codex model (issue #609 precedence). */
  codex?: CodexConfig;
  /** `session.research.antigravity` — supplies the Gemini/Antigravity model. */
  antigravity?: AntigravityResearchConfig;
}

/** The provider-resolved metadata of one candidate, before the §8.2 gate. */
export interface ArbiterAgentMetadata {
  /** Canonical provider/company identity backing the agent. */
  provider: string;
  cmd: string;
  /** Present where the binary path can be operator-overridden (Gemini). */
  cmdSource?: "env" | "cli-default";
  model?: string;
  modelSource: ArbiterMetadataSource;
  effort?: string;
  effortSource: ArbiterMetadataSource;
  maxBudgetUsd?: string;
  budgetSource: ArbiterMetadataSource;
}

/** One resolvable candidate: everything #846 needs to invoke exactly this run. */
export interface ArbiterCandidateProfile extends ArbiterAgentMetadata {
  agentId: AgentId;
  /** Sanitized argv — the bundle travels on stdin and never appears here. */
  argv: string[];
  /** States the enforced §8.2 posture in the run metadata, not just in code. */
  toolPolicy: "no-tools";
}

/**
 * A party's identity as the selection policy sees it. `model: null` means the
 * party's run metadata did not carry a model this process can compare — never
 * that it has none.
 */
export interface ArbiterPartyIdentity {
  role: ArbiterPartyRole;
  agentId: AgentId;
  provider: string;
  model: string | null;
}

/** What a caller supplies for each party. */
export interface ArbiterPartyInput {
  /**
   * Implementation: `context.assignment.implementationAgent`. Review: the agent
   * of the ACTUAL resolved review-run profile.
   */
  agentId: AgentId;
  /**
   * Provider from the party's resolved execution profile. When the run metadata
   * is unavailable this falls back to the canonical agent → company mapping,
   * which is the same value every resolved profile in this codebase records —
   * an agent id, not a label or an executable name.
   */
  provider?: string;
  /** Model from the party's resolved execution profile; absent = unknown. */
  model?: string;
}

/** The selected profile, plus the selection facts #846 and the audit need. */
export interface ResolvedArbiterExecutionProfile extends ArbiterCandidateProfile {
  phase: "review";
  role: "arbiter";
  /** Position in the configured candidate list. Selection order is the audit. */
  candidateIndex: number;
  /** §8.3 confidence threshold for the decisive verdicts of rows 13–14 and 18. */
  minConfidence: number;
  /** Whether the explicit same-provider opt-in was needed to accept this candidate. */
  sameProviderFallback: boolean;
  /** The parties it shares a provider with; empty for a cross-provider selection. */
  sharedProviderWith: ArbiterPartyRole[];
  implementation: ArbiterPartyIdentity;
  review: ArbiterPartyIdentity;
}

/** One bounded rejection record. Literals, an index, and a short locator only. */
export interface ArbiterCandidateRejection {
  /** Position in the configured list — order is part of the audit. */
  index: number;
  /** The configured entry as written, bounded; `null` for a non-string entry. */
  candidate: string | null;
  reason: ArbiterRejectionReason;
  /** Content-free locator (a field name, a party role, a count). */
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Candidate resolution seam
// ---------------------------------------------------------------------------

export type ArbiterCandidateResolution =
  | { ok: true; profile: ArbiterCandidateProfile }
  | { ok: false; reason: ArbiterCandidateFailure; detail?: string };

/**
 * Resolves one configured agent id to an invocable arbiter profile.
 *
 * Injected rather than fixed so the selection policy stays agent-agnostic: it is
 * what lets this module choose between providers without knowing any provider's
 * flags, and what keeps CLI availability an input fact instead of a probe.
 */
export type ArbiterCandidateResolver = (agentId: AgentId) => ArbiterCandidateResolution;

// ---------------------------------------------------------------------------
// Provider-specific metadata rules
// ---------------------------------------------------------------------------

/**
 * Resolve one agent's model/effort/budget through the SAME provider-specific
 * rules the implementation and review lanes already use — the session's Codex
 * and Antigravity configuration and the documented environment overrides —
 * never from a label, a display name, or an executable filename.
 *
 * The arbiter lane deliberately has no complexity-label input: an arbitration is
 * a bounded judgement on one contested finding, and the Issue's complexity says
 * nothing about how hard that judgement is.
 */
export function resolveArbiterAgentMetadata(
  agentId: AgentId,
  config: ArbiterAgentConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ArbiterAgentMetadata {
  const provider = providerForAgent(agentId);
  if (agentId === "claude") {
    const envModel = env["CLAUDE_MODEL"];
    const envEffort = env["CLAUDE_EFFORT"];
    const envBudget = env["CLAUDE_MAX_BUDGET_USD"];
    return {
      provider,
      cmd: "claude",
      model: envModel ?? DEFAULT_ARBITER_CLAUDE_MODEL,
      modelSource: envModel ? "env" : "default",
      effort: envEffort ?? DEFAULT_ARBITER_EFFORT,
      effortSource: envEffort ? "env" : "default",
      // No budget is invented for the arbiter lane: the implementation lane's
      // figures come from the complexity mapping, which has no arbiter tier, so
      // an explicit cap is only recorded when the operator set one.
      ...(envBudget === undefined ? {} : { maxBudgetUsd: envBudget }),
      budgetSource: envBudget === undefined ? "default" : "env",
    };
  }
  if (agentId === "codex") {
    const model = resolveCodexModel(config.codex, env);
    const envEffort = env["CODEX_EFFORT"];
    return {
      provider,
      cmd: "codex",
      model: model.model,
      modelSource: model.source === "unset" ? "cli-default" : model.source,
      effort: envEffort ?? DEFAULT_ARBITER_EFFORT,
      effortSource: envEffort ? "env" : "default",
      // Codex exposes no per-run budget cap flag.
      budgetSource: "default",
    };
  }
  const envBin = env["ANTIGRAVITY_BIN"];
  const sessionModel = config.antigravity?.model;
  return {
    provider,
    cmd: envBin ?? "agy",
    cmdSource: envBin ? "env" : "cli-default",
    model: sessionModel ?? "cli-default",
    modelSource: sessionModel ? "session-config" : "cli-default",
    // The Antigravity effort tier is part of the model display name
    // (e.g. "Gemini 3.1 Pro (Low)"), so there is no separate effort to resolve.
    effortSource: "default",
    budgetSource: "default",
  };
}

/**
 * Whether a value carries an ASCII control character.
 *
 * No CLI flag value may: a newline or a NUL inside a configured model name is
 * either truncated by the spawn or read as a second argument, so it is refused
 * here rather than passed on. Written as a code-point scan rather than a regex
 * so the range appears in the source as numbers instead of as literal control
 * bytes.
 */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A plain decimal amount, the form `--max-budget-usd` accepts. */
const BUDGET_AMOUNT = /^\d+(\.\d+)?$/;

/**
 * Check resolved metadata for a value the invocation layer could not use.
 *
 * Returns a content-free locator for the FIRST problem, or null when everything
 * is usable. A configured value that cannot be passed to the CLI must fail here,
 * before selection, rather than at invocation time: a candidate that would die on
 * argument parsing is not an available arbiter, and treating it as one would
 * spend the lineage's arbitration budget on nothing.
 */
export function validateArbiterMetadata(metadata: ArbiterAgentMetadata): string | null {
  if (metadata.cmd.trim() === "" || hasControlChars(metadata.cmd)) return "cmd:invalid";
  if (metadata.provider.trim() === "") return "provider:missing";
  if (metadata.model !== undefined) {
    if (metadata.model.trim() === "" || hasControlChars(metadata.model)) return "model:invalid";
    if (metadata.model.length > MAX_MODEL_CHARS) return "model:too-long";
  }
  if (metadata.effort !== undefined && !(ARBITER_EFFORT_TIERS as readonly string[]).includes(metadata.effort)) {
    return "effort:invalid";
  }
  if (metadata.maxBudgetUsd !== undefined) {
    if (!BUDGET_AMOUNT.test(metadata.maxBudgetUsd) || Number(metadata.maxBudgetUsd) <= 0) {
      return "budget:invalid";
    }
  }
  return null;
}

/** Build the sanitized argv for an agent that has a defined no-tools invocation. */
function arbiterArgv(agentId: AgentId, metadata: ArbiterAgentMetadata): string[] | null {
  const noTools = ARBITER_NO_TOOLS_ARGS[agentId];
  if (noTools === undefined) return null;
  if (agentId === "claude") {
    return [
      "-p",
      ...noTools,
      ...(metadata.model === undefined ? [] : ["--model", metadata.model]),
      ...(metadata.effort === undefined ? [] : ["--effort", metadata.effort]),
      ...(metadata.maxBudgetUsd === undefined ? [] : ["--max-budget-usd", metadata.maxBudgetUsd]),
    ];
  }
  return [...noTools];
}

/**
 * A caller's answer to "is this agent's CLI usable here?".
 *
 * `true`/`"available"` is the only pass. `"indeterminate"` (issue #897) is for
 * a probe that never answered — a timeout or a refused fork — and is kept
 * distinct from a negative answer so the rejection an operator reads describes
 * the host, not a CLI that was never shown to be missing. Anything else,
 * `undefined` included, is a negative answer: a caller that asked the question
 * and got nothing back has not shown the CLI is there.
 */
export type ArbiterCliAvailability = boolean | "available" | "unavailable" | "indeterminate" | undefined;

export interface ArbiterCandidateResolverOptions {
  config?: ArbiterAgentConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * Whether an agent's CLI is present on this host, as a FACT supplied by the
   * caller — this module never spawns a process. Omit it entirely to skip the
   * availability question (the invocation layer discovers it); supply it and
   * see {@link ArbiterCliAvailability} for how each answer is read.
   */
  cliAvailable?: (agentId: AgentId) => ArbiterCliAvailability;
}

/**
 * The default candidate resolver: this runner's own provider rules and §8.2
 * capability table.
 *
 * Check order is the diagnostic order, most-specific first: an agent this runner
 * cannot invoke without tools is reported as that, not as whatever its model
 * configuration happens to look like.
 */
export function createArbiterCandidateResolver(
  options: ArbiterCandidateResolverOptions = {},
): ArbiterCandidateResolver {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  return (agentId) => {
    if (!isArbiterAgentId(agentId)) {
      return { ok: false, reason: "candidate-not-found", detail: "unknown-agent" };
    }
    if (ARBITER_NO_TOOLS_ARGS[agentId] === undefined) {
      return { ok: false, reason: "unsupported-role", detail: "no-no-tools-invocation" };
    }
    if (options.cliAvailable !== undefined) {
      const availability = options.cliAvailable(agentId);
      if (availability === "indeterminate") {
        return { ok: false, reason: "cli-probe-indeterminate", detail: agentId };
      }
      if (availability !== true && availability !== "available") {
        return { ok: false, reason: "cli-unavailable", detail: agentId };
      }
    }
    const metadata = resolveArbiterAgentMetadata(agentId, config, env);
    const problem = validateArbiterMetadata(metadata);
    if (problem !== null) return { ok: false, reason: "profile-error", detail: problem };
    const argv = arbiterArgv(agentId, metadata);
    if (argv === null) return { ok: false, reason: "unsupported-role", detail: "no-no-tools-invocation" };
    return { ok: true, profile: { ...metadata, agentId, argv, toolPolicy: "no-tools" } };
  };
}

// ---------------------------------------------------------------------------
// Selection policy
// ---------------------------------------------------------------------------

export interface ArbiterCandidateEvaluationInput {
  /** The resolved §8.3 policy: ordered candidates, opt-in, threshold. */
  policy: ResolvedArbiterPolicy;
  /** The implementer, from the persisted assignment (never from labels). */
  implementation: ArbiterPartyInput;
  /** The reviewer, from the actual resolved review-run profile. */
  review: ArbiterPartyInput;
  resolveCandidate: ArbiterCandidateResolver;
}

export interface ArbiterCandidateEvaluation {
  /** The first acceptable candidate, or null when none is. */
  selected: ResolvedArbiterExecutionProfile | null;
  /** Every candidate that was not selected, in configured order. */
  rejections: ArbiterCandidateRejection[];
  implementation: ArbiterPartyIdentity;
  review: ArbiterPartyIdentity;
}

function partyIdentity(role: ArbiterPartyRole, input: ArbiterPartyInput): ArbiterPartyIdentity {
  const provider =
    input.provider !== undefined && input.provider.trim() !== ""
      ? input.provider
      : providerForAgent(input.agentId);
  return { role, agentId: input.agentId, provider, model: knownModel(input.model) };
}

/**
 * Evaluate the configured candidates in order and return the first acceptable
 * one, with a rejection record for every candidate that was passed over.
 *
 * Exported separately from {@link resolveArbiterExecutionProfile} so a read-only
 * diagnostic (`admin session-doctor`) can ask "would an arbiter be available for
 * these parties?" without inventing an arbitration intent it does not have.
 *
 * Deterministic: the same policy, parties, and resolver always produce the same
 * selection and the same rejection list, in the same order.
 */
export function evaluateArbiterCandidates(
  input: ArbiterCandidateEvaluationInput,
): ArbiterCandidateEvaluation {
  const implementation = partyIdentity("implementation", input.implementation);
  const review = partyIdentity("review", input.review);
  const rejections: ArbiterCandidateRejection[] = [];
  const configured: readonly unknown[] = Array.isArray(input.policy.providers) ? input.policy.providers : [];
  const evaluated = configured.slice(0, MAX_ARBITER_CANDIDATES);
  const firstSeenAt = new Map<string, number>();

  const reject = (
    index: number,
    candidate: unknown,
    reason: ArbiterRejectionReason,
    detail: string | null = null,
  ): void => {
    rejections.push({
      index,
      candidate: typeof candidate === "string" ? candidate : null,
      reason,
      detail,
    });
  };

  let selected: ResolvedArbiterExecutionProfile | null = null;
  for (const [index, entry] of evaluated.entries()) {
    if (selected !== null) break;
    // Defensive: a session loaded through `resolveReviewDisputeSettings` can
    // only carry agent ids, so reaching this means a hand-built policy bypassed
    // that boundary — which is exactly when failing closed matters.
    if (!isArbiterAgentId(entry)) {
      reject(index, entry, "not-an-agent-id");
      continue;
    }
    const firstIndex = firstSeenAt.get(entry);
    if (firstIndex !== undefined) {
      reject(index, entry, "duplicate-candidate", `first-at:${firstIndex}`);
      continue;
    }
    firstSeenAt.set(entry, index);

    const resolution = input.resolveCandidate(entry);
    if (!resolution.ok) {
      reject(index, entry, resolution.reason, resolution.detail ?? null);
      continue;
    }
    const profile = resolution.profile;
    // Provider identity is read off the RESOLVED profile, never off the id we
    // asked for: a resolver that reports a provider the canonical mapping would
    // not expect is telling us something we must honor, not correct.
    const sharedProviderWith = [implementation, review]
      .filter((party) => party.provider === profile.provider)
      .map((party) => party.role);

    if (sharedProviderWith.length === 0) {
      selected = {
        ...profile,
        phase: "review",
        role: "arbiter",
        candidateIndex: index,
        minConfidence: input.policy.minConfidence,
        sameProviderFallback: false,
        sharedProviderWith: [],
        implementation,
        review,
      };
      continue;
    }

    // §8.3: overlap is acceptable ONLY under the explicit opt-in.
    if (input.policy.allowSameProvider !== true) {
      reject(index, entry, "same-provider-not-allowed", sharedProviderWith.join("+"));
      continue;
    }
    // ...and only with a model provably different from BOTH parties, whichever
    // one the provider is shared with. An unknown model on either side is not
    // proof of difference.
    const candidateModel = knownModel(profile.model);
    if (candidateModel === null) {
      reject(index, entry, "same-provider-model-unknown", "candidate");
      continue;
    }
    if (implementation.model === null) {
      reject(index, entry, "same-provider-model-unknown", "implementation");
      continue;
    }
    if (review.model === null) {
      reject(index, entry, "same-provider-model-unknown", "review");
      continue;
    }
    if (candidateModel === implementation.model) {
      reject(index, entry, "same-model-as-implementation", null);
      continue;
    }
    if (candidateModel === review.model) {
      reject(index, entry, "same-model-as-review", null);
      continue;
    }
    selected = {
      ...profile,
      phase: "review",
      role: "arbiter",
      candidateIndex: index,
      minConfidence: input.policy.minConfidence,
      sameProviderFallback: true,
      sharedProviderWith,
      implementation,
      review,
    };
  }

  // Recorded rather than silently dropped: a truncated list is a bounded
  // decision this module made, and an operator reading "no acceptable arbiter"
  // is owed the fact that entries past the bound were never tried.
  if (configured.length > MAX_ARBITER_CANDIDATES) {
    rejections.push({
      index: MAX_ARBITER_CANDIDATES,
      candidate: null,
      reason: "candidate-limit-exceeded",
      detail: `configured:${configured.length}`,
    });
  }
  return { selected, rejections, implementation, review };
}

// ---------------------------------------------------------------------------
// The resolution
// ---------------------------------------------------------------------------

/**
 * The #845 decision this module consumes.
 *
 * Structurally typed off {@link RevisionDecision} so it is the SAME value
 * `decideRevision()` returns — this module never reclassifies materiality,
 * re-reads reviewer output, or repeats #845's lineage and version checks. It
 * asks one thing of the decision: did the typed path direct this lineage to
 * arbitration?
 */
export type ArbitrationIntent = Pick<RevisionDecision, "intent" | "lineageId">;

export interface ArbiterProfileInput extends Omit<ArbiterCandidateEvaluationInput, "policy"> {
  /** #845's typed decision. Only an `arbitration` intent resolves a profile. */
  decision: ArbitrationIntent;
  /** The session's resolved §6.1/§8.3 settings; `enabled` gates the protocol. */
  settings: ResolvedReviewDisputeSettings;
}

export type ArbiterProfileResolution =
  | {
      kind: "selected";
      lineageId: string;
      profile: ResolvedArbiterExecutionProfile;
      rejections: ArbiterCandidateRejection[];
    }
  | {
      kind: "human_handoff";
      lineageId: string;
      reason: ArbiterUnavailableReason;
      /** §7 row 19 — the transition owner's row, named rather than restated. */
      row: typeof ARBITER_UNAVAILABLE_ROW;
      rejections: ArbiterCandidateRejection[];
    }
  | {
      kind: "not_applicable";
      lineageId: string;
      reason: ArbiterNotApplicableReason;
      rejections: [];
    };

/**
 * Resolve the one arbiter execution profile for a lineage #845 sent to
 * arbitration, or say — in a typed value — why there is none.
 *
 * Never throws and never mutates: an unusable configuration is an outcome, not
 * an exception, because §8.3's effect for "no acceptable arbiter" is a human
 * handoff (§7 row 19) that a caller can only apply if it gets a value back.
 * Nothing is written to task context here; #846 owns that.
 */
export function resolveArbiterExecutionProfile(input: ArbiterProfileInput): ArbiterProfileResolution {
  const lineageId = input.decision.lineageId;
  if (!input.settings.enabled) {
    return { kind: "not_applicable", lineageId, reason: "dispute-disabled", rejections: [] };
  }
  if (input.decision.intent !== "arbitration") {
    return { kind: "not_applicable", lineageId, reason: "not-arbitration-intent", rejections: [] };
  }
  const evaluation = evaluateArbiterCandidates({
    policy: input.settings.arbiter,
    implementation: input.implementation,
    review: input.review,
    resolveCandidate: input.resolveCandidate,
  });
  if (evaluation.selected !== null) {
    return { kind: "selected", lineageId, profile: evaluation.selected, rejections: evaluation.rejections };
  }
  return {
    kind: "human_handoff",
    lineageId,
    reason: input.settings.arbiter.providers.length === 0 ? "no-candidates" : "no-acceptable-candidate",
    row: ARBITER_UNAVAILABLE_ROW,
    rejections: evaluation.rejections,
  };
}
