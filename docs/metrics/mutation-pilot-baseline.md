# Scoped mutation baseline (Test Maintenance Pilot, slice 4)

Issue #1112. This report is the **pre-change fault-detection evidence** for the
pilot scope: what the four accepted test files detect, today, in a bounded region
of the two accepted sources. It is measurement only. No test, no production
source and no verification policy is changed by this slice, and nothing here
authorizes a deletion, a consolidation or a threshold.

Read `docs/metrics/mutation-pilot-harness.md` first. It defines the harness, the
invocation rules and the vocabulary (`Killed`, `Timeout`, `Survived`,
`NoCoverage`, `CompileError`, `RuntimeError`) this report uses.

## 0. Status

> **Measured.** The pilot run completed inside its budget and wrote its own
> summary; §5 and §6 are transcribed from that run's `summary.json` /
> `summary.md`, and §10 therefore carries a **feasible** hand-off. The evidence
> is bounded in exactly the way §2 records: 38 mutants over 39 of 1147 lines.
>
> | Step | Outcome |
> |---|---|
> | Dry run of the first frozen range (`chain-linear.ts:796-859`, `tool-request-grant.ts:237-288`) | **Completed and passed** — sandbox built, all 180 tests in the four scoped suites passed under instrumentation, **137 mutants** instrumented. |
> | Cost gate applied to that 137 | **Refused.** 137 mutants do not fit the 180-minute budget at concurrency 2 (§4). |
> | Range re-frozen, narrower (§2) | Done and wired; the tests that pin it pass. |
> | Dry run of the standing range (`chain-linear.ts:329-359`, `tool-request-grant.ts:237-244`) | **Completed and passed** — sandbox built, the same 180 tests passed under instrumentation, **38 mutants** instrumented (§4.1). |
> | Cost gate applied to that 38 | **Passed.** 38 fits the budget even on the all-timeout reading, with headroom (§4.3). |
> | Pilot run | **Completed and read back.** Run `999e715b-9e2c-4b54-a2ea-3208fd238865` ran 90 min 52 s against the §3 identity and exited 0 with `state: complete (passed)`; `npm run mutation:pilot:report` transcribed its summary (§4.4). |
> | Result | 38 mutants: **25 Killed, 2 Timeout, 10 Survived, 0 NoCoverage, 0 CompileError, 1 RuntimeError** (§5). |
>
> Three things this status does **not** say. The 72.97% StrykerJS prints is
> `(25 + 2) / 37` — it counts the two timeouts as detections and drops the
> crashed mutant from its denominator; the figure this pilot actually cares
> about, **assertion-observed detection, is 25 of 37 (67.6%)** (§5.1). The
> selection is contract-central rather than representative, so neither number
> generalizes to either module or either suite (§2). And nothing measured here
> authorizes a deletion, a consolidation or a threshold — §6's survivors are
> recorded as pre-existing gaps for #1113 to reconcile, not as work this slice
> does.

## 1. Reconciliation with the predecessor (#1111)

| Field | Value |
|---|---|
| Authoritative predecessor | PR #1177, branch `ai/issue-1111`, reviewed head `898dc7d6c59978a90a22b2865e0a2b15636f77bc` |
| What #1111 delivered | The opt-in harness, a **passed smoke check** and a **passed full-scope dry run**. Not a baseline. |
| What #1111 did **not** deliver | Any mutation score for the pilot scope. No mutant in it had ever been activated (`mutation-pilot-harness.md` §9). |
| Accepted scope, still unchanged | Sources `src/core/chain-linear.ts`, `src/core/tool-request-grant.ts`; tests `test/chain-linear.test.js`, `test/admin-chain-edit.test.js`, `test/tool-request-grant.test.js`, `test/admin-tool-request-grant.test.js` |
| This slice's only scope change | A stated line range **inside each of the two sources** (§2). The four test files are byte-identical and unchanged. |

Two numbers from #1111 are carried here, and both are carried with their
qualifications rather than as results of this slice:

- **The smoke check's 93.33%** is 15 mutants over 12 lines of one file, run by
  one suite. It is evidence that the harness detects mutants at all. It is not a
  baseline, not a per-suite score, and its aggregate is not "assertion kills" —
  one of its 15 was a `Timeout` and one `Survived`.
- **742 mutants and a 181.3 s pass** is the measured instrumentation and
  test-pass cost of the *whole-file* scope, from a dry run. The ≈ 37 h serial /
  ≈ 18.7 h at concurrency 2 that follows is an **explicit reference-cost
  projection, not an observed run**: early kills shorten it, timeouts lengthen
  it. It is used here only as the reason the scope had to be narrowed.

The smoke evidence is reused rather than re-collected: its inputs — the harness,
the sandbox build path, the two sources and the suite that judges them — are
unchanged at this head, and re-running it would answer a question already
answered. **A dry run is never reused across a scope change**, because the scope
is its input: #1111's measured the whole files, this slice's first (§4.1)
measured the first freeze and produced the 137 that was refused, and the standing
range §2 was dry-run on its own before the gate was applied to it. Each
supersedes the last as a statement about cost; none of them supersedes the others
as a statement about the build and the suites, which is why both of this slice's
dry runs are recorded in §4.1 with their 180 passing tests cited on their own.

## 2. The frozen mutation scope

`BASELINE_MUTATE` in `stryker.pilot.config.mjs`, which `scopeFor()` gives both
the `dry-run` and the `pilot` mode:

| Entry | Region | Why this region |
|---|---|---|
| `src/core/chain-linear.ts:329-359` | `edgeKey`, `compareEdges`, `linkEdges`, `resolveRoots` | Edge identity, edge ordering, the line a chain is built from, and the root a linear `prepend` attaches to. `planLinearChainEdit` and `verifyLinearChainReadBack` are both assembled out of these four, so every case in the pure `chain-linear.test.js` *and* in `admin-chain-edit.test.js` — the costliest suite, and the *optimize* candidate — reaches them through the public API. |
| `src/core/tool-request-grant.ts:237-244` | `grantStatus` | The grant lifetime decision: exhaustion checked before expiry, both against `>=`. It is the security-relevant contract behind the *consolidate* candidate (§3.9); `tool-request-grant.test.js` asserts it directly and `admin-tool-request-grant.test.js` reaches it through `tool-request-run.ts`'s exhausted-grant path — which is what makes a per-suite comparison possible later. |

**What the run said about that rationale, including where it was wrong.** The
selection was made before any mutant was activated, and the completed run
corrects two of its assumptions rather than confirming them. First, `compareEdges`
is *not* on the planning hot path: its only call sites are `chain-linear.ts:711`,
`:725`, `:745`, `:832` and `:845`, every one of them inside the read-back and
refusal paths, and all six of its mutants survived (§6.1). Second, the pure
`chain-linear.test.js` killed **nothing** in this region — all 14 detections in
this file came from `admin-chain-edit.test.js` (§5.2). The row above claimed both
suites reach these functions through the public API; for detection purposes only
one of them demonstrably does. The rationale is left standing as written, with
this correction beside it, because a selection argument edited to match its own
result is no longer evidence that the selection was made honestly.

**Why a narrowing at all, and why only this one.** The whole-file scope does not
fit a bounded run (§1). `test-maintenance-candidates.md` §5 permits exactly one
reduction — "a narrower mutate range inside the same two files … and it must be
stated" — and `assertScope()` enforces that bound where it cannot be bypassed.
So: both sources keep a range, no test file is swapped or dropped, no mutator is
excluded, concurrency is not raised to make the arithmetic work, and the scope is
not widened to improve a number.

**The first freeze was wider, was measured, and was refused.** This slice began
with `src/core/chain-linear.ts:796-859` (`verifyLinearChainReadBack`, the example
`test-maintenance-candidates.md` §5 itself names) and
`src/core/tool-request-grant.ts:237-288` (`grantStatus` **and** `grantMatches`,
the whole exact-command authorization decision). That range was dry-run, and it
instrumented **137 mutants**; the gate in §4 refused it. The refusal is recorded
rather than quietly replaced, because it is the only honest reading of what this
pilot can afford: the two contracts that narrowing gave up —
`verifyLinearChainReadBack`'s missing-edge/extra-edge judgement and
`grantMatches`'s scope-before-lifetime ordering — are **unmeasured, and a later
slice that touches the tests covering them has no before-evidence here.**

**Boundaries are function boundaries.** Both standing ranges start at a
declaration and end at its closing brace, and `test/mutation-pilot-harness.test.js`
fails if either stops holding whole functions. Cutting a range mid-function would
be the cheapest way to raise the score in this report: a function's refusal
messages and operator guidance are string literals that tests rarely assert, so
dropping them drops the mutants least likely to be killed. Nothing here is
excluded for being expected to survive.

**What the narrowing costs, stated plainly.** The standing baseline covers 39 of
the 1147 source lines these two modules hold (31 + 8) — **3.4%**. Detection
outside those lines is **unmeasured, not good**: a later slice that changes a
test touching `planLinearChainEdit`, `verifyLinearChainReadBack`, `grantMatches`,
`normalizeCommand` or any other region has no before-evidence here and cannot
claim preservation from this report. Extending the range for such a change means
a new baseline at the cost §4 prices, not an inference from this one.

**The selection is not a random sample, and its score will be biased upward.**
These are small, pure, deterministic functions on the hot path of every case in
all four suites, so a high kill rate is expected and would say little about the
suites as wholes. The figure that matters downstream is not the aggregate; it is
*which suite* killed *which mutant* (§5), because that is the only thing a
consolidation can lose.

**Stability of the range.** A line range is a position, not an identity: an edit
above either function shifts its contents without changing the text of
`BASELINE_MUTATE`. Three things keep the comparison honest — §3 records the
revision the ranges were resolved at; `test/mutation-pilot-harness.test.js`
fails if either range stops covering the functions named above; and mutants are
matched across runs by **source location, mutator, original and replacement**,
never by report index.

## 3. Frozen run identity

Everything a verdict depends on. Both halves of any before/after comparison must
use this identity unchanged; a difference in any row makes the two runs
incomparable rather than merely noisy.

| Input | Value | Source |
|---|---|---|
| Revision | `898dc7d6c59978a90a22b2865e0a2b15636f77bc` plus this slice's own changes; the run's own commit is recorded in `summary.json` | run record |
| Mutate | `src/core/chain-linear.ts:329-359`, `src/core/tool-request-grant.ts:237-244` | `BASELINE_MUTATE` |
| Test files | the four accepted suites, unchanged | `PILOT_TESTS` |
| Mutators | StrykerJS defaults, all of them. None excluded. | no `mutator.excludedMutations` |
| Coverage analysis | `off` | default |
| `timeoutMS` / `timeoutFactor` | 60000 / 2 — the deadline is `timeoutFactor × the covering tests' dry-run time + timeoutMS + overhead`, not `timeoutMS` alone | driver defaults |
| Concurrency | 2 | default; not raised for cost |
| Wall-clock budget | 180 min | `--max-runtime-min` default |
| Incremental | **off** | never used for either half of a comparison |
| `typescript-checker` | not used — it would discard mutants that fail to type-check and change the mutant population between runs | `mutation-pilot-harness.md` §8 |
| Node / Stryker / jest-runner / Jest / TypeScript | recorded per run in `summary.json` `environment` | run record |
| Host load | recorded per run (`loadavg` before and after). The standing range's dry run started at 2.31 / 2.72 / 2.74 on 8-way parallelism and ended at 2.30 / 2.54 / 2.65, with 647 MB free afterwards — quiet, and quieter than the first freeze's run (2.41 / 2.45 / 2.55 → 4.05 / 3.08 / 2.78). A run started on a heavily loaded host manufactures timeouts that are **not** assertion evidence, so this row is a precondition of the pilot run and not just a note about it: the pilot is to be started on a comparably quiet host, and its own recorded load is part of whether §5 may be read as detection evidence at all. | run record |

Exclusions inherited from #1110/#1111, unchanged and re-stated because they bound
what this baseline can mean:

- `test/admin-tool-request-run.test.js` (spawned, so unobservable) and
  `test/tool-request-run-operation.test.js` (would mask a loss in a candidate
  suite) reach these sources and are **not** in the evidence.
- The child-process cases in `admin-chain-edit.test.js` (`:604`, `:731`,
  `:1215`, `:1298`, `:1457`, `:1511`, `:1559`) run their concurrent writer or
  sabotage hook in another Node process. The mutation harness observes only what
  runs inside the Jest worker, so preservation for those cases is argued from
  their assertions and never from a score.
- The fake `gh` and the real `git` / `/bin/sh` processes are fixtures, not
  mutated code.

## 4. The cost gate

Applied to the dry run's own instrumented count for the frozen range, before any
pilot run is started. Every input below is measured, not assumed.

### 4.1 The dry runs

Each started with `npm run mutation:dry-run:start` and read back with
`npm run mutation:dry-run:report`, as §7 requires. Both **completed and passed**.
The second is the one this gate is computed from; the first is kept because it is
the measurement that refused the wider range, and discarding it would leave §2's
narrowing unevidenced.

| Fact | First freeze (refused) | **Standing range (§2)** |
|---|---|---|
| Run id | `cca4e836-35b0-4f27-8a4b-51d3b479d7d5` | `8069c4e2-231a-4c40-9a08-63066d20386a` |
| Commit / worktree | `729b6de189b855c93da7f805aa092d994a7fe5d1`, clean | `56ac381ea4265dd9a9430a7f354454fceed9c9f0`, clean |
| Range dry-run | `chain-linear.ts:796-859`, `tool-request-grant.ts:237-288` | `chain-linear.ts:329-359`, `tool-request-grant.ts:237-244` |
| Node / Stryker / jest-runner / Jest | v22.6.0 / 8.7.1 / 8.7.1 / 29.7.0 | v22.6.0 / 8.7.1 / 8.7.1 / 29.7.0 |
| Concurrency, coverage analysis, `timeoutMS`, incremental | 1 of 8 available, `off`, 60 000 ms, no | 1 of 8 available, `off`, 60 000 ms, no |
| Sandbox build | `tsc` exit 0, **0** diagnostic lines; both sources emitted **and** instrumented | `tsc` exit 0, **0** diagnostic lines; both sources emitted **and** instrumented |
| Initial test run | **180 tests passed**, net 176 681 ms + 2 679 ms overhead | **180 tests passed**, net 175 489 ms + 1 323 ms overhead |
| Mutants instrumented | **137**, across 2 of 717 files considered | **38**, across 2 of 717 files considered |
| Wall time / state | 186.6 s, `complete (passed)` | 182.4 s, `complete (passed)` |

Two things that are evidence, and one that is not. The four suites — including
the three `runAdmin` ones — pass unchanged inside the instrumented sandbox at
this revision, so §3's identity is executable and not just declared; the standing
range's run re-proves that at its own head rather than inheriting it. And the
mutant count for each range is a measurement of that range. What neither is is
any statement about detection: **a dry run activates no mutant**, so the 38 below
is a population, not a score.

The two runs agree closely on the thing the gate actually depends on — the cost
of one pass over the scoped suites (179.4 s, then 176.8 s). That is expected and
is the point: the suites are the same four files in both, and under
`coverageAnalysis: off` the pass cost is a property of the suites, not of how many
mutants the scope holds. It is the **mutant count** that the narrowing changed,
from 137 to 38.

The pilot run records a commit later than `56ac381e` — `dc758e12`, because this
report's own prose is edited between the dry run and the launch (§4.4). That
difference is confined
to `docs/metrics/mutation-pilot-baseline.md`, which is neither a mutated source
nor a scoped test, so it cannot move the instrumented population or the suites'
behaviour. Any change that did touch `BASELINE_MUTATE`, either source or any of
the four suites would invalidate this dry run for the gate, and the gate would
need a new one.

### 4.2 The bound

Under `coverageAnalysis: off` every mutant runs the whole scoped selection, and
that selection's cost does not depend on how many mutants the scope holds. From
the standing range's dry run (§4.1), per mutant:

| Case | Cost | Why |
|---|---|---|
| Killed early | < one pass | Stryker stops the run at the first failing test |
| Survives | **176.8 s** | one full pass (175 489 ms net + 1 323 ms overhead) |
| Times out | **412.3 s** | the deadline is `timeoutFactor × net + timeoutMS + overhead` = 2 × 175.489 + 60 + 1.323 s |

A 180-minute budget at concurrency 2 is 21 600 worker-seconds. So:

- if every mutant survived: **≤ 122 mutants**;
- if every mutant hit its timeout deadline: **≤ 52 mutants**.

**The gate is the second bound.** The first is the tempting one and it is the
wrong one, because a timeout is the case that both costs the most and is most
likely on a shared host — the state a cost gate exists to survive. Choosing it is
not padding: a run that hits its wall-clock budget is killed before Stryker writes
its report, which yields **no** partial results, so an over-optimistic gate does
not buy a smaller baseline, it buys none.

This bound was published as **≤ 51** when it was computed from the first freeze's
slightly slower pass, and the recomputation above moves it to ≤ 52. The gate is
held at the stricter **≤ 51**: a threshold that loosens by one because the host
happened to be quieter is a threshold being fitted to the measurement, which is
the failure mode this section exists to prevent. Nothing turns on the choice
here — §4.3's count clears both — and it is recorded rather than silently
rounded so that a later slice can see the gate was never relaxed to admit a scope.

One asymmetry to keep in view rather than hide. §4.1's passes were timed with
**one** worker; the pilot runs two, and two Jest workers spawning `runAdmin`
children contend, so the pass a pilot measures may be slower than 176.8 s.
Stryker takes its own dry run's time as the `net` in the deadline above, so both
the survivor cost and the timeout ceiling scale together with that contention —
which is the other reason the gate is set against the ceiling, and the reason §3
treats host load as a precondition rather than a footnote.

### 4.3 The decision

| Range | Mutants | Against ≤ 51 | Outcome |
|---|---|---|---|
| `chain-linear.ts:796-859` + `tool-request-grant.ts:237-288` | **137** (measured, §4.1) | 2.7× over. Even on the everything-survives reading it is 3 h 25 min against a 3 h budget. | **Refused.** Narrowed; see §2. |
| `chain-linear.ts:329-359` + `tool-request-grant.ts:237-244` (standing) | **38** (measured, §4.1) | 0.75× of the bound, on the worst case the bound is built from. | **Passed.** The pilot run is authorized at the identity in §3. |

What 38 costs at concurrency 2, both readings stated because only the second is
the gate:

| Reading | Worker-seconds | Wall time | Of the 180-min budget |
|---|---|---|---|
| Every mutant survives | 38 × 176.8 = 6 719 | **56 min** | 31% |
| Every mutant times out | 38 × 412.3 = 15 667 | **131 min** | 73% |

The real run will land below the second and above neither reliably — a killed
mutant stops at its first failing test, which is cheaper than both — so 131 min
is a ceiling, not a prediction. The headroom it leaves is the margin for the
worker contention §4.2 flagged, and it is the reason this passes as a *bounded*
run rather than one that merely fits on paper.

Three things this decision is not. It is not a licence to widen the range back
toward the refused freeze now that a number fits; §2's 3.4% coverage and the two
contracts the narrowing gave up stand as recorded. It is not a prediction of the
outcome — 38 is a population, and how many of them any suite detects is exactly
what §5 is still empty for. And it does not transfer: if the pilot run expires,
is interrupted or writes no summary, the answer is a narrower scope measured
again from its own dry run, not a second attempt at the same scope with the
budget or the concurrency moved to admit it.

### 4.4 The launch and the completed run

The authorization in §4.3 was exercised. `npm run mutation:pilot:start` ran its
preflight — every check `ok`, including `scope-files-exist`, `reports-ignored`
and `not-wired-into-verification` — and spawned one detached run:

| Field | Value | Source |
|---|---|---|
| Run id | `999e715b-9e2c-4b54-a2ea-3208fd238865` | `run-state.json` |
| Started | 2026-09-23T15:34:44.957Z, pid 73504 | `run-state.json` |
| Effective arguments | `--pilot --concurrency 2 --timeout-ms 60000 --max-runtime-min 180 --coverage-analysis off --out .mutation` | `run-state.json` |
| Scope actually handed to Stryker | `chain-linear.ts:329-359`, `tool-request-grant.ts:237-244`; the four accepted suites | `run-spec.json` |
| Sandbox build | `tsc` exit 0, **0** diagnostic lines; both sources emitted **and** instrumented | `build.json` |

Those four rows are what make this run comparable with §4.1's dry run rather
than merely adjacent to it: the recorded spec is the frozen scope of §2, and the
recorded arguments are the identity of §3, both read back from the run's own
files instead of from the command that was typed.

That run **finished on its own terms**, and `npm run mutation:pilot:report` was
run twice: once while it was still in flight, which reported only "background
pilot run still going — 2305 s elapsed" and produced nothing this report may
quote, and once after it had written its summary. The completion facts, all read
back from the run's own files rather than from the console:

| Field | Value | Source |
|---|---|---|
| Finished | 2026-09-23T17:05:37Z; `Done in 90 minutes 50 seconds` | `run.log` |
| Driver wall time | **5451.8 s — 90 min 52 s** | `summary.json` `run.wallMs` |
| Exit / signal / budget | exit `0`, no signal, `timedOut: false`; `state: complete`, `reason: passed` | `summary.json` `run` |
| Surviving process group | none — `groupSurvived: false`, `survivingPids: []` | `summary.json` `run` |
| Pilot's own initial test run | **180 tests passed** in 3 min 3 s (net 181 096 ms, overhead 2 128 ms) | `run.log` |
| Host load before → after | 2.68 / 2.44 / 2.35 → 4.92 / 4.31 / 4.04; 1 171 MB free afterwards | `summary.json` `environment`, `run` |
| Commit / worktree | `dc758e126549dc2822b38c782796154a6f67a458`, clean | `summary.json` `environment` |

Four of those rows are preconditions of reading §5 as evidence at all, not
decoration. The run **was not killed by its budget** (`timedOut: false`), so §5
is a whole population and not a truncated one. Its own initial test run passed
all 180 tests under instrumentation at its own head, so the suites' behaviour in
§5 is the suites' and not the sandbox's. It left no orphan process group. And
the host stayed quiet: a 1-minute load average of 4.92 on 8-way parallelism at
the end of a two-worker run is the run's own cost, not contention from
elsewhere, which is what lets §6.2 treat a timeout as a property of a mutant
rather than of the machine.

The pilot's own pass (181 096 ms net) is **slower** than the dry run's 175 489 ms,
by 3.2%. §4.2 predicted exactly that — the dry runs were timed with one worker
and the pilot runs two, and two Jest workers spawning `runAdmin` children
contend. It moves the per-mutant timeout deadline to `2 × 181.096 + 60 + 2.128 =`
**424.3 s**, up from the 412.3 s §4.2 computed. The gate is unaffected: the
all-timeout ceiling rises to 38 × 424.3 / 2 = 134 min, still inside the
180-minute budget, and the run in fact took 90 min 52 s — **69% of that ceiling
and 50% of the budget.**

The commit recorded above, `dc758e12`, is later than the dry run's `56ac381e`
and earlier than this report's own head, exactly as the note in §4.1 said it
would be. `git diff dc758e12..HEAD` touches three files:

- `docs/metrics/mutation-pilot-baseline.md` — this file;
- `docs/metrics/mutation-pilot-harness.md` — prose only, replacing the
  "no mutation score exists for the pilot scope" note in its §8 with a pointer
  to this baseline;
- `test/mutation-pilot-harness.test.js` — the harness's own test, tightened to
  pin `incrementalFile` identity against the frozen `BASELINE_MUTATE` /
  `PILOT_TESTS` scope rather than the configuration's whole-file default.

None of those is an input to the measurement. **No mutated source, no scoped
test, no `BASELINE_MUTATE` entry, no Stryker configuration and no runtime
harness code (`scripts/mutation-pilot.mjs`) differs** between the revision that
was measured and the revision that publishes the measurement, so §5 describes
this head's code and suites. The third file is a test *of* the harness, not one
of the four pilot suites §2 freezes, and it does not execute in a mutation run.

The progress lines in `.mutation/pilot/run.log` were deliberately **not**
transcribed into §5 while the run was in flight, in any partial form, and the
in-flight read-back above was treated as no result. Three reasons, and the third
is the one that matters:

1. They are a console rendering, not the sanitized record §8 permits quoting.
2. They are provisional — Stryker revises a mutant's state as its run resolves.
3. A partial count is a **biased** count, not a small one. Mutants do not
   complete in a representative order: a killed mutant stops at its first
   failing test and finishes early, while a survivor pays a full pass and a
   timeout pays the whole deadline. Reading a run's first third therefore
   understates survivors early and overstates them later, and no denominator
   corrects it.

That this run finished does not retire the rule. Had it expired against its
180-minute budget, been interrupted, or exited without writing a summary, §10
would stay **inconclusive**: the numbers would not be reconstructed from this
log, the gate would not be re-tuned to make a retry cheaper, and no second run
would be started while the checkout-wide lock or a surviving process group said
this one was active.

## 5. Results

Transcribed from run `999e715b-9e2c-4b54-a2ea-3208fd238865`'s own
`summary.json` / `summary.md` (§4.4). Every outcome is kept distinct; an
aggregate in place of them is exactly the reporting this pilot must not publish.

### 5.1 Outcomes, and the three denominators they can be read against

| Outcome | Count | What it means here |
|---|---|---|
| **Killed** — an assertion in a scoped test observed the change | **25** | The only outcome that is evidence about the tests. |
| **Timeout** — detected by StrykerJS, **no assertion observed it** | **2** | A deadline expired (§6.2). Counted by StrykerJS as a detection; counted here as its own thing. |
| **Survived** | **10** | Classified in §6.1. |
| **NoCoverage** | **0** | Not a finding: under `coverageAnalysis: off` StrykerJS cannot report this status at all, so the 0 is structural (see below). |
| **CompileError** | **0** | The sandbox built cleanly; `tsc` exit 0, 0 diagnostic lines. |
| **RuntimeError** | **1** | A harness outcome, not a test outcome (§6.2). |
| **Incomplete / unknown** | **0** | The run was not truncated: `timedOut: false`, exit 0, `state: complete`. All 38 instrumented mutants reached a terminal status. |

The three readings of the same 38, all stated because only the second is the one
this pilot uses:

| Reading | Figure | Denominator | Why it is or is not used |
|---|---|---|---|
| StrykerJS mutation score | **72.97%** | (25 killed + 2 timeout) / **37** — the crashed mutant is dropped from the denominator | This is the number the tool prints, so it is recorded. It counts timeouts as detections, which this pilot does not. |
| **Assertion-observed detection** | **25 / 37 = 67.6%** | evaluated mutants, timeouts excluded from the numerator | **The figure of record.** It answers "what did an assertion catch". |
| Over everything instrumented | 25 / 38 = 65.8% | all mutants, including the one the harness could not evaluate | The most conservative reading; quoted so the crash is never silently absorbed. |

Per source file, same distinctions:

| File | Mutants | Killed | Timeout | Survived | NoCov | CompileError | RuntimeError | StrykerJS score | Assertion-observed |
|---|---|---|---|---|---|---|---|---|---|
| `src/core/chain-linear.ts` (329-359) | 26 | 14 | 2 | 9 | 0 | 0 | 1 | 64.00% (16/25) | **14/25 = 56.0%** |
| `src/core/tool-request-grant.ts` (237-244) | 12 | 11 | 0 | 1 | 0 | 0 | 0 | 91.67% (11/12) | **11/12 = 91.7%** |
| Total | 38 | 25 | 2 | 10 | 0 | 0 | 1 | 72.97% (27/37) | **25/37 = 67.6%** |

**The 0 under `NoCoverage` is not a statement that everything was covered.**
With `coverageAnalysis: off` every mutant is run against the whole scoped
selection and StrykerJS never computes which tests reach which mutant, so
`NoCoverage` is a status it cannot assign. A survivor in §6.1 is therefore
*either* "executed and unasserted" *or* "never executed" — this run cannot tell
those apart, and §6 does not pretend otherwise.

### 5.2 Which suite detected what

Two structural facts from the raw report make this section per-suite evidence
rather than an aggregate wearing a per-suite label:

- Every evaluated mutant records **`testsCompleted: 180`** — the full scoped
  selection ran for each one; there is no bail, so no suite was cut off before
  it could fail. (The 165.79 tests-per-mutant average StrykerJS prints is
  6 300 / 38: 35 mutants × 180, and 0 for the three the harness could not run to
  completion.)
- Every one of the 25 killed mutants has **exactly one** entry in `killedBy`.
  One test, and only one, failed for each. The per-suite detection sets below
  are therefore **disjoint by observation, not by assumption**.

| Test file | Mutants killed | Tests that killed anything | `coveredBy` |
|---|---|---|---|
| `test/admin-chain-edit.test.js` | **14** — every detection in `chain-linear.ts` | 4 | unknown (§5.1) |
| `test/tool-request-grant.test.js` | **9** | 3 | unknown |
| `test/admin-tool-request-grant.test.js` | **2** | 1 | unknown |
| `test/chain-linear.test.js` | **0** | 0 | unknown |

All 25 detections come from **8 of the 180 tests**:

| Killer | Test | Killed |
|---|---|---|
| `admin-chain-edit.test.js:839` | `admin chain append / prepend › append extends past the head and moves it` | 7 |
| `admin-chain-edit.test.js:362` | `admin chain new — repository-scoped Issue identity (issue #1045) › an Issue of the same number in another repository does not block a new chain` | 5 |
| `admin-chain-edit.test.js:526` | `admin chain new › preview writes nothing — no relationship, no label, no chain` | 1 |
| `admin-chain-edit.test.js:866` | `admin chain append / prepend › prepend attaches ahead of the root and leaves the head alone` | 1 |
| `tool-request-grant.test.js:132` | `tool-request-grant — status › active before expiry and use` | 4 |
| `tool-request-grant.test.js:141` | `tool-request-grant — status › exhausted once uses reaches maxUses` | 3 |
| `tool-request-grant.test.js:136` | `tool-request-grant — status › expired once now passes expiresAt` | 2 |
| `admin-tool-request-grant.test.js:220` | `admin CLI — tool-request grant: clean worktree › refuses to execute when the session checkout is dirty` | 2 |

Three readings that matter downstream, and the limits on each:

1. **The two grant suites do not overlap here at all.** Of the 11 killed mutants
   in `tool-request-grant.ts`, 9 were detected only by the pure
   `tool-request-grant.test.js` and 2 only by `admin-tool-request-grant.test.js`
   — and because `killedBy` is a singleton for every one of them, no mutant was
   detected by both. The two admin-suite detections are at `:241` (the
   exhaustion branch) and `:242` (the expiry branch), the same lines the pure
   suite also reaches, but they are *different mutants*. For this region the
   admin suite is **not redundant with** the pure suite: consolidating it away
   would lose two detections outright. That is a fact about 12 mutants over 8
   lines, not a verdict on either file.
2. **`chain-linear.test.js` killed nothing in this region.** Read precisely:
   with all 180 tests run for each of the 23 mutants that completed the
   selection and complete `killedBy` attribution for them, no test in that file
   failed for any of the 26 mutants in `chain-linear.ts:329-359` — the
   remaining three (§6.2) were never evaluated by any suite at all. It is **not** a statement that the suite is
   worthless — the region is four small helpers, and the suite's subject is the
   planner's public refusals — but it does mean this baseline gives a later
   slice **no before-evidence of detection by that file**, and a consolidation
   touching it cannot cite preservation from here.
3. **`coveredBy` is unknown, not empty.** `summary.json` carries
   `coveredByTest: {}` and the console listing prints `(covered 0)` beside every
   test that killed nothing; both are artifacts of `coverageAnalysis: off`, not
   measurements. `perTest` was not enabled to fix that: it would change the run
   identity (§3), and its attribution through this repository's native-ESM Jest
   setup and `runAdmin` is unvalidated — an unattributed test reads as "no
   coverage", indistinguishable from a real gap, and would understate detection.

Per `test-maintenance-candidates.md` §7 item 4, this is the level at which
preservation has to be argued: in a combined run a mutant counts as killed when
*any* included suite kills it, so an unchanged pure suite can hide a loss in a
changed admin suite. The disjointness above is what makes that check possible
for the grant pair — and its absence for `chain-linear.test.js` is what makes it
impossible for the chain pair.

## 6. Survivors and pre-existing gaps

The classes, unchanged from how they were declared before the numbers existed:

| Class | What it means | What it is not |
|---|---|---|
| Potential weak assertion | The tests execute the code but do not assert the changed fact. | Not yet a defect, and not a licence to add a test that only kills the mutant. |
| Mutation limitation / likely equivalent | The mutant plausibly cannot change observable behaviour. | **Equivalence is never asserted without evidence.** Absent a concrete argument it stays "unresolved". |
| Harness or build issue | The mutant never reached the executed code, or the run could not evaluate it. | Never reported as a statement about the tests. |
| Unresolved | Examined, not explained. | Not silently dropped, and not rounded into one of the others. |

**These are pre-existing quality gaps, recorded separately from any optimization
proposal.** No test was added, deleted, widened or narrowed in this slice to move
any count below, and none of the ten survivors is repaired here. A survivor is an
observation for #1113 to reconcile, not a defect this slice fixes and not a
reason to expand a suite for a better score.

One shape runs through all ten, and it is worth stating before the detail:
**every survivor is an ordering or boundary mutant.** Nothing that changes *which*
edges are planned, *which* key identifies an edge, or *which* lifetime verdict a
grant gets survived; the survivors are the comparator that orders edges, the
`.sort()` that orders roots, and the one instant at which a grant expires. That
is a coherent gap, not ten scattered ones.

### 6.1 The ten survivors

| # | Location | Mutator | Change | Class |
|---|---|---|---|---|
| 1 | `chain-linear.ts:333:69` | BlockStatement | `compareEdges` body emptied — returns `undefined` | Unresolved (group A) |
| 2 | `chain-linear.ts:334:10` | ConditionalExpression | returns `true` | Unresolved (group A) |
| 3 | `chain-linear.ts:334:10` | ConditionalExpression | returns `false` | Unresolved (group A) |
| 4 | `chain-linear.ts:334:10` | LogicalOperator | `\|\|` → `&&` | Unresolved (group A) |
| 5 | `chain-linear.ts:334:10` | ArithmeticOperator | `a.blockerIssueNumber + b.blockerIssueNumber` | Unresolved (group A) |
| 6 | `chain-linear.ts:334:57` | ArithmeticOperator | `a.blockedIssueNumber + b.blockedIssueNumber` | Unresolved (group A) |
| 7 | `chain-linear.ts:355:10` | MethodExpression | the `.sort((a, b) => a - b)` on roots is dropped | Unresolved, leaning mutation limitation (group B) |
| 8 | `chain-linear.ts:358:11` | ArrowFunction | `.sort(() => undefined)` | Unresolved, leaning mutation limitation (group B) |
| 9 | `chain-linear.ts:358:21` | ArithmeticOperator | `.sort((a, b) => a + b)` | Unresolved, leaning mutation limitation (group B) |
| 10 | `tool-request-grant.ts:242:7` | EqualityOperator | `now >= expiresAt` → `now > expiresAt` | **Potential weak assertion** |

**Group A — the whole of `compareEdges` survives (6 of 6).** Not one mutant of
this function was detected, including one that empties its body. The call sites
explain what that can and cannot mean: `compareEdges` is used only at
`chain-linear.ts:711`, `:725`, `:745`, `:832` and `:845`, and in each the sorted
list is the **content of a refusal message** — unplanned edges, missing edges,
extra edges found by the read-back. So the ordering is observable only through
refusal text. Three hypotheses remain open, and this run distinguishes none of
them:

1. Those refusal paths are not executed by the four scoped suites at all (under
   `coverageAnalysis: off` a survivor and an unreached mutant look identical, §5.1).
2. They are executed, but the sorted lists hold **at most one element**, in which
   case every one of the six is order-preserving and genuinely equivalent for the
   inputs tested.
3. They are executed with several elements and the refusal text's *order* is
   simply not asserted — a weak assertion.

Two of the six argue mildly for the third: a comparator returning `undefined`
(#1) or `false`→`0` (#3) leaves the array in insertion order and so is a no-op
for any input, but `true` (#2) and both `+` mutants (#5, #6) do reorder any list
of two or more. Their survival is consistent with hypothesis 1 or 2 and not with
a two-element list being asserted. **Equivalence is not claimed**; the group
stays *unresolved*. The cheap discriminator for #1113, should it want one, is
whether any scoped case reaches a read-back refusal carrying two or more edges —
a coverage question, not a mutation question, and answerable without another
90-minute run.

**Group B — the `.sort()` in `resolveRoots` survives (3 of 3), while the rest of
the function is killed.** `resolveRoots` is called at `chain-linear.ts:578` and
`:643`; both callers use `roots.length` to decide, and the order is observable in
exactly one place — the multi-root refusal that renders the root numbers with
``roots.map((n) => `#${n}`).join(", ")``. Every single-root case, which is every
accepted linear chain, makes the `.sort()` a no-op, so all three mutants are
equivalent there. They would be killed only by a case that reaches the multi-root
refusal with roots arriving out of order *and* asserts the rendered list. This is
the closest thing here to a defensible "likely equivalent", and it is still
recorded as **unresolved-leaning**: the argument is about which cases run, and
this run cannot say which cases run.

**Survivor 10 — the expiry boundary of a grant is not pinned.** This one is
crisp, and it is the only survivor classified as a **potential weak assertion**
on evidence rather than by elimination. `grantStatus` decides expiry with
`now >= expiresAt`; the mutant makes it `now > expiresAt`, so the two differ at
exactly one instant — `now === expiresAt`, where the real code says `expired` and
the mutant says `active`. The suite's expiry test
(`tool-request-grant.test.js:136`, "expired once now **passes** expiresAt") uses a
`now` strictly after the expiry, so nothing distinguishes them. The contrast one
line up is what makes this a finding rather than a quibble: the sibling
`uses >= maxUses` boundary at `:241` **is** pinned — "exhausted once uses reaches
maxUses" sets `uses === maxUses` exactly, and **every** mutant of that condition
is among the 25 killed, while at `:242` the otherwise identical condition leaves
this one standing. The same boundary discipline is applied to exhaustion and not
to expiry.

What that is and is not: it is a gap in the tests, not a defect report about
production behaviour — whether a grant is usable *at* its stated expiry instant
is a design choice, and the finding is that nothing in the suite records which
choice was made. It is security-adjacent (grant lifetime is the
`consolidate` candidate's contract), which is why it is called out rather than
counted. **No test is added here to close it.** Doing so in this slice would be
score-chasing against the very baseline the slice exists to establish; it is
handed to #1113 as a candidate repair with its evidence attached.

### 6.2 The three mutants no assertion judged

Reported apart from everything above, because none of them says anything about
the tests.

| Location | Mutator | Change | Status | Classification |
|---|---|---|---|---|
| `chain-linear.ts:340:38` | AssignmentOperator | `i += 1` → `i -= 1` | **Timeout** | Mutation limitation — a non-terminating mutant |
| `chain-linear.ts:340:19` | ConditionalExpression | `i < issues.length` → `false` | **Timeout** | **Unresolved** |
| `chain-linear.ts:340:19` | EqualityOperator | `i < issues.length` → `i >= issues.length` | **RuntimeError** | Harness outcome |

All three sit in the one loop header of `linkEdges`, and the fourth mutant of
that header — `i <= issues.length` — was killed. Taken together they are the
reason this report never writes "detected" as a single number.

**The `i -= 1` timeout is a real detection, but not by an assertion.** The
counter runs away from the bound, so the loop cannot terminate and no test can
ever observe a return value. StrykerJS's deadline is the only mechanism that can
catch it, and it did. It is counted as a `Timeout` and never as evidence that a
test asserts anything.

**The `false` timeout is not explained by non-termination, and is left
unresolved.** That mutant makes the loop body never run, so `linkEdges` returns
an empty edge list and returns *promptly*; termination is not the issue.
(StrykerJS deliberately generates only `false` for a `for` condition, precisely
so that it does not manufacture infinite loops — there is no `true` counterpart
to compare against.) Either the empty edge list drives one of the scoped
`runAdmin` cases into a wait that never resolves, or the mutant collided with the
424.3 s deadline for an environmental reason. **The run cannot tell, so neither
is asserted**, it is not counted as assertion evidence, and it is not re-run to
tidy it up: a second run at a different host load would be a different
measurement, not a clarification of this one.

**The `i >= issues.length` crash is a harness outcome with a concrete cause.**
StrykerJS reported `Test runner crashed. Tried twice to restart it without any
luck`, with the child process exiting on `SIGABRT` and a V8 stack. The mutant
explains it: with `issues.length === 1` the condition `1 >= 1` holds forever
while the body pushes an edge each iteration, so the loop neither terminates nor
stops allocating — behaviour consistent with the abort that was observed. (For
longer inputs it merely produces an empty list, which is why it is not simply the
`false` mutant again.) StrykerJS excludes it from the 37 it scores against; this
report keeps it visible in all three denominators of §5.1 instead. **It says
nothing about the tests**, and one such case in 38 is a noted limitation, not a
reason to call the run inconclusive — the other 37 reached a terminal status, and
**35 of them completed the whole 180-test selection**. The two mutants in this
table that timed out did not: both record `testsCompleted: 0`, which is why §5.2
counts 35 × 180 rather than 37 × 180. So the per-suite attribution in §5.2 rests
on those 35 complete runs; these three mutants — two timed out, one crashed —
contribute no `killedBy` entry and no evidence about any suite.

## 7. Reproducing this run

1. Ensure the checkout's installed dependencies match the committed lockfile.
   Pins alone are not enough: the loop's dependency sync is lockfile-only, so a
   per-issue worktree can hold the pins without the packages
   (`mutation-pilot-harness.md` §2).
2. `npm run mutation:preflight` — expect every check `ok`, and confirm the scope
   it prints is §2's.
3. `npm run mutation:dry-run:start`, then `npm run mutation:dry-run:report`.
4. `npm run mutation:pilot:start`, then `npm run mutation:pilot:report`.

Each as its own command, never chained, and never a second run while the
checkout-wide lock or a surviving process group says the first is still active.
Do not delete a lock or kill an unrelated process to get past one. Use the same
scope, output directory and resource arguments for a `:start` and its `:report`:
a report reading a different `--out` describes a directory that run never wrote.

The exact inputs this baseline's own run used — revision, toolchain versions,
mutators, concurrency, timeouts, budget and host load — are tabulated in §10, and
they are what an after-run has to match to be comparable. Reading `:report`
before the run finishes is harmless and reports only elapsed time; it is not a
result, and §4.4 records that it was treated as none.

## 8. What never leaves the machine

The raw `mutation.json` / `mutation.html` embed **whole source files** and
absolute host paths. They stay in the gitignored `.mutation/` directory, are
preserved locally for as long as they are useful, and are never uploaded — no
dashboard reporter is configured and the driver strips
`STRYKER_DASHBOARD_API_KEY` from the run's environment. Only the bounded,
sanitized `summary.json` / `summary.md` are quotable, and only the figures and
classifications above are quoted here.

## 9. Limitations

- Mutation evidence shows whether a change is **detected**. It is not proof that
  a test is redundant, not proof that every possible defect remains detectable,
  and equal scores never justify deleting a test.
- The baseline covers 39 lines of 1147 — 3.4% (§2). Outside them, detection is
  unmeasured, and the selection is deliberately contract-central rather than
  representative, so its aggregate score does not generalize to either module or
  to either suite.
- A `Timeout` counts as a detection in StrykerJS though no assertion observed
  the change. On a loaded host it also counts as noise. Both are why it is
  reported apart from `Killed` everywhere in this file.
- Only code running inside the Jest worker is observable (§3).
- Under `coverageAnalysis: off` there is no per-test coverage attribution, so a
  survivor may be an unasserted execution *or* an unreached one, and this run
  cannot separate them (§5.1). That ambiguity is why nine of the ten survivors
  stay **unresolved** rather than being classed; only survivor 10 is classified
  on positive evidence.
- **1 of 38 mutants could not be evaluated at all** (`RuntimeError`, §6.2), and
  one of the two timeouts is unexplained. StrykerJS drops the first from its
  denominator; this report keeps both visible. Neither is evidence about a test.
- `test/chain-linear.test.js` has **no measured detection** anywhere in this
  baseline (§5.2). For that file this report is not a weaker before-picture; it
  is no before-picture.
- Infrastructure starvation, timeouts and errored cases are never counted as
  proof of meaningful assertion coverage.
- This is one run. Nothing here is averaged over repeats, and no variance is
  measured; a re-run on a different host load could move the timeout row in
  particular.

## 10. Hand-off to #1113

#1113 needs an explicit decision, and this report owes it one:

- **Feasible** — the frozen scope produced a complete run inside its budget, and
  §5/§6 hold its distinct counts and classifications. #1113 may then plan against
  it, subject to the per-suite rule in `test-maintenance-candidates.md` §7 item 4.
- **Inconclusive / parked** — the evidence could not be collected, or could only
  be collected by widening the scope, raising concurrency past what the host can
  spare, or reinterpreting timeouts as kills. Then the pilot narrows or parks.
  **Incomplete evidence cannot authorize downstream consolidation**, and a
  missing baseline is reported as missing rather than substituted for.

> **Current decision: FEASIBLE, for the frozen scope in §2 and nothing wider.**
> Run `999e715b-9e2c-4b54-a2ea-3208fd238865` completed inside its budget at the
> §3 identity (90 min 52 s of a 180-minute budget, `timedOut: false`, exit 0),
> and §5/§6 hold its distinct counts and classifications. #1113 may plan against
> this evidence, subject to the per-suite rule in
> `test-maintenance-candidates.md` §7 item 4 and to the bounds below.

**The reproducible inputs #1113 inherits.** Every one of these must be unchanged
for an after-run to be comparable with this one; a difference in any of them
makes the two runs incomparable rather than noisy.

| Input | Value |
|---|---|
| Revision measured | `dc758e126549dc2822b38c782796154a6f67a458`, worktree clean. No mutated source, scoped test, configuration or runtime harness code differs between it and this report's head; the three files that do differ are this report, the harness doc's cross-reference and the harness's own test (§4.4). |
| Mutate | `src/core/chain-linear.ts:329-359`, `src/core/tool-request-grant.ts:237-244` (`BASELINE_MUTATE`) |
| Tests | the four accepted suites, unchanged |
| Toolchain | Node v22.6.0, StrykerJS 8.7.1, `@stryker-mutator/jest-runner` 8.7.1, Jest 29.7.0 |
| Mutators | StrykerJS defaults, none excluded; no `typescript-checker` |
| `coverageAnalysis` / `perTest` | `off` / not enabled |
| Concurrency / `timeoutMS` / `timeoutFactor` / incremental | 2 / 60 000 / 2 / off |
| Budget, and what it cost | `--max-runtime-min 180`; the run took 90 min 52 s, against a 134-min all-timeout ceiling recomputed from its own pass (§4.4) |
| Host condition | load 2.68 / 2.44 / 2.35 → 4.92 / 4.31 / 4.04 on 8-way parallelism, 1 171 MB free afterwards. An after-run started on a busier host is not comparable. |
| Commands | §7, as separate `:start` / `:report` pairs with the same scope, `--out` and resource arguments |
| Matching rule | mutants are matched across runs by **source location, mutator, original and replacement** — never by report index |

**What #1113 may conclude from this, and what it may not.**

- It **may** treat the grant pair as measured: 11 detections over 12 mutants in
  `tool-request-grant.ts:237-244`, split **9 / 2 with no overlap** between the
  pure and the admin suite (§5.2). For that region, dropping
  `admin-tool-request-grant.test.js` loses two detections — a concrete,
  measured cost, not a presumption.
- It **may** treat `chain-linear.ts:329-359` as measured for
  `admin-chain-edit.test.js` (14 detections, from 4 tests) and as **unmeasured
  for `chain-linear.test.js`**, which killed nothing here (§5.2). Preservation
  for that file cannot be argued from this report at all.
- It **may not** read the 72.97% as a fault-detection rate. The figure of record
  is **25 / 37 = 67.6%** assertion-observed (§5.1), and even that describes 39
  of 1147 lines — **3.4%** (§2). Detection everywhere else is *unmeasured, not
  good*.
- It **may not** treat the two contracts the narrowing gave up —
  `verifyLinearChainReadBack`'s missing/extra-edge judgement and `grantMatches`'s
  scope-before-lifetime ordering — as covered. They were refused on cost (§4.3)
  and have no before-evidence here.
- It **may not** close any §6 survivor by adding a test in this slice's name, or
  cite the survivors as proof of redundancy. A survivor means "undetected", not
  "unneeded", and the six in `compareEdges` are explicitly **unresolved** between
  an unreached path, an equivalent mutant and a weak assertion.

**What would make the evidence insufficient again.** Any change to a mutated
source's lines, to one of the four suites, to `BASELINE_MUTATE` or to the
toolchain invalidates this baseline as the *before* half of a comparison; the
answer then is a new baseline at the cost §4 prices, from its own dry run, not an
inference from this one. If a later run cannot be completed inside its budget on
a quiet host, the pilot narrows or parks — **incomplete evidence cannot authorize
downstream consolidation**, and a missing baseline is reported as missing rather
than substituted for.

This decision authorizes #1113's *planning* only. #1114-#1116 still require the
reviewed concrete plan and human approval, and nothing in this report is a
licence to delete, merge or weaken a test.
