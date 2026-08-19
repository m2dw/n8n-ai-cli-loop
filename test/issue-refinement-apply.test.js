/**
 * Applying an accepted Issue refinement and activating implementation
 * (issue #870, docs/issue-refinement-contract.md §6, §10, §11, §12 rows
 * 22–32/42–45, §16).
 *
 * Covers the acceptance criteria of the Issue: body-first/labels-last
 * ordering, stale fingerprints never activating, idempotent retry after
 * partial body/comment/label delivery, a failed application never leaving an
 * Issue implementation-eligible with an unrefined body, and the label plan
 * coming from the persisted activation plan rather than hard-coded literals.
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_REFINEMENT_MARKER_LABEL,
  IMPLEMENTATION_STATUS_LABEL,
  MAX_APPLY_TRANSIENT_FAILURES,
  buildRefinementContextBlock,
  buildRefinementSnapshot,
  computeAppliedRegionDigest,
  containsFilesystemPath,
  containsManagedRegionMarker,
  evaluateManagedRegionWrite,
  evaluateStatusAddition,
  extractManagedRegion,
  hasRefinementComment,
  REFINEMENT_COMMENT_MARKER_PREFIX,
  refinementCommentMarker,
  refinementFingerprintPrefix,
  refinementPredecessorRecords,
  renderManagedRegion,
  renderRefinementAuditComment,
  resolveIssueRefinementSettings,
  spliceManagedRegion,
} from '../dist/index.js';
import { executeRefinementApply } from '../dist/handlers/issue-refinement-apply.js';
import { createRefinementHandler } from '../dist/handlers/issue-refinement-loop.js';
import { createGhRefinementApplyPort } from '../dist/cli/issue-refinement-loop.js';

const STACK_READY = 'status:stack-ready';
const NOW = '2026-08-10T00:00:00.000Z';
const LANE_LABELS = {
  marker: DEFAULT_REFINEMENT_MARKER_LABEL,
  implementationStatus: IMPLEMENTATION_STATUS_LABEL,
};

// ---------------------------------------------------------------------------
// Fixture world (same shape as the #869 loop tests): one usable
// open-stack-ready predecessor #10 behind target Issue #500. The apply port
// MUTATES the world, so the read-only source observes every delivered write
// exactly as a live re-read would.
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

function defaultWorld() {
  return { 500: { issue: targetIssue(), pr: null, comments: [], paths: [], review: null }, 10: predecessor(10) };
}

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
      return opts.blockedBy ?? [{ issueNumber: 10, state: 'open' }];
    },
    async readIssue(n) {
      calls.push(['readIssue', n]);
      if (opts.readIssueThrows === n) throw new Error(`read failed for #${n}`);
      // A structured copy: the walk must never see later world mutations
      // through a stale reference.
      return structuredClone(entry(n).issue);
    },
    async readPullRequest(n) {
      calls.push(['readPullRequest', n]);
      const pr = entry(n).pr;
      if (pr === null) return { kind: 'none' };
      return { kind: 'found', pullRequest: structuredClone(pr) };
    },
    async readChangedPaths(prNumber, limit) {
      calls.push(['readChangedPaths', prNumber, limit]);
      const owner = Object.values(world).find((e) => e.pr && e.pr.number === prNumber);
      return owner ? owner.paths : [];
    },
    async readIssueComments(n, limit) {
      calls.push(['readIssueComments', n, limit]);
      if (opts.readCommentsThrows) throw new Error('comment listing failed');
      return structuredClone(entry(n).comments);
    },
    async readReviewSummary(n) {
      calls.push(['readReviewSummary', n]);
      if (opts.onReviewSummary) opts.onReviewSummary(n);
      return entry(n).review;
    },
    async readIssuePlan() {
      return null;
    },
  };
  return { port, calls };
}

/** Write port over the same world; throws BEFORE mutating on an injected fault. */
function makePort(world, opts = {}) {
  const calls = [];
  const port = {
    async updateIssueBody(n, body) {
      calls.push(['updateIssueBody', n]);
      if (opts.bodyThrows) throw new Error('body write failed');
      world[n].issue.body = body;
      if (opts.onBodyUpdated) opts.onBodyUpdated();
    },
    async postIssueComment(n, body) {
      calls.push(['postIssueComment', n]);
      if (opts.commentThrows) throw new Error('comment post failed');
      world[n].comments.push({ id: `posted-${calls.length}`, createdAt: NOW, updatedAt: NOW, body });
      if (opts.onCommentPosted) opts.onCommentPosted();
    },
    async addIssueLabel(n, label) {
      calls.push(['addIssueLabel', n, label]);
      if (opts.addThrows) throw new Error('label add failed');
      if (!world[n].issue.labels.includes(label)) world[n].issue.labels.push(label);
    },
    async removeIssueLabel(n, label) {
      calls.push(['removeIssueLabel', n, label]);
      if (opts.removeThrows) throw new Error('label remove failed');
      world[n].issue.labels = world[n].issue.labels.filter((l) => l !== label);
      if (opts.onLabelRemoved) opts.onLabelRemoved();
    },
  };
  return { port, calls };
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

function refinedContract() {
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
  };
}

function roleRun(agentId, provider, model) {
  return {
    agentId,
    provider,
    model,
    modelSource: 'default',
    effort: 'high',
    effortSource: 'default',
    invocations: 1,
    totalDurationMs: 100,
  };
}

/** A block exactly as the #869 loop leaves it at `accepted`, against `world`. */
async function acceptedBlock(world, { topology = [] } = {}) {
  const block = buildRefinementContextBlock({
    issueNumber: 500,
    title: world[500].issue.title,
    body: world[500].issue.body,
    labels: world[500].issue.labels,
    agentLabel: 'agent:claude',
    implementationAgent: 'claude',
    refinerAgent: 'claude',
    criticAgent: 'codex',
    settings: settingsFor(),
    laneLabels: LANE_LABELS,
    now: NOW,
  });
  const { port } = makeSource(world);
  const snap = await buildRefinementSnapshot({
    target: structuredClone(world[500].issue),
    source: port,
    limits: block.limits,
    laneLabels: LANE_LABELS,
    stackReadyLabel: STACK_READY,
    now: NOW,
  });
  if (snap.kind !== 'captured') throw new Error(`fixture snapshot not captured: ${snap.kind}`);
  block.state = 'accepted';
  block.predecessorFingerprint = snap.snapshot.predecessorFingerprint;
  block.predecessors = refinementPredecessorRecords(snap.snapshot);
  block.accepted = {
    contract: refinedContract(),
    topology,
    refinerConfidence: 'high',
    criticConfidence: 'high',
    roundsUsed: 1,
    regionBytes: 0,
    acceptedAt: NOW,
  };
  block.execution = {
    runId: 'run-loop',
    refiner: roleRun('claude', 'anthropic', 'opus'),
    critic: roleRun('codex', 'openai', 'gpt-5-codex'),
  };
  return block;
}

let tmpDir;
let runSeq;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'refine-apply-'));
  runSeq = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function runApply(block, world, { sourceOpts = {}, portOpts = {}, runId } = {}) {
  runSeq += 1;
  const id = runId ?? `apply-${runSeq}`;
  const { port: source, calls: reads } = makeSource(world, sourceOpts);
  const { port: applyPort, calls } = makePort(world, portOpts);
  const result = await executeRefinementApply(
    {
      issueNumber: 500,
      block,
      stackReadyLabel: STACK_READY,
      artifactDir: join(tmpDir, id),
      runId: id,
    },
    { source, applyPort, now: () => Date.parse(NOW) },
  );
  return { result, calls, reads, artifactDir: join(tmpDir, id) };
}

// ---------------------------------------------------------------------------
// The normal path: commit point, then body → comment → labels → activated
// ---------------------------------------------------------------------------

describe('executeRefinementApply — commit point and full application', () => {
  test('row 22: a matching live fingerprint persists applying + appliedRegionDigest and performs NO GitHub write', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const { result, calls, artifactDir } = await runApply(block, world);

    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.block.state).toBe('applying');
    const rendered = renderManagedRegion(refinedContract(), block.predecessorFingerprint);
    expect(result.block.appliedRegionDigest).toBe(computeAppliedRegionDigest(rendered));
    expect(result.block.apply).toMatchObject({
      bodyVerified: false,
      commentPosted: false,
      transientFailures: 0,
    });
    // The §16 comment nonce is minted AT the commit point, so it is durably
    // persisted before any GitHub write and a crash-retry can authenticate
    // the comment it already delivered.
    expect(result.block.apply.commentNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(result.events.map((e) => e.type)).toEqual(['refinement.accepted.persisted']);
    expect(result.taskStatus).toBeNull();
    // Nothing GitHub-visible before the commit point has durably persisted.
    expect(calls).toHaveLength(0);
    // The accepted artifact and rendered region are preserved locally.
    expect(result.artifacts).toContain('accepted-refinement.json');
    expect(readFileSync(join(artifactDir, 'managed-region.md'), 'utf8')).toBe(rendered);
  });

  test('the effect run applies body first and labels last, verifies the body from a re-read, and activates', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    const { result, calls, artifactDir } = await runApply(committed, world);

    expect(result.outcome).toEqual({ kind: 'activated' });
    expect(result.block.state).toBe('activated');
    expect(result.taskStatus).toBeNull();

    // Acceptance criterion: body-first, labels-last, removal before addition.
    expect(calls.map((c) => c[0])).toEqual([
      'updateIssueBody',
      'postIssueComment',
      'removeIssueLabel',
      'addIssueLabel',
    ]);
    // The label plan comes from the persisted activation plan, not literals.
    expect(calls[2]).toEqual(['removeIssueLabel', 500, block.activationPlan.markerLabel]);
    expect(calls[3]).toEqual(['addIssueLabel', 500, block.activationPlan.implementationStatusLabel]);

    // §10: everything outside the markers is preserved byte-for-byte, and the
    // written region digests to the persisted appliedRegionDigest.
    expect(world[500].issue.body.startsWith('Downstream body\n\n')).toBe(true);
    const live = extractManagedRegion(world[500].issue.body);
    expect(live.kind).toBe('present');
    expect(live.regionDigest).toBe(committed.appliedRegionDigest);

    // Labels: marker out, implementation status in, agent:* untouched (§14).
    expect(world[500].issue.labels).toContain('agent:claude');
    expect(world[500].issue.labels).toContain(IMPLEMENTATION_STATUS_LABEL);
    expect(world[500].issue.labels).not.toContain(DEFAULT_REFINEMENT_MARKER_LABEL);

    // One §16 comment, carrying the nonce-authenticated idempotency marker.
    expect(world[500].comments).toHaveLength(1);
    expect(
      hasRefinementComment(
        world[500].comments.map((c) => c.body),
        block.predecessorFingerprint,
        committed.apply.commentNonce,
      ),
    ).toBe(true);

    // §15: the prior body is preserved as a local, never-published artifact.
    expect(readFileSync(join(artifactDir, 'prior-issue-body.md'), 'utf8')).toBe('Downstream body');

    expect(result.events.map((e) => e.type)).toEqual([
      'refinement.applied',
      'refinement.comment.posted',
      'refinement.activated',
    ]);
    // §10 trust record for a later refinement of the same Issue.
    expect(result.block.appliedRefinements).toHaveLength(1);
    expect(result.block.appliedRefinements[0].fingerprintPrefix).toBe(
      refinementFingerprintPrefix(block.predecessorFingerprint),
    );
  });
});

// ---------------------------------------------------------------------------
// Staleness — rows 23/24 and 26/27: stale fingerprints cannot activate
// ---------------------------------------------------------------------------

describe('executeRefinementApply — staleness', () => {
  test('rows 23/26: a moved predecessor discards the draft with NO GitHub write, in both states', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    world[10].pr.headSha = sha(99);

    const fromAccepted = await runApply(block, world);
    expect(fromAccepted.result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'fingerprint' });
    expect(fromAccepted.result.block.state).toBe('eligible');
    expect(fromAccepted.result.block.accepted).toBeUndefined();
    expect(fromAccepted.result.block.appliedRegionDigest).toBeNull();
    expect(fromAccepted.result.block.counters.staleRestarts).toBe(1);
    expect(fromAccepted.result.events.map((e) => e.type)).toEqual(['refinement.stale.detected']);
    expect(fromAccepted.calls).toHaveLength(0);

    // Same disposition from `applying` (row 26): commit against fresh state,
    // then move the predecessor before the effect run.
    const world2 = defaultWorld();
    const block2 = await acceptedBlock(world2);
    const committed = (await runApply(block2, world2)).result.block;
    world2[10].pr.headSha = sha(77);
    const fromApplying = await runApply(committed, world2);
    expect(fromApplying.result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'fingerprint' });
    expect(fromApplying.calls).toHaveLength(0);
    expect(world2[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
    expect(world2[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
  });

  test('rows 24: at the stale cap the attempt escalates stale_inputs instead of restarting', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    block.counters.staleRestarts = block.limits.maxStaleRestartsPerIssue;
    world[10].pr.headSha = sha(99);

    const { result, calls } = await runApply(block, world);
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'stale_inputs' });
    expect(result.block.state).toBe('escalated_human');
    expect(result.taskStatus).toBe('ready_for_human');
    expect(calls).toHaveLength(0);
    // The Issue is left NOT implementation-eligible: no label ever moved.
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
  });

  test('an editing of the target body outside the region is a fingerprint change too', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    world[500].issue.body = 'Downstream body, edited by an operator';

    const { result, calls } = await runApply(committed, world);
    expect(result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'fingerprint' });
    expect(calls).toHaveLength(0);
  });

  test('rows 26/27: a target edited during the predecessor sweep is caught by the pre-dispatch re-read and never overwritten', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // The operator edits the Issue while the effect run is still reading
    // predecessors — after the run's initial target read (which the snapshot
    // fingerprint certifies), before the body PATCH would dispatch.
    const edited = 'Downstream body, edited by an operator mid-sweep';
    const { result, calls } = await runApply(committed, world, {
      sourceOpts: {
        onReviewSummary: () => {
          world[500].issue.body = edited;
        },
      },
    });

    expect(result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'fingerprint' });
    expect(result.events.map((e) => e.type)).toEqual(['refinement.stale.detected']);
    expect(result.events[0].data.reason).toBe('target_changed');
    // No write dispatched: the concurrent edit survives untouched.
    expect(calls).toHaveLength(0);
    expect(world[500].issue.body).toBe(edited);
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
  });

  test('a predecessor moved after the body write is caught by the pre-comment re-verification, before the audit comment posts', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // The predecessor's PR head moves after the run-start verification and
    // the body PATCH, before the audit comment dispatches. The post-write
    // region re-read cannot see it — only the full snapshot comparison the
    // comment stage re-runs at its entry can.
    const { result, calls } = await runApply(committed, world, {
      portOpts: {
        onBodyUpdated: () => {
          world[10].pr.headSha = sha(88);
        },
      },
    });

    expect(result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'fingerprint' });
    expect(result.block.state).toBe('eligible');
    const stale = result.events.find((e) => e.type === 'refinement.stale.detected');
    expect(stale.data.reason).toBe('fingerprint_mismatch');
    expect(stale.data.stage).toBe('pre_comment');
    // The body write stands, and its §10 trust record survives the restart so
    // the next attempt may replace the region in place — but no audit comment
    // publishes and no label moves for the stale contract.
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody']);
    expect(world[500].comments).toHaveLength(0);
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
    expect(world[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
    expect(result.block.appliedRefinements).toHaveLength(1);
  });

  test('a target retitled while the comment posts is caught by the label-stage re-verification, before any label moves', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // An operator edit entirely OUTSIDE the managed region, landing after the
    // audit comment delivered: the pre-label region check still passes, so
    // only the full fingerprint comparison at the label stage's entry can
    // refuse to make the Issue implementation-eligible.
    const { result, calls } = await runApply(committed, world, {
      portOpts: {
        onCommentPosted: () => {
          world[500].issue.title = 'Downstream Issue, retitled by an operator';
        },
      },
    });

    expect(result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'fingerprint' });
    const stale = result.events.find((e) => e.type === 'refinement.stale.detected');
    expect(stale.data.reason).toBe('fingerprint_mismatch');
    expect(stale.data.stage).toBe('labels');
    // Body and comment stand; the label transition never dispatches.
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'postIssueComment']);
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
    expect(world[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
  });

  test('a predecessor moved between the marker removal and the status addition cannot activate', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // The predecessor's PR head moves in the narrowest window: after the
    // marker removal delivers, before the status addition dispatches. The
    // label stage's ENTRY verification passed against the old head, and the
    // post-removal region/label re-reads cannot see a predecessor at all —
    // only a full fingerprint re-verification directly ahead of the addition
    // can refuse to make the Issue implementation-eligible.
    const { result, calls } = await runApply(committed, world, {
      portOpts: {
        onLabelRemoved: () => {
          world[10].pr.headSha = sha(66);
        },
      },
    });

    expect(result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'fingerprint' });
    expect(result.block.state).toBe('eligible');
    const stale = result.events.find((e) => e.type === 'refinement.stale.detected');
    expect(stale.data.reason).toBe('fingerprint_mismatch');
    expect(stale.data.stage).toBe('post_removal');
    // The addition never dispatched: the stale contract cannot activate.
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'postIssueComment', 'removeIssueLabel']);
    expect(world[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Idempotent recovery — retry after partial body/comment/label delivery
// ---------------------------------------------------------------------------

describe('executeRefinementApply — idempotent partial-delivery recovery', () => {
  test('a comment failure after the body write retries without a second body write and completes', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    const first = await runApply(committed, world, { portOpts: { commentThrows: true } });
    expect(first.result.outcome).toMatchObject({
      kind: 'write_failed',
      step: 'post_audit_comment',
      transientFailures: 1,
    });
    expect(first.result.block.state).toBe('applying');
    expect(first.result.block.apply.bodyVerified).toBe(true);
    expect(first.result.block.appliedRefinements).toHaveLength(1);
    expect(first.calls.map((c) => c[0])).toEqual(['updateIssueBody', 'postIssueComment']);
    // No label moved: the Issue is not implementation-eligible mid-failure.
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
    expect(world[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);

    const retry = await runApply(first.result.block, world);
    expect(retry.result.outcome).toEqual({ kind: 'activated' });
    // The verified body stage is not re-performed and not re-announced.
    expect(retry.calls.map((c) => c[0])).toEqual([
      'postIssueComment',
      'removeIssueLabel',
      'addIssueLabel',
    ]);
    expect(retry.result.events.map((e) => e.type)).toEqual([
      'refinement.comment.posted',
      'refinement.activated',
    ]);
    expect(world[500].comments).toHaveLength(1);
  });

  test('a crash after the body write but before any commit converges via the §10 byte-identity no-op', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // Simulate a delivered-but-uncommitted body write: the live body already
    // holds exactly the bytes this attempt renders, while the block still
    // says bodyVerified: false.
    const rendered = renderManagedRegion(refinedContract(), block.predecessorFingerprint);
    world[500].issue.body = spliceManagedRegion(world[500].issue.body, rendered);

    const { result, calls } = await runApply(committed, world);
    expect(result.outcome).toEqual({ kind: 'activated' });
    expect(calls.map((c) => c[0])).toEqual(['postIssueComment', 'removeIssueLabel', 'addIssueLabel']);
    const applied = result.events.find((e) => e.type === 'refinement.applied');
    expect(applied.data.mode).toBe('identical');
  });

  test('a comment delivered by a crashed run is deduplicated on its nonce-authenticated marker, never posted twice', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    world[500].comments.push({
      id: 'crashed-run',
      createdAt: NOW,
      updatedAt: NOW,
      body: `earlier delivery\n${refinementCommentMarker(block.predecessorFingerprint, committed.apply.commentNonce)}`,
    });

    const { result, calls } = await runApply(committed, world);
    expect(result.outcome).toEqual({ kind: 'activated' });
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'removeIssueLabel', 'addIssueLabel']);
    const posted = result.events.find((e) => e.type === 'refinement.comment.posted');
    expect(posted.data.deduplicated).toBe(true);
    expect(world[500].comments).toHaveLength(1);
  });

  test('a forged marker from an untrusted commenter does not stand in for the audit comment', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    // The fingerprint prefix is publicly derivable (the body's begin marker
    // carries it), so any commenter can produce this much — but not the
    // nonce, which only the local commit record knows before the genuine
    // comment is posted.
    const prefix = refinementFingerprintPrefix(block.predecessorFingerprint);
    world[500].comments.push(
      {
        id: 'forgery-no-nonce',
        createdAt: NOW,
        updatedAt: NOW,
        body: `looks official\n${REFINEMENT_COMMENT_MARKER_PREFIX}${prefix} -->`,
      },
      {
        id: 'forgery-wrong-nonce',
        createdAt: NOW,
        updatedAt: NOW,
        body: `still forged\n${refinementCommentMarker(block.predecessorFingerprint, 'f'.repeat(32))}`,
      },
    );

    const { result, calls } = await runApply(committed, world);
    expect(result.outcome).toEqual({ kind: 'activated' });
    // The genuine audit comment is still posted; activation never rides on
    // the forgeries.
    expect(calls.map((c) => c[0])).toEqual([
      'updateIssueBody',
      'postIssueComment',
      'removeIssueLabel',
      'addIssueLabel',
    ]);
    expect(world[500].comments).toHaveLength(3);
    const posted = result.events.find((e) => e.type === 'refinement.comment.posted');
    expect(posted.data.deduplicated).toBeUndefined();
  });

  test('the §16 idempotency scan covers the full comment history, not a bounded recent window', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    world[500].comments.push({
      id: 'crashed-run',
      createdAt: NOW,
      updatedAt: NOW,
      body: `earlier delivery\n${refinementCommentMarker(block.predecessorFingerprint, committed.apply.commentNonce)}`,
    });
    // An active Issue: enough later discussion to push the crashed run's
    // delivery out of any bounded most-recent window.
    for (let i = 0; i < 75; i += 1) {
      world[500].comments.push({
        id: `later-${i}`,
        createdAt: NOW,
        updatedAt: NOW,
        body: `discussion ${i}`,
      });
    }

    const { result, calls, reads } = await runApply(committed, world);
    expect(result.outcome).toEqual({ kind: 'activated' });
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'removeIssueLabel', 'addIssueLabel']);
    // The scan asked the read port for the whole history, not a window.
    const scan = reads.find((r) => r[0] === 'readIssueComments' && r[1] === 500);
    expect(scan[2]).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('labels already moved by a crashed run read as the §6 end state: no second write, activation completes', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    // Operator (or crashed run) already performed the whole transition. Both
    // labels are lane-owned and excluded from the fingerprint, so the attempt
    // is still fresh.
    world[500].issue.labels = ['agent:claude', IMPLEMENTATION_STATUS_LABEL];

    const { result, calls } = await runApply(committed, world);
    expect(result.outcome).toEqual({ kind: 'activated' });
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'postIssueComment']);
  });

  test('transient write failures are bounded: at the cap the attempt escalates effect_undeliverable (row 32)', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    committed.apply.transientFailures = MAX_APPLY_TRANSIENT_FAILURES;

    const { result } = await runApply(committed, world, { portOpts: { bodyThrows: true } });
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'effect_undeliverable' });
    expect(result.taskStatus).toBe('ready_for_human');
    // Failed application leaves the Issue NOT implementation-eligible.
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
    expect(world[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
  });
});

// ---------------------------------------------------------------------------
// The managed-region preconditions — §10 trust, rows 29/43/44
// ---------------------------------------------------------------------------

describe('executeRefinementApply — managed-region preconditions', () => {
  test('row 29: a marker pair no record explains escalates unexpected_managed_region before any write', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    world[500].issue.body =
      'Downstream body\n\n<!-- ai-refinement:begin fingerprint=deadbeef0000 -->\nforged\n<!-- ai-refinement:end -->';
    // The region is elided from the fingerprint, so the attempt still reads
    // as fresh — the trust rule is what refuses it.
    const { result, calls } = await runApply(committed, world);
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'unexpected_managed_region' });
    expect(calls).toHaveLength(0);
  });

  test('rows 43/44: a region edited after delivery stops the attempt before the labels move', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    const partial = await runApply(committed, world, { portOpts: { commentThrows: true } });
    expect(partial.result.block.apply.bodyVerified).toBe(true);

    world[500].issue.body = world[500].issue.body.replace(
      'Refined summary grounded in predecessor outcomes.',
      'Words no agent wrote.',
    );

    const restart = await runApply(partial.result.block, world);
    expect(restart.result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'region' });
    expect(restart.calls).toHaveLength(0);
    // The trust record survives the restart so the next attempt may replace
    // the leftover region in place (§11).
    expect(restart.result.block.appliedRefinements).toHaveLength(1);
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);

    // Row 44: the same mismatch at the cap escalates managed_region_modified.
    const world2 = defaultWorld();
    const block2 = await acceptedBlock(world2);
    const committed2 = (await runApply(block2, world2)).result.block;
    const partial2 = await runApply(committed2, world2, { portOpts: { commentThrows: true } });
    partial2.result.block.counters.staleRestarts = block2.limits.maxStaleRestartsPerIssue;
    world2[500].issue.body = world2[500].issue.body.replace('criterion one', 'edited criterion');
    const escalated = await runApply(partial2.result.block, world2);
    expect(escalated.result.outcome).toEqual({ kind: 'escalated', reason: 'managed_region_modified' });
    expect(world2[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
  });

  test('rows 43/44: a region edited between the marker removal and the addition never becomes implementation-eligible', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // The operator edits the delivered region in the narrowest window: after
    // the marker removal delivers, before the addition dispatches. The
    // pre-label region check passed; the post-removal re-read must re-check
    // it, not just the labels.
    const { result, calls } = await runApply(committed, world, {
      portOpts: {
        onLabelRemoved: () => {
          world[500].issue.body = world[500].issue.body.replace('criterion one', 'edited criterion');
        },
      },
    });

    expect(result.outcome).toMatchObject({ kind: 'stale_restart', trigger: 'region' });
    const stale = result.events.find((e) => e.type === 'refinement.stale.detected');
    expect(stale.data.reason).toBe('region_mismatch');
    expect(stale.data.stage).toBe('post_removal');
    // The addition never dispatched: the edited region cannot activate.
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'postIssueComment', 'removeIssueLabel']);
    expect(world[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Marker preconditions — row 42
// ---------------------------------------------------------------------------

describe('executeRefinementApply — marker preconditions (row 42)', () => {
  test('a different executable status appearing mid-run stops the label stage with the marker still in place', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // The operator applies status:needs-fix while the comment posts — after
    // the run-start fingerprint verification, before the label stage.
    const { result, calls } = await runApply(committed, world, {
      portOpts: {
        onCommentPosted: () => {
          world[500].issue.labels.push('status:needs-fix');
        },
      },
    });

    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'marker_precondition_failed' });
    expect(result.taskStatus).toBe('ready_for_human');
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'postIssueComment']);
    // §13: the escalation leaves status:needs-refinement in place and adds no
    // executable status — the Issue cannot drift into implementation.
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
    expect(world[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
  });

  test('row 42: an executable status added between the removal and the addition escalates instead of stacking a second one', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // The operator applies status:needs-fix in the narrowest window: after
    // the marker removal delivers, before the addition dispatches. The
    // pre-removal disposition said `perform`; the post-removal re-read must
    // re-decide it.
    const { result, calls } = await runApply(committed, world, {
      portOpts: {
        onLabelRemoved: () => {
          world[500].issue.labels.push('status:needs-fix');
        },
      },
    });

    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'marker_precondition_failed' });
    expect(result.taskStatus).toBe('ready_for_human');
    const escalated = result.events.find((e) => e.type === 'refinement.escalated.human');
    expect(escalated.data.conflictingLabels).toEqual(['status:needs-fix']);
    expect(escalated.data.stage).toBe('post_removal');
    // The addition never dispatched: the operator's status stands alone
    // rather than beside a second executable status.
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'postIssueComment', 'removeIssueLabel']);
    expect(world[500].issue.labels).not.toContain(IMPLEMENTATION_STATUS_LABEL);
    expect(world[500].issue.labels).toContain('status:needs-fix');
  });

  test('row 42: a pre-existing marker beside status:needs-implementation escalates instead of silently activating', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;

    // The exact two-marker state §3 refuses, already on the Issue when the
    // label stage reads it (an operator re-added the marker after a prior
    // partial run's label addition, or added the status by hand). Eliding the
    // marker as "what our own removal is about to deliver" would read this as
    // `satisfied` and advance.
    world[500].issue.labels.push(IMPLEMENTATION_STATUS_LABEL);

    const { result, calls } = await runApply(committed, world);
    expect(result.outcome).toEqual({ kind: 'escalated', reason: 'marker_precondition_failed' });
    expect(result.taskStatus).toBe('ready_for_human');
    const escalated = result.events.find((e) => e.type === 'refinement.escalated.human');
    expect(escalated.data.conflictingLabels).toEqual([DEFAULT_REFINEMENT_MARKER_LABEL]);
    // Neither label write dispatched: the conflicting pair is left intact for
    // the operator, with §13's marker still in place.
    expect(calls.map((c) => c[0])).toEqual(['updateIssueBody', 'postIssueComment']);
    expect(world[500].issue.labels).toContain(DEFAULT_REFINEMENT_MARKER_LABEL);
    expect(world[500].issue.labels).toContain(IMPLEMENTATION_STATUS_LABEL);
    expect(result.block.state).toBe('escalated_human');
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('executeRefinementApply — refusals', () => {
  test('a block in any other state is refused untouched', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    block.state = 'critiquing';
    const { result, calls } = await runApply(block, world);
    expect(result.outcome).toEqual({ kind: 'refused', detail: 'state:critiquing' });
    expect(calls).toHaveLength(0);
  });

  test('an applying block whose persisted digest does not match its own re-render is refused', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    committed.appliedRegionDigest = 'not-the-digest';
    const { result, calls } = await runApply(committed, world);
    expect(result.outcome).toEqual({ kind: 'refused', detail: 'appliedRegionDigest:drift' });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The phase-runner handler dispatch (issue #870)
// ---------------------------------------------------------------------------

describe('createRefinementHandler — application dispatch', () => {
  const handlerSession = () => ({
    sessionId: 'addon-dev',
    artifactRoot: tmpDir,
    labels: { stackReady: STACK_READY },
    issueRefinement: { enabled: true, agents: { refiner: 'claude', critic: 'codex' } },
  });

  test('an accepted block runs the commit point and maps to success with the applying block', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const { port: source } = makeSource(world);
    const { port: applyPort, calls } = makePort(world);
    const handler = createRefinementHandler(
      { session: handlerSession(), runId: 'run-a1', workerId: 'w' },
      { source, applyPort },
    );

    const result = await handler({
      sessionId: 'addon-dev',
      issueNumber: 500,
      phase: 'refinement',
      context: { refinement: block },
    });

    expect(result.result).toBe('success');
    expect(result.refinementActivation).toBeUndefined();
    expect(result.context.refinement.state).toBe('applying');
    expect(result.extraEvents.map((e) => e.type)).toEqual(['refinement.accepted.persisted']);
    expect(calls).toHaveLength(0);
  });

  test('an applying block that activates maps to success + the row-45 park routing from the persisted plan', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const committed = (await runApply(block, world)).result.block;
    const { port: source } = makeSource(world);
    const { port: applyPort } = makePort(world);
    const handler = createRefinementHandler(
      { session: handlerSession(), runId: 'run-a2', workerId: 'w' },
      { source, applyPort },
    );

    const result = await handler({
      sessionId: 'addon-dev',
      issueNumber: 500,
      phase: 'refinement',
      context: { refinement: committed },
    });

    expect(result.result).toBe('success');
    expect(result.context.refinement.state).toBe('activated');
    expect(result.refinementActivation).toEqual({
      targetStatus: 'blocked',
      targetPhase: 'implementation',
    });
  });

  test('an accepted block with no apply port parks for an operator instead of failing or skipping stages', async () => {
    const world = defaultWorld();
    const block = await acceptedBlock(world);
    const { port: source, calls } = makeSource(world);
    const handler = createRefinementHandler(
      { session: handlerSession(), runId: 'run-a3', workerId: 'w' },
      { source },
    );

    const result = await handler({
      sessionId: 'addon-dev',
      issueNumber: 500,
      phase: 'refinement',
      context: { refinement: block },
    });

    expect(result.result).toBe('blocked');
    expect(result.message).toContain('write port');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pure core — §10 splice/trust, §6 label preconditions, §16 comment
// ---------------------------------------------------------------------------

describe('issue-refinement-apply core', () => {
  const FP = 'a'.repeat(64);
  const rendered = renderManagedRegion(refinedContract(), FP);

  test('spliceManagedRegion appends with one blank-line separator and replaces in place byte-preservingly', () => {
    expect(spliceManagedRegion('', rendered)).toBe(rendered);
    const appended = spliceManagedRegion('Original body', rendered);
    expect(appended).toBe(`Original body\n\n${rendered}`);

    const other = renderManagedRegion(
      { ...refinedContract(), summary: 'A different summary.' },
      FP,
    );
    const replaced = spliceManagedRegion(`intro\n\n${rendered}\n\ntrailer`, other);
    expect(replaced).toBe(`intro\n\n${other}\n\ntrailer`);
  });

  test('evaluateManagedRegionWrite: byte-identity first, then record-keyed trust, then refusal', () => {
    const prefix = refinementFingerprintPrefix(FP);
    const body = `intro\n\n${rendered}`;
    // Identical bytes need no trust record at all.
    expect(evaluateManagedRegionWrite(body, rendered, [])).toEqual({ kind: 'identical' });
    const edited = body.replace('criterion one', 'edited');
    expect(evaluateManagedRegionWrite(edited, rendered, [prefix])).toEqual({ kind: 'replace' });
    expect(evaluateManagedRegionWrite(edited, rendered, [])).toEqual({
      kind: 'untrusted',
      fingerprintPrefix: prefix,
    });
    expect(evaluateManagedRegionWrite('no region here', rendered, [])).toEqual({ kind: 'append' });
    expect(
      evaluateManagedRegionWrite('<!-- ai-refinement:end -->\norphan', rendered, [prefix]),
    ).toEqual({ kind: 'malformed' });
  });

  test('evaluateStatusAddition implements the §6 marker preconditions', () => {
    const add = IMPLEMENTATION_STATUS_LABEL;
    const marker = DEFAULT_REFINEMENT_MARKER_LABEL;
    expect(evaluateStatusAddition(['agent:claude'], marker, add)).toEqual({ kind: 'perform' });
    expect(evaluateStatusAddition(['agent:claude', add], marker, add)).toEqual({ kind: 'satisfied' });
    expect(evaluateStatusAddition(['status:needs-fix'], marker, add)).toEqual({
      kind: 'conflict',
      conflictingLabels: ['status:needs-fix'],
    });
    // The two-marker state §3 refuses is a conflict, never satisfied.
    expect(evaluateStatusAddition([marker, add], marker, add)).toMatchObject({ kind: 'conflict' });
    expect(evaluateStatusAddition([marker], marker, add)).toMatchObject({ kind: 'conflict' });
  });

  test('the §16 audit comment carries the allowed metadata and nothing forbidden', () => {
    const nonce = 'abcdef0123456789abcdef0123456789';
    const comment = renderRefinementAuditComment({
      predecessorFingerprint: FP,
      commentNonce: nonce,
      predecessors: [{ issueNumber: 10, prNumber: 910, headSha: sha(10), state: 'open' }],
      refiner: roleRun('claude', 'anthropic', 'opus'),
      critic: roleRun('codex', 'openai', 'gpt-5-codex'),
      refinerConfidence: 'high',
      criticConfidence: 'medium',
      roundsUsed: 2,
      malformedAttempts: { refiner: 1, critic: 0 },
      staleRestarts: 1,
      topology: [
        {
          index: 0,
          kind: 'split',
          rationale: 'the second half stands alone',
          refinerDisposition: 'advisory',
          criticDisposition: 'advisory',
          effective: 'advisory',
        },
      ],
    });

    expect(comment).toContain(`#10 (PR #910, \`${sha(10).slice(0, 12)}\`)`);
    expect(comment).toContain(refinementFingerprintPrefix(FP));
    expect(comment).toContain('`claude`');
    expect(comment).toContain('`codex`');
    expect(comment).toContain('Critic verdict: `pass`');
    expect(comment).toContain('Rounds used: 2; malformed attempts: refiner 1, critic 0; stale restarts: 1');
    expect(comment).toContain('**not** applied');
    expect(comment).toContain('the second half stands alone');
    expect(comment).toContain('managed region');
    expect(comment).toContain(refinementCommentMarker(FP, nonce));

    // Posted at §11 step 4, BEFORE the label transition: the comment must not
    // assert the activation outcome, and the §16 allowlist has no place for
    // the label transition either.
    expect(comment).not.toContain('activated');
    expect(comment).not.toContain(IMPLEMENTATION_STATUS_LABEL);
    expect(comment).not.toContain(DEFAULT_REFINEMENT_MARKER_LABEL);

    // §16 "never published": no filesystem path, no region markers, no run id.
    expect(containsFilesystemPath(comment)).toBe(false);
    expect(containsManagedRegionMarker(comment)).toBe(false);
    expect(comment).not.toContain('run-');
  });
});

// ---------------------------------------------------------------------------
// gh apply port adapter
// ---------------------------------------------------------------------------

describe('createGhRefinementApplyPort', () => {
  function recordingPort(onCall) {
    const calls = [];
    const port = createGhRefinementApplyPort({
      githubRepo: 'm2dw/repo',
      runGh: (args) => {
        calls.push(args);
        if (onCall) onCall(args);
        return '{}';
      },
    });
    return { port, calls };
  }

  test('issues the same REST shapes the gh work-item provider uses', async () => {
    const { port, calls } = recordingPort();
    await port.updateIssueBody(500, 'new body');
    await port.postIssueComment(500, 'comment body');
    await port.addIssueLabel(500, 'status:needs-implementation');
    await port.removeIssueLabel(500, 'status:needs-refinement');

    expect(calls[0]).toEqual([
      'api', 'repos/m2dw/repo/issues/500', '--method', 'PATCH', '--raw-field', 'body=new body',
    ]);
    expect(calls[1]).toEqual([
      'api', 'repos/m2dw/repo/issues/500/comments', '--method', 'POST', '--raw-field', 'body=comment body',
    ]);
    expect(calls[2]).toEqual([
      'api', 'repos/m2dw/repo/issues/500/labels', '--method', 'POST', '--field', 'labels[]=status:needs-implementation',
    ]);
    expect(calls[3]).toEqual([
      'api', 'repos/m2dw/repo/issues/500/labels/status%3Aneeds-refinement', '--method', 'DELETE',
    ]);
  });

  test('sends an @-prefixed body as a literal raw field, never a gh file reference', async () => {
    const { port, calls } = recordingPort();
    await port.updateIssueBody(500, '@octocat please review\n\nRefined contract.');
    await port.postIssueComment(500, '@octocat applied.');

    expect(calls[0].slice(-2)).toEqual(['--raw-field', 'body=@octocat please review\n\nRefined contract.']);
    expect(calls[1].slice(-2)).toEqual(['--raw-field', 'body=@octocat applied.']);
  });

  test('tolerates a 404 on label removal (already absent) and propagates every other failure', async () => {
    const notFound = recordingPort(() => {
      throw new Error('gh api ... failed (exit 1): HTTP 404: Not Found');
    });
    await expect(notFound.port.removeIssueLabel(500, 'status:needs-refinement')).resolves.toBeUndefined();

    const forbidden = recordingPort(() => {
      throw new Error('gh api ... failed (exit 1): HTTP 403: Forbidden');
    });
    await expect(forbidden.port.removeIssueLabel(500, 'x')).rejects.toThrow('403');
    await expect(forbidden.port.updateIssueBody(500, 'b')).rejects.toThrow('403');
  });
});
