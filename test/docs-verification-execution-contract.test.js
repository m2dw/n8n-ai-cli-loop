/**
 * Structural tests for docs/verification-execution-contract.md
 * (issue #918).
 *
 * The document is the authoritative contract for runner-owned
 * verification execution and continuation: the consuming contract #917
 * §11.3's verification rows defer to. Issue #918 is a pure
 * specification: no production code changes with it, so these tests pin
 * the document's own claims — the closed lane, classification, and
 * cycle-outcome sets, the standing-authorization and runner-authority
 * rules (known verification never stops for a human; agent statements
 * about verification are inert), the environment-prepare prerequisite,
 * the deterministic operator-owned set resolution and the additive
 * verificationPolicy schema, the per-classification stop rules with the
 * single bounded never-launched relaunch and the set-budget deadline
 * clamp, the total classification
 * mapping with both no-masquerade rules, the one-cycle-one-outcome
 * aggregation and the complete evidence bundle (code failure and dirty
 * worktree travel together), the no-new-phase-runner-vocabulary
 * continuation table with its #917 §11.3 pinned-stop route, the
 * evidence-validated direct-to-review
 * continuation and the #722 verdict (validated with revisions R1–R6),
 * the bounded public-summary rule, the compatibility statements (review
 * admission unchanged, review-lane re-execution kept, Tool Request
 * state unchanged), the implementation decomposition, and the
 * reconciliation notes in docs/single-host-execution-backend-contract.md
 * §20, docs/preflight-execution-plan-contract.md §20,
 * docs/tool-request-grant-tiers-contract.md §18,
 * docs/environment-prepare-contract.md §3, docs/phase-contracts.md
 * (implementation success criteria), and docs/DOMAIN.md §5 that land
 * alongside it — against drift. They are structural only, mirroring the
 * doc-only pin pattern used for
 * docs/single-host-execution-backend-contract.md (#917).
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

const DOC_PATH = 'docs/verification-execution-contract.md';
const doc = read(DOC_PATH);
const backend = read('docs/single-host-execution-backend-contract.md');
const preflight = read('docs/preflight-execution-plan-contract.md');
const tiers = read('docs/tool-request-grant-tiers-contract.md');
const envPrepare = read('docs/environment-prepare-contract.md');
const phases = read('docs/phase-contracts.md');

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
    expect(doc).toMatch(/Status: \*\*approved design, not yet implemented\*\* \(issue #918\)/);
  });

  test('states its chain position as the successor of #917', () => {
    expect(doc).toMatch(
      /the successor of the single-host isolated ExecutionBackend contract \(#917\) in the executable chain/,
    );
    expect(doc).toMatch(
      /#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917 → #918 → #919 → #722/,
    );
  });

  test('declares itself the consuming contract of #917 §11.3 and adds no runtime behavior', () => {
    expect(doc).toMatch(
      /and this document is that consuming contract: it consumes #917's outcomes, it never re-defines them\./,
    );
    expect(doc).toMatch(/It adds no runtime behavior/);
  });

  test('defers to the fixed predecessor contracts it consumes', () => {
    expect(doc).toMatch(/fixed by `docs\/environment-prepare-contract\.md` §3\.1–§3\.3/);
    expect(doc).toMatch(/fixed by `docs\/single-host-execution-backend-contract\.md` \(#917\)/);
    expect(doc).toMatch(/fixed by `docs\/preflight-execution-plan-contract\.md` \(#915\)/);
    expect(doc).toMatch(/fixed by `docs\/tool-request-grant-tiers-contract\.md` \(#697\)/);
    expect(doc).toMatch(/fixed by `docs\/single-host-platform-sandbox-contract\.md` \(#916\)/);
    expect(doc).toMatch(/fixed by `docs\/guided-tool-request-flow\.md`; the human gate \*is\* that flow\./);
  });
});

describe(`${DOC_PATH} — closed sets (§2)`, () => {
  test('the lane set is closed', () => {
    expect(doc).toMatch(
      /The lane set is \*\*closed\*\*: `"implementation"` \| `"review"` \| `"conflict-resolution"` \| `"tool-request-continuation"` \(§4\)\. Adding a lane is a change to this document first\./,
    );
  });

  test('the per-command classification set is closed', () => {
    expect(doc).toMatch(
      /The set is closed: `"passed"` \| `"code-failure"` \| `"timeout"` \| `"infrastructure"` \| `"sandbox-policy"` \| `"tainted"` \| `"cancelled"` \| `"lost"` \| `"not-run"`\./,
    );
  });

  test('the cycle-outcome set is closed', () => {
    expect(doc).toMatch(
      /The set is closed: `"passed"` \| `"code-failed"` \| `"infrastructure"` \| `"sandbox-policy"` \| `"tainted"` \| `"cancelled"`\./,
    );
  });

  test('defines the verification-cycle identity #915 names without defining', () => {
    expect(doc).toMatch(
      /The \*\*verification-cycle identity\*\* is `\(taskAttempt, lane, cycleOrdinal\)`/,
    );
    expect(doc).toMatch(
      /`"per-verification-cycle"` occurrence window #915 §10 names without defining — defined here, consumed there\./,
    );
  });
});

describe(`${DOC_PATH} — standing authorization and runner authority (§3)`, () => {
  test('known verification never stops for a human', () => {
    expect(doc).toMatch(/\*\*`session\.verification` is standing operator authorization\.\*\*/);
    expect(doc).toMatch(/No additional human stop exists on the happy path\./);
  });

  test('the runner is authoritative and agent statements are inert', () => {
    expect(doc).toMatch(/\*\*The runner is authoritative for execution and routing\.\*\*/);
    expect(doc).toMatch(/an agent's \*statement\* that verification succeeded is inert/);
  });

  test('a successful command is not a completed implementation', () => {
    expect(doc).toMatch(/\*\*A successful command is not a completed implementation\.\*\*/);
  });
});

describe(`${DOC_PATH} — prerequisites and set resolution (§4–§5)`, () => {
  test('environment preparation is a fail-closed prerequisite', () => {
    expect(doc).toMatch(/No verification cycle launches against an unprepared or stale worktree/);
    expect(doc).toMatch(/\*\*A failed prepare stops before verification\.\*\*/);
    expect(doc).toMatch(
      /never recorded as a verification result and never fed to the agent as code evidence\./,
    );
  });

  test('set resolution is deterministic and operator-owned', () => {
    expect(doc).toMatch(
      /Every `session\.verification` entry, in declaration order, becomes one command of operation class `"verification\.run"`/,
    );
    expect(doc).toMatch(/one command of operation class `"verification\.pinned"`/);
    expect(doc).toMatch(
      /Plan entries join cycles in the `implementation` and `tool-request-continuation` lanes only/,
    );
    expect(doc).toMatch(
      /No issue text, agent output, PR content, or auto-detection contributes a command/,
    );
  });

  test('the set fingerprint binds identities without re-fingerprinting command bytes', () => {
    expect(doc).toMatch(
      /The \*\*set fingerprint\*\* is the SHA-256 of the canonical JSON of the ordered `\(name, operationClass, command identity\)` list/,
    );
    expect(doc).toMatch(/Command bytes are never re-fingerprinted/);
  });

  test('session.verification is preserved verbatim and the policy block is additive', () => {
    expect(doc).toMatch(
      /`session\.verification` itself is preserved verbatim as `Record<string, string>`/,
    );
    expect(doc).toMatch(/Introducing the default budget is a \*\*recorded behavioral change\*\*/);
  });

  test('session timeout policy never rewrites a plan-approved pinned budget', () => {
    expect(doc).toMatch(
      /It becomes `limits\.timeoutMs` on every resolved `"verification\.run"` spec/,
    );
    expect(doc).toMatch(
      /It never applies to a `"verification\.pinned"` command: a plan entry's budget is the approved contract's own `timeoutMs`/,
    );
    expect(doc).toMatch(
      /so an override can never reach a plan entry/,
    );
  });
});

describe(`${DOC_PATH} — lifecycle stop rules and retry discipline (§6)`, () => {
  test('code failures and timeouts continue the set; substrate failures stop it', () => {
    expect(doc).toMatch(/\*\*`code-failure` continues\.\*\*/);
    expect(doc).toMatch(/\*\*`timeout` continues\.\*\*/);
    expect(doc).toMatch(/\*\*`infrastructure` stops the set\*\* — after at most one transient relaunch/);
    expect(doc).toMatch(/\*\*`sandbox-policy` stops the set immediately, no retry\.\*\*/);
    expect(doc).toMatch(/\*\*`tainted` continues\.\*\*/);
    expect(doc).toMatch(/\*\*`cancelled` stops the set\.\*\*/);
  });

  test('the single relaunch is verification.run-only and pinned reservations stay settled', () => {
    expect(doc).toMatch(/This retry exists for `"verification\.run"` only/);
    expect(doc).toMatch(
      /a `"verification\.pinned"` never-launched run settles its reservation per #917 §12 rule 5 and its retry path is the next cycle, never a same-window relaunch/,
    );
  });

  test('setTimeoutMs is a hard deadline for the running command, not only a launch gate', () => {
    expect(doc).toMatch(
      /effective `limits\.timeoutMs` of `min\(per-command budget, remaining set budget\)`/,
    );
    expect(doc).toMatch(/no launched command can outlive the set budget/);
    expect(doc).toMatch(
      /For a `"verification\.pinned"` entry the per-command term is its plan-approved budget \(§5\.2\), never session policy/,
    );
    expect(doc).toMatch(/nothing here ever extends a pinned budget past its approved value/);
    expect(doc).toMatch(
      /A command killed because the clamped budget expired classifies `timeout` exactly like a per-command expiry/,
    );
    expect(doc).toMatch(/records `"not-run"` \(reason `set-budget-exhausted`\)/);
  });

  test('code failures and timeouts are never auto-retried', () => {
    expect(doc).toMatch(/The runner never auto-retries a `code-failure` or a `timeout`\./);
  });
});

describe(`${DOC_PATH} — classification honesty (§7)`, () => {
  test('the mapping is total over #917 outcomes', () => {
    expect(doc).toMatch(/\| `ran`, nonzero exit \| — \| `code-failure` \|/);
    expect(doc).toMatch(/\| `refused` \| — \| `sandbox-policy`, carrying the §11\.2 refusal reason verbatim \|/);
  });

  test('neither direction of masquerade is permitted', () => {
    expect(doc).toMatch(
      /\*\*Infrastructure and isolation failures never masquerade as code failures\.\*\*/,
    );
    expect(doc).toMatch(/\*\*A code failure is never laundered into an infrastructure retry\.\*\*/);
  });
});

describe(`${DOC_PATH} — aggregation and the evidence bundle (§8)`, () => {
  test('one escalation resolves one complete set', () => {
    expect(doc).toMatch(/Every escalation resolves all verification results as one set\./);
    expect(doc).toMatch(/\*\*Complete, not first-failure\.\*\*/);
    expect(doc).toMatch(/neither the agent nor the operator ever resolves one command at a time/);
  });

  test('the precedence table maps lost with infrastructure', () => {
    expect(doc).toMatch(/\| 3 \| `infrastructure` or `lost` \| `infrastructure` \|/);
  });

  test('code failure and dirty worktree travel together, bound to identities', () => {
    expect(doc).toMatch(/\*\*Code failure and dirty worktree travel together\.\*\*/);
    expect(doc).toMatch(/\*\*Evidence binds to identities, not to time\.\*\*/);
  });
});

describe(`${DOC_PATH} — continuation adds no phase-runner vocabulary (§9)`, () => {
  test('no new outcome, result, or status vocabulary exists', () => {
    expect(doc).toMatch(
      /\*\*No new phase-runner vocabulary exists\*\*: no new `PhaseRunOutcome` member, no new `PhaseHandlerResult` member, no new `TaskStatus`, and no change to `nextPhaseAfter`'s transition set/,
    );
  });

  test('substrate cycles never consume agent resources', () => {
    expect(doc).toMatch(
      /\*\*An infrastructure or sandbox-policy cycle never consumes an agent resource\.\*\*/,
    );
    expect(doc).toMatch(/no agent invocation, no repair attempt consumed, no code blame in the bundle/);
    expect(doc).toMatch(/never `needs_fix`, never an agent turn/);
  });

  test('a pinned stop keeps its #917 §11.3 containment-unavailable route', () => {
    expect(doc).toMatch(/\*\*A pinned stop keeps its #917 §11\.3 route\.\*\*/);
    expect(doc).toMatch(
      /falling through #915 §9's ordinary refusal chain — never a fallback to the shipped mechanism or another backend, and never this table's generic phase failure/,
    );
    expect(doc).toMatch(
      /A pinned command classified `lost` keeps the table's `infrastructure` cell/,
    );
  });

  test('caps stay lane-owned and the continuation lane routes through existing vocabulary', () => {
    expect(doc).toMatch(/\*\*Caps stay lane-owned and unchanged\.\*\*/);
    expect(doc).toMatch(
      /full pass → re-queue `\{queued, review\}`; any miss → re-queue `\{queued, implementation\}`/,
    );
  });
});

describe(`${DOC_PATH} — direct routing to review and the #722 verdict (§10)`, () => {
  test('states the acceptance boundary against blind routing', () => {
    expect(doc).toMatch(/\*\*no blind review routing after arbitrary successful commands\.\*\*/);
  });

  test('eligibility is routing metadata over the shipped matching semantics', () => {
    expect(doc).toMatch(
      /its command matches a configured `session\.verification` value under the shipped matching semantics/,
    );
    expect(doc).toMatch(/This classification is \*\*routing metadata only\*\*\./);
  });

  test('issue-required-only matches are excluded from eligibility', () => {
    expect(doc).toMatch(
      /A request matching only an issue-required verification command — one the issue body demands but no `session\.verification` value covers — is deliberately \*\*not\*\* eligible/,
    );
    expect(doc).toMatch(
      /Direct routing would trade the no-op implementation detour for a review blocked on unexecuted required verification\./,
    );
  });

  test('the evidence checklist runs E1 through E7, all-or-implementation', () => {
    expect(doc).toMatch(/\*\*E1 — branch\*\*/);
    expect(doc).toMatch(/\*\*E4 — clean worktree\*\*/);
    expect(doc).toMatch(/\*\*E5 — pushed commit\*\*/);
    expect(doc).toMatch(/\*\*E7 — evidence freshness\*\*/);
    expect(doc).toMatch(
      /each launched command's recorded `requestDigest` \(§8\.2\) must equal the digest the current binding yields/,
    );
    expect(doc).toMatch(
      /E7 fails only when configuration or a backend binding changed mid-flight — and it fails closed/,
    );
    expect(doc).toMatch(
      /There is no hard-failure route out of evidence validation and no partial credit: all seven or implementation\./,
    );
  });

  test('the #722 verdict is validated with revisions R1–R6', () => {
    expect(doc).toMatch(
      /\*\*Validated, with the following revisions required before #722 is implemented\*\*/,
    );
    expect(doc).toMatch(/The guided run's success is never review-admission evidence\./);
    expect(doc).toMatch(/All-or-implementation, never partial credit\./);
    expect(doc).toMatch(/the route is `\{queued, review\}` issued by the resolution surface/);
    expect(doc).toMatch(/`docs\/guided-tool-request-flow\.md` §4 gains the continuation rule/);
  });
});

describe(`${DOC_PATH} — observability and compatibility (§11–§12)`, () => {
  test('public summaries are bounded to names, classifications, and counts', () => {
    expect(doc).toMatch(/receive \*\*names, classifications, and counts only\*\*/);
    expect(doc).toMatch(/never a #917 refusal `detail`/);
    expect(doc).toMatch(/`verification_cycle_completed`/);
  });

  test('review admission is unchanged and the review lane keeps re-executing', () => {
    expect(doc).toMatch(
      /`checkReviewAdmission` \(#681\) keeps exactly its four checks; \*\*no verification evidence is added to admission\*\*/,
    );
    expect(doc).toMatch(/The review lane re-executes the session-configured set in its own worktree/);
  });

  test('phase transitions and Tool Request state are unchanged', () => {
    expect(doc).toMatch(/`nextPhaseAfter` is untouched/);
    expect(doc).toMatch(
      /the #678 failed-clean requeue, and the #404 no-op-resume success are all unchanged/,
    );
  });

  test('the decomposition assigns V6 to #722 and numbers to the tracker', () => {
    expect(doc).toMatch(/the tracker, not this document, assigns numbers; V6 is #722's slice/);
    expect(doc).toMatch(/\| V6 \(#722\) \|/);
  });

  test('rejected-this-cycle non-goals are recorded', () => {
    expect(doc).toMatch(
      /\*\*Evidence reuse to skip the review lane's re-execution\*\* — rejected this cycle/,
    );
    expect(doc).toMatch(/\*\*Flake detection, rerun-to-green, or quarantine\*\*/);
  });
});

describe(`${DOC_PATH} — reconciliation notes in the predecessor documents`, () => {
  test('docs/single-host-execution-backend-contract.md §20 records the delivery', () => {
    expect(backend).toMatch(/\*\*Delivered \(#918\)\*\*: `docs\/verification-execution-contract\.md` —/);
    expect(backend).toMatch(/the consuming contract this document's §11\.3 verification rows defer to/);
    expect(backend).toMatch(
      /The backend engines, run registry, selection wiring, and packaging changes remain with the chain's later issues \(#919 onward\)\./,
    );
  });

  test('docs/preflight-execution-plan-contract.md §20 records the delivery', () => {
    expect(preflight).toMatch(/\*\*Delivered \(#918\)\*\*: `docs\/verification-execution-contract\.md` —/);
    expect(preflight).toMatch(
      /defines the verification-cycle identity the `"per-verification-cycle"` occurrence window keys on/,
    );
  });

  test('docs/tool-request-grant-tiers-contract.md §18 records the delivery', () => {
    expect(tiers).toMatch(/\*\*Delivered \(#918\)\*\*: `docs\/verification-execution-contract\.md` —/);
    expect(tiers).toMatch(/never on a successful command alone/);
  });

  test('docs/environment-prepare-contract.md §3 records the extension', () => {
    expect(envPrepare).toMatch(/\*\*Extended by #918\.\*\*/);
    expect(envPrepare).toMatch(
      /fixed by \[docs\/verification-execution-contract\.md\]\(verification-execution-contract\.md\) \(#918\), which consumes this section without restating it\./,
    );
  });

  test('docs/phase-contracts.md names verification in the implementation success criteria', () => {
    expect(phases).toMatch(
      /Configured verification \(`session\.verification`\) passes before commit\/push/,
    );
  });

  domainTest('docs/DOMAIN.md §5 records the decided contract', () => {
    expect(domain).toMatch(
      /\*\*Verification execution contract decided \(#918\)\*\* — `docs\/verification-execution-contract\.md`/,
    );
    expect(domain).toMatch(/validated with revisions R1–R6/);
  });
});
