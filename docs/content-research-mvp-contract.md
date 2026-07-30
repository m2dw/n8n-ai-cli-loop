# Content Research MVP — Trusted-Private Execution Boundary Contract

## Purpose

This document records the approved execution-boundary contract for the content research MVP. It is the authoritative reference for what the MVP guarantees and what it explicitly defers to deployment-time or later issues.

## Approved Defaults

### Trust model

Content workflow inputs originate from a private repository and are screened by a human before entering the workflow. Human screening reduces the likelihood of accidental or malicious injection, but **inputs are still treated as untrusted**: copied content can contain prompt-injection payloads even after human review, and the workflow must not rely on screening as a security boundary. Structural enforcement of an input/tool boundary (delimiter isolation, write-tool restriction, or equivalent) is a deferred capability (see Deferred Capabilities); the MVP does not implement prompt-injection isolation beyond the private-execution environment boundary.

### Execution environment

The workflow operates in a low-impact private execution environment. It is not exposed to the public internet or to untrusted third-party callers.

### Operational separation

The MVP guarantees **operational separation only**:

- The agent runs with the per-run artifact directory as its working directory (`cwd: artifact directory`). This ensures the agent cannot modify the target repository through its execution cwd.
- The handler writes outputs exclusively to the per-run artifact directory and does not intentionally mutate repository files.

This separation is a convention enforced by code, not by an OS or container boundary.

### Security posture

The MVP **does not** claim:

- An OS-level or container-level security sandbox.
- Complete adversarial prompt-injection resistance.

Host-level sandboxing, containerization, network policy, and filesystem isolation are deployment and runtime concerns, not MVP deliverables.

### Reviewer policy

Reviewers must not require OS/container sandboxing as a P1 blocker unless a later Issue explicitly changes this policy.

## Input Contract

### Accepted inputs

- The bounded Issue title, URL, labels, and body. These fields are interpolated into the research prompt by `buildPrompt` and are treated as untrusted prompt inputs. The body is delimited as input data using HTML comment delimiters (`<!-- begin:issue-body-input -->` / `<!-- end:issue-body-input -->`) and bounded to a fixed character limit to prevent prompt bloat.
- The agent runs in the isolated per-run artifact directory; it does not have access to the repository worktree. Source-file selection and repository access are deferred capabilities (see Deferred Capabilities).

### Excluded inputs

- Automatic fetching of external URLs is not supported.
- Revision-aware source syntax such as `path@sha` is not supported in the MVP.
- Arbitrary remote sources are not ingested.

## Public-Status Contract

### Output boundary

Raw stdout, stderr, research findings, prompts, validation text, source excerpts, local paths, and credentials remain in local run artifacts only (under the per-run artifact directory). They are never forwarded to GitHub, Slack, or any notification channel.

GitHub and notification output may contain only a fixed outcome/status value and explicitly approved bounded metadata. The following must not appear in any GitHub-visible or notification-visible path:

- Research findings or agent output of any kind.
- Raw stdout or stderr, even bounded excerpts.
- Credentials, tokens, or secrets.
- Raw error objects, unredacted stack traces, or diagnostic strings from agent runs.
- Local filesystem paths.

A failed handler result uses a fixed public-safe summary string. The raw diagnostic output remains in `content-research-output.md` in the local artifact directory.

## Deferred Capabilities (Explicit Non-Goals for the MVP)

The following capabilities are out of scope for the MVP. They are intentional non-goals, not oversights:

| Capability | Rationale for deferral |
|---|---|
| OS/container sandbox enforcement | Deployment-specific; requires infrastructure decisions outside this codebase |
| Structural prompt-injection input/tool boundary (delimiter isolation, write-tool restriction, or equivalent) | `buildPrompt` interpolates title, URL, and labels verbatim; no delimiter or tool restriction is applied in the MVP |
| Strong adversarial prompt-injection containment | Requires a threat model and input sanitisation layer not yet designed |
| Deployment-specific network policy | Depends on the target runtime environment (bare metal, Docker, cloud VM, etc.) |
| Deployment-specific filesystem isolation | Same rationale as network policy |
| Repository source-file selection and narrowly bounded file bundle | The agent's cwd is the isolated per-run artifact directory and it does not have access to the repository worktree. Granting access to a narrowly selected and bounded source-file bundle requires a source-selection layer and agent tool restriction not yet designed. |
| External-source fetching with DNS, redirect, and SSRF policy | Requires a network-access design and security review not yet scoped |
| Git-revision-aware repository source resolution (`path@sha` syntax) | Requires a resolver and integrity-check layer not yet designed |
| Broader public-output redaction framework (including credential redaction) | `sanitizeBody` redacts only filesystem paths; a generalised redaction policy covering credentials and all handler output types is not yet designed |

These items should be addressed in dedicated follow-up Issues and must not block MVP delivery.

## Scope Boundary

This document covers the content research workflow only. It does not supersede the security posture documented for other handlers or phases in this repository.
