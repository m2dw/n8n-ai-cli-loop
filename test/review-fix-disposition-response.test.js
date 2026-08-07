/**
 * Unit tests for the issue #843 fix-mode disposition response parser
 * (src/core/review-fix-disposition-response.ts).
 *
 * The module consumes the exact JSON-array contract issue #837 renders into
 * the fix prompt and answers two questions: which per-finding dispositions are
 * admitted (§3), and may this run legitimately have produced no file changes
 * (§3.4, §13). It is pure — it selects no transition and persists nothing,
 * which is issue #840's job — so every case below is a value in, a value out.
 */
import {
  extractDispositionRecords,
  parseFixDispositionResponse,
} from '../dist/core/review-fix-disposition-response.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS } from '../dist/core/review-dispute.js';

const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';

function lineage(id, overrides = {}) {
  return {
    lineageId: id,
    state: 'open',
    version: 1,
    counters: { rebuttals: 0, reconsiderations: 0, arbitrationPasses: 0, malformedArbiterAttempts: 0, evidenceRoundsUsed: 0 },
    rebuttedVersions: [],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: 'src/auth/handler.ts',
    ...overrides,
  };
}

/** The #837 prompt view of a lineage awaiting a disposition. */
function promptFinding(id, overrides = {}) {
  return {
    lineageId: id,
    version: 1,
    state: 'open',
    severity: 'P1',
    affectedBoundary: 'src/auth/handler.ts',
    allowedDispositions: ['fixed', 'review_disputed', 'blocked'],
    ...overrides,
  };
}

function disputeRecord(id, version = 1, overrides = {}) {
  return {
    challenged: { lineageId: id, version },
    rebuttalReason: 'false_premise',
    argument: 'The handler already rejects a null session two frames earlier, so the cited crash cannot occur.',
    evidenceRefs: [{ kind: 'file', path: 'src/auth/handler.ts', startLine: 30, endLine: 36 }],
    whyNoChange: 'Adding a second null check would duplicate the existing guard without changing behavior.',
    ...overrides,
  };
}

function disputed(id, version = 1, overrides = {}) {
  return {
    lineageId: id,
    version,
    disposition: 'review_disputed',
    dispute: disputeRecord(id, version),
    ...overrides,
  };
}

function block(records) {
  return `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\`\n`;
}

/** Resolves everything: isolates the parser's own rules from §3.3 resolution. */
const resolveAll = () => true;
const resolveNone = () => false;

function parse(overrides = {}) {
  const findings = overrides.findings ?? [promptFinding(LINEAGE_A)];
  const lineages = overrides.lineages ?? Object.fromEntries(findings.map((f) => [
    f.lineageId,
    lineage(f.lineageId, { version: f.version, state: f.state }),
  ]));
  return parseFixDispositionResponse({
    response: overrides.response ?? '',
    findings,
    lineages,
    reviewStructure: overrides.reviewStructure ?? 'structured',
    runProducedFileChanges: overrides.runProducedFileChanges ?? false,
    resolveEvidenceRef: overrides.resolveEvidenceRef ?? resolveAll,
    limits: overrides.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
}

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

describe('extractDispositionRecords', () => {
  test('extracts the fenced json array #837 asks for', () => {
    const result = extractDispositionRecords(block([disputed(LINEAGE_A)]));
    expect(result.ok).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].lineageId).toBe(LINEAGE_A);
  });

  test('a response with no fenced json block is unparseable', () => {
    const result = extractDispositionRecords('I disagree with the finding and made no changes.');
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'unparseable', detail: 'response:no-disposition-block' },
    });
  });

  test('a fenced block that is not valid JSON is unparseable', () => {
    const result = extractDispositionRecords('```json\n{not json,,,\n```');
    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe('unparseable');
  });

  test('a fenced block holding an object rather than an array is unparseable', () => {
    const result = extractDispositionRecords('```json\n{ "lineageId": "ln-aaaaaaaaaaaa" }\n```');
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'unparseable', detail: 'response:no-disposition-array' },
    });
  });

  test('two json ARRAY blocks fail closed rather than picking a winner', () => {
    const response = `${block([disputed(LINEAGE_A)])}\n${block([disputed(LINEAGE_B)])}`;
    const result = extractDispositionRecords(response);
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'too-many-items', detail: 'disposition-blocks:2' },
    });
  });

  test('a non-array json block elsewhere in the response is ignored, not fatal', () => {
    const response = 'Config I inspected:\n```json\n{ "enabled": true }\n```\n' + block([disputed(LINEAGE_A)]);
    const result = extractDispositionRecords(response);
    expect(result.ok).toBe(true);
    expect(result.records).toHaveLength(1);
  });

  test('a malformed json fence next to a valid array fails the WHOLE response closed', () => {
    // A truncated first attempt followed by a clean second one. The unreadable
    // fence may itself be a disposition set, so accepting the readable neighbour
    // would silently pick a winner between two candidate sets.
    const response = `\`\`\`json\n[{"lineageId": "${LINEAGE_A}", "version": 1,\n\`\`\`\n${block([disputed(LINEAGE_A)])}`;
    const result = extractDispositionRecords(response);
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'unparseable', detail: 'disposition-block:1:invalid-json' },
    });
  });

  test('an oversized json fence next to a valid array fails the WHOLE response closed', () => {
    const response = `\`\`\`json\n[{"note":"${'x'.repeat(70 * 1024)}"}]\n\`\`\`\n${block([disputed(LINEAGE_A)])}`;
    expect(extractDispositionRecords(response)).toEqual({
      ok: false,
      failure: { reason: 'payload-too-large', detail: 'disposition-block' },
    });
  });

  test('an unreadable fence AFTER the valid array is fatal too — order does not launder it', () => {
    const response = `${block([disputed(LINEAGE_A)])}\nSecond thoughts:\n\`\`\`json\n[{"lineageId":\n\`\`\`\n`;
    const result = extractDispositionRecords(response);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'unparseable', detail: 'disposition-block:2:invalid-json' });
  });

  test('more records than a run may carry is too-many-items', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ lineageId: `ln-${String(i).padStart(12, '0')}`, version: 1, disposition: 'blocked' }));
    const result = extractDispositionRecords(block(many));
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'too-many-items', detail: 'dispositions:25' },
    });
  });

  test('an oversized block is refused before it is parsed', () => {
    const huge = `\`\`\`json\n[{"note":"${'x'.repeat(70 * 1024)}"}]\n\`\`\``;
    const result = extractDispositionRecords(huge);
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'payload-too-large', detail: 'disposition-block' },
    });
  });

  test('the block bound is measured in UTF-8 bytes, not UTF-16 code units', () => {
    // 30k Japanese characters: well under the 64 KiB bound by `String.length`
    // (1 code unit each) and roughly 90 KiB over it by the byte count the
    // #836 contract actually declares (3 bytes each).
    const prose = 'あ'.repeat(30 * 1024);
    const body = JSON.stringify([{ lineageId: LINEAGE_A, version: 1, disposition: 'blocked', note: prose }]);
    expect(body.length).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(64 * 1024);
    const result = extractDispositionRecords(`\`\`\`json\n${body}\n\`\`\``);
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'payload-too-large', detail: 'disposition-block' },
    });
  });

  test('extraction carries no state between calls', () => {
    const response = block([disputed(LINEAGE_A)]);
    expect(extractDispositionRecords(response).ok).toBe(true);
    expect(extractDispositionRecords(response).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The §3.4 zero-change decision
// ---------------------------------------------------------------------------

describe('parseFixDispositionResponse — valid disputes with no file changes', () => {
  test('a complete, evidence-backed all-disputed response admits a zero-change run', () => {
    const findings = [promptFinding(LINEAGE_A), promptFinding(LINEAGE_B)];
    const outcome = parse({
      findings,
      response: block([disputed(LINEAGE_A), disputed(LINEAGE_B)]),
    });
    expect(outcome.responseFailure).toBeNull();
    expect(outcome.rejected).toEqual([]);
    expect(outcome.unanswered).toEqual([]);
    expect(outcome.admitted).toHaveLength(2);
    expect(outcome.zeroChangeAdmissible).toBe(true);
    expect(outcome.summary.counts).toEqual({ fixed: 0, review_disputed: 2, blocked: 0 });
  });

  test('only an ADMITTED dispute consumes the version rebuttal slot', () => {
    const outcome = parse({ response: block([disputed(LINEAGE_A)]) });
    expect(outcome.admitted[0].consumesRebuttal).toBe(true);
  });

  test('a mixed review (§13) never admits a zero-change run, however valid the disputes', () => {
    const outcome = parse({
      response: block([disputed(LINEAGE_A)]),
      reviewStructure: 'mixed',
    });
    expect(outcome.admitted).toHaveLength(1);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a legacy review never admits a zero-change run', () => {
    const outcome = parse({ response: block([disputed(LINEAGE_A)]), reviewStructure: 'legacy' });
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a blocked disposition escalates to a human and does not admit a zero-change run', () => {
    const outcome = parse({
      response: block([{ lineageId: LINEAGE_A, version: 1, disposition: 'blocked', note: 'Needs a product decision.' }]),
    });
    expect(outcome.admitted).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a dispute on a human-gated finding escalates (§7 rows 3/7) and admits no zero-change run', () => {
    const outcome = parse({
      response: block([disputed(LINEAGE_A)]),
      lineages: { [LINEAGE_A]: lineage(LINEAGE_A, { humanGate: true }) },
    });
    // The record itself is well formed and still admitted — §7 escalation is a
    // routing consequence of admission, not a rejection of the dispute.
    expect(outcome.admitted).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.unanswered).toEqual([]);
    // But `escalated_human` is not a state §3.4 lets a no-diff run end in, so
    // the run keeps today's "produced no file changes" failure and the human
    // the gate exists for is not skipped.
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('one human-gated finding among otherwise valid disputes sinks the whole zero-change claim', () => {
    const findings = [promptFinding(LINEAGE_A), promptFinding(LINEAGE_B)];
    const outcome = parse({
      findings,
      lineages: {
        [LINEAGE_A]: lineage(LINEAGE_A),
        [LINEAGE_B]: lineage(LINEAGE_B, { humanGate: true }),
      },
      response: block([disputed(LINEAGE_A), disputed(LINEAGE_B)]),
    });
    expect(outcome.admitted).toHaveLength(2);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('nothing awaiting a disposition means nothing to parse and no zero-change claim', () => {
    const outcome = parse({ findings: [], lineages: {}, response: block([disputed(LINEAGE_A)]) });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.responseFailure).toBeNull();
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §12 fail-closed
// ---------------------------------------------------------------------------

describe('parseFixDispositionResponse — malformed output fails closed', () => {
  test('an unsupported refusal is not a dispute', () => {
    const outcome = parse({ response: 'This finding is simply wrong. I am making no changes.' });
    expect(outcome.responseFailure).toEqual({ reason: 'unparseable', detail: 'response:no-disposition-block' });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.unanswered).toEqual([{ lineageId: LINEAGE_A, version: 1, state: 'open' }]);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a malformed first attempt is not laundered by a valid second array', () => {
    const outcome = parse({
      response: `\`\`\`json\n[{"lineageId": "${LINEAGE_A}",\n\`\`\`\n${block([disputed(LINEAGE_A)])}`,
    });
    expect(outcome.responseFailure).toEqual({ reason: 'unparseable', detail: 'disposition-block:1:invalid-json' });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.unanswered).toEqual([{ lineageId: LINEAGE_A, version: 1, state: 'open' }]);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a dispute with no evidence is not a dispute', () => {
    const record = disputed(LINEAGE_A);
    delete record.dispute.evidenceRefs;
    const outcome = parse({ response: block([record]) });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].failure.reason).toBe('missing-field');
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a dispute whose evidence does not resolve is rejected (§3.3)', () => {
    const outcome = parse({ response: block([disputed(LINEAGE_A)]), resolveEvidenceRef: resolveNone });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected[0].failure.reason).toBe('unresolvable-evidence');
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a malformed evidence reference is rejected before resolution is attempted', () => {
    const record = disputed(LINEAGE_A);
    record.dispute.evidenceRefs = [{ kind: 'file', path: 'src/auth/handler.ts' }];
    let resolverCalls = 0;
    const outcome = parse({
      response: block([record]),
      resolveEvidenceRef: () => { resolverCalls++; return true; },
    });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected[0].failure.reason).toBe('missing-field');
    expect(resolverCalls).toBe(0);
  });

  test('a stale version is rejected and its finding stays unanswered', () => {
    const findings = [promptFinding(LINEAGE_A, { version: 2 })];
    const outcome = parse({
      findings,
      lineages: { [LINEAGE_A]: lineage(LINEAGE_A, { version: 2 }) },
      response: block([disputed(LINEAGE_A, 1)]),
    });
    expect(outcome.rejected[0].failure.reason).toBe('stale-version');
    expect(outcome.unanswered).toEqual([{ lineageId: LINEAGE_A, version: 2, state: 'open' }]);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a disposition for an unknown lineage is rejected', () => {
    const outcome = parse({
      response: block([disputed(LINEAGE_A), disputed(LINEAGE_B)]),
    });
    // LINEAGE_B is neither prompted nor persisted in this run.
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].failure.reason).toBe('unknown-lineage');
    expect(outcome.admitted).toHaveLength(1);
    // One stray record is enough to withdraw the zero-change admission.
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a missing disposition leaves its finding unanswered', () => {
    const outcome = parse({
      findings: [promptFinding(LINEAGE_A), promptFinding(LINEAGE_B)],
      response: block([disputed(LINEAGE_A)]),
    });
    expect(outcome.admitted).toHaveLength(1);
    expect(outcome.unanswered.map((f) => f.lineageId)).toEqual([LINEAGE_B]);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('two records for the same finding reject BOTH — never last-one-wins', () => {
    const outcome = parse({
      response: block([disputed(LINEAGE_A), { lineageId: LINEAGE_A, version: 1, disposition: 'blocked' }]),
    });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected).toHaveLength(2);
    expect(outcome.rejected.every((r) => r.failure.reason === 'duplicate-lineage')).toBe(true);
    expect(outcome.unanswered.map((f) => f.lineageId)).toEqual([LINEAGE_A]);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a review_disputed on a binding finding is malformed (§7 row 24)', () => {
    const outcome = parse({
      findings: [promptFinding(LINEAGE_A, { state: 'binding', allowedDispositions: ['fixed', 'blocked'] })],
      lineages: { [LINEAGE_A]: lineage(LINEAGE_A, { state: 'binding' }) },
      response: block([disputed(LINEAGE_A)]),
    });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected[0].failure.reason).toBe('dispute-on-binding');
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a binding finding still accepts blocked', () => {
    const outcome = parse({
      findings: [promptFinding(LINEAGE_A, { state: 'binding', allowedDispositions: ['fixed', 'blocked'] })],
      lineages: { [LINEAGE_A]: lineage(LINEAGE_A, { state: 'binding' }) },
      response: block([{ lineageId: LINEAGE_A, version: 1, disposition: 'blocked' }]),
    });
    expect(outcome.admitted).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
  });

  test('a second rebuttal for the same version is refused (§6.1)', () => {
    const outcome = parse({
      lineages: { [LINEAGE_A]: lineage(LINEAGE_A, { rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 0, arbitrationPasses: 0, malformedArbiterAttempts: 0, evidenceRoundsUsed: 0 } }) },
      response: block([disputed(LINEAGE_A)]),
    });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected[0].failure.reason).toBe('rebuttal-slot-consumed');
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a disposition addressed to a lineage that is not awaiting one is refused', () => {
    const outcome = parse({
      findings: [promptFinding(LINEAGE_A)],
      lineages: {
        [LINEAGE_A]: lineage(LINEAGE_A),
        [LINEAGE_B]: lineage(LINEAGE_B, { state: 'disputed' }),
      },
      response: block([disputed(LINEAGE_A), disputed(LINEAGE_B)]),
    });
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].failure.reason).toBe('not-actionable-state');
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a dispute challenging a different finding than it answers is malformed', () => {
    const record = disputed(LINEAGE_A);
    record.dispute.challenged = { lineageId: LINEAGE_B, version: 1 };
    const outcome = parse({ response: block([record]) });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('a fixed disposition in a run with no diff is malformed (§3.4)', () => {
    const outcome = parse({
      response: block([{ lineageId: LINEAGE_A, version: 1, disposition: 'fixed' }]),
      runProducedFileChanges: false,
    });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected[0].failure.reason).toBe('fixed-without-diff');
    expect(outcome.unanswered.map((f) => f.lineageId)).toEqual([LINEAGE_A]);
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('an unknown disposition token is malformed', () => {
    const outcome = parse({
      response: block([{ lineageId: LINEAGE_A, version: 1, disposition: 'wont_fix' }]),
    });
    expect(outcome.rejected[0].failure.reason).toBe('unknown-enum');
    expect(outcome.rejected[0].lineageId).toBeNull();
  });

  test('a dispute attached to a non-disputing disposition is malformed', () => {
    const outcome = parse({
      response: block([{ lineageId: LINEAGE_A, version: 1, disposition: 'blocked', dispute: disputeRecord(LINEAGE_A) }]),
      runProducedFileChanges: true,
    });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.rejected[0].failure.reason).toBe('unknown-field');
  });
});

// ---------------------------------------------------------------------------
// Mixed runs
// ---------------------------------------------------------------------------

describe('parseFixDispositionResponse — mixed fixed/disputed runs', () => {
  test('a run with a diff admits both a fixed and a disputed finding', () => {
    const outcome = parse({
      findings: [promptFinding(LINEAGE_A), promptFinding(LINEAGE_B)],
      response: block([
        { lineageId: LINEAGE_A, version: 1, disposition: 'fixed', note: 'Added the null guard.' },
        disputed(LINEAGE_B),
      ]),
      runProducedFileChanges: true,
    });
    expect(outcome.rejected).toEqual([]);
    expect(outcome.unanswered).toEqual([]);
    expect(outcome.summary.counts).toEqual({ fixed: 1, review_disputed: 1, blocked: 0 });
    // The run has a diff, so §3.4's zero-change question does not arise.
    expect(outcome.zeroChangeAdmissible).toBe(false);
  });

  test('the summary carries literals only — no argument or note prose', () => {
    const outcome = parse({
      response: block([disputed(LINEAGE_A, 1, { note: 'a note that must not travel in task context' })]),
    });
    const serialized = JSON.stringify(outcome.summary);
    expect(serialized).not.toContain('must not travel');
    expect(serialized).not.toContain('duplicate the existing guard');
    expect(outcome.summary.dispositions).toEqual([
      { lineageId: LINEAGE_A, version: 1, disposition: 'review_disputed' },
    ]);
  });

  test('the summary reports each rejection by index, lineage, and content-free reason', () => {
    const outcome = parse({
      response: block([disputed(LINEAGE_A), disputed(LINEAGE_B)]),
    });
    expect(outcome.summary.rejections).toEqual([
      { index: 1, lineageId: LINEAGE_B, reason: 'unknown-lineage', detail: 'dispositions[1].lineageId' },
    ]);
    expect(outcome.summary.unansweredLineageIds).toEqual([]);
  });
});
