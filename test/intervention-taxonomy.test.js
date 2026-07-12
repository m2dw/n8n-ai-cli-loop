/**
 * Tests for the intervention taxonomy classifier (issue #587).
 */
import {
  classifyIntervention,
  isCountableIntervention,
  isPlannedHumanAction,
  isCandidate,
  INTERVENTION_L1,
  INTERVENTION_L2,
  INTERVENTION_L3,
  INTERVENTION_CANDIDATE,
  INTERVENTION_NONE,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// classifyIntervention — L1
// ---------------------------------------------------------------------------

describe('classifyIntervention — L1 (human guidance)', () => {
  test.each([
    ['issue_comment_guidance'],
    ['pr_comment_guidance'],
  ])('classifies %s as L1 and counts as intervention', (signal) => {
    const result = classifyIntervention(signal);
    expect(result.level).toBe(INTERVENTION_L1);
    expect(result.signal).toBe(signal);
    expect(result.countsAsIntervention).toBe(true);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// classifyIntervention — L2
// ---------------------------------------------------------------------------

describe('classifyIntervention — L2 (human code work)', () => {
  test.each([
    ['human_commit_on_ai_branch'],
    ['manual_conflict_fix_commit'],
    ['manual_ci_fix_commit'],
  ])('classifies %s as L2 and counts as intervention', (signal) => {
    const result = classifyIntervention(signal);
    expect(result.level).toBe(INTERVENTION_L2);
    expect(result.signal).toBe(signal);
    expect(result.countsAsIntervention).toBe(true);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// classifyIntervention — L3
// ---------------------------------------------------------------------------

describe('classifyIntervention — L3 (human rescue / operations)', () => {
  test.each([
    ['admin_recover'],
    ['human_review_return'],
    ['tool_request_resolution'],
    ['quarantine'],
    ['task_recreation'],
    ['manual_db_repair'],
  ])('classifies %s as L3 and counts as intervention', (signal) => {
    const result = classifyIntervention(signal);
    expect(result.level).toBe(INTERVENTION_L3);
    expect(result.signal).toBe(signal);
    expect(result.countsAsIntervention).toBe(true);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// classifyIntervention — planned human actions (not interventions)
// ---------------------------------------------------------------------------

describe('classifyIntervention — planned human actions (excluded)', () => {
  test.each([
    ['issue_creation'],
    ['merge_approval'],
    ['planned_human_gate'],
  ])('classifies %s as none and does NOT count as intervention', (signal) => {
    const result = classifyIntervention(signal);
    expect(result.level).toBe(INTERVENTION_NONE);
    expect(result.signal).toBe(signal);
    expect(result.countsAsIntervention).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// classifyIntervention — ambiguous / candidate
// ---------------------------------------------------------------------------

describe('classifyIntervention — ambiguous signals', () => {
  test('classifies unknown as candidate and does NOT count as intervention', () => {
    const result = classifyIntervention('unknown');
    expect(result.level).toBe(INTERVENTION_CANDIDATE);
    expect(result.signal).toBe('unknown');
    expect(result.countsAsIntervention).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// All signals produce a non-empty reason
// ---------------------------------------------------------------------------

describe('classifyIntervention — reason completeness', () => {
  const ALL_SIGNALS = [
    'issue_comment_guidance', 'pr_comment_guidance',
    'human_commit_on_ai_branch', 'manual_conflict_fix_commit', 'manual_ci_fix_commit',
    'admin_recover', 'human_review_return', 'tool_request_resolution',
    'quarantine', 'task_recreation', 'manual_db_repair',
    'issue_creation', 'merge_approval', 'planned_human_gate',
    'unknown',
  ];

  test('every signal produces a non-empty reason string', () => {
    for (const signal of ALL_SIGNALS) {
      const result = classifyIntervention(signal);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// isCountableIntervention
// ---------------------------------------------------------------------------

describe('isCountableIntervention', () => {
  test.each([
    [INTERVENTION_L1, true],
    [INTERVENTION_L2, true],
    [INTERVENTION_L3, true],
    [INTERVENTION_CANDIDATE, false],
    [INTERVENTION_NONE, false],
  ])('level %s → %s', (level, expected) => {
    expect(isCountableIntervention(level)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// isPlannedHumanAction
// ---------------------------------------------------------------------------

describe('isPlannedHumanAction', () => {
  test('returns true only for INTERVENTION_NONE', () => {
    expect(isPlannedHumanAction(INTERVENTION_NONE)).toBe(true);
  });

  test.each([
    [INTERVENTION_L1],
    [INTERVENTION_L2],
    [INTERVENTION_L3],
    [INTERVENTION_CANDIDATE],
  ])('returns false for %s', (level) => {
    expect(isPlannedHumanAction(level)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCandidate
// ---------------------------------------------------------------------------

describe('isCandidate', () => {
  test('returns true only for INTERVENTION_CANDIDATE', () => {
    expect(isCandidate(INTERVENTION_CANDIDATE)).toBe(true);
  });

  test.each([
    [INTERVENTION_L1],
    [INTERVENTION_L2],
    [INTERVENTION_L3],
    [INTERVENTION_NONE],
  ])('returns false for %s', (level) => {
    expect(isCandidate(level)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review/fix loop is separate from intervention count
// ---------------------------------------------------------------------------

describe('review/fix loop separation', () => {
  test('no signal kind maps directly to a review/fix-loop event', () => {
    // The review/fix loop is tracked via ReviewFixLoopRecord, not via
    // classifyIntervention. None of the countable signals should represent
    // an AI-driven review→fix cycle — that would conflate automation effort
    // with human intervention.
    const countableSignals = [
      'issue_comment_guidance', 'pr_comment_guidance',
      'human_commit_on_ai_branch', 'manual_conflict_fix_commit', 'manual_ci_fix_commit',
      'admin_recover', 'human_review_return', 'tool_request_resolution',
      'quarantine', 'task_recreation', 'manual_db_repair',
    ];
    for (const signal of countableSignals) {
      const result = classifyIntervention(signal);
      // Verify each countable signal is genuinely human-initiated (not an AI
      // review/fix cycle), by checking the reason does not describe AI self-repair.
      expect(result.reason.toLowerCase()).not.toMatch(/ai.driven|self.repair|automated review/);
    }
  });
});
