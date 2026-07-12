/**
 * Structural tests for docs/parent-child-workflow.md.
 *
 * These tests verify that the migration guide contains the expected reference
 * points so a maintainer can follow the guide without hitting dead ends.
 * They are not a substitute for a live smoke test.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CHILD_WORKFLOW_ID } from '../scripts/build-parent-child-workflow.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/parent-child-workflow.md');

// ---------------------------------------------------------------------------
// Manual checklist disclaimer
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — disclaimer', () => {
  test('explicitly marks checklist as manual (not automated)', () => {
    expect(doc).toMatch(/[Mm]anual checklist/);
  });

  test('does not claim the smoke test was run and passed automatically', () => {
    expect(doc).not.toMatch(
      /smoke.test.*(?:was|has been|is)\s+(?:completed|verified|passed|run successfully)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// What Changed section — explains parent/child split
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — what changed', () => {
  test('references the flat thin workflow JSON', () => {
    expect(doc).toMatch(/n8n-thin-self-driving-workflow\.json/);
  });

  test('references the parent workflow JSON', () => {
    expect(doc).toMatch(/n8n-thin-parent-workflow\.json/);
  });

  test('references the child workflow JSON', () => {
    expect(doc).toMatch(/n8n-thin-child-workflow\.json/);
  });

  test('mentions the child stable workflow ID', () => {
    expect(doc).toMatch(new RegExp(CHILD_WORKFLOW_ID));
  });

  test('mentions the parent workflow ID', () => {
    expect(doc).toMatch(/ai-dev-loop-thin-parent/);
  });

  test('explains that child reads parent payload directly and avoids $json overwrite', () => {
    expect(doc).toMatch(/When Called by Parent/);
    expect(doc).toMatch(/sessionId/);
    expect(doc).toMatch(/\$json.*overwrite|\$json.*overwrite|overwrite.*\$json/i);
  });
});

// ---------------------------------------------------------------------------
// Import order
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — import order', () => {
  test('child workflow import appears before parent workflow import', () => {
    const childIdx = doc.indexOf('n8n-thin-child-workflow');
    const parentIdx = doc.indexOf('n8n-thin-parent-workflow');
    expect(childIdx).toBeGreaterThan(-1);
    expect(parentIdx).toBeGreaterThan(-1);
    expect(childIdx).toBeLessThan(parentIdx);
  });

  test('documents that child must be imported before parent', () => {
    expect(doc).toMatch(/child.*before.*parent|import.*child.*first|child.*first/is);
  });
});

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — prerequisites', () => {
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
// Three CLI calls in order
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — three CLI calls', () => {
  test('references github-intake.js', () => {
    expect(doc).toMatch(/github-intake\.js/);
  });

  test('references run-one-phase.js', () => {
    expect(doc).toMatch(/run-one-phase\.js/);
  });

  test('references dispatch-outbox.js', () => {
    expect(doc).toMatch(/dispatch-outbox\.js/);
  });

  test('intake appears before run-one-phase in command-order section', () => {
    // Scope to "Expected JSON Outputs" section where command order is documented,
    // since run-one-phase is also mentioned earlier in "Why Migrate" for a different purpose.
    const sectionStart = doc.indexOf('## Expected JSON Outputs');
    const section = sectionStart >= 0 ? doc.slice(sectionStart) : doc;
    const idxIntake = section.indexOf('github-intake');
    const idxRun = section.indexOf('run-one-phase');
    expect(idxIntake).toBeGreaterThan(-1);
    expect(idxRun).toBeGreaterThan(-1);
    expect(idxIntake).toBeLessThan(idxRun);
  });

  test('run-one-phase appears before dispatch-outbox in command-order section', () => {
    // Scope to "Expected JSON Outputs" section where command order is documented.
    const sectionStart = doc.indexOf('## Expected JSON Outputs');
    const section = sectionStart >= 0 ? doc.slice(sectionStart) : doc;
    const idxRun = section.indexOf('run-one-phase');
    const idxDispatch = section.indexOf('dispatch-outbox');
    expect(idxRun).toBeGreaterThan(-1);
    expect(idxDispatch).toBeGreaterThan(-1);
    expect(idxRun).toBeLessThan(idxDispatch);
  });
});

// ---------------------------------------------------------------------------
// Smoke-test checklist
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — smoke-test checklist', () => {
  test('smoke test uses research phase (safe, no PR created)', () => {
    expect(doc).toMatch(/research/i);
  });

  test('checklist has checkbox items (markdown task list syntax)', () => {
    const checkboxes = (doc.match(/^- \[ \]/gm) ?? []).length;
    expect(checkboxes).toBeGreaterThanOrEqual(5);
  });

  test('warns not to activate schedule trigger before manual pass', () => {
    expect(doc).toMatch(/[Aa]ctivate.*[Ss]chedule|[Ss]chedule.*[Aa]ctivate/);
    expect(doc).toMatch(/[Oo]nly.*after|[Aa]fter.*pass/i);
  });

  test('dry-run action is documented as "dry_run"', () => {
    expect(doc).toMatch(/"dry_run"/);
    expect(doc).not.toMatch(/action:\s*"candidate"/);
  });

  test('confirms that research phase produces a bot comment', () => {
    expect(doc).toMatch(/Research complete/);
  });

  test('mentions --session-id flag', () => {
    expect(doc).toMatch(/--session-id/);
  });

  test('verifying child workflow ID is a checklist step', () => {
    expect(doc).toMatch(new RegExp(CHILD_WORKFLOW_ID));
  });
});

// ---------------------------------------------------------------------------
// Expected JSON outputs
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — expected JSON outputs', () => {
  test('documents ok field', () => {
    expect(doc).toMatch(/"ok"/);
  });

  test('documents run-one-phase idle outcome', () => {
    expect(doc).toMatch(/"outcome".*"idle"|"idle".*"outcome"/);
  });

  test('documents dispatched and failed fields', () => {
    expect(doc).toMatch(/"dispatched"/);
    expect(doc).toMatch(/"failed"/);
  });
});

// ---------------------------------------------------------------------------
// State inspection
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — state inspection', () => {
  test('includes sqlite3 inspection commands', () => {
    expect(doc).toMatch(/sqlite3/);
  });

  test('references artifact directory structure', () => {
    expect(doc).toMatch(/\.n8n-artifacts/);
  });
});

// ---------------------------------------------------------------------------
// MVP limitations
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — MVP limitations', () => {
  test('documents conflict escalation to human', () => {
    expect(doc).toMatch(/conflict/i);
  });

  test('documents that only one phase runs per execution', () => {
    expect(doc).toMatch(/one phase per|one task.*execut|per.*execut|one.*task.*at a time/i);
  });

  test('documents conflict_resolution not handled', () => {
    expect(doc).toMatch(/conflict_resolution/);
  });

  test('distinguishes MVP stops from real failures', () => {
    expect(doc).toMatch(/[Mm][Vv][Pp].*stop|[Ee]xpected.*stop|stop.*expected/i);
    expect(doc).toMatch(/real fail|actual fail/i);
  });
});

// ---------------------------------------------------------------------------
// Links and references
// ---------------------------------------------------------------------------

describe('docs/parent-child-workflow.md — links and references', () => {
  test('links to minimal-self-driving.md for the flat thin workflow', () => {
    expect(doc).toMatch(/minimal-self-driving/);
  });

  test('links or refers to future-architecture.md', () => {
    expect(doc).toMatch(/future-architecture/);
  });
});
