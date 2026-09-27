# Operator-owned verification amendment and revision contract

Status: **approved design, resolution and persistence implemented,
evidence binding wired, refresh-from-Issue shipped, task operator
surface shipped, continuation wired** (contract: issue #1037;
persistence: issue #1038; resolution: issue #1039; evidence binding:
issue #1040; refresh: issue #1041; operator surface: issue #1042;
continuation: issue #1043). This
document is the authoritative
contract for correcting verification
requirements **after task intake** — when the Issue body, the
operator-authored `session.verification` configuration, or both were
entered wrongly and the task is already stuck behind them. It fixes the
ownership layers, their precedence, the revision model with its stable
command identity and plan digest, the task states in which an amendment
is admissible, the evidence invalidation and preservation rules, the
default continuation, refresh-from-Issue semantics, and the audit and
GitHub-visible reporting requirements. Follow-up implementation issues
reference this specification and MUST NOT redefine its policy; a change
of policy is a change to this document first.

Issue #1037 delivered this document and its structural contract tests
(`test/docs-verification-amendment-contract.test.js`) only, with no
runtime behavior. Issue #1038 added the §5.5 persistence slice (§15
slice A2, `src/core/verification-amendment.ts`): the persisted revision
and checkpoint shapes with their fail-closed validation, the §5.1
`commandId` derivations, and the atomic apply/rebase writes committed
through `TaskStore.completePhaseWithEffects` under the §7 CAS, with
their §12.1 audit events — additive task-context state, no new column,
table, or store method, and no behavioral change to the shipped loop,
which does not read the new state yet. Issue #1039 added the §6
resolution half of §15 slice A1 (`src/core/verification-plan.ts`): the
deterministic effective-plan resolver over the session-default layer,
the intake-pinned Issue-derived requirements, and the applied revision
chain, with §5.1 slot identities carrying their origin and amendment
status, the §5.4 plan digest, the §5.2/§5.3 rule 7 authoring
composition with its explicit refusals, the §6.4 three-way
reconciliation and its rule 4 dispositions, and §6.2 rule 3
satisfaction on the shipped equivalence rule — a pure core module that
reads no live provider state, writes nothing, and executes nothing.
Issue #1040 added the evidence-binding slice
(`src/core/verification-evidence.ts`): manual verification evidence now
records the effective plan digest and revision ordinal, the §5.1 slot
identity it was recorded for, and the reviewed branch HEAD, and a later
review admits an entry only while every one of those identities still
holds — the #918 §8.2 rule 3 posture ("evidence binds to identities,
not to time") applied to the operator-attested evidence layer, as
evidence-layer bookkeeping in the §8.5 sense, changing no §8 amendment
rule. Legacy evidence that lacks the binding is conservatively
inadmissible, and stale evidence fails closed, never deleted (§8.1).
Review Step 4.5 consults the §6 resolver for evidence identity and
records the binding block its escalation hands to
`review-verification resolve`, which stamps it onto new evidence; at
the time of #1040 the gate itself still read the raw inputs (slice A3
landed later, with issue #1043), so what a task verified was unchanged
while what evidence may satisfy it was bound to the plan revision and
commit it actually tested.
Issue #1041 added the §10 refresh slice (§15 slice A6,
`src/core/verification-refresh.ts` and `admin review-verification
refresh`) together with the §5.3 rules 1–2 `revisionId`/`requestKey`
derivations it needs: a provider-neutral live read of the Issue body,
projected through the shipped extractor and diffed against the
**effective** requirement layer, applied as one `issue-refresh`
revision carrying requirement-layer operations only. It previews by
default, emits no `replace`, withholds every retirement without
`--allow-retire`, records the `issueBodyDigest` it read, and refuses
whole — writing nothing and consuming no ordinal — on an unsupported
provider, a provider failure, a missing Issue, a body with no supported
verification section, a body that moved since the preview, or a diff
the §10 rule 3 matcher cannot map. The intake-time body, title, labels,
phase, and every other task field stay exactly as intake pinned them
(§10 rule 1).
Issue #1042 added the rest of the §11 operator surface (§15 slice A4,
`src/core/verification-amend.ts` and the `admin task-verification`
commands): the read-only effective-plan view, the operator-typed
revision with its order-sensitive operation grammar, and a `reset` that
returns an amended plan to its unamended baseline as one ordinary
revision. Each mutation previews by default, applies only under
`--yes`, reports both plan digests, and refuses whole — writing nothing
and consuming no ordinal — on a claimed, running, or terminal task, a
stale plan, a `--expect-plan-digest` mismatch, a pinned entry, or an
invalid operation, including when it would otherwise have had nothing
to do.
Issue #1043 wired §9 continuation and the requirement half of slice A3.
An applying revision — an amendment, a reset, and a refresh alike — now
takes its §9.2 continuation and records the route it took: the typed
`--continue` value on an `amend`, and the row default everywhere else.
A `"review"` or `"implementation"` continuation re-queues the task
`{queued, <continuation>}` inside the same CAS-guarded transaction that
persists the amended plan and its digest (§9.2 rule 2), invalidating
the stale missing-command list, per-command status snapshot, and
evidence-binding block the park recorded — while
`manualVerificationEvidence` is preserved untouched (§8.1) — and a
route the table withholds refuses with nothing written (§9.2 rule 3).
Review Step 4.5 now gates on the effective requirement layer: active
slots gate at their current bytes, each evaluated under its own slot
identity, retired slots are excluded and reported `retired`, never
passed (§8.4), and an unresolvable plan on a task carrying recorded
amendments blocks review outright — only an unamended task falls back
to the raw inputs, where they are exactly the shipped gate. Review
Step 4 still executes the raw `session.verification` values — the
execution half of slice A3 is a later change, and the gate deliberately
credits no execution-layer `add` it did not run.
Issue #1044 landed the §12.2 reporting slice (§15 slice A7): an applied
revision posts one bounded work-item comment, idempotency-keyed on its
`revisionId` and carrying no run identifier, enqueued through the
outbox in the same transaction as the write, naming every retirement
and restoration beside the statement that a retired command is not a
passing result, and changing no label — while a refusal, a replay, and
a rebase post nothing. The human gate's run summary states that the
plan was amended and what it no longer checks, `admin ui` drives the
same §11 commands with the same preview-then-confirm posture, and
`admin review-verification resolve` refuses a command an amendment
orphaned (§13.1).

It does **not** specify, and no implementation built against it may
assume:

- **Verification ownership, non-derivation, and session configuration**
  — fixed by `docs/environment-prepare-contract.md` §3.1–§3.3:
  `session.verification` stays operator-authored, never derived from
  issue text or agent output, and never modifiable, skippable, or
  reorderable by an agent. This contract adds a *task-scoped* operator
  layer over that configuration; it weakens no ownership rule and gives
  an agent no new power.
- **Runner-owned verification execution, classification, aggregation,
  and continuation** — fixed by
  `docs/verification-execution-contract.md` (#918). This contract
  supplies one additional operator-owned input to #918 §5.1 set
  resolution and consumes #918's evidence-binding rules (§8.2 rule 3)
  unchanged; it adds no lane, no classification, no cycle outcome, and
  no continuation route of its own.
- **The preflight Execution Plan, its approval, and its pinned
  entries** — fixed by `docs/preflight-execution-plan-contract.md`
  (#915). A `"verification.pinned"` entry is approval-governed and is
  **never** amendable here (§6.1 rule 4).
- **The ExecutionBackend, its outcome and refusal taxonomies, and
  backend selection** — fixed by
  `docs/single-host-execution-backend-contract.md` (#917).
- **The unattended Tool Request decision, continuation, and parking
  model** — fixed by `docs/unattended-tool-request-contract.md` (#919).
  This contract adds no Tool Request action, disposition, or state.
- **The admin CLI's shared parsing, output, exit-code, and confirmation
  behavior** — fixed by `docs/admin-cli-contract.md` and
  `docs/admin-cli-parsing-contract.md`. §11 states which of those
  guarantees the amendment surface must inherit; it restates none of
  their mechanism.
- **The issue-required verification extractor and matching semantics**
  — the shipped `extractIssueVerificationCommands` /
  `buildIssueVerificationStatus` behavior (issue-body heading scan;
  exact/trimmed command equivalence plus shell-wrapper equivalence, the
  `matchesConfiguredVerificationCommand` rule shared with #918 §10.2)
  is the recorded baseline this contract reuses, never redefines.
- **Progressive Issue refinement** — `docs/issue-refinement-contract.md`
  owns rewriting an Issue body and its managed region. This contract
  never writes an Issue body (§10 rule 1).

## 1. Why this contract — the gap it closes

A verification requirement can be wrong in exactly the same ways any
other operator input can be wrong: a typo, a command that names a script
the repository does not have, a requirement copied from a sibling Issue,
a `session.verification` entry that drifted from the project's actual
task runner. Today the loop has no correction path that is both
auditable and safe:

- **The Issue-derived requirement is pinned at intake.** The review
  lane's Step 4.5 gate reads the issue body out of the *intake-time*
  task context (`context.body`) and extracts required commands from it.
  Editing the GitHub Issue afterwards changes nothing: the task keeps
  gating on the text it was created from, and there is no supported way
  to tell it otherwise.
- **`review-verification resolve` records evidence, not
  requirements.** It answers "did this command run, and with what exit
  code" — that is the *evidence* layer. It cannot say "that command was
  never the right command." An operator facing a typo'd requirement can
  only run the typo'd command (impossible), fabricate evidence
  (dishonest), or edit the database by hand (unauditable).
- **`session.verification` is session-wide.** Correcting one task's
  problem by editing `sessions.json` changes every other task in the
  session, retroactively and silently, with no per-task record of why.
- **Removal is indistinguishable from success.** The only mechanism
  that makes a blocking requirement go away today is deleting it from
  the input it came from, after which nothing anywhere records that a
  check was dropped. "Verification passed" and "verification was
  removed" must never render the same.
- **No revision identity.** With no revision, digest, actor, reason, or
  timestamp, two operators correcting the same task cannot tell whose
  correction is in effect, and a stale correction cannot be detected.

This contract fixes all of it as design: four named ownership layers
with one precedence order (§3), a task-scoped amendment as the initial
mutation scope (§4), a revision model with stable command identity and a
plan digest (§5), a deterministic effective-plan resolution (§6), a
closed admissible-state table with a fail-closed active-task refusal
(§7), evidence invalidation that never destroys evidence (§8), a default
continuation back to review rather than implementation (§9), a
verification-only refresh from the Issue (§10), operator-surface and
reporting requirements (§11–§12), and a compatibility mapping (§13) that
leaves every shipped surface either unchanged or changed as a recorded,
slice-owned change, never silently.

## 2. Terminology

- **Verification command bytes** — the exact command string an operator
  authored, in either the session configuration or the Issue body, with
  leading and trailing whitespace removed and **nothing else changed**.
  No case folding, no shell parsing, no shell-wrapper unwrapping, and
  **no collapsing of interior whitespace**: trimming the ends is safe
  because a shell ignores them, but an interior run of spaces or tabs
  may sit inside a quoted argument, where it is data. `printf 'a  b'`
  and `printf 'a b'` are two different commands and this contract keeps
  them that way. The command bytes are what a slot stores, what the
  plan digest covers, what a report prints, and what the runner
  executes; no surface defined here ever hands a rewritten command to
  #918.
- **Command identity form** — the representation hashed to derive a
  requirement-layer `commandId` (§5.1). It is a representation
  *separate* from the command bytes so that identity can never be
  confused with execution, and it is defined as **the command bytes
  verbatim**: it trims nothing further, folds no case, and collapses no
  whitespace, precisely so two commands that differ in shell-significant
  bytes cannot collapse into one slot. Identity is a distinct concern
  from equivalence *matching*, which stays the shipped
  `matchesConfiguredVerificationCommand` semantics (§13.2).
- **Plan slot** — one addressable position in a task's verification
  plan, carrying a `commandId`, a layer, a state, and its current
  command bytes. A slot survives a correction of its bytes; that
  is what makes it addressable.
- **`commandId`** — the stable identity of a plan slot (§5.1). The
  execution layer's form is `exec:<name>`; the requirement layer's is
  `req:<16 lowercase hex>`.
- **Layer** — which of the four ownership layers a slot or a value
  belongs to. The layer set is **closed**: `"session-default"` |
  `"issue-requirement"` | `"task-amendment"` | `"execution-evidence"`
  (§3). Adding a layer is a change to this document first.
- **Amendment operation** — one addressable change to one slot. The
  operation set is **closed**: `"replace"` | `"add"` | `"retire"` |
  `"restore"` | `"annotate"` (§5.2). Adding an operation is a change to
  this document first. Its serialized shape is fixed by §5.2 so that two
  implementations derive the same `revisionId` for the same amendment.
- **Amendment revision** — the atomic unit of durable change: one
  operator invocation, one or more operations, applied all-or-nothing
  (§5.3).
- **Effective execution set** — the ordered list of commands the runner
  will execute for this task, after amendments (§6.1). It is the input
  #918 §5.1 resolves and fingerprints; this contract computes what goes
  into it, never how #918 runs it.
- **Effective requirement set** — the ordered list of Issue-derived
  requirements the review gate will test for this task, after
  amendments (§6.2).
- **Effective plan** — the pair of the two sets above, in resolution
  order (§6.3). It is what an amendment amends.
- **Plan digest** — the SHA-256 over the canonical JSON of the
  effective plan (§5.4). It is a function of the plan alone: not of
  revisions, reasons, actors, or timestamps.
- **Session baseline** — the snapshot of the session-default layer a
  task's revision chain was last written over: the ordered
  `{name, command}` pairs of `session.verification` as observed at that
  write, with `sessionBaselineDigest` its canonical-JSON SHA-256 (§6.4).
  It is what makes a later session-configuration change **attributable**
  rather than indistinguishable from a hand-edited task row.
- **Request key** — the caller-stable handle on one applying
  invocation, supplied by the operator or derived from the invocation's
  own content, from which `revisionId` is derived so that a retry of the
  same invocation resolves to the same revision (§5.3 rules 1–3).
- **Mutation scope** — how far a correction reaches. The scope set is
  **closed at `"task"` this cycle**: `"task"` is the only supported
  value (§4). `"session"` is named as a future scope and is
  unimplementable under this contract (§17).

## 3. The four ownership layers and their precedence

### 3.1 The layers

| Layer | What it is | Owner | Where it lives today | Scope |
| --- | --- | --- | --- | --- |
| `session-default` | The operator-authored `session.verification` map: named commands the runner executes for every task in the session | Session operator | `sessions.json`, `session.verification` | Session |
| `issue-requirement` | The commands the Issue body demands be run, extracted at intake by `extractIssueVerificationCommands` | Issue author, as pinned at intake | Task context (`context.body`), read by review Step 4.5 | Task |
| `task-amendment` | The durable, revisioned, operator-authored correction defined by this contract | Task operator | Task context, append-only (§5.5) | Task |
| `execution-evidence` | What actually ran: runner-produced results (the #918 §8.2 cycle bundle) and operator-supplied manual evidence | Runner, or operator attesting an execution | Run artifacts; task context (`manualVerificationEvidence`) | Task, bound to identities |

The distinction that matters most is the last row against the first
three. The first three layers say **what must be checked**. The fourth
says **what was checked, and how it came out**. `admin
review-verification resolve` writes the fourth layer and only the
fourth; that is why it can record that a command ran and cannot correct
a command that should never have been required.

### 3.2 Precedence

For any one slot, the highest-precedence layer that has an applicable
value wins:

1. **`task-amendment`** — the latest applied revision that touches the
   slot.
2. **The slot's origin layer** — `session-default` for an `exec:` slot,
   `issue-requirement` for a `req:` slot.

`execution-evidence` never participates in precedence. It is not a
value in the plan; it is a fact about the plan's execution. **Evidence
never becomes a requirement, and an amendment never becomes evidence.**

Three consequences the implementation must preserve:

- A task-scoped amendment **overlays**; it never rewrites its origin.
  `session.verification` is not edited (§4 rule 3) and `context.body` is
  not rewritten (§10 rule 1). The overlay is applied at resolution time,
  every time, so the origin stays readable as the historical record of
  what the task started from.
- Two tasks in the same session with different amendments have
  different effective plans, and neither leaks into the other.
- Amendment ordering within the layer is `revisionOrdinal` ascending,
  then operation order within a revision. Last write wins **per slot**,
  not per plan: a revision touching `exec:test` leaves `exec:lint`
  exactly as the previous revision left it.

### 3.3 Agents may propose; agents may never amend

`docs/environment-prepare-contract.md` §3.2's rule — the agent has no
mechanism to modify, skip, or reorder configured verification — is
extended, not weakened, by the new layer:

1. An agent may **propose** verification: in its output, in a Tool
   Request (`docs/environment-prepare-contract.md` §3.3's
   surface-the-gap path), or in a review finding. A proposal is inert
   text.
2. An agent may **never** author, amend, retire, reorder, or skip an
   amendment. No agent-authored byte becomes an operation, a
   `commandId`, a `reason`, or an actor, and no agent transcript
   triggers a revision.
3. The `actor.kind` set is **closed at `"operator"`** this cycle. Even
   when an operator is transcribing an agent's suggestion verbatim, the
   revision's actor is the operator: a human read it and took
   responsibility for it. There is no agent actor to record and none is
   reserved.
4. Nothing here creates an agent-visible amendment API. Agents keep
   receiving verification evidence in prompts (#918 §11.4) and keep
   having no mechanism to change what is verified.
5. **The runner is authoritative for execution and routing** (#918 §3
   rule 4) on the amended plan exactly as on the unamended one. An
   agent's statement that a command is unnecessary carries the same
   routing weight as any other agent-authored byte: none.

## 4. Task-scoped amendment is the initial mutation scope

1. **`"task"` is the only supported mutation scope this cycle.** An
   amendment is addressed to exactly one `(sessionId, issueNumber)` task
   row and affects that row alone.
2. **The scope is explicit and recorded**, not implied. Every revision
   records `scope: "task"`, so a later session-scope mechanism (§17) is
   an added value in a closed set rather than a reinterpretation of
   existing records.
3. **No task-scoped correction mutates `sessions.json`.** No amendment
   surface reads-modifies-writes the session registry, adds a key to
   `session.verification`, or edits the file in any way. An execution
   layer amendment produces a task-local overlay (§6.1) and nothing
   else.
4. **Task-scoped amendment is the emergency correction, not the
   management surface.** It exists so a single stuck task can be
   corrected now, with a record of who corrected it and why. It is
   deliberately unsuited to fleet management: it has no cross-task
   application, no template, and no inheritance.
5. **Repetition is a signal, not a workflow.** When the same amendment
   is issued on several tasks in a session, the correct fix is the
   session configuration, through the future session-default management
   surface (§17). The operator surface must say so in its output when it
   applies a revision whose operations are byte-identical to an already
   recorded revision on another task in the same session — an advisory
   line, never a refusal, and never an automatic session write.
6. **Amendments are task-row scoped, not attempt scoped.** They survive
   every phase transition, requeue, and new attempt of the same task
   row, and they die with it: re-intaking the Issue as a new task row
   starts from an unamended plan. A revision is never copied between
   task rows.

## 5. The revision model

### 5.1 Stable command identity

`commandId` identifies a **slot**, not bytes. Correcting the bytes is
the entire point of an amendment, so an identity derived from the
current bytes would dissolve on first use.

**Execution layer.** `commandId = "exec:" + name`, where `name` is the
`session.verification` key. The key is already the operator's stable
handle for the command — it names the log artifact
(`verification-<name>.log`, #918 §11.1) and the failure message — so it
is reused, not replaced.

An `add` operation supplies its own name for a task-local slot. The name
must match `/^[A-Za-z0-9][A-Za-z0-9._:-]*$/` and must not collide with
an existing `exec:` slot; a violation of either rule refuses the whole
revision. The character rule is not cosmetic: the name becomes a path
component of a run artifact.

**The collision check is an authoring-time check against the plan the
revision was authored over**, and it is the only collision this contract
refuses. It cannot bind the future: a `session.verification` key added
after the `add` was applied names a slot the check never saw, and a
recorded revision is never retroactively refused (§5.3 rule 6). §6.1
step 1 resolves that later collision in the task-local slot's favour and
reports the session entry masked; nothing about it reaches back into the
chain.

**Requirement layer.** `commandId = "req:" + sha256(command identity
form).slice(0, 16)`, lowercase hex, computed **once**, when the slot
first enters the task's plan — at intake for the pinned extraction, or
at its `add` revision for a later one. The identity form is the command
bytes verbatim (§2), so identity is **byte-preserving**: it never
collapses interior whitespace and therefore never merges two commands
that a shell would run differently. It is thereafter immutable: a
`replace` that corrects the bytes keeps the `commandId`, so the slot's
lineage from the wrong requirement to the right one is a single
addressable history rather than an inferred pairing.

Two source commands with identical bytes collapse to one slot. That is
intended: the plan is a set of checks, and the same check written twice
is one check. Two commands that differ only in interior whitespace are
**not** the same check under this rule — without shell parsing the
difference may be data — so they occupy two slots, and an operator who
believes one of them is a typo retires or replaces it explicitly.

### 5.2 The operation set

| Operation | Effect | Required fields | Refused when |
| --- | --- | --- | --- |
| `replace` | Substitutes the command bytes of an existing slot, in place, keeping its `commandId` and its position | `commandId`, `command`, `reason` | the slot does not exist; the slot is `retired` (restore it first, in this revision or an earlier one); the command bytes are empty; the new command bytes equal the current ones (a no-op is not a revision) |
| `add` | Introduces a new slot, appended after every existing slot of its layer | `layer`, `command`, `reason`, and `name` for the execution layer | the derived or supplied `commandId` collides with an existing slot, **including a retired one** — reinstating a retired slot is `restore`, never `add`; the command bytes are empty; an execution-layer `name` violates the §5.1 character rule |
| `retire` | Marks an existing slot `retired`: excluded from execution and from the review gate, retained in the plan and in every report | `commandId`, `reason` | the slot does not exist; the slot is already `retired` |
| `restore` | Returns a `retired` slot to `active`, keeping its `commandId`, its position, and its bytes | `commandId`, `reason` | the slot does not exist; the slot is already `active` |
| `annotate` | Records a reason against a slot, changing neither its bytes nor its state | `commandId`, `reason` | the slot does not exist |

Rules the table depends on:

1. **`reason` is mandatory on every operation** and must be non-empty
   after trimming. There is no default reason and no empty-reason path,
   and no reason is ever inferred from the operation, the command, or
   the Issue. An operator authoring several operations at once may state
   one reason for the whole revision rather than repeating it: the
   revision-level `--reason` (§11 rule 3) **satisfies this rule for
   every operation that does not carry its own**, and the applying
   surface materializes it onto each of them, so the persisted operation
   always carries a non-empty, operator-authored `reason` of its own.
   A per-operation reason, when supplied, wins for that operation and
   for no other. An amendment without a stated reason is an unauditable
   amendment.
2. **`retire` is not deletion.** A retired slot stays in the plan, in
   the digest (with `state: "retired"`), in the audit record, and in
   every report. Nothing in this contract removes a slot from a plan.
3. **`retire` is never success** (§8.4). It changes what is required;
   it asserts nothing about what passed.
4. **`retire` is reversible, and `restore` is its reversal.** No
   amendment this contract defines is one-way: a mistaken retirement —
   or a requirement the Issue reintroduces (§10 rule 3) — is reinstated
   by a `restore` naming the same `commandId`, which returns the slot to
   `active` at its original position with its original bytes and its
   whole history intact. Correcting the bytes of a retired slot is
   `restore` then `replace`; within a single revision the operations
   apply in their recorded order (§6.1 step 2), so both may sit in one
   revision. Because `add` refuses a `commandId` that collides with a
   retired slot, `restore` is the *only* way a retired slot returns, and
   §5.3 rule 6's promise that a mistaken amendment is reversed by a
   later revision therefore holds for retirement as well.
5. **There is no `reorder` operation.** Execution order stays #918
   §5.1's deterministic order as extended by §6.1; an operator who needs
   a different order changes the session configuration through its own
   surface.
6. **No operation targets a `"verification.pinned"` entry.** #915
   plan-approval entries are approval-governed; an operation naming one
   refuses the whole revision (§6.1 rule 4).

**The serialized operation.** `VerificationAmendmentOperation` is a
closed discriminated union on `kind`. Its serialized shape is normative,
because `revisionId` is derived from it (§5.3 rule 1) and two
implementations that encode it differently would derive different ids
for the same amendment:

```ts
type VerificationAmendmentOperation =
  | { kind: "replace";  commandId: string; command: string; reason: string }
  | { kind: "add"; layer: "execution"; name: string; command: string; reason: string }
  | { kind: "add"; layer: "requirement"; command: string; reason: string }
  | { kind: "retire";   commandId: string; reason: string }
  | { kind: "restore";  commandId: string; reason: string }
  | { kind: "annotate"; commandId: string; reason: string };
```

- **The field set of each variant is exact.** A field the variant does
  not list is not permitted, and a field it lists is required — there
  is no optional field in any variant. An `add` carries `layer`
  always and `name` **iff** `layer === "execution"`; a requirement-layer
  `add` carries no `name`, and its `commandId` is derived at
  application time (§5.1) rather than supplied. `commandId` is never
  supplied on an `add` and is always supplied on every other kind.
- **`command` and `name` are verbatim.** `command` carries the command
  bytes of §2 — trimmed at the ends, otherwise unaltered — and `name`
  carries the operator-supplied execution-layer name. Neither is
  rewritten, case-folded, whitespace-collapsed, or shell-unwrapped on
  the way into the record.
- **Canonical JSON is the encoding**: UTF-8, object keys sorted
  lexicographically at every level, array order preserved, no
  insignificant whitespace, and absent fields omitted rather than
  encoded as `null` or `""`. This is the same `canonicalJson` §5.3 and
  §5.4 hash with.
- **The identity form of an operation omits `reason` and nothing
  else.** It is what `revisionId` hashes (§5.3 rule 1), so retyping a
  reason on a retry cannot manufacture a new revision identity, exactly
  as the revision-level `reason` cannot. The stored operation keeps its
  `reason`; only the hash input drops it.
- **An unrecognized `kind`, an unrecognized `layer`, an absent required
  field, or an unexpected extra field fails closed**: the operation is
  refused and, by §5.3 rule 7, the whole revision with it. Nothing is
  coerced to a default.

### 5.3 The revision record

One operator invocation produces exactly one revision, applied
atomically — every operation or none:

```ts
interface VerificationAmendmentRevision {
  revisionId: string;            // "vamd-" + 16 lowercase hex (§5.3 rule 1)
  revisionOrdinal: number;       // 1-based, monotonic per task row
  requestKey: string;            // the caller-stable invocation key (§5.3 rule 2)
  scope: "task";                 // §4 rule 2
  source: "admin-cli" | "chatops" | "issue-refresh";
  actor: { kind: "operator"; id: string };
  reason: string;                // non-empty; the revision-level statement
  operations: readonly VerificationAmendmentOperation[];  // §5.2
  basePlanDigest: string;        // the plan this revision was authored against
  planDigest: string;            // the plan this revision produces
  sessionBaselineDigest: string; // the session-default layer it was authored over (§6.4)
  continuation: "review" | "implementation" | "none";
  createdAt: string;             // ISO-8601 UTC
  observedTaskRevision: number;  // the AiTask.revision the CAS write observed
  issueBodyDigest?: string;      // §10 rule 6; iff source === "issue-refresh"
}
```

1. **`requestKey` is the idempotency key; `revisionId` names what was
   applied.** Replay recognition looks the task's chain up on
   `(sessionId, issueNumber, requestKey)`, and it does so **before** the
   plan is recomputed, before `basePlanDigest` is compared, and before
   the §7.3 staleness check runs, so a retry is recognized as a replay
   (rule 3) even when its own first attempt already moved the plan. A
   `requestKey` is therefore unique per task row: two distinct revisions
   on one task never carry the same key.
   `revisionId = "vamd-" + sha256(canonicalJson({ sessionId,
   issueNumber, requestKey, basePlanDigest, operations})).slice(0, 16)`,
   where `operations` is the §5.2 identity form of the operation list —
   the canonical serialization with every operation's `reason` omitted.
   It excludes `reason` — the revision's and every operation's —
   `actor`, `createdAt`, `continuation`, and every run identifier, so
   what it names is the amendment itself: these operations, applied to
   that base plan. That exclusion is **direct**: a *derived*
   `requestKey` carries the requested continuation (rule 2), so two
   otherwise-identical invocations that differ only in `--continue`
   present different keys and therefore earn different ids — which is
   correct, because they are two requests, not one amendment described
   twice. It is the **content address of an applied revision**,
   and it is what downstream keys reference — the §12.2 public comment,
   the §8.3 per-slot evidence invalidation record, every report. It is
   **not**
   what a retry is matched on: a retry that rereads an already-amended
   plan reads a different `basePlanDigest` and would derive a different
   id from the same command line. The exclusion of run identifiers from
   both follows the established outbox-key rule: a retry must not
   manufacture a new identity.
   **`revisionOrdinal` is deliberately not an input to either.** The
   ordinal is assigned at write time, so hashing it would give every
   retry of an applied-but-unacknowledged invocation a fresh id — which
   is exactly the duplicate `requestKey` exists to prevent, and which
   bites hardest on the one operation that changes neither the plan nor
   its digest: a repeated `annotate` would otherwise be appended twice,
   once per attempt, while presenting the same `basePlanDigest` both
   times.
2. **`requestKey` is the caller's stable handle on one invocation, and
   is derived from caller-stable inputs alone.** It is
   operator-supplied through `--request-key <token>` (§11 rule 3) and,
   when absent, **derived** as `sha256(canonicalJson({sessionId,
   issueNumber, source, requestedContinuation, operations}))` over the
   same identity form, so an operator who simply reruns an unchanged
   command line after a lost response reuses it without knowing the
   flag exists.
   **`requestedContinuation` is the `--continue` value exactly as
   typed, and `null` when the flag is absent.** It is an input because
   the flag changes what the invocation *does*: an `annotate --continue
   none` and the same annotation with `--continue implementation` are
   two different requests — one records, one records and routes — and a
   key blind to the flag would derive one value for both, so the second
   would be silently reported as a replay and its routing never taken.
   The *resolved* continuation of §9.2 rule 3 is deliberately not
   hashed: the resolution reads the task's state, so hashing it would
   put a non-caller-stable value into the key and break the
   lost-response retry the moment the first attempt moved the task.
   Hashing the typed flag keeps the key computable from the command
   line alone.
   **`basePlanDigest` is deliberately not an input to the
   derivation.** The invocation this key has to survive is precisely
   the one whose `--yes` committed and whose response was lost: the
   operator reruns the same command line, and it now reads the plan
   their own first attempt produced. A key that hashed the base plan
   would derive a different value on that second read, miss the stored
   revision, and let the amendment apply a second time — or be refused
   as stale or as a no-op — instead of being reported as the replay it
   is. The key must be computable from what the caller typed, never
   from what the caller's earlier attempt changed; an operator-supplied
   token has that property by construction. A supplied token must be
   non-empty after trimming and must match
   `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`; a violation exits non-zero
   and mutates nothing (§11 rule 2). The key is recorded on the
   revision, so what made two invocations the same — or different — is
   readable afterwards.
3. **A repeat is recognized, not reapplied.** An invocation whose
   `requestKey` already appears on the task's revision chain is a
   **replay**: nothing is written, no `revisionOrdinal` is consumed, no
   event is appended, no comment is posted, and no continuation is
   re-taken. The surface reports the stored revision — its
   `revisionId`, its `revisionOrdinal`, and the `planDigest` it produced
   — and exits **zero**; a replay is a repeat, not a refusal (§11 rule
   5). Because the lookup precedes every plan comparison (rule 1), a
   replay is never reported as stale, as a no-op, or as a fresh
   amendment, however far the plan moved between the two attempts. The
   cost of a key that ignores the base plan is that a *deliberate*
   second application of the same operations — in practice the
   plan-neutral one, a second `annotate` whose new wording the identity
   form drops with every other `reason` — is indistinguishable by
   content from a retry, and so requires an explicit distinct
   `--request-key`; that flag is the only way to ask for one, and the
   replay report names it.
4. **`basePlanDigest` is what the operator saw.** It is captured from
   the plan the invocation read, before any operation is applied. A
   revision whose `basePlanDigest` does not equal the current plan's
   digest at write time is **stale** and is refused (§7.3) — but only
   once the rule 3 replay lookup has found no match, so a lost-response
   retry is a replay rather than a stale refusal. "The current plan's
   digest" is the digest recomputed from the live inputs and the chain
   (§6.4 rule 6), never the stored one, so a session-configuration
   change between the read and the write refuses as stale rather than
   landing on a plan the operator never saw.
5. **`planDigest` is what the operator gets.** It is computed over the
   plan the operations produce, and it becomes the next revision's
   `basePlanDigest`.
6. **The record is append-only.** A revision is never rewritten,
   reordered, merged, compacted, or removed. Correcting a mistaken
   amendment is a new revision that reverses it, with its own reason —
   never an edit of the old one.
7. **Composition is sequential; atomicity is all-or-nothing.** Every
   operation of a revision is validated against the plan state its
   predecessors *in the same revision* produced, in recorded order (§6.1
   step 2) — never against the base plan. Two consequences, and they are
   normative:
   - **A composition whose later operation is admissible against that
     intermediate state is valid, and its result is the state the
     sequence produces.** `restore S` then `replace S` is valid: the
     restore makes the slot `active` before the replace reads it.
     `replace S` then `retire S` is **valid too**, and produces one slot
     carrying the replaced bytes in state `retired` — `retire` retains
     the slot rather than removing it (§5.2 rule 2), so nothing the
     `replace` wrote is undone, and the §5.4 digest records the new
     bytes with `state: "retired"`. Neither ordering of a valid pair is
     rewritten, reordered, or collapsed: the recorded order is the
     applied order, and replay (§6.1 step 2) reproduces it.
   - **A composition whose later operation meets its own §5.2 refusal
     condition against that intermediate state refuses.** The cases are
     exactly the table's, read against the intermediate state: `retire
     S` then `replace S` (the slot is `retired` when the replace reads
     it — `restore` it first), `retire S` twice or `restore S` twice
     (the second finds the state it wants already set), an `add` whose
     `commandId` collides with one an earlier `add` in the same revision
     created, and a `replace` whose bytes equal what an earlier
     operation in the same revision left on the slot (still a no-op, and
     a no-op is still not a revision).

   When any operation refuses, **the whole revision refuses**: nothing
   is written, no `revisionOrdinal` is consumed, no event is appended,
   and partial application is never a permitted outcome.

### 5.4 The plan digest

`planDigest = sha256(canonicalJson(plan))`, where `plan` is:

```json
{
  "execution":   [ { "commandId": "exec:test", "state": "active",  "command": "npm test" } ],
  "requirement": [ { "commandId": "req:0f3b…", "state": "retired", "command": "npm run e2e" } ]
}
```

- Entries appear in **resolution order** (§6), execution layer first.
- `state` is `"active"` | `"retired"` — a closed set.
- `command` is the slot's command bytes (§2), verbatim — the digest is
  taken over what the runner would execute, not over a rewritten form of
  it, so two plans whose commands differ in shell-significant bytes have
  different digests.
- The digest covers **the plan and nothing else**: no revision ids, no
  reasons, no actors, no timestamps, no evidence. Two different revision
  paths that arrive at the same plan therefore produce the same digest —
  which is exactly what makes an operator's `--expect-plan-digest`
  guard meaningful, and what makes the §11 rule 6 reconciliation check a
  test of the plan rather than of its history.
- It is **not** #918's `setFingerprint`. `setFingerprint` (#918 §5.1) is
  computed by the runner over the resolved executable set — names,
  operation classes, and command identities, including `#915` pinned
  entries. `planDigest` covers the operator-facing plan, requirement
  slots and retirement states included, and covers no pinned entry. The
  two are different digests over different things; neither is derived
  from the other, and an implementation must not substitute one for the
  other.

### 5.5 Persistence

The revision chain is durable task state, stored on the task row
alongside the context that carries `manualVerificationEvidence` today.
The shape is normative; the storage slice is an implementation issue.

The stored state has **two parts with two different mutability rules**,
and conflating them is the one way this record corrupts itself:

- **The revision chain** — stored in ascending `revisionOrdinal`,
  append-only. Every field of every `VerificationAmendmentRevision`
  (§5.3) is immutable once written, its `basePlanDigest`, its
  `planDigest`, and its `sessionBaselineDigest` included: each records
  what was true when *that* revision was applied, and nothing — not a
  later revision, not a §6.4 rule 5 rebase — ever rewrites one (§5.3
  rule 6).
- **The plan checkpoint** — exactly one per task, **mutable**, replaced
  wholesale by the surface that applies a revision or performs a rebase.
  It is stored in the same task context as the chain and so introduces
  no column of its own:

```ts
interface VerificationPlanCheckpoint {
  planDigest: string;             // §5.4, over the plan §6 resolves *now*
  sessionBaseline: readonly { name: string; command: string }[];  // §6.4 rule 1
  sessionBaselineDigest: string;  // sha256(canonicalJson(sessionBaseline))
  appliedThroughOrdinal: number;  // the highest revisionOrdinal the checkpoint covers
  updatedAt: string;              // ISO-8601 UTC
  updatedBy: "revision" | "rebase";  // a closed set
}
```

1. **"The stored `planDigest`" always means the checkpoint's.** Every
   reconciliation in this document — §6.4 rule 3, §11 rule 6 — compares
   against `checkpoint.planDigest` and against no revision's. A
   revision's `planDigest` is *history*: the plan that revision produced,
   over the session baseline it was authored over, and it stays correct
   forever precisely because nothing updates it. The checkpoint is the
   present tense: the plan the task is understood to be running under
   right now.
2. **A rebase writes the checkpoint and nothing else.** §6.4 rule 5's
   re-anchoring replaces `planDigest`, `sessionBaseline`, and
   `sessionBaselineDigest` with the live values and sets `updatedBy:
   "rebase"`, leaving `appliedThroughOrdinal` unchanged — no revision was
   applied, so no ordinal was consumed. It touches no revision record.
   Without this split a rebase would have to either overwrite the newest
   revision's `planDigest`, corrupting the append-only audit record, or
   leave a stale digest in place, making every later reconciliation
   compare against the pre-drift plan and refuse a task whose plan is
   correct. Both are forbidden; the checkpoint is what makes neither
   necessary.
3. **An applied revision writes both, in one transaction.** The revision
   is appended and the checkpoint is replaced in the same CAS write, with
   that revision's `planDigest`, the `session.verification` snapshot
   observed inside the transaction (§6.4 rule 1),
   `appliedThroughOrdinal = revisionOrdinal`, and `updatedBy:
   "revision"`. There is no commit boundary between the two, so they
   cannot diverge.
4. **The session baseline lives on the checkpoint** — the
   `sessionBaseline` snapshot and its `sessionBaselineDigest` (§6.4 rule
   1) — so that a later `session.verification` change is attributable to
   the session layer instead of being read as task-row corruption.
5. **A task with no revision has no checkpoint**, and needs none:
   resolution is total (§6.3), so the plan is whatever §6 computes from
   the live inputs and there is nothing to reconcile against. The
   checkpoint comes into existence with the first revision (§6.4 rule 1)
   and never returns to absent.

The rest of the persistence posture is unchanged:

- **No new column, table, `TaskStatus`, `TaskPhase`, or store method is
  required.** The amendment is task context plus one task event (§12.1);
  the write is an ordinary compare-and-swap on `AiTask.revision`.
- Malformed persisted state — a chain that does not parse, an ordinal
  gap, or a stored digest that reconciles against **neither** the live
  inputs nor the recorded session baseline (§6.4 rule 3) — **fails
  closed** (§11 rule 6): it is refused, never coerced to a default,
  never silently repaired, and never overwritten. A stored digest that
  reconciles against the baseline is authorized session drift, not
  malformed state, and is rebased rather than refused (§6.4 rule 5).
- The checkpoint has **two malformed forms of its own**, and they fail
  closed the same way: a chain that carries revisions with no checkpoint
  beside it, and a checkpoint whose `appliedThroughOrdinal` differs from
  the chain's highest `revisionOrdinal`. Each says a write landed half
  applied, which rule 3's single transaction makes impossible; neither is
  repaired by recomputing the missing half.

## 6. Resolving the effective plan

Resolution is deterministic, total, and runs from durable inputs alone.
It is a pure function of `(session.verification, context.body, the
revision chain, the recorded session baseline)`; it reads no live
provider state, no agent output, and no evidence. It is also **pure in
the other direction**: resolving a plan writes nothing, so the
reconciliation of §6.4 classifies and reports, and only a surface that
already holds a write transaction records the result.

### 6.1 The effective execution set

1. Start from #918 §5.1 rule 1's base: every `session.verification`
   entry, in declaration order, as an `exec:<name>` slot with state
   `active`. The map read here is the **live** one, so a later
   session-configuration fix reaches an amended task like any other;
   §6.4 says how that change is attributed instead of mistaken for a
   hand-edited task row.
   **A session entry whose `exec:<name>` identity is already claimed by
   an execution-layer `add` in the applied chain materializes no slot
   here.** The task-local slot owns the identity — §3.2's precedence,
   applied to a collision the authoring check could not have seen because
   the session key did not exist when the `add` was authored (§5.1) — and
   the session entry is reported **masked by** that `add` revision (§6.4
   rule 4). This is the only case in which step 1 skips a live
   `session.verification` entry, and it exists because the two
   alternatives are both worse: materializing the entry as well would put
   two slots with one `commandId` in the plan, sharing one
   `verification-<name>.log` artifact (#918 §11.1) and one failure
   message, and refusing resolution would wedge an amended task on a
   session edit the operator made in good faith for every other task in
   the session — against §6.3's totality. **Masking is keyed on the `add`
   being present in the chain, not on the state of the slot it created**:
   retiring the task-local slot does not unmask the session entry and
   swap its bytes back into the plan, because a retirement asserts what
   must not run, not which bytes should run instead. An operator who
   decides the session bytes are the right ones adopts them with a
   `replace` on the task-local slot, which is recorded, reasoned, and
   visible like every other amendment.
2. Apply every applied revision in ascending `revisionOrdinal`, and
   within a revision every operation in its recorded order:
   - `replace exec:<name>` substitutes the command bytes in place;
     the slot keeps its position.
   - `add` appends a new `exec:<name>` slot after every slot already in
     the set, so additions accumulate in revision-then-operation order.
     Because step 1 skips a colliding session entry, the replay never
     produces two slots with one `commandId`, and the added slot keeps
     its append position rather than moving to the declaration position
     of the session key that arrived after it.
   - `retire exec:<name>` sets the slot's state to `retired`; a retired
     slot is excluded from execution and stays in the plan.
   - `restore exec:<name>` sets a `retired` slot's state back to
     `active`; the slot keeps its original position and bytes, so a
     restored command returns to the set exactly where it left it,
     never appended at the end.
   - `annotate` changes neither bytes, state, nor position.
   - **An operation whose target slot is not in the set when the replay
     reaches it is inert**: it is skipped, it changes no bytes, state,
     or position, and resolution continues past it. It never
     materializes a slot that step 1 did not produce and no `add`
     created, and it never refuses — §6.3's totality holds over every
     recorded chain. This is the removed-`session.verification`-key
     case, and §6.4 rule 4 reports the slot **orphaned**. Only
     *authoring* refuses an operation against an absent slot (§5.2,
     §5.3 rule 7); replaying an already-recorded chain does not.
3. The `active` slots of the result, in order, are what #918 §5.1 rule 1
   resolves for the cycle. #918 §5.1 rule 2's `"verification.pinned"`
   entries follow, in ascending `entryId`, unchanged; #918 §5.1 rule 3's
   non-derivation rule holds unchanged, because an amendment is operator
   *authored*, never derived — no issue text, agent output, PR content,
   or auto-detection contributes a command.
4. **Amendments never precede, displace, reorder, or modify a
   `"verification.pinned"` entry.** An operation naming a pinned entry
   refuses the revision (§5.2 rule 6). Correcting an approved plan entry
   is #915's approval renewal, not an amendment.
5. **A task-scoped `add` is standing operator authorization, scoped to
   one task.** It is the same mechanism as #918 §3 rule 1 —
   operator-authored command bytes the runner executes unattended — with
   a task-scoped origin instead of a session-scoped one. It requires no
   Tool Request, no grant, and no per-run approval, and it changes no
   tier, backend, or class: the added command resolves as
   `"verification.run"` exactly as a session entry does.

The main correction this enables is the common one: the Issue requires
`npm run e2e`, the session never configured it, and the review gate
blocks. The fix is an **execution-layer `add`** naming the command, not
a requirement-layer edit — the requirement was right, the executable set
was incomplete.

### 6.2 The effective requirement set

1. Start from `extractIssueVerificationCommands(context.body)` — the
   **intake-pinned** snapshot, in extraction order, as `req:` slots with
   state `active` and identities per §5.1.
2. Apply the revision chain exactly as §6.1 step 2 does, over the
   requirement layer.
3. Satisfaction is computed at review time by the shipped
   `buildIssueVerificationStatus` semantics, unchanged: a slot is
   `passed` when a value of the **effective execution set** matches it
   under `matchesConfiguredVerificationCommand`, or when a passing
   (exit 0) `manualVerificationEvidence` entry matches it **and carries
   no §8.3 rule 1 invalidation record naming that slot's `commandId`** —
   the one clause §8.3 rule 2 adds, and the only one; otherwise
   `not_run`. Retired slots are excluded from the gate and reported
   `retired` (§8.4), never `passed` and never `not_run`.
4. **Resolution never writes a status.** An amendment can make a slot
   satisfiable; only a later review run's evaluation makes it satisfied.
   No amendment path writes `passed` into any status field, ever.

### 6.3 Ordering and totality

The effective plan is the execution set followed by the requirement set,
each in the order above. Resolution is total: an empty
`session.verification`, an absent `context.body`, an empty revision
chain, and any combination of them resolve to a well-defined (possibly
empty) plan with a well-defined digest. An empty plan is not an error
and is not "verification passed"; it is a plan with nothing in it, and
#918 §8.1's trivially-`passed` empty-set rule governs execution
unchanged.

### 6.4 Session-default drift and the task baseline

§6.1 step 1 reads the **live** `session.verification`, and it must: an
operator who fixes a genuinely wrong session default expects every task
in the session to pick the fix up, amended tasks included. But §11 rule
6 also demands that a stored `planDigest` which no longer reconciles be
refused as a hand edit. Both rules are right, and without a recorded
baseline they collide: an authorized session edit would be
indistinguishable from a tampered task row, and every amended task in
the session would be refused for a plan that is perfectly correct.

The **session baseline** resolves the collision by making drift
*attributable* instead of assumed hostile.

1. **The baseline is recorded on the checkpoint.** When a task's first
   revision is applied, the write creates the §5.5 plan checkpoint and
   records `sessionBaseline` on it — the ordered `{name, command}` pairs
   of `session.verification` as observed inside that transaction, command
   bytes verbatim (§2) — and
   `sessionBaselineDigest = sha256(canonicalJson(sessionBaseline))`.
   Every later revision records the `sessionBaselineDigest` it was
   authored over (§5.3). The baseline is a copy of operator input kept
   for attribution only: nothing executes from it, and it is never a
   second source of truth for what to run.
2. **Drift is defined, not inferred.** The session-default layer has
   drifted for a task when the digest of the live `session.verification`
   differs from the stored `sessionBaselineDigest`. Nothing else is
   drift — in particular, a stored `planDigest` that disagrees while the
   baseline digest matches is not drift, it is a hand edit.
3. **Reconciliation is three-way, and only one outcome is corruption.**
   A surface resolving the plan of a task that carries a revision chain
   classifies, in this order. Throughout, **the stored `planDigest` is
   the checkpoint's** (§5.5 rule 1) — never a revision's, which records
   history and is not a statement about the plan now — and **the
   baseline test is rule 2's**: the digest of the live
   `session.verification` against the stored `sessionBaselineDigest`.
   - **unreconciled** — recomputing §6 over the live inputs and the
     chain disagrees with the stored `planDigest`, *and* replaying the
     same chain over the recorded `sessionBaseline` (with `context.body`
     unchanged, as it always is) does not reproduce it either. The
     stored state is derivable from no recorded input, so it was written
     outside this surface. Refuse, fail closed, repair nothing (§11 rule
     6).
   - **drifted** — the state is not `unreconciled` and the baseline test
     says the session layer moved. Proceed on the **live** plan and
     rebase (rule 5). This is **not** a refusal, and an implementation
     that refuses here is refusing a correct plan.
     **The classification is on the baseline, not on the plan
     digest.** A session change that leaves the effective plan
     byte-identical still classifies `drifted` — above all the §6.1 step
     1 mask, where a session key arriving under an execution-layer `add`
     materializes no slot and so moves no digest at all. Such a
     **plan-neutral drift** re-anchors the checkpoint and reports its
     rule 4 disposition exactly as a plan-visible one does; only the
     rebase's `planDigest` is then unchanged (rule 5). Testing the plan
     digest first would classify precisely these changes `consistent`,
     leaving the checkpoint anchored to a `sessionBaseline` the session
     no longer has, skipping the promised masked-entry report and its
     `verification.amendment.rebased` event, and deferring the drift
     until some later edit happened to move the plan — at which point
     the recorded baseline would be two session edits behind and the
     rule 4 dispositions would be computed against the wrong "before".
   - **consistent** — the baseline test says the session layer did not
     move, and the recomputation reproduces the stored `planDigest`.
     Proceed, and rebase nothing.

   The three are exhaustive and disjoint. When the baseline digest
   matches, the live session entries and the recorded baseline are the
   same input, so the live recomputation and the baseline replay agree
   and the outcome is `consistent` or `unreconciled`; when it differs,
   the outcome is `drifted` or `unreconciled`. Only the first outcome is
   the hand-edit refusal §11 rule 6 describes.
4. **Precedence is unchanged under drift, and every disposition is
   reported.** Per slot:
   - a session entry whose bytes changed under a slot no amendment gave
     bytes to — the live bytes win, exactly as §3.2's origin-layer rule
     already says;
   - a session entry whose bytes changed under a slot an amendment
     `replace`d — the amendment still wins (§3.2), and the
     reconciliation reports the session change as **masked by** the
     revision that named the slot, so the operator who fixed the session
     sees why this task is unaffected and can reverse the amendment with
     a further revision (§5.3 rule 6);
   - a session key that disappeared — an **execution-layer `add` slot
     is unaffected**: it is task-local, the chain itself materializes it
     (§6.1 step 2), and it has no session origin to lose. A slot that
     exists only because `session.verification` declared it **leaves the
     plan and is reported orphaned**, and it does so *even when a
     revision `replace`d, retired, restored, or annotated it*: §6.1 step
     1 materializes execution slots from the live `session.verification`
     map and from nothing else, so with the key gone there is no base
     slot for those operations to apply to and they are inert (§6.1
     step 2). An implementation must **not** resurrect the slot from the
     recorded `sessionBaseline` — the baseline is attribution-only input
     that nothing executes from (rule 1), and a plan assembled partly
     from it would run bytes the operator has since deleted from the
     session. `orphaned` is a reporting term, never a slot state: the
     slot is simply absent from the plan and from the digest, its
     operations stay in the append-only chain, and if the key returns
     the chain replays onto it again — resolution always replays from
     scratch (§6.1), so the returning slot regains its `replace`d bytes
     and its retired-or-restored state, and can neither lose nor collide
     with the operations recorded against it;
   - a session key that appeared — an ordinary new `exec:` slot,
     `active`, at its declaration position (§6.1 step 1) — **unless its
     `exec:<name>` collides with an execution-layer `add` already in the
     chain**, in which case step 1 materializes no slot for it and the
     reconciliation reports it **masked by** that `add`. It is the same
     disposition as a changed session entry under a `replace`d slot, and
     for the same reason: an amendment owns the slot it named. One
     `commandId` is therefore never two slots, resolution never refuses
     over the collision, and the operator who added the session key sees
     from the mask why this one task still runs its task-local bytes.

   No disposition deletes a revision, rewrites an operation, invents
   one, or writes a status (§6.2 rule 4).
5. **A rebase records the new anchor; it is not an amendment.** On a
   `drifted` classification, the first surface that both observes the
   drift and holds a write transaction — an applying `amend` or
   `refresh`, or the phase runner resolving the plan at claim time —
   updates the **§5.5 plan checkpoint**, and only it: its
   `sessionBaseline`, `sessionBaselineDigest`, and `planDigest` take the
   live values and `updatedBy` becomes `"rebase"`, under the ordinary CAS
   on `AiTask.revision`. It then appends one
   `verification.amendment.rebased` task event (§12.1) carrying both
   baseline digests, both plan digests, and the rule 4 dispositions.
   **A plan-neutral drift rebases like any other**: the two
   `sessionBaselineDigest`s in the event differ, the two `planDigest`s
   are equal, the checkpoint is re-anchored all the same, and the event
   is then the only record that the session layer moved under this task —
   which is why the rebase is driven by rule 3's baseline test and never
   skipped for want of a digest change. A
   rebase **creates no revision, consumes no `revisionOrdinal`, changes
   no operation, rewrites no revision record — the `planDigest` of every
   applied revision keeps saying what that revision produced (§5.5 rule
   2) — takes no continuation (§9), and posts no public comment
   (§12.2)**: the operator-owned plan did not change, the ground under it
   did. Read-only surfaces (`plan`, reports) name the drift in their
   output and write nothing; the next writing surface rebases.
6. **A revision authored against a drifted plan is stale, not corrupt.**
   `basePlanDigest` (§5.3 rule 4) is compared against the live
   recomputed digest, so an operator who read the plan before a session
   change and applied after it is refused as stale (§7.3 rule 2) with
   the drift named, and re-reads. That refusal is what makes rule 5's
   rebase safe: a rebase never carries a revision onto a plan its author
   did not see.

## 7. Admissible task states

### 7.1 The state table (normative)

| `TaskStatus` | Amendment | Why |
| --- | --- | --- |
| `queued` | **permitted** | Nothing holds the task; the next claim resolves the amended plan |
| `blocked` | **permitted** | The implementation-lane human park (issue #224); no owner holds the row |
| `ready_for_human` | **permitted** | The primary case — the review Step 4.5 missing-command handoff |
| `claimed` | **refused** | An owner holds the task and has resolved a plan; amending underneath it would produce evidence bound to a plan that no longer exists |
| `running` | **refused** | Same, and a verification cycle may be in flight |
| `done` | **refused** | Terminal; no future cycle reads the plan |
| `failed` | **refused** | Terminal; reactivate through the shipped recovery surface first, then amend |
| `cancelled` | **refused** | Terminal by operator act (issue #608); a cancelled task never advances |

### 7.2 How `claimed` and `running` fail closed

1. **The refusal is unconditional.** No flag overrides it. There is no
   `--force`, and none may be added: a forced amendment is precisely the
   race the CAS cannot see, because the owning run holds its resolved
   plan in memory and will not re-read it.
2. **The refusal is a refusal, not a queue.** Nothing is stored, no
   revision is created, no `revisionOrdinal` is consumed, and no event
   is appended. The operator retries after the run completes; the
   contract defines no deferred or pending amendment.
3. **The message names the state and the owner** — the status and, when
   recorded, `ownerRunId` — and points at the recovery surface for a run
   that will never finish. This mirrors the shipped
   `review-verification resolve` refusal on active tasks verbatim; it
   invents no new phrasing and no new posture.
4. **The refusal exits non-zero** (§11 rule 5) so scripted use cannot
   mistake it for a no-op success.
5. **Terminal statuses refuse for a different reason and say so.**
   `claimed`/`running` refuse because the task is *active*;
   `done`/`failed`/`cancelled` refuse because it is *finished*. The two
   messages must be distinguishable — the second one names the
   reactivation path, the first one names waiting.

### 7.3 Concurrency

1. **The guard is a compare-and-swap on `AiTask.revision`**, plus the
   §7.1 status check re-evaluated inside the same transaction. Two
   operators amending the same task concurrently: one commits, the other
   observes a changed revision and refuses as stale.
2. **A stale refusal is recoverable and specific**: the message names
   the observed and current revision, and the observed and current
   `planDigest`, so the operator can re-read the plan and re-issue. When
   the difference is session-default drift (§6.4 rule 2) rather than a
   competing revision, the message says so and names the drift, because
   the two have different fixes: waiting out another operator versus
   re-reading a plan whose session layer moved.
3. **`basePlanDigest` is the second, optional guard.** When the operator
   supplies an expected digest (§11 rule 3) and it does not match the
   current plan, the revision refuses even if the CAS would have
   succeeded — a plan can be changed and changed back, and an operator
   who pinned a digest asked for exactly that check.
4. **No new lock is introduced.** An amendment is a metadata write on
   the task row; it takes no worktree lock, no issue lock, and no
   maintenance lock. The `claimed`/`running` refusal plus the CAS is the
   complete concurrency contract, and an implementation that adds a lock
   is changing this document first.

## 8. Evidence invalidation and preservation

### 8.1 The preservation rule comes first

**No amendment ever deletes evidence.** Not a cycle bundle, not a
manual evidence entry, not a run artifact, not a prior revision.
"Invalidation" in this section means exactly one thing: *no longer
admissible as evidence for the current plan*. The record stays, and it
stays readable, with the revision that invalidated it — and the slot it
was invalidated *for* — named on it (§8.3 rule 1).

### 8.2 Execution-layer amendments

A `replace`, `add`, or `retire` on the execution layer changes the
resolved set, and therefore changes #918 §5.1's `setFingerprint` on the
next cycle. Every runner-produced bundle bound to the previous
fingerprint stops being admissible continuation evidence **by #918 §8.2
rule 3, which already says so** — evidence binds to identities, not to
time. This contract adds no rule here; it records that an amendment is
one of the triggers, and that the trigger is a consequence of the
identity binding rather than a special case.

The Tool Request direct-to-review gate (#918 §10.3 E7) therefore fails
after an amendment for any pre-amendment bundle, and falls back to the
shipped implementation continuation. That is the designed behavior, not
a regression: the corrected plan has not been executed yet.

### 8.3 Requirement-layer amendments

| Operation | Effect on `execution-evidence` |
| --- | --- |
| `replace` on slot S | Every manual evidence entry that satisfied S is invalidated **for S, and for S alone**, by a per-slot invalidation record naming S's `commandId` and marked `supersededByRevision: <revisionId>` (rule 1). The entry is preserved, and it remains matchable against any *other* slot it satisfies under the shipped semantics — it was a true statement about a command that ran, and it stays one |
| `add` | Invalidates nothing. Existing evidence stands; the new slot simply starts unsatisfied |
| `retire` | Invalidates nothing and satisfies nothing (§8.4) |
| `restore` | Invalidates nothing and satisfies nothing. The slot returns to the gate with its bytes unchanged, so whatever evidence the §6.2 rule 3 semantics — the shipped ones as extended by rule 2 below — already match against it, including evidence recorded before its retirement, which was never deleted (§8.1), matches it again; evidence that never matched it still does not, and neither does evidence an earlier `replace` of that same slot invalidated for it (rule 3) |
| `annotate` | Invalidates nothing, by definition |

The `replace` rule is the load-bearing one: a passing result for the
wrong command proves nothing about the right command, so carrying it
forward would launder a correction into a pass.

Rules the table depends on:

1. **Invalidation is recorded per slot, never per entry.** One manual
   evidence entry can satisfy more than one requirement slot — the
   shipped `matchesConfiguredVerificationCommand` semantics match by
   command, and two slots may carry the same bytes. A bare
   entry-level mark would therefore be unreadable: a matcher seeing it
   would have to exclude the entry from *every* slot, which contradicts
   the table's promise that it stays matchable elsewhere, or ignore it,
   which carries the superseded result into the corrected slot. The
   record is consequently keyed on the slot:

   ```ts
   type EvidenceSlotInvalidation = {
     commandId: string;              // the requirement slot the entry
                                     // stops satisfying (§5.1)
     supersededByRevision: string;   // the §5.3 revisionId that did it
   };
   ```

   and each manual evidence entry carries an append-only list of them,
   empty for an entry nothing has superseded. `commandId` is a
   requirement-layer identity: the execution layer invalidates by
   `setFingerprint` instead (§8.2) and writes no record here.
2. **The matcher reads it, and reads nothing else.** §6.2 rule 3's
   satisfaction test gains exactly one clause: a manual evidence entry
   is inadmissible for slot S when its list carries a record whose
   `commandId` is S's. For every other slot the entry matches, it is
   admissible unchanged. No other field of the entry is consulted, and
   no invalidation is inferred from a revision the entry does not name.
3. **The list is append-only and idempotent per slot.** At most one
   record per `commandId` per entry: an entry already invalidated for S
   cannot match S again, so a later `replace` of S finds nothing of that
   entry to supersede and rewrites nothing — the earlier record, with
   its earlier `revisionId`, stands. Nothing removes a record, and
   nothing edits one (§8.1); a `restore` in particular reinstates a slot
   without clearing the records naming it, because a superseded result
   is superseded whatever the slot's state.

### 8.4 Removal is never success

1. A retired slot is reported `retired` — a state distinct from
   `passed`, `failed`, and `not_run` — everywhere a slot's state is
   reported: the operator surface, the audit record, the public comment
   (§12.2), and any future set-level summary.
2. A retired slot contributes **no** `passed` classification to a #918
   cycle, no entry to `verificationNames`/`verificationPassed`, and no
   satisfaction to the review gate. It is excluded, not credited.
3. Retiring the last active requirement does **not** produce
   "verification passed". It produces "no verification required for this
   task, by operator amendment `<revisionId>`" — a reportable state that
   names the revision and reads differently from a passing run to any
   human or any grep.
4. An amendment never marks a review passed, never routes a task to
   `done`, and never closes an Issue.
5. **A restoration is reported as explicitly as a retirement.** A
   `restore` names the slot it reinstates in the operator output, the
   audit event, and the public comment (§12.2), and the reinstated slot
   is reported `active`. Restoring a check is not a pass either; it is
   the check coming back. Whether the reinstated slot is *already*
   satisfied is decided by §8.3's `restore` row and by nothing in this
   rule: the restoration itself satisfies nothing, and the slot's
   satisfaction is then whatever the shipped evidence semantics make of
   its unchanged bytes — preserved evidence that matched before the
   retirement matches again, because the retirement deleted nothing
   (§8.1) and invalidated nothing (§8.3). The report states which of
   the two the slot is; it never asserts a rerun that the gate does not
   require.

### 8.5 What this contract does not change about evidence

`admin review-verification resolve`'s failure path clears recorded
passing `manualVerificationEvidence` (issue #622 review, P1) because a
fix that follows may invalidate an earlier passing command. That is
evidence-layer bookkeeping on a different trigger; it is **unchanged**
here, is not an amendment, and produces no revision.

## 9. Continuation after an amendment

### 9.1 The default is review, not implementation

An amendment corrects **what is verified**, not the change under test.
Routing to implementation would spend an agent invocation on a task
whose diff needs no edit, and the review lane re-executes the
session-configured set in its own worktree (#918 §12.4) — which is
exactly the work the corrected plan now demands. So the default
continuation is: **recompute the effective plan and return to review.**

### 9.2 The continuation table (normative)

| Task state at amendment | Default continuation |
| --- | --- |
| `ready_for_human` + `review` | Re-queue `{status: "queued", phase: "review"}` |
| `blocked` + `review` | Re-queue `{status: "queued", phase: "review"}` |
| `ready_for_human` + any non-review phase | Recorded only; the task stays parked. The park has another cause and is resolved by its own surface |
| `blocked` + any non-review phase | Recorded only; the task stays `blocked` |
| `queued` (any phase) | Recorded only; the task stays `queued` at its recorded phase, and the next claim resolves the amended plan |

Rules:

1. **No new vocabulary.** `{queued, review}` is the shipped edge that
   the implementation→review success transition already uses (#918
   §12.3, R5). No `TaskStatus`, `TaskPhase`, `PhaseRunOutcome`, or
   `PhaseHandlerResult` member is added, and `nextPhaseAfter` and
   `checkReviewAdmission` are unchanged.
2. **Recompute before routing.** The re-queue happens only after the new
   plan and its digest are persisted, in the same transaction, so a
   claim can never observe a re-queued task with a stale plan.
3. **An explicit operator override exists, is recorded, and reaches no
   further than the table does.**
   `continuation: "implementation"` routes `{queued, implementation}`
   for the case where the amendment revealed that the *code*, not the
   requirement, is wrong. `continuation: "none"` records the revision
   and routes nothing. The set is closed —
   `"review" | "implementation" | "none"` — and an unrecognized value
   fails closed (§11 rule 2). The default is `"review"` where the table
   permits a re-queue and `"none"` everywhere else, and **every
   non-`none` continuation is available only on a table row that
   permits a re-queue**: an explicit `"review"` *or* an explicit
   `"implementation"` on a row whose default is `"none"` refuses rather
   than inventing a route, and the refusal names the row's state and
   phase and mutates nothing (rule 5). The override is a choice of
   *which* lane a re-queueable task returns to, never a way to acquire
   a re-queue the table withholds. This is what keeps the two
   `Recorded only` park rows honest: a task parked `ready_for_human` or
   `blocked` outside `review` is owned by the surface that parked it,
   and the amendment surface must not requeue it under either route —
   an `--continue implementation` that did so would unpark a
   human-owned or Tool-Request-owned task from here, which §13.4
   forbids.
4. **Continuation never skips review admission.** A re-queued review
   task passes #681's admission checks unchanged on the receiving side;
   this contract adds no verification evidence to admission and removes
   no check from it.
5. **A refused amendment continues nothing.** No revision, no re-queue,
   no event (§7.2 rule 2).

## 10. Refresh from the Issue

`refresh-from-issue` is a **source** for an ordinary revision, not a
second mechanism. It re-reads the Issue body live, re-runs the shipped
extractor, diffs the result against the current requirement layer, and
proposes a revision containing requirement-layer operations only. It
then goes through §5–§9 like any other revision.

1. **Verification-only projection.** The refresh consumes exactly one
   projection of the Issue body: the output of
   `extractIssueVerificationCommands`. It never updates `context.body`,
   the task title, labels, priority, assignment, phase, dependencies,
   the Issue's goal, its acceptance criteria, or any implementation-scope
   field. **The latest Issue body never becomes silently authoritative
   for any task field.** `context.body` deliberately stays the pinned
   intake snapshot, and the amendment layer is what makes the corrected
   requirement effective (§3.2) — which is why the refresh needs no
   write to it.
2. **Operator-invoked, preview by default.** No scheduled refresh, no
   intake-time refresh, and no phase handler that triggers one. A
   refresh prints the proposed revision and applies nothing without the
   explicit confirmation flag (§11 rule 1).
3. **The refresh matches by effective bytes first, and never emits
   `replace`.** The diff is taken against the **effective** requirement
   layer (§6.2) — the slots as the amendments left them, not as intake
   extracted them — and matching runs in the order below, one-to-one:
   each live command and each slot is consumed at most once, live
   commands in extraction order, slots in resolution order.
   1. **Active slot, by command bytes.** A live command that matches an
      `active` slot's *current effective* command bytes under
      `matchesConfiguredVerificationCommand` (§13.2 — the same
      equivalence the review gate uses, so the refresh and the gate
      never disagree about whether the Issue's demand is already in the
      plan) matches that slot and produces **no operation**. This rule
      is what lets an earlier `replace` survive a refresh: once an
      operator has replaced requirement A with B, the slot keeps A's
      `commandId` (§5.1) while carrying B's bytes, so an Issue that now
      names B matches that slot exactly. Matching by identity alone
      would read B as live-only and its own slot as plan-only, and the
      refresh would propose an `add` of a check the plan already has
      plus a retirement of the slot that has it — the
      duplicate-and-retire failure this rule exists to prevent.
   2. **Retired slot, by command bytes.** A still-unmatched live command
      that matches a `retired` slot's current bytes under the same
      equivalence produces a `restore` of that slot.
   3. **Retired slot, by identity.** A still-unmatched live command
      whose `req:` identity (§5.1) equals a `retired` slot's
      `commandId` produces a `restore` of that slot — the Issue is
      asking for a check the plan has, so the slot is reinstated rather
      than duplicated, which is also why an `add` colliding with a
      retired slot refuses (§5.2). Because a retired slot's bytes may
      have been corrected before its retirement, a restoration under
      this rule can reinstate bytes that differ from the live text; the
      refresh reports the difference and still emits no `replace` for
      it.
   4. **An unmatched live command becomes an `add`.**
   5. **An unmatched `active` slot becomes a *proposed* `retire`.** An
      unmatched `retired` slot produces nothing; it is already retired.

   A lineage-preserving correction — "command B is the fixed form of
   command A" — is a judgment only a human can make, so it stays an
   explicit operator `replace` naming the `commandId`. This removes
   lineage guessing from the mechanism entirely rather than bounding it.
4. **A proposed `retire` is never applied implicitly.** Removals are the
   changes that can weaken verification, so they are included in the
   preview and enter the applied revision only under an explicit
   opt-in flag. A refresh run without that opt-in applies its `add`
   and `restore` operations and reports the withheld retirements; it
   never silently drops them from the output. `add` and `restore` need
   no opt-in because neither weakens verification: one introduces a
   check and the other brings one back.
5. **Ambiguity and provider failure fail closed.** A provider error, a
   missing or inaccessible Issue, an unparseable body, or a diff the
   rules above cannot map refuses the refresh whole. No partial revision
   is applied, and no `revisionOrdinal` is consumed.
6. **The read is pinned in the record.** A refresh revision records
   `issueBodyDigest` — SHA-256 over the raw fetched body — and
   `source: "issue-refresh"`. The digest is provider-neutral, so the
   record reads the same for GitHub and Gitea, and it makes "which text
   was this derived from" answerable after the fact.
7. **A refresh that finds no difference is a no-op, not a revision.** It
   exits successfully, reports "no change", consumes no ordinal, and
   appends no event.
8. **An Issue edited between the preview and the apply is detected, not
   applied.** The preview reports the `issueBodyDigest` it read, and
   `--expect-issue-digest <digest>` re-reads the Issue and refuses when
   the live body no longer hashes to that value. The refusal is
   fail-closed and specific — it names both digests, writes nothing, and
   consumes no ordinal — so an operator who reviewed one diff can never
   apply a different one. The guard is opt-in for the same reason
   `--expect-plan-digest` is (§7.3 rule 3): a refresh run without it
   still applies only what its own read produced. The Issue is only half
   the input: a refresh diffs the live text against the task's own
   effective plan, so `--expect-plan-digest <digest>` guards the other
   half and refuses when another revision moved the plan between the
   preview and the apply — the same refusal, for the case where the
   Issue body is untouched but the difference derived from it is not.
   A refresh's own retry is not that case: the rule 7 replay
   recognition is consulted first, so an apply whose response was lost
   is still reported as the repeat it is rather than as a conflict with
   the plan it produced itself. That retry is the only bypass, and it
   is recognized from the chain — by the revision it already applied,
   whose base plan digest is the very digest it is guarding with — and
   never from the emptiness of the difference: a run that merely finds
   nothing left to do is still guarded, because a concurrent amendment
   can leave the live Issue and the plan agreeing after the preview was
   taken, and reporting "no change" there would exit successfully on a
   plan the operator never saw.

## 11. Operator surface requirements

The command grammar below is normative in shape; the implementation is a
later slice (§15). It sits under the existing `review-verification`
noun, next to the shipped `resolve`, because both are the operator's
verification-correction surface for one task — `resolve` for the
evidence layer, these for the requirement and execution layers.

```
admin review-verification plan    --session-id <id> --issue-number <n> [--json]
admin review-verification amend   --session-id <id> --issue-number <n>
                                  (--replace <commandId> --command <bytes>
                                   | --add-execution <name> --command <bytes>
                                   | --add-requirement --command <bytes>
                                   | --retire <commandId>
                                   | --restore <commandId>
                                   | --annotate <commandId>)
                                  [--op-reason <text>] ...
                                  --reason <text>
                                  [--continue review|implementation|none]
                                  [--expect-plan-digest <digest>]
                                  [--request-key <token>] [--yes] [--json]
admin review-verification refresh --session-id <id> --issue-number <n>
                                  --reason <text> [--allow-retire]
                                  [--expect-issue-digest <digest>]
                                  [--expect-plan-digest <digest>]
                                  [--request-key <token>] [--yes] [--json]
```

The shipped surface (issue #1042) spells this grammar as the resource it
addresses — one task's verification plan — and adds one command the
shape above implies but does not name:

| §11 grammar | Shipped command |
| --- | --- |
| `review-verification plan` | `admin task-verification show` |
| `review-verification amend` | `admin task-verification amend` |
| `review-verification refresh` | `admin task-verification refresh-from-issue`, and the shipped `admin review-verification refresh` (issue #1041) unchanged — one implementation, two spellings |
| — | `admin task-verification reset` |

`reset` is neither a new mechanism nor a deletion. It derives the §5.2
operations that return the plan to its unamended baseline — `restore`
for a retired slot, `replace` back to its origin bytes for a replaced
one, `retire` for a slot a task-local `add` created — and applies them
as one ordinary revision under every rule below, because the chain is
append-only and a reversal is a revision (§5.3 rule 6). Retiring a
task-local addition removes a check the task currently runs, so it is
withheld without the same explicit opt-in §10 rule 4 requires. Every
rule below binds to all of these spellings without exception.

1. **Preview by default; `--yes` applies.** `plan` is read-only.
   `amend` and `refresh` print the current plan, the proposed
   operations, the resulting plan, both digests, and the continuation
   they would take, and change nothing without `--yes`. This is the
   established posture of `admin task reconcile-merged` and
   `admin chain sync`, reused rather than re-argued.
2. **Unknown and abbreviated mutation flags fail closed.** The
   "Unknown options are hard errors" bar of `docs/admin-cli-contract.md`
   applies without exception: unknown flags exit non-zero naming the
   offending flag, and boolean flags are recognized only by their exact
   spelling. There is no prefix matching and no abbreviation — `--ye`,
   `--allow-retir`, `--reaso`, `--op-reaso`, `--restor`,
   `--expect-plan-diges`, and `--request-ke` each exit non-zero and
   mutate nothing. These commands must go through the
   shared `tokenizeArgs`/`parseCommonOptions` mechanism, never a
   hand-rolled argv scan, precisely so this guarantee is inherited
   rather than reimplemented.
3. **`--reason` is mandatory on every applying invocation** and refuses
   when empty or whitespace-only (§5.2 rule 1). It is the
   **revision-level** reason, and it is also the reason of every
   operation in the invocation that does not carry one of its own: a
   multi-operation `amend` with a single `--reason` is a complete,
   conforming invocation, and the surface materializes that text onto
   each operation it applies (§5.2 rule 1). Nothing is inferred — the
   operator wrote the sentence, and it is recorded against each
   operation it covers.

   `--op-reason <text>` is the **operation-level** override and is
   repeatable. Each occurrence binds to the operation flag it
   immediately follows — the one open operation clause — and applies to
   that operation alone; a later `--op-reason` never retroactively
   changes an earlier operation, and the revision-level `--reason` never
   overwrites an operation that carries its own. An `--op-reason` that
   precedes every operation flag, follows an already-reasoned operation
   clause, or carries empty or whitespace-only text exits non-zero and
   mutates nothing (rule 2's fail-closed bar). `--expect-plan-digest`
   is optional and, when supplied, is a hard guard (§7.3 rule 3).

   `--request-key <token>` is optional and is the operator's stable
   handle on one invocation (§5.3 rule 2). Omitting it is the normal
   case: the key is then derived from the invocation's own content —
   never from the plan that invocation read — so rerunning an unchanged
   command line after a lost or ambiguous response is recognized as a
   replay and reports the already-stored revision instead of appending a
   second one, whether or not the lost attempt had already changed the
   plan (§5.3 rule 3). Supplying a distinct token is how an operator
   asks for a *deliberate* repeat of the same operations, and it is the
   only way to ask for one. A token that is empty, whitespace-only, or
   outside `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/` exits non-zero and
   mutates nothing.
4. **There is no `--force` and no `--all`.** Nothing overrides the §7.1
   refusals, and no invocation addresses more than one task (§4 rule 1).
5. **Exit codes follow the shared contract.** Usage and validation
   errors, and every operational refusal (§7.1, §7.3, §10 rule 5), exit
   non-zero. A preview, a recognized replay (§5.3 rule 3), and a
   `refresh` that finds nothing to change, exit zero.
6. **Direct database editing is not an operator flow, and is
   detectable.** Every amendment goes through this surface so that the
   revision, the digest, the audit event, and the report are produced in
   one transaction. A hand-edited task row produces none of them, and
   resolution (§6) **recomputes the plan digest from the recorded
   revision chain and refuses to run when it reconciles against neither
   the live inputs nor the recorded session baseline** — the refusal is
   fail-closed, names the mismatch, and never repairs, coerces, or
   overwrites the stored state. The baseline arm is what keeps this rule
   from firing on the legitimate case: a disagreement the recorded
   baseline explains is authorized session drift and is rebased (§6.4
   rules 3 and 5), never refused, so correcting a session default does
   not strand every amended task in the session. The digest this rule
   compares against is the §5.5 checkpoint's, which a rebase is allowed
   to move; a revision's own `planDigest` is append-only history and is
   never what a reconciliation reads.
7. **Redaction applies.** Every human-facing string these commands emit
   goes through the same bounding and sanitization the shipped
   `review-verification resolve` output does; local paths are redacted
   and long text is bounded.
8. **`sessions.json` is never opened for writing** by any of them (§4
   rule 3).

## 12. Audit and reporting

### 12.1 Local audit

- **One task event per applied revision**:
  `verification.amendment.applied`, carrying `revisionId`,
  `revisionOrdinal`, `scope`, `source`, the actor id, the operation
  kinds with their `commandId`s and layers, `basePlanDigest`,
  `planDigest`, the counts of active and retired slots per layer, and
  the continuation taken. `TaskEvent.type` is already a free-form
  string, so this introduces **no new event vocabulary type** and no
  schema change.
- **The event carries no command bytes and no output.** Names,
  identities, digests, and counts only — the #918 §11.3 posture. The
  bytes live in the durable revision record, where the operator surface
  reads them.
- **One task event per rebase**: `verification.amendment.rebased` (§6.4
  rule 5), carrying both `sessionBaselineDigest`s, both `planDigest`s,
  and the §6.4 rule 4 dispositions — the masked and orphaned slots by
  `commandId`, never by command bytes. It records no revision, because a
  rebase is not one. Like the applied event it is a free-form
  `TaskEvent.type` and adds no schema. The event is also where a rebase
  becomes auditable at all: the §5.5 checkpoint it rewrote is mutable and
  keeps no history of its own, so the event is the record of which
  digests were replaced by which.
- **Refusals produce CLI output, not task events.** A refused amendment
  leaves no trace on the task, matching the shipped posture for refused
  operator commands (§7.2 rule 2). **A recognized replay likewise
  appends no event** (§5.3 rule 3): the event belongs to the revision it
  already produced.
- **The revision chain is itself the audit record**, append-only (§5.3
  rule 6): who, when, from where, against which base plan, over which
  session baseline, with which reason, producing which plan.

### 12.2 GitHub-visible reporting

- **One comment per applied revision on a task with a public handoff**,
  posted through the existing outbox and **idempotency-keyed on
  `revisionId`** so a retry never double-posts. The key excludes every
  run identifier, per the established rule.
- **Bounded content**: the revision ordinal, the operation kinds with
  the affected command names, the operator-authored reason, the
  resulting active and retired command names, and the continuation.
  **Never** raw verification output, artifact or worktree paths,
  absolute paths, a session identifier beyond what the shipped comment
  policy already permits, or a #917 refusal detail. Command names are
  operator-authored and safe by construction — the #918 §11.2 argument,
  reused.
- **Every retirement is named explicitly**, together with the statement
  that a retired command is not a passing result (§8.4 rule 1). A
  removal that a reader of the Issue cannot see is exactly the failure
  this contract exists to prevent. **Every restoration is named too**
  (§8.4 rule 5): a check coming back is as reportable as a check going
  away.
- **An amendment must not leave a stale merge gate standing.** When a
  revision applies to a task already parked at the human merge gate and
  routes it nowhere (§9.2's `none`), the task stays actionable while the
  handoff summary published for it still describes the plan the revision
  replaced. That summary is superseded in the same transaction as the
  revision: the reader who merges must not be shown a verification pass
  over a plan that no longer exists. A routing continuation supersedes
  nothing, because re-queuing the task retracts the handoff itself.
- **An execution-layer entry is reported as a recorded plan change and
  never as a check that ran or stopped running.** Review Step 4 executes
  the session's own verification configuration and reads no amendment
  (§13.3), so a public statement may say that session execution is
  unchanged and may not claim that a retired entry "is still run": an
  entry a task-local `add` created under a name the session configuration
  does not hold was never run at all, and crediting it at the merge gate
  is the same failure this section exists to prevent, pointed the other
  way.
- **No label changes.** An amendment adds, removes, and swaps no status
  label; label transitions stay owned by the phase runner and the
  shipped handoff surfaces.
- **A refused amendment posts nothing, and neither does a replay or a
  rebase.** A replay's comment was posted by the revision it repeats
  (§5.3 rule 3), and a rebase changed no operator-owned requirement
  (§6.4 rule 5), so there is nothing for a reader of the Issue to learn
  from either.

## 13. Compatibility

### 13.1 `admin review-verification resolve`

Unchanged. Its argument shape, its `ready_for_human` + `review`
precondition, its active-task refusal, its exit-0/non-zero split, the
one-handoff-per-escalation posture (issue #622), the #622-P1 evidence
clearing, and its output bounding and sanitization all stand. It remains
the **evidence** surface.

One addition is specified for the slice that implements this contract,
and is not a change made here: a `resolve` naming a command that the
effective plan no longer contains — because an amendment replaced or
retired its slot — must refuse, naming the revision, rather than
recording orphan evidence against a slot that is gone.

Whether the plan still contains the command is decided under §13.2's
matching rule, not by a byte comparison: an escalation displays the
bytes the review gated on, and an amendment that only rewraps or
unwraps a slot — `bash -lc '<cmd>'` against `<cmd>` — leaves evidence
for the displayed form admissible for that slot. Refusing it would send
the operator to requeue a review that has nothing to fix.

Requiring the command is not enough on its own: the binding block a
review escalation records names the plan revision and the slot
identities that review resolved, and an amendment applied after it can
leave the command required while the slot beneath it — and the plan
around it — have moved. The same slice therefore verifies the recorded
identity against the effective plan as it now stands, refuses when the
slot moved rather than stamping the escalation's identity, and records
the plan digest and ordinal the evidence is actually taken under. The
reviewed commit is not rebuilt: evidence attests a commit, and no
amendment changes which.

### 13.2 The shipped extractor and matching semantics

`extractIssueVerificationCommands` and `buildIssueVerificationStatus`
are reused verbatim. This contract adds a byte-preserving **identity**
representation (§2) and changes **matching** not at all: equivalence stays
`matchesConfiguredVerificationCommand` — the single core rule shared
with #918 §10.2 — and both surfaces continue to agree about what counts
as a configured verification command.

### 13.3 #918 runner-owned verification

- The amendment layer is one more **operator-owned input** to #918 §5.1
  set resolution. §5.1's non-derivation rule holds unchanged.
- No lane, classification, cycle outcome, stop rule, aggregation rule,
  or continuation row of #918 is added, removed, or reinterpreted.
- `setFingerprint` is computed by #918 over the resolved set, unchanged;
  `planDigest` is a different digest over a different object (§5.4).
- #918 §12.4's rule that the review lane re-executes the
  session-configured set in its own worktree is what makes §9.1's
  return-to-review the correct default, and it is not modified.

### 13.4 Tool Request continuation (#918 §10, #919)

- No Tool Request action, disposition, state, or eligibility rule is
  added. The #918 §12.5 statement of unchanged Tool Request state stands.
- An amendment changes the effective execution set, so E7 fails for any
  bundle produced before it and the resolution falls back to the shipped
  implementation continuation (§8.2). No evidence check is added to
  §10.3 and none is removed.
- #919's authority order, decision table, and parking contract are
  untouched. An amendment is not a gate decision and never resolves,
  parks, or unparks a Tool Request. §9.2 rule 3 is what enforces this
  on the continuation side: a task parked outside `review` takes no
  route, and neither `--continue review` nor `--continue implementation`
  can obtain one.

### 13.5 Session configuration

`session.verification` keeps its shape (`Record<string, string>`), its
ownership, its declaration-order semantics, and its
prefer-separate-commands guidance. No key, block, or flag is added to
the session schema by this contract, and no session file is written by
any surface it defines. The §6.4 session baseline is a **task-side
copy** of what was read: it is stored on the task row, it adds no
session field, and recording or rebasing it never reads-modifies-writes
`sessions.json` (§4 rule 3).

### 13.6 Phase transitions and admission

`nextPhaseAfter` is untouched; `checkReviewAdmission` (#681) keeps
exactly its four checks; the review dispute overrides
(`docs/review-dispute-contract.md` §7.1) stand. §9's routes use shipped
vocabulary only.

## 14. Invariants

1. The layer, operation, actor-kind, slot-state, mutation-scope, and
   continuation sets are closed (§2, §3, §5.2, §9.2); widening any of
   them is a change to this document first.
2. Requirements and evidence are different things: an amendment never
   becomes evidence, evidence never becomes a requirement, and no
   amendment path writes a `passed` status (§3.2, §6.2 rule 4).
3. Agents may propose verification and may never author, amend, retire,
   reorder, or skip it; the actor of every revision is an operator
   (§3.3).
4. A task-scoped amendment overlays its origin and never rewrites it:
   `sessions.json` is never written, and `context.body` is never
   rewritten (§4 rule 3, §10 rule 1).
5. `commandId` identifies a slot, not bytes, so a correction preserves
   lineage; identity is derived once, is thereafter immutable, and is
   byte-preserving — no surface rewrites, collapses, or otherwise
   alters shell-significant command bytes, and what is stored, digested,
   reported, and executed is what the operator authored (§2, §5.1,
   §5.4).
6. A revision is atomic, append-only, reason-carrying, and derived-id
   idempotent over a fixed operation serialization whose identity form
   omits every reason; partial application and silent repeats are both
   impossible (§5.2, §5.3). Its operations compose sequentially against
   the state their predecessors in the same revision produced, so a
   composition every step of which is admissible applies in its recorded
   order — `replace` then `retire` of one slot included — and any
   operation that refuses refuses the whole revision (§5.3 rule 7).
   Every amendment is reversible: a retirement by `restore`, anything
   else by a further revision (§5.2 rule 4, §5.3 rule 6).
7. `planDigest` is a function of the plan alone and is distinct from
   #918's `setFingerprint`; neither is derived from the other (§5.4).
8. Amendment is refused on `claimed` and `running` tasks with no
   override, and on terminal tasks with a distinguishable message; the
   guard is a CAS plus the in-transaction status re-check, and no new
   lock exists (§7).
9. No amendment deletes evidence: invalidation marks inadmissibility and
   names its revision, and the record is preserved (§8.1, §8.3). The
   mark is **per slot** — it names the `commandId` it invalidates as
   well as the `revisionId` — so an entry that satisfied more than one
   requirement slot stays admissible for every slot the amendment did
   not touch (§8.3 rules 1–3).
10. Removing a command is never verification success: a retired slot is
    reported `retired`, is excluded rather than credited, and an empty
    requirement set after retirement never reads as a pass (§8.4).
11. The default continuation after an amendment is recompute and return
    to review, never implementation; the override is explicit and
    recorded, is bounded by the §9.2 table so no continuation re-queues
    a task the table keeps parked, and every route uses shipped
    vocabulary (§9).
12. Refresh-from-Issue updates verification requirements and nothing
    else, is operator-invoked and preview-by-default, never emits
    `replace`, never applies a retirement implicitly, and fails closed
    on ambiguity or provider error (§10).
13. Unknown or abbreviated mutation flags fail closed, `--reason` is
    mandatory, no `--force` exists, and a hand-edited chain that neither
    the live inputs nor the recorded session baseline explains produces
    a plan that resolution refuses rather than repairs (§11).
14. Every applied revision produces exactly one task event and at most
    one idempotency-keyed public comment; both carry names, identities,
    digests, and counts — never command output, paths, or refusal
    details. A refusal, a replay, and a rebase each produce no comment,
    and only a rebase produces an event of its own (§12).
15. This contract adds no `TaskStatus`, `TaskPhase`, `PhaseRunOutcome`,
    `PhaseHandlerResult`, store method, table, column, session field,
    lock, backend, operation class, or Tool Request state, and changes
    no #681/#697/#915/#916/#917/#918/#919 policy (§13).
16. Retry identity is caller-stable: the idempotency key is
    `requestKey`, derived from what the operator typed and never from
    the write-time `revisionOrdinal` or from `basePlanDigest`, and the
    chain is looked up on it before any plan comparison, so a repeated
    invocation is recognized as a replay that writes nothing, consumes
    no ordinal, appends no event, posts nothing, and exits zero — even
    when its own first attempt already changed the plan (§5.3 rules
    1–3).
17. Session-default drift is attributable, not corruption: the recorded
    session baseline separates an authorized `session.verification`
    change — which rebases and proceeds on the live plan, preserving
    every recorded operation — from a hand-edited task row, which alone
    fails closed (§5.5, §6.4, §11 rule 6). Drift is classified on the
    recorded baseline and not on the plan digest, so a session change
    the effective plan does not show — a key masked by a task-local
    `add` above all — still re-anchors the checkpoint and is still
    reported (§6.4 rules 3 and 5). The baseline is never a
    source of executable bytes: a slot whose session key was removed is
    orphaned and its recorded operations go inert, never resurrected
    from the baseline (§6.1 step 2, §6.4 rule 4).
18. The refresh matches a live command against active effective command
    bytes before it uses identity, so a requirement the plan already
    carries after a `replace` is neither duplicated by an `add` nor
    proposed for retirement (§10 rule 3).
19. Stored state separates an append-only revision chain from one mutable
    plan checkpoint: a rebase re-anchors the checkpoint and rewrites no
    revision, and every reconciliation compares against the checkpoint's
    `planDigest` and never against a revision's (§5.5, §6.4 rules 3 and
    5, §11 rule 6).
20. One `commandId` is never two slots: a `session.verification` key that
    arrives on top of an existing task-local `add` is masked rather than
    materialized, so resolution neither duplicates the identity nor
    refuses over it, and the authoring-time collision check binds only
    the plan it was authored over (§5.1, §6.1 step 1, §6.4 rule 4).

## 15. Implementation decomposition proposal

Proposed slices for later issues; the tracker, not this document,
assigns numbers.

| Slice | Content | Depends on | Recorded behavioral change |
| --- | --- | --- | --- |
| A1 | Pure core: command-byte handling and the identity form, `commandId` derivation, operation parsing and canonical serialization (§5.2), effective-plan resolution (§6), `planDigest`, revision validation, request-key and `revisionId` derivation (§5.3 rules 1–3), the three-way digest reconciliation and its §6.4 rule 4 dispositions. No store, no CLI | — | none (new module) |
| A2 | Persistence and the atomic write: the append-only chain on the task row, the mutable §5.5 plan checkpoint carrying the recorded session baseline, CAS plus in-transaction §7.1 status re-check, replay recognition, the `verification.amendment.applied` and `verification.amendment.rebased` events | A1 | none (additive state) |
| A3 | Consumption: review Step 4.5 and the verification set resolve through A1 instead of reading the raw inputs; retired slots reported `retired` | A1, A2 | Amended plans take effect; the `retired` state becomes reportable |
| A4 | The operator surface: `plan`, `amend`, preview/`--yes`, mandatory `--reason`, the §7 refusals, `--expect-plan-digest`, §11 rule 2 flag discipline, redaction, `--json` | A2, A3 | New operator commands |
| A5 | Continuation wiring: the §9.2 table, the `{queued, review}` default, the explicit override | A4 | The post-amendment re-queue |
| A6 | `refresh` (§10): live read, diff, `add`/proposed-`retire` only, `--allow-retire`, `issueBodyDigest`, fail-closed provider handling | A4 | New operator command |
| A7 | Reporting: the §12.2 public comment on the existing outbox, keyed on `revisionId`; the §13.1 `resolve` refusal for orphaned commands | A5 | `resolve` gains one refusal |

## 16. Test seams and matrix

For the implementation slices; the docs pin at the end is the only test
landing with #1037 itself.

| Area | Cases |
| --- | --- |
| Identity (§5.1) | the identity form trims the ends and alters nothing else — `printf 'a  b'` and `printf 'a b'` take two slots; the stored, digested, reported, and executed command is byte-identical to the operator's input through an `add` and a `replace`; `req:` id stable across a `replace`; two byte-identical source commands collapse to one slot; an execution `add` name violating the character rule refuses; a colliding `add` refuses |
| Operation schema (§5.2) | each variant's exact field set round-trips; a requirement-layer `add` carries no `name`; an unrecognized `kind` or `layer`, a missing required field, and an unexpected extra field each refuse the revision; canonical JSON is key-sorted with absent fields omitted, never `null`; the identity form omits every operation `reason` and nothing else, so two invocations differing only in wording derive the same `revisionId` |
| Retire/restore (§5.2 rule 4) | `restore` returns a retired slot to `active` at its original position with its original bytes; `restore` of an active slot refuses; `add` colliding with a retired slot refuses and points at `restore`; `restore` then `replace` in one revision corrects a retired slot's bytes; a retirement followed by a restoration leaves the plan digest equal to the pre-retirement digest |
| Revision (§5.3) | `revisionId` derivation excludes reason/actor/timestamp/continuation **and `revisionOrdinal`**, and repeats identically on replay; the derived `requestKey` excludes `basePlanDigest` and includes the typed `--continue` value, so a plan-changing `amend` whose `--yes` commits but whose response is lost replays on an unchanged rerun that reads the *amended* plan — the chain is matched on `requestKey` before the stale check, nothing is applied twice, and the surface reports the stored revision and exits zero; a retried `annotate` — which moves neither plan nor digest — is likewise a replay that writes nothing, appends no event, and posts nothing; a distinct `--request-key` over the same operations is a new revision against whatever plan it reads; a `--request-key` outside the character rule refuses; atomicity — a revision with one invalid operation applies none; append-only — a reversal is a new revision; a no-op `replace` refuses; sequential composition — `replace S` then `retire S` in one revision **applies**, leaving one slot with the replaced bytes in state `retired` and a digest that carries both, while `retire S` then `replace S` refuses the whole revision, as do `retire S` twice, `restore S` twice, a second `add` of a `commandId` an earlier `add` in the same revision created, and a `replace` whose bytes equal what an earlier operation in the same revision left on the slot |
| Digest (§5.4) | `planDigest` is order-sensitive and state-sensitive; two different revision paths to the same plan produce the same digest; the digest is unaffected by reasons, actors, and timestamps; it is not equal to and not derived from `setFingerprint` |
| Checkpoint (§5.5) | applying a revision appends the chain entry and replaces the checkpoint in one write, with `appliedThroughOrdinal` equal to the new `revisionOrdinal` and `updatedBy: "revision"`; a rebase moves `planDigest`, `sessionBaseline`, and `sessionBaselineDigest`, sets `updatedBy: "rebase"`, leaves `appliedThroughOrdinal` alone, and leaves every revision record byte-identical — in particular the newest revision's `planDigest` still equals the plan that revision produced, not the rebased one; reconciliation reads the checkpoint's digest, so a task whose newest revision predates two session edits still classifies `consistent` after each rebase; a task with no revision has no checkpoint and resolves without reconciling; a chain with revisions and no checkpoint, and a checkpoint whose `appliedThroughOrdinal` differs from the chain's highest ordinal, each fail closed unrepaired |
| Drift (§6.4) | a session-default edit after an amendment classifies `drifted`, resolves on the live plan, and is **not** refused; the rebase updates both stored digests, appends one `verification.amendment.rebased` event, consumes no ordinal, and posts nothing; a hand-edited chain that the baseline replay cannot reproduce classifies `unreconciled` and refuses; a session edit that leaves the effective plan byte-identical — a key arriving under an execution-layer `add`, and a change to a session entry a `replace` masks — still classifies `drifted`, still rebases, and still reports and events its dispositions, with the two `planDigest`s equal and the two `sessionBaselineDigest`s different, and it classifies `consistent` only on the *next* resolve, after the re-anchor; a `replace`d slot masks a changed session entry and the mask is reported; a removed session key orphans the slot **even when a revision `replace`d it**, and the slot is never resurrected from the recorded baseline, while an execution-layer `add` slot is unaffected; the orphaned slot's operations stay in the chain, go inert, and replay onto the slot — bytes and retired-or-restored state intact — when the key returns; a read-only `plan` reports drift and writes nothing; a revision authored before the drift refuses as stale, naming it |
| Resolution (§6) | overlay never mutates `session.verification` or `context.body`; per-slot last-write-wins across revisions; `add` append ordering across revisions; retired slots excluded from execution and retained in the plan; an operation whose target slot is absent from the set is inert and refuses nothing; an operation naming a pinned entry refuses; empty inputs resolve to an empty plan with a digest; a task-local `add` resolves as `"verification.run"`; a `session.verification` key added after a task-local `add` of the same name yields **one** `exec:<name>` slot carrying the amended bytes at its append position — never two slots, never a refusal — the session entry is reported masked, retiring the task-local slot does not unmask it, and adopting the session bytes takes a `replace`; the recorded `add` is not retroactively refused by the arriving key |
| States (§7) | every row of the §7.1 table, including all three terminal refusals with a message distinct from the active-task one; no flag overrides a refusal; a refused amendment consumes no ordinal and appends no event; concurrent amendment — one commits, the other refuses stale naming both digests; `--expect-plan-digest` mismatch refuses even when the CAS would pass |
| Evidence (§8) | an execution amendment invalidates a prior bundle through #918 §8.2 rule 3 and deletes nothing; a requirement `replace` marks matching manual evidence superseded, preserves it, and leaves it matchable for other slots — the mark is one `EvidenceSlotInvalidation` naming the replaced slot's `commandId` and the `revisionId`, so an entry that satisfied two slots stays admissible for the untouched one and is inadmissible only for the replaced one; a second `replace` of the same slot adds no second record for that entry and rewrites neither the first record nor its `revisionId`; a `restore` clears no record; `add`/`retire`/`restore`/`annotate` invalidate nothing; a restored slot is reported `active`, and preserved evidence that matched its unchanged bytes before the retirement satisfies it again without a rerun while evidence that never matched it still leaves it unsatisfied; a retired slot is reported `retired`, never `passed`; retiring the last requirement does not read as a pass; the #622-P1 clearing behavior is unchanged |
| Continuation (§9) | every row of the §9.2 table; recompute-then-route ordering (a claim never sees a re-queued task with a stale plan); explicit `implementation` and `none`; an unrecognized continuation value fails closed; an explicit `review` **or** `implementation` on a `none`-default row refuses, so no continuation unparks a task the table keeps parked; admission unchanged on the receiving side |
| Refresh (§10) | only requirement-layer operations are produced; `context.body`, labels, title, phase, and scope fields are untouched; no `replace` is ever emitted; after an operator replaces requirement A with B, a live Issue naming B matches the active slot by its effective bytes and produces **no operation** — neither an `add` of B nor a proposed retirement of the slot that already carries it; matching is one-to-one, so a duplicated live command does not consume two slots; a live command matching a retired slot's bytes or its identity becomes a `restore`, not an `add`, and applies without `--allow-retire`; a restoration whose reinstated bytes differ from the live text is reported and still emits no `replace`; a plan-only command is a proposed retirement withheld without the opt-in and still reported; provider error, missing Issue, and unparseable body each refuse whole and consume no ordinal; `issueBodyDigest` recorded; a no-difference refresh is a no-op |
| Surface (§11) | preview by default and `--yes` to apply; unknown and abbreviated flags exit non-zero and mutate nothing, on every subcommand; empty `--reason` refuses; a multi-operation `amend` with a single `--reason` applies and records that reason on every operation; a repeated `--op-reason` binds to the operation flag it follows and overrides the revision reason for that operation alone; a leading, doubled, or empty `--op-reason` refuses; no `--force`/`--all` exists; refusal exit codes; a no-change preview exits zero; a recognized replay exits zero; output redaction; `sessions.json` untouched by an amendment, a baseline record, and a rebase alike; a hand-edited chain whose digest reconciles against neither the live inputs nor the baseline refuses without repairing, while one the baseline explains does not refuse |
| Reporting (§12) | one event per applied revision with no command bytes; no event on refusal or on a replay; one rebase event carrying digests and dispositions but no revision; one comment keyed on `revisionId` with no run identifier in the key; retirements named with the not-a-pass statement; no label change; nothing posted on a refusal, a replay, or a rebase |
| Docs pin | `test/docs-verification-amendment-contract.test.js` pins this document's status line and no-runtime-behavior claim, the deferrals to the fixed predecessor contracts, the closed layer/operation/actor/state/scope/continuation sets, the four-layer ownership table and the precedence order, the agents-may-propose-never-amend rules, the task-only mutation scope and the no-`sessions.json`-write rule, the byte-preserving command and identity definitions, the stable `commandId` derivation, the operation table with its mandatory reason, the retire-is-not-deletion and retire-is-reversible-by-`restore` rules, and the serialized operation schema with its canonical encoding and reason-free identity form, the revision record with its caller-stable request-key idempotency — independent of both `revisionOrdinal` and `basePlanDigest` — its lookup-before-comparison replay rule, and its atomicity, the plan digest and its distinction from `setFingerprint`, the split between the append-only chain and the mutable plan checkpoint that a rebase alone moves, the resolution algorithm including the pinned-entry refusal and the masking of a session key that collides with a task-local `add`, the session baseline with its three-way reconciliation and its rebase-not-refuse rule, the §7.1 state table with the unconditional active-task refusal and the CAS-plus-no-new-lock concurrency rule, the preservation-first evidence rules and the removal-is-never-success rules, the §9.2 continuation table with its review default and no-new-vocabulary rule, the refresh rules, the operator-surface requirements including the fail-closed flag bar and the detectable-hand-edit rule, the audit and public-reporting bounds, the compatibility statements, the invariants, and the decomposition — against drift. |

## 17. Non-goals and forward pointers

This document defines task-scoped, operator-owned verification amendment
only. It does not define, and nothing implementing it should assume:

- **Session-default management.** Editing `session.verification` through
  a supported operator surface — validation, preview, per-session
  history, and the migration of repeated task-scoped amendments into a
  session default — is a separate future contract. This document fixes
  the boundary: task-scoped amendment is the *emergency, task-local*
  correction (§4 rule 4), and repeated identical amendments are the
  signal that a session default is wrong (§4 rule 5). A session-scope
  mutation is unimplementable under this contract as written; it is a
  change to this document first. The §6.4 rebase is not that surface
  either: it observes a session change that has already happened through
  whatever surface made it, and re-anchors one task's record to it. It
  can neither make a session change nor propose one.
- **Session-wide, chain-wide, or label-selected bulk amendment.** No
  invocation addresses more than one task (§11 rule 4).
- **Reordering the verification set.** No `reorder` operation exists
  (§5.2 rule 5); order stays #918 §5.1's as extended by §6.1. A
  `restore` returns a slot to its original position and is therefore not
  a reordering (§6.1 step 2).
- **Amending a #915 plan-approval entry.** Pinned entries are
  approval-governed; correcting one is approval renewal (§6.1 rule 4).
- **Amending anything that is not verification.** The task goal,
  implementation scope, acceptance criteria, labels, assignment,
  priority, dependencies, and the Issue body are all out of scope, and
  §10 rule 1 is the specific promise about the refresh path.
- **Rewriting an Issue body.** `docs/issue-refinement-contract.md` owns
  that; this contract never writes one.
- **A ChatOps verb.** `source: "chatops"` is reserved in the schema so a
  later mapping does not require a schema change, but no verb, grammar,
  authorization rule, or dispatch row is defined here — those belong to
  the ChatOps contracts.
- **A UI surface.** `admin ui` entries, if any, are a later slice and add
  no capability beyond §11's commands.
- **Automatic amendment.** Nothing in the loop proposes, applies, or
  schedules a revision: not intake, not a phase handler, not a scheduled
  job, not an agent. Every revision is an operator act.
- **A different evidence model.** Evidence stays #918's: runner-produced
  bundles and operator-attested manual entries, bound to identities.
  This contract adds no evidence source and no way to attest one.
- **Deciding when, and how much of, the effective plan runs.** §6
  resolves *what the plan is*; it never schedules execution and never
  runs a subset.
  **Delivered (#1094)**: `docs/staged-verification-contract.md` — the
  staged verification lifecycle and ownership contract: it consumes
  `EffectiveVerificationPlan`, its `commandId` slot identities, its
  `planDigest`, and `buildEffectiveRequirementStatus` verbatim as the
  required set, and adds a `loop` stage that may run a subset and a
  `final` stage that runs all of it per Issue before the stack-ready
  grant. It introduces no layer, origin, slot state, or revision
  operation; a stage never amends, and its regression set is runner
  state rather than a plan revision. Requirement-layer slots and
  amendment-added slots are explicitly never narrowable, so a
  task-scoped correction made through §11's commands can never be
  selected away. Because a subset run makes "the plan is configured to
  run this" and "this run proved it" two different facts, #1094 §4.2
  step 5 also keeps the execution checks that discharge a requirement
  slot in every selection, and #1094 §4.3 evaluates a *stage's*
  requirement verdicts by calling `buildEffectiveRequirementStatus`
  unchanged over a plan whose execution layer is narrowed to the checks
  that run proved green. The function, its matching rule, and its answer
  for every shipped plan-level caller — §11's `show`, §12's audit and
  reporting surface — are untouched.
  **Delivered (#1095)**: `docs/project-verification-contract.md` — the
  project verification configuration and adapter contract, which adds a
  repository-owned configuration file and two optional project adapters
  **without adding a fifth layer**. §3's four layers and §3.2's
  precedence are untouched: the project file is not a value in the plan,
  never overlays a slot, and answers only "which of the already-required
  checks does this loop run?". Its whole vocabulary is an
  always-required pin and a result-adapter id, so it can neither author
  a command nor reduce what must pass, and a pin creates no revision and
  survives into no other task. A task-amendment-added slot stays
  unselectable there as it is here, and the structured results a project
  adapter may report are inert metadata that never become evidence,
  never become a requirement, and never reach `buildEffectiveRequirementStatus`.
  **Delivered (#1096)**: `docs/verification-evidence-validity-contract.md`
  — the verification evidence validity, pinned regressions and recovery
  contract, which binds a stage evidence bundle to a closed
  seven-component identity and gives the staged pins a lifecycle. It
  consumes four of this document's mechanisms **verbatim and relies on
  them**, and redefines none. §5.4's `planDigest` and §5.3's
  `appliedThroughOrdinal` are two of its components. §6.4's
  `sessionBaselineDigest` is a third, and it exists *because* §6.4 rule 3
  proves that a **plan-neutral drift** leaves the plan digest
  byte-identical: without the baseline in the tuple, an authorized
  session edit would be invisible to every evidence comparison. That
  component reads the **live** `session.verification` layer under §6.4
  rule 1's digest rule and compares it to the checkpoint's stored
  digest, because rule 5 re-anchors the checkpoint only at the next
  writing surface — a divergence between the two is §6.4 rule 3's
  `drifted`, which #1096 records as an unattestable identity and leaves
  entirely to rule 5's rebase. §7.1's
  unconditional `claimed`/`running` refusal is the primary in-flight
  guard for an amendment landing under a stage run, relied upon rather
  than duplicated — the residual race is an unrefused `sessions.json`
  edit, which the end-of-run identity re-check catches as an `unknown`
  stage run whose bundle is inadmissible, after which §6.4 rule 5's
  rebase proceeds unchanged. §8.1's preservation rule is adopted for
  stage evidence: an identity mismatch means "no longer admissible for a
  reuse or a grant", never "deleted", and a retained bundle can still
  arm a pin while never releasing one. Three boundaries are explicit: a
  **pin is runner state, not a plan layer** — arming, dormancy and
  release create no revision, consume no `revisionOrdinal`, change no
  slot state and post no §12.2 comment; a **stage identity is never
  folded into `evaluateVerificationEvidenceBinding`**, which keeps its
  four binding fields and its closed rejection set for operator-attested
  evidence; and §8.5's `review-verification resolve` evidence clearing
  is **not** a pin release. Its §8.4 "removal is never success" posture
  is restated for pins: a released pin is reported released, never
  passed.
