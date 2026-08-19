/**
 * Accepted-revision service for dependency chains (issue #890).
 *
 * A chain always has a last-known-good graph: the revision its
 * {@link ChainRecord.acceptedRevision} pointer names. This module is the only
 * thing that moves that pointer, and it moves it on exactly one condition —
 * that {@link validateChainGraph} passed the candidate against the graph rules
 * and against what the registry already owns.
 *
 * The guarantee it exists for is negative: **a replacement that does not
 * complete leaves the previously accepted revision exactly where it was.**
 * That is what makes acceptance safe to retry from a crashed sync, a lost
 * compare-and-set, or an operator edit that turned out to be cyclic.
 *
 * The store port cannot offer one transaction spanning several of its methods,
 * so the guarantee is bought by ordering instead. Writes go out in the order
 *
 *   1. replace the graph (recording a `candidate` revision),
 *   2. label that revision `accepted`,
 *   3. move the pointer to it,
 *   4. label the predecessor `superseded`,
 *
 * and step 3 is the commit point. Steps 1 and 2 are *descriptive*: until the
 * pointer moves, the last-known-good graph is still the predecessor, so a
 * failure anywhere before step 3 leaves a chain with a newer candidate on
 * record and its accepted revision untouched — which is precisely the state a
 * retry heals. Step 4 is bookkeeping performed after the fact; if it fails the
 * acceptance still stands, and the failure is reported rather than swallowed.
 *
 * Because step 2 is descriptive it must also be *retractable*: an acceptance
 * that labels its revision and then cannot commit the pointer puts the label
 * back to `candidate`, so no reader ever sees a revision marked accepted that
 * the pointer never named — nor two of them at once.
 *
 * The converse has to hold under a race as well: the pointer must never end up
 * naming a revision this retraction has just demoted. Two acceptances of the
 * same candidate label the same revision number, so the loser's retraction and
 * the winner's commit are writes about one row, and the loser cannot tell from
 * a read alone which of the two lands first. It therefore hands the condition
 * to the store as `unlessAcceptedRevision`, decided inside the write itself.
 *
 * Validation failures never write at all: they are decided before step 1.
 *
 * A caller may attach one more condition to step 3 through
 * {@link AcceptChainGraphInput.commitGuard}. It exists for constraints this
 * module deliberately knows nothing about — #891's frozen prefixes are the
 * first — whose truth lives in a table none of the compare-and-sets here
 * covers, so a caller checking them before the call has no way to notice one
 * appearing during it. It is handed to the store and evaluated *inside* step
 * 3's own transaction rather than in a round trip before it, because a check
 * that merely runs late is still a read taken before the write it guards: the
 * only ordering that refuses a freeze landing at the last moment is one where
 * the freeze and the pointer move cannot interleave at all. A veto costs the
 * same retraction a lost pointer does and leaves the accepted revision exactly
 * where it was. A condition that throws instead of answering rolls that
 * transaction back, costs that retraction too, and is answered as a failure
 * rather than rethrown: the label is written by then, so letting the exception
 * out is the one way this module could leave a revision marked accepted that
 * the pointer never named.
 *
 * Every read taken before a write is stale by the time the write goes out, so
 * a decision made from one is re-taken against a fresh row at the point it
 * commits: "the candidate is already the accepted graph" is re-read before it
 * is reported as `unchanged`, and the caller's `expectedRev` /
 * `expectedAcceptedRevision` are re-checked against that same fresh row and
 * again immediately before the pointer moves, where the row-revision
 * compare-and-set closes what is left of the window. The graph handed back
 * with an acceptance is pinned the same way — it is the revision this call
 * committed, never whatever a later acceptance has since put in its place. The
 * row revision reported beside it is pinned harder still: it is read inside
 * this call's own last write rather than after it, because a caller that
 * compare-and-sets its follow-up bookkeeping on that number needs one no other
 * writer's work has been folded into — see
 * {@link ChainGraphAccepted.committedRev}.
 *
 * Duplicate ownership cannot be decided that way at all, though. It is a fact
 * about *other* chains, and a read of those chains stops being true the moment
 * a concurrent acceptance writes: two calls claiming the same previously
 * unowned Issue would each see it free, and each write it. So the claim is
 * restated to the store as `PutChainGraphInput.exclusiveMemberScope` and
 * re-evaluated inside step 1's own transaction, where exactly one of two
 * racing claims can win. It binds step 1 even when the candidate is the graph
 * already on record: recording a candidate claims nothing, so an acceptance
 * that re-writes it is making that claim for the first time, and a chain that
 * took one of its Issues in between has to be able to refuse it. For the same
 * reason the `unchanged` answer takes the claim too, through a step 1 the
 * matching graph and row revision reduce to the store's own no-op — otherwise
 * the one outcome that never writes would be the one outcome deciding
 * duplicate ownership from a read alone. The pre-check stays — it is what
 * produces full diagnostics without writing anything — and the store's answer
 * is the backstop for the window the pre-check cannot cover.
 *
 * Out of scope, deliberately: nothing here reads or writes GitHub Issue
 * Relationships, parses a command line, or consults #891's frozen-prefix
 * rules. It takes a candidate and a store port and returns a verdict.
 */

import { validateChainGraph } from "./chain-graph.js";
import type {
  CanonicalChainGraph,
  ChainGraphDiagnostic,
  ChainOwnershipEntry,
} from "./chain-graph.js";
import { isValidIssueNumber } from "./chain-registry.js";
import type {
  AcceptedRevisionGuard,
  AcceptedRevisionGuardContext,
  ChainEdgeInput,
  ChainGraph,
  ChainGraphIntegrityError,
  ChainListFilter,
  ChainMemberInput,
  ChainMemberOwner,
  ChainRecord,
  ChainRegistryFailureCode,
  ChainRegistryResult,
  ChainRegistryStore,
} from "./chain-registry.js";

/**
 * The slice of {@link ChainRegistryStore} acceptance needs. Narrow on purpose:
 * it documents that acceptance never touches aliases, sync state, or chain
 * deletion, and it lets a caller pass a smaller adapter than the full port.
 */
export type ChainAcceptanceStore = Pick<
  ChainRegistryStore,
  | "getChain"
  | "getChainRecord"
  | "listChainsForIssue"
  | "putChainGraph"
  | "setChainRevisionState"
  | "setAcceptedRevision"
>;

export interface AcceptChainGraphInput {
  chainId: string;
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
  /** Move the head as part of the same acceptance. Omitted, the head stands. */
  headIssueNumber?: number;
  /**
   * Compare-and-set against {@link ChainRecord.rev}. A candidate computed from
   * a chain that has since moved is refused rather than applied on top of a
   * state its author never saw.
   */
  expectedRev?: number;
  /**
   * Compare-and-set against the *accepted revision* rather than the row
   * revision. `null` asserts that nothing has been accepted yet. Weaker than
   * `expectedRev` and useful where it should be: a caller that only cares that
   * the last-known-good graph has not moved does not have to fail because some
   * unrelated write bumped the row.
   */
  expectedAcceptedRevision?: number | null;
  /**
   * How widely to look for chains that already own the candidate's members.
   * Defaults to the candidate chain's own session — a chain in another session
   * is a different operator's registry, not a duplicate claim.
   *
   * The same scope is passed to the store as the write's exclusive member
   * claim, so it decides both what is checked up front and what a concurrent
   * acceptance is refused against.
   */
  ownershipScope?: ChainListFilter;
  /**
   * Chains whose ownership of the candidate's members does not refuse this
   * acceptance, passed through to the store's exclusive claim as
   * {@link import("./chain-registry.js").PutChainGraphInput.tolerateOwnerChainIds}.
   *
   * For the one moment a doubled ownership is the plan rather than the
   * problem: a merge (#893) accepts the combined graph into the surviving
   * chain while the source chain — retired immediately after — still records
   * the members it is handing over. The claim still binds every OTHER chain,
   * inside the write's own transaction.
   */
  tolerateOwnerChainIds?: readonly string[];
  /**
   * A last condition on the commit, evaluated inside the transaction that moves
   * the pointer. Returning a one-line reason vetoes the acceptance; returning
   * `undefined` lets it through.
   *
   * For rules this module does not own and cannot express as a compare-and-set.
   * A frozen prefix (#891) is the motivating case: freezing one writes no chain
   * row, so `expectedRev` cannot see a freeze land between a caller's check and
   * this write, and a sync that read "nothing frozen" minutes ago while talking
   * to GitHub would otherwise accept a graph that drops a dependency a task has
   * since started against.
   *
   * Passed straight through to {@link ChainRegistryStore.setAcceptedRevision}
   * as its `guard`, which is what makes the answer binding rather than merely
   * timely: a check this module ran just before that call would still be a read
   * taken outside the write, and a freeze landing in between would be accepted
   * over. Evaluated in the store's transaction it cannot be, because the freeze
   * is either not yet written — and this pointer move precedes it — or already
   * visible to the guard.
   *
   * Called once, and only where there is a commit to refuse: a rejection is
   * decided before the first write, and an `unchanged` answer moves no pointer,
   * so neither reaches the store call the guard rides on.
   *
   * Synchronous, because a transaction cannot be held open across an `await`.
   * A frozen-prefix check is a pure function of the snapshots it is given, and
   * those are handed to it in {@link AcceptedRevisionGuardContext}.
   *
   * Throwing instead of returning is treated as neither a veto nor a pass: the
   * transaction rolls back, the label written for the pointer move is retracted
   * as it is for a veto, and the call answers `failed` with code
   * `internal_error`. Deciding that here rather than letting the exception out
   * is what keeps the label and the pointer consistent — see
   * {@link ChainAcceptanceFailureCode}.
   */
  commitGuard?: AcceptedRevisionGuard;
  /**
   * Additional chains whose frozen prefixes are read — inside the same
   * transaction — into the context `commitGuard` is handed, alongside the
   * accepted chain's own. Passed through to
   * {@link ChainRegistryStore.setAcceptedRevision} as its `guardChainIds`.
   *
   * For the one acceptance that answers for two chains' started Issues: a
   * merge (#893) commits the combined graph into the target while the source
   * chain still records the members it is handing over, so a freeze landing
   * on a source Issue is recorded against the source chain and a guard handed
   * only the target's rows would accept over it. Ignored without a
   * `commitGuard`.
   */
  commitGuardChainIds?: readonly string[];
  /** Provenance recorded on the revision this acceptance creates. */
  source?: string;
  note?: string;
  now?: string;
}

/**
 * Why an acceptance failed, in the store's own vocabulary plus the one reason
 * the store has no code for: something threw instead of answering.
 *
 * A {@link AcceptChainGraphInput.commitGuard} condition is caller code running
 * inside this module's commit, and a throw from it is neither a veto (nothing
 * said no) nor a store refusal (the store answered nothing; its transaction
 * rolled back). It is still an acceptance that did not commit, so it is
 * reported as one rather than thrown — which is also what lets the `accepted`
 * label be retracted before the answer goes back, since a caller cannot retract
 * a label it never knew was written.
 */
export type ChainAcceptanceFailureCode = ChainRegistryFailureCode | "internal_error";

interface ChainAcceptanceBase {
  chainId: string;
  /**
   * The revision accepted once the call returned. On every non-`accepted`
   * status this is the previous last-known-good revision, unchanged.
   */
  acceptedRevision?: number;
  /**
   * A bookkeeping write that failed *after* the outcome above was already
   * decided: the predecessor's `superseded` label on an acceptance that
   * committed, or the retraction of an `accepted` label on one that did not.
   * The outcome stands either way; a revision label is stale until the next
   * write repairs it. Reported rather than thrown so a caller can log it
   * without unwinding a decision that has already been made.
   */
  followUpFailure?: { code: ChainAcceptanceFailureCode; detail?: string };
}

export interface ChainGraphAccepted extends ChainAcceptanceBase {
  status: "accepted";
  acceptedRevision: number;
  /** What the pointer named before, absent when nothing had been accepted. */
  previousAcceptedRevision?: number;
  /** The predecessor this call labelled `superseded`, when it did. */
  supersededRevision?: number;
  fingerprint: string;
  graph: ChainGraph;
  /**
   * The chain row's {@link ChainRecord.rev} as this call's *last own write*
   * left it — the pointer move, or the predecessor's `superseded` label when
   * one was written — read inside that write's own transaction.
   *
   * It is what a caller compare-and-sets on when it has follow-up bookkeeping
   * of its own to write; admin sync recording `in_sync` is the motivating case.
   * Deliberately not `graph.chain.rev`: the graph may come from a read taken
   * after the commit, and such a read carries whatever else has landed since. A
   * concurrent sync recording an `error` moves no graph revision, so its bump
   * is invisible in the graph yet present in `rev` — and a caller guarding on
   * that number would compare-and-set successfully and overwrite a result newer
   * than its own. Pinned here, the same write is refused instead, which is the
   * whole point of guarding it.
   *
   * The `superseded` label is itself pinned to the pointer move for that same
   * reason: an unpinned bookkeeping write would apply on top of a concurrent
   * verdict and report a row carrying it, quietly extending this number's
   * guarantee past the commit it describes. So the label is the last write only
   * when nothing raced it; when something did, the label is refused (and
   * reported as a {@link ChainAcceptanceBase.followUpFailure}) and this stays
   * the pointer move's.
   */
  committedRev: number;
  canonical: CanonicalChainGraph;
}

export interface ChainGraphUnchanged extends ChainAcceptanceBase {
  status: "unchanged";
  acceptedRevision: number;
  fingerprint: string;
  graph: ChainGraph;
  /**
   * As {@link ChainGraphAccepted.committedRev}. Nothing moved, so this is the
   * row the claim write observed — no later read stands between it and the
   * caller's follow-up write.
   */
  committedRev: number;
  canonical: CanonicalChainGraph;
}

export interface ChainGraphRejected extends ChainAcceptanceBase {
  status: "rejected";
  diagnostics: ChainGraphDiagnostic[];
}

export interface ChainGraphConflict extends ChainAcceptanceBase {
  status: "conflict";
  detail: string;
  /** The row revision actually found, when the store reported one. */
  observedRev?: number;
}

/**
 * {@link AcceptChainGraphInput.commitGuard} refused the commit. The candidate is
 * on record as a `candidate` revision — the state a graph write that never
 * reached the pointer always leaves — and the accepted revision is untouched.
 *
 * Kept apart from `rejected` and `conflict` because it is neither: the graph
 * passed every rule this module knows, and nothing was lost to a race. A rule
 * the caller owns said no, and only the caller can word why.
 */
export interface ChainGraphVetoed extends ChainAcceptanceBase {
  status: "vetoed";
  /** The reason the commit guard gave, verbatim. */
  detail: string;
  /** The revision this call recorded and then left as a `candidate`. */
  candidateRevision: number;
  /**
   * The chain's row revision as this call's own writes left it. Writes made
   * while accepting (and the label retraction) have moved it, so a caller
   * guarding follow-up bookkeeping with a compare-and-set needs this rather
   * than the revision it observed going in.
   *
   * Always a revision this call had pinned, never one read back afterwards: it
   * comes from inside the retraction's transaction, or — when the retraction
   * did not write — from the row the refused pointer move was pinned to. Both
   * are numbers no concurrent writer contributed to, so a follow-up guarded
   * with this loses to a verdict recorded since instead of overwriting it.
   */
  observedRev: number;
}

export interface ChainGraphFailed extends ChainAcceptanceBase {
  status: "failed";
  code: ChainAcceptanceFailureCode;
  detail?: string;
  /** Present when the store's own referential checks refused the graph. */
  errors?: ChainGraphIntegrityError[];
}

export type ChainGraphAcceptance =
  | ChainGraphAccepted
  | ChainGraphUnchanged
  | ChainGraphRejected
  | ChainGraphConflict
  | ChainGraphVetoed
  | ChainGraphFailed;

/**
 * Which chains already contain each of `issueNumbers`.
 *
 * Split out from {@link acceptChainGraph} because the same lookup is what
 * admin sync, intake, and topology editing each need before they can call
 * {@link validateChainGraph} themselves — they must not each re-derive what
 * "already owned" means.
 *
 * Malformed Issue numbers are skipped rather than queried: validation reports
 * them, and asking the store about them would only invent a failure mode.
 */
export async function collectChainOwnership(
  store: Pick<ChainRegistryStore, "listChainsForIssue">,
  issueNumbers: readonly number[],
  options?: { filter?: ChainListFilter; excludeChainId?: string },
): Promise<ChainOwnershipEntry[]> {
  const seen = new Set<number>();
  const entries: ChainOwnershipEntry[] = [];

  for (const issueNumber of issueNumbers) {
    if (!isValidIssueNumber(issueNumber) || seen.has(issueNumber)) continue;
    seen.add(issueNumber);
    const chains = await store.listChainsForIssue(issueNumber, options?.filter);
    for (const chain of chains) {
      if (options?.excludeChainId !== undefined && chain.chainId === options.excludeChainId) {
        continue;
      }
      entries.push({ issueNumber, chainId: chain.chainId });
    }
  }

  return entries.sort(
    (a, b) =>
      a.issueNumber - b.issueNumber ||
      (a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0),
  );
}

type FollowUpFailure = { code: ChainAcceptanceFailureCode; detail?: string };

/**
 * What a label retraction leaves behind: the failure to report when it did not
 * happen, and — when it did — the chain row's revision as read inside the
 * retraction's own transaction. Exactly one of the two is set; neither is, when
 * the pointer turned out to name the revision and nothing was written.
 */
type LabelRetraction = { failure?: FollowUpFailure; chainRev?: number };

function conflictOf(
  chainId: string,
  acceptedRevision: number | undefined,
  detail: string,
  observedRev?: number,
  followUpFailure?: FollowUpFailure,
): ChainGraphConflict {
  return {
    status: "conflict",
    chainId,
    ...(acceptedRevision === undefined ? {} : { acceptedRevision }),
    detail,
    ...(observedRev === undefined ? {} : { observedRev }),
    ...(followUpFailure === undefined ? {} : { followUpFailure }),
  };
}

function failureOf(
  chainId: string,
  acceptedRevision: number | undefined,
  code: ChainAcceptanceFailureCode,
  detail?: string,
  errors?: ChainGraphIntegrityError[],
  followUpFailure?: FollowUpFailure,
): ChainGraphFailed {
  return {
    status: "failed",
    chainId,
    ...(acceptedRevision === undefined ? {} : { acceptedRevision }),
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined ? {} : { errors }),
    ...(followUpFailure === undefined ? {} : { followUpFailure }),
  };
}

/**
 * Put an `accepted` label back to `candidate` after the pointer move it was
 * written for did not happen.
 *
 * `candidate` is what such a revision genuinely is — recorded, never committed
 * as the chain's last-known-good graph — and leaving it labelled `accepted`
 * would let a reader see a revision the pointer never named, or two accepted
 * revisions where a concurrent acceptance won the pointer.
 *
 * Nothing is retracted when the pointer turns out to name the revision anyway:
 * two calls accepting the same candidate produce the same revision number, and
 * the one that loses the pointer must not strip a label the winner's commit
 * made true.
 *
 * That condition cannot be settled by the read below alone, for the same reason
 * duplicate ownership cannot: the winner's commit can land between this call's
 * read and its write, and demoting the label afterwards would leave the
 * accepted pointer naming a revision marked `candidate` — the mirror image of
 * the state this retraction exists to prevent. So the condition is restated to
 * the store as `unlessAcceptedRevision` and re-decided inside the write's own
 * transaction, where the pointer cannot move underneath it. The read stays as
 * the cheap pre-check that skips the write entirely when the winner is already
 * visible.
 *
 * Best effort by necessity: the label and the pointer cannot share one
 * transaction, so a failed retraction is returned for the caller to report as
 * {@link ChainAcceptanceBase.followUpFailure} rather than replacing the
 * conflict that caused it.
 *
 * `expectedRev` pins the write to the row the caller last saw, for the one
 * caller that hands the retraction's own row revision back as the number to
 * guard a follow-up write with. Without it the retraction would apply on top of
 * whatever a concurrent writer had just recorded and report the sum, and the
 * follow-up would then overwrite that writer's verdict. Pinned, the same case
 * refuses the write instead of absorbing it, and the caller is left to decide
 * what the label still needs — a pin is about which revision may be handed
 * back, not about whether the label comes off.
 */
async function retractAcceptedLabel(
  store: ChainAcceptanceStore,
  chainId: string,
  revision: number,
  now: string | undefined,
  expectedRev?: number,
): Promise<LabelRetraction> {
  const record = await store.getChainRecord(chainId);
  if (record?.acceptedRevision === revision) return {};
  const retracted = await store.setChainRevisionState(chainId, revision, "candidate", {
    unlessAcceptedRevision: true,
    ...(expectedRev === undefined ? {} : { expectedRev }),
    ...(now === undefined ? {} : { now }),
  });
  if (retracted.ok) return { chainRev: retracted.chainRev };
  return {
    failure: {
      code: retracted.code,
      ...(retracted.detail === undefined ? {} : { detail: retracted.detail }),
    },
  };
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * {@link retractAcceptedLabel} for the one caller that is already handling a
 * throw.
 *
 * The retraction is itself two store calls, so whatever made a commit guard throw
 * — a database that has stopped answering is the motivating case — is liable to
 * make them throw too. Letting that second throw out would lose the failure
 * being reported and land back in the generic path this catch exists to avoid,
 * so it is folded into the same `followUpFailure` a refused retraction uses: the
 * label is stale either way, and the reason the acceptance failed is the one the
 * caller needs to read first.
 */
async function retractLabelAfterThrow(
  store: ChainAcceptanceStore,
  chainId: string,
  revision: number,
  now: string | undefined,
): Promise<LabelRetraction> {
  try {
    return await retractAcceptedLabel(store, chainId, revision, now);
  } catch (err) {
    return {
      failure: {
        code: "internal_error",
        detail: `could not retract the accepted label on revision ${revision}: ${describeThrown(err)}`,
      },
    };
  }
}

/**
 * Validate a candidate graph and, if it passes, make it the chain's accepted
 * revision.
 *
 * Returns `unchanged` when the candidate is the graph that is already
 * accepted — the same members, the same edges in the same directions, and the
 * same head, in any input order. No row moves in that case: manufacturing a
 * revision for a change that did not happen would make the revision history
 * useless for answering when the chain last actually moved. The exclusive
 * member claim is still taken — the graph write it rides on is the store's
 * no-op — so the answer is refused rather than given if another chain has
 * taken one of the members meanwhile.
 */
export async function acceptChainGraph(
  store: ChainAcceptanceStore,
  input: AcceptChainGraphInput,
): Promise<ChainGraphAcceptance> {
  const { chainId } = input;
  const record = await store.getChainRecord(chainId);
  if (!record) return failureOf(chainId, undefined, "not_found", `no such chain: ${chainId}`);

  const accepted = record.acceptedRevision;

  if (input.expectedRev !== undefined && input.expectedRev !== record.rev) {
    return conflictOf(
      chainId,
      accepted,
      `expected rev ${input.expectedRev}, found ${record.rev}`,
      record.rev,
    );
  }
  if (input.expectedAcceptedRevision !== undefined) {
    const current = accepted ?? null;
    if (current !== input.expectedAcceptedRevision) {
      return conflictOf(
        chainId,
        accepted,
        `expected accepted revision ${String(input.expectedAcceptedRevision)}, found ${String(current)}`,
        record.rev,
      );
    }
  }

  const headIssueNumber = input.headIssueNumber ?? record.headIssueNumber;
  const ownershipScope = input.ownershipScope ?? { sessionId: record.sessionId };
  const tolerated = new Set(input.tolerateOwnerChainIds ?? []);
  const ownership = (
    await collectChainOwnership(
      store,
      input.members.map((member) => member.issueNumber),
      { filter: ownershipScope, excludeChainId: chainId },
    )
  ).filter((entry) => !tolerated.has(entry.chainId));

  const candidate = { chainId, headIssueNumber, members: input.members, edges: input.edges };

  /**
   * Turn a refused graph write into the outcome it stands for.
   *
   * A lost claim is reported as the rejection it would have been had the
   * ownership been visible one read earlier, diagnostics and all: the caller
   * that loses a race and the caller that was simply late deserve the same
   * answer, and only {@link validateChainGraph} gets to word it. Anything else
   * is the store's own verdict, passed through.
   */
  const failedPutOutcome = (
    put: {
      code: ChainRegistryFailureCode;
      detail?: string;
      errors?: ChainGraphIntegrityError[];
      owners?: ChainMemberOwner[];
    },
    acceptedRevision: number | undefined,
  ): ChainGraphAcceptance => {
    if (put.owners !== undefined && put.owners.length > 0) {
      const raced = validateChainGraph(candidate, { ownership: [...ownership, ...put.owners] });
      if (!raced.ok) {
        return {
          status: "rejected",
          chainId,
          ...(acceptedRevision === undefined ? {} : { acceptedRevision }),
          diagnostics: raced.diagnostics,
        };
      }
    }
    if (put.code === "conflict") {
      return conflictOf(chainId, acceptedRevision, put.detail ?? "chain moved during acceptance");
    }
    return failureOf(chainId, acceptedRevision, put.code, put.detail, put.errors);
  };

  const validation = validateChainGraph(candidate, { ownership });
  if (!validation.ok) {
    // Nothing has been written, so the previous last-known-good revision is
    // still exactly what it was before the call.
    return {
      status: "rejected",
      chainId,
      ...(accepted === undefined ? {} : { acceptedRevision: accepted }),
      diagnostics: validation.diagnostics,
    };
  }

  const canonical = validation.graph;

  if (
    accepted !== undefined &&
    accepted === record.graphRevision &&
    record.graphFingerprint === canonical.fingerprint &&
    record.headIssueNumber === headIssueNumber
  ) {
    // `record` was read before the ownership queries, so "the candidate is
    // already what is accepted" is a claim about a row that may have moved
    // since. Decide it on the graph read here instead — the record it carries
    // is the same read as the graph reported alongside it. Answering
    // `unchanged` from the stale row would tell a caller its candidate is the
    // accepted graph while returning a newer one, and it would not retry.
    const graph = await store.getChain(chainId);
    if (!graph) return failureOf(chainId, accepted, "not_found", `no such chain: ${chainId}`);
    const fresh = graph.chain;
    if (
      fresh.acceptedRevision === undefined ||
      fresh.acceptedRevision !== fresh.graphRevision ||
      fresh.graphFingerprint !== canonical.fingerprint ||
      fresh.headIssueNumber !== headIssueNumber
    ) {
      return conflictOf(
        chainId,
        fresh.acceptedRevision,
        `graph moved to revision ${fresh.graphRevision} during acceptance`,
        fresh.rev,
      );
    }
    // Captured where the guard above has just proved it set: the pointer this
    // branch reports is the one those checks passed on, not whatever a read
    // taken after the claim below would find.
    const freshAccepted = fresh.acceptedRevision;
    // Matching the candidate is not the same as standing still. A chain can be
    // accepted away and back again while this call collected ownership — 2, 3,
    // then a 4 that restores the same fingerprint and head — and the check
    // above cannot see that, because it only compares the graph. So the two
    // compare-and-sets are re-taken here against the same fresh row: returning
    // `unchanged` is an assertion that the expectation the caller stated still
    // holds, and reporting it from the row read at the top of the call would
    // make that assertion about a state the store has since left.
    if (input.expectedRev !== undefined && input.expectedRev !== fresh.rev) {
      return conflictOf(
        chainId,
        fresh.acceptedRevision,
        `expected rev ${input.expectedRev}, found ${fresh.rev} during acceptance`,
        fresh.rev,
      );
    }
    // A pointer is known to be set here — the check above refused an unset
    // one — so an `expectedAcceptedRevision` of `null` is stale by definition.
    if (
      input.expectedAcceptedRevision !== undefined &&
      input.expectedAcceptedRevision !== fresh.acceptedRevision
    ) {
      return conflictOf(
        chainId,
        fresh.acceptedRevision,
        `expected accepted revision ${String(input.expectedAcceptedRevision)}, found ${fresh.acceptedRevision} during acceptance`,
        fresh.rev,
      );
    }
    // This is the one branch that returns without ever writing, so it is also
    // the one branch that never hands the candidate's members to the store as
    // a claim — and the ownership it answers from is a read taken before
    // `getChain`. A chain created in that window inside the same scope is
    // invisible to both, so returning here on their word would report
    // `unchanged` for a graph that now has duplicate ownership, while a
    // candidate merely recorded rather than accepted gets the claim re-decided
    // transactionally on its way through `putChainGraph`. So take the same
    // claim: with the graph, the head, and the row revision all matching what
    // was just read, the write is the store's own no-op, and it costs a
    // refusal exactly when ownership has moved. `expectedRev: fresh.rev` is
    // what keeps it a no-op — had the row moved since the read above, the
    // write would replace the very graph this branch is about to call
    // unchanged, so it is refused instead.
    const claim = await store.putChainGraph({
      chainId,
      members: input.members,
      edges: input.edges,
      exclusiveMemberScope: ownershipScope,
      ...(input.tolerateOwnerChainIds === undefined
        ? {}
        : { tolerateOwnerChainIds: input.tolerateOwnerChainIds }),
      expectedRev: fresh.rev,
      ...(input.headIssueNumber === undefined ? {} : { headIssueNumber: input.headIssueNumber }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (!claim.ok) return failedPutOutcome(claim, freshAccepted);

    return {
      status: "unchanged",
      chainId,
      acceptedRevision: freshAccepted,
      fingerprint: canonical.fingerprint,
      graph: claim.value,
      // The claim write is the last thing this branch does, and the record it
      // returned was read inside it.
      committedRev: claim.value.chain.rev,
      canonical,
    };
  }

  // The ownership snapshot above is a read, so between it and this write
  // another chain in the same scope can claim one of these Issues. Re-stating
  // the scope as `exclusiveMemberScope` hands the same question to the store,
  // which answers it inside the transaction that performs the write — so of
  // two acceptances racing for a previously unowned Issue exactly one lands.
  const put = await store.putChainGraph({
    chainId,
    members: input.members,
    edges: input.edges,
    exclusiveMemberScope: ownershipScope,
    ...(input.tolerateOwnerChainIds === undefined
      ? {}
      : { tolerateOwnerChainIds: input.tolerateOwnerChainIds }),
    ...(input.headIssueNumber === undefined ? {} : { headIssueNumber: input.headIssueNumber }),
    ...(input.expectedRev === undefined ? {} : { expectedRev: input.expectedRev }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!put.ok) return failedPutOutcome(put, accepted);

  const revision = put.value.chain.graphRevision;

  // Label first, commit second. Both writes below leave the pointer on the
  // predecessor if they fail, which is the whole point of doing them in this
  // order rather than moving the pointer as soon as the graph landed.
  const labelled = await store.setChainRevisionState(chainId, revision, "accepted", {
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!labelled.ok) {
    return failureOf(chainId, accepted, labelled.code, labelled.detail);
  }

  // Re-read rather than reuse the row revision from `putChainGraph`: labelling
  // the revision above bumped it, and a stale `expectedRev` here would refuse a
  // write that nothing is actually racing. The re-read is itself the guard —
  // a graph revision that no longer matches means someone else replaced the
  // graph between the two writes, and the pointer must not name a revision the
  // caller never validated.
  const current = await store.getChainRecord(chainId);
  if (!current) return failureOf(chainId, accepted, "not_found", `no such chain: ${chainId}`);
  if (current.graphRevision !== revision) {
    return conflictOf(
      chainId,
      current.acceptedRevision,
      `graph moved to revision ${current.graphRevision} during acceptance of ${revision}`,
      current.rev,
      (await retractAcceptedLabel(store, chainId, revision, input.now)).failure,
    );
  }
  // `expectedAcceptedRevision` was checked against a row read before the
  // ownership queries and the graph write, and an acceptance that completed in
  // between would have moved the pointer since. Re-check it here, one read
  // before the pointer move, so the advertised compare-and-set actually decides
  // whether this call may overwrite a newer accepted graph. The window left
  // between this read and the write below is closed by the row-revision
  // compare-and-set the write carries: any acceptance landing in it bumps `rev`
  // and this call loses the pointer rather than taking it.
  if (input.expectedAcceptedRevision !== undefined) {
    const observedAccepted = current.acceptedRevision ?? null;
    if (observedAccepted !== input.expectedAcceptedRevision) {
      return conflictOf(
        chainId,
        current.acceptedRevision,
        `expected accepted revision ${String(input.expectedAcceptedRevision)}, found ${String(observedAccepted)} during acceptance of ${revision}`,
        current.rev,
        (await retractAcceptedLabel(store, chainId, revision, input.now)).failure,
      );
    }
  }

  // The commit point, and therefore the last place a rule this module does not
  // own can still refuse — but it refuses from inside the write below rather
  // than in a round trip before it, so nothing can land in between. Whatever
  // the caller's own check missed while it read GitHub is visible to the guard,
  // and whatever arrives while the guard runs is ordered after the pointer move
  // it would have refused.
  const commitGuard = input.commitGuard;
  let guardThrew: unknown;
  const guard: AcceptedRevisionGuard | undefined =
    commitGuard === undefined
      ? undefined
      : (context) => {
          try {
            return commitGuard(context);
          } catch (err) {
            // Captured on the way past so the rollback below can be told apart
            // from a store that failed on its own account.
            guardThrew = err;
            throw err;
          }
        };

  let pointed: ChainRegistryResult<ChainRecord>;
  try {
    pointed = await store.setAcceptedRevision(chainId, revision, {
      expectedRev: current.rev,
      ...(guard === undefined ? {} : { guard }),
      ...(guard === undefined || input.commitGuardChainIds === undefined
        ? {}
        : { guardChainIds: input.commitGuardChainIds }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } catch (err) {
    // A store that threw for its own reasons is not this module's to interpret,
    // and callers have always seen it propagate.
    if (guardThrew === undefined) throw err;
    // A condition that threw rather than answered is still an acceptance that
    // is not going to commit — the transaction it threw inside rolled back — and
    // it is reported that way instead of being allowed to propagate, because
    // the `accepted` label is already written at this point and only this frame
    // knows it. An exception escaping here would leave the label naming a
    // revision the pointer never took, which no caller can repair: it sees a
    // generic failure and cannot tell a throw before the label from one after
    // it.
    const retraction = await retractLabelAfterThrow(store, chainId, revision, input.now);
    return failureOf(
      chainId,
      current.acceptedRevision,
      "internal_error",
      `the commit guard threw before the pointer move: ${describeThrown(guardThrew)}`,
      undefined,
      retraction.failure,
    );
  }
  if (!pointed.ok) {
    // The label above described a commit that did not happen, whatever refused
    // it, so it comes back off before the outcome is reported.
    if (pointed.code === "guard_refused") {
      // The caller's rule said no from inside the transaction. Nothing was
      // lost to a race and nothing is wrong with the graph, so this is neither
      // a conflict nor a rejection: the candidate stays on record as one, and
      // only the caller can word why it may not be accepted.
      //
      // A veto is also the one refusal whose row revision the caller goes on to
      // guard its own follow-up write with, and a guard refusal rolled its
      // transaction back without touching the chain row — so `current.rev` is
      // still the row this call had pinned, and the retraction is pinned to it
      // in turn. That is what keeps the number below this call's own: an
      // unpinned label write applies on top of whatever a concurrent writer
      // recorded first and reports the sum, and a follow-up guarded with the
      // sum would overwrite that writer's verdict.
      const pinned = await retractAcceptedLabel(store, chainId, revision, input.now, current.rev);
      // The pin lost, so something has been written since the refusal. The
      // label still has to come off — a candidate left marked `accepted` is
      // exactly the state the retraction exists to prevent, and another
      // writer's verdict is no reason to leave it — but it comes off with a
      // write this call could not pin, whose revision is therefore not one it
      // may guard anything with.
      const retraction =
        pinned.failure?.code === "conflict"
          ? await retractAcceptedLabel(store, chainId, revision, input.now)
          : pinned;
      return {
        status: "vetoed",
        chainId,
        ...(current.acceptedRevision === undefined
          ? {}
          : { acceptedRevision: current.acceptedRevision }),
        detail: pointed.detail ?? "the commit guard refused the pointer move",
        candidateRevision: revision,
        // The pinned retraction's own transaction-local revision, never a read
        // taken after it: a re-read here would carry any verdict recorded since
        // and let the caller's follow-up write overwrite it. Where that write
        // did not happen — the pin lost, or the pointer already named the
        // revision — the pinned revision is handed back unchanged, stale by
        // exactly the other writer's bump, which is what makes the follow-up
        // lose to that writer rather than clobber it.
        observedRev: pinned.chainRev ?? current.rev,
        ...(retraction.failure === undefined ? {} : { followUpFailure: retraction.failure }),
      };
    }
    const retraction = await retractAcceptedLabel(store, chainId, revision, input.now);
    if (pointed.code === "conflict") {
      return conflictOf(
        chainId,
        accepted,
        pointed.detail ?? "chain moved during acceptance",
        undefined,
        retraction.failure,
      );
    }
    return failureOf(
      chainId,
      accepted,
      pointed.code,
      pointed.detail,
      undefined,
      retraction.failure,
    );
  }

  // Committed. Everything from here is bookkeeping on the predecessor — and
  // the predecessor is what `current` named, not what the call first read: the
  // compare-and-set above was taken against `current.rev`, so that read is the
  // one describing the revision the pointer actually replaced. Superseding the
  // value read at the top would relabel a revision this call did not replace
  // and leave the one it did replace marked accepted.
  const previousAccepted = current.acceptedRevision;
  let followUpFailure: FollowUpFailure | undefined;
  let supersededRevision: number | undefined;
  // The row as this call's own writes have left it, carried forward from each
  // write's own transaction rather than re-read afterwards: a read taken here
  // cannot tell this call's bumps from a concurrent writer's, and the whole
  // value of handing this number back is that it excludes the latter.
  let committedRev = pointed.value.rev;
  if (previousAccepted !== undefined && previousAccepted !== revision) {
    // Pinned to the pointer move, so a bookkeeping label cannot quietly extend
    // the guarantee `committedRev` carries past the commit it describes. An
    // unpinned label write applies on top of whatever landed since — another
    // sync recording a structural error is the case that matters — and reports
    // the row including that write, which would let this call's follow-up
    // overwrite a verdict newer than its own. Pinned, the same case refuses the
    // label, `committedRev` stays the commit's, and the newer verdict stands.
    const superseded = await store.setChainRevisionState(chainId, previousAccepted, "superseded", {
      expectedRev: pointed.value.rev,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (superseded.ok) {
      supersededRevision = previousAccepted;
      committedRev = superseded.chainRev;
    } else {
      followUpFailure = {
        code: superseded.code,
        ...(superseded.detail === undefined ? {} : { detail: superseded.detail }),
      };
    }
  }

  // The result describes *this* acceptance — `acceptedRevision` and
  // `fingerprint` name the revision the pointer move above committed — so the
  // graph reported beside them has to be that revision's, not whatever the
  // chain holds by the time the answer is assembled. A live read is preferred
  // only while it still names `revision`, since it carries the pointer move and
  // the label writes made since; the moment another acceptance has replaced the
  // graph, the read describes a different revision and the write's own snapshot
  // is used instead. Returning the live read unguarded would hand back
  // `acceptedRevision: 2` alongside revision 3's members. What is pinned is the
  // graph's identity, not the row: a record read here is current by design, and
  // it is only ever the record of the revision this call committed.
  const latest = await store.getChain(chainId);
  const graph: ChainGraph =
    latest !== undefined && latest.chain.graphRevision === revision
      ? latest
      : {
          // `put.value` is the graph this call wrote, so its members and edges
          // are `revision`'s by construction. Its record predates the label and
          // pointer writes, so the pointer is restated; `rev` stays as written,
          // which is what a snapshot of a committed revision honestly reports.
          chain: { ...put.value.chain, acceptedRevision: revision },
          members: put.value.members,
          edges: put.value.edges,
        };

  return {
    status: "accepted",
    chainId,
    acceptedRevision: revision,
    ...(previousAccepted === undefined ? {} : { previousAcceptedRevision: previousAccepted }),
    ...(supersededRevision === undefined ? {} : { supersededRevision }),
    fingerprint: canonical.fingerprint,
    graph,
    committedRev,
    canonical,
    ...(followUpFailure === undefined ? {} : { followUpFailure }),
  };
}
