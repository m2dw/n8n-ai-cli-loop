import { classifyReviewOutput } from '../dist/core/review-classifier.js';

describe('classifyReviewOutput — conflict (strong, structural evidence only)', () => {
  test('Git conflict markers (<<<<<<<) -> conflict', () => {
    expect(classifyReviewOutput('<<<<<<< HEAD\nsome code\n>>>>>>> branch')).toMatchObject({ classification: 'conflict' });
  });

  test('Git "CONFLICT (content):" output -> conflict', () => {
    expect(classifyReviewOutput('CONFLICT (content): Merge conflict in README.md')).toMatchObject({ classification: 'conflict' });
  });

  test('"Automatic merge failed" -> conflict', () => {
    expect(classifyReviewOutput('Automatic merge failed; fix conflicts and then commit the result.')).toMatchObject({ classification: 'conflict' });
  });

  test('"merging is not possible because you have unmerged files" -> conflict', () => {
    expect(classifyReviewOutput('error: Merging is not possible because you have unmerged files.')).toMatchObject({ classification: 'conflict' });
  });

  test('conflict classification sets hasConflictSignal: true', () => {
    const r = classifyReviewOutput('<<<<<<< HEAD\nx\n>>>>>>> theirs');
    expect(r.hasConflictSignal).toBe(true);
    expect(r.hasBlockingFindings).toBe(false);
  });
});

describe('classifyReviewOutput — conflict false positives (issue #168)', () => {
  // The codex review output is freeform discussion of the diff. Generic prose,
  // failing test names, and assertions that merely mention conflicts must NOT be
  // classified as a real Git merge conflict (that triggered false escalations on
  // PRs about conflict-handling code, e.g. #135 / PR #162).

  test('#135-style failing-test output is NOT a conflict', () => {
    const output = [
      'review handler — result classification › merge conflict in codex output -> result: blocked',
      'Expected: "blocked"',
      'Received: "conflict"',
      'phase: "conflict_resolution"',
    ].join('\n');
    const r = classifyReviewOutput(output);
    expect(r.classification).not.toBe('conflict');
    expect(r.hasConflictSignal).toBe(false);
  });

  test('prose "merge conflict in src/foo.ts" alone is NOT a conflict', () => {
    const r = classifyReviewOutput('merge conflict in src/foo.ts');
    expect(r.hasConflictSignal).toBe(false);
    expect(r.classification).not.toBe('conflict');
  });

  test('prose "cannot merge" alone is NOT a conflict', () => {
    const r = classifyReviewOutput('cannot merge: diverged history');
    expect(r.hasConflictSignal).toBe(false);
    expect(r.classification).not.toBe('conflict');
  });

  test('reviewing conflict-handling code stays a normal review', () => {
    const r = classifyReviewOutput('The change correctly handles the merge conflict transition; conflict_resolution semantics look right. LGTM.');
    expect(r.classification).toBe('success');
  });

  test('conflict-named test failure with a [P1] finding -> needs_fix, not conflict', () => {
    const r = classifyReviewOutput('[P1] conflict_resolution test fails: Received "conflict" but Expected "blocked"');
    expect(r.classification).toBe('needs_fix');
  });
});

describe('classifyReviewOutput — needs_fix', () => {
  test('[P1] finding -> needs_fix', () => {
    expect(classifyReviewOutput('Review findings:\n- [P1] Null pointer in auth handler')).toMatchObject({ classification: 'needs_fix' });
  });

  test('[P2] finding -> needs_fix', () => {
    expect(classifyReviewOutput('- [P2] Missing input validation on /api/login')).toMatchObject({ classification: 'needs_fix' });
  });

  test('"blocking finding" -> needs_fix', () => {
    expect(classifyReviewOutput('This is a blocking finding: XSS vulnerability')).toMatchObject({ classification: 'needs_fix' });
  });

  test('"blocker" keyword -> needs_fix', () => {
    expect(classifyReviewOutput('Found a blocker in the authentication flow')).toMatchObject({ classification: 'needs_fix' });
  });

  test('needs_fix sets hasBlockingFindings: true', () => {
    const r = classifyReviewOutput('[P1] critical bug');
    expect(r.hasBlockingFindings).toBe(true);
    expect(r.hasConflictSignal).toBe(false);
  });

  test('counts multiple [P1]/[P2] markers', () => {
    const r = classifyReviewOutput('[P1] auth issue\n[P2] validation missing\n[P1] SQL injection');
    expect(r.findingCount).toBe(3);
  });
});

describe('classifyReviewOutput — requirement fit (issue #174)', () => {
  test('"does not satisfy acceptance criterion" -> needs_fix', () => {
    const r = classifyReviewOutput('The implementation does not satisfy acceptance criterion: rate limiting is not enforced.');
    expect(r).toMatchObject({ classification: 'needs_fix', hasBlockingFindings: true });
  });

  test('"Missing acceptance criterion" -> needs_fix', () => {
    const r = classifyReviewOutput('Missing acceptance criterion: login throttling is not implemented.');
    expect(r.classification).toBe('needs_fix');
  });

  test('"misses the acceptance criteria" (no [P1] marker) -> needs_fix', () => {
    const r = classifyReviewOutput('The PR misses the acceptance criteria for per-IP rate limiting.');
    expect(r.classification).toBe('needs_fix');
  });

  test('"acceptance criterion ... is unmet" -> needs_fix', () => {
    const r = classifyReviewOutput('Acceptance criterion for input validation is unmet.');
    expect(r.classification).toBe('needs_fix');
  });

  test('"unmet requirement" -> needs_fix', () => {
    const r = classifyReviewOutput('There is an unmet requirement: the endpoint must reject empty payloads.');
    expect(r.classification).toBe('needs_fix');
  });

  test('requirement-miss reason mentions the acceptance criterion', () => {
    const r = classifyReviewOutput('Acceptance criterion is not met for rate limiting.');
    expect(r.reason).toMatch(/requirement|acceptance criterion/i);
  });

  test('"all acceptance criteria are met" stays success', () => {
    const r = classifyReviewOutput('All acceptance criteria are met. Code looks good.');
    expect(r.classification).toBe('success');
  });

  test('plain mention of requirements without a miss stays success', () => {
    const r = classifyReviewOutput('The PR addresses the stated requirements and acceptance criteria correctly.');
    expect(r.classification).toBe('success');
  });
});

describe('classifyReviewOutput — success', () => {
  test('no findings -> success', () => {
    expect(classifyReviewOutput('No P1/P2 findings. Code looks good.')).toMatchObject({ classification: 'success' });
  });

  test('LGTM output -> success', () => {
    expect(classifyReviewOutput('LGTM. The implementation follows the existing patterns.')).toMatchObject({ classification: 'success' });
  });

  test('output with P3/P4 only -> success (not blocking)', () => {
    expect(classifyReviewOutput('[P3] Minor style nit: prefer const over let')).toMatchObject({ classification: 'success' });
  });

  test('success has hasBlockingFindings: false, hasConflictSignal: false', () => {
    const r = classifyReviewOutput('Looks good.');
    expect(r.hasBlockingFindings).toBe(false);
    expect(r.hasConflictSignal).toBe(false);
    expect(r.findingCount).toBe(0);
  });
});

describe('classifyReviewOutput — blocked', () => {
  test('empty output -> blocked', () => {
    expect(classifyReviewOutput('')).toMatchObject({ classification: 'blocked' });
  });

  test('whitespace-only output -> blocked', () => {
    expect(classifyReviewOutput('   \n  ')).toMatchObject({ classification: 'blocked' });
  });

  test('"human review required" -> blocked', () => {
    expect(classifyReviewOutput('Human review required: ambiguous change semantics')).toMatchObject({ classification: 'blocked' });
  });

  test('"needs human decision" -> blocked', () => {
    expect(classifyReviewOutput('This needs human decision on the API design')).toMatchObject({ classification: 'blocked' });
  });

  test('"manual review required" -> blocked', () => {
    expect(classifyReviewOutput('Manual review required for this security-sensitive change')).toMatchObject({ classification: 'blocked' });
  });

  test('blocked has hasBlockingFindings: false', () => {
    const r = classifyReviewOutput('');
    expect(r.hasBlockingFindings).toBe(false);
  });
});

describe('classifyReviewOutput — conflict takes priority over needs_fix', () => {
  test('real conflict marker overrides P1 finding', () => {
    const r = classifyReviewOutput('<<<<<<< HEAD\nx\n>>>>>>> theirs\n[P1] also a blocking issue');
    expect(r.classification).toBe('conflict');
  });
});
