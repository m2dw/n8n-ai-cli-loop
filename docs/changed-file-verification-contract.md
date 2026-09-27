# Changed-file / full-suite verification contract

Status: **approved design** (issue #1158, replacing the abandoned #1151
draft). The document itself is a specification; the runtime wiring of
both stages into the lanes landed in issue #1154, and the operator's
later approval of decisions D5 and D6 was applied by issue #1165. This
document is the authoritative contract for test verification of an
Issue in two stages: **Stage 1** runs the test files the Issue changed
plus the files a full run of this Issue has failed, and **Stage 2** runs
the full configured test suite once review approves a revision whose
Stage 1 passed. It replaces the selection policy of the staged
verification chain (#1094–#1108). It is not a second mode beside that
policy.

Availability is tracked in the
[Staged verification](feature-status.md#staged-verification-loop-and-final-stages)
row of `docs/feature-status.md`.

The scope is deliberately small. It reuses the shipped command
execution, deadlines, process-group cleanup, artifacts, locks, stage
run ledger, bounded recovery and human handoff. It adds no process
manager, launch gate, handshake or claim-file protocol, scheduler,
operator command, configuration migration, compatibility mode or
old-setting detector. The operator removes old configuration.

## 0. Authority

### 0.1 Approved operator requirements

These four requirements are the operator's, approved for this
replacement. Everything else in this document serves them. Six further
operator decisions, **D1–D6**, are approved and recorded in §10.1; they
are settled, not open questions. No decision this contract depends on is
left open.

1. **O1 — Stage 1 selection.** Stage 1 runs exactly the runnable test
   files added or modified in the cumulative diff from the Issue base to
   the current worktree, plus the retained files that failed a prior
   Stage 2 of this Issue. No impact inference, no related-test
   heuristics and no hand-maintained command categories.
2. **O2 — Stage 2 entry.** A passing Stage 1 and AI review approval **of
   the same revision** allow Stage 2: the full configured test suite.
3. **O3 — Stage 2 outcome.** A full success permits stack-ready. A full
   failure retains the genuinely failed files and returns the Issue to
   implementation and Stage 1. Retained files stay selected after they
   pass, until the Issue completes.
4. **O4 — No false satisfaction.** A partial or empty Stage 1 never
   satisfies a full-suite requirement. That pending, final-only
   requirement never prevents the review needed to reach Stage 2.

### 0.2 Retirement of the old selection-policy authority

**The staged verification contracts no longer have authority over test
selection.** For the subjects this document covers — what a stage
selects, what a stage run's evidence means, what an Issue retains, how
a stage run routes and when it publishes — this document is the only
normative source. A rule in `docs/staged-verification-contract.md`
(#1094), `docs/project-verification-contract.md` (#1095) or
`docs/verification-evidence-validity-contract.md` (#1096) binds this
replacement **only when §8 restates it**. Those documents stay as the
record of what #1094–#1108 shipped and as a map of reusable code. They
are not a rule-by-rule inheritance chain.

## 1. Terms

- **Issue base**: the one commit this Issue's cumulative diff is taken
  from (§4.1).
- **Revision**: the exact repository content a stage run tests: a commit
  plus any uncommitted content, attested through the existing evidence
  identity (§8 invariant 1).
- **Runnable test file**: a repository-relative path the project's test
  tooling reports as a test file it can run, at the revision under test.
  Core never decides what a test file is.
- **Retained set**: the Issue-scoped set of test files with a trusted
  `failed` outcome in a `failed` Stage 2 of this Issue, including a
  fail-fast run with `not-run` files (§4.3).
- **Suite binding**: the operator-owned setting in the session's stage
  configuration that names exactly one `session.verification` key as
  the test suite entry, binds the test adapter to it, and optionally
  declares which Issue-requirement command texts that entry discharges
  (§6 rule 5).
- **Test suite entry**: the one `session.verification` entry the suite
  binding names. Every other configured entry is a **non-test check**.
  Core never infers the suite from a key name, a command string, the
  project or an AI judgment.
- **Stage 1** and **Stage 2**: the changed-file stage and the full-suite
  stage. The shipped stage identifiers `loop` and `final` may keep their
  names.
- **Existing handoff**: the lane's shipped human handoff (park for an
  operator). Parking preserves the worktree and all recorded evidence.

## 2. Shared information between boundaries

A stage run crosses four boundaries: **selection → execution →
recording → publication**. This table is the minimum semantic
information they share. It fixes meanings, not storage: field names,
types, serialization, schema and digest encodings belong to #1153.

| Information | Meaning | Produced by | Needed by |
| --- | --- | --- | --- |
| Stage | Stage 1 or Stage 2 | Lane | All |
| Suite binding | The test suite entry's key, the test adapter bound to it, the command of the active effective-plan slot that key resolves to, with that plan's identity, and any declared Issue-requirement commands that entry discharges (§6 rule 5) | Operator configuration, validated at load; command bytes reconciled through the effective verification plan | Selection, execution, recording, routing |
| Revision | The content under test, at launch, again at the end and again inside the recording completion | Selection, execution, recording | Recording, publication |
| Issue base | The commit the cumulative diff is taken from | Selection | Recording |
| Selection status | `known` with a file list (possibly empty), or `unavailable` with a reason | Selection | Execution, recording |
| Selected files | Each path with why it is selected: `changed`, `retained`, or both | Selection | Execution, recording, publication |
| Unresolved retained files | Retained paths that are not runnable at the revision | Selection | Recording, publication |
| Execution mode | `files` with a non-empty list, or `full` | Lane | Execution, recording |
| Per-file outcome | `passed`, `failed`, `skipped` (reached, no test executed) or `not-run` (never reached, for example after a fail-fast stop) | Execution | Recording |
| Outcome trust | `trusted` when the run ended on its own (no deadline, interruption or spawn failure), its result is readable and it reports an outcome for exactly the requested files (in `full` mode, every file the tooling reports runnable in the same run), counting `not-run` as an outcome; otherwise `untrusted` with exactly one reason: `deadline` (the run exceeded its configured deadline), `interrupted`, `spawn-failure`, `unreadable-result` or `mismatched-files`. Untrusted per-file outcomes are never credited, whatever the reason; a run that nevertheless recorded a `failed` process result is still R6 or R7, and otherwise the reason decides the result (R8 versus R9) and so the route | Execution | Recording |
| Process result | `succeeded` (zero exit) or `failed` (nonzero exit) for the whole command, recorded whenever the run ended on its own. A nonzero exit with no `failed` file outcome that the host-failure classification does not recognize is a **suite-level failure** (for example a global setup or teardown failure, or a coverage threshold), whether the remaining files are `passed`, `skipped` or `not-run` | Execution | Recording |
| Host-failure classification | Whether the shipped classification of a nonzero run reads its failure as about the host or environment rather than the change: `stageCheckHostFailure` (`src/core/stage-run.ts`) over the shipped `environmentSignal` and `transientSignal`. Reused as shipped; this contract adds no classifier and widens none | Existing verification classification | Recording |
| Completeness | `complete` when outcomes are trusted, the process result is `succeeded` and no file is `not-run`; otherwise `incomplete` with a reason (untrusted, suite-level failure, or a file `not-run`) | Execution | Recording |
| Termination | `confirmed` or `unconfirmed` for every process the run launched | Execution | Recording |
| Launch and termination evidence | Durable facts the run records through the existing stage-run state as they happen: that it is about to launch a process, recorded before that launch, and the runner's cleanup confirmation once its processes end. Only these recorded facts can later prove that a started run with no result launched nothing or left nothing running (§3 R1); nothing a recovering worker observes afterwards stands in for them | Execution | Recording, recovery |
| Evidence identity | The revision and configuration identity, each `attested` with a value or `unattested`, at launch, again at the end and again inside the recording completion (§8 invariant 1) | Selection, execution, recording | Recording, publication |
| Non-test check records | The shipped per-check records for the revision | Existing verification | Routing, publication |
| Result | One row of §3 | Recording | Routing, publication |
| Failure evidence | The stage, the revision if known, what was attempted, the failure reason and the shipped bounded output tail or artifact | Any boundary | Recording, handoff |
| Retained set | Retained paths, each with the Stage 2 run that added it | Recording | Selection, publication |
| Review approval | The revision the AI reviewer approved | Review lane | Routing, publication |

Boundary invariants:

1. **Selection → execution.** An `unavailable` selection is never
   passed on as an empty list, and an empty known list never reaches
   execution. `full` is its own mode, never a `files` request with an
   empty or absent list.
2. **Execution → recording.** Per-file outcomes are credited only when
   outcome trust is `trusted`. A trusted `failed` outcome stands even
   when other files are `not-run` or the process result is `failed`;
   those files stay unproven. `passed` file outcomes never make a run
   whose process result is `failed` pass. `skipped` and `not-run` are
   never merged with each other or with `passed`. The process result is
   a **run-level** fact, not a per-file outcome: a recorded nonzero exit
   at an attested, unchanged identity is a failure (`infrastructure` or
   `failed`, §3) whatever the outcome trust, and losing trust in the
   per-file outcomes costs the run its retentions, never its failure. At
   an unattested or changed identity the identity decides first (§3 R4,
   R5).
3. **Recording.** Failure evidence can be recorded before any inventory,
   selection or per-file outcome exists. A missing field is never read
   as empty, passed or zero. The result, any retained-set change and any
   stack-ready decision are committed together.
4. **Recording → publication.** Publication never re-derives a stage
   result: it takes the recorded result and retained set as given and
   never recomputes them from outcomes, selection or evidence. It does
   read and re-attest every *other* grant prerequisite inside the
   granting completion — the live revision and configuration identity
   (§8 invariant 1), the required non-test check records for that
   revision and the review approval (§5 rule 1) — and withholds the
   grant when any of them is missing, failing or changed. Reading them
   can only withhold a grant; it never turns a recorded non-`passed`
   result into a grant. Publication never describes Stage 1 as a suite
   pass or a skipped file as passed.

## 3. Semantic result table (normative)

Every stage run records exactly one result. **This is the only place a
result is defined.** Later sections name results and never restate
their conditions. When several rows apply, the first row wins, so the
identity rows R4 and R5 decide before any execution outcome (R6–R9).
**Every run classifies**, including a complete Stage 1 whose selected
files are all `skipped`: decision D6 (§10.1) records it as `empty`
(R10), never as a pass.

| # | Result | Stage | Defining condition |
| --- | --- | --- | --- |
| R1 | `termination-unknown` | 1, 2 | Termination of a process the run launched is not confirmed; or a run is found that started and has no recorded result, and its recorded launch and termination evidence (§2) does not prove either that it launched no process or that cleanup confirmed termination of every process it launched. **Unconfirmed termination is what this row is for.** Nothing the recovering worker observes stands in for that evidence — not the earlier worker's death, a superseded allocation, the absence of a visible process or the absence of a recorded process identifier — because a worker that died before launching and one that died just after launching an orphan look the same afterwards. Only a started run with no recorded result whose recorded evidence proves no launch, or confirmed termination of every launched process, is resolvable: it is R9, recovered under the bounded budget rather than parked (§5 rule 3) |
| R2 | `unavailable` | 1, 2 | An input the stage uses cannot be read: in Stage 1 the Issue base, the cumulative diff, the runnable-file report or the retained set, so no selection is known; in Stage 2 only the runnable-file report or the retained set (Stage 2 selects nothing from the Issue base or the diff, so neither being unreadable affects it). Or, in either stage, the **launch-time** plan check refuses to start the run: as the stage launches, another active configured slot's command is equivalent to the bound test suite entry's active command, so the suite to run is ambiguous (§6 rule 2), or the effective verification plan holds no active slot for the bound suite key, so there is no suite command to run (§6 rule 5). **Both plan conditions are launch-time input validation and nothing else.** A plan amended *after* the run launched — the bound slot retired, or a duplicate introduced — changes the configuration identity, so it is R5, never this row; this row can only pre-empt R5 for a plan that was already ambiguous or unbound when the run launched |
| R3 | `retained-unresolved` | 1 | Selection is otherwise known, the revision and configuration identities are attested and unchanged from launch through the completion re-check (so neither R4 nor R5 applies), but at least one retained file is not a runnable test file at the revision. An unattested or changed identity is R4 or R5 instead, never R3 |
| R4 | `identity-unknown` | 1, 2 | The revision or configuration identity is `unattested` at launch, at the end or at the completion re-check (§8 invariant 1), so the evidence matches nothing — including a nonzero exit, which this row pre-empts (R7) |
| R5 | `stale` | 1, 2 | The attested revision or configuration identity at the end or at the completion re-check (§8 invariant 1) differs from the one at launch, or a Stage 2 revision differs from the approved revision — including a run that exited nonzero, which this row pre-empts (R7) |
| R6 | `infrastructure` | 1, 2 | The process result is `failed` and the shipped host-failure classification (§2) recognizes the failure as about the host or environment, not the change. Whatever the per-file outcomes say, they credit nothing and retain nothing: a host failure says nothing about which files the change broke. The classification is the shipped one; a nonzero exit it does not recognize is R7 |
| R7 | `failed` | 1, 2 | Either the process result is `failed` and R6 does not apply — **whatever the outcome trust**, so an unreadable or mismatched adapter result never downgrades a recorded nonzero exit — or outcomes are trusted and at least one file is `failed`; in both cases whether or not other files are `not-run` (a fail-fast stop, or a global setup failure before the remaining files run). **Every known nonzero process result at an attested, unchanged identity that R6 does not recognize is a code-level failure**, never an incomplete run to re-run: a nonzero exit with no `failed` file outcome is the suite-level failure of the Process result row. **R4 and R5 come first.** A nonzero exit whose identity is unattested or changed belongs to no revision this contract can repair against, so it records R4 or R5 and routes as that row does; its bounded output tail stays in the failure evidence, and the re-run is a new run at the live identity, where a genuine failure fails again and records this row. A run that did not end on its own records no process result at all (§2), so a deadline overrun, an interruption or a spawn failure is never this row. Only a *trusted* explicit `failed` file outcome is ever retained, so an untrusted nonzero run reports the failure and retains nothing; `not-run` files stay unproven |
| R8 | `timed-out` | 1, 2 | Execution was attempted, termination is confirmed for every process the run launched, and outcome trust is `untrusted` with reason `deadline`: the run exceeded its configured deadline and was cleaned up. Its per-file outcomes are untrusted and credit nothing, exactly as in R9 — the run is separated from R9 only because overrunning the deadline is treated as the suite's own defect, not as host noise |
| R9 | `incomplete` | 1, 2 | Termination is confirmed for every process the run launched — vacuously so when it launched none — and either execution was attempted and completeness is `incomplete` or any file is `not-run`, or the run started and recorded no result at all. R6 and R7 win first for every run whose process result is `failed`, so this row never re-runs a known nonzero execution: it covers untrusted outcomes whose reason is not `deadline` **and that recorded no `failed` process result**, a trusted zero-exit run that left a file `not-run`, and a started run with no recorded result whose recorded launch and termination evidence proves that it launched no process or that every process it launched was confirmed terminated (R1). A spawn failure the run recorded is an attempt: it launches no process, so termination is vacuously confirmed and outcomes are `untrusted` |
| R10 | `empty` | 1 | Selection is known and empty, so nothing is executed; **or** the run is complete, reached every selected file and `skipped` every one of them, so no test executed (decision D6). Both are the same fact — Stage 1 produced no test evidence — so both permit review and require Stage 2, and neither is ever reported as a pass or credited against the full-suite requirement (O4). An all-`skipped` run is R10 even though it executed the suite's command, because a `skipped` file is never merged with a `passed` one (§2 invariant 2) |
| R11 | `passed` | 1 | Complete, no file `failed`, at least one selected file `passed`, the rest `skipped` |
| R12 | `no-evidence` | 2 | Complete, no file `failed`, and no file `passed`: an empty runnable-file report, or every file `skipped` |
| R13 | `passed` | 2 | Complete, no file `failed`, at least one file `passed`, the rest `skipped` |

What each result is allowed to mean:

| Result | Counts as a passing Stage 1 (O2) | Satisfies the full-suite requirement (O4) | Changes the retained set |
| --- | --- | --- | --- |
| `termination-unknown`, `unavailable`, `retained-unresolved`, `identity-unknown`, `stale`, `infrastructure`, `timed-out`, `incomplete` | No | No | No — an `infrastructure` run's outcomes say nothing about the change and a `timed-out` run's are untrusted, so neither retains anything |
| `failed` (Stage 1) | No | No | No |
| `failed` (Stage 2) | — | No | Adds every `failed` file a trusted outcome names; `not-run` files are not added, an untrusted run adds none, and a suite-level failure adds none |
| `empty` (Stage 1) | **Yes** — it permits review and Stage 2 | No | No |
| `passed` (Stage 1) | Yes | No | No |
| `no-evidence` (Stage 2) | — | No | No |
| `passed` (Stage 2) | — | **Yes** | No — it never clears a retained file |

Non-test checks keep their shipped execution, classification and
routing. Their records sit beside a stage result and never change it,
so a Stage 2 `passed` result alone does not grant (§5 rule 1). **Stage 2
still executes every required non-test check at the approved revision,
exactly as the shipped final stage does** (§10.1 decision D3): this
contract changes test selection only, so nothing here optimizes those
checks away or reuses a loop record in place of running them. A required
non-test check without a passing record for the revision blocks
stack-ready exactly as it blocks progress today.

## 4. Selection

### 4.1 Issue base and cumulative net change

1. **The Issue base is fixed, and moves only on an accepted predecessor
   update.** For an Issue with a predecessor it is the predecessor head
   the shipped dependency flow records (`dependencyBase.baseHeadSha`).
   Otherwise it is the base-branch commit the Issue branch started from.
   It is never the previous run's head, never a moving branch tip and
   never recomputed by a fetch.
   **Decision D5 (§10.1) settles the re-base.** The base advances to a
   new predecessor head exactly when the shipped dependency flow
   explicitly incorporated that head into this Issue's branch *and*
   recorded it together with an attestation that the predecessor was
   accepted at that exact commit — stack-ready again for that head, or an
   equivalent authoritative successful completion signal. **A moved ref,
   a force-push and a bare fetch change nothing**: they supply no
   acceptance, so the recorded base stands and a selection that cannot
   reconcile the two is `unavailable`, never silently re-based. A base
   this contract never resolved against a predecessor never advances, and
   the advance is recorded as part of the Stage 1 selection that performs
   it, so persisted state refuses a rewrite that declares nothing.
   **A declaration is refused just as firmly when it moves nothing.** A
   selection that names the base already recorded advanced nothing, so a
   declaration there — a stale advance computed before another run moved
   the base onto that same commit — is refused rather than recorded: it
   would persist a selection claiming a re-base while the evidence and
   the approval that re-base is supposed to invalidate stay valid.
   **The base a Stage 1 selects against is the one its own run
   resolved**, not the one the stored task still names: the lane holds
   the accepted predecessor head — or the resolved fact that there is no
   predecessor at all, once a blocker has closed — before its completion
   persists either, and the same run's completion is what rewrites the
   recorded `dependencyBase`. A resolved absence is stated, never
   silently replaced by the stored value; a run that never resolves a
   plan (a repair run) reads the recorded one, exactly as its completion
   preserves it.
   Once the base advances, the test files the Issue inherits from its
   predecessor sit below the new base and are **not** this Issue's
   changes. The retained set is unchanged by the advance — an obligation
   is the Issue's, not a revision's (§4.3 rule 2) — while every stage
   result and review approval recorded against the old base is
   invalidated: the re-based branch is a new revision, so earlier stage
   evidence matches nothing (§8 invariant 1), and reaching a grant again
   needs a fresh Stage 1, a fresh approval of that revision and a fresh
   Stage 2. **No bundle is exempt, including the one a live stack-ready
   grant rests on, and the pin that names it is dropped with it.** An
   accepted predecessor head that was already an ancestor leaves the
   Issue branch head where it was, so a retained granting bundle would
   still match that head and its identity — and a fresh approval alone
   would then republish the grant with no Stage 2 run after the advance.
   The invalidation is therefore stronger than the retention floor that
   would otherwise keep the granting bundle: an advance drops every stage
   result the Issue holds, and the stack-ready marker is republished only
   by the completion that records the fresh Stage 2.
   **An approval still waiting on its own final stage is dropped by the
   same write.** It is an approval of the pre-advance revision, held
   outside the stage results and bound only to the approved head, so an
   already-ancestor predecessor head would leave it binding to an
   unchanged branch head — and the next review would resume on it, skip
   its reviewer and run the mandatory Stage 2 under an approval of a base
   the Issue has left. Advancing the base and evicting that approval are
   one write, never two.
2. **The cumulative change is net.** It is the set of paths whose
   complete Git tree entry at the revision differs from the Issue base
   (content, file mode or entry type, so a mode-only change such as
   `chmod +x` is a modification): committed, staged and unstaged edits,
   plus untracked files that are not ignored. A path edited and then
   restored to its base entry is not changed. A rename is a deleted old
   path plus an added new path.
3. **Unreadable is never empty.** A missing base, a base commit absent
   from the object store or a failed diff is `unavailable`.

### 4.2 Stage 1 selection

> **Selected = (changed paths that are runnable test files at the
> revision) ∪ (retained files)**

| Path | Selected in Stage 1 |
| --- | --- |
| Added, modified or untracked runnable test file | Yes (`changed`) |
| Renamed runnable test file | The new path yes; the old path selects nothing |
| Deleted test file | Nothing |
| Changed path that is not a runnable test file (source, helper, fixture, config) | Nothing — Stage 2 covers it |
| Retained file that is runnable | Yes (`retained`), whether or not it changed or has passed since |
| Retained file that is not runnable (deleted or renamed) | Recorded as unresolved; the run is `retained-unresolved` and executes nothing |

The selection is deterministic for a given revision, base and retained
set. Nothing is inferred from imports, names, history or an AI
judgment.

### 4.3 The retained set

1. **Only a `failed` Stage 2 adds**, and it adds exactly the files whose
   outcome is `failed`. `skipped`, `not-run` and every file of a run
   whose outcomes are untrusted are never added.
2. **Nothing removes an entry before the Issue completes.** A later pass
   in either stage and a stack-ready grant keep it.
3. **An unresolved entry is never dropped.** A retained file that is
   legitimately deleted or renamed stays an explicit unresolved
   obligation: it stays retained, the run parks through the existing
   handoff (§5), and nothing discards it silently. No release surface
   exists in this chain; adding one is deferred to a separate future task
   (§10.1 decision D2).

## 5. Transition table (normative)

Routes use only the shipped phase-runner vocabulary: continue, the
existing repair and `needs_fix` requeue, the existing delayed retry
under `maxStageRecoveryAttempts`, and the existing handoff.

| Stage | Result | Next action | Publication (stack-ready) |
| --- | --- | --- | --- |
| 1 | `passed`, `empty` | Implementation lane: continue (commit, push). Review lane: run the AI reviewer; on approval of this revision run Stage 2. An `empty` Stage 1 — nothing selected, or everything selected `skipped` (D6) — takes this row unchanged: it records no test execution, reaches review, and makes Stage 2 mandatory rather than optional, because nothing else can satisfy the full suite | Not granted |
| 1 | `failed` | Existing repair and `needs_fix` requeue under the existing cap; the fix input names the failing files, or the suite-level failure with its bounded output tail | Not granted |
| 1 | `timed-out` | Existing repair and `needs_fix` requeue under the existing cap, as `failed` (rule 2); the fix input names the deadline, the selected files and the bounded output tail, and credits no file outcome. Never an automatic re-run | Not granted |
| 1 | `incomplete`, `unavailable`, `identity-unknown`, `stale` | Re-run Stage 1 from the beginning at the live revision, under `maxStageRecoveryAttempts`, then park. Never a full-suite fallback | Not granted |
| 1 | `infrastructure` | Existing host retry: re-run Stage 1 at the live revision without invoking an agent, under `maxStageRecoveryAttempts`, then park. Never repair, never a full-suite fallback | Not granted |
| 1 | `retained-unresolved`, `termination-unknown` | Park through the existing handoff, naming the unresolved files or the unconfirmed run. Never re-run automatically | Not granted |
| — | Review not approved | Existing review routing; Stage 2 does not run | Not granted |
| 2 | `passed` | Run the required non-test checks at the approved revision as the shipped final stage does (§3). If every one has a passing record for this revision, grant in the completion that records the result. Otherwise withhold and route the failing check by its shipped routing; the Stage 2 result stays recorded | **Granted** only with every required non-test check passing; otherwise withheld |
| 2 | `failed` | Retain the failing files (§4.3), `needs_fix` to implementation under the existing review cycle cap; the next cycle starts at Stage 1. Files `not-run` after a fail-fast stop stay unproven and are covered by the next Stage 2 | Withheld; a live marker is cleared |
| 2 | `timed-out` | `needs_fix` to implementation under the existing review cycle cap, as `failed` (rule 2); the next cycle starts at Stage 1. Nothing is retained, because no outcome is trusted. Never an automatic re-run. This matches the shipped `routeFinalStageBundle`, which already routes `timed-out` to repair | Withheld; cleared |
| 2 | `incomplete`, `identity-unknown` | Re-run Stage 2 at the same approved revision, under `maxStageRecoveryAttempts`, then park | Withheld; cleared |
| 2 | `infrastructure` | Existing host retry: re-run Stage 2 at the same approved revision without invoking an agent, under `maxStageRecoveryAttempts`, then park. Nothing is retained. This keeps the shipped `routeFinalStageBundle` `host-retry` route | Withheld; cleared |
| 2 | `stale` | Return to Stage 1 and review at the live revision; Stage 2 runs again only after approval of that revision. Never a Stage 2 re-run at an unapproved revision | Withheld; cleared |
| 2 | `no-evidence`, `unavailable`, `termination-unknown` | Park through the existing handoff. Never re-run automatically. A Stage 2 that ran the whole suite and skipped every file, or whose runnable-file report was empty, is exactly this row (D6): a full run that proved nothing needs a human, and repeating it would only skip everything again | Withheld; cleared |

Rules:

1. **Only Stage 2 `passed` grants.** It requires the same revision to be
   the Stage 1 revision, the approved revision, the Stage 2 revision and
   the live revision re-attested inside the granting completion (§8
   invariant 1), and every required non-test check to have a passing
   record for that revision.
2. **A code failure is never retried to green.** `failed` always goes to
   repair, including a trusted fail-fast result with `not-run` files and
   a nonzero run whose files are `not-run` for any other reason, such as
   a global setup failure before the remaining tests execute, and a
   nonzero run whose adapter result turned out to be unreadable or to
   name the wrong files. A known nonzero exit that is `failed` is never
   re-run under `maxStageRecoveryAttempts`, trusted per-file outcomes or
   not: losing trust in the outcomes costs that run its retained files,
   never its failure. Two results decide a nonzero exit before `failed`
   does, and neither blames the change.
   **Identity first:** a nonzero exit at an unattested or changed
   identity is `identity-unknown` or `stale` (§3 order) and routes as
   that result does. It is not a code failure of the live revision,
   because nothing binds it to one. The re-run is a new run at the live
   identity, so a genuine failure fails again there and goes to repair;
   the discarded run's output tail stays in its failure evidence.
   **Host failures keep the shipped route:** a nonzero exit the shipped
   host-failure classification recognizes is `infrastructure` and goes
   to the existing host retry without invoking an agent, bounded by
   `maxStageRecoveryAttempts` and then parked, as the shipped
   `routeFinalStageBundle` routes it today. The classification is not
   widened here, so every nonzero exit it does not recognize stays
   `failed`.
   **A run that overran its configured deadline goes to repair too**, as
   `timed-out`: a suite that hangs or exceeds its budget is the Issue's
   defect to fix, not host noise, so it is never re-run under
   `maxStageRecoveryAttempts` and can never pass by being retried. This
   keeps the shipped routing of `timed-out` to repair
   (`routeFinalStageBundle` in `src/core/final-stage-gate.ts`)
   unchanged. Its per-file outcomes stay untrusted and credit nothing,
   so repair is fed the deadline and the bounded output tail, never a
   claimed pass or a retained file. Only untrusted outcomes whose reason
   is *not* `deadline` — an interruption, a spawn failure, an unreadable
   or mismatched result — **and that recorded no `failed` process
   result** are re-run as `incomplete`, together with a trusted run that
   exited zero yet left a file `not-run` and a started run that recorded
   no result at all but whose recorded evidence proves it launched
   nothing or left nothing running (rule 3).
3. **Unknown termination never authorizes another run.** Only a run
   whose recorded launch and termination evidence (§2) proves that it
   launched no process, or that every process it launched was confirmed
   terminated, may be re-run automatically, so an automatic re-run never
   overlaps an earlier one. Every other interrupted run parks instead of
   launching overlapping work; a dead worker, a superseded allocation or
   the absence of a visible process never supplies that proof.
   **Confirmation is exactly what the park waits for**: an interrupted
   run whose recorded evidence proves it is `incomplete` and is recovered
   under `maxStageRecoveryAttempts` like any other incomplete run.
   **The shipped stage-run ledger records no such evidence today**:
   `StageRunLedgerEntry` (`src/core/staged-verification-state.ts`) holds
   allocation, recording and supersession, with no launch, process or
   cleanup state. Until that evidence is recorded, every started run with
   no recorded result is `termination-unknown` and parks, even one whose
   worker died before launching anything. #1154 owns this guard (§10.1
   decision D1); it is a check on the existing handoff path and a
   recorded fact in existing stage-run state, not a new process manager,
   orphan reaper, handshake or claim-file subsystem.
4. **Review is never blocked by the pending full-suite requirement.** An
   Issue-required command that only the test suite entry satisfies reads
   *pending Stage 2* in Stage 1 and in the review gate. It is neither
   `passed` nor a missing command — unless the shipped requirement gate
   already reports it `passed` from admissible bound manual evidence, or
   `retired`, which this contract never overrides (§6 rule 5). Every
   other required command gates as it does today, including one carried
   by manual evidence rather than by a configured command.
   **"Only the test suite entry satisfies it" is the §6 rule 5 relation**,
   not a bare comparison against the suite command: the bound entry's own
   active bytes, plus any Issue-requirement text the operator declared
   for that entry. A requirement matched either way takes this row
   identically — pending before Stage 2, `passed` only on a complete
   passing Stage 2 of the current admissible identity, and never a
   blocker of the review that reaches it.

## 6. Execution

1. **Two explicit modes.** `files` runs a non-empty list; `full` runs the
   whole configured suite. An empty list is never sent, and a test
   adapter receiving one must refuse it rather than run everything.
2. **No accidental full run.** While this contract is enabled, no lane
   runs the test suite entry directly. Stage 1 replaces it in every lane
   that runs it during the loop, and only Stage 2 runs it in full. The
   review lane's direct pre-approval run of every configured command
   stops running the suite. **A duplicate suite entry is detected by
   command, not by slot.** Any other active slot in the effective plan
   whose command is equivalent to the bound entry's active command under
   the shipped configured-command equivalence
   (`matchesConfiguredVerificationCommand`, rule 5) is a duplicate: the
   suite to run is ambiguous, so the stage records `unavailable` (§3 R2)
   and that slot is never executed — neither as the suite nor as a
   non-test check. This is checked as the stage launches. A duplicate an
   operator introduces *after* the launch changes the configuration
   identity instead, and the run records `stale` (§3 R5, §8 invariant 1).
   Comparing slot identities (`exec:<key>`) instead would never fire,
   because two keys always carry distinct slot identities: a
   `session.verification` holding both `test: npm test` and
   `ci: npm test` would leave `ci` classified as a non-test check (rule 5)
   and run the full suite during Stage 1.
3. **Process outcome first.** A deadline, spawn failure or unconfirmed
   cleanup decides the run before any result file is read. This includes
   the setup and discovery commands Stage 1 launches before it knows its
   selection: a setup or discovery that timed out, failed to spawn or
   exited nonzero is recorded with that process outcome and classified by
   §3 R6–R9, so it is repaired or re-run as that row routes. Only a
   runnable-file report that cannot be read after both commands exited 0
   is the unreadable input of §3 R2.
4. **Reuse.** Execution goes through the shipped command runner with its
   deadlines, process-group isolation and cleanup reporting, artifact
   directory, bounded output tail and locks. The language-neutral
   adapter boundary and the Jest adapter are #1152's.
5. **Operator-owned suite binding.** `session.verification` stays an
   opaque map of commands, so the stage configuration must say which
   entry is the suite. While this contract is enabled:
   - The binding names **exactly one** key present in
     `session.verification`, and the test adapter for that entry. An
     absent or empty binding, an unknown key, more than one key or a
     missing adapter refuses the session at load through the shipped
     fail-closed session validation. A refused session runs no stage;
     nothing falls back to guessing the suite or to running every
     command.
   - **The binding names a key; the effective plan supplies the bytes.**
     What Stage 2 runs in `full` mode, and what Stage 1 replaces with
     `files` mode (rule 2), is the command of the **active slot the
     reconciled effective verification plan holds for the bound key**
     (`exec:<bound key>`), never the raw `session.verification` text.
     This keeps the shipped staged-execution rule: `resolveStageSelection`
     and `stageExecutionInput` (`src/handlers/stage-verification.ts`)
     already take command bytes from the plan, so an operator amendment
     that replaces the bound slot is executed as amended and a superseded
     weaker command is never run. The plan identity — the effective
     plan's digest and applied-through ordinal — is part of the
     configuration identity below, so an amendment to the bound slot
     makes earlier stage evidence match nothing (§3 R5) instead of
     carrying a grant across the change.
   - **A retired bound slot has no suite to run.** When the effective
     plan holds no active slot for the bound key **as the stage
     launches**, the stage records `unavailable` (§3 R2) and routes as §5
     does for that result — a Stage 2 parks through the existing handoff,
     a Stage 1 after its bounded re-runs. A retirement that lands *after*
     the launch is a configuration-identity change, so that run records
     `stale` (§3 R5) and routes as §5 does for `stale`: a Stage 2 returns
     through Stage 1 and review rather than parking. Either way it never
     falls back to the pre-amendment `session.verification` bytes, never
     executes a retired slot and never grants. **The requirement closure
     follows the bound slot, retired or not.** A requirement the bound
     entry discharges — by its own bytes or through the declaration
     below — leaves the loop stage's non-test selection with it in both
     cases, because it gates as the suite (rule 2) whether or not the
     suite can run. Kept in that selection it would be reported
     `evidence-lost` by a stage that never runs the suite, which would
     end the run before Stage 1 records `unavailable` and the handoff
     above could happen.
   - An Issue requirement carries command text, not a key. It is the
     full-suite requirement (§5 rule 4) exactly when its command matches
     the bound entry's command under the shipped configured-command
     equivalence (`matchesConfiguredVerificationCommand` in
     `src/core/tool-request-continuation.ts`: exact trimmed text, or the
     shell-wrapper form), reading the bound entry's command from the
     active slot resolved above so an amended suite command is matched as
     amended. For a bound key `test` with command `npm test`,
     a requirement `npm test` reads *pending Stage 2*, never missing —
     unless the shipped requirement gate already reports it satisfied or
     retired, which this contract leaves untouched.
   - **The operator may declare which requirement text the bound entry
     discharges** (issue #1166). The command an Issue requires and the
     command a stage launches are two operator decisions, and they are
     allowed to differ: a project binds `npm run test:files` so a stage
     builds once and launches the suite twice, while its Issues keep
     requiring `npm test`. The binding's optional
     `requirementCommands` is that declaration — a non-empty list of
     Issue-requirement command texts, matched by the same
     `matchesConfiguredVerificationCommand` rule, applying **only to the
     bound entry** and to nothing else in the plan. A requirement it
     matches is the full-suite requirement of §5 rule 4, everywhere the
     relation is read: the review gate, the Stage 1 selection that leaves
     the suite out, and the stage bundle that credits a Stage 2 pass.
     **It declares an identity, never evidence.** Only a complete,
     passing Stage 2 of that entry satisfies a requirement matched this
     way, exactly as for a requirement matched by the entry's own bytes;
     Stage 1, an `empty` Stage 1, a stale or failed Stage 2 and unrelated
     manual evidence satisfy nothing through it. **Nothing is inferred**:
     no `package.json` is read, no script name resolved, no npm alias
     treated as equivalent by any generic matching rule, and no AI
     judgment consulted — `npm test` and `npm run test:files` are the
     same command here only because one operator said so for one entry of
     one session. A declared command another `session.verification` entry
     already runs refuses the session at load, because the suite must
     never discharge a requirement that check's own record owns. **The
     same collision is rechecked against the effective plan as each
     stage launches**, because the load-time check sees only the static
     session map: a task amendment can later `add` or `replace` another
     active execution slot with a declared command — `exec:lint` becoming
     `npm test` while the bound slot still runs `npm run test:files` —
     and such a slot is not a duplicate of the suite's own command, so
     the load-time refusal and the duplicate rule above both miss it.
     Admitted, it would execute the full suite as a non-test check: in
     Stage 1 before the reviewer approved anything, and in the final
     stage a second time beside Stage 2. A declared-command collision in
     the effective plan therefore makes the suite ambiguous exactly as a
     duplicate does — the stage records `unavailable` (§3 R2) and routes
     as §5 does for that result, and the colliding slot is never
     classified as a non-test check and never executed. **A colliding
     slot is excluded whether or not the bound key still has an active
     slot**: one revision may retire the bound entry and give another
     slot a declared command at once, and the retired entry leaves
     nothing for the duplicate rule to compare against, but the
     operator's declaration already says that slot runs the full suite.
     The run reaches the retired-slot `unavailable` handling of rule 1
     instead of running the full suite before review. The
     declaration is part of the configuration identity below, so changing
     it makes earlier stage evidence match nothing.
   - **Nothing here newly blocks a requirement.** A requirement that
     matches no active configured command keeps its shipped gate:
     `buildEffectiveRequirementStatus` (`src/core/verification-plan.ts`)
     reports it `passed` when admissible bound
     `manualVerificationEvidence` satisfies it under the shipped
     admission rule, `retired` when its slot is retired, and missing only
     otherwise. This contract changes which command the stages execute,
     never which evidence the shipped requirement gate admits, so an
     Issue whose requirement is carried by operator-attested manual
     evidence reaches review and stack-ready exactly as it does today.
     Manual evidence never substitutes for Stage 2: a grant still needs a
     Stage 2 `passed` result (§5 rule 1). A requirement that matches only
     a non-test check gates as that check. The match decides which
     requirement the suite satisfies; it never chooses the suite, which
     only the binding does.
   - Every other key is a non-test check and keeps its shipped execution
     (§3), including a key whose command is also a test command — except
     a key whose active command is *equivalent to the bound entry's
     active command* under the same equivalence used just above. That key
     is the duplicate of rule 2: it is never classified as a non-test
     check and never executed, and the stage records `unavailable`.
   - The binding is operator-authored; a repository file never sets or
     changes it (§8 invariant 5). The human operator supplies the suite
     command, the bound key and the adapter configuration. Neither the
     runner nor an AI agent infers them, authorizes them or edits a live
     session registry file to supply them; a session that lacks them is
     refused, not repaired.
   - The bound key, the bound entry's command as resolved from the
     active effective-plan slot, that plan's identity (digest and
     applied-through ordinal), the adapter binding and any declared
     `requirementCommands` are
     part of the **configuration identity** (§8 invariant 1), so changing
     any of them makes earlier stage evidence match nothing. A binding
     that declares no `requirementCommands` keeps the identity it already
     had, so adding the field to the schema invalidates nothing.

   This contract fixes the binding's meaning and validation. **#1152
   implements it** — the configuration surface, the session-registry
   schema and the fail-closed load-time validation for the human-supplied
   binding, alongside the adapter boundary and the Jest adapter (§10.1
   decision D4).
6. **Implemented adapters.** The binding's `adapter` names one of a
   closed set of implemented adapters (`TEST_SUITE_ADAPTER_KINDS`):
   `jest` (#1152) and `vitest` (#1174). An adapter changes how the
   tooling is asked and read, never the algorithm: both run exactly the
   files §4.2 selects in `files` mode and the configured suite in `full`
   mode, both feed the same per-file outcomes into the same §3 table, and
   the selection, retention, routing and grant rules above do not know
   which one ran. The Vitest adapter's tool-specific rules:
   - **Supported range: Vitest 3, from 3.2** — the line the real-Vitest
     fixture runs. Nothing probes the installed version; every report is
     read against the exact shape that line writes, and any other shape is
     an unreadable result, never a guess.
   - **The adapter owns the subcommand.** Discovery is
     `vitest list --filesOnly --json=<file>`, which lists files without
     collecting or running a test; a run is `vitest run`. Neither is watch
     mode, so every launch is finite. The bound command must therefore
     invoke the Vitest executable itself (`npx vitest`,
     `node node_modules/vitest/vitest.mjs`, `pnpm exec vitest`), followed
     only by `--name=value` or `--no-name` options: a package script hides
     whether it already names a subcommand, a bare word would be read as a
     subcommand or a file filter, and watch mode, `--changed`, `--shard`,
     the UI and the reporter options the adapter supplies are refused.
     Each refusal happens before anything launches, with the reason.
   - **Explicit files are checked, not trusted.** Vitest has no
     exact-path facility: a file argument selects every runnable file whose
     path contains it. The adapter passes absolute paths, and before any
     test launches the runner asks `vitest list` which files those same
     arguments select. Unless that is exactly the requested set, no test
     runs and the run records untrusted `mismatched-files` naming the
     similarly named or unselected files (§3). A similarly named file is
     refused, never run and never collapsed into the requested one. This
     check costs one more `vitest list` launch per Stage 1 run.
   - **The machine result is Vitest's JSON reporter.** A run replaces the
     configured reporters with `default` and `json`, because Vitest has no
     way to add one beside them. A file is `failed` when its status or any
     test failed — which covers a file that failed to collect and a failing
     suite hook — `passed` only when at least one test passed, and
     `skipped` when it executed none. A report with a test still pending,
     a file with no test result, a count that disagrees with
     `numTotalTests`, or any unrecognized field value credits nothing.
     Exit zero is never a pass by itself (§2), and a nonzero exit over
     all-passing files is a failed process.
   - **Identity is the repository path.** Configured projects are
     supported when each test file belongs to exactly one project. A file
     two project instances both run is reported twice under one path, and
     the JSON result names no project, so its instances could not be told
     apart: discovery refuses such a configuration as an unreadable report
     that names the file and the projects, rather than collapsing
     incompatible results.

## 7. Scenario matrix

Inventory is `{A, B, C}` throughout. "Publish" means the stack-ready
grant; progress reporting is always allowed and follows invariant 4 of
§2.

| Scenario | Evidence available | Result | Permitted next action | Publish |
| --- | --- | --- | --- | --- |
| Ordinary success | Stage 1 `[A]` complete, A passed; review approved the same revision; Stage 2 complete, all passed; required non-test checks passed for that revision | Stage 1 `passed`, Stage 2 `passed` | Grant | Yes |
| Non-test check failure | Stage 2 complete, all passed; a required non-test check failed for that revision | Stage 2 `passed` | Shipped routing of the failing check | No |
| Full failure retained | Stage 2 complete, B `failed` | Stage 2 `failed`; retained `{B}` | `needs_fix`; next Stage 1 runs `[A, B]` | No |
| Fail-fast failure | Trusted result: B `failed`, C `not-run` | `failed` (either stage); Stage 2 retains `{B}`, not C | Repair; C stays unproven until a later Stage 2 | No |
| Suite-level failure | Process result `failed` (nonzero exit) at an attested, unchanged identity, not recognized by the shipped host-failure classification, with no `failed` file outcome: the rest `passed`, `skipped` or `not-run` after a global setup failure, or an adapter result that could not be read or named the wrong files | `failed` (either stage); nothing retained | Repair with the bounded output tail, whether or not the per-file outcomes are trusted; never a re-run, and files that never ran stay unproven | No |
| Host failure | Process result `failed` at an attested, unchanged identity, recognized by the shipped host-failure classification (`environmentSignal` or `transientSignal`) | `infrastructure` (either stage); nothing retained | Host retry without an agent — Stage 1 at the live revision, Stage 2 at the approved revision — bounded, then park | No |
| Empty Stage 1 | Base and runnable-file report readable, no changed test file, nothing retained | Stage 1 `empty` | Review, then Stage 2 on approval of the same revision | No |
| All-skipped Stage 1 | Stage 1 `[A]` complete, A `skipped`; no file passed or failed | Stage 1 `empty` (D6), never `passed` | No execution is credited; review, then a mandatory Stage 2 on approval of the same revision | No |
| Accepted predecessor update | The dependency flow incorporated the predecessor's newly accepted head and recorded it with an acceptance of that exact commit; `{B}` retained from an earlier Stage 2 | Selection is taken from the new base, so the predecessor's own test files are not this Issue's changes | Stage 1 over the Issue's own changed files ∪ `{B}`; every earlier stage result and review approval is unusable, so a grant needs a fresh Stage 1, approval and Stage 2 | No |
| Predecessor ref moved | The blocker branch was force-pushed or fetched, and nothing recorded an acceptance of the new head | Stage 1 `unavailable` (the base did not move) | Bounded re-run, then park | No |
| Mixed pass/skip | Complete; some files `passed`, others `skipped`, none `failed`. For a Stage 2 grant also: matching Stage 1 evidence, review approval of the same revision, that revision is the live revision re-attested inside the granting completion, required non-test checks passed for it | `passed` (either stage); skipped files never reported passed | Stage 1: review. Stage 2: grant only when every §5 rule 1 prerequisite holds; otherwise withhold as §5 routes | Stage 2 only, under §5 rule 1 |
| All-skipped full run | Stage 2 complete, every file `skipped` | Stage 2 `no-evidence` | Park | No |
| Unavailable selection | Stage 1: base, diff, runnable-file report or retained set unreadable. Stage 2: runnable-file report or retained set unreadable (an unreadable base or diff does not stop Stage 2) | `unavailable` (not `empty`) | Stage 1: bounded re-run, then park. Stage 2: park | No |
| Deadline exceeded | The run overran its configured deadline, cleanup confirmed; outcomes untrusted and crediting nothing | `timed-out` | Repair (§5 rule 2), never a re-run; nothing retained | No |
| Interrupted, termination confirmed | No nonzero exit was recorded, and either failure evidence and partial outcomes that credit nothing, or a started run with no recorded result whose recorded launch and termination evidence proves it launched no process or that every launched process was confirmed terminated | `incomplete` | Bounded re-run from the beginning, then park | No |
| Interrupted, termination unknown | A started run with no result and no recorded evidence proving no launch or confirmed termination — including a worker that died before or just after launching, which the shipped ledger cannot tell apart — or cleanup could not confirm termination | `termination-unknown` | Park; never re-run automatically | No |
| Revision change | Launch and end (or completion re-check) revisions or configuration identities differ, whether or not the run exited nonzero, or Stage 2 revision ≠ approved revision | `stale` | Stage 1 (and review) at the live revision | No |
| Unattested identity | Revision or configuration identity unattested at launch or end, whether or not the run exited nonzero; file outcomes credit nothing | `identity-unknown` | Bounded re-run of the same stage, then park | No |
| Absent retained file | B retained; B deleted or renamed | Stage 1 `retained-unresolved` | Park, naming B; B stays retained | No |

The whole model traces in one pass. The agent changes `A` and a source
file; nothing else is edited.

| Step | Lane, revision | Run | Result | Retained | Route (§5) |
| --- | --- | --- | --- | --- | --- |
| 1 | Implementation | Stage 1 `files [A]` | `passed` | ∅ | Commit and push at H1 |
| 2 | Review at H1 | Stage 1 evidence for H1, else `files [A]` | `passed` | ∅ | Reviewer approves H1 |
| 3 | Review at H1, approved | Stage 2 `full` | `failed` (B) | `{B}` | `needs_fix`; fix input names B |
| 4 | Implementation | Stage 1 `files [A, B]` | `passed` | `{B}` | Commit and push at H2 |
| 5 | Review at H2 | Stage 1 evidence for H2, else `files [A, B]` | `passed` | `{B}` | Reviewer approves H2 |
| 6 | Review at H2, approved | Stage 2 `full` | `passed` | `{B}` | **Grant** |

An Issue that requires the suite command reads it *pending Stage 2* in
steps 1, 2, 4 and 5 (§5 rule 4). It reads `passed` first in step 6.

## 8. Retained invariants

These are the only rules carried from the staged verification chain.
They are restated here so no older document needs to be consulted.

1. **Evidence is bound to identity.** A result counts only for the
   revision and configuration identity recorded at launch and re-checked
   at the end. The configuration identity includes the suite binding
   and the identity of the effective verification plan its command was
   resolved from (§6 rule 5), so an operator amendment to the bound slot
   invalidates earlier stage evidence rather than carrying it forward. An identity that cannot be attested matches nothing,
   including another unattested identity (shipped #1100 matching law).
   **The live identity is re-checked inside publication.** The CAS
   completion that records a result (invariant 2), and so any grant, first
   re-attests the live revision and configuration identity inside the same
   transaction. The live revision is the content under test, including
   uncommitted and untracked non-ignored content, not only the commit
   head. If it differs from the recorded identity, the completion records
   `stale`; if it cannot be attested, `identity-unknown`; and nothing is
   granted. A change after the end check therefore never publishes stale
   evidence.
2. **Allocate before launch, commit once.** A stage run is recorded as
   started before its first process launches. Its result, any
   retained-set change and any grant are committed in one existing CAS
   completion. A partial result is never credited or resumed.
3. **Bounded non-code recovery.** Consecutive non-code results are
   bounded by `maxStageRecoveryAttempts`, then park. Code failures use the
   existing repair and review caps, unchanged.
4. **Absence is never success.** A file or check that did not run is
   never reported, counted or published as passed.
5. **Operator authorization.** Commands, including a test adapter, are
   operator-authored. A repository file never authorizes a command.
6. **Approval alone never grants**, and a declaration left by an earlier
   run never grants a later one.

**Obsolete normative policy** (retired, not carried): the five-set loop
selection union; `selectable` / `finalOnly` stage membership and
selectability by subtraction; the selection port, selection adapter,
result adapter, structured result envelope and project verification
file; the unknown-impact full-set fallback and the loop `unknown` full
re-run; the check-id regression set (R2) and loop pin set (R6); pin
records, release, purchasing power and dormancy; the 13-row transition
table; default-off dual-mode byte-equivalence; migration and
compatibility rules; and the #1094 twelve-slice decomposition.

## 9. Keep / adapt / delete inventory

Reusable implementation, named for downstream slices. This Issue
implements none of it.

| Module | Verdict | Note | Owner |
| --- | --- | --- | --- |
| `src/handlers/command-runner.ts`, `src/handlers/verification.ts` | Keep | Deadlines, process-group isolation, cleanup reporting, artifacts | #1152 uses |
| `src/core/verification-result.ts` | Adapt | Per-check records and outcome classification; add per-file outcomes | #1152, #1153 |
| `src/core/staged-verification-state.ts` | Adapt | Keep allocation, ledger, CAS recording, grant key and recovery streak; replace regression and pin state with the Issue base and retained set | #1153 |
| `src/core/stage-evidence-validity.ts` | Adapt | Keep identity and matching law; the selection-policy input changes | #1153 |
| `src/core/stage-run.ts` | Adapt | Result assembly onto §3; keep `stageCheckHostFailure` as the one host-failure derivation (§3 R6) | #1153, #1154 |
| `src/core/stage-recovery.ts` | Adapt | Keep the bounded streak, counting `infrastructure`, and the automatic `interrupted` re-run only where recorded evidence proves no launch or confirmed termination; drop the loop full re-run; add the unconfirmed-termination park of §5 rule 3 for every other started run with no result — today all of them, since the shipped ledger records no launch or cleanup state | #1154 (§10.1 D1) |
| `src/core/final-stage-gate.ts`, `src/core/final-stage-repair.ts` | Adapt | Keep approval continuation, publication decision, bounded fix input and the `host-retry` route for `infrastructure`; route §5's Stage 2 rows; failing files in the fix input | #1154 |
| `src/handlers/stage-verification.ts`, `src/handlers/implementation.ts`, `src/handlers/review.ts` and the other lanes that run verification | Adapt | Stage 1 in place of the suite entry; review Step 4 stops running the suite; pending-Stage-2 gate; Stage 2 after approval. Keep `resolveStageSelection` / `stageExecutionInput` resolving command bytes from the effective plan (§6 rule 5), and keep the shipped requirement gate's manual-evidence admission untouched | #1154 |
| `src/core/staged-verification-status.ts` | Adapt | Show base, selection, retained set and results | #1154 (sole owner; #1156 only exercises it) |
| `src/core/staged-verification-config.ts` load validation | Adapt | Keep the fail-closed load refusal posture; add the suite binding and its refusals (§6 rule 5) | #1152 (§10.1 D4) |
| `src/core/stage-selection.ts` | Delete | Selection port and group union | #1155 |
| Selection fields in `src/core/staged-verification-config.ts` and `src/registries/json-session-registry.ts` | Delete | `selectable`, `finalOnly`, `selectionTimeoutMs`, `selectionAdapter`, `resultAdapters`, `resultTimeoutMs` | #1155 |
| `src/core/project-verification-file.ts`, `.ai-cli-loop/verification.json` | Delete | Feeds selection only | #1155 |
| `scripts/loop-selection.mjs`, `scripts/staged-verification-baseline.mjs` and their dedicated tests | Delete | Retired policy and its measurement | #1155 |
| `docs/staged-verification-operations.md`, `test/staged-verification-e2e.test.js` | Adapt | Operating docs and the §7 trace on a real project | #1156 |

## 10. Downstream ownership and approved decisions

Ownership stays as the operator assigned it:

| Issue | Owns |
| --- | --- |
| #1152 | Minimal language-neutral adapter boundary (§6) and the real Jest adapter on existing execution plumbing; plus the operator-owned suite binding (§6 rule 5) — its configuration surface, session-registry schema and fail-closed load-time validation (D4) |
| #1153 | Cumulative selection (§4), the retained set, concrete persistence, schema, digests and evidence through existing ports (§2, §3) |
| #1154 | Both stages wired into the real handlers and final publication (§5), eliminating the pre-approval duplicate full run (§6 rule 2), in every lane that runs verification: implementation, review, conflict resolution, tool-request continuation and the repair, no-change and review-retry paths; plus the minimal unconfirmed-termination guard of §5 rule 3 on the existing handoff (D1) and the runtime status view `src/core/staged-verification-status.ts` (§9), which no other Issue owns |
| #1155 | Removal of obsolete selection code, configuration, dedicated tests and docs (§9 Delete rows) |
| #1156 | Real-project end-to-end integration, timing measurements and operating docs |
| #1165 | Applying the later-approved decisions D5 (§4.1 rule 1: the accepted predecessor update that advances the Issue base, and the evidence invalidation that rides it) and D6 (§3 R10: an all-`skipped` Stage 1 is `empty`) to selection, persisted state, routing and the lanes |
| #1174 | The Vitest adapter (§6 rule 6) behind the same boundary, with the two optional port members it needs — a file-written discovery report and the pre-run selection check — and its admission to the closed adapter set; no change to selection, retention, routing or the Jest adapter |

Lane coverage belongs to #1154: its Work section requires auditing every
shipped verification site, including the repair, no-change and
review-retry paths, so no lane is excluded. Selection policy stays
#1153's and handler routing stays #1154's; D1 and D4 add a guard and a
configuration surface to Issues that already own those areas, and
neither redistributes another Issue's work. The runtime status view is
likewise #1154's alone: it is runtime output of the stages #1154 wires
up, so #1156 exercises it end to end but never has to adapt it, and
neither Issue may assume the other will. The rest of the ownership
above follows #1158's summary of #1152, #1153, #1155 and #1156. Because
D1 and D4 extend the Work sections of #1154 and #1152, the operator
updates those two Issue bodies before scheduling them. D5 and D6 were
approved after that chain shipped and are applied by #1165 (§10.1).

### 10.1 Approved operator decisions

The operator has decided these six. They are settled requirements, not
open questions; the sections above implement them.

- **D1 — Unconfirmed termination parks (owner #1154).** #1154 adds a
  minimal guard on the existing human handoff: when the termination of a
  preceding interrupted run cannot be confirmed, park instead of
  launching overlapping work (§5 rule 3). It reuses the existing runner
  and stage-run state. No process manager, autonomous orphan recovery,
  handshake or claim-file subsystem is added, and no scope is expanded
  silently — a concrete implementation blocker is reported instead.
  **Implemented by #1154 for the test stages**: the check-group policy
  records a started stage run that a later allocation supersedes as
  `interrupted` and re-runs it automatically under the recovery budget
  (#1096 §7.1 rule 4), although nothing records that its process group
  ended; #1155 deletes that path. With a suite binding, the implementation, review and
  conflict-resolution lanes and the final stage now check the stage-run
  ledger before launching: an allocated run with no recorded result parks
  through the existing handoff (`openStageRunGuard` in
  `src/core/test-stage-routing.ts`), and the parking completion closes that
  allocation so the operator's requeue launches once. This is the guard
  #1154 owns. It does not park every interruption: a run whose
  recorded evidence proves it launched no process, or that its processes
  were confirmed terminated, keeps the existing bounded automatic
  recovery (§5 rule 3). The shipped `StageRunLedgerEntry` records no
  launch, process or cleanup state, so a worker that died before
  launching cannot be told apart from one that died after launching an
  orphan; recording that evidence in the existing stage-run state is
  part of this guard, and until it exists every started run with no
  result parks. If recording it needs more than that minimal addition,
  #1154 reports the concrete blocker for triage instead of expanding
  scope, and those runs keep parking. #1154 reported that blocker: the
  evidence needs new fields in the persisted `StageRunLedgerEntry`
  schema, so it records none, and every started run with no recorded
  result parks.
- **D2 — A gone retained file is an unresolved obligation.** A retained
  failing file that is legitimately deleted or renamed stays retained and
  parks through the existing handoff (§4.3 rule 3, §5). It is never
  silently discarded. A release command is deferred to a separate future
  task and is not required in this chain, so no Issue here implements
  one.
- **D3 — Stage 2 keeps running the non-test checks.** Stage 2 continues
  to execute the required non-test checks at the approved revision, as
  the shipped final stage does (§3, §5). This effort targets test
  selection only: nothing here optimizes those checks away or introduces
  reuse of an earlier record to avoid running them, and #1154 must not
  weaken the shipped final-stage coverage.
- **D4 — The operator supplies the suite binding (owner #1152).** The
  human operator supplies the suite command, the bound key and the
  adapter configuration; the runner and the AI never infer or
  autonomously authorize them, and never edit a live `sessions.json` or
  other operational setting to supply them (§6 rule 5). #1152 implements
  that configuration surface, its session-registry schema and its
  fail-closed load-time validation, together with the adapter boundary
  and the Jest adapter.
- **D5 — The Issue base advances only on an accepted predecessor update
  (applied by #1165).** When the shipped dependency flow explicitly
  incorporates an updated predecessor and records it, the Issue base
  (§4.1 rule 1) becomes that predecessor's newly accepted head, so the
  test files the Issue inherits from its predecessor stay out of its own
  changes. The advance requires stack-ready again for that **exact**
  head, or equivalent authoritative successful completion evidence:
  **moving a ref or fetching alone never changes the base**, and a
  disagreement the acceptance does not cover is `unavailable` rather
  than a silent re-base. A readiness *label* the predecessor still
  carries is not that evidence — a force-push keeps the label while
  changing the head — so the acceptance must name the commit the
  predecessor's own recorded successful completion was granted at, and
  that commit must be the one this Issue incorporated. The retained
  failing files survive the advance
  untouched; every stage result and review approval recorded against the
  old base is invalidated, so an old approval can no longer carry a run
  to a grant. Option (b) of the original question — keeping the
  pre-re-base base and selecting the inherited test files as changed — is
  rejected: an Issue is not accountable for its predecessor's tests.
- **D6 — A Stage 1 whose selected files are all `skipped` is `empty`
  (applied by #1165).** A complete Stage 1 that reached every selected
  file and executed no test progresses as `empty` (§3 R10), not as
  `passed`: it records no execution, permits code review, and then
  requires Stage 2 after approval of the same revision, because nothing
  it produced can satisfy the full-suite requirement (O4). A Stage 2 that
  skips everything, or whose runnable-file inventory is empty, stays
  `no-evidence` and parks for human confirmation; it is never repeated
  automatically. The ordinary mixed pass/skip case is untouched — it
  still needs at least one `passed` file and keeps every §5 rule 1
  prerequisite.

Where this contract is otherwise silent — concrete field names, types,
serialization, schema and digest encodings — #1153 decides under §2 and
§8, and this Issue invents no product behavior to fill the gap.

`test/docs-changed-file-verification-contract.test.js` pins this
document's semantic structure.
