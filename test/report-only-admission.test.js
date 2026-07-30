import { checkReportOnlyAdmission, describeReportOnlyDeferral, REPORT_ONLY_BLOCKED_PHASES } from '../dist/handlers/report-only-admission.js';

// ---------------------------------------------------------------------------
// checkReportOnlyAdmission (issue #532)
// ---------------------------------------------------------------------------

function makeSession(reportOnly) {
  return {
    sessionId: 'addon-dev',
    repoRoot: '/repo',
    githubRepo: 'm2dw/thunderbird-auth-results-filter',
    artifactRoot: '/repo/.n8n-artifacts',
    githubOwner: 'm2dw',
    githubName: 'thunderbird-auth-results-filter',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    artifactDir: '.n8n-artifacts',
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    repoHostProviderConfigured: false,
    ...(reportOnly !== undefined ? { reportOnly } : {}),
  };
}

function makeTask(phase, overrides = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: 77,
    status: 'running',
    phase,
    priority: 'normal',
    attempts: {},
    context: {},
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('checkReportOnlyAdmission — session not in report-only mode', () => {
  test('admits implementation when reportOnly is absent', () => {
    const result = checkReportOnlyAdmission(makeSession(undefined), makeTask('implementation'));
    expect(result).toEqual({ ok: true });
  });

  test('admits implementation when reportOnly.enabled is false', () => {
    const result = checkReportOnlyAdmission(makeSession({ enabled: false }), makeTask('implementation'));
    expect(result).toEqual({ ok: true });
  });

  test('admits conflict_resolution when reportOnly.enabled is false', () => {
    const result = checkReportOnlyAdmission(makeSession({ enabled: false }), makeTask('conflict_resolution'));
    expect(result).toEqual({ ok: true });
  });
});

describe('checkReportOnlyAdmission — session in report-only mode', () => {
  const session = makeSession({ enabled: true });

  test('refuses admission for the implementation phase', () => {
    const result = checkReportOnlyAdmission(session, makeTask('implementation'));
    expect(result.ok).toBe(false);
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/report-only mode/i);
    expect(result.message).toMatch(/issue #77/);
    expect(result.message).toMatch(/'implementation' phase/);
  });

  test('refuses admission for the conflict_resolution phase', () => {
    const result = checkReportOnlyAdmission(session, makeTask('conflict_resolution'));
    expect(result.ok).toBe(false);
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/'conflict_resolution' phase/);
  });

  test('still admits the review phase (no write authority, may already have an open PR)', () => {
    const result = checkReportOnlyAdmission(session, makeTask('review'));
    expect(result).toEqual({ ok: true });
  });

  test('still admits research and content phases', () => {
    for (const phase of ['research', 'content_research', 'content_draft', 'content_review', 'planner']) {
      expect(checkReportOnlyAdmission(session, makeTask(phase))).toEqual({ ok: true });
    }
  });
});

describe('REPORT_ONLY_BLOCKED_PHASES', () => {
  test('contains exactly the repo-mutating phases', () => {
    expect(new Set(REPORT_ONLY_BLOCKED_PHASES)).toEqual(new Set(['implementation', 'conflict_resolution']));
  });
});

describe('describeReportOnlyDeferral', () => {
  test('states the phase that would have run and how to switch back to normal automation', () => {
    const message = describeReportOnlyDeferral(makeSession({ enabled: true }), 42, 'implementation');
    expect(message).toMatch(/issue #42/);
    expect(message).toMatch(/'implementation' phase/);
    expect(message).toMatch(/No repository changes were made/);
    expect(message).toMatch(/reportOnly.enabled to false/);
  });
});
