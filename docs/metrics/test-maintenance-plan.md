# Test-maintenance implementation plan (Test Maintenance Pilot, slice 5)

Issue #1113. This is a plan, and it is documentation only. It changes no
production source, no test, no assertion, no harness, no configuration, no
workflow and no live session, and it starts no measurement. Its output is a set
of **proposals**, each carrying its own evidence, its own missing evidence and
its own disposition, for an independent reviewer to challenge and an operator to
approve, reject or park.

Nothing here is an approval. A proposal marked *proposed for approval* below is
a proposal that has survived this slice's own reasoning; it becomes work only
after the independent review in §6 and an operator decision.

Read first, because this plan quotes them rather than re-deriving them:
`docs/metrics/test-cost-baseline.md` (#1109, cost),
`docs/metrics/test-maintenance-candidates.md` (#1110, contracts and candidate
classes — especially §4, §5 and §7),
`docs/metrics/mutation-pilot-harness.md` (#1111, the harness and its invocation
rules) and `docs/metrics/mutation-pilot-baseline.md` (#1112, the fault-detection
baseline — especially §2, §5, §6 and §10).

## 0. Summary of dispositions

| # | Proposal | Class | Slice | Disposition |
|---|---|---|---|---|
| P1 | `admin-retention.test.js`: 10 of 11 cases from spawned `dist/cli/admin.js` to in-process `runAdmin`; `:144` stays spawned (it asserts a real exit status) | setup/process optimization (move) | #1114 | **Proposed for approval** |
| P2 | `tool-request-grant.test.js`: pin the grant expiry boundary (`now === expiresAt`) | quality repair (test addition) | #1114 | **Proposed for approval** |
| P3 | `admin-chain-edit.test.js`: make the fake `gh` stand-in cheaper | setup/process optimization | none — a dedicated Issue if §8 A clears | **Deferred** — mechanism unidentified; benefit unmeasured and bounded only from above until an equivalent candidate is benchmarked (§8 A's two-step gate); and its own mutation before half must be bought fresh (§8 F run F3, ≈95 min) |
| P4 | `admin-chain-inspect.test.js`: 6 of 22 cases to `runAdmin` — the 16 that assert a real process exit status stay spawned | setup/process optimization (move) | #1114 | **Deferred** — pending two named code reads; benefit now 8 of 28 start-ups, and 2 of 28 if the first read fails |
| P5 | `admin-tool-request-grant.test.js:1473` consolidated against `tool-request-grant.test.js:54-97` | consolidation | — | **Rejected — retain unchanged** (the case's facts are argv, task state and outbox; the pure suite reaches none of them) |
| P6 | Drop `admin-tool-request-grant.test.js` as redundant with the pure suite | removal | — | **Rejected — retain unchanged** (measured: loses the 2 detections `:220` contributes) |
| P7 | Treat `chain-linear.test.js` as redundant because it killed nothing | removal | — | **Rejected — retain unchanged** (no before-picture at all) |
| P8 | Close the #1112 survivors to raise the score | — | — | **Rejected** as score-chasing, except P2, which is a boundary repair with its own evidence |

**Zero deletions are proposed, and no consolidation is proposed.** Two changes
are proposed for approval; both are additive or boundary-preserving, and neither
removes an asserted fact. Two are deferred with a named, priced acquisition step.
Four are rejected outright.

**Because no consolidation is proposed, #1115 has no proposal in this plan.**
Every surviving candidate is a setup/process optimization or a test addition, so
each belongs to #1114 or to an Issue of its own (§2, §7); none of them may be
implemented under #1115, whose authorized Work is approved consolidation and
removal. #1115 ending report-only is this plan's expected outcome, and §7 treats
it as an acceptable one rather than a gap to fill.

**The #1112 run is not available as a *before half*.** Two independent reasons,
both developed below: its per-mutant raw report lives only in the gitignored
`.mutation/`, which is **absent from this branch** and does not travel to a
downstream worktree (§1.2, §8 F); and P2 changes one of the four scoped suites,
which `mutation-pilot-baseline.md` §10 makes invalidating for the baseline as a
whole, not for one mutate entry (§5.2). The consequence is a single rule:
**every mutation comparison in this pilot takes its own before-run at the
revision it is changing.** The #1112 report stays what it is — a decision input
and a published set of identities — and is never the before half of a
comparison.

**What that costs the pilot, and it is not conditional on P3.** P2 changes a
scoped suite, so the pilot's final head will differ from every mutation result
this chain has published. The only way #1116's final comparison can be
reproducible by anyone who did not hold the raw report is a **pre-P2 before-run
taken in #1114** and a **matching after-run taken in #1116**, each publishing the
complete 38-mutant identity table (§5.2, §7, §8 F). #1116 takes its run whatever
the slices land, and it also schedules the pilot's **final full-project
verification** — `npm test`, `npm run typecheck`, `npm run package` at the final
head — for which no staged or selected-file run substitutes
([`AGENTS.md`](../../AGENTS.md)). Two ≈95-minute mutation runs is the price of a
reproducible pilot outcome; approving it is an operator decision at #1114's
activation, and §7 records what the report must say if the operator declines.

**Zero deletions and no consolidation is a valid outcome** under this Issue's own
terms: "A valid plan may approve only lightweight optimization and no
deletions." It is also the honest one —
§1.3 records that the inherited evidence measures 3.4% of the two pilot modules
and nothing at all outside them, and §8 records what would have to be measured
before any consolidation could be justified.

§4 additionally records a **correction to the reasoning** in
`mutation-pilot-baseline.md` §6.1's account of why the six `compareEdges` mutants
survived: the account rests on the sorted list being observable only inside
refusal text, and at `chain-linear.ts:745` it is not — `admin-chain-edit.test.js`
asserts its order directly. The survivals are nevertheless ordinary equivalence
on the tested input, for a reason §4 gives in full. It changes no number and no
status in that report, needs no measurement to settle, and nothing here depends
on it.

## 1. Reconciliation with the accepted predecessors

### 1.1 Heads and revisions

| Field | Value |
|---|---|
| Authoritative predecessor | #1112, `status:stack-ready`. PR #1178 passed independent review at head `f6009dcb424a2dffdce9edcb6e4c67c906f36409` |
| Predecessor head re-checked at the start of this slice | `f6009dcb` — **unchanged** from the head the Issue names |
| Branch this plan is written on | `ai/issue-1113`, inheriting that head; not started from `main`, and no merge was required |
| Revision the mutation baseline **measured** | `dc758e126549dc2822b38c782796154a6f67a458` — earlier than the head above, and not to be confused with it |
| Cost figures | 2026-09-13, at `9b278b20`, four workers (#1109). **Historical.** Not a current measurement of anything |
| Contract matrix | written at `456b231c`, reconciled to `96da7ad2` (#1110 §1.1) |

### 1.2 The mutation baseline has not drifted — and is still not a usable *before* half

Two separate questions, and only the first one is answered by a diff.

**Drift: none.** `mutation-pilot-baseline.md` §10 lists what would invalidate it: a change to a
mutated source's lines, to one of the four scoped suites, to `BASELINE_MUTATE`
or to the toolchain. Checked at this head:

```
git diff --name-only dc758e12..f6009dcb
  docs/metrics/mutation-pilot-baseline.md
  docs/metrics/mutation-pilot-harness.md
  test/mutation-pilot-harness.test.js
```

and the same diff restricted to `src/core/chain-linear.ts`,
`src/core/tool-request-grant.ts`, the four scoped suites,
`stryker.pilot.config.mjs`, `scripts/mutation-pilot.mjs` and `package.json` is
**empty**. Two of the three changed files are reports; the third is the
harness's own test, which is not one of the four scoped suites and does not
execute in a mutation run (§4.4 of that report says the same for the same
revision pair).

So the baseline **describes this head's code and suites**: its numbers are about
this tree, and nothing has drifted out from under them.

**Availability as data: absent.** Describing the right tree is necessary and not
sufficient. A before/after comparison is performed per mutant, by identity —
§5.2 requires matching on source location, mutator, original and replacement,
and §7 item 4 of `test-maintenance-candidates.md` requires it **per suite**, so
each mutant's `killedBy` entry is part of the before half too. What is published
in git is the aggregate, the per-suite kill *counts*, the eight killer test names
and full identities for the ten survivors (§6.1) and the three unevaluated
mutants (§6.2). What is **not** published anywhere tracked is the identity of
each of the **25 killed** mutants and which suite killed it. Those exist only in
the raw `mutation.json` under the gitignored `.mutation/` (`.gitignore:15`), and:

```
ls .mutation        # ls: .mutation: No such file or directory
```

on this branch. `.mutation/` is a per-checkout artifact directory; it was written
in whatever worktree ran #1112 and it does not follow #1114, #1115 or #1116 into
theirs. So the 14 `admin-chain-edit.test.js` identities that P3's after-check
would have to match **cannot be read** by a downstream slice, and no dry run
recovers them: `mutation-pilot-harness.md` §2 records that the dry run "activates
no mutant, so it writes no `mutation.json`" — it yields a count, not identities.

The consequence is stated once, in §0, and priced in §8 F: any mutation
comparison takes its own before-run, and the slice that takes it **publishes the
bounded sanitized per-mutant identity table into the tracked report before its
`.mutation/` is discarded**. That obligation is what this plan asks #1112's
successor runs to carry; it is not a criticism of #1112, whose report was scoped
to its own findings.

`src/cli/admin.ts` is byte-identical between `96da7ad2` and this head, and
`runBackupRestore` is still at `src/cli/admin.ts:13163`. That is what keeps
`test-maintenance-candidates.md` §3.20's divergence analysis — the only
already-completed divergence analysis in the inherited evidence — usable for P1
without redoing it from scratch.

### 1.3 What the inherited evidence authorizes, and what it does not

| Claim | Status |
|---|---|
| Per-suite cost ranking | **Historical.** Measured 2026-09-13 at `9b278b20`; no suite has a known current cost, including every suite named in this plan (#1110 §1.1, §8) |
| Fault detection in `chain-linear.ts:329-359` for `admin-chain-edit.test.js` | **Measured**: 14 detections from 4 tests |
| Fault detection in `chain-linear.ts:329-359` for `chain-linear.test.js` | **No before-picture.** It killed nothing there (#1112 §5.2) |
| Fault detection in `tool-request-grant.ts:237-244` | **Measured**: 11 of 12 mutants killed, split 9 (pure) / 2 (admin) with **no overlap** |
| Anything outside those 39 lines (3.4% of 1147) | **Unmeasured — not good.** Includes `planLinearChainEdit`, `verifyLinearChainReadBack`, `normalizeCommand`, `grantMatches` |
| `verifyLinearChainReadBack`'s missing/extra-edge judgement, `grantMatches`'s scope-before-lifetime ordering | **Refused on cost** (#1112 §2, §4.3). No before-evidence exists |
| Per-test coverage (`coveredBy`) | **Unknown, not empty.** `coverageAnalysis: off`, so a survivor is "executed and unasserted" *or* "never executed" and this run cannot tell them apart |
| The 25 killed mutants' identities and their `killedBy` | **Not persisted.** Published as counts and killer test names only; the per-mutant rows are in an untracked `.mutation/` that is absent here (§1.2). Reacquisition is a full run, priced in §8 F |
| The 72.97% StrykerJS printed | **Not a fault-detection rate.** The figure of record is **25/37 = 67.6%** assertion-observed; over everything instrumented it is 25/38 |
| Timeouts (2) and the RuntimeError (1) | **Not assertion coverage.** One timeout is a non-terminating mutant, one is unexplained, the crash was never evaluated |
| Every suite outside the measured top 20, and every spawned suite | **No mutation evidence at all**, by design (#1110 §6). Preservation there is argued from assertions or not at all |

Two consequences run through every proposal below.

**Mutation evidence is available for exactly one candidate suite under change.**
Only `admin-chain-edit.test.js` (P3) sits inside the observable boundary with
measured detections to preserve. Every other proposal is argued from its
assertions, which `test-maintenance-candidates.md` §7 item 5 permits and item 4
does not override — item 4 governs the pilot files, and it governs them per
suite, never in aggregate.

**No proposal may cite the aggregate score.** Not for justification, not for
acceptance, not as a threshold. The only mutation facts this plan uses are
per-mutant identities (source location, mutator, original, replacement) and
per-suite `killedBy` sets.

## 2. How to read a proposal

Each proposal carries the five records this Issue requires, in this order:

1. **Target and classification** — exact suite, cases and line numbers at this
   branch's head; whether it is setup/process optimization or
   consolidation/removal; the implementing slice.
2. **Protected assertions and boundaries** — what must still be asserted
   afterwards, at what boundary (real process, real lock, real git, real SQLite,
   real second writer), which historical regressions the cases carry, and how
   fixture independence, cleanup and order isolation are preserved.
3. **Benefit** — measured or hypothesized, said plainly which; and the exact
   command and settings for the fresh before/after measurement that would
   substantiate it.
4. **Mutation evidence** — what applies to this candidate, by stable mutant
   identity; what is uncovered by this study; and what attribution is missing.
5. **Missing evidence, cost, rollback and disposition.**

Classes are `test-maintenance-candidates.md` §2's: *keep*, *optimize*, *move*,
*consolidate*, *possibly remove*. **Slice assignment follows the downstream
Issue's own authorized Work, not the proposal's cost.** #1114 takes low-risk
setup/process optimization that removes no asserted fact; #1115 takes **approved
consolidation and removal, and nothing else**; #1116 takes the final comparison
and the runbook.

An earlier draft of this plan also sent "anything that needs new before-evidence"
to #1115, which put two setup/process optimizations (P3 and P4) in the
consolidation slice. That is not a routing this plan may make: implementing a
process optimization under #1115 would either be a code change no Issue requested
or a silent repurposing of the consolidation slice, both of which
[`AGENTS.md`'s No-Direct-Edits Policy](../../AGENTS.md) forbids. Needing new
before-evidence changes a proposal's **price and sequencing** (§8), never its
class or its slice. Both were re-routed after independent review (§6): P4 to
#1114, and P3 out of all three slices until its cheap gate clears.

Line numbers are read at the current head `f6009dcb` and must be re-read by the
implementing slice, which will be working on a later tree.

---

## 3. The proposals

### P1 — `admin-retention.test.js`: 10 of 11 cases from spawned to `runAdmin`

**Disposition: proposed for approval. Class: move (setup/process optimization). Slice: #1114.**

**1. Target and classification.**
`test/admin-retention.test.js`, whose 11 tests are at `:76`, `:91`, `:115`,
`:144`, `:188`, `:205`, `:218`, `:230`, `:272`, `:283`, `:313`. **Ten cases are
proposed to move; `:144` stays spawned**, for the reason record 2 gives. The suite's `run()`
helper (`:18-25`) is `execFileSync(process.execPath, [CLI, ...args])` against
`dist/cli/admin.js`, with **no explicit `env`**; it is invoked at **27 call
sites** — `:81`, `:85`, `:95`, `:97`, `:101`, `:119`, `:130`, `:158`, `:161`,
`:194`, `:208`, `:221`, `:225`, `:254`, `:255`, `:258`, `:274`, `:276`, `:286`,
`:289`, `:292`, `:296`, `:308`, `:315`, `:316`, `:317`, `:319` — which agrees
with `test-maintenance-candidates.md` §3.20's ≈27 executed runs. **A bare
`grep -c 'run('` reports 30 and must not be used as the work list**: it also
counts the helper's own declaration at `:18` and two unrelated `better-sqlite3`
statement calls, `.run(...)` at `:153` and `:237`, which are synchronous
database writes in the fixtures and are not this helper. **Twenty-five of those
27 call sites move; `:158` and `:161` — the two belonging to `:144` — stay
spawned.** The change adds a `run()` over `runAdmin` from
`test/helpers/admin-cli.js`, which resolves to the same `{code, stdout}` shape,
and keeps the existing `execFileSync` helper (renamed for what it now is, e.g.
`runSpawned()`) for `:144`. As in P4, the file ends with two helpers rather than
one.

**It is not a helper-only edit, and this plan does not present it as one.**
`runAdmin` is declared `async` (`test/helpers/admin-cli.js:79`): it returns a
Promise, and the `{code, stdout, stderr}` triple exists only after that Promise
settles. Replacing only `run()`'s body would hand every current
`parse(run(...))` call a Promise, whose `.stdout` is `undefined`. The move
therefore is:

- `run()` becomes `async` — it can be as small as `return runAdmin([...args])`;
- **every one of the 25 moved call sites gains `await`**, including the nested
  form: `parse(run(...))` becomes `parse(await run(...))`. The implementing
  slice recounts the helper's own invocations at its own head and checks that
  each of *those* is awaited. The check is over invocations of the helper, not
  over every `run(` token in the file: `:153` and `:237` are `better-sqlite3`
  prepared-statement `.run(...)` calls, they are synchronous, and adding `await`
  to them — or reporting the migration incomplete because they lack it — would
  be a defect, not a completion;
- `:144`'s two call sites (`:158`, `:161`) keep the synchronous spawned helper
  and gain no `await`; a stray `await` there is harmless but a rename that
  silently routes them through `runAdmin` is the defect this proposal exists to
  avoid;
- no test callback has to change: all 11 tests are already
  `test('…', async () => {…})`.

What is carried over **verbatim is the assertions** — every `expect(...)` line
and the value it reads — not the call syntax. **No case is deleted, merged or
weakened.** The `:313`→`:283` consolidation that §3.20 floats is explicitly
**not** part of this proposal (see P8).

**2. Protected assertions and boundaries.**

| Case | What must still be asserted, at the same boundary | Move? |
|---|---|---|
| `:76` | backup create reports `taskCount`; list shows the created entry by id | Yes |
| `:91` | restore refuses without `--yes`; `preRestorePath` is set; **no `maintenance_lock` row remains** — read back through a *separate read-only `better-sqlite3` connection opened after the command returns* (#611 review) | Yes |
| `:115` | restore with a deleted live database still reports `ok:true`, and the restored file carries the backup's single task (`COUNT(*) FROM tasks` = 1) and **no `maintenance_lock` row**, read back through the same separate read-only connection as `:91` | Yes |
| `:144` | restore refuses when `--artifact-root` names a gone artifact directory: **a non-zero real process exit status (`:174`)**, `ok:false` with the `artifactDir` error, live database untouched (the task is still readable through a fresh `SqliteTaskStore`) | **No — stays spawned** |
| `:188`, `:205` | preview reports eligible/excluded counts and **never creates `retention_*` tables** (#611 review) | Yes |
| `:218`, `:272` | prune refuses without `--yes`, refuses `--yes` without a fresh backup, and refuses `--yes` without rollup coverage even when a fresh backup exists | Yes |
| `:230` | an old task with an unresolved Tool Request does not block coverage gating for other eligible tasks (#611 review) | Yes |
| `:283`, `:313` | intervention counts survive pruning; prune status reflects a completed watermark | Yes |

**What this suite does *not* assert about the lock, and what the move therefore
cannot preserve.** Both `:91` and `:115` observe `maintenance_lock` exactly once,
*after* the command returns, and both observe its **absence**. Neither observes a
lock *held* at any point: that `:115` seeds a protected lock before the swap, and
that `:91`'s invocation held one at all, are **unverified implementation details**
— they are stated in `:115`'s test title and in both cases' comments, not in any
`expect(...)`. `:144` inspects `maintenance_lock` not at all; its fail-closed
path's lock behaviour is likewise unobserved. An earlier draft of this table
listed the pre-swap seeding as a protected assertion of `:115`; it is not one, and
crediting it would have let the implementing slice believe a fact was covered when
nothing reads it. Consequently these three cases can detect a regression that
**leaks** a lock row, and cannot detect one that **skips acquisition**. The move
must carry the release-observing assertions over verbatim; it must not be
described as preserving acquisition coverage, and — per this Issue's "do not
weaken, do not score-chase" boundary — #1114 may neither add the missing
acquisition assertion nor delete the comments that describe it. Naming that gap is
a candidate for a separate Issue, not work for this pilot.

**Boundary facts — and the one case that does assert the process boundary.**
`:144` asserts, at `:174`, `expect(restored.code).not.toBe(0)`. That value is
`err.status` from `execFileSync` (`:23`): the exit status the real
`node dist/cli/admin.js` process returned to its caller. `runAdmin` does not
observe that status — it **synthesizes** one, by catching the sink's `CliExit`
and otherwise falling back to `process.exitCode`
(`test/helpers/admin-cli.js:97-100`, `:129-133`) — and
`test/helpers/admin-cli.js:26-33` names exactly this case class in its *"what
this deliberately does NOT replace"* list: *"that the real process exit status is
what a shell/n8n caller observes"*. An earlier draft of this plan moved `:144`
with the other ten and claimed every P1 case kept its boundary. **That claim was
wrong**, and it is withdrawn: `:144` is the only run in this suite whose refusal
path is observed as a real non-zero process exit, and moving it would replace
that observation with the harness's own arithmetic.

**`:144` therefore stays spawned, in full.** Its `backup create` at `:158` stays
spawned with it: splitting one case across two invocation modes to save a single
start-up buys almost nothing and makes the fixture harder to reason about.
Keeping only `:161` spawned would preserve the same coverage and is permitted,
not required. The cost of the exception is two Node start-ups out of 27, and it
keeps the process-exit boundary asserted at the boundary.

The other ten cases assert no process boundary: no exit status, no signal, no
stream-separation claim, no "this resource is still held after the command
died". `expect(restored.code)` at `:174` is the suite's only reference to a run's
status; every other case reads only parsed stdout. No case in the suite — `:144`
included — runs `git`, spawns `gh`, or reaches any spawn site inside the
admin CLI. §4 of `test-maintenance-candidates.md` lists `:91` and `:115` under
*lock lifecycle*, and §3.20 already discharged that for them: `runBackupRestore`
(`src/cli/admin.ts:13163`, unchanged at this head) ends every path with
`emit` + `process.exitCode` + `return` and never `die()`, and releases/closes
`oldLock`/`liveLock` in its own `finally` (`:13289-13293`), which runs
identically in both invocation modes. So divergence 1 (a `finally` a real exit
would skip) and divergence 3 (handles reclaimed by process death) do not apply
to the restore cases.

Four checks the implementing slice must perform, and three of them are **not**
discharged by the inherited analysis:

- **Divergence 1, for the non-restore commands.** §3.20 analysed `restore`
  only. `maintenance preview`, `prune run`, `prune status`, `archive rollup`
  and `interventions` have **not** been checked for a `die()` path whose lock
  release or store close depends on process exit. Each must be read before its
  case moves; any that does keeps its spawn.
- **Divergence 3, for every command.** In-process, a store the command fails to
  close stays open in the worker and can hold WAL/SHM state into the next test
  of the same file. Today process death hides that. Each moved command must be
  shown to close its stores, or its case stays spawned. `:91`'s own read-only
  connection must still open *after* the command returns and be closed.
- **Divergence 2, `DEFAULT_SESSIONS_PATH`.** The maintenance/prune/interventions
  cases pass `--session-id addon-dev` but **never** `--sessions-path`, while the
  suite writes a `sessions.json` the CLI is never pointed at. Both modes resolve
  `DEFAULT_SESSIONS_PATH` from the test-owned HOME (#1063) — spawned inherits the
  worker environment because `run()` passes no `env`; in-process it is captured
  once per worker from the same HOME — so the resolved path is the same. The
  implementing slice must confirm that, and must not "fix" the suite by adding
  `--sessions-path` as part of a move: that would change what the cases exercise.
- **Divergence 4, `env` to child processes.** Not reached: these commands spawn
  nothing. `run()` passes no `env` today, so there is nothing to preserve.

Fixture independence and order isolation are unchanged: `beforeEach` still
creates a private `mkdtemp` directory with its own `dbPath`, `backupDir` and
`sessions.json`, and `afterEach` still removes it. `runAdmin` snapshots and
restores `process.env`, `process.cwd()`, `process.exitCode` and the output mode
around every run, which is the state the 25 moved calls would otherwise now
share. `:144` keeps its own process per invocation and shares none of it.

**3. Benefit.** **Hypothesized, not measured.** The predicted saving is the
removal of 25 of 27 `node dist/cli/admin.js` start-ups, each of which loads the whole
admin CLI module graph and `better-sqlite3`. The suite runs no `git` and builds
no repository, so start-up is the plausible dominant cost — but the only support
for the size of that effect is historical and from a different suite: #1018
recorded `admin-cli.test.js` spending "~43s of a ~420s Jest run paying Node
startup over and over" (`test/helpers/admin-cli.js:8-9`). The 23.3 s median /
28.7 s max figure for this suite is a 2026-09-13 observation at `9b278b20` and
is **not** a usable before-measurement.

To substantiate a speedup, #1114 must take its own before-measurement, by §5.1's
protocol, at the revision it is changing. A plausible outcome is a saving
smaller than the suite's own run-to-run spread; §5.4 says what to do then.

**4. Mutation evidence.** **None applies, in either direction.** This suite is
not one of the four scoped suites, and neither `src/stores/sqlite-backup-store.ts`
nor `sqlite-maintenance-lock.ts` nor `sqlite-retention-store.ts` is in
`BASELINE_MUTATE`. A move also changes the observable boundary, which is exactly
why `test-maintenance-candidates.md` §6 excludes moved suites from mutation
comparison: a before/after score would compare an unobservable population with
an observable one and overstate preservation. Preservation here is argued from
the assertions in record 2, per §7 item 5 — and **no mutation run is proposed,
before or after, for this proposal.**

**5. Missing evidence, cost, rollback, disposition.**

- *Missing*: a current cost for this suite (acquire by §5.1, **≈17 min per half
  and ≈34 min for the before/after pair** — see §5.1's costing; the older
  ≈12-minute figure was for the historical two-run invocation and does not cover
  §5.3's added warm-up); the divergence-1 and divergence-3 reads for the five
  non-restore commands (code reading, minutes, no execution).
- *Rejection criteria*: any case whose named assertion cannot be kept at the
  same boundary stays spawned, and the move proceeds without it; if more than a
  few cases must stay, the proposal is reported as not worth its risk rather
  than forced through.
- *Rollback*: the change is confined to one test file — its two helpers, its
  import and the `await` added at each of the 25 moved call sites; reverting
  that file restores the spawned suite exactly.
- *Disposition*: **proposed for approval.** It is the best-evidenced low-risk
  item in the inherited material: a completed divergence analysis, a suite with
  exactly one process-boundary assertion — which this proposal leaves spawned —
  no deletions, and a mechanism with a measured precedent in this repository.

### P2 — pin the grant expiry boundary in `tool-request-grant.test.js`

**Disposition: proposed for approval. Class: quality repair (test addition). Slice: #1114.**

**1. Target and classification.** `test/tool-request-grant.test.js`, the
`tool-request-grant — status` block at `:131-145`. One test is **added**; none is
changed, merged or removed. This is not an optimization and does not reduce
cost; it is the one repair the inherited evidence supports on positive evidence.

**2. Protected assertions and boundaries.** Nothing existing is touched. The
three current cases stay verbatim: `:132` active, `:136` expired, `:141`
exhausted. The new case pins the instant `now === expiresAt`, which
`src/core/tool-request-grant.ts:242` decides with `>=`:

```js
test('expired at exactly expiresAt (boundary; issue #1112 survivor 10)', () => {
  const g = baseGrant({ ttlMs: 1000 });
  expect(grantStatus(g, g.expiresAt)).toBe('expired');
  expect(grantStatus(g, new Date(Date.parse(g.expiresAt) - 1).toISOString())).toBe('active');
});
```

Deriving `now` from `g.expiresAt` rather than from a literal keeps the case
pinned to the boundary if the default TTL or the clamp ever moves. The case is
pure: no process, no git, no SQLite, no lock, no shared fixture, nothing to
clean up, no ordering dependency.

**This pins the behaviour production already has; it does not choose it.**
`mutation-pilot-baseline.md` §6.1 is explicit that whether a grant is usable *at*
its stated expiry instant is a design choice and that the finding is only that
nothing records which choice was made. If a reviewer thinks the choice itself
should change, that is a different Issue with a different authority — not this
chain, and not this test.

**3. Benefit.** **No speedup, and none claimed.** One added assertion pair costs
microseconds. The benefit is fault detection: a boundary in the security-relevant
grant-lifetime decision moves from unasserted to asserted. Under this pilot's
stated priority — verification quality over speed or test count — that is the
kind of change the chain exists to find.

**4. Mutation evidence.** This is the one proposal with a **crisp, measured,
per-mutant** justification. Stable identity:

| Field | Value |
|---|---|
| Location | `src/core/tool-request-grant.ts:242:7` |
| Mutator | EqualityOperator |
| Original → replacement | `now >= expiresAt` → `now > expiresAt` |
| Status in run `999e715b-9e2c-4b54-a2ea-3208fd238865` | **Survived** (survivor 10, the only survivor classified as a *potential weak assertion* on positive evidence) |
| Why it survived | `tool-request-grant.test.js:136` probes `2026-06-20T01:00:00.000Z` against an `expiresAt` of `2026-06-20T00:00:01.000Z` — an hour past the boundary, so real and mutant agree |
| The contrast that makes it a finding | the sibling `uses >= maxUses` at `:241` **is** pinned by `:141` (`uses === maxUses` exactly), and **every** mutant of that condition is among the 25 killed |

Limits, stated: this mutant sits inside the frozen range, so it is one of the 12
mutants that *are* measured; everything else about `tool-request-grant.ts` —
`normalizeCommand`, `hashCommand`, `createToolRequestGrant`, `grantMatches` — is
outside the baseline and unmeasured. Attribution of *coverage* is missing for
this mutant as for all others (`coverageAnalysis: off`); what is known is that
no test failed for it.

**Predicted effect, which must be read back and not assumed**: after the
addition, this mutant should be *killed* by `tool-request-grant.test.js`, and no
other mutant's status should move. **Reading it back is not optional, and it is
not conditional on P3 ever proceeding.** This addition is exactly what makes the
pilot's final head differ from every published mutation result (§5.2), so the
pre-P2 before-run in #1114 and #1116's after-run are the pilot's own mutation
comparison; survivor 10's row is read out of that pair by identity (§8 F, §8 C).
The assertion itself is the evidence that the boundary is pinned; the comparison
is the evidence that pinning it moved detection and moved nothing else.

**5. Missing evidence, cost, rollback, disposition.**

- *Missing*: no further evidence is needed to justify the addition. The
  before/after comparison that reads its effect back is priced in §8 F and owed
  by #1114 and #1116 (§8 C).
- *Interaction, and it matters*: this addition changes one of the four scoped
  suites, so **it invalidates the #1112 baseline as a before half — the whole of
  it, not the `tool-request-grant.ts` entry alone**. All four suites run against
  every mutant (`mutation-pilot-baseline.md` §5: `testsCompleted: 180` for every
  evaluated mutant), so a change to any one of them changes the population that
  judges all 38, including the 26 in `chain-linear.ts`; §10 of that report draws
  the line at "any change … to one of the four suites" without qualifying it by
  mutate entry, and this plan does not narrow it. §5.2 states the resulting rule.
  It does **not** invalidate the baseline as a *decision input* — the survivor-10
  identity this proposal rests on is published in §6.1 and stays readable.
- *Rejection criteria*: if a reviewer holds that adding any test inside a scoped
  suite during the pilot is score-chasing, the honest answer is to park this and
  record the gap; §6 is where that argument belongs. The distinction this plan
  draws is in P8.
- *Rollback*: delete the added test.
- *Disposition*: **proposed for approval.**

### P3 — cheapen the fake `gh` stand-in in `admin-chain-edit.test.js`

**Disposition: deferred pending evidence. Class: optimize (setup/process). Slice:
none in this pilot — a dedicated Issue if §8 A's gate clears.** It is not #1115's:
a fixture optimization is not consolidation, and #1115's Work authorizes approved
consolidation and removal only (§2). It is not #1114's either, because a fixture
mechanism that 53 reviewed tests depend on plus a ≈95-minute mutation before-run
is not the "low-risk" slice #1114 is scoped for, and because §8 A may close it
before any Issue is needed at all.

**1. Target and classification.** `test/admin-chain-edit.test.js`, the
`FAKE_GH_SOURCE` stand-in at `:44-174`, written to a temp `bin/gh` per test
(`:244-245`) and reached through `PATH` (`:220`). It is a `#!/usr/bin/env node`
script, so **every `gh` call the production code makes is a new Node process**.
Setup/process optimization: fixtures only, no production seam, no assertion
touched.

**2. Protected assertions and boundaries.** This is the highest-value suite in
the repository and the most dangerous to touch. It holds 12 test bodies carrying
an "issue #791 review" comment plus the overlapping-edits block at `:1327`; six
rows of `test-maintenance-candidates.md` §4 name cases in it. Any change must
keep:

- `:544` ("apply creates the relationships, registers the accepted graph, and
  restores the labels") on the real spawned stand-in — #1110 §3.1 keeps it there
  as the proof that `gh` is resolved through `PATH`/`spawnEnv()`;
- `:1511`, which asserts the owner `pid` and that a run blocked inside a
  provider call keeps its claim — a real second process;
- `:604`, `:731`, `:1215`, `:1298`, `:1457`, `:1559`, whose concurrent writer or
  sabotage hook is a separate Node process started from inside the fake `gh`
  (`:91`, `:150`, `:166`);
- the durable per-Issue state files (`blocked-<n>.json`, `labels-<n>.json`) the
  tests read back directly (`:197-215`), including the derived reverse direction
  at `:59-68` that makes the two ends of a relationship unable to disagree;
- the failure-injection contract by environment variable
  (`FAKE_GH_FAIL_BLOCKED_BY`, `FAKE_GH_FAIL_DEP`, `FAKE_GH_FAIL_LABEL_ADD`,
  `FAKE_GH_INJECT_AFTER_WRITE`, `FAKE_GH_RACE_SCRIPT`,
  `FAKE_GH_AFTER_SUSPEND_SCRIPT`, `FAKE_GH_AFTER_LABEL_ADD_SCRIPT`), each of
  which is one-shot by marker file.

**3. Benefit. Hypothesized, and its size is unknown.** This suite was the
costliest measured — 172.8 s median of 1331 s summed suite time on 2026-09-13,
about 13% — but #1110 §3.1 is explicit that "how much of that 13% an
optimization actually recovers is unknown until the fake-`gh` cost is measured
rather than estimated". This plan cannot close that, and it will not guess.

**Why it is deferred rather than proposed: the mechanism does not exist yet.**
The per-call cost is Node's start-up, and the number of calls is decided by
production code that this chain may not change. The obvious candidates each
have a defect: a `/bin/sh` rewrite would have to reimplement JSON reading,
writing and GraphQL-shaped responses in shell, which trades a measured cost for
an unmeasured correctness risk in the fixture that 53 tests depend on; a split
stand-in that answers cheap reads in `sh` and delegates writes to Node makes the
fixture two programs that must agree; and neither can be justified before anyone
knows what share of the suite's cost the `gh` spawns actually are.

**4. Mutation evidence.** This is the **only** candidate under change with
usable mutation before-evidence, and it is the reason the proposal is kept alive
rather than dropped. `admin-chain-edit.test.js` killed 14 mutants in
`chain-linear.ts:329-359` — every detection in that file — from exactly four
tests:

| Killer | Test | Killed |
|---|---|---|
| `:839` | `append extends past the head and moves it` | 7 |
| `:362` | `an Issue of the same number in another repository does not block a new chain` | 5 |
| `:526` | `preview writes nothing — no relationship, no label, no chain` | 1 |
| `:866` | `prepend attaches ahead of the root and leaves the head alone` | 1 |

Every killed mutant has exactly one `killedBy` entry, so these 14 are this
suite's own and are not masked by any other. An after-run over the unchanged
`BASELINE_MUTATE` with the four suites otherwise unchanged would therefore answer
the *kill* half of §7 item 4 directly for this suite: **every mutant it killed
before must still be killed by it.**

**It does not answer the coverage half, and nothing in this pilot can.** §7
item 4 of `test-maintenance-candidates.md` also requires that "a mutant it only
covered before must still be covered or killed by it", compared through
`coveredBy` as a set separate from `killedBy`. Under `coverageAnalysis: off`
there is no `coveredBy` for any test (§1.3), so the set of mutants
`admin-chain-edit.test.js` only covered is **unknown at both halves** — not
empty. A combined run cannot stand in for it: the 24 mutants this suite did not
kill are either killed by another suite (`killedBy` names that suite, not this
one) or not killed at all, and in both cases an unchanged combined status is
equally consistent with this suite still executing the mutant and with P3's
fixture change having stopped it from doing so. A single-suite run under the same
configuration does not close the gap either — without coverage it reports a
mutant this suite no longer reaches as `Survived`, exactly as it reports one it
reaches without asserting. And per-test coverage is out of reach at the frozen
identity (§8 F's closing paragraph: `perTest` changes the run identity and is
unvalidated through this repository's native-ESM Jest and `runAdmin`).

So for P3 this acceptance condition **remains unverified**, and this plan does
not treat the combined run, the singleton `killedBy` entries or an unchanged
score as discharging it. What follows from that is recorded in record 5 and in
§5.4 item 3: P3's Issue must either acquire per-suite coverage evidence through
a separately scoped and approved study — a paired `perTest` before/after that is
its own configuration, not the §5.2 identity, and priced before it is launched —
or state in its report that the covered-only condition of §7 item 4 is
unverified for `admin-chain-edit.test.js`, so that an operator who accepts P3
does so knowing that gap rather than on a claim that the check passed.

**But the before half for that check does not exist in a form any downstream
slice can read.**
The table above is the counts and killer names published in
`mutation-pilot-baseline.md` §5.2; the 14 *mutant identities* behind them, and
their `killedBy` attribution, are only in the absent `.mutation/` raw report
(§1.2). Matching by count is not matching by identity: a run that kills a
different 14 scores the same. So P3's after-check requires a fresh before-run at
the head P3 is changing — which is required independently by §5.2, since P2 lands
in #1114 first whenever it is approved, and is equally required when it is not
(§5.2, F3 is defined by P3's head, not by P2) — and that run must publish the **complete 38-mutant
identity/status table** before its own `.mutation/` is discarded (§8 F, run F3).

**Not "the 25 killed identities".** That fresh before-run is taken at the pre-P3
head — post-P2 in the expected shape — and P2 exists precisely to kill survivor 10
(`tool-request-grant.ts:242:7`, EqualityOperator, `now >= expiresAt` →
`now > expiresAt`), so its killed count is expected to be 26 rather than 25 and
is in any case not guaranteed to be either. Publishing only the killed rows would
silently drop the newly killed mutant and hide any other status movement between
the #1112 run and that head. The obligation is §8 F's and is unconditional: every
one of the 38 mutants, killed or not, with location (start and end), mutator,
original → replacement, status and `killedBy` where there is one. The
`admin-chain-edit.test.js` per-suite set this proposal needs is then read out of
that table by `killedBy`, whatever the totals turn out to be.

This roughly doubles P3's mutation cost and is the second reason it is deferred
rather than proposed.

Uncovered by this study, and so not answerable that way at any price: everything in
`chain-linear.ts` outside `:329-359`, all of `src/cli/chain-edit.ts` (1888 lines,
not in the mutate list), the seven child-process cases above, and `coveredBy`
attribution for anything.

**5. Missing evidence, cost, rollback, disposition.**

- *Missing, and these are the blockers*: (a) what share of the suite's current
  cost the fake-`gh` spawns are; (b) a mechanism that preserves the fixture's
  semantics; and (c) a before half for the mutation after-check, which §1.2 shows
  does not exist as readable data and §5.2 shows would be invalidated by P2 even
  if it did; and (d) per-suite coverage for the mutants this suite only covered,
  which `coverageAnalysis: off` never collected (record 4).
- *(d) is not bought by F3.* F3 and F2 establish kill preservation only. If P3's
  Issue proposes a coverage study, it is a separate configuration with its own
  paired halves, cost and operator approval, and it does not alter the §5.2
  identity of F3 or F2. If it does not, the covered-only condition of §7 item 4
  is recorded as **unverified** in that Issue's report and in #1116's, and the
  operator's acceptance of P3 is an explicit acceptance of that gap. Neither
  branch may report item 4 as satisfied for this suite.
- *Bounded acquisition*: §8 A prices (a) at roughly 25 minutes of machine time
  with no mutation run — per-call start-up and wall time recorded by the fixture
  itself during instrumented single-suite runs, divided by the wall time of
  **matched uninstrumented runs interleaved with them** (the per-call log write
  lands inside the instrumented run's wall time but in none of the recorded
  per-call figures, so the instrumented run's own duration is the wrong
  denominator) — plus a standalone
  micro-benchmark that times the stand-in **in each call shape the run
  observed** and a minimal shell stub, all **from the same parent-side clock**
  and each replay run against freshly reset state, so the gate subtracts like
  from like and weights each shape by its own
  recorded call count rather than extrapolating from one. That interleaved pair
  supplies a clean denominator only; the spawn cost itself is
  deliberately not taken as a before/after timing of
  the suite with and without a counter, because that difference is
  instrumentation overhead, not spawn cost. **The shell stub only bounds the gate from above**,
  and only for a stand-in of its own kind:
  it parses nothing, mutates no state and spawns no hook, so clearing that
  ceiling authorizes a prototype benchmark of an *equivalent* candidate, not P3
  itself (§8 A step 3, the gate) — while a candidate outside the stub's `/bin/sh`
  class is judged against the class-free ceiling instead, since `sh` start-up is
  not a proven floor for every process (§8 A). (b) is design work — a scratch prototype of it
  is now part of §8 A's gate, and its committed form is P3's own Issue.
  (c) is §8 F run F3: a
  fresh full baseline at the frozen identity, ≈95 minutes, taken at the head
  **immediately before** P3 is written — after P2 if P2 landed, and equally when
  #1114 rejected or parked it (§5.2) — publishing the complete 38-mutant
  identity/status table. It is additional to the pre-P2 and final runs the pilot
  owes whether or not P3 ever proceeds (§8 F, §7 #1116).
- *Order of the gates*: run §8 A first. It is the cheap one, and if it fails
  there is no reason to spend F3's 95 minutes. §8 A itself is ordered the same
  way internally: the shell-stub ceiling first, because it can only reject, and
  the equivalent-candidate benchmark only if that ceiling clears.
- *Disposition*: **deferred pending evidence.** If §8 A shows the `gh` spawns are
  a small share — or shows that an equivalent candidate does not recover one —
  this proposal is closed as report-only, F3 is not spent, and no
  Issue is opened for it. Closing P3 does not release the pilot from F1 and F2,
  which P2 owes on its own account. If it clears, the operator opens a dedicated Issue whose
  Work states the mechanism, §8 F's before-run and the publication obligation;
  it is not folded into #1114 or #1115. Either way #1115 has nothing to
  consolidate — which §7 treats as an acceptable outcome, not a problem to solve
  by finding something else to change.
- *Split trigger, carried forward to whatever Issue takes this*: if the mechanism
  turns out to be a rewrite of `FAKE_GH_SOURCE` rather than a tweak, propose
  splitting the rewrite out before implementing it. A rewrite of the stand-in that
  53 reviewed tests depend on is not a slice of a maintenance pilot.

### P4 — `admin-chain-inspect.test.js`: 6 of 22 cases to `runAdmin`

**Disposition: deferred pending two named code reads, at reduced scope. Class:
move (setup/process
optimization). Slice: #1114.** It is the same kind of change as P1 — the same
`runAdmin` helper, the same divergence analysis, no assertion removed — so it
belongs in the setup/process slice. An earlier draft assigned it to #1115 because
it needs a fresh cost before-measurement; §2 records why that is not a reason to
route a move into the consolidation slice.

**1. Target and classification.** `test/admin-chain-inspect.test.js` at this
head: **22 cases in 4 `describe` blocks, making 28 spawned `dist/cli/admin.js`
runs** (#1110 §3.14 says "about 27"; the exact count here is 28, listed in
record 2). Nothing is deleted or merged. **6 cases are proposed to move; 16 stay
spawned**, for the reasons record 2 gives. An earlier draft of this plan moved 20
and kept 2; that mapping was wrong, and the correction — which costs this
proposal most of its predicted benefit — is recorded under record 2 and §6.

**2. Retained-case mapping, boundaries and fixtures.**

Every case, its CLI invocations, whether it reaches the fake `gh`, and its
disposition under the move. "Same" means the case's assertions are carried over
verbatim, which is what `runAdmin` is built to allow (`test/helpers/admin-cli.js:20-21`).
As in P1, *verbatim* covers the assertions and not the call syntax — and, as in
P1, the file ends with two helpers because part of the suite stays at the process
boundary:

- `runAdmin` is `async` (`test/helpers/admin-cli.js:79`), so **every moved call
  site gains `await`** and `parse(run(...))` becomes `parse(await run(...))`;
- **no callback has to change**: all six moved cases — `:149`, `:158`, `:403`,
  `:454`, `:549`, `:617` — are already `test('…', async () => {…})`. (The two
  synchronous callbacks in this file, `:184` and `:243`, both stay spawned under
  the corrected mapping, so the `async`-conversion an earlier draft described is
  no longer part of this proposal.);
- because 16 cases stay spawned, this file keeps **two** helpers rather
  than replacing one: the existing synchronous `execFileSync` helper (renamed
  for what it now is, e.g. `runSpawned()`) for those 16, and an `async` `run()`
  over `runAdmin` for the other 6. Both take the same
  `{PATH, FAKE_GH_STATE_DIR, ...envOverrides}` environment object, so the
  spawned cases keep their current invocation unchanged.

| Case | Runs | `gh`? | Facts asserted | Move? |
|---|---|---|---|---|
| `:133` `rejects unknown options` | `:134` | no | **`r.code === 1` (`:135`) and nothing else** | **No — argv + exit status** |
| `:138` `lists chains across sessions by default` | `:141` | no | **exit 0 (`:142`)**, `ok`, `count`, the two `chainId`s | **No — exit status** |
| `:149` `filters by --session-id` | `:152` | no | `count`, the surviving `chainId` — **no status assertion** | Yes |
| `:158` `filters by --sync-status` | `:162` | no | `count`, `chainId`, `syncError` text — **no status assertion** | Yes |
| `:169` `defaults to human-readable output; --json …` | `:171`, `:177` | no | **exit 0 (`:172`)**; human stdout is **not** JSON and names the chain and title; `--json` stdout parses | **No — exit status** |
| `:184` `reports not_found for an unknown chain-ref` | `:185` | no | **exit 1 (`:186`)** **and** `{ok: false, reason: 'not_found'}` | **No — exit status** |
| `:192` `requires a chain-ref positional` | `:193` | no | **`r.code === 1` (`:194`) and nothing else** | **No — argv + exit status** |
| `:197` `shows members, edges, aliases, frozen prefixes; by alias too` | `:221`, `:232`, `:235` | no | **exit 0 (`:236`)**; by id and by alias give the same payload; human output | **No — exit status** |
| `:243` `validate reports not_found` | `:244` | no | **exit 1 (`:245`)**, `not_found` | **No — exit status** |
| `:251` `ok: true when GitHub matches exactly` | `:263` | **yes** | **exit 0 (`:264`)**, `ok`, no findings | **No — exit status** |
| `:275` `reports drift when GitHub has an extra edge` | `:286` | **yes** | **exit 1 (`:287`)**, the drift finding and its edge | **No — exit status** |
| `:296` `structural cycle found only in the observed graph` | `:308` | **yes** | **exit 1 (`:309`)**; cycle reported from observed, not registry | **No — exit status** |
| `:316` `missing_member when GitHub names an undeclared blocker` | `:327` | **yes** | **exit 1 (`:328`)**, `missing_member` | **No — exit status** |
| `:334` `a per-member fetch failure is reported separately` | `:346` (`FAKE_GH_FAIL_BLOCKED_BY`) | **yes, failing** | **exit 1 (`:347`)**; provider error kept apart from structural findings; result marked indeterminate | **No — exit status** |
| `:361` `a provider failure does not report a false frozen-prefix conflict` | `:389` (`FAKE_GH_FAIL_BLOCKED_BY`) | **yes, failing** | **exit 1 (`:390`)**; no frozen-prefix conflict is invented from an incomplete observed graph | **No — exit status** |
| `:403` `reports an unaccepted revision as not current` | `:413` | **yes** | acceptance state, not graph shape — **no status assertion** | Yes — see the gate below |
| `:420` `frozen-prefix conflict when GitHub drops a frozen ancestor edge` | `:446` | **yes** | **exit 1 (`:447`)**, and `frozenPrefix.observed` carries an `ancestor_removed` violation (`:450-452`) against a snapshot built by `buildFrozenPrefix` (`:429`) | **No — exit status** |
| `:454` `never mutates the registry: repeated validation …` | `:464`, `:465` | **yes** | after two runs, revision, sync state and fingerprints are unchanged (read back through `store.getChainRecord` at `:467`) — **no status assertion** | Yes — see the gate below |
| `:476` `defaults to human-readable output; --json …` | `:487`, `:492` | **yes** | **exit 0 (`:488`)**; human vs `--json` shape | **No — exit status** |
| `:549` `same Issue number in two repositories is not duplicate ownership` (#1045) | `:563`, `:579` | **yes** | repository-scoped ownership across two sessions — **no status assertion** | Yes — see the gate below |
| `:586` `same Issue in the same repository is still duplicate ownership` (#1045) | `:598` | **yes** | **exit 1 (`:599`)**; duplicate ownership, named unambiguously | **No — exit status** |
| `:617` `a chain whose session is missing from the session file still validates` | `:638` | **yes** | validation against its own session — **no status assertion** | Yes — see the gate below |

**Why 16 cases stay spawned.** Two reasons, and the second is a correction to an
earlier draft of this plan.

*`:133` and `:192`* each assert exactly one thing — the exit status of a rejected
argv — and `test/helpers/admin-cli.js:26-33` names that case class verbatim in
its *"what this deliberately does NOT replace"* list: "that the real executable
parses real `process.argv` and rejects unknown options" and "that the real
process exit status is what a shell/n8n caller observes". Moved, they would
assert a status the harness synthesizes rather than one a caller observes, which
is a vacuous pass. If a reviewer holds that `:192` (a missing positional, not an
unknown option) falls outside the argv half of that list, it still stays spawned
for the second reason below.

*The other 14* stay spawned because **each of them also asserts an exit status**,
at the line record 2's table names. An earlier draft moved them, on the ground
that the status was not their *only* assertion. **The helper's exception is not
written that way.** It excludes "that the real process exit status is what a
shell/n8n caller observes" and says nothing about what else a case asserts, and
`runAdmin` does not return the status the process returned: it synthesizes one by
catching the sink's `CliExit` and otherwise falling back to `process.exitCode`
(`test/helpers/admin-cli.js:97-100`, `:129-133`). Moving those cases would
silently convert 14 real-status observations into synthesized ones, and — because
`:133` and `:192` are `chain list` and `chain show` — would leave **no spawned
case in this suite observing the exit status of `chain validate` at all**, in
either direction, although exit 1 on a validation finding is what an n8n or shell
caller routes on. That is a boundary loss, which §2's record 2 forbids a move
from incurring, and the surviving `expect(r.code)` line still passing is not a
repair: a check that can no longer fail for the reason it was written is the
vacuous pass the helper's list exists to prevent.

Two alternatives were considered and are **not** proposed:

- *Split each case in two*: keep the spawned invocation for the status assertion
  and add an in-process one for the payload. That **adds** a start-up per case
  rather than removing one, so it cannot serve an optimization.
- *Keep one spawned representative per `(command, status)` pair and move the
  rest*: this is coverage by proxy. It assumes every exit-1 diagnosis in
  `chain validate` leaves through a single exit path — nothing in the suite
  asserts that, and this plan has not read it. A future Issue may propose it, but
  only after establishing the single-exit-path fact by reading the code, and only
  while stating plainly that the moved cases' status checks are thereafter
  harness-level rather than boundary-level. It is not a correction this plan can
  make from the evidence it has.

Keeping 16 cases spawned costs P4 most of its predicted benefit; record 3 states
the reduced figure rather than the old one. Under this Issue's "quality takes
precedence" boundary that is the required trade, not a regrettable one.

**Historical regressions carried by named cases.** `:549`, `:586` and `:617` are
the #1045 repository-scoped-ownership regression set (`test-maintenance-candidates.md`
§4 names this block); the same Issue number in two repositories must not read as
duplicate ownership, and `:617` pins the missing-session path that #1045's fix
introduced. `:334` and `:361` are the #789 provider-failure pair: a per-member
fetch failure is *collected*, not thrown (`src/cli/chain-inspect.ts:517-520`),
and `:361` exists because an incomplete observed graph must not be compared for
frozen-prefix conflicts. `:454` is the read-only guarantee for the whole command.
None of these may be merged into another case: each is the only assertion of its
fact in this suite.

**Fixture independence, cleanup and order isolation.** `beforeEach` (`:97-110`)
creates a fresh `mkdtemp` per case holding `dev_loop.db`, `sessions.json`,
`bin/gh` and `gh-state/`, then opens a `SqliteChainRegistryStore`; `afterEach`
(`:112-115`) closes that store and removes the directory. Every path the CLI is
given is derived from that directory, and `seedBlockedBy` (`:72`) writes
`blocked-<n>.json` inside it, so no case can see another's GitHub state and the
order the cases run in is irrelevant. **A move does not change any of this** —
the fixture is per-case either way — but it does change who holds the file
handles, which is divergence 3 below.

**The four `runAdmin` divergences, checked against this suite.**

- **Divergence 4, `env` to child processes — the gate.** Unlike P1's suite,
  `run()` here **does** pass `env` (`:76-91`): `PATH` prefixed with the temp
  `bin/` and `FAKE_GH_STATE_DIR`. **Thirteen** of the 22 cases depend on it —
  exactly the rows marked `gh`: **yes** in record 2's table, all of them
  `chain validate`; the nine `list`/`show`/`validate not_found` cases never
  reach the fake `gh` and are indifferent to it. **Under the corrected mapping
  the gate governs four of the six moved cases** — `:403`, `:454`, `:549` and
  `:617`, six of the eight moved invocations — because the other nine `gh` cases
  stay spawned for their exit-status assertions and are unaffected by how this
  read comes out. In
  process, `runAdmin` applies `env` over `process.env` for the run and restores
  it afterwards (`test/helpers/admin-cli.js:73-75`), so the *test* side is
  handled; what must be read is the *production* side. The chain of calls is
  `runChainValidate` → `resolveIssueWorkItemProvider` (`src/cli/chain-inspect.ts:511`)
  → the GitHub work-item provider's `gh api graphql` spawn. That spawn must take
  its environment from `spawnEnv()` (`src/handlers/command-runner.ts:189`, applied
  as the default at `:739`), because Jest hands each module a **copy** of
  `process.env` and a spawn site that passes no `env` would resolve `PATH`
  against the host — reaching the developer's real `gh` and passing vacuously.
  **This is a code read of one spawn site, minutes, no execution.** If it does
  not pass `spawnEnv()`, the four moved `gh` cases stay spawned too and P4
  shrinks to **two** cases — `:149` and `:158`, two of 28 start-ups. At that size
  the proposal should be **rejected rather than implemented**: rewriting a
  22-case suite's helper structure to remove two Node start-ups is a change
  without a benefit, and §5.4's "no measurable speedup" outcome is the honest
  report.
- **Divergence 3, store close.** In process the CLI's own
  `SqliteChainRegistryStore` lives in the same worker as the test's, and
  `afterEach`'s `rmSync` runs against whatever handles are still open.
  `runChainValidate` is written to close before it can `die()` — `store.close()`
  at `src/cli/chain-inspect.ts:455`, `:463` and `:495`, with the Phase-1/Phase-2
  split commented at `:448-451` — which is the right shape; `runChainList` closes
  at `:154` and `runChainShow` at `:282`. The read is confirming that those are
  the **only** exit paths in all three commands, including the `not_found`
  returns and every `die()`. Any command that can return without closing keeps
  its cases spawned.
- **Divergence 1, `die()` and `finally`.** The `die()` paths reached here are
  argv rejection, an unreadable sessions file (`:502`), an unresolved session
  (`:507`) and provider resolution (`:513`) — all after Phase 1 closed the store.
  Each must be confirmed to hold no lock and no open handle at the point it dies;
  the suite asserts no "resource still held" fact, so nothing here needs the
  process boundary for that reason.
- **Divergence 2, `DEFAULT_SESSIONS_PATH`.** Reached, but narrowly. `validate`
  cases pass `--sessions-path` through `dbArgs()` (`:117-119`); the eight
  `list`/`show` cases pass `--db-path` only. Only `validate` constructs a
  `JsonSessionRegistry` (`src/cli/chain-inspect.ts:479`) — `list` and `show` parse
  `sessionsPath` (`:103`, `:181`) and never read it. That must be **confirmed by
  reading, not assumed**, and as in P1 the suite must not be "fixed" by adding
  `--sessions-path` to cases that do not pass it today: that would change what
  they exercise. Of the moved six, only `:149` and `:158` are in the
  `--db-path`-only group; the other four pass `--sessions-path` explicitly.

**3. Benefit.** Hypothesized: **8 of 28 Node start-ups removed**, not the "up to
26 of 28" an earlier draft of this plan claimed — the eight invocations belonging
to the six moved cases (`:152`, `:162`, `:413`, `:464`, `:465`, `:563`, `:579`,
`:638`). The other 20 stay spawned to keep the exit-status and argv assertions at
their boundary (record 2). #1110 §3.14 judged this suite "the largest relative
gain among the chain suites" on the premise that effectively all of its spawns
could go; **that premise does not survive record 2**, and this plan does not
carry the judgement forward. Historical cost 28.0 s median / 35.0 s max
at `9b278b20`; **current cost unknown**. Same before/after protocol as P1 (§5.1),
including §5.3's cache protocol — and with a ~29% cut in start-ups against a
median-to-max spread of ~7 s on the historical figures, a result inside the
noise is a likely outcome, in which case §5.4 applies and the report says "no
measurable speedup".

**4. Mutation evidence.** None applies, in either direction: spawned before,
in-process after, and `src/cli/chain-inspect.ts` is not in `BASELINE_MUTATE`.
Preservation is argued from assertions.

**5. Missing evidence, cost, rollback, disposition.**

- *Blocking read 1 — `spawnEnv()`*: `gh` must still be resolved through
  `spawnEnv()` after the move, or the four moved `gh` cases could pass against
  the host's real `gh`, a vacuous pass that is worse than a slow test. The check
  is reading the `validate` path's spawn site (record 2, divergence 4) and
  confirming it passes `spawnEnv()`. Code reading, minutes, no execution.
  **If it fails, P4 shrinks to 2 cases, not 6 — and should then be rejected, not
  implemented.**
- *Blocking read 2 — close on every path*: divergence 3 and divergence 1 above,
  for `runChainList`, `runChainShow` and `runChainValidate`. Same cost.
- *Also missing*: a current cost for this suite (acquire by §5.1). **No mutation
  evidence is needed and none is proposed** — record 4 — so §8 F does not apply
  to P4 and P4 does not wait on it.
- *Rejection criteria*: per case, as in P1 — any case whose named fact in record
  2 cannot be asserted at the same boundary stays spawned, and the move proceeds
  without it. **That criterion is what shrank this proposal from 20 cases to 6**,
  and it applies again at implementation time: the implementing slice re-reads
  the suite at its own head and moves no case that asserts a run's exit status,
  however many other facts that case also asserts. If either blocking read fails
  outright, the honest outcome is a smaller move or none, reported as such.
- *Rollback*: confined to this one test file — its two helpers, its import and
  the `await` at each of the six moved cases' eight call sites; reverting the
  file restores the spawned suite exactly.
- *Disposition*: **deferred, at materially reduced scope.** It is the same
  mechanism as P1 and carries the same low risk, but after record 2's correction
  it buys 8 start-ups out of 28 rather than 26, for a two-helper rewrite of a
  22-case suite and a second measured before/after pair. **An operator may
  reasonably decline it and close it report-only**, and this plan does not argue
  against that; §7's parked alternative for #1114 already allows it. If it is
  taken: P1 goes first — its divergence analysis is already done and reviewed —
  and P4 follows **inside #1114**, sequenced after P1's measured pair has closed
  (§7), only if both blocking reads pass. It is not a consolidation and must not
  be implemented under #1115. If that makes #1114 too large for one focused
  slice, the split to propose is P4 into its own optimization Issue — not a move
  into the consolidation slice.

### P5 — consolidate `admin-tool-request-grant.test.js:1473` against the pure suite

**Disposition: rejected. Retain unchanged. Class: consolidate. Slice: none.**

**1. Target and classification.** `admin-tool-request-grant.test.js:1473`
("quoted-whitespace exactness") against `tool-request-grant.test.js:54-97`
(quoted whitespace `:54`, escaped whitespace `:61`, newline separators
`:83`/`:91`). #1110 §3.9 lists it as a *consolidate* candidate; it is the only
consolidation in the inherited material that touches a pilot suite.

**2. Protected assertions and boundaries — and why this is a rejection.** The
describe at `:1473` holds **exactly one case**, `:1474`, and that case asserts
four facts at three boundaries:

| Assertion | Line | Boundary | Can the pure suite hold it? |
|---|---|---|---|
| `--command 'printf "a  b"'` does not match the stored `printf "a b"` | `:1479-1481` | **argv** — the doubled space has to survive the real command line into `normalizeCommand` | No. `tool-request-grant.test.js:54-97` calls `normalizeCommand` with a JavaScript string literal; the argv leg is never traversed |
| The CLI exits nonzero with `error: …'exact-command only'…` | `:1480-1481` | **CLI envelope** | No |
| `task.context.toolRequest.resolved === false` after the refusal | `:1483` | **SQLite task state** | No |
| `getOutbox()` has length 0 after the refusal | `:1484` | **outbox side effects** | No |

There is no partial consolidation available. The decision fact is not a separable
assertion that could be deleted while the other three stay: it is the `run(...)`
call the other three read the aftermath of. Deleting the case deletes all four;
keeping the case consolidates nothing. **No exact retained admin assertion at the
argv/SQLite/outbox boundary can be named, because the only case at that boundary
is the case the proposal would remove.** §7 item 3 of
`test-maintenance-candidates.md` is explicit that a pure decision test does not
replace one whose facts come from the real surface, and #1110 §3.9's own
condition — any consolidation here "must keep one argv-wiring case" — cannot be
met by a suite with one argv-wiring case.

**No amount of mutation evidence changes this.** Mutants inside
`normalizeCommand` are evaluated by the *decision* it returns; they cannot
establish that argv delivered the doubled space, that the task was left
unresolved, or that no outbox row was written. So §8 B's cost gate was never the
real gate: clearing it would not authorize the consolidation, and failing it is
not why this is rejected. The rejection is a boundary judgement, available now,
at no cost.

**3. Benefit.** #1110 §3.9: "Consolidation saves little time; it mainly reduces
duplication." No speedup is claimed and none should be — which, weighed against
record 2, settles it: nothing measurable is gained and four facts at three
boundaries are at risk.

**4. Mutation evidence — and it points the same way.** The decision this
case protects lives in `normalizeCommand` (`src/core/tool-request-grant.ts:73`)
and `grantMatches` (`:255`). **Neither is in `BASELINE_MUTATE`.** `grantMatches`
was in the first frozen range and was **refused on cost** — that range
instrumented 137 mutants against a gate of ≤51 (#1112 §2, §4.3) — so its
scope-before-lifetime ordering is explicitly recorded as unmeasured. The
measured 12 mutants cover `grantStatus` only.

The measured fact that *does* bear on this proposal points the other way: in the
measured region the two grant suites' detections are **disjoint by observation**
— 9 pure, 2 admin, every `killedBy` a singleton. That is not proof that they are
disjoint in `normalizeCommand` too, but it is direct evidence against assuming
the admin suite is a duplicate of the pure one. Equal names are not equal
coverage, and the one place anyone has looked, they were not.

**5. Missing evidence, cost, rollback, disposition.**

- *Missing*: nothing that would change the answer. A before-baseline over
  `normalizeCommand`'s lines is still missing and is still recorded as a gap
  (§8 B), but record 2 shows it is not what blocks this proposal.
- *Rollback*: not applicable. The file is unchanged.
- *Disposition*: **rejected — retain `admin-tool-request-grant.test.js:1473-1486`
  unchanged.** If a later slice wants this duplication gone, the only honest
  route is a replacement case that asserts the same four facts at the same three
  boundaries — which is the case that is already there. Reopening it requires new
  argument, not new mutation evidence.

### P6 — drop `admin-tool-request-grant.test.js` as redundant with the pure suite

**Disposition: rejected. Retain unchanged.**

**What this proposal is, precisely.** An earlier draft framed it as dropping the
admin suite's "lifetime cases". That framing does not match the evidence and is
withdrawn: the baseline does not attribute either admin detection to an
expiry or exhaustion case. The proposal considered and rejected here is the one
the measurement can actually speak to — **removing `admin-tool-request-grant.test.js`
as a whole**, on the argument that `tool-request-grant.test.js` already covers
`grantStatus`.

**The measurement refutes it.** Of the 11 killed mutants in
`tool-request-grant.ts:237-244`, **9 were killed only by the pure suite and 2
only by the admin suite**, and because every `killedBy` is a singleton, no
mutant was killed by both. The two admin-side detections are mutants at
`tool-request-grant.ts:241` (the exhaustion branch) and `:242` (the expiry
branch) — the same *lines* the pure suite reaches, but **different mutants**.

**The killing case, named.** Both are attributed to a single test,
`admin-tool-request-grant.test.js:220`, `admin CLI — tool-request grant: clean
worktree › refuses to execute when the session checkout is dirty`
(`mutation-pilot-baseline.md` §6, killer table). That is a dirty-worktree
integration case, not a lifetime case. Two things follow, and the second is the
one a later slice must not lose:

- Removing the whole suite loses both measured detections outright, which is the
  rejection.
- The evidence protects **that case specifically** — and, through it, the suite
  that holds it. It says nothing about any other case in the file. A narrower
  proposal to remove some *named subset* of this suite's cases would need its
  own argument and its own evidence; it could not be rejected *or* approved from
  this table, and the two kills here neither justify nor forbid it. No such
  subset is proposed in this plan.

That is a fact about 12 mutants over 8 lines and not a verdict on either file,
which makes the rejection stronger rather than weaker: the one region anyone has
measured showed no redundancy, and the rest is unmeasured.

### P7 — treat `chain-linear.test.js` as redundant because it killed nothing

**Disposition: rejected. Retain unchanged.**

`chain-linear.test.js` has **no measured detection anywhere in the baseline**.
That is not a weak before-picture; it is no before-picture, and
`mutation-pilot-baseline.md` §9 and §10 both say so. Its subject is the planner's
public refusals, and the frozen range is four small helpers — the two barely
overlap. Reading zero kills as redundancy would be the exact inversion the
pilot's boundaries exist to prevent: an absence of evidence used as evidence of
absence, in a file whose contract nobody has measured.

It also could not be validated. A consolidation touching that file cannot cite
preservation from this report at all, so there is no after-check that could
clear it.

### P8 — close the survivors to raise the score

**Disposition: rejected, except P2.**

Nine of the ten survivors are **unresolved** between an unreached path, an
equivalent mutant and a weak assertion, because `coverageAnalysis: off` cannot
separate them. Adding tests aimed at them would be score-chasing against the
baseline this chain exists to establish, and `mutation-pilot-baseline.md` §6 and
§10 forbid it by name. Group A (the six `compareEdges` mutants) and group B (the
three `resolveRoots` `.sort()` mutants) stay recorded as **pre-existing gaps**.
Likewise the two timeouts and the RuntimeError: they are harness and mutation
limitations, not test gaps, and the unexplained `false` timeout is not to be
"tidied up" with a second run at a different host load.

The single exception is **P2**, and the distinction is not the score: survivor 10
is the one survivor classified on positive evidence, its sibling boundary one
line up *is* pinned, and the repair pins a real contract boundary that an
assertion should have held all along. It would be worth doing if no mutation run
had ever happened.

The same applies to the `:313`→`:283` consolidation in #1110 §3.20 and the
`:796`→`:754` merge in §3.10: both would put two facts behind one assertion path,
where a failure in the first hides the second. Neither is proposed.

---

## 4. A correction to the reasoning in the inherited survivor analysis

Recorded because §7 of `test-maintenance-candidates.md` asks a reviewer to
challenge evidence limits. **It changes no number and no status in
`mutation-pilot-baseline.md`, this slice does not edit that report, and it is not
a finding about the harness.**

`mutation-pilot-baseline.md` §6.1 explains group A — all six `compareEdges`
mutants surviving — on the premise that "`compareEdges` is used only at
`chain-linear.ts:711`, `:725`, `:745`, `:832` and `:845`, and in each the sorted
list is the **content of a refusal message**", so that "the ordering is
observable only through refusal text". At this head, `:745` is not a refusal
path:

- `src/core/chain-linear.ts:743-745` sorts `edgeAdditions` with `compareEdges`
  and `:780` returns it as part of the plan;
- `src/cli/chain-edit.ts:1164` publishes it as `plannedEdges` on the preview
  path and `:1510` on the apply path; `:1327` iterates it to build
  `appliedEdges`;
- `test/admin-chain-edit.test.js:533` asserts
  `payload.plannedEdges.map(...)` **`toEqual(['10->11', '11->12'])`** — an
  ordered two-element array — for `chain new 10,11,12`, and `:554` asserts
  `appliedEdges` the same way.

So §6.1's stated reason does not hold for that call site: the path *is* executed
by a scoped suite (`:526` is one of the four killers), the sorted list does *not*
hold at most one element, and the order is *not* unasserted — `:533` asserts it.

**The survivals themselves are nevertheless ordinary equivalence on the tested
input, and that is the correct classification for all six.** One mechanism covers
them:

- `linkEdges` (`src/core/chain-linear.ts:338-344`) builds `edgeAdditions` in the
  operator's argument order, so for `chain new 10,11,12` the array reaching
  `:745` is *already* `[{10,11}, {11,12}]` — ascending under the original
  comparator, which is why `:533` can assert `['10->11', '11->12']` at all.
- **A comparator that never returns a negative value leaves such an array exactly
  as it was.** Two of the six return `0` on this input (the emptied body yields
  `undefined`, and `SortCompare` maps the resulting `NaN` to `+0`; `→ false`
  yields `0`), and for those the language's own stability guarantee settles it.
  The other four return a positive number, and there V8's TimSort settles it:
  `CountAndMakeRun` reverses a leading run **only** when its first comparison —
  `compare(a[1], a[0])`, the later element against the earlier — is **strictly
  negative**, so a never-negative comparator reports one already-ascending run
  and no reversal or merge happens, whatever the array's length.
- Mutant by mutant, on `compare({11,12}, {10,11})`: `→ true` yields `1`;
  `||`→`&&` yields `1 && 1` = `1`; the `+` at `334:57` never evaluates, because
  the truthy left operand short-circuits; and the `+` at `334:10` yields
  `11 + 10` = `21`.

So `:533` is an order-observing assertion that these particular mutants cannot
move — not because the order is unasserted, but because an already-ascending
input is a fixed point of every one of them.

**An earlier draft of this plan got this wrong**, and the correction is recorded
rather than quietly dropped. That draft read the two positive-returning mutants
(ConditionalExpression `→ true` and the ArithmeticOperator at `334:10`) as
reversing the pair and therefore failing `:533`, and inferred a possible gap in
the harness's attribution that a downstream slice would have to settle from the
raw `mutation.json` before trusting any before/after comparison. The inference
does not follow: *positive comparator* is not *reversed array*. The independent
review of this plan rejected it, and this section now states the order-preserving
classification instead. Two consequences:

- **There is no harness discrepancy here, and nothing downstream waits on one.**
  §8 D is no longer an acquisition step, and no slice needs the absent
  `.mutation/` (§1.2) for this question.
- The start/end ambiguity at `334:10` — whether the mutated span is the whole
  `||` or only its left operand — is now **moot**, which is why reading
  `mutation.json` is unnecessary. Stryker's `ArithmeticOperator` maps `-` to `+`,
  and on this input both readings are positive (`21`, or `1` by
  short-circuit). Neither can reverse the pair.

Two limits on this correction, both real. First, the positive-comparator half
rests on **V8's implementation** of an inconsistent comparator, not on the
specification, which leaves that case implementation-defined: it holds for the
pinned Node v22.6.0 that ran #1112 and that §5.3 requires both halves of any
comparison to share, and a future runtime could order these mutants differently.
Second, it is still a code read, not a measurement — this slice took none (§9).

What survives as a finding is small and worth keeping: **group A is explained, but
not for the reason §6.1 gives.** Killing any of the six would need an input whose
insertion order differs from `compareEdges`'s order — at `:745`, an
`edgeAdditions` list the operator's argument order does not already sort.
`admin-chain-edit.test.js` supplies none today. Adding one would be a new scoped
assertion taken to close a survivor, which §3 P8 rejects as score-chasing, so it
is recorded here and **not proposed**. No proposal in this plan relies on the
group-A classification either way: P3's after-check rests on the 14 killed mutants
and their singleton `killedBy` entries, not on the survivors.

## 5. Before/after measurement and comparability

### 5.1 Cost

The #1109 script, the same invocation in both halves — but with its build split
out, because §5.3's cache protocol requires a warm-up Jest run *between* the
build and the measured runs and the script leaves no hook there (see §5.3):

Run it as a script (`sh half.sh`), not as a paste into an interactive shell —
`set -e` is load-bearing here, and in an interactive shell it would close the
terminal instead of stopping the half:

```sh
set -eu                                # every line below is a prerequisite
HALF=before                            # and `after` for the second half
mkdir -p .test-cost
git rev-parse HEAD                     # record it
require_clean() {                      # `git status` exits 0 when dirty, so
  dirty=$(git status --porcelain)      # set -e alone never stops on it
  [ -z "$dirty" ] || { printf 'worktree dirty %s:\n%s\n' "$1" "$dirty"; exit 1; }
}
require_clean "before the build"       # record it: clean
node node_modules/jest/bin/jest.js --clearCache          # §5.3 cache protocol
# settle dist/ to the agreed starting state (§5.3), then:
/usr/bin/time -p npm run build         # timed separately; record its wall time
require_clean "after the build"        # record it: clean
node --experimental-vm-modules node_modules/jest/bin/jest.js --maxWorkers=4 \
  > ".test-cost/$HALF-warmup.log" 2>&1 \
  || { tail -40 ".test-cost/$HALF-warmup.log"; exit 1; }  # warm-up figures are
                                       # discarded; its exit status is not
node scripts/test-cost-baseline.mjs --repeat 2 --max-workers 4 --skip-build \
  --out ".test-cost/$HALF"             # one directory per half; never the default
```

**The prerequisites fail fast, and that is not cosmetic.** Without `set -e` the
sequence walks straight from a failed step into `--skip-build`, and
`--skip-build` is precisely the flag that stops the measuring script from
noticing: a nonzero `npm run build` leaves `dist/` stale or half-written from the
previous state, and the measured runs then time a `dist/` that does not
correspond to the half's SHA — a figure that looks ordinary and is not a
measurement of anything. **A dirty worktree is the one failure `set -e` cannot
see**: `git status --porcelain` exits 0 whatever it prints, so recording its
output would let a half that started dirty — or one whose build regenerated the
tracked workflow JSON because the checked-in copy was out of sync with the
generator ([`AGENTS.md`](../../AGENTS.md) Core Contract) — carry on into the
warm-up and the measured runs, and publish a figure for a tree that is not the
recorded SHA. `require_clean` therefore turns nonempty output into a nonzero
exit, both before and after the build; the half is rejected, not annotated.
The warm-up is the easier one to miss, because its whole
point is that its output is not read: a crashed warm-up (a missing
`--experimental-vm-modules` capability, a `globalSetup` failure, an OOM worker)
leaves the Jest cache and the page cache **partly** warmed, which shifts the
first measured run by an unknown amount rather than failing it. So its log goes
to a file under the gitignored `.test-cost/` instead of `/dev/null`, its status
is checked explicitly, and the last 40 lines are printed on failure so the
operator sees why. A half that trips any of these checks is fixed and restarted
from `--clearCache`, not resumed — the cache protocol §5.3 requires starts at
that line.

**`--out` is per half, and it is not optional.** Both halves are normally run in
the same worktree, and `scripts/test-cost-baseline.mjs` writes into one fixed
directory: it `rmSync`s each `jest-run-N.json` before that run
(`scripts/test-cost-baseline.mjs:875`) and rewrites `baseline.json` and
`report.md` at the end. With the default `.test-cost/` on both sides, the after
half **destroys the before half's per-run JSON** — precisely the per-run figures
§5.3 requires published for both halves, and §5.4 item 4's only noise estimate.
Passing `--out .test-cost/before` and `--out .test-cost/after` keeps the two
sets side by side; an operator who forgets must archive the first output before
starting the second, and a half whose per-run files cannot be produced is
re-run, not reconstructed. Both paths stay under the gitignored `.test-cost/`
(`.gitignore:5`), so the `require_clean` checks above are not tripped by the
half's own output and nothing new is committed; keep `--out` inside it rather than pointing
it at a tracked directory, which the script itself warns against
(`scripts/test-cost-baseline.mjs:374-379`).

`--skip-build` (`scripts/test-cost-baseline.mjs:79-80`, `:852-870`) is what makes
that ordering possible: without it the script runs `npm run build` itself
immediately before the first measured run (`:852-855`), so no warm-up can sit
after the build. Two things the script then stops doing, which the operator must
do by hand and record: timing the build (hence `/usr/bin/time -p` above, kept
apart from the test runs as before) and the post-build worktree recheck
(`:866-868`) — the build regenerates the tracked workflow JSON when the
checked-in copy is stale, so that recheck is not optional, and a nonempty result
rejects the half (`require_clean` above) rather than being recorded beside its
figures. Everything else about
the invocation, including `--repeat 2 --max-workers 4`, is unchanged, and the
warm-up uses the same worker count as the measured runs.

Record for each half: the SHA, worktree cleanliness before and after the build,
Node/npm/Jest/TypeScript versions, host and CPU count, `--max-workers`, the
1/5/15-minute load average before and after, free memory, the build time kept
apart from the test runs, the full-run wall time, the per-suite median and max
for every suite the change touches, **and the cache state required by §5.3 —
including the per-run figures, not only the median**. Output goes to that half's
own gitignored `.test-cost/<half>/`; only bounded sanitized figures are
published. Nothing is uploaded, and no unrelated process is stopped.

**What a half costs, for the approval this needs.** Three full-suite Jest runs,
not two: §5.3's discarded warm-up plus the script's `--repeat 2`. At the last
published full-run figure — 334.2 s and 334.1 s, `test-cost-baseline.md` §2 —
that is ≈16.7 min of Jest, plus the ≈6.4 s build and the recorded
`git`/load/memory steps: **call it ≈17 minutes per half, ≈34 minutes for a
before/after pair**, per suite-set measured. The ≈12-minute figure that an
earlier draft carried was the historical two-run invocation without the warm-up
and understates this protocol by roughly a third; it must not be quoted. The
figure scales with the full-suite time at the revision being measured, so a
slice that finds the suite has grown reprices from its own first run rather than
from this number.

**The before half must be taken at the revision being changed.** The 2026-09-13
figures are not a before-measurement for any tree that exists now
(`test-maintenance-candidates.md` §1.1, §7 item 6). A verification `PASS` is not
a measurement.

### 5.2 Mutation, where it applies at all

Two proposals touch the four scoped suites, and **both** therefore have a
mutation before/after over the unchanged frozen scope: **P2**, which lands in
#1114, and **P3**, if it is ever written. Every half of every such comparison
must hold the whole of `mutation-pilot-baseline.md` §10's identity:
mutate `src/core/chain-linear.ts:329-359` and
`src/core/tool-request-grant.ts:237-244`; the four accepted suites; StrykerJS
defaults with no mutator excluded and no `typescript-checker`;
`coverageAnalysis: off`; concurrency 2; `timeoutMS` 60000, `timeoutFactor` 2;
incremental off; Node v22.6.0, StrykerJS 8.7.1, `@stryker-mutator/jest-runner`
8.7.1, Jest 29.7.0; and a comparably quiet host with its load recorded. Commands
as `:start`/`:report` pairs, one run at a time, per `mutation-pilot-harness.md`
§2 and `mutation-pilot-baseline.md` §7.

Mutants are matched **by source location, mutator, original and replacement** —
never by report index. The acceptance test is §7 item 4's, per suite: a mutant
`admin-chain-edit.test.js` killed before must still be killed by it; the combined
run must show no newly surviving mutant. For the F1 → F2 interval, where P2 is
the only change, the **expected** movement is exactly one row — survivor 10
(`tool-request-grant.ts:242:7`, EqualityOperator, `now >= expiresAt` →
`now > expiresAt`) becoming `Killed` by `tool-request-grant.test.js` — and every
other status must be unchanged; any further movement is a finding to be reported
and explained, not rounded off as noise. Because `killedBy` is a singleton for
every one of the 25, the per-suite **kill** sets are readable from a single
combined run; a separate single-suite run is not required for them. The
per-suite **coverage** sets are not readable from any run at this identity:
with `coverageAnalysis: off`, §7 item 4's requirement that a mutant the suite
only covered stays covered or killed by it cannot be checked, and an unchanged
combined status does not check it (§3 P3 record 4). For P3 that condition is
reported as **unverified** unless P3's Issue buys separate coverage evidence
(§3 P3 record 5). P2 is additive — one new case, no existing case or shared
fixture in `tool-request-grant.test.js` edited — so no case that covered a
mutant before is changed by it; that is an argument from the diff, not a
measurement, and #1114's report states it as such. **Both halves must publish their
per-mutant identity table**, or the comparison is not reproducible by anyone who
did not hold the raw report — which is exactly the position §1.2 describes.

**Sequencing, because P2 changes a scoped suite.** P2 is in #1114 and P3 has no
slice until §8 A clears, so P2 lands first in every ordering this plan permits.
`mutation-pilot-baseline.md` §10 invalidates the
baseline as a before half on "any change … to one of the four suites", and that
invalidation is **whole, not per mutate entry**: every mutant is judged by all
four suites running together — §5 of that report records `testsCompleted: 180`
for every evaluated mutant — so changing any suite changes the population that
judged all 38, the 26 `chain-linear.ts` mutants included. An earlier draft of
this section claimed the damage was confined to the grant entry. **It is not, and
this plan does not narrow the predecessor's rule.**

The same conclusion follows from §5.3 below without reference to §10 at all: a
before/after pair whose diff contains both P2's added case and P3's fixture
change contains two changes inside the mutation input set, and §5.3 permits
exactly one. Any moved
outcome would be unattributable between them.

**The rule, therefore, and it is the only one:**

> Every mutation comparison in this pilot takes its **own** before-run, at the
> revision it is about to change, with the change under test the only difference
> between that run and the after-run.

Applied to what this plan actually proposes, that rule names **two mandatory runs
and one conditional one** (§8 F prices all three):

| Run | When | Taken by | What it is the before half of |
|---|---|---|---|
| **F1** | at #1114's base revision, **before P2 is written** | #1114 | P2 |
| **F2** | at the pilot's final head, after every accepted change | #1116 | — (it is the pilot's after half, and the identity set the pilot leaves behind) |
| **F3** | at the head P3 is about to change, **immediately before P3 is written** — whatever #1114 did with P2 | P3's own Issue | P3 |

F3 is defined by P3's revision, not by P2's outcome. In the expected shape P2 has
landed and F3's head contains it; if #1114 rejected or parked P2, F3 is taken at
the same point — the head P3's Issue branches from — and contains no P2. Either
way F3 → F2 is P3's comparison, and P3 is **not** conditional on P2: it is an
independent dedicated Issue gated only by §8 A.

F1 → F2 attributes the movement to **P2 alone** whenever P3 never proceeds, which
is this plan's expected shape: P1 and P4 touch `admin-retention.test.js` and
`admin-chain-inspect.test.js`, neither of which is among the four scoped suites,
so neither changes the population judging the 38 mutants and neither is a second
change inside this comparison. If P3 does proceed, F3 splits the interval — F1 →
F3 is P2's, F3 → F2 is P3's — because a single interval containing both changes
would be unattributable between them under §5.3. If P3 proceeds **without** P2,
F3 → F2 is P3's alone, and F1 → F3 — which exists only if F1 was taken before P2
was parked — holds no in-set change at all: it is a repeat of the same state,
reported as run-to-run variation and attributed to nothing.

**F1 and F2 are not conditional on P3.** P3's deferral removes F3 and nothing
else: P2 changes a scoped suite on its own account, so without F1 the pilot's
final state can never be compared with anything, and without F2 there is no after
half to compare it against. This is also why F1 cannot be deferred until later —
it is the last moment at which a before half without P2 in it can exist at all.

F3 is not a workaround for §10 — it satisfies §10, because P3's before half then
includes whatever P2 outcome precedes it rather than straddling it. The `.mutation/` availability problem in
§1.2 forces fresh runs independently, so each run answers both objections at
once. Two consequences worth stating:

- **The #1112 baseline is never a before half in this pilot.** It is a decision
  input and a published identity set. Sequencing P3 ahead of P2 would not change
  that, because the data the comparison needs is not on any branch (§1.2), which
  is why this plan does not propose reordering the slices.
- **Every run's slice publishes the identities — F2's as much as F1's.** The
  per-mutant table
  (location, mutator, original → replacement, status, `killedBy`) goes into the
  tracked report before that run's `.mutation/` is discarded — otherwise the next
  slice is exactly where this one is. F1's table is therefore committed *inside*
  the F1 → F2 interval by construction; it is out-of-set for that comparison
  under §5.3 and is recorded there, not counted as a second change.

### 5.3 What makes two halves incomparable

The after half must differ from the before half **only** in the intentional,
test-only change — *among the files that comparison's measured runs actually
read*. Check and record, for each comparison:

- **The diff, scoped to the comparison's own inputs.** Take
  `git diff --stat <before>..<after>` and split it in two: the files inside that
  comparison's **input set** (below), and everything else. **Inside the input
  set there is exactly one change, and it is the change under test** — a second
  one voids the comparison. Outside it, every remaining file is listed in the
  report with a one-line reason; out-of-set files do not void the comparison,
  and they are not waved through unlisted either.

  | Comparison | Input set — any change here voids the pair unless it *is* the change under test | Outside it, and recorded rather than rejected |
  |---|---|---|
  | **Mutation** (§5.2: F1 → F2, F1 → F3, F3 → F2, F1/F3 → F2 when P2 does not land) | `src/`, `tsconfig.json` and **the sandbox build Stryker actually runs**: its `buildCommand` is `scripts/mutation-build.mjs` (`stryker.pilot.config.mjs:181`, `:270`, `:581`), which runs the installed `typescript` compiler with `TSC_ARGS` (`:191`) — so the wrapper and the compiler are in-set, and `npm run build` is not; the four `PILOT_TESTS` suites (`stryker.pilot.config.mjs:99`) and every helper or fixture they import, transitively; **the Jest configuration's `globalSetup`, `globalTeardown` and `setupFiles` modules** (`package.json:46-48`) **and everything they import, transitively** — today `test/helpers/test-home.js`, which all three load (`test-home-global-setup.cjs:18`, `test-home-global-teardown.cjs:12`, `test-home-setup.js:18`); `stryker.pilot.config.mjs`; `scripts/mutation-pilot.mjs`; from `package.json`, the `jest` block (read into the pilot's Jest config at `stryker.pilot.config.mjs:406`, `:592`), the dependency pins and the `mutation:*` entries that launch the run (`package.json:19-28`); `package-lock.json` and the installed tree | Tracked reports under `docs/`, and test files outside `PILOT_TESTS` with helpers only they and no setup module use. Stryker runs the four suites and nothing else, so neither can move a mutant. **The npm build chain is out-of-set here**: `package.json`'s `build`, `build:lib`, `build:parent-child-workflow`, `build:n8n-node` and `pretest` entries (`package.json:9-10`, `:12-13`, `:17`), `scripts/build-parent-child-workflow.mjs` and the `n8n-node/` workspace — Stryker never runs them, and the sandbox starts with no `dist/` (`stryker.pilot.config.mjs:25-29`), so no product of theirs reaches a mutant. The three configured setup modules and `test-home.js` are **not** out-of-set, even though they live under `test/` — Jest loads them regardless of which suites run |
  | **Cost** (§5.1, the full-suite pairs) | `src/`, `tsconfig.json`, **all** of `test/` (which already contains the three configured setup modules), the `jest` block in `package.json` (`package.json:41-49`), **the `scripts` block's build entries and everything they run** — `build`, `build:lib`, `build:parent-child-workflow` and `build:n8n-node` (`package.json:9-10`, `:12`, `:17`), so `scripts/build-parent-child-workflow.mjs` and the `n8n-node/` workspace's own sources, `tsconfig` and `package.json` — `scripts/test-cost-baseline.mjs`, `package-lock.json` and the installed tree — **plus any tracked file a suite reads at runtime**, which here includes parts of `docs/`: the `docs-*.test.js` suites read tracked documents (e.g. `test/docs-changed-file-verification-contract.test.js:25`) | Files no suite reads and no build step consumes. `docs/metrics/` reports qualify today — no suite asserts on one — but confirm it for the files actually in the diff rather than assuming it |

  **Two inputs are in-set although nothing in the four suites imports them.**
  The first is the Jest configuration's `globalSetup`, `globalTeardown` and
  `setupFiles` modules. Jest loads them for *every* run, mutation runs included,
  and they exist to relocate `HOME` for the whole process tree
  (`test/helpers/test-home-global-setup.cjs`,
  `test-home-global-teardown.cjs`, `test-home-setup.js`) — so an edit to one
  changes the environment the 38 mutants are judged in without appearing in any
  suite's import graph. The same holds for what *they* import: all three are thin
  wrappers over `test/helpers/test-home.js`, which does the actual `HOME`
  creation, application and removal, so the input set follows the hooks'
  transitive imports and not only the three configured paths. They are inside
  both rows' input sets: the cost row reaches them through "**all** of `test/`"
  already, and the mutation row names them because the rest of that cell is
  scoped by what `PILOT_TESTS` imports. If a hook later gains another import, the
  set grows with it; the report lists the hooks' import closure at both halves.
  The second is the build itself — and the two rows have **different** builds.
  Both halves of a cost pair run `npm run build` (§5.1), so a change to
  `scripts/build-parent-child-workflow.mjs`, to the `n8n-node/` workspace, or to
  the `scripts` block's wiring alters the generated output — or the build's wall
  time, which §5.1 reports — while the `jest` block sits unchanged; naming only
  the `jest` block would classify those as out-of-set and wave through a
  contaminated cost pair. A mutation half does **not** use that chain. Stryker's
  sandbox starts without `dist/` and produces it only through its `buildCommand`,
  `scripts/mutation-build.mjs`, which runs `tsc` over `tsconfig.json` with
  `TSC_ARGS` and then checks the instrumented emit — so the wrapper and the
  compiler are mutation inputs (both are already in the harness's own
  `TOOLCHAIN_FILES`/`TOOLCHAIN_PACKAGES`, `stryker.pilot.config.mjs:466`,
  `:473`), while the workflow generator and the `n8n-node/` build are not.
  Carrying the cost row's build into the mutation row would void a valid
  ≈95-minute pair over a file no mutation run executes; omitting the wrapper
  would accept a pair whose `dist/` was produced differently on each side.

  **Why this is scoped, and not "the whole diff touches test files only".** That
  older, simpler gate would have rejected the one comparison this plan makes
  mandatory. F1 → F2 spans the whole pilot, and §5.2 requires F1's complete
  38-mutant identity table to be committed to a tracked report *before* F2 is
  taken — so `<before>..<after>` for that pair necessarily carries a
  documentation change, and normally P1's and P4's edits to
  `admin-retention.test.js` and `admin-chain-inspect.test.js` as well, which are
  test files but are not the change under test. None of the three can move a
  mutant, for the reason §5.2 already gives: the mutation run loads
  `PILOT_TESTS` only, and no report and no non-scoped suite is in it. Under the
  scoped check F1 → F2 stands with **P2 as its single in-set change**, exactly as
  §5.2 describes it, and the other files are recorded as out-of-set rather than
  mistaken for contamination.

  **It does not loosen the cost pairs.** For a cost comparison every file under
  `test/` is *inside* the input set, so §7's one-change-per-pair ordering for P1,
  P2 and P4 is untouched: P1's pair still may not contain P4's move. A file
  inside one comparison's input set and outside another's is the normal case in
  this pilot, and the two are checked separately — the same interval can be a
  valid mutation pair and an invalid cost pair, and the report says which it is
  claiming.
- `BASELINE_MUTATE`, `PILOT_TESTS`, the mutator set, `coverageAnalysis`,
  `timeoutMS`, `timeoutFactor`, concurrency and the budget are byte-identical.
- Node, StrykerJS, jest-runner, Jest and TypeScript versions are identical, and
  the checkout's installed packages match the committed lockfile — pins alone
  are not enough in a per-issue worktree
  (`mutation-pilot-harness.md` §2, `mutation-pilot-baseline.md` §7 item 1).
- Same host, same worker count, same command, load recorded at both ends. A run
  started on a busier host manufactures timeouts and is not comparable.
- Build kept apart from the measured test runs; worktree clean, checked again
  after the build.
- **Cache state equal and recorded at both ends** — see the protocol below. A
  warm after-run against a cold before-run manufactures a speedup out of nothing,
  and §5.4's acceptance step would then certify it.

**The cache protocol.** Issue #1113 requires caches to be distinguished from the
change under test, and the checks above do not do it on their own. Three caches
are in play here, and they are not equally dangerous:

| Cache | Why it matters here | Protocol |
|---|---|---|
| **Jest's cache directory** (default, under `os.tmpdir()`) | This project sets `"transform": {}` (`package.json:43`), so there is no transform cache to warm — what remains is the haste/module map and the file crawl. Small, but not zero, and it is the one that differs most between a fresh worktree and a repeatedly-used one | Clear it immediately before **each** half (`node node_modules/jest/bin/jest.js --clearCache`), so neither half inherits a module map from an earlier run; the discarded warm-up below then rebuilds it identically on both sides. Record the command, and that it ran |
| **The TypeScript build output `dist/`** | Each half builds once as its own timed step and `tsconfig.json` sets no `incremental`, so there is no `.tsbuildinfo` — but a `dist/` left over from a previous build is a different starting point from an empty one | Start both halves from the same `dist/` state and record which: either `dist/` removed before the timed build in both halves, or present-and-current in both. Never one of each |
| **The OS page cache** over `node_modules/`, `dist/` and the test files | Not directly controllable, and the largest of the three on a laptop | Precede the measured runs in **both** halves with one discarded warm-up Jest run whose figures are not reported, so both halves begin from a comparably warm page cache. Record that it happened, and the uptime and free-memory figures §5.1 already asks for |

An order and three supporting rules, because a protocol that is only followed on
one side is worse than none:

**The order inside each half is fixed, and both halves follow it identically:**
clear the Jest cache → settle the `dist/` starting state → the timed `npm run
build` → post-build `git status` recheck → one discarded warm-up Jest run → the
measured runs, launched with `--skip-build`. §5.1 spells the sequence out as
runnable commands.

**Why the build comes before the warm-up, and why `--skip-build` is required.**
The warm-up is a Jest run, and this repository's tests import compiled output
from `dist/`, so it cannot precede the build in the permitted empty-`dist/`
starting state — it would have nothing to import. Nor can it sit after the build
if the build is the script's own first step: `scripts/test-cost-baseline.mjs`
runs `npm run build` and then goes straight into its measured Jest runs
(`:852-878`) with no hook between them. Building outside the script and passing
`--skip-build` is what puts the warm-up where the page-cache protocol needs it.
The two bookkeeping steps the script then skips — timing the build and the
post-build worktree recheck (`:866-868`) — move to the operator and are recorded
by hand; neither is optional, and both halves do them the same way.

- **Report per-run figures, not only the median — and call every measured run
  what it is: warm.** The discarded warm-up above has already populated the OS
  page cache and rebuilt Jest's module map before measured run 1, so **run 1 is
  not a cold sample and must not be published as one.** An earlier draft of this
  section asked for a run-1-versus-runs-2/3 cold/warm split; under this protocol
  that split does not exist, and printing it would mislabel the measurement.
  Publish each `--repeat` run's figure separately for both halves anyway: the
  spread across those runs within one half is the only run-to-run noise estimate
  this protocol produces, and §5.4 item 4 needs it.
- **A genuinely cold figure, if anyone wants one, is a separate sample** taken
  *before* the warm-up run, with the cache-clearing steps above applied
  identically in both halves, labelled `cold` explicitly, and compared only with
  the other half's cold sample — never with a warm one. This plan does not
  require it: a cold sample of a suite is one observation with no repeat and no
  spread, and the decisions in §5.4 turn on the warm figures.
- **If the two halves' cache protocols differ in any respect, the comparison is
  void** — not adjusted, not annotated. Re-run the half that deviated.

An identical repository SHA is **not** required and must not be demanded — the
after half is by definition a different tree. What is required is that every
input above is equal and that the diff **inside that comparison's input set** is
the change under test, with the rest of the diff recorded.

### 5.4 Acceptance, rejection and rollback

For every accepted change, in this order:

1. **Assertions.** Every protected assertion in the proposal's record 2 is still
   present and still runs at the same boundary. Not "an equivalent check exists"
   — the same fact, at the same boundary.
2. **Suite result.** `npm test` passes at the changed head. That is the ordinary
   requirement and this chain does not modify it. It is a **per-slice** check and
   does not stand in for the pilot's final full-project verification, which
   #1116 runs at the head carrying every accepted change (§7 #1116); nor does any
   selected-file or staged run stand in for either
   ([`AGENTS.md`](../../AGENTS.md)).
3. **Detection**, where mutation evidence applies — P2 through F1 → F2, and P3
   through F3 → F2 if it ever proceeds (§5.2). No mutant the
   changed suite killed before is now merely covered, surviving or uncovered,
   and the combined run shows no newly surviving mutant. That is the **kill**
   half of `test-maintenance-candidates.md` §7 item 4 only. Its coverage half —
   a mutant the suite only covered before is still covered or killed by it — is
   **unverifiable at the frozen identity** (`coverageAnalysis: off`), and it is
   reported as unverified, never as passed: for P3 unless separate coverage
   evidence is bought (§3 P3 record 5), for P2 with the additive-diff argument
   of §5.2 stated as an argument. For P2 the check also
   runs forwards: survivor 10 must have moved to `Killed`, and if it did not,
   that is a finding about the added case, not a formality to record and pass. **A loss is repaired by
   restoring or repairing the test** — never by weakening an assertion, widening
   an exclusion, excluding a mutant or lowering a threshold. If it cannot be
   repaired, the change is reverted.
4. **Benefit.** The before/after figures from §5.1, with both loads **and both
   cache protocols** recorded, and §5.3's per-run figures published — every
   measured run labelled `warm`, because under §5.3's protocol every one is.
   A comparison missing either is void under §5.3 and cannot reach this step.
   With `--repeat` capped at 3 there is no real spread estimate, and #1109's own
   median-to-max gaps are large (`admin-retention.test.js` 23.3 s → 28.7 s; the
   whole run 1332.1 s → 1330.2 s). **A difference smaller than the observed
   median-to-max gap of the affected suite is not a speedup and must not be
   reported as one.**

If (1) or (3) fails, revert. If only (4) fails, the change is assertion-neutral
and free: report "no measurable speedup" honestly and **default to reverting**,
so the tree is not carrying churn for a benefit nobody measured. Keeping such a
change is an explicit operator decision, not the implementer's.

Every change in this plan is confined to one test file and is revertible by
reverting that file.

## 6. Independent review record

**Status: under independent review. No proposal above has been approved by an
operator.** The independent review lane on this documentation PR has raised
challenges and this plan has been revised to answer them (recorded below);
reviewer challenge is not operator approval, and a proposal against which no
objection was recorded is not thereby accepted.

Verdicts here come from the ordinary independent review lane on this documentation
PR — not from the planning agent, and not from a second self-review, which is not
independent approval. No proposal may be implemented, and no downstream Issue body
may be reconciled, on the strength of this document alone.

The reviewer is asked to challenge, per `test-maintenance-candidates.md` §7:

1. Whether each proposal's record 2 names **every** protected contract from
   §3 and every affected §4 row, with the test that still asserts it afterwards.
2. Whether each such test still runs at the same boundary, and whether P1's and
   P4's treatment of the four `runAdmin` divergences is complete — in particular
   the two this plan flags as **not** discharged by the inherited analysis
   (divergence 1 and divergence 3 for the non-restore retention commands).
3. Whether any claimed overlap is shown at the same boundary. P5 and P6 turn on
   this, and both are now rejected on it — is the rejection right, or is there a
   retained assertion at P5's argv/SQLite/outbox boundary this plan has missed?
4. Whether P3's proposed after-check really satisfies §7 item 4 per suite, given
   that `chain-linear.test.js` contributes no before-evidence — and whether §8 F
   is the right answer to the before half being unavailable (§1.2), or whether
   P3 should simply be closed as report-only rather than priced at 95 minutes.
5. Whether §4 is a misreading by this plan or a real gap in the inherited
   survivor analysis — and whether anything downstream should wait on it.
   **Answered: a misreading; see the record below.**
6. Whether §5's comparability checks are sufficient, and whether the
   "not a speedup" floor in §5.4 is the right one. **Partly answered: the diff
   gate was unscoped and would have rejected the mandatory F1 → F2 comparison;
   see the record below.**
7. Whether P2 is a legitimate boundary repair or the score-chasing that P8
   rejects.
8. Whether §5.3's cache protocol is sufficient and proportionate, given that
   `"transform": {}` makes Jest's own cache small here and the OS page cache the
   dominant one.
9. Whether P4's retained-case mapping is complete, and whether `:133` and `:192`
   are the right two cases to keep spawned — or whether more of the 13 `gh`
   cases belong on that list regardless of how the `spawnEnv()` read comes out.
   **Answered: many more do — every case that asserts an exit status, in P1 as
   well as P4; see the record below.**
10. Whether §1.2's finding — that the #1112 run is not available as a before half
    to any downstream slice — is correct, and whether §8 F's publication
    obligation is the right remedy.
11. Whether §7's #1116 scope discharges that Issue's own Work — in particular
    whether the fresh scoped mutation run and the final full-project
    verification are both scheduled unconditionally. **Answered: they were not;
    see the record below.**
12. Whether §8 A's gate quantity is what it claims to be, given that the stub it
    subtracts performs none of the fixture's work. **Answered: it was an upper
    bound presented as a recoverable share; see the record below.**

Recorded below: each proposal's accepted/rejected/parked outcome, the reviewer's
objection, and the resolution. **Only challenges the review actually produced are
recorded.** A row still marked *pending* means the review recorded no objection
against that proposal — not that it was examined and accepted, and not that an
operator has approved it. No outcome is written here before the review produces
it.

| Proposal | Reviewer's challenge | Resolution | Outcome |
|---|---|---|---|
| P1 | Round 3, P1: `test/admin-retention.test.js:174` asserts `restored.code` — the exit status `execFileSync` reports from the real child process — yet the plan moved that case with the rest and claimed every P1 case stayed at the same boundary. `runAdmin` synthesizes the status by catching `CliExit`, and the helper's own documentation lists a real process exit status among the things it deliberately does not replace. | **Accepted; the plan's mapping was wrong.** `:144` now **stays spawned in full**, keeping both its invocations (`:158`, `:161`) on the real executable; the file ends with two helpers, as P4's does. The move is 10 of 11 cases and 25 of 27 call sites; record 2's table gains a *Move?* column, and the "no case in this suite asserts a process boundary" sentence is withdrawn and replaced by a paragraph naming `:174` as the one that does. Record 3's predicted saving drops from 27 start-ups to 25. | Disposition unchanged: proposed for approval; **scope corrected to 10 of 11 cases** |
| P2 | Round 2, P1: the plan made the mutation comparison conditional on P3, but P2 changes a scoped suite and §1.2 says #1112's identities and `killedBy` are unavailable — so with P3 deferred the pilot would land a detection change it could never compare, and #1116's required fresh scoped run had no before half to pair with. | **Accepted.** §5.2 now names three runs: **F1** (pre-P2, taken by #1114), **F2** (final head, taken by #1116) and **F3** (P3's only, conditional). F1 and F2 are mandatory and independent of P3; §8 F prices them at ≈190 minutes total and F1 is flagged as the one run with a deadline. §8 C stops being an optional extra purchase and becomes the F1 → F2 read-back at zero extra cost, and §7 #1114 records what the report must say if the operator declines F1. | Disposition unchanged: proposed for approval; **its comparison obligation added** |
| P3 | Round 1, P2: slice assignment. #1115's Work authorizes approved consolidation/removal only, so implementing this setup/process optimization there would be an unrequested code change or a silent repurposing of the slice ([`AGENTS.md`](../../AGENTS.md) No-Direct-Edits Policy). | **Accepted.** P3 removed from #1115. It has no slice in this pilot: if §8 A's gate clears it gets a dedicated Issue, and if it does not it closes report-only with no Issue at all. §2's slice-assignment rule was corrected — needing new before-evidence changes a proposal's price, never its class. | Disposition unchanged (**deferred**); slice re-routed |
| P3 | Round 2, P2: §8 A's gate quantity `Σᵢ Nᵢ × (nᵢ − f)` times the functional Node fixture against an `exit 0` shell that does no parsing, no state mutation, no failure injection and no hook spawn. The difference therefore contains work a correct replacement must retain; it is a best-case ceiling, not a recoverable share, and could clear the gate even where no equivalent implementation beats the suite's noise. | **Accepted.** The quantity is renamed `U_proc` and labelled an upper bound throughout. The gate is now two steps: step 1 uses `U_proc` for **early rejection only**, and step 2 requires `R = Σᵢ Nᵢ × (nᵢ − cᵢ)` from a benchmarked scratch prototype that reproduces each shape's dispatch, parsing, state writes, one-shot failure markers and hook spawn — with unreproduced shapes charged `cᵢ = nᵢ`. Only `R` exceeding the spread authorizes P3 and its ≈95-minute F3. §9 records that no figure in this plan is a measured speedup for P3. | Disposition unchanged (**deferred**); gate strengthened |
| P3 | Round 7, P2: the combined run's singleton `killedBy` entries establish that P3 preserves this suite's 14 kills, but not that it preserves the mutants the suite previously only *covered*. With `coverageAnalysis: off` those `coveredBy` sets are unknown, so an unchanged combined status can conceal a coverage loss in `admin-chain-edit.test.js`, and `test-maintenance-candidates.md` §7 item 4 requires that fact to be preserved too. | **Accepted; the plan treated the combined run as sufficient.** §3 P3 record 4 now limits the F3 → F2 check to the kill half of item 4 and states why neither a combined nor a single-suite run at the frozen identity can check the coverage half; record 5 adds it as missing evidence (d), which F3 does not buy. P3's Issue must either acquire per-suite coverage through a separately scoped, priced and approved study outside the §5.2 identity, or report the covered-only condition as **unverified**, with the operator's acceptance of P3 an explicit acceptance of that gap. §5.2 and §5.4 item 3 say the same, and P2's coverage half is recorded as an argument from its additive diff, not a measurement. | Disposition unchanged (**deferred**); acceptance condition recorded as unverified rather than satisfied |
| P4 | Round 3, P2: the plan moved cases that assert `.code` while keeping only the two whose exit status is their *sole* assertion. Those checks observe a real child-process status today and would observe `runAdmin`'s synthetic one afterwards; the helper's subprocess exception is not limited to cases with no other assertions. | **Accepted; the plan's mapping was wrong.** Every case asserting a run's exit status now **stays spawned**: 16 of 22, leaving **6 moved** (`:149`, `:158`, `:403`, `:454`, `:549`, `:617`) and 8 of 28 invocations. Record 2's table names the asserting line per case; the rationale paragraph is rewritten, and the two alternatives — splitting each case in two, and keeping one spawned representative per `(command, status)` pair — are recorded as considered and not proposed (the first adds start-ups; the second is coverage by proxy resting on an unread single-exit-path assumption). Record 3's benefit falls from "up to 26 of 28" to 8 of 28, #1110 §3.14's "largest relative gain" premise is withdrawn, and blocking read 1's failure case now shrinks P4 to 2 cases and **rejects** it rather than implementing it. The `:184`/`:243` `async`-conversion step disappears, both staying spawned. | Disposition unchanged (**deferred pending two reads**); **scope cut to 6 of 22 cases**, and an operator declining it report-only is recorded as reasonable |
| P4 | Round 1, P2: same slice mismatch as P3. | **Accepted.** P4 moved to **#1114**, where it belongs by class: it is a `runAdmin` move of exactly P1's kind. Sequenced last in #1114 with its own before/after pair (§7), because §5.3 permits one change per measured pair. If #1114 will not hold it, the split to propose is P4 into its own optimization Issue — never a move into #1115. | Disposition unchanged (**deferred pending two reads**); slice re-routed |
| P5 | *no objection recorded* | — | Disposition unchanged: rejected, retain unchanged |
| P6 | *no objection recorded* | — | Disposition unchanged: rejected, retain unchanged |
| P7 | *no objection recorded* | — | Disposition unchanged: rejected, retain unchanged |
| P8 | *no objection recorded* | — | Disposition unchanged: rejected as score-chasing |
| §7 #1116 scope | Round 2, P1: the proposed scope scheduled no final full-project verification, although #1116's Work requires it and [`AGENTS.md`](../../AGENTS.md) makes a complete passing full run the thing that licenses a completion claim. | **Accepted.** §7 #1116 now carries three obligations rather than one report: run F2, run and record `npm test`, `npm run typecheck` and `npm run package` at the final head with its SHA, and publish the report. Both measured obligations are explicitly excluded from the parked alternative, so a pilot that lands zero changes still verifies and still publishes an identity table. | **Scope corrected**; still a proposal for the operator to reconcile |
| §5.3 comparability diff | Round 4, P1: the diff gate demanded that `<before>..<after>` touch test files only, yet §5.2/§8 F require F1's 38-mutant identity table to be committed to a tracked report before F2 is taken — so the mandatory F1 → F2 interval necessarily contains a documentation change, plus P1's and P4's edits to suites outside `PILOT_TESTS`. The gate would have rejected the pilot's own required comparison and blocked #1116's final read, over files that cannot affect the mutation run. | **Accepted; the gate was unscoped.** §5.3's first bullet now splits the diff against that comparison's **input set** — the files its measured runs actually read — and requires exactly one in-set change, the change under test, with every out-of-set file listed and reasoned in the report rather than voiding the pair. The two input sets are tabulated: the mutation set is `src/`/build, the four `PILOT_TESTS` suites and their helpers, `stryker.pilot.config.mjs`, `scripts/mutation-pilot.mjs` and the manifest/lockfile/installed tree; the cost set adds all of `test/`, the `jest` block, `scripts/test-cost-baseline.mjs` and any tracked file a suite reads — which here includes the `docs/` files the `docs-*.test.js` suites read. F1 → F2 therefore stands with **P2 as its single in-set change**, and the identity-table commit is recorded as out-of-set at §5.2. Cost pairs are unchanged: every file under `test/` is in their set, so §7's one-change-per-pair ordering for P1, P2 and P4 still holds. | **Check corrected**; F1 → F2 remains mandatory and is now satisfiable |
| §5.1 measurement runbook | Round 5, P2: the half's shell sequence continued into `--skip-build` even if the timed `npm run build` or the discarded warm-up exited nonzero, so a half could measure a stale or partial `dist/` or an incompletely warmed cache. The warm-up was the easiest to miss, because all of its output went to `/dev/null`. | **Accepted; the runbook could produce an invalid measurement.** §5.1's block now runs as a script under `set -eu`, with the warm-up's output going to `.test-cost/$HALF-warmup.log` and its status checked explicitly (`\|\| { tail -40 …; exit 1; }`), and a paragraph states why each prerequisite is one: `--skip-build` is precisely what stops the measuring script from noticing a failed build, and a crashed warm-up leaves the caches *partly* warmed rather than failing. A half that trips a check restarts from `--clearCache`. | **Runbook corrected**; no proposal's disposition changes |
| §5.1 measurement runbook | Round 7, P2: the two `git status --porcelain` lines only recorded the worktree state. `git status` exits 0 when the tree is dirty, so `set -e` did not stop a half that started dirty, or one whose `npm run build` regenerated the tracked workflow JSON, from continuing into the warm-up and the `--skip-build` measurement — a cost half that violates the plan's own clean-worktree comparability requirement. | **Accepted; recording was not rejecting.** Both checks now go through `require_clean`, which exits nonzero with the offending paths when `git status --porcelain` prints anything, before and after the build. The paragraph under the block states why `set -e` alone cannot see this failure and that a dirty half is rejected, not annotated; the `--skip-build` paragraph says the same of the post-build recheck. | **Runbook corrected**; no proposal's disposition changes |
| §5.3 input sets | Round 5, P2: the tabulated input sets omitted real execution inputs. Every Jest run — mutation runs included — loads the configured `globalSetup`, `globalTeardown` and `setupFiles`, which the four suites do not import; and each cost half runs `npm run build`, while the cost row named only the `jest` block of `package.json` and not the build scripts or their implementations. A change to either could alter the environment or the generated `dist/` while the matrix classified it as out-of-set. | **Accepted; both were missing.** The mutation row now names the three configured setup modules (`package.json:46-48`) explicitly and points at the build's own implementation; the cost row names the `build`, `build:lib`, `build:parent-child-workflow` and `build:n8n-node` entries (`package.json:9-10`, `:12`, `:17`) and what they run — `scripts/build-parent-child-workflow.mjs` and the `n8n-node/` workspace — and its out-of-set column now reads "files no suite reads **and no build step consumes**". A following paragraph records why two in-set inputs appear in no suite's import graph. | **Check corrected**; F1 → F2 still satisfiable, with one more thing to hold still |
| §7 #1116 comparison table | Round 5, P2: the "F1 declined" row said F2 supports **no** comparison, but declining F1 does not remove F3 — §8 F still requires F3 immediately before P3, taken at a head that already contains P2 — so on the branch where P3 later clears its gate, F3 → F2 is a valid before/after for P3 that #1116 would have discarded or misreported. | **Accepted; one valid branch was misclassified.** The row is split: "F1 declined, P2 landed, **P3 never proceeded**" keeps the no-comparison outcome, and a new row records **F3 → F2 attributed to P3 alone** when P3 later clears §8 A, with P2's own effect still permanently unattributable and the report stating both. §7 #1114's "declines F1" paragraph is qualified the same way — the permanent loss is P2's before half, not every comparison. | **Table corrected**; #1116's obligations unchanged |
| §5.3 mutation input set | Round 6, P2: the mutation row did not follow the mutation run's real execution path. Stryker's `buildCommand` is `scripts/mutation-build.mjs` (`stryker.pilot.config.mjs:181`, `:270`, `:581`), not the npm build chain, yet the row pulled in "the build's own implementation, per the cost row" — the workflow generator and `n8n-node/` — while leaving the actual wrapper unnamed; and all three configured setup hooks import `test/helpers/test-home.js`, which controls `HOME` for every scoped test and was not listed. #1116 could have discarded a valid ≈95-minute pair or accepted a contaminated one. | **Accepted; the row now follows the run.** The mutation input set names the sandbox build as it executes — `scripts/mutation-build.mjs` and the installed `typescript` compiler with `TSC_ARGS` — and moves `build`, `build:*`, `pretest`, `scripts/build-parent-child-workflow.mjs` and `n8n-node/` to its out-of-set column, with the reason (the sandbox starts without `dist/` and Stryker never runs that chain). The setup hooks are now in-set **with their transitive imports**, `test-home.js` named, and the report records the hooks' import closure at both halves. `package.json` is split into the parts the run reads — the `jest` block, the pins and the `mutation:*` launch entries. The cost row is unchanged: its halves do run `npm run build`. | **Check corrected**; F1 → F2 unchanged, now judged on the files the run actually reads |
| §5.2 / §8 F run F3 | Round 6, P2: F3 was defined as "after P2 lands", while P3 is an independent Issue gated only by §8 A — so if #1114 rejected or parked P2 and §8 A later cleared, F3 had no valid revision and #1116's table had no P3-without-P2 row. | **Accepted; F3 is defined by P3's head, not P2's outcome.** §5.2, §3 P3 record 4/5, §7 #1114's sequencing note and §8 F's table now take F3 at the head immediately before P3 is written, containing P2 only if it landed; P3 stays unconditional on P2. §5.2 and §7 #1116's table gain the branch: **F3 → F2 attributed to P3 alone**, and F1 → F3 — if F1 was taken before P2 was parked — reported as run-to-run variation with no in-set change. | **Definition corrected**; no disposition changes |
| §8 A `U_proc` | Round 5, P2: the gate treated the `/bin/sh` stub cost `f` as the cheapest any process could be, so `U_proc` was presented as an upper bound on every process-based replacement and a prototype's `cᵢ ≤ f` was declared a measurement error. `/bin/sh` start-up is not a proven minimum — a small compiled executable can legitimately start faster — so the rule could reject a valid candidate. | **Accepted; the bound was over-claimed.** `U_proc` is now a ceiling **for the stub's own `sh` class** only, stated at its definition, in the gate's step 1, in the two-upper-bounds paragraph, in §3 P3's summary and in §9. Candidates of any other class — compiled, another shell, in-process — are judged against the class-free `Σᵢ Nᵢ × nᵢ`, which assumes no floor; `R ≤ U_proc` is likewise restricted to same-class prototypes, `cᵢ < f` is a legitimate result outside that class, and the prototype's class is recorded beside its figures. | Disposition unchanged (**deferred**); gate's applicability narrowed |
| §4 group-A survivors | Round 1, P2: the claimed harness discrepancy does not follow. For the already ordered two-element `edgeAdditions` this test asserts, both cited mutants return a **positive** comparator result, and a positive result is not a reversal — under the pinned Node/V8 behaviour `() => true` and the `a.blockerIssueNumber + b.blockerIssueNumber` mutant both leave `['10->11', '11->12']` unchanged. Classify them as order-preserving for this input. | **Accepted; the plan's inference was wrong.** §4 rewritten: all six mutants are non-negative on the asserted input, so none reorders it — the two returning `0` by the language's stability guarantee, the four returning a positive number because V8's TimSort reverses a leading run only on a *strictly negative* first comparison. The harness-discrepancy claim and the downstream gate that depended on it are withdrawn; the `334:10` start/end ambiguity is moot; §8 D's price falls to zero. | Claim **withdrawn**. What remains: §6.1's stated *reason* for group A does not hold at `:745`. Recorded, not proposed |

## 7. Ready-to-review scope proposals for #1114, #1115 and #1116

**These are proposals for an operator to reconcile into those Issue bodies after
the independent review. This task does not edit or activate them.** Each carries
a parked alternative, because each may legitimately end with no code change.

### #1114 — low-risk setup/process optimization

*Proposed scope.* Implement **P1** and **P2**, and take **P4** if its two blocking
reads pass. All three are test-only. P1 and P4 remove no asserted fact, and —
after §6's Round 3 correction — each leaves every case that asserts a real
process exit status spawned, so neither changes a boundary any case asserts; P2
adds one case and changes none. **P4's benefit is now 8 of 28 Node start-ups, not
26 of 28**, which an operator may reasonably judge not worth the slice; §3 P4
records report-only as an acceptable close. P4 is here,
not in #1115, because it is a `runAdmin` move of exactly P1's kind: #1115's Work
authorizes approved consolidation and removal, and neither implementing an
optimization under it nor rewriting its Work to fit one is available to this
pilot (§2).

**The order is fixed, because §5.3 permits exactly one in-set change between a
before half and an after half — and for a cost pair every file under `test/` is
in the set.** P1 and P4 are each a measured change; P2 is not,
but it adds a case — and so runtime — to the full-suite figure. A pair whose diff
contains more than one of them is incomparable, and nothing measured across it
could be attributed to either move. So:

1. Take the §5.1 before-measurement at the branch's base revision, with no
   proposal applied. **At that same revision, take mutation run F1** (§8 F) —
   the pre-P2 before half, ≈95 minutes, publishing the complete 38-mutant
   identity table into the tracked report. It is a separate run from the cost
   measurement and must not be interleaved with it; whichever runs first, the
   other starts from §5.3's cache protocol again.
2. Implement P1 alone and take its after-measurement, under §5.3's comparability
   checks — **including §5.3's cache protocol, applied identically to both
   halves**. This pair is P1's and covers P1 only.
3. Only then add P2's case, and report it as what it is: a change made after the
   measured *cost* pair closed, not covered by it — but **inside** the F1 → F2
   mutation interval, which is what F1 was taken for.
4. **P4 last, and with its own pair.** Do P4's two blocking reads (§3 P4); if
   either fails, take the partial move or none, as §3 P4 specifies. If P4
   proceeds, its cost comparison is a **second** before/after pair with P1 and P2
   already in both halves — the post-P2 head is P4's before half. It is never
   folded into P1's pair, for the same one-change-per-pair reason as step 3, and
   the report must not print one speedup covering both moves.

P2 is not measured and needs no measurement: §3 P2 claims no speedup, and one
added assertion pair costs microseconds. If an operator nevertheless wants P2's
own cost figure, it is a further pair taken after step 2 with P1 already in both
halves — not a widening of P1's. Report P1's and P4's results separately under
§5.4, including "no measurable speedup" where that is what it is. Also perform the
one cheap read this plan defers: the divergence-1/divergence-3 analysis for the
five non-restore retention commands (§3 P1).

*Sequencing note for the mutation runs.* F1 is pinned to the pre-P2 revision and
is the one run #1114 cannot take later — every head after step 3 contains P2.
F3, P3's own before half, must by contrast contain **P2** whenever P2 has landed
(§5.2) — if #1114 rejects or parks P2, F3 is still taken, at the head P3 branches
from — and it is indifferent to P1 and P4: both touch test files — `admin-retention.test.js` and
`admin-chain-inspect.test.js` — that are
not among the four scoped suites, so neither changes the population judging the 38
mutants. So any of #1114's post-P2 heads will do for F3 — any of its heads, if P2
did not land — and the one actually used
must be recorded with the run. The cost pairs and the mutation runs are separate
comparisons and must not be conflated: splitting the cost measurement around each
move does not move the mutation interval, and F1 → F2 stays P2's comparison
whatever the cost pairs do.

*If the operator declines F1.* The ≈95 minutes is a real price and an operator may
refuse it. Then P2 still lands — it is a boundary repair justified on its own
evidence (§3 P2), not on the comparison — but the refusal is **recorded in
#1114's report and carried into #1116**, which then has **no before half for
P2** and says so. That much is permanent: once P2 is in the tree, no run taken
afterwards can serve as a before half for it. What the refusal does *not* do is
delete F3. If P3 later clears §8 A's gate, §8 F still requires F3 immediately
before it, and F3 is taken at a head that already contains P2 — so F3 → F2
remains a valid before/after for **P3**, and #1116 publishes it rather than
discarding it (§7 #1116, the F2 comparison table). Declining F1 therefore leaves #1116 unable to
produce the before/after its Work asks for *for P2*, and on the branch where P3
never proceeds that is the whole of it; either way it is an Issue-body
reconciliation for the operator to make deliberately, not a gap for the
implementing slice to paper over. The alternative — parking P2 until the run is approved — is the other
legitimate branch; what is not legitimate is landing P2, skipping F1 and reporting
the pilot as if a comparison **for P2** had been available — nor, on the other
side, discarding an F3 → F2 pair that P3's own branch does produce.

*Explicitly out of scope.* Any deletion; the `:313`→`:283` consolidation; **P3**,
which needs §8 A's gate and then an Issue of its own (§3 P3); any change to
`src/`, to the harness, to `BASELINE_MUTATE` or to verification policy; any
mutation run **other than F1** (P1 and P4 need none — §3 P4 record 4 — and F3 is
P3's Issue's, not this slice's). Nothing about §4 is assigned here: an earlier
draft made it a read of `.mutation/mutation.json`, and §4 now settles the question
from the source and the pinned runtime with no file to read and no run to buy.

*Parked alternative.* If review rejects P1's move on boundary grounds, #1114
ships P2 alone plus the read, and reports the move as rejected with the reason —
and there is then **no P1 cost comparison at all**, because P1 was the only change
that pair was measuring; the before-measurement stands alone as a current cost
record (§8 E). P4 is independently parked: if blocking read 1 fails it drops to
two cases and is rejected rather than implemented (§3 P4), if blocking read 2
fails it shrinks further, and if #1114 proves too large with it, propose P4 as
its own optimization Issue (see *Size*). Closing P4 report-only on its reduced
benefit alone is also a legitimate outcome. If review rejects P1, P2 and P4, #1114 becomes
report-only: the read, the before-measurement, and a record that no change was
justified. **F1 rides with P2 and only with P2**: if P2 is rejected or parked, no
scoped suite changes in this slice, F1 is not bought, and #1116's run becomes a
re-baseline rather than an after half (§7 #1116).

*Size, and the one split this plan pre-authorizes proposing.* P1 is one test
file's two helpers plus the `await` at its 25 moved call sites (§3 P1), one added
test, one code read and two measurement runs — focused on its own. P4 adds a
second test file, of whose 22 cases 6 move, two code reads and a second
measurement pair. Together they are
at the upper edge of a focused slice. **If the implementing agent finds P4 does
not fit alongside P1 and P2, the correct response is to propose splitting P4 into
its own setup/process-optimization Issue before implementing it** — never to move
it into #1115, and never to widen #1115's Work to receive it. P4 is deferred
pending two reads in any case, so an operator may simply leave it out of #1114's
activation.

### #1115 — approved consolidation

*Proposed scope.* **None. This plan proposes no consolidation and no removal, so
it has nothing to put in this slice.** The recommendation is that #1115 be
activated **report-only**, or not activated at all, at the operator's discretion:
a short record that every consolidation and removal candidate the inherited
material offered was examined and rejected — P5 on boundary grounds, P6 against
measured detection loss, P7 for having no before-picture, P8 as score-chasing —
and that no further candidate was manufactured to give the slice work.

That is not an oversight, and an earlier draft of this plan did give #1115 work:
it routed P3 and P4 here because both need fresh before-evidence. Both are
setup/process optimizations, neither is a consolidation, and #1115's authorized
Work covers approved consolidation and removal only. Implementing them here would
be a code change no Issue requested, and rewriting #1115's Work to admit them is a
specification change this pilot may not make ([`AGENTS.md`](../../AGENTS.md)). So
**P4 moves to #1114** and **P3 waits for §8 A and then an Issue of its own** (§2,
§3 P3, §3 P4).

*Explicitly out of scope.* **P5, P6, P7 and P8 permanently.** P5 is rejected on
boundary grounds rather than deferred on cost (§3 P5): §8 B's cost gate was never
what blocked it, and clearing that gate would not reopen it. No deletion of any
case in `admin-chain-edit.test.js` or `admin-tool-request-grant.test.js`; no change
to any §4 row of `test-maintenance-candidates.md` without a named replacement
assertion at the same boundary. **Also out of scope: P1, P2, P3 and P4** — not
because they are bad changes, but because none of them is a consolidation and this
slice is not the place to implement one that is not.

*Parked alternative — and it is the proposal, not the fallback.* Zero
consolidation is this plan's expected and recommended outcome for #1115, and the
Issue's own terms allow it: "A valid plan may approve only lightweight
optimization and no deletions." Scope must not be broadened to give this slice
something to implement, and the absence of work here must be reported as a result
rather than resolved by finding a test to delete.

*If the operator does approve a consolidation later*, it arrives the same way any
other does: its own evidence, its own retained-case mapping at the same boundary,
and its own independent review. Nothing in this plan pre-approves one.

### #1116 — final comparison and runbook

*Proposed scope.* Two measured obligations and one report.

**1. Run F2 — the pilot's fresh scoped mutation run, unconditionally.** At the
pilot's final head, at the §5.2 frozen identity, under §5.3's comparability and
cache conditions: ≈95 minutes plus a ≈3-minute dry run, through the
`:start`/`:report` pairs, one run at a time (§8 F). **It is not conditional on P3,
and it is not conditional on anything else.** #1116's Work asks for a fresh scoped
run, and this plan's proposed changes make one necessary in their own right: P2
changes a scoped suite, so the pilot's final head is a state no published mutation
result describes. What F2 can be *compared* with depends on what before halves
exist, and the report must say which case it is in:

| Case | Comparison F2 supports |
|---|---|
| F1 taken, P3 never proceeded (this plan's expected shape) | F1 → F2, attributed to **P2 alone**; survivor 10's row read back by identity (§3 P2, §5.2) |
| F1 and F3 taken, P3 landed | F1 → F3 for P2, F3 → F2 for P3, each per-suite under §5.4 item 3 |
| F1 declined by the operator, P2 landed, P3 never proceeded | **None.** F2 is published as a standalone re-baseline and the report states plainly that no before half exists, that the refusal was the reason, and that it is permanent (§7 #1114) |
| F1 declined by the operator, P2 landed, P3 later cleared its §8 A gate | **F3 → F2, attributed to P3 alone.** Declining F1 does not remove F3: §8 F requires it immediately before P3, and it is taken at a head that already contains P2, so that pair is a valid before/after for P3 under §5.3 and #1116 publishes it. P2's own effect stays permanently unattributable, and the report says both things — one comparison published, one gap recorded |
| P2 rejected or parked, P3 never proceeded, no scoped suite changed | F2 is a re-baseline at an unchanged four-suite population; comparable with #1112 only at the published aggregate, never per mutant, because those identities are unavailable (§1.2) |
| P2 rejected or parked, P3 later cleared its §8 A gate and landed | **F3 → F2, attributed to P3 alone.** F3 is taken at the pre-P3 head (§5.2), which contains no P2, so P3 is that pair's single in-set change under §5.3. If F1 was taken before P2 was parked, F1 → F3 has no in-set change and is reported as run-to-run variation, attributed to nothing; the report records P2's rejection or parking as the reason no P2 comparison exists |

In every case F2 publishes the **complete 38-mutant identity table** — location
(start and end), mutator, original → replacement, status, `killedBy` where there
is one — into the tracked report before its `.mutation/` is discarded. That
obligation is what makes this pilot leave behind a before half its successors can
use, and it is the gap #1112 could not have known to close (§1.2, §8 F).

**2. Schedule the final full-project verification, and record it.** At the same
final head: `npm test`, `npm run typecheck` and `npm run package`, complete and
passing, with the head SHA and the results in the report. This is not something
the pilot may narrow or skip. Each implementing slice runs `npm test` at its own
changed head under §5.4 item 2, and that is a per-slice obligation, not this one:
a green Stage 1 is never a green suite, and CI and full project verification
outside the loop remain an independent final safeguard
([`AGENTS.md`](../../AGENTS.md)). The pilot's closing claim — that these test
changes cost the repository no detection and no correctness — is only as good as a
complete, passing full run at the head that carries all of them.

**3. The report, `docs/metrics/test-maintenance-outcome.md`:**
the before/after cost figures for whatever the pilot's slices actually changed —
in this plan's proposal that is #1114's P1 pair and, if it proceeded, its separate
P4 pair, with #1115 contributing nothing — with both halves' SHAs, hosts, loads,
**cache protocols and per-run figures (warm, per §5.3)** and the rest of §5.3's
comparability checks; the mutation comparison F2 supports, per the table above,
carrying forward the identity tables §8 F requires; the full-verification record
from obligation 2; §4's correction to
`mutation-pilot-baseline.md` §6.1's group-A reasoning, carried forward as stated
there and needing no run to confirm; and a
runbook covering the three commands an operator needs (`scripts/test-cost-baseline.mjs`,
the `mutation:*` `:start`/`:report` pairs, and `scripts/changed-file-stage-timing.mjs`)
with their costs, their locks, their gitignored output directories and the rule
that nothing is uploaded.

*Explicitly out of scope.* Any test change; any new measurement beyond F2, the
after halves this plan names and the final verification run; any recommendation
to wire mutation testing into `npm test`, CI or the loop. The pilot's own boundary
is that mutation testing stays opt-in and operator-invoked — F2 is an
operator-approved run inside one slice, not a step towards automating it.

*Parked alternative.* If the implementation slices land zero accepted changes —
which is the likely shape for #1115 by construction, and possible for #1114 if
review rejects P1 — #1116 is a report with no cost comparison in it: what was
measured, what was proposed, what was rejected and why, and the runbook.
**Obligations 1 and 2 do not park with it.** F2 becomes the re-baseline in the
table's fourth row, which is still the pilot's published identity set and still
worth its price; the full-project verification still runs, because it is what
licenses the claim that the pilot left the suite intact. If an operator wants the
pilot to close without buying F2 at all, that is a reconciliation of #1116's own
Work and must be recorded as such — not a silent omission from the report.

## 8. Missing evidence and what it would cost to acquire

Nothing below is launched by this slice. Each is a proposal with a price, for an
operator to approve.

**A. The fake-`gh` spawn share in `admin-chain-edit.test.js`** (blocks P3).

An earlier draft of this item proposed counting the stand-in's invocations and
timing the suite before and after adding the counter. **That procedure does not
measure what P3 turns on**: the difference between those two timings is the
instrumentation's own overhead, and neither run isolates the cumulative Node
start-up inside the `gh` calls. There is also no cheaper mechanism to time the
suite against yet — building one is what this gate is supposed to authorize. The
per-call cost is therefore read *inside* the instrumented run rather than as a
difference between two run kinds. The uninstrumented runs step 2 interleaves are
not a second half of that difference: they supply the denominator the
instrumented run cannot supply about itself, and no per-call figure is derived
from them.

1. **Per-call timing at the `gh` process's own clock.** In a scratch copy of
   `FAKE_GH_SOURCE`, capture `process.uptime()` on the first executable line
   (`t0`) and again from a `process.on('exit')` handler (`t1`), and append
   `<shape> <t0> <t1> <argv-json>` as one line to a samples file. `<shape>` is
   the fixture's own dispatch branch, not merely `argv[0]`: the stand-in's
   branches (`:79-174`) do materially different work — `issue view` is one
   `readJson`; `api graphql` for `blocking(` scans the whole state directory
   with `readdirSync`; the dependency and label writes are `writeFileSync`
   paths; and three branches conditionally `execFileSync` a whole further Node
   process. Distinguish at least `issue view`, `api graphql` (`blockedBy` and
   `blocking(` separately), the `--jq` id lookup, `POST`/`DELETE
   dependencies/blocked_by`, and `POST`/`DELETE` labels, and record the argv so
   step 3 can replay each shape rather than approximate it. Record with each
   line whether that call's one-shot side branch actually fired — the hook child
   at `:91`, `:150` or `:166`, and separately the in-process injected write at
   `:121-127` — since a marker is consumed by its first call and every later
   invocation of the same dispatch branch takes the plain path. Without that
   flag the spawning and non-spawning counts step 3 needs cannot be split out of
   one `Nᵢ`. `t0` is
   the time from that Node process's start to the fixture's first line — the
   interpreter start-up a cheaper stand-in would remove — and `t1` is the call's
   whole in-process cost. Two `uptime()` reads and one `appendFileSync` per
   call. The append runs *after* `t1` has been read, so it is outside both
   `Σt0` and `Σt1` — but it is **not** outside the call: it happens before the
   child exits and therefore before the parent's `execFileSync` returns, so it
   is inside the suite's wall time. An earlier draft said the instrumentation
   overhead was "in neither reported quantity"; that is wrong for the
   denominator, and step 2 takes the denominator from a matched *uninstrumented*
   run for exactly that reason.

   **The samples file must not live under `FAKE_GH_STATE_DIR`.** That directory
   is `join(tmpDir, 'gh-state')`, created per test at
   `test/admin-chain-edit.test.js:240-242`, and `afterEach` deletes `tmpDir`
   recursively (`:250-252`) — a samples file written there is destroyed after
   every test, so a run instrumented that way finishes with at most the last
   test's lines and cannot produce `N`, `Σt0` or `Σt1` at all. Instead the
   scratch copy reads a **second, run-scoped** variable, say
   `FAKE_GH_TIMING_FILE`, pointing at a path under a directory created **once
   per worker outside `tmpDir`** (`mkdtempSync(join(tmpdir(), 'gh-timing-'))`
   in a `beforeAll`) and deleted only in `afterAll`, after the totals are read
   — or, equivalently, summed in `afterAll` and printed there. Append mode plus
   one line per call keeps concurrent writers from interleaving partial records.
   The variable is added **once**, to the `env` block of the suite's own `run()`
   helper (`:217-225`), which is the same block that already passes
   `FAKE_GH_STATE_DIR` and is spread *before* each call's `envOverrides`, so no
   test's failure-injection override can drop it. That single addition covers
   every `gh` invocation in the file: `runAdmin` is called exactly once, at
   `:218` inside `run()`, so there is no fake-`gh` launch site that builds its
   own environment. In particular the standalone `.mjs`/`.cjs` scripts at
   `:615`, `:754`, `:1225`, `:1300`, `:1468`, `:1522` and `:1568` are **not**
   such sites: they are hook children the stand-in itself `execFileSync`s
   (`:91`, `:150`, `:166`), and the admin invocation that encloses them went
   through `run()` — the script created near `:615`, for instance, is handed to
   `run()` at `:630` as `FAKE_GH_RACE_SCRIPT`. The fake `gh` therefore already
   holds `FAKE_GH_TIMING_FILE` before it spawns the hook, and its own call is
   sampled normally; an earlier draft treated these paths as unrecorded, which
   would have discarded valid samples and undercounted exactly the shapes step 3
   most needs. (The hook children make no `gh` call of their own, so they
   contribute no samples themselves — their cost shows up inside the enclosing
   call's `t1`, which is what step 3's spawning shapes are meant to capture.)
   `N` is thus every `gh` invocation the suite makes. The scratch copy must
   still tolerate the variable being absent (skip the append), so the
   instrumented fixture stays usable from a scratch harness that does not set
   it — step 3's replay, for one.
2. **Read the totals off one instrumented run, and the denominator off matched
   uninstrumented ones.** Run that one suite on a quiet host
   under §5.3's cache protocol — a direct Jest invocation limited to
   `test/admin-chain-edit.test.js`, since `scripts/test-cost-baseline.mjs` has
   no path filter and would run all 316 files against a scratch fixture. Then
   sum the appended lines across every test: `N` = calls, `Σt0` = cumulative
   start-up, `Σt1` = cumulative fixture wall time. Report them **per shape**
   `i` — `Nᵢ`, `Σt0ᵢ`, `Σt1ᵢ` — as well as in total; a cheap read and a
   directory scan that also spawns a child are not the same call, and the
   per-shape counts `Nᵢ` are what step 3 weights by. Keep one representative
   argv per shape, and note the state-directory size the shape typically ran
   against, since the `blocking(` scan's cost grows with it. With several
   instrumented runs taken (below), report `N`, `Σt0` and `Σt1` from the one
   whose wall time is the median — never summed across runs, which would
   multiply `N` by the run count — and note whether `Nᵢ` was stable across them,
   since a varying call count means the suite's own path depends on the host and
   the share is not a single number.

   **The denominator comes from a matched *uninstrumented* run, not from this
   one.** Jest's `endTime - startTime` for the file (the figure
   `test-cost-baseline.mjs` summarizes as the per-suite duration) is the right
   quantity, but measured on the instrumented run it contains every per-call
   `appendFileSync`: that write happens after `t1` and before the child exits,
   so the logging overhead is absent from `Σt0` and `Σt1` yet present in the
   wall time, and dividing one by the other biases the reported fixture share
   *downward* by roughly `N × a`, where `a` is the cost of one appended record.
   Instead, in the same §5.3 session, alternate instrumented and uninstrumented
   runs of the same file round-robin, at least three of each, and report the
   median of both: the uninstrumented median `D` is the denominator, the
   instrumented median `D′` is reported beside it, and `D′ − D` is the measured
   instrumentation overhead. It should be on the order of `N × a`; if it is
   materially larger, the scratch fixture is perturbing the suite in some other
   way, and the share is then reported as a range over `[D, D′]` rather than as
   a point. Interleaving the two run kinds in one session — not taking numerator
   and denominator from a single run — is what keeps them comparable under one
   set of host conditions.
3. **The ceiling, then a candidate that actually does the work — both ends timed
   at the
   same clock boundary, and weighted per shape.** From one small standalone
   script, with no Jest involved, time `k` (≈50) `execFileSync` calls with
   `process.hrtime.bigint()` around each call, for: (i) the real
   `FAKE_GH_SOURCE` stand-in replayed with step 2's recorded argv **for every
   shape `i` that step 2 observed**, giving a mean `nᵢ` per shape; and (ii) a
   trivial `#!/bin/sh` / `exit 0` stub, mean `f`. Interleave all targets
   round-robin rather than running all of one and then all of the next, so host
   drift hits them equally, and report the median and spread of each alongside
   the mean. Replay each shape against a state directory seeded to the size
   step 2 recorded for it, so the `blocking(` scan is timed over a
   representative directory rather than an empty one; for a shape whose real
   invocations spawn a hook child — `FAKE_GH_RACE_SCRIPT` (`:88-92`),
   `FAKE_GH_AFTER_LABEL_ADD_SCRIPT` (`:147-151`) and
   `FAKE_GH_AFTER_SUSPEND_SCRIPT` (`:163-167`), the three branches that
   `execFileSync` a whole further Node process — count the spawning and
   non-spawning cases as separate shapes, because one is a second whole Node
   process and the other is not.

   **`FAKE_GH_INJECT_AFTER_WRITE` is not one of those three.** At `:120-127` the
   injected concurrent write happens *inside* the existing fake-`gh` process: it
   pushes a blocker onto the target Issue's list and calls `setBlockers`, with no
   `execFileSync` and no child at all. It is still a distinct shape — the
   dependency `POST` it rides on does strictly more work, against a second
   Issue's state file, than the plain `POST` — so it gets its own `Nᵢ` and `nᵢ`.
   But it must not be classified as child-spawning, because (iii)'s rule charges
   the spawning shapes `cᵢ = nᵢ` on the grounds that a second whole Node process
   is behaviour a cheaper stand-in cannot drop. That reasoning does not apply
   here: an in-process state write is exactly the kind of work a prototype is
   expected to reproduce, so this shape's `cᵢ` must be measured like any other.
   An earlier draft listed it with the three real hook variables, which would
   have pinned its saving at zero by assumption and biased `R` downward.

   **Reset the state and re-arm the markers before every repetition.** For the
   mutating and hook-spawning shapes, `k` calls against one seeded directory are
   not `k` measurements of the same operation. The first `POST`/`DELETE` of a
   dependency or a label rewrites the JSON the next call reads — including the
   derived reverse direction at `:59-68` — so repetitions 2…k take an
   already-present or already-absent path instead of the one being benchmarked;
   and a one-shot failure-injection marker is consumed by its first call, so
   every later repetition runs the plain branch and spawns no hook child at all.
   Averaging those together yields an `nᵢ` — and, in (iii), a `cᵢ` — for a
   mixture of operations nobody proposes to replace, and since both feed
   `U_proc` and `R`, the gate below would then decide on the wrong number. So
   before **every** repetition, for the real fixture and for the candidate
   alike: restore the seeded state directory to the representative snapshot
   (remove it and re-copy from a template built once, rather than mutating it
   back) and re-create the one-shot marker and the hook script the shape's
   environment points at.

   **The state directory is not the whole input for the hook-spawning shapes.**
   The scripts those three variables point at do their work on a *separate*
   SQLite database — `dbPath`, which lives beside `gh-state` under `tmpDir` and
   is never touched by re-seeding `FAKE_GH_STATE_DIR`. They update
   `dependency_chain` rows (`:757-762`), rewrite `dependency_chain_edit_lock`
   ownership (`:1471-1477`, `:1571-1577`), create a chain through the real store
   (`:619-624`), and one of them renames `dependency_chain_frozen_prefix` out of
   existence (`:1228-1232`). Each is a one-way change to the database: from
   repetition 2 onwards the same script takes a different path or fails outright
   — the `ALTER TABLE` cannot rename a table that is already gone, the chain
   creation hits `alias_taken`, the lock row is already owned — so both `nᵢ` and
   `cᵢ` would be averages over a first real call and `k − 1` degenerate ones,
   and the gate below would decide on that mixture. So the per-repetition reset
   must restore **every external target the hook writes to**, `dbPath` above
   all: rebuild it from a template copied once (or hold a whole fresh fixture
   directory per repetition, which is simpler to get right and costs only setup
   time outside the timed window). Verify it the same way as the state
   directory — confirm the hook still took its intended branch on the last
   repetition, since a hook that silently failed early is fast for the wrong
   reason and its `nᵢ` is not a measurement of the shape.

   Do the reset **between** the timed windows —
   `hrtime.bigint()` is read immediately before and after the `execFileSync`
   call alone — so no reset cost lands in `nᵢ`, `f` or `cᵢ`. Give the stub the
   same reset treatment even though it ignores the state, so the round-robin's
   cadence and page-cache pressure are identical across targets. A shape whose
   repetitions are verified non-mutating may skip the re-seed — the two
   `api graphql` reads, `issue view`, the `--jq` id lookup — but the report must
   say which shapes were reset and which were not, because a shape recorded as
   reset-free and later found to mutate invalidates its `nᵢ`. Confirm per shape
   that the replayed call still took its intended branch (the marker was present
   and consumed, the write actually changed state), since a silently
   already-satisfied replay is fast for the wrong reason.

   `nᵢ` and `f` are all measured in the parent and all include the parent's
   fork/exec bookkeeping, so **`nᵢ − f` is a difference of like quantities**:
   the per-call distance, for shape `i`, between the Node stand-in and a
   do-nothing script **under the same `/bin/sh` implementation as the stub**. The
   suite-level figure is the **weighted sum**

   > `U_proc = Σᵢ Nᵢ × (nᵢ − f)`

   — each shape's own count times its own per-call distance.

   **`f` bounds one process class, not all of them.** `/bin/sh` start-up is not a
   proven minimum for spawning a child: a small compiled executable, or a
   lighter shell, can legitimately start faster than this host's `sh`, and
   nothing measured here says otherwise. So `U_proc` is a ceiling **for a
   replacement in the stub's own class** — a `sh` script run by the same shell
   binary on the same host — and for any other class the applicable ceiling is
   the class-free `Σᵢ Nᵢ × nᵢ`, which assumes no floor at all. Say which class
   each reported ceiling belongs to, and pair a candidate with the ceiling that
   matches it; rejecting a compiled or non-`sh` candidate on `U_proc` rejects it
   against a floor it is not bound by. **A single
   "representative" `nᵢ` multiplied by the total `N` is not valid here** and
   must not be reported: the shapes differ by a directory scan, by writes, and
   by an entire extra child process, so whichever one were picked would bias
   the estimate by an unknown factor in an unknown direction, and both steps of
   the gate below would turn on it. An earlier draft of this item did
   exactly that. If some shape's count is too small to be worth its own
   benchmark, fold it into a *demonstrably safe* bound instead — meaning the
   assignment that is **least favourable to the claim being made**. Charge those
   calls the **largest** measured `nᵢ` when arguing for rejection, so the
   ceiling is at its most generous and falls below the spread anyway; charge
   them the **smallest** when arguing that P3 should proceed, so no approval
   rests on an unmeasured shape assumed to be expensive. (An earlier draft had
   this pair the other way round, which would have let an unbenchmarked shape
   argue for proceeding.) Say which bound each reported figure used.

   **What `U_proc` is, and what it is not.** `f` times an `exit 0` shell that
   does none of the fixture's work: it does not parse argv, does not dispatch a
   branch, does not read or write the per-Issue state files, does not honour a
   one-shot failure-injection marker and does not spawn a hook child. Every one
   of those is behaviour §3 P3 record 2 requires any replacement to keep. So
   `nᵢ − f` contains, alongside the interpreter start-up a replacement could
   genuinely drop, all the semantic work it must genuinely retain, and
   **`U_proc` is a best-case ceiling on the saving, not the recoverable share.**
   A ceiling is large whenever the current fixture is expensive, including when
   no correct replacement can beat the suite's own noise — so `U_proc` alone can
   reject P3 and can never authorize it. An earlier draft of this item called it
   "the share a mechanism could actually recover" and gated P3 on it directly;
   both are withdrawn, and no reported figure may describe `U_proc` that way.

   (iii) **The equivalent candidate, benchmarked before anything is
   authorized.** If `U_proc` survives the ceiling test below, write a *scratch*
   prototype of the candidate stand-in — never committed, exactly like the
   instrumented fixture in step 1 — that reproduces, for each replayed shape,
   the dispatch, the argv parsing, the state reads and writes including the
   derived reverse direction at `:59-68`, the one-shot failure-injection markers
   and the hook-child spawn. Benchmark it in the same round-robin as (i) and
   (ii), giving a mean `cᵢ` per shape, and report

   > `R = Σᵢ Nᵢ × (nᵢ − cᵢ)`

   which is the **estimated recoverable share**, because both terms now do the
   same work. Three rules keep it honest. A shape the prototype cannot reproduce
   is charged `cᵢ = nᵢ` — zero saving — and named as unreproduced; that is the
   expected outcome for the hook-spawning shapes, where a second whole Node
   process is the behaviour and not the overhead. A prototype whose output any
   of the 53 tests would read differently is not an equivalent candidate and its
   `cᵢ` may not be quoted. And **`R ≤ U_proc` holds only for a prototype in the
   stub's own class**: a `sh` script under the same shell binary cannot do the
   fixture's work in less than a do-nothing `sh` script's start-up, so there a
   `cᵢ` at or below `f` is a measurement error or an inequivalent prototype, not
   a finding. For a prototype outside that class — a compiled executable, a
   different shell — `cᵢ < f` is a legitimate result and must not be discarded;
   the bound that still holds is `R ≤ Σᵢ Nᵢ × nᵢ`, and a `cᵢ` at or below zero is
   the only measurement error left to check for. Record the prototype's class
   beside its figures so the gate below uses the matching ceiling.
   The prototype is evidence for the gate, not a design decision:
   P3's own Issue still owns the mechanism, and nothing here pre-approves this
   one.

   **`Σt0` is not subtracted from anything.** It is a child-side clock — time
   from the Node process's own start to the fixture's first line — while `f` is
   parent-side and includes bookkeeping `Σt0` explicitly excludes. `Σt0 − N × f`
   would subtract non-comparable quantities and is not a valid estimate; an
   earlier draft of this item used it, and it must not be quoted. `Σt0` is kept
   as an independent child-side **lower bound on the interpreter start-up** a
   cheaper stand-in would remove, and is reported beside `U_proc`, not
   combined with it. For a replacement that is not a process at all — or is a
   process outside the stub's `sh` class — the ceiling is `Σᵢ Nᵢ × nᵢ` measured
   parent-side, of which `Σt1` is the child-side lower bound.

*What this does and does not establish.* `Σt0` and `Σt1` exclude `fork`/`exec`,
dynamic linking before Node's own clock starts, and the parent's spawn
bookkeeping, so both are **lower** bounds. They are measured under the suite's
real contention, which is what makes them usable. `nᵢ`, `f` and `cᵢ` are measured
outside Jest on a quiet host, so every quantity built from them carries the
opposite caveat: they are clean differences taken under conditions the suite does
not run in. `U_proc` is additionally an **upper** bound and not an estimate at
all — and an upper bound for `sh` stand-ins specifically, `Σᵢ Nᵢ × nᵢ` being the
one that holds for any class; only `R`, from an equivalent candidate, estimates a recoverable share, and
even `R` is a prediction about that prototype rather than about whatever P3 would
eventually commit. Record each figure, say which kind it is, and record the
host conditions for each.

*The gate, in two steps, and only the second authorizes anything.*

1. **Ceiling test — it can reject, and that is all it can do.** Take the ceiling
   that matches the replacement class under consideration: `U_proc` for a `sh`
   script under the stub's own shell, and the class-free `Σᵢ Nᵢ × nᵢ` for
   anything else (a compiled helper, a different shell, an in-process
   replacement). If that ceiling is not larger than the affected suite's own
   median-to-max spread under §5.4's rule, P3 closes as report-only for that
   class: no replacement in it can recover more than its ceiling, so there is
   nothing above the noise floor to build. Stop here — step 2 is not bought and
   F3 is not spent. `U_proc` falling below the spread rejects `sh` stand-ins
   only; it does not reject a class the class-free ceiling still clears, and a
   report that stops on `U_proc` must say which class it stopped.
2. **Equivalence test — the only way P3 proceeds.** If the ceiling survives,
   measure `R` per step 3 (iii). **P3 proceeds only if `R` exceeds that same
   spread.** `U_proc` clearing the spread authorizes step 2 and nothing else: it
   is consistent with `R` lying anywhere from `U_proc` down to zero, because
   everything between the two is work a correct replacement still has to do. If
   `R` does not clear the spread, P3 closes as report-only with the prototype's
   per-shape figures recorded — the honest finding being that the fixture's cost
   is its work rather than its interpreter.

Neither step authorizes F3, P3's ≈95-minute mutation before-run; that is bought
only after step 2 clears and an operator opens P3's Issue.

**There is no early rejection from `Σt0`, and an earlier draft's shortcut that
said otherwise is withdrawn.** `Σt0` is a *lower* bound: this item says so
twice, because it excludes `fork`/`exec`, dynamic linking before Node's own
clock starts, and the parent's spawn bookkeeping. A lower bound falling below
the spread is therefore consistent with the parent-observed ceilings rising
above it, and treating it as a stop condition would discard a worthwhile
optimization before the measurement that decides it. **Only an upper bound below
the spread may stop the work early**, and the gate's step 1 is exactly that
test. This item defines two upper bounds, both parent-side and both out of the
same micro-benchmark: `Σᵢ Nᵢ × nᵢ`, which bounds any replacement including an
in-process one, and the tighter `U_proc = Σᵢ Nᵢ × (nᵢ − f)`, which bounds a
replacement **in the stub's own `sh` class** and only that class, because `f` is
this host's `/bin/sh` start-up rather than a proven floor for every process. Use
whichever matches the replacement class under consideration, since
`U_proc ≤ Σᵢ Nᵢ × nᵢ` and rejecting on the wrong one rejects the wrong proposal. If the operator wants the cheapest possible early exit,
measure the `nᵢ` first and compare `Σᵢ Nᵢ × nᵢ` against the spread before timing
the stub at all; `Σt0` cannot serve that purpose in either direction.

Cost: six single-suite Jest runs — three instrumented, three uninstrumented,
alternated — plus one standalone
micro-benchmark over the observed shapes plus the stub (≈50 spawns each,
interleaved round-robin, with a state reset between repetitions for the
mutating and hook-spawning shapes), all of a few minutes each — call it ≈25
minutes of
machine time at the handful of shapes `FAKE_GH_SOURCE` dispatches, rising with
the shape count if the measuring run finds more. The re-seeding is a file copy
between timed windows, so it costs wall time in the benchmark but nothing in
the reported figures. **Step 2 of the gate costs
more, and it is bought separately**: writing the scratch prototype is design and
authoring effort rather than machine time, and its benchmark is another few
minutes in the same round-robin. That is deliberate sequencing — the cheap
rejection runs first, and the prototype is only written for a proposal the
ceiling has failed to kill.
**No mutation run at either step.** Both the instrumented fixture and the
prototype are scratch work for the measurement, are
never committed, and are not part of any proposal.

**B. A before-baseline over `normalizeCommand`/`grantMatches`** (blocks nothing;
recorded as a gap). It was written here as P5's gate. **It is not**: §3 P5 rejects
that proposal on a boundary argument that no mutation evidence could overturn, so
nothing downstream waits on this and no operator should buy it to unblock a
consolidation. It stays listed because the region is genuinely unmeasured and a
later, separately justified piece of work might want it.
Requires editing `BASELINE_MUTATE` in `stryker.pilot.config.mjs` and the range
pins in `test/mutation-pilot-harness.test.js` — harness changes, so they belong
to the slice that does them, not to this one. Then `mutation:dry-run:start` /
`:report` for the instrumented count, the §4.2 cost gate applied to that count at
the published **≤ 51** bound, and only then `mutation:pilot:start` / `:report`.
**The precedent is a refusal**: `chain-linear.ts:796-859` plus
`tool-request-grant.ts:237-288` instrumented 137 mutants and did not fit. If a
`normalizeCommand` range does not clear the gate either, it parks — the gate is
not moved and concurrency is not raised to make the arithmetic work.

**C. Confirming P2's predicted kill** (no longer optional, and no longer a
separate purchase; confirms, does not authorize).

**It is the F1 → F2 comparison of §8 F**, and it costs nothing beyond the two
runs the pilot already owes: F1 is taken before P2 lands and F2 at the final
head, so survivor 10's status at both ends is already in the two published
identity tables. An earlier draft made this item an optional extra run; it is
neither optional — §7 #1116 requires the fresh scoped run whatever P3 does — nor
extra, because F2 is that run.

**The supported invocation is the full 38-mutant pilot run**, `npm run
mutation:pilot:start` / `:report`, with the four suites and the §5.2 identity
unchanged: ≈95 minutes on a quiet host, the same price and the same procedure at
every one of §8 F's runs. Read survivor 10's row out of each by identity
(`src/core/tool-request-grant.ts:242:7`, EqualityOperator, `now >= expiresAt` →
`now > expiresAt`) and check that it is `Survived` in F1 and `Killed` by
`tool-request-grant.test.js` in F2.

An earlier draft priced this as a 12-mutant run over
`tool-request-grant.ts:237-244` alone (≈42 minutes of all-timeout ceiling).
**The harness cannot launch that run.** `scopeFor` in
`scripts/mutation-pilot.mjs:410-424` hard-codes each mode's scope — `--pilot`
and `--dry-run` always take both `BASELINE_MUTATE` entries, `--smoke` takes
`SMOKE_MUTATE` (`tool-request-grant.ts:73-84`) against one suite — and
`parseArgs` (`:306-385`) accepts no `--mutate`, no `--test-files` and no run
spec: `MUTATION_PILOT_SPEC` is written by the driver, not by the operator.
Narrowing to one frozen entry would mean editing `stryker.pilot.config.mjs` and
the exact-range pins in `test/mutation-pilot-harness.test.js` — harness changes,
which §7 puts explicitly out of scope for #1114 and which belong to whichever
slice owns them, with their own justification. **A 12-mutant figure must not be
quoted as an available option.**

If a narrowed run is ever built, two conditions carry over: narrowing to one of
the two frozen entries is a reduction inside the permitted bound and must be
**stated in the run's own record**; and such a run is comparable for those 12
mutants by identity and for nothing else — its aggregate is not comparable with
the baseline's aggregate and must not be printed beside it.

**Separate price: zero.** This item buys no run of its own under any branch. If
F1 and F2 are taken, it is read out of them. If the operator declines F1, no
confirmation is possible at all and F2 records the refusal (§7 #1114, §7 #1116) —
buying a one-off post-P2 run instead would confirm nothing, because a single run
with P2 already in it has no before half to move away from.

**D. Settling the group-A survivor reasoning — not an acquisition step at all.**
Retained as an item only to record that it was priced and turned out to need
nothing. An earlier draft treated §4 as an open discrepancy answerable only from
the raw `mutation.json` for run `999e715b-9e2c-4b54-a2ea-3208fd238865`, whose
mutant `location` start **and end** would say whether `334:10` spans the whole
`||` or only its left operand — a file that is not on this branch and will not be
on a downstream one (§1.2), which put the price at **zero if §8 F is run and a
95-minute run otherwise**. §4 now settles the question from the source and the
pinned Node v22.6.0 semantics instead: every one of the six mutants is
non-negative on the asserted input, so none of them reorders it and the span
ambiguity is moot. **Price: zero. Nothing to acquire, nothing to approve, and
nothing downstream waiting on it.** The residual finding — that §6.1's *reason*
for group A does not hold at `:745` — is recorded in §4 and needs no run.

**E. Current cost for every suite in this plan.** Acquired as a side effect of
§5.1's before-measurements — per-suite medians fall out of the same runs — so it
is not worth a separate run. It is not free, though: §5.1 prices a half at
≈17 minutes and a before/after pair at ≈34 minutes of machine time, and that is
the figure an operator is approving when they approve a move proposal.

**F. Fresh runs at the frozen identity** (F1 and F2 are the pilot's own
before/after pair and block #1116's final comparison; F3 additionally blocks
P3's). Required for two independent reasons — the #1112 raw
report is unavailable as data (§1.2) and P2 invalidates that run as a before half
(§5.2) — and satisfying either satisfies both. Every run is taken at the §5.2
identity, with §5.3's comparability and cache
conditions recorded. Cost, each: the pilot's own measured figure, **90 min 52 s
inside the 180-minute budget** (#1112 §5), plus a ≈3-minute dry run — call it ≈95
minutes of machine time on a quiet host, one run at a time, through the
`:start`/`:report` pairs.

| Run | Revision | Slice | Conditional on | Cost |
|---|---|---|---|---|
| **F1** | #1114's base, **before P2 is written** | #1114 | P2 being approved; nothing else | ≈95 min |
| **F2** | the pilot's final head | #1116 | nothing — #1116's Work requires a fresh scoped run whatever the slices land | ≈95 min |
| **F3** | the head P3 is about to change, immediately before P3 is written — containing P2 if P2 landed, and taken the same way if #1114 rejected or parked it | P3's own Issue | §8 A's two-step gate clearing; **not** on P2 | ≈95 min |

**The mandatory total is ≈190 minutes**, rising to ≈285 only if P3 ever
proceeds. Making F1 or F2 conditional on P3 was an earlier draft's error: P3 is
deferred and may never happen, while P2 changes a scoped suite in #1114, so
treating the mutation comparison as P3's alone would have left the pilot closing
with a changed detection surface and nothing to compare it against. F1 is also
the one run with a deadline — there is no later revision at which a before half
without P2 exists.

**The output obligation is the point, it applies to every one of the three, and
it is not optional.** Before a run's
`.mutation/` is discarded, the slice publishes into the tracked report a bounded
sanitized table of **all 38 mutants**: source location (start and end), mutator,
original → replacement, status, and `killedBy` where there is one. That is what
makes a run a half that a later slice in a different worktree can
actually compare against, and it is what #1112's report could not have known to
include. F2's table is the one the pilot leaves behind for whatever comes after
it, so it is owed even in the branch where F2 has nothing to be compared with. Raw logs and HTML stay out of Git (#1113's own boundary); the identity
table is bounded, sanitized evidence and belongs in it.

**Permanently out of reach within this pilot**, and recorded so that no later
slice mistakes them for gaps it can close cheaply: `verifyLinearChainReadBack`'s
missing/extra-edge judgement (refused on cost); per-test coverage attribution
(`perTest` would change the run identity and its behaviour through this
repository's native-ESM Jest and `runAdmin` is unvalidated); anything in a child
process, a real `git`, a real SQLite writer or a lock held from another process;
and every suite outside the measured top 20.

## 9. Limitations

- **This is a plan, not a result.** No proposal here has been approved by an
  operator or implemented. §6 records only the challenges the independent review
  actually raised and how they were resolved; a cell left *pending* there means no
  objection was recorded against that proposal, which is not the same as approval.
- **No measurement was taken in this slice**, and the 91-minute mutation
  baseline was deliberately not re-run. Every figure quoted is inherited, with
  its own qualifications carried along.
- **Every cost figure is historical.** No suite named here has a known current
  cost. Benefit is "hypothesized" wherever it is not measured, and it is not
  measured anywhere in this plan.
- **Mutation evidence covers 39 of 1147 lines — 3.4%** — of two modules, in a
  deliberately contract-central and therefore upward-biased selection. It
  applies to exactly one candidate suite under change (P3). Everywhere else,
  "unmeasured" means unmeasured, not good.
- **The one mutation run this pilot has taken is not available as a before
  half.** Its per-mutant identities and `killedBy` attribution live only in an
  untracked `.mutation/` that is absent from this branch (§1.2), and P2
  invalidates the run for that purpose anyway (§5.2). Any mutation comparison
  downstream therefore starts by buying its own before-run (§8 F) — which is
  most of why P3 is deferred, and why the pilot owes ≈190 minutes of mutation
  time (F1 and F2) before P3 is considered at all.
- **Per-suite coverage preservation is unverifiable here.** Every mutation
  comparison in this plan checks kill preservation only. The coverage half of
  `test-maintenance-candidates.md` §7 item 4 — a mutant a suite only covered
  stays covered or killed by it — needs `coveredBy`, which
  `coverageAnalysis: off` never collects, so it is reported as unverified for
  every changed scoped suite unless a separately approved study acquires it
  (§3 P3 records 4–5, §5.4 item 3).
- **The §8 A gate's cheap figure is a ceiling, not a benefit.** `U_proc` is
  measured against an `exit 0` stub that parses nothing, writes nothing and
  spawns nothing, so the gap it reports includes work any correct replacement
  must still do. It is also a ceiling **for that stub's own `/bin/sh` class**,
  not for every process: a candidate of another kind is judged against the
  class-free `Σᵢ Nᵢ × nᵢ`. It can reject P3 and cannot authorize it; only the
  equivalent-candidate figure `R` estimates a recoverable share, and even that is
  a prototype's number rather than a committed mechanism's. No figure in this
  plan is a measured speedup for P3.
- **The cache protocol in §5.3 is specified, not validated.** It is derived from
  this repository's configuration (`"transform": {}`, no `incremental` in
  `tsconfig.json`, no `cacheDirectory` set), not from a measurement of how much
  cache state actually moves these suites. Whether the discarded warm-up run
  equalizes the page cache well enough is itself unmeasured.
- **Detection is not redundancy.** Nothing here reads a survivor as a useless
  test, equal scores as permission to delete, or a killed mutant as proof that
  every possible defect remains detectable.
- **§4 is a code read, not a measurement.** It corrects the *reason*
  `mutation-pilot-baseline.md` §6.1 gives for group A's survival, not any number
  or status in that report, and it does so by reading the source and the pinned
  runtime's `Array.prototype.sort` behaviour — this slice took no measurement. Part
  of the argument rests on V8's handling of an inconsistent comparator, which the
  specification leaves implementation-defined; it holds for Node v22.6.0 and is not
  a portable guarantee. An earlier draft read the same mutants as a possible
  harness-attribution gap and priced a run to settle it; the independent review
  rejected that inference, §4 records the correction, and nothing in this plan
  depends on it either way.
- Overlap claims inherited from `test-maintenance-candidates.md` §8 were checked
  from file headers and test lists, not assertion by assertion. Every
  consolidation candidate still needs that comparison before it moves, which is
  part of why no consolidation is proposed at all. P5, the only one the
  inherited material offered, was checked assertion by assertion and rejected
  on that basis (§3 P5).
- CI and any full project verification outside this chain remain an independent
  final safeguard. Nothing in this plan narrows what they run, and no proposal
  here touches verification policy, the loop, or any workflow contract.
