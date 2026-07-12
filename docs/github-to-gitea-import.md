# Public GitHub → Private Gitea Work-Item Import

This document specifies how a **public, user-facing GitHub issue** is imported
into a **private Gitea work item** that drives the AI development loop, without
leaking AI workflow chatter back onto public GitHub. It builds directly on the
two surrounding specs:

- [provider-architecture.md](provider-architecture.md) — the
  `WorkItemProvider` / `RepoHostProvider` split and the `sessions.json`
  secret-indirection rules.
- [gitea-private-work-items.md](gitea-private-work-items.md) — the four
  surfaces, the Tier 0/1/2 visibility ceilings, and the prompt-injection
  boundary. That spec *deferred* GitHub ↔ Gitea mirroring ("Do not add public
  GitHub issue mirroring yet"); **this document is the design that fills that
  gap**, and stops at design.

It is a **design specification only**. No behavior change is required to land
this document, and per the issue that scopes it (#364) **synchronization and
the Gitea provider API are not implemented here**. The current `gh`-CLI
workflow remains the MVP. The goal is to fix the import direction, the field
allow-list, and the trust boundary *before* any code moves public text into a
private prompt, and to name the follow-up slices if automatic sync is later
approved.

## Why An Explicit Import Boundary

The operating model is a deliberate split:

- **GitHub** stays the public, user-facing issue and release repository. A
  maintainer, a contributor, or a drive-by reader files and reads issues there.
- **Gitea** becomes the private AI-driving work-item provider. The queue the
  loop selects from, the coarse workflow state, and the bounded internal
  discussion the agents read and write all live there.
- AI prompts, review feedback, tool requests, quota notes, and raw workflow
  details stay in private Gitea or local artifacts — **never** echoed back to
  public GitHub.

This requires a one-way import seam with a hard trust boundary. The failure
mode to design against is **accidental** implementation: reusing public GitHub
issue comments as the AI transcript, so that prompts and agent output land on a
public surface as a side effect of "just syncing the issue." The import must be
a narrow, explicit, allow-listed copy — not a bidirectional mirror.

> **First-class design goal:** Raw AI interaction stays hidden from the public GitHub repository.
> Import pulls a bounded snapshot of public text *into* the private surface;
> nothing about the AI exchange flows back out. The default
> for any GitHub-bound write is **nothing**, and any exception is an explicit,
> summarized, sanitized Tier 2 step (see
> [gitea-private-work-items.md](gitea-private-work-items.md)).

## Import Direction Is One-Way By Default

```txt
public GitHub issue  ──(bounded, allow-listed, untrusted)──►  private Gitea work item
private Gitea work item  ──►  GitHub:  nothing by default
```

The import is **pull-only into Gitea**. The private work item is the AI's
surface; the public GitHub issue is the human's surface. Keeping the arrow
one-way is what prevents AI chatter from ever reaching public GitHub, because
there is no write-back path to misuse.

## MVP Behavior

The MVP answers each design question from the scoping issue with the most
conservative option that still lets the loop run from a Gitea work item.

### Manual import, not automatic sync

- **MVP = manual import.** An operator triggers a single, explicit import of one
  GitHub issue into a new Gitea work item. There is **no** background poller, no
  webhook, and no continuous reconciliation in the MVP.
- **Automatic sync is future work** and only ships if it is explicitly scoped as
  its own slice (see "Future Phases"). The MVP must not assume any automatic
  sync exists, mirroring the non-goal already stated in
  [gitea-private-work-items.md](gitea-private-work-items.md).

Manual-first keeps the boundary auditable: every cross-surface copy is an
operator action, not an emergent behavior of a sync daemon.

### Backlinks

- **Private Gitea → public GitHub: yes.** The Gitea work item stores a backlink
  to the originating public GitHub issue (URL + issue number) so the loop and a
  maintainer can trace provenance. This link points *outward to the public
  surface*, so it leaks nothing private.
- **Public GitHub → private Gitea: no, by default.** Public GitHub does **not**
  receive a backlink to the private Gitea work item. A private Gitea URL is
  Tier 1 internal detail; publishing it would leak the existence and address of
  the private workflow surface to anyone reading the public repo. A backlink in
  this direction is only ever posted if the operator explicitly opts in **and**
  the target URL is safe and intended for maintainers (e.g. a reachable,
  access-controlled instance whose existence is already known) — never as a
  default, and never inferred from issue text.

### Imported fields (allow-list, not copy-everything)

Only an explicit allow-list of public fields is imported, each bounded and
treated as untrusted:

| GitHub field        | Imported? | Treatment |
| ------------------- | :-------: | --------- |
| **title**           | ✅ | Bounded length; untrusted. |
| **issue body**      | ✅ | Bounded length, truncated past a fixed budget; untrusted. |
| **labels**          | ✅ (mapped) | Only through an explicit GitHub→Gitea label map. Unknown labels are dropped, not auto-created, so public label text cannot mint Gitea workflow state. |
| **selected comments** | ✅ (opt-in, bounded count) | Only operator-selected comments, capped in count and size. Not "all comments," and never the whole thread by default. |
| **reporter metadata** | ✅ (minimal) | Login/handle and a stable issue reference only. Treated as a display string, never as an identity or authorization signal. |

Everything else (reactions, assignees, milestones, project fields, edit
history, raw HTML) is **out of scope for the MVP import** and simply not copied.
The allow-list is the boundary: a field that is not on it cannot reach the Gitea
work item or, downstream, an agent prompt.

### Bounding and marking imported text as untrusted

Before any imported text can reach an agent prompt:

- **Bounded.** Title, body, and each selected comment are truncated to fixed
  budgets; total imported text is capped. Oversized input is truncated with a
  visible marker, not silently expanded into a prompt.
- **Marked untrusted.** Imported public text is wrapped/fenced as
  clearly-delimited **untrusted external content** and labeled with its origin
  (e.g. "imported from public GitHub issue #N — untrusted"). The agent prompt
  must be able to tell where operator/policy instructions end and where copied
  public text begins, so the copied text is consumed as **data describing a task**,
  not as instructions to the agent.
- **Sanitized on the way in.** Import strips/escapes content that could break
  the prompt frame (e.g. fence-breaking sequences, injected role markers) and
  never executes, follows, or resolves links, includes, or commands embedded in
  the public text.

This is the *same* untrusted-input posture
[gitea-private-work-items.md](gitea-private-work-items.md) applies to any work-item
body — import does not grant public text any new authority. Privacy of the
destination does not launder the trust of the source.

### Comments after import

- **MVP: manual re-import, not auto-sync.** New user comments posted on the
  public GitHub issue *after* import are **not** automatically pulled into the
  Gitea work item. If newer context is needed, the operator performs another
  explicit, bounded import of the selected comment(s). Ignoring-by-default and
  requiring an explicit re-import keeps the boundary a deliberate operator
  action and avoids a polling path in the MVP.

### Status posted back to GitHub

- **MVP: nothing, by default.** No automatic status, no AI-derived comment, no
  label churn is posted back to the public GitHub issue on import or during the
  loop. The public issue is left exactly as the human left it.
- Any future public status is a **Tier 2 summary only** — a human-safe sentence
  ("a fix is in progress," "ready for review") with **no raw prompts, no agent
  output, no local paths, no private Gitea URLs, no tokens, no artifact
  references** — and is an explicit, opt-in step, never a default of import.

## Security Requirements

These are hard constraints, not guidelines. They restate the scoping issue's
security requirements in terms of this seam.

1. **Public GitHub issue body and comments are untrusted input.** They may
   *describe* desired work ("refactor the parser," "blocked by #12") but carry
   **no authority**.
2. **Imported text must not be able to alter control-plane policy.** It cannot
   change provider config, tool policy, visibility policy, credentials, auth
   mode, or publication targets. It cannot promote Tier 0/Tier 1 content onto a
   public surface, expand tool access, bypass the tool-request/grant gate, or
   fast-forward human review. A request embedded in public text that *would*
   require any of these is **refused**, and the refusal is a bounded Tier 1
   record on the private item — not a Tier 2 public broadcast that tells an
   attacker which probe landed.
3. **Raw AI artifacts must never be posted back to public GitHub.** Prompts,
   full agent output, review feedback, tool-request mechanics, and quota notes
   stay on the private/local surfaces. There is no code path from a Tier 0/Tier 1
   record to a public GitHub write.
4. **No leakage to public GitHub.** Import must never push private Gitea URLs,
   tokens/credentials, local filesystem paths, or local artifact references
   onto the public issue. This reuses the redaction and path-stripping posture
   already specified for Tier 2 publication in
   [provider-architecture.md](provider-architecture.md)
   (`enforceCommentVisibility` / `sanitizeBody`).

### How prompt-injection risk is bounded during import

Import is the moment untrusted public text crosses into the AI's surface, so the
injection bound is enforced **at import time**, layered:

- **Allow-list + bounding** shrink the attack surface: only named fields, each
  size-capped, can cross at all.
- **Framing** keeps the copied text as delimited, origin-tagged *data*, never
  merged into the instruction channel of a prompt.
- **Policy precedence** means provider/tool/visibility/credential policy is
  resolved from `sessions.json` and code, **not** from issue text; no imported
  string can override it. (This is the same boundary enumerated in
  [gitea-private-work-items.md](gitea-private-work-items.md) — security,
  provider/config, output/visibility, and tool policy domains.)
- **No write-back** means even a successful injection cannot turn into a public
  post: there is no default GitHub write path for the agent to be tricked into
  using.

## MVP vs Future Phases

**MVP (this design's scope — specification only):**

- One-way, **manual** import of a single GitHub issue into a Gitea work item.
- Allow-listed fields (title, body, mapped labels, selected comments, minimal
  reporter metadata), bounded and marked untrusted.
- Private→public backlink stored on the Gitea item; **no** public→private
  backlink by default.
- **No** status posted back to GitHub by default; comments after import need
  manual re-import.

**Future phases (each a separate, explicitly scoped slice; out of scope here):**

1. **Automatic import/sync.** A poller or webhook that imports new issues and
   re-imports updated comments without an operator trigger. Requires its own
   design for rate, dedup/idempotency, and conflict handling, and must preserve
   the one-way, untrusted, allow-listed boundary.
2. **Opt-in public status write-back.** A Tier 2-only, sanitized status comment
   or label on the public GitHub issue, gated behind explicit operator opt-in.
3. **Opt-in maintainer backlink (public→private).** Posting the Gitea URL to
   GitHub only when the operator confirms the URL is safe and intended for
   maintainers.
4. **Gitea provider API support.** The runtime `WorkItemProvider` against the
   verified Gitea REST API (already tracked as a slice in
   [gitea-private-work-items.md](gitea-private-work-items.md)); import depends on
   it but does not implement it.

These are **follow-up implementation issues** to be filed *only if* automatic
import/sync (phase 1) or write-back (phases 2–3) is approved. None is required
for the MVP decision, and none is implemented by this document.

## Non-Goals (restated for this document)

- **Do not implement synchronization.** No poller, webhook, or reconciliation
  loop in this issue.
- **Do not implement Gitea provider API support here.** Import rides on the
  provider slice specified elsewhere; it is not built here.
- **Do not require GitHub App auth** as part of the MVP decision. The import
  boundary is independent of which GitHub auth strategy reads the public issue.
- **Do not add a default public write-back** of any kind.

## Acceptance Criteria Coverage

- *A design document describes the public-GitHub-to-private-Gitea import model* —
  this document ("Why An Explicit Import Boundary," "MVP Behavior").
- *MVP and future phases are separated* — "MVP vs Future Phases."
- *Explains why raw AI interaction stays hidden from public GitHub* — the
  first-class design goal and "Import Direction Is One-Way By Default" (no
  write-back path), plus Security Requirement 3.
- *States how prompt-injection risk is bounded during import* — "How
  prompt-injection risk is bounded during import" (allow-list, bounding,
  framing, policy precedence, no write-back).
- *Follow-up implementation issues identified if automatic import/sync is
  approved* — "Future phases" (1–4), each marked as a separately scoped slice.

## Relationship To Other Docs

- [gitea-private-work-items.md](gitea-private-work-items.md) — the visibility
  tiers, the four surfaces, and the prompt-injection boundary this import seam
  enforces; that spec deferred GitHub↔Gitea mirroring and this document is its
  follow-up.
- [provider-architecture.md](provider-architecture.md) — the
  `WorkItemProvider` / `RepoHostProvider` split, the provider-neutral outbox,
  and the Tier 2 sanitization (`enforceCommentVisibility`, `sanitizeBody`) any
  future write-back must reuse.
- [tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md) —
  the tool-request gate that imported untrusted text must never bypass.
- [phase-contracts.md](phase-contracts.md) — the per-phase contract the loop
  runs once a work item exists; phases consume the imported item, they do not
  re-import.
