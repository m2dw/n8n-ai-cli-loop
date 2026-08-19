# Tool Request Handoff and Dependency Sync Contract

This document specifies two related capabilities and, deliberately, the
boundary between them:

1. **Tool Request handoff** — what an implementation, fix, or conflict-resolution
   agent must do when it needs a command outside its allowed tool set, and how
   the workflow turns that need into a deterministic human handoff.
2. **Handler-owned dependency sync** — how the workflow regenerates lockfiles or
   other dependency metadata without broadly granting mutating package-manager
   commands to the agent.

This is a **specification**. It does not implement dependency sync, admin
commands, or any broadening of the Claude `allowedTools` surface. Follow-up
implementation issues should reference the sections below rather than restating
the design.

It builds on the responsibility split defined in
[docs/phase-contracts.md](phase-contracts.md): n8n owns orchestration,
TypeScript handlers own repository operations and state transitions, and AI
agents only perform the work delegated to their phase.

> **Operator-experience redesign (issue #428).** The *operator-facing* parts of
> this contract — the one-shot `grant` runner (§2.6) and the manual git/admin
> plumbing around it — are superseded by the guided Tool Request flow in
> [docs/tool-request-redesign.md](tool-request-redesign.md). That document keeps
> everything below intact (agent emission §2.1–2.2, the redacted/exact command
> split §2.4, the metadata record §2.5, the partial-work safeguards §2.7, and the
> dependency-sync path §3) and changes only the operator experience and the
> execution-environment model layered on top.

---

## 1. Motivation — Why `npm install` Is Not in `allowedTools`

The Claude implementation lane runs non-interactively with a deliberately narrow
`--allowedTools` set. As of this writing that set is (see
`CLAUDE_ALLOWED_TOOLS` in `src/handlers/implementation.ts`):

```
Read, Edit, MultiEdit, Write,
Bash(rg *), Bash(sed *), Bash(cat *),
Bash(npm test), Bash(npm run package),
Bash(git status *), Bash(git diff *), Bash(git log *), Bash(git show *)
```

Note what is and is not present:

- `npm test` and `npm run package` are allowed as **exact** command strings.
- `npm install`, `npm run *`, generic `npm *`, and arbitrary shell are **not**
  present, and must not be added as a default.

The reason is a security boundary, not an oversight:

- **Package-manager lifecycle scripts execute arbitrary code.** `npm install`
  runs `preinstall`/`install`/`postinstall` scripts from the project *and from
  every dependency in the tree*. Allowing `npm install` is functionally
  equivalent to allowing arbitrary code execution with the agent's privileges.
- **`npm run *` runs arbitrary project scripts.** A wildcard `npm run *`
  permission grants execution of every script in `package.json`, which can wrap
  any command. The two allowed entries (`npm test`, `npm run package`) restrict
  only the *command string* — not a wildcard.
- **A fixed command string is not a fixed command.** `npm test` and
  `npm run package` invoke the `test` and `package` scripts defined in
  `package.json`, plus any `pre`/`post` hooks (`pretest`, `posttest`,
  `prepackage`, `postpackage`). Those script bodies are repository content, and
  in any session where the implementation agent can edit `package.json` it can
  rewrite what those allowed commands actually execute *before* invoking them.
  So the allowlist entry is only as trustworthy as the script bodies behind it.
  This contract therefore scopes `npm test`/`npm run package` to **trusted,
  pre-existing scripts**: a session that allows these commands must either treat
  the `test`/`package` scripts (and their `pre`/`post` hooks) as agent-immutable
  content, or route any agent-authored change to those scripts — like any other
  disallowed mutation — through a **Tool Request** handoff (Section 2) for human
  review before the allowed command is run. Follow-up security and
  dependency-sync work must not assume these command strings are safe purely
  because the string is fixed.
- **The agent cannot be asked at runtime.** Because this is a non-interactive
  CLI workflow, the agent has no interactive "may I run this command?" channel.
  Silently widening the tool set to avoid stalls would erase the boundary the
  narrow set exists to enforce.

The agent therefore must not work around the restriction (no alternative shell
path, no piping through an allowed command, no editing config to relax
permissions). When it genuinely needs a disallowed command, it stops and emits a
**Tool Request** (Section 2). When the disallowed command is specifically a
dependency-sync step, the workflow can satisfy it through a **handler-owned**
operation (Section 3) instead of a handoff — but only under the explicit,
session-configured conditions in that section.

If a specific repository genuinely needs a broader permission, that must be an
**explicit per-session opt-in** with clear documentation — never a change to the
default `allowedTools` (Section 4).

---

## 2. Tool Request Handoff

> **Implementation status (issue #291).** The Tool Request handoff is
> implemented **for the implementation lane only** — i.e. the new-implementation,
> review-driven fix, and verification-repair agents in
> `src/handlers/implementation.ts`. That lane appends the prompt section
> (`toolRequestPromptSection`) and parses the agent output (`parseToolRequest`),
> with detection in `src/core/tool-request.ts`, handoff and metadata capture in
> `src/handlers/implementation.ts`, the public comment + label effects in
> `src/core/outbox-effects.ts`, the `ready_for_human` routing via a distinct
> `tool_request` handler result in `src/core/transitions.ts`, and the operator
> `admin tool-request list` / `admin tool-request resolve` commands in
> `src/cli/admin.ts`.
>
> The **conflict-resolution** agent (also named by the contract in §2.1) is
> **not yet wired**: `src/handlers/conflict-resolution.ts` neither appends
> `toolRequestPromptSection()` nor parses `parseToolRequest` after the agent
> runs, so a conflict-resolution run that needs a disallowed command still
> follows its existing failure path rather than the `tool_request` handoff.
> Extending the handoff to that phase (prompt section, detection, the
> abort-merge handoff, and a `conflict_resolution`-phase public comment in
> `src/core/outbox-effects.ts`) is a follow-up; the §2.1 contract below
> deliberately states the intended behavior for all three agents.
>
> Dependency sync (Section 3) is now implemented for the implementation lane —
> see the status note at the head of Section 3. The Tool Request
> field/metadata names below are the spec's *suggested* shape; the
> implementation uses `expectedFiles`/`requestedAt`/`resolved` in place of
> `expectedFilesChanged`/`detectedAt`/`status`, and keeps the `command` /
> `displayCommand` (exact vs. redacted) split this section requires.

### 2.1 Agent behavior

When an agent (implementation, fix, or conflict-resolution) determines it cannot
complete its task without a command outside its allowed tool set, it must:

- **Stop.** Do not partially complete the task in a way that hides the missing
  step.
- **Not work around the restriction.** Do not invent an alternative shell path,
  do not relax its own permissions, and do not fabricate the command's expected
  output (e.g. hand-editing a lockfile to fake the result of `npm install`).
- **Emit a structured Tool Request section** in its phase output, using the
  fields below.

### 2.2 Required fields

A Tool Request must contain:

| Field | Required | Description |
|---|---|---|
| `command` | yes | The exact command the agent needs, as it would be run. Treated as potentially sensitive: it is recorded in local metadata/artifacts only, never posted verbatim to a public comment (see 2.4). |
| `reason` | yes | Why the task cannot be completed without it. |
| `expected files changed` | yes | The files the command is expected to create or modify (e.g. `package-lock.json`). |
| `required or optional` | yes | Whether the task is blocked without the command (`required`) or the command is a nicety the human may decline (`optional`). |
| `suggested recovery path` | optional | The recommended next action, if the agent knows one (e.g. "enable `dependencySync` for this session" or "run `<command>` and re-queue"). |

So that the request is machine-detectable in freeform agent output, it should be
emitted as a clearly delimited section with a stable, greppable heading (for
example a `## Tool Request` heading or a fenced block tagged `tool-request`).
The exact serialization is an implementation detail of the follow-up issue, but
it must be deterministic enough for a pure detector — in the spirit of the
existing `classifyReviewOutput` patterns in `src/core/review-classifier.ts` — to
recognize it without guessing.

### 2.3 Handler classification — human handoff, not failure

When the handler detects a Tool Request in the agent output it must classify the
run as a **human handoff**, distinct from both generic failure and review
needs-fix:

- It is **not** `failed`. A `failed` result records a `lastError` and signals the
  phase itself broke (non-zero exit, no diff, handler-owned git/gh failure). A
  Tool Request is the agent behaving correctly: it stopped because it lacks a
  permission, not because anything errored.
- It is **not** `needs_fix`. `needs_fix` requeues the task to the implementation
  fix lane with `reviewFeedback`. A Tool Request needs a *human/admin* decision
  about granting a command or enabling dependency sync, not another automated
  implementation pass.
- It **is** a handoff to a human, surfaced via the public comment in Section 2.4
  and tracked via the metadata in Section 2.5.

**Routing note (for the follow-up implementer).** The natural target status is
`ready_for_human`. Be aware of an existing nuance in
`nextPhaseAfter` (`src/core/transitions.ts`): a handler `result: "blocked"`
returned from the **implementation** phase is currently held as
`status: "blocked"` (the dependency-hold path, issue #224), while `blocked` from
other phases routes to `ready_for_human`. A Tool Request handoff must reach a
human (`ready_for_human`) and must **not** be silently absorbed into the
dependency-hold `blocked` state, where it would sit without a human prompt. The
follow-up issue must therefore route Tool Request handoff to `ready_for_human`
explicitly rather than reusing the implementation-phase `blocked` semantics
as-is. Whether that is a distinct handler result value or a context flag checked
before the dependency-hold branch is an implementation decision for that issue.

### 2.4 Public GitHub comment

The handler-/outbox-owned public comment for a Tool Request handoff must
include:

- a **redacted display command** (see below) — never the raw exact command;
- the **reason**;
- the **expected changed files**;
- **why the workflow stopped** (the agent needs a command outside its allowed
  tool set and cannot ask at runtime);
- **suggested next actions** (e.g. an operator runs the command and re-queues,
  or enables `dependencySync` for the session, or grants a documented per-session
  permission).

**Public display command vs. exact command.** A Tool Request command can embed
sensitive context — absolute repository or host paths, internal working
directories, or token-bearing flags/environment values. The public comment must
therefore show a **redacted display command** (`displayCommand`, see 2.5), not
the raw `command`:

- The `displayCommand` is the command with sensitive arguments removed or
  replaced by placeholders, reduced to the parts a human needs in order to
  understand and approve the request. Redaction covers secret-bearing flags and
  environment values (`--token=***`, `GITHUB_TOKEN=***`), absolute filesystem
  paths (`<path>`), credentials embedded in URL userinfo
  (`https://***@github.com/...`), and credential-bearing HTTP headers / auth
  schemes (`Authorization: ***`, `Bearer ***`), plus known opaque token formats
  (GitHub PATs, etc.) wherever they appear.
- The **exact `command`** is retained only in the task-context metadata (2.5) and
  local artifacts, where an operator with appropriate access can read it to run
  or grant it. It is never posted verbatim to a public surface.
- This resolves the tension with the sanitization rules below: there is no case
  where producing the public comment forces a choice between leaking sensitive
  context and omitting the request — the redacted form is always what is public,
  and the exact form is always local.

The comment otherwise follows the same posting path and sanitization rules as
other handoff comments (see the `ready_for_human` handoff comments built in
`src/core/outbox-effects.ts`): server-side filesystem paths, raw prompts, and
raw command transcripts must not be leaked into public comments.

### 2.5 Task context metadata

> **Field-name supersession (issue #919).** The shape below is this spec's
> original *suggested* shape; the shipped record uses
> `expectedFiles`/`requestedAt`/`resolved` in place of
> `expectedFilesChanged`/`detectedAt`/`status` (see the head-note of
> Section 2). `docs/unattended-tool-request-contract.md` §4 makes the
> shipped shape normative: `resolved` plus `resolution` are the record's
> only lifecycle fields, the request lifecycle states are *derived* from
> them and the task status, and no `toolRequest.status` column exists or
> may be introduced. Read `"status": "open"` below as `resolved: false`.

So that admin tooling can list and resolve outstanding requests, the task
context must record a structured Tool Request record, in the spirit of the
existing `dependencyDecision` snapshot (see phase-contracts.md). Suggested shape:

```json
{
  "toolRequest": {
    "command": "npm install",
    "displayCommand": "npm install",
    "reason": "package.json dependencies changed; lockfile must be regenerated",
    "expectedFilesChanged": ["package-lock.json"],
    "necessity": "required",
    "suggestedRecovery": "enable dependencySync for this session, or run the command and re-queue",
    "detectedAt": "<ISO-8601 timestamp>",
    "status": "open"
  }
}
```

- `command` — the **exact** command, kept in local metadata/artifacts only. This
  field is the source of truth an operator runs or grants; it must never be
  copied verbatim into a public comment (2.4).
- `displayCommand` — the **redacted** form safe for public display (sensitive
  paths/tokens removed or placeholdered). This is what the public comment shows.
  When the exact command contains nothing sensitive the two may be identical (as
  above), but the public path must always read `displayCommand`, not `command`.

The record must be structured enough that an admin command (out of scope here,
see Non-Goals) can enumerate open requests and mark them resolved.

### 2.6 Scoped grants (issue #301)

> **Implementation status (issue #301).** Implemented as `admin tool-request
> grant`. The grant type and pure scope/hash/match logic live in
> `src/core/tool-request-grant.ts`; the operator command that creates a grant and
> runs the approved command lives in `src/cli/admin.ts` (`runToolRequestGrant`).

A grant is the second, distinct operator response to a Tool Request, separate
from `manual-done`:

- **`manual-done`** (§2.3, `admin tool-request resolve --action manual-done`)
  means *the operator already ran the command themselves*; the orchestrator just
  re-queues the task. The orchestrator never runs anything.
- **grant** (`admin tool-request grant`) means *the operator approves the
  orchestrator running one specific, exact command on their behalf*. The command
  runs **handler-owned, outside the agent permission surface** — it is never added
  to any agent's `allowedTools` (§3.4 / §4). The permission boundary stays in the
  orchestrator.

A grant is deliberately narrow so an approval can never become a standing
wildcard (a non-goal, §6):

- **Scoped** to a session, an issue/task, a phase, the repo root (cwd), and the
  **normalized command hash**. All five must match for the grant to authorize an
  execution (`grantMatches`). A different command, repo root, or issue does not
  match.
- **Exact-command only.** Matching is by the SHA-256 of the whitespace-normalized
  command, so even a superset (e.g. adding a flag) does not match. An
  operator-supplied `--command` must equal the requested command; broadening is
  refused.
- **One-shot / short-lived.** `maxUses` defaults to 1 and the grant carries a
  short TTL, so it cannot be reused indefinitely (`grantStatus` reports
  `exhausted`/`expired`).

Execution requires a **clean worktree** (the command commonly mutates the repo,
and a successful grant re-queues into the implementation lane whose preflight
aborts on a dirty tree). The command's `stdout`/`stderr`/exit code are captured
in a **local** run artifact (`tool-request-grant.json`) and a task event
(`tool_request_grant_executed` / `tool_request_grant_failed`); the exact command
and full output never reach a public comment — the comment shows only the
redacted `displayCommand` and the high-level outcome (§2.4).

**Branch discipline (issue #316).** The granted command runs on the **issue
branch**, never the session base branch (e.g. `main`). The work branch is the
open PR head branch when one exists (recorded on the task), otherwise the
conventional `ai/issue-<n>` branch, created from the base branch when it does not
exist yet (the initial-implementation case). `runToolRequestGrant` checks out /
creates that branch inside the same repo-lock critical section as the command, so
dependency / Tool Request side effects can never be committed to `main`. If the
checkout cannot safely move to the issue branch, the grant fails closed. The same
discipline applies to `manual-done`: it refuses when the local base branch is
ahead of origin and tells the operator to move those commits onto the issue
branch (or drop them) — it never suggests pushing the base branch.

On a **zero exit** with a clean, no-op result the request is resolved
(`resolution.action: "grant"`) and the task is re-queued, mirroring the
`manual-done` label/lane swap (any branch invented for a pure no-op is tidied up
so the requeued run branches cleanly from the base). When the command **produced
changes** on the issue branch — a dirty worktree or a new commit on the branch —
the task is left a human handoff and is **not** re-queued: the operator commits /
pushes those changes on the issue branch (never the base branch) and then resolves
`manual-done`.

On a **non-zero exit** (issue #678), a failing exit code is diagnostic
information for the implementation agent, not by itself a reason to stop at a
human handoff. If the failing command left the tree clean — the common case: a
verification command such as `npm test` failing without touching any files —
the request is resolved with `resolution.disposition: "failed"` and the captured
exit code/stdout/stderr, and the task is **re-queued** exactly like a clean
no-op, so the agent receives the failure and can diagnose it directly instead of
waiting on an operator. If the failing command left changes behind, re-queueing
immediately would fail the implementation preflight's dirty-tree check —
repository state cannot be preserved safely — so that case is unchanged: the
task is left a human handoff and is **not** re-queued, so a failing granted
command that leaves a dirty tree surfaces a clear failed/handoff state instead
of looping silently. A failing command can also leave the issue-branch tree
clean while having mutated the **base** branch directly (e.g. `git checkout
main && git commit ... && git push`) before returning; the base branch's SHA is
snapshotted before the command runs and compared afterward regardless of
whether `origin/<base>` is in sync, so that mutation is caught even when the
command pushed it — a bare `origin/<base>..<base>` ahead-count check would read
as safe once origin absorbs the push (issue #678 review). A failing command can
also mutate the **remote** base directly via a refspec push (e.g. `git push
origin <sha>:main`) without ever checking out or moving the local base branch
at all, which the local-base-SHA snapshot above does not see either — so the
`origin/<base>` tracking ref itself is also snapshotted before the command runs
and compared afterward, catching the case where Git updates that local ref to
the new remote tip as a side effect of the push (issue #678 review). Any of
these base-mutation cases, too, stays a human handoff and is **not** re-queued.
Either way the consumed grant is recorded so the same exact command cannot be
re-granted (the operator must grant a corrected command or reject).

### 2.7 Preserving partial work and a recoverable continuation point (issue #379)

An implementation agent often produces real work — new files, edits — *before* it
hits a blocker and emits a Tool Request, and it does not commit that work itself.
The handoff cleanup that returns the worker checkout to a safe base (`git checkout
-f <base>` + `git clean -fd`, plus `git branch -D ai/issue-<n>` in new-impl mode)
would otherwise delete that uncommitted diff irrecoverably. Losing it both strands
real work and causes a loop: the next run branches fresh from the base, re-derives
the same missing tool/dependency state, and emits the **same** Tool Request again.

Two safeguards prevent that:

- **The handoff snapshots the partial diff first.** Before the destructive
  cleanup, the handler stages the worktree (tracked edits **and** untracked new
  files, excluding the artifact dir) and writes a `--binary` patch to a local run
  artifact, `partial-implementation.patch`. Its **relative** name is recorded on
  the stored request as `partialDiffArtifact` (never an absolute path; it is not
  surfaced in public comments). An operator — or a recovery step — can reapply it
  with `git apply`. The capture is best-effort: a git failure leaves the cleanup
  outcome unchanged and simply records no patch.
- **`manual-done` fails closed when there is no usable continuation point.**
  Re-queueing only makes progress if the prior attempt left state to continue
  from: a resume branch (`ai/issue-<n>` landed locally **and** pushed, or present
  on origin) or, in fix mode, the PR head. When the session checkout is a real git
  repo and the resolution finds none of these, `manual-done` refuses rather than
  resolving the request into a dead loop, and the message points at the preserved
  `partial-implementation.patch` and the recovery: apply the patch on the issue
  branch, run the requested command, then commit **and push** that branch (never
  the base branch) before re-running the resolve. (When the checkout cannot be
  probed at all the guard does not fire — it acts only on a positive signal, like
  the dirty-tree and base-ahead guards.)

This composes with the branch discipline in §2.6: the recoverable continuation
point is always the issue branch (committed and pushed), never the base branch.

**A resumed no-op implementation is a success, not a failure (issue #404).** When
`manual-done` (or a grant) re-queues the task and the implementation lane resumes
the recorded `ai/issue-<n>` branch (§2.6 branch discipline, `toolRequestResumeBranch`),
the implementation agent may correctly decide the branch already contains the
requested work and exit **without editing any files**. A fresh implementation that
edits nothing is still a failure (`produced no file changes`), but a resumed run is
not: the handler distinguishes the two by checking whether the branch already
carries committed changes relative to its **start point** (`git diff --quiet
<start>...HEAD`, which exits non-zero when the `start..HEAD` range has a diff). The
start point is normally the base branch, but in **dependency-start-point mode**
(the issue branch is stacked on a blocker PR head, §2.6) the probe instead fetches
the blocker head and compares against it — otherwise the blocker PR's own commits
would count as this issue's implementation and a no-op resume carrying only the
dependency changes would be marked done. When the branch does carry issue-specific
commits beyond its start point, the no-op run still runs verification and — if
verification passes — succeeds, reusing
the existing open PR when one is present (and creating it otherwise) so the task
transitions to review like a normal implementation success. The success context
carries `branch`/`prUrl` as usual plus a `resumedNoChanges` marker for audit. Only
a resumed branch with no committed changes beyond its start point falls back to the
`produced no file changes` failure, so a genuinely empty branch — or one holding
only the blocker's dependency changes — never looks done.

---

## 3. Dependency Sync

> **Implementation status (issue #290).** The handler-owned dependency sync is
> implemented for the implementation lane (new-implementation and review-driven
> fix). Session config validation lives in
> `src/registries/json-session-registry.ts` (`validateDependencySync`) with the
> `DependencySyncConfig` type in `src/core/session.ts`; the sync runner is
> `runDependencySync` in `src/handlers/dependency-sync.ts`, wired into
> `src/handlers/implementation.ts` between the post-agent diff check and
> verification. The implemented config matches §3.1 (`enabled`, `triggerPaths`,
> `expectedOutputs`, `command`, optional `allowLifecycleScripts`, `timeoutMs`).
> Two deliberate refinements of §3.2/§3.3: config validation is structural and
> does not hard-enforce npm-specific safe-mode flags on `command` (so the same
> shape stays usable for non-npm tools), but safe mode is enforced at run time —
> `runDependencySync` runs `command` only when it matches a recognized
> lockfile-only command shape (e.g. `npm install --package-lock-only
> --ignore-scripts`, `cargo generate-lockfile`, `poetry lock`, `go mod tidy`).
> Anything else — including project-script runners like `npm run …` and shell
> wrappers that merely carry a dummy `--ignore-scripts` arg — is refused unless
> the session sets `allowLifecycleScripts: true`, returning an `unsafe-command`
> failure rather than executing it. A sync that exits 0 but produces no `expectedOutputs` change is
> treated as a
> legitimate success (an already-in-sync lockfile) rather than a failure;
> `expectedOutputs` production is recorded in metadata. A sync failure (non-zero
> exit, which also covers a timeout) stops the run with actionable feedback before
> any commit/push, per §3.3.

Dependency sync is **separate from `agentTools`**. The agent may freely edit
manifest files such as `package.json` (those are `Edit`/`Write` operations
already in the allowed set), but the *mutating dependency command* that
regenerates lockfiles is a **handler-owned, session-configured** operation that
runs **outside the agent permission surface**.

This means a manifest change that requires a lockfile update does **not** have to
become a Tool Request handoff: if and only if the session has explicitly
configured dependency sync, the handler can perform the regeneration itself.

### 3.1 Session configuration (initial JS/npm shape)

```json
{
  "dependencySync": {
    "enabled": true,
    "triggerPaths": ["package.json"],
    "expectedOutputs": ["package-lock.json"],
    "command": "npm install --package-lock-only --ignore-scripts",
    "allowLifecycleScripts": false,
    "timeoutMs": 120000
  }
}
```

- `enabled` — master switch. Defaults to **off**. When absent or `false`, no
  dependency sync ever runs and a needed dependency command becomes a Tool
  Request handoff instead.
- `triggerPaths` — manifest paths whose change makes the sync eligible.
- `expectedOutputs` — files the command is expected to produce/update; used to
  confirm the sync did something and to scope what the handler should expect in
  the diff.
- `command` — the **exact** command string the handler may run. Not a pattern,
  not a prefix. In the default safe mode it **must** be a lockfile-only,
  no-lifecycle-script form that resolves dependencies and writes the lockfile
  **without** materialising `node_modules` (for npm, `npm install
  --package-lock-only --ignore-scripts`). Forms that still populate or update
  `node_modules` (e.g. `npm install --ignore-scripts` on its own) are **not**
  lockfile-only and mutate the workspace beyond `expectedOutputs`; do not use them
  in safe mode. See `allowLifecycleScripts`.
- `allowLifecycleScripts` — explicit acknowledgement that this sync may execute
  arbitrary code. Defaults to **off** (`false`). See 3.2a.
- `timeoutMs` — a bounded execution budget.

### 3.2 Conditions for the handler to run the command

The implementation handler may run the configured dependency-sync command
**only when all** of the following hold:

1. the session explicitly enables `dependencySync` (`enabled: true`);
2. at least one `triggerPaths` entry actually changed in this run;
3. the command to run is **exactly** the configured session command — never a
   command derived from agent output, the issue text, or any other untrusted
   source;
4. the command runs in **safe (lockfile-only, no-lifecycle-script) mode** unless
   `allowLifecycleScripts` is explicitly `true` (see 3.2a);
5. execution happens **outside** the agent permission surface (it is the
   handler, not the Claude `allowedTools` set, that runs it — `allowedTools` is
   not widened);
6. `stdout`/`stderr` are **bounded** and stored as local run artifacts (under
   `<artifactRoot>/runs/<runId>/`, consistent with other phase artifacts);
7. failures become **actionable feedback or a human handoff**, not a silent pass
   (see 3.3).

If any condition is not met, the handler does not run the command. A genuinely
needed-but-unconfigured dependency command falls back to the Tool Request
handoff in Section 2.

There is one additional eligibility case that does not require a fresh trigger
change. The verification-repair loop re-runs the sync once per repair. If an
earlier sync in the same run already regenerated an `expectedOutputs` file and a
later repair then **reverts or removes** the manifest edit so no `triggerPaths`
entry is dirty anymore, the regenerated lockfile would otherwise be left staged
with no matching manifest change — i.e. a stale lockfile would be committed. In
that single case the handler **forces a resync** so the lockfile is regenerated
against the current (reverted) manifest state, restoring consistency before
commit. Because the lockfile is only ever written by this handler (the agent
edits manifests, not lockfiles), a dirty `expectedOutputs` file with no trigger
change after a prior sync is unambiguously stale and safe to regenerate.

### 3.2a Safe mode — why a fixed command string is not enough

A fixed `command` string pins *which command* runs, but it does **not** by itself
pin *what code* runs. The agent may edit `package.json` (an allowed `Edit`
operation) and thereby satisfy condition 2, and a plain `npm install` will then
execute lifecycle scripts (`preinstall`/`install`/`postinstall`) from the
modified manifest **and from every newly added dependency in the resolved tree**.
That code is influenced by agent-controlled manifest content, so running it from
the handler would re-open exactly the arbitrary-code-execution path the narrow
`allowedTools` set exists to close — the command string being fixed does not
preserve the boundary.

Therefore dependency sync is, by default, **lockfile-only and runs no lifecycle
scripts**:

- The configured `command` must be a lockfile-only, no-script form (for npm,
  `npm install --package-lock-only --ignore-scripts`). The handler regenerates the
  lockfile / dependency metadata without executing any project or dependency
  script **and without installing or updating `node_modules`**.
- This keeps the operation to dependency *resolution and lockfile writing*, which
  is the only thing dependency sync is for.

Executing lifecycle scripts as part of sync is an **explicit, documented
per-session opt-in** and must not be a default:

- It requires `allowLifecycleScripts: true` in the session config.
- That flag is a written acknowledgement that the sync **grants arbitrary code
  execution influenced by agent-edited manifest content**, and is equivalent in
  blast radius to granting `npm install` directly (Section 1). It should be
  reserved for sessions on trusted repositories where an operator has accepted
  that risk.
- A safer alternative to the opt-in, where lifecycle output is actually needed,
  is to require **human approval of the manifest diff** before any lifecycle
  scripts run — i.e. fall back to the Tool Request handoff (Section 2) so a human
  reviews the `package.json` change rather than letting the handler execute
  agent-authored scripts unattended.

### 3.3 Failure handling

If the configured command exits non-zero, times out, or does not produce the
`expectedOutputs`, the handler must not proceed as if the dependency state were
correct. It converts the outcome into either:

- **actionable feedback** (so a fix pass can address, e.g., a manifest that
  references a nonexistent package), or
- a **human handoff** (Section 2.3 routing) when the failure needs an operator
  decision.

The stored artifacts (bounded stdout/stderr) are the evidence for whichever path
is taken.

### 3.4 Why this is not just "add `npm install` to `allowedTools`"

Running the command from the handler rather than the agent preserves every
property the narrow `allowedTools` set exists to protect:

- The command is a **fixed, session-pinned string**, not a capability the agent
  can compose, redirect, or chain.
- It runs only on an **explicit per-session opt-in**, only when a trigger path
  changed, with a **bounded** time budget and **captured** output.
- By default it runs in **safe (no-lifecycle-script) mode**, so an agent-edited
  manifest cannot turn the sync into arbitrary code execution; lifecycle-script
  execution is itself a separate, documented opt-in (3.2a).
- The agent's permission surface is **unchanged**, so nothing the agent does can
  reach `npm install` (or its lifecycle scripts) on its own.

Adding `npm install` to `allowedTools` would instead grant the agent open-ended
ability to trigger arbitrary lifecycle-script execution at any point during a
run — exactly the boundary Section 1 establishes.

### 3.5 Routing a dependency-update Tool Request through dependency sync

> **Implementation status (issue #302).** Implemented for the implementation lane
> (new-implementation and review-driven fix, including the verification-repair
> loop). The router is `runDependencyUpdate` in
> `src/handlers/dependency-update.ts`, wired into the Tool Request detection in
> `src/handlers/implementation.ts` (`routeToolRequest`); the dependency-specific
> human handoff comment is in `src/core/outbox-effects.ts`.

Sections 2 and 3 leave a gap: a request to **add or bump** a dependency (e.g.
`npm install mail-auth-signal@^0.3.0`) is not a manifest edit the agent has
already made — it needs both a `package.json` change and a lockfile update — so it
surfaces as a generic Tool Request (Section 2) every run, and because the package
state never changes the agent re-emits the same request indefinitely.

When a session has `dependencySync` configured, the workflow gives that specific
request shape a first-class path instead of a repeated handoff:

1. The agent's requested command is parsed for **data only** — the package
   name(s) and the explicit version range. It is **never executed**, and never
   selects or composes what runs (Section 4 still holds).
2. The handler applies that version to the **manifest** as a pure JSON data edit
   (no package manager runs, so no lifecycle scripts execute).
3. The handler regenerates the lockfile by running the **exact, session-pinned**
   `dependencySync.command` under the same safe-mode and condition checks as
   Section 3.2 — the manifest edit makes a `triggerPaths` entry dirty, which is
   what makes the sync eligible.
4. The run continues to verification and commit only after the manifest and
   lockfile reflect the requested update.

The path is taken **only** when it can be satisfied safely. It falls back to a
clear human handoff — never a silent pass or a repeated generic comment — when:

- no `dependencySync` is configured/enabled for the session;
- the ecosystem is unsupported here (only npm `package.json` is auto-edited; a
  request for an ecosystem whose manifest the session's `dependencySync` does not
  target, e.g. a `cargo add …` against an npm config, is handed off);
- the request pins no explicit version (the trusted path will not guess "latest");
- the requested dependency is **already** at the requested version (surfaced as a
  distinct "unchanged" handoff so the operator knows the agent can simply proceed
  without the install — directly addressing the re-request loop);
- the configured sync command fails or is refused in safe mode (Section 3.3).

A non-npm project therefore either configures its own ecosystem `dependencySync`
command (Section 5) or opts out entirely, in which case dependency-update requests
continue to follow the generic Tool Request handoff.

---

## 4. Security Boundary (normative)

- **Do not** add broad `npm *`, `npm run *`, or arbitrary-shell permissions to
  `agentTools`/`allowedTools` as the default.
- Package-manager **lifecycle scripts** (`preinstall`/`install`/`postinstall`,
  etc.) and **project scripts** can execute arbitrary code; treat any permission
  that can reach them as arbitrary code execution.
- Dependency mutation is **handler-owned and session-configured**, never an
  agent capability.
- If a repository genuinely needs broader permissions, that must be an
  **explicit per-session opt-in**, documented for that session — not a change to
  the shared default.
- Untrusted inputs (agent output, issue text, GitHub comments) must never select
  or compose the command that gets executed. The only commands the handler runs
  are the fixed, audited entries it already owns plus the exact
  `dependencySync.command` configured for the session.

---

## 5. Non-JS Package Managers (conceptual)

The contract above is intentionally written so that JS/npm is the first concrete
shape, not the only conceivable one. The same separation generalizes:

- **Tool Request handoff** is package-manager agnostic. Any agent that needs a
  disallowed command (a Cargo, Go, Python/Poetry/uv, Bundler, etc. command)
  emits the same structured request with the same fields.
- **Dependency sync** generalizes by reading the same session-config shape with
  ecosystem-appropriate values, for example:

  | Ecosystem | `triggerPaths` (example) | `expectedOutputs` (example) | `command` (example) |
  |---|---|---|---|
  | npm | `package.json` | `package-lock.json` | `npm install --package-lock-only --ignore-scripts` |
  | Rust/Cargo | `Cargo.toml` | `Cargo.lock` | `cargo generate-lockfile` |
  | Python/Poetry | `pyproject.toml` | `poetry.lock` | `poetry lock` |
  | Go modules | `go.mod` | `go.sum` | `go mod tidy` |

These rows are **illustrative only**. This issue does not implement any non-JS
package manager, and the same conditions in Section 3.2 (explicit opt-in, exact
configured command, handler-owned execution, bounded/stored output, actionable
failure) apply identically to each. In particular, each `command` must be the
ecosystem's lockfile-only, no-lifecycle-script form (as the npm row shows); a
plain `npm install` (or any equivalent that runs lifecycle scripts or
materialises a full dependency tree) is **not** a safe-mode sync command. Adding
support for additional package managers is a separate, opt-in effort.

---

## 6. Scope / Non-Goals

This document specifies the contract. It does **not**:

- implement `dependencySync` execution in any handler;
- implement admin commands to list or resolve outstanding Tool Requests;
- broaden the Claude `allowedTools` default;
- add support for any non-JS package manager.

Follow-up implementation issues should cite the relevant section of this
document instead of restating the design.
