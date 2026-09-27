/**
 * Issue #955 review (P1): the per-lineage FIX-run record
 * (src/core/review-dispute-rebuttals.ts,
 * src/core/review-dispute-lineage-provenance.ts,
 * docs/review-dispute-contract.md §7.1, §8.2, §8.3, §10.1).
 *
 * A fix run rebuts only the lineages its own response disputed, and the protocol
 * advances lineages independently — a row 11 material revision sends one lineage
 * back to the implementer while another stays disputed. So "where the §10.2
 * dispute record is" and "who wrote it" are per-lineage facts, and the
 * single-valued keys that carried them (`disputeArtifactDir` and
 * `reviewDisputeParties.implementation`) describe only the last fix run.
 *
 * The reviewer half of the same record is pinned in
 * `review-dispute-reconsiderations.test.js`; both halves are the SAME shared
 * boundary, which is what the last describe below asserts directly.
 */
import {
  REVIEW_DISPUTE_REBUTTALS_CONTEXT_FIELD,
  mergeRebuttalLineageRecord,
  parseRebuttalLineageRecord,
  readRebuttalLineageEntry,
} from '../dist/core/review-dispute-rebuttals.js';
import {
  mergeLineageProvenanceRecord,
  parseLineageProvenanceRecord,
  readLineageProvenanceEntry,
} from '../dist/core/review-dispute-lineage-provenance.js';
import { MAX_LINEAGES_PER_TASK } from '../dist/core/review-dispute.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const DIR = '/artifacts/runs/run-impl-1';
const DIR_B = '/artifacts/runs/run-impl-2';

const entry = (overrides = {}) => ({ version: 1, artifactDir: DIR, agentId: 'claude', ...overrides });
const record = (lineages) => ({ lineages });
/** Own-property view, so a null-prototype record compares as a plain object. */
const plain = (lineages) => ({ ...lineages });

test('the context key is the one the handlers write and read', () => {
  expect(REVIEW_DISPUTE_REBUTTALS_CONTEXT_FIELD).toBe('reviewDisputeRebuttals');
  // Not the reviewer half's key: the two records are written by different
  // phases, and one key holding both would be overwritten by whichever ran last.
  expect(REVIEW_DISPUTE_REBUTTALS_CONTEXT_FIELD).not.toBe('reviewDisputeReconsiderations');
});

describe('parseRebuttalLineageRecord', () => {
  test('keeps a well-formed entry and drops the persisted provider and model', () => {
    // The provider is re-derived from the agent id by the §8.3 policy and the
    // model has no derivation at all, so neither is believed on the way back in
    // — a forged provider hides an overlap, a forged model manufactures the
    // "provably different model" the same-provider opt-in requires.
    const parsed = parseRebuttalLineageRecord(
      record({ [LINEAGE]: { ...entry(), provider: 'openai', model: 'gpt-5' } }),
    );
    expect(plain(parsed.lineages)).toEqual({ [LINEAGE]: { version: 1, artifactDir: DIR, agentId: 'claude' } });
  });

  test('an agent id outside this runner\'s tuple names no party, and the directory survives', () => {
    // The bundle can still be assembled from the right directory; only the §8.3
    // identity is dropped, and the caller falls back for that alone.
    const parsed = parseRebuttalLineageRecord(record({ [LINEAGE]: entry({ agentId: 'implementer-of-the-year' }) }));
    expect(plain(parsed.lineages)).toEqual({ [LINEAGE]: { version: 1, artifactDir: DIR } });
  });

  test('one malformed entry never costs the others', () => {
    // Fail-soft per entry: a dropped entry costs the fall-back the caller
    // already has, never a counter and never a transition.
    const parsed = parseRebuttalLineageRecord(
      record({ [LINEAGE]: entry({ artifactDir: '' }), [LINEAGE_B]: entry({ artifactDir: DIR_B }) }),
    );
    expect(Object.keys(plain(parsed.lineages))).toEqual([LINEAGE_B]);
  });

  test('an unusable record reads as empty', () => {
    for (const value of [undefined, null, 'nonsense', 7, [], { lineages: 7 }]) {
      expect(plain(parseRebuttalLineageRecord(value).lineages)).toEqual({});
    }
  });

  test('the entry count is bounded by the block\'s own lineage cap', () => {
    const lineages = {};
    for (let i = 0; i < MAX_LINEAGES_PER_TASK + 5; i += 1) {
      lineages[`ln-${String(i).padStart(12, '0')}`] = entry();
    }
    expect(Object.keys(plain(parseRebuttalLineageRecord(record(lineages)).lineages)))
      .toHaveLength(MAX_LINEAGES_PER_TASK);
  });
});

describe('readRebuttalLineageEntry', () => {
  const stored = record({ [LINEAGE]: entry(), [LINEAGE_B]: entry({ artifactDir: DIR_B, agentId: 'codex' }) });

  test('answers the lineage asked about, never a sibling', () => {
    // The whole point: the sibling's directory holds `dispute-<sibling>.json`
    // and nothing this lineage's turn can read.
    expect(readRebuttalLineageEntry(stored, LINEAGE, 1)).toEqual({ version: 1, artifactDir: DIR, agentId: 'claude' });
    expect(readRebuttalLineageEntry(stored, LINEAGE_B, 1)).toMatchObject({ artifactDir: DIR_B, agentId: 'codex' });
    expect(readRebuttalLineageEntry(stored, 'ln-cccccccccccc', 1)).toBeUndefined();
  });

  test('an entry answering a LATER version is dropped rather than pointed at', () => {
    // A version only ever moves forward, so this entry describes a debate the
    // lineage has not reached — and #846 would refuse the record it names as an
    // identity mismatch. The caller keeps its own fall-back instead.
    expect(readRebuttalLineageEntry(record({ [LINEAGE]: entry({ version: 4 }) }), LINEAGE, 3)).toBeUndefined();
  });
});

describe('mergeRebuttalLineageRecord', () => {
  test('this run\'s entry is written over its own lineage and no other', () => {
    // Task context merges shallowly: a fix run returning only the lineage it
    // rebutted would drop the sibling's entry, and the sibling's arbitration
    // would then read its rebuttal from a directory that never held it.
    const merged = mergeRebuttalLineageRecord(
      record({ [LINEAGE]: entry({ artifactDir: '/artifacts/runs/run-impl-0' }), [LINEAGE_B]: entry({ artifactDir: DIR_B, agentId: 'codex' }) }),
      LINEAGE,
      { version: 2, artifactDir: DIR, agentId: 'gemini' },
    );
    expect(plain(merged.lineages)).toEqual({
      [LINEAGE_B]: { version: 1, artifactDir: DIR_B, agentId: 'codex' },
      [LINEAGE]: { version: 2, artifactDir: DIR, agentId: 'gemini' },
    });
  });

  test('folding one run\'s several rebutted lineages keeps every one of them', () => {
    // One fix run can rebut several findings, and the handler folds the merge
    // once per written record.
    const merged = [LINEAGE, LINEAGE_B].reduce(
      (carried, lineageId) => mergeRebuttalLineageRecord(carried, lineageId, entry()),
      undefined,
    );
    expect(Object.keys(plain(merged.lineages)).sort()).toEqual([LINEAGE, LINEAGE_B]);
  });

  test('an entry this module would refuse to read is never written', () => {
    const merged = mergeRebuttalLineageRecord(record({ [LINEAGE_B]: entry() }), LINEAGE, { version: 1, artifactDir: '' });
    expect(Object.keys(plain(merged.lineages))).toEqual([LINEAGE_B]);
  });

  test('the run\'s own entry is always kept when the cap is already full', () => {
    const lineages = {};
    for (let i = 0; i < MAX_LINEAGES_PER_TASK; i += 1) lineages[`ln-${String(i).padStart(12, '0')}`] = entry();
    const merged = mergeRebuttalLineageRecord(record(lineages), LINEAGE, entry({ version: 2 }));
    expect(Object.keys(plain(merged.lineages))).toHaveLength(MAX_LINEAGES_PER_TASK);
    expect(merged.lineages[LINEAGE]).toEqual({ version: 2, artifactDir: DIR, agentId: 'claude' });
  });
});

describe('both halves are one boundary', () => {
  // The implementer and reviewer records differ only in which key they live
  // under; what a persisted entry may claim is decided once, so a change to how
  // these records are believed cannot land on one half and miss the other.
  const stored = record({ [LINEAGE]: { ...entry(), provider: 'openai', model: 'gpt-5' } });

  test('parse, read, and merge are the shared implementation', () => {
    expect(plain(parseRebuttalLineageRecord(stored).lineages))
      .toEqual(plain(parseLineageProvenanceRecord(stored).lineages));
    expect(readRebuttalLineageEntry(stored, LINEAGE, 2)).toEqual(readLineageProvenanceEntry(stored, LINEAGE, 2));
    expect(plain(mergeRebuttalLineageRecord(stored, LINEAGE_B, entry({ artifactDir: DIR_B })).lineages))
      .toEqual(plain(mergeLineageProvenanceRecord(stored, LINEAGE_B, entry({ artifactDir: DIR_B })).lineages));
  });
});
