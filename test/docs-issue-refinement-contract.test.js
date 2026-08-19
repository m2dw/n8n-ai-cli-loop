/**
 * Structural tests for docs/issue-refinement-contract.md (issue #866).
 *
 * The document is the authoritative contract for chain-aware progressive Issue
 * refinement, so these tests pin the claims a follow-up implementer or reviewer
 * must not have to rediscover: the single human-facing marker, its
 * non-executable/mutual-exclusion rules over the complete executable-status set
 * (`status:needs-fix` included, since it is the first route intake takes), and
 * the §3.1 guard that stops a task which already existed when the marker
 * landed, the closed vocabularies, the
 * two-lane separation from standalone manual refinement, the eligibility and
 * trigger semantics including the merged-predecessor shape and the required
 * implementation `agent:*` label — the half of the ordinary intake pair that
 * activation does not add, so the lane must require it at admission and keep
 * it — the bounded
 * snapshot inputs, the fingerprint/staleness behavior — its one-to-one coverage
 * of the snapshot inputs, the two exclusions for the lane's own writes, and the
 * dispatch-time precondition that keeps a delayed outbox effect from applying a
 * stale refinement — both agent schemas, the
 * critic-independence rule and its role-resolution failure path, the bounded
 * -refinement constants, the applicable/advisory split with its topology
 * fail-closed rule, the managed-region rules, the activation ordering with its
 * verify-before-persist commit point, its
 * remove-before-add label replacement and its park-and-reactivate handover into
 * the implementation lane, the undeliverable-handoff-comment exception, every
 * transition-table row, the handoff behavior and its operator recovery
 * command — including the label-shape precondition that recovery needs after
 * the one handoff that cannot leave the marker in place — assignment
 * retention, the audit and comment policies, the fail-closed
 * malformed-output rules and the separate bounded-retry-then-handoff
 * disposition for agent process failures, the compatibility statements, and
 * the open specification gaps.
 *
 * They are structural only — no runtime behavior is asserted here, even
 * though the lane the contract describes is now implemented (issues
 * #867-#871), default-off behind `session.issueRefinement.enabled`.
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

const RAW = readFileSync(resolve(ROOT, 'docs/issue-refinement-contract.md'), 'utf8');
const doc = RAW.replace(/\s+/g, ' ');
const phaseContracts = read('docs/phase-contracts.md');
const ideaToImplementation = read('docs/idea-to-implementation.md');

// ---------------------------------------------------------------------------
// Authority and scope
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — authority and scope', () => {
  test('is marked as an approved design, with implementation status recorded separately', () => {
    expect(doc).toMatch(/approved design \(issue #866\)/);
    expect(doc).toMatch(
      /No production intake, implementation, or review behavior changed in #866\s+itself — #866 shipped the contract, not the lane\./,
    );
  });

  test('is the authoritative contract that follow-up issues must not redefine', () => {
    expect(doc).toMatch(/authoritative contract/);
    expect(doc).toMatch(/MUST NOT redefine its policy/);
    expect(doc).toMatch(/a change of policy is a change to this document first/);
  });

  test('records that the follow-up Issues shipped the lane, default-off', () => {
    expect(doc).toMatch(
      /\*\*Implementation status \(issues #867-#871\)\.\*\* The protocol described here is\s+now implemented/,
    );
    expect(doc).toMatch(/It ships default-off behind the same flag\./);
    expect(doc).toMatch(/feature-status\.md#issue-refinement/);
  });

  test('is gated behind a session flag that defaults to false', () => {
    expect(doc).toMatch(/`session\.issueRefinement\.enabled`, which defaults to `false`/);
    expect(doc).toMatch(/behaves exactly as today/);
  });

  test('records the copybara export decision for this document', () => {
    expect(doc).toMatch(/\*\*publicly exportable\*\*, not private-only/);
    expect(doc).toMatch(/copybara\/copy\.bara\.sky/);
  });

  test('keeps the PR merge as the final human approval point', () => {
    expect(doc).toMatch(/final human approval point is unchanged: it is the PR merge/);
  });
});

// ---------------------------------------------------------------------------
// Canonical vocabulary — closed sets
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — canonical vocabulary', () => {
  test('defines exactly three roles, and separates authoring from mutation', () => {
    expect(doc).toMatch(
      /`refiner` \(AI A, produces the refined Issue contract\), `critic` \(AI B, independently critiques it\), `runner`/,
    );
    expect(doc).toMatch(
      /The refiner and critic never mutate GitHub; the runner never authors prose/,
    );
  });

  test('defines the refinement state vocabulary and its terminal states', () => {
    expect(doc).toMatch(
      /`pending`, `eligible`, `drafting`, `critiquing`, `accepted`, `applying`, `activated`, `escalated_human`/,
    );
    expect(doc).toMatch(/`activated` and `escalated_human` are terminal/);
  });

  test('defines exactly three critic verdicts', () => {
    expect(doc).toMatch(
      /\*\*Critic verdicts\*\* \(closed set, exactly three\): `pass`, `revise`, `block`/,
    );
  });

  test('defines exactly two change classes and assigns every field to one', () => {
    expect(doc).toMatch(/\*\*Change classes\*\* \(closed set, exactly two\)/);
    expect(doc).toMatch(/`applicable` — changes the runner may apply automatically/);
    expect(doc).toMatch(/`advisory` — changes the runner records and publishes but never applies/);
    expect(doc).toMatch(/Every field of a refiner result belongs to exactly one class/);
  });

  test('makes an unclassified topology proposal blocking (fail closed)', () => {
    expect(doc).toMatch(
      /A proposal is `advisory` only when the refiner marked it `advisory` \*\*and\*\* the critic independently confirmed `advisory`/,
    );
    expect(doc).toMatch(
      /every other combination, including an unclassified proposal, is `blocking`/i,
    );
  });

  test('separates the three eligibility refusal reasons from the handoff reasons', () => {
    expect(doc).toMatch(
      /\*\*Refusal reasons\*\* \(closed set, exactly three\).*`conflicting_markers`, `no_implementation_agent`, `predecessor_not_ready`/,
    );
  });

  test('enumerates the handoff reasons', () => {
    for (const reason of [
      'fan_in_exceeded',
      'chain_disagreement',
      'not_chain_scoped',
      'malformed_refiner_output',
      'malformed_critic_output',
      'topology_change_required',
      'no_convergence',
      'critique_blocked',
      'stale_inputs',
      'unexpected_managed_region',
      'malformed_managed_region',
      'managed_region_modified',
      'no_independent_critic',
      'effect_undeliverable',
      'agent_unavailable',
      'marker_precondition_failed',
      'execution_marker_conflict',
    ]) {
      expect(doc).toContain(`\`${reason}\``);
    }
  });

  // The conflicting-marker shape that reaches an existing task cannot reuse the
  // `conflicting_markers` refusal literal: a refusal creates no task.
  test('the execution-guard reason is a handoff, and says why it is not the refusal literal', () => {
    expect(doc).toMatch(
      /`execution_marker_conflict` \(§3\) exists for the same reason and covers the one conflicting-marker shape that is not an admission decision: a task that already exists at an executable phase when `status:needs-refinement` appears on its Issue/,
    );
  });

  // The two runtime failures every deployment will meet — an agent process
  // that dies, and a label precondition that no longer holds at dispatch —
  // must be handoffs rather than refusals, because a task already exists.
  test('explains why the two runtime failure reasons are handoffs, not refusals', () => {
    expect(doc).toMatch(
      /Neither is a refusal: a refusal happens before a task exists, while both of these happen to a task that is already mid-lane/,
    );
  });

  test('scopes predecessors to direct blockers only', () => {
    expect(doc).toMatch(/A direct `blocked by` neighbour of the Issue being refined/);
    expect(doc).toMatch(/Transitive ancestors are never predecessors/);
  });
});

// ---------------------------------------------------------------------------
// Two lanes: standalone manual vs chain-aware automatic
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — lane separation', () => {
  test('separates the manual issue-discuss lane from the automatic lane', () => {
    expect(doc).toMatch(/This contract adds a second refinement lane/);
    expect(doc).toMatch(/It does not replace, wrap, or re-enter the first one/);
    expect(doc).toMatch(/The separation is normative/);
  });

  test('the manual lane targets a comment and requires human approval', () => {
    expect(doc).toMatch(/a GitHub \*\*comment\*\*/);
    expect(doc).toMatch(/required — `--approve` with the preview fingerprint/);
  });

  test('the automatic lane targets the Issue body managed region with no human step', () => {
    expect(doc).toMatch(/the Issue \*\*body\*\*'s managed region/);
    expect(doc).toMatch(/none on the successful path/);
  });

  test('the automatic lane never posts through issue-discuss post', () => {
    expect(doc).toMatch(/The automatic lane never calls `issue-discuss post`/);
    expect(doc).toMatch(
      /`issue-discuss post` remains the only path that publishes an operator-reviewed draft/,
    );
  });

  test('a standalone Issue is refused by the automatic lane, not silently refined', () => {
    expect(doc).toMatch(
      /The manual lane is the supported path for refining a \*\*standalone\*\* Issue/,
    );
    expect(doc).toMatch(
      /refuses that shape rather than silently degrading into a single-Issue rewrite/,
    );
  });
});

// ---------------------------------------------------------------------------
// The single marker
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — the human-facing marker', () => {
  test('introduces exactly one new label', () => {
    expect(doc).toMatch(
      /Exactly one new GitHub label is introduced: \*\*`status:needs-refinement`\*\*/,
    );
    expect(doc).toMatch(/It carries no sub-state/);
  });

  test('the marker is not an executable status and never routes to a phase', () => {
    expect(doc).toMatch(/\*\*`status:needs-refinement` is not an executable status\.\*\*/);
    expect(doc).toMatch(
      /It never routes to implementation, review, research, content, or conflict resolution/,
    );
  });

  test('a marked Issue carrying an executable status is refused entirely', () => {
    expect(doc).toMatch(/\*\*An Issue carrying it is not eligible for implementation\.\*\*/);
    expect(doc).toMatch(/intake refuses the Issue entirely — it neither refines nor implements it/);
    expect(doc).toMatch(/`refinement\.eligibility\.refused` with reason `conflicting_markers`/);
    expect(doc).toMatch(/guessing which one wins is exactly how a rough Issue reaches implementation/);
  });

  // The marker alone is not a reachable lane: activation hands the Issue back to
  // ordinary intake, which routes implementation only on `agent:*` +
  // `status:needs-implementation`. The agent label must therefore be on the
  // Issue for the whole lane, and the lane must never remove it.
  test('the marker travels with the implementation agent label, which the lane never removes', () => {
    expect(doc).toMatch(
      /\*\*The marker travels with the implementation `agent:\*` label, and the lane never removes it\.\*\*/,
    );
    expect(doc).toMatch(
      /an Issue carrying the marker with \*\*none\*\* of them is refused admission and held/,
    );
    expect(doc).toMatch(
      /`labelsToPhase` routes on an executable `status:\*` label, so an `agent:\*` label with no executable status produces no candidate and cannot race the relationship graph/,
    );
    expect(doc).toMatch(
      /ordinary intake produces an implementation candidate only from the pair `agent:\*` \+ `status:needs-implementation`/,
    );
    expect(doc).toMatch(
      /An activation that left the Issue with `status:needs-implementation` alone would park a task row nothing could ever reactivate/,
    );
  });

  // `status:needs-fix` is the FIRST route labelsToPhase() takes, so a conflict
  // guard derived from a list that omits it still admits a rough Issue into fix
  // mode. Both the §1 vocabulary and the §3 rule must carry the full six.
  test('the conflicting-marker set is the complete executable-status set, fix mode included', () => {
    const EXECUTABLE = [
      'status:needs-fix',
      'status:needs-review',
      'status:research-needed',
      'status:content-needed',
      'status:needs-implementation',
      'status:needs-conflict-resolution',
    ];
    expect(doc).toMatch(
      /\*\*Executable `status:\*` labels\*\* \(closed set, exactly six\) — the statuses the existing intake router \(`labelsToPhase` in `core\/github-intake\.ts`\) maps to a runnable phase/,
    );
    const vocabulary = RAW.split('**Executable `status:*` labels**')[1].split('**Predecessor.**')[0];
    for (const label of EXECUTABLE) {
      expect(vocabulary).toContain(`\`${label}\``);
    }
    expect(doc).toMatch(
      /Wherever this document says "an executable `status:\*` label" it means exactly this set, in full/,
    );
    expect(doc).toMatch(
      /`status:needs-fix` is a member and is the label the router checks \*\*first\*\*, so a conflict guard derived from a shorter list would still admit a rough Issue into fix mode/,
    );
    // §3's own enumeration repeats the set rather than pointing at a shorter one.
    const rule = RAW.split('**An Issue carrying it is not eligible for implementation.**')[1].split(
      '- **No further GitHub micro-state labels',
    )[0];
    for (const label of EXECUTABLE) {
      expect(rule).toContain(`\`${label}\``);
    }
    expect(doc).toMatch(
      /`status:needs-fix` in particular is executable and is the \*first\* route the intake router takes, so a guard that omitted it would leave fix mode as an open door into a rough Issue/,
    );
  });

  // Refusing admission decides nothing about a task that already exists; the
  // phase runner must refuse to execute it, or the mutual exclusion above is
  // bypassed precisely for the partially-applied label transitions it targets.
  test('the marker also stops an already-queued, claimed, or running task', () => {
    expect(doc).toMatch(/### 3\.1 The marker also stops a task that already exists/);
    expect(doc).toMatch(
      /Refusing \*admission\* \(row 2\) only decides whether a \*\*new\*\* task is created/,
    );
    expect(doc).toMatch(
      /an Issue whose implementation, fix, review, research, content, or conflict-resolution task is already `queued`, `claimed`, or `running`/,
    );
    expect(doc).toMatch(
      /\*\*A pre-execution marker guard, evaluated by the phase runner\.\*\*/,
    );
    expect(doc).toMatch(
      /the phase does not start: nothing is claimed, no agent process is spawned, no branch or worktree is created, and the task moves to `ready_for_human` with handoff reason `execution_marker_conflict`, emitting `refinement\.execution\.suspended`/,
    );
    expect(doc).toMatch(
      /The re-read is live rather than taken from the intake snapshot/,
    );
  });

  test('a running task is stopped cooperatively and its results are not published', () => {
    expect(doc).toMatch(
      /A running agent process is not killed mid-run: the loop's cancellation is already cooperative \(`TaskStore\.cancelTask`, issue #608\), and this lane adds no force-kill/,
    );
    expect(doc).toMatch(
      /The guard is therefore evaluated a \*\*second\*\* time, immediately before any of that run's outward effects are enqueued — push, PR creation or update, comment, label transition/,
    );
    expect(doc).toMatch(
      /no outward effect is enqueued, the task moves to `ready_for_human` with the same reason and event, and the local work \(branch, worktree, artifacts\) is preserved untouched/,
    );
    expect(doc).toMatch(
      /A run whose outward effects were already delivered before the marker appeared is out of scope/,
    );
  });

  test('the execution guard changes no labels and lives outside the §12 table', () => {
    expect(doc).toMatch(/\*\*The guard changes no labels\.\*\*/);
    expect(doc).toMatch(
      /It neither removes the executable `status:\*` label nor removes `status:needs-refinement`/,
    );
    expect(doc).toMatch(
      /\*\*This guard is outside §12's state machine, deliberately\.\*\* Every row of §12 is keyed on `context\.refinement\.state`, and the task this guard stops has no such state/,
    );
    // The second operator exit needs the cancel, because the row is shared.
    expect(doc).toMatch(
      /The cancellation is required in that second exit, not optional: refinement and implementation share one task row \(§14\), so a surviving row for the Issue makes the refinement admission a duplicate and the lane never starts/,
    );
  });

  test('detailed refinement state stays in SQLite, not in more labels', () => {
    expect(doc).toMatch(/\*\*No further GitHub micro-state labels are added\.\*\*/);
    expect(doc).toMatch(
      /Round counts, verdicts, fingerprints, snapshots, caps, and handoff reasons live in SQLite/,
    );
  });

  test('the lane never applies the marker, only removes it at activation', () => {
    expect(doc).toMatch(/never by the refinement lane itself/);
    expect(doc).toMatch(
      /The lane only ever \*removes\* it, as the last GitHub-visible step of activation \(§11, step 5/,
    );
  });

  test('the marker is still subject to the dormant-first ordering', () => {
    expect(doc).toMatch(/\*\*The marker is subject to the dormant-first contract\.\*\*/);
  });
});

// ---------------------------------------------------------------------------
// Eligibility and trigger
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — eligibility and trigger', () => {
  test('reuses the existing intake poll and adds no new trigger surface', () => {
    expect(doc).toMatch(/Eligibility is evaluated by the existing GitHub intake poll/);
    expect(doc).toMatch(/No new scheduler, webhook, or trigger surface is introduced/);
  });

  // Ordinary intake builds an implementation candidate from `agent:*` +
  // `status:needs-implementation`; activation adds only the status. Without the
  // agent label the activated Issue would never produce a candidate, so the
  // parked row could never be reactivated — hence the admission requirement.
  test('requires an implementation agent label at admission and refuses without one', () => {
    expect(doc).toMatch(
      /It carries `status:needs-refinement`, no executable `status:\*` label, and at least one `agent:\*` label naming an implementation-lane agent/,
    );
    expect(doc).toMatch(
      /\*\*Condition 1 is decided at admission; conditions 2–5 at predecessor resolution\.\*\*/,
    );
    expect(doc).toMatch(
      /no `agent:\*` label naming an implementation-lane agent → refusal reason `no_implementation_agent` \(row 47\)/,
    );
    expect(doc).toMatch(
      /admitting such an Issue would run the whole lane and then activate it into a state ordinary intake cannot pick up/,
    );
  });

  test('requires every direct predecessor to carry a usable stack-ready result', () => {
    expect(doc).toMatch(/\*\*Every\*\* direct predecessor has a usable result, in one of exactly two shapes/);
    expect(doc).toMatch(/`session\.labels\.stackReady`, `status:stack-ready` by default/);
    expect(doc).toMatch(/the same stack-ready resolver used by the Gate 2 implementation start gate/);
  });

  test('does not require a main-branch merge', () => {
    expect(doc).toMatch(/\*\*Main-branch merge is not required\.\*\*/);
    expect(doc).toMatch(
      /Waiting for the predecessor to merge into the default branch would serialize the chain/,
    );
  });

  // A predecessor that merges inside the poll interval can never satisfy Gate 2's
  // resolver again (it requires an OPEN PR), so keying eligibility on that
  // resolver alone would hold the dependent at `pending` forever — exactly when
  // Gate 1 would already admit it to implementation.
  test('accepts a merged predecessor as a usable refinement source', () => {
    expect(doc).toMatch(
      /\*\*merged stack-ready result\*\* — the predecessor's PR is \*\*merged\*\*, with a resolvable head commit SHA and merge commit SHA/,
    );
    expect(doc).toMatch(/\*\*A merged predecessor is a usable source, not a lost one\.\*\*/);
    expect(doc).toMatch(
      /a predecessor that merges inside the poll interval before the dependent is next evaluated would never satisfy it again/,
    );
    expect(doc).toMatch(
      /precisely when the ordinary dependency gate \(Gate 1, every `blocked by` Issue closed\) would already admit it to implementation/,
    );
    expect(doc).toMatch(
      /the merged shape does \*\*not\*\* require the stack-ready marker to still be present/,
    );
  });

  test('a mixed merged/open-stack-ready predecessor set is eligible, not held', () => {
    expect(doc).toMatch(
      /a chain whose predecessors are one merged and one open stack-ready is eligible, not held/,
    );
  });

  test('partial predecessor readiness holds rather than proceeding', () => {
    expect(doc).toMatch(/\*\*Partial readiness holds, it does not proceed\.\*\*/);
    expect(doc).toMatch(/the Issue stays `pending` and is re-evaluated next poll/);
  });

  // Eligibility admits shapes the implementation start gates do not (Gate 2
  // takes exactly one open blocker), so the doc has to say what happens to a
  // refined wide fan-in rather than imply implementation starts at once.
  test('a wide open fan-in is refinable but does not therefore start implementation', () => {
    expect(doc).toMatch(
      /\*\*A wide fan-in is refinable, but its implementation start is not therefore due\.\*\*/,
    );
    expect(doc).toMatch(
      /Gate 2 admits \*\*exactly one\*\* open unsatisfied blocker/,
    );
    expect(doc).toMatch(
      /refinable now and implementable only once all but one of them is satisfied/,
    );
    expect(doc).toMatch(
      /§11 step 7 specifies exactly what happens to such an Issue after activation, and §12 row 34 is its normative wait state/,
    );
  });

  // Several eligibility guards can be true of the same Issue at once (an
  // over-cap fan-in whose predecessors are also unready), so the doc has to fix
  // an order — otherwise an implementation may take the pending hold forever
  // instead of the required fan_in_exceeded/chain_disagreement handoff.
  test('orders the eligibility guards so a hold cannot pre-empt a handoff', () => {
    expect(doc).toMatch(/\*\*The guards are ordered, and the first match wins\.\*\*/);
    expect(doc).toMatch(
      /an Issue can exceed the predecessor cap \*and\* have an unready predecessor/,
    );
    const order = [
      '**No direct predecessor** → handoff, reason `not_chain_scoped`',
      '**More direct predecessors than `MAX_PREDECESSORS_PER_REFINEMENT`** →',
      "**The observed predecessor set disagrees with the chain's accepted",
      '**Any direct predecessor without a usable result** → hold',
      'Otherwise → `eligible` (row 3)',
    ];
    let cursor = -1;
    for (const step of order) {
      const at = RAW.indexOf(step);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(doc).toMatch(
      /The three structural failures are evaluated before the readiness hold because none of them is fixed by waiting/,
    );
    expect(doc).toMatch(
      /The hold of row 4 is therefore reserved for an Issue on which conditions 1–3 all pass/,
    );
  });

  test('every negative or erroring answer fails closed', () => {
    expect(doc).toMatch(/\*\*Every negative answer fails closed\.\*\*/);
    expect(doc).toMatch(/An error is never read as "no blockers\."/);
  });

  test('a chainless Issue is refused rather than refined', () => {
    expect(doc).toMatch(/\*\*A chainless Issue is refused, not refined\.\*\*/);
    expect(doc).toMatch(/`not_chain_scoped`/);
  });

  test('cross-checks the observed predecessor set against the chain accepted revision', () => {
    expect(doc).toMatch(
      /agrees with the chain registry's accepted revision for the Issue's chain/,
    );
  });
});

// ---------------------------------------------------------------------------
// Bounded snapshots
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — predecessor inputs and snapshots', () => {
  test('the snapshot is captured once by the runner and frozen', () => {
    expect(doc).toMatch(/captured once per round-set by the runner and frozen for the duration/);
    expect(doc).toMatch(
      /The agents never query GitHub, never resolve a reference the snapshot omitted/,
    );
  });

  test('captures the predecessor PR identity and changed paths without content', () => {
    expect(doc).toMatch(
      /number, state literal \(`open` \| `merged`\), head ref name, head commit SHA, merge commit SHA when merged, title, body/,
    );
    expect(doc).toMatch(
      /paths and counts only, never file content or patch hunks/,
    );
  });

  test('captures terminal review outcome literals only', () => {
    expect(doc).toMatch(/the terminal review outcome literal recorded for that predecessor/);
    expect(doc).toMatch(/literals and counts only/);
  });

  test('treats all snapshot text as untrusted data, never instructions', () => {
    expect(doc).toMatch(/\*\*All snapshot text is untrusted\.\*\*/);
    expect(doc).toMatch(/is never interpreted as instructions/);
  });

  test('truncates over-cap input rather than dropping or using it in full', () => {
    expect(doc).toMatch(
      /An over-cap input is truncated, never silently dropped and never used in full/,
    );
  });

  test('excludes predecessor source diffs deliberately', () => {
    expect(doc).toMatch(/\*\*Predecessor source diffs are deliberately excluded\.\*\*/);
    expect(doc).toMatch(/would leak repository content into a public Issue/);
  });

  test('accepts an existing issue-plan artifact as an input', () => {
    expect(doc).toMatch(/the `issue-plan` artifact for this Issue, when one exists locally/);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint and staleness
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — fingerprint and staleness', () => {
  test('defines the fingerprint over every snapshot input the agents receive', () => {
    expect(doc).toMatch(/\*\*`predecessorFingerprint`\*\*: a SHA-256/);
    expect(doc).toMatch(
      /\*\*every input the §5 snapshot hands the agents\*\*/,
    );
    expect(doc).toMatch(/no input the agents can see is left out of it/);
  });

  // The staleness guarantee is only as wide as the fingerprint: an input the
  // agents read but the fingerprint ignores lets the lane apply a draft written
  // against evidence that has since changed.
  test('hashes each §5 snapshot input, not only the PR head SHAs', () => {
    const section = RAW.split('## 6.')[1].split('## 7.')[0].replace(/\s+/g, ' ');
    // Target Issue inputs.
    expect(section).toMatch(/the digest of its title/);
    expect(section).toMatch(/the digest of its \*\*source body\*\*/);
    expect(section).toMatch(/its sorted label set, with the two lane-owned labels removed/);
    expect(section).toMatch(
      /the digest of the local `issue-plan` artifact used as an input, or the literal `absent` when there is none/,
    );
    // Predecessor inputs.
    expect(section).toMatch(
      /Issue number, Issue state literal \(`open` \| `closed`\), and the digests of its title and body/,
    );
    expect(section).toMatch(/stack-ready marker presence/);
    expect(section).toMatch(
      /state literal \(`open` \| `merged`\), head ref name, head commit SHA, merge commit SHA or `absent`, and the digests of its title and body/,
    );
    expect(section).toMatch(
      /the digest of the captured changed-path list — each path with its added\/removed counts, in capture order/,
    );
    expect(section).toMatch(
      /the terminal review outcome literal, plus the digest of the captured dispute lineage state literals and counts/,
    );
    expect(section).toMatch(
      /the digest of the captured comment window — per comment, its identifier, its last-edited timestamp, and its body digest/,
    );
    // Digests are taken over the truncated bytes the agents actually saw.
    expect(section).toMatch(
      /a lowered truncation cap is itself a fingerprint change/,
    );
    expect(section).toMatch(/The §5 list and this list are one-to-one by construction/);
  });

  // Both exclusions are writes the lane performs itself. Hashing the managed
  // region would make the step-3 body write invalidate the preconditions of
  // steps 4 and 5, so no first refinement could ever complete; hashing the
  // lane-owned labels would break the second half of its own label transition.
  test('excludes exactly the lane\'s own two writes, by name and with reasons', () => {
    expect(doc).toMatch(/\*\*Excluded, and why\.\*\* Exactly two inputs do not participate in freshness/);
    expect(doc).toMatch(/\*\*The managed region of the target body\*\* \(§10\)/);
    // The first refinement APPENDS the region, so the elision has to be canonical
    // or that append would itself shift the source-body digest.
    expect(doc).toMatch(
      /The elision is canonical, so that appending a region for the first time does not change the source body's digest/,
    );
    expect(doc).toMatch(
      /the begin marker through the end marker inclusive is removed, together with the single blank-line separator introduced in front of it when the region was appended/,
    );
    expect(doc).toMatch(
      /hashing the whole body would mean the lane's own write invalidates its own remaining steps/,
    );
    expect(doc).toMatch(
      /no refinement could ever finish its first application/,
    );
    expect(doc).toMatch(
      /the begin marker carries the fingerprint prefix, so a fingerprint over the region could not be computed at all/,
    );
    expect(doc).toMatch(/Everything outside the region is hashed in full/);
    expect(doc).toMatch(/\*\*The two lane-owned labels\*\*/);
    expect(doc).toMatch(
      /hashing them would invalidate the second half of the lane's own label transition/,
    );
    expect(doc).toMatch(/Every other label on the Issue is hashed/);
  });

  test('guards the two excluded labels with marker preconditions instead', () => {
    expect(doc).toMatch(/\*\*marker precondition\*\* carried on the label effects themselves/);
    expect(doc).toMatch(
      /the removal requires `status:needs-refinement` to be present, and the addition requires it to be absent and no executable `status:\*` label other than the one being added to be present/,
    );
    expect(doc).toMatch(
      /A hand-applied executable status therefore stops the transition instead of being silently overwritten/,
    );
  });

  // At-least-once delivery redelivers the label effects, so "already in the
  // end state" has to be satisfaction rather than failure — otherwise every
  // retried activation would escalate.
  test('satisfies a marker precondition whose own end state already holds', () => {
    expect(doc).toMatch(
      /\*\*A marker precondition is satisfied when its own end state already holds\.\*\*/,
    );
    expect(doc).toMatch(
      /A redelivered removal that finds the marker already gone, and a redelivered addition that finds `status:needs-implementation` already present, each perform nothing and count as satisfied/,
    );
    expect(doc).toMatch(
      /Who produced the end state does not matter/,
    );
  });

  // The one shape that genuinely fails is an operator adding a *different*
  // executable status between the removal landing and the addition
  // dispatching — the task is already `applying`, so it needs a handoff.
  test('turns a genuinely failed marker precondition into a handoff, not a refusal', () => {
    expect(doc).toMatch(
      /\*\*A precondition that genuinely does not hold is a handoff, not a refusal\.\*\*/,
    );
    expect(doc).toMatch(
      /an operator adds a \*different\* executable `status:\*` label after the removal effect landed and before the addition effect dispatches/,
    );
    expect(doc).toMatch(
      /the task escalates with reason `marker_precondition_failed` \(§12, row 42\)/,
    );
    expect(doc).toMatch(
      /It is deliberately \*\*not\*\* `conflicting_markers`: that literal is a pending-admission refusal that creates no task \(§12, row 2\), whereas this failure happens to a task already in `applying`/,
    );
    expect(doc).toMatch(
      /which must end on a state §13's recovery can act on rather than sit in `applying` with a half-finished label transition/,
    );
  });

  test('a predecessor that merges mid-attempt re-snapshots instead of stranding', () => {
    expect(doc).toMatch(
      /\*\*A predecessor that merges mid-attempt is a fingerprint change, not a dead end\.\*\*/,
    );
    expect(doc).toMatch(
      /re-snapshotted from the merged result, which §4 accepts as a usable source/,
    );
    expect(doc).toMatch(/The attempt is re-run, never stranded/);
  });

  test('is the idempotency key for the applied refinement', () => {
    expect(doc).toMatch(/it is the idempotency key for the applied refinement/);
    expect(doc).toMatch(/Applying the same fingerprint twice is a no-op, not a second edit/);
  });

  test('is recomputed immediately before the commit point, ahead of both persistence and mutation', () => {
    expect(doc).toMatch(
      /recomputed from live GitHub state immediately before the commit point of §11\*\* — step 1, which precedes both the persistence of step 2 and the first GitHub mutation of step 3/,
    );
  });

  test('is also re-checked at outbox dispatch, not only at enqueue time', () => {
    expect(doc).toMatch(
      /\*\*It is also a dispatch precondition, not only an enqueue-time check\.\*\*/,
    );
    expect(doc).toMatch(
      /the dispatcher recomputes the live fingerprint \*\*immediately before performing that effect\*\*/,
    );
    expect(doc).toMatch(/On mismatch the effect is not performed/);
    expect(doc).toMatch(
      /an effect that has waited in the outbox across a stale window is stopped, never applied late/,
    );
    // The guarantee is honest about needing a dispatcher that does not exist
    // yet: today's dispatcher performs a claimed row unconditionally.
    expect(doc).toMatch(
      /Today's dispatcher has no such check and no way to recompute a fingerprint before delivery, so this is one of the three outbox extensions §18 requires/,
    );
  });

  // The fingerprint deliberately cannot see inside the managed region, so the
  // exclusion has to be paid for: without a region precondition, an edit made
  // inside the region after the body write lands would still pass every later
  // check and be activated as if a critic had approved it.
  test('compensates the region exclusion with a stamped region digest', () => {
    expect(doc).toMatch(/\*\*The excluded region carries its own precondition\.\*\*/);
    expect(doc).toMatch(
      /the lane would post its audit comment and transition labels for content neither agent wrote and no critic approved/,
    );
    expect(doc).toMatch(/\*\*`appliedRegionDigest`\.\*\*/);
    expect(doc).toMatch(
      /the begin marker line through the end marker line inclusive, and nothing outside them/,
    );
    expect(doc).toMatch(
      /\*\*It is stamped on every effect the attempt enqueues after the body update\*\* — the audit comment of step 4 and each label effect of step 5/,
    );
    // The body update itself cannot carry the precondition: it is the write
    // that establishes the digest.
    expect(doc).toMatch(
      /The body-update effect itself carries no region precondition: it is the write that establishes the digest/,
    );
    expect(doc).toMatch(
      /\*\*The dispatcher re-derives it immediately before performing such an effect\*\*/,
    );
    expect(doc).toMatch(/The precondition holds only on a byte-for-byte match/);
    expect(doc).toMatch(
      /A region edited, truncated, re-marked, replaced, deleted, or made malformed after step 3 delivered all fail it/,
    );
    expect(doc).toMatch(
      /\*\*A failed region precondition is dispositioned exactly as a stale fingerprint is\*\*/,
    );
    expect(doc).toMatch(
      /re-snapshots below `MAX_STALE_RESTARTS_PER_ISSUE` \(§12, row 43\) or escalates with reason `managed_region_modified` at the cap \(§12, row 44\)/,
    );
    expect(doc).toMatch(/\*\*The digest belongs to the attempt, not to the Issue\.\*\*/);
  });

  test('discards a stale draft instead of merging it', () => {
    expect(doc).toMatch(/the accepted draft is \*\*discarded, never merged\*\*/);
    expect(doc).toMatch(/`MAX_STALE_RESTARTS_PER_ISSUE` times; at the cap it escalates with reason `stale_inputs`/);
    expect(doc).toMatch(
      /Partially applying a stale contract, or diffing an old draft against new inputs, is not permitted/,
    );
  });
});

// ---------------------------------------------------------------------------
// Roles, schemas, isolation
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — refiner and critic schemas', () => {
  test('the refiner returns exactly one fenced JSON object and mutates nothing', () => {
    expect(doc).toMatch(/The refiner receives the §5 snapshot and returns exactly one fenced JSON object/);
    expect(doc).toMatch(/It edits no files, runs no commands, and touches no network/);
  });

  test('the refiner schema carries the applicable body fields', () => {
    for (const field of [
      'summary',
      'acceptanceCriteria',
      'testPlan',
      'risks',
      'implementationNotes',
      'predecessorReferences',
    ]) {
      expect(doc).toContain(`"${field}"`);
    }
  });

  test('the refiner schema carries topology proposals as advisory-only', () => {
    expect(doc).toMatch(/"topologyProposals": \[ \/\/ advisory — never applied \(§9\)/);
    expect(doc).toMatch(
      /"kind": "split \| dependency_add \| dependency_remove \| dependency_rewire \| supersede"/,
    );
  });

  test('the refiner may not reference an Issue or PR absent from the snapshot', () => {
    expect(doc).toMatch(
      /A reference to any other Issue or PR is malformed/,
    );
  });

  test('the refiner may not emit repository content, paths, or region markers', () => {
    expect(doc).toMatch(
      /must not restate predecessor source code, quote file contents, or emit any local filesystem path/,
    );
    expect(doc).toMatch(/must not emit the managed-region markers of §10 anywhere in its output/);
  });

  test('the refiner never proposes label, milestone, assignee, or state changes', () => {
    expect(doc).toMatch(
      /The refiner never proposes label, milestone, assignee, or state changes/,
    );
    expect(doc).toMatch(/an implementation must not add them without changing this document first/);
  });

  test('the critic sees the snapshot and the result, but not the refiner transcript', () => {
    expect(doc).toMatch(/it does not receive the refiner's reasoning transcript/);
  });

  test('the critic verdicts have fixed semantics and objection requirements', () => {
    expect(doc).toMatch(/\*\*`pass`\*\* — the refined contract is supported by the snapshot/);
    expect(doc).toMatch(/`objections` must be empty/);
    expect(doc).toMatch(/\*\*`revise`\*\* — the contract is fixable within the round cap/);
    expect(doc).toMatch(/`objections` must be non-empty/);
    expect(doc).toMatch(/\*\*`block`\*\* — the contract must not be applied/);
    expect(doc).toMatch(/`block` goes straight to human handoff/);
  });

  test('the critic evaluates and never authors replacement prose', () => {
    expect(doc).toMatch(/The critic evaluates; it never authors replacement prose/);
    expect(doc).toMatch(
      /A critic result containing a rewritten body, criteria list, or notes is malformed/,
    );
  });
});

describe('docs/issue-refinement-contract.md — agent selection and isolation', () => {
  test('the critic must be a different agent, with no self-critique fallback', () => {
    expect(doc).toMatch(/\*\*The critic must not be the same agent as the refiner\.\*\*/);
    expect(doc).toMatch(/escalates with reason `no_independent_critic`/);
    expect(doc).toMatch(/It never falls back to self-critique/);
  });

  test('resolves both roles before the snapshot, so selection failure has a path', () => {
    expect(doc).toMatch(
      /\*\*Role resolution is an explicit, ordered step, not an implicit lookup\.\*\*/,
    );
    expect(doc).toMatch(
      /in state `eligible` and \*\*before the snapshot is captured\*\* — the `roles\.resolved` event of §12, rows 8 and 9/,
    );
    expect(doc).toMatch(
      /escalates at row 9 without spending a snapshot, a draft, or a round/,
    );
    expect(doc).toMatch(
      /A provider that later fails mid-run is an agent process failure \(§17\), not a selection failure/,
    );
  });

  test('reuses the review arbiter cross-provider selection policy', () => {
    expect(doc).toMatch(/Selection reuses the cross-provider policy already specified for the review arbiter/);
    expect(doc).toMatch(/a same-provider, never same-model candidate is allowed only by explicit opt-in/);
  });

  test('both agents run with write-enabling env vars stripped', () => {
    expect(doc).toMatch(/\*\*Both agents run isolated\.\*\*/);
    expect(doc).toMatch(/Write-enabling environment variables are stripped/);
  });

  test('the phase is read-only with respect to the repository', () => {
    expect(doc).toMatch(
      /\*\*The refinement phase is read-only with respect to the repository\.\*\*/,
    );
    expect(doc).toMatch(/detached at fetched `origin\/<base>` in a per-issue worktree/);
    expect(doc).toMatch(/creates no branch, writes no commit, and pushes nothing/);
  });

  test('every GitHub mutation is performed by the runner through the outbox', () => {
    expect(doc).toMatch(
      /Every GitHub mutation in this contract is performed by the runner through the existing outbox, never by an agent/,
    );
  });
});

// ---------------------------------------------------------------------------
// Bounded refinement
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — bounded refinement', () => {
  test('defines a round as one refiner draft plus one critic verdict', () => {
    expect(doc).toMatch(/A \*\*round\*\* is one refiner draft plus one critic verdict/);
  });

  const CONSTANTS = [
    ['MAX_PREDECESSORS_PER_REFINEMENT', '4'],
    ['MAX_REFINEMENT_ROUNDS_PER_ISSUE', '2'],
    ['MAX_MALFORMED_ATTEMPTS_PER_ROLE', '2'],
    ['MAX_AGENT_FAILURES_PER_ROLE', '2'],
    ['MAX_STALE_RESTARTS_PER_ISSUE', '1'],
    ['MAX_COMMENTS_PER_PREDECESSOR', '5'],
    ['MAX_SNAPSHOT_TEXT_BYTES', '8000'],
    ['MAX_CHANGED_PATHS_PER_PREDECESSOR', '100'],
    ['MAX_MANAGED_REGION_BYTES', '16000'],
  ];

  test.each(CONSTANTS)('pins %s at its documented default %s', (name, value) => {
    const row = RAW.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));
    expect(row).toBeDefined();
    expect(row.split('|')[2].trim()).toBe(value);
  });

  test('session config may only lower the constants', () => {
    expect(doc).toMatch(/Session configuration may only \*\*lower\*\* these; the table is the maximum/);
  });

  test('rejects a configured 0 for the six limits that would leave no next action', () => {
    expect(doc).toMatch(
      /A configured value of `0` is rejected at session load for `MAX_PREDECESSORS_PER_REFINEMENT`, `MAX_REFINEMENT_ROUNDS_PER_ISSUE`, `MAX_MALFORMED_ATTEMPTS_PER_ROLE`, `MAX_SNAPSHOT_TEXT_BYTES`, `MAX_CHANGED_PATHS_PER_PREDECESSOR`, and `MAX_MANAGED_REGION_BYTES`/,
    );
    expect(doc).toMatch(
      /`MAX_STALE_RESTARTS_PER_ISSUE`, `MAX_COMMENTS_PER_PREDECESSOR`, and `MAX_AGENT_FAILURES_PER_ROLE` accept `0`/,
    );
    expect(doc).toMatch(
      /a first agent process failure then escalates immediately, which is still a defined next action/,
    );
  });

  // The two role re-run self-loops do not spend a round, so the round cap
  // alone does not bound them; each carries its own per-role counter.
  test('caps the two self-loops that re-run a role without spending a round', () => {
    expect(doc).toMatch(
      /the two self-loops that re-run a role without spending a round carry their own per-role caps — `MAX_MALFORMED_ATTEMPTS_PER_ROLE` for malformed output \(§12, rows 12 and 20\) and `MAX_AGENT_FAILURES_PER_ROLE` for a retryable agent process failure \(§12, rows 38 and 40\)/,
    );
  });

  test('argues why the lane cannot become an unbounded AI debate', () => {
    expect(doc).toMatch(/\*\*Why this cannot become an unbounded AI debate\.\*\*/);
    expect(doc).toMatch(
      /There is no cycle in the transition table of §12 whose edges do not each increment a bounded counter/,
    );
    // The cycles a counter does not bound are the two hold self-loops (which
    // run no agent at all) and the operator recovery edge, whose argument
    // survives only because no automation can take it.
    expect(doc).toMatch(
      /with exactly two exceptions, neither of which runs an agent: the hold self-loops that only re-evaluate on the next poll \(row 4 before refinement, row 34 after activation\), which perform no work at all; and the operator recovery edge out of `escalated_human` \(row 36\), which no automation can take/,
    );
    // Both stale paths — enqueue-time and dispatch-time — share one counter, so
    // adding the second check cannot double the restart budget.
    expect(doc).toMatch(
      /themselves capped by the single `MAX_STALE_RESTARTS_PER_ISSUE` counter shared by the enqueue-time check, the dispatch-time fingerprint precondition, and the dispatch-time managed-region precondition \(§12, rows 23, 26, and 43\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Applicable vs advisory, topology fail-closed
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — applicable and advisory changes', () => {
  test('the applicable set is exactly the managed-region body content', () => {
    expect(doc).toMatch(
      /the refined summary, acceptance criteria, test plan, risks, implementation notes, and the predecessor references that justify them\. Nothing else/,
    );
  });

  test('topology and metadata changes are advisory only', () => {
    expect(doc).toMatch(
      /Issue splitting, dependency addition\/removal\/rewiring, supersession, unresolved questions, and the refiner's self-reported `confidence`/,
    );
    expect(doc).toMatch(
      /labels, milestones, assignees, Issue state, chain membership, chain revision, and frozen prefixes/,
    );
    expect(doc).toMatch(
      /holds no write path to GitHub Issue Relationships or to the chain registry, and an implementation must not give it one/,
    );
  });

  // §1 says every refiner-result field belongs to exactly one change class, so
  // the one field that proposes no change still needs a class — otherwise an
  // implementer has no contract for whether to persist, publish, or drop it.
  test('classifies the refiner confidence field rather than leaving it unclassed', () => {
    expect(RAW).toContain('"confidence": "low | medium | high"  // advisory — self-assessment (§9)');
    expect(doc).toMatch(
      /`confidence` is a self-assessment, classified `advisory` in §9 like every other non-body field/,
    );
    expect(doc).toMatch(
      /no guard in §12 branches on it: a `low`-confidence draft is neither rejected, down-weighted, nor escalated on that basis/,
    );
    expect(doc).toMatch(/\*\*`confidence` is classified, not exempt\.\*\*/);
    expect(doc).toMatch(
      /`confidence` is persisted on the task context \(§15\) and published as a literal in the audit comment \(§16\), it is never written into the Issue body, and no guard in §12 reads it/,
    );
    // And the two sections it names actually carry it.
    expect(doc).toMatch(/the refiner's and critic's `confidence` literals/);
    expect(doc).toMatch(
      /the critic's verdict literal, and both roles' `confidence` literals/,
    );
  });

  test('the runner never performs a topology change', () => {
    expect(doc).toMatch(/\*\*Topology proposals fail closed\.\*\*/);
    expect(doc).toMatch(/The runner never performs a topology change/);
  });

  test('an advisory-only proposal set still applies and activates', () => {
    expect(doc).toMatch(
      /With every proposal `advisory`, refinement proceeds: the body is applied/,
    );
    expect(doc).toMatch(/recommendations for a human/);
  });

  test('any blocking proposal fails closed to handoff with nothing applied', () => {
    expect(doc).toMatch(
      /With \*\*any\*\* proposal `blocking`, the run fails closed: nothing is applied, the Issue is not activated, `status:needs-refinement` stays/,
    );
    expect(doc).toMatch(/escalates with reason `topology_change_required`/);
  });
});

// ---------------------------------------------------------------------------
// Managed body region
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — managed body region', () => {
  test('defines the marker pair and its fingerprint attribute', () => {
    expect(RAW).toContain(
      '<!-- ai-refinement:begin fingerprint=<first 12 hex chars of predecessorFingerprint> -->',
    );
    expect(RAW).toContain('<!-- ai-refinement:end -->');
  });

  test('preserves everything outside the markers byte-for-byte', () => {
    expect(doc).toMatch(/\*\*Everything outside the markers is preserved byte-for-byte\.\*\*/);
    expect(doc).toMatch(/never performs a whole-body replacement/);
  });

  test('appends on first refinement and replaces in place afterwards', () => {
    expect(doc).toMatch(/On the first refinement the region is \*\*appended\*\* at the end of the body/);
    expect(doc).toMatch(/On a later refinement the existing region is \*\*replaced\*\* in place/);
  });

  test('renders the region from the structured result, not from pasted agent output', () => {
    expect(doc).toMatch(
      /rendered by the runner from the refiner's structured result, not pasted from agent output/,
    );
  });

  // The no-op has to be byte-for-byte: keying it on the fingerprint prefix
  // alone would let a redelivery skip over a region an operator had edited
  // since the lane wrote it.
  test('an identical region makes the update a no-op, but a matching prefix alone does not', () => {
    expect(doc).toMatch(/\*\*Idempotency, byte-for-byte\.\*\*/);
    expect(doc).toMatch(/the body update is a no-op and application continues to the next step/);
    expect(doc).toMatch(
      /A matching fingerprint in the begin marker is \*\*not\*\* sufficient on its own: a region carrying this attempt's fingerprint but different bytes was edited after the lane wrote it/,
    );
    expect(doc).toMatch(/the no-op is not taken and the rendered region/);
  });

  test('the region is excluded from the fingerprint it is written under', () => {
    expect(doc).toMatch(/\*\*The region is excluded from the fingerprint\.\*\*/);
    expect(doc).toMatch(
      /the lane's own write here cannot invalidate the effects that follow it, and a redelivery recomputes the same value/,
    );
    // And the exclusion is paid for rather than simply accepted.
    expect(doc).toMatch(
      /\*\*The exclusion is paid for by the region's own precondition\*\*/,
    );
    expect(doc).toMatch(
      /an edit inside the region between delivery and activation stops the attempt instead of riding through a check that deliberately cannot see it/,
    );
  });

  test('an unrecorded marker pair is untrusted and fails closed', () => {
    expect(doc).toMatch(/\*\*Trust rule\.\*\*/);
    expect(doc).toMatch(
      /A marker pair is trusted only when SQLite records a prior applied refinement for this Issue whose fingerprint prefix matches it/,
    );
    expect(doc).toMatch(/escalates with reason `unexpected_managed_region`/);
    expect(doc).toMatch(/a forged marker must not be able to steer what the runner overwrites/);
  });

  test('any malformed marker shape fails closed', () => {
    expect(doc).toMatch(
      /an unbalanced pair, more than one pair, nested pairs, or an end marker before a begin marker — escalates with reason `malformed_managed_region`/,
    );
  });
});

// ---------------------------------------------------------------------------
// Application and activation ordering
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — application and activation ordering', () => {
  test('the seven ordered steps appear in the normative order', () => {
    const section = RAW.split('## 11.')[1].split('## 12.')[0];
    const order = [
      '1. **Re-verify the fingerprint against live GitHub state**',
      '2. **Persist the accepted refinement in SQLite**',
      '3. **Update the Issue body**',
      '4. **Post the audit comment**',
      '5. **Transition labels last, removal before addition**',
      '6. **Park the shared task row for implementation, by reconciliation.**',
      '7. **Implementation is activated by ordinary intake, under its unchanged',
    ];
    let cursor = -1;
    for (const step of order) {
      const at = section.indexOf(step);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  // Step 5 moves two status labels and nothing else; step 7 then depends on the
  // agent label still being there, since that is the other half of the pair
  // `labelsToPhase` routes a new-implementation candidate on.
  test('the label transition leaves the agent label in place for the intake hand-back', () => {
    expect(doc).toMatch(
      /Only those two labels move: the Issue's `agent:\*` label is left exactly as the operator applied it \(§3, §14\), because it is the other half of the pair ordinary intake routes on at step 7/,
    );
    expect(doc).toMatch(
      /After step 5 the Issue carries the ordinary implementation pair — the `agent:\*` label it has carried since admission plus `status:needs-implementation` — which is exactly what `labelsToPhase` needs to produce a new-implementation candidate/,
    );
  });

  test('SQLite persistence is the commit point and nothing is GitHub-visible yet', () => {
    expect(doc).toMatch(/This is the commit point\. Nothing is GitHub-visible yet/);
  });

  // The freshness check guards the commit point rather than following it:
  // persisting first would leave an accepted record for a contract the very
  // next check discards, and row 22 encodes the same single ordering.
  test('freshness is verified before persistence, and §11 and row 22 agree on it', () => {
    expect(doc).toMatch(
      /\*\*Freshness is verified before persistence, and that is the single authoritative ordering\.\*\*/,
    );
    expect(doc).toMatch(
      /the live fingerprint check is the \*guard\* on the commit point, not a second look after it/,
    );
    expect(doc).toMatch(
      /Row 22 says the same thing — its guard is a matching live fingerprint and its effect is the persistence — and the two statements are one rule/,
    );
    expect(doc).toMatch(
      /A mismatch abandons the attempt here — before anything is persisted and before any mutation — and takes the stale path of rows 23\/24/,
    );
    expect(doc).toMatch(
      /the stale case \(rows 23\/24\) touches nothing at all — no accepted record, no stamped effect, no GitHub write/,
    );
    // The dispatch-time re-check is the same fingerprint, not a rival ordering.
    expect(doc).toMatch(
      /The dispatch-time re-check of §6 is not a third ordering: it is the same fingerprint evaluated again per effect/,
    );
    // §6 states the same sequencing from the fingerprint's side.
    expect(doc).toMatch(
      /\*\*recomputed from live GitHub state immediately before the commit point of §11\*\* — step 1, which precedes both the persistence of step 2 and the first GitHub mutation of step 3/,
    );
  });

  test('the label transition is last, and explains why', () => {
    expect(doc).toMatch(
      /the label is the only thing that makes the Issue implementable, so it goes last/,
    );
    expect(doc).toMatch(
      /a crash after an early label transition would hand an unrefined body to implementation/,
    );
  });

  test('activation goes through ordinary intake, not a bypassing enqueue', () => {
    expect(doc).toMatch(
      /No new activation path, no change to the intake router, and no direct enqueue that bypasses the dependency gate/,
    );
    expect(doc).toMatch(
      /when Gate 1 \(every `blocked by` Issue satisfied\) or Gate 2 \(exactly one open unsatisfied blocker, stack-ready\) admits it, intake enqueues the implementation phase/,
    );
  });

  // Eligibility (§4) admits fan-in shapes Gate 2 does not, so activation cannot
  // promise an immediate start — the parked row waits, and the wait is
  // specified rather than left to be discovered as a stall.
  test('activation is a handover, and the fan-in wait after it is specified', () => {
    expect(doc).toMatch(/\*\*Activation is a lane handover, not a start guarantee\.\*\*/);
    expect(doc).toMatch(
      /An Issue refined against two or more predecessors that are all still open therefore reaches `activated` with its parked row still `blocked`/,
    );
    expect(doc).toMatch(/That is the specified state, not a stall/);
    expect(doc).toMatch(
      /every later poll re-evaluates it against the same gates \(§12, row 34\)\. No counter advances, no agent runs, and nothing is re-refined/,
    );
    expect(doc).toMatch(
      /until exactly one open blocker remains and Gate 2 admits it as stack-ready\. Then row 33 fires and implementation starts/,
    );
    // The wait does not re-open refinement; that limitation is G1, not a new
    // revalidation path invented here.
    expect(doc).toMatch(
      /The refinement is \*\*not\*\* revalidated while it waits/,
    );
    expect(doc).toMatch(/that limitation is gap G1/);
    // And it is honest that the wait is unbounded, rather than implying a timeout.
    expect(doc).toMatch(
      /Refinement deliberately adds no timeout and no escalation here/,
    );
  });

  test('steps 3-5 are idempotent under the fingerprint for at-least-once delivery', () => {
    expect(doc).toMatch(
      /Steps 3–5 are each idempotent under the `predecessorFingerprint`, so at-least-once outbox delivery is safe/,
    );
  });

  // Label additions and removals are separate outbox effects, so "remove the
  // marker and add the executable status" needs an explicit delivery order:
  // add-first would put the Issue in the both-markers state §3 refuses, and
  // today's router admits that state to implementation.
  test('the label transition is an atomic replacement or removal-before-addition', () => {
    expect(doc).toMatch(
      /\*\*The label transition is an atomic replacement, or a removal observed sent before the addition is enqueued\.\*\*/,
    );
    expect(doc).toMatch(
      /The existing outbox models label changes as two separate effects \(`gh:label:remove`, `gh:label:add`\), which by themselves fix no delivery order/,
    );
    expect(doc).toMatch(
      /a single atomic label-replacement effect when the provider offers one/,
    );
    expect(doc).toMatch(
      /the \*\*removal\*\* enqueued first and observed as sent before the \*\*addition\*\* is enqueued at all/,
    );
    expect(doc).toMatch(
      /Delivering the addition first would leave the Issue carrying both markers — the state §3 refuses outright — and today's router would admit it to implementation instead of refusing it/,
    );
  });

  test('the no-marker window left by removal-first is inert and crash-safe', () => {
    expect(doc).toMatch(
      /The opposite window, an Issue carrying neither marker, is inert/,
    );
    expect(doc).toMatch(
      /an intake poll landing in that window finds nothing to admit/,
    );
    expect(doc).toMatch(
      /A crash in that window is recovered by the outbox's at-least-once delivery of the still-pending addition, whose marker precondition \(§6\) is satisfied precisely because the removal already landed/,
    );
  });

  test('the ordering is a property of delivery, with one stage in flight at a time', () => {
    expect(doc).toMatch(/\*\*Steps 3–5 are dispatched, not merely enqueued\.\*\*/);
    expect(doc).toMatch(/\*\*One stage in flight at a time\.\*\*/);
    expect(doc).toMatch(
      /The effect for stage N\+1 is enqueued only once stage N's row is observed as sent; the label removal and the label addition are two stages for this purpose/,
    );
    expect(doc).toMatch(
      /a body-update row that exhausted its attempts while the label row succeeded would activate an unrefined Issue/,
    );
  });

  test('a stale precondition at dispatch stops the remaining effects', () => {
    expect(doc).toMatch(/\*\*Every effect is precondition-checked at dispatch\*\*/);
    expect(doc).toMatch(
      /on mismatch it performs nothing and stops every still-undelivered effect of the attempt \(§12, rows 25–27\)/,
    );
    expect(doc).toMatch(
      /A body region already written under the previous fingerprint is left in place/,
    );
  });

  // The fingerprint is not the only dispatch precondition: the label effects
  // carry marker preconditions too, and a failed one must end the attempt
  // rather than leave the task in `applying`.
  test('a failed marker precondition at dispatch ends the attempt at handoff', () => {
    expect(doc).toMatch(
      /\*\*A label effect whose marker precondition no longer holds ends the attempt at handoff\.\*\*/,
    );
    expect(doc).toMatch(
      /an operator applies a \*different\* executable `status:\*` label in the window between the removal landing and the addition dispatching/,
    );
    expect(doc).toMatch(
      /the task escalates with reason `marker_precondition_failed` \(§12, row 42\) rather than remaining in `applying` with the transition half done/,
    );
    expect(doc).toMatch(
      /an effect whose end state already holds — marker already absent, or the very status this attempt adds already present — is satisfied \(§6\)/,
    );
  });

  // The fingerprint elides the managed region, so without a second check every
  // post-body-write effect would be delivered against whatever the region says
  // by then — including an operator's edit inside it.
  test('effects enqueued after the body update also check the region they were approved against', () => {
    expect(doc).toMatch(
      /\*\*An effect enqueued after the body update also checks the region it was approved against\.\*\*/,
    );
    expect(doc).toMatch(
      /it cannot see an edit made \*inside\* the region after step 3 delivered/,
    );
    expect(doc).toMatch(
      /the dispatcher re-derives that digest from the live body immediately before performing the effect/,
    );
    expect(doc).toMatch(
      /re-snapshotting below the stale cap \(§12, row 43\) or escalating `managed_region_modified` at it \(§12, row 44\)/,
    );
    expect(doc).toMatch(
      /Activation therefore cannot complete for a region the critic did not pass/,
    );
  });

  // The label write is external, so no transaction can span it and the park;
  // the crash between them has to be repaired from a durable record or the
  // Issue is implementable by label and unstartable in fact.
  test('the park is reconciled from a durable record rather than transacted with delivery', () => {
    expect(doc).toMatch(
      /\*\*The park is reconciled from a durable record, never assumed\.\*\*/,
    );
    expect(doc).toMatch(
      /Steps 5 and 6 cannot be one transaction: step 5 is an external write, and no SQLite transaction can span it/,
    );
    expect(doc).toMatch(
      /the Issue already carries `status:needs-implementation` while the shared row is still `applying` at phase `refinement`/,
    );
    expect(doc).toMatch(
      /it cannot take the blocked-task reactivation path of row 33, because the row is not parked/,
    );
    expect(doc).toMatch(
      /Reconciliation runs before intake evaluation within the same poll/,
    );
    expect(doc).toMatch(
      /Reconciliation is driven by the outbox row's durable `sent` state rather than by anything held in memory/,
    );
    expect(doc).toMatch(
      /Without a durable reconciliation the window would be permanent rather than transient/,
    );
    expect(doc).toMatch(
      /an Issue implementable by label and unstartable in fact, with no automatic exit and no handoff to tell an operator it needs one/,
    );
    // And the reconciliation is a required extension, not an assumed capability.
    expect(doc).toMatch(
      /today's dispatcher can mark its row sent and nothing more, so this contract cannot assume the park happens with it/,
    );
    // Step 6 itself says the same, and names the single transaction it needs.
    expect(doc).toMatch(
      /performs in \*\*one TaskStore transaction\*\* the state move to `activated` and/,
    );
    expect(doc).toMatch(
      /The transaction is compare-and-set on the row still being this lane's/,
    );
    expect(doc).toMatch(
      /The pass runs \*\*at the start of every poll, before intake evaluates any Issue\*\*/,
    );
  });

  test('an undeliverable effect fails closed rather than half-applying', () => {
    expect(doc).toMatch(/\*\*An undeliverable effect fails closed\.\*\*/);
    expect(doc).toMatch(
      /escalates with reason `effect_undeliverable` \(§12, row 32\); no later \*\*application\*\* stage is enqueued/,
    );
    // The prohibition covers steps 3–5 only: the handoff's own notification must
    // still be deliverable when the effect that dead-lettered was the audit
    // comment, or §13/§16's "exactly one comment per handoff" has no path.
    expect(doc).toMatch(/"Application stage" means steps 3–5 only/);
    expect(doc).toMatch(
      /The handoff's own effects — the ready-for-human label and the one public comment §13 requires — are \*not\* application stages and are always enqueued, including when the effect that dead-lettered was the audit comment of step 4/,
    );
    expect(doc).toMatch(
      /They are new outbox rows with their own fresh retry budget, and they carry \*\*no\*\* fingerprint, marker, or `appliedRegionDigest` precondition/,
    );
  });

  test('activation parks the shared task row so ordinary intake reactivates it', () => {
    expect(doc).toMatch(
      /the park of the shared task row \(§14\) at status `blocked`, phase `implementation`, with `context\.assignment` untouched/,
    );
    expect(doc).toMatch(/\*\*Why the parked row rather than a fresh task\.\*\*/);
    expect(doc).toMatch(
      /an existing row makes ordinary intake's enqueue a duplicate/,
    );
    expect(doc).toMatch(
      /it is the identical hold-and-reactivate shape a dependency-held implementation task already uses \(issue #224\)/,
    );
    expect(doc).toMatch(
      /Activation is therefore complete only when the label transition \*\*and\*\* the park have both committed/,
    );
  });

  // Step 3 has no topic in today's outbox, so the step says so instead of
  // reading as if it could be enqueued now.
  test('the body-update step names the outbox extension it needs', () => {
    expect(doc).toMatch(
      /through the body-update effect §18 requires the outbox to gain\. No existing outbox topic can perform this step/,
    );
    expect(doc).toMatch(
      /by the dispatcher extension §18 requires — the current dispatcher performs a claimed row unconditionally/,
    );
  });

  test('the successful path requires no human action before implementation', () => {
    expect(doc).toMatch(/\*\*No human action is required anywhere in steps 1–7\.\*\*/);
    expect(doc).toMatch(/the first and only human decision is the PR merge/);
    expect(doc).toMatch(
      /The fan-in wait above is no exception: it waits on the chain, never on a human, and needs no operator action to leave/,
    );
  });
});

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — transition table', () => {
  const rows = RAW.split('\n')
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      return {
        num: Number(cells[0]),
        state: cells[1].replace(/`/g, ''),
        event: cells[2].replace(/`/g, ''),
        guard: cells[3],
        next: cells[4].replace(/`/g, ''),
        effect: cells[5],
      };
    });

  test('names the one (state, event) pair whose guards are not mutually exclusive', () => {
    expect(doc).toMatch(
      /Guards for the same \(state, event\) pair are mutually exclusive, with one deliberate exception/,
    );
    expect(doc).toMatch(
      /§4's ordered guard list decides between them — rows 7, 5, 6, then 4, then 3, first match wins/,
    );
    expect(doc).toMatch(
      /so that the hold can never pre-empt a required handoff/,
    );
  });

  test('has 47 rows numbered contiguously from 1', () => {
    expect(rows).toHaveLength(47);
    expect(rows.map((r) => r.num)).toEqual(Array.from({ length: 47 }, (_, i) => i + 1));
  });

  // Rows are appended, never renumbered, because this document and its
  // follow-up Issues cite row numbers throughout.
  test('states that row order is presentational and numbering is stable', () => {
    expect(doc).toMatch(
      /Row order is presentational; the normative content of a row is its \(state, event, guard\) triple and its successor/,
    );
    expect(doc).toMatch(
      /Rows 38–42 belong to the `drafting`, `critiquing`, and `applying` states and are appended rather than inserted so that the row numbers this document, its tests, and its follow-up Issues already cite stay stable/,
    );
    expect(doc).toMatch(
      /Rows 43–45 belong to `applying` and were appended for the same reason: rows 43 and 44 are the managed-region precondition of §6, and row 45 is the activation reconciliation of §11 step 6, which row 31 no longer performs itself/,
    );
    expect(doc).toMatch(
      /Row 46 was appended for the same reason again: it is the one shape in which a handoff cannot deliver the public comment §13 and §16 otherwise require of it/,
    );
    expect(doc).toMatch(
      /Row 47 was appended for the same reason once more: it is the second admission refusal of §4 condition 1, and it sits beside row 2 rather than replacing it because the two failures are repaired by opposite label edits/,
    );
  });

  const EXPECTED = [
    [1, 'pending', 'intake.scanned', 'pending'],
    [2, 'pending', 'intake.scanned', 'pending'],
    [3, 'pending', 'predecessors.resolved', 'eligible'],
    [4, 'pending', 'predecessors.resolved', 'pending'],
    [5, 'pending', 'predecessors.resolved', 'escalated_human'],
    [6, 'pending', 'predecessors.resolved', 'escalated_human'],
    [7, 'pending', 'predecessors.resolved', 'escalated_human'],
    [8, 'eligible', 'roles.resolved', 'eligible'],
    [9, 'eligible', 'roles.resolved', 'escalated_human'],
    [10, 'eligible', 'snapshot.captured', 'drafting'],
    [11, 'drafting', 'draft.returned', 'critiquing'],
    [12, 'drafting', 'draft.returned', 'drafting'],
    [13, 'drafting', 'draft.returned', 'escalated_human'],
    [14, 'critiquing', 'critique.returned', 'accepted'],
    [15, 'critiquing', 'critique.returned', 'accepted'],
    [16, 'critiquing', 'critique.returned', 'escalated_human'],
    [17, 'critiquing', 'critique.returned', 'drafting'],
    [18, 'critiquing', 'critique.returned', 'escalated_human'],
    [19, 'critiquing', 'critique.returned', 'escalated_human'],
    [20, 'critiquing', 'critique.returned', 'critiquing'],
    [21, 'critiquing', 'critique.returned', 'escalated_human'],
    [22, 'accepted', 'apply.requested', 'applying'],
    [23, 'accepted', 'apply.requested', 'eligible'],
    [24, 'accepted', 'apply.requested', 'escalated_human'],
    [25, 'applying', 'effect.precondition.checked', 'applying'],
    [26, 'applying', 'effect.precondition.checked', 'eligible'],
    [27, 'applying', 'effect.precondition.checked', 'escalated_human'],
    [28, 'applying', 'body.update.attempted', 'applying'],
    [29, 'applying', 'body.update.attempted', 'escalated_human'],
    [30, 'applying', 'comment.posted', 'applying'],
    [31, 'applying', 'labels.transitioned', 'applying'],
    [32, 'applying', 'effect.dead_lettered', 'escalated_human'],
    [33, 'activated', 'intake.scanned', 'activated'],
    [34, 'activated', 'intake.scanned', 'activated'],
    [35, 'activated', 'any other event', 'activated'],
    [36, 'escalated_human', 'operator.recovery.applied', 'pending'],
    [37, 'escalated_human', 'any other event', 'escalated_human'],
    [38, 'drafting', 'agent.process.failed', 'drafting'],
    [39, 'drafting', 'agent.process.failed', 'escalated_human'],
    [40, 'critiquing', 'agent.process.failed', 'critiquing'],
    [41, 'critiquing', 'agent.process.failed', 'escalated_human'],
    [42, 'applying', 'effect.precondition.checked', 'escalated_human'],
    [43, 'applying', 'effect.precondition.checked', 'eligible'],
    [44, 'applying', 'effect.precondition.checked', 'escalated_human'],
    [45, 'applying', 'activation.reconciled', 'activated'],
    [46, 'escalated_human', 'handoff.comment.dead_lettered', 'escalated_human'],
    [47, 'pending', 'intake.scanned', 'pending'],
  ];

  test.each(EXPECTED)('row %i: %s + %s -> %s', (num, state, event, next) => {
    const row = rows.find((r) => r.num === num);
    expect(row.state).toBe(state);
    expect(row.event).toBe(event);
    expect(row.next).toBe(next);
  });

  test('every state named in a row belongs to the declared vocabulary', () => {
    const STATES = new Set([
      'pending',
      'eligible',
      'drafting',
      'critiquing',
      'accepted',
      'applying',
      'activated',
      'escalated_human',
    ]);
    for (const row of rows) {
      expect(STATES.has(row.state)).toBe(true);
      expect(STATES.has(row.next)).toBe(true);
    }
  });

  test('operator recovery is the only row that leaves a terminal state', () => {
    const leaving = rows.filter(
      (r) => (r.state === 'activated' || r.state === 'escalated_human') && r.next !== r.state,
    );
    expect(leaving.map((r) => r.num)).toEqual([36]);
    expect(leaving[0].event).toBe('operator.recovery.applied');
    expect(leaving[0].next).toBe('pending');
    expect(doc).toMatch(
      /row 36 is the operator recovery command of §13 — the single edge in this table that no automation can take/,
    );
  });

  test('the requeue and hold rows keep the refinement state terminal', () => {
    expect(doc).toMatch(
      /row 33 keeps the state `activated` and moves only the shared \*\*task row\*\* into the implementation lane/,
    );
    expect(doc).toMatch(
      /row 34 keeps the state `activated` and leaves that row parked while the unchanged dependency gates still hold the Issue \(§11\)/,
    );
  });

  test('row 2 refuses admission without creating a task', () => {
    const row = rows.find((r) => r.num === 2);
    expect(row.guard).toMatch(/marker present with an executable `status:\*`/);
    expect(row.effect).toMatch(/refuse admission; no task/);
    expect(row.effect).toMatch(/conflicting_markers/);
  });

  // The two admission refusals are repaired by opposite label edits (remove an
  // executable status vs. add an agent label), so neither can stand in for the
  // other and rows 1/2/47 must stay mutually exclusive on the agent-label
  // clause.
  test('rows 1 and 47 split admission on the implementation agent label', () => {
    const admit = rows.find((r) => r.num === 1);
    expect(admit.guard).toMatch(/at least one implementation-lane `agent:\*` label/);
    const refuse = rows.find((r) => r.num === 47);
    expect(refuse.guard).toMatch(/no executable `status:\*`/);
    expect(refuse.guard).toMatch(/no implementation-lane `agent:\*` label/);
    expect(refuse.effect).toMatch(/refuse admission; no task/);
    expect(refuse.effect).toMatch(/no_implementation_agent/);
    expect(refuse.effect).toMatch(/re-evaluated next poll/);
  });

  test('row 4 holds the Issue for the next poll instead of escalating', () => {
    const row = rows.find((r) => r.num === 4);
    // The hold is subordinate to the three handoff guards; without that
    // exclusion it would also match an over-cap or chain-disagreeing Issue.
    expect(row.guard).toMatch(/rows 5–7 do not apply/);
    expect(row.effect).toMatch(/hold/);
    expect(row.effect).toMatch(/predecessor_not_ready/);
    expect(row.effect).toMatch(/re-evaluated next poll/);
  });

  test('row 9 escalates when no independent critic can be selected', () => {
    const row = rows.find((r) => r.num === 9);
    expect(row.guard).toMatch(/no independent critic can be selected/);
    expect(row.effect).toMatch(/no_independent_critic/);
    expect(row.effect).toMatch(/no snapshot captured, no round spent/);
  });

  test('row 16 applies nothing when a topology proposal is blocking', () => {
    const row = rows.find((r) => r.num === 16);
    expect(row.guard).toMatch(/`pass`, any proposal `blocking`/);
    expect(row.effect).toMatch(/topology_change_required/);
    expect(row.effect).toMatch(/nothing applied/);
  });

  test('row 22 names its own audit event for the accepted-to-applying commit', () => {
    const row = rows.find((r) => r.num === 22);
    expect(row.effect).toMatch(/persist the accepted refinement \(commit point\)/);
    expect(row.effect).toMatch(/stamp the fingerprint precondition on the attempt's effects/);
    expect(row.effect).toMatch(/refinement\.accepted\.persisted/);
    // The later body write keeps its own distinct event, so neither row borrows
    // the other's name.
    expect(rows.find((r) => r.num === 28).effect).toMatch(/refinement\.applied/);
  });

  test('row 23 discards the draft and re-snapshots on a stale fingerprint', () => {
    const row = rows.find((r) => r.num === 23);
    expect(row.effect).toMatch(/discard the draft/);
    expect(row.effect).toMatch(/refinement\.stale\.detected/);
    expect(row.effect).toMatch(/re-snapshot/);
  });

  test('rows 26 and 27 stop undelivered effects when the dispatch precondition fails', () => {
    const restart = rows.find((r) => r.num === 26);
    expect(restart.guard).toMatch(/fingerprint differs, restarts below `MAX_STALE_RESTARTS_PER_ISSUE`/);
    expect(restart.effect).toMatch(/perform nothing/);
    expect(restart.effect).toMatch(/stop every still-undelivered effect of this attempt/);
    const capped = rows.find((r) => r.num === 27);
    expect(capped.guard).toMatch(/fingerprint differs, restarts at cap/);
    expect(capped.effect).toMatch(/perform nothing/);
    expect(capped.effect).toMatch(/stale_inputs/);
  });

  test('row 31 is the only row that adds the executable implementation label', () => {
    const adding = rows.filter((r) => /status:needs-implementation`/.test(r.effect));
    expect(adding.map((r) => r.num)).toEqual([31]);
    expect(adding[0].effect).toMatch(/remove `status:needs-refinement`/);
  });

  // Delivering the label is not activating: the park is a separate local
  // transaction that cannot ride inside an external write, so row 31 stays in
  // `applying` and row 45 is what commits activation.
  test('row 31 delivers the labels but leaves activation to the reconciliation of row 45', () => {
    const row = rows.find((r) => r.num === 31);
    expect(row.next).toBe('applying');
    expect(row.effect).toMatch(
      /the delivered addition's outbox row, durably `sent`, is the record row 45 reconciles from; the state does not move here/,
    );
    const parking = rows.filter((r) => /park the shared task row/.test(r.effect));
    expect(parking.map((r) => r.num)).toEqual([45]);
  });

  test('row 45 parks the row and moves the state in one compare-and-set transaction', () => {
    const row = rows.find((r) => r.num === 45);
    expect(row.event).toBe('activation.reconciled');
    expect(row.guard).toMatch(
      /the attempt's final label effect is durably recorded `sent` \(§11 step 6\)/,
    );
    expect(row.effect).toMatch(
      /in one TaskStore transaction, compare-and-set on the row still being this lane's/,
    );
    expect(row.effect).toMatch(
      /park the shared task row at `blocked`\/phase `implementation` with `context\.assignment` untouched, and move the refinement state to `activated`/,
    );
    expect(row.effect).toMatch(/a repeated pass is a no-op/);
    expect(row.effect).toMatch(/refinement\.activated/);
  });

  // An edit inside the managed region is invisible to the fingerprint by
  // design, so it needs rows of its own or activation would complete against
  // content no critic passed.
  test('rows 43 and 44 stop the attempt when the managed region no longer matches', () => {
    const restart = rows.find((r) => r.num === 43);
    expect(restart.guard).toMatch(
      /the live managed region does not equal the effect's stamped `appliedRegionDigest` — edited, replaced, deleted, or made malformed after step 3 delivered/,
    );
    expect(restart.guard).toMatch(/stale restarts are below `MAX_STALE_RESTARTS_PER_ISSUE`/);
    expect(restart.effect).toMatch(/perform nothing/);
    expect(restart.effect).toMatch(/stop every still-undelivered effect of this attempt/);
    expect(restart.effect).toMatch(/re-snapshot/);
    const capped = rows.find((r) => r.num === 44);
    expect(capped.guard).toMatch(/the same region mismatch, stale restarts at cap/);
    expect(capped.effect).toMatch(/perform nothing/);
    expect(capped.effect).toMatch(/managed_region_modified/);
  });

  test('row 31 fixes the label delivery order rather than leaving it to the dispatcher', () => {
    const row = rows.find((r) => r.num === 31);
    expect(row.guard).toMatch(
      /atomic replacement, or the marker removal observed sent before the addition was enqueued/,
    );
    expect(row.guard).toMatch(/marker preconditions hold \(§6\)/);
    expect(row.effect).toMatch(
      /remove `status:needs-refinement`, then add `status:needs-implementation`, in that delivery order/,
    );
  });

  test('row 32 escalates an undeliverable effect instead of stalling', () => {
    const row = rows.find((r) => r.num === 32);
    expect(row.guard).toMatch(/exhausted its retry budget or was cancelled by an operator/);
    expect(row.effect).toMatch(/effect_undeliverable/);
    expect(row.effect).toMatch(/no later \*\*application\*\* stage \(steps 3–5\) is enqueued/);
    expect(row.effect).toMatch(
      /the handoff's own ready-for-human label and comment are enqueued as fresh, precondition-free effects even when the dead-lettered effect was the audit comment/,
    );
  });

  // Without row 46 the contract would require a handoff comment it has no way
  // to deliver once the comment topic itself dead-letters.
  test('row 46 lets a handoff stand when its own comment cannot be delivered', () => {
    const row = rows.find((r) => r.num === 46);
    expect(row.guard).toMatch(
      /the handoff's own public comment exhausted its retry budget or was cancelled/,
    );
    expect(row.effect).toMatch(
      /the handoff stands on its local record — status `ready_for_human`, the persisted reason, and `refinement\.escalated\.human` — with no comment/,
    );
    expect(row.effect).toMatch(/refinement\.handoff\.comment\.undeliverable/);
    expect(row.effect).toMatch(/no replacement comment is attempted/);
    expect(doc).toMatch(
      /Row 46 likewise stays inside `escalated_human`: it records that a handoff's comment could not be delivered, and changes no state/,
    );
  });

  test('row 33 requeues the parked task row into the implementation lane', () => {
    const row = rows.find((r) => r.num === 33);
    expect(row.guard).toMatch(
      /the shared task row is parked `blocked` at phase `implementation`/,
    );
    // Reactivation is conditional on the intake gates, which refinement does
    // not widen — an allowed multi-predecessor fan-in is not admitted here.
    expect(row.guard).toMatch(
      /the unchanged intake dependency gates admit it \(Gate 1, or Gate 2's single open stack-ready blocker\)/,
    );
    expect(row.effect).toMatch(
      /reactivate the parked row to `queued` at phase `implementation` through the existing blocked-task reactivation path/,
    );
    expect(row.effect).toMatch(/refinement\.implementation\.requeued/);
  });

  test('row 34 keeps the row parked while the unchanged gates still hold it', () => {
    const row = rows.find((r) => r.num === 34);
    expect(row.guard).toMatch(
      /the unchanged gates do not admit the Issue yet — more than one unsatisfied blocker, or a single open blocker that is not stack-ready/,
    );
    expect(row.effect).toMatch(/leave the row parked and untouched/);
    expect(row.effect).toMatch(/refinement\.implementation\.held/);
    expect(row.effect).toMatch(/re-evaluated next poll/);
  });

  test('row 35 makes a redelivered activation an idempotent no-op', () => {
    const row = rows.find((r) => r.num === 35);
    expect(row.effect).toMatch(/idempotent no-op/);
  });

  test('row 36 is the operator recovery back to pending', () => {
    const row = rows.find((r) => r.num === 36);
    expect(row.guard).toMatch(/an operator ran the §13 recovery command with `--yes`/);
    expect(row.effect).toMatch(/clear the handoff reason, the accepted draft, and the counters/);
    expect(row.effect).toMatch(/keep `context\.assignment`/);
    expect(row.effect).toMatch(/re-queue the row at phase `refinement`/);
  });

  // A timeout, a non-zero exit, or an exhausted quota is the most ordinary
  // runtime failure this lane will meet: it must retry a bounded number of
  // times and then land on a recoverable state, never on task status `failed`.
  test('rows 38 and 40 retry a role after a retryable process failure without spending a round', () => {
    for (const [num, role] of [[38, 'refiner'], [40, 'critic']]) {
      const row = rows.find((r) => r.num === num);
      expect(row.guard).toMatch(
        /the existing phase classification calls the failure retryable/,
      );
      expect(row.guard).toMatch(/below `MAX_AGENT_FAILURES_PER_ROLE`/);
      expect(row.effect).toMatch(new RegExp(`re-run the ${role} after the existing phase-level delay`));
      expect(row.effect).toMatch(/refinement\.agent\.failed/);
      expect(row.effect).toMatch(/no round and no malformed-attempt counter is spent/);
    }
  });

  test('rows 39 and 41 escalate a terminal process failure instead of failing the task', () => {
    for (const num of [39, 41]) {
      const row = rows.find((r) => r.num === num);
      expect(row.guard).toMatch(
        /the classification is non-retryable, or this role's process failures are at cap/,
      );
      expect(row.effect).toMatch(/agent_unavailable/);
      expect(row.effect).toMatch(/the task never reaches status `failed`/);
    }
  });

  // The removal can land while the addition is still queued; an operator who
  // applies a different executable status inside that window must not leave
  // the task stuck in `applying` with half a label transition delivered.
  test('row 42 escalates a failed marker precondition instead of stalling in applying', () => {
    const row = rows.find((r) => r.num === 42);
    expect(row.guard).toMatch(
      /live fingerprint matches, but a marker precondition of §6 does not hold and its end state is not already reached/,
    );
    expect(row.guard).toMatch(
      /an executable `status:\*` other than the one being added is on the Issue/,
    );
    expect(row.effect).toMatch(/perform nothing/);
    expect(row.effect).toMatch(/stop every still-undelivered effect of this attempt/);
    expect(row.effect).toMatch(/marker_precondition_failed/);
  });

  // Redelivery must not look like a precondition failure, or at-least-once
  // delivery of the label effects would escalate every retried activation.
  test('row 25 treats an effect whose end state already holds as satisfied', () => {
    const row = rows.find((r) => r.num === 25);
    expect(row.guard).toMatch(
      /every marker precondition of §6 either holds or has its end state already reached/,
    );
    // The region digest is the third precondition an effect can carry.
    expect(row.guard).toMatch(
      /the effect's stamped `appliedRegionDigest`, when it carries one, equals the live managed region/,
    );
    expect(row.effect).toMatch(/perform this effect, or nothing when its end state already holds/);
  });

  test('row 37 keeps human escalation terminal for automation', () => {
    const row = rows.find((r) => r.num === 37);
    expect(row.effect).toMatch(
      /terminal for automation; only an operator clears it, through row 36/,
    );
  });
});

// ---------------------------------------------------------------------------
// Human handoff
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — human handoff', () => {
  test('handoff is the single exceptional outcome and always does the same four things', () => {
    expect(doc).toMatch(/Handoff is the single exceptional outcome/);
    expect(doc).toMatch(
      /with exactly two documented exceptions: one to item 2, covering the handoffs named below, and one to item 4, covering the handoff whose own comment cannot be delivered/,
    );
    // The §3.1 guard escalates a task that never had a refinement state, so §13
    // has to say its shape is the same.
    expect(doc).toMatch(
      /The §3\.1 execution guard raises its `execution_marker_conflict` handoff in this same shape, on a task that never entered the §12 state machine/,
    );
    expect(doc).toMatch(/sets the task status to `ready_for_human`/);
    expect(doc).toMatch(
      /\*\*leaves `status:needs-refinement` in place\*\* and does \*\*not\*\* add any executable `status:\*` label/,
    );
    expect(doc).toMatch(/adds the session's ready-for-human label/);
    // The comment is a fresh effect, so whatever stopped the lane — including a
    // dead-lettered audit comment — cannot also stop the notification.
    expect(doc).toMatch(
      /through a fresh outbox effect with its own retry budget and no fingerprint, marker, or region precondition, so that whatever stopped the lane cannot also stop the notification that it stopped/,
    );
  });

  // §13 and §16 require one comment per handoff; the comment topic itself can
  // dead-letter, which is exactly the failure that raised the handoff. The
  // contract has to say which of the two requirements yields.
  test('a handoff stands even when its own comment is undeliverable', () => {
    expect(doc).toMatch(
      /\*\*The handoff stands even when its comment cannot be delivered\.\*\*/,
    );
    expect(doc).toMatch(
      /The \*\*load-bearing\*\* parts of a handoff are local and transactional — task status `ready_for_human`, the persisted handoff reason, and the `refinement\.escalated\.human` audit event/,
    );
    expect(doc).toMatch(
      /The public comment is \*\*required whenever GitHub accepts it\*\*, and it gets its own effect and its own full retry budget for that reason\. It is not a copy of the dead-lettered effect and does not inherit its exhausted budget/,
    );
    expect(doc).toMatch(
      /If that comment effect \*also\* dead-letters, the handoff stands without it: the lane records `refinement\.handoff\.comment\.undeliverable` \(§12, row 46\) and \*\*attempts no replacement comment\*\*/,
    );
    expect(doc).toMatch(
      /Retrying a comment through the surface that just proved undeliverable is the one loop this contract will not enter/,
    );
    expect(doc).toMatch(
      /The ready-for-human label add is the same shape and the same disposition/,
    );
    expect(doc).toMatch(
      /Consequently §16's "exactly one comment per handoff" is an upper bound as well as the norm: exactly one when it can be delivered, none when the comment effect itself dead-letters, and never two/,
    );
  });

  test('no automatic transition leaves the escalated state', () => {
    expect(doc).toMatch(/No automatic transition leaves `escalated_human`/);
  });

  // The marker is gone by construction once the removal landed, so the handoff
  // has to say what keeps the Issue out of implementation instead of
  // pretending the label is still doing it.
  test('names the handoffs that cannot leave the marker in place', () => {
    expect(doc).toMatch(
      /\*\*A handoff raised after the marker removal landed cannot leave the marker in place, and says so\.\*\* `marker_precondition_failed` \(row 42\) is raised only after the removal effect of §11 step 5 has already landed/,
    );
    expect(doc).toMatch(
      /`stale_inputs` \(row 27\), `managed_region_modified` \(row 44\), and `effect_undeliverable` \(row 32\) reach the same shape whenever the effect that fails is the label addition rather than an earlier one/,
    );
    expect(doc).toMatch(
      /Every other handoff is raised before step 5 has moved any label, so item 2 above holds verbatim for it/,
    );
    expect(doc).toMatch(
      /re-adding it beside the executable status an operator applied by hand would produce exactly the both-markers combination §3 refuses/,
    );
    expect(doc).toMatch(
      /What keeps the Issue out of implementation in that window is the shared task row rather than the label — it survives at `ready_for_human`, phase `refinement`, so the next intake scan refuses the implementation enqueue as a duplicate/,
    );
    expect(doc).toMatch(
      /cancel the row and let the hand-applied status stand \(the skip path, whose label step is already done for them\), or restore the label shape and run the recovery command/,
    );
  });

  // Handoff leaves `status:needs-refinement` on the Issue, so "just add the
  // implementation label" would produce the both-markers state §3 refuses —
  // the manual skip has to replace the marker and clear the stranded row.
  test('the manual skip path replaces the marker instead of adding beside it', () => {
    expect(doc).toMatch(
      /\*\*Skipping refinement is a label _replacement_, not a label addition\.\*\*/,
    );
    expect(doc).toMatch(
      /adding an executable `status:\*` label beside it produces exactly the both-markers combination §3 refuses outright/,
    );
    expect(doc).toMatch(
      /\*\*Remove `status:needs-refinement` first, then add `status:needs-implementation`\*\* — the same removal-before-addition ordering §11 step 5 gives the automatic path/,
    );
    expect(doc).toMatch(
      /\*\*Dispose of the stranded refinement task row\*\* with `admin task cancel`/,
    );
    expect(doc).toMatch(
      /the next intake scan finds it and refuses the implementation enqueue as a duplicate/,
    );
    expect(doc).toMatch(
      /the refinement state of the cancelled row stays `escalated_human`/,
    );
  });

  test('explains why re-applying the marker cannot recover a handoff', () => {
    expect(doc).toMatch(/\*\*Recovery is an explicit command, because re-labelling cannot work\.\*\*/);
    expect(doc).toMatch(
      /it is already present and re-applying it changes nothing; the task row also still exists, so the next intake scan finds it and refuses the enqueue as a duplicate/,
    );
  });

  test('defines the operator recovery command and what it resets', () => {
    expect(RAW).toContain(
      'admin refinement recover --session-ref <ref> --issue-number <n> [--yes]',
    );
    expect(doc).toMatch(
      /status `ready_for_human`, phase `refinement`, `context\.refinement\.state` = `escalated_human`/,
    );
    expect(doc).toMatch(/It previews by default and applies only with `--yes`/);
    expect(doc).toMatch(/Applying it performs row 36/);
    expect(doc).toMatch(/the refinement state returns to `pending`/);
    expect(doc).toMatch(
      /\*\*`context\.assignment` is preserved, not re-resolved\*\* \(§14\)/,
    );
    expect(doc).toMatch(
      /a condition the operator did not actually fix simply escalates again/,
    );
  });

  // Recovery returns the state to `pending`, where an Issue carrying an
  // executable status is exactly what row 2 refuses — so the command has to
  // require the admissible label shape rather than re-enter a dead end.
  test('recovery requires the admissible label shape before it applies', () => {
    expect(doc).toMatch(
      /\*\*It applies only when the Issue carries the row-1 admissible label shape\*\* — `status:needs-refinement` present and no executable `status:\*` label/,
    );
    expect(doc).toMatch(
      /after a handoff raised once the removal had landed — `marker_precondition_failed` always, and `stale_inputs`, `managed_region_modified`, or `effect_undeliverable` when the failing effect was the label addition — the operator must first re-add the marker/,
    );
    expect(doc).toMatch(
      /applying against any other shape is refused rather than half-performed/,
    );
    expect(doc).toMatch(
      /an Issue that carries an executable status there is precisely what row 2 refuses to admit/,
    );
  });

  // Row 42 is reached only after the body write landed, so recovery must keep
  // the applied-refinement record or the retry would escalate
  // `unexpected_managed_region` against the lane's own managed region.
  test('recovery preserves the applied-refinement record that keeps the region trusted', () => {
    expect(doc).toMatch(
      /\*\*The record of the fingerprint actually applied is preserved too\*\* \(§6\)/,
    );
    expect(doc).toMatch(
      /Clearing that record would make the retry escalate `unexpected_managed_region` against the lane's own write, replacing one stuck state with another/,
    );
    // Row 36's effect cell says the same thing, so the table and the prose
    // cannot drift apart on it.
    expect(doc).toMatch(/keep `context\.assignment` and the applied-refinement record/);
  });

  test('offers no mid-lane resume, only a restart from pending', () => {
    expect(doc).toMatch(
      /There is deliberately no command that resumes a handoff mid-lane/,
    );
    expect(doc).toMatch(/Recovery restarts the attempt from `pending` or it does nothing/);
  });

  test('a predecessor failure holds at pending rather than being handled here', () => {
    expect(doc).toMatch(/Refinement never handles a predecessor failure/);
    expect(doc).toMatch(/the Issue holds at `pending` \(row 4\) until a human intervenes/);
  });

  test('a merged predecessor is not a failure and is not held', () => {
    expect(doc).toMatch(
      /A predecessor that \*\*merged\*\* is not a failure and is not held: it satisfies the merged shape of §4/,
    );
    expect(doc).toMatch(
      /never for one whose result was accepted into the base branch/,
    );
    expect(doc).toMatch(
      /The one predecessor shape that can still hold this lane indefinitely — a predecessor closed with its PR closed unmerged — is recorded as gap G5 in §21/,
    );
  });
});

// ---------------------------------------------------------------------------
// Assignment retention
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — assignment and profile retention', () => {
  test('context.assignment stays the source of truth', () => {
    expect(doc).toMatch(/\*\*`context\.assignment` is the source of truth\*\*/);
    expect(doc).toMatch(/resolved once when the refinement task is admitted \(row 1\)/);
  });

  test('the agent:* label names the implementation owner, not the refiner', () => {
    expect(doc).toMatch(
      /\*\*The `agent:\*` label on a refinement-marked Issue names the intended \*implementation\* owner\*\*, not the refiner/,
    );
    expect(doc).toMatch(/seed for `context\.assignment\.implementationAgent`/);
    expect(doc).toMatch(
      /It is \*\*required\*\* at admission and retained through activation \(§3, §4 condition 1\)/,
    );
    expect(doc).toMatch(
      /it is a hint for this lane, but it is a routing \*precondition\* for the ordinary intake pass that reactivates the parked row/,
    );
  });

  test('refiner and critic are profile roles, never labels', () => {
    expect(doc).toMatch(/`refinementAgent`, `refinementCriticAgent`/);
    expect(doc).toMatch(/They are never expressed as labels/);
  });

  test('activation moves the status labels only and leaves the agent label alone', () => {
    expect(doc).toMatch(
      /\*\*Activation neither adds nor removes an `agent:\*` label, and re-derives nothing\.\*\*/,
    );
    expect(doc).toMatch(
      /leaves the pre-existing `agent:\*` label untouched, so the Issue ends the lane carrying the ordinary implementation label pair/,
    );
    expect(doc).toMatch(/reads its owner from the persisted `context\.assignment`, never from that label/);
    // A label that disagrees with the pinned assignment must not silently
    // re-own the task: reactivation restores the pinned assignment.
    expect(doc).toMatch(
      /the label decides \*that\* the row is picked up, never \*who\* runs it/,
    );
  });

  test('the assignment captured at admission is carried forward, not re-resolved', () => {
    expect(doc).toMatch(
      /the assignment captured at admission is carried forward, not re-resolved from a possibly-edited `sessions\.json`/,
    );
  });

  test('the two phases hand over by park-and-reactivate, not by a second task row', () => {
    expect(doc).toMatch(
      /\*\*The handover between the two phases is the park-and-reactivate of §11 steps 6–7\*\*, not a second task row/,
    );
    expect(doc).toMatch(
      /the implementation phase reads the assignment resolved at row 1, even though intake re-resolved one of its own while scanning/,
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence, audit events, public comment
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — persistence and audit', () => {
  test('names the task-context block and the artifact root', () => {
    expect(doc).toMatch(/\*\*Task context\*\* \(`task\.context\.refinement`\)/);
    // The region digest is persisted state, not something re-derived at
    // dispatch from whatever the body then says.
    expect(doc).toMatch(
      /the `appliedRegionDigest` of the region this attempt rendered \(§6\)/,
    );
    expect(doc).toMatch(/`<artifactRoot>\/issue-refinement\/issue-<n>\/<runId>\/`/);
  });

  test('writes raw transcripts before parsing and never publishes artifact paths', () => {
    expect(doc).toMatch(/the raw refiner and critic transcripts written before parsing/);
    expect(doc).toMatch(
      /Artifact paths never appear in any GitHub comment or Issue body/,
    );
  });

  test('names audit events under one prefix and enumerates the vocabulary', () => {
    expect(doc).toMatch(/Audit events\*\* are named `refinement\.<subject>\.<action>`/);
    for (const event of [
      'refinement.eligibility.granted',
      'refinement.eligibility.refused',
      'refinement.roles.resolved',
      'refinement.accepted.persisted',
      'refinement.implementation.requeued',
      'refinement.implementation.held',
      'refinement.recovery.applied',
      'refinement.snapshot.captured',
      'refinement.draft.recorded',
      'refinement.draft.malformed',
      'refinement.critique.passed',
      'refinement.critique.revise',
      'refinement.critique.malformed',
      'refinement.topology.recorded',
      'refinement.stale.detected',
      'refinement.applied',
      'refinement.comment.posted',
      'refinement.activated',
      'refinement.escalated.human',
      'refinement.agent.failed',
      'refinement.execution.suspended',
      'refinement.handoff.comment.undeliverable',
    ]) {
      expect(doc).toContain(`\`${event}\``);
    }
  });

  // Both facts happen outside the §12 state machine, so without their own
  // events neither would be recorded anywhere.
  test('the two out-of-lane events are explained rather than left dangling', () => {
    expect(doc).toMatch(
      /`refinement\.execution\.suspended` records the pre-execution marker guard of §3\.1 stopping an already-existing executable task — that task carries no refinement state, so no §12 row could record it/,
    );
    expect(doc).toMatch(
      /`refinement\.handoff\.comment\.undeliverable` records a handoff whose public comment could not be delivered \(§12, row 46\)/,
    );
  });

  test('a process failure gets its own event rather than a malformed one', () => {
    expect(doc).toMatch(
      /`refinement\.agent\.failed` is likewise its own event because a process failure is a different fact from malformed output: rows 38 and 40 emit it when nothing was returned to parse/,
    );
  });

  test('no state-changing row has to share or borrow an event name', () => {
    expect(doc).toMatch(
      /`refinement\.accepted\.persisted` records the `accepted` → `applying` commit point \(row 22\), which is a different fact from `refinement\.applied` \(row 28, the body write\)/,
    );
    expect(doc).toMatch(
      /`refinement\.implementation\.requeued` records the handover of the shared task row \(row 33\)/,
    );
    // The hold has its own event so a long fan-in wait is observable rather
    // than looking like a lane that silently stopped.
    expect(doc).toMatch(
      /`refinement\.implementation\.held` records a poll that found the parked row still held by the unchanged dependency gates \(row 34\), which is what makes a long fan-in wait observable rather than silent/,
    );
    expect(doc).toMatch(
      /`refinement\.recovery\.applied` records the operator recovery \(row 36\)/,
    );
    // The activation event belongs to the transaction that commits the park,
    // not to the label delivery that precedes it.
    expect(doc).toMatch(
      /`refinement\.activated` belongs to the reconciliation of row 45 — the transaction that parks the shared task row and moves the state — not to the label delivery of row 31, which changes no state and emits nothing/,
    );
    expect(doc).toMatch(
      /emitting an activation event there would report an activation that had not yet committed/,
    );
  });

  test('audit events carry literals and counters only', () => {
    expect(doc).toMatch(
      /Events carry literals and counters only — never refined prose, snapshot content, agent reasoning, or local paths/,
    );
  });
});

describe('docs/issue-refinement-contract.md — public comment policy', () => {
  test('posts exactly one comment per applied refinement and per handoff', () => {
    expect(doc).toMatch(/Every applied refinement leaves exactly one auditable comment/);
    expect(doc).toMatch(/Every handoff leaves exactly one comment/);
    expect(doc).toMatch(/No other comment is posted by this lane/);
    // The one-comment rule names its own exception here too, so a reader of §16
    // alone cannot conclude a handoff comment is always deliverable.
    expect(doc).toMatch(
      /with the single exception §13 defines: when the handoff's own comment effect dead-letters the handoff stands with no comment at all \(§12, row 46\), and no replacement is attempted\. One or none, never two/,
    );
  });

  test('publishes source predecessor references and agent/model/effort metadata', () => {
    expect(doc).toMatch(
      /the source predecessor references — Issue numbers, PR numbers, and PR head SHAs/,
    );
    expect(doc).toMatch(
      /the agent id, model, and effort used for the refiner and for the critic/,
    );
  });

  test('publishes advisory topology proposals as explicitly not applied', () => {
    expect(doc).toMatch(
      /explicitly labelled as recommendations that were \*\*not\*\* applied/,
    );
  });

  test('never publishes local paths, identifiers, or snapshot content', () => {
    expect(doc).toMatch(
      /Never published: local filesystem paths, artifact paths, run\/session\/task identifiers, raw agent output, agent reasoning, provider error text, snapshot excerpts/,
    );
  });

  // Issue #936: §13 item 4 requires a handoff comment, but §16 used to bound
  // only the APPLIED-refinement one, leaving the handoff body unspecified —
  // which is how a terminal handoff shipped with no public trace at all.
  test('bounds the handoff comment field-by-field', () => {
    expect(doc).toMatch(/A handoff comment \(§13 item 4\) contains at most:/);
    expect(doc).toMatch(
      /the phase \(`refinement`\) and the terminal state literal \(`escalated_human`\)/,
    );
    expect(doc).toMatch(/the handoff reason literal/);
    expect(doc).toMatch(
      /rounds used,\s+malformed attempts per role, agent process failures per role, stale restarts/,
    );
    expect(doc).toMatch(
      /whether the coarse marker was left in place \(§13 item 2\)/,
    );
    expect(doc).toMatch(
      /the next supported operator action for that reason, and the §13 exit an\s+operator can take from a terminal handoff/,
    );
  });

  // The redaction list is one list, not two: a handoff comment carries resolved
  // role CONFIGURATION as its "run metadata" and never a correlation id.
  test('applies the never-published list to the handoff comment too, run id included', () => {
    expect(doc).toMatch(
      /That list binds the handoff comment exactly as it binds the applied-refinement\s+one\. The run id in particular is a run identifier and is never published/,
    );
  });

  // Issue #936 review: the outbox key deduplicates the durable ROW; only a
  // check against the Issue itself can tell that a previous attempt's POST
  // landed before its dispatcher lost the claim.
  test('separates the lane preconditions item 4 is free of from its delivery precondition', () => {
    expect(doc).toMatch(
      /The preconditions item 4 is free of are the lane's own[\s\S]{0,200}Its \*\*delivery\*\* carries exactly one:/,
    );
    expect(doc).toMatch(
      /the comment body opens with an idempotency marker derived from the effect's key,\s+and the dispatcher publishes only after confirming the Issue does not already\s+carry a comment bearing it/,
    );
    expect(doc).toMatch(
      /A\s+comment history that cannot be READ is not an absent comment: the effect fails,\s+retries on its budget, and dead-letters visibly/,
    );
  });

  // Row 46 has no §12 state row behind it: the delivery fails long after the
  // transition committed, so the contract has to name who records it instead.
  test('names where row 46 is recorded and what it may carry', () => {
    expect(doc).toMatch(/Row 46 is recorded \*\*where the row dies\*\*, which is outside every task\s+transaction/);
    expect(doc).toMatch(/the operator `outbox cancel` that retires the row by hand/);
    expect(doc).toMatch(/It is written\s+at most once per effect/);
    expect(doc).toMatch(/it carries literals only, never the\s+provider error text/);
  });

  // Issue #936 review: a marker read and a POST are two calls, so "already
  // there?" is only ever a statement about the past — a dispatcher whose lease
  // expired mid-read could publish beside the one that reclaimed the row.
  test('fences the delivery guard on the dispatch claim, and bounds what is left', () => {
    expect(doc).toMatch(
      /The read and the POST are two calls, though, so the guard is \*\*fenced on the\s+dispatch claim as well\*\*/,
    );
    expect(doc).toMatch(
      /an attempt re-asserts the claim it holds after reading\s+the history and before publishing, and an attempt that no longer holds it stops\s+instead of posting beside whoever took the row/,
    );
    // Stated as a narrowed window, not a proof: claiming atomicity the layer
    // cannot deliver is how the next reader stops fencing at all.
    expect(doc).toMatch(
      /Nothing at this layer can make\s+the pair atomic — the provider offers no conditional create/,
    );
  });

  // At-most-once must not mean at-most-one-chance: the row dies in one table and
  // the audit event lands in another, and the second write can fail alone.
  test('makes the row-46 record recoverable without making it repeatable', () => {
    expect(doc).toMatch(/Recording it is \*\*not a single shot\*\*/);
    expect(doc).toMatch(
      /a dead-lettered row is never selected for dispatch\s+again, so nothing would carry the fact a second time/,
    );
    expect(doc).toMatch(
      /The dead-lettered rows\s+themselves are the repair record/,
    );
    expect(doc).toMatch(
      /every later dispatch run re-derives row 46 for any terminal handoff comment\s+still missing it, and an `outbox cancel` re-run against an already-cancelled\s+row does the same/,
    );
    expect(doc).toMatch(/Both are no-ops once the event exists/);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed malformed output
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — fail-closed malformed output', () => {
  test('enumerates what counts as malformed', () => {
    expect(doc).toMatch(/output that is not exactly one fenced JSON object/);
    expect(doc).toMatch(/a `pass` verdict carrying objections/);
    expect(doc).toMatch(/a `revise` verdict carrying no objection/);
    expect(doc).toMatch(/any output containing the managed-region markers/);
    expect(doc).toMatch(/any output containing an absolute or repository-external filesystem path/);
  });

  test('never partially salvages a malformed result', () => {
    expect(doc).toMatch(/Malformed output is never partially salvaged/);
    expect(doc).toMatch(/a malformed result never advances the round counter/);
  });

  test('separates an agent process failure from malformed output', () => {
    expect(doc).toMatch(/An agent process failure — non-zero exit, quota, timeout — is not malformed output/);
    expect(doc).toMatch(
      /nothing was returned, so there is nothing to salvage, no malformed-attempt counter moves, and no round is spent/,
    );
  });

  // Classification is borrowed; the disposition is not, because the generic
  // phase-failure path ends at `failed`, where neither the marker nor the
  // recovery command can move the Issue.
  test('borrows the existing failure classification but overrides the disposition', () => {
    expect(doc).toMatch(
      /\*\*Classifying\*\* such a failure stays with the existing agent-diagnostic provenance and retry classification/,
    );
    expect(doc).toMatch(/refinement adds no second classifier and no second backoff/);
    expect(doc).toMatch(
      /the generic phase-failure path ends at task status `failed`, and a `failed` task is a dead end for this lane/,
    );
    expect(doc).toMatch(
      /there is no `ready_for_human` refinement row for the §13 recovery command or row 36 to act on/,
    );
  });

  test('retries a retryable process failure in place and escalates a terminal one', () => {
    expect(doc).toMatch(
      /re-runs the same role in the same state after the phase-level delay that classification already prescribes, up to `MAX_AGENT_FAILURES_PER_ROLE` per role \(§12, rows 38 and 40\)/,
    );
    expect(doc).toMatch(
      /any failure once that per-role cap is reached, escalates with reason `agent_unavailable` \(§12, rows 39 and 41\)/,
    );
    expect(doc).toMatch(
      /`status:needs-refinement` stays on the Issue, no executable status is added, one comment carries the reason literal, and `admin refinement recover` applies unchanged/,
    );
    expect(doc).toMatch(
      /No agent process failure therefore leaves the refinement phase at task status `failed`/,
    );
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — compatibility', () => {
  test('leaves issue-discuss untouched', () => {
    expect(doc).toMatch(
      /\*\*`issue-discuss` \(#229, #244–#246\)\.\*\* Untouched/,
    );
  });

  test('does not gate refinement on the planning gate decision', () => {
    expect(doc).toMatch(/\*\*`issue-plan` and the planning gate \(#295, #357\/#358\)\.\*\*/);
    expect(doc).toMatch(
      /`decision` and `readyForImplementation` do \*\*not\*\* gate refinement/,
    );
    expect(doc).toMatch(/requiring `ready` would deadlock the lane/);
  });

  test('reads Issue Relationships but never rewires them', () => {
    expect(doc).toMatch(/\*\*GitHub Issue Relationships\.\*\*/);
    expect(doc).toMatch(
      /Refinement never creates, removes, or rewires a relationship/,
    );
  });

  test('reuses status:stack-ready verbatim and adds no new readiness marker', () => {
    expect(doc).toMatch(/\*\*`status:stack-ready`\.\*\* Reused verbatim as the readiness signal/);
    expect(doc).toMatch(/Refinement adds no new readiness marker/);
  });

  test('the merged input shape is an addition on the refinement side only', () => {
    expect(doc).toMatch(
      /Refinement does accept one input shape Gate 2 does not — a \*\*merged\*\* predecessor PR \(§4\)/,
    );
    expect(doc).toMatch(
      /the Gate 2 resolver keeps its open-PR requirement unchanged/,
    );
    expect(doc).toMatch(
      /a merged predecessor reaches implementation through the ordinary closed-blocker gate \(Gate 1\) exactly as it does today/,
    );
  });

  test('treats the chain registry as read-only', () => {
    expect(doc).toMatch(/\*\*Chain registry \(#788, #790, #890, #892\)\.\*\* Read-only/);
    expect(doc).toMatch(
      /Refinement never registers a member, adds an edge, moves a revision pointer, or touches a frozen prefix/,
    );
  });

  test('keeps the dormant-first contract required', () => {
    expect(doc).toMatch(/\*\*Dormant-first contract\.\*\* Unchanged and still required/);
  });

  // The outbox is still the only mutation path, but it cannot carry this
  // contract unchanged: there is no body-update effect, no dispatch-time
  // precondition, and no way to commit the park that follows a delivered label
  // effect — so all three are named as required extensions rather than assumed.
  test('names the three outbox extensions the contract requires', () => {
    expect(doc).toMatch(
      /\*\*Outbox — reused as the only mutation path, but it must be extended three times\.\*\*/,
    );
    expect(doc).toMatch(
      /no second queue, dispatch process, or out-of-band write path is introduced/,
    );
    // 1. The body-update effect: no topic and no provider method exists today.
    expect(doc).toMatch(/\*\*An Issue-body update effect\.\*\*/);
    expect(doc).toMatch(
      /no payload in the union edits a work-item body, and no `WorkItemProvider` method does either — the port offers `commentItem` and `transitionItem` only/,
    );
    expect(doc).toMatch(
      /a new provider-neutral topic \(`workitem:body-update` in the existing naming\)/,
    );
    expect(doc).toMatch(/a matching dispatcher case/);
    expect(doc).toMatch(
      /Until that effect exists, step 3 cannot be dispatched at all, and the lane must stay disabled \(§19\)/,
    );
    // 2. The dispatch-time precondition, with a terminal non-retrying outcome.
    expect(doc).toMatch(/\*\*A dispatch-time precondition, evaluated per effect\.\*\*/);
    expect(doc).toMatch(
      /today nothing recomputes anything at dispatch, so a row that waited in the queue is delivered against whatever state it finds/,
    );
    expect(doc).toMatch(
      /an optional precondition descriptor persisted on the effect/,
    );
    expect(doc).toMatch(/a precondition evaluator injected into the dispatcher/);
    expect(doc).toMatch(/a \*\*terminal, non-retrying\*\* disposition for a failed check/);
    expect(doc).toMatch(
      /consuming no retry budget, and never being delivered later/,
    );
    // The descriptor has to carry the region digest too, or the exclusion of
    // §6 leaves rows 43-44 unenforceable.
    expect(doc).toMatch(
      /The descriptor carries three things, not one: the accepted `predecessorFingerprint`, the required-present and required-absent labels of §6, and the `appliedRegionDigest` of §6 for every effect enqueued after the body update/,
    );
    expect(doc).toMatch(
      /without that third field the evaluator cannot see an edit inside it and rows 43–44 are unenforceable/,
    );
    // 3. The activation reconciliation: the park cannot ride inside the
    // external label write, and the crash between them must be repairable.
    expect(doc).toMatch(/\*\*A durable activation reconciliation\.\*\*/);
    expect(doc).toMatch(
      /today's dispatcher has no TaskStore transaction and no completion callback that could carry a local write with it/,
    );
    expect(doc).toMatch(
      /Treating the two as one transaction would be a specification that no implementation can honour/,
    );
    expect(doc).toMatch(
      /ordinary intake refuses the implementation enqueue as a duplicate on every later poll and the Issue never starts/,
    );
    expect(doc).toMatch(
      /a reconciliation pass — owned by the runner, driven by that persisted state, and run at the start of every poll before intake evaluates any Issue — that performs the park and the state move in \*\*one TaskStore transaction\*\*, compare-and-set so that re-running it is a no-op \(§12, row 45\)/,
    );
    expect(doc).toMatch(
      /A dispatcher completion callback that performs the same transaction inline is a permitted optimization; the reconciliation pass is what makes the outcome crash-consistent, so it is the requirement/,
    );
    // What genuinely is unchanged stays claimed as unchanged.
    expect(doc).toMatch(
      /Everything else about the outbox is genuinely unchanged: claim\/retry\/backoff, dead-lettering, the maintenance lock \(#818\), the scan cursors \(#819\/#820\), the session-scoped ownership filter, and the visibility policy/,
    );
    expect(doc).toMatch(
      /The one-stage-in-flight enqueue discipline of §11 \*is\* purely a runner-side property and needs no dispatcher change/,
    );
    expect(doc).toMatch(
      /an operator cancelling a queued refinement effect stops the lane rather than half-applying it/,
    );
  });

  // The guard of §3.1 is a runner capability, not an outbox one, and today's
  // runner does not have it — so the compatibility section has to name it as an
  // owed extension rather than assume it.
  test('names the phase-runner marker guard as a required extension', () => {
    expect(doc).toMatch(/\*\*Phase runner — one required guard, outside the outbox\.\*\*/);
    expect(doc).toMatch(
      /Today's runner does neither: it trusts the labels recorded at intake, and a task enqueued before the marker was applied runs unimpeded/,
    );
    expect(doc).toMatch(
      /It is deliberately \*not\* an outbox precondition: the first check happens before any effect exists/,
    );
    expect(doc).toMatch(
      /It reuses the existing cooperative cancellation \(`TaskStore\.cancelTask`, issue #608\) for a run already in flight and adds no force-kill, no new task status, and no new label/,
    );
    expect(doc).toMatch(
      /Until it lands, the mutual exclusion of §3 holds only for Issues with no pre-existing task/,
    );
  });

  test('the dead-letter handoff comment is a fresh row, and stops after it', () => {
    expect(doc).toMatch(
      /the resulting handoff enqueues its own comment as a \*\*new\*\* row with a fresh retry budget and no precondition descriptor, and if that row dead-letters too the lane stops attempting comments altogether \(§13, §12 row 46\)/,
    );
  });

  test('adds no task status and no refinement-specific enqueue', () => {
    expect(doc).toMatch(/\*\*Task statuses and the intake enqueue path\.\*\* Reused as-is, gates included/);
    expect(doc).toMatch(
      /the same branch a dependency-held implementation task already takes \(issue #224\)/,
    );
    expect(doc).toMatch(
      /Refinement introduces no new task status, no refinement-specific enqueue, and no change to the duplicate-refusal behavior/,
    );
    // The reactivation branch only applies to a row that is actually parked,
    // which is what makes the reconciliation required rather than optional.
    expect(doc).toMatch(
      /The park itself is performed by the reconciliation of extension 3, which is why that extension is required rather than optional: an un-parked row is not a row the reactivation branch can take, and intake refuses it as a duplicate instead/,
    );
  });

  // The router is the surface the whole activation path depends on, and it is
  // explicitly NOT changed: the lane meets its requirement by keeping the
  // operator's `agent:*` label on the Issue rather than by teaching
  // labelsToPhase to recover an assignment it deliberately does not read.
  test('leaves the intake router unchanged and says why the agent label is required', () => {
    expect(doc).toMatch(
      /\*\*The intake router \(`labelsToPhase`\) is unchanged, and that is why the `agent:\*` label is required\.\*\*/,
    );
    expect(doc).toMatch(
      /the router builds a new-implementation candidate from the pair `agent:\*` \+ `status:needs-implementation` — never from `status:needs-implementation` alone, and never by reading a persisted `context\.assignment` it deliberately does not consult \(issue #292\)/,
    );
    expect(doc).toMatch(
      /requires the label at admission \(row 1\), refuses admission without it \(row 47\), and leaves it in place at activation \(§11 step 5\)/,
    );
    expect(doc).toMatch(
      /A design that dropped the label and instead reactivated from the persisted assignment was rejected in §20\.2/,
    );
  });

  // Refinement eligibility is wider than the start gates, so the compatibility
  // section has to say the gates keep their exact admission rule.
  test('leaves the dependency gates exactly as they are', () => {
    expect(doc).toMatch(
      /It also makes \*\*no change to the dependency gates\*\*: Gate 1 still requires every `blocked by` Issue satisfied and Gate 2 still admits exactly one open unsatisfied blocker/,
    );
    expect(doc).toMatch(
      /an activated Issue whose fan-in exceeds what those gates admit stays parked until the chain closes it out \(§11, §12 row 34\)/,
    );
    expect(doc).toMatch(
      /Widening Gate 2 to admit a multi-blocker stack is a separate decision this contract deliberately does not take/,
    );
  });

  test('declares refinement a new TaskPhase that phase-enumerating surfaces must learn', () => {
    expect(doc).toMatch(/\*\*Task phases\.\*\* `refinement` is a new `TaskPhase`/);
    expect(doc).toMatch(
      /the phase runner's supported-phase set, the worktree phase set, and the admin status projections/,
    );
    // The one runner behavior the phase must not inherit: ending at `failed`,
    // where §13's recovery command has nothing to act on.
    expect(doc).toMatch(
      /§17 forbids a refinement task ending at status `failed`, so the generic phase-failure disposition is overridden for this phase — a terminal agent process failure is recorded as `ready_for_human` with handoff reason `agent_unavailable`/,
    );
  });
});

// ---------------------------------------------------------------------------
// Configuration, decisions, gaps, verification
// ---------------------------------------------------------------------------

describe('docs/issue-refinement-contract.md — configuration and decisions', () => {
  test('the whole lane is off by default and the marker is then inert', () => {
    expect(doc).toMatch(/"enabled": false, \/\/ default; the whole lane is off/);
    expect(doc).toMatch(/`status:needs-refinement` is an inert label/);
    expect(doc).toMatch(/Enabling the lane changes behavior only for Issues carrying the marker/);
  });

  test('records the chosen decisions', () => {
    expect(doc).toMatch(/\*\*One coarse label, all detail in SQLite\.\*\*/);
    expect(doc).toMatch(/\*\*Stack-ready, not merged, as the readiness signal\.\*\*/);
    expect(doc).toMatch(/\*\*But a merged predecessor still counts as usable\.\*\*/);
    expect(doc).toMatch(
      /\*\*The fingerprint covers every snapshot input, minus the lane's own two writes\.\*\*/,
    );
    expect(doc).toMatch(/\*\*The label transition is a replacement, removal first\.\*\*/);
    expect(doc).toMatch(/\*\*Two agents, independence required, no self-critique fallback\.\*\*/);
    expect(doc).toMatch(/\*\*A managed body region rather than whole-body replacement\.\*\*/);
    expect(doc).toMatch(/\*\*Label transition last in the activation order\.\*\*/);
    expect(doc).toMatch(/\*\*No routine human approval on the successful path\.\*\*/);
    expect(doc).toMatch(
      /\*\*The fingerprint travels with the effect and is re-checked at dispatch\.\*\*/,
    );
    expect(doc).toMatch(/\*\*One stage in flight at a time\.\*\*/);
    expect(doc).toMatch(
      /\*\*Activation parks the shared task row instead of creating a second one\.\*\*/,
    );
    expect(doc).toMatch(
      /\*\*The excluded managed region is guarded by its own digest, not by trust\.\*\*/,
    );
    expect(doc).toMatch(
      /\*\*The park is reconciled from the delivered effect, not transacted with it\.\*\*/,
    );
    expect(doc).toMatch(
      /\*\*An agent process failure escalates instead of failing the task\.\*\*/,
    );
    expect(doc).toMatch(
      /\*\*A failed marker precondition at dispatch is a handoff, not a refusal\.\*\*/,
    );
    expect(doc).toMatch(/\*\*Handoff recovery is an explicit operator command\.\*\*/);
    expect(doc).toMatch(/\*\*Extend the outbox rather than write around it\.\*\*/);
    expect(doc).toMatch(
      /\*\*Activation hands over to the dependency gates instead of overriding them\.\*\*/,
    );
  });

  test('records the rejected alternatives', () => {
    expect(doc).toMatch(/\*\*A second approval label or a `status:refinement-\*` micro-state family\.\*\*/);
    expect(doc).toMatch(/\*\*Reusing `issue-discuss post` to apply the refinement\.\*\*/);
    expect(doc).toMatch(/\*\*Refining transitively, from the whole ancestor set\.\*\*/);
    expect(doc).toMatch(/\*\*Automatically creating child Issues from a split proposal\.\*\*/);
    expect(doc).toMatch(/\*\*Letting a `revise` loop run until the agents agree\.\*\*/);
    expect(doc).toMatch(
      /\*\*Keeping the refinement-marked Issue free of an `agent:\*` label and having intake reactivate from the persisted assignment\.\*\*/,
    );
    expect(doc).toMatch(
      /\*\*Adding the `agent:\*` label at activation instead of requiring it up front\.\*\*/,
    );
  });

  test('records the five open specification gaps', () => {
    expect(doc).toMatch(/\*\*G1 — Re-refinement after a predecessor changes post-activation\.\*\*/);
    expect(doc).toMatch(/\*\*G2 — Fan-in above the cap\.\*\*/);
    expect(doc).toMatch(/\*\*G3 — Multi-chain membership\.\*\*/);
    expect(doc).toMatch(/\*\*G4 — Operator preview\.\*\*/);
    expect(doc).toMatch(/\*\*G5 — A predecessor closed with its PR closed unmerged\.\*\*/);
  });

  test('G5 is named as the only remaining indefinite hold inside the lane', () => {
    expect(doc).toMatch(
      /What is specified is that this is the \*only\* remaining indefinite hold inside the refinement lane/,
    );
    // The post-activation fan-in wait is also indefinite, but it is specified
    // behavior rather than an open gap, so G5 says so instead of overclaiming.
    expect(doc).toMatch(
      /The one indefinite wait that can follow a \*successful\* refinement — an activated Issue whose fan-in the unchanged dependency gates do not admit \(§12, row 34\) — is not a gap/,
    );
  });

  test('points at this test file and explains why no behavioral test accompanies it', () => {
    expect(doc).toMatch(/`test\/docs-issue-refinement-contract\.test\.js` structurally pins/);
    expect(doc).toMatch(/No behavioral test accompanies #866/);
  });
});

// ---------------------------------------------------------------------------
// Cross-document pointers
// ---------------------------------------------------------------------------

describe('cross-document pointers', () => {
  test('phase-contracts.md points at the refinement contract from Gate 2', () => {
    expect(phaseContracts).toMatch(
      /The same stack-readiness signal is also the eligibility trigger for chain-aware progressive Issue refinement/,
    );
    expect(phaseContracts).toMatch(
      /Its marker \(`status:needs-refinement`\) is not an executable status and never routes to a phase defined in this document/,
    );
    // The one requirement the marker places on the phases defined there.
    expect(phaseContracts).toMatch(
      /when that marker is on an Issue whose task already exists, the runner must refuse to start the phase — and refuse to publish the outward effects of a run already in flight — rather than execute against the unrefined Issue/,
    );
    expect(phaseContracts).toMatch(/issue-refinement-contract\.md/);
  });

  test('idea-to-implementation.md points at it from the dormant-first contract', () => {
    expect(ideaToImplementation).toMatch(
      /can instead be labelled `agent:<impl>` \+ `status:needs-refinement` \(an optional, default-off lane\)/,
    );
    expect(ideaToImplementation).toMatch(
      /the marker is not an executable status and `agent:\*` alone routes nowhere, so the pair is dormant and cannot activate the dependent/,
    );
    expect(ideaToImplementation).toMatch(/issue-refinement-contract\.md/);
  });

  // The lane is implemented but default-off (issues #867-#871, gated behind
  // `session.issueRefinement.enabled`). The operational guide must say so and
  // still name the manual fallback for a session that has not opted in, or an
  // operator following step 5 on an unconfigured session leaves the dependent
  // dormant forever.
  test('idea-to-implementation.md marks the refinement lane as implemented but default-off', () => {
    expect(ideaToImplementation).toMatch(
      /\*\*That lane is implemented but default-off — confirm your session has\s+opted in before using it\.\*\*/,
    );
    expect(ideaToImplementation).toMatch(
      /`status:needs-refinement` routes through the\s+refinement handler only when `session\.issueRefinement\.enabled` is `true`/,
    );
    expect(ideaToImplementation).toMatch(/feature-status\.md#issue-refinement/);
    expect(ideaToImplementation).toMatch(
      /If your session has not enabled the lane, refine a rough\s+dependent's body by hand and activate it with the ordinary `agent:<impl>` \+\s+`status:needs-implementation` pair described above/,
    );
    // The lane description that follows must read as the current
    // implementation's behavior, not as a future promise.
    expect(ideaToImplementation).toMatch(
      /The behavior the contract specifies is as follows\./,
    );
  });

  // The dormant-first step-5 guidance must produce a label set ordinary intake
  // can actually reactivate; guidance that stopped at the marker would leave a
  // dependent that refinement admits and intake never picks up.
  test('idea-to-implementation.md tells the operator to apply the agent label too', () => {
    expect(ideaToImplementation).toMatch(
      /Apply \*\*both\*\*/,
    );
    expect(ideaToImplementation).toMatch(
      /the refinement lane requires the agent label at admission and refuses an Issue that carries the marker without one/,
    );
    expect(ideaToImplementation).toMatch(
      /swaps `status:needs-refinement` for `status:needs-implementation` and leaves your `agent:\*` label in place — the ordinary implementation pair, which the next intake scan picks up under the unchanged dependency gates/,
    );
  });
});
