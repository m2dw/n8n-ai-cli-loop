# Tool Request typed-operation grant tiers

Status: **approved design, not yet implemented** (issue #697). This document
is the authoritative contract for how the Tool Request human gate is tiered:
which requests may execute without a waiting human, under what containment,
with what audit trail, and why everything else stays gated exactly as today.
Follow-up implementation issues reference this specification and MUST NOT
redefine its policy; a change of policy is a change to this document first.

This is issue #697, the design deliverable drafted as `docs/DOMAIN.md` §5
derived issue 4 (#503). It builds on the completed focused specification
chain #777–#785 and supersedes nothing: the superseded #696 / PR #776 and the
umbrella issues #778/#779 were replaced by that chain, not by this document.

It does **not** specify, and no implementation built against it may assume:

- **Command grammar and the trust boundary** — fixed by
  `docs/chatops-command-grammar-contract.md` (#777).
- **Provider identity and the state namespace** — fixed by
  `docs/chatops-identity-contract.md` (#780).
- **Comment discovery, the cursor, or the scan window** — fixed by
  `docs/chatops-comment-cursor-contract.md` (#781).
- **The execution-ledger state machine** — fixed by
  `docs/chatops-execution-ledger-contract.md` (#782). This document adds no
  row, no state, and no field to it (§12).
- **The callable operation-dispatch port** — fixed by
  `docs/operation-dispatch-port-contract.md` (#783); `operationId` being a
  typed identity rather than a command string is the premise this whole
  document stands on.
- **Verb-to-operation mapping and per-surface argument policy** — fixed by
  `docs/chatops-operation-mapping-contract.md` (#784). This document does not
  add a ChatOps verb and does not modify #784's table (§12).
- **The five-kind result vocabulary and publication rules** — fixed by
  `docs/chatops-result-contract.md` (#785), whose §12 admission criteria this
  document satisfies point by point (§12).
- **The Tool Request emission contract, the redacted/exact command split, the
  metadata record, and the dependency-sync mechanics** — fixed by
  `docs/tool-request-and-dependency-sync.md`.
- **The guided operator flow** — fixed by `docs/guided-tool-request-flow.md`;
  the human-gate tier below *is* that flow, unchanged.

## 1. Why the gate tiers by typed operation id, not command text

`docs/tool-request-redesign.md` §1 established the negative result this
contract is built around: command shape does not determine what secrets or
host resources execution can reach, so "reversible / secret-free /
worktree-contained" is **undecidable from command text**. A classifier that
inspects `npm run lint` and concludes "safe" has decided nothing about what
`lint` is bound to in that repository's `package.json`, what the environment
carries, or where the process can write. `docs/DOMAIN.md` §3 reached the same
verdict from the trust-boundary side: the Tool Request gate guards channels B
and C (supply chain, agent misjudgment), which repo privacy does not close,
so the relaxation axis is *blast radius and reversibility*, never "the author
is trusted now."

The one relaxation that already exists in production is therefore the
template. The dependency-update route
(`src/handlers/implementation.ts`, the Tool Request disposition site
inventoried by `docs/DOMAIN.md` §2.2 row 6; mechanics in
`docs/tool-request-and-dependency-sync.md` §3.5) does not execute the agent's
requested install command. It recognizes the *need* from decidable evidence
— a manifest diff on a configured trigger path, or an add/bump request whose
command a fixed parser reads as **data only** (package name and explicit
version, never executed; `docs/tool-request-and-dependency-sync.md` §3.5),
applying that data to the manifest as a pure JSON edit — and **substitutes a
session-pinned command** — lockfile-only, lifecycle-scripts-off in its
`docs/tool-request-and-dependency-sync.md` §3.2a safe mode, the only
dependency-sync configuration §14 admits to a relaxed tier — whose reach was
decided by an operator when the session was configured, not by the agent at
request time.

This contract generalizes exactly that move. An operation qualifies for a
relaxed tier only as a **typed operation id** — the same `"resource.action"`
identity discipline as `docs/operation-dispatch-port-contract.md` §4.1 —
registered with a fixed execution, an *enforced* cwd/env/network policy
(§7), and a closed effect enumeration, and opted into by a **session-side
allowlist**.
Free-form command text never participates in the decision: a request that
resolves to no typed operation is human-gated *by construction*, not by
classification.

## 2. Terminology

- **Tool Request** — the agent's structured escalation record
  (`src/core/tool-request.ts`): exact `command` (local-only), redacted
  `displayCommand`, `reason`, `expectedFiles`, `necessity`, optional
  `suggestedAction` hint.
- **Typed operation** — a registry entry identified by an `operationId`
  (`"resource.action"`, lower-kebab both sides, per
  `docs/operation-dispatch-port-contract.md` §4.1) with a pinned execution
  and a fixed policy (§4). Never a command string.
- **Tier** — one of the closed set
  `"auto-grant" | "notify-and-proceed" | "human-gate"` (§3).
- **Allowlist entry** — the session-side opt-in binding one `operationId` to
  one relaxed tier, optionally narrowing its effect enumeration (§5).
- **Pinned substitution** — the execution a relaxed tier actually runs: the
  registry entry's fixed command template or in-process routine, resolved
  from session configuration and code — never the agent's `command` text.
- **Input parser** — an optional fixed routine a registry entry declares
  (§4) that reads the request's `command` as **data only** — never to
  execute it, never to select or compose what runs — extracting typed
  values (a package name, an explicit version range) that parameterize the
  pinned substitution; the `docs/tool-request-and-dependency-sync.md` §3.5
  precedent.
- **Effect enumeration** — the closed set of worktree paths a typed
  operation is allowed to change, declared on the registry entry and
  verified against the observed post-run diff (§8).
- **Audit record** — the durable trail (task events + run artifact) every
  tier decision and every relaxed-tier execution writes (§11).
- **Gate decision point** — the moment a phase handler has classified an
  emitted Tool Request and must choose: proceed under a relaxed tier, or
  hand the request to the pre-#697 disposition flow — the shipped
  dependency-update route where it still applies (§6, §14), a parked human
  handoff otherwise.

## 3. The three tiers

The tier set is closed:
`"auto-grant" | "notify-and-proceed" | "human-gate"`.

| Tier | Who decides | Execution | Operator involvement | Audit |
| --- | --- | --- | --- | --- |
| `auto-grant` | Session allowlist, ahead of time | Pinned substitution, in-phase, immediately | None required; record and continue | Full (§11) |
| `notify-and-proceed` | Session allowlist, ahead of time | Pinned substitution, in-phase, immediately | Post-hoc review of an enqueued notification (§10) | Full (§11), plus a `postHocReview` state |
| `human-gate` | A human, per request | Only via the guided flow's explicit dispositions | A human disposes every request (`docs/guided-tool-request-flow.md`) | As today (§2.4–§2.6 of `docs/tool-request-and-dependency-sync.md`) |

- **`human-gate` is the default and the unchanged behavior.** It covers
  everything that is not an allowlisted typed operation — notably **every
  free-form shell request** (any request that resolves to no typed
  operation), **dependency additions** whose request resolves to no typed
  entry (no explicit version, an unconfigured ecosystem — §14), **network**
  access beyond a typed operation's declared policy, **spend**,
  **credentials**, and anything touching the **canonical repo**. None of
  those categories has a decidable, worktree-observable containment story,
  so none is representable in a relaxed tier (§4, §9). A human-gated request
  parks as a human handoff exactly as `docs/tool-request-and-dependency-sync.md`
  §2.3 specifies today — after the pre-#697 disposition flow, which retains
  the shipped dependency-update route during migration (§6, §14), has
  declined it; the one verdict that skips that flow and parks directly is
  §6 rule 6's `"already-executed"` repeat refusal.
- **`notify-and-proceed` is not a softer default.** Each typed operation in
  this tier must enumerate its allowed side effects explicitly; any observed
  effect outside the enumeration routes the request to the human gate
  (§8). Operations that cannot enumerate their side effects do not qualify
  for the tier — structurally: the registry entry's effect enumeration is a
  required field, and §7's enforced containment boundary leaves an
  execution no way to produce effects that escape the observable surface.
- **`auto-grant` is the narrowest tier, not the loosest.** It admits only
  operations whose ceiling (§9) permits it: no network, and effects strictly
  contained in the issue worktree. Worktree isolation
  (`docs/per-issue-worktrees.md`) remains the blast-radius enabler for this
  tier, exactly as `docs/DOMAIN.md` §5 item 4 required.

## 4. The typed-operation registry entry

```ts
interface TypedToolOperation {
  operationId: string;                    // "resource.action", #783 §4.1 identity rules
  trigger: {
    suggestedActions: readonly string[];  // ToolRequest.suggestedAction values that SELECT this op
    preconditions: readonly string[];     // named, decidable predicates (repo and session-config state; parsed request data)
  };
  input?: {
    parser: string;                       // named fixed routine: request command → typed data, or refusal
  };
  execution:
    | { kind: "pinned-command"; sessionConfigPath: string }
    | { kind: "in-process"; routine: string };
  policy: {
    cwd: "issue-worktree";                // the only value; canonical repo is unrepresentable
    env: "stripped";                      // secret-free by construction (redesign §5)
    network: "none" | "registry-metadata";
  };
  allowedEffects: {
    worktreePaths: readonly string[];     // closed glob set, relative to the worktree root
  };
}
```

Reading the shape is reading the policy:

- **`trigger` selects; it never authorizes.** `suggestedAction` is
  agent-supplied text, so it may do no more than nominate a candidate entry
  — and for a request that omits it or carries a hint no entry uniquely
  matches, a declared `input.parser`'s data-only accept verdict plays the
  same nominating role and no more (§6 rule 2);
  the `preconditions` are named predicates over repo and session-config
  state and, when the entry declares an `input.parser`, over the parsed
  request data (e.g. `"dependency-request-parses"`) whose facts the handler
  evaluates and injects — the resolver itself stays pure (§6). If the
  evidence does not hold, the route declines and the request is human-gated.
  The free-form `command` field appears nowhere in `trigger`: there is no
  field it could fill.
- **`input` admits agent text as data, never as authority.** The only
  component anywhere in the tier machinery that reads the request's
  `command` is a declared `input.parser`: a fixed, named routine — code,
  like an `in-process` execution — that either extracts typed values (a
  package name, an explicit version range) or refuses. The
  `docs/tool-request-and-dependency-sync.md` §3.5 route is the precedent:
  the command is parsed for **data only**, never executed, and the parse
  output parameterizes the pinned execution as data (a manifest JSON edit)
  whose result still faces effect verification (§8) and PR review. A parse
  refusal is a failed precondition (§6); an entry without `input` gives the
  machinery no reader of `command` at all.
- **`execution` has no free-string variant reachable from a request.** A
  `pinned-command` names a session-config path (the `dependencySync.command`
  precedent, `docs/tool-request-and-dependency-sync.md` §3.1) whose value an
  operator wrote; an `in-process` routine is code. Executing agent text
  under a relaxed tier is not a forbidden configuration — it is an
  unrepresentable one.
- **`policy` is a triple of closed values — and a demand on the runner, not
  a description of the command.** Declarative fields do not by themselves
  constrain a process: a pinned command or in-process routine could open an
  absolute path, walk `..` out of the worktree, or touch the network
  regardless of what is written here. Each value therefore names a
  containment guarantee the executing runner must impose **mechanically**
  (§7): filesystem writes confined to the issue worktree and the
  run-artifact directory, an environment constructed from a fixed
  allowlist, and network denied — or, for `"registry-metadata"`
  (package-registry metadata reads, the dependency-sync case), restricted
  to the session-configured registry endpoints — by an enforcing sandbox.
  Credentials, spend, and canonical-repo access have no spelling here *and*
  no reachable surface inside that boundary, which is what keeps them
  human-gate-only without a blocklist to maintain.
- **`allowedEffects` is required and closed.** It is the enumeration §8
  verifies. An entry without one cannot be constructed, which is how
  "operations that cannot enumerate their side effects do not qualify"
  is enforced rather than requested.

Registration validates the same way
`docs/operation-dispatch-port-contract.md` §4.2 validates descriptors: a
malformed id, an empty enumeration, an unknown policy value, an unknown
parser or routine name, or a duplicate id **throws at composition time** — a
bad registry is a defect, not an input.

## 5. The session-side allowlist

```json
{
  "toolRequestTiers": {
    "enabled": true,
    "operations": [
      {
        "operationId": "dependency.sync",
        "tier": "notify-and-proceed",
        "allowedEffects": { "worktreePaths": ["package.json", "package-lock.json"] }
      }
    ]
  }
}
```

- `enabled` — master switch, defaults to **off**. Absent block or
  `enabled: false` means the tier machinery relaxes nothing: every Tool
  Request follows the pre-#697 disposition flow — which, for a session with
  dependency-sync enabled, **includes the shipped §3.5 dependency-update
  route** (§6's migration exception, §14). The pre-#697 behavior is the
  zero-configuration behavior, automatic dependency updates included:
  `"tiers-disabled"` withdraws only relaxations this contract would have
  added, never behavior that shipped before it.
- `operations[]` — one entry per opted-in `operationId`. `tier` accepts only
  `"auto-grant"` and `"notify-and-proceed"`; `"human-gate"` is not a legal
  entry value because absence already means exactly that, and a config
  surface where the same fact has two spellings is a config surface that
  drifts.
- `allowedEffects` — optional **narrowing** of the registry enumeration; the
  effective enumeration is the session value when present, and it must be a
  subset of the registry's.

Session-load validation is fail-closed, in the style the loop already uses
for agent-profile config: an unknown `operationId`, a `tier` above the
operation's ceiling (§9), a session `allowedEffects` that is not a subset of
the registry's, a duplicate `operationId`, or an unrecognized `tier` value
**rejects the session at load** with an actionable error. Entry-specific
admission rules compose with these: a `dependency.sync` allowlist entry in a
session whose `dependencySync.allowLifecycleScripts` is `true` rejects the
session the same way (§14 — the operator has asked for a relaxed tier on a
configuration that withdraws its premise). A session that
merely omits the block loses nothing but the relaxation.

## 6. Tier resolution

Tier resolution is a **pure core policy function** (the
`core/tool-request-changes.ts` precedent, per `docs/DOMAIN.md` §2.2 row 6):

```
resolveGrantTier(request, registry, allowlist, facts) →
  | { tier: "human-gate"; reason: TierRefusalReason }
  | { tier: "auto-grant" | "notify-and-proceed";
      operationId: string; effectiveEffects: readonly string[] }
```

with `TierRefusalReason` =
`"tiers-disabled"` | `"no-candidate"` | `"not-allowlisted"` |
`"containment-unavailable"` | `"precondition-failed"` | `"already-executed"`
— a closed set, recorded in the audit trail (§11), never published beyond
it (§12).

Rules, in order, all fail-closed:

1. `toolRequestTiers` absent or disabled → `human-gate` / `"tiers-disabled"`.
2. Candidate selection, by two nomination paths tried in order. First the
   hint: a `suggestedAction` that names exactly one registry entry via
   `trigger.suggestedActions` nominates that entry. Otherwise the **parser
   probe**: exactly one registry entry declaring an `input.parser` must
   accept the request — the handler runs each such entry's fixed parser
   (§4) over the request as data, and an accept verdict, injected as a
   fact, nominates that entry. The probe is not reserved for hint-less
   requests. `suggestedAction` is optional agent text that the shipped
   dependency-update route never consults — it recognizes eligible install
   requests from `command` alone, whatever the hint says — so a hint with
   no unique match (absent, unrecognized — `manual-review`, a misspelling,
   an unknown value — or naming more than one entry) is **inert, not a
   veto**: the probe runs exactly as for an absent hint, and the request
   shapes the shipped route serves keep resolving past §14's subsumption
   point instead of gaining a new human handoff. No nomination on either
   path — no unique hint match and no probe accept — or a probe accepted
   by more than one entry, → `human-gate` / `"no-candidate"`. The
   `command` and `reason` fields are **never read** by tier resolution —
   the only reader of `command` is a declared `input.parser`, fixed code
   whose accept/refuse verdict the handler injects as facts, so the
   resolver never sees the text: agent-supplied fields select at most a
   candidate; they never authorize.
3. The candidate must have an allowlist entry → else `human-gate` /
   `"not-allowlisted"`.
4. The runner must attest the enforcing containment capability the entry's
   policy demands (§7) — a host fact, injected like any other → else
   `human-gate` / `"containment-unavailable"`.
5. Every `trigger.precondition` must hold in the injected `facts` — for an
   entry with `input`, this is where a parse refusal lands → else
   `human-gate` / `"precondition-failed"`.
6. Repeat protection: if the audit trail already records a successful
   relaxed-tier execution of this `operationId` for the same task attempt,
   the repeat is `human-gate` / `"already-executed"` — a typed operation
   auto-executes at most once per attempt, so a confused agent re-emitting
   the same request converges on a human instead of a loop. This refusal
   sits outside the migration exception below: it parks as a real human
   handoff, never re-entering the pre-#697 dependency route, whose
   `runDependencyUpdate` could execute a second pinned sync.
7. Otherwise the tier is the allowlist entry's tier, with the effective
   effect enumeration attached.

**Migration exception — the §14 compatible route.** A `human-gate` verdict
says this contract offers the request no relaxation; for the refusals this
exception scopes below, it is not an instruction to park unconditionally:
the handler receiving one disposes the request through the pre-#697 flow —
and for a session with dependency-sync enabled, that flow still contains
the shipped `docs/tool-request-and-dependency-sync.md` §3.5
dependency-update route.
Rule 1's `"tiers-disabled"` therefore leaves today's automatic dependency
updates exactly as they are, and the same holds for `"not-allowlisted"`: a
session that opts into tiers without listing `dependency.sync` has declined
this contract's relaxation, not revoked a shipped behavior. The exception
is scoped by refusal reason, not blanket: it covers exactly the five
refusals under which the tier machinery has executed nothing —
`"tiers-disabled"`, `"no-candidate"`, `"not-allowlisted"`,
`"containment-unavailable"`, and `"precondition-failed"` — where falling
back reproduces shipped behavior and nothing can run twice. Rule 6's
`"already-executed"` presupposes the opposite: a relaxed-tier execution of
this operation already succeeded in this task attempt, so handing the
repeat to the pre-#697 flow — whose `runDependencyUpdate` would execute a
second pinned sync — would defeat the at-most-once protection the rule
exists to enforce. An `"already-executed"` verdict therefore parks as a
real human handoff, never through the legacy route: repeat protection
outranks the migration exception (invariant 8). The exception
ends at §14's subsumption point, when the typed entry demonstrably handles
every request the shipped route handles; until then the two routes coexist,
with the typed route taking precedence for requests it resolves.

## 7. Execution under a relaxed tier

The gate decision point is in the phase handler, at the site that today
classifies a Tool Request as a human handoff
(`docs/tool-request-and-dependency-sync.md` §2.3). Under a relaxed tier the
handler, still inside the same phase run, issue lock, and issue worktree:

1. Snapshots the pre-substitution worktree state — per-path **content**,
   not a path list — relative to the phase's committed state, as the
   baseline the observed effect set (§8) is diffed against, and records
   which paths already differ from the committed state (the **pre-dirty
   set**). A clean worktree is deliberately **not** required: the shipped
   dependency-update route serves requests that arrive after the agent has
   already edited `package.json` — and often other issue files — so a
   cleanliness precondition would human-gate exactly the requests §14
   guarantees keep working. Attribution comes from the snapshot instead:
   the run holds the phase's issue lock, so no concurrent writer exists and
   every post-run difference from the snapshot is the substitution's.
   Agent edits on paths the substitution does not touch sit outside the
   observed set — neither verified nor adopted by the tier machinery, left
   in the worktree for the phase's normal flow exactly as today. Agent
   edits that share a path with the substitution — the pre-dirty ∩ observed
   **overlap** — are the one place path names cannot draw the boundary, so
   adoption isolates them at patch level (step 4, §8): path names attribute
   the run; only content attributes the bytes. (The clean-worktree
   precondition scoped grants impose, §2.6 of the same document, is
   unchanged for grants; it is not imported here.)
2. Executes the **pinned substitution only**, inside an **enforcing
   sandbox** that mechanically imposes the entry's policy triple: filesystem
   writes confined to the issue worktree plus the run-artifact directory (an
   absolute path or `..` inside the substitution hits the boundary, it does
   not escape it), environment constructed from a fixed allowlist per
   `docs/tool-request-redesign.md` §5, network denied — or, for
   `"registry-metadata"`, restricted to the session-configured registry
   endpoints — and bounded by a timeout. Both `execution` kinds run inside
   this boundary: an `in-process` routine executes in the sandboxed run
   process, never in the orchestrator's. The sandbox is a **required runner
   capability**, not the execution-environment host default: its concrete
   mechanism is an implementation choice, its guarantees are this
   contract's, and a host that cannot provide it was already routed to the
   human gate at resolution (§6 rule 4) — a relaxed tier never falls back
   to unconfined host execution.
3. Captures exit status and bounded stdout/stderr into the run artifact
   (§11); the exact command and full output never reach a public surface,
   exactly as for grants.
4. On success, verifies effects (§8) and, if verified, adopts the
   substitution's changes into the phase's normal flow and **continues the
   task** — for `notify-and-proceed`, additionally enqueueing the
   notification (§10) in the same completion transaction. Adoption is a
   commit on the issue branch by the same plumbing a grant's `commit`
   disposition uses, but what it stages is **patch-level, never
   path-level**: for each observed path, the committed base content plus
   the substitution's **isolated patch** — that path's step-1-snapshot →
   post-run difference. For a path clean at snapshot time that is simply
   the post-run content. For an overlap path (step 1), staging the worktree
   file would smuggle the agent's unverified pre-existing hunks into the
   tier's commit, so only the isolated patch is applied onto the committed
   base — and an `in-process` routine whose write is a pure data edit (the
   `dependency.sync` manifest case, §14) may equivalently replay that data
   edit against the committed base. An overlap whose patch does not apply
   cleanly to the committed base adopts **nothing**: the run routes to the
   human gate with the entangled paths recorded, exactly as §8 specifies.
   Pre-existing agent edits — overlap hunks included — stay uncommitted in
   the worktree for the phase to carry forward.
5. On a non-zero exit or timeout, does **not** verify or adopt anything: the
   request parks as an ordinary human handoff with the captured, bounded
   result attached as continuation context, and the produced diff is left in
   place for the guided flow's existing `commit`/`keep`/`discard`
   dispositions. A failed relaxed run degrades into exactly the flow that
   existed before this contract; it never retries itself.

## 8. Effect enumeration and verification — the notify-tier constraint

The notify tier's defining constraint (and the auto tier inherits it,
being strictly narrower): **each typed operation must enumerate its allowed
side effects explicitly, and any effect outside the enumeration routes the
request to the human gate.**

- **Observed effects** are the set of worktree paths that differ from the
  pre-substitution snapshot (§7 step 1) after the pinned substitution
  exits — a baseline that may itself carry agent edits, so the diff
  attributes to the run only what the substitution changed — decidable by
  observation in a contained worktree, which is what makes this check
  possible where pre-execution command classification was not (§1). The
  diff is content-level: the observed *path set* is what verification
  checks below, and the per-path isolated *patches* it yields are what a
  verified run may commit (§7 step 4).
- **Verification** is `observed ⊆ effective enumeration` (the
  session-narrowed glob set, §5). Verified → the run is adopted (§7 step 4).
- **Excess** → the tier machinery adopts nothing: no commit, no push, no
  task continuation on the strength of this run. The request routes to the
  human gate carrying the excess path list and the full observed set in its
  audit record; the diff stays in the worktree for the guided flow to
  dispose of. Routing on excess is not best-effort — it is the tier's
  admission condition enforced at the only time it is checkable.
- **Overlap** — an observed path that is also in the pre-dirty set (§7
  step 1) — is attributable but never path-adoptable: the content snapshot
  tells the substitution's hunks and the agent's apart, while committing
  the path would stage both. Adoption therefore stages only the
  substitution's isolated patch onto the committed base (§7 step 4); when
  that isolation fails — the agent's and the substitution's edits collide
  at the hunk level and no data-edit replay applies — the tier machinery
  adopts nothing: the run routes to the human gate carrying the entangled
  path list in its audit record (`tool_request_effects_entangled`, §11),
  and the combined diff stays in the worktree for the guided flow, the
  same posture as excess. The adoption boundary is content-level by
  construction: no agent-authored byte is ever staged on the strength of a
  relaxed-tier run.
- **Unobservable effects are excluded by enforcement, not by declaration or
  verification.** Post-run diffing sees only the worktree, so it could
  never catch a write elsewhere on the host — which is why the policy
  triple is imposed mechanically by §7's sandbox: writes outside the
  worktree and the run-artifact directory are denied, the environment is
  fixed, and network beyond the declared value is unreachable. Inside that
  boundary the worktree surface this section checks (plus run artifacts) is
  the *complete* effect surface, not merely the inspected one, and
  `observed ⊆ enumerated` is a sound admission check. A host that cannot
  enforce the boundary gets no relaxed tier at all (§6 rule 4), never a
  less-verified one; an operation whose execution needs effects outside
  that surface — beyond its declared network policy — cannot be given a
  truthful enumeration, and therefore cannot qualify: that is the precise
  sense in which the notify tier is not a softer default.

## 9. The auto-grant tier's ceiling

An operation's **tier ceiling** is derived from its declaration, never
declared free-hand:

- `policy.network === "none"` → ceiling `auto-grant`.
- `policy.network === "registry-metadata"` → ceiling `notify-and-proceed`.

Since `cwd` and `env` are singletons (§4), network reach is the only
declared capability that distinguishes the tiers — and the distinction is
real only because §7's sandbox enforces it: `"none"` means egress denied,
`"registry-metadata"` means egress restricted to the session-configured
registry endpoints, and a runner that can only deny-all attests no
capability for `"registry-metadata"` entries (§6 rule 4). A session
assigning `auto-grant` to an operation above its ceiling is rejected at
session load (§5). The consequences line up with `docs/DOMAIN.md` §5
item 4's tier sketch: an auto-granted run can touch nothing but the issue
worktree, whose
contents are git-recoverable and whose adoption lands on an issue branch a
human reviews in the PR — worktree isolation is the blast-radius enabler,
not operator trust. Anything with network reach is at best notify-tier
(post-hoc review); anything not expressible in the registry at all is
human-gate (§3).

## 10. Notification and post-hoc review

A `notify-and-proceed` execution enqueues, in the same transaction that
records its adoption (§7 step 4), an operator notification through the
existing outbox and visibility pipeline (`docs/DOMAIN.md` §2.3 Delivery) —
never a new publication path, honoring
`docs/chatops-result-contract.md` §12 criterion 5. The notification's public
text is bounded and redacted: the operation id, the tier, the issue, and the
count of verified effect paths; never the exact command, the output, or the
policy internals (§12 criterion 3).

The review state itself is **new, tier-owned vocabulary**, exactly as
`docs/chatops-result-contract.md` §12 criterion 4 requires it to be:

```
postHocReview: "pending" | "acknowledged" | "flagged"
```

- It lives on the audit record (§11) — it is **not** a `ChatOpsResultKind`,
  not a ledger state or row, and not a task phase or task status. In
  particular it never overloads `ambiguous-execution` (execution status
  undecidable — here execution status is fully known) or `human-handoff`
  (disposition already known or abandoned — here the disposition is
  *proceed*, by policy).
- It is terminal-for-automation: the loop proceeds regardless of the review
  state; that is what "proceed" means in the tier's name. `"acknowledged"`
  closes the record. `"flagged"` marks it for human follow-up — an operator
  deciding the relaxation was wrong, narrowing the allowlist, or opening a
  corrective issue — but never retroactively blocks, reverts, or re-queues
  the completed run by itself.
- The operator surface that lists pending records and applies
  `acknowledged`/`flagged` is an implementation slice (§18), the same
  posture `docs/chatops-result-contract.md` §15 takes for its own audit
  surface.

## 11. Audit record

Every tier decision and every relaxed-tier execution is durably recorded —
the allowlist's "record and continue" is only as trustworthy as this trail:

- **Task events** (the `tool_request_grant_executed` naming precedent):
  `tool_request_tier_resolved` (every gate decision: the resolved
  `operationId` or none, the tier, the `TierRefusalReason` when human-gated),
  `tool_request_tier_executed` / `tool_request_tier_failed` (relaxed runs),
  and `tool_request_effects_exceeded` / `tool_request_effects_entangled`
  (§8 routing).
- **A run artifact** (`tool-request-tier.json`, sibling of
  `tool-request-grant.json`): the request's `displayCommand` (redacted form
  only), the resolved `operationId` and allowlist entry (tier, effective
  enumeration, and the session-config path the pinned execution came from),
  the executed substitution's identity, the containment-capability
  attestation it ran under (§7), exit status and bounded output, the
  observed effect set, the overlap paths and their per-path isolation
  verdicts (§7 step 4), the verification verdict, and for notify-tier runs
  the `postHocReview` state (§10).
- **Placement**: tier names, policy identifiers, and the *why* of a tier
  decision belong here and — when a port invocation is involved — in
  `OperationResult.data`, never in `summary`
  (`docs/chatops-result-contract.md` §12 criterion 3). Public comments about
  a tiered execution carry only what §10 allows.

## 12. Alignment with the callable port and the ChatOps chain

`docs/chatops-result-contract.md` §12 hands this document six admission
criteria; this section answers them one by one.

1. **No new outcome kind.** When an operation invocation is refused by tier
   policy at the port, the result is `rejected` with
   `reason: "not-permitted"` — an existing member of
   `OperationRejectionReason`
   (`docs/operation-dispatch-port-contract.md` §7) — and a tier that allows
   immediate execution yields `executed`/`success`, unchanged. The five-kind
   ChatOps vocabulary is untouched.
2. **Tiering is context construction.** The tier decision is upstream of
   dispatch: for a human actor (admin CLI, an allowlisted ChatOps author),
   the human *is* the gate, and `OperationContext.confirmed` reflects their
   explicit disposition exactly as `docs/operation-dispatch-port-contract.md`
   §5.2 already specifies. For the automation actor — the loop acting on its
   own behalf at the gate decision point — a relaxed tier is the *only*
   authority for constructing `confirmed: true`, and `human-gate` means the
   automation path never constructs it. Nothing in
   `docs/chatops-result-contract.md` §3–§4 changes.
3. **No policy internals in `summary`.** §10 and §11 place every tier name,
   policy identifier, and audit trail in the audit record or
   `OperationResult.data`; public text carries prose plus closed reason
   codes only.
4. **No overloaded pending state.** The deferred-review state is the new
   `postHocReview` vocabulary of §10, owned by this contract's audit
   surface — not `ambiguous-execution`, not `human-handoff`, not a ledger
   state.
5. **No new publication or retry policy.** The one notification this
   contract adds rides the existing outbox, visibility, and
   acknowledgement-retry machinery unchanged.
6. **The prerequisite chain is exactly** the callable port (#783), the
   result contract's §3–§10 (#785), and the operation mapping (#784). This
   document extends #784's world only in the sense that criterion allows: a
   tiering policy *over* typed operations. It adds no ChatOps verb, does not
   modify #784's table, and leaves any configurable per-surface policy
   engine over that table to later work, exactly as #784 §12's final bullet
   scopes it.

## 13. Where Tool Request lives — resolving DOMAIN.md §2.3

`docs/DOMAIN.md` §2.3 left one note open: *"Where does Tool Request live?
(Spans Execution and Operation today; the grant-policy tiers work in §5 will
force this decision.)"* This contract forces it, and the answer is that Tool
Request was only ambiguous while its policy was buried in handler
procedures. Typed tiers make the policy pure, and the razor of
`docs/DOMAIN.md` §2.1 then cuts cleanly:

- **State — Orchestration.** The request record and its lifecycle ride on
  the task (`docs/tool-request-and-dependency-sync.md` §2.5's context
  metadata), in task-store rows only Orchestration writes; the audit events
  of §11 are task events like any other.
- **Policy — Orchestration.** `resolveGrantTier` (§6) and the allowlist
  validation (§5) are pure policy functions in `core/`, the family
  `core/tool-request-changes.ts` already belongs to and that
  `docs/DOMAIN.md` §2.2 row 6 was already extracting.
- **Mechanics — Execution.** Detection and classification of an emitted
  request, worktree execution of a pinned substitution, effect observation,
  and residue handling stay in the handlers, behind the same worktree and
  lock machinery as every other Execution concern.
- **Operator surfaces — Operation.** `admin tool-request list|resolve|grant`,
  the guided flow, the ChatOps `tool-request.run`/`tool-request.resolve`
  operations (#784), and §10's future review surface are Operation entry
  points over the ports above — the "guided Tool Requests" maintenance-port
  row `docs/DOMAIN.md` §2.3's dependency matrix already reserved.

No context named "Tool Request" is created, and none needs to be: the gate
is a policy (Orchestration) exercised through operator surfaces (Operation)
over execution mechanics (Execution), which is the same decomposition every
other phase concern in the domain model already has.

## 14. `dependency.sync` — the first typed operation

The dependency-update route is not just the template (§1); it is the first
registry entry, which calibrates the whole design against a shipped
behavior:

```
operationId:      dependency.sync
trigger:          suggestedActions: ["dependencySync"]
                  preconditions:    ["dependency-request-parses",
                                     "dependency-ecosystem-configured",
                                     "dependency-sync-safe-mode",
                                     "dependency-not-already-satisfied"]
input:            parser → the §3.5 data-only install parser (package names
                  + explicit version ranges; refuses on a missing version
                  or an unsupported ecosystem)
execution:        in-process → the shipped §3.5 routine: apply the parsed
                  versions to the manifest as a pure JSON data edit, then
                  run the exact session-pinned dependencySync.command (the
                  routine's only subprocess)
policy:           cwd issue-worktree, env stripped, network registry-metadata
allowedEffects:   worktreePaths = session dependencySync.triggerPaths
                  ∪ dependencySync.expectedOutputs
```

- Its ceiling (§9) is `notify-and-proceed` — the pinned lockfile-only
  command reads registry metadata over the network — so no session can
  auto-grant it, and the tier sketch's "dependency additions, network …
  human gate" line is honored in the only way that is coherent with a
  shipped dependency-sync: the *free-form request* to install remains
  human-gated; the *typed, lockfile-only, lifecycle-scripts-off
  substitution* whose manifest edit still faces PR review is notify-tier at
  most.
- **"Lifecycle-scripts-off" is enforced, not assumed — the
  `"dependency-sync-safe-mode"` precondition.** The pinned
  `dependencySync.command` is operator-written session config, and the
  shipped schema lets a session opt into lifecycle scripts
  (`allowLifecycleScripts: true`,
  `docs/tool-request-and-dependency-sync.md` §3.1/§3.2a) — a configuration
  under which the same pinned command executes project- and
  dependency-authored code influenced by agent-edited manifest content.
  That execution cannot be given a truthful effect enumeration (lifecycle
  code may write any worktree path and reach the registry endpoints before
  §8 ever runs), so by §3's own admission condition it does not qualify for
  the notify tier — §7's sandbox containing it to the worktree does not
  make it enumerable. The entry therefore demands §3.2a **safe mode** twice
  over, fail-closed: at **session load**, an allowlist entry for
  `dependency.sync` in a session whose
  `dependencySync.allowLifecycleScripts` is `true` rejects the session with
  an actionable error (§5); at **each request**, the
  `"dependency-sync-safe-mode"` precondition holds only when the flag is
  absent-or-false *and* the pinned command passes the shipped structural
  lockfile-only validation (the `unsafe-command` refusal machinery of
  `runDependencySync`) — else `human-gate` / `"precondition-failed"`
  (§6 rule 5), which the migration exception hands back to the pre-#697
  flow, where a lifecycle-enabled session keeps exactly the behavior its
  operator opted into. Lifecycle-enabled dependency sync is thus
  permanently outside every relaxed tier: for such sessions the shipped
  route, with its own explicit opt-in and §3.2a warnings, *is* their policy
  spelling, and the subsumption bar below is scoped to safe-mode
  configurations.
- The entry models the **whole** shipped route
  (`docs/tool-request-and-dependency-sync.md` §3.5), not just its lockfile
  step. An add/bump Tool Request (`npm install pkg@^1.2.3`) arrives
  **before any manifest diff exists** — the manifest edit is something the
  route *produces*, not evidence it consumes — so the trigger carries no
  manifest-diff precondition, the parsed request itself is the decidable
  evidence, and the manifest paths sit in `allowedEffects` beside the
  lockfile: parse as data, edit the manifest as pure JSON, run the pinned
  lockfile command, verify the whole effect set against one enumeration.
- Today's route (an `enabled` dependency-sync session executes the pinned
  command with no waiting human) is this contract's notify tier avant la
  lettre, minus the uniform trail. The implementation slice aligns it:
  `dependency.sync` becomes an ordinary allowlist entry, its §3.5 data
  parser becomes the entry's `input.parser`, its §3.5 fallback conditions
  become the trigger preconditions, its existing public-comment/task-event
  surface becomes the §10 notification, and its `expectedOutputs` check
  becomes the §8 verification. Throughout the migration the shipped route
  is an explicit **compatible route**, with §6's migration exception as its
  mechanism: sessions with dependency-sync enabled but no
  `toolRequestTiers` block keep the
  `docs/tool-request-and-dependency-sync.md` behavior unchanged — rule 1's
  `"tiers-disabled"` (like an enabled block that omits the entry,
  `"not-allowlisted"`) hands such requests back to the pre-#697 flow where
  the shipped route still runs, never to an unconditional park — and the
  route is not subsumed until the typed entry — running under §7's
  enforcing sandbox — handles every request §3.5 handles today **under a
  safe-mode configuration** with no new human gate (lifecycle-enabled
  sessions sit outside the bar by the preceding bullet). Two request
  shapes the shipped route already serves calibrate that bar and are
  handled by the tier machinery itself rather than left to the exception:
  a request whose `suggestedAction` is absent or uniquely matches no entry
  — the shipped route reads only `command`, so `manual-review` or an
  unknown hint never blocked it — nominates the entry through §6 rule 2's
  parser probe, and a request arriving in a dirty worktree — the
  agent has typically already edited the manifest — runs against §7
  step 1's pre-substitution snapshot instead of being refused for
  uncleanliness, a manifest that is itself dirty being served as an
  overlap path: the routine's manifest write is a pure JSON data edit, so
  its isolated patch replays that data edit against the committed base
  (§7 step 4) instead of colliding with the agent's hunks, and only a
  genuinely non-isolable overlap parks for a human (§8). Only then does
  the target state become one policy spelling, this one.

## 15. Deferred: generic auto-grant of agent-proposed commands

Generic auto-grant of agent-proposed commands — any scheme where the agent's
own `command` text executes without a human because a policy judged the
*text* safe — is **explicitly deferred**, per `docs/DOMAIN.md` §5 item 4.
Deferred here means more than unscheduled: §1's undecidability argument is
an argument that no such judgment exists to encode, and §4's `execution`
shape leaves the scheme nothing to be configured *as* — a future issue that
wants it must first amend this contract with a containment story
(`docs/tool-request-redesign.md` §6's restricted-host / Docker / VM track is
the plausible one) that changes the premise, not just the allowlist. §7's
enforcing sandbox does not reopen the question: it contains a *pinned*
execution whose effects were enumerated ahead of time, whereas
agent-proposed text has no enumeration to declare, so §8's admission
condition still has nothing to verify it against.

## 16. Invariants

1. Free-form command text never participates in tier resolution: `command`
   and `reason` are unread by §6, and agent-supplied fields
   (`suggestedAction`) — or, for a request whose hint is absent or
   uniquely matches no entry, a declared parser's data-only accept verdict
   (§6 rule 2) — select at most a candidate, never an authorization.
   The only reader of `command` anywhere in the machinery is a declared
   `input.parser` (§4), whose output is typed data that parameterizes a
   pinned execution and never becomes executed bytes.
2. Under a relaxed tier, the executed bytes are always the pinned
   substitution; agent text is never executed. There is no registry shape
   that could express otherwise (§4).
3. Absence fails closed: no `toolRequestTiers` block, a disabled block, an
   unresolvable request, a missing containment attestation, a failed
   precondition, or a missing allowlist entry all yield `human-gate` — a
   verdict that returns the request to the pre-#697 disposition flow,
   which keeps the shipped §3.5 dependency-sync route until §14's
   subsumption point (§6), so opting out of (or into) tiers never revokes
   a shipped behavior; invalid configuration rejects the session at load
   (§5).
4. Every relaxed-tier adoption is effect-verified: `observed ⊆ enumerated`
   or nothing is adopted and the request routes to the human gate with the
   excess recorded (§8).
5. An operation with `network` other than `"none"` never executes under
   `auto-grant` (§9).
6. Tier machinery writes only inside the issue worktree, the run-artifact
   directory, and its own task-store rows — by §7's enforced boundary, not
   by the substitution's good behavior; canonical-repo, credential, and
   spend effects are unrepresentable (§4) and unreachable (§7).
7. No relaxed tier executes without the enforcing containment capability:
   declarative policy fields never authorize execution by themselves, and a
   host that cannot enforce an entry's policy routes every request for it
   to the human gate (§6 rule 4, `"containment-unavailable"`).
8. A typed operation succeeds under a relaxed tier at most once per task
   attempt; a repeat routes to the human gate as a real human handoff —
   `"already-executed"` sits outside §6's migration exception, so the
   pre-#697 dependency route never executes the repeat (§6 rule 6).
9. This contract adds no `ChatOpsResultKind`, no ledger state, row, or
   field, no task phase, and no ChatOps verb (§12).
10. Public surfaces carry only bounded, redacted text through the existing
    visibility pipeline; tier and policy internals live in the audit record
    and `OperationResult.data` (§10, §11).
11. The human-gate tier's semantics are byte-for-byte today's: this contract
    relaxes nothing except what an operator's session allowlist explicitly
    names.
12. Adoption never stages agent-authored bytes: a relaxed-tier commit
    contains, per observed path, the committed base plus the substitution's
    isolated patch (§7 step 4); an overlap that cannot be isolated adopts
    nothing and routes to the human gate with the entanglement recorded
    (§8).
13. No relaxed tier executes lifecycle scripts: `dependency.sync` requires
    the `docs/tool-request-and-dependency-sync.md` §3.2a safe mode both by
    session-load rejection and by precondition (§14), because an execution
    that runs project- or dependency-authored code has no truthful effect
    enumeration to declare (§8).

## 17. Test seams and matrix

Nothing in this document is implemented. When implementation begins, the
required coverage is:

| Area | Cases |
| --- | --- |
| Tier resolution (§6) | pure-function tests over `resolveGrantTier`: disabled block; parser-probe nomination with the hint absent, unrecognized (`manual-review`, an unknown value), and naming more than one entry — each falling through to the probe — plus probe refusal and cross-entry probe ambiguity → `no-candidate`; unlisted operation; missing containment attestation; each failed precondition, including a parse refusal (no explicit version, unsupported ecosystem, already satisfied) and a lifecycle-enabled dependency-sync configuration (`"dependency-sync-safe-mode"` off); repeat protection, including that `"already-executed"` parks as a real handoff and never re-enters the legacy dependency route; both happy paths — with `command` set to adversarial text throughout, asserting the resolver never reads it into the decision. |
| Registry validation (§4) | construction throws on malformed id, duplicate id, empty enumeration, unknown policy value, unknown parser or routine name; no entry without `allowedEffects` is constructible. |
| Session-load validation (§5) | unknown `operationId`, tier above ceiling, non-subset narrowing, duplicate entry, unrecognized tier value, and a `dependency.sync` entry alongside `dependencySync.allowLifecycleScripts: true` each reject the session with an actionable error; an absent block loads and human-gates everything. |
| Effect verification (§8) | observed-equals, strict-subset, and excess cases; excess adopts nothing, emits `tool_request_effects_exceeded`, and parks the request as a handoff with the diff preserved; overlap-isolation failure adopts nothing, emits `tool_request_effects_entangled`, and parks the same way with the combined diff preserved. |
| Execution flow (§7) | pre-substitution snapshot baseline: a dirty worktree is served, only the substitution's delta is observed and verified, and pre-existing agent edits stay unadopted and in place — including on an overlap path, where adoption stages only the substitution's isolated patch onto the committed base (data-edit replay for the manifest case) and a non-isolable overlap adopts nothing and parks; failure/timeout parks with continuation context and no adoption; success adopts the isolated patches on the issue branch and continues; notify tier enqueues its notification in the adoption transaction. |
| Containment enforcement (§7) | a relaxed-tier execution refuses to launch without a capability attestation; an out-of-worktree write attempt is denied by the sandbox and the run parks per §7 step 5 with nothing adopted; a `network: "none"` entry cannot reach the network; a deny-all-only host yields `containment-unavailable` for a `registry-metadata` entry. |
| Port alignment (§12) | a tier-refused invocation is `rejected`/`not-permitted`; a relaxed-tier invocation runs with `confirmed: true` constructed by the gate, never from a parameter; no tier internals appear in any `summary`. |
| Docs pin | `test/docs-tool-request-grant-tiers-contract.test.js` pins this document's tier set, refusal-reason set, ceiling rule, containment-capability requirement, dependency-route preservation (§6's reason-scoped migration exception and its `"already-executed"` carve-out, rule 2's probe fallback for absent or unmatched hints, §7's snapshot baseline, step 4's patch-level adoption boundary, and §14's safe-mode requirement), §12 criteria answers, the DOMAIN.md §2.3 resolution and §5 item 4 delivery paragraph, and the predecessor forward-pointer corrections against drift. |

## 18. Non-goals and forward pointers

This document defines the grant-tier policy layer only. It does not define,
and nothing implementing it should assume:

- **Implementation of the registry, resolver, handler wiring, session
  schema, audit surface, or the `dependency.sync` migration** — the
  executable chain's successor issues, starting at #915 (see the issue body
  for the authoritative GitHub Issue Relationships).
  **Delivered (#915)**: `docs/preflight-execution-plan-contract.md` — the
  preflight Execution Plan contract, which consumes this tier model as its
  trust foundation: an issue-/chain-scoped, snapshot-fingerprinted,
  operator-approved extension of the §5 session allowlist, resolved ahead
  of write-capable implementation and revalidated fail-closed per
  occurrence, with a preflight refusal always falling through to this
  contract's flow unchanged. Registry, resolver, handler wiring, runtime
  execution, and platform isolation remain with the chain's later issues.
  **Delivered (#916)**: `docs/single-host-platform-sandbox-contract.md` —
  the single-host platform and CLI sandbox capability contract: the closed
  darwin/linux platform set (macOS, Linux, WSL2, and EC2 as targets;
  native Windows and multi-host substrates rejected at startup), the rule
  that no agent CLI sandbox is ever credited with containing runner-owned
  commands, and the fail-closed, behaviorally attested capability probes
  under which a host that cannot supply §7's enforcing sandbox routes
  every relaxed request `"containment-unavailable"`. Registry, resolver,
  handler wiring, and the concrete sandbox mechanism remain with the
  chain's later issues.
  **Delivered (#917)**: `docs/single-host-execution-backend-contract.md` —
  the single-host isolated ExecutionBackend contract: the closed
  `local`/`native-sandbox`/`container` backend set behind which every
  runner-owned command execution routes, with backend selection a pure
  runner function no agent-authored byte can influence, no silent
  isolation downgrade, and §7's enforcing sandbox realized as the
  isolated backend a pinned substitution requires (never `local`).
  Registry, resolver, handler wiring, and the backend engines remain
  with the chain's later issues.
  **Delivered (#918)**: `docs/verification-execution-contract.md` —
  the runner-owned verification execution and continuation contract:
  operator-configured and preflight-approved verification executes
  unattended through the #917 seam with no per-run human stop, every
  multi-command set aggregates into one classified cycle outcome, and
  direct-to-review routing after a Tool Request resolution is gated on
  a passed runner-owned cycle plus durable state evidence — never on a
  successful command alone. Registry, resolver, handler wiring, and
  the backend engines remain with the chain's later issues.
  **Delivered (#919)**: `docs/unattended-tool-request-contract.md` —
  the unattended Tool Request handling and human parking contract: the
  chain's final design issue. It composes this contract's gate into one
  total decision and continuation table (preflight → tiers → legacy
  route → human gate, with the `"already-executed"` and
  `"occurrence-exhausted"` direct parks preserved), adds the
  `"auto-executed"` resolution record at the request-record seam this
  contract left to its slices, fixes the parking and repeat rules, and
  produces the final dependency-ordered implementation decomposition —
  awaiting human approval — that schedules this contract's registry,
  resolver, handler-wiring, and execution slices.
- **Registration of `tool-request.run` / `tool-request.resolve`** as real
  `OperationDescriptor`s — still the open item
  `docs/chatops-operation-mapping-contract.md` §12 assigns to whichever
  issue registers them.
- **A configurable policy engine over the ChatOps verb table** — out of
  scope exactly as #784 §12 scopes it.
- **Restricted-host / Docker / VM execution environments as a general
  substrate for agent-proposed commands** — the
  `docs/tool-request-redesign.md` §6/§9.4 track, which §15 names as the
  premise-changing prerequisite for ever revisiting generic auto-grant.
  Distinct from that track, §7's enforcing sandbox for pinned substitutions
  is **not** deferred: it is a required capability of the implementation
  slices above, and without it no relaxed tier executes (§6 rule 4).
- **Changes to the guided operator flow** — `docs/guided-tool-request-flow.md`
  is unchanged; the human gate *is* that flow.

That work is tracked by the executable chain this issue belongs to:
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships).
