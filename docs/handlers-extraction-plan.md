# Handlers extraction boundaries, order, and first tranche

This document is the boundary and sequencing specification for decomposing the
three phase handlers — `src/handlers/implementation.ts` (3,605 lines),
`src/handlers/review.ts` (2,197), `src/handlers/conflict-resolution.ts`
(1,484) — issue #692. It is the `handlers/` analog of
[`admin-extraction-plan.md`](admin-extraction-plan.md) (#712) for `admin.ts`,
but the disease is different and so is the remedy: `admin.ts` suffers from
**breadth** (many unrelated commands in one file), the handlers suffer from
**depth** (long procedures with policy decisions embedded at ~40 sites). The
remedy for breadth is to split by resource; the remedy for depth is to lift
the decisions out first and only split what is still oversized afterwards.

Inputs this document consolidates:

- [`DOMAIN.md`](DOMAIN.md) §2.1 (the razor), §2.2 (the ten policy-extraction
  candidates and the no-second-lifecycle-template ruling), §2.3 (the context
  contracts, #693), §5 derived issue 2 (the five-step remedy order).
- [`design/handlers-responsibility-inventory.md`](design/handlers-responsibility-inventory.md)
  — the 2026-07-19 line-level raw data. **Its line numbers are superseded by
  §1 below**; its SHARED LIFECYCLE section survives as the checklist §3 uses.
- [`phase-contracts.md`](phase-contracts.md) — the externally observable phase
  contract every slice here must preserve byte-for-byte.

**This is a documentation-only issue: no production code is moved or
refactored here.** Everything below is the specification the issues in §11
execute. Where this document differs from the inventory or from #503's draft
wording, this document — reconciled against the current sources on
2026-07-27 — is authoritative.

## 1. Current-state re-derivation (2026-07-27)

The inventory says "line numbers are approximate and will drift; re-derive
before extraction work." Re-derived against `ai/issue-692` (off main @
3972598). Six deltas change the plan materially:

**1.1 File sizes.** implementation 3,741 → **3,605**; review 2,188 →
**2,197**; conflict-resolution 1,484 → **1,484**. Net: the handlers have not
shrunk. Depth is unchanged.

**1.2 Dual-mode deletion is complete and is not a step here.** `grep -c
worktreeMode src/handlers/*.ts` returns 0 for every file; `worktrees.enabled`
survives only as a rejection message in `admin.ts:2591`. The inventory's
entire DUAL-MODE BRANCH POINTS section (30 sites) is dead text. Worktrees are
unconditional, so every slice below assumes exactly one execution mode. This
was the migration track (#690 → #691 → #698 → #699/#731), which precedes this
work and is done.

**1.3 The lock asymmetry is already half-resolved — the remaining work is a
deletion, not an extension.** DOMAIN.md §2.2 rules that the asymmetry is
resolved runner-side by "extend[ing] the runner's lock hook to review/conflict
and delet[ing] in-handler acquisition." The extension already landed:
`cli/run-one-phase.ts:65` defines `WORKTREE_PHASES = {implementation, review,
conflict_resolution}` and `acquirePhaseLock` (line 410) takes the issue lock
for all three before the handler is invoked; review and conflict receive
`phaseLockOwnerId` (lines 317–318) and skip their own acquire. What remains is
purely subtractive:

- `review.ts:940–957` and `conflict-resolution.ts:956–972` — the
  `if (phaseLockOwnerId === undefined)` acquire/contention/release blocks;
- the `issueLock` and `phaseLockOwnerId` factory parameters on both handlers;
- the tests that exercise the in-handler path (`review-handler.test.js:4553`,
  `conflict-resolution-handler.test.js:1651`, and the `reviewLockScope` /
  `conflictLockScope` contention assertions).

**This path is unreachable in production today** — `run-one-phase.ts` always
passes `phaseLockOwnerId`. Production lock contention already surfaces as the
runner's `lock_contended` outcome (`phase-runner.ts:215,416`), not as the
handler's `blocked` result carrying `reviewLockScope`/`reviewLockHeldBy`. So
M1 (§6) deletes test-only behavior, which is why it is a small slice rather
than the risky one §2.2's wording implies.

**1.4 A fifth boundary leak exists, and it is the only non-type one.**
DOMAIN.md §1.2 records four type-only leaks. There are now five, and
`core/transitions.ts:2` imports a **value** (`ARTIFACT_DIR_PENDING_CONTEXT_FIELD`)
from `handlers/artifact-dir.ts` — a runtime dependency from Orchestration into
Execution, which §2.3's Orchestration row ("Depends on: nothing") forbids
outright. Every policy slice in §4 moves code *into* `core/` and will import
handler-local types on the way; §4.0's dependency rule exists to stop the
count going to six. Repairing the existing five is **not** in this plan's
scope — it is named here so a slice does not silently adopt the leak as
precedent. DOMAIN.md §1.2 is corrected in the same PR as this document.

**1.5 Two policy constants drifted from the inventory.**
`DEFAULT_MAX_REVIEW_CYCLES` is now **10** (`review.ts:224`), not 5;
`DEFAULT_MAX_CONFLICT_REVIEW_CYCLES` is still 2 (`review.ts:230`);
`DEFAULT_MAX_CONFLICT_RESOLUTION_ATTEMPTS` is still 2
(`conflict-resolution.ts:58`). Any contract test that hard-codes 5 is testing
a value that no longer exists.

**1.6 The seam reshape is far cheaper than the call-site count suggests.**
There are 624 handler-factory call sites in the test suite (implementation
332 — 331 in `implementation-handler.test.js` plus one in
`assignment.test.js:368`; review 223; conflict 69). But **each of the three
handler test files already funnels every one of its calls through a local
wrapper function** that fills in the worktree resolver and a fake lock —
`implementation-handler.test.js:200`, `review-handler.test.js:67`,
`conflict-resolution-handler.test.js:61` — and the single outlier
(`assignment.test.js:368`) passes `context` alone, so it is unaffected by any
change to the later parameters. A signature change therefore edits three
wrappers plus the handful of sites that pass deep positional arguments (four
single-line sites pass three or more arguments), not 624 call sites. This is
what makes §5 a one-PR mechanical slice.

### 1.7 Re-derived anchors

The table below replaces the inventory's line numbers for every region this
plan schedules. Anchors are symbol names wherever a symbol exists, because
symbols survive edits that line numbers do not.

| Region | File | Anchor | Lines |
|---|---|---|---|
| Implementation mode + fix detection | implementation.ts | `resolveImplementationMode`, `isNeedsFixTask` | 47–72 |
| Dirty-continuation marker rules | implementation.ts | `isValidDirtyContinuation` | 221–262 |
| Porcelain dirty-path parsing | implementation.ts | `parsePorcelainDirtyPaths`, `parseZPorcelainDirtyPaths`, `excludeArtifactRootPaths` | 263–391 |
| Dirty-continuation capture | implementation.ts | `captureDirtyContinuationOnAgentExit` | 392–478 |
| Prompt building | implementation.ts | `dependencySyncPromptSection`, `verificationPromptSection`, `buildPrompt`, `buildRepairPrompt` | 150–220, 527–742 |
| PR body | implementation.ts | `buildPrBody` | 743–802 |
| Agent profiles | implementation.ts | `EFFORT_RANK`, `effortRank`, `resolveClaudeProfile`, `claudeArgs`, `resolveGeminiProfile`, `resolveCodexProfile`, `implementationCommand` | 803–1088 |
| Worktree materialization (Step 0.6) | implementation.ts | `// Step 0.6` | 1407–1760 |
| Fork refusal | implementation.ts | `fixPr?.isCrossRepository === true` | 1450 |
| Dirty preflight (Step 1) | implementation.ts | `// Step 1` | 1761–1915 |
| Branch setup (Step 3a/b) | implementation.ts | `resumeFromToolRequestBranch`, `retryStartRef` | 1921–2382 |
| Late-failure disposition | implementation.ts | `failAfterBranch`, `capturePartialDiff`, `restoreWorktreeToBase`, `discardEditsToBase` | 2383–2526 |
| Handoff preservation table | implementation.ts | `handoffCleanup` | 2527–2560 |
| Tool Request disposition | implementation.ts | `storeToolRequest`, `toolRequestRepeatKind`, `recordedWorkBranch`, `dependencyBaseForHandoff`, `toolRequestHandoff`, `dependencyUpdateHandoff`, `routeToolRequest` | 2561–2778 |
| Verification repair loop | implementation.ts | `// Step 5.5` | 3138–3355 |
| PR creation | implementation.ts | `createPullRequest` | 3417–3470 |
| Success context assembly | implementation.ts | `dependencyBaseForContext` | 3494–3600 |
| Review profiles + command | review.ts | `ResolvedReviewProfile`, `resolveClaudeReviewProfile`, `reviewCommand` | 31–222 |
| Review loop caps + escalation | review.ts | `DEFAULT_MAX_REVIEW_CYCLES`, `DEFAULT_MAX_CONFLICT_REVIEW_CYCLES`, `reviewLoopState`, `conflictReviewLoopState` | 224–243, 497–543 |
| Review brief + prompt | review.ts | `buildReviewContext`, `buildClaudeReviewPrompt`, `boundReviewFeedback` | 290–496 |
| Review base selection | review.ts | `reviewBase` | 678 |
| Synthetic-worktree release | review.ts | `freeReviewWorktree`, `releaseSyntheticWorktreeForFix` | 777–899 |
| Fork outcome re-classification | review.ts | `forkedPrHandoff` (call sites 1583, 1922, 1985, 2146) | 900–918 |
| In-handler lock acquire | review.ts | `if (phaseLockOwnerId === undefined)` | 940–957 |
| Worktree head selection + materialization | review.ts | (block) | 958–1324 |
| Verification-failure outcome | review.ts | `// Step 4`, `reviewLoopState(task, maxCycles)` | 1500–1593 |
| Residue force-revert | review.ts | `// Step 5.5` | 1733–1810 |
| Classification → outcome | review.ts | `classifyReviewOutput`, `loopState` | 1811–1935 |
| Gemini promotion gate | review.ts | live-mergeability block | 1996–2190 |
| Conflict constants + retry signal | conflict-resolution.ts | `DEFAULT_MAX_CONFLICT_RESOLUTION_ATTEMPTS`, `hasOverlappingFailedTests`, `extractFailedTestNames` | 46–86 |
| Conflict profile | conflict-resolution.ts | `resolveClaudeConflictProfile`, `conflictResolutionCommand` | 98–141 |
| Merge-state parsing | conflict-resolution.ts | `parseUnmergedFiles`, `hasModifyDeleteConflict`, `detectBinaryConflicts`, `findConflictMarkerFiles` | 142–245 |
| Rationale contract | conflict-resolution.ts | `parseMergeRationale` | 263–327 |
| Residue mechanisms | conflict-resolution.ts | `abortMerge`, `cleanResidue`, `worktreeDirtyPaths`, `captureStagedBlobs` | 599–674 |
| Semantic-conflict retry + cap | conflict-resolution.ts | `commitAndPush` (retry block 738–825) | 703–888 |
| PR-resolution outcome mapping | conflict-resolution.ts | `// Step 1` | 890–950 |
| Fork refusal | conflict-resolution.ts | `prInfo.isCrossRepository === true` | 943–955 |
| In-handler lock acquire | conflict-resolution.ts | `if (phaseLockOwnerId === undefined)` | 956–972 |
| Merge attempt + lane routing | conflict-resolution.ts | `// Step 5`, `hasModifyDeleteConflict(unmerged)`, `detectBinaryConflicts` | 1059–1150 |
| Containment checks 1–5 | conflict-resolution.ts | (five blocks) | 1320–1460 |

## 2. Boundary definition

### 2.1 The razor, applied to a procedure

DOMAIN.md §2.1: *what should happen next* = Orchestration (`core/`, pure);
*how to make it happen in a repo/session* = Execution (`handlers/`). For a
3,605-line procedure that razor needs an operational form, because the
procedure legitimately contains both. The operational form is:

> **A handler keeps the procedure and loses the decisions.** After extraction,
> every branch condition in a handler is either (a) a call into a `core/`
> policy function whose inputs the handler gathered, or (b) an I/O failure
> check (`exitCode !== 0`, `!existsSync`, a provider `ProviderResult` error).
> A handler must not contain a conditional that could be evaluated from data
> alone.

That is the acceptance test for "is this slice done," and it is checkable by
reading the diff: a decision that survives in a handler as `if (labels
.includes(...) && attempts >= cap)` failed the razor; the same decision as
`if (reviewLoopState(task, maxCycles).capReached)` passed it.

### 2.2 Four destinations

| Destination | Contents | Constraint |
|---|---|---|
| `src/core/<policy>.ts` | The decisions: caps, routing, dispositions, outcome mapping, classification | Pure. No `fs`/`child_process`/network, no `process.env` read, no import from `handlers/`, `providers/`, `stores/`, `registries/`, `cli/`. Git and host reads arrive as caller-supplied arguments |
| `src/handlers/<mechanism>.ts` | Stable mechanisms shared by two or three handlers: worktree materialization, reconcile fetches, residue cleanup, porcelain parsing | May do git/fs I/O through the injected `CommandRunner`. No task-outcome decisions |
| `src/core/phase-runner.ts` + `src/cli/run-one-phase.ts` | Phase lifecycle only: claim, admission, lock, worktree-context resolution, transitions, completion | **No new responsibility moves here from handlers.** The one item in flight is the lock deletion (§6 M1), which removes a duplicate of what the runner already owns |
| unchanged, in the handler | Agent process invocation, raw output capture, artifact writes, the step sequence itself | — |

### 2.3 No handler-side lifecycle template

Restated because it is the single most likely thing for an implementer to
"helpfully" add: the shared lifecycle in the inventory's SHARED LIFECYCLE
section is a *description*, not a design target. `core/phase-runner.ts`
already owns phase-lifecycle orchestration. A `runPhaseWithLifecycle(...)`
wrapper in `handlers/` would create double orchestration — two places deciding
when the lock is taken and when the worktree is resolved — which is exactly
the defect #440/#515/#524 spent three issues removing. Commonality beyond the
runner's own hooks is extracted as the small named mechanisms in §6, never as
a template, and never as a base class.

### 2.4 What explicitly stays put

- **PR body building and PR creation** (`buildPrBody`,
  `createPullRequest` at 3417–3470): DOMAIN.md §2.3 Delivery resolved this on
  2026-07-20 — synchronous Integration call from Execution, not an outbox
  effect. No slice here moves it. The reuse-on-resume reconcile (3417–3470)
  is the retry-idempotency invariant that decision depends on; a slice that
  touches this region must preserve it verbatim.
- **Prompt construction** (`buildPrompt`, `buildReviewContext`,
  `buildConflictPrompt`): mechanism, not policy — it renders inputs into text
  and decides nothing. It is a §7 file-split candidate, not a §4 extraction
  candidate.
- **The three profile resolvers as three resolvers** (§4, P3) and **the three
  fork rules as three rules** (§4, P2) — per DOMAIN.md §2.2 rows 1–2, only
  their shared primitives are unified.

## 3. Stage 1 — Pin invariants (contract tests)

Nothing else in this plan may start until this stage lands. Every later slice
is a behavior-preserving refactor, and "behavior-preserving" is unfalsifiable
without a pinned baseline. The existing suites
(`implementation-handler.test.js` 8,431 lines, `review-handler.test.js` 5,036,
`conflict-resolution-handler.test.js` 2,251) are extensive but organized by
feature and issue number, so they do not answer "did the lifecycle order
change?" — which is precisely what a refactor breaks.

### 3.1 The checklist

Derived from the inventory's SHARED LIFECYCLE section and its per-phase
deviation list. Shared invariants, pinned once per phase:

1. **Side-effect-free rejection.** An admission/preflight rejection returns
   before any artifact directory is created, any lock is taken, any worktree
   is materialized, and any host write is enqueued.
2. **Artifact-write ordering.** No artifact write happens before worktree
   materialization when `artifactRoot` resolves inside the future worktree
   path (issues #629/#729/#730/#732) — the eager `mkdirSync` would make
   `git worktree add` fail on a non-empty target.
3. **cwd discipline.** After materialization, every git operation runs with
   `cwd` = the issue worktree; the canonical root is used only for
   fetch-into-shared-object-store and repo-host auth reads.
4. **Lock span.** The issue lock is held across the entire worktree-touching
   span and released exactly once, in a `finally`. Asserted in the form that
   survives §6 M1 — the *runner* holds the lock across the handler call
   (`phase-runner.ts:357–371` acquires before any handler is invoked, and
   releases in its own `finally`), so the handler-side assertion is that no
   handler acquires or releases a lock of its own, not that it does so in the
   right place.
5. **Quota routing.** A quota/rate-limit-classified nonzero agent exit yields
   `delayed` (with `category`), never `failed`; every other nonzero yields
   `failed`.
6. **Terminal-state definiteness.** Every non-success terminal path leaves the
   worktree in a defined state — reset to base, merge aborted, or preserved
   with a recorded continuation marker — never mid-merge and never dirty
   without a marker.
7. **Host-write channel.** Every host write is enqueued through the outbox,
   with the single documented exception of PR creation (§2.4).

Per-phase deviations, pinned in that phase's file only:

- **implementation** — dependency-plan step precedes branch work; branch
  *creation* (not just checkout); bounded verification-repair loop
  (`MAX_VERIFICATION_REPAIR_ATTEMPTS = 1`); Tool Request parse happens
  *before* the exit-code check (`// Step 4.5`, 2871) and routes mid-run; PR
  creation on success; worktree removed on success only.
- **review** — admission gate is first; verification runs *before* the agent;
  no commit/push — the agent's output is classified into
  success/needs_fix/conflict/blocked; residue is force-reverted, and an
  uncleanable tree blocks; the worktree is freed on the conflict and synthetic
  paths; the Gemini path additionally requires a confirmed-mergeable live read
  before promoting to success.
- **conflict-resolution** — PR resolution and the fork guard precede any repo
  mutation (the `git fetch`/`reset --hard` at 976+) and any worktree
  materialization, so a lookup failure or missing PR returns without touching
  the repo. Ordering is relative to the *first write*, **not** to the lock: in
  production the runner takes the lock before the handler is entered
  (`phase-runner.ts:357–371`), so nothing in the handler can precede it. The
  pre-lock reading of `conflict-resolution.ts:937–955` describes only the
  direct-handler path that §6 M1 deletes; the merge attempt
  *is* the branch preparation; five containment checks plus the merge-rationale
  contract gate the commit; commit+push happen in-handler; the worktree is
  *kept*; every blocked/failed path runs `merge --abort` plus scoped cleanup.

### 3.2 Placement and shape rules

- One new file per phase: `test/handler-contract-implementation.test.js`,
  `test/handler-contract-review.test.js`,
  `test/handler-contract-conflict-resolution.test.js`. New files, not
  additions to the existing suites, so that a later slice's regression is
  attributable to a lifecycle invariant rather than lost in an 8,431-line
  file.
- Each file constructs its handler through **one local factory wrapper**, the
  same pattern the existing suites already use
  (`implementation-handler.test.js:200`, `review-handler.test.js:67`,
  `conflict-resolution-handler.test.js:61`). This is what keeps §5's
  signature change to a three-line edit; a contract file that calls the
  factory directly at 40 sites re-creates the problem §5 exists to remove.
- Invariants are asserted on **observable order and result shape** — the
  sequence of `CommandRunner` invocations, the presence/absence of a lock
  acquire, the `PhaseHandlerResult` discriminant and its context keys — never
  on internal function calls. A refactor that reorders internals while
  preserving the observable sequence must stay green.
- No contract test may hard-code a policy constant that §4 is about to move
  (§1.5): read caps from the session config the test supplies.

### 3.3 Slices

`T1` implementation, `T2` review, `T3` conflict-resolution. File-disjoint, so
logically parallel; scheduled as a chain because the dependency resolver
supports one open blocker per issue (DOMAIN.md §4.1) and because a shared
convention (§3.2) is cheaper to establish once in T1 and follow twice than to
converge three ways.

## 4. Stage 2 — Extract policy into `core/`

### 4.0 Rules for every policy slice

1. **Purity.** The extracted module imports nothing from `handlers/`,
   `providers/`, `stores/`, `registries/`, or `cli/`, and performs no I/O.
   Anything it needs from git, the repo host, or `process.env` becomes a
   parameter. Where a type is genuinely shared (e.g. `ResolvedSession`
   slices), it is declared in `core/` and the handler conforms — not the
   reverse (§2.3's dependency-inversion rule; see §1.4).
2. **One decision per slice.** A slice extracts one candidate and rewires its
   call sites. It does not opportunistically extract a neighbor.
3. **No behavior change.** The extracted function returns the same decision
   for the same inputs, including for inputs the handler never produces. If
   the extraction reveals a bug, it is filed, not fixed in the slice
   (a refactor PR that also fixes a bug forfeits its rollback guarantee).
4. **Test relocation.** The unit tests for the extracted decision move to
   `test/<module>.test.js` alongside the other `core/` policy tests
   (`review-classifier.test.js`, `tool-request-changes.test.js` are the
   precedent). The handler suite keeps only the tests that assert the handler
   *calls* the policy and *acts* on its answer. Leaving duplicate coverage in
   both files after a slice lands is a slice failure (§9).
5. **Serial.** No two policy slices are in flight (branch open, not merged) at
   the same time when they touch the same handler file — which, given
   implementation.ts owns six of the ten candidates, means effectively all of
   them.

### 4.1 The ten candidates, in extraction order

Order is by entanglement — how much handler-local state the decision reads
today — least first, so the mechanism is proven on cheap slices before it is
bet on `implementation-routing`.

| # | Slice | Target module | Source | Caveat |
|---|---|---|---|---|
| 1 | `P1` Review loop caps + effort escalation | `core/review-loop.ts` | review.ts 224–243, 497–543 | Already pure; reads only `task.context` counters and the session cap. Pure lift-and-move — this is the proof-of-mechanism slice |
| 2 | `P2` Cross-repository head predicate | `core/fork-policy.ts` | impl 1450, review 900–918, conflict 943–955 | **Extract the shared predicate only.** The three outcome mappings stay in their handlers: implementation and conflict *refuse before writes*; review *conditionally converts* needs_fix/conflict → blocked. DOMAIN.md §2.2 row 2 — do not unify the mappings. The flag is optional: absent/`undefined` means *not a fork* today (all three sites test `=== true`) and the predicate must keep that, per §4.0 rule 3 |
| 3 | `P3` Agent-profile primitives | `core/agent-profile.ts` | impl 803–1088, review 31–222, conflict 98–141 | **Extract the shared primitives only**: effort ranking (`EFFORT_RANK`/`effortRank`), the never-downgrade comparator, the env-snapshot input type, the provider→argv shape. The three resolvers stay three resolvers (impl: escalation + budget; review: strength; conflict: claude-only). DOMAIN.md §2.2 row 1 — do **not** force one module. `process.env` reads become an explicit `EnvSnapshot` parameter (rule 4.0.1) |
| 4 | `P4` Conflict outcome mapping | `core/conflict-outcome.ts` | conflict 890–950, 1059–1150 | Covers PR-resolution error-shape routing (lookup-failed → `failed`, missing PR → `blocked`), the clean-merge disposition, and the modify-delete/binary lanes. The modify-delete and binary lanes return `failed`, **deliberately not `blocked`** — preserve that asymmetry verbatim |
| 5 | `P5` Semantic-conflict retry + escalation | `core/conflict-retry.ts` | conflict 46–86, 738–825 | `hasOverlappingFailedTests` + the attempt-cap/escalation rule. `extractFailedTestNames` is a Jest-output *parser* — mechanism; it moves to `core/` with the policy only because it is pure and has no other consumer, and its output is the policy's input |
| 6 | `P6` Gemini promotion gate | `core/mergeability-gate.ts` | review 1996–2190 | A fail-closed state machine: only a *confirmed* MERGEABLE promotes to success; missing selector, host failure, unparsable JSON, and UNKNOWN all block; CONFLICTING/DIRTY route to conflict; a truncated diff blocks regardless. The live host read stays in the handler and is passed in |
| 7 | `P7` Dirty-continuation admission | `core/dirty-continuation.ts` | impl 221–262, 1761–1915 | Marker-validity rules plus the drift computation. Git status output arrives as parsed data; the porcelain parsers (impl 263–391) are **mechanism** and go to `handlers/git-residue.ts` in §6 M3, not here — this slice depends on M3's parsers being importable but not on M3 having landed (it may take them as `string[]` inputs) |
| 8 | `P8` Tool Request disposition | `core/tool-request-disposition.ts` | impl 2561–2778 | Repeat-kind classification, route selection (trusted dependency-update path vs. generic handoff), and the persistence keys (`recordedWorkBranch`, `dependencyBaseForHandoff`). Precedent and near neighbor: `core/tool-request-changes.ts`, `core/tool-request-grant.ts`. The handoff *assembly* (building the result object) stays in the handler |
| 9 | `P9` Handoff/discard preservation table | `core/handoff-preservation.ts` | impl 2383–2560 | Returns an **ordered action plan** (`[{action: "commit-wip"}, …]`); every git operation stays in the handler. Covers `failAfterBranch`'s late-failure disposition, `discardEditsToBase`'s delete-branch-unless(fix/resumed) rule, and `handoffCleanup`'s commit-WIP/keep/delete table |
| 10 | `P10` Implementation mode + branch/start-ref routing | `core/implementation-routing.ts` | impl 47–72, 1407–1760 (ref choices only), 1921–2382 | The most entangled: 460 lines of branch-setup mechanism with routing decisions interleaved. Returns `{mode, branch, startRef, allowFastForward, forkRefusal?, recordedWorkBranch, dependencyBaseToPersist}`. Depends on P2 (fork predicate), P7 (continuation admission), and P9 (which branch survives a handoff). Last for that reason, not only for size |

### 4.2 Newly identified, deliberately not scheduled

Re-derivation found one candidate the 2026-07-19 inventory classed as POLICY
but §2.2 did not carry into its ten: the **five post-agent containment
checks** (`conflict-resolution.ts:1320–1460` — remaining unmerged paths,
leftover markers, staged-set growth beyond baseline, auto-merged content
drift, unstaged/untracked residue). Each is a pure predicate over data the
handler already gathered, and together they are the containment contract that
makes an AI-authored merge safe to commit.

It is **not** in this plan's tranche: DOMAIN.md §2.2's ten are the agreed
scope, and adding an eleventh mid-plan is exactly the scope drift §9's stop
conditions exist to catch. It is recorded here so that whoever schedules the
tail of §4 files it as `P11` (`core/conflict-containment.ts`) rather than
folding it into P4 or P5.

## 5. Stage 3 — Reshape the injected seams

One slice, `R1` in the §8 DAG.

### 5.1 The problem, precisely

Today's factories:

```
createImplementationHandler(context, runner?, depChecker?, resolveWorktree?)
createReviewHandler(context, runner?, resolveWorktree?, issueLock?, resolveRepoHost?, phaseLockOwnerId?)
createConflictResolutionHandler(context, runner?, resolveWorktree?, issueLock?, phaseLockOwnerId?)
```

The same concept sits at different positions across handlers
(`phaseLockOwnerId` is 6th in review, 5th in conflict; `resolveWorktree` is
4th in implementation, 3rd in the other two), and production call sites
already read
`createConflictResolutionHandler(context, undefined, undefined, undefined,
conflictPhaseLockOwnerId)` (`run-one-phase.ts:318`). Three undefineds in a row
is the signature telling you it has outgrown positional injection.

### 5.2 Target

One named seams object, declared in **`handlers/phase-seams.ts`** and passed as
the factories' second parameter. `PhaseHandlerContext` (`phase-runner.ts:113`)
is **not** extended and does not change:

```ts
// src/handlers/phase-seams.ts — Execution layer
export interface PhaseExecutionSeams {
  runner: CommandRunner;                        // handlers/command-runner.ts
  resolveWorktree: typeof resolveIssueWorktree; // handlers/worktree.ts
  resolveRepoHost: typeof resolveSessionRepoHost; // providers/
  depChecker?: DependencyChecker;               // already in core/github-intake.ts
}
```

Every factory becomes
`createXHandler(context: PhaseHandlerContext, seams?: Partial<PhaseExecutionSeams>)`.
A single `withDefaultSeams(seams)` helper fills production defaults, so a
caller that passes `context` alone — e.g. `assignment.test.js:368` — keeps
working unchanged. The one production construction site,
`createPhaseHandlers` (`run-one-phase.ts:203–319`), is in `cli/`, which may
depend on `handlers/` and `providers/`, so it can name the type directly.

**Why not fold the seams into `PhaseHandlerContext`** (the shape an earlier
draft of this section proposed): three of the four members are typed by
Execution-layer or provider symbols — `CommandRunner`
(`handlers/command-runner.ts:19`), `resolveIssueWorktree`
(`handlers/worktree.ts:286`), and `resolveSessionRepoHost` (`providers/`) —
so a `seams` field on a `core/` interface makes `core/phase-runner.ts` import
from `handlers/` and `providers/`. That is three **new** boundary leaks on top
of §1.4's five, and it breaks §4.0 rule 1 and §2.3's "Orchestration depends on
nothing" in the one file the whole plan holds up as the orchestration
boundary. `DependencyChecker` is the sole member that is already
dependency-neutral (`core/github-intake.ts:304`); one clean member does not
buy the other three passage.

The alternative remedy — re-homing the dependency-neutral *contracts*
(`CommandRunner`, and structural `ResolveWorktree`/`ResolveRepoHost` signature
types) into `core/` so the handlers conform to core-declared shapes, per
§4.0 rule 1's dependency-inversion clause — is legitimate but is a **larger,
separately scoped slice**: it moves `ResolveIssueWorktreeInput`/`Result` and
`CommandRunner`'s spawn contract across layers and touches every handler that
imports them. It is not folded into R1 (§4.0 rule 2, one decision per slice).
If it is ever done, R1's seams object can then be re-homed into
`PhaseHandlerContext` as a follow-up with no call-site churn, because the
factory signature already takes one named object rather than positional
arguments. Until then, the seams stay in `handlers/`.

`issueLock` and `phaseLockOwnerId` are **not** in `PhaseExecutionSeams` as
permanent members: they are deleted by §6 M1. Sequencing note: R1 lands before
M1, so R1 carries both fields through the reshape (as optional members of the
seams object, which is where they belong — both are Execution-layer types) and
M1 deletes them. The alternative — M1 first, so R1 never has to carry them —
was rejected because it reverses the order DOMAIN.md §5 fixed (reshape before
mechanisms) for the sake of two fields that cost one line each.

### 5.3 Migration mechanics

One PR, mechanical, because of §1.6: the edit is the new
`handlers/phase-seams.ts` (the interface plus `withDefaultSeams`), three test
wrappers (`implementation-handler.test.js:200`, `review-handler.test.js:67`,
`conflict-resolution-handler.test.js:61`), the three §3 contract-test
wrappers, the three factory definitions, the three call sites in
`run-one-phase.ts:316–318`, and the four single-line test call sites that pass
three or more positional arguments. No file under `core/` is touched.

**Rejected alternative:** keeping `runner` positional at index 2 (it is the
one seam that is consistent across all three handlers) and moving only the
rest into an object. This would have avoided touching the ~17 `(context,
runner)` call sites, but it institutionalizes the mixed convention that caused
the drift, and §1.6 shows the call-site saving is illusory — those sites are
inside the wrappers anyway.

**No transitional adapter.** Unlike the admin plan §4, there is no forwarding
shim: the factories are internal API with no external consumers (they are
imported by `run-one-phase.ts` and the test suite, both in this repo), so a
compatibility layer would only postpone the same edit.

## 6. Stage 4 — Mechanisms, and the lock deletion

### M1 — Delete in-handler lock acquisition

- **Deletes**: `review.ts:940–957`, `conflict-resolution.ts:956–972`, the
  `issueLock`/`phaseLockOwnerId` seam fields carried through by R1, and the
  `IssueWorktreeLock` import in both handlers.
- **Does not change production behavior** (§1.3): the runner already acquires
  for all three worktree phases and already reports contention as
  `lock_contended`.
- **Does change test behavior**, deliberately: a test that invokes a handler
  directly no longer takes a lock. The two tests that assert in-handler
  acquisition (`review-handler.test.js:4553`,
  `conflict-resolution-handler.test.js:1651`) and the contention assertions on
  `reviewLockScope`/`conflictLockScope` move to `phase-runner-lock.test.js`,
  where the behavior actually lives. Coverage must not decrease (§9).
- **Preserves**: `phase-runner-lock.test.js`'s existing assertions verbatim;
  the `lock_contended` outcome shape; the owner-id attribution
  (`contextId ?? runId`) that `admin worktree recovery` reads.

### M2 — `handlers/worktree-materialize.ts`

Fetch-into-canonical + resolve + cwd switch, shared by
implementation (Step 0.6, 1407–1760), review (958–1324), and conflict
(973–1058). **Caveat**: the three differ in which refs they fetch and in the
start-ref/`allowFastForward` choice — those are decisions, supplied by the
caller (from P10 for implementation, from the review head-selection rules, and
from the PR head for conflict). The service performs the fetch and the
materialization; it never picks a ref.

### M3 — `handlers/git-residue.ts`

Porcelain dirty-path listing and parsing (impl 263–391), scoped residue
cleanup (conflict 599–674), and review's force-revert-and-recheck (1733–1810).
Pure mechanism over the injected `CommandRunner`; the *decision* to block on
an uncleanable tree stays in review.

### M4 — reconcile fetches

The `resumeFromToolRequestBranch` / `reuseExistingIssueBranch` /
`validateAgainstBlockerHead` reconcile family (impl 1921–2382) is the third
mechanism named in DOMAIN.md §5. It is scheduled **after** P10, because P10
determines which of its branches are still reachable once routing is a
function; extracting it first would extract a shape that P10 then changes.

## 7. Stage 5 — File splits

Only after stages 1–4. A split is justified only when it follows a seam that
already exists in the code, so the split is a file move rather than a design
decision. Predicted candidates, in likely order:

1. `handlers/implementation-prompt.ts` — `dependencySyncPromptSection`,
   `verificationPromptSection`, `buildPrompt`, `buildRepairPrompt`
   (150–220, 527–742): ~280 lines with one entry point and no state.
2. `handlers/implementation-pr.ts` — `buildPrBody` + the reuse-on-resume
   reconcile and create call (743–802, 3417–3470), keeping §2.4's
   idempotency invariants together in one file.
3. `handlers/review-brief.ts` — `buildReviewContext`,
   `buildClaudeReviewPrompt`, `boundReviewFeedback` (290–496).

**No split issue is filed in the first tranche**, and none should be filed
until stage 4 closes: the whole point of the ordering is that the residual
size after policy extraction, seam reshape, and mechanism extraction is not
knowable now. If a handler is under ~1,200 lines and readable at that point,
its split is not filed at all.

## 8. DAG and slice sequence

```
T1 (impl contract tests) → T2 (review) → T3 (conflict)
   → P1 (review-loop) → P2 (fork-policy) → P3 (agent-profile)
   → P4 (conflict-outcome) → P5 (conflict-retry) → P6 (mergeability-gate)
   → P7 (dirty-continuation) → P8 (tool-request-disposition)
   → P9 (handoff-preservation) → P10 (implementation-routing)
   → R1 (seam reshape) → M1 (lock deletion) → M2 (worktree-materialize)
   → M3 (git-residue) → M4 (reconcile fetches)
   → [stage 5 splits, filed only if still warranted]
```

Edges read "must complete before." The chain is strictly serial, for two
reasons that both apply here and not only to scheduling taste:

- **The dependency resolver supports at most one open blocker per issue**
  (`handlers/dependency-plan.ts`; DOMAIN.md §4.1), so the filed graph must be
  a chain regardless.
- **Ten of the eighteen slices edit `implementation.ts`** (P2, P3, P7, P8, P9,
  P10, R1, M2, M3, M4); of the eight that do not, three are the test-only
  contract slices (T1–T3) and the other five each edit `review.ts` or
  `conflict-resolution.ts`. Two open branches on a 3,605-line procedure
  multiply rebase risk on exactly the file the effort exists to shrink.

Genuine independence exists in three places and is recorded so a future
scheduler can exploit it without re-deriving: `T1`/`T2`/`T3` are file-disjoint;
`P4`/`P5` touch only conflict-resolution while `P1`/`P6` touch only review;
`M1` depends only on `T2`/`T3` (and on `R1` only for the field-deletion
detail, §5.2) and is the cheapest slice in the plan. If scheduling pressure
ever justifies breaking the chain, those three are where the plan permits it —
nowhere else.

## 9. Per-slice requirements and stop conditions

Every slice's issue states, and its PR satisfies:

- **Prerequisites** — its single blocker per §8.
- **Owned files** — the source files it may edit. A diff touching a handler
  region outside its assigned candidate is unrelated churn: stop and re-scope.
- **Compatibility** — the `PhaseHandlerResult` discriminant, `context` keys,
  and `message`/`error` text for every path it touches are unchanged; every
  invariant in §3.1 still holds; every externally observable behavior in
  `phase-contracts.md` is unchanged.
- **Verification** — `npm test` plus, named explicitly, the three handler
  suites, the three §3 contract suites, and the slice's own new
  `test/<module>.test.js`.
- **Rollback** — revert the PR. Because the chain is serial and every slice is
  behavior-preserving, a revert never strands a later slice mid-migration.

Stop conditions (any one halts the chain rather than proceeding):

1. A slice cannot preserve a §3.1 invariant → the invariant was wrong or the
   extraction boundary was wrong; stop and revise this document, do not adjust
   the invariant to fit the diff.
2. A slice's verification fails and a first fix attempt inside the same PR
   does not resolve it → revert the slice; do not start the next one (later
   slices assume this one's module is stable and merged).
3. A slice would change behavior — including "fixing" a bug the extraction
   revealed → stop; file the bug separately (§4.0 rule 3).
4. A slice adds an import from `handlers/`, `providers/`, `stores/`,
   `registries/`, or `cli/` into a `core/` module, or an I/O call into a
   policy module → stop; the boundary in §2.2 is the deliverable, and a
   sixth boundary leak (§1.4) is a regression, not a detail.
5. Test count or assertion count for a touched area decreases without an
   explicit justification in the PR description → stop. M1 is the one slice
   that legitimately *moves* assertions between files; it must show the moved
   count.

## 10. Rules preventing regrowth during the migration

1. **No new policy decision may be authored inside a handler once T1 lands.**
   A new branch condition that could be evaluated from data alone goes into a
   `core/` module — creating that module if it does not exist yet — and the
   handler calls it. The handlers must only shrink after stage 1.
2. **No new positional parameter may be added to a handler factory once R1
   lands.** New seams go into `PhaseExecutionSeams`
   (`handlers/phase-seams.ts`) — never onto `core/`'s `PhaseHandlerContext`,
   which stays dependency-neutral (§5.2).
3. **No handler may acquire the issue lock once M1 lands.** Locking is the
   runner's, via `acquirePhaseLock`. A new phase that needs the lock is added
   to `WORKTREE_PHASES` (`run-one-phase.ts:65`), not given its own acquire.
4. **No handler-side lifecycle template, ever** (§2.3) — including "just a
   small `withWorktree()` wrapper."
5. **Recorded-but-unfixed items stay recorded.** The five `core/`→`handlers/`
   boundary leaks (§1.4) and the eleventh policy candidate (§4.2) move with
   whatever slice touches them, unchanged. Opportunistically fixing either
   inside a refactor slice conflates a relocation PR with a behavior-change PR
   and forfeits the rollback guarantee.
6. **The inventory is a snapshot, not a spec.** A slice that finds
   `design/handlers-responsibility-inventory.md` disagreeing with the code
   follows the code and updates §1.7 of this document; it does not update the
   inventory, which is explicitly point-in-time raw data.

## 11. First tranche of extraction issues

The tranche is stage 1 in full plus the two proof-of-mechanism policy slices.
It stops there deliberately: P1 and P2 are the slices that validate §4.0's
purity rule and the caveat-honoring style of §4.1 rows 1–2, and filing the
remaining eight before that validation would bake an unproven convention into
eight issue bodies.

Filing is a GitHub-side action for whoever picks this up (issue bodies are not
repository files); the drafts below are the text to file, and the chain edges
are `T1 ← T2 ← T3 ← P1 ← P2` — one open blocker each, per §8.

### Issue T1 — Pin implementation-phase lifecycle invariants with contract tests

- **Labels**: `enhancement`, `complexity:high`; **blocker**: none (#692 closed).
- **Scope**: add `test/handler-contract-implementation.test.js` pinning the
  seven shared invariants in §3.1 and the implementation deviations
  (dependency-plan step order, branch creation, the
  `MAX_VERIFICATION_REPAIR_ATTEMPTS = 1` bound, Tool Request parse before the
  exit-code check, PR creation on success, worktree removal on success only).
- **Constraints**: new file only; all construction through one local factory
  wrapper (§3.2); assertions on observable `CommandRunner` order and
  `PhaseHandlerResult` shape, never on internal calls; no hard-coded policy
  constant that stage 2 will move (§1.5).
- **Acceptance**: every §3.1 shared invariant and every implementation
  deviation has at least one failing-if-violated test; `npm test` green; no
  production file modified.

### Issue T2 — Pin review-phase lifecycle invariants with contract tests

- **Labels**: `enhancement`, `complexity:high`; **blocker**: T1.
- **Scope**: `test/handler-contract-review.test.js`, same seven shared
  invariants plus review's deviations: admission gate first, verification
  before the agent, no commit/push, output classification into the four
  outcomes, residue force-revert with block-on-uncleanable, worktree freed on
  conflict and synthetic paths, and the Gemini confirmed-mergeable gate.
- **Constraints**: as T1; additionally, the lock-span invariant (§3.1 #4)
  must be asserted in the form that survives M1 — i.e. against the runner
  holding the lock, not against the handler acquiring it.
- **Acceptance**: as T1, for review.

### Issue T3 — Pin conflict-resolution lifecycle invariants with contract tests

- **Labels**: `enhancement`, `complexity:high`; **blocker**: T2.
- **Scope**: `test/handler-contract-conflict-resolution.test.js`, same seven
  shared invariants plus: PR resolution and the fork guard before the first
  repo mutation, merge-as-branch-prep, the five containment checks and the
  rationale contract gating the commit, in-handler commit+push, worktree
  *kept*, and `merge --abort` plus scoped cleanup on every blocked/failed
  path.
- **Constraints**: as T2 — and specifically, the PR-resolution ordering is
  asserted against the first `CommandRunner` write (no `git fetch`/`reset`
  before a lookup-failed → `failed` or missing-PR → `blocked` return), never
  against lock acquisition. An end-to-end test that expects PR resolution to
  precede the lock contradicts production ordering and would only pass on the
  direct-handler path M1 deletes.
- **Acceptance**: as T1, for conflict-resolution.

### Issue P1 — Extract review loop caps and effort escalation to `core/review-loop.ts`

- **Labels**: `enhancement`, `complexity:medium`; **blocker**: T3.
- **Scope**: move `DEFAULT_MAX_REVIEW_CYCLES` (10),
  `DEFAULT_MAX_CONFLICT_REVIEW_CYCLES` (2), `reviewLoopState`, and
  `conflictReviewLoopState` from `review.ts` into `core/review-loop.ts`;
  rewire the four call sites (1521, 1854, 1946, and the cap-message paths);
  move their unit tests into `test/review-loop.test.js`.
- **Constraints**: §4.0 in full — pure module, no `handlers/` import, no I/O,
  no behavior change including the escalation-at-cap−1 rule
  (`completedCycles === maxCycles - 1` → `"high"`). The cap *messages* stay in
  the handler; only the state computation moves.
- **Acceptance**: `review.ts` contains no cycle-cap arithmetic;
  `test/review-loop.test.js` covers the cap, the escalation boundary, and the
  conflict-review variant without a repo fixture; the T2 contract suite and
  `review-handler.test.js` pass unchanged; no duplicate coverage left behind
  (§4.0 rule 4).
- **Why first**: the only candidate that is already pure, so it validates
  §4.0's mechanism at the lowest possible risk.

### Issue P2 — Extract the cross-repository head predicate to `core/fork-policy.ts`

- **Labels**: `enhancement`, `complexity:medium`; **blocker**: P1.
- **Scope**: extract the shared "is this PR head on a fork" predicate used at
  `implementation.ts:1450`, `review.ts:900–918`, and
  `conflict-resolution.ts:943–955` into `core/fork-policy.ts`, taking the
  provider-confirmed `isCrossRepository` flag as input.
- **Constraints**: **the three outcome mappings do not move and are not
  unified** (DOMAIN.md §2.2 row 2): implementation and conflict-resolution
  refuse before any write; review conditionally converts needs_fix/conflict →
  blocked and keeps its `forkedPrHandoff` closure, which also has to keep the
  classification out of the escalated context. A slice that produces one
  shared `forkOutcome()` returning per-phase results has violated the caveat
  and must be re-scoped.
  **Unknown input keeps today's meaning, which is *not* fail-closed.**
  `isCrossRepository` is optional (`pr-helpers.ts:13`; `providers/types.ts:102`)
  and the Gitea provider deliberately omits it when either repo identity is
  missing (`gitea-repo-host-provider.ts:350–356`, "absent → treated as not a
  fork"). All three current call sites test `=== true`
  (`implementation.ts:1450`, `review.ts:1035,1074`,
  `conflict-resolution.ts:948`), so `undefined` takes the conventional
  same-repo path today. The extracted predicate must return `false` for
  `undefined`, matching §4.0 rule 3 ("the same decision for the same inputs,
  including for inputs the handler never produces"). Making unknown refuse is a
  **behavior change** — a partial-payload PR that runs today would start
  producing a blocked/failed fork handoff — so it is out of scope for this
  refactor slice. If fail-closed is wanted, file it as its own behavioral issue
  against the *provider* contract (where the ambiguity originates), not as a
  silent rider on the extraction.
- **Acceptance**: one predicate, three call sites, three unchanged mappings;
  `test/fork-policy.test.js` covers `true`, `false`, and the
  `undefined`/absent case, pinning `undefined` → not-a-fork; the three
  contract suites and the three handler suites pass unchanged.
- **Why second**: it is the smallest slice with a *caveat*, so it validates
  that the plan's "extract the shared part, keep the divergent part" style is
  executable before eight more slices depend on it.

### Backlog (not filed in this tranche)

`P3`–`P10` per §4.1, then `R1` (§5), `M1`–`M4` (§6), then §7's splits if still
warranted. Each is filed as its predecessor closes, so that its body can cite
the actual post-slice line anchors rather than this document's, which will
have drifted by then (§10 rule 6).

## 12. Coordination with the DOMAIN.md §2.3 context contracts

The issue requires these boundaries to target the contracted contexts (#693).
Mapping, and the two corrections re-derivation forced:

| Contract clause (§2.3) | Discharged by |
|---|---|
| Execution "Ports: … mechanism services as extracted per #692" | §6 M2/M3/M4 — this document names them: `worktree-materialize`, `git-residue`, reconcile fetches |
| Execution "Depends on: Orchestration (pure policy only)" | §4.0 rule 1 + §9 stop condition 4 — the direction is handler → `core/`, never back |
| Orchestration "pure policy functions (… and everything §2.2 extracts)" | §4.1 — all ten candidates land in `core/`, as ten modules, honoring rows 1–2's no-forced-unification caveats |
| Orchestration "Depends on: nothing" | §1.4 — **correction**: there are five leaks, not four, and `core/transitions.ts:2` is a *value* import from `handlers/`. Not repaired here; recorded so no slice adopts it as precedent. §5.2 — R1 adds none: the seams object lives in `handlers/`, so `core/phase-runner.ts` never imports `CommandRunner`, `resolveIssueWorktree`, or `resolveSessionRepoHost` |
| Execution "handlers invoked only by phase-runner" | §2.3 + §10 rule 4 — no handler-side lifecycle template; §10 rule 3 — no handler-side locking |
| §2.2 "resolved runner-side: extend the runner's lock hook to review/conflict and delete in-handler acquisition" | §1.3 — **correction**: the extension already landed (#515/#524). Only the deletion remains, as M1 |
| Delivery "PR creation stays in Execution as a synchronous Integration call" | §2.4 — explicitly excluded from every slice; its reuse-on-resume reconcile is a preserved invariant |
| §4.1 chain B "`#692` … Extraction-slice issues are filed by #692 when it lands" | §11 — the first tranche (T1–T3, P1, P2) with the remainder in the backlog |
