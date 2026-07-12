# Context Execution Contract — Design Specification

> **Design archive.** This document specified the target contract for
> issues **#142** (complete `contextId`-only CLI resolution) and **#143**
> (regenerate parent/child workflows for `contextId`-only child execution).
> Both issues are now closed and this contract is fully implemented.
>
> For the operational guide to the current workflow, see
> [docs/parent-child-workflow.md](../parent-child-workflow.md).

---

## Overview

In the target contract the parent workflow creates a context record and passes
**only** the Create Context stdout to the child trigger. The child reads
`contextId` from the trigger payload and passes `--context-id` to all CLI
invocations. The CLIs resolve `sessionId` internally from the context store —
the child never receives or forwards `sessionId` directly.

Direct `--session-id` invocation remains supported for manual and direct CLI
usage outside of n8n workflows.

---

## Parent Responsibilities

### 1 — Create the context record

The parent's **Create Context** node calls the `create-context` CLI, which
writes a context record to the store and returns a `contextId`.

Expected stdout shape (JSON, single line):

```json
{"ok":true,"contextId":"2415"}
```

The `contextId` is an opaque string key that maps to a stored context entry.

### 2 — Pass only Create Context stdout to the child

The parent's **Call Phase Runner** node passes only the Create Context stdout to
the child trigger. The child receives no `sessionId` field directly.

---

## Child Responsibilities

### 3 — Parse contextId from When Called by Parent

The child reads `contextId` from the trigger payload using the named node
reference:

```
JSON.parse($("When Called by Parent").first().json.stdout).contextId
```

Using the named node reference avoids the `$json` overwrite problem — after each
Execute Command node, `$json` contains that command's stdout, not the original
trigger payload.

### 4 — Pass --context-id to all CLI invocations

Each Execute Command node in the child passes only `--context-id <contextId>`.
The CLIs resolve `sessionId` from the context store internally.

| CLI | `--context-id` | `--session-id` |
|---|---|---|
| `github-intake` | required (contextId-only path) | supported for direct usage |
| `run-one-phase` | required (contextId-only path) | supported for direct usage |
| `dispatch-outbox` | required (contextId-only path) | supported for direct usage |

---

## CLI Argument Contract

### --context-id (primary path in target contract)

```
--context-id <contextId>
```

When supplied, the CLI looks up the context record in the store and resolves
`sessionId` from it. This is the primary invocation path in the parent/child
workflow under the target contract.

### --session-id (direct usage / manual invocation)

```
--session-id <sessionId>
```

Remains supported for direct CLI usage, manual testing, and invocations outside
the parent/child workflow.

---

## Error Cases

| Scenario | Error |
|---|---|
| CLI called without `--context-id` and without `--session-id` | `--context-id or --session-id is required` |
| `run-one-phase` called without any run-ID source | `--run-id is required when --context-id is not provided` |
| Unknown `contextId` supplied | `Unknown contextId: <id>` |
| Unknown `sessionId` supplied | `Unknown sessionId: <id>` |

All error cases exit non-zero and write a machine-readable error to stdout
so that n8n can surface the failure through the execution panel.

---

## Rationale

Passing only `contextId` to the child decouples the parent from session-specific
details:

1. **Removes session coupling** — the parent does not need to read `sessionId`
   from the Config node to forward it to the child.
2. **Single source of truth** — `sessionId`, `repoRoot`, and related fields are
   resolved from the context record, not re-read from multiple Config fields at
   workflow design time.
3. **Stable run IDs** — `contextId` serves as a deterministic run identifier for
   `run-one-phase`, ensuring artifact paths remain consistent across retries.
