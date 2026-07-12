# Per-Issue Worktree Rollout

This document covers the **operational** path for enabling per-issue worktrees
in a running session: how to opt in, what to expect at runtime, how to verify
the feature, and how to recover from common failure modes.

For the underlying design see [docs/per-issue-worktrees.md](per-issue-worktrees.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Enabling Worktrees in sessions.json](#enabling-worktrees-in-sessionsjson)
3. [Operational Model](#operational-model)
4. [Mid-Flight Enablement](#mid-flight-enablement)
5. [Smoke-Test Checklist](#smoke-test-checklist)
6. [Cleanup, Prune, and Recovery](#cleanup-prune-and-recovery)
7. [Security Notes — Path Confidentiality](#security-notes--path-confidentiality)

---

## Overview

Per-issue worktrees give each work item its own isolated git checkout under a
managed state root. Phases (implementation, review, conflict resolution, Tool
Request) execute inside the issue worktree rather than in the shared session
`repoRoot`. The canonical `repoRoot` continues to act as the source for fetch,
prune, and worktree registry operations.

The feature is **opt-in** (default off). A session without the `worktrees`
block keeps today's shared-checkout behavior unchanged.

---

## Enabling Worktrees in sessions.json

Add a `worktrees` block to the target session entry in `sessions.json`
(default path: `~/.config/n8n-ai-cli-loop/sessions.json`):

```json
{
  "sessions": [
    {
      "sessionId": "ai-cli-loop",
      "repoRoot": "/Users/you/git/my-repo",
      "githubRepo": "owner/my-repo",
      "artifactDir": ".n8n-artifacts",
      "worktrees": {
        "enabled": true
      },
      "defaults": {
        "implementationAgent": "claude",
        "reviewAgent": "codex"
      },
      "verification": {
        "test": "npm test"
      },
      "labels": {
        "active": "ai:active",
        "blocked": "ai:blocked",
        "readyForHuman": "ai:ready-for-human"
      }
    }
  ]
}
```

### Optional: custom worktree root

By default the runtime stores worktrees at
`~/.local/state/n8n-ai-cli-loop/worktrees/<session>/<issue>/repo/`. To
override the root for one session only, add the `root` field:

```json
"worktrees": {
  "enabled": true,
  "root": "/fast-disk/worktrees"
}
```

The `root` value must be an **absolute path** outside committed source. It is
also configurable globally via the `N8N_AI_WORKTREE_ROOT` environment variable
(session-level `root` takes precedence over the env var).

### Verifying the config loads cleanly

```sh
node dist/cli/run-one-phase.js --session-id ai-cli-loop --dry-run
```

A malformed `worktrees` block (e.g. a non-absolute `root`) causes the CLI to
exit with a validation error before any work runs.

---

## Operational Model

### Canonical repo vs. issue worktrees

| Location | Role |
|---|---|
| `repoRoot` (canonical) | Fetch, worktree registry, `git worktree add/prune/list` |
| `<worktree root>/<session>/issue-<n>/repo/` | Phase execution cwd for issue N |

The canonical checkout is never modified by phase handlers once worktrees are
enabled. It stays on whatever branch it was on when the session started.

### Worktree lifecycle per issue

1. **Implementation** — the handler creates the worktree (`git worktree add`),
   records `worktreeId` + `worktreePath` in the task context, and removes the
   worktree after committing and pushing the implementation branch.

2. **Review** — creates a fresh worktree for the issue (another `git worktree
   add`), executes inside it, and acquires the issue lock so a concurrent
   review-trigger cannot overlap. The worktree is removed when review finishes.

3. **Tool Request grant / manual-done** — runs against the issue worktree while
   it is active, so side effects land on the issue branch directly.

4. **Conflict resolution** — creates or reuses the issue worktree, resets it to
   the PR head (`git reset --hard origin/<branch>`), and runs in place.

5. **Completion** — any remaining worktree is removed by the handler; the
   operator can run `prune` to reclaim any leftover directories.

> **Note:** `git worktree add` may be called more than once per issue because
> phases that remove the worktree on success (implementation, review) will
> recreate it if a subsequent phase needs it. This is expected behaviour; a
> missing worktree directory between phases is not a sign of a problem.

### Concurrency

Different issues may execute phases simultaneously; each has its own lock
(`IssueWorktreeLock`). The same issue is serialised by that lock — a second
trigger for the same issue is rejected with `lock_contended`.

---

## Mid-Flight Enablement

You can add `"worktrees": { "enabled": true }` to a session that already has
active tasks:

- Issues whose tasks have **not yet started** (or are in `queued` state) pick
  up worktrees automatically on their first phase run.
- Issues that **already have work in the shared checkout** continue to use that
  checkout for any phase that runs before their first worktree-native phase.
  On the first phase after enablement `resolveIssueWorktree` creates the
  worktree and records it in the task context; later phases use it.
- No database migration is needed: `worktreeId` is recomputable from session +
  issue number if it is not already recorded.
- Issues already in a terminal state (`done`, `failed`) are unaffected.

There is no need to drain the queue before enabling; existing active issues
complete on the shared checkout if they are mid-flight when you change the
config, then pick up worktrees on the next trigger.

---

## Smoke-Test Checklist

This is a **manual checklist**. Run it after enabling worktrees for the first
time on a session, or after upgrading to a new release that changes worktree
behaviour. It is not run automatically by the test suite.

### Prerequisites

- [ ] `worktrees.enabled: true` is set in `sessions.json` for the target session.
- [ ] At least one open GitHub issue labelled `ai:active` exists in the target repo.
- [ ] n8n parent and child workflows are imported and active.
- [ ] CLI is at the expected version (`node dist/cli/run-one-phase.js --version`).

### Implementation path

- [ ] Trigger the parent workflow (manual trigger in n8n).
- [ ] Confirm the child execution processes one implementation phase without error.
- [ ] Inspect the task context (`admin status --session-id <id> --issue-number <n>`):
  - [ ] `worktreeId` field is present and matches `<sessionId>/issue-<n>`.
  - [ ] `worktreePath` field is present and points to a directory under the
        worktree root (do **not** post this path publicly — see
        [Security Notes](#security-notes--path-confidentiality)).
- [ ] Verify the issue branch exists in the worktree:
  ```sh
  git -C "$(node -e "const s=require('~/.config/n8n-ai-cli-loop/sessions.json'); ...")" branch
  ```
  Or inspect via:
  ```sh
  node dist/cli/admin.js worktree list --session-id <id>
  ```
  The issue worktree should appear in the list with status `main` or the issue branch.

### Review path

- [ ] Label an issue `ai:ready-for-human`, then (after human review) restore
      the `ai:active` label so a review phase is enqueued.
- [ ] Trigger the workflow; confirm the review phase runs inside the worktree
      (no dirty-state complaint from the implementation handler).
- [ ] Confirm the PR is updated (comment or approval) without touching the
      canonical `repoRoot`.

### Tool Request path

- [ ] Create an issue that will produce a Tool Request during implementation
      (or manually inject a `tool_request` task status).
- [ ] Verify `admin tool-request list --session-id <id>` shows the pending
      request.
- [ ] Run `admin tool-request grant --session-id <id> --issue-number <n>
      --on-changes` and confirm the grant operates inside the issue worktree.
- [ ] Confirm the worktree directory persists after the grant (it is not
      removed on handoff, unlike the shared-checkout model).

### Cleanup path

- [ ] After a task reaches `done`, run:
  ```sh
  node dist/cli/admin.js worktree cleanup --session-id <id>
  ```
  Confirm the done issue's worktree appears as a prune candidate.
- [ ] Re-run with `--yes` and confirm the worktree directory is removed.
- [ ] Confirm the issue branch still exists on `origin` (cleanup never deletes branches).

### Negative / isolation check

- [ ] While issue A is running, trigger issue B simultaneously.
- [ ] Confirm both executions proceed without blocking each other.
- [ ] Confirm the lock for issue A does not block issue B (distinct lock scopes).

---

## Cleanup, Prune, and Recovery

### List worktrees

```sh
node dist/cli/admin.js worktree list --session-id <id>
```

Shows all worktrees registered against the canonical repo, marking which are
managed per-issue worktrees vs. the canonical checkout.

### Prune a single issue

```sh
# Preview (default — no changes):
node dist/cli/admin.js worktree prune --session-id <id> --issue-number <n>

# Remove:
node dist/cli/admin.js worktree prune --session-id <id> --issue-number <n> --yes

# Remove even if dirty or locked (use with care):
node dist/cli/admin.js worktree prune --session-id <id> --issue-number <n> --yes --force
```

Branches are never deleted. The canonical checkout is never touched.

### Bulk cleanup of terminal/orphaned worktrees

```sh
# Preview candidates:
node dist/cli/admin.js worktree cleanup --session-id <id>

# Remove candidates:
node dist/cli/admin.js worktree cleanup --session-id <id> --yes
```

A worktree is a prune candidate when its backing task is `done`, `failed`, or
orphaned (no task row). Active tasks (`queued`, `claimed`, `running`,
`blocked`, `ready_for_human`) and live locks are never pruned.

### Release a stale lock

If a crash leaves a stale issue lock:

```sh
# Preview:
node dist/cli/admin.js worktree release-lock --session-id <id> --issue-number <n>

# Release:
node dist/cli/admin.js worktree release-lock --session-id <id> --issue-number <n> --yes
```

A live (non-stale) lock is refused unless `--force`, since releasing it would
allow two runs to modify the same worktree concurrently.

### Recovery diagnosis

```sh
# Diagnose all issues in a session:
node dist/cli/admin.js worktree recovery --session-id <id>

# Diagnose one issue:
node dist/cli/admin.js worktree recovery --session-id <id> --issue-number <n>
```

This is a **read-only** command. It classifies each issue into one of:
`resume`, `recreate-worktree`, `recreate-from-remote`, `cleanup-stale`,
`report-drift`, or `skip-locked`, and prints the recommended follow-up command.
It never mutates branches, worktrees, or tasks.

Recovery recommendations reference issue numbers and branch names only — never
absolute worktree paths — so the output is safe to share publicly.

---

## Security Notes — Path Confidentiality

Worktree paths (`worktreePath` in task context, `<worktree root>/…` on disk)
are **local filesystem paths** that may reveal host directory layout. The
runtime already redacts the worktree state root from public GitHub comments via
`sessionRedactionPaths`, so outbox comments never leak these paths.

Operators must take the same care manually:

- Do **not** paste `worktreePath` values from task context into GitHub issues,
  PRs, or Slack messages.
- Do **not** include the worktree root in bug reports posted publicly.
- Use `admin worktree recovery` output (which references only branch names) when
  sharing diagnostic output with others.
