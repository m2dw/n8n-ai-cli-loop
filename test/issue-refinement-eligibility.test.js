/**
 * The intake-side predecessor gate (issue #967,
 * docs/issue-refinement-contract.md §4, §12 row 4).
 *
 * Two pure surfaces: the §4 conditions 2–5 evaluation, whose guard ORDER is
 * normative (a structural failure must never be reported as a hold, or the
 * handoff it needs is buried under retries), and the disposition decision that
 * says what intake persists — including the two answers that must move nothing
 * at all, an already-held row and a provider error.
 */

import {
  REFINEMENT_PREDECESSOR_HOLD_KEY,
  buildRefinementPredecessorHold,
  decideRefinementIntakeDisposition,
  describeRefinementPredecessorHold,
  evaluateRefinementIntakeEligibility,
  readRefinementPredecessorHold,
} from '../dist/index.js';

const STACK_READY = 'status:stack-ready';

function issueRead(number, labels = []) {
  return { number, state: 'open', title: `Issue ${number}`, body: '', labels };
}

function openPr(number, { headSha = 'sha-open', mergeable } = {}) {
  return {
    kind: 'found',
    pullRequest: {
      number,
      state: 'open',
      headRefName: `ai/issue-${number}`,
      headSha,
      title: `PR ${number}`,
      body: '',
      ...(mergeable !== undefined ? { mergeable } : {}),
    },
  };
}

function mergedPr(number) {
  return {
    kind: 'found',
    pullRequest: {
      number,
      state: 'merged',
      headRefName: `ai/issue-${number}`,
      headSha: 'sha-merged',
      mergeCommitSha: 'sha-merge-commit',
      title: `PR ${number}`,
      body: '',
    },
  };
}

/** A read-only source built from plain maps; anything unspecified is absent. */
function makeSource({ blockedBy = {}, issues = {}, prs = {}, chainAgreement } = {}) {
  return {
    getBlockedBy: async (n) => blockedBy[n] ?? [],
    readIssue: async (n) => issues[n] ?? issueRead(n),
    readPullRequest: async (n) => prs[n] ?? { kind: 'none' },
    ...(chainAgreement ? { readChainAgreement: chainAgreement } : {}),
  };
}

function evaluate(source, { issueNumber = 200, cap = 4 } = {}) {
  return evaluateRefinementIntakeEligibility({
    issueNumber,
    source,
    stackReadyLabel: STACK_READY,
    maxPredecessorsPerRefinement: cap,
  });
}

const OPEN = (n) => ({ issueNumber: n, state: 'open' });

// ---------------------------------------------------------------------------
// §4 conditions 2–5
// ---------------------------------------------------------------------------

describe('evaluateRefinementIntakeEligibility — §4 conditions 2–5', () => {
  test('an open stack-ready predecessor with a usable head is eligible', async () => {
    const result = await evaluate(
      makeSource({
        blockedBy: { 200: [OPEN(199)] },
        issues: { 199: issueRead(199, [STACK_READY]) },
        prs: { 199: openPr(199) },
      }),
    );
    expect(result).toEqual({ kind: 'eligible', predecessorIssueNumbers: [199] });
  });

  test('a merged predecessor is eligible without the stack-ready marker', async () => {
    const result = await evaluate(
      makeSource({
        blockedBy: { 200: [{ issueNumber: 199, state: 'closed', stateReason: 'completed' }] },
        issues: { 199: issueRead(199) },
        prs: { 199: mergedPr(199) },
      }),
    );
    expect(result.kind).toBe('eligible');
  });

  test('a predecessor without the stack-ready label holds, naming the predecessor', async () => {
    const result = await evaluate(
      makeSource({
        blockedBy: { 200: [OPEN(199)] },
        issues: { 199: issueRead(199) },
        prs: { 199: openPr(199) },
      }),
    );
    expect(result).toEqual({
      kind: 'hold',
      reason: 'predecessor_not_ready',
      predecessorIssueNumbers: [199],
      holds: [{ issueNumber: 199, reason: 'not_stack_ready' }],
    });
  });

  test('a predecessor with no PR holds', async () => {
    const result = await evaluate(
      makeSource({ blockedBy: { 200: [OPEN(199)] }, issues: { 199: issueRead(199, [STACK_READY]) } }),
    );
    expect(result.kind).toBe('hold');
    expect(result.holds).toEqual([{ issueNumber: 199, reason: 'no_pull_request' }]);
  });

  // §4: partial readiness holds; refining against half a chain produces a
  // contract the remaining predecessor immediately invalidates.
  test('one ready and one unready predecessor still holds', async () => {
    const result = await evaluate(
      makeSource({
        blockedBy: { 200: [OPEN(198), OPEN(199)] },
        issues: { 198: issueRead(198, [STACK_READY]), 199: issueRead(199, [STACK_READY]) },
        prs: { 198: openPr(198), 199: openPr(199, { mergeable: 'CONFLICTING' }) },
      }),
    );
    expect(result.kind).toBe('hold');
    expect(result.predecessorIssueNumbers).toEqual([198, 199]);
    expect(result.holds.map((h) => h.issueNumber)).toEqual([199]);
  });

  test('no direct predecessor is structural (not_chain_scoped), never a hold', async () => {
    const result = await evaluate(makeSource({}));
    expect(result).toEqual({
      kind: 'structural',
      reason: 'not_chain_scoped',
      predecessorIssueNumbers: [],
    });
  });

  // The ordering rule is the reason the structural guards run here at all: a
  // condition no poll can clear must not be buried under `predecessor_not_ready`.
  test('an over-wide fan-in is structural even when a predecessor is also unready', async () => {
    const result = await evaluate(
      makeSource({ blockedBy: { 200: [OPEN(1), OPEN(2), OPEN(3)] } }),
      { cap: 2 },
    );
    expect(result.kind).toBe('structural');
    expect(result.reason).toBe('fan_in_exceeded');
    expect(result.predecessorIssueNumbers).toEqual([1, 2, 3]);
    expect(result.detail).toContain('the cap is 2');
  });

  test('duplicate edges are collapsed before the cap is applied', async () => {
    const result = await evaluate(
      makeSource({
        blockedBy: { 200: [OPEN(199), OPEN(199)] },
        issues: { 199: issueRead(199, [STACK_READY]) },
        prs: { 199: openPr(199) },
      }),
      { cap: 1 },
    );
    expect(result).toEqual({ kind: 'eligible', predecessorIssueNumbers: [199] });
  });

  test('a chain disagreement is structural even when a predecessor is also unready', async () => {
    const result = await evaluate(
      makeSource({
        blockedBy: { 200: [OPEN(199)] },
        issues: { 199: issueRead(199) },
        chainAgreement: async () => ({ kind: 'disagrees', detail: 'chain c1: mismatch' }),
      }),
    );
    expect(result).toEqual({
      kind: 'structural',
      reason: 'chain_disagreement',
      predecessorIssueNumbers: [199],
      detail: 'chain c1: mismatch',
    });
  });

  test('an unregistered Issue takes no side and the readiness check still runs', async () => {
    const result = await evaluate(
      makeSource({
        blockedBy: { 200: [OPEN(199)] },
        issues: { 199: issueRead(199, [STACK_READY]) },
        prs: { 199: openPr(199) },
        chainAgreement: async () => ({ kind: 'unregistered' }),
      }),
    );
    expect(result.kind).toBe('eligible');
  });

  test.each([
    ['blocked_by', { getBlockedBy: true }],
    ['issue', { readIssue: true }],
    ['pull_request', { readPullRequest: true }],
    ['chain', { readChainAgreement: true }],
  ])('a %s read that throws is undetermined, never a verdict', async (stage, failing) => {
    const base = makeSource({
      blockedBy: { 200: [OPEN(199)] },
      issues: { 199: issueRead(199, [STACK_READY]) },
      prs: { 199: openPr(199) },
      chainAgreement: async () => ({ kind: 'agrees' }),
    });
    const source = { ...base };
    for (const key of Object.keys(failing)) {
      source[key] = async () => {
        throw new Error(`${key} exploded`);
      };
    }
    const result = await evaluate(source);
    expect(result.kind).toBe('undetermined');
    expect(result.stage).toBe(stage);
    expect(result.detail).toContain('exploded');
  });
});

// ---------------------------------------------------------------------------
// The persisted hold record
// ---------------------------------------------------------------------------

describe('the persisted hold record', () => {
  const eligibility = {
    kind: 'hold',
    reason: 'predecessor_not_ready',
    predecessorIssueNumbers: [199],
    holds: [{ issueNumber: 199, reason: 'not_stack_ready' }],
  };

  test('records literals and counters only, and round-trips', () => {
    const record = buildRefinementPredecessorHold({
      eligibility,
      previousStatus: 'queued',
      now: '2026-08-18T00:00:00.000Z',
    });
    expect(record).toEqual({
      reason: 'predecessor_not_ready',
      predecessorIssueNumbers: [199],
      holds: [{ issueNumber: 199, reason: 'not_stack_ready' }],
      previousStatus: 'queued',
      heldAt: '2026-08-18T00:00:00.000Z',
    });
    expect(readRefinementPredecessorHold({ [REFINEMENT_PREDECESSOR_HOLD_KEY]: record })).toEqual(record);
    expect(describeRefinementPredecessorHold(record)).toContain('#199 not_stack_ready');
  });

  test('a row created parked records no previous status', () => {
    const record = buildRefinementPredecessorHold({ eligibility, now: '2026-08-18T00:00:00.000Z' });
    expect(record.previousStatus).toBeUndefined();
  });

  test.each([
    ['absent context', undefined],
    ['no key', {}],
    ['a non-object', { [REFINEMENT_PREDECESSOR_HOLD_KEY]: 'held' }],
    ['an array', { [REFINEMENT_PREDECESSOR_HOLD_KEY]: [] }],
    ['a foreign reason', { [REFINEMENT_PREDECESSOR_HOLD_KEY]: { reason: 'something_else' } }],
  ])('reads %s as absent rather than defaulting', (_label, context) => {
    expect(readRefinementPredecessorHold(context)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The intake disposition
// ---------------------------------------------------------------------------

describe('decideRefinementIntakeDisposition', () => {
  const hold = {
    kind: 'hold',
    reason: 'predecessor_not_ready',
    predecessorIssueNumbers: [199],
    holds: [{ issueNumber: 199, reason: 'not_stack_ready' }],
  };
  const eligible = { kind: 'eligible', predecessorIssueNumbers: [199] };
  const structural = { kind: 'structural', reason: 'not_chain_scoped', predecessorIssueNumbers: [] };
  const undetermined = { kind: 'undetermined', stage: 'blocked_by', detail: 'boom' };
  const heldRecord = buildRefinementPredecessorHold({ eligibility: hold, now: 'now' });

  const row = (status, phase, context = {}) => ({ status, phase, context });
  const heldRow = row('blocked', 'refinement', { [REFINEMENT_PREDECESSOR_HOLD_KEY]: heldRecord });

  test.each([
    ['no row + hold', hold, undefined, 'hold'],
    ['no row + eligible', eligible, undefined, 'admit'],
    ['no row + structural', structural, undefined, 'admit'],
    ['no row + undetermined', undetermined, undefined, 'admit'],
    ['queued refinement + hold', hold, row('queued', 'refinement'), 'hold_existing'],
    ['queued refinement + eligible', eligible, row('queued', 'refinement'), 'admit'],
    ['held row + hold', hold, heldRow, 'leave'],
    ['held row + eligible', eligible, heldRow, 'reactivate'],
    ['held row + structural', structural, heldRow, 'reactivate'],
    ['held row + undetermined', undetermined, heldRow, 'leave'],
    ['running refinement + hold', hold, row('running', 'refinement'), 'leave'],
    ['ready_for_human refinement + hold', hold, row('ready_for_human', 'refinement'), 'leave'],
    ['disposed implementation row + hold', hold, row('done', 'implementation'), 'hold'],
    ['live implementation row + hold', hold, row('queued', 'implementation'), 'leave'],
  ])('%s → %s', (_label, eligibility, existing, kind) => {
    expect(decideRefinementIntakeDisposition({ eligibility, existing }).kind).toBe(kind);
  });

  // A `blocked` refinement row this gate did not write is not this gate's to
  // release — the hold record is what makes reactivation safe.
  test('a blocked refinement row without a hold record is left alone', () => {
    expect(
      decideRefinementIntakeDisposition({ eligibility: eligible, existing: row('blocked', 'refinement') }).kind,
    ).toBe('admit');
    expect(
      decideRefinementIntakeDisposition({ eligibility: hold, existing: row('blocked', 'refinement') }),
    ).toEqual({ kind: 'leave', reason: 'not_this_gate_s_row' });
  });

  test('the leave reasons distinguish a satisfied guard from an unanswered one', () => {
    expect(decideRefinementIntakeDisposition({ eligibility: hold, existing: heldRow })).toEqual({
      kind: 'leave',
      reason: 'already_held',
    });
    expect(decideRefinementIntakeDisposition({ eligibility: undetermined, existing: heldRow })).toEqual({
      kind: 'leave',
      reason: 'undetermined',
    });
  });

  test('a hold disposition carries the eligibility it was decided from', () => {
    const decision = decideRefinementIntakeDisposition({ eligibility: hold, existing: undefined });
    expect(decision).toEqual({ kind: 'hold', eligibility: hold });
  });
});
