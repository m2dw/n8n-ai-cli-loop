# Review Dispute, Reconsideration, and Arbitration Contract

Status: approved design (issue #835). This document is the authoritative
contract for the review-dispute protocol. Follow-up implementation Issues
reference this specification and MUST NOT redefine its policy; a change of
policy is a change to this document first.

No production review or fix behavior changed in #835 itself — #835 shipped
the contract, not the protocol. It is gated behind
`session.reviewDispute.enabled`, which defaults to `false`; a session that
does not opt in behaves exactly as today.

**Implementation status (issues #849, #965).** The protocol described here is
implemented across issues #836–#849 and #950–#965, and ships default-off behind
that same flag. Every automated §7.1 turn dispatches inside the `review` phase —
the reviewer's reconsideration (issue #952), the runner's arbitration (#955), and
the bounded evidence round's two per-party runs (#964) — so an enabled session
completes a debate without a manual database edit or an operator recovery
command. See [feature-status.md](feature-status.md#review-dispute) for the
operator-facing availability summary. This document remains the policy
authority; how to enable it, read it, and turn it off again is
[review-dispute-operations.md](review-dispute-operations.md), which adds no
policy of its own. The two open specification gaps are unchanged — see §15.

**Provider capability (issue #1067).** Which agent CLI may take which turn is a
separate question from what the protocol is, and §17 is its record: the graded
capability table, the exact blockers, the invocation contract a Codex turn pins,
and the decisions an operator must record before any successor implements one.
**Both decisions have now been taken.** D1 is recorded in §17.11 and
implemented by issue #1069: in a session with `reviewDispute.enabled: true` a
Codex review runs the runner-authored `codex exec` lane of §17.7 and is asked for
the §2.1 envelope like any other reviewer. **D2 is recorded in §17.16 and
implemented by issue #1085**: the reviewer's §4.1 reconsideration may run under
the separately named `read-bounded` posture, for the agents that have such an
invocation (`codex`) and **only** for a session that opts in with
`reviewDispute.reconsideration.readBounded: true`, which is off by default. What
that posture gives up is stated plainly wherever it appears: writes, network and
operator agent configuration are refused, and **reads are not bounded**, so
§8.2's "the bundle is the entire input" does not hold for a lineage decided under
it — and the record says which posture decided it, forever. A Codex **arbitration**
still fails closed; that is a separate turn and D2 did not admit it. **Issue #1070
asked for the Codex reconsideration turn while D2 was unrecorded and stopped on
that** — §17.12 is the record of the stop and of what a successor needed before
asking again. **Issue #1071 asked for the round trip that ends in that turn and
stopped at the same place** — §17.13 records how the loop behaves up to the park,
and the one integration fault it uncovered: §4.1's reconsideration is owed to the
reviewer that RAISED the finding, not to whichever lane the session resolves a
phase later. A session with the protocol **disabled** is untouched: it runs
`codex review`, byte for byte.

This document is **publicly exportable**, not private-only: it describes
protocol shape and never contains repository content, local paths, or run
transcripts (see `copybara/copy.bara.sky`).

## 0. Purpose

The current fix loop treats every blocking review finding as an
implementation command. When review returns `needs_fix`, the bounded review
output is stored as free-form `task.context.reviewFeedback` and the fix-mode
prompt instructs the agent to edit files to address it. There is no
first-class way for the implementation agent to show that a finding rests on
a false premise, contradicts the Issue contract, is already covered by an
invariant or test, or would make the implementation less correct. A no-change
response is not a dispute today: fix mode fails with "exited 0 but produced
no file changes."

This contract defines an evidence-backed dispute protocol with structured
finding lineage, one rebuttal per finding version, reviewer reconsideration,
bounded material revisions, a provider-independent AI arbiter, and human
escalation for the cases automation must not decide. The protocol is
deliberately bounded: no finding lineage receives a third
implementation/reviewer debate round, ever.

## 1. Canonical vocabulary

Exactly one vocabulary is used throughout this document, and a later
implementation must use these tokens verbatim in code, JSON output, audit
events, and operator text. Nothing else is a valid name for these concepts.

**Implementation dispositions** — the per-finding value returned by the
implementation agent in fix mode. Exactly three:

| Disposition | Meaning |
| --- | --- |
| `fixed` | The agent changed code/tests/docs to satisfy the finding's required outcome. |
| `review_disputed` | The agent asserts, with evidence, that the finding version is wrong and no change should be made. |
| `blocked` | The agent cannot act on the finding without input automation cannot supply. |

**Reviewer reconsiderations** — the per-dispute value returned by the
reviewer. Exactly three:

| Reconsideration | Meaning |
| --- | --- |
| `withdraw` | The rebuttal is accepted; the finding is resolved with no change required. |
| `uphold` | The finding stands as written; the disagreement goes to arbitration. |
| `revise` | The reviewer replaces the finding version with a successor version. |

**Arbiter verdicts** — exactly four:

| Verdict | Meaning |
| --- | --- |
| `reviewer_correct` | The finding is binding; the implementation must fix it. |
| `implementer_correct` | The rebuttal stands; the finding is resolved with no change required. |
| `spec_ambiguous` | The Issue contract itself does not decide the disagreement; a human must. |
| `insufficient_evidence` | Neither side's evidence decides the disagreement as presented. |

**Lineage states** — the value of
`task.context.reviewDispute.lineages[<lineageId>].state`:

| State | Meaning | Terminal? |
| --- | --- | --- |
| `open` | The current finding version awaits an implementation disposition. | No |
| `disputed` | A valid rebuttal is recorded; awaits reviewer reconsideration. | No |
| `arbitration_pending` | Awaits the arbiter verdict. | No |
| `evidence_requested` | The single bounded evidence round is in flight. | No |
| `binding` | The finding must be fixed; the debate for this lineage is exhausted. | No |
| `resolved_fixed` | A `fixed` disposition exited the lineage back into the ordinary review loop. | Yes |
| `resolved_withdrawn` | The reviewer withdrew the finding. Resolved with no change required. | Yes |
| `resolved_overruled` | The arbiter ruled `implementer_correct`. Resolved with no change required. | Yes |
| `escalated_human` | Automation stops for this lineage; a human decides. | Yes |

Terminal states are immutable audit records. Automation never reopens a
terminal lineage (§6.4).

## 2. Finding schema, lineage, and versions

### 2.1 Finding record (normative fields)

A blocking finding admitted into the protocol is a structured record. All
fields are REQUIRED unless marked optional; a record missing a required field
is malformed (§12).

| Field | Content |
| --- | --- |
| `lineageId` | Stable opaque ID for the finding lineage, minted by the runner (§2.2). |
| `version` | Positive integer, starting at 1. Incremented only by `revise` (§4). |
| `severity` | One of `P1`, `P2`. Only blocking severities enter the protocol; cosmetic nits never do. |
| `violatedContract` | The invariant, Issue requirement, or acceptance criterion the diff allegedly violates, quoted or precisely named. |
| `preconditions` | The state/input assumptions under which the violation occurs. |
| `failureScenario` | Concrete inputs/state → wrong output, crash, or contract breach. |
| `affectedBoundary` | The file/module/API surface the finding is about, named repository-relative. The runner normalizes an absolute path under the execution root to its repository-relative form at admission, before schema validation; a value that still names a location outside the repository after normalization — an absolute filesystem path or a `..` escape — is malformed (§12). |
| `requiredOutcome` | What a correct implementation must observably do. |
| `humanGate` | Runner-stamped boolean; agents never set it and a reviewer-supplied value is ignored. `true` when the Issue contract explicitly requires human approval for the affected behavior, as flagged by the existing human-gate mechanisms; stamped at admission of each version. An admitted dispute on a `humanGate: true` finding version escalates to a human (§7 rows 3 and 7, §9): automation never decides a human-gated disagreement. |
| `evidenceRefs` | One or more resolvable evidence references (§3.3). |
| `reviewerMeta` | Reviewer identity and run metadata: agent id, model/effort when known, review run id, timestamp. |

Three of these fields — `lineageId`, `humanGate`, and `reviewerMeta` — are
**runner-owned**: only the runner may populate them. What a review run
emits is a **candidate finding**: the record above minus the runner-owned
fields (a re-raise against a live lineage echoes the known `lineageId` per
§2.2 — echoed to attach, never minted). The runner augments every
candidate at admission, before schema validation: it mints `lineageId` or
attaches the candidate to a live lineage (§2.2), stamps `humanGate` from
the existing human-gate mechanisms, and records `reviewerMeta` from the
review run's own metadata, never from agent output. The required-field
rule above — and the malformed rule of §12 — is checked against the
augmented record: a first finding is never malformed for lacking a
runner-owned field, and a candidate is malformed only when an
agent-authored field is missing or invalid. A reviewer-supplied value for
a runner-owned field is ignored and logged, never admitted. The successor
record inside a `revise` (§4.2) is a candidate finding under the same
rules: the runner re-stamps the runner-owned fields at admission of each
version.

### 2.2 Lineage rules

- The **runner mints** `lineageId` when a structured finding is first
  admitted. Agents never mint lineage IDs; they only echo them.
- A lineage identifies one alleged defect across versions, dispositions,
  reconsiderations, and arbitration. All protocol bounds (§6) are counted
  per lineage.
- Prior lineages (ID, state, current version) are included in the next
  review prompt. A reviewer re-raising a known defect MUST reference the
  existing `lineageId`; a new structured finding whose identity tuple
  (`violatedContract`, `affectedBoundary`, `failureScenario`) structurally
  duplicates a live lineage is attached to that lineage by the runner, not
  admitted as a new one.
- A finding that structurally duplicates a **terminal** lineage is not
  re-admitted into that lineage: terminal lineages are immutable (§6.4).
  Exactly one successor path exists — a `resolved_fixed` lineage that
  never consumed a rebuttal is superseded by a fresh version-1 lineage
  linked via `supersedes` (§7, note on rows 1/5/23). Every other terminal
  duplicate — including one whose `resolved_fixed` lineage consumed its
  rebuttal — is dropped from blocking consideration and recorded in the
  audit log (§6.4).

### 2.3 Version rules

- `version` starts at 1 and increments by exactly 1, only via a `revise`
  reconsideration.
- A version is immutable once recorded. Reconsideration cannot silently
  change a finding: the only way to change any field is a `revise` that
  creates a successor version naming its predecessor and its changed fields
  (§4.2).
- `MAX_VERSIONS_PER_LINEAGE = 2`. Version 2 is always the final version; a
  `revise` of version 2 is structurally impossible because version 2's
  dispute goes directly to arbitration (§5, §7; a `humanGate: true`
  version 2 escalates to a human instead, row 7).

## 3. Implementation disposition and dispute schema

### 3.1 Disposition record

In fix mode, for **each** `open` or `binding` finding version in the
prompt, the implementation agent returns exactly one disposition record:

| Field | Content |
| --- | --- |
| `lineageId`, `version` | The finding version being answered. Must match an `open` or `binding` version. |
| `disposition` | `fixed`, `review_disputed`, or `blocked`. All three are valid for an `open` version. A `binding` version accepts only `fixed` or `blocked` (§7 rows 23–24): its debate is exhausted, and a `review_disputed` on a `binding` finding is malformed (§12). |
| `note` | Optional bounded free text (never a substitute for the structured fields below). |

A disposition for an unknown lineage, a version that is neither `open` nor
`binding`, or a stale version is malformed (§12).

### 3.2 Dispute record

A `review_disputed` disposition MUST embed a dispute record:

| Field | Content |
| --- | --- |
| `challenged` | `{ lineageId, version }` of the finding version being rebutted. |
| `rebuttalReason` | Exactly one of the closed enum: `false_premise`, `contradicts_issue_contract`, `already_covered`, `would_reduce_correctness`, `out_of_scope`. |
| `argument` | Bounded prose: why the finding is wrong. |
| `evidenceRefs` | One or more resolvable evidence references (§3.3). REQUIRED — an unsupported assertion is not a dispute. |
| `testEvidence` | Optional: names of existing tests/invariants that already cover the claimed failure scenario. |
| `whyNoChange` | Why changing the code would be incorrect or unnecessary. |

### 3.3 Evidence references and admission (fail closed)

An evidence reference is one of: a repo-relative file path with a line range;
a test name; a named section of a contract document under `docs/`; or a
quoted span of the Issue body. At validation time the runner resolves every
reference **read-only**; resolution follows the same admission posture as
the repository evidence contract
([research-evidence-contract.md](research-evidence-contract.md)): bounded,
tracked-file scope, no symlinks, no network, nothing executed.

A dispute is **admitted** only when it is schema-valid, its
`rebuttalReason` is a listed enum token, and **every** evidence reference
resolves. Anything else is not a dispute: mere refusal, unsupported
assertions, prose objections outside the structured block, and disputes with
unresolvable evidence are all malformed (§12) and fail closed to today's
behavior — the finding stays `open` at the same version, no rebuttal slot is
consumed, and a no-change run fails exactly as it does now.

Only an **admitted** dispute consumes the version's single rebuttal slot
(`MAX_REBUTTALS_PER_VERSION = 1`, §6).

### 3.4 Runs that resolve without file changes

A fix run whose every addressed lineage ends the run in a no-change-required
terminal state (`resolved_withdrawn`, `resolved_overruled`) or a
protocol-progress state (`disputed`, `arbitration_pending`,
`evidence_requested`) is a **valid run with zero file changes**, provided
the admitting review was fully structured (§13). The handler
MUST NOT fail such a run with "produced no file changes"; that failure is
reserved for runs that leave at least one `open` or `binding` lineage
unanswered and produce no diff, and for mixed-review runs whose free-prose
feedback retains legacy blocking force (§13). This is the contract decision
that lets a valid evidence-backed dispute complete without edits.

The separate, protocol-independent admission for a legacy fix turn (issue
#1125's explained no-change fix turn) is subordinate to this section and never
overrides it: whenever a lineage is awaiting a §3.1 disposition on this run, that
path refuses and the answer above is the only one. It cannot be used to end a
disputed finding without a diff, and it never records a disposition, moves a
lineage, or consumes a rebuttal slot.

A `fixed` disposition requires a diff: in a fix run that produced no file
changes, every `fixed` disposition is malformed (§12) and is rejected
**before** any state transition — the lineage stays `open` (or `binding`),
counts as unanswered, and the run fails exactly as today. A no-op `fixed`
claim therefore can never reach `resolved_fixed` and never consumes a
re-review cycle.

## 4. Reviewer reconsideration

### 4.1 Reconsideration record

For each lineage in state `disputed`, the reviewer returns exactly one
reconsideration record:

| Field | Content |
| --- | --- |
| `lineageId`, `version` | The disputed finding version. |
| `reconsideration` | `withdraw`, `uphold`, or `revise`. |
| `rationale` | Bounded prose. |

Reconsideration records are produced only in the reviewer reconsideration
run dispatched by §7.1 — a review-phase run — never in fix mode.

### 4.2 Revision record

A `revise` reconsideration MUST embed a revision record:

| Field | Content |
| --- | --- |
| `predecessorVersion` | The version being replaced (must equal the disputed version). |
| `changedFields` | Non-empty list of finding-field names that differ from the predecessor. |
| `revisionKind` | One of: `narrowed_scope`, `corrected_premise`, `new_evidence`, `restated`. |
| `materialityClaim` | Boolean: whether the reviewer claims the change is material. |
| The successor finding record | Full §2.1 record at `version = predecessorVersion + 1`. |

A `revise` that omits its predecessor, lists no changed fields, or whose
successor record is invalid is malformed (§12). The predecessor version
remains on record unchanged — reconsideration can never silently mutate a
finding.

The embedded successor record is a candidate (§2.1) until admitted: it is
persisted as the lineage's next version only by the row 11 transition.
When the session's version budget forbids a successor
(`MAX_VERSIONS_PER_LINEAGE = 1`, §6.1, row 26), the candidate is still
required and still feeds the §5 structural check, but it is never
persisted as a version — the lineage stays at the disputed version, and
the candidate travels to the arbiter inside the reconsideration record
(§8.2).

## 5. Material-revision rules (deterministic)

The runner — not either agent — decides whether a revision is material, by a
**structural check** over `changedFields` and the recorded field values.

A revision is **material** only when at least one of these fields actually
changed between predecessor and successor:

- `violatedContract`
- `preconditions`
- `failureScenario`
- `affectedBoundary`
- `requiredOutcome`
- `evidenceRefs`, when the added executable evidence invalidates a prior
  premise of the rebuttal (a new test name or file/line whose resolution
  contradicts a dispute evidence reference).

**Never material**: wording-only edits, line-number movement within the same
`affectedBoundary`, added examples, severity-only changes, and restating the
same `failureScenario` in different words.

The structural check is deterministic: it compares recorded field values,
normalized for whitespace, and requires a listed field to differ in
normalized content — a `changedFields` entry whose values compare equal is
ignored. `materialityClaim` is an input to audit, never to the decision.

**Ambiguity goes to arbitration, not to another rebuttal.** When the
structural check cannot decide — the changed field differs textually but
only in phrasing the runner cannot classify (e.g. a rewritten
`failureScenario` that may or may not describe the same scenario) — the
revision is classified `ambiguous` and the lineage proceeds to arbitration.
An ambiguous or non-material revision never grants the implementation
another rebuttal.

## 6. Bounded debate: limits and boundedness

### 6.1 Per-lineage limits (normative constants)

| Constant | Value |
| --- | --- |
| `MAX_REBUTTALS_PER_VERSION` | 1 |
| `MAX_VERSIONS_PER_LINEAGE` | 2 |
| `MAX_RECONSIDERATIONS_PER_LINEAGE` | 1 |
| `MAX_ARBITRATION_PASSES_PER_LINEAGE` | 2 |
| `MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE` | 2 |
| `MAX_EVIDENCE_ROUNDS_PER_LINEAGE` | 1 |

Session config may only **lower** these limits, never raise them.
Lowering a limit never leaves a state without a next action: the §7 rows
instantiate the default maxima, and for lowered limits the cap-reached
routing is:

- `MAX_REBUTTALS_PER_VERSION` MUST NOT be lowered: at 0 no dispute could
  ever be admitted, which is what `session.reviewDispute.enabled: false`
  already expresses. A session configuring 0 is rejected at session load
  (fail closed — the protocol never starts half-enabled).
- `MAX_VERSIONS_PER_LINEAGE` MUST NOT be lowered below 1: every lineage
  begins at version 1 (§4.1), so a version budget of 0 contradicts the
  initial finding itself and no row could ever fire. A session
  configuring 0 is rejected at session load (fail closed), exactly as
  for `MAX_REBUTTALS_PER_VERSION`.
- `MAX_VERSIONS_PER_LINEAGE = 1`: no successor version may be created. The
  `revise` schema is unchanged — §4.2 still requires the embedded
  successor record, because the §5 structural check compares its fields —
  but the successor stays an **unpersisted candidate** (§4.2): it is
  never admitted as a lineage version, and it reaches the arbiter inside
  the reconsideration record (§8.2). A structurally material `revise`
  fires row 26 — the successor-version-unavailable complement of row 11,
  listed in the §7 table — to `arbitration_pending` with the lineage
  still at version 1, and still emits `dispute.revision.material`; row 11
  is unreachable. Row 12 is unchanged: it covers non-material or
  ambiguous revisions only.
- `MAX_RECONSIDERATIONS_PER_LINEAGE = 0`: the reconsideration round is
  skipped. An admitted, not human-gated version-1 dispute fires row 25 —
  row 2's lowered-limit complement, listed in the §7 table — to
  `arbitration_pending`; `disputed` is never entered and rows 2 and 9–12
  are unreachable.
- `MAX_ARBITRATION_PASSES_PER_LINEAGE` MUST NOT be lowered below 1: every
  entry into `arbitration_pending` (rows 6, 10, 12, 22, 25, and 26) needs an
  arbitration pass to invoke the arbiter, and at 0 the state would have no
  next action. A session configuring 0 is rejected at session load (fail
  closed), exactly as for `MAX_REBUTTALS_PER_VERSION`. A session that
  wants a human instead of any arbiter expresses that by configuring no
  acceptable arbiter, which row 19 already routes to `escalated_human`.
- `MAX_ARBITRATION_PASSES_PER_LINEAGE` (lowered to 1) /
  `MAX_EVIDENCE_ROUNDS_PER_LINEAGE`: the evidence round is **available**
  only while the evidence-round budget is unconsumed **and** a further
  arbitration pass remains to receive the re-presented case. Rows 16 and
  17 are written in exactly these terms: an available round fires row 16;
  an unavailable round — the round budget is 0, the round was consumed,
  or no arbitration pass remains — fires row 17's unavailable-round
  event to `escalated_human`.
- `MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE` MUST NOT be lowered below
  1: rows 20 and 21 partition malformed arbiter output by whether the
  resulting attempt count reaches the cap, and at 0 the first malformed
  attempt would satisfy neither row, leaving `arbitration_pending`
  without a next action. A session configuring 0 is rejected at session
  load (fail closed), exactly as for `MAX_REBUTTALS_PER_VERSION`.
- `MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE = 1`: the first malformed
  attempt raises the counter from 0 to the cap of 1 — row 21's
  cap-reached event — and escalates; row 20's below-cap retry is
  unreachable.

### 6.2 The debate shape

- One rebuttal is allowed for a finding version.
- `withdraw` resolves the finding (`resolved_withdrawn`).
- `uphold` proceeds directly to arbitration.
- A **material** `revise` creates version 2 and allows exactly one final
  implementation response to it. A `review_disputed` response to version 2
  proceeds **directly to arbitration** — there is no second
  reconsideration. (A `humanGate: true` version 2 escalates to a human
  instead — §7 row 7.)
- A non-material or ambiguous `revise` proceeds to arbitration.
- No finding lineage receives a third implementation/reviewer debate round.

### 6.3 Why the protocol cannot create an unbounded AI debate

Per lineage, the worst case is: rebuttal of version 1 (one implementation
turn) → one reconsideration (one reviewer turn) → material revise → final
response to version 2 (one implementation turn) → arbitration (at most two
passes and at most two malformed-arbiter attempts, joined by at most one
evidence round of at most two evidence-collection runs, one per party,
§7.1) → terminal state. Every
non-terminal state consumes a bounded counter that only the transition table
(§7) can advance, and every counter exhaustion routes to `binding`,
arbitration, or `escalated_human`. On top of the per-lineage bounds, the
whole task remains inside the existing review-loop cap
(`session.reviewLoop.maxCycles`, default 10, `reviewLoopCapReached` →
ready for human) — the dispute protocol adds no path around that cap.

### 6.4 Terminal lineages stay terminal

Automation never reopens a lineage in a terminal state. A reviewer who
believes new evidence overturns a `resolved_withdrawn` or
`resolved_overruled` lineage records a `reopen_requested` flag on the
lineage, which routes to **human escalation only** — never to a new debate
round. `reopen_requested` is a runner-recorded flag, not a §7 event: it
appears in no transition-table row and the terminal lineage keeps its
state, so terminal immutability holds. The escalation happens at run
level instead — §7.1 rule 1 treats a terminal lineage carrying the flag
exactly like a lineage in `escalated_human`, escalates the task to
`ready_for_human`, and emits `dispute.reopen.requested`. The same flag is
the path for a `resolved_fixed` lineage whose rebuttal was consumed (§7,
note on rows 1/5/23). A finding that structurally duplicates a terminal
lineage is dropped from blocking consideration and recorded in the audit
log, except for the single `supersedes` successor path of §2.2.

## 7. Transition table (normative)

Every row names one state, one event, and exactly one next state. Every
state has one unambiguous next action; events not listed for a state are
malformed input (§12) and do not change state.

| # | State | Event | Next state |
| --- | --- | --- | --- |
| 1 | `open` (version 1) | disposition `fixed` | `resolved_fixed` |
| 2 | `open` (version 1) | admitted dispute (`review_disputed`), finding not human-gated, reconsideration round available | `disputed` |
| 3 | `open` (version 1) | admitted dispute (`review_disputed`), finding `humanGate: true` | `escalated_human` |
| 4 | `open` (version 1) | disposition `blocked` | `escalated_human` |
| 5 | `open` (version 2, final response) | disposition `fixed` | `resolved_fixed` |
| 6 | `open` (version 2, final response) | admitted dispute (`review_disputed`), finding not human-gated | `arbitration_pending` |
| 7 | `open` (version 2, final response) | admitted dispute (`review_disputed`), finding `humanGate: true` | `escalated_human` |
| 8 | `open` (version 2, final response) | disposition `blocked` | `escalated_human` |
| 9 | `disputed` | reconsideration `withdraw` | `resolved_withdrawn` |
| 10 | `disputed` | reconsideration `uphold` | `arbitration_pending` |
| 11 | `disputed` | `revise`, structurally material, successor version available | `open` (version 2, final response) |
| 12 | `disputed` | `revise`, non-material or ambiguous | `arbitration_pending` |
| 13 | `arbitration_pending` | verdict `reviewer_correct`, confidence ≥ threshold | `binding` |
| 14 | `arbitration_pending` | verdict `implementer_correct`, confidence ≥ threshold | `resolved_overruled` |
| 15 | `arbitration_pending` | verdict `spec_ambiguous` | `escalated_human` |
| 16 | `arbitration_pending` | verdict `insufficient_evidence`, evidence round available (§6.1) | `evidence_requested` |
| 17 | `arbitration_pending` | verdict `insufficient_evidence`, evidence round unavailable (used, budget 0, or no arbitration pass remaining — §6.1) | `escalated_human` |
| 18 | `arbitration_pending` | decisive verdict (`reviewer_correct` / `implementer_correct`), confidence < threshold | `escalated_human` |
| 19 | `arbitration_pending` | no acceptable arbiter configured/available (§8.3) | `escalated_human` |
| 20 | `arbitration_pending` | malformed arbiter output, resulting `malformedArbiterAttempts` below the session cap (0 → 1 at the default cap 2) | `arbitration_pending` |
| 21 | `arbitration_pending` | malformed arbiter output, resulting `malformedArbiterAttempts` reaches the session cap (1 → 2 at the default cap 2; 0 → 1 at the lowered cap 1, §6.1) | `escalated_human` |
| 22 | `evidence_requested` | evidence attachments recorded (or the round's runs complete with none) | `arbitration_pending` |
| 23 | `binding` | disposition `fixed` | `resolved_fixed` |
| 24 | `binding` | disposition `blocked` | `escalated_human` |
| 25 | `open` (version 1) | admitted dispute (`review_disputed`), finding not human-gated, reconsideration round unavailable (`MAX_RECONSIDERATIONS_PER_LINEAGE = 0`, §6.1) | `arbitration_pending` |
| 26 | `disputed` | `revise`, structurally material, successor version unavailable (`MAX_VERSIONS_PER_LINEAGE = 1`, §6.1) | `arbitration_pending` |

Notes:

- Rows 2 and 25 partition version 1's admitted, not human-gated dispute by
  whether the session's reconsideration budget (§6.1) is available: at the
  default `MAX_RECONSIDERATIONS_PER_LINEAGE = 1` the round is available and
  row 2 fires; under the lowered limit 0 it is not and row 25 fires.
  Exactly one of the two conditions holds for any session, so the machine
  stays deterministic. Rows 25 and 26 sit after the state-grouped rows to
  keep the historical numbering of rows 1–24 stable.

- Rows 11 and 26 partition `disputed`'s structurally material `revise` by
  whether the session's version budget (§6.1) allows a successor: at the
  default `MAX_VERSIONS_PER_LINEAGE = 2` the successor version is
  available and row 11 fires; under the lowered limit 1 it is not and
  row 26 fires. As with rows 2 and 25, exactly one of the two conditions
  holds for any session. Row 26 persists no successor: the §4.2 candidate
  feeds the structural check and the arbitration bundle, and the lineage
  arbitrates at version 1.

- Rows 1, 5, and 23 fire only for an admitted `fixed`: a `fixed`
  disposition in a run that produced no file changes is malformed (§12)
  and is rejected before any transition — the lineage stays `open` or
  `binding` and the no-diff failure of §3.4 applies.
- Rows 1, 5, and 23: `resolved_fixed` exits the dispute protocol; whether
  the fix actually satisfies the finding is judged by the ordinary next
  review pass, which is itself bounded by `session.reviewLoop.maxCycles`.
  A reviewer who still observes the defect references the `resolved_fixed`
  lineage's id; the terminal lineage itself stays immutable and is never
  re-entered. This is the single successor path of §2.2: when the lineage
  never consumed a rebuttal, the runner admits the re-raise as a **new
  version-1 lineage linked via `supersedes`**; when the rebuttal was
  consumed, the runner instead records `reopen_requested` on the terminal
  lineage and escalates via §7.1 rule 1 (§6.4) — never a new debate
  round. A lineage's debate budget is never refreshed by a fix claim.
- Rows 3 and 7: `humanGate` escalation happens at dispute admission. A
  human-gated finding version that is disputed goes straight to a human —
  it never enters `disputed`, arbitration, or a revision round. `fixed`
  and `blocked` on a human-gated finding behave exactly as rows 1, 4, 5,
  and 8: doing the required work is not the gated decision; deciding the
  disagreement is.
- Row 6 is the "no third round" rule: version 2's dispute skips
  reconsideration entirely.
- Rows 13–14 and 18: the confidence threshold (§8.3) gates decisive
  verdicts (`reviewer_correct`, `implementer_correct`) only.
  `spec_ambiguous` and `insufficient_evidence` are routed by rows 15–17
  regardless of confidence — each already ends at a human or in the
  bounded evidence round — so every returned verdict matches exactly one
  row.
- The rows instantiate the default §6.1 maxima. When a session lowers a
  limit, the cap-reached routing of §6.1 decides which row fires (row 26
  instead of row 11 under `MAX_VERSIONS_PER_LINEAGE = 1`; row 25 instead
  of row 2 under `MAX_RECONSIDERATIONS_PER_LINEAGE = 0`; row 21's
  cap-reached event instead of row 20 under
  `MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE = 1`; row 17's
  unavailable-round event whenever the evidence round is unavailable); no
  lowered limit leaves a state without exactly one next action.
- Rows 20–21 are the malformed-arbiter bound (§8.3, §12):
  `malformedArbiterAttempts` is a runner-owned per-lineage counter
  (§10.1), and the two rows partition every malformed attempt by whether
  the incremented counter stays below or reaches the session cap. Row 20
  records a below-cap attempt and re-invokes the arbiter (the first
  attempt at the default cap 2); row 21 records the cap-reaching attempt
  and escalates (the second at the default cap 2, the first under the
  lowered cap 1). Malformed arbiter output never consumes an arbitration
  pass — passes count returned verdicts (rows 13–18).
- Row 24: a `review_disputed` on a `binding` finding is not an event — it is
  malformed input (§12); the debate for that lineage is exhausted.
- Row 22: the evidence round accepts **evidence attachments only** — new
  resolvable references from either party, no new argument prose. The
  attachments are produced by the §7.1 evidence-collection runs (one per
  party), which are the only defined input to `evidence_requested`; the
  re-presented arbiter bundle then includes their resolved content
  (§8.2). It marks the round used — hence unavailable — so a second
  `insufficient_evidence` hits row 17.

### 7.1 Run-level aggregation

A fix or review run touches many lineages; the task-level result is derived
from lineage states by precedence, evaluated in order so exactly one
outcome applies:

1. Any lineage in `escalated_human` → the task escalates to
   `ready_for_human`. A terminal lineage carrying a `reopen_requested`
   flag (§6.4) is treated by this rule exactly like a lineage in
   `escalated_human`; the flag never changes the lineage's own state.
2. Any lineage in `open`, `binding`, `disputed`, `arbitration_pending`, or
   `evidence_requested` → the review/fix loop continues, still inside the
   review-loop cap. Which party acts next is decided by the lineage states
   present, checked in this order:
   - any lineage in `open` or `binding` → **implementer turn**: today's
     `needs_fix` routing dispatches a fix run carrying those lineages;
     `disputed` lineages wait, unchanged, for the next reviewer turn.
   - otherwise, any lineage in `disputed` → **reviewer turn**: the runner
     dispatches a **reviewer reconsideration run** — a review-phase run,
     never the implementation/fix agent, whose prompt carries the pending
     dispute records and requests exactly one §4 reconsideration record
     per `disputed` lineage. A fix-mode disposition addressed to a
     `disputed` lineage targets a version that is neither `open` nor
     `binding` and is malformed (§12).
   - otherwise, any lineage in `evidence_requested` → **evidence turn**:
     the runner dispatches exactly one bounded **evidence-collection run
     per party** — one implementer-side, one reviewer-side — covering
     every lineage in `evidence_requested`. Each run's prompt carries the
     lineage's finding versions, the admitted dispute and reconsideration
     records, and the `insufficient_evidence` verdict record, and requests
     **evidence attachments only**: zero or more §3.3 evidence references
     per lineage. Anything else in the output — argument prose,
     dispositions, new findings — is ignored and logged. Each returned
     reference is resolved read-only under §3.3; an unresolvable reference
     is dropped and logged, never a run failure. These two runs are the
     sole producer for row 22: when both have completed, the runner
     records the admitted attachments (possibly none) and row 22 returns
     the lineage to `arbitration_pending` for the re-presented case.
     Evidence-collection runs carry no dispositions, change no lineage
     state themselves, and consume no §6.1 counter beyond the single
     evidence round they serve; like every other run they count against
     the review-loop cap.
   - otherwise (only `arbitration_pending` remains) → **runner turn**: no
     agent run is dispatched; the runner advances arbitration between
     runs (§8).

   When the run that triggered this rule produced file changes — e.g. a
   fix run that returned `fixed` with a diff for one lineage while
   disputing another — the runner records `pendingReReview: true` in
   `task.context.reviewDispute` (§10.1) before continuing: the diff stays
   on the branch and its ordinary re-review is deferred, never skipped,
   while the remaining lineages proceed. Intermediate runs that produce
   no file changes (reconsideration, evidence collection, arbitration)
   leave the flag unchanged.
3. All lineages terminal and there are unreviewed file changes — the
   current run produced a diff, or `pendingReReview` was recorded under
   rule 2 by an earlier run of this cycle → normal re-review path (the
   accumulated diff goes back to review, and routing there clears
   `pendingReReview`). This applies whether or not any lineage is
   `resolved_fixed`: in a mixed review (§13) the diff may address prose
   findings alone, and it still returns to review. In particular, a
   reconsideration run that withdraws the last `disputed` lineage
   produces no diff itself, but when `pendingReReview` is set the task
   still routes to review — the earlier fix must be validated by an
   ordinary review before the task can succeed.
4. All lineages terminal with **no** unreviewed file changes — the
   current run produced none and `pendingReReview` is not set
   (`resolved_withdrawn` / `resolved_overruled` only, since every
   `resolved_fixed` lineage implies a diff, §3.4) → when the admitting
   review was fully
   structured (§13), the run records `resolvedWithoutChanges: true` and
   the task proceeds exactly as a review `success`: ready for human
   decision. When the admitting review was mixed (§13), its free prose
   retains legacy blocking force: the same lineage states with no diff
   fail the run exactly as today, and it retries within the review-loop
   cap.

## 8. The AI arbiter

### 8.1 Role

The arbiter is a **read-only** AI role that decides one lineage's
disagreement at a time. It returns exactly one verdict record:

| Field | Content |
| --- | --- |
| `lineageId`, `version` | The lineage/version arbitrated. |
| `verdict` | One of the four §1 verdict tokens. |
| `confidence` | Number in [0, 1]. |
| `rationale` | Bounded prose, local-only (never published, §11). |

The arbiter does not edit code, runs no commands, and MUST NOT introduce
unrelated findings: any additional finding-shaped content in arbiter output
is ignored and logged, never admitted into the protocol.

### 8.2 Bounded context and tool restrictions

The arbiter receives only a runner-composed, bounded bundle:

- the full finding lineage (all versions and their records);
- the admitted dispute record(s) and reconsideration record;
- the runner-resolved content of every cited evidence reference, resolved
  under the same read-only bounds as §3.3;
- on a re-arbitration after the evidence round (§7 row 22): the admitted
  evidence-round attachments, resolved under the same bounds;
- the Issue body (the contract being interpreted);
- the diff hunks touching the finding's `affectedBoundary`, bounded.

Explicitly excluded: full agent transcripts, the rest of the diff,
repository write access, command execution, network access, and any tool
surface beyond the bundle. The enforcement point is the runner: the arbiter
is invoked with no tool permissions, and the bundle is the entire input.

That last clause is about **inputs**, not only side effects, and it is what
makes this posture agent-specific rather than universal: a CLI whose tool
surface cannot be emptied can still be prevented from writing and from reaching
the network, and still not satisfy this section, because it can read evidence
the runner did not resolve. The `no-tools` tool policy recorded on a resolved
profile therefore names *this* boundary, and an identical label elsewhere in
the repository does not import a weaker one into it. §17 records which CLIs
this runner can invoke under it today, on what evidence.

**One turn may run under a weaker, separately named posture, and only by explicit
opt-in.** The reviewer's §4.1 reconsideration — never the arbitration of this
section — may be invoked as `read-bounded` for an agent that has no `no-tools`
invocation, if and only if the session set
`reviewDispute.reconsideration.readBounded`, which is off by default. That posture
does not satisfy the clause above and does not claim to: writes, network and
operator agent configuration are refused, but the agent may read outside the
bundle. It is contract decision D2 (§17.6), recorded by an operator and
implemented in §17.16, and the two postures are never merged, relabelled, or
defaulted into one another — a lineage's record says which one decided it, and a
record that states none is read as neither.

### 8.3 Provider and agent-selection policy

- The arbiter SHOULD come from a provider different from **both** the
  implementer and the reviewer. Implementer identity is read from
  `context.assignment.implementationAgent` (the assignment source of truth,
  never reconstructed from labels); reviewer identity from the review run's
  resolved profile.
- `session.reviewDispute.arbiter.providers` is an ordered candidate list of
  agent ids. The runner selects the first candidate whose provider differs
  from both parties.
- No vendor or model is fixed by this contract. Selection is
  provider-independent by policy, not by naming one arbiter model.
- If no cross-provider candidate exists, a same-provider candidate MAY be
  used only when `session.reviewDispute.arbiter.allowSameProvider` is
  explicitly `true` **and** the candidate is not the same model as either
  party. Otherwise there is **no acceptable independent arbiter** and the
  lineage escalates to a human (table row 19). Fail closed: absence of an
  arbiter never silently converts to "reviewer wins" or "implementer wins".
- `session.reviewDispute.arbiter.minConfidence` (default 0.7) is the
  confidence threshold of rows 13–14 and 18. It gates decisive verdicts
  (`reviewer_correct`, `implementer_correct`) only: `spec_ambiguous` and
  `insufficient_evidence` route via rows 15–17 regardless of confidence,
  so no returned verdict matches more than one row.
- Malformed arbiter output (§12) never consumes an arbitration pass —
  passes count returned verdicts. The runner records each malformed
  attempt in the lineage's `malformedArbiterAttempts` counter (§10.1) and
  emits `dispute.arbitration.malformed`; rows 20–21 make the bound
  deterministic: the first malformed attempt allows one retry; the second
  escalates to a human (`MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE = 2`).

## 9. Human escalation

Human escalation (`escalated_human`, surfacing as `ready_for_human`) is
reserved for what automation must not decide. A lineage takes the
protocol's `escalated_human` transition when, and only when:

- the arbiter returns `spec_ambiguous` — the Issue contract itself does not
  decide the disagreement;
- the arbiter's confidence is below the configured threshold on a
  decisive verdict (`reviewer_correct` or `implementer_correct`; §7
  row 18);
- the Issue contract explicitly requires human approval for the affected
  behavior (human-gated risk): the finding version carries
  `humanGate: true` (§2.1) and its admitted dispute routes to
  `escalated_human` via §7 rows 3 and 7;
- evidence remains insufficient after the single bounded evidence round;
- no acceptable independent arbiter is configured or available;
- the arbiter's output is malformed twice for the same lineage (§8.3,
  row 21);
- a disposition is `blocked`;
- a `reopen_requested` flag is recorded on a terminal lineage.

One further path lands at `ready_for_human` without any lineage entering
`escalated_human`: exhaustion of the review-loop cap
(`session.reviewLoop.maxCycles`) while lineages are still in flight —
including by repeated malformed implementer or reviewer output, which
burns cycles without changing protocol state (§12). This is the
pre-existing `reviewLoopCapReached` handoff (§6.3), a task-level outcome
rather than a protocol transition: no lineage changes state, no
`dispute.escalated.human` audit event is emitted, and no §11 comment is
posted, because no lineage reached a terminal state. The list above is
exhaustive for the protocol's own `escalated_human` transitions; an
implementer of this section must additionally honor the cap handoff.

A second task-level handoff of the same shape covers the runner that
cannot take the turn §7.1 selected: when rule 2 names a turn whose run the
runner does not dispatch — the reviewer turn's reconsideration run, the
evidence-collection runs, or the arbitration the runner turn advances —
the task lands at `ready_for_human` rather than being queued to a phase
that cannot discharge the lineage, and rather than being parked
non-runnable with nothing scheduled to wake it. As with the cap handoff,
no lineage changes state, no counter is spent, and no
`dispute.escalated.human` event is emitted: the lineage stays exactly where
its last transition left it, so the debate resumes there once the missing
dispatch exists or a human acts. A runner that does dispatch every §7.1
turn never reaches this path.

Separation of responsibilities: the **AI arbiter** decides evidence-backed
technical disagreements inside an unambiguous contract; the **human**
decides contract ambiguity, low-confidence outcomes, human-gated risk, and
everything the bounded debate could not resolve. The arbiter never gates
humans out of those cases, and humans are never asked to re-litigate a
high-confidence `reviewer_correct`/`implementer_correct` verdict as part of
this protocol — they see it in the audit record and can intervene through
the existing human-gate mechanisms.

## 10. Persistence and audit events

### 10.1 Task-context state

`task.context.reviewDispute` holds the bounded protocol state: per-lineage
`state`, `version`, counters (rebuttals, reconsiderations, arbitration
passes, malformed arbiter attempts, evidence round used),
`resolvedWithoutChanges`, the run-level `pendingReReview` flag
(§7.1 rules 2–4), and the outcome
literals. Free prose (arguments, rationales) is bounded the same way
`reviewFeedback` already is, and the full records live in run artifacts, not
in the SQLite context column.

Each consumed rebuttal slot also records the implementation run that spent
it (`disputeRuns`: the finding version plus that run's id, one entry per
member of `rebuttedVersions`). That pair is the idempotency key of dispute
persistence: a retried delivery of the same run recognizes its own entry and
records nothing a second time, while any other run addressing the same
version finds the slot consumed and is refused (§6.1, §12). Persisting a
dispute is a compare-and-set against the stored block — a version the
reviewer has since revised, a state that no longer accepts a dispute, or a
lineage record that has otherwise moved leaves the lineage untouched, so an
older run can never overwrite newer review state. Blocks written before
this field existed carry none; they still bound the debate through
`rebuttedVersions`, and a redelivery against one is refused rather than
duplicated.

Every other §7 transition is bounded the same way, by an
`appliedTransitions` ledger on the lineage: a short opaque digest of the
transition's `<lineageId>@<version>#<runId>` key, one entry per applied
transition. A ledger rather than a derived fact, because the ROW a
re-delivered outcome names can legitimately move — once a below-cap
malformed arbiter attempt (row 20) is applied, a second delivery of the
same arbitration run reads the incremented counter and names row 21 — while
the run key does not move. A delivery whose digest is already on file
changes no state, consumes no counter, and emits no second audit event.
Only the digest is persisted, so the ledger carries no run identifier,
prose, or path into task context, and it is bounded by the same §6.1
counters that bound the debate itself. Blocks written before this field
existed carry none; such a lineage recognizes no replay and fails closed on
the state and counter checks instead, never applying a delivery twice.

The §7.1 evidence round has one more piece of bounded state, and it lives
beside the block rather than inside it:
`task.context.reviewDisputeEvidenceRound` records, per lineage, the finding
version the round is being collected against, the round number, and one
record per party — the party run's id, its attempt, its collection state
(`running`, `recoverable`, or `completed`; a party with no record has not
started), the count of admitted §3.3 attachments, and, when the run
recorded them, the admitted references themselves plus safe references to
the §10.2 files it wrote. The round is spent when row 22 applies, and the
record keeps the run id that applied it so a redelivery converges. Zero
admitted attachments is a completed party, never a missing one.

The record carries no evidence content: a file, test, or doc-section
reference is repository-relative by §3.3 and is persisted as written, while
a quoted span of the Issue body is persisted as a digest and a length — the
span itself is in the artifact. Artifacts are named by base name, digest,
and byte length, never by path. Blocks written before this record existed
carry none, and blocks carrying only per-party counts (the record's first
form) stay readable: the absent fields mean `completed`, round 1, and "no
reference detail was recorded", which is exactly what those blocks meant.

### 10.2 Artifacts (local-only)

- `review-findings.json` — the structured findings admitted from a review
  run, keyed by lineage/version.
- `fix-dispositions.json` — the disposition records of a fix run.
- `dispute-<lineageId>.json`, `reconsideration-<lineageId>.json`,
  `arbitration-<lineageId>.json` — the full per-lineage records, including
  the arbiter bundle manifest (what was included, by reference and hash,
  not duplicated content).
- `reconsideration-raw-<lineageId>.txt` — the reviewer reconsideration run's
  raw, unvalidated output, preserved exactly as the agent produced it: the
  runner inserts no delimiter, banner, or heading, and the only content it may
  add is an explicit truncation marker where the artifact's byte bound actually
  cut the output. It is written before the answer is parsed, so a malformed
  reviewer turn leaves a transcript to diagnose; it is never a record, never
  re-read by the protocol, and — like every artifact here — never published
  (§11).
- `reconsideration-stderr-<lineageId>.txt` — the same run's standard error, on
  the same terms, written only when the agent wrote to BOTH streams. Two
  streams are two files rather than one merged transcript, because merging them
  would require runner-authored bytes inside a file that promises to carry none.
  "Both streams" means bytes, not parseable content: a stdout carrying only
  whitespace was still written by the agent, so it stays the raw artifact and
  stderr lands here. Only a completely empty stdout collapses the two, and then
  the parsed output IS stderr, so stderr is the raw artifact and this file is
  not written.
- `reconsideration-runner-error-<lineageId>.txt` — the runner's own diagnostic
  for a reconsideration whose agent subprocess failed to run at all: a timeout,
  an output-buffer overflow, a missing command. It exists so the two transcripts
  above can keep their promise — bytes the agent never wrote are never appended
  to them, because a runner diagnostic persisted as reviewer output would read as
  a turn the reviewer never took. Written only when there is such a failure, and
  local-only on the same terms as everything else here.
- `reconsideration-events-<lineageId>.jsonl` — the progress stream of a
  reconsideration run under the `read-bounded` posture (§17.16), where the CLI
  separates progress from the answer: `--json` writes JSONL events to stdout while
  the reviewer's actual answer goes to a runner-owned file, so stdout there is not
  the transcript the three files above describe. Preserved because it is still the
  agent's own output and a run that produced no answer leaves nothing else to
  read; never parsed for a verdict, which is the whole reason the answer has its
  own channel. Never written by a `no-tools` run, whose stdout IS the answer and
  is already the raw transcript.
- `arbitration-bundle-<lineageId>.json` — the §8.2 manifest of one arbitration
  run: what the bundle carried, by reference and hash, plus the bundle digest,
  the prompt's byte length, and the sanitized resolved-profile metadata. Written
  BEFORE the arbiter answers, because a malformed arbitration writes no verdict
  record and "what was this arbiter actually shown?" is exactly the question such
  a run raises. The verdict record embeds the same manifest, so an admitted
  record stays self-contained.
- `arbitration-raw-<lineageId>.txt`, `arbitration-stderr-<lineageId>.txt`,
  `arbitration-runner-error-<lineageId>.txt` — the arbitration run's transcripts,
  on exactly the terms of their `reconsideration-` counterparts above: the
  agent's bytes as produced, a separate file per stream when both carried bytes,
  and a separately named file for bytes the RUNNER wrote about a subprocess that
  never ran. Written before the answer is parsed, never records, never published.

- `evidence-<party>-<lineageId>.json` — one party's evidence-collection run for
  one lineage: the references it returned, which of them resolved, and which
  were dropped. Party-scoped because §7.1 dispatches two runs for one lineage,
  one implementer-side and one reviewer-side, and neither may overwrite the
  other's record.
- `evidence-raw-<party>-<lineageId>.txt`,
  `evidence-stderr-<party>-<lineageId>.txt`,
  `evidence-runner-error-<party>-<lineageId>.txt` — that run's transcripts, on
  exactly the terms of their `reconsideration-` and `arbitration-`
  counterparts above: the agent's bytes as produced, a separate file per stream
  when both carried bytes, and a separately named file for bytes the RUNNER
  wrote about a subprocess that never ran.

Cleanup follows one rule: answering a dispute clears its **routing**, never
its **record**. A withdrawal, an uphold, a revision, or an arbitration
verdict ends that lineage's pending turn — it must not be routed a second
time — and retains every artifact, because those artifacts are the arbiter's
bundle input (§8.2), the human's audit trail (§9), and the predecessor half
of the §5 materiality comparison. The per-lineage context bookkeeping
(counters, `rebuttedVersions`, `disputeRuns`) is retained for the same
reason a revision mints a new version rather than reopening the old one: the
spent budget is what keeps the debate bounded. Only task completion releases
the artifacts, and only to the session's ordinary artifact retention — the
protocol deletes nothing itself.

### 10.3 Audit events

Audit events are named `dispute.<subject>.<action>`. Every transition in
§7 emits exactly one; two events are emitted without a state transition:
`dispute.rebuttal.rejected` on malformed output that changes no state
(§12), and `dispute.reopen.requested` when §7.1 rule 1 escalates a
terminal lineage carrying the `reopen_requested` flag (§6.4). The full
vocabulary:

`dispute.finding.opened`, `dispute.rebuttal.recorded`,
`dispute.rebuttal.rejected` (malformed, fail-closed),
`dispute.reconsideration.recorded`, `dispute.revision.material`,
`dispute.revision.non_material`, `dispute.revision.ambiguous`,
`dispute.arbitration.verdict`, `dispute.arbitration.malformed`,
`dispute.evidence.requested`,
`dispute.reopen.requested`, `dispute.escalated.human`,
`dispute.resolved`.

The vocabulary carries no evidence-completed token, so the one
evidence-subject event covers both ends of the bounded round: row 16
requests it and row 22 records the collected attachments, and the two are
distinguished in the audit record by the row and by the incremented
`evidenceRoundsUsed` counter row 22 carries.

Row 20 emits `dispute.arbitration.malformed`; row 21 emits
`dispute.escalated.human` carrying the cap-reached
`malformedArbiterAttempts` count (`2` at the default cap) in its
counters, so below-cap and cap-reaching malformed arbiter attempts are
always distinguishable in the audit record.

Event fields: task id, issue number, `lineageId`, `version`, actor role
(`implementer` | `reviewer` | `arbiter` | `runner`), provider/agent id,
the outcome literal, confidence when present, and timestamps. Events carry
literals and counters only — never argument prose, evidence content, or
local paths.

## 11. Public GitHub comment policy

Same posture as the semantic-conflict escalation policy in
[phase-contracts.md](phase-contracts.md): public text describes the *shape*
of the outcome, never its *content*.

A public comment is posted only on lineage resolution or human escalation,
and contains at most: the lineage id, the finding's `severity`, its
`affectedBoundary` — always the admission-normalized repository-relative
value of §2.1, never a raw agent-supplied path — the outcome literal, and
counts (versions, arbitration passes). The outcome literal is the
lineage's terminal state — exactly one of `resolved_fixed`,
`resolved_withdrawn`, `resolved_overruled`, `escalated_human`. `binding`
is not a resolution and never receives its own comment: a lineage that
becomes `binding` is published only when it later reaches a terminal
state via §7 rows 23–24. Because admission fails closed
on any `affectedBoundary` that names a location outside the repository
(§2.1, §12), no admitted lineage can carry a local filesystem path into
this comment.

Never published: rebuttal or rationale prose, arbiter reasoning, evidence
content or quoted file lines, local filesystem paths, raw agent output,
session/run/task-store identifiers, or provider error text.

## 12. Fail-closed behavior for malformed agent output

**Malformed** is any of: an unparseable structured block; an unknown enum
token; a missing required field; an unresolvable evidence reference; an
`affectedBoundary` that names a location outside the repository after the
admission normalization of §2.1; a
disposition for an unknown lineage or a version that is neither `open` nor
`binding`; a `fixed`
disposition in a fix run that produced no file changes (§3.4); a second
rebuttal for the same version; a `review_disputed` on a `binding` finding;
a `revise` without predecessor or changed fields; an arbiter verdict outside
the four tokens or without a confidence.

Effect for implementer and reviewer output, uniformly: the runner records
`dispute.rebuttal.rejected` (or the corresponding audit event),
**no protocol state changes**, no bounded
counter is consumed, and the run outcome falls back to today's semantics —
for fix mode, a run with no diff and no admitted disposition still fails
with "produced no file changes". That fallback to today's run outcome
applies only to a run with **no** file changes. When a fix run produces a
diff but a required disposition is missing or malformed, the §7.1
aggregation is the authoritative router and today's
success-routes-to-review rule does not apply: because malformed output
changes no protocol state, the affected lineages remain `open` (or
`binding`), so §7.1 rule 2 selects another implementer turn carrying
them, and the diff is retained exactly as in every other rule-2
continuation — it stays on the branch and the runner records
`pendingReReview: true` (§7.1), so the unreviewed diff's ordinary
re-review is deferred, never skipped: the accumulated diff routes to
review via §7.1 rule 3 once no lineage keeps the task in rule 2.
Malformed output can therefore never win a
dispute, never burn the implementer's rebuttal slot, and never bypass the
review-loop cap that bounds retries. Repeated malformed output exhausts the
existing `session.reviewLoop.maxCycles` cap and lands at `ready_for_human`
(§9).

Malformed **arbiter** output is the one tracked exception, because the
arbiter is runner-invoked between runs — an unrecorded retry would be
indistinguishable from the first attempt and the required
cap-reached escalation could not be implemented deterministically. The
runner increments the lineage's `malformedArbiterAttempts` counter
(runner-owned, recorded in §10.1; it bounds arbiter retries only and never
consumes an arbitration pass, the rebuttal slot, or the reconsideration)
and follows §7 rows 20–21: a below-cap malformed attempt emits
`dispute.arbitration.malformed` and re-invokes the arbiter; the
cap-reaching attempt emits `dispute.escalated.human` and escalates.
Malformed arbiter output still never decides the dispute for either
party.

## 13. Backward compatibility: legacy free-form `reviewFeedback`

- `task.context.reviewFeedback` remains, bounded exactly as today, and
  remains the fix-prompt payload. The structured findings are additive.
- With `session.reviewDispute.enabled: false` (the default), review and fix
  behave byte-identically to today: free-form feedback, no lineages, no
  dispositions, and a no-change fix run fails.
- With the protocol enabled, a review run that emits **no** structured
  finding blocks (a legacy-format review) is handled exactly as today: the
  classifier's `needs_fix` routes to fix mode on free-form feedback alone,
  no lineage exists, and therefore no dispute is possible. Legacy review
  results thus have a defined compatibility path: the protocol is inert for
  them, never a hard error. A review agent whose report this runner does not
  author is never *asked* for the envelope and always takes this path — today
  that is `codex`, for the structural reason recorded as §17.4 C9, and §17.5 B1
  states what would have to be decided to change it.
- A review is **fully structured** when, after the runner extracts the
  structured finding blocks, the remaining free-form feedback is empty or
  whitespace-only. A **mixed review** (structured findings plus non-empty
  free prose) admits the structured findings into the protocol, and the
  prose keeps its legacy blocking force: it travels in `reviewFeedback`,
  stays in the fix prompt, and is handled exactly as today. The prose
  cannot be disputed — and because the runner cannot verify that free
  prose contains no additional blocking findings, mixed reviews fail
  closed: the zero-change validity of §3.4 and the
  `resolvedWithoutChanges` outcome of §7.1 rule 4 apply only to a fully
  structured review. In a mixed review a no-diff fix run fails exactly as
  today even when every lineage ends in a no-change terminal state, so a
  prose-only blocking finding can never be silently dropped. A reviewer
  who wants a finding disputable must emit it as a structured block.
- The existing classifier vocabulary (`success`, `needs_fix`, `conflict`,
  `blocked`) and the `nextPhaseAfter` routing are unchanged; the protocol
  refines what happens *inside* the `needs_fix` loop and adds the §7.1
  aggregation — including the reviewer-turn reconsideration dispatch — on
  top.

## 14. Decision record

### 14.1 Chosen

Structured per-finding lineage with a strictly bounded debate
(1 rebuttal per version, ≤ 2 versions, 1 reconsideration, ≤ 2 arbitration
passes, ≤ 2 malformed-arbiter attempts, 1 evidence round), runner-owned
deterministic materiality checks, a provider-independent read-only
arbiter, and human escalation for
ambiguity, low confidence, human-gated risk, insufficient evidence, and
missing arbiters.

Accepted costs, stated plainly: up to two extra AI turns per disputed
lineage plus up to three arbiter invocations — at most two return a
valid verdict (the arbitration passes), and one more can be consumed by
a malformed-output retry, since the first malformed attempt re-invokes
the arbiter without consuming a pass (row 20) and a second malformed
attempt escalates and ends the lineage (row 21) — and up to two
evidence-collection runs; reviewer prompts grow by the
prior-lineage digest; a deterministic materiality check will sometimes send
a genuinely material rewording to arbitration (the fallback is by design).

### 14.2 Rejected

| Alternative | Why rejected |
| --- | --- |
| Free-form "I disagree" handling (prompt the fixer to argue in prose) | Unverifiable, unbounded, and indistinguishable from refusal; no lineage, no audit, no cap. |
| Unlimited implementation/reviewer back-and-forth until convergence | Review/implementation ping-pong is the failure mode this contract exists to remove; convergence is not guaranteed. |
| Letting the reviewer's `materialityClaim` decide materiality | The interested party would grade its own revision; materiality must be a runner-owned structural check with arbitration for ambiguity. |
| Letting the arbiter edit code or add findings | Would make the arbiter a third implementer/reviewer and reopen the debate it exists to close. |
| Fixing one vendor/model as the arbiter | Out of scope by the Issue; provider independence is a selection policy, not a vendor name. |
| Same-model arbiter by default | An arbiter sharing a party's model correlates with that party's failure modes; allowed only by explicit same-provider opt-in, never same-model. |
| Treating a no-change run as a dispute implicitly | Silence is not evidence; the no-diff failure stays for runs without an admitted disposition. |
| Auto-accepting disputes when no arbiter is configured | Fail-open; absence of an arbiter must escalate to a human, not decide the dispute. |

## 15. Specification gaps (open)

Recorded rather than closed: each item below is a transition this contract
does **not** define, discovered while building a surface that needed one. An
implementation must fail closed on these — state the stop reason, point at
the existing recovery path, and change nothing — rather than invent the
missing semantics locally. Closing a gap is a change to this document first
(see the authority note above).

**G1 — no human-resolution transition out of `escalated_human`.** §9 lists
exhaustively when a lineage escalates, and §6.4 makes terminal states
immutable audit records, so a human's decision has nowhere to land: there is
no row that consumes a human verdict, no field for one in §10.1, and no audit
event for it in §10.3. The consequences are deliberate for now — the human
decides on the pull request itself, the lineage stays `escalated_human` as
the record of how the debate got there, and the only operator-initiated
transition the contract defines remains §6.4's `reopen_requested` flag, which
records a request against a **resolved** lineage without overturning it.
Operator tooling therefore reports "no automated action is authorized" for an
escalated lineage instead of offering a continuation. A future revision that
wants one must add the row, the persisted field, and the audit event
together; note that `spec_ambiguous` and the unavailable-arbiter path in
particular escalate precisely *because* automation cannot decide, so any such
row has to say what a human verdict authorizes the next run to do.

**G2 — no operator continuation for the undispatched-turn park.** The §9
task-level handoff for a §7.1 turn the runner cannot take leaves the lineage
untouched by design, which is correct, but it also means an operator has
nothing to act on: requeuing the task into review would hand an open lineage to
a run that cannot discharge it. Every turn now has a dispatcher — the reviewer
turn gained one in issue #952, the runner (arbitration) turn in issue #955, and
the evidence turn's two per-party runs plus the row 22 that closes them in issue
#964 — so this park no longer describes an ordinary dispute. What it now
describes is the fail-closed stop for a run that could not ANSWER its turn: an
unlocatable or stale §10.2 record, an unreadable round record, or a party whose
agent identity the runner cannot name. Closing the remaining gap means giving
those stops a protocol-level continuation — a row, a persisted field, and an
audit event — not adding an operator command that moves a lineage nobody
adjudicated.

**Not gaps of this kind: the §17 capability decisions.** D1 and D2 are open too,
but they are a different sort of open. G1 and G2 are transitions this contract
does not define; D1 and D2 are decisions about which agent CLI may take a turn
this contract already defines completely. No row, field, or event is missing for
them, and the current behavior — a Codex reviewer on §13's legacy path, a Codex
reconsideration or arbitration refused — is this contract working, not this
contract silent.

## 16. Verification (documentation tests)

`test/docs-review-dispute-contract.test.js` structurally pins: the three
disposition tokens, the three reconsideration tokens, the four arbiter
verdicts, the lineage-state vocabulary, every transition-table row's
state/event/next-state triple, the bounded-debate constants, the
material-field list and its non-material exclusions, the fail-closed rules,
the arbiter restrictions and selection policy, the escalation conditions,
the legacy-`reviewFeedback` compatibility path, and the open specification
gaps of §15 — plus the cross-document pointer from
`docs/phase-contracts.md`. `npm test` runs it.

Behavioral verification of the implemented protocol lives alongside it:
`test/review-dispute-qualification.test.js` (issue #965) drives the REAL review
and implementation handlers through the real phase runner with deterministic
stub agents, so the gate, the four automated turns, the human handoffs, the
replay rules and the operator projections are exercised as an operator reaches
them; `test/review-dispute-e2e.test.js` (issue #849) drives whole lifecycles
through the real phase runner, task store, outbox and admin projections on both
TaskStore implementations; `test/review-dispute-rollout.test.js` pins default-off
behavior and the audit-preserving disable/re-enable round trip;
`test/docs-review-dispute-operations.test.js` pins the operator document; and
`test/docs-review-dispute-codex-capability.test.js` (issue #1067, amended by
#1069, #1070 and #1085) pins §17 against the runner's own capability tables —
that `codex review` is still refused for structured findings, that `codex` is
still refused as an arbiter candidate and refused for reconsideration **in a
session that has not recorded the §17.6 D2 opt-in**, that the refinement lane's
differently-scoped Codex profile is the one §17.5 describes, that §17 records
both decisions as taken with the bounds they were taken under rather than making
a wider readiness claim, and that the posture an opted-in session resolves is
`read-bounded` and never the `no-tools` literal §17.5 refuses;
`test/codex-structured-review.test.js` with `test/review-findings-schema.test.js`
(issue #1068) exercise §17.10's adapter against a subprocess fixture that stands
in for the CLI — real argv, real stdin, real streams, real isolation, and never a
real `codex`; and `test/review-codex-structured-lane.test.js` (issue #1069)
drives the §17.11 lane through the REAL review handler with that same fixture,
covering the clean envelope, a re-raised lineage, an unknown lineage id, stale
evidence, a failed required verification, a missing or truncated diff, the
disabled session's byte-identical `codex review`, and every invocation failure
that must not read as a pass. `test/review-reconsideration-invocation.test.js`
(issue #838, extended by #1070) covers §17.12's stop as behavior rather than as a
message — a configured Codex reviewer spawns nothing, reads nothing and writes
nothing — alongside the §8.2 boundary the Claude turn does enforce, asserted
against the isolated subprocess's own state and not against its argv. And
`test/review-dispute-round-trip.test.js` (issue #1071) drives §17.13's loop
across real phase boundaries in the mixed configuration §965's suite does not
cover — a Codex reviewer and a Claude implementer — pinning the §3.4
rebuttal-only run against the ordinary no-op it must not be confused with, the
unrelated blocking finding that stays in force, the bounded park the reviewer's
turn stops at and its recovery, the disabled session's untouched debate, and
which agent §4.1's turn is dispatched to once the lane has moved. Finally,
`test/review-dispute-default-path-e2e.test.js` (issue #1072) drives that same
default configuration with **no agent seam at all**: the §17.11 review lane, the
§4.1 reconsideration and the §8.3 arbiter each resolve and spawn their own
production invocation, against fake `claude` and `codex` executables installed on
`PATH` under the real command names, a disposable git repository with real base
and issue commits, an isolated home, and the real task store and outbox. It pins
the Codex-raised finding, the §3.4 Claude rebuttal that edits nothing, the §17.12
park and its recovery — and, on the lane whose reviewer of record does have a
§8.2 invocation, the withdrawal and revision round trips, the upheld dispute that
escalates exactly once, and the negative paths: malformed output, a reviewer
killed mid-turn, evidence that no longer resolves in this checkout, a restarted
delivery, and the disabled session's native `codex review`.
`test/review-reconsideration-read-bounded.test.js` (issue #1085) covers §17.16's
posture at the invocation layer — the opt-in that admits it and the default that
does not, the exact argv and the flags that must never appear in it, the
final-message handshake and each way it can fail, the isolation the run actually
gets, and the posture literal travelling into the §10.2 record — and the same
milestone extends the default-path suite above with the Codex reviewer's
withdrawal, revision and upheld round trips driven through production dispatch to
a real `codex exec` subprocess, plus the default-off refusal on the identical
task. None of them runs a paid agent, calls GitHub or Slack, touches the network,
or edits SQLite by hand.

## 17. Codex participation: capability record and pending decisions

### 17.1 What this section decides, and what it does not

Issue #1067 asked one question: **can the protocol be run with Claude
implementing and Codex reviewing?** This section is the answer, and it is
deliberately narrow. It changes no state, no transition, no counter, no
schema, and no default. It adds no provider abstraction and no runtime. It
records which CLI this runner can invoke for which turn, on what evidence,
names the exact blocker where it cannot, and states the two decisions an
operator would have to make before a successor implements anything.

**Both decisions are now recorded, and each is bounded by what it was approved
for.** D1 is taken — see §17.11, and issue #1069, which routes an enabled
session's Codex review through §17.7's `codex exec` invocation. **D2 is taken as
of 2026-09-07** — see §17.16, and issue #1085, which implements the separately
named `read-bounded` posture for the reviewer's §4.1 reconsideration behind an
explicit, default-off session opt-in
(`reviewDispute.reconsideration.readBounded`). Issue #1070 was the successor that
asked for that turn while D2 was unrecorded, and it stopped on exactly that —
§17.12, whose ordered successor path §17.16 is the completion of. Issue #1071
asked for the round trip that ends in that turn, stopped at the same place, and
recorded the one integration fault the exercise uncovered — §17.13; issue #1072
re-ran the same path through production dispatch — §17.14.

What D2 did **not** move: **a Codex arbitration still fails closed** (§8.3's
candidate resolver is a separate turn and was not in scope), C7 is still
`unknown` in §17.4 and no §17.8 canary has been run, no default changed, no cap
moved, no counter or transition was touched, no session was auto-enabled, and a
session with the protocol disabled runs `codex review` byte for byte as it always
has. A session that has not written the opt-in down behaves exactly as it did
before #1085, refusal included.

### 17.2 Evidence grading

Capability claims are graded with the vocabulary
[single-host-platform-sandbox-contract.md](single-host-platform-sandbox-contract.md)
§6.3 already uses, and with its evaluation rule, so this contract does not
invent a second scale:

| Grade | Meaning here |
| --- | --- |
| `verified` | The invocation is pinned in this repository's own tree and covered by `npm test`, or an on-host canary demonstrated the boundary. |
| `vendor-documented` | The vendor documents the flag or the mechanism, but no on-host check in this repository has exercised it. Credited as documentation, never as attestation. |
| `unknown` | No verified or documented mechanism is on record. |

**Unknown evaluates as absent**, as it does there: a capability that cannot be
established takes the more restrictive reading everywhere a decision is made.
A `vendor-documented` grade is likewise not an enforcement point — §8.2 names
*the runner* as the enforcement point, and a runner cannot enforce with a flag
whose effect it has not observed.

### 17.3 The tested build

**No Codex build has been tested against this contract in this repository, and
no version gate is pinned for one.** That is a recorded fact, not an omission
to be read past: under §17.2 every Codex row below that is not pinned in this
tree is at most `vendor-documented`, and the one row §8.2 actually turns on is
`unknown`.

When a successor lands a Codex turn it must also pin the build it was tested
against, in the shape
[antigravity-workspace-settings.md](antigravity-workspace-settings.md) already
uses for `agy` (`>=1.1.9 <2.0.0`): a declarative `codex --version` gate, so a
CLI whose behavior moves is refused rather than silently trusted. The probe
itself already exists — `codex --version` is the availability probe
`admin session-doctor` and the parent/child workflow run — and it is
non-billable and unauthenticated. §17.8 is the operator procedure that turns
a `vendor-documented` row into a `verified` one; it is explicitly **not** a
CI test, because it spawns a real CLI.

### 17.4 Capability record

| # | Capability | Grade | Basis |
| --- | --- | --- | --- |
| C1 | Non-interactive single-shot run whose prompt is **runner-authored** and delivered on stdin, with no prompt argument (`codex exec`) | `verified` | Pinned by the refinement lane and by the implementation lane. |
| C2 | Declarative version probe that exits without authentication (`codex --version`) | `verified` | The availability probe already used by `admin session-doctor` and by the parent/child workflow. |
| C3 | Model as a **global** option before the subcommand (`codex --model … exec …`), effort as `-c model_reasoning_effort=` over exactly `low` / `medium` / `high` | `verified` | Pinned in the review, implementation and refinement lanes; the three-level set is why the Claude-only tiers `xhigh` and `max` map to `high`. |
| C4 | Read-only sandboxing of **agent-owned** commands (`--sandbox read-only`) | `vendor-documented` | Graded `vendor-documented` for `codex` by single-host-platform-sandbox-contract.md §6.3, with spikes S1/S2 open on Landlock availability and on the CLI's behavior when it is missing. Pinned by the refinement lane; no on-host canary has run. |
| C5 | Refusal of the user configuration file, and with it the MCP servers and hooks declared in it (`--ignore-user-config`) | `vendor-documented` | Pinned by the refinement lane for exactly this reason. Necessary rather than optional here: see §17.7's environment row — a Codex no-tool turn runs with a throwaway `HOME` but a `CODEX_HOME` pointed back at the operator's real `~/.codex`, because that is where its login is, so the config file is reachable unless the flag refuses it. |
| C6 | A structured final message validated against a caller-supplied schema (`--output-schema`) | `vendor-documented` | Described by the vendor's non-interactive documentation. Issue #1068 pins how the runner CONSTRUCTS the flag and the schema document, under `npm test` — which is a fact about this repository, not about any build, so the grade does not move: no on-host run has shown a CLI honoring it. The adapter therefore leaves the flag OFF by default and never treats a response as valid because a schema was supplied (§17.10). |
| C7 | **Removal of the tool surface itself** — no tool reachable by the model at all, the posture §8.2 requires | `unknown` | No documented Codex option is the equivalent of the Claude CLI's `--tools ""` / `--allowedTools ""` / `--disallowedTools` triple. `--sandbox read-only` constrains what an agent-owned command may *do*; it does not remove the command tool, and it does not bound reads. |
| C8 | Refusal of project-scoped instructions and configuration discovered from the working directory | `unknown` | No flag on record. The refinement lane compensates structurally — a throwaway `mkdtemp` cwd that is not a checkout — rather than with an option, which is also why it must pass `--skip-git-repo-check`. |
| C9 | An output contract the `codex review` subcommand is obliged to honor | absent by construction | `codex review` is handed a `--title` brief and a `--base` and composes the report itself. There is no seam for a runner-authored schema, which is the recorded reason `codex` is in `STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS` (§13). |

### 17.5 The two blockers

**B1 — a Codex reviewer cannot be asked for the §2.1 finding envelope.**
C9 is structural, not a gap in the runner: the `codex review` report is
agent-authored, so there is nowhere to put a contract the reviewer must honor.
§13's compatibility path handles that correctly — such a session runs the legacy
prose flow with no lineages, so the protocol is inert for it rather than
permanently malformed. B1 blocks *structured Codex review*, not the protocol.

**B1 is now closed for enabled sessions, by D1 rather than around it** (§17.11).
The close does not weaken C9 and does not touch §13: it changes which COMMAND an
enabled session's Codex review runs. `codex exec` takes a runner-authored prompt
(C1, `verified`), which is a seam for the output contract that `codex review` has
never had. A disabled session still runs `codex review`, and for it C9 and §13's
compatibility path read exactly as above.

**B2 — the §8.2 posture cannot be enforced for Codex today.** This is the
finding that matters, and it does not follow from the sandbox:

- §8.2's boundary is about **inputs**, not side effects: "the arbiter is
  invoked with no tool permissions, and the bundle is the entire input", and
  read tools are denied for a stated reason — an agent that reads a file the
  runner did not resolve is deciding on evidence nobody bounded. The same line
  is drawn for the reviewer's reconsideration.
- `--sandbox read-only` bounds **writes and network** for agent-owned commands.
  It leaves reads available, and reads are exactly what §8.2 excludes. A
  read-only sandbox is therefore not evidence for C7; it answers a different
  question.
- C7 is `unknown`, and under §17.2 unknown evaluates as absent. So the runner —
  §8.2's named enforcement point — has no mechanism with which to enforce.

Two inferences are explicitly **refused** here, because each would weaken the
policy without saying so:

1. **A prompt is not an enforcement point.** Instructing a model not to use its
   tools leaves the tools reachable, and §8.2 is a runner obligation precisely
   so that it does not rest on the model's compliance.
2. **The refinement lane's precedent does not transfer.**
   [issue-refinement-contract.md](issue-refinement-contract.md) §7.3 requires
   its two roles to run isolated with the invocation enforcing the boundary, and
   the lane's resolver records `toolPolicy: "no-tools"` on its Codex profile.
   What that profile actually pins is `--sandbox read-only`,
   `--skip-git-repo-check` and `--ignore-user-config` over a throwaway cwd and a
   credential-stripped environment: no writes, no network, no user config — a
   real boundary, and a weaker one than §8.2's, because reads are not in it.
   This contract does not adopt it by precedent, and a successor must not reuse
   the `no-tools` literal for a Codex dispute turn on the strength of it.
   Whether the refinement lane wants a different label for the same reason is a
   question for that contract, not a change this one makes.

B2 blocks the reviewer's reconsideration and the arbitration turn for Codex —
which is why the reconsideration profile resolver refuses a non-Claude agent and
the arbiter candidate resolver reports `unsupported-role`. Both are correct
under this contract as written and must not be relaxed to close B2.

**B2 is not closed, and for the reconsideration turn it is now routed AROUND by
D2 rather than through** (§17.16). Nothing above is weakened by that: C7 is still
`unknown`, `--sandbox read-only` is still not evidence for it, the `no-tools`
literal is still refused for a Codex dispute turn, and the §8.2 posture still
cannot be enforced for that CLI. What §17.16 adds is a DIFFERENT posture with a
different name and a weaker guarantee, admitted only by explicit session opt-in
and recorded on every lineage it decides. A session without that opt-in meets
exactly the refusal described above. The **arbitration** turn is untouched: the
arbiter candidate resolver still reports `unsupported-role` for `codex`, because
D2 was approved for the reviewer's reconsideration and nothing else.

### 17.6 The two decisions an operator would have to approve

Neither may be taken by a successor without an explicit operator decision
recorded against this section. They are stated in full so that the decision is
about a known shape rather than about a direction. **Both have since been
recorded and implemented — D1 in §17.11, D2 in §17.16.** Both proposals are left
below exactly as written, in the present tense they were approved in, so the
shape that was approved is the shape that is on record and an implementation can
be measured against it rather than against a summary of it.

**D1 — a runner-authored Codex review lane (addresses B1).** For sessions with
`reviewDispute.enabled: true` only, resolve a Codex review through `codex exec`
with a runner-authored prompt carrying the §2.1 envelope instruction — the
shape the refinement lane already runs — instead of through `codex review`,
optionally pinning `--output-schema` once C6 is `verified`.

What the operator is approving: **what a Codex review is** for an enabled
session changes. The vendor's own diff-review pipeline is no longer what
produces the report; a runner-authored prompt is. That is a product decision
about review quality, not only a plumbing change, and it cannot be evaluated
from this document. Bounds that come with the proposal: disabled sessions keep
`codex review` byte-identically (§13's default-off guarantee is unaffected); no
loop cap moves; no second flag is introduced; and the lane fails closed to
§13's legacy path if the envelope does not parse, exactly as a malformed
Claude envelope does (§12).

**D2 — a named weaker tool posture, never the `no-tools` label (addresses
B2).** Add a second tool-policy literal — `read-bounded` is the working name —
for a turn whose CLI cannot empty its tool surface, admitted only under an
explicit session opt-in, and recorded on the run profile and in the §10.3 audit
so a lineage decided under it is distinguishable forever from one decided under
`no-tools`.

What `read-bounded` would and would not guarantee, stated as the operator would
have to accept it:

| Property | Under `no-tools` (§8.2 today) | Under `read-bounded` (D2) |
| --- | --- | --- |
| Writes by the agent | no tool exists to attempt one | refused by the CLI sandbox (`vendor-documented`, C4) |
| Network by the agent | no tool exists to attempt one | refused by the CLI sandbox (`vendor-documented`, C4) |
| Reads by the agent | no tool exists to attempt one | **available**; bounded only by a throwaway cwd and the host's own read permissions |
| "the bundle is the entire input" | guaranteed | **not guaranteed** |
| MCP servers / hooks from user config | refused by argv | refused by argv (`--ignore-user-config`, C5) |
| Project config discovered from cwd | refused by argv | not refused by any flag; mitigated structurally by the throwaway cwd (C8) |

The row that is the decision is the third one, and through it the fourth.
Evidence-boundedness is the property a reconsideration and an arbitration rest
on: a verdict reached partly on unbounded reads is not the verdict §8.1
specifies, however sound it happens to be. An operator may still decide that a
contained-writes, contained-network, unbounded-reads judgement is worth having
from an independent provider — that is a legitimate answer, and it is theirs to
give, in writing, against this section.

**D2 as approved (2026-09-07).** The operator gave exactly that answer, in
writing, for the reviewer's §4.1 reconsideration and for no other turn:

> Permit Codex reconsideration under a restricted execution posture even though
> additional file reads cannot be completely prohibited.
> Do not describe it as the existing no-tools posture; record the distinction.

The approval covers the specification and code work and explicitly does **not**
cover changing any operational session's settings or enabling the feature on a
live session during development. The implementation is §17.16, and the four
conditions this row attaches to the decision — a separately named literal, an
explicit session opt-in that is off by default, the posture recorded on the run
profile, and the §10.3 audit and operator surfaces carrying it so a lineage
decided under it stays distinguishable forever — are the acceptance test for it,
not a summary of it. The table above is the honest description an operator is
accepting, and it is repeated at every surface the posture reaches rather than
being softened once it is in use.

**Not proposed, and out of bounds for any successor of #1067:** relaxing §8.2
in place; reusing the `no-tools` literal for a posture that does not empty the
tool surface; enabling either decision for an operational session as part of
development; a metered API path or provider substitution to work around either
blocker; any increase to the §6.1 caps or to `session.reviewLoop.maxCycles`;
and automatic merge.

### 17.7 The invocation contract a Codex dispute turn would pin

Recorded now so that the approval in §17.6 is given against an exact boundary
rather than an intention, and so that a successor implements this shape or
amends this section. Every row is the shape a Codex turn would inherit from
seams that already exist; none of it is new machinery.

| Aspect | Contract |
| --- | --- |
| Subcommand | `codex exec`. Never `codex review`: a dispute turn's prompt is runner-authored by definition (C1, C9). |
| Prompt delivery | stdin, with no prompt argument. The bundle never appears in argv, so it cannot overflow the argument limit and is not visible in a process listing — the same rule the Claude reconsideration follows. |
| Argv (sanitized) | `codex [--model <m>] exec --sandbox read-only --skip-git-repo-check --ignore-user-config -c model_reasoning_effort=<low\|medium\|high>`, plus `--output-schema <path>` only once C6 is `verified`. `--model` is a global option and must precede the subcommand. §17.10's adapter implements the schema flag as an OPT-IN that is off by default, which is this rule honored rather than deferred: pinning the construction of a flag is not evidence that a build honors it, and §17.9 reserves a change to this row for a successor carrying §17.8's canary. |
| Tool policy recorded | `read-bounded` under D2. Never `no-tools` (§17.5). |
| cwd | A throwaway `mkdtemp` directory, not the worktree and not a checkout — which is why `--skip-git-repo-check` is required rather than incidental. |
| Environment | The shared isolated environment: every write-enabling token stripped, `GH_CONFIG_DIR` pinned at an empty temp dir, every cwd-bearing variable deleted. `HOME` is throwaway for the `openai` provider (the `inherit` policy of [agent-isolation-policy.md](agent-isolation-policy.md) is Anthropic-specific), with `CODEX_HOME` synthesized at the real `~/.codex` so the CLI's own login is reachable. That single passthrough is why C5 is load-bearing: the operator's `config.toml` is otherwise in scope. |
| Response format | One fenced JSON code block holding one object, as the last thing in the response — the same record the Claude turn returns. The §12 admission rules are unchanged, and a Codex response that does not parse is malformed under §12 exactly as a Claude one is. |
| Artifacts | Runner-owned, §10.2, local-only, under the session's artifact directory. Both streams are preserved whatever the exit code; runner-written spawn bytes are peeled back off before capture so the transcript holds agent output only; the raw capture is byte-bounded. |
| Timeout | The runner's own deadline — the reconsideration lane's ten minutes, unchanged. A turn that ran out of time is reported distinctly from one that ran and exited non-zero. |
| Cancellation | The deadline is the only cancellation, and it is the runner's; the subprocess is killed and the turn ends. An invocation failure spends **no** protocol counter and moves no lineage — the fail-closed park of §9 applies unchanged. |
| Model | `CODEX_MODEL`, then `session.codex.model`, then unset. **Unset stays absent**: `--model` is not passed and the profile records `cli-default`, which §8.3 treats as no model at all — so a Codex arbiter can never satisfy the same-provider fallback on an unset model, by design. |
| Effort | `CODEX_EFFORT`, defaulting to `high` as the other dispute turns do. `xhigh` and `max` map to `high` (C3). |

### 17.8 The operator smoke check (never CI)

The procedure that would move C4–C7 off `vendor-documented`, in the shape
[agent-isolation-policy.md](agent-isolation-policy.md) §4 already uses for the
Claude login: an operator-run check, because it spawns a real CLI and may bill
a real turn.

1. Record the build: `codex --version`. Unauthenticated, non-billable, and the
   value a successor's version gate would pin (§17.3).
2. Confirm the flags of C4, C5 and C8 are accepted by that build, from the
   CLI's own help — a flag the build does not recognize is a failed startup,
   not a silently weaker boundary.
3. The C7 canary, which is the only one that decides anything: under the §17.7
   environment and argv, give the CLI a prompt asking it to read a file that
   exists on the host but is **not** in the bundle, and observe whether the
   answer contains that file's content. Content in the answer is a `verified`
   refutation of C7 and settles B2 against `no-tools`; a refusal is one
   observation, on one build and one host, and grades C7 no higher than
   `vendor-documented` until the vendor documents the mechanism.
4. The C4 canary, run the same way: an agent-owned out-of-workspace write and a
   disallowed connect, both expected to be denied.

Results are recorded in §17.4 with the build they were taken on. A canary that
was not run leaves its row where it is; an unrun check is never a pass.

### 17.9 Successor gating

Any successor Issue in this chain **MUST NOT be published stack-ready.** Each
one names its precondition — D1, D2, or both — and stops if the decision has
not been recorded here. A successor that finds a way around a blocker changes
this section first, with its evidence, and never in its own code: the failure
mode this section exists to prevent is a Codex dispute turn shipping under the
`no-tools` label because the sandbox looked close enough.

Provider runtime consolidation (#903–#914, especially #908 and #912) is where a
general capability model belongs. This section uses the narrow interfaces that
exist today — the reconsideration profile resolver, the arbiter candidate
resolver, the review-agent compatibility table — and expects to be folded into
that work rather than to grow into it.

### 17.10 The invocation adapter (issue #1068)

Issue #1068 implemented §17.7's invocation contract, for the REVIEW turn only,
and connected it to nothing. `handlers/codex-structured-review.ts` builds the
argv, delivers the runner-authored prompt on stdin, runs the CLI under the shared
isolation boundary, separates the three streams, and returns one envelope
admitted by the ordinary §2.1 parser or one typed failure;
`core/review-findings-schema.ts` derives the JSON Schema for that envelope from
the domain constants rather than restating them.

**What #1068 did not change, and was the point of that slice.** No handler
called it, no session configuration could select it, `codex` stayed in
`STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS`, `codex review` ran byte for byte as
before, and no counter, transition, default or loop cap moved. D1 was therefore
still unrecorded at the end of #1068: what existed was the mechanism D1 would
switch on, not the switch. **§17.11 is the switch**, and the rest of this
subsection describes the adapter both sections share.

**One row of §17.7 does not transfer, and it is named here rather than quietly
departed from.** §17.7 describes a DISPUTE turn, whose §8.2 posture makes the
bundle the entire input, so its cwd row pins "a throwaway `mkdtemp` directory,
not the worktree and not a checkout". A review is the opposite case by
definition: reading the branch under review is the work, so the adapter's cwd is
the checkout and the boundary around it is the sandbox rather than the absence of
a checkout. Nothing else moves with it — `--skip-git-repo-check` stays pinned
because it disables a refusal to START, never a boundary; the environment,
artifact, timeout, cancellation, model and effort rows apply unchanged; and the
`read-bounded` label is §17.7's name for this posture, not an exercise of D2,
which is about admitting that posture for a §8.2 turn and remains unrecorded.

Five properties are worth stating because a later reader will otherwise have to
re-derive them from the code:

1. **The posture is `read-bounded`, never `no-tools`.** A review reads the
   checkout by design, so §8.2's "the bundle is the entire input" is not the
   claim being made and §17.5's refusal of the `no-tools` literal is honored
   rather than worked around. The profile records `read-bounded`; the isolation
   layer is told `tool-capable`, which is the conservative translation — only an
   Anthropic `no-tools` turn inherits the operator's real home, and this one gets
   a throwaway one with `CODEX_HOME` pointed at the real `~/.codex` so the CLI's
   own login is reachable and nothing else is.
2. **The final message is the review.** `--json` puts progress on stdout and
   `--output-last-message` puts the response in a runner-owned file, so the
   verdict is never recovered by scraping a stream that also carries progress.
   Missing, blank, oversized, stale or unadmissible output is a typed failure,
   never a review that found nothing.
3. **The schema is assistance.** Admission is the ordinary envelope parser on
   every path, whether the flag was passed, honored, ignored, or refused. A build
   that REFUSES a pinned flag is reported as `unsupported-capability`, which is a
   capability to grade in §17.4 rather than an incident to investigate.
4. **No bypass flag exists to be set.** There is no switch on the adapter that
   produces `--dangerously-bypass-approvals-and-sandbox`, `--full-auto`, or a
   metered API path, and its tests assert the absence.
5. **No version gate is pinned, because §17.3 still records no tested build.**
   The declarative `codex --version` gate §17.3 requires is owed by the successor
   that ROUTES a review here, and is not owed by an adapter nothing can reach.
   That successor's precondition is D1; this section is unchanged on that point.
   §17.11 records how that obligation was discharged, and it was not by inventing
   a range.

### 17.11 The routed lane, and decision D1 as taken (issue #1069)

**D1 is recorded here, as §17.6 requires.** Issue #1069 is the operator's
instruction to route it, in the shape §17.6 states and no wider: for sessions
with `reviewDispute.enabled: true` only, a Codex review resolves through §17.7's
`codex exec` invocation with a runner-authored prompt carrying the §2.1 envelope
instruction, instead of through `codex review`. What the operator accepted with
it is the product decision §17.6 names — for an enabled session, the vendor's own
diff-review pipeline is no longer what produces the report; a runner-authored
prompt is.

Every bound §17.6 attached to the proposal holds in the implementation:

- **A disabled session is byte-identical.** The gate is
  `reviewDispute.enabled && agentId === "codex"`, read at the same point §13's
  compatibility gate is read. With the protocol off, nothing below runs and the
  review is `codex review --base … --title …` exactly as before.
- **No loop cap moved, no second flag was introduced, and no default changed.**
  The lane is selected by the flag that already exists; there is no
  session key for it, and no session that was passing reviews is auto-enabled.
- **`STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS` is unchanged, deliberately.** That
  table answers for the `codex review` COMMAND — C9's structural absence of a
  seam — and the routed lane does not run that command and never consults the
  table. Removing `codex` from it would route nothing; it would only start asking
  `codex review` for an envelope it still cannot emit.

**What the reviewer is given.** `codex exec` has no `--base`, so the review base
is this runner's to supply and the diff is prompt text rather than something the
CLI resolves. The lane therefore reuses the review brief every prompt-driven
reviewer already gets — Issue requirements, predecessor context, the §5 verification
results including a failed or not-run required command, the changed-file and
guardrail classification, the stacked `reviewBase...HEAD` diff of issue #667, and the
§2.2 live lineage ids — and the adapter appends the same
`reviewFindingsInstructions` text every structured reviewer reads. The brief is
built once, by one builder, so the Codex reviewer and the Claude reviewer are
answering the same question.

**What the lane may not certify.** Three refusals, all in the same direction:

1. **A diff that could not be captured fails the run.** No review is attempted on
   a `git diff` that exited nonzero.
2. **A truncated diff cannot pass cleanly.** The prompt carries a size ceiling;
   a diff past it is cut, and a `success` verdict over a cut diff is escalated to
   a human instead of promoted, because `codex exec` saw only what the prompt
   contained. `needs_fix` and `conflict` are unaffected — only a clean pass is
   unsafe on a partial view. This is the rule the Gemini lane has always applied,
   for the same reason.
3. **A response without an admissible envelope cannot pass cleanly.** The lane
   ASKED for one, so its absence is not §13's compatibility case. §13 still reads
   the prose the reviewer did write, and a `success` is downgraded to a human
   handoff — the identical direction §12 takes for a malformed Claude envelope.

**Invocation failures are incidents, not verdicts.** An unsupported agent, a
configuration that will not resolve, a CLI that refused a pinned flag, a run that
hit the deadline, a missing, stale, oversized or blank final message: each is
reported as the typed §17.10 failure it is, fails the phase, and spends no
protocol counter and moves no lineage (§17.7's cancellation row). Quota
exhaustion is recognized from the CLI's own stderr and delays the retry, exactly
as on the native lane.

**Admission is the ordinary one.** The envelope the adapter validated enters the
SAME admission path a Claude review's does — one shared entry point below the
parse — so lineage ids, versions, §2.2 attachment to an open lineage, evidence
resolution against the reviewed checkout, the carried-forward prior block, the
§10.1 persisted block, the §10.2 records artifact, the outbox publication and the
implementation disposition prompt are all unchanged and unduplicated. §17.11
routes a reviewer; it does not add a second protocol.

**The §17.3 version gate is still not pinned, and this is how that was
discharged.** §17.3 says a successor that lands a Codex turn must pin the build
it was tested against. No build has been tested — that fact has not changed —
and pinning a range on an untested build would be the invented attestation §17.2
exists to prevent. So the obligation is met the only honest way available: the
lane fails CLOSED on every signal that the build in front of it does not do what
this contract assumes. A refused flag is `unsupported-capability` rather than a
review; a final message that never appeared is `missing-output` rather than a
review that found nothing; an unadmissible response cannot certify a pass. A
version gate would refuse a known-bad build up front; these refusals catch an
unknown one at the point it misbehaves. Pinning the declarative gate remains
owed, and its input is §17.8's smoke check — still an operator procedure, still
never a CI test.

**D2 is untouched.** The reviewer's reconsideration and the arbitration turn
still refuse a non-Claude agent: their blocker is B2, which is about §8.2's input
boundary, and nothing here answers it. An enabled Claude/Codex session can now
open a Codex-raised lineage and route it through the fix loop; a DISPUTE on that
lineage still reaches §8.3 with no selectable arbiter and escalates to a human,
as it did before.

### 17.12 The reconsideration turn stops for D2 (issue #1070)

Issue #1070 is the next successor in this chain and it asked for the turn D2
gates: let the ORIGINAL Codex reviewer run the existing bounded §4.1
reconsideration sub-turn, under this contract's execution boundary. It carried
its own stop condition, in its own words — enforce the accepted tool/evidence
boundary with actual CLI configuration and isolation, read-only alone is not
no-tools, do not enable support by deleting a guard or substituting a prompt
instruction, and **if the predecessor recorded an unresolved boundary decision,
stop for that decision rather than invent a weaker policy.**

**The decision is unresolved, so this milestone stopped.** D2 is a proposal in
§17.6 and nothing has recorded it; C7 is still `unknown` in §17.4 and §17.8's
canary has still not been run. No Codex reconsideration was implemented, no
posture literal was added, and no guard was relaxed. What #1070 changed is the
quality of the refusal, not its direction — see "What this milestone did land"
below.

**Why D1 does not carry this turn.** The two turns fail different tests, and
that is the whole of it:

| | Review (D1, §17.11) | Reconsideration (D2, blocked) |
| --- | --- | --- |
| The blocker | B1 — `codex review` composes its own report, so there is no seam for the §2.1 output contract (C9) | B2 — §8.2 requires the runner to remove the tool surface, and no Codex mechanism for that is on record (C7 `unknown`) |
| What D1 supplied | a different subcommand, `codex exec`, whose prompt the runner writes (C1, `verified`) | nothing: `codex exec` is the same command either way, and the command was never the blocker |
| Reads by the agent | the point of the turn — the checkout IS the input (§17.10) | excluded by §8.2 — "the bundle is the entire input" |
| Posture recorded | `read-bounded`, honestly, for a turn that makes no §8.2 claim | would have to be `read-bounded` for a turn whose premise is the §8.2 claim — which is D2, not a consequence of D1 |

So "Codex already runs a structured turn in this repository" is true and is not
evidence for this one. §17.10 said the same thing in advance: the review lane's
`read-bounded` label "is §17.7's name for this posture, not an exercise of D2,
which is about admitting that posture for a §8.2 turn and remains unrecorded".

**Three shortcuts were available and each is refused, with its reason.** They are
written out because they are what a successor under schedule pressure reaches
for, and each one ships a weaker protocol while leaving every test green:

1. **Reuse the `no-tools` literal over `codex exec --sandbox read-only`,
   `--skip-git-repo-check`, `--ignore-user-config` and a throwaway cwd.** That is
   a real boundary and a weaker one — reads are not in it — and §17.5 refuses the
   label for a dispute turn by name, including via the refinement lane's
   precedent. A lineage upheld under a mislabeled posture is indistinguishable
   afterwards from one upheld under §8.2, which is the specific harm §17.6's D2
   row about the §10.3 audit exists to prevent.
2. **Add the boundary to the prompt** — instruct the model not to read anything
   outside the bundle. §17.5's first refused inference: a prompt is not an
   enforcement point, and §8.2 is a runner obligation precisely so that it does
   not rest on the model's compliance.
3. **Delete the resolver's agent check** and let the isolation layer be the
   boundary. The isolation layer bounds the *environment* — credentials, home,
   config dir, cwd — and has never claimed to bound the tool surface; removing
   the check would not enforce anything, it would only stop reporting that
   nothing enforces it.

**What this milestone did land.** The refusal that was already correct is now a
recorded capability decision rather than an inline agent-id comparison:
`reconsiderationAgentSupport` in `handlers/review-reconsideration.ts` answers for
one agent id, names B2 as the blocker and D2 as the pending decision, and states
in its own error text that read-only sandboxing is not the boundary being asked
for. `resolveReconsiderationProfile` reads its answer from there, so the resolver
and this section cannot drift apart, and the two events that would legitimately
change it — D2 recorded, or C7 graded `verified` — are written where the change
would be made. Tests pin the refusal as an operational fact, not as a string: a
configured Codex reviewer's reconsideration spawns no process, reads no checkout,
writes no artifact, and leaves no lineage, counter or routing state moved.

**What an operator or a successor needs, in order.** Nothing below is a code
change until the step above it is done:

1. Run §17.8 on a real host and a real build — the C7 canary above all, since it
   is the one that decides anything — and record the result in §17.4 with the
   build it was taken on. An unrun check is never a pass.
2. If C7 grades `verified`, there is a genuine no-tools invocation to record and
   **D2 is not needed**: add the agent to the reconsideration capability table
   with that argv, pin the declarative `codex --version` gate §17.3 requires, and
   the posture stays `no-tools` honestly.
3. If C7 does not grade up, the only remaining route is D2, and it is an
   operator's to record against §17.6 — the `read-bounded` literal, an explicit
   session opt-in, and the §10.3 audit and operator surfaces extended so a
   lineage decided under it is distinguishable forever from one decided under
   `no-tools`. §17.6's table is what the operator is accepting: writes and
   network contained, **reads available, and "the bundle is the entire input" not
   guaranteed.**
4. Only then does the invocation get built, to §17.7's rows — which #1070 left
   untouched precisely so that the approval is still given against the exact
   shape §17.6 describes.

**Steps 3 and 4 have since been taken, in that order, and step 1 has not.**
§17.16 is the record: the operator recorded D2 against §17.6 on 2026-09-07 and
issue #1085 built the invocation to §17.7's rows. §17.8's canary has still not
been run and C7 is still `unknown` — which is exactly why the posture that
shipped is `read-bounded` and not `no-tools`. Everything §17.12 says above about
a session that has NOT opted in is still literally true of one, including every
line of "what this milestone did land": the refusal, its wording, and the tests
that pin it as an operational fact are unchanged for that session.

**What happens to a dispute in the meantime, and why that is not a defect.**
Exactly what happened before: a Claude/Codex session opens Codex-raised lineages
and runs the fix loop, and a lineage the implementer disputes reaches §8.3 with
no selectable arbiter and escalates to a human under §9. #1070's own scope
allowed for that outcome in as many words — "this milestone may hand unresolved
disputes to a human". The protocol is bounded and auditable in that state; it is
not stalled and it is not silently degraded.

**What did not move.** No default, no cap, no counter, no transition, no
schema, no session key, no operational session setting, and no global agent
runtime profile. `codex review` is byte-identical for a disabled session, the
§17.11 review lane is unchanged, the arbitration turn is untouched (it is a
separate turn and was never in this milestone's scope), and
`STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS` still contains `codex` for the reason
§17.11 gives.

### 17.13 The round trip up to that turn (issue #1071)

Issue #1071 asked for the whole loop rather than the turn: make the ordinary
Claude implementation → Codex structured review → Claude rebuttal → **original**
Codex reconsideration flow continue correctly across real task phase boundaries.
Three of those four hops are D1's and were already routed (§17.11); the fourth is
D2's, and D2 is still unrecorded. **So the round trip stops where §17.12 says it
stops, and this milestone did not implement a Codex dispute turn, did not add a
posture literal, and did not relax a guard.** §17.12's ordered successor path is
unchanged and is still the only way past it.

What the round trip DOES do in that state is now pinned as behavior rather than
inferred from the refusal: an enabled Claude/Codex session raises a Codex finding
through §17.11's lane, the fix run records a §3.4 zero-change rebuttal and moves
the lineage to `disputed`, and the next review run selects §7.1's reviewer turn
and parks it. At the park the debate state is byte-identical, no counter is
spent, no §7 row is written, no agent is spawned by either the review lane or the
turn, and an operator `recover` re-parks rather than consuming the rebuttal a
second time or re-opening the answered version. An unrelated blocking finding
fixed in the same run keeps its terminal state and does not let the run report a
clean pass, and a session with the protocol switched off runs `codex review` over
the same task with the block untouched.

**The one integration fault that exercise uncovered, and the fix.** §4.1's
reconsideration belongs to the reviewer whose finding is being disputed, and a
whole implementation phase runs between the two. The review phase was handing the
turn `cmdSpec.resolvedProfile.agentId` — the reviewer the CURRENT run resolves —
while the arbitration turn has read the recorded party since issue #955 and the
evidence turns since #962, both for the reason review-dispute-parties.ts states:
a task whose lane was reconfigured after the debate started would otherwise ask
an agent to answer for prose it never wrote. The reviewer's own turn was the last
§7.1 turn still resolving its party from the live lane, and it now reads
`reviewDisputeParties.review` first, falling back to this run's resolved profile
only for a debate that predates the key.

It cuts both ways, which is why it is a correctness fix and not a policy change:

| The debate was raised by | The lane now resolves | Before | After |
| --- | --- | --- | --- |
| `claude` | `codex` | refused as `profile_unavailable` — a turn Claude could have taken was parked | dispatched to `claude`, and the round trip completes |
| `codex` | `claude` | dispatched to `claude`: a §8.2 turn answered by an agent that was not party to the debate | refused as `profile_unavailable` — the D2 stop, for the right reason |

The second row is the one that mattered: it is the failure mode §17.9 exists to
prevent, reached without touching a capability table — a Codex-raised lineage
withdrawn, upheld or revised by a *different* provider, recorded in the §10.3
audit as an ordinary reconsideration, and indistinguishable afterwards from one
the original reviewer took. Nothing about the identity is trusted on the way in:
the persisted party is canonicalized to an agent id this runner recognizes and
nothing else (§8.3's rule, unchanged), so a forged record can only name an agent
whose invocation is resolved on its own merits, and an unrecognized one falls
back exactly as a pre-#955 debate does.

**What did not move.** No default, no cap, no counter, no transition, no schema,
no session key, and no capability table: `RECONSIDERATION_SUPPORTED_AGENTS` still
holds `claude` alone, the arbiter candidate resolver still refuses `codex`,
`STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS` still contains it, the §17.11 review lane
is untouched, and a disabled session runs `codex review` byte for byte. D2 was
still a proposal in §17.6 when this milestone ended, and C7 is still `unknown` in
§17.4. (D2 has since been recorded — §17.16. The identity fix above is what makes
that turn reach the ORIGINAL reviewer rather than the current lane, so the two
milestones compose exactly as written: #1071 decided *who* answers, #1085 decided
*whether this runner can invoke them*.)

### 17.14 The same path with nothing seamed at the boundary (issue #1072)

Issue #1072 asked for the qualification the two milestones above could not give:
prove the loop through **production-default CLI dispatch and persistent phase
transitions**, not through mocked sub-turn results. Issues #965 and #1071 replace
each §7.1 agent invocation with an in-process seam, which proves the protocol
layers compose and proves nothing about whether the argv, the stdin prompt, the
isolated environment, the temp-file handshake and the two-stream capture the
shipping invocation performs ever reach a process.

**What this milestone landed is a test, and no behavior change.** No default, cap,
counter, transition, schema, session key, capability table, argv or posture
literal moved; `git diff` over `src/` for it is empty. The suite is
`test/review-dispute-default-path-e2e.test.js`, and its ground rule is that the
review handler is built with **no** `ReviewDisputeSubTurnSeams` at all: the
§17.11 lane resolves its own `codex exec` invocation, the §4.1 reconsideration
resolves its own no-tools `claude` invocation and builds its own isolated
environment, and the §8.3 arbiter is resolved by the shipping candidate resolver.
Fake `claude` and `codex` executables are installed on `PATH` under the real
command names and answer from a per-scenario queue, so what is faked is the model
behind the CLI and nothing between it and the handler. The repository is a
disposable checkout with real base and issue commits, and the tracked index and
diff the substrate returns are git's own output for it, so every §3.3 resolution
reads real files. `git` and `gh` remain deterministic in-process answers: they are
the substrate this milestone did not integrate, and pinning them keeps a failure
attributable to the dispatch it did.

**What that turns from inference into a pinned fact.** The §17.11 lane really is
spawned as `codex exec` with the §17.7 flags, the checkout as cwd, a throwaway
home and no GitHub credential, and its final message really does arrive through
`--output-last-message`. The §4.1 turn really is spawned with the `--tools ""` /
`--allowedTools ""` / `--disallowedTools` / `--strict-mcp-config` / `--safe-mode`
/ `--no-session-persistence` argv, from a throwaway cwd that is not the worktree,
with the bundle — finding, rebuttal and Issue contract — on stdin. The §10.2
record and raw transcript are written from a real process's bytes, the §11 comment
is a real outbox row carrying the outcome literal and none of the prose, and the
§3.4 zero-change rebuttal is confirmed against the real checkout with `git
status` rather than against a stub's claim about it.

**It stops in the same place, for the same reason.** A Codex reconsideration is
still refused: the Codex-reviewed round trip runs through real CLI dispatch up to
that turn and then produces one bounded handoff — no process spawned, no counter
spent, no §7 row written, a byte-identical block, and a `recover` that re-parks.
Nothing here records D2, grades C7, adds a posture literal or relaxes a guard, and
§17.12's ordered successor path is still the only way past it.

**So the round-trip legs D2 gates are exercised on the lane that has a §8.2
invocation, and that limit is the point rather than a workaround.** The
withdrawal, the material revision and the upheld-with-no-eligible-arbiter
escalation are driven with `claude` as the **reviewer of record** — the same
protocol, the same turns, the same production dispatch, the same records — because
`claude` is the one agent this runner can invoke without a tool surface. What
those cases qualify is the protocol and its dispatch; they are not a claim that a
Codex reviewer can withdraw a finding today, and §17.9's gating is unchanged by
them.

**Two bounds the suite states rather than papers over.** A cancelled reviewer is
exercised as a process killed by signal, not by waiting out the ten-minute
deadline — the deadline's own classification is pinned by issue #953's suite,
and a test that slept for it would buy nothing. And a stale head is exercised as
the rebuttal's evidence no longer resolving in the checkout, which is where the
turn fails closed before an agent is spawned; a moved PR head that still resolves
is an ordinary re-review, not a dispute condition.

### 17.15 The operator diagnostic reads the same capability answer (issue #1073)

Issue #1073 asked a documentation-and-diagnostics question rather than a
capability one: can an operator tell, from `admin session-doctor` alone,
whether a configured Claude/Codex session can complete a rebuttal and a
reconsideration — separately from whether it has an independent arbiter? Before
this issue, doctor's only Codex-reconsideration signal was `reviewAgentCli`
passing, which answers D1 (§17.11) and says nothing about D2.

**What changed.** `admin session-doctor` now calls the same
`reconsiderationAgentSupport` this section already treats as the recorded
answer (§17.12) and reports it as `reviewerReconsiderationCapability`, gated
the same way the three arbiter checks are — emitted only for an enabled
session, and skipped rather than evaluated when the review role itself is
unusable. [review-dispute-operations.md](review-dispute-operations.md) §3
documents the check; §13 records the predecessor evidence (issues
#1067–#1072) behind it and states plainly that no Codex build has been run
against §17.8's canary.

**What did not change.** No default, cap, counter, transition, schema, session
key, capability table, argv or posture literal moved. `RECONSIDERATION_SUPPORTED_AGENTS`
still holds `claude` alone, D2 was still a proposal in §17.6 when this milestone
ended, C7 is still `unknown` in §17.4, and this section is still the only place
either of those facts is decided — the doctor check reads the answer, it is not a
second place that could disagree with it. (D2 has since been recorded — §17.16 —
and the check still reads the same answer from the same function, now given this
session's opt-in as well as the agent id, which is why it did not have to be
rewritten to stay true.) Independent AI arbitration by a third model is unaffected
and remains separate future work; so is the provider-runtime consolidation of
#908/#912, which this diagnostic does not activate, extend, or depend on.

### 17.16 The read-bounded reconsideration, and decision D2 as taken (issue #1085)

**D2 is recorded here, as §17.6 requires.** On 2026-09-07 the operator approved
the tradeoff §17.6's D2 row describes, in the words quoted there, for the
reviewer's §4.1 reconsideration and for no other turn. Issue #1085 is the
implementation of that decision and of nothing wider.

**What was approved, restated as the thing that shipped.** A reviewer whose CLI
this runner cannot invoke without a tool surface — today `codex`, because C7 is
`unknown` and §17.2 reads unknown as absent — may take the §4.1 reconsideration
under a second, separately named posture, `read-bounded`, admitted only by an
explicit session opt-in that is off by default. What that posture guarantees and
what it does not is §17.6's table, unchanged, and the third row is the one an
operator accepted: **reads by the agent are available**, bounded only by a
throwaway cwd and the host's own read permissions. A temporary cwd is not a read
jail, and "the bundle is the entire input" is **not** guaranteed for a lineage
decided under it. That sentence is repeated at the resolver, at the session
schema, at the operator diagnostic and in the operations document, because a
limitation stated once at approval time and nowhere afterwards is how the weaker
posture would quietly become the assumed one.

**The opt-in.** `session.reviewDispute.reconsideration.readBounded`, a boolean
defaulting to `false`, validated at session load like every other value in that
block — a non-boolean is refused rather than coerced, and an unknown key under
`reconsideration` is refused as it is everywhere else in this config. It is a
second switch and not a widening of `enabled`: turning the protocol on never
turns this on with it. With it absent or false, every behavior §17.12 describes
holds byte for byte, refusal wording included.

**Where the posture is enforced.** The invocation is §17.7's rows, and the
reconsideration lane implements them rather than restating them — it imports the
`codex exec` flag list the §17.11 review lane already pins, so one contract cannot
be pinned two ways:

| Row | How this lane honors it |
| --- | --- |
| Subcommand | `codex exec`, never `codex review`. |
| Prompt delivery | stdin, no prompt argument — the same runner-authored §4.1 bundle the Claude lane is given, byte for byte. The bundle, its evidence resolution and its per-run nonce fence are unchanged. |
| Argv (sanitized) | `codex [--model <m>] exec --sandbox read-only --skip-git-repo-check --ignore-user-config --json -c model_reasoning_effort=<low\|medium\|high>`, with `--output-last-message <path>` spliced in at invocation time. No `--output-schema`: a §4.1 record is not the §2.1 envelope that flag's schema describes, and C6 is `vendor-documented` regardless. No bypass flag exists to be set. |
| Tool policy recorded | `read-bounded`. Never `no-tools`, at any layer. |
| cwd | A throwaway `mkdtemp` directory, not the worktree and not a checkout — which is why `--skip-git-repo-check` is required rather than incidental. |
| Environment | The shared isolated environment, told `tool-capable` so the operator's real `HOME` is not inherited; `CODEX_HOME` synthesized at the real `~/.codex` so the CLI's own login is reachable, which is why `--ignore-user-config` (C5) is load-bearing; every write-enabling token stripped and `GH_CONFIG_DIR` pinned at an empty temp dir. |
| Response format | One fenced JSON code block holding one object — the same record the Claude turn returns, admitted by the same §12 parser. It is read from the `--output-last-message` file and from nowhere else: `--json` puts progress on stdout, and a verdict recovered by scraping a progress stream is not a verdict this contract admits. |
| Artifacts | The same §10.2 files the Claude lane writes, plus `reconsideration-events-<lineageId>.jsonl` for the progress stream — which is agent output but is never the answer, so it is neither passed off as the transcript nor discarded. |
| Timeout | The runner's ten minutes, unchanged, and ENFORCED: the child runs in its own process group, so a CLI that traps the deadline's `SIGTERM` is force-killed with its whole tree. |
| Cancellation | The deadline is the only cancellation and it is the runner's. An invocation failure spends **no** counter and moves no lineage. |
| Model | `CODEX_MODEL`, then `session.codex.model`, then unset — and **unset stays absent**, recorded as `cli-default`. |
| Effort | `CODEX_EFFORT`, defaulting to `high`; `xhigh` and `max` map to `high` (C3). |

**What a failure of this lane is, and is not.** Each is a typed operational
outcome that parks the turn with the debate untouched, never a reviewer's
decision: a build that refused a pinned flag (`unsupported-capability`, reported
as `profile_unavailable` — a capability to grade in §17.4, not an incident to
investigate); a run that wrote no final message where its argv said to
(`missing-output`); one whose output file predates the run (`stale-output`); one
past the read bound (`oversized-output`); a blank answer (`empty-output`); an
unadmissible one (`malformed-response`); and a deadline, which is still reported
distinctly from a run that exited nonzero. **No version gate is pinned**, because
§17.3 still records no tested build and inventing a range would be the attestation
§17.2 exists to prevent — so this lane discharges that obligation the same way
§17.11 does, by failing closed on every signal that the build in front of it does
not do what this contract assumes.

**How a lineage decided under it stays distinguishable, forever.** The posture is
carried, verbatim and never defaulted, through six places: the resolved profile;
the §10.2 `reconsideration-<lineageId>.json` record's own `profile` block; the
bounded run summary in task context, which is what `admin dispute status` projects
as `lastReconsideration`; the PER-LINEAGE reviewer record
(`reviewDisputeReconsiderations`), projected as `reconsiderationsByLineage` and
printed beside the lineage itself; the §10.3 `review.dispute.subturn` event, which
names the posture next to the lineage ids that run decided — including on a park,
where "the run that could not answer was the read-bounded one" is the fact an
operator needs; and `admin session-doctor`'s
`reviewerReconsiderationCapability`, which now reports WHICH posture a configured
reviewer would take rather than only whether it may take one. A record that does
not state a posture is reported as `(unrecorded)` and never as `no-tools`:
supplying the stricter literal for a record that does not carry it is precisely
the misreading the second name exists to prevent, and it must not be reintroduced
by a default. Historical `no-tools` records read back as `no-tools`, unchanged and
unreinterpreted.

**What did not move.** The `claude` lane is untouched — same argv, same
`no-tools` literal, same home policy, and an opted-in session invokes a Claude
reviewer exactly as before. `RECONSIDERATION_SUPPORTED_AGENTS` still holds
`claude` alone, because that list answers "who has a verified §8.2 invocation" and
nothing here changed that answer; the read-bounded agents are a second, separately
named list gated on the opt-in. C7 is still `unknown` and §17.8's canary has still
not been run. The arbitration turn is untouched and the arbiter candidate resolver
still refuses `codex` (`unsupported-role`), so an upheld dispute on a Codex-raised
lineage still escalates to a human unless an eligible arbiter is configured. No
default, cap, counter, transition, §7 row, schema field or loop cap moved;
`STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS` still contains `codex`; the §17.11 review
lane is unchanged; a disabled session runs `codex review` byte for byte; and no
operational session was enabled, which the approval explicitly excluded. The
provider runtime consolidation of #903–#914 remains separate future work and is
neither implemented nor depended on here.
