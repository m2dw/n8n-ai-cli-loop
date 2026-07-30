# Installation and Setup Guide

This guide takes you from a fresh checkout through a successful first run.
Complete each step in order; the smoke-test at the end verifies the whole stack.

---

## Contents

1. [Security posture — read this first](#1-security-posture--read-this-first)
2. [Prerequisites](#2-prerequisites)
3. [Install the control-plane repository](#3-install-the-control-plane-repository)
4. [Deployment tree vs development tree](#4-deployment-tree-vs-development-tree)
5. [Prepare the target repository](#5-prepare-the-target-repository)
6. [Configure sessions.json](#6-configure-sessionsjson)
7. [Generate and import the n8n workflows](#7-generate-and-import-the-n8n-workflows)
8. [Configure the parent workflow](#8-configure-the-parent-workflow)
9. [Optional: custom worktree root](#9-optional-custom-worktree-root)
10. [Smoke-test checklist](#10-smoke-test-checklist)
11. [Basic operations](#11-basic-operations)

---

## 1. Security posture — read this first

`n8n-ai-cli-loop` is designed for **private/internal AI automation control
planes**. The GitHub repository that holds your issues, planning artifacts, Tool
Requests, and run metadata **must be private** (or a genuinely access-controlled
internal system).

**Do not** use public GitHub Issues as the primary orchestration surface for AI
planning, Tool Requests, or run metadata. Public repositories that an agent
files PRs against receive only normal, user-facing pull requests — internal
orchestration state must never appear there.

External user input must pass through a human review step before being written
into a control-plane issue. The workflow is not designed for direct external
access.

For the full security model see [`docs/private-control-plane-security.md`](private-control-plane-security.md).

---

## 2. Prerequisites

Verify each tool before continuing.

### System tools

| Tool | Minimum version | Check |
|---|---|---|
| `node` | 20 | `node --version` |
| `npm` | (bundled with Node 20) | `npm --version` |
| `git` | any recent | `git --version` |
| `gh` (GitHub CLI) | any recent | `gh --version` |

### Agent CLIs

Install only the agents you plan to use. Each lane requires the matching binary:

| Agent | Binary | Lane |
|---|---|---|
| Claude Code | `claude` | `agent:claude` implementation and fix |
| Codex CLI | `codex` | `agent:codex` review |
| Antigravity / Gemini | `agy` (or set `ANTIGRAVITY_BIN`) | `agent:gemini` research |

At least one agent CLI must be present to run a meaningful smoke test.

### GitHub CLI authentication

```sh
gh auth login          # authenticate once
gh auth status         # confirm account and repo access
```

`gh` must be authenticated for the GitHub owner/repo you will set as
`githubRepo` in `sessions.json`.

### n8n

A local single-instance n8n is sufficient:

```sh
npm install -g n8n     # if not already installed
n8n start              # default port 5678, runs in the foreground
```

---

## 3. Install the control-plane repository

Clone and build:

```sh
git clone https://github.com/m2dw/n8n-ai-cli-loop.git
cd n8n-ai-cli-loop
npm install
npm run build
```

`npm run build` compiles the TypeScript library (`dist/`) **and** regenerates the
workflow JSON files. The compiled CLI entrypoints land in `dist/cli/`.

Verify the build:

```sh
node dist/cli/run-one-phase.js --help
```

---

## 4. Deployment tree vs development tree

The build writes two copies of each workflow JSON:

| Location | Purpose | CLI path baked in |
|---|---|---|
| `docs/n8n-thin-child-workflow.json` | **Tracked template** — commit-safe, environment-independent | `/opt/n8n-ai-cli-loop/dist/cli` (placeholder) |
| `docs/n8n-thin-parent-workflow.json` | **Tracked template** | same placeholder |
| `.n8n-artifacts/workflows/n8n-thin-child-workflow.json` | **Local deployment artifact** — gitignored | your machine's resolved path |
| `.n8n-artifacts/workflows/n8n-thin-parent-workflow.json` | **Local deployment artifact** | same |

**Always import the files under `.n8n-artifacts/workflows/`** for a local
deployment. They contain the correct `dist/cli` path for your checkout.
The `docs/` copies are for review and onboarding only — importing them requires
manually editing the CLI path in each Execute Command node.

If n8n runs from a different directory or machine, set `CLI_BASE` before building:

```sh
CLI_BASE=/absolute/path/to/n8n-ai-cli-loop/dist/cli npm run build:parent-child-workflow
```

---

## 5. Prepare the target repository

The **target repository** is the GitHub repository an agent will file PRs
against — not the `n8n-ai-cli-loop` control-plane repo itself.

Requirements for the target repo:

1. **Clean main-branch checkout** at `repoRoot`. The implementation handler
   expects to branch from a clean state.

2. **`.n8n-artifacts/` in `.gitignore`**. Run artifacts, SQLite lock files, and
   local workflow artifacts are stored under `.n8n-artifacts/` inside the target
   repo and must never be committed:

   ```sh
   echo '.n8n-artifacts/' >> /path/to/target-repo/.gitignore
   git -C /path/to/target-repo add .gitignore
   git -C /path/to/target-repo commit -m "chore: gitignore n8n-ai-cli-loop artifacts"
   ```

3. **Required GitHub labels** exist in the repo (create them if missing):

   | Label | Purpose |
   |---|---|
   | `agent:claude` | Route to Claude Code |
   | `agent:codex` | Route to Codex CLI |
   | `agent:gemini` | Route to research agent |
   | `status:needs-implementation` | Implementation queue |
   | `status:needs-fix` | Fix queue |
   | `status:needs-review` | Review queue |
   | `status:research-needed` | Research queue |
   | `status:needs-conflict-resolution` | Conflict resolution queue |
   | `status:backlog` | Backlog promotion |
   | `ai:active` | Managed by automation |
   | `ai:blocked` | Automation blocked |
   | `ai:ready-for-human` | Awaiting human review |

---

## 6. Configure sessions.json

The default configuration path is `~/.config/n8n-ai-cli-loop/sessions.json`.
Create the directory if it does not exist:

```sh
mkdir -p ~/.config/n8n-ai-cli-loop
```

### Minimal sessions.json

```json
{
  "sessions": [
    {
      "sessionId": "my-project",
      "repoKey": "my-project",
      "repoRoot": "/absolute/path/to/target-repo",
      "githubRepo": "owner/target-repo",
      "artifactDir": ".n8n-artifacts",
      "defaults": {
        "implementationAgent": "claude",
        "reviewAgent": "codex",
        "researchAgent": "gemini"
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

### Field reference

| Field | Required | Description |
|---|---|---|
| `sessionId` | ✓ | Canonical session identifier used in the DB, artifacts, and diagnostics |
| `repoKey` | ✓ | Short repository identity string |
| `repoRoot` | ✓ | Absolute path to the target repository on the local filesystem |
| `githubRepo` | ✓ | `owner/repo` — used for `gh` commands and issue scanning |
| `artifactDir` | ✓ | Artifact directory relative to `repoRoot` (use `.n8n-artifacts`) |
| `defaults.implementationAgent` | ✓ | `claude` / `codex` / `gemini` |
| `defaults.reviewAgent` | ✓ | `claude` / `codex` / `gemini` |
| `defaults.researchAgent` | ✓ | `claude` / `codex` / `gemini` |
| `verification.test` | | Shell command the review phase runs to verify the implementation |
| `verification.package` | | Shell command for packaging (optional) |
| `labels.active` | ✓ | Label applied while automation is running |
| `labels.blocked` | ✓ | Label applied when automation is blocked |
| `labels.readyForHuman` | ✓ | Label applied when an issue needs human attention |
| `sessionNo` | | Optional short numeric reference (e.g. `1`). Lets the n8n Config node use `1` instead of the full `sessionId` |
| `aliases` | | Optional string aliases (e.g. `["proj", "mp"]`). Same purpose as `sessionNo`. Each must be unique across the registry |
| `audit.acknowledge` | | Documented reasons for accepting a [`session-audit`](#loop-design-audit) finding, keyed by check id (e.g. `{"verification-commands": "docs-only repo"}`). Each reason must be a non-empty string |

#### SQLite database

The default database path is `~/.config/n8n-ai-cli-loop/dev_loop.db`. It is
created automatically on first use. Pass `--db-path` to any CLI command to
override.

### Verify sessions.json loads

```sh
node dist/cli/github-intake.js --session-id my-project --dry-run
```

A configuration error (unknown `sessionId`, malformed JSON, bad field) exits
with code 1 and a clear error message before any work runs.

---

## 7. Generate and import the n8n workflows

### Step 1 — Regenerate local artifacts (if needed)

`npm run build` already ran this. To re-run alone:

```sh
npm run build:parent-child-workflow
# Writes .n8n-artifacts/workflows/n8n-thin-child-workflow.json
# Writes .n8n-artifacts/workflows/n8n-thin-parent-workflow.json
```

### Step 2 — Import: child workflow first

> **Order matters.** The parent's **Call Phase Runner** node references the
> child by its stable string ID (`ai-dev-loop-thin-phase-runner`). Importing the
> parent first leaves that reference unresolvable.

1. Open the n8n UI (`http://localhost:5678` by default).
2. Go to **Workflows → Import from file**.
3. Select `.n8n-artifacts/workflows/n8n-thin-child-workflow.json`.
4. Save the workflow. Confirm its ID is `ai-dev-loop-thin-phase-runner`.

### Step 3 — Import: parent workflow

5. Import `.n8n-artifacts/workflows/n8n-thin-parent-workflow.json`.
6. Save the workflow. Confirm its ID is `ai-dev-loop-thin-parent`.
7. **Do not activate** the Schedule Trigger yet.

---

## 8. Configure the parent workflow

Open the **Config** (Set) node in the parent workflow and set **`sessionRef`**
to a value that identifies your session:

| Value type | Example | Resolves via |
|---|---|---|
| Full `sessionId` | `my-project` | exact match |
| Numeric `sessionNo` | `1` | session number |
| String alias | `proj` | alias list |

`sessionRef` is the only field you edit in the parent workflow. The Config node
resolves it to the canonical `sessionId` at runtime via `admin context create`
and stores the session identity internally — neither `sessionRef` nor
`sessionId` is embedded in the child workflow nodes.

> **Do not edit the child workflow nodes.** The CLI path and command expressions
> are generator-time constants. Re-run `npm run build:parent-child-workflow`
> (or `npm run build`) and re-import the child if you need to change them.

---

## 9. Optional: custom worktree root

Every session runs each work item in its own isolated per-issue git
checkout, so a failed run in one issue cannot dirty the state for another.
This is unconditional — there is no config to enable or disable it.

Worktrees are stored under `~/.local/state/n8n-ai-cli-loop/worktrees/` by
default. To use a different location for one session, add a `worktrees`
block with a `root` override in `sessions.json`:

```json
"worktrees": {
  "root": "/absolute/path"
}
```

For the full operational guide — including cleanup, lock release, and
recovery — see [`docs/worktree-rollout.md`](worktree-rollout.md).

---

## 10. Smoke-test checklist

> **Manual checklist.** Work through each step and record the result before
> activating the schedule trigger.

Use a **throwaway issue** in the target repo. Apply `agent:gemini` +
`status:research-needed` so no code is written or PR opened. Make sure the
research agent CLI is available.

### Before you start

- [ ] `npm install && npm run build` exits 0
- [ ] `gh auth status` shows the correct account and target-repo access
- [ ] `~/.config/n8n-ai-cli-loop/sessions.json` exists and validates (dry-run above passes)
- [ ] `repoRoot` in `sessions.json` points to a clean checkout on `main`
- [ ] `.n8n-artifacts/` is in `.gitignore` of the target repo
- [ ] Research agent CLI is available (`agy --version` or `echo $ANTIGRAVITY_BIN`)
- [ ] n8n is running
- [ ] Child workflow imported with ID `ai-dev-loop-thin-phase-runner`
- [ ] Parent workflow imported with ID `ai-dev-loop-thin-parent`
- [ ] Parent workflow **not yet activated** (Schedule Trigger off)

### Step 1 — Dry-run intake

```sh
node dist/cli/github-intake.js \
  --session-id my-project \
  --supported-phases research \
  --dry-run
```

- [ ] Output `"ok": true`
- [ ] Throwaway issue appears in `results` with `"action": "dry_run"`
- [ ] `candidates >= 1`

### Step 2 — Run real intake (no dry-run)

```sh
node dist/cli/github-intake.js \
  --session-id my-project \
  --supported-phases research
```

- [ ] Output `"ok": true`
- [ ] Throwaway issue appears in `results` with `"action": "enqueued"`
- [ ] `enqueued >= 1`

### Step 3 — Run one phase via CLI

```sh
node dist/cli/run-one-phase.js \
  --session-id my-project \
  --run-id smoke-test-1 \
  --supported-phases research
```

- [ ] Output `"ok": true, "outcome": "completed", "result": "success"`
- [ ] Artifact files created under `<repoRoot>/.n8n-artifacts/runs/smoke-test-1/`

### Step 4 — Dispatch outbox

```sh
node dist/cli/dispatch-outbox.js --session-id my-project
```

- [ ] Output `"ok": true, "dispatched" >= 1, "failed": 0`
- [ ] GitHub issue label changed to `ai:ready-for-human`
- [ ] Bot comment posted on the throwaway issue

### Step 5 — Full parent/child run via n8n

1. [ ] Open the **parent** workflow in the n8n UI.
2. [ ] Click **Execute Workflow** (manual trigger).
3. [ ] Parent's **Call Phase Runner** node shows green.
4. [ ] Child's **GitHub Intake**: `"ok": true`
5. [ ] Child's **Run One Phase**: `"ok": true, "outcome": "idle"` (queue already drained — expected)
6. [ ] Child's **Dispatch Outbox**: `"ok": true, "dispatched": 0` (already sent — expected)

### Step 6 — Activate the schedule trigger

Only after all items above pass:

- [ ] Enable the parent workflow in the n8n UI (activates the 5-minute Schedule Trigger)
- [ ] Wait one cycle; confirm the n8n execution history shows green

---

## 11. Basic operations

### Check session status

```sh
node dist/cli/admin.js status --session-id my-project
```

Shows every active task: runnable, blocked, waiting on Tool Request, failed,
capped, or needs human review. Append `--issue-number <N>` to inspect one issue.

### Interactive terminal UI

```sh
node dist/cli/admin.js ui
```

Lists active tasks across all sessions. Select a task to inspect it and run safe
recovery actions (recover, cap reset) with confirmation prompts.

### Session health check

```sh
node dist/cli/admin.js session-doctor --session-id my-project
```

Probes `gh` auth, `repoRoot` accessibility, `sessions.json` validity, database
state, and agent CLI availability. Reports each check as pass/fail with
remediation hints.

### Loop design audit

```sh
node dist/cli/admin.js session-audit --session-id my-project
```

Where `session-doctor` asks "can this machine run the loop?", `session-audit`
asks "is this session designed to run unattended?". It checks the required
work-item labels, artifact hygiene (`artifactDir` location and gitignore
status), verification commands, handoff notifications and their secret, the
worktree state root, environment-prepare / dependency-sync coherence with the
detected ecosystem, the circuit-breaker kill switch, explicit agent assignment
(every configured flow rule, not just the default flow — intake picks the flow
from the issue's labels), and whether work-item comments land on a public
tracker.

The required-label check is per session, not one fixed list: it covers the
literal routing labels intake matches (`status:needs-implementation`,
`status:content-needed`, `agent:*`, …) **plus** the effective names this session's
transitions actually write — the values of its `labels` block (`active`,
`blocked`, `readyForHuman` and any optional key such as `needsReview` or
`stackReady`), each falling back to its default (`status:stack-ready`,
`status:conflict-resolution-failed`, …) when unset. Renaming a label in the
session therefore moves the requirement to the new name rather than silently
certifying a tracker whose outbound writes will fail.

The two tracker checks (labels, visibility) work for both wired work-item
providers: a `github-issues` session is read with `gh label list` / `gh repo
view`, a `gitea-issues` session with the Gitea REST reads
`GET /repos/{owner}/{repo}[/labels]` (the API token is resolved from the session's
`auth.tokenEnv`). A tracker whose visibility cannot be established is reported as
a warning rather than assumed private — work-item comments carry internal detail,
so the audit never certifies that boundary it has not observed.

Both probes fail closed and fail fast. A label list that cannot be proved
complete (a repository with more labels than one request returns) is reported as
*unavailable* rather than as missing labels, and every tracker request is bounded
by a timeout plus a per-run budget, so an unresponsive instance ends the probe
with a warning instead of hanging the command. That budget is shared by the label
and visibility probes — one wall-clock bound per audit run, not one per probe —
and each request's own timeout is clamped to whatever is left of it, so a request
started late cannot run past the run-wide bound.

The audit is read-only: it never runs a project command (no test/build/install)
and never mutates GitHub, Gitea, or the SQLite store. Each finding is graded
`error` / `warning` / `suggestion` and carries a concrete remedy; the exit code
stays 0 and the overall `verdict` (`ready` / `needs-attention` / `not-ready`)
is reported in the output.

```sh
# Stable machine payload for automation:
node dist/cli/admin.js session-audit --session-id my-project --json

# Skip the read-only tracker probes (no gh / Gitea credentials on this host):
node dist/cli/admin.js session-audit --session-id my-project --offline
```

A deliberate deviation is recorded in the session rather than re-argued at every
run. Add the check's id to the session's `audit.acknowledge` block with the
reason:

```json
"audit": {
  "acknowledge": {
    "verification-commands": "documentation-only repository; nothing to run"
  }
}
```

An acknowledged finding is still listed — with its original severity and the
recorded reason — but no longer counts against the verdict. A key that names no
check suppresses nothing and is reported by the `audit-acknowledgements` check,
which is itself never acknowledgeable: it is the check that validates the block,
so accepting it would hide invalid keys rather than record a trade-off.

### Worktree cleanup (if worktrees are enabled)

```sh
# List all worktrees for the session:
node dist/cli/admin.js worktree list --session-id my-project

# Preview stale/done worktrees eligible for cleanup:
node dist/cli/admin.js worktree cleanup --session-id my-project

# Remove them:
node dist/cli/admin.js worktree cleanup --session-id my-project --yes
```

### Worktree recovery

```sh
# Read-only diagnosis of worktree drift:
node dist/cli/admin.js worktree recovery --session-id my-project

# Release a stale per-issue lock left by a crashed run:
node dist/cli/admin.js worktree release-lock --session-id my-project --issue-number <N> --yes
```

### More troubleshooting

For detailed CLI output formats, SQLite inspection queries, and artifact path
reference, see [`docs/archive/minimal-self-driving.md`](archive/minimal-self-driving.md).

For the end-to-end flow from writing an issue to a merged PR, see
[`docs/idea-to-implementation.md`](idea-to-implementation.md).

For admin CLI command reference, see [`docs/admin-cli-contract.md`](admin-cli-contract.md).
