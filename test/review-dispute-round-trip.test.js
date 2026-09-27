/**
 * Issue #1071 — the Claude-implementer / Codex-reviewer round trip, across real
 * task phase boundaries (docs/review-dispute-contract.md §3.4, §4.1, §7.1, §8.2,
 * §9, §17.12, §17.13).
 *
 * Issue #965's suite drives the same real handlers, but with BOTH parties on
 * `claude` — the only agent this runner has a verified no-tools invocation for.
 * That is the configuration in which every §7.1 turn can actually run, and it is
 * deliberately not the configuration this milestone is about. The round trip
 * named here is the mixed one an operator actually configures: Claude
 * implements, Codex reviews through the §17.11 routed lane, Claude rebuts, and
 * the ORIGINAL reviewer is the one owed the §4.1 reconsideration.
 *
 * Two things are pinned, and they are different in kind:
 *
 *  - **Where the round trip stops, and that it stops cleanly.** A Codex
 *    reconsideration is blocked on operator decision D2 (§17.6, §17.12): C7 —
 *    removal of the tool surface — is `unknown`, and §17.2 reads unknown as
 *    absent, so §8.2's "the bundle is the entire input" cannot be enforced for
 *    that CLI. The turn therefore refuses. What these tests assert is that the
 *    refusal is a bounded human handoff at the exact point the contract puts it:
 *    the debate state is byte-identical, no counter is spent, no transition is
 *    written, no agent is spawned, and a recovery re-parks rather than consuming
 *    the rebuttal twice or re-opening an answered version.
 *  - **Who is asked, when the lane has moved.** §4.1's reconsideration belongs
 *    to the reviewer whose finding is being disputed, and a whole implementation
 *    phase runs in between. The review phase therefore hands the turn the
 *    identity the raising run RECORDED (`reviewDisputeParties.review`), exactly
 *    as issue #955 did for the arbiter's independence measurement and #962 for
 *    the evidence parties — not the lane the session resolves by the time the
 *    reconsideration happens.
 *
 * Ground rules are issue #965's, unchanged: real handlers through the real
 * `runNextPhase` against a real SqliteTaskStore, no hand-written protocol state,
 * no hand-edited task context between stages, and `recoverHandoff` — the port
 * `admin recover` uses — as the only operator action.
 */
import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
import { reconsiderationArtifactName } from '../dist/core/review-dispute-lineage.js';
import { REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD } from '../dist/core/review-dispute-parties.js';
import { parseReconsiderationResponse } from '../dist/core/review-reconsideration-response.js';
import {
  AGENT_RUNTIME_AUDIT_CONTEXT_KEY,
  AGENT_RUNTIME_RESOLVED_EVENT,
} from '../dist/core/agent-runtime-audit.js';

// Every case runs three or more real phase runs against a real SQLite store;
// Jest's 5s default is a coin flip for that under a parallel run.
jest.setTimeout(120_000);

const SESSION_ID = 'round-trip';
const ISSUE = 1071;
const KEY = { sessionId: SESSION_ID, issueNumber: ISSUE };
const BRANCH = `ai/issue-${ISSUE}`;
const PR_URL = 'https://github.com/m2dw/test-repo/pull/71';
const BOUNDARY = 'src/auth/handler.ts';
const SECOND_BOUNDARY = 'src/auth/session.ts';
const ISSUE_BODY = 'The auth handler must reject a request with no session before it reads any tenant state.';
const RATIONALE = 'RECONSIDERATION-PROSE: the cited middleware guard runs before the handler on every entry path.';
const ARGUMENT = 'REBUTTAL-PROSE: the null session is already rejected by the middleware, so the cited crash cannot occur.';
const NOW = '2026-09-07T09:00:00.000Z';

let tmpDir;
let repoRoot;
let artifactRoot;
let worktree;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dispute-round-trip-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  worktree = join(tmpDir, 'wt', SESSION_ID, `issue-${ISSUE}`);
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  // The two evidence files every `file` reference cites, in the checkout the
  // review, the fix and the reviewer's turn all resolve references against.
  mkdirSync(join(worktree, 'src', 'auth'), { recursive: true });
  for (const path of [BOUNDARY, SECOND_BOUNDARY]) {
    writeFileSync(
      join(worktree, path),
      `${Array.from({ length: 80 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`,
      'utf8',
    );
  }
  store = new SqliteTaskStore(join(tmpDir, 'tasks.db'));
  clock = 0;
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Session, worktree and lock fixtures
// ---------------------------------------------------------------------------

/**
 * The mixed lane this milestone is about: Claude implements, Codex reviews.
 *
 * `reviewAgent` is a parameter because the point of several cases below is that
 * it MOVED between the run that raised a finding and the run that is owed the
 * reconsideration — the reconfiguration an operator performs mid-debate.
 */
function baseSession({ reviewAgent = 'codex', ...overrides } = {}) {
  return {
    sessionId: SESSION_ID,
    repoKey: 'test-repo',
    repoRoot,
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    artifactRoot,
    githubOwner: 'm2dw',
    githubName: 'test-repo',
    defaults: { implementationAgent: 'claude', reviewAgent, researchAgent: 'gemini' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
}

function enabledSession(overrides = {}) {
  const { reviewDispute, ...rest } = overrides;
  return baseSession({
    ...rest,
    reviewDispute: { enabled: true, arbiter: { providers: ['gemini'] }, ...reviewDispute },
  });
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
// The stub agent runner (issue #965's, unchanged but for the second boundary)
// ---------------------------------------------------------------------------

const PR_VIEW_JSON = JSON.stringify({
  number: 71,
  url: PR_URL,
  headRefName: BRANCH,
  baseRefName: 'main',
  state: 'OPEN',
  isCrossRepository: false,
});
const PR_LIST_JSON = JSON.stringify([{ number: 71, url: PR_URL, headRefName: BRANCH }]);
const TRACKED_INDEX =
  `100644 1111111111111111111111111111111111111111 0\t${BOUNDARY}\n`
  + `100644 2222222222222222222222222222222222222222 0\t${SECOND_BOUNDARY}\n`;
const DIFF_TEXT = `diff --git a/${BOUNDARY} b/${BOUNDARY}\n+// changed`;

/** The agent executables this suite ever configures. */
const AGENT_CMDS = new Set(['claude', 'codex', 'gemini']);

function stubRunner({ agentOutput = 'No blocking issues.', diffStat = '1 file changed', stageable = '' } = {}) {
  const calls = [];
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
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return respond(cmd, args ?? []);
    },
    agentCalls: () => calls.filter((c) => AGENT_CMDS.has(c.cmd)),
    gitCalls: (sub) => calls.filter((c) => c.cmd === 'git' && (c.args ?? [])[0] === sub),
  };
}

/**
 * The `codex exec` subprocess of the §17.11 routed lane (issue #1069).
 *
 * Supplied for EVERY review run: the adapter owns its own subprocess seam and
 * its production default spawns the real CLI, so a scenario running under a
 * `codex` reviewer would otherwise spawn — and possibly bill — a live turn.
 * Writing the final message where `--output-last-message` says to is the one
 * part of the CLI contract the handler depends on; argv, prompt, temp directory
 * and bounded read all stay production.
 */
function structuredCodexStub(agentOutput) {
  const calls = [];
  return {
    calls,
    run(cmd, args) {
      calls.push({ cmd, args });
      const at = args.indexOf('--output-last-message');
      if (at !== -1) writeFileSync(args[at + 1], agentOutput, 'utf8');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// The reviewer sub-turn seam
// ---------------------------------------------------------------------------

function recordEnvelope(record) {
  return JSON.stringify({ record }, null, 2);
}

function writeRecord(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, 'utf8');
}

/** #838's bounded summary, as the real invocation returns it. */
function reconsiderationSummary(input, outcome) {
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
    // The agent the RUNTIME asked for. Echoed rather than fixed, because which
    // identity the review phase resolves is exactly what several cases assert.
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
  };
}

/**
 * A reviewer sub-turn stub that answers with ONE record — admitted by the real
 * #838 parser against the block the gate handed it — and writes the §10.2 record
 * file a later turn re-reads.
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
    writeRecord(input.artifactDir, name, recordEnvelope(record));
    return {
      ok: true,
      admitted: outcome.admitted,
      artifacts: [{ name, content: recordEnvelope(record) }],
      summary: reconsiderationSummary(input, outcome),
    };
  };
}

// ---------------------------------------------------------------------------
// The review agent's structured envelope
// ---------------------------------------------------------------------------

const FINDING_A = {
  version: 1,
  severity: 'P1',
  violatedContract: 'Acceptance criterion: the handler must reject a request with no session',
  preconditions: 'A request arrives with no session cookie',
  failureScenario: 'FINDING-A-PROSE: the handler dereferences a null session and crashes the process',
  affectedBoundary: BOUNDARY,
  requiredOutcome: 'An unauthenticated request is rejected with 401 before any state read',
  evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 40, endLine: 44 }],
};

/**
 * A SECOND, unrelated blocking finding: a different violated contract on a
 * different boundary, so §2.2's identity tuple mints a second lineage rather
 * than attaching to the first.
 */
const FINDING_B = {
  version: 1,
  severity: 'P1',
  violatedContract: 'Acceptance criterion: session lookup must not widen the tenant scope',
  preconditions: 'A session is resolved for a tenant the caller does not belong to',
  failureScenario: 'FINDING-B-PROSE: the session store returns a cross-tenant record to the caller',
  affectedBoundary: SECOND_BOUNDARY,
  requiredOutcome: 'A cross-tenant session lookup is refused before any record is returned',
  evidenceRefs: [{ kind: 'file', path: SECOND_BOUNDARY, startLine: 10, endLine: 14 }],
};

function envelope(body) {
  return `${REVIEW_FINDINGS_MARKER}\n${JSON.stringify(body)}\n${REVIEW_FINDINGS_END_MARKER}`;
}

function findingsOutput(findings) {
  return envelope({ version: 1, status: 'findings', findings });
}

/** A fix agent's §3.1 disposition block. */
function dispositionBlock(records) {
  return `Here are my dispositions.\n\n\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\`\n`;
}

function disputeDisposition(lineageId, boundary = BOUNDARY, version = 1) {
  return {
    lineageId,
    version,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId, version },
      rebuttalReason: 'false_premise',
      argument: ARGUMENT,
      evidenceRefs: [{ kind: 'file', path: boundary, startLine: 30, endLine: 36 }],
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
  return `2026-09-07T09:${String(clock).padStart(2, '0')}:00.000Z`;
}

async function enqueueReview() {
  await store.enqueueTask({
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    phase: 'review',
    priority: 'normal',
    context: {
      title: 'Reject unauthenticated requests before any tenant read',
      url: `https://github.com/m2dw/test-repo/issues/${ISSUE}`,
      body: ISSUE_BODY,
      prUrl: PR_URL,
      branch: BRANCH,
      labels: ['agent:claude', 'status:needs-review'],
    },
    now: NOW,
  });
}

/** One REAL phase run: the actual handler, runner, store and phase runner. */
async function runPhase(phase, { runId, session = enabledSession(), seams = {}, ...runnerOptions } = {}) {
  const runner = stubRunner(runnerOptions);
  const structured = structuredCodexStub(runnerOptions.agentOutput ?? 'No blocking issues.');
  const context = { session, runId, workerId: 'worker-test' };
  const handler =
    phase === 'review'
      ? createReviewHandler(context, runner, fakeResolveWorktree, fakeLock(), undefined, undefined, {
          structuredReviewRunner: structured,
          ...seams,
        })
      : createImplementationHandler(context, runner, undefined, fakeResolveWorktree);
  const outcome = await runNextPhase({
    store,
    request: { sessionId: SESSION_ID, workerId: 'worker-test', runId, supportedPhases: [phase], now: nextNow() },
    handlers: { [phase]: handler },
    now: nextNow(),
  });
  const result =
    outcome.status === 'completed' || outcome.status === 'delayed' ? outcome.result.result : outcome.status;
  return { outcome, runner, structured, result, task: await store.getTask(KEY) };
}

function blockOf(task) {
  return task.context[REVIEW_DISPUTE_CONTEXT_KEY];
}

function onlyLineageId(task) {
  const ids = Object.keys(blockOf(task).lineages);
  expect(ids).toHaveLength(1);
  return ids[0];
}

/**
 * Which lineage covers which boundary — the only stable key with two findings.
 * Suffix-matched because the persisted value is the admission-normalized path,
 * and this suite is asserting WHICH debate it is, not how the path normalizes.
 */
function lineageIdForBoundary(task, boundary) {
  const found = Object.values(blockOf(task).lineages).filter((l) => l.affectedBoundary.endsWith(boundary));
  expect(found).toHaveLength(1);
  return found[0].lineageId;
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

/** Stage 1: the review agent raises the given findings. */
async function raiseFindings(findings, { session = enabledSession(), runId = 'run-review-1' } = {}) {
  await enqueueReview();
  const run = await runPhase('review', { runId, session, agentOutput: findingsOutput(findings) });
  expect(run.outcome.status).toBe('completed');
  expect(run.task.phase).toBe('implementation');
  return run;
}

/** Stage 2: the fix agent answers with a disposition set. */
async function fixRunAnswers(records, { runId = 'run-impl-2', session = enabledSession(), ...runnerOptions } = {}) {
  return runPhase('implementation', {
    runId,
    session,
    agentOutput: dispositionBlock(records),
    ...runnerOptions,
  });
}

/**
 * Stages 1–2 for ONE finding, ending with one `disputed` lineage the implementer
 * rebutted with no file changes — the §3.4 zero-change run.
 */
async function openDispute({ session = enabledSession() } = {}) {
  const raised = await raiseFindings([FINDING_A], { session });
  const lineageId = onlyLineageId(raised.task);
  expect(blockOf(raised.task).lineages[lineageId].state).toBe('open');

  const rebutted = await fixRunAnswers([disputeDisposition(lineageId)], {
    session,
    diffStat: '',
    stageable: '',
  });
  expect(rebutted.outcome.status).toBe('completed');
  expect(blockOf(rebutted.task).lineages[lineageId].state).toBe('disputed');
  expect(rebutted.task).toMatchObject({ status: 'queued', phase: 'review' });
  return { ...rebutted, lineageId };
}

// ===========================================================================
// 1. The round trip, and the point at which it stops
// ===========================================================================

describe('the Codex-reviewer round trip stops at the reconsideration, cleanly', () => {
  test('a Codex-raised finding and a Claude rebuttal reach the reviewer turn, which refuses under §8.2', async () => {
    const raised = await raiseFindings([FINDING_A]);
    const lineageId = onlyLineageId(raised.task);
    // The §17.11 routed lane produced the finding: `codex exec`, not
    // `codex review`, and the review party recorded beside the block is the
    // agent that actually raised it.
    expect(raised.structured.calls).toHaveLength(1);
    expect(raised.structured.calls[0].args).toContain('exec');
    expect(raised.task.context[REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD]).toEqual({ review: { agentId: 'codex' } });

    const rebutted = await fixRunAnswers([disputeDisposition(lineageId)], { diffStat: '', stageable: '' });
    // §3.4: a validated rebuttal is protocol progress. The run edited nothing
    // and is a SUCCESS, and nothing was committed for it.
    expect(rebutted.result).toBe('success');
    expect(rebutted.runner.gitCalls('commit')).toHaveLength(0);
    expect(blockOf(rebutted.task).lineages[lineageId].state).toBe('disputed');
    expect(rebutted.task.context[REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD]).toEqual({
      implementation: { agentId: 'claude' },
      review: { agentId: 'codex' },
    });
    expect(rebutted.task).toMatchObject({ status: 'queued', phase: 'review' });

    const before = JSON.parse(JSON.stringify(blockOf(rebutted.task)));
    const transitionsBefore = (await transitionEvents()).length;

    // No reconsideration seam: the SHIPPING invocation answers, and for `codex`
    // it refuses — B2/D2 (§17.12), not a defect.
    const reviewed = await runPhase('review', { runId: 'run-review-3' });
    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.status).toBe('ready_for_human');
    // Nothing ran: not the review agent, not the routed review lane, not the
    // reviewer's own turn.
    expect(reviewed.runner.agentCalls()).toHaveLength(0);
    expect(reviewed.structured.calls).toHaveLength(0);
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      taskTurn: 'reviewer',
      lineageIds: [lineageId],
      disposition: 'parked',
      failure: 'profile_unavailable',
    });
    // The debate is byte-identical, and no §7 row was written for it.
    expect(blockOf(reviewed.task)).toEqual(before);
    expect(blockOf(reviewed.task).lineages[lineageId].counters.reconsiderations).toBe(0);
    expect(await transitionEvents()).toHaveLength(transitionsBefore);
    expect(await subTurnEvents()).toHaveLength(1);
  });

  test('recovering the park re-parks: no response is consumed twice and no version re-opens', async () => {
    const { lineageId } = await openDispute();
    // The rebuttal's own §7 row is the only transition on file; every park below
    // must leave that count exactly where it is.
    const transitionsAfterRebuttal = (await transitionEvents()).length;
    const first = await runPhase('review', { runId: 'run-review-3' });
    expect(first.task.status).toBe('ready_for_human');
    const parked = JSON.parse(JSON.stringify(blockOf(first.task)));

    await recover('review');
    const second = await runPhase('review', { runId: 'run-review-4' });
    expect(second.result).toBe('blocked');
    expect(second.task.status).toBe('ready_for_human');
    expect(blockOf(second.task)).toEqual(parked);
    const lineage = blockOf(second.task).lineages[lineageId];
    // §6.1: the rebuttal slot was consumed exactly once, by the fix run — a
    // re-delivered reviewer turn neither spends it again nor re-opens the
    // version it already answered.
    expect(lineage.state).toBe('disputed');
    expect(lineage.version).toBe(1);
    expect(lineage.rebuttedVersions).toEqual([1]);
    expect(lineage.counters).toMatchObject({ rebuttals: 1, reconsiderations: 0, arbitrationPasses: 0 });
    expect(await transitionEvents()).toHaveLength(transitionsAfterRebuttal);
    // One audit line per attempt: a park with an unchanged block would otherwise
    // be indistinguishable from a task nothing ever tried to run.
    expect(await subTurnEvents()).toHaveLength(2);
  });

  test('an unrelated blocking finding stays in force while the disputed one waits', async () => {
    const raised = await raiseFindings([FINDING_A, FINDING_B]);
    const disputedId = lineageIdForBoundary(raised.task, BOUNDARY);
    const fixedId = lineageIdForBoundary(raised.task, SECOND_BOUNDARY);
    expect(disputedId).not.toBe(fixedId);

    // One finding is fixed with a real diff, the other is disputed: a mixed run
    // records both dispositions.
    const answered = await fixRunAnswers(
      [disputeDisposition(disputedId), fixedDisposition(fixedId)],
      { diffStat: '1 file changed', stageable: `${SECOND_BOUNDARY}\0` },
    );
    expect(answered.result).toBe('success');
    expect(blockOf(answered.task).lineages[disputedId].state).toBe('disputed');
    expect(blockOf(answered.task).lineages[fixedId].state).toBe('resolved_fixed');
    expect(answered.task).toMatchObject({ status: 'queued', phase: 'review' });

    // The review phase owes the reviewer's turn for the disputed lineage. It
    // cannot take it, so it parks — and it must NOT fall through to an ordinary
    // review that could report a clean pass over an open debate.
    const reviewed = await runPhase('review', { runId: 'run-review-3' });
    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.status).toBe('ready_for_human');
    expect(reviewed.runner.agentCalls()).toHaveLength(0);
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      lineageIds: [disputedId],
      disposition: 'parked',
      failure: 'profile_unavailable',
    });
    // The fixed lineage keeps its terminal state; the disputed one keeps its own.
    expect(blockOf(reviewed.task).lineages[fixedId].state).toBe('resolved_fixed');
    expect(blockOf(reviewed.task).lineages[disputedId].state).toBe('disputed');
  });

  test('a disabled session runs `codex review` and leaves the debate exactly where it is', async () => {
    const { task, lineageId } = await openDispute();
    const before = JSON.parse(JSON.stringify(blockOf(task)));
    const transitionsBefore = (await transitionEvents()).length;

    // The rollback an operator performs: the protocol is switched off with a
    // debate on file. §13's default-off guarantee — the native command, byte for
    // byte — and §7.1's turns are not owed at all.
    const disabled = await runPhase('review', {
      runId: 'run-review-3',
      session: baseSession({ reviewDispute: { enabled: false } }),
    });
    expect(disabled.structured.calls).toHaveLength(0);
    const agentCalls = disabled.runner.agentCalls();
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0].cmd).toBe('codex');
    expect(agentCalls[0].args).toContain('review');
    expect(blockOf(disabled.task)).toEqual(before);
    expect(blockOf(disabled.task).lineages[lineageId].state).toBe('disputed');
    expect(disabled.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toBeUndefined();
    expect(await transitionEvents()).toHaveLength(transitionsBefore);
  });
});

// ===========================================================================
// 2. Whose turn it is, when the lane has moved under the debate
// ===========================================================================

describe('the reconsideration is owed to the reviewer of record', () => {
  test('a reconfigured lane does not take the original reviewer’s turn', async () => {
    // The finding is raised by a Claude reviewer...
    const raised = await raiseFindings([FINDING_A], { session: enabledSession({ reviewAgent: 'claude' }) });
    const lineageId = onlyLineageId(raised.task);
    expect(raised.task.context[REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD]).toEqual({ review: { agentId: 'claude' } });
    const rebutted = await fixRunAnswers([disputeDisposition(lineageId)], {
      session: enabledSession({ reviewAgent: 'claude' }),
      diffStat: '',
      stageable: '',
    });
    expect(blockOf(rebutted.task).lineages[lineageId].state).toBe('disputed');

    // ...and the operator moves the review lane to Codex before the reviewer's
    // turn. §4.1's reconsideration still belongs to the agent that wrote the
    // finding, so the turn is dispatched for `claude` — the current lane does
    // not inherit a debate it was not part of.
    const calls = [];
    const reviewed = await runPhase('review', {
      runId: 'run-review-3',
      session: enabledSession({ reviewAgent: 'codex' }),
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'withdraw' }), calls) },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe('claude');
    expect(calls[0].run.agentId).toBe('claude');
    // And the round trip completes: withdrawal clears the resolved finding.
    expect(blockOf(reviewed.task).lineages[lineageId].state).toBe('resolved_withdrawn');
    expect(await transitionEvents()).not.toHaveLength(0);
  });

  test('a Codex-raised debate is not answered by a lane later reconfigured to Claude', async () => {
    const { task: rebutted, lineageId } = await openDispute();
    const before = JSON.parse(JSON.stringify(blockOf(rebutted)));

    // The reverse reconfiguration, with the SHIPPING invocation in place: the
    // reviewer of record is `codex`, which has no §8.2 invocation, so the turn
    // refuses rather than letting the newly-configured Claude lane answer for a
    // finding it never wrote.
    const reviewed = await runPhase('review', {
      runId: 'run-review-3',
      session: enabledSession({ reviewAgent: 'claude' }),
    });
    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.status).toBe('ready_for_human');
    expect(reviewed.runner.agentCalls()).toHaveLength(0);
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      lineageIds: [lineageId],
      disposition: 'parked',
      failure: 'profile_unavailable',
    });
    expect(blockOf(reviewed.task)).toEqual(before);
  });

  test('the identity the turn is dispatched with is the recorded one, not the resolved one', async () => {
    const { lineageId } = await openDispute();
    // Same debate, same reconfigured Claude lane, but with the invocation seam
    // in place so the identity the runtime asked for is observable rather than
    // only its refusal.
    const calls = [];
    await runPhase('review', {
      runId: 'run-review-3',
      session: enabledSession({ reviewAgent: 'claude' }),
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'withdraw' }), calls) },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe('codex');
    expect(calls[0].pending).toEqual({ lineageId, version: 1 });
  });
});

// ===========================================================================
// 2b. The §13 runtime audit when the dispute gate owns the run
// ===========================================================================

describe('the §13 runtime audit when the dispute gate owns the run', () => {
  async function auditState(task) {
    const events = await store.listEvents(KEY);
    return {
      trail: task.context[AGENT_RUNTIME_AUDIT_CONTEXT_KEY],
      resolvedEvents: events.filter((e) => e.type === AGENT_RUNTIME_RESOLVED_EVENT).length,
    };
  }

  test('a dispatched sub-turn does not audit the never-invoked review-lane resolution (issue #912 review, P2)', async () => {
    // The finding's own scenario: a Claude-raised debate, with the review lane
    // moved to Codex before the reviewer's turn. The reconsideration is
    // dispatched for the persisted Claude reviewer, so a §13 record naming the
    // CURRENT Codex review lane would describe a resolution nothing invoked.
    const raised = await raiseFindings([FINDING_A], { session: enabledSession({ reviewAgent: 'claude' }) });
    const lineageId = onlyLineageId(raised.task);
    const rebutted = await fixRunAnswers([disputeDisposition(lineageId)], {
      session: enabledSession({ reviewAgent: 'claude' }),
      diffStat: '',
      stageable: '',
    });
    const before = await auditState(rebutted.task);
    // The two completed lanes so far (review, implementation) each recorded
    // their own resolution — the assertions below are about growth, not absence.
    expect(before.trail).toBeDefined();
    expect(before.resolvedEvents).toBeGreaterThan(0);

    const reviewed = await runPhase('review', {
      runId: 'run-review-3',
      session: enabledSession({ reviewAgent: 'codex' }),
      seams: { reconsideration: reconsiderationStub(() => ({ reconsideration: 'withdraw' })) },
    });
    expect(blockOf(reviewed.task).lineages[lineageId].state).toBe('resolved_withdrawn');
    // The run invoked the reconsideration's own resolution (§8.2), never the
    // `review` lane resolved at phase start — so no record is appended and no
    // `agent.runtime.resolved` event claims the Codex assignment ran.
    const after = await auditState(reviewed.task);
    expect(after.trail).toEqual(before.trail);
    expect(after.resolvedEvents).toBe(before.resolvedEvents);
  });

  test('a parked sub-turn withdraws it too — a park invokes nothing at all', async () => {
    // The codex reviewer of record has no §8.2 invocation, so the turn parks
    // under the reconfigured Claude lane. Nothing was spawned, so the §13
    // trail must not record the Claude review lane as this run's resolution.
    const { task: rebutted, lineageId } = await openDispute();
    const before = await auditState(rebutted);

    const reviewed = await runPhase('review', {
      runId: 'run-review-3',
      session: enabledSession({ reviewAgent: 'claude' }),
    });
    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      lineageIds: [lineageId],
      disposition: 'parked',
    });
    const after = await auditState(reviewed.task);
    expect(after.trail).toEqual(before.trail);
    expect(after.resolvedEvents).toBe(before.resolvedEvents);
  });
});

// ===========================================================================
// 3. The two no-ops, which must not be confused with each other
// ===========================================================================

describe('a rebuttal-only run and an ordinary no-op run', () => {
  test('an ordinary no-op still fails, and moves no lineage', async () => {
    const raised = await raiseFindings([FINDING_A]);
    const lineageId = onlyLineageId(raised.task);

    // The fix agent answers nothing and edits nothing: not a disposition set,
    // not a rebuttal, just prose. §3.4 admits a zero-change run only for a
    // complete, valid disposition set, so this is the failure it always was.
    const noop = await runPhase('implementation', {
      runId: 'run-impl-2',
      agentOutput: 'I looked at the finding and decided not to change anything.',
      diffStat: '',
      stageable: '',
    });
    expect(noop.result).toBe('failed');
    expect(noop.outcome.result.error).toMatch(/produced no file changes/);
    expect(blockOf(noop.task).lineages[lineageId]).toMatchObject({
      state: 'open',
      version: 1,
      rebuttedVersions: [],
    });
    expect(await transitionEvents()).toHaveLength(0);
  });

  test('a rebuttal-only run succeeds without a commit and hands the turn to the reviewer', async () => {
    const { task, lineageId, runner } = await openDispute();
    // Nothing was staged, committed or pushed — and the run is still a success,
    // because the protocol progressed.
    expect(runner.gitCalls('commit')).toHaveLength(0);
    expect(runner.gitCalls('push')).toHaveLength(0);
    // §3.4 relaxes the diff check and nothing else: the session's configured
    // verification still ran over the branch this run left behind.
    expect(runner.calls.filter((c) => c.cmd === 'npm')).not.toHaveLength(0);
    expect(blockOf(task).lineages[lineageId]).toMatchObject({
      state: 'disputed',
      rebuttedVersions: [1],
      counters: { rebuttals: 1, reconsiderations: 0 },
    });
    expect(task).toMatchObject({ status: 'queued', phase: 'review' });
  });
});
