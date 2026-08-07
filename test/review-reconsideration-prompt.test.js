/**
 * Unit tests for the issue #838 reviewer-reconsideration prompt
 * (src/core/review-reconsideration-prompt.ts).
 *
 * Two properties are pinned here, because everything downstream depends on
 * them: the bundle is CLOSED (§8.2 — only the Issue contract, the finding, the
 * rebuttal, the resolved excerpts, the diff, and the test evidence reach the
 * reviewer), and the rendering is DETERMINISTIC (same inputs, same bytes), which
 * is what makes a retry of one pending dispute identifiable rather than merely
 * plausible.
 */
import {
  MAX_RECONSIDERATION_DIFF_CHARS,
  MAX_RECONSIDERATION_EXCERPT_CHARS,
  MAX_RECONSIDERATION_ISSUE_CONTRACT_CHARS,
  MAX_RECONSIDERATION_TEST_EVIDENCE,
  buildReconsiderationPromptSection,
  reconsiderationBundleDigest,
  reconsiderationRunKey,
} from '../dist/core/review-reconsideration-prompt.js';
import { MAX_RATIONALE_CHARS, REVISION_KINDS } from '../dist/core/review-dispute.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';

function findingBody(overrides = {}) {
  return {
    severity: 'P1',
    violatedContract: 'The handler must reject a null session before dereferencing it.',
    preconditions: 'A request arrives with no session cookie.',
    failureScenario: 'The handler dereferences session.userId and throws.',
    affectedBoundary: 'src/auth/handler.ts',
    requiredOutcome: 'A null session is rejected with 401 before any dereference.',
    evidenceRefs: [{ kind: 'file', path: 'src/auth/handler.ts', startLine: 30, endLine: 36 }],
    ...overrides,
  };
}

function disputeRecord(overrides = {}) {
  return {
    challenged: { lineageId: LINEAGE, version: 1 },
    rebuttalReason: 'false_premise',
    argument: 'The middleware rejects a null session before the handler runs.',
    evidenceRefs: [{ kind: 'file', path: 'src/auth/middleware.ts', startLine: 10, endLine: 14 }],
    whyNoChange: 'A second guard would duplicate the existing one.',
    ...overrides,
  };
}

function promptInput(overrides = {}) {
  return {
    target: {
      lineageId: LINEAGE,
      version: 1,
      severity: 'P1',
      affectedBoundary: 'src/auth/handler.ts',
      humanGate: false,
      body: findingBody(),
    },
    dispute: disputeRecord(),
    issueContract: 'The endpoint must never return 500 for an unauthenticated request.',
    evidence: [
      {
        ref: { kind: 'file', path: 'src/auth/handler.ts', startLine: 30, endLine: 31 },
        citedBy: 'finding',
        excerpt: '30: const user = session.userId;\n31: return user;',
      },
      {
        ref: { kind: 'file', path: 'src/auth/middleware.ts', startLine: 10, endLine: 10 },
        citedBy: 'rebuttal',
        excerpt: '10: if (!session) return unauthorized();',
      },
    ],
    testEvidence: ['test/auth.test.js > rejects a null session'],
    resolvableEvidenceKinds: ['file', 'doc_section', 'issue_quote'],
    ...overrides,
  };
}

function render(section) {
  return [...section.header, ...section.dataBlock, ...section.footer].join('\n');
}

describe('reconsideration prompt: the answer contract', () => {
  test('states the three outcomes, the single-object envelope, and the pinned lineage/version', () => {
    const text = render(buildReconsiderationPromptSection(promptInput()));
    for (const token of ['`withdraw`', '`uphold`', '`revise`']) {
      expect(text).toContain(token);
    }
    expect(text).toContain('SINGLE fenced ```json code block containing ONE JSON OBJECT');
    expect(text).toContain(`MUST name \`lineageId\` \`${LINEAGE}\` at \`version\` 1`);
    expect(text).toContain(`at most ${MAX_RATIONALE_CHARS} characters`);
    // Issue #838 review, P2: the parser ends the record only on a standalone
    // closing fence, so that a rationale may quote one. Say so in the prompt.
    expect(text).toContain('Close the code block with a fence on a line of its own');
  });

  test('requires the full §4.2 revision shape for a revise', () => {
    const text = render(buildReconsiderationPromptSection(promptInput()));
    expect(text).toContain('"predecessorVersion": 1');
    expect(text).toContain('"changedFields"');
    expect(text).toContain('"revisionKind"');
    expect(text).toContain('"materialityClaim"');
    // The successor sits at predecessorVersion + 1 (§4.2).
    expect(text).toContain('"version": 2');
    for (const kind of REVISION_KINDS) {
      expect(text).toContain(kind);
    }
  });

  test('forbids new findings and any repository or GitHub side effect', () => {
    const text = render(buildReconsiderationPromptSection(promptInput()));
    expect(text).toContain('READ-ONLY turn');
    expect(text).toContain('may NOT raise a new finding here');
    expect(text).toContain('Do not attempt to edit files, run tests, open a pull request, or comment on GitHub.');
  });

  test('names only the evidence kinds this runner can resolve', () => {
    const withoutIssueBody = buildReconsiderationPromptSection(
      promptInput({ resolvableEvidenceKinds: ['file', 'doc_section'] }),
    );
    const text = render(withoutIssueBody);
    expect(text).toContain('`file`, `doc_section`');
    expect(text).not.toContain('`file`, `doc_section`, `issue_quote`');
  });
});

describe('reconsideration prompt: the bundle is closed', () => {
  test('carries exactly the six §8.2 sections, and nothing else', () => {
    const section = buildReconsiderationPromptSection(promptInput({ diffExcerpt: '@@ -30,2 +30,2 @@' }));
    const headings = section.dataBlock.filter((line) => line.startsWith('### '));
    expect(headings).toEqual([
      '### Issue contract (authoritative)',
      `### Disputed finding \`${LINEAGE}\` — version 1`,
      '### Implementation rebuttal',
      '### Referenced code and document excerpts',
      '### Diff excerpt at the affected boundary',
      '### Test evidence',
    ]);
  });

  test('omits the diff section entirely when no diff excerpt was supplied', () => {
    const section = buildReconsiderationPromptSection(promptInput());
    expect(section.dataBlock.join('\n')).not.toContain('Diff excerpt at the affected boundary');
  });

  test('renders the finding, the rebuttal, and both excerpts', () => {
    const data = buildReconsiderationPromptSection(promptInput()).dataBlock.join('\n');
    expect(data).toContain('The handler dereferences session.userId and throws.');
    expect(data).toContain('The middleware rejects a null session before the handler runs.');
    expect(data).toContain('`false_premise`');
    expect(data).toContain('30: const user = session.userId;');
    expect(data).toContain('10: if (!session) return unauthorized();');
    expect(data).toContain('cited by the finding');
    expect(data).toContain('cited by the rebuttal');
    expect(data).toContain('test/auth.test.js > rejects a null session');
  });

  test('reports an unresolved reference rather than dropping it', () => {
    const data = buildReconsiderationPromptSection(
      promptInput({
        evidence: [
          { ref: { kind: 'test', name: 'test/auth.test.js > rejects null' }, citedBy: 'rebuttal', unavailable: 'unsupported-kind' },
          { ref: { kind: 'file', path: 'src/gone.ts', startLine: 1, endLine: 2 }, citedBy: 'rebuttal', unavailable: 'unresolvable' },
        ],
      }),
    ).dataBlock.join('\n');
    expect(data).toContain('(No content: unsupported-kind.)');
    expect(data).toContain('(No content: unresolvable.)');
    expect(data).toContain('src/gone.ts');
  });

  test('renders the literal fields alone when the version carries no fresh record', () => {
    const input = promptInput();
    delete input.target.body;
    const data = buildReconsiderationPromptSection(input).dataBlock.join('\n');
    expect(data).toContain('Full finding text is not available this cycle');
    expect(data).toContain('src/auth/handler.ts');
    expect(data).not.toContain('Violated contract:');
  });
});

describe('reconsideration prompt: bounds', () => {
  test('truncates the Issue contract at its own budget, visibly', () => {
    const data = buildReconsiderationPromptSection(
      promptInput({ issueContract: 'x'.repeat(MAX_RECONSIDERATION_ISSUE_CONTRACT_CHARS + 500) }),
    ).dataBlock.join('\n');
    expect(data).toContain(`… (truncated at ${MAX_RECONSIDERATION_ISSUE_CONTRACT_CHARS} characters)`);
    expect(data).not.toContain('x'.repeat(MAX_RECONSIDERATION_ISSUE_CONTRACT_CHARS + 1));
  });

  test('truncates one excerpt without crowding out the others', () => {
    const section = buildReconsiderationPromptSection(
      promptInput({
        evidence: [
          {
            ref: { kind: 'file', path: 'src/big.ts', startLine: 1, endLine: 2 },
            citedBy: 'finding',
            excerpt: 'y'.repeat(MAX_RECONSIDERATION_EXCERPT_CHARS + 100),
          },
          {
            ref: { kind: 'file', path: 'src/small.ts', startLine: 1, endLine: 1 },
            citedBy: 'rebuttal',
            excerpt: 'the other excerpt survives',
          },
        ],
      }),
    );
    const data = section.dataBlock.join('\n');
    expect(data).toContain(`… (truncated at ${MAX_RECONSIDERATION_EXCERPT_CHARS} characters)`);
    expect(data).toContain('the other excerpt survives');
  });

  test('truncates the diff excerpt at its own budget', () => {
    const data = buildReconsiderationPromptSection(
      promptInput({ diffExcerpt: 'z'.repeat(MAX_RECONSIDERATION_DIFF_CHARS + 10) }),
    ).dataBlock.join('\n');
    expect(data).toContain(`… (truncated at ${MAX_RECONSIDERATION_DIFF_CHARS} characters)`);
  });

  test('caps the test-evidence list and says how many it dropped', () => {
    const entries = Array.from({ length: MAX_RECONSIDERATION_TEST_EVIDENCE + 3 }, (_, i) => `test #${i}`);
    const data = buildReconsiderationPromptSection(promptInput({ testEvidence: entries })).dataBlock.join('\n');
    expect(data).toContain('(3 further entries omitted by the bundle bound.)');
    expect(data).not.toContain(`test #${MAX_RECONSIDERATION_TEST_EVIDENCE + 1}`);
  });
});

describe('reconsideration prompt: retry identity', () => {
  test('the run key is lineage, version, and run id', () => {
    expect(reconsiderationRunKey({ lineageId: LINEAGE, version: 2, runId: 'run-review-7' })).toBe(
      `${LINEAGE}@2#run-review-7`,
    );
  });

  test('the same inputs render byte-identical bundles with one digest', () => {
    const a = buildReconsiderationPromptSection(promptInput());
    const b = buildReconsiderationPromptSection(promptInput());
    expect(b.dataBlock).toEqual(a.dataBlock);
    expect(reconsiderationBundleDigest(b.dataBlock)).toBe(reconsiderationBundleDigest(a.dataBlock));
  });

  test('a widened bundle is a different digest', () => {
    const base = buildReconsiderationPromptSection(promptInput());
    const widened = buildReconsiderationPromptSection(
      promptInput({
        evidence: [
          ...promptInput().evidence,
          {
            ref: { kind: 'file', path: 'src/extra.ts', startLine: 1, endLine: 2 },
            citedBy: 'rebuttal',
            excerpt: '1: extra context nobody asked for',
          },
        ],
      }),
    );
    expect(reconsiderationBundleDigest(widened.dataBlock)).not.toBe(reconsiderationBundleDigest(base.dataBlock));
  });
});
