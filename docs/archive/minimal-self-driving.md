# Minimal Self-Driving Loop — Operator Guide

> **Archived.** This document has been moved to `docs/archive/` because the
> flat thin workflow it describes has been superseded by the parent/child split.
> The current operator setup guide is
> [docs/parent-child-workflow.md](../parent-child-workflow.md), which covers
> the same prerequisites, import steps, sessions.json format, and smoke-test
> procedure for the current workflow.
>
> The content below remains useful as a detailed CLI output reference, SQLite
> inspection guide, and smoke-test record for the flat thin workflow model.

> **No live smoke test has been performed against a real n8n instance / GitHub
> repository for this document.** The checklist in [§ Smoke-Test
> Checklist](#smoke-test-checklist) is a **manual checklist** — work through it
> step by step and record the results yourself before enabling the schedule
> trigger.

---

## Table of Contents

1. [What the Minimal Loop Does](#what-the-minimal-loop-does)
2. [Prerequisites](#prerequisites)
3. [Build and Import](#build-and-import)
4. [Configure sessions.json](#configure-sessionsjson)
5. [Run the Workflow](#run-the-workflow)
6. [Expected JSON Outputs](#expected-json-outputs)
7. [Inspecting State After a Run](#inspecting-state-after-a-run)
8. [Smoke-Test Checklist](#smoke-test-checklist)
9. [Known MVP Limitations](#known-mvp-limitations)
10. [Next Steps](#next-steps)

---

## What the Minimal Loop Does

One n8n execution runs three Execute Command nodes in sequence:

```
[Manual Trigger] ──┐
                    ├──► [GitHub Intake] ──► [Run One Phase] ──► [Dispatch Outbox]
[Schedule Trigger] ─┘
```

| Step | CLI | Responsibility |
|---|---|---|
| **GitHub Intake** | `github-intake.js` | Scan GitHub for labelled issues; enqueue them into SQLite |
| **Run One Phase** | `run-one-phase.js` | Claim one task from the queue; run its phase handler |
| **Dispatch Outbox** | `dispatch-outbox.js` | Flush pending GitHub comments / label changes from SQLite |

Only **one task phase** executes per n8n trigger. Run the workflow repeatedly
(or let the schedule trigger fire) to process a backlog of tasks.

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

Start n8n with whatever port suits your setup:

```sh
n8n start              # default port 5678
# or
N8N_PORT=5679 n8n start
```

If you use a task broker / queue mode, ensure the worker and broker ports
match your n8n configuration. For the minimal loop a single-instance n8n
with the default in-process executor is sufficient.

### Target repository

Before pointing the loop at a repository, ensure `.n8n-artifacts/` is listed
in that repository's `.gitignore`:

```sh
echo '.n8n-artifacts/' >> /path/to/target-repo/.gitignore
git -C /path/to/target-repo add .gitignore && git -C /path/to/target-repo commit -m "chore: ignore .n8n-artifacts"
```

`.n8n-artifacts/` contains local-only operational data — prompts, agent output,
verification logs, and branch/PR context — that should never be committed or
posted publicly. An explicit `.gitignore` entry is the reliable safeguard,
especially when one n8n installation drives multiple repositories.

> If the target repository already ignores `.n8n-artifacts/`, skip this step.

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
# Writes a tracked template AND a local deployment copy of each workflow (issue #391):
#   docs/n8n-thin-parent-workflow.json                       ← tracked template (canonical CLI path)
#   docs/n8n-thin-child-workflow.json                        ← tracked template (canonical CLI path)
#   .n8n-artifacts/workflows/n8n-thin-parent-workflow.json   ← local, baked with your CLI_BASE (gitignored)
#   .n8n-artifacts/workflows/n8n-thin-child-workflow.json    ← local, baked with your CLI_BASE (gitignored)
```

### 2 — Import into n8n

For a local deployment, import the copies under **`.n8n-artifacts/workflows/`** —
they carry the correct `dist/cli` path for your tree. The `docs/` copies
(`docs/n8n-thin-child-workflow.json`, `docs/n8n-thin-parent-workflow.json`) are
the same structure with the canonical placeholder path, kept tracked for review
and onboarding; importing them directly means editing the CLI path afterwards.

Import order matters — child first so n8n registers its stable ID before the parent resolves it:

1. Open the n8n UI.
2. Go to **Workflows → Import from file**.
3. Select your child workflow — `.n8n-artifacts/workflows/n8n-thin-child-workflow.json`
   for a local deployment, or the tracked `docs/n8n-thin-child-workflow.json`
   template (workflow ID: `ai-dev-loop-thin-phase-runner`).
4. Save the child workflow.
5. Import the matching parent workflow —
   `.n8n-artifacts/workflows/n8n-thin-parent-workflow.json` (local) or
   `docs/n8n-thin-parent-workflow.json` (template)
   (workflow ID: `ai-dev-loop-thin-parent`).
6. Save the parent workflow (do **not** activate the Schedule Trigger yet).

### 3 — Edit the Config node

After import, open the **Config** node (the first node after both
triggers) and set **`sessionRef`** to match your `sessions.json` entry.
That is the only field the Execute Command nodes depend on at runtime.

| Field | Default | Description |
|---|---|---|
| `sessionRef` | `ai-cli-loop` | **Editable — must match your `sessions.json` entry (a `sessionId`, `sessionNo`, or alias)** |
| `repoKeyReference` | `(resolved from sessions.json by sessionRef)` | Read-only hint — not used by commands |
| `repoRootReference` | `(resolved from sessions.json by sessionRef)` | Read-only hint — not used by commands |
| `githubRepoReference` | `(resolved from sessions.json by sessionRef)` | Read-only hint — not used by commands |

> **Reference-only fields** (`repoKeyReference`, `repoRootReference`,
> `githubRepoReference`) are UI hints for the operator. They are not read by
> any Execute Command expression. Actual repo/session details are resolved at
> runtime by the TypeScript CLI from `sessions.json` using `sessionRef`.

The CLI base path and supported phases are **generator-time constants** baked
directly into the Execute Command strings. They are not editable fields in
the Config node.

`CLI_BASE` controls which `dist/cli` directory the Execute Command nodes invoke.
If `CLI_BASE` is not set, the build command defaults to `$PWD/dist/cli` — the
`dist/cli` directory inside whatever working directory the build is run from.
**Operators should run the build command from the tree n8n should execute**, so
the baked-in path points at the correct installation:

```sh
# Run from the deployment tree (e.g. ~/n8n/n8n-ai-cli-loop):
npm run build:parent-child-workflow
# → bakes in ~/n8n/n8n-ai-cli-loop/dist/cli

# Or set CLI_BASE explicitly to target a different tree:
CLI_BASE=/your/path/dist/cli npm run build:parent-child-workflow
```

`SESSION_REF` only controls the **initial value** shown in the Config node.
Edit it in the n8n UI after import; it is not required at build time.

---

## Configure sessions.json

Default location: `~/.config/n8n-ai-cli-loop/sessions.json`

```json
{
  "sessions": [
    {
      "sessionId": "ai-cli-loop",
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

Key fields:

| Field | Description |
|---|---|
| `sessionId` | Canonical session identifier; resolved from `sessionRef` in the n8n Config node |
| `repoRoot` | Absolute path to the **target** git repository; used as `cwd` |
| `githubRepo` | `owner/repo` for `gh` API calls |
| `artifactDir` | Relative to `repoRoot`; phase artifacts land here |
| `verification` | Commands run by the review handler before Codex review |
| `labels` | Coarse GitHub labels managed by the outbox dispatcher |

### SQLite DB default path

`~/.config/n8n-ai-cli-loop/dev_loop.db`

Both `run-one-phase` and `dispatch-outbox` default to this path. Override
with `--db-path /custom/path.db` on all three CLIs if needed (use the same
path for all three within one session).

---

## Run the Workflow

### First run — manual trigger

1. In n8n, open the **parent** workflow.
2. Click **Execute Workflow** (manual trigger).
3. The parent execution shows four nodes: Create Context, Acquire, Call Child, Release.
4. Open the **child** execution that was triggered (visible in n8n Executions list or via the Call Child node output) to see the three CLI nodes: GitHub Intake, Run One Phase, and Dispatch Outbox.
5. Check that no CLI node in the child execution exits with a non-zero code.

> **Tip**: GitHub Intake exits `0` even when there are no matching issues.
> Look at the `candidates` field in the child execution's output JSON to confirm it scanned.

### Enabling the schedule trigger

Only enable the Schedule Trigger **after** the manual smoke-test passes
(see [§ Smoke-Test Checklist](#smoke-test-checklist)). Activating the
workflow turns on the 5-minute Schedule Trigger.

---

## Expected JSON Outputs

Each node writes one JSON object to stdout. n8n shows these in the Execute
Command node's `Stdout` output field.

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
    { "issueNumber": 101, "action": "enqueued",      "phase": "implementation" },
    { "issueNumber": 102, "action": "already_exists", "phase": "review" },
    { "issueNumber": 103, "action": "enqueued",      "phase": "research" }
  ]
}
```

`candidates: 0` means no open issues carry the expected labels — expected
when the queue is empty or no issues are labelled.

### run-one-phase

**Idle** (no queued tasks matching `--supported-phases`):

```json
{ "ok": true, "outcome": "idle", "sessionId": "ai-cli-loop", "supportedPhases": ["implementation", "review", "research"] }
```

**Completed** (handler ran successfully):

```json
{
  "ok": true,
  "outcome": "completed",
  "sessionId": "ai-cli-loop",
  "task": { "issueNumber": 101, "status": "queued", "phase": "review" },
  "result": "success"
}
```

Note: after `implementation` success the task transitions to `queued` for
the `review` phase, so `status: "queued"` in the output is normal.

**Phase missing** (no handler registered for this phase — escalated to human):

```json
{
  "ok": true,
  "outcome": "phase_missing",
  "task": { "issueNumber": 101, "status": "ready_for_human", "phase": "conflict_resolution" }
}
```

**Delayed** (agent hit a quota / rate-limit — temporary, retried after a delay):

```json
{
  "ok": true,
  "outcome": "delayed",
  "task": { "issueNumber": 101, "status": "queued", "phase": "implementation" },
  "notBefore": "2026-06-21T15:00:00.000Z"
}
```

When an agent CLI fails because a usage/quota/rate-limit window is exhausted
(detected from its stdout/stderr), the phase is **not** failed. The task is
released back to `queued` with a `notBefore` timestamp and `run-one-phase`
exits 0 with `outcome: "delayed"`, so n8n does not treat a temporary quota
window as a workflow crash. `claimNextTask` ignores the task until
`now >= notBefore`; the normal schedule then picks it up once the quota window
has likely reset. The default delay is 5 hours, configurable via
`QUOTA_RETRY_DELAY_MS` (or `QUOTA_RETRY_DELAY_HOURS`). SQLite is the source of
truth for this timing — it is never encoded in GitHub labels. The original
agent output artifact is preserved for diagnosis, and a `phase.delayed` event
is appended to the task event log.

A concise, public-safe status comment is also queued through the outbox so the
delay is visible on the work item without an operator checking the local DB. It
names the affected phase, the agent, and the absolute expected retry time (UTC),
but never the raw agent output, the matched quota signal, or any local path. The
comment is idempotent on the retry deadline (`notBefore`), so a delay that stays
active across scheduler ticks is not re-commented; a later attempt that hits
quota again and computes a new retry time posts a fresh comment.

### dispatch-outbox

**Nothing pending**:

```json
{ "ok": true, "dispatched": 0, "failed": 0, "errors": [], "sessionId": "ai-cli-loop" }
```

**Successful dispatch**:

```json
{ "ok": true, "dispatched": 3, "failed": 0, "errors": [], "sessionId": "ai-cli-loop" }
```

**Retryable GitHub failure** (exits `0` — entries stay pending for next run):

```json
{
  "ok": true,
  "dispatched": 2,
  "failed": 1,
  "errors": [{ "id": 7, "error": "gh api comment failed (exit 1): ..." }],
  "sessionId": "ai-cli-loop"
}
```

A `failed > 0` result with `ok: true` means GitHub was unreachable or
rate-limited. The entries stay in the outbox and will be retried on the
next trigger.

---

## Inspecting State After a Run

### SQLite DB

```sh
sqlite3 ~/.config/n8n-ai-cli-loop/dev_loop.db

-- Current task statuses
SELECT session_id, issue_number, status, phase, updated_at
FROM tasks
ORDER BY updated_at DESC;

-- Pending outbox entries (not yet dispatched to GitHub)
SELECT id, idempotency_key, topic, sent_at
FROM outbox
WHERE sent_at IS NULL
ORDER BY id;

-- Task event log
SELECT session_id, issue_number, type, message, created_at
FROM events
ORDER BY id DESC
LIMIT 20;
```

### Artifacts

> **Privacy reminder:** artifact files are local-only. They may contain
> prompts, agent output, and verification logs. Do not commit, push, or paste
> their raw content (especially absolute paths) into GitHub comments.
> Summarize findings in plain text when you need to share them.

Each phase run writes files under `<repoRoot>/<artifactDir>/runs/<run-id>/`:

| File | Phase | Content |
|---|---|---|
| `research-prompt.md` | research | Prompt sent to research agent |
| `research-output.md` | research | Raw agent output |
| `research-result.json` | research | Structured result |
| `implementation-prompt.md` | implementation | Prompt sent to Claude |
| `implementation-output.md` | implementation | Claude stdout |
| `implementation-result.json` | implementation | Structured result (incl. `prUrl`, `branch`) |
| `review-context.json` | review | PR/branch context snapshot |
| `review-verification-<name>.log` | review | Verification command output |
| `review-output.md` | review | Raw Codex review output |
| `review-result.json` | review | Classification: `success` / `needs_fix` / `conflict` / `blocked` |

### GitHub issue / PR

After `dispatch-outbox` fires:

- **Label**: the issue label should have changed to one of `ai:active`,
  `ai:blocked`, or `ai:ready-for-human` depending on the task's new status.
  Label side effects are emitted for every phase.
- **Comment**: a bot comment is posted for `implementation` and `review`
  phases (success, failure, or escalation notice). The `research` phase does
  **not** generate a bot comment — only label changes are emitted. Missing
  comments after a research run are expected, not a failure.

If the label / comment did not appear, check the pending outbox:

```sh
sqlite3 ~/.config/n8n-ai-cli-loop/dev_loop.db \
  "SELECT id, topic, payload FROM outbox WHERE sent_at IS NULL"
```

Then manually re-run dispatch-outbox:

```sh
node /path/to/dist/cli/dispatch-outbox.js --session-id ai-cli-loop
```

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
- [ ] Target repo `.gitignore` contains `.n8n-artifacts/`
- [ ] Research agent CLI is available (`agy --version` or `$ANTIGRAVITY_BIN`)
- [ ] n8n is running and the thin workflow is imported (not yet activated)

### Step 1 — Intake only (dry run)

```sh
node dist/cli/github-intake.js \
  --session-id ai-cli-loop \
  --supported-phases research \
  --dry-run
```

- [ ] Output `ok: true`
- [ ] Throwaway issue appears in `results` with `action: "dry_run"` (not `"candidate"`)
- [ ] `candidates >= 1`

### Step 2 — Enqueue manually

```sh
node dist/cli/enqueue-task.js \
  --session-id ai-cli-loop \
  --issue-number <N> \
  --phase research
```

- [ ] Output `ok: true, code: "enqueued"`

### Step 3 — Run one phase

```sh
node dist/cli/run-one-phase.js \
  --session-id ai-cli-loop \
  --run-id smoke-test-1 \
  --supported-phases research
```

- [ ] Output `ok: true, outcome: "completed", result: "success"`
- [ ] Artifact files exist in `<repoRoot>/.n8n-artifacts/runs/smoke-test-1/`
  - [ ] `research-prompt.md`
  - [ ] `research-output.md`
  - [ ] `research-result.json`
- [ ] Task status in SQLite is `ready_for_human`

### Step 4 — Dispatch outbox

```sh
node dist/cli/dispatch-outbox.js --session-id ai-cli-loop
```

- [ ] Output `ok: true, dispatched >= 1, failed: 0`
- [ ] GitHub issue label changed to `ai:ready-for-human`
  - ⚠️ **No bot comment is expected for `research` phase** — only label effects
    are enqueued. Missing comment here is expected, not a failure.
- [ ] `sqlite3 ... "SELECT * FROM outbox WHERE sent_at IS NULL"` returns empty

### Step 5 — Full workflow via n8n manual trigger

1. [ ] Click **Execute Workflow** in the **parent** workflow in n8n
2. [ ] Parent execution nodes (Create Context, Acquire, Call Child, Release) all show green
3. [ ] Open the **child** execution from the Executions list (triggered by Call Child)
4. [ ] All three CLI nodes in the child execution show green (exit 0)
5. [ ] GitHub Intake (child): `ok: true` in stdout
6. [ ] Run One Phase (child): `ok: true, outcome: "idle"` (queue already drained) — expected
7. [ ] Dispatch Outbox (child): `ok: true, dispatched: 0` — expected (already sent)

### Activate schedule trigger

Only after all checklist items above pass:

- [ ] Enable the workflow in n8n (activates the Schedule Trigger)
- [ ] Wait one 5-minute cycle; confirm n8n execution history shows green

---

## Known MVP Limitations

These are **expected MVP stops**, not bugs. A task reaching one of these
states is working as designed.

| Limitation | Observable symptom | Tracking |
|---|---|---|
| **`conflict` escalates to human** | Task ends in `ready_for_human`; `review-result.json` shows `classification: "conflict"` | Conflict handling is not yet automated. Human must resolve the merge conflict and re-trigger. |
| **`conflict_resolution` phase not handled** | `outcome: "phase_missing"`, task → `ready_for_human` | Handler not implemented. Human must resolve manually. |
| **Only one phase per execution** | Queue drains one task at a time | By design. Run multiple executions (or trigger repeatedly) to drain a backlog. |
| **Quota / rate-limit retry is manual** | `dispatch-outbox` returns `failed > 0`; entries stay in outbox | Re-trigger dispatch-outbox or wait for next schedule cycle. Automatic backoff is future work. |

### How to tell an MVP stop from a real failure

| Signal | MVP stop | Real failure |
|---|---|---|
| `run-one-phase` output | `ok: true`, `outcome: "completed"`, `result: "blocked"` or `"success"` | `ok: false` or `ok: true, outcome: "completed", result: "failed"` |
| Task status in SQLite | `ready_for_human` | `failed` |
| `dispatch-outbox` output | `ok: true` (even with `failed > 0`) | `ok: false` |
| Artifact `review-result.json` | `classification: "conflict"` → expected escalation; `classification: "needs_fix"` → auto-requeue to fix mode | `success: false, step: "codex-review"` → Codex process itself failed |

---

## Next Steps

For the full idea → PR lifecycle walkthrough — issue authoring, label gate
rules, the fix/review cycle, SQLite inspection commands, and when to intervene
manually — see [docs/idea-to-implementation.md](../idea-to-implementation.md).

| Issue / feature | What it enables |
|---|---|
| `conflict_resolution` handler | Automated PR conflict resolution |
| Automatic dispatch retry with backoff | No manual re-trigger needed after GitHub rate limits |
| Multi-phase-per-execution loop | Drain the full queue in one n8n execution |
| n8n webhook trigger for label events | Real-time reaction to GitHub label changes instead of polling |

See [docs/future-architecture.md](../future-architecture.md) for broader
architectural notes.
