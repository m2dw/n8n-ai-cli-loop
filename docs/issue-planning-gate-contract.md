# Pre-Implementation Issue Planning Gate (contract)

Issue: #295

The planning gate reviews a GitHub issue **before** automated implementation
starts, so scope, dependency, design, effort, and split risks are caught early
instead of surfacing after many implementation/review cycles.

This document specifies the contract for the first, read-only slice: an admin
preview command that analyzes an issue and emits a structured planning artifact.
Automatic n8n routing into the gate is a deliberate follow-up.

> **Direction (issue #357):** the deterministic heuristic described below is
> **no longer the primary semantic classifier**. It is retained as a hard guard,
> feature extractor, baseline estimate, and fixture source, while semantic
> classification moves to an AI Planner arbitrated by an explicit policy gate. See
> [ai-planner-gate-architecture.md](ai-planner-gate-architecture.md) for that
> architecture.

## Command

```sh
node dist/cli/admin.js issue-plan preview \
  --session-id <id> \
  --issue-number <n> \
  [--comment-limit <n>] \
  [--sessions-path <path>]
```

- `--comment-limit` defaults to 10 and is clamped to 50.
- Output defaults to structured JSON (machine-consumable). `--quiet` / `--verbose`
  apply as for other admin commands.

## Structured planning result

The preview derives a structured result (the testable contract). Exact field
values are deterministic for a given issue snapshot.

```jsonc
{
  "decision": "ready | needs_clarification | split_required | blocked | high_risk",
  "complexity": "low | medium | high | xhigh",
  "recommendedImplementationEffort": "low | medium | high | xhigh",
  "recommendedReviewEffort": "low | medium | high",
  "recommendedFlow": "code | docs | research | custom-profile",
  "summary": "...",
  "risks": ["..."],
  "suggestedChildIssues": ["..."],
  "acceptanceCriteria": ["..."],
  "source": "heuristic",
  "readyForImplementation": true
}
```

### Decision semantics

Decisions are assigned by precedence:

1. `blocked` — the issue declares a `blocked by` / `depends on` relationship.
2. `split_required` — the issue asks to be split (child issues / sub-issues), or
   is `xhigh` complexity with two or more suggested child issues.
3. `high_risk` — `xhigh` complexity, a security-sensitive `high`-complexity
   change, or a change that touches workflow semantics / operational policy.
4. `needs_clarification` — ambiguous goals, conflicting criteria, or no
   acceptance criteria found.
5. `ready` — small and clear; may auto-advance to implementation.

`readyForImplementation` is `true` only for the `ready` decision. Every other
decision means the gate should **stop before implementation** and request human
confirmation. If a split is warranted, `suggestedChildIssues` proposes the
candidate children; the gate does **not** create them in this slice.

### Complexity / effort

`complexity` starts from a structural score (body length, section count, number
of acceptance criteria, count of referenced issues) and is then raised — never
lowered — by an existing `complexity:*` label and by risk detections.
`recommendedImplementationEffort` tracks complexity. `recommendedReviewEffort`
tracks complexity, is bumped for security-sensitive changes, is raised (never
lowered) by an existing `review:*` label, and is capped at `high`.

The heuristic is intentionally conservative and currently over-predicts risk on
some `easy` issues. [`docs/issue-plan-backtest.md`](issue-plan-backtest.md)
records a reproducible baseline of where it over- and under-fires over a labeled
fixture set, so calibration progress is measurable rather than anecdotal.

## State model

- The planning result is persisted in a **local artifact** and echoed in the
  command's JSON output. It is **not** stored in a label-heavy control plane.
- Existing `complexity:*` / `review:*` labels are read as **compatibility hints
  only**. The gate never requires new labels and never mutates labels in this
  slice.
- The artifact is auditable (carries a content fingerprint and provenance) and
  reusable by later implementation/review phases.

## Artifacts

Written under `<artifactRoot>/issue-plan/issue-<n>/`:

- `issue-plan-context.json` — bounded issue snapshot (title, labels, body,
  recent comments), the structured `plan`, a content `fingerprint`, and
  isolation metadata. This is the auditable, reusable record.
- `issue-plan-prompt.md` — an optional prompt that an **isolated** AI agent could
  use to refine the heuristic baseline. Provided for the future routing/post
  slice; it is a preview artifact only and is never auto-executed or auto-posted.

## Safety boundaries

- **Read-only with respect to GitHub.** The command reads issue data via an
  injectable read-only reader and writes only local artifacts. It never posts
  comments, mutates labels/state, creates branches/PRs, or enqueues tasks. The
  module imports no GitHub write surface.
- **Untrusted input.** The issue body and comments are attacker-controllable.
  They are bounded in size, scanned only as data (keyword matching on lowercased
  text), and never interpreted as instructions. Derived lists are capped in
  count and per-item length.
- **No agent in the preview path.** The structured result is computed
  deterministically, so it is reproducible and unit-testable. Any future agent
  refinement must run with write-enabling env vars stripped (the same isolation
  contract as `issue-discuss`, recorded in the artifact's `isolation` block).

## Non-goals (first slice)

- No full project manager / workflow engine.
- No automatic creation of child issues.
- No automatic mutation of GitHub labels.
- Does not replace assignment profiles.
- Not required for every issue until the read-only path proves useful.
