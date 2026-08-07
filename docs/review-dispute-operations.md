# Review Dispute — Operations and Rollout

Status: **implemented, default-off** (issue #849).

This document is **publicly exportable**, not private-only: it describes
protocol operation and command shape and never contains repository content,
local paths, secrets, or live webhook/token values (see
`copybara/copy.bara.sky`).

This is the operator's document. [review-dispute-contract.md](review-dispute-contract.md)
is the authority on *what the protocol is* — the states, the transition table,
the caps, the fail-closed rules — and nothing here redefines any of it. This
document covers only what an operator does: turning the protocol on for one
session, reading what it did, stopping it again, and recovering a task that
stopped.

One rule runs through all of it: **the protocol is gated by exactly one flag,
`session.reviewDispute.enabled`, and it defaults to `false`.** There is no
second switch, no migration, no per-task opt-in, and no cleanup step. Enabling
it changes what a review and a fix run may exchange; disabling it returns the
session to the legacy free-form flow with every audit record left where it is.

Contents:

1. [Minimal configuration](#1-minimal-configuration)
2. [Choosing independent arbiter providers](#2-choosing-independent-arbiter-providers)
3. [Session-doctor readiness](#3-session-doctor-readiness)
4. [Lifecycle states and bounded counters](#4-lifecycle-states-and-bounded-counters)
5. [Operator commands](#5-operator-commands)
6. [Metrics](#6-metrics)
7. [Public visibility versus local audit](#7-public-visibility-versus-local-audit)
8. [Expected human escalations](#8-expected-human-escalations)
9. [Disablement, in-flight recovery, and rollback](#9-disablement-in-flight-recovery-and-rollback)
10. [Known limitations](#10-known-limitations)
11. [Workflow and packaging compatibility](#11-workflow-and-packaging-compatibility)
12. [Verification](#12-verification)

## 1. Minimal configuration

The smallest `sessions.json` entry that enables the protocol adds one block to
a session that already works:

```json
{
  "sessionId": "my-session",
  "defaults": { "implementationAgent": "codex", "reviewAgent": "codex" },
  "reviewDispute": {
    "enabled": true,
    "arbiter": { "providers": ["claude"] }
  }
}
```

That is the whole configuration. Every other field of `reviewDispute` is
optional and every one has a contract default:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | The only gate. Omitted behaves exactly like `false`. |
| `arbiter.providers` | `[]` | Ordered candidate agent ids (§8.3). Empty means every arbitration escalates. |
| `arbiter.allowSameProvider` | `false` | Whether a candidate sharing a provider with a party may arbitrate at all. |
| `arbiter.minConfidence` | `0.7` | Below this, a decisive verdict decides nothing (§7 row 18). |
| `limits.*` | The §6.1 maxima | Per-lineage caps. A session may only **lower** them. |

The `limits` block is the one place where a well-meant edit can stop the
session from loading, and that is deliberate (§6.1): four of the six limits
reject `0`, because at zero the protocol would have a state with no next
action. `maxReconsiderationsPerLineage` and `maxEvidenceRoundsPerLineage` may
be set to `0` — each has an explicit fallback row — and doing so is a
legitimate way to run a narrower debate:

```json
"reviewDispute": {
  "enabled": true,
  "arbiter": { "providers": ["claude", "gemini"] },
  "limits": { "maxReconsiderationsPerLineage": 0 }
}
```

With that, a dispute skips the reviewer's reconsideration entirely and goes
straight to arbitration (§7 row 25).

**Default-off is genuinely legacy.** A session with no `reviewDispute` key and
a session with `"enabled": false` resolve to the same settings, and a run under
either one records no protocol state, appends no `review.dispute.transition`
event, and posts no §11 comment. Nothing needs to be removed to keep a session
on the old behavior.

## 2. Choosing independent arbiter providers

§8.3 requires the arbiter to be *independent*: a candidate that shares a
provider with the implementer or the reviewer is refused, because an agent
from the same family adjudicating its own house is not a third opinion.

Practically:

- **List candidates in preference order.** Resolution stops at the first
  acceptable one; the rest are fallbacks.
- **Pick a provider neither party uses.** With `implementationAgent` and
  `reviewAgent` both on one provider, a single candidate from a different
  provider is enough. With the two roles already split across providers, the
  candidate has to be a third.
- **`allowSameProvider: true` is a narrower escape hatch than it looks.** It
  permits a same-provider candidate only when its *model* is provably
  different from both parties' — and a session-level check cannot prove that,
  because the parties' models are only known once their runs exist. Expect
  `session-doctor` to report `same-provider-model-unknown` for it; that is not
  a misconfiguration.
- **No acceptable candidate is a real setting, not a failure to configure.**
  Every arbitration then escalates to a human (§7 row 19). If that is what you
  want, leave `providers` empty knowingly — but read §8 below first, because
  it changes how much of the protocol actually runs.

## 3. Session-doctor readiness

`admin session-doctor --session-id <id>` reports three arbiter checks for an
**enabled** session, and none at all for a disabled one — with the protocol
off, an unconfigured arbiter is not a finding.

| Check | Passes when | Fails with |
| --- | --- | --- |
| `arbiterConfig` | `reviewDispute` resolves and names at least one candidate | the config error, or `providers is empty` and the row-19 consequence |
| `arbiterCandidates` | no candidate is *unusable* (missing CLI, unsupported role, invalid profile) | `<agent>[<i>]: <reason>` per unusable candidate |
| `arbiterSelection` | one candidate is acceptable against both parties | `No acceptable independent arbiter for …` plus the two remedies |

The role checks are the same ones every session gets: `implementationAgentCli`
and `reviewAgentCli` appear **only when the role is unusable**, so their
absence is the pass. When either role is unusable the two candidate checks are
*skipped* rather than failed, and say so — §8.3 measures a candidate against
the two parties, so with a party missing there is no question to answer. Fix
the role first.

The remediation to read closely is `arbiterSelection`'s failure. It states the
consequence — *every arbitration would escalate to a human (contract §8.3, §7
row 19)* — and the only two things that change it: add a candidate whose
provider differs from both parties, or set
`reviewDispute.arbiter.allowSameProvider` to `true` with a candidate whose
model is provably different from both.

Doctor never spawns an agent CLI more than once per binary, and the arbiter
checks re-use the probes the role checks already ran. Running it is read-only
and resolves no task.

## 4. Lifecycle states and bounded counters

The normative table is §7 of the contract. The operator's summary:

```
open ──dispute──> disputed ──withdraw──> resolved_withdrawn
  │                   │
  │                   ├──uphold───────> arbitration_pending ──reviewer_correct──> binding ──fixed──> resolved_fixed
  │                   │                        │                                            └─blocked─> escalated_human
  │                   │                        ├──implementer_correct──> resolved_overruled
  │                   │                        ├──insufficient_evidence──> evidence_requested ──> arbitration_pending
  │                   │                        └──spec_ambiguous / low confidence / no arbiter / malformed cap ──> escalated_human
  │                   └──revise (material)───> open @ v2 ──fixed──> resolved_fixed
  │                   └──revise (non-material / ambiguous)──> arbitration_pending
  ├──fixed──> resolved_fixed
  └──blocked──> escalated_human
```

Five counters bound it, per lineage. `admin dispute status` prints all five
for every lineage, and none of them is ever clamped — a decision that would
exceed a cap is refused, not silently trimmed.

| Counter | Default cap | Spent by |
| --- | --- | --- |
| `rebuttals` | 1 per version | an admitted `review_disputed` |
| `reconsiderations` | 1 per lineage | the reviewer's `withdraw`/`uphold`/`revise` |
| `arbitrationPasses` | 2 per lineage | an arbiter that answered (rows 13–18) |
| `malformedArbiterAttempts` | 2 per lineage | an arbiter answer that could not be admitted |
| `evidenceRoundsUsed` | 1 per lineage | a bounded evidence round that was collected |

A lineage also carries at most two versions, so there is at most one material
revision and one final implementation response after it.

## 5. Operator commands

Three, all session-scoped through the shared `--session-id` / `--session-ref`
selector, all human-readable by default with `--json` for the stable payload.

### `admin dispute status --session-id <id> --issue-number <n>`

Read-only. Every structured lineage with its version, state, terminal outcome,
severity, repository-relative boundary and five counters; the task-level
`pendingReReview` / `resolvedWithoutChanges` flags; the §7.1 routing intent of
the last transition; and **the one supported next action, or an explicit
statement that no automated action is authorized with the exact stop reason**.

It reads persisted task context and bounded task events only. Arbiter
reasoning, confidence and evidence content are not persisted state and are
never shown. A task with no `reviewDispute` block says so and exits cleanly.

The same projection backs `admin task-status --verbose` and the admin UI's
task detail, so the three surfaces cannot disagree.

### `admin dispute reopen --session-id <id> --issue-number <n> --lineage-id <id> --version <n>`

The **only** operator-initiated transition the contract defines: it records
§6.4's `reopen_requested` flag on a **terminal** lineage and parks the task at
`ready_for_human` under §7.1 rule 1.

It does not overturn the resolution, does not change the lineage's state
(terminal states are immutable audit records), resets no counter, bypasses no
cap, and posts no public comment. It requires the lineage's *current* version,
so a stale command cannot flag a finding that has since been revised. Previews
by default; `--yes` applies. A request already on file is an informative no-op.

### `admin dispute metrics --session-id <id>`

See [§6](#6-metrics).

## 6. Metrics

```sh
node dist/cli/admin.js dispute metrics --session-ref 1
node dist/cli/admin.js dispute metrics --session-ref 1 --json
node dist/cli/admin.js dispute metrics --session-ref 1 --issue-number 302
node dist/cli/admin.js dispute metrics --session-ref 1 --since 2026-08-01T00:00:00Z
```

Everything the report prints is derived from the persisted
`review.dispute.transition` task events and their bounded data (§10.3). It
opens no §10.2 artifact, reads no public comment, makes no GitHub or network
call, and mutates nothing. `--since`/`--until` are inclusive ISO-8601 **UTC**
bounds on the event's `createdAt`; an offset form, a date-only form, and a
well-formed but impossible calendar date such as `2026-02-31T00:00:00Z` are all
refused rather than reinterpreted, and neither flag needs a schema change.

A session-wide run reads the session's `review.dispute.transition` events in one
query rather than one query per task, so the report stays a cheap read on a
session with many tasks and a long event history.

What it counts:

| Field | Derived from |
| --- | --- |
| `findingsOpened` | `dispute.finding.opened` |
| `rebuttalsRecorded` | the `rebuttals` counter each transition moved |
| `rebuttalsRejected` | `dispute.rebuttal.rejected` |
| `reconsiderations` | the `reconsiderations` counter |
| `revisions.material` / `.nonMaterial` / `.ambiguous` | the three `dispute.revision.*` literals |
| `arbitration.verdicts` | the `arbitrationPasses` counter — one per arbiter that answered |
| `arbitration.malformedAttempts` | the `malformedArbiterAttempts` counter |
| `evidence.requested` / `.recorded` | row 16's reason, and the `evidenceRoundsUsed` counter |
| `terminalOutcomes.*` | the terminal state each transition wrote, by literal |
| `humanEscalations` | `dispute.escalated.human` |
| `reopenRequests` | `dispute.reopen.requested` |

The counters with a §6.1 bound are read from the **counter deltas**, not from
the audit-event literals, on purpose: a human-gated dispute spends its rebuttal
slot while reporting `dispute.escalated.human`, and a `withdraw` spends its
reconsideration while reporting `dispute.resolved`. Counting literals would
undercount exactly the cases an operator cares about. The full audit-event
tallies are still reported, under `auditEvents`, alongside `decisionKinds` and
`reasons`.

**`lineagesResolvedWithoutHuman` is an observable proxy, not a saving.** Its
definition: *lineages observed reaching a terminal state other than
`escalated_human` within the window read, and never observed escalating or
carrying a §6.4 reopen request in that window.* It says nothing about what
would have happened without the protocol, and this repository deliberately
does not report a "review loops prevented" figure, because no such number is
measurable from these events. `tasksResolvedWithoutHuman` applies the same
definition at task level: at least one lineage went terminal and none of the
task's lineages escalated or was reopened.

The report is deterministic and safe to run twice. Transitions are counted once
per transition key and an entry the protocol already marked `replayed` is never
counted, so a retried worker, a duplicate decision delivery, an outbox replay,
or a re-read after a process restart all produce identical numbers.
`transitionsDeduplicated` reports how many re-deliveries were discarded, rather
than dropping the fact silently.

Metrics are for observation. They are not a quality gate and nothing in the
runner reads them.

## 7. Public visibility versus local audit

§11 is strict about the split, and it is worth restating for whoever is going
to read the pull request:

**Public** (one comment, on the PR when there is one, otherwise on the work
item, and only when a lineage *resolves* or *escalates*): the lineage id, the
finding's severity, its admission-normalized repository-relative
`affectedBoundary`, the outcome literal, and counts. `binding` is not a
resolution and gets no comment of its own. Intermediate states create no public
noise at all.

**Never public**: rebuttal or rationale prose, arbiter reasoning, evidence
content or quoted file lines, local filesystem paths, raw agent output,
session/run/task identifiers, and provider error text.

**Local only** (§10.2 artifacts, under the session's artifact directory): the
prompts, the raw agent transcripts, the arbitration bundle and its manifest,
and the evidence excerpts. None of the admin commands above open them, and
`dispute metrics` deliberately does not scan them.

## 8. Expected human escalations

These are the protocol working, not the protocol failing. Each one stops the
task at `ready_for_human` with a stop reason `admin dispute status` prints
verbatim.

| Situation | Contract | What an operator does |
| --- | --- | --- |
| A `humanGate` finding is disputed | §9, rows 3/7 | Decide on the PR. The gate exists because automation was never authorized here. |
| The implementer reports `blocked` | rows 4/8/24 | Supply what automation cannot (a credential, a decision) and re-run. |
| `spec_ambiguous` | row 15 | The Issue itself does not decide the disagreement. Amend the Issue, not the lineage. |
| A decisive verdict below `minConfidence` | row 18 | The arbiter was not sure enough. Decide on the PR. |
| No acceptable independent arbiter | row 19 | Configure one (see §2) — then the *next* dispute arbitrates; this one stays escalated. |
| The malformed-arbiter cap is reached | row 21 | The arbiter could not produce an admissible verdict twice. Decide on the PR. |
| Evidence still insufficient with the round spent | row 17 | Decide on the PR. |
| A §7.1 turn this runner cannot dispatch | §15 G2 | See below — this one is a gap, not an escalation. |

The last row is different and should not be mistaken for the others. §7.1's
**reviewer**, **evidence**, and **runner** turns name runs that this codebase
does not dispatch yet, so instead of queueing the task into a handler that
could not discharge it, the runner parks it for a human with the lineage
untouched. `admin dispute status` reports it as
`next action: none (undispatched_turn)` with the turn named, rather than as a
lineage escalation. Until those dispatchers exist, continuing such a task is an
operator action: `admin recover --session-id <id> --issue-number <n> --from
ready_for_human --phase <phase>`.

## 9. Disablement, in-flight recovery, and rollback

Three different operations, deliberately kept apart.

### 9.1 Disabling the feature (safe, reversible, no cleanup)

Set `"enabled": false` — or remove the `reviewDispute` block — and the session
returns to the legacy free-form review flow on its next run. That is the whole
rollback. Specifically:

- every persisted `task.context.reviewDispute` block is **left exactly as it
  is**: not deleted, not migrated, not summarized;
- every `review.dispute.transition` event already recorded stays recorded;
- legacy `reviewFeedback` alongside a block is untouched, and a disabled run
  reads it exactly as it always did;
- a terminal lineage is byte-identical across a disable/re-enable round trip —
  §6.4 makes terminal states immutable audit records, and nothing in the
  disable path writes to them;
- no §11 comment is posted for a disabled session, including for history that
  a previously-enabled session recorded.

`admin dispute status` and `admin dispute metrics` still read a disabled
session's history. It is inert, not hidden.

### 9.2 Recovering an in-flight task

A task the protocol parked is recovered with the ordinary handoff command, not
with a protocol command and never with a direct SQLite edit:

```sh
node dist/cli/admin.js dispute status --session-ref 1 --issue-number 302   # read the stop reason first
node dist/cli/admin.js recover --session-ref 1 --issue-number 302 \
  --from ready_for_human --phase implementation
```

Recovery is a *task* transition. It moves status and phase and leaves the §10.1
block exactly where the protocol left it, so a `disputed` lineage is still
`disputed` afterwards.

### 9.3 `admin dispute reopen` is not rollback

It is a §6.4 request against one **resolved** lineage. It does not undo a
resolution and it is not how a session is turned off. While the protocol is
disabled the command **refuses outright**, before opening the store, and points
at `admin recover` for an ordinary handoff — writing a request that a disabled
session could never act on, and that §11 would never publish, would create
state that is both unreachable and invisible.

## 10. Known limitations

Recorded here and specified in §15 of the contract, not worked around locally:

- **G1 — an `escalated_human` lineage has no way back into automation.** The
  contract defines no transition that consumes a human verdict: no row, no
  persisted field, no audit event. So there is no command that resolves an
  escalated lineage, and operator tooling reports "no automated action is
  authorized" rather than offering one. The human decides on the pull request
  itself, and the lineage stays `escalated_human` as the record of how the
  debate got there. Adding a continuation means adding the row, the field, and
  the event to the contract first.
- **G2 — the reviewer, evidence, and runner turns have no dispatcher.** See §8.
  The gap closes by implementing those runs, not by adding an operator
  transition; requeueing such a task into an ordinary review would hand an open
  lineage to a run that cannot discharge it.

## 11. Workflow and packaging compatibility

**No n8n change is required to run the protocol, and none was made.**

The parent/child workflows
([parent-child-workflow.md](parent-child-workflow.md)) invoke a fixed, small
set of CLI surfaces — `admin context create`, `admin repo-lock
acquire`/`release`, `github-intake`, `run-one-phase` and `dispatch-outbox` —
and every one of them keeps its existing arguments and its existing JSON stdout
contract. The whole
protocol lives inside the phase a `run-one-phase` invocation already runs: the
lineage state is carried in the task's own context, the audit events are
ordinary task events, and the §11 comment is an ordinary outbox row that
`dispatch-outbox` delivers like any other. A workflow therefore carries an
enabled session without knowing the protocol exists, which is the property to
preserve — protocol logic in a workflow node would be a second place for the
transition table to live.

The same holds for the private-node packaging: the node wraps those same CLI
invocations and needed no new operation.

If a future change *does* require a CLI contract change, edit
`scripts/build-parent-child-workflow.mjs` and re-run
`npm run build:parent-child-workflow`. Never hand-edit the generated JSON under
`docs/` — `test/build-parent-child-workflow.test.js` compares the checked-in
files against the generator's output and fails on any drift.

## 12. Verification

`npm test` runs all of the following:

- `test/review-dispute-e2e.test.js` — whole lifecycles through the real phase
  runner, task store, outbox and admin projections, on both TaskStore
  implementations, plus the SQLite-only publication, restart, maintenance-lock
  and CLI cases.
- `test/review-dispute-rollout.test.js` — default-off behavior, audit-trail
  preservation across disable/re-enable, and the recovery-versus-reopen split
  of §9.
- `test/review-dispute-metrics.test.js` — the pure aggregation, its closed
  shape, its idempotence, and the proxy's definition.
- `test/admin-dispute-metrics.test.js` — the `dispute metrics` CLI contract in
  both output modes.
- `test/admin-dispute.test.js` — `dispute status` / `dispute reopen`.
- `test/admin-cli.test.js` — the session-doctor arbiter and role checks.
- `test/docs-review-dispute-operations.test.js` — this document, structurally.

No test in that list runs a paid agent, calls GitHub or Slack, touches the
network, or edits SQLite by hand.
