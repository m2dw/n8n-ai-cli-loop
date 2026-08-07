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
import type { OutboxEffect } from "./task-store.js";
import type { OutboxScanCursorFence, OutboxScanCursorRole } from "./outbox-scan-cursor.js";

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
  /** Number of failed dispatch attempts recorded so far (issue #606). */
  attemptCount: number;
  /** Sanitized message from the most recent failed attempt, if any. */
  lastError?: string;
  /**
   * Earliest time this row is eligible for another dispatch attempt. `undefined`
   * means eligible now (never failed, or a fresh row). Dispatch selection must
   * skip a row while this is in the future so a delayed row cannot occupy the
   * fetch/limit window ahead of a newer due row (issue #606).
   */
  nextAttemptAt?: string;
  /**
   * Set once this row has exhausted its retry budget ({@link OUTBOX_MAX_ATTEMPTS}
   * failed attempts). A dead-lettered row is permanently excluded from dispatch
   * selection — it no longer competes with pending rows for the run cap.
   */
  deadLetterAt?: string;
  /**
   * Set when an operator explicitly cancels this row via `admin outbox cancel`
   * (issue #607). A cancelled row is always dead-lettered too (excluded from
   * dispatch selection), but `cancelledAt` distinguishes an operator decision
   * from an automatic dead-letter caused by exhausting {@link OUTBOX_MAX_ATTEMPTS}.
   */
  cancelledAt?: string;
  /**
   * Set for the duration of a single dispatch attempt (issue #607 review
   * follow-up): `dispatchOutbox` claims a row atomically immediately before
   * performing its external side effect and clears this when the attempt
   * resolves (success or failure). Lets `cancelEntry` detect an in-flight
   * dispatch and refuse to report `cancelled: true` for a row that may
   * already have been delivered. A claim older than
   * {@link OUTBOX_CLAIM_STALE_MS} is treated as abandoned (e.g. the
   * dispatching process crashed) and ignored by both dispatch and cancel —
   * see {@link isOutboxClaimActive}.
   */
  claimedAt?: string;
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
   * Opaque identity of the durable backend this store writes to (issue #818
   * review follow-up); see {@link TaskStore.backendId}. A caller holding a task
   * store and an outbox store compares the two ids to know whether a phase
   * completion's effects are committed transactionally with its task
   * transition (equal, defined ids) or need a separate, deliberately-ordered
   * write (anything else).
   */
  readonly backendId?: string | undefined;

  /**
   * Whether a whole-file maintenance lock is currently held (issue #818).
   * Optional: only the SQLite-backed store has such a lock, and only callers
   * that need to *report* contention (`dispatchOutbox`'s fail-closed
   * pre-check, the `admin outbox retry/cancel` previews) consult it — the
   * mutating methods below enforce the lock themselves, atomically, inside
   * their own transactions. An implementation without one (in-memory stores,
   * the phase-runner's effect collector, test fakes) simply omits it and is
   * treated as unlocked.
   */
  isMaintenanceLocked?(): Promise<boolean>;

  /**
   * Insert a new outbox entry unless the idempotency key already exists.
   * Returns `{ enqueued: true }` on insert, `{ enqueued: false }` on duplicate.
   *
   * Throws `MaintenanceLockedError` (stores/maintenance-lock-guard.ts) when a
   * maintenance lock is held (issue #818): a refusal must never be reported
   * through `{ enqueued: false }`, which already means "duplicate key — safe
   * no-op" and is ignored by nearly every caller. Silently reusing it would
   * drop a real side effect and report success; throwing keeps the effect
   * un-persisted, fails the caller loudly, and lets the work be retried once
   * maintenance releases the lock. Implementations that check the lock must
   * read it inside the same transaction as the insert.
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
   *
   * Throws `MaintenanceLockedError` while a maintenance lock is held, for the
   * same reason (and with the same in-transaction requirement) as
   * {@link enqueue} — more so here, since this path also *deletes* pending
   * rows a concurrent maintenance pass may already have accounted for.
   */
  replacePendingPrSummary(
    input: OutboxEnqueueInput,
    key: { owner: string; repo: string; prNumber: number; marker: string },
  ): Promise<{ enqueued: boolean }>;

  /**
   * Write a whole set of completion effects in ONE transaction — every
   * {@link OutboxEffect} inserted (and, for a PR summary, its pending rows
   * superseded) together, with the maintenance-lock read inside that same
   * transaction (issue #818 review follow-up).
   *
   * Optional: only a store with real transactions can offer it. `runNextPhase`
   * uses it for the supported `store`/`outboxStore` pairing that does NOT share
   * a backend, where the effects cannot ride the task store's
   * `completePhaseWithEffects` transaction. Writing them one {@link enqueue} at
   * a time there means a lock acquired part-way through the set leaves the
   * earlier rows behind while the completion is handed back as retryable — and
   * once maintenance releases, the dispatcher publishes a completion comment or
   * a status label for a phase that never committed and is about to re-run.
   * All-or-nothing removes that state: either the whole set is durable or none
   * of it is.
   *
   * Throws `MaintenanceLockedError` (stores/maintenance-lock-guard.ts) while a
   * lock is held, having written nothing — same typed refusal, and same
   * in-transaction requirement, as {@link enqueue}. A store that omits this
   * makes the caller fall back to per-effect writes, where a partially written
   * set is treated as non-retryable instead.
   */
  enqueueEffects?(effects: OutboxEffect[]): Promise<void>;

  /**
   * Return entries that have not been sent and have not been dead-lettered yet,
   * oldest-first. Delayed rows (a future {@link OutboxEntry.nextAttemptAt}) are
   * still included — due-time eligibility is a dispatch-selection concern (see
   * `dispatchOutbox` in handlers/gh-dispatcher.ts), not a store-read concern, so
   * a caller that only wants "is this row still retryable" (e.g. tests) does not
   * need to reason about the clock.
   * When `limit` is omitted, every such entry is returned so a caller that
   * filters in memory can apply its own cap after filtering.
   */
  listPending(limit?: number): Promise<OutboxEntry[]>;

  /**
   * Return up to `limit` entries that are pending and not dead-lettered,
   * oldest-first, starting after `afterId` (issue #606 review follow-up).
   * Unlike an earlier version of this method, due-time is *not* filtered here:
   * a delayed row (a future {@link OutboxEntry.nextAttemptAt}) is still
   * returned, because the dispatcher's persisted scan cursor (`scanCursorKey`)
   * must be able to see a delayed row that belongs to it (matches its
   * `filter`) in order to avoid advancing the cursor past it — filtering
   * due-time in SQL would make such a row invisible to the scan entirely,
   * letting the cursor skip past its id and permanently strand it once it
   * becomes due (issue #606 review follow-up). The dispatcher applies
   * due-time filtering itself, after the ownership filter, when deciding which
   * scanned rows are actually dispatch-eligible this run. Pagination via
   * `afterId` still keeps this bounded — the dispatcher pages through this
   * instead of pulling every pending row via {@link listPending} to stay
   * bounded by the configured run limit even when the table has accumulated a
   * large backlog (e.g. during a prolonged provider outage).
   */
  listPendingEntries(opts: { limit: number; afterId?: number }): Promise<OutboxEntry[]>;

  /**
   * Mark a single entry as sent. When `claimToken` is supplied (issue #607
   * review follow-up), the update is fenced to it: it only commits while the
   * row's `claimedAt` still equals `claimToken`, so a completion from a
   * dispatch attempt whose claim already expired and was reclaimed by another
   * dispatcher becomes a safe no-op instead of clearing the newer claim.
   * Omitted (direct callers that never claimed the row) keeps the update
   * unconditional.
   *
   * Returns `{ updated: boolean }` (P2 review follow-up) reporting whether
   * `sentAt` was actually persisted by this call — `false` for a fenced no-op
   * (stale claim) or an unknown id. A fenced caller (the dispatcher) uses this
   * to avoid treating a rejected completion as dispatched: counting it anyway
   * would advance the scan cursor past a row whose new owner may later fail
   * and schedule a retry, stranding it.
   */
  markSent(id: number, sentAt?: string, claimToken?: string): Promise<{ updated: boolean }>;

  /**
   * Record a failed dispatch attempt (issue #606). Increments the row's
   * attempt count and either schedules the next eligible attempt with bounded
   * backoff ({@link computeOutboxBackoffMs}) or, once {@link OUTBOX_MAX_ATTEMPTS}
   * is reached, marks the row dead-lettered (excluded from {@link listPending}
   * from then on). `error` is sanitized (paths/tokens stripped, length bounded)
   * before being persisted as `lastError`. A no-op (returns `{ deadLettered:
   * false }`) when `id` does not match a row — mirrors {@link markSent}'s
   * tolerance of an unknown id. `claimToken`, when supplied, fences this
   * update the same way it fences {@link markSent} — a no-op once the row's
   * claim no longer matches (issue #607 review follow-up).
   */
  markFailed(id: number, error: string, now?: string, claimToken?: string): Promise<{ deadLettered: boolean }>;

  /**
   * Return the persisted scan cursor for `key` (issue #606 review follow-up),
   * or `undefined` if none has been recorded yet. `key` scopes the cursor to a
   * single dispatch identity *and role* — the dispatcher keeps three cursors
   * per identity (`floor`, `fwd`, `bulk`), whose keys are derived by
   * `core/outbox-scan-cursor.ts` and whose behavior is specified in
   * `docs/outbox-scan-cursor-contract.md`. See {@link setScanCursor}.
   */
  getScanCursor(key: string): Promise<number | undefined>;

  /**
   * Persist the scan cursor for `key`: the id of the last outbox row a bounded
   * `listPendingEntries` scan confirmed does *not* belong to `key` (issue #606
   * review follow-up). A session-scoped dispatch whose filter matches few or
   * none of a large shared pending backlog would otherwise re-scan the same
   * non-matching prefix from row 1 on every invocation — each run bounded by
   * `scanLimit` in `dispatchOutbox`, but never making progress past that
   * prefix since the in-memory `afterId` pagination cursor does not survive
   * between process invocations. Persisting it here lets the next run resume
   * scanning after the confirmed-foreign prefix instead of re-scanning it,
   * so a capped scan still eventually reaches newer due rows that belong to
   * `key`. The caller only advances this up to the last row confirmed to
   * *not* match its filter — never past a row that matched (dispatched, or
   * still delayed/capped-by-`limit` and left pending) — so a row this key
   * owns, due or delayed, can never be skipped (issue #606 review follow-up).
   *
   * Returns `{ persisted: false }` without writing anything while a whole-file
   * maintenance lock is held (issue #818 review follow-up). This is a write to
   * the maintained database like any other outbox mutation, and the lock can be
   * acquired *after* a drain's last claim resolved but before its cursors are
   * persisted — so the check must be read inside the same transaction as the
   * upsert rather than pre-checked by the caller. A refusal is non-destructive:
   * the cursor keeps the last complete run's value, so the next unlocked run
   * resumes exactly where that run left off. Callers treat it as contention
   * (`dispatchOutbox` stops persisting the remaining cursors and reports
   * `maintenanceLocked`).
   *
   * `fence`, when supplied (issue #820 review follow-up), makes the write
   * conditional on the identity's rewind generation still being the one the
   * caller observed at scan start — see {@link OutboxScanCursorFence} for why
   * ordering the rewind alone is not enough. A stale token returns
   * `{ persisted: false, fenceStale: true }` and writes nothing, which is
   * distinct from the maintenance refusal above (`{ persisted: false }`) so a
   * caller can tell "a retry moved this identity's cursors under me" from "the
   * database is under maintenance". An unfenced call keeps the pre-#820
   * unconditional upsert behavior, which is what stores without fence support
   * get.
   */
  setScanCursor(
    key: string,
    id: number,
    fence?: OutboxScanCursorFence,
  ): Promise<{ persisted: boolean; fenceStale?: true }>;

  /**
   * Current rewind generation of a dispatch identity (issue #820 review
   * follow-up), or `0` when no retry has ever rewound it. Read at scan start —
   * *before* the cursors themselves, so a rewind landing between the two reads
   * is caught rather than hidden — and passed back to {@link setScanCursor} as
   * the fence for every cursor the run persists.
   *
   * Optional, like {@link isMaintenanceLocked}: a store without the capability
   * (in-memory stores, the phase-runner's effect collector, test fakes) simply
   * leaves its cursor writes unfenced, exactly as before #820.
   */
  getScanCursorFence?(identityKey: string): Promise<number>;

  /**
   * Return a single entry by id, in any delivery state (pending, delayed, sent,
   * dead-lettered, or cancelled), or `undefined` if no row has that id. This is
   * the operator-lookup path (issue #607) `admin outbox retry`/`cancel` use to
   * validate a row before mutating it.
   */
  getById(id: number): Promise<OutboxEntry | undefined>;

  /**
   * Return every entry that has not been sent, oldest-first, regardless of
   * delayed or dead-lettered state (issue #607). Unlike {@link listPending} /
   * {@link listPendingEntries} — which exclude a dead-lettered row because it is
   * no longer dispatch-eligible — `admin outbox list` needs to show dead-lettered
   * (including cancelled) rows too, so an operator can diagnose and recover a
   * poison row. Callers apply their own session-ownership filtering and
   * pending/delayed/dead categorization (see {@link categorizeOutboxEntry}).
   */
  listUnsent(): Promise<OutboxEntry[]>;

  /**
   * Recover a delayed, dead-lettered, or cancelled row for another dispatch
   * attempt (issue #607): clears `nextAttemptAt`, `deadLetterAt`, and
   * `cancelledAt`, and resets `attemptCount` to 0 so the row gets a full fresh
   * retry budget. Returns `{ retried: false, reason }` without mutating
   * anything when `id` is unknown (`"not_found"`), the row was already
   * dispatched (`"already_sent"`), the row is already immediately
   * dispatch-eligible with nothing to recover (`"already_pending"`), a
   * concurrent {@link cancelEntry} won the race and cancelled the row first
   * (`"already_cancelled"`, issue #607 review follow-up), or some other
   * concurrent write changed the row between the eligibility check and the
   * commit (`"concurrent_update"` — safe to retry the call), or a whole-file
   * maintenance lock is held (`"maintenance_locked"`, issue #818: reviving a
   * dead-lettered/cancelled row back into the pending bucket is exactly the
   * mutation a prune batch's selection must not race — checked in the same
   * transaction as the compare-and-swap).
   *
   * Implemented as a compare-and-swap, not a blind read-then-write: the
   * `UPDATE` pins `nextAttemptAt`/`deadLetterAt`/`cancelledAt` to the exact
   * values just read, so it only commits if nothing raced it. This preserves
   * deliberate, sequential recovery of an already-cancelled row (its
   * `cancelledAt` is read and pinned as-is) while preventing a `retryEntry`
   * that read the row as retryable from clobbering a `cancelEntry` that
   * commits concurrently — otherwise the cancel would have already been
   * reported to the operator as successful while the row silently became
   * dispatchable again.
   *
   * `opts.cursorIdentityKey`, when supplied (issue #820), additionally rewinds
   * that dispatch identity's persisted scan cursors **in the same transaction
   * as the compare-and-swap**. Recovering a row older than a cursor would
   * otherwise strand it: the row is pending again but sits below the `id >
   * afterId` window every future scan for that identity looks at. Each of the
   * identity's three existing cursors whose `after_id >= id` is set to `id -
   * 1`; a cursor row that does not exist is left absent, never created (see
   * `planScanCursorRewind` in `core/outbox-scan-cursor.ts` and
   * `docs/outbox-scan-cursor-contract.md` §13). Atomicity is the point: a
   * revived row with un-rewound cursors is exactly the stranded state this
   * exists to prevent, so the two writes must commit or fail together. When the
   * compare-and-swap loses its race — or the maintenance guard refuses — no
   * cursor is touched. The roles actually rewound are reported as
   * `cursorsRewound` (present only when `cursorIdentityKey` was supplied);
   * `[]` means the cursors were already behind the row and nothing needed
   * moving. Callers derive the key with `deriveOwnershipScanCursorKey` so the
   * scope the CLI resolves and the keys the dispatcher reads cannot drift.
   */
  retryEntry(
    id: number,
    now?: string,
    opts?: { cursorIdentityKey?: string },
  ): Promise<{ retried: boolean; reason?: string; cursorsRewound?: OutboxScanCursorRole[] }>;

  /**
   * Permanently exclude a row from dispatch selection by operator decision
   * (issue #607): sets `cancelledAt` and, if not already set, `deadLetterAt`.
   * Returns `{ cancelled: false, reason }` without mutating anything when `id`
   * is unknown (`"not_found"`), the row was already dispatched
   * (`"already_sent"`), the row was already cancelled (`"already_cancelled"`),
   * or a dispatch attempt currently holds the row's claim (`"dispatch_in_progress"`,
   * issue #607 review follow-up — see {@link claimForDispatch}): that attempt
   * may already have performed the external side effect, so cancellation
   * cannot be reported as successful while it is in flight — or a whole-file
   * maintenance lock is held (`"maintenance_locked"`, issue #818: checked in
   * the same transaction as the cancelling update).
   *
   * Implemented as a single atomic `UPDATE ... WHERE` (not a read-then-write)
   * so a concurrent {@link claimForDispatch} and `cancelEntry` call can never
   * both believe they won: whichever's `UPDATE` commits first is authoritative
   * and the loser's `WHERE` no longer matches.
   */
  cancelEntry(id: number, now?: string): Promise<{ cancelled: boolean; reason?: string }>;

  /**
   * Atomically claim a row for a single dispatch attempt (issue #607 review
   * follow-up): sets `claimedAt` and returns `true`, but only when the row is
   * still unsent, uncancelled, not dead-lettered, not delayed by a still-future
   * `nextAttemptAt`, and not already claimed by another (non-stale) attempt —
   * the same atomic `UPDATE ... WHERE` mechanism {@link cancelEntry} uses, so
   * the two can never race each other into an inconsistent outcome. The
   * `nextAttemptAt` check (P2 review follow-up) closes a gap where two
   * dispatchers scan the same due row and one of them fails and schedules a
   * retry backoff (via `markFailed`) before the other reaches this claim:
   * without it, the second dispatcher would still claim and dispatch the row
   * immediately, bypassing the backoff that was just set. Returns `false`
   * without mutating anything when the row is no longer claimable (most
   * notably: an operator cancelled it, or a concurrent attempt's failure just
   * delayed it, between the dispatcher's scan and this claim attempt) — the
   * caller must skip dispatching that row rather than performing its external
   * side effect.
   *
   * Also returns `false`, without mutating anything, while a whole-file
   * maintenance lock is held (issue #818), read inside the same transaction as
   * the claiming update. This is the fail-closed point for dispatch: no row is
   * ever claimed — and therefore no external side effect ever performed —
   * while maintenance is in progress. `acquire()` symmetrically refuses while
   * any non-stale claim exists, so a claim and an acquisition can never both
   * succeed; whichever transaction commits first wins.
   *
   * The caller is responsible for clearing `claimedAt` once the attempt
   * resolves (folded into `markSent`/`markFailed`), so a claim never outlives
   * its dispatch attempt under normal operation. A claim older than
   * {@link OUTBOX_CLAIM_STALE_MS} is ignored by this check (and by
   * `cancelEntry`) so a crashed dispatch process cannot permanently strand a
   * row.
   */
  claimForDispatch(id: number, now?: string): Promise<boolean>;

  /**
   * Extend a claim this caller currently holds (issue #607 review follow-up):
   * a compare-and-swap on the exact `claimedAt` value returned by the caller's
   * own {@link claimForDispatch} (or a prior `renewClaim`) that, on success,
   * advances `claimedAt` to `now` and returns it. A dispatch attempt with no
   * per-call timeout (e.g. `gh`) can run past {@link OUTBOX_CLAIM_STALE_MS}
   * while still legitimately in flight; renewing periodically during that
   * attempt keeps the claim looking active so a concurrent dispatcher's
   * staleness check in `claimForDispatch`/`cancelEntry` never mistakes a slow
   * but live claim for an abandoned one and reclaims/duplicates the same
   * external side effect. Returns `undefined` without mutating anything when
   * `claimedAt` no longer matches the row's current value — the claim was
   * already released (sent/failed) or reclaimed by someone else, so this
   * caller no longer owns it and must stop renewing.
   */
  renewClaim(id: number, claimedAt: string, now?: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Delivery-status categorization (issue #607)
// ---------------------------------------------------------------------------

/** Operator-facing delivery status derived from an entry's retry/dead-letter/claim state. */
export type OutboxDeliveryStatus = "pending" | "delayed" | "in_flight" | "dead";

/**
 * Categorize an unsent entry's delivery status for `admin outbox list` (issue
 * #607): `"dead"` once dead-lettered (by exhausted retries or an operator
 * cancel), `"delayed"` while its next attempt is still in the future,
 * `"in_flight"` while a non-stale {@link OutboxStore.claimForDispatch} claim
 * holds the row for an active dispatch attempt (issue #607 review follow-up —
 * such a row is not eligible for dispatch or cancellation right now, so it
 * must not be reported as `"pending"`), else `"pending"` (eligible for
 * dispatch right now). Callers exclude sent entries before categorizing — a
 * sent row has no meaningful delivery status.
 */
export function categorizeOutboxEntry(
  entry: Pick<OutboxEntry, "nextAttemptAt" | "deadLetterAt" | "claimedAt">,
  nowIso: string,
): OutboxDeliveryStatus {
  if (entry.deadLetterAt) return "dead";
  if (entry.nextAttemptAt && entry.nextAttemptAt > nowIso) return "delayed";
  if (isOutboxClaimActive(entry.claimedAt, nowIso)) return "in_flight";
  return "pending";
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

// ---------------------------------------------------------------------------
// Retry backoff / dead-letter policy (issue #606)
// ---------------------------------------------------------------------------

/**
 * Failed attempts a row may accumulate before it is dead-lettered. The Nth
 * failure (attemptCount reaching this value) dead-letters the row instead of
 * scheduling another retry.
 */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Backoff delay after the first failed attempt. */
export const OUTBOX_BASE_RETRY_DELAY_MS = 60 * 1000;

/** Upper bound on the backoff delay, reached well before {@link OUTBOX_MAX_ATTEMPTS}. */
export const OUTBOX_MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/**
 * Bounded exponential backoff for the Nth failed attempt: doubles per attempt
 * from {@link OUTBOX_BASE_RETRY_DELAY_MS}, capped at {@link OUTBOX_MAX_RETRY_DELAY_MS}.
 * `attemptCount` is the total failures recorded so far (1 after the first
 * failure), matching the value persisted as `OutboxEntry.attemptCount`.
 */
export function computeOutboxBackoffMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(OUTBOX_BASE_RETRY_DELAY_MS * 2 ** exponent, OUTBOX_MAX_RETRY_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Dispatch claim policy (issue #607 review follow-up)
// ---------------------------------------------------------------------------

/**
 * How long a dispatch claim ({@link OutboxEntry.claimedAt}) remains active
 * before both {@link OutboxStore.claimForDispatch} and
 * {@link OutboxStore.cancelEntry} treat it as abandoned. A single dispatch
 * attempt (one network call) normally holds a claim for well under a minute;
 * this bound only matters if the dispatching process crashes mid-attempt —
 * without it, a crashed claim would permanently block both re-dispatch and
 * operator cancellation of that row.
 */
export const OUTBOX_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Whether `claimedAt` currently represents an active (non-stale) dispatch
 * claim as of `nowIso`. Shared by the admin `outbox cancel` preview
 * ({@link OutboxStore.cancelEntry}'s read-only mirror) and, in spirit, by the
 * SQL `WHERE` conditions `claimForDispatch`/`cancelEntry` evaluate atomically
 * in the store — kept here as plain JS so the preview path needs no database
 * round trip.
 */
export function isOutboxClaimActive(claimedAt: string | undefined, nowIso: string): boolean {
  if (!claimedAt) return false;
  const staleBefore = new Date(new Date(nowIso).getTime() - OUTBOX_CLAIM_STALE_MS).toISOString();
  return claimedAt > staleBefore;
}
