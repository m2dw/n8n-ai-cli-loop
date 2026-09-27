/**
 * Structural tests for docs/feature-status.md (issue #946).
 *
 * This is the canonical, repository-wide feature availability matrix. A
 * status matrix that silently drifts — an invalid status value, a dropped
 * core row, an omitted explanatory gap, or a boundary quietly relabeled to
 * `available` — is worse than no matrix at all, because operators trust it.
 *
 * These tests are structural only: they pin what the document says, not
 * whether the underlying runtime claim is true (that is a review concern,
 * not a test-suite concern — see the issue's "Review focus" section).
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = resolve(ROOT, 'docs');

function readRaw(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

// Assertions run against a whitespace-normalized copy: the document is
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document
// says, not how it happens to be wrapped.
function normalize(text) {
  return text.replace(/\s+/g, ' ');
}

const RAW = readRaw('docs/feature-status.md');
const doc = normalize(RAW);

const ALLOWED_STATUSES = [
  'available',
  'config-gated',
  'foundation-only',
  'design-only',
  'deprecated',
  'archived',
];

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('docs/feature-status.md — status vocabulary', () => {
  test('defines all five baseline statuses', () => {
    expect(doc).toMatch(/\*\*`available`\*\*/);
    expect(doc).toMatch(/\*\*`config-gated`\*\*/);
    expect(doc).toMatch(/\*\*`foundation-only`\*\*/);
    expect(doc).toMatch(/\*\*`design-only`\*\*/);
    expect(doc).toMatch(/\*\*`deprecated`\*\*.*\*\*`archived`\*\*|\*\*`deprecated`\*\* \/ \*\*`archived`\*\*/);
  });

  test('states that a closed design Issue is not evidence of availability', () => {
    expect(doc).toMatch(/A closed design Issue is not evidence of `available`/);
  });

  test('every matrix row uses only the documented vocabulary', () => {
    const statusValues = [...RAW.matchAll(/-\s+\*\*Status:\*\*\s+`([^`]+)`/g)].map((m) => m[1]);
    expect(statusValues.length).toBeGreaterThan(20);
    for (const value of statusValues) {
      expect(ALLOWED_STATUSES).toContain(value);
    }
  });

  test('every matrix row status line is immediately followed by a Capability line', () => {
    // Guards against a row being relabeled by deleting its explanatory text —
    // a bare status token with no capability/gap prose is not a usable row.
    const rows = [...RAW.matchAll(/-\s+\*\*Status:\*\*\s+`[^`]+`\n- \*\*Capability:\*\*/g)];
    const statusCount = [...RAW.matchAll(/-\s+\*\*Status:\*\*\s+`[^`]+`/g)].length;
    expect(rows.length).toBe(statusCount);
  });
});

// ---------------------------------------------------------------------------
// Required core feature rows (issue #946 §2 minimum coverage list)
// ---------------------------------------------------------------------------

describe('docs/feature-status.md — required core rows are present', () => {
  const REQUIRED_HEADINGS = [
    '#### Issue intake and phase execution',
    '#### Implementation, review, conflict resolution, and research (phase handlers)',
    '#### Content research, draft, and review',
    '#### Per-Issue worktrees and locking',
    '#### Human gate (Go/No-go checklist) and human review return',
    '#### Human gate No-go, advice, and disposition flow',
    '#### Issue planning and AI preview',
    '#### Issue refinement',
    '#### Tool Request grant (single-use) and guided continuation',
    '#### Tool Request grant tiers (typed policy)',
    '#### Unattended Tool Request operation',
    '#### Verification (per-phase, inline repair)',
    '#### Unified verification execution engine (runner-owned)',
    '#### Review dispute',
    '#### ChatOps (comment recognition, cursor, ledger, mapping, dispatch port)',
    '#### GitHub and GitHub App provider',
    '#### Gitea provider',
    '#### Outbox, cursor, retry, and dead-letter operations',
    '#### Admin UI and recovery commands',
    '#### Retention, backup, restore, and pruning',
    '#### Metrics and intervention-rate reporting',
    '#### Copybara private-to-public export',
    '#### Private n8n node distribution',
    '#### Execution backend, platform sandbox, and preflight execution plan',
    '#### Antigravity workspace integration',
    '#### Codex context-mode',
  ];

  test.each(REQUIRED_HEADINGS)('has the row %s', (heading) => {
    expect(RAW).toContain(heading);
  });
});

// ---------------------------------------------------------------------------
// Known boundaries cannot be silently relabeled `available`
// ---------------------------------------------------------------------------

describe('docs/feature-status.md — pinned status/gap boundaries', () => {
  function rowBlock(heading) {
    const idx = RAW.indexOf(heading);
    expect(idx).toBeGreaterThan(-1);
    const nextHeadingIdx = RAW.indexOf('\n#### ', idx + heading.length);
    const end = nextHeadingIdx === -1 ? RAW.length : nextHeadingIdx;
    return normalize(RAW.slice(idx, end));
  }

  // Issue #1024 promoted this row from `foundation-only` to `config-gated`: one
  // bounded pass (`src/cli/chatops-scan.ts`) now chains scan → recognize →
  // ledger → dispatch → publish, and issue #1031 registered the two mapped Tool
  // Request operations, so an authorized command executes. Two qualifications
  // must survive any later edit: it is deliberately NOT `available` (the flag
  // defaults off), and the catalog is CLOSED at those two operations — every
  // other verb is still answered `unknown-operation`. The row must no longer
  // claim the catalog is empty, which would understate what an enabled session
  // can now do to a repository.
  test('ChatOps is config-gated, not available, with the closed operation catalog stated', () => {
    const block = rowBlock('#### ChatOps (comment recognition, cursor, ledger, mapping, dispatch port)');
    expect(block).toMatch(/\*\*Status:\*\* `config-gated`/);
    expect(block).toMatch(/session\.chatOps\.enabled/);
    expect(block).toMatch(/default \*\*off\*\*/);
    expect(block).toMatch(/not `available`/);
    expect(block).toMatch(/operation catalog is closed at two entries/);
    expect(block).toMatch(/tool-request\.run/);
    expect(block).toMatch(/tool-request\.resolve/);
    expect(block).toMatch(/unknown-operation/);
    expect(block).not.toMatch(/operation catalog is still empty/);
    expect(block).not.toMatch(/No supported end-to-end path scans GitHub comments/);
  });

  // The claim that this is wired end to end is only true while the generated
  // child workflow actually carries the node; `build-parent-child-workflow.test.js`
  // pins the generator side, and this pins the row that advertises it.
  test('ChatOps names the generated n8n node that runs the pass', () => {
    const block = rowBlock('#### ChatOps (comment recognition, cursor, ledger, mapping, dispatch port)');
    expect(block).toMatch(/ChatOps\s+Scan/);
    expect(block).toMatch(/child workflow/);
  });

  test('Tool Request grant tiers stays design-only', () => {
    const block = rowBlock('#### Tool Request grant tiers (typed policy)');
    expect(block).toMatch(/\*\*Status:\*\* `design-only`/);
  });

  test('unattended Tool Request stays design-only', () => {
    const block = rowBlock('#### Unattended Tool Request operation');
    expect(block).toMatch(/\*\*Status:\*\* `design-only`/);
  });

  test('the unified verification execution engine stays design-only', () => {
    const block = rowBlock('#### Unified verification execution engine (runner-owned)');
    expect(block).toMatch(/\*\*Status:\*\* `design-only`/);
  });

  test('the execution backend / platform sandbox / preflight chain stays design-only', () => {
    const block = rowBlock('#### Execution backend, platform sandbox, and preflight execution plan');
    expect(block).toMatch(/\*\*Status:\*\* `design-only`/);
  });

  test('issue refinement is config-gated, not plain available', () => {
    const block = rowBlock('#### Issue refinement');
    expect(block).toMatch(/\*\*Status:\*\* `config-gated`/);
    expect(block).toMatch(/session\.issueRefinement\.enabled/);
  });

  // Issue #965 promoted this row from `foundation-only` to `config-gated`: every
  // automated §7.1 turn dispatches, so the "no dispatcher" gap it used to state
  // is gone. It is deliberately NOT `available` — the flag still defaults off —
  // and the §15/G1 human-handoff limitation must stay stated, so a later change
  // cannot quietly relabel it as generally available.
  test('review dispute is config-gated, not available, with the human-handoff limit stated', () => {
    const block = rowBlock('#### Review dispute');
    expect(block).toMatch(/\*\*Status:\*\* `config-gated`/);
    expect(block).toMatch(/session\.reviewDispute\.enabled/);
    expect(block).toMatch(/default `false`/);
    expect(block).toMatch(/not `available`/);
    expect(block).toMatch(/escalated_human/);
    expect(block).not.toMatch(/no dispatcher/);
    // Issue #965's qualification finding, kept in the row an operator reads
    // first: every turn dispatches, but §8.2's verified-no-tools table and
    // §8.3's independence rule have no common answer today, so arbitration
    // itself lands on a human. Promoting the row without this would read as a
    // capability the runner does not have.
    expect(block).toMatch(/arbitration escalates to a human today/);
  });

  // Issue #1066: the matrix used to describe the Go/No-go checklist and the
  // unimplemented No-go/apply/show disposition surface as one `available`
  // row, citing the disposition spec as if it were shipped. The spec itself
  // (docs/human-gate-no-go-flow.md) says it "is a documentation-only issue"
  // — no CLI command, store code, or port exists. These two rows must stay
  // split, with the checklist/return path `available` and the disposition
  // design `design-only`, so neither claim can drift back together.
  test('human gate checklist/return is available, with no disposition command claimed', () => {
    const block = rowBlock('#### Human gate (Go/No-go checklist) and human review return');
    expect(block).toMatch(/\*\*Status:\*\* `available`/);
    expect(block).toMatch(/human-review-return/);
    expect(block).toMatch(/github-app-review-return/);
    expect(block).not.toMatch(/human-gate no-go/);
    expect(block).not.toMatch(/human-gate apply/);
  });

  test('human gate No-go/advice/disposition flow stays design-only and points at existing issues', () => {
    const block = rowBlock('#### Human gate No-go, advice, and disposition flow');
    expect(block).toMatch(/\*\*Status:\*\* `design-only`/);
    expect(block).toMatch(/no `human-gate no-go`, `human-gate apply`, or\s*\n?\s*`human-gate show` subcommand registered/);
    expect(block).toMatch(/documentation-only issue/);
    expect(block).toMatch(/treat\s*\n?\s*any new task against this row as duplicate work/);
    expect(block).toMatch(/#750/);
    expect(block).toMatch(/#764/);
  });

  test('Gitea provider keeps the not-a-complete-replacement gap', () => {
    const block = rowBlock('#### Gitea provider');
    expect(block).toMatch(/This is\s*\n?\s*not a complete GitHub replacement\.|not a complete GitHub replacement/);
    expect(block).toMatch(/design-only/);
  });

  // Issue #1023 promoted this row from `foundation-only` to `config-gated`:
  // issues #768/#800/#811 shipped `scripts/public-export.mjs`, a real
  // `--publish --yes` path that pushes to an operator-supplied public remote
  // and opens/updates a PR via `gh`, so the old "never talks to the real
  // public mirror" claim no longer holds. It is deliberately NOT `available`
  // — `copybara/PIN.json` has never been populated in this repository's
  // history, so a fresh checkout cannot complete any export (real or local)
  // until an operator does a one-time manual jar-provenance bootstrap. A
  // later change must not quietly drop that gate or claim a real publish has
  // actually run without evidence.
  test('Copybara export is config-gated on the manual PIN bootstrap, not available', () => {
    const block = rowBlock('#### Copybara private-to-public export');
    expect(block).toMatch(/\*\*Status:\*\* `config-gated`/);
    expect(block).toMatch(/copybara\/PIN\.json/);
    expect(block).toMatch(/fails closed at the `pin` stage|null/);
    expect(block).not.toMatch(/never talks to the real public mirror/);
  });
});

// ---------------------------------------------------------------------------
// Maintenance rule
// ---------------------------------------------------------------------------

describe('docs/feature-status.md — maintenance rule', () => {
  test('requires availability-changing work to update this file in the same change', () => {
    expect(doc).toMatch(
      /MUST update the relevant\s*row in this file in the same change/,
    );
  });
});

// ---------------------------------------------------------------------------
// Every doc with an explicit Status declaration is represented or excluded
// ---------------------------------------------------------------------------

describe('docs/feature-status.md — coverage of Status-declaring documents', () => {
  const STATUS_LINE = /^(?:> )?\*{0,2}Status:?\s/m;

  function docsWithStatusDeclarations() {
    return readdirSync(DOCS_DIR)
      .filter((name) => name.endsWith('.md'))
      .filter((name) => name !== 'feature-status.md')
      .filter((name) => STATUS_LINE.test(readFileSync(resolve(DOCS_DIR, name), 'utf8')));
  }

  test('every Status-declaring doc is linked from the matrix or listed as excluded', () => {
    const excludedSection = RAW.slice(RAW.indexOf('## 6. Excluded documents'));
    const declaring = docsWithStatusDeclarations();
    expect(declaring.length).toBeGreaterThan(15);

    const missing = declaring.filter(
      (name) => !RAW.includes(name) && !excludedSection.includes(name),
    );
    expect(missing).toEqual([]);
  });

  test('excluded documents carry a stated reason', () => {
    const excludedSection = RAW.slice(RAW.indexOf('## 6. Excluded documents'));
    const bullets = [...excludedSection.matchAll(/^- \[[^\]]+\]\([^)]+\) — (.+)$/gm)];
    expect(bullets.length).toBeGreaterThan(0);
    for (const [, reason] of bullets) {
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-references from corrected documents point back at this matrix
// ---------------------------------------------------------------------------

describe('docs/feature-status.md — corrected documents point back here', () => {
  test('issue-refinement-contract.md links to the issue-refinement row', () => {
    const target = readRaw('docs/issue-refinement-contract.md');
    expect(target).toMatch(/feature-status\.md#issue-refinement/);
  });

  test('review-dispute-contract.md links to the review-dispute row', () => {
    const target = readRaw('docs/review-dispute-contract.md');
    expect(target).toMatch(/feature-status\.md#review-dispute/);
  });

  test('human-gate-no-go-flow.md links to the No-go/disposition row as design-only', () => {
    const target = readRaw('docs/human-gate-no-go-flow.md');
    expect(target).toMatch(/feature-status\.md#human-gate-no-go-advice-and-disposition-flow/);
    expect(target).toMatch(/`design-only`/);
  });

  test('idea-to-implementation.md links to the issue-refinement row', () => {
    const target = readRaw('docs/idea-to-implementation.md');
    expect(target).toMatch(/feature-status\.md#issue-refinement/);
  });

  const CHATOPS_CONTRACTS = [
    'docs/chatops-command-grammar-contract.md',
    'docs/chatops-comment-cursor-contract.md',
    'docs/chatops-execution-ledger-contract.md',
    'docs/chatops-identity-contract.md',
    'docs/chatops-operation-mapping-contract.md',
    'docs/chatops-result-contract.md',
    'docs/operation-dispatch-port-contract.md',
  ];

  // The pointer's job is unchanged by issue #1024's promotion: a component
  // contract's own "implemented" status must never be read as end-to-end
  // availability, so each one still has to name the aggregate row's current
  // status and its gate rather than leaving a reader to infer it.
  test.each(CHATOPS_CONTRACTS)('%s points at feature-status.md for end-to-end availability', (rel) => {
    const target = readRaw(rel);
    expect(target).toMatch(/feature-status\.md/);
    expect(target).toMatch(/config-gated/);
    expect(target).toMatch(/session\.chatOps\.enabled/);
  });
});
