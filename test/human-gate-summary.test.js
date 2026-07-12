/**
 * Tests for Human Gate Decision Summary rendering and sticky-comment dispatch
 * (issue #552).
 */

import { renderHumanGateSummary, HUMAN_GATE_MARKER } from '../dist/core/human-gate-summary.js';
import { enqueueHumanGateSummaryEffect } from '../dist/core/outbox-effects.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIFF_CLEAN = {
  added: ['src/core/human-gate-summary.ts'],
  modified: ['src/core/outbox-effects.ts'],
  deleted: [],
  renamed: [],
  guardrail: { added: [], modified: [], deleted: [], renamed: [] },
};

const DIFF_WITH_GUARDRAIL_DELETE = {
  added: ['src/core/human-gate-summary.ts'],
  modified: ['src/core/outbox-effects.ts'],
  deleted: ['.github/workflows/ci.yml'],
  renamed: [],
  guardrail: {
    added: [],
    modified: [],
    deleted: ['.github/workflows/ci.yml'],
    renamed: [],
  },
};

const DIFF_WITH_GUARDRAIL_ADD = {
  added: [],
  modified: [],
  deleted: [],
  renamed: [],
  guardrail: {
    added: ['.github/workflows/deploy.yml'],
    modified: [],
    deleted: [],
    renamed: [],
  },
};

const DIFF_WITH_GUARDRAIL_RENAME = {
  added: [],
  modified: [],
  deleted: [],
  renamed: [{ from: '.github/workflows/ci.yml', to: '.github/workflows/build.yml' }],
  guardrail: {
    added: [],
    modified: [],
    deleted: [],
    renamed: [{ from: '.github/workflows/ci.yml', to: '.github/workflows/build.yml' }],
  },
};

// ---------------------------------------------------------------------------
// renderHumanGateSummary — marker and structure
// ---------------------------------------------------------------------------

describe('renderHumanGateSummary — marker and structure', () => {
  test('output starts with the HTML comment marker', () => {
    const body = renderHumanGateSummary({
      issueNumber: 552,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-abc',
    });
    expect(body.startsWith(HUMAN_GATE_MARKER)).toBe(true);
  });

  test('marker is distinct from PR_SUMMARY_MARKER', () => {
    expect(HUMAN_GATE_MARKER).not.toBe('<!-- n8n-ai-pr-summary -->');
    expect(HUMAN_GATE_MARKER).toBe('<!-- n8n-ai-human-gate -->');
  });

  test('includes the correct section headings', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('## Human Gate Decision Summary');
    expect(body).toContain('### Implementation Intent');
    expect(body).toContain('### Implementation Approach');
    expect(body).toContain('### Verification');
    expect(body).toContain('### Risk Summary');
    expect(body).toContain('### AI Decisions and Assumptions');
    expect(body).toContain('### Go / No-go Checklist');
  });

  test('includes issue number', () => {
    const body = renderHumanGateSummary({
      issueNumber: 552,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('Issue #552');
  });

  test('includes issue title when provided', () => {
    const body = renderHumanGateSummary({
      issueNumber: 10,
      issueTitle: 'Post Human Gate Decision Summary',
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('Post Human Gate Decision Summary');
  });

  test('includes PR number and branch when provided', () => {
    const body = renderHumanGateSummary({
      issueNumber: 10,
      prNumber: 42,
      branch: 'ai/issue-10',
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('PR #42');
    expect(body).toContain('ai/issue-10');
  });

  test('omits PR line when prNumber is absent', () => {
    const body = renderHumanGateSummary({
      issueNumber: 10,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).not.toContain('**PR #');
  });

  test('includes phase, result, and run ID in footer', () => {
    const body = renderHumanGateSummary({
      issueNumber: 10,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-42',
    });
    expect(body).toContain('Phase: review');
    expect(body).toContain('Result: success');
    expect(body).toContain('Run: run-42');
  });

  test('includes duration in footer when provided', () => {
    const body = renderHumanGateSummary({
      issueNumber: 10,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      durationMs: 90_000,
    });
    expect(body).toContain('Duration: 1m 30s');
  });

  test('omits duration from footer when not provided', () => {
    const body = renderHumanGateSummary({
      issueNumber: 10,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).not.toContain('Duration:');
  });
});

// ---------------------------------------------------------------------------
// renderHumanGateSummary — implementation approach (file changes)
// ---------------------------------------------------------------------------

describe('renderHumanGateSummary — implementation approach', () => {
  test('lists added, modified, deleted files', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_WITH_GUARDRAIL_DELETE,
    });
    expect(body).toContain('Added (1)');
    expect(body).toContain('src/core/human-gate-summary.ts');
    expect(body).toContain('Modified (1)');
    expect(body).toContain('src/core/outbox-effects.ts');
    expect(body).toContain('Deleted (1)');
    expect(body).toContain('.github/workflows/ci.yml');
  });

  test('shows unknown message when diffClassification absent', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('unknown');
  });

  test('caps file list at 10 and shows overflow count', () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: {
        added: manyFiles,
        modified: [],
        deleted: [],
        renamed: [],
        guardrail: { added: [], modified: [], deleted: [], renamed: [] },
      },
    });
    expect(body).toContain('Added (15)');
    expect(body).toContain('+5 more');
    expect(body).not.toContain('src/file10.ts');
  });
});

// ---------------------------------------------------------------------------
// renderHumanGateSummary — verification
// ---------------------------------------------------------------------------

describe('renderHumanGateSummary — verification', () => {
  test('shows passed verification', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      verificationNames: ['npm test', 'npm run package'],
      verificationPassed: true,
    });
    expect(body).toContain('npm test, npm run package');
    expect(body).toContain('✅ passed');
  });

  test('shows unknown when verification not recorded', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// renderHumanGateSummary — risk summary
// ---------------------------------------------------------------------------

describe('renderHumanGateSummary — risk summary', () => {
  test('calls out deleted guardrail file with warning', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_WITH_GUARDRAIL_DELETE,
    });
    expect(body).toContain('.github/workflows/ci.yml');
    expect(body).toContain('requires justification');
  });

  test('calls out added guardrail file', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_WITH_GUARDRAIL_ADD,
    });
    expect(body).toContain('.github/workflows/deploy.yml');
    expect(body).toContain('verify intent');
  });

  test('calls out renamed guardrail file', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_WITH_GUARDRAIL_RENAME,
    });
    expect(body).toContain('.github/workflows/ci.yml');
    expect(body).toContain('.github/workflows/build.yml');
    expect(body).toContain('verify intent');
    expect(body).not.toContain('None detected by the workflow');
  });

  test('shows none detected when no guardrail changes', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_CLEAN,
    });
    expect(body).toContain('None detected by the workflow');
  });

  test('shows unavailable risk note when diffClassification absent', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('Diff classification unavailable');
    expect(body).toContain('guardrail/tooling checks did not run');
    expect(body).not.toContain('None detected by the workflow');
  });

  test('always notes CI status and behavior-change caveat', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('CI/external check status: unknown');
    expect(body).toContain('not audited by this summary');
  });
});

// ---------------------------------------------------------------------------
// renderHumanGateSummary — AI decisions and assumptions
// ---------------------------------------------------------------------------

describe('renderHumanGateSummary — AI decisions and assumptions', () => {
  test('includes classifier reason when provided', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      classifierReason: 'No blocking findings detected in review output',
    });
    expect(body).toContain('No blocking findings detected in review output');
  });

  test('includes review agent label when provided', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      reviewAgentUsed: 'claude',
    });
    expect(body).toContain('Claude (Anthropic)');
  });

  test('includes model when present in resolvedProfile', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      resolvedProfile: { agentId: 'claude', model: 'claude-sonnet-4-5', effort: 'high' },
    });
    expect(body).toContain('claude-sonnet-4-5');
    expect(body).toContain('high');
  });

  test('includes effort/strength from reviewStrength when effort absent', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      resolvedProfile: { agentId: 'claude', reviewStrength: 'medium' },
    });
    expect(body).toContain('medium');
  });

  test('always includes scope-choices caveat', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('not explicitly captured');
  });
});

// ---------------------------------------------------------------------------
// renderHumanGateSummary — Go / No-go checklist
// ---------------------------------------------------------------------------

describe('renderHumanGateSummary — Go / No-go checklist', () => {
  test('checklist is present', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).toContain('- [ ] Implementation intent correctly matches the issue requirements');
    expect(body).toContain('- [ ] All files changed are expected and in scope');
    expect(body).toContain('- [ ] Verification has passed');
    expect(body).toContain('- [ ] Ready to merge');
  });

  test('includes guardrail check when guardrail files are touched', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_WITH_GUARDRAIL_DELETE,
    });
    expect(body).toContain('- [ ] Guardrail/tooling file changes are justified');
  });

  test('omits guardrail check when no guardrail files touched', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
      diffClassification: DIFF_CLEAN,
    });
    expect(body).not.toContain('- [ ] Guardrail/tooling file changes are justified');
  });
});

// ---------------------------------------------------------------------------
// renderHumanGateSummary — sanitization
// ---------------------------------------------------------------------------

describe('renderHumanGateSummary — sanitization (no local paths)', () => {
  test('does not include local paths when diff is absent', () => {
    const body = renderHumanGateSummary({
      issueNumber: 1,
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).not.toContain('/Users/');
    expect(body).not.toContain('/tmp/');
    expect(body).not.toContain('/home/');
  });
});

// ---------------------------------------------------------------------------
// enqueueHumanGateSummaryEffect — helpers
// ---------------------------------------------------------------------------

function makeSession(overrides = {}) {
  return {
    sessionId: 'sess',
    repoRoot: '/tmp/repo',
    artifactRoot: '/tmp/artifacts',
    githubOwner: 'org',
    githubName: 'repo',
    githubRepo: 'org/repo',
    verification: { 'npm test': 'npm test' },
    repoHostProvider: { provider: 'github' },
    workItemProvider: { provider: 'github-issues' },
    labels: {},
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    sessionId: 'sess',
    issueNumber: 10,
    status: 'running',
    phase: 'review',
    context: { title: 'Test issue', prUrl: 'https://github.com/org/repo/pull/42' },
    ...overrides,
  };
}

function makeStore() {
  const entries = [];
  return {
    enqueued: entries,
    enqueue(input) {
      const dup = entries.some(e => e.idempotencyKey === input.idempotencyKey);
      if (!dup) entries.push(input);
      return Promise.resolve({ enqueued: !dup });
    },
    replacePendingPrSummary(input, key) {
      const toRemove = entries.filter(
        e =>
          e.topic === 'repohost:pr-summary' &&
          e.payload?.owner === key.owner &&
          e.payload?.repo === key.repo &&
          e.payload?.prNumber === key.prNumber &&
          e.payload?.marker === key.marker,
      );
      for (const e of toRemove) entries.splice(entries.indexOf(e), 1);
      const dup = entries.some(e => e.idempotencyKey === input.idempotencyKey);
      if (!dup) entries.push(input);
      return Promise.resolve({ enqueued: !dup });
    },
    listPending() { return Promise.resolve([]); },
    markSent() { return Promise.resolve(); },
  };
}

// ---------------------------------------------------------------------------
// enqueueHumanGateSummaryEffect — phase/result gating
// ---------------------------------------------------------------------------

describe('enqueueHumanGateSummaryEffect — phase/result gating', () => {
  test('enqueues for review success', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run1', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].topic).toBe('repohost:pr-summary');
    expect(s.enqueued[0].payload.marker).toBe(HUMAN_GATE_MARKER);
  });

  test('does not enqueue for review needs_fix', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'needs_fix', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run2', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });

  test('does not enqueue for review blocked', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'blocked', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run3', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });

  test('does not enqueue for review failed', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'failed', error: 'oops', context: {} },
      'run4', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });

  test('does not enqueue for implementation success', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask({ phase: 'implementation' }),
      'implementation',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run5', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });

  test('does not enqueue when no PR URL available', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask({ context: { title: 'Test' } }),
      'review',
      { result: 'success', context: {} },
      'run6', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(0);
  });

  test('falls back to task context prUrl when result context omits it', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(),
      makeTask({ context: { title: 'Test', prUrl: 'https://github.com/org/repo/pull/99' } }),
      'review',
      { result: 'success', context: {} },
      'run7', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].payload.prNumber).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// enqueueHumanGateSummaryEffect — payload content
// ---------------------------------------------------------------------------

describe('enqueueHumanGateSummaryEffect — payload content', () => {
  test('rendered body contains the HUMAN_GATE_MARKER', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'runX', new Date().toISOString(),
    );
    expect(s.enqueued[0].payload.body).toContain(HUMAN_GATE_MARKER);
  });

  test('rendered body contains all required sections', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'runY', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    expect(body).toContain('Human Gate Decision Summary');
    expect(body).toContain('Implementation Intent');
    expect(body).toContain('Risk Summary');
    expect(body).toContain('Go / No-go Checklist');
  });

  test('includes review agent and classifier reason from context', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      {
        result: 'success',
        context: {
          prUrl: 'https://github.com/org/repo/pull/42',
          reviewAgentUsed: 'claude',
          reason: 'No blocking findings detected in review output',
          resolvedProfile: { agentId: 'claude', model: 'claude-sonnet-4-5', reviewStrength: 'high' },
        },
      },
      'runZ', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    expect(body).toContain('Claude (Anthropic)');
    expect(body).toContain('No blocking findings detected in review output');
    expect(body).toContain('claude-sonnet-4-5');
  });

  test('includes branch from context', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      {
        result: 'success',
        context: {
          prUrl: 'https://github.com/org/repo/pull/42',
          branch: 'ai/issue-10',
        },
      },
      'runB', new Date().toISOString(),
    );
    expect(s.enqueued[0].payload.body).toContain('ai/issue-10');
  });

  test('body does not contain local artifact paths', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'runSan', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    expect(body).not.toContain('/tmp/');
    expect(body).not.toContain('/Users/');
    expect(body).not.toContain('/home/');
  });

  test('includes verification status when session has verification commands', async () => {
    const s = makeStore();
    const session = makeSession({ verification: { 'npm test': 'npm test', 'npm run package': 'npm run package' } });
    await enqueueHumanGateSummaryEffect(
      s, session, makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'runV', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    expect(body).toContain('npm test');
    expect(body).toContain('✅ passed');
  });

  test('omits issue title for split-provider (gitea-issues) session', async () => {
    const s = makeStore();
    const session = makeSession({ workItemProvider: { provider: 'gitea-issues' } });
    const task = makeTask({ context: { title: 'Private Gitea title', prUrl: 'https://github.com/org/repo/pull/42' } });
    await enqueueHumanGateSummaryEffect(
      s, session, task,
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'runSplit', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].payload.body).not.toContain('Private Gitea title');
  });

  test('includes issue title for github-issues session (same public surface)', async () => {
    const s = makeStore();
    const session = makeSession({ workItemProvider: { provider: 'github-issues' } });
    const task = makeTask({ context: { title: 'Public GitHub title', prUrl: 'https://github.com/org/repo/pull/42' } });
    await enqueueHumanGateSummaryEffect(
      s, session, task,
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'runPub', new Date().toISOString(),
    );
    expect(s.enqueued[0].payload.body).toContain('Public GitHub title');
  });

  test('omits issue title when github-issues work-item provider but non-github repo host (split surface)', async () => {
    const s = makeStore();
    const session = makeSession({
      workItemProvider: { provider: 'github-issues' },
      repoHostProvider: { provider: 'gitea' },
    });
    const task = makeTask({ context: { title: 'Private GitHub Issue title', prUrl: 'https://gitea.example.com/org/repo/pull/42' } });
    await enqueueHumanGateSummaryEffect(
      s, session, task,
      'review',
      { result: 'success', context: { prUrl: 'https://gitea.example.com/org/repo/pull/42' } },
      'runSplit2', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].payload.body).not.toContain('Private GitHub Issue title');
  });
});

// ---------------------------------------------------------------------------
// enqueueHumanGateSummaryEffect — sticky-comment / update behavior
// ---------------------------------------------------------------------------

describe('enqueueHumanGateSummaryEffect — sticky-comment (update not duplicate)', () => {
  test('second run supersedes first pending entry for same PR (human-gate marker only)', async () => {
    const s = makeStore();
    const task = makeTask();
    const session = makeSession();
    const ctx = { prUrl: 'https://github.com/org/repo/pull/42' };

    await enqueueHumanGateSummaryEffect(s, session, task, 'review', { result: 'success', context: ctx }, 'run-A', '2026-01-01T00:00:00Z');
    await enqueueHumanGateSummaryEffect(s, session, task, 'review', { result: 'success', context: ctx }, 'run-B', '2026-01-01T00:01:00Z');

    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].idempotencyKey).toContain('run-B');
  });

  test('uses HUMAN_GATE_MARKER not PR_SUMMARY_MARKER in the outbox entry', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'runM', new Date().toISOString(),
    );
    expect(s.enqueued[0].payload.marker).toBe(HUMAN_GATE_MARKER);
    expect(s.enqueued[0].payload.marker).not.toBe('<!-- n8n-ai-pr-summary -->');
  });

  test('human-gate and pr-summary entries coalesce independently (different markers)', async () => {
    const s = makeStore();
    const task = makeTask();
    const session = makeSession();
    const ctx = { prUrl: 'https://github.com/org/repo/pull/42' };

    // Enqueue a simulated pr-summary entry first
    s.enqueued.push({
      idempotencyKey: 'pr-summary-key',
      topic: 'repohost:pr-summary',
      payload: {
        topic: 'repohost:pr-summary',
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        marker: '<!-- n8n-ai-pr-summary -->',
        body: 'old pr summary',
      },
    });

    // Now enqueue the human-gate summary
    await enqueueHumanGateSummaryEffect(s, session, task, 'review', { result: 'success', context: ctx }, 'run-HG', '2026-01-01T00:00:00Z');

    // Both entries should be present: the pr-summary is NOT clobbered by the human-gate entry
    expect(s.enqueued).toHaveLength(2);
    const markers = s.enqueued.map(e => e.payload?.marker);
    expect(markers).toContain('<!-- n8n-ai-pr-summary -->');
    expect(markers).toContain(HUMAN_GATE_MARKER);
  });
});
