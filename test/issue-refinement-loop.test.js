/**
 * Chain-aware progressive Issue refinement — the bounded two-agent loop
 * (issue #869, docs/issue-refinement-contract.md §7, §8, §9, §10, §12 rows
 * 8–21, §13, §15, §17).
 *
 * Covers the acceptance criteria of the Issue: normal pass, revise-then-pass,
 * round cap, malformed output per role, timeout/provider failure, role
 * independence, topology fail-closed, the no-GitHub-write surface, and the
 * per-role agent/company/model/effort/duration metadata.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_QUOTA_RETRY_DELAY_MS,
  DEFAULT_REFINEMENT_MARKER_LABEL,
  IMPLEMENTATION_STATUS_LABEL,
  IssueWorktreeLock,
  MANAGED_REGION_END,
  SqliteChainRegistryStore,
  SqliteOutboxStore,
  SqliteTaskStore,
  buildRefinementContextBlock,
  buildRefinerPrompt,
  combineTopologyDispositions,
  containsFilesystemPath,
  evaluateRefinementRoleIndependence,
  extractRefinementRecord,
  parseCriticResponse,
  parseRefinerResponse,
  renderManagedRegion,
  resolveIssueRefinementSettings,
  scanManagedRegion,
} from '../dist/index.js';
import {
  REFINEMENT_RETRY_DELAY_MS,
  createRefinementAgentRunner,
  createRefinementHandler,
  defaultRefinementFailureClassifier,
  executeRefinementLoop,
  resolveRefinementRoleProfile,
} from '../dist/handlers/issue-refinement-loop.js';
import {
  createGhRefinementSnapshotSource,
  parseRefinementRunArgs,
  readChainAgreementFromRegistry,
  runRefinementRun,
} from '../dist/cli/issue-refinement-loop.js';

const ADMIN_CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

const STACK_READY = 'status:stack-ready';
const NOW = '2026-08-10T00:00:00.000Z';
const LANE_LABELS = {
  marker: DEFAULT_REFINEMENT_MARKER_LABEL,
  implementationStatus: IMPLEMENTATION_STATUS_LABEL,
};

// ---------------------------------------------------------------------------
// Fixture world (same shape as the #868 snapshot tests): one usable
// open-stack-ready predecessor #10 behind target Issue #500.
// ---------------------------------------------------------------------------

function sha(seed) {
  return String(seed).repeat(40).slice(0, 40);
}

function predecessor(n, overrides = {}) {
  const { issue: issueOverride, pr: prOverride, ...rest } = overrides;
  return {
    issue: {
      number: n,
      state: 'open',
      title: `Predecessor ${n}`,
      body: `Predecessor ${n} body`,
      labels: [STACK_READY, 'agent:claude'],
      ...issueOverride,
    },
    pr:
      prOverride === null
        ? null
        : {
            number: 900 + n,
            state: 'open',
            headRefName: `ai/issue-${n}`,
            headSha: sha(n),
            title: `PR for ${n}`,
            body: `PR ${n} body`,
            ...prOverride,
          },
    comments: [
      { id: `c${n}-1`, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', body: `comment ${n}-1` },
    ],
    paths: [{ path: `src/p${n}.ts`, added: 3, removed: 1 }],
    review: { outcome: 'success' },
    ...rest,
  };
}

function targetIssue(overrides = {}) {
  return {
    number: 500,
    state: 'open',
    title: 'Downstream Issue',
    body: 'Downstream body',
    labels: ['agent:claude', DEFAULT_REFINEMENT_MARKER_LABEL],
    ...overrides,
  };
}

/** Read-only port; records every call so the no-write surface is provable. */
function makeSource(world, opts = {}) {
  const calls = [];
  const entry = (n) => {
    const e = world[n];
    if (!e) throw new Error(`test fixture has no issue #${n}`);
    return e;
  };
  const port = {
    async getBlockedBy(n) {
      calls.push(['getBlockedBy', n]);
      if (opts.blockedByThrows) throw new Error(opts.blockedByThrows);
      return opts.blockedBy ?? [];
    },
    async readIssue(n) {
      calls.push(['readIssue', n]);
      if (opts.readIssueThrows === n) throw new Error(`read failed for #${n}`);
      return entry(n).issue;
    },
    async readPullRequest(n) {
      calls.push(['readPullRequest', n]);
      const pr = entry(n).pr;
      if (pr === null) return { kind: 'none' };
      return { kind: 'found', pullRequest: pr };
    },
    async readChangedPaths(prNumber, limit) {
      calls.push(['readChangedPaths', prNumber, limit]);
      const owner = Object.values(world).find((e) => e.pr && e.pr.number === prNumber);
      return owner ? owner.paths : [];
    },
    async readIssueComments(n, limit) {
      calls.push(['readIssueComments', n, limit]);
      return entry(n).comments;
    },
    async readReviewSummary(n) {
      calls.push(['readReviewSummary', n]);
      return entry(n).review;
    },
    async readIssuePlan(n) {
      calls.push(['readIssuePlan', n]);
      return null;
    },
  };
  return { port, calls };
}

function defaultWorld() {
  return { 500: { issue: targetIssue(), pr: null, comments: [], paths: [], review: null }, 10: predecessor(10) };
}

function settingsFor(config = {}) {
  const resolved = resolveIssueRefinementSettings({
    enabled: true,
    agents: { refiner: 'claude', critic: 'codex' },
    ...config,
  });
  if (!resolved.ok) throw new Error(`fixture settings invalid: ${JSON.stringify(resolved.errors)}`);
  return resolved.settings;
}

function makeBlock(overrides = {}) {
  return buildRefinementContextBlock({
    issueNumber: 500,
    title: 'Downstream Issue',
    body: 'Downstream body',
    labels: ['agent:claude', DEFAULT_REFINEMENT_MARKER_LABEL],
    agentLabel: 'agent:claude',
    implementationAgent: 'claude',
    refinerAgent: 'refinerAgent' in overrides ? overrides.refinerAgent : 'claude',
    criticAgent: 'criticAgent' in overrides ? overrides.criticAgent : 'codex',
    settings: overrides.settings ?? settingsFor(),
    laneLabels: LANE_LABELS,
    now: NOW,
  });
}

/** Test capability table: distinct providers per agent id, no subprocess. */
function fakeProfileResolver(role, agentId) {
  const provider =
    agentId === 'claude' ? 'anthropic' : agentId === 'codex' ? 'openai' : 'google';
  return {
    profile: {
      phase: 'refinement',
      role,
      agentId,
      cmd: agentId,
      argv: ['-p'],
      model: agentId === 'claude' ? 'opus' : 'test-model',
      modelSource: 'default',
      effort: 'high',
      effortSource: 'default',
      provider,
      toolPolicy: 'no-tools',
    },
  };
}

function makeAgent(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(invocation) {
      calls.push(invocation);
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return typeof next === 'function' ? next(invocation) : next;
    },
  };
}

function ok(stdout) {
  return { stdout, stderr: '', exitCode: 0 };
}

function fenced(record) {
  return `Here is the result.\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}

function refinerRecord(overrides = {}) {
  return {
    summary: 'Refined summary grounded in predecessor outcomes.',
    acceptanceCriteria: ['criterion one'],
    testPlan: ['test one'],
    risks: ['risk one'],
    implementationNotes: ['note one'],
    predecessorReferences: [
      { issueNumber: 10, prNumber: 910, headSha: sha(10), decision: 'delivered the port' },
    ],
    topologyProposals: [],
    unresolvedQuestions: [],
    confidence: 'high',
    ...overrides,
  };
}

function criticRecord(overrides = {}) {
  return {
    verdict: 'pass',
    objections: [],
    topologyDispositions: [],
    confidence: 'high',
    ...overrides,
  };
}

const objection = { field: 'summary', kind: 'unsupported', detail: 'claim has no snapshot basis' };

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'refine-loop-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run({
  block = makeBlock(),
  world = defaultWorld(),
  blockedBy = [{ issueNumber: 10, state: 'open' }],
  refiner = makeAgent([ok(fenced(refinerRecord()))]),
  critic = makeAgent([ok(fenced(criticRecord()))]),
  sourceOpts = {},
  deps = {},
  runId = 'run-1',
} = {}) {
  const { port, calls } = makeSource(world, { blockedBy, ...sourceOpts });
  const result = await executeRefinementLoop(
    {
      issueNumber: 500,
      block,
      stackReadyLabel: STACK_READY,
      artifactDir: join(tmpDir, runId),
      runId,
      timeoutMs: 5000,
    },
    {
      source: port,
      refinerAgent: (inv) => refiner.run(inv),
      criticAgent: (inv) => critic.run(inv),
      resolveRoleProfile: fakeProfileResolver,
      now: (() => {
        let t = 0;
        return () => (t += 7);
      })(),
      ...deps,
    },
  );
  return { result, refiner, critic, calls, artifactDir: join(tmpDir, runId) };
}

// ---------------------------------------------------------------------------
// The loop — acceptance paths
// ---------------------------------------------------------------------------

describe('issue-refinement loop — normal pass', () => {
  test('one round, critic pass: accepted state, artifact, metadata for both roles', async () => {
    const { result, refiner, critic, artifactDir } = await run();

    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.taskStatus).toBeNull();
    expect(result.block.state).toBe('accepted');
    expect(result.block.handoffReason).toBeNull();
    expect(result.block.counters.rounds).toBe(1);
    expect(result.block.predecessors.map((p) => p.issueNumber)).toEqual([10]);
    expect(result.block.predecessorFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // A successful run REQUIRES a validated critic pass: both agents ran once.
    expect(refiner.calls).toHaveLength(1);
    expect(critic.calls).toHaveLength(1);

    // §15 accepted record: the validated contract, both confidences.
    expect(result.block.accepted.contract.summary).toBe(
      'Refined summary grounded in predecessor outcomes.',
    );
    expect(result.block.accepted.refinerConfidence).toBe('high');
    expect(result.block.accepted.criticConfidence).toBe('high');
    expect(result.block.accepted.roundsUsed).toBe(1);

    // Agent/company/model/effort/duration metadata persisted for BOTH roles.
    const roles = result.block.execution;
    expect(roles.runId).toBe('run-1');
    expect(roles.refiner).toMatchObject({
      agentId: 'claude',
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
      invocations: 1,
    });
    expect(roles.critic).toMatchObject({
      agentId: 'codex',
      provider: 'openai',
      model: 'test-model',
      effort: 'high',
      invocations: 1,
    });
    expect(roles.refiner.totalDurationMs).toBeGreaterThan(0);
    expect(roles.critic.totalDurationMs).toBeGreaterThan(0);

    expect(result.events.map((e) => e.type)).toEqual([
      'refinement.roles.resolved',
      'refinement.eligibility.granted',
      'refinement.snapshot.captured',
      'refinement.draft.recorded',
      'refinement.critique.passed',
    ]);

    // Artifacts: snapshot, transcripts (written before parsing), acceptance,
    // region, and the run manifest.
    for (const name of [
      'snapshot.json',
      'refiner-round1-attempt1-stdout.txt',
      'critic-round1-attempt1-stdout.txt',
      'accepted-refinement.json',
      'managed-region.md',
      'run-manifest.json',
    ]) {
      expect(existsSync(join(artifactDir, name))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(artifactDir, 'run-manifest.json'), 'utf8'));
    expect(manifest.roles.refiner.model).toBe('opus');
    expect(manifest.roles.critic.provider).toBe('openai');
    expect(manifest.outcome).toEqual({ kind: 'accepted' });
    const accepted = JSON.parse(readFileSync(join(artifactDir, 'accepted-refinement.json'), 'utf8'));
    expect(accepted.accepted.contract.acceptanceCriteria).toEqual(['criterion one']);
    const region = readFileSync(join(artifactDir, 'managed-region.md'), 'utf8');
    expect(region.endsWith(MANAGED_REGION_END)).toBe(true);
  });

  test('prompts fence the snapshot as untrusted data and never share a nonce', async () => {
    const { refiner, critic } = await run();
    const refinerPrompt = refiner.calls[0].prompt;
    const criticPrompt = critic.calls[0].prompt;
    expect(refinerPrompt).toContain('BEGIN UNTRUSTED SNAPSHOT DATA');
    expect(criticPrompt).toContain('BEGIN UNTRUSTED SNAPSHOT DATA');
    expect(refinerPrompt).toContain('Predecessor 10');
    const nonceOf = (p) => p.match(/BEGIN UNTRUSTED SNAPSHOT DATA ([0-9a-f]+) /)[1];
    expect(nonceOf(refinerPrompt)).not.toBe(nonceOf(criticPrompt));
  });

  test('the loop holds no write surface: every port call is a read', async () => {
    const { calls } = await run();
    const methods = new Set(calls.map(([m]) => m));
    const readOnly = new Set([
      'getBlockedBy',
      'readIssue',
      'readPullRequest',
      'readChangedPaths',
      'readIssueComments',
      'readReviewSummary',
      'readIssuePlan',
      'readChainAgreement',
    ]);
    for (const m of methods) expect(readOnly.has(m)).toBe(true);
  });
});

describe('issue-refinement loop — revise then pass', () => {
  test('objections are handed back, a second draft passes, rounds=2', async () => {
    const critic = makeAgent([
      ok(fenced(criticRecord({ verdict: 'revise', objections: [objection] }))),
      ok(fenced(criticRecord())),
    ]);
    const refiner = makeAgent([
      ok(fenced(refinerRecord())),
      ok(fenced(refinerRecord({ summary: 'Second draft with the objection addressed.' }))),
    ]);
    const { result } = await run({ refiner, critic });

    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.counters.rounds).toBe(2);
    expect(refiner.calls).toHaveLength(2);
    expect(critic.calls).toHaveLength(2);
    expect(result.block.accepted.contract.summary).toBe(
      'Second draft with the objection addressed.',
    );
    expect(result.events.map((e) => e.type)).toContain('refinement.critique.revise');

    // §7.2: the objections are the only critic output handed back.
    const secondPrompt = refiner.calls[1].prompt;
    expect(secondPrompt).toContain('REVISION round');
    expect(secondPrompt).toContain('claim has no snapshot basis');
  });

  test('revise at the round cap escalates no_convergence (§12 row 18)', async () => {
    const critic = makeAgent([
      ok(fenced(criticRecord({ verdict: 'revise', objections: [objection] }))),
    ]);
    const { result } = await run({ critic });

    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'no_convergence' });
    expect(result.taskStatus).toBe('ready_for_human');
    expect(result.block.state).toBe('escalated_human');
    expect(result.block.handoffReason).toBe('no_convergence');
    expect(result.block.counters.rounds).toBe(2);
    expect(result.events.map((e) => e.type)).toContain('refinement.escalated.human');
  });

  test('a critic block goes straight to human handoff (§12 row 19)', async () => {
    const critic = makeAgent([ok(fenced(criticRecord({ verdict: 'block' })))]);
    const { result } = await run({ critic });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'critique_blocked' });
    expect(result.block.counters.rounds).toBe(1);
  });
});

describe('issue-refinement loop — malformed output (§17)', () => {
  test('a malformed draft below the cap re-runs the refiner and spends no round', async () => {
    const refiner = makeAgent([ok('no json here'), ok(fenced(refinerRecord()))]);
    const { result } = await run({ refiner });
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.counters.malformedAttempts.refiner).toBe(1);
    expect(result.block.counters.rounds).toBe(1);
    expect(refiner.calls).toHaveLength(2);
    const malformedEvents = result.events.filter((e) => e.type === 'refinement.draft.malformed');
    expect(malformedEvents).toHaveLength(1);
    expect(malformedEvents[0].data.details).toEqual(['no-json-block']);
  });

  test('malformed refiner output at the cap escalates malformed_refiner_output', async () => {
    const refiner = makeAgent([ok('junk')]);
    const { result } = await run({ refiner });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'malformed_refiner_output' });
    expect(result.block.counters.malformedAttempts.refiner).toBe(2);
    expect(refiner.calls).toHaveLength(3); // two tolerated re-runs, third escalates
    expect(result.block.counters.rounds).toBe(0); // malformed never advances a round
  });

  test('malformed critic output at the cap escalates malformed_critic_output', async () => {
    const critic = makeAgent([ok(fenced({ verdict: 'sure!' }))]);
    const { result } = await run({ critic });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'malformed_critic_output' });
    expect(result.block.counters.malformedAttempts.critic).toBe(2);
    expect(critic.calls).toHaveLength(3);
  });

  test('raw transcripts are written even for malformed attempts', async () => {
    const refiner = makeAgent([ok('garbage output'), ok(fenced(refinerRecord()))]);
    const { artifactDir } = await run({ refiner });
    expect(readFileSync(join(artifactDir, 'refiner-round1-attempt1-stdout.txt'), 'utf8')).toBe(
      'garbage output',
    );
    expect(existsSync(join(artifactDir, 'refiner-round1-attempt2-stdout.txt'))).toBe(true);
  });
});

describe('issue-refinement loop — agent process failures (§12 rows 38-41, §17)', () => {
  test('a retryable failure defers the re-run to a later run — never synchronously in this one', async () => {
    const refiner = makeAgent([
      { stdout: '', stderr: 'quota exhausted', exitCode: 1 },
      ok(fenced(refinerRecord())),
    ]);
    const { result } = await run({ refiner });
    // Row 38 (§17): the failing provider is NOT re-invoked in this run — a
    // quota still exhausted would burn every remaining attempt. The resumable
    // position rides the block and the caller applies the phase-level delay.
    expect(refiner.calls).toHaveLength(1);
    expect(result.outcome).toEqual({
      kind: 'agent_retry',
      role: 'refiner',
      failureKind: 'exit-nonzero',
      round: 1,
    });
    expect(result.taskStatus).toBeNull();
    expect(result.block.state).toBe('drafting');
    expect(result.block.pendingRetry).toMatchObject({ role: 'refiner', round: 1, attempt: 1 });
    expect(result.block.counters.agentFailures.refiner).toBe(1);
    expect(result.block.counters.rounds).toBe(0);
    expect(result.block.counters.malformedAttempts.refiner).toBe(0);
    expect(result.events.filter((e) => e.type === 'refinement.agent.failed')).toHaveLength(1);

    // The delayed re-run resumes the SAME role and completes normally.
    const second = await run({ refiner, block: result.block, runId: 'run-2' });
    expect(second.result.outcome).toEqual({ kind: 'accepted' });
    expect(second.result.block.pendingRetry).toBeUndefined();
    expect(second.result.block.counters.agentFailures.refiner).toBe(1);
    expect(refiner.calls).toHaveLength(2);
  });

  test('a critic timeout defers with the round draft persisted; the resume re-runs only the critic', async () => {
    const refiner = makeAgent([ok(fenced(refinerRecord()))]);
    const critic = makeAgent([
      { stdout: '', stderr: 'spawnSync ETIMEDOUT', exitCode: 1, spawnError: 'spawnSync claude ETIMEDOUT' },
      ok(fenced(criticRecord())),
    ]);
    const { result } = await run({ refiner, critic });
    expect(result.outcome).toEqual({
      kind: 'agent_retry',
      role: 'critic',
      failureKind: 'timeout',
      round: 1,
    });
    expect(result.block.state).toBe('critiquing');
    // Row 40: the SAME draft is what the resumed critic re-runs against.
    expect(result.block.pendingRetry).toMatchObject({
      role: 'critic',
      round: 1,
      draft: { summary: refinerRecord().summary },
    });
    expect(result.block.counters.agentFailures.critic).toBe(1);

    const second = await run({ refiner, critic, block: result.block, runId: 'run-2' });
    expect(second.result.outcome).toEqual({ kind: 'accepted' });
    // The refiner did not re-run: one invocation across both runs.
    expect(refiner.calls).toHaveLength(1);
    expect(critic.calls).toHaveLength(2);
  });

  test('failures past the per-role cap escalate agent_unavailable, never task failed', async () => {
    const refiner = makeAgent([{ stdout: '', stderr: 'boom', exitCode: 1 }]);
    const first = await run({ refiner });
    expect(first.result.outcome).toMatchObject({ kind: 'agent_retry' });
    const second = await run({ refiner, block: first.result.block, runId: 'run-2' });
    expect(second.result.outcome).toMatchObject({ kind: 'agent_retry' });
    const third = await run({ refiner, block: second.result.block, runId: 'run-3' });
    expect(third.result.outcome).toEqual({ kind: 'escalated', reason: 'agent_unavailable' });
    expect(third.result.taskStatus).toBe('ready_for_human');
    expect(third.result.block.counters.agentFailures.refiner).toBe(2);
    expect(third.result.block.pendingRetry).toBeUndefined();
    expect(refiner.calls).toHaveLength(3);
  });

  test('a non-retryable failure (missing binary) escalates immediately', async () => {
    const critic = makeAgent([
      { stdout: '', stderr: 'spawn claude ENOENT', exitCode: -1, spawnError: 'spawn claude ENOENT' },
    ]);
    const { result } = await run({ critic });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'agent_unavailable' });
    expect(critic.calls).toHaveLength(1);
    expect(result.block.counters.agentFailures.critic).toBe(0);
  });

  test('a throwing injected agent is a process failure, not a crash', async () => {
    const { result } = await run({
      refiner: {
        calls: [],
        run() {
          throw new Error('ENOSPC: no space left on device');
        },
      },
    });
    expect(result.outcome).toEqual({
      kind: 'agent_retry',
      role: 'refiner',
      failureKind: 'spawn',
      round: 1,
    });
    expect(result.block.pendingRetry).toMatchObject({ role: 'refiner' });
  });

  test('a mid-loop state without a resumable position stays refused', async () => {
    const block = makeBlock();
    block.state = 'critiquing';
    const { result, refiner, critic } = await run({ block });
    expect(result.outcome).toEqual({ kind: 'refused', detail: 'state:critiquing' });
    expect(refiner.calls).toHaveLength(0);
    expect(critic.calls).toHaveLength(0);
  });

  test('a fresh entry discards a stale resumable position instead of inheriting it', async () => {
    // Row 36 recovery re-queues at `pending`; a leftover mid-round position
    // from an earlier attempt must not seed the new one.
    const block = makeBlock();
    block.pendingRetry = {
      role: 'critic',
      round: 1,
      attempt: 1,
      failureKind: 'timeout',
      draft: refinerRecord(),
      recordedAt: NOW,
    };
    const { result } = await run({ block });
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.pendingRetry).toBeUndefined();
  });
});

describe('issue-refinement loop — role resolution (§7.3, §12 rows 8/9)', () => {
  test('an unassigned critic escalates no_independent_critic without a snapshot', async () => {
    const { result, calls } = await run({ block: makeBlock({ criticAgent: undefined }) });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'no_independent_critic' });
    expect(calls).toHaveLength(0); // no snapshot read was spent
    expect(result.block.predecessorFingerprint).toBeNull();
  });

  test('the critic must not be the same agent as the refiner', async () => {
    const { result } = await run({
      block: makeBlock({ refinerAgent: 'claude', criticAgent: 'claude' }),
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'no_independent_critic' });
    const event = result.events.find((e) => e.type === 'refinement.escalated.human');
    expect(event.data.detail).toBe('same-agent');
  });

  test('the default capability table fails closed for agents without a read-only profile', async () => {
    const { result } = await run({
      block: makeBlock({ criticAgent: 'gemini' }),
      deps: { resolveRoleProfile: undefined, env: {} },
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'no_independent_critic' });
    const event = result.events.find((e) => e.type === 'refinement.escalated.human');
    expect(event.data.detail).toBe('critic-profile:gemini');
  });

  test('the default capability table resolves a claude/codex pair to a runnable cross-provider run', async () => {
    const { result } = await run({ deps: { resolveRoleProfile: undefined, env: {} } });
    expect(result.outcome).toEqual({ kind: 'accepted' });
    const event = result.events.find((e) => e.type === 'refinement.roles.resolved');
    expect(event.data.refiner).toMatchObject({ agentId: 'claude', provider: 'anthropic', toolPolicy: 'no-tools' });
    expect(event.data.critic).toMatchObject({ agentId: 'codex', provider: 'openai', toolPolicy: 'no-tools' });
    expect(event.data.crossProvider).toBe(true);
  });

  test('resolved roles are recorded with agent, provider, model, and effort', async () => {
    const { result } = await run();
    const event = result.events.find((e) => e.type === 'refinement.roles.resolved');
    expect(event.data.refiner).toMatchObject({ agentId: 'claude', provider: 'anthropic', model: 'opus' });
    expect(event.data.critic).toMatchObject({ agentId: 'codex', provider: 'openai' });
    expect(event.data.crossProvider).toBe(true);
  });
});

describe('issue-refinement loop — topology proposals fail closed (§9, §12 rows 14-16)', () => {
  const proposal = { kind: 'split', rationale: 'two deliverables in one Issue', disposition: 'advisory' };

  test('pass with both parties advisory: accepted, proposals recorded, never applied', async () => {
    const refiner = makeAgent([ok(fenced(refinerRecord({ topologyProposals: [proposal] })))]);
    const critic = makeAgent([
      ok(fenced(criticRecord({ topologyDispositions: [{ index: 0, disposition: 'advisory' }] }))),
    ]);
    const { result } = await run({ refiner, critic });
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.events.map((e) => e.type)).toContain('refinement.topology.recorded');
    expect(result.block.accepted.topology[0].effective).toBe('advisory');
  });

  test('pass with a blocking proposal escalates topology_change_required', async () => {
    const refiner = makeAgent([
      ok(fenced(refinerRecord({ topologyProposals: [{ ...proposal, disposition: 'blocking' }] }))),
    ]);
    const critic = makeAgent([
      ok(fenced(criticRecord({ topologyDispositions: [{ index: 0, disposition: 'advisory' }] }))),
    ]);
    const { result } = await run({ refiner, critic });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'topology_change_required' });
    expect(result.block.accepted).toBeUndefined();
  });

  test('a critic that omits its disposition makes the proposal blocking', async () => {
    const refiner = makeAgent([ok(fenced(refinerRecord({ topologyProposals: [proposal] })))]);
    const { result } = await run({ refiner });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'topology_change_required' });
  });
});

describe('issue-refinement loop — snapshot outcomes (§12 rows 3-7, 10)', () => {
  test('a chainless Issue escalates not_chain_scoped', async () => {
    const { result } = await run({ blockedBy: [] });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'not_chain_scoped' });
  });

  test('an unready predecessor holds without moving state or counters', async () => {
    const world = defaultWorld();
    world[10] = predecessor(10, { pr: null });
    const { result, refiner } = await run({ world });
    expect(result.outcome).toEqual({ kind: 'hold', reason: 'predecessor_not_ready' });
    expect(result.taskStatus).toBeNull();
    expect(result.block.state).toBe('pending');
    expect(result.block.counters.rounds).toBe(0);
    expect(refiner.calls).toHaveLength(0);
  });

  test('a provider failure is snapshot_failed, retried later, never "no blockers"', async () => {
    const { result } = await run({ sourceOpts: { blockedByThrows: 'network down' } });
    expect(result.outcome.kind).toBe('snapshot_failed');
    expect(result.outcome.stage).toBe('blocked_by');
    expect(result.block.state).toBe('pending');
    expect(result.taskStatus).toBeNull();
  });

  test('a failing target read is snapshot_failed at stage issue', async () => {
    const { result } = await run({ sourceOpts: { readIssueThrows: 500 } });
    expect(result.outcome).toMatchObject({ kind: 'snapshot_failed', stage: 'issue' });
  });

  test('a terminal block is refused untouched', async () => {
    const block = makeBlock();
    block.state = 'escalated_human';
    const { result } = await run({ block });
    expect(result.outcome).toEqual({ kind: 'refused', detail: 'state:escalated_human' });
    expect(result.events).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §7.1/§7.2/§17 — schemas and fail-closed validation
// ---------------------------------------------------------------------------

function snapshotStub() {
  return {
    predecessorFingerprint: 'f'.repeat(64),
    predecessors: [{ issueNumber: 10, pullRequest: { number: 910, headSha: sha(10) } }],
    target: {},
    manifest: {},
  };
}

describe('refiner response validation (§7.1, §17)', () => {
  const parse = (record, max = 16000) =>
    parseRefinerResponse(fenced(record), snapshotStub(), max);

  test('a well-formed response renders a bounded managed region', () => {
    const result = parse(refinerRecord());
    expect(result.ok).toBe(true);
    expect(result.renderedRegion.startsWith('<!-- ai-refinement:begin fingerprint=ffffffffffff -->')).toBe(true);
    expect(result.regionBytes).toBeGreaterThan(0);
  });

  test('the rendered region round-trips through scanManagedRegion', () => {
    const result = parse(refinerRecord());
    const scan = scanManagedRegion(`Operator prose.\n\n${result.renderedRegion}`);
    expect(scan.shape).toBe('present');
    expect(scan.fingerprintPrefix).toBe('ffffffffffff');
    expect(scan.sourceBody).toBe('Operator prose.');
  });

  test.each([
    ['missing field', refinerRecord({ summary: undefined }), 'missing-field:summary'],
    ['unknown field (labels are not in the schema)', refinerRecord({ labels: ['x'] }), 'unknown-field:labels'],
    ['bad enum', refinerRecord({ confidence: 'certain' }), 'invalid-field:confidence'],
    ['reference to an Issue absent from the snapshot', refinerRecord({
      predecessorReferences: [{ issueNumber: 99, prNumber: 910, headSha: sha(1), decision: 'x' }],
    }), 'predecessor-reference-unknown:0'],
    ['reference to a PR absent from the snapshot', refinerRecord({
      predecessorReferences: [{ issueNumber: 10, prNumber: 111, headSha: sha(1), decision: 'x' }],
    }), 'predecessor-reference-unknown:0'],
    ['reference with a head SHA that is not the snapshot head', refinerRecord({
      predecessorReferences: [{ issueNumber: 10, prNumber: 910, headSha: sha(1), decision: 'x' }],
    }), 'predecessor-reference-unknown:0'],
  ])('%s is malformed', (_name, record, detail) => {
    const result = parse(record);
    expect(result.ok).toBe(false);
    expect(result.malformed).toContain(detail);
  });

  test('managed-region marker injection is malformed', () => {
    const raw = `<!-- ai-refinement:begin fingerprint=abc -->\n${fenced(refinerRecord())}`;
    const result = parseRefinerResponse(raw, snapshotStub(), 16000);
    expect(result).toEqual({ ok: false, malformed: ['marker-injection'] });
  });

  test('an absolute filesystem path anywhere in the output is malformed', () => {
    const result = parse(refinerRecord({ summary: 'See /Users/moto/secret/notes.txt for details' }));
    expect(result).toEqual({ ok: false, malformed: ['path-injection'] });
  });

  test('a marker smuggled through JSON unicode escapes is malformed after decoding', () => {
    // The raw text carries no literal marker — only escapes that JSON.parse
    // decodes into one — so the pre-parse §17 pass alone would admit it.
    const body = JSON.stringify(refinerRecord(), null, 2).replace(
      '"Refined summary grounded in predecessor outcomes."',
      '"\\u003c!-- ai-refinement:begin fingerprint=abc --\\u003e"',
    );
    const raw = `Result.\n\`\`\`json\n${body}\n\`\`\`\n`;
    expect(raw.includes('<!--')).toBe(false);
    const result = parseRefinerResponse(raw, snapshotStub(), 16000);
    expect(result).toEqual({ ok: false, malformed: ['marker-injection'] });
  });

  test('an absolute path smuggled through JSON unicode escapes is malformed after decoding', () => {
    const body = JSON.stringify(refinerRecord(), null, 2).replace(
      '"Refined summary grounded in predecessor outcomes."',
      '"See \\u002fUsers\\u002fmoto\\u002fsecret\\u002fnotes.txt for details"',
    );
    const raw = `Result.\n\`\`\`json\n${body}\n\`\`\`\n`;
    expect(raw.includes('/Users')).toBe(false);
    const result = parseRefinerResponse(raw, snapshotStub(), 16000);
    expect(result).toEqual({ ok: false, malformed: ['path-injection'] });
  });

  test('a rendered region above the cap is malformed, not truncated', () => {
    const result = parse(refinerRecord(), 64);
    expect(result).toEqual({ ok: false, malformed: ['region-too-large'] });
  });

  test('a list past the bound is rejected, not truncated', () => {
    const result = parse(refinerRecord({ risks: Array.from({ length: 33 }, (_, i) => `r${i}`) }));
    expect(result.ok).toBe(false);
    expect(result.malformed).toContain('list-too-long:risks');
  });
});

describe('critic response validation (§7.2, §17)', () => {
  test('pass with objections is malformed', () => {
    const result = parseCriticResponse(fenced(criticRecord({ objections: [objection] })));
    expect(result).toEqual({ ok: false, malformed: ['pass-with-objections'] });
  });

  test('revise without objections is malformed', () => {
    const result = parseCriticResponse(fenced(criticRecord({ verdict: 'revise' })));
    expect(result).toEqual({ ok: false, malformed: ['revise-without-objections'] });
  });

  test('replacement prose is named as such (§7.2: the critic never authors)', () => {
    const result = parseCriticResponse(
      fenced(criticRecord({ summary: 'Here is my better rewrite.' })),
    );
    expect(result.ok).toBe(false);
    expect(result.malformed).toContain('replacement-prose:summary');
  });

  test('unknown enum literals are malformed', () => {
    const result = parseCriticResponse(
      fenced(criticRecord({ verdict: 'revise', objections: [{ ...objection, kind: 'meh' }] })),
    );
    expect(result.ok).toBe(false);
    expect(result.malformed).toContain('invalid-field:objections[0]');
  });

  test('a path smuggled through JSON unicode escapes in an objection detail is malformed after decoding', () => {
    const body = JSON.stringify(criticRecord({ verdict: 'revise', objections: [objection] }), null, 2)
      .replace('"claim has no snapshot basis"', '"see \\u002fetc\\u002fpasswd"');
    const raw = `Verdict.\n\`\`\`json\n${body}\n\`\`\`\n`;
    expect(raw.includes('/etc')).toBe(false);
    const result = parseCriticResponse(raw);
    expect(result).toEqual({ ok: false, malformed: ['path-injection'] });
  });
});

describe('fenced-record extraction (§17)', () => {
  test('exactly one fenced JSON object is required', () => {
    expect(extractRefinementRecord('no fences').ok).toBe(false);
    expect(extractRefinementRecord('```json\n{"a":1}\n```\n```json\n{"b":2}\n```')).toEqual({
      ok: false,
      detail: 'multiple-json-objects',
    });
  });

  test('an unparseable fenced block is fatal even beside a clean one', () => {
    const raw = '```json\n{oops\n```\n```json\n{"a":1}\n```';
    expect(extractRefinementRecord(raw)).toEqual({ ok: false, detail: 'unparseable-json-block' });
  });

  test('readable non-object blocks are ignored', () => {
    const raw = '```json\n[1,2]\n```\n```json\n{"a":1}\n```';
    expect(extractRefinementRecord(raw)).toEqual({ ok: true, record: { a: 1 } });
  });
});

describe('topology combination (§9)', () => {
  const advisory = { kind: 'split', rationale: 'r', disposition: 'advisory' };

  test('advisory requires BOTH parties; anything else is blocking', () => {
    expect(combineTopologyDispositions([advisory], [{ index: 0, disposition: 'advisory' }]).anyBlocking).toBe(false);
    expect(combineTopologyDispositions([advisory], []).anyBlocking).toBe(true);
    expect(combineTopologyDispositions([advisory], [{ index: 0, disposition: 'blocking' }]).anyBlocking).toBe(true);
    expect(combineTopologyDispositions([{ ...advisory, disposition: 'blocking' }], [{ index: 0, disposition: 'advisory' }]).anyBlocking).toBe(true);
  });

  test('an unattributable entry fails every proposal closed', () => {
    const combined = combineTopologyDispositions(
      [advisory],
      [{ index: 0, disposition: 'advisory' }, 'garbage'],
    );
    expect(combined.anyBlocking).toBe(true);
  });

  test('an index that does not exist fails closed', () => {
    const combined = combineTopologyDispositions(
      [advisory],
      [{ index: 0, disposition: 'advisory' }, { index: 5, disposition: 'advisory' }],
    );
    expect(combined.anyBlocking).toBe(true);
  });

  test('no proposals means nothing can block', () => {
    expect(combineTopologyDispositions([], []).anyBlocking).toBe(false);
  });
});

describe('role independence (§7.3)', () => {
  const claude = { agentId: 'claude', provider: 'anthropic', model: 'opus' };
  const codex = { agentId: 'codex', provider: 'openai', model: 'gpt-5' };

  test('cross-provider pairs are accepted outright', () => {
    expect(evaluateRefinementRoleIndependence(claude, codex, false)).toEqual({
      ok: true,
      crossProvider: true,
      sameProviderFallback: false,
    });
  });

  test('the same agent is never an independent critic, opt-in or not', () => {
    expect(evaluateRefinementRoleIndependence(claude, claude, true)).toEqual({
      ok: false,
      rejection: 'same-agent',
    });
  });

  test('same provider needs the explicit opt-in and two known, distinct models', () => {
    const sonnet = { agentId: 'codex', provider: 'anthropic', model: 'sonnet' };
    expect(evaluateRefinementRoleIndependence(claude, sonnet, false).rejection).toBe(
      'same-provider-not-allowed',
    );
    expect(
      evaluateRefinementRoleIndependence(claude, { ...sonnet, model: 'cli-default' }, true).rejection,
    ).toBe('same-provider-model-unknown');
    expect(
      evaluateRefinementRoleIndependence(claude, { ...sonnet, model: 'opus' }, true).rejection,
    ).toBe('same-model');
    expect(evaluateRefinementRoleIndependence(claude, sonnet, true)).toEqual({
      ok: true,
      crossProvider: false,
      sameProviderFallback: true,
    });
  });
});

describe('supporting checks', () => {
  test('containsFilesystemPath flags absolute, home, traversal — not repo-relative', () => {
    expect(containsFilesystemPath('see /Users/moto/x/y')).toBe(true);
    expect(containsFilesystemPath('wrote to /tmp')).toBe(true);
    expect(containsFilesystemPath('read /etc for config')).toBe(true);
    expect(containsFilesystemPath('open ~/notes')).toBe(true);
    expect(containsFilesystemPath('go ../up/../../etc')).toBe(true);
    expect(containsFilesystemPath('C:\\Users\\x')).toBe(true);
    expect(containsFilesystemPath('src/core/foo.ts and/or docs')).toBe(false);
    expect(containsFilesystemPath('https://github.com/a/b/issues/1')).toBe(false);
  });

  test('resolveRefinementRoleProfile: claude gets the no-tools argv; codex the read-only sandbox; others fail closed', () => {
    const resolved = resolveRefinementRoleProfile('refiner', 'claude', {});
    expect('profile' in resolved).toBe(true);
    expect(resolved.profile.argv).toContain('--disallowedTools');
    expect(resolved.profile.argv).toContain('--safe-mode');
    expect(resolved.profile.model).toBe('opus');
    expect(resolved.profile.effort).toBe('high');
    expect(resolved.profile.toolPolicy).toBe('no-tools');

    const codex = resolveRefinementRoleProfile('critic', 'codex', {});
    expect('profile' in codex).toBe(true);
    expect(codex.profile.cmd).toBe('codex');
    expect(codex.profile.provider).toBe('openai');
    expect(codex.profile.argv).toEqual([
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high',
    ]);
    expect(codex.profile.model).toBeUndefined(); // CLI default: absent stays absent
    expect(codex.profile.toolPolicy).toBe('no-tools');

    const codexEnv = resolveRefinementRoleProfile('critic', 'codex', {
      CODEX_MODEL: 'gpt-5-codex',
      CODEX_EFFORT: 'medium',
    });
    expect(codexEnv.profile.argv.slice(0, 2)).toEqual(['--model', 'gpt-5-codex']);
    expect(codexEnv.profile.argv).toContain('model_reasoning_effort=medium');
    expect(codexEnv.profile.modelSource).toBe('env');
    expect(codexEnv.profile.effortSource).toBe('env');

    expect('error' in resolveRefinementRoleProfile('critic', 'gemini', {})).toBe(true);
  });

  test('default failure classifier: ENOENT is final, timeout and exits retry', () => {
    expect(
      defaultRefinementFailureClassifier({ stdout: '', stderr: '', exitCode: -1, spawnError: 'spawn claude ENOENT' })
        .retryable,
    ).toBe(false);
    expect(
      defaultRefinementFailureClassifier({ stdout: '', stderr: '', exitCode: -1, spawnError: 'ETIMEDOUT' }),
    ).toEqual({ retryable: true, kind: 'timeout' });
    expect(defaultRefinementFailureClassifier({ stdout: '', stderr: 'x', exitCode: 1 }).retryable).toBe(true);
  });

  test('the default runner spawns the profile argv with the prompt on stdin in an isolated cwd', () => {
    const runs = [];
    const runner = {
      run(cmd, args, opts) {
        runs.push({ cmd, args, opts });
        return ok('x');
      },
    };
    const resolved = resolveRefinementRoleProfile('critic', 'claude', {});
    const agent = createRefinementAgentRunner(resolved.profile, runner, {
      GH_TOKEN: 'secret',
      PATH: '/usr/bin',
    });
    agent({ prompt: 'PROMPT', timeoutMs: 123 });
    expect(runs).toHaveLength(1);
    expect(runs[0].cmd).toBe('claude');
    expect(runs[0].args).toContain('--safe-mode');
    expect(runs[0].opts.stdin).toBe('PROMPT');
    expect(runs[0].opts.timeout).toBe(123);
    // §7.3: write-enabling env stripped, throwaway cwd — no target worktree.
    expect(runs[0].opts.env.GH_TOKEN).toBeUndefined();
    expect(runs[0].opts.cwd).not.toBe(process.cwd());
  });

  test('renderManagedRegion is deterministic for the same contract', () => {
    const contract = parseRefinerResponse(fenced(refinerRecord()), snapshotStub(), 16000).contract;
    expect(renderManagedRegion(contract, 'a'.repeat(64))).toBe(
      renderManagedRegion(contract, 'a'.repeat(64)),
    );
  });

  test('a revision prompt carries the previous draft and the objections only', () => {
    const world = defaultWorld();
    const prompt = buildRefinerPrompt({
      snapshot: {
        predecessorFingerprint: 'f'.repeat(64),
        predecessors: [],
        target: { issueNumber: 500, title: 't' },
        manifest: {},
      },
      nonce: 'aaaa',
      round: 2,
      previousContract: refinerRecord(),
      objections: [objection],
    });
    expect(prompt).toContain('REVISION round');
    expect(prompt).toContain('unsupported');
    expect(world[10].issue.number).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Phase-runner adapter (issue #869 review follow-up)
// ---------------------------------------------------------------------------

describe('createRefinementHandler — phase-runner adapter', () => {
  const handlerSession = (overrides = {}) => ({
    sessionId: 'addon-dev',
    artifactRoot: tmpDir,
    labels: { stackReady: STACK_READY },
    issueRefinement: { enabled: true, agents: { refiner: 'claude', critic: 'codex' } },
    ...overrides,
  });

  const refinementTask = () => ({
    sessionId: 'addon-dev',
    issueNumber: 500,
    phase: 'refinement',
    context: { refinement: makeBlock() },
  });

  test('an accepted run maps to success carrying the block and its audit events', async () => {
    const { port } = makeSource(defaultWorld(), { blockedBy: [{ issueNumber: 10, state: 'open' }] });
    const refiner = makeAgent([ok(fenced(refinerRecord()))]);
    const critic = makeAgent([ok(fenced(criticRecord()))]);
    const handler = createRefinementHandler(
      { session: handlerSession(), runId: 'run-h1', workerId: 'w' },
      {
        source: port,
        refinerAgent: (inv) => refiner.run(inv),
        criticAgent: (inv) => critic.run(inv),
        resolveRoleProfile: fakeProfileResolver,
      },
    );

    const result = await handler(refinementTask());

    expect(result.result).toBe('success');
    expect(result.context.refinement.state).toBe('accepted');
    expect(result.extraEvents.map((e) => e.type)).toContain('refinement.critique.passed');
  });

  test('an escalation maps to blocked (ready_for_human routing) with the handoff block', async () => {
    const { port } = makeSource(defaultWorld(), { blockedBy: [{ issueNumber: 10, state: 'open' }] });
    const refiner = makeAgent([ok(fenced(refinerRecord()))]);
    const critic = makeAgent([ok(fenced(criticRecord({ verdict: 'block' })))]);
    const handler = createRefinementHandler(
      { session: handlerSession(), runId: 'run-h2', workerId: 'w' },
      {
        source: port,
        refinerAgent: (inv) => refiner.run(inv),
        criticAgent: (inv) => critic.run(inv),
        resolveRoleProfile: fakeProfileResolver,
      },
    );

    const result = await handler(refinementTask());

    expect(result.result).toBe('blocked');
    expect(result.context.refinement.state).toBe('escalated_human');
    expect(result.extraEvents.map((e) => e.type)).toContain('refinement.escalated.human');
  });

  test('a retryable agent failure maps to delayed with the resumable block and no short retry override', async () => {
    const { port } = makeSource(defaultWorld(), { blockedBy: [{ issueNumber: 10, state: 'open' }] });
    const refiner = makeAgent([{ stdout: '', stderr: 'quota exhausted', exitCode: 1 }]);
    const critic = makeAgent([ok(fenced(criticRecord()))]);
    const handler = createRefinementHandler(
      { session: handlerSession(), runId: 'run-h5', workerId: 'w' },
      {
        source: port,
        refinerAgent: (inv) => refiner.run(inv),
        criticAgent: (inv) => critic.run(inv),
        resolveRoleProfile: fakeProfileResolver,
      },
    );

    const result = await handler(refinementTask());

    expect(result.result).toBe('delayed');
    // Rows 38/40 (§17): the runner's DEFAULT delayed cool-down is the
    // phase-level delay; the short refinement re-poll override must not apply.
    expect(result.retryAfterMs).toBeUndefined();
    expect(result.context.refinement.state).toBe('drafting');
    expect(result.context.refinement.pendingRetry).toMatchObject({ role: 'refiner', round: 1 });
    expect(result.extraEvents.map((e) => e.type)).toContain('refinement.agent.failed');
    // The failed provider was invoked exactly once — no synchronous re-run.
    expect(refiner.calls).toHaveLength(1);
  });

  test('a disabled lane fails closed without invoking the loop', async () => {
    const { port, calls } = makeSource(defaultWorld());
    const handler = createRefinementHandler(
      { session: handlerSession({ issueRefinement: { enabled: false } }), runId: 'run-h3', workerId: 'w' },
      { source: port },
    );

    const result = await handler(refinementTask());

    expect(result.result).toBe('failed');
    expect(result.error).toContain('disabled');
    expect(calls).toHaveLength(0);
  });

  test('a task without a refinement context block fails closed', async () => {
    const { port } = makeSource(defaultWorld());
    const handler = createRefinementHandler(
      { session: handlerSession(), runId: 'run-h4', workerId: 'w' },
      { source: port },
    );

    const result = await handler({ ...refinementTask(), context: {} });

    expect(result.result).toBe('failed');
    expect(result.error).toContain('context.refinement');
  });
});

// ---------------------------------------------------------------------------
// gh snapshot adapter — changed-path completeness (§5 truncation probe)
// ---------------------------------------------------------------------------

describe('gh snapshot source — readChangedPaths pagination', () => {
  function fileRow(i) {
    return { filename: `src/f${String(i).padStart(4, '0')}.ts`, additions: 1, deletions: 2 };
  }

  function sourceWithPages(pages) {
    const calls = [];
    const source = createGhRefinementSnapshotSource({
      githubRepo: 'm2dw/repo',
      artifactRoot: '/tmp/unused-artifacts',
      runGh: (args) => {
        calls.push(args);
        return JSON.stringify(pages[calls.length - 1] ?? []);
      },
    });
    return { source, calls };
  }

  test('a short first page is returned as an explicit complete listing', async () => {
    const { source, calls } = sourceWithPages([[fileRow(1), fileRow(2)]]);
    const result = await source.readChangedPaths(910, 101);
    expect(result).toEqual({
      paths: [
        { path: 'src/f0001.ts', added: 1, removed: 2 },
        { path: 'src/f0002.ts', added: 1, removed: 2 },
      ],
      complete: true,
    });
    expect(calls).toEqual([['api', 'repos/m2dw/repo/pulls/910/files?per_page=100&page=1']]);
  });

  test('a full page keeps paging past the probe limit and returns the drained set as complete', async () => {
    // 120 files: more than the default 100-path cap, so the pre-fix single
    // `gh pr view` read would have surfaced a bare 100-entry page that the
    // core must treat as possibly truncated. Draining both pages lets the
    // adapter assert completeness and the core cap deterministically.
    const pageOne = Array.from({ length: 100 }, (_, i) => fileRow(i + 1));
    const pageTwo = Array.from({ length: 20 }, (_, i) => fileRow(i + 101));
    const { source, calls } = sourceWithPages([pageOne, pageTwo]);
    const result = await source.readChangedPaths(910, 101);
    expect(result.complete).toBe(true);
    expect(result.paths).toHaveLength(120);
    expect(calls.map((args) => args[1])).toEqual([
      'repos/m2dw/repo/pulls/910/files?per_page=100&page=1',
      'repos/m2dw/repo/pulls/910/files?per_page=100&page=2',
    ]);
  });

  test('a listing still returning full pages at the provider ceiling is returned bare, never complete', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => fileRow(i + 1));
    const { source, calls } = sourceWithPages(Array.from({ length: 40 }, () => fullPage));
    const result = await source.readChangedPaths(910, 101);
    // A bare array (no `complete` assertion): the core reads it as possibly
    // truncated and fails closed past the cap instead of capturing a subset
    // chosen by provider listing order.
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3000);
    expect(calls).toHaveLength(30);
  });
});

// ---------------------------------------------------------------------------
// gh snapshot adapter — comment-history pagination (§16 idempotency scan)
// ---------------------------------------------------------------------------

describe('gh snapshot source — readIssueComments pagination', () => {
  function commentRow(i) {
    return {
      id: i,
      node_id: `IC_${i}`,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-02T00:00:00Z',
      body: `comment ${i}`,
    };
  }

  function sourceWithPages(pages) {
    const calls = [];
    const source = createGhRefinementSnapshotSource({
      githubRepo: 'm2dw/repo',
      artifactRoot: '/tmp/unused-artifacts',
      runGh: (args) => {
        calls.push(args);
        return JSON.stringify(pages[calls.length - 1] ?? []);
      },
    });
    return { source, calls };
  }

  test('the full-history scan drains every REST page, so a comment beyond the first page stays visible', async () => {
    // 130 comments: more than one page. The pre-fix `gh issue view --json
    // comments` read returned only its first GraphQL page, so a crashed
    // run's own audit comment sitting past it was invisible and the retry
    // posted a duplicate.
    const pageOne = Array.from({ length: 100 }, (_, i) => commentRow(i + 1));
    const pageTwo = Array.from({ length: 30 }, (_, i) => commentRow(i + 101));
    const { source, calls } = sourceWithPages([pageOne, pageTwo]);
    const comments = await source.readIssueComments(500, Number.MAX_SAFE_INTEGER);
    expect(comments).toHaveLength(130);
    // The GraphQL node id is preserved (§6 hashes it), REST field names are
    // mapped, and order is the provider's ascending order.
    expect(comments[0]).toEqual({
      id: 'IC_1',
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
      body: 'comment 1',
    });
    expect(comments[129].body).toBe('comment 130');
    expect(calls.map((args) => args[1])).toEqual([
      'repos/m2dw/repo/issues/500/comments?per_page=100&page=1',
      'repos/m2dw/repo/issues/500/comments?per_page=100&page=2',
    ]);
  });

  test('a bounded limit fetches only the tail pages the comment count locates, never draining the history', async () => {
    // 105 comments, window of 3: the Issue record's own comment count places
    // the window on page 2, and page 1 — 100 comments the snapshot would
    // discard anyway — is never requested. Draining the whole history for a
    // bounded window made every snapshot capture and re-verification of a
    // long-discussed predecessor unbounded in API work.
    const tail = Array.from({ length: 5 }, (_, i) => commentRow(i + 101));
    const { source, calls } = sourceWithPages([{ comments: 105 }, tail]);
    const comments = await source.readIssueComments(500, 3);
    expect(comments.map((c) => c.body)).toEqual(['comment 103', 'comment 104', 'comment 105']);
    expect(calls.map((args) => args[1])).toEqual([
      'repos/m2dw/repo/issues/500',
      'repos/m2dw/repo/issues/500/comments?per_page=100&page=2',
    ]);
  });

  test('a bounded window straddling a page boundary still keeps the most recent comments across both pages', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => commentRow(i + 1));
    const pageTwo = [commentRow(101)];
    const { source, calls } = sourceWithPages([{ comments: 101 }, pageOne, pageTwo]);
    const comments = await source.readIssueComments(500, 3);
    expect(comments.map((c) => c.body)).toEqual(['comment 99', 'comment 100', 'comment 101']);
    expect(calls.map((args) => args[1])).toEqual([
      'repos/m2dw/repo/issues/500',
      'repos/m2dw/repo/issues/500/comments?per_page=100&page=1',
      'repos/m2dw/repo/issues/500/comments?per_page=100&page=2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// gh snapshot adapter — registered-chain cross-check (§4 condition 5, row 6)
// ---------------------------------------------------------------------------

describe('gh snapshot source — chain registry cross-check (§4 condition 5)', () => {
  function chainRecord(overrides = {}) {
    return {
      chainId: 'chain_500',
      sessionId: 'addon-dev',
      originIssueNumber: 500,
      headIssueNumber: 500,
      graphRevision: 1,
      graphFingerprint: 'f',
      acceptedRevision: 1,
      syncStatus: 'unknown',
      createdAt: NOW,
      updatedAt: NOW,
      rev: 1,
      ...overrides,
    };
  }

  function graphWithBlockers(chain, blockers) {
    return {
      chain,
      members: [{ chainId: chain.chainId, issueNumber: 500, role: 'head', addedAt: NOW }],
      edges: blockers.map((b) => ({
        chainId: chain.chainId,
        blockerIssueNumber: b,
        blockedIssueNumber: 500,
        createdAt: NOW,
      })),
    };
  }

  function fakeRegistry({ chains = [], graphs = {} } = {}) {
    const calls = [];
    return {
      calls,
      listChainsForIssue: async (issueNumber, filter) => {
        calls.push(['list', issueNumber, filter]);
        return chains;
      },
      getChain: async (chainId) => {
        calls.push(['get', chainId]);
        return graphs[chainId];
      },
      close() {
        calls.push(['close']);
      },
    };
  }

  function ghlessSource(chainAgreement) {
    return createGhRefinementSnapshotSource({
      githubRepo: 'm2dw/repo',
      artifactRoot: '/tmp/unused-artifacts',
      runGh: () => {
        throw new Error('no gh in this test');
      },
      ...(chainAgreement ? { chainAgreement } : {}),
    });
  }

  test('an unregistered issue takes no side, scoped to this session', async () => {
    const registry = fakeRegistry();
    const agreement = await readChainAgreementFromRegistry(registry, 'addon-dev', 500, [10]);
    expect(agreement).toEqual({ kind: 'unregistered' });
    expect(registry.calls).toContainEqual(['list', 500, { sessionId: 'addon-dev' }]);
  });

  test('an accepted revision matching the observed set agrees, whatever the order and duplication', async () => {
    const chain = chainRecord();
    const registry = fakeRegistry({
      chains: [chain],
      graphs: { chain_500: graphWithBlockers(chain, [11, 10, 10]) },
    });
    const agreement = await readChainAgreementFromRegistry(registry, 'addon-dev', 500, [10, 11, 11]);
    expect(agreement).toEqual({ kind: 'agrees' });
  });

  test('a live blocked-by set differing from the accepted revision disagrees, naming both directions', async () => {
    const chain = chainRecord();
    const registry = fakeRegistry({
      chains: [chain],
      graphs: { chain_500: graphWithBlockers(chain, [10, 12]) },
    });
    const agreement = await readChainAgreementFromRegistry(registry, 'addon-dev', 500, [10, 13]);
    expect(agreement.kind).toBe('disagrees');
    expect(agreement.detail).toContain('#12');
    expect(agreement.detail).toContain('#13');
  });

  test('multi-chain membership, no accepted revision, and a stale accepted revision all fail closed as disagreement', async () => {
    const two = await readChainAgreementFromRegistry(
      fakeRegistry({ chains: [chainRecord(), chainRecord({ chainId: 'chain_600' })] }),
      'addon-dev',
      500,
      [10],
    );
    expect(two.kind).toBe('disagrees');
    expect(two.detail).toContain('chain_500');
    expect(two.detail).toContain('chain_600');

    const unaccepted = await readChainAgreementFromRegistry(
      fakeRegistry({ chains: [chainRecord({ acceptedRevision: undefined })] }),
      'addon-dev',
      500,
      [10],
    );
    expect(unaccepted.kind).toBe('disagrees');
    expect(unaccepted.detail).toContain('no accepted revision');

    // The store persists members/edges for the CURRENT graph revision only, so
    // an accepted pointer at an older revision has no reconstructible edge set.
    const stale = await readChainAgreementFromRegistry(
      fakeRegistry({ chains: [chainRecord({ graphRevision: 3, acceptedRevision: 1 })] }),
      'addon-dev',
      500,
      [10],
    );
    expect(stale.kind).toBe('disagrees');
    expect(stale.detail).toContain('accepted revision 1');
  });

  test('the source implements readChainAgreement only when chain wiring is supplied, closing the registry per read', async () => {
    expect(ghlessSource().readChainAgreement).toBeUndefined();

    const registry = fakeRegistry();
    const source = ghlessSource({ sessionId: 'addon-dev', openRegistry: () => registry });
    await expect(source.readChainAgreement(500, [10])).resolves.toEqual({ kind: 'unregistered' });
    expect(registry.calls[registry.calls.length - 1]).toEqual(['close']);
  });

  test('end to end against the SQLite registry: a registered accepted chain gates on the observed set', async () => {
    const chainDb = join(mkdtempSync(join(tmpdir(), 'chain-agree-')), 'chains.db');
    const store = new SqliteChainRegistryStore(chainDb);
    try {
      const created = await store.createChain({
        sessionId: 'addon-dev',
        headIssueNumber: 500,
        members: [{ issueNumber: 500, role: 'head' }, { issueNumber: 10 }],
        edges: [{ blockerIssueNumber: 10, blockedIssueNumber: 500 }],
        now: NOW,
      });
      expect(created.ok).toBe(true);
      const accepted = await store.setAcceptedRevision(created.value.chain.chainId, 1, { now: NOW });
      expect(accepted.ok).toBe(true);
    } finally {
      store.close();
    }

    const source = ghlessSource({ sessionId: 'addon-dev', dbPath: chainDb });
    await expect(source.readChainAgreement(500, [10])).resolves.toEqual({ kind: 'agrees' });

    const drifted = await source.readChainAgreement(500, [10, 11]);
    expect(drifted.kind).toBe('disagrees');
    expect(drifted.detail).toContain('#11');

    // Another session's chains are out of scope: the same issue number reads
    // as unregistered under a different sessionId.
    const other = ghlessSource({ sessionId: 'other-session', dbPath: chainDb });
    await expect(other.readChainAgreement(500, [10])).resolves.toEqual({ kind: 'unregistered' });
  });
});

// ---------------------------------------------------------------------------
// CLI — persistence through the task store
// ---------------------------------------------------------------------------

describe('admin refinement run — CLI', () => {
  let sessionsPath;
  let dbPath;
  let store;

  const SESSION = () => ({
    sessionId: 'addon-dev',
    repoKey: 'repo',
    repoRoot: tmpDir,
    githubRepo: 'm2dw/repo',
    artifactDir: '.artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    issueRefinement: { enabled: true, agents: { refiner: 'claude', critic: 'codex' } },
  });

  beforeEach(async () => {
    sessionsPath = join(tmpDir, 'sessions.json');
    dbPath = join(tmpDir, 'tasks.db');
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [SESSION()] }), 'utf8');
    store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 500,
      phase: 'refinement',
      context: { title: 'Downstream Issue', refinement: makeBlock() },
    });
  });

  function capture(fn) {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    return Promise.resolve()
      .then(fn)
      .then(() => {
        process.stdout.write = original;
        return JSON.parse(chunks.join(''));
      })
      .catch((err) => {
        process.stdout.write = original;
        throw err;
      });
  }

  function cliDeps(overrides = {}) {
    const { port } = makeSource(defaultWorld(), { blockedBy: [{ issueNumber: 10, state: 'open' }] });
    return {
      store,
      source: port,
      issueLock: new IssueWorktreeLock(join(tmpDir, 'locks')),
      refinerAgent: (inv) => makeAgent([ok(fenced(refinerRecord()))]).run(inv),
      criticAgent: (inv) => makeAgent([ok(fenced(criticRecord()))]).run(inv),
      resolveRoleProfile: fakeProfileResolver,
      runId: 'run-cli',
      ...overrides,
    };
  }

  const ARGS = () => ({
    sessionId: 'addon-dev',
    issueNumber: 500,
    sessionsPath,
    dbPath,
    timeoutMs: 5000,
  });

  test('a critic pass persists the accepted block and leaves the task queued for the apply run', async () => {
    const output = await capture(() => runRefinementRun(ARGS(), cliDeps()));
    expect(output.outcome).toEqual({ kind: 'accepted' });
    expect(output.taskStatus).toBeNull();

    // Routed exactly like the phase runner routes a refinement `success`
    // since the application slice exists (issue #870): the row stays `queued`
    // at this phase, and the next normal tick — or a re-run of this command —
    // continues the same block into the application walk.
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 500 });
    expect(task.status).toBe('queued');
    expect(task.context.refinement.state).toBe('accepted');
    expect(task.context.refinement.execution.critic.provider).toBe('openai');

    const events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 500 });
    const types = events.map((e) => e.type);
    expect(types).toContain('refinement.roles.resolved');
    expect(types).toContain('refinement.critique.passed');

    // The issue lock is released on the way out.
    expect(new IssueWorktreeLock(join(tmpDir, 'locks')).inspect('addon-dev', 500).locked).toBe(false);
  });

  test('the block, status, and audit events commit through one transactional store call', async () => {
    const calls = [];
    const recording = {
      getTask: (key) => store.getTask(key),
      transitionTask: (...args) => {
        calls.push('transitionTask');
        return store.transitionTask(...args);
      },
      appendEvent: (event) => {
        calls.push('appendEvent');
        return store.appendEvent(event);
      },
      completePhaseWithEffects: (transition, effects) => {
        calls.push({
          method: 'completePhaseWithEffects',
          events: [transition.event.type, ...(transition.extraEvents ?? []).map((e) => e.type)],
          effects: effects.length,
        });
        return store.completePhaseWithEffects(transition, effects);
      },
    };
    const output = await capture(() => runRefinementRun(ARGS(), cliDeps({ store: recording })));
    expect(output.outcome).toEqual({ kind: 'accepted' });

    // No separate transition + append pair: a failed event write must refuse
    // the whole commit, never strand a terminal block without its audit trail.
    expect(calls.filter((c) => c === 'appendEvent' || c === 'transitionTask')).toHaveLength(0);
    const commits = calls.filter((c) => c.method === 'completePhaseWithEffects');
    expect(commits).toHaveLength(1);
    expect(commits[0].effects).toBe(0);
    expect(commits[0].events).toEqual(output.events);

    const persisted = (await store.listEvents({ sessionId: 'addon-dev', issueNumber: 500 }))
      .map((e) => e.type)
      .filter((t) => t.startsWith('refinement.'));
    expect(persisted).toEqual(output.events);
  });

  test('an escalation persists ready_for_human and the handoff reason', async () => {
    const output = await capture(() =>
      runRefinementRun(
        ARGS(),
        cliDeps({ criticAgent: (inv) => makeAgent([ok(fenced(criticRecord({ verdict: 'block' })))]).run(inv) }),
      ),
    );
    expect(output.outcome).toEqual({ kind: 'escalated', reason: 'critique_blocked' });

    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 500 });
    expect(task.status).toBe('ready_for_human');
    expect(task.context.refinement.state).toBe('escalated_human');
    expect(task.context.refinement.handoffReason).toBe('critique_blocked');
  });

  // Issue #936: an operator running the lane by hand and an unattended tick
  // running it must leave the SAME public trace, or a handoff raised here would
  // be exactly as invisible from GitHub as the one #936 was filed for.
  test('an escalation publishes the §13 ready-for-human label and handoff comment through the outbox', async () => {
    await capture(() =>
      runRefinementRun(
        ARGS(),
        cliDeps({ criticAgent: (inv) => makeAgent([ok(fenced(criticRecord({ verdict: 'block' })))]).run(inv) }),
      ),
    );

    const outbox = new SqliteOutboxStore(dbPath);
    try {
      const rows = await outbox.listUnsent();
      expect(rows.map((r) => r.topic)).toEqual(['gh:label:add', 'gh:comment']);
      expect(rows[0].payload).toMatchObject({ issueNumber: 500, label: 'ai:ready-for-human' });
      const body = rows[1].payload.body;
      expect(body).toContain('`critique_blocked`');
      expect(body).toContain('`escalated_human`');
      // §16: the role metadata is configuration, never the run id or a path.
      expect(body).toContain('`claude`');
      expect(body).not.toContain('run-cli');
      expect(body).not.toContain(tmpDir);
    } finally {
      outbox.close();
    }
  });

  test('an accepted run publishes nothing — only a handoff is public', async () => {
    await capture(() => runRefinementRun(ARGS(), cliDeps()));
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      expect(await outbox.listUnsent()).toHaveLength(0);
    } finally {
      outbox.close();
    }
  });

  test('a retryable agent failure persists the phase-level cool-down so the next tick cannot re-claim immediately', async () => {
    const output = await capture(() =>
      runRefinementRun(
        ARGS(),
        cliDeps({
          refinerAgent: (inv) => makeAgent([{ stdout: '', stderr: 'quota exhausted', exitCode: 1 }]).run(inv),
          now: () => Date.parse(NOW),
          env: {},
        }),
      ),
    );
    expect(output.outcome).toMatchObject({ kind: 'agent_retry', role: 'refiner' });
    expect(output.taskStatus).toBeNull();

    // Mirrors the phase runner's delayed release for the same outcome: the
    // DEFAULT quota cool-down (no short refinement re-poll override), anchored
    // on the run's logical clock. Without it the row stays immediately
    // claimable and the next five-minute tick re-runs the failed agent.
    const expected = new Date(Date.parse(NOW) + DEFAULT_QUOTA_RETRY_DELAY_MS).toISOString();
    expect(output.notBefore).toBe(expected);

    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 500 });
    expect(task.status).toBe('queued');
    expect(task.notBefore).toBe(expected);
    expect(task.context.refinement.pendingRetry).toMatchObject({ role: 'refiner', round: 1 });
  });

  test('an eligibility hold persists the short refinement re-poll window, not the quota delay', async () => {
    const world = defaultWorld();
    world[10] = predecessor(10, { pr: null });
    const { port } = makeSource(world, { blockedBy: [{ issueNumber: 10, state: 'open' }] });
    const output = await capture(() =>
      runRefinementRun(ARGS(), cliDeps({ source: port, now: () => Date.parse(NOW) })),
    );
    expect(output.outcome).toEqual({ kind: 'hold', reason: 'predecessor_not_ready' });
    expect(output.taskStatus).toBeNull();

    const expected = new Date(Date.parse(NOW) + REFINEMENT_RETRY_DELAY_MS).toISOString();
    expect(output.notBefore).toBe(expected);

    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 500 });
    expect(task.status).toBe('queued');
    expect(task.notBefore).toBe(expected);
  });

  test('a refused (terminal) block persists nothing', async () => {
    const terminal = makeBlock();
    terminal.state = 'activated';
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 500 },
      {},
      { context: { title: 'Downstream Issue', refinement: terminal } },
    );
    const key = { sessionId: 'addon-dev', issueNumber: 500 };
    const before = await store.getTask(key);
    const eventsBefore = (await store.listEvents(key)).length;
    const output = await capture(() => runRefinementRun(ARGS(), cliDeps()));
    expect(output.outcome).toEqual({ kind: 'refused', detail: 'state:activated' });
    const after = await store.getTask(key);
    expect(after.revision).toBe(before.revision);
    expect((await store.listEvents(key)).length).toBe(eventsBefore);
  });

  test('parseRefinementRunArgs validates its flags', () => {
    expect(parseRefinementRunArgs(['--issue-number', '5'])).toEqual({
      error: 'Missing required --session-id',
    });
    expect('error' in parseRefinementRunArgs(['--session-id', 's', '--issue-number', 'x'])).toBe(true);
    expect('error' in parseRefinementRunArgs(['--session-id', 's', '--issue-number', '5', '--nope', 'v'])).toBe(true);
    const parsed = parseRefinementRunArgs(['--session-id', 's', '--issue-number', '5']);
    expect(parsed.timeoutMs).toBe(600000);
  });

  test('a disabled lane is refused by the admin CLI before any agent runs', () => {
    const session = SESSION();
    delete session.issueRefinement;
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
    let failed = null;
    try {
      execFileSync(
        process.execPath,
        [
          ADMIN_CLI, 'refinement', 'run',
          '--session-id', 'addon-dev',
          '--issue-number', '500',
          '--sessions-path', sessionsPath,
          '--db-path', dbPath,
        ],
        { encoding: 'utf8' },
      );
    } catch (err) {
      failed = err;
    }
    expect(failed).not.toBeNull();
    expect(failed.status).toBe(1);
    expect(String(failed.stderr) + String(failed.stdout)).toContain('issueRefinement is disabled');
  }, 30_000);

  test('a held issue lock refuses the direct run before any task read or agent', async () => {
    const lockDir = join(tmpDir, 'locks');
    const holder = new IssueWorktreeLock(lockDir);
    expect(holder.acquire('tick-ctx-1', 'addon-dev', 500).locked).toBe(true);

    let failed = null;
    try {
      execFileSync(
        process.execPath,
        [
          ADMIN_CLI, 'refinement', 'run',
          '--session-id', 'addon-dev',
          '--issue-number', '500',
          '--sessions-path', sessionsPath,
          '--db-path', dbPath,
          '--lock-dir', lockDir,
        ],
        { encoding: 'utf8' },
      );
    } catch (err) {
      failed = err;
    }
    expect(failed).not.toBeNull();
    expect(failed.status).toBe(1);
    expect(String(failed.stderr) + String(failed.stdout)).toContain('already running');

    // The refused run touched nothing: the row is unchanged and the normal
    // tick's lock is still held by its owner.
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 500 });
    expect(task.status).toBe('queued');
    expect(holder.inspect('addon-dev', 500).locked).toBe(true);
    holder.release('tick-ctx-1', 'addon-dev', 500);
  }, 30_000);
});
