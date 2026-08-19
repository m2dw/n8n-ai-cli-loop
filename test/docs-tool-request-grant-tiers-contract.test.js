/**
 * Structural tests for docs/tool-request-grant-tiers-contract.md (issue #697).
 *
 * The document is the authoritative contract for tiering the Tool Request
 * human gate over typed operation ids. Issue #697 is a pure specification:
 * no production code changes with it, so these tests pin the document's own
 * claims — the closed three-tier set, the typed-operation premise
 * (undecidable-from-text), the notify tier's effect-enumeration admission
 * condition, the derived auto-grant ceiling, the enforcing-containment
 * requirement for relaxed tiers, the patch-level adoption boundary for
 * overlapping dirty paths, the safe-mode (lifecycle-scripts-off)
 * requirement on dependency.sync, the preserved pre-manifest-diff
 * dependency-update route, the reason-scoped migration exception (the
 * already-executed repeat refusal parks as a real handoff, never the
 * legacy dependency route), the parser-probe fallback for absent or
 * unmatched suggestedAction hints, the point-by-point answers to
 * docs/chatops-result-contract.md §12's admission criteria, and the
 * DOMAIN.md resolutions and predecessor forward-pointer corrections that
 * land alongside it — against drift. They are structural only, mirroring
 * the doc-only pin pattern used for docs/chatops-result-contract.md (#785).
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

const DOC_PATH = 'docs/tool-request-grant-tiers-contract.md';
const doc = read(DOC_PATH);
const port = read('docs/operation-dispatch-port-contract.md');
const mapping = read('docs/chatops-operation-mapping-contract.md');
const result = read('docs/chatops-result-contract.md');

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
    expect(doc).toMatch(/Status: \*\*approved design, not yet implemented\*\* \(issue #697\)/);
  });

  test('names its origin and what it does not supersede', () => {
    expect(doc).toMatch(/design deliverable drafted as `docs\/DOMAIN\.md` §5 derived issue 4/);
    expect(doc).toMatch(
      /supersedes nothing: the superseded #696 \/ PR #776 and the umbrella issues #778\/#779 were replaced by that chain/,
    );
  });

  test('defers to every fixed predecessor contract in the chain', () => {
    expect(doc).toMatch(/chatops-command-grammar-contract\.md` \(#777\)/);
    expect(doc).toMatch(/chatops-identity-contract\.md` \(#780\)/);
    expect(doc).toMatch(/chatops-comment-cursor-contract\.md` \(#781\)/);
    expect(doc).toMatch(/chatops-execution-ledger-contract\.md` \(#782\)/);
    expect(doc).toMatch(/operation-dispatch-port-contract\.md` \(#783\)/);
    expect(doc).toMatch(/chatops-operation-mapping-contract\.md` \(#784\)/);
    expect(doc).toMatch(/chatops-result-contract\.md` \(#785\)/);
  });

  test('states the executable chain as its predecessors state it', () => {
    expect(doc).toMatch(
      /#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917 → #918 → #919 → #722/,
    );
  });
});

describe(`${DOC_PATH} — the typed-operation premise (§1)`, () => {
  test('pins the undecidability result the design is built around', () => {
    expect(doc).toMatch(/\*\*undecidable from command text\*\*/);
  });

  test('names the dependency-update route as the substitution template', () => {
    expect(doc).toMatch(/\*\*substitutes a\s?session-pinned command\*\*/);
    expect(doc).toMatch(/human-gated \*by construction\*, not by classification/);
  });
});

describe(`${DOC_PATH} — the closed three-tier set (§3)`, () => {
  test('defines exactly the three closed tiers', () => {
    expect(doc).toMatch(/"auto-grant" \| "notify-and-proceed" \| "human-gate"/);
  });

  test('human-gate is the default and the unchanged behavior', () => {
    expect(doc).toMatch(/`human-gate` is the default and the unchanged behavior/);
    expect(doc).toMatch(/every free-form shell request/);
    expect(doc).toMatch(/dependency additions/);
    expect(doc).toMatch(/spend/);
    expect(doc).toMatch(/credentials/);
    expect(doc).toMatch(/canonical repo/);
  });

  test('the notify tier is not a softer default and requires effect enumeration', () => {
    expect(doc).toMatch(/`notify-and-proceed` is not a softer default/);
    expect(doc).toMatch(
      /any observed effect outside the enumeration routes the request to the human gate/,
    );
    expect(doc).toMatch(
      /Operations that cannot enumerate their side effects do not qualify for the tier/,
    );
  });

  test('worktree isolation is the blast-radius enabler for the auto tier', () => {
    expect(doc).toMatch(/blast-radius enabler/);
  });
});

describe(`${DOC_PATH} — resolution, ceiling, and refusals (§4–§9)`, () => {
  test('the tier refusal reasons are a closed six-member set', () => {
    expect(doc).toMatch(
      /`"tiers-disabled"` \| `"no-candidate"` \| `"not-allowlisted"` \| `"containment-unavailable"` \| `"precondition-failed"` \| `"already-executed"`/,
    );
  });

  test('relaxed tiers require an enforcing containment capability, fail-closed', () => {
    expect(doc).toMatch(/declarative policy fields never authorize execution by themselves/);
    expect(doc).toMatch(/a relaxed tier never falls back to unconfined host execution/);
    expect(doc).toMatch(/Unobservable effects are excluded by enforcement/);
  });

  test('agent-supplied fields select but never authorize', () => {
    expect(doc).toMatch(/agent-supplied fields select at most a candidate; they never authorize/);
  });

  test('a human-gate verdict composes with the shipped dependency route until subsumption', () => {
    expect(doc).toMatch(/\*\*Migration exception — the §14 compatible route\.\*\*/);
    expect(doc).toMatch(/leaves today's automatic dependency updates exactly as they are/);
  });

  test('the migration exception is reason-scoped and excludes the repeat refusal', () => {
    expect(doc).toMatch(/The exception is scoped by refusal reason, not blanket/);
    expect(doc).toMatch(
      /`"already-executed"` verdict therefore parks as a real human handoff, never through the legacy route/,
    );
    expect(doc).toMatch(/repeat protection outranks the migration exception/);
  });

  test('an absent or unmatched suggestedAction still nominates via the parser probe', () => {
    expect(doc).toMatch(
      /Otherwise the \*\*parser probe\*\*: exactly one registry entry declaring an `input\.parser` must accept the request/,
    );
    expect(doc).toMatch(/is \*\*inert, not a\s?veto\*\*: the probe runs exactly as for an absent hint/);
  });

  test('a dirty worktree is served against the pre-substitution snapshot, not refused', () => {
    expect(doc).toMatch(/A clean worktree is deliberately \*\*not\*\* required/);
    expect(doc).toMatch(/differ from the pre-substitution snapshot \(§7 step 1\)/);
  });

  test('adoption is patch-level and never stages agent-authored bytes', () => {
    expect(doc).toMatch(/what it stages is \*\*patch-level, never path-level\*\*/);
    expect(doc).toMatch(
      /no agent-authored byte is ever staged on the strength of a relaxed-tier run/,
    );
  });

  test('a non-isolable overlap adopts nothing and routes to the human gate', () => {
    expect(doc).toMatch(
      /adopts nothing: the run routes to the human gate carrying the entangled path list/,
    );
    expect(doc).toMatch(/`tool_request_effects_entangled`/);
  });

  test('executing agent text under a relaxed tier is unrepresentable, not just forbidden', () => {
    expect(doc).toMatch(
      /Executing agent text under a relaxed tier is not a forbidden configuration — it is an unrepresentable one/,
    );
  });

  test('the auto-grant ceiling is derived from declared network reach', () => {
    expect(doc).toMatch(/`policy\.network === "none"` → ceiling `auto-grant`/);
    expect(doc).toMatch(/`policy\.network === "registry-metadata"` → ceiling `notify-and-proceed`/);
  });

  test('a repeat routes to the human gate as a real handoff, never the legacy route', () => {
    expect(doc).toMatch(/at most once per task attempt; a repeat routes to the human gate/);
    expect(doc).toMatch(
      /`"already-executed"` sits outside §6's migration exception, so the pre-#697 dependency route never executes the repeat/,
    );
  });
});

describe(`${DOC_PATH} — answers to the #785 §12 admission criteria (§12)`, () => {
  test('criterion 1: tier refusals are the existing not-permitted rejection, no new kind', () => {
    expect(doc).toMatch(/`rejected` with `reason: "not-permitted"`/);
    expect(doc).toMatch(/The five-kind ChatOps vocabulary is untouched/);
  });

  test('criterion 2: tiering is context construction over confirmed', () => {
    expect(doc).toMatch(
      /a relaxed tier is the \*only\* authority for constructing `confirmed: true`/,
    );
  });

  test('criterion 4: postHocReview is new tier-owned vocabulary, never an overloaded kind', () => {
    expect(doc).toMatch(/postHocReview: "pending" \| "acknowledged" \| "flagged"/);
    expect(doc).toMatch(/never overloads `ambiguous-execution`/);
  });

  test('criterion 6: no ChatOps verb is added and the #784 table is not modified', () => {
    expect(doc).toMatch(/adds no ChatOps verb, does not modify #784's table/);
  });
});

describe(`${DOC_PATH} — ownership, calibration, and deferral (§13–§15)`, () => {
  test('resolves the DOMAIN.md §2.3 ownership note without inventing a new context', () => {
    expect(doc).toMatch(/Where Tool Request lives — resolving DOMAIN\.md §2\.3/);
    expect(doc).toMatch(/No context named "Tool Request" is created/);
  });

  test('dependency.sync is the first typed operation and caps at notify', () => {
    expect(doc).toMatch(/operationId: dependency\.sync/);
    expect(doc).toMatch(/Its ceiling \(§9\) is `notify-and-proceed`/);
  });

  test('dependency.sync preserves the pre-manifest-diff add/bump request route', () => {
    expect(doc).toMatch(/arrives \*\*before any manifest diff exists\*\*/);
    expect(doc).toMatch(/an explicit \*\*compatible route\*\*/);
  });

  test('dependency.sync demands safe mode; lifecycle scripts never reach a relaxed tier', () => {
    expect(doc).toMatch(/"dependency-sync-safe-mode"/);
    expect(doc).toMatch(/`dependencySync\.allowLifecycleScripts` is `true` rejects the session/);
    expect(doc).toMatch(
      /Lifecycle-enabled dependency sync is thus permanently outside every relaxed tier/,
    );
  });

  test('the dirty-manifest overlap replays the pure data edit against the committed base', () => {
    expect(doc).toMatch(/replays that data edit against the committed base/);
  });

  test('generic auto-grant of agent-proposed commands is explicitly deferred', () => {
    expect(doc).toMatch(/Generic auto-grant of agent-proposed commands/);
    expect(doc).toMatch(/\*\*explicitly deferred\*\*/);
  });

  test('the human-gate tier relaxes nothing an operator did not name', () => {
    expect(doc).toMatch(
      /relaxes nothing except what an operator's session allowlist explicitly names/,
    );
  });

  test('names its own docs pin', () => {
    expect(doc).toMatch(/test\/docs-tool-request-grant-tiers-contract\.test\.js/);
  });
});

describe(`${DOC_PATH} — reconciliation landed alongside (DOMAIN.md and predecessors)`, () => {
  domainTest('DOMAIN.md §2.3 marks the Tool Request ownership note resolved by #697', () => {
    expect(domain).toMatch(/Where does Tool Request live\? \*\*Resolved \(#697\)\*\*/);
    expect(domain).toMatch(/`docs\/tool-request-grant-tiers-contract\.md` §13/);
  });

  domainTest('DOMAIN.md §5 item 4 records the contract as decided', () => {
    expect(domain).toMatch(/\*\*Contract decided \(#697\)\*\*/);
    expect(domain).toMatch(/`docs\/tool-request-grant-tiers-contract\.md`: the closed three-tier set/);
  });

  test('the dispatch-port contract §16 marks its #697 pointer delivered', () => {
    expect(port).toMatch(/Tool Request grant tiers over typed operation ids\*\* — #697/);
    expect(port).toMatch(
      /\*\*Delivered \(#697\)\*\*: `docs\/tool-request-grant-tiers-contract\.md` tiers the Tool Request gate/,
    );
  });

  test('the operation-mapping contract §12 marks its #697 pointer delivered', () => {
    expect(mapping).toMatch(
      /\*\*Delivered \(#697\)\*\*: `docs\/tool-request-grant-tiers-contract\.md`, which adds no ChatOps verb/,
    );
  });

  test('the result contract §15 marks its #697 pointer delivered', () => {
    expect(result).toMatch(
      /\*\*Delivered \(#697\)\*\*: `docs\/tool-request-grant-tiers-contract\.md`, whose §12 answers those six criteria point by point/,
    );
  });
});
