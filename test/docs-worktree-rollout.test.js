/**
 * Structural tests for docs/worktree-rollout.md.
 *
 * These tests verify that the operator guide contains the key reference
 * points an operator needs to enable, verify, and recover per-issue
 * worktrees.  They are not a substitute for a live smoke test.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/worktree-rollout.md');

// ---------------------------------------------------------------------------
// Manual checklist disclaimer
// ---------------------------------------------------------------------------

describe('docs/worktree-rollout.md — disclaimer', () => {
  test('explicitly marks smoke-test checklist as manual', () => {
    expect(doc).toMatch(/[Mm]anual checklist/);
  });

  test('does not claim the smoke test was run and passed automatically', () => {
    expect(doc).not.toMatch(
      /smoke.test.*(?:was|has been|is)\s+(?:completed|verified|passed|run successfully)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Enabling worktrees
// ---------------------------------------------------------------------------

describe('docs/worktree-rollout.md — enabling worktrees', () => {
  test('references sessions.json', () => {
    expect(doc).toMatch(/sessions\.json/);
  });

  test('shows worktrees.enabled: true in a JSON snippet', () => {
    expect(doc).toMatch(/"worktrees"/);
    expect(doc).toMatch(/"enabled":\s*true/);
  });

  test('documents the optional root field', () => {
    expect(doc).toMatch(/"root"/);
  });

  test('documents the N8N_AI_WORKTREE_ROOT environment variable', () => {
    expect(doc).toMatch(/N8N_AI_WORKTREE_ROOT/);
  });
});

// ---------------------------------------------------------------------------
// Operational model
// ---------------------------------------------------------------------------

describe('docs/worktree-rollout.md — operational model', () => {
  test('explains canonical repo role (fetch / registry)', () => {
    expect(doc).toMatch(/[Cc]anonical/);
    expect(doc).toMatch(/[Ff]etch/);
  });

  test('states phases execute in issue worktrees', () => {
    expect(doc).toMatch(/[Pp]hase/);
    expect(doc).toMatch(/[Ww]orktree/);
  });

  test('documents IssueWorktreeLock concurrency guarantee', () => {
    expect(doc).toMatch(/IssueWorktreeLock|issue lock|lock_contended/);
  });
});

// ---------------------------------------------------------------------------
// Mid-flight enablement
// ---------------------------------------------------------------------------

describe('docs/worktree-rollout.md — mid-flight enablement', () => {
  test('covers adding worktrees to a session with active tasks', () => {
    expect(doc).toMatch(/[Mm]id.?[Ff]light/i);
  });

  test('states no database migration is required', () => {
    expect(doc).toMatch(/[Nn]o database migration|[Nn]o DB migration|[Nn]o.*migration/);
  });
});

// ---------------------------------------------------------------------------
// Smoke-test checklist items
// ---------------------------------------------------------------------------

describe('docs/worktree-rollout.md — smoke-test checklist', () => {
  test('covers the implementation phase path', () => {
    expect(doc).toMatch(/[Ii]mplementation path/);
  });

  test('covers the review phase path', () => {
    expect(doc).toMatch(/[Rr]eview path/);
  });

  test('covers the Tool Request path', () => {
    expect(doc).toMatch(/[Tt]ool [Rr]equest path/);
  });

  test('covers the cleanup path', () => {
    expect(doc).toMatch(/[Cc]leanup path/);
  });

  test('mentions worktreeId in checklist', () => {
    expect(doc).toMatch(/worktreeId/);
  });

  test('mentions worktreePath in checklist', () => {
    expect(doc).toMatch(/worktreePath/);
  });
});

// ---------------------------------------------------------------------------
// Admin commands
// ---------------------------------------------------------------------------

describe('docs/worktree-rollout.md — admin commands', () => {
  test('documents worktree list command', () => {
    expect(doc).toMatch(/worktree list/);
  });

  test('documents worktree prune command', () => {
    expect(doc).toMatch(/worktree prune/);
  });

  test('documents worktree cleanup command', () => {
    expect(doc).toMatch(/worktree cleanup/);
  });

  test('documents worktree release-lock command', () => {
    expect(doc).toMatch(/worktree release-lock/);
  });

  test('documents worktree recovery command', () => {
    expect(doc).toMatch(/worktree recovery/);
  });

  test('states recovery is read-only', () => {
    expect(doc).toMatch(/read.only/i);
  });

  test('states cleanup never deletes branches', () => {
    expect(doc).toMatch(/[Bb]ranches are never deleted/);
  });
});

// ---------------------------------------------------------------------------
// Security / path confidentiality
// ---------------------------------------------------------------------------

describe('docs/worktree-rollout.md — path confidentiality', () => {
  test('warns that local worktree paths must not be posted publicly', () => {
    expect(doc).toMatch(/[Dd]o not.*post.*public|[Nn]ot.*post.*publicly|never.*post.*public|must not.*post/i);
  });

  test('references sessionRedactionPaths or redaction mechanism', () => {
    expect(doc).toMatch(/sessionRedactionPaths|redact/);
  });
});
