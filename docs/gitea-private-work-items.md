# Gitea-Backed Private Work-Item Mode

This document specifies how the project supports **Gitea as a private
work-item backend** for AI-driven development while keeping the user-facing
**GitHub** source repository clean. It builds on the provider split already
described in [provider-architecture.md](provider-architecture.md): a
`WorkItemProvider` (issues/tickets, queue, dependencies, comments, coarse
state) is independent of a `RepoHostProvider` (branches, pull requests, PR
conversation/state).

It is a **design specification only**. No behavior change is required to land
this document, and per the issue that scopes it, the Gitea provider itself is
**not** implemented here. The current `gh`-CLI workflow remains the MVP. The
goal is to fix the topology, the visibility rules, and the trust boundary
*before* implementing Gitea support, and to name the follow-up slices.

## Motivation

The need is **not** simply "another issue tracker." Public GitHub issues are
user-facing: a maintainer, a contributor, or a drive-by reader sees them. But
an AI development loop generates material that does not belong on a public,
user-facing surface:

- the **prompts** handed to agents (which encode internal policy and phrasing),
- **raw agent output** (which may be verbose, speculative, or wrong),
- **review feedback**, **tool requests**, and **quota / rate-limit notes**,
- internal workflow bookkeeping that would be **label noise** in public.

Two distinct risks motivate moving this material off public GitHub:

1. **Internal exposure.** Raw AI exchanges can leak internal reasoning,
   file paths, command lines, environment details, and half-formed plans that
   should not be published to a user-facing repository.
2. **Prompt-injection amplification.** A public issue or comment is an
   *untrusted* channel an attacker can write to. Echoing agent prompts and
   tool-request mechanics back onto that same public surface hands an attacker a
   map of the control plane and a louder amplifier. Keeping the AI exchange on a
   private surface narrows what an attacker can see and influence.

> **First-class design goal:** Hiding AI interaction from the public GitHub
> repository is a primary objective of this mode, not an incidental
> side effect. The default for prompts and raw agent output is *local only*;
> publishing anything to GitHub is an explicit, summarized, sanitized step.

## Desired MVP Topology

```txt
WorkItemProvider = Gitea issues   (private AI workflow state + AI-visible discussion)
RepoHostProvider = GitHub         (public source repo + pull requests)
```

- **Gitea** holds the private AI workflow state: the queue the loop selects
  from, the coarse status/labels, dependency relationships, and the
  bounded/sanitized internal workflow comments the agents read and write.
  Gitea may be self-hosted or otherwise private, so it can carry **richer**
  internal commentary than a public GitHub issue would tolerate.
- **GitHub** stays the public source of truth for code: branches, pull
  requests, and PR review. Public GitHub issues remain **user-facing**; raw AI
  exchanges are not posted there.

This is a **cross-provider pairing** in exactly the sense the provider
architecture already anticipates (compare the "Jira work items + GitHub repo
host" example). The branch join key generalizes from `ai/issue-<n>` to
`ai/<work-item-key>` — see "Joining a Gitea Work Item to a GitHub PR" below.

### Why the private surface is still not "trusted"

Self-hosted / private does **not** mean trusted. A Gitea issue body or comment
is still operator-or-attacker-authored text that an agent reads. Privacy
reduces *exposure*; it does not grant the text *authority*. The trust boundary
in "Prompt-Injection Boundary" below applies to Gitea content exactly as it
applies to GitHub content.

## Surfaces and Visibility Tiers

The core of this spec is a precise distinction between four surfaces and the
**maximum fidelity** of AI-derived content each may carry.

### The four surfaces

| Surface | What it is | Trust direction |
| --- | --- | --- |
| **Local artifacts** (`.n8n-artifacts/`) | Prompts and full agent output written to the local clone. | Output sink (local only) |
| **Private work-item comments** (Gitea) | Bounded, sanitized workflow records the loop reads/writes. | Both: untrusted *input* + bounded *output* |
| **PR comments / PR body** (GitHub) | Human-safe review handoff on the code-host side. | Output sink (public) |
| **User-facing issue comments** (GitHub) | Comments on public, human-owned GitHub issues. | Both: untrusted *input* + summary-only *output* |

### Visibility tiers

Three tiers describe the maximum fidelity allowed on each surface. A surface
may always carry *less* than its tier; it must never carry *more*.

- **Tier 0 — Raw (local only by default).** Full prompts and full agent
  output. Lives in local artifacts (`.n8n-artifacts/`) on the machine where the
  runner executes. Not pushed to any remote by default. This is the only tier
  permitted to contain raw prompts and unbounded agent output.
- **Tier 1 — Bounded / sanitized (private work item).** Workflow records
  written to **Gitea** issue comments: phase outcomes, decisions, tool-request
  status, quota notes, truncated excerpts. Bounded in size and **sanitized**
  (see the sanitization rules below). Richer than what GitHub may show, but
  never a verbatim dump of Tier 0.
- **Tier 2 — Summarized (public GitHub).** Human-safe summaries only on GitHub
  PR bodies, PR comments, and any user-facing issue comment. **No raw prompts,
  no local filesystem paths, no secrets, no private artifact paths, no
  Gitea-internal links that leak the private workflow.**

### Surface → permitted fidelity

| Surface | Raw prompts | Full agent output | Bounded internal record | Human summary |
| --- | :---: | :---: | :---: | :---: |
| Local artifacts (`.n8n-artifacts/`) | ✅ | ✅ | ✅ | ✅ |
| Gitea work-item comment | ❌ | ❌ (bounded excerpt only) | ✅ | ✅ |
| GitHub PR body / PR comment | ❌ | ❌ | ❌ | ✅ |
| GitHub user-facing issue comment | ❌ | ❌ | ❌ | ✅ (or nothing) |

Read the table as a ceiling, not a quota: the loop should default to the
**least** disclosure that still serves the surface's audience. When in doubt
about whether content is human-safe, it stays at Tier 0/Tier 1 and only a
summary crosses to GitHub.

### Sanitization rules for Tier 1 (Gitea) and Tier 2 (GitHub)

Before any agent-derived text leaves Tier 0, it is sanitized:

- **Bounded size.** Comments are truncated to a fixed budget; the full text
  stays in the local artifact. A Gitea comment may *reference* the artifact by
  a stable id, but does not inline it wholesale.
- **No secrets.** Tokens, keys, `Authorization` headers, and credential
  material are never emitted. This reuses the redaction posture already applied
  to GitHub App token handling (errors built from status lines, redaction
  filter as defense in depth — see provider-architecture.md).
- **Tier 2 additionally strips:** local filesystem paths, private artifact
  paths/ids, raw prompt text, and internal Gitea URLs. A Tier 2 summary is
  written for a human reader of the public repo and assumes that reader has no
  access to the private surface.

## Internal AI Comments vs Local Artifacts vs PR Comments vs Issue Comments

These four are deliberately different concepts and must not be collapsed:

- **Local artifacts** — Tier 0. The complete, unbounded record (prompt + agent
  output) for debugging and audit, kept on the runner's disk. Authoritative for
  "what actually happened," never the publication surface.
- **Internal AI comments** — Tier 1, on the **private Gitea** work item. The
  AI-visible discussion thread: bounded workflow records the loop both writes
  (phase results, decisions, tool-request status) and *reads back* on later
  phases. This is the surface where the loop's own narration lives.
- **PR comments** — Tier 2, on the **GitHub** code host. Human-safe review
  handoff tied to the diff. Read by reviewers (human or the review agent); they
  carry summaries and review verdicts, not raw prompts.
- **User-facing issue comments** — Tier 2, on **public GitHub** issues. The
  most conservative surface: a human-readable status/summary, or nothing. This
  is where a maintainer or external contributor reads, so it gets the least
  internal detail.

## Prompt-Injection Boundary

Both **GitHub** issue bodies/comments **and** **Gitea** issue bodies/comments
are **untrusted input** to agents. The fact that Gitea is private does not make
its contents trusted — see "Why the private surface is still not 'trusted'."

Untrusted text may **describe desired behavior** — "please refactor the parser,"
"this is blocked by #12," "use approach X." That is the legitimate content of a
work item. What it must **never** do is **override policy**. Specifically,
issue/comment text is data, not authority:

- It must not override **security policy** — it cannot authorize publishing
  secrets, exfiltrating credentials, or disabling redaction.
- It must not override **provider/config policy** — it cannot alter provider
  selection, auth mode, repo targets, or `sessions.json`-resolved configuration.
- It must not override **output/visibility policy** — it cannot promote Tier 0
  raw prompts or full agent output onto Tier 1 or Tier 2 surfaces, nor demand
  that internal artifacts be posted to public GitHub.
- It must not override **tool policy** — it cannot expand tool access, bypass
  the tool-request/grant gate, or escalate beyond the allowed tool set.

Concretely, an agent must **not** treat issue or comment text as authority to:

1. publish secrets or private artifacts to any surface;
2. change provider configuration, auth, or targets;
3. bypass or fast-forward human review / the review gate;
4. expand tool access or self-grant a tool request.

A request embedded in untrusted text that *would* require any of the above is
refused, and the refusal itself is a Tier 1 workflow record (bounded, on the
private item), not a Tier 2 public broadcast that teaches an attacker which
probes landed. This boundary holds **regardless of which provider** the text
came from.

## Provider Scope

This issue specifies the topology; it does not implement it. The implementation
scope is sliced as follows.

**In scope for the first implementation wave:**

- **Gitea `WorkItemProvider`** — issues as the private work-item tracker:
  `listCandidateItems`, `getItem`, `commentItem`, `transitionItem`, and
  `getDependencies` *if* a first-class equivalent exists (see "Dependency
  Degradation").

**Future work (explicitly out of scope unless a later design finds it
required):**

- **Gitea `RepoHostProvider`.** The MVP keeps **GitHub** as the repo host. A
  Gitea repo host is future work *unless* the implementation design discovers it
  is required for the MVP — which is not expected, because PRs stay on GitHub.
  *(Update: a Gitea `RepoHostProvider` has since been implemented as a separate
  slice — issue #365 — for deployments that eventually want PR-equivalents on
  Gitea too. It is independent of this work-item MVP, which still pairs Gitea work
  items with a GitHub repo host; see "How GitHub Maps Onto The Interfaces →
  `GiteaRepoHostProvider`" in [provider-architecture.md](provider-architecture.md)
  for how repo-host Gitea differs from work-item Gitea.)*
- **GitHub → Gitea automatic public-issue sync.** Mirroring public GitHub
  issues into Gitea (or vice versa) is future work and only happens if it is
  **explicitly scoped as its own slice**. This mode does not assume any
  automatic sync exists.

**Verification obligation for implementers:** Do **not** assume Gitea's REST
API is GitHub-compatible. Each implementation slice must verify the actual
Gitea API surface (endpoints, payloads, label/state semantics, and whether a
dependency/relationship API exists) rather than reusing GitHub call shapes.

## Dependency Degradation When Gitea Lacks Issue Relationships

GitHub provides first-class **Issue Relationships** (`blocked by`), which the
current `WorkItemProvider.getDependencies` reads to drive the stacked-execution
gate. Gitea may **not** expose an equivalent relationship API. The design must
degrade safely rather than fake it.

Today, `getDependencies` is a **required** method on `WorkItemProvider` (see
`src/providers/types.ts`): it MUST throw on error so callers fail closed, and
there is no `capabilities` descriptor. A provider cannot yet omit the method.
Making the dependency read an **optional capability** — so a provider can
declare it unsupported and callers consult a capability descriptor instead of
relying on a required method — is a **prerequisite interface change** that the
Gitea slice must land before it can adopt option 3 below; it is future work, not
part of the current contract. The Gitea provider chooses, in order of
preference:

1. **Native relationships, if Gitea exposes them.** If a verified Gitea
   dependency/relationship API exists, map it to `BlockedByEntry[]` and the
   stacked-execution gate behaves exactly as on GitHub. (Implementers must
   confirm this API actually exists; do not assume.) This fits the current
   required-method contract with no capability-model change.
2. **A documented body/label convention, if relationships are absent.** A
   bounded, parseable convention in the issue body or a dedicated label (e.g. a
   `blocked-by: <key>` marker) that the provider reads deterministically. This
   is opt-in and explicit, never inferred from free-text. It also fits the
   current contract: the method is still implemented, just backed by a
   convention.
3. **Declare the capability absent (requires the capability-model change
   above).** If neither is available, the prerequisite change adds a capability
   descriptor so the Gitea provider can declare `getDependencies` unsupported
   rather than throwing `NotImplemented` or faking a result. Callers then treat
   every item as having **no dependencies**, so the stacked-execution gate
   (`isStackableBlockedCase`) is never taken. Items run independently; the loop
   does not invent or guess a dependency graph.

The hard rule: **fail safe, not fail open.** Absent a *verified* dependency
signal, an item is treated as unblocked-and-independent, never as a fabricated
relationship that could reorder or stall the queue incorrectly. A provider must
not synthesize a fake no-op that silently claims "no blockers" while pretending
the capability is present — it declares the capability absent so the gate is
skipped deliberately.

## Label / Status Mapping Without Public GitHub Label Noise

Today the workflow encodes coarse state as GitHub **labels** (`status:*`,
`agent:*`, `review:*`, and the `SessionLabels` set: `active`, `blocked`,
`readyForHuman`, `stackReady`). In the Gitea-backed mode this internal state
moves to **Gitea**, which keeps it **off** the public GitHub repository.

Mapping rules:

- **Internal workflow state lives on the Gitea work item.** `transitionItem`
  resolves to Gitea label add/remove (or a native Gitea status field if one is
  verified to exist). The coarse states the loop needs — `active`, `blocked`,
  `readyForHuman`, and the `stackReady` marker that gates stacked dependents —
  are Gitea labels/fields, not GitHub labels.
- **`stackReady` remains required, not optional.** As on GitHub, a passing
  review sets `stackReady` on a blocker to unblock its dependents, and a
  non-passing review clears it, so the dependency resolver never branches from
  an unverified base. The Gitea provider must support this transition; it cannot
  be dropped just because the surface changed.
- **Public GitHub label noise does not increase.** Because the AI workflow
  labels live in Gitea, the public GitHub repo does **not** gain `status:*` /
  `agent:*` / `review:*` churn. Any GitHub-side state stays limited to what a
  human reader of the public repo actually needs (e.g. PR review state), not the
  loop's internal bookkeeping.
- **No leaking the private taxonomy.** Gitea-internal label names and status
  values are Tier 1 detail. A Tier 2 GitHub summary describes *outcomes* in
  human terms ("ready for review," "changes requested") rather than echoing the
  internal label vocabulary.

## Joining a Gitea Work Item to a GitHub PR

With work items on Gitea and PRs on GitHub, the two are joined by the same
deterministic head-branch convention the provider architecture already uses,
generalized to the Gitea key:

```txt
ai/<gitea-work-item-key>      e.g. ai/issue-214  (or ai/<repo>-214 if keys collide)
```

The `RepoHostProvider` (GitHub) owns deriving/looking up the branch for a given
work-item ref, exactly as it does today; only the key's origin changes (Gitea
instead of GitHub). Branch push remains a **local git** operation, and
`createPullRequest` still assumes the head branch is already pushed.

## Configuration Shape

Following the `sessions.json` rules in provider-architecture.md, a Gitea
work-item session references secrets **by indirection only** — never inline key
material — and resolves them at runtime. The recognized shape:

```json
{
  "workItemProvider": {
    "provider": "gitea-issues",
    "auth": { "mode": "api-token", "tokenEnv": "N8N_AI_GITEA_API_TOKEN" },
    "gitea": {
      "baseUrl": "https://gitea.example.com",
      "owner": "ai-private",
      "repo": "work-items"
    }
  },
  "repoHostProvider": { "provider": "github", "auth": { "mode": "gh" } }
}
```

- This shape is **recognized** by the validator (the **Gitea config + auth**
  slice below is implemented). `WORK_ITEM_PROVIDERS` includes `gitea-issues`,
  and `WorkItemProviderConfig` carries a sibling, non-secret `gitea` block
  (`GiteaWorkItemConfig`) with `baseUrl`, `owner`, `repo`, and the optional
  `apiPath` (default `/api/v1`) and `labelMapping` (default `labels`) fields.
  The runtime provider is implemented (slice 3, issue #382): a `gitea-issues`
  session reads/writes Gitea over its REST API, and any unwired path still fails
  clearly rather than silently falling back to GitHub.
- The Gitea `baseUrl` is **required** because Gitea is self-hosted (no fixed
  host). It is a non-secret value stored literally; `validateSession` requires
  an `http(s)` URL and rejects one that embeds credentials
  (`user:password@host`) so a password can never be smuggled in through the URL.
- The API token is **never** written inline: it is referenced through the
  sibling `auth` block, which must use `mode: "api-token"` with `tokenEnv` (the
  env-var name holding the token). The credential-key `tokenKey` form is **not
  wired for Gitea yet** — no production resolver exists — so `validateSession`
  rejects it for `gitea-issues`; use `tokenEnv` until a resolver lands. Accepting
  any other auth mode (e.g. `gh`) is rejected, so the GitHub-only code paths can
  never read a GitHub repo under the operator's `gh` session for a Gitea
  work-item session.
- Secret rules are unchanged from the existing model: exactly one of the
  `*Env` / `*Key` indirection forms per secret, validated by `validateSession`;
  no token ever written to `sessions.json` or task context.

## Follow-Up Implementation Slices

This spec defines the topology; the following slices implement it. Each is a
separate issue and must verify the real Gitea API rather than assume GitHub
compatibility.

1. **Provider-neutral outbox.** *(Implemented — issue #361.)* The outbox now
   carries provider-neutral topics — `workitem:comment`, `workitem:transition`,
   and `repohost:pr-comment` (`src/core/outbox.ts`) — alongside the preserved
   legacy `gh:comment` / `gh:label:add` / `gh:label:remove` topics. Each
   provider-neutral row carries the configured provider *kind*, and the
   dispatcher constructs the matching `WorkItemProvider` / `RepoHostProvider`
   from that kind (`src/handlers/gh-dispatcher.ts`) instead of hard-coding
   `gh:*`; the `github-issues` / `github` kinds resolve back to the same `gh`
   providers, so GitHub behavior is preserved (proven by
   `test/outbox-provider-neutral.test.js`). The bounded/sanitized visibility
   enforcement lives in `src/core/outbox-visibility.ts` (see the "Provider-Neutral
   Outbox And Its Visibility Policy" section of
   [provider-architecture.md](provider-architecture.md)). This slice is the
   prerequisite for writing Tier 1 records to Gitea; the Gitea provider itself is
   still future work (slice 3). The legacy `gh:*` emit path remains in place and
   is not removed by this slice.
2. **Gitea config + auth.** *(Implemented — issue #362.)* `SessionConfig` /
   `validateSession` (`src/registries/json-session-registry.ts`,
   `src/core/session.ts`) now parse and validate the `gitea-issues` work-item
   provider: a non-secret `gitea` block (`baseUrl`, `owner`, `repo`, optional
   `apiPath` / `labelMapping`), an `api-token` auth mode resolved at runtime, and
   the secret-indirection rules above. No secret material in `sessions.json`. The
   runtime provider (slice 3) is still unimplemented, so a `gitea-issues` session
   fails clearly rather than silently falling back to GitHub.
3. **Gitea `WorkItemProvider`.** *(Implemented — issue #382.)* The provider
   (`src/providers/gitea/gitea-work-item-provider.ts`) speaks the **verified**
   Gitea REST API — not GitHub call shapes — over an injectable, synchronous HTTP
   transport (`src/providers/gitea/gitea-client.ts`): `listCandidateItems`
   (open issues, PRs excluded, bounded body), `getItem`, `commentItem` (Tier 1,
   bounded/sanitized by the outbox), `transitionItem` (Gitea numeric label-id
   add/remove, failing clearly when a workflow label is absent), and
   `getDependencies` via Gitea's native issue-dependencies endpoint (option 1 of
   the degradation ladder). It is wired into intake (`src/cli/github-intake.ts`)
   and outbox dispatch (`src/cli/dispatch-outbox.ts`) so `workitem:*` rows go to
   Gitea while `repohost:*` PR comments stay on the GitHub repo host; the API
   token is resolved by indirection and never logged. Proven by
   `test/gitea-work-item-provider.test.js` and `test/gitea-runtime.test.js`.

Sanitization/visibility enforcement (keeping Tier 0 out of Tier 1/2) is a
cross-cutting concern these slices share; it should land with the outbox slice
so every publication path goes through the same bounded/sanitized writer.

## Non-Goals (restated for this document)

- **Do not implement the Gitea provider here.** This is specification only.
- **Do not change n8n workflow JSON** unless a documentation test requires the
  generated docs to stay synchronized.
- **Do not add public GitHub issue mirroring** (GitHub ↔ Gitea sync) yet.
- **Do not assume Gitea REST APIs are GitHub-compatible**; implementation slices
  must verify the actual Gitea API surface.

## Acceptance Criteria Coverage

- *A spec document explains the Gitea private-work-item topology* — "Desired MVP
  Topology," "Surfaces and Visibility Tiers."
- *Hiding AI interaction from public GitHub is a first-class design goal* —
  "Motivation" (the highlighted goal).
- *Private Gitea content is still untrusted agent input* — "Why the private
  surface is still not 'trusted'" and "Prompt-Injection Boundary."
- *Which surfaces receive raw / bounded / summarized / no AI output* — "Surface
  → permitted fidelity" table and the tier definitions.
- *Follow-up slices for provider-neutral outbox, Gitea config/auth, and Gitea
  `WorkItemProvider`* — "Follow-Up Implementation Slices."

## Relationship to Other Docs

- [provider-architecture.md](provider-architecture.md) — the `WorkItemProvider`
  / `RepoHostProvider` split, the `sessions.json` secret-indirection rules, and
  the cross-provider (Jira + GitHub) precedent this mode follows.
- [future-architecture.md](future-architecture.md) — the local state store and
  transactional **outbox** that the provider-neutral outbox slice generalizes.
- [tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md) —
  the dependency / stacked-execution behavior the degradation ladder must
  preserve, and the tool-request gate the prompt-injection boundary protects.
- [github-to-gitea-import.md](github-to-gitea-import.md) — the follow-up design
  for the GitHub → Gitea public-issue import this document deferred: a one-way,
  allow-listed, untrusted import with no AI write-back to public GitHub.
- [phase-contracts.md](phase-contracts.md) — the per-phase contract the
  providers serve; phases call providers, not `gh` (or Gitea) directly.
