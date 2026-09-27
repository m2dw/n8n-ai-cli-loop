# Verification evidence validity, pinned regressions and recovery contract

Status: **approved design; §9's S2 session fields
(`maxStageRecoveryAttempts`, `environmentIdentity`) and S4's persisted
identity, ordinal allocation and legacy-evidence rules are implemented,
and no stage run resolves an identity yet** (issues #1096, #1097,
#1099). This
document is the authoritative contract for the **durability** half of
staged verification: what identity a stage evidence bundle is bound to,
when that evidence stops being usable, how a failing check stays pinned
to its Issue until something actually discharges it, and what happens
when a run crashes, is amended underneath, loses the check it pinned, or
has to be recovered by an operator. It fixes the closed identity tuple
and its three-valued components, the conservative matching law for
unknown identity, the attribution rules that keep a whole-command
timeout and a broken host from being reported as code failures, the pin
record with its release table and its single audited operator release,
the idempotency and bounded-retry rules for interrupted runs, and the
migration scenarios for tasks already in flight. Follow-up
implementation issues reference this specification and MUST NOT redefine
its policy; a change of policy is a change to this document first.

**Superseded for selection (#1158).**
`docs/changed-file-verification-contract.md` replaces pinned regressions
with an Issue-scoped retained set of failing test files. It is the only
authority for stage results, retention and recovery routing. This
document remains the record of what shipped. A rule here binds the
replacement only where that contract's §8 restates it: evidence identity
and its matching law, allocation before launch with one commit, and
bounded non-code recovery. An allocated run with no result re-runs
automatically only when termination is confirmed by launch and
termination evidence the run itself recorded, proving that it launched
no process or that every process it launched was confirmed terminated;
that run is `incomplete` and is recovered under the bounded budget. A
worker's death or a superseded allocation never proves it, and the
shipped run ledger records no such evidence. Only a run whose
termination cannot be confirmed parks as `termination-unknown`.

This is slice 3/15 of the independent **Staged Verification** chain: 3
design Issues followed by 12 implementation/validation Issues. Execution
order is represented by GitHub Blocked by relationships and the chain
registry, not by prose here. The chain has no dependency on another
active chain. Issue #1096 delivers this document, the reconciliation
notes in the documents it touches, and its structural contract tests
only: **no runtime behavior ships with it.**

It is the third and last design Issue of the chain, and it closes the
seam both of its predecessors deferred to it. `docs/staged-verification-contract.md`
(#1094) fixes the lifecycle; `docs/project-verification-contract.md`
(#1095) fixes the project-owned inputs. Everything those two decided is
consumed **verbatim** here: the two stages, the five-set loop-selection
union, the closed stage-outcome vocabulary and its precedence, the
evidence bundle and its completeness rule, the mandatory retention
floors R1–R6, the 13-row transition table, the publication ordering, the
check-is-the-unit rule, the six-kind result envelope, and the
never-a-verdict rules. **This document adds no stage, no outcome, no
verdict, no selection source, no transition row and no grant path.** It
adds exactly three things neither predecessor owns: an **identity** for
a bundle richer than the two fields #1094 §6.2 rule 2 named, a
**record and a lifecycle** for the pins #1094 §6.3 R2 and R6 declared,
and a **bounded recovery** for the stage runs #1094 rows 4, 5, 11, 12
and 13 send back to be re-run.

Availability of everything described here is tracked in the
[Staged verification](feature-status.md#staged-verification-loop-and-final-stages)
row of `docs/feature-status.md`.

It does **not** specify, and no implementation built against it may
assume:

- **The stage lifecycle** — stages, selection, outcomes, aggregation,
  the transition table, the publication ordering and the retention
  floors are fixed by `docs/staged-verification-contract.md` (#1094).
  This document never widens a floor, never adds an outcome and never
  creates a path to the stack-ready grant.
- **Project configuration and the adapters** — fixed by
  `docs/project-verification-contract.md` (#1095). A project file and an
  adapter remain non-authorizing, and nothing here lets either one
  declare, correct, or contradict an identity component (§4.3 rule 5).
- **The plan, its four layers, its revision model, its digest, its
  admissible task states and its evidence-invalidation discipline** —
  fixed by `docs/verification-amendment-contract.md` (#1037) and shipped
  in `src/core/verification-plan.ts`,
  `src/core/verification-amendment.ts` and
  `src/core/verification-evidence.ts`. This contract consumes §5.4's
  `planDigest`, §5.3's `revisionOrdinal`, §6.4's session baseline,
  §7.1's `claimed`/`running` refusal and §8.1's preservation rule
  unchanged, and introduces no layer, operation, slot state or revision
  of its own.
- **Runner-owned execution, per-command classification, cycle
  aggregation and lane continuation** — fixed by
  `docs/verification-execution-contract.md` (#918), design-only today.
  §5's attribution rules restate that document's and #934's shipped
  classification posture; they add no classifier and no retry of a code
  failure (#918 §6.3 stands).
- **Environment preparation itself** — `docs/environment-prepare-contract.md`
  owns the prepare command, its stamp, its caching and its stop-reason
  classification (#1060). §4.5 *reads* the shipped prepare stamp as a
  declared identity; it changes nothing about when preparation runs,
  what it runs, or how it is bounded.
- **The platform and sandbox attestation** — `docs/single-host-platform-sandbox-contract.md`
  (#916) owns the capability report. §4.5 consumes its identity when one
  exists and adds no check id, no support level and no probe.
- **Retention, backup and pruning mechanics** —
  `docs/retention-backup-contract.md` owns them. #1094 §6.3's floors are
  unchanged; a pin *record* is stored where its pin already was, and no
  store, table or pruning surface is added.

## 1. Why this contract — the gap it closes

#1094 and #1095 are correct about a single run in a single moment. The
gaps are all about the *second* moment: the run that is reused, the
failure that is remembered, and the run that never finished.

- **A bundle is bound to two identities but produced under seven.**
  #1094 §6.2 rule 2 binds evidence to `planDigest`, `headSha` and
  `selectionDigest`. But a loop stage runs *after the agent diff and
  before the commit* (#1094 §8 step 1), so at loop time the working tree
  is dirty by design and `headSha` describes content the run did not
  test. A dependency sync, a Tool Request install, or an
  `environmentPrepare` run can change what the same command does without
  moving the head at all. And #1037 §6.4's **plan-neutral drift** is a
  session edit that provably leaves `planDigest` byte-identical. Three
  different ways for two genuinely different runs to present identical
  bindings — and §4.4 reuse and the row-7 grant are both decided by
  comparing bindings.
- **Unknown identity has no rule, and the natural implementation gets it
  backwards.** When a component cannot be resolved — the head is
  unresolvable, the plan is `unreconciled`, the prepare stamp is
  unreadable — the obvious implementation records nothing and compares
  absent to absent, which reads as a match. That is the single most
  likely way a stale bundle grants. #916 §9 rule 5's "unknown evaluates
  as absent" is the right rule for a *capability* and the exactly wrong
  rule for an *identity*, and nothing written down says so.
- **A pin can be released by an event that proves nothing.** #1094 §6.3
  R2 says the regression set is "cleared only by a complete, `passed`
  final stage" and R6 says a loop pin drops when a run "records a
  `passed` verdict for that id". Those are two different clearing rules
  for two different sets, and the document does not say what a *single
  check's pass* may and may not buy. An implementation that read R6's
  rule as the general one would let one green check discharge the
  Issue's last full-validation failure.
- **A pinned id can vanish silently.** #1094 §4.2 intersects the pin
  sets with the current required set, so a retired slot or a renamed
  `session.verification` key takes its pin with it, with nothing
  recorded. "The operator renamed the check" and "the operator decided
  the failure no longer matters" become the same event, and only one of
  them should release a pin.
- **Interruption is unbounded.** Rows 4 and 11 re-run the stage "on the
  next claim"; rows 6 and 13 take the shipped delayed retry. None of
  them counts. An Issue on a host that keeps losing its worktree
  re-runs forever, consuming no repair cycle and therefore never
  reaching the cap that would park it — invisible by construction.
- **A whole-command timeout has a tempting wrong answer.** #1095 gives a
  project the ability to report cases. When `npm test` overruns its
  budget, the log ends at some test name. Naming that test as the
  failure would be a fabricated code failure, would pin the wrong thing,
  and would hand an agent a repair target that is not the problem. The
  shipped `classifyReviewVerificationStop` already refuses to read
  output; nothing says a stage must keep refusing.
- **Migration is unwritten.** Tasks in flight when the feature is
  enabled carry legacy `verificationNames`/`verificationPassed` context,
  possibly an unresolved Tool Request, possibly operator-attested
  `manualVerificationEvidence`, and possibly a `status:stack-ready`
  marker earned under the old rule. What each becomes on the first
  staged claim decides whether enabling the feature is safe.

This contract closes all seven: a seven-component identity with a
three-valued component type and one matching law (§4), attribution by
typed facts only (§5), a pin record with a closed release table, a
dormancy rule for ids that leave the plan, and one audited operator
release (§6), idempotency and a bounded consecutive-retry budget with a
named recovery surface (§7), and a migration table that adds no backfill
(§8).

## 2. Terminology

- **Evidence identity** — the closed, seven-component tuple a stage
  evidence bundle is bound to (§4.2). Recorded once per stage run,
  compared whenever the bundle is considered for a use.
- **Identity component** — one named element of the tuple. Every
  component is three-valued (§4.1): a `value`, `none`, or `unknown`.
- **Use** — one of the exactly two questions that compare identities:
  **reuse**, the #1094 §4.4 satisfaction of a final stage without
  re-execution, and **grant**, the #1094 §7 row-7 publication.
  "Retained", "displayed" and "audited" are not uses (§4.6).
- **Valid for a use** — every component of the bundle's identity matches
  the use's expectation under §4.4's law. There is no partial validity.
- **Conservative invalidation** — the rule that an unresolvable identity
  makes evidence unusable rather than usable: `unknown` matches nothing,
  including another `unknown` (§4.4).
- **Attribution** — deciding which check, which cause, and which unit a
  stage run's non-passing outcome is recorded against (§5).
- **Pin** — a check id the runner carries forward into later loop
  selections. Two kinds, both #1094's: a **regression pin** (§6.3 R2,
  armed by a non-passing **final** stage) and a **loop pin** (§6.3 R6,
  armed by a loop stage that selected a check and did not prove it
  green). This contract gives each a record and a lifecycle; the
  membership rules and the selection union stay #1094's.
- **Pin record** — the durable, append-only description of one pin: what
  armed it, at which revision, with which observed detail, and how it
  was released (§6.1).
- **Dormant pin** — a pin whose check id is not in the current required
  set. It leaves the selection because a selection can only name plan
  members, and it stays on the task and re-activates if the id returns
  (§6.4). Dormancy is **not** a release.
- **Release** — the recorded end of a pin. The set is **closed**:
  `proven` | `final-pass` | `amended` | `terminal` (§6.3).
- **Stage recovery attempt** — one automatic re-run of a stage after a
  **non-code** termination (`interrupted`, `unknown`, `infrastructure`).
  Counted consecutively per Issue per stage and bounded (§7.3). A
  `code-failed` or `timed-out` stage run is never a recovery attempt and
  never touches this counter.
- **Recovery act** — an operator operation on stage state through the
  shipped `admin task-verification` surface (#1042). Always audited,
  always refused on an active task, and never a grant (§7.4).

## 3. Mapping the shipped state onto stages

The Issue's first requirement is a map, not a redesign. Every row below
names a mechanism that ships or is fixed by an approved contract today,
and what it becomes under staged verification. **Nothing in this table
changes the mechanism it names.**

| Shipped or fixed mechanism | Where it lives | Its role under staged verification |
| --- | --- | --- |
| The plan revision chain and its §5.5 checkpoint | `src/core/verification-amendment.ts` (#1037) | Source of the `planDigest` and `planRevisionOrdinal` identity components (§4.5). A new revision changes the identity, so every earlier bundle stops being valid for a use — by identity, never by deletion (#1037 §8.1) |
| Session-default drift and the session baseline | #1037 §6.4 | Source of the `sessionBaselineDigest` component, read **live** and compared against the checkpoint's stored baseline (§4.5 rule 6) because rule 5's re-anchor waits for the next writing surface. This is the component that exists **because** §6.4 rule 3 proves a plan-neutral drift leaves `planDigest` equal: without it, an authorized session edit would be invisible to every identity comparison |
| Task amendments and their admissible states | `admin task-verification` (#1042), #1037 §7.1 | The `claimed`/`running` refusal is the primary in-flight guard, consumed unchanged and **relied upon** by §7.2. A stage never amends and never creates a revision (#1094 §9) |
| Operator-attested evidence and its binding | `src/core/verification-evidence.ts`, `evaluateVerificationEvidenceBinding` (#1040) | Consumed **verbatim**. A manual entry still satisfies a `req:<hex>` slot on exactly its shipped terms, its closed rejection set is unchanged, and staged identity is checked *around* it, never instead of it (§4.6 rule 3) |
| Per-slot evidence invalidation records | #1037 §8.3 rule 1 | Unchanged, and deliberately **not** the mechanism used here. An invalidation record says a manual entry stopped satisfying a slot; an identity mismatch says a runner bundle stopped describing this run. Neither is expressed in the other's terms |
| The reviewed head and the approved commit | `src/handlers/review.ts` | Source of the `testedRevision` component for a `final` stage, and of #1094 §8's head binding at enqueue, which this contract extends from one field to the whole tuple (§4.6 rule 2) |
| The review verification deadline and its stop classification | `REVIEW_VERIFICATION_DEFAULT_TIMEOUT_MS`, `classifyReviewVerificationStop` (#1090) | The normative example of §5 rule 1: the stop reason is read from `timedOut`, `deadlineEscalated`, `spawnErrorCode`, `spawnError` and `signal` — typed facts — and never from output. A stage adopts this posture at every site |
| Process-tree cleanup after a deadline | `ProcessTreeCleanup` (#1060, #1090) | A cleanup that cannot confirm termination (`processGroupSignalError`) taints the worktree: the runner cannot say what is still executing there, so the environment identity of the remainder of that stage run is `unknown` (§4.5) |
| The environment prepare stamp | `docs/environment-prepare-contract.md` §2.4 | The **declared** dependency and environment identity (§4.5). Its `cacheKeyFiles` are operator-declared, so core learns "the dependency state changed" without knowing what a lockfile is |
| The platform capability report | #916 §10 | The host half of the environment identity when one exists. Its `CapabilityStatus` three-valued shape is the precedent for §4.1, with one deliberate divergence stated there |
| `admin review-verification resolve`'s failure path clearing manual evidence | #622, preserved by #1037 §8.5 | Unchanged, and it is **not** a pin release: it clears operator-attested evidence on its own trigger and touches no pin, no bundle and no identity (§6.3 rule 5) |
| Legacy `verificationNames` / `verificationPassed` task context | `src/core/implementation-verification.ts` | Read-only history. It is never converted into a bundle, an identity, or a pin (§8 rule 2) |
| Task cancellation | #608 | Produces `cancellation-stop` and an `interrupted` stage (#1094 §6.1), and a terminal task status, which is the `terminal` release (§6.3) |
| The per-Issue worktree lock and the phase execution lock | #440, #456 | Unchanged. Identity is resolved and re-checked inside the lock the phase already holds; no lock is added, widened or held across phases |

## 4. Evidence identity

### 4.1 The three-valued identity component

```ts
type IdentityComponent =
  | { readonly state: "value"; readonly value: string }
  | { readonly state: "none"; readonly source: string }
  | { readonly state: "unknown"; readonly reason: string };
```

The three states are not two states plus an error code; they are three
different, jointly exhaustive answers to "what was this run's X?".

- **`value`** — the source was consulted and gave an identity.
- **`none`** — the source was consulted and completely, authoritatively
  declares nothing. A session with no `environmentPrepare` block has no
  prepare identity; a session that declares no `session.verification`
  layer at all, for a task with no checkpoint, has no session
  baseline. `none` is a *fact about the configuration*, it is stable
  across runs, and it therefore **compares equal to another `none`**.
- **`unknown`** — the source could not be consulted, or its answer could
  not be read. The runner does not know, and saying so is the whole
  content of the value. It **compares equal to nothing, including
  another `unknown`** (§4.4).

Three rules keep the distinction from collapsing:

1. **`none` is never produced by a failure.** Every failure to resolve —
   a refusal, a crash, a timeout, an unreadable artifact, a malformed
   record — yields `unknown` with the reason recorded. `none` is
   reachable only from a successful consultation whose answer is
   "nothing is declared".
2. **A source that does not exist yet is `none`, not `unknown`.** When a
   component's source is an unimplemented contract — #916's capability
   report has no shipped emitter today — the component is `none` for
   every run in every session, stably, and comparisons behave exactly as
   if the component were not there. This is what keeps the identity
   model from making the feature unusable before its sources land, and
   it is the reason rule 1 has to be explicit: "not implemented" is a
   configuration fact, "implemented and broke" is not.
3. **The divergence from #916 is deliberate and is stated here once.**
   #916 §9 rule 5 resolves an `unknown` *capability* to `absent` — no
   credit — because for a capability, absent is the conservative
   reading. For an *identity*, absent is the dangerous reading: it makes
   an unattestable run look exactly like an unattested one, and
   comparing the two equal is precisely the false match §4.4 exists to
   prevent. Both contracts fail closed; they fail closed in opposite
   directions because they are answering opposite questions.

### 4.2 The tuple (closed)

One stage run produces one identity, recorded on its bundle (#1094
§6.2). The component set is **closed**; adding one is a change to this
document first.

```ts
interface StageEvidenceIdentity {
  /** The commit the stage run was launched at. */
  readonly testedRevision: IdentityComponent;
  /** What the working tree held beyond that commit, by content (§4.5). */
  readonly workingTreeState: IdentityComponent;
  /** #1037 §5.4 plan digest of the resolved effective plan. */
  readonly planDigest: IdentityComponent;
  /** #1037 §5.3 `appliedThroughOrdinal`; "0" for an unamended task. */
  readonly planRevisionOrdinal: IdentityComponent;
  /** The live session-default layer under #1037 §6.4 rule 1's digest rule. */
  readonly sessionBaselineDigest: IdentityComponent;
  /** The applied selection policy (§4.5), never the project file's bytes. */
  readonly selectionPolicyDigest: IdentityComponent;
  /** Declared preparation and platform identity (§4.5). Never sniffed. */
  readonly environmentIdentity: IdentityComponent;
}
```

`selectionDigest` (#1094 §6.2) is **not** a member. It describes what
this run chose to do, not the world the run happened in, and #1094 §6.2
rule 1 and §4.4's `selection.full` requirement already govern it. Keeping
the two separate is what lets a consumer say "same world, different
scope" — which is exactly the loop-versus-final distinction.

### 4.3 Resolution

1. **Resolved once, at launch, before the first check starts.** The
   whole tuple is resolved inside the lock the phase already holds and
   written with the stage run's allocated ordinal (§7.1) before any
   check process exists.
2. **An unresolvable identity costs no execution.** Because resolution
   precedes launch, a stage run that cannot establish its identity ends
   `unknown` (rule 4) having run nothing. Failing closed here is cheap
   by construction, which is why the rule can afford to be absolute.
3. **Re-checked once, at the end, before the bundle is written.** Every
   component is resolved again. Any component whose end value does not
   match its launch value under §4.4 makes the stage run `unknown` —
   #1094 §6.1's "a head or `planDigest` change observed mid-run",
   generalized from two components to seven. The bundle is still written
   and still retained; it is simply never valid for a use.
4. **An unresolvable component makes the stage run `unknown`.** Any
   component in state `unknown`, at launch or at the end, makes the
   stage run's outcome `unknown` — the #1094 §6.1 member, not a new one.
   It therefore routes through the shipped rows: a loop stage takes row
   5 (one full re-run in the same lane, then the operator park), a final
   stage takes row 12 (fail closed, park for the operator, no automatic
   re-run), and both are bounded by §7.3.
5. **No component is ever supplied, defaulted, corrected or contradicted
   by an adapter, an agent, a project file, or a case id.** #1095 §9.3's
   command-integrity rule, applied to identity: the sources are the
   shipped plan, the shipped provider seam, the shipped prepare stamp,
   the operator's session, and the #916 report, and there are no others.
6. **A `final` stage launches only on a clean working tree.** "Clean"
   means no modification to a tracked path — added, modified, deleted,
   renamed or staged. A dirty final stage is an evidence-integrity
   condition, not a code condition: the run would test content the head
   being published does not contain, so it is `unknown` at launch and
   routes to row 12 rather than producing a bundle nobody can interpret.
   Untracked, non-ignored paths do **not** block the launch — the review
   worktree routinely holds runner-written artifacts — but they are
   counted into `workingTreeState` (§4.5) so two otherwise identical
   runs are still distinguishable. A `loop` stage has no such
   precondition: it runs on the agent's uncommitted diff on purpose
   (#1094 §8 step 1), which is exactly why `workingTreeState` is a
   component rather than an assertion.

### 4.4 The matching law and conservative invalidation

One law, stated once, used everywhere:

> Two identity components **match** iff both are in state `value` and
> their values are equal, **or** both are in state `none`. A component in
> state `unknown` matches nothing, including another component in state
> `unknown`.
>
> Two identities match iff **all seven** components match. A bundle is
> **valid for a use** iff its identity matches the identity the use
> expects.

Consequences, each of which an implementation could otherwise get wrong:

1. **There is no partial validity and no component weighting.** No
   subset of components is "the important ones", and no use compares
   fewer than seven. A rule that skipped `selectionPolicyDigest` for a
   final bundle — whose selection is total and therefore
   policy-independent — would be sound in isolation and would be one
   more special case for a later change to break; the cost of comparing
   it is one equality test on a window (§8's single transaction) that is
   already this short.
2. **There is no override.** No operator flag, no session value, no
   recovery act and no `--force` declares a mismatched bundle valid. An
   operator who wants a different obligation amends the plan (#1094 §7
   rule 1); an operator who wants a fresh answer re-runs the stage.
3. **Invalidation deletes nothing.** An invalid bundle is retained,
   readable and auditable with the identity that made it invalid on it —
   #1037 §8.1's preservation rule, applied to stage evidence. "Invalid"
   means exactly "not admissible for a use", never "gone".
4. **An invalid bundle can still arm a pin and can never release one.**
   Arming widens later verification and releasing narrows it, so the two
   directions get opposite treatment: the non-green verdicts of a run
   whose identity turned out not to match are still recorded as pins
   (#1094 R2, R6), and none of its passing verdicts releases anything
   (§6.3 rule 4). This asymmetry is the fail-closed direction and it is
   deliberate — a run that ran under an identity nobody can pin down
   still observed something break.
5. **Legacy and partial records are `unknown`, not `none`.** Evidence
   persisted before a component existed carries it as `unknown`: the run
   happened, and the runner cannot retroactively attest what it happened
   under. Such a bundle is therefore never valid for a use (§8 rule 3).

### 4.5 The components, one by one

| Component | Source | `value` is | `none` when | `unknown` when |
| --- | --- | --- | --- | --- |
| `testedRevision` | The stage worktree's resolved `HEAD`, through the shipped provider seam | The normalized 40-hex commit SHA, under the shipped `normalizeCommitSha` rule (#1040) | **Never.** A stage always runs somewhere | The head cannot be resolved or does not normalize — #1040's `head_unresolvable`, restated |
| `workingTreeState` | The shipped provider seam: the porcelain status of the stage worktree, enumerating untracked files individually, **plus the current content of every path that status lists** | `"clean"` when no tracked path is modified and no untracked non-ignored path exists; otherwise `sha256` over the sorted list of `<status-code> <path> <content-fingerprint>` triples, where the fingerprint is the digest of that path's current bytes read back through the same seam — untracked files included — and a fixed sentinel for a path with no current content. **Path strings and file bytes enter a digest and never a surface** | Never | The status cannot be read, or a path the status lists cannot be fingerprinted (§4.5 rule 5) |
| `planDigest` | The #1037 §5.5 checkpoint, or the resolved plan for an unamended task | The §5.4 digest | Never — an empty plan still has a digest | The plan is unresolvable (#1040's `plan_unresolvable`) or #1037 §6.4 classifies the task `unreconciled` |
| `planRevisionOrdinal` | #1037 §5.3 | The decimal `appliedThroughOrdinal`; `"0"` for an unamended task | Never | The checkpoint exists and its ordinal is unreadable |
| `sessionBaselineDigest` | The **live** `session.verification` layer, digested by #1037 §6.4 rule 1's rule, plus the checkpoint's stored `sessionBaselineDigest` when the task carries one | The live digest — when the task carries no checkpoint, or carries one whose stored digest equals it | The session declares no `session.verification` layer at all and the task carries no checkpoint, so nothing is declared and nothing is stored | The live layer cannot be read; or a checkpoint exists and its stored baseline digest is missing, malformed, or differs from the live digest — #1037 §6.4 rule 3's `drifted`, which only #1037's rebase resolves (§4.5 rule 6) |
| `selectionPolicyDigest` | The **applied** selection policy: the resolved `selectable` list, the resolved `finalOnly` list, the effective selectable set (#1095 §3.4) and the resolved result-adapter mapping | `sha256` over their canonical form | Never — an enabled session always resolves a policy, and an empty one digests to a stable value | The session block is unreadable at resolution time |
| `environmentIdentity` | The declared sources only: the #2.4 prepare stamp of the last **successful** prepare in this worktree, the operator's `stagedVerification.environmentIdentity` token, and the #916 capability report when one exists | `sha256` over the canonical form of whichever of the three are present | None of the three is declared or available: no `environmentPrepare` block, no operator token, and no capability report emitter | A prepare is declared and no current stamp can be read, the last prepare attempt failed, the token is present and malformed, a capability report was attempted and failed, or process-tree cleanup could not confirm termination (§4.5 rule 3) |

Six rules the table depends on:

1. **Dependencies are covered twice and sniffed never.** Version
   controlled manifests are part of `testedRevision` — they are files in
   the commit — and uncommitted ones are part of `workingTreeState`. The
   *installed* state is covered by the prepare stamp, whose
   `cacheKeyFiles` the **operator** declared. Core therefore learns
   "the dependency state changed" without reading a lockfile, knowing
   what a package manager is, or inspecting a path (#1094 §3.3).
2. **`selectionPolicyDigest` is the applied policy, not the project
   file.** #1095 invariant 10 requires a refused project file to behave
   exactly like an absent one; making the *file's* digest an identity
   component would break that, since two states that behave identically
   would compare unequal. The file's own digest is still recorded on the
   bundle as evidence detail (#1095 §14), and the two fields are
   deliberately different things: one says what governed the run, the
   other says what the repository contained.
3. **A worktree the runner cannot vouch for has an `unknown`
   environment.** When a deadline's process-tree cleanup reports
   `processGroupSignalError` — descendants may still be running — the
   runner cannot say what is executing in that worktree, so
   `environmentIdentity` is `unknown` for the remainder of that stage
   run. By §4.3 rule 4 the run is `unknown` and parks or re-runs rather
   than producing evidence about a worktree that has an unaccounted
   process in it — which, by #1094 §6.1's precedence, outranks the
   `infrastructure` outcome the same condition would otherwise take
   (§5 rule 3).
4. **Every `unknown` carries a bounded, operator-facing reason**, and
   that reason is recorded, displayed and never parsed for control flow
   — the same posture #1094 §5.1 gives the selection port's `reason`.
5. **A status entry is not a content fingerprint.** A path that is
   already modified, or already untracked, keeps a byte-identical
   `<status-code> <path>` entry when its contents change again. A digest
   over status entries alone would therefore call two different agent
   diffs the same working tree — exactly the loop case this component
   exists for (§4.3 rule 6) — and would miss a change to an untracked
   input under a `final` stage, which the same rule deliberately admits.
   `workingTreeState` is therefore bound to **content**: every path the
   status lists is fingerprinted by its current bytes through the same
   provider seam, the listing enumerates untracked files individually
   rather than collapsing a directory into one entry, a symlink
   fingerprints its target string, and a path with no current content —
   a deletion — takes the fixed sentinel. Two consequences are worth
   stating. First, **fingerprinting bytes is not sniffing them**: rule 1
   and §10 invariant 7 forbid core *interpreting* a path — knowing which
   one is a lockfile, a manifest, a test file or a tool version — and
   hashing the bytes at a path the shipped status already named
   interprets nothing, so core still cannot say *what* changed, only that
   this working tree is not the one an earlier bundle ran on. Second,
   the cost is bounded by the size of the diff and not by the size of
   the repository, because an ignored path is never listed and therefore
   never read. A path the seam lists and cannot fingerprint — unreadable,
   vanished between the listing and the read, or of a kind whose bytes
   the seam cannot produce — makes the component `unknown` and is never
   silently skipped.
6. **The session baseline is read live, and a divergence is not an
   identity.** #1037 §6.4 rule 5 re-anchors the stored checkpoint
   baseline only when a *writing* surface observes the drift — in
   practice the phase runner resolving the plan at claim time — so an
   operator editing `sessions.json` during a stage run moves nothing the
   checkpoint holds, and rereading a stored digest could never observe
   that edit. The `drifted` state #1037 §6.4 rule 3 defines is invisible
   from the checkpoint alone. This component is therefore resolved from
   the **live** `session.verification` layer, at launch and again at the
   end-of-run re-check, under #1037 §6.4 rule 1's digest rule so that the
   live and stored digests stay comparable; a plan-neutral drift moves it
   while `planDigest` provably does not. When the task also carries a
   checkpoint whose stored `sessionBaselineDigest` differs from the live
   one, the component is `unknown` rather than either digest: the run
   would happen over a session layer #1037 has not yet re-anchored, and
   only #1037's rebase resolves that. This contract reads the checkpoint
   and never writes, repairs or rebases one (§7.2 rule 2).

### 4.6 Where identity is used

1. **Reuse (#1094 §4.4).** A final stage is satisfied without
   re-execution only by a bundle that is already same-lane, same-attempt,
   complete, `passed`, `final`, and post-approval — *and* whose identity
   matches the identity resolved for the stage run that would otherwise
   launch. #1094 §4.4's `planDigest` and head conditions are subsumed by
   the tuple; the other conditions are unchanged and are not weakened.
2. **Grant (#1094 §7 row 7, §8 step 5).** The publication transaction
   re-resolves the identity and compares it to the bundle's. #1094 §8's
   "head binding at enqueue" becomes an **identity** binding at enqueue:
   if anything moved between the final stage and the enqueue, the grant
   is not published and the final stage is re-queued, exactly as #1094
   already prescribes for a moved head.
3. **Not a use: operator-attested evidence.** A `req:<hex>` slot
   satisfied by a #1040 manual entry is judged by
   `evaluateVerificationEvidenceBinding` **verbatim**, on its own four
   binding fields and its own closed rejection set. The stage identity
   governs the *stage run*; it is never folded into that evaluator, and
   the evaluator is never re-implemented with more fields. An operator
   attestation is a statement about a run that happened, and #1040
   already decides when it is admissible.
4. **Not a use: retention, display and audit.** R1–R6 retention is
   unchanged, the operator stage view shows every bundle it has
   including invalid ones, and an audit reads them all. Identity
   restricts what evidence may *buy*, never what is *kept* (§4.4 rule
   3).

## 5. Attribution — what a failure may be blamed on

1. **Attribution is by typed facts, never by output.** The stop reason
   for a check comes from the shipped typed fields — `timedOut`,
   `deadlineEscalated`, `spawnErrorCode`, `spawnError`, `signal`, the
   exit code — exactly as `classifyReviewVerificationStop` reads them
   today. No stage outcome, verdict, `notRunKind`, pin, or agent fix
   input is ever derived from parsing a check's stdout or stderr. Output
   remains a bounded tail for a human (#1094 §6.2, #918 §11).
2. **A whole-command timeout has no failing case.** The unit of blame
   for a `timed-out` check is the **check**, always. #1095 §7.4 already
   downgrades a `complete` envelope to `partial` for a run that did not
   finish; this is the attribution half of the same rule:
   - No case from a timed-out check's envelope may be named as the
     cause, and the last case observed before the deadline is
     specifically not the cause — it is the last thing that was printed,
     which is a fact about output ordering and not about what hung.
   - The retained regression entry is the check id and nothing finer
     (§6.5).
   - Case detail from such an envelope may still be shown, labelled as
     *observed before the deadline*, and never as the failing set.
3. **Infrastructure is never fabricated as code, and code is never
   laundered as infrastructure.** A spawn error, a substrate failure and
   a #917 sandbox refusal are `infrastructure` (#1094 §6.1); they reach
   no agent as fix input and consume no repair cycle (#1094 §7 rule 3).
   Symmetrically, no heuristic demotes a nonzero exit to
   `infrastructure` (#1094 §7 rule 6, #918 §6.3). The ban runs in both
   directions because both directions destroy the loop: one burns
   repair cycles on a broken host, the other hides a real failure behind
   a retry. **A cleanup that could not confirm termination is the one
   host condition that does not stop at `infrastructure`**: it also
   makes `environmentIdentity` `unknown` (§4.5 rule 3), and #1094 §6.1's
   precedence puts `unknown` above `infrastructure`, so such a run is
   `unknown` and takes the operator park rather than the delayed retry.
   That is the intended order — a host that merely failed can be retried,
   while a worktree with an unaccounted process in it is a question
   about evidence integrity, and retrying into it would produce more
   evidence of the same doubtful kind.
4. **An absent cause is `evidence-lost`, never the nearest plausible
   one.** #1094 §6.1's fail-closed `notRunKind` rule, restated as an
   attribution rule: when the runner cannot say why a selected check has
   no verdict, it says that, and the stage is `interrupted` or
   `unknown`. Choosing the most likely cause would make an integrity
   failure indistinguishable from an ordinary one.
5. **Attribution never crosses checks.** A failure is recorded against
   the check whose process produced it and no other. A set-level
   condition — a set deadline, a substrate stop, a cancellation — is
   recorded against each affected check through its own `notRunKind`
   (#1094 §6.1), never collapsed onto whichever check happened to be
   running when it hit.

## 6. Pinned regressions

### 6.1 The pin record

#1094 §6.3's R2 and R6 are **id lists**, which is all a selection needs
and not enough for anything else: an operator cannot see why a check is
being carried, and a release cannot be attributed. Each pinned id
therefore carries a record, stored where the pin already is — task
context, beside the bundle, under the existing CAS (#1094 §9) — and not
in a store of its own.

```ts
interface PinRecord {
  readonly checkId: string;                 // #1037 §5.1 identity
  readonly kind: "regression" | "loop";     // R2 or R6
  readonly state: "active" | "dormant" | "released";
  readonly armedBy: {
    readonly taskAttempt: number;
    readonly lane: VerificationLane;        // #918 §2
    readonly stage: StageId;                // #1094 §2
    readonly stageOrdinal: number;
  };
  /** The `testedRevision` of the arming run (§4.5). */
  readonly armedAtRevision: string;
  /** Mirrors the verdict that armed it. Closed. */
  readonly armedReason: "failed" | "timed-out" | "unknown" | "not-run";
  /** Operator-legible only; never an identity and never a match key. */
  readonly observedName?: string;
  /** #1095 case detail when the envelope admitted it. Display only (§6.5). */
  readonly observedFailingCaseIds?: readonly string[];
  /** Set when `state` is "released" (§6.3). */
  readonly release?: {
    readonly kind: "proven" | "final-pass" | "amended" | "terminal";
    readonly at: { readonly stage?: StageId; readonly stageOrdinal?: number };
    readonly operatorReason?: string;       // "amended" only; bounded, never parsed
  };
  /** Set when `state` is "dormant" (§6.4). */
  readonly dormantBecause?: "retired" | "orphaned" | "masked";
}
```

Rules:

1. **The record is append-only.** Arming an id that already has a
   released record appends a new record; it never rewrites the old one.
   A check that broke, was released, and broke again has two records and
   a legible history (#1037 §8.1's posture).
2. **The record is runner-produced in full.** No field is supplied by,
   defaulted from, or corrected by an adapter, a project file, or an
   agent (#1095 §6.1 rule 4, restated).
3. **The record is not a plan revision.** A pin is runner state, not a
   plan layer (#1094 §9). Arming, dormancy and release consume no
   `revisionOrdinal`, create no revision record, change no slot state,
   and post no amendment comment.
4. **Only `checkId`, `kind` and `state` affect selection.** Everything
   else is for the operator, the audit and the fix input. #1094 §4.2's
   union is computed from the active ids and is otherwise unchanged.

### 6.2 The purchasing-power rule

The Issue's first acceptance criterion is that a single PASS never
unpins a prior failing verification. The rule that delivers it is stated
positively, because the negative form invites exceptions:

> A single check's `passed` verdict may buy exactly one thing: the
> removal of that check from the **loop**'s carried-forward selection.
> It may never buy the release of a regression pin, the completeness of
> a bundle, the satisfaction of a final stage, or a grant.

Everything else in this section follows from it.

- **A regression pin is released by no pass at all, only by a complete
  full-set pass.** Not by a loop-stage pass of that check, not by a
  final-stage pass of that check inside an incomplete bundle, not by a
  manual operator evidence entry, and not by any number of other checks
  passing. The only passing event that releases it is `final-pass` — and
  `final-pass` is not a pass of a check, it is **the whole required set
  passing, complete, under a valid identity, at the head being
  published**: the very same evidence #1094 row 7 requires for the
  grant. Releasing a regression pin and granting stack-ready are
  therefore the same event, which is what makes "this Issue's last full
  validation failed" and "this Issue is a usable stacking base"
  impossible to hold at once.
- **A loop pin's release by a proving pass is sound, and is a different
  claim.** A loop pin says a check was *selected and not proven*; a pass
  is exactly its disproof. It is safe for two independent reasons: a
  loop pin gates nothing — it only widens a selection — and the final
  stage's selection is total (#1094 §4.3), so a check released from the
  loop still runs in full before anything is granted. The pass bought a
  narrower loop and nothing else, which is precisely what the rule
  permits.
- **Incompleteness cannot be bought either.** A passing verdict for a
  check inside a bundle that is `complete: false` contributes to no
  release and no satisfaction (#1094 §6.2 rule 4). A bundle proves
  things as a whole or not at all.

### 6.3 The release table (closed)

| Release | Applies to | Condition | Effect |
| --- | --- | --- | --- |
| `proven` | **loop pins only** | A later stage run in this Issue recorded a `passed` verdict for that id in a bundle that is valid for its own run (§4.4 rule 4) | The id leaves the loop pin set. #1094 §6.3 R6's drop rule, with a record |
| `final-pass` | **both** | A complete, `passed` `final` stage run, valid for the grant it produces (#1094 §7 row 7) | Every active and dormant pin of the Issue is released. #1094 §6.3 R2 and R6's "clears with R2" rule, with a record |
| `amended` | **regression pins only** | An explicit, audited operator recovery act (§7.4) | That one id's pin is released, with the operator's reason recorded |
| `terminal` | **both** | The Issue's task reached `done`, `failed` or `cancelled` | Every pin is released; retention of the records follows #1094 R1's horizon |

Rules:

1. **The table is exhaustive.** No timer, no cycle count, no attempt
   budget, no adapter answer, no project file value, no session edit, no
   plan revision, no label, no ChatOps verb and no agent statement
   releases a pin. An id that leaves the required set does not release
   either — it goes dormant (§6.4).
2. **`amended` is the only operator release, and it is narrow.** It
   releases a **pin**, never a check: the check stays in the plan, stays
   required, and still runs in every final stage and in every loop step
   that names it for another reason. It can never grant, never mark a
   stage passed, never satisfy a requirement, never make a bundle
   complete, and never substitute for the row-7 precondition. Releasing
   a pin buys exactly the inverse of §6.2's rule: the loop stops
   carrying it, and nothing else.
3. **Release is never success.** #1037 §8.4, restated for pins: a
   released pin is reported as *released*, with its kind, its reason and
   its operator where applicable — never as `passed`, and never omitted.
   A stage view that showed a released pin as clean would make the
   audited path indistinguishable from a fixed check.
4. **Only a valid bundle releases.** A pass recorded in a bundle whose
   identity does not match its own run (§4.4 rule 4) releases nothing.
   Arming is the opposite: it happens regardless.
5. **`admin review-verification resolve`'s evidence clearing is not a
   release** (#1037 §8.5). It clears operator-attested manual evidence on
   its own shipped trigger; it touches no pin record, no bundle and no
   identity.

### 6.4 Dormancy — deleted and renamed pinned ids

#1094 §4.2 intersects the pin sets with the current required set, so an
id that leaves the plan leaves the selection. That is correct and
unchanged — a selection can only name checks the plan contains — and on
its own it is also a silent pin loss. Dormancy fixes the silence without
touching the intersection.

1. **Leaving the required set makes a pin `dormant`, not released.** The
   id leaves the selection union immediately; the record stays on the
   task, carrying the #1037 §6.4 rule 4 disposition that removed it —
   `retired` by an amendment, `orphaned` by a vanished session key, or
   `masked` by an execution-layer `add`.
2. **A dormant pin re-activates when its `commandId` returns to the
   required set**, with its original arming record intact. #1037 §6.4
   rule 4 already replays the revision chain onto a returning session
   key; the pin returns with it. Re-activation is safe in the direction
   that matters: a pin only ever widens a selection, so re-activating
   one against changed bytes costs a run and can never hide a failure.
3. **A rename is a delete and an add, and the contract refuses to guess
   otherwise.** Core cannot know that `unit-test` is `test` renamed —
   at the identity layer a rename is indistinguishable from a removal
   plus an unrelated addition, and any heuristic that matched them (by
   command bytes, by name similarity) would carry one check's failure
   record onto a different check the operator never said was the same
   one. So the old id's pin goes dormant and never re-activates, the new
   id starts unpinned, and neither outcome is inferred.
4. **The safety net is that the final stage is total.** A renamed check
   is in the required set under its new id, so #1094 §4.3 runs it in
   full before any grant. Dormancy costs loop coverage between now and
   the final stage; it can never cost the gate.
5. **Dormancy is loud.** Every transition to and from `dormant` is
   recorded, shown on the operator stage view with its disposition, and
   emitted as an event. "Your pinned regression stopped being carried
   because the check left the plan" is exactly the sentence an operator
   needs and the one a silent intersection never produces.
6. **A dormant pin still ends only by the §6.3 table.** It is released
   by `final-pass`, by an `amended` recovery act, or by the task
   becoming terminal — and the operator who renamed a check can retire
   its dormant pin explicitly rather than waiting, which is what the
   audited path is for.

### 6.5 Command-level retention and case detail

The Issue asks for a command-level fallback when failing ids are
unavailable. The answer is that the command level is not a fallback; it
is the contract, and case ids are an annotation on it.

1. **The pin is always the check.** #1094's unit of selection and
   #1095 §5.1's verification unit are the check, so a regression pin is
   a `commandId` and never a case id, a case set, or a narrowed command.
   There is no case-level pin to degrade from.
2. **Case detail is recorded when it is admissible and omitted when it
   is not.** `observedFailingCaseIds` carries the failing and errored
   case ids of an admitted `complete` envelope (#1095 §7). When no
   result adapter applies, when the envelope is `unknown`, `unavailable`,
   `unreadable` or `conflicting`, or when the check timed out (§5 rule
   2), the field is simply absent. **Nothing else changes**: same pin,
   same id, same selection consequence, same release rules.
3. **Case detail never narrows anything.** It is not consulted by the
   selection union, by any release condition, by completeness, or by a
   grant. It exists to make a fix input and an operator view specific
   (#1095 §7.6), and #1095 §7.5's inertness rule covers it unchanged.
4. **A pin's `observedName` is legibility, never identity.** The
   operator-authored name is recorded so a stage view can say
   `exec:test ("test")`, and matching is always on `checkId`. A pin is
   never re-associated by name (§6.4 rule 3).

## 7. Crash, retry, amendment-in-flight and recovery

### 7.1 Idempotency and the two observable states

1. **`stageRunId` is the idempotency key.** #1094 §2's
   `(taskAttempt, lane, stage, stageOrdinal)` keys every write a stage
   run performs: its bundle, its pin updates, its attempt-counter update
   and — for a final stage — its grant.
2. **The ordinal is allocated before launch**, in the task's existing
   CAS transaction, and ordinals advance per launched run whatever the
   outcome (#1094 §7 rule 5). A crash therefore leaves an allocated
   ordinal with no bundle, which is a *detectable* signature rather than
   an ambiguity, and the next claim allocates the next ordinal instead
   of reusing one.
3. **There are exactly two observable states per stage run**: *ordinal
   allocated, identity recorded, no bundle* and *bundle, pins and any
   grant committed together*. No state exists in which pins moved and
   the bundle did not, or the grant published and the bundle did not
   (#1094 §8's one-transaction rule, which this contract relies on and
   does not extend).
4. **The first state is `interrupted`.** An allocated ordinal with no
   committed bundle is #1094 row 4 or row 11: the stage re-runs from the
   beginning on the next claim, is never resumed, is never partially
   credited, and consumes no repair cycle. A partial bundle is
   permanently inadmissible (#1094 §6.2 rule 4) and this contract adds
   no resumption path.
5. **The grant is at-most-once by the shipped mechanisms.** Row 7's
   enqueue rides `completePhaseWithEffects` with the outbox's existing
   idempotency key; a replay that observes a bundle already committed
   for that `stageRunId` re-records nothing and re-enqueues nothing. No
   new dedupe surface is introduced.
6. **Retries are new runs, not resumed ones.** Every automatic re-run
   (rows 4, 5, 11, 13 and §7.3) resolves a fresh identity, allocates a
   fresh ordinal and starts from the first check. The only thing carried
   across is task state: the pins, the records and the attempt counter.

### 7.2 Amendments while a run is active

1. **The primary guard is shipped and is relied upon.** #1037 §7.1
   refuses an amendment on a `claimed` or `running` task,
   unconditionally and with no `--force` (§7.2 rule 1). A plan cannot
   change underneath an in-flight stage run through the amendment
   surface, and this contract adds no second guard for that case.
2. **Session-default drift is the residual race, and identity catches
   it.** No surface refuses an operator editing `sessions.json` mid-run,
   and #1037 §6.4 rule 5 does not re-anchor the stored checkpoint
   baseline until a writing surface — the next claim — observes the
   drift, so the stored digest is exactly the thing that provably has
   *not* moved when the edit lands. `sessionBaselineDigest` is therefore
   read live (§4.5 rule 6): the end-of-run re-check (§4.3 rule 3) reads
   the live `session.verification` layer again and observes the move —
   including for a plan-neutral drift, where `planDigest` provably does
   not move either — so the component no longer matches its launch
   value. An edit that landed before launch is caught in the other
   direction, by the live-versus-stored divergence that makes the
   component `unknown` at launch. Either way the stage run is `unknown`,
   its bundle is inadmissible, and the next claim rebases per #1037 §6.4
   rule 5 and re-runs. The rebase is still #1037's: this contract
   performs none and changes none.
3. **An amendment between two stage runs is ordinary, not special.** The
   identity changes, so earlier bundles stop being valid for a use
   (§4.4); the pin sets intersect against the new required set and any
   id that left goes dormant (§6.4); the next stage run resolves fresh.
   No migration, no reconciliation and no carry-over logic is required,
   which is the point of binding to identities rather than to time.
4. **The window between the final stage and its publication is closed by
   two shipped rules together.** The task is `running` for the whole of
   it, so §7.1's refusal applies; and #1094 §8 commits the bundle and
   the grant in one transaction with an identity re-check (§4.6 rule 2).
   No third guard is needed and none is added.
5. **A stale lease is a recovery problem, not an amendment problem.** A
   crashed owner leaves the task `running`, so every amendment refuses —
   correctly, and forever, until the shipped recovery surface clears the
   claim. #1037 §7.2 rule 3 already requires the refusal message to name
   that surface. What this contract adds is only that the orphaned stage
   run reconciles as §7.1 rule 4 describes: an allocated ordinal with no
   bundle, recorded `interrupted`, crediting nothing.

### 7.3 Bounded retries

#1094 bounds code failures through the lanes' existing repair and review
caps. It bounds nothing else: rows 4 and 11 re-run "on the next claim"
and rows 6 and 13 take the shipped delayed retry, none of which counts,
precisely because none of them consumes an agent resource. A task on a
failing host therefore loops without ever reaching a cap and without
ever telling anyone.

1. **The budget counts consecutive non-code stage terminations**, per
   Issue per stage: `interrupted`, `unknown` and `infrastructure`. A
   stage run that produces a verdict-bearing outcome — `passed`,
   `code-failed` or `timed-out` — **resets the counter to zero**, because
   the run got far enough to say something about the change. Consecutive
   is the right shape: the budget bounds a stuck loop, not a lifetime.
2. **It never interacts with a repair cap.** The outcomes it counts are
   exactly the ones #1094 §7 rule 3 says consume no repair cycle, no
   review cycle and no fix invocation. `MAX_VERIFICATION_REPAIR_ATTEMPTS`,
   `DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES` and the review cycle cap are
   untouched and keep counting exactly what they count today.
3. **It is an outer bound and never extends an inner one.** Where #1094
   already bounds a row — row 5's single full re-run of a loop `unknown`,
   then the operator park — the tighter bound wins. The budget can cause
   a park earlier than #1094 would; it can never grant a re-run #1094
   withheld.
4. **At the cap, park for the operator** through the lane's existing
   human handoff — the same route rows 5 and 12 already take. The handoff
   names the stage, the consecutive count, the last outcome, and every
   identity component that resolved `unknown` with its reason. No new
   `TaskStatus`, `TaskPhase`, `PhaseRunOutcome` or `PhaseHandlerResult`
   member is introduced (#1094 §7).
5. **The value is operator-owned and fail-closed.**
   `stagedVerification.maxStageRecoveryAttempts` is a positive integer
   defaulting to a small bounded value; a non-integer, zero or negative
   value refuses the session at load, mirroring #1094 §5.3's posture.
6. **No backoff policy is added.** Rows 6 and 13 keep the shipped
   delayed-retry behavior verbatim; the budget bounds how many delays
   happen and says nothing about how long they are.
7. **Parking releases nothing and grants nothing.** A parked task keeps
   every pin, keeps every bundle, keeps its `stackReady` marker cleared
   (#1094 §7 rule 2 already cleared it), and waits.

### 7.4 Explicit operator recovery

Recovery rides the shipped `admin task-verification` surface (#1042):
#1094 §10 rule 6 forbids a new command family, and every operation below
is an operation on **runner stage state**, never on the plan.

| Operation | What it does | What it can never do |
| --- | --- | --- |
| `stage show` | The #1094 §10 rule 6 stage view, extended: the identity of the last loop and last final bundle with each component's state and each `unknown`'s reason, the pin records with their states and dispositions, the consecutive recovery-attempt count, and #1095's envelope kinds | Change anything |
| `stage release <checkId>` | Releases one **regression** pin as `amended` (§6.3), recording the operator, a required bounded reason, and an event | Release a loop pin, release a dormant pin's obligation to run, retire a check, grant, satisfy a requirement, mark a stage passed, or make a bundle complete |
| `stage reset-attempts` | Clears the §7.3 consecutive counter so a parked task can be retried once the host is fixed | Make any bundle admissible, release any pin, or unblock a grant |

Rules:

1. **Every operation is audited**: an append-only task event, the
   operator identity the shipped surface already resolves, a bounded
   reason, and the observed task revision. This is the "audited
   contract" the Issue's first acceptance criterion requires before a
   pin may be released by anything other than evidence.
2. **Every operation refuses on an active task** — `claimed` or
   `running` — and on a terminal one, with the shipped #1037 §7.1
   messages and postures reused verbatim, and guards on a CAS over
   `AiTask.revision` (#1037 §7.3).
3. **A refused operation changes nothing** and exits non-zero (#1037
   §11 rule 5).
4. **The set is closed, and the exclusions are the point.** There is no
   operation that marks a stage `passed`, forces a grant, edits or
   fabricates a bundle, declares a mismatched identity valid, converts
   an `unknown` component into a `value`, resumes an interrupted run, or
   lowers the row-7 precondition. An operator who wants a different
   obligation amends the **plan** (#1094 §7 rule 1); an operator who
   wants a fresh answer re-runs the stage.
5. **No recovery act touches the plan.** No revision is created, no
   `revisionOrdinal` is consumed, no slot changes state, and no
   amendment comment is posted (#1094 §9, restated).

## 8. Compatibility and migration

1. **Default off.** With `stagedVerification.enabled` absent or `false`,
   nothing in this document runs: no identity is resolved, no pin record
   is written, no counter exists, and behavior is exactly today's (#1094
   §10 rule 1, #1095 §11 rule 1).
2. **In-flight legacy tasks: absence is the initial state, never a
   migration.** A task that predates the feature has no bundle, no pin
   and no counter, and that is read as "no stage has run", which is
   exactly true. There is **no backfill**: legacy
   `verificationNames`/`verificationPassed` context is never converted
   into a bundle, an identity, a pass or a pin; a prior successful run
   never becomes a `final` bundle; and a prior failure never becomes a
   regression pin. The consequence is conservative and bounded — the
   first final stage runs the full required set, once, per in-flight
   Issue.
3. **Persisted evidence written before a component existed carries it as
   `unknown`.** Not `none`, because the run did happen under some
   environment and some policy, and the runner cannot retroactively
   attest which (§4.1 rule 1). Such a bundle is therefore never valid for
   a use, and is retained, readable and auditable like any other (§4.4
   rule 3). This is the main reason the `none`/`unknown` distinction
   exists.
4. **A `status:stack-ready` marker earned before the feature is not
   retroactively revoked.** Revoking it would break Gate 2 for
   dependents that already branched from that head, which is a larger
   harm than the one it would prevent. The marker's *earning* rule
   changes going forward only. The consequence is stated plainly because
   it is real: for one transition, an Issue may stack on a base that
   never ran a final stage. It is one-time, bounded by the set of
   Issues already marked at enable time, and visible in the stage view
   as an Issue with a marker and no granting bundle.
5. **Unresolved Tool Requests.** A task parked on one never reaches a
   stage run — review admission already refuses it (#681, #918 §12.5) —
   so there is nothing to migrate. A Tool Request that lands *between*
   two stage runs is an ordinary identity change: it moves
   `workingTreeState`, usually `testedRevision`, and — when it installs
   a dependency — the prepare stamp inside `environmentIdentity`, so
   earlier bundles stop being valid and the next stage run resolves
   fresh. A granted Tool Request releases no pin and makes no bundle
   valid. The `tool-request-continuation` lane runs the `loop` stage
   under exactly the rules of every other loop lane (#1094 §4.1).
6. **Operator amendments in flight** — §7.2, in full. Nothing about the
   #1042 grammar, the #1037 revision model, the continuation table or
   the amendment comment changes.
7. **Operator-attested evidence** keeps its shipped rule verbatim: a
   legacy unbound entry is `legacy_unbound` and inadmissible, a bound
   entry is judged by `evaluateVerificationEvidenceBinding` on its own
   four fields, and stage identity is never folded into that evaluator
   (§4.6 rule 3).
8. **Disabling the feature again is not a release.** Stage state is
   retained, inert and readable; nothing is deleted; pins are not
   released; and re-enabling resumes from it with every bundle
   re-validated by identity — most will be invalid because the head
   moved, which is the correct answer.
9. **Session schema.** `stagedVerification` gains two optional fields,
   `maxStageRecoveryAttempts` (§7.3 rule 5) and `environmentIdentity`
   (§4.5), both fail-closed at load. A session written against #1094
   §5.3 or #1095 §3.2 loads unchanged and behaves identically.
   `session.verification` is untouched.
10. **Artifacts and public surfaces.** Per-check log names are preserved
    verbatim (#1094 §10 rule 4). Identity reaches a public surface as
    **component names, their three states, and digests only** — never a
    path, never a dirty-file name, never a command byte, never an
    environment value, never a prepare command. `workingTreeState` in
    particular digests the paths **and the bytes** it covers precisely so
    that no surface has to be careful about them. Pin records reach public surfaces as
    check names, states and counts; case ids stay operator- and
    agent-facing (#1095 §7.6). #1094 §10 rule 5 and
    `docs/environment-prepare-contract.md` §2.7 apply unchanged.
11. **Operator surfaces.** The three §7.4 operations extend the existing
    `admin task-verification` family. No new command family, no new
    label, no new ChatOps verb.

## 9. Implementation mapping — reviewing the downstream slices

This contract adds **no slice** to #1094 §13's twelve, and #1095 added
none either. The chain's twelve implementation/validation slices stand
as written; what follows is the review of each against this design, as
the Issue's fourth acceptance criterion requires.

| #1094 slice | What this contract adds to it |
| --- | --- |
| S1 — pure stage model core | `IdentityComponent` and its three states, `StageEvidenceIdentity`, the §4.4 matching law, `PinRecord` and the §6.4 pin state machine, and the §6.3 release table — all pure functions over already-resolved inputs, no I/O |
| S2 — session schema and fail-closed load | `maxStageRecoveryAttempts` and `environmentIdentity` with their refusals (§7.3 rule 5, §4.5) |
| S3 — stage-scoped execution input | Identity resolution before launch and the end-of-run re-check (§4.3); §5's typed-fact attribution at all three shipped sites; the process-tree-cleanup taint rule (§4.5 rule 3); the §4.3 rule 6 clean-worktree precondition for a final stage |
| S4 — bundle persistence | The identity recorded on every bundle; the project file digest recorded *beside* `selectionPolicyDigest` and never as it (§4.5 rule 2); §7.1's ordinal-before-launch allocation and two observable states; legacy bundles read as all-`unknown` (§8 rule 3) |
| S5 — regression and pin tracking | Pin records, dormancy and re-activation (§6.4), the release table (§6.3), the purchasing-power rule (§6.2), and the arming-but-never-releasing rule for invalid bundles (§4.4 rule 4) |
| S6 — the selection port | Nothing. A selection adapter declares no identity and releases no pin |
| S7 — loop stage wiring, implementation lane | The §7.3 consecutive counter, its reset on a verdict-bearing outcome, and the park at the cap through the lane's existing handoff |
| S8 — loop stage wiring, remaining lanes | The same counter in the review, conflict-resolution and tool-request-continuation lanes; §8 rule 5's Tool Request continuation behavior |
| S9 — final stage and rows 7–13 | Identity validity as a precondition of #1094 §4.4 reuse (§4.6 rule 1); row 12 as the destination for every §4.3 rule 4 `unknown` |
| S10 — the publication gate | The identity re-check inside the one publication transaction (§4.6 rule 2), replacing #1094 §8's head-only binding with the whole tuple; at-most-once grant on the shipped keys (§7.1 rule 5) |
| S11 — operator surface and observability | `stage show`'s identity, pin and attempt views; `stage release`; `stage reset-attempts`; the dormancy and release events; the §8 rule 10 redaction posture |
| S12 — first project integration | Nothing. An adapter contributes no identity component and no pin |

Three statements of the predecessors this contract **sharpens without
changing**, recorded so a reviewer can check the claim:

1. #1094 §6.2 rule 2's "evidence binds to identities, not to time" keeps
   its meaning and gains five more identities (§4.2). The two it named
   are still there and still compared.
2. #1094 §6.3 R2 and R6 keep their membership rules, their arming
   triggers and their union into §4.2's selection exactly. What is added
   is a record, a dormant state that the intersection already produced
   silently, and one audited release (§6).
3. #1094 §8's "head binding at enqueue" keeps its behavior — a moved head
   suppresses the grant and re-queues the stage — and is generalized from
   one component to seven (§4.6 rule 2). No new suppression path exists;
   the existing one simply sees more.

## 10. Invariants

1. The identity component set is closed at seven, and the component
   state set is closed at `value` | `none` | `unknown`. Widening either
   is a change to this document first (§4.1, §4.2).
2. `unknown` matches nothing, including another `unknown`; `none`
   matches `none`. A failure to resolve is always `unknown` and never
   `none`, and an unimplemented or unconfigured source is always `none`
   and never `unknown` (§4.1, §4.4).
3. A bundle is valid for a use only when **all seven** components match.
   There is no partial validity, no component weighting, and no operator
   override (§4.4 rules 1–2).
4. An unresolvable identity makes the stage run `unknown` — the shipped
   #1094 §6.1 outcome, routed through the shipped rows 5 and 12 — and
   costs no check execution, because identity resolution precedes launch
   (§4.3 rules 2 and 4).
5. Invalidation never deletes. Every bundle, pin record and artifact is
   retained with the identity that invalidated it on it (§4.4 rule 3,
   #1037 §8.1).
6. An invalid bundle can arm a pin and can never release one (§4.4 rule
   4, §6.3 rule 4).
7. No identity component is ever supplied, defaulted, corrected or
   contradicted by an adapter, a project file, an agent or a case id;
   dependencies and environment are **declared** and never sniffed, and
   core interprets no lockfile, no version and no path — hashing the
   bytes at a path the shipped status already named is not an
   interpretation of it (§4.3 rule 5, §4.5 rules 1 and 5, #1094 §3.3).
8. Attribution is by typed facts only. No stage outcome, verdict,
   `notRunKind`, pin or fix input is derived from parsing a check's
   output (§5 rule 1).
9. A whole-command timeout is attributed to the check and to no case;
   the last case observed before a deadline is specifically not the
   cause (§5 rule 2).
10. Infrastructure is never fabricated as a code failure and a code
    failure is never laundered as infrastructure; an absent cause is
    `evidence-lost` and never the nearest plausible one (§5 rules 3–4).
11. A single check's `passed` verdict buys only its removal from the
    loop's carried-forward selection. It never releases a regression
    pin, never makes a bundle complete, never satisfies a final stage
    and never grants (§6.2).
12. The release set is closed at `proven` | `final-pass` | `amended` |
    `terminal`; `proven` applies to loop pins only and `amended` to
    regression pins only; and a regression pin's only evidential release
    is the same complete, valid, full-set final pass that grants (§6.3).
13. An id that leaves the required set goes **dormant**, not released;
    dormancy is recorded with its disposition, re-activates if the id
    returns, and a rename is treated as a delete plus an add with no
    matching heuristic of any kind (§6.4).
14. The pin unit is the check. Case ids are optional display detail that
    never become a pin, never narrow one, and never affect a release
    (§6.5, #1095 §5.1).
15. `stageRunId` is the idempotency key; the ordinal is allocated before
    launch; exactly two per-run states are observable; an interrupted
    run is never resumed or partially credited; and the grant is
    at-most-once on the shipped outbox key (§7.1).
16. Non-code stage terminations are bounded by a consecutive per-Issue
    per-stage budget that resets on any verdict-bearing outcome, never
    interacts with a repair cap, never extends a bound #1094 set, and
    parks through the lane's existing human handoff at the cap (§7.3).
17. Operator recovery is a closed set of three audited operations on
    runner state, each refusing on an active or terminal task; none of
    them grants, marks a stage passed, edits a bundle, validates a
    mismatched identity, resumes a run, or creates a plan revision
    (§7.4).
18. Enabling the feature migrates nothing: absence of stage state is the
    initial state, no legacy context becomes a bundle, an identity or a
    pin, and no existing `status:stack-ready` marker is retroactively
    revoked (§8 rules 2–4).
19. Public surfaces carry component names, states, digests, check names
    and counts only — never a path, a dirty-file name, a command byte,
    an environment value or a case id (§8 rule 10).
20. No new store, table, column, scheduler, lock, command family, label,
    ChatOps verb, phase-runner vocabulary member, stage, stage outcome,
    verdict, selection source, transition row or grant path is
    introduced (§3, §6.1 rule 3, §7.4, §8 rule 11).
21. Default-off: an un-opted-in session behaves exactly as today (§8
    rule 1).

## 11. Test seams and matrix

For the implementation slices that build against this contract — the
docs pin is the only test landing with #1096 itself:

| Area | Cases |
| --- | --- |
| Component states (§4.1) | Every resolution failure yields `unknown` and never `none`; an unconfigured or unimplemented source yields `none` and never `unknown`; each `unknown` carries a reason and the reason is never parsed; the #916 `unknown`-evaluates-as-absent rule is not applied to identity |
| The matching law (§4.4) | `value`/`value` equal matches, unequal does not; `none`/`none` matches; `unknown` fails against `value`, against `none`, and against another `unknown`; a seven-component identity with one mismatch is invalid; no subset comparison exists; no flag, session value or recovery act makes a mismatched identity valid |
| Components (§4.2, §4.5) | A loop stage at an unchanged head with a changed agent diff produces a different `workingTreeState` and an invalid earlier bundle; re-editing an already-modified tracked file and re-writing an already-present untracked file each move `workingTreeState` even though the porcelain status entry is byte-identical; an untracked path listed as a collapsed directory is enumerated file by file; a path the status lists and the seam cannot read makes the component `unknown` rather than dropping it; a #1037 §6.4 plan-neutral drift moves the live `sessionBaselineDigest` while `planDigest` and the stored checkpoint baseline are both byte-identical, and invalidates prior bundles; a live baseline that differs from a stored one resolves `unknown` until #1037's rebase; a refused #1095 project file leaves `selectionPolicyDigest` equal to the absent-file value while the separately recorded file digest differs; a dependency install through a Tool Request moves the prepare stamp inside `environmentIdentity`; core interprets no lockfile, no tool version and no path to resolve any component, and the `workingTreeState` fingerprint hashes bytes it never reads for meaning |
| Resolution and preconditions (§4.3) | Identity is written before the first check launches; an unresolvable component makes the run `unknown` with zero checks executed; a mid-run change to any of the seven makes the run `unknown` at the end-of-run re-check; a `final` stage on a tracked-file-dirty worktree is `unknown` at launch and routes to row 12; untracked non-ignored paths do not block a final launch and do change `workingTreeState`, including when only their contents changed; a `loop` stage on a dirty worktree runs normally |
| Uses (§4.6) | #1094 §4.4 reuse requires a matching identity in addition to every shipped condition; the row-7 grant re-resolves and re-compares identity inside the publication transaction and suppresses the grant on any mismatch; `evaluateVerificationEvidenceBinding` is called unchanged with its four shipped fields and its closed rejection set; retention, display and audit are unaffected by validity |
| Attribution (§5) | No verdict, outcome, `notRunKind`, pin or fix input is derived from stdout or stderr; a timed-out check attributes to the check and names no case, and the last case in a `partial` envelope is not the cause; a spawn error and a cleanup that could not confirm termination are `infrastructure` and reach no agent; a nonzero exit is never demoted to `infrastructure`; an unexplained absence is `evidence-lost`; a set-level stop is recorded per affected check and never collapsed onto one |
| Pin records (§6.1) | A record is written for every armed id with its arming run, revision and reason; arming an already-released id appends rather than rewrites; no adapter, project file or agent value reaches a field; a pin consumes no `revisionOrdinal` and creates no revision; only `checkId`, `kind` and `state` reach the selection union |
| Purchasing power (§6.2) | A loop-stage `passed` for a regression-pinned id does not release it; a final-stage `passed` for that id inside an incomplete bundle does not release it; a #1040 manual entry does not release it; a complete passing final stage releases it and grants in the same event; a loop pin is released by a proving pass and the check still runs in the next final stage |
| Releases (§6.3) | Each of the four kinds fires only on its own condition; `proven` refuses on a regression pin and `amended` on a loop pin; a pass inside an invalid bundle releases nothing while its failures still arm; a released pin is reported released and never passed; `admin review-verification resolve`'s evidence clearing releases nothing |
| Dormancy (§6.4) | A retired, orphaned or masked id goes dormant with its disposition recorded and leaves the selection; the same `commandId` returning re-activates the pin with its original arming record; a renamed check leaves a dormant pin that never re-activates and a new unpinned id; no byte-similarity or name-similarity heuristic exists; a dormant pin is still released only by the §6.3 table; the final stage runs the renamed check in full |
| Case detail (§6.5) | The pin is the `commandId` for every envelope kind and for a timed-out check; `observedFailingCaseIds` is absent for `unknown`, `unavailable`, `unreadable`, `conflicting` and timed-out checks and the pin is otherwise identical; case detail reaches no selection, release, completeness or grant decision; matching is on `checkId` and never on `observedName` |
| Idempotency (§7.1) | The ordinal is allocated before launch and advances on every launched run; a crash leaves an allocated ordinal with no bundle and reconciles as `interrupted`; no state has pins moved without a bundle or a grant without a bundle; a replayed publication re-records and re-enqueues nothing; a retry starts from the first check with a fresh identity and a fresh ordinal |
| Amendment in flight (§7.2) | #1037 §7.1's `claimed`/`running` refusal is exercised unchanged; a mid-run `sessions.json` edit is caught by the end-of-run re-check reading the live layer — with the stored checkpoint baseline unmoved and no rebase performed by this contract — and re-runs after the #1037 rebase; a drift that landed before launch is `unknown` at launch through the live-versus-stored divergence; an amendment between runs invalidates earlier bundles and sends departed ids dormant with no carry-over logic; the final-to-publication window is closed by the `running` refusal plus the one transaction; a stale lease reconciles to `interrupted` and credits nothing |
| Bounded retries (§7.3) | Consecutive `interrupted`, `unknown` and `infrastructure` terminations count; `passed`, `code-failed` and `timed-out` reset the counter; no repair cap moves; row 5's single re-run is not extended by the budget; the cap parks through the lane's existing handoff naming the stage, the count, the last outcome and every `unknown` component; a zero, negative or non-integer `maxStageRecoveryAttempts` refuses the session; no backoff policy is added; a parked task keeps every pin and every bundle |
| Operator recovery (§7.4) | Each of the three operations does exactly its row and nothing in its "can never" column; all three refuse on `claimed`, `running` and terminal tasks, guard on the task-revision CAS, exit non-zero on refusal and mutate nothing; every act appends an audit event with operator, reason and observed revision; no operation marks a stage passed, forces a grant, edits a bundle, validates a mismatched identity, resumes a run or creates a revision |
| Migration (§8) | Flag-off resolves no identity and writes no record; a legacy task starts with absent stage state and no backfill from `verificationNames`/`verificationPassed`; a pre-feature bundle reads all-`unknown` and is never valid for a use; an existing `status:stack-ready` marker survives enabling and is visible as a marker with no granting bundle; a parked Tool Request reaches no stage run and a granted one invalidates prior bundles without releasing a pin; disabling the feature releases no pin and deletes nothing; a #1094-era and a #1095-era session both load unchanged |
| Redaction (§8 rule 10) | A public summary carries component names, states, digests, check names and counts and no path, dirty-file name, command byte, environment value or case id; `workingTreeState` never exposes a path and never exposes a fingerprinted byte; log artifact names are preserved verbatim |
| Docs pin | `test/docs-verification-evidence-validity-contract.test.js` pins this document's status line, chain position and no-runtime-behavior claim, the deferrals to #1094, #1095 and the fixed predecessor contracts, the shipped-mechanism map, the three-valued component with its never-`none`-from-failure and unimplemented-is-`none` rules and its stated divergence from #916, the closed seven-component tuple with `selectionDigest` excluded, the resolve-before-launch and end-of-run re-check rules with the clean-worktree final precondition, the matching law with `unknown` matching nothing including itself and the arms-but-never-releases asymmetry, the declared-never-sniffed dependency and environment rule, the typed-fact attribution rules with the timeout-has-no-failing-case and both-directions infrastructure rules, the pin record with its append-only and no-revision rules, the purchasing-power rule, the closed four-kind release table, dormancy with its rename-is-a-delete-and-an-add rule, the check-level pin with optional case detail, the idempotency key with its two observable states, the amendment-in-flight rules resting on #1037 §7.1, the bounded consecutive-retry budget with its reset and its never-extends-#1094 rule, the three closed operator recovery operations, the no-backfill migration rules including the non-revoked marker, the invariants, the implementation mapping that adds no slice, and the reconciliation notes in `docs/staged-verification-contract.md` §15, `docs/project-verification-contract.md` §15, `docs/verification-amendment-contract.md` §17, `docs/verification-execution-contract.md` §16, `docs/feature-status.md`, and `docs/DOMAIN.md` §5 where present — against drift |

## 12. Non-goals and forward pointers

This document defines evidence validity, pinned regressions and bounded
recovery only. It does not define, and nothing implementing it should
assume:

- **The artifact layout, event payload shapes and CLI output
  formatting** — what a bundle file is called, how an identity is
  serialized on disk, the exact JSON of a dormancy or release event, and
  the column layout of `stage show`. This contract fixes what is
  recorded and what it means; the shapes belong to #1094 §13's S4 and
  S11.
- **A second evidence model.** Stage bundles remain #1094 §6.2's;
  operator-attested evidence remains #1040's; per-slot invalidation
  records remain #1037 §8.3's. Nothing here merges, replaces or
  re-expresses one in another's terms.
- **Flake detection, rerun-to-green, quarantine, coverage thresholds or
  test-suite quality metrics** — #1094 §11, #918 §6.3 and §16. The §7.3
  budget bounds *non-code* terminations precisely so that it can never
  become a retry of a failing check.
- **Test maintenance of any kind** — no deletion, restructuring,
  renaming, skipping or quarantining, and no mutation-testing engine
  (#1094 §11). A dormant pin is not a disabled check; a released pin is
  not a removed check.
- **A periodic audit scheduler or a background re-validation sweep.**
  Every identity resolution and every comparison happens inside a phase
  the runner was already executing (#1094 §11).
- **Chain-level or cross-Issue evidence.** Pins are Issue-local by
  construction and no aggregate bundle, chain-merge gate or "the whole
  stack passed" artifact exists (#1094 §4.1 rule 1).
- **External CI integration** — GitHub checks, external runners and
  status-based grants remain out of scope; verification is the runner's
  own execution.
- **Environment preparation policy, platform attestation policy, the
  execution backend, the preflight Execution Plan or the grant tiers** —
  `docs/environment-prepare-contract.md`, #916, #917, #915 and #697 own
  them. §4.5 reads their identities and changes none of their rules.
- **Any change to `session.verification`, the amendment surface grammar,
  the ChatOps verb table, the label vocabulary, review admission, the
  review agent, the dispute machinery, or the session schema beyond §8
  rule 9's two additive fields** — governed by their own contracts and
  by #1094 and #1095.
