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
 *
 * **Declared predecessor contract evidence (issue #983, §5.1).** An Issue may
 * carry ONE fenced `refinement-evidence` block naming exact predecessor
 * files, exports, or line ranges; the capture resolves each selection against
 * the predecessor's authoritative commit — the head SHA of its stack-ready PR,
 * or its merge commit — through one more optional READ on the port, and places
 * the bounded, sanitized result (or a recorded omission) in the snapshot both
 * agents receive. A selection that cannot be captured never guesses: it is
 * stored as an `omitted` entry whose reason literal is exactly what the
 * `evidence_required` preflight of issue #1003 gates on, and no agent is
 * invoked here on its behalf. A snapshot with no declaration carries an empty
 * evidence list and HASHES byte-identically to a pre-#983 snapshot (see
 * {@link computePredecessorFingerprint}), so recorded fingerprints of
 * undeclared Issues do not move.
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
import {
  DEFAULT_DENY_GLOBS,
  matchEvidenceGlob,
  normalizeEvidencePath,
  parseEvidenceGlob,
} from "./repository-evidence.js";
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
 * One §5.1 evidence read: a single file at a single, explicit commit.
 *
 * The commit is chosen by the CORE, never by the adapter: it is the
 * predecessor's authoritative result under the stacked-branch contract — the
 * head commit SHA of its stack-ready PR for the `open_stack_ready` shape, the
 * merge commit SHA for `merged` — taken from the same identity §4 classified
 * usable and §15 persists. An adapter must read at exactly that commit; a
 * branch name is not an acceptable substitute, because a branch can move
 * between the identity check and the read.
 */
export interface RefinementEvidenceFileRequest {
  /** The predecessor Issue the selection names. */
  issueNumber: number;
  /** Its stack-ready PR, for adapters that resolve content through the PR. */
  prNumber: number;
  /** The PR's head ref name — context only; never an addressing substitute for the SHA. */
  headRefName: string;
  /** The exact commit to read at. The core verifies the echo below against this. */
  commitSha: string;
  /** Normalized repo-relative path, already shape-checked by the declaration parser. */
  path: string;
  /**
   * Read cap in UTF-8 bytes. The core asks for one more byte than it will
   * scan, so an adapter that honours the cap exactly still reveals
   * truncation; an adapter may return the whole file and the core re-bounds.
   */
  maxBytes: number;
}

/**
 * The three answers an evidence read can give without throwing.
 *
 * `missing_path` is a fact about the commit (no such file there), and
 * `unavailable` is a fact about the adapter's reach (a commit it cannot
 * resolve, a content form it cannot read) — both are recorded omissions, not
 * capture failures, because retrying cannot change them. A transient provider
 * failure is a THROW, never one of these: an unread file must not be recorded
 * as a missing one.
 *
 * `resolvedCommitSha` is the commit the content was actually read at. The core
 * refuses content whose echo differs from the request — an adapter that
 * resolved a branch name, a cache, or the wrong remote must fail closed rather
 * than smuggle in bytes from a commit §4 never certified.
 */
export type RefinementEvidenceFileLookup =
  | { kind: "found"; content: string; resolvedCommitSha: string }
  | { kind: "missing_path" }
  | { kind: "unavailable"; detail?: string };

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
   * §5.1 (issue #983), optional by design: read ONE file at ONE explicit
   * predecessor commit, for a declared evidence selection. Absent means "no
   * evidence resolver wired", which records every declared selection as an
   * `resolver_unavailable` omission rather than failing the capture — the
   * same landable-without-the-adapter seam `readChainAgreement` uses. Throws
   * only on a transient provider failure.
   */
  readPredecessorEvidence?(
    request: RefinementEvidenceFileRequest,
  ): Promise<RefinementEvidenceFileLookup>;
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

// ---------------------------------------------------------------------------
// §5.1 declared predecessor contract evidence (issue #983)
// ---------------------------------------------------------------------------

/** The info string of the one operator-authored declaration block §5.1 reads. */
export const REFINEMENT_EVIDENCE_BLOCK_TAG = "refinement-evidence";

/**
 * §5.1 bound on the number of evidence entries a snapshot records.
 *
 * A snapshot-local constant for the reason the label caps are: it is a floor
 * of the capture itself, far above any legitimate declaration, so a hostile
 * body listing ten thousand selections cannot mint ten thousand snapshot
 * entries. Selections past it are represented by ONE `selection_capped`
 * omission naming the declared total — recorded, never silently dropped.
 */
export const REFINEMENT_MAX_EVIDENCE_SELECTIONS = 8;

/**
 * §5.1 bound on how much of a source file the capture will scan, chosen to
 * match the read-request scan cap of the repository-evidence resolver
 * (issue #806). A selection is extracted from at most this many bytes; an
 * export or line range that lies wholly past it is an omission that SAYS the
 * source was truncated, never a partial capture presented as exact.
 */
export const REFINEMENT_MAX_EVIDENCE_SOURCE_BYTES = 262_144;

/**
 * §5.1 bound for a selection's stored path, sized so a path the declaration
 * parser admitted (at most `PATH_MAX_LENGTH` = 1024 UTF-16 code units, so at
 * most 4096 UTF-8 bytes) is never cut — a truncated path is not a shorter
 * path, it is a wrong one. Bounded and charged like the PR identity strings,
 * for the same reason: it is operator-controlled agent-visible text.
 */
export const REFINEMENT_MAX_EVIDENCE_PATH_BYTES = 4_096;

/** §5.1 bound for an export name, in UTF-16 code units; enforced at parse. */
export const REFINEMENT_MAX_EVIDENCE_EXPORT_CHARS = 128;

/**
 * Why one declared selection is not in the captured evidence (§5.1).
 *
 * Every reason is decided deterministically at capture, without invoking any
 * agent; the set is CLOSED because issue #1003's `evidence_required` preflight
 * dispositions on these literals. The first three are declaration facts, the
 * middle four are resolution facts, and the last three are selection facts
 * about the file that was actually read.
 */
export const REFINEMENT_EVIDENCE_OMISSION_REASONS = [
  "malformed_declaration",
  "invalid_selection",
  "denied_path",
  "selection_capped",
  "unknown_predecessor",
  "resolver_unavailable",
  "source_unavailable",
  "missing_path",
  "identity_mismatch",
  "export_not_found",
  "line_range_out_of_bounds",
] as const;
export type RefinementEvidenceOmissionReason =
  (typeof REFINEMENT_EVIDENCE_OMISSION_REASONS)[number];

/** One parsed §5.1 selection: which predecessor, which file, which slice of it. */
export interface RefinementEvidenceSelector {
  /** The predecessor Issue whose authoritative branch the content must come from. */
  issueNumber: number;
  /** Normalized repo-relative path. */
  path: string;
  /** Exactly one of these two refines the selection; both `null` selects the whole file. */
  exportName: string | null;
  lines: { start: number; end: number } | null;
  /** Operator-declared per-selection byte cap; the §8 prose cap still applies on top. */
  maxBytes: number | null;
  /**
   * §5.2: whether the refinement may proceed without this evidence.
   *
   * `true` unless the declaration says `"required": false`, because an Issue
   * that names a predecessor's exported contract is asserting that its own
   * contract depends on it — the whole point of §5.1 — and a default of
   * "optional" would let exactly the #951 failure through under a declaration
   * that looks like it prevented it. An entry marked optional is captured when
   * it can be and recorded as an omission when it cannot, and never stops the
   * lane; issue #1003's preflight reads this field and nothing else to tell the
   * two apart.
   */
  required: boolean;
}

/**
 * §5.1 immutable provenance: where captured evidence came from, pinned to the
 * predecessor identity §4 certified — never to a branch name alone.
 */
export interface RefinementEvidenceProvenance {
  issueNumber: number;
  prNumber: number;
  shape: RefinementPredecessorShape;
  /** Bounded by {@link REFINEMENT_MAX_PR_IDENTITY_BYTES} — provider text like any other. */
  headRefName: string;
  /** The exact commit the content was read at: head SHA (open) or merge commit SHA (merged). */
  commitSha: string;
}

/**
 * One §5.1 evidence entry, captured or omitted — the snapshot records BOTH,
 * in declaration order, so the refiner, the critic, and issue #1003's
 * preflight all see the same account of what was asked for and what
 * happened to it. Content is bounded, sanitized, and hashed exactly like
 * every other captured text field.
 */
export interface RefinementSnapshotEvidence {
  /** 0-based position in the declaration — the declaration order IS the §5.1 capture order. */
  index: number;
  /** `null` only when the declaration itself could not name a selection (malformed / capped). */
  selector: RefinementEvidenceSelector | null;
  status: "captured" | "omitted";
  omissionReason: RefinementEvidenceOmissionReason | null;
  /** A literal-only elaboration, or a sanitized adapter detail. Bounded prose. */
  detail: string | null;
  /** Present once the selection resolved to a usable predecessor, captured or not. */
  source: RefinementEvidenceProvenance | null;
  /** The bounded, sanitized selection content; `null` when omitted. */
  content: string | null;
  /** The byte cap the content was bounded to; `null` when omitted. */
  maxBytesApplied: number | null;
  /** True when content was cut — by its cap, or by the source scan bound for a whole-file selection. */
  truncated: boolean;
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
  /** The provable upper bound for this predecessor and evidence count (see {@link refinementSnapshotByteBudget}). */
  maxTotalTextBytes: number;
  predecessorCount: number;
  /** §5.1: entries recorded in {@link RefinementSnapshot.evidence}, captured and omitted alike. */
  evidenceCount: number;
}

export interface RefinementSnapshot {
  version: typeof REFINEMENT_SNAPSHOT_VERSION;
  target: RefinementSnapshotTarget;
  /** Ascending Issue number (§5, §6). */
  predecessors: RefinementSnapshotPredecessor[];
  /** §5.1 declared evidence in declaration order; empty when the body declares none. */
  evidence: RefinementSnapshotEvidence[];
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
  | "issue_plan"
  | "evidence";

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
const EVIDENCE_STATUS_VOCABULARY: Record<RefinementSnapshotEvidence["status"], null> = {
  captured: null,
  omitted: null,
};
// Derived from the closed reason list, like the lineage states above.
const EVIDENCE_OMISSION_VOCABULARY: Record<RefinementEvidenceOmissionReason, null> =
  Object.fromEntries(REFINEMENT_EVIDENCE_OMISSION_REASONS.map((r) => [r, null] as const)) as Record<
    RefinementEvidenceOmissionReason,
    null
  >;

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
 * One §5.1 evidence entry's literals: its status, at most one omission
 * reason, and at most one provenance shape literal.
 */
const REFINEMENT_EVIDENCE_LITERAL_BYTES =
  longestLiteral(EVIDENCE_STATUS_VOCABULARY) +
  longestLiteral(EVIDENCE_OMISSION_VOCABULARY) +
  longestLiteral(PREDECESSOR_SHAPE_VOCABULARY);

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
 *
 * Each §5.1 evidence entry (issue #983) contributes its own term: two
 * prose-capped fields (content and detail — no entry carries both at once, so
 * this over-counts, which a bound may), its path at
 * {@link REFINEMENT_MAX_EVIDENCE_PATH_BYTES}, three identity strings (export
 * name, head ref name, commit SHA) at {@link REFINEMENT_MAX_PR_IDENTITY_BYTES}
 * each, and its literals. `evidenceCount` defaults to zero so every pre-#983
 * caller and every undeclared snapshot publishes the bound it always did.
 */
export function refinementSnapshotByteBudget(
  limits: IssueRefinementLimits,
  predecessorCount: number,
  evidenceCount = 0,
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
  const evidenceBytes =
    evidenceCount *
    (2 * limits.maxSnapshotTextBytes +
      REFINEMENT_MAX_EVIDENCE_PATH_BYTES +
      3 * REFINEMENT_MAX_PR_IDENTITY_BYTES +
      REFINEMENT_EVIDENCE_LITERAL_BYTES);
  return (
    limits.maxSnapshotTextBytes * (4 + predecessorCount * perPredecessor) +
    labelBytes +
    identityBytes +
    literalBytes +
    evidenceBytes
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
// §5.1 the evidence declaration and its selectors (issue #983)
// ---------------------------------------------------------------------------

/** One §5.1 declaration entry after parsing: a usable selector, or why not. */
export type RefinementEvidenceParsedEntry =
  | { kind: "valid"; index: number; selector: RefinementEvidenceSelector }
  | {
      kind: "invalid";
      index: number;
      reason: Extract<RefinementEvidenceOmissionReason, "invalid_selection" | "denied_path">;
      /** A parser literal (`unknown_key`, `bad_path`, …), never operator prose. */
      detail: string;
    };

/**
 * The whole declaration: absent, malformed as a unit, or entry-by-entry.
 *
 * `malformed` is deliberately all-or-nothing — an unterminated block, a second
 * block, or a body that is not a JSON array leaves no principled way to say
 * WHICH selections the operator meant, and guessing a subset would capture
 * evidence the declaration never deterministically named.
 */
export type RefinementEvidenceDeclarationParse =
  | { kind: "none" }
  | { kind: "malformed"; detail: string }
  | { kind: "declared"; entries: RefinementEvidenceParsedEntry[] };

const EVIDENCE_ENTRY_KEYS = new Set([
  "issue",
  "path",
  "export",
  "lines",
  "maxBytes",
  "required",
]);

// The deny floor of the repository-evidence resolver (issue #806), parsed once:
// the same secret-shaped paths its read operation refuses are refused here, so
// a snapshot cannot expose what an evidence turn could not. The globs are code
// constants; a hypothetical unparsable one is skipped rather than silently
// admitting everything (parse failures are its module's tests' concern).
const EVIDENCE_DENY_GLOBS: string[][] = DEFAULT_DENY_GLOBS.flatMap((glob) => {
  const parsed = parseEvidenceGlob(glob);
  return parsed.ok ? [parsed.segments] : [];
});

function evidenceDenied(rel: string): boolean {
  const lower = rel.toLowerCase();
  return EVIDENCE_DENY_GLOBS.some((segments) => matchEvidenceGlob(segments, lower));
}

function parseEvidenceEntry(value: unknown, index: number): RefinementEvidenceParsedEntry {
  const invalid = (
    detail: string,
    reason: "invalid_selection" | "denied_path" = "invalid_selection",
  ): RefinementEvidenceParsedEntry => ({ kind: "invalid", index, reason, detail });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("not_an_object");
  }
  const rec = value as Record<string, unknown>;
  // The schema is closed, like every agent-facing schema in this lane: an
  // unknown key is a selection this parser would silently half-honour, and a
  // half-honoured selection is not deterministic from the operator's view.
  for (const key of Object.keys(rec)) {
    if (!EVIDENCE_ENTRY_KEYS.has(key)) return invalid("unknown_key");
  }
  const issue = rec["issue"];
  if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue <= 0) {
    return invalid("bad_issue");
  }
  const pathRaw = rec["path"];
  if (typeof pathRaw !== "string") return invalid("bad_path");
  const norm = normalizeEvidencePath(pathRaw);
  if (!norm.ok || norm.rel === "") return invalid("bad_path");
  if (evidenceDenied(norm.rel)) return invalid("deny_floor", "denied_path");
  let exportName: string | null = null;
  if (rec["export"] !== undefined) {
    const e = rec["export"];
    if (
      typeof e !== "string" ||
      e.length > REFINEMENT_MAX_EVIDENCE_EXPORT_CHARS ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(e)
    ) {
      return invalid("bad_export");
    }
    exportName = e;
  }
  let lines: { start: number; end: number } | null = null;
  if (rec["lines"] !== undefined) {
    const l = rec["lines"];
    const pair = Array.isArray(l) && l.length === 2 ? l : null;
    const start = pair?.[0];
    const end = pair?.[1];
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start
    ) {
      return invalid("bad_lines");
    }
    lines = { start, end };
  }
  if (exportName !== null && lines !== null) return invalid("conflicting_selectors");
  let maxBytes: number | null = null;
  if (rec["maxBytes"] !== undefined) {
    const m = rec["maxBytes"];
    // Zero is rejected like the §8 zero-rejections are: a zero-byte selection
    // has no next action that is not better spelled by omitting the entry.
    if (typeof m !== "number" || !Number.isSafeInteger(m) || m < 1) {
      return invalid("bad_max_bytes");
    }
    maxBytes = m;
  }
  // §5.2: only the literal `false` opts a selection out of the required-evidence
  // preflight. Anything else — a string "false", a 0, a null — is a declaration
  // this parser would have to interpret, and an interpreted requirement is not
  // an explicit one.
  let required = true;
  if (rec["required"] !== undefined) {
    const r = rec["required"];
    if (typeof r !== "boolean") return invalid("bad_required");
    required = r;
  }
  return {
    kind: "valid",
    index,
    selector: { issueNumber: issue, path: norm.rel, exportName, lines, maxBytes, required },
  };
}

/**
 * One line of a Markdown code fence: up to three spaces of indent, a run of
 * three or more backticks or tildes, then the info string. A backtick fence's
 * info string may not itself contain a backtick (CommonMark) — such a line is
 * ordinary text, not a fence.
 */
function parseMarkdownFenceLine(
  line: string,
): { char: "`" | "~"; length: number; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return null;
  const marker = match[1]!;
  const char = marker[0] === "`" ? ("`" as const) : ("~" as const);
  const info = match[2]!;
  if (char === "`" && info.includes("`")) return null;
  return { char, length: marker.length, info: info.trim() };
}

/**
 * Parse the §5.1 declaration out of the target's SOURCE body — the operator's
 * own text, with the lane-written managed region already elided, so the lane
 * cannot declare evidence to itself. The FULL source body is scanned, not the
 * bounded snapshot copy: a declaration near the end of a long body must not
 * stop parsing because the body's snapshot copy was truncated.
 *
 * Exported for issue #1003, whose `evidence_required` preflight must see the
 * same declaration this capture sees, parsed the same way.
 */
export function parseRefinementEvidenceDeclaration(
  sourceBody: string,
): RefinementEvidenceDeclarationParse {
  const blocks: string[][] = [];
  // Markdown fences do not nest, so one open fence is tracked at a time. A
  // `refinement-evidence` opener inside some OTHER fence (an example quoted in
  // a ````markdown block, say) is literal text, not a live declaration, and a
  // fence only closes on a same-character fence at least as long as its opener
  // — so a triple-backtick line inside a four-backtick block stays content.
  let fence: { char: "`" | "~"; length: number; evidence: string[] | null } | null = null;
  for (const line of sourceBody.split(/\r?\n/)) {
    const parsed = parseMarkdownFenceLine(line);
    if (fence === null) {
      if (parsed !== null) {
        fence = {
          char: parsed.char,
          length: parsed.length,
          evidence:
            parsed.char === "`" && parsed.info === REFINEMENT_EVIDENCE_BLOCK_TAG ? [] : null,
        };
      }
      continue;
    }
    if (
      parsed !== null &&
      parsed.char === fence.char &&
      parsed.length >= fence.length &&
      parsed.info === ""
    ) {
      if (fence.evidence !== null) blocks.push(fence.evidence);
      fence = null;
    } else if (fence.evidence !== null) {
      fence.evidence.push(line);
    }
  }
  // An unterminated evidence fence is one ambiguity the operator must resolve.
  // An unterminated OTHER fence just runs to the end of the body, exactly as
  // Markdown renders it, and everything inside it stayed literal.
  if (fence !== null && fence.evidence !== null) {
    return { kind: "malformed", detail: "unterminated_block" };
  }
  if (blocks.length === 0) return { kind: "none" };
  // Two blocks are one ambiguity, not two declarations: there is no rule that
  // could deterministically say which one is authoritative.
  if (blocks.length > 1) return { kind: "malformed", detail: "multiple_blocks" };
  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0]!.join("\n"));
  } catch {
    return { kind: "malformed", detail: "invalid_json" };
  }
  if (!Array.isArray(raw)) return { kind: "malformed", detail: "not_an_array" };
  return { kind: "declared", entries: raw.map((value, index) => parseEvidenceEntry(value, index)) };
}

type LexMode = "code" | "block_comment" | "single" | "double" | "template";

/**
 * Lexer state threaded across lines. `templateExpr` has one counter per
 * enclosing template-literal `${…}` expression, innermost last, holding the
 * unmatched `{` opened inside that expression — so a nested template's closing
 * backtick resumes the expression, not top-level code, and only the `}` that
 * balances a `${` resumes its template. "code" mode with a non-empty stack is
 * still lexically inside a template literal.
 */
interface LexState {
  mode: LexMode;
  templateExpr: number[];
}

/**
 * One non-whitespace character consumed in code position: its column, and
 * whether the lexer was settled — "code" mode, no open template expression,
 * bracket depth at zero — immediately AFTER consuming it. Only a settled `;`
 * or `}` can terminate a declaration, and its column is where the capture
 * must stop.
 */
interface LexCodeChar {
  index: number;
  char: string;
  settled: boolean;
}

/**
 * Advance the extractor's lexer across one line: skip comment and string
 * bodies, and (when `track` is given) count bracket depth and record each
 * code character as a {@link LexCodeChar} in `track.codeChars`. Mutates
 * `state` to where the next line begins.
 */
function lexLine(
  line: string,
  state: LexState,
  track: { depth: number; codeChars: LexCodeChar[] } | null,
): void {
  for (let j = 0; j < line.length; j++) {
    const ch = line[j]!;
    const next = line[j + 1];
    if (state.mode === "block_comment") {
      if (ch === "*" && next === "/") {
        state.mode = "code";
        j++;
      }
      continue;
    }
    if (state.mode === "single" || state.mode === "double" || state.mode === "template") {
      if (ch === "\\") {
        j++;
      } else if (state.mode === "template" && ch === "$" && next === "{") {
        state.templateExpr.push(0);
        state.mode = "code";
        j++;
      } else if (
        (state.mode === "single" && ch === "'") ||
        (state.mode === "double" && ch === '"') ||
        (state.mode === "template" && ch === "`")
      ) {
        state.mode = "code";
      }
      continue;
    }
    // state.mode === "code"
    if (ch === "/" && next === "/") break; // rest of the line is a comment
    if (ch === "/" && next === "*") {
      state.mode = "block_comment";
      j++;
      continue;
    }
    if (ch === "'") state.mode = "single";
    else if (ch === '"') state.mode = "double";
    else if (ch === "`") state.mode = "template";
    else if (
      ch === "}" &&
      state.templateExpr.length > 0 &&
      state.templateExpr[state.templateExpr.length - 1] === 0
    ) {
      // This `}` balances a `${`, not a block: the interrupted template
      // resumes. Its `{` was consumed in template mode and never counted, so
      // `track.depth` stays untouched here too.
      state.templateExpr.pop();
      state.mode = "template";
      continue;
    } else {
      if (state.templateExpr.length > 0) {
        if (ch === "{") state.templateExpr[state.templateExpr.length - 1]!++;
        else if (ch === "}") state.templateExpr[state.templateExpr.length - 1]!--;
      }
      if (track !== null) {
        if (ch === "{" || ch === "(" || ch === "[") track.depth++;
        else if (ch === "}" || ch === ")" || ch === "]") track.depth--;
      }
    }
    if (track !== null && !/\s/.test(ch)) {
      track.codeChars.push({
        index: j,
        char: ch,
        settled: state.mode === "code" && state.templateExpr.length === 0 && track.depth <= 0,
      });
    }
  }
}

/**
 * Extract one exported declaration from TypeScript/JavaScript source, by name,
 * deterministically: the same bytes in always yield the same bytes out.
 *
 * This is a bounded lexical scan, not a parser. It finds the first line that
 * both begins outside comments and strings and opens an `export`ed declaration
 * of the name (const/let/var/function/
 * class/interface/type/enum, with the usual modifiers), then accumulates
 * source up to the declaration's own terminator: the first `;`, or the first
 * `}` not continued by a union/intersection/member token, reached with every
 * brace/bracket/paren opened outside strings and comments closed. The capture
 * ends AT that terminator, so a second statement sharing its physical line —
 * which may be source the Issue never selected — is never captured with the
 * declaration. That covers the declaration
 * shapes this repository writes — the #950/#951 failure this section exists
 * for was an exported selector result type — and a source whose shape defeats
 * the scan yields `null` (an `export_not_found` omission), never a partial
 * slice presented as the declaration.
 */
export function extractExportedDeclaration(source: string, exportName: string): string | null {
  // The name was validated as an identifier at parse; the lookahead replaces
  // `\b` because `$` is not a word character and may legally end the name.
  const escaped = exportName.replace(/\$/g, "\\$");
  const startRe = new RegExp(
    "^\\s*export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?" +
      "(?:const\\s+enum\\s+|const\\s+|let\\s+|var\\s+|function\\s*\\*?\\s*|class\\s+|interface\\s+|type\\s+|enum\\s+)" +
      escaped +
      "(?![A-Za-z0-9_$])",
  );
  const lines = source.split("\n");
  // The start line must itself BEGIN in code: a documentation comment or a
  // multiline template literal can quote `export type …` at column zero, and
  // matching there would capture prose as the authoritative declaration. The
  // pre-scan advances the same lexer over every earlier line so the regex is
  // only consulted where a declaration could actually occur.
  const pre: LexState = { mode: "code", templateExpr: [] };
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (pre.mode === "code" && pre.templateExpr.length === 0 && startRe.test(lines[i]!)) {
      start = i;
      break;
    }
    lexLine(lines[i]!, pre, null);
  }
  if (start === -1) return null;

  const state: LexState = { mode: "code", templateExpr: [] };
  const track: { depth: number; codeChars: LexCodeChar[] } = { depth: 0, codeChars: [] };
  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    track.codeChars = [];
    lexLine(line, state, track);
    for (let c = 0; c < track.codeChars.length; c++) {
      const cc = track.codeChars[c]!;
      if (!cc.settled || (cc.char !== ";" && cc.char !== "}")) continue;
      if (cc.char === ";") {
        // The declaration's own statement terminator: the capture ends AT it,
        // so a second statement sharing the physical line — source the Issue
        // never selected — does not ride into the evidence.
        collected.push(line.slice(0, cc.index + 1));
        return collected.join("\n");
      }
      // A balanced `}`. A union or intersection member can end balanced
      // (`| { … }`) with the declaration still open — the very shape the #950
      // selector result type has — so the declaration continues while the next
      // code character (rest of this line, else the next non-blank line) is a
      // continuation token. A `;` next is the declaration's own terminator:
      // scanning on lets the `;` arm above end the capture at it.
      const next = track.codeChars[c + 1];
      if (next !== undefined) {
        if (next.char === "|" || next.char === "&" || next.char === "." || next.char === ";") {
          continue;
        }
        collected.push(line.slice(0, cc.index + 1));
        return collected.join("\n");
      }
      let k = i + 1;
      while (k < lines.length && lines[k]!.trim() === "") k++;
      if (k >= lines.length || !/^[|&.]/.test(lines[k]!.trim())) {
        collected.push(line.slice(0, cc.index + 1));
        return collected.join("\n");
      }
    }
    collected.push(line);
  }
  // Never terminated: truncated source or a shape the scan cannot bound. An
  // incomplete declaration must not be captured as if it were exact.
  return null;
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
 *
 * §5.1 evidence is hashed IN FULL — every entry, captured or omitted, with its
 * selector, provenance, content digest, and truncation flag — because every
 * one of those fields is agent-visible input, and §6's one-to-one rule admits
 * no exception for it. The evidence part is appended ONLY when at least one
 * entry exists: an empty evidence list serializes byte-identically to a
 * pre-#983 snapshot, so recorded fingerprints of Issues that declare nothing —
 * including every fingerprint embedded in a live managed-region marker — do
 * not move, and the lane does not burn its one stale restart on a code deploy.
 */
export function computePredecessorFingerprint(
  target: RefinementSnapshotTarget,
  predecessors: readonly RefinementSnapshotPredecessor[],
  laneLabels: RefinementLabels,
  evidence: readonly RefinementSnapshotEvidence[] = [],
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

  const parts: unknown[] = [
    REFINEMENT_SNAPSHOT_VERSION,
    targetDigest,
    // Qualifies the label set inside `targetDigest`, for the same reason
    // `changedPathsCapped` is hashed above.
    target.labelsCapped,
    target.issuePlan === null ? "absent" : sha256(target.issuePlan),
    predecessorParts,
  ];
  if (evidence.length > 0) {
    parts.push(
      evidence.map((e) => [
        e.index,
        e.selector === null
          ? "absent"
          : [
              e.selector.issueNumber,
              e.selector.path,
              e.selector.exportName ?? "absent",
              e.selector.lines === null ? "absent" : [e.selector.lines.start, e.selector.lines.end],
              e.selector.maxBytes ?? "absent",
              // §5.2 requiredness is a declared input like every other selector
              // field: flipping a selection from optional to required changes
              // what the lane does with the same bytes, and §6 admits no
              // unhashed input. Only DECLARING Issues are affected — a body
              // that declares nothing still hashes the pre-evidence
              // serialization, so no live managed-region fingerprint moves.
              e.selector.required,
            ],
        e.status,
        e.omissionReason ?? "absent",
        e.detail === null ? "absent" : sha256(e.detail),
        e.source === null
          ? "absent"
          : [
              e.source.issueNumber,
              e.source.prNumber,
              e.source.shape,
              e.source.headRefName,
              e.source.commitSha,
            ],
        e.content === null ? "absent" : sha256(e.content),
        e.maxBytesApplied ?? "absent",
        // Hashed for the reason `changedPathsCapped` is: a source file that
        // grows past a cap leaves the CAPTURED bytes identical while this flips.
        e.truncated,
      ]),
    );
  }
  return sha256(JSON.stringify(parts));
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

// ---------------------------------------------------------------------------
// §5.1 evidence capture (issue #983)
// ---------------------------------------------------------------------------

/**
 * Bound and charge a selector's operator-controlled strings. The path has its
 * own cap ({@link REFINEMENT_MAX_EVIDENCE_PATH_BYTES}) and the export name
 * rides the PR identity cap — both far above what the parser admits, so a
 * value that reaches here is never actually cut; the charge is what matters.
 */
function chargeEvidenceSelector(
  ledger: CaptureLedger,
  index: number,
  selector: RefinementEvidenceSelector,
): RefinementEvidenceSelector {
  return {
    issueNumber: selector.issueNumber,
    path: ledger.identityField(
      `evidence.${index}.selector.path`,
      selector.path,
      REFINEMENT_MAX_EVIDENCE_PATH_BYTES,
    ),
    exportName:
      selector.exportName === null
        ? null
        : ledger.identityField(`evidence.${index}.selector.export`, selector.exportName),
    lines: selector.lines === null ? null : { ...selector.lines },
    maxBytes: selector.maxBytes,
    required: selector.required,
  };
}

/** Bound and charge one entry's provenance strings, like the PR identity strings they mirror. */
function chargeEvidenceProvenance(
  ledger: CaptureLedger,
  index: number,
  source: RefinementEvidenceProvenance,
): RefinementEvidenceProvenance {
  return {
    issueNumber: source.issueNumber,
    prNumber: source.prNumber,
    shape: ledger.literal(source.shape),
    headRefName: ledger.identityField(`evidence.${index}.source.headRefName`, source.headRefName),
    commitSha: ledger.identityField(`evidence.${index}.source.commitSha`, source.commitSha),
  };
}

/** One omitted §5.1 entry, its literals charged where they are stored. */
function omittedEvidence(
  ledger: CaptureLedger,
  index: number,
  selector: RefinementEvidenceSelector | null,
  reason: RefinementEvidenceOmissionReason,
  detail: string | null,
  source: RefinementEvidenceProvenance | null,
): RefinementSnapshotEvidence {
  return {
    index,
    selector: selector === null ? null : chargeEvidenceSelector(ledger, index, selector),
    status: ledger.literal("omitted"),
    omissionReason: ledger.literal(reason),
    detail: detail === null ? null : ledger.field(`evidence.${index}.detail`, detail),
    source: source === null ? null : chargeEvidenceProvenance(ledger, index, source),
    content: null,
    maxBytesApplied: null,
    truncated: false,
  };
}

/**
 * Resolve the §5.1 declaration against the usable predecessor set, in
 * declaration order.
 *
 * Runs AFTER every predecessor was captured and BEFORE their identities are
 * re-verified, so a predecessor whose head moves while its file is being read
 * invalidates the whole attempt (the existing drift hold) rather than leaving
 * evidence from a commit the sealed snapshot no longer certifies. Only a
 * THROWN read fails the capture; every deterministic disappointment — an
 * unknown predecessor, a missing path, an export the file does not have — is
 * recorded as an omission for issue #1003 to disposition, because re-reading
 * cannot change it and inventing content would be worse.
 */
async function captureDeclaredEvidence(
  source: RefinementSnapshotSource,
  sourceBody: string,
  usable: readonly RefinementUsablePredecessor[],
  limits: IssueRefinementLimits,
  ledger: CaptureLedger,
): Promise<
  | { evidence: RefinementSnapshotEvidence[] }
  | Extract<RefinementSnapshotResult, { kind: "failed" }>
> {
  const declaration = parseRefinementEvidenceDeclaration(sourceBody);
  if (declaration.kind === "none") return { evidence: [] };
  if (declaration.kind === "malformed") {
    return {
      evidence: [omittedEvidence(ledger, 0, null, "malformed_declaration", declaration.detail, null)],
    };
  }

  const byIssue = new Map(usable.map((u) => [u.issue.number, u] as const));
  const evidence: RefinementSnapshotEvidence[] = [];
  for (const entry of declaration.entries.slice(0, REFINEMENT_MAX_EVIDENCE_SELECTIONS)) {
    if (entry.kind === "invalid") {
      evidence.push(omittedEvidence(ledger, entry.index, null, entry.reason, entry.detail, null));
      continue;
    }
    const selector = entry.selector;
    const predecessor = byIssue.get(selector.issueNumber);
    if (!predecessor) {
      // Not one of the target's direct, usable predecessors. §5.1 resolves
      // evidence ONLY from the authoritative predecessor set the relationship
      // edges selected — any other Issue's branch is unselected repository
      // content, however plausible the number looks.
      evidence.push(
        omittedEvidence(ledger, entry.index, selector, "unknown_predecessor", null, null),
      );
      continue;
    }
    const identity = predecessor.identity;
    const provenance: RefinementEvidenceProvenance = {
      issueNumber: predecessor.issue.number,
      prNumber: identity.prNumber,
      shape: predecessor.shape,
      headRefName: identity.headRefName,
      // The authoritative commit of the stacked-branch contract: the merge
      // commit once merged, the stack-ready PR head while open.
      commitSha: predecessor.shape === "merged" ? identity.mergeCommitSha : identity.headSha,
    };
    if (!source.readPredecessorEvidence) {
      evidence.push(
        omittedEvidence(ledger, entry.index, selector, "resolver_unavailable", null, provenance),
      );
      continue;
    }

    let lookup: RefinementEvidenceFileLookup;
    try {
      lookup = await source.readPredecessorEvidence({
        issueNumber: provenance.issueNumber,
        prNumber: provenance.prNumber,
        headRefName: provenance.headRefName,
        commitSha: provenance.commitSha,
        path: selector.path,
        // One more than the scan bound, as a truncation probe (see the
        // changed-path read for why the cap alone cannot reveal truncation).
        maxBytes: REFINEMENT_MAX_EVIDENCE_SOURCE_BYTES + 1,
      });
    } catch (err) {
      return failure("evidence", selector.issueNumber, err);
    }
    if (lookup.kind === "missing_path") {
      evidence.push(
        omittedEvidence(ledger, entry.index, selector, "missing_path", null, provenance),
      );
      continue;
    }
    if (lookup.kind === "unavailable") {
      evidence.push(
        omittedEvidence(
          ledger,
          entry.index,
          selector,
          "source_unavailable",
          lookup.detail ?? null,
          provenance,
        ),
      );
      continue;
    }
    if (lookup.resolvedCommitSha !== provenance.commitSha) {
      // The adapter read SOMETHING, but not the commit §4 certified. Content
      // from a moved branch, a cache, or the wrong remote must not enter a
      // snapshot whose provenance claims otherwise.
      evidence.push(
        omittedEvidence(
          ledger,
          entry.index,
          selector,
          "identity_mismatch",
          `expected=${provenance.commitSha} resolved=${lookup.resolvedCommitSha}`,
          provenance,
        ),
      );
      continue;
    }

    const sourceTruncated =
      byteLength(lookup.content) > REFINEMENT_MAX_EVIDENCE_SOURCE_BYTES;
    const scan = boundSnapshotText(lookup.content, REFINEMENT_MAX_EVIDENCE_SOURCE_BYTES).text;
    let raw: string | null = null;
    let omission: RefinementEvidenceOmissionReason | null = null;
    let detail: string | null = null;
    if (selector.exportName !== null) {
      raw = extractExportedDeclaration(scan, selector.exportName);
      if (raw === null) {
        omission = "export_not_found";
        detail = sourceTruncated ? "source_truncated" : null;
      }
    } else if (selector.lines !== null) {
      // Split on `\n` alone so a CRLF file's bytes survive unaltered — line
      // COUNTS agree either way, and the captured bytes stay the file's own.
      const sourceLines = scan.split("\n");
      // When the byte-capped scan ended mid-file, its final element is not
      // known to be a whole source line: a range that reaches it was not fully
      // read, and must be an omission rather than a capture presented as exact.
      const fullLines = sourceTruncated ? sourceLines.length - 1 : sourceLines.length;
      if (selector.lines.end > fullLines) {
        omission = "line_range_out_of_bounds";
        detail = sourceTruncated ? "source_truncated" : `lines=${sourceLines.length}`;
      } else {
        raw = sourceLines.slice(selector.lines.start - 1, selector.lines.end).join("\n");
      }
    } else {
      raw = scan;
    }
    if (omission !== null || raw === null) {
      evidence.push(
        omittedEvidence(
          ledger,
          entry.index,
          selector,
          omission ?? "invalid_selection",
          detail,
          provenance,
        ),
      );
      continue;
    }

    // The operator's cap can only LOWER the §8 prose cap, never widen it.
    const cap = Math.min(
      selector.maxBytes ?? limits.maxSnapshotTextBytes,
      limits.maxSnapshotTextBytes,
    );
    const prepared = ledger.prepare(raw, cap);
    const wholeFile = selector.exportName === null && selector.lines === null;
    const truncated = prepared.truncated || (wholeFile && sourceTruncated);
    evidence.push({
      index: entry.index,
      selector: chargeEvidenceSelector(ledger, entry.index, selector),
      status: ledger.literal("captured"),
      omissionReason: null,
      detail: null,
      source: chargeEvidenceProvenance(ledger, entry.index, provenance),
      content: ledger.commit(`evidence.${entry.index}.content`, {
        text: prepared.text,
        truncated,
      }),
      maxBytesApplied: cap,
      truncated,
    });
  }
  if (declaration.entries.length > REFINEMENT_MAX_EVIDENCE_SELECTIONS) {
    // Recorded, never silently dropped: one entry says how much was declared,
    // so the operator sees the cut and #1003 can refuse to proceed on it.
    evidence.push(
      omittedEvidence(
        ledger,
        REFINEMENT_MAX_EVIDENCE_SELECTIONS,
        null,
        "selection_capped",
        `declared=${declaration.entries.length}`,
        null,
      ),
    );
  }
  return { evidence };
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

  // ---- §5.1 declared predecessor contract evidence (issue #983) -------------
  // After the predecessors are captured (the declaration resolves against
  // their certified identities) and before those identities are re-verified,
  // so a head that moves during an evidence read holds the attempt.
  const evidenceResult = await captureDeclaredEvidence(
    source,
    region.sourceBody,
    usable,
    limits,
    ledger,
  );
  if ("kind" in evidenceResult) return evidenceResult;
  const evidence = evidenceResult.evidence;

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
    computePredecessorFingerprint(targetSnapshot, captured, laneLabels, evidence),
  );

  const snapshot: RefinementSnapshot = {
    version,
    target: targetSnapshot,
    predecessors: captured,
    evidence,
    manifest: {
      capturedAt: now,
      limits: { ...limits },
      truncatedFields: [...ledger.truncatedFields],
      totalTextBytes: ledger.totalTextBytes,
      maxTotalTextBytes: refinementSnapshotByteBudget(limits, captured.length, evidence.length),
      predecessorCount: captured.length,
      evidenceCount: evidence.length,
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

/**
 * The §5.1 evidence entries that were declared but not captured — the exact
 * set issue #1003's `evidence_required` preflight dispositions on. This slice
 * only RECORDS the failures; deciding whether they park the Issue for a human
 * is deliberately not its call.
 */
export function refinementEvidenceOmissions(
  snapshot: RefinementSnapshot,
): RefinementSnapshotEvidence[] {
  return snapshot.evidence.filter((e) => e.status === "omitted");
}
