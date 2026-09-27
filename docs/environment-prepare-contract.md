# Environment Preparation and Verification Contract

This document defines the contract for two runner-owned mechanisms:

1. **`environmentPrepare`** — prepares the per-issue worktree for execution
   before a phase or verification runs.
2. **`verification`** — runs configured correctness checks after an agent produces
   work, without requiring the implementation agent to request those commands
   through Tool Request.

It builds on the responsibility split defined in
[docs/phase-contracts.md](phase-contracts.md) and extends the dependency-sync
model in [docs/tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md).

This is a **specification**. Do not implement the runtime `environmentPrepare`
runner in response to this document. Follow-up implementation issues should
reference the sections below rather than restating the design.

---

## 1. Capability Boundaries

Four runner-owned mechanisms share a responsibility space. They are **strictly
separate** and must never be conflated:

| Mechanism | What it does | Who configures it | When it runs |
|---|---|---|---|
| **Dependency sync** | Regenerates lockfiles after the agent edits a manifest | Session operator, via `dependencySync` | After agent diff, before verification (post-manifest-edit) |
| **Environment prepare** | Installs / materialises runtime dependencies so the worktree can execute | Session operator, via `environmentPrepare` | Before agent execution (per prepare-stamp check) |
| **Verification** | Runs correctness checks (typecheck, tests, build) on the agent's output | Session operator, via `verification` | After agent diff and dependency sync, before commit |
| **Tool Request** | Halts work so a human can approve a command the agent cannot run | Agent (emitted); handler (classified) | During any phase, when the agent hits a disallowed command |

The key distinction between environment prepare and dependency sync:

- **Dependency sync** fires because the agent **edited** a manifest. It
  regenerates only the lockfile. It does NOT materialise `node_modules` or any
  runtime dependency tree in its default (safe) mode.
- **Environment prepare** fires on a stamp-miss: the worktree has not yet been
  prepared, or the preparation is stale. It installs the full runtime dependency
  tree (e.g. `npm ci` produces `node_modules`) so that subsequent tool invocations
  and verification commands can execute.

The two may be configured independently or together. Each serves a different
need; neither substitutes for the other.

---

## 2. Environment Prepare

### 2.1 Operator contract

`environmentPrepare` is **session-defined, not AI-defined**. The exact command
is configured by the session operator. It must never be derived from issue text,
agent output, repository auto-detection, or any other untrusted source.

**Non-derivation rule (normative):** Commands are never inferred from issue text, agent output, or repository auto-detection. The operator sets the command. The runner executes only what the operator set.

### 2.2 Session configuration

```json
{
  "environmentPrepare": {
    "enabled": true,
    "command": "npm ci",
    "cacheKeyFiles": ["package-lock.json"],
    "allowLifecycleScripts": true,
    "timeoutMs": 120000
  }
}
```

Fields:

- `enabled` — master switch. Defaults to **off**. When absent or `false`, no
  environment preparation ever runs and the worktree is used as-is (the existing
  behavior). When a future default is added through a preset, it is still
  gated behind an explicit `enabled: true`.
- `command` — the **exact** command string the runner may execute. Not a
  pattern, not a prefix, not auto-detected. This is the complete shell command as
  the operator intends it to run.
- `cacheKeyFiles` — repo-relative paths whose content hash contributes to the
  prepare stamp (see §2.4). Changing any listed file invalidates the stamp and
  triggers a fresh prepare run. For `npm ci`, this is `["package-lock.json"]`.
  For `pnpm install --frozen-lockfile`, this is `["pnpm-lock.yaml"]`. Optional
  when no content-based caching is needed, but recommended for any ecosystem with
  a lockfile.
- `allowLifecycleScripts` — explicit acknowledgement that the configured
  `command` may execute arbitrary lifecycle-script code (e.g. `npm ci` runs
  `postinstall` scripts from installed dependencies). Defaults to **off**
  (`false`). In safe mode the runner should prefer commands that skip lifecycle
  scripts (e.g. add `--ignore-scripts`). Set to `true` only when the operator
  has reviewed and accepted the lifecycle-script risk for the configured command.
  This mirrors the same field on `dependencySync` and applies the same safety
  rules as described in
  [docs/tool-request-and-dependency-sync.md §3.2a](tool-request-and-dependency-sync.md).
- `timeoutMs` — a bounded execution budget in milliseconds. Defaults to
  `120000` (2 minutes) when omitted. A prepare run that exceeds this timeout
  fails closed (see §2.6).

### 2.3 Where it runs

`environmentPrepare` always runs inside the **issue worktree** directory
(`task.context.worktreePath`) — every phase runs in its own per-issue worktree
unconditionally (see [docs/per-issue-worktrees.md](per-issue-worktrees.md)).

The runner never materialises dependencies into the canonical repo directory,
because doing so would contaminate a shared mutable state — exactly the
problem worktrees exist to solve.

### 2.4 Prepare stamp and caching

The runner maintains a **prepare stamp** to avoid redundant reinstalls. The stamp
is keyed by:

1. **Worktree identity** — `worktreeId`.
2. **Command fingerprint** — the SHA-256 of the whitespace-normalised
   `environmentPrepare.command` string. A command change (even adding a flag)
   invalidates the stamp.
3. **Config fingerprint** — the SHA-256 of the full `environmentPrepare` config
   block. A config change (e.g. adding a `cacheKeyFile`) invalidates the stamp.
4. **`cacheKeyFiles` content hash** — the combined hash of the content of all
   configured `cacheKeyFiles`. A lockfile change (e.g. `package-lock.json` after
   dependency sync) invalidates the stamp.
5. **Tool version metadata** (when available later) — the package manager version
   string, if the runner can obtain it cheaply. Reserved for future use; not part
   of the initial stamp shape.

When the stamp matches a previous **successful** prepare run, the runner skips
execution and records a `skip` outcome. A failed previous run leaves no valid
stamp; the runner retries on the next phase.

The stamp is stored as a local artifact, never in committed source. Stamp files
are local-only and must never appear in public comments.

### 2.5 Runner timing

`environmentPrepare` runs at **deterministic, runner-owned times**. The intended
timing is:

1. After **session, task, and worktree resolution** — the worktree path is known.
2. **Before agent execution** when the phase needs repository execution (e.g.
   implementation, fix, conflict resolution).
3. After **dependency sync** and **before verification** when cache keys may have
   changed — for example when the dependency sync updated the lockfile, the
   prepare stamp's `cacheKeyFiles` hash is stale and a fresh prepare run is
   needed before the verification commands can execute.

The runner must check the stamp before every prepare attempt and skip when the
stamp is current.

#### Conflict-resolution: deferred prepare for conflicted dependency files

When a conflict-resolution phase run detects that a configured `cacheKeyFile`
(e.g. `package-lock.json`, `pnpm-lock.yaml`, `composer.lock`) is itself among
the conflicted files, `environmentPrepare` is **deferred past the agent**.
Running the prepare command against a file that contains conflict markers would
fail immediately — preventing the agent from resolving the very dependency-file
conflict that makes preparation possible.

In this case the ordering is:

1. Agent resolves all conflicts (including any dependency-file conflicts).
2. After the agent returns and passes all integrity checks, `environmentPrepare`
   runs with the now-well-formed dependency files — before verification.
3. Verification runs after prepare.

If **none** of the configured `cacheKeyFiles` are conflicted, the normal
pre-agent timing (point 2 above) applies. The deferred path uses the same
fail-closed failure semantics as the normal path: a failed prepare aborts the
in-progress merge and surfaces as a phase failure.

### 2.6 Failure handling

`environmentPrepare` **fails closed**. When the configured command exits nonzero
or exceeds `timeoutMs`:

- The phase stops. No agent execution follows a failed prepare.
- The failure is recorded in local run artifacts (`environment-prepare-result.json`).
- A task event is emitted to record the failure (`environment_prepare_failed`).
- The outcome is treated as a handler failure, not a Tool Request, because the
  operator owns the command and the failure is a configuration or infrastructure
  problem — not an agent-permission boundary.

A prepare failure does **not** produce a `tool_request` handoff. It surfaces as a
clear stopped state so the operator can inspect the artifact and fix the command
or infrastructure before retrying.

#### Stop-reason classification (normative, #1060)

A failed prepare run is classified into exactly one **stop reason**, and only one
of them is something the configured command chose:

| `stopReason` | Meaning | Signals it is read from |
|---|---|---|
| `command-failed` | The command ran to completion and exited non-zero. | A numeric exit status. |
| `timeout` | `timeoutMs` expired and the runner killed the command. | An `ETIMEDOUT` errno, a watchdog escalation, or — when the measured elapsed time shows the deadline actually **elapsed** — a `SIGTERM` kill with no exit status. |
| `signal` | The command was terminated by a signal before it could exit (OOM killer, operator, supervisor). | A terminating signal with no exit status. |
| `spawn-error` | The command never ran: missing or unexecutable binary, or a host that could not fork. | A spawn-level errno (`ENOENT`, `EACCES`, `ENOBUFS`, …). |
| `refused` | Safe mode refused the command before anything was spawned (§2.2 `allowLifecycleScripts`). | No spawn occurred. |

Classification order is most-determinate first: `timeout` precedes `signal` and
`spawn-error`, because a deadline kill *is* all three at the OS level and the
deadline is the fact the operator needs. `command-failed` is the fallback, so an
unrecognised shape stays the plain command failure it already was.

Normative rules:

- **A killed process is never reported as a non-zero exit.** For any stop reason
  other than `command-failed`, the recorded exit code is the runner's stand-in
  for a status the process never produced and must not be presented as something
  the command said.
- **Captured output is never presented as the cause of a stop the command did not
  choose.** A timed-out `npm ci` prints deprecation warnings on its way to the
  deadline; those bytes are partial output, not the failure, and must be labelled
  as such.
- **One classified sentence reaches every surface.** `task.lastError`, `admin
  status`, and the public failure comment all render the same stop-reason clause,
  which carries no local paths and no command output.
- **A configured deadline is evidence of nothing on its own.** A run is reported
  as a `timeout` only when the deadline is known to have *elapsed* — an
  `ETIMEDOUT` errno, a watchdog escalation, or a measured elapsed time that
  reaches `timeoutMs`. Environment preparation always configures a deadline, so
  a command that terminates itself, or that an operator or supervisor kills a
  second into a five-minute budget, is a `signal` termination and must be
  reported as one.
- **A timed-out process tree is terminated.** The command is spawned into its
  own process group and the whole group is signalled, because the synchronous
  child APIs kill only the direct child — leaving a package manager's fetch pool
  running and its cache locks held for the next attempt. What the sweep reached
  is recorded, and a sweep that could not confirm termination is recorded as such
  rather than as a success.
- **The deadline is enforced even against a command that ignores it.** A
  deadline on a synchronous child API only sends `SIGTERM` and then keeps
  waiting, so a command that traps or ignores that signal would outlive its own
  budget indefinitely. An external watchdog, armed before the spawn and disarmed
  after it, force-kills the process group once the deadline plus a grace period
  has passed; that escalation is recorded as `deadlineEscalated` and reported in
  the stop summary, because a command that had to be taken down is a different
  observation from one that stopped when asked.
- **Raising `timeoutMs` is not a classification.** A timeout is reported as a
  timeout regardless of the configured budget.

### 2.7 Metadata artifacts

The runner records the following in local artifacts (`<artifactRoot>/runs/<runId>/`):

- `environment-prepare-result.json` — records outcome (`run` | `skip` | `failed` |
  `refused`), the stamp key used, timestamp, exit code, and bounded
  stdout/stderr when the command ran.

On a `failed` outcome it additionally records the classified stop reason and the
process-termination facts behind it: `stopReason`, `stopSummary`, `timedOut`,
`deadlineEscalated`, `signal`, `spawnErrorCode`, a bounded `spawnError`, the
`timeoutMs` in force, the measured `durationMs`, and the `processTreeCleanup`
record for the surviving descendants. Within that record,
`processGroupTerminated` is claimed only on evidence — the group was gone by the
end of the grace period, its `SIGKILL` was accepted, or the process table shows
no live member left in it — and a group that still has live members after every
signal to it was refused is recorded as `false` with the refusing errno in
`processGroupSignalError`, which the stop summary renders as an explicitly
unsuccessful cleanup. The errno alone is not that evidence: a group signal
reports the same refusal for a group that is not ours to signal and for one whose
last member is an unreaped zombie.

It also records a bounded `runnerContext` block — configured command, `cwd`,
timing, the child's pid, the runner's own pid and parent pid, Node/platform/arch,
CPU count, load average, and free/total memory — so that a command which
completes when run directly but stalls under runner execution can be
investigated from the artifact rather than by re-running it. Environment
variables appear there by **name only**, never by value: package-manager
environment variables are exactly where a registry token lives.

Artifact paths are local-only and must never be posted verbatim to public comments.
Redaction rules that apply to `repoRoot` and `artifactRoot` apply equally to
worktree paths that appear in prepare output.

### 2.8 What environment prepare is NOT

- **Not auto-detected.** The runner never inspects the repository for a
  `package.json`, `Cargo.toml`, `go.mod`, or any other file to decide which
  command to run. If `environmentPrepare` is not configured, no preparation runs.
- **Not npm-specific.** The session configuration is ecosystem-agnostic. The
  `command` field is a plain string the operator provides.
- **Not a separate n8n node.** Environment preparation runs under
  `run-one-phase` / handler control — it is not an operator-side manual step and
  does not require an additional workflow node.
- **Not a broad permission grant.** The agent's `allowedTools` are not widened. The
  prepared environment is an effect of the runner executing a fixed, session-pinned
  command. Agents cannot trigger preparation themselves.

---

## 3. Verification

**Extended by #918.** This section remains authoritative for
verification ownership, session configuration, and the
non-derivation/runner-owned rules (§3.1–§3.3) and for the timing
anchors in §3.4. The execution lifecycle, failure classification,
multi-command aggregation, continuation routing, and evidence rules
are fixed by
[docs/verification-execution-contract.md](verification-execution-contract.md)
(#918), which consumes this section without restating it.

**Extended by #1037.** Task-scoped, operator-owned correction of
verification requirements after intake — the amendment layer, its
revision model, and its evidence rules — is fixed by
[docs/verification-amendment-contract.md](verification-amendment-contract.md)
(#1037). It adds a task-local operator overlay over
`session.verification`; it never edits `sessions.json`, and it weakens
no rule in §3.1–§3.3: an agent may propose verification and may still
never author, amend, remove, skip, or reorder it.

**Extended by #1095.** Project-owned verification configuration — where a
repository may record its own verification metadata, and what a project
adapter may say about a check — is fixed by
[docs/project-verification-contract.md](project-verification-contract.md)
(#1095). It weakens no rule in §3.1–§3.3: **the project verification file
is non-authorizing**, so it may carry no command, path, budget,
environment value, grant or verdict, it may only name checks the
operator already authorized, and every statement it can make moves
verification toward running more of it. Command bytes stay
`session.verification`'s alone, and the runner never synthesizes a
command from adapter output.

### 3.1 Session configuration

Verification commands are session-defined through `session.verification`, a
`Record<string, string>` mapping command names to shell command strings:

```json
{
  "verification": {
    "typecheck": "npm run typecheck",
    "test": "npm test",
    "build": "npm run build"
  }
}
```

Command lists **prefer separate named commands over shell chains**. A chain like
`npm run typecheck && npm test` makes the error surface ambiguous and the output
logs harder to read. Separate entries produce a separate per-command log artifact
(`review-verification-<name>.log`) and a distinct failure message naming which
command failed.

### 3.2 Commands are runner-owned, not agent-owned

Configured verification commands are runner-owned checks. They are **not**
agent-owned Tool Requests:

- The runner — not the agent — iterates `session.verification` and executes each
  command in the configured execution directory.
- The agent is not asked to invoke these commands. They run automatically as part
  of the phase flow (review, fix, conflict resolution, and after implementation).
- The agent has no mechanism to modify, skip, or reorder configured verification
  commands.

### 3.3 How configured verification reduces Tool Requests

Implementation prompts **must tell agents not to request configured verification
commands as Tool Requests**. Because `npm test`, `npm run typecheck`, and
equivalent runner-owned commands are already executed by the runner, an agent
that requests them as Tool Requests would produce redundant or conflicting state.

The prompt section for verification (in the implementation prompt) must:

- Name the verification commands that are already configured.
- Instruct the agent that those commands will run automatically and must not be
  requested as Tool Requests.
- Confirm the agent should rely on runner-provided verification output (included
  in fix-mode prompts) rather than re-running them manually.

If a command is **not** configured but appears necessary (for example a
project-specific integration test not in `session.verification`), the agent may
still emit a Tool Request or explain the missing verification in its output. This
is the correct behavior — the agent surfaces the gap rather than guessing.

### 3.4 Verification timing

Verification runs:

1. **After agent diff** and **after dependency sync** in the implementation lane.
2. **After PR branch checkout** in the review lane (before the review agent runs).
3. **After merge resolution** in the conflict-resolution lane (before the
   resolution is committed).

In the implementation lane, verification runs inside a bounded repair loop:
failed verification results are fed back to the agent as fix input. After the
loop cap is reached, the task escalates.

---

## 4. Preset Examples

The contract allows future presets that suggest configuration for common
ecosystems. Presets **do not auto-detect** or auto-execute. The operator remains the source of truth: a preset is a suggestion, not an authority. Enabling a
preset does not bypass the `enabled: true` gate or the non-derivation rule in
§2.1.

Candidate preset examples:

| Preset name | `environmentPrepare.command` | `environmentPrepare.cacheKeyFiles` | `verification` examples |
|---|---|---|---|
| `javascript-npm` | `npm ci` | `["package-lock.json"]` | `test: "npm test"`, `typecheck: "npm run typecheck"`, `build: "npm run build"` |
| `javascript-pnpm` | `pnpm install --frozen-lockfile` | `["pnpm-lock.yaml"]` | `test: "pnpm test"` |
| `php-composer` | `composer install --no-interaction --no-scripts` | `["composer.lock"]` | `test: "vendor/bin/phpunit"` |
| `rust-cargo` | `cargo fetch` | `["Cargo.lock"]` | `test: "cargo test"`, `build: "cargo build"` |
| `go-mod` | `go mod download` | `["go.sum"]` | `test: "go test ./..."` |
| `python-uv` | `uv sync --frozen` | `["uv.lock"]` | `test: "uv run pytest"` |

Notes:

- These rows are **illustrative only**. They do not enumerate every ecosystem.
- The `environmentPrepare.command` in these examples materialises the full
  dependency tree. This is distinct from `dependencySync.command`, which updates
  only the lockfile (e.g. `npm install --package-lock-only --ignore-scripts`).
  Both may be configured in the same session; they serve different purposes.
- The lifecycle-script safety rules from
  [docs/tool-request-and-dependency-sync.md §3.2a](tool-request-and-dependency-sync.md)
  apply to `environmentPrepare` as well: any prepare command that runs lifecycle
  scripts must be an explicit operator choice, not a default.

---

## 5. Non-Goals

This document specifies the contract. It does **not**:

- implement the runtime `environmentPrepare` runner in any handler;
- add auto-detection that silently selects a package manager or ecosystem;
- make any preset automatic or default;
- add a new `allowedTools` surface for agents;
- implement `cacheKeyFiles` hashing or stamp storage;
- implement the `tool version metadata` stamp component;
- implement presets.

Follow-up implementation issues should cite the relevant section of this document
rather than restating the design.
