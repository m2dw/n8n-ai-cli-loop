/**
 * Chain-aware progressive Issue refinement — §4 condition 5 against the
 * persistent chain registry (#788/#890; docs/issue-refinement-contract.md §4,
 * §12 row 6).
 *
 * Provider-neutral and pure over an injected reader, so both callers of the
 * cross-check share ONE implementation: the phase handler's snapshot source
 * (`cli/issue-refinement-loop.ts`) and the intake-side eligibility gate
 * (`core/issue-refinement-eligibility.ts`, issue #967). It moved here from the
 * CLI shell for exactly that reason — a second copy on the intake side could
 * drift, and this cross-check decides whether an Issue is handed to a human.
 */

import type { ChainGraph, ChainListFilter, ChainRecord } from "./chain-registry.js";
import type { RefinementChainAgreement } from "./issue-refinement-snapshot.js";

/**
 * The two chain-registry reads the §4 condition-5 cross-check needs.
 * `SqliteChainRegistryStore` satisfies it structurally.
 */
export interface ChainAgreementRegistryReader {
  listChainsForIssue(issueNumber: number, filter?: ChainListFilter): Promise<ChainRecord[]>;
  getChain(chainId: string): Promise<ChainGraph | undefined>;
}

/**
 * §4 condition 5: does the observed direct-predecessor set agree with the
 * accepted revision of the chain the target Issue is registered in?
 *
 * The scoping and the fail-closed choices, stated once:
 *
 *  - An Issue in NO chain of this session is `unregistered` — not a
 *    disagreement; §4 scopes the cross-check to registered members.
 *  - Membership in MORE than one chain is a disagreement: the cross-check
 *    refuses to pick which chain to believe, matching contract gap G3's
 *    refusal of cross-chain refinement.
 *  - A member chain with no accepted revision, or whose accepted revision is
 *    no longer the stored graph (the store persists members/edges for the
 *    CURRENT graph revision only), has no reconstructible accepted edge set to
 *    compare against. Both read as disagreement rather than agreement — the
 *    contract's registry clause has disagreement escalate rather than choose a
 *    side, and §4 orders structural conditions ahead of holds precisely so a
 *    state that needs a human is not buried under retries.
 *  - Agreement itself is set equality between the observed predecessors and
 *    the accepted graph's direct `blocked by` edges into the target,
 *    deduplicated; both directions of a mismatch are named in the detail.
 *
 * A registry read that throws propagates: the snapshot builder records it as a
 * `chain_agreement` stage failure and the intake gate reports it as
 * `undetermined` — both fail closed like any other provider error.
 */
export async function readChainAgreementFromRegistry(
  registry: ChainAgreementRegistryReader,
  sessionId: string,
  issueNumber: number,
  observedPredecessors: readonly number[],
): Promise<RefinementChainAgreement> {
  const chains = await registry.listChainsForIssue(issueNumber, { sessionId });
  if (chains.length === 0) return { kind: "unregistered" };
  if (chains.length > 1) {
    const ids = chains.map((c) => c.chainId).sort().join(", ");
    return {
      kind: "disagrees",
      detail: `member of ${chains.length} registered chains (${ids}); the cross-check refuses multi-chain membership`,
    };
  }
  const chain = chains[0];
  if (chain.acceptedRevision === undefined) {
    return {
      kind: "disagrees",
      detail: `chain ${chain.chainId} has no accepted revision to check the observed predecessor set against`,
    };
  }
  if (chain.acceptedRevision !== chain.graphRevision) {
    return {
      kind: "disagrees",
      detail:
        `chain ${chain.chainId} accepted revision ${chain.acceptedRevision} is not the stored graph `
        + `(revision ${chain.graphRevision}), so the accepted edge set cannot be read`,
    };
  }
  const graph = await registry.getChain(chain.chainId);
  if (!graph) {
    // Listed as a member moments ago; the chain vanished between the two
    // reads. A half-observed registry is a provider failure, not a verdict.
    throw new Error(`chain ${chain.chainId} disappeared between membership and graph reads`);
  }
  const expected = [
    ...new Set(
      graph.edges
        .filter((e) => e.blockedIssueNumber === issueNumber)
        .map((e) => e.blockerIssueNumber),
    ),
  ].sort((a, b) => a - b);
  const observed = [...new Set(observedPredecessors)].sort((a, b) => a - b);
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const missing = expected.filter((n) => !observedSet.has(n));
  const unexpected = observed.filter((n) => !expectedSet.has(n));
  if (missing.length === 0 && unexpected.length === 0) return { kind: "agrees" };
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`accepted predecessors missing on GitHub: ${missing.map((n) => `#${n}`).join(", ")}`);
  }
  if (unexpected.length > 0) {
    parts.push(
      `observed predecessors outside the accepted revision: ${unexpected.map((n) => `#${n}`).join(", ")}`,
    );
  }
  return { kind: "disagrees", detail: `chain ${chain.chainId}: ${parts.join("; ")}` };
}
