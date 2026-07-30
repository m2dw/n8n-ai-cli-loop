# Task and human-handoff mutation ports for admin extraction

This document specifies the ports admin commands must depend on — instead of
concrete SQLite adapters or raw `better-sqlite3` access — before any admin
command that mutates a task or a human-handoff is safely extractable out of
`src/cli/admin.ts` (issue #710). It reconciles the port surface against the
current `src/core/task-store.ts`, `src/stores/sqlite-task-store.ts`,
`src/stores/memory-task-store.ts`, and `src/cli/admin.ts`/`admin-ui.ts`. PR
#707 is prior-attempt research material; where anything below differs from
it, this document is authoritative. **This is a documentation-only issue: no
production code (interfaces, adapters, or call sites) is changed here — the
port shapes below are a target contract for a later implementation issue.**

This document supersedes the relevant part of #612 and complements
[`admin-command-registry-contract.md`](admin-command-registry-contract.md)
(dispatch/registry, issue #708) and
[`admin-cli-contract.md`](admin-cli-contract.md) (output/exit-code contract).
Those two govern *how a command is invoked and rendered*; this one governs
*what a command is allowed to do to task and human-handoff state*, and
through which typed port it must do it.

## 1. Why this is needed before extraction

Per `docs/DOMAIN.md` §2.3, Orchestration is the sole owner of task rows and
task events, and exposes them only through the `TaskStore` port
(`src/core/task-store.ts`): `enqueueTask` / `getTask` / `claimNextTask` /
`transitionTask` / `releaseClaim` / `appendEvent` / `listEvents` /
`completePhaseWithEffects`. Operation (admin) is documented as reaching
Orchestration only through that port — "reaching into internals (e.g. raw
SQLite writes bypassing the stores) is forbidden."

Today, `src/cli/admin.ts` and `src/cli/admin-ui.ts` do not honor that
boundary at the type level: both `import { SqliteTaskStore } from
"../stores/sqlite-task-store.js"` (the **concrete adapter**, not the
`TaskStore` **interface**) and type their local helpers and command bodies
against `SqliteTaskStore` directly (e.g. `admin-ui.ts:189`
`collectActiveTasks(store: SqliteTaskStore, ...)`). `SqliteTaskStore`
`implements TaskStore`, but it also carries five public methods that are
**not** on the `TaskStore` interface: `listTasks`, `recoverTask`,
`recoverHandoff`, `recoverCapHandoff`, and `clearTaskDelay`. Every admin
command that recovers a task, resets the review-loop cap, clears a delay, or
looks up a task by session (rather than by `TaskKey`) calls one of these five
— so admin code cannot be typed against `TaskStore` as it exists today
without losing functionality, and cannot be extracted into a resource module
without either (a) continuing to import the concrete `SqliteTaskStore` class
(inverting the dependency direction §2.3 forbids), or (b) each resource
module reaching into `better-sqlite3` itself (strictly worse). §3 below
closes that gap by promoting the five methods onto the port.

`workItemOutbox()` (`src/core/outbox-effects.ts:171`) already demonstrates
the target shape: it is typed `(outboxStore: OutboxStore, session:
ResolvedSession): OutboxStore` — against the **interface**
(`src/core/outbox.ts:205`), not `SqliteOutboxStore`. Admin's `TaskStore`
usage should conform to the same pattern; the outbox half of admin's
dependency is already correctly inverted at the type level (`admin.ts`
constructs `new SqliteOutboxStore(...)` — a legitimate composition-root
concern — but every function it calls into, e.g. `workItemOutbox`, already
receives it as `OutboxStore`).

## 2. Inventory: every current Task/handoff mutation admin performs

Every store call any in-scope admin command makes, classified by whether it
already goes through a `TaskStore` port method or reaches a concrete-only
extension:

| Admin command(s) | Store call | Port status today |
| --- | --- | --- |
| `task-status`, `list-stuck` | `store.listTasks(sessionId, issueNumber?)` | **Concrete-only.** Two distinct shapes bundled in one overload — see §3.1. |
| `recover` | `store.recoverTask(key, { phase?, now? })` | **Concrete-only.** |
| `recover` (`--from ready_for_human`) | `store.recoverHandoff(key, { fromStatus, phase, now? })` | **Concrete-only.** |
| `recover-cap-handoff` | `store.recoverCapHandoff(key, { phase?, now? })` | **Concrete-only.** |
| `task clear-delay` | `store.clearTaskDelay(key, { now? })` | **Concrete-only.** |
| `human-review-return`, `github-app-review-return`, `review-verification resolve` (via shared `enqueueFixModeRequeue`) | `store.transitionTask(key, expected, patch)` | Existing port method. |
| `human-review-return`, `github-app-review-return`, `review-verification resolve` | `store.appendEvent(event)` | Existing port method. |
| `human-review-return`, `github-app-review-return`, `review-verification resolve` | `workItemOutbox(outboxStore, session).enqueue(...)` | Existing port method (`OutboxStore`), already correctly typed. |
| `tool-request resolve`, `tool-request run`/`grant` | `store.getTask` / `store.listTasks(sessionId, issueNumber)`, `store.transitionTask`, `store.appendEvent`, outbox enqueue | Same as above — Tool Request state lives entirely in `AiTask.context`, not a separate store (§8). |
| `admin ui` (`collectActiveTasks`, task detail, event list) | `store.listTasks(sessionId)` (bulk), `store.getTask`, `store.listEvents` | `getTask`/`listEvents` are already port methods; bulk `listTasks(sessionId)` is concrete-only (§3.1). |
| `context create` | `SqliteContextStore.upsert` / `.getSessionId` | **Out of scope** — see §2.1. |

### 2.1 `context create` is intentionally out of scope

`admin context create` maps an execution ID to a session ID via
`SqliteContextStore` (`src/stores/sqlite-context-store.ts`) — a two-method,
three-line adapter (`upsert`, `getSessionId`, `close`) over its own tiny
`context_id → session_id` table. It is not a mutation of `AiTask` or of any
human-handoff state, so it is not "a current Task or handoff mutation used by
admin commands" and is excluded from this issue's charter by its own scope
paragraph. Flagging this explicitly so its absence below reads as a decision,
not an oversight: a future issue may still choose to type this adapter
against an interface for consistency, but it carries none of the
recoverability/atomicity/CAS complexity this document exists to pin down.

## 3. Port ownership: extend `TaskStore`, do not create a rival interface

**Decision:** the five concrete-only methods in §2 are added to the existing
`TaskStore` interface (`src/core/task-store.ts`), owned by Orchestration —
not split into a separate `AdminTaskPort` or `TaskRecoveryPort`. Rationale:

- All five read or write the exact same aggregate (`tasks` rows keyed by
  `TaskKey`) that `getTask`/`transitionTask`/`appendEvent` already own.
  Splitting ownership of one table across two interfaces would let a future
  change satisfy one port's invariants while silently violating the other's
  (e.g. a recovery op bypassing `transitionTask`'s CAS discipline because it
  lives in a different type).
- `docs/DOMAIN.md` §2.3 already describes Orchestration's ports as a list of
  commands/queries on one interface, not a family of interfaces; recovery and
  inspection queries are additional task-lifecycle operations, not a new
  bounded context.
- `SqliteTaskStore` already implements all eight existing methods plus these
  five on one class today — promoting them onto `TaskStore` documents an
  adapter/port relationship that already exists in practice; it does not
  invent a new one.

A rival interface would also create exactly the two-owners-one-table problem
DOMAIN.md's dependency matrix exists to prevent (Operation may only reach
Orchestration's state through Orchestration's port, singular).

### 3.1 Target `TaskStore` additions

```ts
export interface TaskStore {
  // ... existing methods unchanged ...

  /**
   * List every task row for a session, most-recently-created-first is NOT
   * guaranteed by the store — callers that need ordering (e.g. admin ui's
   * "most-recently-updated first") sort client-side, as they do today.
   * Replaces the bulk-mode call shape of today's concrete-only
   * `listTasks(sessionId)` (no issueNumber), including the omitted-selector
   * case of the three call sites (`task-status`, `recover`,
   * `recover-cap-handoff`) that pass `issueNumber` as optional (see §9). The
   * required-selector, single-task call shape (`listTasks(sessionId,
   * issueNumber)`, used by 8+ call sites today purely as a clunkier
   * `getTask`) is NOT promoted — those call sites migrate to the existing
   * `getTask({ sessionId, issueNumber })` port method instead (see §9), so
   * the port gains exactly one new query shape, not two.
   */
  listSessionTasks(sessionId: string): Promise<AiTask[]>;

  /**
   * Recover a task stuck in `failed`, or in `claimed`/`running` with an
   * expired lease, back to `queued`. Refuses (returns `conflict`) any other
   * status, or a `claimed`/`running` task whose lease has not yet expired —
   * an active task is never touched. `options.phase` overrides the task's
   * current phase (operator-directed re-route); omitted, the phase is
   * unchanged.
   */
  recoverTask(
    key: TaskKey,
    options?: { phase?: TaskPhase; now?: string },
  ): Promise<StoreResult<AiTask>>;

  /**
   * Recover a task parked in a specific human-handoff status
   * (`options.fromStatus`) back to `queued` at `options.phase`. Refuses
   * (returns `conflict`) if the task's current status does not exactly match
   * `fromStatus` — this is a targeted, human-directed re-route, not a general
   * "unstick anything" operation like `recoverTask`. Refuses (returns
   * `tool_request_unresolved`) if the task carries a live, unresolved
   * implementation Tool Request: that handoff must close through
   * `tool-request resolve`/`tool-request run` (§8), never through a generic
   * requeue, or the Tool Request would be left permanently orphaned in
   * context while the task moves on.
   */
  recoverHandoff(
    key: TaskKey,
    options: { fromStatus: TaskStatus; phase: TaskPhase; now?: string },
  ): Promise<StoreResult<AiTask>>;

  /**
   * Recover a task held at `ready_for_human` by a review-loop cap
   * (`context.reviewLoopCapReached` truthy) back to `queued` at
   * `options.phase` (default `"review"`), clearing `reviewLoopCapReached`,
   * `escalatedEffort`, and resetting `reviewCycles` to 0 so the review cycle
   * restarts fresh. Refuses (returns `conflict`) if the task is not
   * `ready_for_human`, or is `ready_for_human` but the cap flag is not set —
   * this operation is specific to the cap-handoff shape, not a general
   * `ready_for_human` recovery (that is `recoverHandoff`).
   */
  recoverCapHandoff(
    key: TaskKey,
    options?: { phase?: TaskPhase; now?: string },
  ): Promise<StoreResult<AiTask>>;

  /**
   * Clear the `notBefore` delay on a `queued` task so it becomes immediately
   * claimable. Refuses (returns `conflict`) any non-`queued` status — a task
   * that is not queued has no delay window to clear.
   */
  clearTaskDelay(
    key: TaskKey,
    options?: { now?: string },
  ): Promise<StoreResult<AiTask>>;
}
```

`StoreResult<AiTask>` and `StoreResultCode` are unchanged (`task.ts`); no new
result code is introduced. `TaskStatus`/`TaskPhase` are the existing exported
types from `core/task.ts`.

### 3.2 Async normalization is the only shape change, and every non-awaiting call site must migrate

`SqliteTaskStore`'s current `listTasks`, `recoverTask`, `recoverHandoff`,
`recoverCapHandoff`, and `clearTaskDelay` are synchronous methods (no
`Promise` wrapper) — an inconsistency with the rest of `TaskStore`, whose
every method returns a `Promise`. Promoting them onto the port normalizes
this: the adapter wraps its existing synchronous SQLite transaction bodies in
an `async` method (the transaction itself stays synchronous internally —
`better-sqlite3` has no async driver — only the public method signature
changes to return a resolved `Promise`).

This is a type-signature normalization for port conformance, but it is
**not** behavior-neutral by itself: today's call sites read these methods'
return values synchronously, not as `Promise<StoreResult<AiTask>>` /
`Promise<AiTask[]>`. Once a method returns a `Promise`, an un-awaited call
site receives a `Promise` object in place of the `StoreResult`/array it
branches on — `result.ok` reads `undefined` off the `Promise` (a `Promise`
has no `ok` property), so `if (result.ok)` is always false and incorrectly
takes the failure branch even on success, while `if (!result.ok)` is always
true and incorrectly takes the failure branch on every call, success or not
— and `for (const task of store.listTasks(sid))` throws (a `Promise` is not
iterable). A later implementation issue must convert every current
synchronous call site to `await` in the same change that adds the `Promise`
wrapper, not as a follow-up. Concretely, today's known call sites (as of this
writing; the implementing change must re-enumerate them, since new call
sites may be added before extraction lands):

- **Recovery call sites** — `admin.ts`'s `recover` command (`store.recoverTask(...)`
  and, for `--from ready_for_human`, `store.recoverHandoff(...)`) and
  `recover-cap-handoff` (`store.recoverCapHandoff(...)`).
- **Delay call site** — `task clear-delay`'s `store.clearTaskDelay(...)`,
  whose result is read via `storeResult.ok`/`storeResult.current` immediately
  after the call.
- **Bulk-list call sites** — every `store.listTasks(sessionId, issueNumber)`
  and `store.listTasks(sessionId)` call in `admin.ts` (8+ required-selector,
  single-task sites migrated to `getTask` per §9 rather than awaited in
  place; the three optional-selector sites — `task-status`, `recover`,
  `recover-cap-handoff` — migrated to the `getTask`/`listSessionTasks` branch
  per §9; and every unconditional bulk-mode site migrated to
  `listSessionTasks` per §3.1 — must be awaited) and in `admin-ui.ts`'s
  `collectActiveTasks`
  (`for (const task of store.listTasks(sid)) { ... }`), which must become
  `for (const task of await store.listSessionTasks(sid)) { ... }` (or an
  equivalent `Promise.all` fan-out if `collectActiveTasks` is called for
  multiple sessions concurrently).
- **UI call sites** — every other `admin-ui.ts` function typed to accept a
  store and call one of the five methods (task detail/event views, per §10)
  must have its own signature updated to `async` (or already be `async` and
  simply gain the `await`) so the `Promise` is resolved before its result is
  read or rendered.

A later implementation issue's own conformance tests (§11) must fail if any
of these call sites is left un-awaited — this is exactly the kind of
regression the port-conformance suite and per-operation transition/refusal
tests exist to catch mechanically, not by code-review inspection alone.

## 4. Atomicity and transaction boundaries

| Operation | Transaction boundary | Notes |
| --- | --- | --- |
| `transitionTask` | One SQLite `IMMEDIATE` transaction: read row, check `expected`, write patch. | Unchanged; existing port method. |
| `recoverTask` / `recoverHandoff` / `recoverCapHandoff` / `clearTaskDelay` | One SQLite `IMMEDIATE` transaction each: read row, check status/context precondition, write. | Same single-row transactional shape as `transitionTask`, just with a fixed (not caller-supplied) expectation and patch. |
| `listSessionTasks` | Single `SELECT`, no transaction needed (read-only). | |
| `completePhaseWithEffects` | One transaction: task transition + `phase.completed` event + every outbox effect, same connection/file (issue #701). | **Not used by any admin command** — this is Orchestration's own phase-completion path. Admin's analogous four-step sequence below is explicitly *not* given this guarantee. |

**Admin's human-handoff mutations are not transactionally atomic across
stores, and this document does not propose making them so.** The shared
`enqueueFixModeRequeue` helper (used by `human-review-return`,
`github-app-review-return`, and `review-verification resolve`'s failure
path) itself performs two sequential, separately-committed operations, then
returns; its three callers each perform two more on top of that. In call
order, against two different SQLite connections/files-of-record:

1. `store.transitionTask(...)` (task store, inside the helper) — the
   status/phase/context change to `queued`/`implementation`.
2. `enqueueStatusLabelEffects(...)` plus an explicit `gh:label:remove` loop
   (outbox store, inside the helper) — swaps GitHub labels to the fix lane
   (adds `status:needs-fix` + the implementation agent label, removes the
   review-lane labels).
3. `workItemOutbox(outboxStore, session).enqueue(...)` (outbox store, in the
   caller, after the helper returns `ok: true`) — the `gh:comment` status
   comment.
4. `store.appendEvent(...)` (task store, in the caller) — the audit event.

A process crash after step 1 commits (the task has already moved) but before
step 2 loses the label swap; a crash after step 2 but before step 3 loses the
status comment; a crash after step 3 but before step 4 loses the audit event
only. Whether a plain re-run of the same admin command can recover the
missing step(s) once step 1 has committed depends on the specific command —
see §5 for the exact per-command behavior. In short: `review-verification
resolve`'s failure path re-validates the task's pre-transition status/phase
before calling the helper at all, so once step 1 has committed it fails
closed and never reaches steps 2–4 again on rerun — the gap is not
recoverable by re-invoking that command. `human-review-return` and
`github-app-review-return` carry no such precondition, so a rerun replays
the whole sequence (a second transition, label swap, comment, and event)
rather than resuming only the missing step(s). This is the current, accepted
behavior for this operator/GitHub-App-driven path — unlike phase completion
(which runs unattended, at scale, and needed the issue #701 guarantee), a
human-handoff return is a low-frequency, human- or single-webhook-triggered
event where a missing label swap, comment, or audit event is recoverable by
operator inspection of task state and, where rerunning does not apply or is
undesirable (full replay), a manual label/comment/event write or a dedicated
recovery command. **This document intentionally
leaves this multi-step sequence non-atomic** — collapsing it into a
`completePhaseWithEffects`-style single-connection commit would require
admin's task store and outbox store to be opened on a *shared* connection.
They are not today: `SqliteTaskStore` and `SqliteOutboxStore` each open their
own `new Database(dbPath)` in their constructors (`src/stores/sqlite-task-
store.ts`, `src/stores/sqlite-outbox-store.ts`), so admin talks to the task
table and the outbox table over two separate SQLite connections even when
both are pointed at the same file — cross-table atomicity is not available
without first changing that. Sharing a connection is an available option for
a future issue but is out of scope for a documentation-only port definition —
no new workflow behavior is introduced here. Any later implementation that
wants a stronger guarantee must file that as its own issue, exactly like
#701 was for phase completion; it does not fall out of merely defining these
ports.

## 5. Idempotency

Two independent idempotency mechanisms already cover this surface; no new
one is introduced:

- **Task-side re-invocation safety** comes from the *expected-state checks*
  in §6: re-running `recoverTask`, `recoverHandoff`, or `recoverCapHandoff`
  against a task that has already left the state it targets returns
  `conflict`, not a silent duplicate mutation — these three operations are
  naturally idempotent-by-refusal, not idempotent-by-dedup.
  **`clearTaskDelay` is excluded from this mechanism.** Its precondition is
  `status === "queued"` (§6), and a successful call does not change
  `status` — the task is `queued` before and after, with only `notBefore`
  cleared. Re-running `clearTaskDelay` against the same task therefore finds
  the same `status === "queued"` precondition still satisfied and succeeds
  again (a second `UPDATE ... SET not_before = NULL`), rather than returning
  `conflict` on the second call the way the three recovery operations do.
  This is safe to re-run — clearing an already-cleared `notBefore` is a
  harmless no-op write, not a duplicate side effect — but it is
  idempotent-by-no-op-effect, not idempotent-by-refusal, and must not be
  listed alongside the other three as "idempotent-by-refusal" in any later
  implementation's documentation or tests; §11's per-operation
  transition/refusal tests must not assert a `conflict` on `clearTaskDelay`
  re-invocation, since that is not, and is not being made, this operation's
  contract.
- **Outbox-side re-invocation safety** comes from `makeOutboxKey` (used by
  every `human-review-return`/`github-app-review-return`/
  `review-verification resolve` call site) plus `OutboxStore.enqueue`'s
  `INSERT OR IGNORE`-on-idempotency-key semantics, but whether a plain
  re-run after a crash actually *reaches* steps 2–4 (§4) — and so exercises
  this dedup at all — depends on the specific command, since none of the
  three re-derives "did the earlier attempt already commit step 1" from
  anything other than the task's own current status:
  - `review-verification resolve`'s failure path re-validates
    `task.status === "ready_for_human" && task.phase === "review"` before
    ever calling `enqueueFixModeRequeue`. Once step 1 has committed, the
    task is already `queued`/`implementation`, so this precondition fails
    and the command dies *without* calling `transitionTask` again — steps
    2–4 are never retried, and the missing label swap / status comment /
    audit event are **not** recoverable by simply re-running this command.
    An operator must reconcile the gap by hand (inspect task state, and if
    needed enqueue the missing outbox effects / append the missing event
    directly) rather than expect a rerun to fill it in.
  - `human-review-return` and `github-app-review-return` have no such
    precondition — they only refuse a `claimed`/`running` task — and they
    re-read the task fresh at the start of every invocation. After step 1
    has committed, a plain re-run reads the already-updated status/phase as
    its own `expected` value, so its `transitionTask` call matches the
    current row and succeeds again. This does **not** "resume" only the
    missing pieces; it replays the whole sequence (a second transition, a
    second label swap, a second status comment, a second audit event). The
    fresh `runId` minted per invocation (`admin-<command>-<timestamp>`)
    means the second comment lands under a distinct `makeOutboxKey`, so it
    is a genuine second comment, not a `INSERT OR IGNORE`-suppressed
    duplicate of the first.

No admin command in scope needs a new idempotency key scheme, but a later
implementation must not assume every crash in the sequence in §4 is
recoverable by re-invoking the same admin command — only the two paths
above without a state precondition happen to behave that way, and even then
by replaying the full sequence, not by resuming the missing suffix.

## 6. Optimistic/concurrent update failure behavior

Every mutation is guarded by an **expected-state check** before it writes,
and every check failure is `StoreResult<AiTask> = { ok: false, code:
"conflict", current }` (or `"not_found"`/`"tool_request_unresolved"` where
noted) — never a partial or silently-coerced write:

| Operation | Expected-state check | Failure code |
| --- | --- | --- |
| `transitionTask` | Caller-supplied `TaskExpected` (any subset of `status`/`phase`/`ownerRunId`/`leaseExpiresAt`/`updatedAt`/`revision`) matched field-by-field against the current row. | `conflict` (mismatch), `not_found` (no row). |
| `recoverTask` | `status ∈ {failed, claimed, running}`, and if `claimed`/`running`, lease must be expired (`isClaimExpired`). | `conflict`, `not_found`. |
| `recoverHandoff` | `status === options.fromStatus` exactly. | `conflict`, `not_found`, **`tool_request_unresolved`** (live Tool Request present — see §8). |
| `recoverCapHandoff` | `status === "ready_for_human"` **and** `context.reviewLoopCapReached` is truthy. | `conflict`, `not_found`. |
| `clearTaskDelay` | `status === "queued"`. | `conflict`, `not_found`. |
| `enqueueFixModeRequeue`'s `transitionTask` call (used by the three human-handoff commands) | `expected.status === task.status` (the status read moments earlier by the same command invocation) **and**, when the caller supplies `expectedRevision` (review-verification-resolve's failure path), `expected.revision === task.revision`. | `conflict`, `not_found`. |

`revision` (a monotonic per-row write counter, `core/task.ts`) is the CAS
token of record wherever a concurrent-write race is plausible within a single
operator flow (two operators resolving different missing verification
commands on the same task at once); `updatedAt` alone is not sufficient
because two writers whose system clocks land in the same millisecond can
observe (and even persist) an identical timestamp. For that token to be
trustworthy, **every** write path that mutates a task row must advance it —
a caller holding a `revision` read before a concurrent `recoverTask`/
`recoverHandoff`/`recoverCapHandoff`/`clearTaskDelay` write must observe a
mismatch on its next `expectedRevision`-gated write, not a stale match. On
the current tree only `transitionTask`'s `UPDATE` (and
`enqueueFixModeRequeue`'s call through it) does `revision = revision + 1`;
`recoverTask`, `recoverHandoff`, `recoverCapHandoff`, and `clearTaskDelay`'s
`UPDATE` statements do not touch `revision` at all today. This document
therefore requires each of those four `UPDATE` statements to gain
`revision = revision + 1` (mirroring `transitionTask`'s existing clause,
§10) as part of promoting them onto `TaskStore` — a minimal, additive SQL
change, not a new CAS mechanism, but a necessary one: without it, one of
these four mutations landing between a caller's `revision` read and its
later `expectedRevision`-gated write would leave that write unable to
detect the intervening change, silently defeating the guarantee this
paragraph claims. `revision` already exists and is already the mechanism
`enqueueFixModeRequeue` uses when a caller opts in via `expectedRevision`;
this document only closes the four gaps in it.

## 7. Allowed state transitions and fail-closed behavior

Every operation in §3.1/§6 refuses (fails closed, `ok: false`) rather than
coercing state when its precondition does not hold. Concretely, none of
`recoverTask`, `recoverHandoff`, `recoverCapHandoff`, or `clearTaskDelay` has
a "force" mode in the port — every existing `--force`-shaped safeguard in the
current admin commands (e.g. worktree recovery's dirty/ahead-of-origin
overrides) lives in a *different*, non-task-mutating layer (git/worktree
mechanics) and is out of scope here. The **allowed transitions** these four
operations encode are exactly:

- `recoverTask`: `{failed | claimed(lease-expired) | running(lease-expired)}`
  → `queued` (same or overridden phase). Every other current status is a
  fail-closed `conflict`.
- `recoverHandoff`: `{options.fromStatus}` (today only invoked with
  `"ready_for_human"` from the CLI, but the port does not hardcode that
  value) → `queued` at `options.phase`, **unless** a live Tool Request is
  present, in which case `tool_request_unresolved` — the operator is routed
  to `tool-request resolve`/`tool-request run` instead (§8), never silently
  requeued past it.
- `recoverCapHandoff`: `ready_for_human` (with `reviewLoopCapReached`) →
  `queued`/`review` (or overridden phase), clearing cap/escalation context.
  Any other status, or `ready_for_human` without the cap flag, is a
  fail-closed `conflict`.
- `clearTaskDelay`: `queued` → `queued` (mutating only `notBefore`). Any
  other status is a fail-closed `conflict`.

A later implementation must preserve every one of these transition/refusal
pairs exactly; widening any of them (e.g. letting `recoverHandoff` requeue a
task with a live Tool Request, or letting `recoverTask` touch a
lease-unexpired `claimed` task) is new workflow behavior and requires its own
issue, not a silent side effect of the extraction this document enables.

## 8. Tool Request resolution and continuation

Tool Request state is **not** a separate store or port — it lives entirely
inside `AiTask.context` (`toolRequest`/`resolved`/`resolution`/
`rejectRecoveryConsumed`, read by `hasUnresolvedToolRequest`/
`readStoredToolRequest` in `core/tool-request.ts`) and is mutated exclusively
through the existing `transitionTask` port method with a `context` patch (a
shallow merge over the current context, per `applyTaskPatch`,
`core/transitions.ts`: `{ ...task.context, ...patch.context }`).

**`applyTaskPatch` itself does not remove keys.** A patch field set to
`undefined` (e.g. the fix-mode cleanup patches that null out
`toolRequest`/`resolution`-adjacent context fields) is spread into the
merged object as an explicit `key: undefined` own property — it is not
deleted from the result. `SqliteTaskStore` today produces the *appearance*
of key removal only as a side effect of persistence: it serializes `context`
via `JSON.stringify` before writing, and `JSON.stringify` silently drops
object properties whose value is `undefined`, so the row it reads back on
the next `getTask` has no trace of the key. This is a serialization-layer
effect of one adapter, not a guarantee `applyTaskPatch` provides. A proposed
`MemoryTaskStore` implementation of the same port method that stores the
merged `AiTask` object in-memory without a serialize/deserialize round trip
would retain the key with value `undefined` — observably different from
`SqliteTaskStore` for any caller that checks `"key" in task.context` or
enumerates `Object.keys(task.context)`, even though both adapters agree that
`task.context.key === undefined`. A later implementation issue must close
this gap explicitly — either (a) have `applyTaskPatch` delete
`undefined`-valued keys from the merged `context` (and `attempts`) object so
both adapters share one, serialization-independent semantics, or (b) if the
implementation instead leaves `applyTaskPatch` as-is, document the two
adapters' key-presence behavior as intentionally different and require
`MemoryTaskStore`'s conformance-suite fixtures (§11) to assert only on
`context.key === undefined`, never on key presence, for every `undefined`-
patch case exercised. Option (a) is preferred: it removes the divergence
instead of just documenting around it, and every call site that patches
`context` today already treats `undefined` as "clear this field," never as
"explicitly store `undefined`."

Both `tool-request resolve` (reject/manual-done) and `tool-request run`/
`grant` (guided run) read the task via `getTask`, apply their business rules
as **pure functions** already extracted into `core/tool-request.ts` and
`core/tool-request-grant.ts`/`core/tool-request-changes.ts` (parsing,
hashing, matching, redaction — no store access in any of the three modules),
and commit the outcome via `transitionTask` + `appendEvent` + an outbox
enqueue, the same three primitives as §4/§5.

No new port operation is required for Tool Request resolution — the existing
`transitionTask`/`getTask`/`appendEvent` triad is sufficient. What must be
preserved verbatim when this logic moves into a resource module:

- **Already-resolved gate**: `existing["resolved"] === true` refuses any
  further resolution, with exactly one exemption.
- **One-shot reject-recovery exemption**: a plain `reject` (no command run,
  no requeue) may be resumed by exactly one subsequent `manual-done`, gated
  on all of: `resolved === true`, `resolution.action === "reject"`,
  `rejectRecoveryConsumed !== true`, `status === "ready_for_human"`, `phase
  === "implementation"`. Consuming the exemption stamps
  `rejectRecoveryConsumed: true` on the *preserved* (not overwritten)
  original `reject` resolution, so the resumed prompt-context still reflects
  that no command actually ran.
- **Active-task refusal**: `claimed`/`running` status refuses any
  resolution/grant (`conflict`-shaped human error, not a `StoreResult`
  conflict — these are pre-transition guard clauses the resource module must
  keep as-is).
- **Review-claim backstop**: `claimNextTask` itself refuses to claim a
  `review`-phase task with a live Tool Request (`hasUnresolvedToolRequest`),
  so a stale row can never reach review out from under an unresolved
  handoff — this is `TaskStore.claimNextTask`'s existing filter, unchanged,
  and is the reason `recoverHandoff`'s `tool_request_unresolved` refusal
  (§7) matters: without it, an operator could requeue straight past the
  guard `claimNextTask` itself enforces.

## 9. `listTasks(sessionId, issueNumber)` calls migrate to `getTask` or to `listSessionTasks`, depending on whether the selector is required

`store.listTasks(sessionId, issueNumber)` has two distinct call shapes in
`admin.ts` today, and they migrate to two different port methods — neither
migrates them all onto a single call:

- **Required-selector, single-task sites** (`--issue-number` is a required
  flag; the command errors out before ever reaching the store call if it is
  omitted): `task clear-delay` (`admin.ts:1519`), `human-review-return`,
  `github-app-review-return`, `review-verification resolve`, and
  `tool-request resolve`/`run`/`grant` — eight-plus call sites that call
  `store.listTasks(sessionId, issueNumber)` and then take `[0]` (with a
  `length === 0` not-found check) purely to look up one task by key — a call
  shape `getTask({ sessionId, issueNumber })` already provides more directly
  (`AiTask | undefined`, no array indexing). These call sites migrate to
  `getTask` when each command is extracted.
- **Optional-selector, bulk-capable sites**: `task-status` (`admin.ts:853`),
  `recover` (`--from ready_for_human`, `admin.ts:1198`), and
  `recover-cap-handoff` (`admin.ts:1368`) each take `issueNumber` as an
  *optional* flag and pass it straight through to `listTasks(sessionId,
  issueNumber)`. When `--issue-number` is supplied, the call still narrows to
  one task and the result is used the same way a single-task lookup would be
  (`task-status` maps over it, `recover`/`recover-cap-handoff` filter it by
  status). When `--issue-number` is *omitted*, the same call intentionally
  returns every task in the session — `task-status` reports session-wide
  status, and `recover`/`recover-cap-handoff` recover every eligible task in
  the session, not just one. Collapsing this call shape onto `getTask` would
  make the omitted-selector case inexpressible (`getTask` requires a single
  `issueNumber` and returns at most one task), silently breaking the
  documented "no `--issue-number` means session-wide" behavior of these three
  commands. These three call sites migrate to an explicit branch instead:
  `issueNumber !== undefined ? await store.getTask({ sessionId, issueNumber
  }).then((t) => (t ? [t] : [])) : await store.listSessionTasks(sessionId)`
  (or the equivalent conditional already used by `runWorktreeRecovery`,
  `admin.ts:4623-4624`, which branches between the two call shapes rather
  than always calling the bulk form).

This document specifies these two migrations, rather than promoting the
two-argument `listTasks` overload onto the port — one bulk query
(`listSessionTasks`, §3.1) and one single-key query (`getTask`, already
ported) is a tighter port surface than a single method whose behavior
branches on whether its second argument is present. This is a call-site
correction, not a new capability, and produces identical `{ ok, task }` /
`{ ok, tasks }` outcomes (a `getTask` miss maps to the same "Task not found"
message the current `tasks.length === 0` check produces; an omitted selector
maps to the same full-session result the current unconditional
`listTasks(sessionId)` call — or `listTasks(sessionId, undefined)` — already
produces).

## 10. Adapter and test-double responsibilities

- **`SqliteTaskStore`** (`src/stores/sqlite-task-store.ts`) remains the sole
  production adapter. Its five concrete-only methods become the concrete
  implementations of the five new `TaskStore` methods (§3.1); each method's
  existing single-row `IMMEDIATE` transaction body is unchanged except for
  the `revision` fix required by §6: `recoverTask`, `recoverHandoff`,
  `recoverCapHandoff`, and `clearTaskDelay`'s `UPDATE` statements each gain
  a `revision = revision + 1` clause (matching `transitionTask`'s existing
  clause), and its public signature gains the `Promise` wrapper (§3.2). No
  other SQL, schema, or transaction semantics change.
- **`MemoryTaskStore`** (`src/stores/memory-task-store.ts`) already
  `implements TaskStore` and is already the fake used by `phase-runner`
  tests (Orchestration-side). It does **not** yet implement the five new
  methods, so it cannot stand in for `SqliteTaskStore` in any admin test
  today. A later implementation issue extends `MemoryTaskStore` with the
  same five methods (mirroring `recoverTask`/`recoverHandoff`/
  `recoverCapHandoff`/`clearTaskDelay`/`listSessionTasks`'s semantics over
  its in-memory `Map`, the same way it already mirrors `claimNextTask`'s
  Tool Request-review filter and `completePhaseWithEffects`'s effect
  application), making it a complete `TaskStore` fake usable by admin
  resource-module unit tests, not just Orchestration tests.
- **Composition roots**: `admin.ts` is not the only executable entrypoint —
  `admin-ui.ts` is its own separate CLI (`admin ui`'s standalone equivalent,
  invoked directly, not dispatched through `admin.ts`) whose own top-level
  startup already constructs `new SqliteTaskStore(parsed.dbPath)` before
  passing it into `interactiveLoop`. Restricting construction to `admin.ts`
  would leave `admin-ui.ts` with no legitimate way to obtain a `TaskStore` at
  all. Both files' top-level command/startup code — `admin.ts`'s command
  dispatch (or its resource-module successors) **and** `admin-ui.ts`'s
  startup function that calls `interactiveLoop` — are the permitted
  composition roots *for the admin surface*: each constructs its own `new
  SqliteTaskStore(dbPath)` exactly once, at its own entrypoint. Every
  function signature below either construction point — command handlers,
  `enqueueFixModeRequeue`, a future `tool-request` resource module, and
  every `admin-ui.ts` function that receives the store as a parameter
  (`interactiveLoop`, `collectActiveTasks`, task-detail/event views, per §11
  item 8) — is typed against `TaskStore` (the interface), never
  `SqliteTaskStore` (the class), mirroring `workItemOutbox`'s existing
  `OutboxStore`-typed signature (§1). This is what makes "no proposed admin
  resource module requires raw SQLite access" true: a resource module
  receives a `TaskStore` (and, where it posts comments, an `OutboxStore`)
  through its function parameters and never imports `better-sqlite3` or
  `sqlite-task-store.js` itself — `admin.ts` and `admin-ui.ts` are the only
  places an admin resource module's own call chain constructs the concrete
  adapter.

  This "two composition roots" framing is scoped to the admin surface this
  document extracts, not a claim about the whole source tree. On the
  current tree, `src/cli/enqueue-task.ts`, `src/cli/github-intake.ts`, and
  `src/cli/run-one-phase.ts` are independent CLI entrypoints that already
  construct their own `new SqliteTaskStore(dbPath)` at their own top level,
  for the same reason `admin-ui.ts` does — each is its own composition root,
  unrelated to `admin.ts`'s command dispatch, and none of them is a proposed
  admin resource module. This document does not require them to change, and
  a later implementation must not treat their existing `SqliteTaskStore`
  imports as a violation of this contract.

## 11. Required contract and integration tests

None of the following exist today; a later implementation issue must add
them alongside the `TaskStore` port extension so behavior preservation is
machine-checked:

1. **Port conformance suite** — one shared test suite (parameterized over
   `SqliteTaskStore` and `MemoryTaskStore`) exercising every method in §3.1
   against both adapters, asserting identical `StoreResult` shapes for the
   same fixture — the mechanism `test/memory-task-store.test.js` already
   uses for the pre-existing methods, extended to the five new ones. This is
   the test that proves the fake is a legitimate substitute, not just a
   same-shaped stand-in.
2. **Per-operation transition/refusal table** — one test per row of §7's
   allowed-transition list, asserting both the success path and every
   documented `conflict`/`not_found`/`tool_request_unresolved` refusal,
   run against the conformance suite so it covers both adapters at once.
3. **`getTask` migration parity** — for each of the 8+ required-selector call
   sites in §9, one test asserting the not-found error message/shape is
   byte-identical before and after the `listTasks(sessionId, issueNumber)` →
   `getTask` migration (a regression net for the call-site rewrite itself).
   For the three optional-selector call sites (`task-status`, `recover`,
   `recover-cap-handoff`), an additional pair of tests per site asserts the
   `--issue-number`-supplied branch matches the pre-migration single-task
   result and the `--issue-number`-omitted branch still returns every task
   in the session (not just the case that happens to exercise `getTask`).
4. **Reject-recovery one-shot exemption** — a test driving `reject` →
   `manual-done` (consumes the exemption) → a second `manual-done` (must
   refuse), pinning §8's `rejectRecoveryConsumed` gate.
5. **`recoverHandoff` Tool Request guard** — a test asserting
   `recoverHandoff` returns `tool_request_unresolved` (not a silent requeue)
   when a live Tool Request is present, and that the existing
   `tool-request resolve`/`run` path remains the only way to clear it.
6. **Non-atomic four-step sequence, documented not hidden** — one test per
   crash window in `enqueueFixModeRequeue`'s call-order sequence (§4): (a)
   crashing/throwing between step 1 (`transitionTask`) and step 2 (label
   effects, inside the helper) asserts the task *has* transitioned while no
   label-change outbox rows exist; (b) crashing between step 2 and step 3
   (the caller's status-comment enqueue) asserts the label-effect rows exist
   but no status-comment row does; (c) crashing between step 3 and step 4
   (the caller's `appendEvent`) asserts the status-comment row exists but the
   audit event does not. Together these pin the current, accepted
   non-atomicity at every boundary so a future change that tries to "fix" it
   silently is forced to update these tests deliberately, not by accident.
7. **Resource-module composition-root check** — a static/lint-level check
   (or a test asserting via `tsc`/type-only import inspection) that no
   *admin resource module* (the files extracted from `admin.ts` per this
   document's charter, plus every `admin-ui.ts` function other than its
   startup function, §10) imports `SqliteTaskStore` as a value —
   construction stays confined to `admin.ts`'s command dispatch and
   `admin-ui.ts`'s startup function (§10) — so a future resource module
   cannot silently reintroduce the concrete-adapter dependency this document
   exists to remove. This check is scoped to the admin surface: it must not
   flag the pre-existing, unrelated `SqliteTaskStore` constructions in
   `src/cli/enqueue-task.ts`, `src/cli/github-intake.ts`, or
   `src/cli/run-one-phase.ts`, each its own independent composition root
   outside this document's charter (§10).
8. **Admin-ui read-path port typing** — a test (or a compile-time check)
   confirming `collectActiveTasks` and the task-detail/event views in
   `admin-ui.ts` are typed against `TaskStore`, not `SqliteTaskStore`, after
   migration — otherwise admin-ui's read path silently reintroduces the same
   concrete dependency the CLI's write path removed.
9. **Recovery-mutation revision advance** — one test per `recoverTask`/
   `recoverHandoff`/`recoverCapHandoff`/`clearTaskDelay`, asserting the
   returned task's `revision` is strictly greater than the pre-write
   `revision`, run against the conformance suite (item 1) so both adapters
   are pinned. This is the regression net for §6/§10's requirement that
   these four `UPDATE` statements gain `revision = revision + 1`.

## 12. Preservation guarantees

A later implementation must preserve, unchanged:

- Every `StoreResult` code and shape currently returned by the five
  concrete-only methods, once promoted onto `TaskStore`.
- Every allowed-transition/refusal pair in §7, and every expected-state check
  in §6 — widening any of them is new workflow behavior requiring its own
  issue.
- The non-atomic, four-step `enqueueFixModeRequeue` call-order sequence
  (transition, then label effects inside the helper; status comment, then
  audit event in the caller) and its accepted crash-window behavior (§4),
  unless a future issue explicitly proposes and scopes a stronger guarantee.
- The Tool Request resolved/reject-recovery/active-task/review-claim
  invariants in §8, verbatim.
- `context create`'s exclusion from this port surface (§2.1) — it is a
  deliberate scope boundary, not a gap to be filled by inertia.
