# ChatOps result, acknowledgement, and dependency contract

Status: **approved design, not yet implemented** (issue #785). This document
is the authoritative contract for how a dispatched (or never-dispatched)
ChatOps comment ends up with a deterministic, bounded, sanitized outcome —
both the durable record an operator can rely on and the provider-visible
marker a requester sees. Follow-up implementation issues reference this
specification and MUST NOT redefine its policy; a change of policy is a
change to this document first.

See [feature-status.md](feature-status.md) for ChatOps's overall
availability, which stays `foundation-only` while this layer remains
unimplemented.

This is issue #785, split part 3 of superseded #779. It supersedes the
result/dependency portion of #779 and of #696 / PR #776. It is the successor
`docs/chatops-operation-mapping-contract.md` (#784) §12 names verbatim: "the
successor issue named in this issue's own dependency list ('result,
acknowledgement, and dependency contract')."

It does **not** specify, and no implementation built against it may assume:

- **Command grammar** — fixed by `docs/chatops-command-grammar-contract.md`
  (#777).
- **Comment discovery, the cursor, or the complete scan window** — fixed by
  `docs/chatops-comment-cursor-contract.md` (#781).
- **The execution-ledger state machine** — fixed by
  `docs/chatops-execution-ledger-contract.md` (#782). This document adds no
  row, no state, and no field to that table; §10 below is explicit about the
  one place it reuses an already-declared field (`ackPublication`) for a case
  #782 left unspecified, and why that is not a state-machine change.
- **Operation mapping and per-surface argument policy** — fixed by
  `docs/chatops-operation-mapping-contract.md` (#784).
- **Tool Request grant-policy tiers over typed operation ids** — #697, which
  this document hands a precise, checkable prerequisite (§12) rather than
  anticipating.

## 1. Terminology

| Term | Meaning |
| --- | --- |
| **Disposition** | The full internal picture of how one comment's handling ended: whether an operation ever dispatched (§4), the ledger state and, where applicable, marker outcome or handoff reason (`docs/chatops-execution-ledger-contract.md` §§5–7, §14) that produced it. |
| **Result kind** | One of §3's five closed values — the ChatOps-adapter-facing *presentation* of a disposition. Never a synonym for ledger state; §4 is the total, many-to-one mapping between them. |
| **Public outcome** | The bounded, sanitized projection (§7) of a disposition that is safe to render in a GitHub comment — a `ChatOpsPublicOutcome` value, never the disposition itself. |
| **Durable acknowledgement** | The disposition as recorded in the ledger row (`docs/chatops-execution-ledger-contract.md` §5) plus this document's result kind — always present, always operator-readable, independent of whether anything was ever posted to the provider. |
| **Provider-visible marker** | The canonical `<!-- chatops-ack:<id>:<outcome> -->`-shaped comment (`docs/chatops-command-grammar-contract.md` §7) — present for only three of §3's five kinds (§5). |
| **Undispatched reason** | One of the nine recognition, mapping, or pre-recognition refusal outcomes (§4.1) that end a comment's handling before any operation is ever invoked. |

## 2. Why a fifth layer, and why "ambiguous" is not "human-handoff"

Three typed vocabularies already exist and none of them is what a requester
or an operator actually reads:

- `OperationResult` (`docs/operation-dispatch-port-contract.md` §7) is a
  three-status, closed-reason union describing what **one operation
  invocation** returned. It says nothing about a comment that never reached
  an operation at all (#777's recognition refusals, #784's mapping
  refusals), and nothing about a row an operator had to intervene on.
- The ledger's `outcome` field (`docs/chatops-execution-ledger-contract.md`
  §5) is a three-value marker vocabulary (`executed`, `rejected`, `error`)
  fixed by #777 §7. It is populated as soon as a row reaches `awaiting_ack`
  — at T3 (`dispatching → awaiting_ack`, row 8), at row 16's retry-budget
  exhaustion, or at row 21's operator resolution — and carries forward
  unchanged through `acknowledged`; it is **not** limited to rows that
  reached `acknowledged`. It has no value for a `rejected` row (never
  dispatched, so it never reaches `awaiting_ack`) or for an `ambiguous` row
  that has not yet been operator-resolved.
- The ledger's `handoff.reason` field (#782 §14) is an eight-member closed
  set covering every reason a row can leave automation's hands. Read as a
  flat list it hides a real distinction that matters to whoever picks the
  row up: six of the eight reasons (`dispatch-crash-unresolved`,
  `reconcile-inconclusive`, `ledger-regression`, `restore-detected`,
  `witness-missing`, `conflicting-evidence`) share one open question — **did
  the operation run at all** — while the other two
  (`operator-escalation`, `ack-publication-abandoned`) do not: in both of
  those, the disposition is already known or explicitly deferred, and what
  is missing is only a human action to make it visible or move it forward.
  Presenting all eight under one banner would make an operator re-derive,
  from the reason string alone, whether reconciliation evidence is what they
  need to read next or whether the answer is already sitting in the row.

`ChatOpsResultKind` (§3) is the single vocabulary a requester and an operator
both read, defined as a **total function** (§4) over the union of all three
existing vocabularies plus the two recognition-layer contracts (#777 §4,
#784 §8) that produce a disposition before any operation ever runs. It adds
no new information; it groups existing, already-closed sets under the axis
that decides what an operator does next.

## 3. The ChatOps result kind

```ts
type ChatOpsResultKind =
  | "success"
  | "rejection"
  | "retryable-failure"
  | "ambiguous-execution"
  | "human-handoff";
```

- **`success`** — the operation ran and its outcome was `executed`.
- **`rejection`** — no automatic retry will ever occur, and the reason is
  about *the request*: either it never reached the operation port at all
  (recognition or mapping refused it before dispatch), or the port was
  invoked and returned a definitive refusal
  (`docs/operation-dispatch-port-contract.md` §7's `OperationRejectionReason`
  set, itself always effect-free — several of its members, `not-permitted`
  included, are returned by the port's own pre-handler validation, before
  any handler is ever invoked, so this proves a dispatch attempt began,
  never that a handler executed). Both are grouped under one
  requester-facing label — "your command did not, and will not, run" —
  while the underlying distinction #782 §6 requires (`rejected` asserts no
  dispatch was ever attempted; `acknowledged` with outcome `rejected`
  asserts one was attempted and the port declined) is preserved, not
  erased, by the `dispatched` field (§4.3).
- **`retryable-failure`** — the ledger reached outcome `error`: either the
  first attempt failed in a way judged not worth retrying (`internal`, row
  8), or the bounded automatic retry budget was exhausted (row 16,
  `docs/chatops-execution-ledger-contract.md` §13.1). "Retryable" names the
  **failure class** (operational, not a defect in the request), not a
  promise that another attempt is in flight — by the time this kind is
  presented, automation has already decided not to try again on its own;
  row 22's operator-authorized retry is how a human gets one.
- **`ambiguous-execution`** — the ledger is in `ambiguous` for one of the
  six execution-uncertain handoff reasons (§2) **and** the row's `attempts`
  is at least 1 — the row left `claimed` at least once before landing in
  `ambiguous`. Whether the operation ran is the open question, and only
  reconciliation evidence or an operator's row-21/row-22 decision resolves
  it.
- **`human-handoff`** — a human must act before the row's disposition is
  fully settled from the provider's side, because some piece of durable,
  provider-visible evidence a future automated reconciliation could rely on
  is missing and no automated path remains to produce it. Three sources, not
  two (§4.2): `acknowledged` via `ackPublication: "abandoned"` (§14's
  `ack-publication-abandoned`, row 19) — itself split by `attempts` exactly
  like the third source below, since row 19 is reachable from a zero-attempt
  row via row 21's resolution just as readily as from one that already
  dispatched (§4.2, §4.3); `ambiguous` via `operator-escalation` or
  `ack-publication-abandoned` (reached directly through row 7 or row 20 while
  already `dispatching` \| `awaiting_ack` \| `retry_scheduled`, not only
  through row 19) with `attempts >= 1`; and `ambiguous` with `attempts === 0`, whatever the
  handoff reason, from a row escalated (ledger row 7) or fenced (ledger row
  20) while still `claimed` — before any dispatch was ever attempted. That
  last case is not actually undecidable: no external effect is ever possible
  from `claimed` (`docs/chatops-execution-ledger-contract.md` §6), so the
  operation certainly never ran. It is `human-handoff`, not
  `ambiguous-execution`, because the row is only *procedurally* stuck in
  `ambiguous` — #782's transition table has no `claimed → rejected` path once
  a row is claimed — and an operator still has to move it out via rows 21/22.
  For two of the three sources — `operator-escalation`/`ack-publication-abandoned`
  cited directly and `attempts === 0` — the local disposition is already
  known or explicitly deferred, and,
  provided the row was never in `awaiting_ack`, "missing evidence" and
  "nothing reached the requester" coincide: no comment of any kind is
  scheduled, so the disposition is genuinely invisible until an operator
  acts. **`operator-escalation` or `ack-publication-abandoned` reached by
  escalating or fencing a row already in `awaiting_ack` is the one
  exception**: a summary was already
  committed, and possibly already delivered, before escalation, so §7.1
  schedules a bounded handoff correction comment in that same transition
  rather than leaving it uncorrected. **The `ackPublication: "abandoned"` source is
  narrower.** What is missing there is specifically the durable ack
  *marker* — the one comment reconciliation (#782 §10–§11) ever reads as
  evidence (§5.1) — not necessarily every comment: §5.1's summary comment is
  scheduled through Delivery's ordinary outbox retry independently of the
  marker's own retry budget and may still reach the requester even after the
  marker is abandoned. "A human must act before the requester's outcome is
  visible" is therefore precise for the other two sources and is, for this
  one, a statement about durable provider-visible *proof* of the outcome
  (needed so a future reconciliation pass never has to re-derive it), not a
  claim that the requester saw nothing.

These five are exhaustive over every terminal-for-automation disposition
this codebase's ChatOps surface can produce today (§4). A future contract
may add a sixth (§12 item 4 is explicit that this document reserves no slot
for one); until one is added, a value outside this set is not a well-formed
`ChatOpsResultKind`.

## 4. The total mapping

`chatOpsResultKind(disposition)` is total and pure over the closed inputs
below. It never inspects a comment body, a summary string, or anything not
already a member of one of the closed sets it reads from (#777 §4, #784 §8,
`docs/operation-dispatch-port-contract.md` §7, #782 §5–§7, §14).

### 4.1 Never dispatched

| Origin | Value | Kind | `dispatched` |
| --- | --- | --- | --- |
| Recognition (#777 §4) | `unauthorized-author` | `rejection` | `false` |
| Recognition (#777 §4) | `malformed` | `rejection` | `false` |
| Recognition (#777 §4) | `ambiguous-edit` | `rejection` | `false` |
| Recognition (#777 §4) | `unsupported-command` | `rejection` | `false` |
| Mapping (#784 §8) | `unsupported-operation` | `rejection` | `false` |
| Mapping (#784 §8) | `invalid-argument` | `rejection` | `false` |
| Pre-recognition (#781 §8–§9) | `bootstrap-backlog` | `rejection` | `false` |
| Pre-recognition (#777 §5 gate 1) | `chatops-disabled` | `rejection` | `false` |
| Pre-recognition (scan candidacy) | `marker-comment` | `rejection` | `false` |

**Mapping is resolved before T1, never after a claim.** `docs/chatops-execution-ledger-contract.md`
§7 rows 1 and 2 are the only two transitions T1 (§8) may apply to a fresh
candidate, and T1 applies exactly one of them, once, per comment: row 1
(`claim`) only when recognition (#777 §4) **and** mapping (#784 §8) have
both already succeeded; row 2 (`refuse`) otherwise. Mapping therefore never
runs after a row exists — a candidate is recognized and, only if
recognition succeeded, immediately mapped, and only the combined
recognition-and-mapping verdict is what T1 ever writes. This closes the gap
a later-checked mapping would otherwise open: #782's `claimed` row accepts
only rows 3, 4, 6, 7, and 20 (§7) — none of them `refuse` — so there is no
`claimed → rejected` transition a mapping failure discovered after row 1
could ever use. Because mapping is decided strictly before T1's row-1-vs-row-2
write, that case never arises: a comment whose mapping fails is never
`claimed` in the first place.

Every row above lands in ledger state `rejected` — `docs/chatops-execution-ledger-contract.md`
§7 row 2's `refuse` event fires for exactly four causes ("recognition
refusal, bootstrap backlog, ChatOps disabled, or a marker comment"), backed
by the ledger's own four-member `ChatOpsRefusalReason` type
(`"recognition-refused"`, `"bootstrap-backlog"`, `"chatops-disabled"`,
`"marker-comment"`, `src/core/chatops-execution-ledger.ts`), and this table's
nine values are exactly those four causes expanded to the outcome
granularity a requester or operator reads. Both mapping causes are recorded
on the ledger row itself under the literal value `"recognition-refused"` —
the same `ChatOpsRefusalReason` #777's four recognition refusals use —
because #782 defines no fifth refusal reason and this document adds none
(front matter): the ledger's own coarse `refuse` event never distinguishes a
mapping refusal from a recognition refusal, and this document does not ask
it to. The finer nine-member distinction this table draws — keeping
`unsupported-operation` and `invalid-argument` apart from each other and
from #777's four causes — is preserved durably by this document's own audit
record instead (§9.1's "closing each of those nine values in \[...] rather
than only the coarse cause `refuse` itself carries" already states this;
this paragraph fixes which single `ChatOpsRefusalReason` literal all six
non-`bootstrap-backlog`/`chatops-disabled`/`marker-comment` causes share on
the ledger row). All nine are `rejection`; #784 §8 already states
`unsupported-operation` and `invalid-argument` are indistinguishable in
detail from this layer's side, and this table does not attempt to
distinguish them further — the nine-member `ChatOpsUndispatchedReason` set
*is* the closed reason domain for an undispatched `rejection` (§7.2), and no
narrower grouping is defined.

The last three rows name causes #782 §7 row 2 groups under one `refuse`
event but that no other document assigns a reason code to, so this document
— already the total mapping over every ledger disposition (§4) — is what
closes them:

- **`bootstrap-backlog`** — a first-seen record carrying `bootstrap: true`
  (#781 §8–§9): the comment predates this scope's cursor ever being
  initialized, and #781 §8 is explicit that "no pre-existing comment is ever
  dispatched at bootstrap."
- **`chatops-disabled`** — gate 1 of #777 §5: `chatOps.enabled` is not true
  for the session, so recognition never runs for the comment at all.
- **`marker-comment`** — the system's own posted claim or ack comment (#777
  §7), excluded from candidacy before recognition runs so a marker can never
  be misread as a command and cause a marker to reply to a marker.

None of the nine reasons in this table — the last three included — ever
produces a marker or any other provider-visible reply (§5, §10.2): a
`rejected` row is terminal, with no external effect ever attempted, from
the same T1 write that creates it
(`docs/chatops-execution-ledger-contract.md` §6–§7 row 2), and this
document schedules nothing outside that constraint. `ackPublication` is
fixed to `"not-required"` for all nine at row creation (§10.3).

### 4.2 Dispatched

| Ledger disposition | Kind | `dispatched` |
| --- | --- | --- |
| `acknowledged`, `ackPublication: "published"`, outcome `executed`, `attempts >= 1` | `success` | `true` |
| `acknowledged`, `ackPublication: "published"`, outcome `executed`, `attempts === 0` | `success` | `false` |
| `acknowledged`, `ackPublication: "published"`, outcome `rejected`, `attempts >= 1` | `rejection` | `true` |
| `acknowledged`, `ackPublication: "published"`, outcome `rejected`, `attempts === 0` | `rejection` | `false` |
| `acknowledged`, `ackPublication: "published"`, outcome `error`, `attempts >= 1` | `retryable-failure` | `true` |
| `acknowledged`, `ackPublication: "published"`, outcome `error`, `attempts === 0` | `retryable-failure` | `false` |
| `acknowledged`, `ackPublication: "abandoned"` (any outcome), `attempts >= 1` | `human-handoff` | `true` |
| `acknowledged`, `ackPublication: "abandoned"` (any outcome), `attempts === 0` | `human-handoff` | `false` |
| `ambiguous`, handoff reason ∈ `{dispatch-crash-unresolved, reconcile-inconclusive, conflicting-evidence}` | `ambiguous-execution` | `true` |
| `ambiguous`, handoff reason ∈ `{ledger-regression, restore-detected, witness-missing}`, `attempts >= 1` | `ambiguous-execution` | `true` |
| `ambiguous`, handoff reason ∈ `{ledger-regression, restore-detected, witness-missing}`, `attempts === 0` | `human-handoff` | `false` |
| `ambiguous`, handoff reason ∈ `{operator-escalation, ack-publication-abandoned}`, `attempts >= 1` | `human-handoff` | `true` |
| `ambiguous`, handoff reason ∈ `{operator-escalation, ack-publication-abandoned}`, `attempts === 0` | `human-handoff` | `false` |

`dispatched` in §4.2 is read directly off `attempts >= 1`
(`docs/chatops-execution-ledger-contract.md` §5, §9.1) for every row above —
it is never implied by disposition alone. For `dispatch-crash-unresolved`,
`reconcile-inconclusive`, and `conflicting-evidence` that read is always
`true` and needs no runtime branching to explain, because those three
reasons are reachable only via ledger rows 9, 11, and 13, each of which
requires a prior `begin-dispatch` (row 6 or 15).

The four `acknowledged` dispositions — the three outcome rows and
`ackPublication: "abandoned"` — are **not** in that always-`true` category,
because #782 row 21 (`operator-resolve`) can apply to *any* `ambiguous` row,
including one whose `attempts` is still 0 because it reached `ambiguous`
straight from `claimed` via row 7 (`escalate`) or row 20 (`fence`) — before
any dispatch was ever attempted. This is the same `claimed`-then-`ambiguous`
path the next paragraph covers for the rows that *stay* `ambiguous` /
`human-handoff`; row 21 is what moves such a row on into `awaiting_ack`
instead. An operator resolving a zero-attempt row still picks one of
`executed | rejected | error` (#782 §13, row 21), and rows 17 or 19 then
carry that resolution into `acknowledged` exactly as they would for any
other row — #782's transition table draws no distinction on `attempts`.
Reporting `dispatched: true` unconditionally for every `acknowledged` row,
as an earlier draft of this table did, would therefore claim a port attempt
began (§4.3) for a row that, by construction, never had one.
`ackPublication: "abandoned"` inherits the same gap rather than closing it:
it is reached only from `awaiting_ack` (#782 row 19), but `awaiting_ack` is
itself reachable from a zero-attempt `ambiguous` row via row 21, so
reaching `awaiting_ack` is proof of a prior `dispatching` only for a row
sourced from row 8 or row 16 — never for one sourced from row 21.

A zero-attempt `acknowledged` row keeps the outcome-selected `kind` —
`success`, `rejection`, or `retryable-failure`, exactly as the operator's
chosen `outcome` selects for any other `acknowledged` row — rather than
becoming `human-handoff`. Unlike a zero-attempt `ambiguous` row (§3's third
`human-handoff` source), the disposition here is not undecided: an operator
has already recorded a definite verdict and rows 17–19 have already
published, or permanently failed to publish, a marker naming it.
`dispatched: false` records that the verdict did not originate from this
system's own dispatch pipeline, without changing what the verdict was. §7.2
closes the reason domain this adds to each of the affected kinds.

The remaining three execution-uncertain reasons — `ledger-regression`,
`restore-detected`, `witness-missing` — and the two already-known-disposition
reasons — `operator-escalation` (ledger row 7) and `ack-publication-abandoned`
(reachable here through row 7 or row 20 directly, in addition to its row-19
path, §9) — are different: rows 7 and 20 both explicitly list
`claimed` among the states they apply to
(`docs/chatops-execution-ledger-contract.md` §7), and both accept any member
of the eight-value `ChatOpsLedgerHandoffReason` set as `reason`/`handoff`
(§2) with no narrower restriction per transition, so a scope-level fence or
an explicit escalation can move a row that was **never dispatched** straight
to `ambiguous` citing any of these five reasons, `ack-publication-abandoned`
included. Mapping those five reasons to `dispatched: true`
unconditionally — as an earlier draft of this table did — would report an
operation as attempted when no write-ahead, and therefore no external
effect, was ever possible for that row. For these five reasons, `attempts`
must be read off the row: `attempts >= 1` still means "an attempt was made,
its result is undecidable" for the three execution-uncertain reasons
(`ambiguous-execution`, `dispatched: true`) or "the disposition is already
known but unpublished" for the two already-known-disposition reasons
(`human-handoff`, `dispatched: true`); `attempts === 0` means no dispatch
attempt — and therefore no port invocation — was ever made
(`human-handoff`, `dispatched: false`, §3).

### 4.3 What `dispatched` preserves

`dispatched: boolean` is not decorative. It is the field that keeps this
document from doing what #782 §6 explicitly forbids — merging `rejected`
and `acknowledged` into one concept. `dispatched` records whether a port
attempt began — whether `invokeOperation`
(`docs/operation-dispatch-port-contract.md` §5) was ever called for this
comment and the ledger recorded a `begin-dispatch` (T2) — **not** whether
an operation's own handler executed. `OperationRejectionReason`
(same document, §7) is itself "definite and effect-free": several of its
members, `not-permitted` included, are returned by the port's own
pre-handler validation, before any handler is invoked. So `dispatched: true`
on a `rejection` proves only that a dispatch attempt was made and the port
returned a result — never that a handler ran, and never that the underlying
operation had, or could have had, an effect. Two `rejection` results with
`dispatched: false` and `dispatched: true` are never interchangeable: the
former means no dispatch attempt was ever made; the latter means one was,
and the port declined (whether that happened at pre-handler validation or
inside the handler itself is not what this field answers — a consumer that
needs that distinction reads `OperationResult.data` or the operation's own
audit surface, never `dispatched`). An audit record (§9) always carries this field
regardless of what a public-facing comment (§7) spells out in prose.

For a `rejection` reached via a §4.1 undispatched reason or a dispatched
`OperationRejectionReason` (`docs/chatops-execution-ledger-contract.md` row
8), the closed reason code alone implies `dispatched`, no `attempts` read
needed: a mapping/recognition reason implies `false`, and an
`OperationRejectionReason` implies `true`. That shortcut does **not** extend
to the fixed `"operator-resolved"` literal (row 21, §7.1, §7.2): because row
21 can resolve either an `attempts >= 1` or an `attempts === 0` `ambiguous`
row (§4.2), `"operator-resolved"` occurs at both values of `dispatched` for
`rejection` and for `retryable-failure`, and `success`'s always-`null`
reason does too when the disposition was reached via row 21. For
`ambiguous-execution` and `human-handoff`, the reason code alone is likewise
**not** enough: `ledger-regression`, `restore-detected`, `witness-missing`,
`operator-escalation`, and `ack-publication-abandoned` each occur at both
values of `dispatched` (§4.2).
In every one of these cases — any kind whose disposition can be traced to
row 21, plus `ambiguous-execution`/`human-handoff` generally — a consumer
must read `attempts` directly rather than infer `dispatched` from `kind` or
`reason` alone.

## 5. Durable acknowledgement vs. provider-visible marker

These are two different durability tiers, deliberately not the same thing:

- **Durable acknowledgement** is the ledger row itself (#782 §5) plus the
  result kind this document derives from it (§4). It exists for **all five**
  kinds, the moment a disposition is reached, whether or not anything was
  ever posted to the provider. It is what makes every result kind
  deterministic (the first acceptance criterion) independent of provider
  availability.
- **Provider-visible marker** is the canonical `<!-- chatops-ack:<id>:<outcome> -->`
  body #777 §7 fixes, whose `outcome` is one of exactly three values
  (`executed`, `rejected`, `error`), **and nothing else in the same
  comment**: #777 §7 authenticates a marker only when its trimmed body is
  *exactly* one of the two canonical forms, not a body that merely contains
  one. The rendered `summary` (§7) is therefore never appended to, or
  embedded inside, the marker comment — doing so would make the comment's
  trimmed body no longer match the canonical form, so it would fail
  authentication and could never become evidence
  (`docs/chatops-execution-ledger-contract.md` §10.1). §5.1 fixes the
  two-comment layout this requires. Exactly one path produces the marker:
  - **Dispatched (§4.2).** `success`, `rejection` (the `acknowledged`
    rows of §4.2's table, not an undispatched §4.1 `rejection`), and
    `retryable-failure` — precisely the three kinds that correspond to a
    ledger row reaching `acknowledged` with `ackPublication: "published"`,
    whatever that row's `attempts` or `dispatched` value (§4.2).

  An undispatched `rejection` (§4.1) never produces this marker, or any
  other provider-visible reply, for any of its nine reasons: the `rejected`
  ledger row is terminal at T1 with no external effect ever attempted
  (`docs/chatops-execution-ledger-contract.md` §6–§7 row 2), and this
  document schedules no comment — marker or summary — outside that
  constraint (§10.2, §10.3). Where `docs/chatops-command-grammar-contract.md`
  (#777) §10's public-response table marks a recognition reason "Allowed,"
  that provision describes #777's own surface, not a comment this document
  constructs or delivers; realizing that table as a ChatOps-adapter-posted
  marker would be exactly the external effect #782 §6 says a `rejected` row
  never attempts, so this document does not do it.

### 5.1 Marker and summary are separate comments

For every kind that produces a marker — the dispatched path (§4.2, §5) is
the only one — publication is **two independent comments**, not one:

1. **The marker comment.** Trimmed body exactly `<!-- chatops-ack:<id>:<outcome> -->`
   (or `<!-- chatops-claimed:<id> -->` for the pre-operation claim, #777
   §7) — nothing else. This is the only comment
   `docs/chatops-execution-ledger-contract.md` rows 17–19 govern: its
   publication, retry, and eventual abandonment are exactly what
   `ackPublication` tracks, because it is the only comment reconciliation
   (#782 §10–§11) ever reads as evidence.
2. **The summary comment.** An ordinary, non-marker comment carrying the
   bounded, sanitized `ChatOpsPublicOutcome.summary` (§6, §7) and, where
   useful, the `reason` code in prose. Its trimmed body is never the
   canonical marker form, so it is never authenticated as a marker, never
   collected as evidence, and never gates or is gated by the marker's
   publication state. It is delivered through Delivery's existing outbox
   effect, carrying its own bounded exponential-backoff retry and permanent
   dead-letter exclusion (`OUTBOX_MAX_ATTEMPTS`, `docs/DOMAIN.md` §2.3),
   never a new ChatOps-specific counter. A duplicate or an undelivered
   summary comment has no correctness consequence beyond its own
   visibility: the durable acknowledgement (§5) and the audit record (§9)
   do not depend on it. §10.1 fixes how its content is made byte-identical
   across delivery retries.

   **The summary comment's body is never grammar-eligible, independent of
   who posts it or how a deployment configures its identity lists.**
   `docs/chatops-command-grammar-contract.md` §2–§3 recognizes a command
   only on a comment's first surviving non-blank line, and never searches
   past a first surviving line that fails to match (§3, and §9's `"context
   or explanation"` / `"/grant"` example is exactly this shape). This
   document therefore fixes the summary comment's leading line to the
   literal `CHATOPS_SUMMARY_HEADER = "ChatOps automated comment — not a
   command"` — never `OperationResult.summary`, `reason`, or any other
   operator- or agent-authored text — followed by a blank line and then
   `summary` (and, where present, `reason` in prose). This literal is
   chosen, and pinned here by exact value rather than left to an
   implementation to select, because its grammar-ineligibility is
   structural, not incidental: §2's grammar requires a candidate line to
   begin with `/` (`command := "/" verb ...`), and `CHATOPS_SUMMARY_HEADER`
   does not, so no choice of `supportedVerbs` (#780 §2), no future verb
   addition, and no coincidental resemblance to a command can ever make it
   match — a header chosen only informally (for example a summary
   introduced by a header that itself happens to start with `/`, such as
   `/grant`) would not carry this guarantee and would recreate exactly the
   recursive-execution risk this section exists to close. `OperationResult.summary`
   (`docs/operation-dispatch-port-contract.md`
   §7) is untrusted prose with no restriction against beginning with a
   `/`-prefixed token, so without a fixed, non-`/`-prefixed leading line a
   rendered summary could itself be misread as a new command. Because the
   candidate line is always `CHATOPS_SUMMARY_HEADER`, never `summary`
   itself, the summary comment can never match #777 §2's grammar, so it can
   never be recognized as a `command` outcome (#777 §4) — regardless of the
   posting account's identity. §7.1 pins the analogous literal,
   `CHATOPS_HANDOFF_CORRECTION_HEADER`, for the handoff correction comment,
   for the identical reason. This is deliberately independent of, and does not substitute
   for, the requirement that `chatOps.authorAllowlist` and
   `chatOps.automationLogins` stay disjoint
   (`docs/chatops-execution-ledger-contract.md` §10.3): even a deployment
   that violated that requirement, so that the account posting the summary
   is also allowlisted to issue commands, gets no recursive-execution path
   from this comment, because recognition never reaches a candidate line
   `summary` could have supplied. Both layers hold simultaneously; neither
   is optional because the other exists.

Order between the two is not defined and does not matter: the marker is
what makes a row terminal-with-evidence (#782 §6), and the summary is
purely informational. An implementation may post either first, or
concurrently.

`ambiguous-execution` and `human-handoff` **never get an ack marker at the
moment they are reached.** #782 §6 is exact about why: "every `acknowledged`
row has settled its marker" and no row may go terminal owing one it cannot
publish. An `ambiguous` row is not `acknowledged` at all, and an
`acknowledged`-via-`"abandoned"` row is terminal *because* its marker could
not be published (#782 §11.4) — posting one anyway would misreport a
decision nobody made.

`human-handoff`'s sources all route to an operator through the ledger
row's own `handoff` field, not just through this document's audit record:

- **`ambiguous` via `operator-escalation` or `ack-publication-abandoned`**
  surfaces through the ledger's own `handoff` structure (#782 §13.3) and the
  parked task state (`ready_for_human`) that routing already uses for
  undecidable work. Row 7 (`escalate`) and row 20 (`fence`) both accept any
  member of the closed `ChatOpsLedgerHandoffReason` set as `reason`, so a
  scope-level fence or an explicit escalation can cite
  `ack-publication-abandoned` directly on a row that never reached
  `awaiting_ack` — a second, narrower route to this same reason string,
  distinct from the `acknowledged`-terminal route the next bullet describes
  (§4.2).
- **`acknowledged` via `ackPublication: "abandoned"`** *also* carries a
  populated `handoff` field. #782 §7 row 19's implementation
  (`src/core/chatops-execution-ledger.ts`) sets
  `handoff: { reason: "ack-publication-abandoned", detail, fenceScope: false }`
  in the same transition that reaches `acknowledged` — a behavior
  `test/chatops-execution-ledger.test.js` itself pins. This is inconsistent with #782 §5's
  row-schema comment, which describes `handoff` as set "exactly when state
  is `ambiguous`"; this document defers to what row 19's transition actually
  does, not to that comment, and does not declare the field absent here on
  the strength of it. This document's own `chatops.outcome.human-handoff`
  audit record (§9) is **additive**, not the sole routing signal:
  `kind: "human-handoff"`, `reason: "ack-publication-abandoned"`, and the
  record's `ledgerScope` give an operator-facing consumer a second way to
  find and act on the row, alongside the row's own `handoff` field — the
  same "additive to, not a replacement for" relationship §9 already states
  for the ledger's `chatops.ledger.<transition>` events generally.

Neither channel posts a new provider comment at the moment the disposition
is reached, with one exception: any handoff reason (`operator-escalation`
and `ack-publication-abandoned` cited directly included) reached by
escalating (row 7) or fencing (row 20) a row that had already reached
`awaiting_ack` — via row 8, row 16, or row 21, whichever transition put it
there — schedules a bounded handoff correction comment in
that same transition, because that row's earlier summary was already
committed, and
possibly already delivered, reporting an outcome this transition now
supersedes (§7.1). Escalating or fencing a row that never reached
`awaiting_ack` posts nothing new, exactly as before. That does not mean the
requester necessarily sees nothing for `ackPublication: "abandoned"`: §7.1
and §10.1 already scheduled that row's
summary comment, atomically with the disposition-producing transition —
T3 (row 8) when the row reached `awaiting_ack` that way, or row 16's or
row 21's own transition when it did not — independently of the marker's
own retry budget, so by the time abandonment is reached the summary may
already be delivered, still retrying, or (after `OUTBOX_MAX_ATTEMPTS`)
itself dead-lettered — none of which this document ties to the marker's
fate. What abandonment guarantees
is narrower and durable: no ack marker will ever exist for this row, so
reconciliation (#782 §10–§11) can never treat it as evidenced — the row's own
`handoff` field and the `chatops.outcome.human-handoff` audit record (§9) are
what an operator reads instead. Their recovery paths are not symmetric, and
this document does not treat them as if they were:

- **An `ambiguous` row has a defined recovery, whatever its handoff
  reason** — `operator-escalation`, `ack-publication-abandoned` cited
  directly via row 7/20 (§4.2), or any other member of the closed set.
  #782 row 21 (`operator-resolve`) moves the row from `ambiguous` to
  `awaiting_ack` with `ackPublication: "pending"`; rows 17–19 then take it
  terminal exactly like any other outcome, posting a normal marker (and,
  per §5.1, a normal summary comment) using the same composition (§7) as
  any other publishable kind. It does not need a sixth marker outcome
  value, because by the time an operator has resolved it, the disposition
  is one of the three publishable kinds again.
- **`ack-publication-abandoned` reached via row 19 has no defined
  recovery.** That row is already `acknowledged` — fully terminal — and
  `docs/chatops-execution-ledger-contract.md` row 23 refuses every event a
  terminal row receives, with no operator-authorized exception comparable
  to rows 21/22 for an `ambiguous` row. This document does not promise a
  "fresh publication attempt": doing so would require a new legal
  transition out of `acknowledged` that #782 does not define, and defining
  one is a change to that document's state machine — explicitly out of
  this document's scope (front matter). Until #782 is revised to add such a
  transition, `ack-publication-abandoned` is a durable dead end for
  automated republication. This is not a gap in the acceptance criteria:
  the durable acknowledgement (§5) and the `chatops.outcome.human-handoff`
  audit record (§9) already give an operator everything needed to act on
  the row directly, including posting a marker manually through whatever
  means they use to interact with the provider — a manually posted marker
  is authenticated, or not, by #777 §7 exactly like any other comment from
  an automation login, and this document neither specifies nor needs a
  ChatOps-owned path for it. "Acknowledgement retries do not invent
  execution success" is satisfied here by refusing to promise a retry path
  that does not exist, not by defining one.

Undispatched `rejection` (§4.1) is a third case: it never enters
`awaiting_ack` at all (#782's `rejected` state has no external-effect step),
so it never gets a marker-shaped reply, or any other provider-visible
reply, at all (§10.2) — `ackPublication` only records the fixed
`"not-required"` value on the row (§10.3); it does not drive delivery,
because there is nothing this document schedules for delivery from that
state.

## 6. Visibility and redaction

Nothing in this section is new policy. It is the existing visibility
pipeline (`src/core/outbox-visibility.ts`, `src/core/text-sanitize.ts`),
applied to the one text surface ChatOps introduces: the acknowledgement
comment.

- **Surface tier.** An acknowledgement is a `work-item` (Tier 1) comment
  (`docs/gitea-private-work-items.md` "Surfaces and Visibility Tiers";
  `outbox-visibility.ts`'s header comment) — the same tier every other
  phase-outcome comment on the issue already uses. It may carry bounded,
  sanitized internal workflow feedback; it may never carry a raw prompt, a
  full agent transcript, or unsanitized command output, exactly as that tier
  already forbids for every other producer.
- **Pipeline.** Every string that reaches a public outcome's `summary`
  field (§7) passes through, in order: `sanitizeBody` (absolute local paths
  → `<path>`, `src/core/text-sanitize.ts`), `redactTokens` and
  `redactApiKeys` (credential shapes), `neutralizeClosingKeywords` (so a
  reason string echoing a `#`-numbered reference can never auto-close an
  issue or PR), `escapeRawHtml` (an operation's `summary` is operator text,
  not agent-authored Markdown, but it is posted to the same issue thread as
  the HTML-comment-shaped marker (§5.1) — even though the two are separate
  comments, raw `<`/`<!--` from any upstream source is neutralized the same
  way #834 already requires for agent-authored prose, so a summary can
  never itself be misread as marker-shaped content), and finally
  `enforceCommentVisibility`'s bound
  (`DEFAULT_COMMENT_MAX_CHARS`, or `OPERATION_SUMMARY_MAX_CHARS` (500,
  `docs/operation-dispatch-port-contract.md` §12) when the source is already
  an `OperationResult.summary` and is therefore bounded twice for defense in
  depth). `sanitizeBody`'s built-in heuristics only match a fixed set of
  path prefixes (home directories, `/tmp`, `/var`, …); a deployment whose
  `session.repoRoot` or `session.artifactRoot` lives under a non-standard
  top-level directory (for example `/projects/...`) is invisible to those
  heuristics. Every call in this pipeline — both the `sanitizeBody` step
  and, when the summary also passes through `enforceCommentVisibility`
  directly, that call's `configuredPaths` option — MUST therefore be given
  `sessionRedactionPaths(session)` (`src/core/outbox-effects.ts`), the same
  helper every other ChatOps-adjacent comment path (`admin.ts`,
  `outbox-effects.ts`, `research-publication.ts`) already uses to extend the
  built-in matcher with the session's actual configured roots. A render call
  that omits it is a contract violation, not a permissible default.
- **What can never appear**, restated because the issue names them
  explicitly and a reviewer should not have to infer it from the pipeline
  alone: a local filesystem path (`session.repoRoot`, `session.artifactRoot`,
  or any path under them), a credential or token of any shape §6's redactors
  recognize, a raw command's stdout/stderr, or a raw diff/artifact excerpt.
  `OperationResult.data` (`docs/operation-dispatch-port-contract.md` §7) is
  **never** included in a public outcome's `summary` — it is structured data
  for an adapter to render *however its surface renders things*, and this
  adapter's surface is a bounded prose comment, not a data dump. A future
  ChatOps surface that wants to expose part of `data` must pass that part
  through this same pipeline explicitly; nothing here does it implicitly.
- **`invalid-argument`'s `detail` is not exempt.** #784 §8 flags this
  document as the place that decides how `detail` may be published, noting
  only that it "should still be treated as untrusted formatting input, not
  user-facing prose to trust verbatim." The answer: `detail` is eligible for
  the public `summary` (§7) but is never treated as pre-sanitized, however
  disciplined #784's own construction of it is — it passes through the
  identical pipeline as an `OperationResult.summary`, as defense in depth,
  not because #784 is expected to fail its own contract.

## 7. The public outcome

```ts
interface ChatOpsPublicOutcome {
  kind: ChatOpsResultKind;      // §3
  dispatched: boolean;          // §4.3
  reason: string | null;        // §7.2, closed per kind; null only for "success"
  summary: string;              // bounded, sanitized (§6); never a comment echo
}
```

### 7.1 Composition

`summary` is built from exactly one of four sources, never more than one:

- **Has an `OperationResult` (§4.2).** `OperationResult.summary`
  (`docs/operation-dispatch-port-contract.md` §7), already bounded at 500
  characters and, per that document's §12, "operator-facing text about the
  operation, never a comment body, never a credential, never a diff" —
  passed through §6's pipeline regardless. This is the source for `success`,
  `rejection` with `dispatched: true`, and `retryable-failure` when the
  disposition was reached via `docs/chatops-execution-ledger-contract.md`
  row 8 (`dispatch-result(outcome)` — "the operation returned a definite
  result"), and for `human-handoff` via `ackPublication: "abandoned"` when
  *that* row was likewise reached via row 8 (`attempts >= 1`, an
  `OperationResult` already returned before publication failed at row 19).
  **This source never applies to a disposition reached via row 16 or row 21
  (below) — neither transition ever produces an `OperationResult` — and
  therefore never to a zero-attempt `acknowledged` row (§4.2), which is
  reachable only via row 21.** It also applies to `ambiguous-execution` and
  `human-handoff` via `operator-escalation` or a fence reason when that
  row's `ambiguous` disposition was reached by escalating (row 7) or
  fencing (row 20) a row that had already reached `awaiting_ack` via row 8
  — the next bullet's carve-out defines this precisely.
- **Undispatched (§4.1).** A fixed, per-reason template naming only the
  reason and, where #784 §8 supplies one, its sanitized `detail` — never a
  substring of the comment body itself. Recognition refusals (`malformed`,
  `ambiguous-edit`, `unsupported-command`) carry no free-form detail at all
  (#777 §4 defines no such field); their `summary` is the fixed template
  alone. This source also covers `human-handoff` at `dispatched: false` for
  the five reasons that never left `ambiguous` at all —
  `operator-escalation`, `ledger-regression`, `restore-detected`,
  `witness-missing`, and `ack-publication-abandoned` cited directly on a
  still-`claimed` row (row 7 or row 20, §4.2) — each only at
  `attempts === 0` (§4.2) — no operation was
  ever called for those, so the same per-reason template applies, keyed off
  the reason already in §7.2's domain for that `(kind, dispatched)` pair.
  **It does not cover a zero-attempt `human-handoff` reached via
  `ackPublication: "abandoned"`** — that row passed through `awaiting_ack`
  via row 21, so its summary comes from the ledger-synthesized source below,
  not this one.
- **Dispatched, no `OperationResult` ever produced (§4.2).** A fixed,
  sanitized handoff template naming only the disposition's closed `reason`
  code (§7.2) — never operator or agent-authored prose, because none
  exists. This is the source for `ambiguous-execution` and for
  `human-handoff` via `operator-escalation` or `ack-publication-abandoned`
  at `attempts >= 1` **only when
  the row reached `ambiguous` without ever passing through `awaiting_ack`**
  — escalated (row 7) or fenced (row 20) directly from `claimed`,
  `dispatching` before row 8 ever ran, or `retry_scheduled`. In that case a
  dispatch attempt began (§4.3) but the ledger never received, or cannot
  yet trust, a completed `OperationResult` — that is exactly the open
  question §3 and §4.2 describe, so there is nothing an
  `OperationResult.summary` could supply. The template is fixed per reason
  the same way the undispatched template is fixed per reason (§7.2 already
  closes the domain both draw from), and passes through §6's pipeline like
  every other `summary`.

  **Escalated or fenced out of `awaiting_ack` is a different case, and this
  bullet's template does not apply to it.** Row 7 (`escalate`) and row 20
  (`fence`) both list `awaiting_ack` among their source states
  (`docs/chatops-execution-ledger-contract.md` §7 rows 7, 20), so a row
  that already reached `awaiting_ack` — via row 8, row 16, or row 21,
  whichever transition put it there — and therefore already has an
  already-enqueued, durable summary from that transition (§10.1's T3
  guarantee for row 8; the same guarantee extended to row 16's and row
  21's own transitions, per the ledger-synthesized bullet below), can
  still be moved to `ambiguous` afterward. That already-committed summary
  is **preserved unchanged, not replaced**: the disposition's `summary`
  source stays whichever one originally produced it — the previous
  bullet's `OperationResult.summary` for a row-8 origin, or the fixed
  ledger-synthesized sentence below for a row-16 or row-21 origin —
  exactly as it would be had the row never been escalated or fenced, and
  this document schedules no second, handoff-template summary for it.
  Only the presented `kind`
  changes, per §4.2's mapping — `dispatched: true` either way (§4.3) — and
  `reason` still reports the handoff cause (`operator-escalation`,
  `ledger-regression`, `restore-detected`, `witness-missing`, or
  `ack-publication-abandoned`, per §7.2)
  regardless of which bullet supplied `summary`; the two fields are sourced
  independently and neither implies the other. Without this rule an
  implementation could enqueue a second, handoff-template summary alongside
  the one already durable from that origin transition, producing a
  stale-or-duplicate comment
  and violating the single-source guarantee §10.1 states for every other
  row.

  Leaving that origin-sourced `summary` as the only thing the requester ever
  sees would understate what changed: it was rendered, and possibly already
  delivered, while the row still read `success`, `rejection`, or
  `retryable-failure`, and row 7/20 has since moved it to `ambiguous`
  without republishing anything. This document therefore schedules one
  additional, bounded **handoff correction comment** — distinct from, and
  never a replacement for, the preserved `summary` — in the same
  transaction as the row 7/20 write, regardless of whether that
  `awaiting_ack` row originated at row 8, row 16, or row 21. Its text is a fixed, per-reason
  template drawn from the same closed domain §7.2 already fixes for the
  handoff cause (`operator-escalation`, `ledger-regression`,
  `restore-detected`, `witness-missing`, or `ack-publication-abandoned`) — never operator- or
  agent-authored prose. Exactly like the summary comment (§5.1), its
  leading line is not the per-reason template itself but a fixed literal
  pinned here — `CHATOPS_HANDOFF_CORRECTION_HEADER = "ChatOps automated
  correction — not a command"` — for the identical structural reason: §2's
  grammar requires a candidate line to begin with `/`, this literal does
  not, and pinning its exact value (rather than leaving "a fixed header" to
  an implementation's choice) is what makes the guarantee checkable instead
  of merely asserted. The per-reason sentence follows a blank line after
  this header, the same two-part layout §5.1 fixes for the summary. It
  passes through §6's pipeline exactly like
  any other public text. It is delivered the same way the summary is: an
  ordinary Delivery outbox effect (§5.1), rendered once and enqueued
  atomically with the escalate/fence transition so a restart replays the
  identical text, retried and eventually dead-lettered under the existing
  `OUTBOX_MAX_ATTEMPTS` policy, never a new counter, and gating nothing —
  §5.1's "no correctness consequence beyond its own visibility" applies to
  it exactly as to the summary. This scheduling is scoped to this one
  transition only: escalating or fencing a row still `claimed`,
  `dispatching` before row 8 ever ran, or `retry_scheduled` schedules no
  comment of any kind (§3) — there, unlike here, nothing was ever reported
  that could go stale.
- **Ledger-synthesized, no `OperationResult` ever produced (rows 10, 16, and
  21).** Three ledger transitions commit a publishable outcome without an
  operation ever returning a result to this process, and without anything
  else durable enough to render a per-reason summary from. All three are
  fixed, once, by this document, exactly like the undispatched and handoff
  templates above — never recomputed, never sourced from `OperationResult`:
  - **Row 10 (`docs/chatops-execution-ledger-contract.md` §7 row 10, §17.2)
    — reconciliation found both the claim and ack markers already on the
    provider.** Reachable only from `dispatching`, which itself requires a
    prior `begin-dispatch` (row 6 or 15), so `dispatched` is always `true`
    for a row-10 disposition — unlike the five `ambiguous`-sourced handoff
    reasons (§4.2) whose `dispatched` is read off `attempts`, row 10's is
    never read off `attempts`, because row 10 has no
    zero-attempt path. The transition adopts the marker's already-published,
    three-valued `outcome` directly, selecting `success`, `rejection`, or
    `retryable-failure` exactly as any other `acknowledged` row does (§4.2),
    and lands in `acknowledged` with `ackPublication: "published"` set
    directly by the reconciliation write itself, never via rows 17–19: the
    marker already exists on the provider, so this document schedules no new
    marker post for a row-10 disposition (§5.1). The **summary** is
    different: no prior transaction ever enqueued one for this row, because
    row 10 is reached without row 8 (T3) ever running, so nothing durable
    exists yet to publish. `summary` is therefore one fixed sentence, keyed
    only on the adopted `outcome` and never on the marker's content or on
    anything reconciliation observed beyond it: "This command's outcome was
    recovered from a provider-visible marker after an interruption; no
    operation result was ever retained locally." `reason` is `null` when the
    adopted `outcome` is `executed` (already within `success`'s existing
    domain, §7.2) and otherwise the fixed literal `"reconciled-from-marker"`
    — added to the `rejection` and `retryable-failure` domains in §7.2,
    always at `dispatched: true` (row 10 never occurs at `dispatched:
    false`), never `OperationRejectionReason` or `OperationFailureReason`,
    for the same reason rows 16 and 21 do not use them: no operation ever
    returned one to this process. This document schedules exactly one new
    summary comment (§5.1) for a row-10 disposition, rendered and enqueued in
    the same transaction as the row-10 reconciliation write itself
    (`dispatching → acknowledged`,
    `docs/chatops-execution-ledger-contract.md` §17.2) — the same
    outcome-producing-transition pattern §10.1 uses for rows 16 and 21, just
    with row 10's own transition standing in for T3.
  - **Row 16 (`docs/chatops-execution-ledger-contract.md` §13.1) —
    automatic retry budget exhausted.** Always `retryable-failure`,
    `dispatched: true`. `reason` is the fixed literal
    `"retry-budget-exhausted"` — added to that row's domain in §7.2, never
    a member of `OperationFailureReason`, because no operation call ever
    returned one: §13.1 is explicit that "the operation provably never
    started on any attempt." `summary` is one fixed sentence: "Automatic
    retries exhausted before this command's operation is known to have
    run; no operation result was ever produced." If the row's marker
    publication later exhausts at row 19 (`ackPublication: "abandoned"`),
    or the row is instead escalated (row 7) or fenced (row 20) out of
    `awaiting_ack`, the presented `kind` shifts to `human-handoff` (§4.2),
    but this fixed
    sentence remains the `summary` unchanged: it was already rendered and
    durably enqueued at row 16's own transition, before publication was
    ever attempted, and §10.1 never recomputes a summary on a later
    delivery or publication outcome — the same rule row 21's own
    publication-abandonment case states below. A row 7/20 escalation or
    fence additionally schedules the handoff correction comment the
    carve-out above (§7.1) defines for every `awaiting_ack` origin.
  - **Row 21 (`docs/chatops-execution-ledger-contract.md` §13,
    `operator-resolve(outcome, operator)`) — operator-decided outcome.**
    The row's resolved `outcome` (`executed | rejected | error`) selects
    the kind exactly as any other `acknowledged` row would (§4.2), but the
    operator supplies only that three-valued marker and their own identity
    — never a summary, never a typed rejection or failure reason. `summary`
    is one fixed sentence, keyed only on `outcome` and never on operator
    identity (§8 keeps that identity in the ledger row's `detail`, not the
    public outcome): "An operator resolved this command's outcome
    directly; no operation result was produced." `reason` is `null` when
    `outcome` is `executed` (already within `success`'s existing domain,
    §7.2) and otherwise the fixed literal `"operator-resolved"` — added to
    the `rejection` and `retryable-failure` domains in §7.2 at **both**
    values of `dispatched`, never `OperationRejectionReason` or
    `OperationFailureReason`, for the same reason row 16 does not use
    `OperationFailureReason`: no operation ever produced one. `dispatched`
    for this row is `attempts >= 1`, read off the row exactly as §4.2
    describes — row 21 can resolve a row that never left `claimed` before
    reaching `ambiguous` (§4.2) just as readily as one that did. If the
    row's marker publication is later abandoned (row 19), or the row is
    instead escalated (row 7) or fenced (row 20) out of `awaiting_ack`, the
    presented
    `kind` shifts to `human-handoff` (§4.2), but this fixed sentence remains
    the `summary` unchanged: it was already rendered and durably enqueued at
    row 21's own transition, before publication was ever attempted, and
    §10.1 never recomputes a summary on a later delivery or publication
    outcome. A row 7/20 escalation or fence additionally schedules the
    handoff correction comment the carve-out above (§7.1) defines for
    every `awaiting_ack` origin.

  Unlike the undispatched and handoff templates, none of these three is a
  per-reason lookup — each is a single fixed sentence, because the ledger
  records nothing more specific than "reconciled from a marker," "budget
  exhausted," or "operator said so" for these rows. All three pass through
  §6's pipeline like every other `summary`, and all three are rendered and
  durably enqueued in the same transaction as the row's own
  outcome-producing transition — row 10's `dispatching → acknowledged`
  (`docs/chatops-execution-ledger-contract.md` §7 row 10, §17.2), row 16's
  `retry_scheduled → awaiting_ack`, and row 21's `ambiguous → awaiting_ack`
  (`docs/chatops-execution-ledger-contract.md` §8, §13, §13.1) — **not**
  T3, which #782 §8 defines only as row 8's `dispatching → awaiting_ack`
  transition. §10.1 states this generally: every row that reaches a
  publishable outcome without an `OperationResult` enqueues its fixed
  summary atomically with the transition that produces that outcome, and
  T3 is one instance of that rule, not the only one. A restart therefore
  replays the identical fixed sentence, never a fresh derivation, so these
  three rows satisfy §10.1's byte-identical-retry guarantee the same way a
  row sourced from an `OperationResult` does.

### 7.2 Reason domains

`reason` is drawn from exactly one closed set per row of §4, never a free
string composed by this layer:

| Kind | `dispatched` | `reason` domain |
| --- | --- | --- |
| `success` | `true` | `null` |
| `success` | `false` | `null` (row 21, zero-attempt `executed` resolution — §4.2, §7.1) |
| `rejection` | `false` | the nine-member set in §4.1 \| `"operator-resolved"` (row 21, zero-attempt `rejected` resolution — §4.2, §7.1) |
| `rejection` | `true` | `OperationRejectionReason` (`docs/operation-dispatch-port-contract.md` §7, row 8) \| `"operator-resolved"` (row 21, fixed — §7.1) \| `"reconciled-from-marker"` (row 10, fixed, always `dispatched: true` — §7.1) |
| `retryable-failure` | `true` | `OperationFailureReason` (same document, §7, row 8) \| `"retry-budget-exhausted"` (row 16, fixed — §7.1) \| `"operator-resolved"` (row 21, fixed — §7.1) \| `"reconciled-from-marker"` (row 10, fixed, always `dispatched: true` — §7.1) |
| `retryable-failure` | `false` | `"operator-resolved"` (row 21, zero-attempt `error` resolution — §4.2, §7.1) |
| `ambiguous-execution` | `true` | the six execution-uncertain handoff reasons (§2), always with `attempts >= 1` (§4.2) |
| `human-handoff` | `true` | `operator-escalation` (with `attempts >= 1`) \| `ack-publication-abandoned` (with `attempts >= 1`) |
| `human-handoff` | `false` | `operator-escalation` \| `ledger-regression` \| `restore-detected` \| `witness-missing` — each only with `attempts === 0` (§4.2) \| `ack-publication-abandoned` — only with `attempts === 0`, reached either via row 21 then row 19, or directly via row 7/20 on a still-`claimed` row (§4.2) |

`"retry-budget-exhausted"`, `"operator-resolved"`, and
`"reconciled-from-marker"` are this document's own fixed additions, not
members of `OperationRejectionReason` or `OperationFailureReason` — those two
sets stay exactly as `docs/operation-dispatch-port-contract.md` §7 closes
them; this document only ever adds to a `(kind, dispatched)` pair's *own*
domain, never to either of #783's.

A `ChatOpsPublicOutcome` whose `reason` is outside the domain its
`(kind, dispatched)` pair selects is not well-formed — the same posture
`docs/operation-dispatch-port-contract.md` §7 already takes for its own two
reason sets.

This closed `reason` value is never derived lazily, after the fact, from the
ledger row's own coarser fields: `outcome` (`docs/chatops-execution-ledger-contract.md`
§5) is only ever one of `executed | rejected | error`, and row 2's `refuse`
event (§7 row 2) records only which of four coarse causes applied, never the
fine-grained §4.1 reason or the port's own `OperationRejectionReason`/
`OperationFailureReason`. Neither retains enough information to reconstruct
the closed `reason` this table requires after a restart. §9.1 defines where
that value is actually made durable and restart-safe.

## 8. Operator-private diagnostic evidence

No new persistence is introduced. What already exists is scoped here as
"operator-private" and the scoping is a usage rule, not a schema change:

- The ledger row's `evidence`, `evidenceTruncated`, `detail`, and `handoff`
  fields (#782 §5, §14) are never read by anything that composes a
  `ChatOpsPublicOutcome` (§7). They are bounded (8 refs, 500 characters,
  #782 §14) for the same reason #782 states — attacker-influenced input
  sizing a denial-of-service surface — not because they are ever headed
  toward a comment.
- These fields remain reachable only through whatever reads the ledger
  directly (an admin surface, a database query, or a future `admin chatops
  status`-shaped command). No such surface is defined here; none is a
  prerequisite for this document's guarantees, the same way #782 §19 left
  "task routing" and its admin-clear command to a later issue.
- This closes the "operator-private evidence remains useful without leaking
  through GitHub comments" acceptance criterion by construction: the two
  paths — the public outcome (§7) and the ledger row (#782 §5) — read from
  the same disposition but share no code, and §6's pipeline runs only on the
  path that leaves the process.

## 9. Event and audit metadata

```ts
interface ChatOpsAuditRecord {
  requestId: string | null;   // #783 §9.1; null whenever `dispatched` is false (§4.3)
  surface: "chatops";         // #783 §5 — constant for this adapter
  actorId: string;            // #783 §5's actor.id
  operationId: string | null; // null for any of §4.1's nine undispatched reasons —
                               // recognition, mapping, or pre-recognition refusal;
                               // known whenever mapping succeeded, even if never dispatched
  ledgerScope: {               // #782 §2
    identity: string;          // ChatOpsProviderIdentity's opaque scope key
    issueNumber: number;
    commentId: string;
  };
  row: number;                 // #782 §7's applied row number, or 0
                                // (CHATOPS_NO_CONTRACT_ROW-shaped) pre-ledger
  kind: ChatOpsResultKind;      // §3
  dispatched: boolean;          // §4.3
  reason: string | null;        // §7.2
}
```

One record per terminal-for-automation disposition (§3), emitted as
`chatops.outcome.<kind>`. This is **additive** to, not a replacement for,
#782 §14's `chatops.ledger.<transition>` events: those describe what the
ledger did internally (a transition, a refusal, a fence); this one describes
what the requester and the operator were ultimately told. A consumer that
needs execution-ledger detail still reads the ledger events; a consumer that
answers "what happened to this command" reads this one. `requestId`,
`surface`, `actorId`, and `operationId` are exactly the four fields
`docs/operation-dispatch-port-contract.md` §12 already names as what an
audit record needs to answer "who ran what, from where, once" — carried
through verbatim, not re-derived. `requestId` and `operationId` are null on
different conditions and must not be conflated: `requestId` is #783 §9.1's
per-invocation identifier, so it is null whenever `dispatched` is `false`
(§4.3) — no port call, no request. `operationId` is #784's mapped verb
identity, resolved before dispatch is ever attempted, so it is null for any
§4.1 undispatched reason, pre-recognition included: the six recognition
(#777 §4) and mapping (#784 §8) refusals never complete mapping, and
`bootstrap-backlog`, `chatops-disabled`, and `marker-comment` (§4.1) never
even reach recognition, so none of the nine has an operation identity to
record; every `human-handoff` at `dispatched: false` reached from a `claimed` row
(§4.2's `attempts === 0` rows) already has a known `operationId` — recognition
and mapping both succeeded, only the dispatch attempt itself never began —
and this record preserves it so an operator can tell which operation a
stalled command targeted without re-deriving it from the comment body.

For `kind: "human-handoff"`, `reason: "ack-publication-abandoned"`, this
record is not merely observability — it is an additional operator-routing
signal, not the only one. The ledger row itself already carries one: #782 §7
row 19 sets the row's own `handoff` field to
`{ reason: "ack-publication-abandoned", detail, fenceScope: false }` in the
same transition that reaches `acknowledged`
(`src/core/chatops-execution-ledger.ts`, confirmed by that module's own test
suite) — even though #782 §5's row-schema comment describes `handoff` as set
"exactly when state is `ambiguous`." That comment is not what the
implementation does for row 19, and this document defers to the
implementation rather than the aspirational comment (front matter: this
document does not revise #782's state machine, but it also does not
misdescribe it). A consumer recovering after a restart can therefore find an
abandoned acknowledgement two ways: by reading the ledger row's own
`handoff` field directly, exactly like an `ambiguous` row's, or by this
event's `ledgerScope` and `row`. The two are not in tension — this event
adds the `chatops.outcome.<kind>` observability stream (§9) on top of a row
that already, on its own, carries everything a recovery consumer needs.

### 9.1 Durable, restart-safe reason persistence

The `chatops.outcome.<kind>` audit record — not the ledger row — is this
document's durable record of the closed `reason` value §7.2 requires. It is
written once, atomically, in the same transaction as the
disposition-producing ledger transition: T1
(`docs/chatops-execution-ledger-contract.md` §7 row 2, `refuse`) for every
§4.1 undispatched reason, closing each of those nine values in at row
creation rather than only the coarse cause `refuse` itself carries; T3 (row
8, `dispatch-result`) for a dispatched rejection or failure whose `reason`
is an `OperationRejectionReason`/`OperationFailureReason`; rows 10, 16, and
21's own transitions (§7.1) for their fixed reason literals; and — closing
the gap the rest of this subsection exists to name — rows 7, 11, 13, and 20's
own transitions whenever one of them is the row's **first** disposition-
producing transition, i.e. it fires from `claimed`, `dispatching`, or
`retry_scheduled` and the row has never previously reached `awaiting_ack`
(`docs/chatops-execution-ledger-contract.md` §7 rows 7, 11, 13, 20). Row 11
and row 13 only ever fire from `dispatching`, so they are always a first
disposition-producing transition; row 7 (`escalate`) and row 20 (`fence`)
sometimes are, and sometimes are not — see below. This is the identical
atomicity guarantee §10.1 already gives the summary outbox effect —
rendered once, enqueued in the same transaction as the outcome-producing
write, never recomputed on retry — extended here to the audit record's
`reason` field. It does not add a field to the ledger row (front matter):
`ChatOpsAuditRecord` (§9) is a separate, already-declared structure with its
own persistence, not an addition to `ChatOpsLedgerRow`.

**Superseding a disposition that already has a record.** Three transitions
change what a row's *current* `ChatOpsPublicOutcome` is after an earlier
transition already produced one, and each requires its own atomic audit
write rather than leaving the earlier record as the only durable one:

- **Row 19** (`ack-publish-failed` at the cap) moves an `awaiting_ack` row —
  which already has a record from T3, row 10, row 16, or row 21 — to
  `acknowledged` with `ackPublication: "abandoned"`. §4.2 changes the row's
  kind from whatever T3/10/16/21 recorded (`success`, `rejection`, or
  `retryable-failure`) to `human-handoff`, `reason:
  "ack-publication-abandoned"` (§7.1, §7.2).
- **Row 7** (`escalate`) or **row 20** (`fence`), when applied to a row
  already in `awaiting_ack`, move it to `ambiguous` with kind
  `human-handoff`, `reason` set to whichever handoff reason the transition
  cited — `"operator-escalation"` and `"ack-publication-abandoned"` are the
  two possible values, per §4.2 — the same case §5.1
  already schedules a bounded handoff correction comment for, "because that
  row's earlier summary was already committed \[...] reporting an outcome
  this transition now supersedes" (§5.1). The audit trail has the identical
  problem the comment trail has there, and gets the identical fix.

For each of these three cases, the same transaction that applies the row
7/19/20 event also writes a **new** `chatops.outcome.human-handoff` record —
it does not rewrite, delete, or mutate the record T3/10/16/21 already wrote.
That earlier record is not an error to be corrected; it is an accurate
account of the disposition the row held at the time it was written, exactly
as the preserved `summary` (§5.1, §7.1) — row-8-, row-16-, or
row-21-sourced, whichever origin applies — that the handoff correction
comment sits alongside, rather than replaces. The new record's `row` field
is `19`, `7`, or `20` — never the earlier transition's row number — so a
reader can tell the two apart without comparing `kind`/`reason`. A row can
therefore accumulate more than one `chatops.outcome.<kind>` record over its
lifetime. "One record per terminal-for-automation disposition" (§9) means
one record per disposition the row has held, not one record per row: a
consumer reconstructing a row's *current* disposition after a restart reads,
for a given `ledgerScope`, the **most recently emitted** record — the event
log's own emission order, never the numeric value of the `row` field. `row`
identifies which transition produced a record; it is not a sequence number,
and it is not time-ordered across records: a row-21 resolution's record
(`row: 21`) can be superseded by a later row-19 abandonment (`row: 19`) or a
later row-7 escalation of the resulting `awaiting_ack` row (`row: 7`), both
numerically lower than the record they supersede. A reader that picks the
record with the numerically highest `row` for a given `ledgerScope` gets the
wrong answer for exactly that case; it must instead read in emission order
and take the last one, exactly as it would read the ledger row's own current
state rather than a stale copy of an earlier one.

This closes the restart gap the ledger row leaves open by design. Neither
`outcome`'s three values nor row 2's undifferentiated `refuse` event is ever
recomputed, guessed, or left absent after a restart — the audit record
already durably carries the precise closed `reason`, committed before the
transaction that produced the disposition ever returns, so there is nothing
left to reconstruct from those coarser fields. That guarantee now covers
every terminal-for-automation disposition a row can reach, including one
reached only via row 7, 11, 13, or 20, and including a later disposition
that supersedes an earlier one via row 7, 19, or 20 — not only T1, T3, and
rows 10/16/21, the transitions the original text of this subsection named.
An implementation
that emits `chatops.outcome.<kind>` as a transient, best-effort event rather
than a durably committed write does not satisfy this document: a restart
between any of these transitions and a merely-in-memory audit emission
would silently lose the exact `reason` §7.2 requires — for an undispatched
`rejection` (§4.1), because the audit record is the *only* durable carrier
of that reason value at all; for a row superseded by row 7, 19, or 20,
because a restart before the new record commits would leave only the
earlier, now-stale record readable, misreporting an `ambiguous` or
abandoned row as still `success`, `rejection`, or `retryable-failure`.

## 10. Acknowledgement-post failure and retry

Two regimes exist, deliberately different, and the difference is
risk-based — not an oversight to reconcile:

### 10.1 Dispatched outcomes (§4.2)

The two comments §5.1 defines have different retry mechanisms, because they
have different persistence needs:

- **The marker.** Governed **entirely** and **unchanged** by
  `docs/chatops-execution-ledger-contract.md` rows 17–19 for every row
  sourced from row 8, row 16, or row 21: `ackPublication` moves
  `pending → published` (row 17) or retries up to
  `CHATOPS_MAX_ACK_PUBLICATION_ATTEMPTS` (row 18) before abandoning and
  raising a `human-handoff` (row 19, §4.2). This document adds no new
  attempt counter and no new bound. Content immutability here costs
  nothing extra: the marker body is `<!-- chatops-ack:<id>:<outcome> -->`,
  and both `<id>` (the ledger scope's `commentId`) and `<outcome>` (the
  row's `outcome` field, #782 §5) are already durable on the row. A retry
  re-derives the identical body from data T3 already committed
  (`docs/chatops-execution-ledger-contract.md` §8) — there is no separate
  payload to lose, and nothing for a restart to forget. **Row 10 is not part
  of this retry path at all**: reconciliation reaches `acknowledged` with
  `ackPublication: "published"` set directly by the row-10 transition itself
  (`docs/chatops-execution-ledger-contract.md` §7 row 10), because the marker
  it adopts was already found on the provider — rows 17–19 never run for a
  row-10 disposition, and there is nothing for this document to retry or
  abandon on the marker side.
- **The summary.** `OperationResult.summary` and the composed `reason` (§7)
  are **not** reconstructable from the ledger row alone — #782 §5's row
  schema stores only the three-valued `outcome`, never the operation's
  prose, and this document adds no field to that row (front matter). What
  makes the summary comment byte-identical across a retry is that it is
  never recomputed: the sanitized `ChatOpsPublicOutcome` (§6, §7) is
  rendered once and enqueued as the outbox effect §5.1 defines, in the
  **same transaction as the ledger transition that first produces the
  outcome**. For every row that reaches `awaiting_ack` via T3
  (`dispatching → awaiting_ack`, row 8, `docs/chatops-execution-ledger-contract.md`
  §8) that transition is T3 itself. Rows 10, 16, and 21 (§7.1) reach a
  publishable outcome by a different transition — row 10's
  `dispatching → acknowledged` (§17.2), row 16's
  `retry_scheduled → awaiting_ack` (§13.1), and row 21's
  `ambiguous → awaiting_ack` (§13) — and none of the three is T3, which
  #782 §8 defines only as row 8's transition. The same requirement applies to
  those transitions in their own right: the outbox enqueue for row 10's,
  row 16's, and row 21's fixed summary (§7.1) is part of the same transaction
  as that row's own outcome-producing write, for the identical reason T3
  carries the enqueue — without it, the ledger could commit the
  disposition and (for rows 16 and 21) reach the marker-publication path
  (§5.1, rows 17–19), or (for row 10) commit `ackPublication: "published"`
  directly, before any publishable summary is durable anywhere, which is
  exactly the lost-write gap rows 17–19 exist to prevent for the marker and
  that this document must prevent for the summary on every one of these
  three rows in its own right. The rendered text is therefore durable from
  the instant the disposition exists, survives a restart the same way any
  other outbox row does, and is never re-derived from the operation or from
  live state on a later delivery attempt. This is the "existing durable
  outbox record" this document relies on instead of adding a field to
  `ChatOpsLedgerRow`: the outbox already persists an effect's payload at
  enqueue time and delivers it unchanged (`docs/DOMAIN.md` §2.3), which is
  exactly the byte-identical-retry property the summary needs and the ledger
  row does not provide.

Put plainly: the marker body and the `summary` text (§7) posted on attempt
*N+1* are byte-identical to attempt *N*, because neither is recomputed on
retry — both are re-delivered from data already fixed at the row's
outcome-producing transition (T3 for row 8; row 10's, row 16's, and row 21's
own transitions for those rows, per above). Row 10 has no marker retry at
all — the marker was already durable on the provider before reconciliation
ever ran — so only its summary is subject to this guarantee, on the same
terms as row 16's and row 21's.

Together these are what make "acknowledgement retries do not invent
execution success" true by construction rather than by discipline: there is
no code path on either retry side that reads anything other than data
already durable at the moment the outcome was first committed, so a retry
cannot produce a different marker body or summary text than what was
already fixed, and reconciliation (#782 §11) is never short-circuited by a
retry succeeding — a retry that publishes moves only `ackPublication` (or
the summary's own outbox delivery state), never `state`, `outcome`, or
`attempts`. A retry that instead exhausts the marker's bounded attempt
budget is the one path that does change the presented `ChatOpsResultKind`:
row 19, at the cap, moves `ackPublication` to `"abandoned"` and, per §4.2
and §9.1, supersedes whatever `success`/`rejection`/`retryable-failure`
record the row already had with a new `chatops.outcome.human-handoff`
record, `reason: "ack-publication-abandoned"` — never inventing an
execution outcome (the row's `outcome`, `attempts`, and the original
record both stay exactly as committed, §9.1), but changing what is
*presented* as the row's current disposition. This is a one-way,
one-time transition out of the retry loop, not a retry that "succeeds
differently": row 19 moves the row to `acknowledged`, and
`docs/chatops-execution-ledger-contract.md` row 23 refuses every event on an
`acknowledged` row — "there is no path out of a fully terminal row" — so
rows 17–19 never run again for that row once `ackPublication` reaches
`"abandoned"`, and no further retry can change `kind` a second time.

### 10.2 Undispatched rejections (§4.1) never publish

A `rejected` row created under any of the nine §4.1 reasons is terminal at
T1 with no external effect ever attempted
(`docs/chatops-execution-ledger-contract.md` §6–§7 row 2, §8), and this
document schedules none: no marker (§5), no summary comment (§5.1), and no
other provider-visible reply. This is deliberately the simpler regime,
because the risk rows 17–19 exist to bound — a lost write retroactively
hiding whether a **mutating** operation ran — cannot occur here: no
operation was ever invoked at all (§4.2's `dispatched: false`; #782 §6,
`rejected`'s external effect is "No").

`docs/chatops-command-grammar-contract.md` (#777) §10's public-response
table marks some of these nine reasons "Allowed" for a reply. That marking
is #777's own and is not realized by this document as a ChatOps-adapter
comment: constructing or delivering one from a `rejected` row would itself
be the external effect #782 §6 says that row never attempts, and #782's
state machine — out of this document's scope to revise (front matter) —
defines no transition that would let a `rejected` row attempt one and stay
terminal. Reconciling #777's table with this constraint, if a requester-visible
reply for these reasons is still wanted, is a revision to #782's state
machine (a new, bounded transition analogous to rows 17–19 but reachable
from `rejected`) — out of scope here. Until such a transition exists, an
undispatched `rejection` produces no provider-visible reply of any kind:
the durable acknowledgement (§5) and the audit record (§9) are what make
its outcome deterministic and operator-visible, independent of the
provider.

### 10.3 Why `ackPublication` still applies structurally

`docs/chatops-execution-ledger-contract.md` §5 declares `ackPublication` as
`"not-required" | "pending" | "published" | "abandoned"` on every ledger
row, not only dispatched ones. This document is what fixes its value for a
`rejected` row: **`"not-required"`**, for all nine §4.1 reasons, written
exactly **once**, in T1 alongside the row itself (#782 §7 row 2, §8), and
**never afterward** — #782 §7 row 23 refuses every event a fully terminal
row receives, `rejected` included, so no later transition may carry
`ackPublication` away from that value on the ledger row itself.

`"pending"` never occurs on a `rejected` row in this document's model: that
value describes a dispatched disposition mid-flight toward `acknowledged`
(`docs/chatops-execution-ledger-contract.md` §5, §9.1, rows 17–19), which a
`rejected` row — never having entered `awaiting_ack` — cannot be. Fixing
every §4.1 reason to `"not-required"` is what keeps this field consistent
with §10.2: there is no reply this document ever schedules for a `rejected`
row, so there is no eligibility state for the field to track beyond the one
value it is given at creation.

This is a value assignment for an already-declared field, fixed once in the
same transaction that creates the row, not a state-machine change — which
is why it belongs here rather than requiring a revision to #782.

## 11. Reconciling DOMAIN.md and the split chain

Three corrections land alongside this document, all editorial (no behavior
change) and all in the direction of making the executable chain and its
prose descriptions agree:

- **`docs/DOMAIN.md` §5 item 3** gains the #784 and #785 paragraphs the
  chain description stopped short of (it previously narrated only through
  #783's delivery). See that document's diff for the exact wording; the
  content is this document's own summary (§2–§10) plus #784's (already
  written, `docs/chatops-operation-mapping-contract.md`).
- **`docs/operation-dispatch-port-contract.md` §16** named "Routing
  protection" as forward-pointing to *this* issue (#785). That was written
  before #784 existed; #784's own title is "ChatOps operation mapping **and
  routing protection**," and its §3–§4 are exactly that routing protection,
  already delivered. The pointer is corrected to "Delivered (#784)," mirroring
  how that same document's §19 already marks its own delivery by #783. The
  same section's "Acknowledgement and result publication" pointer, which
  correctly named this issue, is marked "Delivered (#785)."
- **`docs/chatops-operation-mapping-contract.md` §12** named this document
  by the issue's own working title rather than by filename, since the
  filename did not exist yet when #784 was written. It gains this document's
  filename alongside the existing prose.

No GitHub Issue Relationship changes: the executable chain
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (recorded in the issue body, per DOMAIN.md's own
citation convention) already has #785 in the position this document fills.
Reconciliation here is entirely about the **prose** catching up to a chain
that was already correct.

## 12. Admission criteria for #697

#697 (Tool Request grant-policy tiers over typed operation ids) may begin
once, and may assume without re-verifying:

1. **Every dispatched operation produces exactly one `ChatOpsResultKind`**
   via §4's total mapping. #697 introduces no new outcome kind for a
   tier decision: a tier-gated refusal is `rejection` with
   `reason: "not-permitted"` — already a member of `OperationRejectionReason`
   (`docs/operation-dispatch-port-contract.md` §7) — and a tier that allows
   immediate execution is `success`, unchanged.
2. **Tiering is a context-construction concern, not a result-mapping
   concern.** `OperationContext.confirmed`
   (`docs/operation-dispatch-port-contract.md` §5.2) is where #697's
   auto-grant / notify-and-proceed / human-gate split is decided, entirely
   upstream of §3–§4. #697 does not modify this document's mapping table to
   add its policy.
3. **The public outcome (§7) never carries tier or policy internals beyond
   the closed `reason` code.** A tier name, a policy identifier, or an
   audit trail of *why* a tier applied belongs in `OperationResult.data`
   (`docs/operation-dispatch-port-contract.md` §7) or #697's own audit
   surface — never in `summary`, which §6's pipeline strips to prose plus a
   closed reason code regardless of what upstream supplied.
4. **This document reserves no slot for a pending/awaiting-approval status.**
   Every `ChatOpsResultKind` (§3) describes a disposition that is either
   terminal or terminal-for-automation (#782's own vocabulary). A
   genuinely deferred "notify-and-proceed, pending post-hoc review" state —
   if #697's design needs one — is new vocabulary #697 must define for
   itself; it must not be represented by overloading `ambiguous-execution`
   (which means *execution status is undecidable*, not *execution is
   deliberately deferred*) or `human-handoff` (which means *the disposition
   is already known or explicitly abandoned locally*).
5. **Acknowledgement-post retry (§10) applies unchanged to any operation
   #697 registers.** #697 introduces no new publication or retry policy.
6. **The prerequisite chain is exactly**: `docs/operation-dispatch-port-contract.md`
   (#783, the callable port and `confirmed`/`mutating` gating), this
   document's §3–§10 (the outcome vocabulary and publication rules), and
   `docs/chatops-operation-mapping-contract.md` (#784, whose table #697
   extends with new verbs and/or a tiering policy over it) — no other
   undocumented dependency exists, per §11's reconciliation.

## 13. Test seams and matrix

Nothing in this document is implemented. When implementation begins, the
required coverage is:

| Area | Cases |
| --- | --- |
| Mapping totality (§4) | every row of §4.1 and §4.2 produces the documented `(kind, dispatched)` pair, including all four causes of ledger row 2 (recognition refusal, bootstrap backlog, ChatOps disabled, marker comment); no other ledger disposition or recognition/mapping/pre-recognition outcome exists that the table does not cover. |
| Mapping resolved before T1 (§4.1) | a candidate whose mapping fails (`unsupported-operation` or `invalid-argument`) is never written as `claimed` (ledger row 1) — mapping's outcome is known before T1's row-1-vs-row-2 write, so the row is created directly by row 2 with `ChatOpsRefusalReason: "recognition-refused"`, the same literal #777's four recognition refusals use; no row for such a comment ever reaches `claimed` and is later re-refused. |
| `dispatched` preservation (§4.3) | a `rejection` with `dispatched: false` and one with `dispatched: true` are never collapsed into one shape by any consumer. |
| Zero-attempt ambiguous (§3, §4.2) | an `ambiguous` row reached from `claimed` (ledger row 7 escalate, or row 20 fence) with `attempts === 0` maps to `human-handoff`, `dispatched: false`, for every one of `operator-escalation`, `ledger-regression`, `restore-detected`, `witness-missing`, and `ack-publication-abandoned`; the same five reasons with `attempts >= 1` map to `ambiguous-execution`/`human-handoff` with `dispatched: true` per §4.2's existing rows (`ambiguous-execution` for the three execution-uncertain reasons, `human-handoff` for `operator-escalation` and `ack-publication-abandoned`); `dispatch-crash-unresolved`, `reconcile-inconclusive`, and `conflicting-evidence` never occur at `attempts === 0`. |
| Zero-attempt acknowledged (§3, §4.2) | a row-21 (`operator-resolve`) resolution of a zero-attempt `ambiguous` row (reached from `claimed` via row 7 or row 20) keeps its outcome-selected `kind` — `success` for `executed`, `rejection` for `rejected`, `retryable-failure` for `error` — with `dispatched: false` and `reason` per §7.2's zero-attempt domains; the same three outcomes with `attempts >= 1` keep `dispatched: true` per §4.2's existing rows; a zero-attempt row whose marker publication is later abandoned (row 19) presents as `human-handoff`, `dispatched: false`, `reason: "ack-publication-abandoned"`, never `dispatched: true`. |
| Summary composition (§7.1) | every `(kind, dispatched)` pair resolves to exactly one of the four sources: `success`/dispatched-`rejection`/row-8 `retryable-failure`/row-8-originated `ackPublication: "abandoned"` `human-handoff` (`attempts >= 1`) read `OperationResult.summary`; an `ambiguous-execution`/`operator-escalation`-`human-handoff` disposition escalated (row 7) or fenced (row 20) out of `awaiting_ack` **preserves that same row-8 `OperationResult.summary` unchanged rather than reading the handoff template**, even though its `kind`/`reason` follow §4.2's `ambiguous`-sourced mapping; every §4.1 reason and every zero-attempt `human-handoff` sourced from `operator-escalation`, `ledger-regression`, `restore-detected`, `witness-missing`, or `ack-publication-abandoned` reads the fixed undispatched template; every `ambiguous-execution` reason and every `operator-escalation`-or-`ack-publication-abandoned`-at-`attempts >= 1` `human-handoff` reached without ever passing through `awaiting_ack` reads the fixed handoff template naming only the closed `reason` code; row-10 `success`/`rejection`/`retryable-failure` (always `dispatched: true`), row-16 `retryable-failure`, and every row-21-resolved outcome — including a zero-attempt one, and one whose marker publication is later abandoned — read the fixed ledger-synthesized templates with `reason` `"reconciled-from-marker"`, `"retry-budget-exhausted"`, or `"operator-resolved"` (or `null` for an `executed`/row-10-`executed` outcome); a row-16 disposition whose marker publication is later abandoned (row 19, presenting as `human-handoff`) likewise keeps row 16's fixed sentence unchanged; `ChatOpsPublicOutcome.summary` is non-null for every disposition this document can reach, including those rows after a restart. |
| Handoff correction comment (§5.1, §7.1) | a row escalated (row 7) or fenced (row 20) out of `awaiting_ack` — whether that row reached `awaiting_ack` via row 8, row 16, or row 21 — enqueues, in the same transaction, a fixed handoff correction comment distinct from its preserved `summary`, keyed only on the handoff `reason`, byte-identical on a later delivery retry; escalating or fencing a row still `claimed`, `dispatching` before row 8 ever ran, or `retry_scheduled` enqueues no such comment, and no other kind or transition ever produces one. |
| Reason persistence (§9.1) | the `chatops.outcome.<kind>` audit record's `reason` is committed atomically with T1 (row 2, every §4.1 cause), T3 (row 8, every `OperationRejectionReason`/`OperationFailureReason`), rows 10/16/21's own transitions, and rows 7/11/13/20's own transitions whenever one of them is a row's first disposition-producing transition; after a simulated restart immediately following each of those commits, the exact closed `reason` is readable from the audit record alone, never recomputed from the ledger row's own `outcome` or row 2's coarse `refuse` cause. |
| Reason persistence, superseded (§9.1) | when row 19 abandons an `awaiting_ack` row's marker publication, or row 7/20 escalates or fences a row already in `awaiting_ack`, a **second** `chatops.outcome.human-handoff` record is committed atomically with that transition, with `row: 19`, `7`, or `20`; the earlier record from T3/row 10/row 16/row 21 is left unmodified; after a simulated restart immediately following the superseding commit, a reader that takes the most-recently-emitted record for the `ledgerScope` sees the superseding `human-handoff` disposition, and one that (incorrectly) picks the numerically highest `row` field is shown to fail whenever the superseding row number (7, 19, or 20) is lower than the superseded one (21). |
| Row-10 crash recovery (§3, §4.2, §7.1, §10.1) | a row that reconciles from `dispatching` directly to `acknowledged` via row 10 (`docs/chatops-execution-ledger-contract.md` §7 row 10, §17.2 — claim and ack markers both found on the provider) always has `dispatched: true` and `ackPublication: "published"` set by the reconciliation write itself, never by rows 17–19; its `kind` follows the adopted `outcome` exactly as any other `acknowledged` row (§4.2); its `summary` is the fixed row-10 sentence (never `OperationResult.summary`, since none was ever produced) and its `reason` is `null` for `executed` or `"reconciled-from-marker"` otherwise; the fixed summary is enqueued in the same transaction as the row-10 write, byte-identical on any later delivery retry, exactly like rows 16 and 21 (§10.1). |
| Marker/summary separation (§5.1) | a marker comment's trimmed body is always exactly one canonical form, never containing `summary` text; a summary comment's trimmed body is never a canonical marker form and is never collected as evidence (`docs/chatops-execution-ledger-contract.md` §10.1). |
| Grammar-ineligible headers (§5.1, §7.1) | the summary comment's leading line is always exactly `CHATOPS_SUMMARY_HEADER`, and the handoff correction comment's leading line is always exactly `CHATOPS_HANDOFF_CORRECTION_HEADER`, for every `OperationResult.summary` input including prose crafted to look like a command (e.g. beginning with `/grant`); neither literal ever matches `docs/chatops-command-grammar-contract.md` §2's grammar, and recognizing either comment against that grammar always produces `malformed`, never `command`. |
| Marker gating, dispatched (§5) | `ambiguous-execution` and `human-handoff` never produce a marker post at the moment they are reached; a resolution (row 21) of an `ambiguous` row — whatever its handoff reason, `operator-escalation` or `ack-publication-abandoned` included — posts a marker (and a summary, §5.1) built from §7.1's fixed row-21 template, not an `OperationResult` — regardless of whether the resolved row's `attempts` was 0 or `>= 1`; an `ack-publication-abandoned` row that reached terminal `acknowledged` via row 19 has no automated or operator-authorized republication path defined and stays terminal with no marker — this is distinct from an `ambiguous` row citing `ack-publication-abandoned` as its handoff reason (row 7/20), which is still resolvable via row 21/22 like any other `ambiguous` row. |
| Marker gating, undispatched (§5, §10.2) | none of the nine §4.1 reasons ever produces a marker or any other provider-visible reply; every one sets `ackPublication: "not-required"` at row creation (§10.3) and the row's `state` stays `rejected` throughout. |
| Human-handoff routing split (§5) | an `operator-escalation` disposition and an `ack-publication-abandoned` disposition are both discoverable via the ledger row's own populated `handoff` field — `operator-escalation` via row 7/20, `ack-publication-abandoned` via either row 19 (terminal `acknowledged`) or row 7/20 directly on a still-`ambiguous` row; every one of these is additionally discoverable via its `chatops.outcome.human-handoff` audit record (§9), which is additive, not the sole path. |
| Visibility pipeline (§6) | a summary containing a local path, a credential shape, a closing-keyword reference, and raw HTML each come out sanitized; `OperationResult.data` never appears in a public outcome under any input. |
| Reason domains (§7.2) | a `ChatOpsPublicOutcome` with a reason outside its `(kind, dispatched)` domain is rejected as malformed. |
| Retry content immutability (§10.1) | two publication attempts for the same ledger row produce a byte-identical marker, re-derived each time from the row's persisted `commentId`/`outcome`, and a byte-identical summary, re-delivered each time from the outbox effect enqueued in the same transaction as the row's outcome-producing transition (T3 for row 8; row 10's, row 16's, or row 21's own transition for those rows) rather than re-rendered; a retry never changes `kind`, `reason`, or `dispatched`; for a row-10 disposition, no marker retry ever occurs (rows 17–19 never run), so only the summary's delivery is retried. |
| Undispatched publication policy (§10.2, §10.3) | every `rejected` row, for all nine §4.1 reasons, sets `ackPublication: "not-required"` once, at row creation, and it is never mutated afterward on that row (ledger row 23); no §4.1 reason ever attempts a marker or summary post. |
| Docs pin | `test/docs-chatops-result-contract.test.js` pins this document's five-kind set, the nine-member undispatched-reason set, the §4 mapping tables, the §7.2 reason domains, the §12 admission-criteria list, and the exact `CHATOPS_SUMMARY_HEADER`/`CHATOPS_HANDOFF_CORRECTION_HEADER` literals against drift. |

## 14. Invariants

1. Every disposition this codebase's ChatOps surface can reach maps to
   exactly one `ChatOpsResultKind` (§3, §4) — the mapping is total, and a
   value outside the five-member set is never produced.
2. `dispatched` is preserved through every projection; no consumer may infer
   "no dispatch was ever attempted" from `kind: "rejection"` alone, and no
   consumer may read `dispatched: true` as proof a handler executed rather
   than proof a port attempt began (§4.3).
3. A public outcome's `summary` never contains a local path, a credential
   shape, an unneutralized closing-keyword reference, unescaped raw HTML, or
   any part of `OperationResult.data` (§6).
4. `ambiguous-execution` and `human-handoff` never produce a marker post at
   the moment they are reached; only a row-21 resolution of an `ambiguous`
   row does — whatever its handoff reason, `operator-escalation` or
   `ack-publication-abandoned` cited directly included — built from §7.1's
   fixed row-21 template rather than an `OperationResult` (§5).
   `ack-publication-abandoned` reached via row 19 (terminal `acknowledged`)
   is the one instance with no resolution this document or #782
   defines — it stays terminal with no marker (§5). An undispatched
   `rejection` (§4.1) is a separate case: it never produces a marker, or any
   other provider-visible reply, under any of its nine reasons, and its row
   stays `rejected` throughout (§10.2).
5. A retry of a dispatched outcome's acknowledgement that publishes never
   changes `kind`, `reason`, `dispatched`, or the posted text — it changes
   only `ackPublication` for the marker, or the outbox effect's own delivery
   state for the summary (§10.1). The one exception is a marker-publication
   retry that instead exhausts its bounded attempt budget: at the cap, row
   19 moves `ackPublication` to `"abandoned"` and, per §4.2 and §9.1,
   supersedes the presented `kind`/`reason` with `human-handoff` /
   `ack-publication-abandoned` — without altering the row's own `outcome`,
   `attempts`, or the earlier `chatops.outcome.<kind>` record, and without
   any later retry (row 23 makes the row terminal) reopening it (§10.1).
6. An undispatched rejection never has a reply to deliver: `ackPublication`
   is fixed to `"not-required"` at its one write in T1 and is never mutated
   afterward (§10.2, §10.3; ledger row 23 forbids any later transition on a
   `rejected` row).
7. Operator-private ledger fields (`evidence`, `detail`, `handoff`) are never
   read by the code path that composes a public outcome (§8).
8. `ack-publication-abandoned`'s operator routing reads the ledger row's own
   populated `handoff` field, exactly like `operator-escalation`'s, on
   either of its two reachable paths: row 19 sets it in the same
   transition as `state: "acknowledged"` (per
   `src/core/chatops-execution-ledger.ts` and its test suite), and row 7 or
   row 20 sets it directly on a still-`ambiguous` row exactly as for any
   other handoff reason (§4.2). Both paths get the
   `chatops.outcome.human-handoff` audit record (§5, §9) as an additive,
   not sole, second path.
9. `dispatched` for `ambiguous-execution` and `human-handoff` is
   `attempts >= 1`, read directly off the row for `ledger-regression`,
   `restore-detected`, `witness-missing`, `operator-escalation`, and
   `ack-publication-abandoned` —
   never inferred from the handoff reason alone, because each of those
   five reasons occurs at both values of `dispatched` (§4.2, §4.3). The
   same read applies to every `acknowledged` disposition reached via row
   21 (`success`, `rejection`, `retryable-failure`, and `human-handoff` via
   `ackPublication: "abandoned"`): row 21 can resolve a row that never left
   `claimed`, so `dispatched: true` is never assumed for an `acknowledged`
   row on the strength of its `state` alone (§4.2, §4.3).
10. A marker comment's trimmed body is always exactly one canonical form
    (§5.1); the rendered `summary` is never appended to it or embedded in
    it. The summary's own publication is enqueued as an outbox effect in
    the same transaction as the outcome commit (§10.1), never recomputed
    on a later delivery attempt.
11. A row escalated (row 7) or fenced (row 20) out of `awaiting_ack` —
    whether it reached that state via row 8's `OperationResult`, row 16's
    retry-budget-exhaustion sentence, or row 21's operator-resolution
    sentence — keeps that origin-sourced `summary` unchanged; this
    document never enqueues a
    second, handoff-template summary for it, and only `kind` shifts per
    §4.2. It does, in the same transaction, enqueue one additional fixed
    handoff correction comment — distinct from, and never a substitute
    for, `summary` — so the requester is not left reading a superseded
    outcome with no indication it is now unresolved (§7.1), regardless of
    which transition originally put the row into `awaiting_ack`.
12. The `chatops.outcome.<kind>` audit record's closed `reason` is committed
    durably and atomically with the disposition-producing ledger
    transition, never as a transient event requiring later reconstruction
    from the ledger row's own coarser `outcome` or `refuse` cause (§9.1).
13. A comment's mapping outcome (#784 §8) is always resolved before T1 ever
    writes a ledger row for it (§4.1): `unsupported-operation` and
    `invalid-argument` are represented by row 2's `refuse` event under the
    ledger's existing `"recognition-refused"` `ChatOpsRefusalReason` — the
    same value #777's four recognition refusals use — never by a
    `claimed → rejected` transition #782 does not define, and never by a
    row that was ever, even momentarily, `claimed`.
14. The summary comment (§5.1) and the handoff correction comment (§7.1)
    each begin with a fixed, pinned literal (`CHATOPS_SUMMARY_HEADER`,
    `CHATOPS_HANDOFF_CORRECTION_HEADER`) that never begins with `/`, so
    neither can ever satisfy §2's command grammar — a structural guarantee
    of the exact pinned text, not an incidental property of whatever header
    an implementation happens to choose — independent of
    `OperationResult.summary` content, the per-reason handoff template, or
    the posting account's identity.

## 15. Non-goals and forward pointers

This document defines the result, acknowledgement, and dependency-chain
layer only. It does not define, and nothing implementing it should assume:

- **The execution-ledger state machine and its replay behavior** — already
  fixed, `docs/chatops-execution-ledger-contract.md` (#782); this document
  adds no row, state, or field to it (§10.3).
- **Which operations exist, verb-to-operation mapping, and per-surface
  argument policy** — already fixed, `docs/chatops-operation-mapping-contract.md`
  (#784).
- **Tool Request grant-policy tiers over typed operation ids** — #697, handed
  the precise, checkable admission criteria in §12 rather than anticipated
  here. **Delivered (#697)**: `docs/tool-request-grant-tiers-contract.md`,
  whose §12 answers those six criteria point by point — no new outcome
  kind, tiering at context construction, no policy internals in `summary`,
  a tier-owned `postHocReview` vocabulary instead of an overloaded kind, no
  new publication or retry policy, and exactly the stated prerequisite
  chain.
- **An admin surface for reading ledger rows or the audit record stream** —
  §8 and §9 define what such a surface would read, not the surface itself,
  the same way #782 §19 left an admin fence-clear command to a later issue.
- **Polling, dispatch transport, and the SQLite schema** — already listed as
  non-goals by `docs/chatops-execution-ledger-contract.md` §19 and
  `docs/operation-dispatch-port-contract.md` §16; this document adds no
  transport decision of its own (§10.2, §10.3).

That work is tracked by the executable chain this issue's predecessors head:
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships).
