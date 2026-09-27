// Issue #1102 — docs/staged-verification-contract.md §6.1's stage outcome
// precedence and its accounted-absence table, §4.3's proven projection, §6.2
// rule 6's evidence-bound requirement verdicts, the bundle assembly over both,
// and §10 rule 5's bounded public projection.
//
// Pure throughout: no process, no filesystem, no store. The §14 matrix rows
// this file owns are "Outcomes (§6.1)", the requirement half of "Evidence
// (§6.2)", and the scope half of "Compatibility (§10)".

import {
  STAGE_OUTCOME_PRECEDENCE,
  aggregateStageOutcome,
  stageCheckHostFailure,
  provenExecutionProjection,
  requirementSatisfierMap,
  deriveStageRequirementRecords,
  buildStageRunResultInput,
  summarizeStageRun,
  passedStageCheckNames,
  requiredSlotsByCheckId,
  buildCheckExecutionRecord,
  classifyCheckExecution,
  resolveEffectiveVerificationPlan,
  buildEffectiveRequirementStatus,
  executionSatisfiesRequirement,
  requiredStageChecks,
  requiredStageSelection,
  deriveStageSelectionDigest,
  validateStagedVerificationState,
  legacyStageEvidenceIdentity,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plan(sessionVerification, issueRequirements = []) {
  const resolved = resolveEffectiveVerificationPlan({ sessionVerification, issueRequirements });
  if (resolved.status !== 'resolved') throw new Error(`unresolvable plan: ${resolved.detail}`);
  return resolved.plan;
}

function execRecord(checkId, verdict, overrides = {}) {
  const base = {
    checkId,
    name: checkId.replace(/^exec:/, ''),
    command: `npm run ${checkId}`,
  };
  if (verdict === 'passed') {
    return buildCheckExecutionRecord({ ...base, run: { exitCode: 0, stdout: 'ok', stderr: '' }, ...overrides });
  }
  if (verdict === 'failed') {
    return buildCheckExecutionRecord({ ...base, run: { exitCode: 1, stdout: 'boom', stderr: '' }, ...overrides });
  }
  if (verdict === 'timed-out') {
    return buildCheckExecutionRecord({ ...base, run: { exitCode: 1, stdout: '', stderr: '', timedOut: true }, ...overrides });
  }
  return buildCheckExecutionRecord({ ...base, ...overrides });
}

function outcomeOf(checks, { runCompleted = true, requirementSatisfiers } = {}) {
  return aggregateStageOutcome({
    selectedCheckIds: checks.map((check) => check.record.checkId),
    checks,
    runCompleted,
    ...(requirementSatisfiers ? { requirementSatisfiers } : {}),
  }).outcome;
}

// ---------------------------------------------------------------------------
// The required set (issue #1155)
// ---------------------------------------------------------------------------

// Relocated from the deleted `test/stage-selection.test.js` with the functions
// themselves: issue #1155 retired the five-set union, the `selectable` /
// `finalOnly` membership and the selection port, so the required set is the
// whole of what a stage covers. These pins are what stop a later change from
// reintroducing a narrowing between the plan and the run.
describe('the required set a stage covers (#1155)', () => {
  test('is every active slot, execution layer first, each in plan order', () => {
    const p = plan({ test: 'npm test', lint: 'npm run lint' }, ['npm test']);
    expect(requiredStageChecks(p).map((slot) => slot.commandId)).toEqual([
      'exec:test',
      'exec:lint',
      ...p.requirement.filter((slot) => slot.state === 'active').map((slot) => slot.commandId),
    ]);
  });

  test('a retired slot is not required, so it can never be run', () => {
    const p = plan({ test: 'npm test' });
    const retired = {
      ...p,
      execution: p.execution.map((slot) => ({ ...slot, state: 'retired' })),
    };
    expect(requiredStageChecks(retired)).toEqual([]);
    expect(requiredStageSelection(retired).selection).toEqual({
      checkIds: [],
      selectionDigest: deriveStageSelectionDigest([]),
      // An empty required set is still the whole of it: a run over it proves
      // everything the plan asks for, so it must not read as a narrowed run.
      full: true,
    });
  });

  test('the selection is the whole required set, and says so', () => {
    const p = plan({ test: 'npm test', lint: 'npm run lint' }, ['npm test']);
    const { selection, checks } = requiredStageSelection(p);
    expect(selection.checkIds).toEqual(requiredStageChecks(p).map((slot) => slot.commandId));
    expect(selection.full).toBe(true);
    expect(selection.selectionDigest).toBe(deriveStageSelectionDigest(selection.checkIds));
    // Nothing in the record says *why* a check is present: there is no policy
    // left to record, and no `source` to distinguish one selection from another.
    expect(Object.keys(selection).sort()).toEqual(['checkIds', 'full', 'selectionDigest']);
    expect(checks.find((check) => check.checkId === 'exec:test').name).toBe('test');
    // A requirement slot has no name of its own.
    expect(checks.find((check) => check.checkId.startsWith('req:')).name).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
// §6.1 — precedence
// ---------------------------------------------------------------------------

describe('stage outcome precedence (§6.1)', () => {
  test('the precedence order is the contract order, strongest claim first', () => {
    expect([...STAGE_OUTCOME_PRECEDENCE]).toEqual([
      'interrupted',
      'unknown',
      'infrastructure',
      'code-failed',
      'timed-out',
    ]);
  });

  test('all checks passing is the only way to `passed`', () => {
    expect(outcomeOf([{ record: execRecord('exec:test', 'passed') }, { record: execRecord('exec:lint', 'passed') }]))
      .toBe('passed');
  });

  test('an empty selection over an empty required set is `passed`', () => {
    expect(aggregateStageOutcome({ selectedCheckIds: [], checks: [], runCompleted: true }).outcome).toBe('passed');
  });

  test('a failing check is `code-failed`, and a host failure beside it wins', () => {
    expect(outcomeOf([{ record: execRecord('exec:test', 'failed') }])).toBe('code-failed');
    expect(outcomeOf([
      { record: execRecord('exec:test', 'failed') },
      { record: execRecord('exec:lint', 'failed'), hostFailure: true },
    ])).toBe('infrastructure');
  });

  test('a timeout is a verdict, and a failure outranks it', () => {
    expect(outcomeOf([{ record: execRecord('exec:test', 'timed-out') }])).toBe('timed-out');
    expect(outcomeOf([
      { record: execRecord('exec:test', 'timed-out') },
      { record: execRecord('exec:lint', 'failed') },
    ])).toBe('code-failed');
  });

  test('`unknown` never aggregates to `passed` and outranks a failure', () => {
    const unknown = { ...execRecord('exec:test', 'passed'), verdict: 'unknown' };
    expect(outcomeOf([{ record: unknown }, { record: execRecord('exec:lint', 'failed') }])).toBe('unknown');
  });

  test('a selected check with no record at all is evidence loss, never a pass', () => {
    const aggregation = aggregateStageOutcome({
      selectedCheckIds: ['exec:test', 'exec:lint'],
      checks: [{ record: execRecord('exec:test', 'passed') }],
      runCompleted: true,
    });
    expect(aggregation.outcome).toBe('unknown');
    expect(aggregation.noVerdictCheckIds).toEqual(['exec:lint']);
    expect(aggregation.contributions[1]).toMatchObject({ verdict: 'absent', admittedNotRunKind: 'evidence-lost' });
  });

  test('the same absence is `interrupted` when the run did not complete', () => {
    expect(outcomeOf(
      [{ record: execRecord('exec:test', 'not-run', { notRunKind: 'evidence-lost' }) }],
      { runCompleted: false },
    )).toBe('interrupted');
    expect(outcomeOf([{ record: execRecord('exec:test', 'not-run', { notRunKind: 'evidence-lost' }) }]))
      .toBe('unknown');
  });

  test('the infrastructure signal is the shipped classifiers`, not a second one', () => {
    const missingScript = { exitCode: 1, stdout: '', stderr: 'npm ERR! Missing script: "test"' };
    expect(stageCheckHostFailure(classifyCheckExecution('test', missingScript))).toBe(true);
    expect(stageCheckHostFailure(classifyCheckExecution('test', { exitCode: 1, stdout: 'assert failed', stderr: '' })))
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6.1 — the accounted-absence table
// ---------------------------------------------------------------------------

describe('accounted absences (§6.1)', () => {
  test('a fail-fast stop routes by the failure, not by the absence', () => {
    const aggregation = aggregateStageOutcome({
      selectedCheckIds: ['exec:test', 'exec:lint'],
      checks: [
        { record: execRecord('exec:test', 'failed') },
        { record: execRecord('exec:lint', 'not-run', { notRunKind: 'first-failure-stop' }) },
      ],
      runCompleted: true,
    });
    expect(aggregation.outcome).toBe('code-failed');
    expect(aggregation.contributions[1].contributes).toBe('none');
    // The skip is never a pass: it stays unproven and is pinned for the next
    // cycle (§6.3 R6).
    expect(aggregation.unprovenCheckIds).toEqual(['exec:test', 'exec:lint']);
  });

  test('a fail-fast stop with nothing to blame is evidence loss', () => {
    const aggregation = aggregateStageOutcome({
      selectedCheckIds: ['exec:test'],
      checks: [{ record: execRecord('exec:test', 'not-run', { notRunKind: 'first-failure-stop' }) }],
      runCompleted: true,
    });
    expect(aggregation.outcome).toBe('unknown');
    expect(aggregation.contributions[0].admittedNotRunKind).toBe('evidence-lost');
  });

  test('an absent or unrecognized cause is evidence loss', () => {
    for (const notRunKind of [undefined, 'made-up-cause']) {
      const record = { ...execRecord('exec:test', 'not-run', { notRunKind: 'evidence-lost' }), notRunKind };
      expect(outcomeOf([{ record }])).toBe('unknown');
    }
  });

  test('each remaining cause contributes exactly its table row', () => {
    const rows = [
      ['set-budget-exhausted', 'timed-out'],
      ['infrastructure-stop', 'infrastructure'],
      ['sandbox-policy-stop', 'infrastructure'],
      ['cancellation-stop', 'interrupted'],
    ];
    for (const [notRunKind, expected] of rows) {
      expect(outcomeOf([{ record: execRecord('exec:test', 'not-run', { notRunKind }) }])).toBe(expected);
    }
  });

  test('`requirement-unproven` is admissible only on a req: check with a blamed satisfier', () => {
    const satisfiers = new Map([['req:abc', ['exec:test']]]);
    const requirement = {
      checkId: 'req:abc',
      commandDigest: 'd',
      verdict: 'not-run',
      notRunKind: 'requirement-unproven',
    };
    // Row 1: alongside a failing satisfier it contributes nothing, so the run
    // is `code-failed` and routes to the repair path, never to an operator park.
    expect(outcomeOf(
      [{ record: execRecord('exec:test', 'failed') }, { record: requirement }],
      { requirementSatisfiers: satisfiers },
    )).toBe('code-failed');
    // Alongside a timed-out satisfier: `timed-out`, never `unknown`.
    expect(outcomeOf(
      [{ record: execRecord('exec:test', 'timed-out') }, { record: requirement }],
      { requirementSatisfiers: satisfiers },
    )).toBe('timed-out');
    // No blamed satisfier in this bundle: evidence loss.
    expect(outcomeOf(
      [{ record: execRecord('exec:test', 'passed') }, { record: requirement }],
      { requirementSatisfiers: satisfiers },
    )).toBe('unknown');
    // Not a `req:` check at all: evidence loss.
    expect(outcomeOf([
      { record: execRecord('exec:test', 'failed') },
      { record: execRecord('exec:lint', 'not-run', { notRunKind: 'requirement-unproven' }) },
    ])).toBe('unknown');
    // No satisfier map at all: the admissibility condition is unestablished.
    expect(outcomeOf([{ record: execRecord('exec:test', 'failed') }, { record: requirement }]))
      .toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// §4.3 — the proven projection
// ---------------------------------------------------------------------------

describe('proven projection (§4.3)', () => {
  const p = plan({ test: 'npm test', lint: 'npm run lint' }, ['npm test']);

  test('narrows the execution layer to the checks this run proved green', () => {
    const projected = provenExecutionProjection(p, [
      { checkId: 'exec:test', verdict: 'failed' },
      { checkId: 'exec:lint', verdict: 'passed' },
    ]);
    expect(projected.execution.map((slot) => slot.commandId)).toEqual(['exec:lint']);
    // Nothing else about the plan changes.
    expect(projected.planDigest).toBe(p.planDigest);
    expect(projected.requirement).toBe(p.requirement);
  });

  test('the shipped plan-level call keeps the shipped plan-level answer', () => {
    // The plan says `npm test` is configured, so the plan-level question is
    // `passed` — while the same run that never proved it reads `not_run`.
    expect(buildEffectiveRequirementStatus(p)[0].status).toBe('passed');
    const projected = provenExecutionProjection(p, [{ checkId: 'exec:test', verdict: 'failed' }]);
    expect(buildEffectiveRequirementStatus(projected)[0].status).toBe('not_run');
  });

  test('the satisfier map names every active execution slot that matches', () => {
    const satisfiers = requirementSatisfierMap(p);
    const reqId = p.requirement[0].commandId;
    expect(satisfiers.get(reqId)).toEqual(['exec:test']);
  });
});

// ---------------------------------------------------------------------------
// Issue #1166 — the operator's declared full-suite requirement alias
// (docs/changed-file-verification-contract.md §6 rule 5)
// ---------------------------------------------------------------------------

describe('the declared full-suite requirement alias (#1166)', () => {
  const p = plan({ test: 'npm run test:files', lint: 'npm run lint' }, ['npm test']);
  const reqId = p.requirement[0].commandId;
  const declared = { boundKey: 'test', requirementCommands: ['npm test'] };

  test('the relation itself: the bound slot only, and only for declared text', () => {
    const suite = { name: 'test', command: 'npm run test:files' };
    const lint = { name: 'lint', command: 'npm run lint' };
    expect(executionSatisfiesRequirement(suite, 'npm test', declared)).toBe(true);
    // The shipped bytes rule still stands on its own.
    expect(executionSatisfiesRequirement(suite, 'npm run test:files')).toBe(true);
    // Without the declaration nothing is inferred from the command text.
    expect(executionSatisfiesRequirement(suite, 'npm test')).toBe(false);
    // Another slot never inherits the declaration, whatever it runs.
    expect(executionSatisfiesRequirement(lint, 'npm test', declared)).toBe(false);
    // A near-miss is a different command; the equivalence stays exact.
    expect(executionSatisfiesRequirement(suite, 'npm test --silent', declared)).toBe(false);
    // The declaration is read exactly as a configured command is: a declared
    // `bash -lc '<cmd>'` is a runnable form of `<cmd>`, and nothing more.
    expect(executionSatisfiesRequirement(suite, 'npm test', {
      boundKey: 'test',
      requirementCommands: ["bash -lc 'npm test'"],
    })).toBe(true);
    expect(executionSatisfiesRequirement(suite, "bash -lc 'npm test'", declared)).toBe(false);
  });

  test('the plan-level status and the satisfier map both read the declaration', () => {
    expect(buildEffectiveRequirementStatus(p)[0].status).toBe('not_run');
    expect(buildEffectiveRequirementStatus(p, undefined, undefined, declared)[0]).toMatchObject({
      status: 'passed',
      satisfiedBy: 'execution',
    });
    expect(requirementSatisfierMap(p).get(reqId)).toEqual([]);
    expect(requirementSatisfierMap(p, declared).get(reqId)).toEqual(['exec:test']);
  });

  test('it is an identity, not evidence: only the run that proved the suite credits it', () => {
    const derive = (executionRecords) =>
      deriveStageRequirementRecords({
        plan: p,
        selected: [{ checkId: reqId }],
        executionRecords,
        fullSuite: declared,
      }).records[0];
    expect(derive([execRecord('exec:test', 'passed')]).verdict).toBe('passed');
    expect(derive([execRecord('exec:test', 'failed')])).toMatchObject({
      verdict: 'not-run',
      notRunKind: 'requirement-unproven',
    });
    // No record for the suite at all: the declaration invents none.
    expect(derive([execRecord('exec:lint', 'passed')]).verdict).toBe('not-run');
  });
});

// ---------------------------------------------------------------------------
// §6.2 rule 6 — requirement verdicts come from evidence
// ---------------------------------------------------------------------------

describe('requirement verdicts (§6.2 rule 6)', () => {
  const p = plan({ test: 'npm test', lint: 'npm run lint' }, ['npm test']);
  const reqId = p.requirement[0].commandId;
  const selected = [{ checkId: reqId }];

  const derive = (executionRecords, extra = {}) =>
    deriveStageRequirementRecords({ plan: p, selected, executionRecords, ...extra }).records[0];

  test('passed only when the satisfying check passed in THIS run', () => {
    expect(derive([execRecord('exec:test', 'passed')]).verdict).toBe('passed');
  });

  test('a failed satisfier leaves it not-run with `requirement-unproven`', () => {
    expect(derive([execRecord('exec:test', 'failed')])).toMatchObject({
      verdict: 'not-run',
      notRunKind: 'requirement-unproven',
    });
  });

  test('a timed-out satisfier is `requirement-unproven` too', () => {
    expect(derive([execRecord('exec:test', 'timed-out')]).notRunKind).toBe('requirement-unproven');
  });

  test('a fail-fast-skipped satisfier hands over its own cause', () => {
    expect(derive([execRecord('exec:test', 'not-run', { notRunKind: 'first-failure-stop' })]).notRunKind)
      .toBe('first-failure-stop');
  });

  test('an unselected satisfier, and one whose own verdict is unknown, are evidence loss', () => {
    expect(derive([execRecord('exec:lint', 'passed')]).notRunKind).toBe('evidence-lost');
    const unknown = { ...execRecord('exec:test', 'passed'), verdict: 'unknown' };
    expect(derive([unknown]).notRunKind).toBe('evidence-lost');
  });

  test('admissible manual evidence still satisfies it (§4.3)', () => {
    const record = derive([execRecord('exec:test', 'failed')], {
      manualEvidence: [{ command: 'npm test', exitCode: 0 }],
    });
    expect(record.verdict).toBe('passed');
  });

  test('a requirement record carries no name and no command bytes', () => {
    const record = derive([execRecord('exec:test', 'passed')]);
    expect(record.name).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('npm test');
  });
});

// ---------------------------------------------------------------------------
// Assembly — the bundle #1099 persists
// ---------------------------------------------------------------------------

describe('bundle assembly', () => {
  const p = plan({ test: 'npm test', lint: 'npm run lint' }, ['npm test']);
  const selection = requiredStageSelection(p);
  const stageRunId = { taskAttempt: 1, lane: 'implementation', stage: 'loop', stageOrdinal: 0 };

  const assemble = (executionChecks, overrides = {}) =>
    buildStageRunResultInput({
      stageRunId,
      plan: p,
      selection: selection.selection,
      selected: selection.checks,
      executionChecks,
      runCompleted: true,
      headSha: 'a'.repeat(40),
      ...overrides,
    });

  test('a green run produces a complete, passed bundle covering every selected check', () => {
    const assembly = assemble([
      { record: execRecord('exec:test', 'passed') },
      { record: execRecord('exec:lint', 'passed') },
    ]);
    expect(assembly.bundle.outcome).toBe('passed');
    expect(assembly.bundle.complete).toBe(true);
    expect(assembly.bundle.checks.map((c) => c.checkId).sort())
      .toEqual([...selection.selection.checkIds].sort());
    expect(assembly.integrityDefect).toBeUndefined();
  });

  test('a fail-fast bundle is incomplete, code-failed, and never a grant', () => {
    const assembly = assemble([
      { record: execRecord('exec:test', 'failed') },
      { record: execRecord('exec:lint', 'not-run', { notRunKind: 'first-failure-stop' }) },
    ]);
    expect(assembly.bundle.outcome).toBe('code-failed');
    expect(assembly.bundle.complete).toBe(false);
    // The requirement rides the execution failure rather than becoming unknown.
    const requirement = assembly.bundle.checks.find((c) => c.checkId.startsWith('req:'));
    expect(requirement).toMatchObject({ verdict: 'not-run', notRunKind: 'requirement-unproven' });
  });

  test('the assembled bundle is one #1099 persistence accepts', () => {
    const assembly = assemble([
      { record: execRecord('exec:test', 'passed') },
      { record: execRecord('exec:lint', 'passed') },
    ]);
    const validation = validateStagedVerificationState({
      version: 1,
      ordinals: [],
      runs: [],
      loopBundles: [{
        ...assembly.bundle,
        identity: legacyStageEvidenceIdentity('test-fixture'),
        startedAt: '2026-09-13T00:00:00.000Z',
        recordedAt: '2026-09-13T00:00:01.000Z',
      }],
      finalBundles: [],
    });
    expect(validation).toMatchObject({ valid: true });
  });

  test('the selection digest covers the recorded ids', () => {
    const assembly = assemble([
      { record: execRecord('exec:test', 'passed') },
      { record: execRecord('exec:lint', 'passed') },
    ]);
    expect(assembly.bundle.selection.selectionDigest)
      .toBe(deriveStageSelectionDigest(assembly.bundle.selection.checkIds));
  });
});

// ---------------------------------------------------------------------------
// §10 rule 5 — the bounded public projection
// ---------------------------------------------------------------------------

describe('public projection (§10 rule 5)', () => {
  const bundle = {
    stageRunId: { taskAttempt: 0, lane: 'implementation', stage: 'loop', stageOrdinal: 0 },
    outcome: 'code-failed',
    complete: false,
    selection: { checkIds: ['exec:test', 'exec:lint'], selectionDigest: 'x', full: false },
    checks: [
      execRecord('exec:test', 'failed'),
      execRecord('exec:lint', 'not-run', { notRunKind: 'first-failure-stop' }),
    ],
  };

  test('carries stage, verdicts, counts and `selection.full` — and no output bytes', () => {
    const summary = summarizeStageRun(bundle);
    expect(summary).toMatchObject({
      stage: 'loop',
      outcome: 'code-failed',
      full: false,
      complete: false,
      counts: { selected: 2, passed: 0, failed: 1, notRun: 1 },
    });
    expect(summary.checks).toEqual([
      { label: 'test', verdict: 'failed' },
      { label: 'lint', verdict: 'not-run', notRunKind: 'first-failure-stop' },
    ]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('boom');
    expect(serialized).not.toContain('npm run');
  });

  test('only checks that recorded a pass may be claimed as passed', () => {
    expect(passedStageCheckNames(bundle)).toEqual([]);
    expect(passedStageCheckNames({ checks: [execRecord('exec:test', 'passed')] })).toEqual(['test']);
  });

  test('the required-slot index skips retired slots', () => {
    const p = plan({ test: 'npm test' }, ['npm test']);
    const slots = requiredSlotsByCheckId(p);
    expect(slots.get('exec:test').command).toBe('npm test');
    expect(slots.size).toBe(2);
  });
});
