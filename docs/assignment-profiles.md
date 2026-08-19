# Agent Assignment Profiles

This document specifies **configurable agent assignment profiles**: a way to
decide which agent CLI handles each role (implementation, review, conflict
resolution, research) for each kind of work, without hard-coding a single
implementation/review pairing such as "Claude implements, Codex reviews".

**Status: implemented.** The mechanism described below — trusted-config
profiles, flow resolution, intake-time persistence onto the task, and the
`agent:*` label boundary — is live (`src/core/assignment.ts`, `#259`; Codex
implementation support, `#260`; Claude review support, `#261`; the
`admin task-assign` reassignment command, `#262`; the `labelsToPhase` boundary
narrowing, `#292`). A session that configures no `assignmentProfiles` /
`flowRules` still derives the `code` flow's profile from that session's
configured `defaults` (`builtInCodeProfile()`, `src/core/assignment.ts`) —
which for an unmodified session is the historical pairing (Claude implements,
Codex reviews, Claude resolves conflicts), but for a session with customized
`defaults.implementationAgent` / `defaults.reviewAgent` (e.g. Codex
implementation, Claude review) is that customized pairing instead — see
[Default Behavior](#default-behavior). This document is now the durable contract for
that implemented behavior, not a forward-looking design; issue `#694` closed
the remaining source-of-truth ambiguity between labels and profiles (see
[Assignment vs. `agent:*` Labels](#assignment-vs-agent-labels-source-of-truth)
and [Decisions](#decisions-issue-694) below).

## Why Assignment Must Be Configurable

Before this mechanism landed, the role-to-agent mapping was fixed in two
places:

- `labelsToPhase` (`src/core/github-intake.ts`) hard-coded
  `agent:claude` → implementation and `agent:codex` → review.
- the implementation handler (`src/handlers/implementation.ts`) hard-coded
  `agentId: "claude"` / `cmd: "claude"`, and the review handler shelled out to
  Codex only.

`SessionDefaults` (`src/core/session.ts`) already carried
`implementationAgent` / `reviewAgent` / `researchAgent`, and the task context
already persisted per-task agent assignments (`AiTask.implementationAgent`,
`reviewAgent`, `researchAgent` in `src/core/task.ts`). But there was no way to
say "for documentation issues use a different pairing", and no first-class way
to fall back to a single agent when only one CLI is installed or when a
provider is having an outage.

That fixed model was too rigid because:

- some operators have only one agent CLI installed or authenticated;
- provider outages can make the default implementation or review agent
  unavailable, and the loop should be able to fail over to a working agent;
- documentation work and code work may deserve different pairings (e.g. a
  cheaper model for docs);
- future agents should be added by editing trusted config, not by multiplying
  GitHub labels (`agent:*`) or forking lane logic.

## Concepts

### Flow

A **flow** is a named kind of work — `code`, `docs`, etc. The flow determines
*which assignment profile applies* to a task. A flow is resolved once, at
intake, from **trusted inputs only** (see [Security Boundaries](#security-boundaries)).

### Assignment Profile

An **assignment profile** maps each phase role to a concrete agent:

| Role                  | Phase (`TaskPhase`)    | Meaning                                  |
| --------------------- | ---------------------- | ---------------------------------------- |
| `implementation`      | `implementation`       | Agent that writes the change             |
| `review`              | `review`               | Agent that reviews the resulting PR      |
| `conflict_resolution` | `conflict_resolution`  | Agent that resolves merge conflicts      |
| `research`            | `research` / `planner` | Agent that performs research/planning    |
| `refinement`          | `refinement`           | Refiner (AI A) for chain-aware Issue refinement |
| `refinement_critic`   | `refinement`           | Critic (AI B) that independently critiques the refiner |

`implementation` and `review` are required in every profile. The others are
optional and fall back to the session defaults (`SessionDefaults`) and then to
the existing hard-coded behavior when absent, so partial profiles are valid.

The two refinement roles (issue #866/#867,
[issue-refinement-contract.md](issue-refinement-contract.md) §14) are the one
exception to that fallback chain: `SessionDefaults` names no refiner and no
critic, so an unconfigured role stays **absent**. Their only fallback is the
session-level `issueRefinement.agents.refiner` / `.critic`, which the flow
profile overrides whenever it names one. Absent means absent: the refinement
task records `refinerAgent: null` / `criticAgent: null` and the lane refuses to
start, rather than substituting the implementation agent — which for the critic
would quietly defeat the independence requirement of §7.3. The refinement roles
are never expressed as `agent:*` labels; the `agent:*` label on a
refinement-marked Issue names the intended *implementation* owner (§14).

### Flow Rules

**Flow rules** map trusted labels to a flow, with exactly one rule marked as
the default. Rules are evaluated in order; the first matching rule wins, and
the `default: true` rule is the terminal fallback.

## Configuration Shape

Assignment profiles live in **trusted session configuration**
(`sessions.json`, parsed/validated by `validateSession` in
`src/registries/json-session-registry.ts`), as two new optional fields on
`SessionConfig` (`src/core/session.ts`): `assignmentProfiles` and `flowRules`,
plus an optional `defaultFlow`.

```json
{
  "defaultFlow": "code",
  "assignmentProfiles": {
    "code": {
      "implementation": "claude",
      "review": "codex",
      "conflict_resolution": "claude"
    },
    "docs": {
      "implementation": "claude",
      "review": "codex"
    },
    "codexOnly": {
      "implementation": "codex",
      "review": "codex"
    },
    "claudeOnly": {
      "implementation": "claude",
      "review": "claude",
      "conflict_resolution": "claude"
    }
  },
  "flowRules": [
    { "flow": "docs", "labels": ["documentation"] },
    { "flow": "code", "default": true }
  ]
}
```

- `assignmentProfiles` — a map of flow name → profile. Each profile's agent
  values are drawn from the recognized `AgentId` set (`claude`, `codex`,
  `gemini`; `src/core/task.ts`).
- `flowRules` — an ordered list. Each rule is either `{ "flow": <name>,
  "labels": [<trusted-label>, …] }` (matches when **all** listed labels are
  present) or `{ "flow": <name>, "default": true }`. Exactly one rule must be
  the default; the validator rejects a config with zero or multiple defaults,
  or a `flow` that has no entry in `assignmentProfiles` — **except** the
  built-in `code` flow (`DEFAULT_FLOW`, `src/core/assignment.ts`), which is
  exempt and falls back to `builtInCodeProfile(session)` even with no
  `assignmentProfiles.code` entry. So `{ "flowRules": [{ "flow": "code",
  "default": true }] }` with no `assignmentProfiles` block at all is a valid
  config.
- `defaultFlow` — optional convenience that names the default flow; when
  present it must agree with the `default: true` flow rule.

A session that omits all three fields **keeps today's behavior unchanged**
(see [Default Behavior](#default-behavior)), and `ResolvedSession` keeps them
`undefined`. But supplying *any one* of the three raw fields triggers
validation (`validateAssignment` in `src/registries/json-session-registry.ts`),
which synthesizes the other two before `resolveSession()` runs: an operator
who sets only `assignmentProfiles` gets a synthesized `flowRules: [{ "flow":
"code", "default": true }]` and `defaultFlow: "code"` written onto the
validated config, and `resolveSession()` spreads all three fields whenever
`config` carries them — regardless of what the raw JSON originally set. So a
partial config (e.g. `assignmentProfiles` only) still ends up with all three
fields present and defined on the resolved session; only a config that omits
all three stays fully `undefined`. Code that needs the resolved profile must
still go through `resolveAssignment()` (`src/core/assignment.ts`) or
`agentForPhase()`, not read `assignmentProfiles` off the resolved session
directly, since `resolveAssignment()` is what applies the `builtInCodeProfile`
fallback derived from `session.defaults` when
`session.assignmentProfiles?.[flow]` is absent.

### Where Cost Settings Fit

Model / effort / budget are resolved separately, today via
`labelsToComplexity` and `labelsToReviewStrength` (`src/core/github-intake.ts`)
plus the `CLAUDE_MODEL` / `CLAUDE_EFFORT` / `CLAUDE_MAX_BUDGET_USD` environment
variables read in `src/handlers/implementation.ts`. Those are **trusted**
inputs (operator-controlled labels and the operator's environment). Assignment
profiles select the *agent*; complexity/review labels and operator env select
*model, effort, and budget*. Both are trusted; neither may be chosen from
untrusted issue text. A profile MAY in a later revision carry per-agent cost
hints, but those too live in trusted config, never in the issue body.

Codex model selection (issue #609) follows the same trusted-config-only rule
but a simpler precedence, since Codex has no label-driven model tiers: an
optional `CODEX_MODEL` env var, then an optional `session.codex.model`
session setting, then compatibility mode (no `--model` flag; the Codex CLI's
own config/default applies, recorded as `model: "cli-default"` in resolved
profile metadata). Codex effort still resolves the same way implementation
effort always has — from `labelsToComplexity`/`labelsToReviewStrength` plus
`CODEX_EFFORT` — except review's `model_reasoning_effort` flag is now always
passed explicitly (`review:medium` -> `medium`, no label -> `high`; see
`docs/phase-contracts.md`, "Codex Model Selection"). Neither the Codex model
nor its effort is ever influenced by an assignment profile — profiles
continue to select only the agent (issue #694 decision 5, below).

`complexity:xhigh` implementation work resolves to Claude Fable 5
(`--model fable`) at `--effort xhigh` (issue #857, a follow-up policy
correction to #748) — the strongest available implementation profile. Issue
#748 moved `complexity:xhigh` off Opus 5 (a distilled model; effort above
`high` degrades its implementation quality rather than improving it) onto
Fable 5, but capped it at `high` effort, leaving `xhigh` no stronger than
`complexity:high`. Since Opus 5 at `high` and Fable 5 at `high` are judged
roughly equivalent, `complexity:xhigh` now runs Fable 5 at its own `xhigh`
effort so the tier is materially stronger than `complexity:high`.
`complexity:high` and `complexity:low` are unchanged.

#### Overriding the complexity → model mapping (`session.claude`)

The built-in complexity-label mapping is a config concern, not a permanent
hard-coded assumption. A session may override any tier's model, effort, or
budget via `session.claude.complexityProfiles` so a future Claude model
rename doesn't require a source change:

```json
{
  "claude": {
    "complexityProfiles": {
      "xhigh": { "model": "claude-fable-5" }
    }
  }
}
```

Any field omitted for a tier (`low` / `default` / `high` / `xhigh`) falls back
to that tier's built-in default. `CLAUDE_MODEL` / `CLAUDE_EFFORT` /
`CLAUDE_MAX_BUDGET_USD` env vars still take precedence over both the built-in
mapping and this session override — the precedence order is: **env var >
session `claude.complexityProfiles` override > built-in default**.

#### Preflight: confirming Fable 5 is available

Before relying on `complexity:xhigh`, confirm the installed Claude CLI
recognizes the `fable` model alias and accepts `--effort xhigh` for the
authenticated account:

```sh
claude --model fable --effort xhigh -p "respond with OK"
```

A successful run prints a short reply and exits 0. If Fable 5 is
unavailable, unauthenticated, or rejected by the CLI, implementation fails
closed with the CLI's own error message recorded on the task (no silent
fallback to Opus 5 or any other model) — resolve the CLI/account issue and
retry rather than reassigning the task to a different model.

## Default Behavior

The default must preserve current behavior exactly, for whatever
`session.defaults` a session already has configured:

- When no `flowRules` are configured, every task resolves to the `code` flow.
- When no `assignmentProfiles` are configured, the `code` profile is derived
  from the session's defaults by `builtInCodeProfile()`
  (`src/core/assignment.ts`): `{ implementation:
  defaults.implementationAgent, review: defaults.reviewAgent,
  conflict_resolution: defaults.implementationAgent }` (plus `research:
  defaults.researchAgent` when set). It is **not** a fixed Claude/Codex
  profile — it tracks whatever `defaults.implementationAgent` /
  `defaults.reviewAgent` the session has.
- For an **unmodified** session — the historical
  `defaults.implementationAgent = "claude"` / `defaults.reviewAgent =
  "codex"` — this derives the historical pairing: Claude implements, Codex
  reviews, Claude resolves conflicts, matching the hard-coded handlers this
  mechanism replaced.
- For a session that has **customized** `defaults.implementationAgent` and/or
  `defaults.reviewAgent` (e.g. Codex implementation, Claude review) before
  configuring any `assignmentProfiles`, the built-in `code` profile derives
  that customized pairing instead — there is no separate "default profile"
  independent of `session.defaults`.

Existing `sessions.json` files therefore behave identically with no edits: the
built-in `code` profile is always a function of whatever `session.defaults`
that file already sets.

## Worked Examples

### Code (default)

```json
{ "code": { "implementation": "claude", "review": "codex", "conflict_resolution": "claude" } }
```

Claude writes the change, Codex reviews it, Claude resolves conflicts. This is
the preserved default.

### Docs

```json
{ "docs": { "implementation": "claude", "review": "codex" } }
```

Selected for issues carrying the trusted `documentation` label (per the
`flowRules` above). Documentation work can use a different pairing — here it
omits `conflict_resolution`, so that role falls back to the session default.
An operator could instead point docs implementation/review at a cheaper agent.

### Codex-only (Claude outage / Codex-only operator)

```json
{ "codexOnly": { "implementation": "codex", "review": "codex" } }
```

Implementation and review run on Codex. `conflict_resolution` is deliberately
omitted: only Claude has a conflict-resolution handler
(`CONFLICT_RESOLUTION_SUPPORTED_AGENTS`, `src/core/assignment.ts`), so an
explicit `conflict_resolution: "codex"` is rejected at intake —
`resolveAssignment()` throws rather than silently rerouting. Leaving the
field unset falls back to the session default and is clamped to Claude when
that default is itself unsupported, so conflict resolution on this profile
still runs on Claude. Useful when Claude implementation/review is unavailable
(provider outage) or the operator primarily uses the Codex CLI, but a working,
authenticated Claude CLI must remain available for conflict resolution. The
operator switches to this profile by editing trusted config (e.g. setting it
as the default flow) — not by issue text.

### Claude-only (Codex outage / Claude-only operator)

```json
{ "claudeOnly": { "implementation": "claude", "review": "claude", "conflict_resolution": "claude" } }
```

Every role runs on Claude, including review. Useful for operators who only have
the Claude CLI, or during a Codex outage. Uses the Claude review path added by
`#261` (see [Implementation History](#implementation-history)).

## Security Boundaries

The trust model is the core of this spec.

- **GitHub labels stay coarse state only.** `status:*` labels express workflow
  state. This spec does **not** add a new `agent:*` or per-profile label for
  every agent/profile combination (a stated non-goal). The existing `agent:*`
  labels remain a coarse hint consumed by `labelsToPhase`; assignment is
  resolved from the assignment profile, not by inventing new labels.
- **Flow and assignment resolve from trusted inputs only**: trusted session
  config (`assignmentProfiles`, `flowRules`) and trusted labels (the curated
  label set an operator controls on the repository).
- **Issue body and comments are untrusted.** They may describe *requirements*
  and *intent*, and an agent may read them as task input, but they MUST NOT
  directly select the agent, model, effort, budget, or any credential. A
  sentence like "use Codex with opus and a $50 budget" in an issue body has no
  effect on resolution. This prevents a contributor (or a prompt-injection
  payload inside an issue) from redirecting work to an arbitrary/expensive
  agent or escalating cost.
- **Secrets are never involved here.** Like `sessions.json` generally
  (see [provider-architecture.md](provider-architecture.md)), assignment
  profiles reference agent *identities*, never credentials. Credential
  resolution remains the auth strategy's job.

## Resolution Timing and Persistence

- **Resolved at intake** (or at an explicit reassignment). When a candidate
  issue enters the loop, the flow is resolved from trusted labels + config, the
  matching profile is looked up, and the concrete agent for each role is
  written onto the task (`AiTask.implementationAgent` / `reviewAgent` /
  `researchAgent`, plus `conflict_resolution` agent) — extending the
  assignments already persisted at intake.
- **Persisted, not re-derived per phase.** Once written, later phases read the
  agent off the task context. A subsequent edit to `sessions.json`
  (`assignmentProfiles` / `flowRules`) does **not** retroactively change an
  already-running task: the task keeps the assignment captured at intake. This
  mirrors how the dependency decision is snapshotted at intake
  (`DependencyDecision`, `src/core/github-intake.ts`) so a running task has a
  stable, auditable basis.
- **Explicit reassignment** is the only way to change a task's persisted
  assignment — a deliberate operator action (`admin task-assign`, `#262`; see
  [Implementation History](#implementation-history)), which re-resolves and
  overwrites it. It refuses `claimed`/`running` tasks, so this is how an
  operator fails a stuck task over to another agent once it has completed or
  been recovered back to a reassignable status — not while a phase is
  actively running mid-flight during an outage.

## Assignment vs. `agent:*` Labels (Source of Truth)

This boundary is the durable contract between persisted assignment and GitHub
labels (issue #292). Keep the two roles strictly separate:

- **`context.assignment` is the source of truth** for which agent owns each phase
  (`implementationAgent`, `reviewAgent`, `conflictResolutionAgent`,
  `researchAgent`). It is resolved once at intake and persisted on the task
  (`ResolvedAssignment`, `src/core/assignment.ts`); phase handlers read it via
  `agentForPhase()`.
- **`agent:*` labels are coarse intake hints and public queue hints, not the
  assignment store.** They advertise which lane an issue is queued in and, at
  *first* intake, seed the per-phase override that `resolveAssignment()` records
  into `context.assignment`. After that they are display/queue state only.

Concrete rules that follow from this boundary:

- **`labelsToPhase()` decides the phase/lane only.** It selects the phase and the
  single agent that owns *that* lane (e.g. the review agent for a
  `status:needs-review` issue). It does **not** reconstruct full assignment state
  for other phases — notably it never derives the implementation owner from the
  surrounding `agent:*` labels while routing a review. The function therefore has
  one rule per label set, with no contradictory branches for the same set.
- **The review lane-swap stays label-driven only for *who reviews*.** A genuine
  `agent:gemini` review wins over a stale `agent:codex` label, except when
  `agent:gemini` is paired with `status:research-needed` alongside a real Codex
  review (a stale research marker, not a review assignment). This preserves the
  issue #264 behavior without using labels to remember the implementation owner.
  Because `agent:gemini` is now also a valid *implementation* label, a lingering
  `agent:gemini` beside a genuine Codex/Claude review (e.g. after a failed label
  removal on a Gemini-implementation → Codex-review hand-off) is the mirror image
  of a genuine Gemini review with a stale `agent:codex`, and the two are
  indistinguishable from labels alone. `labelsToPhase()` keeps the deterministic
  `gemini > codex > claude` tie-break in that ambiguous case by design. The
  ambiguity is *bounded*, not resolved by labels: the outbox never re-adds an
  implementation `agent:*` label across the review, and any task that already
  exists keeps the reviewer recorded in `context.assignment.reviewAgent` (intake
  never re-routes an existing task), so the tie-break only ever decides a
  brand-new or manually-labelled issue.
- **Outbox label transitions must not add extra `agent:*` labels to preserve or
  reconstruct assignment.** The implementation→review queue transition removes
  the implementation-agent label and adds the review-queue labels; it does **not**
  re-add an `agent:<impl>` label to "remember" the implementation owner across
  the review (`enqueueStatusLabelEffects`, `src/core/outbox-effects.ts`).
- **`review → needs_fix` requeues restore the implementation agent from
  `context.assignment.implementationAgent`** (falling back to the task column),
  never from a lingering GitHub label.
- **No guaranteed full recovery from labels after DB/task loss.** If the task
  state is lost, the coarse `agent:*` labels are not sufficient to rebuild the
  complete assignment. A dedicated recovery mechanism would be needed; the
  `agent:*` labels must not be overloaded for that purpose.

## Decisions (Issue #694)

Issue #694 asked five questions to close the remaining source-of-truth
ambiguity. These are now settled, and this section is the durable record of
the decision (the mechanics behind each are implemented and described in the
sections linked below):

1. **Is `agent:*` an input or a display of the resolved assignment? One
   direction is read-only.** `agent:*` is an **input only once**, at first
   intake: `labelsToPhase()` reads it to pick the lane and seed
   `LabelAgentOverrides`, which `resolveAssignment()` folds into
   `context.assignment` (see [Assignment vs. `agent:*`
   Labels](#assignment-vs-agent-labels-source-of-truth)). For every task that
   already exists, `agent:*` is **display/queue state only**: intake never
   re-routes an existing task (`enqueueTask` returns `already_exists`), phase
   handlers never read labels, and the outbox is the only writer of `agent:*`
   labels after intake — it sets them to mirror `agentForPhase()`'s resolved
   agent on the next status-label transition it enqueues
   (`enqueueStatusLabelEffects`, `src/core/outbox-effects.ts`). Manually
   relabelling an existing issue's `agent:*` label has no effect on which
   agent runs it. **Exception:** `admin task-assign` (point 3 below) updates
   `context.assignment` and the per-phase agent columns directly and does
   **not** itself enqueue a label effect, so a queued/recovered task's
   `agent:*` label can lag the newly assigned agent until the next outbox
   status transition relabels the issue — the persisted assignment, not the
   label, is authoritative in the interim.
2. **Precedence between labels and profiles, including conflicts.** For the
   `implementation`, `review`, and `research` roles: a label override captured
   at first intake (`LabelAgentOverrides`) beats the flow's assignment
   profile, which beats the session default (`resolveAssignment()`,
   `src/core/assignment.ts`). `conflict_resolution` is the one exception: it
   never follows a label override, only the profile's explicit setting or the
   session's implementation-agent default, each clamped to
   `CONFLICT_RESOLUTION_SUPPORTED_AGENTS` — an explicit but unsupported
   profile setting fails closed instead of silently clamping. There is no
   label-vs-profile conflict once a task is running: only the values captured
   at intake matter, since later label edits are not re-read.
3. **The supported way for a human to temporarily override the agent for one
   task.** `admin task-assign --session-id <id> --issue-number <n>`, with
   either `--profile <name>` (switch to a named `assignmentProfiles` entry) or
   explicit `--implementation-agent` / `--review-agent` / `--research-agent`
   overrides layered on top of the current or profile-derived base. It refuses
   to touch a `claimed`/`running` task, supports `--dry-run`, and persists the
   new `ResolvedAssignment` onto `context.assignment` plus the per-phase agent
   columns in one transition (`src/cli/admin.ts`). This is the only supported
   way to change a task's assignment after intake — editing `sessions.json` or
   relabelling the issue does not.
4. **Whether assignments already persisted on existing tasks are preserved or
   re-resolved on migration.** Preserved, never re-resolved implicitly, for
   tasks that actually have a persisted `context.assignment`: it is
   authoritative for the life of the task (see [Resolution Timing and
   Persistence](#resolution-timing-and-persistence)), and editing
   `sessions.json` does not retroactively change it. Tasks created before
   assignment persistence existed (no `context.assignment`) fall back through
   `agentForPhase()`'s chain: legacy per-phase task column first (pinned, if
   populated), otherwise `session.defaults` — and that default is read live
   at handler time, so for a legacy task with no per-phase column, editing
   `session.defaults` *does* change which agent the task runs next. Only the
   persisted-assignment and populated-legacy-column cases are actually pinned
   against config changes. `admin task-assign` is the only way to move a task
   onto a new resolution explicitly (independent of this implicit fallback).
5. **Boundary with #609 (model/effort observability).** Confirmed, unchanged:
   `#694`/assignment profiles own **which agent** runs each phase; `#609` owns
   **which model/effort** that agent uses within the phase (`labelsToComplexity`,
   `labelsToReviewStrength`, `CLAUDE_MODEL`/`CLAUDE_EFFORT`/
   `CLAUDE_MAX_BUDGET_USD`, `session.claude.complexityProfiles` — see [Where
   Cost Settings Fit](#where-cost-settings-fit)). Neither reads from untrusted
   issue text; both are trusted-config/operator-env concerns layered on top of
   the agent an assignment profile already selected.

## Auditability

The resolved assignment must be observable for cost and audit purposes:

- Record the resolved agent for each phase, alongside the already-recorded
  model / effort / budget and their sources (the implementation handler already
  emits `model`, `modelSource`, `effort`, `effortSource`, `maxBudgetUsd`,
  `budgetSource`), in the run artifacts under `.n8n-artifacts/runs/<id>/`.
- Surface the agent (and, where useful, model/effort) in the public status
  comment for a phase, so reviewers can see "implemented by Codex (opus, high)"
  without reading internal state.

## Failure Mode: Fail Closed

Unsupported assignments MUST fail closed with a clear error, never silently
fall back to a different agent:

- a flow that references a profile not present in `assignmentProfiles`;
- a profile that names an agent with no installed/wired handler for that role
  (validated at config-parse time only for the recognized `AgentId` set —
  whether a specific role/agent pairing has a handler is an execution-time
  check, so a future agent addition doesn't require a config-format change);
- a profile missing a required role (`implementation` or `review`);
- more than one `default: true` flow rule, or none.

Fail-closed means: reject at config-validation time where possible
(`validateSession`), and otherwise stop the task with an explicit error and
hand off to a human (consistent with how intake fails closed on unverifiable
dependencies), rather than running an unintended agent or quietly downgrading.

## Implementation History

The spec was implemented in four follow-up issues, all landed:

1. **Config parsing & validation (`#259`).** Added `assignmentProfiles`,
   `flowRules`, and `defaultFlow` to `SessionConfig` (`src/core/session.ts`)
   and to `validateSession` (`src/registries/json-session-registry.ts`):
   validates profile/flow references, the single-default rule, recognized
   `AgentId`s, and required roles; when no `assignmentProfiles` are
   configured, derives the `code` profile from `session.defaults`
   (`builtInCodeProfile()`) rather than hard-coding Claude/Codex, so a
   session with customized `defaults.implementationAgent` /
   `defaults.reviewAgent` gets that customized pairing instead — see
   [Default Behavior](#default-behavior). Implements flow resolution (trusted labels + config)
   and persistence of the resolved assignment onto the task at intake
   (`src/core/assignment.ts`).
2. **Codex implementation support (`#260`).** Added a Codex implementation
   handler so profiles can set `implementation: "codex"` (codex-only flow)
   (`src/handlers/implementation.ts`).
3. **Claude review support (`#261`).** Added a Claude review path so profiles
   can set `review: "claude"` (claude-only flow) (`src/handlers/review.ts`);
   note the effort-tier difference (`ReviewStrength` in
   `src/core/github-intake.ts` tops out at `high` for Codex, while Claude
   supports an `xhigh` tier).
4. **Reassignment tooling (`#262`).** Added `admin task-assign` (`src/cli/admin.ts`)
   to re-resolve and overwrite a task's persisted assignment — the supported
   way to fail a task over to another agent without editing config and
   waiting for new intake. It refuses `claimed`/`running` tasks (see
   [Decisions](#decisions-issue-694) point 3), so it applies once the task
   has completed or been recovered back to a reassignable status, not while
   a phase is actively running during an outage.

`#292` then narrowed `labelsToPhase()` to the coarse lane-only role described
in [Assignment vs. `agent:*` Labels](#assignment-vs-agent-labels-source-of-truth),
and `#694` is the closing issue that settles the remaining source-of-truth
questions — see [Decisions](#decisions-issue-694) above.

## Relationship To Other Docs

- [provider-architecture.md](provider-architecture.md) — the work-item / repo-host
  provider split and the rule that `sessions.json` holds no secrets. Assignment
  profiles are the agent-role analogue: trusted config selecting *who does the
  work*, just as provider config selects *where the work lives*.
- [phase-contracts.md](phase-contracts.md) — the per-phase behavioral contract
  each assigned agent must satisfy. A profile selects the agent for a phase; the
  phase contract is unchanged regardless of which agent is assigned.
