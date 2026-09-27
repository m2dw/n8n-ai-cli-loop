/**
 * Tests for Human Gate Decision Summary rendering and sticky-comment dispatch
 * (issue #552).
 */

import {
  renderHumanGateSummary,
  renderHumanGateAmendmentSupersededSummary,
  HUMAN_GATE_MARKER,
} from '../dist/core/human-gate-summary.js';
import {
  enqueueHumanGateSummaryEffect,
  enqueueVerificationAmendmentGateSupersededEffect,
} from '../dist/core/outbox-effects.js';

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

  // The title is rendered above every section, including the verification and
  // amendment disclosures, so raw HTML in it would comment the rest of the body
  // out (issue #1044 review, P1).
  test('renders the issue title HTML-inert', () => {
    const body = renderHumanGateSummary({
      issueNumber: 10,
      issueTitle: 'Fix <!-- the parser',
      phase: 'review',
      phaseResult: 'success',
      runId: 'r',
    });
    expect(body).not.toContain('<!-- the parser');
    expect(body).toContain('&lt;!-- the parser');
    expect(body).toContain('### Go / No-go Checklist');
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

  // Issue #1044 (§12.2): the amendment projection the review handler recorded
  // travels into the gate comment. The gate is the last surface before a merge,
  // and a retirement it does not name is a check a human believes still runs.
  test('carries the amendment projection from the completion context into the comment', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      {
        result: 'success',
        context: {
          prUrl: 'https://github.com/org/repo/pull/42',
          verificationAmendment: {
            revisionCount: 1,
            latestOrdinal: 1,
            latestRevisionId: 'vamd-0000000000000001',
            latestSource: 'admin-cli',
            latestReason: 'the e2e suite cannot run here',
            planDigest: 'c'.repeat(64),
            retiredTotal: 1,
            retiredLabels: ['npm run e2e'],
            activeCount: 1,
          },
        },
      },
      'run-amended', new Date().toISOString(),
    );
    expect(s.enqueued).toHaveLength(1);
    const body = s.enqueued[0].payload.body;
    expect(body).toContain("This task's verification plan was amended by an operator");
    expect(body).toContain('the e2e suite cannot run here');
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('`npm run e2e`');
  });

  // Issue #1044 review (P1): a retired label is command BYTES. One holding a
  // backtick closes the code span the renderer opens around it, and whatever
  // follows — `<!--` in the worst case — is then Markdown, not code: the "not a
  // passing result" statement, the merge checklist and the footer all disappear
  // into an HTML comment while the comment still reads as complete.
  test('a retired label carrying a backtick cannot hide the disclosures below it', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      {
        result: 'success',
        context: {
          prUrl: 'https://github.com/org/repo/pull/42',
          verificationAmendment: {
            revisionCount: 1,
            latestOrdinal: 1,
            latestRevisionId: 'vamd-0000000000000003',
            latestSource: 'admin-cli',
            latestReason: 'the suite cannot run here',
            planDigest: 'c'.repeat(64),
            retiredTotal: 1,
            retiredLabels: ['npm test` <!--'],
            activeCount: 1,
          },
        },
      },
      'run-injected', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    // No backtick survives inside the label, so the span closes where the
    // renderer intended and the `<!--` stays literal text inside code.
    expect(body).toContain("`npm test' <!--`");
    expect(body).not.toContain('npm test` <!--');
    // The count is still the truth, and every mandatory disclosure below the
    // list is still outside any comment the label could have opened.
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('A retired verification command is **not** a passing result');
    expect(body).toContain('- [ ] Ready to merge');
  });

  // Issue #1044 review (P1): in a split-provider session the work item lives on
  // a private tracker and the PR on GitHub. The amendment's reason and its
  // requirement labels are that private Issue's own text — the existing title
  // guard does not cover them — so only the public-safe aggregate is published.
  test('a split-provider session publishes the counts and none of the private text', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s,
      makeSession({
        workItemProvider: { provider: 'gitea', gitea: { owner: 'internal', repo: 'work' } },
        repoHostProvider: { provider: 'github' },
      }),
      makeTask({ context: { title: 'Private customer escalation', prUrl: 'https://github.com/org/repo/pull/42' } }),
      'review',
      {
        result: 'success',
        context: {
          prUrl: 'https://github.com/org/repo/pull/42',
          verificationAmendment: {
            revisionCount: 2,
            latestOrdinal: 2,
            latestRevisionId: 'vamd-0000000000000002',
            latestSource: 'admin-cli',
            latestReason: 'customer ACME cannot expose the staging endpoint',
            planDigest: 'c'.repeat(64),
            retiredTotal: 1,
            retiredLabels: ['npm run acme-staging-e2e'],
            executionRetiredTotal: 0,
            executionRetiredLabels: [],
            activeCount: 1,
          },
        },
      },
      'run-split', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    // The fact of the amendment, and the size of the removal, still reach the
    // human who merges — that part is a statement about this repository.
    expect(body).toContain("This task's verification plan was amended by an operator");
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('names withheld');
    expect(body).toContain('- [ ] The operator-retired verification command(s) above are intentionally not run');
    // None of the private work item's text does.
    expect(body).not.toContain('npm run acme-staging-e2e');
    expect(body).not.toContain('ACME');
    expect(body).not.toContain('Private customer escalation');
  });

  test('a same-surface session still publishes the amendment names in full', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      {
        result: 'success',
        context: {
          prUrl: 'https://github.com/org/repo/pull/42',
          verificationAmendment: {
            revisionCount: 1,
            latestOrdinal: 1,
            latestRevisionId: 'vamd-0000000000000001',
            latestSource: 'admin-cli',
            latestReason: 'the e2e suite cannot run here',
            planDigest: 'c'.repeat(64),
            retiredTotal: 1,
            retiredLabels: ['npm run e2e'],
            activeCount: 1,
          },
        },
      },
      'run-same-surface', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    expect(body).toContain('`npm run e2e`');
    expect(body).toContain('the e2e suite cannot run here');
    expect(body).not.toContain('names withheld');
  });

  // Issue #1044 review (P2): a self-hosted session whose work items and pull
  // requests live in the SAME Gitea repository is not a split surface. Reading
  // it as one strips every label and reason out of the merge gate and then
  // tells the reader they were withheld for a privacy boundary that is not
  // there.
  const GITEA_AMENDMENT = {
    revisionCount: 1,
    latestOrdinal: 1,
    latestRevisionId: 'vamd-0000000000000001',
    latestSource: 'admin-cli',
    latestReason: 'the e2e suite cannot run here',
    planDigest: 'c'.repeat(64),
    retiredTotal: 1,
    retiredLabels: ['npm run e2e'],
    activeCount: 1,
  };
  const giteaSession = (workItemRepo, repoHostRepo) =>
    makeSession({
      workItemProvider: { provider: 'gitea-issues', gitea: { baseUrl: 'https://git.example.com/', owner: 'acme', repo: workItemRepo } },
      repoHostProvider: { provider: 'gitea', gitea: { baseUrl: 'https://git.example.com', owner: 'acme', repo: repoHostRepo } },
    });

  test('a same-repository Gitea session publishes the amendment names in full', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, giteaSession('loop', 'loop'),
      makeTask({ context: { title: 'A self-hosted task', prUrl: 'https://git.example.com/acme/loop/pulls/42' } }),
      'review',
      {
        result: 'success',
        context: {
          prUrl: 'https://git.example.com/acme/loop/pulls/42',
          verificationAmendment: GITEA_AMENDMENT,
        },
      },
      'run-gitea-same', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    expect(body).toContain('`npm run e2e`');
    expect(body).toContain('the e2e suite cannot run here');
    expect(body).not.toContain('names withheld');
    expect(body).toContain('A self-hosted task');
  });

  test('a Gitea session whose work items live in another repository still withholds them', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, giteaSession('private-work', 'loop'),
      makeTask({ context: { title: 'A private task', prUrl: 'https://git.example.com/acme/loop/pulls/42' } }),
      'review',
      {
        result: 'success',
        context: {
          prUrl: 'https://git.example.com/acme/loop/pulls/42',
          verificationAmendment: GITEA_AMENDMENT,
        },
      },
      'run-gitea-split', new Date().toISOString(),
    );
    const body = s.enqueued[0].payload.body;
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('names withheld');
    expect(body).not.toContain('npm run e2e');
    expect(body).not.toContain('the e2e suite cannot run here');
    expect(body).not.toContain('A private task');
  });

  test('an unamended review posts the gate comment unchanged', async () => {
    const s = makeStore();
    await enqueueHumanGateSummaryEffect(
      s, makeSession(), makeTask(),
      'review',
      { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/42' } },
      'run-unamended', new Date().toISOString(),
    );
    expect(s.enqueued[0].payload.body).not.toContain('verification plan was amended');
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

// ---------------------------------------------------------------------------
// A record-only amendment supersedes a live handoff (issue #1044 review, P1)
// ---------------------------------------------------------------------------

const AMENDMENT = {
  revisionCount: 1,
  latestOrdinal: 1,
  latestRevisionId: 'vamd-00112233445566aa',
  latestSource: 'admin-cli',
  latestReason: 'the e2e suite cannot run in this environment',
  planDigest: 'a'.repeat(64),
  retiredTotal: 1,
  retiredLabels: ['npm run e2e'],
  activeCount: 1,
  activeRequirementCount: 1,
  activeExecutionCount: 0,
};

describe('the superseded human-gate body', () => {
  test('replaces the stale pass with the amendment and what it retired', () => {
    const body = renderHumanGateAmendmentSupersededSummary({
      issueNumber: 10,
      issueTitle: 'Test issue',
      prNumber: 42,
      branch: 'ai/issue-10',
      verificationAmendment: AMENDMENT,
    });
    // Same marker as the summary it replaces, so the delivery EDITS the stale
    // comment instead of appending an invalidation nobody scrolls to.
    expect(body.startsWith(HUMAN_GATE_MARKER)).toBe(true);
    expect(body).toContain('superseded by a verification amendment');
    expect(body).toContain('no review has run against the amended plan');
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('`npm run e2e`');
    expect(body).toContain('the e2e suite cannot run in this environment');
    // The verification verdict of the superseded plan is not restated anywhere.
    expect(body).not.toContain('✅ passed');
  });

  // Markdown passes raw HTML through, so an issue title carrying an unmatched
  // `<!--` would comment out every line rendered after it — the amended plan,
  // the retirement disclosures, and the checklist — and leave a reader with a
  // body that looks complete while precisely the removals are hidden (issue
  // #1044 review, P1).
  test('renders the issue title HTML-inert so it cannot hide the disclosures', () => {
    const body = renderHumanGateAmendmentSupersededSummary({
      issueNumber: 10,
      issueTitle: 'Fix <!-- the parser',
      prNumber: 42,
      branch: 'ai/issue-10',
      verificationAmendment: AMENDMENT,
    });
    expect(body).not.toContain('<!-- the parser');
    expect(body).toContain('&lt;!-- the parser');
    // Everything the amendment must disclose still follows it, unhidden.
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('Go / No-go Checklist');
  });

  test('is enqueued against the task PR, keyed on the revision and not on a run', async () => {
    const s = makeStore();
    await enqueueVerificationAmendmentGateSupersededEffect(
      s,
      makeSession(),
      makeTask({ status: 'ready_for_human' }),
      AMENDMENT,
      'vamd-00112233445566aa',
      '2026-01-01T00:00:00Z',
    );
    expect(s.enqueued).toHaveLength(1);
    const [row] = s.enqueued;
    expect(row.topic).toBe('repohost:pr-summary');
    expect(row.payload.prNumber).toBe(42);
    expect(row.payload.marker).toBe(HUMAN_GATE_MARKER);
    expect(row.idempotencyKey).toBe(
      'sess:10:vamd-00112233445566aa:repohost:human-gate:superseded',
    );

    // A re-derived enqueue after a crash produces the identical key.
    await enqueueVerificationAmendmentGateSupersededEffect(
      s, makeSession(), makeTask({ status: 'ready_for_human' }), AMENDMENT,
      'vamd-00112233445566aa', '2026-01-01T00:00:01Z',
    );
    expect(s.enqueued).toHaveLength(1);
  });

  test('a task with no PR has no gate comment to supersede', async () => {
    const s = makeStore();
    await enqueueVerificationAmendmentGateSupersededEffect(
      s,
      makeSession(),
      makeTask({ status: 'ready_for_human', context: { title: 'Test issue' } }),
      AMENDMENT,
      'vamd-00112233445566aa',
      '2026-01-01T00:00:00Z',
    );
    expect(s.enqueued).toHaveLength(0);
  });

  // A `gitea` repo host serves a repo declared in its own connection block,
  // which has no relationship to the session's GitHub coordinates. Addressing
  // the row with the GitHub tuple would name a repo the configured host does not
  // serve — and, because the pending-supersede predicate matches on the address,
  // would leave a still-pending stale gate summary to land on top of this one
  // (issue #1044 review, P1).
  test('a gitea repo host is addressed by its configured owner/repo, so it still displaces the stale summary', async () => {
    const s = makeStore();
    const session = makeSession({
      repoHostProvider: {
        provider: 'gitea',
        gitea: { baseUrl: 'https://gitea.example.com', owner: 'code', repo: 'loop' },
      },
    });
    const task = makeTask({
      status: 'ready_for_human',
      context: { title: 'Test issue', prUrl: 'https://gitea.example.com/code/loop/pulls/42' },
    });

    // The passing review's sticky summary, still pending delivery.
    await enqueueHumanGateSummaryEffect(
      s, session, task, 'review', { result: 'success', context: {} }, 'run-A', '2026-01-01T00:00:00Z',
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].payload).toMatchObject({ owner: 'code', repo: 'loop', prNumber: 42 });

    await enqueueVerificationAmendmentGateSupersededEffect(
      s, session, task, AMENDMENT, 'vamd-00112233445566aa', '2026-01-01T00:01:00Z',
    );
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].payload).toMatchObject({ owner: 'code', repo: 'loop', prNumber: 42 });
    expect(s.enqueued[0].payload.body).toContain('superseded by a verification amendment');
  });

  test('a split-provider session publishes the counts and withholds the private names', async () => {
    const s = makeStore();
    await enqueueVerificationAmendmentGateSupersededEffect(
      s,
      makeSession({ workItemProvider: { provider: 'gitea' } }),
      makeTask({ status: 'ready_for_human' }),
      AMENDMENT,
      'vamd-00112233445566aa',
      '2026-01-01T00:00:00Z',
    );
    const [row] = s.enqueued;
    expect(row.payload.body).toContain('Retired — not run, not passed (1)');
    expect(row.payload.body).toContain('names withheld');
    expect(row.payload.body).not.toContain('npm run e2e');
    expect(row.payload.body).not.toContain('the e2e suite cannot run in this environment');
    expect(row.payload.body).not.toContain('Test issue');
  });
});
