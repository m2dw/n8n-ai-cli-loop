# Parent/Child Workflow — Migration Guide & Smoke-Test Checklist

This document covers migrating from the **flat thin workflow**
(`docs/n8n-thin-self-driving-workflow.json`) to the **parent/child split**
(`docs/n8n-thin-child-workflow.json` + `docs/n8n-thin-parent-workflow.json`).

> **No live smoke test has been performed against a real n8n instance / GitHub
> repository for this document.** The checklist in [§ Smoke-Test
> Checklist](#smoke-test-checklist) is a **manual checklist** — work through it
> step by step and record the results yourself before enabling the schedule
> trigger.

---

## Table of Contents

1. [What Changed](#what-changed)
2. [Why Migrate](#why-migrate)
3. [Prerequisites](#prerequisites)
4. [Build and Import](#build-and-import)
5. [Configure sessions.json](#configure-sessionsjson)
6. [Run the Parent Workflow](#run-the-parent-workflow)
7. [Expected JSON Outputs](#expected-json-outputs)
8. [Inspecting State After a Run](#inspecting-state-after-a-run)
9. [Smoke-Test Checklist](#smoke-test-checklist)
10. [Known MVP Limitations](#known-mvp-limitations)
11. [Next Steps](#next-steps)

---

## What Changed

The flat thin workflow ran intake, phase execution, and outbox dispatch inside a
single n8n workflow as a linear chain:

```
[Manual Trigger] ──┐
                    ├──► [Config] ──► [GitHub Intake] ──► [Run One Phase] ──► [Dispatch Outbox]
[Schedule Trigger] ─┘
```

The parent/child split moves the three Execute Command nodes into a **child
workflow** and keeps only the triggers and the Config node in a **parent
workflow**:

```
Parent: [Manual Trigger] ──┐
        [Schedule Trigger] ─┴──► [Config] ──► [Create Context] ──► [Call Phase Runner]
                                                                             │
                                                                   executes child workflow
                                                                             │
Child:  [When Called by Parent] ──► [GitHub Intake] ──► [Run One Phase] ──► [Dispatch Outbox] ──► [Return Context]
```

The parent creates a context record (via the **Create Context** node) and passes
only `contextId` to the child trigger. `contextId` is parsed from the Create
Context stdout (`{"ok":true,"contextId":"<id>"}`). The child reads `contextId`
from `$("When Called by Parent")` — the named node reference avoids the `$json`
overwrite problem (after each Execute Command node, `$json` contains that
command's stdout, not the original trigger payload). All three child CLI nodes
use only `--context-id`; they resolve `sessionId` from the context store
internally, so `sessionId` never crosses the workflow boundary.

### Node inventory

| Workflow | Nodes |
|---|---|
| **Parent** | Manual Trigger, Schedule Trigger, Config (Set), Create Context (Execute Command), Call Phase Runner (Execute Workflow) |
| **Child** | When Called by Parent (Execute Workflow Trigger), GitHub Intake, Run One Phase, Dispatch Outbox, Return Context (Set) |

---

## Why Migrate

| Reason | Detail |
|---|---|
| **Stable parent** | The parent workflow never needs reimporting when CLI logic changes. Only the child changes when the three command strings evolve. |
| **Isolated runId scope** | The child inlines `$execution.id` directly in the `run-one-phase` command expression. Each child execution has a clean, independent run ID that is not shared with the parent. |
| **Easier n8n canvas management** | The Config node in the parent remains a single editable location for the session ID, separate from the execution nodes. |

---

## Prerequisites

### System tools

| Tool | Purpose | Check |
|---|---|---|
| `node` ≥ 20 | Run compiled CLI entrypoints | `node --version` |
| `npm` | Build TypeScript | `npm --version` |
| `git` | Implementation handler branch/commit | `git --version` |
| `gh` | GitHub API — issue scan, PR creation, comments/labels | `gh --version && gh auth status` |
| `claude` | Implementation handler (Claude Code CLI) | `claude --version` |
| `codex` | Review handler (Codex CLI) | `codex --version` |
| `agy` / `$ANTIGRAVITY_BIN` | Research handler | `agy --version` or `echo $ANTIGRAVITY_BIN` |

> If you only use a subset of phases (e.g. `--supported-phases research`),
> only the corresponding agent CLI needs to be present.

### GitHub CLI authentication

```sh
gh auth login          # authenticate once
gh auth status         # verify
```

`gh` must be authenticated for the GitHub owner/repo referenced in
`sessions.json`.

### n8n instance

```sh
n8n start              # default port 5678
```

A single-instance n8n with the default in-process executor is sufficient for
the parent/child workflow.

### Build the TypeScript library

```sh
cd /path/to/n8n-ai-cli-loop
npm install
npm run build          # compiles TS + regenerates all workflow JSONs
```

The compiled CLI entrypoints land in `dist/cli/`.

---

## Build and Import

### 1 — Regenerate (optional, already done by `npm run build`)

```sh
npm run build:parent-child-workflow
# Writes TWO copies of each workflow (issue #391):
#
#   docs/n8n-thin-parent-workflow.json            ← tracked template (canonical CLI path)
#   docs/n8n-thin-child-workflow.json             ← tracked template (canonical CLI path)
#   .n8n-artifacts/workflows/n8n-thin-parent-workflow.json   ← local, baked with your CLI_BASE
#   .n8n-artifacts/workflows/n8n-thin-child-workflow.json    ← local, baked with your CLI_BASE
```

> **Which files do I import?** For a local deployment, import the copies under
> **`.n8n-artifacts/workflows/`** — they carry the correct `dist/cli` path for
> your tree. The `docs/` copies are a tracked, environment-independent template
> (baked with the canonical `/opt/n8n-ai-cli-loop/dist/cli` placeholder) kept for
> review and onboarding; importing them directly requires editing the CLI path in
> each Execute Command node afterwards. `.n8n-artifacts/` is gitignored, so the
> local build never dirties tracked files.

### 2 — Import order: child first

> **Important**: the child workflow must be imported before the parent.
> The parent's **Call Phase Runner** node references the child by its stable
> string ID (`ai-dev-loop-thin-phase-runner`). If the parent is imported first,
> n8n cannot resolve the child ID.

1. Open the n8n UI.
2. Go to **Workflows → Import from file**.
3. Select your child workflow — for a local deployment
   **`.n8n-artifacts/workflows/n8n-thin-child-workflow.json`**, or the tracked
   template **`docs/n8n-thin-child-workflow.json`**  
   (workflow ID: `ai-dev-loop-thin-phase-runner`).
4. Save the child workflow.
5. Import the matching parent workflow —
   **`.n8n-artifacts/workflows/n8n-thin-parent-workflow.json`** (local) or
   **`docs/n8n-thin-parent-workflow.json`** (template)  
   (workflow ID: `ai-dev-loop-thin-parent`).
6. Save the parent workflow. Do **not** activate the Schedule Trigger yet.

### 3 — Edit the Config node in the parent

After import, open the **Config** node in the **parent** workflow and set
**`sessionRef`** to a value that identifies your `sessions.json` entry.

| Field | Default | Description |
|---|---|---|
| `sessionRef` | `ai-cli-loop` | **Editable — a short session reference: a `sessionId`, a numeric `sessionNo`, or an `alias`** |
| `repoKeyReference` | `(resolved from sessions.json by sessionId)` | Read-only hint |
| `repoRootReference` | `(resolved from sessions.json by sessionId)` | Read-only hint |
| `githubRepoReference` | `(resolved from sessions.json by sessionId)` | Read-only hint |

#### Session reference vs. canonical identifiers

The Config node holds a **`sessionRef`**, not the canonical `sessionId`. This
keeps n8n tags / Config values compact while the system still stores and reports
the canonical identifier everywhere it matters. Three identifiers are involved:

| Identifier | Role | Example | Where it lives |
|---|---|---|---|
| **`sessionRef`** | Short, operator-facing reference passed into the workflow | `2`, `addon`, `tar` | n8n tag / parent Config |
| **`sessionId`** | Canonical internal identifier | `thunderbird-auth-results` | DB state, context records, task rows, lock files, artifacts, diagnostics |
| **`repoKey`** | Repository identity | `thunderbird-auth-results-filter` | `sessions.json` |

The **Create Context** node runs `admin.js context create --json --execution-id
<id> --session-ref <ref>`, which resolves `sessionRef` to the canonical `sessionId`
(via exact `sessionId`, numeric `sessionNo`, or string alias) and persists the
**`sessionId`** into the context store. Resolution fails closed: an unknown or
ambiguous reference aborts the run with a clear error. The child workflow still
receives only `--context-id`, so neither `sessionRef` nor `sessionId` crosses the
workflow boundary.

`admin.js context create` also still accepts `--session-id <id>` directly for
backward compatibility, as do `task-status`, `session-doctor`, `repo-lock
status`, and `recover` (each gains a `--session-ref` alternative).

The workflow nodes that parse `admin.js` stdout (`context create`, `repo-lock
acquire`, `repo-lock release`) pass `--json` explicitly. These commands already
default to JSON, but the explicit flag follows the CLI output contract (see
[`admin-cli-contract.md`](./admin-cli-contract.md)) and keeps the downstream
`JSON.parse()` stable even if a command's default output mode changes later.

> **Do not edit the child workflow's nodes directly.** The CLI path and
> supported phases are generator-time constants baked into the Execute Command
> expressions.
>
> `CLI_BASE` controls which `dist/cli` directory the Execute Command nodes in the
> **local** artifacts (`.n8n-artifacts/workflows/`) invoke.  If `CLI_BASE` is not
> set, the build defaults to `$PWD/dist/cli`.  **Run the build from the tree n8n
> should execute** so the baked-in path points at the correct installation:
>
> ```sh
> # Run from the deployment tree (e.g. ~/n8n/n8n-ai-cli-loop):
> npm run build:parent-child-workflow
> # → bakes ~/n8n/n8n-ai-cli-loop/dist/cli into .n8n-artifacts/workflows/
>
> # Or set CLI_BASE explicitly:
> CLI_BASE=/your/path/dist/cli npm run build:parent-child-workflow
> ```
>
> `CLI_BASE` never affects the tracked `docs/` template, which is always baked
> with the canonical `/opt/n8n-ai-cli-loop/dist/cli` path so the committed JSON
> stays stable and environment-independent (issue #391).
>
> `SESSION_REF` (or the legacy `SESSION_ID` fallback) only controls the
> **initial value** shown in the Config node's `sessionRef` field.
> Edit it in the n8n UI after import; it is not required at build time.

---

## Configure sessions.json

Default location: `~/.config/n8n-ai-cli-loop/sessions.json`

```json
{
  "sessions": [
    {
      "sessionId": "ai-cli-loop",
      "sessionNo": 2,
      "aliases": ["addon", "tar"],
      "repoKey": "thunderbird-auth-results-filter",
      "repoRoot": "/Users/you/git/thunderbird-auth-results-filter",
      "githubRepo": "m2dw/thunderbird-auth-results-filter",
      "artifactDir": ".n8n-artifacts",
      "defaults": {
        "implementationAgent": "claude",
        "reviewAgent": "codex",
        "researchAgent": "gemini"
      },
      "verification": {
        "test": "npm test",
        "package": "npm run package"
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

The `sessions.json` format is identical to the flat thin workflow. No changes
are needed if you already have it configured for the thin workflow.

`sessionNo` and `aliases` are **optional** short references that let the parent
Config / n8n tags use a compact value (e.g. `2` or `addon`) instead of the full
`sessionId`. Each must be unique across the registry: a `sessionNo` must not
clash with another session's `sessionNo`, an `alias` must not clash with another
session's `alias`, `sessionId`, or numeric `sessionNo`. A duplicate or colliding
reference makes resolution ambiguous and is rejected when the registry loads.

### SQLite DB default path

`~/.config/n8n-ai-cli-loop/dev_loop.db`

The same database is used by both workflows. Migrating from thin to
parent/child does not require resetting the database.

---

## Run the Parent Workflow

### First run — manual trigger

1. In n8n, open the **parent** workflow.
2. Click **Execute Workflow** (manual trigger).
3. The parent's **Call Phase Runner** node invokes the child synchronously.
4. Observe each child node's output by clicking through the execution panel.
5. Check that no node exits with a non-zero code.

> **Tip**: GitHub Intake exits `0` even when there are no matching issues.
> Look at the `candidates` field in the child's output JSON to confirm it
> scanned.

### Enabling the schedule trigger

Only enable the Schedule Trigger **after** the manual smoke-test passes
(see [§ Smoke-Test Checklist](#smoke-test-checklist)). Activating the
parent workflow turns on the 5-minute Schedule Trigger.

---

## Expected JSON Outputs

The three child CLI commands produce the same JSON output format as the flat
thin workflow. See [docs/archive/minimal-self-driving.md](archive/minimal-self-driving.md) for
the full output reference. A brief summary:

### github-intake

```json
{
  "ok": true,
  "sessionId": "ai-cli-loop",
  "repo": "m2dw/thunderbird-auth-results-filter",
  "scanned": 15,
  "candidates": 3,
  "enqueued": 2,
  "alreadyExists": 1,
  "dryRun": false,
  "results": [
    { "issueNumber": 101, "action": "enqueued",       "phase": "implementation" },
    { "issueNumber": 102, "action": "already_exists", "phase": "review" },
    { "issueNumber": 103, "action": "enqueued",       "phase": "research" }
  ]
}
```

### run-one-phase (idle)

```json
{ "ok": true, "outcome": "idle", "sessionId": "ai-cli-loop", "supportedPhases": ["implementation", "review", "research"] }
```

### dispatch-outbox

```json
{ "ok": true, "dispatched": 0, "failed": 0, "errors": [], "sessionId": "ai-cli-loop" }
```

---

## Inspecting State After a Run

The SQLite database and artifact paths are the same as the flat thin workflow.

```sh
sqlite3 ~/.config/n8n-ai-cli-loop/dev_loop.db

-- Current task statuses
SELECT session_id, issue_number, status, phase, updated_at
FROM tasks
ORDER BY updated_at DESC;

-- Pending outbox entries
SELECT id, idempotency_key, topic, sent_at
FROM outbox
WHERE sent_at IS NULL
ORDER BY id;
```

See [docs/archive/minimal-self-driving.md](archive/minimal-self-driving.md) for the full
inspection reference including artifact paths.

---

## Smoke-Test Checklist

> ⚠️ **Manual checklist** — perform these steps by hand and record each result.

Use a **throwaway issue** in the target repo. Add a label that maps to the
`research` phase (`agent:gemini` + `status:research-needed`) so no code is
written or PR opened.

### Before you start

- [ ] `npm install && npm run build` exits 0
- [ ] `gh auth status` shows correct account and repo access
- [ ] `sessions.json` exists at `~/.config/n8n-ai-cli-loop/sessions.json`
- [ ] `repoRoot` in sessions.json points to a clean git checkout on `main`
- [ ] Research agent CLI is available (`agy --version` or `$ANTIGRAVITY_BIN`)
- [ ] n8n is running
- [ ] Child workflow is imported with ID `ai-dev-loop-thin-phase-runner`
- [ ] Parent workflow is imported with ID `ai-dev-loop-thin-parent`
- [ ] Parent workflow is **not** yet activated (Schedule Trigger off)

### Step 1 — Verify child workflow ID

In the n8n UI, open the child workflow and confirm its workflow ID is exactly
`ai-dev-loop-thin-phase-runner`. This is the stable ID the parent's Call Phase
Runner node resolves at runtime.

- [ ] Child workflow ID is `ai-dev-loop-thin-phase-runner`

### Step 2 — Verify parent's Call Phase Runner references child

In the n8n UI, open the parent workflow and click the **Call Phase Runner**
node. Confirm the **Workflow** field shows `ai-dev-loop-thin-phase-runner`.

- [ ] Call Phase Runner node references `ai-dev-loop-thin-phase-runner`

### Step 3 — Intake only (dry run via CLI)

```sh
node dist/cli/github-intake.js \
  --session-id ai-cli-loop \
  --supported-phases research \
  --dry-run
```

- [ ] Output `ok: true`
- [ ] Throwaway issue appears in `results` with `action: "dry_run"`
- [ ] `candidates >= 1`

### Step 4 — Enqueue manually

```sh
node dist/cli/enqueue-task.js \
  --session-id ai-cli-loop \
  --issue-number <N> \
  --phase research
```

- [ ] Output `ok: true, code: "enqueued"`

### Step 5 — Run one phase (CLI only, before n8n)

```sh
node dist/cli/run-one-phase.js \
  --session-id ai-cli-loop \
  --run-id smoke-test-parent-child-1 \
  --supported-phases research
```

- [ ] Output `ok: true, outcome: "completed", result: "success"`
- [ ] Artifact files exist in `<repoRoot>/.n8n-artifacts/runs/smoke-test-parent-child-1/`
  - [ ] `research-prompt.md`
  - [ ] `research-output.md`
  - [ ] `research-result.json`
- [ ] Task status in SQLite is `ready_for_human`

### Step 6 — Dispatch outbox (CLI only)

```sh
node dist/cli/dispatch-outbox.js --session-id ai-cli-loop
```

- [ ] Output `ok: true, dispatched >= 1, failed: 0`
- [ ] GitHub issue label changed to `ai:ready-for-human`
- [ ] Bot comment posted on GitHub issue: `🔬 **Research complete** for issue #…`
- [ ] `sqlite3 ... "SELECT * FROM outbox WHERE sent_at IS NULL"` returns empty

### Step 7 — Full parent/child workflow via n8n manual trigger

1. [ ] Click **Execute Workflow** in the **parent** workflow (n8n UI)
2. [ ] Parent's Call Phase Runner node shows green (child executed)
3. [ ] Child's GitHub Intake: `ok: true` in stdout
4. [ ] Child's Run One Phase: `ok: true, outcome: "idle"` (queue already drained) — expected
5. [ ] Child's Dispatch Outbox: `ok: true, dispatched: 0` — expected (already sent)

### Step 8 — Activate schedule trigger

Only after all checklist items above pass:

- [ ] Enable the parent workflow in n8n (activates the Schedule Trigger)
- [ ] Wait one 5-minute cycle; confirm n8n execution history shows green

---

## Known MVP Limitations

These are **expected MVP stops**, not bugs. They are identical to the flat thin
workflow limitations.

| Limitation | Observable symptom |
|---|---|
| **`conflict` escalates to human** | Task ends in `ready_for_human`; `review-result.json` shows `classification: "conflict"` |
| **`conflict_resolution` phase not handled** | `outcome: "phase_missing"`, task → `ready_for_human` |
| **Only one phase per execution** | Queue drains one task at a time (by design) |
| **Quota / rate-limit retry is manual** | `dispatch-outbox` returns `failed > 0`; entries stay in outbox |

### How to tell an MVP stop from a real failure

| Signal | MVP stop | Real failure |
|---|---|---|
| `run-one-phase` output | `ok: true`, `outcome: "completed"`, `result: "blocked"` or `"success"` | `ok: false` or `result: "failed"` |
| Task status in SQLite | `ready_for_human` | `failed` |
| `dispatch-outbox` output | `ok: true` (even with `failed > 0`) | `ok: false` |

---

## Next Steps

| Issue / feature | What it enables |
|---|---|
| `conflict_resolution` handler | Automated PR conflict resolution |
| Automatic dispatch retry with backoff | No manual re-trigger after GitHub rate limits |
| Multi-phase-per-execution loop | Drain the full queue in one n8n execution |
| n8n webhook trigger for label events | Real-time reaction instead of polling |

See [docs/future-architecture.md](future-architecture.md) for broader
architectural notes.
