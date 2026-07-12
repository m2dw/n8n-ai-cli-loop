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

/** Outcome of a provider mutation that either succeeds or yields an error. */
export type ProviderResult = { ok: true } | { ok: false; error: string };

/** Outcome of a provider read that yields a value or an error. */
export type ProviderRead<T> = { ok: true; value: T } | { ok: false; error: string };

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
  /** Post a human-visible comment / audit note. */
  commentItem(issueNumber: number, body: string, idempotencyKey?: string): ProviderResult;
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
