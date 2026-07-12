/**
 * Structural tests for docs/archive/minimal-self-driving.md and README.md.
 *
 * These tests are not a substitute for a live smoke test — they verify that
 * the documentation contains the expected reference points so a maintainer
 * can follow the guide without hitting dead ends.
 *
 * Note: minimal-self-driving.md has been archived to docs/archive/ as it
 * describes the flat thin workflow superseded by the parent/child split.
 * The test reads from the archive path; the original path is now a stub.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/archive/minimal-self-driving.md');
const readme = read('README.md');
const phaseContracts = read('docs/phase-contracts.md');

// ---------------------------------------------------------------------------
// README links
// ---------------------------------------------------------------------------

describe('README', () => {
  test('links to docs/archive/minimal-self-driving.md (archived flat-workflow guide)', () => {
    expect(readme).toMatch(/docs\/archive\/minimal-self-driving\.md/);
  });

  test('references parent/child workflow import paths', () => {
    expect(readme).toMatch(/docs\/n8n-thin-parent-workflow\.json/);
    expect(readme).toMatch(/docs\/n8n-thin-child-workflow\.json/);
  });

  test('links to docs/phase-contracts.md', () => {
    expect(readme).toMatch(/docs\/phase-contracts\.md/);
  });

  test('mentions thin workflow as the recommended starting point', () => {
    // Should call out the thin workflow prominently (not just in the legacy section)
    expect(readme).toMatch(/[Tt]hin.*[Ww]ork|[Ww]ork.*[Tt]hin/);
  });

  test('references parent workflow import path', () => {
    expect(readme).toMatch(/docs\/n8n-thin-parent-workflow\.json/);
  });

  test('references child workflow import path', () => {
    expect(readme).toMatch(/docs\/n8n-thin-child-workflow\.json/);
  });

  test('documents that child must be imported before parent', () => {
    // The child must be imported first so n8n registers its ID before the parent resolves it
    const parentIdx = readme.indexOf('n8n-thin-parent-workflow');
    const childIdx = readme.indexOf('n8n-thin-child-workflow');
    expect(childIdx).toBeGreaterThan(-1);
    expect(parentIdx).toBeGreaterThan(-1);
    expect(childIdx).toBeLessThan(parentIdx);
  });

  test('references the child workflow stable ID', () => {
    expect(readme).toMatch(/ai-dev-loop-thin-phase-runner/);
  });
});

// ---------------------------------------------------------------------------
// Phase contracts
// ---------------------------------------------------------------------------

describe('docs/phase-contracts.md', () => {
  test('defines implementation, fix, review, and research contracts', () => {
    expect(phaseContracts).toMatch(/## Implementation/);
    expect(phaseContracts).toMatch(/## Fix Existing PR/);
    expect(phaseContracts).toMatch(/## Review/);
    expect(phaseContracts).toMatch(/## Research/);
  });

  test('keeps git and gh operations handler-owned', () => {
    expect(phaseContracts).toMatch(/Do not run repository state-changing `git` or `gh` commands/);
    expect(phaseContracts).toMatch(/handler-owned/);
  });

  test('documents canonical fix branch policy', () => {
    expect(phaseContracts).toMatch(/ai\/issue-<issueNumber>/);
    expect(phaseContracts).toMatch(/Legacy run-id branches/);
  });

  test('documents that fix mode requires review feedback in task context', () => {
    // Fix mode now auto-receives feedback via reviewFeedback in task context;
    // the doc should explain this rather than the old manual-inclusion note.
    expect(phaseContracts).toMatch(/reviewFeedback|review feedback|fix mode/i);
    expect(phaseContracts).toMatch(/fails.*before running Claude|fail.*before.*Claude|reviewFeedback.*non-empty|non-empty.*reviewFeedback/i);
  });

  test('documents no-direct-edits policy with automation-branch rationale', () => {
    // The policy must state that an automation-owned branch may be active even
    // when the agent cannot confirm it, and that spec/workflow changes go through Issues.
    expect(phaseContracts).toMatch(/automation-owned.*branch.*active|automation.*branch.*may be active/i);
    expect(phaseContracts).toMatch(/dedicated\s+Issue|as.*own.*Issue|through.*Issue/i);
  });

  test('no-direct-edits policy distinguishes inspection from behavior changes', () => {
    // Must explicitly allow normal inspection/diagnosis and operator-requested recovery.
    expect(phaseContracts).toMatch(/[Nn]ormal inspection|[Ii]nspection and diagnosis/);
    expect(phaseContracts).toMatch(/[Ll]ocal recovery|[Oo]perator.*request|[Rr]ecovery.*request/);
  });

  test('distinguishes textual conflicts from semantic conflicts', () => {
    expect(phaseContracts).toMatch(/textual conflict/i);
    expect(phaseContracts).toMatch(/semantic conflict/i);
  });

  test('classifies verification failure as semantic conflict-resolution failure', () => {
    expect(phaseContracts).toMatch(/semantic conflict.resolution failure/i);
  });

  test('defines verification failure as an escalation signal', () => {
    expect(phaseContracts).toMatch(/escalation signal/i);
  });

  test('states automation must stop rather than redesign autonomously', () => {
    expect(phaseContracts).toMatch(/cannot redesign|not.*redesign.*autonomous|do not.*redesign/i);
  });

  test('defines a safe public comment shape for operator-facing handoff', () => {
    expect(phaseContracts).toMatch(/[Ss]afe public comment|[Ss]afe.*operator.*comment|[Ss]afe.*comment shape/i);
  });

  test('specifies what must not appear in GitHub comments on escalation', () => {
    expect(phaseContracts).toMatch(/must not contain/i);
    expect(phaseContracts).toMatch(/[Ll]ocal filesystem path|[Ll]ocal.*path.*artifact/i);
    expect(phaseContracts).toMatch(/[Rr]aw agent output|[Rr]aw.*rationale/i);
  });

  test('states future work boundary — richer support must follow after escalation is established', () => {
    expect(phaseContracts).toMatch(/[Ff]uture work boundary/i);
    expect(phaseContracts).toMatch(/after this escalation boundary|escalation boundary is established/i);
  });
});

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

describe('docs/minimal-self-driving.md — prerequisites', () => {
  test('mentions node requirement', () => {
    expect(doc).toMatch(/\bnode\b/i);
  });

  test('mentions gh CLI and authentication', () => {
    expect(doc).toMatch(/\bgh\b/);
    expect(doc).toMatch(/gh auth/);
  });

  test('mentions claude CLI', () => {
    expect(doc).toMatch(/\bclaude\b/);
  });

  test('mentions codex CLI', () => {
    expect(doc).toMatch(/\bcodex\b/);
  });

  test('mentions research agent (agy / ANTIGRAVITY_BIN)', () => {
    expect(doc).toMatch(/agy|ANTIGRAVITY_BIN/);
  });

  test('mentions sessions.json location', () => {
    expect(doc).toMatch(/sessions\.json/);
    expect(doc).toMatch(/~\/.config\/n8n-ai-cli-loop/);
  });

  test('mentions SQLite DB default path', () => {
    expect(doc).toMatch(/dev_loop\.db/);
  });

  test('mentions npm install / npm run build', () => {
    expect(doc).toMatch(/npm install/);
    expect(doc).toMatch(/npm run build/);
  });
});

// ---------------------------------------------------------------------------
// Import steps
// ---------------------------------------------------------------------------

describe('docs/minimal-self-driving.md — import/run steps', () => {
  test('references the parent/child workflow import paths', () => {
    expect(doc).toMatch(/docs\/n8n-thin-child-workflow\.json/);
    expect(doc).toMatch(/docs\/n8n-thin-parent-workflow\.json/);
  });

  test('instructs to run manual trigger before activating schedule', () => {
    expect(doc).toMatch(/manual trigger/i);
    expect(doc).toMatch(/schedule trigger/i);
    // Should warn not to enable schedule until manual passes
    expect(doc).toMatch(/manual.*pass|smoke.*pass|before.*activat|after.*pass/is);
  });

  test('mentions --session-id flag', () => {
    expect(doc).toMatch(/--session-id/);
  });
});

// ---------------------------------------------------------------------------
// Three CLI calls in order
// ---------------------------------------------------------------------------

describe('docs/minimal-self-driving.md — three CLI calls', () => {
  test('references github-intake.js', () => {
    expect(doc).toMatch(/github-intake\.js/);
  });

  test('references run-one-phase.js', () => {
    expect(doc).toMatch(/run-one-phase\.js/);
  });

  test('references dispatch-outbox.js', () => {
    expect(doc).toMatch(/dispatch-outbox\.js/);
  });

  test('intake appears before run-one-phase in document order', () => {
    const idxIntake = doc.indexOf('github-intake');
    const idxRun = doc.indexOf('run-one-phase');
    expect(idxIntake).toBeGreaterThan(-1);
    expect(idxRun).toBeGreaterThan(-1);
    expect(idxIntake).toBeLessThan(idxRun);
  });

  test('run-one-phase appears before dispatch-outbox in document order', () => {
    const idxRun = doc.indexOf('run-one-phase');
    const idxDispatch = doc.indexOf('dispatch-outbox');
    expect(idxRun).toBeGreaterThan(-1);
    expect(idxDispatch).toBeGreaterThan(-1);
    expect(idxRun).toBeLessThan(idxDispatch);
  });
});

// ---------------------------------------------------------------------------
// Expected JSON outputs documented
// ---------------------------------------------------------------------------

describe('docs/minimal-self-driving.md — expected JSON outputs', () => {
  test('documents github-intake output with ok, candidates, enqueued fields', () => {
    expect(doc).toMatch(/"ok"/);
    expect(doc).toMatch(/"candidates"/);
    expect(doc).toMatch(/"enqueued"/);
  });

  test('documents run-one-phase idle outcome', () => {
    expect(doc).toMatch(/"outcome".*"idle"|"idle".*"outcome"/);
  });

  test('documents run-one-phase completed outcome', () => {
    expect(doc).toMatch(/"outcome".*"completed"|"completed".*"outcome"/);
  });

  test('documents dispatch-outbox dispatched/failed fields', () => {
    expect(doc).toMatch(/"dispatched"/);
    expect(doc).toMatch(/"failed"/);
  });

  test('explains that failed > 0 with ok: true is retryable (not a crash)', () => {
    expect(doc).toMatch(/retryable|retry|rate.limit/i);
  });
});

// ---------------------------------------------------------------------------
// State inspection commands
// ---------------------------------------------------------------------------

describe('docs/minimal-self-driving.md — state inspection', () => {
  test('includes sqlite3 inspection commands', () => {
    expect(doc).toMatch(/sqlite3/);
  });

  test('shows how to query pending outbox entries', () => {
    expect(doc).toMatch(/sent_at IS NULL/i);
  });

  test('references artifact directory structure', () => {
    expect(doc).toMatch(/runs\//);
    expect(doc).toMatch(/\.n8n-artifacts/);
  });

  test('mentions GitHub issue comments and labels as observable side effects', () => {
    expect(doc).toMatch(/comment/i);
    expect(doc).toMatch(/label/i);
  });
});

// ---------------------------------------------------------------------------
// Smoke-test checklist
// ---------------------------------------------------------------------------

describe('docs/minimal-self-driving.md — smoke-test checklist', () => {
  test('explicitly marks checklist as manual (not automated)', () => {
    expect(doc).toMatch(/[Mm]anual checklist|manual.*checklist/i);
  });

  test('smoke test uses research phase (safe, no PR created)', () => {
    expect(doc).toMatch(/research/i);
  });

  test('checklist has checkbox items (markdown task list syntax)', () => {
    const checkboxes = (doc.match(/^- \[ \]/gm) ?? []).length;
    expect(checkboxes).toBeGreaterThanOrEqual(5);
  });

  test('warns not to activate schedule trigger before manual pass', () => {
    expect(doc).toMatch(/[Aa]ctivate.*schedule|[Ss]chedule.*[Aa]ctivate/);
    expect(doc).toMatch(/[Oo]nly.*after|[Aa]fter.*pass/i);
  });

  test('dry-run action is documented as "dry_run" (matching implementation)', () => {
    // github-intake.ts outputs action: "dry_run", not "candidate"
    expect(doc).toMatch(/"dry_run"/);
    // The checklist must not instruct the reader to expect action:"candidate"
    // as the expected value (it may mention "candidate" only as a contrast).
    // Check that we do NOT have `action: "candidate"` or `action:"candidate"`.
    expect(doc).not.toMatch(/action:\s*"candidate"/);
  });

  test('clarifies that research phase does not produce a bot comment', () => {
    // research only emits label effects — no comment outbox entry
    expect(doc).toMatch(/research.*no.*comment|comment.*not.*research|research.*comment.*expected|missing.*comment.*research/is);
  });
});

// ---------------------------------------------------------------------------
// Known MVP limitations
// ---------------------------------------------------------------------------

describe('docs/minimal-self-driving.md — MVP limitations', () => {
  test('documents needs_fix auto-requeue behavior', () => {
    // needs_fix now auto-requeues instead of escalating; doc should reflect this
    expect(doc).toMatch(/needs_fix/);
    expect(doc).toMatch(/auto-requeue|requeue|fix mode/i);
  });

  test('documents conflict escalation to human', () => {
    expect(doc).toMatch(/conflict/i);
  });

  test('documents that only one phase runs per execution', () => {
    expect(doc).toMatch(/one phase per|one task.*execut|per.*execut/i);
  });

  test('documents conflict_resolution not handled', () => {
    expect(doc).toMatch(/conflict_resolution/);
  });

  test('distinguishes MVP stops from real failures', () => {
    // Should have a table or section contrasting the two
    expect(doc).toMatch(/[Mm][Vv][Pp].*stop|[Ee]xpected.*stop|stop.*expected/i);
    expect(doc).toMatch(/real fail|actual fail/i);
  });

  test('does not claim the smoke test was run and passed automatically', () => {
    // Must not positively assert a live test passed.
    // A disclaimer ("No live smoke test has been performed") is fine.
    expect(doc).not.toMatch(/smoke.test.*(?:was|has been|is)\s+(?:completed|verified|passed|run successfully)/i);
    // Must explicitly call out that the checklist is manual
    expect(doc).toMatch(/[Mm]anual checklist/);
  });
});

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

describe('docs/minimal-self-driving.md — next steps', () => {
  test('does not list review feedback auto-requeue as a future next step (already implemented)', () => {
    // Review feedback auto-requeue is now implemented, so Next Steps should not list it
    // (It may appear in the doc as a description of implemented behavior, but not as a pending todo)
    const nextStepsSection = doc.match(/## Next Steps[\s\S]*/)?.[0] ?? '';
    expect(nextStepsSection).not.toMatch(/review feedback auto-requeue/i);
  });

  test('links or refers to future-architecture.md', () => {
    expect(doc).toMatch(/future-architecture/);
  });
});
