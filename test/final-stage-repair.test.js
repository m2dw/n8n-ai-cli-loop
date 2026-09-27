// Issue #1104 — the fix input a failing `final` stage hands back to the
// implementation loop (docs/staged-verification-contract.md §7 rows 9 and 10).
//
// Pure: the bundle → fix-input translation and its refusals.

import {
  planFinalStageRepair,
  MAX_FINAL_REPAIR_TAIL_CHARS,
  MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS,
} from '../dist/core/final-stage-repair.js';

const HEAD = 'b'.repeat(40);
const REQ = `req:${'1'.repeat(64)}`;

const check = (overrides) => ({
  commandDigest: 'digest',
  ...overrides,
});

const bundle = (overrides = {}) => ({
  stageRunId: { taskAttempt: 3, lane: 'review', stage: 'final', stageOrdinal: 1 },
  planDigest: 'plan-digest-1',
  headSha: HEAD,
  outcome: 'code-failed',
  checks: [
    check({ checkId: 'exec:typecheck', name: 'typecheck', verdict: 'passed', exitCode: 0 }),
    check({ checkId: 'exec:test', name: 'test', verdict: 'failed', exitCode: 1, outputTail: 'FAIL test/auth.test.js\n  expected 1, got 2' }),
    check({ checkId: 'exec:package', name: 'package', verdict: 'not-run', notRunKind: 'first-failure-stop' }),
    check({ checkId: REQ, verdict: 'not-run', notRunKind: 'requirement-unproven' }),
  ],
  ...overrides,
});

describe('a code failure becomes one bounded fix input', () => {
  test('names the exact failing check id and the tested revision', () => {
    const plan = planFinalStageRepair(bundle());
    expect(plan.kind).toBe('repair');
    expect(plan.record).toEqual({
      stageRunKey: '3/review/final/1',
      testedRevision: HEAD,
      planDigest: 'plan-digest-1',
      outcome: 'code-failed',
      failing: [{ checkId: 'exec:test', name: 'test', verdict: 'failed', exitCode: 1 }],
      unprovenRequirementIds: [REQ],
      notProvenIds: ['exec:package'],
    });
    expect(plan.verificationFailure).toEqual({ name: 'test', checkId: 'exec:test', exitCode: 1 });

    expect(plan.feedback).toContain(`Tested revision: \`${HEAD}\``);
    expect(plan.feedback).toContain('`exec:test` (test) — failed, exit 1');
    expect(plan.feedback).toContain('expected 1, got 2');
    expect(plan.feedback).toContain(`Issue requirements left unproven by the failure: \`${REQ}\``);
    expect(plan.feedback).toContain('NOT known to pass: `exec:package` (package)');
    // A passing check is never listed as failing or unproven.
    expect(plan.feedback).not.toContain('exec:typecheck');
  });

  test('the persisted record carries no output bytes', () => {
    const plan = planFinalStageRepair(bundle());
    expect(JSON.stringify(plan.record)).not.toContain('expected 1, got 2');
  });

  test('the whole failing set is one input, in plan order', () => {
    const plan = planFinalStageRepair(bundle({
      checks: [
        check({ checkId: 'exec:lint', name: 'lint', verdict: 'failed', exitCode: 2, outputTail: 'lint boom' }),
        check({ checkId: 'exec:test', name: 'test', verdict: 'failed', exitCode: 1, outputTail: 'test boom' }),
      ],
    }));
    expect(plan.record.failing.map((c) => c.checkId)).toEqual(['exec:lint', 'exec:test']);
    expect(plan.verificationFailure.checkId).toBe('exec:lint');
    expect(plan.feedback).toContain('lint boom');
    expect(plan.feedback).toContain('test boom');
  });

  test('a timeout is labelled as output observed before the deadline, never as a failing case', () => {
    const plan = planFinalStageRepair(bundle({
      outcome: 'timed-out',
      checks: [check({ checkId: 'exec:test', name: 'test', verdict: 'timed-out', signal: 'SIGKILL', outputTail: 'last printed line' })],
    }));
    expect(plan.kind).toBe('repair');
    expect(plan.record.outcome).toBe('timed-out');
    expect(plan.record.failing[0]).toEqual({ checkId: 'exec:test', name: 'test', verdict: 'timed-out', signal: 'SIGKILL' });
    expect(plan.feedback).toContain('`exec:test` (test) — timed out, signal SIGKILL');
    expect(plan.feedback).toContain('Output observed before the deadline');
    expect(plan.verificationFailure).toEqual({ name: 'test', checkId: 'exec:test' });
  });

  test('diagnostics are bounded per check and in number of sections', () => {
    const huge = `HEAD-MARKER${'x'.repeat(MAX_FINAL_REPAIR_TAIL_CHARS * 2)}TAIL-MARKER`;
    const checks = Array.from({ length: MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS + 2 }, (_, i) =>
      check({ checkId: `exec:c${i}`, name: `c${i}`, verdict: 'failed', exitCode: 1, outputTail: huge }));
    const plan = planFinalStageRepair(bundle({ checks }));
    expect(plan.feedback).not.toContain('HEAD-MARKER');
    expect(plan.feedback.split('TAIL-MARKER')).toHaveLength(MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS + 1);
    expect(plan.feedback).toContain('2 more failing check(s)');
    expect(plan.feedback.length).toBeLessThan(
      (MAX_FINAL_REPAIR_TAIL_CHARS + 500) * MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS + 2_000,
    );
    // Every failing id is still named, with or without a section.
    expect(plan.record.failing).toHaveLength(MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS + 2);
    expect(plan.feedback).toContain(`\`exec:c${MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS + 1}\``);
  });
});

describe('what never reaches the fix loop', () => {
  test.each(['passed', 'interrupted', 'unknown', 'infrastructure'])(
    'a %s bundle is not a code failure',
    (outcome) => {
      expect(planFinalStageRepair(bundle({ outcome }))).toEqual({ kind: 'refused', reason: 'not-a-code-failure' });
    },
  );

  test('a code verdict with no failing check is refused (§7 rule 7)', () => {
    const plan = planFinalStageRepair(bundle({
      checks: [check({ checkId: 'exec:test', name: 'test', verdict: 'not-run', notRunKind: 'first-failure-stop' })],
    }));
    expect(plan).toEqual({ kind: 'refused', reason: 'no-failing-check' });
  });

  test.each([undefined, 'not-a-sha', ''])('an unattested revision (%p) is refused', (headSha) => {
    expect(planFinalStageRepair(bundle({ headSha }))).toEqual({ kind: 'refused', reason: 'tested-revision-unknown' });
  });
});
