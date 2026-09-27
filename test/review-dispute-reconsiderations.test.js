/**
 * Issue #955 review (P1): the per-lineage reviewer-run record
 * (src/core/review-dispute-reconsiderations.ts,
 * docs/review-dispute-contract.md §7.1, §8.2, §8.3, §10.1).
 *
 * A reviewer sub-turn answers ONE lineage per review run, so "where the §10.2
 * reconsideration record is" and "who wrote it" are per-lineage facts. The
 * single-valued context keys that carried them describe only the last reviewer
 * run, and the arbitration turn that follows selects the first still-pending
 * lineage — which need not be that one.
 *
 * What is pinned here is the record itself: it is read back from task context
 * like every other §10.1-adjacent key, so it is bounded, fail-soft per entry, and
 * believes nothing it cannot re-derive.
 */
import {
  REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD,
  mergeReconsiderationLineageRecord,
  parseReconsiderationLineageRecord,
  readReconsiderationLineageEntry,
  readReconsiderationSummaryParty,
} from '../dist/core/review-dispute-reconsiderations.js';
import { MAX_LINEAGES_PER_TASK } from '../dist/core/review-dispute.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const DIR = '/artifacts/runs/run-review-1';

const entry = (overrides = {}) => ({ version: 1, artifactDir: DIR, agentId: 'claude', ...overrides });
const record = (lineages) => ({ lineages });

/** Own-property view, so a null-prototype record compares as a plain object. */
const plain = (lineages) => ({ ...lineages });

test('the context key is the one the handlers write and read', () => {
  expect(REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD).toBe('reviewDisputeReconsiderations');
});

describe('parseReconsiderationLineageRecord', () => {
  test('keeps a well-formed entry and drops the persisted provider and model', () => {
    // The provider is re-derived from the agent id by the §8.3 policy and the
    // model has no derivation at all, so neither is believed on the way back in.
    const parsed = parseReconsiderationLineageRecord(
      record({ [LINEAGE]: { ...entry(), provider: 'openai', model: 'gpt-5' } }),
    );
    expect(plain(parsed.lineages)).toEqual({ [LINEAGE]: { version: 1, artifactDir: DIR, agentId: 'claude' } });
  });

  test('an agent id outside this runner\'s tuple names no party, and the directory survives', () => {
    // §8.3 has no provider to measure independence against for a name this
    // process cannot resolve — but a path is a path, and the invocation re-checks
    // it against the artifact root before reading anything.
    const parsed = parseReconsiderationLineageRecord(record({ [LINEAGE]: entry({ agentId: 'reviewer-of-the-year' }) }));
    expect(plain(parsed.lineages)).toEqual({ [LINEAGE]: { version: 1, artifactDir: DIR } });
  });

  test.each([
    ['a version below one', { version: 0 }],
    ['a fractional version', { version: 1.5 }],
    ['a missing version', { version: undefined }],
    ['an empty directory', { artifactDir: '' }],
    ['a blank directory', { artifactDir: '   ' }],
    ['a directory longer than the bound', { artifactDir: `/artifacts/${'x'.repeat(1024)}` }],
    ['a directory that is not a string', { artifactDir: 7 }],
  ])('drops an entry with %s', (_name, overrides) => {
    // An empty or absent directory is the dangerous one: it would turn the record
    // read into a relative-path read of the process's working directory.
    expect(plain(parseReconsiderationLineageRecord(record({ [LINEAGE]: entry(overrides) })).lineages)).toEqual({});
  });

  // Issue #1085 review, P2: the posture rides the entry so a lineage decided
  // under `read-bounded` stays identifiable after a LATER lineage's reviewer run
  // rewrote the single-valued summary.
  test('the execution posture survives verbatim, and is never invented', () => {
    const parsed = parseReconsiderationLineageRecord(
      record({
        [LINEAGE]: entry({ toolPolicy: 'read-bounded' }),
        [LINEAGE_B]: entry({ artifactDir: '/artifacts/runs/run-review-2' }),
      }),
    );
    expect(plain(parsed.lineages)).toEqual({
      [LINEAGE]: { version: 1, artifactDir: DIR, agentId: 'claude', toolPolicy: 'read-bounded' },
      // No posture recorded means no posture reported. Defaulting this to
      // `no-tools` is exactly the misreading the second literal exists to stop.
      [LINEAGE_B]: { version: 1, artifactDir: '/artifacts/runs/run-review-2', agentId: 'claude' },
    });
  });

  test.each([
    ['a posture that is not a string', 7],
    ['a blank posture', '   '],
    ['a posture past the bound', 'x'.repeat(65)],
  ])('drops %s while keeping the rest of the entry', (_name, toolPolicy) => {
    // Fail-soft, like `agentId`: the entry is still a usable locator, and a
    // posture that could not have been written here names none.
    const parsed = parseReconsiderationLineageRecord(record({ [LINEAGE]: entry({ toolPolicy }) }));
    expect(plain(parsed.lineages)).toEqual({ [LINEAGE]: { version: 1, artifactDir: DIR, agentId: 'claude' } });
  });

  test('one malformed entry never costs the others', () => {
    const parsed = parseReconsiderationLineageRecord(
      record({ [LINEAGE]: entry({ version: 0 }), [LINEAGE_B]: entry({ artifactDir: '/artifacts/runs/run-review-2' }) }),
    );
    expect(Object.keys(plain(parsed.lineages))).toEqual([LINEAGE_B]);
  });

  test('an unusable record reads as empty', () => {
    for (const value of [undefined, null, 'nonsense', 7, [], { lineages: 7 }, { lineages: [] }]) {
      expect(plain(parseReconsiderationLineageRecord(value).lineages)).toEqual({});
    }
  });

  test('the entry count is bounded by the block\'s own lineage cap', () => {
    const lineages = {};
    for (let i = 0; i < MAX_LINEAGES_PER_TASK + 5; i += 1) {
      lineages[`ln-${String(i).padStart(12, '0')}`] = entry();
    }
    expect(Object.keys(plain(parseReconsiderationLineageRecord(record(lineages)).lineages)))
      .toHaveLength(MAX_LINEAGES_PER_TASK);
  });

  test('a prototype-shaped lineage id is an entry, not a prototype', () => {
    // Lineage ids are runner-minted, but this record comes off task context.
    const parsed = parseReconsiderationLineageRecord(
      JSON.parse(`{"lineages":{"__proto__":{"version":1,"artifactDir":"${DIR}"}}}`),
    );
    expect(Object.keys(plain(parsed.lineages))).toEqual(['__proto__']);
    expect(readReconsiderationLineageEntry(parsed, '__proto__', 1)).toEqual({ version: 1, artifactDir: DIR });
    // The record is a record, not a prototype: nothing leaked onto Object.
    expect({}.artifactDir).toBeUndefined();
  });
});

describe('readReconsiderationLineageEntry', () => {
  const stored = record({ [LINEAGE]: entry(), [LINEAGE_B]: entry({ artifactDir: '/artifacts/runs/run-review-2' }) });

  test('answers the lineage asked about, never a sibling', () => {
    expect(readReconsiderationLineageEntry(stored, LINEAGE, 1)).toEqual({
      version: 1,
      artifactDir: DIR,
      agentId: 'claude',
    });
    expect(readReconsiderationLineageEntry(stored, 'ln-cccccccccccc', 1)).toBeUndefined();
  });

  test('an entry answering an EARLIER version is the ordinary case', () => {
    // A row 11/12 revision bumps the version the arbiter rules on past the one
    // the reviewer answered; the record it wrote is still the record.
    expect(readReconsiderationLineageEntry(stored, LINEAGE, 3)).toMatchObject({ version: 1 });
  });

  test('an entry answering a LATER version is dropped rather than pointed at', () => {
    // A version only ever moves forward, so this entry describes a debate the
    // lineage has not reached — and #846 would refuse the record as an identity
    // mismatch. The caller keeps its own fall-back instead.
    expect(readReconsiderationLineageEntry(record({ [LINEAGE]: entry({ version: 4 }) }), LINEAGE, 3)).toBeUndefined();
  });
});

describe('readReconsiderationSummaryParty', () => {
  /** The reviewer sub-turn's own single-valued invocation summary. */
  const summary = (overrides = {}) => ({
    lineageId: LINEAGE,
    version: 1,
    profile: { agentId: 'codex', provider: 'openai', model: 'gpt-5-codex' },
    ...overrides,
  });

  test('the summary answers the lineage it named, as an id alone', () => {
    // The recorded provider and model are dropped like every other persisted
    // identity: the provider is re-derived from the id and an unknown model can
    // only make §8.3 stricter.
    expect(readReconsiderationSummaryParty(summary(), LINEAGE, 1)).toEqual({ agentId: 'codex' });
  });

  test('a summary written for a SIBLING lineage is not this lineage\'s reviewer', () => {
    // The violation P1 names: this key is rewritten by every reviewer run, so on
    // a task with two debates it describes whichever lineage was answered last.
    // Believing it would let §8.3 measure independence against a reviewer this
    // finding never had.
    expect(readReconsiderationSummaryParty(summary({ lineageId: LINEAGE_B }), LINEAGE, 1)).toBeUndefined();
  });

  test('an EARLIER version is the ordinary case, a LATER one is dropped', () => {
    expect(readReconsiderationSummaryParty(summary(), LINEAGE, 3)).toEqual({ agentId: 'codex' });
    expect(readReconsiderationSummaryParty(summary({ version: 4 }), LINEAGE, 3)).toBeUndefined();
  });

  test.each([
    ['no summary at all', undefined],
    ['an unreadable summary', 'nonsense'],
    ['an array', []],
    ['a summary naming no lineage', { version: 1, profile: { agentId: 'codex' } }],
    ['a lineage id that is not a string', { lineageId: 7, version: 1, profile: { agentId: 'codex' } }],
    ['a missing version', { lineageId: LINEAGE, profile: { agentId: 'codex' } }],
    ['a fractional version', { lineageId: LINEAGE, version: 1.5, profile: { agentId: 'codex' } }],
    ['a version below one', { lineageId: LINEAGE, version: 0, profile: { agentId: 'codex' } }],
    ['an invocation that resolved no profile', { lineageId: LINEAGE, version: 1, profile: null }],
    ['an agent this runner does not know', { lineageId: LINEAGE, version: 1, profile: { agentId: 'reviewer-of-the-year' } }],
  ])('%s names no party', (_name, value) => {
    expect(readReconsiderationSummaryParty(value, LINEAGE, 1)).toBeUndefined();
  });
});

describe('mergeReconsiderationLineageRecord', () => {
  test('this run\'s entry is written over its own lineage and no other', () => {
    const merged = mergeReconsiderationLineageRecord(
      record({
        [LINEAGE]: entry({ artifactDir: '/artifacts/runs/run-review-0' }),
        [LINEAGE_B]: entry({ artifactDir: '/artifacts/runs/run-review-2', agentId: 'gemini' }),
      }),
      LINEAGE,
      { version: 2, artifactDir: DIR, agentId: 'codex' },
    );
    expect(plain(merged.lineages)).toEqual({
      [LINEAGE_B]: { version: 1, artifactDir: '/artifacts/runs/run-review-2', agentId: 'gemini' },
      [LINEAGE]: { version: 2, artifactDir: DIR, agentId: 'codex' },
    });
  });

  test('an absent or unreadable prior record is simply this run\'s own entry', () => {
    for (const prior of [undefined, null, 'nonsense', {}]) {
      expect(plain(mergeReconsiderationLineageRecord(prior, LINEAGE, entry()).lineages))
        .toEqual({ [LINEAGE]: { version: 1, artifactDir: DIR, agentId: 'claude' } });
    }
  });

  test('the run\'s own entry is always kept when the cap is already full', () => {
    // Entries past the block's own lineage cap can only name lineages it no
    // longer has; dropping the entry this run just wrote would reintroduce the
    // gap the record closes.
    const lineages = {};
    for (let i = 0; i < MAX_LINEAGES_PER_TASK; i += 1) lineages[`ln-${String(i).padStart(12, '0')}`] = entry();
    const merged = mergeReconsiderationLineageRecord(record(lineages), LINEAGE, entry({ version: 2 }));
    const keys = Object.keys(plain(merged.lineages));
    expect(keys).toHaveLength(MAX_LINEAGES_PER_TASK);
    expect(merged.lineages[LINEAGE]).toEqual({ version: 2, artifactDir: DIR, agentId: 'claude' });
  });

  test('an entry this module would refuse to read is never written', () => {
    const merged = mergeReconsiderationLineageRecord(
      record({ [LINEAGE_B]: entry() }),
      LINEAGE,
      { version: 1, artifactDir: '' },
    );
    expect(Object.keys(plain(merged.lineages))).toEqual([LINEAGE_B]);
  });
});
