# Guided Tool Request Operator Flow

This document specifies the guided operator flow for resolving Tool Requests.
It defines what an operator does, what admin tooling automates, and the safety
checks that govern each step.

This is a **specification**. No implementation is in scope here. Follow-up
implementation issues should reference the sections below rather than restating
the design.

It builds on:

- [docs/tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md)
  — Tool Request fields, metadata shape, public-comment rules, `grant` and
  `manual-done` semantics, branch discipline, and partial-diff preservation.
- [docs/per-issue-worktrees.md](per-issue-worktrees.md) — per-issue worktree
  model, lifecycle, and lock model. Tool Request side effects run inside the
  issue worktree once that model is enabled for a session.

---

## 1. Problem

The existing `admin tool-request list` and `admin tool-request resolve|grant`
commands give operators the primitives needed to handle a Tool Request, but the
surrounding workflow is entirely manual:

- find the pending request in the list;
- determine the correct branch / worktree to operate in;
- run or reject the command;
- inspect stdout/stderr and repository state;
- decide whether produced files should be kept, committed, or discarded;
- run the correct resolve/grant command with the right flags;
- confirm the task re-queues correctly.

Each of those steps is a mechanical detail that hides the two decisions that
genuinely require human judgement:

1. Is this command safe to run?
2. Is the outcome acceptable?

The guided flow automates the mechanics and surfaces only those two judgement
points.

---

## 2. Operator model

In the guided flow a normal resolution requires only four operator actions:

1. **Review** the command summary: issue, branch, PR, phase, reason, display
   command, expected files, necessity.
2. **Confirm** whether to run, reject, or skip: press Enter (run), type `reject`
   (decline the request), or type `skip` (defer without resolving).
3. **Review** stdout/stderr and a repository diff summary showing which files
   changed and how they compare to the expected-files list.
4. **Decide** the outcome — `done`, `reject`, or `grant` — and, when repository
   changes are present, the file disposition — `commit`, `keep`, or `discard`.

Everything else — worktree resolution, branch verification, command execution,
output capture, diff computation, metadata update, label change, and task
requeue — is automated.

---

## 3. Guided flow steps

The guided flow is triggered via `admin tool-request run` (name TBD per
implementation). Each step is described below alongside what the tooling does
automatically and what the operator decides.

### 3.1 List unresolved requests

**Automated.** Query open Tool Requests across the session (or for a specific
issue when `--issue-number` is supplied). Requests are sorted by detection time,
oldest first. Each line shows:

```
#<issue>  <phase>  <necessity>  <display-command>  (detected <relative-time>)
```

When a specific request is not given on the command line, the tool prompts the
operator to select one.

### 3.2 Show request details

**Automated.** Retrieve and display the full record:

| Field | Source |
|---|---|
| Issue number | task context |
| Branch | task context `branch` / conventional `ai/issue-<n>` |
| PR URL | task context `prUrl` (if present) |
| Phase | task context `phase` |
| Reason | `toolRequest.reason` |
| Display command | `toolRequest.displayCommand` (redacted — never `command`) |
| Expected files | `toolRequest.expectedFiles` |
| Necessity | `toolRequest.necessity` |
| Partial diff artifact | `toolRequest.partialDiffArtifact` (path shown only if present) |

The exact `command` is never displayed in the terminal. An operator who needs to
audit it reads the local run artifact directly.

### 3.3 Resolve and verify the issue worktree

**Automated.** Using `issueWorktreePath(root, sessionId, issueNumber)`:

- Confirm the worktree exists and is checked out on the expected branch.
- Confirm the worktree is registered with the canonical repo (`git worktree
  list`).
- Record the resolved worktree path for subsequent steps.

**Safety checks:**

- **Branch mismatch.** If the worktree's HEAD branch differs from the task's
  recorded branch, the flow fails closed with a clear message:
  `worktree branch '<actual>' does not match expected '<recorded>'`. The
  operator must resolve the discrepancy manually before retrying.
- **No worktree.** If the worktree does not exist, the flow fails closed. The
  worktree must be re-created from the issue branch before the flow can
  proceed.
- **Canonical-checkout guard.** The flow must not operate in the canonical
  `repoRoot`. If the resolved worktree path equals `repoRoot`, the flow fails
  closed (§5 security boundary).

### 3.4 Show pre-run dirty state

**Automated.** Run `git status --short` and `git diff --stat` inside the issue
worktree. Display the result so the operator can see what state the worktree is
in before the command runs.

A non-clean worktree is informational, not a hard stop here — the worktree may
legitimately contain the partial diff from a prior implementation pass (see
`partialDiffArtifact`). The operator sees the state and proceeds.

The tooling also records the pre-run worktree state as a local snapshot —
a `git diff HEAD` patch for tracked changes plus the list of untracked file
paths — so the `discard` disposition (§4.7) can distinguish pre-existing
changes from changes introduced by the command.

### 3.5 Operator pre-run confirmation

**Human decision.** Display a prompt:

```
Run the above command in worktree at <worktree-path>? [Enter=run / reject / skip / grant]
```

- **Enter / `run`** — proceed to §3.6.
- **`reject`** — record the rejection outcome (§4.2) and exit the flow without
  running anything.
- **`skip`** — exit without changing the request state. The request remains open
  for the next operator session.
- **`grant`** — create a scoped grant and delegate execution to the workflow
  (§4.3); exit the guided flow without running the command locally. This skips
  §3.6–§3.8.
- Any **unknown input** fails fast with a usage message; the command does not
  proceed (§5 security boundary).

### 3.6 Run the command

**Automated.** Run `toolRequest.command` (the exact, unredacted value from local
metadata) inside the issue worktree. The command runs with the worktree as the
working directory.

Execution constraints:

- The command is read from local task metadata only; it is never derived from
  any public surface (issue body, PR comment, GitHub API).
- stdout and stderr are captured to bounded local run artifacts under
  `<artifactRoot>/runs/<runId>/tool-request-run.json`, consistent with other
  phase artifacts. The exact command and full output are kept local and never
  posted to any public comment.
- A configurable `timeoutMs` (default 120 000 ms) terminates a hung process.
- The exit code is recorded.

### 3.7 Show post-run output and diff

**Automated.** Display:

1. `exit code: <n>` (non-zero is highlighted).
2. Bounded stdout / stderr (truncated at a configurable line limit; full output
   is in the run artifact).
3. `git status --short` inside the worktree.
4. `git diff --stat` (file-level diff summary; full `git diff` is available via
   `--verbose` or in the run artifact).
5. **Expected-files comparison.** For each path in `toolRequest.expectedFiles`:
   - mark it `present` (exists and is dirty / newly created),
   - `missing` (does not exist),
   - or `unchanged` (exists but not in the diff).
   - Highlight any files in the diff that are not in the expected list.

This gives the operator a complete picture before the outcome decision.

### 3.8 Operator outcome decision

**Human decision.** The operator selects an outcome:

```
Outcome? [done / reject / abort]
```

See §4 for the full semantics of each choice.

If the worktree is dirty after the run (files were created or modified), the
operator is additionally asked for a file disposition:

```
Repository changes detected. File disposition? [commit / keep / discard]
```

See §4 for disposition semantics.

The two prompts are shown together and may be answered in sequence or combined
via flags (`--outcome done --disposition commit`) when the flow is invoked
non-interactively.

### 3.9 Automated post-outcome operations

After the operator's decision the tooling performs all remaining mechanics:

- Update `toolRequest.resolved` and populate `toolRequest.resolution` in the
  task context. (There is no `toolRequest.status` field: the request
  lifecycle is derived from `resolved`/`resolution` plus the task status —
  see `docs/unattended-tool-request-contract.md` §4.)
- Apply the file disposition to the worktree.
- Update GitHub labels (remove the Tool Request / ready-for-human labels; add
  the appropriate status label for the next phase).
- Post a redacted public comment (display command only, never the exact command)
  summarizing the outcome.
- Requeue the task to the appropriate phase (§4).

---

## 4. Outcome and disposition semantics

### 4.1 `done`

The command ran successfully and the operator accepts the result. The workflow
re-queues the task to the phase it was in when the Tool Request was emitted
(typically `implementation`). The implementation agent resumes from the issue
worktree's current state.

Requires the worktree to have a usable continuation point: the issue branch
must be present (locally or on origin). If no continuation point exists the flow
fails closed and directs the operator to push the issue branch before resolving.

### 4.2 `reject`

The operator declines to run the command (pre-run confirmation, §3.5) or
decides the result is unacceptable (outcome decision, §3.8). The request is
closed with `resolution.action: "reject"`. The task is requeued to
`implementation` with a rejection note in `reviewFeedback` so the agent can
attempt a different approach that does not require the disallowed command.

### 4.3 `grant`

Delegates execution to the workflow rather than running the command locally.
When selected at the pre-run confirmation prompt (§3.5) — after the operator
has reviewed the command details and verified the worktree state but before any
local execution — a scoped grant is created and the workflow runs the command
handler-owned, mirroring the existing `admin tool-request grant` semantics
(tool-request-and-dependency-sync.md §2.6). The guided flow creates the grant
and exits without executing §3.6 (local run), §3.7 (output display), or §3.8
(outcome decision); the workflow handler owns the subsequent execution, output
capture, and continuation.

This path is appropriate when the operator wants the orchestrator to handle
execution rather than running the command directly in the local worktree.

### 4.4 `abort`

Exit the guided flow immediately without persisting any outcome change. The
request remains open. Useful when the operator needs to inspect something
externally before deciding.

### 4.5 File disposition: `commit`

Stage and commit repository changes inside the issue worktree. The commit
message includes the display command (not the exact command) and is authored
by the operator identity. The task is requeued after the commit. This path is
appropriate when the command produced files that should become part of the
PR's history (e.g. a regenerated lockfile).

### 4.6 File disposition: `keep`

Leave the worktree dirty. The changes remain as unstaged/untracked files in
the issue worktree. The task is requeued and the implementation agent's next
run begins from this state. This path is appropriate when the command produced
intermediate build artifacts that the agent should inspect or incorporate.

### 4.7 File disposition: `discard`

Revert only the changes introduced by the command, using the pre-run snapshot
recorded in §3.4. The tooling resets the worktree to branch tip (`git reset
--hard HEAD` + `git clean -fd` scoped to the issue worktree) and then
re-applies the pre-run patch and restores the pre-run untracked files, so that
any pre-existing uncommitted work present before the command ran is preserved.
No files produced solely by the command are kept. The task is requeued from
the restored pre-run state.

This path is appropriate when the command produced only diagnostic output and no
files should be committed, while pre-existing partial work in the worktree must
not be lost.

### 4.8 Continuation destination (issue #722)

Every outcome above requeues to `implementation` — with exactly one exception,
added by issue #722 as `docs/verification-execution-contract.md` §10.5 R6
requires. The destination set is closed:
`{queued, implementation}` | `{queued, review}` | remain `ready_for_human`
(`docs/unattended-tool-request-contract.md` §2).

A resolution is routed `{queued, review}` — the only direct-to-review route in
the system — when, and only when, **all** of the following hold. The checks run
in this order, the first failure is the recorded reason, and there is no partial
credit (§10.3 R2 of the verification contract: all of them, or
`implementation`):

| # | Check | Requirement |
|---|---|---|
| 1 | `guided-run-succeeded` | The runner itself observed exit code 0 |
| 2 | `configured-verification-command` | The exact command matches a `session.verification` value under the shipped matching semantics (trimmed equality or `bash -lc '<cmd>'` wrapper equivalence). Free-form command text is never classified heuristically, and an issue-required command no session value covers is not eligible |
| 3 | `no-repository-changes` | The run was a true no-op (`resolution.disposition: "no-op"`); a run that produced repository changes is never direct-reviewed, whatever disposition was applied afterwards |
| 4 | `implementation-phase` | The request was emitted from the `implementation` phase |
| 5 | `tool-request-resolved` | No unresolved Tool Request remains once this resolution commits |
| 6 | `no-pending-implementation-state` | No review feedback, fix mode, conflict state, preserved patch, failed partial-diff capture, missing verification, or unfinished change disposition remains |
| 7 | `worktree-clean` | `git status --porcelain` is empty after disposition handling |
| 8 | `branch-recorded` | The expected issue branch is known |
| 9 | `pr-recorded` | Durable context carries a `prUrl` that resolves to a PR number |
| 10 | `pr-head-matches-branch` | The recorded PR head is the branch the command ran on |
| 11 | `review-base-recorded` | A dependency-started task carries its `dependencyBase.baseHeadSha` (issue #667 / #681 check 4) |
| 12 | `branch-pushed` | The local branch head equals origin's head for that branch, read from the remote (never a stale tracking ref) |
| 13 | `committed-work-present` | The branch carries at least one commit beyond the recorded review base |
| 14 | `review-admitted` | The existing review-admission contract (issue #681) accepts the task; #722 neither weakens it nor adds verification evidence to it |

Eligibility (check 2) is routing metadata only: it selects which continuation is
*attempted*, authorizes nothing, and its failure mode is the ordinary
implementation continuation. The guided run's own success is an eligibility
trigger, never review-admission evidence.

**Recorded deviation.** `docs/verification-execution-contract.md` §10.3 step 1
re-runs the whole resolved verification set as a runner-owned *cycle* in the
`tool-request-continuation` lane and admits only a passed cycle bundle. That
engine is #918's V1–V4 slices and is not shipped — there is no cycle, no
bundle, no `setFingerprint`, and no per-command `requestDigest`, so the E7
freshness comparison has no subject. Checks 1–2 above are what this slice can
prove today: the runner's own observation that an exactly matching configured
verification command exited 0. Checks 3–14 are unchanged state evidence, so an
arbitrary successful command still never routes anything. When the cycle engine
lands, its passed bundle becomes an additional required input to checks 1–2;
nothing here is weakened by it.

The selected destination, its stable reason code, and a bounded, path-safe
evidence summary are persisted on the task (`toolRequestContinuation`) and in a
`tool_request_continuation_routed` event, on both routes. The evidence summary
carries booleans, counts, the matched `session.verification` KEY, and the branch
name — never local paths, artifact locations, raw command output, or
credentials.

`manual-done` and `reject` are unaffected: they keep the implementation
continuation, and no operator input can waive the evidence gate.

---

## 5. Safety checks (normative)

### 5.1 Pre-execution

| Check | Failure action |
|---|---|
| Branch mismatch (worktree HEAD ≠ task branch) | Fail closed; describe mismatch |
| No worktree when worktrees enabled | Fail closed; direct operator to re-create |
| Worktree path == canonical repoRoot (shared-checkout guard) | Fail closed |
| Unknown operator input at any prompt | Fail fast with usage message |

### 5.2 Execution

| Check | Failure action |
|---|---|
| Non-zero exit code | Surface clearly; do not auto-resolve; require operator outcome decision |
| Timeout | Kill process; record as non-zero; surface clearly |
| Expected-files absent after run | Surface as `missing` in comparison (§3.7); operator decides |
| Unexpected files in diff | Surface as unlisted in comparison (§3.7); operator decides |

### 5.3 Post-execution

| Check | Failure action |
|---|---|
| `done` with no continuation point (no pushed issue branch) | Fail closed; direct operator to push branch before resolving |
| `commit` when worktree is clean | No-op commit skipped; continue to requeue |
| Direct-review evidence check 1–14 fails or cannot be proven (§4.8) | Fall back to the `{queued, implementation}` continuation with the failed check recorded; never a hard failure |
| Repository state unprobeable (dirty-state, branch ref, remote head, or base-distance read fails) | Treat as unproven; fall back to `implementation` |
| Review admission rejects the task (issue #681) | Fall back to `implementation`; the admission contract is never weakened to admit a direct-review continuation |

---

## 6. Security boundaries (normative)

- **The command must not run before an explicit operator confirmation.** A
  `run`/Enter at §3.5 is the sole authorization gate.
- **The exact command is local-only metadata.** It is never posted to any
  public comment, issue body, or GitHub API call. Public comments include only
  `displayCommand`.
- **The command is read from local task metadata only.** It is never derived
  from the issue body, a PR comment, the GitHub API, or any other public
  surface.
- **Unknown inputs at operator prompts fail fast.** The flow does not proceed on
  ambiguous input.
- **The flow must not operate in the canonical checkout.** The
  canonical-checkout guard (§5.1) enforces this.

---

## 7. Interaction with per-issue worktrees

Every session runs the flow inside the per-issue worktree unconditionally:

- All command execution (§3.6) and git operations (§3.3, §3.4, §3.7, §4.5,
  §4.7) happen inside the issue worktree, not the canonical `repoRoot`.
- The `IssueWorktreeLock` is held for the duration of §3.3 through §3.9 to
  prevent concurrent phase execution in the same worktree.
- The `partialDiffArtifact` snapshot (tool-request-and-dependency-sync.md
  §2.7) is not needed: the worktree itself is the durable continuation point,
  so uncommitted partial work is already preserved in place.

---

## 8. Non-interactive invocation

The guided flow supports non-interactive use for scripting or testing by
accepting all operator decisions as flags:

```
admin tool-request run \
  --session-ref 1 --issue-number 42 \
  --confirm run \
  --outcome done \
  --disposition commit
```

Unknown flags or unknown `--outcome`/`--disposition`/`--confirm` values fail
fast (§5 security boundary). The `--confirm` flag must be `run`, `reject`,
`skip`, or `grant`; any other value is a hard error, and the command is never
executed.

---

## 9. Follow-up implementation slices

This specification is intentionally implementation-agnostic. The following
slices are expected to implement it:

1. **`admin tool-request run` command skeleton** — parse options, select a
   request, display the detail view (§3.1–§3.2), and stub the prompts.
2. **Worktree resolution and verification** (§3.3) — reuse `resolveIssueWorktree`
   and `listWorktrees` from `src/handlers/worktree.ts`.
3. **Pre-run state display** (§3.4) — run `git status` / `git diff --stat` in
   the issue worktree.
4. **Confirmation prompt and command execution** (§3.5–§3.6) — interactive
   prompt; capture stdout/stderr to run artifact; enforce `timeoutMs`.
5. **Post-run output and diff display** (§3.7) — expected-files comparison.
6. **Outcome and disposition prompts** (§3.8) — interactive or flag-driven;
   wire each outcome to existing resolve/grant primitives where possible.
7. **Post-outcome mechanics** (§3.9) — metadata update, label swap, public
   comment (redacted), task requeue.
8. **Non-interactive flag surface** (§8) — `--confirm`, `--outcome`,
   `--disposition` validated against their allowed value sets.

Slices 1–4 can proceed independently. Slices 5–8 depend on 1–4.

### 9.1 Implemented: repository-change handling on `grant` (issue #419)

Ahead of the full `admin tool-request run` command (slices 1–6), the
repository-change handling of slices 5/7 — expected-files comparison, the
explicit `commit` / `keep` / `discard` / `reject` / `abort` outcomes (§3.7,
§4.5–§4.7), and the related safety checks (§5.2, §5.3) — is implemented on the
existing automated execution path, `admin tool-request grant`, via the
`--on-changes <action>` flag (with `--confirm-discard` for the destructive
discard and `--allow-unexpected` to commit files outside the expected list).

The grant command already runs the approved command and inspects the resulting
worktree on the issue branch (issue #316), so it is the natural host for the
disposition logic until `tool-request run` lands. The pure decision logic lives
in `src/core/tool-request-changes.ts` (`classifyChangedFiles`, `planRepoChange`)
so it can be reused unchanged by `tool-request run` (slice 6/7). Omitting
`--on-changes` preserves the prior behavior of leaving changes on the issue
branch for a manual commit/push.

---

## 10. Non-goals for this specification

- Implementing the guided flow in any source file.
- Changing the existing `admin tool-request list|resolve|grant` command contracts.
- Broadening the Claude agent `allowedTools` surface.
- Automatic outcome selection (the operator always decides §3.8).
- Bulk resolution of multiple Tool Requests in a single guided session.
