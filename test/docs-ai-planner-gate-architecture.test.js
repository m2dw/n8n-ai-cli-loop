/**
 * Contract tests for docs/ai-planner-gate-architecture.md (issue #357).
 *
 * The AI Planner gate is specified as documentation before any implementation
 * code lands. These tests pin the acceptance criteria from issue #357 so the
 * spec cannot silently regress on the claims a follow-up implementation issue
 * depends on:
 *   - the deterministic heuristic is explicitly NOT the primary semantic
 *     classifier anymore;
 *   - the policy gate fail-closed rules are explicit;
 *   - the planner JSON shape documents the required fields;
 *   - planner output is advisory until accepted by policy;
 *   - untrusted-input handling and the read-only MVP constraints are stated;
 *   - the contract doc forward-references this architecture.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/ai-planner-gate-architecture.md');
const contract = read('docs/issue-planning-gate-contract.md');

describe('docs/ai-planner-gate-architecture.md — heuristic is no longer the primary classifier', () => {
  test('states the deterministic heuristic is no longer the primary semantic classifier', () => {
    expect(doc).toMatch(/no longer the primary semantic classifier/i);
  });

  test('retains the heuristic as guard, feature extractor, baseline, and fixture source', () => {
    expect(doc).toMatch(/hard guard/i);
    expect(doc).toMatch(/feature extraction/i);
    expect(doc).toMatch(/baseline estimate/i);
    expect(doc).toMatch(/fixture source/i);
  });
});

describe('docs/ai-planner-gate-architecture.md — responsibility split', () => {
  test('names the three components', () => {
    expect(doc).toMatch(/Deterministic heuristic/i);
    expect(doc).toMatch(/AI Planner/);
    expect(doc).toMatch(/Policy arbiter/i);
  });

  test('assigns semantic classification to the AI Planner, not the heuristic', () => {
    expect(doc).toMatch(/AI Planner[\s\S]{0,400}semantic classification/i);
  });
});

describe('docs/ai-planner-gate-architecture.md — planner output schema', () => {
  // Every field the issue requires must be documented for the follow-up impl.
  const requiredFields = [
    'recommendedFlow',
    'complexity',
    'recommendedImplementationEffort',
    'recommendedReviewEffort',
    'riskSignals',
    'confidence',
    'splitRecommendation',
    'requiresHumanGate',
    'guardConflicts',
    'reasoningSummary',
  ];
  for (const field of requiredFields) {
    test(`documents the \`${field}\` field`, () => {
      expect(doc).toMatch(new RegExp(`"${field}"`));
    });
  }

  test('marks the planner output as JSON with a provenance distinct from the heuristic baseline', () => {
    expect(doc).toMatch(/"source":\s*"ai-planner"/);
  });
});

describe('docs/ai-planner-gate-architecture.md — policy gate fail-closed rules', () => {
  test('uses explicit fail-closed language', () => {
    expect(doc).toMatch(/fail[- ]closed/i);
  });

  test('defines the final decision vocabulary', () => {
    expect(doc).toMatch(/auto-run/);
    expect(doc).toMatch(/human-gate/);
    expect(doc).toMatch(/blocked/);
    expect(doc).toMatch(/split/);
  });

  test('forces a human gate when the planner is unavailable, malformed, or low-confidence', () => {
    expect(doc).toMatch(/unavailable/i);
    expect(doc).toMatch(/malformed/i);
    expect(doc).toMatch(/low confidence|low-confidence/i);
  });

  test('never produces auto-run unless the planner is present, valid, confident, and guard-consistent', () => {
    expect(doc).toMatch(/no path produces `auto-run` unless/i);
  });

  test('hard guards beat the planner', () => {
    expect(doc).toMatch(/guard[\s\S]{0,80}(beat|win|cannot clear|over the planner)/i);
  });
});

describe('docs/ai-planner-gate-architecture.md — advisory until accepted', () => {
  test('states planner output is advisory until accepted by policy', () => {
    expect(doc).toMatch(/advisory until[\s\S]{0,60}(accept|policy arbiter)/i);
  });

  test('downstream phases act on the arbiter decision, not raw planner output', () => {
    expect(doc).toMatch(/arbiter decision[\s\S]{0,80}(never|not).{0,40}raw planner/i);
  });
});

describe('docs/ai-planner-gate-architecture.md — untrusted input handling', () => {
  test('treats issue body and comments as untrusted, attacker-controllable data', () => {
    expect(doc).toMatch(/untrusted/i);
    expect(doc).toMatch(/attacker-controllable/i);
    expect(doc).toMatch(/prompt[- ]injection/i);
  });

  test('strips write-enabling env vars in the agent environment', () => {
    expect(doc).toMatch(/WRITE_ENABLING_ENV_KEYS/);
  });

  test('guards are computed independently of the planner so injection cannot clear them', () => {
    expect(doc).toMatch(/independently of the planner/i);
  });
});

describe('docs/ai-planner-gate-architecture.md — MVP rollout constraints', () => {
  test('read-only artifacts first, no GitHub writes', () => {
    expect(doc).toMatch(/read-only artifacts first/i);
    expect(doc).toMatch(/No GitHub writes/i);
  });

  test('no label or task mutation', () => {
    expect(doc).toMatch(/No label or task mutation/i);
  });
});

describe('docs/ai-planner-gate-architecture.md — fixture and history reuse', () => {
  test('reuses the deterministic bounded-view producer and existing fixtures', () => {
    expect(doc).toMatch(/analyzeIssueForPlan/);
    expect(doc).toMatch(/issue-plan\.test\.js/);
  });

  test('reuses the history evaluation dataset as the planner evaluation set', () => {
    expect(doc).toMatch(/issue-plan-history\.ts/);
    expect(doc).toMatch(/calibrationEligible/);
  });
});

describe('docs/ai-planner-gate-architecture.md — non-goals', () => {
  test('states no AI provider execution and no planner/critic/arbiter consensus in this issue', () => {
    expect(doc).toMatch(/No AI provider execution/i);
    expect(doc).toMatch(/No planner\/critic\/arbiter consensus/i);
  });
});

describe('docs/issue-planning-gate-contract.md — forward reference', () => {
  test('points to the AI Planner architecture and demotes the heuristic', () => {
    expect(contract).toMatch(/ai-planner-gate-architecture\.md/);
    expect(contract).toMatch(/no longer the primary semantic classifier/i);
  });
});
