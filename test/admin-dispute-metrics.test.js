/**
 * `admin dispute metrics` (issue #849; docs/review-dispute-operations.md,
 * docs/admin-cli-contract.md).
 *
 * The report is the operator's only aggregate view of the protocol, so what
 * matters here is not the arithmetic — test/review-dispute-metrics.test.js pins
 * that against the real transition layer — but the CLI contract around it:
 *
 *  - human-readable by default, stable JSON with `--json`, both from ONE
 *    projection;
 *  - session-scoped through the shared selector, optionally narrowed to one
 *    issue and one time window;
 *  - read-only: running it twice changes no task, no event, and no outbox row;
 *  - offline: it never resolves a repo host and never needs a network call;
 *  - a bad window bound is refused rather than silently reinterpreted.
 */
import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/index.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { applyDisputeTransition } from '../dist/core/review-dispute-transition.js';
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
} from '../dist/core/review-dispute-commit.js';

jest.setTimeout(30_000);

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const SESSION = 'metrics-cli-session';
const BOUNDARY = 'src/auth/handler.ts';
const ARGUMENT = 'The null session is already rejected by the middleware, so the cited crash cannot occur.';
const NOW = '2026-08-06T12:00:00.000Z';

let tmpDir;
let dbPath;
let sessionsPath;

function run(...args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }), stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function metrics(...args) {
  return run('dispute', 'metrics', '--session-id', SESSION, '--db-path', dbPath, '--sessions-path', sessionsPath, ...args);
}

function writeSessions() {
  writeFileSync(
    sessionsPath,
    JSON.stringify({
      sessions: [
        {
          sessionId: SESSION,
          repoKey: 'test-repo',
          repoRoot: tmpDir,
          githubRepo: 'org/repo',
          artifactDir: '.n8n-artifacts',
          baseBranch: 'main',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: { test: 'npm test' },
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
          reviewDispute: { enabled: true },
        },
      ],
    }),
  );
}

function lineage(id, overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: id,
    state: 'open',
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, ...counterOverrides },
    rebuttedVersions: [],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
    ...rest,
  };
}

function context(lineages) {
  return { version: 1, reviewStructure: 'structured', lineages };
}

function record(id, disposition) {
  if (disposition === 'fixed') return { lineageId: id, version: 1, disposition: 'fixed', note: 'Added the guard.' };
  if (disposition === 'blocked') {
    return { lineageId: id, version: 1, disposition: 'blocked', note: 'Needs a credential automation cannot supply.' };
  }
  return {
    lineageId: id,
    version: 1,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId: id, version: 1 },
      rebuttalReason: 'false_premise',
      argument: ARGUMENT,
      evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 30, endLine: 36 }],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
  };
}

/** One committed transition, built by the real pipeline and committed durably. */
async function seedTask(store, { issueNumber, lineageId, disposition, diff, at = NOW }) {
  const ctx = context({ [lineageId]: lineage(lineageId) });
  await store.enqueueTask({
    sessionId: SESSION,
    issueNumber,
    phase: 'implementation',
    priority: 'normal',
    context: { [REVIEW_DISPUTE_CONTEXT_KEY]: ctx },
    now: '2026-08-06T11:00:00.000Z',
  });
  const records = [record(lineageId, disposition)];
  const outcome = parseFixDispositionResponse({
    response: `\`\`\`json\n${JSON.stringify(records)}\n\`\`\``,
    findings: Object.values(ctx.lineages).map((l) => ({
      lineageId: l.lineageId,
      version: l.version,
      state: l.state,
      severity: l.severity,
      affectedBoundary: l.affectedBoundary,
      allowedDispositions: ['fixed', 'review_disputed', 'blocked'],
    })),
    lineages: ctx.lineages,
    reviewStructure: ctx.reviewStructure,
    runProducedFileChanges: diff,
    resolveEvidenceRef: () => true,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
  const persisted = persistFixDisputes({
    context: ctx,
    outcome,
    run: { runId: `run-${issueNumber}`, agentId: 'claude', timestamp: at },
    runProducedFileChanges: diff,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
  if (!persisted.ok) throw new Error(`fixture not persisted: ${JSON.stringify(persisted.failure)}`);
  const application = applyDisputeTransition({
    context: ctx,
    decision: { kind: 'dispositions', persistence: persisted.value, outcome, runProducedFileChanges: diff },
    run: { runId: `run-${issueNumber}`, actor: 'implementer' },
  });
  if (!application.ok) throw new Error(`transition failed: ${JSON.stringify(application.failure)}`);
  const patched = await store.transitionTask(
    { sessionId: SESSION, issueNumber },
    { status: 'queued' },
    { status: 'ready_for_human', context: { [REVIEW_DISPUTE_CONTEXT_KEY]: application.value.context }, now: at },
  );
  if (!patched.ok) throw new Error(`seed transition failed: ${patched.code}`);
  await store.appendEvent({
    task: { sessionId: SESSION, issueNumber },
    type: REVIEW_DISPUTE_TRANSITION_EVENT,
    runId: `run-${issueNumber}`,
    data: application.value.event,
    createdAt: at,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dispute-metrics-cli-'));
  dbPath = join(tmpDir, 'test.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function withStore(fn) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

describe('admin dispute metrics — output modes', () => {
  test('defaults to human-readable text and reports every group', async () => {
    await withStore(async (store) => {
      await seedTask(store, { issueNumber: 1, lineageId: 'ln-aaaaaaaaaaaa', disposition: 'fixed', diff: true });
      await seedTask(store, { issueNumber: 2, lineageId: 'ln-bbbbbbbbbbbb', disposition: 'blocked', diff: true });
      await seedTask(store, { issueNumber: 3, lineageId: 'ln-cccccccccccc', disposition: 'review_disputed', diff: false });
    });

    const r = metrics();
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).toThrow();
    expect(r.stdout).toContain('Review-dispute metrics');
    expect(r.stdout).toContain(`session ${SESSION}`);
    expect(r.stdout).toContain('window: all recorded events');
    expect(r.stdout).toContain('tasks scanned: 3');
    expect(r.stdout).toContain('rebuttals: recorded=1');
    expect(r.stdout).toContain('resolved_fixed: 1');
    expect(r.stdout).toContain('escalated_human: 1');
    expect(r.stdout).toContain('human escalations: 1');
    // The proxy is labelled as observed, never as a saving.
    expect(r.stdout).toContain('lineagesResolvedWithoutHuman: 1');
    expect(r.stdout).toContain('not a claim about review loops that would otherwise have run');
  });

  test('--json emits the stable machine payload with a closed shape', async () => {
    await withStore(async (store) => {
      await seedTask(store, { issueNumber: 1, lineageId: 'ln-aaaaaaaaaaaa', disposition: 'fixed', diff: true });
    });

    const parsed = JSON.parse(metrics('--json').stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.sessionId).toBe(SESSION);
    expect(parsed).not.toHaveProperty('issueNumber');
    const m = parsed.metrics;
    expect(m.window).toEqual({ from: null, to: null });
    expect(Object.keys(m.terminalOutcomes).sort()).toEqual(
      ['escalated_human', 'resolved_fixed', 'resolved_overruled', 'resolved_withdrawn'],
    );
    expect(m.terminalOutcomes.resolved_fixed).toBe(1);
    expect(m.terminalOutcomes.resolved_overruled).toBe(0);
    expect(m.revisions).toEqual({ material: 0, nonMaterial: 0, ambiguous: 0 });
    expect(m.arbitration).toEqual({ verdicts: 0, malformedAttempts: 0 });
    expect(m.evidence).toEqual({ requested: 0, recorded: 0 });
    // Nothing local, nothing prose-shaped, no identifier that is not a literal.
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(ARGUMENT);
    expect(serialized).not.toContain(tmpDir);
  });

  test('a session with no dispute activity reports zeros and says why', async () => {
    await withStore(async (store) => {
      await store.enqueueTask({
        sessionId: SESSION,
        issueNumber: 7,
        phase: 'implementation',
        priority: 'normal',
        context: { reviewFeedback: 'legacy prose' },
        now: NOW,
      });
    });

    const human = metrics();
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('tasks scanned: 1');
    expect(human.stdout).toContain('session.reviewDispute.enabled defaults to false');

    const m = JSON.parse(metrics('--json').stdout.trim()).metrics;
    expect(m.transitionEvents).toBe(0);
    expect(m.tasksWithDisputeActivity).toBe(0);
    expect(m.lineagesResolvedWithoutHuman).toBe(0);
  });
});

describe('admin dispute metrics — scoping', () => {
  test('--issue-number narrows the report to one task', async () => {
    await withStore(async (store) => {
      await seedTask(store, { issueNumber: 1, lineageId: 'ln-aaaaaaaaaaaa', disposition: 'fixed', diff: true });
      await seedTask(store, { issueNumber: 2, lineageId: 'ln-bbbbbbbbbbbb', disposition: 'blocked', diff: true });
    });

    const parsed = JSON.parse(metrics('--issue-number', '2', '--json').stdout.trim());
    expect(parsed.issueNumber).toBe(2);
    expect(parsed.metrics.tasksScanned).toBe(1);
    expect(parsed.metrics.terminalOutcomes.escalated_human).toBe(1);
    expect(parsed.metrics.terminalOutcomes.resolved_fixed).toBe(0);
    expect(metrics('--issue-number', '2').stdout).toContain('issue #2');
  });

  test('an issue with no task at all is an empty report, not an error', async () => {
    await withStore(async (store) => {
      await seedTask(store, { issueNumber: 1, lineageId: 'ln-aaaaaaaaaaaa', disposition: 'fixed', diff: true });
    });
    const parsed = JSON.parse(metrics('--issue-number', '99', '--json').stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.metrics.tasksScanned).toBe(0);
    expect(parsed.metrics.transitionEvents).toBe(0);
  });

  test('a bounded window filters by the event timestamp', async () => {
    await withStore(async (store) => {
      await seedTask(store, {
        issueNumber: 1, lineageId: 'ln-aaaaaaaaaaaa', disposition: 'fixed', diff: true, at: '2026-08-01T09:00:00.000Z',
      });
      await seedTask(store, {
        issueNumber: 2, lineageId: 'ln-bbbbbbbbbbbb', disposition: 'blocked', diff: true, at: '2026-08-05T09:00:00.000Z',
      });
    });

    const late = JSON.parse(metrics('--since', '2026-08-04T00:00:00Z', '--json').stdout.trim()).metrics;
    // Normalized to the store's millisecond form, so a bound landing on an
    // event's exact second includes it rather than sorting just below it.
    expect(late.window).toEqual({ from: '2026-08-04T00:00:00.000Z', to: null });
    expect(late.transitionEvents).toBe(1);
    expect(late.terminalOutcomes.escalated_human).toBe(1);
    expect(late.terminalOutcomes.resolved_fixed).toBe(0);
    // Both tasks are still SCANNED — the window bounds the events, not the
    // denominator.
    expect(late.tasksScanned).toBe(2);

    const early = JSON.parse(metrics('--until', '2026-08-04T00:00:00Z', '--json').stdout.trim()).metrics;
    expect(early.transitionEvents).toBe(1);
    expect(early.terminalOutcomes.resolved_fixed).toBe(1);

    expect(metrics('--since', '2026-08-04T00:00:00Z').stdout).toContain('2026-08-04T00:00:00.000Z .. (open)');

    // The boundary the normalization exists for: a bound naming exactly the
    // second an event landed on includes that event.
    const boundary = JSON.parse(metrics('--since', '2026-08-05T09:00:00Z', '--json').stdout.trim()).metrics;
    expect(boundary.transitionEvents).toBe(1);
  });
});

describe('admin dispute metrics — refusals and safety', () => {
  test('a non-UTC or unparseable window bound is refused, never reinterpreted', () => {
    for (const bad of ['yesterday', '2026-08-04', '2026-08-04T00:00:00+09:00', '2026-13-01T00:00:00Z']) {
      const r = metrics('--since', bad, '--json');
      expect(r.code).not.toBe(0);
      expect(JSON.parse(r.stdout.trim()).error).toContain('--since');
    }
  });

  test('a well-formed but impossible calendar date is refused, not rolled forward', () => {
    // `Date.parse` accepts these and silently rolls the overflow into the next
    // month, which would report on a window the operator never asked for.
    for (const [bad, wouldBe] of [
      ['2026-02-31T00:00:00Z', '2026-03-03'],
      ['2026-04-31T00:00:00Z', '2026-05-01'],
      ['2025-02-29T00:00:00Z', '2025-03-01'],
    ]) {
      const r = metrics('--since', bad, '--json');
      expect(r.code).not.toBe(0);
      const { error } = JSON.parse(r.stdout.trim());
      expect(error).toContain('--since');
      expect(error).toContain(bad);
      expect(error).toContain(wouldBe);
    }
    // The leap day that DOES exist is still accepted.
    const ok = metrics('--until', '2028-02-29T00:00:00Z', '--json');
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout.trim()).metrics.window.to).toBe('2028-02-29T00:00:00.000Z');
  });

  test('an inverted window is refused', () => {
    const r = metrics('--since', '2026-08-05T00:00:00Z', '--until', '2026-08-01T00:00:00Z', '--json');
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).error).toMatch(/must not be later than/);
  });

  test('a session selector is required, and an unknown flag is a typo not a filter', () => {
    const noSession = run('dispute', 'metrics', '--db-path', dbPath, '--json');
    expect(noSession.code).not.toBe(0);
    expect(JSON.parse(noSession.stdout.trim()).error).toMatch(/--session-id or --session-ref/);

    const typo = metrics('--sinse', '2026-08-04T00:00:00Z', '--json');
    expect(typo.code).not.toBe(0);
  });

  test('an unknown dispute action names every supported one', () => {
    const r = run('dispute', 'summarise', '--json');
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).error).toContain('status | reopen | metrics');
  });

  test('the report is read-only: two runs change no task, event, or lineage', async () => {
    await withStore(async (store) => {
      await seedTask(store, { issueNumber: 1, lineageId: 'ln-aaaaaaaaaaaa', disposition: 'review_disputed', diff: false });
    });

    let before;
    await withStore(async (store) => {
      before = {
        task: await store.getTask({ sessionId: SESSION, issueNumber: 1 }),
        events: await store.listEvents({ sessionId: SESSION, issueNumber: 1 }),
      };
    });

    const first = metrics('--json').stdout;
    const second = metrics('--json').stdout;
    expect(second).toBe(first);

    await withStore(async (store) => {
      const task = await store.getTask({ sessionId: SESSION, issueNumber: 1 });
      const events = await store.listEvents({ sessionId: SESSION, issueNumber: 1 });
      expect(task).toEqual(before.task);
      expect(events).toEqual(before.events);
      expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(1);
    });
  });

  test('the command appears in help, with its read-only posture stated', () => {
    const help = run('help', 'dispute', 'metrics');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('dispute metrics');
    expect(help.stdout).toContain('--since');
    expect(help.stdout).toContain('Read-only and offline');
  });
});
