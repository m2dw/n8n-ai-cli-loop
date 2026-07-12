import { resolveDependencyExecutionPlan } from '../dist/handlers/dependency-plan.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDepChecker(entries) {
  return { async getBlockedBy() { return entries; } };
}

function makeRunner(steps) {
  let i = 0;
  return {
    run(_cmd, _args, _opts) {
      const result = steps[i] ?? { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      i++;
      return result;
    },
  };
}

function prListJson(prs) {
  return JSON.stringify(prs);
}

const REPO = 'm2dw/test-repo';
const CWD = '/repo';
const READY_LABEL = 'ai:ready-for-human';

const STACK_READY_LABEL = 'status:stack-ready';

function opts(depChecker, runner) {
  return { depChecker, runner, githubRepo: REPO, cwd: CWD, readyForHumanLabel: READY_LABEL };
}

function optsWithStackReady(depChecker, runner) {
  return { depChecker, runner, githubRepo: REPO, cwd: CWD, readyForHumanLabel: READY_LABEL, stackReadyLabel: STACK_READY_LABEL };
}

function issueViewJson(labels) {
  return JSON.stringify({ labels: labels.map((name) => ({ name })) });
}

// ---------------------------------------------------------------------------
// No blockers
// ---------------------------------------------------------------------------

describe('dependency plan — no blockers', () => {
  test('returns kind:none when getBlockedBy returns empty array', async () => {
    const plan = await resolveDependencyExecutionPlan(42, opts(makeDepChecker([]), makeRunner([])));
    expect(plan.kind).toBe('none');
  });

  test('does not call the runner when there are no blockers', async () => {
    let called = false;
    const runner = { run() { called = true; return { stdout: '', stderr: '', exitCode: 0 }; } };
    await resolveDependencyExecutionPlan(42, opts(makeDepChecker([]), runner));
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Closed blockers only
// ---------------------------------------------------------------------------

describe('dependency plan — closed blockers only', () => {
  test('returns kind:none when all blockers are closed', async () => {
    const checker = makeDepChecker([
      { issueNumber: 10, state: 'closed' },
      { issueNumber: 11, state: 'closed' },
    ]);
    const plan = await resolveDependencyExecutionPlan(42, opts(checker, makeRunner([])));
    expect(plan.kind).toBe('none');
  });

  test('does not call the runner when blockers are all closed', async () => {
    let called = false;
    const runner = { run() { called = true; return { stdout: '', stderr: '', exitCode: 0 }; } };
    const checker = makeDepChecker([{ issueNumber: 10, state: 'closed' }]);
    await resolveDependencyExecutionPlan(42, opts(checker, runner));
    expect(called).toBe(false);
  });

  test('returns kind:none when there is a mix of closed and no open blockers', async () => {
    const checker = makeDepChecker([{ issueNumber: 5, state: 'closed' }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, makeRunner([])));
    expect(plan.kind).toBe('none');
  });

  test('returns kind:none when blocker is closed as completed', async () => {
    const checker = makeDepChecker([{ issueNumber: 10, state: 'closed', stateReason: 'completed' }]);
    const plan = await resolveDependencyExecutionPlan(42, opts(checker, makeRunner([])));
    expect(plan.kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Blockers closed as not_planned
// ---------------------------------------------------------------------------

describe('dependency plan — not_planned blockers', () => {
  test('returns kind:unsupported when the single blocker is closed as not_planned', async () => {
    const checker = makeDepChecker([{ issueNumber: 10, state: 'closed', stateReason: 'not_planned' }]);
    const plan = await resolveDependencyExecutionPlan(42, opts(checker, makeRunner([])));
    expect(plan.kind).toBe('unsupported');
  });

  test('reason message names the not_planned blocker issue', async () => {
    const checker = makeDepChecker([{ issueNumber: 10, state: 'closed', stateReason: 'not_planned' }]);
    const plan = await resolveDependencyExecutionPlan(42, opts(checker, makeRunner([])));
    expect(plan.reason).toContain('#10');
    expect(plan.reason).toContain('not-planned');
  });

  test('blockers field includes the not_planned entry', async () => {
    const checker = makeDepChecker([{ issueNumber: 10, state: 'closed', stateReason: 'not_planned' }]);
    const plan = await resolveDependencyExecutionPlan(42, opts(checker, makeRunner([])));
    expect(plan.blockers).toEqual([{ issueNumber: 10, state: 'closed', stateReason: 'not_planned' }]);
  });

  test('allBlockers field includes the not_planned entry', async () => {
    const checker = makeDepChecker([{ issueNumber: 10, state: 'closed', stateReason: 'not_planned' }]);
    const plan = await resolveDependencyExecutionPlan(42, opts(checker, makeRunner([])));
    expect(plan.allBlockers).toEqual([{ issueNumber: 10, state: 'closed', stateReason: 'not_planned' }]);
  });

  test('returns kind:unsupported when not_planned blockers coexist with open blockers', async () => {
    const checker = makeDepChecker([
      { issueNumber: 10, state: 'closed', stateReason: 'not_planned' },
      { issueNumber: 20, state: 'open' },
    ]);
    const plan = await resolveDependencyExecutionPlan(42, opts(checker, makeRunner([])));
    expect(plan.kind).toBe('unsupported');
    expect(plan.reason).toContain('#10');
  });

  test('does not call the runner for a not_planned blocker', async () => {
    let called = false;
    const runner = { run() { called = true; return { stdout: '', stderr: '', exitCode: 0 }; } };
    const checker = makeDepChecker([{ issueNumber: 10, state: 'closed', stateReason: 'not_planned' }]);
    await resolveDependencyExecutionPlan(42, opts(checker, runner));
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// One open blocker with usable PR
// ---------------------------------------------------------------------------

describe('dependency plan — one open blocker with usable PR', () => {
  const BLOCKER_PR = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: 'ai/issue-50', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  // The blocker's review PASSED, signalled by the success-specific stack-ready
  // marker — the readyForHuman label is no longer accepted as that signal because
  // it is also applied to escalated reviews that did not pass (issue #208).
  const READY_ISSUE_VIEW = { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 };

  test('returns kind:ready', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 }, READY_ISSUE_VIEW]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.kind).toBe('ready');
  });

  test('ready plan includes baseIssueNumber', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 }, READY_ISSUE_VIEW]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.baseIssueNumber).toBe(50);
  });

  test('ready plan includes basePrNumber', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 }, READY_ISSUE_VIEW]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.basePrNumber).toBe(77);
  });

  test('ready plan includes baseHeadRefName', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 }, READY_ISSUE_VIEW]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.baseHeadRefName).toBe('ai/issue-50');
  });

  test('ready plan includes basePrUrl', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 }, READY_ISSUE_VIEW]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.basePrUrl).toBe('https://github.com/m2dw/test-repo/pull/77');
  });

  test('gh pr list is called with the blocker branch head', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    let capturedArgs;
    let callCount = 0;
    const runner = {
      run(_cmd, args, _opts) {
        callCount++;
        if (callCount === 1) {
          capturedArgs = args;
          return { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 };
        }
        return { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 };
      },
    };
    await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(capturedArgs).toContain('ai/issue-50');
    expect(capturedArgs).toContain('--head');
  });

  test('ignores closed blockers alongside an open one', async () => {
    const checker = makeDepChecker([
      { issueNumber: 10, state: 'closed' },
      { issueNumber: 50, state: 'open' },
    ]);
    const runner = makeRunner([{ stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 }, READY_ISSUE_VIEW]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.kind).toBe('ready');
    expect(plan.baseIssueNumber).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// One open blocker without PR
// ---------------------------------------------------------------------------

describe('dependency plan — one open blocker without PR', () => {
  test('returns kind:blocked when gh pr list returns empty array', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: '[]', stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
  });

  test('blocked reason mentions the blocker issue number', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: '[]', stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.reason).toContain('50');
  });

  test('blocked result includes blockers array', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: '[]', stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.blockers).toEqual([{ issueNumber: 50, state: 'open' }]);
  });

  test('returns kind:blocked when gh pr list command fails', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: '', stderr: 'gh: auth error', exitCode: 1 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
    expect(plan.reason).toContain('50');
  });

  test('returns kind:blocked when gh pr list returns non-JSON', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([{ stdout: 'not json', stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
  });

  test('returns kind:blocked when PR has no headRefName', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const prNoRef = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: '', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
    const runner = makeRunner([{ stdout: prListJson([prNoRef]), stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
    expect(plan.reason).toContain('headRefName');
  });
});

// ---------------------------------------------------------------------------
// Multiple open blockers
// ---------------------------------------------------------------------------

describe('dependency plan — multiple open blockers', () => {
  test('returns kind:unsupported when two open blockers exist', async () => {
    const checker = makeDepChecker([
      { issueNumber: 10, state: 'open' },
      { issueNumber: 20, state: 'open' },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, makeRunner([])));
    expect(plan.kind).toBe('unsupported');
  });

  test('unsupported reason mentions the issue number', async () => {
    const checker = makeDepChecker([
      { issueNumber: 10, state: 'open' },
      { issueNumber: 20, state: 'open' },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, makeRunner([])));
    expect(plan.reason).toContain('99');
  });

  test('unsupported result includes all open blockers', async () => {
    const checker = makeDepChecker([
      { issueNumber: 10, state: 'open' },
      { issueNumber: 20, state: 'open' },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, makeRunner([])));
    expect(plan.blockers).toHaveLength(2);
    expect(plan.blockers.map((b) => b.issueNumber)).toEqual(expect.arrayContaining([10, 20]));
  });

  test('does not call the runner when multiple open blockers exist', async () => {
    let called = false;
    const runner = { run() { called = true; return { stdout: '', stderr: '', exitCode: 0 }; } };
    const checker = makeDepChecker([
      { issueNumber: 10, state: 'open' },
      { issueNumber: 20, state: 'open' },
    ]);
    await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(called).toBe(false);
  });

  test('returns kind:unsupported for three open blockers', async () => {
    const checker = makeDepChecker([
      { issueNumber: 1, state: 'open' },
      { issueNumber: 2, state: 'open' },
      { issueNumber: 3, state: 'open' },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, makeRunner([])));
    expect(plan.kind).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// Conflicted / dirty blocker PR
// ---------------------------------------------------------------------------

describe('dependency plan — conflicted blocker PR', () => {
  test('returns kind:blocked when mergeable is CONFLICTING', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const pr = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: 'ai/issue-50', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    const runner = makeRunner([{ stdout: prListJson([pr]), stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
  });

  test('blocked reason mentions the conflicted state', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const pr = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: 'ai/issue-50', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    const runner = makeRunner([{ stdout: prListJson([pr]), stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.reason).toContain('CONFLICTING');
  });

  test('returns kind:blocked when mergeStateStatus is DIRTY (even if mergeable is MERGEABLE)', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const pr = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: 'ai/issue-50', mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' };
    const runner = makeRunner([{ stdout: prListJson([pr]), stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
    expect(plan.reason).toContain('DIRTY');
  });

  test('blocked result includes the open blocker in blockers array', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const pr = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: 'ai/issue-50', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    const runner = makeRunner([{ stdout: prListJson([pr]), stderr: '', exitCode: 0 }]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.blockers).toEqual([{ issueNumber: 50, state: 'open' }]);
  });

  test('returns kind:ready for UNKNOWN mergeable (not yet computed)', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const pr = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: 'ai/issue-50', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
    const runner = makeRunner([
      { stdout: prListJson([pr]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.kind).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// Blocker PR exists but blocker issue is not ready-for-human
// ---------------------------------------------------------------------------

describe('dependency plan — blocker PR unreviewed / not ready', () => {
  const BLOCKER_PR = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: 'ai/issue-50', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };

  test('returns kind:blocked when blocker issue is missing the readyForHuman label', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson(['status:needs-review', 'agent:codex']), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
  });

  test('blocked reason mentions the missing readyForHuman label', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson(['status:needs-review']), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.reason).toContain(READY_LABEL);
    expect(plan.reason).toContain('50');
  });

  test('returns kind:blocked when blocker issue is in status:needs-fix', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson(['status:needs-fix', 'agent:claude']), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
  });

  test('returns kind:blocked when gh issue view fails', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'gh: not found', exitCode: 1 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
    expect(plan.reason).toContain('50');
  });

  test('returns kind:blocked when gh issue view returns non-JSON', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: 'not json', stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
  });

  test('blocked result includes the open blocker in blockers array', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson(['status:needs-review']), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.blockers).toEqual([{ issueNumber: 50, state: 'open' }]);
  });
});

// ---------------------------------------------------------------------------
// Reviewed-but-still-stacked blocker (stackReady marker, issue #208 A<-B<-C)
// ---------------------------------------------------------------------------

describe('dependency plan — reviewed stacked blocker (stackReady marker)', () => {
  const BLOCKER_PR = { number: 77, url: 'https://github.com/m2dw/test-repo/pull/77', headRefName: 'ai/issue-50', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };

  test('returns kind:ready when blocker has stackReady label (no readyForHuman) and stackReadyLabel is configured', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson([STACK_READY_LABEL, 'ai:blocked']), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.kind).toBe('ready');
    expect(plan.baseIssueNumber).toBe(50);
  });

  test('still returns kind:blocked for the stackReady label when stackReadyLabel is NOT configured', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson([STACK_READY_LABEL, 'ai:blocked']), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
  });

  test('blocked reason mentions both the readyForHuman and stackReady labels when stackReadyLabel is configured', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson(['status:needs-review']), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.kind).toBe('blocked');
    expect(plan.reason).toContain(READY_LABEL);
    expect(plan.reason).toContain(STACK_READY_LABEL);
  });

  test('readyForHuman label alone does NOT resolve ready — it is also applied to escalated reviews', async () => {
    // A blocker carrying only readyForHuman (no stack-ready marker) is NOT a
    // usable stacking base: readyForHuman is applied both to passing reviews and
    // to escalated (failed) ones, so it cannot confirm the blocker's review passed
    // (issue #208 review follow-up).
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const runner = makeRunner([
      { stdout: prListJson([BLOCKER_PR]), stderr: '', exitCode: 0 },
      { stdout: issueViewJson([READY_LABEL]), stderr: '', exitCode: 0 },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, optsWithStackReady(checker, runner));
    expect(plan.kind).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// Full dependency snapshot on blocked/unsupported plans (allBlockers)
// ---------------------------------------------------------------------------

describe('dependency plan — full relationship snapshot (allBlockers)', () => {
  test('blocked plan records all blockers (open + closed), while blockers holds only the open subset', async () => {
    const checker = makeDepChecker([
      { issueNumber: 49, state: 'closed' },
      { issueNumber: 50, state: 'open' },
    ]);
    const runner = makeRunner([{ stdout: '[]', stderr: '', exitCode: 0 }]); // blocker has no open PR
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, runner));
    expect(plan.kind).toBe('blocked');
    expect(plan.blockers).toEqual([{ issueNumber: 50, state: 'open' }]);
    expect(plan.allBlockers).toEqual([
      { issueNumber: 49, state: 'closed' },
      { issueNumber: 50, state: 'open' },
    ]);
  });

  test('unsupported plan records all blockers including closed ones in allBlockers', async () => {
    const checker = makeDepChecker([
      { issueNumber: 5, state: 'closed' },
      { issueNumber: 10, state: 'open' },
      { issueNumber: 20, state: 'open' },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, opts(checker, makeRunner([])));
    expect(plan.kind).toBe('unsupported');
    expect(plan.blockers).toHaveLength(2);
    expect(plan.allBlockers).toHaveLength(3);
    expect(plan.allBlockers.map((b) => b.issueNumber)).toEqual(expect.arrayContaining([5, 10, 20]));
  });
});

// ---------------------------------------------------------------------------
// Non-GitHub work-item provider — stacking unsupported, fail closed before any
// GitHub label read (issue #382 review follow-up)
// ---------------------------------------------------------------------------

describe('dependency plan — non-GitHub work-item provider (gitea-issues)', () => {
  function giteaOpts(depChecker, runner) {
    return {
      depChecker,
      runner,
      githubRepo: REPO,
      cwd: CWD,
      readyForHumanLabel: READY_LABEL,
      stackReadyLabel: STACK_READY_LABEL,
      workItemProvider: 'gitea-issues',
    };
  }

  test('one open blocker returns kind:unsupported (stacking not supported off GitHub)', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const plan = await resolveDependencyExecutionPlan(99, giteaOpts(checker, makeRunner([])));
    expect(plan.kind).toBe('unsupported');
    expect(plan.reason).toContain('gitea-issues');
    expect(plan.blockers).toEqual([{ issueNumber: 50, state: 'open' }]);
  });

  test('never reads GitHub labels for the blocker — runner is not called', async () => {
    // Regression: a same-numbered public GitHub issue carrying the stack-ready
    // label must NOT let a Gitea task proceed. The blocker readiness lives on the
    // Gitea tracker, so the GitHub read path must not run at all.
    let called = false;
    const runner = {
      run() {
        called = true;
        // If the GitHub path ran, it would find a usable PR + stack-ready label.
        return { stdout: issueViewJson([STACK_READY_LABEL]), stderr: '', exitCode: 0 };
      },
    };
    const checker = makeDepChecker([{ issueNumber: 50, state: 'open' }]);
    const plan = await resolveDependencyExecutionPlan(99, giteaOpts(checker, runner));
    expect(plan.kind).toBe('unsupported');
    expect(called).toBe(false);
  });

  test('records the full open+closed relationship list in allBlockers', async () => {
    const checker = makeDepChecker([
      { issueNumber: 49, state: 'closed' },
      { issueNumber: 50, state: 'open' },
    ]);
    const plan = await resolveDependencyExecutionPlan(99, giteaOpts(checker, makeRunner([])));
    expect(plan.kind).toBe('unsupported');
    expect(plan.blockers).toEqual([{ issueNumber: 50, state: 'open' }]);
    expect(plan.allBlockers).toEqual([
      { issueNumber: 49, state: 'closed' },
      { issueNumber: 50, state: 'open' },
    ]);
  });

  test('closed-only blockers still resolve kind:none for a non-GitHub provider', async () => {
    const checker = makeDepChecker([{ issueNumber: 50, state: 'closed' }]);
    const plan = await resolveDependencyExecutionPlan(99, giteaOpts(checker, makeRunner([])));
    expect(plan.kind).toBe('none');
  });
});
