# Feature Status Matrix

Status: **maintained** (issue #946). This is the canonical, repository-wide
answer to "can I use this now, does it require configuration, is it only a
foundation, or is it design-only?" It is an overview and navigation document.
Runtime source and the detailed contracts it links to remain authoritative
for behavior — this matrix never restates their specifications, only points
at them.

## 1. Status vocabulary

Every row below carries exactly one of these six statuses. No other word
(e.g. "partial", "in progress", "beta") is a valid status value; use the
**Gaps** field to describe nuance instead of inventing a new status.

- **`available`** — wired into a supported runtime or operator path with no
  extra configuration required beyond normal setup. An operator can use it
  today by following the linked docs/CLI.
- **`config-gated`** — implemented and wired end to end, but disabled or
  unavailable until an explicit session/runtime configuration flag enables
  it. The **Configuration** field must name the flag and its default.
- **`foundation-only`** — reusable, tested components exist in `src/`, but no
  supported end-to-end operator workflow strings them together. Naming a
  component "implemented" in its own contract does not make the aggregate
  feature `available`; see §2's ChatOps rule.
- **`design-only`** — an approved or draft design exists with no supported
  runtime implementation. `grep -r` for the design's central type/class in
  `src/` returns nothing, or only unused scaffolding.
- **`deprecated`** / **`archived`** — retained only for migration or history;
  not recommended for current operation. The row must name the replacement.

## 2. Inclusion and transition rules

- **A closed design Issue is not evidence of `available`.** Closing the Issue
  that wrote a contract document records an accepted policy, not a shipped
  runtime path. A row only moves off `design-only` when the **Evidence**
  field names a real source file, CLI subcommand, or test that exercises the
  runtime path — never an Issue or PR number alone.
- **Component-level "implemented" is not feature-level `available`.** A
  contract for one layer of a multi-layer feature (see the ChatOps row in §4)
  can correctly say "implemented" for that layer while the aggregate feature is
  `foundation-only` or `config-gated` — because no supported path chains the
  layers together, or because the path exists but is gated.
  When a component doc's status could be misread this way, it must carry a
  pointer back to this matrix (see the ChatOps contracts for the pattern).
- **`foundation-only` → `config-gated` or `available`** happens when a
  handler, CLI subcommand, or scheduled job exists that an operator can
  invoke end to end. It does not require the feature to be on by default.
- **`config-gated` → `available`** happens only when the session/runtime
  default itself flips to enabled — not when the capability merely exists.
- **`available` → `deprecated`/`archived`** happens when a replacement path
  ships and the old path is kept only for migration or compatibility.
- **Every transition needs evidence in the same change.** A PR that changes
  what a feature can do, how it is gated, or whether it is wired must update
  this file's row (and its `Status`/`Configuration`/`Evidence` fields) in the
  same change — see §5.

## 3. How to read a row

Each row lists, in order: **Status**, **Capability** (one operator-visible
sentence), **Configuration** (flag and default, or "none"), **Evidence**
(repository-relative source/CLI paths), **Docs** (authoritative contracts —
detail lives there, not here), **Gaps** (what a reader must not assume), and
**Related Issues** where useful. Detail belongs in the linked contract, not
in a longer row here.

## 4. Matrix

### Core execution pipeline

#### Issue intake and phase execution

- **Status:** `available`
- **Capability:** GitHub Issues enter the loop through label-driven intake
  and advance through a fixed `TaskPhase` pipeline, one phase execution per
  invocation.
- **Configuration:** none; this is the default runtime path.
- **Evidence:** `src/cli/github-intake.ts`, `src/core/github-intake.ts`,
  `src/cli/run-one-phase.ts`, `src/core/transitions.ts`, `src/core/task.ts`.
- **Docs:** [DOMAIN.md](DOMAIN.md), [phase-contracts.md](phase-contracts.md).
- **Gaps:** none known.

#### Implementation, review, conflict resolution, and research (phase handlers)

- **Status:** `available`
- **Capability:** agent-driven implementation, review, conflict-resolution,
  and research phases, each invoked one phase per `run-one-phase` call.
- **Configuration:** agent/model selection is session-configured; the phases
  themselves require no enablement flag.
- **Evidence:** `src/handlers/implementation.ts`, `src/handlers/review.ts`,
  `src/handlers/conflict-resolution.ts`, `src/handlers/research.ts`.
- **Docs:** [handlers-extraction-plan.md](handlers-extraction-plan.md),
  [phase-contracts.md](phase-contracts.md).
- **Gaps:** none behavioral; the handler files themselves are tracked for a
  size/responsibility extraction (issue #692), a maintainability concern, not
  a capability gap.
- **Related Issues:** #692

#### Content research, draft, and review

- **Status:** `available`
- **Capability:** a separate content pipeline (research → draft → review)
  for content-labeled work items.
- **Configuration:** none; on by default for content-labeled items.
- **Evidence:** `src/handlers/content-research.ts`,
  `src/handlers/content-draft.ts`, `src/handlers/content-review.ts`.
- **Docs:** [content-research-mvp-contract.md](content-research-mvp-contract.md),
  [content-draft-mvp-contract.md](content-draft-mvp-contract.md),
  [content-review-mvp-contract.md](content-review-mvp-contract.md),
  [content-human-ready-handoff.md](content-human-ready-handoff.md).
- **Gaps:** each contract is scoped to an MVP; see the individual documents
  for what is explicitly out of scope.

#### Agent assignment profiles

- **Status:** `available`
- **Capability:** configurable, per-role agent-CLI assignment (which agent
  implements, reviews, resolves conflicts, or researches) without hardcoding
  a single pairing.
- **Configuration:** session `assignmentProfiles`/`flowRules`; a session that
  configures neither derives a built-in default profile.
- **Evidence:** `src/core/assignment.ts`; `admin task-assign`.
- **Docs:** [assignment-profiles.md](assignment-profiles.md).
- **Gaps:** none known.
- **Related Issues:** #259, #260, #261, #262, #292

#### Per-Issue worktrees and locking

- **Status:** `available`
- **Capability:** every phase that touches the working tree runs inside a
  dedicated git worktree for that Issue, exclusively locked for the
  duration.
- **Configuration:** none; worktree-only operation is unconditional across
  all repo-working phases.
- **Evidence:** `src/handlers/worktree.ts` (`IssueWorktreeLock`),
  `src/handlers/worktree-context.ts`; `admin worktree list|prune|recovery|
  cleanup|release-lock|discard`.
- **Docs:** [per-issue-worktrees.md](per-issue-worktrees.md),
  [worktree-only-migration-contract.md](worktree-only-migration-contract.md),
  [worktree-rollout.md](worktree-rollout.md).
- **Gaps:** none known.
- **Related Issues:** #400, #731

### Human and planning workflow

#### Human gate (Go/No-go checklist) and human review return

- **Status:** `available`
- **Capability:** phases that need a human decision post a Go/No-go
  checklist comment (`renderHumanGateSummary`); a human's review return —
  either the operator `human-review-return` fallback or the GitHub App's
  auto-detected `CHANGES_REQUESTED` path — re-activates the task and hands it
  back to implementation.
- **Configuration:** none; on by default at the relevant phase boundaries.
- **Evidence:** `src/core/human-gate-summary.ts`; `admin human-review-return`,
  `admin github-app-review-return`.
- **Docs:** [human-review-return-flow.md](human-review-return-flow.md).
- **Gaps:** this is the checklist-and-return path only. There is no
  structured disposition command yet — see the next row for that design and
  what it would add once implemented.
- **Related Issues:** #552

#### Human gate No-go, advice, and disposition flow

- **Status:** `design-only`
- **Capability:** a proposed `admin human-gate no-go` / `apply` / `show`
  surface that would let an operator record structured No-go feedback,
  receive derived `suggestedCommand` advice, and apply one of six
  dispositions (`continue_fix`, `continue_fix_recreate_pr`, `split_followup`,
  `supersede`, `close_not_planned`, `hold_for_discussion`) against a task
  parked at the Human Gate.
- **Configuration:** n/a; no flag exists because no command is wired.
- **Evidence:** none. There is no `human-gate no-go`, `human-gate apply`, or
  `human-gate show` subcommand registered in `src/cli/admin.ts`, and no
  `StoreResultCode`, event, or provider port from the spec exists on `main`.
- **Docs:** [human-gate-no-go-flow.md](human-gate-no-go-flow.md), which
  states in its own opening section that it "is a documentation-only issue.
  No production code (CLI commands, store methods, provider ports) is
  changed here."
- **Gaps:** every item in the spec's §14 follow-up list is open: the store
  refusal code and atomic gate write, the `no-go`/`show` commands, the advice
  generator, non-destructive `apply` (`continue_fix`, `hold_for_discussion`),
  the host ports the destructive dispositions depend on, and
  `continue_fix_recreate_pr` / `split_followup` / `supersede` /
  `close_not_planned` themselves. This domain, its feedback/advice behavior,
  and its disposition flow are already tracked by the issues below — treat
  any new task against this row as duplicate work, not a fresh design.
- **Related Issues:** #747, #750, #751, #752, #753, #754, #755, #756, #757,
  #758, #759, #760, #761, #762, #763, #764

#### Issue planning and AI preview

- **Status:** `available`
- **Capability:** preview and evaluate an implementation plan for an Issue
  before activation, including an AI-generated preview and a backtest
  evaluation against historical outcomes.
- **Configuration:** none required to preview.
- **Evidence:** `src/cli/issue-plan.ts`, `src/cli/issue-plan-ai.ts`,
  `src/cli/issue-plan-history.ts`; `admin issue-plan preview|ai-preview|
  evaluate-history`.
- **Docs:** [ai-planner-gate-architecture.md](ai-planner-gate-architecture.md),
  [issue-planning-gate-contract.md](issue-planning-gate-contract.md),
  [issue-plan-backtest.md](issue-plan-backtest.md).
- **Gaps:** none known.

#### Issue refinement

- **Status:** `config-gated`
- **Capability:** chain-aware progressive rewriting of a dormant dependent
  Issue's body once its blocker reaches a stack-ready result, then automatic
  handover into ordinary implementation.
- **Configuration:** `session.issueRefinement.enabled`, default `false`.
- **Evidence:** `src/core/issue-refinement.ts`,
  `src/core/issue-refinement-eligibility.ts`,
  `src/core/issue-refinement-progress.ts`,
  `src/core/issue-refinement-progress-status.ts`,
  `src/core/issue-refinement-topology.ts`,
  `src/handlers/issue-refinement-apply.ts`, `src/cli/issue-refinement-loop.ts`,
  `src/core/issue-refinement-recovery.ts`,
  `src/cli/issue-refinement-recover.ts`;
  `admin refinement run`, `admin refinement recover`, `admin task-status`.
- **Docs:** [issue-refinement-contract.md](issue-refinement-contract.md)
  (status line corrected alongside this matrix — it previously read "not yet
  implemented"), [idea-to-implementation.md](idea-to-implementation.md).
- **Gaps:** subject to the publication and config boundaries the contract
  describes; a session that has not opted in treats
  `status:needs-refinement` as an inert label. An Issue whose predecessors are
  not yet usable is held by intake as a non-runnable `blocked` task and
  released automatically once they are (§4), so marking a chain ahead of time
  costs no worker turn; removing the marker while an Issue is held leaves the
  parked row for an operator to re-mark. Progress milestones (issue #975) are
  persisted in SQLite and published as append-only Issue comments through the
  outbox (issue #976), one per committed milestone, and rendered by
  `admin task-status` (human and `--json`) and the admin UI from one shared
  normalized model (issue #977). Those surfaces read the task row and the
  persisted milestone events only — SQLite stays authoritative and the Issue
  comments are a one-way projection. A stopped attempt
  (`ready_for_human` / phase `refinement` / `escalated_human`) is returned to
  the lane with `admin refinement recover` (issue #980): §13's single operator
  edge, previewing by default and applying row 36 with `--yes`. No automatic
  transition leaves that state, and there is deliberately no command that
  resumes a handoff mid-lane.
- **Related Issues:** #866, #867, #868, #869, #870, #871, #967, #975, #976,
  #977, #980

### Tool Request and verification

#### Tool Request grant (single-use) and guided continuation

- **Status:** `available`
- **Capability:** an operator can authorize one previously-blocked command
  for a task with a single-use grant; the orchestrator runs it on the
  operator's behalf, captures the result, and takes an explicit disposition
  for any changes it produced. The existing automated execution path
  consumes the resolution on the next retry, so the continuation behavior is
  wired end to end.
- **Configuration:** none; operator-invoked per task.
- **Evidence:** `src/core/tool-request-grant.ts`; `admin tool-request run`
  (the current operator surface — issue #430's redesigned successor).
  `admin tool-request grant` still exists but is a deprecated alias for
  `tool-request run` (`src/cli/admin.ts`, `tool-request grant` command
  description).
- **Docs:** [guided-tool-request-flow.md](guided-tool-request-flow.md),
  [tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md),
  [tool-request-redesign.md](tool-request-redesign.md) (§9a records that
  issue #430 already implements the core operator-experience track described
  here — the document's own top-of-file "specification" status line predates
  that and covers only the still-unimplemented follow-up items in §9).
- **Gaps:** this is the single-grant primitive only. There is no typed
  tiering and no automatic/unattended granting — see the next two rows.
- **Related Issues:** #419, #428, #430, #445, #454, #458, #472

#### Tool Request grant tiers (typed policy)

- **Status:** `design-only`
- **Capability:** not shipped. The design specifies typed operation tiers
  (blocked/relaxed/pre-approved) to replace today's single ad hoc grant.
- **Configuration:** n/a — no runtime behavior yet.
- **Evidence:** none; `grep -r "GrantTier" src/` has no matches.
- **Docs:** [tool-request-grant-tiers-contract.md](tool-request-grant-tiers-contract.md)
  ("Nothing in this document is implemented").
- **Gaps:** entire tiered policy is unimplemented.
- **Related Issues:** #697

#### Unattended Tool Request operation

- **Status:** `design-only`
- **Capability:** not shipped. The design specifies auto-executing
  pre-approved commands without a human grant.
- **Configuration:** n/a — no runtime behavior yet.
- **Evidence:** none in `src/`.
- **Docs:** [unattended-tool-request-contract.md](unattended-tool-request-contract.md)
  ("adds no runtime behavior").
- **Gaps:** the full 25-slice decomposition is unstarted.
- **Related Issues:** #919

#### Verification (per-phase, inline repair)

- **Status:** `available`
- **Capability:** implementation-phase verification commands run before
  commit/push; a failure blocks the commit/push (reported as a failed run,
  with a dirty-continuation patch captured for the next attempt), after one
  bounded automatic inline repair attempt.
- **Configuration:** verification commands are configured per session/task;
  behavior is on by default once a command is configured.
- **Evidence:** `src/handlers/verification.ts` (command execution),
  `src/handlers/implementation.ts` (verification gating and the bounded
  `MAX_VERIFICATION_REPAIR_ATTEMPTS` repair loop).
- **Docs:** none dedicated — do not confuse with the *unified* engine below.
- **Gaps:** today's verification is per-phase and handler-invoked. Issue
  #934's classify-and-cap `needs_fix` requeue **has since merged** —
  `src/core/implementation-verification.ts` classifies the post-repair
  failure and `src/core/transitions.ts` carries the
  `implementation` + `needs_fix` row — so an ordinary red suite is no
  longer terminal; this row's earlier claim that the work sat unmerged
  on `ai/issue-934` was stale and was corrected while inspecting main
  for issue #1094. What remains missing is staging: every lane still
  runs the whole configured set on every cycle, no run records *which*
  checks ran, and no full per-Issue validation gates the stack-ready
  marker (see the staged verification row below).
- **Related Issues:** #934, #1094

#### Unified verification execution engine (runner-owned)

- **Status:** `design-only`
- **Capability:** not shipped. The design specifies runner-owned
  verification cycles independent of any single phase handler.
- **Configuration:** n/a — no runtime behavior yet.
- **Evidence:** none in `src/`.
- **Docs:** [verification-execution-contract.md](verification-execution-contract.md)
  ("adds no runtime behavior").
- **Gaps:** fully unimplemented.
- **Related Issues:** #918

#### Verification amendment (task-scoped, operator-owned)

- **Status:** `available`
- **Capability:** the full task-scoped operator surface exists — `admin
  task-verification show | amend | refresh-from-issue | reset` (issue
  #1042, alongside the `admin review-verification refresh` spelling from
  issue #1041) inspects one task's effective verification plan and
  corrects it as auditable, task-scoped revisions — and, since issue
  #1043, the correction takes effect: review Step 4.5 gates on the
  effective requirement layer, and an applied revision on a review-lane
  park takes its §9.2 continuation, re-queuing `{queued, review}` (or an
  explicit `--continue implementation`) in the same transaction that
  persists the amended plan, clearing the stale missing-command state so
  a typo correction proceeds straight to a fresh review verification run
  instead of repeating the park or spending a no-op implementation
  cycle. Since issue #1044 the same flow is reachable from `admin ui` and
  is publicly visible: an applied revision posts one bounded work-item
  comment naming the operations, the reason, the resulting active and
  retired commands, and the continuation, and the human-gate summary
  states that the plan was amended and what it no longer checks —
  reporting the plan's true retired total, not the length of the label
  list it bounds. **Limitation:** review Step 4 still executes the raw
  `session.verification` entries, so an execution-layer slot an
  amendment adds or replaces is a recorded plan change that the loop
  neither runs nor credits at the gate, and one it RETIRES keeps
  running — and keeps being reported as run — until the session's own
  configuration changes; the comment and the human-gate summary both
  say so rather than presenting a task-local addition as a check the
  task now runs, or an execution-layer retirement as a check that
  stopped. Only the requirement layer carries the "not run, not passed"
  statement. **Limitation:** on a split-provider session (private
  work-item tracker, public repo host) the human-gate summary carries
  only the public-safe aggregate — every count and digest, none of the
  operator's reason or the command labels, which are the private work
  item's own text and stay on it. A session is split when the two
  providers do not address the same repository: `github-issues` + `github`
  is one surface, and so is a self-hosted `gitea-issues` + `gitea` pair
  naming the same instance, owner, and repository. Anything else — a
  Gitea work-item repo distinct from the code repo included — withholds.
- **Configuration:** none. `admin task-verification show --session-id
  <id> --issue-number <n>` is read-only. `amend`, `refresh-from-issue`,
  and `reset` preview and write nothing without `--yes`; `--reason` is
  mandatory, `--expect-plan-digest` / `--expect-issue-digest` guard
  against a plan or Issue that moved since the preview, and
  `--allow-retire` is required before a refresh or a reset removes a
  check. `refresh-from-issue` reads GitHub work items only; another
  work-item provider refuses as `unsupported_provider`. The `admin ui`
  task menu offers the same plan and the same corrections — every §5.2
  operation, `annotate` included, plus the refresh and the reset — and
  the same `--continue` choice, offered on the rows the §9.2 table lets
  a revision re-queue and withheld on the rows where an explicit
  `review` or `implementation` would only refuse. It runs the
  same commands with the same preview-then-confirm posture and carries
  everything the preview reported into the apply it confirms — the plan
  digest; on a refresh the live Issue digest AND the plan digest that
  preview itself resolved (the `base -> new` pair, or the `(unchanged)`
  digest of a no-change preview, never one read from an earlier screen;
  a preview naming neither offers no apply), since an amendment can move
  the difference with the Issue untouched; and one request key minted
  per correction, named on the preview and on the apply — including on a
  reset, whose preview names the key to pass back — so two byte-identical
  corrections stay two requests instead of the second replaying the
  first, while re-running the printed apply line still replays instead
  of reading as "nothing left to undo". A replacement
  for a command whose printed bytes were redacted is typed in full
  rather than prefilled, so a `<path>` placeholder can never be stored
  as an executable command. It holds no plan resolution, no operation
  derivation, and no write of its own.
- **Evidence:** `src/core/verification-amendment.ts` (issue #1038) — the
  §5.5 persistence slice: the append-only revision chain and the mutable
  plan checkpoint persisted in task context, fail-closed state
  validation, and the atomic apply/rebase writes committed through
  `TaskStore.completePhaseWithEffects` with their §12.1 audit events,
  with behavioral tests in `test/verification-amendment-store.test.js`.
  `src/core/verification-plan.ts` (issue #1039) adds the §6 resolution
  half of slice A1: the deterministic, side-effect-free effective-plan
  resolver over the three requirement-side layers, the §5.4 plan
  digest, the §5.2 authoring composition with its explicit refusals,
  the §6.4 reconciliation, and §6.2 rule 3 satisfaction, with tests in
  `test/verification-plan-resolution.test.js`.
  `src/core/verification-evidence.ts` (issue #1040) binds manual
  verification evidence to the plan digest and revision ordinal, the
  §5.1 slot identity, and the reviewed branch HEAD it was recorded
  against: review Step 4.5 (`src/handlers/review.ts`) and `admin
  review-verification resolve` (`src/cli/admin.ts`) consult the §6
  resolver for evidence identity, legacy unbound evidence is
  conservatively rejected, and stale evidence fails closed, with tests
  in `test/verification-evidence.test.js`.
  `src/core/verification-refresh.ts` and `admin review-verification
  refresh` (issue #1041) add the §10 refresh slice: a provider-neutral
  live read of the Issue body, projected through the shipped extractor
  and diffed one-to-one against the effective requirement layer, applied
  as one `issue-refresh` revision of requirement-layer operations. It
  previews by default, never emits a `replace`, withholds retirements
  without `--allow-retire`, records the `issueBodyDigest` it read, and
  refuses whole on an unsupported provider, a provider failure, a
  missing Issue, a body with no supported verification section, a body
  that moved since the preview, or an unmappable diff — with tests in
  `test/verification-refresh.test.js` and
  `test/admin-review-verification-refresh.test.js`.
  The intake-time `context.body` is never rewritten: a refresh changes
  the requirement layer only, and review Step 4.5 reads the pinned body
  through the effective-plan resolver (issue #1043), never a live one.
  `src/core/verification-amend.ts` and the `admin task-verification`
  commands (issue #1042) add the §11 slice A4 operator surface: a
  read-only effective-plan view carrying slot identity, origin, state,
  revision history, and evidence status; an `amend` whose
  order-sensitive flag grammar binds each `--command`/`--op-reason` to
  the operation it follows and composes them into one revision; and a
  `reset` that returns an amended plan to its baseline through
  `restore`/`replace`/`retire` operations rather than by deleting
  anything. Tests in `test/verification-amend.test.js` and
  `test/admin-task-verification.test.js`.
  Issue #1043 wires §9 continuation and the requirement-layer gate: the
  atomic apply (`src/core/verification-amendment.ts`) re-queues a
  routing revision `{queued, <continuation>}` and invalidates the stale
  missing-command, status-snapshot, and evidence-binding context in the
  same CAS-guarded transaction that persists the plan — preserving
  `manualVerificationEvidence` untouched — while review Step 4.5
  (`src/handlers/review.ts`) gates on the effective requirement layer,
  excludes retired slots, and reports them `retired`, never passed.
  Issue #1044 closes slice A7 and the operator surface:
  `src/core/verification-amendment-publication.ts` projects one applied
  revision onto the §12.2 work-item comment — idempotency-keyed on
  `revisionId` and on no run identifier, enqueued through the outbox in
  the SAME transaction as the revision, with every retirement and
  restoration named and the "a retired command is not a passing result"
  statement beside them — and onto the run-summary block the human gate
  renders (`src/core/human-gate-summary.ts`). A record-only amendment
  (`--continue none`) that MOVES the plan digest, applied to a task
  already parked at `ready_for_human`, also rewrites that PR's sticky
  Human Gate Decision Summary in the same transaction, superseding a pass
  that described the pre-amendment plan; a routing continuation retracts
  the handoff itself and supersedes nothing, and neither does a revision
  that leaves the digest where it was (an `annotate`, or an operation on
  a slot the plan no longer holds) — the parked pass still describes the
  effective plan. `admin ui` gains a
  Verification entry (`src/cli/admin-ui.ts`) that renders the `show`
  payload and drives add/replace/retire/restore/refresh/reset through the
  same commands, previewing each one and carrying the displayed plan
  digest into the apply. `admin review-verification resolve` now refuses
  a command an amendment orphaned (§13.1). Tests in
  `test/verification-amendment-publication.test.js`,
  `test/verification-amendment-e2e.test.js`, and
  `test/admin-ui-cli.test.js`.
- **Docs:**
  [verification-amendment-contract.md](verification-amendment-contract.md),
  with structural tests in
  `test/docs-verification-amendment-contract.test.js`.
- **Gaps:** the execution half of slice A3 is open: review Step 4 still
  executes the raw
  `session.verification` values, so an execution-layer `add`, `replace`,
  or `retire` changes what is recorded and digested but not what the
  review lane runs — and the requirement gate deliberately never credits
  an execution-layer `add` it did not run — so every surface states an
  execution-layer amendment as a recorded plan change that leaves session
  execution unchanged, and never as a check that ran or stopped running.
  The public comment is an Issue comment on the work item and never a PR
  review comment (the only PR write is the sticky human-gate summary
  above), and no amendment changes a label (§12.2). Session-default management
  (editing `session.verification` through an operator surface) is an
  explicit non-goal of the contract and has no design yet.
- **Related Issues:** #1037, #1038, #1039, #1040, #1041, #1042, #1043,
  #1044

#### Staged verification (loop and final stages)

- **Status:** `config-gated`
- **Capability:** the `loop` stage runs in the **implementation lane**,
  and only there. The design specifies a `loop` stage on every normal
  cycle and a `final` stage that runs the entire required set per Issue,
  after AI review approval and before the stack-ready grant is
  published. Issue #1155 retired the group-selection policy that once
  made the loop stage lighter than the final one: both now run the
  **entire required set** of non-test checks, and the bound test suite
  entry leaves both for the changed-file stages
  (`docs/changed-file-verification-contract.md`). What an opted-in
  operator gets today is the first half of that: at the shipped
  pre-commit verification moment the runner resolves the effective plan,
  runs the required set with the shipped spawn, budget and
  `verification-<name>.log` artifacts, and writes a stage bundle beside
  them — what ran, what each check returned, what the run did not reach
  and why, and whether that set was the whole required one. A check the
  run did not reach is never reported as passed: the repair prompt and
  the PR body both name only the checks that recorded a pass and say
  when the cycle ran a subset. Routing is untouched — a red suite takes
  the same #934 repair-and-requeue road it takes today — and the stage
  grants nothing. What an operator can also still do is **write and
  validate the configuration**: a malformed staged block stops session
  load, and a session still carrying a retired group-selection setting
  is refused rather than half-applied (#1102). Beside it sits the
  vocabulary a stage records: one command execution — a pass, a nonzero
  exit, a failed spawn, a deadline, a signal kill — becomes one verdict
  plus a per-check record (#1098). Beside that sits the durable shape
  a stage run would leave behind: an ordinal and a seven-component
  identity written before any check could launch, one evidence bundle
  written at the end, and nothing observable in between — so an
  allocation with no bundle reads as an interrupted run that credits
  nothing, a replayed recording re-records nothing, and a bundle can
  never claim a completeness its own verdicts contradict (#1099).
  Beside that sits the rule that decides whether such a bundle may ever
  be *used*: two identities match only when all seven components match,
  a component the configuration authoritatively declares empty matches
  another empty one, and an unattestable component matches nothing —
  including another unattestable one. A moved commit, an amended or
  Issue-refreshed plan, a re-edited working tree, a session-baseline
  drift, a changed test suite binding or a moved environment
  declaration each make earlier evidence inadmissible for the two uses
  the design admits — satisfying a final stage without re-running it,
  and publishing the stack-ready grant — and evidence written before the
  identity existed is admissible for neither. Invalidation deletes
  nothing: a refused bundle stays readable with the identity that
  refused it on it (#1100). Beside that sits what a stage run covers:
  every `active` slot of the resolved plan, the execution layer first
  and then the requirement layer, each in plan order. Nothing is
  consulted to decide it and nothing can narrow it — issue #1155
  retired #1101's selection port, its five-set union and the
  `selectable` / `finalOnly` membership, so a stage runs all of it and
  the only entry that ever leaves is the bound test suite, which the
  changed-file stages replace. The implementation lane calls all of it, and adds the
  judgment over the results: one run's verdicts aggregate onto one of
  six outcomes, where an absence the run accounted for — the checks a
  first-failure stop never reached, a requirement its failing command
  left unproven — routes by the failure that caused it, and an absence
  nobody accounted for is an integrity failure that never reads as a
  pass. An Issue-demanded command is judged over the checks this run
  proved green rather than over the plan's configured shape, so a
  requirement can never read `passed` on work the cycle did not perform
  (#1102). After the review agent approves, the review lane now runs the
  other half: the entire required set at the approved head, with each
  check under the review deadline, recorded
  as a final bundle in the same completion that publishes
  `status:stack-ready` — and the marker is published only when that
  bundle is complete, passed, full and bound to the head the reviewer
  approved. A failing or expired final check returns the whole failing
  set to the fix loop under the review cycle cap; evidence that cannot be
  attested parks for an operator; an interrupted or host-failed run and a
  head that moved under the run re-run the stage without an agent, up to
  `maxStageRecoveryAttempts` in a row; and a declaration left by an
  earlier run never publishes a later one. No PR is merged and nothing
  waits for the end of the chain (#1103). The failing set that returns to
  the fix loop names each failing check by its plan id, the revision and
  plan digest the final stage tested, and a bounded output tail per check
  — a timeout's tail labelled as output observed before the deadline —
  and lists the checks the failure left unproven as not known to pass. A
  code verdict that names no failing check or cannot attest the revision
  it tested parks for an operator instead of spending a review cycle
  (`src/core/final-stage-repair.ts`, tests in
  `test/final-stage-repair.test.js`) (#1104). Deadlines, restarts and
  host failures stay recoverable without weakening either stage: a check
  killed at its deadline whose process-tree cleanup could not confirm the
  group is gone makes the run `unknown` rather than an ordinary timeout,
  because the worktree may still hold a process nobody accounted for; a
  final stage persists the approval it verifies with its pre-launch
  allocation, so a run lost to a crash or a restart resumes only the
  final stage at the same head instead of the review agent; the end-of-run
  re-check re-reads the task row, so a plan change that lands mid-run
  unbinds the grant; and in the implementation lane an `unknown` loop
  stage retries under the same bounded budget as every other non-code
  termination (issue #1155 retired #1094 §7 row 5's single
  re-run-the-whole-set path, because a stage run already covers the
  entire required set), a host
  failure delays with no inline repair and — on the next claim, when the
  preserved worktree is byte-identical — re-verifies it without another
  agent turn, and consecutive non-code terminations past
  `maxStageRecoveryAttempts` park. No park discards the worktree, and no
  lock is added (`src/core/stage-recovery.ts`, tests in
  `test/staged-verification-recovery.test.js`) (#1106).
- **Configuration:** the opt-in is a `session.stagedVerification` block
  defaulting to disabled (`enabled`, `maxStageRecoveryAttempts`,
  `environmentIdentity`, `testSuite`) — every refusal fail-closed at
  load, and `testSuite` required whenever `enabled` is true. Issue #1155
  removed the group-selection settings outright — `selectable`,
  `finalOnly`, `selectionTimeoutMs`, `selectionAdapter`,
  `resultAdapters` and `resultTimeoutMs` — together with the
  `.ai-cli-loop/verification.json` project file, the selection port and
  the result adapter. There is no migration, alias, deprecation warning
  or compatibility mode: a session still carrying one of those settings
  is refused at load by the closed-field rule, and the operator removes
  it. Enabling the block turns on the implementation lane's loop stage
  and the review lane's final stage, and both now run the **entire
  required set** of non-test checks; the bound test suite entry runs
  only under Stage 1 (the Issue's changed and retained test files) and
  Stage 2 (the full suite at the approved head), per
  `docs/changed-file-verification-contract.md`.
- **Evidence:** `src/core/staged-verification-config.ts` (the session
  block, its fail-closed validation and its defaults), loaded through
  `src/registries/json-session-registry.ts`; tests in
  `test/staged-verification-config.test.js` (#1097). Issue #1155 deleted
  `src/core/project-verification-file.ts` and
  `test/project-verification-file.test.js` with the project file itself.
  Then `src/core/verification-result.ts` (the per-check execution record
  and the command-outcome classification derived from the shipped
  `classifyVerificationFailure` /
  `classifyVerificationEnvironmentFailure` path), with tests in
  `test/verification-result.test.js` (#1098) — #1155 removed the
  structured result envelope and the opaque-command result adapter from
  both. Then
  `src/core/staged-verification-state.ts` (the `stagedVerification` task
  context key: `allocateStageRun`, `recordStageRun`, the stage run
  ledger, the evidence bundle with its identity, and the R1/R3/R4
  retention the shape itself expresses), written through the shipped
  `TaskStore.completePhaseWithEffects` CAS with no new store, no new
  table and an effects seam for a later slice's grant; tests in
  `test/staged-verification-state.test.js` (#1099) — read and written by
  the review lane's final stage since #1103. Then `src/core/stage-evidence-validity.ts` (the
  §4.4 matching law and its mismatch vocabulary, the final-stage reuse
  and grant-binding admissions over #1094 §4.4's shipped conditions with
  their closed refusal set, and the §4.5 component derivations: the
  content-bound working-tree fingerprint, the plan components read from
  the shipped #1037 checkpoint and `reconcileVerificationPlan`
  classification, the suite-binding digest that is the only stage
  configuration left to attest, and the declared-only environment
  identity), with tests in
  `test/stage-evidence-validity.test.js` (#1100) — pure, no I/O, and
  called by the review lane's final stage since #1103. Issue #1155
  deleted `src/core/stage-selection.ts` and
  `test/stage-selection.test.js` outright — the selection port, its wire
  protocol, the effective selectable set and §4.2's five-set union — and
  relocated the required set itself into `src/core/stage-run.ts`, which
  is the whole of what a stage covers. Then `src/core/stage-run.ts` (the
  §6.1 outcome precedence with its accounted-absence table, §4.3's
  proven projection and §6.2 rule 6's requirement verdicts over it, the
  assembly of a bundle #1099 persistence accepts, and §10 rule 5's
  bounded public projection) with tests in `test/stage-run.test.js`, and
  `src/handlers/stage-verification.ts` (the lane side: the reconciled
  plan, the required set executed with the lane's own `CommandRunner`,
  and the bundle artifact) reached from
  `src/handlers/implementation.ts`, with tests in
  `test/stage-verification.test.js` (#1102). Then
  `src/core/final-stage-gate.ts` (§7 rows 7–13 over a final bundle and
  the stack-ready publication gate the label builder reads) with tests
  in `test/final-stage-gate.test.js`, and the final stage in
  `src/handlers/stage-verification.ts` — the run's identity resolved
  before launch and re-resolved after, `allocateStageRun` /
  `recordStageRun` replayed over the task's own context so the recorded
  bundle rides the review completion — reached from
  `src/handlers/review.ts`, with tests in
  `test/final-stage-verification.test.js` (#1103). The
  design deliberately extends shipped modules
  rather than adding an engine — `src/core/verification-plan.ts`,
  `src/core/verification-amendment.ts`, `src/handlers/verification.ts`,
  `src/core/implementation-verification.ts`, `src/core/task-store.ts`
  and `src/core/outbox-effects.ts`: `runVerification` gained an optional
  stage-scoped check map (and, for the final stage, a per-check
  deadline) and records what it ran, the store gained nothing, and the
  publication module reads the final stage's grant only through
  `enqueueStatusLabelEffects`.
- **Docs:** [staged-verification-contract.md](staged-verification-contract.md)
  (issue #1094, "no runtime behavior ships with it"), with structural
  tests in `test/docs-staged-verification-contract.test.js`, and
  [project-verification-contract.md](project-verification-contract.md)
  (issue #1095, the project-owned configuration and adapter contract,
  likewise "no runtime behavior ships with it" — **superseded by #1158**:
  issue #1155 deleted the project file, the selection port and the
  result adapter it specified, and the document is kept as the design
  record of a retired policy), with structural tests
  in `test/docs-project-verification-contract.test.js`, and
  [verification-evidence-validity-contract.md](verification-evidence-validity-contract.md)
  (issue #1096, the evidence-identity, pinned-regression and recovery
  contract that closes the chain's design half, likewise "no runtime
  behavior ships with it"), with structural tests in
  `test/docs-verification-evidence-validity-contract.test.js`, and
  [staged-verification-operations.md](staged-verification-operations.md)
  (issue #1107, rewritten by issue #1155 and corrected by issue #1167:
  configuration, generic command integration, the test suite binding, reading
  the stage view, and recovery), with structural tests in
  `test/docs-staged-verification-operations.test.js`, and
  [changed-file-verification-contract.md](changed-file-verification-contract.md)
  (issue #1158, the approved changed-file / full-suite contract that
  retires this chain's selection policy; issue #1154 wired Stage 1 and
  Stage 2 into the implementation, review and conflict-resolution lanes
  and the final stage for sessions with a `testSuite` binding), with
  structural tests in
  `test/docs-changed-file-verification-contract.test.js`, and
  [changed-file-verification-validation.md](changed-file-verification-validation.md)
  (issue #1156, the published validation of the replacement on a real
  project and its measured Stage 1 / Stage 2 costs), with structural tests in
  `test/docs-staged-verification-operations.test.js`. The stage view is
  `src/core/staged-verification-status.ts`, with tests in
  `test/staged-verification-status.test.js`.
- **Gaps:** six of the 12 implementation/validation slices have landed —
  S2, the configuration slice (#1097), S6, the selection port
  (#1101), S3 with S7, the stage-scoped execution input at
  `runVerification` and the implementation lane's loop stage (#1102),
  and S9 with S10, the review lane's per-Issue final stage and the
  stack-ready publication gate (#1103) — plus S1, now finished across
  #1098's result half, #1100's matching law, #1101's selection
  algorithm and #1102's outcome precedence, and S4 across #1099's
  persistence half and #1102's requirement projection and bundle
  artifact; neither #1095 nor #1096 added a slice, so six remain.
  **The loop stage still runs in one lane only, and only a final stage
  grants.** The review, conflict-resolution and
  tool-request-continuation lanes (S8) still run the whole configured
  set on every loop cycle with no loop bundle. For an opted-in session
  `status:stack-ready` is no longer granted on a passing review alone:
  it is published only by the completion that records a complete,
  passed, full-set final bundle bound to the approved head. Three pieces
  of the design are still absent: issue #1155 retired the regression set
  (R2, #1105) and the loop pin set (R6) with the selection they were
  unioned into — every loop stage runs the entire required set, so a
  check a failure left unproven is run again by the next cycle because
  everything is, not because it was pinned, and there is no pin record
  (S5); only the final stage resolves an identity, so no loop bundle can
  satisfy a final stage or bind a grant; and the implementation lane's
  loop stage now bounds its non-code terminations (#1106) — an `unknown`
  run retries under the same budget as every other non-code termination, a
  host failure delays with no agent turn, and consecutive non-code
  terminations past `maxStageRecoveryAttempts` park with the worktree
  preserved — but the review, conflict-resolution and
  tool-request-continuation lanes' loop verification is still re-run
  without a counted bound (S8). A final stage
  allocates its run in the task store before any check launches, so an
  interruption is recorded by the next claim's allocation, counts toward
  `maxStageRecoveryAttempts`, and is re-run from the beginning, never
  resumed or credited. `admin task-verification show` now carries the
  stage view (#1107): whether the Issue is only review-approved, waiting
  on its final stage, withheld, or holding completed final evidence; the
  last loop and final bundles with selected and required checks,
  verdicts and durations; the reasons a bundle no longer binds; the
  Issue base and the test files a failed Stage 2 retained; and the
  recovery counters. The
  Human Gate summary of an opted-in session states the final stage the
  same way. S11's `stage release` and `stage reset-attempts` operator
  actions are not built.
  The first project integration (S12, #1108) has been retired with the
  policy it measured: issue #1155 deleted `scripts/loop-selection.mjs`,
  `scripts/staged-verification-baseline.mjs`, the committed
  `.ai-cli-loop/verification.json` pin and `test/loop-selection-adapter.test.js`.
  Nothing replaces them — the changed-file stages need no project-side
  selection adapter, because they select nothing beyond the Issue's own
  changed and retained test files.
  **The replacement's own project integration (#1156) is validated but
  unfinished.** `test/changed-file-verification-e2e.test.js` drives the
  contract's §7 trace on a real project — this repository's own Jest over
  a plain-CommonJS git repository, through the phase runner, a durable
  SQLite store and the shipped review handler — covering a selected-file
  pass, review approval, a failing full suite, the retained failing file
  on the next loop, a passing full suite and the stack-ready grant, plus
  a rejected review that runs no full suite at all. The one project-side
  wiring change is a `test:files` script in `package.json` (the same Jest
  invocation without the `pretest` rebuild), so a bound stage builds once
  through `setupCommand` rather than once per suite launch. The measurement
  has been taken: `scripts/changed-file-stage-timing.mjs` ran on this
  repository on 2026-09-18, and
  [changed-file-verification-validation.md](changed-file-verification-validation.md)
  §5.2 publishes the selected file list, the launched commands, the
  durations and the host conditions — a three-file Stage 1 at 36.8 s
  (28.4 s of tests plus 8.4 s of build and discovery) against 779.0 s for
  the whole 315-file suite, 4.7 %, with the whole suite still run in full
  after approval. What is still missing is opt-in: no session in this
  repository binds the suite, and the operator owns that step
  (#1158 §10.1 D4). Until then this repository's own loop still runs
  the whole suite as an ordinary verification command.
  **The binding that step adds now also declares which Issue requirement
  it discharges (#1166).** The suite binding takes an optional
  `requirementCommands` list — the Issue-requirement command texts a
  complete Stage 2 of the bound entry satisfies — because the command an
  Issue requires and the command a stage launches are two operator
  decisions and may differ. Here they do: Issues require `npm test` while
  the binding runs `npm run test:files`, so without
  `"requirementCommands": ["npm test"]` every Issue would block at the
  review gate on a command no configured check runs. The declaration is
  operator-authored, applies only to the bound entry, is part of the
  binding's configuration identity, and satisfies nothing on its own — the
  requirement stays pending until a complete passing Stage 2 records it.
  **The operator guide and the integrated regression were corrected last
  (#1167).** Every enabled configuration example in
  [staged-verification-operations.md](staged-verification-operations.md) now
  carries the `testSuite` binding the schema requires and is validated against
  the shipped loader by `test/docs-staged-verification-operations.test.js`, the
  guide states what a stage actually runs (every required *non-test* check,
  with the bound suite relocated to the changed-file stages) instead of the
  retired complete-set explanation, and `test/changed-file-verification-e2e.test.js`
  drives the `npm test` requirement, the D5 accepted-base advance and the D6
  all-skip results through the real Jest and the real lanes. Two distinctions
  the documents now make explicitly: the published timings are **historical**
  (one pass at head `60cb22dc`, before #1165/#1166, never re-taken, and no
  performance guarantee), and the feature is **implemented but not activated**
  — no session in this repository binds the suite, so the loop still runs
  `npm test` as an ordinary verification command.
  **A Vitest suite can now be bound too (#1174).** `adapter: "vitest"` joins
  `jest` in the closed adapter set, behind the same boundary and the same
  stages, selection, retention and grant rules
  (`src/handlers/vitest-test-adapter.ts`,
  [changed-file-verification-contract.md](changed-file-verification-contract.md)
  §6 rule 6). Supported: Vitest 3 from 3.2. Because Vitest selects files by
  path substring rather than exact path, every Stage 1 run first asks
  `vitest list` what its file arguments select and refuses a similarly named
  file instead of running it; the bound command must invoke the Vitest
  executable itself, not a package script; and each test file must belong to
  exactly one configured project. A real-Vitest fixture
  (`test/vitest-test-file-adapter-fixture.test.js`) and the §7 trace over real
  lanes (`test/changed-file-verification-vitest-e2e.test.js`) verify it; Vitest
  is a devDependency those tests use, and this repository's own suite stays on
  Jest. Like the Jest binding it is **implemented but not activated**: no live
  session binds it.
- **Related Issues:** #1094, #1095, #1096, #1097, #1098, #1099, #1100,
  #1101, #1102, #1103, #1104, #1105, #1106, #1107, #1108, #1152, #1153,
  #1154, #1155, #1156, #1158, #1165, #1166, #1167, #1174

#### Research evidence

- **Status:** `config-gated`
- **Capability:** a bounded read/list/search evidence resolver for the
  research phase, driven by an in-turn stdout-marker request/response
  protocol.
- **Configuration:** `session.research.evidence.enabled`, default `false`.
  Enabling this flag alone only turns on evidence lookups — it does **not**
  enable research publication; see the next row for that independent gate.
- **Evidence:** `src/core/research-evidence-protocol.ts`.
- **Docs:** [research-evidence-contract.md](research-evidence-contract.md)
  (status line corrected alongside this matrix — it previously read "not yet
  implemented" although issue #806 had already shipped it).
- **Gaps:** a session that has not opted in sees no behavior change.
- **Related Issues:** #805, #806

#### Research publication

- **Status:** `config-gated`
- **Capability:** a closed-schema stdout envelope for publishing research
  results, with a sanitizing `sanitized_summary` mode as an alternative to
  keeping results local.
- **Configuration:** two independent gates, both required for a report to
  actually publish: `session.research.publication.mode` (`local_only` by
  default — no publication regardless of other settings — or
  `sanitized_summary`), and `session.research.publication.allowUntrustedInputs`
  (default `false`; publication is refused with `untrusted-provenance` until
  this is explicitly set `true`, since research runs are always treated as
  untrusted provenance). Setting only `session.research.evidence.enabled`
  does not affect this gate.
- **Evidence:** `src/core/research-publication.ts` (`resolvePublicationPolicy`,
  `publicationWithholdReason`).
- **Docs:** [research-publication-contract.md](research-publication-contract.md).
- **Gaps:** a session that has not opted in to both `sanitized_summary` mode
  and `allowUntrustedInputs` publishes nothing.
- **Related Issues:** #834

### Review governance

#### Review dispute

- **Status:** `config-gated`
- **Capability:** a fix author can dispute a review finding instead of being
  required to obey it, and the disagreement is resolved by the protocol rather
  than by silently overriding or silently accepting it. Every automated §7.1
  turn — the reviewer's reconsideration, the runner's arbitration, and the
  bounded evidence round's two per-party runs — now dispatches as an internal
  sub-turn of the `review` phase, so an enabled session drives a dispute from the
  finding that opened it to a resolution or a documented human handoff with no
  manual database edit and no operator recovery command.
- **Configuration:** `session.reviewDispute.enabled`, default `false` — the only
  gate, no migration, no per-task opt-in. A session that enables it should also
  configure `reviewDispute.arbiter.providers` with a candidate independent of both
  parties (§8.3); with none configured every arbitration escalates to a human,
  which is a valid but much narrower mode. One further key exists and is
  deliberately not implied by `enabled`:
  `reviewDispute.reconsideration.readBounded` (default `false`, issue #1085,
  contract §17.6 D2/§17.16) admits the weaker `read-bounded` posture for the
  reviewer's §4.1 turn where the agent has no `no-tools` invocation — see the
  Gaps below for what that posture does not bound. Rolling back either is setting
  the flag to `false`: persisted dispute state and its audit events are preserved,
  a lineage already decided under `read-bounded` keeps that label, and the session
  returns to the previous behavior on its next run.
- **Evidence:** `src/handlers/review-reconsideration.ts`,
  `src/handlers/review-arbitration.ts`,
  `src/handlers/review-evidence-collection.ts`, `src/core/review-dispute-*.ts`;
  `admin dispute status|reopen|metrics`. `src/cli/run-one-phase.ts` registers the
  `review` phase handler, whose §7.1 gate
  (`src/handlers/review-reconsideration-turn.ts`) selects and dispatches the
  reviewer turn (issue #952), the runner/arbitration turn (issue #955) and the
  evidence turn (issue #964) before any ordinary review prompt is built. Those
  turns are retry-safe (issue #953): a run that reaches its deadline reports a
  `timeout` rather than an agent that answered, one logical turn spends its §6.1
  counter exactly once, and a replayed delivery neither re-invokes an agent nor
  changes where the task routes. `test/review-dispute-qualification.test.js`
  drives the REAL review and implementation handlers through the real phase
  runner over that whole matrix with stub agents. `admin session-doctor`
  reports `reviewerReconsiderationCapability` (issue #1073), the arbiter
  triad (`arbiterConfig`/`arbiterCandidates`/`arbiterSelection`, issue #839),
  and the Codex structured-review lane (`src/handlers/codex-structured-review.ts`,
  issue #1068/#1069) that a Claude/Codex session actually runs.
- **Docs:** [review-dispute-contract.md](review-dispute-contract.md),
  [review-dispute-operations.md](review-dispute-operations.md).
- **Gaps:** not `available`: a session that has not opted in sees no behavior
  change, and this row is deliberately not promoted further until the protocol
  has run on real traffic. Contract §15/G1 stands — an `escalated_human` lineage
  has no automated way back, so the documented human handoffs (`spec_ambiguous`,
  a decisive verdict below `minConfidence`, no acceptable independent arbiter,
  the malformed-arbiter cap, evidence still insufficient with the round spent, a
  disputed `humanGate` finding, and an implementer that reports `blocked`) end
  with a person deciding on the pull request.
  One of those handoffs is currently unavoidable rather than configurable:
  §8.2 makes the runner the enforcement point of the no-tool boundary and this
  runner has a verified no-tools invocation for `claude` alone, in the reviewer,
  arbiter and evidence lanes alike. With both parties on Anthropic — which they
  must be for their own turns to run — §8.3 then refuses every arbiter candidate
  as sharing a provider with them, so **arbitration escalates to a human today**
  (§7 row 19) instead of adjudicating. Rebuttal, reconsideration, withdrawal and
  revision all still resolve without one. Widening it means adding a verified
  no-tools invocation for another CLI, which is a runner change, not a session
  setting; `docs/review-dispute-operations.md` §1.1 states the consequence for
  operators.
  A Claude/Codex pairing is a second, narrower handoff and is not the same
  finding: contract §17.11 (issue #1069) routes an enabled session's Codex
  reviewer through a runner-authored `codex exec` lane, so it raises real
  structured findings (decision D1, taken) — a Codex reviewer is a supported
  configuration, not a degraded one. Since issue #1085 such a reviewer can also
  take the §4.1 **reconsideration** turn, and exactly three things about that are
  worth stating together: decision D2 (§17.6) is now recorded and implemented as
  contract §17.16; it runs under the separately named `read-bounded` posture,
  which contains writes, network, operator agent configuration and credentials but
  **does not bound reads**, so §8.2's "the bundle is the entire input" does not
  hold for a lineage decided under it; and it is admitted only by an explicit
  session opt-in, `session.reviewDispute.reconsideration.readBounded`, default
  `false`. `reviewerReconsiderationCapability` (issue #1073, `admin
  session-doctor`) reports which of the three states a session is in — supported
  under `no-tools`, supported under `read-bounded`, or unsupported with the exact
  opt-in that would change it — and `admin dispute status` reports the posture the
  last reviewer run actually enforced, so an enabled-and-supported Codex
  reconsideration is never confused with a disabled one, and neither is confused
  with independent arbitration. **Arbitration is unchanged and is still refused
  for `codex`**: D2 admitted one turn, so a Codex-raised finding the reviewer
  upholds still parks at `ready_for_human` unless an eligible arbiter is
  configured. Without the opt-in, the disputed finding parks as an undispatched
  turn (§15 G2) exactly as before — a different stop from the row-19 case above.
  No Codex build has been tested against this contract and no version gate is
  pinned for one (§17.3); C7 — removal of the tool surface — is still `unknown`,
  which is why what shipped is `read-bounded` and not a second `no-tools`
  invocation. §17.8 is an optional, operator-run, real-CLI procedure — never CI —
  that could change that, and `docs/review-dispute-operations.md` §13 states what
  running it would and would not change, alongside §13.3's bounded smoke check for
  the read-bounded lane itself. Independent AI arbitration by a third model
  remains future work; provider-runtime consolidation (#908, #912) is the separate
  chain that would generalize any of this, and this row is not it.
- **Related Issues:** #835, #836, #837, #838, #839, #840, #841, #843, #844,
  #845, #846, #847, #848, #849, #950, #951, #952, #953, #954, #955, #956, #957,
  #962, #963, #964, #965, #1066, #1067, #1068, #1069, #1070, #1071, #1072,
  #1073, #1085

### ChatOps

#### ChatOps (comment recognition, cursor, ledger, mapping, dispatch port)

- **Status:** `config-gated`
- **Capability:** one bounded, provider-neutral pass connects the whole
  chain: it scans a work item's comments to the end of the list, recognizes
  and authorizes a `/verb` command, records it in the durable cursor and
  execution ledger, maps it onto a canonical operation, dispatches it exactly
  once through the callable operation port, and publishes the contracted
  acknowledgement marker and summary comment. The two mapped Tool Request
  operations are registered, so an authorized comment **executes**: `/grant`
  runs the issue's already-recorded Tool Request command through
  `src/core/tool-request-run.ts` and `/resolve` records the operator decision
  through `src/core/tool-request-resolve.ts` — the same callable cores
  `admin tool-request run` / `resolve` call, invoked in-process, with no argv
  built from a comment and no admin-CLI subprocess. The pass is wired into the
  repository's generated execution path: the child workflow carries a **ChatOps
  Scan** node between *Run One Phase* and *Dispatch Outbox*, invoking the CLI
  with `--context-id` like every other child node, so an enabled session is
  scanned by ordinary scheduled n8n executions with no manual invocation and no
  ChatOps policy in workflow JSON. `chatops-status` reports cursor
  position, fenced scopes, pending publication, and each command's recorded
  disposition without reading SQLite; `chatops-recover` performs the
  operator-only actions (clear a fence, re-seed the epoch witness, resolve or
  authorize a retry for a parked command).
- **Configuration:** `session.chatOps.enabled`, default **off** — a session
  without the block performs no provider read, no ChatOps database write, and
  no comment post — the ChatOps Scan node is therefore inert on every session
  that has not opted in. `authorAllowlist` and `automationLogins` are required when
  enabled and must be disjoint (enforced at session load).
- **Evidence:** `src/cli/chatops-scan.ts`, `src/cli/chatops-status.ts`,
  `src/cli/chatops-recover.ts`, `src/handlers/chatops-pass.ts`,
  `src/core/chatops-result.ts`, `src/core/chatops-store.ts`,
  `src/core/chatops-comment-port.ts`, `src/core/chatops-operations.ts`,
  `src/core/chatops-epoch-witness.ts`, `src/stores/sqlite-chatops-store.ts`,
  `src/providers/github/gh-chatops-comment-port.ts`,
  `src/core/chatops-command.ts`, `src/core/chatops-comment-cursor.ts`,
  `src/core/chatops-execution-ledger.ts`, `src/core/chatops-identity.ts`,
  `src/core/chatops-operation-dispatch.ts`,
  `src/core/chatops-operation-mapping.ts`, `src/core/operation-port.ts`,
  `src/core/tool-request-run.ts`, `src/core/tool-request-resolve.ts`,
  `src/handlers/tool-request-operation-context.ts` (the runtime half the admin
  CLI and ChatOps share),
  `scripts/build-parent-child-workflow.mjs` (the `chatops-scan` node),
  `docs/n8n-thin-child-workflow.json`,
  `test/chatops-runtime.test.js`, `test/chatops-result.test.js`,
  `test/chatops-tool-request-operations.test.js`,
  `test/chatops-scan-cli.test.js`, `test/build-parent-child-workflow.test.js`.
- **Docs:** [chatops-operations.md](chatops-operations.md) (operator guide),
  [chatops-command-grammar-contract.md](chatops-command-grammar-contract.md),
  [chatops-comment-cursor-contract.md](chatops-comment-cursor-contract.md),
  [chatops-execution-ledger-contract.md](chatops-execution-ledger-contract.md),
  [chatops-identity-contract.md](chatops-identity-contract.md),
  [chatops-operation-mapping-contract.md](chatops-operation-mapping-contract.md),
  [chatops-result-contract.md](chatops-result-contract.md),
  [operation-dispatch-port-contract.md](operation-dispatch-port-contract.md).
  Each of those component contracts points back to this row so its own
  layer-scoped "implemented" status is not read as end-to-end availability.
- **Gaps:** deliberately not `available`: the flag defaults off, so every
  session is inert until an operator opts in and lists the authors who may
  command it. **The operation catalog is closed at two entries** —
  `src/core/chatops-operations.ts` registers `tool-request.run` and
  `tool-request.resolve` and nothing else, because
  [operation-dispatch-port-contract.md](operation-dispatch-port-contract.md)
  §11.2 admits an operation only once its handler is a
  `{ request, context } → OperationResult` core and §11.3 charges that
  extraction to the issue that first needs it. Any other verb is still
  answered `rejected` / `unknown-operation` by the port and acknowledged as a
  definite, effect-free refusal, and the verb table remains the two verbs #784
  fixed. What a comment may set stays a closed allowlist: `/grant` exposes
  `--disposition` only, never `--command`. GitHub Issues and Gitea Issues
  both have a `ChatOpsCommentPort` adapter (#1032) and run the identical pass;
  every other work-item kind has neither a ChatOps identity nor a port, so an
  enabled session on one is refused at startup rather than scanned. A Gitea
  scan costs one extra request per work item per pass, because a self-hosted
  instance clamps the page size and only an *empty* page can prove the comment
  list was read to its end. A `/grant` also inherits every precondition
  the CLI guided run has — a clean tree, a resolvable issue branch, and the
  single-worker repo lock — and reports a definite refusal when one does not
  hold. The one exception is the lock the pass is already running inside: a
  pass invoked with `--context-id` treats a lock held by *that same context* as
  its own critical section, because the generated parent takes that lock before
  it calls the child and releases it after — without which every scheduled
  `/grant` would refuse with `conflict` against its own parent. Any other
  holder still refuses.
- **Related Issues:** #696, #777, #778, #779, #780, #781, #782, #783, #784,
  #785, #1024, #1029, #1030, #1031, #1032

### Providers

#### GitHub and GitHub App provider — default `gh` CLI auth

- **Status:** `available`
- **Capability:** primary supported repo-host and work-item provider,
  authenticated via the operator's already-authenticated `gh` CLI session.
- **Configuration:** default provider and default auth mode
  (`repoHostProvider.auth.mode: "gh"`); no flag required.
- **Evidence:** `src/providers/github/gh-repo-host-provider.ts`,
  `src/providers/github/gh-work-item-provider.ts`.
- **Docs:** [provider-architecture.md](provider-architecture.md).
- **Gaps:** none known.

#### GitHub App auth mode

- **Status:** `config-gated`
- **Capability:** authenticates as a GitHub App installation instead of the
  operator's `gh` CLI session (e.g. for unattended/service deployments).
- **Configuration:** requires `repoHostProvider.auth.mode: "github-app"` plus
  the App credential environment settings (`appIdEnv`, `installationIdEnv`,
  `privateKeyPathEnv`); the sibling `*Key`/keychain form is reserved but not
  yet wired to a runtime resolver. Not the default — the default GitHub path
  above uses `gh` auth with no configuration.
- **Evidence:** `src/providers/github/github-app-auth.ts`,
  `src/core/session.ts` (`GitHubAppAuthConfig`).
- **Docs:** [provider-architecture.md](provider-architecture.md).
- **Gaps:** `*Key`/keychain credential references are accepted in the type but
  rejected by the session validator at runtime; only `*Env` works today.

#### Gitea provider

- **Status:** `config-gated`
- **Capability:** repo-host and work-item provider implementations exist and
  are consumed by outbox dispatch when a session selects Gitea; a
  `gitea-issues` session can also run the ChatOps comment surface (#1032).
  **This is not a complete GitHub replacement.**
- **Configuration:** session provider selection; GitHub remains the default.
- **Evidence:** `src/providers/gitea/gitea-repo-host-provider.ts`,
  `src/providers/gitea/gitea-work-item-provider.ts`,
  `src/providers/gitea/gitea-chatops-comment-port.ts`,
  `src/providers/gitea/gitea-client.ts`.
- **Docs:** [gitea-private-work-items.md](gitea-private-work-items.md) ("a
  design specification only" for the parts still unimplemented),
  [github-to-gitea-import.md](github-to-gitea-import.md) ("stops at
  design"), [provider-architecture.md](provider-architecture.md).
- **Gaps:** GitHub → Gitea Issue import/mirroring is `design-only`;
  documented dependency and repo-host parity gaps remain (see
  `github-to-gitea-import.md`). ChatOps on Gitea covers **issue** comments
  only — there are no pull-request review commands on either provider — and a
  scan spends one extra request per work item per pass, because a self-hosted
  instance clamps the page size and only an *empty* page proves the comment
  list was read to its end. Do not present Gitea support as parity with the
  GitHub provider.

### Data lifecycle

#### Outbox, cursor, retry, and dead-letter operations

- **Status:** `available`
- **Capability:** durable outbound-effect queue with a scan cursor, retry,
  cancellation, and maintenance locking.
- **Configuration:** none; on by default.
- **Evidence:** `src/core/outbox.ts`, `src/core/outbox-scan-cursor.ts`,
  `src/core/outbox-visibility.ts`, `src/core/outbox-effects.ts`; `admin
  outbox list|retry|cancel`, `admin maintenance-lock status|release`.
- **Docs:** [outbox-scan-cursor-contract.md](outbox-scan-cursor-contract.md).
- **Gaps:** none known.
- **Related Issues:** #818, #819, #820

#### Retention, backup, restore, and pruning

- **Status:** `available`
- **Capability:** SQLite online backup/restore and retention-bucket pruning
  for `tasks`/`events`.
- **Configuration:** operator-invoked (`admin archive rollup`, the `restore`
  action, the `prune` action); no automatic scheduling.
- **Evidence:** `src/core/retention.ts`, `src/stores/sqlite-backup-store.ts`.
- **Docs:** [retention-backup-contract.md](retention-backup-contract.md) —
  note: that document's own header still reads "specification only ...
  contains no implementation"; this row reflects the current source, which
  has moved past that header (issue #611 shipped the backup/retention split
  it describes). Treat this matrix row, not that header, as current.
- **Gaps:** retention is deliberately scoped to `tasks`/`events` only —
  outbox and context-record retention are excluded per the contract's own
  fail-closed posture (§12).
- **Related Issues:** #610, #611

### Admin and operations

#### Admin UI and recovery commands

- **Status:** `available`
- **Capability:** operator CLI surface for locks, worktrees, recovery,
  sessions, and diagnostics.
- **Configuration:** none; operator-invoked.
- **Evidence:** `src/cli/admin.ts`, `src/cli/admin-ui.ts`; subcommands
  including `repo-lock`, `worktree`, `review-lock`, `maintenance-lock`,
  `recover`, `recover-cap-handoff`, `list-stuck`, `session pause|resume|
  status`, `session-doctor`.
- **Docs:** [admin-cli-contract.md](admin-cli-contract.md),
  [admin-cli-parsing-contract.md](admin-cli-parsing-contract.md),
  [admin-command-registry-contract.md](admin-command-registry-contract.md).
- **Gaps:** `admin.ts` itself is oversized and tracked for extraction
  (issue #692) — a maintainability note, not a capability gap.
- **Related Issues:** #692

#### Merged-PR task reconciliation

- **Status:** `available`
- **Capability:** reconciling a task whose exact recorded pull request has
  already been merged by an operator back into the task lifecycle —
  eligibility from provider data, an explicit outcome for every task
  status, and an audited, atomic transition — independently of worktree
  cleanup.
- **Configuration:** none; operator-invoked
  (`admin task reconcile-merged --session-id <id> [--issue-number <n>]
  [--yes]`), preview by default.
- **Evidence:** `src/core/merged-pr-reconciliation.ts` (issue #1047) — the
  §7 outcome decision, the §8 atomic transition committed through
  `TaskStore.completePhaseWithEffects`, and the §9 audit record, behind
  injected provider/store/lock dependencies, with behavioral tests in
  `test/merged-pr-reconciliation.test.js`. `admin task reconcile-merged`
  (issue #1048, `src/cli/admin.ts`) is the operator surface over that
  core — preview by default, `--yes` to apply, one Issue or a whole
  session, stable JSON plus human output, and the reported PR identity
  redacted like every message — with an `admin ui` entry
  (`src/cli/admin-ui.ts`) that surfaces the preview/apply commands
  without running them. The operator list keeps a `cancelled` task while
  it is still reconcilable, so that entry is reachable for every status
  the command can write. Tests in
  `test/admin-task-reconcile-merged.test.js`. The contract's own
  structural tests (`test/docs-merged-pr-reconciliation-contract.test.js`)
  pin the design.
- **Docs:**
  [merged-pr-reconciliation-contract.md](merged-pr-reconciliation-contract.md),
  [per-issue-worktrees.md](per-issue-worktrees.md) (the two-stage
  disk-space workflow).
- **Gaps:** `admin worktree cleanup` deliberately keeps preserving the
  durable worktree of an awaiting-human task whose PR was merged — the
  contract adds no `--include-merged` and changes no cleanup behavior, so
  reclaiming that disk is the documented two-stage sequence (cleanup →
  `admin task reconcile-merged` → cleanup again). `PullRequest` carries
  no `mergeCommit` field yet (contract §16), and Gitea cannot distinguish
  a merged PR from a closed one, so the command refuses that host
  outright before reading any task (§12.4).
- **Related Issues:** #1046, #1047, #1048, #608, #998

#### Metrics and intervention-rate reporting

- **Status:** `available`
- **Capability:** aggregates L3 human-intervention signal counts (human
  review-return plus tool-request resolution) per Issue/session, alongside a
  generated repo-health metrics snapshot.
- **Configuration:** none for `admin interventions` (operator-invoked). The
  generated repo-health snapshot (`docs/metrics/latest.md`/`latest.json` and
  the README badges) is produced by `.github/workflows/metrics.yml`, which
  runs once daily on a schedule (03:17 UTC) and on demand via
  `workflow_dispatch` — it no longer runs on every push to `main` (#1015).
  Freshness contract: the committed snapshot can lag up to ~24 hours behind
  `main`; run it manually (Actions tab → "Metrics" → "Run workflow", or
  `gh workflow run metrics.yml`) for an up-to-date snapshot on demand. The
  workflow commits `docs/metrics/latest.md`/`latest.json`/`badges/` with
  `[skip ci]` only when a metric value actually changed. Scheduled and
  `workflow_dispatch` runs share a single `metrics-writer` concurrency
  group with `cancel-in-progress: true`, so starting a newer Metrics run
  cancels any older still-active one instead of letting both race the
  `git push` step (the source of the non-fast-forward push failures fixed
  by #1016) — a cancelled run surfaces as cancelled, not a false success.
- **Evidence:** `src/core/l3-intervention-aggregation.ts`,
  `src/core/intervention-taxonomy.ts`, `src/core/github-intervention-scan.ts`;
  `admin interventions`; `.github/workflows/metrics.yml`.
- **Docs:** [metrics/latest.md](metrics/latest.md) (generated).
- **Gaps:** none known.
- **Related Issues:** #588, #1015, #1016

### Distribution and export

#### Copybara private-to-public export

- **Status:** `config-gated`
- **Capability:** an operator-invoked command
  (`scripts/public-export.mjs`, issue #768) runs the SQUASH export against
  real, operator-supplied `--private-remote`/`--public-remote` URLs — not
  only local temporary git repositories — and, on `--publish --yes`, pushes
  the validated commit to a dedicated sync branch and opens/updates a PR
  against the public mirror via `gh pr create`/`gh pr edit`
  (`ensurePullRequest` in `scripts/public-export.mjs`). Baseline resolution
  against the public mirror's pre-existing (unrelated) history, PR-merge-race
  recovery, and a dependency-closure guard for internal-only doc references
  were hardened for that real-GitHub-shaped path by issues #800 and #811.
- **Configuration:** `npm run public:export` (dry run; the default) /
  `npm run public:publish -- --yes` (real push + PR) for the production path;
  `npm run copybara:export` / `copybara:validate` remain for local/offline
  validation. Requires a one-time manual bootstrap of `copybara/PIN.json`
  before any export can run: the file ships with `release`/`jarSha256`/
  `downloadUrl` deliberately `null` (see its own `_note`), and
  `scripts/copybara-export.mjs` fails closed at the `pin` stage until an
  operator independently verifies and commits the real Copybara jar
  checksum — this repository never fabricates or auto-fetches that checksum.
  Separately, the very first export against a given public remote/sync branch
  also requires an explicit `--init-history` or `--last-rev <private-sha>`
  baseline flag; `runPublicExport` in `scripts/public-export.mjs` fails closed
  at the `baseline` stage without one. Later runs on the same branch
  auto-derive the baseline from the previously merged export PR, so this flag
  is only needed once per remote/branch, not on every invocation.
- **Evidence:** `scripts/copybara-export.mjs`, `scripts/copybara-validate.mjs`,
  `scripts/copybara-jar-cache.mjs`, `scripts/public-export.mjs`, `copybara/`
  config (including `copybara/PIN.json`).
- **Docs:** [copybara-export-poc.md](copybara-export-poc.md) (still accurate
  for the local-only mechanics it documents — SQUASH transform, file-ownership
  policy, validation), [copybara-public-export.md](copybara-public-export.md)
  ("production command (#768)" — this is the operational runbook for the real
  export/publish path, not a successor design; the previous "successor
  design" description here was stale).
- **Gaps:** the `copybara/PIN.json` jar-provenance bootstrap has never been
  populated in this repository's history — a fresh checkout cannot complete
  any export, real or local, until an operator does that one-time manual
  verification step. Separately, even after that bootstrap, the first export
  against a new public remote or sync branch still requires the operator to
  pass `--init-history` or `--last-rev` — omitting it fails closed at the
  `baseline` stage rather than succeeding; this is a one-time-per-branch step,
  not a recurring one. No workflow schedules a real publish; it remains
  strictly operator-invoked. The public mirror already carries content from
  an earlier one-off manual snapshot predating this tooling; that is not the
  same as a completed run of `scripts/public-export.mjs --publish`, and no
  evidence in this repository (workflow logs, changelog, PIN history)
  confirms this script has completed a real publish — do not describe this
  row as proven-run, only as a real, fully wired publish path gated on the
  manual PIN step.
- **Related Issues:** #767, #768, #798, #800, #811, #971, #973

#### Private n8n node distribution

- **Status:** `available`
- **Capability:** a private n8n community node package, covering Create
  Context and related operations through its third implementation slice.
- **Configuration:** none to use the shipped slice; later slices are
  intentionally parked under `status:backlog`.
- **Evidence:** `n8n-node/` package.
- **Docs:** [private-node-distribution.md](private-node-distribution.md).
- **Gaps:** governance rule blocks starting slice N+1 before slice N ships;
  later slices remain unimplemented.

### Platform and execution

#### Execution backend, platform sandbox, and preflight execution plan

- **Status:** `design-only`
- **Capability:** not shipped. The design specifies a typed
  local/native-sandbox/container execution backend, a platform/sandbox
  contract, and a fingerprint-bound preflight plan gating what commands may
  run.
- **Configuration:** n/a — no runtime behavior yet.
- **Evidence:** none; `grep -r "SingleHost\|PlatformSandbox\|
  PreflightExecutionPlan\|ExecutionBackend" src/` has no matches.
- **Docs:** [single-host-execution-backend-contract.md](single-host-execution-backend-contract.md),
  [single-host-platform-sandbox-contract.md](single-host-platform-sandbox-contract.md),
  [preflight-execution-plan-contract.md](preflight-execution-plan-contract.md).
- **Gaps:** the entire chain is unimplemented (#915 → #916 → #917 → #918 →
  #919 → #722); only doc-structural tests exist today.
- **Related Issues:** #915, #916, #917, #918, #919, #722

### Agent and editor integrations

#### Antigravity workspace integration

- **Status:** `config-gated`
- **Capability:** writes a read-only Antigravity workspace settings profile.
- **Configuration:** `session.research.antigravity.workspaceSettings.enabled`
  (default `false`); the research phase writes nothing into the workspace
  until it is set to `true`.
- **Evidence:** `src/handlers/antigravity-workspace.ts`,
  `src/core/antigravity-workspace-settings.ts`.
- **Docs:** [antigravity-workspace-settings.md](antigravity-workspace-settings.md)
  ("implemented, disabled by default").
- **Gaps:** requires Antigravity `>=1.1.9 <2.0.0`; workspace `.gemini` rules
  are ignored by the real `agy` binary (grants go through the global store
  instead) — see issue #830.
- **Related Issues:** #826, #830

#### Codex context-mode

- **Status:** `config-gated`
- **Capability:** resolves Codex model/context-mode selection per
  session/provider; operator-observable via `admin context-mode status`.
- **Configuration:** `codex.contextMode.enabled` is a required master
  switch — when it is absent or `false`, the Codex argv is unchanged.
  Operators enable it via `session.codex.contextMode.enabled` (with
  `config`/`profile`) or `CODEX_CONTEXT_MODE=on`; disabled by default.
- **Evidence:** `src/handlers/codex-context-mode.ts`,
  `src/cli/context-mode-status.ts`.
- **Docs:** [codex-context-mode.md](codex-context-mode.md).
- **Gaps:** none known.
- **Related Issues:** #609

#### Provider-centric agent runtime profiles

- **Status:** `available`
- **Capability:** the write-capable phases — `implementation` (Claude, Codex,
  Gemini/Antigravity; both orchestration modes including fix/requeue and the
  verification repair loop) and `conflict_resolution` (Claude) — resolve their
  agent invocation through the provider runtime boundary; the read-side lanes
  do not yet. The design specifies four provider-neutral quality levels
  (`light`/`normal`/`strong`/`maximum`) resolved against a per-provider catalog
  of named runtime profiles, stored outside `sessions.json`, that decides the
  concrete model, effort, budget, binary, and provider options for a phase run.
  Slice B1 (issue #904) ships that catalog as data: built-in defaults, an
  optional `agent-profiles.json` overlay, and the load-time validator. Slice B2
  (issue #905) ships the shared quality resolver — `complexity:*` / `review:*` /
  `quality:*` mapped onto the four levels, per phase class, with escalation as a
  raise-only floor — and snapshots its answer onto the task at intake. Slice
  B3's boundary (issue #906) ships the adapter contract, the fail-closed
  provider registry, the shared resolution/validation engine, and the
  invocation sanitation gate as a typed seam. Issue #907 ships the first
  provider adapter behind that seam — `anthropic`, serving the Claude CLI, with
  the three `CLAUDE_*` break-glass variables, the four Claude invocation lanes
  and their tool boundaries, and a pre-invocation validation gate. Issue #908
  ships the second — `openai`, serving the Codex CLI, with the two `CODEX_*`
  break-glass variables, the four Codex invocation lanes with their subcommands
  and sandbox postures, the global-options-before-the-subcommand ordering rule,
  and an accepted reasoning-effort list that comes from the catalog's capability
  descriptor instead of a ceiling restated in source. Issue #909 ships the third
  and last — `google`, serving the Gemini/Antigravity (`agy`) CLI, with the
  `ANTIGRAVITY_BIN` break-glass variable, the five shipped `agy` lanes and the
  single `--print` invocation shape, the two prompt transports those lanes use,
  the `printTimeout` provider option, and a bounded `agy models` capability
  probe whose failure is reported separately from agent availability. That
  provider folds reasoning effort into the model display name, so the adapter
  needs no effort field and refuses one that resolved. Issue #910 ships slice
  B4's audit record — one provider-neutral record of what a run asked for and
  what it resolved, with every concrete value's source, the catalog
  schema/version/digest, the discovered CLI version, and the resolution's
  timing — plus the bounded task-context trail, the `agent.runtime.resolved`
  event payload, the `agent-runtime.json` run artifact, and the bounded,
  sanitized public status line. Issue #911 cuts the write-capable lanes over
  (`src/handlers/agent-runtime.ts` is the composition root): the per-lane
  model/effort/budget chains are deleted from those handlers, the review
  loop's `escalatedEffort` handoff buys a `strong` quality floor, and every
  attempt persists the §13 record — the `agent-runtime.json` run artifact,
  the bounded task-context trail, and the `agent.runtime.resolved` event
  (before/after table in agent-runtime-profiles-contract.md §10.4). Issue #913
  ships the §11.4 operator surface: `admin agent-profile list` shows the
  effective catalog after overlay with every value labelled built-in or
  overridden, `admin agent-profile show <agent>` reports what each of the four
  quality levels resolves to — model, effort, budget, binary, and each value's
  source — and `admin agent-profile validate` checks the effective catalog, or
  a candidate file, plus every agent's resolution under the current environment
  and session pins. All three are read-only and resolve through the same gates
  a run does; capability discovery (`--probe`) is reported separately and never
  invalidates a profile. Issue #914 adds the §11.6 safe update path: `admin
  agent-profile refresh` compares the overlay against the release's
  recommended (built-in) catalog and the installed provider CLIs — a bounded
  non-interactive model listing where one exists, the bundled catalog
  otherwise, source reported — and previews removed models, unsupported
  efforts, redundant overrides, and stale overrides as a diff. `--yes` applies
  only the tool-managed removals plus a provenance record (the proposed and
  current effective catalogs must produce the same digest, so no resolved
  setting can change), after backing up the previous file; operator-created
  profiles and custom bindings are preserved, and there is no force/replace
  mode.
- **Configuration:** optional. `agent-profiles.json` beside `sessions.json`
  (or `AGENT_PROFILES_FILE`, or `session.agentRuntime.profilesPath`) overrides
  parts of the built-in catalog; with no file present the built-in catalog
  reproduces the pre-cutover resolutions and an existing installation is
  unaffected. `session.agentRuntime.defaultQuality` names the level requested
  when no label does, and `session.agentRuntime.pins` pins a declared profile
  per agent. Editing the catalog changes the next write-capable invocation
  without rewriting session definitions. On the cut-over lanes
  `session.claude.complexityProfiles` and `session.codex.model` are no longer
  read (§10.4); the read-side lanes still resolve per lane from
  `complexity:*` / `review:*` labels, the `CLAUDE_*` / `CODEX_*` /
  `ANTIGRAVITY_BIN` environment variables, and
  `session.research.antigravity.model` — there the catalog feeds nothing.
- **Evidence:** `src/core/agent-profile-catalog.ts`,
  `test/agent-profile-catalog.test.js`, `src/core/agent-quality.ts`,
  `test/agent-quality.test.js`, `src/core/agent-runtime-adapter.ts`,
  `test/agent-runtime-adapter.test.js`, `src/core/claude-runtime-adapter.ts`,
  `test/claude-runtime-adapter.test.js`, `src/core/codex-runtime-adapter.ts`,
  `test/codex-runtime-adapter.test.js`,
  `src/core/antigravity-runtime-adapter.ts`,
  `test/antigravity-runtime-adapter.test.js`,
  `src/core/agent-runtime-audit.ts`, `test/agent-runtime-audit.test.js`,
  `src/handlers/agent-runtime.ts`, `test/implementation-handler.test.js`,
  `test/conflict-resolution-handler.test.js`, `src/cli/agent-profile.ts`,
  `test/admin-agent-profile.test.js`, `src/core/agent-profile-refresh.ts`,
  `test/agent-profile-refresh.test.js`,
  `test/admin-agent-profile-refresh.test.js`.
- **Docs:** [agent-runtime-profiles-contract.md](agent-runtime-profiles-contract.md).
- **Gaps:** the read-side lane cutovers (review, research, content, no-tools)
  and B5 are outstanding — on those lanes a `quality:*` label still selects
  the persisted request but changes nothing about what runs, and editing
  `agent-profiles.json` changes no read-side invocation until B3 cuts those
  lanes over. A misspelled or contradictory `quality:*` label refuses that
  Issue at intake. Of the §11.4 operator commands, the per-provider,
  per-level, per-field diff of a candidate against the effective catalog is
  still outstanding; the comparison is made today by running `admin
  agent-profile list` against each (the overlay-versus-recommendation diff is
  `agent-profile refresh`'s preview, §11.6).
- **Related Issues:** #903, #904, #905, #906, #907, #908, #909, #910, #911, #913, #914, #412, #476, #609, #694

## 5. Maintenance rule

**Any Issue or PR that changes what a feature can do, how it is gated, or
whether it is wired into a supported runtime path MUST update the relevant
row in this file in the same change.** This includes: shipping a
`design-only` or `foundation-only` feature past its current boundary,
flipping a `config-gated` default, wiring a new end-to-end path (as ChatOps
did in issue #1024 to move off `foundation-only`), or deprecating a shipped
path.
Reviewers should treat a missing matrix update as a review finding, the same
way a missing test would be.

A closed design Issue, by itself, is never sufficient justification for
marking a row `available` — see §2. If a change only advances a design
document without shipping runtime behavior, this file does not change.

## 6. Excluded documents

Documents with an explicit `Status:` declaration that are intentionally not
represented as their own matrix row, with the reason:

- [DOMAIN.md](DOMAIN.md) — an architecture/glossary meta-document tracking
  structural decomposition work (admin CLI, handlers, outbox extraction
  boundaries), not a feature-availability declaration about a single
  operator-facing capability.
- [agent-isolation-policy.md](agent-isolation-policy.md) — a cross-cutting
  implementation invariant (the environment every isolated no-tool agent run
  gets) rather than a separately gated operator-facing capability of its own.
  Its `Status:` line records that the policy is implemented. The features it
  backs — Issue refinement, Review dispute, Issue planning and AI preview —
  carry their own rows above, and the availability of each caller is stated in
  that caller's row.
