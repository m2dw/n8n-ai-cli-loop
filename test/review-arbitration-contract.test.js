/**
 * Unit tests for the issue #846 arbitration prompt and response contracts
 * (src/core/review-arbitration-prompt.ts, src/core/review-arbitration-response.ts).
 *
 * The invocation tests cover these two through the handler; what is asserted
 * here is what only the pure modules can show: that every part of the bundle is
 * bounded independently and marked where it was cut, that the digest moves with
 * the bundle and with nothing else, and that the response parser's admission
 * order and confidence semantics hold for inputs the handler would never reach.
 */
import {
  MAX_ARBITRATION_DIFF_CHARS,
  MAX_ARBITRATION_EVIDENCE_ATTACHMENTS,
  MAX_ARBITRATION_EXCERPT_CHARS,
  MAX_ARBITRATION_EXCERPTS,
  MAX_ARBITRATION_ISSUE_CONTRACT_CHARS,
  arbitrationBundleDigest,
  arbitrationRunKey,
  buildArbitrationBundleManifest,
  buildArbitrationPromptSection,
} from '../dist/core/review-arbitration-prompt.js';
import {
  extractArbiterVerdictRecord,
  isDecisiveVerdict,
  parseArbitrationResponse,
} from '../dist/core/review-arbitration-response.js';
import { ARBITER_VERDICTS, MAX_RATIONALE_CHARS } from '../dist/core/review-dispute.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const OTHER_LINEAGE = 'ln-bbbbbbbbbbbb';

function counters(overrides = {}) {
  return {
    rebuttals: 1,
    reconsiderations: 1,
    arbitrationPasses: 0,
    malformedArbiterAttempts: 0,
    evidenceRoundsUsed: 0,
    ...overrides,
  };
}

function lineage(overrides = {}) {
  return {
    lineageId: LINEAGE,
    state: 'arbitration_pending',
    version: 1,
    counters: counters(),
    rebuttedVersions: [1],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: 'src/auth/handler.ts',
    ...overrides,
  };
}

function promptInput(overrides = {}) {
  return {
    target: {
      lineageId: LINEAGE,
      version: 1,
      state: 'arbitration_pending',
      severity: 'P1',
      affectedBoundary: 'src/auth/handler.ts',
      humanGate: false,
      counters: counters(),
    },
    versions: [
      {
        version: 1,
        severity: 'P1',
        affectedBoundary: 'src/auth/handler.ts',
        humanGate: false,
        body: {
          severity: 'P1',
          violatedContract: 'The handler must reject a null session.',
          preconditions: 'No session cookie.',
          failureScenario: 'A 500 is returned.',
          affectedBoundary: 'src/auth/handler.ts',
          requiredOutcome: 'A 401 is returned.',
          evidenceRefs: [{ kind: 'file', path: 'src/auth/handler.ts', startLine: 30, endLine: 32 }],
        },
      },
    ],
    dispute: {
      challenged: { lineageId: LINEAGE, version: 1 },
      rebuttalReason: 'false_premise',
      argument: 'The middleware guards it.',
      evidenceRefs: [{ kind: 'file', path: 'src/auth/middleware.ts', startLine: 10, endLine: 12 }],
      whyNoChange: 'The guard already exists.',
    },
    reconsideration: {
      lineageId: LINEAGE,
      version: 1,
      reconsideration: 'uphold',
      rationale: 'The guard does not run on the direct-dispatch path.',
    },
    issueContract: 'The endpoint must never return 500 for an unauthenticated request.',
    evidence: [
      {
        ref: { kind: 'file', path: 'src/auth/handler.ts', startLine: 30, endLine: 32 },
        citedBy: 'finding',
        excerpt: '30: const line30 = 30;',
      },
    ],
    minConfidence: 0.7,
    ...overrides,
  };
}

function verdict(overrides = {}) {
  return {
    lineageId: LINEAGE,
    version: 1,
    verdict: 'reviewer_correct',
    confidence: 0.9,
    rationale: 'The contract decides it.',
    ...overrides,
  };
}

function fenced(value) {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
}

function parse(response, overrides = {}) {
  return parseArbitrationResponse({
    response,
    pending: { lineageId: LINEAGE, version: 1 },
    lineages: { [LINEAGE]: lineage() },
    minConfidence: 0.7,
    ...overrides,
  });
}

describe('the bundle is bounded, marked, and deterministic', () => {
  test('an oversized Issue contract is cut at its own bound and says so', () => {
    const section = buildArbitrationPromptSection(
      promptInput({ issueContract: 'c'.repeat(MAX_ARBITRATION_ISSUE_CONTRACT_CHARS + 500) }),
    );
    const block = section.dataBlock.join('\n');
    expect(block).toContain(`… (truncated at ${MAX_ARBITRATION_ISSUE_CONTRACT_CHARS} characters)`);
    // One oversized part never crowds another out: the rebuttal is still whole.
    expect(block).toContain('The middleware guards it.');
  });

  test('the excerpt and diff bounds are independent of the contract bound', () => {
    const section = buildArbitrationPromptSection(
      promptInput({
        evidence: [
          {
            ref: { kind: 'file', path: 'src/auth/handler.ts', startLine: 1, endLine: 2 },
            citedBy: 'finding',
            excerpt: 'e'.repeat(MAX_ARBITRATION_EXCERPT_CHARS + 100),
          },
        ],
        diffExcerpt: 'd'.repeat(MAX_ARBITRATION_DIFF_CHARS + 100),
      }),
    );
    const block = section.dataBlock.join('\n');
    expect(block).toContain(`… (truncated at ${MAX_ARBITRATION_EXCERPT_CHARS} characters)`);
    expect(block).toContain(`… (truncated at ${MAX_ARBITRATION_DIFF_CHARS} characters)`);
  });

  test('excerpts past the bundle bound are omitted, and the omission is counted', () => {
    const evidence = Array.from({ length: MAX_ARBITRATION_EXCERPTS + 3 }, (_, i) => ({
      ref: { kind: 'file', path: `src/f${i}.ts`, startLine: 1, endLine: 2 },
      citedBy: 'finding',
      excerpt: `excerpt ${i}`,
    }));
    const block = buildArbitrationPromptSection(promptInput({ evidence })).dataBlock.join('\n');
    expect(block).toContain('3 further excerpt(s) omitted by the bundle bound.');
    expect(block).not.toContain(`excerpt ${MAX_ARBITRATION_EXCERPTS + 2}`);
  });

  test('an admitted evidence-round excerpt keeps its slot when the earlier records fill the bound', () => {
    const ref = { kind: 'file', path: 'src/auth/middleware.ts', startLine: 10, endLine: 12 };
    const input = promptInput({
      evidence: [
        ...Array.from({ length: MAX_ARBITRATION_EXCERPTS }, (_, i) => ({
          ref: { kind: 'file', path: `src/f${i}.ts`, startLine: 1, endLine: 2 },
          citedBy: 'finding',
          excerpt: `excerpt ${i}`,
        })),
        { ref, citedBy: 'evidence_round', excerpt: 'what the evidence round supplied' },
      ],
      evidenceRound: [{ party: 'implementer', ref, note: 'The guard runs before dispatch.' }],
    });
    const block = buildArbitrationPromptSection(input).dataBlock.join('\n');
    // The attachment is listed AND its content is shown: an attachment rendered
    // as a bare reference supplies nothing the round was opened for.
    expect(block).toContain('The guard runs before dispatch.');
    expect(block).toContain('what the evidence round supplied');
    // Its slot comes off the earlier citations, and that omission is still counted.
    expect(block).toContain('1 further excerpt(s) omitted by the bundle bound.');
    expect(block).not.toContain(`excerpt ${MAX_ARBITRATION_EXCERPTS - 1}`);
    // The manifest attests to the same bundle the block rendered.
    const refs = buildArbitrationBundleManifest(input).entries.map((e) => e.ref);
    expect(refs.filter((r) => r.startsWith('evidence_round:'))).toHaveLength(1);
    expect(refs.some((r) => r.includes(`src/f${MAX_ARBITRATION_EXCERPTS - 1}.ts`))).toBe(false);
  });

  test('the reserve never takes more slots than the attachment bound allows', () => {
    const evidence = [
      ...Array.from({ length: MAX_ARBITRATION_EXCERPTS }, (_, i) => ({
        ref: { kind: 'file', path: `src/f${i}.ts`, startLine: 1, endLine: 2 },
        citedBy: 'finding',
        excerpt: `excerpt ${i}`,
      })),
      ...Array.from({ length: MAX_ARBITRATION_EVIDENCE_ATTACHMENTS + 4 }, (_, i) => ({
        ref: { kind: 'file', path: `src/a${i}.ts`, startLine: 1, endLine: 2 },
        citedBy: 'evidence_round',
        excerpt: `attachment ${i}`,
      })),
    ];
    const block = buildArbitrationPromptSection(promptInput({ evidence })).dataBlock.join('\n');
    // Twelve attachments and twelve earlier citations: the reserve is capped by
    // the attachment bound, so the finding and the rebuttal keep the rest.
    expect(block).toContain(`attachment ${MAX_ARBITRATION_EVIDENCE_ATTACHMENTS - 1}`);
    expect(block).not.toContain(`attachment ${MAX_ARBITRATION_EVIDENCE_ATTACHMENTS}`);
    expect(block).toContain('excerpt 11');
    expect(block).not.toContain('excerpt 12');
    expect(block).toContain(
      `${evidence.length - MAX_ARBITRATION_EXCERPTS} further excerpt(s) omitted by the bundle bound.`,
    );
  });

  test('an unavailable citation is rendered as unavailable, never dropped', () => {
    const block = buildArbitrationPromptSection(
      promptInput({
        evidence: [
          {
            ref: { kind: 'file', path: 'src/gone.ts', startLine: 1, endLine: 2 },
            citedBy: 'rebuttal',
            unavailable: 'unresolvable',
          },
        ],
      }),
    ).dataBlock.join('\n');
    expect(block).toContain('src/gone.ts');
    expect(block).toContain('(No content: unresolvable.)');
  });

  test('the same inputs render byte-identically, and a wider bundle does not', () => {
    const first = buildArbitrationPromptSection(promptInput());
    const second = buildArbitrationPromptSection(promptInput());
    expect(second.dataBlock).toEqual(first.dataBlock);
    expect(arbitrationBundleDigest(second.dataBlock)).toBe(arbitrationBundleDigest(first.dataBlock));
    const wider = buildArbitrationPromptSection(promptInput({ verificationEvidence: ['test/auth.test.js > guards'] }));
    expect(arbitrationBundleDigest(wider.dataBlock)).not.toBe(arbitrationBundleDigest(first.dataBlock));
  });

  test('the run key is lineage, version, and run', () => {
    expect(arbitrationRunKey({ lineageId: LINEAGE, version: 2, runId: 'run-7' })).toBe(`${LINEAGE}@2#run-7`);
  });

  test('the header states the four verdicts and the answer contract', () => {
    const header = buildArbitrationPromptSection(promptInput()).header.join('\n');
    for (const token of ARBITER_VERDICTS) expect(header).toContain(token);
    expect(header).toContain(String(MAX_RATIONALE_CHARS));
    expect(header).toContain(LINEAGE);
    // The confidence threshold is stated as calibration, not as a gate to game.
    expect(header).toContain('0.7');
    expect(header).toContain('a low-confidence decisive verdict');
  });

  test('the manifest hashes the BOUNDED content, so it attests to what was shown', () => {
    const input = promptInput({ issueContract: 'c'.repeat(MAX_ARBITRATION_ISSUE_CONTRACT_CHARS + 500) });
    const manifest = buildArbitrationBundleManifest(input);
    const issue = manifest.entries.find((e) => e.kind === 'issue_body');
    expect(issue.bytes).toBeLessThan(MAX_ARBITRATION_ISSUE_CONTRACT_CHARS + 500);
    expect(manifest.lineageId).toBe(LINEAGE);
    expect(manifest.version).toBe(1);
    // Same inputs, same manifest: hashes are content, not identity.
    expect(buildArbitrationBundleManifest(input)).toEqual(manifest);
  });

  test('the manifest attests to the lineage header, counters included', () => {
    const base = buildArbitrationBundleManifest(promptInput());
    const entry = base.entries.find((e) => e.kind === 'lineage');
    expect(entry.ref).toBe(LINEAGE);
    expect(entry.bytes).toBeGreaterThan(0);
    // The counters are rendered into the block, so a run that saw different ones
    // must be tellable apart from this one by the manifest, not only the digest.
    const later = buildArbitrationBundleManifest(
      promptInput({
        target: { ...promptInput().target, counters: counters({ arbitrationPasses: 1 }) },
      }),
    );
    expect(later.entries.find((e) => e.kind === 'lineage').sha256).not.toBe(entry.sha256);
  });

  test('the manifest records who supplied each evidence-round attachment, and its note', () => {
    const ref = { kind: 'file', path: 'src/auth/middleware.ts', startLine: 1, endLine: 3 };
    const withRound = (attachment) => buildArbitrationBundleManifest(promptInput({ evidenceRound: [attachment] }));
    const implementer = withRound({ party: 'implementer', ref, note: 'The guard runs before dispatch.' });
    const entry = implementer.entries.find((e) => e.ref.startsWith('evidence_round[0]:'));
    expect(entry.kind).toBe('evidence');
    expect(entry.bytes).toBeGreaterThan(0);
    // Same reference, different party — and different note — are different bundles.
    const reviewer = withRound({ party: 'reviewer', ref, note: 'The guard runs before dispatch.' });
    expect(reviewer.entries.find((e) => e.ref.startsWith('evidence_round[0]:')).sha256).not.toBe(entry.sha256);
    const renoted = withRound({ party: 'implementer', ref, note: 'The guard runs after dispatch.' });
    expect(renoted.entries.find((e) => e.ref.startsWith('evidence_round[0]:')).sha256).not.toBe(entry.sha256);
  });

  test('an arbitration with no reconsideration renders the absence and manifests nothing', () => {
    const input = promptInput({ reconsideration: undefined });
    const block = buildArbitrationPromptSection(input).dataBlock.join('\n');
    expect(block).toContain('No reconsideration was taken for this lineage');
    expect(buildArbitrationBundleManifest(input).entries.some((e) => e.kind === 'reconsideration')).toBe(false);
  });
});

describe('the verdict envelope', () => {
  test('one fenced object is the record', () => {
    const extraction = extractArbiterVerdictRecord(`prose\n${fenced(verdict())}`);
    expect(extraction.ok).toBe(true);
    expect(extraction.record.verdict).toBe('reviewer_correct');
  });

  test('a quoted array block is not a verdict, and is ignored rather than fatal', () => {
    const extraction = extractArbiterVerdictRecord(
      `\`\`\`json\n[1, 2, 3]\n\`\`\`\n\n${fenced(verdict())}`,
    );
    expect(extraction.ok).toBe(true);
    expect(extraction.record.lineageId).toBe(LINEAGE);
  });

  test('an unreadable fence is fatal even when a clean one follows it', () => {
    const extraction = extractArbiterVerdictRecord(
      `\`\`\`json\n{ truncated\n\`\`\`\n\n${fenced(verdict())}`,
    );
    expect(extraction.ok).toBe(false);
    expect(extraction.failure.reason).toBe('unparseable');
  });

  test('a rationale that quotes a fence does not end the record early', () => {
    const quoting = verdict({ rationale: 'The excerpt is wrapped in ``` in the doc, which is fine.' });
    const extraction = extractArbiterVerdictRecord(fenced(quoting));
    expect(extraction.ok).toBe(true);
    expect(extraction.record.rationale).toContain('```');
  });
});

describe('admission order and confidence semantics', () => {
  test('a malformed record is malformed before it is "for the wrong lineage"', () => {
    const outcome = parse(fenced({ ...verdict({ lineageId: OTHER_LINEAGE }), verdict: 'not_a_verdict' }));
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('unknown-enum');
  });

  test('a verdict for a lineage this invocation did not ask about is refused', () => {
    const outcome = parse(fenced(verdict({ lineageId: OTHER_LINEAGE })));
    expect(outcome.failure.reason).toBe('unknown-lineage');
  });

  test('a lineage that is not awaiting an arbiter is refused as such', () => {
    const outcome = parse(fenced(verdict()), { lineages: { [LINEAGE]: lineage({ state: 'binding' }) } });
    expect(outcome.failure.reason).toBe('not-actionable-state');
  });

  test('a spent §8.3 budget refuses the verdict', () => {
    const outcome = parse(fenced(verdict()), {
      lineages: { [LINEAGE]: lineage({ counters: counters({ arbitrationPasses: 2 }) }) },
    });
    expect(outcome.failure.reason).toBe('arbitration-passes-exhausted');
  });

  test('a lowered session budget refuses what the defaults would allow', () => {
    const outcome = parse(fenced(verdict()), {
      lineages: { [LINEAGE]: lineage({ counters: counters({ arbitrationPasses: 1 }) }) },
      limits: {
        maxRebuttalsPerVersion: 1,
        maxVersionsPerLineage: 2,
        maxReconsiderationsPerLineage: 1,
        maxArbitrationPassesPerLineage: 1,
        maxMalformedArbiterAttemptsPerLineage: 2,
        maxEvidenceRoundsPerLineage: 1,
      },
    });
    expect(outcome.failure.reason).toBe('arbitration-passes-exhausted');
  });

  test('finding-shaped fields are audited on a REJECTED verdict too', () => {
    const outcome = parse(fenced({ ...verdict({ version: 2 }), extraFinding: { severity: 'P2' } }));
    expect(outcome.admitted).toBeNull();
    expect(outcome.failure.reason).toBe('stale-version');
    expect(outcome.summary.ignoredFindingShapedFields).toEqual(['extraFinding']);
  });

  test('only the two decisive verdicts are gated by the threshold', () => {
    expect(isDecisiveVerdict('reviewer_correct')).toBe(true);
    expect(isDecisiveVerdict('implementer_correct')).toBe(true);
    expect(isDecisiveVerdict('spec_ambiguous')).toBe(false);
    expect(isDecisiveVerdict('insufficient_evidence')).toBe(false);
  });

  test('a low-confidence decisive verdict is admitted with the threshold reported', () => {
    const outcome = parse(fenced(verdict({ confidence: 0.1 })));
    expect(outcome.admitted).not.toBeNull();
    expect(outcome.failure).toBeNull();
    expect(outcome.confidence).toEqual({
      decisive: true,
      minConfidence: 0.7,
      confidence: 0.1,
      meetsMinConfidence: false,
    });
    expect(outcome.summary.rationaleChars).toBe('The contract decides it.'.length);
  });
});
