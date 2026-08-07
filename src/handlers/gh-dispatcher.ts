import { OUTBOX_CLAIM_STALE_MS, type OutboxEntry, type OutboxStore, type SlackNotificationPayload } from "../core/outbox.js";
import { deriveScanCursorKey } from "../core/outbox-scan-cursor.js";
import { sanitizeLegacyPrCommentBody } from "../core/outbox-visibility.js";

/** Minimal fetch-compatible function type for Slack webhook dispatch (issue #465). */
export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
import { GhWorkItemProvider } from "../providers/github/gh-work-item-provider.js";
import { GhRepoHostProvider } from "../providers/github/gh-repo-host-provider.js";
import type { GhRunner, GhRunResult } from "../providers/github/gh-runner.js";
import { defaultGhRunner } from "../providers/github/gh-runner.js";
import type { WorkItemProvider, RepoHostProvider } from "../providers/types.js";

// The injectable `gh` executor now lives with the providers; re-exported here so
// existing import sites (and the outbox dispatcher's injection seam) are stable.
export type { GhRunner, GhRunResult };
export { defaultGhRunner };

// ---------------------------------------------------------------------------
// Provider construction (provider-neutral topics)
//
// Provider-neutral outbox rows (`workitem:*`, `repohost:pr-comment`) carry a
// provider *kind* rather than assuming GitHub endpoints. The dispatcher
// constructs the matching provider from that kind via this factory instead of
// hard-coding `gh api` argv, so a future non-GitHub work-item backend (e.g.
// Gitea) is reached by registering a new factory branch — handler and outbox
// code stay unchanged. The `github-issues` / `github` kinds resolve back to the
// existing `gh` providers so GitHub behavior is preserved.
//
// A factory returns `null` for a kind it cannot build (an unimplemented
// provider). The dispatcher treats that as a retryable per-entry failure: the
// row stays pending rather than being dropped, so enabling the provider later
// drains the backlog.
// ---------------------------------------------------------------------------

export interface OutboxProviderFactory {
  /** Build a WorkItemProvider for a provider kind, or null when unsupported. */
  workItem(provider: string, repo: string, cwd: string, runner: GhRunner): WorkItemProvider | null;
  /** Build a RepoHostProvider for a provider kind, or null when unsupported. */
  repoHost(provider: string, repo: string, cwd: string, runner: GhRunner): RepoHostProvider | null;
}

/**
 * The default factory: GitHub is the only wired backend today. `github-issues`
 * and `github` map to the `gh`-backed providers; every other kind is reported
 * as unsupported (null) so its rows stay pending instead of being mis-dispatched
 * to GitHub.
 */
export const defaultOutboxProviderFactory: OutboxProviderFactory = {
  workItem(provider, repo, cwd, runner) {
    if (provider === "github-issues") return new GhWorkItemProvider(runner, repo, cwd);
    return null;
  },
  repoHost(provider, repo, cwd, runner) {
    if (provider === "github") return new GhRepoHostProvider(runner, repo, cwd);
    return null;
  },
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * How often an in-flight dispatch attempt renews its claim (issue #607
 * review follow-up). Half of {@link OUTBOX_CLAIM_STALE_MS} so a renewal is
 * always attempted well before the claim would otherwise be treated as
 * abandoned, tolerating one missed tick (e.g. a slow event-loop turn) without
 * a concurrent dispatcher's staleness check racing ahead of it.
 */
const OUTBOX_CLAIM_RENEW_MS = OUTBOX_CLAIM_STALE_MS / 2;

export interface DispatchResult {
  dispatched: number;
  failed: number;
  errors: Array<{ id: number; error: string }>;
  /**
   * Count of failed rows that exhausted their retry budget on this run and
   * were dead-lettered (issue #606). Included in `failed` above — this is a
   * breakdown, not an additional bucket.
   */
  deadLettered: number;
  /**
   * Set when this run stopped because a whole-file maintenance lock is held
   * (issue #818). An expected idle outcome, not a failure: no row was claimed,
   * no external side effect was performed, and no cursor was advanced. The
   * counters above report whatever was already dispatched before the lock
   * appeared (zero when it was already held at run start). Omitted entirely on
   * a normal run so existing consumers see an unchanged shape.
   */
  maintenanceLocked?: boolean;
  /**
   * Set when this run's persisted scan cursors were refused because an
   * `admin outbox retry` rewound them after the scan started (issue #820 review
   * follow-up). Not a failure and not contention: every row this run claimed was
   * dispatched and counted above, only the scan extent was discarded because it
   * was computed before a row was revived underneath it. The rewound cursors
   * stand, so the next run re-scans that bounded span and finds the recovered
   * row. Omitted entirely on a normal run so existing consumers see an unchanged
   * shape.
   */
  cursorFenceStale?: boolean;
}

export interface DispatchOptions {
  cwd: string;
  limit?: number;
  now?: string;
  /**
   * Optional predicate restricting which pending entries this invocation owns.
   * Used to scope a session-bound dispatch to that session's repo so its runner
   * (e.g. a GitHub App installation token) is never applied to another session's
   * repo rows in a shared DB. Non-matching entries are left pending (retryable)
   * for the run that owns them. When omitted, every pending entry is dispatched.
   */
  filter?: (entry: OutboxEntry) => boolean;
  /**
   * Upper bound on how many due rows a single run will fetch and JSON-parse
   * while paging toward `limit` filter-matching rows (review follow-up to
   * issue #606). Without this bound, a session-scoped `filter` that matches
   * few or none of a large shared due backlog (e.g. many other repos' rows
   * accumulated by an abandoned session) makes the loop page through the
   * *entire* due set every run — each foreign row still fetched and parsed
   * before being discarded by the filter — turning the bounded drain back
   * into an unbounded scan. Defaults to a generous multiple of the fetch
   * page size, but only when `scanCursorKey` is also set — that default is
   * only ever safe together with a persisted cursor (see `scanCursorKey`),
   * which lets scan progress accumulate across runs; otherwise every run
   * would restart at row 1 and a delayed (not-yet-due) prefix bigger than the
   * default could permanently prevent the scan from ever reaching a newer due
   * row (P2 review follow-up). Without a `scanCursorKey`, the default is
   * unbounded — the scan runs to `limit` matches or pending exhaustion —
   * unless the caller supplies an explicit `scanLimit`, which is always
   * honored regardless of `scanCursorKey`. Hitting the cap simply ends the
   * run early with whatever owned rows were already found rather than
   * continuing to scan the remainder of the due set. When `scanCursorKey` is
   * set, the persisted delayed-zone re-walk (Phase A, below) is capped at
   * exactly this value, but the bulk forward scan past that zone (Phase B)
   * gets its own additional reserve on top of it — so a zone that alone spans
   * `scanLimit` rows can never leave Phase B with zero budget to reach a
   * newer due row past it (P1 review follow-up).
   */
  scanLimit?: number;
  /**
   * Identity that scopes a persisted scan cursor across separate invocations
   * (issue #606 review follow-up). Only meaningful together with `filter`:
   * without a persisted cursor, a session-bound dispatch whose filter matches
   * few or none of a large shared due backlog re-scans that same non-matching
   * prefix from row 1 every run — each run individually bounded by
   * `scanLimit`, but never advancing past that prefix because the in-process
   * `afterId` pagination cursor does not survive between invocations (this
   * CLI runs as a fresh process each time). When set, the scan resumes after
   * the prefix the *previous* run for this key confirmed does not match
   * `filter`, so repeated runs eventually reach newer due rows that do.
   * Left undefined (the default) when no `filter` is given. An unfiltered
   * dispatch has no non-matching prefix to skip, but it can still have a
   * *delayed* one (rows still in backoff) — that prefix is handled instead by
   * `scanLimit` defaulting to unbounded when `scanCursorKey` is unset, rather
   * than by a persisted cursor, since there is no non-matching content to
   * remember skipping past.
   *
   * The key is the *dispatch identity*: it must fold in the whole ownership
   * scope `filter` is built from (session id plus the repository/provider
   * tuple), not just the session id, so repointing a session's repository
   * orphans the old cursor instead of reusing it under a different filter. The
   * CLI builds it with `deriveOwnershipScanCursorKey`; the three persisted keys
   * are derived from it by `deriveScanCursorKey`
   * (`core/outbox-scan-cursor.ts`). The behavioral contract for all three
   * cursors — roles, advancement rules, invariants — is
   * `docs/outbox-scan-cursor-contract.md`.
   */
  scanCursorKey?: string;
  /**
   * Provider factory used to construct the work-item / repo-host provider for
   * provider-neutral topics. Defaults to {@link defaultOutboxProviderFactory}
   * (GitHub only). Injected in tests to dispatch through a fake provider.
   */
  providers?: OutboxProviderFactory;
  /**
   * Runner used for repo-host rows (`repohost:pr-comment`), which publish to the
   * public repo host and so must dispatch with repo-host credentials. In a
   * split-auth session those differ from the work-item credentials carried by
   * `runner` (used for `workitem:*` and legacy `gh:*` rows): the repo-host runner
   * is resolved from `repoHostProvider.auth` while `runner` is resolved from
   * `workItemProvider.auth`. Defaults to `runner` when omitted, preserving
   * single-auth behavior. Like `runner`, a factory is resolved lazily and only
   * when a repo-host row is actually pending.
   */
  repoHostRunner?: GhRunnerResolver;
  /**
   * Fetch implementation for Slack webhook dispatch (issue #465). Defaults to
   * `globalThis.fetch`. Injectable for testing without network access.
   */
  fetchImpl?: FetchFn;
  /**
   * Environment variable map used to resolve the Slack webhook URL at dispatch
   * time (issue #465). Defaults to `process.env`. Injectable so tests can
   * supply webhook URLs without mutating the process environment.
   */
  env?: Record<string, string | undefined>;
}

/**
 * A `gh` executor, or a factory that resolves one. A factory is invoked only once
 * there is pending work, so an empty outbox never triggers credential resolution
 * (e.g. a GitHub App installation-token exchange) or its associated API call.
 */
export type GhRunnerResolver = GhRunner | (() => Promise<GhRunner>);

/**
 * Drain pending outbox entries, calling the appropriate `gh` command for each.
 *
 * - On success: marks the entry as sent.
 * - On failure: leaves the entry un-sent and records the attempt (issue #606).
 *   It becomes eligible again after a bounded backoff delay, or — once it has
 *   exhausted its retry budget (`OUTBOX_MAX_ATTEMPTS` in core/outbox.ts) — is
 *   dead-lettered and excluded from all future dispatch selection.
 * - Duplicate idempotency keys are never re-sent (INSERT OR IGNORE at enqueue time).
 *
 * When `runner` is a factory it is resolved lazily — only after pending entries
 * are found — so an empty outbox exits successfully without resolving credentials.
 *
 * `runner` dispatches work-item rows (`workitem:*`, legacy `gh:*`); repo-host
 * rows (`repohost:pr-comment`) dispatch through `opts.repoHostRunner` (defaulting
 * to `runner`). In a split-auth session those resolve from different provider
 * auth configs, so a public PR comment is never posted under work-item
 * credentials. Each is resolved at most once and only when its domain has a
 * pending row.
 */
export async function dispatchOutbox(
  outboxStore: OutboxStore,
  runner: GhRunnerResolver,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  // Fail closed before ANY external side effect while maintenance is in
  // progress (issue #818). This pre-check is the reporting path — it is what
  // turns contention into a typed idle outcome instead of a silent zero-work
  // run — while `claimForDispatch`'s in-transaction check is what actually
  // makes the exclusion atomic against a lock acquired mid-run. Placed before
  // the scan so a locked run also skips every cursor write (`setScanCursor` is
  // itself an outbox-table mutation) and never resolves credentials.
  if (await isMaintenanceLocked(outboxStore)) {
    return { dispatched: 0, failed: 0, errors: [], deadLettered: 0, maintenanceLocked: true };
  }

  const limit = opts.limit ?? 50;
  const now = opts.now ?? new Date().toISOString();
  // Apply due-time eligibility and the ownership filter *before* the limit. A
  // delayed row (a future `nextAttemptAt`, issue #606) or a foreign-repo row
  // must never occupy the fetch/limit window ahead of a newer, due, owned row —
  // otherwise a handful of backed-off or foreign rows sitting at the front of
  // the table would starve every row behind them on each run. The ownership
  // filter (which cannot be pushed into SQL — it's an arbitrary predicate) is
  // applied page by page; due-time is checked here too, in JS, rather than in
  // SQL (`listPendingEntries` returns delayed rows same as `listPending`) —
  // an owned-but-delayed row must still be *seen* by this scan. Pagination
  // stops as soon as `limit` owned+due rows are collected, the pending set is
  // exhausted, or `scanLimit` rows have been fetched — the last of which
  // bounds the worst case (a filter matching little/none of a large shared
  // backlog) to a fixed amount of work instead of scanning the entire pending
  // set every run (review follow-up to issue #606).
  const pageSize = Math.max(limit, 200);
  // The bounded default is only safe together with `scanCursorKey`: a capped
  // scan that finds nothing needs a persisted cursor so the *next* run can
  // resume past the prefix this run already ruled out, or forward progress
  // never accumulates. Without `scanCursorKey` there is no persisted cursor —
  // every run restarts the scan at row 1 — so a capped default would let a
  // delayed (not-yet-due) prefix larger than the cap permanently hide any due
  // row behind it, even though nothing here is foreign or ownership-filtered
  // (P2 review follow-up to issue #606). Defaulting to unbounded in that case
  // instead scans to `limit` matches or pending exhaustion every run, which
  // is exactly the pre-`scanLimit` behavior for a cursorless dispatch. An
  // explicit `opts.scanLimit` is always honored, cursor or not.
  const scanLimit = opts.scanLimit ?? (opts.scanCursorKey ? pageSize * 10 : Infinity);
  // Phase B gets its own dedicated allowance on top of `scanLimit`, reserved
  // for scanning *past* the protected delayed zone (P1 review follow-up to
  // issue #606). Phase A (the zone re-walk below) stays capped at `scanLimit`
  // exactly as before — that cap is what keeps the zone itself bounded to at
  // most `scanLimit` rows across runs. But when a key legitimately owns a
  // zone's worth of simultaneously delayed/failing rows (e.g. `scanLimit`
  // rows in backoff at once), Phase A alone can exhaust the entire budget
  // re-confirming them, leaving nothing for Phase B to reach a newer, due row
  // for the same key sitting just past the zone — starving it until the
  // delayed rows age out of backoff. `phaseBReserve` guarantees Phase B always
  // gets to scan at least one page beyond wherever Phase A stopped, so that
  // newer due rows are never skipped purely because the zone happened to be
  // scanLimit-sized. Adding a fixed reserve rather than raising `scanLimit`
  // itself keeps the zone-size invariant Phase A relies on unchanged.
  const phaseBReserve = pageSize;
  const pending: OutboxEntry[] = [];

  // Three persisted cursors per `scanCursorKey` (issue #606 review follow-up,
  // revised for a P1 finding: with the earlier two-cursor design, two or more
  // simultaneously delayed owned rows ahead of a foreign backlog larger than
  // `scanLimit` froze forward progress indefinitely, because the single
  // "fwd" cursor was pinned at the second delayed row's position on every
  // run and any progress Phase B made scanning past it into the backlog was
  // discarded each time.
  //
  // `floorKey` protects the single earliest row this key owns that is still
  // pending after a run (delayed, or repeatedly failing) — a future scan must
  // always be able to reach it, so `floorKey` never advances past its id.
  //
  // `zoneEndKey` (the "fwd"-role derived key, kept from the original design)
  // marks the far edge of the small "protected zone" spanning every row this key currently
  // still owns — from `floorKey` through the *last* one — whenever there is
  // more than one. That whole zone is re-walked in full every run ("Phase A"
  // below), so no still-open row is silently dropped just because bulk
  // scanning has raced ahead of it. The zone stays small across runs: it only
  // ever grows to the position of the furthest *currently* still-open row,
  // never to the confirmed-foreign extent beyond it. When at most one row is
  // still open, `zoneEndKey` is left stale rather than rewritten — `floorKey`
  // advancing past it (once nothing remains to protect) naturally invalidates
  // it, and while exactly one row is open, Phase A's single-row check below
  // covers it without needing the zone walk at all.
  //
  // `bulkKey` (the "bulk"-role derived key) is the pure bulk-scan resume point ("Phase B"
  // below) — the furthest position confirmed foreign/resolved. It advances
  // every run based on how far Phase B actually scanned, independent of how
  // many rows the zone still protects, so forward progress into a large
  // foreign backlog always accumulates across runs instead of being reset to
  // just past the last still-open row found.
  //
  // All three keys come from the single shared derivation in
  // `core/outbox-scan-cursor.ts` (issue #819) — `floor` is `scanCursorKey`
  // verbatim (so cursors persisted before that refactor keep resolving) and the
  // other two are length-prefixed so no two distinct (identity, role) pairs can
  // collide. See `docs/outbox-scan-cursor-contract.md` for the full contract.
  const floorKey = opts.scanCursorKey;
  const zoneEndKey = floorKey ? deriveScanCursorKey(floorKey, "fwd") : undefined;
  const bulkKey = floorKey ? deriveScanCursorKey(floorKey, "bulk") : undefined;
  // Read *before* the three cursors below, never after (issue #820 review
  // follow-up). This run persists the extent it computes from those reads only
  // while this generation still holds, so a retry that rewinds the cursors
  // mid-run is refused rather than overwritten. Reading the fence second would
  // reopen exactly the hole it closes: a rewind landing between the cursor
  // reads and the fence read would leave this run holding pre-rewind cursor
  // values together with a post-rewind generation, and its writes would then
  // pass the fence and re-strand the revived row.
  const cursorFenceEpoch = floorKey ? await readScanCursorFence(outboxStore, floorKey) : undefined;
  const floorAfterId = floorKey ? await outboxStore.getScanCursor(floorKey) : undefined;
  const persistedZoneEndAfterId = zoneEndKey ? await outboxStore.getScanCursor(zoneEndKey) : undefined;
  const zoneEndAfterId =
    persistedZoneEndAfterId !== undefined && persistedZoneEndAfterId > (floorAfterId ?? 0)
      ? persistedZoneEndAfterId
      : undefined;
  const persistedBulkAfterId = bulkKey ? await outboxStore.getScanCursor(bulkKey) : undefined;
  const bulkAfterId =
    persistedBulkAfterId !== undefined && persistedBulkAfterId > (floorAfterId ?? 0)
      ? persistedBulkAfterId
      : undefined;

  let scanned = 0;
  // Matched rows seen this run, in ascending (scan) order, with whether each
  // was due (attempted) or delayed (known open without needing dispatch).
  // Resolved into "still open after this run" once dispatch outcomes are
  // known, below.
  const matchedCandidates: { id: number; due: boolean }[] = [];
  // The furthest id this run can confirm is safe to skip on a future scan:
  // everything up to and including it is either foreign or (once dispatch
  // outcomes are folded in below) resolved. Starts at the previous floor
  // since nothing beyond it has been re-examined yet.
  let scanExtentId: number | undefined = floorAfterId;

  const recordScannedEntry = (entry: OutboxEntry): void => {
    if (!opts.filter || opts.filter(entry)) {
      const due = isEntryDue(entry, now);
      if (due) pending.push(entry);
      matchedCandidates.push({ id: entry.id, due });
    } else {
      scanExtentId = entry.id;
    }
  };

  // Phase A — re-verify every row the persisted state says this key still
  // owns and hasn't resolved, without re-walking the (possibly huge)
  // confirmed-foreign backlog beyond them.
  let zoneCursor = floorAfterId;
  if (floorKey && zoneEndAfterId !== undefined) {
    // Two or more rows were still open last run: walk the whole protected
    // zone from the floor through `zoneEndAfterId`. That span is bounded by
    // whatever a single prior run could scan to build it (at most
    // `scanLimit`), so this is never more expensive than, and is usually far
    // cheaper than, a full bulk scan.
    while (pending.length < limit && scanned < scanLimit && (zoneCursor ?? 0) < zoneEndAfterId) {
      const remaining = Math.min(pageSize, scanLimit - scanned, zoneEndAfterId - (zoneCursor ?? 0));
      const page = await outboxStore.listPendingEntries({ limit: remaining, afterId: zoneCursor });
      if (page.length === 0) break;
      // `zoneCursor` must only advance through entries actually passed to
      // `recordScannedEntry` — if the dispatch cap (`limit`) is hit partway
      // through this page, the remaining rows are never examined and must
      // stay unexamined for the zone-walk-incomplete check below. Jumping
      // `zoneCursor` straight to the fetched page's last id regardless would
      // mark those trailing rows as scanned without ever recording them,
      // letting the post-run cursor math (which narrows the protected zone
      // to just `matchedCandidates`) forget them even though they were never
      // looked at (P1 review follow-up to issue #606).
      let limitHit = false;
      for (const entry of page) {
        if (pending.length >= limit) {
          limitHit = true;
          break;
        }
        recordScannedEntry(entry);
        zoneCursor = entry.id;
      }
      scanned += page.length;
      if (limitHit) break;
      if (page.length < remaining) break;
    }
  } else if (floorKey && bulkAfterId !== undefined) {
    // At most one row was still open last run: it is guaranteed to be the
    // very next pending row after `floorAfterId` (nothing else can sit
    // between them, by the invariant maintained below), so a single 1-row
    // fetch suffices.
    const [row] = await outboxStore.listPendingEntries({ limit: 1, afterId: floorAfterId });
    scanned++;
    if (row) {
      recordScannedEntry(row);
      zoneCursor = row.id;
    }
  }

  // Phase B — bulk forward scan, resuming from whichever is further along:
  // the zone edge Phase A just re-confirmed this run, or the persisted bulk
  // extent (which may already reach past it, from prior runs' accumulated
  // progress). Already confirmed foreign/resolved territory is never
  // re-fetched, and this cursor is never reset back to just past the last
  // still-open row the way the single "fwd" cursor used to be.
  //
  // Exception: if Phase A ran out of `scanLimit` budget before finishing the
  // zone walk (`zoneCursor` still short of `zoneEndAfterId`), `bulkAfterId`
  // must NOT be used to resume here even though it may reach further — it
  // can have been recorded by an earlier, larger-limit run whose bigger
  // `scanLimit` walked past this entire zone in one pass. Jumping to it would
  // skip the zone's unvisited remainder outright, and since that remainder
  // never enters `matchedCandidates`, the persisted zone/floor cursors below
  // would then shrink to just the scanned prefix — permanently forgetting
  // those still-open rows even once their backoff expires (P1 review
  // follow-up to issue #606). Resuming from `zoneCursor` instead lets Phase
  // B's own budget (topped up by `phaseBReserve` below) continue the zone
  // walk in order, so no still-open row is ever skipped over.
  const zoneWalkIncomplete =
    zoneCursor !== undefined && zoneEndAfterId !== undefined && zoneCursor < zoneEndAfterId;
  let afterId: number | undefined = zoneWalkIncomplete
    ? zoneCursor
    : zoneCursor !== undefined && bulkAfterId !== undefined
      ? Math.max(zoneCursor, bulkAfterId)
      : (zoneCursor ?? bulkAfterId);
  // The reserve only kicks in once Phase A has actually consumed the entire
  // `scanLimit` budget re-walking a protected zone — that's the only case
  // that can leave Phase B with zero budget to reach a newer due row past
  // it. When Phase A did little or no work (no zone to walk, or a zone
  // smaller than `scanLimit`), the plain `scanLimit` ceiling already gives
  // Phase B all the remaining budget; adding the reserve on top of that
  // would let a single run scan `scanLimit + phaseBReserve` rows even with
  // no zone in play, silently blowing past a caller-supplied `scanLimit`.
  const phaseAScanned = scanned;
  const scanCeiling = phaseAScanned >= scanLimit ? phaseAScanned + phaseBReserve : scanLimit;
  while (pending.length < limit && scanned < scanCeiling) {
    // Each fetch is capped by the remaining scan allowance, not just `pageSize`,
    // so a caller-supplied `scanLimit` smaller than `pageSize` (e.g. limit: 50,
    // scanLimit: 1) still bounds the rows actually fetched/parsed to `scanLimit`
    // (plus the Phase B reserve) instead of overshooting on the first page.
    const remaining = Math.min(pageSize, scanCeiling - scanned);
    const page = await outboxStore.listPendingEntries({ limit: remaining, afterId });
    if (page.length === 0) break;
    afterId = page[page.length - 1].id;
    scanned += page.length;
    for (const entry of page) {
      if (pending.length >= limit) break;
      recordScannedEntry(entry);
    }
    if (page.length < remaining) break;
  }

  let dispatched = 0;
  let failed = 0;
  let deadLettered = 0;
  const errors: DispatchResult["errors"] = [];

  const providers = opts.providers ?? defaultOutboxProviderFactory;

  // Resolve the two auth domains' runners independently. Repo-host rows
  // (`repohost:pr-comment`) publish to the public repo host and must use
  // repo-host credentials, which in a split-auth session differ from the
  // work-item credentials used for `workitem:*` / legacy `gh:*` rows. Each runner
  // is resolved at most once, and only when a row of its domain is actually
  // pending, so a run carrying only one domain's rows never resolves (or
  // token-exchanges) the other — and a fatal auth *configuration* error surfaces
  // here, before any row is dispatched. `repoHostRunner` defaults to the
  // work-item `runner` for single-auth sessions and existing callers.
  const resolve = async (r: GhRunnerResolver): Promise<GhRunner> =>
    typeof r === "function" ? await r() : r;
  const workItemRunner = pending.some((e) => !isRepoHostEntry(e) && !isSlackEntry(e))
    ? await resolve(runner)
    : undefined;
  const repoHostRunner = pending.some(isRepoHostEntry)
    ? await resolve(opts.repoHostRunner ?? runner)
    : undefined;

  const fetchImpl: FetchFn = opts.fetchImpl ?? (globalThis as unknown as { fetch: FetchFn }).fetch;
  const env = opts.env ?? process.env;
  // Ids resolved this run — sent, or dead-lettered — so no longer pending and
  // safe to skip past when persisting the cursors below.
  const resolvedIds = new Set<number>();
  // Set when maintenance is acquired part-way through this drain (issue #818).
  // Possible even though the run started unlocked: between two rows there is no
  // active claim, so `acquire()`'s outbox-claim check passes and a maintenance
  // pass can legitimately take the lock. From that point every
  // `claimForDispatch` refuses (its own in-transaction check), so the loop
  // stops here rather than spinning through the remaining rows.
  let maintenanceLocked = false;
  // Set when this run's cursor writes are refused because an `admin outbox
  // retry` rewound this identity's cursors after the scan began (issue #820
  // review follow-up). Unlike `maintenanceLocked` it never stops the dispatch
  // loop — every row already claimed is still dispatched and reported — it only
  // suppresses cursor persistence, whose computed values are now stale.
  let cursorFenceStale = false;
  for (const entry of pending) {
    // Atomically claim the row immediately before its external side effect
    // (issue #607 review follow-up): `pending` was built from a `SELECT` scan
    // that ran moments ago, so an `admin outbox cancel` may have landed on
    // this row in the gap since. `claimForDispatch` uses the same atomic
    // claim/check mechanism `cancelEntry` does, so a row a concurrent cancel
    // already won is never dispatched here — skip it without touching
    // dispatched/failed counts.
    //
    // Stamped fresh per entry, not with the batch-start `now` (P2 review
    // follow-up): a sequential batch can take minutes to drain, so reusing
    // `now` here would claim a later entry with an already-stale timestamp —
    // an overlapping dispatcher checking claim staleness against its own
    // current time would then treat that still-active claim as abandoned and
    // reclaim it, dispatching the same row twice. `opts.now`, when supplied,
    // still wins so tests stay deterministic.
    const claimedAt = opts.now ?? new Date().toISOString();
    const claimed = await outboxStore.claimForDispatch(entry.id, claimedAt);
    if (!claimed) {
      // Distinguish "maintenance took the lock" from the ordinary
      // cancelled/foreign-claim reasons (issue #818): the row is untouched and
      // still pending either way, but only the former means every remaining
      // row would refuse too — so stop the drain and report it, instead of
      // walking the rest of `pending` issuing claims that cannot succeed.
      if (await isMaintenanceLocked(outboxStore)) {
        maintenanceLocked = true;
        break;
      }
      // A failed claim does NOT mean this row is resolved (P1 review
      // follow-up): it may be held by a concurrent dispatcher's still-active
      // claim, not a cancel. Folding it into `resolvedIds` unconditionally
      // let the scan cursor advance past a row that was never actually sent,
      // dead-lettered, or cancelled — if the other dispatcher then failed and
      // scheduled a retry, later runs would resume after this id and strand
      // the row forever. Re-read it and only mark it resolved once it is
      // confirmed sent/dead-lettered (cancellation always sets
      // `deadLetterAt` too, per `cancelEntry`); otherwise leave it open so a
      // future scan keeps finding it once the foreign claim clears.
      const fresh = await outboxStore.getById(entry.id);
      if (fresh?.sentAt !== undefined || fresh?.deadLetterAt !== undefined) {
        resolvedIds.add(entry.id);
      }
      continue;
    }
    // Pick the runner for this row's auth domain. The selected runner is
    // guaranteed resolved: its domain was detected as pending above. Slack notification rows
    // (`slack:notification`) use `fetch` directly and never need a runner — they
    // are given `undefined` so a Slack-only batch never triggers credential
    // resolution (e.g. a GitHub App token exchange) for an unrelated auth domain.
    const entryRunner = isRepoHostEntry(entry) ? repoHostRunner : isSlackEntry(entry) ? undefined : workItemRunner;
    // Constructing a row's provider can throw, not just its dispatch: a provider
    // factory that resolves credentials lazily while building its client (e.g. the
    // `gitea` repo-host factory, whose client builder throws when the configured
    // API-token env var is unset) raises synchronously from inside
    // `dispatchEntry`. Catch it here and record a retryable per-entry failure so
    // the dispatcher always returns a structured result. Letting it propagate
    // would abort the drain mid-loop — after earlier rows were already marked
    // sent — and surface as an uncaught stack trace, breaking the single-JSON /
    // deterministic-exit contract n8n depends on. The row stays pending and the
    // (secret-free, config-reference) message is reported, so fixing the config
    // and re-running drains it.
    //
    // The claim is renewed on a timer while the external call is in flight
    // (P1 review follow-up): `gh` and the Slack webhook fetch have no
    // request timeout, so a single slow call can outlive
    // `OUTBOX_CLAIM_STALE_MS`. Without renewal, a concurrent dispatcher's
    // `claimForDispatch` would then treat this still-live claim as abandoned
    // and reclaim + re-dispatch the same row, duplicating the external
    // effect. `renewClaim` is a compare-and-swap on the claim token this
    // attempt currently holds, so a renewal that loses the race (claim
    // already released or reclaimed) is a safe no-op rather than
    // resurrecting a claim this attempt no longer owns.
    let claimToken = claimedAt;
    const renewTimer = setInterval(() => {
      outboxStore
        .renewClaim(entry.id, claimToken)
        .then((renewedAt) => {
          if (renewedAt !== undefined) claimToken = renewedAt;
        })
        .catch(() => {});
    }, OUTBOX_CLAIM_RENEW_MS);
    let result: Awaited<ReturnType<typeof dispatchEntry>>;
    try {
      result = await dispatchEntry(entry, entryRunner, opts.cwd, providers, fetchImpl, env);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearInterval(renewTimer);
    }
    if (result.ok) {
      // Fenced on `claimToken` (P2 review follow-up), the current (possibly
      // renewed) value held above: if this row's claim expired and was
      // reclaimed by another dispatcher while this attempt's external call
      // was still in flight, this completion must not clear that newer claim
      // or duplicate the side effect being reported as sent here.
      //
      // Only counted as dispatched/resolved once `markSent` confirms it
      // actually persisted `sentAt` (P2 review follow-up): a fenced update
      // rejected by a stale claim token is a no-op on the row, but the
      // external side effect already happened — the row's new owner still
      // holds the live claim and will report its own outcome. Counting this
      // rejected completion anyway would advance the scan cursor past a row
      // that is not actually resolved yet; if the new owner then fails and
      // schedules a retry, the row would be stranded behind the cursor.
      const { updated } = await outboxStore.markSent(entry.id, claimedAt, claimToken);
      if (updated) {
        dispatched++;
        resolvedIds.add(entry.id);
      }
    } else {
      failed++;
      errors.push({ id: entry.id, error: result.error });
      // Scheduled from the actual failure time, not the batch-start `now` — a
      // dispatch that blocks for at least the base backoff delay (e.g. the
      // default `gh` runner has no timeout) would otherwise write a past
      // `next_attempt_at` and defeat the backoff entirely (issue #606 review
      // follow-up). `opts.now`, when supplied, still wins so tests stay
      // deterministic.
      const failedAt = opts.now ?? new Date().toISOString();
      // Same claim-token fencing as the success path above.
      const { deadLettered: rowDeadLettered } = await outboxStore.markFailed(
        entry.id,
        result.error,
        failedAt,
        claimToken,
      );
      if (rowDeadLettered) {
        deadLettered++;
        resolvedIds.add(entry.id);
      }
    }
  }

  // Cursor persistence is skipped entirely once maintenance holds the lock
  // (issue #818): `setScanCursor` writes to this database, and the cursors
  // computed from a drain that stopped mid-way would in any case describe a
  // partial run. Leaving them untouched means the next (unlocked) run resumes
  // exactly where the last complete run left off.
  //
  // This flag check is only the fast path. The lock can also be acquired after
  // the final claim resolved but before the writes below run, in which case
  // `maintenanceLocked` is still false here — so each cursor write is itself
  // guarded in-transaction by the store (issue #818 review follow-up) and
  // reports the refusal back through `persistCursor`, which flips the flag so
  // the remaining cursor writes are skipped and the run reports contention.
  //
  // Every write is additionally fenced on the rewind generation read at scan
  // start (issue #820 review follow-up). An `admin outbox retry` can commit
  // while this run is blocked in an external call: it revives a row this run
  // already scanned past (as dead-lettered, so `listPendingEntries` never
  // returned it) and rewinds the cursors that would hide it. The values below
  // were computed before that happened, so persisting them unconditionally
  // would restore the pre-retry positions and re-strand the recovered row for
  // good. A stale fence therefore stops cursor persistence for the rest of this
  // run — like the maintenance case, no cursor advances and the next run
  // resumes from the rewound position — but is reported separately, since it is
  // an operator recovery rather than database contention.
  const persistCursor = async (key: string, id: number): Promise<void> => {
    const { persisted, fenceStale } = await outboxStore.setScanCursor(
      key,
      id,
      floorKey !== undefined && cursorFenceEpoch !== undefined
        ? { identityKey: floorKey, epoch: cursorFenceEpoch }
        : undefined,
    );
    if (persisted) return;
    if (fenceStale) cursorFenceStale = true;
    else maintenanceLocked = true;
  };
  if (floorKey && !maintenanceLocked) {
    // `matchedCandidates` is already in ascending (scan) order. The smallest
    // still-open id becomes the next floor (Phase A / the zone walk protects
    // it); the largest becomes the next zone end whenever more than one row
    // remains open, so *every* still-open row in between stays protected too
    // — not just the first and second. `bulkKey` always takes the furthest
    // confirmed-foreign extent reached this run (never gated by how many
    // rows remain open), so it is never reset back to just past the last
    // protected row and forward progress into a large foreign backlog keeps
    // accumulating across runs.
    const stillOpen = matchedCandidates.filter((c) => !c.due || !resolvedIds.has(c.id)).map((c) => c.id);
    const nextFloor = stillOpen.length > 0 ? stillOpen[0] - 1 : scanExtentId;
    // A computed value of 0 means "nothing confirmed yet" (the open/only row
    // is the very first one) — leave the cursor unset rather than persisting
    // a redundant 0, matching `listPendingEntries`' `afterId ?? 0` default.
    if (nextFloor !== undefined && nextFloor > 0) {
      await persistCursor(floorKey, nextFloor);
    }
    if (!maintenanceLocked && !cursorFenceStale && zoneEndKey && (stillOpen.length > 1 || zoneWalkIncomplete)) {
      // Unlike `floorKey`/`bulkKey` (both `afterId`-style: "resume scanning
      // strictly after this id"), `zoneEndAfterId` is compared against the
      // zone walk's own cumulative cursor (also `afterId`-style) as an
      // inclusive stopping threshold — so it must be the last still-open
      // row's *own* id, not one less, or the walk would stop just short of
      // ever examining that row.
      //
      // When this run's zone walk didn't reach the end of the *previously*
      // known zone (`zoneWalkIncomplete` — whether from `scanLimit` or from
      // the dispatch `limit` filling `pending` mid-zone, per the corrected
      // `zoneCursor` tracking above), `stillOpen`'s last entry only reflects
      // what was actually examined this run, not the true remaining extent.
      // Persisting that narrower value would drop protection for the
      // unexamined tail — rows this key still owns but never got a chance to
      // re-verify this run — even though they were never confirmed
      // foreign/resolved. Floor the next zone end at the prior
      // `zoneEndAfterId` so an incomplete walk can only ever grow the
      // protected zone, never shrink it (P1 review follow-up to issue #606).
      const nextZoneEnd = zoneWalkIncomplete
        ? Math.max(stillOpen[stillOpen.length - 1] ?? 0, zoneEndAfterId ?? 0)
        : stillOpen[stillOpen.length - 1];
      if (nextZoneEnd > 0) {
        await persistCursor(zoneEndKey, nextZoneEnd);
      }
    }
    if (!maintenanceLocked && !cursorFenceStale && bulkKey) {
      // Guarded to be monotonic: a run whose Phase B loop never executes (or
      // never crosses a foreign row) must not regress the bulk cursor behind
      // progress an earlier run already confirmed.
      const nextBulk = Math.max(scanExtentId ?? 0, persistedBulkAfterId ?? 0);
      if (nextBulk > 0) {
        await persistCursor(bulkKey, nextBulk);
      }
    }
  }

  return {
    dispatched,
    failed,
    errors,
    deadLettered,
    ...(maintenanceLocked ? { maintenanceLocked: true } : {}),
    ...(cursorFenceStale ? { cursorFenceStale: true } : {}),
  };
}

/**
 * Whether the store reports a held whole-file maintenance lock (issue #818).
 * A store without the capability (in-memory implementations, test fakes) has
 * no such lock and is treated as unlocked. Read-only, and never a substitute
 * for the store's own in-transaction guards — see
 * {@link OutboxStore.claimForDispatch}.
 */
async function isMaintenanceLocked(outboxStore: OutboxStore): Promise<boolean> {
  return outboxStore.isMaintenanceLocked ? await outboxStore.isMaintenanceLocked() : false;
}

/**
 * The identity's current rewind generation (issue #820 review follow-up), or
 * `undefined` when the store has no fence capability — in which case this run's
 * cursor writes stay unfenced, exactly as before #820. `undefined` deliberately
 * does not collapse to `0`: a store without the capability also has no retry
 * that could bump it, whereas passing `0` to a store that *does* support fences
 * would claim "no retry has ever rewound this identity" without having read it.
 */
async function readScanCursorFence(
  outboxStore: OutboxStore,
  identityKey: string,
): Promise<number | undefined> {
  return outboxStore.getScanCursorFence ? await outboxStore.getScanCursorFence(identityKey) : undefined;
}

/**
 * Whether an outbox row belongs to the repo-host auth domain (a public-repo-host
 * publication) rather than the work-item domain. Used to route each row to the
 * runner resolved from the matching provider auth.
 *
 * Two row shapes qualify:
 *  - the provider-neutral `repohost:pr-comment` topic enqueued by the current
 *    code; and
 *  - legacy PR-timeline rows enqueued by the *old* code as `gh:comment` with the
 *    trailing `:pr` idempotency-key token (see {@link isLegacyPrCommentEntry}).
 *
 * The legacy case matters on upgrade: a PR comment queued before the split-auth
 * change still has topic `gh:comment`, so without this check it would be treated
 * as a work-item row and dispatched under work-item credentials (or stranded for
 * a non-GitHub work-item session). Classifying it here makes split-auth routing
 * apply to already-queued PR comments too — the row is dispatched with the
 * repo-host runner, posting the public PR comment under repo-host credentials.
 */
function isRepoHostEntry(entry: OutboxEntry): boolean {
  return (
    entry.payload.topic === "repohost:pr-comment" ||
    entry.payload.topic === "repohost:pr-summary" ||
    isLegacyPrCommentEntry(entry)
  );
}

/**
 * Whether an outbox row is a legacy PR-timeline comment enqueued by the pre-
 * split-auth code: topic `gh:comment` with an idempotency key ending in the `:pr`
 * token. That suffix was appended only to the review-phase PR-timeline enqueue
 * (`…:gh:comment:<phase>:<result>:pr`); no other `gh:comment` key ends in `:pr`,
 * so the token unambiguously distinguishes a PR comment from an issue comment.
 * Such a row carries the PR number in `payload.issueNumber` and still dispatches
 * through the `gh:comment` case — only its auth domain is reclassified.
 */
function isLegacyPrCommentEntry(entry: OutboxEntry): boolean {
  return entry.payload.topic === "gh:comment" && entry.idempotencyKey.endsWith(":pr");
}

/**
 * Whether an outbox row belongs to the Slack notification domain. Slack rows
 * dispatch via `fetch` only and never require a GitHub runner, so they must be
 * excluded from the work-item runner resolution check: a Slack-only batch
 * should not trigger a GitHub App token exchange or any GitHub auth side-effect.
 */
function isSlackEntry(entry: OutboxEntry): boolean {
  return entry.payload.topic === "slack:notification";
}

/**
 * Whether an outbox row is currently eligible for another dispatch attempt: it
 * has never failed (no `nextAttemptAt`), or its backoff delay has elapsed as
 * of `now`. `listPendingEntries` returns delayed rows too (issue #606 review
 * follow-up), so the scan loop checks this itself before treating a scanned
 * row as dispatch-eligible this run.
 */
function isEntryDue(entry: OutboxEntry, now: string): boolean {
  return !entry.nextAttemptAt || entry.nextAttemptAt <= now;
}

// ---------------------------------------------------------------------------
// Per-entry dispatch
// ---------------------------------------------------------------------------

async function dispatchEntry(
  entry: OutboxEntry,
  runner: GhRunner | undefined,
  cwd: string,
  providers: OutboxProviderFactory,
  fetchImpl: FetchFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { payload } = entry;
  const repo = `${payload.owner}/${payload.repo}`;

  switch (payload.topic) {
    // -----------------------------------------------------------------------
    // Legacy GitHub-specific topics — dispatch directly against GitHub Issues,
    // preserving the exact `gh` argv. Unchanged so existing sessions keep their
    // observable behavior.
    // -----------------------------------------------------------------------
    case "gh:comment": {
      const provider = new GhWorkItemProvider(runner!, repo, cwd);
      // A legacy PR-timeline row (queued by pre-split-auth code with the `:pr`
      // idempotency token) is a public Tier 2 comment whose stored body may
      // carry a raw review reason/excerpt the visibility policy now keeps off
      // public PR comments. Rebuild a public-safe summary before posting it.
      // Plain issue-side `gh:comment` rows are Tier 1 and dispatched unchanged.
      const body = isLegacyPrCommentEntry(entry)
        ? sanitizeLegacyPrCommentBody(payload.body)
        : payload.body;
      return provider.commentItem(payload.issueNumber, body);
    }
    case "gh:label:add": {
      const provider = new GhWorkItemProvider(runner!, repo, cwd);
      return provider.transitionItem(payload.issueNumber, { kind: "add-label", label: payload.label });
    }
    case "gh:label:remove": {
      const provider = new GhWorkItemProvider(runner!, repo, cwd);
      return provider.transitionItem(payload.issueNumber, { kind: "remove-label", label: payload.label });
    }

    // -----------------------------------------------------------------------
    // Provider-neutral topics — construct the provider from the configured kind
    // and route through the WorkItemProvider / RepoHostProvider interface.
    // -----------------------------------------------------------------------
    case "workitem:comment": {
      const provider = providers.workItem(payload.provider, repo, cwd, runner!);
      if (!provider) return unsupportedProvider("work-item", payload.provider);
      return provider.commentItem(payload.issueNumber, payload.body);
    }
    case "workitem:transition": {
      const provider = providers.workItem(payload.provider, repo, cwd, runner!);
      if (!provider) return unsupportedProvider("work-item", payload.provider);
      return provider.transitionItem(payload.issueNumber, payload.transition);
    }
    case "repohost:pr-comment": {
      const provider = providers.repoHost(payload.provider, repo, cwd, runner!);
      if (!provider) return unsupportedProvider("repo-host", payload.provider);
      return provider.commentPullRequest(String(payload.prNumber), payload.body);
    }

    case "repohost:pr-summary": {
      const provider = providers.repoHost(payload.provider, repo, cwd, runner!);
      if (!provider) return unsupportedProvider("repo-host", payload.provider);
      return provider.upsertStickyPrComment(payload.prNumber, payload.marker, payload.body);
    }

    case "slack:notification": {
      return dispatchSlackNotification(payload, fetchImpl, env);
    }

    default: {
      const never: never = payload;
      return { ok: false, error: `Unknown outbox topic: ${(never as OutboxEntry["payload"]).topic}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Slack webhook dispatch (issue #465)
// ---------------------------------------------------------------------------

/**
 * Build a concise Slack message body from a `slack:notification` outbox payload.
 * Only public-safe fields are included — no local paths, no secrets, no raw
 * agent output. The webhook URL is resolved from the env var at dispatch time
 * and never stored; `payload.webhookUrlEnv` is just its name.
 */
function buildSlackMessage(payload: SlackNotificationPayload): Record<string, unknown> {
  const header = payload.transition === "failed"
    ? `*Failed* — issue #${payload.issueNumber} (session: \`${payload.sessionId}\`)`
    : `*Ready for human* — issue #${payload.issueNumber} (session: \`${payload.sessionId}\`)`;
  const lines: string[] = [
    header,
    `Phase: \`${payload.phase}\``,
  ];
  if (payload.reason) lines.push(payload.transition === "failed" ? `Error: ${payload.reason}` : `Reason: ${payload.reason}`);
  if (payload.issueUrl) lines.push(`Issue: ${payload.issueUrl}`);
  if (payload.prUrl) lines.push(`PR: ${payload.prUrl}`);
  return { text: lines.join("\n") };
}

async function dispatchSlackNotification(
  payload: SlackNotificationPayload,
  fetchImpl: FetchFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const webhookUrl = env[payload.webhookUrlEnv];
  if (!webhookUrl) {
    return { ok: false, error: `Slack webhook URL env var not set: ${payload.webhookUrlEnv}` };
  }
  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSlackMessage(payload)),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Slack webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!response.ok) {
    // Read body text for the error message but cap it to avoid huge payloads
    // entering the error log. Failure to read the body is a soft error — the
    // HTTP status is still surfaced.
    let detail = "";
    try {
      detail = ` — ${(await response.text()).slice(0, 200)}`;
    } catch {
      // body unreadable — status alone is enough
    }
    return { ok: false, error: `Slack webhook returned HTTP ${response.status}${detail}` };
  }
  return { ok: true };
}

/**
 * A provider-neutral row whose kind has no wired implementation. Reported as a
 * retryable failure (not silently dropped) so the row stays pending until the
 * provider is enabled.
 */
function unsupportedProvider(role: string, provider: string): { ok: false; error: string } {
  return { ok: false, error: `Unsupported ${role} provider: ${provider}` };
}
