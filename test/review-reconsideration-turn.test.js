/**
 * Issue #952: the §7.1 reviewer turn dispatched inside the review phase
 * (src/handlers/review-reconsideration-turn.ts,
 * docs/review-dispute-contract.md §7.1, §8.2, §9, §10.1–§10.3).
 *
 * The seam under test is deliberately narrow: given what a task has PERSISTED,
 * either this is an ordinary review or the reviewer's reconsideration runs. So
 * every test below is a persisted block in and one of those two answers out, and
 * the properties pinned are the ones the wiring could plausibly get wrong:
 *
 *  - a `disputed` lineage never falls through to the ordinary review prompt;
 *  - a disabled session takes the legacy path even with a block on file;
 *  - the invocation is handed the ORIGINAL review party and the issue worktree,
 *    and an agent with no no-tools profile fails closed instead of being
 *    silently replaced;
 *  - nothing is committed here: a success carries #840's application for the
 *    phase runner, and the block handed in is not mutated;
 *  - what reaches task context is bounded — literals, counters, and artifact
 *    base names, with no command line and no reviewer prose.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY,
  createReconsiderationSubTurnRunner,
  readLineageFindingVersions,
  runReviewDisputeSubTurn,
} from '../dist/handlers/review-reconsideration-turn.js';
import {
  REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY,
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
} from '../dist/core/review-dispute-dispatch.js';
import { selectEvidenceTurnParty } from '../dist/handlers/review-evidence-turn.js';
import { REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD } from '../dist/core/review-dispute-reconsiderations.js';
import { summarizeDisputeStatus } from '../dist/core/review-dispute-status.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { REVIEW_FINDINGS_ARTIFACT } from '../dist/core/review-dispute-lineage.js';
import { parseReconsiderationResponse } from '../dist/core/review-reconsideration-response.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const BOUNDARY = 'src/auth/handler.ts';
const RUN_ID = 'run-review-7';
/** What `disputeSubTurnIdentity` derives for a first-attempt reviewer turn. */
const DERIVED_RUN_ID = `${RUN_ID}~reviewer.0`;
const RATIONALE = 'The cited middleware guard runs before the handler, so the failure scenario cannot occur.';
const ISSUE_BODY = 'The handler must reject a null session before dereferencing it.';

let root;
let artifactRoot;
let artifactDir;
let disputeArtifactDir;
let reviewArtifactDir;
let repoCwd;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reconsider-turn-'));
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

function context(lineages = { [LINEAGE]: lineage() }) {
  return { version: 1, reviewStructure: 'structured', lineages };
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
function findingVersion(overrides = {}) {
  return {
    ...body(overrides),
    lineageId: LINEAGE,
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

/** The §4.2 revision a `revise` carries: one changed field, declared. */
function revision(successorOverrides = { preconditions: 'Any caller may reach the handler directly.' }) {
  return {
    predecessorVersion: 1,
    changedFields: Object.keys(successorOverrides),
    revisionKind: 'corrected_premise',
    materialityClaim: true,
    successor: body({ version: 2, ...successorOverrides }),
  };
}

/**
 * A real #838 admission: the record is parsed and admitted by the production
 * parser, so no test here can hand the transition layer a record the protocol
 * would never have produced.
 */
function admitted(record, lineages = context().lineages) {
  const outcome = parseReconsiderationResponse({
    response: `\`\`\`json\n${JSON.stringify(record)}\n\`\`\``,
    pending: { lineageId: LINEAGE, version: 1 },
    lineages,
    resolveEvidenceRef: () => true,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
  if (outcome.admitted === null) throw new Error(`fixture not admitted: ${JSON.stringify(outcome.failure)}`);
  return outcome;
}

/** #838's own bounded summary, as the real invocation returns it. */
function summaryFor(outcome, overrides = {}) {
  return {
    lineageId: LINEAGE,
    version: 1,
    runKey: `${LINEAGE}@1#${DERIVED_RUN_ID}`,
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
    profile: {
      phase: 'review',
      role: 'reconsideration',
      agentId: 'claude',
      cmd: 'claude',
      argv: ['-p', '--tools', '', '--disallowedTools', 'Bash,Write,Read', '--model', 'opus'],
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

/** An `invoke` seam that answers with one admitted record. */
function invokeReturning(record, { calls, summary } = {}) {
  return (input) => {
    calls?.push(input);
    const outcome = admitted(record, input.context.lineages);
    return {
      ok: true,
      admitted: outcome.admitted,
      artifacts: [{ name: `reconsideration-${LINEAGE}.json`, content: '{"record":"bytes"}' }],
      summary: summaryFor(outcome, summary),
    };
  };
}

function invokeFailing(failure, { calls } = {}) {
  return (input) => {
    calls?.push(input);
    return { ok: false, failure, artifacts: [], summary: summaryFor(null, { exitCode: 3, failure }) };
  };
}

function gate(options = {}) {
  const { enabled = true, runtime = {}, ...overrides } = options;
  delete overrides.persisted;
  // `persisted: undefined` is a real case — a task carrying no §10.1 block at
  // all — so the disputed fixture stands in only when the key is ABSENT. A
  // destructuring default would answer that case with the fixture instead.
  const persisted = 'persisted' in options ? options.persisted : context();
  return runReviewDisputeSubTurn({
    enabled,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    persisted,
    runId: RUN_ID,
    baseContext: { artifactDir, prUrl: 'https://github.com/org/repo/pull/42', branch: 'ai/issue-952' },
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

// ---------------------------------------------------------------------------
// 1. Which turn the review phase takes
// ---------------------------------------------------------------------------

describe('the review-phase gate', () => {
  test('a disabled session takes the legacy path even with a disputed lineage on file', async () => {
    const calls = [];
    const result = await gate({ enabled: false, runtime: { invoke: invokeReturning({}, { calls }) } });
    expect(result).toEqual({ kind: 'ordinary_review' });
    expect(calls).toHaveLength(0);
  });

  test('a task with no §10.1 block is an ordinary review', async () => {
    expect(await gate({ persisted: undefined })).toEqual({ kind: 'ordinary_review' });
    expect(await gate({ persisted: null })).toEqual({ kind: 'ordinary_review' });
  });

  test('an `open` lineage is the implementer\'s turn, so review runs ordinarily', async () => {
    const result = await gate({ persisted: context({ [LINEAGE]: lineage({ state: 'open', rebuttedVersions: [], counters: { rebuttals: 0 } }) }) });
    expect(result).toEqual({ kind: 'ordinary_review' });
  });

  test('a §13 legacy block is an ordinary review', async () => {
    expect(await gate({ persisted: { version: 1, reviewStructure: 'legacy', lineages: {} } }))
      .toEqual({ kind: 'ordinary_review' });
  });

  test('a §12 unreadable block parks rather than reviewing around whatever it holds', async () => {
    // A block this layer cannot read may be hiding a `disputed` lineage, and an
    // ordinary review reporting a clean success over it would discharge a debate
    // nobody answered.
    const result = await gate({ persisted: { version: 1, reviewStructure: 'structured', lineages: { bad: 1 } } });
    expect(result.kind).toBe('handled');
    expect(result.result.result).toBe('blocked');
    expect(result.result.disputeTransition).toBeUndefined();
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: null,
      taskTurn: null,
      lineageIds: [],
      disposition: 'parked',
      failure: 'invalid_context',
    });
  });

  test('a turn this phase still cannot dispatch parks instead of reviewing', async () => {
    // `evidence_requested` selects the evidence turn, and this caller supplied
    // no evidence runtime (issue #964 dispatches it only when one is supplied).
    // An ordinary review would finish the task with the round still open, so
    // the gate parks it exactly as it did before the turn had a dispatcher.
    const persisted = context({
      [LINEAGE]: lineage({
        state: 'evidence_requested',
        counters: { rebuttals: 1, arbitrationPasses: 1 },
      }),
    });
    const result = await gate({ persisted });
    expect(result.kind).toBe('handled');
    expect(result.result.result).toBe('blocked');
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'evidence_collection',
      taskTurn: 'evidence',
      lineageIds: [LINEAGE],
      disposition: 'parked',
      failure: 'no_implementation',
      failureDetail: 'evidence_collection',
    });
    // The park carries no transition: nothing moved.
    expect(result.result.disputeTransition).toBeUndefined();
    // The phase's own bookkeeping still travels.
    expect(result.result.context.branch).toBe('ai/issue-952');
  });
});

// ---------------------------------------------------------------------------
// 2. The reconsideration itself
// ---------------------------------------------------------------------------

describe('the reviewer sub-turn', () => {
  test('a disputed lineage invokes reconsideration instead of an ordinary review', async () => {
    const calls = [];
    const result = await gate({
      runtime: { invoke: invokeReturning({ lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE }, { calls }) },
    });

    expect(result.kind).toBe('handled');
    expect(calls).toHaveLength(1);
    const input = calls[0];
    // §7.1's reviewer turn, in #844's typed routing shape — never reconstructed
    // from prose.
    expect(input.routing).toEqual({
      kind: 'pending_reconsideration',
      lineages: [{ lineageId: LINEAGE, version: 1 }],
      escalatedLineageIds: [],
      pendingReReview: false,
    });
    expect(input.pending).toEqual({ lineageId: LINEAGE, version: 1 });
    // The issue worktree is the read-only evidence input; the agent still sees
    // only the rendered bundle (#838 owns that boundary).
    expect(input.repoCwd).toBe(repoCwd);
    expect(input.artifactDir).toBe(artifactDir);
    expect(input.artifactRoot).toBe(artifactRoot);
    expect(input.disputeArtifactDir).toBe(disputeArtifactDir);
    expect(input.reviewArtifactDir).toBe(reviewArtifactDir);
    expect(input.issueBody).toBe(ISSUE_BODY);
    // The original review party, resolved by the caller and passed explicitly.
    expect(input.agentId).toBe('claude');
    // The transition is applied under the SUB-TURN's derived run id, so the
    // record's `runKey` and #840's ledger entry are one value.
    expect(input.run).toEqual({ runId: DERIVED_RUN_ID, agentId: 'claude', timestamp: '2026-08-06T12:00:00.000Z' });
  });

  test('an upheld reconsideration applies row 10 and hands the transition to the runner', async () => {
    const persisted = context();
    const snapshot = JSON.parse(JSON.stringify(persisted));
    const result = await gate({
      persisted,
      runtime: { invoke: invokeReturning({ lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE }) },
    });

    expect(result.result.result).toBe('success');
    const application = result.result.disputeTransition;
    expect(application.applied[0]).toMatchObject({ lineageId: LINEAGE, row: 10, toState: 'arbitration_pending' });
    expect(application.context.lineages[LINEAGE]).toMatchObject({
      state: 'arbitration_pending',
      counters: expect.objectContaining({ reconsiderations: 1 }),
    });
    // No transition is committed by the invocation layer: the block handed in is
    // untouched, and the new one travels OUTSIDE `context` for the phase runner
    // to fold into its own completion transaction.
    expect(persisted).toEqual(snapshot);
    expect(result.result.context.reviewDispute).toBeUndefined();
  });

  test('a withdrawal applies row 9 and resolves the lineage', async () => {
    const result = await gate({
      runtime: { invoke: invokeReturning({ lineageId: LINEAGE, version: 1, reconsideration: 'withdraw', rationale: RATIONALE }) },
    });
    expect(result.result.disputeTransition.applied[0]).toMatchObject({ row: 9, toState: 'resolved_withdrawn' });
  });

  test('a material revision is classified by #845 and applies row 11', async () => {
    writeFindingsArtifact();
    const result = await gate({
      runtime: {
        invoke: invokeReturning({
          lineageId: LINEAGE,
          version: 1,
          reconsideration: 'revise',
          rationale: RATIONALE,
          revision: revision(),
        }),
      },
    });

    expect(result.result.result).toBe('success');
    expect(result.result.disputeTransition.applied[0]).toMatchObject({
      row: 11,
      toState: 'open',
      versionAfter: 2,
    });
    const summary = result.result.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY];
    expect(summary.revision).toMatchObject({
      intent: 'final_implementation_response',
      row: 11,
      nextState: 'open',
      candidateAdmitted: true,
      implementationResponsesGranted: 1,
      auditEvents: ['dispute.revision.material'],
    });
    // §5's classification travels as literals and FIELD NAMES only — never the
    // compared values.
    expect(summary.revision.materiality).toEqual({
      classification: 'material',
      materialFields: ['preconditions'],
      ambiguousFields: [],
      auditEvent: 'dispute.revision.material',
    });
    expect(JSON.stringify(summary)).not.toContain('Any caller may reach the handler directly.');
  });

  test('a revision with no recorded predecessor is refused rather than guessed', async () => {
    // No `review-findings.json`: #845 cannot compare the successor against the
    // version it revises, so the decision is rejected and #840 applies nothing.
    const result = await gate({
      runtime: {
        invoke: invokeReturning({
          lineageId: LINEAGE,
          version: 1,
          reconsideration: 'revise',
          rationale: RATIONALE,
          revision: revision(),
        }),
      },
    });
    expect(result.result.result).toBe('blocked');
    expect(result.result.disputeTransition).toBeUndefined();
  });

  test('a revision is not decided against findings from outside the artifact root', async () => {
    // `reviewArtifactDir` arrives from task context. A stale or crafted one holds
    // a perfectly well-formed `review-findings.json` — which is exactly why it
    // must not be read: deciding #845's classification on it would transition a
    // real disputed lineage on a predecessor this session never recorded. The
    // unsafe directory reads as "no predecessor on file" and refuses.
    const outside = join(root, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, REVIEW_FINDINGS_ARTIFACT),
      JSON.stringify({ findings: [findingVersion()] }, null, 2),
      'utf8',
    );
    const result = await gate({
      runtime: {
        reviewArtifactDir: outside,
        invoke: invokeReturning({
          lineageId: LINEAGE,
          version: 1,
          reconsideration: 'revise',
          rationale: RATIONALE,
          revision: revision(),
        }),
      },
    });
    expect(result.result.result).toBe('blocked');
    expect(result.result.disputeTransition).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Fail-closed paths
// ---------------------------------------------------------------------------

describe('failures park with the debate unchanged', () => {
  test('an invocation failure is normalized and parks, committing nothing', async () => {
    const result = await gate({
      runtime: { invoke: invokeFailing({ kind: 'agent-failed', detail: 'exit:3' }) },
    });
    expect(result.result.result).toBe('blocked');
    expect(result.result.disputeTransition).toBeUndefined();
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      taskTurn: 'reviewer',
      disposition: 'parked',
      failure: 'invocation_failed',
      failureDetail: 'exit:3',
    });
  });

  test('malformed reviewer output parks as §12 malformed output, not as a transition', async () => {
    const result = await gate({
      runtime: {
        invoke: invokeFailing({ kind: 'malformed-response', detail: 'unparseable', protocol: { reason: 'unparseable', detail: null } }),
      },
    });
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      failure: 'malformed_output',
      failureDetail: 'unparseable',
      protocolReason: 'unparseable',
      protocolDetail: null,
    });
  });

  test('an absent dispute-artifact directory refuses before anything is read', async () => {
    const calls = [];
    const result = await gate({
      runtime: {
        disputeArtifactDir: '',
        invoke: (input) => {
          calls.push(input);
          throw new Error('the invocation must not be reached');
        },
      },
    });
    expect(calls).toHaveLength(0);
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      failure: 'invocation_failed',
      failureDetail: 'disputeArtifactDir:absent',
    });
  });

  test('an agent with no no-tools profile fails closed instead of being substituted', async () => {
    // The REAL invocation, deliberately: §8.2's boundary is the runner's, so an
    // agent this runner cannot invoke without tools gets no reviewer turn at all
    // — it is never quietly replaced by one that can.
    const result = await gate({ runtime: { agentId: 'codex' } });
    expect(result.result.result).toBe('blocked');
    expect(result.result.disputeTransition).toBeUndefined();
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      failure: 'profile_unavailable',
      failureDetail: 'codex',
    });
  });

  test('an implementation that throws is a run that did not happen', async () => {
    const result = await gate({
      runtime: {
        invoke: () => {
          throw new TypeError('boom');
        },
      },
    });
    expect(result.result.result).toBe('blocked');
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      failure: 'internal_error',
      failureDetail: 'TypeError',
    });
    // Only the error's NAME: a message could carry prose, a path, or an excerpt.
    expect(JSON.stringify(result.result)).not.toContain('boom');
  });

  test('a lineage that left `disputed` between selection and dispatch is not run', async () => {
    // The selector saw `disputed`; the block the dispatch validates says
    // otherwise. Nothing is invoked and nothing moves.
    const runner = createReconsiderationSubTurnRunner({
      issueBody: ISSUE_BODY,
      disputeArtifactDir,
      artifactDir,
      artifactRoot,
      repoCwd,
      agentId: 'claude',
      timestamp: '2026-08-06T12:00:00.000Z',
      invoke: () => {
        throw new Error('the invocation must not be reached');
      },
    });
    const outcome = runner({
      turn: { kind: 'reviewer_reconsideration', rule: 2, lineageIds: [LINEAGE] },
      identity: { kind: 'reviewer_reconsideration', runId: DERIVED_RUN_ID, lineageIds: [LINEAGE] },
      context: context({ [LINEAGE]: lineage({ state: 'arbitration_pending' }) }),
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    expect(outcome).toEqual({
      status: 'failed',
      failure: { kind: 'stale_lineage', detail: 'turn.lineageIds:none-disputed' },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. What reaches task context
// ---------------------------------------------------------------------------

describe('bounded agent metadata and artifact references', () => {
  test('the summary carries artifact BASE names and no local path', async () => {
    const result = await gate({
      runtime: { invoke: invokeReturning({ lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE }) },
    });
    const summary = result.result.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY];
    expect(summary.artifacts).toEqual({
      raw: `reconsideration-raw-${LINEAGE}.txt`,
      stderr: null,
      runnerError: null,
      record: `reconsideration-${LINEAGE}.json`,
    });
    for (const name of Object.values(summary.artifacts)) {
      if (name !== null) expect(name).not.toContain('/');
    }
    // The protocol's own keys name no directory: the run directory is the
    // review phase's own bookkeeping (`context.artifactDir`), and the debate
    // record references only base names inside it.
    const serialized = JSON.stringify({
      reconsideration: summary,
      subTurn: result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY],
    });
    expect(serialized).not.toContain(artifactRoot);
    expect(serialized).not.toContain(repoCwd);
  });

  test('the profile is the record\'s projection: identity, model, effort, tool policy — no command line', async () => {
    const result = await gate({
      runtime: { invoke: invokeReturning({ lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE }) },
    });
    const summary = result.result.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY];
    expect(summary.profile).toEqual({
      agentId: 'claude',
      provider: 'anthropic',
      model: 'opus',
      modelSource: 'default',
      effort: 'high',
      effortSource: 'default',
      toolPolicy: 'no-tools',
      role: 'reconsideration',
    });
    expect(summary.profile.argv).toBeUndefined();
    expect(summary.profile.cmd).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('--disallowedTools');
  });

  test('the reviewer\'s rationale never reaches task context; only its length does', async () => {
    const result = await gate({
      runtime: { invoke: invokeReturning({ lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE }) },
    });
    const serialized = JSON.stringify(result.result.context);
    expect(serialized).not.toContain(RATIONALE);
    expect(result.result.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY].record.rationaleChars)
      .toBe(RATIONALE.length);
  });

  test('the run directory and the reviewer are recorded PER LINEAGE, merged (P1)', async () => {
    // This turn answers one lineage per review run, so the two single-valued
    // keys above describe only the LAST run. A task with two disputed findings
    // takes two reviewer runs, and the arbitration turn that follows may select
    // either lineage — so each run's directory and reviewer identity are also
    // recorded under the lineage they belong to, over what the earlier run wrote
    // for its own (issue #955 review, P1).
    const earlier = {
      lineages: { 'ln-bbbbbbbbbbbb': { version: 1, artifactDir: '/artifacts/runs/run-review-6', agentId: 'gemini' } },
    };
    const result = await gate({
      runtime: {
        reconsiderations: earlier,
        invoke: invokeReturning({ lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE }),
      },
    });

    const record = result.result.context[REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD];
    // The posture rides the same entry, for the same reason and against the same
    // overwrite: on a two-lineage task the single-valued summary states only the
    // newest run's, and §17.6 D2 requires the earlier lineage's to stay readable
    // (issue #1085 review, P2). The carried-forward entry keeps whatever it had —
    // here, nothing, which reads as "no posture on record" and never as
    // `no-tools`.
    expect({ ...record.lineages }).toEqual({
      'ln-bbbbbbbbbbbb': { version: 1, artifactDir: '/artifacts/runs/run-review-6', agentId: 'gemini' },
      [LINEAGE]: { version: 1, artifactDir, agentId: 'claude', toolPolicy: 'no-tools' },
    });
    // The single-valued reference stays exactly what it was: it is what a debate
    // that started before this record still resolves against.
    expect(result.result.context.reconsiderationArtifactDir).toBe(artifactDir);
  });

  test('the posture reaches the sub-turn audit event, beside the lineage it decided (P2)', async () => {
    // §17.6 D2 requires a lineage decided under `read-bounded` to stay
    // distinguishable forever. The single-valued summary cannot carry that on a
    // task with two debates, so the §10.3 event names the posture next to the
    // lineage ids the run answered — which is what makes event history, and not
    // only a local run directory, able to answer "which posture decided THIS
    // lineage" (issue #1085 review, P2).
    const readBounded = {
      profile: {
        ...summaryFor(null).profile,
        agentId: 'codex',
        provider: 'openai',
        toolPolicy: 'read-bounded',
      },
    };
    const result = await gate({
      runtime: {
        agentId: 'codex',
        invoke: invokeReturning(
          { lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE },
          { summary: readBounded },
        ),
      },
    });

    const event = result.result.extraEvents.find((e) => e.data.turn === 'reviewer_reconsideration');
    expect(event.data).toMatchObject({ lineageIds: [LINEAGE], toolPolicy: 'read-bounded' });
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].toolPolicy).toBe('read-bounded');
    expect(result.result.context[REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD].lineages[LINEAGE].toolPolicy)
      .toBe('read-bounded');

    // A run that could not answer still states the posture it was taking: "the
    // run that failed was the read-bounded one" is exactly what an operator
    // reading a park needs, and the park's event is the only place it survives.
    const parked = await gate({
      runtime: {
        agentId: 'codex',
        invoke: () => ({
          ok: false,
          failure: { kind: 'agent-failed', detail: 'exit:3' },
          artifacts: [],
          summary: summaryFor(null, { exitCode: 3, ...readBounded }),
        }),
      },
    });
    expect(parked.result.result).toBe('blocked');
    expect(parked.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].toolPolicy).toBe('read-bounded');
  });

  test('an earlier lineage keeps its posture after a later run under another one (P2)', () => {
    // The failure this closes: the single-valued summary describes the LAST
    // reviewer run, so on a two-lineage task it reports the newer lineage's
    // posture for the whole task and the older one becomes unreadable from
    // persisted state. The per-lineage record is what the operator projection
    // reads instead, and it is never defaulted — the third lineage below
    // recorded no posture and reports `null`, not `no-tools`.
    const task = {
      sessionId: 'demo',
      issueNumber: 7,
      status: 'queued',
      context: {
        reviewDispute: context(),
        reviewDisputeReconsideration: {
          lineageId: 'ln-bbbbbbbbbbbb',
          version: 1,
          profile: { agentId: 'claude', toolPolicy: 'no-tools' },
        },
        reviewDisputeReconsiderations: {
          lineages: {
            [LINEAGE]: {
              version: 1,
              artifactDir: '/artifacts/runs/run-review-7',
              agentId: 'codex',
              toolPolicy: 'read-bounded',
            },
            'ln-bbbbbbbbbbbb': {
              version: 1,
              artifactDir: '/artifacts/runs/run-review-8',
              agentId: 'claude',
              toolPolicy: 'no-tools',
            },
            'ln-cccccccccccc': { version: 1, artifactDir: '/artifacts/runs/run-review-2', agentId: 'claude' },
          },
        },
      },
    };

    const status = summarizeDisputeStatus(task);
    expect(status.lastReconsideration).toMatchObject({ lineageId: 'ln-bbbbbbbbbbbb', toolPolicy: 'no-tools' });
    expect(status.reconsiderationsByLineage).toEqual([
      { lineageId: LINEAGE, version: 1, agentId: 'codex', toolPolicy: 'read-bounded' },
      { lineageId: 'ln-bbbbbbbbbbbb', version: 1, agentId: 'claude', toolPolicy: 'no-tools' },
      { lineageId: 'ln-cccccccccccc', version: 1, agentId: 'claude', toolPolicy: null },
    ]);
  });

  test('an entry the reader would drop is never written, and a failed run writes none', async () => {
    // A persisted entry naming an agent this runner does not recognise is not a
    // party (`canonicalizeDisputeParty`), so it is carried forward as a
    // directory alone rather than as an identity §8.3 cannot measure against.
    const result = await gate({
      runtime: {
        reconsiderations: {
          lineages: {
            'ln-bbbbbbbbbbbb': { version: 1, artifactDir: '/artifacts/runs/run-review-6', agentId: 'not-an-agent' },
            'ln-cccccccccccc': { version: 0, artifactDir: '/artifacts/runs/run-review-4', agentId: 'claude' },
          },
        },
        invoke: invokeReturning({ lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE }),
      },
    });
    expect({ ...result.result.context[REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD].lineages }).toEqual({
      'ln-bbbbbbbbbbbb': { version: 1, artifactDir: '/artifacts/runs/run-review-6' },
      [LINEAGE]: { version: 1, artifactDir, agentId: 'claude', toolPolicy: 'no-tools' },
    });

    // A run that produced no §10.2 record has no directory worth pointing at:
    // the park leaves the key exactly as the last successful run left it.
    const failed = await gate({ runtime: { invoke: invokeFailing({ kind: 'agent-failed', detail: 'exit:3' }) } });
    expect(failed.result.context[REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD]).toBeUndefined();
  });

  test('the rebuttal is read from the fix run that rebutted THIS lineage (P1)', async () => {
    // `disputeArtifactDir` names the LAST fix run, but a fix run rebuts only the
    // lineages its own response disputed. With two lineages rebutted separately,
    // this turn would otherwise look for `dispute-<lineageId>.json` in a
    // directory that never held it (issue #955 review, P1).
    const calls = [];
    const ownDir = join(artifactRoot, 'runs', 'run-impl-5');
    mkdirSync(ownDir, { recursive: true });
    const result = await gate({
      runtime: {
        rebuttals: {
          lineages: {
            [LINEAGE]: { version: 1, artifactDir: ownDir, agentId: 'claude' },
            'ln-bbbbbbbbbbbb': { version: 1, artifactDir: disputeArtifactDir, agentId: 'codex' },
          },
        },
        invoke: invokeReturning(
          { lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE },
          { calls },
        ),
      },
    });

    expect(result.kind).toBe('handled');
    expect(calls).toHaveLength(1);
    expect(calls[0].disputeArtifactDir).toBe(ownDir);
  });

  test.each([
    ['no record at all', undefined],
    ['a record naming only the sibling', { lineages: { 'ln-bbbbbbbbbbbb': { version: 1, artifactDir: '/elsewhere' } } }],
    ['an entry for a version this lineage has not reached', { lineages: { [LINEAGE]: { version: 2, artifactDir: '/elsewhere' } } }],
    ['an unreadable record', 'nonsense'],
  ])('%s leaves the single-valued directory in place', async (_name, rebuttals) => {
    const calls = [];
    await gate({
      runtime: {
        ...(rebuttals === undefined ? {} : { rebuttals }),
        invoke: invokeReturning(
          { lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE },
          { calls },
        ),
      },
    });

    expect(calls[0].disputeArtifactDir).toBe(disputeArtifactDir);
  });
});

// ---------------------------------------------------------------------------
// 5. The §10.2 findings read
// ---------------------------------------------------------------------------

describe('readLineageFindingVersions', () => {
  test('returns the version this cycle recorded for THIS lineage', () => {
    // One review cycle records at most ONE version per lineage (§2.2), so the
    // list this read yields is that cycle's record for the lineage asked about —
    // never a sibling's, whatever version the sibling carries.
    writeFindingsArtifact([
      { ...findingVersion({ version: 2 }), lineageId: 'ln-bbbbbbbbbbbb' },
      findingVersion(),
    ]);
    expect(readLineageFindingVersions(artifactRoot, reviewArtifactDir, LINEAGE).map((f) => f.version)).toEqual([1]);
  });

  test('an artifact holding two versions of one lineage is refused, not half-trusted', () => {
    // §2.2/§2.3: a version was overwritten or a duplicate was appended. The
    // §10.2 parser refuses the whole set, and #845 then reads "no predecessor on
    // file" and refuses the revision rather than deciding it against one half.
    writeFindingsArtifact([
      findingVersion({ version: 2, preconditions: 'Any caller may reach the handler directly.' }),
      findingVersion(),
    ]);
    expect(readLineageFindingVersions(artifactRoot, reviewArtifactDir, LINEAGE)).toEqual([]);
  });

  test('an absent, unreadable, or malformed artifact yields no versions', () => {
    expect(readLineageFindingVersions(artifactRoot, undefined, LINEAGE)).toEqual([]);
    expect(readLineageFindingVersions(artifactRoot, '', LINEAGE)).toEqual([]);
    expect(readLineageFindingVersions(artifactRoot, reviewArtifactDir, LINEAGE)).toEqual([]);
    writeFileSync(join(reviewArtifactDir, REVIEW_FINDINGS_ARTIFACT), 'not json', 'utf8');
    expect(readLineageFindingVersions(artifactRoot, reviewArtifactDir, LINEAGE)).toEqual([]);
  });

  test('another lineage\'s versions are not this lineage\'s', () => {
    writeFindingsArtifact([{ ...findingVersion(), lineageId: 'ln-bbbbbbbbbbbb' }]);
    expect(readLineageFindingVersions(artifactRoot, reviewArtifactDir, LINEAGE)).toEqual([]);
  });

  test('a directory outside the artifact root yields no versions', () => {
    // `reviewArtifactDir` is task context and therefore untrusted. #838 already
    // drops an escaping directory for the prompt bundle; the revision read must
    // drop it on the same terms, or a crafted external `review-findings.json`
    // would decide #845's classification for a real disputed lineage.
    const outside = join(root, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, REVIEW_FINDINGS_ARTIFACT),
      JSON.stringify({ findings: [findingVersion()] }, null, 2),
      'utf8',
    );
    expect(readLineageFindingVersions(artifactRoot, outside, LINEAGE)).toEqual([]);
  });

  test('a directory reached through a symlink yields no versions', () => {
    // The escape can also be a link planted INSIDE the root between the review
    // run and this one. `isSafeArtifactDirAfterRun` resolves it; the read must
    // not follow it.
    const outside = join(root, 'planted');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, REVIEW_FINDINGS_ARTIFACT),
      JSON.stringify({ findings: [findingVersion()] }, null, 2),
      'utf8',
    );
    const linked = join(artifactRoot, 'runs', 'run-review-linked');
    symlinkSync(outside, linked, 'dir');
    expect(readLineageFindingVersions(artifactRoot, linked, LINEAGE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The §7.1 evidence turn behind the same gate (issue #964)
// ---------------------------------------------------------------------------

describe('the evidence turn dispatches through the gate (issue #964)', () => {
  const evidenceLineage = (overrides = {}) =>
    lineage({
      state: 'evidence_requested',
      counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
      ...overrides,
    });

  function evidenceRuntime(overrides = {}) {
    return {
      issueBody: ISSUE_BODY,
      disputeArtifactDir,
      reconsiderationArtifactDir: reviewArtifactDir,
      reviewArtifactDir,
      artifactDir,
      artifactRoot,
      repoCwd,
      timestamp: '2026-08-06T12:00:00.000Z',
      agent: { assignment: { implementationAgent: 'codex', reviewAgent: 'claude' } },
      // Resolution seam so no `git ls-files` subprocess runs in these tests.
      resolveEvidenceRef: () => true,
      ...overrides,
    };
  }

  test('selects one missing party at a time from the persisted round', () => {
    const turn = { lineageIds: [LINEAGE] };
    const ctx = context({ [LINEAGE]: evidenceLineage() });
    // A fresh round starts with the implementer.
    expect(selectEvidenceTurnParty(turn, ctx, undefined)).toMatchObject({ ok: true, party: 'implementer' });
    // A partial round resumes with the party still owed, never the one on file.
    const partial = {
      lineages: {
        [LINEAGE]: {
          version: 1,
          parties: { implementer: { runId: 'run-a~evidence.implementer.0', attempt: 0, attachments: 2 } },
        },
      },
    };
    expect(selectEvidenceTurnParty(turn, ctx, partial)).toMatchObject({ ok: true, party: 'reviewer' });
    // A malformed round record refuses before any party is named: restarting a
    // round whose answers it hides would silently re-buy or reuse evidence.
    const malformed = selectEvidenceTurnParty(turn, ctx, { lineages: 'garbage' });
    expect(malformed.ok).toBe(false);
    expect(malformed.failure).toMatchObject({ kind: 'invalid_context' });
  });

  test('a malformed persisted round parks the turn instead of dispatching a party', async () => {
    const result = await gate({
      persisted: context({ [LINEAGE]: evidenceLineage() }),
      evidence: evidenceRuntime({ evidenceRound: { lineages: 'garbage' } }),
    });
    expect(result.kind).toBe('handled');
    expect(result.result.result).toBe('blocked');
    expect(result.result.disputeTransition).toBeUndefined();
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'evidence_collection',
      disposition: 'parked',
      failure: 'invalid_context',
    });
  });

  test('a round both parties answered resumes row 22 from the record without invoking anyone', async () => {
    // Both parties are on file (a restart after the second party completed but
    // before row 22 committed). The gate selects a party, the dispatch adapter
    // recognizes `round_complete`, and row 22 moves the lineage back to
    // arbitration — no agent runs and no answer is re-bought.
    const round = {
      lineages: {
        [LINEAGE]: {
          version: 1,
          parties: {
            implementer: { runId: 'run-old~evidence.implementer.0', attempt: 0, attachments: 2 },
            reviewer: { runId: 'run-old~evidence.reviewer.0', attempt: 0, attachments: 1 },
          },
        },
      },
    };
    const result = await gate({
      persisted: context({ [LINEAGE]: evidenceLineage() }),
      evidence: evidenceRuntime({ evidenceRound: round }),
    });
    expect(result.kind).toBe('handled');
    expect(result.result.result).toBe('success');
    const application = result.result.disputeTransition;
    expect(application.applied).toHaveLength(1);
    expect(application.context.lineages[LINEAGE].state).toBe('arbitration_pending');
    expect(application.context.lineages[LINEAGE].counters.evidenceRoundsUsed).toBe(1);
    // The re-presented verdict is the arbitration turn's next selection.
    expect(application.routing).toMatchObject({ rule: 2, turn: 'runner', nextPhase: 'review' });
    const summary = result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY];
    expect(summary).toMatchObject({
      turn: 'evidence_collection',
      party: 'implementer',
      disposition: 'applied',
      evidenceRound: { replayedCollection: 'round_complete', closing: LINEAGE, attachmentsRecorded: 3 },
    });
    // The round is spent under THIS run's derived identity, so a redelivery
    // replays the same row and a later round starts from an empty record.
    const nextRound = result.result.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY];
    expect(nextRound.lineages[LINEAGE].recordedRunId).toBe(`${RUN_ID}~evidence.implementer.0`);
  });

  test('an unassemblable bundle parks with the party marked recoverable, the round unspent', async () => {
    // The dispute record cannot be located (the fix run's directory holds no
    // dispute-<lineageId>.json), so #964's assembly refuses before any agent is
    // invoked; the adapter records the implementer's stop as recoverable, and
    // the resumed phase still owes the same party (#963).
    const result = await gate({
      persisted: context({ [LINEAGE]: evidenceLineage() }),
      evidence: evidenceRuntime(),
    });
    expect(result.kind).toBe('handled');
    expect(result.result.result).toBe('blocked');
    expect(result.result.disputeTransition).toBeUndefined();
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'evidence_collection',
      party: 'implementer',
      disposition: 'parked',
      failure: 'invocation_failed',
      failureDetail: `dispute:${LINEAGE}:missing`,
    });
    const round = result.result.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY];
    expect(round.lineages[LINEAGE].parties.implementer).toMatchObject({ status: 'recoverable', attempt: 0 });
    expect(round.lineages[LINEAGE].recordedRunId).toBeUndefined();
  });

  test('disabled sessions never enter the evidence path even with a runtime supplied', async () => {
    const result = await gate({
      enabled: false,
      persisted: context({ [LINEAGE]: evidenceLineage() }),
      evidence: evidenceRuntime(),
    });
    expect(result.kind).toBe('ordinary_review');
  });
});
