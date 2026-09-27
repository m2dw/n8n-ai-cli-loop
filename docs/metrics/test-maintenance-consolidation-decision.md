# Consolidation decision (Test Maintenance Pilot, slice 7)

Issue #1115. This slice changes documentation only. It records that every
consolidation and removal candidate the pilot has examined is **retained
unchanged**. Where [`test-maintenance-plan.md`](test-maintenance-plan.md) (#1113)
or [`test-maintenance-optimization.md`](test-maintenance-optimization.md) (#1114)
already give the evidence, this report links to it rather than repeating it.

## 0. Result

| Question | Answer |
|---|---|
| Consolidations approved | **None** |
| Tests, cases or assertions deleted | **None** |
| Allowed consolidation/removal set | **Empty** |
| Test, production, helper, harness, configuration or workflow files changed | **None**. This file is the only change |
| Measurements started (benchmark, mutation run, repeat of F1, early F2) | **None** |

This is the result the plan expected and recommended for this slice (plan §0 and
§7 #1115). It is reported as a result. It is not a gap to fill, and no new
candidate was invented to give the slice work.

## 1. Inherited heads and reconciliation

| Field | Value |
|---|---|
| Accepted plan | #1113, PR #1179, head `be5563aae5c3d6b24d98d4fef17be85809ce650d` |
| Accepted predecessor | #1114, PR #1180, head `640829ed6603829a3fb5c85ff834b8c8efc68894`, branch `ai/issue-1114`, `status:stack-ready` |
| This branch's head at the start | `640829ed…`: **no drift** from the head the Issue names |
| `git diff --stat be5563aa..640829ed` | three files: `docs/metrics/test-maintenance-optimization.md`, `test/admin-retention.test.js` (P1), `test/tool-request-grant.test.js` (P2) |
| Same diff restricted to `src/`, `test/admin-tool-request-grant.test.js`, `test/chain-linear.test.js`, `test/admin-chain-edit.test.js`, `test/issue-refinement-observability.test.js` | **empty** |

So every candidate suite except the two #1114 touched is byte-identical to the
revision the plan reasoned about. The plan's line numbers still hold for them.
For the two files #1114 touched, §2 gives the lines as they are at `640829ed`.

I read plan §0, §3 P5–P8 and §7 (#1115, #1116), and optimization report §0,
§3.2, §3.4–§3.5, §4, §5 and §7. Nothing in them contradicts this slice's scope.
§2 P5 adds one note on wording, and it does not change the decision.

## 2. Decision table

Line numbers are at `640829ed`. A case is named by its `describe` › `test`
title, which stays stable if lines shift.

| # | Candidate as proposed | Actual inherited tests | Protected facts | Evidence | Decision |
|---|---|---|---|---|---|
| P5 | Consolidate the admin quoted-whitespace case against the pure `normalizeCommand`/`hashCommand` cases | `test/admin-tool-request-grant.test.js:1473-1486`: `admin CLI — tool-request grant: quoted-whitespace exactness` › `rejects a --command that differs only in quoted whitespace` (`:1474`, the only case in its describe). Compared against `test/tool-request-grant.test.js:54`, `:61`, `:65`, `:74`, `:83` and `:91` in `tool-request-grant — normalize & hash`. P2 did not move these lines: it went in at `:141`, after the block closes at `:97` | (1) `--command 'printf "a  b"'` reaches the grant handler through the admin CLI's argument parsing and does not match the stored `printf "a b"`. (2) Nonzero `code`, with `ok:false` and `exact-command only` in the error envelope (`:1480-1481`). (3) `task.context.toolRequest.resolved === false` in SQLite (`:1483`). (4) The outbox is empty (`:1484`) | Plan §3 P5 records 2 and 4. The pure cases call `normalizeCommand`/`hashCommand` on JavaScript strings and reach none of facts 1–4. `normalizeCommand` and `grantMatches` are outside `BASELINE_MUTATE`, so there is no mutation evidence for either side | **Retain unchanged.** The four facts depend on one `run(...)` call, so no partial consolidation exists. Removing the case removes the only argv/task-state/outbox check of this behaviour |
| P6 | Remove `admin-tool-request-grant.test.js` as redundant with the pure suite | The whole file: 72 `test(` cases. The measured killer is `:220`, `admin CLI — tool-request grant: clean worktree` › `refuses to execute when the session checkout is dirty` | The two detections below. Beyond them, the file's CLI, lock, worktree, task-state and outbox facts are not mapped to any replacement | #1112 §5.2 credits `:220` with 2 kills. F1 (optimization report §5.3) gives the same count and names the two mutants: `tool-request-grant.ts:241:7` ConditionalExpression → `true` and `:242:7` ConditionalExpression → `true`. #1112 did not publish identities for its killed mutants. Both `killedBy` entries are singletons. The pure suite's 9 kills are different mutants | **Retain unchanged.** Removing the file loses 2 of the 11 measured kills in the grant region. That evidence protects `:220` in particular. It neither justifies nor forbids a narrower subset, and none is proposed |
| P7 | Treat `chain-linear.test.js` as redundant because it killed nothing | The whole file: 30 `test(` cases in `planLinearChainEdit — new` (`:114`), `— append` (`:196`), `— prepend` (`:354`) and `verifyLinearChainReadBack` (`:426`) | The planner's public plans and refusals, and read-back verification. The frozen mutation range (`chain-linear.ts:329-359`, four small helpers) barely overlaps them | 0 kills in #1112 and 0 in F1. That means there is no before-picture, not that the file is redundant (plan §3 P7). F1 also shows two rows in this range moving between `Survived` and `Timeout` at unchanged inputs (§4), so even the zero is not a stable reading | **Retain unchanged.** A consolidation here could not cite preservation, so no after-check could clear it |
| P8 | Add tests aimed at survivors to raise the score, or consolidate retention cases | F1's 8 survivors: seven in `chain-linear.ts` (`333:69` block; `334:10` → `true`; `334:10` `\|\|` → `&&`; `334:10-53` and `334:57-100` `-` → `+`; `358:11` arrow; `358:21` `-` → `+`) and `tool-request-grant.ts:242:7` `>=` → `>`. There are also two cases a retention merge would join, `test/admin-retention.test.js:326` (`prune status reflects a completed watermark…`, `:313` at the base) and `:296` (`a rollup generated before pruning keeps the intervention count intact…`, `:283` at the base). The `test/issue-refinement-observability.test.js:796` → `:754` merge from #1110 §3.10 is the same kind | The seven `chain-linear.ts` survivors are pre-existing gaps (group A `compareEdges`, group B `resolveRoots` `.sort`), not targets. The two retention cases each keep their own assertion path | Plan §3 P8. `coverageAnalysis: off` cannot tell unreached, equivalent and weakly asserted survivors apart. Merging two cases puts two facts behind one path, so a failure in the first hides the second | **Rejected.** No survivor-targeted test and no case merge. The one justified repair, **P2** (`tool-request-grant — status` › `expired at exactly expiresAt (boundary; issue #1112 survivor 10)`, `test/tool-request-grant.test.js:141`), landed in #1114 and is **not repeated** here |

**Note on P5's wording (the decision stands).** Plan §3 P5 says the
doubled space "has to survive the real command line". At `640829ed` the suite's
`run()` (`test/admin-tool-request-grant.test.js:22-29`) calls the in-process
`runAdmin` harness. So the value arrives as a single argv element to the admin
CLI's parser. It does not pass through a spawned process or a shell. The
boundary the case protects is the CLI's argument parsing and handler, together
with the task-state and outbox effects that follow. The pure suite still reaches
none of those, so the retention reason is unchanged.

## 3. Out of scope for this slice

- **P1** (`admin-retention.test.js` → `runAdmin`) is completed and retained
  (optimization report §3.5: median 8.27 s → 1.14 s for that suite only, with
  no whole-suite speedup claimed).
- **P2** is completed (optimization report §4).
- **P3** and **P4** are deferred optimization proposals (plan §3 P3, P4).

None of these is a consolidation, and none is work for #1115 (plan §7 #1115).
Any later consolidation needs its own evidence, its own retained-case mapping at
the same boundary and its own independent review. This report approves none in
advance.

## 4. Hand-off to #1116

This slice adds nothing to the mutation input set: no mutated source, scoped
suite, `BASELINE_MUTATE` or toolchain change. #1116's obligations in plan §7
(#1116) still stand as written. Changes since the plan, and limits #1116 must
keep:

- **F1's record is the published table.** F1 is run
  `c56e6cc3-06d6-4269-be33-39594e583c15`, taken at `be5563aa`. Its provenance
  is in optimization report §5.1, and its complete 38-row sanitized identity
  table is in §5.3. The raw artifacts behind it were lost when the #1114
  worktree was recreated (optimization report §7): `.mutation/dry-run/`,
  `.mutation/pilot/` (`mutation.json`, `mutation.html`, `run.log`) and the
  before-half cost data. #1116 must not require those files and must not quietly
  regenerate F1. Any detail not printed in §5.1/§5.3 is unrecoverable and must
  be reported that way.
- **F1 → F2 in-set change: P2 alone.** Its target is survivor 10,
  `src/core/tool-request-grant.ts:242:7–242:69`, EqualityOperator, `>=` → `>`.
  It is **Survived** in F1. The intended killer is
  `test/tool-request-grant.test.js:141`. **Nobody has measured that it is now
  killed.** F2 must read its actual status by identity. If it is not `Killed`,
  that is a finding about the added case (plan §5.4 item 3). P1 is not in the
  input set (optimization report §6).
- **Measurement limits carried forward:**
  - `coverageAnalysis: off`, so `coveredBy` is unknown for every mutant. An
    empty coverage column proves nothing, and the coverage side of preservation
    stays unverified.
  - A `Timeout` or `RuntimeError` is not a kill. Only `Killed` with a `killedBy`
    counts as assertion evidence.
  - Two `chain-linear.ts` rows went from `Survived` in #1112 to `Timeout` in F1
    at unchanged inputs: `334:10` ConditionalExpression → `false`, and
    `355:10–358:27` with the `.sort` dropped. If F2 moves any row in that range,
    the movement needs diagnosis against this observation. It must not be
    attributed to P2 automatically, and it must not be dismissed as noise.
- **Cost evidence is not all-pass.** #1114's after half had one failure in
  after run 2: `test/codex-structured-review.test.js:1323`, the
  shared-`os.tmpdir()` isolation-directory leak check (optimization report
  §3.4). This slice does not repair it. That half is not an all-pass cost
  measurement, and its whole-suite wall times support no claim.
- **Still open, and not done or claimed here:**
  - F2 with its dry run, through the `:start`/`:report` pairs, publishing its
    own 38-row table.
  - The final full-project verification at the final head (`npm test`,
    `npm run typecheck`, `npm run package`), complete and passing.
  - `docs/metrics/test-maintenance-outcome.md` and the runbook.

  #1115 contributes no cost pair and no test change to that report. This slice
  does not activate #1116.

## 5. Verification and limits

- The PR changes only this file. No case, assertion or process boundary is
  weakened, because none is touched. No documentation-content test was added.
- `npm test`, `npm run typecheck` and `npm run package` at this head are the
  loop's configured verification. The loop runs them, and this report does not
  claim their results.
- The mutation evidence covers 38 mutants over 39 source lines in two files. It
  supports the P6 and P7 readings. It does not prove that any test is redundant,
  or that every defect in scope would be detected. P5 rests on a boundary
  judgement, P6 on measured detections, and P7 on the absence of any measured
  before-picture.
