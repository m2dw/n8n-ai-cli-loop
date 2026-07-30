# Per-Issue Worktrees

Status: design + foundation slice (issue #400). Worktree-only operation is
now unconditional across all repo-working phases (issue #731) — see
[docs/worktree-only-migration-contract.md](worktree-only-migration-contract.md)
for the migration history; the "Scope of the first slice" and "Deferred"
sections below describe the original 2024 landing and are historical.

This document defines the per-issue git worktree model: the lifecycle, lock
model, recovery model, and cleanup model. It also records what the first
implementation slice lands and what is deliberately deferred to follow-up issues.

## Problem

Today every issue in a session shares one mutable checkout — the session
`repoRoot`. Implementation, review, and conflict resolution all `git checkout`
inside it, so:

- a failed agent run can leave partial edits in the shared checkout;
- Tool Request / manual recovery must pause the whole workflow because the shared
  checkout is dirty;
- one issue waiting on a human blocks unrelated issues;
- the session repo lock degrades into a broad stop-the-world guard.

The contamination guard, quarantine marker, and discard-to-base machinery in the
implementation handler all exist to manage this single shared mutable tree.

## Model

Each work item runs in its own durable git worktree, keyed by session + issue:

```text
<root>/<session>/issue-<n>/repo/      # git worktree checkout for ai/issue-<n>
```

- `<root>` is the managed state root. Resolution order: per-session
  `worktrees.root` → `N8N_AI_WORKTREE_ROOT` env → default
  `~/.local/state/n8n-ai-cli-loop/worktrees`. It lives OUTSIDE committed source
  and is never an artifact root.
- The session segment is URL-encoded so a sessionId containing `/` cannot
  traverse out of `<root>`.
- The session `repoRoot` stays the **canonical** repository: it is where the
  worktrees are created/fetched/pruned from. Phase handlers operate inside the
  issue worktree once it exists.
- `worktreeId` is the stable, location-independent identity `<session>/issue-<n>`
  recorded in task context so later phases (and admin commands) re-resolve the
  same worktree even if `<root>` moved.

### Path / identity helpers

`src/core/worktree-paths.ts` (pure, dependency-free):

- `resolveWorktreeRoot({ sessionRoot?, env? })`
- `issueWorktreeId(sessionId, issueNumber)`
- `issueWorktreePath(root, sessionId, issueNumber)`
- `sessionWorktreeDir(root, sessionId)`
- `redactWorktreePaths(text, root)`

### Git operations + lock

`src/handlers/worktree.ts` (all git side effects via an injected `CommandRunner`,
so the logic is unit-testable without a real repo):

- `resolveIssueWorktree(input)` — create on first use, reuse on later phases.
  Reuse is keyed on the deterministic checkout path, so a resumed phase lands in
  the same tree the prior phase left behind. Creation never mutates the canonical
  checkout: `git worktree add` registers a new working tree and checks out the
  issue branch there (created from `baseRef` when the branch is new, checked out
  as-is when it already exists — `-B` is never used, so prior work is never reset
  away).
- `listWorktrees(repoRoot, runner)` / `parseWorktreeList(porcelain)` —
  structured `git worktree list --porcelain`.
- `removeWorktree(repoRoot, path, { force })` — `git worktree remove`; refuses a
  dirty/locked worktree unless `force`.
- `IssueWorktreeLock` — issue-scoped advisory lock (see Locking).

## Lifecycle

1. **First implementation for an issue**
   - resolve/create branch `ai/issue-<n>` per existing branch/dependency logic;
   - create the issue worktree under the managed state root, checked out on that
     branch;
   - record `worktreeId` + `worktreePath` in task context.
2. **Subsequent phases (review, fix, conflict resolution)**
   - resolve the issue worktree path from context (or recompute deterministically
     from session + issue);
   - run the phase inside that worktree.
3. **Completion / close / cleanup**
   - leave the worktree in place until the PR/Issue state is clearly terminal;
   - `admin worktree list` inspects, `admin worktree prune` removes.

## Locking

- **Session-level lock** (existing `RepoLockStore`): narrowed to operations that
  mutate the canonical repo / worktree registry (creating/pruning worktrees,
  fetching shared refs).
- **Issue/worktree-level lock** (`IssueWorktreeLock`): taken around phase
  execution. Keyed `<session>::issue-<n>` in a dedicated `worktree-locks`
  directory, reusing the proven atomic O_EXCL primitive of `RepoLockStore`.
  - the SAME issue must not run concurrently (one active execution per worktree);
  - DIFFERENT issues may run concurrently — distinct lock scopes never collide;
  - this does NOT rely on n8n preventing overlapping executions.

## Tool Request behavior

- A Tool Request handoff PRESERVES the issue worktree instead of discarding the
  only useful state. The branch-delete / discard-to-base machinery that the
  shared-checkout model needs is unnecessary here: the worktree itself is the
  durable continuation point.
- `admin tool-request grant` / `resolve` operate against the issue worktree
  (`issueWorktreePath(...)`) rather than the shared checkout, so granted-command
  side effects and manual-done verification naturally land on the issue branch.
- A Tool Request with no continuation point becomes an exceptional recovery path,
  not a normal operator flow.

## Recovery model

- Dirty state in one issue worktree never blocks another issue: each issue owns
  its own tree.
- Quota/rate-limit delay: the worktree is reset to its issue-branch tip
  (`git reset --hard` + `git clean -fd` within the worktree) before the delayed
  retry — branches are never deleted.
- Branch deletion / force-push from outside the workflow: detected on resolve
  (the worktree's branch ref is reconciled with origin; divergence fails closed,
  matching today's resume discipline).
- The quarantine marker remains a backstop only for the shared-checkout path.

### Drift diagnosis (`admin worktree recovery`, issue #408)

Per-issue worktrees remove shared-checkout dirty-state failures but introduce
drift between the task context, branch refs, the worktree registry, the issue
lock, and PR state. `admin worktree recovery --session-id <id> [--issue-number
<n>]` is a **read-only** diagnostic that classifies each affected issue into one
recommended action and explains the follow-up command. The pure decision core is
`core/worktree-recovery.ts` (`assessWorktreeRecovery`); the admin command gathers
the git/lock/PR/task signals and renders them. It never deletes branches, removes
worktrees, or mutates tasks.

| State | Action | Meaning |
| --- | --- | --- |
| branch + worktree present and agree | `resume` | resume the worktree |
| branch present, worktree missing, has work (commits ahead / PR / remote) | `recreate-worktree` | recreate the worktree from the existing branch (checked out, never `-b`, so it never fails with `branch already exists`) |
| no local branch but a remote branch / open PR exists | `recreate-from-remote` | recreate the local worktree from remote state |
| local-only branch, no commits ahead of base, no PR | `cleanup-stale` | stale cleanup candidate — the #404 class |
| a task expects a worktree but nothing is recoverable | `report-drift` | recoverable drift, not a hard failure — re-queue for a fresh worktree |
| an active (non-stale) lock holds the issue | `skip-locked` | a live run owns it; do not recover |

A held-but-**stale** lock never blocks recovery; it is surfaced via `staleLock`
with a `worktree release-lock` hint (the per-issue worktree lock — not
`repo-lock force-release`, which targets the session-wide repo lock). Without `--issue-number` the command
diagnoses every issue that has a task or a local `ai/issue-*` branch. Guidance
strings reference only issue numbers and branch names, never absolute paths, so a
recovery recommendation can never leak a local worktree path into a public
comment.

## Dirty Worktree Policy

### Background

Multi-worktree support changes the meaning of a dirty working tree.

Under the shared/canonical checkout model, starting a phase with a dirty tree
is dangerous because unrelated work may be mixed into the automation commit.
With per-issue worktrees each issue owns its own isolated checkout, so a dirty
tree in issue N can only contain work that belongs to issue N.

The motivating failure mode (issue #561): a fix-mode implementation produced
useful edits; verification failed before commit/push; those edits remained in
the issue worktree; and the next implementation attempt aborted at the
clean-check before it could continue the work.

### Policy by checkout type

| Checkout type | Dirty state | Policy |
|---|---|---|
| Canonical repo (`repoRoot`) | Dirty | **Fatal** — shared; dirty state is always unrelated to the current issue. |
| Shared/non-isolated checkout (worktrees disabled) | Dirty | **Fatal** — same reasoning as canonical. |
| Per-issue worktree | Dirty | **Not automatically fatal** — the worktree is owned by that issue. |

### When a dirty per-issue worktree may continue automatically

A phase may proceed on a dirty per-issue worktree when all of the following
safety checks pass:

1. The worktree exists and is recognized by `git worktree list`.
2. The worktree's HEAD branch matches the expected issue branch (`ai/issue-<n>`).
3. The issue number in task context matches the worktree's keyed path
   (`<session>/issue-<n>`).
4. No active lock is held by a concurrent run for this issue — lock contention
   is still fatal.
5. The canonical checkout is clean.

When these conditions hold the dirty state is treated as unfinished work from
the same issue and the phase continues.

### Why dirty continuation is safe for per-issue worktrees

- Each issue owns exactly one worktree, keyed `<session>/issue-<n>`. No other
  issue's work can appear in it.
- The issue lock (`IssueWorktreeLock`) ensures only one run accesses the
  worktree at a time; dirty state therefore cannot be from a concurrent run.
- Edits already in the worktree came from either the automation or an operator
  who intentionally edited the checkout. Both are valid continuation points.
- The implementation agent sees the existing edits in its working tree and can
  build on or replace them — it is not forced to restart from the branch tip.

### Human-edited worktrees

This system does not attempt to detect whether dirty state was produced by
an AI run or by a human editing the worktree directly. If an operator edits a
per-issue worktree, the next phase run treats those edits as the starting
point, the same as any other dirty worktree. Perfect detection of human vs.
AI authorship is neither required nor attempted.

Operators who want to discard dirty state rather than continue from it should
use the dedicated discard command once implemented (see Follow-up work below).

### Fail-closed conditions

Even with the relaxed policy, the following conditions are always fatal:

1. **Canonical checkout is dirty** — abort regardless of worktree mode.
2. **Branch mismatch** — the worktree's HEAD is not `ai/issue-<n>`.
3. **Issue mismatch** — the worktree's key does not match the current issue.
4. **Missing or invalid worktree** — the path is not registered in
   `git worktree list`.
5. **Active lock contention** — a concurrent run holds the issue lock.
6. **Unsafe paths** — any worktree path outside the managed worktree root, or
   inside committed source, is rejected before any phase logic runs.

These conditions represent a genuine integrity problem that cannot be resolved
by continuing with the dirty state; each must stop the phase and surface a
clear error.

### Follow-up implementation work

The following concrete implementation changes are deferred to separate issues:

1. **Continue dirty worktrees** — Implement the continuation logic described
   above: when a phase starts and finds a dirty per-issue worktree, apply the
   safety checks and proceed instead of aborting. *(Implemented in issue #571.)*


2. **Record dirty-failure state** — When a phase aborts because the per-issue
   worktree is dirty and the safety checks fail, record a `dirtyContinuation`
   marker in task context and save the uncommitted diff as an artifact
   (`implementation-dirty-patch.patch`). Subsequent phases can read this to
   distinguish "dirty from a known prior failure" from "dirty for an unknown
   reason" without inspecting git state. *(Implemented in issue #568.)*

### Operator status view — dirty worktree states

`admin status` classifies per-issue worktree dirty state into three categories
that appear in both human-readable and JSON (`--json`) output:

| Display / JSON `dirtyCategory` | Meaning |
|---|---|
| `continuation_candidate` | Worktree is dirty and the task context holds a `dirtyContinuation` marker from a prior verification failure. The **next run will continue automatically** from this state after re-running the safety checks. |
| `continuation_active` | Same marker present and the task is **currently running** — the active phase is using the dirty worktree. |
| `action_required` | Worktree is dirty but **no continuation record** exists. The phase cannot continue safely without operator intervention. |

The canonical checkout dirty state (`canonicalDirty: true` in JSON, `DIRTY (fatal
— implementation aborts; review and conflict-resolution run in the issue
worktree)` in human output) is always reported separately. It blocks
implementation only — review and conflict-resolution phases run inside the
per-issue worktree and are unaffected by canonical checkout dirt.

**Operator recovery:**

- **`continuation_candidate`** — Review the uncommitted changes if desired
  (`git -C <worktree-path> diff HEAD`), then either let the next run proceed
  automatically or discard with:
  ```
  admin worktree discard --session-id <id> --issue-number <n> --yes
  ```
  A discard resets the worktree to `HEAD` (`git reset --hard HEAD`) and
  removes untracked files (`git clean -ffd`), leaving the managed worktree
  registered and in place. The next run resumes from the clean branch tip
  without needing to create a new worktree. Use `worktree discard` rather
  than `worktree prune --force` because `discard` is lock-aware and will
  refuse to act while a worker holds the lock, preventing accidental
  destruction of an active worker's uncommitted changes. If you need to
  clear ignored files or worktree-local configuration that `git clean -ffd`
  does not remove, use `worktree prune` to deregister and delete the
  directory entirely, then let the next run recreate it.

- **`action_required`** — Inspect the dirty state. If the changes are not
  needed, discard with:
  ```
  admin worktree discard --session-id <id> --issue-number <n> --yes
  ```

- **Canonical dirty** — Clean or stash the changes in the canonical checkout
  manually (outside the automation). The per-issue worktrees are unaffected.

Public comments never include worktree paths or dirty-state details; only
sanitized summaries are posted.

## Cleanup model

- No automatic deletion while the PR/Issue is non-terminal — durability is the
  point.
- `admin worktree list --session-id <id>` reports every worktree registered
  against the canonical repo, flagging which are managed per-issue worktrees.
- `admin worktree prune --session-id <id> --issue-number <n>` removes one issue's
  worktree. Previews by default; `--yes` removes; `--force` discards a
  dirty/locked worktree. A missing worktree is a safe no-op. Branches are never
  deleted and the canonical checkout is never touched.
- `admin worktree cleanup --session-id <id>` (issue #407) bulk-classifies every
  managed per-issue worktree for the session from the worktree registry + task
  store and prunes the ones safe to remove:
  - **active** — the issue's task is `queued`/`claimed`/`running`/`blocked`/
    `ready_for_human`, or it holds a live issue lock → never pruned.
  - **terminal** — the issue's task is `done` → prune candidate.
  - **orphaned** — no task row backs the worktree → prune candidate.
  - any other terminal-ish status (e.g. `failed`) is also a candidate, still
    protected by the dirty/unpushed guards below.

  Previews by default (changes nothing); `--yes` removes the candidates. A dirty
  worktree, or one whose branch has commits not on `origin`, is skipped and
  reported unless `--force` is given (which discards that state, clearly logged).
  Every skip carries its reason; the report lists what was removed and what was
  skipped. Branches are never deleted and the canonical checkout is never touched.
- `admin worktree release-lock --session-id <id> --issue-number <n>` (issue #407)
  frees a stale per-issue worktree lock left by a crashed run. Previews by
  default; `--yes` releases. A missing lock is a safe no-op; a live (non-stale)
  lock is refused unless `--force`, since releasing it could let two runs touch
  the same worktree. The worktree itself is untouched.
- `admin worktree discard --session-id <id> --issue-number <n>` resets a dirty
  per-issue worktree to the branch tip (`git reset --hard` + `git clean -fd`).
  Previews by default (shows tracked changes and untracked files that would be
  removed); `--yes` executes the discard. Refuses canonical/shared checkouts and
  non-managed worktrees. Refuses a live issue lock unless `--force` is given.
  Branches, PRs, task rows, and GitHub labels are never touched.
- Unknown flags on the cleanup commands fail fast (a typoed `--force`/`--yes`
  never silently falls through to a destructive default). Worktree paths are
  local-only and never published to public comments.
- Disk-usage policy: operators prune terminal/stale worktrees individually with
  `prune` or in bulk with `cleanup`.

## Compatibility

- **Unconditional** (issue #731): every session runs every repo-working phase
  in its per-issue worktree. There is no `worktrees.enabled` config, and no
  shared-checkout execution mode to opt into; see
  [docs/worktree-only-migration-contract.md](worktree-only-migration-contract.md)
  for the migration history.
- **Task context** records `worktreeId` / `worktreePath`.
- **PR/branch naming** is unchanged (`ai/issue-<n>`, PRs target the session base).
- **Artifacts** stay under the configured artifact root, never inside the
  worktree's committed source.
- **Public comments** never include local worktree paths: the outbox visibility
  layer redacts the worktree state root (in addition to `repoRoot` /
  `artifactRoot`) via `sessionRedactionPaths(session)`.

Cross-issue dependency stacking reads the blocker's **pushed branch** (fetched
into the canonical repo), not another issue's worktree, so stacking does not need
to reach into a sibling worktree.

## Scope of the first slice (this PR)

Landed:

- the path/identity + redaction helpers (`core/worktree-paths.ts`);
- the worktree manager + issue lock (`handlers/worktree.ts`);
- the `worktrees` session opt-in (config type + validation);
- worktree-root redaction wired into public outbox comments;
- `admin worktree list` / `admin worktree prune`;
- tests for: creating a worktree for a new issue, resuming an existing worktree,
  dirty-worktree isolation, lock behavior (same issue vs different issue),
  worktree-targeted resolution for a Tool Request, and public-comment redaction.

Deferred to follow-up issues (after design review, per the issue's own guidance):

- threading the issue worktree as the execution `cwd` through the
  implementation / review / conflict-resolution handlers (the existing handlers'
  shared-checkout choreography — dirty preflight, `checkout base`, contamination
  guard, quarantine, discard-to-base — is replaced by worktree-native setup);
- pointing `admin tool-request grant/resolve` and `manual-done` at the issue
  worktree;
- narrowing the session repo lock to registry-mutating operations and taking the
  issue lock around phase execution in the runner;
- bulk `prune --stale`/`--terminal` cleanup driven by PR/Issue terminal state.
