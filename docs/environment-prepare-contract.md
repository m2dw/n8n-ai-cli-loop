# Environment Preparation and Verification Contract

This document defines the contract for two runner-owned mechanisms:

1. **`environmentPrepare`** — prepares an issue worktree (or shared checkout) for
   execution before a phase or verification runs.
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

- When **per-issue worktrees** are enabled (`session.worktrees.enabled: true`),
  `environmentPrepare` runs inside the **issue worktree** directory
  (`task.context.worktreePath`).
- When worktrees are disabled, it runs in the **session checkout** (`repoRoot`).

The runner never materialises dependencies into the canonical repo directory when
an issue worktree is available, because doing so would contaminate a shared
mutable state — exactly the problem worktrees exist to solve.

### 2.4 Prepare stamp and caching

The runner maintains a **prepare stamp** to avoid redundant reinstalls. The stamp
is keyed by:

1. **Worktree identity** — `worktreeId` when in worktree mode, otherwise the
   canonical `repoRoot`.
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

### 2.7 Metadata artifacts

The runner records the following in local artifacts (`<artifactRoot>/runs/<runId>/`):

- `environment-prepare-result.json` — records outcome (`run` | `skip` | `failed`),
  the stamp key used, timestamp, exit code, and bounded stdout/stderr when the
  command ran.

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
