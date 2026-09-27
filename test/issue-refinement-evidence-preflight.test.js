/**
 * §5.2 required-evidence preflight (issue #1003,
 * docs/issue-refinement-contract.md §5.2, §12 row 48, §13, §15).
 *
 * The pure half: given the frozen §5.1 capture record, does the lane run at
 * all? Covers the acceptance criteria that do not need a loop — requiredness
 * defaulting to required, unknown requiredness failing closed, optional absence
 * never blocking, truncation of a required selection counting as a gap, an
 * undeclared body being unaffected, and the operator projection of the
 * persisted gate record carrying literals rather than declared paths.
 */

import {
  REFINEMENT_EVIDENCE_GAP_REASONS,
  REFINEMENT_EVIDENCE_OMISSION_REASONS,
  evaluateRefinementEvidencePreflight,
  refinementEvidencePreflight,
  renderRefinementLines,
  summarizeRefinementStatus,
} from '../dist/index.js';
import { formatRefinementDetail } from '../dist/cli/admin-ui.js';

function selector(overrides = {}) {
  return {
    issueNumber: 10,
    path: 'src/core/review-dispute-turn.ts',
    exportName: 'DisputeTurnSelection',
    lines: null,
    maxBytes: null,
    required: true,
    ...overrides,
  };
}

function captured(overrides = {}) {
  return {
    index: 0,
    selector: selector(),
    status: 'captured',
    omissionReason: null,
    detail: null,
    source: {
      issueNumber: 10,
      prNumber: 910,
      shape: 'open_stack_ready',
      headRefName: 'ai/issue-10',
      commitSha: 'a'.repeat(40),
    },
    content: 'export type DisputeTurnSelection = { kind: "dispatch" };',
    maxBytesApplied: 8000,
    truncated: false,
    ...overrides,
  };
}

function omitted(reason, overrides = {}) {
  return {
    ...captured(),
    status: 'omitted',
    omissionReason: reason,
    content: null,
    maxBytesApplied: null,
    ...overrides,
  };
}

describe('§5.2 preflight — the closed gap vocabulary', () => {
  test('is the §5.1 omission vocabulary plus truncation, and nothing else', () => {
    expect([...REFINEMENT_EVIDENCE_GAP_REASONS]).toEqual([
      ...REFINEMENT_EVIDENCE_OMISSION_REASONS,
      'truncated',
    ]);
  });

  // Every recorded omission of a required selection is a gap: the lane cannot
  // tell the refiner "this contract is authoritative" and then not hand it over.
  test('every §5.1 omission reason stops a required selection', () => {
    for (const reason of REFINEMENT_EVIDENCE_OMISSION_REASONS) {
      const result = evaluateRefinementEvidencePreflight([omitted(reason)]);
      expect(result.kind).toBe('evidence_required');
      expect(result.gaps).toEqual([
        {
          index: 0,
          reason,
          requirement: 'required',
          predecessorIssueNumber: 10,
        },
      ]);
    }
  });
});

describe('§5.2 preflight — requiredness', () => {
  test('an undeclared body has nothing to require', () => {
    for (const empty of [[], undefined]) {
      expect(evaluateRefinementEvidencePreflight(empty)).toEqual({
        kind: 'satisfied',
        declared: 0,
        captured: 0,
        optionalGaps: 0,
        gaps: [],
      });
    }
  });

  test('captured required evidence satisfies the preflight', () => {
    const result = evaluateRefinementEvidencePreflight([captured()]);
    expect(result.kind).toBe('satisfied');
    expect(result.declared).toBe(1);
    expect(result.captured).toBe(1);
    expect(result.gaps).toEqual([]);
  });

  // The acceptance criterion: optional absence must not raise the handoff.
  test('an optional selection that could not be captured is counted, not blocking', () => {
    const result = evaluateRefinementEvidencePreflight([
      omitted('missing_path', { selector: selector({ required: false }) }),
    ]);
    expect(result.kind).toBe('satisfied');
    expect(result.optionalGaps).toBe(1);
    expect(result.captured).toBe(0);
    expect(result.gaps).toEqual([]);
  });

  test('an optional truncated capture is equally non-blocking', () => {
    const result = evaluateRefinementEvidencePreflight([
      captured({ selector: selector({ required: false }), truncated: true }),
    ]);
    expect(result.kind).toBe('satisfied');
    expect(result.optionalGaps).toBe(1);
    // A truncated entry is not counted as captured either: it is neither.
    expect(result.captured).toBe(0);
  });

  // A required excerpt that was cut is in the snapshot and is still not the
  // contract — the agents are told to treat the missing remainder as
  // unsupported, which is the same dead end by another road.
  test('a truncated required capture is a gap', () => {
    const result = evaluateRefinementEvidencePreflight([captured({ truncated: true })]);
    expect(result.kind).toBe('evidence_required');
    expect(result.gaps).toEqual([
      { index: 0, reason: 'truncated', requirement: 'required', predecessorIssueNumber: 10 },
    ]);
  });

  // A declaration that never named a selection carries no `required` flag to
  // read. The only reading that cannot be wrong is "the operator meant it".
  test('unknown requiredness fails closed and is recorded as undetermined', () => {
    const result = evaluateRefinementEvidencePreflight([
      omitted('malformed_declaration', { selector: null, source: null }),
    ]);
    expect(result.kind).toBe('evidence_required');
    expect(result.gaps).toEqual([
      {
        index: 0,
        reason: 'malformed_declaration',
        requirement: 'undetermined',
        predecessorIssueNumber: null,
      },
    ]);
  });

  test('an omission with no recorded reason still stops the lane', () => {
    const result = evaluateRefinementEvidencePreflight([
      omitted('missing_path', { omissionReason: 'not-a-reason' }),
    ]);
    expect(result.kind).toBe('evidence_required');
    expect(result.gaps[0].reason).toBe('invalid_selection');
  });

  test('mixed entries report every blocking gap in declaration order', () => {
    const result = evaluateRefinementEvidencePreflight([
      captured({ index: 0 }),
      omitted('export_not_found', { index: 1 }),
      omitted('denied_path', { index: 2, selector: null, source: null }),
      omitted('unknown_predecessor', {
        index: 3,
        selector: selector({ required: false, issueNumber: 99 }),
      }),
    ]);
    expect(result.kind).toBe('evidence_required');
    expect(result.declared).toBe(4);
    expect(result.captured).toBe(1);
    expect(result.optionalGaps).toBe(1);
    expect(result.gaps.map((g) => [g.index, g.reason, g.requirement])).toEqual([
      [1, 'export_not_found', 'required'],
      [2, 'denied_path', 'undetermined'],
    ]);
  });

  test('the snapshot-shaped helper reads the same list', () => {
    const snapshot = { evidence: [omitted('source_unavailable')] };
    expect(refinementEvidencePreflight(snapshot)).toEqual(
      evaluateRefinementEvidencePreflight(snapshot.evidence),
    );
  });

  // The decision is a pure function of frozen literals, which is what makes a
  // retry against unchanged inputs reach the same handoff without an agent.
  test('is deterministic for the same capture record', () => {
    const record = [omitted('identity_mismatch'), captured({ index: 1 })];
    expect(evaluateRefinementEvidencePreflight(record)).toEqual(
      evaluateRefinementEvidencePreflight(record),
    );
  });
});

// ---------------------------------------------------------------------------
// §15 operator projection of the persisted gate record
// ---------------------------------------------------------------------------

describe('§5.2 gate record — operator view', () => {
  const block = {
    state: 'escalated_human',
    handoffReason: 'evidence_required',
    predecessorFingerprint: 'f'.repeat(64),
    sourceFingerprint: 's'.repeat(64),
    managedRegion: 'absent',
    predecessors: [{ issueNumber: 10 }],
    counters: {
      rounds: 0,
      malformedAttempts: { refiner: 0, critic: 0 },
      agentFailures: { refiner: 0, critic: 0 },
      staleRestarts: 0,
    },
    roles: { refinerAgent: 'claude', criticAgent: 'codex' },
    evidenceGate: {
      declared: 2,
      captured: 0,
      optionalGaps: 1,
      gaps: [
        {
          index: 0,
          reason: 'missing_path',
          requirement: 'required',
          predecessorIssueNumber: 10,
        },
      ],
      artifact: 'evidence-preflight.json',
      recordedAt: '2026-08-10T00:00:00.000Z',
    },
  };

  test('projects the gate as counters, gap literals, and the artifact name', () => {
    const summary = summarizeRefinementStatus({ context: { refinement: block } });
    expect(summary.handoffReason).toBe('evidence_required');
    expect(summary.evidence).toEqual({
      declared: 2,
      captured: 0,
      optionalGaps: 1,
      gaps: [
        {
          index: 0,
          reason: 'missing_path',
          requirement: 'required',
          predecessorIssueNumber: 10,
        },
      ],
      artifact: 'evidence-preflight.json',
    });
  });

  test('renders the gap an operator has to fix, without a declared path', () => {
    const summary = summarizeRefinementStatus({ context: { refinement: block } });
    const lines = renderRefinementLines(summary).join('\n');
    expect(lines).toContain('handoff=evidence_required');
    expect(lines).toContain('evidence: declared=2 captured=0 optionalGaps=1');
    expect(lines).toContain('artifact=evidence-preflight.json');
    expect(lines).toContain('gap[0]: missing_path (required) predecessor=#10');
    // §15/§16: the declared path lives in the local artifact only.
    expect(lines).not.toContain('src/core');
  });

  // Issue #977's rule: `admin task-status` and the admin UI render ONE model,
  // so the gap an operator reads cannot depend on which surface they opened.
  test('the admin UI detail view prints the same gap literals', () => {
    const task = { context: { refinement: block } };
    const ui = formatRefinementDetail(task, '2026-08-10T01:00:00.000Z').join('\n');
    expect(ui).toContain('evidence: declared=2 captured=0 optionalGaps=1');
    expect(ui).toContain('gap[0]: missing_path (required) predecessor=#10');
    expect(ui).not.toContain('src/core');
  });

  test('a block with no gate renders exactly as before', () => {
    const { evidenceGate: _drop, ...withoutGate } = block;
    const summary = summarizeRefinementStatus({ context: { refinement: withoutGate } });
    expect(summary.evidence).toBeNull();
    expect(renderRefinementLines(summary).join('\n')).not.toContain('evidence:');
  });
});
