/**
 * Unit tests for the issue #950 pending-turn selector
 * (src/core/review-dispute-turn.ts, docs/review-dispute-contract.md §7.1, §12,
 * §13).
 *
 * Two properties carry the whole slice, and every table below exists to pin one
 * of them:
 *
 *  - **precedence.** §7.1 evaluates its rules in order so exactly one outcome
 *    applies, and inside rule 2 the party order is `open`/`binding` →
 *    `disputed` → `evidence_requested` → `arbitration_pending`. The mixed-lineage
 *    table builds every combination of coexisting states and asserts both which
 *    turn wins and which lineages it carries — the shadowed states must be
 *    present in the block and absent from `lineageIds`, since a turn that drags
 *    a waiting lineage along would hand it to the wrong party.
 *  - **fail-closed.** A malformed, contradictory, or disabled input must never
 *    produce a dispatchable turn. The refusal table asserts the `unresolvable`
 *    kind AND that no protocol turn leaked, because the failure mode this
 *    selector exists to prevent is a `disputed` lineage quietly routed to an
 *    ordinary review run.
 */
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { aggregateDisputeRouting } from '../dist/core/review-dispute-transition.js';
import {
  DISPUTE_TURN_KINDS,
  EVIDENCE_COLLECTION_PARTIES,
  disputeTurnAwaitsDispatcher,
  selectPendingDisputeTurn,
} from '../dist/core/review-dispute-turn.js';

const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const LINEAGE_C = 'ln-cccccccccccc';
const LINEAGE_D = 'ln-dddddddddddd';
const BOUNDARY = 'src/auth/handler.ts';

/**
 * The debate history each state must carry to be a state the §7 table could have
 * reached, as the shortest row sequence that produces it:
 *
 *  - `open` v1 is the admission itself — nothing spent.
 *  - `disputed` is row 2: version 1's rebuttal slot is consumed, the round is not.
 *  - `arbitration_pending` is rows 2 → 10 (`uphold`), which spends the round.
 *  - `evidence_requested` is rows 2 → 10 → 16, so a verdict came back (one pass)
 *    and the round is still available (row 22 charges it on the way out).
 *  - `binding` is rows 2 → 10 → 13, and `resolved_overruled` rows 2 → 10 → 14:
 *    both stand on a returned verdict.
 *  - `resolved_withdrawn` is rows 2 → 9, `resolved_fixed` row 1, and
 *    `escalated_human` row 4 — the last two straight out of an untouched `open`.
 *
 * A fixture that wants an UNREACHABLE record overrides these explicitly, which
 * is what the reachability table below does.
 */
const REACHABLE_HISTORY = {
  open: { rebuttedVersions: [], counters: {} },
  disputed: { rebuttedVersions: [1], counters: { rebuttals: 1 } },
  arbitration_pending: { rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 1 } },
  evidence_requested: {
    rebuttedVersions: [1],
    counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
  },
  binding: { rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 } },
  resolved_withdrawn: { rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 1 } },
  resolved_overruled: {
    rebuttedVersions: [1],
    counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
  },
  resolved_fixed: { rebuttedVersions: [], counters: {} },
  escalated_human: { rebuttedVersions: [], counters: {} },
};

function lineage(id, state, overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  const history = REACHABLE_HISTORY[state] ?? { rebuttedVersions: [], counters: {} };
  return {
    lineageId: id,
    state,
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, ...history.counters, ...counterOverrides },
    rebuttedVersions: [...history.rebuttedVersions],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
    // §11: a terminal lineage always carries its outcome literal.
    ...(isTerminal(state) ? { outcome: state } : {}),
    ...rest,
  };
}

function isTerminal(state) {
  return (
    state === 'resolved_fixed'
    || state === 'resolved_withdrawn'
    || state === 'resolved_overruled'
    || state === 'escalated_human'
  );
}

function block(lineages, overrides = {}) {
  const map = {};
  for (const entry of lineages) map[entry.lineageId] = entry;
  return { version: 1, reviewStructure: 'structured', lineages: map, ...overrides };
}

function select(persisted, overrides = {}) {
  return selectPendingDisputeTurn({ enabled: true, persisted, ...overrides });
}

/** Every kind that names a run someone must take — the ones a refusal must never leak. */
const PROTOCOL_TURN_KINDS = [
  'implementer_fix',
  'reviewer_reconsideration',
  'evidence_collection',
  'runner_arbitration',
  're_review',
];

describe('selectPendingDisputeTurn: single lineage (§7.1)', () => {
  const cases = [
    { state: 'open', kind: 'implementer_fix', rule: 2 },
    { state: 'binding', kind: 'implementer_fix', rule: 2 },
    { state: 'disputed', kind: 'reviewer_reconsideration', rule: 2 },
    { state: 'evidence_requested', kind: 'evidence_collection', rule: 2 },
    { state: 'arbitration_pending', kind: 'runner_arbitration', rule: 2 },
  ];

  test.each(cases)('a single $state lineage selects $kind', ({ state, kind, rule }) => {
    const turn = select(block([lineage(LINEAGE_A, state)]));

    expect(turn.kind).toBe(kind);
    expect(turn.rule).toBe(rule);
    expect(turn.lineageIds).toEqual([LINEAGE_A]);
  });

  test('rule 1: an escalated lineage hands the task to a human, not to a turn', () => {
    const turn = select(block([lineage(LINEAGE_A, 'escalated_human')]));

    expect(turn.kind).toBe('human_handoff');
    expect(turn.rule).toBe(1);
    expect(turn.reasons).toEqual(['lineage_escalated_human']);
    expect(turn.escalatedLineageIds).toEqual([LINEAGE_A]);
    expect(turn.reopenRequestedLineageIds).toEqual([]);
  });

  test('rule 1: §6.4 reopen on a resolved lineage escalates without changing its state', () => {
    const turn = select(block([lineage(LINEAGE_A, 'resolved_fixed', { reopenRequested: true })]));

    expect(turn.kind).toBe('human_handoff');
    expect(turn.reasons).toEqual(['reopen_requested']);
    expect(turn.reopenRequestedLineageIds).toEqual([LINEAGE_A]);
  });

  test('rule 3: a terminal lineage set with a deferred diff returns to ordinary review', () => {
    const turn = select(block([lineage(LINEAGE_A, 'resolved_fixed')], { pendingReReview: true }));

    expect(turn.kind).toBe('re_review');
    expect(turn.rule).toBe(3);
    expect(turn.deferred).toBe(true);
  });

  test('rule 4, structured: every lineage terminal with no diff needs no turn', () => {
    const turn = select(block([lineage(LINEAGE_A, 'resolved_withdrawn')]));

    expect(turn.kind).toBe('no_turn');
    expect(turn.rule).toBe(4);
    expect(turn.reason).toBe('resolved_without_changes');
  });

  test('rule 4, mixed (§13): the same states keep the prose blocking force', () => {
    const turn = select(block([lineage(LINEAGE_A, 'resolved_overruled')], { reviewStructure: 'mixed' }));

    expect(turn.kind).toBe('no_turn');
    expect(turn.rule).toBe(4);
    expect(turn.reason).toBe('no_change_run_invalid');
  });

  test('§13: a block with no lineage is the legacy path, never a turn', () => {
    const turn = select(block([], { reviewStructure: 'legacy' }));

    expect(turn.kind).toBe('no_turn');
    expect(turn.rule).toBeNull();
    expect(turn.reason).toBe('legacy_review');
  });

  test('the evidence turn is dual-party and covers every requesting lineage', () => {
    const turn = select(
      block([lineage(LINEAGE_A, 'evidence_requested'), lineage(LINEAGE_B, 'evidence_requested')]),
    );

    expect(turn.kind).toBe('evidence_collection');
    expect(turn.parties).toEqual(['implementer', 'reviewer']);
    expect(turn.parties).toHaveLength(2);
    expect(EVIDENCE_COLLECTION_PARTIES).toEqual(['implementer', 'reviewer']);
    // Both runs cover ALL of them: one bounded run per party, not per lineage.
    expect(turn.lineageIds).toEqual([LINEAGE_A, LINEAGE_B]);
  });
});

describe('selectPendingDisputeTurn: mixed lineages keep §7.1 precedence', () => {
  // Each row states the lineage states that coexist, the turn that must win, and
  // the lineages that turn carries. Every id NOT in `carries` is asserted absent
  // from `lineageIds`: a shadowed lineage waits, unchanged, for its own turn, and
  // dragging it along would hand it to the wrong party.
  const cases = [
    {
      name: 'open shadows disputed, evidence_requested and arbitration_pending',
      states: { [LINEAGE_A]: 'open', [LINEAGE_B]: 'disputed', [LINEAGE_C]: 'evidence_requested', [LINEAGE_D]: 'arbitration_pending' },
      kind: 'implementer_fix',
      carries: [LINEAGE_A],
    },
    {
      name: 'binding is an implementer turn exactly like open',
      states: { [LINEAGE_A]: 'binding', [LINEAGE_B]: 'disputed', [LINEAGE_C]: 'arbitration_pending' },
      kind: 'implementer_fix',
      carries: [LINEAGE_A],
    },
    {
      name: 'open and binding are carried together by the one implementer turn',
      states: { [LINEAGE_A]: 'open', [LINEAGE_B]: 'binding', [LINEAGE_C]: 'disputed' },
      kind: 'implementer_fix',
      carries: [LINEAGE_A, LINEAGE_B],
    },
    {
      name: 'disputed shadows evidence_requested and arbitration_pending',
      states: { [LINEAGE_A]: 'disputed', [LINEAGE_B]: 'evidence_requested', [LINEAGE_C]: 'arbitration_pending' },
      kind: 'reviewer_reconsideration',
      carries: [LINEAGE_A],
    },
    {
      name: 'evidence_requested shadows arbitration_pending',
      states: { [LINEAGE_A]: 'evidence_requested', [LINEAGE_B]: 'arbitration_pending' },
      kind: 'evidence_collection',
      carries: [LINEAGE_A],
    },
    {
      name: 'arbitration_pending is the last branch, alongside terminal lineages',
      states: { [LINEAGE_A]: 'arbitration_pending', [LINEAGE_B]: 'resolved_fixed' },
      kind: 'runner_arbitration',
      carries: [LINEAGE_A],
    },
    {
      name: 'a terminal lineage never joins the turn it coexists with',
      states: { [LINEAGE_A]: 'disputed', [LINEAGE_B]: 'resolved_withdrawn' },
      kind: 'reviewer_reconsideration',
      carries: [LINEAGE_A],
    },
  ];

  test.each(cases)('$name', ({ states, kind, carries }) => {
    const entries = Object.entries(states).map(([id, state]) => lineage(id, state));
    const turn = select(block(entries));

    expect(turn.kind).toBe(kind);
    expect(turn.rule).toBe(2);
    expect(turn.lineageIds).toEqual(carries);
    for (const id of Object.keys(states)) {
      if (!carries.includes(id)) expect(turn.lineageIds).not.toContain(id);
    }
  });

  test('the selected turn is stable under lineage insertion order', () => {
    const a = lineage(LINEAGE_A, 'disputed');
    const b = lineage(LINEAGE_B, 'disputed');

    expect(select(block([a, b]))).toEqual(select(block([b, a])));
  });

  test('rule 1 shadows every rule-2 turn, however many lineages are live', () => {
    const turn = select(
      block([
        lineage(LINEAGE_A, 'open'),
        lineage(LINEAGE_B, 'disputed'),
        lineage(LINEAGE_C, 'escalated_human'),
      ]),
    );

    expect(turn.kind).toBe('human_handoff');
    expect(turn.rule).toBe(1);
    expect(turn.escalatedLineageIds).toEqual([LINEAGE_C]);
  });

  test('rule 1 reports both triggers when an escalation and a reopen coexist', () => {
    const turn = select(
      block([
        lineage(LINEAGE_A, 'escalated_human'),
        lineage(LINEAGE_B, 'resolved_fixed', { reopenRequested: true }),
      ]),
    );

    expect(turn.kind).toBe('human_handoff');
    expect(turn.reasons).toEqual(['lineage_escalated_human', 'reopen_requested']);
    expect(turn.escalatedLineageIds).toEqual([LINEAGE_A]);
    expect(turn.reopenRequestedLineageIds).toEqual([LINEAGE_B]);
  });

  test('rule 2 shadows rule 3: a deferred diff waits for the live lineages', () => {
    const turn = select(
      block([lineage(LINEAGE_A, 'disputed'), lineage(LINEAGE_B, 'resolved_fixed')], { pendingReReview: true }),
    );

    expect(turn.kind).toBe('reviewer_reconsideration');
    expect(turn.lineageIds).toEqual([LINEAGE_A]);
  });
});

describe('selectPendingDisputeTurn: fail-closed (§12)', () => {
  test('a disabled session never selects a protocol turn, whatever the block says', () => {
    const disputed = block([lineage(LINEAGE_A, 'disputed')]);
    const turn = selectPendingDisputeTurn({ enabled: false, persisted: disputed });

    expect(turn.kind).toBe('no_turn');
    expect(turn.reason).toBe('protocol_disabled');
    expect(PROTOCOL_TURN_KINDS).not.toContain(turn.kind);
  });

  test('a disabled session is not even parsed: a malformed block is still no_turn', () => {
    const turn = selectPendingDisputeTurn({ enabled: false, persisted: { version: 9 } });

    expect(turn).toEqual({ kind: 'no_turn', rule: null, reason: 'protocol_disabled' });
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
  ])('an absent block (%s) is the legacy answer, not a refusal', (_name, persisted) => {
    const turn = select(persisted);

    expect(turn.kind).toBe('no_turn');
    expect(turn.reason).toBe('no_dispute_state');
  });

  const malformed = [
    { name: 'a non-object block', persisted: 'reviewDispute', reason: 'not-an-object' },
    { name: 'an unsupported schema version', persisted: block([], { version: 2 }), reason: 'invalid-state-record' },
    {
      name: 'an unknown top-level field',
      persisted: { ...block([]), disputeMode: 'fast' },
      reason: 'unknown-field',
    },
    {
      name: 'an unknown lineage state token',
      persisted: block([lineage(LINEAGE_A, 'under_review')]),
      reason: 'unknown-enum',
    },
    {
      name: 'a lineage key that is not a runner-minted id',
      persisted: { version: 1, reviewStructure: 'structured', lineages: { boom: lineage(LINEAGE_A, 'open') } },
      reason: 'invalid-state-record',
    },
    {
      name: 'a terminal lineage with no outcome literal',
      persisted: block([{ ...lineage(LINEAGE_A, 'resolved_fixed'), outcome: undefined }]),
      reason: 'missing-field',
    },
  ];

  test.each(malformed)('$name refuses rather than routing', ({ persisted, reason }) => {
    const turn = select(persisted);

    expect(turn.kind).toBe('unresolvable');
    expect(turn.rule).toBeNull();
    expect(turn.failure.reason).toBe(reason);
    expect(PROTOCOL_TURN_KINDS).not.toContain(turn.kind);
  });

  test('a counter above the session §6.1 limit refuses under the lowered limit only', () => {
    const persisted = block([lineage(LINEAGE_A, 'arbitration_pending', { counters: { arbitrationPasses: 2 } })]);

    expect(select(persisted).kind).toBe('runner_arbitration');

    const lowered = select(persisted, {
      limits: { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxArbitrationPassesPerLineage: 1 },
    });
    expect(lowered.kind).toBe('unresolvable');
    expect(lowered.failure.reason).toBe('invalid-type');
  });

  const contradictory = [
    {
      name: '§13 legacy structure carrying live lineages',
      persisted: block([lineage(LINEAGE_A, 'disputed')], { reviewStructure: 'legacy' }),
    },
    {
      name: 'resolvedWithoutChanges with a live lineage',
      persisted: block([lineage(LINEAGE_A, 'open')], { resolvedWithoutChanges: true }),
    },
    {
      name: 'resolvedWithoutChanges with an escalated lineage',
      persisted: block([lineage(LINEAGE_A, 'escalated_human')], { resolvedWithoutChanges: true }),
    },
    {
      name: 'resolvedWithoutChanges with a reopen-flagged lineage',
      persisted: block([lineage(LINEAGE_A, 'resolved_fixed', { reopenRequested: true })], {
        resolvedWithoutChanges: true,
      }),
    },
    {
      name: 'resolvedWithoutChanges with no lineage at all',
      persisted: block([], { resolvedWithoutChanges: true }),
    },
    {
      // §7.1 rule 4 is `resolved_withdrawn`/`resolved_overruled` only: a
      // `resolved_fixed` lineage implies a diff (§3.4), and a zero-change claim
      // says there is none. Accepting it would report a task whose diff may
      // never have been reviewed as resolved and send it to a human.
      name: 'resolvedWithoutChanges with a resolved_fixed lineage',
      persisted: block([lineage(LINEAGE_A, 'resolved_fixed')], { resolvedWithoutChanges: true }),
    },
    {
      name: 'resolvedWithoutChanges with a resolved_fixed lineage beside a withdrawn one',
      persisted: block([lineage(LINEAGE_A, 'resolved_fixed'), lineage(LINEAGE_B, 'resolved_withdrawn')], {
        resolvedWithoutChanges: true,
      }),
    },
  ];

  test.each(contradictory)('$name refuses rather than picking a reading', ({ persisted }) => {
    const turn = select(persisted);

    expect(turn.kind).toBe('unresolvable');
    expect(turn.failure.reason).toBe('invalid-state-record');
    expect(turn.failure.detail).toEqual(expect.stringContaining('reviewDispute.'));
  });

  test('the resolved_fixed refusal keys on the zero-change CLAIM, not on the state alone', () => {
    // Without the flag, a terminal `resolved_fixed` set whose diff rule 3 already
    // routed to review is an ordinary state — routing to review is what cleared
    // `pendingReReview` — so it must keep selecting no turn.
    const unflagged = select(block([lineage(LINEAGE_A, 'resolved_fixed')]));
    expect(unflagged.kind).toBe('no_turn');
    expect(unflagged.reason).toBe('resolved_without_changes');

    // With the flag, the same lineage set asserts a diff and no diff at once.
    const flagged = select(block([lineage(LINEAGE_A, 'resolved_fixed')], { resolvedWithoutChanges: true }));
    expect(flagged.kind).toBe('unresolvable');
    expect(flagged.failure.detail).toContain('resolved-fixed');

    // And the deferred-diff reading is never silently taken: a fixed lineage that
    // still owes its ordinary review routes to review, it does not resolve.
    const deferred = select(block([lineage(LINEAGE_A, 'resolved_fixed')], { pendingReReview: true }));
    expect(deferred.kind).toBe('re_review');
  });

  test('a refusal names no lineage content — only a field locator', () => {
    const turn = select(block([lineage(LINEAGE_A, 'open')], { resolvedWithoutChanges: true }));

    expect(turn.failure.detail).not.toContain(BOUNDARY);
    expect(turn.failure.detail).not.toContain(LINEAGE_A);
  });
});

describe('selectPendingDisputeTurn: unreachable §7 states refuse (§12)', () => {
  // A record can pass every schema check and still describe a debate no sequence
  // of §7 rows could have produced. Each row names the state, the corruption, and
  // the locator the refusal must carry — the locator is asserted because a
  // refusal that fires for the wrong reason would pass a `kind` check while
  // proving nothing about the rule it is meant to pin.
  const unreachable = [
    {
      name: 'open whose current version is already rebutted (the rebuttal leaves open)',
      entry: { state: 'open', overrides: { rebuttedVersions: [1], counters: { rebuttals: 1 } } },
      detail: '.state:open-with-rebutted-version',
    },
    {
      name: 'open carrying an arbitration pass (nothing returns from arbitration to open)',
      entry: {
        state: 'open',
        overrides: {
          version: 2,
          rebuttedVersions: [1],
          counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
        },
      },
      detail: '.state:open-after-arbitration',
    },
    {
      name: 'open at version 2 with no reconsideration behind the successor',
      entry: {
        state: 'open',
        overrides: { version: 2, rebuttedVersions: [1], counters: { rebuttals: 1 } },
      },
      detail: '.counters.reconsiderations:0-below-version-2',
    },
    {
      name: 'a version 2 whose version 1 was never rebutted',
      entry: {
        state: 'open',
        overrides: { version: 2, rebuttedVersions: [2], counters: { rebuttals: 1, reconsiderations: 1 } },
      },
      detail: '.version:2-over-unrebutted-1',
    },
    {
      name: 'disputed with its reconsideration round already spent (rows 9-12 leave disputed)',
      entry: { state: 'disputed', overrides: { counters: { reconsiderations: 1 } } },
      detail: '.state:disputed-with-1-reconsiderations',
    },
    {
      name: 'disputed after an arbitration pass (arbitration never returns to disputed)',
      entry: { state: 'disputed', overrides: { counters: { arbitrationPasses: 1 } } },
      detail: '.state:disputed-after-arbitration',
    },
    {
      name: 'arbitration_pending with no admitted dispute',
      entry: {
        state: 'arbitration_pending',
        overrides: { rebuttedVersions: [], counters: { rebuttals: 0, reconsiderations: 1 } },
      },
      // The rebuttal-less debate spend is the earlier, more basic corruption.
      detail: '.counters:spent-without-rebuttal',
    },
    {
      name: 'evidence_requested with no arbitration pass (row 16 needs a returned verdict)',
      entry: { state: 'evidence_requested', overrides: { counters: { arbitrationPasses: 0 } } },
      detail: '.state:evidence_requested-without-arbitration-pass',
    },
    {
      name: 'evidence_requested whose round is already charged (row 22 charges it on exit)',
      entry: { state: 'evidence_requested', overrides: { counters: { evidenceRoundsUsed: 1 } } },
      detail: '.state:evidence_requested-without-available-round',
    },
    {
      name: 'binding with no arbitration pass behind it (row 13 only)',
      entry: { state: 'binding', overrides: { counters: { arbitrationPasses: 0 } } },
      detail: '.state:binding-without-arbitration-pass',
    },
    {
      name: 'resolved_withdrawn with no reconsideration behind it (row 9 only)',
      entry: { state: 'resolved_withdrawn', overrides: { counters: { reconsiderations: 0 } } },
      detail: '.state:resolved_withdrawn-without-reconsideration',
    },
    {
      name: 'resolved_overruled with no arbitration pass behind it (row 14 only)',
      entry: { state: 'resolved_overruled', overrides: { counters: { arbitrationPasses: 0 } } },
      detail: '.state:resolved_overruled-without-arbitration-pass',
    },
    {
      name: 'resolved_fixed at a rebutted version with no arbitration behind it (row 23 only)',
      entry: { state: 'resolved_fixed', overrides: { rebuttedVersions: [1], counters: { rebuttals: 1 } } },
      detail: '.state:resolved_fixed-without-arbitration-pass',
    },
    {
      name: 'a debate counter spent with no rebuttal to open the debate',
      entry: { state: 'escalated_human', overrides: { counters: { arbitrationPasses: 1 } } },
      detail: '.counters:spent-without-rebuttal',
    },
    {
      name: 'an evidence round charged with no arbitration pass',
      entry: {
        state: 'arbitration_pending',
        overrides: { counters: { evidenceRoundsUsed: 1 } },
      },
      detail: '.counters.evidenceRoundsUsed:without-arbitration-pass',
    },
  ];

  test.each(unreachable)('$name refuses rather than dispatching a turn', ({ entry, detail }) => {
    const turn = select(block([lineage(LINEAGE_A, entry.state, entry.overrides)]));

    expect(turn.kind).toBe('unresolvable');
    expect(turn.rule).toBeNull();
    expect(turn.failure.reason).toBe('invalid-state-record');
    expect(turn.failure.detail).toBe(`reviewDispute.lineages[${LINEAGE_A}]${detail}`);
    expect(PROTOCOL_TURN_KINDS).not.toContain(turn.kind);
  });

  test('a state only a debate reaches refuses when the lineage was never disputed', () => {
    // Every one of these states sits downstream of an admitted `review_disputed`
    // against the version it names, so an untouched record in any of them is a
    // finding whose debate the block does not record.
    const debateStates = [
      'disputed',
      'arbitration_pending',
      'evidence_requested',
      'binding',
      'resolved_withdrawn',
      'resolved_overruled',
    ];
    for (const state of debateStates) {
      const untouched = lineage(LINEAGE_A, state, {
        rebuttedVersions: [],
        counters: { ...ZERO_LINEAGE_COUNTERS },
      });
      const turn = select(block([untouched]));

      expect(turn.kind).toBe('unresolvable');
      expect(turn.failure.detail).toBe(`reviewDispute.lineages[${LINEAGE_A}].state:${state}-without-rebuttal`);
    }
  });

  test('one corrupted lineage refuses the whole block, not just its own turn', () => {
    // The reachable `disputed` lineage would otherwise select a reconsideration
    // run: an agent turn taken while the task's persisted state is corrupted.
    const turn = select(
      block([
        lineage(LINEAGE_A, 'open', { rebuttedVersions: [1], counters: { rebuttals: 1 } }),
        lineage(LINEAGE_B, 'disputed'),
      ]),
    );

    expect(turn.kind).toBe('unresolvable');
    expect(turn.failure.detail).toContain('open-with-rebutted-version');
  });

  test('a corrupted lineage shadows even the rule 1 human handoff', () => {
    const turn = select(
      block([
        lineage(LINEAGE_A, 'binding', { counters: { arbitrationPasses: 0 } }),
        lineage(LINEAGE_B, 'escalated_human'),
      ]),
    );

    expect(turn.kind).toBe('unresolvable');
    expect(turn.failure.detail).toContain('binding-without-arbitration-pass');
  });

  test('the refusal is stable under lineage insertion order', () => {
    const a = lineage(LINEAGE_A, 'disputed', { rebuttedVersions: [], counters: { rebuttals: 0 } });
    const b = lineage(LINEAGE_B, 'binding', { counters: { arbitrationPasses: 0 } });

    expect(select(block([a, b]))).toEqual(select(block([b, a])));
    expect(select(block([b, a])).failure.detail).toContain(LINEAGE_A);
  });

  test('the reachable histories of the same states still select their turns', () => {
    // The complement of the table above: the check refuses corrupted records
    // only, so every state reached by an ordinary row sequence still routes.
    const routed = [
      ['open', 'implementer_fix'],
      ['binding', 'implementer_fix'],
      ['disputed', 'reviewer_reconsideration'],
      ['evidence_requested', 'evidence_collection'],
      ['arbitration_pending', 'runner_arbitration'],
    ];
    for (const [state, kind] of routed) {
      expect(select(block([lineage(LINEAGE_A, state)])).kind).toBe(kind);
    }

    // The longer histories too: a version-2 final response (rows 2 → 11), a
    // version-2 dispute in arbitration (row 6), and an arbitration re-entered
    // after the evidence round (rows 16 → 22).
    const finalResponse = lineage(LINEAGE_A, 'open', {
      version: 2,
      rebuttedVersions: [1],
      counters: { rebuttals: 1, reconsiderations: 1 },
    });
    expect(select(block([finalResponse])).kind).toBe('implementer_fix');

    const secondVersionDispute = lineage(LINEAGE_A, 'arbitration_pending', {
      version: 2,
      rebuttedVersions: [1, 2],
      counters: { rebuttals: 2, reconsiderations: 1 },
    });
    expect(select(block([secondVersionDispute])).kind).toBe('runner_arbitration');

    const afterEvidence = lineage(LINEAGE_A, 'arbitration_pending', {
      counters: { arbitrationPasses: 1, evidenceRoundsUsed: 1 },
    });
    expect(select(block([afterEvidence])).kind).toBe('runner_arbitration');
  });

  test('evidence_requested is unreachable when the session allows no evidence round', () => {
    // §6.1: with the round budget at 0 the state has no entry row at all, so the
    // same record that routes under the default limits refuses under the lowered
    // one rather than dispatching a collection run the session disabled.
    const persisted = block([lineage(LINEAGE_A, 'evidence_requested')]);

    expect(select(persisted).kind).toBe('evidence_collection');

    const lowered = select(persisted, {
      limits: { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxEvidenceRoundsPerLineage: 0 },
    });
    expect(lowered.kind).toBe('unresolvable');
    expect(lowered.failure.detail).toContain('evidence_requested-without-available-round');
  });
});

describe('selectPendingDisputeTurn: the result is closed', () => {
  test('every declared turn kind is reachable, and nothing else is produced', () => {
    const observed = new Set(
      [
        select(block([lineage(LINEAGE_A, 'open')])),
        select(block([lineage(LINEAGE_A, 'disputed')])),
        select(block([lineage(LINEAGE_A, 'evidence_requested')])),
        select(block([lineage(LINEAGE_A, 'arbitration_pending')])),
        select(block([lineage(LINEAGE_A, 'resolved_fixed')], { pendingReReview: true })),
        select(block([lineage(LINEAGE_A, 'escalated_human')])),
        select(block([lineage(LINEAGE_A, 'resolved_withdrawn')])),
        select('nonsense'),
      ].map((turn) => turn.kind),
    );

    expect([...observed].sort()).toEqual([...DISPUTE_TURN_KINDS].sort());
  });

  test('no live lineage state ever selects the ordinary-review or no-turn answers', () => {
    for (const state of ['open', 'binding', 'disputed', 'evidence_requested', 'arbitration_pending']) {
      const turn = select(block([lineage(LINEAGE_A, state)]));

      expect(turn.kind).not.toBe('re_review');
      expect(turn.kind).not.toBe('no_turn');
      expect(turn.rule).toBe(2);
    }
  });

  test('the selector agrees with the §7.1 aggregation it is derived from', () => {
    // Precedence has exactly one implementation (#840's aggregation); this pins
    // the correspondence so a future re-derivation here cannot drift from the
    // routing the transition layer commits for the same lineage set.
    const expectedKind = {
      implementer: 'implementer_fix',
      reviewer: 'reviewer_reconsideration',
      evidence: 'evidence_collection',
      runner: 'runner_arbitration',
      re_review: 're_review',
    };
    const contexts = [
      block([lineage(LINEAGE_A, 'open'), lineage(LINEAGE_B, 'disputed')]),
      block([lineage(LINEAGE_A, 'disputed'), lineage(LINEAGE_B, 'evidence_requested')]),
      block([lineage(LINEAGE_A, 'evidence_requested'), lineage(LINEAGE_B, 'arbitration_pending')]),
      block([lineage(LINEAGE_A, 'arbitration_pending')]),
      block([lineage(LINEAGE_A, 'resolved_fixed')], { pendingReReview: true }),
    ];

    for (const ctx of contexts) {
      const routing = aggregateDisputeRouting(ctx);
      const turn = select(ctx);

      expect(turn.kind).toBe(expectedKind[routing.turn]);
      expect(turn.rule).toBe(routing.rule);
      if (turn.kind !== 're_review') expect(turn.lineageIds).toEqual(routing.actionableLineageIds);
    }
  });

  test('disputeTurnAwaitsDispatcher names exactly the three §7.1 sub-turns', () => {
    // "Needs a sub-turn implementation", not "has none": the reviewer's turn was
    // implemented in issue #952 and the runner's in #955, and both still answer
    // true here — the predicate is what `disputeSubTurnIdentity` guards on.
    const dispatcherless = [
      select(block([lineage(LINEAGE_A, 'disputed')])),
      select(block([lineage(LINEAGE_A, 'evidence_requested')])),
      select(block([lineage(LINEAGE_A, 'arbitration_pending')])),
    ];
    for (const turn of dispatcherless) expect(disputeTurnAwaitsDispatcher(turn)).toBe(true);

    const dispatchable = [
      select(block([lineage(LINEAGE_A, 'open')])),
      select(block([lineage(LINEAGE_A, 'resolved_fixed')], { pendingReReview: true })),
      select(block([lineage(LINEAGE_A, 'escalated_human')])),
      select(block([lineage(LINEAGE_A, 'resolved_withdrawn')])),
      select('nonsense'),
    ];
    for (const turn of dispatchable) expect(disputeTurnAwaitsDispatcher(turn)).toBe(false);
  });
});
