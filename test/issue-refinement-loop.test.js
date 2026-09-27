/**
 * Chain-aware progressive Issue refinement — the bounded two-agent loop
 * (issue #869, docs/issue-refinement-contract.md §7, §8, §9, §10, §12 rows
 * 8–21, §13, §15, §17).
 *
 * Covers the acceptance criteria of the Issue: normal pass, revise-then-pass,
 * round cap, malformed output per role, timeout/provider failure, role
 * independence, topology fail-closed, the no-GitHub-write surface, and the
 * per-role agent/company/model/effort/duration metadata.
 *
 * Issue #982 adds §9.1: proposals are normalized against the relationship
 * graph captured for the snapshot before their dispositions are read, so a
 * proposal the graph already satisfies (the reported #951/#950 run: adding an
 * edge that already existed) never spends a human handoff.
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
  REFINEMENT_RECORD_MAX_BYTES,
  REFINEMENT_TOPOLOGY_NORMALIZATIONS,
  SqliteChainRegistryStore,
  SqliteOutboxStore,
  SqliteTaskStore,
  buildCriticPrompt,
  buildRefinementContextBlock,
  buildRefinerPrompt,
  combineTopologyDispositions,
  containsFilesystemPath,
  evaluateRefinementRoleIndependence,
  extractRefinementRecord,
  normalizeTopologyProposals,
  parseCriticResponse,
  parseRefinerResponse,
  planRefinementRecovery,
  refinementEvidenceComplete,
  refinementRelationshipGraph,
  renderManagedRegion,
  renderRefinementLines,
  resolveIssueRefinementSettings,
  routeCriticVerdict,
  scanManagedRegion,
  summarizeRefinementStatus,
} from '../dist/index.js';
import { formatRefinementDetail } from '../dist/cli/admin-ui.js';
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
  // §5.1: an absent resolver is itself an outcome (`resolver_unavailable`), so
  // the port only grows the read when a test wires one.
  if (opts.evidence) {
    port.readPredecessorEvidence = async (request) => {
      calls.push(['readPredecessorEvidence', request.issueNumber, request.path]);
      return opts.evidence(request);
    };
  }
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

  // #999: a risk imported from an unrelated defect (not the target Issue or a
  // snapshot predecessor) is not grounded evidence — the critic rejects it as
  // `unsupported` and the refiner drops it, same as any other objection.
  test('a risk citing an unrelated defect is rejected as unsupported and dropped on revise', async () => {
    const unsupportedRiskObjection = {
      field: 'risks',
      kind: 'unsupported',
      detail: 'risk cites #998, which is not the target Issue or a snapshot predecessor',
    };
    const critic = makeAgent([
      ok(fenced(criticRecord({ verdict: 'revise', objections: [unsupportedRiskObjection] }))),
      ok(fenced(criticRecord())),
    ]);
    const refiner = makeAgent([
      ok(fenced(refinerRecord({ risks: ['risk one', 'unrelated risk from #998'] }))),
      ok(fenced(refinerRecord({ risks: ['risk one'] }))),
    ]);
    const { result } = await run({ refiner, critic });

    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.accepted.contract.risks).toEqual(['risk one']);
    expect(result.events.map((e) => e.type)).toContain('refinement.critique.revise');

    const secondPrompt = refiner.calls[1].prompt;
    expect(secondPrompt).toContain('unsupported');
    expect(secondPrompt).toContain('#998');
  });
});

// ---------------------------------------------------------------------------
// Issue #1176 — a draft that drops a requirement the Issue already states is a
// repairable omission: it goes back to the refiner through the SAME bounded
// revise rows (§12 17/18), and only genuine human blockers reach row 19.
// ---------------------------------------------------------------------------

describe('issue-refinement loop — repairable omissions (§7.2, #1176)', () => {
  // The two requirements the #1111 draft dropped, stated in the Issue itself.
  const MUTATION_LIMITS =
    'Mutation scores and coverage do not guarantee that every defect is detected, do not establish redundancy, and do not by themselves justify deleting a test; lost detection requires repair or restoration, or rejection of the optimization.';
  const PROHIBITIONS =
    'Do not introduce new runner policy, global locks, live sessions.json changes, or behavioral specification edits.';

  // #1111's Issue declared three predecessor excerpts, all captured whole.
  const SELECTIONS = [
    { issue: 10, path: 'src/core/test-maintenance.ts', export: 'MaintenanceCandidate' },
    { issue: 10, path: 'src/core/test-maintenance.ts', export: 'PilotSuite' },
    { issue: 10, path: 'docs/test-maintenance-candidates.md', lines: [1, 2] },
  ];
  const EXCERPT = [
    'export interface MaintenanceCandidate { suite: string; }',
    'export type PilotSuite = "chain-linear" | "tool-request-grant";',
  ].join('\n');

  function incidentWorld(selections = SELECTIONS) {
    const world = defaultWorld();
    world[500].issue = targetIssue({
      body: [
        'Run the mutation-testing pilot on the selected suites.',
        '',
        '## Constraints',
        `- ${MUTATION_LIMITS}`,
        `- ${PROHIBITIONS}`,
        '',
        '```refinement-evidence',
        JSON.stringify(selections, null, 2),
        '```',
      ].join('\n'),
    });
    return world;
  }

  const serve = (request) => ({ kind: 'found', content: EXCERPT, resolvedCommitSha: request.commitSha });

  // Round 1's draft: grounded, but silently drops both constraints.
  const omittingDraft = refinerRecord({
    acceptanceCriteria: ['Run the pilot on the chain-linear and tool-request-grant suites.'],
  });
  // Round 2's draft: the same contract with both constraints restored verbatim.
  const repairedDraft = refinerRecord({
    acceptanceCriteria: [
      'Run the pilot on the chain-linear and tool-request-grant suites.',
      MUTATION_LIMITS,
      PROHIBITIONS,
    ],
  });

  // The critic output #1111 actually received (run 241760): `block` with two
  // `lost_requirement` objections and no named human blocker.
  const INCIDENT_OBJECTIONS = [
    {
      field: 'acceptanceCriteria',
      kind: 'lost_requirement',
      detail:
        'Restore the explicit limits on interpreting mutation evidence: scores and coverage do not guarantee all-defect detection, establish redundancy, or justify deletion by themselves; lost detection requires repair or restoration, or rejection of the optimization.',
    },
    {
      field: 'acceptanceCriteria',
      kind: 'lost_requirement',
      detail:
        'Restore the explicit prohibitions on new runner policy, global locks, live sessions.json changes, and behavioral specification edits.',
    },
  ];
  const incidentBlock = criticRecord({ verdict: 'block', objections: INCIDENT_OBJECTIONS });
  const incidentRevise = criticRecord({ verdict: 'revise', objections: INCIDENT_OBJECTIONS });

  const escalation = (result) => result.events.find((e) => e.type === 'refinement.escalated.human');
  // The critic prompt's draft section — the Issue body is in the snapshot of
  // every critic prompt, so only this section proves what the critic judged.
  const draftUnderReview = (prompt) =>
    prompt.slice(
      prompt.indexOf('Refiner draft under review:'),
      prompt.indexOf('The snapshot between the markers'),
    );

  test('the #1111 regression: block / lost_requirement is routed to a bounded revision, and the repaired draft is accepted', async () => {
    const refiner = makeAgent([ok(fenced(omittingDraft)), ok(fenced(repairedDraft))]);
    const critic = makeAgent([ok(fenced(incidentBlock)), ok(fenced(criticRecord()))]);
    const { result, calls, artifactDir } = await run({
      world: incidentWorld(),
      sourceOpts: { evidence: serve },
      refiner,
      critic,
    });

    // The incident's precondition: every declared excerpt captured whole.
    const snapshot = JSON.parse(readFileSync(join(artifactDir, 'snapshot.json'), 'utf8'));
    expect(snapshot.evidence.map((e) => [e.status, e.truncated])).toEqual([
      ['captured', false],
      ['captured', false],
      ['captured', false],
    ]);

    // Before #1176 this stopped at round 1 of 2 with `critique_blocked`.
    expect(escalation(result)).toBeUndefined();
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.taskStatus).toBeNull();
    expect(result.block.handoffReason).toBeNull();
    expect(result.block.counters.rounds).toBe(2);
    expect(refiner.calls).toHaveLength(2);
    expect(critic.calls).toHaveLength(2);

    // The routing point is explicit on the audit trail.
    const revise = result.events.find((e) => e.type === 'refinement.critique.revise');
    expect(revise.data).toMatchObject({
      round: 1,
      criticVerdict: 'block',
      objections: [
        { field: 'acceptanceCriteria', kind: 'lost_requirement' },
        { field: 'acceptanceCriteria', kind: 'lost_requirement' },
      ],
    });
    expect(result.events.map((e) => e.type)).toEqual([
      'refinement.roles.resolved',
      'refinement.eligibility.granted',
      'refinement.snapshot.captured',
      'refinement.draft.recorded',
      'refinement.critique.revise',
      'refinement.draft.recorded',
      'refinement.critique.passed',
    ]);

    // The refiner got the concrete objections AND its previous draft, with the
    // original Issue and the captured evidence still in front of it.
    const revision = refiner.calls[1].prompt;
    expect(revision).toContain('REVISION round');
    expect(revision).toContain('Restore the explicit limits on interpreting mutation evidence');
    expect(revision).toContain('global locks, live sessions.json changes');
    expect(revision).toContain('"Run the pilot on the chain-linear and tool-request-grant suites."');
    expect(revision).toContain('remains the authority');
    expect(revision).toContain('restore the requirement exactly as the target Issue states it');
    expect(revision).toContain('## Constraints');
    expect(revision).toContain('export interface MaintenanceCandidate');

    // The critic independently re-checked the REPAIRED draft before acceptance.
    expect(draftUnderReview(critic.calls[0].prompt)).not.toContain(PROHIBITIONS);
    expect(draftUnderReview(critic.calls[1].prompt)).toContain(PROHIBITIONS);
    expect(draftUnderReview(critic.calls[1].prompt)).toContain(MUTATION_LIMITS);
    expect(result.block.accepted.contract.acceptanceCriteria).toEqual(
      repairedDraft.acceptanceCriteria,
    );
    expect(result.block.accepted.roundsUsed).toBe(2);

    // Accepted is where the loop stops: nothing applied, nothing activated,
    // and every port call was a read.
    expect(result.block.state).toBe('accepted');
    const readOnly = new Set([
      'getBlockedBy', 'readIssue', 'readPullRequest', 'readChangedPaths',
      'readIssueComments', 'readReviewSummary', 'readIssuePlan', 'readChainAgreement',
      'readPredecessorEvidence',
    ]);
    for (const [method] of calls) expect(readOnly.has(method)).toBe(true);
  });

  test('a critic following the corrected prompt answers revise, and the correction is accepted', async () => {
    const refiner = makeAgent([ok(fenced(omittingDraft)), ok(fenced(repairedDraft))]);
    const critic = makeAgent([ok(fenced(incidentRevise)), ok(fenced(criticRecord()))]);
    const { result } = await run({
      world: incidentWorld(),
      sourceOpts: { evidence: serve },
      refiner,
      critic,
    });
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.counters.rounds).toBe(2);
    const revise = result.events.find((e) => e.type === 'refinement.critique.revise');
    // A literal `revise` is not a routed block.
    expect(revise.data.criticVerdict).toBeUndefined();
    expect(refiner.calls[1].prompt).toContain('Restore the explicit prohibitions');
  });

  test('a repeated omission reaches the existing round cap and escalates no_convergence', async () => {
    const refiner = makeAgent([ok(fenced(omittingDraft))]);
    const critic = makeAgent([ok(fenced(incidentBlock))]);
    const { result } = await run({
      world: incidentWorld(),
      sourceOpts: { evidence: serve },
      refiner,
      critic,
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'no_convergence' });
    expect(result.taskStatus).toBe('ready_for_human');
    expect(result.block.counters.rounds).toBe(2);
    // Exactly the configured budget — no extra round, no extra retry.
    expect(refiner.calls).toHaveLength(2);
    expect(critic.calls).toHaveLength(2);
    expect(result.block.accepted).toBeUndefined();
    expect(escalation(result).data).toMatchObject({
      reason: 'no_convergence',
      round: 2,
      criticVerdict: 'block',
    });
  });

  test('a lowered round cap is honoured: one round, then no_convergence', async () => {
    const refiner = makeAgent([ok(fenced(omittingDraft))]);
    const critic = makeAgent([ok(fenced(incidentBlock))]);
    const { result } = await run({
      block: makeBlock({ settings: settingsFor({ limits: { maxRefinementRoundsPerIssue: 1 } }) }),
      world: incidentWorld(),
      sourceOpts: { evidence: serve },
      refiner,
      critic,
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'no_convergence' });
    expect(refiner.calls).toHaveLength(1);
    expect(critic.calls).toHaveLength(1);
  });

  test('a genuinely missing human decision stays a human blocker', async () => {
    const refiner = makeAgent([ok(fenced(omittingDraft))]);
    const critic = makeAgent([
      ok(fenced(criticRecord({
        verdict: 'block',
        blockReason: 'missing_decision',
        objections: [{
          field: 'acceptanceCriteria',
          kind: 'lost_requirement',
          detail: 'The Issue never says which suites the pilot may delete from; only the operator can decide.',
        }],
      }))),
    ]);
    const { result } = await run({
      world: incidentWorld(),
      sourceOpts: { evidence: serve },
      refiner,
      critic,
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'critique_blocked' });
    expect(result.block.counters.rounds).toBe(1);
    expect(refiner.calls).toHaveLength(1);
    expect(result.block.accepted).toBeUndefined();
    expect(escalation(result).data).toMatchObject({
      reason: 'critique_blocked',
      blockReason: 'missing_decision',
      objections: [{ field: 'acceptanceCriteria', kind: 'lost_requirement' }],
    });
    expect(result.events.map((e) => e.type)).not.toContain('refinement.critique.revise');
    // §15: the block record the operator view projects.
    expect(result.block.criticBlock).toEqual({
      round: 1,
      blockReason: 'missing_decision',
      objections: [{ field: 'acceptanceCriteria', kind: 'lost_requirement' }],
      recordedAt: expect.any(String),
    });
  });

  // The handoff guidance points at `admin task-status --verbose`, so that is
  // where the named human blocker has to be readable — and the admin UI must
  // name the same one.
  test('admin task-status and the admin UI name the recorded blockReason', async () => {
    const critic = makeAgent([
      ok(fenced(criticRecord({
        verdict: 'block',
        blockReason: 'authority_conflict',
        objections: [{
          field: 'implementationNotes',
          kind: 'contradicted',
          detail: 'The Issue requires the pilot suites deleted; the predecessor evidence requires them kept.',
        }],
      }))),
    ]);
    const { result } = await run({ world: incidentWorld(), sourceOpts: { evidence: serve }, critic });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'critique_blocked' });
    const task = { context: { refinement: result.block } };
    const summary = summarizeRefinementStatus(task);
    expect(summary.criticBlock).toEqual({
      round: 1,
      blockReason: 'authority_conflict',
      objections: [{ field: 'implementationNotes', kind: 'contradicted' }],
    });
    const expected =
      'critic block: blockReason=authority_conflict round=1 objections=implementationNotes:contradicted';
    const status = renderRefinementLines(summary).join('\n');
    expect(status).toContain('handoff=critique_blocked');
    expect(status).toContain(expected);
    // Literals only: the objection prose stays in the local transcript.
    expect(status).not.toContain('pilot suites');
    expect(formatRefinementDetail(task, '2026-08-10T01:00:00.000Z').join('\n')).toContain(expected);
  });

  test('an unnamed block renders as such, and a block-free task renders no critic line', async () => {
    const unnamed = summarizeRefinementStatus({
      context: {
        refinement: {
          state: 'escalated_human',
          handoffReason: 'critique_blocked',
          criticBlock: { round: 2, blockReason: null, objections: [], recordedAt: 'x' },
        },
      },
    });
    expect(renderRefinementLines(unnamed).join('\n')).toContain(
      'critic block: blockReason=(none named) round=2 objections=(none)',
    );
    const { result } = await run({
      world: incidentWorld(),
      sourceOpts: { evidence: serve },
      refiner: makeAgent([ok(fenced(omittingDraft))]),
      critic: makeAgent([ok(fenced(incidentBlock))]),
    });
    // A routed (repairable) block records no critic block: nobody is blocked.
    expect(result.block.criticBlock).toBeUndefined();
    const summary = summarizeRefinementStatus({ context: { refinement: result.block } });
    expect(summary.criticBlock).toBeNull();
    expect(renderRefinementLines(summary).join('\n')).not.toContain('critic block:');
  });

  test('an authority conflict beside an omission stays blocked', async () => {
    const critic = makeAgent([
      ok(fenced(criticRecord({
        verdict: 'block',
        objections: [
          INCIDENT_OBJECTIONS[0],
          {
            field: 'implementationNotes',
            kind: 'contradicted',
            detail: 'The Issue requires the pilot suites to be deleted; the predecessor evidence requires them kept.',
          },
        ],
      }))),
    ]);
    const { result, refiner } = await run({
      world: incidentWorld(),
      sourceOpts: { evidence: serve },
      critic,
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'critique_blocked' });
    expect(refiner.calls).toHaveLength(1);
    expect(escalation(result).data.blockReason).toBeNull();
  });

  test('unavailable required evidence stops before either agent runs', async () => {
    const { result, refiner, critic } = await run({
      world: incidentWorld(),
      sourceOpts: { evidence: () => ({ kind: 'missing_path' }) },
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'evidence_required' });
    expect(refiner.calls).toHaveLength(0);
    expect(critic.calls).toHaveLength(0);
  });

  test('an uncaptured optional excerpt keeps a lost_requirement block blocked', async () => {
    const selections = [SELECTIONS[0], SELECTIONS[1], { ...SELECTIONS[2], required: false }];
    const refiner = makeAgent([ok(fenced(omittingDraft))]);
    const critic = makeAgent([ok(fenced(incidentBlock))]);
    const { result } = await run({
      world: incidentWorld(selections),
      sourceOpts: {
        evidence: (request) =>
          request.path === SELECTIONS[2].path ? { kind: 'missing_path' } : serve(request),
      },
      refiner,
      critic,
    });
    // The preflight let the optional gap through, so the agents ran …
    expect(critic.calls).toHaveLength(1);
    // … but with the evidence incomplete the block is not routed as revise.
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'critique_blocked' });
    expect(refiner.calls).toHaveLength(1);
  });

  test('a critic naming evidence_unavailable stays blocked', async () => {
    const critic = makeAgent([
      ok(fenced(criticRecord({ verdict: 'block', blockReason: 'evidence_unavailable', objections: [] }))),
    ]);
    const { result } = await run({
      world: incidentWorld(),
      sourceOpts: { evidence: serve },
      critic,
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'critique_blocked' });
    expect(escalation(result).data.blockReason).toBe('evidence_unavailable');
  });

  test('the critic prompt teaches omission-is-revise and names the block reasons', async () => {
    const { critic, refiner } = await run();
    const prompt = critic.calls[0].prompt;
    expect(prompt).toContain('is a repairable omission, not a missing human decision');
    expect(prompt).toContain('A `block` must carry `blockReason`');
    for (const reason of ['missing_decision', 'authority_conflict', 'evidence_unavailable', 'premise_invalidated', 'scope_change']) {
      expect(prompt).toContain(`\`${reason}\``);
    }
    expect(prompt).not.toContain('drops a stated requirement');
    // `blockReason` is block-only, so it is not part of the schema every
    // verdict is told to match — a `pass`/`revise` copying that schema must
    // not come out malformed (`block-reason-without-block`).
    const schema = prompt.split('Result schema (every verdict):\n```json\n')[1].split('\n```')[0];
    expect(schema).not.toContain('blockReason');
    expect(JSON.parse(schema)).not.toHaveProperty('blockReason');
    expect(prompt).toContain('For verdict `block` ONLY, add one more top-level field to that object');
    expect(prompt).toContain('for `pass` and `revise` leave it out entirely');
    expect(refiner.calls[0].prompt).toContain(
      'Preserve every requirement, constraint, limit, prohibition, and non-goal the target Issue states',
    );
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

// ---------------------------------------------------------------------------
// §9.1 — an already-satisfied proposal never spends a human handoff (#982).
//
// The fixture world is the reported shape: target #500 is ALREADY blocked by
// #10, exactly as #951 was already blocked by #950.
// ---------------------------------------------------------------------------

describe('issue-refinement loop — already-satisfied topology proposals (§9.1)', () => {
  const dependency = (kind, relationship, disposition = 'advisory') => ({
    kind,
    rationale: 'chain ordering',
    disposition,
    relationship,
  });
  const runWith = (proposals, dispositions) =>
    run({
      refiner: makeAgent([ok(fenced(refinerRecord({ topologyProposals: proposals })))]),
      critic: makeAgent([ok(fenced(criticRecord({ topologyDispositions: dispositions })))]),
    });

  test('the #951/#950 case: adding an existing edge does not escalate', async () => {
    const { result } = await runWith(
      [dependency('dependency_add', { blockedIssue: 500, blockerIssue: 10 })],
      [{ index: 0, disposition: 'blocking' }],
    );
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.accepted.topology[0]).toMatchObject({
      normalization: 'already_satisfied',
      normalizationDetail: 'edge-present',
      criticDisposition: 'blocking',
      escalates: false,
    });
  });

  test('removing an absent edge does not escalate', async () => {
    const { result } = await runWith(
      [dependency('dependency_remove', { blockedIssue: 500, blockerIssue: 4242 }, 'blocking')],
      [{ index: 0, disposition: 'blocking' }],
    );
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.accepted.topology[0].normalization).toBe('already_satisfied');
  });

  test('a genuinely new edge still escalates under the §9 rules', async () => {
    const { result } = await runWith(
      [dependency('dependency_add', { blockedIssue: 500, blockerIssue: 4242 })],
      [{ index: 0, disposition: 'blocking' }],
    );
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'topology_change_required' });
    const event = result.events.find((e) => e.type === 'refinement.escalated.human');
    expect(event.data.topology[0]).toMatchObject({
      normalization: 'effective_change',
      normalizationDetail: 'edge-absent',
      escalates: true,
    });
    expect(event.data.normalization).toEqual({
      already_satisfied: 0,
      effective_change: 1,
      invalid_or_unverifiable: 0,
    });
  });

  test('a dependency proposal that names no edge stays unverifiable and fails closed', async () => {
    const { result } = await runWith(
      [{ kind: 'dependency_add', rationale: 'chain ordering', disposition: 'advisory' }],
      [{ index: 0, disposition: 'blocking' }],
    );
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'topology_change_required' });
    const event = result.events.find((e) => e.type === 'refinement.escalated.human');
    expect(event.data.topology[0]).toMatchObject({
      normalization: 'invalid_or_unverifiable',
      normalizationDetail: 'relationship-missing',
    });
  });

  test('duplicate no-op proposals collapse and are recorded as one decision', async () => {
    const edge = { blockedIssue: 500, blockerIssue: 10 };
    const { result } = await runWith(
      [dependency('dependency_add', edge), dependency('dependency_add', edge, 'blocking')],
      [{ index: 0, disposition: 'advisory' }],
    );
    expect(result.outcome).toEqual({ kind: 'accepted' });
    const event = result.events.find((e) => e.type === 'refinement.topology.recorded');
    expect(event.data.topology.map((t) => t.duplicateOfIndex)).toEqual([null, 0]);
    expect(event.data.normalization.already_satisfied).toBe(2);
  });

  test('a relationship read failure never reads as satisfied: nothing is drafted at all', async () => {
    const { result, refiner } = await run({ sourceOpts: { blockedByThrows: 'network down' } });
    expect(result.outcome).toMatchObject({ kind: 'snapshot_failed', stage: 'blocked_by' });
    expect(refiner.calls).toHaveLength(0);
    expect(result.block.accepted).toBeUndefined();
  });

  test('an unparseable relationship is malformed refiner output, not a silent no-op', () => {
    const record = refinerRecord({
      topologyProposals: [
        {
          kind: 'dependency_add',
          rationale: 'chain ordering',
          disposition: 'advisory',
          relationship: { blockedIssue: 500, blockerIssue: 0 },
        },
      ],
    });
    const parsed = parseRefinerResponse(fenced(record), snapshotStub(), 4096);
    expect(parsed).toEqual({ ok: false, malformed: ['invalid-field:topologyProposals[0]'] });
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
// §5.2 required-evidence preflight (issue #1003, §12 row 48)
//
// The reported #951/#950 run: the downstream Issue makes a predecessor's
// exported selector type authoritative. With the evidence in hand the lane
// refines normally; without it the lane must stop BEFORE either agent runs,
// rather than spending the round cap on a draft the critic can only reject.
// ---------------------------------------------------------------------------

describe('issue-refinement loop — required-evidence preflight (§5.2, §12 row 48)', () => {
  const SELECTOR_TYPE = [
    'export type DisputeTurnSelection =',
    '  | { kind: "dispatch"; subTurn: string }',
    '  | { kind: "terminal" };',
  ].join('\n');

  function declaring(selections) {
    const world = defaultWorld();
    world[500].issue = targetIssue({
      body: [
        'Downstream body',
        '',
        '```refinement-evidence',
        JSON.stringify(selections, null, 2),
        '```',
      ].join('\n'),
    });
    return world;
  }

  const serve = (content) => (request) => ({
    kind: 'found',
    content,
    resolvedCommitSha: request.commitSha,
  });

  const REQUIRE_SELECTOR = [
    { issue: 10, path: 'src/core/review-dispute-turn.ts', export: 'DisputeTurnSelection' },
  ];

  test('captured evidence refines normally and records no gate', async () => {
    const { result, refiner, critic } = await run({
      world: declaring(REQUIRE_SELECTOR),
      sourceOpts: { evidence: serve(SELECTOR_TYPE) },
    });
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.evidenceGate).toBeUndefined();
    expect(refiner.calls).toHaveLength(1);
    expect(critic.calls).toHaveLength(1);
    // The evidence the agents were handed is the captured contract itself.
    expect(refiner.calls[0].prompt).toContain('export type DisputeTurnSelection');
    expect(critic.calls[0].prompt).toContain('export type DisputeTurnSelection');
  });

  test('the #951/#950 regression: unreachable required evidence stops before either agent', async () => {
    const { result, refiner, critic, artifactDir } = await run({
      world: declaring(REQUIRE_SELECTOR),
      sourceOpts: { evidence: () => ({ kind: 'missing_path' }) },
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'evidence_required' });
    expect(result.taskStatus).toBe('ready_for_human');
    expect(result.block.state).toBe('escalated_human');
    expect(result.block.handoffReason).toBe('evidence_required');
    // No agent budget: neither process was started, and no round was spent.
    expect(refiner.calls).toHaveLength(0);
    expect(critic.calls).toHaveLength(0);
    expect(result.block.counters.rounds).toBe(0);
    expect(result.block.counters.malformedAttempts).toEqual({ refiner: 0, critic: 0 });
    // Row 48 replaces row 10: the run never reached `drafting`.
    const types = result.events.map((e) => e.type);
    expect(types).not.toContain('refinement.snapshot.captured');
    expect(types).toContain('refinement.escalated.human');
    // §15: literals, counters, and the artifact NAME — never a declared path.
    expect(result.block.evidenceGate).toMatchObject({
      declared: 1,
      captured: 0,
      optionalGaps: 0,
      artifact: 'evidence-preflight.json',
      gaps: [
        {
          index: 0,
          reason: 'missing_path',
          requirement: 'required',
          predecessorIssueNumber: 10,
        },
      ],
    });
    expect(JSON.stringify(result.block)).not.toContain('review-dispute-turn.ts');
    // The full account, paths included, is local-only.
    expect(result.artifacts).toContain('evidence-preflight.json');
    const artifact = JSON.parse(
      readFileSync(join(artifactDir, 'evidence-preflight.json'), 'utf8'),
    );
    expect(artifact.gaps).toHaveLength(1);
    expect(artifact.evidence[0].selector.path).toBe('src/core/review-dispute-turn.ts');
  });

  test('the escalation event carries the gap literals, and the fingerprint is recorded', async () => {
    const { result } = await run({
      world: declaring(REQUIRE_SELECTOR),
      sourceOpts: { evidence: () => ({ kind: 'unavailable', detail: 'type=symlink' }) },
    });
    const escalated = result.events.find((e) => e.type === 'refinement.escalated.human');
    expect(escalated.data.reason).toBe('evidence_required');
    expect(escalated.data.evidence).toEqual({
      declared: 1,
      captured: 0,
      optionalGaps: 0,
      gaps: [
        {
          index: 0,
          reason: 'source_unavailable',
          requirement: 'required',
          predecessorIssueNumber: 10,
        },
      ],
    });
    expect(result.block.predecessorFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a missing evidence resolver is a required-evidence stop, not a silent proceed', async () => {
    const { result, refiner } = await run({ world: declaring(REQUIRE_SELECTOR) });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'evidence_required' });
    expect(result.block.evidenceGate.gaps[0].reason).toBe('resolver_unavailable');
    expect(refiner.calls).toHaveLength(0);
  });

  test('re-running unchanged input reaches the same handoff and still spends no agent', async () => {
    const first = await run({
      world: declaring(REQUIRE_SELECTOR),
      sourceOpts: { evidence: () => ({ kind: 'missing_path' }) },
      runId: 'run-a',
    });
    const second = await run({
      world: declaring(REQUIRE_SELECTOR),
      sourceOpts: { evidence: () => ({ kind: 'missing_path' }) },
      runId: 'run-b',
    });
    expect(second.result.outcome).toEqual(first.result.outcome);
    expect(second.result.block.evidenceGate.gaps).toEqual(first.result.block.evidenceGate.gaps);
    expect(second.result.block.predecessorFingerprint).toBe(
      first.result.block.predecessorFingerprint,
    );
    expect(second.refiner.calls).toHaveLength(0);
    expect(second.critic.calls).toHaveLength(0);
    // And the durable half: the escalated block is refused without re-deciding.
    const again = await run({
      block: first.result.block,
      world: declaring(REQUIRE_SELECTOR),
      sourceOpts: { evidence: () => ({ kind: 'missing_path' }) },
      runId: 'run-c',
    });
    expect(again.result.outcome).toEqual({ kind: 'refused', detail: 'state:escalated_human' });
    expect(again.refiner.calls).toHaveLength(0);
  });

  test('an optional selection that cannot be captured never raises the handoff', async () => {
    const { result, refiner } = await run({
      world: declaring([{ ...REQUIRE_SELECTOR[0], required: false }]),
      sourceOpts: { evidence: () => ({ kind: 'missing_path' }) },
    });
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.evidenceGate).toBeUndefined();
    expect(refiner.calls).toHaveLength(1);
  });

  test('a required excerpt cut by its own byte cap is a gap', async () => {
    const { result } = await run({
      world: declaring([
        { issue: 10, path: 'src/core/review-dispute-turn.ts', maxBytes: 8 },
      ]),
      sourceOpts: { evidence: serve(SELECTOR_TYPE) },
    });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'evidence_required' });
    expect(result.block.evidenceGate.gaps[0]).toEqual({
      index: 0,
      reason: 'truncated',
      requirement: 'required',
      predecessorIssueNumber: 10,
    });
  });

  test('a malformed declaration fails closed as undetermined requiredness', async () => {
    const world = defaultWorld();
    world[500].issue = targetIssue({
      body: ['Downstream body', '', '```refinement-evidence', 'not json', '```'].join('\n'),
    });
    const { result, refiner } = await run({ world });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'evidence_required' });
    expect(result.block.evidenceGate.gaps).toEqual([
      {
        index: 0,
        reason: 'malformed_declaration',
        requirement: 'undetermined',
        predecessorIssueNumber: null,
      },
    ]);
    expect(refiner.calls).toHaveLength(0);
  });

  // §13 row 36 is the only way out, and it re-snapshots: evidence that became
  // reachable — or a declaration the operator corrected — is read as it now
  // stands, so the recovered attempt proceeds instead of stopping again.
  test('recovery re-snapshots, and the same Issue proceeds once the evidence is reachable', async () => {
    const stopped = await run({
      world: declaring(REQUIRE_SELECTOR),
      sourceOpts: { evidence: () => ({ kind: 'missing_path' }) },
      runId: 'run-stop',
    });
    expect(stopped.result.outcome).toEqual({ kind: 'escalated', reason: 'evidence_required' });
    const recovered = planRefinementRecovery({ block: stopped.result.block, now: NOW }).block;
    expect(recovered.state).toBe('pending');
    expect(recovered.handoffReason).toBeNull();
    expect(recovered.evidenceGate).toBeUndefined();
    const retried = await run({
      block: recovered,
      world: declaring(REQUIRE_SELECTOR),
      sourceOpts: { evidence: serve(SELECTOR_TYPE) },
      runId: 'run-retry',
    });
    expect(retried.result.outcome).toEqual({ kind: 'accepted' });
    expect(retried.refiner.calls).toHaveLength(1);
    expect(retried.result.block.evidenceGate).toBeUndefined();
  });

  test('an Issue that declares nothing runs exactly as before', async () => {
    const { result, refiner } = await run();
    expect(result.outcome).toEqual({ kind: 'accepted' });
    expect(result.block.evidenceGate).toBeUndefined();
    expect(result.artifacts).not.toContain('evidence-preflight.json');
    expect(refiner.calls).toHaveLength(1);
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

  // Issue #1176: the optional closed `blockReason`.
  test('a block may name a blockReason; absent or null reads as none', () => {
    const named = parseCriticResponse(
      fenced(criticRecord({ verdict: 'block', blockReason: 'authority_conflict' })),
    );
    expect(named.ok).toBe(true);
    expect(named.critique.blockReason).toBe('authority_conflict');
    expect(parseCriticResponse(fenced(criticRecord({ verdict: 'block' }))).critique.blockReason)
      .toBeNull();
    expect(parseCriticResponse(fenced(criticRecord({ blockReason: null }))).critique.blockReason)
      .toBeNull();
  });

  test.each([
    ['an unknown blockReason literal', criticRecord({ verdict: 'block', blockReason: 'omission' }), 'invalid-field:blockReason'],
    ['a blockReason on a pass', criticRecord({ blockReason: 'missing_decision' }), 'block-reason-without-block'],
    ['a blockReason on a revise', criticRecord({ verdict: 'revise', objections: [objection], blockReason: 'scope_change' }), 'block-reason-without-block'],
  ])('%s is malformed', (_name, record, detail) => {
    expect(parseCriticResponse(fenced(record))).toEqual({ ok: false, malformed: [detail] });
  });
});

describe('critic verdict routing (§7.2 repairable-block routing, #1176)', () => {
  const lost = { field: 'acceptanceCriteria', kind: 'lost_requirement', detail: 'restore the stated limit' };
  const critique = (overrides) => ({ verdict: 'block', objections: [lost], blockReason: null, ...overrides });
  const captured = { status: 'captured', truncated: false };

  test('pass and revise route as themselves', () => {
    expect(routeCriticVerdict(critique({ verdict: 'pass', objections: [] }), [])).toEqual({ route: 'pass' });
    expect(routeCriticVerdict(critique({ verdict: 'revise' }), [])).toEqual({
      route: 'revise',
      repairableBlock: false,
    });
  });

  test('an unnamed block of only lost_requirement objections with complete evidence routes as revise', () => {
    expect(routeCriticVerdict(critique({ objections: [lost, lost] }), [captured, captured])).toEqual({
      route: 'revise',
      repairableBlock: true,
    });
    // An Issue that declares no evidence is trivially complete.
    expect(routeCriticVerdict(critique(), undefined).route).toBe('revise');
  });

  test.each([
    ['a named blockReason', critique({ blockReason: 'missing_decision' }), [captured], 'missing_decision'],
    ['no objections at all', critique({ objections: [] }), [captured], null],
    ['another objection kind beside the omission', critique({ objections: [lost, { ...lost, kind: 'contradicted' }] }), [captured], null],
    ['an omitted evidence selection', critique(), [captured, { status: 'omitted', truncated: false }], null],
    ['a truncated evidence selection', critique(), [{ status: 'captured', truncated: true }], null],
  ])('%s keeps the block', (_name, input, evidence, blockReason) => {
    expect(routeCriticVerdict(input, evidence)).toEqual({ route: 'block', blockReason });
  });

  test('evidence completeness means every selection captured and uncut', () => {
    expect(refinementEvidenceComplete(undefined)).toBe(true);
    expect(refinementEvidenceComplete([])).toBe(true);
    expect(refinementEvidenceComplete([captured])).toBe(true);
    expect(refinementEvidenceComplete([{ status: 'omitted', truncated: false }])).toBe(false);
    expect(refinementEvidenceComplete([{ status: 'captured', truncated: true }])).toBe(false);
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

  // Issue #1192: the scanner replaced a regex; these pin the grammar it kept.
  test('a fence quoted inside a JSON string does not close the block', () => {
    const raw = 'prose\n```json\n{"note":"use ```json\\n{}\\n``` here"}\n```\ntrailing prose';
    expect(extractRefinementRecord(raw)).toEqual({
      ok: true,
      record: { note: 'use ```json\n{}\n``` here' },
    });
  });

  test('CRLF, indented closes, case-insensitive tags and a close at end of output', () => {
    expect(extractRefinementRecord('```JSON \r\n{"a":1}\r\n  ```  \r\nafter')).toEqual({
      ok: true,
      record: { a: 1 },
    });
    expect(extractRefinementRecord('x ```json\n{"a":2}\n```')).toEqual({ ok: true, record: { a: 2 } });
  });

  test('a close fence with trailing text is not a close', () => {
    const raw = '```json\n{"a":1}\n``` not a close\n```';
    expect(extractRefinementRecord(raw)).toEqual({ ok: false, detail: 'unparseable-json-block' });
  });

  test('an unclosed opener is no block', () => {
    expect(extractRefinementRecord('```json\n{"a":1}\n')).toEqual({ ok: false, detail: 'no-json-block' });
    expect(extractRefinementRecord('```json {"a":1}\n```')).toEqual({ ok: false, detail: 'no-json-block' });
  });

  test('an oversized body is payload-too-large, not truncated', () => {
    const big = `{"a":"${'x'.repeat(REFINEMENT_RECORD_MAX_BYTES)}"}`;
    expect(extractRefinementRecord('```json\n' + big + '\n```')).toEqual({
      ok: false,
      detail: 'payload-too-large',
    });
    // Multi-byte characters count in UTF-8 bytes, not code units.
    const wide = `{"a":"${'é'.repeat(REFINEMENT_RECORD_MAX_BYTES / 2)}"}`;
    expect(extractRefinementRecord('```json\n' + wide + '\n```')).toEqual({
      ok: false,
      detail: 'payload-too-large',
    });
  });

  test('matches the replaced regex on a mixed corpus', () => {
    const pattern = () => /```[ \t]*json[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*(?=\r?\n|$)/gim;
    const pieces = ['```', 'json', 'JSON', ' ', '\t', '\n', '\r\n', '\r', ' ', '{"a":1}', '[1]', 'x', '`'];
    let seed = 1192;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 3000; round += 1) {
      let raw = '';
      const len = 1 + rand(24);
      for (let i = 0; i < len; i += 1) raw += pieces[rand(pieces.length)];
      const re = pattern();
      const records = [];
      let expected = null;
      let sawBlock = false;
      for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
        sawBlock = true;
        let parsed;
        try {
          parsed = JSON.parse(m[1]);
        } catch {
          expected = { ok: false, detail: 'unparseable-json-block' };
          break;
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed);
      }
      if (expected === null) {
        if (records.length === 0) expected = { ok: false, detail: sawBlock ? 'no-json-object' : 'no-json-block' };
        else if (records.length > 1) expected = { ok: false, detail: 'multiple-json-objects' };
        else expected = { ok: true, record: records[0] };
      }
      expect({ raw, result: extractRefinementRecord(raw) }).toEqual({ raw, result: expected });
    }
  });

  test('repeated unclosed opening fences are scanned in linear time', () => {
    // 16 MiB is the runner's output ceiling; the regex took minutes here.
    const opener = '```json\n';
    const raw = opener.repeat(Math.floor((16 * 1024 * 1024) / opener.length));
    const started = Date.now();
    expect(extractRefinementRecord(raw)).toEqual({ ok: false, detail: 'no-json-block' });
    expect(extractRefinementRecord(raw + '{"a":1}')).toEqual({ ok: false, detail: 'no-json-block' });
    const blanks = '```' + ' '.repeat(1024) + '\n';
    expect(extractRefinementRecord(blanks.repeat(4096))).toEqual({ ok: false, detail: 'no-json-block' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test('a valid record after many unrelated fences is still found', () => {
    const noise = '```text\nnot json\n```\n'.repeat(10_000);
    expect(extractRefinementRecord(noise + '```json\n{"a":1}\n```\n')).toEqual({
      ok: true,
      record: { a: 1 },
    });
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

  test('with no graph supplied nothing can be excluded — the pre-#982 answer', () => {
    const dependency = {
      kind: 'dependency_add',
      rationale: 'r',
      disposition: 'advisory',
      relationship: { blockedIssue: 951, blockerIssue: 950 },
    };
    const combined = combineTopologyDispositions([dependency], [{ index: 0, disposition: 'blocking' }]);
    expect(combined.normalization.graphAvailable).toBe(false);
    expect(combined.effective[0]).toMatchObject({
      normalization: 'invalid_or_unverifiable',
      normalizationDetail: 'graph-unavailable:not_supplied',
      escalates: true,
    });
    expect(combined.anyBlocking).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §9.1 — normalization against the authoritative relationship graph (#982)
// ---------------------------------------------------------------------------

describe('topology normalization (§9.1)', () => {
  // The reported run: #951 is ALREADY blocked by #950, and the refiner
  // proposed adding exactly that edge.
  const graph = { ok: true, issueNumber: 951, blockedBy: [950] };
  const unavailable = { ok: false, reason: 'read_failed' };

  const proposal = (kind, relationship, disposition = 'advisory') => ({
    kind,
    rationale: 'r',
    disposition,
    ...(relationship ? { relationship } : {}),
  });
  const edge = (blockedIssue, blockerIssue, previousBlockerIssue) => ({
    blockedIssue,
    blockerIssue,
    ...(previousBlockerIssue === undefined ? {} : { previousBlockerIssue }),
  });
  const classify = (p, g = graph) => normalizeTopologyProposals([p], g).entries[0];

  test('the snapshot predecessor list is the authoritative blocked-by set', () => {
    const snapshot = {
      target: { issueNumber: 951 },
      predecessors: [{ issueNumber: 950 }, { issueNumber: 949 }, { issueNumber: 950 }],
    };
    expect(refinementRelationshipGraph(snapshot)).toEqual({
      ok: true,
      issueNumber: 951,
      blockedBy: [949, 950],
    });
  });

  test('a missing or unusable snapshot yields no graph, never an empty one', () => {
    expect(refinementRelationshipGraph(null)).toEqual({ ok: false, reason: 'snapshot_absent' });
    expect(refinementRelationshipGraph({ target: {}, predecessors: [] })).toEqual({
      ok: false,
      reason: 'snapshot_unusable',
    });
  });

  test('dependency_add of an existing edge is already satisfied', () => {
    expect(classify(proposal('dependency_add', edge(951, 950)))).toMatchObject({
      normalization: 'already_satisfied',
      detail: 'edge-present',
    });
  });

  test('dependency_remove of an absent edge is already satisfied', () => {
    expect(classify(proposal('dependency_remove', edge(951, 4242)))).toMatchObject({
      normalization: 'already_satisfied',
      detail: 'edge-absent',
    });
  });

  test('a genuinely new add and a genuine removal are effective changes', () => {
    expect(classify(proposal('dependency_add', edge(951, 4242))).normalization).toBe(
      'effective_change',
    );
    expect(classify(proposal('dependency_remove', edge(951, 950))).normalization).toBe(
      'effective_change',
    );
  });

  test('a rewire is satisfied only when BOTH halves already hold', () => {
    expect(classify(proposal('dependency_rewire', edge(951, 950, 949))).normalization).toBe(
      'already_satisfied',
    );
    expect(classify(proposal('dependency_rewire', edge(951, 4242, 950))).normalization).toBe(
      'effective_change',
    );
    expect(classify(proposal('dependency_rewire', edge(951, 950))).detail).toBe(
      'rewire-previous-missing',
    );
  });

  test('split and supersede name no edge, so they are never satisfied', () => {
    for (const kind of ['split', 'supersede']) {
      expect(classify(proposal(kind, null))).toMatchObject({
        normalization: 'effective_change',
        detail: 'kind-not-relationship',
        key: null,
      });
    }
  });

  test('an uncomparable dependency proposal is unverifiable, never satisfied', () => {
    expect(classify(proposal('dependency_add', null)).detail).toBe('relationship-missing');
    // §5 captures the TARGET's edges only; another Issue's graph is unread.
    expect(classify(proposal('dependency_add', edge(4242, 950))).detail).toBe(
      'relationship-out-of-scope',
    );
    expect(classify(proposal('dependency_remove', edge(951, 951))).detail).toBe(
      'relationship-self-edge',
    );
    for (const kind of ['dependency_add', 'dependency_remove']) {
      expect(classify(proposal(kind, edge(951, 950))).normalization).not.toBe(
        'invalid_or_unverifiable',
      );
    }
  });

  test('an unavailable graph makes every proposal unverifiable, never satisfied', () => {
    const entry = classify(proposal('dependency_add', edge(951, 950)), unavailable);
    expect(entry).toMatchObject({
      normalization: 'invalid_or_unverifiable',
      detail: 'graph-unavailable:read_failed',
    });
    // And it still escalates when the parties say blocking.
    const combined = combineTopologyDispositions(
      [proposal('dependency_add', edge(951, 950), 'blocking')],
      [{ index: 0, disposition: 'advisory' }],
      unavailable,
    );
    expect(combined.anyBlocking).toBe(true);
  });

  test('already-satisfied proposals are excluded whatever either party said', () => {
    const combined = combineTopologyDispositions(
      [proposal('dependency_add', edge(951, 950), 'blocking')],
      [{ index: 0, disposition: 'blocking' }],
      graph,
    );
    expect(combined.anyBlocking).toBe(false);
    expect(combined.effective[0]).toMatchObject({
      effective: 'blocking',
      normalization: 'already_satisfied',
      escalates: false,
    });
    expect(combined.normalization.counts.already_satisfied).toBe(1);
  });

  test('a genuine change still follows the §9 disposition rules', () => {
    const genuine = proposal('dependency_add', edge(951, 4242));
    expect(
      combineTopologyDispositions([genuine], [{ index: 0, disposition: 'advisory' }], graph)
        .anyBlocking,
    ).toBe(false);
    expect(
      combineTopologyDispositions([genuine], [{ index: 0, disposition: 'blocking' }], graph)
        .anyBlocking,
    ).toBe(true);
    expect(combineTopologyDispositions([genuine], [], graph).anyBlocking).toBe(true);
  });

  test('duplicate equivalent proposals collapse to one normalized proposal', () => {
    const dup = proposal('dependency_add', edge(951, 4242));
    const result = normalizeTopologyProposals([dup, { ...dup, rationale: 'said twice' }], graph);
    expect(result.entries[0].duplicateOfIndex).toBeNull();
    expect(result.entries[1].duplicateOfIndex).toBe(0);
    expect(result.entries[0].key).toBe(result.entries[1].key);
    // Two `split`s with different rationales are two proposals, not one.
    const splits = normalizeTopologyProposals(
      [proposal('split', null), proposal('split', null)],
      graph,
    );
    expect(splits.entries[1].duplicateOfIndex).toBeNull();
  });

  test('a collapsed duplicate group blocks when any member does', () => {
    const dup = proposal('dependency_add', edge(951, 4242));
    const combined = combineTopologyDispositions(
      [dup, { ...dup, disposition: 'blocking' }],
      [
        { index: 0, disposition: 'advisory' },
        { index: 1, disposition: 'advisory' },
      ],
      graph,
    );
    expect(combined.anyBlocking).toBe(true);
    expect(combined.effective.map((e) => e.escalates)).toEqual([true, true]);
  });

  test('duplicated no-ops still collapse to no handoff', () => {
    const dup = proposal('dependency_add', edge(951, 950), 'blocking');
    const combined = combineTopologyDispositions([dup, dup], [], graph);
    expect(combined.anyBlocking).toBe(false);
    expect(combined.normalization.counts).toEqual({
      already_satisfied: 2,
      effective_change: 0,
      invalid_or_unverifiable: 0,
    });
  });

  test('the classification vocabulary is closed', () => {
    expect([...REFINEMENT_TOPOLOGY_NORMALIZATIONS]).toEqual([
      'already_satisfied',
      'effective_change',
      'invalid_or_unverifiable',
    ]);
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
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '-c',
      'model_reasoning_effort=high',
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

  // #999: a still-open, reviewed `status:stack-ready` predecessor is the
  // repository's normal stacked-branch state, not an undelivered one — both
  // agents must be told so explicitly, in-band with the snapshot they judge.
  const stackReadySnapshot = {
    predecessorFingerprint: 'f'.repeat(64),
    predecessors: [
      {
        issueNumber: 975,
        issueState: 'open',
        shape: 'open_stack_ready',
        stackReady: true,
        pullRequest: { number: 997, state: 'open', headRefName: 'ai/issue-975' },
      },
    ],
    target: { issueNumber: 976, title: 'Downstream' },
    manifest: {},
  };

  test('the refiner prompt explains open_stack_ready predecessor semantics', () => {
    const prompt = buildRefinerPrompt({
      snapshot: stackReadySnapshot,
      nonce: 'aaaa',
      round: 1,
      previousContract: null,
      objections: null,
    });
    expect(prompt).toContain('stacked-branch workflow');
    expect(prompt).toContain('open_stack_ready');
    expect(prompt).toContain('not evidence that the predecessor\'s work is missing');
  });

  test('the critic prompt explains open_stack_ready predecessor semantics and forbids blocking solely on unmerged state', () => {
    const prompt = buildCriticPrompt({
      snapshot: stackReadySnapshot,
      nonce: 'bbbb',
      contract: refinerRecord(),
    });
    expect(prompt).toContain('stacked-branch workflow');
    expect(prompt).toContain('open_stack_ready');
    expect(prompt).toContain(
      'NOT by itself predecessor evidence contradicting the draft when that predecessor\'s snapshot `shape` is `open_stack_ready`',
    );
    expect(prompt).toContain('do not import concerns about unrelated Issues or defects');
  });

  // §5.1 (issue #983): both prompts embed the SAME serialization of the same
  // frozen snapshot — evidence entries included — inside the untrusted fence,
  // which is what makes the refiner's and the critic's evidence byte-identical
  // rather than merely equivalent.
  test('both prompts carry byte-identical §5.1 evidence inside the untrusted fence', () => {
    const withEvidence = {
      ...stackReadySnapshot,
      evidence: [
        {
          index: 0,
          selector: {
            issueNumber: 975,
            path: 'src/core/x.ts',
            exportName: 'Selection',
            lines: null,
            maxBytes: null,
          },
          status: 'captured',
          omissionReason: null,
          detail: null,
          source: {
            issueNumber: 975,
            prNumber: 997,
            shape: 'open_stack_ready',
            headRefName: 'ai/issue-975',
            commitSha: 'c'.repeat(40),
          },
          content: 'export type Selection = { kind: "dispatch" };',
          maxBytesApplied: 8000,
          truncated: false,
        },
        {
          index: 1,
          selector: null,
          status: 'omitted',
          omissionReason: 'missing_path',
          detail: null,
          source: null,
          content: null,
          maxBytesApplied: null,
          truncated: false,
        },
      ],
    };
    const refiner = buildRefinerPrompt({
      snapshot: withEvidence,
      nonce: 'cccc',
      round: 1,
      previousContract: null,
      objections: null,
    });
    const critic = buildCriticPrompt({ snapshot: withEvidence, nonce: 'cccc', contract: refinerRecord() });
    const fenceBody = (p) =>
      p
        .split('--- BEGIN UNTRUSTED SNAPSHOT DATA cccc ---')[1]
        .split('--- END UNTRUSTED SNAPSHOT DATA cccc ---')[0];
    expect(fenceBody(refiner)).toBe(fenceBody(critic));
    expect(fenceBody(refiner)).toContain('"evidence"');
    expect(fenceBody(refiner)).toContain('export type Selection');
    for (const prompt of [refiner, critic]) {
      expect(prompt).toContain('Declared evidence:');
      expect(prompt).toContain('Do not guess, reconstruct, or substitute its content');
    }
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
// gh snapshot adapter — §5.1 evidence read (issue #983)
// ---------------------------------------------------------------------------

describe('gh snapshot source — readPredecessorEvidence', () => {
  function sourceWithResponses(responses) {
    const calls = [];
    const source = createGhRefinementSnapshotSource({
      githubRepo: 'm2dw/repo',
      artifactRoot: '/tmp/unused-artifacts',
      runGh: (args) => {
        calls.push(args);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return JSON.stringify(next);
      },
    });
    return { source, calls };
  }

  const request = {
    issueNumber: 950,
    prNumber: 968,
    headRefName: 'ai/issue-950',
    commitSha: 'a'.repeat(40),
    path: 'src/core/review-dispute-turn.ts',
    maxBytes: 1024,
  };

  test('reads the file at exactly the pinned commit and echoes it as provenance', async () => {
    const content = 'export type DisputeTurnSelection = { kind: "dispatch" };\n';
    const { source, calls } = sourceWithResponses([
      { type: 'file', encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') },
    ]);
    const result = await source.readPredecessorEvidence(request);
    expect(result).toEqual({ kind: 'found', content, resolvedCommitSha: 'a'.repeat(40) });
    // The commit SHA — never the head ref name — addresses the read.
    expect(calls).toEqual([
      ['api', `repos/m2dw/repo/contents/src/core/review-dispute-turn.ts?ref=${'a'.repeat(40)}`],
    ]);
  });

  test('a 1MB-plus file falls back to the blob API by object id, still pinned bytes', async () => {
    const content = 'big file bytes\n';
    const { source, calls } = sourceWithResponses([
      { type: 'file', encoding: 'none', content: '', sha: 'blob1' },
      { encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') },
    ]);
    const result = await source.readPredecessorEvidence(request);
    expect(result).toEqual({ kind: 'found', content, resolvedCommitSha: 'a'.repeat(40) });
    expect(calls[1]).toEqual(['api', 'repos/m2dw/repo/git/blobs/blob1']);
  });

  test('a blob too large for the runner buffer is an unavailable omission, never fetched', async () => {
    // 64 MiB of file bytes would base64-inflate past the gh runner's own
    // 64 MiB buffer, so the adapter must decide from the Contents API `size`
    // alone instead of starting a download that dies as a transient.
    const size = 64 * 1024 * 1024;
    const { source, calls } = sourceWithResponses([
      { type: 'file', encoding: 'none', content: '', sha: 'blob1', size },
    ]);
    const result = await source.readPredecessorEvidence(request);
    expect(result).toEqual({ kind: 'unavailable', detail: `oversized=${size}` });
    expect(calls).toHaveLength(1);
  });

  test('oversize content is sliced toward the requested read bound, never returned whole', async () => {
    const { source } = sourceWithResponses([
      {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('x'.repeat(5000), 'utf8').toString('base64'),
      },
    ]);
    const result = await source.readPredecessorEvidence(request);
    expect(result.kind).toBe('found');
    expect(result.content).toBe('x'.repeat(1024));
  });

  test('a non-ASCII file is truncated at the UTF-8 byte cap, not at 1024 code units', async () => {
    // 2000 three-byte characters: a code-unit slice would return 1024
    // CHARACTERS — 3072 bytes, three times the requested read bound.
    const { source } = sourceWithResponses([
      {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('あ'.repeat(2000), 'utf8').toString('base64'),
      },
    ]);
    const result = await source.readPredecessorEvidence(request);
    expect(result.kind).toBe('found');
    // 1024 bytes is 341 whole characters plus one dangling lead byte, which
    // decodes as a single replacement character: the decoded length stays at
    // the cap or just past it, so the core's one-byte-past truncation probe
    // still fires while the read bound holds.
    expect(result.content).toBe('あ'.repeat(341) + '�');
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(1026);
  });

  test('a 404 is missing_path; directories and symlinks are not file evidence', async () => {
    const notFound = sourceWithResponses([new Error('gh: Not Found (HTTP 404)')]);
    expect(await notFound.source.readPredecessorEvidence(request)).toEqual({
      kind: 'missing_path',
    });
    const directory = sourceWithResponses([[{ type: 'file', path: 'src/core/a.ts' }]]);
    expect(await directory.source.readPredecessorEvidence(request)).toEqual({
      kind: 'missing_path',
    });
    const symlink = sourceWithResponses([{ type: 'symlink', target: 'elsewhere' }]);
    expect(await symlink.source.readPredecessorEvidence(request)).toEqual({
      kind: 'unavailable',
      detail: 'type=symlink',
    });
  });

  test('a transient provider failure propagates as a throw, never as an omission shape', async () => {
    const { source } = sourceWithResponses([new Error('gh: HTTP 500')]);
    await expect(source.readPredecessorEvidence(request)).rejects.toThrow('HTTP 500');
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
    // Issue #976: one append-only comment effect per committed progress
    // milestone, in the SAME call as the milestones — never a second write a
    // crash could land on one side of.
    const milestones = output.events.filter((t) => t === 'refinement.progress.milestone').length;
    expect(milestones).toBeGreaterThan(0);
    expect(commits[0].effects).toBe(milestones);
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
      // Issue #976: the §15 progress comments lead — the boundaries the run
      // crossed — and §13's label and handoff comment close the sequence, so an
      // operator reads what happened before what to do about it.
      expect(rows.slice(0, -2).every((r) => r.payload.body.includes('ai-refinement:progress'))).toBe(true);
      const label = rows[rows.length - 2];
      const handoff = rows[rows.length - 1];
      expect(label.topic).toBe('gh:label:add');
      expect(handoff.topic).toBe('gh:comment');
      expect(label.payload).toMatchObject({ issueNumber: 500, label: 'ai:ready-for-human' });
      const body = handoff.payload.body;
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

  // Issue #976: an accepted run is not silent any more — it publishes the
  // §15 progress boundaries it crossed. What it still must not publish is a
  // label, a body write, or anything else the lane keeps to itself: only a
  // handoff moves labels.
  test('an accepted run publishes its progress comments and nothing else', async () => {
    const output = await capture(() => runRefinementRun(ARGS(), cliDeps()));
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      const rows = await outbox.listUnsent();
      expect(rows.map((r) => r.topic)).toEqual(
        rows.map(() => 'gh:comment'),
      );
      expect(rows).toHaveLength(
        output.events.filter((t) => t === 'refinement.progress.milestone').length,
      );
      expect(rows.every((r) => r.payload.body.includes('ai-refinement:progress'))).toBe(true);
      // Never the fingerprint that identifies the refinement, and never a path.
      expect(rows.every((r) => !r.payload.body.includes(tmpDir))).toBe(true);
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
