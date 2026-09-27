/**
 * Provider-neutral runtime quality resolution (issue #905, slice B2 of
 * docs/agent-runtime-profiles-contract.md §14.1).
 *
 * The slice resolves a *request* and persists it; it changes no invocation. So
 * what these cover is the request itself: that all four levels are reachable,
 * that §8.2's precedence chain holds top to bottom, that §10.1's compatibility
 * mapping preserves today's label rules (strongest wins, an explicit review
 * label beats a complexity-derived one, `review:xhigh` stays unrecognized),
 * that §10.2's phase-to-class assignment is total, that escalation raises and
 * never lowers, that every malformed or contradictory request refuses rather
 * than resolving to something nearby, and that nothing here consults a
 * provider, a capability, or an agent id.
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  AgentQualityError,
  DEFAULT_REQUESTED_QUALITY,
  PHASE_CLASSES,
  QUALITY_CONTEXT_KEY,
  QUALITY_LABEL_PREFIX,
  QUALITY_LEVELS,
  QUALITY_PIN_CONTEXT_KEY,
  QUALITY_SOURCES,
  REVIEW_LOOP_ESCALATION_QUALITY,
  applyQualityEscalation,
  compareQuality,
  isQualityLevel,
  phaseClassForDisputeTurn,
  phaseClassForPhase,
  qualityForPhase,
  qualityForPhaseClass,
  qualityRank,
  readQualityPin,
  readResolvedQuality,
  resolveRequestedQuality,
  strongerQuality,
} from '../dist/index.js';
import { labelsToComplexity, labelsToReviewStrength } from '../dist/core/github-intake.js';
import { DISPUTE_TURN_KINDS, EVIDENCE_COLLECTION_PARTIES } from '../dist/core/review-dispute-turn.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-09-09T00:00:00.000Z';

function resolveQuality(labels, extra = {}) {
  return resolveRequestedQuality({ labels, now: NOW, ...extra });
}

function refusal(fn) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AgentQualityError);
  expect(thrown.reason).toBe('invalid-quality-request');
  return thrown;
}

/** A task carrying whatever context the case under test needs. */
function task(context) {
  return {
    sessionId: 's',
    issueNumber: 7,
    status: 'queued',
    phase: 'implementation',
    priority: 'normal',
    attempts: {},
    context,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
  };
}

describe('agent-quality — the four levels (§5)', () => {
  test('the vocabulary is the catalog module\'s, ordered weakest to strongest', () => {
    expect([...QUALITY_LEVELS]).toEqual(['light', 'normal', 'strong', 'maximum']);
    expect(QUALITY_LEVELS.map(qualityRank)).toEqual([0, 1, 2, 3]);
    expect(compareQuality('light', 'maximum')).toBeLessThan(0);
    expect(compareQuality('maximum', 'light')).toBeGreaterThan(0);
    expect(compareQuality('normal', 'normal')).toBe(0);
    expect(strongerQuality('light', 'strong')).toBe('strong');
    expect(strongerQuality('maximum', 'strong')).toBe('maximum');
  });

  test('nothing outside the vocabulary is a level', () => {
    for (const value of ['xhigh', 'max', 'high', 'ultra', 'LIGHT', '', undefined, null, 3]) {
      expect(isQualityLevel(value)).toBe(false);
    }
  });

  test('the default request is normal and the escalation floor is a level', () => {
    expect(DEFAULT_REQUESTED_QUALITY).toBe('normal');
    expect(isQualityLevel(REVIEW_LOOP_ESCALATION_QUALITY)).toBe(true);
  });
});

describe('agent-quality — compatibility labels (§10.1)', () => {
  test('every complexity label maps to its level, and all four are reachable', () => {
    expect(resolveQuality(['complexity:low']).implementation).toEqual({
      quality: 'light',
      source: 'compat-label',
      label: 'complexity:low',
    });
    expect(resolveQuality([]).implementation).toEqual({ quality: 'normal', source: 'default' });
    expect(resolveQuality(['complexity:high']).implementation.quality).toBe('strong');
    expect(resolveQuality(['complexity:xhigh']).implementation.quality).toBe('maximum');
  });

  test('every review label maps to its level for the review class', () => {
    expect(resolveQuality(['review:low']).review).toEqual({
      quality: 'light',
      source: 'compat-label',
      label: 'review:low',
    });
    expect(resolveQuality(['review:medium']).review.quality).toBe('normal');
    expect(resolveQuality(['review:high']).review.quality).toBe('strong');
    expect(resolveQuality([]).review).toEqual({ quality: 'normal', source: 'default' });
  });

  test('the strongest label of a family wins, as it does today', () => {
    expect(
      resolveQuality(['complexity:low', 'complexity:high', 'complexity:xhigh']).implementation.quality,
    ).toBe('maximum');
    expect(resolveQuality(['review:low', 'review:high']).review.quality).toBe('strong');
  });

  test('an explicit review label beats a complexity-derived one', () => {
    const resolved = resolveQuality(['complexity:xhigh', 'review:low']);
    expect(resolved.review).toEqual({
      quality: 'light',
      source: 'compat-label',
      label: 'review:low',
    });
    // The implementation class still reads its own family.
    expect(resolved.implementation.quality).toBe('maximum');
  });

  test('with no review label the review class derives from the complexity family', () => {
    expect(resolveQuality(['complexity:high']).review).toEqual({
      quality: 'strong',
      source: 'compat-label',
      label: 'complexity:high',
    });
    expect(resolveQuality(['complexity:low']).review.quality).toBe('light');
  });

  test('complexity:xhigh derives maximum for review, not a pre-capped level', () => {
    // Today's `labelsToReviewStrength` caps a complexity-derived review at the
    // strongest effort one provider's CLI accepted in 2026. The neutral request
    // is not capped: what `maximum` costs is the provider binding's answer
    // (§6.3), which is exactly the calcified assumption this contract removes.
    expect(labelsToReviewStrength(['complexity:xhigh']).strength).toBe('high');
    expect(labelsToReviewStrength(['complexity:high']).strength).toBe('high');
    expect(resolveQuality(['complexity:xhigh']).review.quality).toBe('maximum');
    expect(resolveQuality(['complexity:high']).review.quality).toBe('strong');
  });

  test('review:xhigh stays an unrecognized label and falls through', () => {
    // Not a refusal: the compatibility families keep their pre-contract meaning,
    // where an unrecognized spelling contributes nothing (§8.2, §10.1).
    expect(resolveQuality(['review:xhigh']).review).toEqual({ quality: 'normal', source: 'default' });
    expect(resolveQuality(['review:xhigh', 'complexity:high']).review).toEqual({
      quality: 'strong',
      source: 'compat-label',
      label: 'complexity:high',
    });
  });

  test('an unrecognized complexity spelling also contributes nothing', () => {
    expect(resolveQuality(['complexity:medium']).implementation).toEqual({
      quality: 'normal',
      source: 'default',
    });
  });

  test('the mapping preserves today\'s tier ordering', () => {
    // A pin on behavior preservation (§10.3): the label sets today's mapping
    // orders as low < default < high < xhigh must order the same way as levels.
    const byLabels = [[], ['complexity:low'], ['complexity:high'], ['complexity:xhigh']];
    const efforts = byLabels.map((labels) => labelsToComplexity(labels).effort);
    expect(new Set(efforts).size).toBeGreaterThan(1);
    const ranked = byLabels
      .map((labels) => resolveQuality(labels).implementation.quality)
      .map(qualityRank);
    expect(ranked).toEqual([qualityRank('normal'), qualityRank('light'), qualityRank('strong'), qualityRank('maximum')]);
  });
});

describe('agent-quality — the quality:* namespace (§10.1)', () => {
  test('a quality label outranks both compatibility families, for both classes', () => {
    const resolved = resolveQuality(['complexity:low', 'review:high', 'quality:maximum']);
    expect(resolved.implementation).toEqual({
      quality: 'maximum',
      source: 'label',
      label: 'quality:maximum',
    });
    expect(resolved.review).toEqual({
      quality: 'maximum',
      source: 'label',
      label: 'quality:maximum',
    });
  });

  test('every level is spellable in the canonical namespace', () => {
    for (const level of QUALITY_LEVELS) {
      expect(resolveQuality([`${QUALITY_LABEL_PREFIX}${level}`]).implementation.quality).toBe(level);
    }
  });

  test('the same level stated twice is one request, not a conflict', () => {
    expect(resolveQuality(['quality:strong', 'quality:strong']).implementation.quality).toBe('strong');
  });

  test('two quality labels naming different levels refuse', () => {
    const err = refusal(() => resolveQuality(['quality:light', 'quality:strong']));
    expect(err.message).toMatch(/quality:light/);
    expect(err.message).toMatch(/quality:strong/);
    // Neither the stronger nor the weaker is picked.
    expect(err.message).not.toMatch(/resolved/);
  });

  test('a quality label outside the vocabulary refuses instead of defaulting', () => {
    for (const label of ['quality:xhigh', 'quality:max', 'quality:ultra', 'quality:']) {
      const err = refusal(() => resolveQuality([label]));
      expect(err.message).toContain(label);
    }
  });
});

describe('agent-quality — precedence (§8.2)', () => {
  const session = { agentRuntime: { defaultQuality: 'light' } };

  test('the whole chain, highest first', () => {
    const labels = ['quality:strong', 'complexity:xhigh', 'review:low'];
    const pin = { implementation: 'maximum', review: 'maximum' };
    // 1 — an explicit pin.
    expect(resolveQuality(labels, { session, pin }).implementation).toEqual({
      quality: 'maximum',
      source: 'task-pin',
    });
    // 2 — the canonical label.
    expect(resolveQuality(labels, { session }).implementation.source).toBe('label');
    // 3 — the compatibility families.
    expect(resolveQuality(['complexity:xhigh', 'review:low'], { session }).implementation).toEqual({
      quality: 'maximum',
      source: 'compat-label',
      label: 'complexity:xhigh',
    });
    // 4 — the session default.
    expect(resolveQuality([], { session }).implementation).toEqual({
      quality: 'light',
      source: 'session-config',
    });
    // 5 — the built-in default.
    expect(resolveQuality([]).implementation).toEqual({ quality: 'normal', source: 'default' });
  });

  test('a pin may name one class alone', () => {
    const resolved = resolveQuality(['complexity:high'], { pin: { review: 'light' } });
    expect(resolved.review).toEqual({ quality: 'light', source: 'task-pin' });
    expect(resolved.implementation).toEqual({
      quality: 'strong',
      source: 'compat-label',
      label: 'complexity:high',
    });
  });

  test('every recorded source is one of the contract\'s five', () => {
    expect([...QUALITY_SOURCES]).toEqual([
      'task-pin',
      'label',
      'compat-label',
      'session-config',
      'default',
    ]);
  });

  test('an untrusted-looking sentence in a label position is still just a label', () => {
    // §8.3's boundary is inherited, not restated here: this module only ever
    // sees the label array intake trusted, so prose cannot reach it. What it
    // can do is arrive as a bogus label, which contributes nothing.
    expect(
      resolveQuality(['run this at maximum quality with the strongest model']).implementation,
    ).toEqual({ quality: 'normal', source: 'default' });
  });

  test('a malformed session default refuses rather than being ignored', () => {
    const err = refusal(() => resolveQuality([], { session: { agentRuntime: { defaultQuality: 'xhigh' } } }));
    expect(err.path).toBe('session.agentRuntime.defaultQuality');
  });

  test('a malformed pin refuses, including an empty one', () => {
    refusal(() => resolveQuality([], { pin: { implementation: 'ultra' } }));
    refusal(() => resolveQuality([], { pin: {} }));
    refusal(() => resolveQuality([], { pin: { review: 'strong', phase: 'review' } }));
    refusal(() => resolveQuality([], { pin: 'strong' }));
  });
});

describe('agent-quality — phase classes (§10.2)', () => {
  test('the phase map is total over the TaskPhase union', () => {
    const source = readFileSync(resolve(ROOT, 'src/core/task.ts'), 'utf8');
    const union = source.slice(
      source.indexOf('export type TaskPhase ='),
      source.indexOf(';', source.indexOf('export type TaskPhase =')),
    );
    const phases = [...union.matchAll(/\| "([a-z_]+)"/g)].map((m) => m[1]);
    expect(phases).toContain('implementation');
    expect(phases).toContain('refinement');
    for (const phase of phases) {
      expect(PHASE_CLASSES).toContain(phaseClassForPhase(phase));
    }
  });

  test('judging phases read the review class and producing phases the implementation class', () => {
    expect(phaseClassForPhase('review')).toBe('review-class');
    expect(phaseClassForPhase('content_review')).toBe('review-class');
    for (const phase of [
      'implementation',
      'conflict_resolution',
      'research',
      'content_research',
      'content_draft',
      'planner',
      'refinement',
    ]) {
      expect(phaseClassForPhase(phase)).toBe('implementation-class');
    }
  });

  test('every dispute sub-turn is classified, or declared to run no agent', () => {
    const classified = {
      implementer_fix: 'implementation-class',
      reviewer_reconsideration: 'review-class',
      re_review: 'review-class',
      runner_arbitration: 'review-class',
    };
    for (const kind of DISPUTE_TURN_KINDS) {
      if (kind === 'evidence_collection') continue;
      expect(phaseClassForDisputeTurn(kind)).toBe(classified[kind]);
    }
    for (const kind of ['human_handoff', 'no_turn', 'unresolvable']) {
      expect(phaseClassForDisputeTurn(kind)).toBeUndefined();
    }
  });

  test('evidence collection is per party and refuses to guess one', () => {
    expect([...EVIDENCE_COLLECTION_PARTIES]).toEqual(['implementer', 'reviewer']);
    expect(phaseClassForDisputeTurn('evidence_collection', 'implementer')).toBe('implementation-class');
    expect(phaseClassForDisputeTurn('evidence_collection', 'reviewer')).toBe('review-class');
    refusal(() => phaseClassForDisputeTurn('evidence_collection'));
  });
});

describe('agent-quality — escalation (§10.3)', () => {
  const requested = (quality, source = 'compat-label') => ({ quality, source });

  test('a floor raises a weaker request and records itself as the source', () => {
    expect(applyQualityEscalation(requested('normal'), 'strong')).toEqual({
      quality: 'strong',
      source: 'escalation',
      requested: requested('normal'),
      escalationFloor: 'strong',
    });
  });

  test('a floor never lowers a stronger request, and never rewrites its source', () => {
    expect(applyQualityEscalation(requested('maximum'), 'strong')).toEqual({
      quality: 'maximum',
      source: 'compat-label',
      requested: requested('maximum'),
      escalationFloor: 'strong',
    });
    // Equal is not a raise either — the request already meets the floor.
    expect(applyQualityEscalation(requested('strong'), 'strong').source).toBe('compat-label');
  });

  test('no floor leaves the request exactly as it was', () => {
    expect(applyQualityEscalation(requested('light', 'task-pin'))).toEqual({
      quality: 'light',
      source: 'task-pin',
      requested: requested('light', 'task-pin'),
    });
  });

  test('the review-loop floor raises the default request but not a stronger one', () => {
    const floor = REVIEW_LOOP_ESCALATION_QUALITY;
    expect(applyQualityEscalation(requested('normal', 'default'), floor).quality).toBe(floor);
    expect(applyQualityEscalation(requested('maximum'), floor).quality).toBe('maximum');
  });

  test('a floor outside the vocabulary refuses instead of being ignored', () => {
    refusal(() => applyQualityEscalation(requested('normal'), 'high'));
  });
});

describe('agent-quality — persistence on the task (§9.3)', () => {
  const snapshot = resolveQuality(['complexity:high', 'review:low']);

  test('the intake snapshot round-trips through task context', () => {
    const read = readResolvedQuality(task({ [QUALITY_CONTEXT_KEY]: JSON.parse(JSON.stringify(snapshot)) }));
    expect(read).toEqual(snapshot);
    expect(read.resolvedAt).toBe(NOW);
  });

  test('a task with no snapshot is an absence, not an error', () => {
    expect(readResolvedQuality(task({}))).toBeUndefined();
    expect(readQualityPin(task({}))).toBeUndefined();
  });

  test('a malformed snapshot refuses rather than resolving to normal', () => {
    for (const bad of [
      { implementation: { quality: 'strong', source: 'compat-label' }, resolvedAt: NOW },
      { implementation: { quality: 'ultra', source: 'label' }, review: { quality: 'normal', source: 'default' }, resolvedAt: NOW },
      { implementation: { quality: 'strong', source: 'made-up' }, review: { quality: 'normal', source: 'default' }, resolvedAt: NOW },
      { ...snapshot, resolvedAt: '' },
      'strong',
    ]) {
      refusal(() => readResolvedQuality(task({ [QUALITY_CONTEXT_KEY]: bad })));
    }
  });

  test('a phase reads its own class\'s persisted request', () => {
    const row = task({ [QUALITY_CONTEXT_KEY]: snapshot });
    expect(qualityForPhase(row, undefined, 'implementation').quality).toBe('strong');
    expect(qualityForPhase(row, undefined, 'review').quality).toBe('light');
    expect(qualityForPhaseClass(row, undefined, 'review-class').requested.label).toBe('review:low');
  });

  test('relabelling does not move a task that carries a snapshot', () => {
    const row = task({ [QUALITY_CONTEXT_KEY]: snapshot, labels: ['complexity:low'] });
    expect(qualityForPhase(row, undefined, 'implementation').quality).toBe('strong');
  });

  test('a task created before the snapshot existed resolves from its persisted labels', () => {
    const row = task({ labels: ['complexity:xhigh'] });
    expect(qualityForPhase(row, undefined, 'implementation')).toEqual({
      quality: 'maximum',
      source: 'compat-label',
      requested: { quality: 'maximum', source: 'compat-label', label: 'complexity:xhigh' },
    });
    // With neither a snapshot nor labels, the session default and then `normal`.
    expect(qualityForPhase(task({}), { agentRuntime: { defaultQuality: 'light' } }, 'review').quality).toBe(
      'light',
    );
    expect(qualityForPhase(task({}), undefined, 'review').quality).toBe('normal');
  });

  test('an operator pin outranks the snapshot without rewriting it', () => {
    const row = task({
      [QUALITY_CONTEXT_KEY]: snapshot,
      [QUALITY_PIN_CONTEXT_KEY]: { implementation: 'light' },
    });
    expect(qualityForPhase(row, undefined, 'implementation')).toEqual({
      quality: 'light',
      source: 'task-pin',
      requested: { quality: 'light', source: 'task-pin' },
    });
    // The unpinned class still reads the snapshot.
    expect(qualityForPhase(row, undefined, 'review').quality).toBe('light');
    expect(qualityForPhaseClass(row, undefined, 'review-class').requested.source).toBe('compat-label');
    expect(row.context[QUALITY_CONTEXT_KEY]).toEqual(snapshot);
  });

  test('a malformed pin on the task refuses', () => {
    refusal(() => readQualityPin(task({ [QUALITY_PIN_CONTEXT_KEY]: { implementation: 'ultra' } })));
    refusal(() => qualityForPhase(task({ [QUALITY_PIN_CONTEXT_KEY]: {} }), undefined, 'review'));
  });

  test('an escalation floor applies on top of whatever the task carries', () => {
    const row = task({ [QUALITY_CONTEXT_KEY]: snapshot });
    expect(qualityForPhase(row, undefined, 'review', { escalationFloor: 'strong' })).toEqual({
      quality: 'strong',
      source: 'escalation',
      requested: { quality: 'light', source: 'compat-label', label: 'review:low' },
      escalationFloor: 'strong',
    });
    expect(
      qualityForPhase(row, undefined, 'implementation', { escalationFloor: 'normal' }).quality,
    ).toBe('strong');
  });
});

describe('agent-quality — no provider assumption (§5, §14.3)', () => {
  const source = readFileSync(resolve(ROOT, 'src/core/agent-quality.ts'), 'utf8');

  test('the resolver names no model and no provider effort value', () => {
    // Provider effort values and model names may not appear as data here. The
    // label tables mention `complexity:xhigh` and `review:medium`, which are
    // label spellings, not effort values — hence the leading quote in the
    // pattern, which only matches a bare literal.
    expect(source).not.toMatch(/"(?:low|medium|high|xhigh|max|ultra)"/);
    for (const model of ['sonnet', 'opus', 'fable', 'gpt-', 'gemini']) {
      expect(source).not.toContain(model);
    }
  });

  test('the resolver never reads the catalog, a provider, or an agent id', () => {
    // It imports the vocabulary from the catalog module and nothing else: no
    // capability descriptor, no binding lookup, no `providerForAgent`.
    expect(source).toMatch(/import \{ QUALITY_LEVELS \} from "\.\/agent-profile-catalog\.js"/);
    for (const forbidden of [
      'providerForAgent',
      'lookupQualityBinding',
      'providerCatalogFor',
      'loadAgentProfileCatalog',
      'capabilities',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test('resolution does not depend on which agent will answer', () => {
    // Two Issues differing only in their agent label resolve the same request;
    // what that request costs is the provider binding's answer, not this
    // module's (§6.3).
    const claude = resolveQuality(['agent:claude', 'complexity:xhigh']);
    const codex = resolveQuality(['agent:codex', 'complexity:xhigh']);
    expect(codex).toEqual(claude);
    expect(claude.review.quality).toBe('maximum');
  });
});
