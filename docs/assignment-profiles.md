# Agent Assignment Profiles

This document specifies **configurable agent assignment profiles**: a way to
decide which agent CLI handles each role (implementation, review, conflict
resolution, research) for each kind of work, without hard-coding a single
implementation/review pairing such as "Claude implements, Codex reviews".

It is a design specification only. **No behavior change is required to land
this document.** The current pairing remains the default; the sections below
describe the trusted-config shape, resolution rules, and security boundaries
that a follow-up implementation must satisfy, plus the follow-up issues that
implement them.

## Why Assignment Must Be Configurable

Today the role-to-agent mapping is fixed in two places:

- `labelsToPhase` (`src/core/github-intake.ts`) hard-codes
  `agent:claude` → implementation and `agent:codex` → review.
- the implementation handler (`src/handlers/implementation.ts`) hard-codes
  `agentId: "claude"` / `cmd: "claude"`, and the review handler shells out to
  Codex.

`SessionDefaults` (`src/core/session.ts`) already carries
`implementationAgent` / `reviewAgent` / `researchAgent`, and the task context
already persists per-task agent assignments (`AiTask.implementationAgent`,
`reviewAgent`, `researchAgent` in `src/core/task.ts`). But there is no way to
say "for documentation issues use a different pairing", and no first-class way
to fall back to a single agent when only one CLI is installed or when a
provider is having an outage.

That fixed model is too rigid because:

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

`implementation` and `review` are required in every profile. The others are
optional and fall back to the session defaults (`SessionDefaults`) and then to
the existing hard-coded behavior when absent, so partial profiles are valid.

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
      "review": "codex",
      "conflict_resolution": "codex"
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
  or a `flow` that has no entry in `assignmentProfiles`.
- `defaultFlow` — optional convenience that names the default flow; when
  present it must agree with the `default: true` flow rule.

A session that omits all three fields **keeps today's behavior unchanged**
(see [Default Behavior](#default-behavior)). After resolution the fields are
always present on the resolved session, populated from the built-in default
profile when not configured.

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

## Default Behavior

The default must preserve current behavior exactly:

- **code flow** uses Claude for implementation and Codex for review (and Claude
  for conflict resolution), matching `defaults.implementationAgent = "claude"`
  / `defaults.reviewAgent = "codex"` and the hard-coded handlers today.
- When no `flowRules` are configured, every task resolves to the `code` flow.
- When no `assignmentProfiles` are configured, the `code` profile is the
  built-in `{ implementation: claude, review: codex, conflict_resolution:
  claude }`.

Existing `sessions.json` files therefore behave identically with no edits.

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
{ "codexOnly": { "implementation": "codex", "review": "codex", "conflict_resolution": "codex" } }
```

Every role runs on Codex. Useful when Claude is unavailable (provider outage)
or the operator only has the Codex CLI authenticated. The operator switches to
this by editing trusted config (e.g. setting it as the default flow) — not by
issue text.

### Claude-only (Codex outage / Claude-only operator)

```json
{ "claudeOnly": { "implementation": "claude", "review": "claude", "conflict_resolution": "claude" } }
```

Every role runs on Claude, including review. Useful for operators who only have
the Claude CLI, or during a Codex outage. This requires Claude review support
(a follow-up issue, below), since review is Codex-only today.

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
- **Explicit reassignment** is the only way to change a running task's
  assignment — a deliberate operator action (the reassignment tooling
  follow-up below), which re-resolves and overwrites the persisted assignment.
  This is how an operator fails a stuck task over to another agent mid-flight
  during an outage.

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
- a profile that names an agent with no installed/wired handler (e.g. `gemini`
  for review before that handler exists, or Codex implementation before the
  Codex implementation handler lands);
- a profile missing a required role (`implementation` or `review`);
- more than one `default: true` flow rule, or none.

Fail-closed means: reject at config-validation time where possible
(`validateSession`), and otherwise stop the task with an explicit error and
hand off to a human (consistent with how intake fails closed on unverifiable
dependencies), rather than running an unintended agent or quietly downgrading.

## Follow-up Implementation Issues

Per the non-goals, this issue specifies only. The following follow-up issues
implement the spec:

1. **Config parsing & validation.** Add `assignmentProfiles`, `flowRules`, and
   `defaultFlow` to `SessionConfig` (`src/core/session.ts`) and to
   `validateSession` (`src/registries/json-session-registry.ts`): validate
   profile/flow references, the single-default rule, recognized `AgentId`s, and
   required roles; default to today's `code` = Claude/Codex profile when
   absent. Implement flow resolution (trusted labels + config) and persistence
   of the resolved assignment onto the task at intake.
2. **Codex implementation support.** Add a Codex implementation handler so
   profiles can set `implementation: "codex"` (codex-only flow). Today
   implementation is Claude-only (`src/handlers/implementation.ts`).
3. **Claude review support.** Add a Claude review path so profiles can set
   `review: "claude"` (claude-only flow). Today review is Codex-only; note the
   effort-tier difference (`ReviewStrength` in `src/core/github-intake.ts`
   tops out at `high` for Codex, while Claude supports an `xhigh` tier).
4. **Reassignment tooling.** Add an operator action (CLI/admin path under
   `src/cli/`) to re-resolve and overwrite a running task's persisted
   assignment — the supported way to fail a task over to another agent during
   an outage without editing config and waiting for new intake.

## Relationship To Other Docs

- [provider-architecture.md](provider-architecture.md) — the work-item / repo-host
  provider split and the rule that `sessions.json` holds no secrets. Assignment
  profiles are the agent-role analogue: trusted config selecting *who does the
  work*, just as provider config selects *where the work lives*.
- [phase-contracts.md](phase-contracts.md) — the per-phase behavioral contract
  each assigned agent must satisfy. A profile selects the agent for a phase; the
  phase contract is unchanged regardless of which agent is assigned.
