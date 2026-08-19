# ChatOps execution ledger and crash/restore replay contract

Status: **approved design, implemented at the decision layer**
(`src/core/chatops-execution-ledger.ts`). This document specifies exactly one
thing: once a comment has been discovered as a candidate, what durable states
its execution passes through, which transitions are legal, what happens when
the process dies or the database is restored from an older backup, and what
delivery guarantees any of that actually earns. It does not specify, and no
implementation built against it may assume, comment scanning, cursor
progression, command grammar, or what a recognized command *does* — those are
separate contracts (§19).

This "implemented" status is component-level, not end-to-end: see
[feature-status.md](feature-status.md) for ChatOps's overall availability,
which stays `foundation-only` until comment ingestion, dispatch, and result
publication are connected.

Issue #696 / PR #776 attempted to specify the entire ChatOps surface in one
document and could not converge after ten review cycles. #777 extracted the
command grammar and trust boundary
(`docs/chatops-command-grammar-contract.md`); #780 extracted provider identity
and the state namespace (`docs/chatops-identity-contract.md`); #781 extracted
discovery and the complete scan window
(`docs/chatops-comment-cursor-contract.md`). This document is issue #782, the
next link: the execution ledger and its replay behavior. It supersedes the
ledger/replay portion of #778 and of #696 / PR #776.

The review of PR #776 found the concrete failure this document exists to
prevent: **a local idempotency key alone cannot make execution at-most-once
across a crash or a restore of an older SQLite backup.** A key says "I have
already handled this" only for as long as the row holding it survives. Restore
an older database and the row is gone; the comment is rediscovered, looks
new, and the command runs a second time — against a repository state it was
never written for, with no local trace that it ever ran before.

## 1. Why the ledger needs its own contract

Discovery (#781) ends with a candidate: a comment nobody has a first-seen
record for. #781 §10 is explicit that this is *newly discovered*, not *not yet
executed*, and #781 §16 hands the difference to this document. The gap between
those two statements is where every hard problem lives:

- **There is no transaction that spans SQLite and the provider.** Committing
  "dispatched" locally and posting a comment to GitHub are two independent
  writes with an unprotected window between them. Whichever order they run in,
  a crash in that window leaves a state where one side happened and the other
  did not, and no amount of local care removes the window. Any contract that
  promises exactly-once end-to-end here is promising something the substrate
  cannot deliver.
- **Local state is restorable; external effects are not.** `docs/retention-backup-contract.md`
  §8 makes a verified SQLite backup a hard precondition for destructive
  maintenance and defines restore as a manual, out-of-loop operator action.
  Restore rewinds the database. It does not rewind a merged PR, a granted Tool
  Request, or a comment already posted to an issue. A ledger that trusts only
  its own rows is, after a restore, confidently wrong.
- **The only shared, durable, authenticated record of what happened is on the
  provider.** #777 §7 already defines acknowledgement markers and what makes
  one authentic. This document is what turns them from a formatting rule into
  evidence — with the payload and ordering validation that "authentic" alone
  does not cover.

`docs/outbox-scan-cursor-contract.md` solves the analogous local-only problem
for outbox dispatch, and its fail-closed posture is deliberately echoed here.
The difference is the direction of the risk: an outbox row that is dispatched
twice is a duplicate notification, while a ChatOps command that is dispatched
twice is an operation executed twice. This contract therefore prefers *not
running a command* over *possibly running it again*, and says so in every
place that choice is made.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| **Ledger scope** | One `(ChatOpsProviderIdentity, issueNumber, commentId)` triple — the key shape `docs/chatops-identity-contract.md` §6 calls the *ledger* scope. One row per scope, ever. |
| **Fence scope** | One `(ChatOpsProviderIdentity, issueNumber)` pair — the cursor scope of #781. Fencing (§12) applies at this grain, not per comment. |
| **Attempt** | One pass through `claimed → dispatching → …`. Counted durably as `attempts`. |
| **External effect** | Any write visible outside this process: a marker post, or the dispatched operation itself. |
| **Write-ahead** | A committed local state change that *precedes* the external effect it describes, so a crash leaves a record that the effect *may* exist. |
| **Evidence** | An authenticated marker (#777 §7) that also passes this document's payload and ordering validation (§10). Nothing else is evidence. |
| **Ledger regression** | Provider evidence that describes more execution than the local ledger records (§11). The signature of a restore, a lost write, or a rolled-back row. |
| **Fenced** | A scope in which no dispatch may occur, and every non-terminal row has been moved to `ambiguous`, until an operator clears it (§12). |
| **Epoch** | A monotonically increasing per-session counter, bumped in the same transaction as every write-ahead and mirrored outside the database (§9.2). |

## 3. What the provider can and cannot give

Every guarantee in §4 is derived from this table, which describes the two
supported work-item providers as they exist today. Nothing here is
aspirational.

| Capability | Available? | Consequence |
| --- | --- | --- |
| Transaction spanning local state and a provider write | **No** | Exactly-once dispatch is unachievable by construction (§4). |
| Idempotency key or conditional-create on comment POST | **No** | A retried marker post can produce a second marker; multiplicity is data, not an error, and §11 judges it against `attempts`. |
| Durable, authenticated author identity on every comment | **Yes** | Markers can be authenticated (#777 §7) and forged markers are inert (§10.3). |
| Comments readable in a total order, completely (#781) | **Yes** | Evidence can be gathered without a page boundary hiding half of it. |
| Comment deletion by a repo administrator | **Possible** | Evidence can vanish after the fact. This is the residual hole the epoch witness (§9.2) exists to backstop. |
| Read-after-write visibility guarantee | **Not documented** | Absence of a marker is trusted only after a quiescence delay (§10.4). |
| Second-precision timestamps | **Yes, only second** | Ordering uses #781 §3's total order key, never a timestamp alone. |
| Server-side "has this operation already run" query | **No** | Reconciliation is evidence-based and best-effort, never authoritative. |

**Pinned assumption.** That a comment posted by this automation and
successfully acknowledged by the provider becomes visible to a subsequent
complete scan within `CHATOPS_EVIDENCE_QUIESCENCE_MS` (§10.4) is read from
provider documentation and general behavior, not verified against a live
endpoint by this issue. It is stated here so a later change is a documented
contract violation rather than a silent duplicate execution.

## 4. Guarantees, stated exactly

Four different guarantees are in play and this document keeps them separate,
because collapsing them is how PR #776's draft ended up promising something
impossible.

- **Local ledger transitions are exactly-once.** Every state change in §7 is a
  compare-and-set inside one SQLite transaction, keyed by the ledger scope and
  guarded on the expected current state. Two concurrent workers cannot both
  advance the same row, and a replayed transition is a no-op. This is a real
  exactly-once guarantee because it is entirely local.
- **Dispatch of an external effect is at-most-once, not exactly-once.** A
  command is dispatched at most one time *unless an operator explicitly
  authorizes another attempt* (§13.2). There is deliberately **no
  at-least-once guarantee**: a command whose execution status cannot be
  determined ends in `ambiguous` and may never run at all. Preferring "never
  ran" over "might have run twice" is the central trade of this contract, and
  it is the only choice consistent with the capability table in §3.
- **Retry is deduplicated, not redelivery.** An automatic retry occurs only
  when the previous attempt is *positively proven* to have produced no
  external effect (§10.4). It reuses the same ledger row and increments the
  same `attempts` counter, so it is one delivery that started twice, not two
  deliveries. Retry on unproven state is forbidden — that is the "silent
  replay path" the acceptance criteria rule out.
- **Provider reconciliation is best-effort.** It depends on markers still
  existing and still being readable. An administrator can delete a marker; a
  provider outage can make the window incomplete. When reconciliation cannot
  reach a verdict, the ledger fails closed (§11.3, §12) rather than guessing.

**Not offered, explicitly:** cross-system atomicity, exactly-once execution,
guaranteed execution, and any claim that a local idempotency key alone
survives a restore. #778 and PR #776 implied the last one; this document
retracts it.

## 5. The ledger row

```ts
interface ChatOpsLedgerRow {
  commentId: string;                       // the ledger scope's third component
  state: ChatOpsLedgerState;               // §6
  outcome: ChatOpsMarkerOutcome | null;    // "executed" | "rejected" | "error", once known
  attempts: number;                        // dispatch attempts begun (write-aheads committed)
  epoch: number | null;                    // the epoch stamped by the last write-ahead (§9.2)
  attemptStartedAtMs: number | null;       // instant of that write-ahead — the quiescence anchor (§10.4)
  ackPublication: ChatOpsAckPublication;   // "not-required" | "pending" | "published" | "abandoned"
  ackAttempts: number;                     // marker-publication attempts
  reconcileAttempts: number;               // inconclusive reconciliation passes (§11.3)
  evidence: readonly ChatOpsEvidenceRef[]; // bounded refs, §14
  evidenceTruncated: boolean;              // true when more markers existed than were kept
  evidenceClaims: number;                  // exact claim-marker count — never truncated (§11.1)
  evidenceAcks: number;                    // exact ack-marker count — never truncated (§11.1)
  handoff: ChatOpsLedgerHandoff | null;    // set exactly when state is "ambiguous" (§13.3)
  detail: string | null;                   // bounded operator-facing detail, §14
}
```

The row deliberately stores **no copy of the comment body, author, or
timestamps**. Those are the first-seen record's job (#781 §9), that record is
write-once, and duplicating it here would create a second version of a fact
that must have exactly one. A ledger row is meaningless without its first-seen
row, and §15 requires both to be retained together.

`attempts` is the load-bearing counter, not a diagnostic: §11 compares it
against how many claim markers the provider shows, and that comparison is the
whole restore detector. It is incremented in the write-ahead transaction —
before the effect — never after.

## 6. States

| State | Kind | Meaning | External effect possible? |
| --- | --- | --- | --- |
| `claimed` | claim | Durable intent. This session owns execution of this comment; nothing external has been attempted. | No — never, in this state |
| `dispatching` | dispatch | Write-ahead committed. An external effect may be in flight, may have completed, may never have started. | Yes — the only state one may start from |
| `awaiting_ack` | acknowledgement | A definite outcome is durably recorded locally; the provider-visible ack marker is not yet published. | Yes, but only the marker post |
| `retry_scheduled` | retry | The previous attempt is proven to have had no external effect; one more attempt is permitted (§13.1). | No, until it re-enters `dispatching` |
| `rejected` | terminal | Terminal without ever dispatching: a recognition refusal, bootstrap backlog, or a fence encountered before any attempt. | No |
| `acknowledged` | terminal | Terminal with a known outcome and the ack marker published — or publication permanently abandoned and recorded as such. | No |
| `ambiguous` | terminal for automation | Execution status is undecidable. Automation will never dispatch this row again; an operator decides (§13.3). | No |

`rejected` and `acknowledged` are both terminal but are not interchangeable.
`rejected` asserts *no operation ever ran*; `acknowledged` asserts *an
operation ran and this was its outcome*. Merging them would erase exactly the
distinction a post-incident reader needs, and would let a refused comment be
mistaken for a successful execution.

**Every `acknowledged` row has settled its marker.** `acknowledged` is
reachable only with `ackPublication` at `"published"` (rows 10 and 17) or
`"abandoned"` (row 19, which raises a handoff for exactly that reason). No
transition may make a row terminal while its publication is still `"pending"`
or `"not-required"`: `ack-published` is accepted only from `awaiting_ack`, so
such a row could never publish its marker afterwards, and a resolved row with
no published marker is invisible to every future reconciliation (§11.4). This is
why an operator resolution (row 21) lands in `awaiting_ack` rather than
directly in `acknowledged` — the human decided the outcome, but the marker
that makes it provider-visible still has to be posted.

**Terminal means terminal.** `rejected`, `acknowledged`, and `ambiguous` rows
are never re-opened by any automatic path. `ambiguous` is re-openable only by
the explicit, recorded operator transitions in rows 21 and 22 — which is the
difference between an escape hatch and a silent replay path.

## 7. Transition table

Every legal transition is a numbered row. Anything not in this table is
refused, and a refusal is recorded (§14) rather than ignored. Rows are the
contract's citable identifiers: `applyChatOpsLedgerEvent` returns the row
number it applied or refused under.

| # | From | Event | To | Rule |
| --- | --- | --- | --- | --- |
| 1 | *(no row)* | `claim` — a dispatchable candidate, scope not fenced | `claimed` | Written in T1 (§8) together with the first-seen row and the cursor advance. |
| 2 | *(no row)* | `refuse` — recognition refusal, bootstrap backlog, ChatOps disabled, or a marker comment | `rejected` | Terminal immediately; no external effect will ever be attempted for this comment. |
| 3 | *(no row)* \| `claimed` \| `retry_scheduled` | `claim` or `begin-dispatch` while the fence scope is fenced | *unchanged* | Refused. A fenced scope writes no new claims and starts no attempt — a claim is a promise to dispatch, and a fenced scope may not. |
| 4 | `claimed` | `claim` again (duplicate observation after restart) | `claimed` | Idempotent no-op. One row per ledger scope, forever. |
| 5 | `rejected` \| `acknowledged` \| `ambiguous` | `claim` again | *unchanged* | Refused. A terminal row is never re-claimed, whatever rediscovery says. |
| 6 | `claimed` | `begin-dispatch` | `dispatching` | T2 write-ahead (§9.1): `attempts += 1`, epoch bumped, committed **before** any external call. |
| 7 | `claimed` \| `dispatching` \| `awaiting_ack` \| `retry_scheduled` | `escalate` | `ambiguous` | Explicit escalation of any non-terminal row; `handoff` is required. Also the row a refusal cites when an event is simply not legal from the current state. |
| 8 | `dispatching` | `dispatch-result(outcome)` | `awaiting_ack` | The operation returned a definite result. T3 (§8) records the outcome before the ack marker is posted. |
| 9 | `dispatching` | `reconciled(no-effect)` — no claim marker after quiescence | `retry_scheduled` | The only proof of no external effect (§10.4). `attempts` is not reset. |
| 10 | `dispatching` | `reconciled(acked outcome)` — claim and ack markers both present | `acknowledged` | The world already carries the outcome and the marker; nothing is re-posted. |
| 11 | `dispatching` | `reconciled(claim-only)` — claim marker present, no ack marker | `ambiguous` | The operation may have run, partially or fully. No automatic re-dispatch, ever. |
| 12 | `dispatching` | `reconciled(inconclusive)` — window incomplete, or quiescence not yet elapsed | `dispatching` | `reconcileAttempts += 1`. Unchanged state; the scan is simply retried. |
| 13 | `dispatching` | `reconciled(inconclusive)` with `reconcileAttempts` at `CHATOPS_MAX_RECONCILE_ATTEMPTS` | `ambiguous` | Bounded, then surfaced. Reconciliation never loops forever. |
| 14 | `dispatching` | `begin-dispatch` | *unchanged* | Refused. Re-entering dispatch without a verdict is precisely the silent replay this contract forbids. |
| 15 | `retry_scheduled` | `begin-dispatch` with `attempts < CHATOPS_MAX_DISPATCH_ATTEMPTS` | `dispatching` | A deduplicated retry (§4), not a redelivery. |
| 16 | `retry_scheduled` | `begin-dispatch` with `attempts` at the cap | `awaiting_ack` (`outcome: "error"`) | Exhaustion is a definite negative outcome — the operation provably never ran — so it is acknowledged, not left ambiguous. |
| 17 | `awaiting_ack` | `ack-published` | `acknowledged` | `ackPublication: "published"`. The row's evidence is now durable on the provider. |
| 18 | `awaiting_ack` | `ack-publish-failed` with `ackAttempts < CHATOPS_MAX_ACK_PUBLICATION_ATTEMPTS` | `awaiting_ack` | `ackAttempts += 1`. The outcome is already durable locally; only its publication is retried. |
| 19 | `awaiting_ack` | `ack-publish-failed` at the cap | `acknowledged` (`ackPublication: "abandoned"`) | Terminal, **and** an operator handoff is raised: a row with no published ack is invisible to any future reconciliation (§11.4). |
| 20 | `claimed` \| `dispatching` \| `awaiting_ack` \| `retry_scheduled` | `fence(reason)` | `ambiguous` | Fencing a scope (§12) moves every non-terminal row at once. `handoff` records the fence reason. |
| 21 | `ambiguous` | `operator-resolve(outcome, operator)` | `awaiting_ack` (`ackPublication: "pending"`, `ackAttempts: 0`) | An explicit, recorded human decision about what actually happened. Never inferred; refused without a nonblank operator identity. It lands in `awaiting_ack`, not `acknowledged`, so the decision still gets a provider-visible marker (§6); rows 17-19 then take it terminal. |
| 22 | `ambiguous` | `operator-retry(operator, reason)` | `retry_scheduled` | An explicit, recorded human authorization to attempt again, having judged the duplicate-execution risk. Refused unless **both** a nonblank identity and a nonblank reason are supplied; both are composed into the row's durable `detail` (§13.2). `attempts` is preserved, so §11's evidence comparison stays honest. |
| 23 | `acknowledged` \| `rejected` | any event | *unchanged* | Refused. There is no path out of a fully terminal row. |
| 24 | *(no row)* | evidence exists naming this comment | *(no row)* | Refused, **and the fence scope is fenced** (§11.2): the world records execution the ledger has no memory of. |

A refusal cites the row it was refused under. When no row applies at all — an
event that needs an existing row sent without one, which is a caller defect —
the reported number is `CHATOPS_NO_CONTRACT_ROW` (0); contract rows are
numbered from 1, so the sentinel can never collide with one.

Rows 9, 10, 11, 12, and 13 are the entire crash-recovery surface for a row
caught mid-dispatch, and exactly one of them applies to any given
reconciliation pass. There is no default, no "assume it failed", and no path
from `dispatching` back to `dispatching`-with-a-fresh-attempt.

## 8. Transaction boundaries

Four local transactions, and the external effects that sit between them.
Nothing external is ever inside a transaction; nothing local straddles one.

- **T1 — discovery commit.** The first-seen inserts and cursor advance #781
  §12 already requires to be atomic are extended to include **one ledger row
  for every candidate in the window** (row 1 or row 2). This is a single
  transaction. Its purpose is a strong postcondition: *every comment at or
  below the cursor has exactly one ledger row.* Committing the cursor without
  the rows would let a restart find a comment that is neither a candidate
  (its first-seen record exists) nor tracked (no ledger row) — a permanently
  invisible command, which is the failure #781 §1 exists to prevent, moved one
  layer down.
- **T2 — write-ahead.** `→ dispatching` (row 6 or 15): increment `attempts`,
  stamp the epoch, commit. **Nothing external may happen before this commit
  returns.** The mirrored epoch witness write (§9.2) happens immediately
  after this commit and before the first external call.
- **T3 — outcome commit.** `dispatching → awaiting_ack` (row 8): the
  operation's definite result recorded locally, committed **before** the ack
  marker is posted. Posting first and recording second would leave a crash
  window in which the world has an ack the ledger cannot explain.
- **T4 — publication commit.** `awaiting_ack → acknowledged` (rows 17, 19),
  after the marker post returns.

The external effects, in order, for one attempt:

1. Post the claim marker `<!-- chatops-claimed:<id> -->` (#777 §7).
2. **Only if step 1 returned success**, invoke the operation.
3. Post the ack marker `<!-- chatops-ack:<id>:<outcome> -->`.

Step 2's precondition is what makes §10.4's proof work: because the claim
marker is always posted first and its success confirmed before the operation
starts, the *absence* of a claim marker over a complete, quiesced window
proves the operation never began. Reversing steps 1 and 2 — or posting the
claim marker fire-and-forget — would destroy the only negative evidence this
system has, and with it every automatic retry in row 9.

A failure of step 1 that leaves an *unconfirmed* post (a timeout, a dropped
connection) is not treated as "no marker": it is inconclusive, resolved by
reconciliation like any other mid-dispatch crash, via rows 9–13.

## 9. The dispatch attempt protocol

### 9.1 Write-ahead before effect

An attempt begins with T2 and ends with T4. Between them the row is
`dispatching` or `awaiting_ack`, and both states mean "an external effect may
exist." A process that starts up and finds a row in either state **never
resumes the attempt from where it left off** — it reconciles (§11) and takes
whichever of rows 9–13 the evidence supports, or (for `awaiting_ack`) resumes
only the idempotent-enough part, marker publication, per row 18. Resuming an
operation mid-flight is impossible to do safely without knowing where it
stopped, and nothing local records that.

### 9.2 The epoch witness

Marker evidence has one hole: a repository administrator can delete a comment,
including a marker. A restore combined with a deleted claim marker would make
a previously-dispatched comment look brand new to both the ledger *and* the
reconciler. The epoch witness closes that hole without depending on the
provider at all.

- The database holds a per-session counter, `epoch`, incremented **inside
  every T2 transaction**. A dispatch therefore always carries a strictly
  greater epoch than every dispatch before it.
- Immediately after T2 commits, and **before** the first external call, the
  new value is mirrored to a small file outside the database — under the
  session's `artifactRoot`, which `docs/retention-backup-contract.md` §8's
  restore procedure replaces nothing of: restore swaps the DB file and its
  `-wal`/`-shm` sidecars, never the artifact tree.
- If the witness write fails, **the attempt is aborted before any external
  call** and the row returns to `retry_scheduled`. An effect whose epoch was
  never witnessed is an effect a future restore could not detect.
- At startup, and before any dispatch, the two are compared
  (`assessChatOpsLedgerEpoch`):

| Comparison | Verdict | Action |
| --- | --- | --- |
| `dbEpoch === witnessEpoch` | `consistent` | Normal operation. |
| `dbEpoch > witnessEpoch` | `witness-behind` | Benign: a crash between T2 and the mirror write. The witness is rolled forward to `dbEpoch`; no fence. A restore can never make the database *ahead* of the witness. |
| `dbEpoch < witnessEpoch` | `restore-detected` | **Every scope for this session is fenced** (§12). The database has less dispatch history than the filesystem witnessed. |
| witness absent, `dbEpoch === 0` | `consistent` | A session that has never dispatched has nothing to protect. |
| witness absent, `dbEpoch > 0` | `witness-missing` | Fenced. Includes the legitimate case of a repointed `artifactRoot` (`docs/retention-backup-contract.md` §8), which an operator clears by re-seeding the witness deliberately. |

The asymmetry is deliberate and is why the write order is DB-then-witness: a
crash in the gap can only produce `witness-behind`, which is safe to self-heal,
while the dangerous direction (`dbEpoch < witnessEpoch`) has no benign cause.
The reverse order would make every crash indistinguishable from a restore and
fence the session constantly, which would train operators to clear fences
reflexively — the worst possible outcome for a fail-closed control.

## 10. Authenticated reconciliation evidence

### 10.1 Authentication is necessary but not sufficient

#777 §7 defines an **authenticated** marker: a body that is trimmed-exactly one
of the canonical forms, from an author in `chatOps.automationLogins`. #781 §5.1
indexes those over a complete window. Neither answers the question this layer
asks, which is not "is this a marker" but "**is this marker evidence about this
specific ledger row**". A marker passes into evidence only when all of the
following hold:

1. It is authenticated per #777 §7 — exact canonical body, automation author.
2. Its embedded `<id>` names a comment **this scope knows** — present in the
   window being reconciled, or backed by a first-seen record (#781 §9). A
   marker naming an id the scope has no record of is a defect
   (`unknown-target`), not evidence: it either targets another scope's comment
   or a comment that has been deleted, and in both cases it cannot be matched
   to a row. Resolution is injected (`resolveTarget`) rather than read from a
   store, so the rule stays pure and the caller decides which of the two
   sources answers.
3. The marker comment's own order key (#781 §3) sorts **strictly above** its
   target's. A marker cannot precede the comment it acknowledges; one that
   does is a defect (`evidence-precedes-target`).
4. Its outcome, for an ack marker, is one of #777 §7's closed set. Parsing
   already enforces this; it is restated because "expected payload" means the
   whole payload, not just the id.

Evidence collection is `collectChatOpsExecutionEvidence`, and it reports
multiplicity — how many claim markers and how many ack markers name each
target — where #781's index reports only existence. Multiplicity is the input
to §11's regression test, so collapsing it into a boolean would discard the
restore detector.

### 10.2 Conflicting evidence

Two ack markers naming the same target with different outcomes is a
`conflicting-outcome` defect. It is never resolved by preferring one (neither
"first wins" nor "worst wins" is defensible — both markers are authentic, and
the conflict means something upstream went wrong). The affected row goes to
`ambiguous`; the scope is not fenced, because a conflict is scoped to one
comment and does not imply the ledger as a whole is behind.

### 10.3 Forged and look-alike markers are inert

A comment that resembles a marker but comes from an author outside
`automationLogins` is not authenticated (#777 §7), is not collected, and
therefore:

- cannot suppress a command,
- cannot mark a row acknowledged,
- **cannot fence a scope.** This second property matters as much as the first:
  a fence is a denial-of-service if an untrusted commenter can trigger one.
  Because fencing is driven only by collected evidence, and collection
  requires automation authorship, no commenter can fence anything.

**This contract additionally requires `chatOps.authorAllowlist` and
`chatOps.automationLogins` to be disjoint**, validated at session load
(`validateChatOpsLoginSeparation`). #777 §5 keeps the lists separate in
*meaning* but does not forbid overlap; once markers become evidence that can
fence a scope and mark a row terminal, an overlapping login would let a human
command author post markers that authenticate. The requirement changes no
recognition behavior — it only removes a forgery path this layer would
otherwise open.

### 10.4 Absence as proof, and the quiescence delay

Row 9 — the only automatic retry — rests on a negative claim: *no claim marker
exists, therefore the operation never began*. That claim is sound only when:

- the scan window is **complete** in #781 §5's sense (an incomplete window
  proves nothing about absence), and
- at least `CHATOPS_EVIDENCE_QUIESCENCE_MS` (60 000 ms) has elapsed since the
  attempt's write-ahead, so a marker posted just before the crash has had time
  to become visible to a read, and
- no attempt for this scope is in flight, which the issue-scoped lock this
  codebase already uses for per-issue serialization guarantees.

Before quiescence elapses the verdict is `inconclusive` (row 12), not
`no-effect`. Treating a too-fresh absence as proof would convert provider read
lag into duplicate execution, which is the one failure mode this whole
document is arranged against.

The delay is therefore a **floor, not a default**. Reconciliation accepts an
override only to *raise* it; a non-finite value, or any value below
`CHATOPS_EVIDENCE_QUIESCENCE_MS`, is rejected outright rather than clamped, so
a caller that meant to shorten the window fails loudly instead of quietly
buying itself a duplicate execution. Tests that need a shorter wait move the
injected `nowMs` forward, which is the same arithmetic without weakening the
guard for production callers.

### 10.5 The reconciliation window is not the cursor window

A discovery scan reads from the cursor's loose lower bound (#781 §6.1), so its
window contains only comments **above the cursor**. A marker for an attempt
made several scans ago has by then fallen below the cursor and would be absent
from a discovery window — and absence is exactly what row 9 reads as proof.
Reconciling from a discovery window would therefore manufacture
"proven-no-effect" verdicts for attempts whose markers are alive and well one
page lower.

Two rules close that, and both are required:

- **A reconciliation pass scans from its own lower bound**,
  `chatOpsReconciliationSinceBound(rows)`: one second below the earliest
  write-ahead among the scope's non-terminal rows, or the cursor bound when
  there are none. Every open attempt's markers are then inside the window by
  construction, using the same one-second margin and the same argument #781
  §6.1 gives for the cursor's bound. A scope with no open rows needs no
  widened scan.
- **Collected evidence is persisted onto the row** (§14) the first time it is
  seen. Evidence that has scrolled below a later bound is not re-derived from
  the provider; it is remembered. Persisted refs are additive — a later pass
  may add refs and raise counts, never lower them, because "the marker
  disappeared" (deletion) must not read as "the attempt never happened".

## 11. Reconciliation and ledger regression

`reconcileChatOpsLedgerScope` runs over a **complete** window (#781 §5) plus
the scope's ledger rows, before any dispatch in that scope, and produces one
verdict per comment plus a scope-level decision.

### 11.1 The regression predicate

For a target comment, let `claims` and `acks` be the number of collected claim
and ack markers naming it, and `attempts` the row's counter (0 when there is no
row). The ledger has **regressed** when:

```
claims > attempts   ||   (acks > 0 && attempts === 0)
```

Both halves follow from §8's ordering. Every attempt posts exactly one claim
marker before doing anything else, so in a consistent ledger `claims <=
attempts` always holds; more claim markers than attempts means attempts were
lost. The second half covers the case where the claim marker was deleted but
the ack marker survives: an ack with no local attempt at all is equally
impossible.

`claims` and `acks` are the **monotonic** counts: the larger of what this pass
observed and what the row already carries (§10.5). A marker deleted between
two passes therefore lowers nothing, which keeps deletion from being a way to
un-fence a scope.

The predicate is deliberately one-directional. `attempts > claims` is **not** a
regression: it is the normal shape of an attempt whose marker post failed
(row 9's proven-no-effect case), and of an attempt whose marker was deleted
after the fact. The ledger being *ahead* of the world is safe; the world being
ahead of the ledger is not.

### 11.2 What a regression does

Any regression fences the entire fence scope (§12), not just the row that
tripped it. A restore does not roll back one row — it rolls back everything
committed after the backup — so the one comment whose markers happened to
survive is a sample, not the extent of the damage. Fencing per row would leave
its neighbours free to re-dispatch on exactly the state that was just proven
untrustworthy.

Row 24 is the no-row form of the same rule and is the specific case the issue
names as "database restore predating a successful dispatch": evidence naming a
comment the ledger has never heard of.

### 11.3 Missing or incomplete reconciliation data

Reconciliation requires a complete window. If the scan was incomplete for any
of #781 §11's reasons, **no reconciliation verdict is produced and no dispatch
occurs in that scope** — the rows stay exactly where they are, and rows in
`dispatching` take row 12. Repeated inconclusive passes are bounded by
`CHATOPS_MAX_RECONCILE_ATTEMPTS` (3) and then surface as `ambiguous` (row 13).
Fail-closed here means *stall*, not *guess*: a stalled scope executes nothing,
which is recoverable, while a guessing scope executes twice, which is not.

### 11.4 An abandoned publication is a permanent evidence gap

Row 19 produces a terminal row whose outcome was never published. Every future
reconciliation of that comment will see `claims >= 1` and `acks === 0`, which
is exactly the shape of row 11 — but the row is already terminal, so it is
never re-dispatched. What is lost is the ability of a *future restore* to
detect that this comment executed via its ack marker; only the claim marker
and the epoch witness remain. This is why row 19 raises an operator handoff
even though the row itself is terminal and locally complete.

## 12. Database restore

Restore is a manual, out-of-loop operator action
(`docs/retention-backup-contract.md` §8). This contract adds no automated
restore path and no automatic recovery from one. What it adds is detection and
a fence.

**On restore, the following is true and cannot be undone:** the ledger now
describes less execution than actually happened. Rows that were `acknowledged`
may be back to `claimed`, `dispatching`, or absent; the cursor may be below
comments already executed; first-seen records may be gone, so those comments
are candidates again.

**The fence.** A fenced scope:

- writes no new claims (row 3),
- dispatches nothing, for any row, at any state,
- moves every non-terminal row to `ambiguous` with the fence reason recorded
  (row 20),
- keeps scanning and keeps recording first-seen rows and cursor progress —
  discovery is safe and stopping it would only add a backlog to untangle
  later,
- still lets an `awaiting_ack` row publish its marker (rows 17-19) — in a
  fenced scope that means the rows an operator has settled with row 21, since
  row 20 has moved everything else to `ambiguous`. The fence bars *new
  execution*, not the evidence of execution that already happened; suppressing
  that evidence would blind the very reconciliation the fence exists to
  protect (§11.4),
- is cleared only by an explicit operator action that names the scope and is
  recorded durably. There is no timeout, no retry budget, and no automatic
  clear: a fence that expires on its own is a silent replay path with a
  delay.

**Both detectors run, independently.** §9.2's epoch witness fences at session
grain and catches restores whose markers were deleted; §11's regression
predicate fences at issue grain and catches restores whose witness was lost or
whose artifact tree was repointed. Neither is sufficient alone, and requiring
both to agree before fencing would weaken the whole mechanism to the strength
of its weaker half.

**What an operator does with a fenced scope.** They read the ledger rows and
the issue's markers, decide per comment what actually happened, and apply
row 21 (resolve to a known outcome) or row 22 (authorize another attempt).
That decision needs the evidence, so §14 requires the evidence to be stored on
the row rather than reconstructed from logs.

## 13. Retry and human handoff

### 13.1 Automatic retry

An automatic retry requires all of:

- the row is in `retry_scheduled`, reached only via row 9's proven-no-effect
  verdict or an operator authorization (row 22),
- `attempts < CHATOPS_MAX_DISPATCH_ATTEMPTS` (3),
- the fence scope is not fenced,
- the epoch assessment is `consistent` or `witness-behind`.

Exhausting the attempt cap is a *definite* outcome, not an ambiguous one — the
operation provably never started on any attempt — so row 16 acknowledges it
with outcome `error` rather than escalating. An operator sees it in the ack
marker on the issue, which is the correct surface for "your command did not
run."

### 13.2 Operator-authorized retry

Row 22 is the only way a command that *may* have executed is ever dispatched
again. It requires a recorded operator identity and reason, it preserves
`attempts` (so §11's evidence comparison stays honest afterwards), and it is
never triggered by a timer, a restart, or a config flag. This is the sole
sanctioned replay path in the contract, and it is not silent.

Both halves of that record are **mandatory and enforced**, not conventional:
`operator-retry` carries a required `operator` and a required `reason`, each
refused when blank (`operator-record-required`), and the applied transition
composes both into the row's durable `detail` — `retry authorized by
<operator>: <reason>`. Neither half is recoverable after the fact, and a
replay path whose authorization cannot be attributed afterwards is
indistinguishable, in the incident review, from the silent one this contract
forbids. Row 21 enforces the identity half on the same grounds.

### 13.3 Human handoff

`ambiguous` is where every undecidable outcome lands: mid-dispatch crash with a
claim marker (row 11), bounded-inconclusive reconciliation (row 13), a fence
(row 20), or conflicting evidence (§10.2). The row carries a `handoff`:

```ts
interface ChatOpsLedgerHandoff {
  reason: ChatOpsLedgerHandoffReason;  // closed set, §14
  detail: string | null;               // bounded
  fenceScope: boolean;                 // true when the whole scope is fenced, not just this row
}
```

An ambiguous row surfaces to the operator through the same parked,
human-visible task state this codebase already uses for work that cannot
proceed without a decision (`ready_for_human`). Wiring the ledger into task
routing is the dispatch port's job (§19), not this document's; what this
document fixes is that the ledger must *never* resolve an ambiguity by acting.

## 14. Bounded evidence and observability

Everything the ledger stores for an operator is bounded, because the inputs are
attacker-influenced (a comment thread anyone with issue access can grow) and an
unbounded row is a denial-of-service surface — the same posture #777 §10 takes
for comment bodies.

- **Evidence refs.** At most `CHATOPS_MAX_EVIDENCE_REFS` (8) per row, each a
  fixed-shape `{ markerCommentId, kind, outcome, createdAt }`. When more
  markers exist, the **first** refs are retained (they are the ones nearest the
  attempt, and thus the ones that explain it) and `evidenceTruncated` is set,
  so a truncated view never reads as a complete one. Counts (`claims`,
  `acks`) are always exact, because §11's predicate depends on them and a
  truncated count would silently disarm the restore detector.
- **Detail strings.** Truncated to `CHATOPS_LEDGER_DETAIL_MAX_CHARS` (500),
  with the truncation marked. No comment body is ever copied into a detail
  string; the first-seen record already holds it (#781 §9).
- **Handoff reasons are a closed set**, not free text:
  `dispatch-crash-unresolved`, `reconcile-inconclusive`, `ledger-regression`,
  `restore-detected`, `witness-missing`, `conflicting-evidence`,
  `ack-publication-abandoned`, `operator-escalation`.
- **Observability events.** One event per applied transition, named
  `chatops.ledger.<transition>` and carrying the row number (§7) it applied
  under, plus `chatops.ledger.fenced` / `chatops.ledger.fence-cleared` at scope
  grain. Refusals are events too (`chatops.ledger.refused`): a transition that
  was attempted and denied is exactly the signal an operator needs when a
  command "does nothing", and dropping it would make the fail-closed behavior
  indistinguishable from a hang.

## 15. Persistence requirements

This document defines no schema — the implementation issue that adds the
`chatops_*` tables does — but it fixes what that schema must satisfy, on top of
`docs/chatops-identity-contract.md` §7 and #781 §12:

- **One ledger row per ledger scope, enforced by the primary key**
  `(session_id, provider, provider_endpoint, provider_owner, provider_repo,
  issue_number, comment_id)` as separate typed columns, never an opaque joined
  string. Uniqueness is what makes row 4 an idempotent no-op rather than a
  race.
- **Every transition is a guarded compare-and-set** on the expected current
  state within one transaction. A blind `UPDATE … SET state = ?` would let two
  workers both advance a row, and "both advanced it" is "both dispatched it".
- **T1 is one transaction** spanning first-seen rows, cursor advance, and
  ledger rows (§8).
- **The epoch counter lives in the database and is bumped inside T2**, never in
  a separate transaction, and never derived from a clock.
- **Ledger rows and first-seen rows are retained together.** A retention policy
  that prunes one must prune the other, for the reason #781 §12 already gives
  in the other direction: a ledger row without its first-seen record cannot be
  explained, and a first-seen record without its ledger row reads as "never
  executed".
- **The fence is a durable row**, not process state — `(fence scope, reason,
  raisedAt, clearedAt, clearedBy)`. A fence that lives only in memory is
  cleared by a restart, which is precisely the event most likely to have caused
  it.
- **The epoch witness file is exempt from artifact retention sweeps.** Pruning
  it converts a protected session into a `witness-missing` fence at best, and
  removes the deleted-marker backstop at worst.
- **A field-set change orphans, never reinterprets.** Same rule as #780 §7,
  #781 §12, and `docs/outbox-scan-cursor-contract.md` §4.1.

## 16. Invariants

**L1 — One ledger row per comment, forever.** Enforced by the primary key
(§15); rediscovery after a restart is row 4, not a second row.

**L2 — Every comment at or below the cursor has a ledger row.** T1 commits the
rows with the cursor advance (§8), so no comment can be simultaneously
"already observed" and "untracked".

**L3 — No external effect precedes its write-ahead.** Every effect happens in
`dispatching` or `awaiting_ack`, and both are entered by a committed
transaction (T2, T3).

**L4 — A retry happens only on proof of no effect.** Row 9 is the only
automatic path into `retry_scheduled`, and it requires a complete, quiesced
window with no claim marker (§10.4). Row 22 is the only other path, and it is
an explicit human decision.

**L5 — The ledger is never behind the world without fencing.** `claims >
attempts` or an ack with no attempt fences the scope (§11.1), as does
`dbEpoch < witnessEpoch` (§9.2).

**L6 — Terminal states are never re-opened automatically.** Rows 5 and 23
refuse; only rows 21 and 22 move an `ambiguous` row, and both require a
recorded operator.

**L7 — Unauthenticated input changes nothing.** A forged or look-alike marker
is not collected, so it cannot acknowledge, suppress, or fence (§10.3).

**L8 — Ambiguity is surfaced, never resolved by acting.** Every undecidable
state ends in `ambiguous` with a handoff (§13.3); no code path dispatches on
an unresolved ambiguity.

**L9 — Local transitions are exactly-once; external dispatch is at-most-once.**
§4, and the two are never conflated in any message, event, or field name.

**L10 — No row becomes terminal owing an unpublishable marker.** `acknowledged`
is entered only with `ackPublication` at `"published"` or `"abandoned"` (§6);
a decision that still owes a marker waits in `awaiting_ack`, where rows 17-19
can still publish it or record its abandonment.

## 17. Behavior in the required scenarios

### 17.1 Crash after claim but before dispatch

The row is `claimed`, `attempts` is 0, and §8's ordering guarantees no external
effect exists. Restart finds it, reconciles (finding no evidence, consistent
with `attempts === 0`), and takes row 6 — a first dispatch, not a retry. This
is the one crash point that is completely safe, and it is safe *because* T2 is
a separate, later transaction than T1.

### 17.2 Crash after dispatch but before acknowledgement persistence

The row is `dispatching` with `attempts >= 1`. Restart never resumes it
(row 14 refuses). It reconciles, and exactly one of:

- no claim marker, window complete, quiescence elapsed → row 9,
  `retry_scheduled`; the operation provably never began (§8 step 2's
  precondition),
- claim marker but no ack marker → row 11, `ambiguous`; the operation may have
  run, and nothing automatic will touch it again,
- claim and ack markers → row 10, `acknowledged`, adopting the marker's
  outcome; the world already has both the effect and its record,
- window incomplete or too soon → row 12, then row 13 once bounded.

### 17.3 Database restore predating a successful dispatch

Two independent detectors fire (§12). The epoch witness under `artifactRoot`
survives the restore and reports a higher epoch than the restored database
(`restore-detected`), fencing every scope for the session. Independently, the
next complete scan of the affected issue collects the claim/ack markers the
dispatch left behind and finds `claims > attempts` — or, for a row the restore
erased entirely, evidence naming a comment with no row at all (row 24) —
fencing that scope. Nothing dispatches; every non-terminal row becomes
`ambiguous` with reason `restore-detected` or `ledger-regression`; an operator
resolves per comment via rows 21 and 22.

### 17.4 Forged acknowledgement marker from an untrusted author

Not authenticated (#777 §7), so not collected (§10.1) and not evidence. It
does not acknowledge the command it names, does not suppress it, and does not
fence the scope (§10.3). If the forged comment is itself a well-formed command
from an allowlisted author, it is recognized normally under #777 §2–§6 and
gets its own ledger row. The disjointness requirement (§10.3) ensures a command
author can never be an automation author, so no allowlisted human can produce
an authentic marker either.

### 17.5 Missing or incomplete provider reconciliation data

An incomplete window (#781 §11) produces no verdict and no dispatch in that
scope (§11.3). A `dispatching` row takes row 12 and stays put; after
`CHATOPS_MAX_RECONCILE_ATTEMPTS` inconclusive passes it takes row 13 and
surfaces as `ambiguous`. A `claimed` row simply waits — it has no external
effect to reconcile, and waiting costs only latency. Nothing advances on
partial data, in either direction.

### 17.6 Duplicate candidate observation after restart

Two mechanisms already dedupe discovery (#781 §10: the order key and the
first-seen record), and the ledger adds a third that is about *execution*: the
row's primary key. A re-observed comment with an existing row takes row 4 (no
change, no second row) or row 5 (terminal, refused). Duplicate observation is
therefore uninteresting by construction — which is exactly what lets the
interesting case, ledger regression (§11), be treated as the anomaly it is.

## 18. Test matrix

`test/chatops-execution-ledger.test.js` covers, at minimum:

| Area | Cases |
| --- | --- |
| Transitions (§7) | every numbered row applied once; every refused event returns a refusal with its row number; no event moves a fully terminal row. |
| Write-ahead (§8, §9.1) | `attempts` increments on entry to `dispatching`, not on exit; re-entering `dispatching` is refused. |
| Epoch (§9.2) | all five comparison verdicts; `witness-behind` self-heals without a fence; `witness-missing` with `dbEpoch === 0` does not fence. |
| Evidence (§10) | unknown-target, marker preceding its target, conflicting outcomes, non-automation author ignored, multiplicity counted exactly. |
| Regression (§11.1) | `claims > attempts` fences; `acks > 0 && attempts === 0` fences; `attempts > claims` does not; evidence with no row fences (row 24). |
| Quiescence (§10.4) | absence before the delay is inconclusive, after it is proof; incomplete window is never proof; an override below the floor, or a non-finite one, is rejected. |
| Operator decisions (§13.2) | row 21 leaves the row publishable and rows 17-19 can still take it terminal; row 22 refuses a blank identity or reason and records both. |
| Reconciliation window (§10.5) | the bound covers the earliest open write-ahead, not the cursor; persisted evidence counts never decrease when a marker disappears. |
| Retry (§13.1) | cap enforced; exhaustion acknowledges with `error`; retry refused while fenced. |
| Handoff (§13.3) | every ambiguous entry carries a closed-set reason; no ambiguous row dispatches. |
| Bounds (§14) | evidence refs truncated with a flag while counts stay exact; detail truncation. |
| Login separation (§10.3) | overlapping allowlist/automation logins rejected. |

`test/docs-chatops-execution-ledger-contract.test.js` pins this document's
transition table, guarantee wording, invariants, and required scenarios
against drift.

## 19. Explicit non-goals and forward pointers

This document defines the execution ledger and its replay behavior only. It
does not define, and nothing that implements it should assume:

- **The operation-dispatch port** — the callable interface an attempt invokes
  between §8's steps 1 and 3, which verbs exist, and what each may touch. That
  is the immediate successor, and it consumes `ChatOpsLedgerRow`,
  `applyChatOpsLedgerEvent`, and §7's row numbers exactly as defined here
  rather than re-deriving them. **Delivered (#783)**:
  `docs/operation-dispatch-port-contract.md` defines the port itself and, in
  its §9, the total mapping from an operation's typed result onto this
  document's events — including the one result shape that maps to *no* event
  (an indeterminate effect), which leaves the row `dispatching` for §11's
  reconciliation instead of guessing. Which verbs exist remains open (#784).
- **Polling** — when a scan or a reconciliation pass runs, and what triggers
  either.
- **The SQLite schema** — §15 fixes what it must satisfy; the implementation
  issue writes it.
- **Task routing** — how an `ambiguous` row parks a task as `ready_for_human`,
  and how an operator clears a fence from the admin CLI.
- **Comment scanning and cursor progression** — `docs/chatops-comment-cursor-contract.md`
  (#781), already implemented.
- **Command grammar and marker format** — `docs/chatops-command-grammar-contract.md`
  (#777), already implemented. A future revision that adds an attempt nonce to
  the marker payload would strengthen §11's regression predicate from "count
  comparison" to "identity comparison"; that revision is not proposed here,
  and §4's guarantees are stated for the marker format as it exists today.

That work is tracked by the executable chain this issue's predecessors head:
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships).
