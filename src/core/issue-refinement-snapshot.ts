/**
 * Chain-aware progressive Issue refinement — the bounded predecessor snapshot
 * (issue #868, docs/issue-refinement-contract.md §4, §5, §6).
 *
 * This module builds the ONE authoritative input set the refiner and critic ever
 * see, and the `predecessorFingerprint` that is its identity. It is the second
 * slice of the lane, after the state/intake foundation in
 * `core/issue-refinement.ts` (issue #867).
 *
 * What it does NOT do is as load-bearing as what it does: it invokes no agent,
 * writes no Issue body, mutates no relationship, and activates no
 * implementation. Every port it depends on is a READ, so those four
 * prohibitions are properties of the type, not promises in a comment.
 *
 * Four properties are worth stating up front, because each is a decision:
 *
 *  - **Provider-neutral by construction.** Nothing here knows about `gh`,
 *    GraphQL, or Gitea. {@link RefinementSnapshotSource} is a read-only port of
 *    provider-neutral shapes, and the chain cross-check of §4 condition 5 is an
 *    OPTIONAL injected resolver — so this lands without the persistent chain
 *    registry, and the registry becomes one adapter of that seam later.
 *  - **Deterministic.** Same inputs → byte-identical snapshot and identical
 *    fingerprint. Wall-clock time is injected (`now`) and deliberately excluded
 *    from the hash; predecessors are ordered by ascending Issue number, changed
 *    paths by ascending path, dispute lineages by the protocol's state order,
 *    and comments by their capture order — so no provider's listing order can
 *    move a digest. Where a provider's order could decide WHICH inputs survive a
 *    cap rather than merely how they are arranged — the changed-path listing —
 *    a non-canonical over-cap listing is refused rather than captured.
 *  - **Bounded, everywhere.** Every text field is truncated to
 *    `MAX_SNAPSHOT_TEXT_BYTES` at capture time and the truncation is recorded in
 *    the manifest (§5) — labels and the PR identity strings included, under
 *    their own caps.
 *    Because every field and every count is capped, the total is bounded too,
 *    and {@link refinementSnapshotByteBudget} states that bound as a number the
 *    manifest carries alongside the actual size.
 *  - **Fails closed.** A predecessor whose PR/head identity is missing or
 *    ambiguous is not usable, and an unusable predecessor holds the Issue at
 *    `pending` (§12 row 4) rather than producing a snapshot with a hole in it. A
 *    predecessor that MOVES between capture and verification holds it for the
 *    same reason, and so does a `blocked by` edge added or removed inside the
 *    capture window: the draft would be written against evidence that had
 *    already changed, which is what §6's staleness rule exists to prevent,
 *    applied one step earlier.
 *
 * **One deliberate omission.** Issue #868's scope line reads "the downstream
 * Issue title/body/comments"; §5 of the contract enumerates the target Issue's
 * inputs as a CLOSED list — number, title, current body, label set,
 * managed-region state, and the local `issue-plan` artifact — with no comment
 * window, and §6's one-to-one rule ("an input the agents receive but this
 * fingerprint does not cover…") is derived from exactly that list. The contract
 * is authoritative over follow-up Issues by its own terms, and adding a target
 * comment window would be a policy change owed to the document first, so the
 * target side implements §5 verbatim. Predecessor comment windows — the ones §5
 * does specify — are captured in full.
 */

import { createHash } from "crypto";
import type { BlockedByEntry } from "./github-intake.js";
import type { ReviewClassification } from "./review-classifier.js";
import type { LineageState } from "./review-dispute.js";
import { LINEAGE_STATES } from "./review-dispute.js";
import type {
  IssueRefinementLimits,
  ManagedRegionShape,
  RefinementLabels,
  RefinementPredecessorRecord,
} from "./issue-refinement.js";
import { computeIssueSourceDigest, scanManagedRegion } from "./issue-refinement.js";
import { redactApiKeys, sanitizeBody } from "./text-sanitize.js";

// ---------------------------------------------------------------------------
// The read-only provider port
//
// Every method is a READ. There is deliberately no write on this interface: §5
// capture and §6 fingerprinting are read-only by contract, and a port that
// cannot mutate is the cheapest possible proof of it.
// ---------------------------------------------------------------------------

/** A work item as this lane reads it — state literal, title, body, labels. */
export interface RefinementIssueRead {
  number: number;
  /** §5 Issue state literal. */
  state: "open" | "closed";
  title: string;
  /** Absent or empty when the item has no body. */
  body?: string | undefined;
  labels: readonly string[];
}

/** A predecessor's stack-ready PR, in provider-neutral terms. */
export interface RefinementPullRequestRead {
  number: number;
  /**
   * §5 PR state literal, already normalized by the adapter. GitHub's
   * `OPEN`/`MERGED`/`CLOSED` and Gitea's `open`/`closed` both map here, and a
   * closed-unmerged PR maps to `closed` — a state §4 accepts in neither shape.
   */
  state: "open" | "merged" | "closed";
  headRefName: string;
  /** The head commit SHA. Absent or empty is a missing-identity failure (§4). */
  headSha?: string | undefined;
  /** Present only for a merged PR; §6 hashes the literal `absent` otherwise. */
  mergeCommitSha?: string | undefined;
  title: string;
  body?: string | undefined;
  /** Mergeability, when the adapter queried it. Mirrors the Gate 2 resolver's check. */
  mergeable?: string | undefined;
  mergeStateStatus?: string | undefined;
}

/**
 * Resolving a predecessor's PR has three answers, not two.
 *
 * `ambiguous` exists because "which PR is this predecessor's result?" can have
 * more than one answer (two open PRs on the same Issue, a head-branch convention
 * that matched twice), and picking one would be a guess about which decisions
 * the downstream Issue is being refined against. §4's fail-closed rule makes
 * that a hold, so the port must be able to SAY ambiguous rather than choose.
 * A transient lookup failure is a throw, never `none` — an unread PR must never
 * be read as "no PR exists".
 */
export type RefinementPullRequestLookup =
  | { kind: "found"; pullRequest: RefinementPullRequestRead }
  | { kind: "none" }
  | { kind: "ambiguous"; detail?: string };

/** One changed path with its line counts. Paths and counts only — never content (§5). */
export interface RefinementChangedPathRead {
  path: string;
  added: number;
  removed: number;
}

/**
 * A changed-path response that STATES whether it is the whole set.
 *
 * A bare array cannot: a complete listing in provider order and a truncated page
 * in provider order are byte-identical, and past the cap those two mean different
 * things (see {@link RefinementSnapshotSource.readChangedPaths}). An adapter that
 * knows it returned every changed path says so here, and is then free to return
 * them in whatever order the provider gave — the core sorts and caps a complete
 * set deterministically. `complete: true` is an assertion the core trusts; an
 * adapter that cannot honestly make it should return the array form instead.
 */
export interface RefinementChangedPathListing {
  paths: readonly RefinementChangedPathRead[];
  /** `true` only when `paths` is EVERY changed path of the PR, unpaged and untruncated. */
  complete: boolean;
}

/** One Issue comment in the §5 window. */
export interface RefinementCommentRead {
  /** Stable provider identifier; hashed by §6. */
  id: string;
  /** Creation timestamp — used to pick the most recent window, never published. */
  createdAt: string;
  /** Last-edited timestamp; hashed by §6 so an edit inside the window is a change. */
  updatedAt: string;
  body: string;
}

/**
 * §5 review evidence for a predecessor: literals and counts, never prose.
 *
 * `disputeLineages` is populated only when the review-dispute protocol is
 * enabled, and carries terminal lineage state literals with their counts
 * exactly as review-dispute-contract.md §11 permits — never a finding's text.
 * Its array order is not significant: the capture re-orders it by the
 * protocol's own state sequence, so a source is free to report it in any order.
 */
export interface RefinementReviewSummaryRead {
  outcome: ReviewClassification;
  disputeLineages?: ReadonlyArray<{ state: LineageState; count: number }> | undefined;
}

/**
 * §4 condition 5: does the observed predecessor set agree with the chain's
 * accepted revision?
 *
 * `unregistered` is the answer for an Issue the registry does not know, and it
 * is NOT a disagreement — §4 scopes the cross-check to "when the Issue is a
 * registered chain member". A resolver that throws is a provider failure and
 * fails closed like any other.
 */
export type RefinementChainAgreement =
  | { kind: "agrees" }
  | { kind: "unregistered" }
  | { kind: "disagrees"; detail?: string };

/**
 * Everything the snapshot builder reads, and nothing it can write.
 *
 * `getBlockedBy` matches the {@link BlockedByEntry} contract the dependency gate
 * already uses (`DependencyChecker`, `WorkItemProvider.getDependencies`): it
 * MUST throw on any error so the caller fails closed instead of reading an
 * unread relationship set as an empty one.
 */
export interface RefinementSnapshotSource {
  /** §5/§18: the direct `blocked by` edge set, from the same relationship checker the dependency gate uses. */
  getBlockedBy(issueNumber: number): Promise<readonly BlockedByEntry[]>;
  /** Read a work item. Throws on failure. */
  readIssue(issueNumber: number): Promise<RefinementIssueRead>;
  /** Resolve the predecessor's stack-ready PR. Throws only on a lookup FAILURE. */
  readPullRequest(issueNumber: number): Promise<RefinementPullRequestLookup>;
  /**
   * Changed paths with per-path counts, capped by the caller-supplied limit.
   *
   * The core asks for one MORE than it will keep, so an adapter that honours the
   * limit exactly still reveals truncation, and it caps again, so an over-eager
   * adapter cannot widen the bound.
   *
   * The core's own sort fixes the order of what it received, but not WHICH paths
   * it received: past the cap a provider-ordered PAGE would decide the surviving
   * subset by a listing order, so two captures of the same PR could differ. A
   * response longer than the cap must therefore either be ordered ascending by
   * path — whose first `cap` entries are the PR's first `cap` paths whatever the
   * source did — or be returned as a {@link RefinementChangedPathListing} with
   * `complete: true`, which says the subset was not chosen at all. Returning the
   * complete list in any order is fine as long as it SAYS so; a bare array is
   * read as possibly truncated, because a complete provider-ordered list and a
   * truncated one are indistinguishable. An over-cap response that is neither
   * ascending nor declared complete is refused rather than captured, so the
   * requirement fails closed instead of silently producing a non-deterministic
   * snapshot. At or under the cap the order never matters.
   */
  readChangedPaths(
    prNumber: number,
    limit: number,
  ): Promise<readonly RefinementChangedPathRead[] | RefinementChangedPathListing>;
  /**
   * The predecessor's Issue comments. The adapter should return at most `limit`
   * most-recent comments; the core sorts and caps regardless, so the window is
   * the same whatever order the adapter used.
   */
  readIssueComments(issueNumber: number, limit: number): Promise<readonly RefinementCommentRead[]>;
  /** The terminal review outcome recorded for this predecessor, or `null` when none is. */
  readReviewSummary(issueNumber: number): Promise<RefinementReviewSummaryRead | null>;
  /** §5: the local `issue-plan` artifact CONTENT for the target Issue, or `null`. Never a path. */
  readIssuePlan(issueNumber: number): Promise<string | null>;
  /**
   * §4 condition 5, optional by design: absent means "no chain registry wired",
   * which reads as `unregistered` and takes no side. This is the seam the
   * persistent chain registry becomes an adapter of.
   */
  readChainAgreement?(
    issueNumber: number,
    observedPredecessors: readonly number[],
  ): Promise<RefinementChainAgreement>;
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** Serialization tag; changing the snapshot shape changes every fingerprint. */
export const REFINEMENT_SNAPSHOT_VERSION = "issue-refinement.snapshot.v1";

/**
 * §5 bounds for the target's label set.
 *
 * Labels are agent-visible snapshot input like any other captured text, so they
 * are bounded like any other captured text — a provider that reports a hundred
 * 4KB labels must not be able to push the snapshot past the
 * {@link refinementSnapshotByteBudget} the manifest publishes.
 *
 * They are snapshot-local constants rather than §8 limits because §8 is a closed
 * contract table an operator may lower; these are floors of the capture itself,
 * and both are far above any label set a repository realistically carries (a
 * GitHub label name is capped at 50 characters upstream), so the bound is a
 * backstop against a hostile or broken source rather than a routine cut.
 */
export const REFINEMENT_MAX_TARGET_LABELS = 64;
export const REFINEMENT_MAX_TARGET_LABEL_BYTES = 256;

/**
 * How many of those labels are lane-owned (§6), and therefore bounded by
 * {@link REFINEMENT_MAX_TARGET_LABEL_BYTES} alone rather than by the prose cap
 * as well — see the capture's label block. Exactly the two of
 * {@link RefinementLabels}, and only relevant to the byte budget below.
 */
const REFINEMENT_LANE_OWNED_LABELS = 2;

/**
 * §5 bound for a predecessor's PR identity strings — head ref name, head SHA,
 * merge commit SHA.
 *
 * These are provider-controlled text exactly like an Issue body is, and they are
 * copied into agent-visible snapshot fields, so they are bounded and charged to
 * the {@link CaptureLedger} like any other captured text. Without that, a source
 * returning a megabyte-long `headRefName` would push the snapshot past the
 * {@link refinementSnapshotByteBudget} the manifest publishes — and a published
 * bound one field can exceed is not a bound.
 *
 * It is a snapshot-local constant for the reason the label caps are (§8 is a
 * closed contract table an operator may lower; this is a floor of the capture
 * itself), and it sits far above any well-formed value: a git ref is at most 255
 * bytes on the filesystems git supports and a SHA-256 object id is 64 hex
 * characters, so truncation here only ever cuts a value that was already
 * malformed.
 */
export const REFINEMENT_MAX_PR_IDENTITY_BYTES = 256;

/** How many of those identity strings each predecessor contributes, for the budget. */
const REFINEMENT_PR_IDENTITY_FIELDS = 3;

/**
 * §5 bound for a captured comment's identity strings — the provider's comment id
 * and its `updatedAt` stamp.
 *
 * The same argument as {@link REFINEMENT_MAX_PR_IDENTITY_BYTES}, one field
 * smaller: both strings are provider-controlled, both are copied into the
 * agent-visible snapshot, and both are hashed by §6 — so a source returning a
 * megabyte-long comment id would push the snapshot past the published
 * {@link refinementSnapshotByteBudget} while the manifest reported a total that
 * never counted it. They are bounded by their own constant rather than by the
 * prose cap for the identity reason too: a comment id cut to a lowered
 * `maxSnapshotTextBytes` is not a shorter id, it is a wrong one, and it is what
 * the truncation record keys a comment body by. The value sits far above any
 * well-formed id (a numeric REST id or a base64 node id) or ISO-8601 stamp, so
 * truncation here only ever cuts a value that was already malformed.
 */
export const REFINEMENT_MAX_COMMENT_IDENTITY_BYTES = 128;

/** How many identity strings each captured comment contributes, for the budget. */
const REFINEMENT_COMMENT_IDENTITY_FIELDS = 2;

/** §4 the two shapes in which a predecessor result is usable. */
export const REFINEMENT_PREDECESSOR_SHAPES = ["open_stack_ready", "merged"] as const;
export type RefinementPredecessorShape = (typeof REFINEMENT_PREDECESSOR_SHAPES)[number];

/**
 * Why one predecessor is not usable (§12 row 4 detail).
 *
 * These are snapshot-local detail literals, not contract vocabulary: the row-4
 * refusal reason is always `predecessor_not_ready`, and this says which of its
 * shapes occurred so an operator surface can report something more useful than
 * "not ready".
 */
export const REFINEMENT_PREDECESSOR_HOLD_REASONS = [
  "no_pull_request",
  "ambiguous_pull_request",
  "not_stack_ready",
  "missing_head_ref",
  "missing_head_sha",
  "missing_merge_commit",
  "pull_request_not_usable",
  "changed_during_capture",
] as const;
export type RefinementPredecessorHoldReason = (typeof REFINEMENT_PREDECESSOR_HOLD_REASONS)[number];

export interface RefinementPredecessorHold {
  issueNumber: number;
  reason: RefinementPredecessorHoldReason;
  /** A literal-only elaboration (a PR state, a missing field name). Never prose from GitHub. */
  detail?: string;
}

/** §5 the target Issue's half of the snapshot. */
export interface RefinementSnapshotTarget {
  issueNumber: number;
  title: string;
  /**
   * The current body, bounded — what §5 hands the agents.
   *
   * Carried ALONGSIDE {@link RefinementSnapshotTarget.sourceBody} rather than
   * instead of it because §6 hashes only the source body: the managed region is
   * one of exactly two inputs excluded from the fingerprint, because the lane
   * itself writes it.
   */
  body: string;
  /** The body with the §10 managed region elided (§6), bounded. This is what is hashed. */
  sourceBody: string;
  /** §5/§10 the managed-region state, read from the FULL body before bounding. */
  managedRegion: ManagedRegionShape;
  /**
   * The label set, deduplicated and sorted, bounded by {@link REFINEMENT_MAX_TARGET_LABELS}
   * and {@link REFINEMENT_MAX_TARGET_LABEL_BYTES}. §6 hashes it with the two lane-owned
   * labels removed — which is why those two are bounded by the label constant alone
   * and never by a lowered `maxSnapshotTextBytes`: the exclusion matches the literal,
   * so a lane label truncated below its literal would defeat it (see the capture).
   */
  labels: string[];
  /**
   * True when the source reported more labels than {@link REFINEMENT_MAX_TARGET_LABELS}
   * admits, or when a label was truncated to its cap — including a label truncation
   * whose result then collapsed into another label's retained prefix.
   *
   * Hashed by §6 (unlike the manifest's truncation record) for the reason the
   * per-field digests make unnecessary elsewhere: dropping a label past the cap
   * leaves the CAPTURED label set byte-identical, so without this flag a label
   * set that grew past the cap would be indistinguishable from one that had not.
   */
  labelsCapped: boolean;
  /** §5 the local `issue-plan` artifact content, bounded; `null` when none exists. */
  issuePlan: string | null;
}

export interface RefinementSnapshotComment {
  /** Bounded by {@link REFINEMENT_MAX_COMMENT_IDENTITY_BYTES} — provider text like any other. */
  id: string;
  /** Bounded by {@link REFINEMENT_MAX_COMMENT_IDENTITY_BYTES}; a well-formed stamp is far inside it. */
  updatedAt: string;
  body: string;
}

export interface RefinementSnapshotPullRequest {
  number: number;
  state: "open" | "merged";
  /** Bounded by {@link REFINEMENT_MAX_PR_IDENTITY_BYTES} — provider text like any other. */
  headRefName: string;
  /** Bounded by {@link REFINEMENT_MAX_PR_IDENTITY_BYTES}; a well-formed object id is far inside it. */
  headSha: string;
  /** §6 hashes the literal `absent` when there is none. Bounded like the other identity strings. */
  mergeCommitSha: string | null;
  title: string;
  body: string;
}

/** §5 one predecessor's bounded evidence. */
export interface RefinementSnapshotPredecessor {
  issueNumber: number;
  issueState: "open" | "closed";
  title: string;
  body: string;
  /** §6: whether the stack-ready marker was present at capture. */
  stackReady: boolean;
  /** Which of the two §4 shapes made this predecessor usable. */
  shape: RefinementPredecessorShape;
  pullRequest: RefinementSnapshotPullRequest;
  /** Paths and counts only, sorted by path, capped by `MAX_CHANGED_PATHS_PER_PREDECESSOR`. */
  changedPaths: RefinementChangedPathRead[];
  /** True when the adapter reported more paths than the cap admits. */
  changedPathsCapped: boolean;
  /** The terminal review outcome literal, or `null` when the loop recorded none. */
  reviewOutcome: ReviewClassification | null;
  /**
   * Terminal dispute lineage literals and counts in the protocol's own state
   * order, or `null` when the protocol is off. Ordered because they are a
   * summary rather than an ordered window: a re-ordered report of the same
   * counts must not move the fingerprint.
   */
  disputeLineages: Array<{ state: LineageState; count: number }> | null;
  /** Up to `MAX_COMMENTS_PER_PREDECESSOR` most recent comments, oldest first. */
  comments: RefinementSnapshotComment[];
}

/**
 * Runner-side bookkeeping about the capture. Deliberately NOT hashed: §6 says
 * the truncation record needs no separate digest because every text digest is
 * already taken over the truncated bytes, and hashing `capturedAt` would make
 * an idempotent re-capture look like a changed input.
 */
export interface RefinementSnapshotManifest {
  capturedAt: string;
  /** The §8 limits actually in force for this capture. */
  limits: IssueRefinementLimits;
  /** Field ids whose text was truncated at capture time, in capture order (§5). */
  truncatedFields: string[];
  /**
   * Total UTF-8 bytes of every text field placed in the snapshot's content — the
   * captured prose and identity strings, and the state literals stored directly
   * beside them (§4 shapes, Issue/PR states, review outcomes, dispute lineage
   * states, the managed-region shape, the version tag, the fingerprint).
   *
   * This manifest's own fields are outside it, and deliberately: they describe
   * the capture rather than being content handed to the agents, and counting the
   * truncated-field ids would count identifiers already counted where they were
   * captured.
   */
  totalTextBytes: number;
  /** The provable upper bound for this predecessor count (see {@link refinementSnapshotByteBudget}). */
  maxTotalTextBytes: number;
  predecessorCount: number;
}

export interface RefinementSnapshot {
  version: typeof REFINEMENT_SNAPSHOT_VERSION;
  target: RefinementSnapshotTarget;
  /** Ascending Issue number (§5, §6). */
  predecessors: RefinementSnapshotPredecessor[];
  manifest: RefinementSnapshotManifest;
  /** §6 SHA-256 over every input the snapshot hands the agents. */
  predecessorFingerprint: string;
}

/** Where a provider failure happened, so a retry can say what it was retrying. */
export type RefinementSnapshotFailureStage =
  | "blocked_by"
  | "chain_agreement"
  | "issue"
  | "pull_request"
  | "changed_paths"
  | "comments"
  | "review_summary"
  | "issue_plan";

/**
 * The outcome of one capture attempt, in §4's own vocabulary.
 *
 *  - `captured` — §12 row 3 / row 10: eligible, and here is the frozen input set.
 *  - `hold` — row 4: `predecessor_not_ready`. Re-evaluated on the next poll; no
 *    counter moves and no task is handed off.
 *  - `handoff` — rows 5, 6, 7. None of these is fixed by waiting, which is why
 *    §4 orders them BEFORE the hold.
 *  - `failed` — a provider/network error. Nothing proceeds; the caller applies
 *    the existing transient retry behavior. Never reported as "no blockers".
 */
export type RefinementSnapshotResult =
  | { kind: "captured"; snapshot: RefinementSnapshot }
  | {
      kind: "hold";
      reason: "predecessor_not_ready";
      predecessorIssueNumbers: number[];
      holds: RefinementPredecessorHold[];
    }
  | {
      kind: "handoff";
      reason: "not_chain_scoped" | "fan_in_exceeded" | "chain_disagreement";
      predecessorIssueNumbers: number[];
      detail?: string;
    }
  | { kind: "failed"; stage: RefinementSnapshotFailureStage; issueNumber: number; error: string };

export interface BuildRefinementSnapshotInput {
  /** The Issue being refined. Its labels and body come from the caller's live read. */
  target: RefinementIssueRead;
  source: RefinementSnapshotSource;
  /** §8 limits in force for this attempt, pinned by the task's §15 block. */
  limits: IssueRefinementLimits;
  /** §6: the two lane-owned labels, excluded from the target's hashed label set. */
  laneLabels: RefinementLabels;
  /** §4: `session.labels.stackReady`, the success-only marker the open shape requires. */
  stackReadyLabel: string;
  /** Injected wall clock; recorded in the manifest and never hashed. */
  now: string;
}

// ---------------------------------------------------------------------------
// Bounding and redaction
// ---------------------------------------------------------------------------

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes, never splitting a code
 * point.
 *
 * No ellipsis is appended, deliberately: a marker would push the field past the
 * cap it was truncated to and would become part of the digest §6 takes over
 * "the bytes the agents saw". The fact of truncation is recorded in the
 * manifest instead, which is exactly where §5 puts it.
 */
export function boundSnapshotText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  // A lone high surrogate at the cut would be an unpaired code unit; drop it so
  // the stored text is well-formed UTF-16 and its digest is stable.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * Strip what must never enter the snapshot from a captured text field.
 *
 * Two transforms, both deterministic so the digest stays reproducible:
 * absolute filesystem paths (`sanitizeBody`) and third-party credential shapes
 * (`redactApiKeys`).
 *
 * `redactTokens` is deliberately NOT applied here WHOLE even though it is the
 * sibling catch-all: it rewrites every 40-hex run as `[redacted]`, and a
 * predecessor's head commit SHA is precisely a 40-hex run — the identity this
 * whole snapshot is built around. Its other two clauses have no such collateral
 * and ARE applied, by {@link redactTokensPreservingShas} below.
 */
function captureText(text: string | undefined): string {
  if (!text) return "";
  return redactTokensPreservingShas(redactApiKeys(sanitizeBody(text)));
}

/**
 * The token shapes of `redactTokens`, minus only its 40-hex clause (see
 * {@link captureText}).
 *
 * The keyword-introduced form matters as much as the GitHub prefixes here:
 * snapshot text is attacker-controllable Issue/PR prose and locally read plan
 * content (§5), so a `Bearer <secret>` or `token <secret>` pasted into an Issue
 * would otherwise reach the agents verbatim. Redacting it keeps the introducing
 * keyword, so the text still reads as a credential mention rather than losing a
 * sentence — and a bare 40-hex SHA, which carries no such introducer, survives.
 */
function redactTokensPreservingShas(text: string): string {
  return text
    .replace(/\b(?:gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/\b(token|Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "$1 [redacted]");
}

/** A bounded value that has not been charged to the ledger yet. */
interface PreparedField {
  text: string;
  truncated: boolean;
}

/** A capture-time accumulator for the manifest's truncation record and byte total. */
class CaptureLedger {
  readonly truncatedFields: string[] = [];
  totalTextBytes = 0;

  constructor(private readonly maxBytes: number) {}

  /**
   * Redact, bound, and record one text field.
   *
   * `postBound` runs AFTER the cut and before the byte is counted, so a field
   * that needs a normalization the truncation could disturb (the source body's
   * trailing-whitespace strip, §6) is accounted for at the size it is stored.
   */
  field(id: string, raw: string | undefined, postBound?: (text: string) => string): string {
    return this.record(id, raw, this.maxBytes, postBound);
  }

  /**
   * An identity string — a PR's head ref name, head SHA or merge commit SHA, a
   * comment's id or `updatedAt` stamp — bounded by its own `maxBytes`
   * INDEPENDENTLY of the general text cap.
   *
   * Independently, because `maxSnapshotTextBytes` is a prose cap and lowering it
   * must not corrupt an identifier: a truncated head SHA is not a shorter SHA,
   * it is a wrong one, and §15 persists exactly these values as the
   * predecessor's identity. The identity constants sit far above any well-formed
   * ref, object id, comment id or timestamp, so the field is still bounded and
   * still charged here — a source cannot smuggle unbounded text through it —
   * while a legitimate value survives whatever the operator set the prose cap to.
   */
  identityField(
    id: string,
    raw: string | undefined,
    maxBytes: number = REFINEMENT_MAX_PR_IDENTITY_BYTES,
  ): string {
    return this.record(id, raw, maxBytes);
  }

  /**
   * Redact and bound a value WITHOUT charging it, for a field whose membership
   * in the snapshot is decided after bounding.
   *
   * The target's label set is the one such field: two over-long labels can share
   * their retained prefix, and the collapse that follows keeps exactly one of
   * them. Charging at bound time would put bytes in the manifest that are not in
   * the snapshot, so the caller charges what it keeps with
   * {@link CaptureLedger.commit} instead. `maxBytes` is applied as given — the
   * caller chooses whether to min it with the general cap, the way {@link
   * CaptureLedger.field} does and {@link CaptureLedger.identityField} does not.
   */
  prepare(raw: string | undefined, maxBytes: number): PreparedField {
    return boundSnapshotText(captureText(raw), maxBytes);
  }

  /**
   * {@link CaptureLedger.prepare} for a value this lane OWNS: bounded, but not
   * redacted.
   *
   * The redaction pass exists for provider-controlled prose. A lane-owned label
   * is neither — it is a literal this module was handed in `laneLabels` and
   * matched against exactly — and §6 excludes it from the hashed label set by
   * comparing that literal, so any rewrite of it would silently defeat the
   * exclusion.
   */
  prepareLiteral(raw: string, maxBytes: number): PreparedField {
    return boundSnapshotText(raw, maxBytes);
  }

  /**
   * Charge a closed-vocabulary literal the snapshot stores directly — an Issue or
   * PR state, a predecessor shape, a review outcome, a dispute lineage state, the
   * managed-region shape, the version tag, the fingerprint.
   *
   * These are not captured prose: they come from this module's own vocabularies
   * (or are digests of a fixed width), so there is nothing to redact, nothing to
   * truncate, and no truncation record to make. They ARE text placed in the
   * snapshot, though, so the manifest's byte total counts them and
   * {@link refinementSnapshotByteBudget} carries a term for each — a total that
   * skipped them would not be the total §5 says it is. The value is returned
   * unchanged, and its literal type with it, so charging is an annotation at the
   * point of storage rather than a second list to keep in step.
   */
  literal<T extends string>(value: T): T {
    this.totalTextBytes += byteLength(value);
    return value;
  }

  /** Charge a {@link CaptureLedger.prepare}d value to the manifest and return it. */
  commit(id: string, prepared: PreparedField): string {
    if (prepared.truncated) this.truncatedFields.push(id);
    this.totalTextBytes += byteLength(prepared.text);
    return prepared.text;
  }

  private record(
    id: string,
    raw: string | undefined,
    maxBytes: number,
    postBound?: (text: string) => string,
  ): string {
    const bounded = this.prepare(raw, maxBytes);
    const text = postBound ? postBound(bounded.text) : bounded.text;
    return this.commit(id, { text, truncated: bounded.truncated });
  }
}

/**
 * The longest literal of a closed vocabulary, in bytes.
 *
 * The vocabularies below are written as exhaustive key sets rather than arrays
 * so that widening one of their unions is a compile error here — a silently
 * understated budget is exactly the failure this bound exists to rule out.
 */
function longestLiteral(vocabulary: Record<string, null>): number {
  return Object.keys(vocabulary).reduce((max, v) => Math.max(max, byteLength(v)), 0);
}

const MANAGED_REGION_SHAPE_VOCABULARY: Record<ManagedRegionShape, null> = {
  absent: null,
  present: null,
  malformed: null,
};
const REVIEW_OUTCOME_VOCABULARY: Record<ReviewClassification, null> = {
  success: null,
  needs_fix: null,
  conflict: null,
  blocked: null,
};
const ISSUE_STATE_VOCABULARY: Record<RefinementSnapshotPredecessor["issueState"], null> = {
  open: null,
  closed: null,
};
const PR_STATE_VOCABULARY: Record<RefinementSnapshotPullRequest["state"], null> = {
  open: null,
  merged: null,
};
const PREDECESSOR_SHAPE_VOCABULARY: Record<RefinementPredecessorShape, null> = {
  open_stack_ready: null,
  merged: null,
};
// Derived from the protocol's own list rather than restated, because that list
// is the vocabulary — a state added there is one this snapshot can store.
const LINEAGE_STATE_VOCABULARY: Record<LineageState, null> = Object.fromEntries(
  LINEAGE_STATES.map((s) => [s, null] as const),
) as Record<LineageState, null>;

/** A SHA-256 rendered as lowercase hex, which is what §6's fingerprint always is. */
const REFINEMENT_DIGEST_BYTES = 64;

/**
 * The snapshot-wide literals: the version tag and the fingerprint at the root,
 * and the target's managed-region shape.
 */
const REFINEMENT_SNAPSHOT_LITERAL_BYTES =
  byteLength(REFINEMENT_SNAPSHOT_VERSION) +
  REFINEMENT_DIGEST_BYTES +
  longestLiteral(MANAGED_REGION_SHAPE_VOCABULARY);

/**
 * One predecessor's literals: Issue state, §4 shape, PR state, review outcome,
 * and its dispute lineage rows — at most one per protocol state, because the
 * capture merges duplicate rows (see {@link canonicalDisputeLineages}).
 */
const REFINEMENT_PREDECESSOR_LITERAL_BYTES =
  longestLiteral(ISSUE_STATE_VOCABULARY) +
  longestLiteral(PREDECESSOR_SHAPE_VOCABULARY) +
  longestLiteral(PR_STATE_VOCABULARY) +
  longestLiteral(REVIEW_OUTCOME_VOCABULARY) +
  LINEAGE_STATES.length * longestLiteral(LINEAGE_STATE_VOCABULARY);

/**
 * The provable upper bound on a snapshot's total text size, in bytes.
 *
 * Every text field is capped at `MAX_SNAPSHOT_TEXT_BYTES` and every repeated
 * field has its own count cap, so the total is a product of constants rather
 * than a hope. Four target fields (title, body, source body, issue-plan) plus,
 * per predecessor, four fields (Issue title/body, PR title/body), one comment
 * window, and one changed-path list.
 *
 * Three groups carry their own caps and so contribute their own terms rather than
 * riding on `maxSnapshotTextBytes` — but all three are inside the bound, because
 * all three are agent-visible input: the target's label set
 * ({@link REFINEMENT_MAX_TARGET_LABEL_BYTES} each, {@link REFINEMENT_MAX_TARGET_LABELS} of
 * them), each predecessor's three PR identity strings — head ref name, head
 * SHA, merge commit SHA — at {@link REFINEMENT_MAX_PR_IDENTITY_BYTES} each, and the
 * two identity strings of every captured comment — id and `updatedAt` — at
 * {@link REFINEMENT_MAX_COMMENT_IDENTITY_BYTES} each. The identity terms do not
 * shrink with a lowered prose cap, because those fields are deliberately not cut
 * by one (see {@link CaptureLedger.identityField}), and neither do the two
 * lane-owned labels, for the same reason.
 *
 * A fourth group is neither captured prose nor an identity string: the state
 * literals the snapshot stores directly — Issue and PR states, the §4 shape, the
 * review outcome, the dispute lineage states, the managed-region shape, the
 * version tag, the fingerprint. They are text placed in the snapshot like any
 * other, the manifest's total counts them ({@link CaptureLedger.literal}), and so
 * the bound carries a term for each, taken from the longest literal of each
 * closed vocabulary. Without them the published bound would be one a snapshot
 * with all its counted fields at their caps could exceed, which is not a bound.
 *
 * The manifest's own bookkeeping — `capturedAt`, the pinned limits, the
 * truncated-field ids — is outside the total by definition: it describes the
 * capture rather than being content handed to the agents, and its ids are
 * derived from fields already counted.
 */
export function refinementSnapshotByteBudget(
  limits: IssueRefinementLimits,
  predecessorCount: number,
): number {
  const perPredecessor =
    4 + limits.maxCommentsPerPredecessor + limits.maxChangedPathsPerPredecessor;
  const perLabel = Math.min(REFINEMENT_MAX_TARGET_LABEL_BYTES, limits.maxSnapshotTextBytes);
  // The two lane-owned labels do not shrink with a lowered prose cap, for the
  // reason the identity strings do not: §6 excludes them by matching the literal.
  const labelBytes =
    (REFINEMENT_MAX_TARGET_LABELS - REFINEMENT_LANE_OWNED_LABELS) * perLabel +
    REFINEMENT_LANE_OWNED_LABELS * REFINEMENT_MAX_TARGET_LABEL_BYTES;
  const identityBytes =
    predecessorCount *
    (REFINEMENT_PR_IDENTITY_FIELDS * REFINEMENT_MAX_PR_IDENTITY_BYTES +
      limits.maxCommentsPerPredecessor *
        REFINEMENT_COMMENT_IDENTITY_FIELDS *
        REFINEMENT_MAX_COMMENT_IDENTITY_BYTES);
  const literalBytes =
    REFINEMENT_SNAPSHOT_LITERAL_BYTES + predecessorCount * REFINEMENT_PREDECESSOR_LITERAL_BYTES;
  return (
    limits.maxSnapshotTextBytes * (4 + predecessorCount * perPredecessor) +
    labelBytes +
    identityBytes +
    literalBytes
  );
}

// ---------------------------------------------------------------------------
// §4 predecessor usability
// ---------------------------------------------------------------------------

/**
 * The identity of a predecessor result: the tuple whose movement invalidates a
 * draft written against it.
 *
 * Compared before and after capture so that "a predecessor changed during
 * snapshot construction" is detected here rather than surviving into a draft —
 * the same fact §6 catches at the commit point, one step earlier and one poll
 * cheaper.
 */
export interface RefinementPredecessorIdentity {
  issueState: "open" | "closed";
  stackReady: boolean;
  prNumber: number;
  prState: string;
  headRefName: string;
  headSha: string;
  /** The empty string when the PR is not merged; §6 hashes `absent` for that case. */
  mergeCommitSha: string;
}

export interface RefinementUsablePredecessor {
  issue: RefinementIssueRead;
  pullRequest: RefinementPullRequestRead;
  shape: RefinementPredecessorShape;
  stackReady: boolean;
  identity: RefinementPredecessorIdentity;
}

export type RefinementPredecessorUsability =
  | { kind: "usable"; usable: RefinementUsablePredecessor }
  | { kind: "unusable"; hold: RefinementPredecessorHold };

/**
 * Decide §4 condition 4 for one predecessor: is its result usable, in one of
 * exactly two shapes?
 *
 * The open shape mirrors the Gate 2 stack-ready resolver verbatim — the marker
 * must be present AND a usable (non-conflicting) PR head must resolve — because
 * §4 says refinement reuses that signal rather than inventing a second one. The
 * merged shape is the addition §18 names on the refinement side only: a merged
 * PR is more authoritative than an open head, and it does NOT require the
 * marker to still be present, because the merge itself carries the human
 * approval the marker stands in for.
 */
export function classifyPredecessorUsability(
  issue: RefinementIssueRead,
  lookup: RefinementPullRequestLookup,
  stackReadyLabel: string,
): RefinementPredecessorUsability {
  const issueNumber = issue.number;
  if (lookup.kind === "none") {
    return { kind: "unusable", hold: { issueNumber, reason: "no_pull_request" } };
  }
  if (lookup.kind === "ambiguous") {
    return {
      kind: "unusable",
      hold: {
        issueNumber,
        reason: "ambiguous_pull_request",
        ...(lookup.detail !== undefined ? { detail: lookup.detail } : {}),
      },
    };
  }

  const pr = lookup.pullRequest;
  const stackReady = issue.labels.includes(stackReadyLabel);
  const headSha = pr.headSha ?? "";
  const mergeCommitSha = pr.mergeCommitSha ?? "";

  if (pr.state !== "open" && pr.state !== "merged") {
    return {
      kind: "unusable",
      hold: { issueNumber, reason: "pull_request_not_usable", detail: `state=${pr.state}` },
    };
  }

  if (pr.state === "open") {
    // The success-only marker is the whole of the open shape's human approval.
    // The ready-for-human label is not accepted as a substitute anywhere in this
    // codebase, and is not read here either (issue #208).
    if (!stackReady) {
      return { kind: "unusable", hold: { issueNumber, reason: "not_stack_ready" } };
    }
    if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
      return {
        kind: "unusable",
        hold: {
          issueNumber,
          reason: "pull_request_not_usable",
          detail: `mergeable=${pr.mergeable ?? "-"} mergeStateStatus=${pr.mergeStateStatus ?? "-"}`,
        },
      };
    }
  } else if (mergeCommitSha.length === 0) {
    // §4's merged shape requires a resolvable merge commit SHA as well as a head
    // commit SHA. A PR reported merged with neither is ambiguous identity, not a
    // usable result.
    return { kind: "unusable", hold: { issueNumber, reason: "missing_merge_commit" } };
  }

  if (pr.headRefName.length === 0) {
    return { kind: "unusable", hold: { issueNumber, reason: "missing_head_ref" } };
  }
  if (headSha.length === 0) {
    return { kind: "unusable", hold: { issueNumber, reason: "missing_head_sha" } };
  }

  return {
    kind: "usable",
    usable: {
      issue,
      pullRequest: pr,
      shape: pr.state === "merged" ? "merged" : "open_stack_ready",
      stackReady,
      identity: {
        issueState: issue.state,
        stackReady,
        prNumber: pr.number,
        prState: pr.state,
        headRefName: pr.headRefName,
        headSha,
        mergeCommitSha,
      },
    },
  };
}

function identitiesEqual(
  a: RefinementPredecessorIdentity,
  b: RefinementPredecessorIdentity,
): boolean {
  return (
    a.issueState === b.issueState &&
    a.stackReady === b.stackReady &&
    a.prNumber === b.prNumber &&
    a.prState === b.prState &&
    a.headRefName === b.headRefName &&
    a.headSha === b.headSha &&
    a.mergeCommitSha === b.mergeCommitSha
  );
}

// ---------------------------------------------------------------------------
// §6 the fingerprint
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * §6 `predecessorFingerprint`: SHA-256 over a canonical serialization of every
 * input the snapshot hands the agents.
 *
 * The target half reuses §6's target-side serialization
 * ({@link computeIssueSourceDigest}) rather than restating it, so the shape #867
 * records at admission and the shape this slice records at capture cannot drift
 * apart. Everything is a digest or a JSON scalar, so no field can be confused
 * with another by concatenation.
 *
 * The stored `sourceBody` is hashed AS STORED, by the digest-only entry point
 * that takes an already-elided body — deliberately not by re-scanning it. The
 * capture elides the managed region once, before bounding; a malformed region is
 * stored unelided by design, and the cut can leave behind what reads as a
 * well-formed region, so a second elision here would drop bytes the agents were
 * handed and edits to them would stop moving this fingerprint.
 *
 * Exactly two inputs are excluded, both of them writes this lane performs
 * itself (§6): the managed region of the target body — elided by the capture —
 * and the two lane-owned labels, removed by the target-side digest.
 * `capturedAt` is not an agent input at all and is not hashed either.
 */
export function computePredecessorFingerprint(
  target: RefinementSnapshotTarget,
  predecessors: readonly RefinementSnapshotPredecessor[],
  laneLabels: RefinementLabels,
): string {
  const targetDigest = computeIssueSourceDigest({
    issueNumber: target.issueNumber,
    title: target.title,
    sourceBody: target.sourceBody,
    labels: target.labels,
    laneLabels,
  });

  const predecessorParts = predecessors.map((p) => [
    p.issueNumber,
    p.issueState,
    sha256(p.title),
    sha256(p.body),
    p.stackReady,
    p.pullRequest.number,
    p.pullRequest.state,
    p.pullRequest.headRefName,
    p.pullRequest.headSha,
    p.pullRequest.mergeCommitSha ?? "absent",
    sha256(p.pullRequest.title),
    sha256(p.pullRequest.body),
    sha256(JSON.stringify(p.changedPaths.map((c) => [c.path, c.added, c.removed]))),
    // Hashed alongside the list itself: a source that grows past the cap leaves
    // the CAPTURED list byte-identical while this flag flips, and the flag is
    // what tells the agents whether their path list is complete.
    p.changedPathsCapped,
    p.reviewOutcome ?? "absent",
    p.disputeLineages === null
      ? "absent"
      : sha256(JSON.stringify(p.disputeLineages.map((l) => [l.state, l.count]))),
    sha256(JSON.stringify(p.comments.map((c) => [c.id, c.updatedAt, sha256(c.body)]))),
  ]);

  return sha256(
    JSON.stringify([
      REFINEMENT_SNAPSHOT_VERSION,
      targetDigest,
      // Qualifies the label set inside `targetDigest`, for the same reason
      // `changedPathsCapped` is hashed above.
      target.labelsCapped,
      target.issuePlan === null ? "absent" : sha256(target.issuePlan),
      predecessorParts,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** The one code-unit comparator, so every canonical order in this module agrees. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read a changed-path response as a listing.
 *
 * The bare-array form carries no completeness claim, and the safe reading of
 * silence is "possibly truncated" — an array that happens to be complete looks
 * exactly like a page, so assuming the former would capture a provider-chosen
 * subset as if it were the PR's first paths.
 */
function asChangedPathListing(
  response: readonly RefinementChangedPathRead[] | RefinementChangedPathListing,
): RefinementChangedPathListing {
  return Array.isArray(response)
    ? { paths: response, complete: false }
    : (response as RefinementChangedPathListing);
}

/** Is this changed-path listing already ordered ascending by path? */
function pathsAreCanonical(paths: readonly RefinementChangedPathRead[]): boolean {
  let previous: string | null = null;
  for (const entry of paths) {
    if (previous !== null && compareStrings(previous, entry.path) > 0) return false;
    previous = entry.path;
  }
  return true;
}

/**
 * §5 dispute lineages in a canonical order.
 *
 * Unlike a comment window, these are state/count SUMMARIES: the array order
 * carries no evidence, so it must not carry a fingerprint either — a source that
 * reports the same counts in a different order has reported the same review
 * facts. They are ordered by the protocol's own state sequence
 * ({@link LINEAGE_STATES}); a token the protocol does not know sorts last by
 * literal, so even an unrecognized state is placed deterministically rather than
 * left where the provider happened to put it.
 *
 * A state reported more than once is one state's count reported in parts —
 * review-dispute-contract.md §11 lists each state once — so the rows are merged
 * rather than kept side by side. That is also what bounds the stored literal
 * list by the protocol's vocabulary, which the per-predecessor term of
 * {@link refinementSnapshotByteBudget} rests on.
 */
function canonicalDisputeLineages(
  lineages: ReadonlyArray<{ state: LineageState; count: number }>,
): Array<{ state: LineageState; count: number }> {
  const rank = (state: LineageState): number => {
    const index = LINEAGE_STATES.indexOf(state);
    return index === -1 ? LINEAGE_STATES.length : index;
  };
  const merged = new Map<LineageState, number>();
  for (const l of lineages) merged.set(l.state, (merged.get(l.state) ?? 0) + l.count);
  return [...merged]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => rank(a.state) - rank(b.state) || compareStrings(a.state, b.state));
}

/**
 * §1: the direct `blocked by` neighbours, canonically. Duplicate edges are
 * collapsed so a provider that reports an edge twice cannot inflate the fan-in
 * count past its cap, and the ascending order is the one §5/§6 capture in.
 *
 * Exported for the intake-side gate of issue #967, which answers §4 conditions
 * 2–5 before a claimable task exists: it must derive the predecessor set from
 * the same edges, in the same canonical order, or the two evaluations could
 * disagree about the fan-in count.
 */
export function directPredecessorNumbers(blockedBy: readonly BlockedByEntry[]): number[] {
  return [...new Set(blockedBy.map((b) => b.issueNumber))].sort((a, b) => a - b);
}

/**
 * §4 condition 5, as a step that can be run more than once — at the start of a
 * capture and again before it is sealed.
 *
 * Returns the refusal, or `null` when the chain takes no side: an absent
 * resolver (no registry wired) and an `unregistered` Issue both read as
 * agreement, per §4's scoping of the cross-check to registered members.
 */
async function checkChainAgreement(
  source: RefinementSnapshotSource,
  targetNumber: number,
  predecessorNumbers: number[],
): Promise<RefinementSnapshotResult | null> {
  if (!source.readChainAgreement) return null;
  let agreement: RefinementChainAgreement;
  try {
    agreement = await source.readChainAgreement(targetNumber, predecessorNumbers);
  } catch (err) {
    return failure("chain_agreement", targetNumber, err);
  }
  if (agreement.kind !== "disagrees") return null;
  return {
    kind: "handoff",
    reason: "chain_disagreement",
    predecessorIssueNumbers: predecessorNumbers,
    ...(agreement.detail !== undefined ? { detail: agreement.detail } : {}),
  };
}

/**
 * The `blocked by` edges that appeared or vanished between two reads, as §12
 * row 4 holds.
 *
 * A predecessor set is an eligibility input in its own right (§4), so an edge
 * added or removed mid-capture is the same class of event as a predecessor whose
 * head moved: the snapshot would certify a set that is no longer the Issue's.
 * Both directions are reported — a vanished edge would leave the snapshot
 * carrying a predecessor the Issue no longer has, an added one would leave it
 * missing a predecessor the refiner must see.
 */
function predecessorSetDrift(
  before: readonly number[],
  after: readonly number[],
): RefinementPredecessorHold[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const holds: RefinementPredecessorHold[] = [];
  for (const issueNumber of before) {
    if (!afterSet.has(issueNumber)) {
      holds.push({ issueNumber, reason: "changed_during_capture", detail: "predecessor_removed" });
    }
  }
  for (const issueNumber of after) {
    if (!beforeSet.has(issueNumber)) {
      holds.push({ issueNumber, reason: "changed_during_capture", detail: "predecessor_added" });
    }
  }
  return holds;
}

function failure(
  stage: RefinementSnapshotFailureStage,
  issueNumber: number,
  err: unknown,
): Extract<RefinementSnapshotResult, { kind: "failed" }> {
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: "failed",
    stage,
    issueNumber,
    error: redactTokensPreservingShas(redactApiKeys(sanitizeBody(message))),
  };
}

/**
 * Build the §5 bounded snapshot and its §6 fingerprint, or say why not.
 *
 * The order of work is §4's ordered guard list, and it is normative rather than
 * incidental: the three structural failures are decided BEFORE the readiness
 * hold, because none of them is fixed by waiting and taking the hold instead
 * would bury a condition that needs a human under an indefinite sequence of
 * `predecessor_not_ready` refusals.
 *
 *  1. no direct predecessor        → handoff `not_chain_scoped`      (row 7)
 *  2. more than the fan-in cap     → handoff `fan_in_exceeded`       (row 5)
 *  3. chain registry disagrees     → handoff `chain_disagreement`    (row 6)
 *  4. any predecessor not usable   → hold `predecessor_not_ready`    (row 4)
 *  5. otherwise                    → capture                          (rows 3, 10)
 *
 * Capture then re-verifies what it was decided on before it seals anything: each
 * predecessor's identity, and — last of all — the predecessor SET itself and the
 * chain cross-check over it. Guards 1–3 and 4 are both read once at the top of a
 * capture that is many provider reads long, so without that second pass a
 * `captured` snapshot could certify a predecessor set or a head that had already
 * moved. A difference is guard 4's hold, and the next poll starts over.
 */
export async function buildRefinementSnapshot(
  input: BuildRefinementSnapshotInput,
): Promise<RefinementSnapshotResult> {
  const { target, source, limits, laneLabels, stackReadyLabel, now } = input;

  let blockedBy: readonly BlockedByEntry[];
  try {
    blockedBy = await source.getBlockedBy(target.number);
  } catch (err) {
    return failure("blocked_by", target.number, err);
  }

  // §1: a predecessor is a DIRECT `blocked by` neighbour, open or closed —
  // transitive ancestors never are, and a closed one is exactly the merged shape
  // §4 admits.
  const predecessorNumbers = directPredecessorNumbers(blockedBy);

  if (predecessorNumbers.length === 0) {
    return { kind: "handoff", reason: "not_chain_scoped", predecessorIssueNumbers: [] };
  }
  if (predecessorNumbers.length > limits.maxPredecessorsPerRefinement) {
    return {
      kind: "handoff",
      reason: "fan_in_exceeded",
      predecessorIssueNumbers: predecessorNumbers,
      detail: `${predecessorNumbers.length} direct predecessors; the cap is ${limits.maxPredecessorsPerRefinement}`,
    };
  }

  const disagreement = await checkChainAgreement(source, target.number, predecessorNumbers);
  if (disagreement) return disagreement;

  // ---- §4 condition 4: every predecessor must have a usable result ----------
  const usable: RefinementUsablePredecessor[] = [];
  const holds: RefinementPredecessorHold[] = [];
  for (const issueNumber of predecessorNumbers) {
    let issue: RefinementIssueRead;
    try {
      issue = await source.readIssue(issueNumber);
    } catch (err) {
      return failure("issue", issueNumber, err);
    }
    let lookup: RefinementPullRequestLookup;
    try {
      lookup = await source.readPullRequest(issueNumber);
    } catch (err) {
      return failure("pull_request", issueNumber, err);
    }
    const verdict = classifyPredecessorUsability(issue, lookup, stackReadyLabel);
    if (verdict.kind === "unusable") holds.push(verdict.hold);
    else usable.push(verdict.usable);
  }

  // Partial readiness holds, it does not proceed (§4): refining against half a
  // chain would produce a contract the remaining predecessor immediately
  // invalidates.
  if (holds.length > 0) {
    return {
      kind: "hold",
      reason: "predecessor_not_ready",
      predecessorIssueNumbers: predecessorNumbers,
      holds,
    };
  }

  // ---- Capture -------------------------------------------------------------
  const ledger = new CaptureLedger(limits.maxSnapshotTextBytes);

  const region = scanManagedRegion(target.body);
  // Labels are captured text like any other §5 field: deduplicated, sorted (so
  // the digest is independent of the provider's listing order), capped by count,
  // and each one bounded and charged to the ledger.
  //
  // Two details of that are load-bearing:
  //
  //  - The two lane-owned labels are bounded by the label constant ALONE, not by
  //    it min'd with `maxSnapshotTextBytes`, and are not passed through the
  //    redaction pass. §6 excludes them from the hashed label set by matching the
  //    literal, and `maxSnapshotTextBytes` may legitimately be lowered below
  //    their length — a lane label cut down to `sta` is no longer the literal, so
  //    it would survive into the digest and the lane's own step-5 label
  //    transition would invalidate the snapshot that transition is applying. This
  //    is the rule the PR identity strings already follow, for the same reason:
  //    a prose cap must not corrupt an identifier.
  //  - Bounding can make two distinct over-long labels collide on their retained
  //    prefix, and the collapse below keeps one of them. Only what survives the
  //    collapse is charged, so the manifest's byte total stays what §5 says it is
  //    — the bytes of the fields actually placed in the snapshot — rather than
  //    counting a label the snapshot does not carry.
  const laneOwned = new Set([laneLabels.marker, laneLabels.implementationStatus]);
  const proseLabelBytes = Math.min(REFINEMENT_MAX_TARGET_LABEL_BYTES, limits.maxSnapshotTextBytes);
  const rawLabels = [...new Set(target.labels)].sort(compareStrings);
  const labels: string[] = [];
  const keptLabels = new Set<string>();
  let labelTruncated = false;
  rawLabels.slice(0, REFINEMENT_MAX_TARGET_LABELS).forEach((label, i) => {
    const bounded = laneOwned.has(label)
      ? ledger.prepareLiteral(label, REFINEMENT_MAX_TARGET_LABEL_BYTES)
      : ledger.prepare(label, proseLabelBytes);
    // Recorded even when the value is then collapsed away: the label set lost
    // information either way, which is exactly what `labelsCapped` reports.
    if (bounded.truncated) labelTruncated = true;
    if (keptLabels.has(bounded.text)) return;
    keptLabels.add(bounded.text);
    labels.push(ledger.commit(`target.label.${i}`, bounded));
  });
  // Bounding is order-preserving for same-cap prefixes, but the lane-owned
  // labels are cut at a different cap, so the stored set is re-sorted rather
  // than assumed sorted — §6 hashes this order.
  labels.sort(compareStrings);
  const labelsCapped = rawLabels.length > REFINEMENT_MAX_TARGET_LABELS || labelTruncated;
  const targetSnapshot: RefinementSnapshotTarget = {
    issueNumber: target.number,
    title: ledger.field("target.title", target.title),
    body: ledger.field("target.body", target.body),
    // Bounding can leave trailing whitespace where the elision had stripped it,
    // and §6's digest must be over exactly these bytes — so the strip is redone
    // after the cut, which is also what makes re-hashing the stored value
    // reproduce the same digest.
    sourceBody: ledger.field("target.sourceBody", region.sourceBody, (t) => t.replace(/\s+$/, "")),
    managedRegion: ledger.literal(region.shape),
    labels,
    labelsCapped,
    issuePlan: null,
  };

  let plan: string | null;
  try {
    plan = await source.readIssuePlan(target.number);
  } catch (err) {
    return failure("issue_plan", target.number, err);
  }
  if (plan !== null) {
    targetSnapshot.issuePlan = ledger.field("target.issuePlan", plan);
  }

  const captured: RefinementSnapshotPredecessor[] = [];
  for (const entry of usable) {
    const issueNumber = entry.issue.number;
    const pr = entry.pullRequest;

    let pathListing: RefinementChangedPathListing;
    try {
      // One MORE than the cap is requested as a truncation probe: an adapter
      // that honours its documented limit returns exactly `cap` entries both
      // for a PR with `cap` paths and for one with a thousand, so at the cap
      // alone "complete" and "truncated" are indistinguishable and an
      // incomplete list would be recorded — and hashed — as complete. The
      // extra entry is never captured; it only moves the count past the cap.
      pathListing = asChangedPathListing(
        await source.readChangedPaths(pr.number, limits.maxChangedPathsPerPredecessor + 1),
      );
    } catch (err) {
      return failure("changed_paths", issueNumber, err);
    }
    const rawPaths = pathListing.paths;
    // Sorting fixes the ORDER of what was returned; it cannot fix WHICH paths
    // were returned. Past the cap the surviving subset is decided by the listing
    // itself, so a provider-ordered page would make the snapshot — and its
    // fingerprint — depend on that order while the PR's contents stood still.
    // Two listings have no such freedom: a canonically ordered one, whose first
    // `cap` entries are the PR's first `cap` paths whatever the source did, and
    // a declared-complete one, which chose no subset at all and so sorts and caps
    // to the same paths from any order. An over-cap listing that is neither is
    // refused here rather than captured non-deterministically.
    if (
      !pathListing.complete &&
      rawPaths.length > limits.maxChangedPathsPerPredecessor &&
      !pathsAreCanonical(rawPaths)
    ) {
      return failure(
        "changed_paths",
        issueNumber,
        new Error(
          `PR #${pr.number} returned ${rawPaths.length} changed paths past the ` +
            `${limits.maxChangedPathsPerPredecessor}-path cap in a non-canonical order; ` +
            `the source must order changed paths ascending by path or report the ` +
            `listing complete`,
        ),
      );
    }
    // The sorted order IS the capture order §6 hashes. The cap is re-applied
    // here so an adapter that ignored the limit cannot widen it.
    const sortedPaths = [...rawPaths].sort((a, b) => compareStrings(a.path, b.path));
    const changedPathsCapped = sortedPaths.length > limits.maxChangedPathsPerPredecessor;
    const changedPaths = sortedPaths
      .slice(0, limits.maxChangedPathsPerPredecessor)
      .map((c, i) => ({
        path: ledger.field(`predecessor.${issueNumber}.changedPath.${i}`, c.path),
        added: c.added,
        removed: c.removed,
      }));

    let rawComments: readonly RefinementCommentRead[];
    try {
      rawComments = await source.readIssueComments(issueNumber, limits.maxCommentsPerPredecessor);
    } catch (err) {
      return failure("comments", issueNumber, err);
    }
    // Most recent window, oldest first, deterministic under any adapter order.
    const comments = [...rawComments]
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0
          : a.createdAt < b.createdAt
            ? -1
            : 1,
      )
      // The cap is re-applied here so an adapter that ignored — or could not
      // honour — the limit cannot widen it. The window start is counted forward
      // rather than written `slice(-cap)`, because `slice(-0)` is `slice(0)`:
      // a zero cap would capture every comment the adapter returned, past a cap
      // §6's byte budget allots no comment bytes for at all.
      .slice(Math.max(rawComments.length - limits.maxCommentsPerPredecessor, 0))
      // The window is chosen on the RAW id — the value the source ordered by —
      // and bounded afterwards, so the bound cannot disturb which comments the
      // tie-break picks. Id and stamp are provider-controlled agent-visible text
      // and are charged like the PR identity strings: the id keys the body's
      // truncation record, so the bounded id is what that key is built from.
      .map((c, i) => {
        // Keyed by window position, not by the id: an id being truncated is
        // exactly the case where the id cannot name its own record.
        const commentId = ledger.identityField(
          `predecessor.${issueNumber}.comment.${i}.id`,
          c.id,
          REFINEMENT_MAX_COMMENT_IDENTITY_BYTES,
        );
        return {
          id: commentId,
          updatedAt: ledger.identityField(
            `predecessor.${issueNumber}.comment.${commentId}.updatedAt`,
            c.updatedAt,
            REFINEMENT_MAX_COMMENT_IDENTITY_BYTES,
          ),
          body: ledger.field(`predecessor.${issueNumber}.comment.${commentId}.body`, c.body),
        };
      });

    let review: RefinementReviewSummaryRead | null;
    try {
      review = await source.readReviewSummary(issueNumber);
    } catch (err) {
      return failure("review_summary", issueNumber, err);
    }

    // The PR identity strings are provider-controlled agent-visible text, so
    // they are bounded and charged to the ledger like every other captured
    // field — the published byte budget has to cover them or it is not a bound.
    const identity = (id: string, raw: string | undefined): string =>
      ledger.identityField(`predecessor.${issueNumber}.pr.${id}`, raw);
    const mergeCommitSha = pr.mergeCommitSha ? identity("mergeCommitSha", pr.mergeCommitSha) : "";

    // The state literals are stored text too — charged so the manifest's total is
    // the total §5 says it is (see {@link CaptureLedger.literal}).
    const disputeLineages = review?.disputeLineages
      ? canonicalDisputeLineages(review.disputeLineages).map((l) => ({
          state: ledger.literal(l.state),
          count: l.count,
        }))
      : null;

    captured.push({
      issueNumber,
      issueState: ledger.literal(entry.issue.state),
      title: ledger.field(`predecessor.${issueNumber}.title`, entry.issue.title),
      body: ledger.field(`predecessor.${issueNumber}.body`, entry.issue.body),
      stackReady: entry.stackReady,
      shape: ledger.literal(entry.shape),
      pullRequest: {
        number: pr.number,
        state: ledger.literal(entry.shape === "merged" ? "merged" : "open"),
        headRefName: identity("headRefName", pr.headRefName),
        headSha: identity("headSha", pr.headSha),
        mergeCommitSha: mergeCommitSha || null,
        title: ledger.field(`predecessor.${issueNumber}.pr.title`, pr.title),
        body: ledger.field(`predecessor.${issueNumber}.pr.body`, pr.body),
      },
      changedPaths,
      changedPathsCapped,
      reviewOutcome: review ? ledger.literal(review.outcome) : null,
      disputeLineages,
      comments,
    });
  }

  // ---- Re-verify identity: a predecessor that MOVED during capture holds ----
  // Capture is several reads long, and a predecessor can merge, re-open, or get
  // a new head SHA inside that window. A snapshot half-taken from before the
  // move and half from after would be internally inconsistent, and its
  // fingerprint would certify a state that never existed.
  const drifted: RefinementPredecessorHold[] = [];
  for (const entry of usable) {
    const issueNumber = entry.issue.number;
    let issue: RefinementIssueRead;
    let lookup: RefinementPullRequestLookup;
    try {
      issue = await source.readIssue(issueNumber);
    } catch (err) {
      return failure("issue", issueNumber, err);
    }
    try {
      lookup = await source.readPullRequest(issueNumber);
    } catch (err) {
      return failure("pull_request", issueNumber, err);
    }
    const verdict = classifyPredecessorUsability(issue, lookup, stackReadyLabel);
    if (verdict.kind === "unusable") {
      drifted.push({ ...verdict.hold, reason: "changed_during_capture", detail: verdict.hold.reason });
      continue;
    }
    if (!identitiesEqual(entry.identity, verdict.usable.identity)) {
      drifted.push({ issueNumber, reason: "changed_during_capture" });
    }
  }
  if (drifted.length > 0) {
    return {
      kind: "hold",
      reason: "predecessor_not_ready",
      predecessorIssueNumbers: predecessorNumbers,
      holds: drifted,
    };
  }

  // ---- Re-verify the predecessor SET, last, immediately before sealing -------
  // Which Issues are predecessors is an eligibility input exactly as their heads
  // are, and it was read once, at the top of a capture that is many reads long.
  // An edge added or removed inside that window would leave a `captured`
  // snapshot — and a fingerprint certifying it — that omits a direct predecessor
  // the refiner must see, or carries one the Issue no longer has. So the
  // relationship set is re-read here rather than at the top only, and the chain
  // cross-check is re-run against it.
  //
  // It goes last on purpose: the window it cannot cover is the one after its own
  // read, and putting it after the per-predecessor verification above leaves that
  // window as short as this module can make it. A difference holds (§12 row 4)
  // rather than re-capturing in place — the next poll re-reads everything from a
  // single consistent starting point, which is the same reason a moved head
  // holds. `predecessorIssueNumbers` stays the set this attempt was made
  // against, as it is for every other hold; the holds name what changed and in
  // which direction.
  let recheckedBlockedBy: readonly BlockedByEntry[];
  try {
    recheckedBlockedBy = await source.getBlockedBy(target.number);
  } catch (err) {
    return failure("blocked_by", target.number, err);
  }
  const setDrift = predecessorSetDrift(
    predecessorNumbers,
    directPredecessorNumbers(recheckedBlockedBy),
  );
  if (setDrift.length > 0) {
    return {
      kind: "hold",
      reason: "predecessor_not_ready",
      predecessorIssueNumbers: predecessorNumbers,
      holds: setDrift,
    };
  }
  // The set is unchanged, so the cross-check is re-run against the same numbers:
  // what can have moved is the chain's accepted revision, and a chain that has
  // since disagreed needs the human §4 row 6 sends it to, not a snapshot.
  const lateDisagreement = await checkChainAgreement(source, target.number, predecessorNumbers);
  if (lateDisagreement) return lateDisagreement;

  // The version tag and the fingerprint are stored text like every other field,
  // so they are charged before the manifest reads the total — which is why they
  // are computed here rather than inline in the object literal below.
  const version = ledger.literal(REFINEMENT_SNAPSHOT_VERSION);
  const predecessorFingerprint = ledger.literal(
    computePredecessorFingerprint(targetSnapshot, captured, laneLabels),
  );

  const snapshot: RefinementSnapshot = {
    version,
    target: targetSnapshot,
    predecessors: captured,
    manifest: {
      capturedAt: now,
      limits: { ...limits },
      truncatedFields: [...ledger.truncatedFields],
      totalTextBytes: ledger.totalTextBytes,
      maxTotalTextBytes: refinementSnapshotByteBudget(limits, captured.length),
      predecessorCount: captured.length,
    },
    predecessorFingerprint,
  };
  return { kind: "captured", snapshot };
}

/**
 * Project a captured snapshot into the §15 predecessor records the task context
 * persists — Issue numbers, PR numbers, head SHAs, and the state literal, and
 * nothing else. Prose, comments, and changed paths stay in the local artifact.
 */
export function refinementPredecessorRecords(
  snapshot: RefinementSnapshot,
): RefinementPredecessorRecord[] {
  return snapshot.predecessors.map((p) => ({
    issueNumber: p.issueNumber,
    prNumber: p.pullRequest.number,
    headSha: p.pullRequest.headSha,
    state: p.pullRequest.state,
  }));
}
