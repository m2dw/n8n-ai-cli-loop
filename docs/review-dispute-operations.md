# Review Dispute — Operations and Rollout

Status: **config-gated, default-off** (issues #849, #965). Every automated §7.1
turn now dispatches inside the `review` phase, so an enabled session completes a
dispute without a manual database edit or an operator recovery command; see
[feature-status.md](feature-status.md#review-dispute) for the matrix row.

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
13. [Predecessor integration evidence and the optional real-CLI smoke check](#13-predecessor-integration-evidence-and-the-optional-real-cli-smoke-check)

## 1. Minimal configuration

The smallest `sessions.json` entry that enables the protocol adds one block to
a session that already works:

```json
{
  "sessionId": "my-session",
  "defaults": { "implementationAgent": "claude", "reviewAgent": "claude" },
  "reviewDispute": {
    "enabled": true,
    "arbiter": { "providers": ["claude"] }
  }
}
```

That is the whole configuration. The agent ids are not incidental and are not a
recommendation of one vendor: §1.1 explains which roles this runner can actually
execute. With today's capability table the reviewer has to be `claude` for a
debate to happen under the §8.2 posture — which then leaves the arbiter with no
independent candidate, so arbitration escalates to a human. A `codex` reviewer can
debate only if you additionally opt into the weaker `read-bounded` posture
(`reconsideration.readBounded`, below), and that is a decision about what a
verdict may be based on, not a default. Read §1.1 before enabling the flag, so the
first escalated dispute is the documented outcome rather than a surprise.

Every other field of `reviewDispute` is optional and every one has a contract
default:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | The only gate. Omitted behaves exactly like `false`. |
| `arbiter.providers` | `[]` | Ordered candidate agent ids (§8.3). Empty means every arbitration escalates. |
| `arbiter.allowSameProvider` | `false` | Whether a candidate sharing a provider with a party may arbitrate at all. |
| `arbiter.minConfidence` | `0.7` | Below this, a decisive verdict decides nothing (§7 row 18). |
| `limits.*` | The §6.1 maxima | Per-lineage caps. A session may only **lower** them. |
| `reconsideration.readBounded` | `false` | Admit the weaker `read-bounded` posture for the reviewer's §4.1 turn, for an agent that has no `no-tools` invocation (today `codex`). Contract decision D2 (§17.6, §17.16). Reads outside the runner's bundle are **not** bounded under it — see §1.1 and §13.3 before setting it. |

The `limits` block is the one place where a well-meant edit can stop the
session from loading, and that is deliberate (§6.1): four of the six limits
reject `0`, because at zero the protocol would have a state with no next
action. `maxReconsiderationsPerLineage` and `maxEvidenceRoundsPerLineage` may
be set to `0` — each has an explicit fallback row — and doing so is a
legitimate way to run a narrower debate:

```json
"reviewDispute": {
  "enabled": true,
  "arbiter": { "providers": ["claude"] },
  "limits": { "maxReconsiderationsPerLineage": 0 }
}
```

With that, a dispute skips the reviewer's reconsideration entirely and goes
straight to arbitration (§7 row 25).

A `reviewDispute` block that does not resolve **fails the run**, in the `review`
phase and in the `implementation` phase alike, before either invokes its agent.
It is never read as "protocol disabled": degrading to the legacy path would let
an invalid limit hand back a clean review, and degrading to the contract's own
maxima would let a session that meant to *lower* a limit silently run at the
default. Both stop with the same diagnostic, naming the configuration paths that
failed. (Session load rejects such a block too, so in practice this is reached
only by a hand-built session object.)

**Default-off is genuinely legacy.** A session with no `reviewDispute` key and
a session with `"enabled": false` resolve to the same settings, and a run under
either one records no protocol state, appends no `review.dispute.transition`
event, and posts no §11 comment. Nothing needs to be removed to keep a session
on the old behavior.

### 1.1 Provider prerequisites

Three roles have to be runnable before an enabled session can complete a debate,
and they fail closed rather than silently substituting one another:

| Role | Resolved from | Requirement |
| --- | --- | --- |
| Implementation | `defaults.implementationAgent` (or the task's agent label) | An agent whose fix prompt is runner-authored, so it can be given the §3.1 disposition contract. A reviewer this runner cannot author a prompt for is never *asked* for structured findings, and a session whose reviewer is one of those runs the legacy prose path with no lineages at all — see §13 of the contract. `codex` is no longer such a reviewer with the flag on: contract §17.11 routes it through `codex exec`, whose prompt this runner writes (§1.1 below). |
| Review | `defaults.reviewAgent` (or the task's agent label) | The same agent answers the reconsideration sub-turn, with **no tool surface**. An agent with no no-tools invocation fails closed as `profile_unavailable` instead of reconsidering under another provider — unless the session opted into the weaker `read-bounded` posture for an agent that has one (`reviewDispute.reconsideration.readBounded`, default false; contract §17.6 D2, §17.16, and the Codex paragraphs below). |
| Arbiter | `reviewDispute.arbiter.providers`, in order | Two tests, in this order: the runner must have a **verified no-tools invocation** for the candidate (§8.2), and the candidate must be **independent** of both parties (§8.3). See §2. |

**Codex specifically, since it is the other CLI most sessions already run.**
A session with `reviewAgent: "codex"` is a supported, working configuration, and
what it runs depends on the flag:

- **Flag off** — the legacy prose review, `codex review`, with no lineages and
  therefore no dispute. Unchanged, byte for byte, from before the protocol
  existed.
- **Flag on** — the runner-authored `codex exec` lane (contract §17.11). The
  reviewer is given the review brief and the PR diff as a prompt this runner
  wrote, is asked for the §2.1 finding envelope like any other reviewer, and its
  findings open lineages and drive the fix loop normally. Nothing about this is
  configurable and there is no separate switch: enabling the protocol selects it.

A Codex reviewer can now also take the **reconsideration** turn, but only under a
weaker, separately named execution posture and only if you turn it on. This is
contract decision **D2** (§17.6), recorded by an operator on 2026-09-07 and
implemented as §17.16. It is off by default and it is not implied by
`enabled`:

```jsonc
"reviewDispute": {
  "enabled": true,
  "reconsideration": { "readBounded": true }   // default false
}
```

**What you are accepting by setting it, stated as the contract states it.** The
`read-bounded` posture refuses writes, network and operator agent configuration
for the reviewer's turn, runs it in a throwaway directory that is not your
checkout, strips every GitHub credential, and enforces the runner's ten-minute
deadline. It does **not** bound reads: the agent may read files outside the
runner-supplied bundle under the host's own permissions, so §8.2's "the bundle is
the entire input" does not hold for a finding decided under it. A temporary
working directory is not a read jail, and this document will not tell you
otherwise. That is the whole of the tradeoff, and it is why the posture has its
own name: every lineage decided under it records `read-bounded` permanently, in
its §10.2 record and in `admin dispute status`, so it is never afterwards
confused with one decided under the §8.2 posture.

**Rolling it back.** Set `readBounded` to `false` (or remove the key). The next
review run refuses the turn again and parks at `ready_for_human` exactly as
before, with the debate byte-identical and no counter spent. Nothing already
recorded is rewritten: a lineage decided under `read-bounded` keeps that label,
which is the point of having it.

What a Codex reviewer still cannot do is take the **arbitration** turn, with or
without that opt-in. D2 was approved for the reviewer's reconsideration and
nothing else, so the arbiter candidate resolver still refuses `codex`
(`unsupported-role`) — it is not a bug to report and not fixed by configuration.
With a Claude implementer and a Codex reviewer, an **upheld** dispute therefore
still escalates to a human rather than reaching an arbiter — see §10. A withdrawal
or a revision now resolves without one.

**Leaving it off is a supported configuration, not a degraded one.** Issue #1070
was the milestone that would have given the Codex reviewer its reconsideration
turn while D2 was unrecorded, and it stopped rather than shipping the turn under a
weaker boundary; contract §17.12 records the stop, the three shortcuts it
refused, and the ordered steps that led to §17.16. §17.8's on-host smoke check has
still not been run and C7 is still `unknown`, which is exactly why what shipped is
`read-bounded` and not a second `no-tools` invocation. An operator who does not
want unbounded reads in a verdict should leave the opt-in off and take the human
handoff, which is a decision this document supports rather than a state to escape.

Two things follow that are worth stating plainly. First, a Codex review that
runs on this lane and does **not** produce a valid envelope never passes cleanly:
it escalates to a human. Second, a diff too large for the prompt is truncated,
and a clean verdict over a truncated diff also escalates rather than promoting to
`ready_for_human` — the reviewer only saw part of the change.

Nothing probes the CLIs before a review — spawning one subprocess per candidate
ahead of every review would be a real cost for a rare path — so an absent CLI
surfaces as an operational failure that parks the task with no counter spent,
never as a lineage escalation this host cannot justify. `admin session-doctor`
(§3) is where a configuration is checked ahead of time.

**Today only `claude` has a verified no-tools invocation**, in all three lanes:
the reviewer's reconsideration, the arbiter's, and the evidence round's per-party
runs. §8.2 makes the runner the enforcement point of that boundary, so an agent
whose read-only invocation this repository has not verified is not usable for
those turns however independent its provider is — `admin session-doctor` reports
it as `arbiterCandidates: <agent>[<i>]: unsupported-role`, and at runtime it is
one of the candidates row 19 escalates past.

The `read-bounded` opt-in above does not change that sentence and is not an
exception to it: it admits a **different**, weaker posture for **one** turn, and
only where an operator recorded the decision. There is still exactly one agent
with a verified no-tools invocation, and the arbiter and evidence lanes still
require that one.

That has a consequence worth knowing before enabling the flag, because it is not
a misconfiguration you can correct: with both parties on Anthropic — which they
must be for their own turns to run — **no arbiter candidate is acceptable**, so
every upheld dispute escalates to a human (§7 row 19) instead of being
adjudicated. `allowSameProvider` does not rescue it either: a party recovered
from task context carries an agent id with no model (see §2), and an unknown
model is not proof of difference. Enabling the protocol is still worth it in that
mode — a rebuttal is recorded, the reviewer reconsiders it, and a withdrawal or a
revision resolves the lineage without a human — but arbitration itself lands on
the pull request. Widening it means adding a verified no-tools invocation for
another CLI, which is a change to this runner, not to a session.

### 1.2 What the protocol runs on its own

With the flag on, these turns happen inside ordinary phase runs. None of them is
a new public phase, and none needs an operator:

| Turn | Runs in | What it does |
| --- | --- | --- |
| Fix disposition | `implementation` | The fix agent answers each open finding: `fixed`, `review_disputed`, or `blocked` (§3.1). An admitted dispute records the rebuttal and moves the lineage to `disputed`. |
| Reviewer reconsideration | `review` (sub-turn) | The original reviewer answers the rebuttal: withdraw, uphold, or revise (§7 rows 9–12). |
| Runner arbitration | `review` (sub-turn) | An independent arbiter decides an upheld dispute (§7 rows 13–21). |
| Evidence collection | `review` (sub-turn) | One bounded round, **one party per phase run**, when the arbiter answered `insufficient_evidence` (§7 rows 16, 22). Both answers then re-present the same arbitration with the evidence attached. |

A review run that takes one of these sub-turns never builds an ordinary review
prompt and never invokes the review agent, so a `disputed` or
`arbitration_pending` lineage cannot be discharged by a run that was not asked
about it.

## 2. Choosing independent arbiter providers

§8.3 requires the arbiter to be *independent*: a candidate that shares a
provider with the implementer or the reviewer is refused, because an agent
from the same family adjudicating its own house is not a third opinion.

Practically:

- **List candidates in preference order.** Resolution stops at the first
  acceptable one; the rest are fallbacks.
- **Pick a provider neither party uses — that this runner can invoke.**
  Independence is the second test, not the first: a candidate the runner has no
  verified no-tools invocation for (§1.1) never reaches it. With
  `implementationAgent` and `reviewAgent` both on one provider, a single
  candidate from a different provider would be enough; with the two roles split
  across providers, the candidate has to be a third. Both readings are subject
  to §1.1's capability list, which today holds `claude` alone — so with the
  Anthropic parties the other two turns require, the two tests have no common
  answer and arbitration escalates. That is a limitation of this runner, and the
  reason `admin session-doctor` reports `arbiterCandidates` and
  `arbiterSelection` as two separate checks.
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

`admin session-doctor --session-id <id>` reports four checks that only matter
for the review-dispute protocol — one about the reviewer, three about the
arbiter — for an **enabled** session, and none of the four for a disabled one:
with the protocol off, an unconfigured arbiter and an unverified reconsideration
posture are both not findings.

| Check | Passes when | Fails with |
| --- | --- | --- |
| `reviewerReconsiderationCapability` | `reviewAgent` has a verified §8.2 no-tools invocation, **or** has a `read-bounded` invocation and this session opted into it | `Unsupported reconsideration agent: <agent>`, naming the B2 blocker, the D2 decision, the exact setting that would admit it, and the human-handoff behavior (contract §15 G2) — never `arbiterSelection`'s row-19 wording |
| `arbiterConfig` | `reviewDispute` resolves and names at least one candidate | the config error, or `providers is empty` and the row-19 consequence |
| `arbiterCandidates` | no candidate is *unusable* (missing CLI, unsupported role, invalid profile) | `<agent>[<i>]: <reason>` per unusable candidate |
| `arbiterSelection` | one candidate is acceptable against both parties | `No acceptable independent arbiter for …` plus the two remedies |

**`reviewerReconsiderationCapability` answers a different question than the
three arbiter checks, and issue #1073 is the reason it is a separate check
rather than folded into them.** It reports whether the configured
`reviewAgent` can take the §4.1 reconsideration turn at all — a property of
that one agent id and this session's §17.6 D2 opt-in — which has nothing to do
with whether an independent arbiter is configured. `claude` passes it
unconditionally, under the `no-tools` posture (§1.1, §17.12). A Codex reviewer
fails it in a session that has not set
`reviewDispute.reconsideration.readBounded`, even though it passes
`reviewAgentCli` — that check only says the structured review lane (D1,
§17.11) is supported, and being able to *raise* a finding is not being able to
*reconsider* one. With the opt-in set it passes, and the check says under which
posture: **the detail line names `read-bounded` explicitly**, states that reads
outside the bundle were not bounded, and tells you the one setting that reverses
it. Read that line as the answer to "which boundary is deciding my findings", not
just as a green check. A session can therefore see any of the four combinations:
`reviewerReconsiderationCapability: true` with `arbiterSelection: false` (a
Claude/Claude pairing — rebuttal, reconsideration, withdrawal and revision all
still resolve without a human; only an upheld dispute needs one, §7 row 19) is
the common case documented in §1.1, and it must never be read from these
checks as "the dispute path does not work" — only arbitration does not. The
reverse, `reviewerReconsiderationCapability: false`, is the one combination
that IS a capability gap for that reviewer: a Codex-raised finding that gets
disputed parks at `ready_for_human` as an undispatched turn (contract §15 G2)
before it ever reaches arbitration, which is a different stop than
`arbiterSelection`'s and is reported with different wording precisely so the
two are never conflated. Since issue #1085 that combination is a **choice** for a
Codex reviewer rather than a dead end — the failure names the opt-in that would
admit the turn and what accepting it costs — and leaving it as it is remains a
supported answer. See §10 for what an operator does about each.

The role checks are the same ones every session gets: `implementationAgentCli`
and `reviewAgentCli` appear **only when the role is unusable**, so their
absence is the pass. When the review role is unusable,
`reviewerReconsiderationCapability` is skipped the same way and says so. When
either role is unusable the two candidate checks are *skipped* rather than
failed, and say so — §8.3 measures a candidate against the two parties, so
with a party missing there is no question to answer. Fix the role first.

The remediation to read closely is `arbiterSelection`'s failure. It states the
consequence — *every arbitration would escalate to a human (contract §8.3, §7
row 19)* — and the only two things that change it: add a candidate whose
provider differs from both parties, or set
`reviewDispute.arbiter.allowSameProvider` to `true` with a candidate whose
model is provably different from both.

When a candidate was refused as `unsupported-role`, the same finding adds the
reason neither remedy would have helped: §8.2's verified-no-tools requirement is
checked *before* independence is, and the invocation is defined for `claude`
only (§1.1). That case is not fixed by configuration — it is fixed by adding a
verified invocation to this runner, or accepted as a session that arbitrates
through row 19. The note appears only for that rejection reason, so a candidate
refused purely for sharing a provider still reads as the configuration problem
it is.

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

When a bounded evidence round is open or spent, it also prints that round's
progress — the one stall §10.1 cannot show, since a lineage waiting for its
second party and a lineage waiting for anything else look identical in the
block:

```
evidence round 1: implementer=completed(1)@0 reviewer=recoverable(0)@1 [invocation_failed]  recorded=1
```

Per party (`implementer`, then `reviewer`): its state
(`not_started` / `running` / `recoverable` / `completed` / `unreadable`), the
count of admitted attachments, the attempt number, and — for a run that stopped
`recoverable` — the bounded reason token for why. The trailer carries the total
attachments recorded, plus `complete` once both parties answered and
`rowApplied` once §7 row 22 has consumed the round. `--json` adds the reference,
dropped and artifact **counts** for each party. That is what tells an operator
which party a partial round is still owed, and whether the last attempt stopped
for a reason a rerun would hit again.

It reads persisted task context and bounded task events only. Arbiter
reasoning, confidence and evidence content are not persisted state and are
never shown; neither are the evidence references themselves, their paths, their
quote digests, or any artifact name — an operator surface is a publication
surface (§11), and only counts, literals and version numbers cross it. A task
with no `reviewDispute` block says so and exits cleanly.

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
| A §7.1 turn this runtime could not run | §15 G2 | See below — this one is a stop, not an escalation. |

The last row is different and should not be mistaken for the others. Every §7.1
turn has a dispatcher (the reviewer's since issue #952, the runner's since #955,
the evidence round's since #964), so this is no longer the ordinary outcome of a
dispute — it is the **fail-closed stop** for a run that could not answer a turn
it was asked to take: a §10.2 record that cannot be located in this checkout, a
verdict record that names a version the lineage has left, a persisted round
record that cannot be read, or a party whose agent identity this runner cannot
name. Rather than queueing the task into a run that could not discharge the
lineage, the runner parks it for a human with the debate state untouched, and
`admin dispute status` reports it as `next action: none (undispatched_turn)`
with the turn named rather than as a lineage escalation.

Continuing such a task is an operator action, and one worth reading the stop
reason for first — the same park will repeat if the missing record is still
missing: `admin recover --session-id <id> --issue-number <n> --from
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

**Rolling back the `read-bounded` reconsideration opt-in alone** is the narrower
move and does not require disabling the protocol: set
`reviewDispute.reconsideration.readBounded` to `false`, or remove the
`reconsideration` block. From the next run, a reviewer that had no `no-tools`
invocation is refused again and its turn parks at `ready_for_human` with the
debate untouched — the §17.12 behavior, unchanged. Nothing recorded is rewritten:
a lineage already decided under `read-bounded` keeps that label in its §10.2
record and in `admin dispute status`, because the point of the separate name is
that it survives the rollback. A lineage left mid-debate is not stranded either —
it parks, exactly as it would have before the opt-in was ever set.

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
- **G2 — no operator continuation for the undispatched-turn park.** See §8.
  Every §7.1 turn now has a dispatcher — the reviewer's in issue #952, the
  runner (arbitration) turn's in issue #955, the evidence round's in issue #964 —
  so this park is no longer where an ordinary dispute ends. What remains is the
  fail-closed stop for a turn this runtime could not answer, and there is still
  no protocol transition an operator can apply to it: requeueing such a task into
  an ordinary review would hand an open lineage to a run that cannot discharge
  it. The task-level `admin recover` handoff of §9.2 is the only continuation,
  and it deliberately changes no lineage.

One further limitation is not a specification gap but an open **decision**, and
it is the one that shapes what an enabled session can actually do today:

- **Only `claude` can take a dispute turn under the §8.2 posture, so a
  Claude/Codex pairing debates only as far as you have opted in.** Contract §17
  is the full record — the graded capability table, the two blockers, the
  invocation contract a Codex turn pins, and the operator smoke check that would
  settle the open capability question. The short version for an operator:

  - A Codex *reviewer* is supported, and with the flag on it runs the structured
    `codex exec` lane and opens real lineages (§1.1, contract §17.11).
  - A Codex *reconsideration* is refused **by default**, because §8.2 requires the
    runner to make the bundle the entire input and the Codex CLI has no documented
    way to remove its tool surface. Read-only sandboxing does not answer that — it
    bounds writes and network, not reads — and neither does a prompt asking the
    model to abstain. It can be admitted under the separately named, weaker
    `read-bounded` posture by setting
    `reviewDispute.reconsideration.readBounded` (§1.1, contract §17.6 D2,
    §17.16), which is a decision about accepting unbounded reads in a verdict,
    not a fix for a defect.
  - A Codex *arbitration* is refused, full stop. D2 did not admit it and no
    setting turns it on.

  So a finding a Codex reviewer raised can be fixed and can be disputed; with the
  opt-in off the dispute reaches a human instead of an arbiter, and with it on the
  reviewer answers first and only an **upheld** dispute reaches a human. Issue
  #1070 is the successor that tested the gating rule and honored it: it asked for
  the Codex reconsideration turn, found D2 unrecorded, and stopped — contract
  §17.12 records what it refused and what the next attempt needed first. Issue
  #1071 then asked for the whole round trip that ends in that turn and stopped at
  the same place, so the default-off behavior is written down as behavior
  (contract §17.13): the finding is raised, the rebuttal is recorded, and the task
  parks at `ready_for_human` with the debate untouched, no counter spent and
  nothing to re-run — `admin dispute status` reports no authorized action, and
  `admin recover` simply parks it again. One fix did land with it, and it is about
  identity rather than capability: the reconsideration is offered to the reviewer
  that RAISED the finding, read from the party each run records, so reassigning
  `reviewAgent` mid-debate can neither hand a Codex-raised dispute to a Claude
  reviewer nor block a Claude-raised one that Claude can still answer. Issue #1072
  then re-ran that same path with the agent invocations un-stubbed — fake `claude`
  and `codex` executables on `PATH`, spawned by the shipping invocations — so the
  behavior above is qualified against real processes rather than against
  in-process substitutes (contract §17.14), and issue #1085 extended that suite to
  the opted-in path. Treat the human handoff as the supported behavior of a
  Claude/Codex pairing that has not opted in, not as a gap being worked around.

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

- `test/review-dispute-qualification.test.js` — the release-qualification
  matrix: the REAL review and implementation handlers, driven through the real
  phase runner and task store with deterministic stub agents, over the gate,
  the dispute/reconsideration/arbitration/evidence turns, the human handoffs,
  duplicate delivery, operator visibility, and the disable/re-enable round trip.
  Nothing between its stages is hand-written: each run's inputs are whatever the
  previous run committed.
- `test/review-dispute-round-trip.test.js` — the same real handlers in the mixed
  Claude-implementer / Codex-reviewer configuration: the finding, the
  zero-change rebuttal, the bounded park the reviewer's turn stops at and its
  recovery, an unrelated blocking finding that stays in force, the disabled
  session's untouched debate, and which agent the reconsideration is offered to
  once `reviewAgent` has been reassigned mid-debate.
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
- `test/admin-cli.test.js` — the session-doctor arbiter, role and
  reviewer-reconsideration-capability checks (issue #1073).
- `test/docs-review-dispute-operations.test.js` — this document, structurally.
- `test/docs-review-dispute-codex-capability.test.js` — contract §17 against the
  runner's own capability tables, and this document's §1.1 and §10 statements
  about Codex against those same tables.
- `test/codex-structured-review.test.js` and
  `test/review-findings-schema.test.js` — contract §17.10's invocation adapter
  and the envelope schema it derives, driven against a subprocess fixture
  standing in for the CLI. The binary that runs is never `codex`: a test that
  resolved the real one could bill a turn.
- `test/review-codex-structured-lane.test.js` — contract §17.11's routed lane
  through the real review handler and the same fixture: the enabled session's
  `codex exec` command construction, the envelope reaching the persisted block
  and the findings artifact, re-raise and unknown-lineage handling, stale
  evidence, a failed required verification, a missing or truncated diff, the
  disabled session's unchanged `codex review`, and each invocation failure that
  must not read as a clean pass.
- `test/review-dispute-default-path-e2e.test.js` — contract §17.14's
  qualification of the same Claude-implementer / Codex-reviewer round trip
  through **production-default CLI dispatch**: no `ReviewDisputeSubTurnSeams`
  substitute, fake `claude`/`codex` executables on `PATH` under their real
  names answering from a per-scenario queue, and a disposable checkout with
  real git history. It is the evidence behind §10's "human handoff is the
  supported behavior, not a gap being worked around" — the round trip really
  does reach real CLI dispatch before parking at the D2 stop, and nothing
  about that changed by removing the in-process seam. Issue #1085 added the
  opted-in half to the same suite: with
  `reviewDispute.reconsideration.readBounded` set, the identical task reaches a
  real `codex exec` reconsideration subprocess through the same dispatch, and
  the withdrawal, the material revision and the upheld-with-no-arbiter handoff
  are each driven to completion — with the default-off refusal pinned on the
  same task so the opt-in is what makes the difference.
- `test/review-reconsideration-read-bounded.test.js` — contract §17.16 at the
  invocation layer: the opt-in that admits the posture and the default that does
  not, the argv it pins and the bypass flags that must never appear in it, the
  `--output-last-message` handshake and each way it can fail (missing, stale,
  oversized, refused flag, deadline), the isolation the run actually gets
  (throwaway cwd that is not the checkout, throwaway `HOME`, no GitHub
  credential, `CODEX_HOME` at the real config dir), and the posture literal
  travelling into the §10.2 record without ever becoming `no-tools`.

No test in that list runs a paid agent, calls GitHub or Slack, touches the
network, or edits SQLite by hand. The one check that would spawn a real Codex
CLI is contract §17.8, and it is deliberately an operator procedure rather than
a test, in the same shape as
[agent-isolation-policy.md](agent-isolation-policy.md) §4.

## 13. Predecessor integration evidence and the optional real-CLI smoke check

This section exists so that "the Claude/Codex path is tested" is answered with
the specific tests that back it and their specific limits, rather than with a
general impression. Nothing here is a new capability or a new switch.

### 13.1 What is already qualified, in-repository, without a live CLI call

The Claude-implementer / Codex-reviewer round trip is qualified end to end by
the chain of issues #1067–#1072, each recorded in contract §17.11–§17.14. In
order of what each one added:

| Issue | What it qualified | Evidence |
| --- | --- | --- |
| #1069 | The Codex structured-review lane is real and routes findings (D1 taken) | `test/review-codex-structured-lane.test.js` |
| #1070 | A Codex reconsideration is correctly refused rather than silently degraded (D2 named, not resolved) | `test/review-reconsideration-invocation.test.js`, `test/docs-review-dispute-codex-capability.test.js` |
| #1071 | The whole round trip up to that refusal, over real phase boundaries, plus the reviewer-of-record identity fix (§17.13) | `test/review-dispute-round-trip.test.js` |
| #1072 | The same round trip through **production-default CLI dispatch** — no in-process seam anywhere in the chain | `test/review-dispute-default-path-e2e.test.js` |

Together these are what backs the sentence in §10: a Claude/Codex session
raises real, structured Codex findings, and a disputed one parks at
`ready_for_human` as a documented, tested outcome — not an untested corner.
**None of it is a claim that a real Codex CLI has ever been run against this
contract.** Every one of the tests above runs a fake executable named `codex`
(or, for #1069–#1071, an in-process stub standing in for one); contract §17.3
records this plainly — "No Codex build has been tested against this contract
in this repository, and no version gate is pinned for one." Session-doctor's
`codexCli` check and the parent/child workflow's own probe are both
`codex --version` — non-billable and unauthenticated — and neither one is
evidence for C4–C7 of §17.4, which stay `vendor-documented` or `unknown` until
someone runs the check in §13.2.

### 13.2 The optional, operator-run, real-CLI smoke check

Contract §17.8 is the procedure that could move C4, C5 and — the one that
actually decides anything — C7 off `vendor-documented`/`unknown`. It is
described here again only to state its operational shape plainly:

- **It is optional.** No session, workflow, or test requires it. Declining to
  run it leaves every current behavior exactly where it is: Codex review works,
  Codex reconsideration is refused by default and runs under the `read-bounded`
  posture where an operator opted in, and all of it is correctly reported by
  `session-doctor` (§3) either way. What §17.8 would change is whether a
  `no-tools` invocation becomes available for that CLI — a stronger posture than
  the one D2 admitted, never a prerequisite for it.
- **It is operator-initiated, and it may bill a real turn.** It spawns the
  real `codex` CLI on a real host under the operator's own credentials
  (`CODEX_HOME`, per §17.7). It is not, and must not become, a CI test —
  §17.8 says this explicitly, in the same shape
  [agent-isolation-policy.md](agent-isolation-policy.md) §4 already uses for
  the Claude login canary.
- **It settles a question, it does not activate anything.** A `verified` C7
  result is the fact a successor would need to add `codex` to
  `RECONSIDERATION_SUPPORTED_AGENTS` without recording decision D2 (contract
  §17.12, step 2). It is still a documentation step for *this* Issue: running
  it does not change `reconsiderationAgentSupport`, does not change what
  `session-doctor` reports, and does not enable anything by itself.
- **Record the result where the contract already asks for it.** §17.4's table
  and §17.3's tested-build statement, with the exact `codex --version` output
  the canary was run against — never as a claim inside this operations
  document that the check has been run, unless it actually has and the build
  is named.

**Never claim a live run occurred without that evidence.** This document does
not claim §17.8 has been executed, and neither does contract §17.3 or §17.4 —
both say the opposite, in as many words. A future edit that reports a
`verified` grade without naming the build and the date is a documentation
defect, not a rollout.

### 13.3 The read-bounded reconsideration: opt-in, rollback, and its own optional smoke check

The exact configuration change, in full — nothing else is required, and no other
key changes:

```jsonc
// sessions.json, the session you are enabling it for
"reviewDispute": {
  "enabled": true,                              // unchanged; required
  "reconsideration": { "readBounded": true }    // the §17.6 D2 opt-in; default false
}
```

Confirm it took effect before relying on it, and read the posture rather than the
tick:

```sh
node dist/cli/admin.js session-doctor --session-id <id>
#   reviewerReconsiderationCapability: ok — "... under the `read-bounded` posture ..."
node dist/cli/admin.js dispute status --session-ref 1 --issue-number <n>
#   <lineage>  v1  disputed  P1  src/auth/handler.ts
#       reconsideration: v1 agent=codex toolPolicy=read-bounded
#   last reconsideration: <lineage> v1 agent=codex toolPolicy=read-bounded
```

Read the indented per-lineage line, not only the task-level one. `last
reconsideration` is single-valued and describes whichever lineage the most recent
reviewer run answered; on a task that disputed two findings the per-lineage line is
what still names the posture the OTHER lineage was decided under. Both print
`toolPolicy=(unrecorded)` for a run that recorded none — a debate from before the
field, or a run that resolved no profile — and never `no-tools`. The same value is
on each run's `review.dispute.subturn` event, which is where an already-closed
debate's posture is read from.

**Rollback** is §9.1's narrow form: set `readBounded` back to `false`. The next
run refuses the turn and parks, the debate is untouched, and every lineage already
decided under the posture keeps that label — on its own line, on its own event, and
in its own §10.2 record.

**The optional bounded real-CLI smoke check**, if you want evidence on your own
host before enabling it on work that matters. It is operator-run, it may bill one
real Codex turn, and it is **not** a test — the same shape as §13.2:

1. Record the build: `codex --version`. Unauthenticated and non-billable.
2. Confirm the pinned flags are accepted by that build, from its own help:
   `--sandbox`, `--skip-git-repo-check`, `--ignore-user-config`, `--json`,
   `--output-last-message`. A flag this build does not recognize is a failed
   startup, which the lane reports as `unsupported-capability` and never as a
   reviewer's silence — this step tells you that in advance instead.
3. Run one real dispute on a throwaway Issue in a scratch session: a Codex review
   that raises one finding, a Claude fix run that disputes it without editing, and
   one review run for the reconsideration. Then read
   `<artifactRoot>/runs/<runId>/` and check three files exist and say what they
   should: `reconsideration-<lineageId>.json` (the admitted record, with
   `"toolPolicy":"read-bounded"` in its profile block),
   `reconsideration-raw-<lineageId>.txt` (the reviewer's final message, verbatim),
   and `reconsideration-events-<lineageId>.jsonl` (progress, never a verdict).
4. Confirm the boundary that IS enforced, on the same run: the repository is
   unchanged (`git status` in the worktree), no operator agent configuration was
   read (the run passed `--ignore-user-config`), and no GitHub write occurred.
   **Do not attempt to confirm that no out-of-bundle read occurred — it is not
   prevented, and a run that happened not to read anything is not evidence that
   one could not.** That is the acknowledged limit of the posture, and §17.8's C7
   canary is the separate procedure that would grade the stronger claim.
5. Record what you observed against contract §17.4 with the build it was taken
   on, exactly as §13.2 requires. An unrun check is never a pass.

### 13.4 The separate, larger migration this does not activate

Issues #908 and #912 (provider runtime consolidation, #903–#914) are where a
general cross-provider capability model belongs — one table describing what
any agent can do for any role, rather than the narrow purpose-built resolvers
this contract uses today (the reconsideration profile resolver, the arbiter
candidate resolver, the review-agent compatibility table). Contract §17.9
already says the §17 material is written to be folded into that work, not to
grow into a second copy of it.

That migration is out of scope here, on purpose: this Issue documents and
diagnoses the path that already exists, and activating or reshaping #908/#912
is a decision for whoever owns that chain, not a side effect of a docs and
diagnostics change. If that migration ever gives Codex a verified no-tools
posture, the change lands in `reconsiderationAgentSupport` and the arbiter
candidate resolver first (exactly as §17.12 already describes), and this
document and `session-doctor`'s checks follow from that change rather than
leading it. **Independent AI arbitration — a third-party model adjudicating a
dispute neither party can agree on — remains a separate, future milestone.**
Nothing in this Issue brings it closer than §2 and §8 already describe: the
arbiter checks exist today and correctly report row 19 wherever no independent
candidate is configured, and no code in this Issue changes what makes a
candidate acceptable.
