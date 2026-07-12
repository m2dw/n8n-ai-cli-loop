# Human Review Return Flow

This document specifies how a PR that reached human review can be returned to
fix mode when a human reviewer requests changes.

---

## Why `status:needs-fix` Alone Is Insufficient

The implementation fix handler reads `task.context.reviewFeedback` before
spawning a fix agent. When that field is absent or empty the handler exits with:

```
Fix mode requires review feedback
```

The automatic review loop avoids this because the review handler writes
`task.context.reviewFeedback` before requeueing the task. Human review has no
equivalent first-class path. Applying the `status:needs-fix` label from GitHub
only changes routing — it does not populate the feedback field. Any path that
re-enters fix mode must explicitly set `reviewFeedback` in the task context
before the task is enqueued.

---

## Context / DB Contract

The following fields must be present in the task context before a task is
enqueued for fix mode:

| Field | Type | Description |
|---|---|---|
| `reviewFeedback` | `string` (non-empty) | Bounded, sanitized feedback text delivered to the fix agent. |
| `reviewFeedbackSource` | `string` | Machine-readable source token (see values below). |
| `reviewFeedbackRecordedAt` | ISO-8601 string | Timestamp the feedback was written. |

**`reviewFeedbackSource` values:**

| Value | Meaning |
|---|---|
| `github-app-review` | Feedback extracted from a GitHub review (`CHANGES_REQUESTED`) by the GitHub App automation. |
| `github-app-comment` | Feedback extracted from a GitHub PR comment by the GitHub App automation. |
| `operator_input` | Feedback provided directly by an operator via `admin.js human-review-return` (`--feedback` / `--feedback-file`). |
| `human_comment` | Latest human issue comment forwarded by an operator via `admin.js human-review-return --feedback-source issue-comment`. |

Labels (`status:needs-fix`, agent label) are routing signals set by whichever
path populates the context. They are not the feedback payload.

---

## Two Supported Paths

### Path A — No GitHub App (Operator / `admin.js` fallback)

This path is available in all deployments.

1. A human reviewer posts review comments on the PR on GitHub.
2. The operator reads those comments and decides to return the task to fix mode.
3. The operator runs the `human-review-return` admin command (issue #284):

   ```
   node dist/cli/admin.js human-review-return \
     --session-id <id> --issue-number <n> \
     --feedback "Reviewer requested: ..."
   ```

   The feedback source is chosen explicitly via exactly one of:
   - `--feedback "<text>"` — direct operator text (`reviewFeedbackSource: "operator_input"`).
   - `--feedback-file <path>` — operator text from a local file (`operator_input`).
   - `--feedback-source issue-comment` — the latest human (non-bot) issue comment
     (`reviewFeedbackSource: "human_comment"`).

4. The admin command:
   - Bounds the input to a safe maximum length (4 000 characters).
   - Sanitizes the text: redacts local filesystem paths and artifact paths
     (shared `sanitizeBody` sanitizer) before storage or any comment.
   - Writes `reviewFeedback`, `reviewFeedbackSource`, `reviewFeedbackRecordedAt`,
     and `reviewFeedbackMeta` (channel/author/timestamp when available) to the
     task context, and marks `implementationMode: "fix"`.
   - Preserves the existing `prUrl` / `branch` context (falling back to the
     conventional `ai/issue-<n>` branch) so the fix run updates the same PR.
   - Swaps GitHub labels to the fix lane via the outbox — reusing the same
     `enqueueStatusLabelEffects` logic as the automatic review→fix requeue: adds
     `status:needs-fix` plus the implementation agent label (e.g. `agent:claude`)
     and removes the ready-for-human and review-lane labels.
   - Requeues the task with `status: "queued"` and `phase: "implementation"`.
   - Appends a `human_review_return` task event and enqueues a sanitized status
     comment (never the raw feedback verbatim).

   It refuses to act on a `claimed`/`running` task, on a missing task, or on
   empty feedback (in which case nothing is requeued).

The admin command is the authoritative trust boundary for this path. The
operator is responsible for deciding which GitHub comment text is safe to
forward.

### Path B — GitHub App Enabled

This path requires the GitHub App to be installed and configured for the
repository.

1. A human reviewer submits a `CHANGES_REQUESTED` review or posts PR comments.
2. The GitHub App webhook handler receives the review or comment event.
3. The handler:
   - Verifies the event is for an open PR tracked in the task store.
   - Extracts comment/review body text.
   - Bounds the text to the same safe maximum length as Path A.
   - Sanitizes the text using the shared sanitizer (no local paths, artifact
     paths, raw prompts, or raw command lines).
   - Writes `reviewFeedback`, `reviewFeedbackSource: "github-app-review"` or
     `"github-app-comment"`, and `reviewFeedbackRecordedAt` to the task context.
   - Sets labels to `status:needs-fix` plus the implementation agent label.
   - Requeues the task.
4. Bot identity (the GitHub App) and human identity remain separated in GitHub's
   audit trail. The bot must not post review feedback content back to the public
   PR thread.

The GitHub App path is optional. Basic operation does not require it.

---

## Security Constraints

GitHub comment and review text is **untrusted input** regardless of the
originating user's role.

- Feedback text must be bounded before storage (recommended maximum: 4 000
  characters; hard cap: 8 000 characters).
- A shared sanitizer must strip or redact: local filesystem paths, CI artifact
  URLs, raw shell command lines, and inline prompt-injection markers.
- `reviewFeedback` must never be echoed verbatim into public GitHub comments,
  issue bodies, or log streams.
- `reviewFeedbackSource` must always be recorded so incidents can be traced to
  the originating input channel.
- The sanitizer and length bounds must be the same implementation for both
  paths (admin command and GitHub App) to avoid divergent behavior.

---

## Non-Goals for This Specification

The following items are explicitly out of scope for this document. They are
expected to be addressed in follow-up issues:

- Implementing GitHub App webhook detection and routing.
- Implementing the shared sanitizer utility.
- Requiring the GitHub App for any existing operation.

---

## Recommended Implementation Order

1. **Shared sanitizer** — build and test the bounded-text sanitizer as a
   standalone utility. Both paths depend on it.
2. **`admin.js human-review-return` command** (Path A, issue #284) — the operator
   fallback. This unblocks human review handoff without any GitHub App work.
3. **GitHub App webhook handler** (Path B) — implement review/comment event
   handling that calls the shared sanitizer and requeues tasks. Guarded by an
   explicit GitHub App configuration flag.
4. **Intake label mapping** — ensure `labelsToPhase` recognises the
   `status:needs-fix` + agent label combination used by both paths.
