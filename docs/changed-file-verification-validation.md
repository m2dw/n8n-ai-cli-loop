# Changed-file / full-suite verification — validation and measured results

Status: **integration unfinished — end-to-end behavior validated, repository-scale
timings measured, no session bound** (issue #1156, slice 6/6).

This is the publication half of
[changed-file-verification-contract.md](changed-file-verification-contract.md)
(#1158): what the replacement actually does on a real project, what it costs,
and what is still missing. It decides nothing. Where this report and the
contract disagree, the contract wins.

Read this together with
[staged-verification-operations.md](staged-verification-operations.md) §6,
which is the operator guide for turning the binding on.

## 1. Summary

| Question | Answer |
| --- | --- |
| Does the loop run only the Issue's changed and retained test files? | Yes — validated end to end against a real Jest (§2) |
| Does anything run the whole suite before review approval? | No — no full run precedes the reviewer in any validated trace (§2, §3) |
| Does a failing full run retain its failing files for the next loop? | Yes — the retained file is selected by the next Stage 1 and stays retained after it passes (§2) |
| Is `status:stack-ready` still gated on a complete, passing full suite? | Yes — the grant rides the completion that records a passing Stage 2 at the approved head (§2) |
| Are the Stage 1 / Stage 2 durations on **this** repository measured? | **Yes**, on 2026-09-18 at head `60cb22dc`: a three-file Stage 1 costs 36.8 s against 779.0 s for the whole 315-file suite — 4.7 %, 742.1 s less per pre-approval cycle (§5.2), with the conditions and limitations recorded beside them. Historical: taken once at that head and not re-taken since (§5) |
| Does this branch itself still get full project verification? | Yes — every head, this one included, and not from this report: the Issue workflow runs `npm test`, `npm run typecheck` and `npm run package` at the branch head and gates on them. The measurement's own Stage 2 additionally ran the whole 315-file suite green at `60cb22dc` (§5.1) |
| Is the integration finished? | **No.** One operator step is left — no session here binds the suite — and §5.3 states it |

## 2. End-to-end evidence

`test/changed-file-verification-e2e.test.js` drives
[the contract's §7 trace](changed-file-verification-contract.md) on a real
project: a plain-CommonJS (non-TypeScript) Jest project in a real git
repository, with this repository's own installed Jest doing the discovery, the
selected run and the machine result. The lanes are the real orchestration path
— the phase runner claims each task from a durable SQLite store, and the review
lane is the shipped `createReviewHandler`. Only the network (`gh`, `fetch`,
`pull`, `ls-remote`) and the reviewer CLI are answered by the test; every build,
lint and test command really runs.

Inventory is `{A, B, C}`. `A` is the test file the Issue edits, `B` is the file
that catches the source defect, and `C` is a file neither stage 1 ever selects.

| Step | Lane | Executed test commands | Result | Retained | Route |
| --- | --- | --- | --- | --- | --- |
| 1 | implementation | `--listTests`, `--runTestsByPath …/a.test.cjs` | Stage 1 `passed` | ∅ | commit H1 |
| 2 | review at H1 | `--listTests`, `--runTestsByPath …/a.test.cjs` | Stage 1 `passed` | ∅ | reviewer approves |
| 3 | review at H1, approved | `--listTests`, full run | Stage 2 `failed` (B) | `{B}` | `needs_fix`, fix input names B |
| 4 | implementation | `--listTests`, `--runTestsByPath …/a.test.cjs …/b.test.cjs` | Stage 1 `passed` | `{B}` | commit H2 |
| 5 | review at H2 | `--listTests`, `--runTestsByPath …/a.test.cjs …/b.test.cjs` | Stage 1 `passed` | `{B}` | reviewer approves |
| 6 | review at H2, approved | `--listTests`, full run | Stage 2 `passed` | `{B}` | **grant** |

What the test asserts, beyond the table:

- **No full run precedes the reviewer.** Every full-suite invocation in steps 3
  and 6 sits after the reviewer CLI call in the same trace, and the
  implementation lane's traces contain none at all.
- **A rejected review never runs the suite and never grants** — a separate case
  drives a `[P1]` review to `needs_fix` and asserts an empty full-run list and
  no `status:stack-ready` effect.
- **The obligation is durable.** The stores are closed and reopened between
  steps 3 and 4, and `B` is still retained on the task row.
- **A retained file stays retained after it passes** (contract §4.3), so step 6
  grants with `{B}` still held.
- **Absence is never success** (§8 invariant 4): the granting bundle reports
  three passed files because the full run actually ran three, and `C` is
  reported by no Stage 1 bundle.

Issue #1167 extended the same file — the same fixture project, the same real
Jest, the same lanes — with the behaviors the operator configuration in
[staged-verification-operations.md](staged-verification-operations.md) §6
depends on, so nothing that guide documents rests on the scripted-runner tests
alone:

| Case | What the integrated run shows |
| --- | --- |
| The ordinary `npm test` requirement, undeclared | The review gate blocks on a required command no configured check runs. The reviewer never runs, no full suite is launched and nothing is granted |
| The ordinary `npm test` requirement, declared (§6's binding) | Stage 1 runs the changed file only, the requirement reads *pending Stage 2* through review, and the complete passing Stage 2 — nothing before it — turns it `passed` and grants |
| D5, an accepted predecessor update | Driven through the phase runner and the durable store: an Issue that earned a real grant at the old base is re-queued against the newly accepted head, and the base advances only for the accepted head. The predecessor's own test file leaves the selection, the retained file survives, and every bundle recorded against the old base — the Stage 2 the grant rested on, and the pin naming it — is dropped. A head that moved with no acceptance of that exact commit launches nothing and leaves the recorded base standing on the row |
| D6, an all-skipped Stage 1 | `empty`, never `passed`: review still runs and Stage 2 is still mandatory |
| D6, an all-skipped Stage 2 | `no-evidence`: the Issue parks, nothing is granted, and the full run is not repeated |

These are the same decisions `test/changed-file-verification-wiring.test.js`
covers against a scripted Jest. They are repeated here against the real one
because a skip, a machine result and a discovery are exactly the places a fake
runner can agree with the adapter and a real one disagree.

The earlier slices' tests stay the authority for their own halves:
`test/changed-file-verification-wiring.test.js` (#1154) covers every lane and
route against a scripted runner, `test/jest-test-file-adapter-fixture.test.js`
(#1152) covers the adapter against real Jest, and
`test/staged-verification-e2e.test.js` covers the non-test checks, the store
restart, cross-Issue isolation and operator amendments.

## 3. What an ordinary localized change costs

The claim this replacement makes is **per cycle**, not per Issue:

- Before approval, each cycle runs the Issue's changed and retained test files
  instead of the whole suite. For a localized change that is a handful of files
  out of the project's entire runnable-file inventory.
- After approval, the whole suite runs once, at the approved revision. Nothing
  is skipped, reused or subtracted there — the grant is the same complete,
  passing, full-set evidence it was before this chain.
- A repair cycle therefore costs `build + discovery + selected files` instead of
  `build + whole suite`, and the whole suite is paid once per approval rather
  than once per cycle.

Three costs are *added*, and none of them is free:

1. **The setup (build) command** runs once per stage, before discovery, because
   discovery and the selected files both read built output.
2. **Discovery** is a separate process launch (`--listTests --json`) on every
   stage, including cycles whose selection turns out to be empty.
3. **Stage 2** is a second full-suite run per approval round — an Issue that is
   approved, fails its full suite and is approved again pays for two.

## 4. How to reproduce the measurement

`scripts/changed-file-stage-timing.mjs` takes the measurement. It is opt-in and
run by hand: nothing in `npm test`, `npm run package` or CI invokes it, and it
makes no commit, label, publication or configuration change. It adds no
selection and no statistics of its own — the Issue base, the cumulative change,
the runnable-file report and the selection all come from the shipped modules the
lanes call, and every command is launched through the shipped command runner.

```sh
npm run build
node scripts/changed-file-stage-timing.mjs --base-branch main --json .changed-file-timing.json
```

**Run it from an ordinary terminal, not through the loop's grant executor.** The
approved-command executor in `src/core/tool-request-run.ts` runs every granted
command as `/bin/sh -c` under a fixed `GRANT_EXEC_DEFAULT_TIMEOUT_MS` of 120
seconds. This measurement is a build plus a whole-suite Jest run; it does not fit
in that window and never will (§5.2.2), and the only grant that can carry it is a
detached one that returns before the run finishes. Nothing here asks for the
ceiling to be raised — a longer deadline on the grant path would change what
every other approved command may do, for one report.

It prints, for the current branch:

- the Issue base and the number of changed paths;
- the runnable-file inventory size and **the actual selected file list** with
  each file's `changed` / `retained` reasons;
- the exact argv of every launched command — setup, discovery, the selected run
  and the full run. The JSON report keeps each launch's `cmd` and `args` apart,
  exactly as they were executed, and the console line quotes only the arguments
  that need it, so a path or suite command carrying spaces or shell
  metacharacters stays unambiguous and reproducible;
- the wall-clock duration of each, the Stage 1 / Stage 2 ratio, and the build +
  discovery cost;
- the host conditions the numbers were taken under: platform, CPU count and
  model, memory, node version, load average before and after, and any
  `--maxWorkers` the suite command carries.

A reproducible representative change is any branch that edits a small number of
test files; `--retained a,b` adds retained files to the selection so a post-
failure cycle can be measured without producing a failure first, and
`--skip-full` measures Stage 1 alone.

**Name the base explicitly on a stacked branch.** Without `--base`, the Issue
base is resolved from `--base-branch`, so a branch stacked on unmerged
predecessors gets the merge base with `main` — the root of the whole stack — and
its "cumulative change" is every slice's change, not this Issue's. The selection
is then large by construction and measures nothing about a localized change.
Pass `--base <predecessor sha>`, the accepted revision this Issue actually built
on, whenever the branch is not cut directly from the base branch.

Three rules govern what it will and will not call a saving:

- **An empty selection is a measurement, not a gap.** A branch that changed only
  sources or documentation and retains nothing has an `empty` Stage 1 (§3 R10):
  it executes no test file, so its test time is **zero**, and the pre-approval
  cycle still costs the setup plus the runnable-file report.
- **A stage that never tested for any other reason is incomplete.** A Stage 1
  whose plan is `retained-unresolved` — `--retained` named a deleted, renamed or
  misspelled file the runnable-file report does not carry — or `unavailable`
  executed nothing and is not an `empty` pass; a Stage 2 whose own setup or
  discovery failed, hit the deadline, or left a runnable-file report that was
  unreadable or named no file never launched a test. Either stops the
  measurement: the partial report is printed and written, and the exit status is
  nonzero. A red suite is the one failure that is a *result* — its tests did run
  — and it still exits 0.
- **A ratio needs two completed runs.** A saving is printed only when both
  stages ended on their own and accounted for every file they expected — the
  trust, completeness and termination the shipped runner already reports. A run
  that hit `--timeout`, failed its setup or discovery, or left an unreadable
  machine result still has command durations, and they are reported; they are
  not compared, because they are not a whole-suite time. The report says which
  stage disqualified the comparison and why. A run whose setup or discovery
  failed outright stops there, but still prints its partial report — the
  durations taken so far, the host conditions and the disqualifying reason — and
  still writes it to `--json`; the nonzero exit status is taken after that
  report, never instead of it.

## 5. Measured results

Every number below was taken on this branch on 2026-09-18 by §4's script, at
head `60cb22dced995680e06e25145eda97d7132bc027` with `--base 30430073`, and is
copied from the machine report that run wrote. It is one pass on one host — read
[Measurement limitations](#measurement-limitations) before quoting any of it as
a project benchmark.

**They are historical measurements, and this Issue did not re-take them.** The
branch has since gained the D5/D6 corrections (#1165), the declared full-suite
requirement (#1166) and the documentation corrections of #1167, so `60cb22dc` is
no longer the head anyone reads. Nothing in those changes is expected to move a
duration, but nothing measured it either: the table below is evidence about one
run at one revision, not a current benchmark and not a performance guarantee.
Re-run §4's script to get a fresh number.

### 5.1 Full project verification of this branch

Full project verification of this branch is **not** what is missing, and this
report neither performs it nor stands in for it. The Issue workflow that owns
the branch runs `npm test`, `npm run typecheck` and `npm run package` itself, at
the head produced by each turn, and the branch does not pass review or reach
completion unless they pass. That is the `npm test` requirement of
[AGENTS.md](../AGENTS.md) §Verification, and it is discharged by that run — a
report cannot certify a command whose result is decided after the report is
written, so no result is claimed here for the head you are reading.

What this report *can* record is a full-suite run that really happened, on a
real head of this branch, because the measurement's Stage 2 is one. It is
evidence, not a gate:

| | |
| --- | --- |
| Head | `60cb22dced995680e06e25145eda97d7132bc027` |
| Commands | `npm run build`, then `npm run test:files -- --json --outputFile=<tmp>/timing-stage2-result.json` |
| Files reported | 315 of the 315 runnable test files |
| Failing files | **0** |
| Exit code | `0` |
| Duration | 771.0 s of Jest; 779.0 s including that stage's own build and discovery |

That is the whole suite and not a subset of it: `package.json` defines `test`
and `test:files` as the same command — `node --experimental-vm-modules
node_modules/.bin/jest`, launched with no file argument and no project filter —
and `npm test`'s `pretest` is `npm run build`, which Stage 2 ran first. The only
difference from `npm test` is `--json --outputFile=<tmp>`, which adds a machine
report and selects nothing. `npm run package` *is* `npm run build`, which exited
`0` twice in that run; `npm run typecheck` was not launched under its own name,
and `npm run build`'s `tsc -p tsconfig.json` compiles the same project with emit
rather than `--noEmit`.

Two runs still decide completion, and neither of them is this table: the
workflow's own verification at the final head, and CI (§6).

To be unambiguous about what that means for the revision you are reading: every
head this branch has produced, including its last, is verified by that workflow
run, after the turn that wrote this file exits. A sentence in this report saying
an agent turn could not launch Jest is a statement about the turn, never about
the branch — the turn does not run the suite because the workflow runs it, and
the branch does not complete unless it passes.

What an *agent turn* on this branch cannot do is launch the toolchain itself:
the non-interactive issue workflow admits no `npm` or `node` invocation and
cannot grant one inline. That blocks exactly one thing — the stopwatch in §5.2.
The timing script has to launch `npm run build`, a selected-file run and a
full-suite run inside the turn, and none of those three is one of the configured
verification commands the workflow runs for it. An operator closed that gap on
2026-09-18, from outside the turn, by granting the detached launch §5.2.2
describes.

### 5.2 Repository-scale timings — measured

**The repository-scale numbers below were measured, not modelled.**

| Measurement | Value |
| --- | --- |
| Stage 1 duration (selected files) | **28.4 s** — 28449 ms for 3 files |
| Stage 2 duration (full suite) | **779.0 s** — 778957 ms for 315 files, its own build and discovery included |
| Build (setup) cost per stage | **7.2 s** — 7245 ms in Stage 1, 6899 ms in Stage 2 |
| Discovery cost per stage | **1.1 s** — 1128 ms in Stage 1, 1018 ms in Stage 2 |
| Saving per pre-approval cycle | **742.1 s** — a 36822 ms cycle against 778957 ms, a ratio of **4.7 %** |

The conditions they were taken under, as recorded by the run rather than
reconstructed:

| Condition | Value |
| --- | --- |
| Taken at | `2026-09-18T05:41:30.283Z` |
| Head / base | `60cb22dc` against `30430073` (`branch-start`), 10 changed paths |
| Host | `darwin-arm64`, Apple M2, 8 CPUs, 24 GiB, node `v22.6.0` |
| Load average | 2.74 / 3.46 / 4.23 before, 6.58 / 5.64 / 5.32 after |
| Workers | `--maxWorkers` absent from the suite command, `JEST_WORKERS` unset — Jest's own default over 8 CPUs |
| Binding | `{"adapter":"jest","setupCommand":"npm run build","argumentSeparator":"--"}`, suite command `npm run test:files` |

**The selected file list**, three files out of a 315-file runnable inventory,
each selected because this Issue's cumulative diff changed it and nothing was
retained (selection digest `53c5475d…`, plan `execute`):

- `test/changed-file-verification-e2e.test.js` — `changed`
- `test/docs-staged-verification-operations.test.js` — `changed`
- `test/staged-verification-e2e.test.js` — `changed`

**The executed commands**, in order, as launched:

```sh
$ npm run build                                                  # setup, 7.2s
$ npm run test:files -- --listTests --json                       # discovery, 1.1s
$ npm run test:files -- --json --outputFile=<tmp>/timing-stage1-result.json \
    --runTestsByPath <the three absolute paths above>            # Stage 1, 28.4s
$ npm run build                                                  # Stage 2 setup, 6.9s
$ npm run test:files -- --listTests --json                       # Stage 2 discovery, 1.0s
$ npm run test:files -- --json --outputFile=<tmp>/timing-stage2-result.json
                                                                 # Stage 2, 771.0s
```

Both stages were `trusted`, `complete` and `confirmed`, so the ratio is taken
from two runs that each ended on their own and accounted for every file they
expected (§4).

#### 5.2.1 What the numbers say about an ordinary localized change

This branch is one: 10 changed paths, three of them test files.

- **No full suite ran before approval.** The pre-approval cycle executed 3 of
  315 runnable files — 0.95 % of the inventory — and cost 36.8 s end to end.
- **Actual saving: 742.1 s per pre-approval cycle**, about 12 minutes back on
  every repair cycle, because the whole suite is paid once per approval round
  instead of once per cycle (§3).
- **Build cost: 8.4 s of that 36.8 s** — 7.2 s of `npm run build` plus 1.1 s of
  discovery, 23 % of the cycle. It is paid by every cycle, including one whose
  selection turns out to be empty, and it is the price of the replacement.
- **Full-stage cost is unchanged: 779.0 s**, 315 files, 0 failures, run once per
  approval. An Issue approved, failed and approved again pays it twice (§3).
- **This is not a best case.** The three selected files are among the
  repository's slowest — roughly 9.5 s each, against a 2.5 s whole-suite average
  per file (779.0 s / 315) — because they are subprocess-heavy end-to-end
  suites. A localized change touching three *ordinary* test files would cost
  less than 28.4 s of testing; one touching many test files legitimately
  approaches the full-suite cost.

#### 5.2.2 Why a granted command could not take it in its own process

The measurement is an operator step rather than a turn's own command, and the
reason is a measured one, not an oversight. It is recorded here so the next
reader does not spend another cycle rediscovering it.

The loop's approved-command path executes a granted command as
`/bin/sh -c "<command>"` with `timeout: GRANT_EXEC_DEFAULT_TIMEOUT_MS`, and that
constant is `120_000` — [`src/core/tool-request-run.ts`](../src/core/tool-request-run.ts),
where it is declared and where the single `exec.run("/bin/sh", …)` call applies
it. It is a hard, unconfigurable wall clock: no flag, environment variable or
per-request field raises it.

The measurement needs, in one process: `npm run build` (three TypeScript
compilations), a `--listTests` discovery over this repository's 315 runnable
test files, a selected-file run, and then the **whole suite**. On 2026-09-18 an
operator granted exactly that command through that path. The captured result:

| | |
| --- | --- |
| Command | `npm run build && node scripts/changed-file-stage-timing.mjs --base 30430073 --json .changed-file-timing.json` |
| Exit code | `1` |
| stderr | `Error: spawnSync /bin/sh ETIMEDOUT` |
| How far it got | `npm run build` completed — stdout carries all three build steps, and `dist/` was written — and the deadline fired inside the timing script, before it printed anything |

So the build alone consumes most of the 120 s window, and the whole-suite run
that follows it is the deliverable. **No granted command can take this
measurement in its own process**, and a second foreground grant of the same
command would fail the same way; the failure above is a property of the
executor, not of the branch, the script or the host's load at the time.

Two consequences, both deliberate:

- **This report does not ask for the ceiling to be raised.** 120 s is the bound
  every approved command in the product runs under; widening it to publish one
  table would trade a safety property for a measurement.
- **The measurement stayed an operator step**, like the `sessions.json` binding
  in §5.3. The run §4 documents is taken **in a terminal** — not as a granted
  command, and under no deadline at all — and the detached form below is the one
  shape that also fits the grant path.

The shape that fits the ceiling is a detached launch: the granted shell returns
as soon as it has backgrounded the run, so the executor's deadline applies to a
process that has already exited, and the report is collected from disk
afterwards. **This is how §5.2's numbers were taken**, at 05:41:30Z on
2026-09-18:

```sh
nohup node scripts/changed-file-stage-timing.mjs --base 30430073 \
  --json .changed-file-timing.json > .changed-file-timing.log 2>&1 &
```

`dist/` has to be built already — the script refuses to run without it — and the
detached run still pays its own `npm run build` as the measured setup, so the
build cost in the report is a real one. Both output paths are ignored
(`.changed-file-timing*`), so the run moves no tracked file while a stage is
attesting the worktree. It is a delivery mechanism, not a second measurement:
the numbers, the selected file list and the recorded conditions are exactly the
ones §4 describes, and `--base 30430073` names `#1155`'s accepted head — the
revision this Issue built on, and what the loop resolves as the Issue base — so
the selection is this slice's own three-file change rather than the whole
stack's.

`30430073` is the last commit on this branch that is not #1156's — name the SHA,
not `HEAD~n`, because every further fix turn shifts the offset. `--base-branch
main` is the wrong invocation here and would overstate the selection badly: this
branch is the last of six stacked, unmerged slices, so its merge base with
`main` is the root of the whole stack (§4, "Name the base explicitly on a
stacked branch").

### 5.3 What is still missing — the session binding

Per this Issue's own acceptance rule, the project integration is
**unfinished, not foundation-complete**: no session in this repository binds the
suite, so the loop that runs this branch still runs the whole suite as an
ordinary verification command, exactly as it did before the chain. The
measurement in §5.2 is a measurement of the shipped stages, not evidence that
they are switched on here.

One step closes it, and nothing in the repository can take it:

- An operator adds the §6 binding of
  [staged-verification-operations.md](staged-verification-operations.md) to this
  repository's session in `sessions.json`. Nothing in the repository can do
  that: the suite command, the bound key and the adapter binding are
  operator-authored (contract §10.1 D4), and the runner never edits a live
  session.

That binding now carries one more operator-authored field, and it is not
optional here. This repository's Issues require `npm test` while the binding
runs `npm run test:files`, so without `"requirementCommands": ["npm test"]`
(issue #1166, contract §6 rule 5) every Issue would block at the review gate on
a required command no configured check runs — the whole-suite requirement could
never reach the Stage 2 that discharges it. The declaration changes no command
and grants nothing: `npm test` stays pending until a complete passing Stage 2 at
the approved revision records it.

Until it is done, this repository's own loop still runs `npm test` — the whole
suite — as an ordinary verification command on every cycle.

### Measurement limitations

The numbers in §5.2 are bounded evidence, not a benchmark:

- **One pass, one host.** The script takes a single measurement and records the
  load average around it. It does not repeat, discard outliers or model
  variance. A starved host inflates both stages, not necessarily by the same
  factor.
- **Warm versus cold.** Stage 2 runs after Stage 1 in the same invocation, so it
  benefits from a warm filesystem cache and a warm npm/Jest module cache. The
  real Stage 2 runs in a later phase on a possibly cold host, which makes the
  measured saving a *lower* bound on the real one.
- **Worker count is observed, not controlled.** The script records
  `--maxWorkers` and the CPU count; it never sets them. Jest's own worker
  heuristics dominate the full-suite number.
- **The selected-file number depends entirely on the branch measured.** It is a
  property of the change, not of the project, and a branch that edits many test
  files legitimately approaches the full-suite cost. The three files this run
  selected are unusually slow ones (§5.2.1), so 28.4 s is not a typical
  three-file Stage 1.
- **The head measured is not necessarily the head you are reading.** The run was
  taken at `60cb22dc`; the commit that published these numbers is later than the
  run that produced them. It edits this report and the docs test that pins it —
  `test/docs-staged-verification-operations.test.js`, already one of the three
  selected files — so the selection is the same three files and the added cost
  is a handful of string assertions inside a 28.4 s file set. A later commit
  touching `src/`, another test file or the Jest configuration would invalidate
  the durations and need the run re-taken, and one that adds or removes a test
  file would change the selection too. Later commits on this branch did exactly
  that — #1165 and #1166 changed `src/` and several test files — so the
  durations above describe `60cb22dc` and no head after it.
- **A load average is not an isolated host.** The run shared the machine with
  whatever produced a 2.74 → 6.58 one-minute load (the run itself is most of
  that rise). Both stages paid it; neither was measured on a quiet box.
- **Nothing here measures detection.** Stage 1 is a cheaper *cycle*, not a
  cheaper *guarantee*; §6 states what is and is not guaranteed.

## 6. What is guaranteed, and what is not

- **Guaranteed.** `status:stack-ready` is published only by the completion that
  records a complete, passing, full-set final bundle — the whole test suite
  included — bound to the approved revision, with the required non-test checks
  passed for that same revision. Review approval alone never grants, and an
  earlier run's declaration never grants a later one.
- **Not guaranteed.** A defect that only some *other* test file would catch is
  found by Stage 2, one review cycle later, rather than by the cycle that
  introduced it. That is the deliberate trade: detection is unchanged at the
  gate and later within the loop.
- **Unchanged.** CI and any full project verification an operator runs outside
  the loop remain an independent final safeguard. This chain narrows what the
  *loop* runs before approval; it never narrows what CI runs, and no setting
  here can omit a required check.

## 7. Obsolete-selector removal

Issue #1155 removed the #1094–#1108 group-selection policy outright — there is
no migration, alias, deprecation warning or dual-mode support. The checks that
hold that line are `test/staged-verification-config.test.js` (a session still
carrying `selectable`, `finalOnly`, `selectionTimeoutMs`, `selectionAdapter`,
`resultAdapters` or `resultTimeoutMs` does not load) and
`test/docs-staged-verification-operations.test.js` (no retired setting survives
in a copyable example). `src/core/stage-selection.ts`,
`src/core/project-verification-file.ts`, `.ai-cli-loop/verification.json`,
`scripts/loop-selection.mjs` and `scripts/staged-verification-baseline.mjs` are
deleted, and nothing in this Issue reintroduces a selection port, a project
verification file or a second selection mode.

## 8. Out of scope

No automatic publication, merge, periodic audit or test-maintenance expansion.
No test removal, assertion weakening or hand-crafted category partition: none of
those is a means of speeding up this rollout. The Test Maintenance Pilot
(#1109–#1116) stays a separate project — this report neither consumes its
dependency graph nor changes its branches, and
`scripts/changed-file-stage-timing.mjs` shares no code, no output directory and
no report with it.
