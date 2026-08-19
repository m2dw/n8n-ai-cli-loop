/**
 * Structural tests for docs/unattended-tool-request-contract.md
 * (issue #919).
 *
 * The document is the authoritative contract for unattended Tool Request
 * handling and human parking: the chain's final design issue, integrating
 * the #697/#915/#916/#917/#918 contracts into one decision and
 * continuation model. Issue #919 is a pure specification: no production
 * code changes with it, so these tests pin the document's own claims —
 * the fixed authority order with its two direct-park carve-outs, the
 * derived request lifecycle with no new status column, the 30-row
 * normative decision and continuation table with its five rules and its
 * grant-alias mapping onto the guided-run rows, the never-durable
 * free-form rule and the human-gate floor, the mandatory
 * operator-response continuation context and the "auto-executed"
 * resolution record, the deterministic repeat and no-progress rules, the
 * parking contract (single park via ready_for_human, three-gate
 * independence, no chain scheduler, explain-never-loop), the preserved
 * work-product rules, the two new audit events, the reconciliation
 * statements (the #722 R1–R6 restatement included), the §2.5/§3.9
 * status-column supersession amendments that land with this document in
 * docs/tool-request-and-dependency-sync.md and
 * docs/guided-tool-request-flow.md, the 25-slice
 * dependency-ordered decomposition with its approval-first rule, and the
 * delivery notes in docs/tool-request-grant-tiers-contract.md §18,
 * docs/preflight-execution-plan-contract.md §20,
 * docs/single-host-execution-backend-contract.md §20,
 * docs/verification-execution-contract.md §16, and docs/DOMAIN.md §5
 * that land alongside it — against drift. They are structural only,
 * mirroring the doc-only pin pattern used for
 * docs/verification-execution-contract.md (#918).
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the document is
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document
// says, not how it happens to be wrapped. Row-count assertions use the
// raw text, where "one row per line" is itself the pinned property.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/unattended-tool-request-contract.md';
const doc = read(DOC_PATH);
const rawDoc = readFileSync(resolve(ROOT, DOC_PATH), 'utf8');
const tiers = read('docs/tool-request-grant-tiers-contract.md');
const preflight = read('docs/preflight-execution-plan-contract.md');
const backend = read('docs/single-host-execution-backend-contract.md');
const verification = read('docs/verification-execution-contract.md');
const depSync = read('docs/tool-request-and-dependency-sync.md');
const guidedFlow = read('docs/guided-tool-request-flow.md');

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
    expect(doc).toMatch(/Status: \*\*approved design, not yet implemented\*\* \(issue #919\)/);
  });

  test('states its chain position as the successor of #918 and the final design issue', () => {
    expect(doc).toMatch(
      /the successor of the runner-owned verification execution and continuation contract \(#918\) in the executable chain/,
    );
    expect(doc).toMatch(
      /#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917 → #918 → #919 → #722/,
    );
    expect(doc).toMatch(/It is the chain's final design issue/);
    expect(doc).toMatch(/It adds no runtime behavior/);
  });

  test('defers to the fixed predecessor contracts it consumes', () => {
    expect(doc).toMatch(
      /fixed by `docs\/tool-request-grant-tiers-contract\.md` \(#697\)\. This document adds no tier and no `TierRefusalReason` member\./,
    );
    expect(doc).toMatch(
      /fixed by `docs\/preflight-execution-plan-contract\.md` \(#915\)\. This document adds no `PreflightRefusalReason` member and no plan state\./,
    );
    expect(doc).toMatch(/fixed by `docs\/single-host-platform-sandbox-contract\.md` \(#916\)/);
    expect(doc).toMatch(
      /fixed by `docs\/single-host-execution-backend-contract\.md` \(#917\)\. This document adds no backend, class, outcome, or refusal reason\./,
    );
    expect(doc).toMatch(
      /fixed by `docs\/verification-execution-contract\.md` \(#918\), including the #722 verdict \(R1–R6\)/,
    );
    expect(doc).toMatch(/fixed by `docs\/tool-request-and-dependency-sync\.md`/);
    expect(doc).toMatch(
      /fixed by `docs\/guided-tool-request-flow\.md`; the human gate \*is\* that flow\. Its §4 continuation amendment belongs to #722 \(#918 §10\.5 R6\), not to this document\./,
    );
    expect(doc).toMatch(/fixed by `docs\/human-gate-no-go-flow\.md`/);
  });
});

describe(`${DOC_PATH} — closed vocabulary (§2)`, () => {
  test('the derived request-lifecycle set is closed and no status column is introduced', () => {
    expect(doc).toMatch(
      /`"pending" \| "auto-resolved" \| "parked" \| "operator-resolved" \| "continued"` \(§4\)/,
    );
    expect(doc).toMatch(
      /the stored record keeps exactly the shipped fields \(`resolved`, `resolution`\), and \*\*no `toolRequest\.status` column is introduced\*\*/,
    );
  });

  test('the continuation-destination set is closed over shipped vocabulary', () => {
    expect(doc).toMatch(
      /`\{queued, implementation\}` \| `\{queued, review\}` \(#918 §10 \/ #722, the only direct-to-review route\) \| remain `ready_for_human`\. No new `TaskStatus`, `PhaseRunOutcome`, or `PhaseHandlerResult` member exists\./,
    );
  });
});

describe(`${DOC_PATH} — authority order (§3)`, () => {
  test('routine approved verification never becomes a Tool Request stop', () => {
    expect(doc).toMatch(
      /\*\*Routine approved verification does not require a Tool Request stop\*\*/,
    );
  });

  test('the consult order is fixed with two direct-park carve-outs', () => {
    expect(doc).toMatch(
      /At the gate decision point the handler consults, in order, stopping at the first authority that serves the request \(#915 §9's precedence, adopted whole\)/,
    );
    expect(doc).toMatch(
      /Two refusals bypass the fallthrough by design and park directly: `"occurrence-exhausted"` \(#915 §9's carve-out\) and `"already-executed"` \(#697 §6 rule 6\) — repeat protection outranks fallthrough/,
    );
  });

  test('free-form approval is never durable', () => {
    expect(doc).toMatch(
      /\*\*No surface converts an approved free-form command into a standing allowlist entry, a plan entry, or any wildcard, and this contract adds none\.\*\*/,
    );
    expect(doc).toMatch(/`maxUses` defaulting to 1 and a short TTL/);
  });

  test('the human-gate floor is structural', () => {
    expect(doc).toMatch(
      /\*\*every free-form shell request\*\* \(no typed resolution\), \*\*dependency additions\*\* that resolve to no typed entry, \*\*credentials\*\*, \*\*spend\*\*, \*\*network access beyond a typed operation's declared policy\*\*, \*\*any canonical-repository mutation\*\*, and \*\*unresolved policy\*\*/,
    );
    expect(doc).toMatch(/a structural guarantee, not a classifier's opinion/);
  });
});

describe(`${DOC_PATH} — the decision and continuation table (§5)`, () => {
  const decisionSection = rawDoc
    .split('## 6. Human interaction')[0]
    .split('## 5. The decision and continuation table')[1];
  const rows = decisionSection.match(/^\| \d+ \|/gm) ?? [];

  test('carries exactly 30 single-line rows, numbered in order', () => {
    expect(rows).toHaveLength(30);
    rows.forEach((row, i) => expect(row).toBe(`| ${i + 1} |`));
  });

  test('parks land ready_for_human, never blocked, never failed', () => {
    expect(doc).toMatch(
      /Human park via the `tool_request` handler result: `ready_for_human`, never `blocked`, never `failed`/,
    );
  });

  test('repeat protections park directly, never re-entering the legacy route', () => {
    expect(doc).toMatch(
      /Direct human park \(§8\) carrying the prior occurrence's recorded outcome — or, when the window is spent by an unsettled reservation \(a crash before any outcome was recorded, #915 §10's ambiguous-reservation rule\), the dangling reservation state itself, so the §8\.4 explanation exists either way; `resolveGrantTier` and the legacy route are never consulted/,
    );
    expect(doc).toMatch(
      /never the legacy dependency route \(repeat protection outranks the migration exception\)/,
    );
  });

  test('direct-to-review is the single evidence-gated route', () => {
    expect(doc).toMatch(
      /Re-queue `\{queued, review\}` — the only direct-to-review route; any miss falls to row 27 with the failed check named/,
    );
    expect(doc).toMatch(
      /a passed runner-owned cycle plus the full E1–E7 state evidence — never a successful command alone, and never an agent statement/,
    );
  });

  test('the no-progress repeat and cross-gate rows are pinned', () => {
    expect(doc).toMatch(
      /No-progress repeat: direct human park carrying both the prior request and the operator response; no further automatic continuation for that identity within the task attempt/,
    );
    expect(doc).toMatch(
      /Refused `tool_request_unresolved`: a live Tool Request closes only through its own resolution surfaces/,
    );
  });

  test('the grant alias maps onto the guided-run rows', () => {
    expect(doc).toMatch(
      /The deprecated `grant` alias \(§3\.3\) has no rows of its own: a `grant`-surfaced resolution is a guided run and takes rows 21–25 verbatim/,
    );
    expect(doc).toMatch(
      /differing only in the recorded `resolution\.action` — `grant` instead of `guided-run`, so historical records still replay as "the command was run"/,
    );
    for (const row of [21, 22, 23, 24, 25]) {
      expect(doc).toContain(`| ${row} | Parked request | Operator: guided run (\`grant\` alias included) |`);
    }
  });

  test('the keep disposition preserves the shipped handoff', () => {
    expect(doc).toContain('Repository changes, disposition `keep` (the default)');
    expect(doc).toMatch(
      /The shipped keep handoff stands: the produced changes stay in place on the issue branch, the request stays unresolved, and the park holds — no automatic re-queue/,
    );
  });

  test('guided-run outcomes are recorded as dispositions, never as the resolution action', () => {
    expect(doc).toContain(
      'Resolve action `guided-run` with `resolution.disposition: "no-op"` and the captured result',
    );
    expect(doc).toContain(
      'resolve action `guided-run` with `resolution.disposition: "committed"`',
    );
    expect(doc).toContain(
      'resolve action `guided-run` with `resolution.disposition: "discarded"`',
    );
    expect(doc).toContain(
      'resolve action `guided-run` with `resolution.disposition: "failed"` and the captured result',
    );
    // `no-op`/`committed`/`discarded`/`failed` are ToolRequestDisposition
    // values, never valid `resolution.action` values.
    expect(doc).not.toMatch(/resolve `"(?:no-op|committed|discarded|failed)"`/);
  });

  test('the five table rules stand', () => {
    expect(doc).toMatch(/\*\*Consult order is fixed and complete\.\*\*/);
    expect(doc).toMatch(/\*\*Auto-execution is always the pinned substitution\.\*\*/);
    expect(doc).toMatch(
      /\*\*Every unattended request failure degrades into the shipped human flow; planned verification outcomes never enter it\.\*\*/,
    );
    expect(doc).toMatch(
      /\*\*Parking is single and typed\.\*\* Every park row lands `ready_for_human` via the `tool_request` handler result; at most one unresolved request exists per task \(`hasUnresolvedToolRequest` is the authority, #677\)/,
    );
    expect(doc).toMatch(/\*\*Continuation is evidence-routed\.\*\*/);
  });

  test('planned verification outcomes route through #918, never the rows 10–12 parks', () => {
    expect(doc).toMatch(/rows 10–12 never apply: no Tool Request exists to park/);
    for (const row of [10, 11, 12]) {
      expect(doc).toContain(
        `| ${row} | Request-resolving relaxed-tier execution (launched by rows 3–4 or 7–8) |`,
      );
    }
    expect(doc).toMatch(
      /a nonzero exit or timeout is `code-failure`\/`timeout` continuing the verification set into the repair loop as ordinary fix input/,
    );
  });

  test('backend refusal, infrastructure, and lost outcomes park with their record carried', () => {
    expect(doc).toMatch(
      /Backend `refused`\/`infrastructure` outcome — surfaced as `"containment-unavailable"` \(#697 §6 rule 4\)/,
    );
    expect(doc).toMatch(/or `lost` \(assigned only by reconciliation, #917 §8\.5\)/);
    expect(doc).toMatch(
      /the `lost` run record \(fate unknown: never relaunched, the occurrence reservation \/ at-most-once identity stays consumed, §10\.1\)/,
    );
    expect(doc).toMatch(
      /never a retry on another backend, never a silent isolation downgrade \(#917 §13 rule 3\)/,
    );
  });

  test('an operator-cancelled unattended execution parks, never resolving the request', () => {
    expect(doc).toMatch(
      /`cancelled` \(an explicit operator cancellation honored at the backend layer, #917 §8\.3 — the #608 cooperative-stop posture\), or `lost`/,
    );
    expect(doc).toMatch(
      /the `cancelled` run record \(an operator stopped the run mid-flight: never a resolution — `"auto-executed"` requires a `ran` outcome, §6\.4 — with the partial captured result attached and any produced diff preserved for the guided dispositions like rows 10–11/,
    );
    expect(doc).toMatch(
      /the occurrence reservation settles with the recorded `cancelled` outcome and stays consumed, #917 §12 rule 5, never an automatic relaunch/,
    );
    // Row 12 supplies the mapping #917 §11.3's columns omit — cancellation
    // routes through this contract's park, not through a §11.3 column.
    expect(doc).toMatch(
      /with the `cancelled` mapping supplied by this row \(#917 §11\.1 closes the outcome set; its §11\.3 columns omit `cancelled`\)/,
    );
  });
});

describe(`${DOC_PATH} — human interaction (§6)`, () => {
  test('the shipped disposition surface is preserved verbatim', () => {
    expect(doc).toMatch(
      /Actions \(`manual-done` \| `reject` \| `guided-run` \| `grant`\), dispositions \(`no-op` \| `committed` \| `discarded` \| `failed`\)/,
    );
    expect(doc).toMatch(/This contract adds no disposition and removes none\./);
  });

  test('continuation context is mandatory', () => {
    expect(doc).toMatch(
      /\*\*a Tool Request must never resolve in a way that re-queues the agent with no memory of what the operator decided or what a command revealed\.\*\*/,
    );
    expect(doc).toMatch(
      /Resolving a request without recording what the next prompt needs is a defect, not a degraded mode\./,
    );
  });

  test('the auto-executed resolution record is the one request-record addition', () => {
    expect(doc).toMatch(
      /Rows 3–4 and 7–8 resolve the request without an operator only when the launched execution succeeds/,
    );
    expect(doc).toMatch(
      /`"auto-executed"` is never written for a failed run\./,
    );
    expect(doc).toMatch(
      /`resolution\.action` gains one value: `"auto-executed"`\. The four shipped values and their semantics are unchanged\./,
    );
    expect(doc).toMatch(
      /the authorizing source \(`"plan-approval"` or `"session-allowlist"`\), the tier, and the captured bounded result/,
    );
    expect(doc).toMatch(
      /it adopts the `"auto-executed"` record only at #697 §14's subsumption point/,
    );
  });
});

describe(`${DOC_PATH} — repeats and no-progress loops (§7)`, () => {
  test('repeat identity is recorded, never prose-derived', () => {
    expect(doc).toMatch(/`\(operationId, params digest\)`/);
    expect(doc).toMatch(
      /`normalizeToolRequestCommand`, trim-only — deliberately not the grant's whitespace-collapsing hash/,
    );
    expect(doc).toMatch(
      /no heuristic inspects agent prose to decide whether progress happened — commits, file changes, and request identity are the only inputs/,
    );
  });

  test('the no-progress repeat rule is deterministic and bounded', () => {
    expect(doc).toMatch(
      /At most one automatic continuation exists per identical free-form identity per task attempt/,
    );
    expect(doc).toMatch(
      /marked `repeatedAfterResolution` \(the generalization of the shipped `repeatedAfterManualDone`\)/,
    );
    expect(doc).toMatch(/`"unresolved-duplicate"` suppression is made uniform and normative/);
  });
});

describe(`${DOC_PATH} — parking (§8)`, () => {
  test('a park is the typed handoff and costs nothing while parked', () => {
    expect(doc).toMatch(
      /The task moves to `ready_for_human` via the `tool_request` handler result — a distinct classification, not a failure \(`failed`\) and not a dependency hold \(`blocked`\)/,
    );
    expect(doc).toMatch(
      /A parked task is not claimable, consumes no agent invocations, runs no retries, and emits no repeated public comments/,
    );
  });

  test('the three gates stay independent', () => {
    expect(doc).toMatch(
      /A task sits behind at most one at a time; the cross-refusal is mechanical: Human Gate operations and generic recovery refuse `tool_request_unresolved` while a request is live/,
    );
  });

  test('a parked issue stalls its chain with no new scheduler and stops out loud', () => {
    expect(doc).toMatch(
      /A parked Issue stalls its chain \*\*by the existing dependency gate, not by any new machinery\*\*/,
    );
    expect(doc).toMatch(
      /\*\*A chain blocked on a genuinely human-only decision may stop — indefinitely\.\*\* That is designed behavior, not an error state\./,
    );
    expect(doc).toMatch(
      /\*\*Other already-runnable Issues continue\*\* under the existing intake and claim behavior, unchanged/,
    );
    expect(doc).toMatch(/No chain scheduler is introduced \(#915 §13's rule, inherited\)/);
  });

  test('every park is explained from recorded decisions', () => {
    expect(doc).toMatch(
      /Every park must be answerable from operator surfaces without reading logs, and the answer is recorded at decision time, not reconstructed/,
    );
  });
});

describe(`${DOC_PATH} — preservation, recovery, and audit (§9–§10)`, () => {
  test('no disposition destroys unpreserved work', () => {
    expect(doc).toMatch(
      /The park must never cost work, and no disposition may destroy bytes it did not first preserve/,
    );
    expect(doc).toMatch(/`discard` snapshots to `discarded-changes\.patch` before/);
    expect(doc).toMatch(/`partial-implementation\.patch`/);
    expect(doc).toMatch(/\*\*The base branch is untouchable\*\*/);
  });

  test('recovery never relaunches ambiguity and never bypasses a live request', () => {
    expect(doc).toMatch(
      /Recovery never relaunches an ambiguous unattended execution — the next window or a human does\./,
    );
    expect(doc).toMatch(
      /`RECOVERABLE_STATUSES` stays `\["failed", "claimed", "running"\]`; `ready_for_human` is deliberately not in it/,
    );
  });

  test('exactly two new audit events exist, with bounded public surfaces', () => {
    expect(doc).toMatch(/adds exactly two task events, both closed/);
    expect(doc).toMatch(/`tool_request_parked`/);
    expect(doc).toMatch(/`tool_request_continuation_routed`/);
    expect(doc).toMatch(
      /names, reasons, and counts; never output bytes, paths, exact commands, or refusal detail strings/,
    );
  });
});

describe(`${DOC_PATH} — reconciliation (§11)`, () => {
  test('the #722 verdict is restated, not reopened', () => {
    expect(doc).toMatch(
      /The #722 verdict \(\*\*validated with revisions R1–R6\*\*\) stands exactly as #918 §10\.5 records it/,
    );
    expect(doc).toMatch(
      /changes `docs\/verification-execution-contract\.md` not at all/,
    );
  });

  test('the redesign §6 resolver is superseded for guided runs by #917 per-class policy', () => {
    expect(doc).toMatch(
      /item 4's execution-environment resolver is superseded for guided runs by #917's per-class backend policy \(`"tool-request\.granted"`\)/,
    );
  });

  test('the status-column supersession is landed in the shipped Tool Request documents', () => {
    expect(doc).toMatch(
      /\*\*Metadata record\*\* \(§2\.5\): the stored shape is the shipped one\. That section's original suggested `"status": "open"` field is explicitly superseded/,
    );
    expect(doc).toMatch(
      /§3\.9's record-update step now names the shipped `resolved` field instead of the never-shipped `toolRequest\.status` \(§4's no-status-column rule\)/,
    );
    expect(depSync).toMatch(/\*\*Field-name supersession \(issue #919\)\.\*\*/);
    expect(depSync).toMatch(/Read `"status": "open"` below as `resolved: false`\./);
    expect(guidedFlow).toMatch(
      /Update `toolRequest\.resolved` and populate `toolRequest\.resolution` in the task context\. \(There is no `toolRequest\.status` field: the request lifecycle is derived from `resolved`\/`resolution` plus the task status — see `docs\/unattended-tool-request-contract\.md` §4\.\)/,
    );
    expect(guidedFlow).not.toMatch(/Update `toolRequest\.status`/);
  });

  test('shipped issue-numbered behaviors are preserved by name', () => {
    for (const pin of [
      /#300 \(repeat-kind comment suppression → row 17\)/,
      /#302 \(dependency-update router → row 13\)/,
      /#404 \(resumed no-op success → row 27\)/,
      /#678 \(failed-clean requeue → row 25\)/,
      /#681 \(review admission untouched — #918 §12\.4\)/,
    ]) {
      expect(doc).toMatch(pin);
    }
  });
});

describe(`${DOC_PATH} — implementation decomposition (§12)`, () => {
  const decompSection = rawDoc
    .split('## 13. Invariants')[0]
    .split('## 12. Final implementation decomposition')[1];
  const rows = decompSection.match(/^\| \d+ \|/gm) ?? [];

  test('carries exactly 25 dependency-ordered slices, numbered in order', () => {
    expect(rows).toHaveLength(25);
    rows.forEach((row, i) => expect(row).toBe(`| ${i + 1} |`));
  });

  test('is explicitly a proposal awaiting human approval', () => {
    expect(doc).toMatch(/\*\*No implementation Issues are created by this document\.\*\*/);
    expect(doc).toMatch(
      /it awaits human approval, and the tracker — not this document — assigns numbers and may re-cut slices/,
    );
  });

  test('efforts map to the tracker complexity labels', () => {
    expect(doc).toMatch(
      /\*\*S\*\* ≈ `complexity:medium`, \*\*M\*\* ≈ `complexity:high`, \*\*L\/XL\*\* ≈ `complexity:xhigh`/,
    );
  });

  test('names the critical path to unattended operation', () => {
    expect(doc).toMatch(
      /The critical path to "routine operations stop parking" is B1→B2\/B3→N1→N2→G2 with G1\/U1 alongside/,
    );
  });
});

describe(`${DOC_PATH} — invariants (§13)`, () => {
  test('no new phase-runner or predecessor vocabulary is added', () => {
    expect(doc).toMatch(
      /This contract adds no `TaskStatus`, `PhaseRunOutcome`, `PhaseHandlerResult` member, tier, refusal reason, backend, outcome, plan state, or ChatOps verb/,
    );
  });

  test('the docs pin names this test file', () => {
    expect(doc).toMatch(/test\/docs-unattended-tool-request-contract\.test\.js/);
  });
});

describe(`${DOC_PATH} — delivery notes in predecessor documents`, () => {
  test('docs/tool-request-grant-tiers-contract.md §18 records the #919 delivery', () => {
    expect(tiers).toMatch(
      /\*\*Delivered \(#919\)\*\*: `docs\/unattended-tool-request-contract\.md`/,
    );
  });

  test('docs/preflight-execution-plan-contract.md §20 records the #919 delivery', () => {
    expect(preflight).toMatch(
      /\*\*Delivered \(#919\)\*\*: `docs\/unattended-tool-request-contract\.md`/,
    );
  });

  test('docs/single-host-execution-backend-contract.md §20 records the #919 delivery', () => {
    expect(backend).toMatch(
      /\*\*Delivered \(#919\)\*\*: `docs\/unattended-tool-request-contract\.md`/,
    );
  });

  test('docs/verification-execution-contract.md §16 records the #919 delivery', () => {
    expect(verification).toMatch(
      /\*\*Delivered \(#919\)\*\*: `docs\/unattended-tool-request-contract\.md`/,
    );
  });

  domainTest('docs/DOMAIN.md §5 records the #919 contract decision', () => {
    expect(domain).toMatch(/\*\*Unattended Tool Request contract decided \(#919\)\*\*/);
    expect(domain).toMatch(
      /no implementation Issues are created by the design/,
    );
  });
});
