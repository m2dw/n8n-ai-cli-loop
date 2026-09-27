# Staged verification lifecycle and ownership contract

Status: **approved design; §13's S2 session configuration, S1's
common command-result vocabulary, evidence matching law, selection
algorithm and stage-outcome precedence, S4's stage evidence persistence
and requirement projection, S6's selection port, S3 with S7's
implementation-lane loop stage, and S9 with S10's per-Issue final
stage and stack-ready publication gate implemented** (issues #1094,
#1097, #1098, #1099, #1100, #1101, #1102, #1103).
This
document is the authoritative contract for the **staged** shape of
runner-owned verification: a lightweight **loop stage** that runs on
every normal implementation, fix, review, and conflict-resolution cycle,
and a **final stage** that runs the complete required validation for
**each Issue** before that Issue may be published as a stacking base.
It fixes the ownership split between the runner and the project, the two
stages and their selection rules, the closed stage-outcome vocabulary,
the normative state-transition table, the mandatory retention the runner
owns, and the ordering between AI review approval, final verification,
and stack-ready publication. Follow-up implementation issues reference
this specification and MUST NOT redefine its policy; a change of policy
is a change to this document first.

**Superseded for selection (#1158).**
`docs/changed-file-verification-contract.md` is the authoritative
contract for test selection, stage results, retention, routing and
stack-ready publication of Stage 1 (changed files) and Stage 2 (full
suite). This document keeps no authority over those subjects. It remains
the record of what #1094–#1108 shipped. A rule here binds the
replacement only where that contract's §8 restates it.

This is slice 1/15 of the independent **Staged Verification** chain: 3
design Issues followed by 12 implementation/validation Issues. Execution
order is represented by GitHub Blocked by relationships and the chain
registry, not by prose here. The chain has no dependency on another
active chain. Issue #1094 delivers this document, the reconciliation
notes in the documents it touches, and its structural contract tests
only: **no runtime behavior ships with it.**

Availability of everything described here is tracked in the
[Staged verification](feature-status.md#staged-verification-loop-and-final-stages)
row of `docs/feature-status.md`.

It does **not** specify, and no implementation built against it may
assume:

- **Verification ownership, non-derivation, and session configuration**
  — fixed by `docs/environment-prepare-contract.md` §3.1–§3.3.
  `session.verification` stays operator-authored, never derived from
  Issue text or agent output, never modifiable, skippable, or
  reorderable by an agent. A *stage* selects among already-authorized
  checks; it never authors one.
- **The effective verification plan, its layers, precedence, stable
  command identity, plan digest, revision model, admissible states, and
  evidence invalidation** — fixed by
  `docs/verification-amendment-contract.md` (#1037) and **shipped** in
  `src/core/verification-plan.ts`, `src/core/verification-amendment.ts`,
  and `src/core/verification-evidence.ts` (#1038–#1044). This contract
  consumes `EffectiveVerificationPlan` and its `commandId`/`planDigest`
  identities verbatim; it introduces no plan layer, no slot origin, and
  no revision operation.
- **Runner-owned execution, per-command classification, cycle
  aggregation, the evidence bundle, and lane continuation** — fixed by
  `docs/verification-execution-contract.md` (#918), which is
  **design-only** today. A stage is a *selection and lifecycle* layer
  above set resolution: when #918's unified engine lands, the stage
  supplies the resolved set's membership filter (#918 §5.1) and consumes
  its cycle outcomes unchanged. Until then it adapts the three shipped
  execution sites (§9).
- **The ExecutionBackend, the preflight Execution Plan, the grant
  tiers, and the platform/sandbox attestation** — fixed by #917, #915,
  #697 and #916 respectively. This contract adds no backend, operation
  class, outcome, refusal reason, tier, or plan state.
- **The dependency gates themselves.** `docs/phase-contracts.md`'s Gate
  1 (close-only) and Gate 2 (stack-ready with a usable PR) keep their
  definitions and their resolver. This contract changes only *what it
  takes to earn* the stack-ready marker, never how a dependent consumes
  it.
- **Progressive Issue refinement.** `docs/issue-refinement-contract.md`
  keys its eligibility on the same stack-ready signal; a marker that is
  harder to earn is still the same marker, and no refinement rule
  changes here.
- **Retention, backup, and pruning mechanics** —
  `docs/retention-backup-contract.md` owns them. §6.3's mandatory
  retention is a *floor* that policy must respect; it adds no store, no
  table, and no pruning surface.

## 1. Why this contract — the gap it closes

Verification today is all-or-nothing and stage-blind, and the loop pays
for it at both ends.

- **Every cycle runs everything, or the loop is not verified at all.**
  The resolved set is the whole configured set, every time, in every
  lane (#918 §5.1; shipped, `runVerification` iterates
  `session.verification` in full). On a project whose full required
  validation is slow, that cost is paid on every repair iteration, every
  fix turn, and every review cycle — most of which touched a fraction of
  the surface. The only lever an operator has is to configure *less*,
  which weakens the gate permanently rather than staging it.
- **Nothing is validated per Issue before downstream work starts.**
  `status:stack-ready` is enqueued on `phase === "review" && result ===
  "success"` alone (`src/core/outbox-effects.ts`); review admission
  deliberately carries no verification evidence (#681; #918 §12.4). A
  dependent Issue may therefore branch from a base whose full required
  validation never ran on the approved head — and, under Gate 2, it
  branches from that head *before the blocker is merged*, so the first
  moment the full set runs against the combined work is somewhere down
  the stack, far from the change that broke it.
- **"It passed" is ambiguous.** A passing run today does not record
  *which* checks ran. A subset run and a full run produce the same
  shape, so no consumer can tell partial evidence from complete
  evidence — which makes any selective execution unsafe to add without
  first fixing what a stage *is*.
- **A failure the loop already saw can be re-selected away.** When a
  check fails, the next cycle has no memory of it. Any impact-based
  narrowing that forgets prior failures would let a known-broken check
  drop out of the loop precisely because the fix did not touch its
  "impact area".
- **The project's knowledge and the runner's authority are tangled.**
  Which checks relate to a change is a question only the project can
  answer — it depends on the language, the build graph, the test
  framework, the repository layout. Whether a check may run, when, with
  what evidence, and what its result means is a question only the runner
  may answer. Nothing today separates them, so any selection feature
  risks pulling language knowledge into core or authorization out of it.

This contract fixes all of it as design: two named stages with
deterministic selection (§4), one narrowing-only project port that can
never widen authorization (§5), one closed stage-outcome vocabulary with
an evidence bundle that records its own completeness (§6), one normative
state-transition table that grants stack-ready on complete evidence and
on nothing else (§7), one publication ordering (§8), and an explicit
map of the shipped modules to extend (§9) — with compatibility (§10) and
a maintenance boundary (§11) that keep every shipped behavior unchanged
until an operator opts in.

## 2. Terminology

- **Check** — one addressable verification obligation, identified by the
  shipped `EffectiveVerificationSlot.commandId`: `exec:<name>` for an
  execution-layer slot, `req:<hex>` for an Issue-required slot
  (`src/core/verification-plan.ts`, #1039). A check is never a command
  string in this contract; it is an identity in the effective plan.
- **Required set** — for one task at one moment, every `active` slot of
  the resolved `EffectiveVerificationPlan`: the execution layer the
  runner runs, plus the requirement layer whose satisfaction
  `buildEffectiveRequirementStatus` judges. `retired` slots are not in
  the required set.
- **Stage** — a named verification obligation level within the Issue's
  lifecycle. The stage set is **closed**: `"loop"` | `"final"` (§4).
  Adding a stage is a change to this document first.
- **Stage run** — one execution of one stage's selected checks. Its
  identity is `(taskAttempt, lane, stage, stageOrdinal)`, where `lane`
  is #918 §2's lane and `stageOrdinal` starts at 0 per attempt, lane and
  stage. A stage run contains one or more #918 verification cycles; it
  never spans lanes.
- **Selection** — the ordered subset of the required set a stage run
  executes (§4.2, §4.3). Selection is metadata about *scope*, never
  about *permission*.
- **Always-required check** — a check the loop stage may never omit.
  Every check is always-required unless the operator listed it as
  selectable (§5.3). The default is therefore "omit nothing".
- **Regression set** — the check ids that failed, timed out, or returned
  no admissible verdict in this Issue's most recent non-passing **final**
  stage run. Unioned into every subsequent loop selection until a final
  stage passes (§4.2 rule 3, §6.3 R2).
- **Loop pin set** — the check ids a **loop** stage run selected and did
  not record a `passed` verdict for. Unioned into every subsequent loop
  selection until each id is proven green (§4.2 rule 4, §6.3 R6). The
  regression set is written by final stages only; the loop pin set is
  what carries a loop stage's own unproven checks forward.
- **Accounted absence** — a selected check with no verdict whose cause
  the stage run itself recorded: the execution site stopped at the first
  failure, a set budget expired, the substrate broke, a policy refused,
  or an operator cancelled. Its named cause — not the bare absence —
  decides what it contributes to the stage outcome (§6.1).
- **Evidence loss** — a selected check with no verdict and no recorded
  cause: the run ended before reaching it for no named reason, or its
  verdict is unreadable or unbindable. Evidence loss is what makes a
  stage run `interrupted` or `unknown`; an accounted absence is not
  evidence loss (§6.1).
- **Selection port** — the project-owned adapter that answers "which
  checks does this change touch?" (§5). Its answers are proposals; the
  runner decides.
- **Stage outcome** — the aggregate judgment of one stage run (§6.1).
  The set is **closed**: `"passed"` | `"code-failed"` | `"timed-out"` |
  `"interrupted"` | `"unknown"` | `"infrastructure"`.
- **Stage evidence bundle** — the durable result of one stage run
  (§6.2), carrying its selection, its completeness, its bindings, and
  every selected check's verdict. The bundle — never an agent statement,
  never an adapter statement — is the only admissible evidence that a
  stage ran or passed.
- **Complete bundle** — a bundle whose selection equals the full
  required set and whose every selected check carries a terminal verdict.
  Only a complete, `passed` bundle can satisfy a final stage.
  Completeness is about verdict coverage, never about blame: a check
  without a terminal verdict keeps a bundle incomplete whether its
  absence is accounted for or lost.
- **Partial bundle** — any bundle that is not complete. Retained for the
  operator, permanently inadmissible as evidence (§6.2 rule 4).
- **Stack-ready grant** — the enqueue of the `stackReady` label effect
  that makes an Issue a usable stacking base under Gate 2
  (`docs/phase-contracts.md`; `src/core/outbox-effects.ts`).

## 3. Ownership — who decides what

Three owners, one precedence order, no overlap.

### 3.1 The runner owns the lifecycle

The runner — core, language-neutral — owns, exclusively:

1. **Stage scheduling**: which stage runs in which lane at which moment
   (§4.1, §8).
2. **Execution**: launching checks, bounding them, and capturing their
   results, through the shipped execution sites today and #917's seam
   when it lands.
3. **Verdicts and aggregation**: the per-check classification and the
   stage outcome (§6.1). No project input reclassifies a result.
4. **Evidence**: the bundle, its bindings, its completeness flag, and
   its admissibility (§6.2).
5. **Mandatory retention** (§6.3). Retention is never configurable by
   the project or by an adapter.
6. **Transitions and publication**: the §7 table and the §8 ordering,
   including the stack-ready grant.
7. **Authorization**: which commands may execute at all — unchanged, and
   owned upstream by `docs/environment-prepare-contract.md` §3 and the
   #1037 plan layers.

### 3.2 The project owns test meaning and selection

The project — configuration plus an out-of-core adapter — owns:

1. **What a check means**: what `exec:test` actually verifies, how it is
   invoked, what it covers. This is already true and already
   operator-owned; this contract does not move it.
2. **Impact relatedness**: given an opaque change descriptor, which
   check ids are related to it (§5). This is the only new project
   responsibility, and it is a **narrowing proposal**, not a decision.

### 3.3 What core may never know

Core contains **no** TypeScript, npm, Jest, filename, extension,
directory, build-graph, package-manager, or repository-layout knowledge.
Specifically, core may never:

- inspect a changed path's extension, basename, or directory to infer
  anything;
- map a source file to a test file by any naming convention;
- parse a test runner's output, a coverage report, or a build manifest;
- assume a check is a shell command of any particular shape beyond the
  bytes the operator authored;
- ship a default adapter, a language detector, or a built-in impact
  heuristic.

Paths that reach core are **opaque strings** carried from the provider's
diff and passed through to the adapter unread. The consequence is the
design's safety property: an operator with no adapter gets today's full
verification on every loop — slower than the optimum, never weaker than
today.

TypeScript/Jest is the **first project integration**, delivered as an
adapter in the chain's last slice (§13 S12). It is not a core feature
and it is not a reference implementation core depends on.

### 3.4 Precedence

Where the layers disagree, the order is: **operator plan > runner
lifecycle > project selection**. An adapter cannot add a check the plan
does not contain, cannot keep a check the plan retired, cannot omit an
always-required check, cannot omit a regression-set check, cannot omit a
pinned unproven check, and cannot run at all in the final stage. Every one of those is enforced by the
runner, not by trusting the adapter (§5.2).

## 4. The two stages

### 4.1 When each stage runs

| Stage | Lanes | Moment | Purpose |
| --- | --- | --- | --- |
| `loop` | `implementation`, `review`, `conflict-resolution`, `tool-request-continuation` | Exactly the #918 §4.1 moments, unchanged — the loop stage *is* the verification that runs there today, with a selection | Keep the loop honest at loop cost |
| `final` | `review` only | After the review agent returns `success`, at the approved head, before any publication effect is enqueued (§8) | Prove the whole required set passes on the exact head a dependent will branch from |

Rules:

1. **The final stage is per Issue, not per chain.** Every Issue runs its
   own final stage before its own stack-ready grant. Deferring full
   validation to chain merge is exactly the failure this contract
   exists to prevent: under Gate 2 a dependent branches from an unmerged
   head, so a defect admitted at that head is inherited by every
   downstream Issue before anyone runs the full set.
2. **The final stage never runs before approval.** A final bundle
   produced before the review agent returned `success` would be
   invalidated by any reviewer-requested edit, and re-running after the
   edit is the same work. Running it after approval means it binds to
   the head that was actually approved (§8).
3. **A stage run never spans lanes or heads.** A stage run that would
   observe a head change mid-run ends `unknown` (§6.1) rather than
   producing a bundle whose bindings are ambiguous.
4. **The loop stage never grants anything.** Its evidence routes the
   loop and feeds the next selection; it can never satisfy a final stage
   and can never produce a stack-ready grant (§7, invariant 6).

### 4.2 Loop selection

The loop stage's selection is computed by the runner, deterministically,
as the ordered union of five sets, in required-set order:

1. **Impact-related checks** — the selection port's `"selected"` ids,
   intersected with the required set (§5.2 rule 1).
2. **Always-required checks** — every required-set check the operator
   did **not** list as selectable (§5.3). The default list is empty, so
   by default this is the entire required set.
3. **Regression checks** — this Issue's regression set (§6.3 R2),
   unioned in unconditionally, whether or not the change is "related"
   to them and whether or not they are selectable. A check that failed
   the Issue's last full validation stays in the loop until a final
   stage clears it.
4. **Pinned unproven checks** — this Issue's loop pin set (§6.3 R6),
   unioned in unconditionally on exactly the same terms as the
   regression set. A check a loop run selected and did not prove green —
   because it failed, because it timed out, because a fail-fast stop
   meant it never ran, or because its verdict was lost — stays selected
   until some stage run records a `passed` verdict for it. This step is
   what makes §7 row 3's timeout pin and row 2's failing set
   *enforceable by the selection algorithm* instead of by a prose
   promise: a timed-out selectable check is neither impact-related (the
   adapter may well call it unrelated on the next cycle) nor in the
   regression set (only a **final** stage writes that), so without this
   step it could be selected away on the very next loop.
5. **Requirement-satisfying execution checks** — for every **active
   requirement-layer** check (`req:<hex>`) in the required set, every
   **active execution-layer** check whose command satisfies that slot
   under the shipped `matchesConfiguredVerificationCommand` rule (§4.3),
   unioned in unconditionally. **Retaining a mandatory slot is not the
   same as running it.** A requirement slot is never selectable (§5.3),
   so it is always in the selection — but a slot is an obligation, not a
   process, and it is discharged only by the execution check that
   actually runs the command. If `session.verification.test` is
   `npm test`, the operator lists `test` as selectable, and the Issue
   requires `npm test`, then without this step a selection could drop
   `exec:test` while keeping `req:<hex>`, and §4.3's satisfaction test
   would read the requirement as passed on work this stage run never
   performed. This step closes that gap by construction: the check that
   discharges a mandatory requirement is selected whenever the
   requirement is.

Steps 3, 4 and 5 are **floors the port cannot reach.** §5.2 rule 2's
narrowing applies to step 1 only; no adapter answer, and no `selectable`
list, removes a regression id, a pinned id, or an execution id that step
5 pulled in. `selectable` says which checks may be skipped as
*unrelated* to a change; it is never a licence to report an
Issue-mandated requirement as satisfied by a check that did not run, so
where the two collide the requirement wins — the Issue's demand and the
operator's plan are the same authority (§3.4), and only one reading of
it is sound. Steps 3 and 4 hold check ids only and are intersected with
the current required set at selection time, so a check a plan revision
retired leaves the selection with it; step 5 is computed over the
required set itself and retires with it on the same revision. None of
the three can push the selection past a full required run — that
degenerate case is exactly the safe fallback below.

**Unknown impact falls back to full required validation.** When the port
is absent, refuses, errors, exceeds its budget, returns a malformed
response, names an id outside the request, or returns `"unknown"`, step
1 contributes the **entire required set**. There is no partial fallback
and no "best effort" subset: unknown impact is never a reason to run
less.

The selection is recorded in the bundle along with a `selectionDigest`
over the ordered selected ids, so a later consumer can tell exactly what
was and was not run (§6.2).

### 4.3 Final selection

The final stage's selection is **the entire required set**, always. No
impact filter, no selectable list, no adapter consultation — the port is
not invoked in the final stage at all (§5.2 rule 5). A final stage run
whose selection is anything less than the full required set is by
definition a partial bundle and cannot grant (§6.2 rule 4).

**Requirement satisfaction is bound to the run's evidence, not to the
plan's shape.** Requirement-layer slots are judged through the shipped
`buildEffectiveRequirementStatus` / `buildIssueVerificationStatus` path,
over the same evidence sources (#1040 binding, operator-attested manual
evidence) and the same `matchesConfiguredVerificationCommand` matching
rule — consumed verbatim, never forked, never reimplemented. What a
stage changes is that call's **input**, not the call:

- The shipped call answers over the plan's whole **active** execution
  layer. That is a statement about what the plan is *configured* to run,
  which is the right answer to the plan-level question and the wrong
  answer to a stage's question: an active slot can be one this stage run
  never selected (§4.2), or selected and failed, timed out, or skipped.
  Consuming it unchanged over the resolved plan would let a mandatory
  requirement read `passed` on a check that produced no passing verdict.
- A stage therefore derives a `req:<hex>` check's verdict from the same
  function applied to a **proven projection** of the plan: the resolved
  plan with its execution layer narrowed to exactly the execution slots
  *this stage run recorded a `passed` verdict for*. Nothing else about
  the plan changes — retired slots stay retired, requirement bytes stay
  the slot's current bytes, and the matching rule is untouched. Manual
  evidence is admitted unchanged under #1040 binding, because an
  operator attestation is already a statement about a run that happened.

Two consequences, both intended:

- A requirement whose satisfying execution check failed, timed out, was
  skipped by a fail-fast stop, or lost its verdict is `not_run` for that
  stage — never `passed`. Together with §4.2 step 5, which guarantees
  the satisfying check was *selected*, the only way a requirement reads
  `not_run` is that the work genuinely did not pass in this run.
  **`not_run` is not the same as unexplained.** When the satisfying
  check ran and recorded `failed` or `timed-out`, the requirement's
  absence is an accounted absence — `requirement-unproven` (§6.1) — and
  contributes nothing to the stage outcome, so a failing required
  command routes to the repair path exactly as the failing execution
  check does, and never to the operator handoff an `unknown` stage would
  get (§7 rule 9).
- The plan-level question keeps its shipped plan-level answer. `admin
  task-verification show` (#1042), the #1044 amendment comment, and
  every other shipped consumer keep calling
  `buildEffectiveRequirementStatus` over the resolved plan and keep
  reporting "this requirement is covered by the configured plan". A
  stage bundle answers a different question — "did it pass in *this
  run*?" — and the two are reported side by side, never merged (§10
  rule 6).

A requirement slot that is `not_run` at the end of a final stage makes
the bundle incomplete — it does not make it passed.

### 4.4 Satisfying a final stage without re-execution

A final stage is satisfied without launching anything **iff** a bundle
exists that is all of:

- a bundle whose `stageRunId.stage` is **`final`** (§6.2). **A `loop`
  bundle never satisfies a final stage**, however complete, however
  full, however its digests compare — §4.1 rule 4 and §7 invariant 6
  admit no exception, and a full loop selection does not become final
  evidence by being full;
- **produced after the review approval this publication rests on** —
  which for a `final` bundle follows from §4.1 rule 2 together with the
  same-task-attempt and same-head conditions below, since a final stage
  is only ever launched after the review agent returned `success` at
  that head;
- from the **same task attempt and the same lane** as the final stage
  would run in;
- **complete** (§2) and `passed`;
- bound to the **same `planDigest`** as the currently resolved plan;
- bound to the **same head SHA** as the head being published;
- not marked partial or interrupted.

This is same-lane, same-head, same-plan reuse only. It does not reopen
#918 §12.4's rejected cross-lane reuse: an implementation-lane bundle
never satisfies a review-lane final stage, however its digests compare.
Nor is it a cross-stage reuse: the reused bundle must itself be a final
stage's own bundle, so the only thing §8 step 4 can skip is a repeat of
work a final stage already did at this head after this approval.

## 5. The selection port

### 5.1 The port

Language-neutral, one call, no state:

```ts
type StageId = "loop" | "final";

interface StageSelectionRequest {
  readonly stage: StageId;                  // always "loop"; see rule 5
  /** Every check id in the required set, in plan order. Opaque to the adapter. */
  readonly checkIds: readonly string[];
  readonly change: {
    /** Repository-relative paths, verbatim from the provider diff. Opaque to core. */
    readonly paths: readonly string[];
    readonly baseRef?: string;
    readonly headRef?: string;
  };
}

type StageSelectionResponse =
  | { readonly kind: "selected"; readonly checkIds: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };
```

`reason` is bounded, operator-facing text. It is recorded in the bundle
and never parsed for control flow.

### 5.2 Rules

1. **Subset or nothing.** A `"selected"` response naming any id absent
   from `request.checkIds` makes the **whole response** `"unknown"`. The
   runner never intersects silently and never accepts a partially valid
   answer; a confused adapter falls back to full validation.
2. **Narrowing only.** The response is a proposal about *relatedness*.
   The runner unions it with the always-required set, the regression set
   and the loop pin set (§4.2) before executing. An adapter cannot shrink
   the loop below what the operator and the Issue's own history demand.
3. **Never authorization.** The port cannot introduce a command,
   rewrite a command's bytes, change a slot's state, or affect any
   grant, tier, or approval. Every check it can name was already
   authorized by `session.verification`, the Issue-required extractor,
   or an operator amendment. Selection is scope; authorization is
   upstream and untouched.
4. **Never evidence.** The port's output never appears in a verdict,
   never contributes to a stage outcome, and never appears on a public
   surface as a result. It is recorded as an input.
5. **Never consulted in the final stage.** `stage: "final"` is not a
   legal request. The final selection is total by definition (§4.3), so
   there is nothing to ask and no adapter failure mode that could reduce
   it.
6. **Bounded and fail-closed-to-full.** The call runs under an operator
   budget (§5.3). Exceeding it, crashing, or returning unparsable output
   is `"unknown"` — never a stall, never an empty selection.
7. **Out of core.** Core ships no adapter. The absence of an adapter is
   `"unknown"` for every request, which is the safe default (§4.2).

### 5.3 Session policy (additive, opt-in, fail-closed)

`session.verification` is preserved verbatim as `Record<string, string>`
(#918 §12.1). Staged verification lives in a new, optional sibling
block:

```json
{
  "stagedVerification": {
    "enabled": true,
    "selectable": ["test"],
    "selectionTimeoutMs": 30000
  }
}
```

- `enabled` — default `false`. With it absent or `false`, nothing in
  this contract runs and behavior is exactly today's (§10).
- `selectable` — the closed list of `session.verification` **keys** the
  selection port is permitted to narrow away. Default `[]`: with the
  feature enabled but nothing listed, every check is always-required and
  the loop stage runs the full set — enabled, correct, and no faster.
  A name that matches no `session.verification` key refuses the session
  at load, mirroring #918 §5.2's `perCommand` posture.
- `selectionTimeoutMs` — the port's budget; a positive integer,
  defaulting to a small bounded value when absent. Expiry is
  `"unknown"`.

Two membership rules keep the list from widening beyond the operator's
intent:

- A **requirement-layer** slot (`req:<hex>`, an Issue-demanded command)
  is never selectable. The Issue asked for it; an adapter does not get
  to decide it is unrelated. This rule alone retains only the *slot*,
  which is why it is not the whole guard: §4.2 step 5 additionally
  retains the execution checks that discharge it, so an `exec:<name>`
  the operator did list here is selected anyway whenever a requirement
  slot needs it to pass.
- A **task-amendment-added** slot is never selectable. It exists because
  an operator corrected this specific task (#1037 §4); narrowing it away
  would defeat the correction.

Validation is fail-closed at session load: unknown fields, non-integer
or non-positive budgets, and unresolvable `selectable` names refuse the
session.

### 5.4 No sessions.json edit is required per Issue

Routine per-Issue operation touches the session file **never**. The one
operator decision that lives there — `enabled`, `selectable`,
`selectionTimeoutMs` — is a one-time configuration act. Everything that
varies per Issue is task-scoped runner state: the selection, the stage
bundles, the regression set, the loop pin set, the stage ordinals, and
the retention marks. Per-Issue corrections to *what must pass* go through the shipped
task-scoped amendment surface (`admin task-verification`, #1042), which
this contract consumes unchanged and never bypasses.

## 6. Stage outcomes, evidence, and retention

### 6.1 The stage outcome vocabulary (closed)

| Stage outcome | Meaning | Derived from |
| --- | --- | --- |
| `passed` | Every selected check returned a passing verdict | all checks pass |
| `code-failed` | At least one selected check returned a failing verdict about the change | the shipped nonzero-exit path; #918's `code-failure` |
| `timed-out` | At least one selected check exceeded its budget and none failed for another reason | the shipped review deadline (`session.verificationTimeoutMs`, #1090) and #918's `timeout` |
| `interrupted` | The stage run itself did not complete, so at least one selected check has **no verdict at all** through evidence loss or a `cancellation-stop` | cancellation (#608), lock loss, worktree discard, host or process loss mid-run |
| `unknown` | The stage run completed but at least one selected check has **no admissible verdict** through evidence loss | unreadable or unbindable evidence, a head or `planDigest` change observed mid-run, a result the shipped classifier cannot map |
| `infrastructure` | The failure is about the host or the environment, not the change | `classifyVerificationFailure` / `src/core/implementation-verification.ts` (#934) setup-failure classification; #918's `infrastructure` / `sandbox-policy` |

Precedence, first row that matches any selected check wins:
`interrupted` > `unknown` > `infrastructure` > `code-failed` >
`timed-out` > `passed`.

A selected check with no verdict enters that precedence **through its
recorded cause, not through its bare absence.** The `notRunKind` set is
closed (§6.2) and each member maps to exactly one contribution:

| `notRunKind` | When the runner records it | What the absence contributes |
| --- | --- | --- |
| `first-failure-stop` | The execution site stopped at the first failing or expired check and never reached this one — today's `runVerification` returns on the first nonzero exit (`src/handlers/verification.ts`); #918 §6.2 rules 1–2 remove this case under the unified engine, which continues past `code-failure` and `timeout` | **Nothing.** The `failed` or `timed-out` verdict that caused the stop is what decides the row |
| `requirement-unproven` | A `req:<hex>` slot the run did not prove, because the execution check that would satisfy it *ran* and recorded a known non-passing verdict — `failed` or `timed-out` — in this same bundle (§4.3, §6.2 rule 6). The requirement is unsatisfied for a reason the bundle already states at the execution layer | **Nothing.** The satisfying execution check's own `failed` or `timed-out` verdict decides the row |
| `set-budget-exhausted` | #918 §6.2 rule 2: the set deadline kept this check from launching | `timed-out` |
| `infrastructure-stop` | #918 §6.2 rule 3: the substrate broke and the set stopped | `infrastructure` |
| `sandbox-policy-stop` | #918 §6.2 rule 4: a #917 refusal stopped the set | `infrastructure` |
| `cancellation-stop` | #918 §6.2 rule 6: an operator cancelled (#608) | `interrupted` |
| `evidence-lost` | Any absence with no cause above: the run ended before reaching this check for no recorded reason, or its verdict is unreadable or unbindable | `interrupted` if the stage run did not complete, otherwise `unknown` |

Four rules keep the vocabulary honest:

- **`timed-out` is a verdict about a check; `interrupted` is the absence
  of a verdict about the stage.** A bounded check that overran its
  budget produced information (it did not finish in the budget the
  operator set); an interrupted stage produced none. A check the *set*
  deadline kept from launching is the one accounted absence that still
  reads `timed-out`: what ran out is the budget the operator set, which
  is information about the run, not a verdict that went missing.
- **`unknown` is never `passed`.** A missing, unreadable, or unbindable
  verdict is treated as the strongest available claim's *absence*, not
  as a pass, everywhere in §7.
- **Infrastructure never masquerades as code.** An `infrastructure`
  stage never reaches an agent as fix input and never consumes a repair
  cycle — the shipped #934 split, restated, not redefined.
- **An accounted absence is not evidence loss.** A fail-fast skip is the
  ordinary shape of a failing suite today, not a broken run: an ordinary
  `code-failed` stage whose remaining checks were never reached must
  route to the repair path, never to the interruption or `unknown`
  handling that would restart the stage forever or park it for an
  operator. Two guards keep the distinction from becoming a hole.
  **Fail closed on the cause:** an unrecognized or missing `notRunKind`
  is `evidence-lost`, and `first-failure-stop` is admissible only when
  the same stage run carries at least one `failed` or `timed-out`
  verdict — a run that skipped checks with nothing to blame lost
  evidence and says so. `requirement-unproven` is admissible only on a
  `req:<hex>` check, and only when the execution check that would
  satisfy it carries a `failed` or `timed-out` verdict **in this same
  bundle**; a requirement left unproven by anything else — a satisfying
  verdict that is itself `unknown`, a satisfying check that was never
  selected, a cause nobody recorded — is `evidence-lost`, because at
  that point the run genuinely cannot say why the requirement went
  unproven. **The skip is never a pass:** a skipped check
  carries no verdict, keeps the bundle incomplete (§2), can never
  contribute to a grant, and is pinned for the next cycle (§6.3 R6). The
  table changes which *row* a run routes through, never what it proved.

### 6.2 The stage evidence bundle

One stage run produces one bundle. The shape is normative; persistence
is an implementation slice (§13 S4):

```ts
interface StageRunResult {
  stageRunId: {
    taskAttempt: number;
    lane: VerificationLane;       // #918 §2
    stage: StageId;
    stageOrdinal: number;
  };
  planDigest: string;             // #1039 EffectiveVerificationPlan.planDigest
  headSha?: string;               // the head the stage ran against
  selection: {
    checkIds: readonly string[];  // ordered, as executed
    selectionDigest: string;      // sha256 over the ordered ids
    /** True iff `checkIds` equals the full required set. */
    full: boolean;
    source: "port" | "port-unknown-fallback" | "no-adapter" | "final-total";
    portReason?: string;          // bounded; recorded, never parsed
  };
  outcome: StageOutcome;
  /** False when any selected check lacks a terminal verdict. */
  complete: boolean;
  checks: readonly {
    checkId: string;
    verdict: "passed" | "failed" | "timed-out" | "not-run" | "unknown";
    exitCode?: number;
    /**
     * Required when verdict is "not-run": the recorded cause, which
     * decides what the absence contributes to `outcome` (§6.1). Closed
     * set; absent or unrecognized reads as "evidence-lost".
     */
    notRunKind?:
      | "first-failure-stop"
      | "requirement-unproven"
      | "set-budget-exhausted"
      | "infrastructure-stop"
      | "sandbox-policy-stop"
      | "cancellation-stop"
      | "evidence-lost";
    notRunReason?: string;         // bounded operator text; never parsed
    outputTail?: string;          // bounded, failures only
    logArtifact?: string;         // run-artifact-relative path
    durationMs?: number;
  }[];
}
```

Rules:

1. **A bundle records its own scope.** `selection.full` and
   `selectionDigest` are what make partial evidence recognizable as
   partial. No consumer may infer completeness from an outcome alone.
2. **Evidence binds to identities, not to time.** A bundle is evidence
   only for its `planDigest`, its `headSha`, and its `selectionDigest`.
   A plan revision, a new commit, or a changed required set makes it a
   historical artifact. This is #918 §8.2 rule 3 and #1037 §8's
   invalidation discipline, consumed unchanged.
3. **Complete, not first-failure.** Every selected check appears, passed
   and failed alike, so one escalation surfaces one set (#918 §8.2 rule
   1). Where the shipped sites still stop at the first failure, the
   bundle records the remainder as `not-run` with
   `notRunKind: "first-failure-stop"` rather than pretending they
   passed — an accounted absence, which §6.1 keeps out of the
   `interrupted` and `unknown` rows so the run still routes by the
   failure that stopped it (§7 rule 8). Such a bundle is nonetheless
   **incomplete**: it is the failing set's evidence, never a grant's.
   Closing the gap at the source — executing every selected check and
   reporting one full set — is #918 §6.2 rules 1–2's job when the
   unified engine lands, and nothing here depends on the shipped
   fail-fast behavior changing first.
4. **A partial bundle is permanently inadmissible.** `complete: false`
   — including every `interrupted` run — can never satisfy a final
   stage, can never contribute to a grant, and is never resumed: the
   next final stage starts from the beginning. It is retained for the
   operator and for audit.
5. **Agent and adapter statements are inert.** Only a runner-produced
   bundle is evidence, for routing, for satisfaction, and for every
   public summary (#918 §3 rule 4, restated for stages).
6. **A requirement check's verdict comes from evidence, not from the
   plan.** A `req:<hex>` entry in `checks` is `passed` only when §4.3's
   proven projection makes it so — an execution check *this run*
   recorded `passed` for satisfies it, or admissible manual evidence
   does. Otherwise it is `not-run`, and its `notRunKind` states what
   this same bundle already says about the execution check that would
   have satisfied it, in this order: **`requirement-unproven` when that
   check ran and recorded a known non-passing verdict** (`failed` or
   `timed-out`); **that check's own `notRunKind` when it too is
   `not-run`**; and **`evidence-lost` when no such cause was recorded.**
   The first case is what keeps an ordinary red build routing by its
   failure: an Issue that requires `npm test` is unsatisfied precisely
   *because* the matching execution check failed or expired, which the
   bundle states at the execution layer, so the requirement's absence
   adds nothing to the §6.1 precedence and the stage stays `code-failed`
   or `timed-out` instead of becoming `unknown` and parking for an
   operator (§7 rule 9). The requirement layer is thus never the place
   where a bundle claims more than the execution layer proved — nor the
   place where it invents evidence loss the execution layer did not
   report — and a mandatory requirement can never be the one check in a
   `passed` bundle that nothing ran.

### 6.3 Mandatory retention (runner-owned)

Retention is the runner's obligation, not the project's option:

- **R1 — the granting bundle.** The complete, `passed` final bundle that
  produced a live stack-ready grant is retained until the Issue's task
  reaches a terminal state. The grant is only auditable while the
  evidence behind it exists, and Gate 2 lets dependents branch on that
  grant before the blocker merges.
- **R2 — the regression set.** The failing, timed-out, and `unknown`
  check ids of the most recent non-passing final stage run are retained
  as the Issue's regression set and unioned into every later loop
  selection (§4.2 rule 3). Cleared only by a complete, `passed` final
  stage.
- **R3 — loop bundles.** Retained per #918 §8.2 rule 4's per-escalation
  consumption: the next loop bundle in the same lane supersedes the
  previous one. Only check *ids* survive into the next selection, never
  output bytes.
- **R4 — partial bundles.** Retained for the operator, marked, and never
  promoted to admissible by any later act.
- **R5 — retention is a floor.** `docs/retention-backup-contract.md`
  owns pruning; a pruning policy must not delete an R1 bundle while its
  grant is live. This adds no store, no table, and no new pruning
  surface.
- **R6 — the loop pin set.** Every check id a **loop** stage run selected
  and did not record a `passed` verdict for — `failed`, `timed-out`,
  `unknown`, or absent through an accounted absence or evidence loss
  alike — is retained as the Issue's loop pin set and unioned into every
  later loop selection (§4.2 step 4). R3 supersedes the previous loop
  *bundle*; R6 is the one piece of loop state that deliberately does not
  get superseded, because a check whose evidence was just discarded is
  exactly the check that must still run. It is an id list beside R2, not
  a store of its own (§9). Its lifetime is fixed, not configurable:
  - **Scope: the Issue, not the lane and not the stage run.** A pin
    survives a requeue, a repair cycle, a lane change, a fresh task
    attempt, an interruption, and any number of intervening loop runs.
    Scoping a pin to one run or one lane is precisely what would let the
    following cycle select the check away.
  - **An id leaves the set only by being proven green:** a later loop or
    final stage run that records a `passed` verdict for that id drops
    that id, and nothing else does — no timer, no cycle count, no
    operator value, no adapter answer.
  - **The whole set clears with R2:** a complete, `passed` final stage
    (§7 row 7) empties it, since at that point every required check
    passed at the published head and nothing is unproven. An id that a
    plan revision dropped from the required set also leaves, by the §4.2
    intersection.
  - **Ids only, never output bytes**, exactly as R3.
  - The set is a subset of the required set, so its worst case is a full
    loop run — the same safe degenerate case as unknown impact (§4.2).

Nothing an adapter returns, and nothing a project configures, can shorten
R1, R2 or R6.

## 7. The state-transition table (normative)

Stage run outcome → what the runner does. **No new phase-runner
vocabulary exists**: no new `PhaseRunOutcome` member, no new
`PhaseHandlerResult` member, no new `TaskStatus`, and no change to
`nextPhaseAfter`'s transition set. Every cell routes through vocabulary
that ships today.

| # | Stage | Outcome | Runner action and next state | Evidence and retention | Stack-ready |
| --- | --- | --- | --- | --- | --- |
| 1 | `loop` | `passed` | The lane's shipped success path continues: implementation proceeds to commit/push/PR, review proceeds to the review agent, conflict resolution proceeds to the merge commit | Loop bundle retained per R3; regression set unchanged | **Not granted.** Loop evidence never grants |
| 2 | `loop` | `code-failed` | The shipped #934 route: bounded inline repair, then requeue the same task at `implementation` while `verificationRepairCycles` is under `DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES`; at the cap, the existing human handoff. The whole failing set is one fix input | Failing ids recorded on the run; every selected check this run did not prove green — the failing ids and any `first-failure-stop` skips alike — joins the loop pin set (R6); regression set unchanged (only a **final** stage writes it) | **Not granted.** Any live marker is cleared by the shipped implementation-success path |
| 3 | `loop` | `timed-out` | Routed exactly as row 2 — a timeout is code-side (#918 §7) — under the same cap. Never auto-retried to green | Timed-out ids join this Issue's loop pin set (R6) and are unioned into **every** later loop selection by §4.2 step 4 until a stage run proves them green: an expired check is never "unrelated" on a following cycle, and no adapter answer and no `selectable` list can select it away | Not granted |
| 4 | `loop` | `interrupted` | **No transition is derived.** The task returns to its pre-stage status; the next claim re-runs the stage from the beginning. No repair cycle is consumed, no agent is invoked, no fix input is produced | Partial bundle retained per R4, `complete: false`, inadmissible; the selected ids it did not prove green join the loop pin set (R6) | Not granted |
| 5 | `loop` | `unknown` | Re-run the stage **once** in the same lane with the full required set (`source: "port-unknown-fallback"` is already the fallback for port failure; this covers evidence failure). If the re-run is also `unknown`, park for the operator via the lane's existing human handoff, naming the checks with no admissible verdict | Both bundles retained; no verdict is inferred | Not granted |
| 6 | `loop` | `infrastructure` | The shipped #934 host-failure route: delayed retry, no agent invocation, no repair cycle consumed, no code blame in the fix input | Recorded as an operator-facing fact | Not granted |
| 7 | `final` | `passed` **and** `complete` | Publish the grant in the same transaction that records the bundle (§8) | R1 retention begins; regression set **cleared** | **Granted** |
| 8 | `final` | `passed` **but not** `complete` | Impossible by construction (§6.1 maps every absence to a non-`passed` outcome, and the two absences that contribute nothing — `first-failure-stop` and `requirement-unproven` — are admissible only alongside a failing or expired verdict); if ever observed, treated as **row 12** — an evidence-integrity failure, so the operator handoff, never the code-repair route — and reported as a runner defect | Partial bundle retained | **Withheld** |
| 9 | `final` | `code-failed` | Return to the implementation loop as a code failure — the shipped `needs_fix` requeue — with the **whole** failing set as one fix input, under the existing cap and its existing human handoff at the cap | Failing ids become the Issue's regression set (R2), retained across every later loop | **Withheld**; any live marker cleared |
| 10 | `final` | `timed-out` | Routed as row 9 | Timed-out ids join the regression set | **Withheld**; cleared |
| 11 | `final` | `interrupted` | The final stage is re-run from the beginning on the next claim. Never resumed, never partially credited. No repair cycle consumed | Partial bundle retained per R4, inadmissible | **Withheld**; cleared |
| 12 | `final` | `unknown` | Fail closed: park for the operator through the lane's existing human handoff, naming every check with no admissible verdict. No automatic re-run, because the cause is evidence integrity, not flakiness | Recorded; regression set gains the unknown ids (R2) | **Withheld**; cleared |
| 13 | `final` | `infrastructure` | The shipped host-failure route: delayed retry. No agent invocation, no repair cycle, no code blame | Recorded | **Withheld**; cleared |

Rules the table depends on:

1. **Stack-ready is granted by exactly one cell.** Row 7 — a complete,
   `passed` final bundle bound to the head being published — and nothing
   else. Every other row withholds. There is no partial credit, no
   "enough of the set", and no operator override that substitutes for
   the bundle; an operator who wants to grant anyway corrects the *plan*
   (#1037) and re-runs the stage.
2. **Any non-passing final stage clears a live marker.** A marker can
   only exist because an earlier final stage passed at an earlier head;
   once a later final stage at a later head does not pass, that marker
   describes a base that no longer exists. Clearing reuses the shipped
   `stackReady` removal enqueue, unchanged.
3. **Infrastructure and interruption never consume agent resources.**
   Rows 4, 6, 11 and 13 consume no repair cycle, no review cycle, and no
   fix invocation, and reach no agent prompt. The lane's caps are intact
   when the stage re-runs.
4. **Caps stay lane-owned and unchanged.** `MAX_VERIFICATION_REPAIR_ATTEMPTS`,
   `DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES`, and the review loop's cycle
   cap are existing values. This contract counts against them exactly as
   the shipped loops do and adds no cap of its own.
5. **Stage ordinals advance per launched stage run** regardless of
   outcome, so an interrupted run and its re-run are distinguishable in
   evidence.
6. **A code failure is never laundered.** No heuristic inspects output
   to reclassify a failing check as infrastructure, and no re-run to
   green is performed (#918 §6.3).
7. **Missing evidence is never treated as a code failure.** Row 8's
   defensive case is a runner defect, not a defect in the Issue's code:
   the bundle claims `passed` while some selected check has no terminal
   verdict, so there is no failing set to hand an agent. It routes to
   row 12's operator handoff — not to row 10, and so not to row 9's
   repair route — because sending an empty or invented failing set into
   the fix loop would burn repair cycles on misleading input and hide
   the integrity failure that actually needs an operator.
8. **A fail-fast stop routes by the failure, not by the absence.** Where
   the execution site stops at the first failing or expired check — the
   shipped `runVerification` does, so an ordinary failing suite produces
   a bundle whose remaining checks are all `not-run` — those unreached
   checks are an accounted absence (§6.1). They contribute nothing to the
   precedence, so the run is `code-failed` or `timed-out` and routes
   through rows 2, 3, 9 or 10 — the repair path — and **never** through
   rows 4, 5, 11 or 12. This is what §6.1's accounted-absence table is
   for: letting a bare missing verdict win the precedence would turn
   every red build into an interruption that restarts the stage forever,
   or into an `unknown` that parks it for an operator, instead of handing
   the failing set to the fix loop. The skipped ids stay unproven, never
   passed: in a loop stage they join the pin set (R6) so the next cycle
   runs them, and in a final stage the next final stage runs them because
   a final selection is always total (§4.3).
9. **A failing requirement routes as a failure, not as missing
   evidence.** The same holds one layer up. A `req:<hex>` slot left
   unproven because the execution check that would satisfy it recorded
   `failed` or `timed-out` carries `requirement-unproven` and likewise
   contributes nothing to the precedence (§6.1, §6.2 rule 6), so a
   final stage in which a required command failed is `code-failed` and
   routes through row 9 — the repair route the failure calls for — and
   never through row 12. Without this mapping the identical failing run
   would park for an operator whenever the Issue happened to demand the
   command that failed, and route to repair whenever it did not. The
   requirement stays unproven and the bundle stays incomplete either
   way; what the mapping fixes is only which row the run takes.

## 8. Ordering: review approval, final verification, publication

The ordered sequence for one Issue, with the ordering constraints that
make it correct:

1. **Normal loop.** Implementation and fix runs execute the `loop` stage
   at the shipped moment — after the agent diff and dependency sync,
   **before** commit/push/PR — and route per rows 1–6. A known-broken
   commit is still never pushed.
2. **Review lane loop stage.** The review worktree executes the `loop`
   stage at the shipped moment, before the review agent runs, and routes
   per rows 1–6.
3. **AI review approval.** The review agent returns `success`. Nothing
   about the review agent, its admission preflight (#681), its
   dispute machinery, or its `needs_fix`/`conflict`/`blocked` routes
   changes here.
4. **Final stage.** Only now, in the review worktree, at the approved
   head, the runner executes the `final` stage over the entire required
   set — unless §4.4's same-lane/same-head/same-plan complete **`final`
   stage** bundle from this approval already satisfies it. A `loop`
   bundle, including a full one produced at this same head in step 2
   before approval, never satisfies step 4.
5. **Publication.** On row 7 only, the runner records the final bundle
   and enqueues the stack-ready grant **in the same store transaction**
   — the shipped `TaskStore.completePhaseWithEffects` CAS carrying
   `PhaseCompletionTransition` plus its `OutboxEffect` list. On every
   other row, no grant is enqueued and a live marker is cleared in that
   same transaction.

Four ordering constraints:

- **Approval before final.** Step 4 after step 3, so the bundle binds to
  the head the reviewer approved — the head a dependent will branch
  from under Gate 2.
- **Final before publication.** Step 5 after step 4, never concurrently
  and never speculatively. The grant is an effect *of* the bundle.
- **One transaction.** Evidence and grant commit together or neither
  commits. A crash between them cannot leave a grant whose evidence was
  never persisted, nor evidence whose grant was never published.
- **Head binding at enqueue.** If the branch head moved between the
  final stage and the enqueue, the bundle no longer binds (§6.2 rule 2):
  the grant is not published and the final stage is re-queued. Publishing
  a grant for a head that no longer exists is exactly the failure on
  partial evidence this contract forbids.

Downstream consumption is unchanged: the Gate 2 resolver, the
`github-intake` stack-ready resolver, and the refinement eligibility
trigger all keep keying on the same marker. The marker simply becomes
harder to earn.

## 9. Modules and ports to extend

The chain extends the shipped tree. **No parallel orchestration engine
is introduced**: no second scheduler, no second classifier, no second
evidence model, no second store.

| Concern | Existing module / port (shipped unless noted) | What the chain adds |
| --- | --- | --- |
| Effective plan, check identity, plan digest | `src/core/verification-plan.ts` — `resolveEffectiveVerificationPlan`, `EffectiveVerificationPlan`, `EffectiveVerificationSlot.commandId`, `planDigest`, `buildEffectiveRequirementStatus` | A **pure** `selectStageChecks(plan, stage, selectionInput)` over an already-resolved plan, including §4.2 step 5's requirement closure; and a **proven projection** of the plan — its execution layer narrowed to the checks the stage run proved green — passed into `buildEffectiveRequirementStatus` *unchanged*, so stage-level satisfaction binds to evidence while the shipped plan-level call keeps its shipped meaning for the operator surfaces. No new layer, origin, slot state, or matching rule |
| Revisions and amendments | `src/core/verification-amendment.ts`, `src/core/verification-amend.ts`, `admin task-verification` (#1042) | Nothing. A stage never amends; the regression set is runner state, not a plan revision |
| Evidence binding | `src/core/verification-evidence.ts`, `buildVerificationEvidenceBindingBlock` (#1040) | Stage bundles reuse the same digest/ordinal binding discipline |
| Execution | `src/handlers/verification.ts` `runVerification`; the review lane's deadline loop (`src/handlers/review.ts`, #1090); the conflict-resolution variant | A stage-scoped check map passed into the existing sites. When #918's unified engine lands, the stage becomes an input to its §5.1 set resolution and these adapters retire |
| Failure classification and continuation | `src/core/implementation-verification.ts` (#934), `src/core/review-classifier.ts` `classifyVerificationFailure` | The stage outcome is **derived from** the shipped classifier. No second classifier exists |
| Persistence and mutation | `src/core/task-store.ts` — `TaskStore`, `PhaseCompletionTransition`, `OutboxEffect`, `completePhaseWithEffects` | Stage bundles, the regression set and the loop pin set (§6.3 R2, R6) persisted as additive task-context state under the existing CAS transaction — two id lists beside the bundle, not a second store. No new column, table, or store method |
| Publication | `src/core/outbox-effects.ts` — the `stackReady` add/remove enqueues | The grant gains its §7 row-7 precondition and its §8 same-transaction ordering. Label vocabulary and idempotency keys unchanged |
| Transitions | `src/core/transitions.ts` `nextPhaseAfter` | **Unchanged.** No phase, result, or status is added |
| Review admission | `checkReviewAdmission` (#681) | **Unchanged.** No verification evidence is added to admission (#918 §12.4 stands) |
| Gate 2 consumption | `src/handlers/dependency-plan.ts`, `src/core/github-intake.ts` stack-ready resolver | **Unchanged** |
| Locking | The per-Issue worktree lock and the phase execution lock (#440) | **Unchanged.** The final stage runs inside the lock the review phase already holds (§11) |
| Selection port | *New, small* — one injected function type and its fail-closed wrapper | The only genuinely new seam in the design |

## 10. Compatibility and opt-in

1. **Default off.** With `stagedVerification.enabled` absent or `false`,
   nothing here executes: one full set per lane, stack-ready on review
   success alone, exactly today's behavior and today's artifacts.
2. **Enabled with no `selectable` and no adapter.** Both stages run the
   full required set. The only observable differences are additive:
   stage-tagged bundles, the regression set, the loop pin set, the final
   stage before publication, and the row-7 precondition on the grant.
3. **Session schema.** `session.verification` is untouched. The
   `stagedVerification` block is optional and additive; a session
   without it loads exactly as today. `verificationTimeoutMs` (#1090)
   and the #918 `verificationPolicy` block, when it lands, keep their
   meanings — a stage changes *which* checks run, never how a check is
   bounded.
4. **Artifacts.** Per-check log names are preserved verbatim
   (`verification-<name>.log`, `review-verification-<name>.log`,
   `conflict-resolution-verification-<name>.log`). Stage bundles are new
   files alongside them, never replacements.
5. **Public surfaces.** Stage outcomes reach PR summaries, human-gate
   summaries and ChatOps acknowledgements as **stage, check names,
   verdicts, counts, and the `selection.full` flag only** — never raw
   output, never paths, never command bytes beyond the operator-authored
   name. The redaction posture of
   `docs/environment-prepare-contract.md` §2.7 applies unchanged. The
   `selection.full` flag is deliberately public: an operator reading
   "verification passed" must be able to see whether that was the whole
   set.
6. **Operator surfaces.** `admin task-verification show` gains the stage
   view (current regression set, current loop pin set, last loop bundle,
   last final bundle and its bindings). No new command family is introduced.

## 11. Boundary with project maintenance

Staged verification is a *scheduling and evidence* contract. Heavy test
maintenance remains a separate project operation, outside this chain.
Explicitly excluded, and unimplementable under this contract as written:

- **No automated deletion or restructuring of tests.** Nothing here
  deletes, moves, merges, splits, renames, skips, or quarantines a test,
  a test file, or a check. A check the loop stage does not select is
  *not run this cycle*; it is not disabled, not retired, and not
  weakened. Only an operator, through the shipped amendment surface,
  retires a slot.
- **No mutation-testing engine.** No mutant generation, no mutation
  score, no coverage threshold, no test-quality judgment of any kind.
  "Mutation" in this chain means the shipped **store mutation ports**
  (§9) and nothing else.
- **No periodic audit scheduler.** No cron, no timer, no background
  sweep, no "re-validate every N hours". Every stage run is triggered by
  a phase the runner was already executing.
- **No cross-project concurrency scheduler.** No scheduling across
  repositories, sessions, or hosts; no shared queue; no global
  admission control. Staged verification is per task, in the lane the
  task is already in.
- **No new global lock.** The final stage runs inside the per-Issue
  worktree lock and phase execution lock (#440) the review phase already
  holds. No lock is added, widened, promoted to a global scope, or held
  across phases. Two Issues' final stages are as concurrent as their
  phases already are.
- **No flake detection, rerun-to-green, or quarantine.** A failing check
  is a fact; the loop sees it (#918 §6.3).

## 12. Invariants

1. The stage set (`"loop"` | `"final"`) and the stage-outcome set are
   closed; widening either is a change to this document first (§2).
2. Core is language-, framework-, filename- and layout-neutral: paths
   are opaque, no test-runner output is parsed, and no default adapter
   ships (§3.3).
3. Selection is scope, never authorization. Every check a stage can run
   was already authorized upstream; no adapter output adds, rewrites, or
   permits a command (§5.2 rule 3).
4. The adapter narrows and never widens: a response naming an unknown id
   is wholly `"unknown"`, and the runner always unions in the
   always-required set, the regression set and the loop pin set (§5.2
   rules 1–2, §4.2).
5. Unknown impact runs the **full** required set. Absence, refusal,
   timeout, malformed output, and explicit `"unknown"` all fall back to
   full validation; none of them ever runs less (§4.2).
6. The loop stage never grants and never satisfies a final stage; the
   final stage runs the entire required set, per Issue, before the
   stack-ready grant (§4.1 rules 1 and 4, §4.3).
7. Stack-ready is granted only by table row 7: a **complete**, `passed`
   final bundle bound to the current `planDigest` and to the head being
   published, enqueued in the same transaction that records it. Partial,
   stale, unbound, interrupted, and `unknown` evidence never grants
   (§7 rule 1, §8).
8. Any non-passing final stage clears a live stack-ready marker (§7
   rule 2).
9. A bundle records its own completeness; no consumer infers scope from
   an outcome (§6.2 rule 1).
10. `unknown` is never treated as `passed`, and `interrupted` is never
    resumed or partially credited (§6.1, §6.2 rule 4).
11. Infrastructure and interruption never reach an agent as fix input
    and never consume a repair cycle, a review cycle, or a fix
    invocation (§7 rule 3).
12. Retention of the granting bundle, of the regression set, and of the
    loop pin set is runner-owned and mandatory; no project configuration
    or adapter output can shorten it (§6.3). A pinned check leaves the
    selection only by being proven green.
13. No new phase-runner vocabulary, no change to `nextPhaseAfter` or
    `checkReviewAdmission`, no new store, table, column, scheduler, or
    lock (§7, §9, §11).
14. Routine per-Issue operation requires no `sessions.json` edit; the
    only session-level act is the one-time opt-in (§5.4).
15. Default-off: an un-opted-in session behaves exactly as today (§10
    rule 1).
16. An accounted absence is never evidence loss and never a pass. A
    fail-fast stop routes by the failure that caused it, so an ordinary
    failing suite reaches the repair path and never the interruption or
    `unknown` rows; an absence with no recorded cause is `interrupted` or
    `unknown`. Either way the check is unproven, the bundle is
    incomplete, and the id is pinned (§6.1, §6.2 rule 3, §7 rule 8,
    §6.3 R6).
17. A mandatory requirement is never reported as passed without the
    evidence of a check that ran. Selection retains the execution checks
    that discharge every active requirement slot (§4.2 step 5), and a
    stage judges satisfaction over the run's **proven** execution
    evidence rather than over the plan's configured execution layer
    (§4.3, §6.2 rule 6). Retaining a requirement slot is not executing
    it, and this design never lets the first stand in for the second.
    Symmetrically, a requirement left unproven by a satisfying check
    that failed or expired is an accounted absence
    (`requirement-unproven`), not evidence loss, so a failing required
    command routes by its failure and not to the operator handoff
    (§6.1, §7 rule 9).

## 13. Implementation decomposition proposal

Twelve implementation/validation slices for the chain's later issues —
the tracker, not this document, assigns numbers. Each is
separately mergeable and each preserves default-off behavior until S10.

| Slice | Content | Depends on |
| --- | --- | --- |
| S1 | Pure stage model core module: `StageId`, the stage-outcome vocabulary and precedence, the `StageRunResult` shape, and `selectStageChecks` over an `EffectiveVerificationPlan` — including §4.2 step 5's requirement closure, which reuses `matchesConfiguredVerificationCommand` verbatim. No execution, no I/O | — |
| S2 | `stagedVerification` session schema and fail-closed load validation (`enabled`, `selectable`, `selectionTimeoutMs`), including the requirement-layer and amendment-added non-selectability rules | S1 |
| S3 | Stage-scoped execution input at the three shipped sites: `runVerification`, the review deadline loop, the conflict-resolution variant, including recording the fail-fast remainder as `not-run` with `notRunKind: "first-failure-stop"` (§6.1) rather than leaving it unexplained. Byte-equivalent when the selection is the full set | S1 |
| S4 | Stage bundle persistence and artifacts through `TaskStore.completePhaseWithEffects` under the existing CAS; bundle bindings and the completeness flag; §4.3's proven projection and the §6.2 rule 6 derivation of `req:<hex>` verdicts from it — including the `requirement-unproven` accounted absence for a requirement whose satisfying check failed or expired — with the shipped plan-level `buildEffectiveRequirementStatus` consumers asserted unchanged | S1, S3 |
| S5 | Regression-set (R2) and loop-pin-set (R6) tracking and their union into loop selection, including the pin lifetime — pinned on any non-green loop verdict, dropped only on a later `passed`, cleared with R2 on a passing final stage; retention floors R1/R3/R4 and their interaction with the pruning policy | S4 |
| S6 | The selection port: injected function type, bounded invocation, and the total fail-closed-to-full wrapper covering absence, refusal, timeout, malformed output, and out-of-request ids | S1, S2 |
| S7 | Loop stage wiring in the implementation lane, deriving rows 1–6 from the shipped #934 classifier; flag-gated | S3, S4, S6 |
| S8 | Loop stage wiring in the review, conflict-resolution, and tool-request-continuation lanes; flag-gated | S7 |
| S9 | Final stage execution at the approved head, §4.4 satisfaction, and rows 7–13 | S8 |
| S10 | The publication gate: row-7 precondition, §8 same-transaction ordering and head binding in `src/core/outbox-effects.ts`; Gate 2 consumption asserted unchanged. **This slice is where behavior changes for an opted-in session** | S9 |
| S11 | Operator surface and observability: the `admin task-verification` stage view, stage events, and the bounded public summary including `selection.full` | S10 |
| S12 | The first project integration: a TypeScript/Jest selection adapter for this repository, delivered outside core, plus end-to-end validation that an enabled session with a real adapter narrows the loop and still grants only on a complete final stage | S10 |

**Reviewed against the chain's later design Issues, and still twelve.**
`docs/project-verification-contract.md` (#1095) and
`docs/verification-evidence-validity-contract.md` (#1096) each add
content to some of these slices and **neither adds a slice**; their own
§13 and §9 record which slice gains what. A design Issue that needed a
thirteenth slice would be changing this table, and therefore this
document, first.

## 14. Test seams and matrix

For the implementation slices that build against this contract — the
docs pin is the only test landing with #1094 itself:

| Area | Cases |
| --- | --- |
| Selection (§4.2, §4.3) | Loop selection is the ordered union of port ids, always-required, regression and pinned ids; a check absent from `selectable` is never omitted; a regression id is selected even when unrelated and even when selectable; a check that timed out, failed, or was fail-fast-skipped in the previous loop is selected on the next one even when the port calls it unrelated and the operator lists it selectable; a pinned id retired by a plan revision leaves the selection; an `exec:<name>` the operator listed as selectable, and the port called unrelated, is selected anyway when an active `req:<hex>` slot matches its command; retiring that requirement slot releases it; final selection is always the full required set; `selectionDigest` changes with membership and not with resolution order |
| Port (§5) | Out-of-request id → whole response `"unknown"` → full set; absent adapter, refusal, crash, timeout, malformed output each → full set; the port is never invoked with `stage: "final"`; adapter output never appears in a verdict; `selectable` naming an unknown key refuses the session; requirement-layer and amendment-added slots are refused as selectable |
| Outcomes (§6.1) | The precedence order; `timed-out` vs `interrupted` discrimination; `unknown` never aggregates to `passed`; the infrastructure mapping is the shipped `classifyVerificationFailure` result, not a second classifier; each `notRunKind` contributes exactly its table row — a `first-failure-stop` run with one failing check is `code-failed`, not `interrupted` or `unknown`; a `first-failure-stop` with no failing or expired verdict in the run is `evidence-lost`; an absent or unrecognized `notRunKind` is `evidence-lost`; a `requirement-unproven` slot alongside its `failed` satisfying check is `code-failed` and alongside its `timed-out` satisfying check is `timed-out`, never `unknown`; a `requirement-unproven` on a check that is not `req:<hex>`, or whose satisfying check carries no `failed` or `timed-out` verdict in the same bundle, is `evidence-lost` |
| Evidence (§6.2) | `complete` false whenever a selected check lacks a terminal verdict, accounted absences included; a fail-fast bundle is incomplete and never grants; a partial bundle never satisfies a final stage; bindings invalidate on `planDigest`, head, or required-set change; every selected check present in the bundle; a `req:<hex>` check is `passed` only when the proven projection admits it — an active-but-failed, active-but-timed-out, active-but-fail-fast-skipped, or active-but-unselected execution slot leaves the requirement `not-run`, where the shipped plan-level `buildEffectiveRequirementStatus` call over the same plan would report it `passed`; the derived `notRunKind` is `requirement-unproven` for the failed and the timed-out satisfier, the skipped satisfier's own `first-failure-stop` for the fail-fast one, and `evidence-lost` for the unselected one and for a satisfier whose own verdict is `unknown`; admissible #1040 manual evidence still satisfies it; the shipped plan-level consumers keep the shipped answer |
| Retention (§6.3) | R1 survives until the task is terminal; R2 survives every loop and clears only on a complete passing final stage; R6 survives a requeue, a repair cycle, a lane change and a new task attempt, drops an id only when a later run records `passed` for it, and clears with R2; a pruning policy cannot delete a live R1 bundle; no adapter or project value shortens any of them |
| Transitions (§7) | Every one of the 13 rows, notably: row 4 consumes no repair cycle and derives no transition; row 5's single full re-run then operator park; row 7 is the only granting cell; row 8 routes to row 12's operator handoff and consumes no repair cycle; a fail-fast `code-failed` loop run routes to row 2 and a fail-fast `code-failed` final run to row 9, never to rows 4, 5, 11 or 12; a final run whose failing or expired check is also the satisfier of an active `req:<hex>` slot routes to row 9 or row 10, never to row 12; rows 9–13 each clear a live marker; rows 6 and 13 reach no agent prompt; caps counted exactly as the shipped loops count them |
| Ordering (§8) | Final runs after review `success` and before any publication effect; grant and bundle commit in one transaction; a head change between stage and enqueue suppresses the grant and re-queues the stage; §4.4 satisfaction accepts only same-lane/same-head/same-plan complete **final-stage** bundles and rejects both an implementation-lane bundle and a `loop` bundle, including a full passing review-lane `loop` bundle at the approved head |
| Compatibility (§10) | Flag-off byte-equivalence at the three shipped sites; log-file names preserved; `nextPhaseAfter`, `checkReviewAdmission`, and the Gate 2 resolver unchanged; public summaries carry no output bytes or paths and do carry `selection.full` |
| Docs pin | `test/docs-staged-verification-contract.test.js` pins this document's status line, chain position and no-runtime-behavior claim, the deferrals to the fixed predecessor contracts, the closed stage and stage-outcome sets, the three-owner split and the core-may-never-know list, the two stages with the per-Issue final rule and the approval-before-final rule, the five-set loop-selection union with its pinned-unproven-checks and requirement-closure floors and the unknown-impact-runs-full rule, the evidence-bound requirement satisfaction that keeps a retained mandatory slot from reading passed without a run, the accounted-absence table with the fail-fast and failing-requirement routing rules, the port's narrowing-only/never-authorization/never-final rules, the additive default-off session block, the bundle completeness and inadmissibility rules, the mandatory retention floors, the 13-row transition table with its single granting cell, the publication ordering and its one-transaction rule, the modules-to-extend table, the §11 exclusions (no test deletion or restructuring, no mutation-testing engine, no periodic audit scheduler, no cross-project scheduler, no new global lock), the invariants, and the reconciliation notes in `docs/verification-execution-contract.md` §16, `docs/verification-amendment-contract.md` §17, `docs/phase-contracts.md` (Gate 2), `docs/feature-status.md`, and `docs/DOMAIN.md` §5 where present — against drift |

## 15. Non-goals and forward pointers

This document defines the staged verification lifecycle and its
ownership only. It does not define, and nothing implementing it should
assume:

- **The detailed project-adapter contract and the first TypeScript/Jest
  integration** — how an adapter is discovered, packaged, invoked,
  versioned, and validated; what a real impact analysis computes. §5
  fixes the port's *semantics and safety properties*; the rest belongs
  to the chain's remaining design Issues and slice S12.
  **Delivered (#1095)**: `docs/project-verification-contract.md` — the
  project verification configuration and adapter contract: a single
  repository-owned, non-authorizing configuration file whose entire
  vocabulary is a project pin and a result-adapter id, two independently
  optional adapters (selection and result) with one transport and one
  version rule, stable check-and-case identity in which the check is the
  verification unit and an opaque command is a complete one, runner-owned
  execution metadata and duration, and a six-kind structured result
  envelope that makes unknown and partial explicit and can never be a
  verdict. It supplies the **effective selectable set** §4.2 step 2
  consumes — computed by subtraction only, always a subset of the
  operator's `selectable` list — and adds no sixth source to §4.2's
  union, no stage, no outcome, no verdict, no transition row and no
  grant path. §5.1's request and response bodies are consumed verbatim;
  only the transport around them is new. The one membership class it
  adds, the operator-owned `final-only`, is still reached by every floor
  in §4.2 steps 3, 4 and 5, and it filters step 1's `"selected"`
  proposal only: §4.2's unknown-impact fallback is untouched and still
  contributes the entire required set, `final-only` checks included.
- **Evidence, observability, and operator-surface detail beyond §6 and
  §10 rule 6** — the exact artifact layout, event payloads, CLI output
  shapes, and audit reporting belong to the chain's remaining design
  Issues and slices S4 and S11.
  **Delivered (#1096)**: `docs/verification-evidence-validity-contract.md`
  — the verification evidence validity, pinned regressions and recovery
  contract, and the chain's third and last design Issue. It answers the
  durability half of §6: a **closed seven-component evidence identity**
  whose components are three-valued, in which `unknown` matches nothing
  — including another `unknown` — while a `none` from an unconfigured
  source matches `none`, so an unresolvable identity invalidates
  conservatively instead of comparing equal by accident. §6.2 rule 2's
  "evidence binds to identities, not to time" keeps its meaning and
  gains five more identities: the working-tree state a `loop` stage
  needs because it runs on an uncommitted diff, #1037 §6.4's session
  baseline because a plan-neutral drift provably leaves `planDigest`
  byte-identical, the applied selection policy, and a **declared**
  preparation and platform identity that core never sniffs. An
  unresolvable component makes the stage run `unknown` — this §6.1
  member, routed through these rows 5 and 12 — and costs no execution,
  because identity resolves before launch. It gives R2 and R6 a record
  and a lifecycle without changing their membership: a single check's
  pass buys only its removal from the loop's carried-forward selection,
  a regression pin's only evidential release is the same complete,
  valid, full-set final pass that grants, an id that leaves the required
  set goes **dormant** rather than silently released, and one audited
  operator release exists that releases a pin and never a check. It
  bounds the non-code re-runs rows 4, 5, 11 and 13 leave uncounted with
  a consecutive per-Issue per-stage budget that never touches a repair
  cap and never extends a bound this document set, and it adds no stage,
  outcome, verdict, selection source, transition row, grant path or
  slice — §13's twelve stand, and §9's module table is unchanged.
- **The unified verification engine itself** — `docs/verification-execution-contract.md`
  (#918) owns it and it remains unimplemented. This contract is
  deliberately engine-agnostic: it works over the three shipped
  execution sites today and over #918's engine when it lands, and it
  adds nothing to #918's lane, classification, or cycle-outcome sets.
- **Any change to review admission, the review agent, or the dispute
  machinery** — #681 and `docs/review-dispute-contract.md` stand
  unchanged; the final stage runs after their verdict, never instead of
  it.
- **Chain-level verification** — a chain-merge gate, a cross-Issue
  aggregate bundle, or any "the whole stack passed" artifact. The unit
  of final verification is one Issue, deliberately (§4.1 rule 1).
- **Flake detection, rerun-to-green, quarantine, coverage thresholds, or
  test-suite quality metrics** — §11, and #918 §6.3 and §16.
- **External CI integration** — GitHub checks, external runners, and
  status-based grants are out of scope; verification is the runner's own
  execution.
- **Any change to `session.verification`, the amendment surface grammar,
  the ChatOps verb table, the label vocabulary, or the session schema
  beyond §5.3's additive block** — governed by their own contracts.
