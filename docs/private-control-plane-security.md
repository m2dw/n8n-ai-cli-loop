# Private Control-Plane Security Posture

This document states the deployment boundary and security model for
`n8n-ai-cli-loop`. Future designs for Tool Requests, grants, issue-discuss,
advisor, and any other AI orchestration feature should treat this document as
authoritative when a tradeoff between security and usability must be resolved.

---

## 1. Intended Deployment Model

`n8n-ai-cli-loop` is designed for **private/internal AI automation control
planes**. The primary orchestration surface — GitHub Issues used for task
intake, AI planning artifacts, Tool Request handoffs, run metadata, and
internal recovery details — must live in a **private** repository or a
genuinely access-controlled internal system.

**Do not use public GitHub Issues or public PR comments as the primary
orchestration channel for AI planning, Tool Requests, run metadata, or
internal recovery details.**

Public repositories that the project targets (the repositories an agent files
PRs against) are user-facing surfaces. They may receive:

- Normal pull requests with public-safe descriptions.
- Public release notes.
- Summarized, user-facing comments.

They must not receive raw AI planning output, Tool Request blocks, detailed
run logs, local file paths, or any artifact that would expose internal
orchestration state to the public internet.

---

## 2. Human-Curated Input Boundary

The intended data flow from external users into the private control plane is:

```text
external user
  -> public GitHub / support channel / other user-facing surface
  -> benevolent human review, summarization, and selection
  -> private AI control-plane Issue
  -> n8n-ai-cli-loop processing
```

External text must **not** be written directly into AI orchestration Issues
without a benevolent human review step. The private control plane is not
designed to accept arbitrary direct external input.

### What this means in practice

1. **External users must not directly write to private AI orchestration
   Issues.** Write access to the private control-plane repo must be limited to
   operators and trusted contributors.

2. **External reports should pass through human review first.** Before copying,
   summarizing, or converting an external report into an AI control-plane Issue,
   a human operator should read and evaluate it.

3. **Human-curated input is lower risk than arbitrary public input, but it is
   not fully trusted.** A human reviewer may inadvertently copy malicious text,
   be deceived by a social-engineering attack, or introduce misleading
   instructions. Copied external content can still contain prompt injection
   payloads.

4. **Safeguards remain in place.** The system keeps explicit side-effect
   boundaries, run logs, review steps, and operator-controlled risk acceptance
   regardless of how an Issue was authored.

5. **Designs must not assume a hostile public Issue surface** unless a
   deployment explicitly opts into that unsupported model. The default
   assumption is a private control plane with human-reviewed input; adding
   complexity or restrictions to accommodate a fully public control plane is
   out of scope.

---

## 3. Public vs. Private Surfaces

| Surface | Role | Acceptable content |
|---|---|---|
| Private orchestration repo (Issues, comments) | AI control plane | Planning artifacts, Tool Requests, run metadata, grant decisions, internal paths, recovery instructions |
| Public target repo (PRs, public comments) | User-facing | Summarized PR descriptions, release notes, user-facing comments only |
| Local artifact store (`.n8n-artifacts/`) | Local state | All internal artifacts; never published directly |

---

## 4. GitHub Issue Bodies and Comments Are Untrusted Input

Even in a private deployment, GitHub issue bodies and comments are untrusted
input. An operator or contributor with write access to the private repo could
craft a malicious issue body. External actors are a smaller risk in private
repos but the attack surface is not zero.

Consequences for implementation:

- **Never execute strings from issue bodies or comments as shell commands**
  without explicit sanitization and intent checking.
- **Never follow hyperlinks or embedded instructions** in issue bodies as
  implicit operator directives — only structured labels, relationships, and
  handler-level configuration count as control signals.
- **Prompt injection is in scope.** AI agents reading GitHub issue content
  must be designed with the understanding that the content could attempt to
  hijack the agent's behavior. Structural guards (label gates, dependency
  gates, allowedTools restrictions) are the primary defense, not trust in the
  content itself.

This posture applies even when the private repo has a small, trusted team:
the rule is enforced by design, not by counting contributors.

---

## 5. Security Controls Should Not Make the Workflow Unusable

Security mitigations must protect operators without distorting the core
automation workflow. When a security control conflicts with core functionality,
the preferred resolution is an **explicit operator risk-acceptance mode** — not
silently weakening the feature or forcing an awkward fallback workflow.

Guiding principles:

1. **Default to safer behavior.** Features that interact with external input
   (issue bodies, PR comments, webhook payloads) should use the most
   restrictive interpretation by default.

2. **Keep risky actions explicit and visible.** When a less restrictive mode
   is available, it must be opt-in, clearly named, and emit a visible warning
   at runtime so the operator knows they are running outside the default
   posture.

3. **Prefer opt-in over distorted design.** If the only way to keep a feature
   strictly safe is to make it useless or require an awkward multi-step
   workaround, prefer implementing the feature with a clear operator opt-in /
   risk-acceptance path rather than degrading the feature or abandoning it
   entirely.

4. **Configurable where reasonable.** Security mitigations that have a
   meaningful cost to usability should be configurable per-deployment so that
   a private/internal operator can make an informed tradeoff decision.

5. **Do not design for a public control plane.** The project does not support
   running the AI orchestration loop against a public GitHub repo. Do not add
   complexity, restrictions, or awkward UX to accommodate that unsupported
   case. If a future issue proposes public-control-plane support, that is a
   separate project scope requiring its own security model.

---

## 6. Operator Risk-Acceptance Pattern

When a security mitigation would materially reduce functionality in a
private/internal deployment, implementations should follow this pattern:

1. **Document the risk** in the relevant spec or handler comment, naming
   the concrete threat being mitigated.
2. **Default to the safer behavior** — the mitigation is on unless opted out.
3. **Provide an explicit opt-out** — a configuration key, environment
   variable, or label that signals operator acknowledgement of the tradeoff.
4. **Emit a warning at runtime** when the opt-out is active, so the choice
   remains visible across upgrades and operator rotations.
5. **Never silently apply the less restrictive behavior** — a missing config
   key must always resolve to the safer default.

Example wording for a runtime warning when an opt-out is active:

```
[WARN] <feature-name> risk-acceptance mode is active.
  The operator has opted out of <mitigation-name>.
  Risk: <one-line description of the threat>.
  To restore safe defaults, unset <CONFIG_KEY> or remove label <label>.
```

---

## 7. Applicability to Feature Design

This posture applies to all AI orchestration features, including but not
limited to:

- **Tool Request / grant** — Grants are operator decisions made in the private
  control plane. Tool Request blocks in issue comments are internal artifacts
  and must not appear in public repositories. Grant mechanics should not be
  made so restrictive that they prevent legitimate automation; operators in
  private deployments may accept broader grant scopes with a visible warning.
  The redesigned operator flow — guided runs, low-impact execution, and the
  execution-environment opt-ins that consume this posture — is specified in
  [docs/tool-request-redesign.md](tool-request-redesign.md) (issue #428).

- **Issue-discuss / advisor** — Conversations between the advisor and issue
  content are conducted on private orchestration issues or local artifacts.
  Summaries surfaced to public repos must be scrubbed of internal details.

- **Issue intake** — Label gates and dependency gates are the structural
  controls that prevent arbitrary issue content from driving agent behavior.
  They must remain in place regardless of operator opt-ins.

- **allowedTools** — The narrow `allowedTools` surface described in
  [docs/tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md)
  is a security boundary, not a convenience limitation. Broadening it requires
  explicit justification and must follow the operator risk-acceptance pattern
  above.

---

## 8. Summary

> `n8n-ai-cli-loop` is designed for private/internal AI automation control
> planes. Do not use public GitHub Issues or public PR comments as the primary
> orchestration channel for AI planning, Tool Requests, run metadata, or
> internal recovery details.
>
> External user input must pass through benevolent human review before being
> written into AI control-plane Issues. The private control plane is not
> designed for direct external access. Human-curated input is lower risk than
> arbitrary public input but is not fully trusted — copied external text can
> still contain prompt injection payloads.
>
> Security controls should protect operators without making the workflow
> unusable. When a security control conflicts with core functionality, prefer
> an explicit operator risk-acceptance mode over silently weakening the feature
> or forcing an awkward workflow. Public-safe defaults remain important, but
> private/internal deployments may opt into broader functionality with clear
> warnings.
>
> GitHub issue bodies and comments are untrusted input even in private
> deployments. Structural guards — not content trust — are the primary defense
> against prompt injection and malicious inputs.
