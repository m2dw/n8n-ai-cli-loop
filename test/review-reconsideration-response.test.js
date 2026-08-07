/**
 * Unit tests for the issue #838 reviewer-reconsideration response parser
 * (src/core/review-reconsideration-response.ts).
 *
 * The module answers one question — may this reviewer output be admitted as THE
 * reconsideration of THIS pending dispute? — so every test below is a value in,
 * a value out. The three admissible outcomes are covered, and so is every way
 * §12 says an answer must fail closed: a malformed envelope, two answers, an
 * answer for another lineage, an answer for a version the lineage has moved
 * past, a lineage that was never awaiting a reviewer turn, a spent §6.1 budget,
 * and a `revise` whose successor cannot stand on its own.
 */
import {
  extractReconsiderationRecord,
  parseReconsiderationResponse,
} from '../dist/core/review-reconsideration-response.js';
import {
  MAX_RATIONALE_CHARS,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
} from '../dist/core/review-dispute.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const OTHER_LINEAGE = 'ln-bbbbbbbbbbbb';
const RATIONALE = 'The cited middleware guard runs before the handler, so the failure scenario cannot occur.';

function lineage(overrides = {}) {
  return {
    lineageId: LINEAGE,
    state: 'disputed',
    version: 1,
    counters: { rebuttals: 1, reconsiderations: 0, arbitrationPasses: 0, malformedArbiterAttempts: 0, evidenceRoundsUsed: 0 },
    rebuttedVersions: [1],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: 'src/auth/handler.ts',
    ...overrides,
  };
}

function successor(overrides = {}) {
  return {
    lineageId: LINEAGE,
    version: 2,
    severity: 'P1',
    violatedContract: 'The handler must reject a null session before dereferencing it.',
    preconditions: 'A request reaches the handler without passing the middleware.',
    failureScenario: 'The direct-dispatch path skips the middleware and dereferences a null session.',
    affectedBoundary: 'src/auth/handler.ts',
    requiredOutcome: 'The handler rejects a null session on every entry path.',
    evidenceRefs: [{ kind: 'file', path: 'src/auth/dispatch.ts', startLine: 12, endLine: 20 }],
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    lineageId: LINEAGE,
    version: 1,
    reconsideration: 'uphold',
    rationale: RATIONALE,
    ...overrides,
  };
}

function fenced(value) {
  return `Here is my reconsideration.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function parse(responseOrRecord, overrides = {}) {
  const response = typeof responseOrRecord === 'string' ? responseOrRecord : fenced(responseOrRecord);
  return parseReconsiderationResponse({
    response,
    pending: { lineageId: LINEAGE, version: 1 },
    lineages: { [LINEAGE]: lineage() },
    resolveEvidenceRef: () => true,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    ...overrides,
  });
}

describe('extractReconsiderationRecord', () => {
  test('extracts the single fenced json object', () => {
    const extraction = extractReconsiderationRecord(fenced(record()));
    expect(extraction.ok).toBe(true);
    expect(extraction.record.lineageId).toBe(LINEAGE);
  });

  test('prose with no fenced block is unparseable', () => {
    const extraction = extractReconsiderationRecord('I still believe the finding is correct.');
    expect(extraction).toEqual({
      ok: false,
      failure: { reason: 'unparseable', detail: 'response:no-reconsideration-block' },
    });
  });

  test('two objects are too-many-items, never "the last one wins"', () => {
    const extraction = extractReconsiderationRecord(
      `${fenced(record())}\n${fenced(record({ reconsideration: 'withdraw' }))}`,
    );
    expect(extraction.ok).toBe(false);
    expect(extraction.failure.reason).toBe('too-many-items');
  });

  test('an unreadable fence fails the whole envelope even beside a clean one', () => {
    const extraction = extractReconsiderationRecord(
      '```json\n{ not json\n```\n' + fenced(record()),
    );
    expect(extraction.ok).toBe(false);
    expect(extraction.failure.reason).toBe('unparseable');
    expect(extraction.failure.detail).toContain('invalid-json');
  });

  test('a fenced block past the #836 byte bound is payload-too-large', () => {
    const huge = `\`\`\`json\n{"pad":"${'p'.repeat(REVIEW_DISPUTE_RECORD_MAX_BYTES + 10)}"}\n\`\`\``;
    const extraction = extractReconsiderationRecord(huge);
    expect(extraction).toEqual({
      ok: false,
      failure: { reason: 'payload-too-large', detail: 'reconsideration-block' },
    });
  });

  // Issue #838 review, P2: a reviewer reasoning about Markdown will quote a
  // fence. A closing delimiter that accepted any triple backtick would cut the
  // record off inside `rationale` and reject a valid answer as invalid JSON.
  test('a rationale that quotes a code fence does not end the block', () => {
    const rationale = 'The rebuttal quotes ``` inside its argument, which does not change the finding.';
    const extraction = extractReconsiderationRecord(fenced(record({ rationale })));
    expect(extraction.ok).toBe(true);
    expect(extraction.record.rationale).toBe(rationale);
    expect(parse(record({ rationale })).admitted.record.rationale).toBe(rationale);
  });

  // The same, one level meaner: the quoted fence sits at the very start of the
  // JSON string, so only the opening quote separates it from the line start.
  test('a rationale beginning with a code fence does not end the block', () => {
    const rationale = '```json is what the reviewer asked for, and the rebuttal supplied prose instead.';
    const extraction = extractReconsiderationRecord(fenced(record({ rationale })));
    expect(extraction.ok).toBe(true);
    expect(extraction.record.rationale).toBe(rationale);
  });

  // The closing anchor must not become a way to smuggle a second answer past
  // the one-record rule: a quoted fence is not a delimiter in EITHER direction.
  test('a quoted fence does not split one answer into two', () => {
    const extraction = extractReconsiderationRecord(
      fenced(record({ rationale: 'Fences ``` and ``` both appear in the disputed excerpt.' })),
    );
    expect(extraction.ok).toBe(true);
    expect(extraction.record.reconsideration).toBe('uphold');
  });

  test('a readable non-object block is ignored, not fatal', () => {
    const extraction = extractReconsiderationRecord(
      '```json\n[1, 2, 3]\n```\n' + fenced(record()),
    );
    expect(extraction.ok).toBe(true);
    expect(extraction.record.reconsideration).toBe('uphold');
  });
});

describe('the three admissible outcomes', () => {
  test('uphold', () => {
    const outcome = parse(record({ reconsideration: 'uphold' }));
    expect(outcome.failure).toBeNull();
    expect(outcome.admitted.record.reconsideration).toBe('uphold');
    expect(outcome.summary.reconsideration).toBe('uphold');
    expect(outcome.summary.revisionKind).toBeNull();
  });

  test('withdraw', () => {
    const outcome = parse(record({ reconsideration: 'withdraw' }));
    expect(outcome.failure).toBeNull();
    expect(outcome.admitted.record.reconsideration).toBe('withdraw');
    expect(outcome.admitted.lineage.lineageId).toBe(LINEAGE);
  });

  test('revise carries predecessor, changed fields, kind, and the complete successor', () => {
    const outcome = parse(
      record({
        reconsideration: 'revise',
        revision: {
          predecessorVersion: 1,
          changedFields: ['failureScenario', 'evidenceRefs'],
          revisionKind: 'narrowed_scope',
          materialityClaim: true,
          successor: successor(),
        },
      }),
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.admitted.record.revision.successor.version).toBe(2);
    expect(outcome.summary).toMatchObject({
      reconsideration: 'revise',
      revisionKind: 'narrowed_scope',
      materialityClaim: true,
      changedFields: ['failureScenario', 'evidenceRefs'],
      successorVersion: 2,
    });
  });
});

describe('the summary carries literals only', () => {
  test('rationale travels as a length, never as prose', () => {
    const outcome = parse(record());
    expect(outcome.summary.rationaleChars).toBe(RATIONALE.length);
    expect(JSON.stringify(outcome.summary)).not.toContain(RATIONALE);
  });

  test('a failure summary carries the reason and a content-free locator', () => {
    const outcome = parse('no block here at all');
    expect(outcome.admitted).toBeNull();
    expect(outcome.summary.failure).toEqual({
      reason: 'unparseable',
      detail: 'response:no-reconsideration-block',
    });
    expect(outcome.summary.reconsideration).toBeNull();
  });
});

describe('fail closed', () => {
  test('a record for another lineage is not admitted against the pending one', () => {
    const outcome = parse(record({ lineageId: OTHER_LINEAGE }), {
      lineages: { [LINEAGE]: lineage(), [OTHER_LINEAGE]: lineage({ lineageId: OTHER_LINEAGE }) },
    });
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure).toEqual({ reason: 'unknown-lineage', detail: 'reconsideration.lineageId:not-pending' });
  });

  test('a stale version is rejected rather than applied to the current one', () => {
    const outcome = parse(record({ version: 2 }));
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('stale-version');
  });

  test('a version the lineage has moved past is rejected by the #836 admission too', () => {
    const outcome = parseReconsiderationResponse({
      response: fenced(record({ version: 2 })),
      pending: { lineageId: LINEAGE, version: 2 },
      lineages: { [LINEAGE]: lineage({ version: 1 }) },
      resolveEvidenceRef: () => true,
    });
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('stale-version');
  });

  test('a lineage this task does not carry is unknown', () => {
    const outcome = parse(record(), { lineages: {} });
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('unknown-lineage');
  });

  test.each(['open', 'binding', 'arbitration_pending', 'escalated_human', 'resolved_fixed'])(
    'a lineage in state %s is not awaiting a reviewer turn',
    (state) => {
      const outcome = parse(record(), { lineages: { [LINEAGE]: lineage({ state }) } });
      expect(outcome.admitted).toBeNull();
      expect(outcome.failure.reason).toBe('not-actionable-state');
      expect(outcome.failure.detail).toContain(state);
    },
  );

  test('a spent §6.1 reconsideration budget admits nothing', () => {
    const outcome = parse(record(), {
      lineages: { [LINEAGE]: lineage({ counters: { ...lineage().counters, reconsiderations: 1 } }) },
    });
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('reconsideration-slot-consumed');
  });

  test('a session that configured the round away admits nothing either', () => {
    const outcome = parse(record(), {
      limits: { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxReconsiderationsPerLineage: 0 },
    });
    expect(outcome.failure.reason).toBe('reconsideration-slot-consumed');
  });

  test('an unknown enum token is malformed', () => {
    const outcome = parse(record({ reconsideration: 'partially_withdraw' }));
    expect(outcome.failure.reason).toBe('unknown-enum');
  });

  test('an extra field — including a smuggled second finding — is malformed', () => {
    const outcome = parse(record({ newFinding: successor() }));
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('unknown-field');
  });

  test('a second block of volunteered findings is never admitted alongside the answer', () => {
    const outcome = parse(
      `${fenced(record())}\n\`\`\`json\n${JSON.stringify([successor()])}\n\`\`\`\n`,
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.admitted.record.reconsideration).toBe('uphold');
    expect(outcome.admitted.record.revision).toBeUndefined();
    expect(JSON.stringify(outcome.summary)).not.toContain('direct-dispatch');
  });

  test('a rationale past the bound is rejected', () => {
    const outcome = parse(record({ rationale: 'r'.repeat(MAX_RATIONALE_CHARS + 1) }));
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('field-too-long');
  });

  test('an empty rationale is not a reconsideration', () => {
    const outcome = parse(record({ rationale: '   ' }));
    expect(outcome.admitted).toBeNull();
  });

  test('a revision with no changed fields is malformed (§4.2)', () => {
    const outcome = parse(
      record({
        reconsideration: 'revise',
        revision: {
          predecessorVersion: 1,
          changedFields: [],
          revisionKind: 'restated',
          materialityClaim: false,
          successor: successor(),
        },
      }),
    );
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure).not.toBeNull();
  });

  // §4.2: the successor sits at exactly `predecessorVersion + 1`. Version 1 is
  // the wrong version that stays INSIDE the absolute version ceiling, so the
  // §4.2 rule is what rejects it rather than the #836 range bound.
  test('a successor at the wrong version is an invalid revision', () => {
    const outcome = parse(
      record({
        reconsideration: 'revise',
        revision: {
          predecessorVersion: 1,
          changedFields: ['failureScenario'],
          revisionKind: 'corrected_premise',
          materialityClaim: true,
          successor: successor({ version: 1 }),
        },
      }),
    );
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('invalid-revision');
  });

  // Past the ceiling the #836 range bound fires first — a different reason, the
  // same fail-closed effect: no version beyond `MAX_VERSIONS_PER_LINEAGE` can
  // enter the protocol through a revision.
  test('a successor past the absolute version ceiling is never admitted', () => {
    const outcome = parse(
      record({
        reconsideration: 'revise',
        revision: {
          predecessorVersion: 1,
          changedFields: ['failureScenario'],
          revisionKind: 'corrected_premise',
          materialityClaim: true,
          successor: successor({ version: 3 }),
        },
      }),
    );
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure).not.toBeNull();
  });

  test('a successor bound to another lineage never enters this one', () => {
    const outcome = parse(
      record({
        reconsideration: 'revise',
        revision: {
          predecessorVersion: 1,
          changedFields: ['failureScenario'],
          revisionKind: 'corrected_premise',
          materialityClaim: true,
          successor: successor({ lineageId: OTHER_LINEAGE }),
        },
      }),
    );
    expect(outcome.failure.reason).toBe('invalid-revision');
  });

  test('a successor citing unresolvable evidence is not admitted', () => {
    const outcome = parse(
      record({
        reconsideration: 'revise',
        revision: {
          predecessorVersion: 1,
          changedFields: ['evidenceRefs'],
          revisionKind: 'new_evidence',
          materialityClaim: true,
          successor: successor(),
        },
      }),
      { resolveEvidenceRef: () => false },
    );
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('unresolvable-evidence');
  });

  test('a `revision` on a non-revise outcome is malformed', () => {
    const outcome = parse(
      record({
        reconsideration: 'uphold',
        revision: {
          predecessorVersion: 1,
          changedFields: ['failureScenario'],
          revisionKind: 'restated',
          materialityClaim: false,
          successor: successor(),
        },
      }),
    );
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('unknown-field');
  });

  test('two answers admit neither', () => {
    const outcome = parse(
      `${fenced(record({ reconsideration: 'withdraw' }))}\n${fenced(record({ reconsideration: 'uphold' }))}`,
    );
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('too-many-items');
  });
});
