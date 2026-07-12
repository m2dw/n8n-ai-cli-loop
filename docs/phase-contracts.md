# Phase Contracts

This document defines the behavioral contract for each self-driving workflow
phase. n8n owns orchestration, TypeScript handlers own repository operations,
and AI agents only perform the work delegated to their phase.

These contracts are intentionally narrow. They make the workflow predictable
enough for n8n to route tasks without encoding each agent's judgment in the
workflow graph.

## GitHub Intake — One-Shot Dependency Gate

The intake step (`github-intake` CLI) scans open GitHub issues, maps their
labels to a task phase, and enqueues matching issues into the task store.
Two independent gates control whether an issue is enqueued:

**Label gate** — `labelsToPhase` inspects the label set and returns a phase
mapping only when a recognized label combination is present (e.g.
`agent:claude` + `status:needs-implementation`).  Issues with no matching
combination are ignored.

**Dependency gate** — Before checking labels, `parseCandidates` queries
GitHub Issue Relationships for each issue via the `DependencyChecker` adapter.
An issue is skipped for the current scan cycle when it has at least one
`blocked by` relationship whose source issue is still open.  Once all open
blockers are closed the next intake scan will pass the issue through and
enqueue it.  If the relationship check cannot be completed (GraphQL error,
network failure, unsupported field), the issue is held back — fail closed.

**Source of truth** — GitHub Issue Relationships (`blocked by`) are the
authoritative dependency signal.  Free-form issue body text is not parsed.
The dependent issue side is always checked; blocking relationships on other
issues are not traversed.

**DependencyChecker adapter seam** — The default implementation
(`GraphQLDependencyChecker` in `src/cli/github-intake.ts`) queries
`blockedBy(first: ...)` via `gh api graphql`.  If this
GraphQL field is unavailable in the target environment, replace the default
with a custom implementation and pass it to `runIntake()` as the `depChecker`
argument.

**Dependency decision snapshot** — When an issue passes the gate and is
enqueued, a `dependencyDecision` object is stored in the task context:

```json
{
  "checkedAt": "<ISO-8601 timestamp>",
  "source": "github-relationships",
  "blockedBy": [{ "issueNumber": 42, "state": "closed" }],
  "blocked": false
}
```

This snapshot records the time the check was performed, the source, all
`blocked by` entries (including closed ones), and the final gate decision.

**One-shot semantics** — Enqueue is idempotent per `(sessionId, issueNumber)`
pair.  Once an issue passes both gates and is inserted into the task store,
all future scan cycles will see `already_exists` and skip it.  The dependency
gate therefore fires at most once per session/issue pair: it is the gate that
decides whether the issue is eligible on a given scan cycle, not a recurring
check.  Resetting a completed or failed task requires a manual store operation
outside the intake path.

## Dependent Stack Creation — Dormant-First Contract

The dependency gate above only holds back an issue whose `blocked by`
relationship is **already visible at scan time**. GitHub Issue Relationships and
execution labels are configured in separate operations, and intake runs on a
schedule, so the *order* in which an operator applies them is a correctness
concern, not a cosmetic one.

**Why executable labels before relationship setup are unsafe.** `parseCandidates`
checks the dependency gate using whatever relationships GitHub reports at the
moment of the scan. If a dependent issue already carries an executable label
combination (`agent:*` + an executable `status:*`) but its `blocked by`
relationship is not yet configured, the dependency gate sees no blocker and the
label gate matches, so the issue passes both gates and is enqueued as if it were
independent. Because enqueue is one-shot and idempotent per
`(sessionId, issueNumber)` (see [One-shot semantics](#github-intake--one-shot-dependency-gate)),
a relationship added afterward has **no retroactive effect** — the dependent has
already been admitted and will run unblocked. The race is therefore **not
self-healing**: a late relationship cannot retract an issue intake has already
enqueued.

**Motivating failure mode (the #360–#365 race).** While creating the #360–#365
issue stack, execution labels were applied to dependent issues before their
`blocked by` relationships were fully configured. An intake scan observed
`agent:*` / `status:needs-implementation` while the dependency gate still saw no
blocker, so the dependents were enqueued as if they had no blocker.

**Required creation order for any issue expected to be `blocked by` another:**

1. Create the issue in a non-executable (dormant) state. Do **not** apply
   `agent:*` labels. Do **not** apply executable `status:*` labels
   (`status:needs-implementation`, `status:needs-review`,
   `status:research-needed`, `status:needs-conflict-resolution`). Prefer
   `status:backlog` or no workflow status while relationships are configured.
2. Set all `blocked by` relationships for the stack.
3. Verify the relationship graph: each dependent issue must show its intended
   open blocker(s) before any executable label is applied.
4. Add executable labels only after the relationships are configured and
   verified. Activate the root issue first (the one with no open blocker), and
   activate a single root unless there is a deliberate reason to run multiple
   independent roots.
5. Activate each dependent explicitly — intake does **not** auto-activate
   dormant issues. `parseCandidates` calls `labelsToPhase` first and skips any
   issue that lacks an executable label combination *before* it ever consults
   the dependency gate (see `src/core/github-intake.ts`). A dependent left fully
   dormant is therefore never scanned and will never enter the queue, no matter
   how many of its blockers close. To make a dependent eligible, a human must
   apply its executable (`agent:*` + executable `status:*`) labels. The safe
   time to do this is after step 3: once the `blocked by` relationship is
   visible, applying executable labels no longer races the dependency gate, so
   the dependent is admitted only when its blocker state actually permits it.

   How an already-labeled dependent then activates depends on the blocker's
   state, and it is **not** always "held until the blocker closes":

   - **Close-only (Gate 1).** For any blocker shape the resolver does not
     support for early stacking, the dependent is held until every `blocked by`
     blocker is *closed*.
   - **Stack-ready (Gate 2).** For the supported stackable shape (exactly one
     open blocker on a new-implementation dependent), the dependent may be
     enqueued **before** its blocker closes — as soon as the blocker reaches the
     success-specific stack-ready marker (`status:stack-ready` by default) with
     a usable PR.

   See [Dependency-Aware Execution Semantics](#dependency-aware-execution-semantics)
   below for the full Gate 1 / Gate 2 definitions.

**Single vs. stacked creation.** A single independent issue with no expected
`blocked by` relationship may be created with executable labels immediately —
there is no relationship to race against. The dormant-first order is required
only when a `blocked by` relationship is expected, i.e. for dependent stacks.

This is an operator contract, not an automated guard: intake does not currently
detect or correct the race. See
[idea-to-implementation.md](idea-to-implementation.md#dormant-first-creation-for-dependent-issue-stacks)
for the operator-facing walkthrough.

## Dependency-Aware Execution Semantics

The purpose of dependency-aware execution is to keep a dependent issue moving
even when its blocker has not been merged to `main` yet.  It does **not** give
this system ownership of merge ordering, retargeting, or any stacked-branch
finalization queue.  Merge ordering and dependency visibility are delegated to
GitHub Issue Relationships and human review.  This system does not enforce merge
order.  PR base does not encode dependency order.

Two concepts are kept strictly separate and must never be conflated:

- **Branch start point** — where the dependent implementation branch is *created
  from*.  When an open blocker has a usable reviewed PR, the branch is started
  from the blocker PR head so the implementation compiles against the blocker's
  changes.
- **PR target (base)** — what the dependent PR *merges into*.  This is always the
  session base branch (`main` by default), never the blocker PR head branch.

The dependent PR therefore always targets `main`, even though its branch was
created from the blocker head.  There is no later retargeting or rebase-onto-main
step owned by this system.  If the dependent PR merges before the blocker PR it
will include the blocker's changes; that is acceptable, because GitHub Issue
Relationships and human review own merge-order decisions.

**Source of truth** — GitHub Issue Relationships (`blocked by`) are the
authoritative dependency signal and the source of merge-order visibility.  Local
labels and free-form issue body text are not.  The automation chooses a suitable
implementation start point only; it does not enforce merge order and must not
invent custom merge sequencing.

Gate 1 and Gate 2 below are **alternative intake paths**, not sequential steps:
a dependent issue advances through either Gate 1 or Gate 2 depending on the
blocker's state.

### Gate 1 — Dependency Intake Gate (close-only, simple behavior)

The gate described in [GitHub Intake — One-Shot Dependency Gate](#github-intake--one-shot-dependency-gate)
above is the **close-only** implementation.  A dependent issue is held back until
every `blocked by` issue is closed.  This is safe but wastes AI execution time
when a blocker already has a reviewed PR waiting for a human merge.  It remains
the fallback for any blocker that is not yet usable as a start point (see the
Unsupported Cases table).

### Gate 2 — Implementation Start Gate (one open blocker with a usable PR)

A dependent issue may advance to implementation **before** its blocker is closed,
provided the blocker has a **usable PR**.

**Definition of usable PR**

A blocker PR is usable when all of the following are true:

- The PR is open (not closed or merged).
- The PR head branch exists in the remote repository.
- The blocker issue has reached a configured implementation-complete state,
  confirmed by the **success-specific stack-readiness marker** (`status:stack-ready`
  by default, configurable via the `stackReady` session label).  This marker is
  applied whenever a review **passes** and cleared on any review that does not
  pass.  The check is on the blocker **issue**, not on the PR itself.
  - The `status:ready-for-human` label is **not** accepted as the
    implementation-complete signal.  Although it is applied when a review passes,
    this codebase also applies it when a review is **escalated** to a human
    (loop-cap reached, ambiguous/empty review output) *without* passing.  Trusting
    it would let a dependent start from a blocker whose review actually failed, so
    the resolver keys only on the success-specific `status:stack-ready` marker.
- The PR has no reported merge conflict.
- The PR has not failed review (guaranteed by keying on the success-only
  stack-ready marker above).

If a blocker has no open PR, the dependent issue is still blocked (Gate 1).

**Branch start point rule**

When the implementation start gate is satisfied the dependent implementation
branch is created from the blocker PR head branch, not from `main`, so the
implementation compiles against the blocker's changes.  Branching from `main`
while the blocker is unmerged would silently produce a stale base.

**PR target rule**

The dependent PR targets the session base branch (`main` by default).  It does
**not** target the blocker PR head branch, and there is no follow-up
rebase/retarget step.  Delivering to `main` keeps the dependent issue's mainline
delivery visible and explicit.

### Review and handoff for a dependency-started PR

A dependency-started PR is reviewed against the session base branch (`main`),
the same as any other PR.  Because the branch was created from the blocker head,
its diff against `main` may also include the blocker's changes; that is expected
and acceptable.  If the dependent PR is merged before its blocker and thereby
includes the blocker's changes, that outcome is acceptable from this system's
perspective — merge ordering is owned by GitHub Issue Relationships and human
review, not by this system.

When its review passes it follows the **normal review-success handoff**
(`status:ready-for-human`).  It is **not** held back, retargeted, or marked
unmergeable merely because it was implemented on top of a blocker — the
`dependencyBase` metadata recorded at implementation time is informational only
and must not, on its own, downgrade a passing review to `blocked` or suppress
the ready-for-human handoff.  It is held or requeued only on a genuine review or
conflict failure, exactly like any other PR.

> **Known implementation divergence** — `src/handlers/review.ts` still implements
> a legacy stacked-base safety check: when `dependencyBase` metadata is present,
> the handler queries the live PR `baseRefName` and blocks the review for a human
> when the live base targets the blocker branch or cannot be confirmed.  The
> **live-base guard must be preserved**: if the live PR base is not the session
> base (`main`), that is a real misconfiguration that must stop automated review
> handoff — removing it wholesale would reintroduce the #216/#217 omission this
> contract exists to prevent (see
> [Anti-pattern: do not deliver dependent work into the blocker branch](#anti-pattern-do-not-deliver-dependent-work-into-the-blocker-branch-216217)
> below).  The prohibited pattern is narrower: once the live `baseRefName` is
> confirmed to equal the session base, `dependencyBase` metadata alone must not
> additionally delay, downgrade, or suppress a passing review (see
> [Dependency metadata: permitted and prohibited uses](#dependency-metadata-permitted-and-prohibited-uses)
> below).  The follow-up implementation issue should therefore **retain** the
> live-base guard for PRs whose `baseRefName` does not yet equal the session base
> and **remove only** the metadata-only gate that applies after the live target is
> confirmed correct.  The corresponding tests are in `test/review-handler.test.js`
> under the `"review handler — dependency-started PR (issue #242)"` describe block;
> those tests should be updated to reflect this narrowed scope rather than removed
> entirely.

### Dependency metadata: permitted and prohibited uses

`dependencyBase` context recorded at implementation time documents where the
dependent implementation branch was started from.  It is informational only.

**Permitted uses:**

- **Branch creation context** — selecting the implementation branch start point
  (applied once during the implementation phase, not reread in later phases).
- **PR and issue explanatory context** — the PR body or a GitHub comment may
  reference the blocker issue and PR to orient human reviewers.
- **Diagnostics** — including start-point decisions in result artifacts and logs.

**Prohibited uses under this policy:**

- **Review-base selection guards** — blocking, diverting, or delaying the review
  phase because `dependencyBase` is present.
- **Ready-for-human suppression** — withholding or downgrading a passing review
  classification based on dependency metadata alone.
- **Merge-readiness proofs** — asserting that a dependent PR must wait for its
  blocker to merge before the dependent PR is considered ready.
- **Blocker merge/rebase/ancestry enforcement** — confirming or enforcing that
  the blocker was merged, or that the dependent branch was rebased onto `main`,
  as a precondition for any phase transition.

### Anti-pattern: do not deliver dependent work into the blocker branch (#216/#217)

This is the concrete merge-omission trap the rules above exist to prevent:

- #217 was blocked by #216.
- #217 was implemented and its PR (#231) was merged into the `ai/issue-216`
  branch instead of into `main`.
- GitHub then showed #217 / PR #231 as merged/closed, but the #217 changes were
  still absent from `main` (and from the normal operation tree) until #216 itself
  merged.
- Humans and agents could therefore believe #217 was done because its PR was
  merged, while the actual deliverable was still hidden inside another branch.

The automation must never merge a dependent PR into the blocker branch, and must
never close a dependent issue as a side effect of merging into the blocker
branch.  A dependent issue may be *implemented* against blocker code, but its PR
must still target `main` so its mainline delivery remains visible and explicit.

### Unsupported Cases (fall back to the close-only block)

The following dependency shapes are **not** usable as a dependency-aware start
point.  When any of these is detected the dependent issue does not start
implementation against the blocker; it is held (`blocked`) and re-evaluated on a
later intake scan, exactly as under the close-only Gate 1.  The automation does
not attempt to resolve them by inventing a merge order.

| Condition | Reason to fall back |
|---|---|
| Multiple open blockers | More than one unmerged blocker is ambiguous to start from.  Resolve manually: merge or close all but one blocker first. |
| Blocker has no open PR | The blocker's implementation is not complete; no usable head branch exists to start from. |
| Blocker PR has a merge conflict | The conflict must be resolved before the head branch is usable as a start point. |
| Blocker PR failed review | A PR in `needs_fix` state may change further; starting from it now risks a moving base. |
| Blocker PR head branch missing from remote | The branch reference cannot be checked out or used as a start point. |

## Common Rules

- Work only inside the configured repository root.
- Treat `sessionId`, `repoRoot`, `githubRepo`, and artifact paths as handler
  inputs, not values to rediscover from the current shell directory.
- Keep each phase limited to its assigned responsibility.
- Do not run repository state-changing `git` or `gh` commands from agent
  prompts. Branch checkout, commit, push, PR creation, PR checkout, comments,
  labels, and outbox dispatch are handler-owned.
- Do not make unrelated refactors or cleanup changes while completing a task.
- Do not bump package or extension versions unless the issue explicitly asks
  for a release/versioning change.
- Do not directly edit specification documents (`AGENTS.md`, `docs/phase-contracts.md`,
  or any file that defines agent or workflow behavior contracts), workflow behavior,
  or operational policy unless the current task issue explicitly requests that exact
  change. Because an automation-owned Issue/PR branch may be active at any time —
  even when the agent cannot confirm it — such changes must enter through a dedicated
  Issue. Normal inspection and diagnosis is always permitted. Local recovery actions
  explicitly requested by the operator are permitted when scoped to the request and
  reported in the artifact. Discovered specification gaps must be recorded in the
  result artifact and opened as a follow-up Issue rather than edited inline. See
  `AGENTS.md` — No-Direct-Edits Policy for the full action-by-action distinctions.
- Prefer existing project patterns and local helper APIs over new abstractions.
- Write phase artifacts under `<artifactRoot>/runs/<runId>/`.
- A phase that cannot satisfy its contract should fail clearly instead of
  silently moving work forward.

## Complexity Labels

Optional complexity labels control the Claude model, effort, and budget used for
implementation.  They are evaluated at the start of each implementation run.

| Label             | Model  | Effort | Budget |
|-------------------|--------|--------|--------|
| `complexity:low`  | sonnet | low    | $2     |
| *(no label)*      | sonnet | high   | $5     |
| `complexity:high` | opus   | high   | $10    |
| `complexity:xhigh`| opus   | xhigh  | $20    |

When multiple complexity labels are present the strongest wins:
`xhigh > high > low`.

Environment variables (`CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_MAX_BUDGET_USD`)
override complexity-label defaults when set.

Review-loop effort escalation (`escalatedEffort`) promotes effort to `high` on
the penultimate fix cycle only when it would actually raise the label-derived
effort.  Labels whose effort already meets or exceeds the escalation target
(the default and `high`, plus `complexity:xhigh`) skip escalation — in
particular `xhigh` is never downgraded to `high`.

`complexity:xhigh` is a Claude implementation tier only. The Codex review path
has no `xhigh` reasoning effort (`model_reasoning_effort` accepts low/medium/high
only), so when no explicit `review:*` label is present `complexity:xhigh`
derives the strongest Codex-supported review strength (`high`), the same as
`complexity:high`. See the review-strength note below.

## Review Strength Labels

Optional review labels control the Codex `model_reasoning_effort` config used for
the review phase. Explicit review labels win over complexity-derived strength;
when several conflict, the strongest wins.

| Label           | Codex reasoning effort      |
|-----------------|-----------------------------|
| `review:low`    | `low`                       |
| `review:medium` | *(default — no flag)*       |
| `review:high`   | `high`                      |

Precedence when present: `review:high > review:medium > review:low`.

**There is no `review:xhigh`.** The installed Codex CLI's
`model_reasoning_effort` only accepts low/medium/high — `xhigh` is a Claude-only
effort tier. Per issue #243 it is *not* silently downgraded to `high`: a
`review:xhigh` label is simply not a recognized review label and has no effect.
Only Claude implementation supports `xhigh` (via `complexity:xhigh`). When no
explicit `review:*` label is set, `complexity:xhigh` and `complexity:high` both
derive the strongest Codex-supported review strength (`high`).

## Implementation

Implementation handles `agent:claude` + `status:needs-implementation`.

Allowed:

- Read the issue context supplied by intake.
- Inspect source, tests, docs, and local helper APIs.
- Edit files needed to satisfy the issue.
- Run safe inspection and verification commands allowed by the handler.

Forbidden:

- Running `git` or `gh`.
- Creating, renaming, or pushing branches.
- Opening or editing PRs.
- Changing unrelated files.
- Performing release/version bumps unless explicitly requested.

Success criteria:

- The requested change is implemented in the configured repository.
- The working tree contains file changes after the agent exits.
- The handler can commit, push, and create a PR for `ai/issue-<issueNumber>`.
- The task transitions to review after a successful implementation run.

Failure criteria:

- The worktree is dirty before the handler starts.
- The implementation agent exits non-zero.
- The implementation agent exits zero but produces no diff.
- Handler-owned `git` or `gh` operations fail.

Required artifacts:

- `implementation-prompt.md`
- `implementation-output.md`
- `implementation-result.json`

## Fix Existing PR

Fix mode handles `agent:claude` + `status:needs-fix`.

Allowed:

- Read the fix request supplied in task context or the prompt, plus local code.
- Apply focused changes that address actionable review findings.
- Run safe inspection and verification commands allowed by the handler.

Forbidden:

- Creating a new PR.
- Creating a new branch for the same issue.
- Expanding the scope beyond the review findings unless required to fix the
  same defect.
- Running `git` or `gh`.

Success criteria:

- The handler finds an open PR whose head branch is `ai/issue-<issueNumber>`.
- The handler checks out that existing branch.
- The agent applies fixes on that branch.
- The handler commits and pushes to the same branch.
- The task transitions back to review.

Failure criteria:

- No open canonical PR branch exists.
- The fix request is not present in task context or the prompt.
- The existing PR branch cannot be checked out or updated.
- The agent exits non-zero or produces no diff.

Fix mode is triggered automatically when the review handler returns `needs_fix`.
The review output is captured as `reviewFeedback` in task context and included
in the fix prompt. Fix mode also activates when task labels contain
`status:needs-fix` (manual trigger), but in that case `reviewFeedback` must
be present — fix mode will fail before running Claude if feedback is absent.

Operational note:

Legacy run-id branches such as `ai/issue-37-1133` are not part of the long-term
contract. Migrate those PRs manually to `ai/issue-<issueNumber>` before retrying
fix automation.

## Review

Review handles `status:needs-review`. The review agent is chosen from the coarse
`agent:*` labels (`labelsToPhase`), but the implementation owner is **not**
reconstructed from those labels here — it is read from
`context.assignment.implementationAgent`, the source of truth. See
[assignment-profiles.md](assignment-profiles.md#assignment-vs-agent-labels-source-of-truth)
for the assignment-vs-label boundary (issue #292).

Allowed:

- Check out the PR branch.
- Run configured verification commands.
- Review the diff against `main`.
- Classify the result as no blocking findings, needs fix, conflict, or failed.
- Record actionable findings through handler/outbox-managed GitHub updates.

Forbidden:

- Implementing fixes.
- Committing or pushing changes.
- Treating cosmetic nits as blocking findings by themselves.
- Merging PRs.

Review posture:

- Lead with bugs, regressions, spec mismatches, and missing tests.
- Prefer concrete file/line references when findings are actionable.
- Keep summaries secondary to findings.
- Say explicitly when there are no blocking findings.

Success criteria:

- Verification commands pass.
- Codex review completes.
- The review classifier can determine the next state from the review output.
- Blocking findings are recorded clearly enough for fix mode; otherwise the task
  becomes ready for human decision.

Routing after review:

- `success` → task becomes ready for human decision.
- `needs_fix` → task is automatically requeued to implementation/fix mode.
  Review output is captured as `reviewFeedback` in task context.
- `conflict` → the review handler returns `result: "conflict"`, which the runner
  routes to the `conflict_resolution` lane.  This applies to dependency-started
  PRs too: because every PR (dependency-started or not) targets the session base
  (`main`), a conflict is always a conflict against `main`, which the
  `conflict_resolution` handler resolves by merging `main` into the PR branch.
- `blocked` (empty/ambiguous output, or conflict classification) → task
  escalates to `ready_for_human`.

Required artifacts:

- `review-context.json`
- `review-output.md`
- `review-result.json`
- `review-verification-<name>.log` for each configured verification command

## Research

Research handles `agent:gemini` + `status:research-needed`.

Allowed:

- Read repository files and issue context.
- Investigate existing code, dependencies, external constraints, and design
  options.
- Produce findings that can become follow-up implementation issues.

Forbidden:

- Editing repository files.
- Running implementation work.
- Creating branches or PRs.
- Presenting uncertain claims as confirmed facts.

Success criteria:

- The output summarizes findings, options, recommendation, risks, and open
  questions.
- The output is usable by a maintainer or implementation agent as planning
  input.
- The task becomes ready for human decision unless a later workflow explicitly
  routes research output into implementation.

Required artifacts:

- `research-prompt.md`
- `research-output.md`
- `research-result.json`

## Conflict Resolution

Conflict resolution handles `status:needs-conflict-resolution`, or any task
routed here when the review handler classifies its result as `conflict`.

**Responsibility split** — The handler owns all repository operations.  The
agent owns only editing conflicted files and staging the specific resolved
files.  The agent must not run `gh` commands or broad `git` operations; it
may run the scoped inspection and staging commands listed below.

### Handler-owned responsibilities

The handler performs these steps in order, stopping on the first failure:

1. Locate the open PR for the issue via `gh pr list` (using `branchName(issueNumber)`).
2. Verify the worktree is clean before touching it.
3. Check out the PR branch.
4. Fetch and update from the configured base branch.
5. Attempt a merge of the base branch into the PR branch.
   - If the result is already up-to-date (no `MERGE_HEAD`), skip steps 6–12
     and return `success` so the task re-enters `review`.  No verification,
     commit, or push is performed because there is nothing to merge.
   - If the merge completes cleanly via fast-forward, skip steps 6–9,
     run verification (step 10), commit (step 11), push (step 12), and return
     `success` so the task re-enters `review`.
6. Detect the conflict shape (text conflicts vs. binary or modify/delete conflicts).
7. Write a scoped conflict-resolution prompt that lists only the conflicted files.
8. Invoke the agent to edit and stage the resolved files.
9. Verify no unmerged paths remain and no conflict markers are present in staged files.
10. Run verification commands (e.g. `npm test`).  A verification failure is a
    semantic conflict-resolution failure — abort the in-progress merge before
    any commit and escalate; see **Semantic Conflict Escalation Policy** below.
11. Commit the merge resolution.
12. Push the PR branch.
13. Return `success` so the task re-enters `review`.

### Agent-owned responsibilities

- Edit conflicted files to produce a coherent, compilable resolution.
- Stage the specific resolved files using `git add -- <filename>`.
- Use `git status` and `git ls-files -u` to inspect conflict state.
- Do not stage unrelated files.
- Do not run `gh` commands or any `git` command other than `status`,
  `ls-files -u`, and `add -- <filename>`.

### Stop / handoff conditions

The handler must stop and move the issue to `status:ready-for-human` when setup
cannot begin:

- No open PR is linked to the issue (e.g. head branch `ai/issue-<N>` not found).
- The worktree is dirty before setup begins.

The handler must stop and mark the issue `status:conflict-resolution-failed` when:

- The PR branch is missing or cannot be checked out.
- `git fetch` or the base-branch update fails.
- The merge command fails for an unexpected reason (exit code non-zero for
  reasons other than conflicts).
- Binary or modify/delete conflicts are detected — these require human judgment
  and must not be guessed by the agent.
- The agent exits non-zero.
- Unmerged paths remain after the agent runs.
- Conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) remain in staged files
  after the agent runs.
- Verification fails after conflict resolution.
- Push fails.

The handler must not proceed past a stop condition, attempt a partial merge
commit, or leave the worktree in an intermediate state.

### Success criteria

- All conflicts are resolved without markers.
- The merge commit is pushed to the PR branch.
- The task transitions back to `review` for re-evaluation.

### Failure criteria

- Any stop/handoff condition listed above is triggered.
- The agent produces no diff on the conflicted files.

### Semantic Conflict Escalation Policy

**Textual vs. semantic conflicts**

A *textual conflict* occurs when Git detects overlapping edits — the same lines were changed in both the PR branch and the base branch.  Git surfaces these as conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).  The agent resolves textual conflicts by editing the conflicted files to produce coherent output.

A *semantic conflict* occurs when the textual merge completes without markers but the combined code no longer works: verification commands fail, tests break, or the build does not compile.  Git cannot detect semantic conflicts; only running the project's verification suite reveals them.

**Classification of verification failures**

A verification failure after a conflict_resolution attempt is classified as a *semantic conflict-resolution failure*.  It is not a transient error and must not be treated as one.

**Attempt limit**

Each conflict_resolution cycle is a single automated attempt.  Automation stops after the first verification failure.  Re-running conflict_resolution on the same textual state will not resolve a semantic disagreement: the agent cannot redesign the interacting feature logic, rewrite the merged subsystems to be compatible, or determine which change takes semantic precedence.  Retrying loops without converging.

**Escalation signal and required actions**

A verification failure after any conflict_resolution attempt is an explicit escalation signal.  The handler must:

1. Stop immediately — do not commit or push the unverified merge state.
2. Mark the task `status:conflict-resolution-failed`.
3. Post a safe operator-facing GitHub comment (see below).

Do not attempt further automated resolution passes, redesign the feature autonomously, or attempt to determine semantic intent from the conflicting changes.

**Safe public comment shape**

The GitHub comment posted on escalation must contain:

- A plain-language statement that conflict resolution was attempted and verification failed.
- The names of the verification commands that failed (e.g. `npm test`) and their exit-code category.
- A statement that human semantic review is needed, naming the PR branch and the base branch.

The comment must not contain:

- Local filesystem paths (artifact root, worktree path, temp files, or any path rooted on the local machine).
- Raw agent output, implementation rationale, or diagnostic log text.
- Session IDs, run IDs, or internal task-store identifiers.
- Contents of local configuration files or environment variables.

Example safe comment:

> Conflict resolution was attempted for `ai/issue-<N>` against `main`.  The textual merge completed but verification failed (`npm test` — non-zero exit).  Human review is required to resolve the semantic conflict between the PR branch and `main`.

**Future work boundary**

Richer automation support — automated context enrichment, rationale surfacing, or semantic review-feedback integration — must be implemented as separate issues after this escalation boundary is established.  Do not add retry logic, autonomous redesign behavior, or semantic conflict fixers in any issue that establishes or depends on this policy.

Required artifacts:

- `conflict-resolution-prompt.md`
- `conflict-resolution-output.md`
- `conflict-resolution-result.json`
