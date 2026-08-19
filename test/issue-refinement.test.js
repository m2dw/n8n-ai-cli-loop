/**
 * Chain-aware progressive Issue refinement — state foundation (issue #867).
 *
 * Pins the contract vocabulary (§1), the §8 limit table and its fail-closed
 * validation, the §12 row 1/2/47 admission decision, the §10 managed-region
 * scan, the §6 source fingerprint, and the §15 context block including the §14
 * activation plan.
 */

import {
  DEFAULT_REFINEMENT_MARKER_LABEL,
  EXECUTABLE_STATUS_LABELS,
  IMPLEMENTATION_STATUS_LABEL,
  ISSUE_REFINEMENT_DEFAULT_LIMITS,
  ISSUE_REFINEMENT_LIMIT_SPECS,
  REFINEMENT_ACTIVATION_STEPS,
  REFINEMENT_CHANGE_CLASSES,
  REFINEMENT_CONTEXT_KEY,
  REFINEMENT_CRITIC_VERDICTS,
  REFINEMENT_HANDOFF_REASONS,
  REFINEMENT_REFUSAL_REASONS,
  REFINEMENT_STATES,
  REFINEMENT_TOPOLOGY_DISPOSITIONS,
  TERMINAL_REFINEMENT_STATES,
  buildRefinementContextBlock,
  computeIssueSourceFingerprint,
  evaluateRefinementAdmission,
  implementationLaneAgentLabel,
  labelsToPhase,
  readRefinementContextBlock,
  resolveIssueRefinementSettings,
  resolveRefinementLabels,
  scanManagedRegion,
  summarizeRefinementStatus,
} from '../dist/index.js';

const LANE_LABELS = {
  marker: DEFAULT_REFINEMENT_MARKER_LABEL,
  implementationStatus: IMPLEMENTATION_STATUS_LABEL,
};

function settings(overrides = {}) {
  const resolved = resolveIssueRefinementSettings({ enabled: true, ...overrides });
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '));
  return resolved.settings;
}

// ---------------------------------------------------------------------------
// §1 Canonical vocabulary
// ---------------------------------------------------------------------------

describe('issue-refinement — §1 canonical vocabulary', () => {
  test('refinement states are the eight literals, two of them terminal', () => {
    expect([...REFINEMENT_STATES]).toEqual([
      'pending',
      'eligible',
      'drafting',
      'critiquing',
      'accepted',
      'applying',
      'activated',
      'escalated_human',
    ]);
    expect([...TERMINAL_REFINEMENT_STATES].sort()).toEqual(['activated', 'escalated_human']);
  });

  test('closed sets have exactly the sizes the contract fixes', () => {
    expect([...REFINEMENT_CRITIC_VERDICTS]).toEqual(['pass', 'revise', 'block']);
    expect([...REFINEMENT_CHANGE_CLASSES]).toEqual(['applicable', 'advisory']);
    expect([...REFINEMENT_TOPOLOGY_DISPOSITIONS]).toEqual(['advisory', 'blocking']);
    expect([...REFINEMENT_REFUSAL_REASONS]).toEqual([
      'conflicting_markers',
      'no_implementation_agent',
      'predecessor_not_ready',
    ]);
    expect(REFINEMENT_HANDOFF_REASONS).toHaveLength(17);
    expect(REFINEMENT_HANDOFF_REASONS).toEqual(
      expect.arrayContaining(['execution_marker_conflict', 'agent_unavailable', 'marker_precondition_failed']),
    );
  });

  test('the executable status set is the closed six, and includes status:needs-fix', () => {
    expect([...EXECUTABLE_STATUS_LABELS].sort()).toEqual([
      'status:content-needed',
      'status:needs-conflict-resolution',
      'status:needs-fix',
      'status:needs-implementation',
      'status:needs-review',
      'status:research-needed',
    ]);
    // §1: the marker is deliberately not executable.
    expect(EXECUTABLE_STATUS_LABELS).not.toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
  });

  test('the marker is session-overridable; the implementation status stays the intake literal', () => {
    expect(resolveRefinementLabels(undefined)).toEqual({
      marker: 'status:needs-refinement',
      implementationStatus: 'status:needs-implementation',
    });
    // The marker is only ever READ, so a rename is safe. The implementation
    // status is only ever WRITTEN, and `labelsToPhase` gates pickup on the
    // literal — a session alias here would park an implementation row nothing
    // could reactivate (§11 step 7).
    expect(
      resolveRefinementLabels({
        active: 'ai:active',
        blocked: 'ai:blocked',
        readyForHuman: 'ai:rfh',
        needsRefinement: 'status:rough',
        needsImplementation: 'status:go',
      }),
    ).toEqual({ marker: 'status:rough', implementationStatus: 'status:needs-implementation' });
  });
});

// ---------------------------------------------------------------------------
// §12 rows 1, 2, 47 — admission
// ---------------------------------------------------------------------------

describe('issue-refinement — §12 admission (rows 1, 2, 47)', () => {
  test('row 1: marker plus an implementation-lane agent label admits', () => {
    expect(evaluateRefinementAdmission(['status:needs-refinement', 'agent:claude', 'complexity:high'])).toEqual({
      kind: 'admit',
      implementationAgent: 'claude',
      agentLabel: 'agent:claude',
    });
  });

  test('no marker is not this lane’s business at all', () => {
    expect(evaluateRefinementAdmission(['agent:claude', 'status:needs-implementation'])).toEqual({
      kind: 'not_marked',
    });
  });

  test('row 2: EVERY executable status beside the marker refuses with conflicting_markers', () => {
    for (const executable of EXECUTABLE_STATUS_LABELS) {
      const admission = evaluateRefinementAdmission([
        'status:needs-refinement',
        executable,
        'agent:claude',
      ]);
      expect(admission).toEqual({
        kind: 'refused',
        reason: 'conflicting_markers',
        executableStatusLabels: [executable],
      });
    }
  });

  test('row 2 covers status:needs-fix, the route the intake router takes FIRST', () => {
    // The precise failure §3 exists to prevent: a guard derived from a shorter
    // list would leave fix mode as an open door into a rough Issue.
    const admission = evaluateRefinementAdmission([
      'status:needs-refinement',
      'status:needs-fix',
      'agent:codex',
    ]);
    expect(admission.kind).toBe('refused');
    expect(admission.reason).toBe('conflicting_markers');
  });

  test('row 2 reports every conflicting executable status, not just the first', () => {
    const admission = evaluateRefinementAdmission([
      'status:needs-refinement',
      'status:needs-review',
      'status:needs-fix',
      'agent:claude',
    ]);
    expect(admission.executableStatusLabels.sort()).toEqual(['status:needs-fix', 'status:needs-review']);
  });

  test('row 47: the marker with no implementation-lane agent label refuses', () => {
    expect(evaluateRefinementAdmission(['status:needs-refinement', 'complexity:high'])).toEqual({
      kind: 'refused',
      reason: 'no_implementation_agent',
      executableStatusLabels: [],
    });
  });

  test('row 2 wins over row 47 — the two refusals never merge', () => {
    // Both conditions fail at once; §4 decides condition 1 as one ordered test,
    // and the two are repaired by opposite label edits.
    const admission = evaluateRefinementAdmission(['status:needs-refinement', 'status:needs-fix']);
    expect(admission.reason).toBe('conflicting_markers');
  });

  test('multiple agent labels are resolved by the implementation lane’s own precedence', () => {
    expect(
      evaluateRefinementAdmission(['status:needs-refinement', 'agent:gemini', 'agent:codex', 'agent:claude'])
        .implementationAgent,
    ).toBe('claude');
    expect(
      evaluateRefinementAdmission(['status:needs-refinement', 'agent:gemini', 'agent:codex'])
        .implementationAgent,
    ).toBe('codex');
    expect(
      evaluateRefinementAdmission(['status:needs-refinement', 'agent:gemini']).implementationAgent,
    ).toBe('gemini');
  });

  test('a session-renamed marker is honoured, and the default no longer admits', () => {
    expect(evaluateRefinementAdmission(['status:rough', 'agent:claude'], 'status:rough').kind).toBe('admit');
    expect(evaluateRefinementAdmission(['status:needs-refinement', 'agent:claude'], 'status:rough').kind).toBe(
      'not_marked',
    );
  });

  test('implementationLaneAgentLabel reports the label, or nothing', () => {
    expect(implementationLaneAgentLabel(['agent:codex'])).toEqual({ label: 'agent:codex', agent: 'codex' });
    expect(implementationLaneAgentLabel(['agent:unknown'])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §8 limits
// ---------------------------------------------------------------------------

describe('issue-refinement — §8 limits', () => {
  test('defaults are the contract table verbatim', () => {
    expect(ISSUE_REFINEMENT_DEFAULT_LIMITS).toEqual({
      maxPredecessorsPerRefinement: 4,
      maxRefinementRoundsPerIssue: 2,
      maxMalformedAttemptsPerRole: 2,
      maxAgentFailuresPerRole: 2,
      maxStaleRestartsPerIssue: 1,
      maxCommentsPerPredecessor: 5,
      maxSnapshotTextBytes: 8000,
      maxChangedPathsPerPredecessor: 100,
      maxManagedRegionBytes: 16000,
    });
  });

  test('the lane is off unless a session opts in', () => {
    expect(resolveIssueRefinementSettings(undefined).settings.enabled).toBe(false);
    expect(resolveIssueRefinementSettings({}).settings.enabled).toBe(false);
    expect(resolveIssueRefinementSettings({ enabled: false }).settings.enabled).toBe(false);
    expect(resolveIssueRefinementSettings({ enabled: true }).settings.enabled).toBe(true);
  });

  test('a limit may be lowered but never raised', () => {
    const lowered = resolveIssueRefinementSettings({ limits: { maxRefinementRoundsPerIssue: 1 } });
    expect(lowered.ok).toBe(true);
    expect(lowered.settings.limits.maxRefinementRoundsPerIssue).toBe(1);

    const raised = resolveIssueRefinementSettings({ limits: { maxRefinementRoundsPerIssue: 3 } });
    expect(raised.ok).toBe(false);
    expect(raised.errors[0]).toMatchObject({
      code: 'above-default',
      constant: 'MAX_REFINEMENT_ROUNDS_PER_ISSUE',
    });
  });

  test('exactly six limits reject 0; the other three accept it', () => {
    const rejectsZero = [];
    const acceptsZero = [];
    for (const key of Object.keys(ISSUE_REFINEMENT_LIMIT_SPECS)) {
      const resolved = resolveIssueRefinementSettings({ limits: { [key]: 0 } });
      (resolved.ok ? acceptsZero : rejectsZero).push(key);
    }
    expect(rejectsZero.sort()).toEqual([
      'maxChangedPathsPerPredecessor',
      'maxMalformedAttemptsPerRole',
      'maxManagedRegionBytes',
      'maxPredecessorsPerRefinement',
      'maxRefinementRoundsPerIssue',
      'maxSnapshotTextBytes',
    ]);
    expect(acceptsZero.sort()).toEqual([
      'maxAgentFailuresPerRole',
      'maxCommentsPerPredecessor',
      'maxStaleRestartsPerIssue',
    ]);
  });

  test('a non-integer limit is rejected rather than coerced', () => {
    const resolved = resolveIssueRefinementSettings({ limits: { maxSnapshotTextBytes: '4000' } });
    expect(resolved.ok).toBe(false);
    expect(resolved.errors[0].code).toBe('not-an-integer');
  });

  test('every problem is reported, not just the first', () => {
    const resolved = resolveIssueRefinementSettings({
      enabled: 'yes',
      limits: { maxRefinementRoundsPerIssue: 0, maxPredecessorsPerRefinement: 9 },
      agents: { refiner: 'gpt' },
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.errors.map((e) => e.code).sort()).toEqual([
      'above-default',
      'below-minimum',
      'not-a-boolean',
      'not-an-agent-id',
    ]);
  });

  test('refiner/critic must name a known agent id', () => {
    const ok = resolveIssueRefinementSettings({ agents: { refiner: 'codex', critic: 'gemini', allowSameProvider: true } });
    expect(ok.settings.agents).toEqual({ refiner: 'codex', critic: 'gemini', allowSameProvider: true });
    expect(resolveIssueRefinementSettings({ agents: { critic: 'reviewer' } }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §10 managed region / §6 source fingerprint
// ---------------------------------------------------------------------------

const BEGIN = '<!-- ai-refinement:begin fingerprint=abc123def456 -->';
const END = '<!-- ai-refinement:end -->';

describe('issue-refinement — §10 managed region scan', () => {
  test('zero markers is the normal first-refinement case', () => {
    const scan = scanManagedRegion('Original body.\n');
    expect(scan.shape).toBe('absent');
    expect(scan.sourceBody).toBe('Original body.');
    expect(scan.fingerprintPrefix).toBeNull();
  });

  test('a well-formed pair is elided with its blank-line separator', () => {
    const body = `Original body.\n\n${BEGIN}\n### Refined contract\ntext\n${END}\n`;
    const scan = scanManagedRegion(body);
    expect(scan.shape).toBe('present');
    expect(scan.sourceBody).toBe('Original body.');
    expect(scan.fingerprintPrefix).toBe('abc123def456');
  });

  test('unbalanced, duplicated, and out-of-order markers are malformed', () => {
    for (const body of [
      `Body\n${BEGIN}\ntext\n`,
      `Body\n${END}\n`,
      `Body\n${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`,
      `Body\n${END}\ntext\n${BEGIN}\n`,
    ]) {
      expect(scanManagedRegion(body).shape).toBe('malformed');
    }
  });

  test('a malformed region is reported, never repaired', () => {
    const body = `Body\n${BEGIN}\ntext\n`;
    // The elision is undefined for a malformed region, so the raw body stands.
    expect(scanManagedRegion(body).sourceBody).toBe(body);
  });
});

describe('issue-refinement — §6 source fingerprint', () => {
  const base = {
    issueNumber: 867,
    title: 'Add progressive-refinement task state',
    body: 'Original body.\n',
    labels: ['status:needs-refinement', 'agent:claude', 'complexity:high'],
    laneLabels: LANE_LABELS,
  };

  test('the two lane-owned labels are excluded, so step 5 cannot invalidate it', () => {
    const before = computeIssueSourceFingerprint(base).digest;
    const after = computeIssueSourceFingerprint({
      ...base,
      // Exactly the §11 step-5 transition: marker out, implementation status in.
      labels: ['agent:claude', 'complexity:high', 'status:needs-implementation'],
    }).digest;
    expect(after).toBe(before);
  });

  test('every other label change moves it', () => {
    const before = computeIssueSourceFingerprint(base).digest;
    const after = computeIssueSourceFingerprint({ ...base, labels: [...base.labels, 'complexity:low'] }).digest;
    expect(after).not.toBe(before);
  });

  test('label order and duplicates do not move it', () => {
    const a = computeIssueSourceFingerprint(base).digest;
    const b = computeIssueSourceFingerprint({
      ...base,
      labels: ['complexity:high', 'agent:claude', 'agent:claude', 'status:needs-refinement'],
    }).digest;
    expect(b).toBe(a);
  });

  test('appending a managed region does not move it, but an edit outside one does', () => {
    const before = computeIssueSourceFingerprint(base);
    expect(before.managedRegion).toBe('absent');

    const withRegion = computeIssueSourceFingerprint({
      ...base,
      body: `Original body.\n\n${BEGIN}\n### Refined contract\ntext\n${END}\n`,
    });
    expect(withRegion.digest).toBe(before.digest);
    expect(withRegion.managedRegion).toBe('present');

    const editedOutside = computeIssueSourceFingerprint({
      ...base,
      body: `Original body, amended by the operator.\n\n${BEGIN}\ntext\n${END}\n`,
    });
    expect(editedOutside.digest).not.toBe(before.digest);
  });

  test('title, issue number, and body all participate', () => {
    const before = computeIssueSourceFingerprint(base).digest;
    expect(computeIssueSourceFingerprint({ ...base, title: 'Other' }).digest).not.toBe(before);
    expect(computeIssueSourceFingerprint({ ...base, issueNumber: 868 }).digest).not.toBe(before);
    expect(computeIssueSourceFingerprint({ ...base, body: 'Other body.' }).digest).not.toBe(before);
  });

  test('a missing body is a defined input, not a crash', () => {
    const digest = computeIssueSourceFingerprint({ ...base, body: undefined }).digest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// §15 context block / §14 activation plan
// ---------------------------------------------------------------------------

describe('issue-refinement — §15 context block', () => {
  const input = {
    issueNumber: 867,
    title: 'Add progressive-refinement task state',
    body: 'Original body.',
    labels: ['status:needs-refinement', 'agent:codex'],
    agentLabel: 'agent:codex',
    implementationAgent: 'codex',
    refinerAgent: 'claude',
    criticAgent: 'gemini',
    settings: settings(),
    laneLabels: LANE_LABELS,
    now: '2026-08-10T00:00:00.000Z',
  };

  test('a freshly admitted task starts at pending with zeroed counters', () => {
    const block = buildRefinementContextBlock(input);
    expect(block.state).toBe('pending');
    expect(block.counters).toEqual({
      rounds: 0,
      malformedAttempts: { refiner: 0, critic: 0 },
      agentFailures: { refiner: 0, critic: 0 },
      staleRestarts: 0,
    });
    expect(block.handoffReason).toBeNull();
    // Admission is §4 condition 1 only; conditions 2–5 are predecessor
    // resolution, which has not run.
    expect(block.predecessors).toEqual([]);
    expect(block.predecessorFingerprint).toBeNull();
    expect(block.appliedRegionDigest).toBeNull();
    expect(block.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(block.managedRegion).toBe('absent');
  });

  test('the §8 limits in force are pinned onto the attempt', () => {
    const block = buildRefinementContextBlock({
      ...input,
      settings: settings({ limits: { maxRefinementRoundsPerIssue: 1, maxStaleRestartsPerIssue: 0 } }),
    });
    expect(block.limits.maxRefinementRoundsPerIssue).toBe(1);
    expect(block.limits.maxStaleRestartsPerIssue).toBe(0);
    expect(block.limits.maxPredecessorsPerRefinement).toBe(4);
  });

  test('§14: the deferred implementation activation is explicit', () => {
    const block = buildRefinementContextBlock(input);
    expect(block.activationPlan).toEqual({
      targetPhase: 'implementation',
      targetStatus: 'blocked',
      implementationMode: 'new',
      implementationAgent: 'codex',
      agentLabel: 'agent:codex',
      markerLabel: 'status:needs-refinement',
      implementationStatusLabel: 'status:needs-implementation',
      steps: [...REFINEMENT_ACTIVATION_STEPS],
      plannedAt: '2026-08-10T00:00:00.000Z',
    });
  });

  test('§11 step 7: the planned activation label is one ordinary intake can route', () => {
    // A session that renames `needsImplementation` must not push that alias into
    // the plan: `labelsToPhase` only ever gates on the literal, so activation
    // would otherwise leave the parked implementation row blocked forever.
    const laneLabels = resolveRefinementLabels({
      active: 'ai:active',
      blocked: 'ai:blocked',
      readyForHuman: 'ai:rfh',
      needsImplementation: 'status:go',
    });
    const block = buildRefinementContextBlock({ ...input, laneLabels });
    expect(block.activationPlan.implementationStatusLabel).toBe('status:needs-implementation');
    // The pair activation leaves behind routes to a NEW implementation owned by
    // the pinned agent — the plan's own targetPhase/implementationMode.
    expect(
      labelsToPhase([block.activationPlan.agentLabel, block.activationPlan.implementationStatusLabel]),
    ).toEqual({
      phase: block.activationPlan.targetPhase,
      implementationMode: block.activationPlan.implementationMode,
      implementationAgent: block.activationPlan.implementationAgent,
    });
  });

  test('§11: the activation steps are ordered, labels last and removal before addition', () => {
    expect([...REFINEMENT_ACTIVATION_STEPS]).toEqual([
      'verify_fingerprint',
      'persist_accepted',
      'update_issue_body',
      'post_audit_comment',
      'transition_labels',
      'park_task_row',
      'reactivate_via_intake',
    ]);
  });

  test('§14 roles: an unconfigured refiner or critic is recorded null, never defaulted', () => {
    const block = buildRefinementContextBlock({
      ...input,
      refinerAgent: undefined,
      criticAgent: undefined,
    });
    expect(block.roles).toEqual({
      implementationAgent: 'codex',
      refinerAgent: null,
      criticAgent: null,
      allowSameProvider: false,
    });
  });

  test('the block round-trips through the tolerant reader', () => {
    const block = buildRefinementContextBlock(input);
    expect(readRefinementContextBlock({ [REFINEMENT_CONTEXT_KEY]: block })).toEqual(block);
    expect(readRefinementContextBlock({})).toBeUndefined();
    expect(readRefinementContextBlock(undefined)).toBeUndefined();
    // A block with no recognised state is reported absent rather than defaulted
    // to `pending` — that would claim a lane that may already have run.
    expect(readRefinementContextBlock({ [REFINEMENT_CONTEXT_KEY]: { state: 'weird' } })).toBeUndefined();
  });
});

describe('issue-refinement — operator projection', () => {
  const block = buildRefinementContextBlock({
    issueNumber: 867,
    title: 'T',
    labels: ['status:needs-refinement', 'agent:claude'],
    agentLabel: 'agent:claude',
    implementationAgent: 'claude',
    refinerAgent: 'claude',
    criticAgent: 'codex',
    settings: settings(),
    laneLabels: LANE_LABELS,
    now: '2026-08-10T00:00:00.000Z',
  });

  test('a task with no refinement block projects to null', () => {
    expect(summarizeRefinementStatus({ context: {} })).toBeNull();
    expect(summarizeRefinementStatus({ context: { assignment: {} } })).toBeNull();
  });

  test('a refinement task projects its state, counters, roles, and activation plan', () => {
    const summary = summarizeRefinementStatus({ context: { [REFINEMENT_CONTEXT_KEY]: block } });
    expect(summary).toMatchObject({
      state: 'pending',
      terminal: false,
      handoffReason: null,
      predecessorFingerprint: null,
      managedRegion: 'absent',
      predecessors: [],
      refinerAgent: 'claude',
      criticAgent: 'codex',
    });
    expect(summary.counters.rounds).toBe(0);
    expect(summary.activation).toMatchObject({
      targetPhase: 'implementation',
      targetStatus: 'blocked',
      implementationAgent: 'claude',
      agentLabel: 'agent:claude',
      markerLabel: 'status:needs-refinement',
      implementationStatusLabel: 'status:needs-implementation',
    });
  });

  test('a terminal state and a handoff reason are surfaced', () => {
    const summary = summarizeRefinementStatus({
      context: {
        [REFINEMENT_CONTEXT_KEY]: { ...block, state: 'escalated_human', handoffReason: 'not_chain_scoped' },
      },
    });
    expect(summary.state).toBe('escalated_human');
    expect(summary.terminal).toBe(true);
    expect(summary.handoffReason).toBe('not_chain_scoped');
  });

  test('a drifted block is rendered, not hidden — but nothing is invented', () => {
    const summary = summarizeRefinementStatus({
      context: {
        [REFINEMENT_CONTEXT_KEY]: { state: 'drafting', counters: { rounds: 'two' }, roles: {} },
      },
    });
    expect(summary.state).toBe('drafting');
    expect(summary.counters.rounds).toBeNull();
    expect(summary.refinerAgent).toBeNull();
    expect(summary.activation).toBeNull();
  });
});
