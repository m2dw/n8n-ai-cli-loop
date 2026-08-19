# Phase Contracts

This document defines the behavioral contract for each self-driving workflow
phase. n8n owns orchestration, TypeScript handlers own repository operations,
and AI agents only perform the work delegated to their phase.

These contracts are intentionally narrow. They make the workflow predictable
enough for n8n to route tasks without encoding each agent's judgment in the
workflow graph.

## GitHub Intake — One-Shot Dependency Gate

The intake step (`github-intake` CLI) scans open GitHub issues, maps their
labels to a task phase, and enqueues matching issues into the task store.
Two independent gates control whether an issue is enqueued:

**Label gate** — `labelsToPhase` inspects the label set and returns a phase
mapping only when a recognized label combination is present (e.g.
`agent:claude` + `status:needs-implementation`).  Issues with no matching
combination are ignored.

**Dependency gate** — Before checking labels, `parseCandidates` queries
GitHub Issue Relationships for each issue via the `DependencyChecker` adapter.
An issue is skipped for the current scan cycle when it has at least one
`blocked by` relationship whose source issue is still open.  Once all open
blockers are closed the next intake scan will pass the issue through and
enqueue it.  If the relationship check cannot be completed (GraphQL error,
network failure, unsupported field), the issue is held back — fail closed.

**Source of truth** — GitHub Issue Relationships (`blocked by`) are the
authoritative dependency signal.  Free-form issue body text is not parsed.
The dependent issue side is always checked; blocking relationships on other
issues are not traversed.

**DependencyChecker adapter seam** — The default implementation
(`GraphQLDependencyChecker` in `src/cli/github-intake.ts`) queries
`blockedBy(first: ...)` via `gh api graphql`.  If this
GraphQL field is unavailable in the target environment, replace the default
with a custom implementation and pass it to `runIntake()` as the `depChecker`
argument.

**Dependency decision snapshot** — When an issue passes the gate and is
enqueued, a `dependencyDecision` object is stored in the task context:

```json
{
  "checkedAt": "<ISO-8601 timestamp>",
  "source": "github-relationships",
  "blockedBy": [{ "issueNumber": 42, "state": "closed" }],
  "blocked": false
}
```

This snapshot records the time the check was performed, the source, all
`blocked by` entries (including closed ones), and the final gate decision.

**One-shot semantics** — Enqueue is idempotent per `(sessionId, issueNumber)`
pair.  Once an issue passes both gates and is inserted into the task store,
all future scan cycles will see `already_exists` and skip it.  The dependency
gate therefore fires at most once per session/issue pair: it is the gate that
decides whether the issue is eligible on a given scan cycle, not a recurring
check.  Resetting a completed or failed task requires a manual store operation
outside the intake path.

## Dependent Stack Creation — Dormant-First Contract

The dependency gate above only holds back an issue whose `blocked by`
relationship is **already visible at scan time**. GitHub Issue Relationships and
execution labels are configured in separate operations, and intake runs on a
schedule, so the *order* in which an operator applies them is a correctness
concern, not a cosmetic one.

**Why executable labels before relationship setup are unsafe.** `parseCandidates`
checks the dependency gate using whatever relationships GitHub reports at the
moment of the scan. If a dependent issue already carries an executable label
combination (`agent:*` + an executable `status:*`) but its `blocked by`
relationship is not yet configured, the dependency gate sees no blocker and the
label gate matches, so the issue passes both gates and is enqueued as if it were
independent. Because enqueue is one-shot and idempotent per
`(sessionId, issueNumber)` (see [One-shot semantics](#github-intake--one-shot-dependency-gate)),
a relationship added afterward has **no retroactive effect** — the dependent has
already been admitted and will run unblocked. The race is therefore **not
self-healing**: a late relationship cannot retract an issue intake has already
enqueued.

**Motivating failure mode (the #360–#365 race).** While creating the #360–#365
issue stack, execution labels were applied to dependent issues before their
`blocked by` relationships were fully configured. An intake scan observed
`agent:*` / `status:needs-implementation` while the dependency gate still saw no
blocker, so the dependents were enqueued as if they had no blocker.

**Required creation order for any issue expected to be `blocked by` another:**

1. Create the issue in a non-executable (dormant) state. Do **not** apply
   `agent:*` labels. Do **not** apply executable `status:*` labels
   (`status:needs-implementation`, `status:needs-review`,
   `status:research-needed`, `status:needs-conflict-resolution`). Prefer
   `status:backlog` or no workflow status while relationships are configured.
2. Set all `blocked by` relationships for the stack.
3. Verify the relationship graph: each dependent issue must show its intended
   open blocker(s) before any executable label is applied.
4. Add executable labels only after the relationships are configured and
   verified. Activate the root issue first (the one with no open blocker), and
   activate a single root unless there is a deliberate reason to run multiple
   independent roots.
5. Activate each dependent explicitly — intake does **not** auto-activate
   dormant issues. `parseCandidates` calls `labelsToPhase` first and skips any
   issue that lacks an executable label combination *before* it ever consults
   the dependency gate (see `src/core/github-intake.ts`). A dependent left fully
   dormant is therefore never scanned and will never enter the queue, no matter
   how many of its blockers close. To make a dependent eligible, a human must
   apply its executable (`agent:*` + executable `status:*`) labels. The safe
   time to do this is after step 3: once the `blocked by` relationship is
   visible, applying executable labels no longer races the dependency gate, so
   the dependent is admitted only when its blocker state actually permits it.

   How an already-labeled dependent then activates depends on the blocker's
   state, and it is **not** always "held until the blocker closes":

   - **Close-only (Gate 1).** For any blocker shape the resolver does not
     support for early stacking, the dependent is held until every `blocked by`
     blocker is *closed*.
   - **Stack-ready (Gate 2).** For the supported stackable shape (exactly one
     open blocker on a new-implementation dependent), the dependent may be
     enqueued **before** its blocker closes — as soon as the blocker reaches the
     success-specific stack-ready marker (`status:stack-ready` by default) with
     a usable PR.

   See [Dependency-Aware Execution Semantics](#dependency-aware-execution-semantics)
   below for the full Gate 1 / Gate 2 definitions.

**Single vs. stacked creation.** A single independent issue with no expected
`blocked by` relationship may be created with executable labels immediately —
there is no relationship to race against. The dormant-first order is required
only when a `blocked by` relationship is expected, i.e. for dependent stacks.

This is an operator contract, not an automated guard: intake does not currently
detect or correct the race. See
[idea-to-implementation.md](idea-to-implementation.md#dormant-first-creation-for-dependent-issue-stacks)
for the operator-facing walkthrough.

## Dependency-Aware Execution Semantics

The purpose of dependency-aware execution is to keep a dependent issue moving
even when its blocker has not been merged to `main` yet.  It does **not** give
this system ownership of merge ordering, retargeting, or any stacked-branch
finalization queue.  Merge ordering and dependency visibility are delegated to
GitHub Issue Relationships and human review.  This system does not enforce merge
order.  PR base does not encode dependency order.

Two concepts are kept strictly separate and must never be conflated:

- **Branch start point** — where the dependent implementation branch is *created
  from*.  When an open blocker has a usable reviewed PR, the branch is started
  from the blocker PR head so the implementation compiles against the blocker's
  changes.
- **PR target (base)** — what the dependent PR *merges into*.  This is always the
  session base branch (`main` by default), never the blocker PR head branch.

The dependent PR therefore always targets `main`, even though its branch was
created from the blocker head.  There is no later retargeting or rebase-onto-main
step owned by this system.  If the dependent PR merges before the blocker PR it
will include the blocker's changes; that is acceptable, because GitHub Issue
Relationships and human review own merge-order decisions.

**Source of truth** — GitHub Issue Relationships (`blocked by`) are the
authoritative dependency signal and the source of merge-order visibility.  Local
labels and free-form issue body text are not.  The automation chooses a suitable
implementation start point only; it does not enforce merge order and must not
invent custom merge sequencing.

Gate 1 and Gate 2 below are **alternative intake paths**, not sequential steps:
a dependent issue advances through either Gate 1 or Gate 2 depending on the
blocker's state.

### Gate 1 — Dependency Intake Gate (close-only, simple behavior)

The gate described in [GitHub Intake — One-Shot Dependency Gate](#github-intake--one-shot-dependency-gate)
above is the **close-only** implementation.  A dependent issue is held back until
every `blocked by` issue is closed.  This is safe but wastes AI execution time
when a blocker already has a reviewed PR waiting for a human merge.  It remains
the fallback for any blocker that is not yet usable as a start point (see the
Unsupported Cases table).

### Gate 2 — Implementation Start Gate (one open blocker with a usable PR)

A dependent issue may advance to implementation **before** its blocker is closed,
provided the blocker has a **usable PR**.

**Definition of usable PR**

A blocker PR is usable when all of the following are true:

- The PR is open (not closed or merged).
- The PR head branch exists in the remote repository.
- The blocker issue has reached a configured implementation-complete state,
  confirmed by the **success-specific stack-readiness marker** (`status:stack-ready`
  by default, configurable via the `stackReady` session label).  This marker is
  applied whenever a review **passes** and cleared on any review that does not
  pass.  The check is on the blocker **issue**, not on the PR itself.
  - The `status:ready-for-human` label is **not** accepted as the
    implementation-complete signal.  Although it is applied when a review passes,
    this codebase also applies it when a review is **escalated** to a human
    (loop-cap reached, ambiguous/empty review output) *without* passing.  Trusting
    it would let a dependent start from a blocker whose review actually failed, so
    the resolver keys only on the success-specific `status:stack-ready` marker.
- The PR has no reported merge conflict.
- The PR has not failed review (guaranteed by keying on the success-only
  stack-ready marker above).

If a blocker has no open PR, the dependent issue is still blocked (Gate 1).

The same stack-readiness signal is also the eligibility trigger for chain-aware
progressive Issue refinement — an optional, default-off lane that refines a
rough dependent Issue from its predecessors' stack-ready results *before* it
becomes implementable. Its marker (`status:needs-refinement`) is not an
executable status and never routes to a phase defined in this document. It does,
however, place one requirement on the phases that *are* defined here: when that
marker is on an Issue whose task already exists, the runner must refuse to start
the phase — and refuse to publish the outward effects of a run already in
flight — rather than execute against the unrefined Issue. See
[issue-refinement-contract.md](issue-refinement-contract.md) §3.1 (issue #866).

**Branch start point rule**

When the implementation start gate is satisfied the dependent implementation
branch is created from the blocker PR head branch, not from `main`, so the
implementation compiles against the blocker's changes.  Branching from `main`
while the blocker is unmerged would silently produce a stale base.

**PR target rule**

The dependent PR targets the session base branch (`main` by default).  It does
**not** target the blocker PR head branch, and there is no follow-up
rebase/retarget step.  Delivering to `main` keeps the dependent issue's mainline
delivery visible and explicit.

### Review and handoff for a dependency-started PR

A dependency-started PR is reviewed against the session base branch (`main`),
the same as any other PR.  Because the branch was created from the blocker head,
its diff against `main` may also include the blocker's changes; that is expected
and acceptable.  If the dependent PR is merged before its blocker and thereby
includes the blocker's changes, that outcome is acceptable from this system's
perspective — merge ordering is owned by GitHub Issue Relationships and human
review, not by this system.

When its review passes it follows the **normal review-success handoff**
(`status:ready-for-human`).  It is **not** held back, retargeted, or marked
unmergeable merely because it was implemented on top of a blocker — the
`dependencyBase` metadata recorded at implementation time is informational only
and must not, on its own, downgrade a passing review to `blocked` or suppress
the ready-for-human handoff.  It is held or requeued only on a genuine review or
conflict failure, exactly like any other PR.

> **Known implementation divergence** — `src/handlers/review.ts` still implements
> a legacy stacked-base safety check: when `dependencyBase` metadata is present,
> the handler queries the live PR `baseRefName` and blocks the review for a human
> when the live base targets the blocker branch or cannot be confirmed.  The
> **live-base guard must be preserved**: if the live PR base is not the session
> base (`main`), that is a real misconfiguration that must stop automated review
> handoff — removing it wholesale would reintroduce the #216/#217 omission this
> contract exists to prevent (see
> [Anti-pattern: do not deliver dependent work into the blocker branch](#anti-pattern-do-not-deliver-dependent-work-into-the-blocker-branch-216217)
> below).  The prohibited pattern is narrower: once the live `baseRefName` is
> confirmed to equal the session base, `dependencyBase` metadata alone must not
> additionally delay, downgrade, or suppress a passing review (see
> [Dependency metadata: permitted and prohibited uses](#dependency-metadata-permitted-and-prohibited-uses)
> below).  The follow-up implementation issue should therefore **retain** the
> live-base guard for PRs whose `baseRefName` does not yet equal the session base
> and **remove only** the metadata-only gate that applies after the live target is
> confirmed correct.  The corresponding tests are in `test/review-handler.test.js`
> under the `"review handler — dependency-started PR (issue #242)"` describe block;
> those tests should be updated to reflect this narrowed scope rather than removed
> entirely.

### Dependency metadata: permitted and prohibited uses

`dependencyBase` context recorded at implementation time documents where the
dependent implementation branch was started from.  It is informational only.

**Permitted uses:**

- **Branch creation context** — selecting the implementation branch start point
  (applied once during the implementation phase, not reread in later phases).
- **PR and issue explanatory context** — the PR body or a GitHub comment may
  reference the blocker issue and PR to orient human reviewers.
- **Diagnostics** — including start-point decisions in result artifacts and logs.

**Prohibited uses under this policy:**

- **Review-base selection guards** — blocking, diverting, or delaying the review
  phase because `dependencyBase` is present.
- **Ready-for-human suppression** — withholding or downgrading a passing review
  classification based on dependency metadata alone.
- **Merge-readiness proofs** — asserting that a dependent PR must wait for its
  blocker to merge before the dependent PR is considered ready.
- **Blocker merge/rebase/ancestry enforcement** — confirming or enforcing that
  the blocker was merged, or that the dependent branch was rebased onto `main`,
  as a precondition for any phase transition.

### Anti-pattern: do not deliver dependent work into the blocker branch (#216/#217)

This is the concrete merge-omission trap the rules above exist to prevent:

- #217 was blocked by #216.
- #217 was implemented and its PR (#231) was merged into the `ai/issue-216`
  branch instead of into `main`.
- GitHub then showed #217 / PR #231 as merged/closed, but the #217 changes were
  still absent from `main` (and from the normal operation tree) until #216 itself
  merged.
- Humans and agents could therefore believe #217 was done because its PR was
  merged, while the actual deliverable was still hidden inside another branch.

The automation must never merge a dependent PR into the blocker branch, and must
never close a dependent issue as a side effect of merging into the blocker
branch.  A dependent issue may be *implemented* against blocker code, but its PR
must still target `main` so its mainline delivery remains visible and explicit.

### Unsupported Cases (fall back to the close-only block)

The following dependency shapes are **not** usable as a dependency-aware start
point.  When any of these is detected the dependent issue does not start
implementation against the blocker; it is held (`blocked`) and re-evaluated on a
later intake scan, exactly as under the close-only Gate 1.  The automation does
not attempt to resolve them by inventing a merge order.

| Condition | Reason to fall back |
|---|---|
| Multiple open blockers | More than one unmerged blocker is ambiguous to start from.  Resolve manually: merge or close all but one blocker first. |
| Blocker has no open PR | The blocker's implementation is not complete; no usable head branch exists to start from. |
| Blocker PR has a merge conflict | The conflict must be resolved before the head branch is usable as a start point. |
| Blocker PR failed review | A PR in `needs_fix` state may change further; starting from it now risks a moving base. |
| Blocker PR head branch missing from remote | The branch reference cannot be checked out or used as a start point. |

## Common Rules

- Work only inside the configured repository root.
- Treat `sessionId`, `repoRoot`, `githubRepo`, and artifact paths as handler
  inputs, not values to rediscover from the current shell directory.
- Keep each phase limited to its assigned responsibility.
- Do not run repository state-changing `git` or `gh` commands from agent
  prompts. Branch checkout, commit, push, PR creation, PR checkout, comments,
  labels, and outbox dispatch are handler-owned.
- Do not make unrelated refactors or cleanup changes while completing a task.
- Do not bump package or extension versions unless the issue explicitly asks
  for a release/versioning change.
- Do not directly edit specification documents (`AGENTS.md`, `docs/phase-contracts.md`,
  or any file that defines agent or workflow behavior contracts), workflow behavior,
  or operational policy unless the current task issue explicitly requests that exact
  change. Because an automation-owned Issue/PR branch may be active at any time —
  even when the agent cannot confirm it — such changes must enter through a dedicated
  Issue. Normal inspection and diagnosis is always permitted. Local recovery actions
  explicitly requested by the operator are permitted when scoped to the request and
  reported in the artifact. Discovered specification gaps must be recorded in the
  result artifact and opened as a follow-up Issue rather than edited inline. See
  `AGENTS.md` — No-Direct-Edits Policy for the full action-by-action distinctions.
- Prefer existing project patterns and local helper APIs over new abstractions.
- Write phase artifacts under `<artifactRoot>/runs/<runId>/`.
- A phase that cannot satisfy its contract should fail clearly instead of
  silently moving work forward.

## Agent Diagnostic Provenance and Retry Classification

Issue #661 attempted to prevent quota-delay false positives — an agent's raw
output falsely triggering a multi-hour "quota exhausted" delay — while still
catching every legitimate provider quota/rate-limit message that arrives as
plain stdout text. After ten implementation/review cycles the work repeatedly
alternated between two failures: trusting stdout text reintroduced false
delays whenever an agent transcript or reviewed diff quoted a provider error,
and rejecting unproven stdout text stopped recognizing legitimate provider
messages that some CLIs print to stdout. **#661 and its PR #669 are superseded
exploratory implementations.** This section is the authoritative contract;
a future runtime issue may replace #661/PR #669's heuristics entirely and is
not required to preserve any of that branch's signal lists, regexes, or
stdout+stderr concatenation behavior.

### The provenance problem

A provider's own CLI process and the agent it is running can both write to the
same stdout stream. Raw agent stdout routinely contains source code, reviewed
diffs, test output, and verbatim quotes of provider error messages (e.g. an
agent explaining "the previous run failed with `rate limit exceeded`" while
reviewing a log, or a diff that adds a string literal containing that phrase).
**Text-only analysis cannot distinguish a genuine provider diagnostic from an
identical string quoted inside a transcript, diff, or test fixture** — the
bytes are the same either way. No amount of additional phrase-matching,
regex tightening, or signal-list curation closes this gap, because the
ambiguity is structural (shared stream, arbitrary untrusted content), not a
matter of insufficiently precise wording.

### Stdout is untrusted for automatic retry classification

Raw agent stdout must not, by itself, trigger an automatic quota/capacity
delay. It only counts as a provider diagnostic when a provider-specific
adapter establishes **provenance** — i.e. the adapter can show the text
originated from the provider/CLI process's own diagnostic output for this
invocation, not from agent-authored or agent-quoted content. Marker prefixes
such as `ERROR:` do **not**, by themselves, establish provenance: an agent can
write or quote a line beginning `ERROR:` in a diff, log excerpt, or
explanation just as easily as a CLI can emit one. A prefix is a formatting
convention, not proof of origin.

### Stderr: a bounded, provider-owned diagnostic channel

Raw stderr may be used for classification, but only through a bounded,
provider-owned channel — it is not automatically more trustworthy than stdout
just because it is a different stream:

- **Boundary.** A provider adapter must explicitly declare stderr as its
  diagnostic channel for a given agent CLI; this is not a default trust
  extended to every agent. Even then, only output attributable to the
  provider CLI's own process counts — a verbose/debug mode that echoes the
  agent transcript to stderr does not make that echoed content eligible, for
  the same reason stdout is untrusted above.
- **Retention limit.** Classification may inspect only a bounded tail of
  captured stderr for a given invocation (a fixed-size window, e.g. the final
  few KB), not the full unbounded capture — this keeps a long transcript that
  happens to scroll through stderr from being scanned wholesale for
  quota-shaped phrases. Only the specific matched diagnostic line(s), not the
  full stderr blob, may be carried into task context, event payloads, or
  GitHub-facing artifacts; full stderr capture is retained under the same
  run-log retention as any other phase output, not extended or special-cased
  because it fed a classification decision.

### Machine-readable output takes precedence over text matching

When a provider adapter exposes a machine-readable result (a structured error
code, a typed field, a documented exit-code convention — whatever the
provider's own interface guarantees), that result is preferred over any text
match on stdout or stderr. Provenance is established by construction in this
case: the adapter is reading a channel the provider contractually controls,
not inferring meaning from prose. Text matching against the bounded stderr
channel above is a fallback for providers/CLIs that expose no machine-readable
signal, not a substitute for one that already exists.

### Failure categories

Every agent CLI failure is classified into exactly one of four categories:

| Category | Meaning |
|---|---|
| `usage_quota` | A fixed-rate or subscription usage window is exhausted (e.g. "usage limit reached", "5-hour limit"). Recoverable only once the window resets. |
| `rate_limit` | A short-term request-rate limit was hit (e.g. HTTP 429, "too many requests"). Recoverable quickly, independent of any usage window. |
| `provider_capacity` | The upstream provider is transiently overloaded (e.g. "overloaded_error", "resource exhausted" for capacity reasons). Recoverable once load subsides, independent of the caller's own usage/rate. |
| `ordinary_failure` | Any failure whose provenance is not established as a provider diagnostic, or that is a genuine task/tooling failure. The default category. |

**Category precedence.** When a trusted diagnostic source (a machine-readable
result, or the bounded provider-owned stderr channel) contains signals for
more than one category, explicit usage-exhaustion wording takes precedence
over generic retry wording: `usage_quota` > `rate_limit` > `provider_capacity`
> `ordinary_failure`. Generic transient phrasing such as "try again later" on
its own — with no explicit usage/rate-limit/capacity signal alongside it —
must not be upgraded to `usage_quota`; it is only decisive when it is the
only trusted signal available and an adapter maps it to `rate_limit` or
`provider_capacity`, never to `usage_quota` by itself.

**Ambiguous markerless stdout is deterministic, not a hidden delay.** When
stdout contains quota/rate-limit-shaped text but no adapter can establish
provenance, the outcome must be deterministic and fail-visible: the failure is
classified `ordinary_failure` and surfaces through the phase's normal failure
handling (e.g. `needs_fix` escalation, `ready_for_human`, or a scoped retry
per that phase's contract elsewhere in this document) exactly as any other
task failure would. It must never silently fall back to a long, unexplained
quota-style delay.

### Retry policy by category

| Category | Retry behavior |
|---|---|
| `usage_quota` | May use the long, reset-oriented delay (task requeued with a `notBefore` timestamp scaled to the usage window, e.g. the existing `QUOTA_RETRY_DELAY_MS`/`QUOTA_RETRY_DELAY_HOURS` default). |
| `rate_limit` | Short transient retry policy — a brief backoff, not the multi-hour quota delay. |
| `provider_capacity` | Short transient retry policy — a brief backoff, not the multi-hour quota delay. |
| `ordinary_failure` | Not delayed as quota at all. Follows the ordinary failure path for the phase (fix/escalation/human handoff), with no automatic re-queue delay attributable to this policy. |

### Decision table

| Trusted source | Category | Retry behavior |
|---|---|---|
| Machine-readable provider result: usage exhaustion | `usage_quota` | Long reset-oriented delay |
| Machine-readable provider result: rate limiting | `rate_limit` | Short transient retry |
| Machine-readable provider result: capacity/overload | `provider_capacity` | Short transient retry |
| Bounded provider-owned stderr channel: explicit usage-exhaustion wording | `usage_quota` | Long reset-oriented delay |
| Bounded provider-owned stderr channel: rate-limit/capacity wording only | `rate_limit` / `provider_capacity` | Short transient retry |
| Markerless stdout, quota-shaped text, no adapter provenance | `ordinary_failure` | Ordinary failure handling — no automatic delay |
| Any stream, marker-prefixed text alone (e.g. `ERROR:`) with no adapter provenance | `ordinary_failure` | Ordinary failure handling — no automatic delay |

### Known implementation divergence

`src/core/quota-classifier.ts` currently classifies by text-matching the
**concatenation of raw stdout and stderr**, with no provenance/adapter seam —
exactly the untrusted-stdout pattern this contract prohibits for automatic
delay. This is the #661/PR #669 heuristic referenced above. Bringing the
runtime in line with this contract (introducing a provider-adapter provenance
seam, bounding the stderr channel, and splitting `isQuotaExhaustion` into the
four categories above) is out of scope for this specification issue and must
be done in a dedicated follow-up implementation issue.

### Indeterminate CLI probes (issue #897)

The categories above describe failures of the **agent** process. A second,
narrower source of non-code failure is a **CLI availability probe that never
answered** — `admin session-doctor` spawning `<agent> --version` on a host that
timed out or refused the fork.

Such a probe establishes nothing about the CLI. It is therefore reported with
its own typed status (`timeout` / `spawn-error`, `transient: true`) and its
operator-facing diagnostic is prefixed with the structural marker
`[cli-probe-indeterminate]`, never with "not found".

When a **review verification command** fails and its captured output carries
that marker, the failure is evidence about the machine, not about the diff.
Review takes the **short transient retry policy** — the same backoff
`rate_limit` and `provider_capacity` take — rather than routing to `needs_fix`.
Routing it to `needs_fix` would requeue an implementation phase that correctly
finds nothing to change and then fails for producing no diff.

The delay is bounded (`MAX_TRANSIENT_VERIFICATION_RETRIES` in
`src/core/review-classifier.ts`), and the bound is **per verification command**:
each configured command keeps its own counter in the task context, and a
command that passes releases the budget it had spent. A shared counter would
let a probe timeout in `test` spend the budget, pass on the retry, and then
route `package`'s first indeterminate probe to `needs_fix`. Once a command's
bound is spent, its failure follows
the ordinary `needs_fix` path so a condition that does not clear still reaches a
human as the real failure it is. Detection matches the bracketed marker and
nothing else: verification output quotes the words "timeout", "EAGAIN" and
"unavailable" for unrelated reasons, and a broader rule would start delaying
genuine test failures.

## Complexity Labels

Optional complexity labels control the Claude model, effort, and budget used for
implementation.  They are evaluated at the start of each implementation run.

| Label             | Model  | Effort | Budget |
|-------------------|--------|--------|--------|
| `complexity:low`  | sonnet | low    | $2     |
| *(no label)*      | sonnet | high   | $5     |
| `complexity:high` | opus   | high   | $10    |
| `complexity:xhigh`| fable  | xhigh  | $20    |

When multiple complexity labels are present the strongest wins:
`xhigh > high > low`.

`complexity:xhigh` selects Claude Fable 5 (`fable`) at `xhigh` effort (issue
#857, a follow-up policy correction to #748) — the strongest available
implementation profile, not a route back to Opus 5. Issue #748 moved
`complexity:xhigh` off Opus 5 (a distilled model; effort above `high`
degrades its implementation quality rather than improving it) onto Fable 5,
but capped it at `high` effort, leaving the tier no stronger than
`complexity:high`. Since Opus 5 at `high` and Fable 5 at `high` are judged
roughly equivalent in implementation capability, `complexity:xhigh` now runs
Fable 5 at its own `xhigh` effort tier so the tier is materially stronger
than `complexity:high`. See `docs/assignment-profiles.md` ("Where Cost
Settings Fit") for the session-config override shape and a preflight command
to confirm Fable 5 availability.

Environment variables (`CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_MAX_BUDGET_USD`)
override complexity-label defaults when set; a session's
`claude.complexityProfiles` override sits between the built-in default and
the env vars in precedence.

Review-loop effort escalation (`escalatedEffort`) promotes effort to `high` on
the penultimate fix cycle only when it would actually raise the label-derived
effort.  Labels whose effort already meets or exceeds the escalation target
(the default and `high`, plus `complexity:xhigh`, which now also resolves to
`high`) skip escalation — the escalation rank guard exists so a stronger
label-derived effort (e.g. a session override that raises a tier back to
`xhigh`) is never silently downgraded.

`complexity:xhigh` is a Claude implementation tier only. The Codex review path
has no `xhigh` reasoning effort (`model_reasoning_effort` accepts low/medium/high
only), so when no explicit `review:*` label is present `complexity:xhigh`
derives the strongest Codex-supported review strength (`high`), the same as
`complexity:high`. See the review-strength note below.

## Review Strength Labels

Optional review labels control the Codex `model_reasoning_effort` config used for
the review phase. Explicit review labels win over complexity-derived strength;
when several conflict, the strongest wins.

| Label            | Codex reasoning effort |
|------------------|-------------------------|
| `review:low`     | `low`                   |
| `review:medium`  | `medium`                |
| `review:high`    | `high`                  |
| *(no label)*     | `high`                  |

Precedence when present: `review:high > review:medium > review:low`.

**Issue #609: `review:medium` now always passes an explicit
`-c model_reasoning_effort=medium` flag.** Before #609, the "default" tier
(covering both a genuine `review:medium` label and the no-label case) passed no
`model_reasoning_effort` flag at all, so the effective effort silently tracked
whatever the operator's global `~/.codex/config.toml` happened to default to —
a `review:medium` review could run at `high` on one machine and `low` on
another. Every review now resolves to an explicit level, independent of
unrelated global Codex config: an explicit `review:medium` label maps to
`medium`; the no-label case maps to `high`, mirroring how Claude's own review
default already resolves to `high` effort when no review label is present
(`resolveClaudeReviewProfile`, `src/handlers/review.ts`). `CODEX_EFFORT`
overrides both when set (see `resolveCodexReviewEffort`, `src/handlers/review.ts`),
mirroring the implementation lane's `CODEX_EFFORT` precedence.

**There is no `review:xhigh`.** The installed Codex CLI's
`model_reasoning_effort` only accepts low/medium/high — `xhigh` is a Claude-only
effort tier. Per issue #243 it is *not* silently downgraded to `high`: a
`review:xhigh` label is simply not a recognized review label and has no effect
(it falls through to the no-label case above, `high`). `xhigh` is a valid
Claude implementation effort value — `complexity:xhigh` itself resolves to
`xhigh` effort on Fable 5 (issue #857). When no explicit `review:*` label is
set, `complexity:xhigh` and `complexity:high` both derive the strongest
Codex-supported review strength (`high`), since Codex has no `xhigh`
reasoning tier.

## Codex Model Selection (issue #609)

Codex model selection is optional and separate from effort. Precedence:

1. `CODEX_MODEL` env var (operator override) — highest.
2. `session.codex.model` (session-level setting; validated/cloned in
   `src/registries/json-session-registry.ts`).
3. **Compatibility mode** — neither is set. No `--model` flag is passed;
   the Codex CLI's own config/authenticated default selects the model,
   exactly as it did before this option existed. Resolved profile metadata
   records this as `model: "cli-default"`, distinguishable from an explicit
   selection (`modelSource: "default"` for implementation, `"cli-default"`
   for review — see `ResolvedImplementationProfile`/`ResolvedReviewProfile`).

When resolved to an explicit model, it is passed as `--model <model>`, a
**global** Codex CLI option spliced before the `exec`/`review` subcommand
(same positioning rule as `--profile` for context-mode — see
`resolveCodexModel()`, `src/handlers/codex-context-mode.ts`). This precedence
is shared by both the implementation (`codex exec`) and review (`codex review`)
lanes — a single `session.codex.model` setting (or `CODEX_MODEL` override)
governs both, so the same session/task inputs resolve to the same model
independent of unrelated global Codex config.

There is no label- or escalation-driven model selection for Codex: models are
a trusted-config/operator-env concern only, mirroring how assignment profiles
select the *agent* but never its model/effort (`docs/assignment-profiles.md`,
"Where Cost Settings Fit", issue #694 decision 5). Escalation
(`escalatedEffort`) only ever raises *effort*, never model — the same rule
Claude's `CLAUDE_MODEL` already follows.

## Implementation

Implementation handles `agent:claude` + `status:needs-implementation`.

Allowed:

- Read the issue context supplied by intake.
- Inspect source, tests, docs, and local helper APIs.
- Edit files needed to satisfy the issue.
- Run safe inspection and verification commands allowed by the handler.

Forbidden:

- Running `git` or `gh`.
- Creating, renaming, or pushing branches.
- Opening or editing PRs.
- Changing unrelated files.
- Performing release/version bumps unless explicitly requested.

Success criteria:

- The requested change is implemented in the configured repository.
- The working tree contains file changes after the agent exits.
- Configured verification (`session.verification`) passes before
  commit/push — execution and continuation semantics per
  [docs/verification-execution-contract.md](verification-execution-contract.md).
- The handler can commit, push, and create a PR for `ai/issue-<issueNumber>`.
- The task transitions to review after a successful implementation run.

Failure criteria:

- The worktree is dirty before the handler starts.
- The implementation agent exits non-zero.
- The implementation agent exits zero but produces no diff.
- Handler-owned `git` or `gh` operations fail.

Required artifacts:

- `implementation-prompt.md`
- `implementation-output.md`
- `implementation-result.json`

## Fix Existing PR

Fix mode handles `agent:claude` + `status:needs-fix`.

Allowed:

- Read the fix request supplied in task context or the prompt, plus local code.
- Apply focused changes that address actionable review findings.
- Run safe inspection and verification commands allowed by the handler.

Forbidden:

- Creating a new PR.
- Creating a new branch for the same issue.
- Expanding the scope beyond the review findings unless required to fix the
  same defect.
- Running `git` or `gh`.

Success criteria:

- The handler finds an open PR whose head branch is `ai/issue-<issueNumber>`.
- The handler checks out that existing branch.
- The agent applies fixes on that branch.
- The handler commits and pushes to the same branch.
- The task transitions back to review.

Failure criteria:

- No open canonical PR branch exists.
- The fix request is not present in task context or the prompt.
- The existing PR branch cannot be checked out or updated.
- The agent exits non-zero or produces no diff.

Fix mode is triggered automatically when the review handler returns `needs_fix`.
The review output is captured as `reviewFeedback` in task context and included
in the fix prompt. Fix mode also activates when task labels contain
`status:needs-fix` (manual trigger), but in that case `reviewFeedback` must
be present — fix mode will fail before running Claude if feedback is absent.

The evidence-backed review-dispute protocol — structured finding lineage,
per-finding dispositions (`fixed` / `review_disputed` / `blocked`), reviewer
reconsideration, bounded arbitration, and human escalation — is specified in
[review-dispute-contract.md](review-dispute-contract.md) (issue #835). It is
implemented (issues #836-#849) but ships default-off; whenever
`session.reviewDispute.enabled` is off, a fix run that produces no diff
fails exactly as described above. See
[feature-status.md](feature-status.md#review-dispute) for the operator-facing
availability summary.

Operational note:

Legacy run-id branches such as `ai/issue-37-1133` are not part of the long-term
contract. Migrate those PRs manually to `ai/issue-<issueNumber>` before retrying
fix automation.

## Review

Review handles `status:needs-review`. The review agent is chosen from the coarse
`agent:*` labels (`labelsToPhase`), but the implementation owner is **not**
reconstructed from those labels here — it is read from
`context.assignment.implementationAgent`, the source of truth. See
[assignment-profiles.md](assignment-profiles.md#assignment-vs-agent-labels-source-of-truth)
for the assignment-vs-label boundary (issue #292).

Allowed:

- Check out the PR branch.
- Run configured verification commands.
- Review the diff against `main`.
- Classify the result as no blocking findings, needs fix, conflict, or failed.
- Record actionable findings through handler/outbox-managed GitHub updates.

Forbidden:

- Implementing fixes.
- Committing or pushing changes.
- Treating cosmetic nits as blocking findings by themselves.
- Merging PRs.

Review posture:

- Lead with bugs, regressions, spec mismatches, and missing tests.
- Prefer concrete file/line references when findings are actionable.
- Keep summaries secondary to findings.
- Say explicitly when there are no blocking findings.

Success criteria:

- Verification commands pass.
- Codex review completes.
- The review classifier can determine the next state from the review output.
- Blocking findings are recorded clearly enough for fix mode; otherwise the task
  becomes ready for human decision.

Routing after review:

- `success` → task becomes ready for human decision.
- `needs_fix` → task is automatically requeued to implementation/fix mode.
  Review output is captured as `reviewFeedback` in task context. The
  structured dispute/reconsideration/arbitration protocol layered on this
  loop is specified in
  [review-dispute-contract.md](review-dispute-contract.md).
- `conflict` → the review handler returns `result: "conflict"`, which the runner
  routes to the `conflict_resolution` lane.  This applies to dependency-started
  PRs too: because every PR (dependency-started or not) targets the session base
  (`main`), a conflict is always a conflict against `main`, which the
  `conflict_resolution` handler resolves by merging `main` into the PR branch.
- `blocked` (empty/ambiguous output, or conflict classification) → task
  escalates to `ready_for_human`.

Required artifacts:

- `review-context.json`
- `review-output.md`
- `review-result.json`
- `review-verification-<name>.log` for each configured verification command

## Research

Research handles `agent:gemini` + `status:research-needed`.

Allowed:

- Read repository files and issue context.
- Investigate existing code, dependencies, external constraints, and design
  options.
- Produce findings that can become follow-up implementation issues.

Forbidden:

- Editing repository files.
- Running implementation work.
- Creating branches or PRs.
- Presenting uncertain claims as confirmed facts.

Execution context (issue #855):

- The agent runs in a per-run Issue worktree detached at the freshly fetched
  `origin/<base>` commit — never in the shared canonical checkout, which may be
  stale, dirty, or in use for unrelated work. See
  docs/per-issue-worktrees.md §Research worktree.
- Fetch, SHA resolution, or worktree creation failing stops the run *before* the
  agent is invoked. There is no fallback to local repository state.
- No `ai/issue-<n>` branch is created; the checkout is removed after the run and
  run artifacts (written outside it) are preserved.

Success criteria:

- The output summarizes findings, options, recommendation, risks, and open
  questions.
- The output is usable by a maintainer or implementation agent as planning
  input.
- The task becomes ready for human decision unless a later workflow explicitly
  routes research output into implementation.

Required artifacts:

- `research-prompt.md`
- `research-output.md`
- `research-result.json`
- `research-workspace-failure.json` — only when the per-run research worktree
  could not be prepared (issue #855): the failing stage
  (`worktree-root` / `fetch-base` / `resolve-base` / `worktree-create`), the base
  branch, the underlying git text (local-only), and `agentInvoked: false`.
- `research-permission-denial.json` — only when the run is classified as a
  permission denial (see below).
- `research-denial-diagnostic-<channel>.txt` — only alongside that artifact: a
  verbatim copy of each populated trusted diagnostic channel, which is what the
  recorded evidence line numbers index into (see below).
- `research-evidence-manifest.json`, `research-evidence-turn-<n>.json`,
  `research-prompt-turn-<n>.md`, `research-turn-<n>-output.md`, and
  `research-issue-body.md` — only on an evidence-enabled run
  (`session.research.evidence.enabled`, issue #806): the run-level evidence
  accounting, the per-turn sanitized request records, and the per-invocation
  verbatim prompt/output captures of the evidence turn loop defined in
  [docs/research-evidence-contract.md](research-evidence-contract.md) §9. A
  disabled run writes none of these.
- `research-workspace-settings.json` — only when the runner-owned Antigravity
  workspace permission profile is enabled
  (`session.research.antigravity.workspaceSettings.enabled`, issue #826): the
  policy version, schema pin, content hash, rule counts, ignore mode, trust
  status, the version the installed CLI reported, the state of the
  runner-owned global permission overlay (issue #830), and the read-only tool
  registration installed with it (issue #832) for the profile
  regenerated before every headless invocation, or the
  refusal reason when preparation failed closed. Specified in
  [docs/antigravity-workspace-settings.md](antigravity-workspace-settings.md).
- `research-tool-surface-violation.json` — only when a run that installed that
  registration is still denied a command/process permission (issue #832): the
  installed CLI offered a command-capable tool the registration does not name,
  which is a compatibility finding about the build rather than an ordinary
  denial. The record carries the policy identity, the CLI version, the exact
  registration installed, and the operator's next step; the remedy is never to
  grant command execution.
  A disabled run writes nothing into the workspace and writes no such artifact.

Input bound: the persisted GitHub Issue body interpolated into the research
prompt is bounded at 32,768 characters (issue #803; raised from the original
4,000, which was too small for ordinary research Issues). A body beyond the
bound is truncated deterministically to a prefix of that length with an
explicit `<!-- body truncated -->` marker appended. `research-brief.json`,
`research-context.json`, and `research-result.json` all record
`bodyIncluded`, `bodyTruncated`, `bodyOriginalLength`, and
`bodyIncludedLength` so complete and truncated input can be distinguished
after the fact. The runner-owned full-body artifact and the bounded query path
for bodies beyond this bound are specified in
[docs/research-evidence-contract.md](research-evidence-contract.md) (issue #805,
`issue-body` evidence source) and implemented in its follow-up issue; the bound
and its reporting above are unchanged by that design.

### Antigravity print-mode timeout (issue #861)

`agy --print` applies its own print-mode wait timeout — `agy --help` documents
`--print-timeout` as defaulting to `5m0s`. A large but valid research task can
exceed five minutes; when it does, the CLI exits non-zero after emitting only a
partial response and the run is classified as `command-failure`, indistinguishable
from a genuine agent error without cross-checking elapsed time against that
default.

The research handler always passes an explicit `--print-timeout <value>` to
`agy --print`, so the run is never implicitly bound by Antigravity's own
five-minute default:

- **Configuration key:** `session.research.antigravity.printTimeout`, a string.
- **Default:** `"15m"` (`ANTIGRAVITY_PRINT_TIMEOUT_DEFAULT`,
  src/core/antigravity-print-timeout.ts) when the session does not configure one —
  three times Antigravity's own CLI default.
- **Accepted format:** one or more `<number><unit>` segments using `h`, `m`, or
  `s`, e.g. `"15m"`, `"90s"`, `"1h30m"` — the same shape `agy --print-timeout`
  itself accepts (Go's `time.ParseDuration`).
- **Bounds:** rejected at session load (`json-session-registry.ts`) and again by
  the handler before the value reaches command argv: empty, malformed (wrong
  unit, extra characters, a repeated unit), zero, negative, and any duration
  exceeding `ANTIGRAVITY_PRINT_TIMEOUT_MAX_MS` (60 minutes) all fail closed with
  a descriptive error rather than silently falling back to a default or an
  unbounded wait.
- **Argv order:** `["--model", <model>, "--print-timeout", <value>, "--print"]`
  when a model is configured, `["--print-timeout", <value>, "--print"]`
  otherwise — model, then print-timeout, then `--print`, regardless of which of
  the two optional inputs are configured.
- **Recorded, not just applied:** `ResolvedResearchProfile` carries
  `printTimeout` (the value passed to argv), `printTimeoutMs` (the same value in
  milliseconds), and `printTimeoutSource` (`"cli-default"` or
  `"session-config"`), so `research-context.json` (written before the agent is
  invoked) and `research-result.json` both show the effective timeout without
  opening the raw capture.
- **No outer deadline undercuts it.** The research handler passes no `timeout`
  option to the command runner, so nothing in this codebase can impose a
  deadline shorter than the configured `--print-timeout` — the only timeout
  governing a research invocation is the one named above.

This is diagnosis-and-configuration only: it does not change quota/rate-limit
classification, permission-denial classification, or any other research outcome
in the table below. A run that still exceeds the configured `--print-timeout`
classifies as `command-failure`, exactly like any other non-zero `agy --print`
exit.

### Research outcome classification

`research-result.json` records exactly one `outcome`:

| Outcome | Meaning |
|---|---|
| `valid` | Exit 0 with non-empty stdout. |
| `quota/rate-limit` | The trusted diagnostic classifies as `usage_quota` / `rate_limit` / `provider_capacity`; the task is delayed, not failed. |
| `command-failure` | Non-zero exit that is not a quota condition. |
| `permission-denied/read` | Exit 0, empty stdout, and the trusted diagnostic states that a repository read/search operation was refused. |
| `permission-denied/command` | Same, for a refused command/process operation. |
| `permission-denied/unspecified` | Same, but the diagnostic does not support the read-vs-command distinction (no operation token, or both classes refused). |
| `empty-output` | Exit 0, empty/whitespace-only stdout, with no denial evidence (issue #795). |
| `evidence/unavailable` | Evidence-enabled runs only (issue #806): the tracked-file snapshot could not be captured, exceeded its bounds, or the evidence root's identity changed mid-turn. A partial snapshot is never served. |
| `evidence/protocol-error` | Evidence-enabled runs only: two consecutive invocations produced a malformed evidence request block and no findings. |
| `evidence/budget-exhausted` | Evidence-enabled runs only: a turn, query, byte, or cumulative-prompt budget was spent and the final invocation produced a request block with no findings text. |

**Headless permission denials (issue #804, first slice of #802).** A headless
Gemini/Antigravity run can be *soft-denied*: the CLI cannot obtain a tool
permission non-interactively, abandons the tool call, and still exits 0 with
empty stdout — process-identical to an unproductive run, with the actionable
cause left in the CLI's own diagnostics. The research handler therefore
re-examines exactly that case (exit 0 + empty stdout, no quota classification)
against the same provider-adapter provenance seam the quota path uses: raw
stdout is never scanned, and an invocation whose binary was operator-overridden
via `ANTIGRAVITY_BIN` yields no trusted diagnostic and stays `empty-output`. A
run that produced findings is never downgraded, and a non-zero exit stays
`command-failure`.

Because the denial is reported on stderr by a process that exits 0, the research
phase must be driven by a command runner that captures both streams on success.
The `execFileSync`-based default runner discards buffered stderr on a zero exit
and reports `stderr: ""`, which would make every real denial indistinguishable
from `empty-output`; the research handler therefore defaults to the
`spawnSync`-based both-streams runner.

The read-vs-command distinction is resolved per denial from its own evidence
window, preferring the rejected tool's identifier (`run_shell_command`,
`read_file`, …) over prose or bare command words, which a diagnostic may be
quoting from the rejected call's arguments — `run_shell_command "grep …":
permission denied` is a `command` denial, not an ambiguous one. Only a
diagnostic that names no tool at all falls back to those generic tokens, and
two opposing tool identifiers stay `unspecified`.

Diagnosis only: this classification grants no permission, relaxes no policy,
and adds no execution path. The constrained read-only execution contract that
gives a headless research run repository evidence without any of those grants
is specified in [docs/research-evidence-contract.md](research-evidence-contract.md)
(issue #805); it is an approved design whose implementation lands in a separate
issue in the #802 decomposition, off by default, and it changes nothing
described in this section until then.

The bounded read-only workspace permission profile that keeps a headless run's
own tool calls from being auto-denied is a separate, also opt-in layer specified
in [docs/antigravity-workspace-settings.md](antigravity-workspace-settings.md)
(issue #826, reconciled with the installed `agy` 1.1.9 by issue #830). It grants
no write, command, child-process, or network capability,
introduces no research outcome, and leaves the classification above and the
evidence bounds unchanged; a run whose profile cannot be prepared — whose
installed CLI is outside the reconciled version range, or whose
prepared profile no longer matches the file the CLI would load at launch — fails
closed before the agent is invoked. Its workspace-scoped rules are installed into
the global CLI settings for the duration of the run and removed again on every
exit path, leaving unrelated settings unchanged. Because the profile lets the agent read and
search the workspace with its own tools, enabling it also withholds raw agent
output from every published comment and notification, exactly as an interpolated
Issue body and an enabled evidence channel already do.

**Denial artifact and publication bounds.** `research-permission-denial.json`
records the denial category (`deniedOperation`), the matched signal, the
diagnostic source and `cmdSource` provenance, an operator hint, the total
`denialCount`, and bounded evidence records. An evidence record is content-free
by construction: it carries only the matched denial signal, the matched
operation tokens — both literals from the classifier's own fixed vocabulary,
never spans copied out of the diagnostic — and the `channel`/`line` where the
denial appeared. A denied command body, its arguments, a generated scratch
path, or an echoed prompt line therefore cannot be retained even when the CLI
prints one on or beside the denial line; the unbounded detail stays in the raw
local capture (`research-output.md`) — which is why that file falls back to
stderr whenever stdout carries no visible content, not only when stdout is
exactly empty: a soft denial commonly prints whitespace on stdout and its
diagnostic on stderr. The number of retained records is capped, with
`evidenceTruncated` marking the cut.

An evidence `line` is 1-based *within the bounded diagnostic the classifier
consumed*, which is a fixed-size tail of the channel and may begin mid-line — so
for a verbose run it does not agree with the numbering of the fuller
`research-output.md` capture. The handler therefore also writes
`research-denial-diagnostic-<channel>.txt` holding exactly the bytes that were
numbered, and `diagnosticFiles` in the artifact maps each evidence `channel` to
its file, so a recorded location always resolves precisely. Those files are
local-only and no wider than the bound the provider adapter already applied.
`research-result.json` carries only a compact summary of the same fields and
points at the artifact. The GitHub/Slack failure text is fixed-form: it names
the outcome, the operation class, and the exit code, and never the denied
command, refused path, scratch path, prompt content, matched diagnostic text,
or any repository path.

## Conflict Resolution

Conflict resolution handles `status:needs-conflict-resolution`, or any task
routed here when the review handler classifies its result as `conflict`.

**Responsibility split** — The handler owns all repository operations.  The
agent owns only editing conflicted files and staging the specific resolved
files.  The agent must not run `gh` commands or broad `git` operations; it
may run the scoped inspection and staging commands listed below.

### Handler-owned responsibilities

The handler performs these steps in order, stopping on the first failure:

1. Locate the open PR for the issue via `gh pr list` (using `branchName(issueNumber)`).
2. Verify the worktree is clean before touching it.
3. Check out the PR branch.
4. Fetch and update from the configured base branch.
5. Attempt a merge of the base branch into the PR branch.
   - If the result is already up-to-date (no `MERGE_HEAD`), skip steps 6–12
     and return `success` so the task re-enters `review`.  No verification,
     commit, or push is performed because there is nothing to merge.
   - If the merge completes cleanly via fast-forward, skip steps 6–9,
     run verification (step 10), commit (step 11), push (step 12), and return
     `success` so the task re-enters `review`.
6. Detect the conflict shape (text conflicts vs. binary or modify/delete conflicts).
7. Write a scoped conflict-resolution prompt that lists only the conflicted files.
8. Invoke the agent to edit and stage the resolved files.
9. Verify no unmerged paths remain and no conflict markers are present in staged files.
10. Run verification commands (e.g. `npm test`).  A verification failure is a
    semantic conflict-resolution failure — abort the in-progress merge before
    any commit and escalate; see **Semantic Conflict Escalation Policy** below.
11. Commit the merge resolution.
12. Push the PR branch.
13. Return `success` so the task re-enters `review`.

### Agent-owned responsibilities

- Edit conflicted files to produce a coherent, compilable resolution.
- Stage the specific resolved files using `git add -- <filename>`.
- Use `git status` and `git ls-files -u` to inspect conflict state.
- Do not stage unrelated files.
- Do not run `gh` commands or any `git` command other than `status`,
  `ls-files -u`, and `add -- <filename>`.

### Stop / handoff conditions

The handler must stop and move the issue to `status:ready-for-human` when setup
cannot begin:

- No open PR is linked to the issue (e.g. head branch `ai/issue-<N>` not found).
- The worktree is dirty before setup begins.

The handler must stop and mark the issue `status:conflict-resolution-failed` when:

- The PR branch is missing or cannot be checked out.
- `git fetch` or the base-branch update fails.
- The merge command fails for an unexpected reason (exit code non-zero for
  reasons other than conflicts).
- Binary or modify/delete conflicts are detected — these require human judgment
  and must not be guessed by the agent.
- The agent exits non-zero.
- Unmerged paths remain after the agent runs.
- Conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) remain in staged files
  after the agent runs.
- Verification fails after conflict resolution.
- Push fails.

The handler must not proceed past a stop condition, attempt a partial merge
commit, or leave the worktree in an intermediate state.

### Success criteria

- All conflicts are resolved without markers.
- The merge commit is pushed to the PR branch.
- The task transitions back to `review` for re-evaluation.

### Failure criteria

- Any stop/handoff condition listed above is triggered.
- The agent produces no diff on the conflicted files.

### Semantic Conflict Escalation Policy

**Textual vs. semantic conflicts**

A *textual conflict* occurs when Git detects overlapping edits — the same lines were changed in both the PR branch and the base branch.  Git surfaces these as conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).  The agent resolves textual conflicts by editing the conflicted files to produce coherent output.

A *semantic conflict* occurs when the textual merge completes without markers but the combined code no longer works: verification commands fail, tests break, or the build does not compile.  Git cannot detect semantic conflicts; only running the project's verification suite reveals them.

**Classification of verification failures**

A verification failure after a conflict_resolution attempt is classified as a *semantic conflict-resolution failure*.  It is not a transient error and must not be treated as one.

**Attempt limit**

Each conflict_resolution cycle is a single automated attempt.  Automation stops after the first verification failure.  Re-running conflict_resolution on the same textual state will not resolve a semantic disagreement: the agent cannot redesign the interacting feature logic, rewrite the merged subsystems to be compatible, or determine which change takes semantic precedence.  Retrying loops without converging.

**Escalation signal and required actions**

A verification failure after any conflict_resolution attempt is an explicit escalation signal.  The handler must:

1. Stop immediately — do not commit or push the unverified merge state.
2. Mark the task `status:conflict-resolution-failed`.
3. Post a safe operator-facing GitHub comment (see below).

Do not attempt further automated resolution passes, redesign the feature autonomously, or attempt to determine semantic intent from the conflicting changes.

**Safe public comment shape**

The GitHub comment posted on escalation must contain:

- A plain-language statement that conflict resolution was attempted and verification failed.
- The names of the verification commands that failed (e.g. `npm test`) and their exit-code category.
- A statement that human semantic review is needed, naming the PR branch and the base branch.

The comment must not contain:

- Local filesystem paths (artifact root, worktree path, temp files, or any path rooted on the local machine).
- Raw agent output, implementation rationale, or diagnostic log text.
- Session IDs, run IDs, or internal task-store identifiers.
- Contents of local configuration files or environment variables.

Example safe comment:

> Conflict resolution was attempted for `ai/issue-<N>` against `main`.  The textual merge completed but verification failed (`npm test` — non-zero exit).  Human review is required to resolve the semantic conflict between the PR branch and `main`.

**Future work boundary**

Richer automation support — automated context enrichment, rationale surfacing, or semantic review-feedback integration — must be implemented as separate issues after this escalation boundary is established.  Do not add retry logic, autonomous redesign behavior, or semantic conflict fixers in any issue that establishes or depends on this policy.

Required artifacts:

- `conflict-resolution-prompt.md`
- `conflict-resolution-output.md`
- `conflict-resolution-result.json`
