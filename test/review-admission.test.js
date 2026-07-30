import { checkReviewAdmission, resolveDependencyReviewBase } from '../dist/handlers/review-admission.js';

// ---------------------------------------------------------------------------
// checkReviewAdmission (issue #681)
// ---------------------------------------------------------------------------

function makeTask(context = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: 77,
    status: 'running',
    phase: 'review',
    priority: 'normal',
    attempts: {},
    context: {
      prUrl: 'https://github.com/m2dw/test-repo/pull/99',
      branch: 'ai/issue-77',
      ...context,
    },
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  };
}

describe('checkReviewAdmission — unresolved Tool Request', () => {
  test('refuses admission when context.toolRequest is unresolved', () => {
    const result = checkReviewAdmission(makeTask({ toolRequest: { resolved: false } }));
    expect(result.ok).toBe(false);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/unresolved implementation Tool Request/i);
  });

  test('admits when context.toolRequest is resolved', () => {
    const result = checkReviewAdmission(makeTask({ toolRequest: { resolved: true } }));
    expect(result.ok).toBe(true);
  });

  test('admits when context.toolRequest is absent', () => {
    const result = checkReviewAdmission(makeTask());
    expect(result.ok).toBe(true);
  });
});

describe('checkReviewAdmission — durable PR reference', () => {
  test('refuses admission when neither prUrl nor branch is recorded', () => {
    const result = checkReviewAdmission(makeTask({ prUrl: undefined, branch: undefined }));
    expect(result.ok).toBe(false);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/No PR URL or branch/);
  });

  test('admits with only prUrl recorded (resolves to a PR number)', () => {
    const result = checkReviewAdmission(makeTask({ branch: undefined }));
    expect(result.ok).toBe(true);
  });

  test('admits with only branch recorded (no prUrl)', () => {
    const result = checkReviewAdmission(makeTask({ prUrl: undefined }));
    expect(result.ok).toBe(true);
  });

  test('refuses admission when prUrl cannot be resolved to a PR number and no branch is recorded', () => {
    const result = checkReviewAdmission(
      makeTask({ prUrl: 'https://github.com/m2dw/test-repo/not-a-pr-link', branch: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/does not resolve to a PR number/);
  });

  test('a recorded branch rescues an unresolvable prUrl', () => {
    const result = checkReviewAdmission(
      makeTask({ prUrl: 'https://github.com/m2dw/test-repo/not-a-pr-link', branch: 'ai/issue-77' }),
    );
    expect(result.ok).toBe(true);
  });

  test('accepts a Gitea-style /pulls/<n> URL', () => {
    const result = checkReviewAdmission(
      makeTask({ prUrl: 'https://gitea.example.com/acme/code/pulls/99', branch: undefined }),
    );
    expect(result.ok).toBe(true);
  });

  test('refuses admission when branch is blank and prUrl is absent', () => {
    const result = checkReviewAdmission(makeTask({ prUrl: undefined, branch: '   ' }));
    expect(result.ok).toBe(false);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/No PR URL or branch/);
  });

  test('a blank branch does not rescue an unresolvable prUrl', () => {
    const result = checkReviewAdmission(
      makeTask({ prUrl: 'https://github.com/m2dw/test-repo/not-a-pr-link', branch: '   ' }),
    );
    expect(result.ok).toBe(false);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/does not resolve to a PR number/);
  });

  test('refuses admission when the recorded prUrl resolves to PR number 0 and no branch is recorded', () => {
    const result = checkReviewAdmission(
      makeTask({ prUrl: 'https://github.com/m2dw/test-repo/pull/0', branch: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/does not resolve to a PR number/);
  });

  test('a recorded branch rescues a prUrl that resolves to PR number 0', () => {
    const result = checkReviewAdmission(
      makeTask({ prUrl: 'https://github.com/m2dw/test-repo/pull/0', branch: 'ai/issue-77' }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('checkReviewAdmission — dependency-started review base (issue #667)', () => {
  test('admits a non-dependency-started task with no dependencyBase', () => {
    const result = checkReviewAdmission(makeTask());
    expect(result.ok).toBe(true);
    expect(result.dependencyReviewBase).toBeUndefined();
  });

  test('admits a dependency-started task with a valid baseHeadSha and surfaces it', () => {
    const result = checkReviewAdmission(
      makeTask({
        dependencyBase: {
          baseIssueNumber: 50,
          basePrNumber: 88,
          baseHeadRefName: 'ai/issue-50',
          baseHeadSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.dependencyReviewBase).toEqual({
      sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      refName: 'ai/issue-50',
    });
  });

  test('blocks a dependency-started task with no baseHeadSha', () => {
    const result = checkReviewAdmission(
      makeTask({
        dependencyBase: { baseIssueNumber: 50, basePrNumber: 88, baseHeadRefName: 'ai/issue-50' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/baseHeadSha/);
  });

  test('blocks a dependency-started task with a whitespace-only baseHeadSha', () => {
    const result = checkReviewAdmission(
      makeTask({ dependencyBase: { baseHeadRefName: 'ai/issue-50', baseHeadSha: '   ' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.result).toBe('blocked');
  });

  test('the unresolved Tool Request check fires before the dependency-base check', () => {
    const result = checkReviewAdmission(
      makeTask({
        toolRequest: { resolved: false },
        dependencyBase: { baseHeadRefName: 'ai/issue-50' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/unresolved implementation Tool Request/i);
  });
});

// ---------------------------------------------------------------------------
// resolveDependencyReviewBase
// ---------------------------------------------------------------------------

describe('resolveDependencyReviewBase', () => {
  test('reports missing:false with no base when context has no dependencyBase', () => {
    expect(resolveDependencyReviewBase({})).toEqual({ missing: false });
  });

  test('reports missing:false with no base when dependencyBase is not an object', () => {
    expect(resolveDependencyReviewBase({ dependencyBase: 'not-an-object' })).toEqual({ missing: false });
    expect(resolveDependencyReviewBase({ dependencyBase: null })).toEqual({ missing: false });
    expect(resolveDependencyReviewBase({ dependencyBase: ['a'] })).toEqual({ missing: false });
  });

  test('reports missing:true when dependencyBase has no baseHeadSha', () => {
    expect(resolveDependencyReviewBase({ dependencyBase: { baseHeadRefName: 'ai/issue-50' } })).toEqual({
      missing: true,
    });
  });

  test('resolves sha and refName when both are present', () => {
    expect(
      resolveDependencyReviewBase({
        dependencyBase: { baseHeadSha: 'abc123', baseHeadRefName: 'ai/issue-50' },
      }),
    ).toEqual({ base: { sha: 'abc123', refName: 'ai/issue-50' }, missing: false });
  });

  test('resolves sha with no refName when baseHeadRefName is absent', () => {
    expect(resolveDependencyReviewBase({ dependencyBase: { baseHeadSha: 'abc123' } })).toEqual({
      base: { sha: 'abc123', refName: undefined },
      missing: false,
    });
  });
});
