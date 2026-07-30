# Admin extraction DAG, migration slices, and rollback plan

**Note (issue #731):** the `quarantine status`/`quarantine clear` subcommands
referenced throughout this plan have been deleted along with
`worktrees.enabled` — those references are historical.

This document is the final integration specification for decomposing
`src/cli/admin.ts` (10,574 lines) and `src/cli/admin-ui.ts` (1,900 lines) into
resource-oriented modules (issue #712). It consolidates, sequences, and
resolves the four prerequisite specifications produced after issue #612 hit
the review-cycle cap:

- [`admin-command-registry-contract.md`](admin-command-registry-contract.md)
  (#708) — dispatch/registry mechanics.
- [`admin-cli-parsing-contract.md`](admin-cli-parsing-contract.md) (#709) —
  shared option parsing, output, help, confirmation, and the transitional-
  adapter rules this document schedules.
- [`admin-task-handoff-ports-contract.md`](admin-task-handoff-ports-contract.md)
  (#710) — the `TaskStore` port extension for task/human-handoff mutation.
- [`admin-resource-boundaries-contract.md`](admin-resource-boundaries-contract.md)
  (#711) — Session/Worktree/Lock/UI/Outbox/Maintenance module boundaries and
  ports.

[`admin-cli-contract.md`](admin-cli-contract.md) (#308/#309) is the older
baseline output/exit-code contract all four extend; it is not itself one of
the four split documents and is not re-litigated here.

PR #707 is prior-attempt research material only. Where anything in this
document differs from it or from #612, this document — reconciled against
the current `src/cli/admin.ts`/`admin-ui.ts` and the four contracts above —
is authoritative. **This is a documentation-only issue: no production code is
moved or refactored here.** Everything below is the specification a later
implementation issue (or set of issues, filed under #613) executes.

## 1. Complete command and entrypoint inventory

Every current external admin surface, in one table, merging #708 §2 (dispatch
classification), #710 §2 (task/handoff ownership), and #711 §2 (everything
else). "Target module" is the resource-oriented module a later implementation
extracts this command's handler into; "Port prerequisite" names the port work
from §2 of this document that must land first.

| Command / entrypoint | Target module | Port prerequisite | Notes |
| --- | --- | --- | --- |
| `github-intake`, `enqueue-task`, `run-one-phase`, `dispatch-outbox` | *(none — catalog-only)* | none | Independent executables, never dispatched by `main()`; only listed in `admin help` (#708 §2.1). Not moved. `enqueue-task.ts` lacks an `isMain` guard — see §7 rule 3. |
| `task-status`, `list-stuck`, `recover`, `recover-cap-handoff`, `task clear-delay`, `human-review-return`, `github-app-review-return`, `review-verification resolve`, `tool-request list`, `tool-request resolve`, `tool-request run`, `tool-request grant` (deprecated alias of `run`), `task-assign` | **Task/Handoff** | P1 (`TaskStore` port, #710) | `task-assign`'s core logic already lives in `core/assignment.ts` (Orchestration-owned per #710's ownership note); its CLI dispatch moves with this cluster for admin.ts-churn reasons, not because #710/#711 reassign its data ownership. |
| `session-doctor`, `session-init`, `session preset list` (hidden), `session preset show` (hidden) | **Session** | P3 (`SessionRegistry` write surface, #711 §3.3) | The two `session preset` actions are dispatchable but absent from `COMMANDS`/`admin help` — preserve that exact visibility gap (#708 §2.4, #711 §12 item 11). |
| `worktree list`, `worktree prune`, `worktree recovery`, `worktree cleanup`, `worktree discard` | **Worktree** | P2 (`LockStore` port, #711 §5.5) — `discard` acquires a lock; the others only read/inspect one | `cleanup`/`prune`/`discard` are three separate code paths, not variants of one helper (#711 §4.2) — preserve the distinction. |
| `worktree release-lock`, `repo-lock acquire`, `repo-lock release`, `repo-lock status`, `repo-lock force-release`, `review-lock status`, `review-lock release` | **Lock** | P2 (`LockStore` port, #711 §5.5) | `review-lock */worktree release-lock` are the same underlying `IssueWorktreeLock` scope, differing only in two output fields (#711 §5.1) — an alias pair, not two implementations. |
| `admin ui` | **UI** (`admin-ui.ts`, stays its own file) | P1 + P2 (reads Task/Lock/Worktree/Session state) | Not a sixth composition root (#711 §9.2 point 2); `main()` hands it deferred factories, not constructed ports, so its non-TTY guard still runs first. 45 named exports in `admin-ui.ts` are a stable test-import contract (#711 §11) regardless of which file ends up owning each. |
| `quarantine status`, `quarantine clear`, `interventions`, `status` (top-level aggregator) | **Maintenance** | P1 + P2 (status/quarantine read Task and Lock state) | `quarantine`'s marker-file access and `interventions`' raw `Database` handle are **recorded boundary violations, not fixed by this plan** — see §7 rule 4 and §3 slice S2. |
| `context create`, `context-mode status`, `issue-discuss preview`, `issue-discuss post`, `issue-plan preview`, `issue-plan ai-preview`, `issue-plan evaluate-history` | **Content** (Intake context, per `DOMAIN.md` §2.3) | none — read-only registry retype only | Already the best-isolated group (#711 §8.2); only its `COMMANDS`/dispatch registration moves, no logic changes. |
| `help` | *(stays in the dispatcher)* | none | Self-describes the composition root; never "owned" by a resource module. |
| *(no current command)* — future Outbox operator controls (list/retry/cancel/dead-letter, #607) | **Outbox** (forward-looking) | none yet | No command exists today; §7 rule 5 pins where the first one must land. |
| `npm run metrics` | *(not an admin subcommand)* | n/a | `scripts/metrics.mjs`, a separate composition root outside `COMMANDS`/`main()` (#711 §8.3). Out of scope. |

This table is the acceptance-criterion artifact "the inventory accounts for
every current command, hidden entrypoint, alias, and catalog-only command." A
later implementation's automated version of it is §4 rule 11's completeness
test (already specified in #711 §12 item 11); this document does not
duplicate that test's mechanics, only its scope.

## 2. Port prerequisites (must land before any command in their column above moves)

These are pure interface/adapter changes with **no command-handler
relocation**. They exist so that when a command's handler *does* move out of
`admin.ts`, it can be typed against a port instead of a concrete adapter from
the first commit — never move a handler and then retrofit its typing in a
follow-up.

| ID | Port work | Source contract | Files touched | Unlocks |
| --- | --- | --- | --- | --- |
| P1 | Extend `TaskStore` with `listSessionTasks`, `recoverTask`, `recoverHandoff`, `recoverCapHandoff`, `clearTaskDelay`; add the `revision` bump to each; convert to `async`; migrate every `listTasks(sessionId, issueNumber)` call site to `getTask`/`listSessionTasks` per #710 §9 | #710 §3, §3.2, §6, §9 | `src/core/task-store.ts`, `src/stores/sqlite-task-store.ts`, `src/stores/memory-task-store.ts`, ~20 call sites in `admin.ts`/`admin-ui.ts` | Task/Handoff cluster (S6), UI (S7), Maintenance's `status` (S2) |
| P2 | Add `LockStore` interface (`acquire`/`release`/`forceRelease`/`inspect`/`peek`); change `IssueWorktreeLock`'s constructor to `constructor(store: LockStore)`, fixing all 11 call sites (7 in `admin.ts`, 1 in `admin-ui.ts`, `run-one-phase.ts`, `handlers/review.ts`, `handlers/conflict-resolution.ts`) | #711 §5.5 | `src/stores/repo-lock-store.ts` (export `LockStore`/`PeekResult`), `src/handlers/worktree.ts` (`IssueWorktreeLock`), the 11 call sites | Lock (S3), Worktree (S5), UI (S7), Maintenance's `status`/`quarantine` (S2) |
| P3 | Add `SessionRegistry.createSession`/`.updateSession` (file-scoped lock with stale-TTL recovery, per §3.3's docstring); retype path-A read call sites (9 sites) onto the `SessionRegistry` interface; leave paths B/C (tolerant reads, 9 commands) untouched | #711 §3.3 | `src/core/session.ts` (interface), `src/registries/json-session-registry.ts` (impl + lock sidecar), 9 path-A call sites | Session (S4) |
| P4 | Registry/dispatch scaffolding: give resource modules a way to export their own `CommandInfo[]` + handler map for `main()` to collect, without moving any handler body yet. This is the seam every slice in §3 registers into and the mechanism the temporary adapters in §4 forward through. | #708 §8 (dependency-direction rule: modules register *into* the dispatcher, never import it back) | `src/cli/admin.ts` (collector wiring only) | Every slice in §3 |

**P1, P2, and P3 have no dependency on each other** — they touch disjoint
files and disjoint `TaskStore`/`LockStore`/`SessionRegistry` interfaces. They
are still executed **serially** (P1 → P2 → P3 → P4), not in parallel, for the
same reason command-extraction slices are serial (§3's preamble): each also
carries call-site retyping inside `admin.ts`/`admin-ui.ts`, and concurrent
PRs editing overlapping neighborhoods of a 10,574-line file multiply merge
risk for no throughput gain — a merged repo has no wall-clock benefit from
starting P2 before P1's PR lands. Order among the three is by unlock size,
largest first: P1 unlocks the 12-command Task/Handoff cluster and is a
prerequisite for `status`; P2 unlocks Worktree, Lock, and UI; P3 unlocks only
Session's 4 commands. P4 is last because it is the one port-prep item that
depends on nothing being extracted yet but is only useful once a command is
ready to move, i.e., immediately before S1.

## 3. Extraction DAG and slice sequence

```
P1 (TaskStore) ─┐
P2 (LockStore) ─┼─→ P4 (dispatch scaffolding) ─→ S1 (Content) ─→ S2 (Maintenance) ─→ S3 (Lock) ─→ S4 (Session) ─→ S5 (Worktree) ─→ S6 (Task/Handoff) ─→ S7 (UI) ─→ S8 (composition-root finish)
P3 (SessionRegistry) ─┘
```

Edges read "must complete before." `S2` depends on `P1`+`P2` (reads Task and
Lock state); `S3` and `S5` depend on `P2`; `S4` depends on `P3`; `S6` depends
on `P1`; `S7` depends on `P1`+`P2` and, for confidence rather than
compilation, benefits from `S3`/`S6` already landed (the UI shells out to the
compiled `admin.js` for those commands' mutations — #711 §6.2 category 1 —
so their extraction reduces the surface `S7`'s subprocess tests exercise).
`S1` and `S2` have no port prerequisite beyond `P4` (Content's commands don't
mutate Task/Lock/Session state; Maintenance's `status`/`quarantine status`
read Task/Lock state that already exists as concrete-typed calls today and
only need retyping once `P1`/`P2` land — hence `S2` after them, not before).

Every slice is a single, self-contained PR (or a short PR stack) against
`main`. **The sequence is deliberately serial even where two slices are
logically independent** (e.g., `S3` Lock and `S4` Session touch disjoint
command sets and disjoint files) because both slices edit the *same* shared
structures in `admin.ts` — the `COMMANDS` array and the `main()` if-chain —
and interleaving their PRs multiplies rebase/merge-conflict risk on exactly
the file this whole effort exists to shrink. This is also what "slice
ordering minimizes concurrent edits to `admin.ts`" means concretely: no two
command-extraction slices are ever in flight (branch open, not yet merged)
at the same time.

Rationale for the S1–S7 order specifically:

- **S1 (Content) first**: zero logic changes (handlers already live in their
  own files per #711 §8.2), so it is the cheapest possible proof that `P4`'s
  registration scaffolding and the temporary-adapter pattern (§4) actually
  work end-to-end, before betting a riskier slice on the same mechanism.
- **S2 (Maintenance) second**: `status` is a pure read-only fan-out (#711
  §8.1) — moving it exercises cross-module port consumption (Task, Lock,
  Worktree reads) without any mutation risk. `quarantine`/`interventions`'
  raw-access violations are carried over unfixed (§7 rule 4), so this slice
  is dispatch-relocation only, same risk class as S1.
- **S3 (Lock) third**: small (7 commands), self-contained once `P2` lands,
  and unblocks `S5`'s `discard` command (which acquires a lock).
- **S4 (Session) fourth**: small (4 commands, 2 of them hidden), independent
  of everything except `P3`.
- **S5 (Worktree) fifth**: depends on `P2` and is lower-risk once `S3` has
  already proven the Lock port's call-site pattern inside a real slice.
- **S6 (Task/Handoff) sixth**: the largest cluster (12 commands including the
  alias) and the one with the most subtle preservation requirements (§4/§6/§8
  of #710 — non-atomic multi-step sequences, CAS/revision semantics,
  Tool Request resolution invariants). Sequenced after five smaller slices
  have validated the extraction mechanism, not first.
- **S7 (UI) last** among command-focused slices: `admin-ui.ts` reads every
  other module (#711 §10's dependency matrix: "UI is the one module allowed
  to depend on every other module's read path") and carries the highest
  regression surface (45 pinned test exports, three invocation categories,
  the non-TTY-guard-precedes-construction ordering). Doing it last means
  every module it reads has already been extracted and stabilized.
- **S8 (composition-root finish)**: not a command-extraction slice — it is
  the cleanup pass once every handler accepts injected ports, converting
  `main()`'s remaining per-command inline construction into the
  one-construction-per-need shape #711 §9.2 specifies, and confirming the
  thin-entrypoint shape (§6).

### Per-slice specification

Each slice below lists: prerequisites, owned files/modules, compatibility
requirements, verification, and rollback — the acceptance-criterion shape the
issue requires for every slice.

#### P1 — `TaskStore` port extension

- **Prerequisites**: none.
- **Owned files**: `src/core/task-store.ts`, `src/stores/sqlite-task-store.ts`,
  `src/stores/memory-task-store.ts`; call sites in `admin.ts` (recovery,
  delay, bulk-list — #710 §3.2) and `admin-ui.ts` (`collectActiveTasks` and
  every other store-typed screen function, #710 §10).
- **Compatibility requirements**: every `StoreResult` code/shape unchanged
  (#710 §12); every allowed-transition/refusal pair in #710 §7 unchanged;
  the four-step `enqueueFixModeRequeue` sequence's non-atomicity preserved,
  not silently fixed (#710 §4); no admin resource module may import
  `SqliteTaskStore` as a value once this lands (#710 §11 item 7).
- **Verification**: #710 §11's 9 required tests (port-conformance suite
  across `SqliteTaskStore`/`MemoryTaskStore`, per-operation transition/
  refusal table, `getTask` migration parity, reject-recovery exemption,
  `recoverHandoff` Tool Request guard, non-atomic crash-window tests,
  composition-root import check, admin-ui read-path typing check, revision
  advance test) plus the full existing `admin-*.test.js` suite (unchanged
  call sites must keep passing).
- **Rollback**: revert the PR. No command dispatch changed, so rollback is
  a pure type/behavior revert with no COMMANDS/`main()` conflict risk.

#### P2 — `LockStore` port + `IssueWorktreeLock` injection

- **Prerequisites**: none.
- **Owned files**: `src/stores/repo-lock-store.ts` (export `LockStore`,
  `PeekResult`), `src/handlers/worktree.ts` (`IssueWorktreeLock` constructor),
  all 11 call sites listed in #711 §5.5 (7 in `admin.ts`, 1 in `admin-ui.ts`,
  `run-one-phase.ts:379`, `handlers/review.ts:886`,
  `handlers/conflict-resolution.ts:936`).
- **Compatibility requirements**: `status`'s two independently-configured
  lock directories (`--lock-dir` vs. `--worktree-lock-dir`) must remain
  distinct instances pointed at distinct directories (#711 §5.5, the
  `status`-specific hazard); the `repo-lock force-release` vs.
  `worktree release-lock`/`review-lock release` staleness-gate asymmetry is
  preserved, not normalized (#711 §5.2); the review/conflict-resolution
  in-handler fallback (`issueLock ?? new IssueWorktreeLock(...)`) keeps
  compiling and keeps its existing default-directory behavior for tests that
  omit the lock argument.
- **Verification**: #711 §12 items 4, 5, 6, 7, 13 (LockStore conformance
  suite, distinct-directory test, force-release asymmetry test, review-lock/
  worktree-release-lock alias parity, non-admin call-site conformance) plus
  `test/repo-lock-store.test.js`, `test/admin-worktree.test.js`,
  `test/admin-review-lock.test.js`, `test/phase-runner-lock.test.js`,
  `test/conflict-resolution-handler.test.js`, `test/review-handler.test.js`.
- **Rollback**: revert the PR. Touches files outside `admin.ts`'s command
  bodies plus 11 call sites; no COMMANDS/dispatch structure changed.

#### P3 — `SessionRegistry` write surface

- **Prerequisites**: none.
- **Owned files**: `src/core/session.ts` (`SessionRegistry` interface,
  `SessionConfigPatch`), `src/registries/json-session-registry.ts`
  (`createSession`, `updateSession`, the `<sessionsPath>.lock` sidecar), the
  9 path-A call sites (`admin.ts:4840,5702,6071,6625,7088,7925`;
  `admin-ui.ts:789,1845`; `context-mode-status.ts:496`).
- **Compatibility requirements**: paths B and C (#711 §3.2, 9 commands'
  tolerant reads) are **not** migrated onto `SessionRegistry` and must not
  start failing on a malformed unrelated session entry (#711 §13); the
  registry's snapshot semantics (construction-time index, no implicit
  reload) are preserved; `createSession`'s reference-invariant check covers
  `sessionId`, `repoKey`, `sessionNo`, and every `aliases` entry, not just
  the two fields `runSessionInit` checks today.
- **Verification**: #711 §12 items 1, 2, 3 (tolerant-read characterization
  for all 9 path-B/C commands, `createSession` conformance including
  same-instance and cross-instance concurrency and crash-recovery tests,
  `updateSession` conformance) plus `test/json-session-registry.test.js`.
- **Rollback**: revert the PR. No command dispatch changed.

#### P4 — Dispatch/registration scaffolding

- **Prerequisites**: P1, P2, P3 landed (so the first real slice, S1, has
  every port it might need already available, even though Content itself
  needs none of them — this ordering is about not leaving a partially-built
  scaffolding in `main()` while port work is still landing underneath it).
- **Owned files**: `src/cli/admin.ts` only (the `COMMANDS` aggregation point
  and `main()`'s dispatch loop).
- **Compatibility requirements**: `admin help`'s output (order, content),
  every exit code, and every dispatch error message (#708 §7, §9) are
  byte-identical before and after — this slice changes *how* `COMMANDS`/the
  if-chain are assembled, never their observable behavior. No resource
  module may import the dispatcher (#708 §8's one-directional dependency
  rule) — the scaffolding only pulls registrations inward.
- **Verification**: full existing `test/admin-cli.test.js` and
  `test/admin-command-framework.test.js` suites pass unchanged (they pin
  exactly the observable behavior this slice must not alter).
- **Rollback**: revert the PR; `admin.ts` returns to one hand-maintained
  `COMMANDS` array/if-chain, exactly as today.

#### S1 — Content module registration

- **Prerequisites**: P4.
- **Owned files**: `src/cli/admin.ts` (remove Content's `COMMANDS` entries
  and dispatch branches, replace with a registration import from
  `context-mode-status.ts`/`issue-discuss.ts`/`issue-plan*.ts`); those four
  files gain an exported `CommandInfo[]`/handler-map fragment each.
- **Compatibility requirements**: `context create`, `context-mode status`,
  `issue-discuss preview|post`, `issue-plan preview|ai-preview|
  evaluate-history` keep identical argv, output, and exit-code behavior
  (#711 §13). No logic inside these four files changes.
- **Verification**: `test/admin-context-mode-status.test.js`,
  `test/admin-cli.test.js`'s Content-command assertions, plus a full
  `admin help` snapshot comparison.
- **Rollback**: revert the PR; `admin.ts` regains its inline Content
  registrations.

#### S2 — Maintenance module extraction

- **Prerequisites**: P1, P2, P4, S1.
- **Owned files**: new `src/cli/commands/maintenance.ts` (or equivalent)
  owning `runQuarantineStatus`, `runQuarantineClear`, `runInterventions`,
  `runStatus`; `admin.ts` gains a temporary forwarding adapter (§4) until
  cutover, then loses the inline bodies.
- **Compatibility requirements**: `status` stays a thin fan-out over
  `LockStore`/`IssueWorktreeLock`/`TaskStore` reads, never re-implementing
  any of their logic (#711 §8.1); quarantine's marker-file access and
  interventions' raw `Database` handle are carried over **unfixed** — this
  slice relocates the violation, it does not remediate it (§7 rule 4).
- **Verification**: `test/admin-status.test.js`, #711 §12 item 10
  (quarantine/interventions raw-access characterization tests, added before
  this slice if they don't already exist, so the violation has a pinned
  baseline before it moves).
- **Rollback**: revert the PR; delete the new module file, restore
  `admin.ts`'s inline bodies from the adapter's forwarding target.

#### S3 — Lock module extraction

- **Prerequisites**: P2, P4, S1, S2.
- **Owned files**: new `src/cli/commands/lock.ts` owning
  `runRepoLockAcquire/Release/Status/ForceRelease`,
  `runReviewLockStatus/Release`, `resolveIssueLockRelease` (shared by
  `worktree release-lock` and `review-lock release`).
- **Compatibility requirements**: the `review-lock`/`worktree release-lock`
  alias relationship (#711 §5.1) and the `repo-lock force-release` staleness
  asymmetry (#711 §5.2) preserved verbatim.
- **Verification**: `test/repo-lock-store.test.js`, `test/admin-review-lock.test.js`,
  #711 §12 items 6, 7.
- **Rollback**: revert the PR; restore inline bodies in `admin.ts`.

#### S4 — Session module extraction

- **Prerequisites**: P3, P4, S1, S2, S3.
- **Owned files**: new `src/cli/commands/session.ts` owning
  `runSessionDoctor`, `runSessionInit` (with its dedicated pre-registry
  bootstrap step, #711 §3.3), `runSessionPresetList`, `runSessionPresetShow`.
- **Compatibility requirements**: `session preset list`/`show` remain
  dispatchable but absent from `COMMANDS`/`admin help` (#708 §2.4) — the
  extraction must not accidentally register them; `session-init`'s
  fresh-install bootstrap (create `sessions.json` + parent dir before
  constructing the registry) is preserved exactly.
- **Verification**: `test/admin-session-preset.test.js`, #711 §12 items 1–3.
- **Rollback**: revert the PR; restore inline bodies.

#### S5 — Worktree module extraction

- **Prerequisites**: P2, P4, S1–S4.
- **Owned files**: relocate `runWorktreeList/Prune/Recovery/Cleanup/Discard`
  out of `admin.ts` into a module alongside the existing
  `src/handlers/worktree.ts` free functions (`listWorktrees`,
  `resolveIssueWorktree`, etc.) — this document does not mandate a
  `WorktreeManager` class (#711 §4.1's razor still applies).
  `worktreeHasUnpushedCommits` and the discard reset/clean sequence, which
  today re-implement git-probe logic inline in `admin.ts` rather than
  delegating to the shared module, are extraction targets of this slice.
- **Compatibility requirements**: `cleanup`, `discard`, and `prune` stay
  three distinct code paths, not merged into one helper (#711 §4.2);
  `worktree recovery` stays diagnostic-only (never calls
  `release-lock` itself, only prints the guidance to run it).
- **Verification**: `test/admin-worktree.test.js`,
  `test/admin-worktree-cleanup.test.js`, `test/admin-worktree-discard.test.js`,
  `test/admin-worktree-recovery.test.js`, `test/worktree.test.js`,
  `test/worktree-recovery.test.js`.
- **Rollback**: revert the PR; restore inline bodies.

#### S6 — Task/Handoff module extraction

- **Prerequisites**: P1, P4, S1–S5.
- **Owned files**: new `src/cli/commands/task.ts` (or split further into
  `task.ts`/`tool-request.ts` if a later implementation judges the combined
  file too large — this document does not mandate one file) owning
  `task-status`, `list-stuck`, `recover`, `recover-cap-handoff`,
  `task clear-delay`, `human-review-return`, `github-app-review-return`,
  `review-verification resolve`, `tool-request list/resolve/run/grant`,
  `task-assign`, plus the shared `enqueueFixModeRequeue` helper.
- **Compatibility requirements**: every allowed-transition/refusal pair,
  the non-atomic four-step sequence, the Tool Request resolved/
  reject-recovery/active-task/review-claim invariants, and the
  `tool-request grant`/`run` alias (`actionLabel` distinction) — all
  verbatim, per #710 §12 and #708 §7.
- **Verification**: `test/admin-task-clear-delay.test.js`,
  `test/admin-human-review-return.test.js`,
  `test/admin-github-app-review-return.test.js`,
  `test/admin-review-verification.test.js`,
  `test/admin-tool-request.test.js`, `test/admin-tool-request-run.test.js`,
  `test/admin-tool-request-grant.test.js`, plus every #710 §11 test.
- **Rollback**: revert the PR; restore inline bodies. Given this slice's
  size, prefer landing it as a stacked sequence of smaller PRs
  (e.g., one per command group: recovery, human-handoff, tool-request) each
  independently revertible, rather than one monolithic PR — see §5's stop
  condition on partial-slice failure.

#### S7 — UI module finalization

- **Prerequisites**: P1, P2, S1–S6 (see §3's rationale for sequencing UI
  last among command-focused slices).
- **Owned files**: `src/cli/admin-ui.ts` — retype every store-typed function
  (`collectActiveTasks`, `interactiveLoop`, `taskMenu`, `showEvents`,
  `closedTaskMenu`, `closedTaskList`) from `SqliteTaskStore` to `TaskStore`;
  add the `LockStore`-typed constructor call for its `IssueWorktreeLock`;
  fix the duplicate `JsonSessionRegistry` construction (#711 §6.1); thread
  `main()`-supplied **deferred factories** (not constructed ports) into
  `runAdminUi` so the non-TTY guard still runs before any port is built
  (#711 §9.2 point 2).
- **Compatibility requirements**: all 45 named exports in #711 §11 stay
  stable exports (rename forbidden without an explicit, separate decision);
  the three invocation categories (shell-out / in-process / print-only, #711
  §6.2) stay exactly as categorized; the `admin.js`/`admin-ui.js` sibling-
  entrypoint subprocess contract (#708 §8) is unaffected.
- **Verification**: `test/admin-ui-cli.test.js` (all 45 exports importable,
  three-category classification test per #711 §12 item 9), #711 §12 items 8
  (single-construction + non-TTY-guard-precedes-construction).
- **Rollback**: revert the PR; `admin-ui.ts` returns to concrete-class typing.

#### S8 — Composition-root finish

- **Prerequisites**: S1–S7 complete.
- **Owned files**: `src/cli/admin.ts`'s `main()` — replace any remaining
  per-command inline construction with the one-construction-per-need model
  (#711 §9.2 point 1), including the `session-init` factory exception and
  the `repo-lock force-release`/`interventions` no-`SessionRegistry`
  exception.
- **Compatibility requirements**: every exception in #711 §9.2 (session-init
  factory, repo-lock force-release / interventions needing no
  SessionRegistry, admin-ui's deferred factories) preserved exactly; no
  command gains a port it doesn't call.
- **Verification**: full `admin-*.test.js` suite plus a targeted review
  confirming `main()` constructs each adapter class at most once per
  invocation, driven by which command actually runs (a static/manual check,
  not a proposed new automated test beyond what S1–S7 already added).
- **Rollback**: revert the PR; construction remains per-command as landed by
  S1–S7 (functionally correct, just not fully consolidated) — this slice is
  pure cleanup, so reverting it loses no correctness, only the tidiness
  acceptance criterion in §6.

## 4. Temporary dispatch adapters

Per #709 §8, a transitional adapter may only **forward** — same `argv` slice
in, call into the extracted module's exported handler, no new validation,
output shaping, or confirmation gate. This document adds the scheduling
`admin-cli-parsing-contract.md` left open:

- **Which slices need one**: every command-extraction slice, S1 through S6
  (S7 doesn't need one — `admin-ui.ts` is already a separate file; S8 is not
  a command move). Each slice's adapter forwards from `admin.ts`'s `main()`
  if-chain entry for that command to the new module's exported `runXxx`
  function, for exactly the duration of that slice's own PR.
- **Removal milestone**: the adapter for slice `Sn` is deleted in the
  **same PR** that lands `Sn` — per #709 §8's explicit removal criterion,
  once `Sn`'s own contract tests (§3's per-slice verification) pass against
  the new module directly, the forwarding code has no remaining reason to
  exist. A slice's PR description must state explicitly that its adapter was
  both added and removed within that PR; if a slice genuinely cannot close
  in one PR (see S6's stacked-PR note), each stacked PR must say so and
  track the still-open adapter as a named follow-up, never silently left in
  place.
- **What the adapter must never do**: change exit codes, output shape, help
  text, or flag spelling (all pinned by #709 §5–§7) — even "temporarily, to
  make the new module's types cleaner."
- **Verification of removal**: #709 §9 item 9 (transitional-adapter
  absence) — a CI grep/test asserting no forwarding code from a *completed*
  slice remains in the tree — is added once S1 lands and re-run after every
  subsequent slice.

## 5. Test-file decomposition and compatibility test placement

`test/admin-cli.test.js` (2,280 lines) is today's catch-all, mixing
dispatch/registry/parsing/help contract tests with per-command behavior
tests. Several resources already have their own file
(`test/admin-worktree.test.js`, `test/admin-review-lock.test.js`,
`test/admin-task-clear-delay.test.js`, `test/admin-tool-request*.test.js`,
`test/admin-human-review-return.test.js`,
`test/admin-github-app-review-return.test.js`,
`test/admin-review-verification.test.js`,
`test/admin-session-preset.test.js`, `test/admin-context-mode-status.test.js`,
`test/admin-worktree-{cleanup,discard,recovery}.test.js`,
`test/admin-status.test.js`, `test/admin-ui-cli.test.js`); the pattern below
extends that split to full coverage, resource by resource:

- **Stays in `test/admin-cli.test.js`**: only the genuinely cross-cutting
  contract tests owned by #708/#709 — global-flag precedence, `--session-id`/
  `--session-ref` precedence, `--yes`/`--dry-run` pattern classification
  (#709 §9 items 1–8), help rendering and dispatch-error behavior (#708 §9
  items 1–8), and the ownership-map completeness test (#711 §12 item 11).
  These tests assert properties of the *dispatcher*, not of any one
  resource, so they have no other home.
- **Moves out, one resource at a time, in lockstep with the slice that
  extracts it**: each slice in §3 that doesn't already have a dedicated test
  file gains one in the same PR (`test/admin-maintenance.test.js` for S2,
  `test/admin-repo-lock.test.js` for S3's `repo-lock` commands — leaving
  `test/admin-review-lock.test.js` as-is for the alias half — `test/admin-session.test.js`
  for S4's `session-doctor`/`session-init`). A slice's PR must move that
  resource's existing behavior tests out of `admin-cli.test.js` into the new
  file, not merely add new tests alongside the old ones — leaving
  duplicate coverage in both files after a slice lands is itself a slice
  failure (§6 stop condition).
- **New compatibility tests from the four contracts** (#710 §11, #711 §12,
  #708 §9, #709 §9) are added in the port-prep slice (P1/P2/P3) or
  command-extraction slice (S1–S7) that each test's subject belongs to —
  already cross-referenced per-slice in §3's "Verification" bullets above,
  not repeated here.
- **`memory-task-store.test.js`, `json-session-registry.test.js`,
  `repo-lock-store.test.js`** stay store/adapter-level test files, unmoved —
  they test the port/adapter directly, not the CLI command surface, so they
  are not part of the `admin-cli.test.js` decomposition.

## 6. Stop conditions (apply to every slice)

- A slice's diff touches `admin.ts` lines outside its assigned command(s)'
  registration/dispatch range (i.e., unrelated churn to a shared structure
  it wasn't scoped to change) → stop, re-scope the diff before merging.
- A slice's verification suite (its own new tests plus the full existing
  `admin-*.test.js`/`test/*.test.js` regression set) fails and a first fix
  attempt does not resolve it within the same PR → revert the slice, do not
  proceed to the next slice in the sequence (later slices assume this one's
  ports/modules are stable and merged).
- A slice would widen any preservation guarantee from #708 §7, #709's
  pinned exit-codes/output-shapes, #710 §12, or #711 §13 (e.g., letting
  `recoverHandoff` bypass its Tool Request guard, or merging `worktree
  release-lock` and `review-lock release` into one command) → stop; that is
  new workflow behavior requiring its own issue, never a side effect of an
  extraction slice.
- A slice's temporary adapter (§4) cannot be deleted in the same PR that
  introduced it → stop merging further slices until the adapter is either
  deleted or explicitly tracked as a named, time-boxed follow-up issue with
  sign-off — an adapter must never accumulate silently across multiple
  slices.
- Test coverage for the touched resource decreases (test count or assertion
  count) without an explicit justification recorded in the PR description →
  stop; a decomposition PR is never a coverage-reducing PR.

## 7. Rules preventing new commands from being added to the monolith during migration

1. **No new command handler body may be authored inside `admin.ts` once P4
   lands**, regardless of which slice (S1–S8) has or hasn't reached that
   command's resource yet. A new command is written directly in its target
   resource module (per §1's ownership table, extended by whichever contract
   governs its category), even if that module doesn't exist yet as a
   standalone file — in that case, create the module file as part of adding
   the command, and register it through P4's scaffolding immediately. The
   monolith must only ever shrink after P4, never regain a new inline
   handler.
2. **No new entry may be added to `admin.ts`'s `COMMANDS` array as a
   hand-written literal** once P4 lands — new entries are collected from a
   resource module's exported `CommandInfo[]`, the same mechanism P4
   establishes for existing commands.
3. **`enqueue-task.ts`'s missing `isMain` guard is not to be relied upon.**
   Per #708 §2.1, any slice whose extracted module ends up imported by
   `enqueue-task.ts` (directly or transitively) must add the same `isMain`/
   `import.meta.url` guard the other three catalog-only entrypoints already
   have, *before* introducing that import — never assume today's
   side-effecting import behavior is safe to build on.
4. **Recorded, not fixed, boundary violations stay recorded.** Quarantine's
   marker-file access and interventions' raw `Database` handle (#711 §8.1)
   move with S2 exactly as they are today — a slice must not "opportunistically"
   fix them mid-move, since that conflates a relocation PR with a behavior-
   change PR and forfeits this plan's per-slice rollback guarantee (reverting
   S2 should be a pure structural revert, not also lose an unrelated fix).
   If a later issue does fix either, it does so as its own slice, filed and
   sequenced independently of this DAG.
5. **The Session ↔ Task `AgentId` type-only import** (#711 §10's asterisked
   matrix cell) is not to be treated as license for any *new* runtime
   dependency between Session and any other module. Session's dependency
   row in #711 §10 stays `✗` for every other module, permanently.
6. **Outbox, Session audit/pause-resume, and Worktree "shell access"
   remain forward-looking with no owner yet built** (#711 §3.4, §4.3, §7).
   If any of the three is built during or after this migration, it is owned
   by the module §1/§711 already names for it — never bolted onto
   Maintenance or UI because that happens to be the nearest existing command
   group at the time.

## 8. What remains in the thin top-level entrypoint and composition root

After S8, `src/cli/admin.ts` retains exactly:

- `main()`'s first statement, `extractOutputFlags(rawArgv)` (global-flag
  extraction, unchanged — #709 §1).
- The `COMMANDS` aggregation point — assembled by collecting each resource
  module's exported `CommandInfo[]` (P4), not a single hand-maintained
  literal.
- The dispatch if-chain (or its structural equivalent) that matches
  `argv[0]`/`argv[1]` tokens to a resource module's exported handler,
  preserving every classification rule in #708 §3–§6 (single-token vs.
  compound identity, the `session preset` visibility gap, deterministic
  exact-string matching).
- The **composition root**: construction of `TaskStore`, `LockStore`,
  `SessionRegistry`, `OutboxStore`, and provider adapters, one instance per
  process invocation, handed to whichever command handler actually needs it
  (#711 §9.2) — including the `session-init` factory exception, the
  `repo-lock force-release`/`interventions` no-`SessionRegistry` exception,
  and the deferred-factory handoff into `runAdminUi`.
- `help`'s own rendering (it describes the dispatcher itself, not any
  resource).
- The `ui` case, delegating in-process to `admin-ui.ts`'s `runAdminUi`
  (still not a sixth composition root — #711 §9.2 point 2).

Everything else — every `runXxx` command-handler body, every command-specific
argv parser beyond the shared `admin-command.ts` mechanism, and every
resource's own concrete-adapter knowledge — lives in that resource's own
module. `admin-ui.ts`, `run-one-phase.ts`, `github-intake.ts`,
`enqueue-task.ts`, and `dispatch-outbox.ts` remain their own, separate
composition roots exactly as #711 §9.2 already specifies; this plan does not
merge them into `admin.ts`'s.

## 9. Resolving contradictions among the prerequisite specifications

None of the four documents directly contradict each other on a decision; the
gaps between them are things left unresolved because each was scoped to its
own slice. This document closes the ones that matter for sequencing:

- **Target file layout was never pinned.** #708 §8 uses a *hypothetical*
  example (`src/cli/commands/tool-request.ts`); #711 describes ownership by
  module name only. This document adopts `src/cli/commands/<resource>.ts`
  as the recommended (not mandated) layout for Maintenance, Lock, Session,
  Worktree, and Task/Handoff (§3's per-slice "Owned files"); a later
  implementation may split further (e.g., `task.ts` + `tool-request.ts`)
  without revising this plan, since the DAG's edges are module-level, not
  file-level.
- **Ordering of the three independent port-prep items (P1/P2/P3)** was not
  specified by any single contract (each specifies its own port in
  isolation). §2 resolves it: serial, largest-unlock-first (P1 → P2 → P3),
  for the admin.ts-churn reason stated there.
- **Whether Lock's port work blocks Worktree or Worktree blocks Lock** is
  implied but not stated by #711 (§4.2 shows `discard` acquiring a lock, and
  §5.5 defines the port, but the two sections don't cross-reference a
  required order). This document fixes it: P2 (the port) before both S3
  and S5; S3 before S5 (Lock's commands are fully independent of Worktree's,
  so extracting the smaller set first reduces the risk surface S5 inherits).
- **Whether UI extraction can start before Task/Handoff finishes** is
  compatible either way per #711 (UI's dependency is on the *ports*, P1/P2,
  not on Task/Handoff's *extraction*). This document sequences UI last among
  command-focused slices anyway, for the confidence reason in §3, not
  because any contract requires it — a later implementation that finds
  scheduling pressure to move S7 earlier may do so without violating any
  compatibility requirement, as long as P1/P2 have already landed.

## 10. Documentation review

This document is documentation-only: no source file listed in §3 is edited
by this issue. The acceptance criterion "documentation review passes" refers
to review of this document and the update in `docs/DOMAIN.md` (§11 below),
not to any code change.

## 11. Follow-up: `docs/DOMAIN.md` and #613

`docs/DOMAIN.md`'s chain-A sequencing and hot-spot references to "#612 (admin
boundaries)" as the source of #613's per-resource extraction issues are
updated (in this same PR) to point at this document instead — #612 is
superseded in full by #708–#711 (the four prerequisite specs) and this
document (#712), which supersedes #612 for the purpose of generating #613's
per-resource extraction issues. #613 itself is not edited by this
documentation-only issue (issue bodies are not repository files); the
GitHub-side update — repointing #613's description at this document — is a
tracked action for whoever opens the first §3 slice as its own issue, not a
file change here.
