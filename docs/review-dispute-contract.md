# Review Dispute, Reconsideration, and Arbitration Contract

Status: approved design (issue #835). This document is the authoritative
contract for the review-dispute protocol. Follow-up implementation Issues
reference this specification and MUST NOT redefine its policy; a change of
policy is a change to this document first.

No production review or fix behavior changed in #835 itself — #835 shipped
the contract, not the protocol. It is gated behind
`session.reviewDispute.enabled`, which defaults to `false`; a session that
does not opt in behaves exactly as today.

**Implementation status (issue #849).** The protocol described here is now
implemented across issues #836–#849 and ships default-off behind that same
flag. See [feature-status.md](feature-status.md#review-dispute) for the
operator-facing availability summary. This document remains the policy
authority; how to enable it, read it, and turn it off again is
[review-dispute-operations.md](review-dispute-operations.md), which adds no
policy of its own. Two turns of §7.1 still have no dispatcher — see §15/G2.

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
  them, never a hard error.
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
task-level handoff for a §7.1 turn the runner cannot dispatch leaves the
lineage untouched by design, which is correct, but it also means an operator
has nothing to act on: requeuing the task into review would hand an open
lineage to a run that cannot discharge it. The gap closes by implementing the
missing dispatchers, not by adding an operator transition.

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

Behavioral verification of the implemented protocol lives alongside it (issue
#849): `test/review-dispute-e2e.test.js` drives whole lifecycles through the
real phase runner, task store, outbox and admin projections on both TaskStore
implementations; `test/review-dispute-rollout.test.js` pins default-off
behavior and the audit-preserving disable/re-enable round trip; and
`test/docs-review-dispute-operations.test.js` pins the operator document. None
of them runs a paid agent, calls GitHub or Slack, touches the network, or
edits SQLite by hand.
