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
    '#### Human gate (Go/No-go) and human review return',
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

  test('ChatOps stays foundation-only with the no-dispatcher gap stated', () => {
    const block = rowBlock('#### ChatOps (comment recognition, cursor, ledger, mapping, dispatch port)');
    expect(block).toMatch(/\*\*Status:\*\* `foundation-only`/);
    expect(block).toMatch(/No supported end-to-end path scans GitHub comments/);
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

  test('review dispute stays foundation-only with the no-dispatcher gap stated', () => {
    const block = rowBlock('#### Review dispute');
    expect(block).toMatch(/\*\*Status:\*\* `foundation-only`/);
    expect(block).toMatch(/session\.reviewDispute\.enabled/);
    expect(block).toMatch(/no dispatcher/);
  });

  test('Gitea provider keeps the not-a-complete-replacement gap', () => {
    const block = rowBlock('#### Gitea provider');
    expect(block).toMatch(/This is\s*\n?\s*not a complete GitHub replacement\.|not a complete GitHub replacement/);
    expect(block).toMatch(/design-only/);
  });

  test('Copybara export keeps the prototype/foundation-only boundary', () => {
    const block = rowBlock('#### Copybara private-to-public export');
    expect(block).toMatch(/\*\*Status:\*\* `foundation-only`/);
    expect(block).toMatch(/never talks to the real public mirror/);
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

  test.each(CHATOPS_CONTRACTS)('%s points at feature-status.md for end-to-end availability', (rel) => {
    const target = readRaw(rel);
    expect(target).toMatch(/feature-status\.md/);
    expect(target).toMatch(/foundation-only/);
  });
});
