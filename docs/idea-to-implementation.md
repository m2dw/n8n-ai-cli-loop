# AI Idea-to-Implementation Workflow

This document walks through the complete lifecycle of a code change that is
driven by the AI dev loop — from writing a GitHub issue to having a PR ready
for human review.

---

> **Scope — Thin CLI Workflow Path Only**
>
> This guide describes the **thin CLI path** driven by three TypeScript CLI
> entrypoints: `github-intake` → `run-one-phase` → `dispatch-outbox`. Task
> state is stored in SQLite, implementation branches follow the `ai/issue-<N>`
> naming convention, and labels follow the `agent:*` / `status:*` / `ai:*`
> scheme documented below.
>
> Applicable workflow import files. For a local deployment import the gitignored
> copies generated under `.n8n-artifacts/workflows/` (baked with your `CLI_BASE`);
> the `docs/` copies are the tracked, environment-independent template:
> - `n8n-thin-child-workflow.json` (import first, shared by every session) —
>   `docs/` template or `.n8n-artifacts/workflows/`
> - the session's parent — `.n8n-artifacts/workflows/ai-dev-loop-parent-<slug>-<digest>.json`,
>   or the generic `docs/n8n-thin-parent-workflow.json` template
>
> For setup and smoke-test instructions, see
> [docs/parent-child-workflow.md](parent-child-workflow.md).

---

## Table of Contents

1. [Workflow Overview](#workflow-overview)
2. [Step 1 — Write a GitHub Issue](#step-1--write-a-github-issue)
3. [Step 2 — Apply Labels](#step-2--apply-labels)
4. [Step 3 — Automation Picks It Up](#step-3--automation-picks-it-up)
5. [Step 4 — Implementation Phase](#step-4--implementation-phase)
6. [Step 5 — Review Phase](#step-5--review-phase)
7. [Step 6 — Fix Cycle (if review finds issues)](#step-6--fix-cycle-if-review-finds-issues)
8. [Step 7 — Ready for Human](#step-7--ready-for-human)
9. [Tracking Progress](#tracking-progress)
10. [Other Entry Points](#other-entry-points)
11. [When to Intervene Manually](#when-to-intervene-manually)

---

## Workflow Overview

```
 Human                          n8n (every 5 min)                GitHub
 ──────                         ─────────────────                ──────
 [Write issue]
 [Apply labels] ──────────────► [GitHub Intake]
                                 ↓ enqueues into SQLite
                                [Run One Phase: implementation]
                                 ↓ Claude Code edits files
                                 ↓ handler commits + pushes + opens PR
                                                                  [PR opened]
                                [Run One Phase: review]
                                 ↓ Codex reviews diff
                                 ↓ handler classifies result
                                [Dispatch Outbox]
                                 ↓ posts comment + updates label
                                                                  [ai:ready-for-human]
 [Human reviews PR]
 [Human merges]
```

One n8n trigger runs one phase. The schedule trigger fires every five minutes,
so a full implementation + review cycle typically takes two trigger cycles
(~10 minutes) when no other tasks are queued ahead.

---

## Step 1 — Write a GitHub Issue

Write the issue title and body to convey the desired outcome, not the
implementation steps. The clearer the expected behavior and acceptance criteria,
the more likely the agent produces a usable first attempt.

> **Important — what the agent actually sees:** `github-intake` fetches the
> issue and persists `title`, `url`, `labels`, **and the issue body** to the
> task store. `buildPrompt()` constructs the implementation prompt from those
> stored fields plus any `reviewFeedback`, embedding the body under an
> `## Issue Description` heading. The issue body **is** passed to Claude during
> implementation, so acceptance criteria and context written in the body reach
> the agent. A precise title still matters as the primary signal for the kind
> of change expected.

Useful sections to include:

- **Goal** — one sentence describing what should be different after the change.
- **Context** — relevant background: which files, which behavior, why it
  matters.
- **Acceptance criteria** — observable conditions that indicate success. These
  reach the agent: the issue body is persisted at intake and included in the
  implementation prompt, so the criteria are consumed by Claude directly as
  well as being useful for humans reviewing the PR.
- **Out of scope** — explicitly list anything that should not change, if there
  is likely ambiguity.

Keep the title precise. The agent uses the title as the primary signal for what
kind of change is expected.

### Dependency ordering

If the issue depends on another issue being merged first, add a GitHub Issue
Relationship of type `blocked by` pointing at the blocking issue. The intake
step checks open `blocked by` relationships before enqueuing. Issues with open
blockers are skipped until all blockers are closed.

#### Dormant-first creation for dependent issue stacks

GitHub Issue Relationships and execution labels are configured in **separate**
operations, and intake runs on a five-minute schedule. The dependency gate only
holds back an issue whose `blocked by` relationship is **already visible at the
moment intake scans it**. If you apply executable labels (`agent:*` plus an
executable `status:*`) to a dependent issue *before* its `blocked by`
relationship is set, an intake scan can observe the labels while the gate still
sees no blocker, and enqueue the dependent as if it were independent. Because
enqueue is one-shot and idempotent (see
[Step 3 — GitHub Intake](#github-intake)), the relationship added afterward has
no retroactive effect — the dependent has already been admitted and will run
unblocked. **The race is not self-healing.**

This is exactly what happened while creating the #360–#365 issue stack:
execution labels were applied before the `blocked by` relationships were fully
configured, so intake saw `agent:*` / `status:needs-implementation` before the
relationship was visible and enqueued dependent issues as if they had no
blocker.

To create a dependent stack safely, follow the **dormant-first** contract:

1. **Create every issue in the stack dormant.** Do not apply `agent:*` labels.
   Do not apply executable `status:*` labels (`status:needs-implementation`,
   `status:needs-review`, `status:research-needed`,
   `status:needs-conflict-resolution`). Prefer `status:backlog` or no workflow
   status while relationships are being configured. The `agent:*` label goes on
   at activation time — step 4 for the root, step 5 for each dependent,
   including the refinement variant below — never before the graph is verified.
2. **Set all `blocked by` relationships** between the issues in the stack.
3. **Verify the relationship graph.** Confirm each dependent issue shows its
   intended open blocker(s) before any executable label is applied.
4. **Activate only the root issue.** Add executable labels (e.g.
   `agent:claude` + `status:needs-implementation`) to the single root issue —
   the one with no open blocker. Leave the dependents dormant.
5. **Activate each dependent explicitly — intake does not auto-activate dormant
   issues.** A dependent left fully dormant is never scanned: intake matches
   executable labels *first* and only then checks the dependency gate, so an
   issue with no executable labels never enters the queue, no matter how many of
   its blockers close. A human must apply each dependent's executable labels for
   it to run. Doing so is safe *once the relationship is configured and
   verified* (step 3): the visible `blocked by` relationship makes the
   dependency gate hold the dependent until its blocker state permits it. Note
   that "permitted" is **not** always "blocker closed":
   - **Close-only:** for unsupported blocker shapes the dependent waits until
     every `blocked by` blocker is *closed*.
   - **Stack-ready:** for a single open blocker on a new-implementation
     dependent, the dependent can be enqueued *before* the blocker closes, once
     the blocker reaches the success-only stack-ready marker
     (`status:stack-ready`) with a usable PR.

   The minimal-risk posture is to activate only the root first and label each
   dependent once you have confirmed its blocker state, so a mistaken
   relationship can never enqueue a dependent prematurely.

   A dependent that is still rough at step 5 — written before its blocker's
   design settled — has a specified home in the chain-aware progressive
   refinement lane: it can instead be labelled `agent:<impl>` +
   `status:needs-refinement` (an optional, default-off lane).

   **That lane is implemented but default-off — confirm your session has
   opted in before using it.** `status:needs-refinement` routes through the
   refinement handler only when `session.issueRefinement.enabled` is `true`
   (see [feature-status.md](feature-status.md#issue-refinement)); a session
   that has not opted in treats the label as inert, so applying the pair
   leaves the dependent dormant indefinitely instead of rewriting and
   activating it. If your session has not enabled the lane, refine a rough
   dependent's body by hand and activate it with the ordinary `agent:<impl>` +
   `status:needs-implementation` pair described above.

   The behavior the contract specifies is as follows.
   Apply **both** labels: the marker is not an executable status and `agent:*`
   alone routes nowhere, so the pair is dormant and cannot activate the
   dependent, but the refinement lane requires the agent label at admission and
   refuses an Issue that carries the marker without one. Applying the pair
   hands the Issue to chain-aware progressive refinement, which rewrites the
   Issue's contract from the blocker's stack-ready result, then swaps
   `status:needs-refinement` for `status:needs-implementation` and leaves your
   `agent:*` label in place — the ordinary implementation pair, which the next
   intake scan picks up under the unchanged dependency gates. See
   [issue-refinement-contract.md](issue-refinement-contract.md) (issue #866).

Distinguish three cases:

- **Single independent issue** — no `blocked by` relationship is expected.
  Apply executable labels immediately; there is no relationship to race against.
- **Dependent stack creation** — one or more issues will be `blocked by`
  another. Create them dormant, set and verify relationships, then activate the
  stack as above.
- **Activating the root after verification** — executable labels go on the root
  issue *only after* the relationship graph is confirmed. Activate a single root
  unless you deliberately intend to run multiple independent roots in parallel.

For the underlying intake contract that makes this ordering a correctness
requirement, see
[phase-contracts.md](phase-contracts.md#dependent-stack-creation--dormant-first-contract).

---

## Step 2 — Apply Labels

Labels are the intake gate. The automation scans for specific label
combinations and maps them to phases.

### Implementation path (most common)

```
agent:claude   +   status:needs-implementation
```

Claude Code implements the issue, commits the result on a branch named
`ai/issue-<N>`, and opens a pull request. The task then moves automatically to
the review phase.

### Fix an existing PR

```
agent:claude   +   status:needs-fix
```

Used when a PR already exists for this issue and the review has left actionable
findings. The automation checks out the existing branch and applies focused
fixes. Requires `reviewFeedback` in task context, which is written automatically
when the review handler transitions a task to `needs_fix` and requeues it.

**Manual recovery note:** The label-based intake is idempotent — if a task
already exists in SQLite, the intake step skips it and does not rewrite its
context. Applying `agent:claude` + `status:needs-fix` labels manually is
therefore not enough to requeue an existing task in fix mode. For manual
recovery, rerun the review phase — the review handler writes `reviewFeedback`
and requeues the task as `queued:implementation` when it classifies the result
as `needs_fix`. If the task is stuck in `failed`, `claimed`, or `running`
status before the review can run, reset it first:

```sh
node dist/cli/admin.js recover \
  --session-id <id> \
  --issue-number <N> \
  --phase review
```

Then trigger the review phase:

```sh
node dist/cli/run-one-phase.js \
  --session-id <id> \
  --run-id manual-rerun-1 \
  --supported-phases implementation,review,research
```

### Review only

```
agent:codex   +   status:needs-review
```

Enqueues a review task directly. Useful if you want to trigger review
independently of the automated review that follows implementation.

**Prerequisite:** The review handler requires `task.context.prUrl` or
`task.context.branch` to be present in the stored task; without one it exits
immediately with `No PR URL or branch`. For issues that went through the
normal implementation flow the branch (`ai/issue-<N>`) is already stored.
For issues that were never implemented through this automation you must seed
that context first — either run the normal implementation flow so the handler
records the branch, or use `enqueue-task` with a full `--context-json`
containing `prUrl` and `branch` (this only works when no task row exists yet;
`enqueueTask` returns `already_exists` for any pre-existing row and will not
update its context):

```sh
node dist/cli/enqueue-task.js \
  --session-id <id> \
  --issue-number <N> \
  --phase review \
  --implementation-agent claude \
  --review-agent codex \
  --context-json '{"title":"My feature","url":"https://github.com/org/repo/issues/N","labels":["enhancement"],"prUrl":"https://github.com/org/repo/pull/456","branch":"ai/issue-N"}'
```

Then run `run-one-phase` with `--supported-phases review` (or let the next n8n
trigger pick it up).

### Research first

```
agent:gemini   +   status:research-needed
```

Gemini investigates the problem space and produces a findings document. The
task ends at `ready_for_human` — a maintainer reads the output and decides
whether to open a new implementation issue. No code is written.

---

## Step 3 — Automation Picks It Up

The n8n workflow runs on a five-minute schedule (or immediately on manual
trigger). Each execution runs three CLI steps in sequence:

### GitHub Intake

`github-intake` scans open issues for the label combinations above. For each
matching issue it runs two checks:

1. **Dependency gate** — skips the issue if it has any open `blocked by`
   relationships. Fails closed: if the relationship check cannot be completed,
   the issue is held back.
2. **Idempotency** — skips the issue if it already exists in the SQLite task
   store. Each issue is enqueued at most once per session.

Issues that pass both checks are inserted into the SQLite queue as tasks.

### Run One Phase

`run-one-phase` claims one task from the queue and dispatches it to the
appropriate handler. Only one phase runs per execution.

### Dispatch Outbox

`dispatch-outbox` flushes pending GitHub actions (label changes, issue
comments) that were recorded during phase execution. These are written to a
local outbox table first and then sent to GitHub as a separate step to allow
safe retries.

---

## Step 4 — Implementation Phase

The implementation handler:

1. Checks that the working tree is clean.
2. Creates or checks out branch `ai/issue-<N>`.
3. Constructs a prompt from the stored task context (title, URL, labels, and the issue body) and any prior `reviewFeedback`; the GitHub issue body is included under an `## Issue Description` heading.
4. Runs Claude Code against the target repository with that prompt.
5. Verifies that Claude produced a non-empty diff.
6. Commits, pushes, and opens a pull request.
7. Records a `pr_url` and `branch` in task context.
8. Transitions the task to `queued:review`.
9. Enqueues a GitHub comment and label swap (`status:needs-review`, `agent:codex`) in the outbox.

Artifacts written to `<repoRoot>/.n8n-artifacts/runs/<run-id>/`:

| File | Contents |
|---|---|
| `implementation-prompt.md` | Prompt sent to Claude Code |
| `implementation-output.md` | Claude Code stdout |
| `implementation-result.json` | Structured result including `prUrl` and `branch` |

If the implementation fails (Claude exits non-zero, no diff produced, or a git
operation fails), the task transitions to `status: "failed"` and a failure
comment is posted.

---

## Step 5 — Review Phase

The review handler:

1. Looks up the open PR for `ai/issue-<N>`.
2. Checks out the PR branch.
3. Runs the configured verification commands (e.g. `npm test`,
   `npm run package`).
4. Runs Codex CLI to review the diff against `main`.
5. Classifies the result:

| Classification | Next state | What happens |
|---|---|---|
| `success` | `ready_for_human` | A success comment is posted; label → `ai:ready-for-human` |
| `needs_fix` | `queued:implementation` (fix mode) | Review output is saved as `reviewFeedback`; task is requeued for Claude to apply fixes |
| `conflict` | `ready_for_human` | Escalated; human must resolve merge conflict manually |
| `blocked` | `ready_for_human` | Ambiguous or empty review output; escalated to human |

Artifacts written to `<repoRoot>/.n8n-artifacts/runs/<run-id>/`:

| File | Contents |
|---|---|
| `review-context.json` | PR and branch snapshot |
| `review-output.md` | Raw Codex review output |
| `review-result.json` | Classification and findings |
| `review-verification-<name>.log` | Output of each verification command |

---

## Step 6 — Fix Cycle (if review finds issues)

When review classifies the result as `needs_fix`, the task is automatically
requeued in fix mode. No human action is required. The next execution of
`run-one-phase` will:

1. Check out the existing `ai/issue-<N>` branch (no new PR is created).
2. Run Claude Code with a prompt that includes the original issue context plus
   the review findings.
3. Commit and push the fixes to the same branch.
4. Transition the task back to `queued:review`.

The fix → review → fix cycle repeats until the review passes, a conflict is
detected, or a failure escalates to human.

---

## Step 7 — Ready for Human

When the task reaches `ready_for_human`, the following have happened:

- The GitHub issue label has been updated to `ai:ready-for-human`.
- A comment has been posted on the issue with the outcome summary.
- The pull request (if any) is open. It has passed automated review if the classification was `success`; for `conflict` or `blocked` escalations it requires manual inspection.

Human actions at this point:

1. Read the bot comment on the issue for a summary of what was done.
2. Open the pull request and read the diff.
3. Run any manual checks you consider important.
4. Merge the PR if satisfactory, or trigger another fix cycle. See
   [When to Intervene Manually](#when-to-intervene-manually) for the correct
   recovery path — label-only intake will not requeue an existing task.

---

## Tracking Progress

### GitHub issue labels

| Label | Meaning |
|---|---|
| `ai:active` | A phase is in progress or recently completed |
| `ai:blocked` | The task is blocked and needs human attention |
| `ai:ready-for-human` | Automation has finished; human decision required |

### SQLite state

The `tasks` and `events` tables are keyed by `session_id`. A single database
can hold rows for multiple sessions, so always filter by `session_id` when
querying those tables to avoid mixing rows from different sessions:

```sh
sqlite3 ~/.config/n8n-ai-cli-loop/dev_loop.db

-- Current task status for one session
SELECT session_id, issue_number, status, phase, updated_at
FROM tasks
WHERE session_id = '<session-id>'
ORDER BY updated_at DESC;

-- Pending outbox actions (not yet sent to GitHub)
SELECT id, topic, idempotency_key, sent_at
FROM outbox
WHERE sent_at IS NULL
ORDER BY id;

-- Event log for a specific issue within a session
SELECT type, message, created_at
FROM events
WHERE session_id = '<session-id>' AND issue_number = <N>
ORDER BY id;
```

### Artifacts

Each phase run writes files under `<repoRoot>/.n8n-artifacts/runs/<run-id>/`.
The run ID matches the n8n execution ID when triggered from n8n, or the value
of `--run-id` when invoked manually.

#### Privacy and prerequisites

`.n8n-artifacts/` is **local-only operational data** and must not be committed
or posted publicly. Artifact files can contain:

- The full implementation or review prompt (including issue body and
  `reviewFeedback` from prior cycles)
- Raw agent output (Claude Code stdout, Codex review text)
- Verification command output (`npm test`, `npm run package`, etc.)
- Branch names, PR URLs, and other local context

Keep `.n8n-artifacts/` listed in the target repository's `.gitignore` so these
files are excluded from commits and never appear in the PR diff that Claude or
Codex review. **If you target a repository that does not already ignore it, add
`.n8n-artifacts/` to that repo's `.gitignore` before running the loop.**

When referencing artifacts in GitHub comments or issue threads, summarize the
findings in plain text rather than pasting raw artifact content. Do **not**
include local absolute paths (e.g. `/Users/you/.n8n-artifacts/…`) in any
GitHub comment — those paths are machine-specific and may leak system details.
Refer to a run by its run ID or a short sanitized description instead.

A repository-wide scan (`rg "/Users/" --hidden -g '!node_modules' -g '!.git' .`)
confirms the only remaining `/Users/...` references live under `test/` — fixture
data for path-redaction and path-handling coverage (e.g. `test/text-sanitize.test.js`,
`test/tool-request.test.js`) — plus the neutral placeholder examples above
(`/Users/you/...`, `/Users/alice/...`). Those are intentional and should not be
changed to satisfy a "no personal paths" scan.

---

## Other Entry Points

### Manual enqueue

For normal issue-driven work, prefer `github-intake` so the handler fetches
the issue and populates the required context automatically:

```sh
node /path/to/dist/cli/github-intake.js \
  --session-id ai-cli-loop \
  --supported-phases implementation,review,research
```

If you must call `enqueue-task` directly, pass `--context-json` with at least
the issue `title`, `url`, and `labels`; otherwise the implementation prompt
falls back to just `Issue #123` and Claude will not see the requested change.
For review tasks, also include `prUrl` or `branch` inside the context object.

```sh
node /path/to/dist/cli/enqueue-task.js \
  --session-id ai-cli-loop \
  --issue-number 123 \
  --phase implementation \
  --implementation-agent claude \
  --review-agent codex \
  --context-json '{"title":"My feature","url":"https://github.com/org/repo/issues/123","labels":["enhancement"]}'
```

For a review task, add the PR reference:

```sh
node /path/to/dist/cli/enqueue-task.js \
  --session-id ai-cli-loop \
  --issue-number 123 \
  --phase review \
  --implementation-agent claude \
  --review-agent codex \
  --context-json '{"title":"My feature","url":"https://github.com/org/repo/issues/123","labels":["enhancement"],"prUrl":"https://github.com/org/repo/pull/456","branch":"ai/issue-123"}'
```

### Manual phase execution

Run a single phase outside of n8n:

```sh
node /path/to/dist/cli/run-one-phase.js \
  --session-id ai-cli-loop \
  --run-id manual-run-1 \
  --supported-phases implementation
```

### Manual outbox flush

Send pending GitHub actions immediately without waiting for the next n8n
trigger:

```sh
node /path/to/dist/cli/dispatch-outbox.js --session-id ai-cli-loop
```

---

## When to Intervene Manually

| Situation | Action |
|---|---|
| `ai:ready-for-human` after implementation success | Review and merge the PR |
| Task in `failed` status after implementation failure | Read the failure comment; rewrite the issue if needed; then run `admin recover --session-id <id> --issue-number <N>` to reset the failed task back to `queued` for a retry. Re-applying labels alone will not requeue it (the task store returns `already_exists` for any existing row), and deleting the row is not the primary path — prefer `admin recover`. |
| `ai:ready-for-human` with `conflict` classification | Resolve the merge conflict on `ai/issue-<N>` manually, then push and re-trigger review |
| Manual fix recovery (existing task needs `reviewFeedback`) | Rerun the review phase — the review handler writes `reviewFeedback` and requeues on `needs_fix` automatically. If the task is stuck in `failed`, `claimed`, or `running` status, reset it first with `admin recover --session-id <id> --issue-number <N> --phase review`, then trigger review via `run-one-phase --session-id <id> --supported-phases implementation,review,research`. |
| Task stuck at `ready_for_human` because the review loop hit its cap (`reviewLoopCapReached`) | Run `admin recover-cap-handoff --session-id <id> --issue-number <N>` to requeue the task for another review cycle. This only targets `ready_for_human` tasks where `reviewLoopCapReached` is set. |
| `ai:blocked` | Human-handoff state — **`admin recover` does not apply here.** `admin recover` only resets tasks in `failed`, `claimed`, or `running` status; `recoverTask` rejects `blocked`, so running it against an `ai:blocked` task returns an empty result rather than requeuing it. Check the bot comment and resolve whatever is blocking (e.g. close or unlink the blocking issue). Re-applying the original label alone is a no-op because `enqueueTask` returns `already_exists` for any existing row and will not change its state. To re-queue after resolving the blocker, delete the blocked row from SQLite (`DELETE FROM tasks WHERE session_id = '<id>' AND issue_number = <N>;`) and then re-run `github-intake --session-id <id> --supported-phases implementation,review,research`. |
| Outbox stuck (`failed > 0` in dispatch-outbox output) | Re-run dispatch-outbox manually; GitHub may have been rate-limited or temporarily unavailable |
| Task stuck in `claimed` status in SQLite | The n8n execution that held the lease may have been cancelled. Run `admin list-stuck --session-id <id>` to see whether the lease has expired (stale). Once expired, reset with `admin recover --session-id <id> --issue-number <N>`. If the lease has not yet expired, wait for it to expire before recovering. |

For architectural background and future directions, see
[docs/future-architecture.md](future-architecture.md).

For n8n setup instructions, see
[docs/parent-child-workflow.md](parent-child-workflow.md).
For a detailed CLI output reference, see the archived guide
[docs/archive/minimal-self-driving.md](archive/minimal-self-driving.md).
