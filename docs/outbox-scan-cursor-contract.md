# Outbox scan cursor contract (three cursors)

Status: **implemented**. This document specifies behavior that ships today in
`src/handlers/gh-dispatcher.ts` (`dispatchOutbox`), `src/core/outbox-scan-cursor.ts`
(key derivation and rewind rule), `src/cli/dispatch-outbox.ts` (ownership scope),
`src/cli/admin.ts` (`outbox retry`) and `src/stores/sqlite-outbox-store.ts`
(`retryEntry`). It is a behavioral contract, not a proposal: an edit that changes
any rule here must change the code and the tests in the same commit.

Issue #819 formalizes the model introduced by issue #606 and its review
follow-ups; issue #820 adds retry-triggered cursor rewind (§13). Nothing in this
document removes a persisted cursor, creates a cursor that does not already
exist, or redesigns the outbox schema (§11).

## 1. Why cursors exist at all

`dispatch-outbox` runs as a **fresh process each time**, so the in-memory
`afterId` pagination cursor does not survive between invocations. A
session-bound run owns only the rows its `filter` matches. Two facts then
collide:

1. A run must be **bounded** — it may not page through an entire shared pending
   backlog (another session's rows, a provider outage's accumulated rows) on
   every invocation.
2. A bounded run that finds nothing must still make **progress**, or it re-scans
   the same non-matching prefix from row 1 forever and never reaches the owned
   row behind it.

A persisted cursor is what reconciles them: it records how far a previous run
for the same dispatch identity already ruled out, so the next run resumes rather
than restarts. The cost of getting it wrong is not a slow run — it is a
**permanently stranded row**, because `listPendingEntries({ afterId })` selects
`id > afterId` and never looks back.

One cursor is not enough. A single "resume here" cursor must simultaneously be
held back by the oldest owned row still waiting (or the row is skipped) and be
pushed forward past a large foreign backlog (or progress never accumulates).
Those are contradictory requirements, so the model splits them across three
cursors with distinct jobs.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| **Dispatch identity** | The value passed as `DispatchOptions.scanCursorKey`. Derived from the ownership scope (§4). |
| **Owned row** | A pending, non-dead-lettered row for which `opts.filter` returns true (or any pending row when no filter is given). |
| **Foreign row** | A pending row `opts.filter` rejects. It belongs to some other identity's scope. |
| **Due row** | An owned row whose `nextAttemptAt` is unset or `<= now`. Only due rows are dispatched. |
| **Delayed row** | An owned row with a future `nextAttemptAt` — in retry backoff. Scanned, never dispatched this run. |
| **Resolved row** | A row this run confirmed `sentAt` or `deadLetterAt` (cancellation sets `deadLetterAt` too). It leaves the pending set. |
| **Still-open row** | An owned row that was scanned this run and is not resolved: delayed, failed-and-rescheduled, or matched but left un-attempted by the dispatch `limit`. |
| **Protected zone** | The id span `(floor, zoneEnd]` re-walked in full every run (§7, Phase A). |

## 3. The three cursors

All three are rows in `outbox_scan_cursor (scan_key TEXT PRIMARY KEY, after_id
INTEGER)`. All three are `afterId`-style **exclusive** lower bounds except where
§8.2 says otherwise.

| Role | Persisted key | Job |
| --- | --- | --- |
| `floor` | the dispatch identity, verbatim | The lower bound that preserves visibility of delayed or retryable rows. Never advances past a row this identity still owns and has not resolved. |
| `fwd` (protected-zone end) | `<len>:<identity>:fwd` | Marks the far edge of the protected zone — the last still-open owned row. Forward progress through the near/current range: the whole zone is re-walked every run. |
| `bulk` | `<len>:<identity>:bulk` | Bounded scanning through older or foreign backlog. The furthest position confirmed foreign or resolved. Advances independently of how many rows the zone still protects. |

**Why three and not two.** With a single forward cursor, two or more
simultaneously delayed owned rows sitting ahead of a foreign backlog larger than
`scanLimit` froze progress indefinitely: the cursor was pinned at the second
delayed row's position on every run, and whatever the bulk scan achieved past it
was discarded. Splitting "how far it is safe to forget" (`bulk`) from "what must
still be revisited" (`floor`, `fwd`) is what makes progress and protection
independent.

## 4. Ownership scope and key derivation

### 4.1 One shared derivation

`src/core/outbox-scan-cursor.ts` owns the only derivation. No other module may
build a `scan_key` string.

```
identity = deriveOwnershipScanCursorKey(scope)
scan_key = deriveScanCursorKey(identity, role)
```

### 4.2 The ownership scope tuple

The scope is the `sessionId` **plus the full repository/provider ownership
tuple** the dispatch filter is built from:

```
[ sessionId, githubOwner, githubName, giteaOwner|null, giteaRepo|null, giteaBaseUrl|null ]
```

`sessionId` alone is **not** a sufficient scope. A cursor asserts "everything up
to this id is foreign or resolved *for this filter*"; that claim is only
transferable while the filter is unchanged.

`giteaBaseUrl` participates because the same `owner/repo` pair on two Gitea
instances is two different ownership scopes.

### 4.3 Injectivity of the identity

`deriveOwnershipScanCursorKey` is `JSON.stringify` of an array of primitive
strings and `null`s. That encoding is injective: quotes and backslashes inside a
component are escaped, so no component's content can be mistaken for a
delimiter, and distinct tuples always produce distinct strings. No additional
escaping layer is needed.

### 4.4 Injectivity of the per-role key

`fwd` and `bulk` are **length-prefixed**, not suffixed: `<len>:<identity>:<role>`.

A plain suffix would collide. Dispatch identities are only validated as nonempty
strings, so identities `foo` and `foo::fwd` would produce `foo::fwd` as the
former's `fwd` key and as the latter's own `floor` key — letting one identity
read an unrelated cursor and permanently skip its own older pending rows. The
length prefix delimits the identity portion unambiguously, so for a fixed role
the map identity → key is injective; the trailing role token then separates
`fwd` from `bulk`.

### 4.5 Cross-role disjointness

`floor` is the identity verbatim and therefore not length-prefixed, so its key
space is "any string" and §4.4's argument alone does not exclude a `floor` key
equal to some *other* identity's derived key — identity `3:foo:fwd` would
otherwise address the same row as identity `foo`'s `fwd` cursor.

**Normative rule.** A dispatch identity MUST NOT have the derived-key shape
`<len>:<identity>:<role>` with a canonical decimal `<len>` and `<role>` in
`{fwd, bulk}`, and MUST NOT be empty. `deriveScanCursorKey` rejects both with a
`TypeError` rather than accepting a key that could collide. With that rule the
guarantee is total: for accepted identities, two derived keys are equal only if
their (identity, role) pairs are equal, two floor keys only if their identities
are, and a floor key never equals a derived key.

Every scope this repository supports satisfies the rule by construction: an
ownership identity from §4.2 is a JSON array and always begins with `[`, while a
derived key always begins with a decimal digit — the two spaces are disjoint by
first byte, so the rejection path is unreachable from the CLI.

### 4.6 Configuration changes orphan the old key

Changing any component of the scope — repointing a session at a different
repository, switching Gitea instances, changing the session id — changes the
identity and therefore all three keys. This is **intentional orphaning**, not a
migration:

- The old rows are left in `outbox_scan_cursor` and are simply never looked up
  again. They are harmless.
- The new identity starts with no cursor, i.e. scanning restarts at row 1.

Reusing the old cursor would be a correctness bug: rows for the *new* target
sitting below the old cursor's position were confirmed foreign under the *old*
filter, and `id > afterId` would skip them permanently even though they match the
new one.

## 5. Reading the cursors at run start

```
floorAfterId  = get(floor)
zoneEndAfterId = get(fwd)  if it is > (floorAfterId ?? 0), else treated as unset
bulkAfterId    = get(bulk) if it is > (floorAfterId ?? 0), else treated as unset
```

**Stale invalidation.** A `fwd` or `bulk` value at or behind the floor carries no
information the floor does not already carry, so it is discarded rather than
migrated. This is how a `fwd` cursor that was deliberately left stale (§8.2) stops
being consulted once the floor overtakes it.

## 6. Scan budget

| Quantity | Value |
| --- | --- |
| `pageSize` | `max(limit, 200)` |
| `scanLimit` | `opts.scanLimit`, else `pageSize * 10` when an identity is set, else `Infinity` |
| `phaseBReserve` | `pageSize` |

**The default bound is only safe with a cursor.** Without an identity there is no
persisted progress, so every run would restart at row 1 and a delayed prefix
larger than the cap could hide every row behind it forever. Cursorless dispatch
therefore defaults to an unbounded scan (the pre-`scanLimit` behavior). An
explicit `opts.scanLimit` is always honored, cursor or not.

**Phase B keeps a reserve.** Phase A is capped at `scanLimit` exactly — that cap
is what bounds the zone's own size across runs. But an identity may legitimately
own a whole `scanLimit`-sized zone of simultaneously delayed rows, and
re-confirming them would then consume the entire budget. `phaseBReserve` is added
to the ceiling **only when Phase A actually consumed the whole `scanLimit`**, so
Phase B always gets at least one page beyond wherever Phase A stopped, and a run
with no zone in play never exceeds a caller-supplied `scanLimit`.

## 7. Scanning: two phases

### 7.1 Phase A — re-walk what is still owned

- `zoneEndAfterId` set (two or more rows were still open last run): walk
  `(floorAfterId, zoneEndAfterId]` in pages, bounded by `scanLimit` and by the
  dispatch `limit`.
- else `bulkAfterId` set (at most one row was still open): fetch exactly one row
  after `floorAfterId`. By the invariants of §9 nothing else can sit between
  them.
- else: no Phase A work.

The zone cursor advances **only through rows actually examined**. If the dispatch
`limit` fills mid-page, the remaining rows of that page stay unexamined and the
walk is recorded as incomplete (§8.2) — jumping the cursor to the fetched page's
last id would mark rows as scanned that were never looked at.

### 7.2 Phase B — bounded forward scan

Phase B resumes from the further of the zone edge Phase A re-confirmed this run
and the persisted `bulk` extent, so already-confirmed territory is never
re-fetched.

**Exception — incomplete zone walk.** If Phase A ran out of budget before
reaching `zoneEndAfterId`, `bulkAfterId` must **not** be used to resume, even
when it reaches further: it can have been recorded by an earlier run with a
larger `scanLimit` that walked past the whole zone in one pass. Jumping to it
would skip the zone's unvisited remainder, and since that remainder never enters
`matchedCandidates`, the cursor writes of §8 would then shrink the protected zone
to the scanned prefix and forget those rows permanently. Phase B instead resumes
from the zone cursor and continues the walk in order.

### 7.3 Classifying a scanned row

| Row | Effect |
| --- | --- |
| Filter rejects it (foreign) | Advances `scanExtentId` — the furthest id confirmed skippable this run. |
| Filter accepts it, due | Recorded as a matched candidate and queued for dispatch. |
| Filter accepts it, delayed | Recorded as a matched candidate, **not** dispatched. |

`listPendingEntries` deliberately does **not** filter by due-time in SQL. A
delayed owned row must still be *seen*, or the cursor would advance past a row
that becomes due later and strand it.

## 8. Advancement rules

Cursor writes happen once, after the dispatch loop, and only when an identity is
set. `stillOpen` is the ascending list of matched candidates that are delayed, or
due but not resolved.

### 8.1 `floor`

```
nextFloor = stillOpen.length > 0 ? stillOpen[0] - 1 : scanExtentId
persist when nextFloor > 0
```

- Never advances past the earliest still-open owned row.
- With nothing still open, it advances to the furthest confirmed-foreign extent.
- Monotonic non-decreasing: every scanned row has `id > floorAfterId`, and
  `scanExtentId` starts at `floorAfterId`.
- A computed `0` means "nothing confirmed yet"; the row is left unset rather than
  storing a redundant `0`, matching `afterId ?? 0` in the store.

### 8.2 `fwd` (zone end)

```
written only when stillOpen.length > 1 or the zone walk was incomplete
nextZoneEnd = zoneWalkIncomplete ? max(last stillOpen, previous zoneEndAfterId)
                                 : last stillOpen
persist when nextZoneEnd > 0
```

- **Inclusive, not exclusive.** Unlike the other two, `fwd` is compared against
  the walk's own cursor as an inclusive stopping threshold, so it stores the last
  still-open row's *own* id — one less would stop the walk just short of that row.
- **An incomplete walk may only grow the zone.** `stillOpen`'s last entry then
  reflects only what was examined, so the previous value is used as a floor.
  Otherwise the unexamined tail — rows never confirmed foreign or resolved —
  would lose protection.
- **At most one row still open leaves the value stale on purpose.** Phase A's
  single-row fetch covers that case without a zone walk, and the `floor`
  advancing past the stale value invalidates it (§5).

### 8.3 `bulk`

```
nextBulk = max(scanExtentId ?? 0, persisted bulk value ?? 0)
persist when nextBulk > 0
```

- Takes the furthest confirmed-foreign extent reached this run, **never gated by
  how many rows remain open**. This is what makes progress into a large foreign
  backlog accumulate across runs instead of being reset to just past the last
  protected row.
- **Monotonic non-decreasing**, guarded by the `max` against the raw persisted
  value, so a run whose Phase B never executed cannot regress it.

### 8.4 Maintenance lock

While a whole-file maintenance lock is held, no cursor is written:

- A run that starts locked returns `maintenanceLocked: true` before scanning, so
  no cursor is even read.
- A lock acquired mid-drain stops the loop; the cursor writes are skipped.
- A lock acquired after the last claim but before the writes is caught by the
  store's own in-transaction guard, which refuses the write and reports it; the
  dispatcher then skips the remaining cursor writes.

A refusal is non-destructive: the cursors keep the last complete run's values, so
the next unlocked run resumes from there.

## 9. Invariants

These are the properties every change must preserve. **I1** is the safety
property; the rest exist to support it.

- **I1 — No owned pending row is permanently skipped.** For every row an
  identity owns that is still pending after a run, some future run for that
  identity will scan it again.
- **I2 — The floor never crosses a still-open owned row.** `floor` is only
  advanced to `firstStillOpen - 1`, or to a confirmed-foreign extent when nothing
  is open.
- **I3 — Every still-open owned row is inside the protected zone.** After a run
  with two or more still-open rows, all of them lie in `(floor, zoneEnd]`, so
  Phase A revisits every one of them — not just the first and last.
- **I4 — A skipped region contains no owned pending row.** The span Phase B jumps
  over via `bulk` was scanned by an earlier run for the same identity and
  contained no still-open owned row at that time; a row's payload never changes,
  so it cannot become owned later. A filter change is a scope change, which
  changes the identity (§4.6).
- **I5 — `floor` and `bulk` are monotonic non-decreasing per identity**; `fwd` may
  shrink only to the last still-open row's id, and only after a complete walk.
- **I6 — A delayed row is protection, not progress.** It is always counted as
  still open regardless of the dispatch outcome of other rows.
- **I7 — An unexamined row is never treated as confirmed.** Cursors only advance
  through rows that were actually classified by §7.3.

## 10. Behavior in the required situations

### 10.1 Multiple delayed rows

Every delayed owned row is scanned, none is dispatched, and all of them are
still-open. `floor` stops before the earliest; `fwd` reaches the latest; the whole
span is re-walked next run. `bulk` still advances past any foreign rows found
beyond them, so a newer due row further along is reached even while the delayed
rows persist across many runs.

### 10.2 Retry

A failed dispatch leaves the row pending with a backoff-scheduled
`nextAttemptAt`. It is still-open, so it holds the floor exactly like a delayed
row. It leaves the still-open set only when it is sent, dead-lettered (retry
budget exhausted), or cancelled. A row whose claim was lost to a concurrent
dispatcher is re-read and counted as resolved **only** if it is confirmed sent or
dead-lettered — a live foreign claim leaves it open, so the cursor cannot advance
past a row that other dispatcher may yet reschedule.

That is the *dispatch-driven* retry. An **operator** retry (`admin outbox retry`)
of a row the cursors already passed is a separate case, covered by §13.

### 10.3 Foreign backlog

Foreign rows advance `scanExtentId` and nothing else. `bulk` accumulates that
extent across runs, so a backlog many times larger than `scanLimit` is crossed in
bounded steps — each run bounded, the sequence of runs monotone.

### 10.4 Scan and page limits change between runs

`limit`, `scanLimit` and the derived `pageSize` are per-invocation inputs and are
**not** persisted. Cursors are ids, so they stay meaningful under any budget
change:

- **Shrinking** the budget: a zone that no longer fits in one run is walked
  incompletely; §7.2's exception keeps Phase B from jumping past its remainder,
  and §8.2's `max` keeps the zone from shrinking to the examined prefix. Progress
  continues over successive runs.
- **Growing** the budget: strictly more rows are examined; every rule still
  applies unchanged.

A `bulk` value recorded under a larger budget is never used to skip a zone the
current run could not finish walking.

### 10.5 Ownership scope change

The identity changes, so all three cursors are new and unset (§4.6): the next run
scans from row 1 and any row for the new scope that sits below the old cursor is
reached. The old rows remain, orphaned and unread.

## 11. Compatibility and migration

**No migration is required, and none is performed.**

- The `floor` key is the dispatch identity verbatim — byte-identical to the key
  issue #606 persisted — so every pre-existing cursor row continues to resolve
  and keeps its meaning.
- `deriveOwnershipScanCursorKey` reproduces the `JSON.stringify` tuple the CLI
  built inline before issue #819, byte for byte.
- `fwd` and `bulk` rows that do not exist yet simply read as unset, which is the
  conservative direction: the run behaves as though no prior progress was
  confirmed beyond the floor.
- No schema change: `outbox_scan_cursor` is unchanged. The §13.5 fence lives in
  its own `outbox_scan_cursor_fence` table, created with `CREATE TABLE IF NOT
  EXISTS` like the cursor table before it; an existing database starts at
  generation 0, which is what "no retry has rewound this identity" means, so
  there is nothing to migrate there either.
- Orphaned rows from an earlier ownership scope are never read and are left in
  place; no cleanup step exists or is needed.

Out of scope for this contract: removing persisted cursors, creating a cursor row
that does not already exist (including during the §13 rewind), and any outbox
schema redesign.

## 12. Test matrix

Behavioral coverage lives in `test/outbox-scan-cursor-contract.test.js` and
`test/gh-dispatcher.test.js`; derivation coverage in
`test/outbox-scan-cursor-key.test.js`; retry-rewind coverage (§13) in
`test/outbox-retry-cursor-rewind.test.js` and `test/admin-outbox.test.js`; this
document's claims in `test/docs-outbox-scan-cursor-contract.test.js`.

| Case | Pins |
| --- | --- |
| Several simultaneously delayed owned rows, repeated runs | §10.1, I3, I6 |
| Delayed rows ahead of a foreign backlog larger than `scanLimit` | §10.1, §10.3 |
| Foreign backlog crossed over successive bounded runs | §10.3, I4 |
| `scanLimit`/`limit` reduced between runs over a large zone | §10.4, §7.2, §8.2 |
| `scanLimit`/`limit` raised between runs | §10.4 |
| Ownership scope repointed to another repository | §10.5, §4.6 |
| Identity pairs such as `foo` / `foo::fwd` | §4.4 |
| Identity spaces vs derived key spaces | §4.5 |
| Pre-#819 cursor row read by the current code | §11 |
| Dead-letter releases the floor | §10.2 |
| Operator retry of a row older than the cursors | §13, R1–R5 |
| Retry whose compare-and-set loses a race | §13.3, R4 |
| Retry when a cursor role has no persisted row | §13.2, R3 |
| Row held by a live foreign claim keeps the floor | §10.2 |
| Retry committing inside an in-flight drain's cursor window | §13.5, F1–F5 |
| Retry whose rewind moves nothing but still fences the drain | §13.5, F2 |

## 13. Operator retry rewinds the cursors (issue #820)

### 13.1 The stranding this prevents

Every rule above concerns a *dispatch* run, which only ever moves a cursor
forward. `admin outbox retry` is the one operation that moves a **row**
backward: it takes a dead-lettered, cancelled or delayed row and makes it
pending again.

If the identity's cursors have already advanced past that row — which is the
normal state, since a dead-lettered row is resolved and stops holding the floor
(§10.2) — updating only the row is not a recovery. The row is pending, and
`listPendingEntries` selects `id > afterId`, so no future scan for that identity
ever looks at it again. That is the **permanently stranded row** of §1, reached
through the recovery command instead of avoided by it.

So the retry rewinds the cursors it would otherwise strand the row behind.

### 13.2 The rule

Let `id` be the retried row and `scope` the dispatch identity resolved from the
retrying session's configuration (§4.2) — the same tuple, through the same
`deriveOwnershipScanCursorKey`, that `dispatch-outbox.ts` builds. Then, for each
of the three role keys of that identity (§4.4):

- **R1 — Rewind at or past.** A cursor row whose `after_id >= id` is set to `id -
  1`. `>=` and not `>`: the scan predicate is strict, so a cursor sitting exactly
  on the row already excludes it.
- **R2 — Never overshoot.** `id - 1` is the largest value that leaves the row
  visible; a cursor is never pulled back further than the recovery requires.
- **R3 — Absent stays absent.** A role with no persisted row is left with none.
  It already reads as "no confirmed progress" (§11), the conservative direction,
  and creating one would claim progress no run ever made. This is an `UPDATE`,
  never an upsert.
- **R4 — All or nothing.** The row update and every rewind commit in **one**
  SQLite transaction. A revived row with un-rewound cursors is precisely the
  stranded state this exists to prevent, so the two may not be separable — not
  by a crash, not by a concurrent writer.
- **R5 — Only a real recovery rewinds.** The rewind runs only after the retry's
  compare-and-swap (`OutboxStore.retryEntry`) has actually updated the row. A no-op
  (`already_sent`, `already_pending`, `not_found`), a lost race
  (`already_cancelled`, `concurrent_update`) and a maintenance refusal
  (`maintenance_locked`, §8.4) all leave every cursor byte-for-byte unchanged.

A cursor with no supplied scope is not rewound at all: the store only touches
cursors when the caller passes the identity key, so a direct `retryEntry(id)`
keeps its pre-#820 behavior exactly.

### 13.3 Why rewinding is safe

Rewinding runs the cursors backward, which §9's I5 calls monotonic for a
*dispatch* run. That invariant is about what a scan may conclude, and a rewind
concludes nothing: it only re-opens a span for examination.

- **I1 is strengthened, not weakened** — the whole point is that a row which
  would otherwise never be scanned again is scanned again.
- **I4 still holds.** The re-opened span was confirmed foreign or resolved by an
  earlier run; re-scanning it re-classifies those rows the same way and the
  cursors climb back over them. The only cost is bounded, one-off rescanning
  work, and the only new outcome is *finding* the revived row.
- **Fencing is untouched.** The retry's compare-and-swap still pins
  `nextAttemptAt` / `deadLetterAt` / `cancelledAt` to the values it read, and
  claim fencing on dispatch is unchanged. Idempotency is unchanged: retrying an
  already-pending row is still a no-op, and by R5 a no-op moves nothing.

### 13.4 What the operator sees

`admin outbox retry` without `--yes` stays non-mutating and additionally reports
whether a rewind is required, which **existing** cursor roles it would affect,
and the `after_id` they would be set to. With `--yes` it applies the row update
and the rewind together and reports the roles actually moved. The explicit
confirmation contract is unchanged.

### 13.5 Fencing a dispatch run that raced the retry

R4's transaction makes the row update and the rewind inseparable. It does **not**
make them survive a dispatch run that was already in flight, and that run is not
a hypothetical: a drain reads its three cursors at scan start (§5) and only
persists the extent computed from them at the very end (§8), with an unbounded
amount of external I/O in between.

Consider a retry of row `id` committing inside that window. The run scanned past
`id` while the row was still dead-lettered, so `listPendingEntries` never
returned it and the extent the run is about to write covers it. The write is an
unconditional upsert, and it lands *after* the rewind. The result is the
pre-retry cursor position restored, the recovered row stranded again — and this
time nothing is left to rewind it, because the recovery command already
completed and reported success. Every retry that overlaps a drain would fail
this way.

So cursor persistence is **fenced**, not merely ordered:

- **F1 — One generation per identity.** Each dispatch identity has a rewind
  generation, starting at 0 (`outbox_scan_cursor_fence`, keyed by the identity —
  the `floor` key). It is not a cursor: it is per identity, not per role, and it
  is an upsert, so R3 does not apply to it.
- **F2 — Every committed retry bumps it.** A retry that supplies a cursor scope
  and commits its compare-and-swap increments the generation *in the same
  transaction* as R4's writes — whether or not any cursor row actually moved. A
  cursor sitting below `id` needs no rewind, yet an in-flight run can still
  advance it past `id`, so bumping only on an actual rewind would leave exactly
  that case open. By R5, a no-op or lost retry bumps nothing.
- **F3 — Cursor writes carry the observed generation.** A dispatch run reads the
  generation at scan start, **before** it reads the cursors, and passes it with
  every cursor write. Reading it after the cursors would reopen the hole: the run
  would hold pre-rewind cursor values with a post-rewind generation.
- **F4 — A stale generation refuses the write.** The store compares generations
  inside the same transaction as the upsert (comparing outside it would only move
  the race) and writes nothing when they differ. The run then persists no further
  cursors and reports `cursorFenceStale`; rows it already dispatched are still
  dispatched and counted.
- **F5 — Refusal is non-destructive.** The rewound cursors stand, so the next run
  resumes from them, re-scans a bounded span it has already classified once, and
  finds the recovered row. Nothing is skipped — only work is repeated.

An unfenced `setScanCursor` call keeps its pre-#820 unconditional behavior, and a
store with no fence support (in-memory stores, test fakes) leaves its writes
unfenced; the fence is a property of the SQLite-backed store the operator
commands and the dispatcher share.
