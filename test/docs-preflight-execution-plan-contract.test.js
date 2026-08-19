/**
 * Structural tests for docs/preflight-execution-plan-contract.md (issue #915).
 *
 * The document is the authoritative contract for the preflight Execution
 * Plan: a durable, operator-approvable record — produced before
 * write-capable implementation begins — of the environment-preparation,
 * verification, and predictable Tool Request operations an issue or chain
 * segment is expected to need. Issue #915 is a pure specification: no
 * production code changes with it, so these tests pin the document's own
 * claims — the typed-operation unit of approval (never command text), the
 * closed refusal-reason and plan-state sets, the seven-axis pinned
 * operation contract, the nominate-never-authorize contribution rule, the
 * fingerprint/invalidation semantics that make stale approval unreusable,
 * the locator-addressed evidence re-derivation rule, the session-config
 * command-reference (no command bytes) rule, the approval non-implications
 * (no code trust, no text matching, no
 * standing grant, no schedule), the runner-decides rule, the
 * subtracts-nothing fallthrough into the #697 flow with its
 * occurrence-exhausted carve-out, the reservation-before-launch
 * consumption rule, the typed-identity uniqueness rule, the chain-scope
 * membership-evidence rule, the cover-bounded retirement rule, the
 * no-scheduler chain rule, both examples, the §16 compatibility statements, and the
 * delivery-note reconciliation in docs/tool-request-grant-tiers-contract.md
 * and docs/DOMAIN.md that lands alongside it — against drift. They are
 * structural only, mirroring the doc-only pin pattern used for
 * docs/tool-request-grant-tiers-contract.md (#697).
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the document is
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document
// says, not how it happens to be wrapped.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/preflight-execution-plan-contract.md';
const doc = read(DOC_PATH);
const tiers = read('docs/tool-request-grant-tiers-contract.md');

// docs/DOMAIN.md is a PRIVATE_ONLY_PATH (copybara/copy.bara.sky): the public
// mirror never receives it, and a test that unconditionally loads it couples
// this file to material the exported tree lacks — a dangling ENOENT in the
// public repo's own CI (issue #811). The DOMAIN.md reconciliation pins below
// therefore run only where the document exists (the private source of truth)
// and skip cleanly in the exported tree.
const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;
const domainTest = domain === null ? test.skip : test;

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked approved design, not yet implemented', () => {
    expect(doc).toMatch(/Status: \*\*approved design, not yet implemented\*\* \(issue #915\)/);
  });

  test('states its chain position as the first successor of #697', () => {
    expect(doc).toMatch(/the first successor of the grant-tiers contract in the executable chain/);
    expect(doc).toMatch(
      /#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917 → #918 → #919 → #722/,
    );
  });

  test('defers to the fixed predecessor contracts it consumes', () => {
    expect(doc).toMatch(/fixed by `docs\/tool-request-grant-tiers-contract\.md` \(#697\)/);
    expect(doc).toMatch(/fixed by `docs\/tool-request-and-dependency-sync\.md` §2/);
    expect(doc).toMatch(/fixed by `docs\/guided-tool-request-flow\.md`/);
    expect(doc).toMatch(/fixed by `docs\/environment-prepare-contract\.md`/);
    expect(doc).toMatch(/`docs\/operation-dispatch-port-contract\.md` §4\.1/);
  });

  test('defines the plan in one sentence as an allowlist extension, not an executor', () => {
    expect(doc).toMatch(
      /issue-\/chain-scoped, snapshot-fingerprinted, operator-approved extension of the #697 session allowlist/,
    );
    expect(doc).toMatch(/\*\*The plan is not a fifth executor\.\*\*/);
    expect(doc).toMatch(/It executes nothing, owns no subprocess, and introduces no new way for bytes to run/);
  });
});

describe(`${DOC_PATH} — the schema (§4)`, () => {
  test('the unit of approval is a typed operation contract, never command text', () => {
    expect(doc).toMatch(/approval applies to a typed operation contract, not to matching command text/);
    expect(doc).toMatch(/There is no field in which free command text could be planned as an authorizable unit/);
  });

  test('every evidence item carries a typed locator and versioned canonicalization', () => {
    expect(doc).toMatch(/locator: EvidenceLocator/);
    expect(doc).toMatch(/\*\*Every baseline evidence item is re-derivable from its own fields\.\*\*/);
    expect(doc).toMatch(/nothing about retrieval is left to implementation choice/);
    expect(doc).toMatch(
      /approval freezes not only what the evidence bytes were but how to fetch and canonicalize them again/,
    );
  });

  test('session-config pins store a command reference and digest, never the bytes', () => {
    expect(doc).toMatch(/commandRef: SessionConfigLocator/);
    expect(doc).toMatch(
      /stores `commandRef` \(the §4 session-config locator\) and `commandDigest` only, never the bytes/,
    );
  });

  test('the pinned contract fixes all seven policy axes per operation', () => {
    expect(doc).toMatch(
      /The pinned operation contract fixes all seven policy axes per operation\*\* — command \(or in-process routine\), cwd, environment, network, timeout, output, and side-effect policy/,
    );
  });

  test('session-mechanism is a recording value legal only on session-default entries', () => {
    expect(doc).toMatch(/`"session-mechanism"` is a recording value, not a grant/);
    expect(doc).toMatch(/legal only on `"session-default"` entries/);
  });

  test('the tier field is required on plan-approval entries and ceiling-validated at assembly', () => {
    expect(doc).toMatch(
      /`tier` names the #697 execution tier a `"plan-approval"` entry runs at — the value a session allowlist entry would carry/,
    );
    expect(doc).toMatch(/validated at assembly against the operation's #697 §9 ceiling/);
  });

  test('package-registry is plan vocabulary that fails closed until a capability exists', () => {
    expect(doc).toMatch(/`"package-registry"` is plan vocabulary, defined here/);
    expect(doc).toMatch(/\*\*not\*\* a member of #697's registry policy triple/);
    expect(doc).toMatch(
      /until then resolution refuses it `"containment-unavailable"` \(§9\), fail-closed/,
    );
  });

  test('unresolved entries predict a human gate and are never authorizable', () => {
    expect(doc).toMatch(/a prediction of a human gate, not a pending authorization/);
    expect(doc).toMatch(/Unresolved entries are never authorizable under any approval state/);
  });

  test('plan validation throws at assembly, fail-closed', () => {
    expect(doc).toMatch(/\*\*throws at assembly\*\* — a bad plan is a defect, not an input/);
  });

  test('chain scopes carry and match re-derivable membership evidence', () => {
    expect(doc).toMatch(
      /a `scope\.chainId` without exactly one `baseline\.evidence` item whose locator is `\{ source: "chain-registry", chainId: scope\.chainId \}`/,
    );
    expect(doc).toMatch(
      /the frozen issue list is the evidenced membership verbatim, never a hand-supplied list/,
    );
    expect(doc).toMatch(
      /a `"plan-approval"` resolved entry of a chain-scoped plan whose `assumptions` omit that evidence's name/,
    );
  });

  test('the authorizable typed identity is unique, merged deterministically across layers', () => {
    expect(doc).toMatch(/\*\*The authorizable typed identity is unique within a plan\.\*\*/);
    expect(doc).toMatch(
      /merges same-identity contributions from different layers into a single entry, deterministically, before validation/,
    );
    expect(doc).toMatch(/the merged entry is `"session-default"`/);
    expect(doc).toMatch(/`origin` is the earliest nominating layer in §5's table order/);
  });
});

describe(`${DOC_PATH} — contribution and provenance (§5)`, () => {
  test('contribution layers nominate and never authorize', () => {
    expect(doc).toMatch(/\*\*contribution layers nominate; they never authorize\*\*/);
  });

  test('the non-derivation rule is preserved: approval converts a derived pin into an operator-set one', () => {
    expect(doc).toMatch(/the runner executes only what the operator set — is preserved, not relaxed/);
    expect(doc).toMatch(/Approval is what converts a derived pin into an operator-set one/);
  });

  test('issue-specific needs are covered without routine sessions.json edits', () => {
    expect(doc).toMatch(/\*\*without requiring routine edits to `sessions\.json`\*\*/);
  });
});

describe(`${DOC_PATH} — snapshot, fingerprint, and approval (§6–§8)`, () => {
  test('snapshots are immutable and any covered change yields a different fingerprint', () => {
    expect(doc).toMatch(/\*\*Snapshots are immutable and append-only\.\*\*/);
    expect(doc).toMatch(
      /A changed command, a changed policy value, a changed side-effect declaration, or a changed baseline assumption each yield a different fingerprint/,
    );
  });

  test('baseline assumptions are content-addressed, never head-SHA-addressed', () => {
    expect(doc).toMatch(/\*\*Baseline assumptions are content-addressed, never head-SHA-addressed\.\*\*/);
  });

  test('recording exposes no secrets and no local absolute paths', () => {
    expect(doc).toMatch(/no absolute path is representable/);
    expect(doc).toMatch(/local and operator-visible, never posted to a public surface/);
  });

  test('a secret in an operator command is unrepresentable in durable plan artifacts', () => {
    expect(doc).toMatch(/unrepresentable in durable plan artifacts by construction, not by scanning/);
    expect(doc).toMatch(
      /re-derives the bytes from `commandRef` for the approval display and verifies them against `commandDigest` first/,
    );
  });

  test('evidence re-derivation is deterministic and locators are frozen by the fingerprint', () => {
    expect(doc).toMatch(/\*\*Re-derivation is deterministic by construction\.\*\*/);
    expect(doc).toMatch(
      /a plan can never be revalidated against different bytes than its approval displayed/,
    );
    expect(doc).toMatch(/names, sources, locators, canonicalization ids, and their content fingerprints/);
  });

  test('one approval covers the whole plan instead of each occurrence', () => {
    expect(doc).toMatch(/\*\*One approval covers the whole plan\.\*\*/);
    expect(doc).toMatch(/approve the full plan once instead of approving each occurrence/);
  });

  test('approval never implies trust in the code the operation executes', () => {
    expect(doc).toMatch(/\*\*Not trust in the code the operation will execute\.\*\*/);
    expect(doc).toMatch(/Preflight approval must not imply that future modified test code is trusted/);
    expect(doc).toMatch(/The executed repository code remains untrusted at all times/);
  });

  test('approval is not text matching, not a standing grant, and not a schedule', () => {
    expect(doc).toMatch(/\*\*Not text matching\.\*\*/);
    expect(doc).toMatch(/\*\*Not a standing session grant\.\*\*/);
    expect(doc).toMatch(/\*\*Not a schedule\.\*\*/);
  });

  test('renewal is always a new snapshot plus a new approval; stale approval never silently reuses', () => {
    expect(doc).toMatch(/\*\*Renewal is always a new snapshot plus a new approval\*\*/);
    expect(doc).toMatch(/No stale approval is ever silently reused/);
  });
});

describe(`${DOC_PATH} — authorization resolution (§9)`, () => {
  test('the refusal reasons are a closed eight-member set', () => {
    expect(doc).toMatch(
      /`"preflight-disabled"` \| `"no-plan"` \| `"not-in-plan"` \| `"plan-unapproved"` \| `"plan-stale"` \| `"assumption-failed"` \| `"containment-unavailable"` \| `"occurrence-exhausted"` — a closed set/,
    );
  });

  test('scope matching is exact on session, repository, and issue', () => {
    expect(doc).toMatch(/Scope identity is exact on all three axes, never issue number alone/);
  });

  test('unresolved entries are structurally unmatchable, not a refusal branch', () => {
    expect(doc).toMatch(/Unresolved entries carry neither field and participate in no match/);
  });

  test('a plan-approval verdict enters #697 §7 in the allowlist verdict\'s place', () => {
    expect(doc).toMatch(/\*\*The plan-approval handoff\.\*\*/);
    expect(doc).toMatch(
      /`resolveGrantTier` is not additionally called for the occurrence — it is the fallthrough authority, reached only on refusal/,
    );
  });

  test('agent free-text fields are never read by preflight resolution', () => {
    expect(doc).toMatch(
      /The request's free-text `command` and `reason` fields are \*\*never read\*\* by preflight resolution/,
    );
  });

  test('the runner, not the implementation agent, decides', () => {
    expect(doc).toMatch(/\*\*The runner, not the implementation agent, decides\.\*\*/);
    expect(doc).toMatch(/there is no agent-writable input that flips it/);
  });

  test('preflight is consulted first and refusals fall through, subtracting nothing', () => {
    expect(doc).toMatch(/consults preflight authorization \*\*first\*\*/);
    expect(doc).toMatch(/\*\*a preflight refusal subtracts nothing\*\*/);
  });

  test('a revoked plan authorizes nothing: rule 5 reads the lifecycle state, not the record', () => {
    expect(doc).toMatch(
      /requires the active snapshot to stand in lifecycle state `approved` \(§11\) at this consult/,
    );
    expect(doc).toMatch(/the record alone proves nothing/);
    expect(doc).toMatch(
      /A surviving `decision: "approved"` record for the same fingerprint is never sufficient on its own/,
    );
  });

  test('occurrence-exhausted parks as a direct human handoff, never the legacy route', () => {
    expect(doc).toMatch(/\*\*The `"occurrence-exhausted"` carve-out\.\*\*/);
    expect(doc).toMatch(/the plan-side mirror of #697 §6 rule 6's `"already-executed"`/);
    expect(doc).toMatch(/parks as a \*\*direct human handoff\*\*/);
    expect(doc).toMatch(
      /`resolveGrantTier` is not consulted and the legacy route is never reached for the occurrence/,
    );
    expect(doc).toMatch(/repeat protection outranks fallthrough/);
  });
});

describe(`${DOC_PATH} — family semantics and lifecycle (§10–§11)`, () => {
  test('report-only runs adopt nothing and adopt-changes runs are #697 relaxed-tier runs', () => {
    expect(doc).toMatch(/\*\*Report-only runs adopt nothing, ever\.\*\*/);
    expect(doc).toMatch(/\*\*Adopt-changes runs are #697 relaxed-tier runs\.\*\*/);
  });

  test('the plan states are a closed five-member set with no edge back into approved', () => {
    expect(doc).toMatch(/`"snapshotted" \| "approved" \| "declined" \| "revoked" \| "superseded"`/);
    expect(doc).toMatch(/there is no edge back into `approved`/);
    expect(doc).toMatch(/Staleness is deliberately \*\*not\*\* a stored state/);
  });

  test('cross-lineage retirement is cover-bounded and a partial overlap refuses scope-conflict', () => {
    expect(doc).toMatch(/cross-lineage retirement is \*\*cover-bounded\*\*/);
    expect(doc).toMatch(
      /\*\*refuses the insert\*\* with the typed port result `"scope-conflict"`/,
    );
    expect(doc).toMatch(
      /\*\*a snapshot never withdraws authority from an issue it does not cover\*\*/,
    );
  });

  test('the events are their own closed vocabulary', () => {
    expect(doc).toMatch(
      /`preflight_plan_snapshotted`, `preflight_plan_superseded`, `preflight_plan_approved`, `preflight_plan_declined`, `preflight_plan_revoked`, `preflight_authorization_resolved`/,
    );
    expect(doc).toMatch(/`preflight_entry_consumed`/);
  });

  test('occurrence capacity is reserved before launch and settled after the run', () => {
    expect(doc).toMatch(/\*\*Occurrence capacity is reserved before launch, then settled\.\*\*/);
    expect(doc).toMatch(/commits \*\*before the operation launches\*\*/);
    expect(doc).toMatch(/a changed plan cannot relaunch a consumed operation/);
    expect(doc).toMatch(/`reservePlanOccurrence\(taskScope, planFingerprint, entryId, occurrenceKey\)`/);
    expect(doc).toMatch(/`settlePlanOccurrence\(taskScope, planFingerprint, entryId, occurrenceKey, runRef\)`/);
    expect(doc).toMatch(/`preflight_entry_reserved`/);
  });

  test('the occurrence key carries the task scope so chain siblings never contend', () => {
    expect(doc).toMatch(
      /`\(sessionId, repo, issueNumber, operationId, params digest, occurrenceKey\)`/,
    );
    expect(doc).toMatch(/the leading scope triple is the need's runner-injected task identity/);
    expect(doc).toMatch(/with it they are disjoint occurrences by construction/);
  });

  test('an unsettled reservation is ambiguous and counts as consumed', () => {
    expect(doc).toMatch(/\*\*An unsettled reservation is ambiguous and counts as consumed\.\*\*/);
    expect(doc).toMatch(/There is no automatic release and no operator release port/);
  });

  test('the master switch defaults off and absent config is byte-for-byte pre-#915 behavior', () => {
    expect(doc).toMatch(/`enabled` defaults to \*\*off\*\*/);
    expect(doc).toMatch(/every behavior in the loop is byte-for-byte pre-#915/);
  });
});

describe(`${DOC_PATH} — chains, examples, and compatibility (§13–§16)`, () => {
  test('no new chain scheduler is introduced', () => {
    expect(doc).toMatch(/\*\*No new chain scheduler is introduced\.\*\*/);
    expect(doc).toMatch(/The plan never orders, triggers, blocks, or re-queues issues/);
  });

  test('carries a Node.js example and a language-neutral example', () => {
    expect(doc).toMatch(
      /"commandRef": \{ "source": "session-config", "keyPath": \["environmentPrepare", "command"\] \}/,
    );
    expect(doc).toMatch(/"command": "npm run test:integration"/);
    expect(doc).toMatch(/"operationId": "dependency\.sync"/);
    expect(doc).toMatch(/"locator": \{ "source": "chain-registry", "chainId": "svc-hardening" \}/);
    expect(doc).toMatch(/"command": "make lint"/);
  });

  test('consumes #697 whole and extends it nowhere', () => {
    expect(doc).toMatch(/\*\*Consumed whole, extended nowhere\.\*\*/);
    expect(doc).toMatch(
      /With `preflight` disabled or absent, every #697 outcome is byte-for-byte unchanged/,
    );
  });

  test('the Tool Request emission contract and scoped grants are untouched', () => {
    expect(doc).toMatch(/\*\*The emission contract is untouched\.\*\*/);
    expect(doc).toMatch(/\*\*Scoped grants \(§2\.6\) are unchanged and orthogonal\.\*\*/);
  });

  test('free-form agent-proposed shell never gains automatic authorization', () => {
    expect(doc).toMatch(/Free-form agent-proposed shell never gains automatic authorization/);
    expect(doc).toMatch(/a plan gives free-form text no new route/);
  });

  test('runtime execution and platform isolation are deferred to the later chain issues', () => {
    expect(doc).toMatch(/\*\*Runtime execution and platform isolation\*\*/);
    expect(doc).toMatch(/#916 onward; see the issue body for the authoritative GitHub Issue Relationships/);
  });

  test('names its own docs pin', () => {
    expect(doc).toMatch(/test\/docs-preflight-execution-plan-contract\.test\.js/);
  });
});

describe(`${DOC_PATH} — reconciliation landed alongside`, () => {
  test('the grant-tiers contract §18 marks its #915 pointer delivered', () => {
    expect(tiers).toMatch(
      /\*\*Delivered \(#915\)\*\*: `docs\/preflight-execution-plan-contract\.md` — the preflight Execution Plan contract/,
    );
    expect(tiers).toMatch(
      /with a preflight refusal always falling through to this contract's flow unchanged/,
    );
  });

  domainTest('DOMAIN.md §5 item 4 records the preflight contract as decided', () => {
    expect(domain).toMatch(/\*\*Preflight contract decided \(#915\)\*\*/);
    expect(domain).toMatch(
      /`docs\/preflight-execution-plan-contract\.md`: the durable preflight Execution Plan over #697's typed operations/,
    );
  });
});
