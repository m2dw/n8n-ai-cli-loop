// ---------------------------------------------------------------------------
// Provider interfaces
//
// These types describe the operations the thin runner needs from a work-item
// tracker (issues/tickets) and a repository host (PR operations), independent of
// any particular backend. The current GitHub behavior is implemented by the
// `gh`-backed providers in ./github; future backends (GitHub App, Jira, ADO,
// Bitbucket) implement the same interfaces without touching handler code.
//
// The shape follows docs/provider-architecture.md (issue #214). Handlers depend
// ONLY on these interfaces — never on raw `gh` command details. Local git
// operations (fetch/checkout/merge/commit/push) are deliberately NOT part of
// these interfaces: they stay in the handlers, separate from the repo-host API.
//
// Identifiers are kept as primitives for the MVP: a work item is addressed by
// its issue number and a pull request by a selector (PR number or branch). The
// head-branch convention (`ai/issue-<n>`) is owned by the RepoHostProvider, so
// callers ask for "the PR for this work item" rather than deriving the branch.
// ---------------------------------------------------------------------------

import type { BlockedByEntry } from "../core/github-intake.js";

export type { BlockedByEntry };

/**
 * Outcome of a provider mutation that either succeeds or yields an error.
 *
 * `alreadyAbsent` is set on a successful `remove-label` transition when the
 * provider found the label already gone (e.g. a 404) rather than removing it
 * itself. Both the GitHub and Gitea providers treat that as `ok: true` since
 * the end state ("label not on the Issue") is the same either way — but a
 * caller that must attribute the removal to ITS OWN operation (see
 * `suspendIssueAutomation` in core/issue-activation.ts, issue #787 review)
 * needs to tell "I removed this" apart from "someone else already had", so it
 * never records a label it did not actually remove as restorable.
 */
export type ProviderResult = { ok: true; alreadyAbsent?: boolean } | { ok: false; error: string };

/** Outcome of a provider read that yields a value or an error. */
export type ProviderRead<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Outcome of a dependency-relationship mutation (issue #791).
 *
 * Distinct from {@link ProviderResult} because the interesting distinction is
 * the opposite one: a relationship write is requested against a state the
 * caller read moments earlier, and the only honest answers are "this call
 * created/removed it" and "the tracker already held it that way". `changed`
 * carries exactly that, which is what makes a retry after a partial failure
 * safe — re-running an edit converges instead of double-writing — and what
 * keeps `admin chain new|append|prepend` from reporting an edge as applied when
 * another actor had already drawn it.
 */
export type DependencyMutationResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Work items (issues / tickets)
// ---------------------------------------------------------------------------

/** A candidate work item as surfaced when listing open issues during intake. */
export interface WorkItem {
  number: number;
  title: string;
  url: string;
  labels: string[];
  /** Raw work-item body (markdown). Absent when the item has no body. */
  body?: string;
}

/** Detail read for a single work item. Currently only the label set is read. */
export interface WorkItemDetails {
  labels: string[];
}

/**
 * Provider-neutral "move to this coarse state". For GitHub it resolves to a
 * label add/remove; for a tracker with native transitions it resolves to a
 * workflow transition id.
 */
export type WorkItemTransition =
  | { kind: "add-label"; label: string }
  | { kind: "remove-label"; label: string };

/**
 * Read/write operations against a work-item tracker (issues, tickets).
 *
 * `getDependencies` matches the {@link DependencyChecker} contract: it MUST
 * throw on any error so callers can fail closed.
 */
export interface WorkItemProvider {
  /** Queue selection: candidate items eligible to enter the loop. Throws on failure. */
  listCandidateItems(limit: number): WorkItem[];
  /** Detail for a single item (currently its labels). */
  getItem(issueNumber: number): ProviderRead<WorkItemDetails>;
  /** Dependency relationships (`blocked by`). Throws on failure (fail closed). */
  getDependencies(issueNumber: number): Promise<BlockedByEntry[]>;
  /**
   * The other direction of the same relationship: the Issues this one BLOCKS
   * (issue #791 review).
   *
   * A dependency edge has two ends, and reading only the `blocked by` end leaves
   * a whole class of live topology invisible — an Issue that blocks something
   * outside the set being read looks, from its own blockers alone, like a
   * downstream end. `admin chain append` is the case that made this a port
   * method rather than a caller's loop: it may only extend past a head that
   * nothing depends on, and a head already blocking an unregistered Issue is a
   * fork the command promises to refuse but could not see.
   *
   * Entries describe the BLOCKED Issue (the far end), mirroring
   * {@link WorkItemProvider.getDependencies}. Throws on failure for the same
   * reason: a caller that cannot read this must fail closed, never treat an
   * unread relationship as an absent one.
   */
  getDependents(issueNumber: number): Promise<BlockedByEntry[]>;
  /**
   * Declare that `blockedIssueNumber` is blocked by `blockerIssueNumber` — the
   * write counterpart of {@link WorkItemProvider.getDependencies}, expressed in
   * the tracker's own relationship model rather than as body text, so the same
   * read that gates the loop sees it (issue #791).
   *
   * Idempotent: a relationship the tracker already holds is reported as
   * `changed: false`, never as an error. Unlike the read side this does NOT
   * throw — a relationship edit is one step of a multi-Issue mutation whose
   * caller has to know exactly which steps landed before it can describe a
   * recovery, and an exception carries none of that.
   */
  addDependency(blockedIssueNumber: number, blockerIssueNumber: number): Promise<DependencyMutationResult>;
  /**
   * Remove a `blocked by` relationship. Idempotent; see
   * {@link WorkItemProvider.addDependency}.
   *
   * The linear chain commands never call it — they only ever add, which is what
   * makes "a failed edit cannot destroy a relationship somebody else drew" a
   * property of the code rather than a promise. It is here because a port that
   * can create a dependency but not delete one is not a model of the tracker's
   * relationship API, and an operator-driven topology edit that does remove one
   * must not have to reach past this interface to do it.
   */
  removeDependency(blockedIssueNumber: number, blockerIssueNumber: number): Promise<DependencyMutationResult>;
  /** Post a human-visible comment / audit note. */
  commentItem(issueNumber: number, body: string, idempotencyKey?: string): ProviderResult;
  /**
   * Whether the item already carries a comment containing `marker` (issue #936).
   *
   * The delivery-side half of an at-most-once comment: the local outbox key
   * deduplicates the durable row, but only the tracker can answer whether a
   * previous attempt's POST actually landed before its dispatcher lost the
   * claim. Callers use it as a precondition, so it must fail (`ok: false`)
   * rather than guess when the comment history cannot be read — reporting a
   * comment as absent because the read failed is what produces the duplicate
   * this exists to prevent.
   *
   * Optional: a provider that cannot read its comment history simply does not
   * implement it, and callers fall back to posting unconditionally (the
   * behavior every comment had before this seam existed).
   */
  hasItemCommentWithMarker?(issueNumber: number, marker: string): ProviderRead<boolean>;
  /** Move the item's coarse workflow state (label add/remove). */
  transitionItem(issueNumber: number, transition: WorkItemTransition): ProviderResult;
}

// ---------------------------------------------------------------------------
// Repository host (pull requests)
// ---------------------------------------------------------------------------

/** A pull request, carrying the fields the runner consumes. */
export interface PullRequest {
  number: number;
  url: string;
  headRefName: string;
  /** PR state ("OPEN" | "CLOSED" | "MERGED" on GitHub; "open" | "closed" on Gitea). Absent when not queried. */
  state?: string;
  /** Live base ref the PR targets. Absent when not queried. */
  baseRefName?: string;
  /** Mergeability ("MERGEABLE" | "CONFLICTING" | "UNKNOWN"). Absent when not queried. */
  mergeable?: string;
  /** Merge-state status ("CLEAN" | "DIRTY" | ...). Absent when not queried. */
  mergeStateStatus?: string;
  /**
   * True when the PR head lives in a DIFFERENT repository than the base (a fork).
   * A forked head is not an `origin` branch, so it can only be materialized via
   * `pull/<n>/head` and must never be pushed to `origin` by branch name. Absent
   * when not queried; treat absence as "not a fork" (the conventional same-repo
   * case) so consumers fail closed only on a confirmed cross-repository head.
   */
  isCrossRepository?: boolean;
}

/**
 * Result of resolving the single open PR for a work item. Distinguishes a
 * successful "no open PR" answer (a legitimate state callers may hand off) from
 * a lookup failure (a transient or operator problem that must not be read as "no
 * PR exists").
 */
export type FindPullRequestResult =
  | { kind: "found"; pullRequest: PullRequest }
  | { kind: "none" }
  | { kind: "failed"; error: string };

export interface CreatePullRequestInput {
  title: string;
  body: string;
  /** Head branch the PR is opened from (already pushed by local git). */
  head: string;
  /** Base branch the PR targets. */
  base: string;
}

/** Read/write operations against a repository host's pull requests. */
export interface RepoHostProvider {
  /** Resolve the open PR that corresponds to a work item (by head-branch convention). */
  findPullRequestForWorkItem(issueNumber: number): FindPullRequestResult;
  /** Open a PR for an already-pushed branch. */
  createPullRequest(input: CreatePullRequestInput): ProviderRead<PullRequest>;
  /** Fetch a PR by selector (PR number or branch), including base ref and mergeability. */
  getPullRequest(selector: string): ProviderRead<PullRequest>;
  /** Post a comment on a PR. */
  commentPullRequest(selector: string, body: string, idempotencyKey?: string): ProviderResult;
  /**
   * Post or update a sticky summary comment on a PR. Searches existing comments
   * for one whose body contains `marker`; edits it in place if found, or creates
   * a new comment when none exists. Used to keep the human merge-gate summary
   * up-to-date without spamming new comments on each pass (issue #506).
   */
  upsertStickyPrComment(prNumber: number, marker: string, body: string): ProviderResult;
}
