# ChatOps comment cursor and complete scan window

Status: **approved design, implemented at the discovery layer**
(`src/core/chatops-comment-cursor.ts`). This document specifies exactly one
thing: how a session discovers the comments on one work item in a total
order, and how far a durable cursor over that order may advance. It does not
specify, and no implementation built against it may assume, an execution
ledger, claim/dispatch/ack behavior, database-restore semantics, or command
dispatch — those are separate, later contracts (§16).

This "implemented" status is component-level, not end-to-end: see
[feature-status.md](feature-status.md) for ChatOps's overall availability,
which stays `foundation-only` until comment ingestion, dispatch, and result
publication are connected.

Issue #696 / PR #776 attempted to specify the entire ChatOps surface in one
document and could not converge after ten review cycles. #777 extracted the
command grammar and trust boundary
(`docs/chatops-command-grammar-contract.md`); #780 extracted provider identity
and the state namespace (`docs/chatops-identity-contract.md`). This document
is issue #781, the next link: discovery and cursor progression only. It
supersedes the cursor/pagination portion of #778 and of #696 / PR #776.

The review of PR #776 found the concrete failure this document exists to
prevent: **a timestamp-only or incompletely paginated cursor can permanently
skip a valid command** — when two comments share a timestamp, or when a
command sits at the end of one page and the acknowledgement marker that
describes it sits on the next.

## 1. Why the cursor needs its own contract

A cursor says "everything up to here has been observed and durably
recorded." Two things make that claim hard to earn against an issue-comment
list, and both were review findings on PR #776:

- **Provider timestamps are not unique.** GitHub and Gitea both report
  comment timestamps at whole-second precision. Two comments posted in the
  same second — a human command and the automation's own marker, or two
  commands pasted back to back — carry identical `created_at` values. A
  cursor that stores only a timestamp and resumes from "strictly after" it
  skips the sibling; one that resumes from "at or after" it re-delivers the
  comment it already processed. Neither is acceptable, and no choice between
  them is correct, because the underlying order is not total.
- **A page boundary is not a scan boundary.** Reading one page and advancing
  is not the same as reading the list. A command can be the last comment on
  page 3 while the marker that acknowledges it is the first on page 4; a
  scan that stops at page 3 sees a command with no marker and one that stops
  at page 4 sees both. Advancing a cursor over a prefix therefore records
  "observed" for a region whose meaning was never fully read.

`docs/outbox-scan-cursor-contract.md` solves the analogous problem for
outbox dispatch and its structure is deliberately echoed here: a documented
ordering, explicit advancement rules, named invariants, and a fail-closed
posture whenever completeness cannot be proven. The differences come from
the source of truth: the outbox scans a local table with a monotonic integer
primary key, whereas this scans a remote, paginated, concurrently-mutated
list whose only ordering signal is a coarse timestamp.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| **Cursor scope** | One `(ChatOpsProviderIdentity, issueNumber)` pair — the key shape `docs/chatops-identity-contract.md` §6 defines. Every rule below is per-scope. |
| **Order key** | `(createdAtMs, commentId)` — the total order over one scope's comments (§3). |
| **Cursor** | The durable high-water mark: an order key, exclusive (§4). |
| **Scan** | One attempt to read every comment above the cursor. |
| **Scan window** | The comments one scan read. **Complete** when §5's conditions hold; otherwise incomplete and nothing advances. |
| **Frontier** | The largest order key a scan has accepted so far, used to detect unstable provider ordering (§7). |
| **First-seen record** | The durable, write-once copy of a comment's immutable fields, written the first time a scan observes it (§9). |
| **Candidate** | A comment in a complete window with no prior first-seen record — *newly discovered*, which is not the same as *not yet executed* (§10). |

## 3. Total ordering of comments

The order key for a comment is:

```
orderKey(comment) = (createdAtMs, commentId)
```

- `createdAtMs` is `comment.createdAt` parsed to epoch milliseconds. The
  value must be an ISO-8601 instant **with an explicit timezone designator**
  (`Z` or `±HH:MM`). A zone-less timestamp is rejected rather than read as
  local time: the same string would then order differently on two hosts, and
  ordering is the one thing this layer must get right. Both supported
  providers emit a zone (`Z` for GitHub, an offset for Gitea).
- **The calendar fields are range checked, not merely shape checked.** Month,
  day (leap years included), hour, minute, second, and offset must all name a
  value that exists. `Date.parse` *normalizes* an impossible date —
  `2026-02-30T00:00:00Z` becomes March 2 — so a shape-only check would turn a
  malformed provider value into a plausible instant and let a durable cursor
  advance to a position nothing ever reported. An out-of-range field is
  `malformed-timestamp` (§11), like any other unusable timestamp.
- `commentId` breaks ties, which is what makes the order **total**. It is
  compared **numerically**, via "shorter string is smaller, equal length
  compares lexically" — exact for canonical decimal strings with no leading
  zeros (`docs/chatops-command-grammar-contract.md` §7 standardizes that
  shape for both providers), and unlike `Number(id)` it stays exact past
  `Number.MAX_SAFE_INTEGER`. A plain lexical compare would order `"9"` after
  `"10"`; a float compare would eventually collapse two distinct ids onto one
  value, and a collapsed id is a skipped comment.
- A comment whose id or `createdAt` is malformed has **no** position in the
  order. It is never ordered "somewhere reasonable" — it fails the window
  (§11).

Comparison is `compareChatOpsCommentOrderKeys`; ids compare via
`compareChatOpsCommentIds`.

**Why `createdAt` and not `updatedAt`.** An edit changes `updatedAt`, so an
`updatedAt`-ordered cursor would see an old comment jump above the mark and
re-deliver it forever. `createdAt` is immutable for a given comment, which is
what a high-water mark needs. `updatedAt` still matters — it is half of
#777 §6's first-seen edit decision — but it is data, not order (§9).

## 4. The cursor

```ts
interface ChatOpsCommentCursor {
  createdAtMs: number;   // parsed instant of the last comment of the last complete window
  createdAt: string;     // that comment's createdAt, verbatim
  commentId: string;     // that comment's id — the tie-break half of the mark
}
```

- **Exclusive.** Every comment with `orderKey <= cursor` has been observed and
  durably recorded; everything strictly above has not. Because the order is
  total (§3), "the other comment posted in the same second" is unambiguously
  above or below the mark — never both, never neither. This is what satisfies
  the acceptance criterion that the cursor cannot permanently skip a valid
  command at a timestamp boundary.
- **One row per cursor scope**, keyed exactly as
  `docs/chatops-identity-contract.md` §6 defines. This document does not
  re-derive identity and adds no field to it.
- **Monotonic non-decreasing.** A complete window advances the cursor to its
  last new comment, or leaves it untouched when the window added nothing
  (§13, I3). Nothing in this contract moves a cursor backwards; an operator
  rewind, if one is ever wanted, is successor scope (§16).
- **`createdAt` is retained verbatim** next to the parsed instant because the
  provider's `since` filter takes a timestamp string, not an order key (§6),
  and re-formatting a stored instant would risk drifting from the spelling
  the provider itself uses.

### 4.1 The initialization sentinel

The durable row is a **state**, not just a position:

```ts
interface ChatOpsCursorState {
  initialized: boolean;                  // a complete window has been recorded for this scope
  cursor: ChatOpsCommentCursor | null;   // where it sits, null when nothing was ever observed
}
```

`initialized` exists because a position alone cannot express *"bootstrapped
over an issue that had no comments"*. Both halves must be persisted:

- **`initialized: false, cursor: null`** — the scope has never completed a
  scan (`CHATOPS_UNINITIALIZED_CURSOR_STATE`). The next scan bootstraps (§8).
- **`initialized: true, cursor: null`** — the bootstrap window was empty. The
  next scan is *not* a bootstrap: every comment it finds was posted after the
  surface was enabled and is a normal candidate.
- **`initialized: true, cursor: <position>`** — the ordinary case.

Collapsing the first two states would create a permanent skip, not a delayed
one: a `/grant` posted after an empty bootstrap and before the next poll would
be read as pre-existing backlog, recorded with `bootstrap: true`, and never
dispatched — with the cursor then above it, so no later scan reconsiders it.
That is precisely the failure §1 forbids, so the sentinel is mandatory rather
than an optimization.

Both `evaluateChatOpsScanWindow` (as `nextState`) and `planChatOpsBootstrap`
(as `state`) return the whole row to persist, with `initialized: true`
regardless of whether the position moved. `ChatOpsScanWindowInput.initialized`
carries it back in; it defaults to `cursor !== null`, so a caller that has a
position need not pass it, and a position with `initialized: false` is refused
as contradictory.

## 5. The complete scan window

A scan window is **complete** only when all of these hold:

1. At least one page was read.
2. Every page was fetched successfully. A single failed page fails the window
   (§11).
3. The final page reports **no further pages** — the scan reached the end of
   the comment list. No page before the last may report "no further pages".
4. No more than `CHATOPS_MAX_SCAN_PAGES` (200) pages were read (§5.2).
5. Every comment in every page has a well-formed id and timestamps (§3).
6. Each page's own comments are **strictly ascending** in order key.
7. Every previously unseen comment sorts **strictly above the frontier**
   (§7); overlap duplicates are permitted and dropped.

Only a complete window may advance the cursor, write first-seen records, or
produce candidates. An incomplete window advances nothing at all — that is
this document's fail-closed rule, and §11 is the failure taxonomy.

`evaluateChatOpsScanWindow` decides this, purely, from the pages a caller
supplies. Because it is pure, the same pages always yield the same decision:
a scan that crashed after fetching can be re-run and reach the same answer.

### 5.1 Why completeness must reach the end of the list

Condition 3 — *the scan runs to the end of the comment list*, not to a page
budget — is what makes a page boundary harmless. Any comment that existed
when the scan started is in the window, so a command on one page and its
acknowledgement marker on the next are always evaluated together. Dispatching
from a prefix would mean deciding about a command while the comment that
describes its fate is one unread page away.

`indexAuthenticatedChatOpsMarkers` makes that concrete: over a complete
window it reports which comment ids carry an **authenticated** marker
(`docs/chatops-command-grammar-contract.md` §7 — exact canonical body *and* an
author in `automationLogins`), and which comments are markers themselves. It
reports; it decides nothing. A look-alike marker from a non-automation author
is not indexed at all, so an untrusted comment still cannot suppress a
trusted command. What a downstream layer does with the index — suppress,
resume, re-ack — is execution-ledger scope (§16).

### 5.2 The page guard is a guard, not a budget

`CHATOPS_MAX_SCAN_PAGES` exists so a pathological list cannot spin a scan
forever. Exceeding it is an **explicit failure** (`page-budget-exhausted`,
not retryable), never partial progress: advancing over the prefix would
contradict §5.1, and silently stopping would be exactly the "skips a
command" failure this contract exists to prevent. Reaching it means an issue
has grown past roughly 20 000 comments at 100 per page and needs an operator
decision, not an automatic one. The outbox's `scanLimit`
(`docs/outbox-scan-cursor-contract.md` §6) can safely be a budget instead,
because its cursor advances only through rows actually classified and its
protected zone keeps the unscanned remainder reachable; a remote comment
list offers no equivalent protected zone, so the guard has to fail closed.

## 6. Pagination requirements and provider-port capabilities

The port that feeds `evaluateChatOpsScanWindow` must satisfy all of the
following. These are requirements on the adapter; wiring an adapter into a
runtime poller is out of scope (§16).

| Requirement | Why |
| --- | --- |
| **Ascending order by creation.** Pages are returned oldest-first, in the §3 order. | Descending pagination is unsafe: a comment posted mid-scan shifts every later element back by one, so page *n+1* re-delivers one element and the list end silently walks away. With ascending order, a concurrent post can only appear at the end — it is picked up by this scan or the next, never skipped (§14.3). |
| **Stable, canonical ids.** Every comment carries an immutable decimal id, no leading zeros. | §3's tie-break, §9's record key, and #777 §7's marker format all depend on it. |
| **Explicit end-of-list signal.** Each page states whether more pages exist (a link header, a `hasMore` flag, or a short final page the adapter converts into one). | §5 condition 3. "The page came back shorter than requested" is a legitimate source for that signal, but the adapter must derive it — the core never guesses from page length. |
| **Inclusive lower bound (optional).** A `since`-style filter, used as an optimization only. | §6.1. An adapter without one re-reads the list from the beginning; that is slower but equally correct, because the order-key comparison — not the filter — is what excludes already-seen comments. |
| **Verbatim `createdAt`/`updatedAt` in one spelling.** Both fields as the provider reported them, formatted identically. | #777 §6 decides "edited" by comparing the two strings. If an adapter normalized one field and not the other, an unedited comment would look edited and be rejected as `ambiguous-edit`. |
| **Page size is an adapter concern.** The core accepts any page size, including pages of differing size within one scan. | Nothing in §5 depends on page size; only page *sequence* matters. |

### 6.1 The `since` bound is deliberately loose

`chatOpsScanSinceBound(cursor)` returns the cursor's instant **minus one
second** (`CHATOPS_SCAN_SINCE_MARGIN_MS`), UTC-normalized to whole seconds —
or `null` when there is no cursor, which means "read from the beginning of
the list" (§8).

The margin is not defensive padding, it is correctness. GitHub documents
`since` as "only show results that were last updated **after** the given
time" and truncates timestamps to whole seconds, so requesting exactly the
cursor's instant may legitimately exclude a sibling comment created in that
same second — the precise skip §1 describes. Asking one second earlier
guarantees every comment at the cursor's timestamp is re-delivered; the
order-key comparison then drops the ones at or below the mark
(`droppedAtOrBelowCursor`). Over-fetching costs at most a few extra rows;
under-fetching loses a command permanently.

Two further notes on `since` semantics:

- GitHub filters on **`updated_at`**, not `created_at`. That is safe here in
  one direction only, which is the direction that matters: for any comment,
  `updated_at >= created_at`, so a comment created above the bound is always
  returned. The comments the filter hides are ones whose *last update* is
  below the bound, and those are necessarily below the cursor too.
- The filter is an optimization, never the completeness argument. §5's
  conditions are evaluated over whatever the pages actually contained. A
  provider that ignores `since` entirely and returns the full list yields the
  same result, just with a larger `droppedAtOrBelowCursor`.

**Pinned assumption.** That GitHub's per-issue comment listing returns
comments in ascending creation order, and that its `since` parameter is
`updated_at`-based and exclusive, are read from the provider's documentation,
not verified against a live endpoint by this issue. Both are stated here so a
later change in provider behavior is a documented contract violation rather
than a silent skip. An adapter that cannot honor the ascending-order
requirement must not be wired to this core; there is no descending-order mode.

## 7. Overlap, duplicates, and unstable ordering

Two pages may overlap — because the `since` bound is loose (§6.1), because
the provider re-paginates around a concurrent write, or because an adapter
retried a page. Overlap is expected and handled, not treated as an error:

- **A repeat of an id already accepted this window is dropped** (first
  occurrence wins) and counted in `droppedDuplicates`. It does not move the
  frontier and does not become a second candidate.
- **Content may differ between the two copies.** That is an edit landing
  mid-scan, and #777 §6 already resolves it: the first-seen copy is the one
  that counts. It never fails the window.
- **The ordering half may not differ.** If the same id comes back with a
  different `createdAt`, the key that positions the whole window is itself
  unstable; that is `identity-conflict`, not retryable (§11).
- **A previously unseen comment at or behind the frontier fails the window**
  (`unstable-ordering`, retryable). Under §6's ascending requirement this
  cannot happen; observing it means the provider's ordering is not stable,
  and a scan cannot prove a gap-free window over an unstable order. The
  alternative — accept the straggler and advance anyway — was rejected: the
  straggler that *was* returned is the visible half of the problem, and the
  same instability can hide one that was not. Failing closed costs a delayed
  dispatch; advancing costs a lost command.
- **A page whose own comments are not strictly ascending fails the window**
  (`page-out-of-order`, not retryable) — including a page that repeats an id
  within itself. A single response contradicting itself is a provider or
  adapter defect, and retrying it just burns quota.

## 8. Bootstrap

First use of a cursor scope — no persisted row — scans with no lower bound
and must therefore read the whole existing comment list. `planChatOpsBootstrap`
turns that first complete window into:

- **A cursor state** (§4.1) with `initialized: true` and a position at the
  newest comment — or a `null` position when the issue has no comments at
  all. The sentinel is written either way: an empty bootstrap is still a
  bootstrap, and the next scan must treat what it finds as new rather than as
  backlog.
- **A first-seen record for every existing comment**, each flagged
  `bootstrap: true` (§9).
- **An explicit list of skipped command attempts** — every pre-existing
  comment whose candidate line looks like a command
  (`looksLikeCommandAttempt`, #777 §10).

**No pre-existing comment is ever dispatched at bootstrap.** Executing
commands that predate the surface being enabled would run instructions nobody
re-issued, against a repository state they were never written for, and their
acknowledgement history belongs to a period this session never observed.

This is a *skip*, and the acceptance criterion is that it is not a **silent**
one: `skippedCommandAttempts` names each skipped comment (id, author,
timestamp), a caller must surface it, and the `bootstrap` flag on every
first-seen record keeps the fact durable and auditable long after the log
line scrolls away. An operator who wants one of those commands run re-issues
it as a new comment — which lands above the cursor and is dispatched
normally.

The two alternatives were rejected: starting the cursor at "now" without
recording anything hides which commands were passed over (a silent skip), and
dispatching the backlog replays arbitrarily old instructions.

**Bootstrap happens exactly once per scope**, and `initialized` (§4.1) is what
enforces that. An issue that was empty at bootstrap has no comment to anchor a
position to, so the sentinel is the only thing distinguishing it from a scope
that has never been scanned — without it, the first command posted after
ChatOps was enabled would be bootstrapped away as if it predated the surface.

## 9. Durable first-seen input

`docs/chatops-command-grammar-contract.md` §6 requires recognition to be a
function of a comment's **first-seen** fields, and §4 of that document
explicitly leaves "make that survive a restart" to this chain. This is that
mechanism.

```ts
interface ChatOpsFirstSeenRecord {
  commentId: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  body: string | null;   // null when over MAX_CHATOPS_COMMENT_BODY_CHARS
  bodyLength: number;
  bodySha256: string;
  bootstrap: boolean;
}
```

- **Write-once.** A record is inserted the first time a comment is observed
  and never updated. A later scan seeing a different body or `updatedAt` is
  an edit, which #777 §6 says to ignore — so the reconciliation result
  `edited-after-first-seen` is informational, never a write and never a
  failure.
- **`author`/`createdAt` drift is different.** Those are id-level facts. If a
  provider reports them differently for the same id, the record and the
  observation are not the same comment; `reconcileChatOpsFirstSeen` returns
  `identity-conflict` and the caller fails closed (§11).
- **Body storage is bounded.** A body over `MAX_CHATOPS_COMMENT_BODY_CHARS`
  (4000, #777 §10) is `malformed` regardless of its content, so storing it
  would grow the row without changing any decision it can ever feed; `body`
  is `null` and `bodyLength`/`bodySha256` still record what arrived. The hash
  is always present, so an edit is detectable even for a body that was not
  stored.
- **`bootstrap`** marks a comment that existed before the scope was
  bootstrapped (§8) — the durable half of "we deliberately did not run this".

## 10. Candidate deduplication at the scan boundary

`selectChatOpsCandidates(window, hasFirstSeen)` splits a complete window into
comments with no first-seen record (`candidates`) and ones already recorded
(`alreadyObserved`). Two independent mechanisms therefore keep a comment from
being re-offered: its order key sits at or below the cursor, and its
first-seen record exists. The second is what covers the deliberate overlap
the loose `since` bound creates (§6.1), and what makes a scan that crashed
between writing records and advancing the cursor harmless (§14.5).

**This is deduplication of discovery, not of execution.** "This comment has
been seen before" is not "this command has already run" — a record can exist
for a comment whose execution never started, is in flight, or failed. Whether
a candidate may execute, and exactly once, is the execution ledger's
question, and this document deliberately makes no claim about it (§16).
`ChatOpsCandidateSelection` says only *newly discovered*.

## 11. Failure, retry, and fail-closed behavior

Every way a scan can fail to prove completeness produces one
`ChatOpsScanWindowIncomplete` value with a reason, a detail string, and
whether re-running could plausibly help. **No incomplete result advances
anything**: no cursor write, no first-seen record, no candidate.

| Reason | Meaning | Retryable |
| --- | --- | --- |
| `page-fetch-failed` | The caller could not fetch a page (network, auth, rate limit). Constructed via `chatOpsScanFetchFailure`. | yes |
| `pages-truncated` | The last page still reports further pages — the list end was never reached. | yes |
| `no-pages` | No pages were supplied. A scan always reads at least one. | no (caller defect) |
| `trailing-page-after-end` | A page followed one that reported no further pages. | no (caller defect) |
| `page-budget-exhausted` | More pages than the §5.2 guard. | no (operator decision) |
| `malformed-comment-id` | An id was not a canonical decimal string. | no |
| `malformed-timestamp` | A `createdAt`/`updatedAt` was not a well-formed instant. | no |
| `page-out-of-order` | A page's own comments were not strictly ascending. | no |
| `unstable-ordering` | A previously unseen comment appeared at or behind the frontier (§7). | yes |
| `identity-conflict` | The same id came back with a different `createdAt` (§7), or a first-seen record's id-level fields drifted (§9). | no |

Retry is the caller's: a retryable failure means the next scan for that scope
re-runs from the unchanged cursor and can succeed. Retry must be bounded and
escalated rather than looped forever — a scope that cannot complete a scan is
not losing commands (the cursor never moved), but it is not executing them
either, and that is a human-visible condition. The escalation surface itself
(where the alert goes, how a stuck scope is reported) is operator-surface
scope, not defined here.

Nothing in this table is recoverable by advancing "as far as we got". A
partial advance is the one outcome the fail-closed rule exists to forbid.

## 12. Persistence requirements

This document defines no schema — the successor that adds `chatops_*` tables
does — but it fixes what that schema must satisfy, on top of
`docs/chatops-identity-contract.md` §7:

- **Two tables, both keyed by §6-of-#780 columns, not an opaque joined
  string.** The cursor table is keyed by
  `(session_id, provider, provider_endpoint, provider_owner, provider_repo,
  issue_number)`; the first-seen table adds `comment_id`. Note that this is
  the same column set #780 §6 calls the *ledger* scope — first-seen and
  execution are two different tables at the same grain, and this document
  defines only the first.
- **The cursor row stores both halves of §4.1's state.** The initialization
  sentinel is a column with its own truth value, not "a row exists": the row
  must be writable with a `null` position and still mean *bootstrapped*.
  Storing only the position would reintroduce the empty-bootstrap skip.
- **A complete window commits atomically.** The first-seen inserts and the
  cursor advance for one window are a single transaction. A crash therefore
  leaves the scope either entirely at the old cursor or entirely at the new
  one; there is no state where the cursor advanced over comments whose
  records were never written. (The reverse order — records written, cursor
  not advanced — is harmless even without atomicity, since §10 dedupes on the
  records; atomicity is required so the *unsafe* order cannot occur.)
- **First-seen rows are insert-only.** No code path updates one. An insert
  that collides with an existing row is a re-observation, resolved by §9's
  reconciliation, never an overwrite.
- **A field-set change orphans, never reinterprets.** Same rule as #780 §7
  and `docs/outbox-scan-cursor-contract.md` §4.1: rows under an older column
  set are a distinct, older scope.
- **The cursor is derived state, the records are not.** A cursor row can be
  rebuilt by re-scanning (it costs one full pass and a lot of dropped rows).
  First-seen records cannot — they capture a body that may since have been
  edited. A retention or backup policy that keeps one must keep the other;
  keeping only the cursor would silently convert "we saw this unedited" into
  "we never saw this".

## 13. Invariants

**I1 — No valid command is permanently skipped.** For every comment above the
cursor, some future complete scan for that scope observes it. Follows from:
the cursor only advances over comments in a complete window (§5), a complete
window reaches the end of the list (§5 condition 3), the lower bound is
inclusive of the cursor's whole timestamp second (§6.1), and bootstrap — the
one sanctioned skip — happens at most once per scope because the
initialization sentinel is durable (§4.1).

**I2 — The order is total.** Two distinct comments never compare equal, so
"at or below the cursor" is a strict partition of the scope's comments (§3).

**I3 — The cursor is monotonic non-decreasing.** It advances only to the last
comment of a complete window's new comments, and every such comment sorts
strictly above the old cursor. A window with nothing new leaves it unchanged.

**I4 — An incomplete window changes nothing.** No cursor write, no record, no
candidate, for any reason in §11.

**I5 — A comment yields a first-seen record at most once.** Records are
insert-only and a re-observation reconciles instead of writing (§9).

**I6 — Frontier acceptance is strictly increasing.** Every newly accepted
comment sorts strictly above every previously accepted one; overlap
duplicates are dropped rather than accepted twice (§7).

**I7 — A marker is in the same window as its command.** Any comment that
existed when a complete scan started is in that scan's window (§5.1), so a
page boundary never separates a command from an acknowledgement that
preceded the scan.

**I8 — Discovery makes no execution claim.** Nothing in this layer asserts
that a candidate has or has not run (§10).

## 14. Behavior in the required situations

### 14.1 Multiple comments with identical timestamps

Both carry the same `createdAtMs`; the id tie-break orders them (§3). A
cursor landing on the first leaves the second strictly above the mark, and
the next scan's `since` bound (one second earlier, §6.1) re-delivers both —
the first is dropped by the order comparison, the second is a candidate.
Neither is skipped and neither is offered twice.

### 14.2 Command at the end of one page, marker on the next

Both are in the window, because a window only counts as complete when it
reaches the end of the list (§5 condition 3, I7).
`indexAuthenticatedChatOpsMarkers` sees the marker regardless of which page
carried it. A scan that stopped at the command's page is `pages-truncated`
and advances nothing.

### 14.3 New comments arriving during pagination

Under §6's ascending order, a comment posted mid-scan can only appear at the
end of the list. Either it lands in a later page of this scan (it is a
candidate now) or it does not (the last page's end-of-list signal was
truthful at the time, the cursor stops below it, and the next scan picks it
up). Both outcomes are correct; neither loses it. What ascending order
forbids is the descending-pagination failure where a mid-scan insert shifts
an unread element across a page boundary.

### 14.4 Provider returning overlapping pages

Repeated ids are dropped as duplicates and counted (§7); the first copy wins
for content, per #777 §6's first-seen rule. Overlap alone never fails a
window. Only a *new* id behind the frontier, or a repeated id whose
`createdAt` changed, does.

### 14.5 Restart midway through a scan

Nothing partial was persisted, so the restarted process re-scans from the
unchanged cursor. It re-reads the same comments, re-derives the same window
(the evaluation is pure), and reaches the same answer. If the crash happened
after the commit, the cursor is already advanced and those comments are below
the mark; if before, they are candidates again — and any first-seen record
that did land makes §10 drop them from candidacy rather than re-offering
them.

### 14.6 Initial bootstrap after commands already exist

§8: every existing comment gets a first-seen record flagged `bootstrap`, the
cursor starts at the newest, and every pre-existing comment that looks like a
command attempt is reported in `skippedCommandAttempts`. Nothing from before
bootstrap is dispatched, and nothing is skipped silently.

The degenerate version of the same scenario — bootstrap on an issue with **no**
comments — is why §4.1 exists. The plan has no position to persist, so it
persists `initialized: true, cursor: null`. A `/grant` posted a second later is
then discovered by the next scan as a candidate above an empty cursor, not
recorded as backlog and skipped.

## 15. Test matrix

`test/chatops-comment-cursor.test.js` covers, at minimum:

| Area | Cases |
| --- | --- |
| Ordering (§3) | id tie-break at an identical timestamp; numeric id compare (`"9"` before `"10"`); ids past `Number.MAX_SAFE_INTEGER`; zone-less, unparseable, and calendar-invalid (`2026-02-30`, hour 24, offset `+25:00`) timestamps rejected; non-canonical ids rejected. |
| Cursor (§4, §4.1, §6.1) | `since` bound is one second below the cursor and second-precision; `null` for bootstrap; a cursor's own comment is dropped on the next scan; monotonicity when a window adds nothing; `nextState` is always `initialized`; a position with `initialized: false` is refused. |
| Completeness (§5) | truncated last page; a page after an end-of-list page; empty page list; page-budget guard; single-page window. |
| Pagination/overlap (§7) | overlapping pages deduped; edited body mid-scan keeps the first copy; changed `createdAt` is `identity-conflict`; new id behind the frontier is `unstable-ordering`; non-ascending page. |
| Bootstrap (§8) | all comments recorded with `bootstrap: true`; command attempts reported; nothing dispatched; an empty issue leaves the position `null` but the scope `initialized`, and a command posted after that empty bootstrap is a candidate, not backlog. |
| First-seen (§9) | over-long body stored as `null` + hash; write-once reconciliation for unchanged / edited / conflicting fields. |
| Candidates (§10) | already-recorded ids excluded; ordering preserved. |
| Markers (§5.1) | marker on a later page than its command; non-automation look-alike not indexed. |
| Fail-closed (§11) | every reason advances nothing; retryable classification. |

## 16. Explicit non-goals and forward pointers

This document defines discovery and cursor progression only. It does not
define, and nothing that implements it should assume:

- **The execution ledger** — claim, dispatch, acknowledge, and what survives a
  database restore. §10 is explicit that a candidate is not a "not yet
  executed" claim. The immediate successor issue (#782) owns this, in
  `docs/chatops-execution-ledger-contract.md`, which states the guarantee this
  chain can actually earn: at-most-once dispatch, not exactly-once.
- **Replay after a restore to an older snapshot** — a restored cursor legally
  points below comments already executed; resolving that needs the ledger,
  not the cursor (`docs/chatops-execution-ledger-contract.md` §12).
- **Polling** — when a scan runs, how often, and what triggers it.
- **Operation dispatch and trust tiers** — what a recognized command does.
- **Operator surfaces** — how a stuck scope (§11) is alerted or unstuck.

That work is tracked by the executable chain this issue's predecessors head:
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships). The immediate successor consumes `ChatOpsCommentCursor`,
`ChatOpsFirstSeenRecord`, and `ChatOpsCandidateSelection` exactly as defined
here rather than re-deriving them.
