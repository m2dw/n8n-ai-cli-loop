/**
 * Structural tests for the Dirty Worktree Policy section of
 * docs/per-issue-worktrees.md (issue #567).
 *
 * These tests verify that the specification covers each required topic:
 * canonical vs. per-issue dirty distinction, fail-closed conditions, the
 * human-edited worktree stance, and the follow-up work items.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const doc = readFileSync(resolve(ROOT, 'docs/per-issue-worktrees.md'), 'utf8');

// ---------------------------------------------------------------------------
// Section presence
// ---------------------------------------------------------------------------

describe('docs/per-issue-worktrees.md — dirty worktree policy section', () => {
  test('contains a Dirty Worktree Policy heading', () => {
    expect(doc).toMatch(/##\s+Dirty Worktree Policy/);
  });
});

// ---------------------------------------------------------------------------
// Canonical vs. per-issue distinction
// ---------------------------------------------------------------------------

describe('docs/per-issue-worktrees.md — canonical vs. per-issue distinction', () => {
  test('states canonical checkout dirty is fatal', () => {
    expect(doc).toMatch(/[Cc]anonical.*[Ff]atal|[Ff]atal.*[Cc]anonical/s);
  });

  test('states per-issue worktree dirty is not automatically fatal', () => {
    expect(doc).toMatch(/[Pp]er.issue worktree.*[Nn]ot automatically fatal|[Nn]ot automatically fatal.*[Pp]er.issue/s);
  });

  test('covers shared/non-isolated checkout case', () => {
    expect(doc).toMatch(/[Ss]hared.*checkout|non-isolated/);
  });
});

// ---------------------------------------------------------------------------
// Continuation safety checks
// ---------------------------------------------------------------------------

describe('docs/per-issue-worktrees.md — continuation safety checks', () => {
  test('requires worktree to be registered in git worktree list', () => {
    expect(doc).toMatch(/git worktree list/);
  });

  test('requires HEAD branch to match expected issue branch', () => {
    expect(doc).toMatch(/HEAD.*branch.*ai\/issue|branch.*HEAD.*ai\/issue|HEAD.*matches.*expected/i);
  });

  test('requires issue number to match worktree key', () => {
    expect(doc).toMatch(/issue number.*match|match.*issue number/i);
  });

  test('states lock contention is still fatal', () => {
    expect(doc).toMatch(/Active lock contention|lock contention[\s\S]{0,40}still fatal/i);
  });

  test('requires canonical checkout to be clean', () => {
    expect(doc).toMatch(/canonical checkout is clean|canonical.*clean/);
  });
});

// ---------------------------------------------------------------------------
// Why dirty continuation is safe
// ---------------------------------------------------------------------------

describe('docs/per-issue-worktrees.md — rationale for dirty continuation', () => {
  test('explains one worktree per issue ownership', () => {
    expect(doc).toMatch(/owns.*one worktree|one worktree.*owned|each issue owns/i);
  });

  test('references IssueWorktreeLock as the concurrency guard', () => {
    expect(doc).toMatch(/IssueWorktreeLock/);
  });
});

// ---------------------------------------------------------------------------
// Human-edited worktrees
// ---------------------------------------------------------------------------

describe('docs/per-issue-worktrees.md — human-edited worktrees', () => {
  test('states perfect human-vs-AI dirty detection is not required', () => {
    expect(doc).toMatch(
      /[Pp]erfect detection.*not required|not.*attempt.*detect.*human.*AI|neither required nor attempted/i,
    );
  });

  test('states human edits are treated as operator intervention', () => {
    expect(doc).toMatch(/operator.*edits?.*treated|treats? those edits|treat.*edits.*starting point/i);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed conditions
// ---------------------------------------------------------------------------

describe('docs/per-issue-worktrees.md — fail-closed conditions', () => {
  test('lists canonical dirty as a fail-closed condition', () => {
    expect(doc).toMatch(/[Cc]anonical checkout is dirty/);
  });

  test('lists branch mismatch as a fail-closed condition', () => {
    expect(doc).toMatch(/[Bb]ranch mismatch/);
  });

  test('lists issue mismatch as a fail-closed condition', () => {
    expect(doc).toMatch(/[Ii]ssue mismatch/);
  });

  test('lists missing or invalid worktree as a fail-closed condition', () => {
    expect(doc).toMatch(/[Mm]issing or invalid worktree/);
  });

  test('lists active lock contention as a fail-closed condition', () => {
    expect(doc).toMatch(/[Aa]ctive lock contention/);
  });

  test('lists unsafe paths as a fail-closed condition', () => {
    expect(doc).toMatch(/[Uu]nsafe path|outside the managed worktree root/);
  });
});

// ---------------------------------------------------------------------------
// Follow-up work items
// ---------------------------------------------------------------------------

describe('docs/per-issue-worktrees.md — follow-up work items', () => {
  test('identifies recording dirty-failure state as a follow-up', () => {
    expect(doc).toMatch(/[Rr]ecord.*dirty.failure state|dirty-failure.*marker|dirty.failure state/);
  });

  test('identifies continuing dirty worktrees as a follow-up', () => {
    expect(doc).toMatch(/[Cc]ontinue dirty worktrees|continuation logic/);
  });

  test('identifies manual discard as a follow-up', () => {
    expect(doc).toMatch(/[Mm]anual discard|admin worktree discard/);
  });
});

// ---------------------------------------------------------------------------
// Operator status view — dirty worktree states (issue #569)
// ---------------------------------------------------------------------------

describe('docs/per-issue-worktrees.md — operator status view', () => {
  test('contains an operator status view section for dirty worktree states', () => {
    expect(doc).toMatch(/[Oo]perator status view|[Oo]perator [Ss]tatus/);
  });

  test('documents the continuation_candidate state', () => {
    expect(doc).toMatch(/continuation_candidate/);
  });

  test('documents the continuation_active state', () => {
    expect(doc).toMatch(/continuation_active/);
  });

  test('documents the action_required state', () => {
    expect(doc).toMatch(/action_required/);
  });

  test('describes the canonical dirty state as fatal', () => {
    expect(doc).toMatch(/[Cc]anonical.*fatal|fatal.*[Cc]anonical/s);
  });

  test('provides worktree prune as the discard recovery command', () => {
    expect(doc).toMatch(/admin worktree prune.*--force|worktree prune.*--force/);
  });

  test('notes that public comments do not expose worktree paths or dirty-state details', () => {
    expect(doc).toMatch(/[Pp]ublic comments? never include|never.*publish|sanitized/);
  });
});
