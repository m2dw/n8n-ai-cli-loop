# Retention, Archival, Pruning, and SQLite Backup Contract

Status: **specification only** (issue #610) — deliverable of the architecture
review triage (`docs/DOMAIN.md` §4 finding 2). This document defines the
behavioral contract for destructive maintenance of the loop's local SQLite
state and `.n8n-artifacts/runs/` tree. **It contains no implementation.**
Follow-up implementation is tracked by #611, which per the triage DAG splits
into three issues — backup, archive, prune — each scoped in §13 below.

Audience: humans and AI sessions implementing #611's split issues, and anyone
reviewing a later PR against this contract.

## 1. Why a contract before code

Tasks, task events, outbox rows, idempotency-key rows, context records, and
run artifacts under `.n8n-artifacts/runs/` currently grow without any
lifecycle policy — nothing ever deletes them. Two things make "just add a
prune command" unsafe without this document first:

- **Historical events are now evidence.** `core/l3-intervention-aggregation.ts`
  (issue #588) and the issue-plan history/calibration tooling
  (`cli/issue-plan-history.ts`) read raw `events`/`tasks` rows to compute
  intervention-rate and workflow-quality metrics. Indiscriminate deletion
  destroys the only source for those metrics.
- **Per `docs/DOMAIN.md` §2.3 (Operation context)**, retention/backup get
  "explicit store-level ports" — not raw SQL. `docs/admin-resource-boundaries-contract.md`
  §8.1 already flags `interventions` opening its own raw `better-sqlite3`
  handle as a boundary violation to fix, not prior art to copy. Any future
  prune/archive command must go through `TaskStore`/`OutboxStore`-owned ports,
  never a raw `DELETE`/`VACUUM` issued from `admin.ts`.

## 2. Scope and non-goals

In scope: the behavioral rules that a later implementation must satisfy for
retention floors, archival/rollup, DB↔artifact linkage, backup/restore,
preview/confirmation/locking/failure behavior, multi-session isolation,
disk-pressure handling, and exclusions.

Out of scope (explicitly deferred to #611's split issues, §13):
- Concrete CLI command names/flags, store method signatures, SQL, schedule/cron
  wiring.
- Worktree lifecycle pruning (`admin worktree prune`/`cleanup`) — already
  specified in `docs/per-issue-worktrees.md`; this contract's exclusions (§12)
  explicitly keep worktrees out of its own scope rather than duplicating that
  document.
- Lock recovery (`repo-lock`, `worktree release-lock`, `review-lock`) — already
  specified; §12 excludes locks from retention/prune by reference, not by
  redefinition.

## 3. Data class inventory

| Data class | Storage | Owning context (`DOMAIN.md` §2.3) | Grows unbounded today? |
|---|---|---|---|
| Task rows | `tasks` table, `stores/sqlite-task-store.ts` | Orchestration | Yes — never deleted |
| Task events | `events` table, same store | Orchestration | Yes — append-only |
| Outbox rows | `outbox` table, `stores/sqlite-outbox-store.ts` | Delivery | Yes — dead-letter marks, never deletes |
| Context records | `context_records` table, `stores/sqlite-context-store.ts` | Intake (`admin-resource-boundaries-contract.md` §8.2) | Yes, but tiny (one row per `context create` call) |
| Run artifacts | `<artifactRoot>/runs/<run-id>/` on disk | Execution | Yes — one directory per phase run |
| `repositories` table | `stores/sqlite-task-store.ts` | Orchestration | No — one row per distinct `owner/name`, not per-event |
| `outbox_scan_cursor` table | `stores/sqlite-outbox-store.ts` | Delivery | No — one row per scan key, overwritten in place |
| `outbox_scan_cursor_fence` table | `stores/sqlite-outbox-store.ts` | Delivery | No — one row per dispatch identity, incremented in place (issue #820) |
| `runs` table (`sqlite-task-store.ts` schema) | — | — | **Dead schema**: defined by `CREATE TABLE`, never written or read anywhere in the codebase. Out of scope for this contract; a candidate for a separate schema-cleanup issue, not for a retention floor |
| `idempotency_keys` table (both stores) | — | — | **Dead schema**, same as above. Outbox de-duplication is actually enforced by the `UNIQUE` constraint on `outbox.idempotency_key`, not this table. Out of scope for the same reason |

Rows that are small dimension tables or already self-overwriting
(`repositories`, `outbox_scan_cursor`, `outbox_scan_cursor_fence`) need no
retention floor — they do not
accumulate history to prune. The two dead tables need no floor because
nothing ever populates them; a later cleanup issue may drop them, but that is
schema hygiene, not retention policy, and must not be bundled into #611.

## 4. Record lifecycle taxonomy

Every prunable row must be classified into exactly one of: **active**,
**delayed**, **human-gated**, **terminal**, **cancelled**, **dead-letter**.
This section maps the taxonomy onto enums that already exist in code — it
does not invent new statuses.

**Task rows** (`core/task.ts` `TaskStatus`, `cli/admin.ts` `classifyStatus`):

| Taxonomy bucket | `TaskStatus` / classification |
|---|---|
| Active | `claimed`, `running` (including stale-claim, per `classifyStatus`'s `stale`/`running` split — staleness is a recovery concern, not a retention one); **and** `queued` with no `notBefore`, or `notBefore` already in the past (`classifyStatus`'s `runnable`) — this is the standard waiting-for-worker state, not idle history, and must never be treated as eligible for pruning |
| Delayed | `queued` with `notBefore` in the future (`waiting_retry`) |
| Human-gated | `ready_for_human` (covers `waiting_for_tool_request`, `capped`, and plain `needs_human`) and `blocked` |
| Terminal | `done`, `failed` |
| Cancelled | `cancelled` (issue #608 — terminal, but tracked separately because its retention floor differs, §5) |
| Dead-letter | not applicable to tasks — no task-level dead-letter concept exists |

**Task events**: events have no status of their own; an event's bucket is its
**owning task's current bucket** at evaluation time. An event belonging to an
active, delayed, or human-gated task is never eligible for pruning regardless
of the event's own age.

**Outbox rows** (`stores/sqlite-outbox-store.ts` columns, `core/outbox.ts`):

| Taxonomy bucket | Column state |
|---|---|
| Active | `sent_at IS NULL AND dead_letter_at IS NULL AND cancelled_at IS NULL` and due now or claimed |
| Delayed | same, but `next_attempt_at` in the future |
| Terminal | `sent_at IS NOT NULL` (delivered) — takes **precedence** over Cancelled (see note below) |
| Cancelled | `cancelled_at IS NOT NULL AND sent_at IS NULL` — takes **precedence** over Dead-letter (see note below) |
| Dead-letter | `dead_letter_at IS NOT NULL AND cancelled_at IS NULL AND sent_at IS NULL` |

**Sent/cancelled precedence.** `cancelEntry` only cancels a row whose claim is
unset or stale (`WHERE ... AND (claimed_at IS NULL OR claimed_at <= ?)`,
`stores/sqlite-outbox-store.ts`) precisely because, per that method's own
comment, "a dispatcher that already claimed this row via `claimForDispatch`
may be mid-flight on the external side effect, and once it has performed that
effect no cancellation can un-do it." A claim being *stale* means presumed
dead, not guaranteed dead: the original dispatcher can still be alive and
complete its send after cancellation has already set `cancelled_at`.
`markSent`'s claim-fenced `UPDATE` (`WHERE id = ? AND claimed_at = ?`) does
not check `cancelled_at`, so that late completion succeeds and stamps
`sent_at` over an already-cancelled row — a real race in the current store,
not a hypothetical. Since every row must fall into exactly one bucket (§4),
**Terminal (sent) takes precedence over Cancelled**: a row with both columns
set is classified Terminal, not Cancelled. Unlike the dead-letter case below,
this is not a question of whose *intent* is more authoritative — `sent_at`
means the external side effect (e.g., a GitHub comment or label change)
already irreversibly happened, so the cancellation attempt did not, in fact,
prevent delivery, and the row's true state is "delivered" regardless of the
operator's cancellation timestamp.

**`sent_at` is not guaranteed to be the later timestamp on a raced row.**
`gh-dispatcher.ts` calls `markSent(entry.id, claimedAt, claimToken)` with the
*original* `claimedAt` it captured before dispatching (`handlers/
gh-dispatcher.ts`), not the time the external send actually completed. Because
`cancelEntry` only cancels a claim that is already at or before the staleness
threshold (`WHERE ... AND (claimed_at IS NULL OR claimed_at <= ?)`), the
`claimedAt` that ends up stamped as `sent_at` on a raced row necessarily
predates `cancelled_at`, not follows it — the opposite of "always the same or
a later anchor." Counting this row's 30-day terminal-sent floor from `sent_at`
alone would therefore let its retention window start, and its floor expire,
before the row was even cancelled — less conservative than the cancelled
floor, not more. This section's floor for such a row is instead **counted
from `MAX(sent_at, cancelled_at)`** (§5) — the later of the two timestamps, or
a true delivery-completion timestamp if a later implementation adds one —
never `sent_at` alone. Any rollup covering such a row (§6) must record it
under its sent/delivered accounting, not a cancellation count; only the floor
anchor changes, not the bucket classification above.

**This is not limited to the cancellation race — `sent_at` understates
completion time for every successful send.** `claimedAt` (the value stamped
into `sent_at`) is captured once, immediately before `dispatchEntry` is
called, and `markSent(entry.id, claimedAt, claimToken)` passes that same
pre-dispatch value regardless of whether this attempt ever raced a
cancellation. The external call it is dispatching — the `gh` runner or the
Slack webhook `fetch` — has no request timeout, which is precisely why this
same call site renews the row's claim on a timer while the call is in flight
("a single slow call can outlive `OUTBOX_CLAIM_STALE_MS`," `handlers/
gh-dispatcher.ts`): the implementation already assumes a single dispatch can
run for an unbounded, potentially long duration. A row whose send takes days
still gets `sent_at` stamped at the moment the attempt *started*, not the
moment the side effect actually happened, so counting the 30-day
terminal-sent floor (§5) from `sent_at` can make an entirely ordinary,
uncancelled, successful send eligible for pruning within days of dispatch
starting — immediately upon completion if the call ran for the full 30-day
floor, and never fewer than 30 days after the true completion time only by
coincidence. `MAX(sent_at, cancelled_at)` does not help here: a normal
successful send has no `cancelled_at` to take the max against. **The floor
must instead be anchored on a true completion timestamp, captured after the
external effect resolves, for every successful send — not only a raced
one.** §13 item 3c requires `gh-dispatcher.ts` to capture that timestamp
immediately after `dispatchEntry` returns and pass it to `markSent` in place
of `claimedAt` (the existing `claimToken` fencing parameter is unaffected —
it already carries the claim's own identity separately from the value being
stamped into `sent_at`). Until that fix lands, no persisted column reflects
true completion time for any sent row, so §5's terminal-sent floor is **not
yet enforceable**: a prune pass must not delete a terminal-sent outbox row on
the strength of `sent_at` alone, for the same reason a context record cannot
be pruned before §13 item 3b closes the reachability gap — age past a floor
computed from an anchor that is not a lower bound on the event it is
supposed to measure is not a safe precondition for deletion.

**Cancelled/dead-letter precedence.** Operator cancellation (issue #607,
`OutboxStore.cancel`) sets `dead_letter_at = COALESCE(dead_letter_at, ?)`
*together with* `cancelled_at` in the current store
(`stores/sqlite-outbox-store.ts`), so a manually cancelled row also has
`dead_letter_at IS NOT NULL` whenever it was cancelled after exhausting
retries (the common case). Since every row must fall into exactly one bucket
(§4), **Cancelled takes precedence over Dead-letter**: a row with both
columns set (and `sent_at IS NULL`, per the precedence above) is classified
Cancelled, not Dead-letter. This is a deliberate choice, not an arbitrary
tie-break — an operator's explicit cancellation is the more specific and more
recent signal of intent than an automatic retry-exhaustion mark, so the row
gets the 30-day cancelled floor, not the 90-day dead-letter floor.

**Context records**: no status column exists (`context_id`, `session_id`,
`created_at` only) — and, critically, `tasks` has **no `context_id` column**
either, so there is no persisted, queryable link from a task row to the
context record(s) it uses. The only place `contextId` appears anywhere today
is inside individual event JSON payloads written by `core/phase-runner.ts`
once a phase actually starts (`events.data.contextId`). A context created
before its owning task's first phase starts — e.g. `context create` run ahead
of `run-one-phase`, or a task still sitting in the delayed bucket — has no
such event yet, so it would look orphaned even though the workflow still
needs it.

Reachability as a task-row check is therefore **not implementable against the
current schema**, and this contract does not treat it as a defined bucket
until that gap is closed. No context record may be classified as orphaned, or
made eligible on any age basis, until #611's split issues add one of:
- a `context_id` column on `tasks`, set at `context create`/task-creation
  time (not inferred after the fact from events);
- an explicit lifecycle marker on `context_records` itself (e.g. a
  `released_at` column written when the last task known to reference it
  reaches a terminal or cancelled state); or
- a reachability scan that also covers `events.data.contextId` in addition to
  `tasks`, if a later implementation can show that is sufficient coverage —
  this contract mandates that the check be backed by persisted, queryable
  data, not a specific schema shape.

Until one of these exists, context records are **excluded from pruning
outright, regardless of age** (§12) — the same fail-closed posture as the
outbox session-scoping gap in §10. Age alone never makes a context record
eligible even once reachability is implementable; reachability does (§5).

**Tool Requests**: not a separate table — embedded in `task.context.toolRequest`
(`core/tool-request.ts`, `StoredToolRequest.resolved`). A task carrying an
unresolved Tool Request (`resolved !== true`) is **excluded** from every
bucket above regardless of its nominal task status (§12) — this is an
exclusion, not a taxonomy bucket, because it can co-occur with any status.

## 5. Minimum retention periods

These are **floors**: a later implementation may make retention configurable
per session, but no configuration may set a period shorter than the floor
here, and the default must equal the floor.

| Data class | Floor | Starts counting from |
|---|---|---|
| Task row + its events, while active/delayed/human-gated | **Never** eligible, at any age | n/a |
| Task row + its events, terminal (`done`/`failed`) | 180 days, **and** a covering rollup (§6) must already exist | task's terminal transition (`updated_at` at the transition, not `created_at`) |
| Task row + its events, cancelled | 30 days, **and** a covering rollup (§6) must already exist | task's cancellation (issue #608's `cancelTask`) |
| Outbox row, terminal (sent) | 30 days, **and** a covering rollup (§6) must already exist — **and not yet enforceable**; blocked until §13 item 3c's true completion timestamp lands (§4) | the completion timestamp captured after dispatch (§13 item 3c), or `MAX(<that timestamp>, cancelled_at)` for a row that also carries `cancelled_at` (the raced case, §4) — never the pre-dispatch `claimedAt` currently stamped into `sent_at` |
| Outbox row, cancelled | 30 days, **and** a covering rollup (§6) must already exist | `cancelled_at` |
| Outbox row, dead-letter | 90 days, **and** a covering rollup (§6), **and** an operator export/acknowledgment | `dead_letter_at` |
| Context record, orphaned (unreachable, §4) | 30 days — **not yet enforceable**; blocked until §4's reachability gap is closed | `created_at` |
| Run artifact directory | tied to its owning task/run's floor above, never shorter (§7) | n/a — derived |

Rationale for the asymmetry: cancelled tasks and dead-lettered outbox rows get
*shorter* task-floor-equivalent windows than normal completions because their
raw existence (not just their content) is itself diagnostic signal that an
operator or a later metrics pass needs a chance to see; dead-letters get the
*longest* floor of the three because #607's whole purpose is giving an
operator time to inspect and requeue them before they vanish.

Every task and outbox floor above requires its covering rollup (§6) as an
**and**, not an alternative — age past the floor is necessary but never
sufficient. §6 and §12 state the same rule categorically ("no raw
task/event/outbox-history deletion without a covering rollup"); this table
restates it per-row so each floor is self-contained, not to carve out an
exception. Context records are rollup-exempt because §6's rollup exists to
preserve intervention/outcome *metrics*, and context records carry no metrics
signal of their own — but they remain blocked on the separate reachability
gap noted above and in §4.

Outbox pruning/rollups are additionally gated on §10's session-association
gap: until `outbox` has a persisted `session_id`, the floors above can only be
applied file-wide, never per-session.

The terminal-sent floor is additionally gated on §13 item 3c: until
`gh-dispatcher.ts` is fixed to capture and pass a true post-dispatch
completion timestamp (§4), `sent_at` reflects the pre-dispatch claim time, not
completion, and a prune pass must treat every terminal-sent row as ineligible
regardless of age rather than anchor its floor on that value.

A row already past its floor is merely **eligible** — §9 governs whether a
prune pass actually removes it (batching, locking, backup precondition).

## 6. Historical rollup required before raw deletion

No raw task/event/outbox-history deletion may occur for a session unless a
**rollup** covering that session's full to-be-deleted time window already
exists and has been durably written to a **dedicated rollup table in the
same SQLite database the raw rows live in** — not a `.n8n-artifacts/`
filesystem artifact. This is a hard constraint on the storage choice, not an
implementation option left open for #611: a filesystem-artifact rollup has no
owning `run-id` for §7's artifact-retention linkage to protect it, so it
would be indistinguishable from an orphaned directory to §7's orphan sweep
and could be removed by ordinary artifact pruning while still the sole
surviving copy of the counts it covers — and it would sit entirely outside
§8's SQLite backup, so a restore performed after such a sweep could not
recover it either, leaving `admin interventions` and `issue-plan-history`
unable to reconstruct the window the prune's coverage check had certified as
covered. A dedicated table has neither failure mode: `db.backup(path)` (§8)
copies the whole database file, so every §8 backup captures the rollup table
along with the rows it covers, and §7's artifact-directory deletion and
orphan sweep only ever act on `.n8n-artifacts/runs/<run-id>/` directories, so
a rollup stored in-database is never a candidate for either. The rollup must
be sufficient to reproduce, without the raw rows:

- **L3 intervention counts by kind, per issue, at per-event granularity** —
  per the taxonomy in `core/intervention-taxonomy.ts` and the event mapping in
  `core/l3-intervention-aggregation.ts` (`L3_EVENT_TYPE_MAP`). The rollup must
  retain each intervention as its own record keyed by
  `(issue_number, kind, event_timestamp, event_id)` — **not** a per-day or
  per-session-lifetime total, and **not** `(issue_number, kind,
  event_timestamp)` alone. Millisecond timestamps are not unique: two L3
  events can share an issue, kind, and `created_at` millisecond under
  concurrent commands or repeated operations that stamp the same `now`, and a
  timestamp-only key would collapse them into one rollup row, undercounting
  every subsequent `admin interventions` run once the raw `events` rows are
  pruned. `event_id` is the source `events.id` (the table's `AUTOINCREMENT`
  primary key, per `stores/sqlite-task-store.ts`) for an entry derived from an
  actual event row; §6's task-context-fallback bullet below defines the
  identity to use for entries that have no backing event row. `admin
  interventions --issue-number N` reports
  counts scoped to a single issue (the `byIssue` breakdown), and
  `admin interventions` also accepts arbitrary `--since`/`--until` timestamp
  ranges (`cli/admin.ts`); a coarser bucket — daily or one total per session —
  can reconstruct neither the per-issue attribution nor an arbitrary sub-day
  time window from what survives pruning. The rollup's grain must be at least
  as fine as `admin interventions`'s current output on both axes (issue and
  timestamp), not merely "not coarser" by some looser reading of that bar.
- **Task-context-derived tool-request interventions, not just mapped events.**
  `aggregateL3Interventions`'s task-context fallback (`L3_EVENT_TYPE_MAP`'s
  event path has no *matching row within the query's own window*, but the
  task's `context.toolRequest.resolved === true`) counts a
  `tool_request_resolution` intervention for a legacy or partial-history task
  — this is not a hypothetical edge case, it is the documented behavior at
  `core/l3-intervention-aggregation.ts`'s task-context fallback. "No matching
  row within the query's own window" is **not** the same as "no
  `tool_request_*` event anywhere in the task's history": the aggregator's
  suppression check (`bySig?.["tool_request_resolution"] > 0`) is built only
  from the `since`/`until`-filtered event rows for that issue, so a task with
  an actual `tool_request_*` event whose `created_at` falls *outside* a
  requested `--since`/`--until` window still trips the fallback for that
  bounded query — and the fallback's own window check then applies the
  query's bounds to `toolRequest.resolution.resolvedAt` (falling back to
  `toolRequest.resolvedAt`), not to the event's `created_at`. A task can
  therefore have an old, out-of-window event and still contribute a
  fallback-derived count to a bounded report whose window covers only its
  `resolvedAt`. (For the default *unbounded* query — no `since`/`until`
  supplied — every event for the issue is in-window by construction, so the
  fallback fires only when the issue truly has no qualifying event anywhere in
  history; that is the one case where "no event at all" accurately describes
  the trigger, and it falls out of the general reconstruction rule below as
  the unbounded-window special case.)

  A rollup that only persists the per-`(issue_number, kind, event_timestamp,
  event_id)` records derived from the bullet above silently drops this
  fallback-derived intervention the moment the task row it depends on is
  pruned, understating every subsequent `admin interventions` run relative to
  what it would have reported before pruning. The rollup must therefore also
  persist, for **every** task with `context.toolRequest.resolved === true` —
  regardless of whether that same task also has one or more `tool_request_*`
  events persisted under the bullet above, since whether the fallback fires
  for a given report depends on that report's window, not on whether an event
  exists somewhere in the task's full history — the issue number, the
  `tool_request_resolution` kind, and the resolution timestamp the fallback
  itself uses (`toolRequest
  .resolution.resolvedAt`, falling back to `toolRequest.resolvedAt`) — recorded
  as its own `(issue_number, kind, event_timestamp, event_id)` entry alongside
  the event-derived ones, not folded into a separate count that
  `admin interventions`'s per-issue/per-window output can't distinguish from
  the event-derived signal. This entry has no backing `events` row, so
  `event_id` is the task's own `session_id` (part of the `tasks` table's
  `(session_id, issue_number)` primary key, per `stores/sqlite-task-store.ts`)
  rather than an `events.id` — a task trips this fallback at most once per
  kind, so `session_id` is a sufficient unique identity here, matching the
  reproducibility bar the `event_id` column exists to satisfy without
  requiring a synthetic row id where none exists.

  **Reconstruction must apply the same window-scoped suppression rule the
  live aggregator applies, not a presence/absence check on the raw event
  history.** A reader (bounded or unbounded) reconstructing a report from the
  rollup must exclude a task's fallback entry from its count only when an
  event-derived entry for the *same issue* — from the bullet above — has an
  `event_timestamp` inside the report's own queried window (`[since,
  until)`, or unconditionally "in window" when neither bound is supplied);
  otherwise the fallback entry must be included. This is what lets a bounded
  report reconstructed after pruning match what `aggregateL3Interventions`
  would have returned against the pre-prune raw tables for that same window,
  including the case where the event's `created_at` predates the report's
  `--since` but the task's `resolvedAt` falls inside it: pruning the old event
  row must not also discard the fallback entry, and the fallback entry must
  not be suppressed by an event that is itself outside the window being
  queried.

  **A task whose fallback timestamp cannot be
  resolved is still counted by an unbounded query, and the rollup must
  preserve that count.** The timestamp-resolution/skip logic
  (`core/l3-intervention-aggregation.ts`) only runs inside the aggregator's
  `since !== undefined || until !== undefined` branch — when neither bound is
  supplied (the default, unbounded `admin interventions` invocation), the
  fallback's `tool_request_resolution` count is added unconditionally, with no
  timestamp check at all. Only a *bounded* `--since`/`--until` query skips a
  task whose fallback timestamp cannot be resolved. Pruning such a task's row
  on the premise that its fallback contributes nothing would therefore
  silently reduce every subsequent unbounded `admin interventions` total by
  one, contradicting this contract's reproducibility requirement. The rollup
  must retain this count regardless of whether a resolvable timestamp exists:
  persist the entry with `event_timestamp` recorded as an explicit
  unknown/null sentinel (never omitted, and never defaulted to the rollup's
  own generation time) when neither `toolRequest.resolution.resolvedAt` nor
  `toolRequest.resolvedAt` is present — `event_id` (the task's `session_id`,
  per above) is still recorded even when `event_timestamp` is the unknown
  sentinel, so an unbounded reader still sees the
  count while a bounded reader can still exclude it precisely because the
  timestamp is marked unknown rather than fabricated. Equivalently, a later
  implementation may instead keep such a task's row out of prune eligibility
  entirely until this rollup entry exists. Either approach satisfies this
  bullet; treating an unresolvable fallback timestamp as "nothing to persist"
  and pruning the row anyway does not.
- **Unobservable-signal accounting** — the rollup must record which
  `InterventionSignalKind`s were unobservable for the pruned window (mirroring
  `UNOBSERVABLE_L3_SIGNALS`), so a later reader never mistakes "no raw events
  survived to check" for "zero interventions occurred."
- **Per-issue calibration summary, not terminal-status tallies** —
  `cli/issue-plan-history.ts` derives its workflow-quality/difficulty output
  for an issue from that task's per-phase `attempts` map, intermediate
  review-loop outcomes (pass vs. cap-handoff, read from `events` and the
  generated `gh:comment` outbox rows' stored markers), `task.context`, and the
  full `events` history for that task — not merely a count of terminal
  statuses per phase. A rollup that records only `done`/`failed`/`cancelled`
  counts per `TaskPhase` cannot reproduce `issue-plan-history`'s finality
  (`final`/`incomplete`/`unknown`) or difficulty classification for any
  individual issue once the raw rows are gone. The rollup must instead
  persist, per issue, either (a) `issue-plan-history`'s already-derived output
  for that issue (finality, finality reason, final status/phase, per-phase
  attempt counts, difficulty), captured at rollup time, or (b) a record
  retaining the specific fields that output is computed from (per-phase
  attempt counts, intermediate review outcomes, and the relevant comment
  markers). An aggregate that collapses those fields into a session-wide or
  per-phase-only total does not satisfy this section.
- **Dead-letter counts by topic**, for outbox rows.

**Coverage check, not best-effort**: a prune pass must verify the rollup's
recorded coverage window (session + time range) is a superset of the rows it
is about to delete before proceeding. A rollup that covers 2026-01 through
2026-03 does not license pruning a 2026-04 row. This is what makes "metrics
needed for historical intervention/loop analysis remain reproducible after
pruning" (the issue's acceptance criterion) a checked precondition rather than
an aspiration.

**File-wide coverage scope for pre-migration outbox rollups.** §10 permits a
whole-file outbox sweep before `outbox` gains a persisted `session_id`
(§13 item 3a), because no per-session scoping can be computed from stored
data. A rollup covering such a sweep cannot be keyed by "session + time
range" for the same reason — there is no session to key it by. For this case,
and only this case, the coverage key is **`dbPath` + time range** (the whole
physical file, not a session): the rollup records the full row-id or
timestamp range it summarizes across every outbox row in the file, and a
whole-file prune pass verifies that recorded range is a superset of the rows
it is about to delete, the same superset check as above but scoped to the
file instead of a session. This is a narrower substitute for session-scoping,
not a relaxation of the coverage requirement itself: once the migration in
§13 item 3a lands, all subsequent outbox rollups and prunes revert to
per-session coverage like every other data class — **with one permanent
exception**: rows the backfill leaves with `session_id IS NULL` (§10) have no
session to key a rollup by, so they keep an indefinite, narrower variant of
this same `dbPath`-scoped coverage key, filtered additionally to
`session_id IS NULL` (§10 defines the corresponding prune path). A file-wide
rollup generated before the migration does not retroactively license a
session-scoped prune afterward — a session-scoped prune must be covered by a
session-keyed rollup, not inherit coverage from an earlier whole-file one —
and it does not retroactively cover the post-migration `session_id IS NULL`
subset either; that subset requires its own NULL-scoped rollup, generated
after the migration once `session_id IS NULL` is a stable, queryable
predicate.

Rollup generation is itself non-destructive and read-only against the stores
it summarizes — it never needs the backup precondition in §8, only the prune
step that follows it does.

**Readers must merge rollup and raw data — a rollup existing is not enough.**
This section's reproducibility promise is only real if the readers that
compute these metrics actually consult the rollup once raw rows are gone.
`admin interventions` and `cli/issue-plan-history.ts` (or any equivalent
reporting path) must, once any prune has run, read **both** the rollup(s)
covering pruned windows **and** the raw `events`/`tasks`/`outbox` rows still
present for un-pruned windows, and merge the two into a single result — never
raw rows alone. The coverage check earlier in this section binds the prune
pass ("do not delete rows a rollup doesn't cover"); it says nothing about
readers, so a later implementation that lands a rollup format but leaves
`admin interventions`/`issue-plan-history` querying only `events`/`tasks`/
`outbox` satisfies no part of this section, even though a rollup exists on
disk — the reports would silently omit every pruned window. Concretely: for a
query window that spans both a pruned (rollup-only) sub-range and a retained
(raw) sub-range, the reader's merged output for that window must equal the
output an unpruned raw-only reader would have produced over the same window —
no double-count at the boundary, no gap. Per data class: intervention counts
merge rollup `(issue_number, kind, event_timestamp, event_id)` entries
(including the task-context-fallback entries from the bullet above) with any
surviving raw-derived entries before totalling, deduplicating on the full
tuple so a row that briefly exists in both a rollup and the surviving raw
`events` table (e.g. a rollup generated just before its covered window's rows
are pruned) is counted once, not twice; applying the query's
`--since`/`--until` bounds to the merged set exactly as
`aggregateL3Interventions` applies them to raw rows: a rollup entry is subject
to the same bound comparison as a raw one, keyed on its own `event_timestamp`
(the tuple's `event_id` disambiguates same-millisecond entries but plays no
role in the bound comparison itself). This is why persisting the task-context
fallback's unknown-timestamp entries (previous bullet) satisfies rather than
violates the equivalence just stated: the raw reader's
`if (resolvedAt === undefined) continue` guard already excludes such an entry
from any bounded query, for any `--since`/`--until` values, before pruning ever
happens; a null/unknown `event_timestamp` sentinel fails that same bound
comparison in the merged reader, so a bounded merge excludes it too, while an
unbounded merge includes it — matching the unpruned raw-only reader's output
in both cases. `issue-plan-history`'s finality/
difficulty output for a given issue resolves to that issue's persisted rollup
output (bullet 4 above) once its underlying `tasks`/`events` rows are pruned,
and to the current live-derived computation otherwise. A rollup format
landing without a corresponding reader update does not satisfy this section.

## 7. Relationship between DB records and `.n8n-artifacts/runs/`

A run artifact directory (`handlers/artifact-dir.ts` `runArtifactDir` →
`<artifactRoot>/runs/<run-id>/`) and the DB rows referencing that `run-id`
(task `context.artifactDir`, `events.run_id`, `outbox` payloads that embed a
`runId`) are **not** stored in one transaction (git/filesystem state is never
transactional with SQLite, per `DOMAIN.md` §2.3 Execution: "Transactions: none
across git+DB"). This contract therefore fixes an explicit ordering and an
explicit tolerance for partial completion:

- An artifact directory is **never** deleted while any DB row still
  references its `run-id` and that row has not itself cleared retention
  (§5). Deleting the directory first would leave a DB row pointing at
  evidence that no longer exists — a worse failure mode than a leftover
  directory, because it silently degrades an event that is supposed to still
  be authoritative.
- **This guarantee is only as strong as the pruner's ability to resolve a
  `run-id` reference, and today `outbox` rows are not resolvable.** Task
  rows (`context.artifactDir`) and event rows (`events.run_id`) expose
  their `run-id` as a queryable column/field, so a pruner can evaluate "does
  any surviving row still reference this `run-id`" and get a correct
  answer. `outbox` rows cannot: a `runId` appears only inside a composed
  `idempotencyKey` string or free-text comment/label body
  (`core/outbox-effects.ts`), never as its own column or JSON field, so an
  unsent or dead-lettered outbox row can still be the only surviving
  reference to a `run-id` while remaining invisible to that check — the
  pruner has no general, reliable way to detect the dependency before
  deleting `runs/<run-id>/`. **Artifact-directory deletion must therefore
  not proceed on the strength of "no task/event row references this
  run-id" alone; it must treat `outbox`'s reference as unresolvable, and
  unresolvable is not the same as absent.** §13 item 3a's structured,
  queryable `run_id` field on `outbox` (today identified only as a
  prerequisite for §8 point 5's restore-time consistency check) is a
  prerequisite for enabling automatic artifact-directory deletion at all,
  not only for verifying it at restore time. Until that migration lands,
  deletion of any `run-id`'s artifact directory must either stay deferred
  entirely or be additionally conditioned on a check the current schema
  cannot express — either way, the follow-up implementation may not treat
  this contract as satisfied by a deletion path that only consults
  `tasks`/`events`. Once §13 item 3a's `run_id` column exists **and every
  pre-existing row has been resolved by its backfill (§13 item 3a) to either
  a concrete `run_id` or an explicit no-run determination**, a row whose
  `run_id` is `NULL` (an effect not produced by a phase run, per §13 item 3a)
  is resolved as **absent**, not unresolvable — it simply has no `run-id` to
  reference, the same as if the column did not apply to it — and does not
  block deletion; only a row with a non-null `run_id` matching the directory
  under consideration, or a row still in the backfill's **unresolved** state,
  still blocks it. **A legacy row's `run_id` is `NULL` immediately after the
  migration purely because the column did not previously exist, not because
  backfill classified it as run-less** — treating that default `NULL` as
  absent before backfill has run would let deletion proceed on exactly the
  kind of unresolved reference this section exists to block, defeating the
  guarantee for every database that had outbox rows before this migration
  landed.
- Within one prune pass, **DB rows are deleted before their corresponding
  artifact directory**. Rationale: a committed DB deletion is the safe
  point-of-no-return (§9's batching model); the directory delete that follows
  is a plain filesystem `rm -rf` with no transactional guarantee, so it must
  happen only after the DB no longer needs the directory to exist. If the
  process crashes between the two, the result is an orphaned directory with
  no surviving DB reference — harmless disk usage, cleaned up by the next
  prune pass's independent artifact-orphan sweep — never a dangling DB
  reference into a deleted directory.
- **Artifact deletion is additionally gated on backup retention (§8), not
  just on the row deletion above.** Row deletion makes a directory eligible,
  but eligibility is necessary, not sufficient: the directory must not
  actually be removed while any **currently retained** verified backup (§8's
  3-backup floor) predates that row's deletion and could therefore still
  reference the row — and its `run-id` — if restored. A prune pass records,
  per artifact directory it deletes, the backup generation at or after which
  removal is safe (the first backup whose snapshot postdates the row's
  deletion); the actual `rm -rf` is deferred until backup rotation (§8) has
  retired every older retained backup. Without this, the backup taken
  immediately before a prune pass captures the very rows that pass is about
  to delete, so restoring that backup afterwards would resurrect DB rows
  pointing at artifact directories already removed — the exact dangling
  reference this section exists to prevent, reintroduced through restore
  instead of through prune.
- An artifact directory whose `run-id` is **not referenced by any surviving
  row at all** (already-orphaned, e.g. from a session whose task row was
  already pruned in an earlier release before this contract existed, or one
  left behind by an interrupted prune pass per the previous bullet) follows
  its own floor: 180 days from the directory's filesystem mtime, treated the
  same as a terminal task's floor since it is the same category of evidence
  with no better anchor available. **This mtime floor is a minimum, not a
  sufficient condition — it does not override the previous bullet's backup
  gate.** The orphan sweep must apply the identical backup gate the previous
  bullet applies to a live row's deletion: it may not remove an
  mtime-eligible directory while any currently retained backup (§8's
  3-backup floor) could still contain a row referencing that `run-id`.
  **The directory's mtime must never be used as a stand-in for that row's
  deletion time.** mtime records the artifact's creation/last-write time,
  which is always at or before the row's own retention floor and therefore
  strictly *earlier* than the row's eventual deletion, never a conservative
  proxy for it — a backup taken any time after mtime but before the row was
  actually deleted still contains the reference, so gating on "no retained
  backup predates mtime" would pass exactly the backups this rule exists to
  block, and restoring one of them would resurrect a row pointing at a
  directory the orphan sweep already removed. The sweep must instead gate on
  a durably persisted reference to the actual (or conservatively-bounded)
  deletion point:
  - For a directory left behind by an interrupted prune pass (the previous
    bullet's case), the recorded "backup generation at or after which
    removal is safe" that bullet requires a prune pass to persist per
    artifact directory must be written durably (in the SQLite file itself,
    alongside the other maintenance state in §9 — never held only in
    process memory) at the point the row is deleted, so it survives the
    same crash that interrupted the `rm -rf`. The orphan sweep reads that
    persisted marker directly; it never needs to reconstruct or approximate
    a deletion time for this case.
  - For a directory with no such marker (the legacy, pre-contract case,
    where no deletion was ever recorded because none of this bookkeeping
    existed yet), the sweep cannot know the true deletion time and must not
    guess one from filesystem metadata. It instead persists, the first time
    it observes the directory as orphaned, a durable `first_observed_at`
    timestamp for that `run-id` (same durable store as the marker above) and
    gates on *that* instead of mtime. `first_observed_at` is always at or
    after the row's actual deletion — the sweep can only ever observe an
    orphan once its referencing row is already gone — so "no currently
    retained backup predates `first_observed_at`" is a conservative
    superset of the true safety condition ("no currently retained backup
    predates the actual deletion"): it may hold a directory slightly longer
    than the minimum required, but it never releases one a live backup
    could still reference. The sweep removes the directory only once every
    currently retained backup postdates `first_observed_at`, exactly the
    "hold until backup rotation clears it" deferral the previous bullet
    specifies, applied without requiring a live row or an mtime guess to
    anchor it.
- Quarantine markers (`Execution`-owned per `DOMAIN.md` §2.3, "until #699")
  are explicitly excluded (§12) — they are recovery state, not history.

## 8. SQLite backup and restore contract

**Backup is a hard precondition for destructive maintenance, not a
recommendation.** No prune/archive-then-delete operation may run unless a
verified backup completed successfully as part of that same maintenance
invocation (or immediately prior to it, within an implementation-defined
short window — but never "the operator says they backed up last week").
There is no override flag that bypasses this precondition; if backup fails,
prune refuses to run, full stop (fail-closed, matching the admin CLI
contract's general posture in `docs/admin-cli-contract.md`).

**Online backup, not a file copy.** The live DB may have concurrent readers
and writers (multiple sessions can share one `dbPath`, §10) and may be in WAL
mode; a plain filesystem copy of the `.sqlite` file risks copying a
torn/inconsistent snapshot if it races a writer, and silently misses the
`-wal`/`-shm` sidecar files if copied naively. A backup that satisfies this
contract's precondition must be produced with the Backup API exposed by
`better-sqlite3` (`db.backup(path)`) — the only primitive that supports the
same-transaction, same-snapshot verification sequence required below.
`VACUUM INTO <path>` is also an online-safe, concurrent-access-friendly SQLite
primitive, and remains permitted elsewhere in this codebase as a general
space-reclaiming/copy operation, but a copy produced by `VACUUM INTO` does
not qualify as a verified maintenance backup under this contract (see the
verification requirement immediately below for why) and cannot satisfy §8's
opening precondition on its own.

**Verification, not just completion.** A backup is not "successful" merely
because the copy operation returned without throwing. It must be additionally
verified before it can satisfy the precondition:
- `PRAGMA integrity_check` on the backup file returns `ok`.
- A cheap row-count sanity check (e.g. `SELECT COUNT(*) FROM tasks`) on the
  backup is compared against a live-DB count captured from the **same
  snapshot the backup itself reads**, not a separately-issued query at
  verification time. Under concurrent writers (backup never acquires the
  maintenance lock and never pauses them — see §9's scoping of that lock to
  prune), a live count queried *after* the backup completes
  can have drifted from what the backup actually captured by an unbounded
  amount — a busy period of sustained task creation or recovery can move the
  live count arbitrarily far from the backup's count with no correctness
  problem at all, so any fixed "small drift" threshold either rejects valid
  backups under load or is set so loose it verifies nothing. The
  implementation must instead obtain both counts from one consistent read:
  open the backup's source connection in a single deferred transaction,
  issue the row-count query first, and perform the backup operation via the
  Backup API (`db.backup(path)`) as the next statement on that same
  transaction, before committing — SQLite's snapshot isolation then
  guarantees the count and the backup describe the identical database state.
  The backup-file count and this snapshot count must then match **exactly**;
  no drift tolerance is needed or permitted, because there is no longer a
  gap in time between the two reads for a concurrent writer to occupy.
  **This same-transaction sequence is achievable only with the Backup API
  (`db.backup(path)`), not with `VACUUM INTO`.** SQLite refuses to execute
  `VACUUM` or `VACUUM INTO` while a transaction is open, so `VACUUM INTO`
  cannot be the next statement inside the deferred transaction that just
  issued the row-count read — the row-count and the copy cannot share one
  snapshot this way, and there is no other sequencing that closes the same
  concurrent-writer gap for `VACUUM INTO`. A backup that must satisfy this
  precondition (§8's opening paragraph) is therefore produced with the
  Backup API, not `VACUUM INTO`. `VACUUM INTO` remains permitted elsewhere
  in this codebase as a general space-reclaiming/copy primitive; it is not
  an equivalent, compliant alternative to the Backup API for a backup that
  destructive maintenance depends on.

**Backup retention.** At least the **3 most recent successfully verified**
backups for a given `dbPath` must be retained at all times; backup rotation
never deletes the backup that most recently satisfied a still-pending prune's
precondition until a strictly newer verified backup exists to replace it.
Older backups beyond that floor may rotate on whatever schedule the
implementation chooses. **This floor is also an artifact-retention
obligation, not just a DB-file one**: per §7, an artifact directory referenced
by any currently retained backup must survive until that backup rotates out,
so restoring any of the 3 retained backups never resurrects a DB row whose
artifact directory has already been removed.

**Restore is an out-of-loop, manual operation.** No automated workflow (n8n,
`dispatch-outbox`, `run-one-phase`) ever restores a backup on its own — restore
is an operator action taken with the loop fully stopped. A preflight glance at
"no live phase, no held lock" is not sufficient on its own: a worker or the
outbox dispatcher can pass its own admission check and start running *after*
restore's preflight observes quiescence but *before* restore has actually
replaced the DB file, and that process would then keep writing to the old
file's inode while every subsequent command reads the newly-restored file —
losing the in-flight process's state and splitting the loop's view of the
world across two files. Restoring therefore requires:
1. Restore itself acquires the same DB-resident maintenance lock (§9) — via
   the identical conditional-write protocol every other maintenance
   acquisition and every phase-start/outbox-mutation check goes through, not
   a separate restore-only check — and only *after* acquiring it does restore
   re-verify quiescence (no session sharing the target `dbPath` has a live
   phase running, and no `outbox` row holds a non-stale claim, per §9's
   acquisition rules) against that same atomic exclusion point. Acquiring
   first and rechecking after, rather than checking then acquiring, is what
   closes the gap above: once restore holds the lock, §9 already requires
   every phase-start and outbox-mutating path to refuse
   (`lock_contended`-shaped) against that same shared resource, so nothing
   still eligible to interleave with the file swap.
2. **Restore never opens the verified backup file for writing.** The backup
   selected for restore keeps counting toward the §8 3-backup floor and
   keeps satisfying whatever verification produced it throughout the entire
   restore, because restore never mutates it: immediately after re-verifying
   quiescence, restore makes a fresh, byte-for-byte copy of the verified
   backup into a separate, not-yet-live replacement file (e.g.
   `<dbPath>.restore-tmp`) on the same filesystem as `dbPath`, and every step
   below operates on that copy, never on the backup it was copied from. A
   design that carries the lock (or the WAL checkpoint in item 3) into the
   backup file itself would both invalidate that backup's verification
   snapshot — it would no longer be the bytes verification checked — and
   silently drop the retained-backup count required by §8 to two for as long
   as restore is in progress, exactly the gap this item exists to close.
   Restore holds that lock **through the file swap**, not just through the
   preflight check. Because the lock's atomicity depends on the *live* file
   restore is about to replace, restore must carry the held lock forward
   into the replacement content before that content becomes the live file:
   after creating the replacement copy, restore writes its own
   maintenance-lock row into the replacement copy (never into the verified
   backup) before the atomic rename that makes the replacement `dbPath`, so
   that the instant the swap becomes visible, any phase-start or
   outbox-mutation attempt that opens the (now-live) restored file still
   observes the lock held and refuses, exactly as it would against the old
   file a moment earlier. A design that releases the lock on the old file
   and only then renames the replacement into place reopens the identical
   gap this section exists to close, just moved to sit *around* the rename
   instead of before it. Restore releases the carried-forward lock, in a
   `finally` matching every other lock user in this codebase, only once the
   rename and the artifact-consistency check (item 5 below) have both
   completed.
3. **The replacement's own WAL is checkpointed and closed before it becomes
   `dbPath`, and the live file's existing journal sidecars are swapped out
   as part of the same operation as the main-file rename — never left
   behind for SQLite to replay.** Two distinct sidecar problems exist here,
   both closed by this item:
   - The maintenance-lock write in item 2 is issued against the not-yet-live
     replacement file. If that connection is left in WAL mode, the write can
     land in a `<replacement>-wal` sidecar rather than the replacement's main
     page space. A bare `rename(replacement, dbPath)` moves only the main
     file; a `<replacement>-wal` never becomes `dbPath-wal` through that
     rename, so the lock write would simply not exist in whatever file the
     next connection actually opens. Restore therefore runs
     `PRAGMA wal_checkpoint(TRUNCATE)` and closes the connection against the
     replacement file before the rename, folding the lock write into the
     replacement's main file and leaving no sidecar to lose.
   - The *live* `dbPath` being replaced can itself be in WAL mode with its
     own `dbPath-wal`/`dbPath-shm` already on disk. Renaming only the main
     file leaves those old sidecars sitting next to the newly-renamed
     content; the next connection that opens `dbPath` sees a `-wal` file
     whose frames were written against the *old* database's page layout and
     will attempt to replay them over the restored content — silently
     reintroducing pre-restore data (or corrupting the restored file) the
     instant a connection opens it, including the very connection restore
     itself relies on for the artifact-consistency check in item 5. Because
     no filesystem gives an atomic multi-file rename, restore — still
     holding the item-1 lock, so no other connection can race this sequence
     — moves the live `dbPath-wal` and `dbPath-shm` aside (e.g. suffixed
     `.pre-restore`, mirroring item 4's preserve-not-delete posture) as the
     step immediately before the main-file rename, so that by the time the
     rename makes the replacement visible as `dbPath`, no stale sidecar
     exists for a connection to find. If `dbPath` was never in WAL mode (no
     sidecars present), this step is a no-op check, not a skip — restore
     confirms their absence rather than assuming it.
   Restore fails closed (does not proceed to the rename) if the checkpoint
   against the replacement does not report a full checkpoint (`0` busy/
   `0` remaining from `wal_checkpoint(TRUNCATE)`), since a partial checkpoint
   means the lock write from item 2 may still be split across the main file
   and its sidecar.
4. The replaced file's prior state — the main file **and** the sidecars
   moved aside in item 3 — is preserved together (moved aside, not deleted)
   until the operator confirms the restore succeeded, mirroring this
   codebase's general preference for reversible-by-default recovery over
   destructive-by-default recovery. Rolling back the pre-restore main file
   without also restoring its matching sidecars would reintroduce the
   identical stale-WAL-replay hazard item 3 exists to prevent — so rollback
   is defined over the main file and its sidecars as one unit, never the
   main file in isolation.
5. **Artifact consistency is verified, not assumed — for the references this
   check can actually resolve as artifact-producing.** §7's deferred-deletion
   rule means a restore of any currently retained backup should never
   resurrect a dangling DB→artifact reference in the first place — but
   restore treats this as a checked invariant, not a guarantee taken on
   faith. **This check is scoped to task rows' artifact-directory context
   fields — today exactly five keys are known to name a
   `<artifactRoot>/runs/<run-id>/` directory, and all five must be
   validated:**
   - `context.artifactDir` — set by every phase handler that produces a run
     artifact directory; the field most handlers overwrite each phase.
   - `context.draftArtifactDir` — content_draft's quota-delay path
     (`content-draft.ts:538`), preserving the draft run dir under a stable
     key while `artifactDir` still points at the upstream research dir.
   - `context.researchArtifactDir` — content_draft's success path
     (`content-draft.ts:571`), preserving the research dir once `artifactDir`
     is overwritten to point at the draft dir.
   - `context.reviewRunArtifactDir` — content_review's delayed/needs_fix/
     blocked/success paths (`content-review.ts:764,793,810,819`), preserving
     the review run dir separately from whichever draft/research dir
     `artifactDir` already carries forward.
   - `context.reviewArtifactDir` — the review handler's admitted-findings
     path (`review.ts`), a dedicated reference to the review run that wrote
     `review-findings.json`, carried forward unchanged across every later
     implementation retry so a fix-mode prompt build can still find it after
     `artifactDir` has moved on to that retry's own run directory (issue
     #837 review).

   Plus any future handler-specific key following the same naming pattern
   per `handlers/artifact-dir.ts` — it does not walk `events.run_id`. The
   implementation must keep this list centralized and explicit (e.g. a
   single exported array of context-field names in `handlers/artifact-dir.ts`
   that every restore/prune pass imports) rather than re-deriving it ad hoc
   per call site, so that adding a new handler-specific key is a one-line
   addition instead of a silent restore-coverage gap. An
   event's `run_id` only records which phase-runner invocation produced that
   event; `core/phase-runner.ts` stamps `runId: request.runId` on every
   lifecycle event it appends (`phase.started`, `phase.lock.failed`,
   `phase.lock.contended`, `phase.worktree.failed`, `phase.worktree.resolved`,
   `phase.completed`, `phase.delayed`, `outbox.enqueue.failed`), and most of
   these fire — or can fire — before any handler is invoked at all. A phase
   rejected at the admission, lock, or worktree-prep preflight (§9) never
   reaches the handler that would create `runs/<run-id>/`, yet it still
   appends `phase.started` and a `phase.completed` event carrying that same
   `run-id`, by design and on every such rejection, not as a rare edge case.
   Treating an event's `run_id` as an artifact-producing reference would make
   restore reject a backup containing these entirely normal preflight-
   rejection events for want of a directory that was never supposed to
   exist — failing closed on evidence that isn't evidence of anything wrong.
   A task-row context field is different in kind from an event's `run_id` —
   but its mere presence is **not** proof that the directory it names was
   ever created. A handler can compute and return one of these fields before
   its own `mkdirSync` call runs: `createReviewHandler` resolves `artifactDir`
   up front and returns it in `context` on the review-admission-rejection
   path (`review.ts:598,600`) and on the repo-host-resolution-failure path
   (`review.ts:636-641`), both of which return `failed`/`blocked` before the
   handler's `mkdirSync(artifactDir, ...)` call (`review.ts:682`) ever
   executes. A backup captured while a task sits in either resulting state is
   an ordinary, expected snapshot — not corruption — and restore must not
   fail on it merely because `runs/<run-id>/` was never created.

   Restore therefore validates an artifact-directory context field only when
   it carries a durable **artifact-created marker** alongside it, not merely
   because the field is present. A `mkdirSync` return alone is not sufficient
   grounds for that marker: `runs/<run-id>` can already exist as a symlink,
   or be replaced by one immediately after creation, in which case
   `mkdirSync(..., { recursive: true })` reports success without a real
   directory ever existing inside `artifactRoot` — precisely the gap
   `isSafeArtifactDirAfterRun` (`handlers/artifact-dir.ts`) exists to close.
   Today only `content-draft.ts` and `content-review.ts` already call it
   immediately after their own `mkdirSync`; `implementation.ts:964`,
   `review.ts:682`, `research.ts:101`, and `conflict-resolution.ts:538` each
   call `mkdirSync(artifactDir, ...)` for the `context.artifactDir` case
   without any following `isSafeArtifactDirAfterRun` check today. Adding that
   call to each of those four handlers, immediately after their `mkdirSync`
   and before returning `context.artifactDir`, is therefore a prerequisite
   of — not already-satisfied groundwork for — the marker this section
   specifies, and is in scope for the required follow-up implementation
   surface (§13) alongside adding the marker itself. Each handler that sets
   one of the fields enumerated above must therefore pair it, in the same
   context write, with a marker recording that its creation step returned
   successfully **and** that this path-safety check passed against that same
   write. **The marker must bind to the specific path it was set for, not be
   a bare boolean** — e.g. `<field>Created: <artifactDir value at the write
   that set it>`, not `<field>Created: true`. Task context is built by
   merging patches (later phase handlers overwrite fields the earlier ones
   set), and a bare boolean marker created for one run's directory would
   otherwise survive a later patch that overwrites `<field>` with a new,
   not-yet-created path but does not itself touch `<field>Created` — exactly
   the review-admission-rejection and repo-host-resolution-failure paths
   above, which return a new `artifactDir` before any `mkdirSync` runs.
   Without a path-bound marker, restore would read the stale `true` next to
   the new path and validate a directory that was never supposed to exist,
   failing closed on a perfectly valid backup. A string-valued marker closes
   this by construction: restore only treats the marker as covering
   `<field>`'s current value when `<field>Created === <field>` exactly;
   any mismatch (including a boolean `true` left over from an older,
   non-conforming write) is treated as "no marker for this value," falling
   through to the "excluded from this check" behavior below rather than
   being misread as coverage for a directory it was never paired with. Set
   only after both the `mkdirSync` (or equivalent) call and its paired
   `isSafeArtifactDirAfterRun` check succeed against the same path, and
   never set (or left stale) on a pre-creation failure/blocked return (such
   as the two review paths above), a post-creation safety-check failure, or
   any other handler's own admission/preflight-failure path — a handler that
   returns a new `<field>` value on such a path must explicitly set
   `<field>Created` to `false`/`null` in that same write, never omit the key.
   Because task context is built by shallow-merging patches, an omitted key
   is indistinguishable from "unchanged" and would leave the *previous*
   write's marker value in place; since that marker is now bound to the
   value-equality check above, a stale-but-still-equal-by-accident marker
   from an earlier write for a different path is exactly the failure mode
   the path-binding in this rule exists to close, so the field and its
   marker must always be written together, not relied on to diverge safely
   on omission. A field whose marker does not match the
   field's current value is excluded from this check; the absence of its
   directory is expected, not fail-closed evidence of a broken backup.
   Before replacing the live DB, restore walks every artifact-directory
   field whose creation marker matches that field's current value on the
   restored snapshot's task rows and performs that same path-safety
   validation against the live filesystem — not a bare existence check — confirming
   `<artifactRoot>/runs/<run-id>/` still exists, is a real (non-symlinked)
   directory, and still resolves inside `artifactRoot`. Any row failing that
   check, whether because the directory is missing or because it (or a
   parent segment) now resolves outside `artifactRoot`, fails the restore
   (fail-closed, matching this section's general posture) instead of
   silently completing a restore that leaves a task row pointing at an
   artifact that was deleted, or redirected outside the artifact root, out
   from under it. Adding this marker to every handler enumerated above —
   which for `implementation.ts`, `review.ts`, `research.ts`, and
   `conflict-resolution.ts` first requires adding the
   `isSafeArtifactDirAfterRun` call itself, since none of the four call it
   today — is required follow-up implementation surface (§13) — the
   artifact-consistency check specified here cannot be built correctly
   before the markers exist, since without them restore cannot distinguish
   "field set, directory created and validated" from "field set, creation or
   validation short-circuited before it completed."
   **Ordinary outbox rows are excluded from this specific check** for the
   same underlying reason event rows are: unlike a task's context, `outbox`
   has neither a persisted `session_id` (§10) nor a
   structured `run_id`/`runId` payload field today — `runId` appears only
   inside a composed `idempotencyKey` string and free-text comment/label body
   text (`core/outbox-effects.ts`), never as its own queryable column or JSON
   field — so there is no owning session to resolve an artifact root through,
   and §10 forbids `payload.owner`/`payload.repo` as a proxy for that
   resolution. Excluding these rows here is consistent with, not weaker than,
   the rest of this contract's fail-closed posture: §7 now requires
   artifact-directory deletion itself to stay gated (deferred or otherwise
   conditioned) on the same missing `run_id` field for any `run-id` an
   outbox row could reference, so this restore-side exclusion is not a gap
   opened on top of an otherwise-enforced deletion-side guarantee — the
   deletion side carries the identical prerequisite. This exclusion is
   lifted only once outbox rows carry a persisted `session_id` (§13
   item 3a), a structured, queryable `run_id` field, and — for the
   artifact-reference check specifically — the paired `run_artifact_created`
   provenance flag defined there. A non-null `run_id` alone does not lift
   the exclusion for the row it is on: only rows where `run_artifact_created`
   is also `true` are subject to artifact validation once the exclusion
   lifts for the file as a whole; a row with `run_artifact_created` `false`
   or unresolved stays excluded from the check the same as a `NULL`
   `run_id` row. Until the schema prerequisite lands, neither verifying
   outbox artifact consistency at restore time nor safely deleting an
   artifact directory that an outbox row might reference is implementable,
   not merely deferred by convenience.

**A shared `dbPath` is not a single-`artifactRoot` guarantee, and the backup
manifest must not assume otherwise.** §10 already establishes that multiple
sessions can share one physical SQLite file; those sessions are not required
to share a configured `artifactRoot`, so a single backup of `dbPath` can
contain task rows whose artifact-directory `run-id`s resolve under two or
more distinct `<artifactRoot>/runs/<run-id>/` trees. Validating the artifact consistency
check above against one singular `<artifactRoot>` is therefore unsound in
that configuration: it either checks every row's `run-id` against the wrong
root and rejects an otherwise-valid restore of a session it doesn't own, or
it checks only one session's root and silently skips verifying another
session's artifacts, defeating the fail-closed posture above.

**The mapping must be read from a durable, DB-resident record, not derived
from live session config at backup time.** A session's `artifactRoot` is
today only known from its configuration (`sessions.json` and equivalents) —
the identical "runtime config, not a persisted, queryable association"
distinction §10 already draws for `payload.owner`/`payload.repo`. An operator
retires a session by removing its entry once its work is done, but that
session's `tasks`/`context_records` rows (and any outbox row carrying
`run_artifact_created = true`, above) can remain in the DB for the rest of
the retention window (§2) after removal. Deriving the manifest's mapping from
live session config at backup time would silently drop exactly the sessions
this mapping most needs to preserve: the rows stay queryable in the DB, but
the config entry needed to resolve their root is gone by the time a later
backup runs. That either omits the manifest entry — which then fails
restore's fail-closed check below on an entirely ordinary, still-retained
backup — or forces an operator to keep every historical session's entry in
config indefinitely just to keep past backups restorable, defeating the
purpose of retiring a session at all. Each session's `artifactRoot` must
therefore be stamped durably into the DB itself the first time that session
writes any `tasks`/`context_records` row — e.g. a small
`session_roots(session_id, artifact_root)` table, populated by whichever
store call performs a session's first write.

**A session id is not bound to a permanent `artifactRoot`, so that store
call must reconcile the live-configured root against the durable entry on
every write, not only the first.** An operator is free to repoint a session
id at a new repo checkout or artifact directory in config at any time;
nothing in this contract or the code prevents it. If that write path only
ever wrote the entry once and otherwise ignored it, the entry would
silently go stale the moment config changes underneath it, and every row
written afterward — under the new root — would be validated at restore
time against the old one, producing exactly the false restore failure (or
wrong-tree validation) this section exists to prevent. The write must
therefore compare the live-configured `artifactRoot` against the durable
entry on every write: a match is a no-op; a session writing its first row
ever inserts the entry; a **mismatch** means the operator moved this
session's root since the entry was stamped, and neither silent resolution
is safe — overwriting the entry corrupts resolution of already-written rows
still keyed to the old root (per the fail-closed check in point 5 below),
and leaving it stale corrupts resolution of the very row now being written.
The write must instead **fail closed**: it is refused, with an error naming
the session id, the recorded root, and the newly configured root, unless
the DB currently holds no row for that session — across `tasks`,
`context_records`, and artifact-marked `outbox` rows (§10) — that is both
still within its retention window (§2) and resolves under the *old* root.
Only once every old-root row has aged out and been pruned is the entry
permitted to update to the new root, and the blocked write permitted to
proceed. An operator who needs to move a session's artifact storage before
that point has two options: prune the session's old-root history first
(accepting the loss of that history) and reconfigure, or leave the id
retired and start the moved work under a **new** session id — the same
"new id, not a reused one" resolution already required for the
differently-configured-session-reusing-an-id case. This keeps each
`session_roots` entry durable for exactly one root-epoch per session id,
so the backup manifest's `session_id → artifactRoot` mapping — read from
that durable record at backup time, not from live session config — never
resolves a still-retained row against the wrong root. It also makes the
mapping survive a session's removal from config the same way the rows it
maps stay queryable after that removal. A `session_roots` table adopted
after sessions have already been retired cannot retroactively recover an
already-removed session's root; the migration that introduces it must
backfill one entry per session from whatever config history is still
available at migration time, exactly once, and a session already retired and
removed before that migration runs is a known, documented gap: the migration
cannot manufacture a `session_roots` entry it has no config history for. That
gap resolves to the identical fail-closed behavior as the missing-manifest-
entry case below, not to skipping the check — a marker-bearing task/
context_records row (or `run_artifact_created` outbox row) belonging to such
a session has a real, unresolved artifact reference, and treating it as
"nothing to check" would let a restore accept it without ever verifying that
reference. Backup must therefore refuse to produce a `session_roots` mapping
entry for that session and must instead record it, by session id, in the
manifest as an **unresolved-root** session; restore must refuse (fail closed)
any snapshot containing a marker-bearing row owned by a session listed as
unresolved-root, for the same reason it refuses one with no manifest entry at
all — both mean an artifact reference the restore cannot validate is present.
The only way to lift this for a given session is for an operator to supply
its historical root out of band and have it recorded in `session_roots`
before the next backup runs; until then, every backup and restore involving
that session's marker-bearing rows fails closed rather than silently
proceeding unchecked.

**The fail-closed requirement is scoped to sessions with a validated
artifact reference actually present, not to every session with any row in
the backup.** Point 5 above only ever walks a task row's artifact-directory
context field when that field carries its paired creation marker, and (per
this section's other finding) an outbox row's `run_id` only when
`run_artifact_created` is `true`; a session whose present rows carry no such
marker has nothing for point 5 to resolve a root against, so requiring a
manifest entry for it would fail backups closed over rows point 5 was never
going to check in the first place. The backup operation must therefore
record, as part of the backup's manifest (not inferred at restore time), the
`session_id → artifactRoot` mapping — read from the durable `session_roots`
record above — for every session with **at least one task/context_records
row present in that backup carrying a marker-paired artifact-directory
field, or at least one outbox row present with `run_artifact_created =
true`**. Restore's artifact consistency check in point 5 above must resolve
each such row's artifact-directory path against its owning row's session's
recorded `artifactRoot` from this mapping, not a single implied root, and
must fail closed (same as an individually missing directory) if such a row
is present in the snapshot but its owning session has no corresponding entry
in the manifest's mapping — including a session explicitly recorded as
unresolved-root above, which counts as "no corresponding entry" for this
purpose, never as a resolved mapping to skip validation against. Event rows
and marker-less task/context_records rows are outside this requirement —
point 5 does not walk them for artifact
resolution and they carry nothing for a missing entry to fail closed over.
Outbox rows remain outside this mapping's scope until §13 item 3a's
`session_id`/`run_id`/`run_artifact_created` columns exist — only then does
an outbox row have anything to key this mapping by.

## 9. Preview, confirmation, locking, and failure behavior

**Preview-by-default, `--yes` to apply**, exactly like every other destructive
admin command (`docs/admin-cli-contract.md`; e.g. `outbox retry`, `task
cancel`). A prune preview must enumerate, per data class, the row/directory
count that would be removed and the backup that would satisfy §8 — an
operator must be able to see the blast radius before confirming.

**A dedicated maintenance lock, not the existing per-issue locks.** Prune
operates at the whole-file level (a `DELETE` touching many issues' rows at
once) — the per-issue `IssueWorktreeLock` and the session-level
`RepoLockStore` guard *phase execution*, not file-level maintenance, and
neither is sufficient on its own. A new maintenance lock (implementation
detail for #611: state persisted in the SQLite file at `dbPath` itself —
e.g. a lock row/table alongside `tasks`/`events` — not a standalone
sidecar file; see the atomicity requirement below for why) must be
acquired exclusively for the duration of **prune's** row-selection-through-
delete-batch work, and:

**Backup itself never acquires this lock and is never blocked by it.**
§8 requires the online, concurrent-safe Backup API (`db.backup(path)`)
precisely so that a backup can be taken without pausing readers or writers;
making backup contend for the same lock that blocks every task- and
outbox-mutating path below would defeat that design and turn every backup
into a full write freeze, which is neither required for a correct backup
nor consistent with the concurrent-writer backup test in §13's Backup
follow-up. The lock exists to make **prune's** row selection and deletion
atomic with respect to concurrent task/outbox mutation (the requeue-race
and stale-outbox-claim scenarios below); backup, being read-only against
the live file, needs no such exclusion. When a maintenance invocation runs
backup immediately before prune, backup completes and is verified *before*
prune acquires the lock — §8's opening precondition requires a verified
backup to exist prior to prune starting, not one taken while prune's lock
is held — and a standalone `backup` invocation with no following prune in
the same run never touches this lock at all. The exclusivity rules below
apply to prune's acquisition only:
- refuses to acquire while **any** session sharing that `dbPath` has a phase
  actively running (checked, not merely assumed — a stale/crashed lock is
  recoverable the same way `worktree release-lock` recovers a stale issue
  lock, never assumed live by default);
- refuses to acquire while any `outbox` row has a **non-stale claim**
  (`claimed_at` set and not yet past `OUTBOX_CLAIM_STALE_MS`, per
  `core/outbox.ts`). A live claim means a dispatcher may already be mid-flight on
  an external GitHub effect (§4's sent/cancelled-precedence note documents
  this as a real race in the current store, not a hypothetical one). Without
  this check, maintenance could acquire the lock while such a claim is live,
  and the "every outbox-mutating command must honor the maintenance lock"
  rule below would then force that dispatcher's later `renewClaim`/
  `markSent` to refuse *after* the external effect already happened; a
  maintenance run that outlasts `OUTBOX_CLAIM_STALE_MS` would let the claim
  go stale and be re-dispatched, duplicating the effect. A claim already past
  `OUTBOX_CLAIM_STALE_MS` is stale and does not block acquisition, matching
  the "recoverable, never assumed live" posture of the phase check above.
  (An implementation may instead close this race by exempting a claim
  owner's `renewClaim`/`markSent`/`markFailed` calls for its own
  already-held, non-stale claim token from the maintenance-lock check in
  §9's "every outbox-mutating command" rule below, so a dispatcher that
  started before maintenance acquired the lock can still record its
  already-external effect's terminal result regardless of when maintenance
  later acquires — but a compliant implementation must pick one of these two
  closures, not silently drop both the way the acquisition-time check alone
  being absent does today.);
- refuses to acquire while another maintenance operation already holds it;
- is released in a `finally`, matching every existing lock user in this
  codebase (`handlers/review.ts`, `handlers/conflict-resolution.ts`).
A sidecar file may still exist alongside this DB-resident state purely for
the same cross-process discoverability/recovery UX as other locks in this
codebase (`stores/repo-lock-store.ts`'s pattern) — but it must not be the
mechanism phase startup checks, for the reason below.

**Phase start and maintenance acquisition must go through one atomic
exclusion protocol, not two independently-timed checks.** A design where
phase startup checks "is the maintenance lock held" and, separately,
maintenance-lock acquisition checks "is any phase actively running" — each
implemented as its own check-then-act step against its own resource — does
**not** close the race even when both checks exist: maintenance can observe
no active phase and acquire its lock in the gap after a phase has passed its
own check but before that phase has actually claimed and started, and the
reverse ordering is equally possible. Each side's check is atomic with
respect to its own subsequent act, but the two sides are not atomic with
respect to *each other*, and that is the window this contract must close —
permitting that "consult" shape as a compliant option (as an earlier version
of this contract did) does not uphold the guarantee, regardless of check
ordering or how quickly each side re-checks. This contract therefore
requires a single shared exclusion point that both operations contend for
atomically: task claim (wherever a task transitions into the active bucket,
§4 — the path `runNextPhase` goes through) and maintenance-lock acquisition
must be two conditional operations against the *same* underlying resource,
evaluated under that resource's own atomicity guarantee — concretely, both
expressed as conditional writes against a shared lock row/table inside the
same SQLite file `dbPath` points at, relying on SQLite's writer
serialization (only one write transaction proceeds at a time) rather than
on independently-timed application-level checks. For example: a task-claim
transaction's `UPDATE` includes `AND NOT EXISTS (SELECT 1 FROM
maintenance_lock)` in its `WHERE` clause, and a maintenance-lock acquisition
is itself a transaction that both inserts that row and verifies no active
phase, evaluated against the same file's serialized writes — so the two
transactions cannot interleave to produce the race above; whichever commits
first is authoritative and the other observes it. A maintenance lock
implemented purely as a sidecar file, consulted by phase startup as an
independent pre-check before a separate, later DB claim, does not satisfy
this requirement regardless of ordering — it always leaves the
check-to-act gap described above. `acquirePhaseLock`/`IssueWorktreeLock`
already gate phase execution today via per-issue/session locks; the
maintenance exclusion point described here is the whole-file analogue and
must provide the same atomicity guarantee, not merely mirror their shape.
The same requirement applies to the non-stale-outbox-claim check the bullet
list above adds: `claimForDispatch`'s claiming `UPDATE` and a
maintenance-lock acquisition's verification that no non-stale claim exists
must likewise be conditional writes/reads against that same shared resource
under SQLite's writer serialization, not two independently-timed checks —
otherwise the identical claim-vs-acquisition gap this paragraph closes for
phase startup reopens for the outbox-claim case the bullet above exists to
prevent.

**Every task- *and* outbox-mutating path, not just phase startup, must honor
the maintenance lock.** Phase startup is not the only way a task can change
state out from under a prune batch, and prune deletes eligible `outbox` rows
(§5) exactly as it deletes tasks — the same race applies to both tables, not
just the first. Operator commands that mutate a task row — recovery/requeue
(`admin recover`, stale-claim reclaim), human-handoff requeue (`admin`
grant/resolve paths that flip a task out of the human-gated bucket), and
cancellation (issue #608's `cancelTask`) — run independently of
`runNextPhase` and are not covered by the phase-start check above. The same
is true of every `outbox` mutator: `admin outbox retry`
(`cli/admin.ts`'s `runOutboxRetry` → `outboxStore.retryEntry`) can move a
dead-lettered or cancelled row back to pending, `admin outbox cancel`
(`outboxStore.cancelEntry`) can dead-letter/cancel a row, and the dispatcher
(`handlers/gh-dispatcher.ts`'s `dispatchOutbox`/`claimForDispatch`) claims and
sends pending rows — none of these run through `runNextPhase` either, and
none are covered by the phase-start check above. Left unaddressed, a prune
batch can select an eligible terminal/cancelled task or terminal/cancelled/
dead-lettered outbox row (§4–§5) as a deletion candidate, and before that
batch commits, one of these commands can move the same row back into an
active/pending bucket — e.g. requeuing a `failed` task, an operator
recovering a task the prune pass had already read as `done`, or **an
operator running `outbox retry` on a dead-lettered row after prune has
selected it for deletion but before the delete commits, reviving a row that
still carries a pending external effect (an unsent GitHub comment/label)**.
A compliant implementation that only gates phase startup would then delete a
now-active task or a now-pending outbox row and silently lose that pending
effect — exactly the class of bug §12's exclusion matrix exists to prevent,
and it applies identically to `outbox` as to `tasks`. This contract requires
one of:
- every task- and outbox-mutating command above — phase startup,
  recovery/requeue, human-handoff requeue, cancellation, `outbox retry`,
  `outbox cancel`, and the dispatcher's claim-then-send — acquires (or
  itself checks) the maintenance lock before writing, refusing with the
  same retryable `lock_contended`-shaped outcome as phase startup whenever
  the maintenance lock is held, mirroring §9's phase-start gate exactly
  rather than adding a second, differently-shaped check; or
- prune's own row deletion is an atomic conditional delete in both tables,
  expressed against each table's **actual** keys and lifecycle columns —
  `tasks` has no `id` column (its primary key is the composite `(session_id,
  issue_number)`, `stores/sqlite-task-store.ts`) and `outbox` has no `status`
  column (its bucket is derived from `sent_at`/`cancelled_at`/
  `dead_letter_at`/`claimed_at`, per §4's taxonomy table) — so:
  for `tasks`, a single `DELETE ... WHERE session_id = ? AND issue_number = ?
  AND <every §4/§12 exclusion predicate still holds>` (status bucket,
  unresolved-Tool-Request flag, rollup coverage, etc.); for `outbox`, the
  equivalent `DELETE ... WHERE id = ? AND <the same §4 timestamp predicate
  that classified the row as eligible under §5 still holds> AND
  <rollup/export coverage still holds>` — e.g. for a terminal (sent) row,
  `sent_at IS NOT NULL`; for a cancelled row, `cancelled_at IS NOT NULL AND
  sent_at IS NULL`; for a dead-letter row, `dead_letter_at IS NOT NULL AND
  cancelled_at IS NULL AND sent_at IS NULL` — each executed at commit time
  rather than relying on a row's eligibility as read during the earlier
  selection/preview pass, so a row mutated between selection and commit (a
  retried, cancelled, or re-claimed outbox row exactly as much as a requeued
  task) no longer matches the delete's `WHERE` clause and survives, with the
  batch treating a zero-row-affected delete as "no longer eligible, skip"
  rather than an error.

Either design closes the race for both tables; relying on eligibility as
computed once during selection, with nothing revalidating it at the point of
deletion and no lock covering the intervening commands, does not — and a
design that closes this race for `tasks` while leaving `outbox` covered by
neither alternative does not satisfy this contract.

**Outbox side: implemented via the first alternative (issue #818).** Every
`outbox` mutation now reads `maintenance_lock` *inside the same SQLite
transaction as its own write*, per the atomicity requirement above — never as
a separate pre-check:

- `enqueue` and `replacePendingPrSummary` (`stores/sqlite-outbox-store.ts`),
  plus the transactional phase-completion/cancellation enqueues
  `completePhaseWithEffects` / `cancelTaskWithEffects`
  (`stores/sqlite-task-store.ts`, issue #701) — so a phase or an operator
  command can never add a row to a file `restore` is replacing;
- `claimForDispatch` — the fail-closed point for dispatch: no row is claimed,
  and therefore no external side effect performed, while the lock is held.
  This is the mirror image of the acquisition-time non-stale-claim refusal
  described above; the two together make claim and acquisition mutually
  exclusive in both orders;
- `retryEntry` / `cancelEntry` — the `admin outbox retry` / `cancel` bucket
  changes this section names explicitly. `retryEntry`'s guarded transaction also
  carries the scan-cursor rewind that keeps a revived row visible to future
  dispatch scans (issue #820, `docs/outbox-scan-cursor-contract.md` §13), so a
  refusal leaves both the row and every cursor untouched;
- `setScanCursor` — the dispatcher's persisted scan cursors are rows in the
  maintained database too (issue #818 review follow-up). The lock can be
  acquired *after* a drain's last claim resolved but before its cursors are
  persisted, so `dispatchOutbox`'s pre-check and its in-loop contention flag
  cannot cover this write; the guard belongs in the mutator, atomically. A
  refusal is non-destructive — the cursor keeps the last complete run's value,
  which is also what the next unlocked run wants to resume from — and the
  dispatcher stops persisting the remaining cursors and reports contention.

Refusals are typed, never generic process failures. `retryEntry`/`cancelEntry`
report `reason: "maintenance_locked"`, `claimForDispatch` returns `false`
without mutating anything, `setScanCursor` returns `{ persisted: false }`,
the two `*WithEffects` task-store calls return
`code: "maintenance_locked"` (refusing the completion *in full* — transition,
event, and effects — which is what preserves #701's all-or-nothing contract
under contention), and the enqueue paths throw a typed
`MaintenanceLockedError` rather than reusing `{ enqueued: false }`, which
already means "duplicate idempotency key, safe no-op" and would silently drop
a real side effect. `dispatch-outbox` surfaces contention as **exit 0** with
`outcome: "maintenance_locked"` — an expected idle outcome, like an empty
outbox, with no public comment, label mutation, or provider request performed
after the lock was observed. A run that met the lock before its first claim
reports zero dispatched/failed counts; one that met it part-way (a lock
acquired mid-drain, or only at cursor persistence) still reports the rows it
had already completed, since those effects were genuinely published.
`run-one-phase` likewise reports
`outcome: "maintenance_locked"` at exit 0.

**A refusal must never arrive after a task has already moved.** A typed
refusal only helps if the caller has nothing half-applied to clean up, so every
write that changes a task *and* enqueues the effects announcing that change
goes through a single transaction that reads the lock before either half lands
(issue #818 review follow-up):

- `SqliteTaskStore.transitionTaskWithEffects` is the generic form of that
  commit, used by the operator commands that move a task between lanes —
  `human-review-return` / `github-app-review-return` /
  `review-verification-resolve` (via `enqueueFixModeRequeue`) and the
  review-verification requeue. They previously transitioned the task first and
  enqueued their labels/comment afterwards through a second connection, so a
  held lock aborted them mid-sequence: task requeued for a fix run, lane labels
  never queued, for the whole maintenance window. The public status comment
  announcing the move belongs to that same effect set, for the same reason: once
  the task has left `ready_for_human`, the command refuses to run again, so a
  comment enqueued separately afterwards is unrecoverable if it is refused.
  Those commands also read the lock once up front so the refusal is reported
  before any live repo-host lookup, and exit non-zero saying nothing was
  changed.
- `runNextPhase` commits a completion's effects through
  `completePhaseWithEffects` whenever the task store and the outbox store report
  the same `backendId` — one database, one transaction, one in-transaction lock
  read covering the transition and every effect. Under the supported
  separate-backend pairing (a task store that is not the outbox's database)
  there is no such transaction, so the effects are written to the outbox store
  *before* the transition is attempted. That ordering is what makes a refusal
  safe: the lock is met while nothing has moved, so the run reports
  `maintenance_locked` and the phase re-runs intact. Writing them afterwards
  (best-effort, behind a pre-check) left the unrecoverable direction exposed —
  a lock acquired after the pre-check dropped the completion's comments and
  labels while the run reported `completed`, with no way to replay them from a
  task that had already left the phase. The residual risk of the chosen order —
  effects outliving a transition that then fails its CAS — is recoverable:
  every effect is idempotency-keyed and the re-run re-derives the same set.
  That separate write is itself all-or-nothing: `OutboxStore.enqueueEffects`
  commits the whole effect set in one transaction behind one in-transaction
  lock read, so a lock acquired part-way through cannot leave some rows durable
  while the completion is handed back — otherwise the dispatcher would later
  publish a completion comment or status label for a phase that never committed
  and is about to re-run. A store that cannot offer that transaction falls back
  to per-effect writes, and a refusal that lands mid-set is then treated as
  *non*-retryable: the completion commits (so the already-durable rows announce
  a phase that really did complete) and the shortfall is recorded as an
  `outbox.enqueue.failed` event.
  A `maintenance_locked` completion also hands the claim back (`queued`,
  unowned, pre-claim attempt count) instead of leaving the task `running` on a
  live lease: `archive rollup` acquires with `skipActivityChecks`, so the lock
  can land while a phase is legitimately live, and the retry this outcome
  promises must not wait out a 30-minute lease. That requeue goes through
  `completePhaseWithEffects` with an empty effect set — the one interface
  transition that reads the lock inside its own transaction — never a bare
  `transitionTask`, which is unguarded and would write into a database a
  `restore` is replacing. So when the refusal came from the task store's own
  database the requeue is refused too, and the task is deliberately left
  `running` for lease expiry / `admin task recover` to recover *after*
  maintenance rather than racing it. The re-run still cannot start during
  maintenance, since `claimNextTask` is itself lock-guarded (§ above).

Deliberately **not** guarded: `markSent`, `markFailed`, and `renewClaim`.
Those do not start new work — they resolve or keep alive a dispatch attempt
claimed *before* the lock was acquired, whose external side effect may already
have been published. Since acquisition already refuses while any non-stale
claim exists, a lock can only coexist with an in-flight attempt whose claim has
gone stale, and recording that attempt's outcome is strictly safer than losing
it (the alternative strands the row or lets a second dispatcher duplicate the
effect). Backup remains exempt from this lock entirely, per §8.

**Batched, resumable, never one giant transaction.** Prune processes one data
class and one bounded time/row window per committed SQLite transaction. Each
batch's commit persists a watermark (e.g. "events for session S up to id N
pruned"). An interrupted run (crash, kill, disk-full mid-run) leaves the DB in
a valid state after its last committed batch — never a half-deleted table —
and resumes from the watermark rather than re-scanning already-pruned ranges
or attempting to re-delete rows that no longer exist. Artifact-directory
deletion for a batch happens after that batch's DB commit, per §7's ordering,
and is independently retryable (a repeat `rm -rf` on an already-removed
directory is a no-op, not a failure).

**Partial failure is a normal outcome, not an aborted run.** If a later batch
fails (disk full, permission error, artifact directory unexpectedly missing
verification), the operation stops, reports exactly which watermark it
reached, and leaves everything before that watermark committed. It does not
roll back prior batches — that would re-grow a table the operator already
confirmed removing, and violates the "resumable" property above.

**Guarded status and force-release recovery (issue #817).** A maintenance
process killed before its `finally`/`close()` path runs (an OOM kill, a
`SIGKILL`, a host crash) leaves the `maintenance_lock` row populated with no
live holder able to call `release()` — every later phase claim and
maintenance run then refuses indefinitely with `lock_contended`/
`phase_active`-shaped outcomes, and until this issue the only recovery was
direct SQLite editing. `admin maintenance-lock status --session-ref <ref>
[--json]` is a read-only diagnostic: it reports whether the lock is held,
its holder, acquisition time, age, whether it was acquired via
`skipActivityChecks` (`activityExempt` — see below), the count of task
phases still claimed/running with an unexpired lease, and the count of
`outbox` rows with a non-stale dispatch claim — the exact two counts this
section's acquisition refusal bullets above are computed from, so an
operator can see not just that the lock is held but whether the work it
protects is still genuinely in flight. `status` opens the database
**read-only** and never creates `maintenance_lock` or migrates it (review
follow-up to issue #817) — a naive `CREATE TABLE IF NOT EXISTS` run
unconditionally on open would otherwise mutate a legacy database that
predates this table the first time an operator merely inspects it, and fail
outright against a filesystem-read-only backup. `admin maintenance-lock
release --session-ref <ref> [--yes] [--confirm-stranded] [--json]`
force-releases the lock: unlike the lock's own `release()`, it **ignores the
recorded holder** (the whole reason it exists — no live holder remains to
release its own lock), but it reuses the identical
phase-active/non-stale-outbox-claim predicates `acquire()` refuses on, so a
force-release can never clear a lock while the work it protects is still
genuinely in flight — and (P1 review follow-up below) also requires
`--confirm-stranded` alongside `--yes` before it will delete any held lock,
regardless of holder kind. It follows the standard admin CLI mutation
contract: preview by default, mutates only with `--yes`, and — like `status`
— stays read-only for the preview path, only opening the database for
read/write once `--yes` is actually given. A database with no lock held is a
safe no-op, both in preview and with `--yes` — so a repeated release after
the lock has already cleared (by this recovery path or by its own holder)
never errors. Neither command's output includes the local `dbPath`; the
holder token (e.g. `prune:<pid>:<timestamp>`) identifies a process/run, not
a filesystem path.

**Every holder needs an explicit confirmation, not just `--yes` (issue #817
review, P1).** `admin archive rollup` acquires this lock with
`skipActivityChecks: true` (§9 above) because it only needs mutual exclusion
against another maintenance-lock holder, not the phase/outbox guards
`prune`/`restore` need — which means a rollup's lock shows **zero** live
task phases and **zero** non-stale outbox claims for its entire lifetime,
whether it is genuinely still running or has been stranded by a crash. An
initial version of `forceRelease` treated that as evidence unique to
`skipActivityChecks` holders and required an explicit confirmation only from
them — but `prune`/`restore` are exactly as invisible to those two counts:
both acquire an ordinary, non-`activityExempt` lock and then do their own
destructive work — a delete batch, a file rename — without ever creating a
task lease or outbox claim for it, so a live one of either also shows zero
of both for its entire run. Those being the only two predicates
`forceRelease` checked for a normal holder meant `admin maintenance-lock
release --yes` could force-release a live `prune run --yes` or `restore`
lock exactly as readily as a truly stranded one, letting a second one start
concurrently against it and violate the lock's data-safety contract — the
same race `runArchiveRollup`'s own comments document for the rollup case,
just for `prune`/`restore` too. `acquire()` persists whether an acquisition
used `skipActivityChecks` (the `activity_exempt` column, surfaced as
`status`'s `activityExempt`) purely for `status`/error-message context now;
`forceRelease` refuses to delete *any* held lock — regardless of holder kind
or the phase/outbox counts — unless the caller also passes `confirmStranded`
(`admin maintenance-lock release --yes --confirm-stranded`). This is **not**
a TTL or liveness check the tool performs: `--confirm-stranded` is a
deliberate, explicit operator override, asserting (after checking
out-of-band, e.g. the process list, that no such process still targets this
database) that this specific lock is in fact stranded — the same "an
operator running `status` first is the one positioned to judge this" posture
the paragraph below already applies to every holder kind.

This recovery path is **deliberately** not TTL-based and does not couple to
PID/host liveness — an implementation must not "helpfully" add either. A
maintenance run legitimately holds this lock for as long as its batched
prune/rollup/restore work takes (§9's "batched, resumable, never one giant
transaction" above), which has no fixed upper bound; any TTL short enough to
be useful for stranded-lock detection is also short enough to fire on a
still-running, healthy maintenance pass on a large table, and PID liveness
is meaningless across the host reboots and container respawns this system
already has to tolerate (a crashed process's PID can be reused by an
unrelated process before an operator ever looks). The two activity checks
above are the only correctness gate this contract requires; "is a
maintenance run *actually* stranded" is a judgment only an operator running
`status` first, then `release --yes`, is positioned to make.

## 10. Multi-session isolation

Multiple sessions can share one physical SQLite file. `tasks` (and
`context_records`) rows carry a `session_id` column today, so row-scoped
retention is well-defined for them. **`outbox` has no dedicated
`session_id` column**, but it is not true that no persisted, queryable
session attribution exists at all: every writer builds `idempotency_key` via
`makeOutboxKey(session.sessionId, ...)` (`core/outbox.ts`,
`core/outbox-effects.ts`) with `sessionId` as the key's first
colon-delimited component, and `cli/issue-plan-history.ts` already relies on
exactly this — it filters `outbox` comment rows with
``idempotency_key.startsWith(`${sessionId}:`)`` to keep a shared-repo,
multi-session database from attributing one session's comment to another
(`issue-plan-history.ts`'s `readHistory`). That is a real, persisted,
already-queried association for every row written by the current
`makeOutboxKey` convention; what is genuinely missing is a dedicated indexed
column — matching still means testing `idempotency_key` against each
candidate session's id as a string prefix rather than an indexed equality
lookup, and it says nothing about rows from before that convention existed
(if any). Sessions are additionally isolated at dispatch time by matching
`payload.owner`/`payload.repo` against the dispatching session's configured
repo (`core/outbox.ts`, `handlers/gh-dispatcher.ts`) — that check alone
*is* a runtime filter, not a persisted, queryable association, because two
sessions configured against the same `owner/repo` are indistinguishable by
`payload.owner`/`payload.repo` in the stored row; the `idempotency_key`
prefix does not have *that* ambiguity — distinct session ids always produce
distinct first components — but it has a different one of its own, addressed
next.

**The `${sessionId}:` prefix test is only unambiguous when configured
session ids are colon-boundary prefix-free.** `makeOutboxKey` joins its
parts with an unescaped `:` and does not escape any `:` that already
appears inside `sessionId` itself, so a key built from
`sessionId = "team:blue"` (e.g. `"team:blue:42:run-abc:..."`) also satisfies
`startsWith("team:")` — the exact test both `issue-plan-history.ts` and the
backfill below use to attribute rows to a session literally named `"team"`.
Whenever two currently-configured session ids stand in this relationship —
one id, with a trailing `:` appended, is a literal prefix of another id with
a trailing `:` appended (`"team:"` is a prefix of `"team:blue:"`) — a row
genuinely owned by the longer id matches *both* candidates' prefix tests,
and there is no general way to tell from the key text alone which id
actually produced it: a `startsWith` match only proves the key's leading
characters equal the candidate id followed by `:`, not that the candidate
id is the *whole* first colon-delimited component `makeOutboxKey` was
called with. Picking the longest matching candidate is not a safe
substitute for resolving this: a row from session `"a:b"` whose second
`makeOutboxKey` argument happens to stringify to `"c"` produces
`"a:b:c:..."`, which also satisfies `startsWith("a:b:c:")` for an unrelated
but currently-configured session literally named `"a:b:c"` — the longer
match there is the *wrong* owner, not the right one. This contract
therefore requires configured session ids to be **colon-boundary
prefix-free**: no currently-configured session id, with a trailing `:`
appended, may be a prefix of another currently-configured session id with a
trailing `:` appended. Session configuration (loading `sessions.json` and
equivalents) must validate this invariant at load time and refuse to start
with a colliding pair — the same fail-closed posture as every other
configuration precondition in this contract. This is a general
encoding-safety requirement of the `makeOutboxKey`/`startsWith` convention
itself, not one scoped only to the migration below — `issue-plan-history.ts`'s
existing filter shares the identical exposure today, silently
misattributing (or under-attributing) rows between a colliding pair rather
than refusing to start.

This has consequences for retention/backup:

- **Row-scoping defaults to one session, for data classes that can express
  it.** Every destructive retention command targets exactly one
  `--session-id`/`--session-ref` by default, matching every other
  session-scoped admin command's convention (`docs/admin-cli-contract.md`
  "Common option names"). There is no implicit "prune the whole file"
  default. This applies to `tasks`/`events`/`context_records` pruning as
  specified in §5–§7.
- **Outbox rows are excluded from session-scoped retention until a persisted
  `session_id` column exists.** A session-scoped prune or rollup cannot
  safely identify "this session's rows" by querying `payload.owner`/
  `payload.repo` as a proxy — that remains unsafe whenever two sessions
  share a repo, since it would let one session's prune delete another
  session's delivered or dead-lettered rows. Therefore: **no outbox row may
  be pruned, and no outbox rollup (§6) may be generated, on a session-scoped
  basis until #611's split issues add a persisted `session_id` column to
  `outbox`** (schema migration plus a backfill strategy for pre-existing
  rows). The backfill must refuse to run at all while any two
  currently-configured session ids violate the colon-boundary prefix-free
  invariant above — the migration is exactly the kind of full-file,
  every-row attribution pass that invariant exists to protect, so the
  precondition is checked once up front rather than re-litigated per row.
  Given a prefix-free configuration, the backfill's primary attribution
  source must be the `idempotency_key` prefix described above, not
  `payload.owner`/`payload.repo`: for each existing row, test
  `idempotency_key` against every currently-known session id as a
  ``startsWith(`${sessionId}:`)`` match (the same predicate
  `issue-plan-history.ts` already applies at query time); because the
  configuration is prefix-free, at most one currently-known session id can
  match a given row this way, and a row so matched backfills to that
  session. A row matching zero currently-known session ids by this test is
  not automatically ambiguous — a colliding pair can no longer produce that
  outcome, so a zero-match result here means either a row predating the
  `makeOutboxKey` convention or a row from a since-removed session id no
  longer covered by the live invariant; both fall through to the
  `payload.owner`/`payload.repo` fallback below. `payload.owner`/
  `payload.repo` is that fallback for the residual case only — a row whose
  `idempotency_key` matches zero known sessions — and even there only
  backfills when exactly one currently-configured session targets that
  `owner`/`repo`; a row left unresolved by both the key-prefix pass and that
  unambiguous owner/repo fallback stays unresolved rather than guessed.
  Until this migration ships, the outbox floors in §5 govern only a
  **whole-file** sweep (no
  `--session-id` scoping possible), and that whole-file sweep must still
  satisfy every other precondition in this contract (backup, locking, and
  rollup coverage — keyed by `dbPath` + time range rather than session +
  time range, per §6's file-wide coverage rule). A later implementation must
  not add `--session-id` filtering to *ongoing* outbox pruning by querying
  `payload.owner`/`payload.repo` as a substitute for the migrated column —
  that is the exact unsafe shortcut this rule forecloses; the one-time
  backfill's narrow, unambiguous-only owner/repo fallback above is not an
  exception to it, since after migration every row is queried by the
  persisted column, never by owner/repo again.
- **Post-migration `session_id IS NULL` rows get a permanent, narrower
  whole-file path — never a dead end.** The backfill above intentionally
  leaves a row unresolved rather than guessing its session; without an
  explicit rule those rows would have no permitted coverage scope once the
  migration lands, since the pre-migration whole-file sweep above applies
  only *until* the migration ships, and per-session coverage is impossible
  for a row with no session. This contract does not accept that as an
  implicit permanent exclusion from maintenance: `outbox` rows with
  `session_id IS NULL` keep indefinite access to the same whole-file sweep
  mechanics §6 defines for the pre-migration case, narrowed to exactly that
  subset — coverage keyed by `dbPath` + `session_id IS NULL` + time range,
  and a NULL-scoped prune pass that only ever deletes rows still carrying
  `session_id IS NULL`, never a row the backfill resolved or a row enqueued
  after migration (which always carries a non-null `session_id`, per §13
  item 3a). This path is not a temporary migration-window allowance; it
  persists for as long as any unresolved legacy row exists, because the
  backfill runs once and never retries a row it already declined to guess.
  A prune preview that includes this path must label it distinctly (e.g.
  `unresolved legacy outbox rows`) so an operator never mistakes it for a
  session-scoped or full whole-file prune.
- **File-level operations are not session-scoped, even though row deletion
  is.** Prune's `DELETE`s touch the physical file regardless of which
  session's rows triggered them. The maintenance lock (§9) is therefore a
  **file-level** lock keyed by `dbPath`, refused if *any* session sharing that
  file has an active phase — not just the target session — to prevent
  prune racing a different session's in-flight write. Backup is exempt from
  this lock (§9): its online, concurrent-safe primitive (§8) is exactly what
  lets it read a consistent snapshot of a file shared by multiple active
  sessions without contending for file-level exclusivity at all.
- An explicit multi-session sweep (e.g. an `--all-sessions` flag, an
  implementation choice for #611) may exist for an operator who intentionally
  wants to prune every session sharing a file, but it must never be the
  default, and its preview must enumerate every affected `session_id` before
  requiring confirmation — silently touching a session the operator did not
  name is exactly the failure this rule prevents.

## 11. Disk-pressure behavior and operator warnings

No disk-space check exists anywhere in this codebase today (`session-doctor`
does not check free space — `DOMAIN.md` §4 finding 6 already tracks that gap
separately as backlog work, and this contract does not fold that broader
phase-execution gating into #611). Scoped to retention/backup/prune only:

- **Backup refuses to start, rather than fail midway, when free space on the
  backup destination filesystem is insufficient.** A backup (§8's Backup API
  requirement) needs roughly the size of the live DB again in free space —
  but on a WAL-mode database, "the live DB" for this purpose is the
  **logical snapshot** the backup will materialize, not just `dbPath` on
  disk: an uncheckpointed `dbPath-wal` can hold a large volume of pages not
  yet folded into the main file, and the Backup API must include those pages
  in its output. Sizing the estimate off `dbPath` alone therefore admits
  operations that can still exhaust disk midway on a busy WAL database with
  a large sidecar. The estimate must be `(dbPath size + dbPath-wal size) ×
  1.5`, re-reading the `-wal` file size immediately before the check (not a
  cached value from an earlier inspection) since it can grow between an
  operator glancing at disk usage and backup actually starting.

  **This estimate must be checked against the filesystem that will actually
  receive the bytes, not against `dbPath`'s filesystem.** The backup output
  path and `dbPath` are not guaranteed to share a filesystem — pointing
  backups at a separately mounted volume is common practice for exactly this
  kind of disaster-recovery hygiene — so a check against `dbPath`'s
  filesystem is only correct by coincidence:
  - If the destination volume is nearly full while `dbPath`'s volume has
    ample space, a `dbPath`-only check would let the backup start and still
    exhaust disk on the destination side — precisely the half-written,
    unverifiable backup file this refusal exists to prevent.
  - If `dbPath`'s volume is tight while the destination volume has abundant
    space, a `dbPath`-only check would refuse a backup that was in fact safe
    to run, since none of its bytes land on `dbPath`'s volume.

  The free-space check must therefore run against the filesystem containing
  the backup output path, and, when the implementation stages the backup
  under a temporary path before an atomic rename/move into its final
  location, the temporary path's filesystem as well if it differs from the
  final destination's. Refusing up front against this WAL-inclusive headroom
  estimate, checked at the destination, is strictly better than starting a
  backup that runs out of disk and leaves a half-written, unverifiable
  backup file behind.
- Because backup is prune's hard precondition (§8), a refused backup means
  prune never runs under disk pressure either — this is the intended
  fail-closed behavior, not a gap: pruning to relieve disk pressure without a
  verified backup first would defeat the entire point of §8.
- **Operator warning surfaces independently of any prune attempt.** A
  disk-pressure warning belongs on the read-only inspection surface (`admin
  doctor`/`session-doctor`, once #611 lands the check) so an operator learns
  about pressure before they try to run maintenance and hit the refusal above
  — the warning and the refusal are two different code paths and #611 should
  not conflate "tell the operator" with "block the operation."

## 12. Exclusions

These categories are **never** touched by any retention/archive/prune
operation this contract governs, at any age, with no override flag:

- **Active tasks** — any task in the active or delayed bucket (§4), regardless
  of `updated_at` age. "Old" is not "safe to remove" for a task still in
  flight.
- **Human-gated tasks** — `ready_for_human`/`blocked`, regardless of age. A
  task waiting on a human is not stale merely because it has waited a long
  time; that is exactly the case an operator most needs the row to still
  exist for.
- **Live worktrees and their locks** — worktree directories and
  `IssueWorktreeLock` state are Execution-owned (`DOMAIN.md` §2.3) and already
  fully specified by `docs/per-issue-worktrees.md` and its `admin worktree
  prune`/`cleanup`/`release-lock` commands. This contract does not gain any
  authority over worktrees or locks by implication — a later prune
  implementation must not reach into worktree directories or lock sidecar
  files, even indirectly via an artifact-directory sweep that happens to share
  a parent path.
- **Unresolved Tool Requests** — a task carrying `context.toolRequest` with
  `resolved !== true` (`core/tool-request.ts`) is excluded outright, as noted
  in §4 — this is checked independently of, and in addition to, the task's
  nominal status bucket.
- **Rows a rollup does not yet cover** — per §6, raw task/event/outbox-history
  deletion is refused, categorically, until a covering rollup exists and its
  coverage window is verified to be a superset of the rows targeted.
- **Context records, until reachability is implementable** — per §4, no
  persisted association currently links a `tasks` row to the `context_id`(s)
  it uses, so orphan-classification cannot be computed from stored data. Every
  context record is excluded outright, regardless of age, until #611 adds one
  of the persisted associations §4 describes.
- **Outbox rows, on a session-scoped basis, for as long as no session
  association is resolvable** — per §10, `outbox` has no persisted
  `session_id` before the §13 item 3a migration lands. A session-scoped prune
  or rollup must not run against outbox rows until that column (and its
  backfill) exists; only a whole-file sweep is possible in the meantime, and
  even that must still satisfy every other precondition in this contract.
  After migration this exclusion narrows rather than disappears: rows the
  backfill could not resolve (`session_id IS NULL`) stay permanently excluded
  from *session-scoped* pruning specifically, but — per §10's NULL-scoped
  path — are not excluded from maintenance altogether; they are archived and
  pruned via the permanent NULL-scoped whole-file sweep instead.
- **Backups themselves, below the retention floor** — per §8, the most recent
  3 verified backups are never pruned by any operation this contract governs
  (a future backup-rotation command is free to rotate older ones, but that is
  #611's backup issue to design, not this section's floor to lower).
- **Outbox rows, terminal (sent), until a true completion timestamp exists**
  — per §4 and §5, `sent_at` is currently populated with the pre-dispatch
  `claimedAt`, not the time the external effect actually completed, so age
  computed from it is not a lower bound on true completion time. Every
  terminal-sent row is excluded outright, regardless of age, until §13 item
  3c's dispatcher fix lands.

## 13. Follow-up implementation scope (#611)

Per `docs/DOMAIN.md` §4.1, #611 is the tracking issue and splits into three
implementation issues along this contract's natural seams. Each is
independently testable against this document without needing the others
merged first (backup has no dependency on archive or prune; archive has no
dependency on backup either — §6 makes rollup generation read-only against
the stores it summarizes, so it needs no backup precondition, only a fresh DB
to read; prune depends on both backup, per §8's precondition, and archive,
per §6's coverage-check precondition):

1. **Backup** — implements §8: the online-backup primitive (`better-sqlite3`
   Backup API, `db.backup(path)` — not `VACUUM INTO`, which cannot satisfy
   §8's same-transaction verification requirement), the integrity/row-count
   verification step,
   the 3-backup retention floor, the durable `session_roots(session_id,
   artifact_root)` table (§8) and its one-time migration backfill, the
   manifest's `session_id → artifactRoot` mapping derived from that table,
   the centralized list of artifact-directory context-field names (§8 point
   5), adding the missing `isSafeArtifactDirAfterRun` call, immediately after
   `mkdirSync`, to `implementation.ts`, `review.ts`, `research.ts`, and
   `conflict-resolution.ts` (only `content-draft.ts` and `content-review.ts`
   call it today), the paired creation-marker field each handler in that
   list must write, and the paired `run_artifact_created` flag
   `enqueueTaskResultEffect` must write alongside a phase-result outbox
   row's `run_id` (§8). Testable
   independent of prune: "backup against a live DB with concurrent writers
   produces a file that passes `PRAGMA integrity_check`, and a phase/outbox
   mutation issued while that backup is in flight is never refused with a
   `lock_contended`-shaped outcome — backup never acquires the maintenance
   lock (§9)", "a failed/incomplete
   backup is never counted toward the retention floor", "disk-pressure
   refusal per §11 fires before any partial file is written", "a backup of a
   `dbPath` shared by two sessions with distinct `artifactRoot`s records both
   sessions' roots in the manifest from their `session_roots` entries, and
   restore's artifact consistency check (§8 point 5) resolves each session's
   rows against its own recorded root rather than a single implied one",
   "a restored task row carrying an artifact-directory field without its
   paired creation marker (e.g. a review admission-rejection or
   repo-host-resolution-failure context) never fails restore for a missing
   directory, while the same field WITH its marker set does fail restore
   when that directory is missing", "a session removed from
   `sessions.json`/config after writing rows still has a `session_roots`
   entry, a backup taken after that removal still records the session's root
   in the manifest from that entry, and restore against that session's
   retained, marker-carrying rows succeeds using the recorded root", "a
   session whose only present rows carry no marker-paired artifact-directory
   field is not required to have a `session_roots`/manifest entry for backup
   to succeed", "a phase-result outbox row enqueued for a preflight-rejected
   review carries a non-null `run_id` with `run_artifact_created = false`,
   and neither the manifest mapping nor restore's artifact-consistency check
   requires an entry for it", "a session's write is refused, and its
   `session_roots` entry left unchanged, when the live-configured
   `artifactRoot` differs from the recorded one and the session still has a
   `tasks`/`context_records`/artifact-marked-`outbox` row within its
   retention window resolving under the old root", "the same write succeeds
   and updates the entry to the new root once no such old-root row remains",
   "a backup taken after a permitted root update resolves that session's
   post-update rows against the new root and never against the stale one."
2. **Archive** — implements §6: the rollup generation (read-only) and its
   coverage-window bookkeeping. Testable independent of prune: "a rollup
   generated over a fixed event set reproduces the same L3 intervention counts
   `admin interventions` reports over that same raw data, including for an
   arbitrary `--issue-number`/`--since`/`--until` combination not known in
   advance", "coverage window recorded matches the actual session/time range
   summarized", "unobservable signals are recorded, never silently reported as
   zero", "a rollup generated over a fixed set of issues reproduces the same
   finality/difficulty classification `issue-plan-history` computes over that
   same raw data, per issue", "a rollup generated over a task set that
   includes a legacy task with `context.toolRequest.resolved === true` and no
   `tool_request_*` event reproduces the same `tool_request_resolution` count
   `aggregateL3Interventions`'s task-context fallback would have reported for
   that task, including its resolution timestamp, and that count survives
   deletion of the underlying task row." **Session-scoped** outbox rollups are
   blocked on the schema migration in item 3a below and must not ship ahead of
   it (§10). A **whole-file, `dbPath`-scoped** outbox rollup is not blocked by
   that migration — §6's file-wide coverage rule and §10 both require this
   archive issue to produce one, keyed by `dbPath` + time range, so that the
   whole-file outbox sweep permitted by the prune issue (item 3) has a
   rollup to satisfy §5's precondition before that migration lands. Testable:
   "a whole-file outbox rollup generated before `outbox.session_id` exists
   records dead-letter counts by topic and a `dbPath` + time-range coverage
   window, and a whole-file prune pass can verify that window is a superset
   of the rows it is about to delete."
3. **Prune** — implements §5, §6 (reader-side merge), §7, §9, §10, §12
   together: the store-level ports (`DOMAIN.md` §2.3 — no raw SQL from
   `admin.ts`), the maintenance lock, batched/resumable deletion,
   DB-then-artifact ordering, the full exclusion matrix, and updating
   `admin interventions`/`issue-plan-history` to read and merge rollup data
   per §6's reader-merge requirement. Testable: a post-prune report test
   proving that, for an issue/window with both a pruned (rollup-only)
   sub-range and a retained (raw) sub-range, `admin interventions`'s and
   `issue-plan-history`'s output over the full window is identical to what an
   unpruned raw-only run over that same window would have produced; one test
   per exclusion in §12 proving the row survives an otherwise-eligible prune
   pass; an interrupted-batch test
   proving resume-from-watermark never double-deletes or re-scans; a
   backup-precondition test proving prune refuses without a fresh verified
   backup; a multi-session test proving a session-scoped prune never touches
   another session's rows sharing the same file, and that the file-level
   maintenance lock still blocks while any sharing session is active; a
   phase-start-vs-maintenance-lock race test proving a task claim attempted
   immediately after maintenance acquires its lock is refused/retried rather
   than allowed to start and run concurrently with maintenance (§9); a
   requeue-race test proving a task requeued/recovered/cancelled after a
   prune batch selects it but before that batch commits is not deleted —
   either because the mutating command was itself refused while the
   maintenance lock was held, or because the batch's conditional delete
   revalidates every §4/§12 exclusion predicate at commit time and no-ops on
   the now-ineligible row (§9); an artifact-vs-backup-retention test proving
   an artifact directory referenced by a currently retained backup survives
   an otherwise-eligible prune pass, and is only removed after the backup
   that references it rotates out (§7, §8); an already-orphaned-artifact test
   proving a directory with no surviving row and no durably persisted
   deletion marker is not removed at its mtime-based floor while a currently
   retained backup predates the sweep's own persisted `first_observed_at`
   for it, and is only removed once every retained backup postdates
   `first_observed_at` (§7).

   This issue also carries three prerequisites this contract identifies but
   does not design (§4, §10) — all three must land, with tests, before the
   corresponding data class's pruning/rollup logic can be implemented, not
   merely before it can be enabled:
   - **3a. Outbox session association** (§10): add a persisted `session_id`
     column to `outbox`, plus a backfill strategy for pre-existing rows. Also
     add a structured, queryable, **nullable** `run_id` field (`runId` today
     lives only inside a composed `idempotencyKey` string and comment/label
     body text, `core/outbox-effects.ts`), **plus a backfill strategy for
     pre-existing rows equally rigorous to the `session_id` backfill
     described below** — both columns together are what
     lift §8 point 5's outbox exclusion from the restore artifact-consistency
     check, and the `run_id` field is additionally a prerequisite for §7's
     artifact-directory deletion gating: until it exists, deletion cannot
     safely rely on "no row references this run-id" for any run-id an
     outbox row could hold. **`run_id` must be nullable because not every
     outbox row is produced by a phase run.** `github-intake.ts`'s
     intake-reactivate effect (clearing the blocked label on task
     reactivation) enqueues with no run in scope at all, and
     `enqueueQuotaDelayCommentEffect` (`core/outbox-effects.ts`) intentionally
     keys its idempotency on `notBefore`, not a run, because the same delay
     window must dedupe across repeated scheduler ticks rather than produce
     one comment per attempt. The migration must not force these effects to
     fabricate a `run_id` merely to satisfy a non-null column — a fabricated
     value would point restore's artifact-consistency check (§8 point 5) and
     §7's deletion gating at a `runs/<run-id>/` directory that was never
     created, turning a legitimate row into a permanent restore failure or a
     permanently undeletable phantom reference. Only outbox rows whose effect
     genuinely references a run (e.g. the phase-result comment enqueued by
     `enqueueTaskResultEffect`) carry a `run_id`; for a row enqueued after
     this migration by a confirmed run-less effect, a null `run_id` is not
     treated as unresolved or unresolvable — it correctly means "this row has
     no artifact directory to check."

     **A non-null `run_id` is not by itself proof that a `runs/<run-id>/`
     directory was ever created, and artifact-reference checks in §7 and §8
     must not treat it as one** — the same distinction point 5 above already
     draws for task context fields applies here. `enqueueTaskResultEffect` is
     invoked by `runNextPhase` after every phase attempt reaches a terminal
     or delayed outcome, including a preflight rejection that never reaches
     the handler's own artifact-directory creation step —
     `createReviewHandler`'s admission-rejection (`review.ts:598,600`) and
     repo-host-resolution-failure (`review.ts:636-641`) paths are two such
     cases (point 5 above), and both still return through `runNextPhase`,
     which enqueues the phase-result comment stamped with that attempt's
     `request.runId` regardless. Treating every non-null `run_id` on an
     outbox row as artifact-producing would fail restore on an entirely
     ordinary backup — a rejected review's phase-result comment pointing at a
     `runs/<run-id>/` directory that was never supposed to exist, exactly the
     failure mode point 5 already rules out for context fields. The enqueue
     path must therefore pair `run_id` with the same kind of
     creation-provenance signal used there: `enqueueTaskResultEffect` also
     records a `run_artifact_created` flag (nullable boolean) alongside
     `run_id`, set `true` only when that same phase attempt's handler run
     also set a paired `<field>Created` marker (point 5) before
     `runNextPhase` enqueued the comment, and `false` on every path that
     never reaches the handler's own directory-creation step (including both
     `review.ts` paths above). §7's deletion gating and §8 point 5's restore
     validation apply to an outbox row's `run_id` only when
     `run_artifact_created` is also `true`; a non-null `run_id` with the flag
     `false` (or unresolved — see the migration note below) is treated
     exactly like a `NULL` `run_id` for artifact-reference purposes — it
     correctly means "this row references a run, but that run never created
     an artifact directory to check" — while the `run_id` value itself is
     still retained and still used for prune/rollup correlation unrelated to
     artifact validation.

     **This guarantee holds only for rows the migration positively
     classifies — it does not hold for pre-existing rows by default.**
     `ALTER TABLE ADD COLUMN run_id` leaves every row that existed before the
     migration with `run_id = NULL` regardless of what that row's effect
     actually referenced; the column's prior absence is not evidence the row
     is run-less, only that no queryable field existed to say so. Backfill
     must therefore parse every pre-existing row's `idempotencyKey` and
     comment/label body text — the same free-text locations that today hold
     the only copy of a `runId` (§7) — and assign the extracted `run_id`
     wherever a run reference is found there. A pre-existing row is only
     backfilled to `NULL` when parsing finds no run reference **and** the
     row's effect type is one of the confirmed run-less kinds (the
     `intake-reactivate` label-clear and the `notBefore`-keyed quota-delay
     comment above, or an equivalent confirmed-run-less effect added later);
     a pre-existing row of any other effect type, or any row the backfill
     cannot confidently classify, is left in a distinct **unresolved**
     state — a sentinel `run_id` value or a separate `run_id_resolved`
     boolean, never bare `NULL` — rather than defaulted to absent. §7's
     artifact-directory deletion gate treats an unresolved row exactly as it
     treats today's pre-migration unresolvable outbox reference: it blocks
     deletion of any run's artifact directory the row cannot be proven not to
     reference, and a database does not begin treating `NULL` as absent for
     deletion purposes until every pre-existing row in it has been resolved
     one way or the other. Testable: "a pre-existing outbox row whose
     `idempotencyKey` or body embeds a run-id is backfilled to that
     `run_id`, not left `NULL`", "a pre-existing row of a confirmed
     run-less effect type is backfilled to `NULL`", "a pre-existing row
     backfill cannot classify is marked unresolved, not `NULL`",
     "artifact-directory deletion for a run-id still referenced by an
     unresolved legacy row is blocked even though no row exposes a matching
     non-null `run_id` column value", "a database with zero unresolved
     legacy rows remaining permits `NULL` to be treated as absent, and a
     database with any unresolved row remaining does not."
     **The `session_id` recorded must be the producing/owning session — the
     task's session that enqueues the row — never the session that later
     runs the dispatcher.** `OutboxStore.enqueue` (`core/outbox.ts`) is called
     by the task's own session at the point a work item is produced; a
     dispatcher (`handlers/gh-dispatcher.ts`) that later claims and sends the
     row can belong to a different session sharing the same `dbPath` (e.g.
     two sessions configured against the same `owner`/`repo`, §10). Stamping
     the dispatching session's id instead would let session B's dispatcher
     assign its own id to a row session A produced, so a session-scoped prune
     targeting A would miss the row (it now looks owned by B) or a prune
     targeting B would delete a row A still needs — either way the wrong
     session's retention/rollup governs it. The enqueue API (`OutboxStore
     .enqueue`/`OutboxEnqueueInput`, `core/outbox.ts`) must therefore accept
     the producing session's id as an explicit parameter supplied by the
     caller at enqueue time, not derive it later from whichever session
     happens to dispatch the row. Testable: "a freshly inserted outbox row
     records the *enqueuing* session's id, not the id of whatever session
     later dispatches it, and its structured `run_id` when the enqueuing
     effect references one", "an outbox row enqueued by an effect that is not
     tied to any run (`intake-reactivate`'s label-clear, the quota-delay
     comment keyed on `notBefore`) is inserted with `run_id` left `NULL`
     rather than a fabricated value", "a row enqueued by session A and
     dispatched/sent by session B (both configured against the same
     `owner`/`repo`) still carries session A's id after `markSent`",
     "backfill assigns a `session_id` to every pre-existing row unambiguously
     resolvable from `payload.owner`/`payload.repo`, and leaves ambiguous rows
     (matched by more than one session) unresolved rather than guessing",
     "session configuration refuses to load when two configured session ids
     violate the colon-boundary prefix-free invariant (§10), e.g.
     `"team"` and `"team:blue"` configured together", "the backfill refuses
     to run against a configuration violating that invariant rather than
     silently misattributing the colliding ids' rows", "given a prefix-free
     configuration, a pre-existing row whose `idempotency_key` was built from
     `sessionId = "team:blue"` backfills to `"team:blue"`, not left
     unresolved merely because its key also happens to start with
     `"team:"`", "a
     session-scoped outbox prune only ever deletes rows carrying the target
     session's id", "restore's artifact consistency check resolves a
     post-migration outbox row's `run_id` against its recorded session's
     `artifactRoot`, the same as a task/event row, only when that `run_id` is
     non-null AND `run_artifact_created` is `true`, and skips the check
     entirely for a row whose `run_id` is `NULL` or whose
     `run_artifact_created` is `false`/unresolved", "a phase-result outbox
     row enqueued by `enqueueTaskResultEffect` for a preflight-rejected
     review run (`review.ts:598,600` or `review.ts:636-641`) carries a
     non-null `run_id` but `run_artifact_created = false`, and restore's
     artifact-consistency check does not fail on it despite no
     `runs/<run-id>/` directory ever existing for that run", "a NULL-scoped
     outbox rollup generated after migration records
     a `dbPath` + `session_id IS NULL` + time-range coverage window covering
     exactly the rows still unresolved at that point, and a NULL-scoped
     prune pass run against it deletes only rows still carrying
     `session_id IS NULL` — never a row the backfill resolved to a session,
     and never a row enqueued after migration, since post-migration enqueues
     always carry a non-null `session_id`."
   - **3b. Context-record reachability** (§4): add a persisted association
     between a `tasks` row and the `context_id`(s) it uses (or an equivalent
     lifecycle marker on `context_records`, per §4's options). Testable: "a
     context created before its owning task's first phase starts is not
     classified orphaned", "a context record's reachability answer matches
     manual inspection of which tasks still reference it, without relying on
     `events.data.contextId` alone."
   - **3c. Sent-completion timestamp** (§4): fix `gh-dispatcher.ts` to capture
     a timestamp immediately after `dispatchEntry` resolves successfully and
     pass that value — not the pre-dispatch `claimedAt` it captured before
     calling `dispatchEntry` — as the `sentAt` argument to
     `outboxStore.markSent(entry.id, sentAt, claimToken)`. This is an
     application-logic fix, not a schema migration — `sent_at` already exists
     as a column, it is simply populated with the wrong timestamp today — but
     it gates the terminal-sent floor exactly like a schema prerequisite
     because no query over the existing column can recover the true
     completion time after the fact. `claimToken` (the third argument, used
     for the claim-fencing `WHERE claimed_at = ?` predicate) is untouched by
     this change; only the value stamped into `sent_at` moves from the
     pre-dispatch to the post-dispatch capture. Testable: "a dispatch that
     takes longer than the terminal-sent floor to complete is not eligible
     for pruning immediately upon completion", "`sent_at` on a successful,
     uncancelled send is always at or after the row's `claimed_at` value
     going into that attempt, never equal to it for a dispatch that took any
     measurable time", "the claim-token fencing behavior on a stale-claim
     completion (§4's raced-row case) is unchanged by this fix — a
     rejected/no-op `markSent` still leaves the row open exactly as before."
