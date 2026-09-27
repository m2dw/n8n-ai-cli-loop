# Test-maintenance outcome and periodic audit runbook (Test Maintenance Pilot, slice 8)

Issue #1116. This is the pilot's closing report and its reusable procedure. It
covers the final mutation run **F2**, the F1 → F2 comparison, the final
full-project verification, the inventory of what the pilot actually changed,
and a runbook (§10) for repeating a bounded audit by hand. It changes no test,
source, helper, harness, configuration, workflow or specification file. This
file is the only change.

The operator's priority is verification quality over speed or test count. Where
the evidence below is incomplete, it is labelled incomplete, and no quality gate
is described as passed unless it was run to completion and passed.

## 0. Result

| Question | Answer |
|---|---|
| Tests changed by the pilot | **Two files.** P1 moved 10 of 11 `admin-retention.test.js` cases in-process (#1114). P2 added one case to `tool-request-grant.test.js` (#1114). #1115 changed nothing |
| Tests, cases or assertions deleted or consolidated | **None** |
| Measured speedup | **Suite-local only.** `admin-retention.test.js` median 8.27 s → 1.14 s (§3). **No whole-project speedup is claimed** |
| F2 | **Complete**: run `6a5307de-feb6-46c6-86de-9f0b7188a372` at `f815077e`, 38 of 38 mutants terminal, state complete (passed) (§4, §5) |
| P2's target mutant (`tool-request-grant.ts:242:7`, `>=` → `>`) | **Killed in F2**, by the case P2 added (`tool-request-grant.test.js:141`) (§6.1) |
| F1 assertion-observed kills kept in F2 | **25 of 25**, each by the same test (§6.2) |
| Rows that moved outside P2's target | **Three**, all in `chain-linear.ts` and all between `Survived` and `Timeout`. Two F1 `Timeout` rows are `Survived` in F2 (§6.3) |
| Kill-side acceptance (plan §5.4 item 3) | **Met for assertion-observed kills. Not met as literally written** ("no mutant may newly survive"): two rows are `Survived` in F2 that were `Timeout` in F1. §6.3 diagnoses them and §6.4 names the decision this needs. No full preservation claim is made |
| Coverage-side preservation | **Unverified**: `coverageAnalysis: off` (§6.5) |
| Final full verification (`npm test`, `npm run typecheck`, `npm run package`) | **`npm test` PASS, observed exit 0** at `a8c494e0` (code/test tree = `f815077e`): 316 suites passed, 1 skipped; 13 763 tests passed, 8 skipped, 0 failed. **`npm run package` PASS, observed exit 0.** No generated-output drift. **`npm run typecheck` PASS, observed exit 0** at `028f0106` (code/test tree = `f815077e`), run through an operator-approved guided run (§7) |
| Periodic automation scheduled | **None.** Mutation testing stays out of `npm test`, CI, review and the runtime workflow (§10.8) |

## 1. Inherited head and reconciliation

| Field | Value |
|---|---|
| Accepted predecessor | #1115, PR #1181, head `f815077e7b2345d883e7ede57f7d76702d99222f`, branch `ai/issue-1115` |
| This branch's head at the start and throughout F2 | `f815077e…`: **no drift**. `git status --porcelain` was empty at the start, and F2 recorded `worktreeDirty: clean` |
| F1's input head | `be5563aae5c3d6b24d98d4fef17be85809ce650d` (optimization report §5.1) |
| `git diff --stat be5563aa..f815077e` | four files: `docs/metrics/test-maintenance-consolidation-decision.md`, `docs/metrics/test-maintenance-optimization.md`, `test/admin-retention.test.js` (P1), `test/tool-request-grant.test.js` (P2) |
| Same diff restricted to the mutation input set: `src/`, `scripts/`, `package.json`, `package-lock.json`, `tsconfig.json`, `stryker.pilot.config.mjs`, `.gitignore`, `test/helpers/` and the four scoped suites | **one file**: `test/tool-request-grant.test.js`, +6 lines, 0 removed. That is P2 |
| Toolchain at F2 | Node v22.6.0, `@stryker-mutator/core` 8.7.1, `@stryker-mutator/jest-runner` 8.7.1, Jest 29.7.0, TypeScript 6.0.3: the same as F1 |

So F1 → F2 has exactly **one intended in-set change, P2**. P1
(`admin-retention.test.js`) is not a scoped suite and imports nothing in the
mutated ranges. The decision and optimization reports are documentation. Both
are out of set. No unexpected drift was found, so none needed investigating
before comparing.

Sections read before any measurement: plan §5 and §7 (#1116), optimization
report §3–§8, consolidation decision §4, harness report §2, §6, §7.

## 2. Inventory: what the pilot retained, added and left unchanged

| Item | Slice | Change | Status at `f815077e` |
|---|---|---|---|
| **P1**: `test/admin-retention.test.js` | #1114 | 10 of 11 cases (25 helper calls) moved from a spawned `execFileSync` CLI to the in-process `runAdmin` harness. The missing-artifact-directory case stays spawned because it asserts a real process exit status. No `expect` line changed | **Retained** (optimization report §3.5) |
| **P2**: `test/tool-request-grant.test.js` | #1114 | One added case, `tool-request-grant — status` › `expired at exactly expiresAt (boundary; issue #1112 survivor 10)`, at `:141`. The existing cases are unchanged. "exhausted" moved from `:141` to `:147` | **Added** |
| P3: cheaper fake `gh` in `admin-chain-edit.test.js` | — | Not done | **Deferred** (plan §3 P3) |
| P4: 6 of 22 `admin-chain-inspect.test.js` cases in-process | — | Not done | **Deferred** (plan §3 P4) |
| P5: consolidate `admin-tool-request-grant.test.js:1473` | #1115 | None | **Retained unchanged**. The boundary is in-process argv parsing, task state and outbox, not a spawned shell (decision report §2) |
| P6: remove `admin-tool-request-grant.test.js` | #1115 | None | **Retained unchanged**. `:220` holds 2 singleton kills, confirmed again in F2 (§6.2) |
| P7: treat `chain-linear.test.js` as redundant | #1115 | None | **Retained unchanged**. 0 kills in #1112, F1 and F2 means no before-picture, not redundancy |
| P8: survivor-targeted tests, retention merges | #1115 | None | **Rejected** |
| Every other test file, the harness, the Stryker configuration, `src/`, workflow JSON | — | None | **Unchanged** |

Net effect on the suite: **+1 test case, 0 removed.** No production file,
shared helper or harness changed at any point in the pilot.

## 3. P1 cost evidence (reused, not re-measured)

This section reuses #1114's accepted pair (optimization report §3.4–§3.5). No
fresh benchmark was launched. #1115 changed no test, so it has no after pair,
and none is invented here.

| Field | Before | After |
|---|---|---|
| SHA | `be5563aa…` | `9e12b1fe1b426f668df45b2495d3625002c71a53` (P1 only) |
| Protocol | `--clearCache`, `dist/` removed, timed build, clean-tree checks before the build, after the build and after the runs, one discarded warm-up that passed, then `scripts/test-cost-baseline.mjs --repeat 2 --max-workers 4 --skip-build` | identical |
| Host, toolchain | Apple M2, darwin 24.6.0 arm64, 8 CPUs, 24 GiB; Node v22.6.0, npm 10.8.2, Jest 29.7.0, TypeScript 6.0.3 | identical |
| Load, 1/5/15 min | 4.92/4.24/4.00 at start; 7.93/7.19/5.58 before run 1; 8.68/9.72/7.51 between runs; 5.88/8.18/7.73 after run 2 | 2.42/3.15/4.30 at start; 6.56/7.37/6.09 before run 1; **11.46**/8.74/7.10 between runs; 7.51/7.80/7.21 after run 2 |
| Free memory | ≈0.1 GB at start; ≈2.2 GB before the measured runs; ≈2.6 GB after each run | ≈0.3 GB at start; ≈2.5 GB before the measured runs; ≈2.7 GB after run 1, ≈2.8 GB after run 2 |
| `admin-retention.test.js`, warm, per run | 10.39 s, 6.14 s. Median **8.27 s**, median-to-max gap 2.12 s | 0.90 s, 1.38 s. Median **1.14 s**, gap 0.24 s |
| Full run, warm | 463.9 s, 428.7 s, 0 failed | 408.2 s (0 failed); 447.9 s (**1 failed**) |

**What this supports.** A 7.13 s drop in the retention suite's median, above
the 2.12 s gap that was set as the threshold before the after half existed. The
slower after run (1.38 s) is still faster than the faster before run (6.14 s).
That is a **suite-local** saving of about 7 s of worker time per full run,
spread over four workers.

**Load during the pair.** The host was shared with other projects throughout,
and no unrelated process was stopped (optimization report §3.4). The load rows
above are the only readings taken, at the four sampling points each half
recorded; nothing was sampled per suite. The two halves' loads differ. The after
half started lighter (2.42 against 4.92) but peaked higher between its runs
(11.46 against 8.68, the highest reading in either half). So load does not
explain the retention drop in the after half's favour. It does make the
full-run times in the table less comparable than the per-suite figures, and it
is part of why the whole-project comparison below is not supported.

**What it does not support.**

- Any whole-project speedup. Each half's two full runs differ by 35–40 s, which
  is more than the 18 s difference between the medians.
- An all-pass cost run. After run 2 failed once, in
  `test/codex-structured-review.test.js:1323`, the shared-`os.tmpdir()`
  isolation-directory leak check (optimization report §3.4). That test is
  outside P1, and the failure is carried here unchanged.
- Rechecking. The before half's raw files and its build log were lost when the
  #1114 worktree was recreated (optimization report §7). The figures above were
  copied out of those files while they still existed, and cannot be re-derived.
  Two warm samples per half are the only noise estimate available.

P1 has no mutation evidence in either direction: `admin-retention.test.js` is
not a scoped suite. Its preservation argument is the assertion mapping and
divergence reads in optimization report §3.2–§3.3, not a score.

## 4. F2 provenance

Launched and read only through the supported pairs, one at a time, with the
default arguments and the default `.mutation/` output. No full verification or
other heavy run of this pilot overlapped it. Each launch was its own Tool
Request, and a launch that returned 0 was not treated as a result. Each run
counted only once its own `summary.json` read `state: complete (passed)`.

| Field | Dry run | Pilot (F2) |
|---|---|---|
| Command | `npm run mutation:dry-run:start`, then `summary.md`/`summary.json` | `npm run mutation:pilot:start`, then `summary.md`/`summary.json` |
| Run id | `9313ec43-6469-43c2-abc3-691dd3000fb9` | `6a5307de-feb6-46c6-86de-9f0b7188a372` |
| Commit, worktree | `f815077e…`, clean | `f815077e…`, clean |
| When (UTC) | 2026-09-24, ended 23:45:23 | 2026-09-25 03:17:05 → 04:47:13 |
| Effective arguments | dry-run defaults: concurrency 1, budget 30 min, `--timeout-ms 60000`, `--coverage-analysis off` | `--pilot --concurrency 2 --timeout-ms 60000 --max-runtime-min 180 --coverage-analysis off --out .mutation` (from `run-state.json`) |
| Configuration | `timeoutFactor` 2, incremental off, StrykerJS default mutators, no mutator excluded, no checker, existing harness and `stryker.pilot.config.mjs` | the same |
| Scope handed to Stryker (`run-spec.json`) | mutate `src/core/chain-linear.ts:329-359`, `src/core/tool-request-grant.ts:237-244`; tests `chain-linear`, `admin-chain-edit`, `tool-request-grant`, `admin-tool-request-grant` (`.test.js`) | the same, frozen and not widened |
| Sandbox build | `tsc` exit 0, 0 diagnostic lines; both files emitted and instrumented | the same |
| Preflight | every check `ok`, including `reports-ignored` and `not-wired-into-verification` | the same |
| Mutants instrumented | 38 | 38 |
| One pass over the scoped suites | **181 tests**, net 175 753 ms + 1 565 ms overhead, 183.0 s wall; complete (passed) | pilot's own initial run: 181 tests, net 180 371 ms + 2 216 ms overhead |
| Wall time | 183.0 s | **5407.4 s (90 min 7 s)**, within the 180-min budget |
| Ending | lock released | exit 0, no signal, `timedOut: false`, `groupSurvived: false`, no surviving pid; lock released |
| Per-mutant deadline | — | about 421 s (60 000 ms + 2 × 180 371 ms + overhead) |
| Load, 1/5/15 min | 6.14/9.29/6.82 → 3.20/6.78/6.27 | 2.98/2.91/2.94 at start → 3.55/4.45/4.63 at end. Sampled during the run: 4.44 (03:26), 3.83/4.41/4.25 (03:47), 4.88/6.75/5.75 (03:59), 3.13/3.58/4.25 (04:20), 4.72/4.83/4.71 (04:41) |
| Free memory | not recorded | 1 256 MB at the end (`summary.json`); not sampled during the run |
| Cache | Jest runs inside Stryker's sandbox copy. Its cache state was not controlled or recorded, and neither was F1's | the same |

The host was shared with other projects throughout. No unrelated process was
stopped, and concurrency was not raised. F1's dry run had **180** tests. F2's
has **181**, and the one extra test is P2's.

Two `SIGABRT` child-process exits in `run.log` (12:48:05 and 12:49:51 local
time) belong to the `RuntimeError` mutant (`340:19`, `>=`), which Stryker
restarted twice and then classified. That is the same classification as in F1
and #1112.

## 5. F2 identity table (all 38)

The format is the same as F1's table (optimization report §5.3). Location is
`line:column` start–end in the mutated file. Match rows by location + mutator +
original + replacement, never by row order. `killedBy` names the test by file
and the line of its `test(` call **at `f815077e`**. `tests` is StrykerJS's
`testsCompleted`, and `—` means none recorded. The **F1** column repeats F1's
status for the same identity. **Bold** marks a row whose status differs.

**`src/core/chain-linear.ts`**

| Location | Mutator | Original → replacement | F2 status | `killedBy` | tests | F1 |
|---|---|---|---|---|---|---|
| 329:48–331:2 | BlockStatement | `edgeKey` body → `{}` | Killed | `admin-chain-edit.test.js:839` | 181 | Killed, `:839` |
| 330:10–330:66 | StringLiteral | `edgeKey`'s template literal → empty template literal | Killed | `admin-chain-edit.test.js:839` | 181 | Killed, `:839` |
| 333:69–335:2 | BlockStatement | `compareEdges` body → `{}` | **Timeout** | — | — | **Survived** |
| 334:10–334:100 | ConditionalExpression | `a.blockerIssueNumber - b.blockerIssueNumber \|\| a.blockedIssueNumber - b.blockedIssueNumber` → `true` | Survived | — | 181 | Survived |
| 334:10–334:100 | ConditionalExpression | same → `false` | **Survived** | — | 181 | **Timeout** |
| 334:10–334:100 | LogicalOperator | `\|\|` → `&&` | Survived | — | 181 | Survived |
| 334:10–334:53 | ArithmeticOperator | `a.blockerIssueNumber - b.blockerIssueNumber` → `a.blockerIssueNumber + b.blockerIssueNumber` | Survived | — | 181 | Survived |
| 334:57–334:100 | ArithmeticOperator | `a.blockedIssueNumber - b.blockedIssueNumber` → `a.blockedIssueNumber + b.blockedIssueNumber` | Survived | — | 181 | Survived |
| 338:65–344:2 | BlockStatement | `linkEdges` body → `{}` | Killed | `admin-chain-edit.test.js:362` | 181 | Killed, `:362` |
| 339:35–339:37 | ArrayDeclaration | `[]` → `["Stryker was here"]` | Killed | `admin-chain-edit.test.js:362` | 181 | Killed, `:362` |
| 340:19–340:36 | EqualityOperator | `i < issues.length` → `i <= issues.length` | Killed | `admin-chain-edit.test.js:362` | 181 | Killed, `:362` |
| 340:19–340:36 | ConditionalExpression | `i < issues.length` → `false` | Timeout | — | — | Timeout |
| 340:19–340:36 | EqualityOperator | `i < issues.length` → `i >= issues.length` | RuntimeError (test runner crashed; restarted twice) | — | — | RuntimeError |
| 340:38–340:44 | AssignmentOperator | `i += 1` → `i -= 1` | Timeout | — | — | Timeout |
| 340:46–342:4 | BlockStatement | loop body → `{}` | Killed | `admin-chain-edit.test.js:526` | 181 | Killed, `:526` |
| 341:16–341:84 | ObjectLiteral | edge object → `{}` | Killed | `admin-chain-edit.test.js:362` | 181 | Killed, `:362` |
| 341:45–341:50 | ArithmeticOperator | `i - 1` → `i + 1` | Killed | `admin-chain-edit.test.js:362` | 181 | Killed, `:362` |
| 353:60–359:2 | BlockStatement | `resolveRoots` body → `{}` | Killed | `admin-chain-edit.test.js:839` | 181 | Killed, `:839` |
| 354:44–354:71 | ArrowFunction | `(e) => e.blockedIssueNumber` → `() => undefined` | Killed | `admin-chain-edit.test.js:839` | 181 | Killed, `:839` |
| 355:10–357:56 | MethodExpression | `….filter((issueNumber) => !blocked.has(issueNumber))` dropped → `target.members.map(m => m.issueNumber)` | Killed | `admin-chain-edit.test.js:839` | 181 | Killed, `:839` |
| 355:10–358:27 | MethodExpression | `.sort((a, b) => a - b)` dropped → `target.members.map(m => m.issueNumber).filter(issueNumber => !blocked.has(issueNumber))` | **Survived** | — | 181 | **Timeout** |
| 356:10–356:30 | ArrowFunction | `(m) => m.issueNumber` → `() => undefined` | Killed | `admin-chain-edit.test.js:839` | 181 | Killed, `:839` |
| 357:13–357:55 | ArrowFunction | `(issueNumber) => !blocked.has(issueNumber)` → `() => undefined` | Killed | `admin-chain-edit.test.js:839` | 181 | Killed, `:839` |
| 357:30–357:55 | BooleanLiteral | `!blocked.has(issueNumber)` → `blocked.has(issueNumber)` | Killed | `admin-chain-edit.test.js:866` | 181 | Killed, `:866` |
| 358:11–358:26 | ArrowFunction | `(a, b) => a - b` → `() => undefined` | Survived | — | 181 | Survived |
| 358:21–358:26 | ArithmeticOperator | `a - b` → `a + b` | Survived | — | 181 | Survived |

**`src/core/tool-request-grant.ts`**

| Location | Mutator | Original → replacement | F2 status | `killedBy` | tests | F1 |
|---|---|---|---|---|---|---|
| 240:39–244:2 | BlockStatement | `grantStatus` body → `{}` | Killed | `tool-request-grant.test.js:132` | 181 | Killed, `:132` |
| 241:7–241:34 | ConditionalExpression | `grant.uses >= grant.maxUses` → `true` | Killed | `admin-tool-request-grant.test.js:220` | 181 | Killed, `:220` |
| 241:7–241:34 | ConditionalExpression | same → `false` | Killed | `tool-request-grant.test.js:147` | 181 | Killed, `:141` (same test, see below) |
| 241:7–241:34 | EqualityOperator | `>=` → `grant.uses > grant.maxUses` | Killed | `tool-request-grant.test.js:147` | 181 | Killed, `:141` (same test) |
| 241:7–241:34 | EqualityOperator | `>=` → `grant.uses < grant.maxUses` | Killed | `tool-request-grant.test.js:132` | 181 | Killed, `:132` |
| 241:43–241:54 | StringLiteral | `"exhausted"` → `""` | Killed | `tool-request-grant.test.js:147` | 181 | Killed, `:141` (same test) |
| 242:7–242:69 | ConditionalExpression | `new Date(now).getTime() >= new Date(grant.expiresAt).getTime()` → `true` | Killed | `admin-tool-request-grant.test.js:220` | 181 | Killed, `:220` |
| 242:7–242:69 | ConditionalExpression | same → `false` | Killed | `tool-request-grant.test.js:136` | 181 | Killed, `:136` |
| 242:7–242:69 | EqualityOperator | `>=` → `new Date(now).getTime() > new Date(grant.expiresAt).getTime()` | **Killed** (P2's target; #1112 survivor 10) | `tool-request-grant.test.js:141` | 181 | **Survived** |
| 242:7–242:69 | EqualityOperator | `>=` → `new Date(now).getTime() < new Date(grant.expiresAt).getTime()` | Killed | `tool-request-grant.test.js:132` | 181 | Killed, `:132` |
| 242:78–242:87 | StringLiteral | `"expired"` → `""` | Killed | `tool-request-grant.test.js:136` | 181 | Killed, `:136` |
| 243:10–243:18 | StringLiteral | `"active"` → `""` | Killed | `tool-request-grant.test.js:132` | 181 | Killed, `:132` |

The killing tests at `f815077e`, by name (from F2's `mutation.json`
`testFiles`):

- `admin-chain-edit.test.js:839`: `admin chain append / prepend` › append extends past the head and moves it
- `:362`: `admin chain new — repository-scoped Issue identity (issue #1045)` › an Issue of the same number in another repository does not block a new chain
- `:526`: `admin chain new` › preview writes nothing — no relationship, no label, no chain
- `:866`: `admin chain append / prepend` › prepend attaches ahead of the root and leaves the head alone
- `tool-request-grant.test.js:132`: `tool-request-grant — status` › active before expiry and use
- `:136`: › expired once now passes expiresAt
- `:141`: › expired at exactly expiresAt (boundary; issue #1112 survivor 10). **This is P2's case**
- `:147`: › exhausted once uses reaches maxUses. This is F1's `:141`, moved down six lines by P2. It has the same name, and its body is byte-identical
- `admin-tool-request-grant.test.js:220`: `admin CLI — tool-request grant: clean worktree` › refuses to execute when the session checkout is dirty

Per killer: `:839` 7, `:362` 5, `:526` 1, `:866` 1, `:132` 4, `:147` 3, `:136` 2,
`:141` 1, `admin-tool-request-grant:220` 2. That is 26. Every killed mutant has
exactly one `killedBy` entry.

### 5.1 F2 outcomes

| Outcome | F1 | F2 |
|---|---|---|
| Killed | 25 | **26** |
| Survived | 8 | 8 |
| Timeout | 4 | **3** |
| RuntimeError | 1 | 1 |
| NoCoverage / CompileError | 0 / 0 | 0 / 0. The NoCoverage zero is structural under `coverageAnalysis: off` |
| Total | 38, all terminal | 38, all terminal |

Readings for F2: the StrykerJS score is 78.38 % ((26 + 3) / 37), the same as
F1's. That equality is a coincidence of the row movements (§6.3) and is not
evidence of anything. **Assertion-observed, 26 / 37 = 70.3 %** (F1: 67.6 %).
Over everything instrumented, 26 / 38 = 68.4 %. These percentages are
reported for completeness. The comparison in §6 is made by identity, never by
score.

## 6. F1 → F2 assessment

### 6.1 P2's target

`src/core/tool-request-grant.ts:242:7–242:69`, EqualityOperator, `>=` → `>`:
**Survived in F1, Killed in F2**, and its single `killedBy` entry is
`tool-request-grant.test.js:141`, the case P2 added. This is read from F2's
`mutation.json`, not inferred from the diff. Under the mutant,
`now === expiresAt` yields `active`, and the case's first assertion expects
`expired`. So **P2 demonstrates the detection it was added for**, in this
scope. P2's case killed no other mutant. It is the only killer of this one, so
the gain is attributable to it.

### 6.2 Kills per suite, and whether any former kill was lost

| Suite | F1 kills | F2 kills | Same mutants, same killing test? |
|---|---|---|---|
| `admin-chain-edit.test.js` | 14 | 14 | **Yes**, all 14 (`:839` 7, `:362` 5, `:526` 1, `:866` 1) |
| `tool-request-grant.test.js` | 9 | 10 | **Yes** for F1's 9 (`:132` 4, `:136` 2, and the "exhausted" case's 3 at its new line `:147`), **+1** by P2's `:141` (§6.1) |
| `admin-tool-request-grant.test.js` | 2 | 2 | **Yes**, both at `:220` |
| `chain-linear.test.js` | 0 | 0 | — |
| **Total** | **25** | **26** | **No F1 kill was lost, and none moved to another test** |

Only `Killed` with a `killedBy` counts here. `Timeout`, `RuntimeError` and
unknown are kept apart.

### 6.3 The three rows that moved outside P2's target

All three are in `chain-linear.ts`, all move between `Survived` and `Timeout`,
and none involves a kill:

| Row | #1112 (`dc758e12`) | F1 (`be5563aa`) | F2 (`f815077e`) |
|---|---|---|---|
| 333:69–335:2 BlockStatement, `compareEdges` body → `{}` | Survived | Survived | **Timeout** |
| 334:10–334:100 ConditionalExpression → `false` (#1112 survivor 3) | Survived | Timeout | **Survived** |
| 355:10–358:27 MethodExpression, `.sort` dropped (#1112 survivor 7) | Survived | Timeout | **Survived** |

**Two of these now "newly survive" relative to F1.** In F1 they were
`Timeout`, which StrykerJS counts as detected, and in F2 they are `Survived`.
The third went the other way. The history from #1112 to F1 already showed these
rows can move at unchanged inputs (optimization report §5.4). F2 has to be read
against that history. It does not settle the movement.

**Diagnosis, from the code, with no re-run.**

- **333:69 and 334:10 → `false` behave the same on every input.**
  `compareEdges` is only ever passed to `Array.prototype.sort`
  (`chain-linear.ts:711`, `:725`, `:745`, `:832`, `:845`). The emptied body
  returns `undefined`, which the sort's comparison step converts to `NaN` and
  then to `+0`. The `→ false` mutant returns `false`, which converts to `0`.
  Both are the constant-zero comparator, so both leave every array in its
  input order (plan §4 makes the same observation). **In F1 the first survived
  and the second timed out. In F2 they swapped.** Two mutants that execute
  identically cannot owe a different status to their own semantics. So for this
  pair, the `Timeout` reflects the conditions the mutant's test pass ran under,
  not the mutant.
- **The `.sort`-dropped mutant cannot loop.** It only leaves the roots unsorted,
  as optimization report §5.4 already noted.
- **None of the three rows records any completed test when it is `Timeout`.**
  Each `Survived` reading records all 181 tests completing.
- **P2 is not a plausible cause, but that is not measured.** Under
  `coverageAnalysis: off`, every mutant runs all 181 tests, P2's case included.
  But P2's case calls only `grantStatus` in `tool-request-grant.ts`. It cannot
  reach `compareEdges` or `resolveRoots`, and it adds about a millisecond to a
  pass of roughly 180 s. The per-mutant deadline is about 421 s, well over twice
  a normal pass. So a `Timeout` means that one mutant's pass took more than
  twice as long as normal. The recorded evidence does not say why: host load,
  worker contention between the two concurrent Stryker workers, or a slow
  spawned `gh` stand-in in `admin-chain-edit.test.js`. `run.log` names no cause
  for these rows. This report therefore **claims no cause**. It does not blame
  P2, and it does not dismiss the movement as noise.

### 6.4 Acceptance reading, and the decision this needs

Plan §5.4 item 3, as carried forward by optimization report §6: "no mutant
killed in F1 may be anything but killed in F2, and no mutant may newly survive."

| Part | Result |
|---|---|
| Every F1 `Killed` is `Killed` in F2 | **Met**: 25 of 25, same killing tests (§6.2) |
| P2's target is killed by P2's case | **Met** (§6.1) |
| No mutant newly survives | **Not met as written.** Two rows are `Survived` in F2 that were `Timeout` in F1 (§6.3) |

So this report **stops short of a full preservation claim.** What it can say is
narrower. No assertion-observed detection was lost in this scope, and P2 added
one. The movement is confined to rows whose `Timeout` status has already shifted
once at unchanged inputs. For one pair, the diagnosis shows the status cannot
come from the mutant.

**Decision needed (operator or reviewer).** Either:

1. accept that a `Timeout` in the *before* half is not detection evidence (which
   is how every report in this pilot has counted it), so a `Timeout` →
   `Survived` row is not a lost detection, and record the pilot's kill-side
   acceptance as met for assertion-observed kills only; or
2. treat the rule literally and leave the pilot's preservation claim open. The
   only way to learn more would be a separately authorized investigation of the
   timeout behaviour of those rows (for example, a run with the host otherwise
   idle). That would be a new measurement, not a re-run to tidy the score, and
   this Issue does not authorize it.

No test or source was edited to change either reading, and no heavy run was
repeated.

### 6.5 What the comparison does not cover

- **Coverage-side preservation is unverified.** Under `coverageAnalysis: off`,
  `coveredBy` is `null` (unknown) for all 38 mutants in F2, as in F1. That is
  not an empty known set. P2 is purely additive, so no existing case that could
  have covered a mutant changed. That is an argument from the diff, not a
  measured coverage result.
- **38 mutants over 39 source lines in two files.** This says nothing about the
  rest of either module or the project. It does not prove any test redundant, or
  that every defect in scope would be detected.
- **P1 is outside this evidence entirely** (§3).
- Plan §4's correction to `mutation-pilot-baseline.md` §6.1 still stands as
  stated there: the six `compareEdges` survivors are explained by
  order-preserving comparators on already-ascending input, not by "refusal text
  only". F2 changes nothing about it. One of the six is `Timeout` this time
  (§6.3), and the correction rests on V8's sort behaviour at Node v22.6.0, as it
  says.

## 7. Final full-project verification

The code/test tree this verifies is **`f815077e`'s**. This slice changes no
code or test file, only this report. So `git diff f815077e -- . ':!docs/metrics/test-maintenance-outcome.md'`
is empty for whatever tree the runner commits. Any later documentation edit
does not change which code/test revision a result verifies.

| Command | Where it ran | Result |
|---|---|---|
| `npm test` (build via `pretest`, then the whole Jest suite) | **Attempt 1, not a result.** Run through the guided-run executor at `95d61936` (code/test tree = `f815077e`), after F2 had finished and its lock was released. Resolved 2026-09-25 06:27:43 UTC | **Incomplete, exit 1 from the executor, not from Jest.** The executor stopped the command at its 120 s limit (`Error: spawnSync /bin/sh ETIMEDOUT`). The `pretest` build finished. Jest started, and 14 suites had printed `PASS` when it was stopped. No other suite reported, no Jest summary was printed and no test failure appeared. **This is not a pass and not a failure of any test** |
| `npm test` (build via `pretest`, then the whole Jest suite) | **Attempt 2, superseded by attempt 3.** Requested for an ordinary terminal, but run through guided-run again at HEAD `bc7163a0` (code/test tree = `f815077e`). Output went to the gitignored `.test-cost/final-npm-test.log`. Started about 08:23 UTC and finished 2026-09-25 08:39 UTC. The executor timed out at 120 s again (08:25:20 UTC, `spawnSync /bin/sh ETIMEDOUT`), but killed only its `/bin/sh`. The `npm test` child was reparented to `init` and ran to completion, writing to the log. No second run was started while it ran | **Complete summary, exit status not observed.** Jest summary: `Test Suites: 1 skipped, 316 passed, 316 of 317 total`; `Tests: 8 skipped, 13763 passed, 13771 total`; `Time: 850.987 s`; no `FAIL` line. The killed shell never ran the trailing `echo "npm test exit $?"`, so no exit code was captured. The log was lost when this worktree was recreated at about 08:47 UTC. Kept as supporting evidence only |
| `npm test` (build via `pretest`, then the whole Jest suite) | **Attempt 3, the result.** Run in the implementing session as the literal `npm test`, a command this session's allowlist permits, as a background task that records the process exit status. No executor timeout applied. HEAD `a8c494e0a26444838424d5c98b8cc1279be6fb45` (code/test tree = `f815077e`). `git status --porcelain` was empty before the run. Started 2026-09-25 08:58:25 UTC, finished about 09:13 UTC. No other `npm`/`jest` process was running at the start, and no second run was started. Load 1/5/15 min: 2.88/5.13/6.21 at start, 5.61/5.56/5.86 at 09:09 UTC, 9.02/7.34/6.54 at 09:13 UTC | **PASS, observed exit code 0.** The `pretest` build (`build:lib` `tsc`, workflow generation, `build:n8n-node` `tsc`) succeeded. Jest summary: `Test Suites: 1 skipped, 316 passed, 316 of 317 total`; `Tests: 8 skipped, 13763 passed, 13771 total`; `Time: 858.951 s`; `Ran all test suites.` No `FAIL` line. `test/codex-structured-review.test.js` passed (87.3 s), so the shared-tmpdir failure did not recur. That suite printed its own `console.warn` "escalation starved on attempt 1/2", a host-starvation notice from its built-in retry, not a failure. Jest's output does not name the skipped suite |
| `npm run package` (= `npm run build`) | In the implementing session, right after attempt 3, at the same HEAD and code/test tree, 2026-09-25 about 09:13 UTC | **PASS, observed exit code 0.** `build:lib` (`tsc -p tsconfig.json`), `build:parent-child-workflow` (tracked template JSONs plus the ignored `.n8n-artifacts/workflows/` local copies) and `build:n8n-node` (`tsc`) all completed |
| `npm run typecheck` (= `tsc -p tsconfig.json --noEmit`) | The implementing session's permission settings refused the literal command ("This command requires approval"), and it was not bypassed. It was then requested as a Tool Request and run by the operator through guided-run, resolved 2026-09-25 09:34:04 UTC, at HEAD `028f01060b663826ee6a967429ec98bacb5b13bd` (code/test tree = `f815077e`; `git diff --stat a8c494e0 028f0106` lists only this report). Output went to the gitignored `.test-cost/final-typecheck.log`. It finished well inside the 120 s executor limit, so the trailing exit-status line was written | **PASS, observed exit code 0.** The log holds the `tsc -p tsconfig.json --noEmit` banner, no diagnostic, the line `npm run typecheck exit 0` and `git rev-parse HEAD` = `028f0106…`. The `git status --porcelain` appended after it printed nothing, so the tree was clean. Before this, `build:lib` (the same `tsc -p tsconfig.json` without `--noEmit`) had also exited 0 in attempt 3's `pretest` and the `package` run |
| Generated-output drift (`git status --porcelain` after the build) | After attempt 1, after attempt 2 (08:39 UTC, HEAD `bc7163a0206a88961f6f32942fa322d15a1bdd7e`), and after attempt 3 plus the `package` run (09:13 UTC, HEAD `a8c494e0…`) | **None** each time. The builds rewrote the tracked workflow JSONs, and `git status --porcelain` listed nothing except this report's own uncommitted edit (attempt 3). The generator output matches what is committed |

Attempt 1 is recorded only so that it is not repeated in the same way. Its
14 `PASS` lines are a partial observation of an interrupted run. They are not
counted as verification.

Attempt 2 completed only because the executor's timeout left the child process
running. That was not a supported long-command path, and §10.6 does not
recommend relying on it. Its exit status was never observed, so attempt 3 was
run to observe one. It is not a retry for a better result: attempt 2 had
already reported no failures.

Attempt 3 is the pilot's full `npm test` result. Its wall time (859 s) is not a
cost measurement. It is longer than the "about 8 min" estimate used earlier, and
the three load readings are the only load evidence for it.

**What the final verification establishes.** At code/test tree `f815077e`,
`npm test`, `npm run package` and `npm run typecheck` each completed and passed
with observed exit code 0, with no generated-output drift. `npm test` and
`npm run package` ran at HEAD `a8c494e0`, and `npm run typecheck` at HEAD
`028f0106`. The two heads differ only in this report, so all three results
verify the same code/test tree.

A launched command, a Stage 1 run or the loop's changed-file selection does not
substitute for these results. Had `test/codex-structured-review.test.js`'s
shared-tmpdir check (§3) failed again, that failure would have been recorded here
with its evidence and not repaired in this Issue. It passed in attempts 2 and 3.
Two passing runs do not show that the race is gone.

## 8. Explicit unknowns

- F1's raw files (`mutation.json`, `mutation.html`, `run.log`, summaries) and
  #1114's before-half cost logs are lost. Whatever F1's tracked table does not
  print is unrecoverable, including its per-row timing, its load during
  individual mutants and its `run.log` warnings. They were not regenerated.
- Why the three `chain-linear.ts` rows reached `Timeout` in the runs where they
  did (§6.3).
- `coveredBy` for every mutant, in both runs.
- Jest cache state inside Stryker's sandbox, in both runs.
- Free memory during F2 (only the end value was recorded) and in F2's dry run.
- Which suite the final `npm test` skipped (Jest does not name it), and host
  load between the three readings taken during attempt 3. Host load during the
  `npm run typecheck` run was not recorded.
- Whether an existing Issue already tracks the `codex-structured-review.test.js`
  shared-tmpdir race. This run had no GitHub access, and no tracking was found
  in the repository's documentation. See §9.

## 9. Deferred work and follow-up proposals

These are separate from the completed pilot. None is started, scheduled or
authorized by this report.

| Item | Why it is open | Suggested next step |
|---|---|---|
| P3 (`admin-chain-edit.test.js` fake `gh`) | Deferred by the plan; needs its own §8 A gate and an F3 before half | Its own Issue if pursued |
| P4 (`admin-chain-inspect.test.js`, 6 of 22 in-process) | Deferred by the plan; needs its own cost pair | Its own Issue if pursued |
| The §6.4 decision on `Timeout` → `Survived` rows | This report cannot make it | Operator or reviewer decision on this PR |
| Timeout instability of the `chain-linear.ts` comparator/sort rows | Unexplained across three runs | Only if the decision in §6.4 needs it: a separately authorized, bounded investigation |
| `codex-structured-review.test.js:1323` shared-tmpdir race | Seen in #1114's after run 2. It passed in this Issue's full `npm test` (§7), which does not show the race is gone. Not this pilot's to fix | Check GitHub for an existing Issue first; open one only if none exists |
| `runArchiveRollup` constructs `SqliteRetentionStore` outside the `try` that releases the lock | Latent; noted in optimization report §3.3; no case reaches it | Its own Issue |

## 10. Periodic maintenance runbook

An operator-driven audit, about **once or twice a month**. It is started by a
person, by hand. Nothing here is scheduled, and nothing here changes
`npm test`, CI, review or the runtime workflow. The steps are
language-neutral. This project's commands appear as examples.

### 10.1 Select (about 30 minutes, no heavy runs)

1. Record the head: `git rev-parse HEAD`, and confirm the tree is clean.
2. Pick **a few** candidates, not a sweep:
   - **expensive tests**: the top suites by median in the most recent cost
     baseline you have (here, `docs/metrics/test-cost-baseline.md` or a fresh
     §10.3 run if that one is stale);
   - **recently changed tests**: for example `git log --since=<last audit> --name-only -- test/`.
3. Skip anything an active Issue or chain is editing. Independent scheduling
   does not make concurrent edits to the same test or configuration file safe.

### 10.2 Map protected contracts and boundaries

For each candidate, write down, before changing anything:

- every assertion and the **boundary it observes**: a real process exit status,
  a child process, a lock holder, a second writer, persisted state, an outbox,
  argv parsing;
- which of those an in-process or cheaper replacement would still reach
  (optimization report §3.2–§3.3 and decision report §2 are worked examples);
- what is **not** observed today, so that a later change is not credited with
  covering it.

Keep a test whenever preservation of its contract is uncertain.

### 10.3 Collect evidence only when it answers a question

Run one heavy tool at a time, and never concurrently with a full verification
run. Other projects may share the host: record load and memory, bound your own
parallelism, and never stop unrelated processes.

| Tool | Prerequisites | Budget and cost (this host) | Lock | Output (gitignored) | How to read it |
|---|---|---|---|---|---|
| **Test cost**: `node scripts/test-cost-baseline.mjs --repeat 2 --max-workers 4 [--skip-build] --out .test-cost/<half>` | `node_modules` installed, clean tree. For a before/after pair, use plan §5.1's `half.sh` sequence: `--clearCache`, remove `dist/`, timed build, clean checks, discarded warm-up | About 17 min per half with the warm-up, about 34 min per pair. Built-in limits: 15 min build, 45 min per run, `--repeat` at most 3 | **None**. Serialize by hand | `.test-cost/` (`jest-run-N.json`, `baseline.json`, `report.md`). One `--out` per half, never the default twice | A speedup counts only if it beats the suite's own median-to-max gap. Whole-suite wall times rarely resolve a single-suite change. Failures are flake candidates only if the same test passed in another complete run |
| **Mutation**: `npm run mutation:preflight`; `npm run mutation:dry-run:start` then `:report`; `npm run mutation:pilot:start` then `:report` (also `mutation:smoke:*`) | `npm install` in *this* checkout (pinning is not installing); preflight all `ok`; a frozen, narrow scope inside the harness's accepted files (`assertScope()`). There is no `--mutate` or single-file flag | Dry run about 3 min. Pilot over the frozen 38-mutant ranges took 85–91 min at concurrency 2, against a 180-min budget. The whole-file scope (742 mutants) does not fit | `.mutation/pilot.lock`: one run per checkout, whatever `--out` says. Never delete it by hand; `:report` says whether its owner is `running`, `overdue` or `lost` | `.mutation/<mode>/` (`summary.md`/`summary.json` are the sanitized forms; `mutation.json`/`mutation.html`/`run.log` contain source and stay local) | Start detached, because the guided-run executor's 120 s limit cannot hold even the dry run. A `:start` returning 0 is not a result; only `finished` with `state: complete (passed)` is. Use the same scope, concurrency, `timeoutMS`, `coverageAnalysis` and toolchain for both halves, with incremental **off** |
| **Changed-file stage timing**: `npm run build`, then `node scripts/changed-file-stage-timing.mjs --base-branch main [--skip-full] --json .changed-file-timing.json` | A built `dist/`; a branch with changed test files, or Stage 1 has nothing to measure | Stage 1 is seconds to minutes. Stage 2 is the whole suite (about 13 min measured in `changed-file-verification-validation.md`); `--timeout` defaults to 30 min per command | **None**. Serialize by hand | `.changed-file-timing*` | Run it from an ordinary terminal, not the 120 s grant executor. Its Stage 2 figure *is* the full-suite cost, not an extra workload. `INCOMPLETE` means a stage never tested; a red suite is a measured result |

Nothing is uploaded: no dashboard reporter is configured, and the harness
strips `STRYKER_DASHBOARD_API_KEY`.

**Reading mutation evidence.**

- Compare by **identity** (location start–end, mutator, original →
  replacement, `killedBy` test *name*), never by row index, a shifted test
  line alone, or an aggregate score. §5 is the template.
- Only `Killed` with a `killedBy` is assertion evidence. `Timeout`,
  `RuntimeError` and unknown are kept apart. Rows in `chain-linear.ts`'s
  comparator and sort region have moved between `Survived` and `Timeout` at
  equivalent inputs (§6.3). Expect that, and do not read one run's `Timeout`
  there as a detection.
- Under `coverageAnalysis: off`, `coveredBy` is unknown, not empty.
- Equal coverage or equal scores never justify deleting a test. A survivor is
  not by itself a reason to add a score-chasing test (plan §3 P8). Add one only
  when it pins a real, reviewed behaviour, as P2 did.

### 10.4 Independent plan review

Write the proposal down: each change, the contracts it must keep (§10.2), the
measurement that would accept or reject it, and the threshold, fixed **before**
the after half exists. Have someone other than the author review it.
Consolidations or deletions need their own evidence and a retained-case mapping
at the same boundary. None is approved in advance.

### 10.5 Make small approved changes

Make one change per measured pair. Change no assertion, fixture teardown, lock
behaviour or timeout unless that is the reviewed change. Do not widen
exclusions or lower thresholds to make a change pass. Newly lost detection
means repairing or restoring the test, or rejecting the change.

### 10.6 Compare before and after

Take the after half at a clean, committed head, under the same protocol,
toolchain, host and cache conditions as the before half. Apply the pre-set
threshold. Report "no measurable speedup" and "zero deletions" as results when
that is what happened. Run the full project verification (`npm test`,
`npm run typecheck`, `npm run package`) at the final head, and record the SHA
and the actual results. A Stage 1 run or a successful launch is not a full
pass. Here `npm test` took 8 to 15 min, so it must run in an ordinary terminal.
The 120 s guided-run executor stops the requested command partway (§7, attempts
1 and 2). Do not count on a child process outliving that timeout the way attempt 2's
did. Use a path that has no short timeout and records the exit status, such as
an ordinary terminal or an approved background task (§7, attempt 3). Record each
command's own exit status, and do not substitute an equivalent command for it
without saying so. Copy the output, the exit status and the HEAD SHA into the
tracked report before the worktree can be recreated. CI remains the independent
final safeguard.

### 10.7 Preserve sanitized evidence before cleanup

Copy the bounded figures into a tracked report **before** the worktree is
removed: SHAs, commands, versions, per-run figures, load and memory, and the
complete identity table. A worktree can be recreated between cycles, and
gitignored raw data goes with it (optimization report §7). Mask checkout, home
and temp paths, cap lists, and never commit `.mutation/`, `.test-cost/` or
`.changed-file-timing*` content.

### 10.8 What this runbook never does

- schedule itself, or add a cron job, workflow node or CI job;
- add mutation testing to `npm test`, per-PR CI, ordinary review or the
  runtime workflow;
- run mutation testing over the whole repository as a first step;
- change live `sessions.json`, runner policy, global locks or cross-project
  scheduling;
- kill unrelated processes, delete a run lock, or chain long runs behind a
  foreground command to get past an executor timeout.

## 11. What stays local

- `.mutation/dry-run/` and `.mutation/pilot/` from run `9313ec43…` and run
  `6a5307de…`: `mutation.json`, `mutation.html`, `run.log`, `build.json`,
  `run-spec.json`, `run-state.json` and the summaries. They are gitignored. The
  raw report embeds whole source files, and it was not published or uploaded.
- Everything in §4–§6 was copied from those files while they existed, so this
  report remains F2's record after the worktree is cleaned up.

## 12. Limitations

- One F2 run, taken once, with no repeat for a tidier score. Its `Timeout` rows
  are as unstable as F1's were (§6.3).
- P1's saving rests on two warm samples per half on a shared host, and its after
  half includes one unrelated failure (§3).
- The mutation evidence is supporting evidence about fault detection in 38
  mutants. It is not proof that any test is redundant, or that every possible
  defect remains detectable.
