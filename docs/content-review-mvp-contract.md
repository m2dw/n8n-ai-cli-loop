# Content Review MVP — Editorial Review and Human-Handoff Contract

## Purpose

This document records the approved execution-boundary, artifact, and human-handoff contract for the content editorial-review MVP. It is the authoritative reference for what the MVP guarantees and what it explicitly defers to deployment-time or later issues. This contract is forward-looking: it defines the approved defaults for issue #603 and #604 to implement. The current runtime does not need to already implement the review phase for this contract to be valid.

## Relationship to Upstream Contracts

The content review phase is a downstream consumer of the content draft phase. Its input contract references both the content-draft MVP contract ([content-draft-mvp-contract.md](content-draft-mvp-contract.md)) and the content-research MVP contract ([content-research-mvp-contract.md](content-research-mvp-contract.md)) as upstream sources of truth. The review phase does **not** re-derive, relax, or copy assumptions from those contracts — those documents govern their respective phases only.

## Approved Defaults

### Review working directory (cwd)

The review agent runs from its **per-run artifact directory**, not from the repository root and not from the repository working tree. This is the same operational-separation convention used by the research and draft agents. The agent cannot modify the target repository through its execution cwd.

### Trust model

The same trust posture that applies to the content research and draft phases applies here. Inputs derived from issue fields and draft artifacts are treated as untrusted prompt inputs even after human screening upstream. The MVP does not implement structural prompt-injection isolation beyond the private-execution environment boundary.

### Operational separation

The MVP guarantees **operational separation only**:

- The review agent's cwd is the per-run artifact directory.
- The handler writes review outputs exclusively to the per-run artifact directory.
- The review phase does not modify, commit, or push the target repository.

This separation is a convention enforced by code, not by an OS or container boundary.

### Security posture

The MVP **does not** claim:

- An OS-level or container-level security sandbox.
- Complete adversarial prompt-injection resistance.

Host-level sandboxing, containerization, network policy, and filesystem isolation are deployment and runtime concerns, not MVP deliverables.

### Reviewer policy

Reviewers must evaluate this contract against this Issue body and the upstream draft/research contracts only. Reviewers must not require OS/container sandboxing as a P1 blocker unless a later Issue explicitly changes this policy. The current runtime is not required to already implement the review phase.

## Input Contract

### Accepted inputs

The review agent accepts only the following bounded inputs:

1. **Issue title and body** — the same bounded Issue title and body fields accepted by the research and draft phases. These fields are treated as untrusted prompt inputs and bounded to a fixed character limit. They are the sole issue-level inputs.
2. **Validated draft artifact** — the `content-draft-output.md` produced by the draft phase, identified through stable task-context artifact metadata (e.g. a well-known artifact key or path under the per-run artifact directory of the upstream draft run). Only the validated draft itself is consumed; see Excluded inputs below.
3. **Validated research brief** — when present, the `content-research-validated-brief.md` produced by the research phase, identified through stable task-context artifact metadata. The research brief is an optional input; the review phase must succeed without it if the upstream research phase was not run.

All three accepted inputs are identified through task-context metadata, not by scanning arbitrary artifact paths or by reading upstream run artifact directories directly.

### Excluded inputs

The following must not be used as review inputs, even when present in the artifact directory:

- Raw draft agent stdout or stderr.
- Raw research agent stdout or stderr.
- Research or draft agent prompts or diagnostic output.
- Malformed, partial, or unvalidated draft or research output.
- Local filesystem paths.
- Credentials, tokens, or secrets.
- Source code excerpts, external source fetches, or URL content.
- Any field not listed under Accepted inputs above.

Automatic fetching of external URLs is not supported. Revision-aware source syntax such as `path@sha` is not supported in the MVP. Arbitrary remote sources are not ingested.

## Artifact Identity

Each review run is identified by a per-run artifact directory, consistent with the pattern used by other phases. The per-run artifact directory contains the review phase's output files. The run's identity is carried in task-context metadata, not inferred from directory-listing state.

Required artifacts produced by the review phase:

- `content-review-prompt.md` — the prompt submitted to the review agent.
- `content-review-findings.md` — the full local editorial findings produced by the agent, including detailed feedback. This file remains local.
- `content-review-result.json` — the structured result record (outcome enum, bounded metadata; see Public-Status Contract below).

When the outcome is `needs_fix`, the handler may additionally persist a bounded fix-feedback record in task context so the draft agent can consume it in a subsequent run. This record must not duplicate detailed findings verbatim; it carries only the structured fix guidance needed to drive the next draft cycle.

These artifacts are **local only** and are never forwarded to GitHub, Slack, or any notification channel, except for the explicitly approved bounded fields described in the Public-Status Contract.

## Fix Feedback Policy

When the outcome is `needs_fix`, detailed editorial findings are stored in the local `content-review-findings.md` artifact. A bounded fix-feedback record derived from those findings may be persisted in task context for the draft agent's next run. This record is a structured internal signal — not a human-readable narrative — and it is consumed only by the draft phase handler.

Fix feedback **must not** be:

- Posted verbatim to GitHub (as a comment, label, or issue update).
- Included in any notification-channel message.
- Forwarded to any human-visible output channel as raw editorial text.

## Repository-Mutation Policy

The review phase **does not** modify the target repository. Specifically:

- No files in the repository working tree are edited.
- No `git` operations (commit, push, checkout, add, restore, clean) are run by the review handler or the review agent.
- No `gh` operations (PR creation, PR comment, label change) are run by the review handler or the review agent.
- Review findings remain local run artifacts in the per-run artifact directory.

Publication of the reviewed draft to the target repository or any external destination is an explicit human-controlled action and is outside the automated MVP (see Human Handoff below).

## Public-Status Contract

### Output boundary

Draft text, research text, editorial findings, source excerpts, prompts, validation feedback, diagnostic output, raw errors, fix-feedback text, and local filesystem paths remain in local run artifacts only. They are never forwarded to GitHub, Slack, or any notification channel.

GitHub and notification output may contain only a fixed outcome enum value and explicitly approved bounded metadata. The following must not appear in any GitHub-visible or notification-visible path:

- Draft text or self-review text of any kind.
- Research text or research brief content.
- Editorial findings or review commentary of any kind.
- Fix feedback text, whether structured or free-form.
- Raw stdout or stderr, even bounded excerpts.
- Validation feedback, diagnostic strings, or raw error objects.
- Credentials, tokens, or secrets.
- Unredacted stack traces.
- Local filesystem paths.

### Outcome enums

The review phase reports one of the following fixed outcome values in `content-review-result.json` and any GitHub-visible status update. Each outcome has exactly one unambiguous downstream transition:

| Outcome | Meaning | Transition |
|---|---|---|
| `success` | The draft passed editorial review and is ready for human export or publication. | Advance to human handoff; no automated follow-up. |
| `needs_fix` | The draft requires revision. Bounded fix feedback has been persisted in task context for the draft agent. | Return to draft phase for a subsequent run. |
| `blocked` | The review could not be completed (e.g. missing or invalid draft input, agent error). | Surface the bounded error status; no automated retry. |

No free-form outcome strings are permitted.

### Approved bounded metadata

In addition to the outcome enum, a GitHub-visible result record may carry the following bounded metadata fields only:

- `issueNumber` — integer.
- `runId` — opaque string, must not encode local paths.
- `reviewArtifactKey` — the artifact key under which the local review findings can be located (opaque identifier, not a filesystem path).
- `readyForHuman` — boolean; `true` only when outcome is `success`.

All other fields remain local.

## Human Handoff

When the outcome is `success` and `readyForHuman` is `true`, the reviewed draft is available for human export or publication. The automated MVP stops here. Specifically:

- The system does not automatically commit, push, open a PR, post a comment, or publish the draft to any destination.
- The human operator retrieves the draft from the local per-run artifact directory using the `reviewArtifactKey` reference.
- All export, formatting, publication, and distribution decisions are made by the human operator.

This is an intentional scope boundary, not an oversight. It ensures that no content is published without explicit human intent.

For the operator-facing walkthrough of this handoff — how to locate the local draft and findings, and what approve/export, request-revision, and reject actually look like in practice — see [content-human-ready-handoff.md](content-human-ready-handoff.md).

## Deferred Capabilities (Explicit Non-Goals for the MVP)

The following capabilities are out of scope for the MVP. They are intentional non-goals, not oversights:

| Capability | Rationale for deferral |
|---|---|
| Automated publication or export of the approved draft | Requires a publication handler, commit/push policy, and access-control design not yet scoped |
| Automated retry of the draft phase beyond a bounded cycle count | Requires a loop-termination policy and cycle-budget design not yet scoped |
| Rich structured fix-feedback schema passed to the draft agent | The bounded fix-feedback record format is an internal contract between the review and draft handlers; a versioned schema is deferred |
| Automatic external-source fetching as a review input | Requires a network-access design, DNS/redirect/SSRF policy, and security review not yet scoped |
| Structural prompt-injection input/tool boundary | Same rationale as the upstream contracts; deferred to a dedicated follow-up |
| OS/container sandbox enforcement | Deployment-specific; requires infrastructure decisions outside this codebase |
| Credential and path redaction framework broader than local artifact writes | `sanitizeBody` or equivalent covers local paths only; a generalised redaction policy covering credentials and all handler output types is not yet designed |
| Multi-reviewer or consensus-review mode | Single review agent per run only; multi-agent review coordination is not yet designed |
| Review versioning or incremental review updates | Single-run output only; multi-version review management is not yet designed |
| Human-notification of readiness beyond a GitHub status field | Push notifications, Slack DMs, or email alerts are deployment and runtime concerns |

These items should be addressed in dedicated follow-up issues and must not block MVP delivery.

## Scope Boundary

This document covers the content editorial-review workflow only. It does not supersede the security posture documented for other handlers or phases in this repository, and it does not modify the content-draft MVP contract or the content-research MVP contract.
