import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  parseEvaluateHistoryArgs,
  runEvaluateHistory,
  deriveOutcomeSignals,
  classifyOutcome,
  buildRecord,
  renderJsonl,
  renderCsv,
  renderCalibrationPrompt,
  renderSummaryMarkdown,
  renderPlannerSection,
  derivePlannerCandidates,
  computePlannerDisagreements,
  interpretPlannerArtifact,
  hasPlannerPredictions,
  ArtifactPlannerSource,
  LivePlannerSource,
  SqliteHistoryStore,
  EmptyHistoryStore,
} from '../dist/cli/issue-plan-history.js';
import { computeFingerprint } from '../dist/cli/issue-discuss.js';
import { analyzeIssueForPlan } from '../dist/cli/issue-plan.js';

const ADMIN_CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let repoRoot;
let sessionsPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'issue-plan-history-test-'));
  repoRoot = join(tmpDir, 'repo');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeFileSync(sessionsPath, JSON.stringify({
    sessions: [{
      sessionId: 'addon-dev',
      repoKey: 'demo-repo',
      repoRoot,
      githubRepo: 'm2dw/demo-repo',
      artifactDir: '.n8n-artifacts',
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
      verification: {},
      labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    }],
  }));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Read-only fake issue reader: exposes only readIssue.
function makeReader(issuesByNumber) {
  const calls = [];
  return {
    calls,
    readIssue(repo, issueNumber) {
      calls.push({ method: 'readIssue', repo, issueNumber });
      const issue = issuesByNumber[issueNumber];
      if (!issue) throw new Error(`no fake issue for #${issueNumber}`);
      return { number: issueNumber, ...issue };
    },
  };
}

// Read-only fake history store.
function makeHistoryStore(historyByNumber) {
  const calls = [];
  let closed = false;
  return {
    calls,
    get closed() { return closed; },
    readHistory(sessionId, issueNumber) {
      calls.push({ sessionId, issueNumber });
      return historyByNumber[issueNumber] ?? { events: [], comments: [] };
    },
    close() { closed = true; },
  };
}

const EASY_ISSUE = {
  title: 'Fix typo in README',
  body: '## Acceptance Criteria\n\n- The typo is corrected.\n- `npm test` passes.',
  state: 'OPEN',
  labels: ['enhancement'],
  comments: [],
};

async function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(chunks.join('').trim());
}

function runAdmin(...args) {
  try {
    const stdout = execFileSync(process.execPath, [ADMIN_CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe('parseEvaluateHistoryArgs', () => {
  test('missing --session-id is rejected', () => {
    expect(parseEvaluateHistoryArgs(['--issues', '1,2'])).toMatchObject({ error: expect.stringContaining('session-id') });
  });

  test('missing --issues is rejected', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a'])).toMatchObject({ error: expect.stringContaining('issues') });
  });

  test('non-numeric issue token is rejected', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1,x'])).toMatchObject({ error: expect.stringContaining('positive integers') });
  });

  test('parses and de-duplicates an explicit issue list', () => {
    const parsed = parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '309, 311, 309 , 295']);
    expect(parsed).toMatchObject({ sessionId: 'a', issues: [309, 311, 295], format: 'jsonl', commentLimit: 10 });
  });

  test('invalid --format is rejected', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1', '--format', 'yaml'])).toMatchObject({ error: expect.stringContaining('format') });
  });

  test('--comment-limit is clamped to the max', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1', '--comment-limit', '999']).commentLimit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Outcome signal derivation + bucket classification
// ---------------------------------------------------------------------------

describe('deriveOutcomeSignals + classifyOutcome', () => {
  test('easy: implementation 1, review 1, no fix loop', () => {
    const history = {
      task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'implementation', result: 'success' }, createdAt: 't' },
        { type: 'phase.completed', data: { phase: 'review', result: 'success' }, createdAt: 't' },
      ],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.implementationAttempts).toBe(1);
    expect(signals.reviewAttempts).toBe(1);
    expect(signals.needsFixCount).toBe(0);
    expect(classifyOutcome(signals).bucket).toBe('easy');
  });

  test('easy: passing review handed off to ready_for_human (production has no `done`)', () => {
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'implementation', result: 'success' }, createdAt: 't' },
        { type: 'phase.completed', data: { phase: 'review', result: 'success' }, createdAt: 't' },
      ],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(true);
    expect(signals.humanHandoff).toBe(true);
    expect(classifyOutcome(signals).bucket).toBe('easy');
  });

  test('normal: ready_for_human handoff after a single fix cycle', () => {
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 2, review: 2 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'review', result: 'needs_fix' }, createdAt: 't' },
        { type: 'phase.completed', data: { phase: 'review', result: 'success' }, createdAt: 't' },
      ],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(true);
    expect(classifyOutcome(signals).bucket).toBe('normal');
  });

  test('incomplete: a blocked-review handoff to ready_for_human is NOT treated as easy/final', () => {
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'review', result: 'blocked' }, createdAt: 't' },
      ],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(false);
    expect(signals.humanHandoff).toBe(true);
    // ready_for_human ALONE is not success: not final, so not a final outcome.
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('normal: completed after a single fix cycle', () => {
    const history = {
      task: { status: 'done', phase: 'review', attempts: { implementation: 2, review: 2 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'review', result: 'needs_fix' }, createdAt: 't' },
        { type: 'phase.completed', data: { phase: 'review', result: 'success' }, createdAt: 't' },
      ],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.needsFixCount).toBe(1);
    expect(signals.blockingReviewCount).toBe(1);
    expect(classifyOutcome(signals).bucket).toBe('normal');
  });

  test('hard: cap reached / high attempts', () => {
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 4, review: 5 }, context: { reviewLoopCapReached: true }, updatedAt: 't' },
      events: [],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.capReached).toBe(true);
    expect(signals.humanHandoff).toBe(true);
    expect(classifyOutcome(signals).bucket).toBe('hard');
  });

  test('tooling_noise: tool request dominates and task not done', () => {
    const history = {
      task: { status: 'ready_for_human', phase: 'implementation', attempts: { implementation: 1 }, context: { toolRequest: { command: 'npm install x' } }, updatedAt: 't' },
      events: [{ type: 'phase.completed', data: { phase: 'implementation', result: 'tool_request' }, createdAt: 't' }],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.toolRequestSignal).toBe(true);
    expect(signals.toolingNoiseSignal).toBe(true);
    expect(signals.noiseSignals).toContain('disallowed-command tool request');
    const out = classifyOutcome(signals);
    expect(out.bucket).toBe('tooling_noise');
    expect(out.reason).toMatch(/tool request/i);
  });

  test('infra_noise: dirty working tree in lastError, not done', () => {
    const history = {
      task: { status: 'failed', phase: 'implementation', attempts: { implementation: 1 }, context: {}, lastError: 'aborting: working tree is dirty', updatedAt: 't' },
      events: [],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.infraNoiseSignal).toBe(true);
    expect(signals.infraReasons).toContain('dirty working tree');
    expect(classifyOutcome(signals).bucket).toBe('infra_noise');
  });

  test('infra noise does NOT override a cleanly completed task', () => {
    const history = {
      task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, lastError: 'a transient ETIMEDOUT happened earlier', updatedAt: 't' },
      events: [],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.infraNoiseSignal).toBe(true);
    // Cleanly done → still easy, infra does not dominate.
    expect(classifyOutcome(signals).bucket).toBe('easy');
  });

  test('unknown: no local data', () => {
    const signals = deriveOutcomeSignals({ events: [], comments: [] });
    expect(signals.hasLocalData).toBe(false);
    expect(classifyOutcome(signals).bucket).toBe('unknown');
  });

  test('unknown: an unreadable history is never bucketed as normal', () => {
    const signals = deriveOutcomeSignals({ events: [], comments: [], readError: 'database is locked' });
    expect(signals.hasLocalData).toBe(false);
    expect(signals.historyReadError).toBe('database is locked');
    const out = classifyOutcome(signals);
    expect(out.bucket).toBe('unknown');
    expect(out.reason).toContain('database is locked');
  });

  test('a failed task with low attempts is NOT easy/final (incomplete, no false-easy)', () => {
    const history = {
      task: { status: 'failed', phase: 'implementation', attempts: { implementation: 1 }, context: {}, updatedAt: 't' },
      events: [{ type: 'phase.completed', data: { phase: 'implementation', result: 'failed' }, createdAt: 't' }],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.hasLocalData).toBe(true);
    expect(signals.finality).toBe('incomplete');
    const out = classifyOutcome(signals);
    expect(out.bucket).toBe('incomplete');
    expect(out.reason).toMatch(/failed/);
  });

  test('a blocked task with low attempts is not classified easy/final', () => {
    const history = {
      task: { status: 'blocked', phase: 'implementation', attempts: { implementation: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('incomplete: a queued task is not classified as a final outcome (#326)', () => {
    const history = {
      task: { status: 'queued', phase: 'implementation', attempts: {}, context: {}, updatedAt: 't' },
      events: [],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.hasLocalData).toBe(true);
    expect(signals.finality).toBe('incomplete');
    const out = classifyOutcome(signals);
    expect(out.bucket).toBe('incomplete');
    expect(out.reason).toMatch(/queued/);
  });

  test('infra_noise vs tooling_noise: auth failure is tooling, network failure is infra', () => {
    const authHistory = {
      task: { status: 'failed', phase: 'implementation', attempts: { implementation: 1 }, context: {}, lastError: 'gh: authentication failed: bad credentials', updatedAt: 't' },
      events: [],
      comments: [],
    };
    const authSignals = deriveOutcomeSignals(authHistory);
    expect(authSignals.toolingNoiseSignal).toBe(true);
    expect(authSignals.toolingReasons).toContain('auth failure');
    expect(authSignals.infraNoiseSignal).toBe(false);
    expect(classifyOutcome(authSignals).bucket).toBe('tooling_noise');

    const netHistory = {
      task: { status: 'failed', phase: 'implementation', attempts: { implementation: 1 }, context: {}, lastError: 'ECONNRESET while talking to api.github.com', updatedAt: 't' },
      events: [],
      comments: [],
    };
    const netSignals = deriveOutcomeSignals(netHistory);
    expect(netSignals.infraNoiseSignal).toBe(true);
    expect(classifyOutcome(netSignals).bucket).toBe('infra_noise');
  });

  test('command-permission failure surfaces as tooling_noise', () => {
    const history = {
      task: { status: 'failed', phase: 'implementation', attempts: { implementation: 1 }, context: {}, lastError: 'command not allowed: rm -rf', updatedAt: 't' },
      events: [],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.toolingReasons).toContain('command permission failure');
    expect(classifyOutcome(signals).bucket).toBe('tooling_noise');
  });

  test('attempts fall back to phase.started counts when task is absent', () => {
    const history = {
      events: [
        { type: 'phase.started', data: { phase: 'implementation' }, createdAt: 't' },
        { type: 'phase.started', data: { phase: 'implementation' }, createdAt: 't' },
        { type: 'phase.started', data: { phase: 'review' }, createdAt: 't' },
      ],
      comments: [],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.implementationAttempts).toBe(2);
    expect(signals.reviewAttempts).toBe(1);
  });

  test('stored "Review passed" comment proves success when phase.completed events are absent', () => {
    // Legacy / read-only DB: ready_for_human task, no review event, but the
    // generated "Review passed" comment is present (issue #329 review).
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [{ body: '✅ **Review passed** for #42.', createdAt: 't', sent: true }],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(true);
    expect(signals.completedCleanly).toBe(true);
    expect(signals.finality).toBe('final');
    expect(classifyOutcome(signals).bucket).toBe('easy');
  });

  test('stored "Review loop cap reached" comment proves a final cap handoff without events', () => {
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 3, review: 4 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [{ body: '🛑 **Review loop cap reached** for #42.\n\nBlocking review cycles: 3/3.', createdAt: 't', sent: true }],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.capReached).toBe(true);
    expect(signals.finality).toBe('final');
    expect(classifyOutcome(signals).bucket).toBe('hard');
  });

  test('ready_for_human with no passing-review evidence stays incomplete (handoff alone is not success)', () => {
    // Same status, but the stored comment is a needs_fix/requeue note, not a pass.
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [{ body: '🔄 **Review found blocking findings for #42 — automatically requeuing to fix mode.**', createdAt: 't', sent: true }],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(false);
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('stale stored "Review passed" comment does NOT override a current blocked review event (requeue/recovery)', () => {
    // A prior run left a "Review passed" comment, then the issue was requeued and
    // the current run's review came back blocked. The recorded event must win
    // over the stale comment (issue #329 review).
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 2, review: 2 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'review', result: 'blocked' }, createdAt: 't2' },
      ],
      comments: [{ body: '✅ **Review passed** for #42.', createdAt: 't1', sent: true }],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(false);
    expect(signals.completedCleanly).toBe(false);
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('stale stored "Review loop cap reached" comment does NOT override a recovered run with cleared cap context', () => {
    // The cap comment is left over from before a recovery; the current run has a
    // fresh review event and no cap flag, so it must not be exported as a hard cap.
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 2, review: 2 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'review', result: 'needs_fix' }, createdAt: 't2' },
      ],
      comments: [{ body: '🛑 **Review loop cap reached** for #42.\n\nBlocking review cycles: 3/3.', createdAt: 't1', sent: true }],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.capReached).toBe(false);
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('stale stored "Review loop cap reached" comment does NOT finalize an in-flight requeued task', () => {
    // A prior run hit the cap and left the comment; the task was then requeued and
    // is now `running` again with no current review event yet. The stale comment
    // must not promote this in-flight issue to a final capped (hard) outcome
    // (issue #329 review): finality must stay incomplete.
    const history = {
      task: { status: 'running', phase: 'review', attempts: { implementation: 3, review: 3 }, context: {}, updatedAt: 't2' },
      events: [],
      comments: [{ body: '🛑 **Review loop cap reached** for #42.\n\nBlocking review cycles: 3/3.', createdAt: 't1', sent: true }],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.capReached).toBe(false);
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('newer stored "Review passed" comment supersedes an older "cap reached" on a legacy DB', () => {
    // A capped run left the cap comment, was recovered, and later passed — but the
    // read-only / legacy DB carries no terminal `phase.completed` event, so the
    // older `🛑 Review loop cap reached` comment lingers alongside the newer
    // `✅ Review passed` one. The latest marker (by timestamp) must win so the run
    // is exported as the actual pass, not a stale capped `hard` outcome
    // (issue #329 review).
    // Modest attempt counts so the cap marker is the only thing that could make
    // this `hard`; without the timestamp fix the stale cap comment would.
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [
        { body: '🛑 **Review loop cap reached** for #42.\n\nBlocking review cycles: 3/3.', createdAt: '2026-06-22T10:00:00.000Z', sent: true },
        { body: '✅ **Review passed** for #42.', createdAt: '2026-06-22T11:00:00.000Z', sent: true },
      ],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(true);
    expect(signals.capReached).toBe(false);
    expect(signals.completedCleanly).toBe(true);
    expect(signals.finality).toBe('final');
    expect(classifyOutcome(signals).bucket).not.toBe('hard');
  });

  test('older stored "Review passed" does NOT supersede a newer "cap reached" on a legacy DB', () => {
    // The reverse ordering: an early pass comment followed by a later cap comment
    // means the run ultimately hit the cap. The latest marker must drive the
    // fallback, so the cap outcome wins (issue #329 review).
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 3, review: 4 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [
        { body: '✅ **Review passed** for #42.', createdAt: '2026-06-22T10:00:00.000Z', sent: true },
        { body: '🛑 **Review loop cap reached** for #42.\n\nBlocking review cycles: 3/3.', createdAt: '2026-06-22T11:00:00.000Z', sent: true },
      ],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(false);
    expect(signals.capReached).toBe(true);
    expect(signals.finality).toBe('final');
    expect(classifyOutcome(signals).bucket).toBe('hard');
  });

  test('newer stored "Review passed" overrides an OLDER review needs_fix event on a partial history', () => {
    // Partial / legacy history: the first review returned `needs_fix` (event
    // recorded), the run was fixed and re-reviewed to a pass, but the terminal
    // `phase.completed` success event was never recorded — only the generated
    // `✅ Review passed` comment, stamped AFTER the needs_fix event. Treating any
    // review event as authoritative would skip the stored-marker fallback and
    // misclassify this final pass as incomplete. The latest marker is newer than
    // the latest review event, so it must win (issue #329 review).
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 2, review: 2 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'review', result: 'needs_fix' }, createdAt: '2026-06-22T10:00:00.000Z' },
      ],
      comments: [
        { body: '✅ **Review passed** for #42.', createdAt: '2026-06-22T11:00:00.000Z', sent: true },
      ],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(true);
    expect(signals.completedCleanly).toBe(true);
    expect(signals.finality).toBe('final');
    expect(classifyOutcome(signals).bucket).not.toBe('incomplete');
  });

  test('newer stored "cap reached" overrides an OLDER review needs_fix event on a partial history', () => {
    // Same partial-history shape, but the terminal marker is the cap. The first
    // review's `needs_fix` event predates the `🛑 Review loop cap reached`
    // comment, so the newer cap marker must drive a final `hard` outcome rather
    // than leaving the run as incomplete (issue #329 review).
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 3, review: 4 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'review', result: 'needs_fix' }, createdAt: '2026-06-22T10:00:00.000Z' },
      ],
      comments: [
        { body: '🛑 **Review loop cap reached** for #42.\n\nBlocking review cycles: 3/3.', createdAt: '2026-06-22T11:00:00.000Z', sent: true },
      ],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.capReached).toBe(true);
    expect(signals.finality).toBe('final');
    expect(classifyOutcome(signals).bucket).toBe('hard');
  });

  test('a quoted marker inside a blocking-review excerpt does NOT finalize a failing run', () => {
    // A generated blocking-review (needs_fix) comment embeds the prior review
    // feedback as an excerpt inside a `<details>` code fence, and that excerpt can
    // literally quote `✅ **Review passed**` / `🛑 **Review loop cap reached**`.
    // An unanchored marker match would read the quoted text as terminal outcome
    // evidence and — because the stored-marker fallback can override a newer
    // review event by timestamp — export this unfinished/failing loop as a final
    // `easy`/`hard` outcome. The markers must match only the generated comment
    // header (start of body), not anywhere in the body (issue #329 review).
    const blockingBody = [
      '🔄 **Review found blocking findings for #42 — automatically requeuing to fix mode.**',
      '',
      'Reason: Review found blocking findings',
      '',
      '<details>',
      '<summary>Review findings excerpt</summary>',
      '',
      '```',
      'Earlier the bot said ✅ **Review passed** for #42, but that was premature.',
      'A flaky run also reported 🛑 **Review loop cap reached** for #42.',
      '```',
      '</details>',
    ].join('\n');
    const history = {
      task: { status: 'running', phase: 'review', attempts: { implementation: 2, review: 2 }, context: {}, updatedAt: 't' },
      events: [
        { type: 'phase.completed', data: { phase: 'review', result: 'needs_fix' }, createdAt: '2026-06-22T10:00:00.000Z' },
      ],
      comments: [
        { body: blockingBody, createdAt: '2026-06-22T11:00:00.000Z', sent: true },
      ],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(false);
    expect(signals.capReached).toBe(false);
    expect(signals.completedCleanly).toBe(false);
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('newer non-terminal review handoff comment defeats a stale "Review passed" on a partial DB', () => {
    // Legacy / partial DB with NO review `phase.completed` event. A prior run
    // left a `✅ Review passed` comment; the issue was then requeued and the
    // current run escalated to a human, leaving a NEWER `⚠️ Review escalated`
    // handoff. With no review event, keying off `lastReviewEventAt === null`
    // alone would make the stale pass marker authoritative and export a final
    // `easy` outcome. The newer handoff comment is fresher review evidence, so
    // the stale marker must not win — the run stays incomplete (issue #329).
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [
        { body: '✅ **Review passed** for #42.', createdAt: '2026-06-22T10:00:00.000Z', sent: true },
        { body: '⚠️ **Review escalated to human** for #42.\n\nReason: Review requires human attention', createdAt: '2026-06-22T11:00:00.000Z', sent: true },
      ],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(false);
    expect(signals.completedCleanly).toBe(false);
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('newer non-terminal review handoff comment defeats a stale "cap reached" on a partial DB', () => {
    // Same shape but the stale terminal marker is the loop cap. A NEWER
    // requeue-to-fix handoff means the run did not end at the cap, so it must
    // not be exported as a final `hard` cap outcome (issue #329).
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 2, review: 2 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [
        { body: '🛑 **Review loop cap reached** for #42.\n\nBlocking review cycles: 3/3.', createdAt: '2026-06-22T10:00:00.000Z', sent: true },
        { body: '🔄 **Review found blocking findings for #42 — automatically requeuing to fix mode.**\n\nReason: Review found blocking findings', createdAt: '2026-06-22T11:00:00.000Z', sent: true },
      ],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(false);
    expect(signals.capReached).toBe(false);
    expect(signals.finality).toBe('incomplete');
    expect(classifyOutcome(signals).bucket).toBe('incomplete');
  });

  test('an OLDER review handoff comment does NOT block a newer "Review passed" on a partial DB', () => {
    // Regression guard for the opposite ordering: the escalation handoff predates
    // the terminal pass marker (the run escalated, was recovered, then passed) on
    // a legacy DB with no review event. The newer pass marker is the latest review
    // evidence and must still finalize the run as a clean pass (issue #329).
    const history = {
      task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [
        { body: '⚠️ **Review escalated to human** for #42.\n\nReason: Review requires human attention', createdAt: '2026-06-22T10:00:00.000Z', sent: true },
        { body: '✅ **Review passed** for #42.', createdAt: '2026-06-22T11:00:00.000Z', sent: true },
      ],
    };
    const signals = deriveOutcomeSignals(history);
    expect(signals.reviewSucceeded).toBe(true);
    expect(signals.completedCleanly).toBe(true);
    expect(signals.finality).toBe('final');
    expect(classifyOutcome(signals).bucket).not.toBe('incomplete');
  });

  test('run metadata is parsed from a stored comment body', () => {
    const body = [
      'Review complete.',
      '',
      '<details>',
      '<summary>Run metadata</summary>',
      '',
      '- Phase: review',
      '- Agent: Codex',
      '- Model: gpt-5',
      '- Effort: high',
      '- Run ID: run-1',
      '- Duration: 3m 12s',
      '',
      '</details>',
    ].join('\n');
    const signals = deriveOutcomeSignals({ events: [], comments: [{ body, createdAt: 't', sent: true }] });
    expect(signals.runMetadata).toEqual([{ phase: 'review', model: 'gpt-5', effort: 'high', duration: '3m 12s' }]);
  });
});

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

describe('buildRecord', () => {
  test('joins heuristic prediction with local outcome', () => {
    const history = {
      task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [],
    };
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 42, { number: 42, ...EASY_ISSUE }, history, 10);
    expect(record).toMatchObject({
      sessionId: 'addon-dev',
      repo: 'm2dw/demo-repo',
      issueNumber: 42,
      decision: 'ready',
      complexity: 'low',
      acceptanceCriteriaCount: 2,
      implementationAttempts: 1,
      reviewAttempts: 1,
      outcomeBucket: 'easy',
      hasLocalData: true,
      finality: 'final',
      calibrationEligible: true,
    });
    expect(record.labels).toEqual(['enhancement']);
    // issue #329 fields are present and well-formed.
    expect(record.outcomeBucketReason).toEqual(expect.any(String));
    expect(Array.isArray(record.noiseSignals)).toBe(true);
    expect(Array.isArray(record.issueDifficultySignals)).toBe(true);
    expect(record.calibrationExclusionReason).toBeUndefined();
  });

  test('an incomplete task is excluded from calibration with an explicit reason', () => {
    const history = {
      task: { status: 'running', phase: 'implementation', attempts: { implementation: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [],
    };
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 42, { number: 42, ...EASY_ISSUE }, history, 10);
    expect(record.finality).toBe('incomplete');
    expect(record.outcomeBucket).toBe('incomplete');
    expect(record.calibrationEligible).toBe(false);
    expect(record.calibrationExclusionReason).toMatch(/not final/i);
  });

  test('a completed-but-noisy hard run is excluded from calibration (noise may have inflated retries)', () => {
    // The run finished (done) with a passing review, so it skips the noise bucket,
    // but the high attempt counts that make it `hard` followed an infra failure on
    // an earlier attempt. Its difficulty cannot be cleanly attributed to the issue
    // (issue #329 review), so it must not drive calibration.
    const history = {
      task: { status: 'done', phase: 'review', attempts: { implementation: 4, review: 4 }, context: {}, lastError: 'ECONNRESET talking to api.github.com on attempt 1', updatedAt: 't' },
      events: [],
      comments: [],
    };
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 42, { number: 42, ...EASY_ISSUE }, history, 10);
    expect(record.outcomeBucket).toBe('hard');
    expect(record.infraNoiseSignal).toBe(true);
    expect(record.calibrationEligible).toBe(false);
    expect(record.calibrationExclusionReason).toMatch(/inflated by infra\/tooling noise/i);
  });

  test('a clean hard run with no noise stays calibration-eligible', () => {
    const history = {
      task: { status: 'done', phase: 'review', attempts: { implementation: 4, review: 4 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [],
    };
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 42, { number: 42, ...EASY_ISSUE }, history, 10);
    expect(record.outcomeBucket).toBe('hard');
    expect(record.noiseSignals).toEqual([]);
    expect(record.calibrationEligible).toBe(true);
  });

  test('preserves the full stored comment bodies, not just parsed run metadata', () => {
    const history = {
      task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' },
      events: [],
      comments: [
        { body: 'Review needs_fix: missing null check on line 12.', createdAt: 't1', sent: true },
        { body: 'Handing off to a human: review-loop cap reached.', createdAt: 't2', sent: false },
      ],
    };
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 42, { number: 42, ...EASY_ISSUE }, history, 10);
    expect(record.storedComments).toEqual([
      { body: 'Review needs_fix: missing null check on line 12.', createdAt: 't1', sent: true },
      { body: 'Handing off to a human: review-loop cap reached.', createdAt: 't2', sent: false },
    ]);
    // The bodies survive into the JSONL dataset (and thus the calibration prompt).
    expect(renderJsonl([record])).toContain('missing null check on line 12');
  });

  test('a read error still produces a complete record with readError set', () => {
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 7, { readError: 'boom' }, { events: [], comments: [] }, 10);
    expect(record.readError).toBe('boom');
    expect(record.title).toBe('(unreadable)');
    expect(record.outcomeBucket).toBe('unknown');
  });

  test('a read error leaves prediction fields null instead of fabricating them', () => {
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 7, { readError: 'boom' }, { events: [], comments: [] }, 10);
    expect(record.decision).toBeNull();
    expect(record.complexity).toBeNull();
    expect(record.recommendedImplementationEffort).toBeNull();
    expect(record.recommendedReviewEffort).toBeNull();
    expect(record.recommendedFlow).toBeNull();
    expect(record.acceptanceCriteriaCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

describe('renderers', () => {
  const records = [
    buildRecord('addon-dev', 'm2dw/demo-repo', 309, { number: 309, ...EASY_ISSUE },
      { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] }, 10),
  ];

  test('renderJsonl emits one JSON object per line', () => {
    const out = renderJsonl(records);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out.trim())).toMatchObject({ issueNumber: 309 });
  });

  test('renderCsv emits a header and a row', () => {
    const out = renderCsv(records);
    const lines = out.trim().split('\n');
    expect(lines[0]).toContain('issueNumber');
    expect(lines[1]).toContain('309');
  });

  test('renderSummaryMarkdown includes the table and observations', () => {
    const md = renderSummaryMarkdown('addon-dev', 'm2dw/demo-repo', records, '2026-06-21T00:00:00Z');
    expect(md).toContain('| #309 |');
    expect(md).toContain('## Observations');
  });

  test('renderCalibrationPrompt asks for concrete rule changes and separation of causes', () => {
    const prompt = renderCalibrationPrompt('m2dw/demo-repo', records);
    expect(prompt).toContain('CONCRETE candidate rule changes');
    expect(prompt).toContain('infrastructure or workflow noise');
    // The evaluated issue appears only as data in the JSONL block.
    expect(prompt).toContain('"issueNumber":309');
    expect(prompt).toContain('UNTRUSTED');
  });

  test('renderCalibrationPrompt derives candidate mismatches from records, not hard-coded issues', () => {
    const fp = { issueNumber: 700, decision: 'high_risk', complexity: 'xhigh', outcomeBucket: 'easy', calibrationEligible: true };
    const ok = { issueNumber: 701, decision: 'ready', complexity: 'low', outcomeBucket: 'easy', calibrationEligible: true };
    const prompt = renderCalibrationPrompt('m2dw/demo-repo', [fp, ok]);
    expect(prompt).toContain('## Candidate mismatches to confirm');
    expect(prompt).toContain('#700: predicted `high_risk` / `xhigh`');
    // No issue outside the evaluated dataset (e.g. the old hard-coded #309/#311) is asserted.
    expect(prompt).not.toContain('#309');
    expect(prompt).not.toContain('#311');
  });

  test('read-error rows are excluded from mismatch counts and noted as unclassified', () => {
    const readErr = buildRecord('addon-dev', 'm2dw/demo-repo', 8, { readError: 'boom' },
      { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] }, 10);
    expect(readErr.outcomeBucket).toBe('easy');
    const md = renderSummaryMarkdown('addon-dev', 'm2dw/demo-repo', [readErr], '2026-06-21T00:00:00Z');
    // Not reported as a false positive (no real prediction ran for it).
    expect(md).toContain('No likely false positives detected in this set.');
    expect(md).toContain('could not be read');
    const prompt = renderCalibrationPrompt('m2dw/demo-repo', [readErr]);
    expect(prompt).not.toContain('Candidate mismatches to confirm');
  });

  test('renderCalibrationPrompt omits the mismatch section when no candidate is derived', () => {
    const ok = { issueNumber: 701, decision: 'ready', complexity: 'low', outcomeBucket: 'easy', calibrationEligible: true };
    const prompt = renderCalibrationPrompt('m2dw/demo-repo', [ok]);
    expect(prompt).not.toContain('Candidate mismatches to confirm');
    expect(prompt).not.toContain('#309');
    expect(prompt).not.toContain('#311');
  });

  test('renderCalibrationPrompt instructs the agent to exclude non-final and ignore noise', () => {
    const prompt = renderCalibrationPrompt('m2dw/demo-repo', records);
    expect(prompt).toContain('Mandatory exclusions');
    expect(prompt).toContain('calibrationEligible');
    expect(prompt).toMatch(/ready_for_human.*not.*success/i);
    expect(prompt).toContain('NEVER infer issue difficulty from `noiseSignals`');
  });

  test('an incomplete (#326-style) candidate is excluded from calibration mismatches', () => {
    // Predicted hard but the run is still queued: must not be a final false positive.
    const incompleteFp = buildRecord('addon-dev', 'm2dw/demo-repo', 326,
      { number: 326, title: 'Refactor token refresh', body: 'See #300. Migration + rollback needed.', state: 'OPEN', labels: [], comments: [] },
      { task: { status: 'queued', phase: 'implementation', attempts: {}, context: {}, updatedAt: 't' }, events: [], comments: [] }, 10);
    expect(incompleteFp.finality).toBe('incomplete');
    expect(incompleteFp.calibrationEligible).toBe(false);
    const prompt = renderCalibrationPrompt('m2dw/demo-repo', [incompleteFp]);
    expect(prompt).not.toContain('Candidate mismatches to confirm');
    const md = renderSummaryMarkdown('addon-dev', 'm2dw/demo-repo', [incompleteFp], '2026-06-21T00:00:00Z');
    expect(md).toContain('are not final and are excluded from calibration');
  });
});

// ---------------------------------------------------------------------------
// runEvaluateHistory — local artifact contract
// ---------------------------------------------------------------------------

describe('runEvaluateHistory', () => {
  test('writes jsonl, summary, and calibration prompt; emits bucket counts', async () => {
    const reader = makeReader({
      309: EASY_ISSUE,
      311: { ...EASY_ISSUE, title: 'Another easy one' },
    });
    const store = makeHistoryStore({
      309: { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] },
      311: { task: { status: 'ready_for_human', phase: 'implementation', attempts: { implementation: 1 }, context: { toolRequest: { command: 'x' } }, updatedAt: 't' }, events: [], comments: [] },
    });
    const args = parseEvaluateHistoryArgs(['--session-id', 'addon-dev', '--issues', '309,311', '--sessions-path', sessionsPath]);
    const out = await capture(() => runEvaluateHistory(args, reader, store));

    expect(out).toMatchObject({ ok: true, sessionId: 'addon-dev', repo: 'm2dw/demo-repo', posted: false, issueCount: 2 });
    expect(out.bucketCounts).toMatchObject({ easy: 1, tooling_noise: 1 });
    // Only the cleanly-completed easy issue is calibration-eligible.
    expect(out.calibrationEligibleCount).toBe(1);
    expect(existsSync(out.artifacts.jsonl)).toBe(true);
    expect(existsSync(out.artifacts.summary)).toBe(true);
    expect(existsSync(out.artifacts.prompt)).toBe(true);
    expect(out.outDir).toContain(join('issue-plan', 'evaluate-history'));

    const jsonl = readFileSync(out.artifacts.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(jsonl).toHaveLength(2);
    expect(jsonl[0]).toMatchObject({ issueNumber: 309, outcomeBucket: 'easy', finality: 'final', calibrationEligible: true });
    expect(jsonl[1]).toMatchObject({ issueNumber: 311, outcomeBucket: 'tooling_noise', calibrationEligible: false });

    // The injected store is owned by the caller and must NOT be closed here.
    expect(store.closed).toBe(false);
    expect(store.calls).toEqual([
      { sessionId: 'addon-dev', issueNumber: 309 },
      { sessionId: 'addon-dev', issueNumber: 311 },
    ]);
  });

  test('--format csv additionally writes a CSV artifact', async () => {
    const reader = makeReader({ 309: EASY_ISSUE });
    const store = makeHistoryStore({ 309: { events: [], comments: [] } });
    const args = parseEvaluateHistoryArgs(['--session-id', 'addon-dev', '--issues', '309', '--format', 'csv', '--sessions-path', sessionsPath]);
    const out = await capture(() => runEvaluateHistory(args, reader, store));
    expect(out.artifacts.csv).toBeDefined();
    expect(existsSync(out.artifacts.csv)).toBe(true);
  });

  test('a per-issue read failure is captured, not fatal', async () => {
    const reader = {
      readIssue(repo, issueNumber) {
        if (issueNumber === 999) throw new Error('simulated read failure');
        return { number: issueNumber, ...EASY_ISSUE };
      },
    };
    const store = makeHistoryStore({});
    const args = parseEvaluateHistoryArgs(['--session-id', 'addon-dev', '--issues', '309,999', '--sessions-path', sessionsPath]);
    const out = await capture(() => runEvaluateHistory(args, reader, store));
    expect(out.issueCount).toBe(2);
    const jsonl = readFileSync(out.artifacts.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const failed = jsonl.find((r) => r.issueNumber === 999);
    expect(failed.readError).toContain('simulated read failure');
  });

  test('a history-store read failure is recorded as unknown, not normal', async () => {
    const reader = makeReader({ 309: EASY_ISSUE });
    const store = {
      closed: false,
      readHistory() { throw new Error('database is locked'); },
      close() { this.closed = true; },
    };
    const args = parseEvaluateHistoryArgs(['--session-id', 'addon-dev', '--issues', '309', '--sessions-path', sessionsPath]);
    const out = await capture(() => runEvaluateHistory(args, reader, store));
    const jsonl = readFileSync(out.artifacts.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rec = jsonl.find((r) => r.issueNumber === 309);
    expect(rec.outcomeBucket).toBe('unknown');
    expect(rec.hasLocalData).toBe(false);
    expect(rec.historyReadError).toContain('database is locked');
  });

  test('unknown session is fail-closed as JSON', async () => {
    const reader = makeReader({ 1: EASY_ISSUE });
    const store = makeHistoryStore({});
    const args = parseEvaluateHistoryArgs(['--session-id', 'nope', '--issues', '1', '--sessions-path', sessionsPath]);

    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    let exitCode = null;
    const origExit = process.exit.bind(process);
    process.exit = (code) => { exitCode = code; throw new Error('exit'); };
    try {
      await runEvaluateHistory(args, reader, store);
    } catch {
      // expected — intercepted process.exit
    } finally {
      process.stdout.write = orig;
      process.exit = origExit;
    }
    const output = JSON.parse(chunks.join('').trim());
    expect(output.ok).toBe(false);
    expect(output.error).toContain('nope');
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SqliteHistoryStore — real, read-only DB join
// ---------------------------------------------------------------------------

describe('SqliteHistoryStore', () => {
  function seedDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE tasks (session_id TEXT, issue_number INTEGER, status TEXT, phase TEXT, attempts TEXT, context TEXT, last_error TEXT, updated_at TEXT, PRIMARY KEY (session_id, issue_number));
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, issue_number INTEGER, type TEXT, run_id TEXT, message TEXT, data TEXT, created_at TEXT);
      CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT UNIQUE, topic TEXT, payload TEXT, created_at TEXT, sent_at TEXT);
    `);
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)').run(
      'addon-dev', 309, 'done', 'review',
      JSON.stringify({ implementation: 1, review: 1 }), JSON.stringify({}), null, 't',
    );
    db.prepare('INSERT INTO events (session_id, issue_number, type, run_id, message, data, created_at) VALUES (?,?,?,?,?,?,?)').run(
      'addon-dev', 309, 'phase.completed', 'r1', null, JSON.stringify({ phase: 'review', result: 'success' }), 't',
    );
    db.prepare('INSERT INTO outbox (idempotency_key, topic, payload, created_at, sent_at) VALUES (?,?,?,?,?)').run(
      'addon-dev:309:r1:gh:comment:review', 'gh:comment',
      JSON.stringify({ topic: 'gh:comment', owner: 'm2dw', repo: 'demo-repo', issueNumber: 309, body: 'Review done' }),
      't', 't',
    );
    // A comment for a different session/issue that must NOT be attributed to #309.
    db.prepare('INSERT INTO outbox (idempotency_key, topic, payload, created_at, sent_at) VALUES (?,?,?,?,?)').run(
      'other:309:r1:gh:comment:review', 'gh:comment',
      JSON.stringify({ topic: 'gh:comment', owner: 'm2dw', repo: 'demo-repo', issueNumber: 309, body: 'other session' }),
      't', null,
    );
    db.close();
  }

  test('reads task, events, and only this session\'s comments', () => {
    const dbPath = join(tmpDir, 'dev.db');
    seedDb(dbPath);
    const store = new SqliteHistoryStore(dbPath);
    try {
      const history = store.readHistory('addon-dev', 309);
      expect(history.task).toMatchObject({ status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 } });
      expect(history.events).toHaveLength(1);
      expect(history.events[0]).toMatchObject({ type: 'phase.completed', data: { result: 'success' } });
      expect(history.comments).toHaveLength(1);
      expect(history.comments[0]).toMatchObject({ body: 'Review done', sent: true });
    } finally {
      store.close();
    }
  });

  test('opens the database read-only (writes are rejected)', () => {
    const dbPath = join(tmpDir, 'dev2.db');
    seedDb(dbPath);
    const store = new SqliteHistoryStore(dbPath);
    try {
      // Reading is fine; mutating is impossible on a readonly connection. Prove the
      // store never produced a writable handle by confirming a fresh readonly
      // connection refuses writes.
      const probe = new Database(dbPath, { readonly: true });
      expect(() => probe.exec("INSERT INTO tasks VALUES ('x',1,'queued','review','{}','{}',null,'t')")).toThrow();
      probe.close();
      const history = store.readHistory('addon-dev', 309);
      expect(history.task).toBeDefined();
    } finally {
      store.close();
    }
  });

  test('missing issue yields empty history', () => {
    const dbPath = join(tmpDir, 'dev3.db');
    seedDb(dbPath);
    const store = new SqliteHistoryStore(dbPath);
    try {
      const history = store.readHistory('addon-dev', 12345);
      expect(history.task).toBeUndefined();
      expect(history.events).toEqual([]);
      expect(history.comments).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('legacy outbox without idempotency_key still returns task/events', () => {
    const dbPath = join(tmpDir, 'legacy.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE tasks (session_id TEXT, issue_number INTEGER, status TEXT, phase TEXT, attempts TEXT, context TEXT, last_error TEXT, updated_at TEXT, PRIMARY KEY (session_id, issue_number));
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, issue_number INTEGER, type TEXT, run_id TEXT, message TEXT, data TEXT, created_at TEXT);
      CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, payload TEXT, created_at TEXT, sent_at TEXT);
    `);
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)').run(
      'addon-dev', 309, 'done', 'review', JSON.stringify({ implementation: 1, review: 1 }), JSON.stringify({}), null, 't',
    );
    db.prepare('INSERT INTO events (session_id, issue_number, type, run_id, message, data, created_at) VALUES (?,?,?,?,?,?,?)').run(
      'addon-dev', 309, 'phase.completed', 'r1', null, JSON.stringify({ phase: 'review', result: 'success' }), 't',
    );
    db.close();
    const store = new SqliteHistoryStore(dbPath);
    try {
      const history = store.readHistory('addon-dev', 309);
      expect(history.task).toBeDefined();
      expect(history.events).toHaveLength(1);
      // Comment extraction is skipped for the legacy schema rather than throwing.
      expect(history.comments).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('falls back to a pruned issue\'s persisted rollup when the live task/events rows are gone (issue #611 review)', () => {
    const dbPath = join(tmpDir, 'pruned.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE tasks (session_id TEXT, issue_number INTEGER, status TEXT, phase TEXT, attempts TEXT, context TEXT, last_error TEXT, updated_at TEXT, PRIMARY KEY (session_id, issue_number));
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, issue_number INTEGER, type TEXT, run_id TEXT, message TEXT, data TEXT, created_at TEXT);
      CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT UNIQUE, topic TEXT, payload TEXT, created_at TEXT, sent_at TEXT);
      CREATE TABLE retention_issue_history_rollup (session_id TEXT, issue_number INTEGER, task_snapshot TEXT, events TEXT, archived_at TEXT, PRIMARY KEY (session_id, issue_number));
    `);
    // No row in `tasks`/`events` — this issue was already pruned. Only the
    // rollup and the (never-pruned) outbox comment survive.
    db.prepare(
      'INSERT INTO retention_issue_history_rollup (session_id, issue_number, task_snapshot, events, archived_at) VALUES (?,?,?,?,?)',
    ).run(
      'addon-dev',
      309,
      JSON.stringify({
        status: 'done',
        phase: 'review',
        attempts: JSON.stringify({ implementation: 1, review: 1 }),
        context: JSON.stringify({}),
        lastError: null,
        updatedAt: 't',
      }),
      JSON.stringify([{ type: 'phase.completed', message: null, data: JSON.stringify({ phase: 'review', result: 'success' }), createdAt: 't' }]),
      't',
    );
    db.prepare('INSERT INTO outbox (idempotency_key, topic, payload, created_at, sent_at) VALUES (?,?,?,?,?)').run(
      'addon-dev:309:r1:gh:comment:review', 'gh:comment',
      JSON.stringify({ topic: 'gh:comment', owner: 'm2dw', repo: 'demo-repo', issueNumber: 309, body: 'Review done' }),
      't', 't',
    );
    db.close();

    const store = new SqliteHistoryStore(dbPath);
    try {
      const history = store.readHistory('addon-dev', 309);
      expect(history.task).toMatchObject({ status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 } });
      expect(history.events).toHaveLength(1);
      expect(history.events[0]).toMatchObject({ type: 'phase.completed', data: { result: 'success' } });
      expect(history.comments).toHaveLength(1);
      expect(history.comments[0]).toMatchObject({ body: 'Review done' });
    } finally {
      store.close();
    }
  });

  test('a live task row is never shadowed by a stale rollup entry for the same issue', () => {
    const dbPath = join(tmpDir, 'live-wins.db');
    seedDb(dbPath);
    const db = new Database(dbPath, { readonly: false });
    db.exec(
      'CREATE TABLE retention_issue_history_rollup (session_id TEXT, issue_number INTEGER, task_snapshot TEXT, events TEXT, archived_at TEXT, PRIMARY KEY (session_id, issue_number))',
    );
    db.prepare(
      'INSERT INTO retention_issue_history_rollup (session_id, issue_number, task_snapshot, events, archived_at) VALUES (?,?,?,?,?)',
    ).run(
      'addon-dev',
      309,
      JSON.stringify({ status: 'stale', phase: 'stale', attempts: '{}', context: '{}', lastError: null, updatedAt: 't' }),
      JSON.stringify([]),
      't',
    );
    db.close();

    const store = new SqliteHistoryStore(dbPath);
    try {
      const history = store.readHistory('addon-dev', 309);
      expect(history.task.status).toBe('done'); // the live row, not the stale rollup
    } finally {
      store.close();
    }
  });
});

describe('EmptyHistoryStore', () => {
  test('degrades every issue to empty history (read-only no-op)', () => {
    const store = new EmptyHistoryStore();
    const history = store.readHistory('addon-dev', 309);
    expect(history).toEqual({ events: [], comments: [] });
    expect(() => store.close()).not.toThrow();
  });

  test('runEvaluateHistory degrades a missing --db-path to unknown records', async () => {
    const reader = makeReader({ 309: EASY_ISSUE });
    const missingDb = join(tmpDir, 'does-not-exist.db');
    // No injected store: the default factory must see the missing DB and fall
    // back to EmptyHistoryStore instead of aborting.
    const args = parseEvaluateHistoryArgs([
      '--session-id', 'addon-dev', '--issues', '309',
      '--sessions-path', sessionsPath, '--db-path', missingDb,
    ]);
    const out = await capture(() => runEvaluateHistory(args, reader));
    expect(out.ok).toBe(true);
    expect(out.issueCount).toBe(1);
    const jsonl = readFileSync(out.artifacts.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(jsonl[0]).toMatchObject({ issueNumber: 309, hasLocalData: false, outcomeBucket: 'unknown' });
    expect(existsSync(missingDb)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin CLI integration
// ---------------------------------------------------------------------------

describe('issue-plan evaluate-history — admin CLI integration', () => {
  test('appears in admin help output', () => {
    const r = runAdmin('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('issue-plan evaluate-history');
  });

  test('"help issue-plan evaluate-history" documents required flags', () => {
    const r = runAdmin('help', 'issue-plan', 'evaluate-history');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--issues');
    expect(r.stdout).toContain('--session-id');
  });

  test('missing --issues exits non-zero', () => {
    const r = runAdmin('issue-plan', 'evaluate-history', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('issues') });
  });

  test('unknown issue-plan action exits non-zero and mentions evaluate-history', () => {
    const r = runAdmin('issue-plan', 'bogus');
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('evaluate-history') });
  });
});

// ---------------------------------------------------------------------------
// AI Planner comparison (issue #359)
// ---------------------------------------------------------------------------

// A schema-valid planner result (matches PLANNER_SCHEMA_VERSION === 1).
const VALID_PLANNER_RESULT = {
  recommendedFlow: 'code',
  complexity: 'low',
  recommendedImplementationEffort: 'low',
  recommendedReviewEffort: 'low',
  riskSignals: [{ kind: 'ambiguity', explanation: 'goals are clear', severity: 'low' }],
  confidence: 0.82,
  splitRecommendation: { shouldSplit: false, childIssues: [] },
  requiresHumanGate: false,
  guardConflicts: [],
  reasoningSummary: 'Straightforward typo fix.',
  source: 'ai-planner',
  model: 'claude-test',
  schemaVersion: 1,
};

// Recompute the snapshot fingerprint exactly as `issue-plan ai-preview` does, so
// tests can build artifacts whose freshness check passes (or deliberately fails).
function fingerprintFor(issue, { sessionId = 'addon-dev', repo = 'm2dw/demo-repo', commentLimit = 10 } = {}) {
  const bounded = analyzeIssueForPlan(issue, commentLimit);
  return computeFingerprint({
    sessionId,
    repo,
    issueNumber: issue.number,
    issueState: issue.state,
    title: bounded.titleText,
    labels: issue.labels,
    body: issue.body,
    comments: commentLimit > 0 ? issue.comments.slice(-commentLimit) : [],
  });
}

// The fingerprint of the EASY_ISSUE@309 snapshot used by these fixtures.
const FRESH_FINGERPRINT = fingerprintFor({ number: 309, ...EASY_ISSUE });

// Build an `ai-planner-context.json`-shaped artifact object (mirrors what
// `issue-plan ai-preview` writes). `fingerprint` defaults to the fresh
// EASY_ISSUE@309 fingerprint so the artifact validates against that snapshot.
function makeContextArtifact({ status = 'ok', plannerResult = VALID_PLANNER_RESULT, plannerError = null, arbiterDecision = 'auto-run', fingerprint = FRESH_FINGERPRINT } = {}) {
  return {
    sessionId: 'addon-dev',
    repo: 'm2dw/demo-repo',
    issueNumber: 309,
    plannerResult,
    plannerError,
    arbiterDecision: arbiterDecision === null ? null : { decision: arbiterDecision, source: 'policy-arbiter' },
    execution: { provider: 'claude', status, source: 'ai-planner' },
    fingerprint,
  };
}

// A planner source returning canned predictions per issue number.
function makePlannerSource(byNumber) {
  const calls = [];
  let closed = false;
  return {
    calls,
    get closed() { return closed; },
    readPlanner(ctx) {
      calls.push(ctx);
      return byNumber[ctx.issueNumber] ?? { status: 'missing', result: null, arbiterDecision: null, error: 'no fixture', origin: 'none' };
    },
    close() { closed = true; },
  };
}

const OK_PREDICTION = { status: 'ok', result: VALID_PLANNER_RESULT, arbiterDecision: 'auto-run', error: null, origin: 'artifact' };

describe('interpretPlannerArtifact', () => {
  test('a valid plannerResult with a matching fingerprint is read as ok and re-validated', () => {
    const p = interpretPlannerArtifact(makeContextArtifact(), '/x/ctx.json', FRESH_FINGERPRINT);
    expect(p.status).toBe('ok');
    expect(p.result).toMatchObject({ complexity: 'low', confidence: 0.82 });
    expect(p.arbiterDecision).toBe('auto-run');
    expect(p.origin).toBe('artifact');
  });

  test('a valid plannerResult whose fingerprint no longer matches the snapshot is stale, not ok', () => {
    const p = interpretPlannerArtifact(makeContextArtifact(), '/x/ctx.json', 'a-different-fingerprint');
    expect(p.status).toBe('stale');
    expect(p.result).toBeNull();
    expect(p.error).toMatch(/does not match the current issue snapshot/);
  });

  test('a valid plannerResult with no recorded fingerprint cannot be verified and is stale', () => {
    const p = interpretPlannerArtifact(makeContextArtifact({ fingerprint: null }), '/x/ctx.json', FRESH_FINGERPRINT);
    expect(p.status).toBe('stale');
    expect(p.result).toBeNull();
    expect(p.error).toMatch(/no fingerprint/);
  });

  test('a valid plannerResult is stale when the current fingerprint could not be recomputed', () => {
    const p = interpretPlannerArtifact(makeContextArtifact(), '/x/ctx.json', null);
    expect(p.status).toBe('stale');
    expect(p.result).toBeNull();
    expect(p.error).toMatch(/Could not recompute/);
  });

  test('a recorded agent_error with no result is surfaced as agent_error, not ok', () => {
    const p = interpretPlannerArtifact(
      makeContextArtifact({ status: 'agent_error', plannerResult: null, plannerError: 'agent timed out', arbiterDecision: 'human-gate' }),
      '/x/ctx.json',
      FRESH_FINGERPRINT,
    );
    expect(p.status).toBe('agent_error');
    expect(p.result).toBeNull();
    expect(p.error).toContain('agent timed out');
  });

  test('a schema-invalid plannerResult degrades to invalid_output (never trusted)', () => {
    const bad = { ...VALID_PLANNER_RESULT, complexity: 'gigantic' };
    const p = interpretPlannerArtifact(makeContextArtifact({ status: 'ok', plannerResult: bad }), '/x/ctx.json', FRESH_FINGERPRINT);
    expect(p.status).toBe('invalid_output');
    expect(p.result).toBeNull();
    expect(p.error).toMatch(/complexity/);
  });

  test('a non-object artifact is invalid_output', () => {
    expect(interpretPlannerArtifact(null, '/x/ctx.json', FRESH_FINGERPRINT).status).toBe('invalid_output');
    expect(interpretPlannerArtifact([1, 2], '/x/ctx.json', FRESH_FINGERPRINT).status).toBe('invalid_output');
  });
});

describe('ArtifactPlannerSource', () => {
  test('consumes an existing ai-preview context artifact whose fingerprint matches the current snapshot', () => {
    const artifactRoot = join(tmpDir, 'arts');
    const dir = join(artifactRoot, 'issue-plan', 'issue-309');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ai-planner-context.json'), JSON.stringify(makeContextArtifact()));
    const source = new ArtifactPlannerSource(artifactRoot);
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 309, issue: { number: 309, ...EASY_ISSUE }, commentLimit: 10 });
    expect(p.status).toBe('ok');
    expect(p.origin).toBe('artifact');
    expect(p.artifactPath).toContain(join('issue-plan', 'issue-309', 'ai-planner-context.json'));
  });

  test('rejects a stale artifact whose snapshot changed after ai-preview ran', () => {
    const artifactRoot = join(tmpDir, 'stale-arts');
    const dir = join(artifactRoot, 'issue-plan', 'issue-309');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ai-planner-context.json'), JSON.stringify(makeContextArtifact()));
    const source = new ArtifactPlannerSource(artifactRoot);
    // The issue body changed since the artifact was written, so the recomputed
    // fingerprint differs — the schema-valid decision must NOT be scored as ok.
    const changed = { number: 309, ...EASY_ISSUE, body: EASY_ISSUE.body + '\n\nEdited after preview.' };
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 309, issue: changed, commentLimit: 10 });
    expect(p.status).toBe('stale');
    expect(p.result).toBeNull();
    expect(p.error).toMatch(/does not match the current issue snapshot/);
  });

  test('rejects an artifact as stale when the issue could not be read (freshness unprovable)', () => {
    const artifactRoot = join(tmpDir, 'noissue-arts');
    const dir = join(artifactRoot, 'issue-plan', 'issue-309');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ai-planner-context.json'), JSON.stringify(makeContextArtifact()));
    const source = new ArtifactPlannerSource(artifactRoot);
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 309, issue: undefined, commentLimit: 10 });
    expect(p.status).toBe('stale');
    expect(p.result).toBeNull();
  });

  test('a missing artifact is reported as missing, not a successful prediction', () => {
    const source = new ArtifactPlannerSource(join(tmpDir, 'empty-arts'));
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 999, commentLimit: 10 });
    expect(p.status).toBe('missing');
    expect(p.result).toBeNull();
    expect(p.origin).toBe('none');
    expect(p.error).toMatch(/No ai-preview artifact/);
  });

  test('a corrupt artifact JSON is invalid_output', () => {
    const artifactRoot = join(tmpDir, 'corrupt-arts');
    const dir = join(artifactRoot, 'issue-plan', 'issue-309');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ai-planner-context.json'), '{ not json');
    const source = new ArtifactPlannerSource(artifactRoot);
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 309, commentLimit: 10 });
    expect(p.status).toBe('invalid_output');
    expect(p.error).toMatch(/Failed to read ai-preview artifact/);
  });
});

describe('LivePlannerSource', () => {
  function makeAgent(run, provider = 'stub') {
    const calls = [];
    return { provider, calls, run(inv) { calls.push(inv); return typeof run === 'function' ? run(inv) : run; } };
  }
  const issue = { number: 309, ...EASY_ISSUE };

  test('a successful agent run yields an ok prediction with an arbiter decision', () => {
    const agent = makeAgent({ ok: true, stdout: JSON.stringify(VALID_PLANNER_RESULT), stderr: '', exitCode: 0 });
    const source = new LivePlannerSource({ agent, timeoutMs: 1000 });
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 309, issue, commentLimit: 10 });
    expect(p.status).toBe('ok');
    expect(p.origin).toBe('live');
    expect(p.arbiterDecision).toBe('auto-run');
    // The agent was invoked with an isolated cwd and the planner prompt.
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0].prompt).toContain('AI Planner');
    expect(agent.calls[0].cwd).toContain('ai-planner-cwd-');
  });

  test('an agent failure yields an agent_error prediction (fail closed)', () => {
    const agent = makeAgent({ ok: false, stdout: '', stderr: 'boom', exitCode: 1, error: 'spawn failed' });
    const source = new LivePlannerSource({ agent, timeoutMs: 1000 });
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 309, issue, commentLimit: 10 });
    expect(p.status).toBe('agent_error');
    expect(p.result).toBeNull();
    expect(p.arbiterDecision).toBe('human-gate');
  });

  test('unparseable agent output yields invalid_output', () => {
    const agent = makeAgent({ ok: true, stdout: 'not json at all', stderr: '', exitCode: 0 });
    const source = new LivePlannerSource({ agent, timeoutMs: 1000 });
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 309, issue, commentLimit: 10 });
    expect(p.status).toBe('invalid_output');
    expect(p.result).toBeNull();
  });

  test('a missing issue (read error) never runs the agent', () => {
    const agent = makeAgent({ ok: true, stdout: JSON.stringify(VALID_PLANNER_RESULT), stderr: '', exitCode: 0 });
    const source = new LivePlannerSource({ agent, timeoutMs: 1000 });
    const p = source.readPlanner({ sessionId: 'addon-dev', repo: 'm2dw/demo-repo', issueNumber: 309, issue: undefined, commentLimit: 10 });
    expect(p.status).toBe('missing');
    expect(agent.calls).toHaveLength(0);
  });
});

describe('buildRecord with a planner prediction', () => {
  const history = { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] };

  test('populates planner columns alongside the deterministic baseline', () => {
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 309, { number: 309, ...EASY_ISSUE }, history, 10, OK_PREDICTION);
    expect(record).toMatchObject({
      decision: 'ready',
      complexity: 'low',
      outcomeBucket: 'easy',
      plannerParseStatus: 'ok',
      plannerDecision: 'auto-run',
      plannerComplexity: 'low',
      plannerRecommendedFlow: 'code',
      plannerImplementationEffort: 'low',
      plannerReviewEffort: 'low',
      plannerConfidence: 0.82,
      plannerRequiresHumanGate: false,
    });
    expect(record.plannerRiskSignals).toEqual(['ambiguity(low)']);
  });

  test('a missing planner prediction is recorded explicitly, not as success', () => {
    const missing = { status: 'missing', result: null, arbiterDecision: null, error: 'no artifact', origin: 'none' };
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 309, { number: 309, ...EASY_ISSUE }, history, 10, missing);
    expect(record.plannerParseStatus).toBe('missing');
    expect(record.plannerComplexity).toBeNull();
    expect(record.plannerDecision).toBeNull();
    expect(record.plannerError).toBe('no artifact');
  });

  test('omits all planner columns when no prediction is supplied (deterministic-only default)', () => {
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 309, { number: 309, ...EASY_ISSUE }, history, 10);
    expect(record.plannerParseStatus).toBeUndefined();
    expect(record.plannerComplexity).toBeUndefined();
    expect('plannerParseStatus' in record).toBe(false);
  });

  test('records planner↔heuristic disagreements', () => {
    const pessimistic = {
      status: 'ok',
      result: { ...VALID_PLANNER_RESULT, complexity: 'high', requiresHumanGate: true },
      arbiterDecision: 'human-gate',
      error: null,
      origin: 'artifact',
    };
    const record = buildRecord('addon-dev', 'm2dw/demo-repo', 309, { number: 309, ...EASY_ISSUE }, history, 10, pessimistic);
    expect(record.plannerVsHeuristicDisagreements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('complexity: heuristic=low planner=high'),
        expect.stringContaining('gate:'),
      ]),
    );
  });
});

describe('computePlannerDisagreements', () => {
  test('reports guard conflicts the planner self-reported', () => {
    const prediction = {
      status: 'ok',
      arbiterDecision: 'blocked',
      result: { ...VALID_PLANNER_RESULT, guardConflicts: [{ guard: 'blocked-by-dependency', guardValue: 'blocked', plannerValue: 'advance', note: 'n' }] },
    };
    const out = computePlannerDisagreements('blocked', 'low', 'low', 'low', 'code', prediction);
    expect(out.some((d) => d.includes('guardConflict: blocked-by-dependency'))).toBe(true);
  });

  test('surfaces the arbiter-recomputed guard conflict even when the planner self-report is empty', () => {
    const prediction = {
      status: 'ok',
      arbiterDecision: 'blocked',
      arbiterGuardConflicts: [{ guard: 'blocked-by-dependency', guardValue: 'blocked', plannerValue: 'advance', note: 'n' }],
      // Planner failed to acknowledge the hard guard in its own array.
      result: { ...VALID_PLANNER_RESULT, guardConflicts: [] },
    };
    const out = computePlannerDisagreements('blocked', 'low', 'low', 'low', 'code', prediction);
    expect(out.some((d) => d.includes('guardConflict: blocked-by-dependency'))).toBe(true);
  });

  test('does not duplicate a guard conflict reported by both arbiter and planner', () => {
    const conflict = { guard: 'blocked-by-dependency', guardValue: 'blocked', plannerValue: 'advance', note: 'n' };
    const prediction = {
      status: 'ok',
      arbiterDecision: 'blocked',
      arbiterGuardConflicts: [conflict],
      result: { ...VALID_PLANNER_RESULT, guardConflicts: [conflict] },
    };
    const out = computePlannerDisagreements('blocked', 'low', 'low', 'low', 'code', prediction);
    expect(out.filter((d) => d.includes('guardConflict: blocked-by-dependency'))).toHaveLength(1);
  });

  test('returns nothing when there is no valid plan', () => {
    expect(computePlannerDisagreements('ready', 'low', 'low', 'low', 'code', { status: 'missing', result: null, arbiterDecision: null })).toEqual([]);
  });
});

describe('planner-aware renderers', () => {
  const recOk = buildRecord('addon-dev', 'm2dw/demo-repo', 309, { number: 309, ...EASY_ISSUE },
    { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] }, 10, OK_PREDICTION);
  const recNoPlanner = buildRecord('addon-dev', 'm2dw/demo-repo', 311, { number: 311, ...EASY_ISSUE },
    { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] }, 10);

  test('hasPlannerPredictions detects planner columns', () => {
    expect(hasPlannerPredictions([recOk])).toBe(true);
    expect(hasPlannerPredictions([recNoPlanner])).toBe(false);
  });

  test('renderCsv appends planner columns only when present', () => {
    expect(renderCsv([recOk]).split('\n')[0]).toContain('plannerParseStatus');
    expect(renderCsv([recNoPlanner]).split('\n')[0]).not.toContain('plannerParseStatus');
  });

  test('renderPlannerSection is empty without planner predictions', () => {
    expect(renderPlannerSection([recNoPlanner])).toEqual([]);
  });

  test('renderSummaryMarkdown includes the planner comparison block when present', () => {
    const md = renderSummaryMarkdown('addon-dev', 'm2dw/demo-repo', [recOk], '2026-06-25T00:00:00Z');
    expect(md).toContain('## AI Planner vs. heuristic vs. outcome');
    expect(md).toContain('Planner ↔ outcome candidates');
  });

  test('renderSummaryMarkdown notes issues with no usable planner prediction', () => {
    const recMissing = buildRecord('addon-dev', 'm2dw/demo-repo', 312, { number: 312, ...EASY_ISSUE },
      { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] }, 10,
      { status: 'missing', result: null, arbiterDecision: null, error: 'no artifact', origin: 'none' });
    const md = renderSummaryMarkdown('addon-dev', 'm2dw/demo-repo', [recMissing], '2026-06-25T00:00:00Z');
    expect(md).toContain('no usable planner prediction');
    expect(md).toContain('#312 (missing)');
  });

  test('derivePlannerCandidates flags an escalating planner against an easy outcome', () => {
    const fp = buildRecord('addon-dev', 'm2dw/demo-repo', 400, { number: 400, ...EASY_ISSUE },
      { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] }, 10,
      { status: 'ok', result: { ...VALID_PLANNER_RESULT, complexity: 'xhigh', requiresHumanGate: true }, arbiterDecision: 'human-gate', error: null, origin: 'artifact' });
    const cand = derivePlannerCandidates([fp]);
    expect(cand.falsePositives.map((r) => r.issueNumber)).toEqual([400]);
  });

  // A hard outcome the arbiter gated (human-gate/split/blocked) is NOT a planner
  // false negative, even when the plan self-reported requiresHumanGate=false at
  // low complexity — the accepted policy decision did not auto-run (issue #359).
  const HARD_HISTORY = { task: { status: 'ready_for_human', phase: 'review', attempts: { implementation: 4, review: 5 }, context: { reviewLoopCapReached: true }, updatedAt: 't' }, events: [], comments: [] };

  test('derivePlannerCandidates does not score a gated plan as a false negative', () => {
    const gated = buildRecord('addon-dev', 'm2dw/demo-repo', 401, { number: 401, ...EASY_ISSUE }, HARD_HISTORY, 10,
      { status: 'ok', result: { ...VALID_PLANNER_RESULT, complexity: 'low', requiresHumanGate: false }, arbiterDecision: 'human-gate', error: null, origin: 'artifact' });
    expect(gated.outcomeBucket).toBe('hard');
    expect(gated.calibrationEligible).toBe(true);
    expect(derivePlannerCandidates([gated]).falseNegatives).toEqual([]);
  });

  test('derivePlannerCandidates scores an auto-run plan against a hard outcome as a false negative', () => {
    const optimistic = buildRecord('addon-dev', 'm2dw/demo-repo', 402, { number: 402, ...EASY_ISSUE }, HARD_HISTORY, 10,
      { status: 'ok', result: { ...VALID_PLANNER_RESULT, complexity: 'low', requiresHumanGate: false }, arbiterDecision: 'auto-run', error: null, origin: 'artifact' });
    expect(derivePlannerCandidates([optimistic]).falseNegatives.map((r) => r.issueNumber)).toEqual([402]);
  });

  test('renderCalibrationPrompt describes planner fields and never scores missing as correct', () => {
    const prompt = renderCalibrationPrompt('m2dw/demo-repo', [recOk]);
    expect(prompt).toContain('AI Planner comparison (issue #359)');
    expect(prompt).toContain('NEVER score `missing`');
  });
});

describe('runEvaluateHistory with a planner source', () => {
  test('artifact mode joins baseline, planner prediction, and outcome side by side', async () => {
    const reader = makeReader({ 309: EASY_ISSUE, 311: { ...EASY_ISSUE, title: 'Second' } });
    const store = makeHistoryStore({
      309: { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] },
      311: { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] },
    });
    // 309 has a planner prediction; 311 does not (missing artifact).
    const plannerSource = makePlannerSource({
      309: OK_PREDICTION,
      311: { status: 'missing', result: null, arbiterDecision: null, error: 'no artifact', origin: 'none' },
    });
    const args = parseEvaluateHistoryArgs(['--session-id', 'addon-dev', '--issues', '309,311', '--planner-mode', 'artifact', '--sessions-path', sessionsPath]);
    const out = await capture(() => runEvaluateHistory(args, reader, store, plannerSource));

    expect(out.plannerMode).toBe('artifact');
    expect(out.plannerSummary.statusCounts).toMatchObject({ ok: 1, missing: 1 });
    // Injected source is owned by the caller and must not be closed.
    expect(plannerSource.closed).toBe(false);

    const jsonl = readFileSync(out.artifacts.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(jsonl[0]).toMatchObject({ issueNumber: 309, decision: 'ready', outcomeBucket: 'easy', plannerParseStatus: 'ok', plannerDecision: 'auto-run', plannerComplexity: 'low' });
    expect(jsonl[1]).toMatchObject({ issueNumber: 311, plannerParseStatus: 'missing', plannerComplexity: null });
  });

  test('default (off) mode emits no planner columns', async () => {
    const reader = makeReader({ 309: EASY_ISSUE });
    const store = makeHistoryStore({ 309: { events: [], comments: [] } });
    const args = parseEvaluateHistoryArgs(['--session-id', 'addon-dev', '--issues', '309', '--sessions-path', sessionsPath]);
    const out = await capture(() => runEvaluateHistory(args, reader, store));
    expect(out.plannerMode).toBe('off');
    expect(out.plannerSummary).toBeNull();
    const jsonl = readFileSync(out.artifacts.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect('plannerParseStatus' in jsonl[0]).toBe(false);
  });

  test('artifact mode reads a real ai-preview artifact under the session artifact root', async () => {
    const reader = makeReader({ 309: EASY_ISSUE });
    const store = makeHistoryStore({ 309: { task: { status: 'done', phase: 'review', attempts: { implementation: 1, review: 1 }, context: {}, updatedAt: 't' }, events: [], comments: [] } });
    // artifactRoot = <repoRoot>/.n8n-artifacts (resolved from sessions.json).
    const dir = join(repoRoot, '.n8n-artifacts', 'issue-plan', 'issue-309');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ai-planner-context.json'), JSON.stringify(makeContextArtifact()));
    const args = parseEvaluateHistoryArgs(['--session-id', 'addon-dev', '--issues', '309', '--planner-mode', 'artifact', '--sessions-path', sessionsPath]);
    const out = await capture(() => runEvaluateHistory(args, reader, store));
    expect(out.plannerSummary.statusCounts.ok).toBe(1);
    const jsonl = readFileSync(out.artifacts.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(jsonl[0]).toMatchObject({ plannerParseStatus: 'ok', plannerComplexity: 'low' });
  });

  test('a planner-source failure for one issue is recorded, not fatal', async () => {
    const reader = makeReader({ 309: EASY_ISSUE });
    const store = makeHistoryStore({ 309: { events: [], comments: [] } });
    const plannerSource = {
      closed: false,
      readPlanner() { throw new Error('source exploded'); },
      close() { this.closed = true; },
    };
    const args = parseEvaluateHistoryArgs(['--session-id', 'addon-dev', '--issues', '309', '--planner-mode', 'artifact', '--sessions-path', sessionsPath]);
    const out = await capture(() => runEvaluateHistory(args, reader, store, plannerSource));
    const jsonl = readFileSync(out.artifacts.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(jsonl[0].plannerParseStatus).toBe('invalid_output');
    expect(jsonl[0].plannerError).toContain('source exploded');
  });
});

describe('parseEvaluateHistoryArgs — planner flags', () => {
  test('defaults planner-mode to off', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1']).plannerMode).toBe('off');
  });

  test('accepts artifact and live planner modes', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1', '--planner-mode', 'artifact']).plannerMode).toBe('artifact');
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1', '--planner-mode', 'live']).plannerMode).toBe('live');
  });

  test('rejects an unknown planner-mode', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1', '--planner-mode', 'bogus'])).toMatchObject({ error: expect.stringContaining('planner-mode') });
  });

  test('rejects an unknown planner-agent', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1', '--planner-agent', 'bogus'])).toMatchObject({ error: expect.stringContaining('planner-agent') });
  });

  test('clamps the planner timeout to the max', () => {
    expect(parseEvaluateHistoryArgs(['--session-id', 'a', '--issues', '1', '--timeout', '99999999']).timeoutMs).toBe(600000);
  });
});
