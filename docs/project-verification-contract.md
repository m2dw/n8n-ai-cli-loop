# Project verification configuration and adapter contract

Status: **RETIRED design record — superseded by
`docs/changed-file-verification-contract.md` (#1158) and removed from
the implementation by #1155** (issues #1095, #1097, #1098, #1155).
Nothing below is implemented any more: issue #1155 deleted the
`.ai-cli-loop/verification.json` project file and its reader, the
selection adapter and its transport, the result adapter and the
structured result envelope, and the `selectable` / `finalOnly` /
`selectionAdapter` / `selectionTimeoutMs` / `resultAdapters` /
`resultTimeoutMs` session fields, together with the group-selection
policy they served. A stage now runs the **entire required set**, and the
test suite is run by the changed-file stages. This document is kept as
the design record of the retired policy — and of the authorization
boundary it established, which the replacement keeps — not as a
description of shipped behavior. This
document is the authoritative contract for the **project-owned** half of
staged verification: where a project's verification configuration lives,
what it may and may not say, how a project may supply a **selection
adapter** and a **result adapter**, what a check's stable identity,
execution metadata, stage membership, result class and duration are, and
what an optional structured result — including its explicit unknown and
partial states — may claim. It fixes the authorization boundary between
operator-owned configuration and repository-owned configuration, so that
routine per-Issue operation never edits `sessions.json` and never
silently grants a new command permission. Follow-up implementation
issues reference this specification and MUST NOT redefine its policy; a
change of policy is a change to this document first.

**Superseded for selection (#1158).**
`docs/changed-file-verification-contract.md` retires the project
verification file, stage membership, and the selection and result
adapters described here as selection policy. Its implementation Issues
replace them with one test adapter. This document keeps no authority
over test selection, stage results or retention. It remains the record
of what shipped. A rule here binds the replacement only where that
contract's §8 restates it, as it does for operator authorization of
commands.

This is slice 2/15 of the independent **Staged Verification** chain: 3
design Issues followed by 12 implementation/validation Issues. Execution
order is represented by GitHub Blocked by relationships and the chain
registry, not by prose here. The chain has no dependency on another
active chain. Issue #1095 delivers this document, the reconciliation
notes in the documents it touches, and its structural contract tests
only: **no runtime behavior ships with it.**

It builds on `docs/staged-verification-contract.md` (#1094), which fixes
the lifecycle this document plugs into. Everything #1094 decided is
consumed **verbatim** here: the two stages, the closed stage-outcome
vocabulary, the five-set loop-selection union, the evidence bundle and
its completeness rule, the mandatory retention, the 13-row transition
table, and the publication ordering. This document adds no stage, no
outcome, no verdict, no transition row, and no grant path. Where it
appears to extend #1094, it extends exactly one thing: the **inputs**
#1094 already named — the `selectable` list it consumes in §4.2 step 2,
the selection port it declared in §5.1, and the per-check record shape
it declared in §6.2.

Availability of everything described here is tracked in the
[Staged verification](feature-status.md#staged-verification-loop-and-final-stages)
row of `docs/feature-status.md`.

It does **not** specify, and no implementation built against it may
assume:

- **The stage lifecycle itself** — stages, selection floors, outcomes,
  evidence admissibility, retention, transitions and publication are
  fixed by `docs/staged-verification-contract.md` (#1094). This document
  never widens a floor, never adds an outcome, and never creates a path
  to the stack-ready grant.
- **Verification ownership, non-derivation, and session
  configuration** — fixed by `docs/environment-prepare-contract.md`
  §3.1–§3.3. `session.verification` stays operator-authored, never
  derived from Issue text or agent output, never modifiable, skippable,
  or reorderable by an agent. A project file selects *among* authorized
  checks and describes their results; it never authors a command.
- **The effective verification plan, its layers, precedence, stable
  command identity, plan digest, revision model and evidence
  invalidation** — fixed by `docs/verification-amendment-contract.md`
  (#1037) and shipped in `src/core/verification-plan.ts`,
  `src/core/verification-amendment.ts` and
  `src/core/verification-evidence.ts`. The project file is **not** a
  fifth plan layer and never enters §3.2's precedence (§3.5).
- **Runner-owned execution, per-command classification, cycle
  aggregation and lane continuation** — fixed by
  `docs/verification-execution-contract.md` (#918), design-only today.
  A result adapter never classifies, never re-runs, and never reaches
  the classifier.
- **The ExecutionBackend, the preflight Execution Plan, the grant tiers
  and the platform/sandbox attestation** — fixed by #917, #915, #697
  and #916. Adapter invocation introduces no operation class, no
  refusal reason, no tier and no new authority (§8.5).
- **Evidence artifact layout, event payloads, CLI output shapes and
  audit reporting** — the chain's third design Issue owns them (§15).
  This document fixes the *shape and admissibility* of a structured
  result, not where it is written or how it is displayed.

## 1. Why this contract — the gap it closes

#1094 fixed the lifecycle and deliberately left one seam open: it
declared a selection port and then said, in its own §15, that "how an
adapter is discovered, packaged, invoked, versioned, and validated"
belongs to a later design Issue. Four concrete gaps follow from that,
and each of them is a way an implementation could go wrong.

- **There is nowhere for a project to say anything.** #1094 §5.3 gives
  the operator three session fields and nothing else. A project that
  wants a check pinned as always-required, or wants its test output
  parsed into failing ids, has no place to record it. The only place
  that exists today is `sessions.json` — which is exactly the file
  #1094 §5.4 promises routine per-Issue operation never touches, and
  which no Issue branch can carry, review, or roll back with its code.
- **Any configuration file inside the repository is agent-writable.**
  The repository is the one surface the implementation agent edits. A
  project file that could name a command, a path, an environment
  variable or a budget would be a way for agent-authored bytes to
  execute with the runner's authority, or to weaken verification below
  what the operator configured. Choosing a location without fixing what
  it may contain would hand back the authorization property #1094 §5.2
  rule 3 established.
- **"It failed" is coarser than it needs to be, and "it passed" can be
  a lie nobody can see.** A check is one command; its evidence today is
  an exit code and a bounded output tail. A project that *can* say
  which cases failed should be able to, so the fix loop gets the failing
  set rather than a log tail. But letting a project's parser speak at all
  raises the question this contract must answer precisely: what happens
  when the parser disagrees with the exit code, is truncated, is
  unparsable, or is simply absent.
- **Selection granularity is an unowned question.** #1094's unit of
  selection is a check, and a check is a whole command. Without a
  written rule, an implementation could reasonably "help" by rewriting
  `npm test` into `npm test -- <pattern>` from adapter output — which
  would mean an out-of-core adapter had authored the bytes the runner
  executes. That is the single most likely way this feature breaks its
  own authorization boundary, and it has to be forbidden in writing
  (§9.3).

This contract closes all four: one repository-owned file whose entire
vocabulary is non-authorizing and monotone toward *more* verification
(§3, §4), a stable identity and metadata model in which the check is the
unit and cases are optional detail (§5, §6), a structured result
envelope whose closed kind set makes unknown and partial explicit and
whose payload is never a verdict (§7), two independently optional
adapters with one transport, one version rule and one fail-closed
wrapper (§8), and a restatement of exactly how the project's answer
enters #1094's selection without moving any floor (§9).

## 2. Terminology

- **Check** — unchanged from #1094 §2: one addressable verification
  obligation identified by the shipped
  `EffectiveVerificationSlot.commandId` (`exec:<name>` or `req:<hex>`).
  Check identity is minted by `src/core/verification-plan.ts` and by
  nothing else. **No project input mints, renames, or aliases a check
  id.**
- **Verification unit** — the granularity at which a stage selects, runs
  and judges. The verification unit is **always the check** (§5.1). An
  opaque command is therefore a complete, first-class verification unit
  with no adapter of any kind.
- **Case** — an optional, project-defined subdivision *inside* a check:
  one test, example, scenario, or assertion group. A case is evidence
  detail and fix input; it is never a check, never selected, never
  retained as a pin, and never granted (§5.2).
- **Case id** — the project's stable identity for a case, opaque to
  core (§5.3).
- **Project verification file** — the repository-owned, version
  controlled configuration at `.ai-cli-loop/verification.json` (§4).
- **Selection adapter** — the project-supplied program that implements
  #1094 §5.1's selection port (§8.1). Optional.
- **Result adapter** — the project-supplied program that turns one
  check's own run artifacts into a structured result envelope (§8.2).
  Optional, and independent of the selection adapter.
- **Structured result envelope** — the bounded, closed-kind payload a
  result adapter returns for one check in one stage run (§7).
- **Stage membership** — the resolved, runner-computed answer to "in
  which stages may this check be omitted?". The set is **closed**:
  `"always"` | `"selectable"` | `"final-only"` (§5.4).
- **Effective selectable set** — the check ids a loop selection is
  permitted to omit as unrelated, after every subtractive rule has been
  applied (§3.4). This is the set #1094 §4.2 step 2 consumes; that step
  is unchanged.
- **Authorizing configuration** — configuration that can cause bytes to
  execute, or can reduce what must pass. Under this contract it lives in
  `sessions.json` and in the shipped task-amendment surface, and nowhere
  else (§3).

## 3. Configuration locations and the authorization boundary

### 3.1 The three locations

| Location | Owner | Reachable by an agent? | May authorize execution? | May reduce what must pass? | Changes per Issue? |
| --- | --- | --- | --- | --- | --- |
| `sessions.json` — `session.verification`, `session.stagedVerification` | Session operator | **No** | **Yes** — it is the only place command bytes are authored | **Yes** — `selectable` and `finalOnly` are the operator's own staging decision | **No** — one-time |
| Task amendment surface — `admin task-verification` (#1042) | Task operator | **No** | **Yes**, within #1037's rules | **Yes**, within #1037's rules | Per Issue, by an operator, deliberately |
| `.ai-cli-loop/verification.json` — the project verification file | Repository (and therefore the implementation agent) | **Yes** | **No** | **No** | Per Issue, with the code, in the PR |

The table is the whole security argument in one row per location: the
two locations an agent cannot reach are the two that can authorize, and
the one an agent can reach can do neither of the dangerous things.

### 3.2 What the session block authorizes

`session.stagedVerification` (#1094 §5.3) is extended **additively** with
the adapter declarations. The three fields #1094 defined keep their
meanings exactly:

```json
{
  "stagedVerification": {
    "enabled": true,
    "selectable": ["test", "e2e"],
    "finalOnly": ["e2e"],
    "selectionTimeoutMs": 30000,
    "selectionAdapter": "node scripts/loop-selection.mjs",
    "resultAdapters": { "jest-v1": "node scripts/loop-jest-result.mjs" },
    "resultTimeoutMs": 30000
  }
}
```

- `enabled`, `selectable`, `selectionTimeoutMs` — #1094 §5.3, unchanged.
- `finalOnly` — the operator's own staging decision: check names a
  selection adapter's `"selected"` proposal may not pull into a loop,
  and which the always-required step never reaches, but which always
  enter the final selection (§5.4). Every #1094 floor still reaches
  them, and so does #1094 §4.2's unknown-impact fallback: a loop whose
  selection answer is unknown runs the entire required set, `finalOnly`
  names included, so this field narrows a loop only where a working
  selection adapter answers it (§9.2). **Every `finalOnly` name must
  also appear in `selectable`**: staging a check out of the loop is a
  statement that the loop may omit it, so the two lists are never
  allowed to disagree, and the effective selectable set (§3.4) stays the
  single place selectability is decided.
- `selectionAdapter` — the command that implements the selection port.
  **Absent means no selection adapter**, which is #1094 §5.2 rule 7's
  safe default: every request reads `"unknown"`, so every loop runs the
  full required set.
- `resultAdapters` — a map from a project-chosen **adapter id** to the
  command that implements it. The id is what the project file may name
  (§4.2); the command is what only the operator may write.
- `resultTimeoutMs` — the result adapter's budget, a positive integer
  with a small bounded default.

Validation stays fail-closed at session load, exactly as #1094 §5.3
requires: unknown fields, non-integer or non-positive budgets,
unresolvable `selectable` or `finalOnly` names, a `finalOnly` name absent
from `selectable`, an empty adapter command, and a duplicate adapter id
all refuse the session. A session written
against #1094's three-field schema still loads unchanged; every field
added here is optional.

### 3.3 What the project file may never contain

The project verification file's vocabulary is closed (§4.2) and the
exclusions are the point of the design. A project file may never carry:

- a command, an argument, a flag, a shell fragment, or an interpreter
  name;
- a filesystem path, a glob, a URL, or an artifact location;
- an environment variable, a secret, a credential, or a token;
- a timeout, a budget, a retry count, a concurrency value, or any other
  resource knob;
- a grant, a tier, a sandbox setting, or any #697/#916/#917 value;
- a verdict, an outcome, a result class, a pass/fail claim, or any
  statement about what happened in a run;
- a check id, a check name that is not already a key of the resolved
  plan, or any attempt to create, rename, retire, or restore a slot;
- a statement that makes a check **selectable**, final-only, or
  otherwise eligible for omission.

Any of them refuses the file (§4.4). The rule that generates the list is
short enough to keep in mind: **the project file may only name things
the operator already authorized, and may only move verification in the
direction of running more of it.**

### 3.4 Selectability is computed by subtraction

The effective selectable set is computed by the runner, from four
subtractive sources, in this order:

1. Start from the operator's `selectable` list, resolved to check ids
   against the current effective plan.
2. Subtract every check the #1094 §5.3 membership rules already exclude:
   a **requirement-layer** slot (`req:<hex>`) and a
   **task-amendment-added** slot are never selectable.
3. Subtract every check the project file pinned with
   `alwaysRequired: true` (§4.2).
4. Subtract every check whose structured result was `conflicting` in this
   task (§7.4) — trust withdrawn for the remainder of the task.

Three properties follow, and all three are testable:

- **Monotone in one direction.** Every source subtracts; no source adds.
  There is no ordering in which a later rule restores selectability an
  earlier rule removed, so the order above is documentation, not
  semantics.
- **Bounded below by the operator.** The effective selectable set is
  always a subset of the operator's `selectable` list, so no project
  file, adapter answer, or runtime event can make the loop run less than
  the operator's own configuration allows.
- **#1094 §4.2 is unchanged.** Its step 2 — "every required-set check
  the operator did **not** list as selectable" — consumes the effective
  selectable set instead of the raw list. The union is still five sets;
  no sixth source exists, and steps 3, 4 and 5 remain floors no rule
  here can reach.

### 3.5 Reconciliation with the four plan layers

`docs/verification-amendment-contract.md` §3 fixes four ownership layers
— `session-default`, `issue-requirement`, `task-amendment`,
`execution-evidence` — and one precedence order over them. **This
contract adds no layer and changes no precedence.** The project file
does not participate in §3.2's precedence at all, because it answers a
different question:

| Question | Who answers it | Where |
| --- | --- | --- |
| What must be checked? | The first three #1037 layers, in their existing precedence | The effective plan |
| What was checked, and how did it come out? | `execution-evidence` — the runner's bundle | #1094 §6.2 |
| Which of the already-required checks does *this* loop run? | The runner, from the effective selectable set (§3.4) and the port's proposal | #1094 §4.2 |
| What extra detail can be said about one check's run? | The result adapter, as inert metadata | §7 |

Two consequences worth stating because an implementation could get them
backwards:

- **A project file entry for a check that is not in the plan is not an
  addition.** It is a refusal (§4.4). The plan is the only source of
  checks, so a project file naming an unknown check is a stale or
  mistaken file, not a request.
- **A project pin is not an amendment.** `alwaysRequired: true` does not
  create a revision, does not appear in the plan, does not change a
  slot's state, and does not survive into any other task. It is an input
  to one selection computation, recorded in the bundle as such.

### 3.6 Routine per-Issue operation touches no authorizing file

#1094 §5.4's promise holds and this contract is what makes it concrete.
For a normal Issue:

- Adding, correcting, or removing a *command* is an operator act, in
  `sessions.json` or through `admin task-verification`. It is not
  routine.
- Pinning a check as always-required for this repository, or mapping a
  check to a result adapter id, is a **repository** act: an edit to a
  version-controlled file, made on the Issue's branch, reviewed in the
  Issue's PR, and reverted by reverting the commit.
- Everything else that varies per Issue — the selection, the bundles,
  the regression set, the loop pin set, the stage ordinals and the
  retention marks — is task-scoped runner state and was never
  configuration.

### 3.7 What "authorization" does and does not mean here

The honest boundary, stated plainly so no implementation over-claims it.

An adapter command named in `sessions.json` frequently points at a
script inside the repository — `node scripts/loop-selection.mjs`. The
operator authorizes *that command*; the repository supplies the bytes it
runs. This is the same trust level the project already operates at:
`npm test` runs repository code, and has since before this chain
existed. The property preserved here is therefore not "adapters cannot
run repository code" — they can, as tests do — but the narrower and
still meaningful:

1. **No new authority.** An adapter runs with the authority verification
   commands already run with, under the same #916/#917 posture, in the
   same worktree, for a bounded time. It gains no grant, no tier, no
   network permission and no filesystem reach that the check itself
   lacks.
2. **No new command class.** The set of commands that can execute is
   still exactly the set an operator wrote in `sessions.json`. The
   project file can select among them by id; it can never introduce one,
   and the runner never synthesizes one (§9.3).
3. **No weakening.** Nothing an adapter returns, and nothing the project
   file says, can reduce the required set, reduce the final selection,
   remove a floor, or grant stack-ready. The worst an adversarial
   adapter achieves is that more verification runs than necessary, or
   that its structured detail is discarded.

## 4. The project verification file

### 4.1 Location and discovery

The file is `.ai-cli-loop/verification.json`, relative to the **root of
the worktree being verified**.

- **Exactly one location.** No search upward, no search downward, no
  per-directory files, no merge of several files, no environment
  variable override, no CLI flag, and no alternative extension.
  Discovery that can be influenced at run time is a way to smuggle
  configuration past review; a single fixed path cannot be.
- **Absence is normal and silent.** No file means no project pins and
  no result adapters: the operator's configuration stands alone, and
  behavior is exactly #1094 with no project input. Absence is never an
  error, never a warning on a public surface, and never a refusal.
- **No framework detection.** The runner never inspects the repository
  to guess a language, a package manager, a test framework, or a
  suitable adapter. #1094 §3.3 forbids it, and this contract adds no
  exception: an unconfigured project gets opaque commands, which are a
  complete verification unit.
- **Read from the head being verified.** The file is read from the
  worktree as it exists for the stage run, so a branch that adds a pin
  gets the pin on the same cycle that adds it. Its content digest is
  recorded in the bundle (§6.1), which is what makes a mid-Issue change
  visible to an operator rather than silent.

The consequence of reading the branch's own file is worth stating
directly, because it is the one place an agent edit changes behavior: an
agent that deletes a pin moves the check from always-required back to
**whatever the operator's `selectable` list already allowed** — never
below it (§3.4), never out of the required set, and never out of the
final stage, which is total by #1094 §4.3 regardless of any project
input. The blast radius of the worst project-file edit is therefore one
loop cycle running less than it might have, on a check the operator had
already marked omissible, with the final stage unchanged.

### 4.2 Schema (version 1)

```json
{
  "version": 1,
  "checks": {
    "typecheck": { "alwaysRequired": true },
    "test": { "alwaysRequired": false, "result": "jest-v1" }
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer, must be `1` | The file's schema version. A version this runner does not know refuses the file (§4.4) |
| `checks` | object, optional | Keys are `session.verification` **names** — never check ids, never command bytes |
| `checks.<name>.alwaysRequired` | boolean, optional | `true` pins the check out of the effective selectable set (§3.4 step 3). `false` means "no project pin" and **never grants selectability** |
| `checks.<name>.result` | string, optional | An adapter id that must be a key of `session.stagedVerification.resultAdapters` |

That is the entire vocabulary. There is no other field, no nesting
beyond this, and no extension point: a future need is a change to this
document and a `version` bump, not an unvalidated pass-through.

Names, not ids, are the key deliberately. `exec:<name>` is derived from
the operator's name by the shipped `deriveExecutionCommandId`, so a
project file keyed on names cannot address a requirement slot at all —
which is precisely the slot class §3.4 step 2 must keep unselectable and
§8.2 must keep un-adapted.

### 4.3 What the file is for, in one sentence each

- `alwaysRequired` — the project knows something the operator's staging
  did not: this check is cheap, or central, or historically the one that
  catches the regressions that matter, so never skip it in a loop.
- `result` — the project knows how to read this check's own output, and
  is offering to turn it into failing case ids for the fix loop and the
  operator.

Neither statement can make verification weaker, which is why the file
can live where an agent can write it.

### 4.4 Validation and refusal

Validation is **fail-closed at read time**, and a refusal is an
operator-facing fact, never a verification failure and never agent fix
input. The closed refusal list:

| Condition | Disposition |
| --- | --- |
| Unreadable, non-UTF-8, or not a JSON object | Refuse the file |
| `version` absent, non-integer, or not `1` | Refuse the file |
| Any field outside §4.2's table, at any depth | Refuse the file |
| `checks` key matching no `session.verification` name in the resolved plan | Refuse the file |
| `alwaysRequired` not a boolean | Refuse the file |
| `result` not a string, empty, or naming an id absent from `resultAdapters` | Refuse the file |
| Duplicate keys after JSON parsing | Refuse the file |
| File larger than a small fixed bound | Refuse the file |

**Refusing the file means ignoring all of it**: no partial application,
no "apply the entries that parsed". A half-applied file is a
configuration whose effect nobody can predict from reading it. The
resulting behavior is the file's absence (§4.1) — the operator's
configuration alone — plus a recorded refusal reason.

What "fail closed" buys here is precise, and the precision matters
because the obvious stronger claim is false. A project statement is
subtractive with respect to *selectability*, so dropping it moves a
check back toward the operator's own configuration — and for an
`alwaysRequired: true` pin on a check the operator listed as
`selectable`, that direction is less loop verification, not more:
honoring the pin takes the check out of the effective selectable set,
while ignoring the file returns it there and the selection adapter may
then omit it from a loop. **A refused file can therefore run less loop
verification than the same file honored, on exactly the checks the
operator had already marked omissible.** The guarantee is a floor, not a
monotone direction, and it is the floor §3.4 and §4.1 already state:

- **Never below the operator.** The effective selectable set stays a
  subset of the operator's `selectable` list whether the file is
  honored, absent, or refused, so a refusal can never reach a check the
  operator did not already allow the loop to skip.
- **Never out of the required set, never out of the final stage.** A
  refusal changes selection only. The required set is the plan's, and
  the final stage is the entire required set by #1094 §4.3 regardless of
  any project input, so nothing passes that would otherwise fail.
- **Never a verdict.** A refusal is an operator-facing fact: it changes
  no verdict, no stage outcome, no completeness flag and no transition,
  and it is never agent fix input.

The worst a refusal costs is one loop cycle's coverage of a check the
operator already staged as omissible — the same blast radius §4.1 gives
an agent that deletes a pin, which is the identical act seen from the
other side. Failing closed on the *file* is therefore about
predictability: a half-applied file has an effect nobody can read off
it, while a fully ignored one has exactly the effect §4.1 documents.

## 5. Identity, units, and stage membership

### 5.1 The check is the verification unit

A check is selected whole, run whole, and judged whole. There is no
partial execution of a check, no per-case selection, no per-case
retention, and no per-case grant. Three consequences:

- **An opaque command is a complete verification unit.** A project with
  no adapters, no file, and one `make verify` entry participates fully:
  it is selected by #1094 §4.2, judged by the shipped classifier, and
  recorded in the bundle like any other check.
- **Granularity is a configuration decision, not an adapter power.** An
  operator who wants unit tests and integration tests staged separately
  writes two `session.verification` entries. That is the supported way
  to get finer selection, and it keeps the bytes that execute
  operator-authored.
- **Cases never become checks.** No adapter output creates a check id,
  splits a check, or gets its own verdict, pin, regression entry or
  retention rule.

### 5.2 Cases are optional detail

A case exists only inside a structured result envelope (§7). It is
evidence detail and fix input: the failing case ids of a failed check
are the most useful thing the fix loop can be handed, and they are far
more legible to an operator than a truncated log tail. They are also
entirely optional — every rule in #1094 and in this document holds when
no case is ever reported.

### 5.3 Case id stability

A case id is an opaque string minted by the project. Core never parses
it, never splits it, never infers a file, package, or framework from it,
and never uses it to construct a command (§9.3). The project owes
exactly one property in return:

- **Stability.** The same logical case in the same repository state has
  the same id across runs, hosts and worktrees. Ids derived from the
  framework's own identity satisfy this; ids containing an absolute
  path, a timestamp, a process id, a shard number, or a run ordinal do
  not.
- **Uniqueness within a check.** Two entries with the same id in one
  envelope make the envelope `unreadable` (§7.5).
- **Bounded.** Non-empty, at most 512 bytes.
- **Honest.** A project that cannot produce stable ids must not produce
  ids: returning `kind: "unknown"` (§7.1) is the supported answer and
  costs nothing.

Case ids and case labels are **operator-facing and agent-facing only**.
Public surfaces carry counts, never ids and never labels (§7.6),
because an id derived from a framework identity routinely embeds a
repository path.

### 5.4 Stage membership

Stage membership is a **resolved property of a check in a task**, not a
configuration field, and its set is closed:

| Membership | Enters a loop selection by impact or by the always-required step? | Enters the final selection? | Reached by the #1094 floors? |
| --- | --- | --- | --- |
| `always` | Yes — always | Yes | Yes |
| `selectable` | Only when the selection port calls it related | Yes | Yes |
| `final-only` | **Never through a `"selected"` proposal** — but the unknown-impact fallback still contributes it | Yes | **Yes** |

Resolution, deterministic and total:

1. A check in the effective selectable set (§3.4) and named in the
   operator's `finalOnly` list is `final-only`.
2. A check in the effective selectable set otherwise is `selectable`.
3. Every other check is `always`.

The last two columns are the rules that keep `final-only` from being a
hole, and the first of them has two halves.

**Where `final-only` narrows.** `final-only` removes a check from #1094
§4.2's step 1 and step 2 only, and from step 1 **only when the selection
port returned a well-formed `"selected"` response**. Against such a
response the filter is exactly what the operator asked for: an impact
analysis may not pull a staged-out suite back into a loop. Step 2 needs
no qualifier, because a `finalOnly` name must also be `selectable`
(§3.2) and a check that leaves the effective selectable set stops being
`final-only` at all (rule 3 above), so the step-2 removal is already
implied by the resolution and is stated only for completeness.

**Where it does not narrow.** The unknown-impact fallback is not a
proposal to filter. When the selection port is absent, refuses, errors,
exceeds its budget, answers malformed, names an out-of-request id, or
returns `"unknown"`, step 1 contributes the **entire required set,
`final-only` checks included** (§8.1, §9.2). That rule is #1094 §4.2's
own, this contract does not change it, and it is what makes a session
with `finalOnly` and no `selectionAdapter` run every required check in
every loop (§8.3 row 1, §10.3). `final-only` buys a narrower loop from a
*working* selection adapter; it never buys one from a silent, broken, or
slow one.

Steps 3, 4 and 5 — the regression set, the loop pin set, and the
requirement closure — still pull a `final-only` check into a loop
selection unconditionally, on both paths. A `final-only` check that
failed this Issue's last final stage therefore runs on every subsequent
loop until a final stage clears it, exactly like any other check, and
the expensive suite an operator staged out of the loop comes back into
the loop precisely when it is the one that broke.

Membership is recorded per check in the bundle (§6.1), so evidence
answers "why was this check not run?" without a consumer re-deriving it
from configuration that may since have changed.

## 6. Command execution metadata

### 6.1 The per-check execution record

#1094 §6.2's `checks[]` entry is the normative core. This document fixes
the metadata fields it carries. The shape is normative; persistence and
artifact layout belong to #1094 §13's S4 and to the chain's third design
Issue:

```ts
interface CheckExecutionRecord {
  /** #1037 identity. Minted by the plan, never by a project. */
  checkId: string;
  /** The operator-authored name for an `exec:` check; absent for `req:`. */
  name?: string;
  /** sha256 over the command bytes as resolved. The bytes are not copied here. */
  commandDigest: string;
  /** Resolved membership (§5.4), recorded as of this stage run. */
  membership: "always" | "selectable" | "final-only";
  /** Why this check is in this selection, in #1094 §4.2 order. */
  selectedBy: readonly (
    | "impact"
    | "always-required"
    | "regression"
    | "pin"
    | "requirement-closure"
    | "final-total"
  )[];
  startedAtMs?: number;        // wall clock, for ordering and operator display
  durationMs?: number;         // runner-measured; see §6.2
  exitCode?: number;
  signal?: string;
  verdict: "passed" | "failed" | "timed-out" | "not-run" | "unknown";
  notRunKind?: NotRunKind;     // #1094 §6.2, unchanged
  outputTail?: string;         // #1094 §6.2, bounded, failures only
  logArtifact?: string;        // #1094 §6.2, run-artifact-relative
  structured?: StructuredCheckResult;   // §7
}
```

Rules:

1. **Command bytes are not duplicated into the record.** The plan holds
   them; `commandDigest` binds the record to them. This keeps #1094 §10
   rule 5's redaction posture mechanical rather than a matter of care at
   each surface.
2. **`selectedBy` is recorded, not inferred.** A consumer asking why a
   check ran reads the record; it does not re-run the selection
   algorithm against configuration that may have changed since.
3. **A `req:<hex>` record has no `name` and no `structured` payload.** A
   requirement slot's verdict is derived from #1094 §4.3's proven
   projection, not from a run of its own, so there is no output for an
   adapter to read (§8.2).
4. **The record is runner-produced in full.** No field is supplied by,
   defaulted from, or corrected by an adapter — including every field in
   §6.2 and §6.3.

### 6.2 Duration

- `durationMs` is **measured by the runner**, from immediately before
  the process is launched to immediately after it is reaped, using a
  monotonic clock. It is never taken from, adjusted by, or
  cross-checked against adapter output.
- A check with no launch has no `durationMs`. An accounted absence
  (#1094 §6.1) is not a zero-duration run, and recording it as one would
  make "ran instantly" and "never ran" indistinguishable in evidence.
- A case's `durationMs` (§7.2) is **advisory detail about a case**. Case
  durations are never summed, never compared to the check duration, and
  never used to derive, correct or validate it.

### 6.3 Result classes

The result classes are #1094's, unchanged and not extended:

- A check's `verdict` is one of `passed`, `failed`, `timed-out`,
  `not-run`, `unknown` (#1094 §6.2), derived from the shipped
  classification path (`classifyVerificationFailure`,
  `src/core/implementation-verification.ts`) — never from a structured
  result.
- A stage run's outcome is one of `passed`, `code-failed`, `timed-out`,
  `interrupted`, `unknown`, `infrastructure` (#1094 §6.1), with #1094's
  precedence, unchanged.
- A case's `status` (§7.2) is a **different, smaller vocabulary about a
  different subject**. It never enters either set above, never
  participates in either precedence, and never maps to a verdict.

## 7. The structured result envelope

### 7.1 Closed kind set

One check in one stage run has at most one envelope. Its `kind` is
closed, and the two states the Issue's contract demands be explicit —
unknown and partial — are first-class members rather than an absence
someone has to interpret:

| `kind` | Meaning | Carries cases? |
| --- | --- | --- |
| `complete` | The adapter parsed the run and asserts the case list is exhaustive | Yes, exhaustive |
| `partial` | The adapter parsed some cases and states that the list is **not** exhaustive — truncated output, a crashed worker, an unfinished shard | Yes, non-exhaustive |
| `unknown` | The adapter ran and can say nothing about cases — no machine-readable output, an unrecognized format, a framework that produced nothing | No |
| `unavailable` | No adapter applies, or none was invoked: no `result` mapping, the feature is off, the check did not run, or the check passed (§7.3) | No |
| `unreadable` | The runner could not admit the adapter's answer: non-zero exit, budget exceeded, malformed JSON, schema violation, oversized payload, duplicate or out-of-bounds ids | No |
| `conflicting` | Well-formed, but contradicts the runner's own verdict (§7.4) | No — retained for the operator, inadmissible as detail |

`unavailable` and `unknown` are deliberately distinct: the first says
nobody was asked, the second says someone was asked and honestly could
not tell. An operator reading "no failing tests listed" needs to know
which.

### 7.2 Shape

```ts
type StructuredCheckResult =
  | { kind: "complete" | "partial"; cases: readonly CaseResult[]; totals?: CaseTotals; truncated?: boolean; note?: string }
  | { kind: "unknown" | "unavailable" | "unreadable" | "conflicting"; reason: string };

interface CaseResult {
  /** Project-minted, stable, opaque to core (§5.3). */
  caseId: string;
  /** Bounded, operator-facing display text. Never parsed. */
  label?: string;
  status: "passed" | "failed" | "errored" | "skipped" | "unknown";
  /** Advisory only (§6.2). */
  durationMs?: number;
}

interface CaseTotals {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
}
```

`reason`, `note` and `label` are bounded operator-facing text, recorded
and never parsed for control flow — the same posture #1094 §5.1 gives
the selection port's `reason`.

### 7.3 When a result adapter is invoked

A result adapter is invoked for a check when **all** of:

- staged verification is enabled and the check is an `exec:` check;
- the project file maps the check's name to an adapter id, and that id
  resolves in `resultAdapters`;
- the check actually ran in this stage run, and its verdict is `failed`
  or `timed-out`.

Otherwise the envelope is `unavailable` with the reason recorded. The
failure-only rule is deliberate: the payload's value is the failing set,
the cost is a bounded subprocess per failing check, and invoking a
parser on every passing check in every loop cycle would spend that cost
on data no consumer reads. A project that wants totals on green runs is
asking for a test-suite quality metric, which #1094 §11 places outside
this chain.

### 7.4 The envelope is never a verdict

The runner's verdict is authoritative, always. The envelope may add
detail to it and may never change it.

- The response has **no verdict field, no outcome field, and no
  pass/fail claim for the check**. The shape makes the claim
  inexpressible rather than merely forbidden.
- **`complete` is downgraded to `partial` whenever the check did not run
  to completion** — `timed-out`, or terminated by a signal. An
  exhaustive claim about a run that was cut short is wrong on its face,
  and the downgrade is mechanical so no adapter has to be trusted to
  make it.
- **Contradiction is `conflicting`.** A `complete` envelope for a
  `failed` check that reports no `failed` and no `errored` case
  contradicts the exit code. The envelope is retained for the operator,
  its cases are inadmissible, the check's verdict is untouched, and the
  check leaves the effective selectable set for the remainder of the
  task (§3.4 step 4). That is the whole consequence: trust in the
  parser's detail is withdrawn, and trust in the exit code was never at
  stake.
- **No re-run, no re-classification, no "the adapter says it is flaky".**
  #1094 §7 rule 6 and #918 §6.3 stand.

The asymmetry is intentional and is the reason the rule can be stated so
simply: a parser that under-reports costs the operator detail, while a
parser that could *create* a failure — or clear one — would have moved
verdict authority into repository-writable code.

### 7.5 Bounds and admission

Every bound below is checked by the runner, and failing any of them
makes the envelope `unreadable` unless stated otherwise:

- The adapter exits 0 within `resultTimeoutMs` and writes one JSON
  object on stdout. stderr is captured, bounded, and operator-facing.
- The payload is at most a small fixed size; a larger one is
  `unreadable`.
- `protocolVersion` is present and known (§8.4).
- Every `caseId` is non-empty, at most 512 bytes, and unique within the
  envelope.
- A case count above a fixed cap is **not** a refusal: the runner
  truncates deterministically — non-passing cases first, preserving the
  adapter's order within each status class — sets `truncated: true`, and
  downgrades `complete` to `partial`. Losing detail must not lose the
  detail that matters.
- `totals` that disagree with the case list downgrades `complete` to
  `partial`. Disagreement is itself a statement that the list is not
  exhaustive.
- The envelope is **inert on every #1094 path**: it never contributes to
  a verdict, an outcome, the §6.1 precedence, the completeness flag, the
  regression set, the loop pin set, retention, or a grant.

### 7.6 Where the payload may appear

- **Agent fix input** — the failing and errored case ids of a failed
  check, bounded to a fixed maximum with a remainder count, alongside
  the existing bounded output tail. This is the payload's primary
  purpose.
- **Operator surfaces** — `admin task-verification`'s stage view (#1094
  §10 rule 6) may show ids, labels, counts and the envelope kind.
- **Public surfaces** — PR summaries, human-gate summaries and ChatOps
  acknowledgements carry **counts and the envelope kind only**: never a
  case id, never a label, never a path, never output bytes. #1094 §10
  rule 5 and `docs/environment-prepare-contract.md` §2.7 apply
  unchanged.

## 8. The adapters

### 8.1 The selection adapter

The selection adapter implements #1094 §5.1's port. **Its request and
response bodies are that document's, verbatim**; this section fixes only
the transport around them.

- **Invocation.** The runner spawns `selectionAdapter` in the worktree
  root, writes one JSON object to stdin, closes stdin, and reads one
  JSON object from stdout under `selectionTimeoutMs`.
- **Envelope.** The wire object is
  `{ "protocolVersion": 1, "kind": "selection", "request": <§5.1 request> }`
  and the response is
  `{ "protocolVersion": 1, "response": <§5.1 response> }`.
- **Everything fails to `"unknown"`.** Absent adapter, non-zero exit,
  signal, timeout, empty stdout, non-JSON stdout, unknown
  `protocolVersion`, schema violation, an id outside `request.checkIds`
  (#1094 §5.2 rule 1) — each yields `"unknown"`, and #1094 §4.2's
  unknown-impact rule then runs the **full** required set, `final-only`
  checks included (§5.4). Stage membership filters a `"selected"`
  proposal, never this fallback.
- **Never invoked for the final stage.** #1094 §5.2 rule 5 is a
  transport-level rule here too: no process is spawned for a final
  selection, so there is no failure mode to handle.
- **What the request deliberately omits.** The adapter receives check
  ids, the change paths, and the stage. It does **not** receive command
  bytes, the regression set, the loop pin set, the plan, the Issue body,
  or session configuration. It cannot act on floors it cannot see, which
  keeps "narrowing proposal" and "selection decision" structurally
  separate rather than separate by convention.

### 8.2 The result adapter

- **Invocation.** The runner spawns the command `resultAdapters[<id>]`
  resolved from the project file's `result` id, in the worktree root,
  with one JSON object on stdin, under `resultTimeoutMs`.
- **Request:**

  ```ts
  interface StructuredResultRequest {
    protocolVersion: 1;
    kind: "result";
    checkId: string;          // `exec:<name>` only
    name: string;             // the operator-authored check name
    verdict: "failed" | "timed-out";
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    /** The runner's own per-check log artifact for this run. */
    logArtifact: string;
  }
  ```

- **Response:** `{ "protocolVersion": 1, "result": <§7.2 envelope> }`.
  The `unavailable` and `conflicting` kinds are **runner-only**: an
  adapter that returns either is `unreadable`. An adapter says what it
  found (`complete`, `partial`) or that it cannot tell (`unknown`); it
  never reports on its own invocation or on the runner's verdict.
- **The runner passes one path and validates nothing else.**
  `logArtifact` is the artifact the runner wrote (#1094 §10 rule 4's
  preserved names). An adapter that needs another file — a framework's
  own JSON report — finds it itself, in the worktree, with the authority
  it already has. The runner never accepts a path *from* the project
  file (§3.3), so no project input can direct a runner read.
- **Failure is never a check failure.** A missing, crashing, hanging, or
  malformed result adapter yields `unreadable` and changes nothing about
  the check, the stage outcome, the bundle's completeness, or the
  transition. This is #957's ignore-and-audit posture, applied to a
  second kind of optional payload.
- **Never invoked for a `req:<hex>` check** (§6.1 rule 3), and never for
  a check that passed or did not run (§7.3).

### 8.3 Independence and optionality

The two adapters are independent, and each is independently optional.
All four combinations are supported and none is degraded:

| Selection adapter | Result adapter | Behavior |
| --- | --- | --- |
| Absent | Absent | Every loop runs the full required set; failures carry an output tail. Exactly #1094 with no project input |
| Absent | Present | Full loops, with failing case ids in the fix input and the operator view |
| Present | Absent | Narrowed loops within the operator's `selectable` list; failures carry an output tail |
| Present | Present | Narrowed loops with structured failure detail |

There is no bundling, no implied ordering, no shared process, no shared
state between them, and no requirement that a project implementing one
implement the other.

### 8.4 Versioning

- Both protocols carry `protocolVersion`, currently `1`, in both
  directions.
- A runner that reads a `protocolVersion` it does not know treats the
  answer as `"unknown"` (selection) or `unreadable` (result). It never
  attempts a partial or best-effort read of an unknown version.
- A new version is a change to this document, with both versions
  accepted for at least one release so an adapter and a runner may be
  upgraded independently.
- The project file's `version` (§4.2) is separate and is not a protocol
  version: it versions the file's schema, and an unknown value refuses
  the file (§4.4).

### 8.5 Execution posture

Adapters run under the posture verification commands already run under:
the same worktree, the same environment construction, the same
#916/#917 platform and sandbox rules, the same #697 tier. Adapter
invocation introduces **no** new operation class, refusal reason, grant,
tier, backend or preflight plan state, and no new lock: it happens
inside the phase execution lock and the per-Issue worktree lock the
stage already holds (#1094 §11).

## 9. How the project's answer enters selection

### 9.1 Restated floors

This section adds nothing to #1094 §4.2; it restates the floors from the
project side so an adapter author can see what their answer cannot do:

- A `"selected"` response is intersected with the required set and
  **unioned** with the always-required set, this Issue's regression set,
  this Issue's loop pin set, and the requirement closure. An adapter's
  omission of any of those is inert.
- A check outside the **effective** selectable set (§3.4) is
  always-required no matter what the adapter answers.
- A `final-only` check is outside step 1 only for the answer the adapter
  actually gave; an unknown answer restores it to step 1 with everything
  else (§5.4, §9.2).
- The final stage is the entire required set, always, with no adapter
  consulted.

### 9.2 Incomplete or unknown answers broaden, never narrow

Every degenerate case converges on the same safe behavior: a missing
adapter, a refusal, a crash, a timeout, malformed output, an unknown
protocol version, an out-of-request id, or an explicit `"unknown"` all
make step 1 contribute the **entire required set**. There is no partial
credit and no best-effort subset. **"Entire" includes `final-only`
checks**: stage membership is a filter over a well-formed `"selected"`
proposal (§5.4), and there is no proposal to filter on this path, so a
`finalOnly` name is omitted from a loop only when a selection adapter
actually answered — never because one was absent, crashed, or timed
out. The same principle governs the result
side, in its own currency: an envelope that is `partial`, `unknown`,
`unreadable` or `conflicting` yields less *detail*, never less
*verification*, and `conflicting` additionally broadens the next loop by
withdrawing the check's selectability (§3.4 step 4).

### 9.3 The runner never synthesizes a command

The runner executes the operator's command bytes, unmodified, for every
check it runs. It never appends a filter, a test-name pattern, a shard
index, a path list, or any other argument derived from a selection
response, a case id, a structured result, a change path, or a project
file. Two independent reasons, either of which is sufficient:

- **Authorization.** A command assembled from adapter output is a
  command the operator never wrote, executed with the runner's
  authority. That is the boundary §3 exists to hold.
- **Evidence.** A check's identity and digest bind its evidence (#1094
  §6.2 rule 2). A run of `npm test -- <pattern>` is not a run of
  `npm test`, so admitting it under the same check id would let a
  narrowed run stand as evidence for a check that never ran in full —
  which is exactly the class of claim #1094 §4.3 spent its length
  preventing.

A project that wants a narrower command writes a narrower
`session.verification` entry (§5.1).

## 10. Worked examples

The same core contract, three projects, one of them not TypeScript and
one of them with no adapter at all.

### 10.1 This repository — TypeScript with Jest

`sessions.json` (operator, one-time):

```json
{
  "verification": {
    "typecheck": "npm run typecheck",
    "test": "npm test",
    "package": "npm run package"
  },
  "stagedVerification": {
    "enabled": true,
    "selectable": ["test", "package"],
    "selectionTimeoutMs": 30000,
    "selectionAdapter": "node scripts/loop-selection.mjs",
    "resultAdapters": { "jest-v1": "node scripts/loop-jest-result.mjs" },
    "resultTimeoutMs": 30000
  }
}
```

`.ai-cli-loop/verification.json` (repository, version-controlled):

```json
{
  "version": 1,
  "checks": {
    "typecheck": { "alwaysRequired": true },
    "test": { "result": "jest-v1" }
  }
}
```

Resolved membership: `exec:typecheck` is `always` — the operator listed
it as selectable, and the project pinned it back, because a typecheck on
this repository is fast and catches the majority of loop breakage.
`exec:test` and `exec:package` are `selectable`.

A loop cycle whose change touches only `src/core/verification-plan.ts`:
the selection adapter answers
`{"kind":"selected","checkIds":["exec:test"]}`; the union with the
always-required set yields `exec:typecheck` and `exec:test`;
`exec:package` is omitted. `npm test` fails. The runner classifies
`failed`, writes `verification-test.log`, and — because the project file
maps `test` to `jest-v1` — invokes the result adapter, which reads the
log, finds Jest's reporter output and returns:

```json
{
  "protocolVersion": 1,
  "result": {
    "kind": "complete",
    "cases": [
      { "caseId": "test/verification-plan.test.js::resolves a retired slot", "status": "failed" }
    ],
    "totals": { "total": 412, "passed": 411, "failed": 1 }
  }
}
```

The fix input carries the failing case id beside the bounded output
tail; the stage is `code-failed` and routes through #1094 row 2;
`exec:test` joins the loop pin set, so the next loop runs it even if the
adapter calls the fix unrelated. When review approves, the final stage
runs `typecheck`, `test` and `package` — the whole required set, no
adapter consulted — and only a complete, passing final bundle grants
stack-ready.

### 10.2 A Go module — non-TypeScript, same core contract

Nothing in core changes. The project supplies its own adapters, its own
case-id scheme, and its own pins.

`sessions.json`:

```json
{
  "verification": {
    "vet": "go vet ./...",
    "build": "go build ./...",
    "test": "go test -json ./...",
    "e2e": "make e2e"
  },
  "stagedVerification": {
    "enabled": true,
    "selectable": ["test", "e2e"],
    "finalOnly": ["e2e"],
    "selectionTimeoutMs": 30000,
    "selectionAdapter": "go run ./tools/loopselect",
    "resultAdapters": { "gotest-v1": "go run ./tools/looptestresult" },
    "resultTimeoutMs": 60000
  }
}
```

`.ai-cli-loop/verification.json`:

```json
{
  "version": 1,
  "checks": {
    "vet": { "alwaysRequired": true },
    "build": { "alwaysRequired": true },
    "test": { "result": "gotest-v1" }
  }
}
```

Membership: `exec:vet` and `exec:build` are `always`, `exec:test` is
`selectable`, `exec:e2e` is `final-only` — a twenty-minute suite the
operator staged out of the loop, which still runs in every final stage
and still returns to the loop the moment it is in this Issue's
regression set (§5.4). It returns for one other reason too: on a cycle
where `go run ./tools/loopselect` fails to build, crashes, or overruns
its 30 s budget, the selection reads `"unknown"` and that loop runs the
entire required set — `exec:e2e` with it (§9.2). A broken adapter costs
this project twenty minutes, never coverage.

`go test -json ./...` writes machine-readable output to stdout, which
the runner already captures into `verification-test.log`, so the
operator's command needs no redirection and no flag invented by this
contract. The result adapter reads that artifact and mints case ids from
Go's own identity — `github.com/acme/svc/internal/billing.TestRounding`,
or `.../TestRounding/negative_amounts` for a subtest — which are stable
across runs and hosts, as §5.3 requires.

Two non-TypeScript specifics worth naming, because they are where a
language-neutral contract usually leaks:

- **A build is a check like any other.** `exec:build` is pinned
  always-required because in a compiled language a build failure makes
  every other check meaningless. That is a project judgment expressed in
  the project file, not a special case in core.
- **Truncation is normal here.** A large `go test -json` stream can
  exceed the runner's bounded log capture. The adapter returns
  `kind: "partial"` and the failing cases it did parse; the check's
  verdict is unaffected, the bundle's completeness is unaffected, and
  the operator sees `partial` rather than an exhaustive claim that
  happens to be wrong.

### 10.3 A project with opaque commands and no adapter

A polyglot service with a `Makefile` and no interest in adapters:

```json
{
  "verification": { "lint": "make lint", "verify": "make verify" },
  "stagedVerification": { "enabled": true, "selectable": ["verify"] }
}
```

No `.ai-cli-loop/verification.json`, no `selectionAdapter`, no
`resultAdapters`. Every selection request reads `"unknown"`, so every
loop runs `make lint` and `make verify` — the full required set — and
every final stage runs the same set at the approved head. `make verify`
is a single verification unit: one command, one verdict, one entry in
the bundle, no cases, `structured: { kind: "unavailable" }`.

The project gets the whole of #1094 — staged evidence, the regression
set, the loop pin set, the per-Issue final stage, and the single
granting cell — while writing exactly two commands and one flag. That is
the design's floor, and it is deliberately the same floor an
un-adapted TypeScript repository gets.

## 11. Compatibility and opt-in

1. **Default off.** With `stagedVerification.enabled` absent or `false`,
   nothing here runs: no file is read, no adapter is spawned, and
   behavior is exactly today's (#1094 §10 rule 1).
2. **Enabled with no project file and no adapters.** The full required
   set in both stages, `structured: { kind: "unavailable" }` on every
   check, and no spawned subprocess beyond the checks themselves.
3. **Session schema.** `session.verification` is untouched.
   `stagedVerification` gains optional fields only; a session written
   against #1094 §5.3 loads unchanged and behaves identically.
4. **Artifacts.** Per-check log names are preserved verbatim (#1094 §10
   rule 4). A structured result is recorded inside the stage bundle, not
   as a replacement for any existing artifact.
5. **Public surfaces.** Counts and envelope kinds only; no case id, no
   label, no path, no output bytes (§7.6).
6. **Operator surfaces.** The #1094 §10 rule 6 stage view gains the
   envelope kind and, where present, the failing case ids. No new
   command family is introduced.

## 12. Invariants

1. The verification unit is the check. Cases are optional detail and
   never become checks, selections, pins, regressions, retention units,
   or grants (§5.1, §5.2).
2. Check identity is minted by the shipped plan and by nothing else. No
   project input creates, renames, aliases, retires, or restores a check
   (§2, §3.5).
3. The project verification file is non-authorizing: it may contain no
   command, path, budget, environment value, grant, or verdict, and its
   vocabulary is closed at `version`, `checks.<name>.alwaysRequired` and
   `checks.<name>.result` (§3.3, §4.2).
4. Selectability is computed by subtraction only, and the effective
   selectable set is always a subset of the operator's `selectable`
   list. No project file, adapter answer, or runtime event ever adds
   selectability (§3.4).
5. #1094 §4.2's five-set union is unchanged: this contract supplies the
   effective selectable set its step 2 consumes and adds no sixth
   source. Steps 3, 4 and 5 remain floors nothing here can reach (§3.4,
   §9.1).
6. Stage membership is a closed set — `always`, `selectable`,
   `final-only` — resolved deterministically and recorded in evidence.
   `final-only` removes a check from the always-required step and from a
   well-formed `"selected"` proposal only; every #1094 floor still
   reaches it, and so does the unknown-impact fallback, which
   contributes the entire required set including `final-only` checks
   (§5.4, §9.2).
7. A structured result is never a verdict. The envelope has no verdict
   field, the runner's classification is authoritative, `complete` is
   downgraded to `partial` for any run that did not complete, and a
   contradiction is `conflicting` with its cases inadmissible (§7.4).
8. Every adapter failure mode is fail-closed toward more verification
   and less trust: selection failures yield the full required set,
   result failures yield `unreadable`, and neither changes a verdict, a
   stage outcome, a completeness flag, or a transition (§8.1, §8.2,
   §9.2).
9. The runner never synthesizes or modifies a command. No selection
   response, case id, structured result, change path, or project file
   contributes a byte to what executes (§9.3).
10. A refused project file is ignored in full, never applied in part,
    and the result is exactly the file's absence: never below the
    operator's own `selectable` bound, never out of the required set,
    never out of the final stage, and never a verdict — a dropped
    `alwaysRequired` pin may still cost one loop cycle's coverage of a
    check the operator already staged as omissible (§4.1, §4.4).
11. No framework detection exists. An unconfigured project runs opaque
    commands as complete verification units, and an opaque command is a
    supported first-class configuration, not a degraded one (§4.1,
    §5.1, §10.3).
12. Case ids and labels are operator- and agent-facing only; public
    surfaces carry counts and envelope kinds (§5.3, §7.6).
13. Adapter invocation adds no authority, operation class, refusal
    reason, tier, backend state, store, scheduler, or lock (§3.7,
    §8.5).
14. Routine per-Issue operation edits no authorizing file: project
    changes ride the Issue's own branch, and command changes remain
    operator acts (§3.6).
15. Default-off: an un-opted-in session behaves exactly as today (§11
    rule 1).

## 13. Implementation mapping

This contract adds **no slice** to #1094 §13's twelve. It specifies
content for five of them, and the rest are untouched:

| #1094 slice | What this contract adds to it |
| --- | --- |
| S1 — pure stage model core | Stage membership resolution (§5.4) and the effective selectable set (§3.4) as pure functions over an `EffectiveVerificationPlan`; the `CheckExecutionRecord` and `StructuredCheckResult` types (§6.1, §7.2) |
| S2 — session schema and fail-closed load | `finalOnly`, `selectionAdapter`, `resultAdapters`, `resultTimeoutMs` and their refusals (§3.2); the project file reader and its closed refusal table (§4.4) |
| S4 — bundle persistence | `membership`, `selectedBy`, `commandDigest`, the project file digest, and the structured envelope recorded in the bundle (§6.1) |
| S6 — the selection port | The §8.1 transport, envelope, protocol version and total fail-closed wrapper |
| S12 — first project integration | The §10.1 TypeScript/Jest adapters for this repository, out of core |

The result adapter's own invocation site — failure-only, per check,
inside the stage run — belongs with S3's stage-scoped execution input,
which is the only place that knows a check's verdict at the moment it is
produced.

## 14. Test seams and matrix

For the implementation slices that build against this contract — the
docs pin is the only test landing with #1095 itself:

| Area | Cases |
| --- | --- |
| Configuration locations (§3) | A project file naming a command, path, budget, environment value, grant or verdict is refused; a project file cannot make a check selectable; a `finalOnly` name absent from `selectable` refuses the session; the effective selectable set is always a subset of the operator's list; a `req:<hex>` slot and a task-amendment-added slot are never selectable regardless of any project input; a project pin creates no plan revision and does not survive into another task |
| Project file (§4) | Discovery is the single fixed path, with no upward search, no override and no alternative extension; absence is silent and equals the operator's configuration alone; every row of the §4.4 refusal table refuses the whole file; a refused file leaves behavior equal to absence, including the case that costs coverage — a refused file whose `alwaysRequired: true` pin named an operator-`selectable` check leaves that check selectable, and the refusal still changes no required check, no final selection, no verdict and no transition; an unknown `version` refuses; `alwaysRequired: false` grants nothing; a `checks` key matching no plan name refuses; the file's digest is recorded in the bundle |
| Identity and membership (§5) | No project input mints or renames a check id; membership resolves to exactly one of the three classes; a `final-only` check is excluded from a well-formed `"selected"` proposal and from the always-required step, and always enters the final selection; a `final-only` check **is** selected in the loop when the selection answer is `"unknown"` — including with no `selectionAdapter` configured, with an adapter that exits non-zero, and with an adapter that overruns `selectionTimeoutMs` — and when it is in the regression set, in the loop pin set, or pulled in by the requirement closure; membership is recorded per check |
| Case identity (§5.3) | Duplicate case ids make the envelope `unreadable`; an over-long or empty id makes it `unreadable`; ids are never parsed, split, or used to build a command |
| Execution metadata (§6) | `durationMs` is runner-measured and never derived from or corrected by adapter data; an accounted absence has no duration; `selectedBy` is recorded and matches the selection that produced the run; command bytes are not copied into the record; a `req:<hex>` record carries no `name` and no structured payload |
| Envelope kinds (§7.1) | Each of the six kinds is produced by its own condition; `unavailable` and `unknown` are distinguishable; an adapter returning `unavailable` or `conflicting` is `unreadable` |
| Envelope admission (§7.4, §7.5) | A `complete` envelope on a `timed-out` check is downgraded to `partial`; a `complete` envelope with no failing case on a `failed` check is `conflicting`, its cases inadmissible, its check's verdict unchanged, and its check leaves the effective selectable set for the task; disagreeing `totals` downgrade to `partial`; an over-cap case list truncates non-passing-first, sets `truncated`, and downgrades to `partial`; a malformed, oversized, timed-out, crashing or non-zero-exit adapter is `unreadable` and changes no verdict, outcome, completeness flag or transition |
| Invocation (§7.3, §8.2) | A result adapter is invoked only for a failed or timed-out `exec:` check with a resolving adapter id; never on pass, never on `not-run`, never for `req:<hex>`, never when the feature is off; the request carries only the §8.2 fields; no path from the project file is ever read by the runner |
| Selection transport (§8.1) | The §5.1 request and response bodies are unchanged; every transport failure yields `"unknown"` and then the full required set, with `final-only` checks in it; no process is spawned for a final selection; the request carries no command bytes, no regression set, no pin set, no plan and no session configuration |
| Versioning (§8.4) | An unknown `protocolVersion` is `"unknown"` for selection and `unreadable` for results, with no partial read; the file `version` and the protocol version are independent |
| Command integrity (§9.3) | No selection response, case id, structured result, change path or project file value ever reaches the executed command; the executed bytes equal the plan's bytes for every check in every stage |
| Examples (§10) | The TypeScript/Jest, Go and no-adapter configurations each resolve to the documented membership and the documented selection under the same core code path, with no language-specific branch in core |
| Compatibility (§11) | A #1094-era session loads unchanged; flag-off spawns no adapter and reads no file; log artifact names are preserved; public summaries carry counts and kinds only |
| Docs pin | `test/docs-project-verification-contract.test.js` pins this document's status line, chain position and no-runtime-behavior claim, the deferrals to #1094 and the fixed predecessor contracts, the three-location table and its authorization boundary, the closed project-file vocabulary and its never-contains list, the subtraction-only selectability rule with its operator lower bound and its "#1094 §4.2 is unchanged" claim, the reconciliation with #1037's four layers, the single fixed file location with silent absence and no framework detection, the closed refusal table with the ignore-the-whole-file rule and the operator-floor bound that replaces the false monotone, the check-is-the-unit rule with granularity-is-configuration, the case id stability rules, the closed stage-membership set with its floors-still-reach-it rule and its unknown-impact fallback rule, the runner-measured duration rule, the six envelope kinds with unknown and partial explicit, the never-a-verdict rules including the `partial` downgrade and `conflicting`, the fail-closed adapter wrappers, the four-combination optionality table, the no-command-synthesis rule with both its reasons, the three worked examples, the invariants, the implementation mapping, and the reconciliation notes in `docs/staged-verification-contract.md` §15, `docs/verification-amendment-contract.md` §17, `docs/environment-prepare-contract.md` §3, `docs/feature-status.md`, and `docs/DOMAIN.md` §5 where present — against drift |

## 15. Non-goals and forward pointers

This document defines project-owned verification configuration and the
adapter contracts only. It does not define, and nothing implementing it
should assume:

- **Evidence layout, observability, and operator-surface detail** — the
  exact artifact paths, bundle serialization, event payloads, CLI output
  shapes and audit reporting belong to the chain's third design Issue
  and to #1094 §13's S4 and S11. This document fixes what a structured
  result *is* and when it is admissible, not where it is written.
  **Delivered (#1096)**: `docs/verification-evidence-validity-contract.md`
  — the verification evidence validity, pinned regressions and recovery
  contract, the chain's third design Issue. It fixes what a bundle is
  *bound to* and what a pin's life is, and it leaves the layout itself
  to #1094 §13's S4 and S11 as this bullet says. Three of its rules touch
  this document and none of them changes it. **The identity component is
  the applied selection policy, never the project file's bytes**: §3.4's
  effective selectable set, the operator's lists and the resolved
  result-adapter mapping are digested, so a refused file and an absent
  file — which §12 invariant 10 requires to behave identically — compare
  identical, while the file's own digest stays recorded beside it as
  evidence detail (§14). **A structured result stays inert**: it
  contributes to no identity component, no pin, no release and no
  recovery decision, exactly as §7.5 already says, and no adapter
  declares, defaults or corrects an identity. **The case stays detail**:
  a regression pin is always a `commandId`, failing case ids are an
  optional annotation on it, and a `timed-out` check — whose envelope
  §7.4 already downgrades to `partial` — attributes to the check and
  names no case at all, so the last case printed before a deadline can
  never become a pinned failure.
- **A real impact analysis.** What a selection adapter computes — build
  graphs, import graphs, coverage maps, heuristics — is entirely the
  project's business. Core's contract with it begins and ends at §8.1.
- **Adapter packaging, distribution, or a registry.** An adapter is a
  command the operator named. There is no plugin manifest, no package
  format, no version negotiation beyond §8.4, no discovery protocol, and
  no shared adapter library.
- **Framework detection, scaffolding, or generated configuration.** No
  auto-detection, no `init` command that writes a project file, no
  inferred adapter (§4.1).
- **Per-case selection, sharding, or test splitting.** The check is the
  unit (§5.1), and command synthesis is forbidden (§9.3).
- **Flake detection, rerun-to-green, quarantine, coverage thresholds, or
  test-suite quality metrics** — #1094 §11 and #918 §6.3 and §16.
- **Test maintenance of any kind** — no deletion, restructuring,
  renaming, skipping, or quarantining, and no mutation-testing engine
  (#1094 §11).
- **Any change to `session.verification`, the amendment surface grammar,
  the ChatOps verb table, the label vocabulary, the review admission
  path, or the stack-ready grant** — governed by their own contracts and
  by #1094.
