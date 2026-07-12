/**
 * Contract tests for docs/idea-to-implementation.md.
 *
 * This operator-facing guide documents the full idea -> PR lifecycle. The
 * tests below pin down the operational claims that have drifted (or could
 * drift) from the implementation, so the doc fails CI if it regresses to
 * known-bad wording. They are not a substitute for a live smoke test — they
 * verify that the guide stays aligned with current handler/CLI behavior.
 *
 * Each describe block maps to one of the assertions called out in issue #177.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/idea-to-implementation.md');

/** Slice from the "When to Intervene Manually" heading to the end of the doc. */
function interveneSection() {
  const idx = doc.indexOf('## When to Intervene Manually');
  expect(idx).toBeGreaterThan(-1);
  return doc.slice(idx);
}

// ---------------------------------------------------------------------------
// Issue body handling (coordinated with #173)
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — issue body handling', () => {
  // After #173 the issue body IS persisted at intake and included in the
  // implementation prompt. The doc must not regress to the pre-#173 claim
  // that the body is dropped before reaching Claude.
  test('does not claim the issue body is omitted from the implementation prompt', () => {
    expect(doc).not.toMatch(/issue body is\s+\**not\**\s+(passed|included|consumed)/i);
    expect(doc).not.toMatch(/body is\s+\**not\**\s+passed to Claude/i);
    expect(doc).not.toMatch(/(does not|doesn't|do not)\s+pass(es)?\s+the\s+(issue\s+)?body/i);
    expect(doc).not.toMatch(/only persists `title`, `url`, and `labels`/i);
  });

  test('states that the issue body is persisted and included in the prompt', () => {
    expect(doc).toMatch(/issue body[\s\S]{0,160}(persist|includ|passed)/i);
    // The prompt embeds the body under an Issue Description heading.
    expect(doc).toMatch(/## Issue Description|Issue Description/);
  });
});

// ---------------------------------------------------------------------------
// Failed implementation recovery -> admin recover (not row deletion)
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — failed implementation recovery', () => {
  test('recommends `admin recover` as the recovery path', () => {
    expect(doc).toMatch(/admin recover\b/);
  });

  test('does not present deleting the failed row as the primary recovery path', () => {
    const section = interveneSection();
    // The failed-task row must not instruct deleting the row as the main path.
    expect(section).not.toMatch(/clear or delete the failed row/i);
  });
});

// ---------------------------------------------------------------------------
// Review-loop cap recovery -> admin recover-cap-handoff
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — review-loop cap recovery', () => {
  test('mentions `admin recover-cap-handoff` for cap-blocked tasks', () => {
    expect(doc).toMatch(/admin recover-cap-handoff\b/);
  });

  test('ties the cap handoff to the reviewLoopCapReached condition', () => {
    expect(doc).toMatch(/reviewLoopCapReached/);
  });
});

// ---------------------------------------------------------------------------
// Blocked tasks are NOT recoverable via `admin recover`
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — blocked task recovery', () => {
  /** Slice the single table row that documents the `ai:blocked` situation. */
  function blockedRow() {
    const section = interveneSection();
    const lines = section.split('\n');
    const row = lines.find((l) => /\|\s*`ai:blocked`/.test(l));
    expect(row).toBeTruthy();
    return row;
  }

  // `recoverTask()` only accepts failed/claimed/running and rejects `blocked`,
  // so `admin recover` is a no-op for an `ai:blocked` task. The guide must not
  // direct operators to use `admin recover` for blocked tasks.
  test('does not direct blocked tasks to `admin recover`', () => {
    expect(blockedRow()).not.toMatch(/run `admin recover\b/);
  });

  test('states that `admin recover` does not apply to blocked tasks', () => {
    expect(blockedRow()).toMatch(/admin recover[\s\S]{0,80}(does not apply|no-op|not apply|reject)/i);
  });
});

// ---------------------------------------------------------------------------
// Event queries filter by session_id (multi-session safety)
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — event queries', () => {
  test('the events query example filters by session_id', () => {
    const eventsIdx = doc.indexOf('FROM events');
    expect(eventsIdx).toBeGreaterThan(-1);
    // Grab the SELECT ... FROM events ... query block around the match.
    const block = doc.slice(eventsIdx, eventsIdx + 200);
    expect(block).toMatch(/session_id/);
  });

  test('the tasks query example filters by session_id', () => {
    const tasksIdx = doc.indexOf('FROM tasks');
    expect(tasksIdx).toBeGreaterThan(-1);
    const block = doc.slice(tasksIdx, tasksIdx + 200);
    expect(block).toMatch(/session_id/);
  });
});

// ---------------------------------------------------------------------------
// Artifacts directory and .gitignore exclusion expectation
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — artifacts', () => {
  test('references the .n8n-artifacts/ directory', () => {
    expect(doc).toMatch(/\.n8n-artifacts\//);
  });

  test('documents the .gitignore / artifact-exclusion expectation', () => {
    expect(doc).toMatch(/\.gitignore/);
    expect(doc).toMatch(/\.n8n-artifacts\/[\s\S]{0,200}(ignore|exclud|not.*commit)/i);
  });
});

// ---------------------------------------------------------------------------
// Label-only recovery is idempotent for existing tasks
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — label-only recovery', () => {
  test('warns that label-only intake is idempotent for existing tasks', () => {
    expect(doc).toMatch(/idempotent/i);
    expect(doc).toMatch(/already_exists/);
  });

  test('explains that re-applying labels alone will not requeue an existing task', () => {
    expect(doc).toMatch(/label.*(no-op|not enough|will not requeue|alone is a no-op)/i);
  });
});

// ---------------------------------------------------------------------------
// Dormant-first creation for dependent issue stacks (issue #371)
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — dormant-first dependent stacks', () => {
  /** Slice the dormant-first subsection. */
  function dormantSection() {
    const idx = doc.indexOf('#### Dormant-first creation for dependent issue stacks');
    expect(idx).toBeGreaterThan(-1);
    // Stop at the next top-level Step heading.
    const rest = doc.slice(idx);
    const end = rest.indexOf('\n## ');
    return end > -1 ? rest.slice(0, end) : rest;
  }

  test('states the dormant-first rule for dependent stacks', () => {
    const section = dormantSection();
    expect(section).toMatch(/dormant/i);
    // Dependent issues must be created without executable labels first.
    expect(section).toMatch(/`agent:\*`/);
    expect(section).toMatch(/status:needs-implementation/);
  });

  test('explains why executable labels before relationship setup are unsafe', () => {
    const section = dormantSection();
    // The race: labels observed before the blocked by relationship is visible.
    expect(section).toMatch(/before[\s\S]{0,120}`blocked by`/i);
    expect(section).toMatch(/not self-healing|no retroactive effect|idempotent/i);
  });

  test('references the #360–#365 race as the motivating failure mode', () => {
    expect(dormantSection()).toMatch(/#360[\s\S]{0,6}#365/);
  });

  test('distinguishes single, stacked, and root-activation cases', () => {
    const section = dormantSection();
    expect(section).toMatch(/single independent issue/i);
    expect(section).toMatch(/dependent stack creation/i);
    expect(section).toMatch(/activat\w+ the root|root after verification/i);
  });
});

// ---------------------------------------------------------------------------
// Scope declaration — thin CLI path only
// ---------------------------------------------------------------------------

describe('docs/idea-to-implementation.md — scope declaration', () => {
  /** Text before the first Step heading — the preamble where scope must appear. */
  function preamble() {
    const idx = doc.indexOf('## Step 1');
    expect(idx).toBeGreaterThan(-1);
    return doc.slice(0, idx);
  }

  test('declares the thin CLI path scope before operational steps begin', () => {
    const pre = preamble();
    expect(pre).toMatch(/github-intake/);
    expect(pre).toMatch(/run-one-phase/);
  });

  test('references the parent/child workflow import files in the preamble', () => {
    expect(preamble()).toMatch(/n8n-thin-child-workflow\.json/);
    expect(preamble()).toMatch(/n8n-thin-parent-workflow\.json/);
  });
});
