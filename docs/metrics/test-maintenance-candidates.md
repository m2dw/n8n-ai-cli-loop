# Test-maintenance candidates (Test Maintenance Pilot, slice 2)

Issue #1110. This is an analysis report. It changes no source file, test,
assertion, configuration or worker count, and it runs no mutation testing. It
maps the measured cost from slice 1 to the contract each costly suite protects,
and it selects a small, explicit scope for the opt-in StrykerJS harness
(slice 3) and the scoped mutation baseline (slice 4).

Every classification below is a candidate for later slices, not a decision to
change a test. Quality comes first. A test stays when it is uncertain whether
its contract would survive a change. Similar coverage, similar assertion syntax
or an equal mutation score is never evidence for deleting a test.

## 1. Reconciliation with the predecessor (#1109)

| Field | Value |
|---|---|
| Cost source | `docs/metrics/test-cost-baseline.md`: two complete Jest runs at `9b278b20`, **measured 2026-09-13 17:53–18:04 UTC** (4 workers, 334 s wall each, build 6.4 s kept apart) |
| Tree the matrix was written against | `456b231c`. Every line number, invocation fact, cost driver and history count in §3 was read there. |
| Tree this report is reconciled to | the branch's current inherited HEAD `96da7ad2` (merge of the updated #1109 branch, PR #1175). §3 line numbers and file sizes below were re-read there; see §1.1. |
| Cost granularity | per suite only (`endTime - startTime`, module load included). **Per-test cost is unknown.** Suites outside the measured top 20 have no ranked cost here and are not candidates. |
| Scope used | the 20 suites in §3. Their listed medians sum to 810.6 s of the ~1331 s summed suite time **as measured on 2026-09-13**. The 856 s and 937 s totals in `test-cost-baseline.md:37` are the 20 slowest suites of each run, chosen separately per run. Their mean (896.5 s) is not the 810.6 s of this fixed set, so they do not measure it. |

The accepted baseline gives enough evidence for this slice. No broader scope
was needed, and no requirement was added. Where this report estimates a process
count or a cost driver, it says so. Those figures come from reading the code,
not from a measurement.

### 1.1 The tree has moved since the measurement

**Every timing in this report is a 2026-09-13 observation at `9b278b20`. None
of it is a current measurement of `96da7ad2`, and this slice ran none.** The
repository changed substantially between the measured SHA and the inherited
HEAD, so the numbers below rank *what was measured then*, not what the suite
costs now.

`git diff --stat 456b231c 96da7ad2 -- src test` is 78 files: 35 under `src/`
and 43 under `test/` (fixtures included). The changed sources include
`src/handlers/review.ts` (+315/−16), `src/handlers/implementation.ts`
(+324/−57), `src/core/tool-request-run.ts` (+33/−0),
`src/core/outbox-effects.ts` (+23/−0), `src/cli/admin.ts` (+39/−6),
`src/core/verification-plan.ts` (+61/−2),
`src/registries/json-session-registry.ts` (+30/−23) and `src/index.ts`
(+189/−106). `test/loop-selection-adapter.test.js` was **deleted** with the
retired selector; nothing in this report proposes reinstating it.

What this changes, and what it does not:

| Claim | Status at `96da7ad2` |
|---|---|
| Per-suite medians and maxima in §3 | **Historical.** Valid as 2026-09-13 observations at `9b278b20`; **current cost is unknown** for every suite. |
| The ranking (which suite is costliest) | **Historical, and unverified now.** 18 of the 20 candidate suites are byte-identical between `456b231c` and `96da7ad2`, so their *relative* order is plausibly unchanged — but that is an inference from unchanged test code, not a measurement, and their production paths did change. |
| `codex-structured-review.test.js` (§3.6) and `admin-n8n-deploy.test.js` (§3.15) | **Changed** since the matrix was written. Each brought a case under host-starvation retry handling, which can only raise cost. Their listed medians are superseded; current cost unknown. See the per-section notes. |
| Line numbers in §3, §4 and §5 | **Re-read at `96da7ad2`** and corrected where they moved. |
| Total suite count, `dist/` import counts (§2) | **Re-counted at `96da7ad2`**: 316 test files, 263 importing `../dist/`. |
| Pilot scope (§5) | **Re-verified unchanged.** See below. |

**Pilot scope re-verification.** `git diff --name-status 456b231c 96da7ad2 --
src/core/chain-linear.ts src/core/tool-request-grant.ts
src/cli/chain-edit.ts src/stores/sqlite-chain-registry-store.ts
test/chain-linear.test.js test/admin-chain-edit.test.js
test/tool-request-grant.test.js test/admin-tool-request-grant.test.js`
returns nothing: both pilot sources, both pilot CLI/store dependencies and all
four pilot test files are byte-identical across the merge. The bounded scope in
§5 therefore still holds, and the §3.1/§3.9 suites' code-derived facts
(line numbers, invocation, cost drivers) carry over unchanged.

**What was deliberately not done here.** No suite was remeasured, no
benchmarking framework was added and no broad remeasurement was run. This is a
documentation slice; the issue forbids changing source, tests or live
configuration in it. The verification `PASS` results produced on this branch are
correctness signals, not performance measurements, and are not used as such
anywhere below. When slices 6–8 compare before and after, they must take both
measurements under comparable conditions (same command, worker count, host and
recorded load, as §7 item 6 requires) at a stated SHA — the 2026-09-13 numbers
here are not a usable "before" for a run on a later tree.

## 2. How to read the matrix

**Classes**

- **keep**: leave as is.
- **optimize**: make setup or process cost cheaper. Assertions and the
  production path stay unchanged.
- **move**: run in-process through `test/helpers/admin-cli.js` (`runAdmin`,
  #1018) or through a direct module call, instead of spawning a process.
- **consolidate**: merge cases, for example into a `test.each` table, keeping
  every asserted fact.
- **possibly remove**: only after an independent reviewer shows that the
  retained contract is asserted elsewhere at the same boundary.

**Mutation boundary** (as the harness would observe it; slice 3 must confirm)

- **in-process**: the code under test runs inside the Jest worker. That covers
  imports of `dist/index.js` and `runAdmin`. A mutant switched on in the
  worker can be observed.
- **spawned**: the assertion depends on `node dist/cli/*.js` running in a child
  process. Until slice 3 shows that the active mutant, and coverage, reach child
  processes, the harness cannot see these tests. A surviving mutant, or
  "no coverage", tells us nothing about them.
- **mixed**: part of each flow runs in a child process.

**Boundary facts that shape every mutation claim**

- 263 of the 316 `test/*.test.js` files at `96da7ad2` directly import
  `../dist/` (static `from`, `import()` or `require()`), and none imports
  `src/`. (At the measured `9b278b20`/`456b231c` tree it was 259 of 311; the
  ratio is unchanged.) Three more
  files only mention a `../dist/` path without importing it:
  `admin-session-preset.test.js` and `admin-issue-activation.test.js` build a
  CLI URL they spawn (spawned, not in-process), and
  `build-parent-child-workflow.test.js:1512` builds a deliberately nonexistent
  path. Those three are not in-process evidence. Mutants in
  `src/*.ts` only reach a test after a TypeScript build inside the mutation
  sandbox. `tsconfig.json` sets `noEmitOnError: true`, so a mutant that fails
  type-checking can stop the build.
- Jest runs as native ESM (`node --experimental-vm-modules`). Slice 3 must
  check that the harness's Jest runner supports this setup, rather than assume
  it.
- `runAdmin` has documented divergences from a spawned run
  (`test/helpers/admin-cli.js:37-57`): `finally` blocks run where a real exit
  would skip them; module-load constants are captured once; there is no handle
  reclamation by process death; `env` reaches children only through
  `spawnEnv()`. Any *move* must re-check these.

## 3. Candidate matrix (measured top 20)

**Read every "N s median / M s max" below as "measured on 2026-09-13 at
`9b278b20`".** They come from #1109's two samples and are historical; §1.1
explains why no figure here is a current cost of `96da7ad2`. Where a suite has
changed since, its section says so and its current cost is marked unknown.

Line numbers are for the inherited HEAD `96da7ad2`. History lists the issue
references in the file's tests and comments, plus
`git log --oneline --no-merges 96da7ad2 -- <file>` commit counts (merge
commits excluded; without `--no-merges`, for example, `admin-cli.test.js` shows
48 rather than 42). The commit subjects are generic
(`fix: implement issue #N` / `fix: apply review feedback for issue #N`), so the
number of review rounds is the best available signal of regressions caught
during review.

### 3.1 `admin-chain-edit.test.js`: 172.8 s median / 219.4 s max, 53 tests, **pilot**

- **Invocation.** In-process through `runAdmin` (`:29`, `:217-225`). A fresh
  SQLite registry is created per test (`:235-253`).
- **Cost driver (estimated).** `gh` is a Node script on `PATH` (`:44-174`), and
  every `gh` call is a new Node process. One apply issues roughly 12–20 calls.
  Many tests run two or three commands. The race and sabotage hooks start one
  more Node process that loads `dist/index.js`: `:604`, `:731`, `:1215`,
  `:1298`, `:1457`, `:1511`, `:1559`. Since the CLI itself is already
  in-process, CLI start-up is not the cost.
- **Production path.** `src/cli/chain-edit.ts` (1888 lines) →
  `src/core/chain-linear.ts` (`planLinearChainEdit` `:457`,
  `verifyLinearChainReadBack` `:796`) → `src/stores/sqlite-chain-registry-store.ts`
  (edit locks, accepted revision, aliases, frozen prefixes).
- **Protected contracts.**
  - `:277` argument handling
  - `:335` #1045 repository-scoped lock identity, including the rolling-upgrade
    case `:458`
  - `:525` chain new (preview is inert; apply accepts the graph and restores
    labels; alias races)
  - `:838` append/prepend and frozen prefixes
  - `:941` failure/recovery crash windows
  - `:1342` overlapping edits (lock contention, stale takeover, lost claim)
- **Unique here.** The *order* of GitHub, label and registry steps, and the
  recovery JSON. `test/chain-linear.test.js` has only the pure plan and
  read-back decisions; its header assigns step order to this suite.
- **History.** #791 (one implementation commit and 11 review-feedback commits),
  #1045 (1 + 2), #1018 (moved in-process), #788, #893. 12 test bodies carry an
  "issue #791 review" comment: `:319`, `:604`, `:693`, `:731`, `:878`,
  `:1010`, `:1044`, `:1170`, `:1215`, `:1457`, `:1511`, `:1559`. A 13th
  occurrence is the block comment `:1327` over the overlapping-edits
  `describe` (`:1342`).
- **Mutation boundary.** In-process for the edit flow. It is **mixed** for the
  seven hook tests above, because the concurrent writer runs outside the
  worker. The hook changes state; the code under test still runs in the
  worker.
- **Class.**
  - **Keep** every contract group.
  - **Optimize** the fake-`gh` process cost. For example, a cheaper stand-in
    that answers the same argv with the same durable state files. Test
    fixtures only; no production seam is required.
  - **Consolidate** at most the #1045 scope cases `:446`/`:487`/`:507` into a
    table. `:458` (rolling upgrade) stays on its own.
  - **Possibly remove:** none.
- **Benefit.** Highest in the repository *on the 2026-09-13 sample*: 172.8 s
  of the 1331 s summed suite time, about 13%. The suite is byte-identical at
  `96da7ad2` and so is its production path (§1.1), but its current cost is
  unknown and the share is not re-derived here. How much of that 13% an
  optimization actually recovers is likewise unknown until the fake-`gh` cost
  is measured rather than estimated.
- **Risk.**
  - Losing the proof that `gh` is resolved through `PATH`/`spawnEnv()`. Keep
    at least `:544` on the real spawned stand-in.
  - `:1511` must keep a real second process: it asserts the owner `pid`, and
    that a run blocked inside a provider call keeps its claim.

### 3.2 `review-dispute-default-path-e2e.test.js`: 62.0 s / 89.7 s, 23 tests

- **Invocation.** Handlers and `runNextPhase` run in-process. `claude`,
  `codex` and `gemini` are `sh` → `node test/helpers/fake-agent-cli.mjs`
  wrappers on `PATH`. `git`, `gh` and `npm` are answered by a substrate that
  replays captured real-checkout facts.
- **Cost driver (estimated).**
  - About 8 real `git` spawns per test in `beforeEach` (`:238-285`).
  - 2–5 fake-agent Node starts per case.
  - The hang case (`:1929`) must take ≥ 5 s.
  - Starvation retries go up to 3 attempts / 60 s per run.
- **Production path.** `src/core/phase-runner.ts`,
  `src/handlers/review.ts`, `src/handlers/implementation.ts`,
  `src/handlers/command-runner.ts`, `src/handlers/codex-structured-review.ts`,
  `src/handlers/review-reconsideration*.ts`, `src/core/review-dispute-*.ts`.
  The test file is unchanged in the merge, but `src/handlers/review.ts`
  (+315/−16) and `src/handlers/implementation.ts` (+324/−57) are the two
  largest source changes in it (§1.1). The suite's assertions are unchanged;
  its cost is not necessarily, and was not remeasured.
- **Protected contracts.**
  - `:1126` real codex/claude subprocesses and the D2 stop
  - `:1271` native `codex review` in a disabled session
  - `:1339` read-bounded reconsideration (#1085)
  - `:1628` Claude no-tools round trip
  - `:1787` negative paths, including `:1816` (reviewer killed mid-turn = operational failure)
  - `:1929` hang bounded by escalation (#1089)
  - `:2110` starvation classification must not swallow a broken fixture
    (`:2111`) or an external kill (`:2147`)
- **History.** #1072 (suite origin), #965, #1071, #1085, #1089, #1060, #897.
  11 commits.
- **Mutation boundary.** Mixed. The protocol runs in-process; agent answers
  come from child processes that run test fixtures, not production code.
- **Class.**
  - **Keep** the Codex and Claude lanes. They differ in argv, capture path and
    tool policy; parallel test names do not mean duplicates.
  - **Optimize.** Build the fixture repository once and copy it per test. Give
    `:1929`/`:2110` a setup without git or SQLite.
- **Benefit.** Unknown per test. The shared `beforeEach` git setup is paid by
  all 23 tests; the deliberate hang and starvation retries are not reducible.
- **Risk.** Tests that write to the checkout (e.g. `:1841`) need a private
  copy. Harness self-tests `:2110` guard against false passes on a starved
  host (see the host-starvation classification pattern) and must stay.

### 3.3 `run-one-phase-cli.test.js`: 53.2 s / 82.9 s, 33 tests

- **Invocation.** `execFileSync(node dist/cli/run-one-phase.js)` for 23
  cases. `beforeEach` builds a bare origin and pushes to it: 7 `git` spawns for
  every test, including the in-process ones.
- **Production path.** `src/cli/run-one-phase.ts`,
  `src/core/phase-runner.ts`, research handler/worktree
  (`src/handlers/worktree.ts`), SQLite stores.
- **Protected contracts.**
  - `:143` argument errors (exit code + JSON)
  - `:168` config errors
  - `:555` quota failure exits 0 with `delayed`/`notBefore` (#672)
  - `:798` report-only admission (#532)
  - `:402` refinement lock serialization (#869 review, in-process)
  - token-exchange deferral `:230`/`:313` (#217, #382, #869)
- **History.** 26 commits. #855, #672, #532, #869, #952, #955, #964.
- **Mutation boundary.** Spawned for the CLI cases; in-process for
  `:192`–`:461`.
- **Class.**
  - **Optimize.** Build the git origin only for the ~7 cases that run
    research.
  - **Keep** the real-CLI cases. This executable is what n8n calls, so
    stdout JSON and exit status are the contract.
  - **Consolidate** only the contextId-echo variants.
- **Benefit (estimated).** About 7 `git` spawns saved in each of the ~26 tests
  that do not run research. The real-CLI start-up cost stays.
- **Risk.** Low for lazy fixtures, provided a case that reaches research
  without being marked for it fails loudly rather than skipping the origin.
  A move to in-process is not proposed.

### 3.4 `admin-tool-request-direct-review.test.js`: 47.2 s / 63.0 s, 15 tests

- **Invocation.** Spawned `dist/cli/admin.js`. `initRepo` runs ~13 `git`
  calls per test (bare origin plus two pushes).
- **Production path.** `runToolRequestGrant` → `src/core/tool-request-run.ts`
  → `decideToolRequestContinuation` (`src/core/tool-request-continuation.ts`).
  `tool-request-run.ts` gained 33 lines in the merge (§1.1); the test file
  itself is unchanged.
- **Protected contracts.**
  - `:174` eligible direct-review route: `:175` review queued with no extra
    implementation pass; `:281` duplicate delivery refused, no second effect.
  - `:303` every fallback fails closed, over real git: `:329` unpushed,
    `:359` PR head mismatch, `:394` dirty outside the probe, `:407` run
    produced changes.
- **Overlap.** `test/tool-request-continuation.test.js` covers the same
  checks as a pure decision. It does **not** show that the real repository
  probes supply those facts.
- **History.** #722 (a single commit).
- **Mutation boundary.** Spawned.
- **Class.**
  - **Move** to `runAdmin`; no case asserts the process boundary.
  - **Keep** real git for `:175`, `:329`, `:359`, `:394`, `:407`.
- **Benefit (estimated).** One Node start-up per CLI call, but the ~13 `git`
  calls per test stay, so the gain is probably a small share of the suite's
  cost (47.2 s on 2026-09-13; current cost unmeasured).
- **Risk.** The four `runAdmin` divergences (§2) must be re-checked. The fallbacks whose only real input is a context field (`:351`,
  `:369`, `:385`) resemble the pure cases, but the admin path derives those
  fields itself. They are **not** removal candidates without that derivation
  being covered.

### 3.5 `admin-tool-request.test.js`: 39.2 s / 40.6 s, 50 tests

- **Invocation.** Spawned for every CLI call. `initRepo` plus extra inline git
  setup per resolve case. The help/list tests (`:153-313`) pay only Node
  start-up.
- **Production path.** `runToolRequestList`, `runToolRequestResolveCommand` →
  `src/core/tool-request-resolve.ts`, `resolveIssueRunCwd`.
- **Protected contracts.**
  - list JSON shape and partial-work fields (#390)
  - resolve: manual-done tiers, reject auto-requeue (#678), one-shot and stale
    replay (#674)
  - real branch-sync probes `:879-1197` (#379, #390)
  - worktree sessions `:1246` (#454/#455)
- **Overlap.** `test/tool-request-resolve-operation.test.js` covers the same
  decisions with scripted git results. It does not run the real branch/remote
  probes, list output or argv mapping.
- **History.** 30 commits: #299, #316, #379, #390, #454, #455, #674, #677, #678,
  #731, #732.
- **Mutation boundary.** Spawned.
- **Class.**
  - **Move** `:153`, `:173` and the argv refusals to `runAdmin`.
  - **Keep** the branch-sync probes and worktree cases on real git.
  - **Consolidate** candidates: `:682`/`:726`/`:781`/`:833` against
    resolve-operation `:285-335`, but only after confirming which SQLite
    facts each CLI case asserts.
- **Benefit (estimated).** Node start-up for the help/list/argv cases (the
  cheapest group). The resolve cases keep their git setup, so the gain is
  modest.
- **Risk.** A consolidation against the scripted-git suite could drop the
  argv mapping or the real probe input; each CLI case's SQLite assertions
  must be listed first. The `runAdmin` divergences apply to every move.
- **Note.** `runWithFakeGh` (`:26`) appears to have no call site. Removing it
  is tidy-up for a later slice, not a coverage change.

### 3.6 `codex-structured-review.test.js`: 37.8 s / 43.9 s (2026-09-13), 42 tests

- **Changed since the measurement.** This suite is one of the two candidates
  that moved between `456b231c` and `96da7ad2` (commits `20aebdd1`, `93565e48`,
  #1153). The change is test-harness hardening only: a
  `FIXTURE_COMPLETED_MARKER` that every `/bin/sh` fixture writes under `set -e`,
  and an `invokeUntilAnswered` that now retries an incomplete fixture once and
  throws when it recurs. No test was added or removed and no assertion was
  weakened; the retry can only *raise* cost on a loaded host. **The 37.8 s /
  43.9 s figures are superseded; the current cost of this suite is unknown.**
  Everything below was re-read at `96da7ad2`.
- **Invocation.** In-process `runCodexStructuredReview`. Real `/bin/sh`
  fixtures run through the production `bothStreamsCommandRunner`.
- **Cost driver (estimated).** Deliberate deadlines: `:879` (750 ms against a
  5 s sleep), and `:901` "a CLI that ignores the deadline signal is
  force-killed, not waited out" (≥ 5 s, up to 2 attempts). Since #1153, any
  case may now pay a second attempt.
- **Production path.** `src/handlers/codex-structured-review.ts`,
  `src/handlers/agent-runtime.ts`, `src/handlers/command-runner.ts`,
  `src/core/review-finding-envelope.ts`. All four are unchanged between
  `456b231c` and `96da7ad2`.
- **Protected contracts.**
  - `:444` §17.7 argv (pure)
  - `:667` real `codex exec`: admission, stream separation `:805`, failure
    taxonomy, timeout `:879`, SIGTERM-proof escalation `:901` (#1060)
  - `:1092` isolation boundary: env strip and HOME/CODEX_HOME `:1093`, checkout
    byte-identical `:1129`, TOCTOU and symlink swap
- **History.** 9 commits. #1068, #1069, #1060, #1027, #912, #897, #1153.
- **Mutation boundary.** In-process adapter; the process is a test fixture.
- **Class.**
  - **Keep** `:668`, `:805`, `:1093`, `:1129` and one deadline case.
  - **Move** the classification-only cases (malformed, truncated, prose-only,
    blank) to the adapter's injected agent seam.
  - Dropping `:901` in favour of `test/command-runner-process-tree.test.js` is
    **not** proposed: that suite does not prove the adapter enforces the
    deadline.
- **Benefit.** **Unknown**, and smaller than it looks. On the 2026-09-13
  sample most of the 37.8 s was the two deliberate deadline cases, which stay;
  each moved case saves one `/bin/sh` start. That share has not been
  remeasured since #1153 added retries, so no benefit figure is claimed.
- **Risk.** A classification case moved to the injected seam no longer passes
  through `bothStreamsCommandRunner`'s stream capture. Each moved case needs a
  kept real-process case that feeds the same stream shape. A move must also
  keep the #1153 completion marker meaningful: a case that no longer runs a
  `/bin/sh` fixture has no marker, so it must not be routed through
  `invokeUntilAnswered` as if it did.

### 3.7 `admin-chain-advanced.test.js`: 37.5 s / 52.3 s, 8 tests

- **Invocation.** Spawned `dist/cli/admin.js`, about 10 runs in total. Each
  also starts the fake `gh` about 15–25 times (a copy of the chain-edit
  stand-in).
- **Production path.** `src/cli/chain-advanced.ts` →
  `src/core/chain-advanced.ts` (`planChainFork`, `planChainMerge`,
  `verifyAdvancedChainReadBack`) → registry store.
- **Protected contracts.**
  - fork `:253`
  - merge `:346`, including retry convergence `:409`, a concurrent GitHub edit
    caught by read-back `:444`, and a merge interrupted after acceptance
    resuming with retirement only `:466` (a crash window)
- **History.** #893 (a single commit).
- **Mutation boundary.** Spawned.
- **Class.**
  - **Move** to `runAdmin`: mechanical, same `{code, stdout}` shape.
  - **Keep** all 8 cases. The fake-`gh` optimization from 3.1 applies here
    too.
- **Benefit (estimated).** About 10 Node start-ups from the move; the larger
  share is the 150–250 fake-`gh` starts, which only the 3.1 optimization
  addresses.
- **Risk.** `:466` is a crash window. Under `runAdmin`, a `finally` that a
  real exit would skip still runs (divergence #1), so the move must show the
  interruption is simulated without depending on process death.

### 3.8 `admin-review-verification-refresh.test.js`: 34.6 s / 55.0 s, 13 tests

- **Invocation.** Spawned, about 30 CLI starts. The fake `gh` is a shell
  script on `PATH`.
- **Production path.** `review-verification refresh` →
  `src/core/verification-refresh.ts`, `gh issue view` adapter, SQLite.
- **Protected contracts.**
  - digest guards: `:196` `--expect-issue-digest`; `:217` `--expect-plan-digest`
    against a concurrent amend (#1044 P2), including the lost-response retry
  - `--allow-retire`
  - replay by `--request-key` without calling the provider (`:433`)
- **History.** 7 commits. #1041, #1043, #1044.
- **Mutation boundary.** Spawned.
- **Class.** **Move** to `runAdmin`.
- **Benefit (estimated).** About 30 Node start-ups; likely the larger share
  of the suite's cost (34.6 s on 2026-09-13; current cost unmeasured), since
  the suite runs no git setup.
- **Risk.** If the `gh` spawn does not pass `spawnEnv()`, the host's real `gh`
  is used and `:433` could pass vacuously. A move needs a `gh` call log that
  asserts zero calls.

### 3.9 `admin-tool-request-grant.test.js`: 32.7 s / 33.8 s, 72 tests, **pilot**

- **Invocation.** Already in-process (`runAdmin`, `:6`, #1018).
- **Cost driver (estimated).** `initRepo` (about 6 `git` calls, plus a bare
  remote when needed), inline git assertions, a real `/bin/sh` run of the
  granted command, and `git worktree add` in `:1542`.
- **Production path.** `runToolRequestGrant(argv, 'grant')` →
  `src/core/tool-request-run.ts` → `src/core/tool-request-grant.ts`
  (`normalizeCommand` `:73`, `hashCommand` `:135`, `createToolRequestGrant`
  `:215`, `grantStatus` `:237`, `grantMatches` `:255`) and
  `src/core/tool-request-changes.ts`.
- **Protected contracts.**
  - `:169` validation, including exact command only (`:201`)
  - `:219` dirty checkout
  - `:263` execution runs once (#316 branch cases `:369`/`:416`/`:461`)
  - `:521` `--on-changes` (#419)
  - `:890` branch discipline (#316)
  - `:1231` failure handoff (#678, refspec push `:1364`)
  - `:1442` shell semantics
  - `:1473` quoted-whitespace exactness
  - `:1492` repo lock
  - `:1542` worktree sessions (#454)
  - `:1907` artifact cleanup (#458)
  - `:1959` fresh repeated request (#490)
- **Overlap.** `test/tool-request-grant.test.js` covers normalize/hash (`:41-97`,
  including quoted whitespace `:54`, escaped whitespace `:61`, newline
  separators `:83`/`:91`) and matching (`:147`).
  `test/tool-request-run-operation.test.js` covers the run core with scripted
  git. Neither has real git, real shell or real artifact files.
- **History.** 31 commits. #316 (11 non-merge commits: one implementation
  commit and 10 review-feedback commits), #419, #454, #458, #472, #490, #678,
  #731, #732, #1018.
- **Mutation boundary.** In-process.
- **Class.**
  - **Keep** `:263`, `:890`, `:1231`, `:1542`, `:1907`, and `:601`/`:663`/`:747`/`:758`
    (real index/push).
  - **Optimize** with a template repository per test.
  - **Consolidate** candidates: `:149`/`:156` help, `:537-555` flag coupling,
    and `:1473` against `tool-request-grant.test.js:54-97`. Each must keep one
    argv-wiring case.
  - `:1492` lock contention is in-process only. It is a *gap*, not a removal
    candidate (see §4).
- **Benefit (estimated).** The template repository saves about 6 `git` calls
  in each of up to 72 tests. Consolidation saves little time; it mainly
  reduces duplication.
- **Risk.** A shared template can leak index, hook or remote state between
  tests; each test still needs a private copy. Consolidating `:1473` could
  lose the proof that quoted whitespace survives argv parsing, which the pure
  suite cannot show.

### 3.10 `issue-refinement-observability.test.js`: 29.8 s / 30.7 s, 34 tests

- **Invocation.** In-process `runNextPhase` with canned handlers and a fresh
  SQLite per test. Only 3 spawned admin runs.
- **Production path.** `runNextPhase` (`src/core/phase-runner.ts`) →
  `prepareRefinementProgressCommit` (`src/core/issue-refinement-progress.ts:790`),
  `projectRefinementProgress` (`:612`) →
  `enqueueRefinementProgressCommentEffects` (`src/core/outbox-effects.ts:2549`)
  and `renderRefinementProgressComment`
  (`src/core/issue-refinement-progress-publication.ts:483`), into
  `src/stores/sqlite-task-store.ts` and `src/stores/sqlite-outbox-store.ts`.
  The admin view goes through `summarizeRefinementProgress`
  (`src/core/issue-refinement-progress-status.ts:345`),
  `summarizeRefinementStatus` (`src/core/issue-refinement-status.ts:125`),
  `formatRefinementDetail` (`src/cli/admin-ui.ts:1306`) and, for the spawned
  cases, `runTaskStatus` (`src/cli/admin.ts:1613`). `outbox-effects.ts` and
  `admin.ts` changed in the merge (§1.1), so both of their line numbers were
  re-read at `96da7ad2`; the test file is unchanged.
- **Protected contracts.**
  - `:166` the task row, milestone event, outbox comment and admin view agree
  - replay emits nothing new (`:528`)
  - `:754` "human and --json admin output agree, and JSON keeps the exact UTC
    deadline", read by a **second process on the WAL database**
  - `:870` normalized model (pure)
- **History.** 4 commits. #977, #975, #976, #980.
- **Mutation boundary.** In-process, except `:754`/`:796`.
- **Class.**
  - **Keep.**
  - **Consolidate** `:796` into `:754`'s single spawn only if the JSON can
    list both tasks.
  - `:754` must stay spawned.
- **Benefit (estimated).** Small: one or two Node start-ups. Most cost is the
  per-test SQLite and in-process phase runs, which are the contract.
- **Risk.** Merging `:796` into `:754` couples two facts in one spawn, so a
  failure in one hides the other, and `:796`'s "no event read" claim must
  still be asserted for its own task.

### 3.11 `admin-cli.test.js`: 28.9 s / 34.9 s, 201 tests

- **Invocation.** Already in-process (#1018).
- **Cost driver (estimated).** The session-doctor block `:1338-2130` (stub
  `gh`/agent executables, real probe spawns, retry loops for #897, real
  `git init` at `:1457`/`:1467`/`:2049`).
- **Production path.** `src/cli/admin.ts` (`main` `:14475`) →
  `runTaskStatus` `:1613`, `runListStuck` `:1778`, `runRecover` `:1995`,
  `runContextCreate` `:4172`, `runSessionDoctor` `:4735` (probe stub parsed at
  `:4793` by `parseCliProbeStub`, `src/core/cli-probe.ts:322`; real probes
  through `probe`, `src/handlers/command-runner.ts:891`, classified by
  `classifyProbeFailure`, `src/core/cli-probe.ts:153`),
  `runRepoLockAcquire`/`Release`/`Status`/`ForceRelease` `:5469-5556` →
  `RepoLockStore` (`src/stores/repo-lock-store.ts:54`), `runTaskAssign`
  `:8636`, `runSessionInit` `:8981`, and `SqliteTaskStore`/`SqliteContextStore`.
  `src/cli/admin.ts` gained 33 lines in the merge (§1.1); `cli-probe.ts`,
  `command-runner.ts` and `repo-lock-store.ts` are unchanged.
- **Protected contracts.**
  - help; task-status; list-stuck
  - recover (#401, #242, #951/#984, #677)
  - session-init; context create
  - session-doctor (#839, #897, #965, #849, #1073, #1085)
  - repo-lock acquire/status/force-release/release `:2136-2375`
  - task-assign; output contract `:2681` (#308)
- **History.** 42 commits, the most of any suite.
- **Mutation boundary.** In-process; doctor probes run real child processes.
- **Class.**
  - **Keep.**
  - **Optimize.** Give non-probe doctor cases the probe stub by default
    (rationale already at `:1503-1513`).
  - **Consolidate** the ~10 repeated "appears in help" checks.
  - **Must stay real.** `:1702` "an unavailable candidate CLI is reported as
    such" (real PATH); `:1759` spawn count; `:1796` "backed by REAL probes";
    the git-init cases.
- **Benefit (estimated).** Real probe spawns and #897 retry waits in the
  doctor cases that do not assert probe behaviour. Unknown per test; the
  help consolidation saves almost no time.
- **Risk.** A stub-by-default can turn a case that relied on a real probe into
  one that passes against the stub. Each case switched to the stub must be
  shown to assert no probe outcome. Consolidated help checks must keep every
  command name.

### 3.12 `admin-tool-request-run.test.js`: 28.7 s / 30.3 s, 18 tests

- **Invocation.** Spawned; real git per test.
- **Production path.** `runToolRequestGrant(argv, 'run')` →
  `src/core/tool-request-run.ts` (dispositions; #629 patch apply), which
  gained 33 lines in the merge (§1.1). The test file is unchanged.
- **Protected contracts.** Several #430 review crash windows:
  - `:350` "records the consumed grant when the post-commit push fails"
  - `:440` "fails closed when the revert leaves generated files behind
    (nested git repo)"
  - `:209-261` artifact/gitignore dirtiness
  - `:575` #629 patch applied before the command
- **Overlap.** `test/tool-request-run-operation.test.js` uses scripted git.
  `admin-tool-request-grant.test.js` exercises the same engine over real git
  in-process, but through the `grant` surface.
- **History.** 7 commits. #430 (with 4 review rounds), #629, #678.
- **Mutation boundary.** Spawned. This suite reaches
  `src/core/tool-request-grant.ts` but is **outside the pilot's observable
  boundary**.
- **Class.**
  - **Move** to `runAdmin`.
  - **Keep** `:350`, `:440`, `:575` and the artifact cases on real git.
  - **Consolidate** `:468`/`:494` only after checking that the `run`
    surface's continuation context is asserted elsewhere.
- **Benefit (estimated).** One Node start-up per CLI call; real git per test
  stays, so a modest share of the suite's cost (28.7 s on 2026-09-13; current
  cost unmeasured).
- **Risk.** `:350` and `:440` are crash windows. A move must show that neither
  depends on a `finally` a real exit would skip (divergence #1).

### 3.13 `admin-task-reconcile-merged.test.js`: 28.2 s / 46.3 s, 27 tests

- **Invocation.** In-process (`runAdmin`). Every test runs `git init/add/commit`
  in `beforeEach` (`:246-249`) and calls a shell fake `gh`.
- **Production path.** `src/core/merged-pr-reconciliation.ts`.
- **Protected contracts.**
  - exit classes: `:548` provider read failure exits 1 and never reads as
    not-merged; `:596` missing task exits 1
  - `:642` a live Issue lock withholds every writing outcome (real lock file)
  - `:663` a concurrent write during the provider read loses the CAS (a real
    second process)
  - `:784` composition with `worktree cleanup`
- **Overlap.** `test/merged-pr-reconciliation.test.js` covers the outcome
  table and staleness with stub host and lock.
- **History.** 2 commits. #1047, #1048.
- **Mutation boundary.** In-process, except the second writer in `:663`.
- **Class.**
  - **Optimize.** Create the git repository only where the command needs one.
    Verify first that session loading does not require a git `repoRoot`.
  - **Keep** `:548`, `:596`, `:642`, `:663`, `:784`.
- **Benefit (estimated).** Three `git` spawns in each of the 27 tests that do
  not need a repository. Unknown until the session-loading check is done.
- **Risk.** If a command silently falls back when `repoRoot` is not a git
  repository, a lazy fixture would test that fallback instead of the real
  path. Each case without a repository must assert the same outcome as before.

### 3.14 `admin-chain-inspect.test.js`: 28.0 s / 35.0 s, 22 tests

- **Invocation.** Spawned for every command (about 27 runs). `list`/`show` start
  no `gh`.
- **Production path.** `src/cli/chain-inspect.ts` and the registry store.
- **Protected contracts.**
  - list and show
  - validate: drift, a cycle seen only on GitHub, `missing_member`; a provider
    error kept apart from structural results and marked indeterminate
    (`:334`/`:361`, from review)
  - #1045 repository scope
- **History.** 3 commits. #789, #788, #1045.
- **Mutation boundary.** Spawned.
- **Class.**
  - **Move** to `runAdmin`.
  - **Keep** all 22 cases.
- **Benefit (estimated).** About 27 Node start-ups. Start-up dominates, so
  this is the largest relative gain among the chain suites.
- **Risk.** Low for `list`/`show`. For `validate`, `gh` must still be resolved
  through `spawnEnv()`, or the provider-error cases `:334`/`:361` could pass
  against the host's real `gh`.

### 3.15 `admin-n8n-deploy.test.js`: 27.2 s / 34.7 s (2026-09-13), 35 tests

- **Changed since the measurement.** The second of the two changed candidates
  (commit `45aa3c81`, #1165). One case — the parent-active restore inside
  `describe('apply (--yes)')` — was moved onto `runSuccessfulDeploy` with a log
  reset between attempts, and its Jest timeout was raised from 60 s to
  300 s. No test was added or removed and no assertion was weakened, but that
  case can now cost a second deploy attempt. **The 27.2 s / 34.7 s figures are
  superseded; the current cost of this suite is unknown.** Everything below was
  re-read at `96da7ad2`.
- **Invocation.** Spawned. Each apply also runs
  `scripts/build-parent-child-workflow.mjs` and a shell fake `n8n`. The
  host-starvation helpers `runSuccessfulDeploy`/`runFailingDeploy` (`:88-141`)
  exist because of an earlier flake (#897 classification); #1165 extended
  `runSuccessfulDeploy` to one more case.
- **Production path.** `src/core/n8n-deploy.ts` (planner, executor,
  verification, lock scopes), unchanged between `456b231c` and `96da7ad2`.
- **Protected contracts.**
  - `:401` generate, import child then parent, verify
  - `:650` missing binary hint
  - per-parent lock `:682` refusal, `:714` release after success, `:727`
    release after failure
  - shared-child lock `:760` refusal, `:783` both released, `:797` child lock
    released after failure
- **Overlap.** `test/n8n-deploy.test.js` covers the planner/executor with a
  fake runner and no filesystem or process.
- **History.** 14 commits. #822, #897, #1165.
- **Mutation boundary.** Spawned.
- **Class.**
  - **Consolidate** `:714` into `:783`, and `:727` with `:797`, keeping every
    asserted lock path.
  - **Move** help, option validation and preview to `runAdmin`. The
    failed-deploy lock-release cases (`:727`, `:797`) are also move
    candidates. Process exit does not release those locks:
    `executeN8nDeploy` releases both in `finally` blocks
    (`src/core/n8n-deploy.ts:878-901`) and returns before `runN8nDeploy` sets
    `process.exitCode`. Keep one of them spawned only if a move review finds
    another assertion that depends on a real process.
  - **Keep spawned.** `:401`, `:682`, `:760`, `:650`.
- **Benefit.** **Unknown.** The move would save Node start-ups for the
  help/validation/preview cases, and the consolidation two deploy runs; the
  apply cases keep the build script and fake `n8n`, so the gain was partial
  even on the 2026-09-13 sample, and that sample predates #1165. No figure is
  claimed until a comparable before/after measurement exists.
- **Risk.** `beforeEach` writes to the repository's own `.n8n-artifacts`.
  That is shared state, so merging cases must not increase contention.
  Several direct `run` calls have no starvation retry, so a consolidation must
  not move an assertion from a retried helper onto a bare `run`. Consolidating
  `:714`/`:783` or `:727`/`:797` also lengthens the single case that #1165
  already had to give a 300 s budget.

### 3.16 `admin-review-verification.test.js`: 26.2 s / 43.6 s, 38 tests

- **Invocation.** Spawned, about 42 runs.
- **Production path.** `review-verification resolve` →
  `src/core/verification-evidence.ts`, `src/core/verification-amendment.ts`,
  `src/core/verification-plan.ts` (the last changed in the merge, +61/−2,
  §1.1; the test file is unchanged).
- **Protected contracts.**
  - a pass requeues to review (#593/#213)
  - multi-command partial resolves (#622)
  - branch-only PR context via live `gh` (#674 P1)
  - a later failure clears stale evidence (#622 P1)
  - evidence binding `--head-sha` (#1040, #1043 P2)
- **History.** 8 commits.
- **Mutation boundary.** Spawned.
- **Class.**
  - **Move** the decision/state blocks to `runAdmin`.
  - The fake-`gh` case stays spawned until its spawn site is confirmed to pass
    `spawnEnv()`.
  - **Consolidate** the three overlapping help checks.
- **Benefit (estimated).** Most of about 42 Node start-ups; no git setup, so
  start-up is likely the main cost.
- **Risk.** The branch-only PR context (#674 P1) depends on the live `gh`
  lookup. If moved before its spawn site is confirmed, the case could pass
  against the host's `gh` or skip the lookup.

### 3.17 `admin-context-mode-status.test.js`: 25.8 s / 50.2 s, 17 tests

- **Invocation.** 10 pure cases in-process; 7 CLI cases spawned
  (`:222-293`). No probe runs (`--probe-cli` is never passed).
- **Cost driver.** Seven spawns cannot explain a 25.8 s median on their own.
  The large median/max gap points to host contention, but the cause is
  **unknown** without a `--runInBand` measurement.
- **Production path.** Pure cases: `buildContextModeStatus`
  (`src/cli/context-mode-status.ts:183`). CLI cases: `src/cli/admin.ts`
  dispatch (`:14369`) → `runContextModeStatus`
  (`src/cli/context-mode-status.ts:492`), `parseContextModeStatusArgs`
  (`:454`), `renderContextModeStatus` (`:543`), and session loading in
  `src/registries/json-session-registry.ts`, whose `contextMode` validation
  (`:1075`) produces the `:280` error. `context-mode-status.ts` is unchanged
  in the merge; `admin.ts` and `json-session-registry.ts` are not (§1.1), so
  both line numbers above were re-read at `96da7ad2`. The registry change does
  not touch `validateCodexContextMode`'s "enabled but no invocation form"
  refusal, which is the fact `:280` asserts.
- **Protected contracts.**
  - the verdict matrix (#399)
  - `:280` "an enabled-but-empty session config is rejected at load time
    before a run" (registry validation reached only through the CLI)
- **History.** 3 commits.
- **Mutation boundary.** In-process for the pure cases, spawned for the CLI.
- **Class.**
  - **Move** the CLI block to `runAdmin`.
  - **Keep** the pure block.
- **Benefit.** Unknown. Seven start-ups were a small share of the 25.8 s
  measured on 2026-09-13, so the move may give no measurable speedup until the
  cost cause is measured.
- **Risk.** `:280` must still reach the registry validation through session
  loading, not through `buildContextModeStatus` alone. Under `runAdmin`, a
  host `CODEX_CONTEXT_MODE` still leaks unless the env is set explicitly.
- **Finding.** The spawned `run` merges `process.env`, so a host
  `CODEX_CONTEXT_MODE` could change results. Record this for slice 6; do not
  fix it here.

### 3.18 `admin-chain-sync.test.js`: 23.9 s / 32.9 s, 24 tests

- **Invocation.** Spawned, about 28 runs. The race tests start another Node
  process that loads `dist/index.js`.
- **Production path.** `src/cli/chain-sync.ts` → `src/core/chain-sync.ts`
  (`planChainSync`) → registry store.
- **Protected contracts.**
  - argument handling `:205`
  - import and no-op revision
  - refusals keep the accepted graph, including two transaction races:
    `:520` "a prefix frozen while GitHub is being read still refuses the
    import", and `:562` "a verdict about a graph that has since moved does not
    overwrite newer sync state"
  - `--all` partial success exits 1 (`:611`)
- **History.** 3 commits. #892, #788, #789.
- **Mutation boundary.** Spawned.
- **Class.**
  - **Move** to `runAdmin`. The racing writer must stay a separate process and
    connection, so the transaction isolation stays real.
  - **Consolidate** the 7 argument cases into a table.
- **Benefit (estimated).** About 28 Node start-ups from the move. The table
  saves no time by itself.
- **Risk.** `:520`/`:562` lose meaning if the racing writer moves into the
  worker and shares a connection. A table must keep each case's exact exit
  code and error text.

### 3.19 `public-export.test.js`: 23.6 s / 24.7 s, 81 tests

- **Invocation.** In-process imports of `scripts/public-export.mjs` and
  `scripts/copybara-export.mjs`. Real `git` builds the fixtures; Java and
  `gh` are stubbed.
- **Cost driver (estimated).** About 20–40 `git` processes per
  `runPublicExport` case (`:646`).
- **Production path.** `scripts/public-export.mjs` and
  `scripts/copybara-export.mjs` — JavaScript under `scripts/`, not TypeScript
  under `src/`. Both are unchanged in the merge. This is why the suite is
  excluded from the mutation pilot (§6): there is no `src/` module to mutate.
- **Protected contracts.**
  - a publish never touches public `main`
  - dry run never touches the remote
  - merge status keyed on headRefOid, failing closed (#800 P1)
  - baseline staging and recovery from a merged PR (#800)
  - idempotent reruns
- **History.** 9 commits.
- **Mutation boundary.** In-process, but under `scripts/`, which is outside
  `src/` and outside any TypeScript mutation scope.
- **Class.**
  - **Keep.**
  - **Optimize** with template repositories (`git clone --local`).
  - Real ref semantics stay required.
- **Benefit (estimated).** Part of the 20–40 `git` processes per case, for the
  fixture-building share only. Unknown until measured.
- **Risk.** A `--local` clone shares objects and may carry different refs or
  config (e.g. `origin`) than the fixture built from scratch. The public
  `main` and headRefOid cases must see the same ref layout as before.

### 3.20 `admin-retention.test.js`: 23.3 s / 28.7 s, 11 tests

- **Invocation.** Spawned, 27 runs for 11 tests.
- **Production path.** `src/stores/sqlite-backup-store.ts`,
  `src/stores/sqlite-maintenance-lock.ts`,
  `src/stores/sqlite-retention-store.ts`.
- **Protected contracts.**
  - `:91` restore requires `--yes`, and no `maintenance_lock` row is left
    behind
  - `:115` restore with a missing live database seeds a protected lock before
    the swap (#611 review)
  - `:205` preview never creates tables (#611 review)
  - `:230` coverage gating (#611 review)
  - `:283` intervention counts survive pruning
- **History.** 4 commits. #611.
- **Mutation boundary.** Spawned.
- **Class.**
  - **Move** to `runAdmin`: the backup/restore cases `:76`, `:91`, `:115`,
    `:144` and the maintenance/prune cases `:188`, `:205`, `:218`, `:230`,
    `:272`, `:283`.
  - The restore cases (`:91`, `:115`, `:144`) do not depend on process exit.
    `runBackupRestore` (`src/cli/admin.ts:13163-13293`) ends every path with
    `emit` + `process.exitCode` + `return`, never `die()`. It closes the stub
    database and releases/closes `oldLock`/`liveLock` in its own `finally`
    (`:13289-13293`), which runs the same way in a spawned run and under
    `runAdmin`. So divergence #1 (a `finally` skipped by a real exit) and #3
    (handles reclaimed by process death) do not apply. `:144` does not assert
    the maintenance lock at all. Its facts are the non-zero code, the `ok:false`
    `artifactDir` error and an untouched live database.
  - What a move must still keep for these cases: the lock-row assertions in
    `:91` and `:115` still read the real SQLite file through a separate
    read-only connection after the command returns. `--session-id` stays
    unused (divergence #2, `DEFAULT_SESSIONS_PATH`). No spawn site is reached
    (divergence #4). If a later change makes restore exit through `die()` or
    leaves a lock open on purpose, the case goes back to spawned.
  - **Consolidate** `:313` into `:283` only if every watermark assertion is
    kept.
- **Benefit (estimated).** Most of 27 Node start-ups; no git setup.
- **Risk.** Moderate for the restore cases, bounded by the checks above. A
  merged `:283`/`:313` would hide one watermark failure behind the other.

## 4. High-value cases that no simplification may lose

These must keep their real boundary: a real process, a real lock, a real git
or a real second writer. A simplification that touches one of them has to
show the case still runs at the same boundary.

| Kind | Cases |
|---|---|
| Cross-process concurrency / CAS | `admin-chain-edit.test.js:1511` (owner pid; blocked run keeps claim); `:604`, `:731`, `:1298` (registry writes during a run); `admin-chain-sync.test.js:520`, `:562`; `admin-task-reconcile-merged.test.js:663`; `issue-refinement-observability.test.js:754` (second process on WAL) |
| Lock lifecycle | `admin-chain-edit.test.js:1368`, `:1408`, `:1446`, `:1457`, `:1559`, `:458` (rolling upgrade); `admin-n8n-deploy.test.js:682`, `:727`, `:760`, `:797`; `admin-retention.test.js:91`, `:115` (real lock row in the SQLite file; the release is an explicit `finally`, not process death, so `runAdmin` keeps the boundary, see §3.20); `admin-task-reconcile-merged.test.js:642`; `admin-tool-request-grant.test.js:1492`, `:1517` |
| Process / signal / deadline | `codex-structured-review.test.js:879`, `:901`; `review-dispute-default-path-e2e.test.js:1816`, `:1929`, `:2111`, `:2147`; `admin-cli.test.js:1702`, `:1759`, `:1796` |
| CLI wiring (exit status, streams, argv) | `admin-cli-subprocess.test.js:60-196` (generic owner of these contracts); `run-one-phase-cli.test.js:143`, `:168`, `:555`, `:798`; `admin-task-reconcile-merged.test.js:548`, `:596`; `admin-chain-sync.test.js:611` |
| Real git / filesystem facts | `admin-tool-request-direct-review.test.js:329`, `:359`, `:394`, `:407`; `admin-tool-request.test.js:879-1197`; `admin-tool-request-grant.test.js:890-1228`, `:1231-1440`; `admin-tool-request-run.test.js:350`, `:440`, `:575`; `public-export.test.js:646` block |
| Prior-bug / review regressions | the 12 "issue #791 review" test bodies in `admin-chain-edit.test.js` (§3.1) plus the overlapping-edits block `:1327`; #316/#678 review cases in `admin-tool-request-grant.test.js`; #430 review cases in `admin-tool-request-run.test.js`; #611 review cases in `admin-retention.test.js`; #1044 P1/P2 in `admin-review-verification-refresh.test.js`; #800 P1/P2 in `public-export.test.js`; #897/#1089 starvation classification |

Found gap (to record, not to fix here): repo-lock contention in
`admin-tool-request-grant.test.js:1493` uses an in-process holder. No test
found holds the repository lock from another process while a grant runs.

## 5. Pilot scope for mutation validation (slices 3–4)

The scope is two small, pure modules with in-process tests. One sits under
the costliest suite (an *optimize* candidate), one under a *consolidate*
candidate. Both are reached only in the Jest worker by the listed tests, so a
mutant is observable.

**Still valid at the inherited HEAD.** `src/core/chain-linear.ts`,
`src/core/tool-request-grant.ts`, `test/chain-linear.test.js`,
`test/admin-chain-edit.test.js`, `test/tool-request-grant.test.js` and
`test/admin-tool-request-grant.test.js` are byte-identical between `456b231c`
and `96da7ad2` (§1.1). Sizes and test-call-site counts below were re-checked
there. Only the *cost* that motivated picking §3.1 is historical: it ranks the
2026-09-13 measurement, and slice 3 must not read it as a current figure.

| Source to mutate | Size | Tests counted as evidence | Why |
|---|---|---|---|
| `src/core/chain-linear.ts` | 859 lines | `test/chain-linear.test.js` (pure, 30 test call sites), `test/admin-chain-edit.test.js` (in-process `runAdmin`, 53 tests) | The costliest suite (§3.1). Its expensive part is test fixture processes, not production code, so a setup optimization can be checked for preserved detection. Heavily reviewed history (#791, #1045). |
| `src/core/tool-request-grant.ts` | 288 lines | `test/tool-request-grant.test.js` (pure, 21 test call sites, including the `test.each` at `:156`), `test/admin-tool-request-grant.test.js` (in-process `runAdmin`, 72 tests) | Security-relevant exact-command matching (quoted whitespace, newline separators), consolidation candidates (§3.9), and a suite cheap enough to mutate within a bounded run. |

**Bounds for slices 3 and 4** (carried from the issue, not new policy)

- The configuration names exactly these two files to mutate and exactly these
  four test files. It does not mutate the whole repository, and it does not
  add a mutation step to `npm test`, CI or the AI loop.
- The same configuration (mutators, test files, coverage analysis, timeouts,
  concurrency) is used for every before/after run. Concurrency is bounded,
  and host load is recorded. Other processes on the host are never stopped.
- Reports go under a gitignored directory. Only bounded, sanitized summaries
  are published.
- If the harness's dry run estimates a cost that does not fit a bounded run,
  report that. Do not silently swap test files. A narrower mutate range inside
  the same two files (for example `planLinearChainEdit` `:457` and
  `verifyLinearChainReadBack` `:796`) is the only allowed reduction, and it
  must be stated.

**Questions slice 3 must answer before any score is used**

1. Can mutants in `src/*.ts` reach tests that import `dist/`? That needs a
   build inside the sandbox, with `noEmitOnError: true` handled without
   weakening the project `tsconfig.json`.
2. Does the Jest runner support this `--experimental-vm-modules` ESM setup and
   the `globalSetup`/`setupFiles` HOME isolation (#1063)?
3. Is per-test coverage attributed for `runAdmin` cases? Does anything run in a
   child process that the tool would miss?

**Inside the scope but not validated by mutation**

- `admin-chain-edit.test.js` `:604`, `:731`, `:1215`, `:1298`, `:1457`,
  `:1511`, `:1559`. The concurrent writer or sabotage hook runs in a child
  Node process. The edit under test is observable; the child's behaviour is
  not.
- The fake `gh` and the real `/bin/sh`/`git` processes are test fixtures or
  external tools, not mutated code.
- Session-selection and `spawnEnv()` wiring in `src/cli/chain-edit.ts` and
  `src/core/tool-request-run.ts` are outside the mutate list. A surviving
  mutant cannot exist there, and so it cannot signal a coverage loss there.

**Reaches the pilot sources but excluded from the pilot evidence**

- `test/admin-tool-request-run.test.js`: spawned, so it is unobservable.
- `test/tool-request-run-operation.test.js`: in-process with scripted git, but
  not a candidate under change. Including it would hide whether the candidate
  suites alone still detect a mutant.
- `src/cli/chain-advanced.ts` imports only a type from `chain-linear.ts`.

## 6. Excluded candidates and why

| Candidate | Reason for exclusion from the pilot |
|---|---|
| Spawned suites to move to `runAdmin` (§3.4, 3.5, 3.7, 3.8, 3.12, 3.14–3.18, 3.20) | Their tests are outside the observable mutation boundary before the move and inside it after. A before/after score would compare different boundaries and overstate preservation. Validate them later by showing that each asserted fact is unchanged and each harness divergence is checked, not by mutation score. |
| `review-dispute-default-path-e2e.test.js`, `codex-structured-review.test.js` | Cost is deliberate deadlines and fixture processes. The affected handlers are large (not a small scope), and the value is the process/deadline boundary itself. |
| `run-one-phase-cli.test.js` | The executable's stdout/exit contract is what n8n consumes. Real-CLI cases stay. The only candidate is lazy fixture setup, which needs no mutation validation. |
| `admin-cli.test.js` (session-doctor) | Probe-heavy and flake-sensitive (#897). The source (`src/cli/admin.ts`, 15034 lines at `96da7ad2`) is far too large for a small mutation scope. |
| `public-export.test.js` | Code under `scripts/` (not TypeScript `src/`). Real git ref semantics are the contract. |
| `admin-context-mode-status.test.js` | Cost cause unknown (§3.17). Measure before proposing anything. |
| Suites outside the measured top 20 | No ranked cost in #1109, so any benefit is unknown. |

## 7. Checklist for challenging a proposed simplification

A reviewer in slice 5 (independent plan review) or later should refuse a
change unless every answer is yes and backed by evidence:

1. Is every protected contract from §3, and every affected row in §4, named,
   with the test that still asserts it after the change?
2. Does each such test still run at the same boundary: real process, real
   lock holder, real git, real second writer? A move to `runAdmin` must
   address all four documented divergences.
3. Is a claimed overlap shown at the same boundary? A pure decision test does
   not replace a test whose facts come from real git, SQLite, exit status or
   process death.
4. For the pilot files, is detection preserved **per candidate suite**, not
   only across the combined four-test run? In a combined run a mutant counts
   as killed when any included test kills it, so an unchanged pure unit suite
   (`chain-linear.test.js`, `tool-request-grant.test.js`) can hide a loss in
   the changed admin suite. That is the same masking that keeps
   `tool-request-run-operation.test.js` out of the evidence (§5). Compare the
   candidate suite's own results before and after, keeping kills and coverage
   apart. A mutant the suite *killed* before must still be *killed* by it; a
   mutant it now only *covers* is a lost detection, even when another test
   still kills it. A mutant it only covered before must still be covered or
   killed by it. Use either per-mutant `killedBy` and `coveredBy` (compared
   as separate sets) in the report, or a separate run with only that suite
   under the same configuration, with no mutant that it killed before now
   surviving, covered-only or uncovered. The combined run must also show no
   newly surviving or uncovered mutant. If a loss appears, the fix is
   restoring or repairing the test, not weakening an assertion, excluding the
   mutant or lowering a threshold.
5. For cases outside the observable boundary (§5), is preservation argued
   from the assertions themselves, rather than from a mutation score?
6. Is the benefit measured with the #1109 command under conditions comparable
   to the "before" run — same command, same `--max-workers`, same host, with
   the load recorded — and is the SHA of each run stated? The 2026-09-13
   numbers in §3 are not a usable "before" for a run on a later tree (§1.1):
   a proposal that claims a speedup must take its own before-measurement at
   the SHA it is changing. A verification `PASS` is not a measurement. "No
   measurable speedup" and "zero deletions" are acceptable outcomes.

## 8. Limitations

- Costs are per suite, from two samples on a shared, loaded host. Every
  per-case or per-process cost here is an estimate from reading the code.
- **The cost data is historical.** It was measured on 2026-09-13 at
  `9b278b20`; this report is reconciled to `96da7ad2`, and no suite was
  remeasured in this slice (§1.1). The ranking in §3 therefore orders the
  suites *as they were then*. Two candidates have since changed (§3.6, §3.15)
  and their figures are superseded; for the other 18 the test files are
  unchanged, but several of their production paths are not, so "the ranking
  probably still holds" is an inference, not an observation. Any claim that a
  suite is still among the costliest needs a fresh measurement.
- No current cost is known for any suite in this report, including the pilot
  scope. Where a benefit could not be bounded from the historical sample, the
  section says **unknown** rather than giving an estimate.
- Overlap was checked from file headers and test lists, not by comparing
  assertions line by line. Every *consolidate* or *possibly remove* candidate
  needs that comparison before a change.
- Commit subjects do not describe what broke. Regression history comes from
  issue references and review-round counts, not from reproduced failures.
- Mutation-tool behaviour (§5 questions) is unconfirmed until slice 3. The
  StrykerJS configuration and incremental-mode documentation
  (<https://stryker-mutator.io/docs/stryker-js/configuration/>,
  <https://stryker-mutator.io/docs/stryker-js/incremental/>) must be checked
  against the installed version then.
