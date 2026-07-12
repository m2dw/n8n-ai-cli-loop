/**
 * Outbox types and idempotency-key helpers.
 *
 * Side effects are stored in SQLite and dispatched by a separate process,
 * keeping handlers free of direct GitHub API calls and making retries trivial.
 *
 * Two families of topics coexist:
 *  - Legacy GitHub-specific topics (`gh:comment`, `gh:label:add`,
 *    `gh:label:remove`) that dispatch against GitHub Issues directly. These are
 *    preserved unchanged so existing sessions keep their exact observable
 *    behavior.
 *  - Provider-neutral topics (`workitem:comment`, `workitem:transition`,
 *    `repohost:pr-comment`) that carry a provider *kind* and route through the
 *    configured {@link WorkItemProvider} / {@link RepoHostProvider} at dispatch
 *    time instead of assuming GitHub issue endpoints. These are the path a
 *    non-GitHub work-item backend (e.g. private Gitea issues) uses; the
 *    `github-issues` / `github` kinds resolve back to the same `gh` providers so
 *    GitHub behavior is preserved. See docs/provider-architecture.md
 *    ("Outbox Visibility Policy") and docs/gitea-private-work-items.md.
 */

import type { WorkItemProviderKind, RepoHostProviderKind } from "./session.js";
import type { WorkItemTransition } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Legacy GitHub-specific payload types
// ---------------------------------------------------------------------------

export interface GhCommentPayload {
  topic: "gh:comment";
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

export interface GhLabelAddPayload {
  topic: "gh:label:add";
  owner: string;
  repo: string;
  issueNumber: number;
  label: string;
}

export interface GhLabelRemovePayload {
  topic: "gh:label:remove";
  owner: string;
  repo: string;
  issueNumber: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Provider-neutral payload types
//
// Each carries the configured provider *kind* and an `owner`/`repo` pair (kept
// even for non-GitHub providers so the session-scoped dispatch filter, which
// keys on `payload.owner`/`payload.repo`, works for every topic). At dispatch
// time the kind selects which provider implementation handles the row; the
// `github-issues` / `github` kinds resolve to the existing `gh` providers.
// ---------------------------------------------------------------------------

/** Tier 1 work-item comment routed through the configured WorkItemProvider. */
export interface WorkItemCommentPayload {
  topic: "workitem:comment";
  provider: WorkItemProviderKind;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

/** Coarse work-item state change routed through the configured WorkItemProvider. */
export interface WorkItemTransitionPayload {
  topic: "workitem:transition";
  provider: WorkItemProviderKind;
  owner: string;
  repo: string;
  issueNumber: number;
  transition: WorkItemTransition;
}

/** Tier 2 public PR comment routed through the configured RepoHostProvider. */
export interface RepoHostPrCommentPayload {
  topic: "repohost:pr-comment";
  provider: RepoHostProviderKind;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}

/**
 * Tier 2 sticky PR summary comment: upsert (find-by-marker and edit, or create)
 * via the configured RepoHostProvider. Updated on each implementation/review pass
 * so the human merge gate always sees the latest change summary (issue #506).
 */
export interface RepoHostPrSummaryPayload {
  topic: "repohost:pr-summary";
  provider: RepoHostProviderKind;
  owner: string;
  repo: string;
  prNumber: number;
  /** HTML comment marker used to locate the existing sticky comment. */
  marker: string;
  body: string;
}

/**
 * Slack incoming-webhook notification for `ready_for_human` or `failed`
 * transitions (issues #465, #529). `owner`/`repo` carry the session's GitHub
 * coordinates so the session-scoped dispatch filter (which keys on those
 * fields) works correctly. `webhookUrlEnv` is the **name** of the env var
 * holding the Slack webhook URL — never the URL itself — so no secret is
 * persisted in the SQLite outbox.
 */
export interface SlackNotificationPayload {
  topic: "slack:notification";
  /** GitHub owner — used by the session-scoped dispatch filter. */
  owner: string;
  /** GitHub repo name — used by the session-scoped dispatch filter. */
  repo: string;
  /** Env var name that holds the Slack incoming webhook URL at dispatch time. */
  webhookUrlEnv: string;
  /** Session identifier for the notification message. */
  sessionId: string;
  /** Work-item (issue) number. */
  issueNumber: number;
  /** Phase that produced this notification. */
  phase: string;
  /**
   * Task transition that triggered this notification. Omitted on legacy
   * entries (treated as `"ready_for_human"` by the dispatcher).
   */
  transition?: "ready_for_human" | "failed";
  /** Short human-readable reason or last error (sanitized, no local paths). */
  reason?: string;
  /** Public GitHub issue URL — safe to include in Slack messages. */
  issueUrl?: string;
  /** Public GitHub PR URL if available — safe to include in Slack messages. */
  prUrl?: string;
}

export type OutboxTopic =
  | "gh:comment"
  | "gh:label:add"
  | "gh:label:remove"
  | "workitem:comment"
  | "workitem:transition"
  | "repohost:pr-comment"
  | "repohost:pr-summary"
  | "slack:notification";

export type OutboxPayload =
  | GhCommentPayload
  | GhLabelAddPayload
  | GhLabelRemovePayload
  | WorkItemCommentPayload
  | WorkItemTransitionPayload
  | RepoHostPrCommentPayload
  | RepoHostPrSummaryPayload
  | SlackNotificationPayload;

// ---------------------------------------------------------------------------
// Outbox entry
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  id: number;
  idempotencyKey: string;
  topic: OutboxTopic;
  payload: OutboxPayload;
  createdAt: string;
  sentAt?: string;
}

export interface OutboxEnqueueInput {
  idempotencyKey: string;
  topic: OutboxTopic;
  payload: OutboxPayload;
  now?: string;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface OutboxStore {
  /**
   * Insert a new outbox entry unless the idempotency key already exists.
   * Returns `{ enqueued: true }` on insert, `{ enqueued: false }` on duplicate.
   */
  enqueue(input: OutboxEnqueueInput): Promise<{ enqueued: boolean }>;

  /**
   * Atomically supersede pending `repohost:pr-summary` rows for the same PR
   * group and insert a fresh entry, so only the latest summary body is ever
   * dispatched.  Any existing pending (unsent) rows whose payload matches
   * `(owner, repo, prNumber, marker)` are deleted before the insert, preventing
   * a stale-body retry from overwriting a newer successful dispatch (issue #506).
   *
   * Returns `{ enqueued: true }` when inserted, `{ enqueued: false }` when the
   * idempotency key already exists (same-run duplicate — safe no-op).
   */
  replacePendingPrSummary(
    input: OutboxEnqueueInput,
    key: { owner: string; repo: string; prNumber: number; marker: string },
  ): Promise<{ enqueued: boolean }>;

  /**
   * Return entries that have not been sent yet, oldest-first.
   * When `limit` is omitted, every pending entry is returned so a caller that
   * filters in memory can apply its own cap after filtering.
   */
  listPending(limit?: number): Promise<OutboxEntry[]>;

  /** Mark a single entry as sent. */
  markSent(id: number, sentAt?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Idempotency key generation
// ---------------------------------------------------------------------------

/**
 * Build a stable idempotency key from ordered string/number parts.
 * Parts are joined with ":" after converting to string.
 *
 * Examples:
 *   makeOutboxKey("session1", 42, "run-abc", "gh:comment", "implementation:success")
 *   → "session1:42:run-abc:gh:comment:implementation:success"
 */
export function makeOutboxKey(...parts: (string | number)[]): string {
  return parts.map(String).join(":");
}
