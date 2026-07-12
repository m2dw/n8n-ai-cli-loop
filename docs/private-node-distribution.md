# Private Node Distribution — Planning Document

This document records the planning analysis for distributing a private
`n8n-nodes-ai-cli-loop` node alongside the generated workflow JSONs. It covers
the decision rationale, migration continuity strategy, first implementation
slice, affected workflow files, and issue-labeling governance.

> **Status: Slice 3 implemented.** The private node now covers Create Context,
> Acquire Repo Lock, Release Repo Lock, and Release Repo Lock on Error in a
> dedicated private-node parent workflow variant
> (`docs/n8n-thin-parent-workflow-private-node.json`). Both lock-release paths
> use private-node operations. The Execute Command parent workflow remains the
> default. Run One Phase remains an Execute Command node (Slice 4). Follow-up
> slices must not receive `status:needs-implementation` until the dependency on
> this slice is confirmed.

---

## Table of Contents

1. [Context — Why Consider a Private Node?](#context)
2. [Decision: Is Private Node Distribution the Right Direction?](#decision)
3. [Migration Continuity](#migration-continuity)
4. [Operation Inventory](#operation-inventory)
5. [First Implementation Slice](#first-implementation-slice)
6. [Rollback and Fallback Path](#rollback-and-fallback-path)
7. [Workflow File Inventory](#workflow-file-inventory)
8. [Shadow Testing Guide (Slice 1)](#shadow-testing-guide-slice-1)
9. [Issue-Labeling Governance](#issue-labeling-governance)

---

## Context

The current parent/child workflow architecture uses `n8n-nodes-base.executeCommand`
nodes to call the project's CLI entry points:

**Parent workflow Execute Command nodes (admin.js):**

| Node | Command |
|---|---|
| Create Context | `admin.js context create --json --execution-id … --session-ref …` |
| Acquire Repo Lock | `admin.js repo-lock acquire --json --context-id …` |
| Release Repo Lock | `admin.js repo-lock release --json --context-id …` |
| Release Repo Lock on Error | `admin.js repo-lock release --json --context-id …` |

**Child workflow Execute Command nodes:**

| Node | Command |
|---|---|
| GitHub Intake | `github-intake.js --context-id … --supported-phases …` |
| Run One Phase | `run-one-phase.js --context-id … --run-id … --supported-phases …` |
| Dispatch Outbox | `dispatch-outbox.js --context-id …` |

This works when the n8n instance has Execute Command enabled. In newer or
self-hosted n8n security configurations, `executeCommand` is blocked by default.
Operators must explicitly allow command execution — a step that introduces
operational friction and a broader attack surface than a typed private node.

---

## Decision

**Private node distribution is the right long-term direction for this project.**

### Why it fits

1. **Security posture.** A private node does not require `executeCommand` to be
   enabled. Each operation is a typed TypeScript function, not an arbitrary
   shell string. The `--session-ref` shell-injection concern that prompted the
   `shellescape()` helper in `build-parent-child-workflow.mjs` disappears
   entirely.

2. **Better error surfaces.** `executeCommand` nodes fail with raw stderr
   strings. A private node can return typed error objects that the workflow can
   branch on directly without stdout JSON parsing.

3. **Single distribution artifact.** Operators installing this project install
   one npm package. The workflow JSONs reference node types from that package.
   No separate `dist/cli` path configuration (`CLI_BASE`, `CANONICAL_CLI_BASE`)
   is needed.

4. **Project-specific, not broadly reusable.** The workflow is tightly coupled
   to this project's CLI. A broadly published community node would create
   maintenance obligations that are not warranted. A private npm package shipped
   alongside the project avoids that burden.

### Why the Execute Command path should stay as the default

1. **The private node path has not been smoke-tested.** Replacing the default
   before a shadow test runs repeats the parent/child migration pattern where a
   small mismatch breaks the whole loop.

2. **Gradual replacement reduces blast radius.** The same lesson learned from
   the parent/child split applies here: replacing one operation at a time is
   safer than a big-bang switch.

3. **Custom node installation adds a deployment step.** Until the deployment
   story (npm install, n8n custom node path, restart) is documented and tested,
   the Execute Command workflow remains simpler for new operators.

### Summary

The private node direction is accepted. Implementation must proceed
incrementally via a shadow workflow, with the Execute Command workflow staying
as the default until the private-node path has been tested end-to-end.

---

## Migration Continuity

The parent/child split already isolates concern well. The parent workflow
(`docs/n8n-thin-parent-workflow.json`) owns scheduling, config, lock
acquisition, lock release, and the sub-workflow call. The child workflow
(`docs/n8n-thin-child-workflow.json`) owns the three phase-runner operations.

**The parent workflow does not need to change at any migration step.** The
`Call Phase Runner` node invokes the child by workflow ID. During migration,
operators can run the Execute Command child and the private-node child
side-by-side in the same n8n instance — one for production, one for shadow
testing — because they have distinct workflow IDs.

Migration continuity rules:

- `docs/n8n-thin-parent-workflow.json` and `docs/n8n-thin-child-workflow.json`
  remain the documented defaults. Their `versionId` and `id` fields are not
  changed until the private-node path is proven stable.
- A private-node variant child workflow gets its own ID
  (e.g. `ai-dev-loop-private-node-phase-runner`) so it can coexist with the
  Execute Command child during parallel testing.
- Operators switch production to the private-node path by changing the
  `workflowId` field in the parent's `Call Phase Runner` node — a single-field
  edit, not a reimport of the parent.
- The Execute Command child remains importable and functional throughout. It is
  never archived or removed while the private-node path is in shadow testing.

---

## Operation Inventory

The proposed private-node operations map directly to the current Execute Command
nodes. All operations are thin wrappers around the existing CLI/core APIs in
the first iteration; calling TypeScript core APIs directly is a later
consideration.

| Operation | Risk | Node |
|---|---|---|
| Create Context | Low — read/write to context store only, no lock or phase logic | parent |
| Acquire Repo Lock | Low — lock acquisition; failure is a clean skip, not a crash | parent |
| Release Repo Lock | Low — lock release; idempotent; already has error-path duplicate | parent |
| GitHub Intake | Medium — reads GitHub API and mutates task store | child |
| Dispatch Outbox | Low-medium — posts outbox messages; runs after phase completion | child |
| Run One Phase | High — invokes the agent; longest-running; most failure modes | child |

---

## First Implementation Slice

**Slice 1: Private node package skeleton**

Create the npm package `n8n-nodes-ai-cli-loop` alongside the project:

- Package directory at `n8n-node/` (or a sibling package in a future
  workspace layout).
- Implements exactly one operation: **Dispatch Outbox** (lowest risk — it runs
  after the phase, has no lock interactions, and its failure is not loop-breaking
  in the same way as intake or phase execution).
- No production workflow is modified. A shadow child workflow JSON
  (`docs/n8n-thin-child-workflow-private-node.json`) is generated for manual
  import and testing.
- Acceptance test: manually run the shadow child against a test session with a
  known pending outbox item. Confirm the outbox item is dispatched and the
  workflow exits cleanly.

**Why Dispatch Outbox first:**

- It fires after the phase has already completed. A failure there does not
  prevent the phase result from being recorded.
- Its CLI contract is minimal: `dispatch-outbox.js --context-id <id>` with no
  additional flags.
- It has no conditional branching in the current workflow (it always runs after
  Run One Phase succeeds).

**Slice 2 (implemented):** Replace `GitHub Intake` with a private node operation
in the shadow child workflow. The shadow child now uses `githubIntake` typed
parameters (`contextId`, `supportedPhases`) instead of a shell command string.
No CLI path configuration is needed in the workflow JSON.

**Slice 3 (implemented):** Replace `Create Context`, `Acquire Repo Lock`,
`Release Repo Lock`, and `Release Repo Lock on Error` in a private-node parent
workflow variant (`docs/n8n-thin-parent-workflow-private-node.json`). Both
lock-release paths (success and error) are replaced together. The IF Locked
condition and Call Phase Runner contextId expression both read private-node
output directly (no `JSON.parse` of `.stdout`). The Execute Command parent
workflow remains the default.

**Slice 4 (implemented):** Replace `Run One Phase` with a private node operation
(`runOnePhase`) in the shadow child workflow. The shadow child now uses `runOnePhase`
typed parameters (`contextId`, `runId`, `supportedPhases`) instead of a shell command
string. No Execute Command nodes remain in the private-node child workflow.

Each slice is a separate implementation issue. No slice issue receives
`status:needs-implementation` until the prior slice's implementation issue is
closed and the dependency link is confirmed.

---

## Rollback and Fallback Path

The rollback for any slice is simple because the Execute Command workflow is
never removed:

1. In n8n, change the `workflowId` in the parent's `Call Phase Runner` node
   back to `ai-dev-loop-thin-phase-runner` (the Execute Command child ID).
2. Deactivate and archive the private-node child workflow if desired.
3. Uninstall the custom node package from the n8n custom node path and restart
   n8n.

No data migration is required: the context store, task store, and outbox schema
are shared by both paths. The private node calls the same underlying CLI/core
functions; it does not introduce a separate data model.

The shadow child workflow should be explicitly documented as "for parallel
testing — not for production" in its `name` field
(e.g. `AI Dev Loop — Phase Runner (Private Node — SHADOW TEST)`) to prevent
accidental promotion.

---

## Workflow File Inventory

Files that would be **added** when Slice 1 is implemented:

| File | Description |
|---|---|
| `n8n-node/package.json` | Private node npm package manifest (`n8n-nodes-ai-cli-loop`) |
| `n8n-node/src/AiCliLoop.node.ts` | n8n node type definitions (initially one Dispatch Outbox operation) |
| `docs/n8n-thin-child-workflow-private-node.json` | Shadow child workflow using private-node operations (tracked template) |
| `.n8n-artifacts/workflows/n8n-thin-child-workflow-private-node.json` | Local deployment artifact (gitignored) |

Files that would be **changed** when Slice 1 is implemented:

| File | Change |
|---|---|
| `scripts/build-parent-child-workflow.mjs` | Add `buildPrivateNodeChildWorkflow()` builder function and write both artifacts |

Files that are **not changed** in Slice 1:

| File | Reason |
|---|---|
| `docs/n8n-thin-parent-workflow.json` | Parent workflow unchanged; only the child ID changes at cutover |
| `docs/n8n-thin-child-workflow.json` | Execute Command child remains the default |
| `src/` TypeScript source | No source changes; the private node wraps existing CLIs |

Files **added in Slice 3**:

| File | Description |
|---|---|
| `docs/n8n-thin-parent-workflow-private-node.json` | Private-node parent variant (SHADOW TEST); both lock-release paths use private-node operations |

Files **changed in Slice 4**:

| File | Change |
|---|---|
| `n8n-node/src/AiCliLoop.node.ts` | Add `runOnePhase` operation (contextId, runId, supportedPhases parameters) |
| `scripts/build-parent-child-workflow.mjs` | Replace Run One Phase Execute Command with private-node operation in `buildPrivateNodeChildWorkflow()` |
| `docs/n8n-thin-child-workflow-private-node.json` | Updated to reflect Run One Phase as a private-node operation; no Execute Command nodes remain |

---

## Shadow Testing Guide (Slice 2)

This section covers how to manually test the private-node shadow child workflow
and how to fall back to the Execute Command child if needed.

### What is the shadow workflow?

`docs/n8n-thin-child-workflow-private-node.json` is a child workflow that
replaces all three Execute Command operations (GitHub Intake, Run One Phase,
and Dispatch Outbox) with private `CUSTOM.aiCliLoop` node operations.
No Execute Command nodes remain in the child workflow.
The workflow is named **"AI Dev Loop — Phase Runner (Private Node — SHADOW TEST)"**
and uses a distinct workflow ID (`ai-dev-loop-private-node-phase-runner`) so it
can coexist with the production child workflow in the same n8n instance.

**Why `CUSTOM.aiCliLoop` and not `n8n-nodes-ai-cli-loop.aiCliLoop`:**
n8n assigns the `CUSTOM.` prefix when a node is loaded via `N8N_CUSTOM_EXTENSIONS`
(the recommended startup-script path). The node implementation's `description.name`
(`aiCliLoop`) becomes the suffix. If the same node were installed under
`~/.n8n/custom/node_modules`, n8n would register it as
`n8n-nodes-ai-cli-loop.aiCliLoop` — a different type string — and a workflow
referencing `CUSTOM.aiCliLoop` would show the node as unknown (`?`). The
startup-script approach and `CUSTOM.aiCliLoop` go together; the
`~/.n8n/custom/node_modules` path and `n8n-nodes-ai-cli-loop.aiCliLoop` are a
separate, incompatible combination.

**GitHub Intake private-node parameters:**

- `contextId` — the context ID forwarded from the parent workflow (n8n expression)
- `supportedPhases` — comma-separated list of phases baked in at workflow-generation
  time (e.g. `implementation,review,conflict_resolution,research`)

**Run One Phase private-node parameters (Slice 4):**

- `contextId` — the context ID forwarded from the parent workflow (n8n expression)
- `runId` — the n8n execution ID with millisecond fallback
  (`$execution.id || ("run-" + $now.toMillis())`) for deduplication and tracing
- `supportedPhases` — comma-separated list of phases baked in at workflow-generation time

No `CLI_BASE` path is embedded in the workflow JSON for any private-node step.
The node resolves its CLI path from the `CLI_BASE` environment variable or its
install location at runtime.

### Prerequisites

1. Build the project from the repository root (builds both the root CLI and the
   n8n-node package):
   ```sh
   npm install
   npm run build
   ```
   The private node invokes CLI entrypoints from `dist/cli/` at runtime; this
   step produces those binaries.  The n8n-node TypeScript is also compiled here
   via the `build:n8n-node` workspace script.

2. **Recommended: use the startup script to launch n8n.**
   The startup script sets `CLI_BASE`, `N8N_CUSTOM_EXTENSIONS`, and
   `NODES_EXCLUDE` automatically:

   **Mac / Linux:**
   ```sh
   # Make executable once:
   chmod +x scripts/start-n8n-ai-cli-loop.sh

   # Start n8n:
   ./scripts/start-n8n-ai-cli-loop.sh
   ```

   **Windows:**
   ```bat
   scripts\start-n8n-ai-cli-loop.bat
   ```

   This sets:
   - `CLI_BASE` → `<repo>/dist/cli` (runtime CLI path for the private node)
   - `N8N_CUSTOM_EXTENSIONS` → `<repo>/n8n-node/dist` (the compiled node file)
   - `NODES_EXCLUDE` → `[]`

   When loaded via `N8N_CUSTOM_EXTENSIONS`, n8n registers the node type as
   **`CUSTOM.aiCliLoop`**.  The workflow JSONs use this type string.

   **Optional: existing n8n users (npm link / local package install)**

   If you already manage an n8n instance and prefer to integrate the node
   into your existing node-management workflow:

   ```sh
   # npm link — mounts the package into the global node_modules
   cd n8n-node && npm link && cd ..
   # Then set CLI_BASE and restart n8n normally.

   # Local install into ~/.n8n/custom — n8n's custom-dir loader scans this
   # tree and registers the node as n8n-nodes-ai-cli-loop.aiCliLoop.
   mkdir -p ~/.n8n/custom/node_modules
   ln -s "$(pwd)/n8n-node" ~/.n8n/custom/node_modules/n8n-nodes-ai-cli-loop
   ```

   > **Important:** n8n's `~/.n8n/custom` loader registers nodes by their
   > package name, so this installs the node as
   > `n8n-nodes-ai-cli-loop.aiCliLoop` — **not** `CUSTOM.aiCliLoop`.
   > The generated workflow JSONs reference `CUSTOM.aiCliLoop` and will show
   > the node as unknown (`?`) when the custom-dir path is used.
   > If you want to use the generated workflow JSONs without modification,
   > use the startup-script / `N8N_CUSTOM_EXTENSIONS` path above instead.

3. Restart (or start) n8n using the method chosen in step 2.

### Running the shadow test

1. In n8n, import `.n8n-artifacts/workflows/n8n-thin-child-workflow-private-node.json`
   (generated by `npm run build`; this artifact embeds the correct CLI paths for your
   install, unlike the tracked `docs/` template which contains the canonical
   `/opt` path).
   Import the Execute Command child (`.n8n-artifacts/workflows/n8n-thin-child-workflow.json`)
   first if not already present, so n8n has both IDs registered.
2. Keep the production parent pointing to the Execute Command child
   (`ai-dev-loop-thin-phase-runner`). Do not change the parent yet.
3. With a test session that has open GitHub issues matching the supported phases,
   manually trigger the shadow child workflow and pass a valid `contextId`.
4. Verify GitHub Intake runs correctly: the private-node step should emit
   `{ ok: true, scanned: N, candidates: M, enqueued: K }` (visible in n8n's
   node output panel). No CLI path error should appear.
5. Verify the outbox item is dispatched and the Dispatch Outbox node exits with
   a clean `{ ok: true, dispatched: N, failed: 0 }` result.
6. Confirm the Execute Command child workflow still works unchanged.

### Switching production to the private-node path

Once the shadow test checklist above is complete:

1. In the parent workflow (`AI Dev Loop — Parent Workflow`), open the
   **Call Phase Runner** node.
2. Change `workflowId` from `ai-dev-loop-thin-phase-runner` to
   `ai-dev-loop-private-node-phase-runner`.
3. Save and activate the parent.

No data migration is required. The context store, task store, and outbox schema
are shared by both paths.

### Falling back to Execute Command

If the shadow test reveals a problem:

1. Change the `workflowId` in the parent's **Call Phase Runner** node back to
   `ai-dev-loop-thin-phase-runner`.
2. Optionally deactivate the shadow child workflow.
3. Uninstall the custom node package and restart n8n.

The Execute Command child workflow is never removed. Rollback is a single-field
edit in n8n.

---

## Shadow Testing Guide (Slice 3)

This section covers how to test the private-node parent workflow variant and
how to fall back to the Execute Command parent if needed.

### What is the private-node parent variant?

`docs/n8n-thin-parent-workflow-private-node.json` is a parent workflow that
replaces the four Execute Command nodes (Create Context, Acquire Repo Lock,
Release Repo Lock, Release Repo Lock on Error) with private `CUSTOM.aiCliLoop`
operations. The remaining nodes (Config, IF Locked, Call Phase Runner, Stop and
Error) are standard n8n built-in nodes.

The workflow is named **"AI Dev Loop — Parent Workflow (Private Node — SHADOW TEST)"**
and uses a distinct workflow ID (`ai-dev-loop-private-node-parent`) so it can
coexist with the Execute Command parent in the same n8n instance.

**Key differences from the Execute Command parent:**

- No CLI path is embedded in the workflow JSON. The private node resolves its
  CLI path from `CLI_BASE` or its install location at runtime.
- IF Locked reads `json.locked` directly from the private-node Acquire Repo
  Lock output (no `JSON.parse` of `.stdout`).
- Call Phase Runner reads `contextId` from `$("Create Context").first().json.contextId`
  directly (no `JSON.parse` of `.stdout`).
- Call Phase Runner invokes the private-node child (`ai-dev-loop-private-node-phase-runner`)
  so the full parent+child path uses private-node operations throughout.

### Prerequisites

Same as Slice 2 — build the project and install the `n8n-nodes-ai-cli-loop`
package in your n8n custom node path. See the Slice 2 section above for the
full prerequisite steps.

### Running the shadow test

1. Import the Slice 2 private-node child workflow first (if not already present):
   `.n8n-artifacts/workflows/n8n-thin-child-workflow-private-node.json`
   (generated by `npm run build`; the tracked `docs/` template contains the canonical
   `/opt` path and will fail at Run One Phase unless your install is at `/opt`).
2. Import the private-node parent:
   `.n8n-artifacts/workflows/n8n-thin-parent-workflow-private-node.json`
   (generated by `npm run build`).
3. Keep the existing Execute Command parent (`ai-dev-loop-thin-parent`) active
   in production. The private-node parent (`ai-dev-loop-private-node-parent`) is
   for shadow testing only.
4. Manually trigger the private-node parent. Verify:
   - Create Context emits `{ contextId: "..." }` (visible in n8n node output).
   - Acquire Repo Lock emits `{ locked: true }` when the lock is free.
   - IF Locked routes correctly to Call Phase Runner on `locked: true`.
   - The private-node child runs and exits cleanly.
   - Release Repo Lock emits a clean result on the success path.
5. To test the error path: configure the child to fail intentionally and verify
   Release Repo Lock on Error runs and releases the lock before Stop and Error
   marks the execution as failed.
6. Confirm the Execute Command parent workflow still works unchanged.

### Switching production to the private-node parent

Once the shadow test checklist above is complete:

1. In n8n, deactivate the Execute Command parent (`ai-dev-loop-thin-parent`).
2. Activate the private-node parent (`ai-dev-loop-private-node-parent`).
3. Monitor the next scheduled execution.

No data migration is required.

### Falling back to Execute Command parent

If the shadow test reveals a problem:

1. Deactivate the private-node parent.
2. Re-activate the Execute Command parent.
3. The Execute Command parent is never removed. Rollback is a two-activation-toggle
   operation in n8n.

---

## Shadow Testing Guide (Slice 4)

This section covers how to test the private-node Run One Phase operation and how
to fall back to the Execute Command child if needed.

### What changed in Slice 4?

The private-node child workflow (`docs/n8n-thin-child-workflow-private-node.json`)
now uses the `runOnePhase` operation for the Run One Phase step instead of an
Execute Command node. This is the highest-risk replacement because Run One Phase
controls the agent subprocess, owns the phase-execution lock, and has the most
failure modes (idle, delayed, lock contention, claim loss, phase failure).

**Run One Phase private-node parameters:**

- `contextId` — reads from `$("When Called by Parent").first().json.contextId`
- `runId` — `$execution.id || ("run-" + $now.toMillis())`
- `supportedPhases` — baked-in at workflow-generation time

The node calls `run-one-phase.js` internally with these parameters. All outcome
semantics (idle, delayed, lock_contended, claim_lost, completed, phase failure)
are preserved — the node propagates the JSON output exactly as the Execute Command
node did.

### Prerequisites

Same as Slice 2 — build the project and install the `n8n-nodes-ai-cli-loop`
package. See the Slice 2 section above for full prerequisite steps. Regenerate
the local deployment artifact after building:

```sh
npm run build
```

### Running the shadow test

1. Import the updated private-node child workflow:
   `.n8n-artifacts/workflows/n8n-thin-child-workflow-private-node.json`
   (generated by `npm run build`; the tracked `docs/` template contains the canonical
   `/opt` path for documentation purposes).
2. Keep the production parent pointing to the Execute Command child
   (`ai-dev-loop-thin-phase-runner`). Do not change the parent yet.
3. With a test session that has open GitHub issues matching the supported phases,
   manually trigger the shadow child workflow and pass a valid `contextId`.
4. Verify GitHub Intake runs correctly (private-node step).
5. Verify Run One Phase runs correctly: the private-node step should emit a JSON
   object with `ok: true` and an `outcome` field (e.g. `completed`, `idle`,
   `lock_contended`). No CLI path error should appear.
6. Verify Dispatch Outbox runs correctly (private-node step).
7. Trigger a second run while the first is still running to confirm
   `lock_contended` is returned cleanly (not a node error).
8. Confirm the Execute Command child workflow still works unchanged.

### Switching production to the private-node path

Once the shadow test checklist above is complete:

1. In the parent workflow (`AI Dev Loop — Parent Workflow`), open the
   **Call Phase Runner** node.
2. Change `workflowId` from `ai-dev-loop-thin-phase-runner` to
   `ai-dev-loop-private-node-phase-runner`.
3. Save and activate the parent.

No data migration is required.

### Falling back to Execute Command child

If the shadow test reveals a problem with Run One Phase:

1. Change the `workflowId` in the parent's **Call Phase Runner** node back to
   `ai-dev-loop-thin-phase-runner`.
2. Optionally deactivate the private-node shadow child workflow.

The Execute Command child workflow is never removed. Rollback is a single-field
edit in n8n.

---

## Issue-Labeling Governance

This issue is intentionally parked under `status:backlog`. The governance rules
for follow-up implementation issues are:

1. **No execution labels until dependency links are confirmed.** A follow-up
   issue for Slice 2 must not receive `status:needs-implementation` until Slice
   1 is closed and the dependency is recorded (via a "depends on #NNN" link in
   the issue body or a project board relationship).

2. **`review:high` applies to all private-node slices.** Each slice touches
   the deployment contract (n8n node type, workflow JSON, package) and merits
   full review before promotion to production.

3. **Shadow testing before production cutover.** The `status:needs-implementation`
   label on a cutover issue (promoting the shadow workflow to production) must
   not be applied until the shadow test checklist from the previous slice is
   recorded as complete.

4. **This planning issue closes when the plan is accepted.** Acceptance means a
   reviewer has confirmed the decision, migration continuity strategy, first
   slice, and rollback path documented here. It does not mean any code has been
   written.
