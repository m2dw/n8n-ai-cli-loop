# Chain-Aware Progressive Issue Refinement Contract

Status: approved design (issue #866). This document is the authoritative
contract for chain-aware progressive Issue refinement. Follow-up
implementation Issues reference this specification and MUST NOT redefine its
policy; a change of policy is a change to this document first.

No production intake, implementation, or review behavior changed in #866
itself — #866 shipped the contract, not the lane. It is gated behind
`session.issueRefinement.enabled`, which defaults to `false`; a session that
does not opt in behaves exactly as today.

**Implementation status (issues #867-#871).** The protocol described here is
now implemented: admission (`status:needs-refinement` intake), the refinement
loop, apply/activate, and the activation-to-implementation handover all exist
and are wired into `run-one-phase` and `admin refinement run`. It ships
default-off behind the same flag. See
[feature-status.md](feature-status.md#issue-refinement) for the operator-facing
availability summary and known publication/config boundaries.

This document is **publicly exportable**, not private-only: it describes
protocol shape and never contains repository content, local paths, or run
transcripts (see `copybara/copy.bara.sky`).

## 0. Purpose

Dependent Issues in a stack are created early, while the work that precedes
them is still being designed. The dormant-first contract in
[idea-to-implementation.md](idea-to-implementation.md) makes that ordering a
correctness requirement: every Issue in a stack is written and wired before
any of them runs. So a downstream Issue is necessarily written against
assumptions about its predecessors, not against their outcome.

By the time a predecessor reaches `status:stack-ready`, its PR head and its
reviewed artifacts contain decisions the downstream Issue was written without:
the module that actually exists, the seam that was actually injected, the
constant that was actually chosen, the follow-up that was already absorbed.
Today, carrying those decisions down the chain is a manual body edit by the
operator, repeated once per predecessor. When it is skipped, the downstream
implementation phase starts from a stale contract and the cost surfaces
several review cycles later.

This contract defines a bounded, chain-aware refinement lane that runs
*between* a predecessor becoming stack-ready and a downstream Issue becoming
implementable. One agent refines the Issue contract from the predecessor
evidence; a second, independent agent critiques the result; when the critique
passes, the refined contract is applied and the normal implementation lane is
activated with no human step. The lane is deliberately bounded: it never
debates indefinitely, it never changes chain topology, and every disagreement
it cannot settle stops at human handoff.

The final human approval point is unchanged: it is the PR merge.

## 1. Canonical vocabulary

Exactly one vocabulary is used throughout this document, and a later
implementation must use these tokens verbatim in code, JSON output, audit
events, and tests.

**Roles.** `refiner` (AI A, produces the refined Issue contract), `critic`
(AI B, independently critiques it), `runner` (the deterministic handler that
gathers inputs, enforces every limit, and performs every GitHub mutation).
The refiner and critic never mutate GitHub; the runner never authors prose.

**Refinement states** (SQLite, `task.context.refinement.state`): `pending`,
`eligible`, `drafting`, `critiquing`, `accepted`, `applying`, `activated`,
`escalated_human`. `activated` and `escalated_human` are terminal.

**Critic verdicts** (closed set, exactly three): `pass`, `revise`, `block`.

**Change classes** (closed set, exactly two): `applicable` — changes the
runner may apply automatically; `advisory` — changes the runner records and
publishes but never applies. Every field of a refiner result belongs to
exactly one class; §9 fixes the membership.

**Topology proposal dispositions** (closed set, exactly two): `advisory`,
`blocking`. A proposal is `advisory` only when the refiner marked it
`advisory` **and** the critic independently confirmed `advisory`; every other
combination, including an unclassified proposal, is `blocking`.

**Refusal reasons** (closed set, exactly three) — recorded by an eligibility
evaluation that creates no task or holds the Issue, never a handoff:
`conflicting_markers`, `no_implementation_agent`, `predecessor_not_ready`.

**Handoff reasons** (closed set): `fan_in_exceeded`,
`chain_disagreement`, `not_chain_scoped`, `malformed_refiner_output`,
`malformed_critic_output`, `topology_change_required`, `no_convergence`,
`critique_blocked`, `stale_inputs`, `unexpected_managed_region`,
`malformed_managed_region`, `managed_region_modified`,
`no_independent_critic`, `effect_undeliverable`,
`agent_unavailable`, `marker_precondition_failed`,
`execution_marker_conflict`.

`agent_unavailable` and `marker_precondition_failed` exist because the two most
ordinary runtime failures — an agent
process that times out or exhausts quota (§17), and a label precondition that
no longer holds when the effect reaches the dispatcher (§6) — must each land on
a state an operator can act on. Neither is a refusal: a refusal happens before
a task exists, while both of these happen to a task that is already mid-lane.
`execution_marker_conflict` (§3) exists for the same reason and covers the one
conflicting-marker shape that is not an admission decision: a task that already
exists at an executable phase when `status:needs-refinement` appears on its
Issue.

**Executable `status:*` labels** (closed set, exactly six) — the statuses the
existing intake router (`labelsToPhase` in `core/github-intake.ts`) maps to a
runnable phase: `status:needs-fix`, `status:needs-review`,
`status:research-needed`, `status:content-needed`,
`status:needs-implementation`, `status:needs-conflict-resolution`. Wherever
this document says "an executable `status:*` label" it means exactly this set,
in full. `status:needs-fix` is a member and is the label the router checks
**first**, so a conflict guard derived from a shorter list would still admit a
rough Issue into fix mode — the precise failure §3 exists to prevent.
`status:needs-refinement` is deliberately not a member.

**Predecessor.** A direct `blocked by` neighbour of the Issue being refined,
as reported by GitHub Issue Relationships. Transitive ancestors are never
predecessors for this purpose.

## 2. Two lanes, deliberately separate

This contract adds a second refinement lane. It does not replace, wrap, or
re-enter the first one. The separation is normative.

| | Standalone manual refinement | Chain-aware automatic refinement |
| --- | --- | --- |
| Surface | `admin issue-discuss preview` / `post` (issues #229, #244–#246) | the `refinement` task phase defined here |
| Trigger | an operator runs the command | a predecessor reaching `status:stack-ready` (§4) |
| Scope | one Issue, read in isolation | one Issue plus its direct predecessors' stack-ready results |
| Output target | a GitHub **comment** | the Issue **body**'s managed region (§10) |
| Human step | required — `--approve` with the preview fingerprint | none on the successful path |
| Applies on approval | the operator-reviewed draft, verbatim | the critic-passed refined contract |
| Chain awareness | none | required; a chainless Issue is refused (§4, row 7) |

Consequences that follow, and that an implementation must preserve:

- The automatic lane never calls `issue-discuss post` and never posts the
  refined contract as a comment in place of applying it. `issue-discuss post`
  remains the only path that publishes an operator-reviewed draft, and it
  still requires the `--approve` token.
- `issue-discuss preview` remains strictly read-only with respect to GitHub
  and remains available on an Issue that is also queued for automatic
  refinement. It carries no predecessor evidence and confers no eligibility.
- The manual lane is the supported path for refining a **standalone** Issue —
  one with no `blocked by` predecessor. The automatic lane refuses that shape
  rather than silently degrading into a single-Issue rewrite.

## 3. One human-facing marker; everything else in SQLite

Exactly one new GitHub label is introduced: **`status:needs-refinement`**.
It is coarse and human-facing: it says "this Issue is still rough, and
automation owns the next step." It carries no sub-state.

Normative rules:

- **`status:needs-refinement` is not an executable status.** It never routes
  to implementation, review, research, content, or conflict resolution.
- **An Issue carrying it is not eligible for implementation.** When an Issue
  carries `status:needs-refinement` together with any executable `status:*`
  label — the closed six-member set of §1, `status:needs-fix`,
  `status:needs-review`, `status:research-needed`, `status:content-needed`,
  `status:needs-implementation`, `status:needs-conflict-resolution` — intake
  refuses the Issue entirely —
  it neither refines nor implements it — and records
  `refinement.eligibility.refused` with reason `conflicting_markers`. The
  refusal is fail-closed by design: the two markers together are an operator
  mistake or a partially-applied label transition, and guessing which one
  wins is exactly how a rough Issue reaches implementation. The list is
  normative and complete: `status:needs-fix` in particular is executable and is
  the *first* route the intake router takes, so a guard that omitted it would
  leave fix mode as an open door into a rough Issue.
- **The marker travels with the implementation `agent:*` label, and the lane
  never removes it.** A refinement-marked Issue carries one `agent:*` label
  naming an agent the implementation lane of `labelsToPhase` recognises
  (`agent:claude`, `agent:codex`, `agent:gemini`); an Issue carrying the marker
  with **none** of them is refused admission and held (§4). More than one is
  not a refinement-lane decision: the existing implementation-lane precedence
  in `labelsToPhase` picks the owner, exactly as it does for any other Issue,
  and refinement neither re-orders nor second-guesses it. This adds no new
  label — `agent:*` already exists and already names the intended
  implementation owner (§14) — and it is dormant-safe: `labelsToPhase` routes
  on an executable `status:*` label, so an `agent:*` label with no executable
  status produces no candidate and cannot race the relationship graph. The
  requirement is not cosmetic: activation hands the Issue back to *ordinary*
  intake (§11 step 7), and ordinary intake produces an implementation candidate
  only from the pair `agent:*` + `status:needs-implementation`. An activation
  that left the Issue with `status:needs-implementation` alone would park a
  task row nothing could ever reactivate.
- **No further GitHub micro-state labels are added.** Round counts, verdicts,
  fingerprints, snapshots, caps, and handoff reasons live in SQLite on the
  task context and in local artifacts. The label plane stays coarse, in line
  with the assignment-vs-labels boundary of
  [assignment-profiles.md](assignment-profiles.md).
- **The marker is applied by a human or by Issue-creation tooling**, never by
  the refinement lane itself. The lane only ever *removes* it, as the last
  GitHub-visible step of activation (§11, step 5 — the steps after it are
  local task-row bookkeeping).
- **The marker is subject to the dormant-first contract.** Because it is not
  executable it cannot race the relationship graph into an implementation
  run, but it must still be applied only after the stack's `blocked by`
  relationships are configured and verified, so that the first eligibility
  evaluation sees the real predecessor set.

### 3.1 The marker also stops a task that already exists

Refusing *admission* (row 2) only decides whether a **new** task is created. It
does nothing to a task that was already created before the marker appeared —
and that is the ordinary case, because the marker is applied by a human, who can
apply it to an Issue whose implementation, fix, review, research, content, or
conflict-resolution task is already `queued`, `claimed`, or `running`. Without
the rules below, the phase runner would happily execute that task against the
rough contract the marker says is not ready, and the fail-closed guarantee above
would hold for every Issue except the partially-transitioned ones it exists to
protect. So:

- **A pre-execution marker guard, evaluated by the phase runner.** Immediately
  before a task at an **executable phase** — `implementation` in either mode,
  `review`, `research`, `content_research`, `conflict_resolution` — is claimed
  and started, the runner re-reads the Issue's live labels. When
  `status:needs-refinement` is present the phase does not start: nothing is
  claimed, no agent process is spawned, no branch or worktree is created, and
  the task moves to `ready_for_human` with handoff reason
  `execution_marker_conflict`, emitting `refinement.execution.suspended`. The
  re-read is live rather than taken from the intake snapshot, because the marker
  may have been applied after the task was enqueued — which is exactly the
  window this guard covers.
- **A task already running is stopped cooperatively, and its results are not
  published.** A running agent process is not killed mid-run: the loop's
  cancellation is already cooperative (`TaskStore.cancelTask`, issue #608), and
  this lane adds no force-kill. The guard is therefore evaluated a **second**
  time, immediately before any of that run's outward effects are enqueued —
  push, PR creation or update, comment, label transition. If
  `status:needs-refinement` is present at that point the run's results are not
  published: no outward effect is enqueued, the task moves to `ready_for_human`
  with the same reason and event, and the local work (branch, worktree,
  artifacts) is preserved untouched for the operator. A run whose outward
  effects were already delivered before the marker appeared is out of scope —
  the work is public and this lane does not retract it; the marker then simply
  blocks the *next* phase through the first guard.
- **The guard changes no labels.** It neither removes the executable
  `status:*` label nor removes `status:needs-refinement`: both were applied by
  an operator and deciding which one wins is the human decision this handoff
  exists to request. Everything else about the handoff is §13's ordinary shape —
  status `ready_for_human`, the session's ready-for-human label, and exactly one
  public comment carrying the reason literal.
- **This guard is outside §12's state machine, deliberately.** Every row of §12
  is keyed on `context.refinement.state`, and the task this guard stops has no
  such state: row 2 refused to admit a refinement task for the Issue, so no
  refinement lane exists for it. Making the guard a transition row would require
  inventing a refinement state for a task that is not in this lane. It is
  instead a property of the phase runner, and §18 names it as the extension the
  follow-up implementation owes.
- **The exit is the operator's, and it is the same two exits as §13.** Either
  remove `status:needs-refinement` and let the executable status stand — the
  suspended row is then resumed through the ordinary `ready_for_human` recovery
  surfaces, not by this lane — or remove the executable status and dispose of
  the suspended row with `admin task cancel`, after which the next poll admits
  the Issue under row 1. The cancellation is required in that second exit, not
  optional: refinement and implementation share one task row (§14), so a
  surviving row for the Issue makes the refinement admission a duplicate and
  the lane never starts.

## 4. Eligibility and trigger semantics

**Trigger.** Eligibility is evaluated by the existing GitHub intake poll. No
new scheduler, webhook, or trigger surface is introduced. Each poll
re-evaluates every Issue carrying `status:needs-refinement`, so an Issue that
is not yet eligible is simply re-evaluated on the next poll.

**Eligibility test.** An Issue is eligible when all of the following hold:

1. It carries `status:needs-refinement`, no executable `status:*` label, and at
   least one `agent:*` label naming an implementation-lane agent (§3, §14).
2. It has at least one direct `blocked by` predecessor.
3. It has at most `MAX_PREDECESSORS_PER_REFINEMENT` (§8) direct predecessors.
4. **Every** direct predecessor has a usable result, in one of exactly two
   shapes:
   - **open stack-ready head** — the predecessor carries the success-only
     stack-ready marker (`session.labels.stackReady`, `status:stack-ready` by
     default) and the same stack-ready resolver used by the Gate 2
     implementation start gate in [phase-contracts.md](phase-contracts.md)
     confirms a usable PR head for it; or
   - **merged stack-ready result** — the predecessor's PR is **merged**, with a
     resolvable head commit SHA and merge commit SHA.
5. The direct predecessor set observed on GitHub agrees with the chain
   registry's accepted revision for the Issue's chain, when the Issue is a
   registered chain member.

**Condition 1 is decided at admission; conditions 2–5 at predecessor
resolution.** Condition 1 is a pure label test, so it is evaluated on
`intake.scanned` before any task exists (§12, rows 1, 2, and 47) — an Issue that
fails it never becomes a refinement task and never queries relationships. Its
two failure shapes both refuse admission and both are holds, not handoffs,
because there is no task to hand off:

- an executable `status:*` label alongside the marker → refusal reason
  `conflicting_markers` (row 2);
- no `agent:*` label naming an implementation-lane agent → refusal reason
  `no_implementation_agent` (row 47).

Both are repaired by an operator editing labels, and both are re-evaluated on
the next poll; neither consumes a round or a counter. The missing-agent refusal
is fail-closed for the reason §3 gives: admitting such an Issue would run the
whole lane and then activate it into a state ordinary intake cannot pick up.

**The guards are ordered, and the first match wins.** More than one of these
conditions can fail at once — an Issue can exceed the predecessor cap *and*
have an unready predecessor — so the evaluation order is normative rather than
left to an implementation:

1. **No direct predecessor** → handoff, reason `not_chain_scoped`
   (§12, row 7).
2. **More direct predecessors than `MAX_PREDECESSORS_PER_REFINEMENT`** →
   handoff, reason `fan_in_exceeded` (row 5).
3. **The observed predecessor set disagrees with the chain's accepted
   revision** → handoff, reason `chain_disagreement` (row 6).
4. **Any direct predecessor without a usable result** → hold, refusal reason
   `predecessor_not_ready` (row 4).
5. Otherwise → `eligible` (row 3).

The three structural failures are evaluated before the readiness hold because
none of them is fixed by waiting: an over-wide fan-in stays over-wide, and a
predecessor set that contradicts the chain registry stays contradictory, no
matter how many polls later those predecessors turn stack-ready. Taking the
hold instead would bury a condition that needs a human under an indefinite
sequence of `predecessor_not_ready` refusals. The hold of row 4 is therefore
reserved for an Issue on which conditions 1–3 all pass.

**Main-branch merge is not required.** Eligibility deliberately uses the same
signal as Gate 2: a stack-ready predecessor with a usable PR head. Waiting for
the predecessor to merge into the default branch would serialize the chain
behind human merge decisions and defeat the purpose of stacking.

**A merged predecessor is a usable source, not a lost one.** Gate 2's resolver
requires an *open* PR, so on its own it would stop confirming a predecessor the
moment that predecessor merges — and a predecessor that merges inside the poll
interval before the dependent is next evaluated would never satisfy it again.
The dependent would hold at `pending`, still carrying
`status:needs-refinement`, precisely when the ordinary dependency gate (Gate 1,
every `blocked by` Issue closed) would already admit it to implementation. The
merged shape above closes that hole: a merged PR is *more* authoritative than
an open head, because its head commit is final and a human already took the
merge decision that is this loop's last approval point. Consequently the merged
shape does **not** require the stack-ready marker to still be present — the
merge itself carries the human approval the marker stands in for — while the
open shape still requires it, since an open head with no passing review is not
a decision yet.

**Partial readiness holds, it does not proceed.** With two predecessors of
which one is stack-ready, the Issue stays `pending` and is re-evaluated next
poll. Refining against half a chain would produce a contract that the second
predecessor immediately invalidates. "Usable" for this purpose means either
shape above, so a chain whose predecessors are one merged and one open
stack-ready is eligible, not held.

**A wide fan-in is refinable, but its implementation start is not therefore
due.** This test deliberately admits shapes the *implementation* start gates do
not: up to `MAX_PREDECESSORS_PER_REFINEMENT` predecessors, any number of them
still open. The unchanged intake gates are narrower — Gate 1 admits an Issue
whose every `blocked by` Issue is satisfied, and Gate 2 admits **exactly one**
open unsatisfied blocker, stack-ready. An Issue with two predecessors that are
both still open is therefore refinable now and implementable only once all but
one of them is satisfied. That is deliberate: refining early against decisions
that are already final is the point of the lane, and refinement is not a reason
to loosen a dependency gate. §11 step 7 specifies exactly what happens to such
an Issue after activation, and §12 row 34 is its normative wait state.

**Every negative answer fails closed.** A relationship query that throws, a
stack-ready resolver that throws or is absent, a chain lookup that errors —
all leave the Issue held, exactly as the existing dependency gate does. An
error is never read as "no blockers."

**A chainless Issue is refused, not refined.** An Issue carrying the marker
with zero direct predecessors escalates to human handoff with reason
`not_chain_scoped`. Its refinement path is the manual lane (§2).

## 5. Authoritative predecessor inputs and bounded snapshots

Refinement reads a **bounded snapshot**, captured once per round-set by the
runner and frozen for the duration. The agents never query GitHub, never
resolve a reference the snapshot omitted, and never see anything not listed
here.

For the Issue being refined:

- number, title, current body, and label set;
- the managed-region state of the body (§10);
- the `issue-plan` artifact for this Issue, when one exists locally.

For **each** predecessor, in ascending Issue number:

- the predecessor's Issue number, Issue state literal (`open` | `closed`),
  title, and body;
- its stack-ready PR: number, state literal (`open` | `merged`), head ref name,
  head commit SHA, merge commit SHA when merged, title, body;
- the PR's changed-path list with per-path added/removed line counts — paths
  and counts only, never file content or patch hunks;
- the terminal review outcome literal recorded for that predecessor by the
  loop, plus, when the review-dispute protocol is enabled, the terminal
  lineage states of its findings (literals and counts only, per
  [review-dispute-contract.md](review-dispute-contract.md) §11);
- up to `MAX_COMMENTS_PER_PREDECESSOR` most recent Issue comments.

Bounds and treatment:

- Every text field is truncated to its cap in §8 at capture time, and the
  truncation is recorded in the snapshot manifest. An over-cap input is
  truncated, never silently dropped and never used in full.
- **The label set is bounded like any other captured text** — by label count and
  by per-label length — and whether either bound was reached is recorded on the
  snapshot and hashed by §6. Labels are agent-visible input, so they count
  against the snapshot's total-size bound rather than sitting outside it.
- **Credential shapes are redacted before capture**, including the
  keyword-introduced forms (`Bearer <secret>`, `token <secret>`) that
  attacker-controlled Issue or PR prose can carry. Bare commit SHAs are
  preserved: they are the predecessor identity this snapshot is built on.
- **All snapshot text is untrusted.** It is attacker-controllable Issue and
  PR prose. It is passed to the agents as data inside an explicit
  untrusted-input fence and is never interpreted as instructions, in the same
  posture the planning and dispute surfaces already take.
- The snapshot is the *authoritative* input set. If a refined contract cites
  a predecessor decision that is not derivable from the snapshot, the critic
  must return `revise` or `block` (§7.2).
- **Predecessor source diffs are deliberately excluded.** The refined
  contract describes intent, criteria, risk, and notes; reproducing a
  predecessor's implementation in the downstream Issue body is out of scope
  and would leak repository content into a public Issue.

## 6. Fingerprints and staleness

The runner computes one **`predecessorFingerprint`**: a SHA-256 over a
canonical, deterministic serialization of **every input the §5 snapshot hands
the agents**. The name is historical; the value covers the target Issue's own
inputs as well, and no input the agents can see is left out of it. Exactly two
things are excluded, both of them writes this lane performs itself, and the
exclusions are enumerated below rather than left implicit.

**Hashed — the target Issue's inputs:**

- its number, and the digest of its title;
- the digest of its **source body**: the current body with the managed region
  of §10 elided when one is present (the exclusion rule below);
- its sorted label set, with the two lane-owned labels removed (the exclusion
  rule below), and whether that set was capped or truncated at capture (§5);
- the digest of the local `issue-plan` artifact used as an input, or the
  literal `absent` when there is none.

**Hashed — each predecessor's inputs**, in ascending Issue number:

- Issue number, Issue state literal (`open` | `closed`), and the digests of its
  title and body;
- stack-ready marker presence;
- the PR's number, state literal (`open` | `merged`), head ref name, head
  commit SHA, merge commit SHA or `absent`, and the digests of its title and
  body;
- the digest of the captured changed-path list — each path with its
  added/removed counts, in capture order — and whether that list was capped,
  since a capped list tells the agents something the captured paths alone do
  not;
- the terminal review outcome literal, plus the digest of the captured dispute
  lineage state literals and counts when the dispute protocol is enabled;
- the digest of the captured comment window — per comment, its identifier, its
  last-edited timestamp, and its body digest, in capture order.

Every text digest is taken over the **truncated** text actually placed in the
snapshot, so a digest is exactly the bytes the agents saw and a lowered
truncation cap is itself a fingerprint change; the snapshot manifest's
truncation record needs no separate digest. The §5 list and this list are
one-to-one by construction: an input the agents receive but this fingerprint
does not cover would let the lane apply a draft written against evidence that
has since changed, which is exactly what the staleness rule exists to prevent.

**Excluded, and why.** Exactly two inputs do not participate in freshness,
because the lane itself writes both while applying a refinement:

- **The managed region of the target body** (§10) — both its rendered content
  and the managed-region state §5 hands the agents alongside the body. The
  elision is canonical, so that appending a region for the first time does not
  change the source body's digest: the begin marker through the end marker
  inclusive is removed, together with the single blank-line separator introduced
  in front of it when the region was appended, and trailing whitespace is
  stripped before digesting. Step 3 of §11 rewrites that region, so hashing the
  whole body would mean the lane's own write invalidates its own remaining steps:
  the audit comment of step 4 and the label transition of step 5 would each
  recompute a different digest, take the stale path, and no refinement could ever
  finish its first application. Eliding the region also removes a circular
  definition — the begin marker carries the fingerprint prefix, so a fingerprint
  over the region could not be computed at all. Everything outside the region is
  hashed in full, so an operator editing the Issue *outside* the region mid-run is
  still detected, and §10's trust rule is untouched: it is keyed on the SQLite
  record of a prior applied refinement, not on this digest. An edit *inside* the
  region is not covered by this fingerprint at all, and is caught instead by the
  region precondition below — the exclusion is compensated, not merely accepted.
- **The two lane-owned labels** — `status:needs-refinement` and the executable
  implementation status the lane adds (`status:needs-implementation`). Step 5
  removes the first and adds the second, so hashing them would invalidate the
  second half of the lane's own label transition. Every other label on the
  Issue is hashed. These two are guarded instead by a **marker precondition**
  carried on the label effects themselves, checked at dispatch alongside the
  fingerprint: the removal requires `status:needs-refinement` to be present,
  and the addition requires it to be absent and no executable `status:*` label
  other than the one being added to be present. A hand-applied executable
  status therefore stops the transition instead of being silently overwritten.

**Marker preconditions, precisely.** Two rules make the check above both
idempotent and terminal, and an implementation needs each of them:

- **A marker precondition is satisfied when its own end state already holds.**
  A redelivered removal that finds the marker already gone, and a redelivered
  addition that finds `status:needs-implementation` already present, each
  perform nothing and count as satisfied — that is what makes step 5 of §11
  safe under at-least-once delivery. Who produced the end state does not
  matter: an operator who removed the marker or applied exactly the executable
  status this attempt was going to apply has done the lane's own work, and the
  transition completes rather than fighting them.
- **A precondition that genuinely does not hold is a handoff, not a refusal.**
  Exactly one shape can reach this: an operator adds a *different* executable
  `status:*` label after the removal effect landed and before the addition
  effect dispatches, so the addition can neither be performed (it would leave
  the Issue carrying two executable statuses) nor be treated as already done.
  The dispatcher performs nothing, the runner stops every still-undelivered
  effect of the attempt, and the task escalates with reason
  `marker_precondition_failed` (§12, row 42). It is deliberately **not**
  `conflicting_markers`: that literal is a pending-admission refusal that
  creates no task (§12, row 2), whereas this failure happens to a task already
  in `applying`, which must end on a state §13's recovery can act on rather
  than sit in `applying` with a half-finished label transition.

**The excluded region carries its own precondition.** Eliding the managed region
keeps the lane's own body write from invalidating the effects that follow it, but
that exclusion on its own would open a hole exactly as bad as the one it closes:
once step 3 of §11 has delivered, an edit *inside* the region would leave every
later fingerprint check passing, and the lane would post its audit comment and
transition labels for content neither agent wrote and no critic approved —
activating implementation against a body it never approved, while this section
still claimed mid-run Issue edits are detected. A second, narrower precondition
closes it, and an implementation needs all five rules:

- **`appliedRegionDigest`.** Rendering is deterministic (§10), so the runner
  renders the region at step 2 of §11 — the commit point, before any mutation —
  and persists a SHA-256 over exactly the bytes step 3 will write: the begin marker line
  through the end marker line inclusive, and nothing outside them. It is
  persisted with the accepted refinement, in the same write that records the
  fingerprint, so a crash between the commit point and step 3 resumes against
  the same expected region rather than re-deriving a new one.
- **It is stamped on every effect the attempt enqueues after the body update** —
  the audit comment of step 4 and each label effect of step 5 — alongside the
  fingerprint precondition. The body-update effect itself carries no region
  precondition: it is the write that establishes the digest, and it is governed
  instead by §10's trust, idempotency, and malformed rules.
- **The dispatcher re-derives it immediately before performing such an effect**,
  from the live Issue body, extracting the region under §10's rules. The
  precondition holds only on a byte-for-byte match. A region edited, truncated,
  re-marked, replaced, deleted, or made malformed after step 3 delivered all fail
  it, and so does a body that no longer carries a region at all.
- **A failed region precondition is dispositioned exactly as a stale fingerprint
  is**: nothing is performed, every still-undelivered effect of the attempt is
  stopped, and the attempt re-snapshots below `MAX_STALE_RESTARTS_PER_ISSUE`
  (§12, row 43) or escalates with reason `managed_region_modified` at the cap
  (§12, row 44). It shares that counter deliberately — both record the same fact,
  that the state the accepted contract was written against no longer holds — and
  sharing it bounds the retry loop an operator repeatedly editing the region
  would otherwise create.
- **The digest belongs to the attempt, not to the Issue.** A later refinement
  renders its own region and stamps its own digest; whether an existing region
  may be replaced at all is §10's trust rule, which is keyed on the recorded
  applied refinement and is unaffected by this precondition.

The fingerprint is the identity of the whole refinement attempt:

- It is recorded when the snapshot is captured, and it is the idempotency key
  for the applied refinement. Applying the same fingerprint twice is a no-op,
  not a second edit.
- It is **recomputed from live GitHub state immediately before the commit point
  of §11** — step 1, which precedes both the persistence of step 2 and the first
  GitHub mutation of step 3. A mismatch means a predecessor moved (a new head
  SHA, a re-opened PR, an edited body) or the Issue itself was edited while
  the agents were running, so the accepted contract was written against
  inputs that no longer hold.
- **It is also a dispatch precondition, not only an enqueue-time check.**
  Every GitHub mutation goes through the outbox (§7.3), so an arbitrary delay
  can separate the enqueue-time re-verification above from the moment the
  dispatcher performs the effect; a predecessor can move inside that window.
  Each refinement effect therefore carries the `predecessorFingerprint` it was
  accepted under as an explicit precondition, and the dispatcher recomputes
  the live fingerprint **immediately before performing that effect**. On
  mismatch the effect is not performed. The precondition is a property of the
  queued effect, not of the moment it was queued: an effect that has waited in
  the outbox across a stale window is stopped, never applied late (§11).
  Today's dispatcher has no such check and no way to recompute a fingerprint
  before delivery, so this is one of the three outbox extensions §18 requires;
  the guarantee in this bullet is unenforceable until that extension lands. The
  same check evaluates the marker preconditions above and the
  `appliedRegionDigest` the effect carries.
- On mismatch, the accepted draft is **discarded, never merged**. The Issue
  returns to `eligible` and is re-snapshotted from scratch, at most
  `MAX_STALE_RESTARTS_PER_ISSUE` times; at the cap it escalates with reason
  `stale_inputs`. Partially applying a stale contract, or diffing an old
  draft against new inputs, is not permitted.
- **A predecessor that merges mid-attempt is a fingerprint change, not a dead
  end.** The PR state literal and merge commit SHA are hashed, so a merge
  between capture and application is detected exactly like a new head SHA: the
  draft is discarded and the Issue is re-snapshotted from the merged result,
  which §4 accepts as a usable source. The attempt is re-run, never stranded.
- The fingerprint that was actually applied is persisted and embedded in the
  managed-region begin marker (§10), which is what makes a redelivered
  activation idempotent across a crash.

## 7. Roles, isolation, and structured result schemas

### 7.1 Refiner (AI A)

The refiner receives the §5 snapshot and returns exactly one fenced JSON
object. It edits no files, runs no commands, and touches no network.

```jsonc
{
  "summary": "...",                    // applicable — replaces the managed summary
  "acceptanceCriteria": ["..."],       // applicable
  "testPlan": ["..."],                 // applicable
  "risks": ["..."],                    // applicable
  "implementationNotes": ["..."],      // applicable
  "predecessorReferences": [           // applicable — provenance for the above
    { "issueNumber": 123, "prNumber": 456, "headSha": "…", "decision": "..." }
  ],
  "topologyProposals": [               // advisory — never applied (§9)
    {
      "kind": "split | dependency_add | dependency_remove | dependency_rewire | supersede",
      "rationale": "...",
      "disposition": "advisory | blocking"
    }
  ],
  "unresolvedQuestions": ["..."],      // advisory
  "confidence": "low | medium | high"  // advisory — self-assessment (§9)
}
```

Rules:

- Every applicable claim must be traceable to the snapshot, and every entry
  in `predecessorReferences` must name a predecessor that is actually in the
  snapshot. A reference to any other Issue or PR is malformed (§17).
- The refiner must not restate predecessor source code, quote file contents,
  or emit any local filesystem path.
- The refiner must not emit the managed-region markers of §10 anywhere in its
  output; doing so is malformed (marker injection).
- `confidence` is a self-assessment, classified `advisory` in §9 like every
  other non-body field. It is recorded and published as a literal, and no
  guard in §12 branches on it: a `low`-confidence draft is neither rejected,
  down-weighted, nor escalated on that basis. Judging the draft is the
  critic's job, and the critic's verdict is what the table reads.
- The refiner never proposes label, milestone, assignee, or state changes.
  Those fields are absent from the schema, and an implementation must not add
  them without changing this document first.

### 7.2 Critic (AI B)

The critic receives the same snapshot, the refiner's result, and nothing
else — in particular it does not receive the refiner's reasoning transcript.
It returns exactly one fenced JSON object.

```jsonc
{
  "verdict": "pass | revise | block",
  "objections": [
    {
      "field": "summary | acceptanceCriteria | testPlan | risks | implementationNotes | predecessorReferences",
      "kind": "unsupported | contradicted | lost_requirement | out_of_scope | ambiguous",
      "detail": "..."
    }
  ],
  "topologyDispositions": [
    { "index": 0, "disposition": "advisory | blocking" }
  ],
  "confidence": "low | medium | high"
}
```

Verdict semantics:

- **`pass`** — the refined contract is supported by the snapshot, preserves
  every requirement of the original Issue, and stays within the Issue's
  scope. `objections` must be empty.
- **`revise`** — the contract is fixable within the round cap. `objections`
  must be non-empty; they are the only critic output handed back to the
  refiner.
- **`block`** — the contract must not be applied and the round cap must not
  be spent trying. Used when the refiner contradicts predecessor evidence,
  drops a requirement the original Issue stated, or refines an Issue whose
  premise the predecessor outcome invalidated. `block` goes straight to human
  handoff.

The critic evaluates; it never authors replacement prose. A critic result
containing a rewritten body, criteria list, or notes is malformed (§17).

### 7.3 Agent selection and isolation

- **The critic must not be the same agent as the refiner.** Selection reuses
  the cross-provider policy already specified for the review arbiter
  ([review-dispute-contract.md](review-dispute-contract.md) §8.3): a
  cross-provider candidate is preferred; a same-provider, never same-model
  candidate is allowed only by explicit opt-in. When no independent critic is
  available, the run escalates with reason `no_independent_critic`. It never
  falls back to self-critique.
- **Role resolution is an explicit, ordered step, not an implicit lookup.**
  Both roles are resolved once per refinement attempt, in state `eligible` and
  **before the snapshot is captured** — the `roles.resolved` event of §12,
  rows 8 and 9. Resolving first is what gives the independence requirement
  above an executable failure path: a run that cannot name two independent
  agents escalates at row 9 without spending a snapshot, a draft, or a round.
  A resolution that succeeds is recorded on the task context and is not
  re-resolved for the remaining rounds of that attempt; a stale restart (§6)
  re-resolves, because it is a fresh attempt. A provider that later fails
  mid-run is an agent process failure (§17), not a selection failure.
- **Both agents run isolated.** Write-enabling environment variables are
  stripped, exactly as specified for `issue-discuss` and the AI planner. No
  repository write surface, no `gh` write path, and no credentials that could
  produce an authenticated side effect are in scope for either agent. One part
  of that isolation is provider-specific: an agent CLI whose own login is only
  reachable from the operator's real home runs with it, under the compensating
  controls of [agent-isolation-policy.md](agent-isolation-policy.md), and only
  when the invocation itself enforces the no-tools boundary. GitHub credentials
  are unreachable either way.
- **The refinement phase is read-only with respect to the repository.** When
  it needs a checkout at all, it runs detached at fetched `origin/<base>` in a
  per-issue worktree, the same shape the research phase uses. It creates no
  branch, writes no commit, and pushes nothing.
- Every GitHub mutation in this contract is performed by the runner through
  the existing outbox, never by an agent — through the outbox as extended by
  §18, which names the two additions this contract requires of it.

## 8. Bounded refinement: normative limits

A **round** is one refiner draft plus one critic verdict.

| Constant | Default | Meaning |
| --- | --- | --- |
| `MAX_PREDECESSORS_PER_REFINEMENT` | 4 | Direct predecessors above this escalate (`fan_in_exceeded`). |
| `MAX_REFINEMENT_ROUNDS_PER_ISSUE` | 2 | Rounds per refinement attempt; a `revise` at the cap escalates (`no_convergence`). |
| `MAX_MALFORMED_ATTEMPTS_PER_ROLE` | 2 | Malformed outputs tolerated per role before escalating. |
| `MAX_AGENT_FAILURES_PER_ROLE` | 2 | Retryable agent *process* failures (timeout, quota, transient provider error) tolerated per role before escalating (`agent_unavailable`); counted separately from malformed output (§17). |
| `MAX_STALE_RESTARTS_PER_ISSUE` | 1 | Fingerprint- and managed-region-mismatch restarts before escalating (`stale_inputs` / `managed_region_modified`). |
| `MAX_COMMENTS_PER_PREDECESSOR` | 5 | Most recent Issue comments captured per predecessor. |
| `MAX_SNAPSHOT_TEXT_BYTES` | 8000 | Per text field (Issue body, PR body, comment) in the snapshot. |
| `MAX_CHANGED_PATHS_PER_PREDECESSOR` | 100 | Changed paths captured per predecessor PR. |
| `MAX_MANAGED_REGION_BYTES` | 16000 | Rendered managed region; a larger region escalates. |

Session configuration may only **lower** these; the table is the maximum. A
configured value of `0` is rejected at session load for
`MAX_PREDECESSORS_PER_REFINEMENT`, `MAX_REFINEMENT_ROUNDS_PER_ISSUE`,
`MAX_MALFORMED_ATTEMPTS_PER_ROLE`, `MAX_SNAPSHOT_TEXT_BYTES`,
`MAX_CHANGED_PATHS_PER_PREDECESSOR`, and `MAX_MANAGED_REGION_BYTES`, because
at `0` the lane would have a state with no next action.
`MAX_STALE_RESTARTS_PER_ISSUE`, `MAX_COMMENTS_PER_PREDECESSOR`, and
`MAX_AGENT_FAILURES_PER_ROLE` accept `0`: at `0` the restart, respectively the
comment window, respectively the process-failure retry, is simply unavailable —
a first agent process failure then escalates immediately, which is still a
defined next action.

**Why this cannot become an unbounded AI debate.** Each Issue gets at most
`MAX_REFINEMENT_ROUNDS_PER_ISSUE` rounds; the only transition that spends a
round and returns to the refiner is a `revise` strictly below that cap, and the
two self-loops that re-run a role without spending a round carry their own
per-role caps — `MAX_MALFORMED_ATTEMPTS_PER_ROLE` for malformed output (§12,
rows 12 and 20) and `MAX_AGENT_FAILURES_PER_ROLE` for a retryable agent process
failure (§12, rows 38 and 40); the only transitions that
return to `eligible` are stale restarts, themselves capped by the single
`MAX_STALE_RESTARTS_PER_ISSUE` counter shared by the enqueue-time check, the
dispatch-time fingerprint precondition, and the dispatch-time managed-region
precondition (§12, rows 23, 26, and 43); and every cap exhaustion
has exactly one successor — `escalated_human`, which is terminal for
automation. There is no cycle in the transition table of §12 whose edges do
not each increment a bounded counter, with exactly two exceptions, neither of
which runs an agent: the hold self-loops that only re-evaluate on the next poll
(row 4 before refinement, row 34 after activation), which perform no work at
all; and the operator recovery edge out of `escalated_human` (row 36), which no
automation can take and which a human must issue one command at a time (§13).

## 9. Applicable and advisory changes

**Applicable — may be applied automatically.** The Issue-body prose in the
managed region: the refined summary, acceptance criteria, test plan, risks,
implementation notes, and the predecessor references that justify them.
Nothing else.

**Advisory — recorded and published, never applied.** Issue splitting,
dependency addition/removal/rewiring, supersession, unresolved questions, and
the refiner's self-reported `confidence`. Also, implicitly, everything absent
from the refiner schema: labels, milestones, assignees, Issue state, chain
membership, chain revision, and frozen prefixes. The refinement lane holds no
write path to GitHub Issue Relationships or to the chain registry, and an
implementation must not give it one.

**`confidence` is classified, not exempt.** It proposes no change, so it is
named in the advisory set explicitly rather than left out — the "every field
belongs to exactly one class" rule of §1 admits no metadata escape hatch, and
an implementation is owed a disposition for every field it will parse.
Concretely: `confidence` is persisted on the task context (§15) and published
as a literal in the audit comment (§16), it is never written into the Issue
body, and no guard in §12 reads it (§7.1).

**Topology proposals fail closed.** The runner never performs a topology
change. Beyond that:

- A proposal is treated as `advisory` only when the refiner marked it
  `advisory` **and** the critic's `topologyDispositions` entry for the same
  index independently confirms `advisory`. A missing entry, an unparseable
  entry, an index that does not exist, or either party saying `blocking`
  makes it `blocking`.
- With every proposal `advisory`, refinement proceeds: the body is applied,
  the proposals are published in the audit comment as recommendations for a
  human, and the implementation lane is activated.
- With **any** proposal `blocking`, the run fails closed: nothing is applied,
  the Issue is not activated, `status:needs-refinement` stays, and the task
  escalates with reason `topology_change_required`. A downstream Issue that
  genuinely needs to be split or rewired is a decision for a human, and
  implementing it as written would be the wrong work.

## 10. The managed body region

The applied update rewrites exactly one **managed region** of the Issue body,
delimited by HTML comment markers:

```
<!-- ai-refinement:begin fingerprint=<first 12 hex chars of predecessorFingerprint> -->
### Refined contract
…summary, acceptance criteria, test plan, risks, implementation notes,
  predecessor references…
<!-- ai-refinement:end -->
```

Rules:

- **Everything outside the markers is preserved byte-for-byte.** The lane
  never rewrites operator prose, never reorders the original body, and never
  performs a whole-body replacement.
- On the first refinement the region is **appended** at the end of the body.
  On a later refinement the existing region is **replaced** in place.
- The region is rendered by the runner from the refiner's structured result,
  not pasted from agent output, so its shape is deterministic and its size is
  bounded by `MAX_MANAGED_REGION_BYTES`.
- **Idempotency, byte-for-byte.** If the region already present is
  byte-for-byte identical to the region about to be written, the body update is
  a no-op and application continues to the next step. This is what makes a
  redelivered or crash-resumed activation safe. A matching fingerprint in the
  begin marker is **not** sufficient on its own: a region carrying this
  attempt's fingerprint but different bytes was edited after the lane wrote it,
  so the no-op is not taken and the rendered region — which is authoritative
  for lane-owned space — is written over it.
- **The region is excluded from the fingerprint.** The target-body digest that
  feeds `predecessorFingerprint` is taken over the body with this region elided
  (§6), so the lane's own write here cannot invalidate the effects that follow
  it, and a redelivery recomputes the same value. **The exclusion is paid for by
  the region's own precondition**: the rendered region's `appliedRegionDigest`
  is stamped on every effect enqueued after the body update and re-derived from
  the live body at dispatch (§6), so an edit inside the region between delivery
  and activation stops the attempt instead of riding through a check that
  deliberately cannot see it.
- **Trust rule.** A marker pair is trusted only when SQLite records a prior
  applied refinement for this Issue whose fingerprint prefix matches it. A
  body carrying a marker pair with no such record escalates with reason
  `unexpected_managed_region` — an Issue body is attacker-authorable, and a
  forged marker must not be able to steer what the runner overwrites.
- Zero markers is the normal first-refinement case. Anything malformed —
  an unbalanced pair, more than one pair, nested pairs, or an end marker
  before a begin marker — escalates with reason `malformed_managed_region`.

## 11. Application and activation ordering

Once the critic returns `pass` (and §9 admits every topology proposal), the
runner performs these steps **in this order**. The order is normative: it is
what guarantees that no crash can activate an unrefined Issue, and that no
retry can activate one twice.

1. **Re-verify the fingerprint against live GitHub state** (§6). A mismatch
   abandons the attempt here — before anything is persisted and before any
   mutation — and takes the stale path of rows 23/24.
2. **Persist the accepted refinement in SQLite** — the refined contract, the
   `predecessorFingerprint`, the rendered managed region and its
   `appliedRegionDigest` (§6), the round counters, and the agent/model/effort
   metadata — and **stamp the fingerprint as a precondition on every effect this
   attempt will enqueue**. This is the commit point. Nothing is GitHub-visible
   yet, and the persistence itself emits `refinement.accepted.persisted`
   (§12, row 22).
3. **Update the Issue body** — render and write the managed region (§10),
   through the body-update effect §18 requires the outbox to gain. No existing
   outbox topic can perform this step. The region written here is the one
   rendered and digested at step 2, and that `appliedRegionDigest` is stamped on
   every effect enqueued after this one (§6), so steps 4 and 5 are conditional
   on the region still holding the bytes this step wrote.
4. **Post the audit comment** (§16).
5. **Transition labels last, removal before addition** — remove
   `status:needs-refinement` and add the executable implementation status
   (`status:needs-implementation`), through the existing outbox label-effect
   path, under the replacement rule below. Only those two labels move: the
   Issue's `agent:*` label is left exactly as the operator applied it (§3,
   §14), because it is the other half of the pair ordinary intake routes on at
   step 7.
6. **Park the shared task row for implementation, by reconciliation.** The
   label write is a call to GitHub, so it shares no transaction with any local
   write and the park cannot be one half of an atomic pair with it. The durable
   record that the label landed is the outbox row observed `sent`. Activation is
   therefore completed by a **reconciliation pass** that reads that record: for
   each attempt in `applying` whose final label effect is durably `sent`, it
   performs in **one TaskStore transaction** the state move to `activated` and
   the park of the shared task row (§14) at status `blocked`, phase
   `implementation`, with `context.assignment` untouched (§12, row 45). The
   transaction is compare-and-set on the row still being this lane's, so a
   repeated pass, a redelivered label effect, and a dispatcher that performs the
   park inline as an optimization all converge on the same single park. The pass
   runs **at the start of every poll, before intake evaluates any Issue**, and
   §18 requires it as the third outbox/dispatcher extension.
7. **Implementation is activated by ordinary intake, under its unchanged
   gates.** After step 5 the Issue carries the ordinary implementation pair —
   the `agent:*` label it has carried since admission plus
   `status:needs-implementation` — which is exactly what `labelsToPhase` needs
   to produce a new-implementation candidate. The next poll therefore sees an
   ordinary implementable Issue and evaluates it exactly as it evaluates any
   other: when Gate 1 (every `blocked by` Issue satisfied) or Gate 2 (exactly
   one open unsatisfied blocker, stack-ready) admits it, intake enqueues the
   implementation phase through the existing lane, which reactivates the parked
   row (§12, row 33). No new activation path, no change to the intake router,
   and no direct enqueue that bypasses the dependency gate.

**Freshness is verified before persistence, and that is the single
authoritative ordering.** Steps 1 and 2 are in this order and no other: the
live fingerprint check is the *guard* on the commit point, not a second look
after it. Row 22 says the same thing — its guard is a matching live
fingerprint and its effect is the persistence — and the two statements are one
rule, deliberately, so that no implementation can read the contract as
persisting first. The alternative ordering was considered and rejected: writing
the accepted record first means a crash between the write and the check leaves
an `applying` attempt whose contract may already be stale, and the mismatch path
would then have to *undo* a commit point rather than never reach it. With this
order the stale case (rows 23/24) touches nothing at all — no accepted record,
no stamped effect, no GitHub write — and the Issue returns to `eligible` for a
clean re-snapshot. The dispatch-time re-check of §6 is not a third ordering: it
is the same fingerprint evaluated again per effect, because an effect can wait
in the outbox arbitrarily long after the commit point.

**Steps 3–5 are dispatched, not merely enqueued.** Because every mutation goes
through the outbox, "in this order" has to be a property of *delivery*, not of
enqueue. These rules make it one:

- **The label transition is an atomic replacement, or a removal observed sent
  before the addition is enqueued.** The existing outbox models label changes as
  two separate effects (`gh:label:remove`, `gh:label:add`), which by themselves
  fix no delivery order. Step 5 therefore requires one of exactly two shapes: a
  single atomic label-replacement effect when the provider offers one (one
  set-labels request that drops `status:needs-refinement` and adds
  `status:needs-implementation` together), or, absent that, the **removal**
  enqueued first and observed as sent before the **addition** is enqueued at
  all. Delivering the addition first would leave the Issue carrying both markers
  — the state §3 refuses outright — and today's router would admit it to
  implementation instead of refusing it, handing an unrefined body to the
  implementation lane. The opposite window, an Issue carrying neither marker,
  is inert: no marker routes anywhere, the shared task row is still `applying`
  and owned by this lane, and an intake poll landing in that window finds
  nothing to admit. A crash in that window is recovered by the outbox's
  at-least-once delivery of the still-pending addition, whose marker
  precondition (§6) is satisfied precisely because the removal already landed.
- **One stage in flight at a time.** The effect for stage N+1 is enqueued only
  once stage N's row is observed as sent; the label removal and the label
  addition are two stages for this purpose. Queuing every stage at once would
  make the ordering depend on dispatcher scheduling and per-row retry backoff,
  and a body-update row that exhausted its attempts while the label row
  succeeded would activate an unrefined Issue — exactly the failure this
  ordering exists to prevent.
- **Every effect is precondition-checked at dispatch** (§6), by the dispatcher
  extension §18 requires — the current dispatcher performs a claimed row
  unconditionally. Immediately before performing an effect the dispatcher
  recomputes the live fingerprint; on mismatch it performs nothing and stops
  every still-undelivered effect of the attempt (§12, rows 25–27). An effect stopped this way is never applied
  late: the accepted contract is discarded and the Issue is re-snapshotted, or
  escalated at the stale cap. A body region already written under the previous
  fingerprint is left in place — it is a recorded applied refinement, so §10's
  trust rule lets the next attempt replace it in place.
- **An effect enqueued after the body update also checks the region it was
  approved against.** The fingerprint deliberately elides the managed region
  (§6), so it cannot see an edit made *inside* the region after step 3 delivered
  — and steps 4 and 5 would otherwise proceed against content no agent produced.
  Each effect enqueued after step 3 therefore carries the `appliedRegionDigest`
  of the region step 3 rendered, and the dispatcher re-derives that digest from
  the live body immediately before performing the effect. On any mismatch —
  edited, replaced, deleted, or made malformed — it performs nothing and stops
  every still-undelivered effect of the attempt, re-snapshotting below the stale
  cap (§12, row 43) or escalating `managed_region_modified` at it (§12, row 44).
  Activation therefore cannot complete for a region the critic did not pass. The
  guard ends where this lane's mutations end: an edit made after the final label
  effect was delivered is post-activation, where refinement is terminal and gap
  G1 governs — the local reconciliation of step 6 changes nothing on GitHub and
  re-checking a region there would only refuse to record work already done.
- **A label effect whose marker precondition no longer holds ends the attempt
  at handoff.** The same dispatch check evaluates the marker preconditions of
  §6, and one shape can fail them: an operator applies a *different* executable
  `status:*` label in the window between the removal landing and the addition
  dispatching. The addition is not performed, the still-undelivered effects are
  stopped, and the task escalates with reason `marker_precondition_failed`
  (§12, row 42) rather than remaining in `applying` with the transition half
  done. The complementary shapes are no-ops, not failures: an effect whose end
  state already holds — marker already absent, or the very status this attempt
  adds already present — is satisfied (§6).
- **An undeliverable effect fails closed.** A refinement effect that
  dead-letters, or that an operator cancels, escalates with reason
  `effect_undeliverable` (§12, row 32); no later **application** stage is
  enqueued. "Application stage" means steps 3–5 only. The handoff's own
  effects — the ready-for-human label and the one public comment §13 requires —
  are *not* application stages and are always enqueued, including when the
  effect that dead-lettered was the audit comment of step 4. They are new outbox
  rows with their own fresh retry budget, and they carry **no** fingerprint,
  marker, or `appliedRegionDigest` precondition: a handoff comment reports a
  failure rather than applying a contract, so a state change that would stop an
  application effect must not also silence the notification that the lane
  stopped. §13 defines what happens if that handoff comment is itself
  undeliverable.

Why this order: the label is the only thing that makes the Issue
implementable, so it goes last — a crash after step 3 leaves a refined but
still-marked Issue, which the next poll re-evaluates and completes
idempotently, whereas a crash after an early label transition would hand an
unrefined body to implementation. Steps 3–5 are each idempotent under the
`predecessorFingerprint`, so at-least-once outbox delivery is safe. Step 3's own
idempotency is byte-for-byte on the rendered region rather than on the
fingerprint prefix (§10), so a redelivery that meets an edited region rewrites
it instead of skipping it as already applied.

**Why the parked row rather than a fresh task.** §14 requires refinement and
implementation to be the same task row, and an existing row makes ordinary
intake's enqueue a duplicate. Parking the row at `blocked`/`implementation` is
what turns the next scan into a reactivation instead of a refusal: it is the
identical hold-and-reactivate shape a dependency-held implementation task
already uses (issue #224), so the intake path needs no new branch and no
refinement-specific enqueue. Activation is therefore complete only when the
label transition **and** the park have both committed; until then the Issue is
still owned by this lane, and the reconciliation below is what commits the
second half.

**The park is reconciled from a durable record, never assumed.** Steps 5 and 6
cannot be one transaction: step 5 is an external write, and no SQLite
transaction can span it. Between the addition being delivered and the park being
committed there is therefore a real window in which the Issue already carries
`status:needs-implementation` while the shared row is still `applying` at phase
`refinement`. An intake poll landing in that window finds an existing,
un-parked row and refuses the implementation enqueue as a duplicate — it cannot
take the blocked-task reactivation path of row 33, because the row is not
parked. That refusal is safe but must be **transient**, and two rules make it
so:

- Reconciliation runs before intake evaluation within the same poll, so the
  ordinary case never exposes the window to intake at all.
- Reconciliation is driven by the outbox row's durable `sent` state rather than
  by anything held in memory by the process that dispatched it, so a crash
  anywhere in the window is repaired by the next poll rather than by an
  operator.

Without a durable reconciliation the window would be permanent rather than
transient: nothing else in the system re-derives "the label already landed", the
row would sit un-parked at phase `refinement` indefinitely, and every later poll
would refuse the implementation enqueue as a duplicate — an Issue implementable
by label and unstartable in fact, with no automatic exit and no handoff to tell
an operator it needs one. That is why the reconciliation is a required extension
(§18) and not an implementation detail: today's dispatcher can mark its row sent
and nothing more, so this contract cannot assume the park happens with it.

**Activation is a lane handover, not a start guarantee.** Step 7 hands the
Issue to intake under intake's own gates, and those gates are narrower than §4
eligibility: Gate 2 admits exactly one open unsatisfied blocker. An Issue
refined against two or more predecessors that are all still open therefore
reaches `activated` with its parked row still `blocked` — the poll finds the
Issue implementable by label and held by dependency, so it neither reactivates
the row nor refuses it. That is the specified state, not a stall:

- The row stays parked at `blocked`/phase `implementation`, with
  `context.assignment` and the applied refinement intact, and every later poll
  re-evaluates it against the same gates (§12, row 34). No counter advances, no
  agent runs, and nothing is re-refined.
- It leaves the wait when the chain moves — each predecessor that closes as
  completed (or whose PR merges and closes it) satisfies one more blocker,
  until Gate 1 admits the Issue, or until exactly one open blocker remains and
  Gate 2 admits it as stack-ready. Then row 33 fires and implementation starts.
  A predecessor closed `not_planned` satisfies nothing, exactly as it does not
  for any other dependency-held task.
- The refinement is **not** revalidated while it waits. Refinement is terminal
  at `activated` (row 35), so a predecessor that moves after activation does
  not re-open the lane; that limitation is gap G1, and it applies to this wait
  exactly as it applies to an Issue whose implementation started immediately.
- The wait is bounded only by the chain, so it can be long — a fan-in whose
  predecessors never close waits forever, in precisely the way any
  dependency-held implementation task already does. Refinement deliberately
  adds no timeout and no escalation here: the Issue is refined, correctly
  labelled, and visible in the ordinary blocked-task surfaces, and shortening
  the wait would mean loosening a dependency gate this contract does not own.

**No human action is required anywhere in steps 1–7.** That is the normal
successful path in full: marker applied by whoever created the Issue,
predecessor becomes stack-ready, refine, critique, apply, activate,
implement, review — and the first and only human decision is the PR merge. The
fan-in wait above is no exception: it waits on the chain, never on a human, and
needs no operator action to leave.

## 12. Transition table (normative)

One row per (state, event, guard). Every row is exhaustive for its state; an
event with no matching row is a no-op that records nothing. Guards for the
same (state, event) pair are mutually exclusive, with one deliberate
exception: several of the `pending` + `predecessors.resolved` rows can match
the same Issue, and §4's ordered guard list decides between them — rows 7, 5,
6, then 4, then 3, first match wins. Row 4's guard is written to say so, so
that the hold can never pre-empt a required handoff.

Row order is presentational; the normative content of a row is its
(state, event, guard) triple and its successor. Rows 38–42 belong to the
`drafting`, `critiquing`, and `applying` states and are appended rather than
inserted so that the row numbers this document, its tests, and its follow-up
Issues already cite stay stable. Rows 43–45 belong to `applying` and were
appended for the same reason: rows 43 and 44 are the managed-region precondition
of §6, and row 45 is the activation reconciliation of §11 step 6, which row 31
no longer performs itself. Row 46 was appended for the same reason again: it is
the one shape in which a handoff cannot deliver the public comment §13 and §16
otherwise require of it. Row 47 was appended for the same reason once more: it
is the second admission refusal of §4 condition 1, and it sits beside row 2
rather than replacing it because the two failures are repaired by opposite
label edits.

Three rows continue past a terminal refinement state, and none weakens the
terminality: row 33 keeps the state `activated` and moves only the shared
**task row** into the implementation lane; row 34 keeps the state `activated`
and leaves that row parked while the unchanged dependency gates still hold the
Issue (§11); and row 36 is the operator recovery command of §13 — the single
edge in this table that no automation can take. Row 46 likewise stays inside
`escalated_human`: it records that a handoff's comment could not be delivered,
and changes no state.

| # | State | Event | Guard | Next state | Effect |
| --- | --- | --- | --- | --- | --- |
| 1 | `pending` | `intake.scanned` | marker present, no executable `status:*`, at least one implementation-lane `agent:*` label | `pending` | admit a `refinement`-phase task; resolve and persist `context.assignment` |
| 2 | `pending` | `intake.scanned` | marker present with an executable `status:*` | `pending` | refuse admission; no task; `refinement.eligibility.refused` (`conflicting_markers`) |
| 3 | `pending` | `predecessors.resolved` | every direct predecessor usable in either §4 shape (open stack-ready head, or merged), count within cap, chain agrees | `eligible` | `refinement.eligibility.granted` |
| 4 | `pending` | `predecessors.resolved` | rows 5–7 do not apply, and at least one predecessor satisfies neither §4 shape | `pending` | hold; `refinement.eligibility.refused` (`predecessor_not_ready`); re-evaluated next poll |
| 5 | `pending` | `predecessors.resolved` | predecessor count above `MAX_PREDECESSORS_PER_REFINEMENT` | `escalated_human` | handoff (`fan_in_exceeded`) |
| 6 | `pending` | `predecessors.resolved` | observed predecessors disagree with the chain's accepted revision | `escalated_human` | handoff (`chain_disagreement`) |
| 7 | `pending` | `predecessors.resolved` | no direct predecessor | `escalated_human` | handoff (`not_chain_scoped`) |
| 8 | `eligible` | `roles.resolved` | refiner and critic resolve to two agents satisfying the independence rule of §7.3 | `eligible` | record both resolved roles on the task; `refinement.roles.resolved` |
| 9 | `eligible` | `roles.resolved` | no independent critic can be selected | `escalated_human` | handoff (`no_independent_critic`); no snapshot captured, no round spent |
| 10 | `eligible` | `snapshot.captured` | roles resolved, within snapshot caps | `drafting` | record `predecessorFingerprint`; `refinement.snapshot.captured` |
| 11 | `drafting` | `draft.returned` | well-formed refiner result | `critiquing` | `refinement.draft.recorded` |
| 12 | `drafting` | `draft.returned` | malformed, attempts below `MAX_MALFORMED_ATTEMPTS_PER_ROLE` | `drafting` | re-run the refiner; `refinement.draft.malformed` |
| 13 | `drafting` | `draft.returned` | malformed, attempts at cap | `escalated_human` | handoff (`malformed_refiner_output`) |
| 14 | `critiquing` | `critique.returned` | `pass`, no topology proposal | `accepted` | `refinement.critique.passed` |
| 15 | `critiquing` | `critique.returned` | `pass`, every proposal `advisory` by both parties | `accepted` | `refinement.critique.passed`; `refinement.topology.recorded` |
| 16 | `critiquing` | `critique.returned` | `pass`, any proposal `blocking` | `escalated_human` | handoff (`topology_change_required`); nothing applied |
| 17 | `critiquing` | `critique.returned` | `revise`, rounds used below `MAX_REFINEMENT_ROUNDS_PER_ISSUE` | `drafting` | `refinement.critique.revise`; objections handed back to the refiner |
| 18 | `critiquing` | `critique.returned` | `revise`, rounds used at cap | `escalated_human` | handoff (`no_convergence`) |
| 19 | `critiquing` | `critique.returned` | `block` | `escalated_human` | handoff (`critique_blocked`) |
| 20 | `critiquing` | `critique.returned` | malformed, attempts below `MAX_MALFORMED_ATTEMPTS_PER_ROLE` | `critiquing` | re-run the critic; `refinement.critique.malformed` |
| 21 | `critiquing` | `critique.returned` | malformed, attempts at cap | `escalated_human` | handoff (`malformed_critic_output`) |
| 22 | `accepted` | `apply.requested` | live fingerprint equals `predecessorFingerprint` | `applying` | persist the accepted refinement (commit point), including the `appliedRegionDigest` of the region step 3 will write; stamp the fingerprint precondition on the attempt's effects; `refinement.accepted.persisted` |
| 23 | `accepted` | `apply.requested` | fingerprint differs, restarts below `MAX_STALE_RESTARTS_PER_ISSUE` | `eligible` | discard the draft; `refinement.stale.detected`; re-snapshot |
| 24 | `accepted` | `apply.requested` | fingerprint differs, restarts at cap | `escalated_human` | handoff (`stale_inputs`) |
| 25 | `applying` | `effect.precondition.checked` | live fingerprint equals the stamped precondition, every marker precondition of §6 either holds or has its end state already reached, and the effect's stamped `appliedRegionDigest`, when it carries one, equals the live managed region | `applying` | perform this effect, or nothing when its end state already holds (rows 28–31 name what each one does) |
| 26 | `applying` | `effect.precondition.checked` | fingerprint differs, restarts below `MAX_STALE_RESTARTS_PER_ISSUE` | `eligible` | perform nothing; stop every still-undelivered effect of this attempt; `refinement.stale.detected`; re-snapshot |
| 27 | `applying` | `effect.precondition.checked` | fingerprint differs, restarts at cap | `escalated_human` | perform nothing; stop every still-undelivered effect; handoff (`stale_inputs`) |
| 28 | `applying` | `body.update.attempted` | managed region absent, or present and trusted | `applying` | write the managed region; `refinement.applied` |
| 29 | `applying` | `body.update.attempted` | managed region present but untrusted or malformed | `escalated_human` | handoff (`unexpected_managed_region` / `malformed_managed_region`) |
| 30 | `applying` | `comment.posted` | — | `applying` | post the audit comment; `refinement.comment.posted` |
| 31 | `applying` | `labels.transitioned` | atomic replacement, or the marker removal observed sent before the addition was enqueued; marker preconditions hold (§6) | `applying` | remove `status:needs-refinement`, then add `status:needs-implementation`, in that delivery order; the delivered addition's outbox row, durably `sent`, is the record row 45 reconciles from; the state does not move here |
| 32 | `applying` | `effect.dead_lettered` | a refinement effect exhausted its retry budget or was cancelled by an operator | `escalated_human` | handoff (`effect_undeliverable`); no later **application** stage (steps 3–5) is enqueued; the handoff's own ready-for-human label and comment are enqueued as fresh, precondition-free effects even when the dead-lettered effect was the audit comment (§11, §13) |
| 33 | `activated` | `intake.scanned` | the shared task row is parked `blocked` at phase `implementation`, the Issue carries `status:needs-implementation`, and the unchanged intake dependency gates admit it (Gate 1, or Gate 2's single open stack-ready blocker) | `activated` | reactivate the parked row to `queued` at phase `implementation` through the existing blocked-task reactivation path; `refinement.implementation.requeued` |
| 34 | `activated` | `intake.scanned` | the row is parked as in row 33 but the unchanged gates do not admit the Issue yet — more than one unsatisfied blocker, or a single open blocker that is not stack-ready | `activated` | leave the row parked and untouched; `refinement.implementation.held`; re-evaluated next poll (§11) |
| 35 | `activated` | any other event | — | `activated` | terminal; a redelivered step with the same fingerprint is an idempotent no-op |
| 36 | `escalated_human` | `operator.recovery.applied` | an operator ran the §13 recovery command with `--yes`; the task is `ready_for_human` at phase `refinement` | `pending` | clear the handoff reason, the accepted draft, and the counters; keep `context.assignment` and the applied-refinement record; re-queue the row at phase `refinement`; `refinement.recovery.applied` |
| 37 | `escalated_human` | any other event | — | `escalated_human` | terminal for automation; only an operator clears it, through row 36 |
| 38 | `drafting` | `agent.process.failed` | the existing phase classification calls the failure retryable (timeout, quota, transient provider error) and this role's process failures are below `MAX_AGENT_FAILURES_PER_ROLE` | `drafting` | re-run the refiner after the existing phase-level delay; `refinement.agent.failed`; no round and no malformed-attempt counter is spent |
| 39 | `drafting` | `agent.process.failed` | the classification is non-retryable, or this role's process failures are at cap | `escalated_human` | handoff (`agent_unavailable`); the task never reaches status `failed` (§17) |
| 40 | `critiquing` | `agent.process.failed` | the existing phase classification calls the failure retryable and this role's process failures are below `MAX_AGENT_FAILURES_PER_ROLE` | `critiquing` | re-run the critic after the existing phase-level delay; `refinement.agent.failed`; no round and no malformed-attempt counter is spent |
| 41 | `critiquing` | `agent.process.failed` | the classification is non-retryable, or this role's process failures are at cap | `escalated_human` | handoff (`agent_unavailable`); the task never reaches status `failed` (§17) |
| 42 | `applying` | `effect.precondition.checked` | live fingerprint matches, but a marker precondition of §6 does not hold and its end state is not already reached — an executable `status:*` other than the one being added is on the Issue | `escalated_human` | perform nothing; stop every still-undelivered effect of this attempt; handoff (`marker_precondition_failed`) |
| 43 | `applying` | `effect.precondition.checked` | fingerprint and marker preconditions hold, but the live managed region does not equal the effect's stamped `appliedRegionDigest` — edited, replaced, deleted, or made malformed after step 3 delivered — and stale restarts are below `MAX_STALE_RESTARTS_PER_ISSUE` | `eligible` | perform nothing; stop every still-undelivered effect of this attempt; `refinement.stale.detected`; re-snapshot |
| 44 | `applying` | `effect.precondition.checked` | the same region mismatch, stale restarts at cap | `escalated_human` | perform nothing; stop every still-undelivered effect; handoff (`managed_region_modified`) |
| 45 | `applying` | `activation.reconciled` | the attempt's final label effect is durably recorded `sent` (§11 step 6) | `activated` | in one TaskStore transaction, compare-and-set on the row still being this lane's: park the shared task row at `blocked`/phase `implementation` with `context.assignment` untouched, and move the refinement state to `activated`; a repeated pass is a no-op; `refinement.activated` |
| 46 | `escalated_human` | `handoff.comment.dead_lettered` | the handoff's own public comment exhausted its retry budget or was cancelled | `escalated_human` | the handoff stands on its local record — status `ready_for_human`, the persisted reason, and `refinement.escalated.human` — with no comment; record `refinement.handoff.comment.undeliverable`; no replacement comment is attempted (§13) |
| 47 | `pending` | `intake.scanned` | marker present, no executable `status:*`, and no implementation-lane `agent:*` label | `pending` | refuse admission; no task; `refinement.eligibility.refused` (`no_implementation_agent`); re-evaluated next poll |

## 13. Human handoff

Handoff is the single exceptional outcome. Every escalation in §12 does the
same four things — with exactly two documented exceptions: one to item 2,
covering the handoffs named below, and one to item 4, covering the handoff
whose own comment cannot be delivered. The §3.1 execution guard raises its
`execution_marker_conflict` handoff in this same shape, on a task that never
entered the §12 state machine:

1. sets the task status to `ready_for_human`;
2. **leaves `status:needs-refinement` in place** and does **not** add any
   executable `status:*` label, so the Issue cannot drift into implementation
   while a human is deciding;
3. adds the session's ready-for-human label;
4. posts one public comment carrying the handoff reason literal and the §16
   fields, and nothing else — through a fresh outbox effect with its own retry
   budget and no fingerprint, marker, or region precondition, so that whatever
   stopped the lane cannot also stop the notification that it stopped
   (§11; row 32 in particular forbids only later *application* stages).

The preconditions item 4 is free of are the lane's own — the §6 fingerprint, the
§10 managed region, the §11 label markers. Its **delivery** carries exactly one:
the comment body opens with an idempotency marker derived from the effect's key,
and the dispatcher publishes only after confirming the Issue does not already
carry a comment bearing it. That check answers a question the outbox key cannot —
whether a previous attempt's POST reached GitHub before the attempt lost its
claim — and it is what makes "exactly one comment per handoff" hold across a
crashed or reclaimed dispatch rather than only across a re-derived transition. A
comment history that cannot be READ is not an absent comment: the effect fails,
retries on its budget, and dead-letters visibly, because a duplicate handoff
notice is the one outcome §16 rules out outright.

The read and the POST are two calls, though, so the guard is **fenced on the
dispatch claim as well**: an attempt re-asserts the claim it holds after reading
the history and before publishing, and an attempt that no longer holds it stops
instead of posting beside whoever took the row. Nothing at this layer can make
the pair atomic — the provider offers no conditional create — so what remains is
a POST that outruns a claim lease renewed moments earlier, rather than a read and
a POST that together outrun whatever was left of it.

**The handoff stands even when its comment cannot be delivered.** Item 4 is a
GitHub write, and every GitHub write in this contract can fail permanently — the
comment topic can dead-letter for the whole session (a revoked token, a
repository archived mid-run), which is exactly the case in which the handoff
that item 4 announces was itself raised as `effect_undeliverable`. The contract
resolves this explicitly rather than requiring a comment it cannot guarantee:

- The **load-bearing** parts of a handoff are local and transactional — task
  status `ready_for_human`, the persisted handoff reason, and the
  `refinement.escalated.human` audit event. Those three are what stop the lane,
  what `admin` surfaces show, and what the §13 recovery command acts on. None of
  them depends on GitHub.
- The public comment is **required whenever GitHub accepts it**, and it gets its
  own effect and its own full retry budget for that reason. It is not a copy of
  the dead-lettered effect and does not inherit its exhausted budget.
- If that comment effect *also* dead-letters, the handoff stands without it:
  the lane records `refinement.handoff.comment.undeliverable` (§12, row 46) and
  **attempts no replacement comment**. Retrying a comment through the surface
  that just proved undeliverable is the one loop this contract will not enter,
  and a handoff that could be undone by a failed notification would be worse
  than one that is merely quiet. The ready-for-human label add is the same
  shape and the same disposition.
- Consequently §16's "exactly one comment per handoff" is an upper bound as
  well as the norm: exactly one when it can be delivered, none when the comment
  effect itself dead-letters, and never two.
- Row 46 is recorded **where the row dies**, which is outside every task
  transaction: the dispatch run whose failure exhausts the retry budget writes
  it, and so does the operator `outbox cancel` that retires the row by hand,
  since a cancelled effect is as undelivered as an exhausted one. It is written
  at most once per effect — a later `outbox retry` that dead-letters the same
  row again reports no new fact — and it carries literals only, never the
  provider error text, which stays on the outbox row where `admin outbox list`
  already shows it. Without this record the task is the one surface that could
  say the notice was lost and does not: the Issue shows nothing by definition.
- Recording it is **not a single shot**. The row's death and the record are two
  writes against different tables and cannot be made atomic, so the second can
  fail on its own — and a dead-lettered row is never selected for dispatch
  again, so nothing would carry the fact a second time. The dead-lettered rows
  themselves are the repair record: they stay listable, and they carry the
  effect key the event is derived from and the disposition that killed them, so
  every later dispatch run re-derives row 46 for any terminal handoff comment
  still missing it, and an `outbox cancel` re-run against an already-cancelled
  row does the same. Both are no-ops once the event exists, which is what keeps
  "at most once per effect" true while making it recoverable.

**A handoff raised after the marker removal landed cannot leave the marker in
place, and says so.** `marker_precondition_failed` (row 42) is raised only after
the removal effect of §11 step 5 has already landed, so the marker is gone by
construction; `stale_inputs` (row 27), `managed_region_modified` (row 44), and
`effect_undeliverable` (row 32) reach the same shape whenever the effect that
fails is the label addition rather than an earlier one. Every other handoff is
raised before step 5 has moved any label, so item 2 above holds verbatim for it.
The lane does not re-add the marker: re-adding it beside the executable status an
operator applied by hand would produce exactly the both-markers combination §3
refuses, which routes nowhere at all — and after the other three reasons the
addition never landed, so re-adding a marker the operator may be mid-way through
replacing helps nothing either. What keeps the Issue out of implementation in
that window is the shared task row rather than the label — it survives at
`ready_for_human`, phase `refinement`, so the next intake scan refuses the
implementation enqueue as a duplicate, the same mechanism the manual skip below
relies on. Everything else about the handoff is unchanged: no executable status
is added by the lane, the ready-for-human label is added, and one comment
carries the reason literal. The operator then has exactly the two exits below —
cancel the row and let the hand-applied status stand (the skip path, whose
label step is already done for them), or restore the label shape and run the
recovery command.

No automatic transition leaves `escalated_human`. Clearing it is an operator
action: fix the Issue, fix the relationship graph, or accept the topology
recommendation manually, then either skip refinement and hand the Issue to
implementation by hand, or run the recovery command below to try refinement
again.

**Skipping refinement is a label _replacement_, not a label addition.** The
marker was deliberately left in place, so adding an executable `status:*`
label beside it produces exactly the both-markers combination §3 refuses
outright — intake would then neither refine nor implement the Issue, and the
skip would not start anything. Handing the Issue to implementation manually is
therefore two ordinary operator steps, in this order:

1. **Remove `status:needs-refinement` first, then add
   `status:needs-implementation`** — the same removal-before-addition ordering
   §11 step 5 gives the automatic path, so the Issue never carries both
   markers at once.
2. **Dispose of the stranded refinement task row** with `admin task cancel`.
   That row still exists at status `ready_for_human`, phase `refinement`;
   left in place, the next intake scan finds it and refuses the implementation
   enqueue as a duplicate, exactly as it does for the re-labelling case below.

This lane adds no command for either step, and the refinement state of the
cancelled row stays `escalated_human`. That is correct: the Issue left the
refinement lane rather than completing it, and nothing in §12 claims otherwise.

**Recovery is an explicit command, because re-labelling cannot work.** The
marker was deliberately left in place, so it is already present and re-applying
it changes nothing; the task row also still exists, so the next intake scan
finds it and refuses the enqueue as a duplicate. Automation has no way to
observe "the human fixed it." Recovery is therefore its own operator surface:

```
admin refinement recover --session-ref <ref> --issue-number <n> [--yes]
```

Normative behavior, modelled on the existing handoff-recovery commands:

- It targets exactly one task: status `ready_for_human`, phase `refinement`,
  `context.refinement.state` = `escalated_human`. Any other status, phase, or
  refinement state is refused, and so is a claimed or running task.
- It previews by default and applies only with `--yes`.
- **It applies only when the Issue carries the row-1 admissible label shape** —
  `status:needs-refinement` present and no executable `status:*` label. Every
  handoff raised before §11 step 5 moved a label leaves that shape untouched, so
  the check is invisible on those paths; after a handoff raised once the removal
  had landed — `marker_precondition_failed` always, and `stale_inputs`,
  `managed_region_modified`, or `effect_undeliverable` when the failing effect
  was the label addition — the operator must first re-add the marker, and remove
  the executable status too when one is present. The preview reports the observed
  labels and names the missing step, and applying against any other shape is
  refused rather than half-performed — recovery returns the state to `pending`,
  and an Issue that carries an executable status there is precisely what row 2
  refuses to admit.
- Applying it performs row 36: the handoff reason, the accepted draft, the
  snapshot, and the round/malformed/stale counters are cleared; the refinement
  state returns to `pending`; the task row returns to `queued` at phase
  `refinement`; the session's ready-for-human label is removed through the
  outbox. `status:needs-refinement` is untouched: on every handoff reason but
  `marker_precondition_failed` it never left, and on that one the label check
  above has already established that the operator put it back.
- **`context.assignment` is preserved, not re-resolved** (§14). Recovery is a
  retry of the same work item, not a re-admission of it.
- **The record of the fingerprint actually applied is preserved too** (§6). A
  handoff can happen after the body write has already landed — row 42 is
  reached only in that window, and a `marker_precondition_failed` recovery is
  therefore the common case — and §10 trusts a managed region only while
  SQLite records the applied refinement that produced it. Clearing that record
  would make the retry escalate `unexpected_managed_region` against the lane's
  own write, replacing one stuck state with another.
- The next poll re-evaluates eligibility from `pending`, so a condition the
  operator did not actually fix simply escalates again. Each retry costs one
  deliberate command; nothing here re-enters automatically.

There is deliberately no command that resumes a handoff mid-lane — no way to
re-run only the critic, or to apply a draft the critic rejected. Recovery
restarts the attempt from `pending` or it does nothing.

Refinement never handles a predecessor failure. If a predecessor's PR is
closed unmerged, or its stack-ready marker is withdrawn while the PR is still
open, the next eligibility evaluation simply stops finding a usable result and
the Issue holds at `pending` (row 4) until a human intervenes — the same posture
the dependency gate already takes. A predecessor that **merged** is not a
failure and is not held: it satisfies the merged shape of §4, so the hold in
row 4 is reserved for predecessors whose result does not exist yet or no longer
passes, never for one whose result was accepted into the base branch. The one
predecessor shape that can still hold this lane indefinitely — a predecessor
closed with its PR closed unmerged — is recorded as gap G5 in §21.

## 14. Assignment and profile retention

The target implementation assignment must survive refinement without being
encoded as extra labels. The rules:

- **`context.assignment` is the source of truth**, exactly as in
  [assignment-profiles.md](assignment-profiles.md). It is resolved once when
  the refinement task is admitted (row 1) — from the Issue's flow, trusted
  config, and its single `agent:*` label — and written onto the task.
- **The `agent:*` label on a refinement-marked Issue names the intended
  *implementation* owner**, not the refiner. It is the same coarse queue hint
  it already is, and it is the seed for `context.assignment.implementationAgent`.
  It is **required** at admission and retained through activation (§3, §4
  condition 1): it is a hint for this lane, but it is a routing *precondition*
  for the ordinary intake pass that reactivates the parked row.
- **The refiner and critic are resolved from the assignment profile**, as two
  additional roles (`refinementAgent`, `refinementCriticAgent`) alongside the
  existing implementation/review/conflict/research roles. They are never
  expressed as labels, and the critic's independence requirement (§7.3) is
  enforced against the resolved profile, not against labels.
- **Activation neither adds nor removes an `agent:*` label, and re-derives
  nothing.** Step 5 of §11 moves the two status labels only —
  `status:needs-refinement` out, `status:needs-implementation` in — and leaves
  the pre-existing `agent:*` label untouched, so the Issue ends the lane
  carrying the ordinary implementation label pair. The implementation phase
  still reads its owner from the persisted `context.assignment`, never from
  that label; this mirrors the existing rule that the implementation→review
  transition must not re-add an `agent:<impl>` label to remember the
  implementation owner. A label that disagrees with the pinned assignment —
  an operator edit mid-lane, or a config override that resolved a different
  implementation agent at row 1 — changes nothing but the lane the candidate is
  routed on: reactivation restores the pinned assignment (last bullet), so the
  label decides *that* the row is picked up, never *who* runs it.
- The refinement task and the implementation task are the same task row,
  moving between phases; the assignment captured at admission is carried
  forward, not re-resolved from a possibly-edited `sessions.json`.
- **The handover between the two phases is the park-and-reactivate of §11
  steps 6–7**, not a second task row. Activation parks the row at
  `blocked`/phase `implementation`; ordinary intake reactivates it. The
  reactivation path merges fresh intake context over the retained context and
  restores the pinned assignment, which is exactly the retention rule above —
  so the implementation phase reads the assignment resolved at row 1, even
  though intake re-resolved one of its own while scanning.

## 15. Persistence, artifacts, and audit events

**Task context** (`task.context.refinement`): the state literal, the
`predecessorFingerprint`, the `appliedRegionDigest` of the region this attempt
rendered (§6), the predecessor list (Issue numbers, PR numbers,
head SHAs), the round counters, per-role malformed-attempt counters, per-role
agent process-failure counters, the
stale-restart counter, the accepted refined contract, the recorded advisory
proposals, the refiner's and critic's `confidence` literals, the handoff
reason when escalated, and — while a retryable agent process failure awaits
its delayed re-run (§12, rows 38 and 40; §17) — the resumable mid-round
retry record: the role, round, and attempt to resume, plus the validated
draft (critic re-run) or the previous round's contract and objections
(refiner re-run) the deferred turn re-runs against.

**Artifacts** (local-only, never published): under
`<artifactRoot>/issue-refinement/issue-<n>/<runId>/` — the snapshot bundle
and its manifest (including which fields were truncated), the raw refiner and
critic transcripts written before parsing, the rendered managed region, and a
run manifest carrying agent/model/effort per role. Artifact paths never
appear in any GitHub comment or Issue body.

**Audit events** are named `refinement.<subject>.<action>`. Every transition
in §12 that changes state, records a refusal or a hold, or moves the shared
task row emits exactly one: `refinement.eligibility.granted`,
`refinement.eligibility.refused`, `refinement.roles.resolved`,
`refinement.snapshot.captured`, `refinement.draft.recorded`,
`refinement.draft.malformed`, `refinement.critique.passed`,
`refinement.critique.revise`, `refinement.critique.malformed`,
`refinement.agent.failed`,
`refinement.topology.recorded`, `refinement.accepted.persisted`,
`refinement.stale.detected`, `refinement.applied`,
`refinement.comment.posted`, `refinement.activated`,
`refinement.implementation.requeued`, `refinement.implementation.held`,
`refinement.recovery.applied`, `refinement.escalated.human`,
`refinement.execution.suspended`,
`refinement.handoff.comment.undeliverable`.

Four of these exist so that no state-changing row has to share or borrow an
event name: `refinement.accepted.persisted` records the `accepted` → `applying`
commit point (row 22), which is a different fact from `refinement.applied`
(row 28, the body write); `refinement.implementation.requeued` records the
handover of the shared task row (row 33); `refinement.implementation.held`
records a poll that found the parked row still held by the unchanged
dependency gates (row 34), which is what makes a long fan-in wait observable
rather than silent; and `refinement.recovery.applied` records the operator
recovery (row 36). `refinement.activated` belongs to the reconciliation of row
45 — the transaction that parks the shared task row and moves the state — not to
the label delivery of row 31, which changes no state and emits nothing: the
durable `sent` outbox row is that delivery's record, and emitting an activation
event there would report an activation that had not yet committed.
`refinement.agent.failed` is likewise its own event because
a process failure is a different fact from malformed output: rows 38 and 40
emit it when nothing was returned to parse, so no malformed-attempt counter
moved and the `refinement.draft.malformed` / `refinement.critique.malformed`
pair would misreport what happened.

Two events belong to tasks and effects outside the §12 state machine, and exist
so that neither is silent. `refinement.execution.suspended` records the
pre-execution marker guard of §3.1 stopping an already-existing executable task
— that task carries no refinement state, so no §12 row could record it.
`refinement.handoff.comment.undeliverable` records a handoff whose public
comment could not be delivered (§12, row 46): the handoff is otherwise
invisible on GitHub, so this event and the persisted handoff reason are the only
record an operator has.

Event fields: task id, issue number, refinement state, predecessor Issue
numbers, the `predecessorFingerprint`, actor role
(`refiner` | `critic` | `runner`), provider/agent id, model, effort, the
outcome or handoff-reason literal, the round and attempt counters, and
timestamps. Events carry literals and counters only — never refined prose,
snapshot content, agent reasoning, or local paths.

## 16. Public GitHub comment policy

Every applied refinement leaves exactly one auditable comment, posted at step
4 of §11. Every handoff leaves exactly one comment (§13) — with the single
exception §13 defines: when the handoff's own comment effect dead-letters the
handoff stands with no comment at all (§12, row 46), and no replacement is
attempted. One or none, never two. No other comment is posted by this lane.

An applied-refinement comment contains at most:

- the source predecessor references — Issue numbers, PR numbers, and PR head
  SHAs, taken from the snapshot;
- the `predecessorFingerprint` prefix that identifies the applied region;
- the agent id, model, and effort used for the refiner and for the critic,
  the critic's verdict literal, and both roles' `confidence` literals;
- the counts: rounds used, malformed attempts, stale restarts;
- the advisory topology proposals, when any, explicitly labelled as
  recommendations that were **not** applied;
- a pointer to the managed region of the Issue body, which is where the
  refined content itself already lives.

A handoff comment (§13 item 4) contains at most:

- the phase (`refinement`) and the terminal state literal (`escalated_human`);
- the handoff reason literal;
- the §8 counters and the limits in force for the attempt: rounds used,
  malformed attempts per role, agent process failures per role, stale restarts;
- the agent id, provider, model, effort, and invocation count resolved for the
  refiner and for the critic, when the attempt reached role resolution;
- whether the coarse marker was left in place (§13 item 2), so the reader is not
  told to expect a label that a post-step-5 handoff has already removed;
- the next supported operator action for that reason, and the §13 exit an
  operator can take from a terminal handoff.

Never published: local filesystem paths, artifact paths, run/session/task
identifiers, raw agent output, agent reasoning, provider error text, snapshot
excerpts of predecessor bodies or comments, or repository file contents.

That list binds the handoff comment exactly as it binds the applied-refinement
one. The run id in particular is a run identifier and is never published, so the
"run metadata" a handoff carries is the resolved role metadata above —
configuration, not a correlation id. An operator who needs the run id has
`admin task-status`.

The comment is metadata about a change the reader can already see in the
Issue body; it does not restate that change.

## 17. Fail-closed behavior for malformed agent output

**Malformed** is any of: output that is not exactly one fenced JSON object;
an unparseable object; an unknown or missing enum literal; a missing required
field; a `pass` verdict carrying objections; a `revise` verdict carrying no
objection; a critic result containing replacement prose; a
`predecessorReferences` entry naming an Issue or PR absent from the snapshot;
any output containing the managed-region markers; any output containing an
absolute or repository-external filesystem path; or a rendered region above
`MAX_MANAGED_REGION_BYTES`.

Malformed output is never partially salvaged. The raw transcript is written
to the artifact directory before parsing, the attempt counter for that role
increments, and the role is re-run below the cap or escalated at it (rows
12/13 and 20/21). Nothing is applied from a malformed result, and a malformed
result never advances the round counter.

An agent process failure — non-zero exit, quota, timeout — is not malformed
output: nothing was returned, so there is nothing to salvage, no
malformed-attempt counter moves, and no round is spent. **Classifying** such a
failure stays with the existing agent-diagnostic provenance and retry
classification in [phase-contracts.md](phase-contracts.md); refinement adds no
second classifier and no second backoff. What this contract must add is the
**disposition**, because the generic phase-failure path ends at task status
`failed`, and a `failed` task is a dead end for this lane: `status:needs-refinement`
is still on the Issue, so it is not implementable, and there is no
`ready_for_human` refinement row for the §13 recovery command or row 36 to act
on. So:

- A failure the existing classification calls **retryable** — a timeout, quota
  exhaustion, a transient provider error — re-runs the same role in the same
  state after the phase-level delay that classification already prescribes, up
  to `MAX_AGENT_FAILURES_PER_ROLE` per role (§12, rows 38 and 40), emitting
  `refinement.agent.failed`. The refinement state does not move, and neither
  the round counter nor the malformed-attempt counter advances.
- A failure the classification calls **non-retryable**, and any failure once
  that per-role cap is reached, escalates with reason `agent_unavailable`
  (§12, rows 39 and 41). That is an ordinary handoff in every respect (§13):
  the task becomes `ready_for_human` at phase `refinement`,
  `status:needs-refinement` stays on the Issue, no executable status is added,
  one comment carries the reason literal, and `admin refinement recover`
  applies unchanged — an operator who fixes the provider outage or quota re-runs
  the attempt from `pending` with one command.

No agent process failure therefore leaves the refinement phase at task status
`failed`: the lane converts it into either a bounded retry or a recoverable
handoff, so an Issue that carries the marker always has an operator surface
that can move it.

## 18. Compatibility with existing surfaces

**`issue-discuss` (#229, #244–#246).** Untouched. It remains the standalone
manual lane: read-only preview, operator `--approve`, comment-only post,
never a body edit. The automatic lane neither calls it nor requires it. §2 is
the normative separation.

**`issue-plan` and the planning gate (#295, #357/#358).** Untouched, and
read-only from this lane's perspective. An existing local `issue-plan`
artifact for the Issue is an *input* to the refiner (§5). The planning gate's
`decision` and `readyForImplementation` do **not** gate refinement: a rough
Issue is expected to look `needs_clarification` before refinement, and
requiring `ready` would deadlock the lane. Refinement does not write, update,
or invalidate planning artifacts; a stale planning artifact is simply an
input the critic can object to as `unsupported`.

**GitHub Issue Relationships.** The authoritative source of the predecessor
edge set (§5), read through the same relationship checker the dependency gate
uses. Refinement never creates, removes, or rewires a relationship — those
are advisory proposals only (§9).

**`status:stack-ready`.** Reused verbatim as the readiness signal, with the
same success-only meaning and the same resolver as the Gate 2 implementation
start gate. Refinement adds no new readiness marker and changes nothing about
how stack-ready is set or consumed. An Issue may be both refinement-eligible
and, after activation, Gate-2 stackable on the same predecessor. Refinement
does accept one input shape Gate 2 does not — a **merged** predecessor PR (§4)
— because refinement reads a predecessor's decisions while Gate 2 picks a
branch start point, and a merged predecessor has no open head to branch from
but its decisions are final. That is an addition on the refinement side only:
the Gate 2 resolver keeps its open-PR requirement unchanged, and a merged
predecessor reaches implementation through the ordinary closed-blocker gate
(Gate 1) exactly as it does today.

**Chain registry (#788, #790, #890, #892).** Read-only. The registry's
accepted revision is the cross-check that the observed predecessor set is the
one the chain expects (§4, row 6); disagreement escalates rather than
choosing a side. Refinement never registers a member, adds an edge, moves a
revision pointer, or touches a frozen prefix.

**Dormant-first contract.** Unchanged and still required. Because
`status:needs-refinement` is not executable it cannot itself lose the
label-versus-relationship race, but it must still be applied after
relationships are configured and verified, so the first eligibility
evaluation sees the true predecessor set.

**Review-dispute protocol (#835).** Independent. Refinement reads only
terminal lineage literals and counts from a predecessor (§5) and follows the
same "shape, never content" comment posture (§16).

**Outbox — reused as the only mutation path, but it must be extended three
times.** The outbox stays the single vehicle for every GitHub mutation in this
contract, and no second queue, dispatch process, or out-of-band write path is
introduced. It cannot, however, carry this contract unchanged. Today's payload
union is `gh:comment` / `gh:label:add` / `gh:label:remove` plus the
provider-neutral `workitem:*` and `repohost:*` topics; its dispatcher performs
each row once it is claimed — checking nothing about the Issue beyond whether
this row's own comment already landed (§13 item 4's marker) — and all it can do
afterwards is mark that row sent. Three capabilities this contract depends on are therefore
missing, and the follow-up implementation Issue owns all three:

1. **An Issue-body update effect.** Step 3 of §11 has no topic to enqueue: no
   payload in the union edits a work-item body, and no `WorkItemProvider`
   method does either — the port offers `commentItem` and `transitionItem`
   only. Required: a new provider-neutral topic (`workitem:body-update` in the
   existing naming) whose payload carries the provider kind, `owner`/`repo`,
   the Issue number, and the rendered body; a matching dispatcher case; and a
   body-update method on `WorkItemProvider` implemented for each work-item
   backend. The renderer stays runner-side (§10), so the payload carries the
   final body text and the dispatcher makes exactly one write. Until that
   effect exists, step 3 cannot be dispatched at all, and the lane must stay
   disabled (§19) rather than write the body outside the outbox.
2. **A dispatch-time precondition, evaluated per effect.** §6 requires the
   live `predecessorFingerprint` and the marker preconditions to be recomputed
   *immediately before* an effect is performed; today nothing recomputes
   anything at dispatch, so a row that waited in the queue is delivered against
   whatever state it finds. Required: an optional precondition descriptor
   persisted on the effect (the accepted fingerprint, plus the required-present
   and required-absent labels of §6), a precondition evaluator injected into
   the dispatcher — it needs GitHub reads the dispatcher does not perform
   today — and a **terminal, non-retrying** disposition for a failed check.
   That disposition is neither `markSent` nor a retryable `markFailed`: an
   effect whose precondition no longer holds must be stopped the way an
   operator cancellation stops a row, recording the reason, consuming no retry
   budget, and never being delivered later. Rows 25–27 of §12 are the lane's
   view of that mechanism. The descriptor carries three things, not one: the
   accepted `predecessorFingerprint`, the required-present and required-absent
   labels of §6, and the `appliedRegionDigest` of §6 for every effect enqueued
   after the body update — the region is excluded from the fingerprint, so
   without that third field the evaluator cannot see an edit inside it and rows
   43–44 are unenforceable. The handoff comment of §13 item 4 already carries a
   narrower, self-contained cousin of this: a marker its dispatcher looks for on
   the Issue before publishing, whose only question is "did a previous attempt at
   THIS row already land". It reads no fingerprint and no label, refuses nothing,
   and settles the row as delivered when the answer is yes — so it is an
   at-most-once delivery guard, not the §6 evaluator described here, and it
   leaves all three requirements above outstanding.
3. **A durable activation reconciliation.** Step 6 of §11 must park the shared
   task row once the final label effect is delivered, and that park cannot ride
   inside the delivery: the delivery is a call to GitHub, and today's dispatcher
   has no TaskStore transaction and no completion callback that could carry a
   local write with it. Treating the two as one transaction would be a
   specification that no implementation can honour, and the crash between them
   is not benign — the Issue carries `status:needs-implementation` while the
   shared row is still un-parked at phase `refinement`, so ordinary intake
   refuses the implementation enqueue as a duplicate on every later poll and the
   Issue never starts. Required: the delivered effect's `sent` state is durable
   and attributable to its refinement attempt, plus a reconciliation pass —
   owned by the runner, driven by that persisted state, and run at the start of
   every poll before intake evaluates any Issue — that performs the park and the
   state move in **one TaskStore transaction**, compare-and-set so that
   re-running it is a no-op (§12, row 45). A dispatcher completion callback that
   performs the same transaction inline is a permitted optimization; the
   reconciliation pass is what makes the outcome crash-consistent, so it is the
   requirement.

Everything else about the outbox is genuinely unchanged: claim/retry/backoff,
dead-lettering, the maintenance lock (#818), the scan cursors (#819/#820), the
session-scoped ownership filter, and the visibility policy all apply to
refinement effects exactly as they apply to every other row. The
one-stage-in-flight enqueue discipline of §11 *is* purely a runner-side
property and needs no dispatcher change. A refinement effect that dead-letters
or is cancelled through the existing operator surfaces is observed by this lane
as row 32, so an operator cancelling a queued refinement effect stops the lane
rather than half-applying it. Dead-lettering has one lane-specific consequence
the outbox itself does not know about: the resulting handoff enqueues its own
comment as a **new** row with a fresh retry budget and no precondition
descriptor, and if that row dead-letters too the lane stops attempting comments
altogether (§13, §12 row 46) rather than re-enqueueing against a surface that
has already proved undeliverable.

**Phase runner — one required guard, outside the outbox.** §3.1 requires the
runner to re-read the Issue's live labels immediately before it starts a task at
an executable phase, and again immediately before that run's outward effects are
enqueued, refusing both when `status:needs-refinement` is present. Today's runner
does neither: it trusts the labels recorded at intake, and a task enqueued before
the marker was applied runs unimpeded. The follow-up implementation owns this
guard together with the three outbox extensions above. It is deliberately *not*
an outbox precondition: the first check happens before any effect exists, and its
subject is a task at an executable phase rather than a refinement effect. It
reuses the existing cooperative cancellation (`TaskStore.cancelTask`, issue #608)
for a run already in flight and adds no force-kill, no new task status, and no
new label. Until it lands, the mutual exclusion of §3 holds only for Issues with
no pre-existing task — which is why the lane stays disabled by default (§19).

**Task statuses and the intake enqueue path.** Reused as-is, gates included.
Activation parks the shared row at `blocked`/phase `implementation` precisely
so the existing reactivation branch of the intake enqueue applies — the same
branch a dependency-held implementation task already takes (issue #224). The
park itself is performed by the reconciliation of extension 3, which is why that
extension is required rather than optional: an un-parked row is not a row the
reactivation branch can take, and intake refuses it as a duplicate instead.
Refinement introduces no new task status, no refinement-specific enqueue, and
no change to the duplicate-refusal behavior for every other shape. It also
makes **no change to the dependency gates**: Gate 1 still requires every
`blocked by` Issue satisfied and Gate 2 still admits exactly one open
unsatisfied blocker, so an activated Issue whose fan-in exceeds what those
gates admit stays parked until the chain closes it out (§11, §12 row 34).
Widening Gate 2 to admit a multi-blocker stack is a separate decision this
contract deliberately does not take.

**The intake router (`labelsToPhase`) is unchanged, and that is why the
`agent:*` label is required.** The reactivation branch above is reached only
through a candidate, and the router builds a new-implementation candidate from
the pair `agent:*` + `status:needs-implementation` — never from
`status:needs-implementation` alone, and never by reading a persisted
`context.assignment` it deliberately does not consult (issue #292). This
contract meets that requirement by keeping the existing label on the Issue for
the whole lane (§3, §14) rather than by teaching the router a new way to
recover an assignment: refinement requires the label at admission (row 1),
refuses admission without it (row 47), and leaves it in place at activation
(§11 step 5). A design that dropped the label and instead reactivated from the
persisted assignment was rejected in §20.2.

**Task phases.** `refinement` is a new `TaskPhase`. The follow-up
implementation must teach the surfaces that enumerate phases — the phase
runner's supported-phase set, the worktree phase set, and the admin status
projections — about it, in the same way a new task status had to be taught to
`classifyStatus`. One behavior of the shared runner is deliberately *not*
inherited: §17 forbids a refinement task ending at status `failed`, so the
generic phase-failure disposition is overridden for this phase — a terminal
agent process failure is recorded as `ready_for_human` with handoff reason
`agent_unavailable`, the disposition the runner already has for every other
outcome that hands work to a human.

## 19. Configuration

```jsonc
{
  "issueRefinement": {
    "enabled": false,                 // default; the whole lane is off
    "limits": { /* §8 constants; may only be lowered */ },
    "agents": {
      "refiner": "…",                 // resolved from the assignment profile
      "critic": "…",
      "allowSameProvider": false      // §7.3; never allows the same model
    }
  }
}
```

With `enabled` absent or `false`, `status:needs-refinement` is an inert label:
intake ignores it, no refinement task is created, and an Issue carrying it
alongside an executable status is routed exactly as it is today. Enabling the
lane changes behavior only for Issues carrying the marker.

## 20. Decision record

### 20.1 Chosen

- **One coarse label, all detail in SQLite.** Consistent with the existing
  assignment-vs-labels boundary and with keeping the queue readable by a
  human at a glance.
- **Stack-ready, not merged, as the readiness signal.** Reuses Gate 2's exact
  semantics; waiting for merge would serialize the chain behind human merge
  decisions.
- **But a merged predecessor still counts as usable.** Gate 2's resolver
  requires an open PR, so keying eligibility on it alone would strand any
  dependent whose predecessor merged before the next poll — held at `pending`
  precisely when Gate 1 would already admit it. Accepting the merged shape costs
  nothing in safety: the merge is this loop's final human gate, so a merged
  head is a stronger signal than an open one.
- **Two agents, independence required, no self-critique fallback.** A single
  agent grading its own refinement gives no independent signal; failing
  closed when no independent critic exists is cheaper than a false pass.
- **A managed body region rather than whole-body replacement.** Preserves
  operator prose byte-for-byte, makes reapplication idempotent, and makes the
  applied delta exactly auditable.
- **Fingerprint re-verified immediately before the commit point — and therefore
  before the first mutation — with discard-and-restart on mismatch.** A merge of
  a stale draft into fresh inputs is unauditable; a re-run is bounded and cheap.
  Verifying *before* persisting rather than after is what keeps the stale path
  free of anything to undo: no accepted record is written for a contract that
  turns out to be stale (§11, §12 row 22).
- **The fingerprint covers every snapshot input, minus the lane's own two
  writes.** A guard that hashed only PR head SHAs and the raw body would accept
  a draft written against a predecessor title, changed-path set, review outcome,
  or comment that has since changed — the staleness guarantee would be narrower
  than the evidence it protects. Conversely, hashing the managed region or the
  two lane-owned labels would deadlock the lane against its own step-3 body
  write and its own step-5 label transition, so those two are excluded by name
  and guarded by their own preconditions instead of by silence — marker
  preconditions for the labels, the `appliedRegionDigest` for the region. The
  cost is that an
  unrelated comment landing mid-attempt spends a stale restart; a re-run is
  bounded and cheap, and a human commenting on a predecessor mid-refinement is a
  reasonable moment to re-read the evidence.
- **The label transition is a replacement, removal first.** Two independent
  label effects with no ordering rule can put the Issue in the both-markers
  state §3 refuses — and the router in place today admits that state to
  implementation rather than refusing it, which is the one outcome this whole
  ordering exists to prevent. The no-marker window that removal-first creates is
  inert by construction.
- **The fingerprint travels with the effect and is re-checked at dispatch.**
  An enqueue-time check alone only proves the inputs were fresh when the row
  was written, and a deferred dispatcher can deliver it arbitrarily later; the
  precondition is what makes "stale refinements are never applied" true of the
  moment the write actually happens.
- **The excluded managed region is guarded by its own digest, not by trust.**
  Eliding the region is what lets the lane's own body write coexist with the
  preconditions of the effects after it, but an exclusion with nothing behind it
  would let an edit *inside* the region ride through every later check and be
  activated as if a critic had passed it. Stamping the rendered region's digest
  on those later effects keeps the exclusion narrow: the lane's own write no
  longer invalidates its own steps, and anyone else's write still does (§6, §10).
- **The park is reconciled from the delivered effect, not transacted with it.**
  A GitHub label write and a SQLite park cannot be atomic, so specifying them as
  one transaction would specify something unbuildable and leave the crash between
  them undefined — the worst of both. Reconciling from the durable `sent` row
  instead makes the park re-derivable at any later poll, which turns that crash
  window from a permanent stall into a transient one (§11 step 6, §18).
- **One stage in flight at a time.** With independently-retrying outbox rows,
  delivery order — and therefore the label-last guarantee — would otherwise be
  a scheduling accident.
- **Label transition last in the activation order.** The only ordering under
  which no crash can activate an unrefined Issue.
- **Activation parks the shared task row instead of creating a second one.**
  §14 requires one row; parking at `blocked`/`implementation` reuses the
  existing dependency-hold reactivation shape, so the refined Issue actually
  reaches implementation without a bespoke enqueue that would bypass the
  dependency gate.
- **An agent process failure escalates instead of failing the task.** A
  timeout or a quota exhaustion is the most ordinary failure this lane will
  meet, and the generic phase-failure path ends at task status `failed` — a
  state from which the marker is still on the Issue and no recovery command
  applies. A bounded retry followed by an `agent_unavailable` handoff keeps
  every failure on a state an operator can move (§17).
- **A failed marker precondition at dispatch is a handoff, not a refusal.** The
  task is already `applying` with half its label transition delivered, so the
  pending-admission refusal literal does not fit it and leaving it in `applying`
  would strand it. `marker_precondition_failed` gives that window a terminal,
  recoverable state, and the recovery command's label-shape check is what makes
  the retry well-defined (§6, §13).
- **Handoff recovery is an explicit operator command.** The marker is already
  present after a handoff and the task row already exists, so nothing an
  operator can do to GitHub alone re-enters the lane; leaving that implicit is
  how a handed-off Issue becomes permanently stuck.
- **Topology proposals fail closed unless both agents call them advisory.**
  Splitting and rewiring change what the work *is*; that stays a human
  decision.
- **Extend the outbox rather than write around it.** The body update, the
  dispatch-time precondition, and the activation reconciliation are all three
  genuinely new outbox capabilities (§18).
  Naming them as required extensions is the honest option: the alternative —
  letting the refinement runner write the Issue body directly — would put a
  GitHub mutation outside the queue that gives every other mutation its
  idempotency, retry, ownership filter, and audit trail, for the one mutation
  in this contract that overwrites operator-authored text.
- **Activation hands over to the dependency gates instead of overriding
  them.** An activated Issue whose fan-in the gates do not yet admit waits
  parked (§12, row 34). Refinement's value is refining early against decisions
  that are already final, which is a different question from when it is safe to
  branch; letting a refined Issue skip a gate would make refinement a way to
  bypass the dependency model rather than a way to sharpen an Issue.
- **The marker stops an existing task, not only a new one.** Refusing intake
  admission is a decision about creating a task; a rough Issue whose
  implementation, fix, review, research, content, or conflict-resolution task
  was enqueued *before* the marker landed would otherwise run on the stale
  contract the marker exists to flag. A pre-execution guard plus a
  before-publication re-check, both dispositioned as `execution_marker_conflict`
  handoffs, close that hole without a force-kill and without a new label (§3.1).
- **A handoff whose comment cannot be delivered still stands.** The local record
  is what stops the lane; the public comment is a notification. Making the
  handoff conditional on a GitHub write would mean the one failure mode that
  most needs a handoff — an undeliverable comment topic — is the one that could
  not raise one. The comment gets its own fresh, precondition-free effect, and
  when even that dead-letters the lane records the fact and stops rather than
  re-enqueueing forever (§13, §12 row 46).
- **No routine human approval on the successful path.** The final human gate
  is the PR merge, as it already is for every other lane.

### 20.2 Rejected

- **A second approval label or a `status:refinement-*` micro-state family.**
  Rebuilds the label-heavy control plane this project deliberately avoids.
- **Reusing `issue-discuss post` to apply the refinement.** It is
  comment-only and human-approved by design; overloading it would either
  weaken its approval token or leave the body unrefined.
- **Refining transitively, from the whole ancestor set.** Unbounded input
  growth, and a decision three levels up is already reflected in the direct
  predecessor's own refined contract.
- **Including predecessor diffs in the snapshot.** Leaks repository content
  into a public Issue and invites the downstream Issue to restate an
  implementation instead of a contract.
- **Automatically creating child Issues from a split proposal.** The planning
  gate already declined this for the same reason: creating work items is a
  human decision.
- **Blocking refinement on the planning gate's `ready` decision.** A rough
  Issue is exactly the input this lane exists to consume.
- **Letting a `revise` loop run until the agents agree.** Bounded rounds with
  a handoff at the cap is the only shape that cannot spend unbounded budget.
- **Keeping the refinement-marked Issue free of an `agent:*` label and having
  intake reactivate from the persisted assignment.** Superficially tidier — the
  marker alone would be the whole label state — but it requires `labelsToPhase`
  to route an Issue carrying `status:needs-implementation` and no agent label,
  which is precisely the assignment-from-labels reconstruction that #292 ruled
  out, and it would change routing for every Issue in the repository to serve
  one optional lane. The `agent:*` label already exists for this purpose,
  already names the implementation owner, and is inert without an executable
  status, so requiring it costs nothing and keeps the router untouched (§18).
- **Adding the `agent:*` label at activation instead of requiring it up
  front.** It would work, but it puts the lane in the business of deciding an
  implementation owner and writing an ownership label — the same
  ownership-in-labels move §14 forbids elsewhere — and it defers the failure:
  an Issue whose assignment cannot resolve would run the entire refinement
  before anything noticed. Requiring the label at admission fails closed on the
  first poll, before an agent runs.

## 21. Specification gaps (open)

- **G1 — Re-refinement after a predecessor changes post-activation.** Once an
  Issue is `activated`, a predecessor that later force-pushes a new head SHA
  does not re-open refinement; the Issue is already in the implementation
  lane. Whether a second refinement pass should be offered, and how it would
  interact with an in-flight implementation, is not specified here.
- **G2 — Fan-in above the cap.** `fan_in_exceeded` hands off; there is no
  specified way to refine a wide fan-in incrementally.
- **G3 — Multi-chain membership.** An Issue whose predecessors span two
  registered chains is refused by the chain cross-check as
  `chain_disagreement`, matching intake's refusal to fuse chains. A
  deliberate cross-chain refinement is out of scope.
- **G4 — Operator preview.** There is no read-only "what would refinement
  produce" command in this contract. Adding one is compatible with
  everything here, but it is not specified.
- **G5 — A predecessor closed with its PR closed unmerged.** That shape
  satisfies neither §4 shape and never will, so the dependent holds at `pending`
  (row 4) indefinitely while the ordinary dependency gate would already admit
  it. Refinement deliberately does not decide this case: the predecessor's work
  was abandoned, so the downstream Issue's premise is in doubt and only a human
  can say whether it should be refined, rewritten, or closed. Whether the lane
  should escalate this shape on its own — a new handoff reason, and a defined
  operator exit for the already-created refinement task row, since removing the
  marker and hand-applying an executable status leaves that row parked at phase
  `refinement` — is left open. What is specified is that this is the *only*
  remaining indefinite hold inside the refinement lane: every other predecessor
  shape either becomes usable (§4), holds only while its result is still
  pending, or escalates. The one indefinite wait that can follow a *successful*
  refinement — an activated Issue whose fan-in the unchanged dependency gates
  do not admit (§12, row 34) — is not a gap: it is specified in §11, and it is
  the ordinary dependency-hold behavior every implementation task already has.

## 22. Verification (documentation tests)

`test/docs-issue-refinement-contract.test.js` structurally pins: the single
label marker, its non-executable/mutual-exclusion rules over the complete
six-member executable-status set (`status:needs-fix` included), and the §3.1
pre-execution guard that stops an already-queued or running task, the closed
vocabularies (states, verdicts, change classes, topology dispositions,
handoff reasons), the two-lane separation, the eligibility rules including
stack-ready-not-merged, the merged-predecessor shape, the required
implementation `agent:*` label with its admission refusal and its retention
through activation, and fail-closed holds, the
snapshot input list and its exclusions, the fingerprint's one-to-one coverage of
that input list together with its two named exclusions and the preconditions
that compensate for them — the marker preconditions for the labels and the
`appliedRegionDigest` for the managed region — the staleness behavior, both
result schemas, the
critic-independence rule including its role-resolution failure path, the
bounded-refinement constants, the applicable/advisory split and the topology
fail-closed rule, the managed-region rules including its byte-for-byte
idempotency, the activation ordering with its verify-before-persist commit
point, its
dispatch-time precondition, one-stage-in-flight rule, remove-before-add label
replacement, reconciled park-and-reactivate handover, post-activation fan-in
wait, and no-human-action property, every transition-table row's
state/event/next-state triple, the handoff behavior including the operator
recovery command and its label-shape precondition, the marker-precondition
handoff and the bounded-retry-then-handoff disposition for agent process
failures, the undeliverable-handoff-comment exception,
the assignment-retention rules, the audit-event vocabulary,
the public comment policy, the fail-closed malformed-output rules,
the compatibility statements including the three required outbox extensions,
the required phase-runner marker guard, and
the unchanged dependency gates,
and the open gaps of §21 — plus the cross-document pointers from
[phase-contracts.md](phase-contracts.md) and
[idea-to-implementation.md](idea-to-implementation.md). `npm test` runs it.

No behavioral test accompanies #866, because #866 changes no production
behavior. Behavioral verification lands with the implementation Issues that
reference this contract.
