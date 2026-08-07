/**
 * Unit tests for the structured review finding envelope (issue #841,
 * docs/review-dispute-contract.md).
 *
 * Two properties govern everything here:
 *
 *  1. **Fail closed.** An envelope that cannot be admitted in full is admitted
 *     not at all — no lineage, no partial context, no half-stamped finding.
 *  2. **Local only.** This module admits a review's structured findings. It
 *     reads a persisted lineage only to decide which debate a candidate belongs
 *     to (§2.2) — it never advances a counter, never consults a §6.1 cap, never
 *     rewrites a record it attached to, and never produces a state other than
 *     `open` at version 1. Those are #840's, and the last describe block pins
 *     that the boundary is real rather than merely intended.
 */
import {
  REVIEW_BLOCKED_REASONS,
  REVIEW_ENVELOPE_STATUSES,
  REVIEW_FINDINGS_END_MARKER,
  REVIEW_FINDINGS_ENVELOPE_MAX_BYTES,
  REVIEW_FINDINGS_MARKER,
  REVIEW_FINDING_ADMISSION_OVERHEAD_BYTES,
  STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS,
  admitReviewFindings,
  buildInitialLineageContext,
  createReviewEvidenceResolver,
  extractReviewFindingsEnvelope,
  openLineagePrompts,
  parseReviewFindingsEnvelope,
  processReviewFindings,
  resolveFindingHumanGate,
  reviewFindingsInstructions,
  reviewResolvableEvidenceKinds,
  structuredFindingsSupport,
} from '../dist/core/review-finding-envelope.js';
import {
  MAX_FINDINGS_PER_REVIEW,
  MAX_FINDING_TEXT_CHARS,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  ZERO_LINEAGE_COUNTERS,
} from '../dist/core/review-dispute.js';
import { stableStringify } from '../dist/core/review-dispute-lineage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRACKED = new Set([
  'src/handlers/review.ts',
  'src/core/review-finding-envelope.ts',
  'docs/review-dispute-contract.md',
]);

/**
 * Content of the tracked fixtures, so a §3.3 reference can be checked against the
 * place it cites and not merely against the path. Sources are 40 lines; the doc
 * carries two headings.
 */
const numberedLines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

const TRACKED_CONTENT = new Map([
  ['src/handlers/review.ts', `${numberedLines(40)}\n`],
  ['src/core/review-finding-envelope.ts', `${numberedLines(40)}\n`],
  [
    'docs/review-dispute-contract.md',
    '# Review dispute contract\n\n## §2.1 Finding schema\n\nA finding is …\n\n### §10.1  Bounded   persistence\n\nOnly the block …\n',
  ],
]);

const readTrackedFile = (path) => TRACKED_CONTENT.get(path);

const RESOLVER = createReviewEvidenceResolver({ trackedFiles: TRACKED, readTrackedFile });

const META = {
  agentId: 'claude',
  model: 'opus',
  effort: 'high',
  reviewRunId: 'run-review-1',
  timestamp: '2026-08-03T00:00:00.000Z',
};

function finding(overrides = {}) {
  return {
    version: 1,
    severity: 'P1',
    violatedContract: 'Acceptance criterion: normal review produces validated structured findings',
    preconditions: 'The review-dispute protocol is enabled and the agent honors the output contract',
    failureScenario: 'A blocking finding is emitted as prose, so no lineage exists and it cannot be disputed',
    affectedBoundary: 'src/handlers/review.ts',
    requiredOutcome: 'The review emits one validated structured envelope carrying every blocking finding',
    evidenceRefs: [{ kind: 'file', path: 'src/handlers/review.ts', startLine: 10, endLine: 20 }],
    ...overrides,
  };
}

/** A second, structurally DISTINCT finding — a different §2.2 identity tuple. */
function otherFinding(overrides = {}) {
  return finding({
    severity: 'P2',
    violatedContract: 'Acceptance criterion: raw review output stays local',
    failureScenario: 'The full reviewer report is written into task.context and grows the SQLite row',
    affectedBoundary: 'src/core/review-finding-envelope.ts',
    evidenceRefs: [{ kind: 'file', path: 'src/core/review-finding-envelope.ts', startLine: 1, endLine: 5 }],
    ...overrides,
  });
}

function wrap(body, { preamble = '', trailer = '' } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return `${preamble}\n${REVIEW_FINDINGS_MARKER}\n${payload}\n${REVIEW_FINDINGS_END_MARKER}\n${trailer}`;
}

function run(output, overrides = {}) {
  return processReviewFindings({
    output,
    reviewerMeta: META,
    humanGate: false,
    resolveEvidenceRef: RESOLVER,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Success and blocked envelopes
// ---------------------------------------------------------------------------

describe('review finding envelope — success and blocked', () => {
  test('a success envelope admits with no findings and a fully structured review', () => {
    const outcome = run(wrap({ version: 1, status: 'success' }));
    expect(outcome.kind).toBe('admitted');
    expect(outcome.status).toBe('success');
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.structure.mode).toBe('structured');
    expect(outcome.structure.zeroChangeValid).toBe(true);
    expect(Object.keys(outcome.context.lineages)).toHaveLength(0);
  });

  test('a blocked envelope carries a closed reason token', () => {
    const outcome = run(wrap({ version: 1, status: 'blocked', blockedReason: 'insufficient_context' }));
    expect(outcome.kind).toBe('admitted');
    expect(outcome.status).toBe('blocked');
    expect(outcome.blockedReason).toBe('insufficient_context');
    expect(outcome.findings).toHaveLength(0);
  });

  test('a blocked envelope without a reason is malformed', () => {
    const outcome = run(wrap({ version: 1, status: 'blocked' }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'missing-field', detail: 'envelope.blockedReason' });
  });

  test('a blocked reason outside the closed vocabulary is malformed', () => {
    const outcome = run(wrap({ version: 1, status: 'blocked', blockedReason: 'i felt like it' }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('unknown-enum');
  });

  test('a blockedReason on a non-blocked status is malformed', () => {
    const outcome = run(wrap({ version: 1, status: 'success', blockedReason: 'insufficient_context' }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'unknown-field', detail: 'envelope.blockedReason' });
  });

  test('the closed status and reason vocabularies are exactly the contract tokens', () => {
    expect([...REVIEW_ENVELOPE_STATUSES]).toEqual(['success', 'blocked', 'findings']);
    expect([...REVIEW_BLOCKED_REASONS]).toEqual([
      'insufficient_context',
      'diff_not_reviewable',
      'tooling_unavailable',
      'requires_human_judgment',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Findings, lineage minting, and determinism
// ---------------------------------------------------------------------------

describe('review finding envelope — admitted findings', () => {
  test('a single finding mints a version-1 lineage in state open with zero counters', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    expect(outcome.kind).toBe('admitted');
    expect(outcome.findings).toHaveLength(1);
    const admitted = outcome.findings[0];
    expect(admitted.lineageId).toMatch(/^ln-[0-9a-f]{12}$/);
    expect(admitted.version).toBe(1);
    expect(admitted.humanGate).toBe(false);
    expect(admitted.reviewerMeta).toEqual(META);
    const lineage = outcome.context.lineages[admitted.lineageId];
    expect(lineage).toMatchObject({
      lineageId: admitted.lineageId,
      state: 'open',
      version: 1,
      counters: ZERO_LINEAGE_COUNTERS,
      rebuttedVersions: [],
      humanGate: false,
      severity: 'P1',
      affectedBoundary: 'src/handlers/review.ts',
    });
  });

  test('multiple distinct findings mint distinct lineages, all at version 1', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding(), otherFinding()] }));
    expect(outcome.kind).toBe('admitted');
    expect(outcome.findings).toHaveLength(2);
    const ids = outcome.findings.map((f) => f.lineageId);
    expect(new Set(ids).size).toBe(2);
    expect(Object.keys(outcome.context.lineages).sort()).toEqual([...ids].sort());
    expect(outcome.findings.every((f) => f.version === 1)).toBe(true);
  });

  test('the runner stamps humanGate; a reviewer-supplied value is dropped and logged', () => {
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ humanGate: false, reviewerMeta: { agentId: 'impostor' } })],
      }),
      { humanGate: true },
    );
    expect(outcome.kind).toBe('admitted');
    expect(outcome.findings[0].humanGate).toBe(true);
    expect(outcome.findings[0].reviewerMeta.agentId).toBe('claude');
    expect(outcome.ignoredRunnerOwnedFields).toEqual([
      'envelope.findings[0].humanGate',
      'envelope.findings[0].reviewerMeta',
    ]);
  });

  test('parsing the same output twice is byte-identical', () => {
    const output = wrap({ version: 1, status: 'findings', findings: [finding(), otherFinding()] });
    const first = run(output);
    const second = run(output);
    expect(stableStringify(first.context)).toBe(stableStringify(second.context));
    expect(stableStringify(first.findings)).toBe(stableStringify(second.findings));
  });

  test('an absolute boundary under the execution root normalizes to repository-relative', () => {
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ affectedBoundary: '/work/repo/src/handlers/review.ts' })],
      }),
      { repoRoot: '/work/repo' },
    );
    expect(outcome.kind).toBe('admitted');
    expect(outcome.findings[0].affectedBoundary).toBe('src/handlers/review.ts');
  });

  test('a boundary outside the repository is malformed', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding({ affectedBoundary: '/etc/passwd' })] }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('boundary-outside-repository');
  });
});

// ---------------------------------------------------------------------------
// Duplicate ids
// ---------------------------------------------------------------------------

describe('review finding envelope — duplicate finding ids', () => {
  test('two candidates with the same identity tuple mint one id and the set is rejected', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding(), finding()] }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('duplicate-version');
  });

  test('a re-worded duplicate of the same identity tuple is still one lineage, so it is rejected', () => {
    // §2.2 compares the identity tuple wording-insensitively, so punctuation and
    // case changes do not buy a second debate about the same alleged defect.
    const twin = finding({
      violatedContract: 'ACCEPTANCE CRITERION: Normal review produces validated structured findings!',
    });
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding(), twin] }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('duplicate-version');
  });

  test('a duplicate leaves no lineage behind — nothing is partially persisted', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding(), finding()] }));
    expect(outcome.context).toBeUndefined();
    expect(outcome.findings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Malformed, truncated, and duplicated envelopes
// ---------------------------------------------------------------------------

describe('review finding envelope — malformed output', () => {
  test('no markers at all is a legacy review, not an error', () => {
    const outcome = run('## Review\n\nLooks good to me.\n');
    expect(outcome.kind).toBe('legacy');
    expect(outcome.structure.mode).toBe('legacy');
    expect(outcome.structure.zeroChangeValid).toBe(false);
    expect(outcome.structure.legacyFinding).toMatchObject({ kind: 'legacy_free_form', disputable: false });
  });

  test('a truncated envelope (no end marker) is rejected, not silently parsed', () => {
    const outcome = run(`${REVIEW_FINDINGS_MARKER}\n{"version":1,"status":"success"}\n`);
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'unparseable', detail: 'envelope:unterminated-block' });
  });

  test('a payload truncated mid-JSON is rejected', () => {
    const outcome = run(wrap('{"version":1,"status":"findings","findings":[{"severity":"P1"'));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('unparseable');
  });

  test('two envelopes are rejected rather than resolved by last-one-wins', () => {
    const output = `${wrap({ version: 1, status: 'success' })}\n${wrap({ version: 1, status: 'findings', findings: [finding()] })}`;
    const outcome = run(output);
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.detail).toContain('duplicate-block');
  });

  test('a nested opening marker is an unterminated block', () => {
    const outcome = run(
      `${REVIEW_FINDINGS_MARKER}\n${REVIEW_FINDINGS_MARKER}\n{"version":1,"status":"success"}\n${REVIEW_FINDINGS_END_MARKER}\n`,
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.detail).toBe('envelope:unterminated-block');
  });

  test('a payload that is not an object is rejected', () => {
    const outcome = run(wrap('[{"version":1,"status":"success"}]'));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'not-an-object', detail: 'envelope' });
  });

  test('an unknown envelope field is rejected without echoing its name', () => {
    const outcome = run(wrap({ version: 1, status: 'success', autoMerge: true }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toEqual({ reason: 'unknown-field', detail: 'envelope' });
  });

  test('an unsupported envelope schema version is rejected', () => {
    const outcome = run(wrap({ version: 2, status: 'success' }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'invalid-version', detail: 'envelope.version' });
  });

  test('a status carrying the wrong payload is rejected in both directions', () => {
    const successWithFindings = run(wrap({ version: 1, status: 'success', findings: [finding()] }));
    expect(successWithFindings.failure).toMatchObject({ reason: 'unknown-field', detail: 'envelope.findings' });
    const findingsWithNone = run(wrap({ version: 1, status: 'findings', findings: [] }));
    expect(findingsWithNone.failure).toMatchObject({ reason: 'missing-field', detail: 'envelope.findings:0' });
  });

  test('more findings than one review may carry are rejected', () => {
    const many = Array.from({ length: MAX_FINDINGS_PER_REVIEW + 1 }, (_, i) =>
      finding({ affectedBoundary: `src/handlers/review.ts#step${i}` }));
    const outcome = run(wrap({ version: 1, status: 'findings', findings: many }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'too-many-items' });
  });

  test('an envelope larger than the payload bound is rejected before it is parsed', () => {
    const huge = 'x'.repeat(REVIEW_FINDINGS_ENVELOPE_MAX_BYTES + 1);
    const outcome = run(wrap(huge));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('payload-too-large');
  });
});

// ---------------------------------------------------------------------------
// Malicious fence content
// ---------------------------------------------------------------------------

describe('review finding envelope — malicious fence content', () => {
  test('marker text inside a JSON string cannot terminate the block', () => {
    // A JSON string cannot contain a raw newline, so the end marker embedded in a
    // field value is never a whole line and the block runs to its real terminator.
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [
          finding({
            requiredOutcome: `The handler must not stop at ${REVIEW_FINDINGS_END_MARKER} inside a value`,
          }),
        ],
      }),
    );
    expect(outcome.kind).toBe('admitted');
    expect(outcome.findings[0].requiredOutcome).toContain(REVIEW_FINDINGS_END_MARKER);
  });

  test('a fenced fake envelope in the prose is a second block and fails closed', () => {
    const prose = [
      'Here is what a reviewer would emit:',
      '```json',
      REVIEW_FINDINGS_MARKER,
      '{"version":1,"status":"success"}',
      REVIEW_FINDINGS_END_MARKER,
      '```',
    ].join('\n');
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding()] }, { preamble: prose }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.detail).toContain('duplicate-block');
  });

  test('a stray end marker in the prose is chatter, not a block', () => {
    const outcome = run(wrap({ version: 1, status: 'success' }, { preamble: REVIEW_FINDINGS_END_MARKER }));
    expect(outcome.kind).toBe('admitted');
    expect(outcome.structure.mode).toBe('mixed');
  });

  test('a field the runner could not re-encode is rejected as malformed encoding', () => {
    // A lone surrogate: legal to escape inside JSON, but it does not survive a
    // UTF-8 round trip, so the stable serialization §10.2 depends on would not be
    // stable. Built from a code point rather than pasted, so no undisplayable
    // byte appears in this source file.
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ requiredOutcome: `broken ${String.fromCharCode(0xd800)} pair` })],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('malformed-encoding');
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe('review finding envelope — evidence', () => {
  test('more evidence references than the record bound is rejected', () => {
    const refs = Array.from({ length: 11 }, (_, i) => ({
      kind: 'file', path: 'src/handlers/review.ts', startLine: i + 1, endLine: i + 2,
    }));
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding({ evidenceRefs: refs })] }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('too-many-items');
  });

  test('an oversized issue quote is rejected', () => {
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ evidenceRefs: [{ kind: 'issue_quote', quote: 'q'.repeat(1001) }] })],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('field-too-long');
  });

  test('a finding with no evidence at all is rejected', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding({ evidenceRefs: [] })] }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('missing-field');
  });

  test('an untracked file reference does not resolve and the finding is rejected', () => {
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ evidenceRefs: [{ kind: 'file', path: 'src/nowhere.ts', startLine: 1, endLine: 2 }] })],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('unresolvable-evidence');
  });

  test('the resolver admits tracked paths and refuses everything else', () => {
    expect(RESOLVER({ kind: 'file', path: 'src/handlers/review.ts', startLine: 1, endLine: 2 })).toBe(true);
    expect(RESOLVER({ kind: 'file', path: 'src/absent.ts', startLine: 1, endLine: 2 })).toBe(false);
    expect(RESOLVER({ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: '2.1' })).toBe(true);
    expect(RESOLVER({ kind: 'doc_section', path: 'docs/absent.md', section: '2.1' })).toBe(false);
  });

  test('a line range past the end of a tracked file does not resolve', () => {
    // The path is real; the lines are not. §3.3 asks whether the REFERENCE
    // resolves, so a tracked path is only half the answer — admitting this would
    // open a blocking lineage on a range nobody could read.
    expect(RESOLVER({ kind: 'file', path: 'src/handlers/review.ts', startLine: 39, endLine: 40 })).toBe(true);
    expect(RESOLVER({ kind: 'file', path: 'src/handlers/review.ts', startLine: 40, endLine: 41 })).toBe(false);
    expect(RESOLVER({ kind: 'file', path: 'src/handlers/review.ts', startLine: 900, endLine: 950 })).toBe(false);
  });

  test('an inverted or zero-based range names no lines and does not resolve', () => {
    expect(RESOLVER({ kind: 'file', path: 'src/handlers/review.ts', startLine: 20, endLine: 10 })).toBe(false);
    expect(RESOLVER({ kind: 'file', path: 'src/handlers/review.ts', startLine: 0, endLine: 5 })).toBe(false);
  });

  test('a finding citing lines beyond a tracked file is rejected whole', () => {
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [
          finding({
            evidenceRefs: [{ kind: 'file', path: 'src/handlers/review.ts', startLine: 500, endLine: 520 }],
          }),
        ],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('unresolvable-evidence');
  });

  test('a doc_section resolves only against a heading the document carries', () => {
    expect(
      RESOLVER({ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: '§10.1 Bounded persistence' }),
    ).toBe(true);
    expect(RESOLVER({ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: 'FINDING SCHEMA' })).toBe(
      true,
    );
    // Present in the prose, but not as a heading — and not a section at all.
    expect(RESOLVER({ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: 'A finding is' })).toBe(
      false,
    );
    expect(RESOLVER({ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: '§99 Arbiter' })).toBe(
      false,
    );
    expect(RESOLVER({ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: '   ' })).toBe(false);
  });

  test('a finding citing an invented document section is rejected whole', () => {
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [
          finding({
            evidenceRefs: [
              { kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: '§42 Fabricated section' },
            ],
          }),
        ],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('unresolvable-evidence');
  });

  test('content the runner cannot read leaves file and doc references unresolved', () => {
    // No reader at all, a reader that declines (oversized, unreadable), and binary
    // content are the same admission: unverified, therefore unresolved.
    const noReader = createReviewEvidenceResolver({ trackedFiles: TRACKED });
    const declining = createReviewEvidenceResolver({ trackedFiles: TRACKED, readTrackedFile: () => undefined });
    const binary = createReviewEvidenceResolver({
      trackedFiles: TRACKED,
      readTrackedFile: () => `${String.fromCharCode(0)}${numberedLines(40)}`,
    });
    for (const resolver of [noReader, declining, binary]) {
      expect(resolver({ kind: 'file', path: 'src/handlers/review.ts', startLine: 1, endLine: 2 })).toBe(false);
      expect(resolver({ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: '2.1' })).toBe(false);
    }
  });

  test('repeated resolution of the same path reads it once and answers identically', () => {
    const reads = [];
    const resolver = createReviewEvidenceResolver({
      trackedFiles: TRACKED,
      readTrackedFile: (path) => {
        reads.push(path);
        return TRACKED_CONTENT.get(path);
      },
    });
    const ref = { kind: 'file', path: 'src/handlers/review.ts', startLine: 1, endLine: 2 };
    expect([resolver(ref), resolver(ref), resolver(ref)]).toEqual([true, true, true]);
    expect(reads).toEqual(['src/handlers/review.ts']);
  });

  test('an issue quote resolves against the issue body when one is supplied', () => {
    const resolver = createReviewEvidenceResolver({
      trackedFiles: TRACKED,
      issueBody: 'The runner  MUST   emit a closed envelope.',
    });
    expect(resolver({ kind: 'issue_quote', quote: 'must emit a closed envelope' })).toBe(true);
    expect(resolver({ kind: 'issue_quote', quote: 'must delete the repository' })).toBe(false);
  });

  test('an issue quote does not resolve when this run captured no body to check it against', () => {
    // §3.3 asks whether the reference RESOLVES, and "there was nothing to compare
    // it to" is not a yes. Admitting it would open a lineage on a quote no run
    // ever matched against anything.
    expect(RESOLVER({ kind: 'issue_quote', quote: 'anything at all' })).toBe(false);
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ evidenceRefs: [{ kind: 'issue_quote', quote: 'anything at all' }] })],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('unresolvable-evidence');
  });

  test('a test reference is never resolvable read-only, so the finding is rejected', () => {
    // Deciding whether a named test exists means running or parsing the suite —
    // #842's pipeline resolver. Until then an invented test name is
    // indistinguishable from a real one, so it is refused rather than believed.
    expect(RESOLVER({ kind: 'test', name: 'review admits a structured envelope' })).toBe(false);
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ evidenceRefs: [{ kind: 'test', name: 'a test nobody wrote' }] })],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({
      reason: 'unresolvable-evidence',
      detail: 'envelope.findings[0].evidenceRefs[0]',
    });
  });

  test('one unverifiable reference rejects the whole finding, not just that reference', () => {
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [
          finding({
            evidenceRefs: [
              { kind: 'file', path: 'src/handlers/review.ts', startLine: 1, endLine: 2 },
              { kind: 'test', name: 'a test nobody wrote' },
            ],
          }),
        ],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ detail: 'envelope.findings[0].evidenceRefs[1]' });
  });

  test('the prompt offers exactly the reference forms this run can verify', () => {
    // Prompt and resolver in lockstep: a reviewer is never asked for evidence
    // that admission would refuse.
    const withBody = reviewFindingsInstructions({ issueBodyAvailable: true });
    expect(withBody).toContain('"kind": "file"');
    expect(withBody).toContain('"kind": "doc_section"');
    expect(withBody).toContain('"kind": "issue_quote"');
    expect(withBody).not.toContain('"kind": "test"');

    const withoutBody = reviewFindingsInstructions();
    expect(withoutBody).toContain('"kind": "file"');
    expect(withoutBody).not.toContain('"kind": "issue_quote"');
    expect(withoutBody).not.toContain('"kind": "test"');
    expect(reviewResolvableEvidenceKinds({ issueBodyAvailable: false })).toEqual(['file', 'doc_section']);
    expect(reviewResolvableEvidenceKinds({ issueBodyAvailable: true })).toEqual([
      'file', 'doc_section', 'issue_quote',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The §10.2 artifact and the two size bounds
// ---------------------------------------------------------------------------

describe('review finding envelope — bounded artifact', () => {
  test('an admitted envelope carries its serialized full records', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding(), otherFinding()] }));
    expect(outcome.kind).toBe('admitted');
    const artifact = JSON.parse(outcome.findingsArtifact);
    expect(artifact.findings).toHaveLength(2);
    expect(artifact.findings[0].lineageId).toBe(outcome.findings[0].lineageId);
    expect(artifact.findings[0].reviewerMeta).toEqual(META);
    // Deterministic: the same output serializes to the same bytes.
    expect(run(wrap({ version: 1, status: 'findings', findings: [finding(), otherFinding()] })).findingsArtifact)
      .toBe(outcome.findingsArtifact);
  });

  test('the accepted envelope budget reserves room for what admission adds', () => {
    // The envelope is agent-authored; the artifact is that same content PLUS the
    // runner-owned fields. Were the two budgets equal, an envelope accepted just
    // under the limit would mint lineages whose records could not be written.
    expect(
      REVIEW_FINDINGS_ENVELOPE_MAX_BYTES + MAX_FINDINGS_PER_REVIEW * REVIEW_FINDING_ADMISSION_OVERHEAD_BYTES,
    ).toBeLessThanOrEqual(REVIEW_DISPUTE_RECORD_MAX_BYTES);
  });

  test('a full review at the very edge of the envelope budget still serializes', () => {
    // The worst real case: MAX_FINDINGS_PER_REVIEW distinct findings padded until
    // the payload is just under the accepted bound. Admission must produce an
    // artifact — never a persisted lineage with no records behind it.
    const build = (fill) =>
      Array.from({ length: MAX_FINDINGS_PER_REVIEW }, (_, i) =>
        finding({
          violatedContract: `Acceptance criterion ${i}: ${'c'.repeat(fill)}`,
          affectedBoundary: `src/handlers/review.ts#step${i}`,
          preconditions: 'p'.repeat(fill),
          requiredOutcome: 'r'.repeat(fill),
        }));
    const envelopeOf = (fill) => ({ version: 1, status: 'findings', findings: build(fill) });
    const sizeOf = (fill) => Buffer.byteLength(JSON.stringify(envelopeOf(fill)), 'utf8');
    // Three padded fields per finding grow the payload by 3 bytes per finding per
    // added character; solve for the largest fill that still fits, then confirm.
    const base = sizeOf(1);
    let fill = 1 + Math.floor((REVIEW_FINDINGS_ENVELOPE_MAX_BYTES - base) / (3 * MAX_FINDINGS_PER_REVIEW));
    while (sizeOf(fill) > REVIEW_FINDINGS_ENVELOPE_MAX_BYTES) fill--;
    // The budget, not a per-field bound, is what this case is exercising.
    expect(fill).toBeLessThan(MAX_FINDING_TEXT_CHARS - 40);
    const payload = JSON.stringify(envelopeOf(fill));
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    expect(payloadBytes).toBeGreaterThan(REVIEW_FINDINGS_ENVELOPE_MAX_BYTES - 3 * MAX_FINDINGS_PER_REVIEW);

    const outcome = run(wrap(payload));
    expect(outcome.kind).toBe('admitted');
    expect(outcome.findings).toHaveLength(MAX_FINDINGS_PER_REVIEW);
    const artifactBytes = Buffer.byteLength(outcome.findingsArtifact, 'utf8');
    // The artifact really is bigger than the envelope — that growth is the whole
    // reason the two budgets differ — and it still fits the record bound.
    expect(artifactBytes).toBeGreaterThan(payloadBytes);
    expect(artifactBytes).toBeLessThanOrEqual(REVIEW_DISPUTE_RECORD_MAX_BYTES);
    expect(JSON.parse(outcome.findingsArtifact).findings).toHaveLength(MAX_FINDINGS_PER_REVIEW);
  });

  test('an envelope one byte over the accepted budget is refused before anything is minted', () => {
    const outcome = run(wrap('x'.repeat(REVIEW_FINDINGS_ENVELOPE_MAX_BYTES + 1)));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('payload-too-large');
    expect(outcome.context).toBeUndefined();
    expect(outcome.findingsArtifact).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invalid initial lineage data
// ---------------------------------------------------------------------------

describe('review finding envelope — invalid initial lineage data', () => {
  test('an initial finding at version 2 is rejected', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding({ version: 2 })] }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('invalid-version');
  });

  test('an initial finding at version 0 is rejected', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding({ version: 0 })] }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure.reason).toBe('invalid-type');
  });

  test('a predecessor/revision structure on an initial finding is an unknown field', () => {
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ predecessorVersion: 1, revisionKind: 'restated' })],
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'unknown-field' });
  });

  test('an echoed lineageId names no lineage this task has on file and is rejected', () => {
    // §2.2: agents only ECHO ids. An id no persisted lineage carries cannot
    // attach, and minting one from agent output is what the contract forbids.
    const outcome = run(
      wrap({ version: 1, status: 'findings', findings: [finding({ lineageId: 'ln-0123456789ab' })] }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'unknown-lineage', detail: 'envelope.findings[0].lineageId' });
  });

  test('a lineage id that could not have been minted never reaches the persisted block', () => {
    const admitted = admitReviewFindings({
      candidates: [finding()],
      reviewerMeta: META,
      humanGate: false,
      resolveEvidenceRef: RESOLVER,
    });
    expect(admitted.ok).toBe(true);
    const broken = buildInitialLineageContext([{ ...admitted.value.findings[0], lineageId: '../escape' }], 'structured');
    expect(broken.ok).toBe(false);
    expect(broken.failure.reason).toBe('invalid-state-record');
  });
});

// ---------------------------------------------------------------------------
// Legacy and mixed reviewer output (§13)
// ---------------------------------------------------------------------------

describe('review finding envelope — legacy compatibility', () => {
  test('prose alongside a valid envelope is a mixed review that fails closed on zero change', () => {
    const outcome = run(wrap({ version: 1, status: 'success' }, { preamble: 'Also: the naming here is odd.' }));
    expect(outcome.kind).toBe('admitted');
    expect(outcome.structure.mode).toBe('mixed');
    expect(outcome.structure.zeroChangeValid).toBe(false);
    expect(outcome.context.reviewStructure).toBe('mixed');
  });

  test('an envelope alone is a fully structured review', () => {
    const outcome = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    expect(outcome.structure.mode).toBe('structured');
    expect(outcome.context.reviewStructure).toBe('structured');
  });

  test('a legacy review keeps its prose as the non-disputable legacy finding', () => {
    const outcome = run('[P1] Missing null check in src/handlers/review.ts');
    expect(outcome.kind).toBe('legacy');
    expect(outcome.structure.legacyFinding.feedback).toContain('[P1]');
    expect(outcome.structure.legacyFinding.disputable).toBe(false);
  });

  test('a review agent whose output format the runner does not author is explicitly unsupported', () => {
    expect(structuredFindingsSupport('codex')).toEqual({
      supported: false,
      reason: 'prompt-not-agent-authored',
    });
    expect([...STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS]).toEqual(['codex']);
    expect(structuredFindingsSupport('claude')).toEqual({ supported: true });
    expect(structuredFindingsSupport('gemini')).toEqual({ supported: true });
  });
});

// ---------------------------------------------------------------------------
// Extraction and prompt contract
// ---------------------------------------------------------------------------

describe('review finding envelope — extraction and prompt', () => {
  test('extraction returns the residual prose with the block removed', () => {
    const extracted = extractReviewFindingsEnvelope(
      wrap({ version: 1, status: 'success' }, { preamble: 'before', trailer: 'after' }),
    );
    expect(extracted.kind).toBe('payload');
    expect(extracted.payload).toBe('{"version":1,"status":"success"}');
    expect(extracted.residual).toContain('before');
    expect(extracted.residual).toContain('after');
    expect(extracted.residual).not.toContain(REVIEW_FINDINGS_MARKER);
  });

  test('CRLF markers are recognized', () => {
    const extracted = extractReviewFindingsEnvelope(
      `${REVIEW_FINDINGS_MARKER}\r\n{"version":1,"status":"success"}\r\n${REVIEW_FINDINGS_END_MARKER}\r\n`,
    );
    expect(extracted.kind).toBe('payload');
  });

  test('parse rejects a payload independently of extraction', () => {
    const parsed = parseReviewFindingsEnvelope('{"version":1}');
    expect(parsed.ok).toBe(false);
    expect(parsed.failure).toMatchObject({ reason: 'missing-field', detail: 'envelope.status' });
  });

  test('the prompt contract names the markers, every status, and every blocked reason', () => {
    const text = reviewFindingsInstructions();
    expect(text).toContain(REVIEW_FINDINGS_MARKER);
    expect(text).toContain(REVIEW_FINDINGS_END_MARKER);
    for (const status of REVIEW_ENVELOPE_STATUSES) expect(text).toContain(`\`${status}\``);
    for (const reason of REVIEW_BLOCKED_REASONS) expect(text).toContain(reason);
    expect(text).toContain('runner-owned');
  });

  test('a first review is told not to set a lineage id at all', () => {
    const text = reviewFindingsInstructions();
    expect(text).toContain('Do not set `lineageId`, `humanGate`, or `reviewerMeta`');
    expect(text).not.toContain('still open');
  });

  test('the prompt lists the open lineages a re-raise may echo', () => {
    // The reviewer is shown exactly the ids admission will accept: an id it was
    // never shown is rejected, so inventing one has to be ruled out in the brief
    // rather than discovered at admission (issue #841 review, P1).
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding(), otherFinding()] }));
    const live = openLineagePrompts(first.context);
    const text = reviewFindingsInstructions({ issueBodyAvailable: true, liveLineages: live });

    expect(live).toHaveLength(2);
    for (const lineage of live) {
      expect(text).toContain(`\`${lineage.lineageId}\` (version 1) — ${lineage.severity} at \`${lineage.affectedBoundary}\``);
    }
    expect(text).toContain('still open');
    // `lineageId` is no longer blanket-forbidden, but the other two stay so.
    expect(text).toContain('Do not set `humanGate` or `reviewerMeta`');
    expect(text).not.toContain('Do not set `lineageId`, `humanGate`, or `reviewerMeta`');
    // Only §11-publishable literals reach a later reviewer — never the prose an
    // earlier one wrote.
    expect(text).not.toContain(finding().failureScenario);
    expect(text).not.toContain(finding().violatedContract);
  });

  test('a terminal lineage is never offered as a re-raise target', () => {
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding(), otherFinding()] }));
    const [open, closed] = Object.keys(first.context.lineages);
    const context = {
      ...first.context,
      lineages: {
        [open]: first.context.lineages[open],
        [closed]: { ...first.context.lineages[closed], state: 'resolved_fixed', outcome: 'resolved_fixed' },
      },
    };
    expect(openLineagePrompts(context).map((l) => l.lineageId)).toEqual([open]);
  });
});

// ---------------------------------------------------------------------------
// The human-gate stamp
// ---------------------------------------------------------------------------

describe('review finding envelope — human gate stamp', () => {
  test.each(['open', 'applying', 'apply_failed', 'held'])('a live gate (%s) stamps true', (state) => {
    expect(resolveFindingHumanGate({ humanGate: { state } })).toBe(true);
  });

  test('a resolved gate is a closed audit record and stamps nothing', () => {
    expect(resolveFindingHumanGate({ humanGate: { state: 'resolved' } })).toBe(false);
  });

  test('an absent or malformed gate record stamps false', () => {
    expect(resolveFindingHumanGate({})).toBe(false);
    expect(resolveFindingHumanGate(undefined)).toBe(false);
    expect(resolveFindingHumanGate({ humanGate: 'yes' })).toBe(false);
    expect(resolveFindingHumanGate({ humanGate: ['open'] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The state-machine boundary (#840 is not reimplemented here)
// ---------------------------------------------------------------------------

describe('review finding envelope — state-machine boundary', () => {
  const OUTPUT = wrap({ version: 1, status: 'findings', findings: [finding(), otherFinding()] });

  test('every admitted lineage is open at version 1 with zero counters and no outcome', () => {
    const outcome = run(OUTPUT);
    for (const lineage of Object.values(outcome.context.lineages)) {
      expect(lineage.state).toBe('open');
      expect(lineage.version).toBe(1);
      expect(lineage.counters).toEqual(ZERO_LINEAGE_COUNTERS);
      expect(lineage.rebuttedVersions).toEqual([]);
      expect(lineage.outcome).toBeUndefined();
      expect(lineage.supersedes).toBeUndefined();
      expect(lineage.reopenRequested).toBeUndefined();
    }
  });

  test('no run-level transition flag is ever invented', () => {
    // `pendingReReview` and `resolvedWithoutChanges` are §7.1 aggregation
    // outcomes: they describe what a RUN did to the lineages, which is #840's
    // decision, not an admission fact. With nothing on file there is nothing to
    // carry, so neither key exists.
    const outcome = run(OUTPUT);
    expect(Object.prototype.hasOwnProperty.call(outcome.context, 'pendingReReview')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(outcome.context, 'resolvedWithoutChanges')).toBe(false);
  });

  test('a prior pendingReReview survives the block this run writes', () => {
    // The flag records that some earlier fix's diff still owes an ordinary
    // review. The new block REPLACES the stored one, so dropping it here would
    // let #840's aggregation read that diff as already reviewed and promote the
    // task early. Carried, never cleared: clearing it is a §7 transition.
    const prior = { version: 1, reviewStructure: 'structured', lineages: {}, pendingReReview: true };

    const outcome = run(OUTPUT, { priorContext: prior });

    expect(outcome.kind).toBe('admitted');
    expect(outcome.context.pendingReReview).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(outcome.context, 'resolvedWithoutChanges')).toBe(false);
  });

  test('a prior resolvedWithoutChanges survives onto a fully structured block', () => {
    const prior = {
      version: 1,
      reviewStructure: 'structured',
      lineages: {},
      resolvedWithoutChanges: true,
    };

    const outcome = run(OUTPUT, { priorContext: prior });

    expect(outcome.kind).toBe('admitted');
    expect(outcome.structure.mode).toBe('structured');
    expect(outcome.context.resolvedWithoutChanges).toBe(true);
  });

  test('a prior resolvedWithoutChanges is dropped, not rejected, when §13 denies this block', () => {
    // §13 lets only a fully structured review claim a no-diff-required run, so a
    // mixed block cannot hold the flag at all. Refusing the envelope over a
    // PREVIOUS run's flag would trap the task: every later review carrying prose
    // would be refused the same way. Dropping it leaves the mixed run's own
    // prose blocking — the conservative direction — while `pendingReReview`,
    // which has no such restriction, still carries.
    const prior = {
      version: 1,
      reviewStructure: 'structured',
      lineages: {},
      resolvedWithoutChanges: true,
    };

    const mixed = wrap(
      { version: 1, status: 'findings', findings: [finding(), otherFinding()] },
      { preamble: 'Also: the naming here is odd.' },
    );

    const outcome = run(mixed, { priorContext: prior });

    expect(outcome.kind).toBe('admitted');
    expect(outcome.structure.mode).toBe('mixed');
    expect(Object.prototype.hasOwnProperty.call(outcome.context, 'resolvedWithoutChanges')).toBe(false);
  });

  test('carrying the run-level flags stays deterministic across repeated parses', () => {
    const prior = { version: 1, reviewStructure: 'structured', lineages: {}, pendingReReview: true };
    const first = run(OUTPUT, { priorContext: prior });
    const second = run(OUTPUT, { priorContext: first.context });
    expect(stableStringify(second.context)).toBe(stableStringify(first.context));
  });

  test('with no block on file, nothing can accumulate across runs', () => {
    // The same review output processed twice — as a re-review would — yields the
    // SAME lineage ids and the SAME zeroed counters: an id comes from the
    // finding's own §2.2 identity tuple rather than from a sequence, so no cap is
    // consumed, advanced, or checked by processing a review again.
    const first = run(OUTPUT);
    const second = run(OUTPUT);
    expect(Object.keys(second.context.lineages)).toEqual(Object.keys(first.context.lineages));
    expect(stableStringify(second.context)).toBe(stableStringify(first.context));
  });

  test('a prior lineage is carried into the new block verbatim, never advanced', () => {
    // The block a review writes replaces the stored one, so what an earlier
    // review persisted has to be carried forward — but only copied. Deciding
    // what a re-emitted finding does to an existing debate is #840's.
    const first = run(OUTPUT);
    const [id, other] = Object.keys(first.context.lineages);
    const persisted = {
      ...first.context.lineages[id],
      counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1 },
      rebuttedVersions: [1],
    };
    const prior = { version: 1, reviewStructure: 'structured', lineages: { [id]: persisted } };

    const second = run(OUTPUT, { priorContext: prior });

    expect(second.kind).toBe('admitted');
    expect(second.retainedLineages).toBe(1);
    // Re-emitting the same finding attaches it to the lineage already on file —
    // no id is minted for it — and that record's counters are neither reset nor
    // incremented. Attaching is recognizing which debate the re-raise belongs
    // to; it is not a decision about the debate.
    expect(second.attachments).toEqual([
      { lineageId: id, version: 1, severity: persisted.severity, path: 'envelope.findings[0]' },
    ]);
    expect(Object.keys(second.context.lineages).sort()).toEqual([id, other].sort());
    expect(second.context.lineages[id]).toEqual(persisted);
    // The finding this run did not see before still opens at version 1.
    expect(second.context.lineages[other]).toMatchObject({ state: 'open', version: 1 });
  });

  test('an invalid prior block is refused rather than silently replaced', () => {
    const outcome = run(OUTPUT, { priorContext: { version: 1, reviewStructure: 'structured', lineages: { bogus: {} } } });
    expect(outcome.kind).toBe('rejected');
  });

  test('a re-raise attaches without touching any counter, cap, or transition flag', () => {
    // The seam this Issue DOES own: recognizing that a candidate belongs to a
    // lineage already on file (§2.2). What it must not do is act on that lineage
    // — the persisted record comes back byte-identical, counters included, and
    // no §6.1 cap is consumed by re-raising the same defect over and over.
    const first = run(OUTPUT);
    const [id] = Object.keys(first.context.lineages);
    const persisted = {
      ...first.context.lineages[id],
      counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1, arbitrationPasses: 1 },
      rebuttedVersions: [1],
    };
    const prior = { version: 1, reviewStructure: 'structured', lineages: { [id]: persisted } };

    const reRaise = wrap({
      version: 1,
      status: 'findings',
      findings: [finding({ lineageId: id })],
    });
    const again = run(reRaise, { priorContext: prior });
    const third = run(reRaise, { priorContext: again.context });

    for (const outcome of [again, third]) {
      expect(outcome.kind).toBe('admitted');
      // Nothing new is written: the re-raise attaches to the record on file.
      expect(outcome.findings).toHaveLength(0);
      expect(outcome.attachments).toEqual([
        { lineageId: id, version: 1, severity: persisted.severity, path: 'envelope.findings[0]' },
      ]);
      expect(Object.keys(outcome.context.lineages)).toEqual([id]);
      expect(outcome.context.lineages[id]).toEqual(persisted);
    }
    expect(stableStringify(third.context)).toBe(stableStringify(again.context));
  });

  test('an unlabelled structural duplicate attaches too, rather than opening a second debate', () => {
    // §2.2 is about the identity tuple, not about whether the reviewer happened
    // to echo an id. Re-raising the same defect verbatim under a re-review must
    // land on the live lineage either way.
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    const [id] = Object.keys(first.context.lineages);

    const second = run(wrap({ version: 1, status: 'findings', findings: [finding()] }), {
      priorContext: first.context,
    });

    expect(second.kind).toBe('admitted');
    expect(second.findings).toHaveLength(0);
    expect(second.attachments.map((a) => a.lineageId)).toEqual([id]);
    expect(Object.keys(second.context.lineages)).toEqual([id]);
  });

  test('an id echoed from outside the lineages on file is still rejected', () => {
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    const outcome = run(
      wrap({ version: 1, status: 'findings', findings: [finding({ lineageId: 'ln-0123456789ab' })] }),
      { priorContext: first.context },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'unknown-lineage', detail: 'envelope.findings[0].lineageId' });
  });

  test('two candidates cannot attach to the same lineage in one envelope', () => {
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    const [id] = Object.keys(first.context.lineages);
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ lineageId: id }), otherFinding({ lineageId: id })],
      }),
      { priorContext: first.context },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'duplicate-lineage', detail: 'envelope.findings[1].lineageId' });
  });

  test('an echo naming a version other than the lineage current one is stale', () => {
    // §2.3: an attach lands on the immutable current version. A reviewer that
    // echoes an id but names a version the lineage has moved past is referring to
    // a record that is no longer the one on file.
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    const [id] = Object.keys(first.context.lineages);
    const advanced = {
      version: 1,
      reviewStructure: 'structured',
      lineages: { [id]: { ...first.context.lineages[id], version: 2 } },
    };
    const outcome = run(
      wrap({ version: 1, status: 'findings', findings: [finding({ lineageId: id })] }),
      { priorContext: advanced },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({ reason: 'stale-version', detail: 'envelope.findings[0].version:1' });
  });

  test('a re-raise citing evidence that does not resolve is refused, not attached', () => {
    // §3.3: an attachment is blocking output — it is what routes this diff back
    // to `needs_fix` — so its references must resolve exactly as a fresh
    // finding's do. Without the check, echoing a known id would be the one way
    // to block a diff on evidence nobody could read.
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    const [id] = Object.keys(first.context.lineages);
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [
          finding({
            lineageId: id,
            evidenceRefs: [{ kind: 'file', path: 'src/handlers/invented.ts', startLine: 1, endLine: 2 }],
          }),
        ],
      }),
      { priorContext: first.context },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({
      reason: 'unresolvable-evidence',
      detail: 'envelope.findings[0].evidenceRefs[0]',
    });
    // Fail closed: no attachment, no block, nothing half-written.
    expect(outcome.attachments).toBeUndefined();
    expect(outcome.context).toBeUndefined();
  });

  test('an unlabelled duplicate cannot attach on a citation past the end of a real file', () => {
    // The same rule where the reviewer echoed nothing: the identity tuple is what
    // attaches (§2.2), and evidence is not part of it, so a structural duplicate
    // reaches the attach path with whatever references it likes.
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    const outcome = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [
          finding({
            evidenceRefs: [{ kind: 'file', path: 'src/handlers/review.ts', startLine: 1, endLine: 4000 }],
          }),
        ],
      }),
      { priorContext: first.context },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.failure).toMatchObject({
      reason: 'unresolvable-evidence',
      detail: 'envelope.findings[0].evidenceRefs[0]',
    });
  });

  test('a re-raise alongside a genuinely new finding admits only the new one', () => {
    const first = run(wrap({ version: 1, status: 'findings', findings: [finding()] }));
    const [id] = Object.keys(first.context.lineages);
    const second = run(
      wrap({
        version: 1,
        status: 'findings',
        findings: [finding({ lineageId: id }), otherFinding()],
      }),
      { priorContext: first.context },
    );
    expect(second.kind).toBe('admitted');
    expect(second.findings).toHaveLength(1);
    expect(second.attachments.map((a) => a.lineageId)).toEqual([id]);
    // The §10.2 artifact records both halves: the version this run wrote, and the
    // lineage it attached to (whose own record is in the earlier run's directory).
    const artifact = JSON.parse(second.findingsArtifact);
    expect(artifact.findings).toHaveLength(1);
    expect(artifact.attachments.map((a) => a.lineageId)).toEqual([id]);
    expect(Object.keys(second.context.lineages).sort()).toEqual(
      [id, second.findings[0].lineageId].sort(),
    );
  });

  test('the admission seam takes lineages, never a transition to apply to them', () => {
    // A structural guard: `admitReviewFindings` accepts candidates, run metadata,
    // a resolver, and the lineages already on file — and nothing that could carry
    // a state, counter, or cap decision into it. If a future change widens that,
    // this test fails and the #840 boundary is re-examined deliberately.
    expect(admitReviewFindings.length).toBe(1);
    const admitted = admitReviewFindings({
      candidates: [finding()],
      reviewerMeta: META,
      humanGate: false,
      resolveEvidenceRef: RESOLVER,
      priorLineages: {},
    });
    expect(admitted.ok).toBe(true);
    expect(admitted.value.attachments).toEqual([]);
    expect(Object.keys(admitted.value.findings[0]).sort()).toEqual(
      [
        'affectedBoundary',
        'evidenceRefs',
        'failureScenario',
        'humanGate',
        'lineageId',
        'preconditions',
        'requiredOutcome',
        'reviewerMeta',
        'severity',
        'version',
        'violatedContract',
      ].sort(),
    );
  });
});
