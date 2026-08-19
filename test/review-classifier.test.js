import {
  MAX_TRANSIENT_VERIFICATION_RETRIES,
  classifyReviewOutput,
  classifyVerificationFailure,
  clearTransientVerificationRetries,
  recordTransientVerificationRetry,
  transientVerificationRetriesFor,
} from '../dist/core/review-classifier.js';
import { CLI_PROBE_INDETERMINATE_MARKER } from '../dist/core/cli-probe.js';

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

describe('classifyVerificationFailure — transient probe failures (#897)', () => {
  test('an indeterminate CLI probe in the output is transient, and names its signal', () => {
    const output = `FAIL test/admin-cli.test.js\n  Received: "${CLI_PROBE_INDETERMINATE_MARKER} claude timed out"`;
    expect(classifyVerificationFailure(output)).toEqual({
      transient: true, signal: CLI_PROBE_INDETERMINATE_MARKER,
    });
  });

  test('an ordinary test failure is not transient', () => {
    for (const output of [
      '',
      'FAIL test/foo.test.js\n  ● expected 1 received 2',
      'Error: Cannot find module "left-pad"',
    ]) {
      expect(classifyVerificationFailure(output)).toEqual({ transient: false });
    }
  });

  test('prose about probes, timeouts and unavailable CLIs is not evidence', () => {
    // Verification output quotes these words constantly. Only the structural
    // marker counts, or the rule would start delaying real test failures.
    for (const output of [
      'the cli probe was indeterminate',
      'Timeout - Async callback was not invoked within the 5000 ms timeout',
      'claude: cli-unavailable',
      'spawn claude EAGAIN',
    ]) {
      expect(classifyVerificationFailure(output).transient).toBe(false);
    }
  });

  test('the retry bound is small and positive', () => {
    // Unbounded delays would strand the task where no human is looking.
    expect(MAX_TRANSIENT_VERIFICATION_RETRIES).toBeGreaterThan(0);
    expect(MAX_TRANSIENT_VERIFICATION_RETRIES).toBeLessThanOrEqual(3);
  });
});

describe('transient verification retry ledger — per command (#897)', () => {
  const LEDGER = 'verificationTransientRetriesByStep';

  test('a fresh context has spent nothing', () => {
    for (const ctx of [undefined, {}, { [LEDGER]: 'nope' }, { [LEDGER]: ['test'] }]) {
      expect(transientVerificationRetriesFor(ctx, 'test')).toBe(0);
    }
  });

  test('one command spending its budget leaves every other command a full one', () => {
    const ctx = { [LEDGER]: { test: MAX_TRANSIENT_VERIFICATION_RETRIES } };
    expect(transientVerificationRetriesFor(ctx, 'test')).toBe(MAX_TRANSIENT_VERIFICATION_RETRIES);
    expect(transientVerificationRetriesFor(ctx, 'package')).toBe(0);
  });

  test('junk counters are ignored rather than trusted', () => {
    const ctx = { [LEDGER]: { a: 0, b: -1, c: 1.5, d: '2', e: null, f: 2 } };
    for (const step of ['a', 'b', 'c', 'd', 'e']) {
      expect(transientVerificationRetriesFor(ctx, step)).toBe(0);
    }
    expect(transientVerificationRetriesFor(ctx, 'f')).toBe(2);
  });

  test('a pre-ledger scalar counts only against the step it was recorded for', () => {
    const ctx = { verificationTransientRetries: 2, transientVerificationStep: 'test' };
    expect(transientVerificationRetriesFor(ctx, 'test')).toBe(2);
    expect(transientVerificationRetriesFor(ctx, 'package')).toBe(0);
  });

  test('a scalar with no recorded step still bounds whichever command is failing', () => {
    // Never widen a budget that is already in flight: with no step recorded the
    // scalar is all that is known about the task's spend.
    const ctx = { verificationTransientRetries: 2 };
    expect(transientVerificationRetriesFor(ctx, 'anything')).toBe(2);
  });

  test('recording a retry keeps other pending spend and drops the commands that passed', () => {
    const ctx = { [LEDGER]: { test: 2, typecheck: 1 } };
    expect(recordTransientVerificationRetry({
      ctx, step: 'package', attempt: 1, passedSteps: ['test'],
    })).toEqual({ typecheck: 1, package: 1 });
  });

  test('recording migrates a pre-ledger scalar onto its own step', () => {
    const ctx = { verificationTransientRetries: 2, transientVerificationStep: 'test' };
    expect(recordTransientVerificationRetry({
      ctx, step: 'package', attempt: 1, passedSteps: [],
    })).toEqual({ test: 2, package: 1 });
  });

  test('clearing after a full pass releases the ledger and the legacy scalar (#934)', () => {
    const ctx = {
      [LEDGER]: { test: MAX_TRANSIENT_VERIFICATION_RETRIES },
      verificationTransientRetries: MAX_TRANSIENT_VERIFICATION_RETRIES,
      transientVerificationStep: 'test',
      transientVerificationSignal: '[cli-probe-indeterminate]',
    };
    const patch = clearTransientVerificationRetries(ctx, ['test', 'package', 'typecheck']);
    expect(patch[LEDGER]).toBeUndefined();
    expect(patch.verificationTransientRetries).toBeUndefined();
    expect(patch.transientVerificationStep).toBeUndefined();
    expect(patch.transientVerificationSignal).toBeUndefined();
    // The next phase's first transient failure of the same command gets a full budget.
    expect(transientVerificationRetriesFor({ ...ctx, ...patch }, 'test')).toBe(0);
  });

  test('clearing keeps spend for a command that did not pass', () => {
    const ctx = { [LEDGER]: { test: 1, package: 2 } };
    const patch = clearTransientVerificationRetries(ctx, ['test']);
    expect(patch[LEDGER]).toEqual({ package: 2 });
    expect(transientVerificationRetriesFor({ ...ctx, ...patch }, 'package')).toBe(2);
  });

  test('clearing keeps a pre-ledger scalar naming a command that did not pass', () => {
    const ctx = { verificationTransientRetries: 2, transientVerificationStep: 'package' };
    const patch = clearTransientVerificationRetries(ctx, ['test']);
    expect(patch).not.toHaveProperty('verificationTransientRetries');
    expect(transientVerificationRetriesFor({ ...ctx, ...patch }, 'package')).toBe(2);
  });

  test('clearing drops a step-less scalar once any command has answered', () => {
    // With no step recorded the scalar is the whole task's count, so a command
    // that passed is enough to make it stale for every command.
    const ctx = { verificationTransientRetries: 2 };
    const patch = clearTransientVerificationRetries(ctx, ['test']);
    expect(transientVerificationRetriesFor({ ...ctx, ...patch }, 'anything')).toBe(0);
  });

  test('clearing a fresh context is a no-op patch', () => {
    expect(clearTransientVerificationRetries(undefined, ['test'])[LEDGER]).toBeUndefined();
    expect(clearTransientVerificationRetries({}, [])[LEDGER]).toBeUndefined();
  });
});
