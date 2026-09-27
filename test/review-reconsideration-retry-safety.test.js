/**
 * Issue #953: the reviewer sub-turn is retry-safe and idempotent
 * (src/handlers/review-reconsideration-turn.ts, docs/review-dispute-contract.md
 * §5, §6.1, §7, §7.1, §12).
 *
 * #952 wired the turn; this suite pins the properties a crash, a retry, a
 * duplicate delivery, or an agent that answers badly could otherwise break:
 *
 *  - every §7 row the turn can instantiate — withdraw (9), uphold (10), material
 *    revise (11), non-material and ambiguous revise (12) — spends the lineage's
 *    single §6.1 reconsideration and no more;
 *  - one logical turn produces at most ONE transition and one counter increment,
 *    however many lineages it covers, and the remainder is re-selected without an
 *    operator recovery step;
 *  - replaying a run whose transition already committed invokes no agent, spends
 *    no counter, and leaves the task on the destination the first delivery
 *    routed to;
 *  - a run whose completion never committed re-runs under a new claim and still
 *    lands exactly one increment;
 *  - a deadline, a nonzero exit, malformed output, and unresolvable evidence each
 *    leave the block byte-identical, and a deadline is reported AS a deadline;
 *  - `pendingReReview` is carried through this no-file-change turn, and is
 *    cleared only by the §7.1 rule that answers it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY,
  runReviewDisputeSubTurn,
} from '../dist/handlers/review-reconsideration-turn.js';
import { REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY } from '../dist/core/review-dispute-dispatch.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { REVIEW_FINDINGS_ARTIFACT } from '../dist/core/review-dispute-lineage.js';
import { parseReconsiderationResponse } from '../dist/core/review-reconsideration-response.js';
import { bothStreamsCommandRunner } from '../dist/handlers/command-runner.js';
import { MemoryTaskStore, runNextPhase } from '../dist/index.js';
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
} from '../dist/core/review-dispute-commit.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const OTHER_LINEAGE = 'ln-bbbbbbbbbbbb';
const BOUNDARY = 'src/auth/handler.ts';
const RUN_ID = 'run-review-7';
/** What `disputeSubTurnIdentity` derives for a first-attempt reviewer turn. */
const derivedRunId = (runId) => `${runId}~reviewer.0`;
const RATIONALE = 'The cited middleware guard runs before the handler, so the failure scenario cannot occur.';
const ISSUE_BODY = 'The handler must reject a null session before dereferencing it.';

let root;
let artifactRoot;
let artifactDir;
let disputeArtifactDir;
let reviewArtifactDir;
let repoCwd;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reconsider-retry-'));
  artifactRoot = join(root, 'artifacts');
  artifactDir = join(artifactRoot, 'runs', RUN_ID);
  disputeArtifactDir = join(artifactRoot, 'runs', 'run-impl-6');
  reviewArtifactDir = join(artifactRoot, 'runs', 'run-review-5');
  repoCwd = join(root, 'worktree');
  for (const dir of [artifactDir, disputeArtifactDir, reviewArtifactDir, repoCwd]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function lineage(overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: LINEAGE,
    state: 'disputed',
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1, ...counterOverrides },
    rebuttedVersions: [1],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
    ...rest,
  };
}

function context(lineages = { [LINEAGE]: lineage() }, extra = {}) {
  return { version: 1, reviewStructure: 'structured', lineages, ...extra };
}

const FILE_REF = { kind: 'file', path: BOUNDARY, startLine: 10, endLine: 20 };

function body(overrides = {}) {
  return {
    version: 1,
    severity: 'P1',
    violatedContract: 'Acceptance criterion 3: the handler rejects a null session.',
    preconditions: 'A request reaches the handler without passing the middleware.',
    failureScenario: 'The direct-dispatch path dereferences a null session.',
    affectedBoundary: BOUNDARY,
    requiredOutcome: 'The handler rejects a null session on every entry path.',
    evidenceRefs: [FILE_REF],
    ...overrides,
  };
}

/** A recorded §2.1 version, as `review-findings.json` holds it. */
function findingVersion(lineageId = LINEAGE, overrides = {}) {
  return {
    ...body(overrides),
    lineageId,
    humanGate: false,
    reviewerMeta: {
      agentId: 'claude',
      model: 'opus',
      effort: 'high',
      reviewRunId: 'run-review-5',
      timestamp: '2026-08-05T10:00:00.000Z',
    },
  };
}

function writeFindingsArtifact(findings = [findingVersion()]) {
  writeFileSync(join(reviewArtifactDir, REVIEW_FINDINGS_ARTIFACT), JSON.stringify({ findings }, null, 2), 'utf8');
}

/** A §4.2 revision over one changed field. */
function revision(successorOverrides, revisionKind = 'corrected_premise') {
  return {
    predecessorVersion: 1,
    changedFields: Object.keys(successorOverrides),
    revisionKind,
    // §5: an input to audit, never to the decision. Every fixture below claims
    // materiality, so a row that comes back non-material came back from the
    // structural check and not from the reviewer's own grading.
    materialityClaim: true,
    successor: body({ version: 2, ...successorOverrides }),
  };
}

function record(reconsideration, extra = {}, lineageId = LINEAGE) {
  return { lineageId, version: 1, reconsideration, rationale: RATIONALE, ...extra };
}

/** #838's own bounded summary, as the real invocation returns it. */
function summaryFor(outcome, overrides = {}) {
  return {
    lineageId: LINEAGE,
    version: 1,
    runKey: `${LINEAGE}@1#${derivedRunId(RUN_ID)}`,
    bundleDigest: 'a1b2c3d4e5f6',
    promptBytes: 4096,
    rawOutputBytes: 512,
    rawArtifact: `reconsideration-raw-${LINEAGE}.txt`,
    stderrArtifact: null,
    runnerErrorArtifact: null,
    recordArtifact: `reconsideration-${LINEAGE}.json`,
    excerpts: 1,
    unresolvedExcerpts: 0,
    exitCode: 0,
    timedOut: false,
    profile: {
      phase: 'review',
      role: 'reconsideration',
      agentId: 'claude',
      cmd: 'claude',
      argv: ['-p', '--tools', ''],
      model: 'opus',
      modelSource: 'default',
      effort: 'high',
      effortSource: 'default',
      provider: 'anthropic',
      toolPolicy: 'no-tools',
    },
    record: outcome?.summary ?? null,
    failure: null,
    ...overrides,
  };
}

/**
 * An `invoke` seam that answers whichever pending lineage the runner selected.
 *
 * The record is put through the PRODUCTION parser against the block the runner
 * handed over, so no test here can reach the transition layer with a record the
 * protocol would have refused.
 */
function invokeReturning(build, { calls } = {}) {
  return (input) => {
    calls?.push(input);
    const raw = build(input.pending);
    const outcome = parseReconsiderationResponse({
      response: `\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``,
      pending: input.pending,
      lineages: input.context.lineages,
      resolveEvidenceRef: () => true,
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    if (outcome.admitted === null) throw new Error(`fixture not admitted: ${JSON.stringify(outcome.failure)}`);
    return {
      ok: true,
      admitted: outcome.admitted,
      artifacts: [{ name: `reconsideration-${input.pending.lineageId}.json`, content: '{"record":"bytes"}' }],
      summary: summaryFor(outcome),
    };
  };
}

function invokeFailing(failure, summaryOverrides = {}, { calls } = {}) {
  return (input) => {
    calls?.push(input);
    return { ok: false, failure, artifacts: [], summary: summaryFor(null, { failure, ...summaryOverrides }) };
  };
}

/** Refuses to be called: every no-run assertion below shares this seam. */
function invokeNever(calls = []) {
  return (input) => {
    calls.push(input);
    throw new Error('the invocation must not be reached');
  };
}

function gate(options = {}) {
  const { enabled = true, runtime = {}, runId = RUN_ID, ...overrides } = options;
  delete overrides.persisted;
  const persisted = 'persisted' in options ? options.persisted : context();
  return runReviewDisputeSubTurn({
    enabled,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    persisted,
    runId,
    baseContext: { artifactDir, prUrl: 'https://github.com/org/repo/pull/42', branch: 'ai/issue-953' },
    runtime: {
      issueBody: ISSUE_BODY,
      disputeArtifactDir,
      reviewArtifactDir,
      artifactDir,
      artifactRoot,
      repoCwd,
      agentId: 'claude',
      timestamp: '2026-08-06T12:00:00.000Z',
      ...runtime,
    },
    ...overrides,
  });
}

/** The lineage as the applied transition left it. */
function appliedLineage(result, lineageId = LINEAGE) {
  return result.result.disputeTransition.context.lineages[lineageId];
}

// ---------------------------------------------------------------------------
// 1. The deadline, as a typed fact
// ---------------------------------------------------------------------------

describe('a killed-on-deadline child is reported as one', () => {
  // `bothStreamsCommandRunner` is the runner the reconsideration spawns its agent
  // with (§10.2 needs stderr on a zero exit), so it is the one that has to carry
  // the fact. It reads the errno off `spawnSync`'s own error rather than matching
  // the message, which is why nothing below asserts on wording.
  test('the deadline is reported separately from the exit status', () => {
    const result = bothStreamsCommandRunner.run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      cwd: root,
      timeout: 250,
    });
    expect(result.timedOut).toBe(true);
    // Still a failed run for every caller that only reads the exit code.
    expect(result.exitCode).not.toBe(0);
    expect(typeof result.spawnError).toBe('string');
  }, 30_000);

  test('an agent that ran and refused is not a deadline', () => {
    const result = bothStreamsCommandRunner.run(process.execPath, ['-e', 'process.exit(3)'], { cwd: root });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. Every §7 row the turn can instantiate, and what each spends
// ---------------------------------------------------------------------------

describe('the rows a reviewer turn instantiates', () => {
  test('withdraw applies row 9 and spends the single §6.1 reconsideration', async () => {
    const result = await gate({ runtime: { invoke: invokeReturning(() => record('withdraw')) } });

    expect(result.result.result).toBe('success');
    expect(result.result.disputeTransition.applied).toHaveLength(1);
    expect(result.result.disputeTransition.applied[0]).toMatchObject({
      row: 9,
      toState: 'resolved_withdrawn',
      auditEvent: 'dispute.resolved',
      counterDelta: expect.objectContaining({ reconsiderations: 1 }),
      countersAfter: expect.objectContaining({ reconsiderations: 1 }),
      replayed: false,
    });
    // §6.1's ceiling is 1, so the spent round is what makes a second reviewer turn
    // for this lineage impossible — not a flag some later run has to remember.
    expect(appliedLineage(result).counters.reconsiderations).toBe(1);
    // The ledger entry the replay guard keys on is written with the row.
    expect(appliedLineage(result).appliedTransitions).toHaveLength(1);
  });

  test('uphold applies row 10 and spends the same single round', async () => {
    const result = await gate({ runtime: { invoke: invokeReturning(() => record('uphold')) } });
    expect(result.result.disputeTransition.applied[0]).toMatchObject({
      row: 10,
      toState: 'arbitration_pending',
      countersAfter: expect.objectContaining({ reconsiderations: 1 }),
    });
    expect(appliedLineage(result).appliedTransitions).toHaveLength(1);
  });

  test('a non-material revision applies row 12 and grants no further response', async () => {
    writeFindingsArtifact();
    // §5 "Never material: ... severity-only changes". The reviewer declares the
    // field and claims materiality; the structural check decides otherwise.
    const result = await gate({
      runtime: { invoke: invokeReturning(() => record('revise', { revision: revision({ severity: 'P2' }, 'restated') })) },
    });

    expect(result.result.result).toBe('success');
    expect(result.result.disputeTransition.applied[0]).toMatchObject({
      row: 12,
      toState: 'arbitration_pending',
      // The candidate is not admitted: the lineage arbitrates at its disputed
      // version, so no successor version is minted.
      versionAfter: 1,
      auditEvent: 'dispute.revision.non_material',
      countersAfter: expect.objectContaining({ reconsiderations: 1 }),
    });
    expect(appliedLineage(result).version).toBe(1);
    const summary = result.result.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY];
    expect(summary.revision).toMatchObject({
      intent: 'arbitration',
      row: 12,
      nextState: 'arbitration_pending',
      candidateAdmitted: false,
      implementationResponsesGranted: 0,
    });
    expect(summary.revision.materiality).toMatchObject({ classification: 'non_material', materialFields: [] });
  });

  test('an ambiguous revision applies row 12 rather than a second rebuttal', async () => {
    writeFindingsArtifact();
    // §5's own example of what the structural check cannot decide: a rewritten
    // `failureScenario` that may or may not describe the same scenario.
    const result = await gate({
      runtime: {
        invoke: invokeReturning(() =>
          record('revise', {
            revision: revision({
              failureScenario: 'An unauthenticated caller reaches code that assumes an established identity.',
            }),
          }),
        ),
      },
    });

    expect(result.result.disputeTransition.applied[0]).toMatchObject({
      row: 12,
      toState: 'arbitration_pending',
      versionAfter: 1,
      auditEvent: 'dispute.revision.ambiguous',
    });
    const summary = result.result.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY];
    expect(summary.revision.materiality).toMatchObject({
      classification: 'ambiguous',
      materialFields: [],
      ambiguousFields: ['failureScenario'],
    });
    // §11/§10.3: the classification and the FIELD NAMES travel; the reviewer's
    // rewritten prose does not.
    expect(JSON.stringify(result.result.context)).not.toContain('an established identity');
  });

  test('a material revision applies row 11 and mints exactly one successor version', async () => {
    writeFindingsArtifact();
    const result = await gate({
      runtime: {
        invoke: invokeReturning(() =>
          record('revise', { revision: revision({ preconditions: 'Any caller may reach the handler directly.' }) }),
        ),
      },
    });

    expect(result.result.disputeTransition.applied[0]).toMatchObject({
      row: 11,
      toState: 'open',
      versionAfter: 2,
      countersAfter: expect.objectContaining({ reconsiderations: 1 }),
    });
    // Row 11 admits the §4.2 candidate AS version 2, so the successor's own §2.1
    // fields are written with it — the final implementation response is prompted
    // against the surface the reviewer revised TO.
    expect(appliedLineage(result)).toMatchObject({ version: 2, state: 'open' });
  });
});

// ---------------------------------------------------------------------------
// 3. One turn, one transition, one counter increment
// ---------------------------------------------------------------------------

describe('a logical turn is charged exactly once', () => {
  test('replaying a run whose transition committed runs no agent and spends nothing', async () => {
    const first = await gate({ runtime: { invoke: invokeReturning(() => record('withdraw')) } });
    const committed = first.result.disputeTransition.context;
    expect(committed.lineages[LINEAGE].counters.reconsiderations).toBe(1);

    // The redelivery: the SAME claim, over the block the first delivery wrote.
    // §7.1 is re-derived from persisted state, so the reviewer turn is no longer
    // owed — no agent runs, no second row is applied, and the task continues on
    // the destination the first delivery routed to (rule 4's ordinary review
    // result, unchanged).
    const calls = [];
    const replay = await gate({
      persisted: committed,
      runtime: { invoke: invokeNever(calls) },
    });
    expect(replay).toEqual({ kind: 'ordinary_review' });
    expect(calls).toHaveLength(0);
    expect(first.result.disputeTransition.routing).toMatchObject({ turn: 'none', readyForHuman: false });
  });

  test('a turn covering two disputed lineages moves one row and re-selects the rest', async () => {
    const both = context({
      [LINEAGE]: lineage(),
      [OTHER_LINEAGE]: lineage({ lineageId: OTHER_LINEAGE }),
    });
    const calls = [];
    const first = await gate({ persisted: both, runtime: { invoke: invokeReturning(() => record('withdraw', {}, LINEAGE), { calls }) } });

    // One row per completion: the runner folds exactly one application into the
    // transaction it commits.
    expect(first.result.disputeTransition.applied).toHaveLength(1);
    expect(first.result.disputeTransition.applied[0]).toMatchObject({ lineageId: LINEAGE, row: 9 });
    const after = first.result.disputeTransition.context;
    expect(after.lineages[OTHER_LINEAGE]).toMatchObject({ state: 'disputed' });
    // §7.1 rule 2: the remaining `disputed` lineage names the reviewer turn, which
    // this runner CAN dispatch — so the task is queued back onto review rather
    // than parked for an operator to restart.
    expect(first.result.disputeTransition.routing).toMatchObject({
      rule: 2,
      turn: 'reviewer',
      nextPhase: 'review',
      readyForHuman: false,
    });

    // The next claim answers the remainder, and only the remainder.
    const second = await gate({
      persisted: after,
      runId: 'run-review-8',
      runtime: { invoke: invokeReturning(() => record('withdraw', {}, OTHER_LINEAGE), { calls }) },
    });
    expect(second.result.disputeTransition.applied).toHaveLength(1);
    expect(second.result.disputeTransition.applied[0]).toMatchObject({ lineageId: OTHER_LINEAGE, row: 9 });
    // Each lineage was reconsidered once, by its own run.
    expect(calls.map((call) => call.pending.lineageId)).toEqual([LINEAGE, OTHER_LINEAGE]);
    expect(calls.map((call) => call.run.runId)).toEqual([derivedRunId(RUN_ID), derivedRunId('run-review-8')]);
    for (const id of [LINEAGE, OTHER_LINEAGE]) {
      expect(second.result.disputeTransition.context.lineages[id].counters.reconsiderations).toBe(1);
    }
  });

  test('a run interrupted before its completion committed re-runs and still charges one round', async () => {
    // The first claim reached a decision and died before `completePhaseWithEffects`
    // — so nothing of it is on file and the block is byte-identical.
    const persisted = context();
    const snapshot = JSON.parse(JSON.stringify(persisted));
    const lost = await gate({ persisted, runtime: { invoke: invokeReturning(() => record('uphold')) } });
    expect(lost.result.result).toBe('success');
    expect(persisted).toEqual(snapshot);

    // The lease expired and the task was re-claimed. A fresh claim is a legitimate
    // new attempt: it derives its own run id, runs the reconsideration again, and
    // the round is spent by whichever delivery actually commits — once.
    const recovered = await gate({
      persisted,
      runId: 'run-review-9',
      runtime: { invoke: invokeReturning(() => record('uphold')) },
    });
    expect(recovered.result.disputeTransition.applied[0]).toMatchObject({
      row: 10,
      countersAfter: expect.objectContaining({ reconsiderations: 1 }),
      replayed: false,
    });
    expect(appliedLineage(recovered).counters.reconsiderations).toBe(1);
    expect(appliedLineage(recovered).appliedTransitions).toHaveLength(1);
    // The abandoned attempt left no trace in the block that would let a later
    // delivery be mistaken for a replay of it.
    expect(appliedLineage(recovered).appliedTransitions).not.toEqual(
      lost.result.disputeTransition.context.lineages[LINEAGE].appliedTransitions,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Failures: nothing moves, and the reason is the real one
// ---------------------------------------------------------------------------

describe('a run that produced no admissible answer leaves the debate untouched', () => {
  /** Every park below must leave the block exactly as it found it. */
  async function parkedOn(invoke) {
    const persisted = context();
    const snapshot = JSON.parse(JSON.stringify(persisted));
    const result = await gate({ persisted, runtime: { invoke } });
    expect(result.result.result).toBe('blocked');
    expect(result.result.disputeTransition).toBeUndefined();
    expect(persisted).toEqual(snapshot);
    return result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY];
  }

  test('a deadline is routed as a timeout, not as an agent that ran and failed', async () => {
    // #838 reports a killed agent with the same `agent-failed` token it uses for a
    // nonzero exit, so the deadline fact has to travel on the summary; without it
    // an operator reading the park would go looking for a reviewer that answered.
    const summary = await parkedOn(invokeFailing({ kind: 'agent-failed', detail: 'exit:1' }, { exitCode: 1, timedOut: true }));
    expect(summary).toMatchObject({ disposition: 'parked', failure: 'timeout', failureDetail: 'exit:1' });
  });

  test('the same failure without a deadline stays an ordinary run failure', async () => {
    const summary = await parkedOn(invokeFailing({ kind: 'agent-failed', detail: 'exit:3' }, { exitCode: 3 }));
    expect(summary).toMatchObject({ failure: 'invocation_failed', failureDetail: 'exit:3' });
  });

  test('§12 malformed output is neither a transition nor a spent counter', async () => {
    const summary = await parkedOn(
      invokeFailing({
        kind: 'malformed-response',
        detail: 'unknown-enum',
        protocol: { reason: 'unknown-enum', detail: 'reconsideration.reconsideration' },
      }),
    );
    expect(summary).toMatchObject({
      failure: 'malformed_output',
      protocolReason: 'unknown-enum',
      protocolDetail: 'reconsideration.reconsideration',
    });
  });

  test('a §3.3 reference that does not resolve is malformed output, not a decision', async () => {
    // §12 lists an unresolvable evidence reference among the malformed cases:
    // admission refuses it, so the revision never reaches the transition layer.
    const summary = await parkedOn(
      invokeFailing({
        kind: 'malformed-response',
        detail: 'unresolvable-evidence',
        protocol: { reason: 'unresolvable-evidence', detail: 'reconsideration.revision.successor.evidenceRefs[0]' },
      }),
    );
    expect(summary).toMatchObject({ failure: 'malformed_output', failureDetail: 'unresolvable-evidence' });
  });

  test('a reconsideration slot already spent is a stale lineage, never a second round', async () => {
    const summary = await parkedOn(
      invokeFailing({
        kind: 'reconsideration-slot-consumed',
        detail: `lineages[${LINEAGE}].counters.reconsiderations:1`,
      }),
    );
    expect(summary).toMatchObject({ failure: 'stale_lineage' });
  });

  test('a revision the block refuses in full parks instead of committing an unchanged block', async () => {
    // No `review-findings.json`, so #845 has no predecessor to compare against and
    // rejects the revision. #840 refuses every row it carried, and a delivery that
    // moved nothing must not be reported as a turn that was taken.
    const summary = await parkedOn(
      invokeReturning(() => record('revise', { revision: revision({ preconditions: 'Any caller may reach the handler directly.' }) })),
    );
    expect(summary).toMatchObject({ disposition: 'parked', failure: 'stale_lineage' });
  });
});

// ---------------------------------------------------------------------------
// 5. `pendingReReview` across a turn that changes no file
// ---------------------------------------------------------------------------

describe('the deferred re-review flag', () => {
  test('is carried through a reviewer turn that leaves another lineage disputed', async () => {
    // §7.1: intermediate runs that produce no file changes leave the flag
    // unchanged. Rule 2 still applies here — one lineage is still disputed — so
    // the earlier fix's unreviewed diff stays owed a review.
    const persisted = context(
      { [LINEAGE]: lineage(), [OTHER_LINEAGE]: lineage({ lineageId: OTHER_LINEAGE }) },
      { pendingReReview: true },
    );
    const calls = [];
    const result = await gate({
      persisted,
      runtime: { invoke: invokeReturning(() => record('withdraw', {}, LINEAGE), { calls }) },
    });

    expect(result.result.disputeTransition.context.pendingReReview).toBe(true);
    expect(result.result.disputeTransition.routing).toMatchObject({ rule: 2, turn: 'reviewer' });
    // The flag is a fact about the branch, not an instruction to the reviewer: the
    // invocation is told what the block says and changes none of it.
    expect(calls[0].routing.pendingReReview).toBe(true);
  });

  test('is cleared only by the §7.1 rule that answers it', async () => {
    // The last `disputed` lineage withdraws, so every lineage is terminal and the
    // accumulated diff routes back to review (rule 3) — which is what discharges
    // the deferral, so the flag does not survive it.
    const result = await gate({
      persisted: context(undefined, { pendingReReview: true }),
      runtime: { invoke: invokeReturning(() => record('withdraw')) },
    });

    expect(result.result.disputeTransition.routing).toMatchObject({
      rule: 3,
      turn: 're_review',
      nextPhase: 'review',
      readyForHuman: false,
    });
    expect(result.result.disputeTransition.context.pendingReReview).toBeUndefined();
    // Rule 3 is not rule 4: an unreviewed diff is still owed an ordinary review,
    // so the zero-change outcome is not recorded.
    expect(result.result.disputeTransition.context.resolvedWithoutChanges).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. The turn as the phase runner actually completes it
// ---------------------------------------------------------------------------

describe('the reviewer turn, committed through runNextPhase', () => {
  const SESSION = 's';
  const ISSUE = 953;
  const KEY = { sessionId: SESSION, issueNumber: ISSUE };
  let store;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  /** The review phase handler, reduced to its §7.1 gate and an ordinary result. */
  function reviewHandler(runId, invoke) {
    return async (task) => {
      const decided = await runReviewDisputeSubTurn({
        enabled: true,
        limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
        persisted: task.context[REVIEW_DISPUTE_CONTEXT_KEY],
        runId,
        baseContext: { artifactDir },
        runtime: {
          issueBody: ISSUE_BODY,
          disputeArtifactDir,
          reviewArtifactDir,
          artifactDir,
          artifactRoot,
          repoCwd,
          agentId: 'claude',
          timestamp: '2026-08-06T12:00:00.000Z',
          invoke,
        },
      });
      // What the real handler does with `ordinary_review`: build and run the
      // generic review, which here simply passes.
      return decided.kind === 'handled'
        ? decided.result
        : { result: 'success', context: { artifactDir }, message: 'ordinary review passed' };
    };
  }

  async function claim(runId, invoke, now) {
    return runNextPhase({
      store,
      request: { sessionId: SESSION, workerId: 'w', runId, supportedPhases: ['review'], now },
      handlers: { review: reviewHandler(runId, invoke) },
    });
  }

  test('completes the debate and continues to the next normative turn with no operator step', async () => {
    await store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase: 'review',
      priority: 'normal',
      // An earlier fix run left a diff on the branch and disputed the finding, so
      // its re-review is deferred (§7.1 rule 2), never skipped.
      context: { [REVIEW_DISPUTE_CONTEXT_KEY]: context(undefined, { pendingReReview: true }) },
      now: '2026-08-06T11:00:00.000Z',
    });

    const first = await claim(RUN_ID, invokeReturning(() => record('withdraw')), '2026-08-06T12:00:00.000Z');
    expect(first.status).toBe('completed');

    const afterTurn = await store.getTask(KEY);
    const block = afterTurn.context[REVIEW_DISPUTE_CONTEXT_KEY];
    expect(block.lineages[LINEAGE]).toMatchObject({
      state: 'resolved_withdrawn',
      counters: expect.objectContaining({ reconsiderations: 1 }),
    });
    // §7.1 rule 3: the deferred diff goes back to an ordinary review, and the task
    // is QUEUED there — not parked for an operator to restart it.
    expect(afterTurn.status).toBe('queued');
    expect(afterTurn.phase).toBe('review');
    expect(afterTurn.ownerRunId ?? undefined).toBeUndefined();

    const transitions = (await store.listEvents(KEY)).filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].data.applied[0]).toMatchObject({ row: 9, toState: 'resolved_withdrawn' });
    expect(transitions[0].data.undispatchedTurn).toBeUndefined();
    // §10.3/§11: the reviewer's rationale reaches no durable event.
    expect(JSON.stringify(transitions[0].data)).not.toContain(RATIONALE);

    // The next claim finds no reviewer turn owed: the block itself is the record
    // of what was answered, so the deferred re-review runs ordinarily and no
    // second round is spent.
    const calls = [];
    const second = await claim('run-review-8', invokeNever(calls), '2026-08-06T12:05:00.000Z');
    expect(second.status).toBe('completed');
    expect(calls).toHaveLength(0);

    const settled = await store.getTask(KEY);
    expect(settled.status).toBe('ready_for_human');
    expect(settled.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE].counters.reconsiderations).toBe(1);
    expect((await store.listEvents(KEY)).filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(1);
  }, 30_000);

  test('a run that produced no admissible answer commits nothing and hands the task to a human', async () => {
    await store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase: 'review',
      priority: 'normal',
      context: { [REVIEW_DISPUTE_CONTEXT_KEY]: context() },
      now: '2026-08-06T11:00:00.000Z',
    });

    const outcome = await claim(
      RUN_ID,
      invokeFailing({ kind: 'agent-failed', detail: 'exit:1' }, { exitCode: 1, timedOut: true }),
      '2026-08-06T12:00:00.000Z',
    );
    expect(outcome.status).toBe('completed');

    const stored = await store.getTask(KEY);
    // §12: no protocol state changes and no bounded counter is consumed.
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE]).toMatchObject({
      state: 'disputed',
      counters: expect.objectContaining({ reconsiderations: 0 }),
    });
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE].appliedTransitions ?? []).toHaveLength(0);
    // §9: `blocked` on the phase that ran, so an operator resumes where the work
    // stopped — and no transition event was appended for a turn nothing took.
    expect(stored.status).toBe('ready_for_human');
    expect(stored.phase).toBe('review');
    expect((await store.listEvents(KEY)).filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(0);
    // The operational reason survives as the sub-turn's own bounded record.
    expect(stored.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      disposition: 'parked',
      failure: 'timeout',
    });
  }, 30_000);
});
