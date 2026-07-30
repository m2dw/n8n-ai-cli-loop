# Content Draft MVP — Execution and Artifact Contract

## Purpose

This document records the approved execution-boundary and artifact contract for the content draft MVP. It is the authoritative reference for what the MVP guarantees and what it explicitly defers to deployment-time or later issues. This contract is forward-looking: it defines the approved defaults for issue #602 to implement. The current runtime does not need to already implement the draft phase for this contract to be valid.

## Relationship to the Content Research Contract

The content draft phase is a downstream consumer of the content research phase. Its input contract references the content-research MVP contract ([content-research-mvp-contract.md](content-research-mvp-contract.md)) as the upstream source of truth for the research brief. The draft phase does **not** re-derive, relax, or copy assumptions from #600 / PR #619 — those issues concern the research phase only.

## Approved Defaults

### Draft working directory (cwd)

The draft agent runs from its **per-run artifact directory**, not from the repository root and not from the repository working tree. This is the same operational-separation convention used by the research agent. The agent cannot modify the target repository through its execution cwd.

### Trust model

The same trust posture that applies to the content research phase applies here. Inputs derived from issue fields and research artifacts are treated as untrusted prompt inputs even after human screening upstream. The MVP does not implement structural prompt-injection isolation beyond the private-execution environment boundary.

### Operational separation

The MVP guarantees **operational separation only**:

- The draft agent's cwd is the per-run artifact directory.
- The handler writes draft outputs exclusively to the per-run artifact directory.
- The draft phase does not modify, commit, or push the target repository.

This separation is a convention enforced by code, not by an OS or container boundary.

### Security posture

The MVP **does not** claim:

- An OS-level or container-level security sandbox.
- Complete adversarial prompt-injection resistance.

Host-level sandboxing, containerization, network policy, and filesystem isolation are deployment and runtime concerns, not MVP deliverables.

### Reviewer policy

Reviewers must not require OS/container sandboxing as a P1 blocker unless a later Issue explicitly changes this policy. Reviewers must evaluate this contract against the Issue body and the content-research MVP contract only. The current runtime is not required to already implement the draft phase.

## Input Contract

### Accepted inputs

The draft agent accepts only the following bounded inputs:

1. **Issue title and body** — the same bounded Issue title and body fields that are accepted by the research phase. These fields are treated as untrusted prompt inputs and bounded to a fixed character limit. They are the sole issue-level inputs.
2. **Content-research brief** — a validated research artifact, identified through stable task-context artifact metadata (e.g. a well-known artifact key or path under the per-run artifact directory of the upstream research run). Only the brief itself is consumed; see Excluded inputs below.

The content-research brief is identified through task-context metadata, not by scanning arbitrary artifact paths or by reading the research run's artifact directory directly.

### Excluded inputs

The following must not be used as draft inputs, even when present in the artifact directory:

- Raw research stdout or stderr.
- Research agent prompts or diagnostic output.
- Malformed, partial, or unvalidated research output.
- Local filesystem paths.
- Credentials, tokens, or secrets.
- Source code excerpts, external source fetches, or URL content.
- Any field not listed under Accepted inputs above.

Automatic fetching of external URLs is not supported. Revision-aware source syntax such as `path@sha` is not supported in the MVP. Arbitrary remote sources are not ingested.

## Artifact Identity

Each draft run is identified by a per-run artifact directory, consistent with the pattern used by other phases. The per-run artifact directory contains the draft phase's output files. The run's identity is carried in task-context metadata, not inferred from directory-listing state.

Required artifacts produced by the draft phase:

- `content-draft-prompt.md` — the prompt submitted to the draft agent.
- `content-draft-output.md` — the full local draft produced by the agent, including the draft text and self-review remarks.
- `content-draft-result.json` — the structured result record (outcome enum, bounded metadata; see Public-Status Contract below).

These artifacts are **local only** and are never forwarded to GitHub, Slack, or any notification channel.

## Repository-Mutation Policy

The draft phase **does not** modify the target repository. Specifically:

- No files in the repository working tree are edited.
- No `git` operations (commit, push, checkout, add, restore, clean) are run by the draft handler or the draft agent.
- No `gh` operations (PR creation, PR comment, label change) are run by the draft handler or the draft agent.
- The draft and self-review remain local run artifacts in the per-run artifact directory.

Publication of the generated draft to the target repository is a deferred capability (see Deferred Capabilities).

## Public-Status Contract

### Output boundary

Raw draft text, self-review text, research text, source excerpts, prompts, validation feedback, diagnostic output, raw errors, and local filesystem paths remain in local run artifacts only. They are never forwarded to GitHub, Slack, or any notification channel.

GitHub and notification output may contain only a fixed outcome enum value and explicitly approved bounded metadata. The following must not appear in any GitHub-visible or notification-visible path:

- Draft text or self-review text of any kind.
- Research text or research brief content.
- Raw stdout or stderr, even bounded excerpts.
- Validation feedback, diagnostic strings, or raw error objects.
- Credentials, tokens, or secrets.
- Unredacted stack traces.
- Local filesystem paths.

### Outcome enums

The draft phase reports one of the following fixed outcome values in `content-draft-result.json` and any GitHub-visible status update:

| Outcome | Meaning |
|---|---|
| `draft_complete` | The draft and self-review were produced and written to local artifacts. |
| `draft_failed` | The draft agent exited non-zero or produced no output. |
| `input_invalid` | The accepted inputs could not be validated (e.g. research brief missing or malformed). |

No free-form outcome strings are permitted.

### Approved bounded metadata

In addition to the outcome enum, a GitHub-visible result record may carry the following bounded metadata fields only:

- `issueNumber` — integer.
- `runId` — opaque string, must not encode local paths.
- `draftArtifactKey` — the artifact key under which the local draft can be located (opaque identifier, not a filesystem path).

All other fields remain local.

## Deferred Capabilities (Explicit Non-Goals for the MVP)

The following capabilities are out of scope for the MVP. They are intentional non-goals, not oversights:

| Capability | Rationale for deferral |
|---|---|
| Publication or export of the draft to the target repository or any external destination | Requires a publication handler, commit/push policy, and access-control design not yet scoped |
| Automatic external-source fetching as a draft input | Requires a network-access design, DNS/redirect/SSRF policy, and security review not yet scoped |
| Structural prompt-injection input/tool boundary (delimiter isolation, write-tool restriction, or equivalent) | Same rationale as the content-research MVP contract; deferred to a dedicated follow-up |
| OS/container sandbox enforcement | Deployment-specific; requires infrastructure decisions outside this codebase |
| Credential and path redaction framework broader than local artifact writes | `sanitizeBody` or equivalent covers local paths only; a generalised redaction policy covering credentials and all handler output types is not yet designed |
| Source-file bundle selection for draft context | The agent's cwd is the isolated per-run artifact directory; granting access to repository source files requires a source-selection layer and agent tool restriction not yet designed |
| Git-revision-aware source resolution (`path@sha` syntax) | Requires a resolver and integrity-check layer not yet designed |
| Self-review routing to automated fix cycles | Research and draft phases are not currently wired into the review/fix loop |
| Draft versioning or incremental draft updates | Single-run output only; multi-version draft management is not yet designed |

These items should be addressed in dedicated follow-up issues and must not block MVP delivery.

## Scope Boundary

This document covers the content draft workflow only. It does not supersede the security posture documented for other handlers or phases in this repository, and it does not modify the content-research MVP contract.
