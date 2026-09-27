# Low-risk test optimization (Test Maintenance Pilot, slice 6)

Issue #1114. Implements the approved **P1** and **P2** of
[`test-maintenance-plan.md`](test-maintenance-plan.md) §3, under that plan's §5
measurement rules and §7 (#1114) ordering, and takes mutation run **F1** (§5.2,
§8 F). P3 and P4 are out of scope and were not touched. P5–P8 authorize nothing
and nothing here acts on them. #1115 and #1116 are not activated by this slice.

The operator's priority is verification quality over speed or test count. This
report states a speedup only if the measured pair shows one larger than the
suite's own noise (§5.4 item 4). "No measurable speedup" is an acceptable
result and would be reported as such.

## 0. Status

| Step (plan §7, #1114) | State |
|---|---|
| Cost **before** half, §5.1 protocol, at the base | **Done**: complete and valid (§3.4) |
| Mutation run **F1** at the same base, not overlapping the cost half | **Done**: complete, 38 of 38 mutants reached a terminal status (§5) |
| **P1** implemented alone | **Done**, in `test/admin-retention.test.js` only (§3) |
| Cost **after** half for P1 | **Done** at the committed P1-only head `9e12b1fe`: complete, same cache protocol (§3.4) |
| P1 retain/revert decision (§5.4) | **Retained.** The retention suite's median fell by 7.13 s, and the noise gap it had to exceed was 2.12 s (§3.5) |
| **P2** added | **Done**, after the P1 cost pair closed, in `test/tool-request-grant.test.js` only (§4) |
| `npm test` at the changed head | Run by the loop's configured verification; not claimed here |
| F2 (the after half of F1) | **#1116's**, not this slice's (§6) |

This report was updated in place as the pending steps closed.

## 1. Inherited head

- Predecessor: #1113, PR #1179, reviewed head
  `be5563aae5c3d6b24d98d4fef17be85809ce650d` (branch `ai/issue-1113`).
- This branch's base is that same commit. **No head drift**: `git rev-parse HEAD`
  at the start of both measurements was `be5563aa…`, and every measurement
  began from a clean worktree (checked, not assumed; §3.3, §5.1).
- Plan sections read before any edit: §3 P1/P2, §5, §7 (#1114), §8 F.

## 2. The order the work ran in

All times UTC, 2026-09-24. No two measurements overlapped. No edit was made
until both *before* measurements had finished, and no tracked file was edited
while the *after* half ran (step 6). Its script refuses a dirty tree before the
build, after the build and after the runs.

| # | Step | Start | End | Head |
|---|---|---|---|---|
| 1 | Cost *before* half (§5.1): clear Jest cache, `dist/` removed, timed build, clean recheck, discarded warm-up, `--repeat 2 --max-workers 4 --skip-build --out .test-cost/before` | 15:13:04 | 15:35:13 | `be5563aa`, clean before build, after build and after the runs |
| 2 | F1 dry run: `npm run mutation:dry-run:start`, then polled `mutation:dry-run:report` | 15:38:12 | ≈15:41 | `be5563aa`, clean |
| 3 | F1 pilot: `npm run mutation:pilot:start`, then polled `mutation:pilot:report` | 15:41:30 | 17:07:44 | `be5563aa`, clean |
| 4 | P1 edit (§3), committed as `9e12b1fe` | after 17:07:44 | — | test file and this report only |
| 5 | Cost *after* half: the same script and protocol as step 1, `--out .test-cost/after` | 17:42:26 | 18:03:49 | `9e12b1fe`, clean before build, after build and after the runs |
| 6 | §5.4 decision on P1: retained (§3.5) | after 18:03:49 | — | — |
| 7 | P2 edit (§4) | after step 6 | — | uncommitted, test file and this report only |

Both launches used only the supported `:start`/`:report` pairs, with matching
arguments and the default `.mutation/` output location. Neither the harness
nor its configuration was changed. The runs went in the background because the
Tool Request executor has a 120 s outer timeout; each was treated as passed only
when its `--report` read `finished` with `state: complete (passed)`. Starting
one in the background did not count as passing.

## 3. P1: `admin-retention.test.js`, 10 of 11 cases moved to `runAdmin`

### 3.1 The change

- Added `async function run(...args) { return runAdmin(args); }` over the
  existing `test/helpers/admin-cli.js` harness. The existing `execFileSync`
  helper is kept unchanged and renamed `runSpawned()`.
- **Helper invocations, recounted at the base:** 27, matching the plan. **25
  moved**, and every one is now awaited, including the nested
  `parse(await run(...))` form. **2 stay spawned**: the `backup create` and
  `backup restore` of the missing-artifact-directory case. The file's two
  `better-sqlite3` prepared-statement `.run(...)` calls (in the fixtures of the
  missing-artifact case and the unresolved-Tool-Request case) are synchronous
  database writes, not the helper. They were left exactly as they were.
- **No `expect(...)` line changed.** `git diff -U0` of the file contains no
  added or removed line with `expect` in it. No case was deleted, merged,
  renamed or weakened, and no fixture, `beforeEach`/`afterEach`, comment about
  lock behaviour or Jest timeout was touched. The `:313`→`:283` consolidation is
  not done (plan P8).
- No `--sessions-path` was added, and no production file or shared helper
  changed.

### 3.2 Retained-case mapping

Base line → line at the P1 head. Every assertion column is carried over
verbatim.

| Base | P1 head | Case | Protected assertions (plan §3 P1 record 2) | Mode |
|---|---|---|---|---|
| `:76` | `:89` | create / list | `taskCount`; listed entry id | in-process |
| `:91` | `:104` | restore requires `--yes` | `wouldRestore`; `ok`, `preRestorePath`, `artifactCheckSkipped`; **no `maintenance_lock` row**, read through a separate read-only connection opened after the command returns and closed | in-process |
| `:115` | `:128` | restore with the live DB missing | `ok`; restored `COUNT(*) FROM tasks` = 1; **no `maintenance_lock` row**, read the same way | in-process |
| `:144` | `:157` | restore refuses when an artifact directory is gone | **`restored.code` not 0: a real process exit status**; `ok:false`; `artifactDir` error; live DB untouched (fresh `SqliteTaskStore`) | **spawned, both calls** |
| `:188` | `:201` | preview counts | eligible `[1]`; `excluded.active` 1; task still readable | in-process |
| `:205` | `:218` | preview is read-only | no `retention_*` tables | in-process |
| `:218` | `:231` | prune gating | `wouldPrune`; `backup_precondition_failed` | in-process |
| `:230` | `:243` | unresolved Tool Request does not block coverage | `ok`; reason not `rollup_coverage_missing`; `tasksDeleted` 1; task 1 kept, task 2 gone | in-process |
| `:272` | `:285` | refuses without rollup coverage | `ok:false`; `rollup_coverage_missing` | in-process |
| `:283` | `:296` | intervention counts survive pruning | before/after `human_review_return` 1; `entriesWritten` ≥ 1; backup `ok`; prune `ok`, `tasksDeleted` 1; task gone; totals equal | in-process |
| `:313` | `:326` | prune status watermark | `watermark.status` `complete` | in-process |

**What the move does not claim.** The suite observes `maintenance_lock` only
*after* a command returns, and only its **absence**. It can catch a regression
that leaks a lock row. It cannot catch one that skips taking the lock. That gap
is the plan's (§3 P1 record 2), and it was there before this change. This
slice neither closes it nor describes the moved cases as covering lock
acquisition. The comments that describe the seeding stay as they were.

### 3.3 Divergence reads (plan §3 P1, "four checks")

Read at `be5563aa` in `src/cli/admin.ts`, before any case moved.

| Command (handler) | Divergence 1: a `die()` whose cleanup depends on process exit | Divergence 3: stores/locks closed without process death |
|---|---|---|
| `interventions` (`runInterventions`, `:13066`) | `die()` only on argument errors and when the DB cannot be opened, both before any handle exists | read-only `Database` closed in `finally` (`:13109-13111`) |
| `backup create` (`runBackupCreate`, `:13141`) | `die()` only on argument errors; failures `emit` + `process.exitCode` + `return` | `createBackup` closes the databases it opens |
| `backup list` (`runBackupList`, `:13155`) | `die()` only on argument errors | reads the manifest; opens no store |
| `backup restore` (`runBackupRestore`, `:13163`) | never `die()`s after parsing; every path is `emit` + `process.exitCode` + `return` | `oldLock`/`liveLock` released and closed in its own `finally`. Already analysed by the plan (§3 P1 record 2), unchanged at this head |
| `maintenance preview` (`runMaintenancePreview`, `:13321`) | `die()` only on argument errors | read-only `SqliteRetentionStore` closed in `finally` (`:13343-13345`) |
| `archive rollup` (`runArchiveRollup`, `:13352`) | `die()` on argument errors and on a missing DB (`:13359`), both before the lock is constructed | lock-contended path closes the lock (`:13375`); otherwise store closed, then lock released and closed, in `finally` (`:13393-13397`) |
| `prune run` (`runPruneRun`, `:13404`) | every `die()` (`:13411`, `:13420`, `:13423`) comes before the registry read, the stores, the pin and the lock | preview store closed in `finally` (`:13448-13450`); retention store closed, lock released and closed, backup unpinned, each in nested `finally`s (`:13565-13574`) |
| `prune status` (`runPruneStatus`, `:13577`) | `die()` only on argument errors | store closed in `finally` (`:13593-13595`) |

So none of the moved commands relies on process death for a release, a close or
an exit status. A moved case's `code` is not asserted anywhere; only
`:144`/`:157` asserts one, and that case stays spawned. One latent issue was
seen and is **not** this slice's to fix: in `runArchiveRollup` the
`SqliteRetentionStore` is constructed at `:13381`, outside the `try` whose
`finally` releases the lock. A constructor throw there would leave the lock row
behind. No case reaches that path in either mode, so the move changes nothing
about it. It is recorded here for a separate Issue (unlike `runPruneRun`,
which constructs its store inside the `try`, `:13549-13555`).

**Divergence 2, `DEFAULT_SESSIONS_PATH`.** The cases pass
`--session-id addon-dev` and never `--sessions-path`. Only `prune run` reads the
registry (`:13431-13437`), and it treats a read failure as "no session". Both
modes resolve `DEFAULT_SESSIONS_PATH` (`src/registries/json-session-registry.ts:63`)
from the same test-owned `HOME` (#1063). The spawned child inherits the
worker's environment because `runSpawned` passes no `env`, and the in-process
module is imported under the `HOME` that `setupFiles` pinned. So the resolved
path, and whatever the registry read returns, is the same in both modes.
`--sessions-path` was deliberately not added.

**Divergence 4, `env` to child processes.** Not reached: none of these commands
spawns anything.

**One in-process difference, and why it cannot weaken the moved cases.** Lock
holder strings embed `process.pid`. In-process, every run in a worker shares one
pid, where the spawned runs had a fresh, then-dead one each. Every lock is
released before its command returns, and the two restore cases assert that
directly, so no row carries a holder into the next run. The pid is part of a
string no case asserts on.

**Fixture independence and order isolation** are unchanged: `beforeEach` still
creates a private `mkdtemp` directory (DB, backups, `sessions.json`) and
`afterEach` removes it. `runAdmin` snapshots and restores `process.env`,
`process.cwd()`, `process.exitCode` and the output mode around every run, and
the output mode is decided from argv alone.

### 3.4 Cost measurement

Both halves ran the same gitignored script, `sh .test-cost/half.sh <before|after>`,
from the repository root. It is the §5.1 sequence: a clean-tree check, Jest
cache cleared, `dist/` removed, a timed `npm run build`, a second clean-tree
check, one discarded warm-up that must pass, then
`node scripts/test-cost-baseline.mjs --repeat 2 --max-workers 4 --skip-build
--out .test-cost/<half>` and a third clean-tree check. Each half has its own
output directory, and the script refuses to overwrite an existing one.

| Field | Before | After |
|---|---|---|
| SHA | `be5563aae5c3d6b24d98d4fef17be85809ce650d` | `9e12b1fe1b426f668df45b2495d3625002c71a53` |
| Clean worktree | before the build, after the build, after the measured runs | the same three checks, all clean |
| Toolchain | Node v22.6.0, npm 10.8.2, Jest 29.7.0, TypeScript 6.0.3 | identical |
| Host | Apple M2 laptop, darwin 24.6.0 arm64, 8 CPUs, 24 GiB | the same host |
| Workers | `--maxWorkers=4` (warm-up and both measured runs) | identical |
| Cache protocol | Jest cache cleared (`--clearCache`); `dist/` **removed** before the timed build; one discarded warm-up run, which **passed** | identical; warm-up **passed** (17:42:34–17:49:32) |
| Build (timed apart) | 9.54 s real | 6.84 s real (9.54 s user, 0.59 s sys) |
| Load, 1/5/15 min | 4.92/4.24/4.00 at start; 7.93/7.19/5.58 before run 1; 8.68/9.72/7.51 between runs; 5.88/8.18/7.73 after run 2 | 2.42/3.15/4.30 at start; 6.56/7.37/6.09 before run 1; 11.46/8.74/7.10 between runs; 7.51/7.80/7.21 after run 2 |
| Free memory | ≈0.1 GB at start (7 116 free pages × 16 KiB); ≈2.2 GB before the measured runs; ≈2.6 GB after each run | ≈0.3 GB at start (19 531 pages); ≈2.5 GB before the measured runs (149 895 pages); ≈2.7 GB after run 1, ≈2.8 GB after run 2 |
| Full run, warm | run 1 **463.9 s**, run 2 **428.7 s** (317 suites, 13 770 tests, 0 failed, 8 skipped, both runs) | run 1 **408.2 s** (0 failed, 8 skipped); run 2 **447.9 s** (**1 failed**, 8 skipped; see below) |
| `test/admin-retention.test.js`, warm | run 1 **10.39 s**, run 2 **6.14 s**, so median 8.27 s, max 10.39 s, **median-to-max gap 2.12 s** (11 tests, all passed) | run 1 **0.90 s**, run 2 **1.38 s**, so median 1.14 s, max 1.38 s, gap 0.24 s (11 tests, all passed, both runs) |

Every measured run is **warm**: the discarded warm-up ran before run 1, so run 1
is not a cold sample (§5.3). The host was shared with other projects the whole
time. The load figures above are that load, and no unrelated process was
stopped. The after half's load between its runs (11.46) was higher than any
the before half saw.

**The pair is comparable (§5.3).** Within the cost input set,
`git diff --stat be5563aa..9e12b1fe` has exactly one change,
`test/admin-retention.test.js`, and it is P1. The only other file in the diff is
this report, which is out-of-set: `docs-feature-status.test.js` lists only
top-level `docs/*.md`, and `metrics-script.test.js` reads only
`latest.json`/`latest.md`. The cache protocol, toolchain, host, worker count and
command are identical on both sides.

**After run 2's one failure is outside the change and was not hidden.**
`test/codex-structured-review.test.js:1323`, the ENOSPC isolation-directory
leak check, found three new `ai-codex-review-{cwd,home,io}-*` entries in the
shared `os.tmpdir()`. That set is one complete isolation triple from some other
review that was running concurrently. The test's own comment says concurrent
reviews create and remove such directories in the same place, and the triple is
consistent with that race. It is not consistent with the stubbed call under
test, which throws before it creates any directory. The same suite passed in
after run 1, the warm-up and both before runs. P1 changes nothing that suite
reads. This is a failure in a measured run, not in one of §5.1's prerequisites
(clean tree, build, warm-up), so the half was not restarted. It is published
here, and the full-run wall times, which no decision rests on, carry it. The
race itself is left for a separate Issue.

**Build time is not compared.** The build is timed apart and P1 changes no build
input. The before half's raw build log was lost when the runner recreated this
worktree (§7), so it can no longer be rechecked whether its 9.54 s was the
`real` line. The after build's `user` line happens to read the same 9.54 s. No
decision here uses build time either way.

### 3.5 Decision (§5.4): P1 is retained

The rule, fixed in this report before the after half existed: P1 counts as a
speedup only if the retention suite's figure drops by more than that suite's
observed median-to-max gap. The gap is 2.12 s (before), or the after half's own
gap if that is larger (it is 0.24 s).

| §5.4 step | Result |
|---|---|
| 1. Assertions | Every protected assertion is present, at the same boundary (§3.2). The one real process exit assertion is still spawned |
| 2. Suite result | `npm test` at the changed head is the loop's configured verification, not claimed here. The retention suite passed in all four measured runs and both warm-ups |
| 3. Detection | Not applicable to P1: it has no mutation evidence in either direction (plan §3 P1 record 4) |
| 4. Benefit | Median **8.27 s → 1.14 s**, a **7.13 s** drop, which is more than the 2.12 s gap. The slower after run (1.38 s) is still faster than the faster before run (6.14 s). **This is a measurable speedup for this suite** |

On the whole-suite wall time, this report claims **nothing**. Medians were
446.3 s before and 428.1 s after, but each half's two runs are 35–40 s apart,
so an 18 s difference is inside that noise, and the after half had a single
failure. The saving P1 can claim is the retention suite's own, about 7 s of
worker time per full run, spread over four workers.

## 4. P2: the grant expiry boundary

Added **after** the P1 cost pair closed and P1's §5.4 decision was recorded
(§3.5), as the plan's §7 step 3 requires, so the P1 pair stayed a single change.
The case is additive. It is inserted in `test/tool-request-grant.test.js`'s
`tool-request-grant — status` block, between the "expired" and "exhausted"
cases. The three existing cases (`:132` active, `:136` expired, `:141` exhausted
at the base) are unchanged, and no other line of the file moved except the
"exhausted" case, which moved down six lines:

```js
test('expired at exactly expiresAt (boundary; issue #1112 survivor 10)', () => {
  const g = baseGrant({ ttlMs: 1000 });
  expect(grantStatus(g, g.expiresAt)).toBe('expired');
  expect(grantStatus(g, new Date(Date.parse(g.expiresAt) - 1).toISOString())).toBe('active');
});
```

It records how production already behaves (`src/core/tool-request-grant.ts:242`
uses `>=`), with no source change and no speedup claimed. `now` is derived from
the grant's own `expiresAt`, so the case stays on the boundary if the default
TTL or its clamp ever changes. Under the `>=` → `>` mutant, `now === expiresAt`
returns `active`, which the first assertion rejects. The second assertion keeps
the case from passing if the boundary moves the other way. F1 was taken for it
(§5), and F1 at `be5563aa` shows the target mutant **Survived**. Whether it is
now killed is F2's to measure (§6). This report does not claim it from the diff.

## 5. F1: the mutation *before* half for P2

### 5.1 Provenance

| Field | Value |
|---|---|
| Run id | `c56e6cc3-06d6-4269-be33-39594e583c15` |
| Commit | `be5563aae5c3d6b24d98d4fef17be85809ce650d`, worktree clean |
| Scope | mutate `src/core/chain-linear.ts:329-359`, `src/core/tool-request-grant.ts:237-244`; tests `chain-linear`, `admin-chain-edit`, `tool-request-grant`, `admin-tool-request-grant` (`.test.js`). Frozen, not widened |
| Configuration | concurrency 2; `timeoutMS` 60000; `timeoutFactor` 2; `coverageAnalysis: off`; incremental off; budget 180 min; StrykerJS defaults, no mutator excluded, no checker |
| Toolchain | Node v22.6.0, StrykerJS 8.7.1, `@stryker-mutator/jest-runner` 8.7.1, Jest 29.7.0 |
| Dry run | 38 mutants instrumented; 180 tests, one pass 2 min 55 s (net 174 421 ms), 184.6 s wall; state complete (passed) |
| Pilot | wall **5153.8 s (85 min 54 s)**, within the 180-min budget; exit 0, not timed out, no surviving process group; state complete (passed) |
| Per-mutant deadline | about 410 s (60 000 ms + 2 × net dry-run time + overhead) |
| Sandbox build | `tsc` exit 0, 0 diagnostic lines; both scoped files emitted and instrumented |
| Load, 1/5/15 min | 1.77/5.28/6.60 before the dry run; 2.96/4.53/6.05 → 3.52/4.42/4.74 over the pilot; 2.80/4.20/4.65 at the end |
| Free memory | ≈1.4 GB before the dry run, ≈1.2 GB at pilot start, ≈1.1–1.2 GB at the end |

### 5.2 Outcomes

Every outcome is kept separate. A `Timeout` is a detection only by StrykerJS's
deadline, never by an assertion.

| Outcome | Count |
|---|---|
| Killed | **25** |
| Survived | **8** |
| Timeout | **4** |
| RuntimeError | **1** |
| NoCoverage / CompileError | 0 / 0. The 0 under NoCoverage is structural under `coverageAnalysis: off`, not a measurement |
| Total | 38 of 38, all terminal |

Readings: StrykerJS score 78.38 % ((25 + 4) / 37); **assertion-observed
25 / 37 = 67.6 %**; over everything instrumented, 25 / 38 = 65.8 %. Killed per
suite: `admin-chain-edit` 14, `tool-request-grant` 9, `admin-tool-request-grant`
2, `chain-linear` 0. Every killed mutant has exactly one `killedBy` entry.
**`coveredBy` is unknown for every mutant**: `coverageAnalysis: off` cannot
produce it. An empty coverage column here is not evidence that nothing was
covered, and nothing in this report claims coverage was preserved.

### 5.3 Identity table (all 38)

Location is `line:column` start–end in the mutated file. Match rows by
location + mutator + original + replacement, never by row order. `tests` is
StrykerJS's `testsCompleted`; `—` means none recorded.

**`src/core/chain-linear.ts`**

| Location | Mutator | Original → replacement | Status | `killedBy` | tests |
|---|---|---|---|---|---|
| 329:48–331:2 | BlockStatement | `edgeKey` body → `{}` | Killed | `admin-chain-edit.test.js:839` | 180 |
| 330:10–330:66 | StringLiteral | `edgeKey`'s template literal → empty template literal | Killed | `admin-chain-edit.test.js:839` | 180 |
| 333:69–335:2 | BlockStatement | `compareEdges` body → `{}` | Survived | — | 180 |
| 334:10–334:100 | ConditionalExpression | `a.blockerIssueNumber - b.blockerIssueNumber \|\| a.blockedIssueNumber - b.blockedIssueNumber` → `true` | Survived | — | 180 |
| 334:10–334:100 | ConditionalExpression | same → `false` | **Timeout** | — | — |
| 334:10–334:100 | LogicalOperator | `\|\|` → `&&` | Survived | — | 180 |
| 334:10–334:53 | ArithmeticOperator | `a.blockerIssueNumber - b.blockerIssueNumber` → `a.blockerIssueNumber + b.blockerIssueNumber` | Survived | — | 180 |
| 334:57–334:100 | ArithmeticOperator | `a.blockedIssueNumber - b.blockedIssueNumber` → `a.blockedIssueNumber + b.blockedIssueNumber` | Survived | — | 180 |
| 338:65–344:2 | BlockStatement | `linkEdges` body → `{}` | Killed | `admin-chain-edit.test.js:362` | 180 |
| 339:35–339:37 | ArrayDeclaration | `[]` → `["Stryker was here"]` | Killed | `admin-chain-edit.test.js:362` | 180 |
| 340:19–340:36 | EqualityOperator | `i < issues.length` → `i <= issues.length` | Killed | `admin-chain-edit.test.js:362` | 180 |
| 340:19–340:36 | ConditionalExpression | `i < issues.length` → `false` | **Timeout** | — | — |
| 340:19–340:36 | EqualityOperator | `i < issues.length` → `i >= issues.length` | **RuntimeError** (test runner crashed; restarted twice) | — | — |
| 340:38–340:44 | AssignmentOperator | `i += 1` → `i -= 1` | **Timeout** | — | — |
| 340:46–342:4 | BlockStatement | loop body → `{}` | Killed | `admin-chain-edit.test.js:526` | 180 |
| 341:16–341:84 | ObjectLiteral | edge object → `{}` | Killed | `admin-chain-edit.test.js:362` | 180 |
| 341:45–341:50 | ArithmeticOperator | `i - 1` → `i + 1` | Killed | `admin-chain-edit.test.js:362` | 180 |
| 353:60–359:2 | BlockStatement | `resolveRoots` body → `{}` | Killed | `admin-chain-edit.test.js:839` | 180 |
| 354:44–354:71 | ArrowFunction | `(e) => e.blockedIssueNumber` → `() => undefined` | Killed | `admin-chain-edit.test.js:839` | 180 |
| 355:10–357:56 | MethodExpression | `….filter((issueNumber) => !blocked.has(issueNumber))` dropped → `target.members.map(m => m.issueNumber)` | Killed | `admin-chain-edit.test.js:839` | 180 |
| 355:10–358:27 | MethodExpression | `.sort((a, b) => a - b)` dropped → `target.members.map(m => m.issueNumber).filter(issueNumber => !blocked.has(issueNumber))` | **Timeout** | — | — |
| 356:10–356:30 | ArrowFunction | `(m) => m.issueNumber` → `() => undefined` | Killed | `admin-chain-edit.test.js:839` | 180 |
| 357:13–357:55 | ArrowFunction | `(issueNumber) => !blocked.has(issueNumber)` → `() => undefined` | Killed | `admin-chain-edit.test.js:839` | 180 |
| 357:30–357:55 | BooleanLiteral | `!blocked.has(issueNumber)` → `blocked.has(issueNumber)` | Killed | `admin-chain-edit.test.js:866` | 180 |
| 358:11–358:26 | ArrowFunction | `(a, b) => a - b` → `() => undefined` | Survived | — | 180 |
| 358:21–358:26 | ArithmeticOperator | `a - b` → `a + b` | Survived | — | 180 |

**`src/core/tool-request-grant.ts`**

| Location | Mutator | Original → replacement | Status | `killedBy` | tests |
|---|---|---|---|---|---|
| 240:39–244:2 | BlockStatement | `grantStatus` body → `{}` | Killed | `tool-request-grant.test.js:132` | 180 |
| 241:7–241:34 | ConditionalExpression | `grant.uses >= grant.maxUses` → `true` | Killed | `admin-tool-request-grant.test.js:220` | 180 |
| 241:7–241:34 | ConditionalExpression | same → `false` | Killed | `tool-request-grant.test.js:141` | 180 |
| 241:7–241:34 | EqualityOperator | `>=` → `grant.uses > grant.maxUses` | Killed | `tool-request-grant.test.js:141` | 180 |
| 241:7–241:34 | EqualityOperator | `>=` → `grant.uses < grant.maxUses` | Killed | `tool-request-grant.test.js:132` | 180 |
| 241:43–241:54 | StringLiteral | `"exhausted"` → `""` | Killed | `tool-request-grant.test.js:141` | 180 |
| 242:7–242:69 | ConditionalExpression | `new Date(now).getTime() >= new Date(grant.expiresAt).getTime()` → `true` | Killed | `admin-tool-request-grant.test.js:220` | 180 |
| 242:7–242:69 | ConditionalExpression | same → `false` | Killed | `tool-request-grant.test.js:136` | 180 |
| 242:7–242:69 | EqualityOperator | `>=` → `new Date(now).getTime() > new Date(grant.expiresAt).getTime()` | **Survived** (P2's target; #1112 survivor 10) | — | 180 |
| 242:7–242:69 | EqualityOperator | `>=` → `new Date(now).getTime() < new Date(grant.expiresAt).getTime()` | Killed | `tool-request-grant.test.js:132` | 180 |
| 242:78–242:87 | StringLiteral | `"expired"` → `""` | Killed | `tool-request-grant.test.js:136` | 180 |
| 243:10–243:18 | StringLiteral | `"active"` → `""` | Killed | `tool-request-grant.test.js:132` | 180 |

`killedBy` names the killing test by file and the line of its `test(` call at
`be5563aa`. Those lines are:

- `admin-chain-edit.test.js:839`: append extends past the head and moves it
- `:362`: an Issue of the same number in another repository does not block a new chain
- `:526`: preview writes nothing
- `:866`: prepend attaches ahead of the root
- `tool-request-grant.test.js:132`: active
- `:136`: expired once now passes expiresAt
- `:141`: exhausted
- `admin-tool-request-grant.test.js:220`: refuses to execute when the checkout is dirty

Per killer: `:839` 7, `:362` 5, `:526` 1, `:866` 1, `:132` 4, `:141` 3, `:136`
2, `admin-tool-request-grant:220` 2. That is 25.

### 5.4 What differs from #1112, reported and not explained away

F1 is **not** compared *against* #1112 as a pair: #1112 is never a before half
in this pilot (plan §5.2). But plan §1.2 found no drift in the mutation input
set since #1112, and F1 ran at the same frozen scope, configuration and
toolchain. So a difference between the two runs is **run-to-run variation at
unchanged inputs**, and it bears directly on how #1116 reads F2:

- The **25 killed** mutants and the per-killer counts match #1112 §5.2 exactly,
  and so do the per-suite kill counts (14 / 9 / 2 / 0).
- Survivor 10 (`tool-request-grant.ts:242:7`, `>=` → `>`) is **Survived** in both.
- **Two rows moved from `Survived` in #1112 to `Timeout` in F1:**
  `chain-linear.ts:334:10` ConditionalExpression → `false` (#1112 survivor 3),
  and `chain-linear.ts:355:10–358:27` MethodExpression, the `.sort` dropped
  (#1112 survivor 7). Both record no completed tests. Neither mutant can loop:
  a comparator that always returns `false` keeps input order, and dropping the
  `.sort` only leaves the roots unsorted. So non-termination does not explain
  these timeouts, and this report does not claim a cause. They are counted as
  `Timeout`, never as assertion evidence. Re-running to tidy them up would be a
  different measurement, not a clarification, so no re-run was done. The
  RuntimeError (`340:19`, `>=`) and the other two timeouts (`340:19` → `false`,
  `340:38` `-=`) match #1112.

**Consequence for F1 → F2.** The plan expects exactly one row to move between
F1 and F2 (survivor 10 to `Killed` by `tool-request-grant.test.js`). F1 shows
that at least these two `chain-linear.ts` rows can move between `Survived` and
`Timeout` with no change to any input. If F2 moves them, #1116 must report the
movement and set it against this observation. It must not treat it as a
regression caused by P2, and it must not drop it as noise either.

## 6. Hand-off to #1116

- **F2 is #1116's.** It must be taken at the pilot's final head at the same §5.2
  identity, and must publish its own 38-row identity table in this format.
- The expected F1 → F2 movement is survivor 10 (`tool-request-grant.ts:242:7`,
  EqualityOperator, `>=` → `>`) becoming **Killed**, by
  `tool-request-grant.test.js`, by the case added in §4. That holds only if
  P2 lands. It is on this branch, but if review parks or rejects it, F1 → F2
  becomes a comparison of unchanged inputs. If survivor 10 is **not** killed in
  F2, that is a finding about the added case (plan §5.4 item 3), not a formality.
- Kill-side acceptance (plan §5.4 item 3): no mutant killed in F1 may be
  anything but killed in F2, and no mutant may newly survive. The coverage side
  stays **unverified** (`coverageAnalysis: off`). P2 is additive, so no
  existing case that covered a mutant changes. That is an argument from the
  diff, not a measurement.
- Watch the two `Survived`/`Timeout` rows in §5.4.
- P1 does not affect F1 → F2: `admin-retention.test.js` is not a scoped suite
  and imports nothing in the mutation input set. This report is out-of-set for
  the mutation comparison as well.

## 7. What stays local

Nothing raw was committed or uploaded. Only the bounded figures and identities
above are published.

**Raw data from the before measurements is no longer on disk.** Between this
slice's first cycle and its review-fix cycle, the runner recreated this
worktree. That discarded the gitignored `.test-cost/before/`, the before-half
logs, `.mutation/dry-run/` and `.mutation/pilot/` (`mutation.json`,
`mutation.html`, `run.log`, summaries), and the original `half.sh` and `f1.sh`.
The before-half and F1 figures in §3.4 and §5 were copied out of those files
while they still existed. They cannot be re-derived now, and the one
before-half value that could not be rechecked is marked as such in §3.4. The
F1 run id (§5.1) identifies the run, but its report is not retained. #1116
takes F2 at its own head and does not need F1's raw files: the published
38-row table is F1's record.

Still local, in gitignored paths, from the review-fix cycle:

- `.test-cost/after/` (`jest-run-1.json`, `jest-run-2.json`, `baseline.json`,
  `report.md`), `.test-cost/after-half.log`, `after-build.log` and
  `after-warmup.log`
- `.test-cost/half.sh`, rewritten to the same §5.1 sequence. It also stamps
  load, free pages and each clean-tree check into the half log

## 8. Limitations

- Two warm runs per half give a crude spread (§5.4 item 4). The before half's
  retention figures differ by 4.25 s between its own two runs, on a loaded,
  shared host. P1's 7.13 s drop clears that, but the two-sample spread is still
  the only noise estimate available.
- P1's saving is the retention suite's own. The full-run wall time cannot
  resolve a change this size (§3.5), so no whole-suite speedup is claimed.
- One measured run (after run 2) had one failure outside the change, a
  shared-tmpdir race in `codex-structured-review.test.js` (§3.4). It is
  reported, not filtered out, and it needs its own Issue.
- The mutation evidence covers 38 mutants over 39 source lines in two files.
  It says nothing about the rest of the project, and it is not proof that any
  test is redundant or that every defect in scope would be detected.
- P1 has no mutation evidence in either direction (plan §3 P1 record 4). Its
  preservation argument rests on the assertion mapping and divergence reads in
  §3, not on a score.
