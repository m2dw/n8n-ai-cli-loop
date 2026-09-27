/**
 * Issue #1125: the pure decision half of the explained no-change fix turn.
 *
 * `parseNoChangeDeclaration` reads at most one declaration out of an agent
 * response and answers whether it is admissible; `admitNoChangeRun` combines
 * that with the run's situation (fix turn, pending dispositions, live Tool
 * Request, turn cap, branch history). Neither runs a command, verifies
 * anything, or decides a phase — the handler owns all of that.
 */
import {
  MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS,
  MAX_NO_CHANGE_CARRIED_FEEDBACK_CHARS,
  MIN_NO_CHANGE_EXPLANATION_CHARS,
  NO_CHANGE_CONTEXT_FIELD,
  NO_CHANGE_REASONS,
  NO_CHANGE_TURNS_CONTEXT_FIELD,
  admitNoChangeRun,
  buildNoChangeContinuation,
  buildNoChangePromptSection,
  noChangeTurnsSpent,
  parseNoChangeDeclaration,
  readNoChangeContinuation,
} from '../dist/core/implementation-no-change.js';

const FEEDBACK =
  "[P1] Verification 'test' failed (exit 1):\n" +
  'FAIL test/hostname.test.js — expected mapping for "staging.example.com" to be present';

const EXPLANATION =
  'The hostname mappings the finding asks for are already present in src/hosts.ts and are exercised by the ' +
  'existing suite; the reported failure came from a host that could not resolve DNS during that run and does ' +
  'not reproduce on this revision.';

const FILE_REF = { kind: 'file', path: 'src/hosts.ts', startLine: 10, endLine: 24 };

function declaration(overrides = {}) {
  return {
    noChangeRequired: true,
    reason: 'not_reproducing',
    addressedFeedback: 'expected mapping for "staging.example.com" to be present',
    explanation: EXPLANATION,
    evidenceRefs: [FILE_REF],
    ...overrides,
  };
}

function block(value) {
  return `I reviewed the failure and changed nothing.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function parse(response, { feedback = FEEDBACK, resolves = true } = {}) {
  return parseNoChangeDeclaration({
    response,
    feedback,
    resolveEvidenceRef: () => resolves,
  });
}

describe('parseNoChangeDeclaration (issue #1125)', () => {
  test('admits a complete, evidence-backed declaration', () => {
    const result = parse(block(declaration()));
    expect(result.ok).toBe(true);
    expect(result.declaration).toEqual({
      reason: 'not_reproducing',
      addressedFeedback: 'expected mapping for "staging.example.com" to be present',
      explanation: EXPLANATION,
      evidenceRefs: [FILE_REF],
    });
  });

  test('every documented reason token is accepted', () => {
    for (const reason of NO_CHANGE_REASONS) {
      expect(parse(block(declaration({ reason }))).ok).toBe(true);
    }
  });

  // The ordinary "the agent just did nothing" run. Prose cannot be matched back
  // to the feedback, so it is not a declaration and the caller keeps today's
  // failure.
  test('prose with no fenced block is absent, not admitted', () => {
    const result = parse('Everything already passes, nothing to do.');
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'absent', detail: 'response:no-declaration-block' });
  });

  test('a json block carrying no noChangeRequired key is ignored, not fatal', () => {
    const response =
      '```json\n{"some": "config the agent quoted"}\n```\n' + block(declaration());
    expect(parse(response).ok).toBe(true);
  });

  test('two declarations are refused rather than picking a winner', () => {
    const result = parse(block(declaration()) + block(declaration({ reason: 'environmental' })));
    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe('too-many-items');
  });

  // An unreadable fence may BE the declaration — truncated, oversized — so
  // skipping it to accept a neighbouring one would silently drop the candidate
  // nobody can read.
  test('an unreadable json fence is fatal even when another block is clean', () => {
    const result = parse('```json\n{not valid json\n```\n' + block(declaration()));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'unparseable', detail: 'no-change-block:invalid-json' });
  });

  test('an oversized json fence is refused on the byte bound', () => {
    const huge = `\`\`\`json\n{"noChangeRequired": true, "pad": "${'x'.repeat(70 * 1024)}"}\n\`\`\``;
    const result = parse(huge);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'payload-too-large', detail: 'no-change-block' });
  });

  test('noChangeRequired must be exactly true', () => {
    const result = parse(block(declaration({ noChangeRequired: false })));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-record', detail: 'declaration.noChangeRequired:not-true' });
  });

  test('an unknown field is refused', () => {
    const result = parse(block({ ...declaration(), verdict: 'approved' }));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-record', detail: 'declaration.verdict:unknown-field' });
  });

  test('an unknown reason token is refused', () => {
    const result = parse(block(declaration({ reason: 'because_i_said_so' })));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-record', detail: 'declaration.reason' });
  });

  // Exit 0 plus a generic phrase is exactly what must NOT be enough.
  test('a generic one-line explanation is refused as too short', () => {
    const result = parse(block(declaration({ explanation: 'Nothing to do.' })));
    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe('explanation-too-short');
    expect('Nothing to do.'.length).toBeLessThan(MIN_NO_CHANGE_EXPLANATION_CHARS);
  });

  test('an addressedFeedback excerpt that is not in the feedback is refused', () => {
    const result = parse(block(declaration({ addressedFeedback: 'the reviewer said this PR looks great' })));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'feedback-not-quoted', detail: 'not-an-excerpt' });
  });

  test('a trivially short excerpt is refused before containment is even checked', () => {
    const result = parse(block(declaration({ addressedFeedback: 'failed' })));
    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe('feedback-not-quoted');
    expect(result.failure.detail).toMatch(/^chars:/);
  });

  // Containment is whitespace- and case-normalized, so a quote re-wrapped by the
  // agent still matches the feedback it came from.
  test('the excerpt match tolerates re-wrapped whitespace and case', () => {
    const result = parse(
      block(declaration({ addressedFeedback: 'Expected   mapping for\n"staging.example.com"\nto be present' })),
    );
    expect(result.ok).toBe(true);
  });

  test('evidenceRefs are required — an empty list is refused', () => {
    const result = parse(block(declaration({ evidenceRefs: [] })));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-record', detail: 'declaration.evidenceRefs' });
  });

  test('a malformed evidence reference is refused on shape', () => {
    const result = parse(block(declaration({ evidenceRefs: [{ kind: 'file', path: 'src/hosts.ts' }] })));
    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe('invalid-record');
  });

  // §3.3's posture: unverified and verified-present are not the same admission.
  test('an evidence reference that does not resolve sinks the declaration', () => {
    const result = parse(block(declaration()), { resolves: false });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'unresolvable-evidence', detail: 'declaration.evidenceRefs[0]' });
  });

  test('resolution is only attempted after the shape and content checks pass', () => {
    const seen = [];
    parseNoChangeDeclaration({
      response: block(declaration({ explanation: 'Nope.' })),
      feedback: FEEDBACK,
      resolveEvidenceRef: (ref) => {
        seen.push(ref);
        return true;
      },
    });
    expect(seen).toEqual([]);
  });
});

describe('admitNoChangeRun (issue #1125)', () => {
  const PUBLISHED_SHA = 'c'.repeat(40);

  function admission(overrides = {}) {
    return admitNoChangeRun({
      fixMode: true,
      structuredDispositionPending: false,
      unresolvedToolRequest: false,
      priorNoChangeTurns: 0,
      parseDeclaration: () => parse(block(declaration())),
      probeBranchCommits: () => 'has-issue-commits',
      probePublishedRevision: () => ({ status: 'published', revision: PUBLISHED_SHA }),
      ...overrides,
    });
  }

  test('admits a first fix turn with a clean declaration on a branch carrying commits', () => {
    const result = admission();
    expect(result.admitted).toBe(true);
    expect(result.turn).toBe(1);
    expect(result.declaration.reason).toBe('not_reproducing');
    // The admitted revision IS the one the publication probe confirmed, so no
    // caller can hand the reviewer a separately-read local HEAD.
    expect(result.revision).toBe(PUBLISHED_SHA);
  });

  // A fresh implementation that edits nothing keeps its failure, and must not
  // even pay for the parse.
  test('a non-fix turn is refused without parsing or probing', () => {
    let spent = 0;
    const result = admission({
      fixMode: false,
      parseDeclaration: () => { spent++; return parse(block(declaration())); },
      probeBranchCommits: () => { spent++; return 'has-issue-commits'; },
    });
    expect(result).toEqual({ admitted: false, reason: 'not-a-fix-turn', detail: null });
    expect(spent).toBe(0);
  });

  // §3.4 owns the zero-change question whenever a lineage awaits a disposition;
  // this path must never be a second route around the protocol.
  test('a run with structured dispositions pending is refused', () => {
    const result = admission({ structuredDispositionPending: true });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('structured-dispositions-pending');
  });

  test('an unresolved Tool Request is refused', () => {
    const result = admission({ unresolvedToolRequest: true });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('unresolved-tool-request');
  });

  test('consecutive no-change turns are bounded', () => {
    expect(admission({ priorNoChangeTurns: MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS - 1 }).admitted).toBe(true);
    const capped = admission({ priorNoChangeTurns: MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS });
    expect(capped.admitted).toBe(false);
    expect(capped.reason).toBe('turn-cap-reached');
    expect(capped.detail).toBe(`${MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS}/${MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS}`);
  });

  test('a refused declaration is reported with its parse failure', () => {
    const result = admission({ parseDeclaration: () => parse('nothing to do') });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('declaration-refused');
    expect(result.failure.reason).toBe('absent');
  });

  // A branch with nothing of this Issue's own — empty, or holding only a
  // predecessor's commits — has no implementation for an explanation to stand on.
  test('a branch with no issue commits is refused', () => {
    const result = admission({ probeBranchCommits: () => 'no-issue-commits' });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('no-issue-commits');
  });

  test('an unanswerable branch probe is refused, never read as empty', () => {
    const result = admission({ probeBranchCommits: () => 'unknown' });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('branch-probe-failed');
  });

  test('the branch probe is only spent once the declaration is admissible', () => {
    let probed = 0;
    admission({
      parseDeclaration: () => parse('nothing to do'),
      probeBranchCommits: () => { probed++; return 'has-issue-commits'; },
    });
    expect(probed).toBe(0);
  });

  // An admitted turn pushes nothing, so a revision origin does not serve as the
  // PR head would be verified and reviewed while the PR still shows the old one.
  test('a revision that is not the published PR head is refused', () => {
    const result = admission({
      probePublishedRevision: () => ({ status: 'unpublished', detail: 'local aaa != origin/ai/issue-77 bbb' }),
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('revision-unpublished');
    expect(result.detail).toBe('local aaa != origin/ai/issue-77 bbb');
  });

  test('an unresolvable published head is refused, never assumed to match', () => {
    const result = admission({
      probePublishedRevision: () => ({ status: 'unknown', detail: 'fetch:128' }),
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('published-revision-probe-failed');
  });

  // It is the only step that talks to the remote, so it goes last: a run refused
  // on any cheaper ground must not pay for a fetch.
  test('the publication probe is spent last, after the branch probe answers', () => {
    let published = 0;
    const probePublishedRevision = () => { published++; return { status: 'published', revision: PUBLISHED_SHA }; };
    admission({ parseDeclaration: () => parse('nothing to do'), probePublishedRevision });
    admission({ probeBranchCommits: () => 'no-issue-commits', probePublishedRevision });
    admission({ probeBranchCommits: () => 'unknown', probePublishedRevision });
    expect(published).toBe(0);
    expect(admission({ probePublishedRevision }).admitted).toBe(true);
    expect(published).toBe(1);
  });
});

describe('no-change continuation record (issue #1125)', () => {
  const continuation = buildNoChangeContinuation({
    declaration: {
      reason: 'not_reproducing',
      addressedFeedback: 'expected mapping for "staging.example.com" to be present',
      explanation: EXPLANATION,
      evidenceRefs: [FILE_REF],
    },
    revision: 'a'.repeat(40),
    runId: 'run-impl-9',
    turn: 1,
    feedback: FEEDBACK,
  });

  test('round-trips through task context', () => {
    expect(readNoChangeContinuation({ [NO_CHANGE_CONTEXT_FIELD]: continuation })).toEqual(continuation);
  });

  test('the carried feedback is bounded for storage', () => {
    const long = buildNoChangeContinuation({
      declaration: continuation,
      revision: 'b'.repeat(40),
      runId: 'run-impl-9',
      turn: 1,
      feedback: 'x'.repeat(MAX_NO_CHANGE_CARRIED_FEEDBACK_CHARS + 500),
    });
    expect(long.feedback.length).toBeLessThan(MAX_NO_CHANGE_CARRIED_FEEDBACK_CHARS + 100);
    expect(long.feedback).toMatch(/truncated for storage/);
  });

  test('a malformed or absent record reads as undefined rather than half-trusted', () => {
    expect(readNoChangeContinuation(undefined)).toBeUndefined();
    expect(readNoChangeContinuation({})).toBeUndefined();
    expect(readNoChangeContinuation({ [NO_CHANGE_CONTEXT_FIELD]: 'nope' })).toBeUndefined();
    expect(
      readNoChangeContinuation({ [NO_CHANGE_CONTEXT_FIELD]: { ...continuation, revision: '' } }),
    ).toBeUndefined();
    expect(
      readNoChangeContinuation({ [NO_CHANGE_CONTEXT_FIELD]: { ...continuation, reason: 'invented' } }),
    ).toBeUndefined();
    expect(
      readNoChangeContinuation({ [NO_CHANGE_CONTEXT_FIELD]: { ...continuation, evidenceRefs: [{ kind: 'file' }] } }),
    ).toBeUndefined();
  });

  test('the turn counter reads defensively', () => {
    expect(noChangeTurnsSpent(undefined)).toBe(0);
    expect(noChangeTurnsSpent({})).toBe(0);
    expect(noChangeTurnsSpent({ [NO_CHANGE_TURNS_CONTEXT_FIELD]: 'two' })).toBe(0);
    expect(noChangeTurnsSpent({ [NO_CHANGE_TURNS_CONTEXT_FIELD]: -3 })).toBe(0);
    expect(noChangeTurnsSpent({ [NO_CHANGE_TURNS_CONTEXT_FIELD]: 2 })).toBe(2);
  });
});

describe('no-change prompt section (issue #1125)', () => {
  test('offers only the evidence kinds the runner can resolve on this run', () => {
    const withBody = buildNoChangePromptSection({
      resolvableEvidenceKinds: ['file', 'doc_section', 'issue_quote'],
    }).join('\n');
    expect(withBody).toContain('"kind": "issue_quote"');

    const withoutBody = buildNoChangePromptSection({
      resolvableEvidenceKinds: ['file', 'doc_section'],
    }).join('\n');
    expect(withoutBody).not.toContain('issue_quote');
    expect(withoutBody).toContain('"kind": "file"');
  });

  // The instruction the agent reads and the parser the runner applies must not
  // drift: every reason token the contract accepts is offered.
  test('lists every reason token and refuses to promise the agent its own PASS counts', () => {
    const section = buildNoChangePromptSection({ resolvableEvidenceKinds: ['file'] }).join('\n');
    for (const reason of NO_CHANGE_REASONS) expect(section).toContain(`"${reason}"`);
    expect(section).toContain('Do NOT claim a verification command passed as your evidence');
  });
});
