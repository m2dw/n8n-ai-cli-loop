# Report-Only Rollout Mode (contract)

Issue: #532

An L1/report-only rollout gate for newly onboarded sessions: intake still
discovers and analyzes candidate issues, but the phases that mutate the
repository never run, so a session can be validated end-to-end (label
routing, dependency gating, agent/model resolution) before it is trusted to
create branches, push commits, or open pull requests.

## Configuration

```jsonc
{
  "sessionId": "addon-dev",
  // ...
  "reportOnly": { "enabled": true }
}
```

- `reportOnly` is optional. A session without it (or with `enabled: false`)
  runs normal automation — this is a pure opt-in gate, not a new default.
- Toggling `enabled` back to `false` (or removing the block) resumes normal
  implementation immediately; nothing about the session definition, labels,
  or already-queued tasks needs to change (acceptance criteria, issue #532).

## What is blocked

Only the phases that mutate the repository are refused:

- `implementation` — would create/update a branch, run a write-authority
  agent, and open or update a pull request.
- `conflict_resolution` — would commit and push a conflict-resolution merge
  to an existing PR branch.

Every other phase is unaffected: `research`, `content_research`,
`content_draft`, and `content_review` never touch the issue branch, and
`review` is read/analysis-only (it inspects an already-open PR but never
pushes, merges, or approves it — see `src/handlers/review.ts`). Intake keeps
finding and classifying candidate issues exactly as it does today.

## Enforcement — two layers

1. **Intake** (`src/cli/github-intake.ts`): a candidate that resolves to a
   blocked phase is never enqueued as that phase. Intake still scans and
   classifies the issue; the candidate instead gets a `report_only_deferred`
   result entry with a message stating what would have happened under normal
   automation. No task, branch, or PR is created — the primary,
   acceptance-criteria-facing guarantee.
2. **Phase admission** (`src/handlers/report-only-admission.ts`,
   `checkReportOnlyAdmission`), wired as the `runNextPhase` `admitPhase` gate
   in `src/cli/run-one-phase.ts` alongside the existing review-admission
   check (issue #681). This runs before the issue lock is acquired or the
   worktree is resolved/created — a rejection here is guaranteed
   side-effect-free. It is a defense-in-depth backstop for a task that
   reaches a blocked phase some other way: it was enqueued before the
   session opted into report-only mode, or a `review` outcome (`needs_fix` /
   `conflict`) requeued it into `implementation` / `conflict_resolution`
   after the session was switched to report-only.

A blocked admission flows through the normal completion path (status
transition, `phase.completed` event, escalation labels/comment) exactly like
any other `blocked` handler result: `implementation` is held at `blocked`
status (eligible for reactivation once report-only is turned off and intake
runs again), `conflict_resolution` is held at `ready_for_human`.

## The report

Every deferred/blocked candidate carries a message of the form:

> Session `<sessionId>` is in report-only mode (`reportOnly.enabled=true`):
> issue #`<n>` would have proceeded to the `'<phase>'` phase under normal
> automation — creating/updating a branch, running an implementation-capable
> agent with write authority, and opening or updating a pull request. No
> repository changes were made. Set `reportOnly.enabled` to `false` (or
> remove the block) to resume normal implementation for this session.

Intake's JSON output additionally surfaces `reportOnly: boolean` and
`reportOnlyDeferred: <count>` alongside the existing `enqueued` /
`alreadyExists` counters, so an n8n workflow (or an operator reading the CLI
output) can see at a glance how many candidates were held back.

## Deliberately out of scope (issue #532 backlog note)

This first slice does not post a report artifact to GitHub or invoke the
richer `issue-plan ai-preview` / `issue-discuss` analysis pipelines
automatically — those remain separate, operator-invoked commands (see
[issue-planning-gate-contract.md](issue-planning-gate-contract.md) and
[ai-planner-gate-architecture.md](ai-planner-gate-architecture.md)) that can
be run against the same candidate issues report-only mode still discovers.
No new GitHub labels are introduced; report-only status is a session-config
property, not label-driven.
