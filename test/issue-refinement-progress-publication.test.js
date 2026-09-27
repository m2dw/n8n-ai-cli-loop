/**
 * Issue #976 — publishing the #975 refinement progress milestones as
 * append-only GitHub comments (docs/issue-refinement-contract.md §15/§16).
 *
 * #975 made progress a persisted contract but published none of it: an Issue in
 * refinement showed a human nothing between `status:needs-refinement` and
 * whatever terminal notice §13 eventually posted. These tests pin the four
 * things that closes:
 *
 *  - the PROJECTION — one concise comment per milestone kind, rendering only
 *    fields the milestone actually carries, and refusing (never guessing) an
 *    unknown schema version, an unknown kind, or a deadline-less retry;
 *  - the SAFETY boundary — no fingerprints, no raw output, no absolute paths,
 *    no artifact references, no `undefined`/`null` prose, bounded length;
 *  - IDEMPOTENCY — the dedupe identity is the deterministic `milestoneId` plus
 *    the fixed projection/version, so a replayed transition, a restart, and an
 *    outbox retry publish no second comment;
 *  - DELIVERY — the comment rows commit in the same transaction as the
 *    milestones, against the real phase runner and a real SQLite store: a lost
 *    claim publishes neither, and a poll publishes nothing at all.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  MAX_PROGRESS_COMMENT_CHARS,
  REFINEMENT_PROGRESS_COMMENT_HEADLINES,
  REFINEMENT_PROGRESS_COMMENT_PROJECTION,
  REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT,
  REFINEMENT_PROGRESS_COMMENT_VERSION,
  publishableRefinementProgressComment,
  refinementProgressCommentIdempotencyKey,
  refinementProgressCommentMarker,
  refinementProgressCommentUnpublishableEvent,
  renderRefinementProgressComment,
} from '../dist/core/issue-refinement-progress-publication.js';
import {
  REFINEMENT_PROGRESS_EVENT_TYPE,
  REFINEMENT_PROGRESS_MILESTONE_KINDS,
  REFINEMENT_PROGRESS_SCHEMA_VERSION,
} from '../dist/core/issue-refinement-progress.js';
import { enqueueRefinementProgressCommentEffects } from '../dist/core/outbox-effects.js';
import { ISSUE_REFINEMENT_DEFAULT_LIMITS } from '../dist/core/issue-refinement.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { runNextPhase } from '../dist/core/phase-runner.js';

const NOW = '2026-08-20T10:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);
const PREDECESSOR_FINGERPRINT = 'b'.repeat(64);

const SESSION = {
  sessionId: 'test-session',
  repoKey: 'test-repo',
  repoRoot: '/tmp/test-repo',
  githubRepo: 'org/repo',
  artifactDir: '.artifacts',
  artifactRoot: '/tmp/test-repo/.artifacts',
  githubOwner: 'org',
  githubName: 'repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: {},
  labels: {
    active: 'ai:active',
    blocked: 'ai:blocked',
    readyForHuman: 'ai:ready-for-human',
    needsReview: 'status:needs-review',
    needsImplementation: 'status:needs-implementation',
  },
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
};

/** A well-formed milestone, exactly as #975 commits one. */
const milestone = (over = {}) => ({
  schemaVersion: REFINEMENT_PROGRESS_SCHEMA_VERSION,
  milestoneId: 'f'.repeat(32),
  kind: 'refiner_completed',
  issueNumber: 99,
  sourceFingerprint: FINGERPRINT,
  predecessorFingerprint: PREDECESSOR_FINGERPRINT,
  state: 'critiquing',
  round: 1,
  role: 'refiner',
  attempt: 1,
  agent: {
    agentId: 'claude',
    provider: 'anthropic',
    model: 'claude-opus-5',
    effort: 'high',
    modelSource: 'default',
    effortSource: 'default',
  },
  durationMs: 4200,
  result: 'high',
  nextAction: 'await_critic',
  humanActionRequired: false,
  occurredAt: NOW,
  ...over,
});

const render = (over = {}) => {
  const projection = publishableRefinementProgressComment(milestone(over));
  expect(projection.publishable).toBe(true);
  return renderRefinementProgressComment(projection.comment);
};

// ---------------------------------------------------------------------------
// The projection: one comment per boundary
// ---------------------------------------------------------------------------

describe('refinement progress comments — the projection', () => {
  test('every #975 milestone kind has its own headline', () => {
    expect(Object.keys(REFINEMENT_PROGRESS_COMMENT_HEADLINES).sort())
      .toEqual([...REFINEMENT_PROGRESS_MILESTONE_KINDS].sort());
    // Distinct wording per kind: a reader scanning the Issue must be able to
    // tell two boundaries apart without reading the table.
    expect(new Set(Object.values(REFINEMENT_PROGRESS_COMMENT_HEADLINES)).size)
      .toBe(REFINEMENT_PROGRESS_MILESTONE_KINDS.length);
  });

  test('renders the started boundary', () => {
    const body = render({ kind: 'started', state: 'drafting', nextAction: 'await_refiner', round: undefined, role: undefined, attempt: undefined, agent: undefined, durationMs: undefined, result: undefined });
    expect(body).toContain('Issue refinement started');
    expect(body).toContain('| Milestone | `started` |');
    expect(body).toContain('| Refinement state | `drafting` |');
    expect(body).toContain('`await_refiner`');
  });

  test('renders a refiner sub-turn with its role, attempt, agent, and duration', () => {
    const body = render();
    expect(body).toContain('Refiner sub-turn completed');
    expect(body).toContain('| Round | 1 |');
    expect(body).toContain('| Role | `refiner` (attempt 1) |');
    expect(body).toContain('| Agent | `claude`, provider `anthropic`, model `claude-opus-5`, effort `high` |');
    expect(body).toContain('| Duration | 4s |');
  });

  test('renders the critic verdict as its structured result', () => {
    const body = render({ kind: 'critic_completed', role: 'critic', result: 'revise', nextAction: 'await_refiner' });
    expect(body).toContain('Critic sub-turn completed');
    expect(body).toContain('| Result | `revise` |');
  });

  test('renders a retry with the exact committed deadline', () => {
    const body = render({
      kind: 'retry_scheduled',
      state: 'drafting',
      result: undefined,
      failureClass: 'usage_quota',
      nextAction: 'await_retry',
      retryNotBefore: '2026-08-20T15:30:00.000Z',
    });
    expect(body).toContain('Refinement retry scheduled');
    expect(body).toContain('| Failure class | `usage_quota` |');
    expect(body).toContain('| Retry not before | `2026-08-20T15:30:00.000Z` (UTC) |');
  });

  test('renders acceptance and activation', () => {
    expect(render({ kind: 'accepted', state: 'accepted', nextAction: 'await_application', role: undefined, attempt: undefined, agent: undefined, durationMs: undefined }))
      .toContain('Refined Issue contract accepted');
    const activated = render({ kind: 'activated', state: 'activated', nextAction: 'await_implementation', round: undefined, role: undefined, attempt: undefined, agent: undefined, durationMs: undefined, result: undefined });
    expect(activated).toContain('implementation activated');
    expect(activated).toContain('`await_implementation`');
  });

  test('a handoff and a failure both say a human has to act', () => {
    const handoff = render({
      kind: 'human_handoff',
      state: 'escalated_human',
      nextAction: 'await_human',
      reason: 'agent_unavailable',
      result: undefined,
      humanActionRequired: true,
    });
    expect(handoff).toContain('needs a human');
    expect(handoff).toContain('| Reason | `agent_unavailable` |');
    expect(handoff).toContain('**Human action required.**');

    const failed = render({
      kind: 'failed',
      state: 'drafting',
      nextAction: 'await_human',
      failureClass: 'phase_failed',
      result: undefined,
      humanActionRequired: true,
    });
    expect(failed).toContain('Refinement failed and needs a human');
    expect(failed).toContain('| Failure class | `phase_failed` |');
    expect(failed).toContain('**Human action required.**');
  });

  test('a non-terminal milestone does not claim human action', () => {
    expect(render()).not.toContain('Human action required');
  });
});

// ---------------------------------------------------------------------------
// Safety: what a comment may never carry
// ---------------------------------------------------------------------------

describe('refinement progress comments — visibility and bounding', () => {
  test('never publishes the source or predecessor fingerprint', () => {
    const body = render();
    expect(body).not.toContain(FINGERPRINT);
    expect(body).not.toContain(PREDECESSOR_FINGERPRINT);
    // Not even a prefix of one: the field has no row at all.
    expect(body).not.toContain('aaaaaaaa');
    expect(body).not.toContain('fingerprint');
  });

  test('omits an absent optional field instead of rendering undefined or null', () => {
    const body = render({
      kind: 'started',
      state: 'drafting',
      nextAction: 'await_refiner',
      round: undefined,
      role: undefined,
      attempt: undefined,
      agent: undefined,
      durationMs: undefined,
      result: undefined,
      reason: undefined,
      failureClass: undefined,
    });
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('null');
    expect(body).not.toContain('| Round |');
    expect(body).not.toContain('| Role |');
    expect(body).not.toContain('| Agent |');
    expect(body).not.toContain('| Duration |');
    expect(body).not.toContain('| Result |');
  });

  test('drops a malformed identifier rather than rendering half a record', () => {
    // #975 sanitizes on the way in; the renderer refuses anything that slipped
    // past — an agent record with no usable id publishes no agent row at all.
    const body = render({ agent: { agentId: '   ', provider: 'anthropic', model: null, effort: null } });
    expect(body).not.toContain('| Agent |');
  });

  test('bounds the rendered body and drops the oversized literals outright', () => {
    const long = 'x'.repeat(4000);
    const body = render({
      state: long,
      result: long,
      agent: { agentId: long, provider: long, model: long, effort: long },
    });
    expect(body.length).toBeLessThanOrEqual(MAX_PROGRESS_COMMENT_CHARS);
    expect(body).not.toContain(long);
    expect(body).not.toContain('xxxxxxxx');
    // The boundary itself still publishes: a pathological literal costs the
    // reader that field, not the comment.
    expect(body).toContain('| Milestone | `refiner_completed` |');
  });

  test('flattens a value that would otherwise break the table', () => {
    const body = render({ state: 'drafting\n| injected | row |' });
    expect(body).not.toContain('| injected | row |');
  });

  // Issue #1201: a backslash run before a pipe must not decide whether that
  // pipe is a cell boundary, whatever its parity.
  test.each([
    ['one backslash before a pipe', 'a\\|b'],
    ['two backslashes before a pipe', 'a\\\\|b'],
    ['three backslashes before a pipe', 'a\\\\\\|b | c'],
    ['a trailing backslash', 'drafting\\'],
    ['a backtick next to a backslash-pipe', 'a`\\|`b'],
    ['a multiline value with a backslash-pipe', 'a\\\n|b\r\n\\| c\rd'],
  ])('%s cannot add a cell or a row', (_name, value) => {
    const body = render({ state: value, result: value, agent: { agentId: value, provider: value, model: value, effort: value } });
    const rows = tableRows(body);
    expect(rows.map((row) => row.cells.length).every((n) => n === 2)).toBe(true);
    expect(rows.map((row) => row.cells[0])).toEqual([
      'Milestone', 'Refinement state', 'Round', 'Role', 'Result', 'Agent', 'Duration', 'Next',
    ]);
    // The state cell still says what the input said: only the escaping was added.
    const state = rows.find((row) => row.cells[0] === 'Refinement state').cells[1];
    expect(unescapeCell(state)).toBe(`\`${value.replace(/\r\n|[\r\n]/g, ' ').replace(/`/g, "'")}\``);
  });

  test('a backslash that does not precede a pipe is displayed as typed', () => {
    // Every literal renders inside a code span, where `\\` would read as two.
    const body = render({ state: 'draft\\ing\\', agent: { agentId: 'a\\b', provider: 'claude', model: null, effort: null } });
    expect(body).toContain('| Refinement state | `draft\\ing\\` |');
    expect(body).toContain('`a\\b`');
  });

  // Issue #1201 review, P2: the cap cuts at a source boundary, so a capped
  // literal is a prefix of the input and never shows more backslashes than it had.
  test.each([
    // 74 + 6 + 2 = 82 escaped chars; the cut at 79 lands inside the doubled run.
    ['three backslashes before a pipe at the cut', 'x'.repeat(74) + '\\'.repeat(3) + '|', 'x'.repeat(74) + '\\'.repeat(3)],
    // 40 + 78 + 2 = 120 escaped chars; only 39 of the run fit, undoubled.
    ['a long run before a pipe at the cut', 'x'.repeat(40) + '\\'.repeat(39) + '|', 'x'.repeat(40) + '\\'.repeat(39)],
    // 76 + 4 = 80 would fit alone; the trailing `y` forces a cut inside the pair.
    ['a whole pair that no longer fits', 'x'.repeat(76) + '\\|y', 'x'.repeat(76) + '\\'],
    // 80 source chars escape to 20 + 50 + 20 = 90; the earlier pipes push the
    // plain run across the cut, and only 9 of it fit.
    ['a plain run at the cut', '|'.repeat(10) + 'x'.repeat(50) + '\\'.repeat(20), '\\|'.repeat(10) + 'x'.repeat(50) + '\\'.repeat(9)],
  ])('%s is cut to a prefix of the input', (_name, value, prefix) => {
    const body = render({ state: value });
    const rows = tableRows(body);
    expect(rows.every((row) => row.cells.length === 2)).toBe(true);
    expect(body).toContain(`| Refinement state | \`${prefix}…\` |`);
  });
});

/**
 * Split each markdown table row the way a parity-aware renderer does: a `\`
 * escapes the next character, and only an unescaped `|` is a boundary. The
 * header and delimiter rows are skipped.
 */
function tableRows(body) {
  return body
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line) && !/^\|\s*Field\s*\|/.test(line))
    .map((line) => {
      const cells = [];
      let current = '';
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '\\' && i + 1 < line.length) {
          current += line[i] + line[i + 1];
          i += 1;
        } else if (line[i] === '|') {
          cells.push(current);
          current = '';
        } else {
          current += line[i];
        }
      }
      cells.push(current);
      return { cells: cells.slice(1, -1).map((c) => c.trim()) };
    });
}

function unescapeCell(value) {
  return value.replace(/\\([\\|])/g, '$1');
}

// ---------------------------------------------------------------------------
// Failing closed
// ---------------------------------------------------------------------------

describe('refinement progress comments — unknown input fails closed', () => {
  test('refuses an unknown schema version with an actionable diagnostic', () => {
    const projection = publishableRefinementProgressComment(
      milestone({ schemaVersion: REFINEMENT_PROGRESS_SCHEMA_VERSION + 1 }),
    );
    expect(projection.publishable).toBe(false);
    expect(projection.refusal.code).toBe('unsupported_schema_version');
    expect(projection.refusal.detail).toContain('admin task-status');
    expect(projection.refusal.milestoneId).toBe('f'.repeat(32));
  });

  test('refuses an unknown milestone kind rather than inventing wording', () => {
    const projection = publishableRefinementProgressComment(milestone({ kind: 'teleported' }));
    expect(projection.publishable).toBe(false);
    expect(projection.refusal.code).toBe('unknown_kind');
  });

  test('refuses a retry milestone with no authoritative deadline', () => {
    for (const retryNotBefore of [undefined, null, '', 'soon', '2026-08-20']) {
      const projection = publishableRefinementProgressComment(
        milestone({ kind: 'retry_scheduled', nextAction: 'await_retry', retryNotBefore }),
      );
      expect(projection.publishable).toBe(false);
      expect(projection.refusal.code).toBe('missing_retry_deadline');
    }
  });

  test('refuses a milestone with nothing to key a row on', () => {
    expect(publishableRefinementProgressComment(milestone({ milestoneId: '' })).refusal.code)
      .toBe('malformed_milestone');
    expect(publishableRefinementProgressComment(milestone({ issueNumber: 0 })).refusal.code)
      .toBe('malformed_milestone');
    expect(publishableRefinementProgressComment(null).refusal.code).toBe('malformed_milestone');
  });

  test('an unrecognised nextAction falls back to the kind default, and still publishes', () => {
    // The least load-bearing line in the note: a value the renderer does not
    // know must not cost the reader the boundary itself.
    const body = render({ kind: 'accepted', nextAction: 'await_teleport' });
    expect(body).toContain('| Milestone | `accepted` |');
    expect(body).toContain('`await_application`');
  });
});

// ---------------------------------------------------------------------------
// Dedupe identity
// ---------------------------------------------------------------------------

describe('refinement progress comments — the dedupe identity', () => {
  const key = (over = {}) =>
    refinementProgressCommentIdempotencyKey({
      sessionId: 'test-session',
      issueNumber: 99,
      milestoneId: 'f'.repeat(32),
      ...over,
    });

  test('is the milestone id plus the fixed projection and version', () => {
    expect(key()).toBe(
      `test-session:99:${REFINEMENT_PROGRESS_COMMENT_PROJECTION}:v${REFINEMENT_PROGRESS_COMMENT_VERSION}:${'f'.repeat(32)}`,
    );
  });

  test('carries no run id, timestamp, or wording', () => {
    const k = key();
    expect(k).not.toContain('run-');
    expect(k).not.toContain('2026-');
    expect(k).not.toContain('completed');
  });

  test('separates milestones, Issues, and sessions', () => {
    expect(key({ milestoneId: 'e'.repeat(32) })).not.toBe(key());
    expect(key({ issueNumber: 100 })).not.toBe(key());
    expect(key({ sessionId: 'other' })).not.toBe(key());
  });

  test('the delivery marker is derived from the key and hides the session id', () => {
    const marker = refinementProgressCommentMarker(key());
    expect(marker).toMatch(/^<!-- ai-refinement:progress key=[0-9a-f]{16} -->$/);
    expect(marker).not.toContain('test-session');
    expect(refinementProgressCommentMarker(key({ milestoneId: 'e'.repeat(32) }))).not.toBe(marker);
    // The marker opens the body, so a dispatcher can recognise its own delivery.
    const projection = publishableRefinementProgressComment(milestone());
    expect(renderRefinementProgressComment(projection.comment, marker).startsWith(marker)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The effect builder
// ---------------------------------------------------------------------------

describe('enqueueRefinementProgressCommentEffects', () => {
  let tmpDir;
  let dbPath;

  const enqueue = async (milestones, session = SESSION, issueNumber = 99) => {
    const store = new SqliteOutboxStore(dbPath);
    try {
      return await enqueueRefinementProgressCommentEffects(
        store, session, { issueNumber }, milestones, NOW,
      );
    } finally {
      store.close();
    }
  };

  const pending = async () => {
    const store = new SqliteOutboxStore(dbPath);
    try {
      return await store.listUnsent();
    } finally {
      store.close();
    }
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'refinement-progress-pub-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('enqueues one comment row per milestone, in order', async () => {
    const refusals = await enqueue([
      milestone({ kind: 'started', milestoneId: '1'.repeat(32) }),
      milestone({ kind: 'refiner_completed', milestoneId: '2'.repeat(32) }),
    ]);
    expect(refusals).toEqual([]);
    const rows = await pending();
    expect(rows.map((r) => r.topic)).toEqual(['gh:comment', 'gh:comment']);
    expect(rows[0].payload.body).toContain('| Milestone | `started` |');
    expect(rows[1].payload.body).toContain('| Milestone | `refiner_completed` |');
    expect(rows[0].payload.issueNumber).toBe(99);
    expect(rows[0].payload.owner).toBe('org');
    expect(rows[0].payload.repo).toBe('repo');
  });

  test('carries the delivery marker in the body and on the payload', async () => {
    await enqueue([milestone()]);
    const [row] = await pending();
    const marker = refinementProgressCommentMarker(row.idempotencyKey);
    expect(row.payload.dedupeMarker).toBe(marker);
    expect(row.payload.body.startsWith(marker)).toBe(true);
  });

  test('a re-derived delivery enqueues no second row', async () => {
    await enqueue([milestone()]);
    await enqueue([milestone({ occurredAt: '2026-08-20T23:59:00.000Z' })]);
    expect(await pending()).toHaveLength(1);
  });

  test('publishes nothing when there are no milestones', async () => {
    expect(await enqueue([])).toEqual([]);
    expect(await enqueue(undefined)).toEqual([]);
    expect(await pending()).toHaveLength(0);
  });

  test('an unrenderable milestone enqueues nothing and returns the refusal', async () => {
    const refusals = await enqueue([
      milestone({ kind: 'started', milestoneId: '1'.repeat(32) }),
      milestone({ kind: 'unheard_of', milestoneId: '2'.repeat(32) }),
      milestone({ schemaVersion: 99, milestoneId: '3'.repeat(32) }),
    ]);
    expect(refusals.map((r) => r.code)).toEqual(['unknown_kind', 'unsupported_schema_version']);
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.body).toContain('`started`');
  });

  test('refuses a milestone addressed at a different Issue than the task', async () => {
    const refusals = await enqueue([milestone({ issueNumber: 1234 })]);
    expect(refusals.map((r) => r.code)).toEqual(['malformed_milestone']);
    expect(await pending()).toHaveLength(0);
  });

  test('redacts a local path that reached a published literal', async () => {
    await enqueue([milestone({ state: '/tmp/test-repo/drafting' })]);
    const [row] = await pending();
    expect(row.payload.body).not.toContain('/tmp/test-repo');
    expect(row.payload.body).toContain('<path>');
  });

  test('routes to the configured work-item provider rather than a GitHub-only row', async () => {
    await enqueue([milestone()], {
      ...SESSION,
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'token' },
        gitea: { baseUrl: 'https://git.example', owner: 'private', repo: 'mirror' },
      },
    });
    const [row] = await pending();
    expect(row.topic).toBe('workitem:comment');
    expect(row.payload.owner).toBe('private');
    expect(row.payload.dedupeMarker).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Delivery: the real runner, the real store, one transaction
// ---------------------------------------------------------------------------

const KEY = { sessionId: 'test-session', issueNumber: 99 };
const REQUEST = {
  sessionId: 'test-session',
  workerId: 'w1',
  runId: 'run-refine-1',
  supportedPhases: ['refinement'],
  now: NOW,
};

const block = (over = {}) => ({
  state: 'drafting',
  sourceFingerprint: FINGERPRINT,
  predecessorFingerprint: PREDECESSOR_FINGERPRINT,
  limits: { ...ISSUE_REFINEMENT_DEFAULT_LIMITS },
  ...over,
});

const ctx = (over = {}) => ({ title: 'Downstream Issue', refinement: block(over) });

const evt = (type, data = {}) => ({
  type,
  data: {
    issueNumber: 99,
    runId: 'run-refine-1',
    state: 'drafting',
    predecessorFingerprint: PREDECESSOR_FINGERPRINT,
    at: '2026-08-20T09:59:00.000Z',
    ...data,
  },
});

const REFINER_AGENT = {
  agentId: 'claude',
  provider: 'anthropic',
  model: 'opus',
  modelSource: 'default',
  effort: 'high',
  effortSource: 'default',
};

const snapshotCaptured = () =>
  evt('refinement.snapshot.captured', { state: 'drafting', predecessorCount: 1 });
const draftRecorded = () =>
  evt('refinement.draft.recorded', {
    state: 'critiquing', round: 1, role: 'refiner', ...REFINER_AGENT,
    confidence: 'high', attempt: 1, durationMs: 4200,
  });
const critiquePassed = () =>
  evt('refinement.critique.passed', {
    state: 'accepted', round: 1, refinerConfidence: 'high', criticConfidence: 'medium',
    role: 'critic', agentId: 'codex', provider: 'openai', model: 'gpt-5',
    attempt: 1, durationMs: 3100,
  });
const activatedEvent = () =>
  evt('refinement.activated', { state: 'activated', parked: { status: 'blocked', phase: 'implementation' } });
const agentFailed = () =>
  evt('refinement.agent.failed', {
    state: 'drafting', role: 'refiner', ...REFINER_AGENT,
    failureKind: 'usage_quota', retryable: true, round: 1, attempt: 1, durationMs: 600,
  });

describe('refinement progress comments — committed with the transition', () => {
  let tmpDir;
  let taskStore;
  let outboxStore;

  const enqueueTask = async (context) =>
    taskStore.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 99,
      phase: 'refinement',
      now: NOW,
      context,
    });

  const run = async (handler) =>
    runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { refinement: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

  const comments = async () =>
    (await outboxStore.listUnsent()).filter((r) => r.topic === 'gh:comment');

  const milestoneIds = async () =>
    (await taskStore.listEvents(KEY))
      .filter((e) => e.type === REFINEMENT_PROGRESS_EVENT_TYPE)
      .map((e) => e.data.milestoneId);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'refinement-progress-delivery-'));
    const dbPath = join(tmpDir, 'test.db');
    taskStore = new SqliteTaskStore(dbPath);
    outboxStore = new SqliteOutboxStore(dbPath);
  });

  afterEach(() => {
    taskStore.close();
    outboxStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a successful refinement publishes ordered comments from started to activated', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    expect((await run(async () => ({
      result: 'success',
      context: ctx({ state: 'accepted' }),
      extraEvents: [snapshotCaptured(), draftRecorded(), critiquePassed()],
    }))).status).toBe('completed');

    // The application walk continues on the next tick and activates.
    const carried = (await taskStore.getTask(KEY)).context;
    expect((await run(async () => ({
      result: 'success',
      context: { ...carried, refinement: { ...carried.refinement, state: 'activated' } },
      extraEvents: [activatedEvent()],
    }))).status).toBe('completed');

    const rows = await comments();
    expect(rows.map((r) => r.payload.body.match(/\| Milestone \| `(\w+)` \|/)[1])).toEqual([
      'started',
      'refiner_completed',
      'critic_completed',
      'accepted',
      'activated',
    ]);
    // One comment per committed milestone, keyed on it.
    const ids = await milestoneIds();
    expect(rows.map((r) => r.idempotencyKey)).toEqual(
      ids.map((milestoneId) =>
        refinementProgressCommentIdempotencyKey({ sessionId: 'test-session', issueNumber: 99, milestoneId }),
      ),
    );
  });

  test('a replayed phase completion publishes no duplicate comment', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    const handlerResult = (context) => ({
      result: 'success',
      context,
      extraEvents: [snapshotCaptured(), draftRecorded(), critiquePassed()],
    });
    await run(async () => handlerResult(ctx({ state: 'accepted' })));
    const first = await comments();
    expect(first).toHaveLength(4);

    // The row stayed queued at this phase, so the next tick re-claims it and a
    // crashed run re-derives the identical walk. The ledger on the row keeps the
    // milestones from repeating; the idempotency key keeps the rows from doing so.
    const replay = (await taskStore.getTask(KEY)).context;
    await run(async () => handlerResult({ ...replay, refinement: { ...replay.refinement, state: 'accepted' } }));
    const second = await comments();
    expect(second.map((r) => r.idempotencyKey)).toEqual(first.map((r) => r.idempotencyKey));
  });

  test('a committed retry publishes exactly one comment carrying the row deadline', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    const outcome = await run(async () => ({
      result: 'delayed',
      message: 'refinement refiner process failure (usage_quota) in round 1',
      context: ctx({
        state: 'drafting',
        pendingRetry: { role: 'refiner', round: 1, attempt: 1, failureKind: 'usage_quota' },
      }),
      extraEvents: [agentFailed()],
    }));
    expect(outcome.status).toBe('delayed');

    const rows = await comments();
    expect(rows).toHaveLength(1);
    const task = await taskStore.getTask(KEY);
    expect(rows[0].payload.body).toContain(`| Retry not before | \`${task.notBefore}\` (UTC) |`);
    expect(rows[0].payload.body).toContain('| Failure class | `usage_quota` |');

    // A later scheduler pass that re-runs the same unchanged retry crosses no
    // new boundary: the ledger suppresses the milestone, so no second comment.
    // The pass runs after the committed deadline, which is how the row becomes
    // claimable again at all.
    const later = '2026-08-21T10:00:00.000Z';
    const carried = (await taskStore.getTask(KEY)).context;
    const second = await runNextPhase({
      store: taskStore,
      request: { ...REQUEST, runId: 'run-refine-2', now: later },
      handlers: {
        refinement: async () => ({ result: 'delayed', context: carried, extraEvents: [agentFailed()] }),
      },
      outboxStore,
      session: SESSION,
      now: later,
    });
    expect(second.status).toBe('delayed');
    expect(await comments()).toHaveLength(1);
  });

  test('a lost claim publishes neither the milestone nor its comment', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: {
        refinement: async () => {
          await taskStore.transitionTask(KEY, {}, { ownerRunId: 'someone-else', now: NOW });
          return {
            result: 'success',
            context: ctx({ state: 'accepted' }),
            extraEvents: [snapshotCaptured(), critiquePassed()],
          };
        },
      },
      outboxStore,
      session: SESSION,
      now: NOW,
    });
    expect(outcome.status).toBe('claim_lost');
    expect(await milestoneIds()).toEqual([]);
    expect(await comments()).toHaveLength(0);
  });

  test('a poll that crosses no boundary publishes nothing', async () => {
    await enqueueTask(ctx({ state: 'pending' }));
    // An eligibility hold: delayed, no pendingRetry, and no event that projects
    // a milestone. It is the commonest run this lane makes.
    const outcome = await run(async () => ({
      result: 'delayed',
      message: 'refinement is not yet eligible',
      context: ctx({ state: 'pending' }),
      extraEvents: [evt('refinement.hold', { state: 'pending', reason: 'predecessor_not_ready' })],
    }));
    expect(outcome.status).toBe('delayed');
    expect(await milestoneIds()).toEqual([]);
    expect(await comments()).toHaveLength(0);
  });

  test('a terminal handoff publishes its progress comment before the §13 notice', async () => {
    await enqueueTask(ctx({ state: 'critiquing' }));
    const outcome = await run(async () => ({
      result: 'blocked',
      message: 'refinement escalated (agent_unavailable)',
      context: ctx({ state: 'escalated_human', handoffReason: 'agent_unavailable', counters: {} }),
      extraEvents: [
        evt('refinement.escalated.human', { state: 'escalated_human', reason: 'agent_unavailable' }),
      ],
    }));
    expect(outcome.status).toBe('completed');

    const rows = await comments();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.body).toContain('| Milestone | `human_handoff` |');
    expect(rows[0].payload.body).toContain('**Human action required.**');
    // The §13 handoff comment still lands, unchanged, behind it.
    expect(rows[1].payload.body).toContain('Issue refinement stopped and needs a human');
  });

  test('a non-retryable phase failure publishes the terminal boundary', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    const outcome = await run(async () => {
      throw new Error('refinement handler exploded');
    });
    expect(outcome.status).toBe('completed');

    const rows = await comments();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.body).toContain('| Milestone | `failed` |');
    expect(rows[0].payload.body).toContain('**Human action required.**');
    // The handler's error string is prose; it never reaches the comment.
    expect(rows[0].payload.body).not.toContain('exploded');
  });

  test('an unpublishable milestone publishes nothing and becomes a diagnostic event', async () => {
    // Only a producer this build does not have can mint one, so it is driven
    // through the builder directly — what matters is that the refusal turns
    // into the task event the committing layer appends, and never a comment.
    const refusals = await enqueueRefinementProgressCommentEffects(
      outboxStore, SESSION, { issueNumber: 99 }, [milestone({ kind: 'from_the_future' })], NOW,
    );
    expect(refusals).toHaveLength(1);
    expect(await comments()).toHaveLength(0);

    const event = refinementProgressCommentUnpublishableEvent(refusals[0]);
    expect(event.type).toBe(REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT);
    expect(event.type).toBe('refinement.progress.comment.unpublishable');
    expect(event.data).toMatchObject({
      code: 'unknown_kind',
      projection: REFINEMENT_PROGRESS_COMMENT_PROJECTION,
      projectionVersion: REFINEMENT_PROGRESS_COMMENT_VERSION,
      milestoneId: 'f'.repeat(32),
      issueNumber: 99,
    });
    // The diagnostic is actionable and content-free: it names what to read, and
    // carries no milestone prose, path, or agent output.
    expect(event.data.detail).toContain('admin task-status');
    expect(event.message).toBe(refusals[0].detail);
  });
});
