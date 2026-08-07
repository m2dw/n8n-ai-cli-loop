/**
 * Unit tests for the issue #837 fix-mode disposition prompt builder
 * (src/core/review-fix-disposition-prompt.ts).
 *
 * This module is pure: it renders which findings are awaiting an
 * implementation disposition and the disposition contract text for them. It
 * never parses an agent response, never mutates `reviewDispute`/lineage
 * state, and never selects a task transition — issue #843 owns response
 * parsing, issue #840 owns persistence and transitions.
 */
import {
  parseFindingsArtifact,
  resolveFixPromptFindings,
  buildFixDispositionPromptSection,
} from '../dist/core/review-fix-disposition-prompt.js';
import { emptyReviewDisputeContext } from '../dist/core/review-dispute.js';

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

function findingRecord(id, overrides = {}) {
  return {
    lineageId: id,
    version: 1,
    severity: 'P1',
    violatedContract: 'Auth handler must reject a null session before use',
    preconditions: 'A request arrives with no session cookie',
    failureScenario: 'handler.ts:42 dereferences session.user without a null check and crashes the process',
    affectedBoundary: 'src/auth/handler.ts',
    requiredOutcome: 'The handler returns 401 for a missing session instead of crashing',
    evidenceRefs: [{ kind: 'file', path: 'src/auth/handler.ts', startLine: 40, endLine: 44 }],
    humanGate: false,
    reviewerMeta: { agentId: 'codex', reviewRunId: 'review-run-1', timestamp: '2026-08-03T00:00:00.000Z' },
    ...overrides,
  };
}

function disputeContext(lineages, overrides = {}) {
  return { version: 1, reviewStructure: 'structured', lineages, ...overrides };
}

describe('parseFindingsArtifact', () => {
  test('parses a well-formed artifact', () => {
    const raw = JSON.stringify({ findings: [findingRecord('ln-aaaaaaaaaaaa')] });
    const parsed = parseFindingsArtifact(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].lineageId).toBe('ln-aaaaaaaaaaaa');
  });

  test('parses an artifact with attachments alongside findings, ignoring attachments', () => {
    const raw = JSON.stringify({
      findings: [findingRecord('ln-aaaaaaaaaaaa')],
      attachments: [{ lineageId: 'ln-bbbbbbbbbbbb', version: 1, severity: 'P2', path: 'envelope.findings[1]' }],
    });
    const parsed = parseFindingsArtifact(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].lineageId).toBe('ln-aaaaaaaaaaaa');
  });

  test('fails closed on unparseable JSON', () => {
    expect(parseFindingsArtifact('{ not json')).toBeNull();
  });

  test('fails closed on a JSON array at the top level', () => {
    expect(parseFindingsArtifact('[]')).toBeNull();
  });

  test('fails closed when `findings` is missing', () => {
    expect(parseFindingsArtifact(JSON.stringify({ attachments: [] }))).toBeNull();
  });

  test('fails closed when `findings` is not an array', () => {
    expect(parseFindingsArtifact(JSON.stringify({ findings: 'nope' }))).toBeNull();
  });

  test('fails closed when a finding element is missing a required field', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa');
    delete bad.requiredOutcome;
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed when any element in `findings` is malformed, not just the bad one', () => {
    const good = findingRecord('ln-aaaaaaaaaaaa');
    const bad = { lineageId: 'ln-bbbbbbbbbbbb' };
    expect(parseFindingsArtifact(JSON.stringify({ findings: [good, bad] }))).toBeNull();
  });

  test('fails closed when an evidenceRefs entry is null (syntactically valid, semantically corrupt)', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', { evidenceRefs: [null] });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed when a `file` evidenceRefs entry is missing required fields', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', { evidenceRefs: [{ kind: 'file', path: 'src/a.ts' }] });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed when an evidenceRefs entry has an unknown kind', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', { evidenceRefs: [{ kind: 'not_a_kind' }] });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed when a `file` evidenceRefs entry points outside the repository', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', {
      evidenceRefs: [{ kind: 'file', path: '/etc/passwd', startLine: 1, endLine: 1 }],
    });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed on an out-of-vocabulary severity', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', { severity: 'P3' });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed on an empty body-text field', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', { violatedContract: '   ' });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed on an out-of-range version', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', { version: 0 });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed on a non-integer version', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', { version: 1.5 });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed on an unknown extra field', () => {
    const bad = findingRecord('ln-aaaaaaaaaaaa', { extra: 'not part of the schema' });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [bad] }))).toBeNull();
  });

  test('fails closed on a duplicate lineageId + version record, rather than letting the last one win', () => {
    const first = findingRecord('ln-aaaaaaaaaaaa', { requiredOutcome: 'first record' });
    const second = findingRecord('ln-aaaaaaaaaaaa', { requiredOutcome: 'second record' });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [first, second] }))).toBeNull();
  });

  test('fails closed on two different versions of the same lineage in one artifact', () => {
    const v1 = findingRecord('ln-aaaaaaaaaaaa', { version: 1 });
    const v2 = findingRecord('ln-aaaaaaaaaaaa', { version: 2 });
    expect(parseFindingsArtifact(JSON.stringify({ findings: [v1, v2] }))).toBeNull();
  });
});

describe('resolveFixPromptFindings', () => {
  test('returns nothing when no lineage is awaiting a disposition', () => {
    expect(resolveFixPromptFindings(emptyReviewDisputeContext('structured'), null)).toEqual([]);
  });

  test('only includes lineages in an awaits-implementer state (open, binding)', () => {
    const context = disputeContext({
      'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa', { state: 'open' }),
      'ln-bbbbbbbbbbbb': lineage('ln-bbbbbbbbbbbb', { state: 'binding' }),
      'ln-cccccccccccc': lineage('ln-cccccccccccc', { state: 'disputed' }),
      'ln-dddddddddddd': lineage('ln-dddddddddddd', { state: 'resolved_fixed', outcome: 'resolved_fixed' }),
    });
    const findings = resolveFixPromptFindings(context, null);
    expect(findings.map((f) => f.lineageId).sort()).toEqual(['ln-aaaaaaaaaaaa', 'ln-bbbbbbbbbbbb']);
  });

  test('is deterministically ordered by lineage id regardless of object key order', () => {
    const context = disputeContext({
      'ln-cccccccccccc': lineage('ln-cccccccccccc'),
      'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa'),
      'ln-bbbbbbbbbbbb': lineage('ln-bbbbbbbbbbbb'),
    });
    const findings = resolveFixPromptFindings(context, null);
    expect(findings.map((f) => f.lineageId)).toEqual(['ln-aaaaaaaaaaaa', 'ln-bbbbbbbbbbbb', 'ln-cccccccccccc']);
  });

  test('an open lineage allows all three dispositions', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa', { state: 'open' }) });
    const [f] = resolveFixPromptFindings(context, null);
    expect([...f.allowedDispositions].sort()).toEqual(['blocked', 'fixed', 'review_disputed']);
  });

  test('a binding lineage excludes review_disputed', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa', { state: 'binding' }) });
    const [f] = resolveFixPromptFindings(context, null);
    expect([...f.allowedDispositions].sort()).toEqual(['blocked', 'fixed']);
  });

  test('attaches a full body when the artifact carries a matching lineageId + version', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa', { version: 1 }) });
    const artifact = [findingRecord('ln-aaaaaaaaaaaa', { version: 1 })];
    const [f] = resolveFixPromptFindings(context, artifact);
    expect(f.body).toBeDefined();
    expect(f.body.violatedContract).toBe('Auth handler must reject a null session before use');
  });

  test('a revised version only matches the artifact record at the SAME version', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa', { version: 2 }) });
    // The artifact carries only the version-1 record (e.g. stale/mismatched input) —
    // it must not be misapplied to the lineage's current version 2.
    const artifact = [findingRecord('ln-aaaaaaaaaaaa', { version: 1 })];
    const [f] = resolveFixPromptFindings(context, artifact);
    expect(f.version).toBe(2);
    expect(f.body).toBeUndefined();
  });

  test('leaves the lineage undefined-body (degraded) when the artifact is null', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const [f] = resolveFixPromptFindings(context, null);
    expect(f.body).toBeUndefined();
    expect(f.lineageId).toBe('ln-aaaaaaaaaaaa');
    expect(f.affectedBoundary).toBe('src/auth/handler.ts');
  });

  test('does not mutate its inputs', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const artifact = [findingRecord('ln-aaaaaaaaaaaa')];
    const contextSnapshot = JSON.parse(JSON.stringify(context));
    const artifactSnapshot = JSON.parse(JSON.stringify(artifact));
    resolveFixPromptFindings(context, artifact);
    expect(context).toEqual(contextSnapshot);
    expect(artifact).toEqual(artifactSnapshot);
  });
});

describe('buildFixDispositionPromptSection', () => {
  test('returns null for an empty finding list (legacy-only fallback)', () => {
    expect(buildFixDispositionPromptSection([])).toBeNull();
  });

  test('renders the exact #836 disposition vocabulary, and only it', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    const headerText = section.header.join('\n');
    expect(headerText).toContain('`fixed`');
    expect(headerText).toContain('`review_disputed`');
    expect(headerText).toContain('`blocked`');
    expect(headerText).not.toMatch(/`accepted`|`rejected`|`withdrawn`/);
  });

  test('a single open finding needs no binding-state caveat', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa', { state: 'open' }) });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    expect(section.header.join('\n')).not.toMatch(/binding` state/);
  });

  test('a binding finding gets an explicit no-second-dispute caveat naming its id', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa', { state: 'binding' }) });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    const headerText = section.header.join('\n');
    expect(headerText).toContain('`ln-aaaaaaaaaaaa`');
    expect(headerText).toMatch(/binding` state/);
    expect(headerText).toMatch(/may NOT be disputed again/);
  });

  test('describes the evidence-backed dispute contract and distinguishes it from refusal/disagreement/no-op', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    const headerText = section.header.join('\n');
    expect(headerText).toMatch(/evidence-backed/);
    expect(headerText).toMatch(/false_premise/);
    expect(headerText).toMatch(/contradicts_issue_contract/);
    expect(headerText).toMatch(/already_covered/);
    expect(headerText).toMatch(/would_reduce_correctness/);
    expect(headerText).toMatch(/out_of_scope/);
    expect(headerText).toMatch(/unsupported assertion is not a dispute/);
    expect(headerText).toMatch(/bare refusal to act, disagreement stated without evidence, and[\s\S]*making no change[\s\S]*NOT valid dispositions/);
  });

  test('explains the implementer only proposes — it cannot self-accept or choose the next state', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    expect(section.header.join('\n')).toMatch(
      /only PROPOSE a disposition[\s\S]*cannot accept your own rebuttal, resolve a finding, or decide what happens next/,
    );
  });

  test('specifies a machine-readable disposition record with lineageId + version for every disposition, not just review_disputed', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    const headerText = section.header.join('\n');
    expect(headerText).toMatch(/```json/);
    expect(headerText).toContain('"lineageId"');
    expect(headerText).toContain('"version"');
    expect(headerText).toContain('"disposition"');
    expect(headerText).toMatch(/machine-readable/);
    expect(headerText).toMatch(/lineageId.*and.*version.*MUST exactly match/);
  });

  test('explains mixed dispositions across findings are supported', () => {
    const context = disputeContext({
      'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa'),
      'ln-bbbbbbbbbbbb': lineage('ln-bbbbbbbbbbbb'),
    });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    expect(section.header.join('\n')).toMatch(/[Mm]ixed dispositions across multiple findings[\s\S]*expected and supported/);
  });

  test('renders a full finding body when available: contract, preconditions, scenario, outcome, evidence', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const artifact = [findingRecord('ln-aaaaaaaaaaaa')];
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, artifact));
    const dataText = section.dataBlock.join('\n');
    expect(dataText).toContain('ln-aaaaaaaaaaaa');
    expect(dataText).toContain('version 1, state `open`, severity P1');
    expect(dataText).toContain('Auth handler must reject a null session before use');
    expect(dataText).toContain('A request arrives with no session cookie');
    expect(dataText).toContain('handler.ts:42 dereferences session.user without a null check and crashes the process');
    expect(dataText).toContain('The handler returns 401 for a missing session instead of crashing');
    expect(dataText).toContain('file `src/auth/handler.ts`:40-44');
  });

  test('renders a degraded finding (no body) without fabricating prose', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    const dataText = section.dataBlock.join('\n');
    expect(dataText).toContain('ln-aaaaaaaaaaaa');
    expect(dataText).toMatch(/Full finding text is not available this cycle/);
    expect(dataText).not.toContain('Auth handler must reject');
  });

  test('renders multiple findings independently in the data block', () => {
    const context = disputeContext({
      'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa', { affectedBoundary: 'src/a.ts' }),
      'ln-bbbbbbbbbbbb': lineage('ln-bbbbbbbbbbbb', { affectedBoundary: 'src/b.ts' }),
    });
    const artifact = [
      findingRecord('ln-aaaaaaaaaaaa', { affectedBoundary: 'src/a.ts' }),
      findingRecord('ln-bbbbbbbbbbbb', { affectedBoundary: 'src/b.ts' }),
    ];
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, artifact));
    const dataText = section.dataBlock.join('\n');
    expect(dataText).toContain('ln-aaaaaaaaaaaa');
    expect(dataText).toContain('ln-bbbbbbbbbbbb');
    expect(dataText.indexOf('ln-aaaaaaaaaaaa')).toBeLessThan(dataText.indexOf('ln-bbbbbbbbbbbb'));
  });

  test('the footer restates the per-finding disposition requirement', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    expect(section.footer.join('\n')).toMatch(/Propose your disposition for each finding listed above/);
  });

  test('the disposition template is a syntactically valid JSON array, with no comments or union syntax', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const section = buildFixDispositionPromptSection(resolveFixPromptFindings(context, null));
    const headerText = section.header.join('\n');
    const match = headerText.match(/```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    let parsed;
    expect(() => {
      parsed = JSON.parse(match[1]);
    }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const record of parsed) {
      expect(typeof record.lineageId).toBe('string');
      expect(typeof record.version).toBe('number');
      expect(['fixed', 'review_disputed', 'blocked']).toContain(record.disposition);
    }
    const disputed = parsed.find((r) => r.disposition === 'review_disputed');
    expect(disputed.dispute).toBeDefined();
    expect(disputed.dispute.challenged).toEqual({ lineageId: disputed.lineageId, version: disputed.version });
  });

  test('is a pure function of its inputs — no filesystem or persistence side effects', () => {
    const context = disputeContext({ 'ln-aaaaaaaaaaaa': lineage('ln-aaaaaaaaaaaa') });
    const artifact = [findingRecord('ln-aaaaaaaaaaaa')];
    const findings = resolveFixPromptFindings(context, artifact);
    const a = buildFixDispositionPromptSection(findings);
    const b = buildFixDispositionPromptSection(findings);
    expect(a).toEqual(b);
  });
});
