/**
 * Structural pins for the Codex capability record (issue #1067):
 * docs/review-dispute-contract.md §17 and the two paragraphs
 * docs/review-dispute-operations.md added alongside it.
 *
 * §17 is a document about what this runner CANNOT do yet, which is the kind of
 * document that rots in one specific direction: somebody lands a Codex turn,
 * the capability table stops matching the code, and the section starts reading
 * as a readiness claim it never made. So every assertion here is one of three
 * shapes:
 *
 *  1. the refusals §17 describes are still the refusals the CODE performs —
 *     checked against the runner's own capability tables, never against a
 *     second copy of them written here;
 *  2. the one divergence §17.5 exists to name is still a divergence: the
 *     refinement lane really does resolve a Codex profile labelled `no-tools`,
 *     and the dispute lanes really do refuse one;
 *  3. the section still states a blocker and two pending decisions, and still
 *     forbids publishing a successor as stack-ready.
 *
 * If a successor implements D1 or D2, these tests are expected to fail. That is
 * the point: the decision gets recorded in §17 first, and the pins move with it.
 *
 * Issue #1068 was the first successor and moved exactly two of them: §17 no
 * longer claims that nothing in it is implemented, because §17.7's invocation
 * contract gained an adapter.
 *
 * Issue #1069 is the second, and it took D1. So the pins about ROUTING moved:
 * §17 now records D1 as taken (§17.11), and an enabled session's Codex review
 * runs `codex exec` rather than `codex review`. Three things did NOT move, and
 * are still checked against the runner's own tables rather than a second copy
 * written here: `codex review` is still refused for structured findings (the
 * compatibility table answers for that COMMAND, and the routed lane never
 * consults it), `codex` is still refused for both dispute turns, and D2 is still
 * unrecorded.
 *
 * Issue #1070 is the third, and it is the one this file was written for: it
 * asked for the turn D2 gates, found D2 unrecorded, and stopped (§17.12). Its
 * pins are therefore about a REFUSAL that now has a shape — a capability
 * decision naming B2 and D2, whose answer the resolver reads rather than
 * restates — and about the three shortcuts §17.12 records as refused. If a later
 * change makes any of these fail, the question to ask is whether §17.6 gained a
 * recorded D2 or §17.4 gained a `verified` C7; if neither did, the change is the
 * failure mode this file exists to catch.
 *
 * Issue #1071 is the fourth: it asked for the round trip that ENDS in that turn,
 * stopped at the same place, and fixed the one integration fault the exercise
 * uncovered — §4.1's reconsideration is owed to the reviewer that raised the
 * finding, not to whichever lane the session resolves a phase later. Its pins are
 * §17.13's, and they are deliberately paired with the runner's tables again: a
 * milestone that moves an identity must not be readable as one that moved a
 * capability.
 *
 * Issue #1085 is the sixth, and it is the one the header above anticipated: an
 * operator recorded D2, so the pins that said "D2 is open" moved — and only
 * those. What replaces them is deliberately narrower and harder to satisfy by
 * accident: the section records the decision with its date and its quoted
 * approval; the posture it admitted is `read-bounded` and the `no-tools` literal
 * is still unreachable for that lane in the source; the opt-in is default-off in
 * the resolver as well as in the prose; and everything D2 did NOT admit — the
 * arbitration turn, the §8.2 capability list, C7's grade, the native review
 * command — is still checked against the runner's own tables. A change that makes
 * one of those fail is the failure mode this file exists to catch, now in the
 * opposite direction: not a capability shipped without a decision, but a decision
 * read wider than it was given.
 *
 * Issue #1072 is the fifth, and it moved no behavior at all: it re-ran the same
 * path with the agent invocations un-stubbed, against fake executables on `PATH`.
 * Its pins (§17.14) are therefore about a claim of COVERAGE — that the argv the
 * section says is spawned is the argv the resolvers build, that the round-trip
 * legs it exercises on a Claude reviewer are named as a limit rather than as a
 * capability, and that the two things the suite does not cover are stated.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS,
  structuredFindingsSupport,
} from '../dist/core/review-finding-envelope.js';
import {
  RECONSIDERATION_NO_TOOLS_ARGS,
  RECONSIDERATION_READ_BOUNDED_ARGS,
  RECONSIDERATION_SUPPORTED_AGENTS,
  buildReconsiderationArgv,
  reconsiderationAgentSupport,
  resolveReconsiderationProfile,
} from '../dist/handlers/review-reconsideration.js';
import {
  CODEX_STRUCTURED_REVIEW_EXEC_ARGS,
  resolveCodexStructuredReviewProfile,
} from '../dist/handlers/codex-structured-review.js';
import { resolveAgentPhaseRuntime } from '../dist/handlers/agent-runtime.js';
import { resolveReviewDisputeSettings } from '../dist/core/review-dispute.js';
import { summarizeDisputeStatus } from '../dist/core/review-dispute-status.js';
import {
  ARBITER_CLAUDE_NO_TOOLS_ARGS,
  createArbiterCandidateResolver,
} from '../dist/core/review-arbiter-profile.js';
import { resolveRefinementRoleProfile } from '../dist/handlers/issue-refinement-loop.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const CONTRACT_RAW = read('docs/review-dispute-contract.md');
const OPS_RAW = read('docs/review-dispute-operations.md');
const contract = CONTRACT_RAW.replace(/\s+/g, ' ');
const ops = OPS_RAW.replace(/\s+/g, ' ');
const sandbox = read('docs/single-host-platform-sandbox-contract.md').replace(/\s+/g, ' ');

/** §17 as its own body, so a pin cannot be satisfied by text elsewhere. */
const section17 = CONTRACT_RAW.slice(CONTRACT_RAW.indexOf('\n## 17. ')).replace(/\s+/g, ' ');

/**
 * Resolve a real `structured_exec` runtime through the boundary (issue #912):
 * the structured lane now takes model, effort, and binary from it rather than
 * from `session.codex`, so these pins call the resolver the way the runner does.
 */
function structuredRuntime() {
  const resolution = resolveAgentPhaseRuntime({
    task: {
      sessionId: 'docs-codex-capability-test',
      issueNumber: 1,
      status: 'running',
      phase: 'review',
      priority: 'normal',
      attempts: {},
      context: { labels: [] },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    session: {},
    phase: 'review',
    lane: 'structured_exec',
    agentId: 'codex',
    env: {},
  });
  if ('error' in resolution) throw new Error(resolution.error);
  return resolution.runtime;
}

describe('review-dispute contract §17 — the section exists and claims only what was decided', () => {
  test('is present, and says up front which decision is recorded and which is not', () => {
    expect(CONTRACT_RAW).toMatch(
      /\n## 17\. Codex participation: capability record and pending decisions\n/,
    );
    // #1069 took D1 and #1085 took D2, so the claim is no longer "one decision".
    // What replaces it is the pair that IS true and is still checkable: both
    // decisions recorded, each bounded by what it was approved for, and the
    // things neither of them moved.
    expect(section17).toMatch(
      /\*\*Both decisions are now recorded, and each is bounded by what it was approved for\.\*\*/,
    );
    expect(section17).toMatch(/D1 is taken . see §17\.11/);
    expect(section17).toMatch(/\*\*D2 is taken as of 2026-09-07\*\* . see §17\.16/);
    expect(section17).toMatch(/explicit, default-off session opt-in/);
    // The bound that matters most, because it is the one a reader will assume
    // moved with it: arbitration did not.
    expect(section17).toMatch(/\*\*a Codex arbitration still fails closed\*\*/);
    expect(section17).toMatch(/C7 is still\s+`unknown` in §17\.4 and no §17\.8 canary has been run/);
    expect(section17).toMatch(
      /a session with the protocol disabled runs `codex review` byte for byte as it always\s+has/,
    );
    expect(section17).toMatch(
      /A session that has not written the opt-in down behaves exactly as it did\s+before #1085, refusal included/,
    );
  });

  test('the header points at it and states the default-off bound', () => {
    expect(contract).toMatch(/\*\*Provider capability \(issue #1067\)\.\*\*/);
    expect(contract).toMatch(/\*\*Both decisions have now been taken\.\*\*/);
    expect(contract).toMatch(/D1 is recorded in §17\.11 and\s+implemented by issue #1069/);
    expect(contract).toMatch(
      /\*\*D2 is recorded in §17\.16 and\s+implemented by issue #1085\*\*/,
    );
    expect(contract).toMatch(/`reviewDispute\.reconsideration\.readBounded: true`, which is off by default/);
    expect(contract).toMatch(/\*\*reads are not bounded\*\*/);
    expect(contract).toMatch(/A Codex \*\*arbitration\*\*\s+still fails closed/);
    expect(contract).toMatch(
      /A session with the protocol \*\*disabled\*\* is untouched: it runs\s+`codex review`, byte for byte/,
    );
  });

  test('records that no build was tested and no version gate is pinned', () => {
    expect(section17).toMatch(
      /\*\*No Codex build has been tested against this contract in this repository, and no version gate is pinned for one\.\*\*/,
    );
    // The claim that matters: an untested build cannot be graded up.
    expect(section17).toMatch(/at most `vendor-documented`/);
    expect(section17).toMatch(/`codex --version`/);
  });

  test('reuses the platform contract’s grading scale and its absent-on-unknown rule', () => {
    for (const grade of ['`verified`', '`vendor-documented`', '`unknown`']) {
      expect(section17).toContain(grade);
    }
    expect(section17).toMatch(/\*\*Unknown evaluates as absent\*\*/);
    expect(section17).toMatch(/single-host-platform-sandbox-contract\.md/);
    // The scale is borrowed, not invented — the source still defines it.
    expect(sandbox).toMatch(/\| `vendor-documented` \| The vendor documents the mechanism/);
    expect(sandbox).toMatch(/\*\*Unknown evaluates as absent\*\*/);
  });

  test('C4 cites the grade the platform contract actually records for codex', () => {
    expect(sandbox).toMatch(/\| `codex` \| vendor-documented \|/);
    expect(section17).toMatch(/\| C4 \|[^|]*`--sandbox read-only`[^|]*\| `vendor-documented` \|/);
  });

  test('C7 — the capability §8.2 turns on — is graded unknown', () => {
    expect(section17).toMatch(/\| C7 \| \*\*Removal of the tool surface itself\*\*/);
    expect(section17).toMatch(/\| C7 \|[^|]*\| `unknown` \|/);
    // Named against the concrete Claude flags it has no counterpart for.
    for (const flag of ['--tools', '--allowedTools', '--disallowedTools']) {
      expect(section17).toContain(flag);
      expect(ARBITER_CLAUDE_NO_TOOLS_ARGS).toContain(flag);
    }
  });
});

describe('review-dispute contract §17.5 — the blocker, and the two refused inferences', () => {
  test('B2 is stated as an input boundary, not a side-effect one', () => {
    expect(section17).toMatch(/\*\*B2 . the §8\.2 posture cannot be enforced for Codex today\.\*\*/);
    expect(section17).toMatch(/§8\.2's boundary is about \*\*inputs\*\*, not side effects/);
    expect(section17).toMatch(
      /`--sandbox read-only` bounds \*\*writes and network\*\* for agent-owned commands/,
    );
    expect(section17).toMatch(/It leaves reads available, and reads are exactly what §8\.2 excludes/);
  });

  test('a prompt is refused as an enforcement point', () => {
    expect(section17).toMatch(/\*\*A prompt is not an enforcement point\.\*\*/);
  });

  test('the refinement lane’s precedent is refused explicitly', () => {
    expect(section17).toMatch(/\*\*The refinement lane's precedent does not transfer\.\*\*/);
    expect(section17).toMatch(/a successor must not reuse the `no-tools` literal for a Codex dispute turn/);
  });

  test('§8.2 itself now says the label does not travel', () => {
    expect(contract).toMatch(/That last clause is about \*\*inputs\*\*, not only side effects/);
    expect(contract).toMatch(/an identical label elsewhere in the repository does not import a weaker one into it/);
  });

  test('B1 is recorded as structural, and §13 still routes the native command to the legacy path', () => {
    expect(section17).toMatch(/\*\*B1 . a Codex reviewer cannot be asked for the §2\.1 finding envelope\.\*\*/);
    expect(contract).toMatch(/today that is `codex`, for the structural reason recorded as §17\.4 C9/);
  });

  test('B1’s close names D1 as the route, and does not weaken C9 or §13 to get there', () => {
    expect(section17).toMatch(
      /\*\*B1 is now closed for enabled sessions, by D1 rather than around it\*\* \(§17\.11\)/,
    );
    expect(section17).toMatch(/It changes which COMMAND an enabled session's Codex review runs/i);
    expect(section17).toMatch(/A disabled session still runs `codex review`/);
    // C9 is a statement about `codex review`, and it did not move.
    expect(section17).toMatch(/\| C9 \|[^|]*\| absent by construction \|/);
  });
});

describe('review-dispute contract §17.6/§17.9 — decisions, not implementations', () => {
  test('both decisions are named, scoped, and marked as needing an operator', () => {
    expect(section17).toMatch(/\*\*D1 . a runner-authored Codex review lane \(addresses B1\)\.\*\*/);
    expect(section17).toMatch(
      /\*\*D2 . a named weaker tool posture, never the `no-tools` label \(addresses B2\)\.\*\*/,
    );
    expect(section17).toMatch(/without an explicit operator decision recorded against this section/);
    // D2 is honest about the property it gives up.
    expect(section17).toMatch(/\| "the bundle is the entire input" \| guaranteed \| \*\*not guaranteed\*\* \|/);
  });

  test('the product boundaries the Issue set are restated as out of bounds', () => {
    expect(section17).toMatch(/\*\*Not proposed, and out of bounds for any successor of #1067:\*\*/);
    for (const bound of [
      'relaxing §8.2 in place',
      'reusing the `no-tools` literal',
      'enabling either decision for an operational session',
      'a metered API path or provider substitution',
      'any increase to the §6.1 caps',
      'automatic merge',
    ]) {
      expect(section17).toContain(bound);
    }
  });

  test('successors are gated, and the provider overhaul is a pointer not a dependency', () => {
    expect(section17).toMatch(/\*\*MUST NOT be published stack-ready\.\*\*/);
    expect(section17).toMatch(/#903.#914, especially #908 and #912/);
    expect(section17).toMatch(/expects to be folded into that work rather than to grow into it/);
  });

  test('§15 keeps the gaps and the decisions apart', () => {
    expect(contract).toMatch(/\*\*Not gaps of this kind: the §17 capability decisions\.\*\*/);
    expect(contract).toMatch(/G1 and G2 are transitions this contract does not define/);
  });
});

describe('review-dispute contract §17.7/§17.8 — the invocation contract and the smoke check', () => {
  test('pins the exact subcommand, prompt delivery, and flags a Codex turn would use', () => {
    expect(section17).toMatch(/\| Subcommand \| `codex exec`\. Never `codex review`/);
    expect(section17).toMatch(/stdin, with no prompt argument/);
    for (const flag of ['--sandbox read-only', '--skip-git-repo-check', '--ignore-user-config']) {
      expect(section17).toContain(flag);
    }
    expect(section17).toMatch(/`--output-schema <path>` only once C6 is `verified`/);
    expect(section17).toMatch(/\| Tool policy recorded \| `read-bounded` under D2\. Never `no-tools`/);
  });

  test('states cwd, environment, artifact ownership, timeout, cancellation and model/effort', () => {
    expect(section17).toMatch(/A throwaway `mkdtemp` directory, not the worktree and not a checkout/);
    expect(section17).toMatch(/`CODEX_HOME` synthesized at the real `~\/\.codex`/);
    expect(section17).toMatch(/Runner-owned, §10\.2, local-only/);
    expect(section17).toMatch(/An invocation failure spends \*\*no\*\* protocol counter and moves no lineage/);
    expect(section17).toMatch(/\*\*Unset stays absent\*\*/);
    expect(section17).toMatch(/`xhigh` and `max` map to `high`/);
  });

  test('the C7 canary is an operator procedure, never a CI test', () => {
    expect(section17).toMatch(/### 17\.8 The operator smoke check \(never CI\)/);
    expect(section17).toMatch(/because it spawns a real CLI and may bill a real turn/);
    expect(section17).toMatch(/A canary that was not run leaves its row where it is; an unrun check is never a pass/);
    expect(section17).toMatch(/agent-isolation-policy\.md/);
  });
});

describe('review-dispute contract §17.10 — the adapter, and what it did not change', () => {
  test('the section records an implementation that nothing routes to', () => {
    expect(section17).toMatch(/### 17\.10 The invocation adapter \(issue #1068\)/);
    expect(section17).toMatch(/for the REVIEW turn only, and connected it to nothing/);
    // Stated in the past tense since #1069, because the sentence is the record
    // of what #1068 did — not a claim about the tree today.
    expect(section17).toMatch(/D1 was therefore still unrecorded at the end of #1068/);
    expect(section17).toMatch(/what existed was the mechanism D1 would switch on, not the switch/);
    expect(section17).toMatch(/\*\*§17\.11 is the switch\*\*/);
  });

  test('the one §17.7 row a review cannot honor is named, not quietly departed from', () => {
    expect(section17).toMatch(
      /\*\*One row of §17\.7 does not transfer, and it is named here rather than quietly departed from\.\*\*/,
    );
    expect(section17).toMatch(/the adapter's cwd is the checkout/);
    // The row it diverges from is still stated for the dispute turn it was
    // written for, unchanged.
    expect(section17).toMatch(/A throwaway `mkdtemp` directory, not the worktree and not a checkout/);
    // And the divergence is not an exercise of D2.
    expect(section17).toMatch(/not an exercise of D2/);
  });

  test('the posture it records is the one §17.5 permits, in the doc and in the code', () => {
    expect(section17).toMatch(/\*\*The posture is `read-bounded`, never `no-tools`\.\*\*/);
    // The pin that matters: the doc's claim is the resolver's answer, not a
    // second copy of it written here.
    const { profile } = resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} });
    expect(profile.toolPolicy).toBe('read-bounded');
    expect(profile.argv).toEqual(
      expect.arrayContaining(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config']),
    );
  });

  test('the schema flag stays opt-in while C6 is vendor-documented', () => {
    expect(section17).toMatch(/\*\*The schema is assistance\.\*\*/);
    expect(section17).toMatch(/implements the schema flag as an OPT-IN that is off by default/);
    expect(section17).toMatch(/\| C6 \|[^|]*\| `vendor-documented` \|/);
    expect(resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} }).profile.capabilities.outputSchema).toBe(false);
    expect(resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), outputSchema: true, env: {} }).profile.capabilities.outputSchema)
      .toBe(true);
  });

  test('no bypass flag exists to be set, as the section claims', () => {
    expect(section17).toMatch(/\*\*No bypass flag exists to be set\.\*\*/);
    const argv = resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} }).profile.argv.join(' ');
    for (const forbidden of ['--dangerously', 'bypass', '--full-auto', 'danger-full-access']) {
      expect(argv).not.toContain(forbidden);
    }
  });

  test('no version gate was pinned, because §17.3 still records no tested build', () => {
    expect(section17).toMatch(/\*\*No version gate is pinned, because §17\.3 still records no tested build\.\*\*/);
    expect(section17).toMatch(
      /\*\*No Codex build has been tested against this contract in this repository, and no version gate is pinned for one\.\*\*/,
    );
  });
});

describe('review-dispute contract §17.11 — D1 as taken, and the bounds it was taken under', () => {
  test('the decision is recorded, with the scope §17.6 proposed', () => {
    expect(section17).toMatch(/### 17\.11 The routed lane, and decision D1 as taken \(issue #1069\)/);
    expect(section17).toMatch(/\*\*D1 is recorded here, as §17\.6 requires\.\*\*/);
    expect(section17).toMatch(/For sessions with `reviewDispute\.enabled: true` only/);
    // The product decision §17.6 says an operator is actually approving.
    expect(section17).toMatch(
      /the vendor's own diff-review pipeline is no longer what produces the report; a runner-authored prompt is/,
    );
  });

  test('every bound §17.6 attached to the proposal is restated as held', () => {
    expect(section17).toMatch(/\*\*A disabled session is byte-identical\.\*\*/);
    expect(section17).toMatch(
      /\*\*No loop cap moved, no second flag was introduced, and no default changed\.\*\*/,
    );
    expect(section17).toMatch(/no session that was passing reviews is auto-enabled/);
  });

  test('the three refusals are stated, so a clean pass cannot come from a partial review', () => {
    expect(section17).toMatch(/\*\*A diff that could not be captured fails the run\.\*\*/);
    expect(section17).toMatch(/\*\*A truncated diff cannot pass cleanly\.\*\*/);
    expect(section17).toMatch(/\*\*A response without an admissible envelope cannot pass cleanly\.\*\*/);
    // And the direction is the one §12 already takes for a Claude envelope.
    expect(section17).toMatch(/the identical direction §12 takes for a malformed Claude envelope/);
  });

  test('invocation failures spend no counter, and admission is the shared one', () => {
    expect(section17).toMatch(/\*\*Invocation failures are incidents, not verdicts\.\*\*/);
    expect(section17).toMatch(/spends no protocol counter and moves no lineage/);
    expect(section17).toMatch(/\*\*Admission is the ordinary one\.\*\*/);
    expect(section17).toMatch(/it does not add a second protocol/);
  });

  test('the §17.3 version-gate obligation is discharged by failing closed, not by inventing a range', () => {
    expect(section17).toMatch(
      /\*\*The §17\.3 version gate is still not pinned, and this is how that was discharged\.\*\*/,
    );
    expect(section17).toMatch(/pinning a range on an untested build would be the invented attestation/);
    expect(section17).toMatch(/Pinning the declarative gate remains owed/);
    // §17.3's own statement is unchanged: still no tested build.
    expect(section17).toMatch(
      /\*\*No Codex build has been tested against this contract in this repository, and no version gate is pinned for one\.\*\*/,
    );
  });

  test('D2 is explicitly untouched, and the dispute lanes still refuse codex in code', () => {
    expect(section17).toMatch(/\*\*D2 is untouched\.\*\*/);
    expect(section17).toMatch(/still reaches §8\.3 with no selectable arbiter and escalates to a human/);
    // The pin that matters is the runner's own answer, not this sentence.
    expect(resolveReconsiderationProfile('codex', {}).profile).toBeUndefined();
    expect(createArbiterCandidateResolver({ env: {} })('codex').ok).toBe(false);
  });
});

describe('review-dispute contract §17.12 — the reconsideration turn stopped for D2 (issue #1070)', () => {
  test('the section records a stop, and says which decision it stopped for', () => {
    expect(section17).toMatch(/### 17\.12 The reconsideration turn stops for D2 \(issue #1070\)/);
    expect(section17).toMatch(/\*\*The decision is unresolved, so this milestone stopped\.\*\*/);
    // The stop condition the Issue itself carried, restated so the record is
    // about a rule that was followed rather than about a milestone that stalled.
    expect(section17).toMatch(
      /if the predecessor recorded an unresolved boundary decision,\s+stop for that decision rather than invent a weaker policy/,
    );
    expect(section17).toMatch(/No Codex reconsideration was implemented, no\s+posture literal was added, and no guard was relaxed/);
  });

  test('it explains why D1 does not carry this turn, rather than leaving it to be re-derived', () => {
    expect(section17).toMatch(/\*\*Why D1 does not carry this turn\.\*\*/);
    // The distinction that does the work: different blockers, and only B1 was
    // answered by changing which command runs.
    expect(section17).toMatch(/\| The blocker \| B1 . `codex review` composes its own report/);
    expect(section17).toMatch(/`codex exec` is the same command either way, and the command was never the blocker/);
  });

  test('the three shortcuts it refused are named, each with its reason', () => {
    expect(section17).toMatch(
      /\*\*Three shortcuts were available and each is refused, with its reason\.\*\*/,
    );
    expect(section17).toMatch(/\*\*Reuse the `no-tools` literal over `codex exec --sandbox read-only`/);
    expect(section17).toMatch(/\*\*Add the boundary to the prompt\*\*/);
    expect(section17).toMatch(/\*\*Delete the resolver's agent check\*\*/);
    // The isolation layer is not offered as a substitute for the missing guard.
    expect(section17).toMatch(
      /it would only stop reporting that\s+nothing enforces it/,
    );
  });

  test('the successor path is ordered, and step 2 does not require D2 at all', () => {
    expect(section17).toMatch(/\*\*What an operator or a successor needs, in order\.\*\*/);
    expect(section17).toMatch(/Run §17\.8 on a real host and a real build/);
    expect(section17).toMatch(/\*\*D2 is not needed\*\*/);
    expect(section17).toMatch(/An unrun check is never a pass/);
  });

  test('the human handoff is recorded as supported behavior, not as a gap', () => {
    expect(section17).toMatch(
      /\*\*What happens to a dispute in the meantime, and why that is not a defect\.\*\*/,
    );
    expect(section17).toMatch(/this milestone may hand unresolved\s+disputes to a human/);
    expect(section17).toMatch(/it is not stalled and it is not silently degraded/);
  });

  test('the code still gives that answer for a session that has not opted in', () => {
    // The capability decision, from the runner rather than from a second copy.
    // §17.12's refusal is not history: it is what an un-opted-in session gets,
    // and #1085 was required to leave it exactly where it was.
    expect([...RECONSIDERATION_SUPPORTED_AGENTS]).toEqual(['claude']);
    const codex = reconsiderationAgentSupport('codex');
    expect(codex).toEqual({
      supported: false,
      blocker: 'B2',
      pendingDecision: 'D2',
      optIn: 'reviewDispute.reconsideration.readBounded',
      reason: expect.stringContaining('D2 (§17.6)'),
    });
    expect(resolveReconsiderationProfile('codex', {}).error).toBe(codex.reason);
    expect(resolveReconsiderationProfile('codex', {}, { readBounded: false }).profile).toBeUndefined();
    // And the posture §17.5 refuses for a dispute turn is still not constructible:
    // the second posture this module can now resolve carries the OTHER literal,
    // so no caller can select a Codex turn that records `no-tools` (§17.16).
    const source = read('src/handlers/review-reconsideration.ts');
    expect(new Set(source.match(/toolPolicy:\s*"[^"]+"/g))).toEqual(
      new Set(['toolPolicy: "no-tools"', 'toolPolicy: "read-bounded"']),
    );
    const claude = resolveReconsiderationProfile('claude', {}).profile;
    expect(claude.toolPolicy).toBe('no-tools');
    // The sandbox flags of §17.7 belong to a posture this lane does not have.
    expect(claude.argv.join(' ')).not.toContain('--sandbox');
  });

  test('§17.12 changed nothing else, and says so checkably', () => {
    expect(section17).toMatch(/\*\*What did not move\.\*\*/);
    // The review lane and the native command are both unchanged, in the code.
    expect(STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS).toContain('codex');
    expect(resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} }).profile.toolPolicy).toBe('read-bounded');
    // The arbitration turn was a separate turn and is still refused.
    expect(createArbiterCandidateResolver({ env: {} })('codex').ok).toBe(false);
    // The ordered successor path §17.12 wrote was completed rather than
    // sidestepped, and the section says which steps were taken and which was not.
    expect(section17).toMatch(/\*\*Steps 3 and 4 have since been taken, in that order, and step 1 has not\.\*\*/);
    expect(section17).toMatch(/§17\.8's canary has still not\s+been run and C7 is still `unknown`/);
    expect(section17).toMatch(
      /Everything §17\.12 says above about a session that has NOT opted in is still literally true of one/,
    );
  });
});

describe('review-dispute contract §17.13 — the round trip stopped at the same place (issue #1071)', () => {
  test('the section records the stop, and claims no Codex dispute turn', () => {
    expect(section17).toMatch(/### 17\.13 The round trip up to that turn \(issue #1071\)/);
    expect(section17).toMatch(
      /\*\*So the round trip stops where §17\.12 says it stops, and this milestone did not implement a Codex dispute turn, did not add a posture literal, and did not relax a guard\.\*\*/,
    );
    // The runner still gives that answer, from its own tables.
    expect([...RECONSIDERATION_SUPPORTED_AGENTS]).toEqual(['claude']);
    expect(createArbiterCandidateResolver({ env: {} })('codex').ok).toBe(false);
    expect(STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS).toContain('codex');
    expect(resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} }).profile.toolPolicy).toBe('read-bounded');
  });

  test('what the loop does up to the park is stated as behavior, not inferred', () => {
    expect(section17).toMatch(/no counter is spent, no §7 row is written/);
    expect(section17).toMatch(
      /an operator `recover` re-parks rather than consuming the rebuttal a second time or re-opening the answered version/,
    );
  });

  test('the one fault it fixed is named, with the direction it cuts both ways', () => {
    expect(section17).toMatch(/\*\*The one integration fault that exercise uncovered, and the fix\.\*\*/);
    expect(section17).toMatch(/it now reads `reviewDisputeParties\.review` first/);
    // Both rows, because a fix stated in one direction reads as a relaxation.
    expect(section17).toMatch(/\| `claude` \| `codex` \| refused as `profile_unavailable`/);
    expect(section17).toMatch(
      /\| `codex` \| `claude` \| dispatched to `claude`: a §8\.2 turn answered by an agent that was not party to the debate/,
    );
  });

  test('it changed no capability table, and says so checkably', () => {
    expect(section17).toMatch(/`RECONSIDERATION_SUPPORTED_AGENTS` still holds `claude` alone/);
    // Written as the record of THAT milestone, with the later decision pointed
    // at rather than backdated into it.
    expect(section17).toMatch(
      /D2 was still a proposal in §17\.6 when this milestone ended, and C7 is still `unknown` in §17\.4/,
    );
    expect(section17).toMatch(/#1071 decided \*who\* answers, #1085 decided \*whether this runner can invoke them\*/);
  });

  test('§16 names the suite that drives the round trip, and it exists', () => {
    expect(CONTRACT_RAW).toContain('test/review-dispute-round-trip.test.js');
    expect(() => read('test/review-dispute-round-trip.test.js')).not.toThrow();
  });
});

describe('review-dispute contract §17.14 — the same path with nothing seamed (issue #1072)', () => {
  test('the section records a test milestone and no behavior change', () => {
    expect(section17).toMatch(
      /### 17\.14 The same path with nothing seamed at the boundary \(issue #1072\)/,
    );
    expect(section17).toMatch(/\*\*What this milestone landed is a test, and no behavior change\.\*\*/);
    expect(section17).toMatch(/the review handler is built with \*\*no\*\* `ReviewDisputeSubTurnSeams` at all/);
    // The tables it claims not to have touched, from the runner rather than from
    // a second copy written here.
    expect([...RECONSIDERATION_SUPPORTED_AGENTS]).toEqual(['claude']);
    expect(createArbiterCandidateResolver({ env: {} })('codex').ok).toBe(false);
    expect(STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS).toContain('codex');
  });

  test('the invocations it says are spawned are the ones the resolvers build', () => {
    // The §4.1 argv, named in the section and produced by the profile resolver.
    for (const flag of ['--strict-mcp-config', '--safe-mode', '--no-session-persistence']) {
      expect(section17).toContain(flag);
      expect(RECONSIDERATION_NO_TOOLS_ARGS).toContain(flag);
    }
    expect(resolveReconsiderationProfile('claude', {}).profile.argv).toEqual(
      expect.arrayContaining([...RECONSIDERATION_NO_TOOLS_ARGS]),
    );
    // And the §17.11 lane's, which the section says is spawned as `codex exec`.
    expect(section17).toMatch(/really is\s+spawned as `codex exec` with the §17\.7 flags/);
    expect(resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} }).profile.argv).toEqual(
      expect.arrayContaining(['exec', '--sandbox', 'read-only']),
    );
  });

  test('it stops where §17.12 stops, and records nothing that would move it', () => {
    expect(section17).toMatch(/\*\*It stops in the same place, for the same reason\.\*\*/);
    expect(section17).toMatch(
      /Nothing here records D2, grades C7, adds a posture literal or relaxes a guard/,
    );
    expect(resolveReconsiderationProfile('codex', {}).profile).toBeUndefined();
  });

  test('the reviewer-of-record substitution is stated as a limit, never as a capability', () => {
    expect(section17).toMatch(
      /\*\*So the round-trip legs D2 gates are exercised on the lane that has a §8\.2\s+invocation, and that limit is the point rather than a workaround\.\*\*/,
    );
    expect(section17).toMatch(/they are not a claim that a Codex reviewer can withdraw a finding today/);
  });

  test('the two coverage bounds are named rather than papered over', () => {
    expect(section17).toMatch(/\*\*Two bounds the suite states rather than papers over\.\*\*/);
    expect(section17).toMatch(
      /exercised as a process killed by signal, not by waiting out the ten-minute\s+deadline/,
    );
    expect(section17).toMatch(/a moved PR head that still resolves\s+is an ordinary re-review/);
  });

  test('§16 names the suite and its fake CLI, and both exist', () => {
    expect(CONTRACT_RAW).toContain('test/review-dispute-default-path-e2e.test.js');
    expect(() => read('test/review-dispute-default-path-e2e.test.js')).not.toThrow();
    expect(() => read('test/helpers/fake-agent-cli.mjs')).not.toThrow();
  });
});

describe('review-dispute contract §17.16 — D2 as taken, and the bounds it was taken under (issue #1085)', () => {
  test('the decision is recorded with its date and its quoted approval, as §17.6 requires', () => {
    expect(section17).toMatch(
      /### 17\.16 The read-bounded reconsideration, and decision D2 as taken \(issue #1085\)/,
    );
    expect(section17).toMatch(/\*\*D2 is recorded here, as §17\.6 requires\.\*\*/);
    expect(section17).toMatch(/\*\*D2 as approved \(2026-09-07\)\.\*\*/);
    // The operator's own words, so the approval is measurable against a shape
    // rather than a summary — including the instruction not to relabel it.
    expect(section17).toMatch(/Do not describe it as the existing no-tools posture; record the distinction/);
    // And the bound the approval itself carried.
    expect(section17).toMatch(
      /does \*\*not\*\* cover changing any operational session's settings or enabling the feature on a live session/,
    );
  });

  test('the limitation is stated at every place the posture is, never once and then softened', () => {
    expect(section17).toMatch(/\*\*reads by the agent are available\*\*/);
    expect(section17).toMatch(/A temporary cwd is not a read\s+jail/);
    expect(section17).toMatch(
      /"the bundle is the entire input" is \*\*not\*\* guaranteed for a lineage\s+decided under it/,
    );
    // §8.2 itself says it, so a reader who never reaches §17 still learns it.
    expect(contract).toMatch(
      /\*\*One turn may run under a weaker, separately named posture, and only by explicit\s+opt-in\.\*\*/,
    );
    expect(contract).toMatch(/The reviewer's §4\.1 reconsideration . never the arbitration of this\s+section/);
  });

  test('the opt-in is default-off and is a second switch, in the doc and in the resolver', () => {
    expect(section17).toMatch(/a boolean\s+defaulting to `false`/);
    expect(section17).toMatch(/It is a second switch and not a widening of `enabled`/);
    // The resolver's own answer, not a second copy of it written here.
    expect(resolveReconsiderationProfile('codex', {}).profile).toBeUndefined();
    expect(resolveReconsiderationProfile('codex', {}, { readBounded: true }).profile.toolPolicy).toBe(
      'read-bounded',
    );
    expect(resolveReviewDisputeSettings({ enabled: true }).settings.reconsideration).toEqual({
      readBounded: false,
    });
    expect(
      resolveReviewDisputeSettings({ enabled: true, reconsideration: { readBounded: true } }).settings
        .reconsideration,
    ).toEqual({ readBounded: true });
    // A non-boolean is refused rather than coerced into either answer.
    expect(resolveReviewDisputeSettings({ reconsideration: { readBounded: 'true' } }).ok).toBe(false);
  });

  test('the argv the section pins is the argv the resolver builds, and shares §17.11’s constant', () => {
    const { profile } = resolveReconsiderationProfile('codex', {}, { readBounded: true });
    expect([...RECONSIDERATION_READ_BOUNDED_ARGS]).toEqual([...CODEX_STRUCTURED_REVIEW_EXEC_ARGS]);
    expect(profile.argv).toEqual(
      expect.arrayContaining(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config']),
    );
    // Two flags the section says are NOT pinned for this turn.
    expect(profile.argv).not.toContain('--output-schema');
    expect(section17).toMatch(/No `--output-schema`: a §4\.1 record is not the §2\.1 envelope/);
    expect(section17).toMatch(/No bypass flag exists to be set/);
    const argv = buildReconsiderationArgv(profile, { lastMessagePath: '/tmp/x' }).join(' ');
    for (const forbidden of ['--dangerously', 'bypass', '--full-auto', 'danger-full-access']) {
      expect(argv).not.toContain(forbidden);
    }
  });

  test('what D2 did not move is stated, and the runner still refuses each of those', () => {
    expect(section17).toMatch(/\*\*What did not move\.\*\* The `claude` lane is untouched/);
    expect(section17).toMatch(/C7 is still `unknown` and §17\.8's canary has still\s+not been run/);
    // The arbitration turn, the native review command and the §8.2 table are
    // read from the runner rather than from the sentence that claims them.
    expect(createArbiterCandidateResolver({ env: {} })('codex').ok).toBe(false);
    expect(STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS).toContain('codex');
    expect([...RECONSIDERATION_SUPPORTED_AGENTS]).toEqual(['claude']);
    // A claude reviewer is invoked exactly as before, opt-in or not.
    const before = resolveReconsiderationProfile('claude', {}).profile;
    const after = resolveReconsiderationProfile('claude', {}, { readBounded: true }).profile;
    expect(after).toEqual(before);
    expect(after.toolPolicy).toBe('no-tools');
  });

  test('the posture is recorded PER LINEAGE, so a later run cannot overwrite an earlier one', () => {
    // Issue #1085 review, P2. The single-valued summary describes the LAST
    // reviewer run, and D2's guarantee is about a LINEAGE — so the section names
    // the two surfaces that keep the association, and both are read from the
    // runner rather than from the sentence that claims them.
    expect(section17).toMatch(/carried, verbatim and never defaulted, through six places/);
    expect(section17).toMatch(/reviewDisputeReconsiderations/);
    expect(section17).toMatch(/reconsiderationsByLineage/);
    expect(section17).toMatch(/`review\.dispute\.subturn` event/);

    const task = {
      sessionId: 'demo',
      issueNumber: 1,
      status: 'queued',
      context: {
        reviewDispute: { version: 1, reviewStructure: 'structured', lineages: {} },
        // The newest run was `no-tools`; the older lineage was decided under the
        // weaker posture and must still say so.
        reviewDisputeReconsideration: {
          lineageId: 'ln-bbbbbbbbbbbb',
          version: 1,
          profile: { agentId: 'claude', toolPolicy: 'no-tools' },
        },
        reviewDisputeReconsiderations: {
          lineages: {
            'ln-aaaaaaaaaaaa': { version: 1, artifactDir: '/a', agentId: 'codex', toolPolicy: 'read-bounded' },
            'ln-bbbbbbbbbbbb': { version: 1, artifactDir: '/b', agentId: 'claude', toolPolicy: 'no-tools' },
          },
        },
      },
    };
    const status = summarizeDisputeStatus(task);
    expect(status.lastReconsideration.toolPolicy).toBe('no-tools');
    expect(status.reconsiderationsByLineage).toEqual([
      { lineageId: 'ln-aaaaaaaaaaaa', version: 1, agentId: 'codex', toolPolicy: 'read-bounded' },
      { lineageId: 'ln-bbbbbbbbbbbb', version: 1, agentId: 'claude', toolPolicy: 'no-tools' },
    ]);
  });

  test('§16 names the new suite, and it exists', () => {
    expect(CONTRACT_RAW).toContain('test/review-reconsideration-read-bounded.test.js');
    expect(() => read('test/review-reconsideration-read-bounded.test.js')).not.toThrow();
  });
});

describe('the runner still performs every refusal §17 describes', () => {
  test('`codex review` is still excluded from structured findings (§17.4 C9, §17.5 B1)', () => {
    // Unchanged by #1069, and deliberately so: this table answers for the native
    // review COMMAND, which is what a disabled session still runs and which
    // still has no seam for an output contract. §17.11's lane runs `codex exec`
    // and never consults it — removing the entry would route nothing and would
    // only start asking `codex review` for an envelope it cannot emit.
    expect(STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS).toContain('codex');
    expect(structuredFindingsSupport('codex')).toEqual({
      supported: false,
      reason: 'prompt-not-agent-authored',
    });
    // The comparison case: an agent whose prompt the runner authors is unaffected.
    expect(structuredFindingsSupport('claude')).toEqual({ supported: true });
    // And §17.11 says exactly that, so the code and the document agree on WHY
    // the entry stayed rather than on the entry alone.
    expect(section17).toMatch(
      /\*\*`STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS` is unchanged, deliberately\.\*\*/,
    );
  });

  test('codex is still refused for the reviewer’s reconsideration (§17.5 B2)', () => {
    const refused = resolveReconsiderationProfile('codex', {});
    expect(refused.profile).toBeUndefined();
    expect(refused.error).toMatch(/Unsupported reconsideration agent: codex/);
    expect(refused.error).toMatch(/only `claude` has a no-tools invocation defined/);
  });

  test('codex is still refused as an arbiter candidate, before independence is asked', () => {
    const resolution = createArbiterCandidateResolver({ env: {} })('codex');
    expect(resolution).toEqual({
      ok: false,
      reason: 'unsupported-role',
      detail: 'no-no-tools-invocation',
    });
  });

  test('claude remains the one agent with the §8.2 posture, in both dispute lanes', () => {
    const claude = resolveReconsiderationProfile('claude', {});
    expect(claude.error).toBeUndefined();
    expect(claude.profile.toolPolicy).toBe('no-tools');
    const arbiter = createArbiterCandidateResolver({ env: {} })('claude');
    expect(arbiter.ok).toBe(true);
    expect(arbiter.profile.toolPolicy).toBe('no-tools');
  });
});

describe('the divergence §17.5 names is real, and still only a divergence', () => {
  test('the refinement lane resolves a Codex profile the dispute lanes refuse', () => {
    const refinement = resolveRefinementRoleProfile('critic', 'codex', {});
    expect(refinement.error).toBeUndefined();
    // What §17.5 says that profile actually pins — writes, network and user
    // config, not reads.
    expect(refinement.profile.argv).toEqual(
      expect.arrayContaining(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config']),
    );
    // And the label it carries, which is exactly why §17.5 refuses the precedent.
    expect(refinement.profile.toolPolicy).toBe('no-tools');
    // The same agent id, same repository, opposite answer in the dispute lane.
    expect(createArbiterCandidateResolver({ env: {} })('codex').ok).toBe(false);
  });
});

describe('docs/review-dispute-operations.md — the operator-facing half', () => {
  test('§1.1 tells an operator what a codex reviewer does and does not get', () => {
    expect(ops).toMatch(/\*\*Codex specifically, since it is the other CLI most sessions already run\.\*\*/);
    expect(ops).toMatch(/A session with `reviewAgent: "codex"` is a supported, working configuration/);
    // Since #1069 the answer depends on the flag, and both halves are stated.
    expect(ops).toMatch(/\*\*Flag off\*\* . the legacy prose review, `codex review`/);
    expect(ops).toMatch(/\*\*Flag on\*\* . the runner-authored `codex exec` lane \(contract §17\.11\)/);
    expect(ops).toMatch(/Unchanged, byte for byte, from before the protocol existed/);
    // The turn a Codex reviewer CAN now take, the switch that admits it, and —
    // in the same breath — what accepting it costs. A document that stated the
    // capability without the limit would be the drift this file exists to catch.
    expect(ops).toMatch(/\*\*What you are accepting by setting it, stated as the contract states it\.\*\*/);
    expect(ops).toMatch(/"reconsideration": \{ "readBounded": true \}/);
    expect(ops).toMatch(/It does \*\*not\*\* bound reads/);
    expect(ops).toMatch(
      /A temporary working directory is not a read jail, and this document will not tell you otherwise/,
    );
    expect(ops).toMatch(/\*\*Rolling it back\.\*\*/);
    // The turn it still cannot take, and that no setting changes that one.
    expect(ops).toMatch(/What a Codex reviewer still cannot do is take the \*\*arbitration\*\* turn/);
    expect(ops).toMatch(/it is not a bug to report and not fixed by configuration/);
    // Leaving the opt-in off must read as a choice, not as a defect.
    expect(ops).toMatch(/\*\*Leaving it off is a supported configuration, not a degraded one\.\*\*/);
    // And the two fail-closed rules an operator will actually meet.
    expect(ops).toMatch(/does \*\*not\*\* produce a valid envelope never passes cleanly/);
    expect(ops).toMatch(/a clean verdict over a truncated diff also escalates/);
  });

  test('the pre-existing capability statement is unchanged, not softened', () => {
    expect(ops).toMatch(/\*\*Today only `claude` has a verified no-tools invocation\*\*/);
  });

  test('§10 records the limitation at its current width, without offering a workaround', () => {
    expect(ops).toMatch(
      /\*\*Only `claude` can take a dispute turn under the §8\.2 posture, so a Claude\/Codex pairing debates only as far as you have opted in\.\*\*/,
    );
    // The reason the §8.2 posture is unavailable is unchanged, and is still not
    // answered by the sandbox the weaker posture does use.
    expect(ops).toMatch(/Read-only sandboxing does not answer that . it bounds writes and network, not reads/);
    expect(ops).toMatch(
      /which is a decision about accepting unbounded reads in a verdict, not a fix for a defect/,
    );
    // Arbitration did not move with it, stated as its own line so the two are
    // never read as one capability.
    expect(ops).toMatch(/A Codex \*arbitration\* is refused, full stop\. D2 did not admit it and no setting turns it on/);
    // Issue #1070 met the gating rule, so an operator reading the tracker does
    // not have to guess how the decision was reached.
    expect(ops).toMatch(/Issue #1070 is the successor that tested the gating rule and honored it/);
    expect(ops).toMatch(
      /Treat the human handoff as the supported behavior of a Claude\/Codex pairing that has not opted in, not as a gap being worked around/,
    );
    // The limitation narrowed with D1 and §10 says how, so an operator is not
    // left reading a Codex reviewer as inert.
    expect(ops).toMatch(/with the flag on it runs the structured `codex exec` lane and opens real lineages/);
    expect(ops).toMatch(/the dispute reaches a human instead of an arbiter/);
  });

  test('§13.3 gives the exact opt-in, the rollback, and a smoke check that claims nothing it cannot', () => {
    expect(ops).toMatch(/### 13\.3 The read-bounded reconsideration: opt-in, rollback, and its own optional smoke check/);
    expect(ops).toMatch(/"reconsideration": \{ "readBounded": true \}/);
    expect(ops).toMatch(/toolPolicy=read-bounded/);
    expect(ops).toMatch(/it may bill one real Codex turn, and it is \*\*not\*\* a test/);
    // The step that keeps the procedure honest: the property this posture does
    // not have must not be "verified" by a run that happened not to exercise it.
    expect(ops).toMatch(
      /\*\*Do not attempt to confirm that no out-of-bundle read occurred . it is not prevented, and a run that happened not to read anything is not evidence that one could not\.\*\*/,
    );
    expect(ops).toMatch(/An unrun check is never a pass/);
  });

  test('§12 lists this test file and keeps the smoke check out of npm test', () => {
    expect(ops).toContain('test/docs-review-dispute-codex-capability.test.js');
    expect(ops).toMatch(
      /The one check that would spawn a real Codex CLI is contract §17\.8, and it is deliberately an operator procedure rather than a test/,
    );
  });
});

describe('both documents stay publicly exportable', () => {
  test('§17 carries no absolute local path, secret, or live webhook', () => {
    for (const raw of [CONTRACT_RAW, OPS_RAW]) {
      expect(raw).not.toMatch(/\/Users\//);
      expect(raw).not.toMatch(/\/home\/[a-z]/);
      expect(raw).not.toMatch(/hooks\.slack\.com/);
      expect(raw).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
    }
  });
});
