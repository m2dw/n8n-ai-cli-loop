# Scoped StrykerJS harness (Test Maintenance Pilot, slice 3)

Issue #1111. This is an opt-in maintenance tool, not a feature of the loop.
Nothing in `npm test`, `pretest`, `npm run package`, ordinary loop verification
or per-PR CI runs mutation testing, and no scheduler was added. Every run is a
command an operator types.

The harness exists to answer one question: **can StrykerJS mutate the code this
repository actually executes, without imposing routine mutation cost?** It does
not produce a mutation baseline — that is slice 4 (#1112) — and it changes no
test and no production behaviour.

## 1. Reconciliation with the predecessor (#1110)

| Field | Value |
|---|---|
| Accepted scope source | `docs/metrics/test-maintenance-candidates.md` §5, on the inherited branch |
| Sources to mutate | `src/core/chain-linear.ts`, `src/core/tool-request-grant.ts` |
| Test files counted as evidence | `test/chain-linear.test.js`, `test/admin-chain-edit.test.js`, `test/tool-request-grant.test.js`, `test/admin-tool-request-grant.test.js` |
| Still matches this branch | Yes. `test/mutation-pilot-harness.test.js` asserts the six paths exist and that each test file imports `../dist/`, and it runs in the ordinary suite, so a later move breaks the build rather than silently widening the scope. |

**The file bound above was not widened, narrowed or substituted**, and it is the
bound this table states: the mutated sources are those two files and the
evidence suites those four, in #1111 and since. `assertScope()` in
`stryker.pilot.config.mjs` refuses any configuration whose mutate list names a
file outside those two, or whose test list names a file outside those four —
including the two suites #1110 excluded on purpose
(`admin-tool-request-run.test.js`, which is spawned, and
`tool-request-run-operation.test.js`, which would mask a loss in a candidate
suite). A whole-repository pass is not a configuration this harness can produce.

**What did change is how much of those two files a run mutates, and the rest of
this document turns on the distinction.** #1111's modes mutated them whole; that
is the scope §6 measured at 742 mutants and rejected as unaffordable. Since
#1112, `mutation:pilot` and `mutation:dry-run` mutate **frozen line ranges**
inside the same two files (§2, `BASELINE_MUTATE`) — the narrowing §6 says slice 4
had to make, which `assertScope()` permits precisely because it moves no file
into or out of either list. Where this document says "whole-file scope" it means
the historical measurement; "frozen ranges" or "the active scope" means what the
commands run today.

## 2. Invocation

**Prerequisite: the two packages must actually be installed in the checkout you
run from.** Pinning them in `package.json` is not enough. The loop's own
dependency sync runs in lockfile-only safe mode (`npm install
--package-lock-only --ignore-scripts`, see
`docs/tool-request-and-dependency-sync.md` §3.2a), which regenerates
`package-lock.json` and never writes `node_modules/`. A per-issue worktree
therefore has the pins but not the packages until an operator runs `npm install`
there. `npm run mutation:preflight` says so by name when they are missing, and
every other mode refuses to start Stryker until the preflight is clean. The same
install is what puts TypeScript where the sandbox build needs it: the
`sandbox-compiler` check names the absolute path the build command will execute
(§3 item 2), because the sandbox cannot supply it.

| Command | What it does | Cost |
|---|---|---|
| `npm run mutation:preflight` | Checks the harness and prints the scope. Runs no build, no test and no mutation. | Instant |
| `npm run mutation:dry-run` | Stryker's own dry run over the active scope, no mutant activated. Proves the sandbox builds and the scoped tests pass unchanged, and reports how many mutants a full run would have to test. | 182 s over the frozen ranges (38 mutants, `mutation-pilot-baseline.md` §4.1); 187 s over the whole-file scope (§4, attempt 6). Either way longer than a 2-minute caller will wait, so **start it detached, see §2.1** |
| `npm run mutation:smoke` | The minimal known-detectable mutation check (§4). Its own 12-line range is fixed and independent of the pilot's. | 75 s measured (§4, attempt 4) |
| `npm run mutation:pilot` | The frozen ranges inside the accepted scope. Run only after the smoke check passes **and** the dry run's mutant count fits a budget. | **90 min 52 s measured** over the frozen ranges (`mutation-pilot-baseline.md` §4.3). Over the whole files it was never run and does not fit — §6 |

**Since #1112, `mutation:pilot` and `mutation:dry-run` run the frozen line ranges
inside the two accepted sources (`BASELINE_MUTATE`), not the whole files** (§1).
The whole-file scope is the one §6 measured and found not to fit; the two modes
were narrowed together on purpose, because a dry run is what says how many
mutants the pilot must test. The ranges, and what the narrowing does and does not
license, are in `docs/metrics/mutation-pilot-baseline.md` §2. `mutation:smoke` is
untouched by that narrowing: it has always had a range of its own (§4).

**Run one of these at a time, each as its own command.** Chaining them
(`mutation:preflight && mutation:smoke && mutation:dry-run`) is what broke
attempt 4: the three together outlast a wrapper's own command timeout, and when
that wrapper stops reading, Stryker — which inherits the console — dies on the
broken pipe. The driver now names that case (`interrupted
(console-closed:EPIPE)`) instead of filing it as a Stryker result, and — when
its output is not a terminal, which is when Stryker goes quiet — prints a
heartbeat every 30 s so a silent dry run can be told from a hang. Neither makes
a chained invocation fit; they only make its failure legible.

**One run at a time is enforced, not merely advised.** Before any mode that
builds or tests does anything, it takes an ownership lock at `.mutation/pilot.lock`
by exclusive create (`open` with `wx`, so two starts racing cannot both win), and
releases it on the way out. **That path is fixed and `--out` does not move it.**
The lock is what serializes runs in this checkout, so it cannot be a file the
caller gets to choose: were it taken under `--out`, the default run and
`--out .mutation/alternate` would create two different locks, both pass the
preflight, and both go on to build, test and prune at once. `--out` still decides
where reports, logs and sandboxes are written; it never decides who may run. Nor
is the lock inside one mode's report directory, because what a run owns is wider
than that: every mode shares the host, the one `.mutation/stryker-tmp`, and the
sandbox-pruning pass. Starting a smoke run during a dry run, or a second
`:start` on top of a run that is stuck past its budget, is refused with the
holder's mode, pid and age — **every live owner blocks**, including one a
`:report` would call `overdue`, since a stuck run's Stryker group is still on the
host. A `:start` hands its lock to the detached copy it spawns, so the lock always
names the process that is actually running, and **that copy recognizes the lock by
its run id, never by a pid alone**: a driver killed outright can leave its record
behind while the group it started runs on, and the host is free to hand that pid
to a later invocation of this harness, which would then take the live run's lock
for its own. Every process that legitimately meets its own record carries the id
(`MUTATION_PILOT_RUN_ID`), so requiring it costs nothing. A record whose driver is
gone while its recorded group runs on is refused outright — neither adopted nor
cleared — whatever else it resembles.

**The lock outlives a killed driver while its Stryker group runs on.** The driver
starts Stryker in its own process group, and stops that group on every ending it
controls — but a SIGKILL or an OOM kill of the driver leaves the group running
with nothing left to release anything. So the driver records that group id in its
own lock record before it waits on the run, and an acquisition asks about the
driver **and** that group: a lock is abandoned only when both are gone. Until
then the next invocation is refused, and told which group is still running rather
than offered a `:report` no driver will write. The id is cleared again as soon as
the run is over, so a pid the host later recycles cannot refuse a future run;
it is kept only in the one case where the group outlived even SIGKILL, which the
run summary reports as `groupSurvived` — and classifies as `interrupted
(group-survived)`, never `complete`, whatever the leader's exit code was (the
cost baseline does the same and skips its remaining repetitions). Windows has no group id, and `taskkill`
can reach the leader while a worker survives, so there the driver also records
each pid still running when it gave up (`strykerSurvivors`, stamped like the
leader) and the lock stays held while any of them is. Should that record fail to be written at
all, the group is stopped and waited for before the failure is reported: an
unrecorded group left running is exactly the state in which a later stale-lock
recovery would admit a second run beside it. A lock left behind by a killed run is
cleared by the next invocation once it can see that nothing of the run is left; a
lock whose record cannot be read is treated as live for a minute (a start can be
mid-write) and then cleared. **Clearing replaces one named instance, not whatever is at the
path.** Removing the dead owner's file and winning the create again are two
steps, and between them the winner's brand new lock sits exactly where the dead
one was; an unconditional remove there deletes a live lock and lets both runs
proceed. So the removal happens under a second exclusive-create mutex
(`.mutation/pilot.lock.steal`), which re-reads the lock and removes it only when
it is still the instance that was judged abandoned — a lock record is stamped
with its run's pid, id and start time. A caller that finds the mutex held does
not clear at all; it retries the create and is refused by the clearer's live
lock, which is the right answer. The mutex is released on every ending, and one
left by a process killed inside it is reclaimed after a minute — by instance,
never by path. The mutex file carries a stamp naming its creator, and reclaiming
it moves it aside with an atomic rename before checking that stamp, so of any
number of callers that judged it stale exactly one moves it and the rest see it
gone. Removing it by path would recreate, one level down, the very race the mutex
exists to prevent: the second caller's remove would land on the live mutex the
first had already taken, and an adoption and a clearing would run on one lock
file at once.
**Every liveness question is asked about the recorded process, never about its
number.** `kill(pid, 0)` only says that *something* holds that pid, and a host
recycles pids: after a driver is killed, an unrelated later process can inherit
its number and keep a dead run's lock refusing every start for as long as that
stranger lives — the wedge stale-lock recovery exists to prevent. So a lock
record and a background run state both stamp the creation time the host reports
for the process they name (`pidStart`, and `strykerPidStart` for the Stryker
group leader), taken while that process is certainly alive, and a pid that exists
with a different creation time counts as gone. A group is judged through its
leader first: leader present with a matching stamp is a live run; leader present
with a different stamp means the pid was recycled, which a host may only do once
the number is free as a process group id too, so nothing of the recorded group is
left; leader gone while the group id still answers is that leader's orphaned
workers and only they. The stamp comes from `ps` in UTC, and on Windows, which
has no `ps`, from CIM through PowerShell as a UTC round-trip timestamp. A host
that can report neither, or a record written without a stamp, falls back to the numeric check —
never the other way round, since a run that might still be live must keep its
lock. `--preflight` and `:report` take no lock — they neither build nor write.

### 2.1 When the run is longer than the caller will wait

Attempt 5 ran `npm run mutation:dry-run` alone, with nothing else in the
command, and still did not finish: the wrapper stopped it at **119.4 s** with
`interrupted (parent-signal:SIGTERM)`, 90 s into an initial test run that had
not returned. That is not a tuning problem. The wrapper's budget is a constant
(`GRANT_EXEC_DEFAULT_TIMEOUT_MS`, 120 s, `src/core/tool-request-run.ts`), the
dry run executes the four pilot suites once **in a single process** — Stryker's
Jest runner runs in band, so their durations add rather than overlap — and
`admin-chain-edit.test.js` alone measured 172.8 s median in #1109. No
concurrency, coverage or timeout setting makes ≈ 3.5 min of serial Jest fit
into 2 min.

So the run is decoupled from the console that starts it:

| Command | What it does | Cost |
|---|---|---|
| `npm run mutation:dry-run:start` | Runs the preflight, clears the report directory, then starts the same dry run **detached** with its output in `.mutation/dry-run/run.log`, and exits. | ~1 s |
| `npm run mutation:dry-run:report` | Reads back what that run recorded. Exits 0 while it is still going. | Instant |

`:start` and `:report` exist for `mutation:smoke` and `mutation:pilot` too.
Two properties make this work where the foreground run did not. The detached
copy is spawned with `detached: true`, so it is a **session leader**: the
`SIGTERM` a wrapper sends its own process group on timeout never reaches it.
The flag is set on Windows too, where it takes the copy out of the initiating
console, so closing that console or killing its process tree leaves the run
alone. And its output goes to a file rather than to an inherited pipe, so there is no
pipe left to break when the caller stops reading.

This is one run, started by one explicit command. Nothing is scheduled,
repeated, or started on the harness's own initiative, and `--background` is
never passed to the detached copy, so a start cannot recurse.

A detached dry run is also the only one that **records** its numbers. A dry run
activates no mutant, so it writes no `mutation.json`; its mutant count and the
cost of one pass over the scoped suites exist only in the lines Stryker printed.
The detached copy's stdout *is* `run.log` — truncated by the `:start` that
spawned it — so that file is definitionally its own output, and the driver reads
the two numbers back out of it into `summary.json` (`dryRun.facts`,
`dryRun.cost`) and into the "Dry run" section of `summary.md`. A foreground dry
run wrote to the caller's console instead, and any `run.log` in the directory
belongs to some earlier background run; parsing it would publish another
invocation's mutant count as this one's, so a foreground run reports
`No cost projection:` and the reason rather than a number.

`:report` reports one of five things, and the distinctions are the point — this
pilot must never present a harness failure as a statement about the tests:

| Status | Meaning | Exit |
|---|---|---|
| `absent` | Nothing was started here. Not a claim about any run. | 1 |
| `running` | Alive and inside its own budget. Read it again. | 0 |
| `overdue` | Alive, but past the budget its own driver enforces, with nothing written — stuck, not slow. | 1 |
| `lost` | Gone, leaving no summary of its own. **No conclusion about the tests can be drawn from it.** | 1 |
| `finished` | Its summary exists; that summary, not this status, is the result. | as the run's |

A report **reads only**. It never prunes sandboxes, clears artifacts or writes,
because it is asked for precisely while a run may be live and doing all three
would destroy what it came to read. `finished` requires a summary carrying that
start's own run id (`MUTATION_PILOT_RUN_ID`, recorded in
`summary.json` as `environment.runId`) — matching on the mere presence of
`summary.json` would let a later foreground run's result be relayed as this
one's. That JSON is therefore the run's **completion marker, and it is written
last**: the driver writes `summary.md` first, so a `:report` that reads
`finished` can always print the report it promises. Written the other way round,
a poll landing between the two writes announces a finished run and prints
nothing, and a failed Markdown write would leave the JSON answering "finished,
passed" for good from evidence nobody can read. Should the Markdown be missing
anyway — removed from outside this harness — the report says so on stderr
instead of passing over it silently, and still relays the run's own judgements
and exit code. When there is no summary to relay, the last 20 lines of the run log are
printed instead, masked the same way every other artifact here is — the log path
named above them included, since `--out` may have been given as an absolute one.
An absolute `--out` outside the checkout, home and temp directories is masked as
`<out>` wherever it appears, in the summaries as well as the log tail. So is its
physical target when `--out` is a symlink, because Stryker and Jest report their
canonicalized working directory rather than the path they were given.

Options are passed through npm's `--`, e.g.
`npm run mutation:pilot -- --concurrency 4 --max-runtime-min 90`:

- `--concurrency <n>` — Stryker workers. Defaults to 2 (1 for `--dry-run`,
  which has a single test run to give them) and is capped at the host's
  available parallelism, which honours CPU affinity and container quotas. Other
  projects may share this host.
- `--max-runtime-min <n>` — wall-clock budget (default 180; 30 for `--dry-run`,
  which runs no mutant). On expiry the run's own detached process group is
  signalled, and only that group. Nothing else on the host is ever touched.
- `--timeout-ms <n>` — Stryker's per-test deadline baseline (default 60000, on
  top of `timeoutFactor: 2` applied to the measured dry-run time).
- `--coverage-analysis off|all|perTest` — default `off`; see §5 question 3.
- `--out <dir>` — default `.mutation` (gitignored). A start, a refusal and a
  report each print the `:report`/`:start` command for the directory the run they
  are talking about is using, `-- --out <dir>` included where it is not the
  default: the same command without it would read `.mutation/<label>`, where that
  run has written nothing.
- `--incremental` — off by default; see §7.

`stryker.pilot.config.mjs` is deliberately **not** a name StrykerJS discovers on
its own, so a bare `npx stryker run` in this checkout finds no configuration at
all and cannot start a repository-wide pass.

## 3. How a mutant reaches the executed code

263 of this repository's 316 test files import the compiled output
(`../dist/index.js`, `../dist/cli/admin.js`) and none imports `src/`. A mutant
in `src/*.ts` is therefore invisible unless it is compiled first. Four settings
make that true, and a fifth makes it provable:

1. **The sandbox starts with no `dist/`.** `dist` is gitignored and Stryker's
   sandbox honours `.gitignore`; it is also named in `ignorePatterns` so the
   guarantee does not rest on that. A stale build in the checkout cannot answer
   for a mutated source — if the sandbox build failed there would be nothing to
   import, and every scoped test would error rather than pass quietly.
2. **`buildCommand` runs `scripts/mutation-build.mjs`**, with the sandbox as the
   working directory. That wrapper runs the project's own compiler over the
   project's own `tsconfig.json` —
   `node <checkout>/node_modules/typescript/bin/tsc -p tsconfig.json --noEmitOnError false --declaration false --sourceMap false`
   — and then checks the result. The three compiler overrides are command-line
   only: the checked-in `tsconfig.json` keeps `noEmitOnError: true` for the real
   build, while the sandbox still emits JavaScript if the instrumented tree does
   not type-check. Declarations are off because declaration emit has diagnostics
   of its own that `// @ts-nocheck` does not suppress, and source maps because
   nothing in the test path reads them.

   Both the wrapper and the compiler are named by **absolute path in the
   checkout**, and that is load bearing. `Sandbox.init()` in
   `@stryker-mutator/core` 8.7.x is `fillSandbox()` → `runBuildCommand()` →
   `symlinkNodeModulesIfNeeded()`: the build runs *before* `node_modules` is
   linked into the sandbox, and `node_modules` is not part of the sandbox copy
   either. A sandbox-relative `node node_modules/typescript/bin/tsc` therefore
   fails with `MODULE_NOT_FOUND`, emits no `dist/`, and the run dies before a
   single mutant is tested — see §4. Resolving `tsc` from `PATH` instead would
   work only by accident: Stryker builds that `PATH` with `npmRunPathEnv()` at
   the *parent's* working directory, which would stop pointing at the checkout
   the moment that detail is corrected to use the sandbox.
   `npm run mutation:preflight` checks both absolute paths
   (`sandbox-compiler`, `sandbox-build-script`) before any mode starts Stryker.

   The working directory is still the sandbox, so `-p tsconfig.json` reads the
   sandbox's instrumented sources and emits the sandbox's `dist/`. Type
   resolution reaches the checkout's `node_modules` by the ordinary upward walk,
   because the sandbox lives under `tempDirName` inside the checkout; at test
   time the symlink is in place, so the compiled code loads `better-sqlite3` and
   the rest from the sandbox root.
3. **`disableTypeChecks` is a glob over the compiled sources, not `false`.**
   Stryker's instrumentation is not valid TypeScript: it assigns to its own
   `stryNS_*` / `stryCov_*` / `stryMutAct_*` function declarations and calls them
   with arguments they do not declare, so `tsc` reports TS2630, TS2345, TS7006
   and TS2554 for a file it instrumented. `--noEmitOnError false` does not rescue
   that — it decides whether JavaScript is *emitted*, never the exit code, and
   `tsc` still exits 2, which Stryker reads as a failed build (§4, attempt 3).
   Stryker's answer is to prepend `// @ts-nocheck` to the sandbox copies, which
   it does by default for exactly this reason; this configuration scopes it to
   `<checkout>/src/**/*.ts` — the only files `tsconfig.json` compiles — so the
   sandbox's test files stay byte-identical to the checkout's. The pattern is
   absolute because Stryker resolves it against the process working directory
   and matches it against absolute file names.

   The wrapper is the second line of defence, because that preprocessing is
   best-effort: Stryker logs a warning and leaves a file type-checked if it
   cannot parse it. So the wrapper accepts a non-zero `tsc` exit **only** when
   every mutated source emitted its `dist/` JavaScript *and* that JavaScript
   carries the instrumentation marker (`stryMutAct_`); anything else is a hard
   build failure naming the file. That check is also this harness's own
   evidence, recorded per run in `build.json` and rendered in `summary.md` under
   "Sandbox build": bounded counts of diagnostic codes, never compiler output or
   source text.
4. **`jest.enableFindRelatedTests` is pinned off.** Left at its default,
   Stryker asks Jest for the tests related to the mutated file; Jest walks the
   module graph, finds that no test imports `src/`, and runs **zero** tests —
   reporting every mutant as surviving. That failure is silent and looks exactly
   like weak tests, which is why it is pinned rather than left alone.
5. **The smoke check (§4) fails unless at least one mutant is actually
   detected.** That is the positive evidence that 1–4 held on this machine, on
   this Node, with this Stryker version.

The checkout is never mutated: `inPlace` is false, so unrelated dirty work in
the working tree is not at risk. All Stryker state lives under `.mutation/`.

## 4. The smoke check

`npm run mutation:smoke` mutates `src/core/tool-request-grant.ts:73-84` —
`normalizeCommand`'s declarations, its `flushPendingSpace` helper and the scan
loop header — and runs only `test/tool-request-grant.test.js`. Every statement
in that range is directly asserted by that suite's first cases ("trims and
collapses internal whitespace", "preserves whitespace inside quoted
arguments"), so a mutant that reaches the executed code is expected to die. The
check passes when all of:

- the Stryker run completed and exited zero (its initial dry run is part of
  that: Stryker refuses to continue when the unchanged tests fail);
- at least one mutant was Killed or Timed out;
- no mutant ended in `CompileError` or `RuntimeError`.

A surviving mutant is **reported, not failed on**. The bar is deliberately
"detection happens at all", because the thing on trial here is the harness. A
score is never an acceptance gate anywhere in this pilot: `thresholds.break` is
`null`.

> **Status on this branch: the smoke check has run and passed** (attempt 4), and
> **the dry run has run and passed** (attempt 6). Both halves of this slice's
> acceptance are therefore evidenced on this machine: a deliberately observable
> mutation was detected through the real build/test path, and the unchanged
> scoped suites pass under instrumentation. The dry run's mutant count and cost
> are in §6.
>
> **All six attempts below predate #1112 and ran the whole-file scope** (§1);
> attempt 6's dry run is therefore the whole-file one. The frozen ranges' own dry
> runs and the completed pilot run over them are in
> `docs/metrics/mutation-pilot-baseline.md` §4. The smoke range is unaffected
> either way — it has never been the pilot's scope.
>
> **Attempt 1** stopped at the preflight: `installed:@stryker-mutator/core` and
> `installed:@stryker-mutator/jest-runner` both failed and Stryker was never
> started. That was the §2 prerequisite, not a defect: the worktree had the pins
> but no `node_modules` entry for them.
>
> **Attempt 2**, after `npm install` in the worktree, got past the preflight and
> failed inside Stryker in 1.7 s: `Sandbox.runBuildCommand` could not find
> `node_modules/typescript/bin/tsc` in the sandbox (`MODULE_NOT_FOUND`) while
> the checkout's compiler was present. No report was written, so the run was
> classified `interrupted (no-report)` and `mutation:dry-run` never ran. **That
> was a harness defect, now fixed** — the sandbox has no `node_modules` at build
> time, so the build command names the compiler by absolute checkout path (§3
> item 2), and the preflight's new `sandbox-compiler` check verifies that exact
> path up front.
>
> That attempt's `summary.md` also listed "no mutants were generated in the
> smoke range" and "no mutant was detected" beside the interruption. Those
> readings were wrong and are no longer produced: an interrupted run now reports
> only that it did not complete, because a run that never reached the mutants
> says nothing about the pilot suites. Do not read any statement about scope,
> coverage or detection out of a `no-report` summary.
>
> **Attempt 3** got past the preflight and past the `MODULE_NOT_FOUND`: the
> compiler ran, and failed in 4.0 s with 15 TypeScript errors in
> `src/core/tool-request-grant.ts` — TS2630 "Cannot assign to `stryNS_9fa48`
> because it is a function", TS2554 "Expected 0 arguments, but got 3", TS7006,
> TS2345 — all of them about Stryker's own instrumentation. `tsc` exited 2, so
> `Sandbox.runBuildCommand` failed, no report was written, and the run was again
> classified `interrupted (no-report)`. **That was a harness defect, now
> fixed**: `disableTypeChecks` was `false`, which switched off the `// @ts-nocheck`
> preprocessing Stryker performs by default precisely because instrumented code
> does not type-check (§3 item 3). The belief that `--noEmitOnError false`
> covered this was wrong — it changes the emit, not the exit code. The same fix
> added `scripts/mutation-build.mjs`, so a residual diagnostic degrades to a
> warning instead of ending the run, and only when the mutated sources
> provably reached `dist/` as instrumented JavaScript.
>
> **Attempt 4 ran the smoke check end to end and it PASSED** — the evidence §3
> and §5 were waiting for. Node v22.6.0, Stryker 8.7.1, jest-runner 8.7.1, Jest
> 29.7.0; 75 s wall, concurrency 2; the sandbox build exited 0 with no
> diagnostics and `src/core/tool-request-grant.ts` → `dist/core/tool-request-grant.js`
> recorded as emitted **and** instrumented. 15 mutants in the smoke range: 13
> Killed, 1 Timeout, 1 Survived (score 93.33%), 0 CompileError, 0 RuntimeError,
> 0 with no coverage. The surviving mutant is `BooleanLiteral` at
> `tool-request-grant.ts:76` (`let pendingSpace = false` → `true`); it is
> reported, not failed on (see the bar above), and it is a real observation
> about that suite rather than a harness problem — every other mutant in the
> same range died.
>
> **The same command's `mutation:dry-run` did not finish, and that was not a
> Stryker failure.** All three commands had been chained into one invocation
> (`mutation:preflight && mutation:smoke && mutation:dry-run`); the wrapper
> running them hit its own command timeout, killed the shell and stopped reading
> the pipe. Stryker inherits that console, so its next write failed and it exited
> 1 after 179 s. The driver filed the run as `complete (exit:1)` — a statement
> that reads as "the pilot suites failed" about a run nobody had been listening
> to. **That was a harness defect, now fixed**: the driver watches the streams it
> and Stryker share, survives losing them, and classifies that case as
> `interrupted (console-closed:EPIPE)`, which `smokeVerdict` already refuses to
> draw any conclusion from. `summary.md` says so in words as well as in the
> reason code. Nothing is known about the dry run from that attempt — not the
> mutant count, not whether the four scoped suites pass under instrumentation.
>
> The narrow case is the one that classification turns on: losing the console
> *after* Stryker has already exited 0 with its report written is **not** an
> interruption, and that run stays `complete (passed)`. `summary.md` notes the
> loss there too, but as what it is — output missing from the log — rather than
> repeating a warning that would contradict the result the same file carries.
>
> **Attempt 5** ran `npm run mutation:dry-run` alone and was stopped at 119.4 s
> by the caller's own 120 s budget, with `interrupted (parent-signal:SIGTERM)`,
> 90 s into an initial test run that had not returned. Nothing is known about
> the tests from it either. That attempt is why §2.1 exists: the wrapper's budget
> is a constant and the scoped suites take longer than it, so the run had to stop
> depending on the console that started it rather than be tuned to fit it.
>
> **Attempt 6 ran the dry run end to end and it PASSED.** Started detached with
> `npm run mutation:dry-run:start` and read back with
> `npm run mutation:dry-run:report`, on commit `74be9fb4` with a clean worktree.
> Node v22.6.0, Stryker 8.7.1, jest-runner 8.7.1, Jest 29.7.0; concurrency 1 of 8
> available, `coverageAnalysis: off`, load average 4.11/2.99/2.98 → 2.88/2.90/2.94.
> The sandbox build exited 0 with **0** diagnostic lines, and both mutated
> sources were recorded as emitted **and** instrumented —
> `src/core/chain-linear.ts` → `dist/core/chain-linear.js` and
> `src/core/tool-request-grant.ts` → `dist/core/tool-request-grant.js`. Stryker
> found 2 of 716 files to mutate and instrumented them with **742 mutants**, then
> `Initial test run succeeded. Ran 180 tests in 3 minutes 1 second (net 179927
> ms, overhead 1387 ms)`. Wall time 187.1 s, `complete (passed)`, exit 0.
>
> Two things follow, and they are the evidence §5 and §6 were waiting for. All
> four scoped suites — including the three `runAdmin` ones — pass unchanged
> inside the instrumented sandbox, so the ESM and HOME-isolation configuration
> holds for them and not only for the pure suite. And the whole-file scope now
> has a measured cost, which is §6's problem rather than this section's.
>
> Attempts 2 and 3 were killed before Stryker could honour `cleanTempDir`, each
> leaving a full copy of the checkout under `.mutation/stryker-tmp`. The driver
> now prunes sandboxes that have been untouched for an hour before it starts a
> run (§7); attempt 6 pruned one and reported it.
>
> The sequence that validates this section is `npm install` in the worktree,
> then `npm run mutation:preflight` (expect all checks `ok`, including
> `sandbox-compiler` and `sandbox-build-script`), then `npm run mutation:smoke`,
> then `npm run mutation:dry-run:start` followed by
> `npm run mutation:dry-run:report` — **each as a separate command** (§2).

## 5. The questions #1110 §5 required this slice to answer

1. **Can mutants in `src/*.ts` reach tests that import `dist/`?**
   By construction, yes — §3 items 1–4 are the mechanism. The compiled tree is
   built from the instrumented sandbox sources on every run, with type checking
   disabled for them (instrumented TypeScript does not type-check) and the
   emit verified per mutated file. **Confirmed end to end** by attempt 4 (§4):
   13 of 15 mutants in `src/core/tool-request-grant.ts:73-84` were killed by
   `test/tool-request-grant.test.js`, which imports `../dist/`. A mutant that
   never reached the compiled output could not have been killed by it, and a
   sandbox that had reused a stale `dist/` would have killed none.
2. **Does the Jest runner support this `--experimental-vm-modules` ESM setup
   and the `globalSetup`/`setupFiles` HOME isolation (#1063)?**
   The configuration addresses both: `testRunnerNodeArgs:
   ['--experimental-vm-modules']` (and the same flag appended to `NODE_OPTIONS`
   for the whole process tree), and the Jest configuration handed to the runner
   is the project's own block read out of `package.json` — `globalSetup`,
   `globalTeardown` and `setupFiles` come along unchanged, so the run gets the
   test-owned HOME. Without them `test/helpers/test-home-setup.js` throws
   loudly rather than reading the operator's real home, which is the intended
   failure mode. **Confirmed for the pure suite** by attempt 4: had either the
   ESM flag or the HOME isolation been missing, every mutant would have ended in
   `RuntimeError` and none did. **Confirmed for the three `runAdmin` suites** by
   attempt 6 (§4): the dry run executed all four scoped suites inside the
   instrumented sandbox and all 180 tests passed. A missing ESM flag or a
   `test/helpers/test-home-setup.js` that could not find its HOME would have
   failed the initial test run outright, and Stryker refuses to continue past
   one that fails.
3. **Is per-test coverage attributed for `runAdmin` cases, and does anything run
   in a child process the tool would miss?**
   Not assumed. `coverageAnalysis` defaults to **`off`**, where every mutant
   runs the whole scoped selection and no attribution is needed. `perTest` is
   available behind `--coverage-analysis perTest`, but its scores must be
   compared against an `off` run before being used as evidence: an unattributed
   test appears as "no coverage", which is indistinguishable from a real
   coverage gap and would understate detection. Independently of the setting,
   #1110 §5 already records what is outside the observable boundary — the
   concurrent writer and sabotage hooks in `admin-chain-edit.test.js`
   (`:604`, `:731`, `:1215`, `:1298`, `:1457`, `:1511`, `:1559`) run in child
   Node processes, and the fake `gh`, `/bin/sh` and `git` processes are
   fixtures, not mutated code. Preservation for those cases is argued from the
   assertions, never from a mutation score.

When a run answers these, the `summary.json` it writes carries `killedByTest`
and `coveredByTest` as **separate** per-test-file counts, which is what #1110
§7 item 4 needs: a mutant a candidate suite killed before must still be killed
by it, and one it now only covers is a lost detection even when another test
kills it.

## 6. Cost, and what to do when it does not fit

**This section measures the whole-file scope — the two accepted sources taken
entire, 859 + 288 source lines — which is what `mutation:pilot` ran until #1112
narrowed it (§1).** It is the historical measurement that forced the narrowing,
not a description of what the commands run today; the active frozen ranges and
their own cost are in `docs/metrics/mutation-pilot-baseline.md` §2 and §4.
Attempt 6 measured the whole-file scope (§4):

| Quantity | Measured | Where it comes from |
|---|---|---|
| Mutants instrumented | **742** | `Instrumented 2 source file(s) with 742 mutant(s)` |
| One pass over the four scoped suites | **181.3 s** (179 927 ms net + 1 387 ms overhead), 180 tests | `Initial test run succeeded…` |
| Dry-run wall time | 187.1 s | the run's own `summary.json` |

**The whole-file scope does not fit a bounded run.** With `coverageAnalysis: off`
every mutant runs the whole scoped selection, so an undetected mutant costs one
full pass: 742 × 181.3 s is **≈ 37 h serial**, ≈ 18.7 h at concurrency 2 (the
default) and ≈ 4.7 h at concurrency 8 — against a default wall-clock budget of
180 minutes. That is this slice's answer to "does it fit", and the answer is no.

Three qualifications, because a figure like that is easy to misuse in either
direction. It is a *reference* cost and not a measurement — no run has ever
activated a mutant over the whole-file scope — because Stryker stops a mutant's test run at the
first failing test, so a killed mutant usually costs less than a full pass,
while a timed-out one costs more (up to `timeoutMS` plus `timeoutFactor` × the
measured pass). 742 is the
count Stryker instruments, which under `coverageAnalysis: off` is also the count
it tests, since nothing is filtered by coverage. And the four suites run **in
band** under Stryker's Jest runner, so their durations add rather than overlap —
the 181.3 s is already that sum, not the parallel wall time `npm test` shows.
The driver records all of this per run in `summary.json` under `dryRun.cost`,
with its `basis` stated in the same object, so the assumption travels with the
number.

**So slice 4 must narrow the scope before it measures, and the narrowing is
constrained.** Per #1110 §5 the only allowed reduction is a narrower line range
*inside the same two files* — for example `planLinearChainEdit` and
`verifyLinearChainReadBack` in `chain-linear.ts` — stated explicitly, with the
same range used for both halves of any before/after comparison.
`assertScope()` already permits exactly this and nothing else (§1).
**#1112 made that narrowing, and it took two attempts** — both measured, neither
guessed. Its first freeze took `verifyLinearChainReadBack` whole together with
`grantStatus` and `grantMatches`; its own dry run instrumented **137 mutants**
over 116 lines, which the cost gate in
`docs/metrics/mutation-pilot-baseline.md` §4 refused. The freeze that stands is
`src/core/chain-linear.ts:329-359` and `src/core/tool-request-grant.ts:237-244`,
stated with the rest of the run identity in that report.
The 742-mutant figure above stays what it is: the measured cost of the
whole-file scope, and the reason the narrowing exists. Do not swap
the test files, do not drop a candidate suite from the evidence, do not raise
concurrency past what the host can spare to make the arithmetic work, and do not
widen the scope to make a number look better. The smoke range is the worked
example of a range that does fit: 15 mutants, 75 s (§4).

## 7. Reports, retention and what never leaves the machine

- Everything the harness writes goes under `.mutation/` (gitignored): the
  Stryker sandbox, the generated run spec, the sandbox build record
  (`build.json`), and the raw `mutation.json` / `mutation.html`.
- **That "gitignored" is checked with Git, not by reading `.gitignore`.** A
  `.gitignore` is a program: a later `!` rule re-includes what an earlier one
  excluded, and a path already in the index is not ignored at all — so a line
  that reads `.mutation/` proves nothing on its own. The preflight's
  `reports-ignored` check therefore asks `git check-ignore` (over `--stdin`,
  which is the only form that takes `-z`) about each raw artifact a run writes
  — every mode's `mutation.json`, `mutation.html`, `build.json`,
  `run-spec.json`, `run.log`, `run-state.json`, the incremental state file that
  mode would write under this invocation's settings (§7), plus the lock and
  every file Stryker would copy restated inside a `sandbox-*` copy — and
  passes only when Git excludes every one of them. That list comes from
  Stryker's own `ProjectReader`, not `git ls-files`: Stryker copies untracked
  files too, and a tracked-files-only probe would never ask about them. It is
  only a fallback: when Stryker is not installed the `installed:` check fails,
  and when it is installed but its reader gives no answer the `sandbox-inputs`
  check fails, so neither case can certify the checkout. The reader is loaded
  after Stryker's package entry, because loading it directly hits an import
  cycle in Stryker and fails before it reads anything. One representative sandbox
  file is not enough: a rule naming only that file, or a later `!*.ts`, would
  leave the copied source committable while the representative read as
  ignored. When the sandbox directory itself is excluded, Git tests it as a
  leading directory of every such path and they all pass together. Files
  only, and deliberately: a directory-only pattern matches a bare `.mutation`
  just when Git can see it *is* a directory, and at preflight time nothing has
  been created yet. Exit 1 — "none of these are ignored" — is an answer and
  fails the check; no answer at all (no Git, not a work tree) also fails it,
  because certifying a source-bearing report as safe without evidence is the
  mistake worth failing on. An `--out` that resolves outside this work tree
  (symlinks followed) is the one exception: those paths cannot be committed to
  this repository and `git check-ignore` would reject the whole batch for them,
  so they are left out of the question and counted as covered — while the fixed
  run lock, which is always in the tree, is still asked of Git.
- A report directory belongs to **one** run: the driver clears the previous
  run's artifacts before it starts Stryker, so a run that dies early can never
  be summarized — or given a smoke verdict — from the last run's report. A
  detached run's `run-state.json` and `run.log` are written by the `:start` that
  spawned it and are deliberately *not* in that cleared set, so the copy does not
  erase the record of itself; `environment.runId` is what ties the two together.
  The copy also writes `run-state.json` itself once it holds the lock, when no
  record for its run id is there yet, so a `:start` killed between the spawn and
  its own write still leaves a run `:report` can find.
- The raw report embeds **whole source files** and absolute sandbox paths. It is
  never published. `summary.json` / `summary.md`, written beside it, are the
  bounded sanitized form: checkout, home and temp paths are masked with the same
  helpers `scripts/test-cost-baseline.mjs` uses, mutant lists are capped at 20
  entries with the omitted count stated, and replacements are truncated to 80
  characters. A replacement is source text and can hold the `|` that ends a
  table cell or the backtick that ends a code span, so every value rendered into
  a `summary.md` table is escaped: an unescaped one would split its row and the
  published table would stop parsing. Only those are meant to be quoted in a
  checked-in report. Because they are the only publishable artifacts, both
  record the settings that change what a verdict means — the per-mutant
  deadline's parts, `timeoutFactor` (`environment.timeoutFactor`) and the
  additive `--timeout-ms` baseline (`environment.timeoutMs`; Stryker's deadline
  is `timeoutFactor` × the covering tests' dry-run time + `timeoutMS` +
  overhead, not `timeoutMS` alone) — and whether `--incremental` reused
  earlier verdicts (`environment.incremental`) — beside the concurrency and
  coverage analysis. A dry
  run's `dryRun` block is the one part read back out of `run.log` rather than
  out of a Stryker report; every field in it is an integer Stryker printed, so
  there is no path or source text in it to mask.
- **No reporter uploads anything.** The `dashboard` reporter is not configured,
  and the driver strips `STRYKER_DASHBOARD_API_KEY` from the run's environment
  so a host-level key cannot turn a local run into a publication.
- `cleanTempDir` is on, so the sandbox is removed after an orderly run. A run
  that is killed first never gets to, and each abandoned sandbox is a whole copy
  of the checkout, so the driver prunes them at the start of the next run. Only
  `sandbox-*` directories under this harness's own `.mutation/stryker-tmp` are
  considered, and only after an hour untouched. Two things keep a live sandbox
  from being pruned: the ownership lock (§2), which means no other run of this
  harness is in one while the pruning happens, and the age, since a run in
  progress writes into its sandbox continuously.
- Until it is pruned, an abandoned sandbox is invisible to the project's own
  Jest run: `package.json` sets `testPathIgnorePatterns` and
  `modulePathIgnorePatterns` to `<rootDir>/\.mutation/` and, because `--out`
  moves the sandbox with it, to `<rootDir>/(.*/)?stryker-tmp/sandbox-[^/]*/`
  for a sandbox under any in-tree output directory. So `npm test` neither
  collects the sandbox's instrumented test copies nor indexes its `package.json`
  as a duplicate module. Both rules are anchored at `<rootDir>`, and Stryker runs
  Jest with the sandbox as its root, so they never hide the sandbox's own tests
  from a mutation run.
- **Incremental mode is off by default.** It reuses results from a previous run,
  which is exactly wrong for a before/after comparison on a changed tree;
  `--incremental` exists for iterating on the harness itself and must not be
  used for either half of a comparison. When it is used, the state file is
  `.mutation/<mode>/incremental/<identity-digest>.json` — one file per mode
  *and* per run identity: the mutation scope, the test selection,
  `coverageAnalysis`, `timeoutMS`, `timeoutFactor` and `concurrency`. A single
  file under
  `.mutation/` would be reused across modes, and with `coverageAnalysis: off`
  there is no coverage matrix for Stryker to notice the changed test selection
  with: a pilot run could keep a smoke survivor without ever running the three
  extra suites, and a smoke run could report kills that only a pilot-only test
  made. The deadline is in the digest for the same reason: Stryker counts a
  `Timeout` as a **detection**, so a mutant classified `Timeout` under a short
  `--timeout-ms` would otherwise stay counted as detected after the deadline is
  raised, without ever being executed under it. `--concurrency` is in the digest
  as the other half of that deadline: worker contention on these
  process-spawning suites is what pushes a slow mutant past it, so a `Timeout`
  recorded at eight workers must not be inherited by a one-worker run in which
  the same mutant would have survived. The inherited Jest configuration and the
  executing toolchain are in the digest too: the Node version, the installed
  `@stryker-mutator/core`, `@stryker-mutator/jest-runner`, `jest` and
  `typescript` versions, and content hashes of `stryker.pilot.config.mjs`,
  `scripts/mutation-build.mjs` and `tsconfig.json`. Stryker reuses a status
  whenever source and tests are unchanged, so without them a rerun after an
  upgrade or a harness edit would inherit verdicts the new tools never produced
  while the summary recorded only the versions installed now.
- The preflight's `reports-ignored` check asks Git about the **actual**
  incremental path for each mode under the settings of the invocation at hand,
  not a placeholder inside that directory. `git check-ignore` answers per exact
  pathname, so a `.gitignore` that re-included the deterministic digest name
  while leaving a placeholder ignored would otherwise pass the check with a
  source-bearing report still committable.

## 8. Versions

| Package | Pinned in `package.json` | Why |
|---|---|---|
| `@stryker-mutator/core` | `^10.0.0` | Moved from `^8.7.0` by #1185 to clear the audit findings the 8.x dependency chain carries (§8.1). |
| `@stryker-mutator/jest-runner` | `^10.0.0` | Released in lockstep with core and peer-depends on it, so it moves with core; a test pins the two to one version in both `package.json` and `package-lock.json`. |

The implementation run had no network access, so the pin could not be checked
against the live registry or the published documentation. The preflight
therefore verifies compatibility **from the installed packages themselves**:
`npm run mutation:preflight` reports each package's resolved version and
compares the running Node against the `engines.node` range that package
declares. It does the same for the `@babel/core` the instrumenter resolves,
whose range is stricter from 10.x (§8.1). It fails on an unsupported version
and reports (rather than guesses at) a range it cannot parse. The `pinned:*` checks likewise compare each
installed version against the range `package.json` pins, so a stale
`node_modules` (an 8.x core under the `^10.0.0` pin, say) fails the preflight
instead of starting a long run. Run it after `npm install`, and confirm the
pin against
<https://stryker-mutator.io/docs/stryker-js/configuration/> and
<https://stryker-mutator.io/docs/stryker-js/incremental/> before slice 4 takes
any measurement.

### 8.1 Upgrade from 8.7.1 (#1185)

**Why.** `npm audit` on 2026-09-25 (the #1185 baseline) reported findings
whose only fix was a major upgrade to `@stryker-mutator/core@10.0.0` and
`@stryker-mutator/jest-runner@10.0.0`. The lockfile at `12e7cc54` shows why no
lockfile refresh inside 8.x could clear them: 8.7.1 pins them itself.

| Advisory chain (8.7.1 lockfile) | Pinned by |
|---|---|
| `ajv` 8.17.1 | `@stryker-mutator/core` 8.7.1: `ajv ~8.17.1` |
| `@inquirer/prompts` 6.0.1 → `@inquirer/editor` 3.0.1 → `external-editor` 3.1.0 → `tmp` 0.0.33 | `@stryker-mutator/core` 8.7.1: `@inquirer/prompts ^6.0.0` |
| `@babel/core` 7.25.9 | `@stryker-mutator/instrumenter` 8.7.1: `@babel/core ~7.25.2` |

**Choice.** `^10.0.0` for both packages: the version the audit itself names as
the fix. The implementation run had no registry access, so it could not tell
whether a later 9.x release would also clear the chain. It took the version
the audit already vouches for rather than guessing at a smaller jump. Both
packages keep one version because the runner peer-depends on core.

**What had to change in the harness: nothing that alters a run.** The
configuration uses only long-standing options (`buildCommand`, `mutate` line
ranges, `jest.projectType: 'custom'`, `jest.config`,
`jest.enableFindRelatedTests`, `disableTypeChecks`, `ignorePatterns`,
`incremental`/`incrementalFile`, `testRunnerNodeArgs`, `timeoutMS`,
`timeoutFactor`, the four reporters). The sandbox build names the wrapper and
the compiler by absolute path, so it does not depend on the order in which
`Sandbox.init()` builds and links `node_modules` (see §3). The mutators, scope,
deadlines, concurrency and thresholds are unchanged, and no mutator was
disabled. Existing incremental state is never reused across the upgrade,
because the Stryker and Jest runner versions are part of the incremental
identity (§7).

**The one internal contract.** The preflight's `sandbox-inputs` check loads
Stryker's own `ProjectReader` from `dist/src/fs/project-reader.js` after the
package entry, and calls `new ProjectReader(fs, logger, options)
.resolveInputFileNames()`. That is not public API. If 10.x moved or reshaped
it, the check fails and names the cause: `sandboxInputFiles` returns null, so
the preflight blocks the run. It never silently falls back. The default suite
exercises it against the installed package
(`test/mutation-pilot-harness.test.js`, "the sandbox files asked about are the
ones Stryker copies"), so `npm test` after `npm ci` is the fixture check for
that contract.

**Node prerequisite: 22.18 or later on the 22 line, or 24.11 or later.** This
is the one contract 10.x added that the harness had to adapt to. Stryker 10
declares `engines.node` `>=22.0.0`, but its instrumenter now depends on
`@babel/core ~8.0.0` (8.0.6 in the lockfile), and every Babel 8 package
declares `^22.18.0 || >=24.11.0`. Checking Stryker's own range therefore
certified the operator host's Node 22.6.0, which Babel 8 does not support. The
preflight now also checks `node-range:@babel/core` against the `@babel/core`
the instrumenter actually resolves (`INSTRUMENTER_PARSER_CHAIN`, resolved the
way Node resolves it). That is the nested 8.x, not the checkout's hoisted
`@babel/core` 7.29.7, which is Jest's. An unsupported Node now fails the
preflight with the range named, before any run starts. CI's `node-version: 22`
resolves to a current 22.x, which is inside the range. Only the harness needs
this Node; the default suite does not load the instrumenter.

**Install.** The loop's dependency sync regenerates `package-lock.json` only
and never installs. It also never fired here, because the `^10.0.0` pin was
already inside a wip commit, so the first operator `npm ci` failed against a
lockfile still on 8.7.1. The operator then ran a real install, recorded as
`a2dbecb4` ("install Stryker 10 and refresh audit lockfile"). The lockfile now
locks `@stryker-mutator/core`, `jest-runner`, `instrumenter`, `api` and `util`
all at 10.0.0. From here on, `npm ci` is the right command again. That
install's `npm` also reformatted the `workspaces` and `jest` arrays in
`package.json` onto several lines. The values are unchanged.

**Advisory chain after the upgrade (lockfile at `a2dbecb4`).**

| 8.7.1 | 10.0.0 |
|---|---|
| `ajv` 8.17.1 (`~8.17.1`) | `ajv` 8.20.0 (`~8.20.0`) |
| `@inquirer/prompts` 6.0.1 → `@inquirer/editor` 3.0.1 → `external-editor` 3.1.0 → `tmp` 0.0.33 | `@inquirer/prompts` 8.7.2 → `@inquirer/editor` 5.3.3 → `@inquirer/external-editor` 3.0.5; `external-editor` and `tmp` are no longer in the tree |
| instrumenter `@babel/core` 7.25.9 (`~7.25.2`, hoisted) | instrumenter `@babel/core` 8.0.6 (`~8.0.0`, nested); the hoisted `@babel/core` 7.29.7 belongs to Jest 29 |

Every package the 8.7.1 advisories named has either left the tree or moved
off the version 8.7.1 pinned it to. After the install, the operator's
`npm audit` still reported **residual dev-only findings**. The Issue #1185
comment that goes with `a2dbecb4` records them. The implementation run has no
registry access, so it could neither rerun `npm audit` nor read that comment.
The advisory IDs, and whether any of them is still on the Stryker chain, are
therefore recorded there and not repeated here. `npm audit --omit=dev` cannot
be moved by this change, because both Stryker packages are devDependencies.
Findings outside the Stryker chain are out of scope for this Issue, which makes
no Jest, TypeScript, n8n or workflow migration.

**Smoke on 10.x: PASSED, and the same mutant population.** `npm run
mutation:smoke` on commit `2202ae51` (worktree dirty with the install), Node
v24.19.0, Stryker 10.0.0, jest-runner 10.0.0, Jest 29.7.0; concurrency 2 of 8,
`coverageAnalysis: off`; 73.7 s wall, `complete (passed)`. The sandbox build
exited 0 with 0 diagnostic lines, and `src/core/tool-request-grant.ts` →
`dist/core/tool-request-grant.js` was recorded as emitted **and** instrumented.
15 mutants: 13 Killed, 1 Timeout, 1 Survived (score 93.33%), 0 CompileError,
0 RuntimeError. By location, mutator and replacement:

| Line:col | Mutator | Replacement | 10.x status |
|---|---|---|---|
| 74:16 | StringLiteral | `"Stryker was here!"` | Killed |
| 76:22 | BooleanLiteral | `true` | Survived |
| 79:41–82:4 | BlockStatement | `{}` | Killed |
| 80:9 | ConditionalExpression | `true` | Killed |
| 80:9 | ConditionalExpression | `false` | Killed |
| 80:9 | LogicalOperator | `pendingSpace \|\| result.length > 0` | Killed |
| 80:25 | ConditionalExpression | `true` | Killed |
| 80:25 | EqualityOperator | `result.length >= 0` | Killed |
| 80:25 | EqualityOperator | `result.length <= 0` | Killed |
| 80:54 | StringLiteral | `""` | Killed |
| 81:20 | BooleanLiteral | `true` | Killed |
| 83:19 | ConditionalExpression | `false` | Killed |
| 83:19 | EqualityOperator | `i <= command.length` | Killed |
| 83:19 | EqualityOperator | `i >= command.length` | Killed |
| 83:39 | UpdateOperator | `i--` | Timeout |

The totals and every status count match 8.7.1's attempt 4 (§4). So does the
one mutant that identifies itself there: the survivor is the same
`BooleanLiteral` at line 76 (`let pendingSpace = false` → `true`). Attempt 4
kept only its summary, not a per-mutant report, so the other 14 cannot be
matched one by one. Nothing in the counts suggests a tooling-induced
difference. No scope, mutator, deadline or threshold was changed to get this
result.

**Still not re-measured on 10.x:** the dry run and the frozen-range pilot run.
The figures in §4 (attempt 6), §6 and `mutation-pilot-baseline.md` are
measurements *of 8.7.1*. A before/after comparison must not pair an 8.7.1 half
with a 10.x half without stating the toolchain change. Any new pilot
measurement starts from a fresh baseline, and incremental state from 8.7.1 is
never reused (§7).

`@stryker-mutator/typescript-checker` is deliberately **not** used: it discards
mutants that do not type-check, which would change the mutant population between
a "before" and an "after" run whenever unrelated types move. The same
configuration must be used for both halves of any comparison.

## 9. Limitations

- Mutation evidence shows whether a change is *detected*. It is not proof that a
  test is redundant, and equal scores never justify deleting one.
- The harness observes only code that runs inside the Jest worker. Assertions
  whose subject is a child process, a real lock holder or a second writer are
  outside it; #1110 §4 lists them, and they are validated by argument, not by
  score.
- A mutant killed by a timeout is counted as detected by StrykerJS even though
  no assertion observed it. The per-test deadline is deliberately generous
  (`timeoutMS` 60000, `timeoutFactor` 2) so a loaded host manufactures as few of
  those as possible; `summary.md` reports `Timeout` separately from `Killed` so
  they can be read apart.
- The smoke range's 93.33% over 15 mutants of 12 lines of one file (§4) is
  evidence that the harness detects mutants, and nothing else: it is not a
  baseline and not a per-suite score. **No figure in this document is a mutation
  score for either pilot scope**, because no run described here activates a
  mutant in one — attempts 1-5 produced no result at all and attempt 6 was a dry
  run, which activates none. The baseline is slice 4's work and lives in
  `docs/metrics/mutation-pilot-baseline.md`, which carries the completed pilot
  run over the frozen ranges of both sources (38 mutants; 25 killed, 2 timed out,
  10 survived, 1 runtime error). Cite that file's own denominators and per-suite
  attribution, not this one's smoke figure.
- The 742 mutants and 181.3 s pass in §6 are a cost for the **whole-file scope**,
  which no longer describes what `mutation:pilot` runs (§1). Read as a run time
  they are also a projection from one measured pass rather than an observation,
  and §6 states the three assumptions it rests on. Cite them as the reason the
  scope was narrowed, with those assumptions attached — never as the cost of the
  frozen ranges, which measured 90 min 52 s (`mutation-pilot-baseline.md` §4.3).
