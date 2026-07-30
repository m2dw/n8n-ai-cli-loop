/**
 * Structural tests for docs/handlers-extraction-plan.md (issue #692).
 *
 * Two jobs:
 *   1. Verify the boundary/order specification still states the decisions a
 *      later extraction slice must not re-litigate (no lifecycle template,
 *      no forced unification of profile resolvers or fork rules, policy-first
 *      stage order, first tranche defined).
 *   2. Pin the small number of *current-state* facts the plan's sequencing
 *      depends on. These are the claims that would silently invalidate the
 *      plan if the code moved underneath it — most importantly that the phase
 *      runner already owns lock acquisition for all three worktree phases,
 *      which is why the plan schedules a deletion rather than an extension.
 *
 * They are not a substitute for the runtime tests of any extracted module.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/handlers-extraction-plan.md');
const domain = read('docs/DOMAIN.md');
const inventory = read('docs/design/handlers-responsibility-inventory.md');

// ---------------------------------------------------------------------------
// Boundary definition
// ---------------------------------------------------------------------------

describe('docs/handlers-extraction-plan.md — boundary definition', () => {
  test('names depth (not breadth) as the disease, distinguishing it from admin.ts', () => {
    expect(doc).toMatch(/depth/i);
    expect(doc).toMatch(/breadth/i);
    expect(doc).toMatch(/admin\.ts/);
  });

  test('states the operational razor: handlers keep the procedure, lose the decisions', () => {
    expect(doc).toMatch(/keeps the procedure and loses the decisions/i);
  });

  test('forbids a handler-side lifecycle template', () => {
    expect(doc).toMatch(/[Nn]o handler-side lifecycle template/);
    expect(doc).toMatch(/double orchestration/i);
  });

  test('names phase-runner.ts as the existing owner of phase-lifecycle orchestration', () => {
    expect(doc).toMatch(/core\/phase-runner\.ts/);
  });

  test('defines the purity rule for extracted policy modules', () => {
    expect(doc).toMatch(/No .*fs.*child_process|no I\/O|performs no I\/O/i);
    expect(doc).toMatch(/imports nothing from `handlers\/`|No .*import from `handlers\/`/);
  });

  test('keeps PR creation in Execution as a synchronous Integration call', () => {
    expect(doc).toMatch(/PR (body building and PR )?creation/i);
    expect(doc).toMatch(/synchronous Integration call/i);
  });
});

// ---------------------------------------------------------------------------
// Stage order (policy-first) and the per-phase caveats
// ---------------------------------------------------------------------------

describe('docs/handlers-extraction-plan.md — stage order', () => {
  test('orders the five stages: pin, extract policy, reshape seams, mechanisms, splits', () => {
    const pin = doc.search(/## 3\. Stage 1 — Pin invariants/);
    const policy = doc.search(/## 4\. Stage 2 — Extract policy/);
    const reshape = doc.search(/## 5\. Stage 3 — Reshape/);
    const mechanisms = doc.search(/## 6\. Stage 4 — Mechanisms/);
    const splits = doc.search(/## 7\. Stage 5 — File splits/);
    expect(pin).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(pin);
    expect(reshape).toBeGreaterThan(policy);
    expect(mechanisms).toBeGreaterThan(reshape);
    expect(splits).toBeGreaterThan(mechanisms);
  });

  test('states nothing may start before the contract tests land', () => {
    expect(doc).toMatch(/[Nn]othing else in this plan may start until this stage lands/);
  });

  test('honors DOMAIN.md §2.2 row 1: profile resolvers are not unified', () => {
    expect(doc).toMatch(/shared primitives only/i);
    expect(doc).toMatch(/three resolvers stay three resolvers/i);
  });

  test('honors DOMAIN.md §2.2 row 2: fork outcome mappings stay per-phase', () => {
    expect(doc).toMatch(/[Ee]xtract the shared predicate only/);
    expect(doc).toMatch(/three outcome mappings (stay|do not move)/i);
  });

  test('schedules all ten DOMAIN.md §2.2 policy candidates', () => {
    for (const target of [
      'core/review-loop.ts',
      'core/fork-policy.ts',
      'core/agent-profile.ts',
      'core/conflict-outcome.ts',
      'core/conflict-retry.ts',
      'core/mergeability-gate.ts',
      'core/dirty-continuation.ts',
      'core/tool-request-disposition.ts',
      'core/handoff-preservation.ts',
      'core/implementation-routing.ts',
    ]) {
      expect(doc).toContain(target);
    }
  });

  test('defers file splits and files no split issue in the first tranche', () => {
    expect(doc).toMatch(/No split issue is filed in the first tranche/i);
  });
});

// ---------------------------------------------------------------------------
// Seam reshape
// ---------------------------------------------------------------------------

describe('docs/handlers-extraction-plan.md — seam reshape', () => {
  test('specifies one execution-context object replacing the positional seams', () => {
    expect(doc).toMatch(/PhaseExecutionSeams/);
    expect(doc).toMatch(/PhaseHandlerContext/);
  });

  test('names the seams being reshaped', () => {
    expect(doc).toMatch(/resolveWorktree/);
    expect(doc).toMatch(/issueLock/);
    expect(doc).toMatch(/phaseLockOwnerId/);
    expect(doc).toMatch(/resolveRepoHost/);
    expect(doc).toMatch(/depChecker/);
  });

  test('records the rejected alternative rather than only the chosen shape', () => {
    expect(doc).toMatch(/Rejected alternative/i);
  });
});

// ---------------------------------------------------------------------------
// Sequencing, rules, and the first tranche
// ---------------------------------------------------------------------------

describe('docs/handlers-extraction-plan.md — sequencing and tranche', () => {
  test('states the single-open-blocker constraint that forces a chain', () => {
    expect(doc).toMatch(/one open blocker|at most one open blocker|single-blocker/i);
  });

  test('lists per-slice prerequisites, verification, and rollback requirements', () => {
    expect(doc).toMatch(/\*\*Prerequisites\*\*/);
    expect(doc).toMatch(/\*\*Verification\*\*/);
    expect(doc).toMatch(/\*\*Rollback\*\*/);
  });

  test('defines stop conditions that halt the chain', () => {
    expect(doc).toMatch(/Stop conditions/i);
  });

  test('has rules preventing regrowth during the migration', () => {
    expect(doc).toMatch(/## 10\. Rules preventing regrowth/);
    expect(doc).toMatch(/No new policy decision may be authored inside a handler/i);
    expect(doc).toMatch(/No handler may acquire the issue lock/i);
  });

  test('drafts the first tranche as five issues: three contract-test slices plus two policy slices', () => {
    expect(doc).toMatch(/### Issue T1 —/);
    expect(doc).toMatch(/### Issue T2 —/);
    expect(doc).toMatch(/### Issue T3 —/);
    expect(doc).toMatch(/### Issue P1 —/);
    expect(doc).toMatch(/### Issue P2 —/);
  });

  test('each drafted issue states its blocker so the filed graph is a chain', () => {
    const blockers = doc.match(/\*\*blocker\*\*:/g) ?? [];
    expect(blockers.length).toBeGreaterThanOrEqual(5);
  });

  test('maps the plan back to the DOMAIN.md §2.3 context contracts', () => {
    expect(doc).toMatch(/## 12\. Coordination with the DOMAIN\.md §2\.3 context contracts/);
  });
});

// ---------------------------------------------------------------------------
// Current-state facts the plan's sequencing depends on
// ---------------------------------------------------------------------------

describe('docs/handlers-extraction-plan.md — pinned current-state facts', () => {
  test('the phase runner already acquires the issue lock for all three worktree phases', () => {
    // This is why the plan schedules a lock DELETION (§6 M1) rather than the
    // hook extension DOMAIN.md §2.2's wording implies. If this stops being
    // true, M1's scope is wrong.
    const runOnePhase = read('src/cli/run-one-phase.ts');
    const worktreePhases = runOnePhase.match(/const WORKTREE_PHASES[^;]*;/s);
    expect(worktreePhases).not.toBeNull();
    expect(worktreePhases[0]).toMatch(/"implementation"/);
    expect(worktreePhases[0]).toMatch(/"review"/);
    expect(worktreePhases[0]).toMatch(/"conflict_resolution"/);
    expect(runOnePhase).toMatch(/acquirePhaseLock:\s*\(task\)\s*=>\s*acquireIssuePhaseLock/);
    expect(doc).toMatch(/the extension already landed|extension already landed/i);
  });

  test('the dual-mode (worktree vs canonical) branches are gone, so the plan excludes them', () => {
    for (const rel of [
      'src/handlers/implementation.ts',
      'src/handlers/review.ts',
      'src/handlers/conflict-resolution.ts',
    ]) {
      expect(read(rel)).not.toMatch(/worktreeMode/);
    }
    expect(doc).toMatch(/[Dd]ual-mode deletion is complete and is not a step here/);
  });

  test('the runtime core→handlers leak the plan records still exists and is recorded, not repaired', () => {
    expect(read('src/core/transitions.ts')).toMatch(
      /import \{ ARTIFACT_DIR_PENDING_CONTEXT_FIELD \} from "\.\.\/handlers\/artifact-dir\.js"/,
    );
    expect(doc).toMatch(/ARTIFACT_DIR_PENDING_CONTEXT_FIELD/);
    expect(domain).toMatch(/five.*boundary leaks|\*\*five\*\* boundary leaks/i);
  });

  test('the three handler factories still take the positional seams the reshape replaces', () => {
    expect(read('src/handlers/implementation.ts')).toMatch(/export function createImplementationHandler\(/);
    expect(read('src/handlers/review.ts')).toMatch(/export function createReviewHandler\(/);
    expect(read('src/handlers/conflict-resolution.ts')).toMatch(/export function createConflictResolutionHandler\(/);
  });
});

// ---------------------------------------------------------------------------
// Cross-document consistency
// ---------------------------------------------------------------------------

describe('handlers extraction plan — cross-document consistency', () => {
  test('DOMAIN.md points its handlers hot spots at this plan', () => {
    expect(domain).toMatch(/docs\/handlers-extraction-plan\.md/);
  });

  test('DOMAIN.md §5 derived issue 2 records the plan as the decided specification', () => {
    expect(domain).toMatch(/#692, 2026-07-27[\s\S]{0,120}handlers-extraction-plan\.md/);
  });

  test('the responsibility inventory defers its line numbers to the plan', () => {
    expect(inventory).toMatch(/handlers-extraction-plan\.md/);
    expect(inventory).toMatch(/re-derived/i);
  });

  test('the plan cites the inventory SHARED LIFECYCLE section as the contract-test checklist', () => {
    expect(doc).toMatch(/SHARED LIFECYCLE/);
    expect(inventory).toMatch(/## SHARED LIFECYCLE/);
  });
});
