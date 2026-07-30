# Human Gate No-go Flow

Specification for what happens when a human rejects work parked at the **Human
Gate** — the `ready_for_human` handoff a task reaches after an AI review passes
and `renderHumanGateSummary` posts its Go/No-go checklist to the PR
(`src/core/human-gate-summary.ts`, issue #552).

This document replaces issue #554 and PR #556. PR #556 is historical reference
material only: it was amended fourteen times against an architecture that has
since changed, and its state vocabulary contradicts the ports, statuses, and
recovery rules that exist on `main` today. **Where anything in PR #556 differs
from this document, this document is authoritative, and PR #556 must not be
merged or copied.** Every state name, port method, task status, and store
result code below is reconciled against the current tree:
`src/core/task.ts`, `src/core/task-store.ts`, `src/core/outbox.ts`,
`src/stores/sqlite-task-store.ts`, `src/cli/admin.ts`, and
[`docs/admin-task-handoff-ports-contract.md`](admin-task-handoff-ports-contract.md).

**This is a documentation-only issue.** No production code (CLI commands,
store methods, provider ports) is changed here. §11 lists what a later
implementation issue must add, including the port additions §10 shows do not
exist yet.

Related contracts, all of which this document defers to rather than restates:

- [`DOMAIN.md`](DOMAIN.md) — context ownership, the dependency matrix, and the
  author-channel invariant (§3) this document's command-construction rules
  implement.
- [`admin-task-handoff-ports-contract.md`](admin-task-handoff-ports-contract.md)
  — the `TaskStore` port surface, atomicity, idempotency, and CAS rules every
  mutation below must go through.
- [`admin-cli-contract.md`](admin-cli-contract.md) — output modes, exit codes,
  `--dry-run` / `--yes` gating, unknown-option rejection.
- [`human-review-return-flow.md`](human-review-return-flow.md) — the existing
  fix-mode return path that the continuation dispositions reuse verbatim.

---

## 1. Canonical vocabulary

Exactly one vocabulary is used throughout this document, and a later
implementation must use these tokens verbatim in code, JSON output, and
operator text. Nothing else is a valid name for these concepts.

**Gate states** — the value of `task.context.humanGate.state`:

| State | Meaning | Gate live? |
| --- | --- | --- |
| `open` | No-go feedback recorded; no disposition applied yet. The only state whose feedback may be pre-populated for editing. | Yes |
| `applying` | A disposition's steps are executing under a lease. Transient. | Yes |
| `apply_failed` | A disposition partially completed and one step failed. Stable; requires a resume or an explicit abandon. | Yes |
| `held` | `hold_for_discussion` was applied. The workflow is parked with no continuation; a later `apply` may still choose an actionable disposition. | Yes |
| `resolved` | An actionable disposition completed. This gate is closed and is an immutable audit record. | No |

**Dispositions** — the value of `task.context.humanGate.disposition`:

`continue_fix`, `continue_fix_recreate_pr`, `split_followup`, `supersede`,
`close_not_planned`, `hold_for_discussion`.

**Operations** — exactly two mutating commands, plus one read-only inspector:

| Command | Mutates? | Purpose |
| --- | --- | --- |
| `admin.js human-gate no-go` | Yes | Record (or edit) operator No-go feedback and return advice. |
| `admin.js human-gate apply` | Yes | Apply the selected disposition. |
| `admin.js human-gate show` | No | Print the current gate record. |

The two-operation model is fixed. Advice generation is **part of `no-go`**, not
a third mutating command: a separate advice command would be a third writer of
`humanGate` and would need its own place in the state machine for no benefit.
`human-gate show` re-displays the stored advice without regenerating it.

**Terminology guard.** "Human Gate" in this document always means the
`ready_for_human` merge gate. It is *not* the planning-gate verdict spelled
`human-gate` in [`ai-planner-gate-architecture.md`](ai-planner-gate-architecture.md)
§ Decision vocabulary, and it is *not* the Tool Request permission gate
(`docs/guided-tool-request-flow.md`). The three are independent; a task can sit
behind only one of them at a time, and the refusals in §7 keep them from being
resolved through each other's commands.

---

## 2. `task.context.humanGate` is workflow state, not a storage boundary

`humanGate` is a plain object inside `AiTask.context`, exactly like
`toolRequest` (ports contract §8) and `reviewFeedback`
(`human-review-return-flow.md`). It introduces **no new store, no new table,
and no new port interface** — the one store-side addition it does require,
`transitionTaskWithEvent` (§4.1), is a method on the `TaskStore` port that
already exists, alongside the equally atomic `completePhaseWithEffects` and
`cancelTaskWithEffects`. Orchestration remains the sole owner of task rows
(`DOMAIN.md` §2.3), and every read and write below goes through the existing
`TaskStore` port.

**Whole-object replacement is mandatory.** Every write of `humanGate` replaces
the entire object; a partial merge is forbidden. This is not stylistic —
`applyTaskPatch` (`src/core/transitions.ts`) shallow-merges `context` and does
**not** delete keys, so a field set to `undefined` survives as an own property
in `MemoryTaskStore` and disappears only in `SqliteTaskStore` as a
`JSON.stringify` side effect (ports contract §8). A gate reset expressed as
`{ humanGate: { ...prev, disposition: undefined } }` would therefore be
observably adapter-dependent. Replacing the object outright makes the reset
rules in §5 adapter-independent and removes the class of stale-field bugs the
acceptance criteria forbid.

Concretely, every gate mutation is exactly one call of the shape:

```ts
await store.transitionTaskWithEvent(
  { sessionId, issueNumber },
  { status: observedStatus, revision: observedRevision },
  { context: { humanGate: /* a COMPLETE new object */ }, /* ...other patch fields */ },
  { type: "human_gate.*", data: { gateId /* ... */ } },
);
```

The patch half is exactly a `transitionTask()` patch, with the same CAS
expectation; §4.1 explains why the event travels with it.

---

## 3. Persisted `humanGate` fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `gateId` | integer ≥ 1 | always | Identity of *this* gate. `1` on the first `no-go`; incremented by one every time `no-go` opens a **new** gate over a `held` or `resolved` one (§5). Never reused, never decremented. Everything else in this object belongs to `gateId` and must never be carried across an increment. |
| `state` | one of §1's five states | always | Current gate state. |
| `feedback` | non-empty string | always | Bounded, sanitized No-go reason (§9). |
| `feedbackSource` | source token | always | Which channel produced `feedback`: `operator_input` (`--message`/`--message-file`), `operator_editor` (`$EDITOR` template), or `github-app-no-go` (future GitHub App path). |
| `feedbackRecordedAt` | ISO-8601 | always | When `feedback` was last written. |
| `feedbackMeta` | object | optional | Provenance for audit: channel, author login, and source timestamp when the source provides them. Never used to build a command (§8). |
| `openedAt` | ISO-8601 | always | When this `gateId` was opened. Unchanged by feedback edits. |
| `updatedAt` | ISO-8601 | always | Last write of any field in this object. |
| `advice` | object | optional | The advice record (§8). Absent before the first generation, when `--no-ai` was passed, when generation failed, and immediately after any feedback write — both a new gate and an edit of an `open` one (§5). Advice always describes the `feedback` currently stored beside it. |
| `adviceError` | string | optional | Sanitized reason advice is absent when generation was attempted and rejected. Mutually exclusive with `advice`, and cleared by a feedback write exactly as `advice` is (§5). |
| `disposition` | one of §1's six dispositions | optional | Set by `apply`. Absent while `state` is `open`. |
| `appliedAt` | ISO-8601 | optional | When `apply` finalized. Absent unless `state` is `held` or `resolved`. |
| `appliedBy` | source token | optional | `operator_cli` today; reserved for a future automation path. Written with `appliedAt`. |
| `pendingOperation` | object (§6) | optional | In-flight or partially-failed apply progress. Present **only** while `state` is `applying` or `apply_failed`; cleared by finalize and by abandon. |

**Initialization.** The first `no-go` on a task writes the complete object with
`gateId: 1`, `state: "open"`, and no `advice`/`disposition`/`appliedAt`/
`appliedBy`/`pendingOperation` keys.

**Reset.** Opening a new gate writes a complete object with `gateId: prev + 1`,
`state: "open"`, fresh `feedback`/`feedbackSource`/`feedbackRecordedAt`/
`openedAt`/`updatedAt`, and **no** `advice`, `adviceError`, `disposition`,
`appliedAt`, `appliedBy`, or `pendingOperation` key at all. Because the object
is replaced rather than merged (§2), "no key" is literally true in both store
adapters.

**Audit is append-only elsewhere.** `humanGate` holds only the *current* gate.
The history of prior gates lives in task events (§4) — the object is
deliberately not a growing log, so a task with twenty gates does not carry
twenty feedback bodies in every context read.

---

## 4. Task events

Every gate mutation appends exactly one event, and every event corresponds to
exactly one gate mutation. Event `data` always carries `gateId` so events can
be grouped per gate. There are no exemptions: every write of `humanGate` listed
anywhere in this document appears in the table below, including the advice
write in §5, which is a mutation of `humanGate` like any other.

| Event type | Emitted when |
| --- | --- |
| `human_gate.opened` | `no-go` creates `gateId` 1 or increments to a new gate. |
| `human_gate.feedback_updated` | `no-go` replaces feedback on an already-`open` gate. |
| `human_gate.advice_recorded` | `no-go` persists an `advice` record, or an `adviceError` when generation was attempted and rejected (§5, §8.1). `data` carries the outcome (`advice` or `adviceError`) but never the advice body. |
| `human_gate.apply_claimed` | `apply` takes the lease and sets `applying`. |
| `human_gate.step_completed` | Each disposition step finishes (§6). |
| `human_gate.apply_failed` | A step fails and the gate lands in `apply_failed`. |
| `human_gate.abandoned` | `--abandon-pending-operation` discards a `pendingOperation`. |
| `human_gate.held` | `hold_for_discussion` finalizes. |
| `human_gate.resolved` | An actionable disposition finalizes. |

`--no-ai`, or a `no-go` run in which advice generation is never attempted,
writes no advice and therefore emits no `human_gate.advice_recorded` event.

### 4.1 The gate write and its event must commit together

The "exactly one event per mutation" rule above is only enforceable if the
`humanGate` write and its event commit atomically. They must:

- **Required primitive.** Each gate mutation is one atomic commit of the
  revision-guarded `transitionTask()` patch *plus* its `human_gate.*` event, in
  a single task-store transaction. A lost CAS writes neither. Unlike the label
  and comment steps in ports contract §4 — which straddle two SQLite
  connections and are therefore accepted as non-atomic — the task row and the
  task-event table are the *same* store and the same connection, so this
  atomicity costs nothing structural.
- **It does not exist on today's `TaskStore`.** `transitionTask()` and
  `appendEvent()` are separate calls, and the one atomic
  transition-plus-event-plus-effects primitive, `completePhaseWithEffects()`,
  is documented as Orchestration's phase-completion path carrying a
  `phase.completed` event and explicitly **not used by any admin command**
  (ports contract §4). A Human Gate implementation therefore cannot satisfy the
  rule with the current surface.
- **Required addition.** The implementing issue (§14 item 1) adds
  `transitionTaskWithEvent(key, expected, patch, event)` to the **existing**
  `TaskStore` port — the same CAS semantics as `transitionTask()`, with the
  event inserted in the same transaction, mirroring
  `completePhaseWithEffects()`/`cancelTaskWithEffects()` and implemented in
  both `SqliteTaskStore` and `MemoryTaskStore`. This is a method on a port that
  already exists; it is not a new store, table, or interface, so §2 still
  holds. No Human Gate command may ship before it.
- **Required addition, terminal dispositions.** `supersede` and
  `close_not_planned` finalize the gate *by cancelling the task*, and
  `transitionTaskWithEvent` is not the primitive for them: the cancellation
  must stay one commit with its `task.cancelled` event and its work-item
  close/comment effects, which is what `cancelTaskWithEffects()` exists for
  (§10.1). But that method on `main` cannot carry a gate finalize. Its
  `options` are `{ reason?, now? }` only; `#applyCancel` merges nothing into
  the row's context but `cancelledAt`/`cancelReason`; it accepts exactly one
  `TaskEvent`; and it has no `expected` guard
  (`src/stores/sqlite-task-store.ts`). It can therefore write neither
  `humanGate.state: "resolved"` nor `human_gate.resolved`, so cancelling and
  *then* finalizing would be two commits with a crash window between them in
  which the task is already `cancelled` while the gate still reads `applying`
  — a terminal task that still claims to be mid-apply, which is exactly the
  contradiction §7.2 rules out for the non-terminal `requeue_fix_mode` path,
  and worse here because the task can never be requeued to repair it. The
  implementing issue (§14 item 1) therefore **widens the existing
  `cancelTaskWithEffects()`** — a caller-supplied context patch, a CAS guard,
  and an ordered event list — rather than adding a second cancel method. The
  widened contract is specified once, in §7.2, and no terminal disposition may
  ship before it.
- **Ordering is fixed.** The event is never appended before the transition
  commits. An event describing a mutation that did not happen is therefore
  impossible in either the atomic or the interim shape below.
- **Interim repair semantics.** If any code lands ahead of the primitive and
  uses `transitionTask()` followed by `appendEvent()`, the guarantee degrades
  to *at most* one event per mutation: a crash between the two leaves a
  committed gate write with no event. In that shape the rules are: (a) the task
  row is the sole authority for gate state — no command may infer `state`,
  `gateId`, or `disposition` from events; (b) `human-gate show` detects the gap
  by comparing `humanGate.gateId`/`state`/`updatedAt` against the newest
  `human_gate.*` event for that `gateId` and renders `event missing (crash
  window)` rather than implying the mutation never happened; and (c) the
  missing event is never back-filled with a fabricated timestamp. This is a
  documented degradation, not a substitute — the "exactly one event" invariant
  is restored only by the atomic primitive.

---

## 5. `admin.js human-gate no-go`

Records or edits operator feedback for the gate and returns advice. It never
applies a disposition and never moves the task out of `ready_for_human`.

**Options** (in addition to the global flags in `admin-cli-contract.md`):

| Option | Meaning |
| --- | --- |
| `--session-id <id>` / `--session-ref <ref>` | Session selector (required, mutually exclusive). |
| `--issue-number <n>` | Work item number (required). |
| `--message <text>` | Feedback text (`feedbackSource: operator_input`). |
| `--message-file <path>` | Feedback from a local file (`feedbackSource: operator_input`). |
| `--no-ai` | Skip advice generation. Feedback is still recorded. |
| `--dry-run` | Preview the write and the refusal checks; persist nothing. |

With neither `--message` nor `--message-file`, `$EDITOR` opens on a template
(`feedbackSource: operator_editor`). Supplying both is an error.

**Preconditions, checked in order, all fail closed:**

1. The task exists (`TaskStore.getTask()`), else `not_found`.
2. `task.status === "ready_for_human"`, else refuse `not_at_human_gate`. A
   `claimed`/`running` task is never mutated — the same rule
   `human-review-return` already enforces.
3. `hasUnresolvedToolRequest(task.context)` is false, else refuse
   `tool_request_unresolved` with the same operator guidance
   `recoverSkipReason` already produces (`admin.ts`): a live Tool Request must
   close through `tool-request resolve`/`grant` first. A Tool Request handoff
   is not a Human Gate No-go.
4. `humanGate.state` is not `applying` or `apply_failed`, else refuse
   `apply_in_progress`. Feedback must not move while a disposition's steps are
   half-applied.
5. Feedback is non-empty after bounding and sanitization (§9), else refuse
   `empty_feedback` and write nothing.

**Effect, by prior state:**

| Prior `humanGate` | Result | `gateId` | Feedback pre-populated for editing? |
| --- | --- | --- | --- |
| absent | new gate, `state: "open"` | `1` | No — empty template |
| `open` | same gate, feedback replaced, prior advice cleared | unchanged | **Yes** — the editor opens on the existing unresolved `feedback` |
| `held` | **new** gate, full reset (§3) | `prev + 1` | No — empty template |
| `resolved` | **new** gate, full reset (§3) | `prev + 1` | No — empty template |
| `applying` / `apply_failed` | refused (`apply_in_progress`) | — | — |

This is the stale-gate rule the acceptance criteria require, stated once:
**pre-population is allowed only for an unresolved (`open`) gate.** A gate that
already produced a decision (`held` or `resolved`) is never edited in place;
`no-go` starts a new `gateId` whose object contains no `disposition`,
`appliedAt`, `appliedBy`, `advice`, or `pendingOperation` key. A new gate can
therefore never silently inherit an earlier gate's decision or apply metadata.

**Write.** One atomic transition-plus-event commit (§4.1): `expected: { status:
"ready_for_human", revision }` with the revision read in step 1, patch
`{ context: { humanGate: <complete object> } }`, event `human_gate.opened` or
`human_gate.feedback_updated`. Status and phase are unchanged. A `conflict`
result means another writer landed in between; the command exits non-zero with
`human_gate_conflict` and persists nothing (§7).

**The feedback write always clears prior advice.** The complete object it
writes carries **no** `advice` and **no** `adviceError` key — on a new gate
because the reset rule already forbids them (§3), and on an edited `open` gate
because the stored advice was generated from feedback that no longer exists.
Clearing is part of the *first* commit, before advice generation is attempted,
not a side effect of a later successful generation. This is what makes the
field invariant hold in every branch that follows: `--no-ai`, a generation that
fails and records `adviceError`, a generation still in flight, and a process
that dies mid-generation all leave the gate with no recommendation rather than
with the previous feedback's recommendation. An operator who edits feedback and
passes `--no-ai` sees advice disappear; that is the intended outcome, and
`human-gate show` reports "no advice for the current feedback" rather than
re-displaying a superseded one.

**Advice** is generated after the feedback write, from the stored gate, and
persisted by a **second** gate mutation under the revision the first commit
returned — again one atomic transition-plus-event commit (§4.1), this one
carrying `human_gate.advice_recorded`. It replaces the whole `humanGate` object
(§2), setting `advice` or `adviceError` plus `updatedAt` on a gate that, by the
rule above, currently has neither. It is a gate mutation and so it is
not exempt from §4's one-event rule.

Splitting the two writes is deliberate: a failed or slow advice call must never
lose the operator's feedback. If the advice write loses its CAS, the advice is
dropped, not retried, and no `human_gate.advice_recorded` event is emitted — the
feedback is already safe, the gate is left with no advice rather than with the
old one, and `no-go` can simply be re-run.

**Public surface.** `no-go` enqueues one sanitized `gh:comment` recording that
a Human Gate No-go was raised, its `gateId`, and the disposition options. The
raw feedback body is **never** posted (§9).

---

## 6. `admin.js human-gate apply`

Applies one disposition. This is the only command that requeues, cancels, or
otherwise moves the task off the gate.

**Options:**

| Option | Meaning |
| --- | --- |
| `--session-id <id>` / `--session-ref <ref>` | Session selector (required). |
| `--issue-number <n>` | Work item number (required). |
| `--disposition <value>` | One of §1's six dispositions (required). Anything else is rejected by the parser before any store read. |
| `--out-of-scope-item <text>` | One structured out-of-scope item for `split_followup`; repeatable. |
| `--out-of-scope-file <path>` | Out-of-scope items from a file, one per non-empty line, `#`-prefixed lines ignored. |
| `--yes` | Required confirmation for every destructive disposition (§7). |
| `--abandon-pending-operation` | Discard an `apply_failed` `pendingOperation` to start a different disposition. Also requires `--yes`. |
| `--dry-run` | Preview the resolved step list and every eligibility check; persist nothing and enqueue nothing. |

### 6.1 Eligibility

Checked in order, all fail closed, before any step runs:

1. Task exists, else `not_found`.
2. `humanGate` exists, else `no_gate` — `apply` never invents a gate.
3. `task.status === "ready_for_human"`, else `not_at_human_gate`.
4. `hasUnresolvedToolRequest(task.context)` is false, else
   `tool_request_unresolved`.
5. Gate state admits this call:

| Gate state | Fresh `apply` | Resume (same disposition + same `inputDigest`) | Abandon |
| --- | --- | --- | --- |
| `open` | allowed | n/a | n/a |
| `held` | allowed (any disposition); a repeat of `hold_for_discussion` short-circuits as a no-op **before** the claim (§6.1.1) | n/a | n/a |
| `applying` | refused `apply_in_progress` **unless** `pendingOperation.leaseExpiresAt` is in the past, in which case the call takes the lease over (§6.4) | as for fresh | refused — a live lease is never abandoned |
| `apply_failed` | refused `pending_operation_mismatch` | allowed | allowed with `--abandon-pending-operation --yes` |
| `resolved` | refused `gate_resolved` | n/a | n/a |

   `gate_resolved` is the idempotency backstop: a repeated `apply` after a
   successful one is a refusal, never a second mutation. To act again the
   operator must run `no-go`, which opens a new gate (§5).
6. Destructive dispositions require `--yes`; without it the command prints the
   planned steps and exits `0` having changed nothing, per
   `admin-cli-contract.md`'s preview-by-default rule.
7. The disposition's own precondition in §7 holds.

### 6.1.1 Pre-claim no-op: a repeated hold

`hold_for_discussion` is the one disposition whose effect is already fully
expressed by the gate state it produces, so re-running it must change nothing.
That guarantee cannot come from the generic flow of §6.2–§6.3: a claim would
write `applying` and emit `human_gate.apply_claimed`, `record_hold` would post a
second status comment, and the finalize would emit a second `human_gate.held`.
Three mutations and a duplicate public comment is not a no-op.

Therefore, **after eligibility (§6.1) and before the claim (§6.2)**, `apply`
short-circuits when all of the following hold:

- `disposition` is `hold_for_discussion`;
- `humanGate.state` is `held`;
- `humanGate.disposition` is `hold_for_discussion`;
- `humanGate.gateId` is the gate the call resolved — the check is per-gate, so a
  new `no-go` (§5) always produces a live hold rather than a no-op.

The command then **writes nothing, enqueues nothing, and emits no event**. It
exits `0` reporting the existing `gateId`, `state: "held"`, `appliedAt`, and
`appliedBy` unchanged, with a message saying the gate is already held. `--json`
adds `noop: true` so a caller can distinguish it from a hold it just applied.
`--dry-run` reports the same no-op instead of a step list.

The short-circuit is deliberately narrow. Any *other* disposition against a
`held` gate is a real decision the operator is making after the discussion, and
runs the full flow of §6.2–§6.3. `hold_for_discussion` against an `open` gate is
also a real transition (`open` → `held`) and is never short-circuited. And
because the check requires `state: "held"`, a hold that failed mid-apply
(`apply_failed`) is not mistaken for a completed one; it resumes under §6.4.

### 6.2 Claim

`apply` claims the gate with one atomic transition-plus-event commit (§4.1)
under `expected: { status: "ready_for_human", revision }`, writing a complete
`humanGate` object with `state: "applying"` and a fresh `pendingOperation`, and
emitting `human_gate.apply_claimed`:

| `pendingOperation` field | Type | Description |
| --- | --- | --- |
| `disposition` | disposition | The disposition being executed. |
| `inputDigest` | string | SHA-256 over the canonicalized structured inputs (the disposition plus the ordered, sanitized out-of-scope items). A resume must match it exactly. |
| `runId` | string | `human-gate-<sessionId>-<issueNumber>-<gateId>-<disposition>` — **pinned to the gate, not to the invocation** (§6.5). |
| `steps` | string[] | The ordered step IDs from §7, resolved at claim time. |
| `completedSteps` | string[] | Step IDs already finished, in completion order. |
| `stepResults` | object | Per-step outputs a resume must not recompute (e.g. `create_replacement_item` → the created item number). |
| `failedStep` | string | Step that failed, when `state` is `apply_failed`. |
| `failedReason` | string | Sanitized, bounded failure message. |
| `leaseExpiresAt` | ISO-8601 | Lease horizon for this attempt (§6.4). |
| `attempt` | integer ≥ 1 | Incremented on every claim or resume of the same `inputDigest`. |

A lost CAS here means another operator claimed first: exit non-zero with
`human_gate_conflict` and run no steps.

### 6.3 Execute and finalize

Steps run in the order §7 lists, skipping any ID already in `completedSteps`.
After each step, one atomic transition-plus-event commit (§4.1) records the
step — whole-object replacement, revision-guarded, `human_gate.step_completed`
in the same transaction. A step that produced a host object records its
identity (§7.2) in that same commit, so the step is marked complete and its
result persisted together or not at all.

- **All steps succeed** → finalize: one commit setting `state` to `resolved`
  (or `held` for `hold_for_discussion`), `disposition`, `appliedAt`,
  `appliedBy`, and **no** `pendingOperation` key, with event
  `human_gate.resolved` or `human_gate.held`.
  - **The finalize is never a commit against an already-terminal task.** Two
    dispositions move the task off `ready_for_human` in their last step, and
    for both the finalize is **fused into that step**, not appended after it:
    `requeue_fix_mode` carries it (§7.2), and for `supersede` /
    `close_not_planned` the `cancel_task` step is itself the finalize (§7.2).
    A separate finalize commit after either step would be guarded on a status
    that no longer holds, and would leave the gate readable as `applying` on a
    task that is already `queued` or `cancelled`.
- **A step fails** → one commit setting `state: "apply_failed"` with
  `failedStep`/`failedReason` retained, with event `human_gate.apply_failed`.
  The command exits non-zero. The task stays at `ready_for_human`; nothing is
  silently rolled back, and nothing is silently retried.

### 6.4 Stale-apply recovery

A crashed `apply` leaves `state: "applying"` with a `pendingOperation` whose
`leaseExpiresAt` eventually passes. Recovery is **not** performed by
`admin recover` (§7.3) — a generic requeue would abandon half-applied host
effects. Instead the next `apply` call whose disposition and `inputDigest`
match takes the lease over: it re-claims through the same revision-guarded
atomic commit as §6.2 (a fresh `human_gate.apply_claimed` event), increments
`attempt`, and resumes at the first step not in `completedSteps` — each resumed
item-creating step reconciling by marker first (§7.2), so a step that ran on
the host but never committed is adopted rather than repeated. A mismatched
disposition against an expired lease is
`pending_operation_mismatch` and requires `--abandon-pending-operation --yes`,
which records `human_gate.abandoned`, clears `pendingOperation`, and returns
the gate to `open` **without** undoing steps that already ran — the operator is
told, in the refusal text, exactly which steps completed.

### 6.5 Idempotency

Five mechanisms, none new:

- **Refusal.** A second `apply` against a `resolved` gate returns
  `gate_resolved`. Idempotent-by-refusal, like `recoverTask`/`recoverHandoff`
  (ports contract §5).
- **Pre-claim short-circuit.** A repeated `hold_for_discussion` against a gate
  already `held` by that disposition returns success without claiming, without
  running `record_hold`, and without emitting an event (§6.1.1). This is the
  only path that answers "already done" with `ok` rather than a refusal, and it
  is available only because `hold_for_discussion` has no host effect to
  reconcile beyond the comment it would otherwise duplicate.
- **Step skipping.** A resume never re-runs a step in `completedSteps`, and
  never recomputes a value already in `stepResults`. This covers every step
  whose completion was committed, but by itself it says nothing about a step
  that ran on the host and crashed before its commit — hence the next
  mechanism.
- **Reconcile-before-create.** Every item-creating step (§7.2) is keyed by the
  stable marker `human-gate:<sessionId>:<issueNumber>:<gateId>:<stepId>` and
  reconciles against it before creating. This — not step skipping — is what
  stops a resumed `supersede` from creating a second replacement item, and a
  resumed `split_followup` from creating a second copy of follow-up item `i`,
  when the crash landed between the host create and the commit that records
  it.
- **Outbox dedup.** Because `runId` is pinned to the gate rather than minted
  per invocation, a resumed apply's re-enqueued comment and label rows collapse
  onto the same `makeOutboxKey(sessionId, issueNumber, runId, topic,
  discriminator)` and are suppressed by `OutboxStore.enqueue()`'s
  `INSERT OR IGNORE` semantics. This is a deliberate departure from admin's
  usual `admin-<command>-<timestamp>` runId, which ports contract §5 shows
  causes a re-run to post a genuine *second* comment rather than dedup. A
  Human Gate apply must dedup, so it must not mint a fresh runId per attempt.

`no-go` is not idempotent-by-dedup and does not claim to be: re-running it
against an `open` gate replaces the feedback (last write wins under the
revision guard) and never appends.

---

## 7. Dispositions

Every disposition below states its precondition, its ordered steps, the
resulting task/work-item/PR state, and its recovery eligibility.

### 7.1 Disposition table

| Disposition | Precondition (beyond §6.1) | Destructive (`--yes`)? | Ordered steps | Resulting task status/phase | Resulting work item | Resulting PR |
| --- | --- | --- | --- | --- | --- | --- |
| `continue_fix` | An open PR is resolvable for the task — `context.prUrl`, else a live check of `context.branch` (falling back to `ai/issue-<n>`); else refuse `no_open_pr`. | No | `requeue_fix_mode` | `queued` / `implementation`, `implementationMode: "fix"` | fix-lane labels | unchanged, reused |
| `continue_fix_recreate_pr` | Same as `continue_fix`, plus the handler support and PR-close port §7.2 requires; else refuse `not_yet_supported`. | Yes | `record_restart_directive`, `requeue_fix_mode` | `queued` / `implementation`, `implementationMode: "fix"`, `implementationRestart: "recreate_branch"` | fix-lane labels | closed and replaced by the implementation phase, not by admin — requires the handler change in §7.2 |
| `split_followup` | At least one structured out-of-scope item, each non-empty after bounding and sanitization; plus `continue_fix`'s open-PR precondition. | Yes | `create_followup_item:0` … `create_followup_item:N-1`, `requeue_fix_mode` | `queued` / `implementation`, `implementationMode: "fix"` | current item keeps fix-lane labels; N new items created | unchanged, reused |
| `supersede` | None beyond §6.1. | Yes | `create_replacement_item`, `cancel_task` | `cancelled` (terminal) | current item closed; replacement item created carrying the No-go rationale | closed |
| `close_not_planned` | None beyond §6.1. | Yes | `cancel_task` | `cancelled` (terminal) | closed as not planned | closed |
| `hold_for_discussion` | None beyond §6.1. | No | `record_hold` | `ready_for_human` (unchanged) | unchanged | unchanged |

### 7.2 Step semantics

- **`requeue_fix_mode`** reuses the existing `enqueueFixModeRequeue` helper
  (`src/cli/admin.ts`) unchanged in shape: `transitionTask()` to
  `queued`/`implementation` with `reviewFeedback` set from the gate feedback,
  then fix-lane label effects, a status comment, and an audit event. Two
  requirements specific to this flow:
  - `reviewFeedbackSource` is `human_gate_no_go`, a new source token added to
    [`human-review-return-flow.md`](human-review-return-flow.md)'s table so the
    two flows share one vocabulary.
  - The gate finalize and the requeue are **the same `transitionTask()` call**,
    committed together with the `human_gate.resolved` event under §4.1's
    primitive. The helper must accept caller-supplied extra context *and* a
    caller-supplied event, so `humanGate`'s `resolved` object is written in the
    same patch that sets `implementationMode: "fix"` and the gate event lands
    in the same transaction. A second, separate write would leave a crash
    window where the task is requeued into fix mode while the gate still reads
    `open` — a task that is simultaneously "running" and "awaiting a human
    decision" is exactly the contradictory state this document exists to
    prevent.
  - Everything *after* that combined call — the fix-lane labels and the status
    comment, which are outbox rows in a different store — inherits the accepted
    non-atomic sequence and crash windows documented in ports contract §4, as
    does the caller's own `task.*` audit event for the requeue. This flow
    does not strengthen that guarantee and must not claim to. §4.1 covers only
    the `human_gate.*` event, which lives in the same store as the task row.
- **`record_restart_directive`** writes `implementationRestart` =
  `"recreate_branch"` into the task context. Admin performs **no git writes**:
  branch reset and PR recreation are Execution mechanics (`DOMAIN.md` §2.3),
  and must be carried out by the implementation handler.

  **This is a required handler change, not existing routing.** `main` does not
  read `implementationRestart` anywhere — the token appears in no source file
  today. The fix-mode path in `src/handlers/implementation.ts` resolves the live
  PR through `resolveFixPr`, checks out that PR's head branch
  (`fixPr.headRefName ?? ai/issue-<n>`), pushes to it, and returns the existing
  `prUrl` in context. Left as-is, a `continue_fix_recreate_pr` apply would be
  indistinguishable from `continue_fix`: the directive would sit unread in the
  task context and the original branch and PR would be reused, which is the one
  outcome the operator chose this disposition to avoid.

  A later implementation must therefore add, before shipping this disposition
  (§14 item 6):
  - handler consumption of `implementationRestart: "recreate_branch"` on a fix
    run, taking a fresh start ref from the base branch instead of the existing
    PR head, and creating a new PR rather than reusing `context.prUrl`;
  - a close of the superseded PR, which needs the PR-close port §11 lists as
    missing — the same gap that blocks `supersede` and `close_not_planned`;
  - clearing `implementationRestart` once consumed, so a subsequent ordinary
    `continue_fix` requeue does not recreate the branch a second time.

  Until those land, `continue_fix_recreate_pr` is refused as "not yet
  supported" on the same fail-closed rule §11 applies to the other blocked
  dispositions. Degrading it into a plain `continue_fix` is not permitted: it
  would report a recreation that never happened.
- **Item creation is reconcile-before-create, always.** `create_followup_item`
  and `create_replacement_item` are the only steps that create a host object,
  and both obey one rule, stated once here and never weakened per step.
  Recording the created number in `stepResults` is **not** sufficient on its
  own: the host create and the `stepResults` commit are two operations against
  two different systems, so a crash between them leaves an item that exists on
  the host and a step that still looks incomplete. A resume that only consulted
  `completedSteps`/`stepResults` would create a duplicate. Therefore:
  - **Stable idempotency key.** Every created item carries the deterministic
    marker `human-gate:<sessionId>:<issueNumber>:<gateId>:<stepId>` — derived
    only from structured fields, never from feedback text (§8.2) — embedded in
    the created item body as a machine-readable line. `<stepId>` is the step ID
    verbatim (`create_followup_item:0`, `create_replacement_item`), so the key
    is unique per item, stable across attempts of the same gate, and never
    collides with an earlier `gateId`'s items.
  - **Reconcile first.** Before creating, the step searches the host for an
    item carrying its marker. Found → adopt that number into `stepResults` and
    mark the step complete without creating anything. Not found → create, then
    commit the number. This is the same rule `DOMAIN.md` §2.3 sets for PR
    creation — reconcile against the existing object, create only if absent —
    applied to the same class of synchronous-create-plus-transition crash
    window it was written for, including process death between the create and
    the transition.
  - **Indeterminate failures reconcile too.** A create whose outcome is unknown
    (timeout, connection reset, ambiguous host error) is never retried blind:
    the step re-reconciles by marker and only then decides to create.
  - Follow-up items are created in list order, one step each, so a partial
    failure resumes precisely, and each resumed step re-reconciles
    independently.
- **`create_followup_item:<i>`** creates one follow-up work item from
  out-of-scope item `i` under the rule above, recording the created number in
  `stepResults`.
- **`create_replacement_item`** creates the superseding work item under the
  rule above, recording its number in `stepResults`.
- **`cancel_task`** is the last step of `supersede` and `close_not_planned`,
  and it is **also their finalize** (§6.3): nothing is committed after it. One
  `TaskStore.cancelTaskWithEffects()` call — *as widened below* — commits all
  of this in one transaction:
  1. the transition to `cancelled`, with `reason` = `human-gate:<disposition>`;
  2. the gate finalize: the complete `humanGate` object with `state:
     "resolved"`, `disposition`, `appliedAt`, `appliedBy`, and **no**
     `pendingOperation` key;
  3. both required events, in order — `task.cancelled`, then
     `human_gate.resolved`;
  4. the sanitized operator-visible comment and the work-item close/label
     effects.

  The widening `main` requires (§4.1), on the **existing** `TaskStore` port and
  in both `SqliteTaskStore` and `MemoryTaskStore`:

  | Parameter | Today | Widened to | Why |
  | --- | --- | --- | --- |
  | `options.context` | absent | optional object merged into the cancelled row's context **in the same `UPDATE`** that sets `status = 'cancelled'`, on top of the existing `cancelledAt`/`cancelReason` merge | Carries the resolved `humanGate` object into the row atomically with the terminal transition. Without it the gate can only be written by a second, non-atomic call. |
  | `options.expected` | absent (no CAS) | optional `{ revision }`, checked **inside the same `IMMEDIATE` transaction, before the `UPDATE`**, returning `{ ok: false, code: "conflict", current }` on mismatch | Same CAS discipline `transitionTask()` enforces (§10.2). A terminal apply that lost the row-level race must write *nothing*: no cancellation, no gate finalize, no events, no outbox rows. |
  | `event` | exactly one `TaskEvent` | `TaskEvent \| TaskEvent[]`, inserted in array order in the same transaction | `task.cancelled` and `human_gate.resolved` are both required audit effects of this commit; one slot cannot carry two. |

  `apply` passes `expected.revision` from its most recent gate commit — the
  claim (§6.2), or the last step commit (§6.3) for `supersede`, which runs
  `create_replacement_item` first — and reports a mismatch as
  `human_gate_conflict`. §4's one-event-per-mutation rule still holds: this
  commit is two mutations, the cancellation and the gate finalize, each
  carrying exactly one event.

  The widening is **backward compatible**. Both of today's callers
  (`admin task cancel` and `admin task reconcile-closed`, `src/cli/admin.ts`)
  pass a single event and neither new option, so their behavior and the
  existing `already_cancelled` / `conflict` refusals are unchanged; the new
  options are opt-in and default to the current semantics.

  Until the widening lands, `supersede` and `close_not_planned` are refused as
  "not yet supported" (§11) — they are already blocked there on the work-item
  close and PR close ports, so no partial application ships in the meantime.
- **`record_hold`** performs no host writes beyond a sanitized status comment
  and writes the `held` gate object. It runs only when the gate is not already
  `held` by `hold_for_discussion`; a repeat is short-circuited before the claim
  (§6.1.1), so the comment is posted
  once per hold decision, not once per invocation.

### 7.3 Recovery eligibility

The rule, stated once: **a live gate blocks generic recovery; a resolved gate
does not; a terminal disposition is structurally unrecoverable.**

| Gate `state` | Task status | `admin recover --from ready_for_human` | `admin recover` (generic) | `admin recover-cap-handoff` |
| --- | --- | --- | --- | --- |
| `open`, `applying`, `apply_failed`, `held` | `ready_for_human` | **refused** `human_gate_unresolved` | not applicable — `ready_for_human` ∉ `RECOVERABLE_STATUSES` | **refused** `human_gate_unresolved` |
| `resolved`, disposition `continue_fix` / `continue_fix_recreate_pr` / `split_followup` | `queued` → later `ready_for_human` again | allowed — a later, independent handoff is a normal recovery target | normal rules | normal rules |
| `resolved`, disposition `supersede` / `close_not_planned` | `cancelled` | not applicable — status is not `ready_for_human` | not applicable — `cancelled` ∉ `RECOVERABLE_STATUSES` | not applicable |
| absent | any | normal rules | normal rules | normal rules |

Three requirements follow, and a later implementation must satisfy all three:

1. **`recoverHandoff` gains a `human_gate_unresolved` refusal**, structurally
   identical to the existing `tool_request_unresolved` refusal it already
   returns (`src/stores/sqlite-task-store.ts`, issue #677): checked inside the
   same `IMMEDIATE` transaction, before the `UPDATE`, returning
   `{ ok: false, code: "human_gate_unresolved", current }`. `recoverCapHandoff`
   gains the same check. Without it, `admin recover --from ready_for_human
   --phase review` would requeue straight past a live gate, restarting work a
   human explicitly stopped and orphaning any half-applied `pendingOperation`.
2. **The refusal is previewed by `--dry-run`.** `runRecover`'s dry-run branch
   already anticipates `tool_request_unresolved` so a preview never promises a
   recovery the live run refuses; it must anticipate `human_gate_unresolved`
   the same way, and `recoverSkipReason` must expand it into actionable text
   naming `admin human-gate apply` (or `--abandon-pending-operation`) as the
   way out.
3. **Terminal dispositions stay terminal.** `supersede` and
   `close_not_planned` leave the task `cancelled`, which is already excluded
   from both recovery paths on `main`: `RECOVERABLE_STATUSES` is
   `["failed", "claimed", "running"]` and `recoverHandoff` matches
   `fromStatus` exactly. No implementation may add `cancelled` to
   `RECOVERABLE_STATUSES`, teach `recoverTask` to accept it, or invoke
   `recoverHandoff` with `fromStatus: "cancelled"`. Closed and superseded work
   is never restartable by generic recovery; re-doing it means filing new work,
   which is what the replacement item created by `supersede` is for.

---

## 8. Advice and suggested commands

Advice is generated by an AI advisor from the gate feedback and bounded task
metadata. It is **advisory only**: it never selects, pre-authorizes, or
executes a disposition, and `apply` reads nothing from it.

### 8.1 Advice record

| Field | Type | Description |
| --- | --- | --- |
| `source` | `"ai-advisor"` | Provenance token, distinct from operator input. |
| `recommendedDisposition` | disposition | Validated against §1's closed set. |
| `confidence` | `"high"` \| `"medium"` \| `"low"` | |
| `reason` | string | Sanitized, bounded rationale. Display-only. |
| `informationNeeded` | string \| `null` | What is still missing for a confident recommendation. Display-only. |
| `suggestedCommand` | string | Derived by §8.2. **Never model-authored text.** |
| `generatedAt` | ISO-8601 | |

**Fail closed on malformed advice.** If the model's output is unparseable, or
`recommendedDisposition` is not one of the six tokens, or `confidence` is not
one of the three tokens, the **entire** advice record is discarded: `advice` is
absent and `adviceError` records a sanitized reason. Partial advice is never
stored, because a stored partial record invites a reader to trust the fields
that did parse.

### 8.2 Deriving `suggestedCommand`

`suggestedCommand` is built by a pure function from a **static template table
keyed by the validated disposition token**, with exactly two substituted
values, both structurally typed and neither of them free-form text:

- `<sessionId>` — the canonical session ID resolved by the session registry,
  not any value appearing in feedback or advice.
- `<issueNumber>` — the integer `issueNumber` from the task row.

| Disposition | Template |
| --- | --- |
| `continue_fix` | `node dist/cli/admin.js human-gate apply --session-id <sessionId> --issue-number <issueNumber> --disposition continue_fix` |
| `continue_fix_recreate_pr` | `node dist/cli/admin.js human-gate apply --session-id <sessionId> --issue-number <issueNumber> --disposition continue_fix_recreate_pr --yes` |
| `split_followup` | `node dist/cli/admin.js human-gate apply --session-id <sessionId> --issue-number <issueNumber> --disposition split_followup --out-of-scope-item "<describe one out-of-scope concern>" --yes` |
| `supersede` | `node dist/cli/admin.js human-gate apply --session-id <sessionId> --issue-number <issueNumber> --disposition supersede --yes` |
| `close_not_planned` | `node dist/cli/admin.js human-gate apply --session-id <sessionId> --issue-number <issueNumber> --disposition close_not_planned --yes` |
| `hold_for_discussion` | `node dist/cli/admin.js human-gate apply --session-id <sessionId> --issue-number <issueNumber> --disposition hold_for_discussion` |

Prohibitions, all of them absolute:

- **No free-form interpolation.** `feedback`, `feedbackMeta`, `reason`,
  `informationNeeded`, work-item titles, PR titles, GitHub comment text, and
  any other untrusted or operator-authored string must never appear inside
  `suggestedCommand`. The `split_followup` template embeds
  a fixed literal placeholder, never a model-proposed or operator-proposed item.
- **No model-authored commands.** If the model emits a command string, it is
  discarded, not stored and not displayed. `suggestedCommand` is always
  regenerated from the table.
- **Display only.** `suggestedCommand` is text for a human to read, edit, and
  run deliberately. Nothing in the loop executes it, and no path turns advice
  into an `apply` invocation automatically.

This is the `DOMAIN.md` §3 author-channel invariant applied to this flow — the
only text-to-action path is a fixed grammar, structurally parsed, never
LLM-interpreted free text — and the same principle as the typed-operation
allowlist in `DOMAIN.md` §5.4: what may run is decided by a typed identifier in
an allowlist, never by inspecting a command string.

---

## 9. Security constraints

`feedback` and every out-of-scope item are **untrusted input** regardless of
who typed them, matching `human-review-return-flow.md`'s stance and
`DOMAIN.md` §3's channel classification (operator-authored text still transits
third-party content).

- **Bounded before storage**: 4 000 characters recommended, 8 000 hard cap —
  the same bounds as `human-review-return-flow.md`, using the same
  `boundedExcerpt` helper (`src/core/text-sanitize.ts`).
- **Sanitized before storage**: `sanitizeBody(text,
  sessionRedactionPaths(session))` — the same sanitizer both existing paths
  use, so behavior cannot diverge between flows.
- **Never echoed verbatim**: no public comment, work-item body, PR body, or log
  stream contains raw `feedback`, raw out-of-scope items, or raw advice
  `reason`. Public comments carry the gate state, `gateId`, disposition, and a
  bounded excerpt only.
- **Source always recorded**: `feedbackSource` (and `appliedBy`) are required
  so an incident traces back to its input channel.
- **Structured fields only for commands**: §8.2.
- **Confirmation for destructive dispositions**: `--yes` is required for
  `continue_fix_recreate_pr`, `split_followup`, `supersede`, and
  `close_not_planned`, per `admin-cli-contract.md`'s preview-by-default rule.
  A typo'd `--yes` is an unknown option and a hard error, never a silent
  mutation.

---

## 10. Mutation boundary

### 10.1 Every mutation, and the port it goes through

| Mutation | Port |
| --- | --- |
| Read the task and its gate | `TaskStore.getTask()` |
| Write/replace `humanGate` (open, edit, advice, claim, step, finalize, abandon) **with its event** | `TaskStore.transitionTask()` semantics committed together with `TaskStore.appendEvent()` semantics, through the `transitionTaskWithEvent` addition §4.1 requires. Never two independent calls once it lands. |
| Requeue into fix mode | `TaskStore.transitionTask()` (via `enqueueFixModeRequeue`) |
| Cancel **and finalize the gate** for `supersede` / `close_not_planned` | `TaskStore.cancelTaskWithEffects()`, widened per §7.2 to take the gate context patch, an `expected` revision, and both events. Never a cancel followed by a separate gate write. |
| Append any gate event | `TaskStore.appendEvent()`, only as the event half of the atomic commit above — never standalone |
| Render the gate history | `TaskStore.listEvents()` |
| Comments and label changes | `OutboxStore.enqueue()` via `workItemOutbox(outboxStore, session)` |

Forbidden, without exception:

- Raw `better-sqlite3` access or any SQL issued from a Human Gate code path.
- Any write to the `tasks` table that bypasses `TaskStore` (`DOMAIN.md` §2.3:
  reaching into internals is forbidden).
- Typing any Human Gate function against `SqliteTaskStore` rather than the
  `TaskStore` interface. Construction stays in the composition roots ports
  contract §10 names; every function below them receives `TaskStore` and
  `OutboxStore`.
- Synchronous host writes from admin for anything the outbox can carry. The
  only synchronous host writes in this flow are the work-item creations in
  `create_followup_item` / `create_replacement_item`, which need the created
  number as a return value — the same justified exception `DOMAIN.md` §2.3
  grants PR creation, and subject to the same reconcile-before-create rule.

### 10.2 Concurrency

Every write is CAS-guarded on `AiTask.revision`, the row-level monotonic
counter `transitionTask` already advances and already accepts in
`TaskExpected`. This flow introduces **no second revision counter inside
`humanGate`** — a gate-local counter would be a rival CAS token that
`transitionTask` does not enforce, and would let a write that lost the row-level
race still look consistent gate-locally. `updatedAt` alone is insufficient for
the reason ports contract §6 gives: two writers in the same millisecond can
read and persist an identical timestamp.

Concurrent-operation behavior:

| Race | Outcome |
| --- | --- |
| Two `no-go` calls | Second loses CAS → `human_gate_conflict`, exit non-zero, nothing written. |
| Two `apply` calls | Second loses the claim CAS → `human_gate_conflict`; only one lease exists, so steps never interleave. |
| `no-go` during `applying`/`apply_failed` | Refused `apply_in_progress` before any write (§5). |
| `apply` racing a phase claim | The claim CAS fails on the changed status; `apply` refuses `not_at_human_gate` rather than mutating a running task. |
| Generic recovery racing a live gate | Refused `human_gate_unresolved` inside `recoverHandoff`'s transaction (§7.3). |
| `admin task cancel` racing an `apply` | `cancelTask`'s existing CAS decides; the loser observes the winner's fully-applied result, never a torn write (`TaskStore.cancelTask` contract). |

### 10.3 Store result codes

Existing codes this flow relies on, all present in `StoreResultCode`
(`src/core/task.ts`) today: `not_found`, `conflict`, `already_cancelled`,
`tool_request_unresolved`.

Required addition for the implementing issue: **`human_gate_unresolved`** — a
new `StoreResultCode` returned by `recoverHandoff` and `recoverCapHandoff` when
a live gate is present (§7.3). It is deliberately distinct from `conflict` so
an operator gets actionable guidance instead of a generic mismatch, exactly as
`tool_request_unresolved` does.

The CLI-level refusal tokens (`not_at_human_gate`, `no_gate`,
`apply_in_progress`, `pending_operation_mismatch`, `gate_resolved`,
`empty_feedback`, `no_open_pr`, `not_yet_supported`, `human_gate_conflict`) are
command-layer reason codes in the JSON output, not `StoreResult` codes. They
must not be added to `StoreResultCode`. `not_yet_supported` is the fail-closed
refusal every disposition blocked on a missing port or handler change returns
(§11).

---

## 11. Port gaps this specification does not paper over

Four host capabilities the dispositions need **do not exist anywhere in the
current tree**, and a later implementation must add them before shipping the
affected dispositions rather than improvising:

| Capability | Why it is missing today | Blocks |
| --- | --- | --- |
| Create a work item | `WorkItemProvider` (`src/providers/types.ts`) has `listCandidateItems`/`getItem`/`getDependencies`/`commentItem`/`transitionItem` and no create. | `split_followup`, `supersede` |
| Find a work item by marker | Reconcile-before-create (§7.2) needs to ask the host "does an item carrying marker `human-gate:…` already exist?". `listCandidateItems` is a queue-selection query and `getItem` needs a number the crashed attempt never recorded; neither can answer it. | the reconcile half of `split_followup`, `supersede` |
| Close a work item | `WorkItemTransition` is `{ kind: "add-label" \| "remove-label" }` only — labels cannot close an item. | `supersede`, `close_not_planned` |
| Close a pull request | `RepoHostProvider` has find/create/get/comment/sticky-comment and no close. | `supersede`, `close_not_planned`, `continue_fix_recreate_pr` |

One **store** capability is missing for the same two dispositions:
`cancelTaskWithEffects()` cannot commit a gate finalize alongside the
cancellation (§4.1). Its widening is specified in §7.2 and scheduled in §14
item 1; it blocks `supersede` and `close_not_planned` exactly as the host gaps
above do.

Consequences a later implementation must respect:

- Until those ports land, `split_followup`, `supersede`, and
  `close_not_planned` cannot fully execute. They must be **rejected with an
  actionable "not yet supported" error**, never silently degraded into a
  partial application that leaves a cancelled task next to an open work item.
- The create and the find land **together**, in the same issue. A create port
  without a marker lookup cannot satisfy §7.2's reconcile-before-create rule,
  and shipping it alone would reintroduce exactly the duplicate-item resume
  this document forbids. Equivalently, a create port that itself takes an
  idempotency key the host enforces (as `commentItem`'s `idempotencyKey` does)
  satisfies the rule without a separate lookup; a create port with neither does
  not.
- `continue_fix` and `hold_for_discussion` need no new host capability and are
  shippable first — they create no host object, so the reconcile rule does not
  apply to them.
- `continue_fix_recreate_pr` creates no host object either, but it is not
  shippable with them. Beyond the PR-close port above it needs a **handler**
  change that is not a port at all: `main` never reads `implementationRestart`,
  so the directive `record_restart_directive` writes would be ignored and the
  original branch and PR silently reused (§7.2). Both must land before the
  disposition ships, and until then it is refused as "not yet supported" on the
  same fail-closed rule as the dispositions above — never degraded into a plain
  `continue_fix`.
- Closing an item from the host UI is already reconciled independently by
  `admin task reconcile-closed` (issue #608), which cancels a task whose work
  item was closed as `not_planned`. That is a reconciliation backstop, not a
  substitute for the ports above: it cannot create a replacement item, cannot
  close a PR, and cannot record which disposition drove the close.
- Every new port must be an outbox topic or a `ProviderResult`-returning
  Integration method, per the `DOMAIN.md` dependency matrix — never a shell-out
  from admin.

---

## 12. Output modes

Both commands follow `admin-cli-contract.md`: human-readable by default,
`--json` forces a stable object, errors in JSON mode go to stdout as
`{ "ok": false, "error": "..." }`, exit `0` on success or safe no-op and
non-zero on refusal.

The JSON object for both commands carries at minimum `ok`, `sessionId`,
`issueNumber`, `gateId`, `state`, and — on refusal — `reasonCode` drawn from
§10.3's command-layer token list. `--dry-run` adds `dryRun: true` and, for
`apply`, the resolved `steps` list, so a preview shows exactly what a live run
would do. A repeated `hold_for_discussion` adds `noop: true` and no `steps`
list (§6.1.1) — it exits `0` like a success, so a caller needs the flag to tell
"already held" from "just held".

---

## 13. Non-goals

- Implementing the CLI commands, the store refusal, or the UI.
- Changing the two-operation interaction model.
- A GitHub App path that raises a No-go automatically. `feedbackSource` reserves
  `github-app-no-go` for it; nothing else here assumes it exists.
- Versioning or archiving prior gates inside `humanGate` — history lives in
  task events (§3, §4).
- Strengthening `enqueueFixModeRequeue`'s documented non-atomic sequence
  (ports contract §4) for labels, the status comment, and the caller's `task.*`
  audit event. That remains its own issue. §4.1 pulls only the `human_gate.*`
  event inside the transition — same store, same connection — and changes
  nothing about the cross-store suffix.
- Modifying production task rows as part of this documentation work.

---

## 14. Follow-up implementation issues

1. **Store refusal and the atomic gate write** — add `human_gate_unresolved` to
   `StoreResultCode`; add the live-gate check to `recoverHandoff` and
   `recoverCapHandoff` in both `SqliteTaskStore` and `MemoryTaskStore`; extend
   `runRecover`'s dry-run preview and `recoverSkipReason`; add
   `transitionTaskWithEvent` to the `TaskStore` port in both adapters (§4.1),
   with a test proving a lost CAS writes neither the patch nor the event; and
   widen `cancelTaskWithEffects` in both adapters with `options.context`,
   `options.expected`, and an ordered event list (§7.2), with tests proving
   that one commit carries both the resolved gate object and both events, that
   a stale `expected.revision` writes nothing at all, and that the existing
   single-event callers are unaffected. Independent of the CLI, and the safety
   floor for everything else.
2. **`human-gate no-go` / `show`** — feedback capture, sanitization, gate
   open/edit/reset, events, status comment. No advice yet.
3. **Advice** — generation, closed-set validation, fail-closed rejection, and
   the §8.2 template table as a pure function with its own unit tests.
4. **`human-gate apply`, non-destructive** — `continue_fix` and
   `hold_for_discussion`, including the combined finalize-plus-requeue write
   (§7.2) and the pre-claim no-op for a repeated hold (§6.1.1).
5. **Host ports** — work-item create plus its marker lookup (or a
   host-enforced idempotency key), work-item close, and PR close (§11).
6. **`continue_fix_recreate_pr`** — on top of issue 5's PR close: teach the
   implementation handler to consume `implementationRestart:
   "recreate_branch"` (fresh start ref from the base branch, new PR instead of
   the recorded `prUrl`, directive cleared once consumed), then enable the
   disposition. Until both land it stays refused as "not yet supported" (§7.2,
   §11) — the directive is inert on `main` and would otherwise reuse the
   original PR.
7. **`human-gate apply`, destructive** — `split_followup`, `supersede`,
   `close_not_planned`, on top of issue 5. `supersede` and `close_not_planned`
   additionally require the widened `cancelTaskWithEffects` from issue 1: the
   fused cancel-plus-finalize of §7.2 is the only shape in which they may
   ship.
