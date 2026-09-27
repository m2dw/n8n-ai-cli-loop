/**
 * Issue #954: the §7.1 arbitration sub-turn adapter
 * (src/handlers/review-arbitration-turn.ts,
 * docs/review-dispute-contract.md §7.1, §8.2, §8.3, §10.2).
 *
 * The seam under test takes VALUES — the selected turn, its derived identity, the
 * validated §10.1 block, the resolved §6.1/§8.3 settings, the two parties, and a
 * candidate resolver — and returns one typed outcome. It stops before the verdict
 * routing and the transition #955 owns, so every assertion below is about what
 * this slice decides and what it hands on:
 *
 *  - exactly ONE deterministically chosen `arbitration_pending` lineage per call,
 *    with the rest left for the next selector cycle;
 *  - the arbiter #839 selected is the ONLY agent invoked — never the review or
 *    implementation party — and an unavailable or same-provider-disallowed
 *    candidate list produces a typed value with no invocation at all;
 *  - the input handed to #846 is the one it documents, down to the sub-turn's
 *    derived run identity and the bounded artifact roots;
 *  - failures normalize into the sub-turn vocabulary without mutating anything;
 *  - what may reach task context is bounded: literals, counters, artifact BASE
 *    names, and no command line or arbiter prose;
 *  - this adapter never routes and never registers itself: the review phase
 *    dispatches the turn only when its caller supplied #955's runtime.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ARBITRATION_SUB_TURN_DISPOSITIONS,
  REVIEW_DISPUTE_ARBITRATION_CONTEXT_KEY,
  createArbitrationSubTurnAdapter,
  nextArbitrationLineage,
} from '../dist/handlers/review-arbitration-turn.js';
import { runReviewDisputeSubTurn } from '../dist/handlers/review-reconsideration-turn.js';
import { createArbiterCandidateResolver } from '../dist/core/review-arbiter-profile.js';
import {
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
  disputeSubTurnIdentity,
} from '../dist/core/review-dispute-dispatch.js';
import {
  arbitrationArtifactName,
  arbitrationBundleArtifactName,
  disputeArtifactName,
  reconsiderationArtifactName,
  REVIEW_FINDINGS_ARTIFACT,
} from '../dist/core/review-dispute-lineage.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const LINEAGE_C = 'ln-cccccccccccc';
const BOUNDARY = 'src/auth/handler.ts';
const RUN_ID = 'run-review-9';
/** What `disputeSubTurnIdentity` derives for a first-attempt arbitration turn. */
const DERIVED_RUN_ID = `${RUN_ID}~runner.0`;
const RATIONALE =
  'The Issue contract requires a 401 on every entry path, and the middleware the rebuttal cites does not run on '
  + 'the direct-dispatch path, so the finding holds.';
const ISSUE_BODY = 'The endpoint must never return 500 for an unauthenticated request.';

let tmpRoot;
let artifactRoot;
let artifactDir;
let disputeDir;
let reconsiderationDir;
let reviewDir;
let repoCwd;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRepo() {
  mkdirSync(join(repoCwd, 'src', 'auth'), { recursive: true });
  for (const file of ['handler.ts', 'middleware.ts']) {
    writeFileSync(
      join(repoCwd, 'src', 'auth', file),
      Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n',
      'utf8',
    );
  }
}

/** A command runner that answers `git ls-files -s` from the fixture repository. */
function trackedFilesRunner(calls = []) {
  return {
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return {
        stdout: '100644 aaaaaaa 0\tsrc/auth/handler.ts\n100644 bbbbbbb 0\tsrc/auth/middleware.ts\n',
        stderr: '',
        exitCode: 0,
      };
    },
  };
}

function findingRecord() {
  return {
    lineageId: LINEAGE,
    version: 1,
    severity: 'P1',
    violatedContract: 'The handler must reject a null session before dereferencing it.',
    preconditions: 'A request arrives with no session cookie.',
    failureScenario: 'The handler dereferences session.userId and throws a 500.',
    affectedBoundary: BOUNDARY,
    requiredOutcome: 'A null session is rejected with 401 before any dereference.',
    evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 30, endLine: 32 }],
    humanGate: false,
    reviewerMeta: { agentId: 'gemini', reviewRunId: 'run-review-1', timestamp: '2026-08-05T00:00:00.000Z' },
  };
}

function writeArtifacts() {
  writeFileSync(
    join(disputeDir, disputeArtifactName(LINEAGE)),
    JSON.stringify({
      lineageId: LINEAGE,
      version: 1,
      severity: 'P1',
      affectedBoundary: BOUNDARY,
      humanGate: false,
      state: 'disputed',
      run: { runId: 'run-impl-1', agentId: 'codex', timestamp: '2026-08-05T01:00:00.000Z' },
      record: {
        lineageId: LINEAGE,
        version: 1,
        disposition: 'review_disputed',
        dispute: {
          challenged: { lineageId: LINEAGE, version: 1 },
          rebuttalReason: 'false_premise',
          argument: 'The middleware rejects a null session before the handler is reached.',
          evidenceRefs: [{ kind: 'file', path: 'src/auth/middleware.ts', startLine: 10, endLine: 12 }],
          testEvidence: ['test/auth.test.js > rejects a null session'],
          whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
        },
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(reconsiderationDir, reconsiderationArtifactName(LINEAGE)),
    JSON.stringify({
      lineageId: LINEAGE,
      version: 1,
      severity: 'P1',
      affectedBoundary: BOUNDARY,
      humanGate: false,
      state: 'disputed',
      run: { runId: 'run-review-2', agentId: 'gemini', timestamp: '2026-08-05T02:00:00.000Z' },
      record: {
        lineageId: LINEAGE,
        version: 1,
        reconsideration: 'uphold',
        rationale: 'The middleware does not run on the direct-dispatch path, so the finding stands as written.',
      },
    }),
    'utf8',
  );
  writeFileSync(join(reviewDir, REVIEW_FINDINGS_ARTIFACT), JSON.stringify({ findings: [findingRecord()] }), 'utf8');
}

function lineage(overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: LINEAGE,
    state: 'arbitration_pending',
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1, reconsiderations: 1, ...counterOverrides },
    rebuttedVersions: [1],
    disputeRuns: [{ version: 1, runId: 'run-impl-1' }],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
    ...rest,
  };
}

function context(lineages = { [LINEAGE]: lineage() }) {
  return { version: 1, reviewStructure: 'structured', lineages };
}

/** The §8.3 policy, cross-provider by default: parties on OpenAI and Google. */
function settings(arbiter = {}) {
  return {
    enabled: true,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    arbiter: { providers: ['claude'], allowSameProvider: false, minConfidence: 0.7, ...arbiter },
  };
}

function runtime(overrides = {}) {
  return {
    settings: settings(),
    implementation: { agentId: 'codex', model: 'gpt-5-codex' },
    review: { agentId: 'gemini', model: 'gemini-3.1-pro' },
    resolveCandidate: createArbiterCandidateResolver({ env: {} }),
    issueBody: ISSUE_BODY,
    disputeArtifactDir: disputeDir,
    reconsiderationArtifactDir: reconsiderationDir,
    reviewArtifactDir: reviewDir,
    artifactDir,
    artifactRoot,
    repoCwd,
    timestamp: '2026-08-05T03:00:00.000Z',
    runner: trackedFilesRunner(),
    env: {},
    ...overrides,
  };
}

function request(overrides = {}) {
  const { turn: turnOverride, ...rest } = overrides;
  const turn = turnOverride ?? { kind: 'runner_arbitration', rule: 2, lineageIds: [LINEAGE] };
  const identity = disputeSubTurnIdentity({ runId: RUN_ID, turn });
  expect(identity.ok).toBe(true);
  return {
    turn,
    identity: identity.value,
    context: context(),
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    ...rest,
  };
}

function verdict(overrides = {}) {
  return { lineageId: LINEAGE, version: 1, verdict: 'reviewer_correct', confidence: 0.86, rationale: RATIONALE, ...overrides };
}

function fenced(value) {
  return `Arbitrated.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/** The AGENT's own subprocess seam: the real isolation path runs, the spawn does not. */
function agentRunner(response, calls = [], exitCode = 0) {
  return {
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return { stdout: exitCode === 0 ? response : '', stderr: exitCode === 0 ? '' : response, exitCode };
    },
  };
}

/**
 * An `invoke` stub that records the #846 input it was handed.
 *
 * Its default answer is a failed run whose summary is built FROM that input, so
 * the profile facts the adapter republishes are the ones it actually passed down
 * rather than a hand-written constant that could agree with nothing.
 */
function recordingInvoke(seen, result) {
  return (input) => {
    seen.push(input);
    if (result !== undefined) return result;
    const profile = input.selection.profile;
    const failure = { kind: 'agent-failed', detail: 'exit:1' };
    return {
      ok: false,
      failure,
      bundle: null,
      artifacts: [],
      summary: {
        lineageId: input.pending.lineageId,
        version: input.pending.version,
        runKey: `${input.pending.lineageId}@${input.pending.version}#${input.run.runId}`,
        bundleDigest: 'deadbeef',
        promptBytes: 10,
        bundleEntries: 1,
        rawOutputBytes: 0,
        bundleArtifact: null,
        rawArtifact: null,
        stderrArtifact: null,
        runnerErrorArtifact: null,
        verdictArtifact: null,
        excerpts: 0,
        unresolvedExcerpts: 0,
        exitCode: 1,
        timedOut: false,
        durationMs: 1,
        profile: {
          agentId: profile.agentId,
          provider: profile.provider,
          model: profile.model,
          effort: profile.effort,
          toolPolicy: profile.toolPolicy,
          candidateIndex: profile.candidateIndex,
          minConfidence: profile.minConfidence,
          sameProviderFallback: profile.sameProviderFallback,
          sharedProviderWith: [...profile.sharedProviderWith],
        },
        verdict: null,
        failure,
      },
    };
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'arbitration-turn-'));
  artifactRoot = join(tmpRoot, 'artifacts');
  artifactDir = join(artifactRoot, 'runs', RUN_ID);
  disputeDir = join(artifactRoot, 'runs', 'run-impl-1');
  reconsiderationDir = join(artifactRoot, 'runs', 'run-review-2');
  reviewDir = join(artifactRoot, 'runs', 'run-review-1');
  repoCwd = join(tmpRoot, 'worktree');
  for (const dir of [artifactDir, disputeDir, reconsiderationDir, reviewDir, repoCwd]) {
    mkdirSync(dir, { recursive: true });
  }
  makeRepo();
  writeArtifacts();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('construction', () => {
  test('the adapter is built once from values and invokes nothing on its own', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(runtime({ invoke: recordingInvoke(seen) }));
    expect(typeof adapter).toBe('function');
    expect(seen).toHaveLength(0);
  });

  test('a turn that is not the arbitration turn fails closed as an identity fault', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(runtime({ invoke: recordingInvoke(seen) }));
    const reviewerTurn = { kind: 'reviewer_reconsideration', rule: 2, lineageIds: [LINEAGE] };
    const identity = disputeSubTurnIdentity({ runId: RUN_ID, turn: reviewerTurn });
    const outcome = adapter({
      turn: reviewerTurn,
      identity: identity.value,
      context: context({ [LINEAGE]: lineage({ state: 'disputed' }) }),
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    expect(outcome.kind).toBe('not_dispatched');
    expect(outcome.failure.kind).toBe('invalid_identity');
    expect(seen).toHaveLength(0);
  });

  test('the disposition tokens are the outcome kinds, and nothing else', () => {
    expect([...ARBITRATION_SUB_TURN_DISPOSITIONS]).toEqual(['invoked', 'not_invoked', 'not_dispatched']);
  });
});

// ---------------------------------------------------------------------------
// One lineage per call
// ---------------------------------------------------------------------------

describe('one deterministically chosen lineage per call (§7.1)', () => {
  test('the FIRST still-pending id of a multi-lineage turn is the one arbitrated', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(runtime({ invoke: recordingInvoke(seen) }));
    const outcome = adapter(
      request({
        turn: { kind: 'runner_arbitration', rule: 2, lineageIds: [LINEAGE, LINEAGE_B, LINEAGE_C] },
        context: context({
          // The first id has left the state since selection; the remaining two are
          // still owed a run, and only ONE of them is answered here.
          [LINEAGE]: lineage({ state: 'resolved_fixed', outcome: 'resolved_fixed' }),
          [LINEAGE_B]: lineage({ lineageId: LINEAGE_B }),
          [LINEAGE_C]: lineage({ lineageId: LINEAGE_C }),
        }),
      }),
    );
    expect(outcome.kind).toBe('invoked');
    expect(outcome.lineageId).toBe(LINEAGE_B);
    expect(seen).toHaveLength(1);
    expect(seen[0].pending).toEqual({ lineageId: LINEAGE_B, version: 1 });
    // The turn's whole set is still recorded: the remainder is not lost, it is
    // simply not this call's work.
    expect(outcome.summary.lineageIds).toEqual([LINEAGE, LINEAGE_B, LINEAGE_C]);
  });

  test('the selection is a pure function of the block and the turn', () => {
    const req = request({
      turn: { kind: 'runner_arbitration', rule: 2, lineageIds: [LINEAGE, LINEAGE_B] },
      context: context({
        [LINEAGE]: lineage({ state: 'binding' }),
        [LINEAGE_B]: lineage({ lineageId: LINEAGE_B }),
      }),
    });
    expect(nextArbitrationLineage(req).lineageId).toBe(LINEAGE_B);
    expect(nextArbitrationLineage(req).lineageId).toBe(LINEAGE_B);
  });

  test('a turn whose lineages have all left `arbitration_pending` dispatches nothing', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(runtime({ invoke: recordingInvoke(seen) }));
    const outcome = adapter(
      request({ context: context({ [LINEAGE]: lineage({ state: 'evidence_requested' }) }) }),
    );
    expect(outcome.kind).toBe('not_dispatched');
    expect(outcome.failure).toEqual({
      kind: 'stale_lineage',
      detail: 'turn.lineageIds:none-arbitration-pending',
    });
    expect(outcome.lineageId).toBeNull();
    expect(seen).toHaveLength(0);
  });

  test('a lineage the turn names but the block does not hold is skipped, not invented', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(runtime({ invoke: recordingInvoke(seen) }));
    const outcome = adapter(
      request({
        turn: { kind: 'runner_arbitration', rule: 2, lineageIds: [LINEAGE_B, LINEAGE] },
        context: context({ [LINEAGE]: lineage() }),
      }),
    );
    expect(outcome.lineageId).toBe(LINEAGE);
    expect(seen[0].pending.lineageId).toBe(LINEAGE);
  });

  test('an absent artifact directory refuses rather than reading a guessed one', () => {
    for (const field of ['disputeArtifactDir', 'reconsiderationArtifactDir']) {
      const seen = [];
      const adapter = createArbitrationSubTurnAdapter(
        runtime({ [field]: '', invoke: recordingInvoke(seen) }),
      );
      const outcome = adapter(request());
      expect(outcome.kind).toBe('not_dispatched');
      expect(outcome.failure).toEqual({ kind: 'invocation_failed', detail: `${field}:absent` });
      expect(seen).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Profile resolution (§8.3)
// ---------------------------------------------------------------------------

describe('arbiter profile resolution (§8.3)', () => {
  test('a cross-provider candidate is selected and its facts travel', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(runtime({ invoke: recordingInvoke(seen) }));
    const outcome = adapter(request());
    expect(outcome.kind).toBe('invoked');
    expect(outcome.resolution.kind).toBe('selected');
    expect(outcome.summary.turn).toBe('runner_arbitration');
    expect(outcome.summary.taskTurn).toBe('runner');
    expect(outcome.summary.profileResolution).toBe('selected');
    expect(outcome.summary.profile.agentId).toBe('claude');
    expect(outcome.summary.profile.candidateIndex).toBe(0);
    expect(outcome.summary.profile.minConfidence).toBe(0.7);
    expect(outcome.summary.profile.sameProviderFallback).toBe(false);
    expect(outcome.summary.profile.sharedProviderWith).toEqual([]);
    expect(outcome.summary.profile.toolPolicy).toBe('no-tools');
    expect(outcome.summary.parties).toEqual({
      implementation: { role: 'implementation', agentId: 'codex', provider: 'openai', model: 'gpt-5-codex' },
      review: { role: 'review', agentId: 'gemini', provider: 'google', model: 'gemini-3.1-pro' },
    });
    expect(outcome.summary.policy).toEqual({
      candidates: ['claude'],
      allowSameProvider: false,
      minConfidence: 0.7,
    });
  });

  test('candidates are rejected in configured order and the first acceptable one wins', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ settings: settings({ providers: ['codex', 'claude'] }), invoke: recordingInvoke(seen) }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('invoked');
    expect(outcome.summary.candidateRejections).toEqual([
      { index: 0, candidate: 'codex', reason: 'unsupported-role', detail: 'no-no-tools-invocation' },
    ]);
    expect(outcome.summary.profile.candidateIndex).toBe(1);
    expect(seen[0].selection.profile.agentId).toBe('claude');
  });

  test('a same-provider candidate without the opt-in is refused, and nothing is invoked', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ review: { agentId: 'claude', model: 'sonnet' }, invoke: recordingInvoke(seen) }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('not_invoked');
    expect(seen).toHaveLength(0);
    expect(outcome.resolution.kind).toBe('human_handoff');
    expect(outcome.resolution.reason).toBe('no-acceptable-candidate');
    expect(outcome.summary.row).toBe(19);
    expect(outcome.summary.candidateRejections).toEqual([
      { index: 0, candidate: 'claude', reason: 'same-provider-not-allowed', detail: 'review' },
    ]);
    expect(outcome.failure).toEqual({
      kind: 'profile_unavailable',
      detail: 'human_handoff:no-acceptable-candidate',
    });
    // Ready for #955: the resolution travels as #847's own `profile` outcome.
    expect(outcome.route).toEqual({
      kind: 'profile',
      resolution: outcome.resolution,
      run: { runId: DERIVED_RUN_ID },
    });
    expect(outcome.artifacts).toEqual([]);
  });

  test('an unavailable CLI is a typed handoff, never a substituted agent', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(
      runtime({
        resolveCandidate: createArbiterCandidateResolver({ env: {}, cliAvailable: () => 'unavailable' }),
        invoke: recordingInvoke(seen),
      }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('not_invoked');
    expect(outcome.summary.candidateRejections[0].reason).toBe('cli-unavailable');
    expect(outcome.summary.profile).toBeNull();
    expect(outcome.summary.parties).toBeNull();
    expect(seen).toHaveLength(0);
  });

  test('an empty candidate list is `no-candidates`, and still row 19', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ settings: settings({ providers: [] }), invoke: recordingInvoke(seen) }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('not_invoked');
    expect(outcome.resolution.reason).toBe('no-candidates');
    expect(outcome.summary.row).toBe(19);
    expect(seen).toHaveLength(0);
  });

  test('a disabled protocol resolves nothing and invokes nothing', () => {
    const seen = [];
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ settings: { ...settings(), enabled: false }, invoke: recordingInvoke(seen) }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('not_invoked');
    expect(outcome.resolution.kind).toBe('not_applicable');
    expect(outcome.summary.row).toBeNull();
    expect(outcome.failure.detail).toBe('not_applicable:dispute-disabled');
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invocation construction
// ---------------------------------------------------------------------------

describe('the #846 input contract', () => {
  test('every documented field is supplied, from the sub-turn and the runtime', () => {
    const seen = [];
    const req = request();
    const adapter = createArbitrationSubTurnAdapter(runtime({ invoke: recordingInvoke(seen) }));
    adapter(req);
    const input = seen[0];
    expect(input.selection.kind).toBe('selected');
    expect(input.selection.lineageId).toBe(LINEAGE);
    expect(input.pending).toEqual({ lineageId: LINEAGE, version: 1 });
    // The CURRENT validated block, by reference: nothing is re-parsed or rebuilt.
    expect(input.context).toBe(req.context);
    expect(input.limits).toBe(req.limits);
    expect(input.issueBody).toBe(ISSUE_BODY);
    expect(input.disputeArtifactDir).toBe(disputeDir);
    expect(input.reconsiderationArtifactDir).toBe(reconsiderationDir);
    expect(input.reviewArtifactDir).toBe(reviewDir);
    expect(input.artifactDir).toBe(artifactDir);
    expect(input.artifactRoot).toBe(artifactRoot);
    expect(input.repoCwd).toBe(repoCwd);
    // The SUB-TURN's derived run id — the value #840's ledger keys on — and the
    // ARBITER's own agent id, never the review party's.
    expect(input.run).toEqual({
      runId: DERIVED_RUN_ID,
      agentId: 'claude',
      timestamp: '2026-08-05T03:00:00.000Z',
    });
    expect(input.run.agentId).not.toBe('gemini');
    // The run key the outcome publishes is the one #846 composes from that id.
    expect(seen).toHaveLength(1);
  });

  test('the optional bundle inputs are forwarded only when the runtime carries them', () => {
    const seen = [];
    const bare = createArbitrationSubTurnAdapter(
      runtime({ reviewArtifactDir: undefined, invoke: recordingInvoke(seen) }),
    );
    bare(request());
    expect('reviewArtifactDir' in seen[0]).toBe(false);
    expect('diffExcerpt' in seen[0]).toBe(false);
    expect('evidenceRoundAttachments' in seen[0]).toBe(false);

    const attachment = {
      party: 'reviewer',
      ref: { kind: 'file', path: BOUNDARY, startLine: 1, endLine: 2 },
    };
    const full = createArbitrationSubTurnAdapter(
      runtime({
        diffExcerpt: '@@ -1 +1 @@',
        verificationEvidence: ['npm test > auth'],
        evidenceRoundAttachments: [attachment],
        timeoutMs: 1234,
        invoke: recordingInvoke(seen),
      }),
    );
    full(request());
    expect(seen[1].diffExcerpt).toBe('@@ -1 +1 @@');
    expect(seen[1].verificationEvidence).toEqual(['npm test > auth']);
    expect(seen[1].evidenceRoundAttachments).toEqual([attachment]);
    expect(seen[1].timeoutMs).toBe(1234);
  });

  test('the run key is the sub-turn identity applied to the chosen lineage', () => {
    const adapter = createArbitrationSubTurnAdapter(runtime({ invoke: recordingInvoke([]) }));
    const outcome = adapter(request());
    expect(outcome.runKey).toBe(`${LINEAGE}@1#${DERIVED_RUN_ID}`);
    expect(outcome.summary.runKey).toBe(outcome.runKey);
  });
});

// ---------------------------------------------------------------------------
// The real invocation
// ---------------------------------------------------------------------------

describe('the selected arbiter, really invoked (§8.2)', () => {
  test('only the arbiter is spawned, with the profile #839 resolved', () => {
    const calls = [];
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ agentRunner: agentRunner(fenced(verdict()), calls) }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('invoked');
    expect(outcome.result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].cmd).not.toBe('codex');
    expect(calls[0].cmd).not.toBe('agy');
    // §8.2: no tool surface, and the bundle travels on stdin rather than in argv.
    expect(calls[0].args).toEqual(outcome.resolution.profile.argv);
    expect(calls[0].args.join(' ')).toContain('--disallowedTools');
    expect(calls[0].opts.stdin).toContain(LINEAGE);
    expect(calls[0].opts.cwd).not.toBe(repoCwd);
  });

  test('the admitted verdict, its confidence routing, and its artifacts come back whole', () => {
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ agentRunner: agentRunner(fenced(verdict())) }),
    );
    const outcome = adapter(request());
    expect(outcome.result.admitted.record.verdict).toBe('reviewer_correct');
    expect(outcome.result.confidence).toEqual({
      decisive: true,
      minConfidence: 0.7,
      confidence: 0.86,
      meetsMinConfidence: true,
    });
    expect(outcome.route).toEqual({ kind: 'invocation', result: outcome.result });
    expect(outcome.failure).toBeNull();
    // §10.2 stayed local, and the artifacts the caller may re-persist are named.
    expect(outcome.artifacts.map((a) => a.name).sort()).toEqual(
      [arbitrationArtifactName(LINEAGE), arbitrationBundleArtifactName(LINEAGE)].sort(),
    );
    const written = JSON.parse(readFileSync(join(artifactDir, arbitrationArtifactName(LINEAGE)), 'utf8'));
    expect(written.run.runId).toBe(DERIVED_RUN_ID);
    expect(written.record.rationale).toBe(RATIONALE);
  });

  test('a low-confidence decisive verdict is a result, not a failure', () => {
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ agentRunner: agentRunner(fenced(verdict({ confidence: 0.2 }))) }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('invoked');
    expect(outcome.result.ok).toBe(true);
    expect(outcome.failure).toBeNull();
    expect(outcome.summary.invocation.verdict.meetsMinConfidence).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure normalization
// ---------------------------------------------------------------------------

describe('invocation failures normalize without mutating anything', () => {
  test('a nonzero exit is an `invocation_failed`, and the block is untouched', () => {
    const req = request();
    const before = JSON.parse(JSON.stringify(req.context));
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ agentRunner: agentRunner('boom', [], 3) }),
    );
    const outcome = adapter(req);
    expect(outcome.kind).toBe('invoked');
    expect(outcome.result.ok).toBe(false);
    expect(outcome.failure.kind).toBe('invocation_failed');
    expect(outcome.summary.failure.kind).toBe('invocation_failed');
    expect(req.context).toEqual(before);
    expect(req.context.lineages[LINEAGE].state).toBe('arbitration_pending');
    expect(req.context.lineages[LINEAGE].counters.arbitrationPasses).toBe(0);
  });

  test('a killed arbiter is a `timeout`, not an ordinary failure (issue #953)', () => {
    const adapter = createArbitrationSubTurnAdapter(
      runtime({
        agentRunner: {
          run() {
            return { stdout: '', stderr: 'timed out', exitCode: null, timedOut: true, spawnError: 'timed out' };
          },
        },
      }),
    );
    const outcome = adapter(request());
    expect(outcome.result.ok).toBe(false);
    expect(outcome.summary.invocation.timedOut).toBe(true);
    expect(outcome.failure.kind).toBe('timeout');
  });

  test('output that cannot be admitted is `malformed_output`, with the §12 reason kept', () => {
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ agentRunner: agentRunner('not a verdict at all') }),
    );
    const outcome = adapter(request());
    expect(outcome.failure.kind).toBe('malformed_output');
    expect(outcome.failure.protocol).toBeDefined();
    expect(outcome.summary.invocation.verdict.verdict).toBeNull();
  });

  test('an invocation that throws is a typed internal error, named and nothing more', () => {
    const adapter = createArbitrationSubTurnAdapter(
      runtime({
        invoke: () => {
          throw new TypeError('secret internals');
        },
      }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('not_dispatched');
    expect(outcome.failure).toEqual({ kind: 'internal_error', detail: 'TypeError' });
    expect(JSON.stringify(outcome)).not.toContain('secret internals');
  });
});

// ---------------------------------------------------------------------------
// Bounded output
// ---------------------------------------------------------------------------

describe('bounded metadata and artifact output', () => {
  test('the summary carries names, literals, and counters — no command line, no prose', () => {
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ agentRunner: agentRunner(fenced(verdict())) }),
    );
    const outcome = adapter(request());
    const serialized = JSON.stringify(outcome.summary);
    // The arbiter's rationale stays in the local artifact; only its LENGTH travels.
    expect(serialized).not.toContain(RATIONALE);
    expect(outcome.summary.invocation.verdict.rationaleChars).toBe(RATIONALE.length);
    // The resolved command line is an operator's local invocation, not protocol state.
    expect(serialized).not.toContain('--disallowedTools');
    expect(serialized).not.toContain('argv');
    expect(outcome.summary.profile.cmd).toBeUndefined();
    // Artifacts are BASE names: a separator would make one a path.
    for (const name of [
      outcome.summary.invocation.bundleArtifact,
      outcome.summary.invocation.rawArtifact,
      outcome.summary.invocation.verdictArtifact,
    ]) {
      expect(name).not.toMatch(/[\\/]/);
    }
    // No artifact directory reaches the summary.
    expect(serialized).not.toContain(artifactDir);
    expect(serialized).not.toContain(repoCwd);
  });

  test('the summary is a copy: mutating it cannot reach the resolution or the policy', () => {
    const configured = settings({ providers: ['codex', 'claude'] });
    const adapter = createArbitrationSubTurnAdapter(
      runtime({ settings: configured, review: { agentId: 'claude', model: 'sonnet' }, invoke: recordingInvoke([]) }),
    );
    const outcome = adapter(request());
    expect(outcome.kind).toBe('not_invoked');
    expect(outcome.summary.candidateRejections).toHaveLength(2);
    outcome.summary.candidateRejections[0].reason = 'profile-error';
    outcome.summary.candidateRejections.push({ index: 9, candidate: null, reason: 'profile-error', detail: null });
    outcome.summary.policy.candidates.push('gemini');
    expect(outcome.resolution.rejections).toHaveLength(2);
    expect(outcome.resolution.rejections[0].reason).toBe('unsupported-role');
    expect(configured.arbiter.providers).toEqual(['codex', 'claude']);
  });

  test('the context key names this turn and nothing else', () => {
    expect(REVIEW_DISPUTE_ARBITRATION_CONTEXT_KEY).toBe('reviewDisputeArbitration');
    expect(REVIEW_DISPUTE_ARBITRATION_CONTEXT_KEY).not.toBe(REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY);
  });
});

// ---------------------------------------------------------------------------
// Values only: this module routes nothing
// ---------------------------------------------------------------------------

describe('the routing half stays with #955', () => {
  test('the review phase parks an arbitration turn it was given no runtime for', async () => {
    // This adapter resolves and invokes; it never routes and never registers.
    // Issue #955 supplies the routing half, and the gate dispatches the turn only
    // when its caller passed the §8.2/§8.3 runtime — which this call does not.
    const gate = await runReviewDisputeSubTurn({
      enabled: true,
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
      persisted: context(),
      runId: RUN_ID,
      runtime: {
        issueBody: ISSUE_BODY,
        disputeArtifactDir: disputeDir,
        artifactDir,
        artifactRoot,
        repoCwd,
        agentId: 'claude',
        timestamp: '2026-08-05T03:00:00.000Z',
      },
    });
    expect(gate.kind).toBe('handled');
    expect(gate.result.result).toBe('blocked');
    const summary = gate.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY];
    expect(summary.turn).toBe('runner_arbitration');
    expect(summary.failure).toBe('no_implementation');
  });
});
