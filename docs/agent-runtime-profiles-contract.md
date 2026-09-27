# Provider-centric agent runtime profile architecture

Status: **approved design; slices B1–B2 implemented, B3's adapter boundary, all three provider adapters, and the write-capable lane cutover landed, B4's audit record landed** (issues #903, #904, #905, #906, #907, #908, #909, #910, #911). This document
is the authoritative contract for how a phase run resolves the concrete
runtime settings of the agent that owns it — model, reasoning effort, budget,
binary, and provider-specific options. It defines a provider-centric profile
catalog addressed by four provider-neutral quality levels, where that catalog
lives, how operator overrides layer onto it, when it is read, what is refused,
and what is recorded. Follow-up implementation issues reference this
specification and MUST NOT redefine its policy; a change of policy is a change
to this document first.

**The write-capable lanes resolve through this contract; the read-side lanes
do not yet.** Issue #903 wrote this document
and changed no source file. Issue #904 landed slice B1 — the catalog schema,
the built-in catalog, the overlay merge, the loader, and the load-time
validator, in `src/core/agent-profile-catalog.ts` — as a pure core module no
handler reads. Issue #905 landed slice B2 — the quality vocabulary's ordering,
the compatibility mapping, per-phase-class resolution, escalation as a floor,
and the intake snapshot, in `src/core/agent-quality.ts` — as one shared
resolver that consults no provider and no capability, plus the one intake write
that persists its answer on the task. Issue #906 landed slice B3's boundary —
the adapter contract, the fail-closed provider registry, the shared §8.1
resolution engine, and the invocation sanitation gate (§7.1), in
`src/core/agent-runtime-adapter.ts` — as a typed seam with no provider adapter
registered and no lane wired through it. Issue #907 landed slice B3's first
provider adapter — the `anthropic` entry serving the Claude CLI, in
`src/core/claude-runtime-adapter.ts` — as a pure module a composition root can
register but no lane calls, so a resolved profile still becomes no argv any lane
runs. Issue #908 landed slice B3's second provider adapter — the `openai` entry
serving the Codex CLI, in `src/core/codex-runtime-adapter.ts` — on the same
terms, and with it the retirement of the obsolete assumption that this
provider's reasoning effort stops at the third of three tiers: the accepted
values are the capability descriptor's list, so an installation whose
Codex/model combination accepts a further tier declares it in the catalog
rather than waiting for a source change. Issue #909 landed slice B3's third and
last provider adapter — the `google` entry serving the Gemini/Antigravity
(`agy`) CLI, in `src/core/antigravity-runtime-adapter.ts` — on the same terms,
and with it the provider whose reasoning effort is folded into the model display
name rather than carried in a field of its own: the adapter requires no effort
setting, emits no effort flag, and refuses one that resolved, so no shared code
assumes this provider speaks another's effort vocabulary. Issue #910 landed
slice B4's audit record — the §13 metadata every billable run leaves behind, in
`src/core/agent-runtime-audit.ts` — as ONE provider-neutral record shape built
by a single projection from a resolution, so the same fields are emitted for
Claude, Codex, and Gemini/Antigravity and only the absent values differ; it
persists nothing itself, and with no lane resolving through the boundary yet no
run produces a record. Issue #911 then cut the
write-capable lanes over: `implementation` (all three providers, both
orchestration modes including fix/requeue) and `conflict_resolution` now
resolve their invocation through the boundary, delete their §1.2 chains, and
persist a §13 record per attempt, with the before/after table in §10.4. The
read-side lane cutovers and the operator commands are the follow-up boundaries
listed in §14; for the lanes not yet cut over, the resolution sites described
in §1.2 keep behaving exactly as they do today — there a persisted quality
request changes no invocation — and for those lanes this document still
describes the target, not the tree.

It does **not** specify, and no implementation built against it may assume:

- **Which agent owns which phase** — fixed by
  [assignment-profiles.md](assignment-profiles.md) (#259, #292, #694).
  Assignment profiles select the *agent* and nothing else; this contract
  starts from an agent id that has already been resolved and persisted. The
  #694 source-of-truth rules — `context.assignment` is authoritative, `agent:*`
  labels are a first-intake hint and thereafter display state, `admin
  task-assign` is the only post-intake reassignment — are unchanged and
  untouched by anything below.
- **The per-phase behavioral contract** — fixed by
  [phase-contracts.md](phase-contracts.md). A phase's success criteria, its
  handoff conditions, and its retry classification do not change because a
  different profile resolved.
- **Credentials, authentication, and provider selection for work items or the
  repo host** — fixed by [provider-architecture.md](provider-architecture.md).
  A runtime profile names model and effort *settings*; it never names, holds,
  or resolves a credential.
- **What commands an agent may run and under what containment** — fixed by
  [tool-request-grant-tiers-contract.md](tool-request-grant-tiers-contract.md)
  (#697) and
  [single-host-platform-sandbox-contract.md](single-host-platform-sandbox-contract.md)
  (#916). A profile is a cost/capability selection, never an authorization.
- **Arbiter eligibility and the same-provider/same-model rules** — fixed by
  [review-dispute-contract.md](review-dispute-contract.md) §8.2/§8.3 and
  `src/core/review-arbiter-profile.ts` (#839). This contract feeds that
  machinery better metadata (§13.4); it does not relax any of its rules.

## 1. Why a provider-centric contract — the gap this closes

### 1.1 Two things change at very different speeds

The workflow architecture — phases, handoffs, locks, the outbox — changes
slowly and deliberately. Provider model names, reasoning-effort tiers, price
points, and CLI flag spellings change on the providers' schedule, which is
much faster and entirely outside this repository's control.

Today those two speeds are entangled. A provider renaming a model, adding a
reasoning tier, or changing a flag's ceiling requires a source change in a
phase handler, a new test, and a release — for what is, in substance, a data
edit. **Runtime settings must be data the operator can edit, addressed by a
stable, provider-neutral vocabulary the workflow can hard-code.**

### 1.2 Where the decision lives today

The decision is currently spread across labels, environment variables, session
fields, and per-lane defaults, with no single owner. The inventory below is the
state this contract targets, not a list of bugs:

| Lane | Model | Effort | Budget | Binary |
| --- | --- | --- | --- | --- |
| Implementation (Claude) | `CLAUDE_MODEL` > `session.claude.complexityProfiles` > built-in `complexity:*` map | `CLAUDE_EFFORT` > escalation > tier map | `CLAUDE_MAX_BUDGET_USD` > tier map | fixed `claude` |
| Implementation (Codex) | `CODEX_MODEL` > `session.codex.model` > unset | `CODEX_EFFORT` > complexity-derived | n/a | fixed `codex` |
| Review (Claude) | `CLAUDE_MODEL` > `review:*`-derived | `CLAUDE_EFFORT` > `review:*`-derived | n/a | fixed `claude` |
| Review (Codex) | `CODEX_MODEL` > `session.codex.model` > unset | `CODEX_EFFORT` > `review:*`-derived, ceiling `high` | n/a | fixed `codex` |
| Review (Gemini/Antigravity) | none — never passed | none — no effort concept | n/a | `ANTIGRAVITY_BIN` > `agy` |
| Research (Antigravity) | `session.research.antigravity.model` | folded into the model name | n/a | `ANTIGRAVITY_BIN` > `agy` |
| Refinement / critic | `CLAUDE_MODEL` > hard-coded `opus` | `CLAUDE_EFFORT` > hard-coded | n/a | per agent |
| Reconsideration (#1085) | per lane, `CLAUDE_MODEL` > `opus`, or Codex's own chain | `CLAUDE_EFFORT` > `high`, or `CODEX_EFFORT` | n/a | per agent |
| Arbitration (#839, #846) | `DEFAULT_ARBITER_CLAUDE_MODEL` and each provider's own chain | `DEFAULT_ARBITER_EFFORT` | n/a | per agent |

Four consequences follow, and each is a requirement on the design below:

1. **Obsolete capability assumptions calcify into source.** Codex review is
   capped at `high` because `model_reasoning_effort` accepted only
   low/medium/high when that code was written; the ceiling lives in a comment
   and a TypeScript union (`ReviewStrength`), so revisiting it is a code
   change. A capability ceiling is a fact about a provider CLI at a point in
   time. It belongs in data, with a declared, auditable value (§6.3).
2. **Adding a lane multiplies the decision.** Each new lane — reconsideration,
   arbitration, refinement critic — has had to restate its own model/effort
   default chain, so the same operator intent ("run this cheaply") has no
   single expression.
3. **A phase-by-provider matrix would grow combinatorially.** Nine lanes times
   three providers times four tiers is not a configuration surface an operator
   can hold. Centering on the provider collapses it (§4.3).
4. **The label vocabulary leaks provider effort names.** `complexity:xhigh`
   and `review:high` read as literal provider effort values, which is why
   `review:xhigh` had to be declared "not a recognized label" rather than
   meaning something. Labels should express *how much quality this work
   deserves*; the provider decides what that costs (§10).

## 2. The core idea in one paragraph

An assignment profile already answers **who** runs a phase. This contract adds
one orthogonal question — **how much quality** — answered by one of four
provider-neutral levels. The pair `(agent, quality)` is then resolved against a
**provider catalog**: per-provider named profiles carrying concrete settings,
plus an explicit binding from each quality level to one of those names. The
agent's adapter turns the resolved settings into an invocation for its own
lane. The catalog is data, lives outside `sessions.json`, ships with built-in
defaults, accepts partial overrides, and is read fresh at each phase start.

```
assignment profile ──> agentId ──┐
                                 ├──> catalog[provider].qualityBindings[quality]
trusted labels ──> quality ──────┘         │
                                           v
                                    named profile ──> adapter ──> argv
                                    (model, effort,
                                     budget, binary,
                                     providerOptions)
```

## 3. Vocabulary

- **Quality level** — one of the four provider-neutral values `light`,
  `normal`, `strong`, `maximum` (§5). A *request*, never a setting.
- **Provider** — the company/runtime behind an agent (`anthropic`, `openai`,
  `google`), as `providerForAgent()` already resolves it. The catalog is keyed
  by provider, not by agent id, so two agent ids backed by the same provider
  share a catalog entry.
- **Runtime profile** — a named, provider-scoped bundle of concrete settings:
  `model`, `effort`, `budget`, `binary`, and `providerOptions`. Names are
  operator-facing strings (e.g. `claude-strong`), scoped to their provider.
- **Quality binding** — the declared map, per provider, from each of the four
  quality levels to exactly one runtime profile name.
- **Capability descriptor** — the per-provider declaration of which setting
  keys that provider accepts and, for enumerated settings, which values
  (§6.2). Validation is driven by this descriptor, not by hard-coded unions.
- **Catalog** — the whole document: providers, their profiles, their bindings,
  their capability descriptors, and a schema version.
- **Adapter** — the per-provider code that turns a resolved profile into a
  concrete invocation for a given lane (§7).
- **Resolved runtime profile** — the audit record of one phase run's
  resolution: requested quality, chosen profile, every concrete value, and the
  source of each (§13).

## 4. Ownership and layering

### 4.1 The layer table

Each row has exactly one owner. Nothing below may be decided by a layer other
than its owner.

| Decision | Owner | Source of truth |
| --- | --- | --- |
| Which agent owns a phase | assignment profile | `context.assignment` (#694) |
| Which provider backs an agent | agent registry | `providerForAgent()` |
| How much quality this work deserves | quality resolution (§9) | task-persisted requested quality |
| Which named profile a quality level means for a provider | catalog quality binding | catalog file, or built-in |
| What concrete model/effort/budget/binary that name carries | catalog runtime profile | catalog file, or built-in |
| Which of those settings the provider accepts | capability descriptor | catalog file, or built-in |
| How settings become argv for a lane | adapter | source (per provider) |
| Whether the invocation is authorized to do anything | grant tiers (#697) | out of scope here |

### 4.2 Assignment profiles are untouched

Restating #694 decision 5 in this contract's terms, unchanged: **assignment
profiles select the agent and never its runtime settings.** An
`assignmentProfiles` entry MUST NOT gain a `model`, `effort`, `budget`,
`quality`, or `profile` field; a validator that sees one rejects the config.
The two mechanisms are joined by exactly one value — the resolved agent id.
Every source-of-truth rule in
[assignment-profiles.md](assignment-profiles.md) ("Assignment vs. `agent:*`
Labels") survives verbatim.

### 4.3 The matrix stays provider × quality

**No phase-specific model profiles** (a stated non-goal). The catalog is keyed
by provider and quality level only — twelve bindings for three providers, not
one entry per (phase, provider, tier). A phase influences resolution in exactly
one way: it decides *which requested quality applies* (an implementation-class
phase reads the implementation-class quality, a review-class phase reads the
review-class quality; §9.3). It never selects a different catalog entry, and
the catalog schema has no phase key to select one with. Lane-specific
*invocation* differences — Codex's global `--model` versus its `-c
model_reasoning_effort`, Claude's `--effort`, Antigravity's `--print` — are the
adapter's business (§7), not the catalog's.

## 5. The four quality levels

```
light  <  normal  <  strong  <  maximum
```

`QualityLevel` is a closed, ordered union of exactly those four values. It is
the one vocabulary in this design that IS a permanent TypeScript union
(§14.3) — because it is provider-neutral and does not track any provider's
catalog.

The levels are defined by intent, relative to each other, within a provider:

- **`light`** — the cheapest resolution an operator is willing to ship. For
  mechanical, well-specified, low-blast-radius work. Being wrong here costs a
  retry, not a rollback.
- **`normal`** — the default. The resolution that should handle ordinary work
  without an operator thinking about it. Absent any signal, this is what runs.
- **`strong`** — deliberately more capable than `normal` at materially higher
  cost, for work whose difficulty was recognized in advance.
- **`maximum`** — the strongest resolution the provider offers for this kind
  of work, with cost explicitly not the deciding factor.

Three rules keep the vocabulary honest:

1. **A quality level never names a model or an effort value.** `maximum` is
   not `xhigh`; `normal` is not `medium`. The coincidence that a provider's
   `normal` binding today carries `high` effort (as Claude's and Codex's
   review defaults do) is a fact about that binding, not about the level.
2. **The ordering is within a provider, not across providers.** `strong` on
   Codex and `strong` on Claude are both "deliberately more capable than that
   provider's normal". This contract makes no claim that they are equivalent,
   equally expensive, or comparable in output quality. Cross-provider
   comparison is exactly what #839's same-model/same-provider rules already
   refuse to infer, and nothing here gives them a new basis to infer it.
3. **A level is a request; a binding is the answer.** Requesting `maximum`
   guarantees the resolution declared for `maximum`. It does not guarantee
   that the resolution differs from `strong` — see §6.3.

## 6. Provider catalogs

### 6.1 Catalog shape

The catalog is a JSON document. The shape is normative; the values shown are
illustrative and MUST NOT be read as a permanent model recommendation.

```json
{
  "schemaVersion": 1,
  "catalogVersion": "2026-09-07",
  "providers": {
    "anthropic": {
      "capabilities": {
        "model": "free",
        "effort": ["low", "medium", "high", "xhigh", "max"],
        "budget": "free",
        "binary": "free"
      },
      "profiles": {
        "claude-light":   { "model": "sonnet", "effort": "low",   "budget": "2"  },
        "claude-normal":  { "model": "sonnet", "effort": "high",  "budget": "5"  },
        "claude-strong":  { "model": "opus",   "effort": "high",  "budget": "10" },
        "claude-maximum": { "model": "fable",  "effort": "xhigh", "budget": "20" }
      },
      "qualityBindings": {
        "light": "claude-light",
        "normal": "claude-normal",
        "strong": "claude-strong",
        "maximum": "claude-maximum"
      }
    },
    "openai": {
      "capabilities": { "model": "free", "effort": ["low", "medium", "high"] },
      "profiles": {
        "codex-light":  { "effort": "low" },
        "codex-normal": { "effort": "medium" },
        "codex-high":   { "effort": "high" }
      },
      "qualityBindings": {
        "light": "codex-light",
        "normal": "codex-normal",
        "strong": "codex-high",
        "maximum": "codex-high"
      }
    },
    "google": {
      "capabilities": { "model": "free", "binary": "free", "providerOptions": ["printTimeout"] },
      "profiles": {
        "agy-light":   { "providerOptions": { "printTimeout": "15m" } },
        "agy-normal":  { "providerOptions": { "printTimeout": "15m" } },
        "agy-strong":  { "providerOptions": { "printTimeout": "30m" } },
        "agy-maximum": { "providerOptions": { "printTimeout": "30m" } }
      },
      "qualityBindings": {
        "light": "agy-light",
        "normal": "agy-normal",
        "strong": "agy-strong",
        "maximum": "agy-maximum"
      }
    }
  }
}
```

Notes on the shape, all normative:

- **Every setting field is optional.** An omitted field means the provider's
  own default applies — for Codex's `model`, exactly today's compatibility
  mode where no `--model` flag is passed. Omission is recorded as an absence
  (§13.3), never as a model named `"default"`.
- **`providerOptions` is an open string map**, the escape hatch for settings
  that exist for one provider only (Antigravity's `printTimeout`, a future
  Codex `-c` override). Its *keys* are constrained by the capability
  descriptor; its values are opaque strings the adapter interprets.
- **Profile names are scoped to their provider.** `claude-strong` and
  `codex-high` never collide, and a binding may only name a profile declared
  under the same provider.
- **The catalog carries no phase key, no agent id, and no credential.** A
  loader that encounters one rejects the file (§12).

### 6.2 Capability descriptors make ceilings data

A capability descriptor declares, per setting key, either `"free"` (any string
is accepted; the provider CLI is the real judge) or an explicit array of
accepted values (an enumerated setting). A key absent from the descriptor is a
setting that provider does not accept at all.

This is the mechanism that moves an obsolete assumption out of source: Codex's
low/medium/high effort ceiling becomes the array
`"effort": ["low", "medium", "high"]` in the catalog. When the Codex CLI gains
a tier, an operator adds the value and rebinds `maximum` — a data edit, with
no source change, no new TypeScript union member, and no release. Symmetrically,
Antigravity declares no `effort` key at all, because Antigravity folds effort
into the model display name; a profile that sets `effort` under `google` is
rejected at load rather than silently ignored.

Model names are always `"free"`. The loop never maintains a list of valid model
names, never normalizes or aliases one, and never asks a provider for one
(§11.3). Whether a model exists is the provider CLI's answer at run time,
surfaced as a fail-closed run error — the stance
[assignment-profiles.md](assignment-profiles.md) already documents for the
Fable 5 preflight.

### 6.3 Two levels may bind to the same profile — declared, never silent

A provider whose CLI genuinely offers only three useful steps binds two quality
levels to the same profile, as `openai` does above for `strong` and `maximum`.
This is **explicitly permitted and is not a downgrade**, because:

- the binding is declared in the catalog, visible before any run;
- the resolved record still reports `requestedQuality: "maximum"` alongside
  the concrete settings, so an operator can see that the request was honored
  by a profile shared with `strong` (§13.2);
- the operator can change it by editing one line, the moment the provider
  gains a stronger tier.

Contrast this with what remains forbidden: **a runtime clamp**. Nothing may
inspect a resolved setting, decide the provider will not accept it, and
substitute a nearby value. Unsupported settings refuse (§12.3). "Declared
equality at configuration time" and "silent substitution at run time" are
different things, and only the first is allowed.

This also retires the awkward `review:xhigh` situation. Today `review:xhigh` is
"not a recognized label" precisely so it is not silently downgraded. Under this
contract the operator writes `quality:maximum`, and the answer for a Codex
review is whatever the `openai` `maximum` binding says — today the same profile
as `strong`, tomorrow a stronger one, with the difference recorded either way.

### 6.4 Every level must be bound

For each provider present in the effective catalog, all four quality levels
MUST resolve to a declared profile. There is no fallback level, no
"nearest lower binding", and no inheritance from another provider. An unbound
level is a load-time validation failure (§12.2), not a run-time surprise.

## 7. Adapters own the invocation

A resolved profile is settings, not a command line. Each provider has one
adapter responsible for turning `(profile, lane)` into an invocation:

- **Anthropic** — `--model <model> --effort <effort>`, budget applied through
  the lane's existing budget mechanism (shipped in §7.2).
- **OpenAI/Codex** — `--model <model>` spliced as a *global* option before the
  `exec`/`review` subcommand (the existing positioning rule), effort as
  `-c model_reasoning_effort=<effort>` after it. An absent model passes no
  `--model` at all.
- **Google/Antigravity** — `<binary> --print`, `--model <model>` when set,
  `--print-timeout <providerOptions.printTimeout>` when set.

Two rules bound the adapters:

1. **A setting the lane cannot express is recorded as not applicable, never
   dropped in silence.** Claude's review lane has no budget mechanism, so a
   `budget` on a profile used by that lane resolves to
   `budgetApplied: "not-applicable"` in the audit record. That is a declared
   asymmetry between lanes of the same provider, visible in the record.
2. **An adapter never re-derives a setting.** It consumes the resolved profile
   and the operator env overrides passed to it (§8); it does not consult
   labels, the session, or a default of its own. When §14's slices land, the
   per-lane default chains inventoried in §1.2 are deleted, not layered under.

### 7.1 The common boundary the adapters plug into

Slice B3's boundary (issue #906, `src/core/agent-runtime-adapter.ts`) fixes
the contract every adapter implements and the pipeline every lane will call:

- **A provider registry that fails closed.** Adapters register under the
  catalog's provider keys; the agent→provider mapping is injected by the
  caller, and an unknown or unregistered agent — including one the shipped
  fail-open mapping echoes back as its own provider — refuses
  (`unknown-provider`) rather than resolving to a settings-free invocation.
- **One shared §8.1 resolution engine.** Environment overrides, the task and
  session profile pins, and the quality binding resolve in one place, with
  every override validated against the capability descriptors before any
  billable invocation (`invalid-override`, `unknown-profile`) and every
  resolved value carrying its §13.2 source.
- **A sanitation gate over the invocation data.** The plan's command must be
  the resolved binary, argv stays control-character free, and the lane's
  prompt reaches the CLI verbatim on the channel the plan declares — stdin
  where a lane requires it today — so a prompt can never silently migrate or
  be dropped. A resolved budget must be declared applied or not applicable
  (rule 1 above), never dropped in silence.
- **A typed configuration/transient split.** Everything the boundary throws is
  deterministic, pre-invocation, and human-actionable; a transient agent
  execution failure keeps its existing run-time classification (issue #897),
  and the optional CLI discovery hook interprets a typed probe outcome so a
  transiently unprobeable CLI is `indeterminate`, never recorded as
  unavailable. Discovery is informational only and never feeds the catalog
  (§11.3).

The boundary is pure and spawns nothing: lanes keep their runner seams, their
sandbox and permission flags, their timeouts, and the isolation bracket, which
is why each lane can migrate onto an adapter one cutover at a time, with no
flag day.

### 7.2 The Claude adapter

Issue #907 landed the first provider adapter, `src/core/claude-runtime-adapter.ts`,
serving the catalog's `anthropic` key. It supplies the provider-specific
knowledge §7 leaves to an adapter, and nothing else:

- **The break-glass variables.** `CLAUDE_MODEL`, `CLAUDE_EFFORT`, and
  `CLAUDE_MAX_BUDGET_USD` keep their §1.2 meaning and their §8.1 layer-1
  precedence: each overrides one field, leaves the others resolving normally,
  and is still checked against the provider's capability descriptor, so a
  break-glass value may replace a setting but never widen what the provider
  accepts. There is deliberately **no binary override**: the shipped Claude
  lanes all run a fixed `claude`, and an operator who needs another executable
  sets `binary` on a catalog profile, which is validated like any other setting
  rather than trusted from the ambient environment.
- **A lane table, as data.** Four lanes are served — `implementation`,
  `conflict_resolution`, `review`, and `no_tools` (the reviewer's
  reconsideration, the arbiter, and the refinement critic share one read-only
  invocation). Each entry declares that lane's tool boundary, whether it grants
  an edit permission mode, which auto-approval allowlist it carries, and whether
  it can express a per-run budget cap at all. **Those are properties of the
  lane, never of a profile**: no catalog edit can add a permission mode, widen
  an allowlist, or dissolve the read-only boundary, and a lane the table does
  not declare refuses rather than inheriting a less restricted shape.
- **The §7 rule-1 asymmetry, declared.** The `review` and `no_tools` lanes have
  no budget mechanism, so a resolved budget on those lanes is reported as
  `budgetApplied: "not-applicable"` and passes no flag — visible in the record,
  never dropped in silence. The two editing lanes report `applied` and pass
  `--max-budget-usd`.
- **A pre-invocation validation pass.** Before any billable run, every concrete
  value is checked for the shape the Claude CLI needs: present, free of
  whitespace the flag cannot hold, and not flag-shaped — a model or binary
  beginning with `-` would be parsed as another option and silently change the
  invocation. A provider option the Claude invocation has no place for refuses
  (`unsupported-setting`) rather than being accepted and ignored.

An absent model or effort passes no flag at all, so a profile that unsets one
returns the Claude CLI to its own default (§6.1) rather than resolving to a
model named `"default"`. Every lane delivers its prompt on **stdin**, verbatim,
and never as an argv element — which is what keeps a resolved profile's argv
loggable in full.

The adapter names no model and no effort value anywhere in its source (§14.3):
a model refresh stays a catalog edit. It is registered by a composition root
and, since issue #911, called by the write-capable lanes (`implementation`,
`conflict_resolution`), whose cutover carries its own §10.4 before/after
table — that table is where what the review loop's escalation floor buys
became a quality level and therefore a different profile, where the
pre-cutover `escalatedEffort` raised effort only. For this provider one
difference remains, owed to the review cutover: an explicit `review:medium`
(§9.2 divergence 1). It is a binding decision with operator-visible cost
consequences, so it belongs to the cutover that documents it, not to the
adapter that makes it expressible.

### 7.3 The Codex adapter

Issue #908 landed the second provider adapter, `src/core/codex-runtime-adapter.ts`,
serving the catalog's `openai` key. It supplies the provider-specific knowledge
§7 leaves to an adapter, and nothing else:

- **The break-glass variables.** `CODEX_MODEL` and `CODEX_EFFORT` keep their
  §1.2 meaning and their §8.1 layer-1 precedence: each overrides one field,
  leaves the other resolving normally, and is still checked against the
  provider's capability descriptor, so a break-glass value may replace a setting
  but never widen what the provider accepts. `CODEX_MODEL` reaching the boundary
  as a validated override is the whole of this provider's explicit model
  selection — the descriptor declares `model` as `"free"` (§6.2), the loop keeps
  no list of model names, and whether the named model exists is the CLI's answer
  at run time. There is deliberately **no binary override**, for the same reason
  as §7.2, and **no budget variable**: the Codex CLI has no per-run budget cap
  flag on any lane, so every lane declares `budgetApplied: "not-applicable"`
  (§7 rule 1) rather than a budget being dropped in silence.
- **A lane table, as data.** Four lanes are served — `implementation` (`codex
  exec`), `review` (`codex review --base <branch>`), `structured_exec` (the
  read-bounded `codex exec` carrying `--json` and its run-owned output paths,
  shared by the structured review runner and the reviewer's read-bounded
  reconsideration turn), and `read_bounded` (the same sandbox posture without
  the event stream). Each entry declares the subcommand, the sandbox and
  approval flags the lane pins, whether it names a base branch, which run-owned
  output paths it can splice, and whether it has a place for a context-mode
  form. **Those are properties of the lane, never of a profile**: no catalog
  edit can drop a `--sandbox` pin, add an output path a lane does not read, or
  widen a read-bounded lane, and a lane the table does not declare refuses
  rather than inheriting a less restricted shape. `--sandbox read-only` is never
  a no-tools boundary — it bounds writes and network while leaving reads
  available — and the table says so where the lane is declared.
- **One argument-ordering rule, applied once.** `--model` and `--profile` are
  GLOBAL Codex options and precede the subcommand; `-c` overrides follow it,
  the resolved reasoning effort first and the operator's context-mode entries
  after, with any run-owned output path between the subcommand and the
  overrides. Splicing a global after `exec`/`review` makes the CLI fail argument
  parsing before the run starts, which is why the rule lives in one place here
  instead of once per lane.
- **Context-mode stays operator-supplied (#376).** The invocation form is never
  guessed: the caller resolves it from session config and passes it in as a lane
  input, and the adapter only places it. A lane with no place for one refuses a
  configured form rather than accepting it and emitting nothing. A context-mode
  `-c` entry naming a setting the adapter itself emits — the model or the
  reasoning effort — refuses too: Codex takes the last value on the command
  line and context-mode entries are emitted last, so honoring one would let an
  unvalidated value silently replace the resolved, capability-checked one from
  below the §8.1 ladder. An operator retargets the profile or breaks the glass
  with the variable instead.
- **A pre-invocation validation pass.** Before any billable run, every concrete
  value and every lane input is checked for the shape the Codex CLI needs:
  present, free of control characters, and not flag-shaped, with the whitespace
  rule that fits the value — a reasoning effort and a git ref are single tokens,
  while a run-owned output path is its own argv element and is preserved
  verbatim, spaces and all, rather than trimmed or refused. A provider option
  the Codex invocation has no place for refuses (`unsupported-setting`) rather
  than being accepted and ignored.

An absent model or effort passes no flag at all, so a profile that unsets one
returns the Codex CLI to its own configured default (§6.1) rather than resolving
to a model named `"default"` or to an effort the adapter picked. Every lane
delivers its prompt on **stdin**, verbatim, and never as an argv element.

The adapter **names no model and no reasoning-effort value anywhere in its
source** (§14.3), and — the point of this slice — **it never clamps**. The
`xhigh`/`max` → third-tier mapping the shipped per-lane chains still perform is
the silent substitution §12.3 forbids, and it is not reproduced behind the
adapter: an effort the provider does not declare was already refused by the
catalog validator or the boundary, and an installation whose Codex/model
combination accepts a stronger tier declares that value in its capability
descriptor and binds a quality level to it. Discovery reports the installed
CLI's version, and the resolution reports the effective model and effort with
each value's own source (§13.2); neither ever feeds the catalog (§11.3),
because inferring a capability from a version banner is how the retired ceiling
reached source in the first place.

The implementation lane is cut over (issue #911, §10.4): the unlabelled-run
divergence B1 recorded is closed by the data edit §9.2 predicted — the
built-in `normal` binding now targets `codex-high` — and the context-mode
`--profile` the pre-cutover lane spliced after `exec` now lands before the
subcommand, per the ordering rule above. What remains for this provider is
the review cutover's own difference, an explicit `review:medium` (§9.2
divergence 2), which is that cutover's business, with its own §10.3
before/after table, not the adapter's.

### 7.4 The Gemini/Antigravity adapter

Issue #909 landed the third and last provider adapter,
`src/core/antigravity-runtime-adapter.ts`, serving the catalog's `google` key.
It supplies the provider-specific knowledge §7 leaves to an adapter, and
nothing else:

- **The break-glass variable.** `ANTIGRAVITY_BIN` keeps its §1.2 meaning and
  its §8.1 layer-1 precedence, and is still checked against the provider's
  capability descriptor. This is the one provider whose inventoried variable
  names the **binary** rather than a model or an effort, which is why it is
  honored here where §7.2 and §7.3 deliberately decline a binary override:
  every shipped Antigravity lane already selects its executable this way, so
  honoring it preserves an established affordance instead of trusting a new
  one — and it turns today's `ANTIGRAVITY_BIN` set-but-empty case into a
  refusal rather than a spawn of the empty string. There is deliberately **no
  model variable and no effort variable**: §8.1 inventories neither for this
  provider, the model is a profile setting the catalog validates, and adding a
  variable here would be an adapter writing §8.1's contents.
- **One invocation shape, and the ordering rule that comes with it.**
  `<binary> [--model M] [--print-timeout T] --print <operand>`. `--print` is
  what puts the CLI in non-interactive mode, and on the pinned build it is a
  flag that **must have a value**, so it is emitted last and the operand is
  part of the shape rather than an optional tail — anything spliced after the
  prompt would be read as the prompt. An invocation with no prompt is
  therefore not expressible at all, and refuses rather than emitting a bare
  `--print` that fails argument parsing after the phase has started.
- **A lane table, as data.** Five lanes are served — `implementation`,
  `review`, `research`, `content_draft`, and `content_review`, the shipped
  paths that invoke `agy` today. There is no `conflict_resolution` entry,
  because no shipped lane invokes this provider for it. Unlike the other two
  providers every entry carries the same invocation shape, because `agy` has
  one non-interactive mode and neither the model flag nor the print timeout
  varies by lane; the table still exists so a lane nobody declared refuses
  rather than resolving, and so the one property that **does** vary per lane
  has somewhere to live.
- **Two prompt transports, and which lane may ask for which.** By default the
  prompt reaches the CLI on **both** channels — as the `--print` operand and on
  stdin — because some `agy` builds read the prompt only from the operand and
  ignore stdin, so a stdin-only delivery would silently run the phase on no
  prompt at all. The research lane's repository-evidence loop is the one path
  that needs the other transport: from its second turn the prompt has grown
  with evidence content and must not reach execve's argument area, so it
  delivers on stdin only and satisfies the parser with a fixed, content-free
  operand. **That is a property of the lane, never of a profile**: getting it
  wrong is silent, so a lane whose spec does not accept the stdin-only
  transport refuses one.
- **Effort as a provider fact, declared once.** The `google` descriptor
  declares no `effort` key, because this provider folds the tier into the model
  **display name** — one model string, not a model plus a tier — so the adapter
  emits no effort flag and requires no effort field. An effort that somehow
  resolved (an operator widened the descriptor and set it) **refuses** rather
  than being dropped in silence, and the refusal says where the tier actually
  lives. This is also why a model here is not treated as a single token: a
  display name legitimately carries plain spaces and parentheses, and only what
  would stop naming a model at all is refused.
- **The `printTimeout` provider option.** The catalog validates that a profile
  names only options the descriptor declares, but not their values (§6.1), so
  the adapter validates this one with the same parser the session registry and
  the research handler already use (issue #861) before it becomes argv. Any
  other provider option refuses (`unsupported-setting`) rather than being
  accepted and ignored. Every lane reports `budgetApplied: "not-applicable"`:
  the CLI has no budget cap flag, which is a declared asymmetry (§7 rule 1).
- **Capability discovery that cannot be mistaken for availability.** Two
  probes, deliberately kept apart. `<binary> --version` answers whether the CLI
  is there, through the boundary's own interpreter, and is **the only probe that
  may answer `unavailable`**. `<binary> models` answers what it offers, under a
  bounded deadline, and reports in its own vocabulary — `listed`,
  `undiscovered`, `indeterminate` — so a build with no `models` subcommand, or
  one that exits non-zero listing them, is recorded as a capability this loop
  could not read and **never** as a missing agent. Neither probe feeds the
  catalog (§11.3): a listed name is operator-facing detail, no configured model
  is ever checked against it, and a model this loop could not list still
  resolves, because `model` is `"free"` and the CLI is the judge at run time.

An absent model passes no `--model` at all, so a profile that unsets one
returns the CLI to its own default (§6.1) rather than resolving to a model named
`"default"`. The adapter **names no model anywhere in its source** (§14.3), and
names no effort value either — there is no effort vocabulary here to name, which
is the point.

The implementation lane is cut over (issue #911): every built-in `google`
profile carries a `printTimeout`, so that lane now passes `--print-timeout
15m` and stopped running under Antigravity's own five-minute print-mode
default — an operator-visible change in when a run is cut off, recorded in
§10.4's before/after table. The read-side lanes that pass none today gain the
same flag at their own cutover, under their own §10.3 table, not the
adapter's.

## 8. Precedence

### 8.1 Concrete settings

Highest wins. Every entry records a distinct source value in the audit record.

| # | Layer | Granularity | Recorded source |
| --- | --- | --- | --- |
| 1 | Operator environment override for that provider (`CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_MAX_BUDGET_USD`, `CODEX_MODEL`, `CODEX_EFFORT`, `ANTIGRAVITY_BIN`) | one field | `env` |
| 2 | Task-pinned profile name (explicit operator action) | whole profile | `task-pin` |
| 3 | Session per-agent profile pin (`session.agentRuntime.pins.<agentId>`) | whole profile | `session-config` |
| 4 | Quality binding in the effective catalog, where the operator overlay supplied the value | whole profile | `catalog-overlay` |
| 5 | Quality binding in the effective catalog, where the built-in supplied the value | whole profile | `catalog-builtin` |

Layer 1 is **field-level and break-glass**: setting `CLAUDE_EFFORT` overrides
effort and leaves model and budget resolving normally. Layers 2–5 are
**profile-level**: a pin replaces the binding lookup outright rather than
merging with it, so a pinned profile's omitted field stays omitted.

Layers 2 and 3 name a *profile*, never a raw model string. An operator who
wants a one-off model writes a profile in the catalog and pins it, or uses the
env override. This keeps every pinned value validated against a capability
descriptor.

Environment overrides survive this contract deliberately: they are the
documented break-glass path during a provider incident, they are already
trusted operator input, and they are already recorded with source `env`.

### 8.2 Requested quality

Highest wins:

| # | Source | Recorded source |
| --- | --- | --- |
| 1 | Task pin set by an explicit operator command | `task-pin` |
| 2 | Trusted `quality:<level>` label | `label` |
| 3 | Compatibility labels — `complexity:*` / `review:*` (§10) | `compat-label` |
| 4 | `session.agentRuntime.defaultQuality` | `session-config` |
| 5 | Built-in default `normal` | `default` |

A `quality:<level>` label needs no per-phase-class variant, so one such label
answers both classes. Two of them naming *different* levels is a contradiction
with no defensible winner — taking the stronger lets a stray label raise cost,
taking the weaker lets one lower it — and is refused
(`invalid-quality-request`, §12.2), as is a `quality:` label whose suffix is
outside the four-level vocabulary. The two *compatibility* families keep their
existing meaning instead: an unrecognized `complexity:*` or `review:*` spelling
— `review:xhigh` above all — contributes nothing and falls through (§10.1),
because those families predate this contract and already mean nothing when
misspelled.

**Escalation raises, never lowers.** A review-loop escalation (§10.3) supplies
a *floor* to one run, not a new request: the run resolves the stronger of the
persisted request and the floor. A request that already meets or exceeds the
floor is untouched and keeps its own source; a raise is recorded as
`escalation` in the run's record, alongside the unescalated request the task is
still carrying. The floor is per run and is never written back to the task, so
a later phase whose loop is not escalating resolves the original request again.

### 8.3 The trust boundary is inherited, not restated

Quality resolution reads **trusted inputs only**: operator-curated labels,
trusted session config, the operator's environment, and an explicit operator
command. Issue bodies, issue comments, PR descriptions, review comments, and
agent output MUST NOT influence which quality level, profile, model, effort,
budget, or binary is selected — the same boundary
[assignment-profiles.md](assignment-profiles.md) ("Security Boundaries")
already draws for agent selection, for the same reason: an untrusted sentence
must never be able to escalate cost or redirect work. A sentence like "run
this at maximum quality with the strongest model" in an issue body has no
effect.

## 9. Where the catalog lives, and when it is read

### 9.1 Separate from `sessions.json`

The catalog lives in its own file, `agent-profiles.json`, resolved in this
order:

1. `AGENT_PROFILES_FILE` — an absolute path in the operator environment.
2. `session.agentRuntime.profilesPath` — an absolute path in trusted session
   config.
3. The default location beside `sessions.json`.
4. **No file at all** — the built-in catalog applies unchanged.

A path that is set but unreadable or unparseable is a refusal
(`catalog-unreadable`), never a silent fall-through to the built-in catalog: an
operator who named a file meant to use it. A configured path that is not
absolute is the same refusal for the same reason: a stateless CLI or phase
invocation runs from whatever directory started it, so a relative path names a
different file each time.

`sessions.json` keeps only *selection*, never the catalog: `profilesPath`,
`defaultQuality`, and per-agent `pins`. **Inlining a catalog into
`sessions.json` is rejected** — an `agentProfiles`/`providers` catalog key
there is a validation error, so there is exactly one place to look for a
model name.

The `agentRuntime` block is validated closed, one key at a time as the slice
that reads it lands: B2 (#905) accepts `defaultQuality`, and `profilesPath` and
`pins` are refused as unrecognized settings until their slice arrives, rather
than accepted and silently ignored. An operator who writes a setting learns
immediately whether this build honors it.

Rationale for the split, and for `sessions.json` remaining the *selection*
surface: session config is reviewed rarely and changes for durable
architectural reasons; the catalog changes whenever a provider ships something.
Mixing the two makes a routine model refresh a diff against a file that also
holds provider auth, assignment profiles, and lock settings.

### 9.2 Built-in defaults

The loop MUST run correctly with no catalog file present. The built-in catalog
is compiled in, covers all three providers and all four levels, and — at the
moment §14's slices land — reproduces today's resolutions for today's inputs
(§10.3). It is a *default*, not a floor: an overlay may replace any part of it.

The catalog B1 shipped (`BUILT_IN_AGENT_PROFILE_CATALOG`) reproduces today's
complexity mapping for `anthropic`, today's Codex compatibility mode and
low/medium/high effort ceiling for `openai`, and today's single default print
timeout for `google`. The write-capable cutover (issue #911) closed the
no-label divergence B1 recorded, by the data edit it predicted: the `openai`
`normal` binding targets `codex-high`, so an unlabeled run keeps resolving
today's `high` effort on the cut-over implementation lane (§10.4). It carries
two known divergences still, both of them review-class cases no lane resolves
through this catalog yet: an explicit `review:medium` maps to `normal`, which
for `anthropic` carries `high` effort where today's Claude review lane
resolves `medium`; and the same explicit `review:medium` maps to `normal` for
`openai` too, which now carries `high` effort where today's Codex review lane
resolves `medium`. One provider-level binding cannot honor both an explicit
`review:medium` and an unlabeled default that resolve to different efforts on
the same provider, so B3 resolves each with its own before/after table rather
than either slice picking one silently.

### 9.3 Reload timing

- **The requested quality is resolved once, at intake, and persisted on the
  task**, per phase class (an implementation-class value derived from
  `complexity:*` and a review-class value derived from `review:*`). This
  mirrors how the assignment is snapshotted, and for the same reason: a
  running task needs a stable, auditable basis. Relabelling an issue later does
  not change a task already in flight. B2 persists it under the task-context
  key `requestedQuality`, beside `assignment`; a task reactivated by a later
  intake pass keeps its original snapshot, exactly as it keeps its original
  assignment. A task created before the snapshot existed has none, and resolves
  from the labels intake already persisted on it rather than falling to
  `normal`.
- **A pin is read live, not snapshotted.** An explicit operator pin (§8.2 layer
  1, task context `qualityPin`) outranks the snapshot on every subsequent run
  without rewriting it, because a pin is an operator action that must take
  effect on a task already in flight — the one thing the snapshot exists to
  protect the task *from* is a config or label edit, not an operator's explicit
  decision.
- **The catalog is read at phase start**, once per phase execution, and never
  re-read mid-run. A phase that has begun never observes an edit to the file.
- **Concrete settings are therefore resolved per phase run, not snapshotted at
  intake.** This is the deliberate asymmetry of this design: quality is a
  property of the *work* and should be stable; a model name is a property of
  the *provider catalog* and must be allowed to move. Pinning concrete model
  names for the lifetime of a task would strand a long-running or requeued task
  on a model that has since been retired.
- **A pin holds a profile *name*, not a snapshot of its settings.** Pinning
  `claude-strong` (§8.1 layers 2–3) guarantees *profile identity*: every run of
  that task resolves through that one profile, unmoved by a binding change, a
  relabelling, or a change to another profile. It does **not** freeze the
  concrete values — if the operator retargets `claude-strong` itself (§9.4),
  the next run of the pinned task uses the retargeted model, exactly as an
  unpinned one would. There is no versioned or immutable pin, because one would
  reintroduce the stranding problem above one task at a time.
- **An operator who needs stable concrete settings pins a profile they do not
  edit.** The supported pattern is append-only: declare a dated profile in the
  overlay (`claude-strong-2026-09-07`), pin that, and refresh the catalog by
  adding the *next* dated profile rather than by retargeting a pinned one.
  Immutability is an operator convention over a mutable catalog, not an
  enforced property — enforcing it would make a pinned profile naming a retired
  model unfixable without re-pinning every task that names it.
- Because two runs of the same phase may legitimately resolve differently —
  including two runs of a pinned task — **every run records its own
  resolution** (§13). The record, not the catalog, is the evidence of what a
  given run used, and a pinned task whose settings moved is visible in it as
  the same `profileName` against a different `catalogDigest`.

### 9.4 Overlay semantics — partial, never a full copy

An operator MUST be able to change one binding without restating the catalog.
The file is merged over the built-in catalog with these rules:

- **Providers merge by key.** A provider absent from the file keeps its
  built-in entry entirely.
- **Profiles merge by name, field by field.** `{"claude-strong": {"model":
  "fable"}}` retargets that profile's model and keeps its built-in effort and
  budget. A profile name absent from the file keeps its built-in definition; a
  name not present in the built-in catalog is added.
- **A field set to JSON `null` is explicitly unset**, restoring "the provider
  CLI's own default applies". This is how an operator drops an explicit
  `--model` and returns a provider to compatibility mode, and it is why "absent
  from the file" cannot mean "removed".
- **Bindings replace, they do not merge.** A binding's value is one profile
  name; supplying it replaces the built-in name for that level and leaves the
  other three levels alone.
- **Capability descriptors replace per key.** Supplying `"effort": ["low",
  "medium", "high", "xhigh"]` replaces that provider's accepted effort list;
  other keys keep their built-in declaration.
- **`providerOptions` merges by key**, with `null` unsetting one option.
- **There is no deletion and no block replacement.** The file cannot remove a
  built-in provider, a built-in profile, or a level, and there is no operation
  that substitutes a whole `providers` block for the built-in one. The only
  supported way to neutralize a built-in value is the explicit `null` above,
  which unsets one field and leaves the profile in place. A consequence the
  loader and the validator can both rely on: the effective catalog always
  declares every built-in provider, and a provider missing from it is one that
  was never built in (§12.3).

The smallest valid override file is therefore a few lines:

```json
{
  "schemaVersion": 1,
  "providers": { "openai": { "qualityBindings": { "maximum": "codex-xhigh" } } }
}
```

and it is valid only if `codex-xhigh` is also declared — by the same file or by
the built-in catalog (§12.2).

## 10. Compatibility with existing labels

### 10.1 Labels are inputs to quality, not provider effort names

`complexity:*` and `review:*` remain supported and keep working. They are
**compatibility inputs mapped to a provider-neutral quality level**, and are
never again read as a literal provider effort value:

| Label | Applies to | Quality level |
| --- | --- | --- |
| `complexity:low` | implementation-class phases | `light` |
| *(no complexity label)* | implementation-class phases | `normal` |
| `complexity:high` | implementation-class phases | `strong` |
| `complexity:xhigh` | implementation-class phases | `maximum` |
| `review:low` | review-class phases | `light` |
| `review:medium` | review-class phases | `normal` |
| `review:high` | review-class phases | `strong` |
| *(no review label)* | review-class phases | derived from the complexity label if present, else `normal` |

When several labels of a class are present, the strongest wins, preserving
today's rule. `quality:<level>` is the forward-looking canonical namespace and
outranks both compatibility families (§8.2); it needs no per-phase-class
variant, because the label states the level directly.

`review:xhigh` remains unrecognized as a *label*. Its intent now has a
supported spelling — `quality:maximum` — whose answer for a given provider is
whatever that provider's `maximum` binding declares (§6.3).

### 10.2 Phase classes

Two classes exist, and they exist only to pick which requested quality a phase
reads — not to select a catalog entry (§4.3):

- **implementation-class** — implementation, fix-existing-PR, conflict
  resolution, research, refinement, and the dispute sub-turns that produce
  work.
- **review-class** — review and the dispute sub-turns that judge work.

Slice B2 (#905) fixes the exact assignment, in
`phaseClassForPhase`/`phaseClassForDisputeTurn`:

| Phase or sub-turn | Class |
| --- | --- |
| `implementation` (both modes), `conflict_resolution` | implementation-class |
| `research`, `refinement`, `planner` | implementation-class |
| `content_research`, `content_draft` | implementation-class |
| `review`, `content_review` | review-class |
| dispute `implementer_fix` | implementation-class |
| dispute `reviewer_reconsideration`, `re_review`, arbitration | review-class |
| dispute `evidence_collection` | per party — implementer side is implementation-class, reviewer side is review-class |
| dispute `human_handoff`, `no_turn`, `unresolvable` | none — no agent runs, so no quality is resolved |

The phase map is total: adding a phase without assigning it a class is a
compile error, because a phase that silently reads the implementation-class
request is exactly the unowned decision this contract exists to remove.

### 10.3 Behavior preservation at cutover

The built-in catalog's job at cutover is to make the change invisible: for any
task, the same labels and the same environment must resolve to the same
concrete model, effort, and budget as before, on every lane. Where today's
lanes differ from each other for the same nominal tier — a Claude review's
`normal` resolving to `high` effort, a Codex review's `normal` resolving to
`medium` for an explicit `review:medium` label — the cutover slice records the
difference as a deliberate, documented change with its own before/after table,
or preserves it. It does not resolve such a difference by silently picking one.
Effort escalation on the penultimate fix cycle (`escalatedEffort`) is, since
the write-capable cutover, a per-run quality floor of `strong` (§8.2, slice
B2's `REVIEW_LOOP_ESCALATION_QUALITY`): it raises the whole resolved profile
and never lowers a request that already meets the floor. That it can now raise
model and budget alongside effort is a deliberate, documented cutover change —
see §10.4.

### 10.4 The write-capable cutover (issue #911)

`implementation` (Claude, Codex, Gemini/Antigravity; both orchestration modes
including fix/requeue) and `conflict_resolution` (Claude) resolve through the
boundary. With no `agent-profiles.json` present, the built-in catalog
reproduces the pre-cutover model, effort, and budget for every labeled and
unlabeled run — including the unlabeled Codex case, whose built-in `normal`
binding now targets `codex-high` so the no-label divergence B1 recorded is
closed by the data edit it predicted. The deliberate differences, before →
after:

| Case | Before | After |
| --- | --- | --- |
| Review-loop escalation (`escalatedEffort` handoff) | raised effort only, to `high`, keeping model and budget | a quality floor of `strong`: the run resolves that binding's whole profile (for `anthropic`, opus/high/$10) |
| `session.claude.complexityProfiles` | overrode the implementation/conflict tier map | no longer read by the cut-over lanes; express the override as an `agent-profiles.json` overlay |
| `session.codex.model` | spliced `--model` into `codex exec` | no longer read by the implementation lane; set `model` on an `openai` profile or break the glass with `CODEX_MODEL` |
| `CODEX_EFFORT` outside the declared list (e.g. `xhigh`) | silently clamped to `high` | refused (`invalid-override`, §12.3) |
| Codex context-mode `--profile` | spliced after `exec`, where a global option fails CLI argument parsing | spliced before the subcommand, per the §7.3 ordering rule |
| Antigravity print timeout | none passed; `agy`'s own five-minute default governed | every built-in `google` profile carries `printTimeout: 15m`, so the lane passes `--print-timeout 15m` |
| `ANTIGRAVITY_BIN` set but empty | spawned the empty string | refused (`invalid-override`) |
| `CLAUDE_EFFORT` / `CLAUDE_MAX_BUDGET_USD` malformed | passed through to the CLI | refused against the capability descriptor (`invalid-override`) |

Everything else is preserved: worktree isolation, locks, Tool Request
handling, environment preparation, verification and its repair loop, branch
and recovery behavior, and the assignment boundary are untouched, and every
attempt now persists the §13 record (run artifact, bounded task-context trail,
and `agent.runtime.resolved` event).

## 11. Refreshing a fast-moving catalog safely

### 11.1 Versioning

`schemaVersion` is required and integral. A file whose `schemaVersion` exceeds
what the binary understands is **refused whole** (`catalog-schema-unsupported`)
— never partially parsed, never mixed with built-ins. A newer file on an older
binary is an operator mistake with a clear message, not a half-applied catalog.

`catalogVersion` is an optional free-form label (a date, a tag) recorded in the
audit record so a run can be traced to a catalog revision.

### 11.2 Closed schema

Unknown keys anywhere in the document are rejected. A typo'd
`qualityBinding` (singular) must not silently leave the built-in binding in
place while the operator believes it was overridden.

### 11.3 No auto-discovery, ever

The loop never fetches a provider's model list, never queries a CLI for
available models to populate the catalog, and never rewrites the catalog file.
Refreshing is an operator edit. This keeps the catalog a reviewable, diffable
artifact and keeps a provider's API surface out of the loop's trust boundary.

The `admin agent-profile refresh` command (§11.6) does not weaken this rule —
it is the operator edit, made explicit and reviewable: no phase run ever
triggers it, it proposes a diff and writes nothing without the operator's
explicit confirmation, and no discovered name is ever proposed as a value.
Discovery there flags what may have been *removed*; the only source of a
recommendation is the release's bundled catalog.

### 11.4 Inspect before adopting

Editing a catalog should never require running a task to find out what changed.
Issue #913 landed the read-only operator commands, in `src/cli/agent-profile.ts`:

- **`admin agent-profile list`** shows the effective catalog after overlay —
  per provider, its capability descriptors, every declared profile with each
  setting's concrete value, all four quality bindings with the profile they
  name and the levels sharing it (§6.3), and which agents resolve through that
  provider. Every value is labelled built-in or overridden, so an overlay's
  effect is visible without diffing a file against a compiled-in constant, and
  a field the overlay explicitly unset (§9.4) is named as unset rather than
  reading as never-set.
- **`admin agent-profile show <agent> [--quality <level>]`** answers what a run
  would resolve: all four levels, each with its bound profile and the concrete
  model, effort, budget, binary, and provider options the §8.1 ladder produces
  for it, every value carrying its own §13.2 source. An unset value is reported
  as an absence with its reason (§13.3), never as a model named `"default"`.
- **`admin agent-profile validate [--file <path>] [--probe]`** validates the
  effective catalog, or a candidate file before it is adopted, and then
  resolves every agent at every level under the current environment and the
  session's pins — so an `invalid-override`, an `unknown-profile` pin, or an
  `unsupported-value` is reported here instead of failing a phase mid-run.

Both of §12.1's pre-invocation gates run, in `show` as in `validate`. §8.1
resolution is only the first: a `model` capability is `free`, so a value the
provider's CLI would parse as another flag (`CLAUDE_MODEL=--help`), a budget
that is not a USD amount, or a provider option the provider has no invocation
for all resolve cleanly and are refused by the adapter. Both commands therefore
plan an invocation as well as resolve one, through the same
`planAgentInvocation` a run calls — planning spawns nothing, so the plan is
discarded and only its refusal is reported. Reporting a resolution as valid
without it would approve exactly the configurations the next run rejects.

Three properties are load-bearing. The commands re-derive nothing: they run the
same catalog gate, the same §8.1 resolution engine, the same adapter gate, and
the same fail-closed provider registry a phase run does, so what they print is
what a run would resolve rather than a second implementation that can drift.
They address a catalog and a session, never one task — a task's persisted quality snapshot and
its task-level pins (§8.1 layer 2, §8.2 layer 1) are out of scope. And
capability discovery is never a verdict: `--probe` reports each provider's
version probe as `available`, `unavailable`, or `indeterminate` in a section of
its own, a CLI that is missing or unprobeable never makes a profile invalid, and
no discovered value feeds the catalog (§11.3).

The per-provider, per-level, per-field **diff** of a candidate against the
currently effective catalog remains outstanding; today the comparison is made by
running `list` against each. The overlay-versus-recommendation diff is a
different question with a landed answer: `refresh`'s preview (§11.6).

### 11.5 A refresh never disturbs work in flight

Editing the catalog cannot change a running phase (§9.3), cannot change any
task's persisted requested quality, and cannot change any already-recorded
resolution. The next phase run picks up the new catalog, and its own record
says so.

### 11.6 The refresh command (issue #914)

`admin agent-profile refresh` compares the configured overlay against this
release's **recommended catalog** — the compiled-in built-in (§9.2), which is
what "recommended" means here — and against what the installed provider CLIs
report, then proposes updates as a diff. The default invocation is
non-mutating; applying requires the admin CLI's established explicit
confirmation (`--yes`). Landed in `src/cli/agent-profile.ts` with the pure
comparison in `src/core/agent-profile-refresh.ts`, pinned by
`test/agent-profile-refresh.test.js` and
`test/admin-agent-profile-refresh.test.js`.

Where the facts come from, per provider, with the source reported either way:

- **Installed CLI versions** — each adapter's declared version probe (§7.1),
  reported with the same available/unavailable/indeterminate vocabulary as
  `validate --probe`, and exactly as informational: never a verdict on a
  profile.
- **Model inventories** — a provider's bounded, non-interactive listing where
  one exists (today only the Antigravity CLI's `models` subcommand, §7.4,
  under its own deadline and interpreter), and the bundled recommended
  catalog everywhere else — including when a live listing is unavailable,
  unreadable, or skipped with `--offline`. The applied record names the
  aggregate source: `live`, `bundled`, or `mixed`. A listing is taken **per
  resolved executable**: when profiles resolve to different binaries, each
  binary is queried separately and every profile is compared only against
  the listing of the binary that would run it, never against another
  executable's inventory; a profile whose own executable did not list falls
  back to the bundled comparison. A listing the interpreter kept only up to
  its bound is carried as **truncated**: it proves every carried name present
  but proves nothing absent, so no `removed-model` finding rests on it —
  neither from the truncated prefix nor from the bundled fallback, since the
  CLI may well list the configured model past the bound — and the inventory
  reason reports the truncation. An executable is resolved for **every
  profile the effective catalog declares**, whether or not a quality binding
  references it: a profile reachable only through a pin is probed and judged
  exactly like a bound one, never degraded to the bundled fallback while the
  binary that would run it answers.
- **Effort tiers** — no provider offers a live listing, so efforts are always
  compared against the release's capability descriptors.

What it detects; every finding names the document path it is about:

- **`removed-model`** — a configured model the current inventory does not
  contain: under a live listing (an exhaustive one — a truncated listing
  derives none), any model the effective catalog resolves; under the bundled
  fallback, an overlay-supplied model that is not among the release's
  recommended models. Advisory — the operator verifies and edits.
- **`unsupported-effort`** — an effort value, or a widened effort descriptor,
  the release does not declare. Advisory, because a wider descriptor may be a
  deliberate declaration about a newer installed CLI (§6.2).
- **`redundant-override`** — an overlay value identical to the release
  recommendation. Proposed for removal: dropping it changes no resolved
  setting today and lets the next release's recommendation flow through —
  which is how a newer recommended profile is adopted without this tool ever
  writing a model name.
- **`stale-override`** — an overlay value shadowing a *different*
  recommendation. Preserved and reported, so a newer recommendation is
  visible without being imposed.
- **`operator-addition`** — a provider or profile the release does not
  declare. Preserved unchanged.

What `--yes` may write is exactly the **tool-managed set**, and nothing else:
the removal of redundant overrides (with the containers they empty pruned) and
one `refresh` provenance record. Operator-created profiles, custom bindings,
explicit `null` unsets that shadow a recommended value, and every value that
differs from the recommendation are preserved verbatim. There is deliberately
**no force/replace mode**; if one is ever wanted it is a separate design, not
a flag on this command. Three guarantees make the write safe:

- **A refresh cannot silently alter active provider settings.** The proposed
  overlay's effective catalog must produce the same digest as the current one
  (the provenance record is excluded from the digest on purpose), and the
  planner refuses its own plan otherwise. And **the newest model is never
  assumed to be the preferred cost/quality choice**: the only source of a
  recommendation is the release's bundled catalog; a live listing can flag a
  removal but can never nominate a value.
- **The previous file is backed up before it is replaced.** Applying stages
  the new document, writes the document the plan was computed from to a
  timestamped `agent-profiles.json.bak-…` beside it, re-checks the catalog
  (below), and renames the staged file into place, so the configured path
  holds either the old or the new document at every instant. The staged file
  and the backup are each created exclusively
  with owner-only permissions and then given the current catalog's exact
  permission bits — a chmod, deliberately not an open-mode the umask would
  mask, and for the backup deliberately not a copy that would carry the bits
  from its first instant — so applying neither widens a `0600` catalog nor
  narrows a group-readable one, and the backup's contents are never
  readable, even briefly, by a principal the catalog did not name. Ownership
  is retained the same way: a file carrying the applying process's owner or
  default group would rebind *who* a group-scoped mode grants — for the
  backup that would hand the previous catalog's contents to a different
  group outright — so a differing uid/gid is put back on both files before
  they take the catalog's mode bits, and an apply that cannot retain them
  refuses (`catalog-ownership`) with nothing written. An extended ACL is
  retained the same way again, because mode bits and ownership do not
  describe one: the catalog's access control entries are read under the
  apply lock and re-created on both files while each is still owner-only —
  a `deny` entry, or an `allow` entry existing readers depend on, survives
  the replacement and protects the backup — and an ACL that cannot be read,
  re-created, or verified refuses the apply (`catalog-acl`) with nothing
  written. Entries the *directory* would hand to a fresh file — a macOS
  ACE carrying `file_inherit`, or a POSIX default ACL — are covered by the
  same rule: an inherited entry grants readers the catalog never named
  regardless of a file's owner-only open mode, so both files are created
  empty, their inherited entries removed and the catalog's exact ACL
  established first, and each document's bytes written only after that —
  and inherited entries that cannot be removed refuse the apply
  (`catalog-acl`) the same way. And a configured path
  that is itself a symlink is applied
  *through*: the lock, the staging and backup files, and the replacement all
  act on the resolved target, so the link survives the apply and the shared
  target — not a private regular file severed from it — holds the refreshed
  document.
- **A concurrent edit is never overwritten.** The whole check-and-replace is
  one critical section: an exclusive lock file
  (`agent-profiles.json.refresh-lock`) serializes applies, so a second
  refresh arriving mid-apply refuses (`refresh-conflict`) rather than
  queueing, and the staging and backup files are allocated under the lock and
  created exclusively. Under that lock — after every staging and backup
  step, immediately before the replacement, with no write of the transaction
  after it — the apply re-reads the file and refuses
  (`refresh-conflict`) if it changed in between — nothing is written, the
  newer file stays, and re-running plans against it. The re-read is
  deliberately the last step: taken any earlier — before the backup work in
  particular — it would let an edit landing while the backup was prepared be
  verified against stale bytes and then silently overwritten, absent from
  the catalog and the backup alike. An interrupted apply can
  leave the lock file behind; deleting it (after confirming no refresh is
  running) is the recovery, and the exclusive creation turns any collision
  that survives into a loud failure instead of an overwrite.

The applied file records catalog version and update source in a top-level
`refresh` block — the one addition this contract makes to §6.1's document
shape, optional, tool-written, and validated closed like everything else. It
is metadata: it names no setting, joins no resolution, and does not perturb
the catalog digest.

```json
"refresh": {
  "refreshedAt": "2026-09-11T00:00:00.000Z",
  "updateSource": "bundled",
  "recommendedCatalogVersion": "builtin-2026-09-07"
}
```

Upgrade, rollback, and offline behavior:

- **Upgrade** — after updating the loop, run `refresh` to see the new
  release's recommendations against the operator overlay; applying removes
  only what is redundant under the new recommendation and reports the rest.
- **Rollback** — restore the printed backup over the catalog path; the next
  phase run or CLI invocation reads it fresh (§9.3, §11.5). A binary older
  than the `refresh` block refuses a refreshed file whole (`catalog-invalid`,
  §11.2) rather than misreading it; restoring the backup is the answer there
  too.
- **Offline** — `--offline` skips every probe, and a probe that fails or
  times out degrades identically: both fall back to the bundled recommended
  catalog and say so, and neither can make a profile invalid (§7.1).
- **No file** — with no `agent-profiles.json` present the command reports
  that the built-in defaults apply, writes nothing, and creates nothing: a
  missing catalog stays a valid configuration.

A refresh addresses a catalog and a session, never one task (§11.4), cannot
disturb work in flight (§11.5), and an unparseable or invalid overlay is
refused with its §12.2 reason rather than repaired — `validate` names the
problem, a human fixes it.

## 12. Validation and fail-closed behavior

### 12.1 Where validation happens

Two gates, both fail-closed:

- **Load time** — schema, references, and capability conformance, when the
  catalog is read at phase start. Everything checkable without a task is
  checked here, so a bad edit fails on the next phase for every task rather
  than corrupting one.
- **Resolution time** — the requested quality, the pins, and the env overrides
  for this specific run.

### 12.2 Refusal reasons

A closed set. Adding a member is a change to this document first.

| Reason | Raised when |
| --- | --- |
| `catalog-unreadable` | a configured catalog path is missing, unreadable, or not valid JSON |
| `catalog-schema-unsupported` | `schemaVersion` is absent, non-integral, or newer than the binary supports |
| `catalog-invalid` | unknown key, wrong type, or a forbidden key (phase, agent id, credential) |
| `unknown-provider` | a resolved agent's provider has no catalog entry, or no registered runtime adapter at the B3 boundary (§7.1) |
| `unbound-quality` | a provider does not bind all four quality levels |
| `unknown-profile` | a binding or a pin names a profile not declared for that provider |
| `unsupported-setting` | a profile sets a key the provider's capability descriptor does not declare |
| `unsupported-value` | an enumerated setting carries a value outside the declared list |
| `invalid-quality-request` | a quality request is unreadable or self-contradictory: a `quality:` label outside the vocabulary, two of them naming different levels, a malformed or empty pin, a malformed `defaultQuality`, or a malformed persisted snapshot |
| `invalid-override` | an env override or a pin is empty, malformed, or fails the same capability check |

### 12.3 No silent downgrade

The governing rule, stated once: **a resolved setting is never replaced by a
nearby value the provider would accept.** A refusal stops the phase with the specific
reason and hands off to a human, exactly as an unsupported assignment does.
Concretely, all of the following are refusals and none is a clamp:

- a `maximum` binding naming a profile with an effort the provider does not
  declare — refused at load, not lowered to the highest declared value;
- a `CODEX_EFFORT=xhigh` override against a provider declaring
  low/medium/high — refused, not lowered to `high`;
- a `quality:` label outside the vocabulary, or two of them naming different
  levels — refused for that work item, not resolved to the nearest level and
  not quietly defaulted to `normal`; intake refuses that one Issue rather than
  the whole scan, so one operator's typo never stops every other Issue;
- a session pin naming a profile the effective catalog does not declare — a
  typo, or a name only a previous revision of the overlay carried, since an
  overlay cannot delete a built-in profile (§9.4) — refused, not resolved
  through the quality binding instead;
- a resolved agent whose provider the effective catalog does not declare, which
  after the merge rules of §9.4 means a provider that was never built in —
  refused, not served from another provider's profiles and not given a
  settings-free default invocation.

A quality refusal withholds *admission only*: it decides that no new task is
created for that work item, and it never suppresses a guard that acts on the
task the work item already has. Concretely, an Issue relabelled into refinement
while its previous lane is still live is suspended for a human first
(docs/issue-refinement-contract.md §3.1) and only then refused, because leaving
the old lane claimable is exactly the execution the refinement marker exists to
stop — a typo must not buy an Issue a running phase it would otherwise lose.
The same order applies to the predecessor gate: a refinement row whose
predecessors are not ready is parked before the refusal is reported
(docs/issue-refinement-contract.md §4), so a malformed label can never make an
ineligible task claimable again. Only the guards that make a task *less*
claimable run ahead of a refusal; releasing a hold waits for a poll whose
quality request resolves.

The one permitted "same answer for two requests" is a *declared* binding
(§6.3), which is configuration, not substitution.

## 13. Observability and audit metadata

Implemented by issue #910 as `src/core/agent-runtime-audit.ts` (slice B4's
audit record), pinned by `test/agent-runtime-audit.test.js`. The module builds
the record, the bounded task-context trail, the task-event payload, the
run-artifact bytes, and the public line; it performs no side effect of its own,
and no lane produces a record until a lane cuts over (§14.1 B3).

### 13.1 Both halves are recorded

The requested quality and the concrete resolved settings are recorded
together. Neither alone is sufficient: quality alone hides what actually ran;
settings alone hide what was asked for, which is what makes a declared shared
binding (§6.3) auditable rather than suspicious.

**One record shape, every provider.** The record is built by a single
provider-neutral projection from a resolution, so a run on any provider emits
the same fields; what differs between providers is which *values* are absent,
never which fields exist. This is what makes two runs on two providers
comparable at all, and it is why the record is not the per-provider operator
summary an adapter may also expose.

### 13.2 The record

```jsonc
{
  "recordVersion": 1,                   // the record shape's own version
  "agentId": "codex",
  "provider": "openai",
  "phase": "review",
  "phaseClass": "review-class",         // derived from the phase via §10.2
  "lane": "review",

  "requestedQuality": "maximum",        // what the TASK asked for
  "requestedQualitySource": "compat-label", // task-pin | label | compat-label | session-config | default
  "requestedQualityLabel": "complexity:xhigh", // present when the source was a label

  "effectiveQuality": "maximum",        // what this RUN resolved
  "effectiveQualitySource": "compat-label", // the above, plus escalation
  "escalationFloor": "strong",          // present when a floor was offered

  "profileName": "codex-high",
  "profileSource": "catalog-builtin",   // task-pin | session-config | catalog-overlay | catalog-builtin
  "sharedWithQualityLevels": ["normal", "strong"], // the OTHER levels bound to this profile

  "catalogSchemaVersion": 1,
  "catalogVersion": "builtin-2026-09-07",
  "catalogSource": "builtin",           // builtin | file
  "catalogDigest": "sha256:…",          // of the effective catalog after overlay

  // model omitted entirely = absence; never null, never the string "default"
  "modelSource": "cli-default",
  "effort": "high",
  "effortSource": "catalog-builtin",
  // budget omitted entirely: this provider declares no budget setting
  "budgetSource": "not-applicable",
  "binary": "codex",
  "binarySource": "default",
  "providerOptions": {},
  "providerOptionSources": {},

  "cliVersion": "0.9.3",                // only when discovery was determinate
  "cliStatus": "available",             // available | unavailable | indeterminate

  "resolvedAt": "2026-09-10T04:05:06.000Z",
  "resolutionDurationMs": 3
}
```

- **Every concrete value carries its own source**, so a `CLAUDE_EFFORT` in the
  operator's environment is distinguishable from a catalog binding at a glance.
- **`catalogDigest` covers the effective catalog after overlay**, so two runs
  that resolved differently can be attributed to a catalog edit rather than to
  a bug; `catalogSchemaVersion` is the schema the document was read under, not
  the operator's revision label.
- **`sharedWithQualityLevels`** is what makes §6.3 auditable: a `maximum`
  request answered by a profile that `normal` and `strong` also bind says so in
  the record. It lists the
  levels *other than* this run's, whichever §8.1 layer chose the profile, so
  the fact does not change shape between a binding and a pin.
- **`escalation` is a run's source, never a task's.** A run raised by a
  review-loop floor records `effectiveQualitySource: "escalation"` while the
  task keeps the request it was admitted with — which stays visible as
  `requestedQuality`/`requestedQualitySource` — so the record separates "the
  labels asked for this" from "the loop pushed this run up" (§8.2, §10.3).
- **`budgetApplied` is present exactly when a budget resolved and the
  invocation plan was supplied**, so a lane with no budget flag records
  `not-applicable` (§7 rule 1) rather than leaving a reader to assume the cap
  was in force.
- **A discovered CLI version is the one recorded value that came from a CLI's
  stdout**, so it is bounded, redacted, and stripped of control characters
  before it is recorded; an `indeterminate` probe contributes a status and
  never a version (§7.1).
- **A recorded value over the bound is truncated visibly, never silently.** Any
  single recorded string is bounded, because the task-context trail is
  replicated into every backup and restore — but a bound is a presentation
  limit, not a licence to rewrite what ran. A value over it is recorded as its
  prefix plus the original length and a SHA-256 of the whole value, so two
  binaries that differ only past the bound keep two different records, the
  record says out loud that it is truncated, and a candidate path can still be
  confirmed or refuted by hashing.
- **The record has no field for a prompt, an environment, or a credential.**
  An operator override contributes the *source* `env`, never the variable's
  value, and the invocation's argv, stdin, and environment additions do not
  reach the record at all.

### 13.3 Absence is absence

An unset model is recorded as an absence, never as a model name. The existing
`UNRESOLVED_MODEL_TOKENS` treatment (`cli-default`, `n/a`, `unknown`,
`default`, `unset`) stays authoritative: these strings are not model names, and
no consumer may treat one as proof that two runs used different models. In the
record an absence is a *missing field* carrying its source, so a serialized
record has nothing a reader could mistake for a value.

### 13.4 Surfaces

- **Run artifacts** under `.n8n-artifacts/runs/<id>/`, alongside the resolved
  assignment, as `agent-runtime.json`.
- **Task events and task context.** One `agent.runtime.resolved` event carries
  the whole record; the task keeps a bounded trail of the most recent records,
  which trims oldest-first and counts what it trimmed rather than presenting a
  shortened history as a complete one. Appending treats already-persisted
  entries as opaque, so a record written by another build of this loop can
  neither block a run nor be reinterpreted as this version's facts.
- **The public status comment**, extended to name the quality alongside the
  agent — "agent claude (anthropic) — quality: strong requested by label
  complexity:high — profile claude-strong — model opus, effort high, budget
  $10" — so a reviewer sees both halves without reading internal state. That
  line is bounded, single-line, and sanitized: concrete settings are quoted
  from the resolution and never translated from the quality level, so a
  `maximum` request answered by a provider's high-only profile reads as
  `maximum` requested with `high` effort and the shared binding named, never as
  an `xhigh` run the provider never performed. The shared-binding sentence is
  the catalog's claim, so the line only makes it about a profile the catalog
  chose: a pinned profile is named as pinned and the levels the provider binds
  to it are listed without folding the run's own level in, so pinning
  `claude-light` for a `normal` run never reads as a binding of `normal` to
  `claude-light` that the catalog does not declare. The resolved binary is omitted
  from the public line, because a break-glass variable may legitimately point
  it at an absolute local path; full internal metadata stays in the events and
  the artifact.
- **Operator commands** to show the effective catalog, show what one agent
  resolves at each quality level, and validate the effective catalog or a
  candidate file (§11.4). They are read-only and print no credential: a
  break-glass variable contributes its resolved *setting* and the source `env`,
  never any other variable and never a value from outside the four settings.

### 13.5 Feeding arbitration, without weakening it

Better metadata makes #839's same-provider/same-model rules sharper: an
arbiter candidate can compare *declared profile names and models* rather than
inferring from lane defaults. None of those rules relax. In particular, an
absent model remains **not** proof that two parties differ (§13.3), a
same-provider candidate still requires the explicit opt-in plus a provably
different model, and a shared binding (§6.3) makes two lanes' sameness
*visible* — which, if anything, causes more same-model refusals, not fewer.

## 14. Follow-up implementation boundaries

### 14.1 Slices

Each slice is independently landable, and each carries its own doc pin.

| Slice | Scope | Boundary |
| --- | --- | --- |
| B1 | Catalog schema, loader, overlay merge, validator, built-in catalog | Pure core module. No handler reads it yet; behavior unchanged. **Landed in issue #904** as `src/core/agent-profile-catalog.ts`. |
| B2 | Quality levels, compatibility mapping, per-phase-class resolution, persistence on the task | Pure resolution plus one intake write. Still not consumed by any lane. **Landed in issue #905** as `src/core/agent-quality.ts`. |
| B3 | The adapter interface and the three provider adapters; lanes switch over one at a time | The only slice that changes what runs. Each lane's cutover carries its own before/after table (§10.3). **The adapter contract and the provider registry landed in issue #906** as `src/core/agent-runtime-adapter.ts` (§7.1); **the Claude adapter landed in issue #907** as `src/core/claude-runtime-adapter.ts` (§7.2); **the Codex adapter landed in issue #908** as `src/core/codex-runtime-adapter.ts` (§7.3); **the Gemini/Antigravity adapter landed in issue #909** as `src/core/antigravity-runtime-adapter.ts` (§7.4); **the write-capable lanes (`implementation`, `conflict_resolution`) switched over in issue #911** with the §10.4 before/after table. The read-side lanes are not cut over yet, so their behavior is unchanged. |
| B4 | Audit record, artifacts, status comment, operator commands | Observability only. **The audit record landed in issue #910** as `src/core/agent-runtime-audit.ts` (§13): one provider-neutral record shape, the bounded task-context trail, the task-event payload, the run-artifact bytes, and the sanitized public line. It is a pure projection that performs no side effect, so until a lane cuts over nothing produces a record. **The operator commands of §11.4 landed in issue #913** as `src/cli/agent-profile.ts` — `admin agent-profile list`, `show`, and `validate`, read-only and resolving through the same gates a run does; only their candidate-versus-effective diff remains. **The §11.6 refresh command landed in issue #914** — `admin agent-profile refresh`, preview by default and `--yes` to apply, with the pure comparison in `src/core/agent-profile-refresh.ts`: tool-managed values only, backup before write, and the settings-preservation digest invariant. |
| B5 | Delete the superseded per-lane default chains inventoried in §1.2 | Removal only; nothing new resolves. |

Ordering is B1 → B2 → B3 → B4 → B5. B4 may land alongside B3 for the lanes
already cut over; B5 must not begin before every lane in §1.2 is cut over,
because a partially deleted chain is exactly the silent-default failure this
contract exists to remove.

### 14.2 Explicitly out of scope for every slice

Phase-specific model profiles; identical effort names across providers;
credential handling; provider capability *discovery*; any change to assignment
profiles, grant tiers, or arbitration rules.

### 14.3 What may and may not become a TypeScript union

**May** — the closed, provider-neutral vocabularies this contract owns:
`QualityLevel` (four members), the phase classes, the setting *keys*, the
source values in the audit record, and the refusal reasons in §12.2.

**Must not** — anything tracking a provider's catalog: model names, effort
values, budget amounts, profile names, and per-provider capability lists.
These are `string` in the types and validated against the catalog's capability
descriptors at load. `ReviewStrength`'s low/medium/high union and the
`ComplexityTier` model constants are the concrete cases this rule retires: they
encoded a provider's 2026 capability surface into the type system, which is why
a CLI gaining a tier currently needs a source change.

A follow-up implementation that adds a model name to a union has violated this
contract, whatever else it got right.

## 15. Open questions

Recorded so a follow-up resolves them deliberately rather than by accident:

1. **Should `quality:*` labels be written back** by the loop when a
   compatibility label was used, or do the two vocabularies coexist
   indefinitely? Coexistence is assumed until decided.
2. **Whether a fifth level is ever needed** below `light` for trivial
   mechanical work. Assumed no: `light` plus an operator-defined profile
   covers it without widening a vocabulary that must stay stable.
3. **Whether the catalog should be per-session** rather than per-installation
   when one host runs several sessions. Assumed per-installation with a
   session-level path override (§9.1), which covers the case without a second
   mechanism.

## 16. Relationship to other docs

- [assignment-profiles.md](assignment-profiles.md) — selects the *agent*; this
  contract selects that agent's *settings*. Its "Where Cost Settings Fit"
  section describes the shipped mechanism this document targets for
  replacement, and its #694 source-of-truth rules are unchanged (§4.2).
- [phase-contracts.md](phase-contracts.md) — "Complexity Labels", "Review
  Strength Labels", and "Codex Model Selection" document the shipped label and
  env behavior; §10 here maps those labels onto quality levels without
  changing what they mean today.
- [provider-architecture.md](provider-architecture.md) — the work-item /
  repo-host provider split and the rule that `sessions.json` holds no secrets.
  A runtime profile is the agent-runtime analogue of a provider config: trusted
  data selecting *how the work runs*, holding no credential.
- [review-dispute-contract.md](review-dispute-contract.md) — §8.2/§8.3 arbiter
  eligibility, which consumes the metadata this contract standardizes (§13.5).
- [feature-status.md](feature-status.md#provider-centric-agent-runtime-profiles)
  — the repository-wide availability matrix; this design is `foundation-only`
  there now that B1's catalog exists in `src/`, and stays there until §14's
  remaining slices wire a lane to it.

This document's structural pin is
`test/docs-agent-runtime-profiles-contract.test.js`. Slice B1's behavioral pin
is `test/agent-profile-catalog.test.js`. Slice B2's behavioral pin is
`test/agent-quality.test.js`. Slice B3's boundary pin is
`test/agent-runtime-adapter.test.js`, its Claude adapter's pin is
`test/claude-runtime-adapter.test.js`, its Codex adapter's pin is
`test/codex-runtime-adapter.test.js`, and its Gemini/Antigravity adapter's pin
is `test/antigravity-runtime-adapter.test.js`. Slice B4's audit record is pinned
by `test/agent-runtime-audit.test.js` and its §11.4 operator commands by
`test/admin-agent-profile.test.js`. The §11.6 refresh command is pinned by
`test/agent-profile-refresh.test.js` (the planner) and
`test/admin-agent-profile-refresh.test.js` (the command).
