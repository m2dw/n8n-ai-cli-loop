# Callable operation-dispatch port

Status: **approved design, implemented at the port layer**
(`src/core/operation-port.ts`, `src/core/chatops-operation-dispatch.ts`). No
operation is registered yet — this document defines the boundary an operation
is invoked across, not which operations exist.

This "implemented" status is component-level, not end-to-end: see
[feature-status.md](feature-status.md) for ChatOps's overall availability,
which stays `foundation-only` until comment ingestion, dispatch, and result
publication are connected.

This is issue #783, the successor `docs/chatops-execution-ledger-contract.md`
§19 names: "the callable interface an attempt invokes between §8's steps 1 and
3". It specifies exactly one thing — how an already-existing, resource-oriented
admin operation is invoked programmatically by an adapter that is not a
terminal. It supersedes the callable-dispatch portion of #779 and of #696 /
PR #776.

It does **not** specify which verbs exist, how a ChatOps command maps onto an
operation, which parameters a given surface may set, how an outcome is
published back to a comment, or how the Tool Request gate tiers a typed
operation. Those are #784, #785, and #697 (§16).

The review of PR #776 found the failure this document exists to prevent: that
PR built its dispatch step on a seam its cited prerequisite did not provide,
and the fallback available to it — reconstructing an admin CLI command string
and running it — would have made a comment's contents the input to a command
line. §11 states what the real prerequisite is, in a form that can be checked
rather than assumed.

## 1. Why a callable port, and why not the alternatives

There is exactly one implementation of "resolve a Tool Request", "release an
issue lock", "clear a task delay" — and there are now four callers that want
it: the admin CLI, `admin ui`, the ChatOps comment surface, and a future
GitHub App. Three ways to connect them exist, and two are wrong for reasons
worth writing down, because both are locally convenient and repeatedly
proposed:

- **Rebuild an argv string and spawn `admin.js`.** `admin-ui.ts` already does
  this (`docs/admin-command-registry-contract.md` §8), so there is precedent
  and it works — for a caller whose arguments are its own. ChatOps's arguments
  are not: they came from a comment. Recognition already refuses shell
  metacharacters and never hands a string to a shell
  (`docs/chatops-command-grammar-contract.md` §1, §2), and an argv-spawn with
  no shell preserves that. What it does not preserve is *legibility of the
  trust boundary*: once the call site is a token array, "which of these tokens
  came from a person on the internet and which from the session" is a question
  answered by reading the assembly code, every time, forever. It also inherits
  the CLI's whole surface — a flag the operator surface adds tomorrow is a flag
  ChatOps can pass today, with no type, no review, and no compile error.
- **Reimplement the operation in the adapter.** This trades one problem for a
  worse one: two implementations of a destructive operation that drift, of
  which only one is covered by the tests everyone knows about.
- **Call the operation as a function** (this document). The adapter supplies
  typed parameters and a separately-typed trusted context; the operation
  returns a typed result. Nothing is parsed, nothing is spawned, nothing is
  printed, and the trust boundary is a type signature rather than a habit.

The port is also what makes the ChatOps ledger's guarantee reachable at all.
`docs/chatops-execution-ledger-contract.md` §8 places the operation invocation
between two local transactions, and §11 makes the whole at-most-once argument
depend on knowing whether an attempt produced an external effect. A subprocess
that exits non-zero cannot answer that question; a typed result can, and §7's
`effect` field is where it answers it.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| **Operation** | One resource-oriented unit of admin behavior, identified by a typed id (`tool-request.run`), implemented once, invoked by any adapter. |
| **Adapter** | A surface that turns some external event — an argv, a keypress, a webhook, a comment — into one invocation. |
| **Request** | The untrusted half of an invocation: an operation id plus that operation's declared parameters. |
| **Context** | The trusted half: who is asking, in which session, scoped to which work item, may they apply changes, and under what request id. |
| **Result** | The typed value an operation returns. Never rendered output, never an exit code. |
| **Effect** | What an invocation did outside this process: `applied`, `none`, or `unknown`. |
| **Definite** | A result whose `effect` is `applied` or `none`. `unknown` is the only indefinite one. |
| **Registry** | The collection of descriptors a composition root assembled; the only way an adapter reaches an operation. |
| **Operation core** | The part of a command handler that decides and acts, with the argv parsing, output rendering, and process exit removed (§11). |

## 3. Ownership

### 3.1 The owning context is Operation

`docs/DOMAIN.md` §2.3 already places this: **Operation** owns
"admin/status/doctor/metrics" and its entry says, verbatim, that "the ChatOps
adapter #696 is a second entry point over the same ports". This document is
that sentence made executable. Operation owns no state of its own — it
operates other contexts' state through their public ports — and the operation
port inherits exactly that posture: it is a *calling convention*, not a store,
and every durable thing an operation touches it touches through the owning
context's existing port (`TaskStore`, `OutboxStore`, `SessionRegistry`,
`IssueWorktreeLock`, the provider adapters).

Consequences that follow from the placement and are not separately negotiable:

- An operation may not reach into another context's internals to shortcut its
  own port. DOMAIN.md §2.3's Operation row already forbids it ("reaching into
  internals — e.g. raw SQLite writes bypassing the stores — is forbidden"), and
  a callable port makes the temptation larger, not smaller, because the caller
  is no longer a human who would notice the command doing something surprising.
- An operation may never invoke a phase handler. DOMAIN.md §2.3 ends with the
  rule that Operation "may invoke separately defined maintenance ports … but
  never phase handlers directly"; phase handlers are invoked only by
  `runNextPhase`. ChatOps gains no exception: `/grant` resolves a Tool Request
  through the same port `admin tool-request run` uses, and the loop picks the
  work up on its next phase.

### 3.2 Dependency direction

`src/core/operation-port.ts` declares the port and depends on nothing —
not on `src/cli/`, not on `src/handlers/`, not on any adapter. Operation
modules are *pulled inward* by a composition root that passes descriptors to
`createOperationRegistry`; a module never reaches back into a registry to
register itself. This is the same direction
`docs/admin-command-registry-contract.md` §8 fixes for CLI command
registration, restated here because a registry is exactly the structure that
invites the inversion.

`src/core/chatops-operation-dispatch.ts` is the ChatOps-specific binding: it
builds a context from ledger-scope facts and maps a result onto a ledger event
(§9). It depends on the port and on the ledger's types; the port does not
depend on it. Adding a second binding (a GitHub App one) adds a sibling
module, never a branch inside the port.

## 4. The typed request

### 4.1 Shape

```ts
interface OperationRequest {
  operationId: string;   // "resource.action", lower-kebab both sides
  params: Readonly<Record<string, OperationParamValue | readonly OperationParamValue[]>>;
}
```

`OperationParamValue` is `string | number | boolean`. There are no nested
objects, and there is **no `argv` field, no `command` field, and no free-form
string that a downstream layer interprets**. A repeated parameter is an array
under its own name — never a positional token list, because positional meaning
is the property that makes a token array unreadable at a glance.

`operationId` mirrors the CLI's resource/action identity
(`docs/admin-command-registry-contract.md` §3) so one operation can back both
surfaces without a translation table. It is still not a command string: it is
never split on whitespace, never re-joined into argv, and never interpolated
into anything.

Each operation declares its parameters:

```ts
interface OperationParamSpec {
  name: string;                 // lower-kebab, the CLI flag spelling minus "--"
  type: "string" | "number" | "boolean";
  required?: boolean;
  repeated?: boolean;
}
```

Validation is closed in both directions: an unknown parameter is refused
(never ignored), a missing required parameter is refused, a wrong type is
refused, and an array for a non-repeatable parameter is refused. Silently
dropping an unrecognized parameter would mean an invocation can do something
other than what its caller wrote down, which is precisely the property this
port exists to remove.

**The validated request is a snapshot, not the caller's object.** `params` is
untrusted data supplied by an adapter, so it may be a proxy or an object of
getters, and it remains writable by whoever built it for the whole invocation.
The port therefore reads each name and value exactly once, into a frozen plain
request (repeated values copied into a frozen array), validates *that*, and
passes *that* to the handler. Validating one object and executing against
another would let a value answer `safe` to the check and `other` to the
operation — an action applied to data that never passed validation, which is
indistinguishable, from the ledger's side, from one that did.

The snapshot has **no prototype**, because `params` is JSON an adapter decoded
and JSON may carry an own `"__proto__"` key. Copied into an ordinary object,
that name reaches `Object.prototype`'s inherited setter rather than becoming an
own key: the validation that enumerates own keys would never see it, and the
handler would then read a declared parameter it inherited from the object the
caller installed. With no prototype it is an ordinary own key — snapshotted,
seen, and refused as an unknown parameter, since no declared name can spell it
— and there is nothing for a handler to inherit under a parameter's name.

Declaring a parameter is **not** the same as permitting a surface to set it.
Per-surface argument allowlists are #784's scope; a declared parameter says
only "this operation understands this input", never "a comment may supply it".

### 4.2 Descriptor and registry

```ts
interface OperationDescriptor {
  id: string;
  summary: string;                       // one line, operator-facing
  mutating: boolean;                     // true when a confirmed run changes durable state
  scope: "session" | "issue";
  params: readonly OperationParamSpec[];
  run(invocation: { request; context }): OperationResult | Promise<OperationResult>;
}
```

`createOperationRegistry(descriptors)` **throws** on a duplicate id, a
malformed id or parameter name, a blank summary, a parameter that collides
with a reserved context name (§5.1), or a parameter declaring an unknown `type`
or a non-boolean `required` / `repeated`. `invokeOperation` **returns a result** for
every invocation-time problem. The asymmetry is deliberate: a bad descriptor is
a defect at the composition root that must stop the process before it serves
anyone, while a bad request is ordinary untrusted input that must produce an
answer — including when the answer goes into a durable ledger row.

`mutating` is not decorative: together with `confirmed` it is the pair §5.2's
postcondition checks, so declaring an operation non-`mutating` is a claim the
port will hold it to. Because it is a claim the port checks rather than a label
it repeats, `mutating`, `scope`, and `run` are validated at registration too: a
non-boolean `mutating` and an unrecognized `scope` are registration defects,
the latter because a third value would match neither scope check and so be
checked by nothing.

Each parameter spec is validated the same way and for the same reason: its
`type`, `required`, and `repeated` fields decide how §4.1 reads a supplied
value, so a descriptor that came from unchecked JavaScript or from
configuration must not be able to declare one the port would then misread. An
unrecognized `type` (`"json"`, say) would fall through to the boolean check and
have its values validated as booleans, and a truthy but non-`true` `required`
or `repeated` would silently make a required parameter optional and a
repeatable one non-repeatable — a descriptor serving requests under semantics
it did not declare.

**The registry stores an immutable copy of each descriptor**, and `get`/`list`
hand that copy out. Registration reads every field exactly once and freezes the
result — the descriptor, its parameter list, and each parameter spec — so a
composition root, or the operation's own handler, that still holds the object it
supplied cannot re-declare the operation afterwards. Without this, a handler
could set `mutating = true` on its own descriptor during one invocation and have
the *next* invocation accept `applied` effects from an operation that was
registered as non-mutating, which is the guard in §5.2 defeated one call later
than it looks.

`scope` is checked by the port, not by each operation: an `issue`-scoped
operation requires `context.issueNumber`, and a `session`-scoped one requires
its absence. Both mismatches are rejected as `invalid-context`. Leaving this
to each operation is how one of them eventually forgets and starts accepting a
work item it will silently ignore.

## 5. The trusted execution context

```ts
interface OperationContext {
  surface: "admin-cli" | "admin-ui" | "chatops" | "github-app";
  actor: { kind: "human" | "automation"; id: string };
  sessionId: string;
  issueNumber: number | null;
  requestId: string;
  confirmed: boolean;
  deadlineMs: number | null;
}
```

Every field is established by the adapter from authenticated channel state and
**never** from request parameters:

| Field | Where an adapter gets it | Where it may never come from |
| --- | --- | --- |
| `surface` | The adapter's own identity, a constant. | Anything at runtime. |
| `actor` | The authenticated caller — a shell user, an allowlisted comment author from the immutable first-seen record (`docs/chatops-comment-cursor-contract.md` §9), an app installation. | The comment body, a parameter, a provider field describing the *target* rather than the author. |
| `sessionId` | The session the process was started with, or the ledger scope's identity (`docs/chatops-identity-contract.md` §6). | A parameter, ever — this is the field that would let a comment retarget another session. |
| `issueNumber` | The work item the event arrived on, unconditionally. | A parameter. The grammar deliberately gives a comment no token shape for retargeting another issue (`docs/chatops-command-grammar-contract.md` §2, last rule); this is where that promise is kept. |
| `requestId` | Derived from durable scope (§9.1). | A caller-chosen string, which would let two invocations claim one identity. |
| `confirmed` | The adapter's own gate (§5.2). | A parameter (see §5.1). |
| `deadlineMs` | The adapter's budget. | A parameter, since a caller-chosen deadline is a caller-chosen denial of the next caller's turn. |

The two halves are separate arguments of separate types. That is the whole
enforcement mechanism for "trusted context is distinct from user-supplied
parameters": there is no merge step, no spread of one into the other, and no
single "options" bag where a reader has to remember which key is which.

### 5.1 Reserved parameter names

`OPERATION_RESERVED_PARAM_NAMES` is a closed set — `actor`, `confirmed`,
`deadline-ms`, `dry-run`, `issue`, `issue-number`, `json`, `request-id`,
`session-id`, `session-ref`, `surface`, `yes` — refused in two places: at
registration (an operation may not *declare* one) and at invocation (a request
may not *carry* one, even for an operation that declares nothing).

Checking it structurally rather than per-operation is the point. An operation
that forgot to reject `session-id` would otherwise be one comment away from
acting on another session, and "every operation remembers" is not a property a
codebase keeps for long. Output-mode names (`json`, `dry-run`) are reserved for
a different reason: this port returns data, never rendered output (§7), so an
operation that accepted one would be re-inventing a concern that does not exist
at this layer.

### 5.2 Confirmation is trusted context, not a parameter

`docs/admin-cli-contract.md` makes destructive admin commands preview-by-default
with an explicit `--yes`. That gate is hoisted into trusted context as
`confirmed`, so no user-supplied parameter can ever set it, and so a surface
can be *structurally* unable to apply changes rather than merely unlikely to.

Three rules follow:

1. An operation invoked with `confirmed: false` must return
   `effect: "none"` — it describes what it would do and changes nothing.
2. **The port enforces that postcondition.** An `executed` result with
   `effect: "applied"` from an invocation that was not authorized to apply —
   `confirmed: false`, or a descriptor that declared itself non-`mutating` —
   is converted to
   `failed` / `internal` / `effect: "unknown"`, carrying the original summary.
   This is the one place the port overrides an operation's own account of
   itself, and the reason is that such a result is self-contradicting: the
   operation applied effects nobody authorized, so its claim to know which ones
   is worth nothing. Downgrading to `unknown` routes it to reconciliation and,
   for ChatOps, to an operator (§9) instead of into the acknowledged record.
3. **The authority is snapshotted before the handler runs.** `confirmed` and
   `mutating` are read once, at entry, and it is those values the postcondition
   is checked against. The handler is given the caller's own context object, so
   a check that re-read `confirmed` afterwards would test whatever the run last
   wrote there — an unconfirmed operation could set `confirmed = true` on its
   way to applying changes and have the port certify the result. `mutating` is
   protected across invocations as well as within one, by the registry storing
   an immutable copy of the descriptor (§4.2); the snapshot alone would only
   save the call that did the rewriting.

Which operations a given surface may ever invoke with `confirmed: true` is
policy for #784 and #697, not this contract. This contract only guarantees the
flag cannot arrive from the untrusted half.

## 6. What an adapter may never do

1. **Never assemble argv or a command string to reach an operation.** No
   `execFile`, `spawn`, `exec`, or `node dist/cli/admin.js` on the path from a
   received event to an operation. The port is a function call.
2. **Never parse admin CLI argv to *produce* a request.** A ChatOps command's
   token array (`docs/chatops-command-grammar-contract.md` §2) is mapped to
   typed parameters by #784's mapping layer; the port never receives tokens.
3. **Never construct a context field from request data**, including "just the
   issue number, since it was in the comment anyway".
4. **Never open a transaction around an operation** (§8).
5. **Never render inside an operation**: no stdout writes, no
   `setOutputMode`/`emit`/`report`, no `die`/`process.exit` on any path an
   operation can reach (§11).

Rules 1 and 5 are machine-checked (§13, §14); rules 2–4 are review rules with
type-level support — there is no argv field to fill, no context field an
operation's parameters can reach, and no transaction handle in the port's
signature.

## 7. Typed results and errors

```ts
type OperationResult =
  | { status: "executed"; effect: "applied" | "none"; summary: string; data?: Record<string, unknown> }
  | { status: "rejected"; reason: OperationRejectionReason; effect: "none"; summary: string }
  | { status: "failed";   reason: OperationFailureReason; effect: "none" | "unknown"; summary: string };
```

- `OperationRejectionReason` = `unknown-operation` | `invalid-request` |
  `invalid-context` | `not-permitted` | `precondition-failed` | `conflict`.
  Every one of them is **definite and effect-free**: the operation provably did
  not run. `effect` is `"none"` by construction, not by convention.
- `OperationFailureReason` = `unavailable` | `timeout` | `internal`. These may
  or may not have left an effect, so `effect` is a required field with no
  default — whether an effect may exist is the one fact only the operation
  knows, and defaulting it either way would be the port guessing on the
  question the entire at-most-once chain depends on.

There is no exit code, no `ok: boolean`, and no rendered string. `data` is
already-redacted structured output for an adapter to render however its surface
renders things; visibility and redaction of anything that leaves toward a host
remain Delivery's, per DOMAIN.md §2.3.

Both reason sets are closed and the port checks them on the way out: a result
carrying a reason outside its own set is not a well-formed result, because an
adapter that pattern-matches on the set — as §9's ledger mapping does — must
never meet a value it has no row for.

`invokeOperation` never throws — including for a malformed *outer* argument. A
`request` or `context` that is not an object at all (`null`, `undefined`, a
string, an array) is rejected as `invalid-request` / `invalid-context` before
any field is read, because an adapter is ordinary JavaScript at the boundary
and a dispatch attempt that threw would leave §9's ledger window with no result
to record.

The same holds for a half that *is* an object but cannot be read: `operationId`,
`params`, or a context field may be a getter or a proxy trap that throws. Every
pre-handler read — validation, the operation-id read, the registry lookup, the
scope checks, and the §5.2 confirmation read — therefore sits inside one
exception boundary, and a throw from it is reported as `rejected` naming the
half that was being inspected (`invalid-request` or `invalid-context`). It is a
*rejection*, not a `failed` / `unknown`: no handler has run at that point, so
the non-event is definite and `effect: "none"` is the truthful answer. The
operation id is read once, into a local, so the id that is looked up and named
in every later message is the id that was validated.

That totality also covers reading the handler's *own* return value. Recognising
a result means reading fields off an object the port did not build, and any of
them may be an accessor that throws or that answers differently on a second
read. So the fields are read exactly once, inside the same boundary that catches
a throwing handler, into a plain result which is what gets validated and
returned: an exception raised while inspecting a return value is converted to
`failed` / `internal` / `unknown` like any other loss of control. By then the
handler may already have had its effect, and a caller mid-ledger needs that
disposition far more than it needs a stack trace.

That totality extends to the refusal's own summary. A malformed value is
described, not serialized: a string is quoted, a primitive is printed as
itself, and anything else is named by shape (`an object`, `an array`, `1n`).
JSON serialization is not total — a `BigInt` operation id, a circular value, or
a `toJSON` of the caller's choosing all raise from inside the formatter — and a
refusal that threw while explaining itself would leave the ledger window with
no disposition just as surely as one that never ran.

A handler that throws, or returns a value that is not a well-formed result,
becomes `failed` / `internal` /
`effect: "unknown"`: a handler that lost control cannot vouch for what it had
already done by then, and recording "it failed, retry it" on its behalf is
exactly how a command gets replayed on top of effects that already landed.

## 8. Transaction and side-effect ownership

- **The operation owns its transaction.** It runs whatever the owning context's
  port already runs — `TaskStore.completePhaseWithEffects`, a store-level CAS,
  an outbox enqueue joined to the producer's transaction (DOMAIN.md §2.3) — and
  it commits or rolls back before it returns. Atomicity guarantees are the
  operation's and its store's, unchanged by being called from a new surface.
- **The adapter owns no transaction.** No adapter opens one around an
  invocation, and no adapter's durable state is written inside the operation's.
  The port takes no transaction handle, so this is not merely discouraged.
- **No transaction spans the port.** This is the same substrate limit
  `docs/chatops-execution-ledger-contract.md` §1 states for SQLite and the
  provider, and it is why §7's `effect` exists rather than a promise of
  end-to-end atomicity.
- **Deferred host writes stay in the outbox.** An operation that needs a
  comment, a label, or a transition posted enqueues an effect in its own
  transaction; Delivery dispatches it. An adapter never dispatches, and an
  operation never posts directly except where DOMAIN.md §2.3 already records
  the one synchronous exception (PR creation, which is Execution's, not
  Operation's).
- **Ordering against the ChatOps ledger is fixed by #782 §8**: the write-ahead
  T2 commits, the epoch witness is mirrored, the claim marker is posted and
  confirmed, *then* the port is invoked, and only then does T3 record the
  outcome. The port sits strictly between two local transactions and inside
  neither. An operation must therefore never assume it can be re-run: the
  ledger refuses re-entering `dispatching` without a verdict (#782 row 14), so
  a given attempt is invoked at most once.

Nothing here moves domain logic into the adapter. The adapter's entire
contribution is: build a context, build a request, call, and record what came
back.

## 9. Binding to the ChatOps execution ledger

### 9.1 The context for one attempt

`chatOpsOperationContext(attempt)` builds the trusted half from ledger-scope
facts only: the identity (`docs/chatops-identity-contract.md` §6), the issue
the comment lives on, the first-seen author login, and the attempt number the
ledger's write-ahead just produced. Nothing is read from the comment body,
because the body's contribution — a verb and a token list — is the untrusted
half and belongs in the request.

A malformed attempt — a blank author login, an attempt number below 1 —
**throws** rather than returning a result, which is the §4.2 rule applied one
layer out: those fields come from the adapter's own durable rows, not from a
user, so a bad one is a corrupt ledger row and the caller has not yet produced
any external effect it would need a result to record.

`requestId` is `chatOpsLedgerKey(identity, issueNumber, commentId)#<attempt>`.
It is stable for the life of an attempt and never reused by another one, which
is what makes it usable as an idempotency handle by an operation that wants
one. It is not a *substitute* for the ledger: #782 §1 is explicit that a local
idempotency key alone cannot make execution at-most-once across a restore.

### 9.2 Result → ledger event

`chatOpsDispatchDisposition(result)` returns either a ledger event to record or
an instruction to reconcile. The table is total over §7's result shapes:

| Result | Ledger event (#782 §7) | Why |
| --- | --- | --- |
| `executed` | `dispatch-result` with outcome `executed` (row 8) | Definite outcome, definite verdict. |
| `rejected` (any reason) | `dispatch-result` with outcome `rejected` (row 8) | Definite refusal. Marker outcome `rejected` (an operation that refused) is not ledger *state* `rejected` (a comment that never dispatched); row 8 records the former. |
| `failed`, `effect: "none"`, reason `internal` | `dispatch-result` with outcome `error` (row 8) | Definite, and not worth retrying: re-running code that just failed deterministically only spends the attempt cap. Row 16 already acknowledges cap exhaustion with `error`, so the outcome is not a new concept. |
| `failed`, `effect: "none"`, reason `unavailable` or `timeout` | `reconciled` with verdict `no-effect` (row 9) | Row 9 is the ledger's only automatic path into retry and it requires positive proof the operation never began. A `none` effect from the operation itself is that proof, and at least as strong as the absence-based proof #782 §10.4 accepts. The retry stays bounded by `attempts` (row 16). |
| `failed`, `effect: "unknown"` (any reason) | **none** | The row stays `dispatching` and #782 §11's reconciliation decides from provider evidence. Recording a guess here is the double execution this chain exists to prevent. |

The mapping introduces no new ledger event, no new state, and no new row
number. It consumes #782's transition table exactly as that document defines
it, per its §19 instruction to the successor.

## 10. Deadlines, cancellation, and retries

- **The port has no cancellation.** `deadlineMs` is advisory: an operation that
  overruns it reports `failed` / `timeout` with the effect it can honestly
  claim — `none` if it proved it never started, `unknown` otherwise. Adding
  cancellation would mean unwinding a partially-applied operation from outside,
  which is the saga DOMAIN.md §2.3 explicitly does not have.
- **The port never retries.** It invokes once and returns. Retry policy belongs
  to the caller's own durable state machine (for ChatOps, #782 §13.1's bounded
  automatic retry). A port that retried internally would make `attempts`
  — the load-bearing input to #782 §11.1's restore detector — a count of
  something other than what actually happened.

## 11. The prerequisite, stated concretely

### 11.1 What PR #776 assumed, and why it was not true

PR #776 treated the admin decomposition (#612/#613, now sequenced by
`docs/admin-extraction-plan.md`, #712) as the thing that would hand ChatOps a
callable operation. It does not, and this is checkable rather than a matter of
opinion:

- Every admin *command* handler today has the shape
  `runXxx(argv: string[]): Promise<void>` — or its synchronous `void` twin,
  sometimes with an extra injected argument after `argv` (`src/cli/admin.ts`).
  Each parses its own options, writes results through the process-global output
  mode in `src/cli/cli-io.ts` (`setOutputMode`/`emit`/`report`), and reports
  failure by calling `die()`, which calls `process.exit`. None of them returns
  its outcome to a caller.
- `docs/admin-extraction-plan.md` is a **relocation** plan, not a re-shaping
  one. Its §4 forbids even a transitional adapter from changing "exit codes,
  output shape, help text, or flag spelling"; its §8 says that after the final
  slice, "every `runXxx` command-handler body … lives in that resource's own
  module" — the same `argv`-in / stdout-and-exit-out shape, in a different
  file.
- Its port prerequisites P1–P4 are `TaskStore`, `LockStore`, `SessionRegistry`,
  and dispatch-registration scaffolding. Those are *store* ports and a *CLI
  registry* seam. None of them is an operation port, and none of them makes a
  handler callable by a non-terminal.

So after the entire plan completes, an adapter that is not a terminal still
faces the same three blockers: it must synthesize argv, it must capture output
from a process-global sink, and it must survive a callee that may exit the
process. Building ChatOps on that is what produced PR #776's argv-reconstruction
risk.

### 11.2 The real prerequisite: per-operation core extraction

The prerequisite is a **core/shell split of each operation's handler**, and it
is defined here rather than assumed elsewhere. An operation may be registered
in a registry only once all of the following hold for it:

1. Its decision-and-action body is a function that takes
   `{ request, context }` and returns an `OperationResult`.
2. That body performs **no argv parsing**. Option parsing stays in the CLI
   shell, which converts argv to typed parameters and then calls the core.
3. That body performs **no output**: no `console.*`, no `emit`/`report`, no
   dependence on `getOutputMode()`. The CLI shell renders the returned result
   in exactly the output shape `docs/admin-cli-contract.md` and
   `docs/admin-cli-parsing-contract.md` pin today.
4. That body **never calls `die()` or `process.exit`** on any path. Failure is
   a returned `rejected`/`failed` result; the CLI shell maps it to today's exit
   code.
5. Its dependencies (stores, registries, providers, locks) are **injected**,
   not constructed inside it and not read from module-level singletons — so a
   test, `admin ui`, and ChatOps can all supply their own.
6. The CLI command's existing behavior is unchanged: same flags, same output
   bytes, same exit codes, same preconditions. The split is verified by the
   command's existing tests continuing to pass **plus** a new test that
   invokes the core through the port and asserts the same decision (§13).

This split is **orthogonal to the admin extraction plan**, in both directions:

- It is not provided by any slice of that plan, per §11.1.
- It does not require any slice of that plan. A handler can be split into core
  and shell while it still lives in `src/cli/admin.ts`, and the resulting core
  can move to a resource module later with the plan's own rollback properties
  intact. Nothing in this contract is blocked on #613, and #613 is not blocked
  on this.

Therefore this document adds no `P5` to `docs/admin-extraction-plan.md`'s DAG
and reorders none of its slices. It records the relationship instead, and
`docs/DOMAIN.md` §4.1's `#613 → #696` edge is corrected in the same change: the
edge was a sequencing preference, not a dependency, and treating it as a
dependency is what let "the callable seam will exist by then" go unexamined.

### 11.3 Where the extraction work is charged

Per-operation, to the issue that first needs that operation — beginning with
#784, which maps the first verbs. There is no repo-wide refactor to schedule
and no fan-in blocker to file, which also keeps the design dependency contract
representable: DOMAIN.md §4.1 records that the resolver supports at most one
open blocker per issue, so a prerequisite that fanned into every ChatOps issue
could not be expressed as an edge at all. The rule that keeps it honest is
§11.2's gate — a registry that only accepts a split core cannot accumulate
half-extracted operations, because an unsplit handler has nothing to register.

## 12. Observability and bounds

- `summary` is bounded at `OPERATION_SUMMARY_MAX_CHARS` (500) and truncated
  with a visible `… (truncated)` marker. The marker counts against the bound
  rather than extending it, so a bounded summary is never longer than 500
  characters — the same bound-and-flag posture
  `docs/chatops-execution-ledger-contract.md` §14 uses, so an operation's
  summary can be carried into a ledger row or an operator surface without a
  second bounding rule.
- A summary is operator-facing text about the operation, never a comment body,
  never a credential, never a diff.
- `requestId`, `surface`, `actor.id`, and `operationId` are the four fields an
  audit record needs to answer "who ran what, from where, once". They are all
  in the trusted half, which is what makes the audit record trustworthy.

## 13. Test seams

Adapter-independent invocation is a first-class requirement, not a byproduct:

- **In-memory registry.** `createOperationRegistry([...])` over hand-written
  descriptors needs no database, no filesystem, and no session. A test
  registers a recording descriptor and asserts what the port passed it.
- **A descriptor is a function.** An operation's contract test calls
  `invokeOperation(registry, request, context)` and asserts on the returned
  result — no stdout capture, no exit-code assertions, no subprocess.
- **Adapters are tested against a fake registry**, not against real operations:
  #784's mapping tests assert "this comment produced this request", and the
  registry records it, so mapping tests never execute anything.
- **The ChatOps binding is pure.** `chatOpsOperationContext` and
  `chatOpsDispatchDisposition` take plain values and return plain values, so
  the whole result→ledger-event mapping is testable without a ledger, a
  provider, or a clock.
- **The prohibitions are greppable.** §6 rules 1 and 5 are asserted by scanning
  the port and binding modules' source — **with comments stripped**, so the
  rules can still be *written down* in the code they govern — for
  `spawn`/`execFile`/`child_process`/`admin.js` and for
  `process.exit`/`console.`, so a future edit that reintroduces a subprocess or
  a print fails a test rather than a review.

## 14. Test matrix

`test/operation-port.test.js` covers, at minimum:

| Area | Cases |
| --- | --- |
| Request/context separation (§5) | every reserved name refused at invocation; refused at registration; a request carrying `session-id` never reaches the handler; the handler receives context fields verbatim. |
| Registration defects (§4.2) | duplicate id, malformed id, malformed parameter name, blank summary, reserved parameter, non-boolean `mutating`, unknown `scope`, missing `run`, non-array `params`, non-object descriptor, non-object parameter spec, unknown parameter `type`, non-boolean `required`, non-boolean `repeated` — each throws `OperationRegistrationError`; a registered descriptor and its parameter specs are frozen, and rewriting the supplied object afterwards changes nothing the registry hands out. |
| Parameter validation (§4.1) | unknown parameter, missing required, wrong type, array for a non-repeatable parameter, empty array — each `rejected`/`invalid-request`; a valid repeated parameter passes; a parameter value is read once, and neither a getter answering differently on a second read nor a write to the caller's `params` (or to a repeated parameter's array) while the handler runs can change what the handler acts on; an own `"__proto__"` key in decoded `params` is refused as an unknown parameter, never reaches a handler, and leaves the snapshot's `params` prototype-less. |
| Scope (§4.2) | issue-scoped without a work item and session-scoped with one are both `invalid-context`. |
| Results (§7) | `invokeOperation` never throws for a throwing handler; a throwing handler yields `failed`/`internal`/`unknown`; a malformed return value yields the same; a non-object `request`/`context` yields `rejected`/`invalid-request`/`invalid-context`; a returned result whose `status`, `summary`, `effect`, or `data` accessor throws yields the same indeterminate failure; a field that answers differently on a second read cannot change the returned result; a `request` whose `operationId` or `params` accessor throws, and a `context` whose `surface`, `actor`, `issueNumber`, or `confirmed` accessor throws, each yield `rejected`/`invalid-request` or `invalid-context` with `effect: "none"` and never reach a handler; summaries are bounded, marker included. |
| Confirmation (§5.2) | `confirmed: false` reaches the handler unchanged; an `applied` effect under `confirmed: false` is downgraded to `failed`/`internal`/`unknown` and keeps the original summary; the same downgrade applies to a non-`mutating` descriptor that reports `applied`; a handler that sets `confirmed = true` on its context, or `mutating = true` on its descriptor, while it runs is downgraded just the same, and a descriptor rewritten during one run does not authorize the next one. |
| Unknown operation (§7) | unregistered id and malformed id are both `rejected`/`unknown-operation`. |
| No subprocess (§6) | the port and binding modules, comments stripped, contain no `spawn`/`execFile`/`child_process`/`admin.js`, no `process.exit`, and no `console.` call. |

`test/chatops-operation-dispatch.test.js` covers:

| Area | Cases |
| --- | --- |
| Context construction (§9.1) | surface, actor from the first-seen author, session from the identity, issue from the attempt; a non-positive attempt throws; a blank author throws. |
| Request id (§9.1) | derived from the ledger key and the attempt; distinct attempts differ; distinct comments differ. |
| Event mapping (§9.2) | every row of the table, including the `unknown`-effect row that maps to no event. |
| Ledger compatibility | each mapped event is accepted by `applyChatOpsLedgerEvent` from `dispatching` and lands on the row number the table claims. |

`test/docs-operation-dispatch-port-contract.test.js` pins this document's
reserved-name set, result shapes, mapping table, prohibitions, and §11's
prerequisite statement against drift.

## 15. Invariants

1. A request never carries a trusted field; a context never carries an
   operation parameter.
2. No path from a received external event to an operation assembles argv or
   spawns a process.
3. An operation returns; it never exits the process and never prints.
4. Every result is definite or explicitly `unknown`; nothing infers effect from
   the absence of an error.
5. No transaction spans the port, and adapters open none.
6. One operation implementation serves every surface; a surface-specific
   behavior difference is expressed as a context field, never as a second
   implementation.
7. An operation is registered only after §11.2's split; the registry has no
   shape that could accept anything else.

## 16. Non-goals and forward pointers

This document defines the callable boundary only. It does not define, and
nothing implementing it may assume:

- **Which operations exist and how a ChatOps verb maps onto one** — #784, the
  immediate successor, which also owns per-surface argument policy.
- **Routing protection** — which operations a surface may reach at all, and
  what happens to one it may not. **Delivered (#784)**:
  `docs/chatops-operation-mapping-contract.md` binds each supported verb to
  exactly one canonical operation id behind a closed, per-verb parameter
  allowlist, refusing any trusted-context field or deprecated operation id at
  table-construction time.
- **Acknowledgement and result publication** — how an outcome becomes a
  comment; the marker format is already fixed by
  `docs/chatops-command-grammar-contract.md` §7. **Delivered (#785)**:
  `docs/chatops-result-contract.md` defines the total mapping from this
  document's §7 result and #782's ledger disposition onto a five-kind
  ChatOps-facing outcome, and the bounded/redacted composition of the public
  acknowledgement and the provider-visible marker.
- **Tool Request grant tiers over typed operation ids** — #697, which builds on
  `operationId` being a typed identity rather than a command string
  (`docs/DOMAIN.md` §5 item 4). **Delivered (#697)**:
  `docs/tool-request-grant-tiers-contract.md` tiers the Tool Request gate
  over typed-operation registry entries behind a session-side allowlist —
  auto-grant / notify-and-proceed / human-gate — with tier refusals
  surfacing as this document's §7 `not-permitted` rejection and the tier
  decision made at context construction (§5.2's `confirmed`), never in the
  result mapping.
- **Polling, the SQLite schema, and task routing** — already listed as
  non-goals by `docs/chatops-execution-ledger-contract.md` §19.
- **The admin CLI's own decomposition** — `docs/admin-extraction-plan.md`,
  which this document neither blocks nor depends on (§11.2).

That work is tracked by the executable chain this issue's predecessors head:
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships).
