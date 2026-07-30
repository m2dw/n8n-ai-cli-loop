# Content Workflow — Operator Guide and Human-Ready Handoff

This document is the operator-facing companion to the content MVP contracts.
It walks through the complete content lifecycle that is driven by the AI dev
loop — from writing a content Issue to reading a reviewed local draft and
deciding what to do with it. It does not redefine any contract; where a
guarantee is described here, the authoritative source is one of:

- [docs/content-research-mvp-contract.md](content-research-mvp-contract.md)
- [docs/content-draft-mvp-contract.md](content-draft-mvp-contract.md)
- [docs/content-review-mvp-contract.md](content-review-mvp-contract.md)

If anything here appears to conflict with one of those contracts, the
contract wins.

> **This is a documentation-only guide.** The content workflow does not
> publish, export, or commit anything. Every export, formatting, and
> publication decision remains a manual, human-controlled action outside this
> automation. See [Human Actions at the Handoff](#human-actions-at-the-handoff)
> below.

---

## Table of Contents

1. [Workflow Overview](#workflow-overview)
2. [Step 1 — Write a Content Issue](#step-1--write-a-content-issue)
3. [Step 2 — Apply Labels](#step-2--apply-labels)
4. [Step 3 — Automation Picks It Up](#step-3--automation-picks-it-up)
5. [Step 4 — Content Research Phase](#step-4--content-research-phase)
6. [Step 5 — Content Draft Phase](#step-5--content-draft-phase)
7. [Step 6 — Content Review Phase](#step-6--content-review-phase)
8. [Step 7 — Ready for Human](#step-7--ready-for-human)
9. [Locating Local Artifacts](#locating-local-artifacts)
10. [Human Actions at the Handoff](#human-actions-at-the-handoff)
11. [Publication Is Manual and Out of Scope](#publication-is-manual-and-out-of-scope)
12. [Smoke-Test Checklist](#smoke-test-checklist)

---

## Workflow Overview

```
 Human                          n8n (every 5 min)                GitHub
 ──────                         ─────────────────                ──────
 [Write content issue]
 [Apply labels] ──────────────► [GitHub Intake]
                                 ↓ enqueues into SQLite
                                [Run One Phase: content_research]
                                 ↓ Gemini investigates + validates a brief
                                [Run One Phase: content_draft]
                                 ↓ agent drafts + self-reviews
                                [Run One Phase: content_review]
                                 ↓ agent runs an editorial pass
                                [Dispatch Outbox]
                                 ↓ posts a fixed-status comment + label
                                                          [ai:ready-for-human]
 [Human reads local draft]
 [Human approves / exports, requests revision, or rejects]
```

The same three CLI entrypoints drive both the code pipeline and the content
pipeline: `github-intake` → `run-one-phase` → `dispatch-outbox`. Only the
`--phase` / `--supported-phases` values differ. `run-one-phase`'s default
`--supported-phases` already includes `content_research`, `content_draft`,
and `content_review`, so the same n8n schedule trigger that drives the code
pipeline also drives the content pipeline — no separate workflow is needed.

Unlike the code pipeline, the content pipeline never opens a pull request and
never touches the target repository's working tree. Every phase writes to a
local, per-run artifact directory only (see [Locating Local
Artifacts](#locating-local-artifacts)).

---

## Step 1 — Write a Content Issue

Write the issue title and body to convey the requested content outcome —
topic, intended audience, and any constraints — not implementation steps.
The title and body are the only issue-level fields the content agents
receive; they are treated as untrusted prompt input and bounded to a fixed
character limit at every phase (contract §Accepted inputs in each of the
three content contracts).

If you want the research phase to revise a prior attempt, put the revision
instructions in the body of a **new** Issue rather than editing the original
Issue in place — see [Human Actions at the
Handoff](#human-actions-at-the-handoff) for why an existing task cannot be
re-driven by re-labeling.

---

## Step 2 — Apply Labels

```
agent:gemini   +   status:content-needed
```

This is the **only** label combination the intake automation matches for the
content pipeline. Gemini is currently the only supported content-research
agent. Applying this pair enqueues a `content_research` task; the
`content_draft` and `content_review` phases that follow are **not**
label-driven — they are reached automatically once the prior phase succeeds
(see [Step 3](#step-3--automation-picks-it-up)). There is no label that
enqueues `content_draft` or `content_review` directly.

---

## Step 3 — Automation Picks It Up

### GitHub Intake

```sh
node dist/cli/github-intake.js \
  --session-id <id> \
  --supported-phases research,content_research
```

`github-intake` scans open issues for `agent:gemini` + `status:content-needed`
(among the other label combinations it understands), applies the same
dependency gate and idempotency check used for code issues, and inserts a
matching issue into the SQLite queue as a `content_research` task.

### Run One Phase

```sh
node dist/cli/run-one-phase.js \
  --session-id <id> \
  --run-id <id>
```

`run-one-phase` claims one task and dispatches it to whichever phase it is
currently queued in. Its default `--supported-phases` already covers
`research,content_research,content_draft,content_review`, so a plain
invocation (no flags needed) advances a content task through research, draft,
and review over successive calls — the same way it advances a code task
through implementation and review.

### Dispatch Outbox

```sh
node dist/cli/dispatch-outbox.js --session-id <id>
```

Flushes the fixed-status comment and label change recorded during the phase
run to GitHub. See [Step 7](#step-7--ready-for-human) for exactly what that
comment contains.

---

## Step 4 — Content Research Phase

Gemini investigates the topic and produces a validated research brief. On
success the task advances automatically to `content_draft`; the
`status:content-needed` and `agent:gemini` labels are removed so intake does
not re-route the issue back into research while later phases run.

Local-only artifacts (never forwarded to GitHub):

| File | Contents |
|---|---|
| `content-research-prompt.md` | Prompt sent to the research agent |
| `content-research-output.md` | Raw research agent output |
| `content-research-result.json` | Structured result record |
| `content-research-validated-brief.md` | The validated brief consumed by the draft phase |

Full contract: [content-research-mvp-contract.md](content-research-mvp-contract.md).

---

## Step 5 — Content Draft Phase

The draft agent consumes the bounded issue title/body and the validated
research brief (when present) and produces a draft with a self-review. On
success the task advances automatically to `content_review`.

Local-only artifacts:

| File | Contents |
|---|---|
| `content-draft-prompt.md` | Prompt sent to the draft agent |
| `content-draft-output.md` | **The full draft text and self-review remarks — this is the article.** |
| `content-draft-result.json` | Structured result record (`draft_complete`, `draft_failed`, or `input_invalid`) |

Full contract: [content-draft-mvp-contract.md](content-draft-mvp-contract.md).

---

## Step 6 — Content Review Phase

The review agent performs an editorial pass against the draft, the original
issue request, and the research brief (when present), evaluating factual
accuracy, private-information leakage, overclaiming, structure, missing
caveats, and title/body fit. It reports exactly one outcome:

| Outcome | Meaning | Next state |
|---|---|---|
| `success` | No blocking findings. The draft is ready for human export or publication. | `ready_for_human` |
| `needs_fix` | One or more blocking findings. | Automatically requeued to `content_draft`, unless the cycle cap below has already been reached |
| `blocked` | The review could not be completed (missing/invalid draft input, agent error). | `ready_for_human`, escalated |

The `content_draft` ↔ `content_review` revision loop is capped at **3**
completed `needs_fix` cycles (`DEFAULT_MAX_CONTENT_REVIEW_CYCLES`). Once the
cap is reached, the task is escalated straight to `ready_for_human` instead
of looping again — this is a deliberate bound, not a bug, because the
editorial agent can otherwise return `needs_fix` indefinitely with no human
in the loop.

Local-only artifacts:

| File | Contents |
|---|---|
| `content-review-prompt.md` | Prompt sent to the review agent |
| `content-review-findings.md` | **Full editorial findings, including detailed feedback. Local only — never posted to GitHub.** |
| `content-review-result.json` | Structured result record (outcome enum + bounded metadata) |

Full contract: [content-review-mvp-contract.md](content-review-mvp-contract.md).

---

## Step 7 — Ready for Human

`dispatch-outbox` posts a **fixed-status comment** on the GitHub Issue and
swaps the coarse status label to `ai:ready-for-human` (the same label used by
the code pipeline). The comment text is one of a small, fixed set of strings
— no draft text, findings, source excerpts, raw errors, or local paths are
ever included:

| Phase outcome | GitHub-visible comment |
|---|---|
| `content_research` success | `✅ **Content research complete** for issue #N.` |
| `content_research` failed | `❌ **Content research failed** for issue #N.` |
| `content_draft` success | `✅ **Content draft complete** for issue #N. Outcome: \`draft_complete\`.` |
| `content_draft` failed | `❌ **Content draft failed** for issue #N. Outcome: \`draft_failed\`` (or `input_invalid`) |
| `content_review` success | `✅ **Content review passed** for issue #N. Ready for human review. Outcome: \`success\`.` |
| `content_review` needs_fix, still cycling | `🔄 **Content review: needs revision** for issue #N. Returned to draft phase. Outcome: \`needs_fix\`.` |
| `content_review` needs_fix, cap reached | `🔄 **Content review: needs revision** for issue #N. Editorial cycle limit reached — escalated for human review. Outcome: \`needs_fix\`.` |
| `content_review` blocked | `❌ **Content review blocked** for issue #N. Outcome: \`blocked\`.` |

These strings are the entire GitHub-visible public status contract for the
content pipeline — this table is exhaustive, not illustrative. Anything a
human needs beyond "which fixed outcome happened" is read from local
artifacts (next section).

---

## Locating Local Artifacts

The reviewed draft and its findings never leave the machine running the
loop. To find them for a specific issue, query the task's stored `context`
(a JSON column) in the session's SQLite database — the same database and
default path used for the code pipeline:

```sh
sqlite3 ~/.config/n8n-ai-cli-loop/dev_loop.db

SELECT
  issue_number,
  status,
  phase,
  json_extract(context, '$.outcome')              AS review_outcome,
  json_extract(context, '$.readyForHuman')         AS ready_for_human,
  json_extract(context, '$.artifactDir')           AS draft_artifact_dir,
  json_extract(context, '$.reviewRunArtifactDir')  AS review_artifact_dir,
  json_extract(context, '$.reviewArtifactKey')     AS review_run_id
FROM tasks
WHERE session_id = '<session-id>' AND issue_number = <N>;
```

- `draft_artifact_dir` is the content-draft run's artifact directory. It
  contains `content-draft-output.md` — the draft text itself.
- `review_artifact_dir` (equivalently, `<artifactRoot>/runs/<review_run_id>/`)
  is the content-review run's artifact directory. It contains
  `content-review-findings.md` (the full editorial findings) and
  `content-review-result.json` (the structured verdict).
- `ready_for_human` is `true` only when `review_outcome` is `success`.

Both directories live under `<repoRoot>/.n8n-artifacts/runs/<run-id>/` by
default, the same artifact root used by the code pipeline (see
[docs/idea-to-implementation.md § Artifacts](idea-to-implementation.md#artifacts)).

> **Never paste a local path, `content-draft-output.md` content, or
> `content-review-findings.md` content into a GitHub comment or any other
> public channel.** These files are local-only by contract. If you need to
> reference a specific run in a public thread, use the run ID
> (`review_run_id` above), not the filesystem path.
>
> There is currently no `admin` subcommand that resolves an issue number
> directly to an artifact directory — the SQLite query above is the
> supported way to locate one. This is a known gap, not an oversight.

---

## Human Actions at the Handoff

Once an issue reaches `ready_for_human` from the content pipeline, exactly
three actions are available. None of them are automated — the MVP stops at
`ready_for_human` by design (contract §Human Handoff in
[content-review-mvp-contract.md](content-review-mvp-contract.md)).

### Approve and export

Open `content-draft-output.md` from the draft artifact directory located
above, read it, and manually copy, format, and publish it through whatever
external channel you use (CMS, static-site repo, blog platform, etc.). No
command in this repository performs publication or export — that boundary is
intentional (see [Publication Is Manual](#publication-is-manual-and-out-of-scope)
below).

### Request revision

- **While the automated cycle count is under the cap (fewer than 3 completed
  `needs_fix` cycles):** no action needed — the review handler already wrote
  bounded fix feedback to task context and requeued the task to
  `content_draft` automatically. Running `run-one-phase` again continues the
  cycle.
- **After the cap has been reached** (the task is `ready_for_human` with a
  `needs_fix` outcome): the automated revision loop has stopped and does not
  resume on its own. Re-labeling the same Issue does not requeue it —
  intake is idempotent and skips any issue that already has a task row, the
  same behavior documented for the code pipeline in
  [idea-to-implementation.md](idea-to-implementation.md#step-2--apply-labels).
  There is no supported command to inject free-form human revision notes
  into an existing task's next draft attempt (a richer fix-feedback channel
  is an explicit deferred capability of the review contract). The supported
  path is to open a **new** content Issue whose body includes the specific
  revisions you want, and label it as in [Step 2](#step-2--apply-labels).

### Reject

Read the draft and the findings, and decide not to use it. This requires no
system action — simply do not export it. Optionally close the GitHub Issue
to signal the decision to other operators. There is no "rejected" outcome or
label in the automated MVP; rejection is a human decision made entirely
outside the loop.

---

## Publication Is Manual and Out of Scope

Automated publication, export, commit, or push of a reviewed draft is not
part of this MVP and is not planned as part of it without a dedicated,
separately scoped follow-up (publication handler, commit/push policy, and
access-control design are all listed as deferred capabilities in
[content-review-mvp-contract.md](content-review-mvp-contract.md#deferred-capabilities-explicit-non-goals-for-the-mvp)).
Every export, formatting, and distribution decision is made by a human,
outside this automation, using the local draft located as described above.

---

## Smoke-Test Checklist

> ⚠️ **Manual checklist** — perform these steps by hand and record each
> result. Use a **throwaway, low-stakes sample article Issue** in the target
> repo; do not use a real content request for this test.

### Before you start

- [ ] `npm install && npm run build` exits 0
- [ ] `gh auth status` shows correct account and repo access
- [ ] `sessions.json` exists at `~/.config/n8n-ai-cli-loop/sessions.json`
- [ ] Content-research agent CLI is available (`agy --version` or
      `$ANTIGRAVITY_BIN`)
- [ ] A throwaway Issue exists with a title and body describing a trivial,
      low-stakes sample article (e.g. "a two-paragraph overview of what this
      repository does")

### Step 1 — Label and intake

- [ ] Apply `agent:gemini` + `status:content-needed` to the sample Issue
- [ ] Run `node dist/cli/github-intake.js --session-id <id> --supported-phases research,content_research`
- [ ] Output shows `ok: true` and the sample issue enqueued as `content_research`

### Step 2 — Run the pipeline to completion

- [ ] Run `node dist/cli/run-one-phase.js --session-id <id> --run-id smoke-content-1` repeatedly (once per phase: research, draft, review) until the task reaches `ready_for_human`
- [ ] Each run reports `ok: true, outcome: "completed"`
- [ ] `content-research-result.json`, `content-draft-result.json`, and
      `content-review-result.json` all exist under the corresponding run
      artifact directories

### Step 3 — Verify the public-status contract

- [ ] Run `node dist/cli/dispatch-outbox.js --session-id <id>`
- [ ] The GitHub Issue label changed to `ai:ready-for-human`
- [ ] The GitHub Issue comment(s) match the fixed strings in [Step
      7](#step-7--ready-for-human) exactly — no draft text, findings,
      excerpts, raw errors, or local paths appear anywhere in the comment
      thread
- [ ] `SELECT * FROM outbox WHERE sent_at IS NULL` returns empty for this
      session

### Step 4 — Locate and read the local draft

- [ ] Run the SQLite query from [Locating Local
      Artifacts](#locating-local-artifacts) for the sample issue number
- [ ] `readyForHuman` is `true` (assuming the sample review passed)
- [ ] `content-draft-output.md` exists at `draft_artifact_dir` and contains
      readable article text
- [ ] `content-review-findings.md` exists at `review_artifact_dir` and
      contains editorial findings labeled BLOCKING or ADVISORY

### Step 5 — Exercise the human decision point

- [ ] Confirm you can decide "approve," "request revision," or "reject" for
      the sample draft using only the guidance in [Human Actions at the
      Handoff](#human-actions-at-the-handoff) — no additional undocumented
      steps were required
- [ ] Clean up: close the throwaway Issue and remove its row from SQLite if
      you do not want it to persist in the session's task history
