/**
 * Who the two parties to a review dispute actually were (§8.3).
 *
 * The arbitration sub-turn runs one or more phases AFTER the runs it arbitrates:
 * the review run that raised the finding, the fix run that rebutted it, and the
 * reviewer's reconsideration are all behind it. §8.3 measures a candidate
 * arbiter's independence against those runs — not against whatever the session
 * is configured to use by the time arbitration happens. A task whose assignment
 * was reconfigured, or one that predates assignment persistence, would otherwise
 * be measured against the CURRENT lane and could select an arbiter sharing the
 * original reviewer's provider.
 *
 * So each run records its own resolved identity here, under one dedicated,
 * never-overwritten context key — the same shape and the same reason
 * `disputeArtifactDir`/`reconsiderationArtifactDir` exist for.
 *
 * What travels is ONE field: the agent id. Everything read back out of task
 * context is untrusted — a restored, migrated, or otherwise altered task carries
 * exactly the same shape as one this runner wrote — and §8.3's two comparisons
 * are precisely the ones a forged field would subvert:
 *
 *  - a forged `provider` hides that a candidate shares the actual party's
 *    provider, turning a same-provider selection into an apparently
 *    cross-provider one. So the provider is never read back: it is DERIVED from
 *    the agent id, which is validated against this runner's closed tuple, by the
 *    same canonical agent → company mapping every resolved profile records;
 *  - a forged `model` makes a same-provider candidate look "provably different"
 *    from a party it actually shares a model with. This process has no way to
 *    authenticate a model string it did not just resolve itself, so a persisted
 *    model is an UNKNOWN and is not recorded at all (issue #955 review, P1).
 *
 * An unknown model can only make §8.3 stricter, never laxer: every same-provider
 * candidate is rejected as `same-provider-model-unknown` and the lineage
 * escalates through row 19 rather than being judged by a party's own model. That
 * is the same identity §8.3 gets from `context.assignment.implementationAgent`
 * in the contract's own wording — the provenance key's job is to name WHICH run
 * the debate had, not to certify metadata nobody can verify.
 *
 * {@link summarizeDisputeParty} is therefore the projection of a profile this
 * process resolved IN THIS RUN, where provider and model are first-hand facts;
 * {@link canonicalizeDisputeParty} is the boundary everything read back out of
 * task context passes through.
 */

import { isArbiterAgentId } from "./review-arbiter-profile.js";

/**
 * Context key holding the resolved identity of each party to the debate.
 *
 * Written by the run that resolved it — the review run that raised the findings,
 * and the fix run that recorded the rebuttal — and merged rather than replaced,
 * so neither half can drop the other's.
 */
export const REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD = "reviewDisputeParties";

/** The two roles §8.3 measures a candidate arbiter against. */
export const REVIEW_DISPUTE_PARTY_ROLES = ["implementation", "review"] as const;
export type ReviewDisputePartyRole = (typeof REVIEW_DISPUTE_PARTY_ROLES)[number];

/**
 * Maximum length of any one recorded field.
 *
 * Agent ids, provider names, and model names are all short literals; anything
 * longer is not one of them, and task context is a §10.1 budget this key shares.
 * Over-long values are DROPPED rather than truncated — a truncated model name
 * would compare unequal to itself and could "prove" a difference that is not
 * there.
 */
const MAX_PARTY_FIELD_CHARS = 64;

/**
 * One party's identity.
 *
 * `provider` and `model` are populated only by {@link summarizeDisputeParty},
 * for a profile the current run resolved itself. Anything that has been through
 * task context carries the agent id alone: an absent provider falls back to the
 * canonical agent → company mapping, and an absent model is the unknown §8.3
 * fails closed on.
 */
export interface ReviewDisputePartyProvenance {
  agentId: string;
  provider?: string;
  model?: string;
}

/** Both halves. Either may be absent: they are written by different runs. */
export type ReviewDisputeParties = {
  [K in ReviewDisputePartyRole]?: ReviewDisputePartyProvenance;
};

function boundedField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_PARTY_FIELD_CHARS) return undefined;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project a profile THIS PROCESS JUST RESOLVED down to the three fields §8.3
 * compares.
 *
 * Takes `unknown` deliberately: the callers hold profiles of three different
 * shapes (implementation, review, reconsideration), and every one of them
 * already spells these three fields the same way. Returns `undefined` when the
 * value names no agent — a profile with no id is not a party.
 *
 * The provider and the model are first-hand facts here and travel verbatim.
 * That holds only for a profile resolved in the current run: anything coming
 * back out of task context must go through {@link canonicalizeDisputeParty}
 * instead, which is what {@link readDisputeParty} does.
 */
export function summarizeDisputeParty(profile: unknown): ReviewDisputePartyProvenance | undefined {
  if (!isRecord(profile)) return undefined;
  const agentId = boundedField(profile["agentId"]);
  if (agentId === undefined) return undefined;
  const provider = boundedField(profile["provider"]);
  const model = boundedField(profile["model"]);
  return {
    agentId,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * Reduce an UNTRUSTED recorded identity to the part of it that can be believed.
 *
 * Exactly one field survives: an agent id this runner recognises. A record
 * naming an id outside that closed tuple is not a party at all — §8.3 has no
 * provider to measure independence against for a name this process cannot
 * resolve, and the caller falls back or parks rather than measuring against a
 * string somebody wrote down.
 *
 * `provider` and `model` are dropped whatever they say. The provider is
 * re-derived from the agent id by the selection policy's canonical mapping, so
 * a forged one cannot conceal an overlap; the model has no such derivation and
 * no authentication, so it stays unknown, which fails closed (§8.3).
 */
export function canonicalizeDisputeParty(value: unknown): ReviewDisputePartyProvenance | undefined {
  const summary = summarizeDisputeParty(value);
  if (summary === undefined || !isArbiterAgentId(summary.agentId)) return undefined;
  return { agentId: summary.agentId };
}

/** Read one role's recorded identity out of untrusted task context. */
export function readDisputeParty(
  raw: unknown,
  role: ReviewDisputePartyRole,
): ReviewDisputePartyProvenance | undefined {
  if (!isRecord(raw)) return undefined;
  return canonicalizeDisputeParty(raw[role]);
}

/**
 * Merge a patch over whatever context already carries.
 *
 * Task context merges SHALLOWLY, so a handler returning only its own half would
 * replace the whole key and drop the other party's identity — which is precisely
 * the provenance loss this key exists to prevent. Roles the patch does not name
 * are carried forward as they were read.
 *
 * Both halves are canonicalized on the way IN, not only on the way out: a
 * provider or a model is a first-hand fact only inside the run that resolved it,
 * and the moment it lands in task context nothing can tell it apart from one an
 * altered task supplied. Recording a claim this protocol has already decided it
 * will never believe would only invite a later reader to believe it.
 */
export function mergeDisputeParties(raw: unknown, patch: ReviewDisputeParties): ReviewDisputeParties {
  const merged: ReviewDisputeParties = {};
  for (const role of REVIEW_DISPUTE_PARTY_ROLES) {
    const next = canonicalizeDisputeParty(patch[role]) ?? readDisputeParty(raw, role);
    if (next !== undefined) merged[role] = next;
  }
  return merged;
}
