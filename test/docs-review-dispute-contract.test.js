/**
 * Structural tests for docs/review-dispute-contract.md (issue #835).
 *
 * The document is the authoritative contract for the review dispute,
 * reconsideration, and arbitration protocol, so these tests pin the claims a
 * follow-up implementer or reviewer must not have to rediscover: the closed
 * outcome vocabularies, the lineage/version rules, the deterministic
 * material-revision rules, the bounded-debate constants, every transition-table
 * row, the arbiter restrictions and selection policy, the human-escalation
 * split, the fail-closed rules, and the legacy `reviewFeedback` compatibility
 * path.
 *
 * They are structural only — no runtime behavior is asserted here, because
 * issue #835 intentionally changes no production review or fix behavior.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the documents are
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document says,
// not how it happens to be wrapped.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const RAW = readFileSync(resolve(ROOT, 'docs/review-dispute-contract.md'), 'utf8');
const doc = RAW.replace(/\s+/g, ' ');
const phaseContracts = read('docs/phase-contracts.md');

// ---------------------------------------------------------------------------
// Authority and scope
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — authority and scope', () => {
  test('is marked as an approved design, with implementation status recorded separately', () => {
    expect(doc).toMatch(/approved design \(issue #835\)/);
    expect(doc).toMatch(
      /No production review or fix behavior changed in #835 itself — #835 shipped\s+the contract, not the protocol\./,
    );
  });

  test('is the authoritative contract that follow-up issues must not redefine', () => {
    expect(doc).toMatch(/authoritative contract/);
    expect(doc).toMatch(/MUST NOT redefine its policy/);
    expect(doc).toMatch(/a change of policy is a change to this document first/);
  });

  test('is gated behind a session flag that defaults to false', () => {
    expect(doc).toMatch(/`session\.reviewDispute\.enabled`, which defaults to `false`/);
    expect(doc).toMatch(/behaves exactly as today/);
  });

  test('states the problem it removes: no-change responses fail today', () => {
    expect(doc).toMatch(/A no-change response is not a dispute today/);
    expect(doc).toMatch(/exited 0 but produced no file changes/);
  });

  test('records the copybara export decision for this document', () => {
    expect(doc).toMatch(/\*\*publicly exportable\*\*, not private-only/);
    expect(doc).toMatch(/copybara\/copy\.bara\.sky/);
  });
});

// ---------------------------------------------------------------------------
// Canonical vocabulary — exactly the tokens from the issue, nothing else
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — outcome vocabulary', () => {
  test('defines exactly three implementation dispositions', () => {
    expect(doc).toMatch(/\*\*Implementation dispositions\*\*[\s\S]{0,120}?Exactly three:/);
    for (const token of ['`fixed`', '`review_disputed`', '`blocked`']) {
      expect(doc).toContain(token);
    }
  });

  test('defines exactly three reviewer reconsiderations', () => {
    expect(doc).toMatch(/\*\*Reviewer reconsiderations\*\*[\s\S]{0,120}?Exactly three:/);
    for (const token of ['`withdraw`', '`uphold`', '`revise`']) {
      expect(doc).toContain(token);
    }
  });

  test('defines exactly four arbiter verdicts', () => {
    expect(doc).toMatch(/\*\*Arbiter verdicts\*\* — exactly four:/);
    for (const token of [
      '`reviewer_correct`', '`implementer_correct`',
      '`spec_ambiguous`', '`insufficient_evidence`',
    ]) {
      expect(doc).toContain(token);
    }
  });

  test('defines the full lineage-state vocabulary', () => {
    for (const state of [
      '`open`', '`disputed`', '`arbitration_pending`', '`evidence_requested`',
      '`binding`', '`resolved_fixed`', '`resolved_withdrawn`',
      '`resolved_overruled`', '`escalated_human`',
    ]) {
      expect(doc).toContain(state);
    }
  });

  test('states terminal states are immutable and never reopened by automation', () => {
    expect(doc).toMatch(/Terminal states are immutable audit records/);
    expect(doc).toMatch(/Automation never reopens a lineage in a terminal state/);
  });
});

// ---------------------------------------------------------------------------
// Finding schema and lineage/version rules
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — finding schema and lineage rules', () => {
  test('requires the structured finding fields from the issue contract', () => {
    for (const field of [
      '`lineageId`', '`version`', '`severity`', '`violatedContract`',
      '`preconditions`', '`failureScenario`', '`affectedBoundary`',
      '`requiredOutcome`', '`humanGate`', '`evidenceRefs`', '`reviewerMeta`',
    ]) {
      expect(doc).toContain(field);
    }
  });

  test('reviewers emit candidate findings; the runner populates its own fields before validation', () => {
    expect(doc).toMatch(/`lineageId`, `humanGate`, and `reviewerMeta` — are \*\*runner-owned\*\*/);
    expect(doc).toMatch(/What a review run emits is a \*\*candidate finding\*\*/);
    expect(doc).toMatch(/augments every candidate at admission, before schema validation/);
    expect(doc).toMatch(/a first finding is never malformed for lacking a runner-owned field/);
    expect(doc).toMatch(/The successor record inside a `revise` \(§4\.2\) is a candidate finding under the same rules/);
  });

  test('the runner mints lineage IDs; agents only echo them', () => {
    expect(doc).toMatch(/The \*\*runner mints\*\* `lineageId`/);
    expect(doc).toMatch(/Agents never mint lineage IDs; they only echo them/);
  });

  test('versions are immutable and only revise creates a successor', () => {
    expect(doc).toMatch(/A version is immutable once recorded/);
    expect(doc).toMatch(/the only way to change any field is a `revise` that creates a successor version naming its predecessor and its changed fields/);
  });

  test('caps a lineage at two versions and explains why version 2 is final', () => {
    expect(doc).toMatch(/`MAX_VERSIONS_PER_LINEAGE = 2`/);
    expect(doc).toMatch(/Version 2 is always the final version/);
    expect(doc).toMatch(/version 2's dispute goes directly to arbitration/);
  });

  test('affectedBoundary is repository-relative, normalized and fail-closed at admission', () => {
    expect(doc).toMatch(/`affectedBoundary` \| The file\/module\/API surface the finding is about, named repository-relative/);
    expect(doc).toMatch(/normalizes an absolute path under the execution root to its repository-relative form at admission, before schema validation/);
    expect(doc).toMatch(/an `affectedBoundary` that names a location outside the repository after the admission normalization of §2\.1/);
  });

  test('duplicate findings attach to the live lineage instead of forking a new one', () => {
    expect(doc).toMatch(/structurally duplicates a live lineage is attached to that lineage by the runner/);
    expect(doc).toMatch(/structurally duplicates a \*\*terminal\*\* lineage is not re-admitted/);
  });
});

// ---------------------------------------------------------------------------
// Dispute schema and evidence admission
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — dispute schema', () => {
  test('closes the rebuttal-reason enum', () => {
    expect(doc).toMatch(/`false_premise`, `contradicts_issue_contract`, `already_covered`, `would_reduce_correctness`, `out_of_scope`/);
  });

  test('requires evidence — an unsupported assertion is not a dispute', () => {
    expect(doc).toMatch(/REQUIRED — an unsupported assertion is not a dispute/);
    expect(doc).toMatch(/mere refusal, unsupported assertions, prose objections outside the structured block, and disputes with unresolvable evidence are all malformed/);
  });

  test('resolves evidence read-only under the repository evidence posture', () => {
    expect(doc).toMatch(/resolution follows the same admission posture as the repository evidence contract/);
    expect(doc).toMatch(/research-evidence-contract\.md/);
    expect(doc).toMatch(/bounded, tracked-file scope, no symlinks, no network, nothing executed/);
  });

  test('only an admitted dispute consumes the single rebuttal slot', () => {
    expect(doc).toMatch(/Only an \*\*admitted\*\* dispute consumes the version's single rebuttal slot/);
    expect(doc).toMatch(/`MAX_REBUTTALS_PER_VERSION = 1`/);
  });

  test('a fully resolved dispute run may complete with zero file changes', () => {
    expect(doc).toMatch(/\*\*valid run with zero file changes\*\*, provided the admitting review was fully structured/);
    expect(doc).toMatch(/MUST NOT fail such a run with "produced no file changes"/);
    expect(doc).toMatch(/lets a valid evidence-backed dispute complete without edits/);
  });

  test('a fixed disposition without a diff is rejected before any state transition', () => {
    expect(doc).toMatch(/A `fixed` disposition requires a diff/);
    expect(doc).toMatch(/every `fixed` disposition is malformed \(§12\) and is rejected \*\*before\*\* any state transition/);
    expect(doc).toMatch(/A no-op `fixed` claim therefore can never reach `resolved_fixed` and never consumes a re-review cycle/);
  });
});

// ---------------------------------------------------------------------------
// Reconsideration and material-revision rules
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — reconsideration and materiality', () => {
  test('a revision names predecessor, changed fields, kind, and materiality claim', () => {
    for (const field of [
      '`predecessorVersion`', '`changedFields`', '`revisionKind`', '`materialityClaim`',
    ]) {
      expect(doc).toContain(field);
    }
    expect(doc).toMatch(/`narrowed_scope`, `corrected_premise`, `new_evidence`, `restated`/);
  });

  test('reconsideration can never silently mutate a finding', () => {
    expect(doc).toMatch(/The predecessor version remains on record unchanged — reconsideration can never silently mutate a finding/);
  });

  test('materiality is a runner-owned deterministic structural check', () => {
    expect(doc).toMatch(/The runner — not either agent — decides whether a revision is material/);
    expect(doc).toMatch(/The structural check is deterministic/);
    expect(doc).toMatch(/`materialityClaim` is an input to audit, never to the decision/);
  });

  test('lists the material fields from the issue contract', () => {
    expect(doc).toMatch(/A revision is \*\*material\*\* only when at least one of these fields actually changed/);
    expect(doc).toMatch(/- `violatedContract` - `preconditions` - `failureScenario` - `affectedBoundary` - `requiredOutcome`/);
    expect(doc).toMatch(/executable evidence invalidates a prior premise/);
  });

  test('lists the never-material changes from the issue contract', () => {
    expect(doc).toMatch(/\*\*Never material\*\*: wording-only edits, line-number movement within the same `affectedBoundary`, added examples, severity-only changes, and restating the same `failureScenario` in different words/);
  });

  test('ambiguous revisions go to arbitration, never to another rebuttal', () => {
    expect(doc).toMatch(/\*\*Ambiguity goes to arbitration, not to another rebuttal\.\*\*/);
    expect(doc).toMatch(/An ambiguous or non-material revision never grants the implementation another rebuttal/);
  });
});

// ---------------------------------------------------------------------------
// Bounded debate
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — bounded debate', () => {
  test('pins every bounded-debate constant and value', () => {
    expect(doc).toMatch(/`MAX_REBUTTALS_PER_VERSION` \| 1/);
    expect(doc).toMatch(/`MAX_VERSIONS_PER_LINEAGE` \| 2/);
    expect(doc).toMatch(/`MAX_RECONSIDERATIONS_PER_LINEAGE` \| 1/);
    expect(doc).toMatch(/`MAX_ARBITRATION_PASSES_PER_LINEAGE` \| 2/);
    expect(doc).toMatch(/`MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE` \| 2/);
    expect(doc).toMatch(/`MAX_EVIDENCE_ROUNDS_PER_LINEAGE` \| 1/);
  });

  test('session config may only lower the limits', () => {
    expect(doc).toMatch(/Session config may only \*\*lower\*\* these limits, never raise them/);
  });

  test('defines cap-reached routing for lowered session limits', () => {
    expect(doc).toMatch(/Lowering a limit never leaves a state without a next action/);
    expect(doc).toMatch(/`MAX_REBUTTALS_PER_VERSION` MUST NOT be lowered/);
    expect(doc).toMatch(/A session configuring 0 is rejected at session load/);
    expect(doc).toMatch(/`MAX_VERSIONS_PER_LINEAGE` MUST NOT be lowered below 1/);
    expect(doc).toMatch(/`MAX_VERSIONS_PER_LINEAGE = 1`: no successor version may be created/);
    expect(doc).toMatch(/`MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE` MUST NOT be lowered below\s+1/);
    expect(doc.match(/A session\s+configuring 0 is rejected at session\s+load/g)).toHaveLength(4);
    expect(doc).toMatch(/`MAX_RECONSIDERATIONS_PER_LINEAGE = 0`: the reconsideration round is skipped/);
    expect(doc).toMatch(/\*\*available\*\* only while the evidence-round budget is unconsumed \*\*and\*\* a further arbitration pass remains/);
    expect(doc).toMatch(/fires row 26 — the successor-version-unavailable complement of row 11/);
    expect(doc).toMatch(/fires row 17's unavailable-round event to `escalated_human`/);
    expect(doc).toMatch(/row 21's cap-reached event — and escalates; row 20's below-cap retry is unreachable/);
    expect(doc).toMatch(/no lowered limit leaves a state without exactly one next action/);
  });

  test('under the lowered version cap the revise successor stays an unpersisted candidate', () => {
    expect(doc).toMatch(/the successor stays an \*\*unpersisted candidate\*\*/);
    expect(doc).toMatch(/persisted as the lineage's next version only by the row 11 transition/);
    expect(doc).toMatch(/to `arbitration_pending` with the lineage still at version 1/);
    expect(doc).toMatch(/the candidate travels to the arbiter inside the reconsideration record \(§8\.2\)/);
  });

  test('forbids a third implementation/reviewer debate round per lineage', () => {
    expect(doc).toMatch(/No finding lineage receives a third implementation\/reviewer debate round/);
  });

  test('argues boundedness and stays inside the existing review-loop cap', () => {
    expect(doc).toMatch(/cannot create an unbounded AI debate/);
    expect(doc).toMatch(/`session\.reviewLoop\.maxCycles`, default 10, `reviewLoopCapReached`/);
    expect(doc).toMatch(/the dispute protocol adds no path around that cap/);
  });

  test('reopening a terminal lineage routes to human escalation only', () => {
    expect(doc).toMatch(/`reopen_requested` flag on the lineage, which routes to \*\*human escalation only\*\* — never to a new debate round/);
  });
});

// ---------------------------------------------------------------------------
// Transition table — parsed row by row from the raw document
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — transition table', () => {
  // Numbered rows of the §7 table are single physical lines: `| <n> | ... |`.
  const rows = RAW.split('\n')
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      return { num: Number(cells[0]), state: cells[1], event: cells[2], next: cells[3] };
    });

  test('has exactly 26 numbered rows, numbered consecutively', () => {
    expect(rows).toHaveLength(26);
    expect(rows.map((r) => r.num)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
  });

  test('every row has one state, one event, and exactly one next state', () => {
    expect(doc).toMatch(/Every row names one state, one event, and exactly one next state/);
    expect(doc).toMatch(/Every state has one unambiguous next action/);
    for (const row of rows) {
      expect(row.state).toBeTruthy();
      expect(row.event).toBeTruthy();
      expect(row.next).toMatch(/^`[a-z_]+`/);
    }
  });

  test('no two rows share the same (state, event) pair — the machine is deterministic', () => {
    const keys = rows.map((r) => `${r.state} :: ${r.event}`);
    expect(new Set(keys).size).toBe(rows.length);
  });

  test('source states are only the non-terminal states', () => {
    const sources = new Set(rows.map((r) => r.state.replace(/ \(.*\)$/, '')));
    expect(sources).toEqual(new Set([
      '`open`', '`disputed`', '`arbitration_pending`', '`evidence_requested`', '`binding`',
    ]));
  });

  test('next states are only vocabulary states', () => {
    const allowed = new Set([
      '`resolved_fixed`', '`disputed`', '`escalated_human`', '`arbitration_pending`',
      '`resolved_withdrawn`', '`open` (version 2, final response)', '`binding`',
      '`resolved_overruled`', '`evidence_requested`',
    ]);
    for (const row of rows) {
      expect(allowed).toContain(row.next);
    }
  });

  test('pins the issue-mandated routing rows verbatim', () => {
    const byKey = new Map(rows.map((r) => [`${r.state} :: ${r.event}`, r.next]));
    expect(byKey.get('`disputed` :: reconsideration `withdraw`')).toBe('`resolved_withdrawn`');
    expect(byKey.get('`disputed` :: reconsideration `uphold`')).toBe('`arbitration_pending`');
    expect(byKey.get('`disputed` :: `revise`, structurally material, successor version available')).toBe('`open` (version 2, final response)');
    expect(byKey.get('`disputed` :: `revise`, structurally material, successor version unavailable (`MAX_VERSIONS_PER_LINEAGE = 1`, §6.1)')).toBe('`arbitration_pending`');
    expect(byKey.get('`disputed` :: `revise`, non-material or ambiguous')).toBe('`arbitration_pending`');
    expect(byKey.get('`open` (version 2, final response) :: admitted dispute (`review_disputed`), finding not human-gated')).toBe('`arbitration_pending`');
    expect(byKey.get('`open` (version 1) :: admitted dispute (`review_disputed`), finding not human-gated, reconsideration round available')).toBe('`disputed`');
    expect(byKey.get('`open` (version 1) :: admitted dispute (`review_disputed`), finding not human-gated, reconsideration round unavailable (`MAX_RECONSIDERATIONS_PER_LINEAGE = 0`, §6.1)')).toBe('`arbitration_pending`');
    expect(byKey.get('`open` (version 1) :: admitted dispute (`review_disputed`), finding `humanGate: true`')).toBe('`escalated_human`');
    expect(byKey.get('`open` (version 2, final response) :: admitted dispute (`review_disputed`), finding `humanGate: true`')).toBe('`escalated_human`');
    expect(byKey.get('`arbitration_pending` :: malformed arbiter output, resulting `malformedArbiterAttempts` below the session cap (0 → 1 at the default cap 2)')).toBe('`arbitration_pending`');
    expect(byKey.get('`arbitration_pending` :: malformed arbiter output, resulting `malformedArbiterAttempts` reaches the session cap (1 → 2 at the default cap 2; 0 → 1 at the lowered cap 1, §6.1)')).toBe('`escalated_human`');
    expect(byKey.get('`arbitration_pending` :: verdict `spec_ambiguous`')).toBe('`escalated_human`');
    expect(byKey.get('`arbitration_pending` :: verdict `insufficient_evidence`, evidence round available (§6.1)')).toBe('`evidence_requested`');
    expect(byKey.get('`arbitration_pending` :: verdict `insufficient_evidence`, evidence round unavailable (used, budget 0, or no arbitration pass remaining — §6.1)')).toBe('`escalated_human`');
    expect(byKey.get('`arbitration_pending` :: decisive verdict (`reviewer_correct` / `implementer_correct`), confidence < threshold')).toBe('`escalated_human`');
    expect(byKey.get('`arbitration_pending` :: no acceptable arbiter configured/available (§8.3)')).toBe('`escalated_human`');
  });

  test('rows 2 and 25 partition the version-1 dispute by reconsideration availability', () => {
    expect(doc).toMatch(/Rows 2 and 25 partition version 1's admitted, not human-gated dispute by whether the session's reconsideration budget \(§6\.1\) is available/);
    expect(doc).toMatch(/Exactly one of the two conditions holds for any session, so the machine stays deterministic/);
  });

  test('rows 11 and 26 partition the material revise by successor-version availability', () => {
    expect(doc).toMatch(/Rows 11 and 26 partition `disputed`'s structurally material `revise` by whether the session's version budget \(§6\.1\) allows a successor/);
    expect(doc).toMatch(/As with rows 2 and 25, exactly one of the two conditions holds for any session/);
  });

  test('a binding finding accepts only fixed or blocked', () => {
    const bindingRows = rows.filter((r) => r.state === '`binding`');
    expect(bindingRows.map((r) => r.event).sort()).toEqual([
      'disposition `blocked`', 'disposition `fixed`',
    ]);
    expect(doc).toMatch(/a `review_disputed` on a `binding` finding is not an event — it is malformed input/);
  });

  test('the evidence round accepts attachments only and marks itself used', () => {
    expect(doc).toMatch(/\*\*evidence attachments only\*\* — new resolvable references from either party, no new argument prose/);
    expect(doc).toMatch(/It marks the round used/);
  });

  test('a fix claim never refreshes a lineage debate budget', () => {
    expect(doc).toMatch(/A lineage's debate budget is never refreshed by a fix claim/);
  });

  test('defines the run-level aggregation precedence', () => {
    expect(doc).toMatch(/derived from lineage states by precedence, evaluated in order so exactly one outcome applies/);
    expect(doc).toMatch(/Any lineage in `escalated_human` → the task escalates to `ready_for_human`/);
    expect(doc).toMatch(/`resolvedWithoutChanges: true`/);
    expect(doc).toMatch(/proceeds exactly as a review `success`: ready for human decision/);
  });

  test('a pending fix diff survives dispute turns and still reaches re-review', () => {
    expect(doc).toMatch(/records `pendingReReview: true` in `task\.context\.reviewDispute`/);
    expect(doc).toMatch(/its ordinary re-review is deferred, never skipped/);
    expect(doc).toMatch(/or `pendingReReview` was recorded under rule 2 by an earlier run of this cycle/);
    expect(doc).toMatch(/routing there clears `pendingReReview`/);
    expect(doc).toMatch(/when `pendingReReview` is set the task still routes to review/);
    expect(doc).toMatch(/the current run produced none and `pendingReReview` is not set/);
  });
});

// ---------------------------------------------------------------------------
// Arbiter
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — AI arbiter', () => {
  test('the arbiter is read-only and cannot edit code or add findings', () => {
    expect(doc).toMatch(/\*\*read-only\*\* AI role/);
    expect(doc).toMatch(/does not edit code, runs no commands, and MUST NOT introduce unrelated findings/);
    expect(doc).toMatch(/finding-shaped content in arbiter output is ignored and logged, never admitted into the protocol/);
  });

  test('the arbiter receives a bounded runner-composed bundle', () => {
    expect(doc).toMatch(/runner-composed, bounded bundle/);
    expect(doc).toMatch(/the full finding lineage \(all versions and their records\)/);
    expect(doc).toMatch(/the Issue body \(the contract being interpreted\)/);
    expect(doc).toMatch(/diff hunks touching the finding's `affectedBoundary`, bounded/);
  });

  test('excludes transcripts, write access, commands, and network', () => {
    expect(doc).toMatch(/Explicitly excluded: full agent transcripts, the rest of the diff, repository write access, command execution, network access/);
    expect(doc).toMatch(/invoked with no tool permissions, and the bundle is the entire input/);
  });

  test('prefers a provider different from both implementer and reviewer', () => {
    expect(doc).toMatch(/provider different from \*\*both\*\* the implementer and the reviewer/);
    expect(doc).toMatch(/`context\.assignment\.implementationAgent` \(the assignment source of truth, never reconstructed from labels\)/);
    expect(doc).toMatch(/`session\.reviewDispute\.arbiter\.providers` is an ordered candidate list/);
  });

  test('fixes no vendor or model as the arbiter', () => {
    expect(doc).toMatch(/No vendor or model is fixed by this contract/);
  });

  test('same-provider arbiters require explicit opt-in and never the same model', () => {
    expect(doc).toMatch(/`session\.reviewDispute\.arbiter\.allowSameProvider` is explicitly `true`/);
    expect(doc).toMatch(/not the same model as either party/);
  });

  test('a missing arbiter fails closed to human escalation, never to a default winner', () => {
    expect(doc).toMatch(/\*\*no acceptable independent arbiter\*\* and the lineage escalates to a human/);
    expect(doc).toMatch(/absence of an arbiter never silently converts to "reviewer wins" or "implementer wins"/);
  });

  test('the confidence threshold gates decisive verdicts only', () => {
    expect(doc).toMatch(/It gates decisive verdicts \(`reviewer_correct`, `implementer_correct`\) only/);
    expect(doc).toMatch(/`spec_ambiguous` and `insufficient_evidence` route via rows 15–17 regardless of confidence/);
    expect(doc).toMatch(/so no returned verdict matches more than one row/);
  });

  test('names the confidence threshold and the malformed-arbiter rule', () => {
    expect(doc).toMatch(/`session\.reviewDispute\.arbiter\.minConfidence` \(default 0\.7\)/);
    expect(doc).toMatch(/Malformed arbiter output \(§12\) never consumes an arbitration pass/);
    expect(doc).toMatch(/records each malformed attempt in the lineage's `malformedArbiterAttempts` counter/);
    expect(doc).toMatch(/the first malformed attempt allows one retry; the second escalates to a human \(`MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE = 2`\)/);
  });

  test('malformed arbiter attempts are tracked so the two passes are distinguishable', () => {
    expect(doc).toMatch(/Malformed \*\*arbiter\*\* output is the one tracked exception/);
    expect(doc).toMatch(/never consumes an arbitration pass, the rebuttal slot, or the reconsideration/);
    expect(doc).toMatch(/Row 20 emits `dispute\.arbitration\.malformed`; row 21 emits `dispute\.escalated\.human` carrying the cap-reached `malformedArbiterAttempts` count \(`2` at the default cap\)/);
  });
});

// ---------------------------------------------------------------------------
// Human escalation
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — human escalation', () => {
  test('lists every escalation condition from the issue contract', () => {
    expect(doc).toMatch(/the arbiter returns `spec_ambiguous`/);
    expect(doc).toMatch(/confidence is below the configured threshold/);
    expect(doc).toMatch(/explicitly requires human approval for the affected behavior \(human-gated risk\)/);
    expect(doc).toMatch(/evidence remains insufficient after the single bounded evidence round/);
    expect(doc).toMatch(/no acceptable independent arbiter is configured or available/);
  });

  test('human-gated findings carry a runner-stamped field and escalate on dispute', () => {
    expect(doc).toMatch(/`humanGate` \| Runner-stamped boolean; agents never set it and a reviewer-supplied value is ignored/);
    expect(doc).toMatch(/An admitted dispute on a `humanGate: true` finding version escalates to a human/);
    expect(doc).toMatch(/automation never decides a human-gated disagreement/);
    expect(doc).toMatch(/its admitted dispute routes to `escalated_human` via §7 rows 3 and 7/);
  });

  test('the arbiter escalates after a second malformed output for the same lineage', () => {
    expect(doc).toMatch(/the arbiter's output is malformed twice for the same lineage \(§8\.3, row 21\)/);
  });

  test('review-loop-cap exhaustion is a task-level handoff, not a protocol transition', () => {
    expect(doc).toMatch(/One further path lands at `ready_for_human` without any lineage entering `escalated_human`: exhaustion of the review-loop cap/);
    expect(doc).toMatch(/the pre-existing `reviewLoopCapReached` handoff \(§6\.3\), a task-level outcome rather than a protocol transition/);
    expect(doc).toMatch(/no lineage changes state, no `dispute\.escalated\.human` audit event is emitted, and no §11 comment is posted/);
    expect(doc).toMatch(/exhaustive for the protocol's own `escalated_human` transitions; an implementer of this section must additionally honor the cap handoff/);
  });

  test('an undispatchable §7.1 turn is a task-level handoff too, and spends no protocol state', () => {
    expect(doc).toMatch(/A second task-level handoff of the same shape covers the runner that cannot take the turn §7\.1 selected/);
    expect(doc).toMatch(/the reviewer turn's reconsideration run, the evidence-collection runs, or the arbitration the runner turn advances/);
    expect(doc).toMatch(/the task lands at `ready_for_human` rather than being queued to a phase that cannot discharge the lineage, and rather than being parked non-runnable with nothing scheduled to wake it/);
    expect(doc).toMatch(/no lineage changes state, no counter is spent, and no `dispute\.escalated\.human` event is emitted/);
    expect(doc).toMatch(/A runner that does dispatch every §7\.1 turn never reaches this path/);
  });

  test('separates arbiter and human responsibilities', () => {
    expect(doc).toMatch(/the \*\*AI arbiter\*\* decides evidence-backed technical disagreements inside an unambiguous contract/);
    expect(doc).toMatch(/the \*\*human\*\* decides contract ambiguity, low-confidence outcomes, human-gated risk/);
  });
});

// ---------------------------------------------------------------------------
// Persistence, audit, and public comments
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — persistence and publication', () => {
  test('names the local artifacts', () => {
    for (const artifact of [
      'review-findings.json', 'fix-dispositions.json', 'dispute-<lineageId>.json',
      'reconsideration-<lineageId>.json', 'arbitration-<lineageId>.json',
      // Issue #838: the reviewer reconsideration's raw, unvalidated transcript,
      // written before the answer is parsed and never admitted as a record —
      // and, when the agent wrote to both streams, its stderr sibling.
      'reconsideration-raw-<lineageId>.txt',
      'reconsideration-stderr-<lineageId>.txt',
      // Issue #838 review, P2: bytes the RUNNER wrote about a subprocess that
      // never ran have their own file, so neither transcript above carries them.
      'reconsideration-runner-error-<lineageId>.txt',
      // Issue #846: the arbitration run's §8.2 bundle manifest — written before
      // the arbiter answers, so a malformed verdict still records what it saw —
      // and the three transcripts that mirror the reconsideration ones.
      'arbitration-bundle-<lineageId>.json',
      'arbitration-raw-<lineageId>.txt',
      'arbitration-stderr-<lineageId>.txt',
      'arbitration-runner-error-<lineageId>.txt',
    ]) {
      expect(doc).toContain(artifact);
    }
  });

  // Issue #838 review, P2: the raw transcript is the agent's bytes, not the
  // runner's rendering of them. The two-file rule is what makes that true when
  // an agent writes to both streams, so the contract has to state it.
  test('forbids runner-authored content inside the raw transcripts', () => {
    expect(doc).toMatch(/the\s+runner inserts no delimiter, banner, or heading/);
    expect(doc).toMatch(/the only content it may\s+add is an explicit truncation marker/);
    expect(doc).toMatch(/Two\s+streams are two files rather than one merged transcript/);
    expect(doc).toMatch(/bytes the agent never wrote are never appended\s+to them/);
  });

  test('keeps full records in artifacts, bounded state in task context', () => {
    expect(doc).toMatch(/the full records live in run artifacts, not in the SQLite context column/);
  });

  // Issue #840: the transition layer's idempotency ledger. It is a persisted
  // field like `disputeRuns`, so the contract has to say what it holds and what
  // a delivery already on file does — otherwise a re-delivered outcome could
  // spend a counter twice and nothing would say it must not.
  test('bounds every transition with an applied-transition ledger', () => {
    expect(doc).toMatch(/`appliedTransitions` ledger on the lineage/);
    expect(doc).toMatch(/short opaque digest of the\s+transition's `<lineageId>@<version>#<runId>` key/);
    expect(doc).toMatch(
      /A delivery whose digest is already on file\s+changes no state, consumes no counter, and emits no second audit event/,
    );
    expect(doc).toMatch(/the ledger carries no run identifier,\s+prose, or path into task context/);
  });

  // Issue #840: rows 16 and 22 are the two ends of one bounded round, and the
  // §10.3 vocabulary is closed — so the contract states which event row 22
  // emits rather than leaving an implementer to invent a token for it.
  test('the one evidence event covers both ends of the bounded round', () => {
    expect(doc).toMatch(/The vocabulary carries no evidence-completed token/);
    expect(doc).toMatch(/row 16\s+requests it and row 22 records the collected attachments/);
    expect(doc).toMatch(/distinguished in the audit record by the row and by the incremented\s+`evidenceRoundsUsed` counter/);
  });

  test('names the audit events for every transition', () => {
    for (const event of [
      'dispute.finding.opened', 'dispute.rebuttal.recorded', 'dispute.rebuttal.rejected',
      'dispute.reconsideration.recorded', 'dispute.revision.material',
      'dispute.revision.non_material', 'dispute.revision.ambiguous',
      'dispute.arbitration.verdict', 'dispute.arbitration.malformed',
      'dispute.evidence.requested',
      'dispute.reopen.requested', 'dispute.escalated.human', 'dispute.resolved',
    ]) {
      expect(doc).toContain(event);
    }
  });

  test('audit events carry literals and counters only', () => {
    expect(doc).toMatch(/Events carry literals and counters only — never argument prose, evidence content, or local paths/);
  });

  test('public comments are posted only on resolution or escalation, shape not content', () => {
    expect(doc).toMatch(/posted only on lineage resolution or human escalation/);
    expect(doc).toMatch(/describes the \*shape\* of the outcome, never its \*content\*/);
  });

  test('forbids publishing prose, evidence, paths, and identifiers', () => {
    expect(doc).toMatch(/Never published: rebuttal or rationale prose, arbiter reasoning, evidence content or quoted file lines, local filesystem paths, raw agent output, session\/run\/task-store identifiers, or provider error text/);
  });

  test('the published outcome literal is a terminal state; binding never gets its own comment', () => {
    expect(doc).toMatch(/The outcome literal is the lineage's terminal state — exactly one of `resolved_fixed`, `resolved_withdrawn`, `resolved_overruled`, `escalated_human`/);
    expect(doc).toMatch(/`binding` is not a resolution and never receives its own comment/);
    expect(doc).toMatch(/published only when it later reaches a terminal state via §7 rows 23–24/);
  });

  test('the published affectedBoundary is the admission-normalized repository-relative value', () => {
    expect(doc).toMatch(/always the admission-normalized repository-relative value of §2\.1, never a raw agent-supplied path/);
    expect(doc).toMatch(/no admitted lineage can carry a local filesystem path into this comment/);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behavior
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — fail-closed behavior', () => {
  test('enumerates the malformed shapes', () => {
    expect(doc).toMatch(/an unparseable structured block; an unknown enum token; a missing required field; an unresolvable evidence reference/);
    expect(doc).toMatch(/a `fixed` disposition in a fix run that produced no file changes \(§3\.4\)/);
    expect(doc).toMatch(/a second rebuttal for the same version; a `review_disputed` on a `binding` finding/);
  });

  test('malformed output changes no state and consumes no counter', () => {
    expect(doc).toMatch(/\*\*no protocol state changes\*\*, no bounded counter is consumed/);
    expect(doc).toMatch(/Malformed output can therefore never win a dispute, never burn the implementer's rebuttal slot, and never bypass the review-loop cap/);
  });

  test('repeated malformed output lands at the existing loop cap', () => {
    expect(doc).toMatch(/Repeated malformed output exhausts the existing `session\.reviewLoop\.maxCycles` cap and lands at `ready_for_human`/);
  });

  test('a diff-producing run with a malformed disposition routes via §7.1 and retains the diff', () => {
    expect(doc).toMatch(/That fallback to today's run outcome applies only to a run with \*\*no\*\* file changes/);
    expect(doc).toMatch(/the §7\.1 aggregation is the authoritative router and today's success-routes-to-review rule does not apply/);
    expect(doc).toMatch(/the runner records `pendingReReview: true` \(§7\.1\), so the unreviewed diff's ordinary re-review is deferred, never skipped/);
  });
});

// ---------------------------------------------------------------------------
// Legacy compatibility
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — legacy compatibility', () => {
  test('legacy free-form reviewFeedback remains and stays the fix-prompt payload', () => {
    expect(doc).toMatch(/`task\.context\.reviewFeedback` remains, bounded exactly as today, and remains the fix-prompt payload/);
  });

  test('the disabled default is byte-identical to today', () => {
    expect(doc).toMatch(/review and fix behave byte-identically to today/);
  });

  test('a legacy-format review keeps the protocol inert, never a hard error', () => {
    expect(doc).toMatch(/emits \*\*no\*\* structured finding blocks \(a legacy-format review\) is handled exactly as today/);
    expect(doc).toMatch(/no lineage exists, and therefore no dispute is possible/);
    expect(doc).toMatch(/the protocol is inert for them, never a hard error/);
  });

  test('mixed reviews keep prose blocking force and fail closed on no-diff runs', () => {
    expect(doc).toMatch(/A review is \*\*fully structured\*\* when, after the runner extracts the structured finding blocks, the remaining free-form feedback is empty or whitespace-only/);
    expect(doc).toMatch(/the prose keeps its legacy blocking force/);
    expect(doc).toMatch(/mixed reviews fail closed/);
    expect(doc).toMatch(/a prose-only blocking finding can never be silently dropped/);
    expect(doc).toMatch(/A reviewer who wants a finding disputable must emit it as a structured block/);
  });

  test('the classifier vocabulary and phase routing are unchanged', () => {
    expect(doc).toMatch(/The existing classifier vocabulary \(`success`, `needs_fix`, `conflict`, `blocked`\) and the `nextPhaseAfter` routing are unchanged/);
  });
});

// ---------------------------------------------------------------------------
// Decision record
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — decision record', () => {
  test('has a decision record with chosen and rejected sections', () => {
    expect(doc).toMatch(/### 14\.1 Chosen/);
    expect(doc).toMatch(/### 14\.2 Rejected/);
    expect(doc).toMatch(/Accepted costs, stated plainly/);
  });

  test('rejects unlimited debate and free-form disagreement', () => {
    expect(doc).toMatch(/Unlimited implementation\/reviewer back-and-forth until convergence/);
    expect(doc).toMatch(/Free-form "I disagree" handling/);
  });

  test('rejects reviewer-graded materiality and an editing arbiter', () => {
    expect(doc).toMatch(/Letting the reviewer's `materialityClaim` decide materiality/);
    expect(doc).toMatch(/Letting the arbiter edit code or add findings/);
  });

  test('rejects a fixed vendor and a fail-open missing-arbiter default', () => {
    expect(doc).toMatch(/Fixing one vendor\/model as the arbiter/);
    expect(doc).toMatch(/Auto-accepting disputes when no arbiter is configured/);
  });

  test('rejects treating silence as a dispute', () => {
    expect(doc).toMatch(/Treating a no-change run as a dispute implicitly/);
    expect(doc).toMatch(/Silence is not evidence/);
  });
});

// ---------------------------------------------------------------------------
// §15 Specification gaps (issue #848)
//
// Recorded in the contract rather than closed inside an implementation Issue.
// Pinned here so a future revision that adds the missing transition has to
// remove the gap from the document (and this test) deliberately, instead of
// leaving operator tooling promising a continuation the protocol never defined.
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — open specification gaps', () => {
  test('records that no human-resolution transition leaves escalated_human', () => {
    expect(doc).toMatch(/## 15\. Specification gaps \(open\)/);
    expect(doc).toMatch(/G1 — no human-resolution transition out of `escalated_human`/);
    expect(doc).toMatch(/there is no row that consumes a human verdict/);
    expect(doc).toMatch(/no field for one in §10\.1, and no audit event for it in §10\.3/);
  });

  test('states the fail-closed obligation an implementation inherits from a gap', () => {
    expect(doc).toMatch(/implementation must fail closed on these/);
    expect(doc).toMatch(/state the stop reason, point at the existing recovery path, and change nothing/);
    expect(doc).toMatch(/Closing a gap is a change to this document first/);
  });

  test('keeps §6.4 reopen_requested as the only operator-initiated transition', () => {
    expect(doc).toMatch(
      /the only operator-initiated transition the contract defines remains §6\.4's `reopen_requested` flag/,
    );
    expect(doc).toMatch(/records a request against a \*\*resolved\*\* lineage without overturning it/);
  });

  test('records the undispatched-turn park as a dispatcher gap, not an operator one', () => {
    expect(doc).toMatch(/G2 — no operator continuation for the undispatched-turn park/);
    expect(doc).toMatch(
      /The gap closes by implementing the missing dispatchers, not by adding an operator transition/,
    );
  });

  test('the verification section claims the gaps are pinned', () => {
    expect(doc).toMatch(/## 16\. Verification \(documentation tests\)/);
    expect(doc).toMatch(/the open specification gaps of §15/);
  });
});

// ---------------------------------------------------------------------------
// Cross-document consistency
// ---------------------------------------------------------------------------

describe('docs/review-dispute-contract.md — cross-document links', () => {
  test('phase-contracts.md points at this contract from the fix and review lanes', () => {
    const links = phaseContracts.match(/review-dispute-contract\.md/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(phaseContracts).toMatch(/evidence-backed review-dispute protocol/);
  });

  test('phase-contracts.md keeps the no-diff failure until the protocol lands', () => {
    expect(phaseContracts).toMatch(/a fix run that produces no diff fails exactly as described above/);
  });

  test('this document links back to phase-contracts.md and the evidence contract', () => {
    expect(doc).toMatch(/phase-contracts\.md/);
    expect(doc).toMatch(/research-evidence-contract\.md/);
  });

  test('this document reuses the existing review classification tokens', () => {
    for (const token of ['`success`', '`needs_fix`', '`conflict`', '`blocked`']) {
      expect(doc).toContain(token);
      expect(phaseContracts).toContain(token.replace(/`/g, '`'));
    }
  });

  test('contains no absolute filesystem paths', () => {
    expect(doc).not.toMatch(/\/Users\//);
    expect(doc).not.toMatch(/\/home\/[a-z]/);
  });
});
