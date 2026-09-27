/**
 * Review-dispute release qualification (issue #965;
 * docs/review-dispute-contract.md, docs/review-dispute-operations.md,
 * docs/feature-status.md).
 *
 * Every other suite in this chain — including issue #849's `review-dispute-e2e`
 * — drives the protocol with a FAKE phase handler that returns an
 * already-computed application, and continues a stalled lifecycle by writing the
 * next stage's task context itself. That proves the protocol layers compose; it
 * cannot prove that the phase an operator actually runs reaches them. This suite
 * is the missing half: the REAL review handler and the REAL implementation
 * handler, driven through the real `runNextPhase`, the real TaskStore, and the
 * real §7.1 sub-turn gate, with nothing between the stages but the task the
 * previous run committed.
 *
 * Ground rules:
 *
 *  - **Real handlers only.** `createReviewHandler` and
 *    `createImplementationHandler`, exactly as `run-one-phase` builds them. The
 *    finding that opens a debate is raised by the review handler from a review
 *    agent's structured envelope; the rebuttal is admitted by the implementation
 *    handler from a fix agent's disposition block. Neither is hand-written.
 *  - **No task context is hand-edited between stages.** A stage's inputs are
 *    whatever the previous stage committed. The only operator action any
 *    scenario takes is `recoverHandoff` — the store port `admin recover` uses —
 *    and only after asserting the park it resumes from.
 *  - **Deterministic stub agents.** The phase agents are a stub CommandRunner;
 *    the three §7.1 sub-turn agents are the invocation seams
 *    (`ReviewDisputeSubTurnSeams`), which replace ONE subprocess each and
 *    nothing else — the turn selection, bundle assembly, record admission, §7
 *    routing and transition application all still run. No CLI is spawned, no
 *    network call is made, and no SQLite row is edited by hand.
 *  - **One capability answer, named.** §8.2 makes the runner the enforcement
 *    point of the arbiter's no-tool boundary, and this runner has a verified
 *    no-tools invocation for `claude` alone — which §8.3 then refuses for sharing
 *    a provider with the parties, since those same tables force both parties onto
 *    `claude` too. So the shipping resolver escalates every arbitration through
 *    row 19, which is pinned as its own test, and the scenarios that need to
 *    reach a verdict substitute that ONE resolution (`arbiterCandidateFixture`)
 *    to get at the selection policy underneath it. Nothing else about §8.3 is
 *    faked: the independence measurement, the ordering, the threshold and the
 *    handoff all run.
 *  - **Records are records.** Every §10.2 file a later turn reads is written by
 *    the stub that produced it, in the shape the production invocation writes,
 *    so the re-reads (the rebuttal, the reconsideration, the verdict, the
 *    evidence record and its digest) are the real ones.
 */
import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, runNextPhase } from '../dist/index.js';
import { createReviewHandler } from '../dist/handlers/review.js';
import { createImplementationHandler } from '../dist/handlers/implementation.js';
import {
  REVIEW_FINDINGS_END_MARKER,
  REVIEW_FINDINGS_MARKER,
} from '../dist/core/review-finding-envelope.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS } from '../dist/core/review-dispute.js';
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
} from '../dist/core/review-dispute-commit.js';
import {
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
  REVIEW_DISPUTE_SUB_TURN_EVENT,
} from '../dist/core/review-dispute-dispatch.js';
import {
  arbitrationArtifactName,
  reconsiderationArtifactName,
} from '../dist/core/review-dispute-lineage.js';
import {
  REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY,
  evidenceArtifactName,
} from '../dist/core/review-dispute-evidence-state.js';
import { parseReconsiderationResponse } from '../dist/core/review-reconsideration-response.js';
import { summarizeDisputeStatus } from '../dist/core/review-dispute-status.js';

// Several cases run four or more real phase runs against a real SQLite store;
// Jest's 5s default is a coin flip for that under a parallel run.
jest.setTimeout(120_000);

const SESSION_ID = 'addon-dev';
const ISSUE = 77;
const KEY = { sessionId: SESSION_ID, issueNumber: ISSUE };
const BRANCH = 'ai/issue-77';
const PR_URL = 'https://github.com/m2dw/test-repo/pull/44';
const BOUNDARY = 'src/auth/handler.ts';
const ISSUE_BODY = 'The auth handler must reject a request with no session before it reads any tenant state.';
const RATIONALE = 'RECONSIDERATION-PROSE: the cited middleware guard runs before the handler on every entry path.';
const ARGUMENT = 'REBUTTAL-PROSE: the null session is already rejected by the middleware, so the cited crash cannot occur.';
const VERDICT_RATIONALE = 'ARBITER-PROSE: the acceptance criterion names the handler, not the middleware.';
const NOW = '2026-08-22T09:00:00.000Z';

let tmpDir;
let repoRoot;
let artifactRoot;
let worktree;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dispute-qualification-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  worktree = join(tmpDir, 'wt', SESSION_ID, `issue-${ISSUE}`);
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  // The evidence file every `file` reference cites, in the checkout both the
  // review and the fix run resolve references against.
  mkdirSync(join(worktree, 'src', 'auth'), { recursive: true });
  writeFileSync(
    join(worktree, BOUNDARY),
    `${Array.from({ length: 80 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`,
    'utf8',
  );
  store = new SqliteTaskStore(join(tmpDir, 'tasks.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Session, worktree and lock fixtures
// ---------------------------------------------------------------------------

function baseSession(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    repoKey: 'test-repo',
    repoRoot,
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    artifactRoot,
    githubOwner: 'm2dw',
    githubName: 'test-repo',
    // Both parties on Anthropic — the only provider whose agent this runner has
    // a verified no-tools invocation for, and therefore the only one that can
    // take the reviewer's reconsideration (§8.2, issue #838) or a party's
    // evidence-collection run (#962). §8.3 independence is then a real constraint
    // on the arbiter rather than a formality; see `arbiterCandidateFixture`.
    defaults: { implementationAgent: 'claude', reviewAgent: 'claude', researchAgent: 'gemini' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
}

/**
 * The minimal opt-in of docs/review-dispute-operations.md §1 — one flag and one
 * ordered candidate list — with `codex` as the candidate.
 *
 * `codex` rather than the document's `claude` because the document's example is
 * written for an operator, who cannot change §8.2's capability table, while this
 * suite substitutes exactly one answer from it (`arbiterCandidateFixture`) so the
 * §8.3 policy underneath is measurable. A candidate on a THIRD provider is what
 * makes the independence measurement real: with both parties on Anthropic, a
 * `claude` candidate would be refused by provider overlap and every scenario
 * below would pass for the wrong reason.
 */
function enabledSession(reviewDispute = {}) {
  return baseSession({
    reviewDispute: { enabled: true, arbiter: { providers: ['codex'] }, ...reviewDispute },
  });
}

/**
 * §8.3's candidate-resolution seam, answering for `codex` and nothing else.
 *
 * This is the ONE capability answer the suite substitutes, and it is worth being
 * precise about why, because it is the only place a scenario is not running the
 * shipping decision.
 *
 * §8.2 makes the runner the enforcement point of the arbiter's no-tool boundary,
 * so #839 keeps a capability table of agents it has a *verified* no-tools argv
 * for — and today that table holds `claude` alone, exactly as #838's reviewer
 * table and #962's evidence table do. §8.3 then refuses any candidate sharing a
 * provider with either party. The two rules cross: a session whose parties are
 * Anthropic (the only parties whose own turns can run at all) has no candidate
 * §8.3 can accept, so with the shipping resolver EVERY arbitration escalates
 * through row 19 before any of the policy under test is reached. That is pinned
 * as its own result below — see "the shipping §8.2 capability table" — rather
 * than hidden.
 *
 * Substituting the resolver here buys back the policy layer: candidate order,
 * the independence measurement, `minConfidence`, the verdict routing and the
 * row-19 handoff all run against the parties the debate actually recorded. What
 * it does NOT claim is that this repository can invoke a Codex arbiter; adding
 * that means adding a verified argv to #839's table, which issue #965 explicitly
 * does not do.
 */
const CODEX_ARBITER_PROFILE = {
  agentId: 'codex',
  provider: 'openai',
  cmd: 'codex',
  argv: ['exec'],
  model: 'gpt-5-codex',
  modelSource: 'default',
  effort: 'high',
  effortSource: 'default',
  budgetSource: 'default',
  toolPolicy: 'no-tools',
};

function arbiterCandidateFixture(candidate) {
  return candidate === 'codex'
    ? { ok: true, profile: { ...CODEX_ARBITER_PROFILE } }
    : { ok: false, reason: 'unsupported-role', detail: 'no-no-tools-invocation' };
}

function fakeResolveWorktree(input) {
  return {
    ok: true,
    path: worktree,
    worktreeId: `${input.sessionId}/issue-${input.issueNumber}`,
    branch: input.branch,
    created: false,
    branchReused: true,
  };
}

function fakeLock() {
  return {
    acquire: (ownerId, sessionId, issueNumber) => ({ ok: true, locked: true, contextId: ownerId, sessionId, issueNumber }),
    release: () => ({ ok: true, released: true }),
  };
}

// ---------------------------------------------------------------------------
// The stub agent runner
//
// A dispatching runner rather than a fixed step queue: a review run that ends in
// a sub-turn issues a different (and deliberately shorter) command sequence than
// one that reaches the review agent, and pinning positions here would make the
// suite fail on orchestration order rather than on protocol behavior.
// ---------------------------------------------------------------------------

const PR_VIEW_JSON = JSON.stringify({
  number: 44,
  url: PR_URL,
  headRefName: BRANCH,
  baseRefName: 'main',
  state: 'OPEN',
  isCrossRepository: false,
});
const PR_LIST_JSON = JSON.stringify([{ number: 44, url: PR_URL, headRefName: BRANCH }]);
const TRACKED_INDEX = `100644 1111111111111111111111111111111111111111 0\t${BOUNDARY}\n`;
const DIFF_TEXT = `diff --git a/${BOUNDARY} b/${BOUNDARY}\n+// changed`;

/** The agent executables this suite ever configures. */
const AGENT_CMDS = new Set(['claude', 'codex', 'gemini']);

function stubRunner({ agentOutput = 'No blocking issues.', diffStat = '1 file changed', stageable = '' } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const result = respond(cmd, args ?? []);
    return result;
  };
  const respond = (cmd, args) => {
    const ok = (stdout) => ({ stdout, stderr: '', exitCode: 0 });
    if (AGENT_CMDS.has(cmd)) return ok(agentOutput);
    if (cmd === 'npm') return ok('All tests passed.');
    if (cmd === 'gh') {
      if (args.includes('view')) return ok(PR_VIEW_JSON);
      if (args.includes('list')) return ok(PR_LIST_JSON);
      return ok('');
    }
    if (cmd === 'git') {
      switch (args[0]) {
        case 'rev-list':
          return ok('0');
        case 'rev-parse':
          return ok(`refs/heads/${BRANCH}`);
        case 'diff':
          return ok(args.includes('--stat') ? diffStat : DIFF_TEXT);
        case 'ls-files':
          if (args.includes('-z')) return ok(stageable);
          if (args.includes('--others')) return ok('');
          return ok(TRACKED_INDEX);
        default:
          return ok('');
      }
    }
    return ok('');
  };
  return {
    calls,
    run,
    agentCalls: () => calls.filter((c) => AGENT_CMDS.has(c.cmd)),
  };
}

// ---------------------------------------------------------------------------
// §10.2 record fixtures the sub-turn stubs write
// ---------------------------------------------------------------------------

function recordEnvelope(record) {
  return JSON.stringify({ record }, null, 2);
}

function writeRecord(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, 'utf8');
}

/**
 * #838's bounded summary, as the real invocation returns it. The adapter reads
 * it for the audit line only, so every field is either derived from the input or
 * a fixed literal.
 */
function reconsiderationSummary(input, outcome, overrides = {}) {
  const { lineageId, version } = input.pending;
  return {
    lineageId,
    version,
    runKey: `${lineageId}@${version}#${input.run.runId}`,
    bundleDigest: 'a1b2c3d4e5f6',
    promptBytes: 4096,
    rawOutputBytes: 512,
    rawArtifact: `reconsideration-raw-${lineageId}.txt`,
    stderrArtifact: null,
    runnerErrorArtifact: null,
    recordArtifact: reconsiderationArtifactName(lineageId),
    excerpts: 1,
    unresolvedExcerpts: 0,
    exitCode: 0,
    profile: {
      phase: 'review',
      role: 'reconsideration',
      agentId: input.agentId ?? 'claude',
      cmd: 'claude',
      argv: ['-p'],
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
 * A reviewer sub-turn stub that answers with ONE record — admitted by the real
 * #838 parser against the block the gate handed it, so no scenario can walk a
 * path the contract would never have produced — and writes the §10.2 record file
 * a later evidence or arbitration turn re-reads.
 */
function reconsiderationStub(build, calls = []) {
  return (input) => {
    calls.push(input);
    const { lineageId, version } = input.pending;
    const record = { lineageId, version, rationale: RATIONALE, ...build({ lineageId, version }) };
    const outcome = parseReconsiderationResponse({
      response: `\`\`\`json\n${JSON.stringify(record)}\n\`\`\``,
      pending: { lineageId, version },
      lineages: input.context.lineages,
      resolveEvidenceRef: () => true,
      limits: input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    if (outcome.admitted === null) {
      throw new Error(`reconsideration fixture not admitted: ${JSON.stringify(outcome.failure)}`);
    }
    const name = reconsiderationArtifactName(lineageId);
    const content = recordEnvelope(record);
    writeRecord(input.artifactDir, name, content);
    return {
      ok: true,
      admitted: outcome.admitted,
      artifacts: [{ name, content }],
      summary: reconsiderationSummary(input, outcome),
    };
  };
}

const DECISIVE_VERDICTS = ['reviewer_correct', 'implementer_correct'];

function arbitrationSummary(input, { verdict = null, failure = null, timedOut = false, exitCode = 0 } = {}) {
  const profile = input.selection.profile;
  const meets = verdict === null || !DECISIVE_VERDICTS.includes(verdict.verdict)
    || verdict.confidence >= profile.minConfidence;
  return {
    lineageId: input.pending.lineageId,
    version: input.pending.version,
    runKey: `${input.pending.lineageId}@${input.pending.version}#${input.run.runId}`,
    bundleDigest: 'deadbeefcafe',
    promptBytes: 512,
    bundleEntries: 4,
    rawOutputBytes: 128,
    bundleArtifact: 'arbitration-bundle.json',
    rawArtifact: 'arbitration-raw.txt',
    stderrArtifact: null,
    runnerErrorArtifact: null,
    verdictArtifact: verdict === null ? null : arbitrationArtifactName(input.pending.lineageId),
    excerpts: 2,
    unresolvedExcerpts: 0,
    exitCode,
    timedOut,
    durationMs: 1200,
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
    verdict:
      verdict === null
        ? null
        : {
            lineageId: verdict.lineageId,
            version: verdict.version,
            verdict: verdict.verdict,
            confidence: verdict.confidence,
            decisive: DECISIVE_VERDICTS.includes(verdict.verdict),
            minConfidence: profile.minConfidence,
            meetsMinConfidence: meets,
            rationaleChars: verdict.rationale.length,
            ignoredFindingShapedFields: [],
          },
    failure,
  };
}

/**
 * A runner (arbitration) sub-turn stub. The verdict is #846's already-admitted
 * record; the confidence routing is computed from the SELECTED profile's own
 * threshold rather than a constant, so a scenario cannot disagree with the
 * policy under test. The verdict file is written because §7.1's row-16 evidence
 * turn re-presents it.
 */
function arbitrationStub(build, calls = []) {
  return (input) => {
    calls.push(input);
    const { lineageId, version } = input.pending;
    const record = {
      lineageId,
      version,
      verdict: 'reviewer_correct',
      confidence: 0.9,
      rationale: VERDICT_RATIONALE,
      ...build({ lineageId, version, attempt: calls.length }),
    };
    const profile = input.selection.profile;
    const name = arbitrationArtifactName(lineageId);
    const content = recordEnvelope(record);
    writeRecord(input.artifactDir, name, content);
    return {
      ok: true,
      admitted: { record, lineage: input.context.lineages[lineageId], ignoredFindingShapedFields: [] },
      confidence: {
        decisive: DECISIVE_VERDICTS.includes(record.verdict),
        minConfidence: profile.minConfidence,
        confidence: record.confidence,
        meetsMinConfidence:
          !DECISIVE_VERDICTS.includes(record.verdict) || record.confidence >= profile.minConfidence,
      },
      bundle: { entries: [], digest: 'deadbeefcafe' },
      artifacts: [{ name, content }],
      summary: arbitrationSummary(input, { verdict: record }),
    };
  };
}

/** A runner (arbitration) sub-turn stub that answers with one typed failure. */
function arbitrationFailureStub(failure, calls = []) {
  return (input) => {
    calls.push(input);
    return {
      ok: false,
      failure,
      bundle: null,
      artifacts: [],
      summary: arbitrationSummary(input, { failure, exitCode: 1 }),
    };
  };
}

/**
 * An evidence-collection stub for ONE party, in #962's typed result shape.
 *
 * It writes the per-party §10.2 record file with the SAME bytes it returns as an
 * artifact, because the follow-up arbitration admits that file only against the
 * digest the round recorded — which is the #964 regression this suite pins.
 */
function evidenceStub(calls = [], { attachments = 1 } = {}) {
  return (input) => {
    calls.push(input);
    const party = input.party;
    const lineageId = input.bundle.lineages[0].lineageId;
    const version = input.bundle.lineages[0].version;
    const ref = { kind: 'file', path: BOUNDARY, startLine: party === 'implementer' ? 40 : 50, endLine: party === 'implementer' ? 44 : 54 };
    const references = attachments === 0 ? [] : [ref];
    const record = {
      party,
      lineageId,
      version,
      round: input.run.round ?? 1,
      attempt: input.run.attempt ?? 1,
      runKey: `${lineageId}@${version}/e1:${party}.0#${input.run.runId}`,
      run: { runId: input.run.runId, agentId: 'claude', timestamp: input.run.timestamp ?? NOW },
      profile: { agentId: 'claude', provider: 'anthropic', toolPolicy: 'no-tools' },
      bundleDigest: 'd'.repeat(64),
      answered: true,
      attachments: references.length,
      references,
      dropped: [],
      ignored: [],
      rejected: [],
      envelopeFailure: null,
    };
    const name = evidenceArtifactName(party, lineageId, 'record');
    const content = JSON.stringify(record, null, 2);
    writeRecord(input.artifactDir, name, content);
    return {
      outcome: 'completed',
      collection: {
        party,
        attachments: references.length === 0 ? {} : { [lineageId]: references.length },
        references: references.length === 0 ? {} : { [lineageId]: references },
        dropped: {},
        ignored: [],
        rejected: [],
        droppedRefs: [],
        envelopeFailure: null,
        summary: {
          party,
          asked: 1,
          answered: 1,
          admitted: references.length,
          dropped: 0,
          ignoredFields: 0,
          rejectedRecords: 0,
          unansweredLineageIds: [],
          failure: null,
        },
      },
      artifacts: [{ name, content }],
      failure: null,
      summary: {
        party,
        runId: input.run.runId,
        attempt: input.run.attempt ?? 1,
        round: input.run.round ?? 1,
        runKeys: { [lineageId]: record.runKey },
        askedLineageIds: [lineageId],
        bundleDigest: 'd'.repeat(64),
        promptBytes: 1000,
        rawOutputBytes: 100,
        exitCode: 0,
        timedOut: false,
        durationMs: 600,
        artifacts: {},
        profile: {
          agentId: 'claude',
          provider: 'anthropic',
          modelSource: 'default',
          effortSource: 'default',
          toolPolicy: 'no-tools',
          agentSource: 'assignment',
        },
        evidence: null,
        outcome: 'completed',
        failure: null,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// The review agent's structured envelope
// ---------------------------------------------------------------------------

const FINDING = {
  version: 1,
  severity: 'P1',
  violatedContract: 'Acceptance criterion: the handler must reject a request with no session',
  preconditions: 'A request arrives with no session cookie',
  failureScenario: 'FINDING-PROSE: the handler dereferences a null session and crashes the process',
  affectedBoundary: BOUNDARY,
  requiredOutcome: 'An unauthenticated request is rejected with 401 before any state read',
  evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 40, endLine: 44 }],
};

function envelope(body) {
  return `${REVIEW_FINDINGS_MARKER}\n${JSON.stringify(body)}\n${REVIEW_FINDINGS_END_MARKER}`;
}

const FINDINGS_OUTPUT = envelope({ version: 1, status: 'findings', findings: [FINDING] });
const CLEAN_OUTPUT = envelope({ version: 1, status: 'success' });

/** A fix agent's §3.1 disposition block. */
function dispositionBlock(records) {
  return `Here are my dispositions.\n\n\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\`\n`;
}

function disputeDisposition(lineageId, version = 1) {
  return {
    lineageId,
    version,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId, version },
      rebuttalReason: 'false_premise',
      argument: ARGUMENT,
      evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 30, endLine: 36 }],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
  };
}

/** §3.1: a `fixed` disposition is only admissible from a run that changed files. */
function fixedDisposition(lineageId, version = 1) {
  return {
    lineageId,
    version,
    disposition: 'fixed',
    note: 'Added the missing null-session rejection on the direct-dispatch path.',
  };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

let clock = 0;
function nextNow() {
  clock += 1;
  return `2026-08-22T09:${String(clock).padStart(2, '0')}:00.000Z`;
}

beforeEach(() => {
  clock = 0;
});

async function enqueueReview(extraContext = {}) {
  await store.enqueueTask({
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    phase: 'review',
    priority: 'normal',
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      body: ISSUE_BODY,
      prUrl: PR_URL,
      branch: BRANCH,
      labels: ['agent:claude', 'status:needs-review'],
      ...extraContext,
    },
    now: NOW,
  });
}

/**
 * One REAL phase run: the actual handler, through the actual phase runner,
 * against the actual store. Nothing about the task is written here —
 * `runNextPhase` owns every write.
 */
/**
 * The `codex exec` subprocess of the §17.11 routed lane (issue #1069).
 *
 * Defaulted for EVERY review run, not just the codex-reviewer scenarios, and
 * that is deliberate: the adapter owns its own subprocess seam and its
 * production default spawns the real CLI, so a scenario that flipped the
 * reviewer to `codex` without noticing would spawn — and possibly bill — a live
 * Codex turn. Writing the final message where `--output-last-message` says to is
 * the one part of the CLI contract the handler depends on; everything else on
 * the path (argv, prompt, temp directory, bounded read) stays production.
 */
function structuredCodexStub(agentOutput) {
  return {
    run(_cmd, args) {
      const at = args.indexOf('--output-last-message');
      if (at !== -1) writeFileSync(args[at + 1], agentOutput, 'utf8');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

async function runPhase(phase, { runId, session = enabledSession(), seams = {}, ...runnerOptions } = {}) {
  const runner = stubRunner(runnerOptions);
  const context = { session, runId, workerId: 'worker-test' };
  const handler =
    phase === 'review'
      ? createReviewHandler(context, runner, fakeResolveWorktree, fakeLock(), undefined, undefined, {
          // The §8.3 capability answer, defaulted so every scenario measures the
          // policy rather than the table. A scenario that wants the SHIPPING
          // table passes `resolveArbiterCandidate: undefined` explicitly — the
          // handler falls back to the real resolver on an absent value.
          resolveArbiterCandidate: arbiterCandidateFixture,
          structuredReviewRunner: structuredCodexStub(runnerOptions.agentOutput ?? 'No blocking issues.'),
          ...seams,
        })
      : createImplementationHandler(context, runner, undefined, fakeResolveWorktree);
  const outcome = await runNextPhase({
    store,
    request: { sessionId: SESSION_ID, workerId: 'worker-test', runId, supportedPhases: [phase], now: nextNow() },
    handlers: { [phase]: handler },
    now: nextNow(),
  });
  // `PhaseRunOutcome.result` is the handler's whole result object; the token the
  // scenarios assert on is its `result` field, surfaced here so a run that never
  // reached the handler (a lost claim, a paused session) is visible as itself
  // rather than as `undefined`.
  const result =
    outcome.status === 'completed' || outcome.status === 'delayed' ? outcome.result.result : outcome.status;
  return { outcome, runner, result, task: await store.getTask(KEY) };
}

function blockOf(task) {
  return task.context[REVIEW_DISPUTE_CONTEXT_KEY];
}

function onlyLineageId(task) {
  const ids = Object.keys(blockOf(task).lineages);
  expect(ids).toHaveLength(1);
  return ids[0];
}

async function transitionEvents() {
  const events = await store.listEvents(KEY);
  return events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
}

async function subTurnEvents() {
  const events = await store.listEvents(KEY);
  return events.filter((e) => e.type === REVIEW_DISPUTE_SUB_TURN_EVENT);
}

/** The supported operator continuation, and only after the park is asserted. */
async function recover(phase) {
  const before = await store.getTask(KEY);
  expect(before.status).toBe('ready_for_human');
  const result = await store.recoverHandoff(KEY, { fromStatus: 'ready_for_human', phase, now: nextNow() });
  expect(result.ok).toBe(true);
  return result.value;
}

// ---------------------------------------------------------------------------
// Composite stages, each of them REAL runs
// ---------------------------------------------------------------------------

/** Stage 1: the review agent raises one blocking finding. */
async function raiseFinding({ session = enabledSession(), runId = 'run-review-1' } = {}) {
  await enqueueReview();
  const { outcome, task, runner } = await runPhase('review', { runId, session, agentOutput: FINDINGS_OUTPUT });
  expect(outcome.status).toBe('completed');
  return { task, runner };
}

/** Stage 2: the fix agent answers the finding. */
async function fixRunAnswers(records, { runId = 'run-impl-2', session = enabledSession(), ...runnerOptions } = {}) {
  const { outcome, task, runner } = await runPhase('implementation', {
    runId,
    session,
    agentOutput: dispositionBlock(records),
    ...runnerOptions,
  });
  expect(outcome.status).toBe('completed');
  return { task, runner };
}

/** Stages 1–2, ending with one `disputed` lineage the implementer rebutted. */
async function openDispute({ session = enabledSession() } = {}) {
  const raised = await raiseFinding({ session });
  const lineageId = onlyLineageId(raised.task);
  expect(blockOf(raised.task).lineages[lineageId].state).toBe('open');
  expect(raised.task.phase).toBe('implementation');

  const { task } = await fixRunAnswers([disputeDisposition(lineageId)], {
    session,
    // A rebuttal is a zero-change run: nothing was edited, so nothing is staged.
    diffStat: '',
    stageable: '',
  });
  expect(blockOf(task).lineages[lineageId].state).toBe('disputed');
  // §7.1 rule 2 names the reviewer's turn, and the review phase dispatches it.
  expect(task).toMatchObject({ status: 'queued', phase: 'review' });
  return { task, lineageId };
}

// ===========================================================================
// 1. The gate: default-off is the legacy path
// ===========================================================================

describe('gate qualification — a session that has not opted in', () => {
  test('an omitted `reviewDispute` block and an explicit `enabled: false` behave identically', async () => {
    const omitted = baseSession();
    const explicit = baseSession({ reviewDispute: { enabled: false } });
    const results = [];
    for (const session of [omitted, explicit]) {
      await store.close();
      store = new SqliteTaskStore(join(tmpDir, `tasks-${results.length}.db`));
      await enqueueReview();
      const { task, result } = await runPhase('review', {
        runId: 'run-review-1',
        session,
        agentOutput: FINDINGS_OUTPUT,
      });
      results.push({ result, status: task.status, phase: task.phase, context: task.context });
    }
    const [a, b] = results;
    expect(a.result).toBe(b.result);
    expect(a.status).toBe(b.status);
    expect(a.phase).toBe(b.phase);
    // The envelope the reviewer emitted is not even read: a `[P1]`-free prose
    // classification is what decides the run, exactly as before the protocol.
    for (const one of results) {
      expect(one.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
      expect(one.context.reviewFindings).toBeUndefined();
      expect(one.context.reviewDisputeParties).toBeUndefined();
    }
    expect(await transitionEvents()).toHaveLength(0);
  });

  test('a disabled session with a persisted debate runs the ordinary review and changes nothing', async () => {
    // The debate is produced by REAL enabled runs first, then the very next run
    // is made under a disabled session — the rollback an operator performs.
    const { task, lineageId } = await openDispute();
    const before = JSON.parse(JSON.stringify(blockOf(task)));
    const eventsBefore = (await transitionEvents()).length;

    const reconsiderations = [];
    const { task: after, runner } = await runPhase('review', {
      runId: 'run-review-3',
      session: baseSession({ reviewDispute: { enabled: false } }),
      agentOutput: 'No blocking issues.',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'withdraw' }), reconsiderations) },
    });

    // No sub-turn agent was invoked, and the ordinary review agent was.
    expect(reconsiderations).toHaveLength(0);
    expect(runner.agentCalls()).toHaveLength(1);
    // The audit state is preserved, not deleted and not migrated.
    expect(blockOf(after)).toEqual(before);
    expect(blockOf(after).lineages[lineageId].state).toBe('disputed');
    expect((await transitionEvents()).length).toBe(eventsBefore);
    expect(await subTurnEvents()).toHaveLength(0);
  });

  test('re-enabling after a rollback resumes the same debate from the same state', async () => {
    const { lineageId } = await openDispute();
    await runPhase('review', {
      runId: 'run-review-3',
      session: baseSession({ reviewDispute: { enabled: false } }),
      agentOutput: 'No blocking issues.',
    });
    // The disabled review finished the task; the operator hands it back to review.
    const resumed = await store.getTask(KEY);
    if (resumed.status !== 'queued') await recover('review');

    const calls = [];
    const { task } = await runPhase('review', {
      runId: 'run-review-4',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'withdraw' }), calls) },
    });
    expect(calls).toHaveLength(1);
    expect(blockOf(task).lineages[lineageId].state).toBe('resolved_withdrawn');
  });
});

// ===========================================================================
// 2. The gate: an enabled but unusable configuration fails closed
// ===========================================================================

describe('gate qualification — an enabled configuration that cannot be resolved', () => {
  test('a malformed limit fails the review before any agent runs, with an actionable diagnostic', async () => {
    await enqueueReview();
    const { result, task, runner } = await runPhase('review', {
      runId: 'run-review-1',
      session: enabledSession({ limits: { maxVersionsPerLineage: 0 } }),
      agentOutput: FINDINGS_OUTPUT,
    });
    expect(result).toBe('failed');
    expect(runner.agentCalls()).toHaveLength(0);
    expect(task.context.reviewDisputeConfigError.paths).toContain('reviewDispute.limits.maxVersionsPerLineage');
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
  });

  test('the same malformed limit fails the fix run rather than degrading to the contract maxima', async () => {
    // The asymmetry this closes (issue #965): review already failed closed here,
    // while the fix run fell back to `REVIEW_DISPUTE_DEFAULT_LIMITS` and carried
    // on — so a session that meant to LOWER a §6.1 limit and got the value wrong
    // had its dispositions admitted at the contract maximum instead. Silently
    // running at a bound nobody chose is the enforcement bypass the gate exists
    // to prevent, and it is worse here than in review, because this is the phase
    // that writes lineage state.
    const { task: raised } = await raiseFinding();
    expect(raised.phase).toBe('implementation');
    const lineageId = onlyLineageId(raised);
    const { result, task, runner } = await runPhase('implementation', {
      runId: 'run-impl-2',
      session: enabledSession({ limits: { maxVersionsPerLineage: 0 } }),
      agentOutput: dispositionBlock([fixedDisposition(lineageId)]),
    });
    expect(result).toBe('failed');
    // Before the fix agent, and with the same bounded diagnostic review writes.
    expect(runner.agentCalls()).toHaveLength(0);
    expect(task.context.reviewDisputeConfigError.paths).toContain('reviewDispute.limits.maxVersionsPerLineage');
    // And the debate is exactly where the review left it: nothing was admitted.
    expect(blockOf(task).lineages[lineageId].state).toBe('open');
  });

  test('an enabled session with no arbiter candidate escalates rather than substituting one', async () => {
    // Not a configuration error: §8.3 says an empty candidate list is a real
    // setting whose consequence is that every arbitration escalates (row 19).
    const session = enabledSession({ arbiter: { providers: [] } });
    const { lineageId } = await openDispute({ session });
    const { task: upheld } = await runPhase('review', {
      runId: 'run-review-3',
      session,
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    expect(blockOf(upheld).lineages[lineageId].state).toBe('arbitration_pending');

    const calls = [];
    const { task } = await runPhase('review', {
      runId: 'run-review-4',
      session,
      seams: { arbitration: arbitrationStub(() => ({}), calls) },
    });
    // No arbiter was invoked, and no counter was spent buying one.
    expect(calls).toHaveLength(0);
    expect(blockOf(task).lineages[lineageId].state).toBe('escalated_human');
    expect(task.status).toBe('ready_for_human');
  });

  test('the shipping §8.2 capability table leaves an Anthropic-reviewed debate with no arbiter', async () => {
    // The other half of `arbiterCandidateFixture`, and the honest limit of what
    // this release qualifies. Nothing is stubbed here: the handler resolves its
    // own candidates.
    //
    // `codex` is a configured, spelled-correctly, provider-independent candidate.
    // It is still refused, because §8.2 makes the runner the enforcement point of
    // the arbiter's no-tool boundary and this runner has a verified no-tools argv
    // for `claude` alone (`unsupported-role: no-no-tools-invocation`). A `claude`
    // candidate would resolve and then be refused by §8.3 for sharing Anthropic
    // with both parties — and `allowSameProvider` cannot rescue it either, since a
    // party recovered from task context carries an agent id with no model and an
    // unknown model is not proof of difference.
    //
    // So for the only party configuration whose own §7.1 turns can run, every
    // arbitration escalates through row 19 today. That is fail-closed, bounded and
    // reported — never a default win for either party — but it is the reason
    // docs/feature-status.md promotes this feature to `config-gated` and not to
    // `available`.
    const session = enabledSession();
    const { lineageId } = await openDispute({ session });
    await runPhase('review', {
      runId: 'run-review-3',
      session,
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    const calls = [];
    const { task } = await runPhase('review', {
      runId: 'run-review-4',
      session,
      seams: {
        resolveArbiterCandidate: undefined,
        arbitration: arbitrationStub(() => ({ verdict: 'reviewer_correct', confidence: 0.99 }), calls),
      },
    });
    expect(calls).toHaveLength(0);
    expect(blockOf(task).lineages[lineageId].state).toBe('escalated_human');
    expect(task.status).toBe('ready_for_human');
    // The stop is reported as a terminal escalation, not as an unrunnable turn.
    const status = summarizeDisputeStatus(task, await store.listEvents(KEY));
    expect(status.nextAction.authorized).toBe(false);
  });
});

// ===========================================================================
// 3. The real-handler lifecycle matrix
// ===========================================================================

describe('real-handler lifecycles — the implementer answers the finding', () => {
  test('a fixed finding returns through an ordinary re-review and closes the loop', async () => {
    const { task: raised } = await raiseFinding();
    const lineageId = onlyLineageId(raised);

    const { task: fixed } = await fixRunAnswers([fixedDisposition(lineageId)], { stageable: `${BOUNDARY}\0` });
    expect(blockOf(fixed).lineages[lineageId].state).toBe('resolved_fixed');
    expect(fixed).toMatchObject({ status: 'queued', phase: 'review' });

    // No debate is open, so this is an ordinary review — the review agent runs.
    const calls = [];
    const { result, task, runner } = await runPhase('review', {
      runId: 'run-review-3',
      agentOutput: CLEAN_OUTPUT,
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'withdraw' }), calls) },
    });
    expect(calls).toHaveLength(0);
    expect(runner.agentCalls()).toHaveLength(1);
    expect(result).toBe('success');
    expect(task.status).toBe('ready_for_human');
  });

  test('a dispute followed by the reviewer withdrawing resolves without the review agent', async () => {
    const { lineageId } = await openDispute();
    const calls = [];
    const { outcome, task, runner } = await runPhase('review', {
      runId: 'run-review-3',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'withdraw' }), calls) },
    });
    expect(outcome.status).toBe('completed');
    expect(calls).toHaveLength(1);
    // The reviewer's turn is NOT an ordinary review: no review agent ran.
    expect(runner.agentCalls()).toHaveLength(0);
    expect(blockOf(task).lineages[lineageId].state).toBe('resolved_withdrawn');
    expect((await transitionEvents()).length).toBeGreaterThan(0);
  });

  test('a dispute the reviewer upholds reaches arbitration and a decisive `reviewer_correct` binds it', async () => {
    const { lineageId } = await openDispute();
    const { task: upheld } = await runPhase('review', {
      runId: 'run-review-3',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    expect(blockOf(upheld).lineages[lineageId].state).toBe('arbitration_pending');
    expect(upheld).toMatchObject({ status: 'queued', phase: 'review' });

    const calls = [];
    const { task, runner } = await runPhase('review', {
      runId: 'run-review-4',
      seams: { arbitration: arbitrationStub(() => ({ verdict: 'reviewer_correct', confidence: 0.92 }), calls) },
    });
    expect(calls).toHaveLength(1);
    expect(runner.agentCalls()).toHaveLength(0);
    expect(blockOf(task).lineages[lineageId].state).toBe('binding');
    // A binding finding is the implementer's to fix — and it may no longer be
    // disputed, which the fix handler enforces from the block alone.
    expect(task.phase).toBe('implementation');

    const { task: after } = await fixRunAnswers([fixedDisposition(lineageId)], {
      runId: 'run-impl-5',
      stageable: `${BOUNDARY}\0`,
    });
    expect(blockOf(after).lineages[lineageId].state).toBe('resolved_fixed');
  });

  test('a decisive `implementer_correct` overrules the finding instead of binding it', async () => {
    const { lineageId } = await openDispute();
    await runPhase('review', {
      runId: 'run-review-3',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    const { task } = await runPhase('review', {
      runId: 'run-review-4',
      seams: { arbitration: arbitrationStub(() => ({ verdict: 'implementer_correct', confidence: 0.95 })) },
    });
    expect(blockOf(task).lineages[lineageId].state).toBe('resolved_overruled');
  });

  test('a material revision opens version 2 and hands the finding back to the implementer', async () => {
    const { lineageId } = await openDispute();
    const { task } = await runPhase('review', {
      runId: 'run-review-3',
      seams: {
        reconsideration: reconsiderationStub(({ version }) => ({
          reconsideration: 'revise',
          revision: {
            predecessorVersion: version,
            changedFields: ['preconditions'],
            revisionKind: 'corrected_premise',
            materialityClaim: true,
            successor: {
              ...FINDING,
              version: version + 1,
              preconditions: 'Any caller may reach the handler directly, bypassing the middleware.',
            },
          },
        })),
      },
    });
    const lineage = blockOf(task).lineages[lineageId];
    expect(lineage).toMatchObject({ state: 'open', version: 2 });
    expect(task.phase).toBe('implementation');
  });

  test('a non-material revision is not a new version and does not re-open the debate', async () => {
    const { lineageId } = await openDispute();
    const { task } = await runPhase('review', {
      runId: 'run-review-3',
      seams: {
        reconsideration: reconsiderationStub(({ version }) => ({
          reconsideration: 'revise',
          revision: {
            predecessorVersion: version,
            // §5 "never material: severity-only changes". The successor is still
            // PROPOSED as the next version; row 12 is what declines to open it.
            changedFields: ['severity'],
            revisionKind: 'restated',
            materialityClaim: false,
            successor: { ...FINDING, version: version + 1, severity: 'P2' },
          },
        })),
      },
    });
    const lineage = blockOf(task).lineages[lineageId];
    expect(lineage.version).toBe(1);
    expect(['arbitration_pending', 'disputed']).toContain(lineage.state);
  });
});

// ===========================================================================
// 4. Human handoffs stop, deterministically
// ===========================================================================

describe('real-handler lifecycles — human handoffs', () => {
  async function arbitrate(build, { runId = 'run-review-4', session = enabledSession(), calls = [] } = {}) {
    const { lineageId } = await openDispute({ session });
    await runPhase('review', {
      runId: 'run-review-3',
      session,
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    const { task, outcome } = await runPhase('review', {
      runId,
      session,
      seams: { arbitration: arbitrationStub(build, calls) },
    });
    return { task, outcome, lineageId, calls };
  }

  test('`spec_ambiguous` escalates to a human and nothing nudges it onwards', async () => {
    const { task, lineageId } = await arbitrate(() => ({ verdict: 'spec_ambiguous', confidence: 0.99 }));
    expect(blockOf(task).lineages[lineageId].state).toBe('escalated_human');
    expect(task.status).toBe('ready_for_human');
    const status = summarizeDisputeStatus(task, await store.listEvents(KEY));
    // §15 G1: an escalated lineage has no automated way back, and the operator
    // surface says so rather than offering one.
    expect(status.nextAction.authorized).toBe(false);
    expect(status.reopenEligibleLineageIds).not.toContain(lineageId);
  });

  test('a decisive verdict below `minConfidence` decides nothing and escalates', async () => {
    const session = enabledSession({ arbiter: { providers: ['codex'], minConfidence: 0.9 } });
    const { task, lineageId } = await arbitrate(
      () => ({ verdict: 'reviewer_correct', confidence: 0.7 }),
      { session },
    );
    expect(blockOf(task).lineages[lineageId].state).toBe('escalated_human');
  });

  test('a malformed arbiter response is retried, and the cap escalates rather than looping', async () => {
    const session = enabledSession();
    const { lineageId } = await openDispute({ session });
    await runPhase('review', {
      runId: 'run-review-3',
      session,
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });

    const calls = [];
    const malformed = arbitrationFailureStub({ kind: 'malformed-response', detail: 'verdict:absent' }, calls);
    let task;
    let attempts = 0;
    // Each malformed answer spends one §6.1 attempt; the lineage stays pending
    // until the cap, and the cap escalates. The loop is bounded by the cap plus
    // one, so a lineage that never escalated would fail this test rather than
    // spin.
    const cap = REVIEW_DISPUTE_DEFAULT_LIMITS.maxMalformedArbiterAttemptsPerLineage;
    while (attempts < cap + 1) {
      attempts += 1;
      const current = await store.getTask(KEY);
      if (current.status === 'ready_for_human') await recover('review');
      const run = await runPhase('review', {
        runId: `run-review-arb-${attempts}`,
        session,
        seams: { arbitration: malformed },
      });
      task = run.task;
      if (blockOf(task).lineages[lineageId].state === 'escalated_human') break;
    }
    expect(blockOf(task).lineages[lineageId].state).toBe('escalated_human');
    expect(calls.length).toBe(cap);
    expect(blockOf(task).lineages[lineageId].counters.malformedArbiterAttempts).toBe(cap);
  });
});

// ===========================================================================
// 5. The evidence round — the #964 regression, end to end
// ===========================================================================

describe('real-handler lifecycles — the bounded evidence round', () => {
  async function toEvidenceRequested(session = enabledSession()) {
    const { lineageId } = await openDispute({ session });
    await runPhase('review', {
      runId: 'run-review-3',
      session,
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    const { task } = await runPhase('review', {
      runId: 'run-review-4',
      session,
      seams: { arbitration: arbitrationStub(() => ({ verdict: 'insufficient_evidence', confidence: 0.8 })) },
    });
    expect(blockOf(task).lineages[lineageId].state).toBe('evidence_requested');
    return { lineageId, task };
  }

  test('an `insufficient_evidence` verdict opens one round, collects both parties, and re-arbitrates WITH the evidence', async () => {
    const { lineageId } = await toEvidenceRequested();

    // One party per phase run, selected from the persisted round record — not
    // from anything this test says.
    const first = [];
    const { task: afterFirst } = await runPhase('review', {
      runId: 'run-review-5',
      seams: { evidence: evidenceStub(first) },
    });
    expect(first).toHaveLength(1);
    expect(first[0].party).toBe('implementer');
    const round = afterFirst.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY];
    expect(round.lineages[lineageId].parties.implementer).toBeDefined();
    expect(round.lineages[lineageId].parties.reviewer).toBeUndefined();
    // The round is still open, so the lineage has not moved.
    expect(blockOf(afterFirst).lineages[lineageId].state).toBe('evidence_requested');

    const second = [];
    if ((await store.getTask(KEY)).status === 'ready_for_human') await recover('review');
    const { task: afterSecond } = await runPhase('review', {
      runId: 'run-review-6',
      seams: { evidence: evidenceStub(second) },
    });
    expect(second).toHaveLength(1);
    expect(second[0].party).toBe('reviewer');
    // Row 22: both parties answered, so the round closes and the lineage returns
    // to arbitration with the round spent.
    expect(blockOf(afterSecond).lineages[lineageId]).toMatchObject({
      state: 'arbitration_pending',
      counters: expect.objectContaining({ evidenceRoundsUsed: 1 }),
    });

    // The regression (#964 review, P1): the follow-up arbitration must be given
    // what the round collected, not re-asked the question that opened it.
    const calls = [];
    if ((await store.getTask(KEY)).status === 'ready_for_human') await recover('review');
    const { task: decided } = await runPhase('review', {
      runId: 'run-review-7',
      seams: { arbitration: arbitrationStub(() => ({ verdict: 'reviewer_correct', confidence: 0.93 }), calls) },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].evidenceRoundAttachments ?? []).toHaveLength(2);
    expect((calls[0].evidenceRoundAttachments ?? []).map((a) => a.party).sort()).toEqual([
      'implementer',
      'reviewer',
    ]);
    expect(blockOf(decided).lineages[lineageId].state).toBe('binding');
  });

  test('a second `insufficient_evidence` with the round spent escalates instead of asking again', async () => {
    const { lineageId } = await toEvidenceRequested();
    for (const [runId, party] of [['run-review-5', 'implementer'], ['run-review-6', 'reviewer']]) {
      if ((await store.getTask(KEY)).status === 'ready_for_human') await recover('review');
      const calls = [];
      await runPhase('review', { runId, seams: { evidence: evidenceStub(calls) } });
      expect(calls[0].party).toBe(party);
    }
    if ((await store.getTask(KEY)).status === 'ready_for_human') await recover('review');
    const { task } = await runPhase('review', {
      runId: 'run-review-7',
      seams: { arbitration: arbitrationStub(() => ({ verdict: 'insufficient_evidence', confidence: 0.8 })) },
    });
    expect(blockOf(task).lineages[lineageId].state).toBe('escalated_human');
    expect(task.status).toBe('ready_for_human');
  });

  test('a party that answers with nothing still completes the round (§7 row 22)', async () => {
    const { lineageId } = await toEvidenceRequested();
    for (const runId of ['run-review-5', 'run-review-6']) {
      if ((await store.getTask(KEY)).status === 'ready_for_human') await recover('review');
      await runPhase('review', {
        runId,
        seams: { evidence: evidenceStub([], { attachments: 0 }) },
      });
    }
    const task = await store.getTask(KEY);
    expect(blockOf(task).lineages[lineageId]).toMatchObject({
      state: 'arbitration_pending',
      counters: expect.objectContaining({ evidenceRoundsUsed: 1 }),
    });
  });
});

// ===========================================================================
// 6. Duplicate delivery and claim loss
// ===========================================================================

describe('real-handler qualification — redelivery is idempotent', () => {
  test('re-running the same review phase run neither re-invokes the reviewer nor re-applies the row', async () => {
    const { lineageId } = await openDispute();
    const calls = [];
    const stub = reconsiderationStub(() => ({ reconsideration: 'uphold' }), calls);
    const { task: first } = await runPhase('review', { runId: 'run-review-3', seams: { reconsideration: stub } });
    expect(blockOf(first).lineages[lineageId].state).toBe('arbitration_pending');
    const eventsAfterFirst = (await transitionEvents()).length;
    const counters = JSON.parse(JSON.stringify(blockOf(first).lineages[lineageId].counters));

    // The identical delivery: same phase, same run id. The §7.1 selector now
    // names the runner's turn, so a second reviewer sub-turn is not even
    // selected — and nothing about the lineage moves.
    await store.recoverHandoff(KEY, { fromStatus: 'queued', phase: 'review', now: nextNow() });
    const { task: second } = await runPhase('review', {
      runId: 'run-review-3',
      seams: {
        reconsideration: stub,
        arbitration: arbitrationStub(() => ({ verdict: 'reviewer_correct', confidence: 0.9 })),
      },
    });
    expect(calls).toHaveLength(1);
    expect(blockOf(second).lineages[lineageId].counters.reconsiderations).toBe(counters.reconsiderations);
    expect((await transitionEvents()).length).toBeGreaterThanOrEqual(eventsAfterFirst);
  });

  test('a re-delivered arbitration claim converges on the row it already committed', async () => {
    const { lineageId } = await openDispute();
    await runPhase('review', {
      runId: 'run-review-3',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    const calls = [];
    const stub = arbitrationStub(() => ({ verdict: 'reviewer_correct', confidence: 0.92 }), calls);
    const { task: first } = await runPhase('review', { runId: 'run-review-4', seams: { arbitration: stub } });
    expect(blockOf(first).lineages[lineageId].state).toBe('binding');

    await store.recoverHandoff(KEY, { fromStatus: 'queued', phase: 'review', now: nextNow() });
    const { task: second } = await runPhase('review', { runId: 'run-review-4', seams: { arbitration: stub } });
    // The verdict is not re-bought: the applied-row record replays it.
    expect(calls).toHaveLength(1);
    expect(blockOf(second).lineages[lineageId]).toMatchObject({
      state: 'binding',
      counters: expect.objectContaining({
        arbitrationPasses: blockOf(first).lineages[lineageId].counters.arbitrationPasses,
      }),
    });
  });
});

// ===========================================================================
// 7. Operator visibility
// ===========================================================================

describe('operator visibility over a real-handler debate', () => {
  test('a disabled session reports no protocol state at all', async () => {
    await enqueueReview();
    const { task } = await runPhase('review', {
      runId: 'run-review-1',
      session: baseSession(),
      agentOutput: FINDINGS_OUTPUT,
    });
    expect(summarizeDisputeStatus(task, await store.listEvents(KEY))).toBeNull();
  });

  test('an enabled session with no debate reports a block and no lineage', async () => {
    await enqueueReview();
    const { task } = await runPhase('review', { runId: 'run-review-1', agentOutput: CLEAN_OUTPUT });
    const status = summarizeDisputeStatus(task, await store.listEvents(KEY));
    expect(status.reviewStructure).toBe('structured');
    expect(status.lineages).toHaveLength(0);
  });

  test('an open debate reports the current turn and its bounded counters, and nothing else', async () => {
    const { lineageId } = await openDispute();
    const { task } = await runPhase('review', {
      runId: 'run-review-3',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    const status = summarizeDisputeStatus(task, await store.listEvents(KEY));
    const lineage = status.lineages.find((l) => l.lineageId === lineageId);
    expect(lineage).toMatchObject({ state: 'arbitration_pending' });
    expect(lineage.counters).toMatchObject({ rebuttals: 1, reconsiderations: 1 });

    // Bounded metadata only: no prose from any party, no absolute path, no
    // agent transcript. Every string in the projection is a literal or a count.
    const rendered = JSON.stringify(status);
    for (const secret of [ARGUMENT, RATIONALE, VERDICT_RATIONALE, FINDING.failureScenario]) {
      expect(rendered).not.toContain(secret);
    }
    expect(rendered).not.toContain(tmpDir);
    expect(rendered).not.toContain(artifactRoot);
  });

  test('an evidence round reports per-party progress without the evidence itself', async () => {
    const { lineageId } = await openDispute();
    await runPhase('review', {
      runId: 'run-review-3',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    await runPhase('review', {
      runId: 'run-review-4',
      seams: { arbitration: arbitrationStub(() => ({ verdict: 'insufficient_evidence', confidence: 0.8 })) },
    });
    if ((await store.getTask(KEY)).status === 'ready_for_human') await recover('review');
    const { task } = await runPhase('review', { runId: 'run-review-5', seams: { evidence: evidenceStub([]) } });

    const status = summarizeDisputeStatus(task, await store.listEvents(KEY));
    // An empty projection renders as `[]`, which would pass every `not.toContain`
    // below while showing an operator nothing — so the round has to be there
    // first, with one party answered and the other still owed.
    expect(status.evidenceCollection).toHaveLength(1);
    const [round] = status.evidenceCollection;
    expect(round.complete).toBe(false);
    expect(round.parties.map((p) => `${p.party}:${p.state}`)).toEqual([
      'implementer:completed',
      'reviewer:not_started',
    ]);
    const rendered = JSON.stringify(status.evidenceCollection);
    expect(rendered).toContain(lineageId);
    expect(rendered).not.toContain(tmpDir);
    expect(rendered).not.toContain(BOUNDARY);
  });

  test('a terminal escalation reports its stop reason and authorizes no action', async () => {
    const { lineageId } = await openDispute();
    await runPhase('review', {
      runId: 'run-review-3',
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'uphold' })) },
    });
    const { task } = await runPhase('review', {
      runId: 'run-review-4',
      seams: { arbitration: arbitrationStub(() => ({ verdict: 'spec_ambiguous', confidence: 0.99 })) },
    });
    const status = summarizeDisputeStatus(task, await store.listEvents(KEY));
    expect(status.lineages.find((l) => l.lineageId === lineageId)).toMatchObject({
      state: 'escalated_human',
      terminal: true,
    });
    expect(status.nextAction.authorized).toBe(false);
    expect(status.nextAction.description).toMatch(/escalated_human/);
  });
});

// ===========================================================================
// 8. §13 mixed structured/prose compatibility
// ===========================================================================

describe('real-handler qualification — mixed structured and prose reviews', () => {
  test('an envelope emitted alongside prose findings still routes to fix and opens the lineage', async () => {
    await enqueueReview();
    const mixed = `[P1] The auth handler still crashes on a null session.\n\n${FINDINGS_OUTPUT}`;
    const { result, task } = await runPhase('review', { runId: 'run-review-1', agentOutput: mixed });
    expect(result).toBe('needs_fix');
    const lineages = Object.values(blockOf(task).lineages);
    expect(lineages).toHaveLength(1);
    expect(lineages[0].state).toBe('open');
  });

  test('an enabled codex reviewer runs the §17.11 lane and opens a real lineage', async () => {
    await enqueueReview();
    // Issue #1069 / decision D1: `codex review` composes its own report from a
    // `--title` brief and has no seam for the output contract, so an enabled
    // session resolves the review through the runner-authored `codex exec`
    // invocation instead — and its envelope is admitted like any other.
    const session = baseSession({
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    });
    const { result, task } = await runPhase('review', {
      runId: 'run-review-1',
      session,
      agentOutput: FINDINGS_OUTPUT,
    });
    expect(result).toBe('needs_fix');
    expect(task.context.reviewFindings).toMatchObject({
      mode: 'admitted',
      agentId: 'codex',
      invocation: 'codex-structured',
      status: 'findings',
    });
    const lineages = Object.values(blockOf(task).lineages);
    expect(lineages).toHaveLength(1);
    expect(lineages[0].state).toBe('open');
  });

  test('a codex reviewer that answers without an envelope cannot pass cleanly', async () => {
    await enqueueReview();
    // The §17.11 lane ASKED for one, so this is not §13's compatibility case: a
    // prose-only answer is read for its prose and refused a clean certification.
    const session = baseSession({
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    });
    const { result, task } = await runPhase('review', {
      runId: 'run-review-1',
      session,
      agentOutput: 'Looks good to me. No blocking issues.',
    });
    expect(result).toBe('blocked');
    expect(task.context.reviewFindings).toMatchObject({
      mode: 'rejected',
      agentId: 'codex',
      invocation: 'codex-structured',
    });
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
  });
});
