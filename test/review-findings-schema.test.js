/**
 * Unit tests for the issue #1068 finding-envelope JSON Schema
 * (src/core/review-findings-schema.ts).
 *
 * The schema exists to help a CLI that accepts one for its final message
 * (`codex exec --output-schema`) produce something admissible on the first turn.
 * Two properties are what these tests are for:
 *
 *  - it is DERIVED from the domain, so an enum or a bound that moves in
 *    `review-dispute.ts` moves here in the same commit rather than drifting into
 *    a second schema vocabulary that describes a shape admission refuses;
 *  - it is ASSISTANCE, never admission — a payload written to satisfy it still
 *    has to pass `parseReviewFindingsEnvelope`, and the strict encoding's
 *    explicit `null`s are removed before it does.
 */
import {
  REVIEW_FINDINGS_SCHEMA_NAME,
  buildReviewFindingsJsonSchema,
  stripNullEnvelopeMembers,
} from '../dist/core/review-findings-schema.js';
import {
  REVIEW_BLOCKED_REASONS,
  REVIEW_ENVELOPE_STATUSES,
  REVIEW_FINDINGS_ENVELOPE_VERSION,
  parseReviewFindingsEnvelope,
} from '../dist/core/review-finding-envelope.js';
import {
  ABSOLUTE_MAX_VERSION,
  FINDING_SEVERITIES,
  MAX_AFFECTED_BOUNDARY_CHARS,
  MAX_EVIDENCE_PATH_CHARS,
  MAX_EVIDENCE_REFS_PER_RECORD,
  MAX_FINDING_TEXT_CHARS,
  MAX_FINDINGS_PER_REVIEW,
} from '../dist/core/review-dispute.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';

function findingSchemaOf(schema) {
  return schema.properties.findings.items;
}

/** Every object schema reachable from the document, root included. */
function objectSchemas(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) objectSchemas(item, out);
    return out;
  }
  const type = node.type;
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object'));
  if (isObject && node.properties !== undefined) out.push(node);
  for (const value of Object.values(node)) objectSchemas(value, out);
  return out;
}

describe('review findings JSON Schema', () => {
  test('the envelope wrapper is derived from the domain vocabulary', () => {
    const schema = buildReviewFindingsJsonSchema();
    expect(schema.title).toBe(REVIEW_FINDINGS_SCHEMA_NAME);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.version.enum).toEqual([REVIEW_FINDINGS_ENVELOPE_VERSION]);
    expect(schema.properties.status.enum).toEqual([...REVIEW_ENVELOPE_STATUSES]);
    // The blocked vocabulary is closed and comes from the domain, plus the `null`
    // a strict encoding uses where the envelope simply omits the member.
    expect(schema.properties.blockedReason.enum).toEqual([...REVIEW_BLOCKED_REASONS, null]);
    expect(schema.properties.findings.maxItems).toBe(MAX_FINDINGS_PER_REVIEW);
    expect(schema.properties.findings.minItems).toBe(1);
  });

  test('the finding object is the §2.1 record minus the runner-owned fields', () => {
    const finding = findingSchemaOf(buildReviewFindingsJsonSchema());
    expect(finding.additionalProperties).toBe(false);
    expect(Object.keys(finding.properties).sort()).toEqual([
      'affectedBoundary',
      'evidenceRefs',
      'failureScenario',
      'preconditions',
      'requiredOutcome',
      'severity',
      'version',
      'violatedContract',
    ]);
    // §2.1: `humanGate` and `reviewerMeta` are runner-owned and a reviewer-supplied
    // value is discarded, so the schema does not offer them at all — and neither
    // is `lineageId` on a task with no open lineage to attach to.
    expect(finding.properties.humanGate).toBeUndefined();
    expect(finding.properties.reviewerMeta).toBeUndefined();
    expect(finding.properties.lineageId).toBeUndefined();
    expect(finding.properties.severity.enum).toEqual([...FINDING_SEVERITIES]);
    expect(finding.properties.version.maximum).toBe(ABSOLUTE_MAX_VERSION);
    expect(finding.properties.violatedContract.maxLength).toBe(MAX_FINDING_TEXT_CHARS);
    expect(finding.properties.affectedBoundary.maxLength).toBe(MAX_AFFECTED_BOUNDARY_CHARS);
    expect(finding.properties.evidenceRefs.maxItems).toBe(MAX_EVIDENCE_REFS_PER_RECORD);
    expect(finding.properties.evidenceRefs.minItems).toBe(1);
  });

  test('only the evidence kinds this run can resolve are expressible', () => {
    const withoutIssue = buildReviewFindingsJsonSchema({ resolvableEvidenceKinds: ['file', 'doc_section'] });
    const kinds = (schema) =>
      findingSchemaOf(schema).properties.evidenceRefs.items.anyOf.map((v) => v.properties.kind.enum[0]);
    expect(kinds(withoutIssue)).toEqual(['file', 'doc_section']);

    const withIssue = buildReviewFindingsJsonSchema({
      resolvableEvidenceKinds: ['file', 'doc_section', 'issue_quote'],
    });
    expect(kinds(withIssue)).toEqual(['file', 'doc_section', 'issue_quote']);

    const fileVariant = findingSchemaOf(withoutIssue).properties.evidenceRefs.items.anyOf[0];
    expect(fileVariant.required).toEqual(['kind', 'path', 'startLine', 'endLine']);
    expect(fileVariant.properties.path.maxLength).toBe(MAX_EVIDENCE_PATH_CHARS);
    expect(fileVariant.properties.startLine.minimum).toBe(1);
  });

  test('a single resolvable kind is the item schema itself, not a one-member union', () => {
    const schema = buildReviewFindingsJsonSchema({ resolvableEvidenceKinds: ['file'] });
    const items = findingSchemaOf(schema).properties.evidenceRefs.items;
    expect(items.anyOf).toBeUndefined();
    expect(items.properties.kind.enum).toEqual(['file']);
  });

  test('kinds that name no §3.3 reference form fall back rather than emitting an empty union', () => {
    // An empty `anyOf` is not a valid schema in any draft, so a caller whose kinds
    // resolve to nothing gets the default pair — a narrower envelope than asked
    // for, never an unusable document.
    const schema = buildReviewFindingsJsonSchema({ resolvableEvidenceKinds: ['telepathy'] });
    const kinds = findingSchemaOf(schema).properties.evidenceRefs.items.anyOf.map(
      (v) => v.properties.kind.enum[0],
    );
    expect(kinds).toEqual(['file', 'doc_section']);
  });

  test('a re-raise may name only an open lineage', () => {
    const schema = buildReviewFindingsJsonSchema({ liveLineageIds: [LINEAGE] });
    const finding = findingSchemaOf(schema);
    expect(finding.properties.lineageId.enum).toEqual([LINEAGE, null]);
    expect(finding.properties.lineageId.type).toEqual(['string', 'null']);
    // Required-and-nullable, not optional: the strict subset has no other way to
    // express "may be absent", and the `null` is stripped before admission.
    expect(finding.required).toContain('lineageId');
  });

  test('every object in the document is closed and states all of its members required', () => {
    const schema = buildReviewFindingsJsonSchema({
      resolvableEvidenceKinds: ['file', 'doc_section', 'issue_quote'],
      liveLineageIds: [LINEAGE],
    });
    const objects = objectSchemas(schema);
    expect(objects.length).toBeGreaterThan(4);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect([...object.required].sort()).toEqual(Object.keys(object.properties).sort());
    }
  });

  test('the schema is rebuilt per run, never shared', () => {
    const a = buildReviewFindingsJsonSchema({ liveLineageIds: [LINEAGE] });
    const b = buildReviewFindingsJsonSchema();
    expect(findingSchemaOf(a).properties.lineageId).toBeDefined();
    // A cached document would have handed the second run the first run's lineage.
    expect(findingSchemaOf(b).properties.lineageId).toBeUndefined();
  });

  test('the document serializes; nothing in it is a function or a cycle', () => {
    const schema = buildReviewFindingsJsonSchema({ liveLineageIds: [LINEAGE] });
    expect(() => JSON.stringify(schema)).not.toThrow();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe('strict-encoding nulls', () => {
  const finding = {
    version: 1,
    severity: 'P1',
    violatedContract: 'The endpoint must never return 500 for an unauthenticated request.',
    preconditions: 'A request with no Authorization header.',
    failureScenario: 'GET /orders with no header returns 500 instead of 401.',
    affectedBoundary: 'src/auth/handler.ts',
    requiredOutcome: 'Unauthenticated requests receive 401.',
    evidenceRefs: [{ kind: 'file', path: 'src/auth/handler.ts', startLine: 10, endLine: 12 }],
  };

  test('a strict `success` envelope admits once its nulls are removed', () => {
    const strict = JSON.stringify({ version: 1, status: 'success', blockedReason: null, findings: null });
    // Without the strip, the explicit nulls are unknown fields for this status:
    // this is the exact failure the adapter exists to prevent.
    expect(parseReviewFindingsEnvelope(strict).ok).toBe(false);
    const parsed = parseReviewFindingsEnvelope(stripNullEnvelopeMembers(strict));
    expect(parsed.ok).toBe(true);
    expect(parsed.value.status).toBe('success');
    expect(parsed.value.candidates).toEqual([]);
  });

  test('a strict `blocked` envelope keeps its reason', () => {
    const strict = JSON.stringify({
      version: 1,
      status: 'blocked',
      blockedReason: 'insufficient_context',
      findings: null,
    });
    const parsed = parseReviewFindingsEnvelope(stripNullEnvelopeMembers(strict));
    expect(parsed.ok).toBe(true);
    expect(parsed.value.blockedReason).toBe('insufficient_context');
  });

  test('a strict `findings` envelope keeps its findings and drops a null lineageId', () => {
    const strict = JSON.stringify({
      version: 1,
      status: 'findings',
      blockedReason: null,
      findings: [{ lineageId: null, ...finding }],
    });
    const parsed = parseReviewFindingsEnvelope(stripNullEnvelopeMembers(strict));
    expect(parsed.ok).toBe(true);
    expect(parsed.value.candidates).toHaveLength(1);
    expect(parsed.value.candidates[0].lineageId).toBeUndefined();
    expect(parsed.value.candidates[0].severity).toBe('P1');
  });

  test('an echoed lineage id survives; only an explicit null is dropped', () => {
    const strict = JSON.stringify({
      version: 1,
      status: 'findings',
      blockedReason: null,
      findings: [{ lineageId: LINEAGE, ...finding }],
    });
    const parsed = parseReviewFindingsEnvelope(stripNullEnvelopeMembers(strict));
    expect(parsed.ok).toBe(true);
    expect(parsed.value.candidates[0].lineageId).toBe(LINEAGE);
  });

  test('the strip repairs nothing else and is never a second admission gate', () => {
    // A `findings: null` on a `findings` status is a self-contradicting envelope,
    // and removing the member leaves the domain parser to say so.
    const contradiction = JSON.stringify({ version: 1, status: 'findings', blockedReason: null, findings: null });
    const parsed = parseReviewFindingsEnvelope(stripNullEnvelopeMembers(contradiction));
    expect(parsed.ok).toBe(false);
    expect(parsed.failure.reason).toBe('missing-field');

    // Unknown keys, non-null values, and a null in a position the schema never
    // declares nullable are all left exactly as written.
    const untouched = JSON.stringify({ version: 1, status: 'success', invented: null });
    expect(stripNullEnvelopeMembers(untouched)).toBe(untouched);

    // Unparseable input has no repair and no failure vocabulary here.
    expect(stripNullEnvelopeMembers('not json at all')).toBe('not json at all');
    expect(stripNullEnvelopeMembers('[1,2,3]')).toBe('[1,2,3]');
  });

  test('a payload with nothing to strip is returned byte-identical', () => {
    // The response artifact is what an operator diffs, so re-serializing for
    // nothing would rewrite the agent's own spacing and key order.
    const already = '{\n  "version": 1,\n  "status": "success"\n}';
    expect(stripNullEnvelopeMembers(already)).toBe(already);
  });
});
