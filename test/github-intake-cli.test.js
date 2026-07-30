import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteContextStore, SqliteOutboxStore } from '../dist/index.js';
import { GraphQLDependencyChecker, runIntake } from '../dist/cli/github-intake.js';

const CLI = new URL('../dist/cli/github-intake.js', import.meta.url).pathname;

const SESSION = {
  sessionId: 'addon-dev',
  repoKey: 'thunderbird-auth-results-filter',
  repoRoot: '/Users/moto/git/thunderbird-auth-results-filter',
  githubRepo: 'm2dw/thunderbird-auth-results-filter',
  artifactDir: '.n8n-artifacts',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
};

const FAKE_ISSUES = [
  {
    number: 101,
    title: 'Implement feature A',
    url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/101',
    labels: [{ name: 'agent:claude' }, { name: 'status:needs-implementation' }],
    body: 'Feature A should add a rate limiter to the login endpoint.',
  },
  {
    number: 102,
    title: 'Review PR for B',
    url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/102',
    labels: [{ name: 'agent:codex' }, { name: 'status:needs-review' }],
  },
  {
    number: 103,
    title: 'Unrelated bug',
    url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/103',
    labels: [{ name: 'bug' }],
  },
];

const fakeGh = {
  listIssues: () => FAKE_ISSUES,
};

const failingGh = {
  listIssues: () => { throw new Error('gh: authentication failed'); },
};

/** No-op dep checker: no issue is blocked. */
const noBlockerChecker = {
  getBlockedBy: async () => [],
};

/** Blocks the given issue numbers with an open upstream issue. */
function openBlockerChecker(blockedNums) {
  return {
    getBlockedBy: async (n) =>
      blockedNums.includes(n) ? [{ issueNumber: 99, state: 'open' }] : [],
  };
}

let tmpDir;
let sessionsPath;
let dbPath;

function baseCliArgs() {
  return ['--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath];
}

function runCli(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'github-intake-test-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [SESSION] }), 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLI arg validation (subprocess)
// ---------------------------------------------------------------------------

describe('github-intake CLI — arg validation', () => {
  test('missing --session-id and --context-id exits non-zero', () => {
    const r = runCli('--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--context-id or --session-id is required') });
  });

  test('invalid --limit exits non-zero', () => {
    const r = runCli(...baseCliArgs(), '--limit', '0');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--limit') });
  });
});

// ---------------------------------------------------------------------------
// Config errors (subprocess)
// ---------------------------------------------------------------------------

describe('github-intake CLI — config errors', () => {
  test('missing sessions file exits non-zero', () => {
    const r = runCli('--session-id', 'addon-dev', '--sessions-path', join(tmpDir, 'nope.json'), '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false });
  });

  test('unknown sessionId exits non-zero', () => {
    const r = runCli('--session-id', 'no-such', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no-such') });
  });
});

// ---------------------------------------------------------------------------
// Intake logic (fake gh runner + mock dep checker, in-process)
// ---------------------------------------------------------------------------

describe('github-intake — contextId passthrough', () => {
  test('includes contextId in output when provided', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'], contextId: 'exec-42' };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    try {
      await runIntake(args, fakeGh, noBlockerChecker);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: true, contextId: 'exec-42' });
  });

  test('omits contextId from output when not provided', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    try {
      await runIntake(args, fakeGh, noBlockerChecker);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out.contextId).toBeUndefined();
  });
});

describe('github-intake — successful intake', () => {
  test('enqueues matching issues and skips non-matching', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    try {
      await runIntake(args, fakeGh, noBlockerChecker);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({
      ok: true,
      sessionId: 'addon-dev',
      scanned: 3,
      candidates: 2,
      enqueued: 2,
      alreadyExists: 0,
      dryRun: false,
    });
  });

  test('enqueued tasks are visible via SqliteTaskStore.getTask', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      await runIntake(args, fakeGh, noBlockerChecker);
    } finally {
      process.stdout.write = origWrite;
    }

    const store = new SqliteTaskStore(dbPath);
    const task101 = await store.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    const task102 = await store.getTask({ sessionId: 'addon-dev', issueNumber: 102 });
    store.close();

    expect(task101).toMatchObject({ status: 'queued', phase: 'implementation' });
    expect(task101?.context).toMatchObject({
      title: 'Implement feature A',
      body: 'Feature A should add a rate limiter to the login endpoint.',
    });
    expect(task102).toMatchObject({ status: 'queued', phase: 'review' });
    // Issue 102 has no body, so the context omits the field entirely.
    expect(task102?.context?.body).toBeUndefined();
  });

  test('duplicate intake reports alreadyExists and does not throw', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    try {
      await runIntake(args, fakeGh, noBlockerChecker);
      chunks.length = 0;
      await runIntake(args, fakeGh, noBlockerChecker);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: true, enqueued: 0, alreadyExists: 2 });
  });

  test('enqueued task context includes dependencyDecision snapshot', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      await runIntake(args, fakeGh, noBlockerChecker);
    } finally {
      process.stdout.write = origWrite;
    }

    const store = new SqliteTaskStore(dbPath);
    const task101 = await store.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    store.close();

    expect(task101?.context?.dependencyDecision).toMatchObject({
      source: 'github-relationships',
      blocked: false,
      blockedBy: [],
    });
    expect(typeof task101?.context?.dependencyDecision?.checkedAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Dependency gate — blocked issues are skipped
// ---------------------------------------------------------------------------

describe('github-intake — dependency gate (GitHub Issue Relationships)', () => {
  test('skips a blocked review issue but enqueues the unblocked sibling', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    // Issue 102 (review lane) is blocked — non-stackable, so it stays held.
    // Issue 101 (new-implementation) is unblocked and enqueues normally.
    try {
      await runIntake(args, fakeGh, openBlockerChecker([102]));
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: true, candidates: 1, enqueued: 1 });
    expect(out.results[0].issueNumber).toBe(101);
  });

  test('enqueues a new-implementation issue with one stack-ready open blocker (Gate 2 stackable)', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    // Issue 101 (new-implementation) has a single open blocker the resolver
    // confirms is stack-ready → enqueued so the implementation handler can stack
    // it on the blocker PR. Issue 102 (review) is unblocked and enqueues as usual.
    try {
      await runIntake(args, fakeGh, openBlockerChecker([101]), async () => true);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: true, candidates: 2, enqueued: 2 });
    const enqueued101 = out.results.find((r) => r.issueNumber === 101);
    expect(enqueued101).toMatchObject({ action: 'enqueued', phase: 'implementation' });
  });

  test('holds a Gate 2 stackable issue whose blocker is not yet stack-ready', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    // Issue 101's blocker has no usable PR head yet → held at intake (not enqueued)
    // so it is not removed from automation by a terminal implementation `blocked`.
    // Issue 102 (review) is unblocked and still enqueues.
    try {
      await runIntake(args, fakeGh, openBlockerChecker([101]), async () => false);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: true, candidates: 1, enqueued: 1 });
    expect(out.results.find((r) => r.issueNumber === 101)).toBeUndefined();
    expect(out.results.find((r) => r.issueNumber === 102)).toMatchObject({ action: 'enqueued' });
  });

  test('skips all issues when none are stackable (multiple blockers / blocked review)', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };
    // Issue 101 (new-impl) has TWO open blockers → unsupported, held.
    // Issue 102 (review) has one open blocker → non-stackable, held.
    const checker = {
      getBlockedBy: async (n) => {
        if (n === 101) return [{ issueNumber: 98, state: 'open' }, { issueNumber: 99, state: 'open' }];
        if (n === 102) return [{ issueNumber: 99, state: 'open' }];
        return [];
      },
    };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    try {
      await runIntake(args, fakeGh, checker);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: true, candidates: 0, enqueued: 0 });
  });

  test('does not skip issue when all blockers are closed', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    const closedChecker = {
      getBlockedBy: async () => [{ issueNumber: 50, state: 'closed' }],
    };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    try {
      await runIntake(args, fakeGh, closedChecker);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: true, candidates: 1, enqueued: 1 });
  });
});

describe('GraphQLDependencyChecker', () => {
  test('queries the GitHub blockedBy field and maps blocker states', async () => {
    let capturedArgs;
    const runGh = (args) => {
      capturedArgs = args;
      return JSON.stringify({
        data: {
          repository: {
            issue: {
              blockedBy: {
                nodes: [
                  { number: 111, state: 'CLOSED' },
                  { number: 120, state: 'OPEN' },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    };

    const checker = new GraphQLDependencyChecker('m2dw/n8n-ai-cli-loop', runGh);
    await expect(checker.getBlockedBy(112)).resolves.toEqual([
      { issueNumber: 111, state: 'closed' },
      { issueNumber: 120, state: 'open' },
    ]);

    const args = capturedArgs;
    const queryArg = args.find((arg) => typeof arg === 'string' && arg.startsWith('query='));
    expect(queryArg).toContain('blockedBy(first: 50, after: $after)');
    expect(queryArg).toContain('stateReason');
    expect(queryArg).not.toContain('issueRelationships');
    expect(args).toContain('owner=m2dw');
    expect(args).toContain('name=n8n-ai-cli-loop');
    expect(args).toContain('number=112');
  });

  test('maps stateReason for closed blockers', async () => {
    const runGh = () =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              blockedBy: {
                nodes: [
                  { number: 10, state: 'CLOSED', stateReason: 'NOT_PLANNED' },
                  { number: 11, state: 'CLOSED', stateReason: 'COMPLETED' },
                  { number: 12, state: 'CLOSED', stateReason: null },
                  { number: 13, state: 'OPEN' },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });

    const checker = new GraphQLDependencyChecker('m2dw/n8n-ai-cli-loop', runGh);
    await expect(checker.getBlockedBy(99)).resolves.toEqual([
      { issueNumber: 10, state: 'closed', stateReason: 'not_planned' },
      { issueNumber: 11, state: 'closed', stateReason: 'completed' },
      { issueNumber: 12, state: 'closed', stateReason: null },
      { issueNumber: 13, state: 'open' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

describe('github-intake — dry-run', () => {
  test('--dry-run reports candidates but does not write to SQLite', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: true, supportedPhases: ['implementation', 'review'] };

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    try {
      await runIntake(args, fakeGh, noBlockerChecker);
    } finally {
      process.stdout.write = origWrite;
    }

    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: true, dryRun: true, candidates: 2, enqueued: 0 });
    expect(out.results.every((r) => r.action === 'dry_run')).toBe(true);

    // Nothing should be written to the DB.
    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    store.close();
    expect(task).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// gh failure
// ---------------------------------------------------------------------------

describe('github-intake — gh failure', () => {
  test('gh command failure exits non-zero with JSON error', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false };

    let exitCode = null;
    const origExit = process.exit.bind(process);
    const origWrite = process.stdout.write.bind(process.stdout);
    const chunks = [];

    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    process.exit = (code) => { exitCode = code; throw new Error(`process.exit(${code})`); };

    try {
      await runIntake(args, failingGh, noBlockerChecker);
    } catch {
      // expected — we threw from our process.exit mock
    } finally {
      process.exit = origExit;
      process.stdout.write = origWrite;
    }

    expect(exitCode).toBe(1);
    const out = JSON.parse(chunks.join('').trim());
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('gh') });
  });
});

// FAKE_ISSUES has: 101 (implementation), 102 (review), 103 (bug/no match)
// plus we need a research candidate for phase gating tests
const FAKE_ISSUES_WITH_RESEARCH = [
  ...FAKE_ISSUES,
  {
    number: 104,
    title: 'Investigate perf issue',
    url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/104',
    labels: [{ name: 'agent:gemini' }, { name: 'status:research-needed' }],
  },
];

const fakeGhWithResearch = { listIssues: () => FAKE_ISSUES_WITH_RESEARCH };

describe('github-intake — supported phase gating', () => {
  function captureIntake(args) {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    return runIntake(args, fakeGhWithResearch, noBlockerChecker).finally(() => {
      process.stdout.write = origWrite;
    }).then(() => JSON.parse(chunks.join('').trim()));
  }

  test('default supportedPhases enqueues only research', async () => {
    const out = await captureIntake({ sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['research'] });
    expect(out).toMatchObject({ ok: true, supportedPhases: ['research'], candidates: 1, enqueued: 1 });
    expect(out.results.every((r) => r.phase === 'research')).toBe(true);
  });

  test('supportedPhases research,review enqueues both phases only', async () => {
    const out = await captureIntake({ sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['research', 'review'] });
    expect(out).toMatchObject({ ok: true, candidates: 2 });
    const phases = out.results.map((r) => r.phase);
    expect(phases).toContain('research');
    expect(phases).toContain('review');
    expect(phases).not.toContain('implementation');
  });

  test('duplicate intake with supportedPhases is idempotent', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['research'] };
    await captureIntake(args);
    const out = await captureIntake(args);
    expect(out).toMatchObject({ ok: true, enqueued: 0, alreadyExists: 1 });
  });

  test('invalid --supported-phases exits non-zero via CLI', () => {
    const r = runCli(...baseCliArgs(), '--supported-phases', 'bogus');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });
});

describe('github-intake — report-only rollout mode (issue #532)', () => {
  function writeReportOnlySession() {
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [{ ...SESSION, reportOnly: { enabled: true } }] }), 'utf8');
  }

  function captureIntake(args) {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    return runIntake(args, fakeGh, noBlockerChecker).finally(() => {
      process.stdout.write = origWrite;
    }).then(() => JSON.parse(chunks.join('').trim()));
  }

  // FAKE_ISSUES: 101 -> implementation, 102 -> review, 103 -> no match.
  test('defers the implementation candidate instead of enqueuing it, and still enqueues review', async () => {
    writeReportOnlySession();
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const out = await captureIntake(args);
    expect(out).toMatchObject({ ok: true, reportOnly: true, reportOnlyDeferred: 1, candidates: 2, enqueued: 1 });

    const deferred = out.results.find((r) => r.issueNumber === 101);
    expect(deferred).toMatchObject({ action: 'report_only_deferred', phase: 'implementation' });
    expect(deferred.message).toMatch(/report-only mode/i);
    expect(deferred.message).toMatch(/issue #101/);

    const enqueued = out.results.find((r) => r.issueNumber === 102);
    expect(enqueued).toMatchObject({ action: 'enqueued', phase: 'review' });

    const store = new SqliteTaskStore(dbPath);
    const implTask = await store.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    const reviewTask = await store.getTask({ sessionId: 'addon-dev', issueNumber: 102 });
    store.close();
    expect(implTask).toBeUndefined();
    expect(reviewTask).toBeDefined();
  });

  test('a session without reportOnly enqueues the implementation candidate normally', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const out = await captureIntake(args);
    expect(out).toMatchObject({ ok: true, reportOnly: false, reportOnlyDeferred: 0, enqueued: 2 });
    expect(out.results.some((r) => r.action === 'report_only_deferred')).toBe(false);
  });

  test('reportOnly.enabled: false behaves exactly like no reportOnly block', async () => {
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [{ ...SESSION, reportOnly: { enabled: false } }] }), 'utf8');
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation', 'review'] };

    const out = await captureIntake(args);
    expect(out).toMatchObject({ ok: true, reportOnly: false, reportOnlyDeferred: 0, enqueued: 2 });
  });

  // --dry-run must preview report-only deferrals accurately (issue #532 review
  // follow-up): the implementation candidate should be classified as
  // `report_only_deferred`, not `dry_run`, and nothing should be written.
  test('--dry-run reports the implementation candidate as report_only_deferred, not dry_run', async () => {
    writeReportOnlySession();
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: true, supportedPhases: ['implementation', 'review'] };

    const out = await captureIntake(args);
    expect(out).toMatchObject({ ok: true, dryRun: true, reportOnly: true, reportOnlyDeferred: 1, candidates: 2, enqueued: 0 });

    const deferred = out.results.find((r) => r.issueNumber === 101);
    expect(deferred).toMatchObject({ action: 'report_only_deferred', phase: 'implementation' });
    expect(deferred.message).toMatch(/report-only mode/i);
    expect(deferred.message).toMatch(/issue #101/);

    const enqueued = out.results.find((r) => r.issueNumber === 102);
    expect(enqueued).toMatchObject({ action: 'dry_run', phase: 'review' });

    const store = new SqliteTaskStore(dbPath);
    const implTask = await store.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    const reviewTask = await store.getTask({ sessionId: 'addon-dev', issueNumber: 102 });
    store.close();
    expect(implTask).toBeUndefined();
    expect(reviewTask).toBeUndefined();
  });
});

describe('github-intake — contextId-only resolution (no --session-id)', () => {
  const fakeGh = { listIssues: () => [] };
  const noBlocker = { getBlockedBy: async () => [] };

  function captureIntake(args) {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    return runIntake(args, fakeGh, noBlocker).finally(() => {
      process.stdout.write = origWrite;
    }).then(() => JSON.parse(chunks.join('').trim()));
  }

  test('contextId resolves sessionId from context store', async () => {
    const ctxStore = new SqliteContextStore(dbPath);
    ctxStore.upsert('intake-ctx-1', 'addon-dev');
    ctxStore.close();

    const out = await captureIntake({
      sessionId: undefined,
      contextId: 'intake-ctx-1',
      sessionsPath,
      dbPath,
      limit: 100,
      dryRun: false,
      supportedPhases: ['research'],
    });
    expect(out).toMatchObject({ ok: true, sessionId: 'addon-dev', contextId: 'intake-ctx-1' });
  });

  test('unknown contextId exits non-zero via CLI', () => {
    const r = runCli(
      '--context-id', 'no-such-context-intake',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
    );
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no-such-context-intake') });
  });
});

// ---------------------------------------------------------------------------
// Reactivation of blocked implementation tasks (issue #224)
// ---------------------------------------------------------------------------

describe('github-intake — blocked label cleared on reactivation (issue #224)', () => {
  function captureIntake(args) {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    return runIntake(args, fakeGh, noBlockerChecker).finally(() => {
      process.stdout.write = origWrite;
    }).then(() => JSON.parse(chunks.join('').trim()));
  }

  test('emits gh:label:remove for ai:blocked when a blocked implementation task is reactivated', async () => {
    // Simulate what happens when an implementation handler previously returned
    // `blocked`: the task row sits in `blocked` status at the implementation
    // phase and the GitHub issue carries the ai:blocked label (added by the
    // outbox effect emitted during that phase run). When intake later sees the
    // issue again (e.g. after the blocker becomes stack-ready and its labels
    // still include agent:claude + status:needs-implementation), enqueueTask
    // reactivates the row but the store has no outbox access, so the ai:blocked
    // label would remain on GitHub without this fix (issue #224).
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 101,
      phase: 'implementation',
      now: '2026-06-07T09:00:00.000Z',
    });
    // Simulate the handler returning blocked → task transitions to blocked status.
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 101 },
      { status: 'queued' },
      { status: 'blocked', phase: 'implementation' },
    );
    store.close();

    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    const out = await captureIntake(args);

    // The task was reactivated, not freshly enqueued.
    expect(out).toMatchObject({ ok: true, enqueued: 1 });
    const reactivatedResult = out.results.find((r) => r.issueNumber === 101);
    expect(reactivatedResult).toMatchObject({ action: 'reactivated', phase: 'implementation' });

    // The outbox must carry a gh:label:remove for ai:blocked so the label is
    // cleared before the next implementation/review run starts.
    const outboxStore = new SqliteOutboxStore(dbPath);
    const pending = await outboxStore.listPending();
    outboxStore.close();

    const labelRemove = pending.find(
      (e) => e.topic === 'gh:label:remove' && e.payload.issueNumber === 101 && e.payload.label === 'ai:blocked',
    );
    expect(labelRemove).toBeDefined();
  });

  test('does not emit blocked label removal for a freshly enqueued (non-reactivated) task', async () => {
    // A new task that was never blocked must not trigger a spurious label removal.
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    const out = await captureIntake(args);

    expect(out).toMatchObject({ ok: true, enqueued: 1 });
    const enqueuedResult = out.results.find((r) => r.issueNumber === 101);
    expect(enqueuedResult).toMatchObject({ action: 'enqueued' });

    const outboxStore = new SqliteOutboxStore(dbPath);
    const pending = await outboxStore.listPending();
    outboxStore.close();

    const labelRemove = pending.find(
      (e) => e.topic === 'gh:label:remove' && e.payload.label === 'ai:blocked',
    );
    expect(labelRemove).toBeUndefined();
  });

  test('reactivates a conflict_resolution task held blocked by report-only mode once report-only is disabled (issue #532 review)', async () => {
    // Simulate a review that queued conflict_resolution, then a run-one-phase
    // attempt while the session was in report-only mode: the admission gate
    // (checkReportOnlyAdmission) rejects it and transitions.ts holds the task
    // at `blocked`/conflict_resolution (not ready_for_human) so it stays
    // eligible for reactivation — the GitHub issue keeps its
    // status:needs-conflict-resolution label throughout.
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 201,
      phase: 'conflict_resolution',
      now: '2026-06-07T09:00:00.000Z',
    });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 201 },
      { status: 'queued' },
      { status: 'blocked', phase: 'conflict_resolution' },
    );
    store.close();

    // report-only mode is now disabled (normal SESSION), and the issue is
    // still carrying the conflict-resolution label an operator never removed.
    const conflictGh = {
      listIssues: () => [
        {
          number: 201,
          title: 'Resolve merge conflict for C',
          url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/201',
          labels: [{ name: 'status:needs-conflict-resolution' }],
        },
      ],
    };
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    let out;
    try {
      await runIntake(
        { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['conflict_resolution'] },
        conflictGh,
        noBlockerChecker,
      );
    } finally {
      process.stdout.write = origWrite;
    }
    out = JSON.parse(chunks.join('').trim());

    expect(out).toMatchObject({ ok: true, enqueued: 1 });
    const reactivatedResult = out.results.find((r) => r.issueNumber === 201);
    expect(reactivatedResult).toMatchObject({ action: 'reactivated', phase: 'conflict_resolution' });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 201 });
    store2.close();
    expect(task?.status).toBe('queued');
    expect(task?.phase).toBe('conflict_resolution');

    const outboxStore = new SqliteOutboxStore(dbPath);
    const pending = await outboxStore.listPending();
    outboxStore.close();
    const labelRemove = pending.find(
      (e) => e.topic === 'gh:label:remove' && e.payload.issueNumber === 201 && e.payload.label === 'ai:blocked',
    );
    expect(labelRemove).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Intake must never resurrect a cancelled task (issue #608)
// ---------------------------------------------------------------------------

describe('github-intake — does not resurrect a cancelled task (issue #608)', () => {
  function captureIntake(args) {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    return runIntake(args, fakeGh, noBlockerChecker).finally(() => {
      process.stdout.write = origWrite;
    }).then(() => JSON.parse(chunks.join('').trim()));
  }

  test('a cancelled task is reported already_exists and is not requeued', async () => {
    // The operator cancelled the task while the GitHub issue stayed open and
    // still carries the labels that make it an intake candidate (e.g. the
    // issue was deprioritized without being closed). A later intake pass must
    // not silently bring it back to `queued`.
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 101,
      phase: 'implementation',
      now: '2026-06-07T09:00:00.000Z',
    });
    const cancelled = await store.cancelTask(
      { sessionId: 'addon-dev', issueNumber: 101 },
      { reason: 'operator abandoned', now: '2026-06-07T09:05:00.000Z' },
    );
    expect(cancelled.ok).toBe(true);
    store.close();

    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    const out = await captureIntake(args);

    expect(out).toMatchObject({ ok: true, enqueued: 0, alreadyExists: 1 });
    const result = out.results.find((r) => r.issueNumber === 101);
    expect(result).toMatchObject({ action: 'already_exists' });

    const after = new SqliteTaskStore(dbPath);
    const task = await after.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    after.close();
    expect(task.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// GitHub label intake must never override an unresolved Tool Request (issue #677)
// ---------------------------------------------------------------------------

describe('github-intake — unresolved Tool Request is authoritative over conflicting labels (issue #677)', () => {
  function captureIntake(args, gh = fakeGh) {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    return runIntake(args, gh, noBlockerChecker).finally(() => {
      process.stdout.write = origWrite;
    }).then(() => JSON.parse(chunks.join('').trim()));
  }

  // Issue #102 in FAKE_ISSUES carries `agent:codex` + `status:needs-review` — the
  // exact conflicting-label shape from the issue #677 incident (an operator/label
  // change routing the issue toward review while implementation left it parked on
  // an unresolved Tool Request).
  test('an existing ready_for_human/implementation Tool Request handoff is left untouched by a conflicting status:needs-review label', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 102,
      phase: 'implementation',
      implementationAgent: 'claude',
      now: '2026-06-07T09:00:00.000Z',
    });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 102 },
      { status: 'queued' },
      {
        status: 'ready_for_human',
        phase: 'implementation',
        context: {
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-07T09:00:00.000Z',
            resolved: false,
          },
        },
      },
    );
    store.close();

    const args = {
      sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false,
      supportedPhases: ['implementation', 'review'],
    };
    const out = await captureIntake(args);

    const result102 = out.results.find((r) => r.issueNumber === 102);
    expect(result102).toMatchObject({ action: 'already_exists' });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 102 });
    store2.close();
    expect(task.status).toBe('ready_for_human');
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequest.resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Assignment persistence (issue #259)
// ---------------------------------------------------------------------------

describe('github-intake — assignment persistence', () => {
  function capture(args, gh = fakeGh) {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    return runIntake(args, gh, noBlockerChecker)
      .finally(() => { process.stdout.write = origWrite; })
      .then(() => JSON.parse(chunks.join('').trim()));
  }

  test('persists a default resolved assignment in task context', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    await capture(args);

    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    store.close();

    expect(task?.context?.assignment).toMatchObject({
      flow: 'code',
      implementationAgent: 'claude',
      reviewAgent: 'codex',
      conflictResolutionAgent: 'claude',
      source: 'default',
    });
    expect(typeof task?.context?.assignment?.resolvedAt).toBe('string');
  });

  test('a documentation issue resolves to the configured docs flow', async () => {
    const docsSession = {
      ...SESSION,
      assignmentProfiles: {
        code: { implementation: 'claude', review: 'codex', conflict_resolution: 'claude' },
        docs: { implementation: 'claude', review: 'claude' },
      },
      flowRules: [
        { flow: 'docs', labels: ['documentation'] },
        { flow: 'code', default: true },
      ],
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [docsSession] }), 'utf8');

    const docGh = {
      listIssues: () => [{
        number: 201,
        title: 'Document the API',
        url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/201',
        labels: [{ name: 'agent:claude' }, { name: 'status:needs-implementation' }, { name: 'documentation' }],
      }],
    };
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    await capture(args, docGh);

    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 201 });
    store.close();

    expect(task?.context?.assignment).toMatchObject({
      flow: 'docs',
      reviewAgent: 'claude',
      implementationAgent: 'claude',
      source: 'session-config',
    });
  });

  test('editing session config after intake does not change the persisted assignment', async () => {
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    await capture(args);

    // Operator edits sessions.json to flip the implementation default to codex.
    writeFileSync(
      sessionsPath,
      JSON.stringify({ sessions: [{ ...SESSION, defaults: { implementationAgent: 'codex', reviewAgent: 'codex' } }] }),
      'utf8',
    );
    // A second intake pass is idempotent (already_exists) and must not rewrite context.
    await capture(args);

    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    store.close();

    expect(task?.context?.assignment?.implementationAgent).toBe('claude');
  });

  test('reactivating a blocked task preserves the originally pinned assignment', async () => {
    // First intake pins the assignment (claude/codex) on the implementation task.
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    await capture(args);

    // Drive the task into `blocked` at the implementation phase, mimicking a
    // dependency-held task awaiting reactivation.
    const store = new SqliteTaskStore(dbPath);
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 101 },
      { status: 'queued' },
      { status: 'blocked', phase: 'implementation' },
    );
    store.close();

    // Operator edits sessions.json to flip the implementation default to codex
    // before the blocker clears.
    writeFileSync(
      sessionsPath,
      JSON.stringify({ sessions: [{ ...SESSION, defaults: { implementationAgent: 'codex', reviewAgent: 'codex' } }] }),
      'utf8',
    );

    // Second intake reactivates the blocked task; the merge must not overwrite
    // the pinned assignment with a freshly resolved one (issue #259).
    const out = await capture(args);
    const reactivated = out.results.find((r) => r.issueNumber === 101);
    expect(reactivated).toMatchObject({ action: 'reactivated' });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    store2.close();
    expect(task?.context?.assignment?.implementationAgent).toBe('claude');
    expect(task?.context?.assignment?.reviewAgent).toBe('codex');
  });

  test('agent:gemini + status:needs-review label overrides default Codex reviewAgent in persisted assignment', async () => {
    // Session default is Codex for review. The issue labels specify Gemini — the
    // persisted assignment must honour the label-derived override (#264).
    const geminiReviewGh = {
      listIssues: () => [{
        number: 301,
        title: 'Review PR for Gemini issue',
        url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/301',
        labels: [{ name: 'agent:gemini' }, { name: 'status:needs-review' }],
      }],
    };
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['review'] };
    await capture(args, geminiReviewGh);

    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 301 });
    store.close();

    expect(task?.context?.assignment?.reviewAgent).toBe('gemini');
  });

  test('agent:codex + status:needs-implementation persists codex in assignment (not session default)', async () => {
    // This is the intake-to-handler path regression: without the label-override fix,
    // resolveAssignment() would persist implementationAgent: 'claude' (session default)
    // even though the label explicitly says agent:codex. agentForPhase() prefers the
    // persisted assignment, so the implementation handler would run Claude instead of Codex.
    const codexIssue = {
      number: 200,
      title: 'Implement with Codex',
      url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/200',
      labels: [{ name: 'agent:codex' }, { name: 'status:needs-implementation' }],
    };
    const codexGh = { listIssues: () => [codexIssue] };
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    await capture(args, codexGh);

    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 200 });
    store.close();

    // The persisted assignment must honor the explicit label, not the session default (claude).
    expect(task?.context?.assignment?.implementationAgent).toBe('codex');
    // conflictResolutionAgent stays on Claude — label overrides for implementation
    // do not propagate to conflict resolution; only Claude is supported there.
    expect(task?.context?.assignment?.conflictResolutionAgent).toBe('claude');
    // The task-level column must also reflect the label.
    expect(task?.implementationAgent).toBe('codex');
  });

  test('reactivating a legacy blocked task (no pinned assignment) does not adopt a freshly resolved one', async () => {
    // Simulate a task created before assignment persistence existed: it sits in
    // `blocked` at the implementation phase with no context.assignment, so its
    // agent columns are the authority for agentForPhase().
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 101,
      phase: 'implementation',
      now: '2026-06-07T09:00:00.000Z',
    });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 101 },
      { status: 'queued' },
      { status: 'blocked', phase: 'implementation' },
    );
    const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    store.close();
    expect(before?.context?.assignment).toBeUndefined();

    // Operator changes the implementation default while the task is blocked.
    writeFileSync(
      sessionsPath,
      JSON.stringify({ sessions: [{ ...SESSION, defaults: { implementationAgent: 'codex', reviewAgent: 'codex' } }] }),
      'utf8',
    );

    // Reactivation must not inject a config-derived assignment into the legacy
    // task; agentForPhase must keep following the original columns (issue #259).
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['implementation'] };
    const out = await capture(args);
    const reactivated = out.results.find((r) => r.issueNumber === 101);
    expect(reactivated).toMatchObject({ action: 'reactivated' });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 101 });
    store2.close();
    expect(task?.context?.assignment).toBeUndefined();
  });

  test('label-derived reviewAgent overrides session default in persisted assignment (issue #261)', async () => {
    // SESSION has defaults.reviewAgent = 'codex'. An issue carrying
    // agent:claude + status:needs-review should resolve to reviewAgent:'claude'
    // in the persisted assignment so agentForPhase() (which prefers the
    // persisted assignment over task.reviewAgent) invokes Claude, not Codex.
    const reviewGh = {
      listIssues: () => [{
        number: 301,
        title: 'Review PR for feature X',
        url: 'https://github.com/m2dw/thunderbird-auth-results-filter/issues/301',
        labels: [{ name: 'agent:claude' }, { name: 'status:needs-review' }],
      }],
    };
    const args = { sessionId: 'addon-dev', sessionsPath, dbPath, limit: 100, dryRun: false, supportedPhases: ['review'] };
    await capture(args, reviewGh);

    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 301 });
    store.close();

    // The persisted assignment must reflect Claude, not the Codex session default.
    expect(task?.context?.assignment?.reviewAgent).toBe('claude');
  });
});
