import { createHash } from 'crypto';
import {
  EVIDENCE_REQUEST_MARKER,
  EVIDENCE_REQUEST_END_MARKER,
  EVIDENCE_TRANSPORTS,
  evidenceTransportForAgent,
  parseEvidenceRequest,
  renderEvidenceSection,
  renderRequestTooLarge,
  stripRequestBlocks,
} from '../dist/core/research-evidence-protocol.js';
import {
  EVIDENCE_BYTES_PER_TURN,
  MAX_QUERIES_PER_TURN,
  REQUEST_MAX_BYTES,
  REQUEST_SCAN_MAX_BYTES,
} from '../dist/core/repository-evidence.js';

function block(payload) {
  return [EVIDENCE_REQUEST_MARKER, payload, EVIDENCE_REQUEST_END_MARKER].join('\n');
}

const BUDGET = { queriesRemaining: 10, bytesRemaining: 100_000, turnsRemaining: 2 };

describe('parseEvidenceRequest', () => {
  test('well-formed single block parses into query entries', () => {
    const stdout = 'thinking...\n' + block('{"queries":[{"id":"q1","op":"list","path":"src"}]}') + '\n';
    const parsed = parseEvidenceRequest(stdout);
    expect(parsed.kind).toBe('request');
    expect(parsed.entries).toEqual([{ kind: 'query', query: { id: 'q1', op: 'list', path: 'src' } }]);
    expect(parsed.blockCount).toBe(1);
  });

  test('markers are recognized only as a whole line (rule 1)', () => {
    const inline = `text ${EVIDENCE_REQUEST_MARKER}\n{"queries":[]}\n${EVIDENCE_REQUEST_END_MARKER} trailing`;
    expect(parseEvidenceRequest(inline).kind).toBe('none');
  });

  test('the LAST well-formed block wins and the count is recorded (rule 3)', () => {
    const stdout = block('{"queries":[{"id":"old","op":"list"}]}') + '\nquote:\n'
      + block('{"queries":[{"id":"new","op":"list"}]}');
    const parsed = parseEvidenceRequest(stdout);
    expect(parsed.blockCount).toBe(2);
    expect(parsed.entries[0].query.id).toBe('new');
  });

  test('malformed JSON is reported, never partially served', () => {
    expect(parseEvidenceRequest(block('{"queries": [oops')).kind).toBe('malformed');
    expect(parseEvidenceRequest(block('{"queries": {}, "extra": 1}')).kind).toBe('malformed');
  });

  test('unknown fields are rejected, not ignored (rule 2, case 42/69)', () => {
    const parsed = parseEvidenceRequest(block('{"queries":[{"id":"q1","op":"list","nope":true},{"id":"q2","op":"search","pattern":"x","source":"repo"}]}'));
    expect(parsed.entries[0]).toMatchObject({ kind: 'invalid', reason: 'invalid-query', detail: 'unknown-field' });
    expect(parsed.entries[1]).toMatchObject({ kind: 'invalid', reason: 'invalid-query', detail: 'unknown-field' });
  });

  test('duplicate ids: first kept, later duplicates invalid (rule 6)', () => {
    const parsed = parseEvidenceRequest(block('{"queries":[{"id":"q1","op":"list"},{"id":"q1","op":"list"}]}'));
    expect(parsed.entries[0].kind).toBe('query');
    expect(parsed.entries[1]).toMatchObject({ kind: 'invalid', detail: 'duplicate-id' });
  });

  test('unsupported op is its own reason', () => {
    const parsed = parseEvidenceRequest(block('{"queries":[{"id":"q1","op":"write"}]}'));
    expect(parsed.entries[0]).toMatchObject({ kind: 'invalid', reason: 'unsupported-op' });
  });

  test('excess queries are summarized, never enumerated (rule 5)', () => {
    const queries = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, op: 'list' }));
    const parsed = parseEvidenceRequest(block(JSON.stringify({ queries })));
    expect(parsed.entries).toHaveLength(MAX_QUERIES_PER_TURN);
    expect(parsed.droppedQueries).toBe(30 - MAX_QUERIES_PER_TURN);
  });

  test('over-REQUEST_MAX_BYTES payload is not parsed; recorded by length and sha256 (rule 4)', () => {
    const payload = '{"queries":[' + '"x",'.repeat(REQUEST_MAX_BYTES / 4) + '"x"]}';
    const parsed = parseEvidenceRequest(block(payload));
    expect(parsed.kind).toBe('too-large');
    expect(parsed.payloadLength).toBe(Buffer.byteLength(payload, 'utf8'));
    expect(parsed.payloadSha256).toBe(createHash('sha256').update(payload, 'utf8').digest('hex'));
  });

  test('over-length fields are invalid-query naming field and length, never echoing the value (rule 4)', () => {
    const longPath = 'a/'.repeat(600) + 'b';
    const parsed = parseEvidenceRequest(block(JSON.stringify({ queries: [{ id: 'q1', op: 'read', path: longPath }] })));
    const entry = parsed.entries[0];
    expect(entry.kind).toBe('invalid');
    expect(entry.detail).toBe(`path-too-long:${longPath.length}`);
    expect(JSON.stringify(entry)).not.toContain('a/a/a');
  });

  test('nothing else in stdout is interpreted as a request (rule 7)', () => {
    expect(parseEvidenceRequest('{"queries":[{"id":"q1","op":"list"}]}').kind).toBe('none');
    expect(parseEvidenceRequest('```json\n{"queries":[]}\n```').kind).toBe('none');
  });

  test('the scan window is bounded in UTF-8 bytes, not UTF-16 code units (rule 4)', () => {
    // 4 UTF-8 bytes but only 2 UTF-16 units per emoji: enough padding to push
    // the block out of the BYTE window while the whole string still fits a
    // (wrong) UTF-16 window.
    const pad = '😀'.repeat(Math.ceil(REQUEST_SCAN_MAX_BYTES / 4) + 1024);
    const stdout = block('{"queries":[{"id":"q1","op":"list"}]}') + '\n' + pad;
    expect(stdout.length).toBeLessThanOrEqual(REQUEST_SCAN_MAX_BYTES);
    expect(Buffer.byteLength(pad, 'utf8')).toBeGreaterThan(REQUEST_SCAN_MAX_BYTES);
    expect(parseEvidenceRequest(stdout).kind).toBe('none');
  });

  test('a block inside the trailing byte window of oversized multibyte stdout is still found (rule 4)', () => {
    const pad = '😀'.repeat(Math.ceil(REQUEST_SCAN_MAX_BYTES / 4) + 1024);
    const stdout = pad + '\n' + block('{"queries":[{"id":"q1","op":"list"}]}') + '\n';
    const parsed = parseEvidenceRequest(stdout);
    expect(parsed.kind).toBe('request');
    expect(parsed.entries[0].query.id).toBe('q1');
  });
});

describe('stripRequestBlocks', () => {
  test('removes marker blocks and keeps findings text', () => {
    const stdout = 'Findings first.\n' + block('{"queries":[]}') + '\nAnd after.';
    expect(stripRequestBlocks(stdout)).toBe('Findings first.\nAnd after.');
  });
});

describe('renderEvidenceSection', () => {
  test('bounded, delimited, labelled, remaining budget stated (§6.2)', () => {
    const section = renderEvidenceSection({
      turn: 2,
      maxTurns: 4,
      results: [{ id: 'q1', op: 'list', status: 'ok', paths: ['src/a.ts'], truncated: false, pathsExcludedGenerated: 0, pathsExcludedSensitive: 0, pathsExcludedSymlink: 0 }],
      budget: BUDGET,
    });
    expect(section).toContain('## Repository Evidence (turn 2 of 4)');
    expect(section).toContain('Budget remaining: 10 queries, 100000 bytes, 2 turns.');
    expect(section).toContain('<!-- begin:evidence-response -->');
    expect(section).toContain('<!-- end:evidence-response -->');
    expect(section).toContain('"src/a.ts"');
  });

  test('a response that would exceed EVIDENCE_BYTES_PER_TURN is capped with one responseTruncated summary (rule 8)', () => {
    const bigContent = 'y'.repeat(60_000);
    const results = Array.from({ length: 8 }, (_, i) => ({
      id: `q${i}`, op: 'read', status: 'ok', source: 'repo', contentSource: 'worktree',
      scope: 'tracked-worktree', path: 'a.txt', content: bigContent, firstLine: 1, lastLine: 1,
      totalBytes: bigContent.length, totalLines: 1, totalLinesExact: true, truncated: false, redacted: false,
    }));
    const section = renderEvidenceSection({ turn: 1, maxTurns: 4, results, budget: BUDGET });
    expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(EVIDENCE_BYTES_PER_TURN + 2_048);
    expect(section).toContain('"responseTruncated"');
    expect(section).toContain('"omittedResults"');
  });

  test('requestOverflow is a bounded count, not per-query results (rule 5)', () => {
    const section = renderEvidenceSection({
      turn: 1, maxTurns: 4, results: [], budget: BUDGET,
      requestOverflow: { droppedQueries: 9992, limit: MAX_QUERIES_PER_TURN },
    });
    expect(section).toContain('"droppedQueries":9992');
  });

  test('request-too-large response names the bound and observed count only', () => {
    const section = renderRequestTooLarge(1, 4, BUDGET, 12_345);
    expect(section).toContain('"request-too-large"');
    expect(section).toContain(String(REQUEST_MAX_BYTES));
    expect(section).toContain('12345');
  });
});

describe('transport registry', () => {
  test('ships antigravity-stdout-marker for gemini with stdin-only delivery (§6.3.1)', () => {
    expect(EVIDENCE_TRANSPORTS.gemini).toEqual({
      id: 'antigravity-stdout-marker',
      agentId: 'gemini',
      promptDelivery: 'stdin',
    });
    expect(evidenceTransportForAgent('gemini')).toBeDefined();
  });

  test('an agent without a registered transport is refused at enable time (rule 5)', () => {
    expect(evidenceTransportForAgent('claude')).toBeUndefined();
    expect(evidenceTransportForAgent(undefined)).toBeUndefined();
  });
});
