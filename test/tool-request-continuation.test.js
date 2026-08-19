import {
  matchesConfiguredVerificationCommand,
  resolveConfiguredVerification,
  collectPendingImplementationMarkers,
  decideToolRequestContinuation,
  buildToolRequestContinuationRecord,
  boundEvidenceLabel,
  TOOL_REQUEST_CONTINUATION_CHECKS,
  TOOL_REQUEST_PENDING_MARKERS,
  MAX_EVIDENCE_LABEL_CHARS,
} from '../dist/index.js';

// Issue #722 — the pure continuation decision for a resolved implementation
// Tool Request. `docs/unattended-tool-request-contract.md` row 26 (via
// `docs/verification-execution-contract.md` §10) is the only direct-to-review
// route in the system; everything else keeps row 27's shipped implementation
// continuation. Every check below is fail-closed: an unproven input is
// `undefined` and never passes.

const SHA = 'a'.repeat(40);

function passingInput(overrides = {}) {
  return {
    guidedRun: { exitCode: 0, command: 'npm test', disposition: 'no-op', producedChanges: false },
    verificationCommands: { test: 'npm test' },
    phase: 'implementation',
    toolRequestUnresolved: false,
    pendingMarkers: [],
    repository: {
      worktreeClean: true,
      branch: 'ai/issue-722',
      localHeadSha: SHA,
      remoteHeadSha: SHA,
      commitsSinceReviewBase: 3,
    },
    durableContext: { prRecorded: true, prHeadBranch: 'ai/issue-722', reviewBaseRecorded: true },
    reviewAdmitted: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Configured-verification matching (#918 §10.2)
// ---------------------------------------------------------------------------

describe('matchesConfiguredVerificationCommand', () => {
  test('exact and trimmed equality match', () => {
    expect(matchesConfiguredVerificationCommand('npm test', 'npm test')).toBe(true);
    expect(matchesConfiguredVerificationCommand('  npm test  ', 'npm test')).toBe(true);
  });

  test('a shell-wrapped session value matches the bare compound command', () => {
    expect(matchesConfiguredVerificationCommand("bash -lc 'cd frontend && npm test'", 'cd frontend && npm test')).toBe(true);
    expect(matchesConfiguredVerificationCommand('sh -c "npm run lint"', 'npm run lint')).toBe(true);
  });

  test('a different command never matches', () => {
    expect(matchesConfiguredVerificationCommand('npm test', 'npm test -- --watch')).toBe(false);
    expect(matchesConfiguredVerificationCommand('npm test', 'npm install left-pad')).toBe(false);
  });

  test('an empty configured command certifies nothing', () => {
    // `runVerification` skips empty command strings rather than spawning them,
    // so an empty entry must never be treated as covering a command.
    expect(matchesConfiguredVerificationCommand('', '')).toBe(false);
    expect(matchesConfiguredVerificationCommand('   ', 'npm test')).toBe(false);
  });
});

describe('resolveConfiguredVerification', () => {
  test('returns the matching entry name in configuration order', () => {
    const resolved = resolveConfiguredVerification('npm test', { typecheck: 'npm run typecheck', test: 'npm test' });
    expect(resolved).toEqual({ name: 'test', command: 'npm test' });
  });

  test('the first matching entry wins deterministically', () => {
    const resolved = resolveConfiguredVerification('npm test', { a: 'npm test', b: 'npm test' });
    expect(resolved.name).toBe('a');
  });

  test('an uncovered command resolves to nothing', () => {
    expect(resolveConfiguredVerification('npm install left-pad', { test: 'npm test' })).toBeUndefined();
    expect(resolveConfiguredVerification('npm test', {})).toBeUndefined();
    expect(resolveConfiguredVerification('npm test', undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pending implementation state
// ---------------------------------------------------------------------------

describe('collectPendingImplementationMarkers', () => {
  test('a clean implementation context has no markers', () => {
    expect(collectPendingImplementationMarkers({ branch: 'ai/issue-722' })).toEqual([]);
    expect(collectPendingImplementationMarkers(undefined)).toEqual([]);
  });

  test('each pending signal produces its stable marker id', () => {
    expect(collectPendingImplementationMarkers({ reviewFeedback: 'fix the guard' })).toEqual(['review-feedback']);
    expect(collectPendingImplementationMarkers({ implementationMode: 'fix' })).toEqual(['fix-mode']);
    expect(collectPendingImplementationMarkers({ conflictedFiles: ['a.ts'] })).toEqual(['conflict-state']);
    expect(collectPendingImplementationMarkers({}, { preservedPatchPending: true })).toEqual(['preserved-patch']);
    expect(
      collectPendingImplementationMarkers({ toolRequest: { partialDiffCaptureFailed: 'diff failed' } }),
    ).toEqual(['partial-diff-capture-failed']);
    expect(collectPendingImplementationMarkers({ missingVerificationCommands: ['npm test'] })).toEqual([
      'missing-verification',
    ]);
    expect(collectPendingImplementationMarkers({ toolRequestChangeAction: { outcome: 'kept' } })).toEqual([
      'unresolved-change-disposition',
    ]);
  });

  test('a closed-out change disposition is not pending', () => {
    for (const outcome of ['committed', 'discarded', 'rejected']) {
      expect(collectPendingImplementationMarkers({ toolRequestChangeAction: { outcome } })).toEqual([]);
    }
  });

  test('markers are emitted in the closed contract order', () => {
    const markers = collectPendingImplementationMarkers(
      {
        missingVerificationCommands: ['npm test'],
        conflictedFiles: ['a.ts'],
        reviewFeedback: 'fix it',
        implementationMode: 'fix',
      },
      { preservedPatchPending: true },
    );
    expect(markers).toEqual(TOOL_REQUEST_PENDING_MARKERS.filter((m) => markers.includes(m)));
    expect(markers[0]).toBe('review-feedback');
  });
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe('decideToolRequestContinuation — the direct-review route', () => {
  test('complete evidence routes to review with every check passed', () => {
    const decision = decideToolRequestContinuation(passingInput());
    expect(decision.phase).toBe('review');
    expect(decision.reason).toBe('direct-review');
    expect(decision.evidence.failedCheck).toBeUndefined();
    expect(decision.evidence.checksPassed).toEqual([...TOOL_REQUEST_CONTINUATION_CHECKS]);
    expect(decision.evidence.verificationName).toBe('test');
    expect(decision.evidence.branch).toBe('ai/issue-722');
  });

  test('the evidence summary carries only bounded, path-safe values', () => {
    const decision = decideToolRequestContinuation(passingInput());
    const serialized = JSON.stringify(decision.evidence);
    expect(serialized).not.toContain('npm test');
    for (const value of Object.values(decision.evidence)) {
      if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(MAX_EVIDENCE_LABEL_CHARS);
    }
  });
});

describe('decideToolRequestContinuation — every check fails closed', () => {
  const cases = [
    ['guided-run-succeeded', 'guided-run-not-successful', { guidedRun: { exitCode: 1, command: 'npm test', disposition: 'no-op', producedChanges: false } }],
    ['configured-verification-command', 'command-not-configured-verification', { verificationCommands: { test: 'npm run other' } }],
    ['no-repository-changes', 'repository-changes-produced', { guidedRun: { exitCode: 0, command: 'npm test', disposition: 'committed', producedChanges: true } }],
    ['implementation-phase', 'phase-not-implementation', { phase: 'conflict_resolution' }],
    ['tool-request-resolved', 'tool-request-unresolved', { toolRequestUnresolved: true }],
    ['no-pending-implementation-state', 'pending-implementation-state', { pendingMarkers: ['review-feedback'] }],
    ['worktree-clean', 'worktree-not-clean', { repository: { ...passingInput().repository, worktreeClean: false } }],
    ['branch-recorded', 'branch-not-recorded', { repository: { ...passingInput().repository, branch: undefined } }],
    ['pr-recorded', 'pr-not-recorded', { durableContext: { prRecorded: false, prHeadBranch: 'ai/issue-722', reviewBaseRecorded: true } }],
    ['pr-head-matches-branch', 'pr-head-mismatch', { durableContext: { prRecorded: true, prHeadBranch: 'other-branch', reviewBaseRecorded: true } }],
    ['review-base-recorded', 'review-base-missing', { durableContext: { prRecorded: true, prHeadBranch: 'ai/issue-722', reviewBaseRecorded: false } }],
    ['branch-pushed', 'branch-not-pushed', { repository: { ...passingInput().repository, remoteHeadSha: 'b'.repeat(40) } }],
    ['committed-work-present', 'no-committed-work', { repository: { ...passingInput().repository, commitsSinceReviewBase: 0 } }],
    ['review-admitted', 'review-admission-rejected', { reviewAdmitted: false }],
  ];

  test.each(cases)('%s failing routes to implementation as %s', (check, reason, override) => {
    const decision = decideToolRequestContinuation(passingInput(override));
    expect(decision.phase).toBe('implementation');
    expect(decision.reason).toBe(reason);
    expect(decision.evidence.failedCheck).toBe(check);
    expect(decision.evidence.checksPassed).not.toContain(check);
  });

  test('every check has a failing case above', () => {
    expect(cases.map(([check]) => check)).toEqual([...TOOL_REQUEST_CONTINUATION_CHECKS]);
  });
});

describe('decideToolRequestContinuation — unprovable evidence', () => {
  test('an unprobeable repository state never passes', () => {
    const decision = decideToolRequestContinuation(
      passingInput({ repository: { branch: 'ai/issue-722' } }),
    );
    expect(decision.phase).toBe('implementation');
    expect(decision.reason).toBe('worktree-not-clean');
    expect(decision.evidence.branchPushed).toBe(false);
    expect(decision.evidence.committedWork).toBe(false);
  });

  test('a branch head with no remote counterpart is not pushed', () => {
    const decision = decideToolRequestContinuation(
      passingInput({ repository: { ...passingInput().repository, remoteHeadSha: undefined } }),
    );
    expect(decision.reason).toBe('branch-not-pushed');
  });

  test('a missing local head is not pushed either (both undefined is not equality)', () => {
    const decision = decideToolRequestContinuation(
      passingInput({ repository: { ...passingInput().repository, localHeadSha: undefined, remoteHeadSha: undefined } }),
    );
    expect(decision.reason).toBe('branch-not-pushed');
  });

  test('a negative or non-numeric base distance is not committed work', () => {
    const decision = decideToolRequestContinuation(
      passingInput({ repository: { ...passingInput().repository, commitsSinceReviewBase: undefined } }),
    );
    expect(decision.reason).toBe('no-committed-work');
  });
});

describe('decideToolRequestContinuation — check ordering', () => {
  test('the first unmet check is the recorded reason, whatever else is missing', () => {
    // An arbitrary command with no repository evidence at all reports the
    // eligibility miss — which is what lets the caller skip the probes.
    const decision = decideToolRequestContinuation(
      passingInput({
        verificationCommands: {},
        repository: {},
        durableContext: { prRecorded: false, reviewBaseRecorded: false },
        reviewAdmitted: false,
      }),
    );
    expect(decision.reason).toBe('command-not-configured-verification');
    expect(decision.evidence.checksPassed).toEqual(['guided-run-succeeded']);
  });

  test('a failed run is reported before eligibility', () => {
    const decision = decideToolRequestContinuation(
      passingInput({ guidedRun: { exitCode: 2, command: 'anything', disposition: 'failed', producedChanges: false } }),
    );
    expect(decision.reason).toBe('guided-run-not-successful');
    expect(decision.evidence.checksPassed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bounded, path-safe evidence
// ---------------------------------------------------------------------------

describe('boundEvidenceLabel', () => {
  test('drops local filesystem locations', () => {
    expect(boundEvidenceLabel('/Users/someone/repo')).toBeUndefined();
    expect(boundEvidenceLabel('~/repo/.n8n-artifacts')).toBeUndefined();
    expect(boundEvidenceLabel('C:\\repo')).toBeUndefined();
    expect(boundEvidenceLabel('a\\b')).toBeUndefined();
  });

  test('keeps ordinary branch names and trims blanks', () => {
    expect(boundEvidenceLabel('  ai/issue-722  ')).toBe('ai/issue-722');
    expect(boundEvidenceLabel('   ')).toBeUndefined();
    expect(boundEvidenceLabel(undefined)).toBeUndefined();
  });

  test('bounds long values', () => {
    expect(boundEvidenceLabel('x'.repeat(500))).toHaveLength(MAX_EVIDENCE_LABEL_CHARS);
  });

  test('an absolute-path branch is dropped from the decision evidence', () => {
    const decision = decideToolRequestContinuation(
      passingInput({ repository: { ...passingInput().repository, branch: '/tmp/checkout' } }),
    );
    expect(decision.reason).toBe('branch-not-recorded');
    expect(decision.evidence.branch).toBeUndefined();
  });
});

describe('buildToolRequestContinuationRecord', () => {
  test('records destination, reason, surface and evidence', () => {
    const decision = decideToolRequestContinuation(passingInput());
    const record = buildToolRequestContinuationRecord(decision, 'guided-run', '2026-08-17T00:00:00.000Z');
    expect(record).toMatchObject({
      destination: 'review',
      reason: 'direct-review',
      surface: 'guided-run',
      decidedAt: '2026-08-17T00:00:00.000Z',
    });
    expect(record.evidence.checksPassed).toHaveLength(TOOL_REQUEST_CONTINUATION_CHECKS.length);
  });

  test('the deprecated grant alias records the same decision under its own surface', () => {
    const decision = decideToolRequestContinuation(passingInput());
    const viaRun = buildToolRequestContinuationRecord(decision, 'guided-run', '2026-08-17T00:00:00.000Z');
    const viaGrant = buildToolRequestContinuationRecord(decision, 'grant', '2026-08-17T00:00:00.000Z');
    expect(viaGrant.destination).toBe(viaRun.destination);
    expect(viaGrant.reason).toBe(viaRun.reason);
    expect(viaGrant.evidence).toEqual(viaRun.evidence);
    expect(viaGrant.surface).toBe('grant');
  });
});
