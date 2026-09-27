# Merged-PR task reconciliation contract

Status: **approved design, operation core and operator command
implemented** (contract: issue #1046; core: issue #1047; command:
issue #1048). This document is the authoritative
contract for reconciling the authoritative merged state of a task's
**exact recorded pull request** back into the task lifecycle.
Implementation issues reference this specification and MUST NOT redefine
its policy; a change of policy is a change to this document first.

Issue #1046 delivered this document and its structural contract tests
(`test/docs-merged-pr-reconciliation-contract.test.js`) only, with no
runtime behavior. Issue #1047 added the callable operation core
(`src/core/merged-pr-reconciliation.ts`): the §7 decision over injected
provider/store/lock dependencies, the §8 atomic transition committed
through `TaskStore.completePhaseWithEffects`, and the §9 audit record.
Issue #1048 added the operator command (§17 slice 3),
`admin task reconcile-merged`: preview by default over one Issue or a
whole session, the §12.4 command-level provider refusal decided before
any task is read, and the §11 CAS wiring — all of it delegating every
decision to the core. The optional `PullRequest.mergeCommit` provider
field (§16) has not landed, so there is still no provider field and the
merge commit stays absent from every record.

## 1. The problem

A task can sit at `ready_for_human`, `blocked`, `queued`, or another
non-terminal status long after an operator has already merged its pull
request. Merging a PR on the repo host does not touch the SQLite task
row — the same gap issue #608 named for closed Issues, in the opposite
direction. It also happens in irregular recovery cases where the task
never reached the normal human-gate state before the merge: a run that
failed after pushing, a task cancelled while its PR was already open, a
task requeued for a fix that the operator instead merged by hand.

`admin worktree cleanup` deliberately treats in-flight and
awaiting-human tasks as active (`ACTIVE_TASK_STATUSES` =
`queued`/`claimed`/`running`/`blocked`/`ready_for_human`, in
`src/cli/admin.ts`) and refuses to remove their durable Issue
worktrees. That
safety rule is correct and this contract does not weaken it. The missing
piece is not a cleanup exception — it is an explicit contract for
reconciling an externally merged PR back into the task lifecycle,
decided from provider data and independent of any filesystem decision.

## 2. Scope

This document specifies, and an implementation built against it must not
redefine:

- what identifies the pull request a reconciliation is allowed to act on
  (§4);
- which external signal is authoritative (§5);
- when a task is safe to reconcile (§6);
- the outcome of **every** `TaskStatus`, in one normative table (§7);
- the applied transition and its atomicity (§8);
- the audit history and the single new task event (§9);
- preview/apply, staleness, and concurrency (§10, §11);
- the fail-closed conditions (§12);
- the mutation boundary — lifecycle metadata only (§13);
- that `admin worktree cleanup` is unchanged (§14).

It does **not** specify, and no implementation built against it may
assume:

- **Worktree lifecycle, cleanup classification, and the dirty-worktree
  policy** — fixed by `docs/per-issue-worktrees.md`. This contract
  changes no classification and adds no cleanup flag (§14).
- **Cancellation semantics** — fixed by issue #608
  (`TaskStore.cancelTask`, `admin task cancel`, `admin task
  reconcile-closed`). A merge is not a cancellation and never borrows
  its vocabulary (§15.1).
- **Post-create PR adoption** — fixed by `src/core/pr-reconciliation.ts`
  (issue #998), which decides whether a creation retry may adopt an
  already-open PR. It refuses anything that is not open; this contract
  refuses anything that is not merged. The two never call each other
  (§15.2).
- **The Human Gate** — fixed by `docs/human-gate-no-go-flow.md` (#747,
  design-only). The Human Gate is the *normal* route out of
  `ready_for_human`. This contract is the irregular-recovery route and
  must never displace it (§15.3).
- **Recovery of `claimed`/`running` rows** — fixed by `admin recover`
  and `TaskStore.recoverTask` (`RECOVERABLE_STATUSES` =
  `["failed", "claimed", "running"]`). Reconciliation defers to it and
  never races it (§6.3).
- **Tool Request resolution** — fixed by `admin tool-request
  resolve`/`grant` and `docs/unattended-tool-request-contract.md`
  (#677). Reconciliation refuses a task holding a live request (§6.4)
  and never closes, consumes, or reroutes one (§15.4).
- **Provider transport, authentication, and the repo-host factory** —
  fixed by `docs/provider-architecture.md`.

## 3. Closed vocabulary

Three closed sets. An implementation adds no member to any of them
without amending this document, and adds no `TaskStatus`, `TaskPhase`,
`PhaseRunOutcome`, or `PhaseHandlerResult` member at all.

**Outcomes.** `MergedPrReconciliationOutcome` is exactly:

`"reconciled" | "recorded-terminal" | "already-reconciled" |
"noop-done" | "active" | "refused"`

**Refusals.** `MergedPrReconciliationRefusal` is exactly (ten values):

`"missing-pr-identity" | "pr-lookup-failed" | "identity-mismatch" |
"not-merged" | "active-recovery-required" | "invalid-claim-metadata" |
"malformed-disposition-history" | "tool-request-unresolved" |
"stale-state" | "store-refused"`

**Command-level refusal.** One reason exists that is decided once, for
the whole invocation, before any task is examined:
`"unsupported-provider"` (§12.4).

## 4. PR identity is exact, recorded, and required

The unit of reconciliation is **the pull request this task recorded**,
never "the Issue", never "a PR that mentions the Issue".

- **4.1 The recorded identity.** `task.context.prUrl` is the identity,
  read through `resolvePrContext` (`src/core/pr-context.ts`), with the
  number derived by `extractPrNumber` (which already handles GitHub's
  `/pull/<n>` and Gitea's `/pulls/<n>`). A task with no `prUrl`, or with
  a `prUrl` from which no number can be extracted, is refused
  `"missing-pr-identity"` — never reconciled.
- **4.2 Never inferred.** None of the following is ever sufficient, and
  none may be used as a fallback: a bare Issue number; the head-branch
  convention `ai/issue-<n>` (`branchName`); a search for merged PRs
  referencing the Issue; the newest merged PR on the base branch; a
  closing keyword in a PR body. `findPullRequestForWorkItem` owns the
  branch-name convention and is therefore **not** an admissible source
  of identity here.
- **4.3 The provider must echo the same PR.** The live read is
  `getPullRequest(<recorded number>)`. Its returned `number` must equal
  the recorded number and its `url` must equal the recorded `prUrl`;
  when the task also recorded `context.branch`, the returned
  `headRefName` must equal it. Any disagreement is
  `"identity-mismatch"` — a refusal, never a correction of the recorded
  identity.
- **4.4 Absent fields are refusals, not passes.** A provider response
  missing `state` has not confirmed a merge. A response missing `number`
  or `url` has not confirmed identity. Absence fails closed at every
  point, inheriting the #998 rule.

## 5. The authoritative external completion signal

- **5.1** A **live** provider read reporting the PR state `MERGED` is
  the authoritative external completion signal for the current
  development workflow. Nothing else is: not a local `git branch
  --merged`, not the presence of the commits on the base branch, not a
  human comment saying "merged", not a closed Issue.
- **5.2 Live means read now.** The state must come from a provider read
  performed during this invocation. A `state` cached in task context, or
  carried over from an earlier run, is not a signal.
- **5.3 Provider data only, never prose.** The decision reads structured
  provider data (`PullRequest.state`, `number`, `url`, `headRefName`).
  It never parses CLI error text or human-facing output. This is the
  #998 discipline, inherited verbatim: error prose is not a contract.
- **5.4 The state string is compared case-insensitively against exactly
  `MERGED`.** `OPEN` and `CLOSED` are both `"not-merged"`. A host whose
  vocabulary cannot express `MERGED` is handled at §12.4, never by
  widening this comparison.

## 6. Eligibility

Eligibility is the conjunction of identity (§4), the merged signal (§5),
execution safety (§6.2–§6.3), and the absence of an unresolved Tool
Request (§6.4). It is **not** a status whitelist anchored on
`ready_for_human`.

- **6.1 `ready_for_human` is a common case, not a requirement.** It is
  the status most externally merged tasks happen to be in, because it is
  where a passing review parks them. It carries no special authority
  here, and an implementation must not gate on it. `queued` and
  `blocked` are equally eligible, and the irregular recovery cases this
  contract exists for are precisely the ones that never reached
  `ready_for_human`.
- **6.2 A live Issue lock means active.** `IssueWorktreeLock.inspect`
  reporting `locked: true` with `stale: false` means a run may be
  touching that Issue right now. Every writing outcome is withheld:
  the result is `"active"`. A stale lock (`stale: true`) does not
  protect the row — it is the residue of a crashed run and
  `admin worktree release-lock` owns it — but reconciliation never
  releases it (§13).
- **6.3 A `claimed`/`running` row is never reconciled.** With a valid
  claim (`ownerRunId` set and `leaseExpiresAt` in the future) or a live
  lock, the result is `"active"`. With neither — an expired lease and no
  live lock — the row is a **recovery** case, and the result is the
  refusal `"active-recovery-required"`: `admin recover` owns
  `RECOVERABLE_STATUSES`, and two writers CAS-ing the same row with no
  shared lock is exactly the race this contract refuses to enter.
  Recovery only ever re-queues: `TaskStore.recoverTask` moves every row
  it recovers to `queued` (rows 1–2 of §7), which this contract then
  handles. It decides that from status and lease expiry **alone** — it
  does not consult `hasUnresolvedToolRequest`, so today an expired
  `claimed`/`running` row carrying an unresolved Tool Request *is*
  requeued and arrives at row 1 with the request still live. Only
  `TaskStore.recoverHandoff` — the `admin recover --from
  ready_for_human` path — refuses that case, with
  `tool_request_unresolved` (#677). An implementation must not read this
  refusal as "recovery will screen the request for me": §6.4, not
  recovery, is what stops a requeued row with a live request from being
  reconciled. There is no force flag for this refusal.
- **6.3.1 Unusable claim metadata is its own refusal.** §6.3's two cases
  are not exhaustive over the rows the store can actually hold.
  `AiTask.ownerRunId` and `AiTask.leaseExpiresAt` are both optional, so a
  `claimed`/`running` row can carry **neither** a valid claim **nor** a
  demonstrably expired lease: `leaseExpiresAt` absent, `leaseExpiresAt`
  unparsable, or `ownerRunId` absent while a lease is still in the
  future. `isClaimExpired` (`src/core/transitions.ts`) reports `false`
  for the first two — it returns `false` outright when the field is
  absent, and `Date.parse` of an unparsable value is `NaN`, so
  `NaN <= Date.parse(now)` is `false` as well — so such a row is *not*
  expired, and the third is not a claim. With no live Issue lock, every
  such row is refused `"invalid-claim-metadata"`. It is a residual
  branch by construction: any `claimed`/`running` row that matches
  neither of §6.3's cases lands here, so the pair is closed and no
  inconsistent row is left to implementation choice.
- **6.3.2 Why it is not `"active-recovery-required"`.** Because recovery
  does not own this row. `admin recover` selects candidates with
  `t.status === "failed" || isClaimExpired(t, now)`, and
  `TaskStore.recoverTask` independently refuses a `claimed`/`running`
  row with `conflict` unless `isClaimExpired` is true. A row whose lease
  is absent or unparsable fails both, so recovery silently skips it;
  routing the operator there would name a remedy that does nothing. The
  row is treated as **potentially live** regardless — a claim whose
  lease write was lost is exactly the shape of a run still holding the
  task — so it is never reconciled and never written, and the refusal
  is distinct so the operator can tell the two remedies apart.
- **6.3.3 The remedy, honestly.** The operator establishes whether a run
  actually owns the row — `IssueWorktreeLock.inspect` via
  `admin worktree status`, plus the task's run history — and repairs it
  through the surface that owns claim metadata. **No such repair surface
  exists today**, and this contract adds none: teaching `recoverTask` to
  treat unusable claim metadata as expired is a change to recovery, not
  to reconciliation, and it is out of scope here. Until it lands the
  refusal is terminal for this contract, which is the fail-closed
  outcome §12.5 requires; §13.3 still prohibits hand-editing the row as
  the routine answer. There is no force flag for this refusal either.
- **6.4 An unresolved Tool Request refuses every writing outcome.** A
  task whose context carries a live Tool Request
  (`hasUnresolvedToolRequest`, #677 — the authority, and at most one
  exists per task) is refused `"tool-request-unresolved"`. A live
  request closes **only** through its own resolution surfaces —
  `admin tool-request resolve` (`manual-done`/`reject`) and
  `admin tool-request grant`. That cross-gate rule is already enforced
  by `TaskStore.recoverHandoff` (#677), by the Human Gate
  (`docs/human-gate-no-go-flow.md` §6.1 and its feedback preconditions),
  and by retention (`src/core/retention.ts`, `unresolved_tool_request`),
  and this contract does not become the exception to it.
- **6.4.1 Why, concretely.** The resolution surfaces are pinned to the
  handoff the request was parked at: the `manual-done`-after-`reject`
  resume in `src/core/tool-request-resolve.ts` fires only while
  `task.status === "ready_for_human"` and `task.phase ===
  "implementation"`, precisely so a stale request cannot requeue work
  that already reached `done`. A reconciliation that moved such a row to
  `done` would therefore strand the request permanently: the resolver
  deliberately refuses to requeue a completed task, and no other surface
  closes it. The operator resolves the request first and re-runs
  reconciliation; §7.2 R5 guarantees the refused row was left
  byte-identical, so that re-run is a clean first attempt.
- **6.4.2 How it composes with §7.** The refusal is row 17, at
  precedence step 5 (§7.1): after the `done` short-circuit, after the
  idempotency check, after every execution-safety row, and before any
  provider read. It therefore displaces exactly the five writing rows —
  1, 3, 5, 12, and 14 — and nothing else. A `done` row is still
  `noop-done`; an already-reconciled row is still `already-reconciled`;
  a live or recovery-owned row still reports `active` or
  `"active-recovery-required"`, which are the more actionable answers.
  It applies to `failed` and `cancelled` as well: `recorded-terminal` is
  a write, and a live request on a terminal row is still a request only
  its own surfaces may close. Being a task-row decision, it costs no
  provider call.
- **6.5 Nothing else gates eligibility.** Not the phase, not the attempt
  counts, not the presence of a dirty worktree, not unpushed commits,
  not the age of the row. A worktree's contents are a *cleanup* concern
  and are decided by cleanup's own guards (§14); they never decide a
  lifecycle transition.

## 7. The normative outcome table

Every `TaskStatus` has an explicit outcome. Rows are evaluated in the
precedence order of §7.1; the first matching row wins.

| # | Status | Condition | Outcome | Writes |
| --- | --- | --- | --- | --- |
| 1 | `queued` | eligible (§6), no live lock | `reconciled` | status → `done`, disposition record, event, comment |
| 2 | `queued` | live Issue lock | `active` | none |
| 3 | `blocked` | eligible (§6), no live lock | `reconciled` | as row 1 |
| 4 | `blocked` | live Issue lock | `active` | none |
| 5 | `ready_for_human` | eligible (§6), no live lock | `reconciled` | as row 1 |
| 6 | `ready_for_human` | live Issue lock | `active` | none |
| 7 | `claimed` | valid claim or live Issue lock | `active` | none |
| 8 | `claimed` | expired lease and no live lock | `refused` `"active-recovery-required"` | none |
| 9 | `running` | valid claim or live Issue lock | `active` | none |
| 10 | `running` | expired lease and no live lock | `refused` `"active-recovery-required"` | none |
| 11 | `done` | always | `noop-done` | none |
| 12 | `failed` | eligible (§6), no live lock | `recorded-terminal` | disposition record, event, comment; status and phase preserved |
| 13 | `failed` | live Issue lock | `active` | none |
| 14 | `cancelled` | eligible (§6), no live lock | `recorded-terminal` | as row 12 |
| 15 | `cancelled` | live Issue lock | `active` | none |
| 16 | any | a disposition record whose full identity key (§10.1) equals the currently recorded one already exists | `already-reconciled` | none |
| 17 | any writing row (1, 3, 5, 12, 14) | the task context carries an unresolved Tool Request (§6.4) | `refused` `"tool-request-unresolved"` | none |
| 18 | any | no recorded PR identity (§4.1) | `refused` `"missing-pr-identity"` | none |
| 19 | any | the provider read failed | `refused` `"pr-lookup-failed"` | none |
| 20 | any | the returned PR is not the recorded one (§4.3) | `refused` `"identity-mismatch"` | none |
| 21 | any | provider state is not `MERGED`, or absent | `refused` `"not-merged"` | none |
| 22 | any | the row moved between observation and write — the CAS lost (§11.4) | `refused` `"stale-state"` | none |
| 23 | any | the store refused the write for a reason that is not a lost CAS (`maintenance_locked`, §8.5) | `refused` `"store-refused"` | none |
| 24 | `claimed` | no live lock, and neither a valid claim nor a demonstrably expired lease (§6.3.1) | `refused` `"invalid-claim-metadata"` | none |
| 25 | `running` | no live lock, and neither a valid claim nor a demonstrably expired lease (§6.3.1) | `refused` `"invalid-claim-metadata"` | none |
| 26 | any except `done` | `context.mergedPrReconciliations` is present and is not a valid disposition history (§9.2.4) | `refused` `"malformed-disposition-history"` | none |

### 7.1 Precedence

1. **Session provider support** (§12.4) is decided once, before any task
   is read. An unsupported repo host refuses the whole invocation.
2. **Row 11** (`done`): an informative no-op that writes nothing and
   needs no provider read. It short-circuits first, so a finished task
   never consumes a provider call and never reports `active`.
3. **Rows 26 then 16** (the disposition history), from the task row
   alone and in that order: the history is *validated* before it is
   *read*. A malformed history cannot answer "has this PR already been
   reconciled", so no conclusion may be drawn from it — including
   `already-reconciled`. It also outranks the execution-safety rows: the
   defect must be repaired whatever the run does, and answering `active`
   would hide a data defect that is still there once the run ends. It
   costs no provider call. Row 26 excludes `done` because row 11
   short-circuits first and reads no history at all.
4. **Execution safety** (rows 2, 4, 6, 7, 8, 9, 10, 13, 15, and then
   24, 25): decided from the task row and the Issue lock, with no
   provider call. A live run is reported as such whether or not its PR
   is merged. Rows 24 and 25 are the residual of rows 7–10: they match a
   `claimed`/`running` row only after both the valid-claim and the
   expired-lease conditions have failed, so the `claimed`/`running`
   branch has no fall-through (§6.3.1).
5. **Row 17** (`"tool-request-unresolved"`): the cross-gate refusal of
   §6.4, decided from the task row with no provider call, after every
   non-writing row has had its chance to match.
6. **Identity and signal** (rows 18 → 19 → 20 → 21), in that order.
7. **Status routing** (rows 1, 3, 5, 12, 14).
8. **The write** (rows 22, 23).

### 7.2 Rules

- **R1 — Every status is covered.** The eight `TaskStatus` values each
  appear in at least one row. There is no default, no "other", and no
  status whose behavior is left to the implementation.
- **R2 — Only three statuses transition.** `queued`, `blocked`, and
  `ready_for_human` are the only statuses whose *status* changes, and
  the only status they change to is `done` (§8.1).
- **R3 — Terminal history is preserved.** `failed` and `cancelled`
  record the external merged disposition and keep their status, their
  phase, and every existing context field. Nothing is erased,
  overwritten, or relabelled; a merged PR does not retroactively make a
  failure a success (§8.3).
- **R4 — Active means report, never act.** `active` and
  `"active-recovery-required"` write nothing at all — no record, no
  event, no comment. They are observations.
- **R5 — Refusals never partially apply.** A refusal leaves the task
  byte-identical to how it was found, so a re-run after the operator
  fixes the cause is a clean first attempt.
- **R6 — Coverage is per row, not per status.** Every status is covered
  by rows whose conditions are exhaustive over the rows the store can
  hold, including inconsistent ones. `claimed` and `running` are the
  case that matters: rows 7–10 plus the residual rows 24–25 leave no
  `claimed`/`running` row unmatched, so unusable claim metadata has a
  named outcome (§6.3.1) rather than an implementation-chosen one.

## 8. The applied transition

- **8.1 Target.** `reconciled` sets `status: "done"` and leaves `phase`
  unchanged. `done` is the existing `TaskStatus` for a task that will
  never execute again: `claimNextTask` cannot claim it, `cancelTask`
  refuses it as terminal, and `admin worktree cleanup` already
  classifies it `terminal`. No new status is introduced, and `cancelled`
  is never used (§15.1).
- **8.2 This is the first writer of `done`.** No runtime path writes
  `done` today — `nextPhaseAfter` (`src/core/transitions.ts`) never
  returns it, no handler patches it, and every occurrence in `src/` is a
  read (the cleanup classification, the refinement progress projection,
  the terminal guards in the task stores). Reconciliation is therefore
  the first producer of a status the system was already built to
  consume. An implementation must not "fix" the reads to accommodate a
  different target status.
- **8.3 The terminal record.** `recorded-terminal` writes only
  `task.context.mergedPrReconciliations` — appending exactly one entry
  (§9.2) — and appends the event. It issues no status patch and no phase
  patch, and it removes or rewrites no other context field, including
  any entry already in that list.
- **8.4 Atomicity.** The status/context patch, the task event, and the
  work-item comment effect commit in **one** transaction, in the shape
  `completePhaseWithEffects` and `cancelTaskWithEffects` already
  establish (issue #701/#608). A crash must not be able to leave a task
  `done` with no record of why, because the repeat run would then read
  the disposition record as absent and the status as terminal — a state
  no outcome in §7 describes. The store surface that provides this is an
  implementation slice (§17); the guarantee is not.
- **8.5 Maintenance lock.** Under a held maintenance lock the whole call
  refuses with `"store-refused"` and touches nothing (issue #818), so
  the operator's reconciliation stays repeatable once the lock clears.

## 9. Audit

### 9.1 The event

Exactly **one** new task event type exists: `task.merged_pr_reconciled`.
It is appended only by a writing outcome — `reconciled` and
`recorded-terminal` — and never by `active`, `noop-done`,
`already-reconciled`, or any refusal. `data` carries, and is closed at:

| Field | Meaning |
| --- | --- |
| `prNumber` | the recorded PR number, echoed by the provider (§4.3) |
| `prUrl` | the recorded `task.context.prUrl` |
| `providerState` | the provider's state string, verbatim (e.g. `MERGED`) |
| `mergeCommit` | the merge commit, **present only when the provider reported one** (§16) |
| `observedAt` | ISO-8601 time of the provider read that produced `providerState` |
| `previousStatus` | the `TaskStatus` observed before the write |
| `previousPhase` | the `TaskPhase` observed before the write |
| `outcome` | a `MergedPrReconciliationOutcome` value |

### 9.2 The disposition history

The same fields are persisted on the task as one entry in
`task.context.mergedPrReconciliations` — an **append-only,
identity-keyed list**, never a single value. It is written by both
writing outcomes, including `recorded-terminal`, which is how a `failed`
or `cancelled` task carries the external merged disposition without
losing its status.

- **9.2.1 One entry per PR identity.** An entry's key is the §10.1
  identity key. At most one entry exists per key: a writing outcome
  appends an entry for an identity not already present, and an identity
  already present is row 16 (`already-reconciled`), which writes
  nothing. No entry is ever rewritten in place, removed, reordered, or
  merged into another; entries are held in append order, which is
  observation order.
- **9.2.2 Why a list and not a value.** A task's recorded `prUrl` can
  legitimately move to a superseding PR (§10.3). A `failed` or
  `cancelled` task recorded against PR A that later records PR B, and B
  is merged, reaches `recorded-terminal` a second time (row 12/14) and
  appends B's entry **beside** A's. A single-valued field could not hold
  both, and overwriting A would erase terminal history §7.2 R3 and §13
  forbid erasing. Refusing the second merge is equally wrong: B really
  was merged, and the disposition would go unrecorded.
- **9.2.3 It only grows by real dispositions.** The list gains at most
  one entry per distinct PR identity this task ever recorded and
  reconciled, so it is bounded by the number of superseding PRs — in
  practice one. Reconciliation never prunes, truncates, or compacts it;
  nothing else may either.
- **9.2.4 The history is validated before it is read.** `TaskContext` is
  `Record<string, unknown>` (`src/core/task.ts`) and nothing validates
  its members: `admin enqueue-task --context-json` merges an arbitrary
  JSON object into a new task's context after checking only that the
  argument is a JSON *object*, and every other writer patches context
  keys freely. `context.mergedPrReconciliations` can therefore hold a
  value this contract never wrote. A **valid disposition history** is
  exactly one of:
  - **absent** — the key is not present. That means "no disposition
    recorded", is the normal shape of a task before its first
    reconciliation, and is never a refusal; or
  - a JSON **array**, possibly empty, in which every element is a JSON
    object carrying a non-empty string `prUrl` and an integer
    `prNumber`, and no two elements share the same §10.1 identity key.

  Anything else is **malformed** and the task is refused
  `"malformed-disposition-history"` (§12.6.2): a present value that is not
  an array — including `null`, a string (even one whose text is JSON), a
  number, a boolean, or an object — an element that is not an object, an
  element whose `prUrl` or `prNumber` is absent or of the wrong type or
  whose `prUrl` is empty, or two entries sharing one identity key, which
  §9.2.1 says cannot exist.
- **9.2.5 Validation is whole-list, and tolerant only of unknown
  fields.** One malformed element refuses the whole task. The list is
  never partially read, filtered, sorted, or trusted "up to the bad
  entry": the entry an implementation would skip is exactly the one that
  might already record this PR, and skipping it turns row 16 into a
  duplicate append — a second audit record and a second operator-visible
  comment for one merge. Conversely, an element carrying fields **beyond**
  §9.1's is not malformed: unknown fields are preserved verbatim and
  never validated, so a later slice may widen the entry shape without
  invalidating histories written before it. The §9.1 fields other than
  `prUrl` and `prNumber` are likewise not validated and their absence is
  not malformed — only the identity key must be readable, because only
  the key decides row 16.
- **9.2.6 A malformed history is never repaired, coerced, or replaced.**
  An implementation must not wrap a lone object in an array, must not
  `JSON.parse` a string that looks like a list, must not drop, truncate,
  or normalize the value, and must not treat it as an empty list and
  append beside it. Each of those either destroys a context field §8.3
  and §13 promise to preserve, or records a disposition the operator
  cannot reconcile with what the row actually held. The refusal writes
  nothing at all, so the row is left byte-identical (§7.2 R5).
- **9.2.7 The remedy, honestly.** The operator inspects the row and
  restores a valid history — or removes the key — through whichever
  surface wrote the bad value. **No supported task-context repair
  surface exists today**, and this contract adds none: a `context`
  patch command is a change to task-context management, not to
  reconciliation, and it is out of scope here. Until one lands the
  refusal is terminal for this contract, which is the fail-closed
  outcome §12.5 requires, and §13.3 still prohibits hand-editing the row
  as the routine answer. There is no force flag for this refusal
  (§12.7).

### 9.3 What is never recorded or published

- **Never a local path.** No `repoRoot`, no `artifactRoot`, no worktree
  path, in the event, the record, or the comment. The comment body
  passes through `sanitizeBody(body, sessionRedactionPaths(session))`,
  exactly as `admin task cancel` / `task reconcile-closed` already do.
- **Never a synthesized merge commit.** Absent stays absent (§16).
- **Never a diff, a file list, or agent output.** The record is
  lifecycle metadata.

### 9.4 The operator-visible comment

Exactly one bounded comment is enqueued to the backing work item through
the outbox, in the same transaction as the write (§8.4), naming the PR,
the previous status and phase, and the outcome. **No label mutation is
performed** — the `admin task cancel` reason applies unchanged: a local
orchestration decision must never look like a work-item relationship
signal, and intake reads work-item state only, never local task status,
so this holds automatically as long as no label is touched.

## 10. Idempotency

- **10.1 The key is the complete PR identity.** It is the pair
  `(prUrl, prNumber)`, both compared verbatim against
  `task.context.prUrl` and the number §4.1 extracts from it. A second
  reconciliation of a task holding an entry in
  `context.mergedPrReconciliations` whose `prUrl` **and** `prNumber`
  both equal the currently recorded ones is `already-reconciled`: it
  writes nothing, appends no event, and posts no comment. The check runs
  only against a history §9.2.4 has already validated; it is never
  evaluated over an unvalidated value, and a value it cannot validate is
  row 26, not "no entry found".
- **10.1.1 The number alone is not the key.** Row 16 is decided from the
  task row before the §4.3 provider echo, so a key that stored only
  `prNumber` would report `already-reconciled` for a `prUrl` that now
  points at a *different repository's* PR that happens to carry the same
  number — silently claiming a merge that was never observed for the
  recorded PR. With the URL in the key the identities differ, §7
  continues, and the mismatch is caught where it belongs: at §4.3, as
  `"identity-mismatch"`, or as a fresh evaluation of a genuinely
  different PR.
- **10.2** The key deliberately excludes the outcome, the observation
  time, and any run id: the question is "has this exact PR already been
  reconciled for this task", not "has this invocation run before".
- **10.3** A task whose recorded `prUrl` later changes to a *different*
  PR (a superseding PR opened for the same Issue) is not shielded by an
  earlier entry: the identities differ, so §7 is evaluated afresh. A row
  the earlier reconciliation left `done` short-circuits at row 11
  (`noop-done`); a `failed` or `cancelled` row reaches row 12/14 again
  and **appends** the new PR's entry beside the old one (§9.2.2). An
  entry is never overwritten in place.

## 11. Preview, apply, and stale state

- **11.1 Preview is the default.** An invocation previews unless an
  explicit apply flag is given, mirroring every other state-changing
  admin surface (`worktree cleanup`, `task cancel`,
  `task reconcile-closed`). A preview performs every read — including the live
  provider read — and performs **no** write.
- **11.2 A preview reports the exact outcome the apply would produce**,
  per task, from the same §7 table. It never reports a summary that
  hides a refusal.
- **11.3 A preview is not a promise.** The apply re-reads the task row
  and re-evaluates §7 from scratch. Any conclusion carried over from the
  preview is a defect.
- **11.4 The write is compare-and-swap.** The transition CAS-es on the
  `(status, phase, ownerRunId, revision)` observed during this
  invocation's read. This is what closes the §6.3 window: if a run
  claims the row between the safety check and the write, the expected
  status no longer matches and the write loses. **`revision` is not
  optional.** It is the monotonic `tasks.revision` column every task
  write increments, and it is the only component that catches a
  concurrent write which moved *the identity this reconciliation was
  decided from* — a patch that rewrites `context.prUrl` to a different
  PR, or rewrites the disposition history of §9.2, while leaving
  `status`, `phase`, and `ownerRunId` untouched. Without it such a write
  would commit a reconciliation against a PR the row no longer records.
  The CAS shape is the one `SqliteTaskStore.replaceTask` already
  establishes: `expected: { status, phase, revision }`, widened here by
  `ownerRunId`. An implementation may substitute an equivalent
  whole-row identity snapshot, but never a narrower expectation.
- **11.5 A lost CAS is `"stale-state"`.** Never a retry loop, never a
  re-read-and-force, never a widened expectation. The operator re-runs;
  the fresh read routes the row correctly through §7. A lost CAS is
  **never** `"store-refused"`: the two refusals are disjoint, and
  `"store-refused"` is reserved for a store refusal that is not a CAS
  conflict — today exactly §8.5's `maintenance_locked`. Reading a lost
  CAS as `"store-refused"` (or a maintenance-lock refusal as
  `"stale-state"`) is a defect, because the operator's remedy differs:
  a stale row wants a re-run, a held maintenance lock wants a wait.
- **11.6 No lock is taken.** Reconciliation touches no filesystem, so it
  acquires neither the Issue worktree lock nor the repo lock. It is safe
  to run concurrently with anything except an active phase run, which
  §6.2/§6.3 exclude and §11.4 backstops.

## 12. Fail-closed conditions

Every uncertainty resolves to "do not reconcile". Specifically:

- **12.1 Provider errors.** A failed `getPullRequest` is
  `"pr-lookup-failed"`. "The PR is not merged" is never inferred from a
  failed read, and a failed read never falls back to a second lookup
  strategy.
- **12.2 Missing PR identity.** §4.1 — refused, never derived.
- **12.3 Closed-unmerged PRs.** A PR the operator closed without merging
  is `"not-merged"`. Closing a PR is not completing work, and this
  contract has no outcome for it: the operator's route for an abandoned
  Issue is `admin task reconcile-closed` (#608), which cancels.
- **12.4 Unsupported providers.** A repo host whose PR state cannot
  distinguish *merged* from *closed-unmerged* cannot supply the §5
  signal, and the whole invocation refuses with
  `"unsupported-provider"` before any task is examined — the fail-closed
  precedent `task reconcile-closed` sets for `not_planned`. This is the
  live situation for Gitea: `GiteaRepoHostProvider` maps `state`
  verbatim from Gitea's `open`/`closed`, so a merged Gitea PR is
  indistinguishable from a closed-unmerged one. Widening §5.4 to treat
  `closed` as merged would cancel-by-merge every abandoned PR on that
  host, and is prohibited. Gitea support requires a provider change that
  reports merge state, not a policy change here.
- **12.5 Ambiguity.** Any state this contract does not name is a
  refusal, not a default. An implementation that reaches an unnamed case
  must refuse and surface it, never guess.
- **12.6 Unresolved Tool Requests.** A live Tool Request is
  `"tool-request-unresolved"` (§6.4), never a note on an otherwise
  applied reconciliation and never a warning the operator may ignore.
  The request's own resolution surfaces are the only way it closes.
- **12.6.1 Unusable claim metadata.** A `claimed`/`running` row whose
  claim is neither valid nor demonstrably expired is
  `"invalid-claim-metadata"` (§6.3.1), never a pass, never folded into
  `"active-recovery-required"`, and never reconciled on the assumption
  that a missing lease means a dead run.
- **12.6.2 Malformed disposition history.** A present
  `context.mergedPrReconciliations` that is not a valid disposition
  history (§9.2.4) is `"malformed-disposition-history"`. It is never
  repaired, never coerced, never overwritten, and never read as an empty
  list: an unreadable audit history is exactly the state in which
  appending would risk a duplicate record and a duplicate
  operator-visible comment for one merge, and overwriting would destroy
  a context field this contract promises to preserve.
- **12.7 No force flag.** No flag overrides `"not-merged"`,
  `"identity-mismatch"`, `"missing-pr-identity"`,
  `"active-recovery-required"`, `"invalid-claim-metadata"`,
  `"malformed-disposition-history"`, or
  `"tool-request-unresolved"`. The safety these refusals provide is the
  point of the contract, and a `--force` would be a route back to the
  hand-edited-database posture §13.3 prohibits.

## 13. Mutation boundary

- **13.1 Lifecycle metadata only.** The complete set of writes is: the
  task row's `status`/`context` patch, one task event, and one work-item
  comment effect (§8, §9).
- **13.2 Never anything else.** Reconciliation never removes a worktree,
  never releases or force-releases a lock, never deletes or creates a
  branch, never runs any `git` write, never deletes a file, never prunes
  an artifact directory, never mutates a label, and never closes,
  reopens, or edits a work item. There is no flag that makes it do any
  of these.
- **13.3 Direct SQLite editing is not the normal path.** Hand-editing
  the task row to represent an external merge is prohibited as routine
  operation: it produces no event, no disposition record, and no
  operator-visible comment, so the merge becomes invisible to audit and
  to the intervention metrics. This contract exists so that the
  supported path is a supported path.

## 14. `admin worktree cleanup` is unchanged

- **14.1** Cleanup performs **no** merged-PR scan, makes **no** provider
  call, and prints **no** merged-PR advisory. It is a filesystem
  operation over the worktree registry and the task store.
- **14.2** `ACTIVE_TASK_STATUSES` stays exactly
  `queued`/`claimed`/`running`/`blocked`/`ready_for_human`, and an
  awaiting-human task's durable Issue worktree is still never removed.
- **14.3 No `--include-merged`.** No flag is added to cleanup by this
  contract or by any implementation of it.
- **14.4 The composition is one-directional and incidental.** After a
  `reconciled` outcome the row is `done`, which cleanup already
  classifies `terminal` → prune candidate, still behind its existing
  dirty/unpushed/lock guards and still requiring `--yes`. Cleanup never
  learns that a merge is why. Reconciliation never learns that a
  worktree exists.
- **14.5 Reconciling is not a precondition for cleanup and cleanup is
  not a consequence of reconciling.** Neither command invokes the other,
  and an operator may run either alone.
- **14.6 The disk-pressure sequence is a recommendation, in three
  stages.** When the reason for reconciling is reclaiming disk, the
  supported order is: (1) run the ordinary
  `admin worktree cleanup`; (2) only if more space must still be
  reclaimed, preview `admin task reconcile-merged` and then apply it with
  `--yes`; (3) run the same, unchanged `admin worktree cleanup` again,
  which now sees the reconciled tasks as ordinary `done` prune
  candidates. Each stage is a separate operator decision with its own
  preview. This ordering is guidance for operators and documentation,
  never a coupling: it adds no flag, no automatic invocation, and no
  ordering requirement to either command, and §14.5 still holds — stage 2
  is skippable, and stages 1 and 3 are the same command run twice.

## 15. Neighbouring surfaces

### 15.1 Cancellation is not merging

`admin task cancel` and `admin task reconcile-closed` (#608) both
express **abandonment** and both land `cancelled`. Using either to
represent a successful external merge is prohibited: it records
completed, merged work as abandoned, it posts an operator-visible
comment that says the opposite of what happened, and it corrupts the L3
intervention signal that distinguishes abandoned work from delivered
work. The shapes are deliberately parallel — preview by default,
per-status eligibility, atomic transition-plus-effects, fail-closed
provider reads — and the *dispositions* are opposites.

### 15.2 `core/pr-reconciliation.ts` (#998) solves a different problem

That module decides whether a PR-creation retry may adopt an
already-**open** PR on the exact head branch; `"not-open"` is one of its
refusals. This contract decides whether a task may be completed because
its recorded PR is **merged**. They share their discipline — provider
data never prose, exact identity never a guess, absence is a refusal —
and they share no code path. Neither calls the other, and the name
similarity must not become an invitation to merge them.

### 15.3 The Human Gate remains the normal route

`docs/human-gate-no-go-flow.md` (#747) specifies the normal path out of
`ready_for_human`. Reconciliation is the **irregular** path: it exists
for merges that happened outside the gate, including the recovery cases
that never reached it. An implementation must not route normal gate
traffic through this contract, and must not make reconciliation a
prerequisite for the gate.

### 15.4 A Tool Request closes only through its own surfaces

`admin tool-request resolve` (`manual-done`/`reject`) and
`admin tool-request grant` are the only routes out of a live Tool
Request. Every neighbouring surface that could otherwise move such a
task refuses instead: `TaskStore.recoverHandoff` returns
`tool_request_unresolved` (#677), the Human Gate refuses feedback and
`apply` on the same condition (`docs/human-gate-no-go-flow.md` §6.1),
review admission and retention both exclude the task
(`src/core/review-admission.ts`, `src/core/retention.ts`). §6.4 adds
this contract to that list. The one surface that does **not** check it
is `TaskStore.recoverTask` (§6.3) — that is a description of today's
behavior, not a licence to copy it.

## 16. Provider port gap: the merge commit

`PullRequest` (`src/providers/types.ts`) carries no merge commit, and
the GitHub provider's `PR_FIELDS` does not request one, so **today the
merge commit is always absent**. §9's `mergeCommit` is therefore
specified as "when available":

- An implementation slice may add an optional `mergeCommit?: string` to
  `PullRequest` and request it from the host (on GitHub,
  `gh pr view --json mergeCommit`).
- Until then, the field is simply absent from the event and the record.
- **Absence never blocks reconciliation** — `MERGED` is the signal
  (§5.1), the merge commit is corroborating audit detail.
- **Absence is never filled in.** The merge commit is never derived from
  a local `git log`, never taken from the base-branch tip, and never
  guessed from the PR head. A synthesized commit id in an audit record
  is worse than no commit id.

## 17. Implementation decomposition (proposal)

**No implementation Issues are created by this document.** The
decomposition below is a proposal; it awaits human approval, and the
tracker — not this document — assigns numbers and may re-cut the slices.

| # | Slice | Effort |
| --- | --- | --- |
| 1 | Pure core decision module: §4 identity checks, §5 signal, §9.2.4 disposition-history validation, §7 table over injected task + provider facts. No I/O. | S |
| 2 | Store surface for §8.4: an atomic status/context patch + event + effects commit for a non-phase transition, with §8.5's maintenance-lock refusal. | M |
| 3 | Operator command: preview/apply over one Issue or a whole session, §12.4's command-level provider refusal, §11's CAS wiring. | M |
| 4 | Optional `PullRequest.mergeCommit` and its GitHub field request (§16). | S |
| 5 | End-to-end tests: one per §7 row, plus idempotency, stale-state, and the §14 no-change assertions on cleanup. | M |

Effort maps to the tracker complexity labels: **S** ≈
`complexity:medium`, **M** ≈ `complexity:high`, **L/XL** ≈
`complexity:xhigh`.

## 18. Invariants

- **I1** Reconciliation acts only on the task's exact recorded PR
  identity, never on an Issue number, a branch-name guess, or an
  unrelated merged PR.
- **I2** A live provider `MERGED` is the only completion signal.
- **I3** `ready_for_human` is never an eligibility requirement.
- **I4** Every `TaskStatus` has an explicit outcome in §7; there is no
  default branch.
- **I5** `queued`, `blocked`, and `ready_for_human` are the only
  statuses that transition, and `done` is the only status they
  transition to.
- **I6** `failed` and `cancelled` keep their status, their phase, and
  every existing context field.
- **I7** `claimed` and `running` are never reconciled, including when
  their claim metadata is unusable: that row is refused
  `"invalid-claim-metadata"`, never treated as an expired claim.
- **I8** The transition, its event, and its comment commit together or
  not at all.
- **I9** Every uncertainty — provider error, missing identity,
  closed-unmerged PR, unsupported host, unusable claim metadata, lost
  CAS — is a refusal that writes nothing.
- **I10** No worktree, branch, file, artifact, label, or work-item state
  is ever mutated.
- **I11** `admin worktree cleanup` gains no flag, no provider call, and
  no advisory output.
- **I12** No new `TaskStatus`, `TaskPhase`, `PhaseRunOutcome`, or
  `PhaseHandlerResult` member is introduced.
- **I13** The write CAS-es on the observed `revision` as well as
  `(status, phase, ownerRunId)`, and a lost CAS is always
  `"stale-state"` and never `"store-refused"`.
- **I14** The disposition history is append-only and keyed by the
  complete PR identity `(prUrl, prNumber)`; no entry is ever
  overwritten, removed, or keyed by the PR number alone.
- **I15** A task carrying an unresolved Tool Request is never written by
  reconciliation; it is refused `"tool-request-unresolved"`, and the
  request closes only through `tool-request resolve`/`grant`.
- **I16** A present `context.mergedPrReconciliations` that is not a
  valid disposition history (§9.2.4) is refused
  `"malformed-disposition-history"` before it is read for idempotency;
  it is never coerced, repaired, overwritten, or read as an empty list.

## 19. Contract tests

The normative rules above are pinned structurally by
`test/docs-merged-pr-reconciliation-contract.test.js`. Those tests are
structural only: they pin what this document says, not whether a runtime
implements it. The operation core's behavior is pinned separately by
`test/merged-pr-reconciliation.test.js` (issue #1047), and the operator
command's behavior — preview/apply, the §7 outcomes end to end, the
§12.4 provider refusal, the exit-status mapping, and the §14 no-change
assertions on `worktree cleanup` — by
`test/admin-task-reconcile-merged.test.js` (issue #1048).
