/**
 * Issue #936 — publishing a terminal PIR handoff to GitHub
 * (docs/issue-refinement-contract.md §13 items 3–4, §16).
 *
 * The live #697 pilot ended with the task at `ready_for_human` / `refinement` /
 * `escalated_human` / `agent_unavailable` and the Issue carrying nothing but
 * `status:needs-refinement`: no ready-for-human label, no handoff comment, and
 * no outbox row at all, so the only way to discover the stop was
 * `admin task-status`. These tests pin the two effects that close that gap, the
 * bound and the redaction on their public text, and the run-independent keys
 * that keep a phase retry from publishing the handoff twice.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { OUTBOX_MAX_ATTEMPTS } from '../dist/core/outbox.js';
import {
  enqueueRefinementHandoffEffects,
  recordRefinementHandoffCommentUndeliverable,
  repairRefinementHandoffCommentUndeliverable,
} from '../dist/core/outbox-effects.js';
import { dispatchOutbox } from '../dist/handlers/gh-dispatcher.js';
import { main } from '../dist/cli/dispatch-outbox.js';
import {
  MAX_HANDOFF_COMMENT_CHARS,
  REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT,
  REFINEMENT_HANDOFF_MARKER,
  REFINEMENT_HANDOFF_NEXT_ACTIONS,
  publishableRefinementHandoff,
  publishableRefinementHandoffFromContext,
  refinementHandoffCommentMarker,
  refinementHandoffEffectFromKey,
  refinementHandoffIdempotencyKey,
  renderRefinementHandoffComment,
} from '../dist/core/issue-refinement-publication.js';
import { REFINEMENT_HANDOFF_REASONS, ISSUE_REFINEMENT_DEFAULT_LIMITS } from '../dist/core/issue-refinement.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;

const SESSION = {
  sessionId: 'addon-dev',
  repoKey: 'some-repo',
  repoRoot: '/tmp/some-repo',
  githubRepo: 'm2dw/some-repo',
  githubOwner: 'm2dw',
  githubName: 'some-repo',
  artifactDir: '.n8n-artifacts',
  artifactRoot: '/tmp/some-repo/.n8n-artifacts',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: {},
  labels: {
    active: 'ai:active',
    blocked: 'ai:blocked',
    readyForHuman: 'ai:ready-for-human',
    needsImplementation: 'status:needs-implementation',
  },
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
};

const NOW = '2026-08-18T09:00:00.000Z';

function block(overrides = {}) {
  return {
    state: 'escalated_human',
    handoffReason: 'agent_unavailable',
    predecessorFingerprint: null,
    appliedRegionDigest: null,
    sourceFingerprint: 'deadbeef',
    managedRegion: 'absent',
    predecessors: [],
    counters: {
      rounds: 1,
      malformedAttempts: { refiner: 0, critic: 1 },
      agentFailures: { refiner: 2, critic: 0 },
      staleRestarts: 0,
    },
    limits: { ...ISSUE_REFINEMENT_DEFAULT_LIMITS },
    roles: { implementationAgent: 'claude', refinerAgent: 'claude', criticAgent: 'codex', allowSameProvider: false },
    activationPlan: {},
    markerLabel: 'status:needs-refinement',
    admittedAt: NOW,
    updatedAt: NOW,
    execution: {
      runId: 'run-secret-1',
      refiner: {
        agentId: 'claude',
        provider: 'anthropic',
        model: 'claude-opus',
        modelSource: 'session',
        effort: 'high',
        effortSource: 'default',
        invocations: 3,
        totalDurationMs: 1234,
      },
      critic: null,
    },
    ...overrides,
  };
}

async function pending() {
  const store = new SqliteOutboxStore(dbPath);
  try {
    return await store.listUnsent();
  } finally {
    store.close();
  }
}

/** Swallow the single JSON object `dispatch-outbox`'s `main()` writes to stdout. */
async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
}

async function enqueueHandoff(context, session = SESSION, issueNumber = 697) {
  const store = new SqliteOutboxStore(dbPath);
  try {
    await enqueueRefinementHandoffEffects(store, session, { issueNumber }, context, NOW);
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'refinement-handoff-test-'));
  dbPath = join(tmpDir, 'test.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeFileSync(
    sessionsPath,
    JSON.stringify({
      sessions: [
        {
          sessionId: 'addon-dev',
          repoKey: 'some-repo',
          repoRoot: tmpDir,
          githubRepo: 'm2dw/some-repo',
          artifactDir: '.n8n-artifacts',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: {},
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        },
      ],
    }),
    'utf8',
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The gate: what may be published at all
// ---------------------------------------------------------------------------

describe('publishableRefinementHandoff — the §13 gate', () => {
  test('publishes a terminal escalation carrying a recognised reason', () => {
    const publication = publishableRefinementHandoff(697, block());
    expect(publication).toMatchObject({
      issueNumber: 697,
      phase: 'refinement',
      state: 'escalated_human',
      reason: 'agent_unavailable',
      markerLabel: 'status:needs-refinement',
      markerRetained: true,
    });
    // Run metadata is the resolved ROLE configuration; the run id is a run
    // identifier and §16 forbids it, so it is not reachable from the value.
    expect(publication.refiner).toEqual({
      agentId: 'claude',
      provider: 'anthropic',
      model: 'claude-opus',
      effort: 'high',
      invocations: 3,
    });
    expect(publication.critic).toBeNull();
    expect(JSON.stringify(publication)).not.toContain('run-secret-1');
  });

  test.each(['pending', 'eligible', 'drafting', 'critiquing', 'accepted', 'applying', 'activated'])(
    'publishes nothing for the non-handoff state %s',
    (state) => {
      expect(publishableRefinementHandoff(697, block({ state, handoffReason: null }))).toBeNull();
    },
  );

  test('publishes nothing for an escalated block with an unrecognised reason', () => {
    expect(publishableRefinementHandoff(697, block({ handoffReason: 'because' }))).toBeNull();
    expect(publishableRefinementHandoff(697, block({ handoffReason: null }))).toBeNull();
  });

  test('publishes nothing for a completion that carries no refinement block', () => {
    expect(publishableRefinementHandoffFromContext(697, undefined)).toBeNull();
    expect(publishableRefinementHandoffFromContext(697, { prUrl: 'https://x/pull/1' })).toBeNull();
  });

  test('survives a block written without the §8 counters or limits', () => {
    const publication = publishableRefinementHandoff(697, {
      state: 'escalated_human',
      handoffReason: 'no_convergence',
    });
    expect(publication.counters).toEqual({
      rounds: 0,
      malformedAttempts: { refiner: 0, critic: 0 },
      agentFailures: { refiner: 0, critic: 0 },
      staleRestarts: 0,
    });
    expect(publication.limits).toEqual(ISSUE_REFINEMENT_DEFAULT_LIMITS);
    expect(publication.markerLabel).toBe('status:needs-refinement');
  });

  test('a configured limit of 0 is published as 0, not replaced by the default', () => {
    const publication = publishableRefinementHandoff(
      697,
      block({ limits: { ...ISSUE_REFINEMENT_DEFAULT_LIMITS, maxStaleRestartsPerIssue: 0 } }),
    );
    expect(publication.limits.maxStaleRestartsPerIssue).toBe(0);
  });

  test('a handoff raised after the label transition started does not claim the marker is present', () => {
    for (const reason of ['marker_precondition_failed', 'stale_inputs', 'managed_region_modified', 'effect_undeliverable']) {
      expect(publishableRefinementHandoff(697, block({ handoffReason: reason })).markerRetained).toBe(false);
    }
    expect(publishableRefinementHandoff(697, block({ handoffReason: 'no_convergence' })).markerRetained).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The body: bounded, sanitized, literals only
// ---------------------------------------------------------------------------

describe('renderRefinementHandoffComment — §16 fields', () => {
  test('carries the phase, state, reason, counters, and role metadata', () => {
    const body = renderRefinementHandoffComment(publishableRefinementHandoff(697, block()));
    expect(body).toContain(REFINEMENT_HANDOFF_MARKER);
    expect(body).toContain('`refinement`');
    expect(body).toContain('`escalated_human`');
    expect(body).toContain('`agent_unavailable`');
    expect(body).toContain('| Rounds used | 1 / 2 |');
    expect(body).toContain('0 / 1 (cap 2)'); // malformed refiner / critic
    expect(body).toContain('2 / 0 (cap 2)'); // agent process failures
    expect(body).toContain('`claude`');
    expect(body).toContain('model `claude-opus`');
    expect(body).toContain('effort `high`');
    expect(body).toContain('not resolved'); // the critic never ran
    expect(body).toContain(REFINEMENT_HANDOFF_NEXT_ACTIONS.agent_unavailable);
    // §13 item 2, stated for the reader who has to decide what to relabel.
    expect(body).toContain('deliberately left in place');
    expect(body).toContain('admin task cancel');
    // §16: never a run id, never raw output, never an artifact path.
    expect(body).not.toContain('run-secret-1');
    expect(body).not.toContain('.n8n-artifacts');
  });

  test('every handoff reason renders through the same generic path with its own next action', () => {
    const seen = new Set();
    for (const reason of REFINEMENT_HANDOFF_REASONS) {
      const body = renderRefinementHandoffComment(publishableRefinementHandoff(697, block({ handoffReason: reason })));
      expect(body).toContain(`| Handoff reason | \`${reason}\` |`);
      expect(body).toContain(REFINEMENT_HANDOFF_NEXT_ACTIONS[reason]);
      expect(body.length).toBeLessThanOrEqual(MAX_HANDOFF_COMMENT_CHARS);
      seen.add(REFINEMENT_HANDOFF_NEXT_ACTIONS[reason]);
    }
    // A shared "see the docs" sentence for every reason would make the comment
    // useless exactly when it matters, so each reason names its own next step.
    expect(seen.size).toBe(REFINEMENT_HANDOFF_REASONS.length);
  });

  test('a post-step-5 handoff warns that the marker may already be gone', () => {
    const body = renderRefinementHandoffComment(
      publishableRefinementHandoff(697, block({ handoffReason: 'marker_precondition_failed' })),
    );
    expect(body).toContain('may no longer be on the Issue');
    expect(body).not.toContain('deliberately left in place');
  });

  test('bounds a pathological configured literal instead of publishing it whole', () => {
    const body = renderRefinementHandoffComment(
      publishableRefinementHandoff(
        697,
        block({
          execution: {
            runId: 'r',
            refiner: {
              agentId: 'claude',
              provider: 'anthropic',
              model: 'm'.repeat(5000),
              modelSource: 's',
              effort: null,
              effortSource: 's',
              invocations: 1,
              totalDurationMs: 1,
            },
            critic: null,
          },
        }),
      ),
    );
    expect(body).not.toContain('m'.repeat(200));
    expect(body.length).toBeLessThanOrEqual(MAX_HANDOFF_COMMENT_CHARS);
    // A newline or a pipe in a cell would break the table it is rendered into.
    expect(body.split('\n').filter((l) => l.startsWith('| Refiner |'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The effects: two rows, in the outbox, retry-safe
// ---------------------------------------------------------------------------

describe('enqueueRefinementHandoffEffects', () => {
  test('a terminal agent_unavailable handoff enqueues the ready-for-human label and one comment', async () => {
    await enqueueHandoff({ refinement: block() });

    const rows = await pending();
    expect(rows).toHaveLength(2);
    const [label, comment] = rows;
    expect(label.topic).toBe('gh:label:add');
    expect(label.payload).toMatchObject({
      owner: 'm2dw',
      repo: 'some-repo',
      issueNumber: 697,
      label: 'ai:ready-for-human',
    });
    expect(comment.topic).toBe('gh:comment');
    expect(comment.payload.issueNumber).toBe(697);
    expect(comment.payload.body).toContain('`agent_unavailable`');

    // §13 item 2: the marker stays, and no executable status is added, so the
    // Issue cannot drift into implementation while a human is deciding. The
    // comment BODY names `status:needs-implementation` as the operator's manual
    // next step, so the assertion is over the label EFFECTS, not the payloads.
    expect(rows.map((r) => r.topic)).not.toContain('gh:label:remove');
    expect(rows.filter((r) => r.topic.startsWith('gh:label')).map((r) => r.payload.label)).toEqual([
      'ai:ready-for-human',
    ]);
  });

  test('every other terminal reason uses the same generic publication path', async () => {
    await enqueueHandoff({ refinement: block({ handoffReason: 'no_independent_critic' }) });
    const rows = await pending();
    expect(rows.map((r) => r.topic).sort()).toEqual(['gh:comment', 'gh:label:add']);
    expect(rows.find((r) => r.topic === 'gh:comment').payload.body).toContain('`no_independent_critic`');
  });

  test('a duplicate phase retry re-derives the same keys and publishes no second comment', async () => {
    await enqueueHandoff({ refinement: block() });
    await enqueueHandoff({ refinement: block({ updatedAt: '2026-08-18T11:22:33.000Z' }) });

    const rows = await pending();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    expect(rows.find((r) => r.topic === 'gh:comment').idempotencyKey).toBe(
      refinementHandoffIdempotencyKey({
        sessionId: 'addon-dev',
        issueNumber: 697,
        reason: 'agent_unavailable',
        effect: 'comment',
      }),
    );
    // Run-independent by construction: nothing in either key names a run.
    expect(rows.every((r) => !r.idempotencyKey.includes('run-'))).toBe(true);
  });

  test('a later handoff stopping for a DIFFERENT reason is still published', async () => {
    await enqueueHandoff({ refinement: block() });
    await enqueueHandoff({ refinement: block({ handoffReason: 'no_convergence' }) });
    expect(await pending()).toHaveLength(4);
  });

  test('publishes nothing for a non-terminal completion', async () => {
    await enqueueHandoff({ refinement: block({ state: 'accepted', handoffReason: null }) });
    await enqueueHandoff({ refinement: block({ state: 'activated', handoffReason: null }) });
    await enqueueHandoff({});
    expect(await pending()).toHaveLength(0);
  });

  test('a session with no ready-for-human label still publishes the comment', async () => {
    await enqueueHandoff({ refinement: block() }, { ...SESSION, labels: { active: 'ai:active' } });
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('gh:comment');
  });

  test('redacts a local path that reached a published literal', async () => {
    await enqueueHandoff({ refinement: block({ markerLabel: '/tmp/some-repo/status:needs-refinement' }) });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');
    expect(comment.payload.body).not.toContain('/tmp/some-repo');
    expect(comment.payload.body).toContain('<path>');
  });

  test('routes to the configured work-item provider rather than a GitHub-only row', async () => {
    await enqueueHandoff({ refinement: block() }, {
      ...SESSION,
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { baseUrl: 'https://git.example', owner: 'private', repo: 'work' },
      },
    });
    const rows = await pending();
    expect(rows.map((r) => r.topic).sort()).toEqual(['workitem:comment', 'workitem:transition']);
    expect(rows.every((r) => r.payload.owner === 'private' && r.payload.repo === 'work')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Operator visibility of a failed publication
// ---------------------------------------------------------------------------

describe('admin outbox list — handoff publication attempts', () => {
  test('a failed comment dispatch is visible as delayed, then dead, instead of silently omitted', async () => {
    await enqueueHandoff({ refinement: block() });
    const rows = await pending();
    const commentId = rows.find((r) => r.topic === 'gh:comment').id;

    const store = new SqliteOutboxStore(dbPath);
    try {
      // `asOf` is pinned an hour ahead instead of defaulting to the wall clock:
      // `markFailed` schedules the first retry only OUTBOX_BASE_RETRY_DELAY_MS
      // (one minute) out, and the `outbox list` subprocess below re-categorizes
      // the row against ITS own clock. Under a loaded parallel run a spawn can
      // outlive that minute, and the row would then read `pending` again for a
      // reason that has nothing to do with what this test asserts. The backoff
      // is derived from `asOf`, so pinning it keeps the row delayed for the
      // whole test however slow the spawn is — the same reason the dead-letter
      // loop below passes an explicit timestamp.
      await store.markFailed(
        commentId,
        'gh: 502 Bad Gateway',
        new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      );
    } finally {
      store.close();
    }

    const delayed = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI, 'outbox', 'list', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json'],
        { encoding: 'utf8' },
      ).trim(),
    );
    expect(delayed.counts).toMatchObject({ delayed: 1, pending: 1 });
    expect(delayed.entries.find((e) => e.id === commentId).status).toBe('delayed');

    const dead = new SqliteOutboxStore(dbPath);
    try {
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
        await dead.markFailed(commentId, `boom-${i}`, '2026-08-18T12:00:00.000Z');
      }
    } finally {
      dead.close();
    }

    const after = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI, 'outbox', 'list', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json'],
        { encoding: 'utf8' },
      ).trim(),
    );
    // §13: the handoff stands on its local record; what a dead comment must not
    // do is disappear — an operator can still see it, and retry it, from here.
    expect(after.entries.find((e) => e.id === commentId).status).toBe('dead');

    execFileSync(
      process.execPath,
      [CLI, 'outbox', 'retry', '--id', String(commentId), '--session-id', 'addon-dev',
        '--sessions-path', sessionsPath, '--db-path', dbPath, '--yes'],
      { encoding: 'utf8' },
    );
    const recovered = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI, 'outbox', 'list', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json'],
        { encoding: 'utf8' },
      ).trim(),
    );
    expect(recovered.entries.find((e) => e.id === commentId).status).toBe('pending');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Malformed persisted role metadata
//
// The §15 execution record is TYPED but READ BACK from persisted task context,
// and `readRefinementContextBlock` accepts any block carrying a recognised
// state. A publication is built INSIDE the completion, before the transition
// commits, so a renderer that throws on a half-written record does not merely
// lose the comment — it abandons the whole handoff and leaves the task running.
// ---------------------------------------------------------------------------

describe('publishableRefinementHandoff — malformed role records', () => {
  function withRoles(refiner, critic = null) {
    return block({ execution: { runId: 'run-secret-1', refiner, critic } });
  }

  test('an execution record with an empty role object publishes as "not resolved"', () => {
    const publication = publishableRefinementHandoff(697, withRoles({}));
    expect(publication.refiner).toBeNull();
    const body = renderRefinementHandoffComment(publication);
    expect(body).toContain('| Refiner | not resolved |');
    expect(body).toContain('`agent_unavailable`');
  });

  test('a role whose literals are not strings still renders, never throws', () => {
    const publication = publishableRefinementHandoff(
      697,
      withRoles({ agentId: 'claude', provider: 42, model: { name: 'x' }, effort: [], invocations: 'many' }),
    );
    expect(publication.refiner).toEqual({
      agentId: 'claude',
      // Named honestly rather than invented: the block never recorded one.
      provider: 'unknown',
      model: null,
      effort: null,
      invocations: 0,
    });
    const body = renderRefinementHandoffComment(publication);
    expect(body).toContain('provider `unknown`');
    expect(body).toContain('0 invocation(s)');
  });

  test('a role naming no agent publishes as unresolved rather than half-rendered', () => {
    const publication = publishableRefinementHandoff(697, withRoles({ provider: 'anthropic', invocations: 2 }));
    expect(publication.refiner).toBeNull();
    expect(renderRefinementHandoffComment(publication)).not.toContain('anthropic');
  });

  test('a whitespace-only literal is not published as a resolved value', () => {
    const publication = publishableRefinementHandoff(
      697,
      withRoles({ agentId: '  ', provider: 'anthropic' }, { agentId: 'codex', provider: '   ', model: '  ' }),
    );
    expect(publication.refiner).toBeNull();
    expect(publication.critic).toEqual({
      agentId: 'codex',
      provider: 'unknown',
      model: null,
      effort: null,
      invocations: 0,
    });
  });

  test('a terminal handoff whose whole execution record is malformed still enqueues both effects', async () => {
    await enqueueHandoff({ refinement: block({ execution: { refiner: 7, critic: 'codex' } }) });
    const rows = await pending();
    expect(rows.map((r) => r.topic).sort()).toEqual(['gh:comment', 'gh:label:add']);
  });
});

// ---------------------------------------------------------------------------
// Delivery-side idempotency (§16 "never two")
//
// The outbox key stops a second ROW. It cannot stop a second COMMENT: a
// dispatcher that posts and then loses its claim before `markSent` leaves the
// same pending row behind, and the retry would publish a duplicate handoff.
// ---------------------------------------------------------------------------

describe('handoff comment — delivery-side marker', () => {
  const NO_LABEL_SESSION = { ...SESSION, labels: { active: 'ai:active' } };

  function commentKey(reason = 'agent_unavailable', issueNumber = 697) {
    return refinementHandoffIdempotencyKey({ sessionId: 'addon-dev', issueNumber, reason, effect: 'comment' });
  }

  /**
   * A `gh` fake that answers the comment-history GET from `comments` and records
   * every POST, so a test can assert on what was (not) published.
   */
  function markerRunner({ pages = [[]], listFails = false } = {}) {
    const posts = [];
    const gets = [];
    let page = 0;
    return {
      posts,
      gets,
      run(args) {
        const method = args[args.indexOf('--method') + 1];
        if (method === 'GET') {
          gets.push(args);
          if (listFails) return { exitCode: 1, stdout: '', stderr: 'gh: 502 Bad Gateway' };
          const body = JSON.stringify((pages[page] ?? []).map((b) => ({ body: b })));
          page++;
          return { exitCode: 0, stdout: body, stderr: '' };
        }
        posts.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
  }

  test('the enqueued comment carries a marker derived from its own idempotency key', async () => {
    await enqueueHandoff({ refinement: block() }, NO_LABEL_SESSION);
    const [comment] = await pending();
    const marker = refinementHandoffCommentMarker(commentKey());
    expect(comment.payload.dedupeMarker).toBe(marker);
    // The marker has to be IN the body, or the delivery check can never find it.
    expect(comment.payload.body.split('\n')[0]).toBe(marker);
    // §16: the key names the session, so it is hashed rather than published.
    expect(comment.payload.body).not.toContain('addon-dev');
  });

  test('a handoff stopping for a different reason carries a different marker', () => {
    expect(refinementHandoffCommentMarker(commentKey('no_convergence'))).not.toBe(
      refinementHandoffCommentMarker(commentKey('agent_unavailable')),
    );
  });

  test('a comment already carrying the marker is treated as delivered, not posted again', async () => {
    await enqueueHandoff({ refinement: block() }, NO_LABEL_SESSION);
    const marker = refinementHandoffCommentMarker(commentKey());
    const runner = markerRunner({ pages: [[`${marker}\nposted by the attempt that crashed`]] });

    const store = new SqliteOutboxStore(dbPath);
    let result;
    try {
      result = await dispatchOutbox(store, runner, { cwd: tmpDir });
    } finally {
      store.close();
    }

    expect(runner.posts).toHaveLength(0);
    // Settled, not stuck: the row is sent, so it stops occupying the outbox.
    expect(result.dispatched).toBe(1);
    expect(await pending()).toHaveLength(0);
  });

  test('an unmarked history posts exactly one comment', async () => {
    await enqueueHandoff({ refinement: block() }, NO_LABEL_SESSION);
    const runner = markerRunner({ pages: [['an unrelated comment']] });

    const store = new SqliteOutboxStore(dbPath);
    try {
      await dispatchOutbox(store, runner, { cwd: tmpDir });
    } finally {
      store.close();
    }

    expect(runner.posts).toHaveLength(1);
    expect(runner.posts[0]).toContain('POST');
  });

  test('the scan reaches a marker beyond the first page', async () => {
    await enqueueHandoff({ refinement: block() }, NO_LABEL_SESSION);
    const marker = refinementHandoffCommentMarker(commentKey());
    // A full page proves nothing about what follows it; stopping there is how a
    // busy Issue gets a second handoff comment.
    const runner = markerRunner({ pages: [new Array(100).fill('chatter'), [marker]] });

    const store = new SqliteOutboxStore(dbPath);
    try {
      await dispatchOutbox(store, runner, { cwd: tmpDir });
    } finally {
      store.close();
    }

    expect(runner.posts).toHaveLength(0);
  });

  test('a comment history that cannot be read leaves the row pending instead of duplicating', async () => {
    await enqueueHandoff({ refinement: block() }, NO_LABEL_SESSION);
    const runner = markerRunner({ listFails: true });

    const store = new SqliteOutboxStore(dbPath);
    let result;
    try {
      result = await dispatchOutbox(store, runner, { cwd: tmpDir });
    } finally {
      store.close();
    }

    expect(runner.posts).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toContain('list comments');
    expect(await pending()).toHaveLength(1);
  });

  test('the marker survives the rewrite to a non-GitHub work-item provider', async () => {
    await enqueueHandoff({ refinement: block() }, {
      ...NO_LABEL_SESSION,
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { baseUrl: 'https://git.example', owner: 'private', repo: 'work' },
      },
    });
    const [comment] = await pending();
    expect(comment.topic).toBe('workitem:comment');
    expect(comment.payload.dedupeMarker).toBe(refinementHandoffCommentMarker(commentKey()));
  });

  /**
   * A store whose claim operations are observable, and optionally lost.
   *
   * `renewClaim` is delegated through a Proxy rather than a subclass because the
   * SQLite store keeps its handle in a private field: a plain prototype clone
   * would break the moment a delegated method touched it.
   */
  function claimProxy(store, { log, lost = false } = {}) {
    return new Proxy(store, {
      get(target, prop) {
        const value = target[prop];
        if (prop === 'renewClaim') {
          return async (...args) => {
            log?.push('renew');
            return lost ? undefined : await value.bind(target)(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  test('a claim lost during the history read stops the attempt before it posts', async () => {
    await enqueueHandoff({ refinement: block() }, NO_LABEL_SESSION);
    const runner = markerRunner({ pages: [['unrelated chatter']] });

    const store = new SqliteOutboxStore(dbPath);
    let result;
    try {
      // `gh` runs under `spawnSync`, which blocks the event loop for the whole
      // call — so the renewal timer cannot fire while the history read is in
      // flight, and a lease can expire mid-read no matter how short the renew
      // interval is. `renewClaim`'s CAS is what reports that the row has since
      // been reclaimed, and it fails here exactly as it would then.
      result = await dispatchOutbox(claimProxy(store, { lost: true }), runner, { cwd: tmpDir });
    } finally {
      store.close();
    }

    // The read happened; the POST did not. Two dispatchers each reading the same
    // absent history is precisely how a comment §16 caps at one becomes two.
    expect(runner.gets).toHaveLength(1);
    expect(runner.posts).toHaveLength(0);
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toContain('claim lost');
    // Not resolved either: whoever owns the row now reports its outcome, and
    // this row stays visible until someone does.
    expect(await pending()).toHaveLength(1);
  });

  test('a marked comment re-asserts its claim between the read and the POST', async () => {
    await enqueueHandoff({ refinement: block() }, NO_LABEL_SESSION);
    const log = [];
    const runner = {
      run(args) {
        const method = args[args.indexOf('--method') + 1];
        if (method === 'GET') {
          log.push('read');
          return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        log.push('post');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const store = new SqliteOutboxStore(dbPath);
    try {
      await dispatchOutbox(claimProxy(store, { log }), runner, { cwd: tmpDir });
    } finally {
      store.close();
    }

    // The order is the whole point: renewing before the read would prove
    // ownership at a moment the read then invalidates.
    expect(log).toEqual(['read', 'renew', 'post']);
  });

  test('an unmarked comment row posts without re-asserting its claim', async () => {
    const log = [];
    const store = new SqliteOutboxStore(dbPath);
    try {
      await store.enqueue({
        idempotencyKey: 'plain',
        topic: 'gh:comment',
        payload: { topic: 'gh:comment', owner: 'm2dw', repo: 'some-repo', issueNumber: 697, body: 'hello' },
      });
      const runner = markerRunner();
      await dispatchOutbox(claimProxy(store, { log }), runner, { cwd: tmpDir });
      expect(runner.posts).toHaveLength(1);
      // Nothing caps this comment at one, so it pays for neither the history
      // read nor the extra claim write.
      expect(log).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('an ordinary comment row without a marker is posted without a history read', async () => {
    const store = new SqliteOutboxStore(dbPath);
    try {
      await store.enqueue({
        idempotencyKey: 'plain',
        topic: 'gh:comment',
        payload: { topic: 'gh:comment', owner: 'm2dw', repo: 'some-repo', issueNumber: 697, body: 'hello' },
      });
      const runner = markerRunner();
      await dispatchOutbox(store, runner, { cwd: tmpDir });
      expect(runner.posts).toHaveLength(1);
      // No marker, no precondition: a status comment nobody caps at one must
      // not pay for a full comment-history read on every dispatch.
      expect(runner.gets).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// §12 row 46 — the handoff comment that never lands
//
// §13 lets the handoff stand without its comment and forbids a replacement. It
// does not let the fact go unrecorded: the Issue shows nothing, so the task
// itself has to say that the notice was lost.
// ---------------------------------------------------------------------------

describe('recordRefinementHandoffCommentUndeliverable — §12 row 46', () => {
  async function withTask(fn, issueNumber = 697) {
    const store = new SqliteTaskStore(dbPath);
    try {
      await store.enqueueTask({
        sessionId: 'addon-dev',
        issueNumber,
        phase: 'refinement',
        context: { title: 'A refined Issue', refinement: block() },
      });
      return await fn(store);
    } finally {
      store.close();
    }
  }

  function undeliverable(events) {
    return events.filter((e) => e.type === REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT);
  }

  test('a dead-lettered handoff comment records the event on the task, once', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');

    await withTask(async (store) => {
      expect(await recordRefinementHandoffCommentUndeliverable(store, comment, 'dead_lettered', NOW)).toBe(true);
      // A later `outbox retry` that dead-letters the same row again records
      // nothing new: the fact has not changed.
      expect(await recordRefinementHandoffCommentUndeliverable(store, comment, 'dead_lettered', NOW)).toBe(false);

      const events = undeliverable(await store.listEvents({ sessionId: 'addon-dev', issueNumber: 697 }));
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({
        issueNumber: 697,
        refinementState: 'escalated_human',
        handoffReason: 'agent_unavailable',
        disposition: 'dead_lettered',
      });
      // §15: literals and counters only — never the provider error text, which
      // may name a host or a path and already lives on the outbox row.
      expect(JSON.stringify(events[0].data)).not.toContain('Bad Gateway');
    });
  });

  test('an operator cancel records the same fact with its own disposition', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');

    await withTask(async (store) => {
      await recordRefinementHandoffCommentUndeliverable(store, comment, 'cancelled', NOW);
      const events = undeliverable(await store.listEvents({ sessionId: 'addon-dev', issueNumber: 697 }));
      expect(events[0].data.disposition).toBe('cancelled');
    });
  });

  test('the label effect and unrelated rows record nothing', async () => {
    await enqueueHandoff({ refinement: block() });
    const rows = await pending();
    const label = rows.find((r) => r.topic === 'gh:label:add');

    await withTask(async (store) => {
      expect(await recordRefinementHandoffCommentUndeliverable(store, label, 'dead_lettered', NOW)).toBe(false);
      expect(
        await recordRefinementHandoffCommentUndeliverable(
          store, { idempotencyKey: 'addon-dev:697:run-1:gh:comment:review:success' }, 'dead_lettered', NOW,
        ),
      ).toBe(false);
      expect(undeliverable(await store.listEvents({ sessionId: 'addon-dev', issueNumber: 697 }))).toHaveLength(0);
    });
  });

  test('a handoff whose task row is gone records nothing rather than inventing one', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');
    const store = new SqliteTaskStore(dbPath);
    try {
      expect(await recordRefinementHandoffCommentUndeliverable(store, comment, 'dead_lettered', NOW)).toBe(false);
    } finally {
      store.close();
    }
  });

  test('a session id containing the key separator still resolves to its own task', async () => {
    const session = { ...SESSION, sessionId: 'team:addon:dev' };
    await enqueueHandoff({ refinement: block() }, session, 42);
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');
    expect(refinementHandoffEffectFromKey(comment.idempotencyKey)).toEqual({
      sessionId: 'team:addon:dev',
      issueNumber: 42,
      reason: 'agent_unavailable',
      effect: 'comment',
    });
  });

  test('the dispatcher records the event when the row exhausts its retry budget', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');

    const taskStore = new SqliteTaskStore(dbPath);
    await taskStore.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 697,
      phase: 'refinement',
      context: { title: 'A refined Issue', refinement: block() },
    });
    taskStore.close();

    // One attempt short of the cap, failed long ago so the row is due again.
    const store = new SqliteOutboxStore(dbPath);
    try {
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS - 1; i++) {
        await store.markFailed(comment.id, `boom-${i}`, '2020-01-01T00:00:00.000Z');
      }
    } finally {
      store.close();
    }

    await captureStdout(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        { run: () => ({ exitCode: 1, stdout: '', stderr: 'gh: 503 service unavailable' }) },
      );
    });

    const after = new SqliteTaskStore(dbPath);
    try {
      const events = (await after.listEvents({ sessionId: 'addon-dev', issueNumber: 697 })).filter(
        (e) => e.type === REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT,
      );
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ disposition: 'dead_lettered', handoffReason: 'agent_unavailable' });
    } finally {
      after.close();
    }
  }, 30_000);

  /** Every row-46 event on issue 697's task, read through a fresh store. */
  async function recordedEvents(issueNumber = 697) {
    const store = new SqliteTaskStore(dbPath);
    try {
      return undeliverable(await store.listEvents({ sessionId: 'addon-dev', issueNumber }));
    } finally {
      store.close();
    }
  }

  /** The task the handoff was raised from, so there is something to append to. */
  async function seedTask(issueNumber = 697) {
    const store = new SqliteTaskStore(dbPath);
    try {
      await store.enqueueTask({
        sessionId: 'addon-dev',
        issueNumber,
        phase: 'refinement',
        context: { title: 'A refined Issue', refinement: block() },
      });
    } finally {
      store.close();
    }
  }

  async function drain() {
    await captureStdout(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        { run: () => ({ exitCode: 0, stdout: '[]', stderr: '' }) },
      );
    });
  }

  test('a dead letter whose audit write never landed is repaired by a later run', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');
    await seedTask();

    // The dead letter committed; the audit append that should have followed it
    // did not — a busy database, a crash between the two writes. The row is
    // never selected for dispatch again, so its one-shot hook cannot fire a
    // second time, and without a repair the fact would be lost for good.
    const store = new SqliteOutboxStore(dbPath);
    try {
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
        await store.markFailed(comment.id, `boom-${i}`, '2020-01-01T00:00:00.000Z');
      }
      expect((await store.getById(comment.id)).deadLetterAt).toBeDefined();
    } finally {
      store.close();
    }
    expect(await recordedEvents()).toHaveLength(0);

    await drain();

    const events = await recordedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ disposition: 'dead_lettered', handoffReason: 'agent_unavailable' });

    // And the sweep is idempotent: a repaired row records nothing further.
    await drain();
    expect(await recordedEvents()).toHaveLength(1);
  }, 30_000);

  test('a repair sweep leaves rows that are not terminal handoff comments alone', async () => {
    await enqueueHandoff({ refinement: block() });
    const rows = await pending();
    await seedTask();

    const store = new SqliteTaskStore(dbPath);
    try {
      // Nothing here is a dead-lettered handoff comment: the label effect never
      // has a row-46 counterpart, and a comment still awaiting delivery is not
      // undeliverable — recording it would announce a loss that has not
      // happened.
      const result = await repairRefinementHandoffCommentUndeliverable(store, rows, NOW);
      expect(result).toEqual({ recorded: 0, errors: [] });
    } finally {
      store.close();
    }
    expect(await recordedEvents()).toHaveLength(0);
  });

  test('a repair reads the disposition off the row, not off how it was found', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');
    await seedTask();

    const outbox = new SqliteOutboxStore(dbPath);
    let cancelled;
    try {
      await outbox.cancelEntry(comment.id);
      cancelled = await outbox.getById(comment.id);
    } finally {
      outbox.close();
    }

    const store = new SqliteTaskStore(dbPath);
    try {
      // An operator cancel dead-letters the row too, so the sweep sees both
      // shapes; `cancelledAt` is what tells them apart, and an operator reading
      // the event back is owed the difference.
      expect(await repairRefinementHandoffCommentUndeliverable(store, [cancelled], NOW)).toEqual({
        recorded: 1,
        errors: [],
      });
    } finally {
      store.close();
    }
    expect((await recordedEvents())[0].data.disposition).toBe('cancelled');
  });

  test('two repairs racing over one row still record the fact exactly once', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');
    await seedTask();

    const outbox = new SqliteOutboxStore(dbPath);
    let dead;
    try {
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
        await outbox.markFailed(comment.id, `boom-${i}`, '2020-01-01T00:00:00.000Z');
      }
      dead = await outbox.getById(comment.id);
    } finally {
      outbox.close();
    }

    // Two overlapping `dispatch-outbox` runs — or a drain and an `admin outbox
    // cancel` — repairing the same dead letter from separate connections. The
    // recording is a store-level check-and-write, so one of them sees the
    // other's event rather than both observing an empty history (P2 review
    // follow-up to issue #936).
    const storeA = new SqliteTaskStore(dbPath);
    const storeB = new SqliteTaskStore(dbPath);
    try {
      const results = await Promise.all([
        repairRefinementHandoffCommentUndeliverable(storeA, [dead], NOW),
        repairRefinementHandoffCommentUndeliverable(storeB, [dead], NOW),
      ]);
      expect(results.map((r) => r.recorded).reduce((a, b) => a + b, 0)).toBe(1);
      expect(results.flatMap((r) => r.errors)).toEqual([]);
    } finally {
      storeA.close();
      storeB.close();
    }

    expect(await recordedEvents()).toHaveLength(1);
  }, 30_000);

  test('re-running admin outbox cancel records the audit event a failed run owed', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');
    await seedTask();

    // The shape of a first run that cancelled the row and then failed to append
    // its event: the row is cancelled, the audit record is missing, and the
    // command is the operator's only handle on it.
    const store = new SqliteOutboxStore(dbPath);
    try {
      expect((await store.cancelEntry(comment.id)).cancelled).toBe(true);
    } finally {
      store.close();
    }

    const out = execFileSync(
      process.execPath,
      [CLI, 'outbox', 'cancel', '--id', String(comment.id), '--session-id', 'addon-dev',
        '--sessions-path', sessionsPath, '--db-path', dbPath, '--yes'],
      { encoding: 'utf8' },
    );

    // The re-run cancels nothing — it repairs. Reporting `already_cancelled` and
    // skipping the record is what left the handoff permanently unaudited.
    const payload = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
    expect(payload).toMatchObject({ ok: true, cancelled: false, reason: 'already_cancelled' });
    const events = await recordedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].data.disposition).toBe('cancelled');
  }, 30_000);

  test('admin outbox cancel records the same fact for the row it retires', async () => {
    await enqueueHandoff({ refinement: block() });
    const comment = (await pending()).find((r) => r.topic === 'gh:comment');

    const taskStore = new SqliteTaskStore(dbPath);
    await taskStore.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 697,
      phase: 'refinement',
      context: { title: 'A refined Issue', refinement: block() },
    });
    taskStore.close();

    execFileSync(
      process.execPath,
      [CLI, 'outbox', 'cancel', '--id', String(comment.id), '--session-id', 'addon-dev',
        '--sessions-path', sessionsPath, '--db-path', dbPath, '--yes'],
      { encoding: 'utf8' },
    );

    const after = new SqliteTaskStore(dbPath);
    try {
      const events = (await after.listEvents({ sessionId: 'addon-dev', issueNumber: 697 })).filter(
        (e) => e.type === REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT,
      );
      expect(events).toHaveLength(1);
      expect(events[0].data.disposition).toBe('cancelled');
    } finally {
      after.close();
    }
  }, 30_000);
});
