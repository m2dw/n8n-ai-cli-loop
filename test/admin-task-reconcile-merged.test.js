/**
 * `admin task reconcile-merged` — the operator surface over
 * docs/merged-pr-reconciliation-contract.md (issue #1048).
 *
 * The §7 decision itself is pinned by test/merged-pr-reconciliation.test.js
 * (issue #1047); these cases pin what the COMMAND does with it end to end: that
 * a preview writes nothing, that an apply writes exactly the contract's three
 * effects, that every outcome reaches the payload with a stable shape, that an
 * operational failure and a "not eligible" answer map to different exit
 * statuses, and that `admin worktree cleanup` — unchanged by this contract —
 * sees a reconciled task as an ordinary prune candidate afterwards.
 *
 * The repo host is a fake `gh` on PATH that serves one JSON fixture per PR
 * number, so a missing fixture is a real provider failure rather than a stub
 * that quietly returns "not merged".
 */
import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  IssueWorktreeLock,
  SqliteOutboxStore,
  SqliteTaskStore,
  resolveIssueWorktree,
} from '../dist/index.js';
import { runAdmin } from './helpers/admin-cli.js';

// Every case forks real `git` in beforeEach and a real fake-`gh` per provider
// read, and two of them fork a second Node process; give the whole file the
// headroom the other spawn-touching suites use rather than letting a loaded
// runner flake against Jest's 5s default.
jest.setTimeout(30_000);

const SESSION = 'addon-dev';
const REPO = 'm2dw/test-repo';

let tmpDir;
let repoRoot;
let worktreeRoot;
let sessionsPath;
let dbPath;
let lockDir;
let ghDir;
let prDir;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function sh(value) {
  return JSON.stringify(value);
}

/**
 * A fake `gh` that answers `pr view <selector> --json ...` from a per-PR
 * fixture file. A missing fixture exits non-zero, which is what a deleted or
 * inaccessible PR looks like — the contract's `pr-lookup-failed`, never
 * "not merged". Every invocation is logged so a case can assert that a
 * decision was reached WITHOUT a provider call.
 */
function writeFakeGh() {
  const script = [
    '#!/bin/sh',
    `echo "$@" >> ${sh(join(tmpDir, 'gh-calls.log'))}`,
    // One-shot concurrent writer: lets a case mutate the task row in the window
    // between the command's read and its compare-and-swap.
    `if [ -f ${sh(join(tmpDir, 'mutate.mjs'))} ]; then`,
    `  ${sh(process.execPath)} ${sh(join(tmpDir, 'mutate.mjs'))} >> ${sh(join(tmpDir, 'mutate.log'))} 2>&1`,
    `  rm -f ${sh(join(tmpDir, 'mutate.mjs'))}`,
    'fi',
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  f=${sh(prDir)}/pr-$3.json`,
    '  if [ -f "$f" ]; then cat "$f"; exit 0; fi',
    // The error text deliberately embeds a local path, so the command's
    // sanitization is exercised on the way to the operator.
    `  echo "gh: could not resolve PR $3 in checkout ${repoRoot}" 1>&2`,
    '  exit 1',
    'fi',
    'exit 1',
  ].join('\n');
  const path = join(ghDir, 'gh');
  writeFileSync(path, script + '\n', 'utf8');
  chmodSync(path, 0o755);
}

function ghCalls() {
  const path = join(tmpDir, 'gh-calls.log');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function writeSession(overrides = {}) {
  const session = {
    sessionId: SESSION,
    repoKey: 'test-repo',
    repoRoot,
    githubRepo: REPO,
    artifactDir: '.n8n-artifacts',
    baseBranch: 'main',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    worktrees: { root: worktreeRoot },
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }, null, 2), 'utf8');
}

function prUrl(n) {
  return `https://github.com/${REPO}/pull/${n}`;
}

function writePr(n, overrides = {}) {
  writeFileSync(
    join(prDir, `pr-${n}.json`),
    JSON.stringify({
      number: n,
      url: prUrl(n),
      headRefName: overrides.headRefName ?? `ai/issue-${overrides.issueNumber ?? n}`,
      state: 'MERGED',
      baseRefName: 'main',
      ...overrides,
    }),
    'utf8',
  );
}

/**
 * Seed one task row. `pr` (a PR number) records the exact PR identity the
 * contract reconciles from; omitting it produces a task with no recorded PR.
 */
async function seed(
  issueNumber,
  { status = 'queued', phase = 'implementation', pr, context = {}, ownerRunId, leaseExpiresAt } = {},
) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({ sessionId: SESSION, issueNumber, phase, implementationAgent: 'claude' });
    const patch = { status, phase, context: { ...context } };
    if (pr !== undefined) {
      patch.context.prUrl = prUrl(pr);
      patch.context.branch = `ai/issue-${issueNumber}`;
    }
    if (status === 'claimed' || status === 'running') {
      patch.ownerRunId = ownerRunId ?? 'run-live';
      patch.leaseExpiresAt = leaseExpiresAt ?? '2999-01-01T00:00:00.000Z';
    }
    const result = await store.transitionTask({ sessionId: SESSION, issueNumber }, { status: 'queued' }, patch);
    if (!result.ok) throw new Error(`seed failed: ${result.code}`);
  } finally {
    store.close();
  }
}

async function getTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  try {
    return await store.getTask({ sessionId: SESSION, issueNumber });
  } finally {
    store.close();
  }
}

async function getEvents(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  try {
    return await store.listEvents({ sessionId: SESSION, issueNumber });
  } finally {
    store.close();
  }
}

async function getOutbox() {
  const store = new SqliteOutboxStore(dbPath);
  try {
    return await store.listPending();
  } finally {
    store.close();
  }
}

function run(...args) {
  return runAdmin(args, { env: { PATH: `${ghDir}:${process.env.PATH}` } });
}

/** The command under test, with the fixture registry/db/lock dir wired in. */
function reconcile(...extra) {
  return run(
    'task', 'reconcile-merged',
    '--session-id', SESSION,
    '--sessions-path', sessionsPath,
    '--db-path', dbPath,
    '--worktree-lock-dir', lockDir,
    ...extra,
  );
}

function reconcileJson(...extra) {
  return reconcile('--json', ...extra);
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

function rowFor(payload, issueNumber) {
  return payload.results.find((r) => r.issueNumber === issueNumber);
}

/**
 * Strip every path- and root-valued field from a payload, recursively.
 *
 * `worktree cleanup` echoes absolute paths that live under this file's own
 * `admin-reconcile-merged-*` temp directory, so searching the raw JSON for
 * merged-PR vocabulary would match the fixture's directory name instead of
 * anything cleanup actually said. What survives the strip is cleanup's own
 * classification vocabulary, which is what §14 requires to stay unchanged.
 */
function withoutPaths(value) {
  if (Array.isArray(value)) return value.map(withoutPaths);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/path|root/i.test(key))
        .map(([key, inner]) => [key, withoutPaths(inner)]),
    );
  }
  return value;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-reconcile-merged-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
  lockDir = join(tmpDir, 'state', 'worktree-locks');
  ghDir = join(tmpDir, 'bin');
  prDir = join(tmpDir, 'prs');
  mkdirSync(ghDir, { recursive: true });
  mkdirSync(prDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
  writeSession();
  writeFakeGh();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discoverability and argument handling
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — discoverability and parsing', () => {
  test('appears in the help listing with its options and the operator sequence', async () => {
    const listing = await run('help');
    expect(listing.code).toBe(0);
    expect(listing.stdout).toContain('task reconcile-merged');

    const detail = await run('help', 'task reconcile-merged');
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain('--issue-number');
    expect(detail.stdout).toContain('--yes');
    expect(detail.stdout).toContain('worktree cleanup');
  });

  test('requires a session selector', async () => {
    const r = await run('task', 'reconcile-merged', '--db-path', dbPath, '--json');
    expect(r.code).toBe(1);
    expect(parse(r).ok).toBe(false);
  });

  test('rejects an unknown action under `task`', async () => {
    const r = await run('task', 'reconcile-merge', '--session-id', SESSION, '--json');
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('reconcile-merged');
  });

  test('rejects unknown and abbreviated flags, including --force', async () => {
    for (const flag of ['--force', '--bogus', '--ye', '--include-merged']) {
      const r = await reconcileJson(flag);
      expect(r.code).toBe(1);
      expect(parse(r).error).toContain('Unknown option');
    }
  });

  test('rejects a non-numeric --issue-number', async () => {
    const r = await reconcileJson('--issue-number', 'abc');
    expect(r.code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Preview is side-effect free
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — preview', () => {
  test('previews a merged PR without writing anything', async () => {
    await seed(101, { status: 'queued', pr: 21 });
    writePr(21, { issueNumber: 101 });

    const r = await reconcileJson('--issue-number', '101');
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload).toMatchObject({
      ok: true,
      sessionId: SESSION,
      issueNumber: 101,
      mode: 'preview',
      dryRun: true,
      scanned: 1,
      reconciled: 1,
    });
    expect(rowFor(payload, 101)).toMatchObject({
      issueNumber: 101,
      taskStatus: 'queued',
      taskPhase: 'implementation',
      prUrl: prUrl(21),
      prNumber: 21,
      outcome: 'reconciled',
      eligible: true,
      applied: false,
      providerState: 'MERGED',
    });

    // Nothing moved: status, context, events, and the outbox are untouched.
    const task = await getTask(101);
    expect(task.status).toBe('queued');
    expect(task.context.mergedPrReconciliations).toBeUndefined();
    expect((await getEvents(101)).filter((e) => e.type === 'task.merged_pr_reconciled')).toHaveLength(0);
    expect(await getOutbox()).toHaveLength(0);
  });

  test('preview output is deterministic and repeatable', async () => {
    await seed(101, { status: 'queued', pr: 21 });
    await seed(102, { status: 'ready_for_human', phase: 'review', pr: 22 });
    writePr(21, { issueNumber: 101 });
    writePr(22, { issueNumber: 102, state: 'OPEN' });

    const first = await reconcileJson();
    const second = await reconcileJson();
    expect(first.stdout).toBe(second.stdout);
    expect(parse(first).results.map((r) => r.issueNumber)).toEqual([101, 102]);

    const human = await reconcile();
    const humanAgain = await reconcile();
    expect(human.stdout).toBe(humanAgain.stdout);
    expect(human.stdout).toContain('#101: would reconcile');
    expect(human.stdout).toContain('#102: not eligible (not-merged)');
    expect(human.stdout).toContain('Run with --yes to apply.');
    // The two-stage operator sequence is stated on every human-readable run.
    expect(human.stdout).toContain('admin worktree cleanup');
  });
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — apply', () => {
  test('completes a queued task and writes the transition, event, and comment', async () => {
    await seed(101, { status: 'queued', pr: 21 });
    writePr(21, { issueNumber: 101 });

    const r = await reconcileJson('--issue-number', '101', '--yes');
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload).toMatchObject({ ok: true, mode: 'apply', dryRun: false, reconciled: 1 });
    expect(rowFor(payload, 101)).toMatchObject({ outcome: 'reconciled', applied: true, eligible: true });

    const task = await getTask(101);
    expect(task.status).toBe('done');
    expect(task.context.mergedPrReconciliations).toEqual([
      expect.objectContaining({
        prUrl: prUrl(21),
        prNumber: 21,
        providerState: 'MERGED',
        previousStatus: 'queued',
        outcome: 'reconciled',
      }),
    ]);

    const events = (await getEvents(101)).filter((e) => e.type === 'task.merged_pr_reconciled');
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ prUrl: prUrl(21), prNumber: 21 });

    const outbox = await getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload.topic).toBe('gh:comment');
    expect(outbox[0].payload.issueNumber).toBe(101);
    expect(outbox[0].payload.body).toContain(prUrl(21));
    expect(outbox[0].payload.body).not.toContain(tmpDir);
  });

  test('records the merge on a failed task without changing its status', async () => {
    await seed(103, { status: 'failed', pr: 23 });
    writePr(23, { issueNumber: 103 });

    const preview = await reconcileJson('--issue-number', '103');
    expect(rowFor(parse(preview), 103)).toMatchObject({
      outcome: 'recorded-terminal',
      eligible: true,
      applied: false,
    });

    const r = await reconcileJson('--issue-number', '103', '--yes');
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ recordedTerminal: 1, reconciled: 0 });

    const task = await getTask(103);
    expect(task.status).toBe('failed');
    expect(task.context.mergedPrReconciliations).toHaveLength(1);
  });

  test('reconciles a cancelled task the same way (terminal status preserved)', async () => {
    await seed(104, { status: 'cancelled', pr: 24 });
    writePr(24, { issueNumber: 104 });

    const r = await reconcileJson('--issue-number', '104', '--yes');
    expect(r.code).toBe(0);
    expect(rowFor(parse(r), 104)).toMatchObject({ outcome: 'recorded-terminal', applied: true });
    expect((await getTask(104)).status).toBe('cancelled');
  });

  test('a repeated apply is a no-op: `done` short-circuits, a terminal row is already-reconciled', async () => {
    await seed(101, { status: 'blocked', pr: 21 });
    await seed(103, { status: 'failed', pr: 23 });
    writePr(21, { issueNumber: 101 });
    writePr(23, { issueNumber: 103 });

    const first = await reconcileJson('--yes');
    expect(first.code).toBe(0);
    expect(parse(first)).toMatchObject({ reconciled: 1, recordedTerminal: 1 });
    const afterFirst = { 101: await getTask(101), 103: await getTask(103) };
    expect(afterFirst[101].status).toBe('done');

    // Single-Issue mode still reports the reconciled task; the bulk scan skips
    // `done` rows entirely.
    const repeatOne = await reconcileJson('--issue-number', '101', '--yes');
    expect(repeatOne.code).toBe(0);
    expect(rowFor(parse(repeatOne), 101)).toMatchObject({ outcome: 'noop-done', applied: false });

    const repeatBulk = await reconcileJson('--yes');
    expect(repeatBulk.code).toBe(0);
    const bulk = parse(repeatBulk);
    expect(bulk.results.map((r) => r.issueNumber)).toEqual([103]);
    expect(rowFor(bulk, 103)).toMatchObject({ outcome: 'already-reconciled', applied: false });

    // Neither row changed, and no second comment was queued for either.
    expect(await getTask(101)).toEqual(afterFirst[101]);
    expect(await getTask(103)).toEqual(afterFirst[103]);
    expect(await getOutbox()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Refusals — eligibility answers (exit 0) and operational failures (exit 1)
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — refusals', () => {
  test('an open PR is not eligible and does not fail the run', async () => {
    await seed(102, { status: 'ready_for_human', phase: 'review', pr: 22 });
    writePr(22, { issueNumber: 102, state: 'OPEN' });

    const r = await reconcileJson('--issue-number', '102');
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(rowFor(payload, 102)).toMatchObject({
      outcome: 'refused',
      reason: 'not-merged',
      providerState: 'OPEN',
      eligible: false,
      applied: false,
    });
    expect((await getTask(102)).status).toBe('ready_for_human');
  });

  test('a closed-unmerged PR is not-merged and points at reconcile-closed', async () => {
    await seed(105, { status: 'queued', pr: 25 });
    writePr(25, { issueNumber: 105, state: 'CLOSED' });

    const payload = parse(await reconcileJson('--issue-number', '105', '--yes'));
    expect(rowFor(payload, 105)).toMatchObject({ outcome: 'refused', reason: 'not-merged', providerState: 'CLOSED' });
    expect(rowFor(payload, 105).message).toContain('reconcile-closed');
    expect((await getTask(105)).status).toBe('queued');
  });

  test('a task with no recorded PR is refused without any provider call', async () => {
    await seed(106, { status: 'queued' });

    const payload = parse(await reconcileJson('--issue-number', '106', '--yes'));
    expect(rowFor(payload, 106)).toMatchObject({
      outcome: 'refused',
      reason: 'missing-pr-identity',
      prUrl: null,
      prNumber: null,
      providerState: null,
    });
    expect(ghCalls()).toHaveLength(0);
    expect((await getTask(106)).status).toBe('queued');
  });

  test('a recorded PR identity that is a local path is redacted in every output', async () => {
    // `context.prUrl` is arbitrary task context, so a malformed row can hold an
    // absolute local path instead of a URL. Both shapes are covered: one with no
    // extractable PR number (refused before any provider call, so nothing else
    // would ever reject it) and one that still yields a number and reaches the
    // provider. Neither may put the path in the payload or on the screen.
    await seed(112, { status: 'queued', context: { prUrl: join(repoRoot, 'pr', 'local-only') } });
    await seed(113, { status: 'queued', context: { prUrl: join(repoRoot, 'pull', '21') } });
    writePr(21, { issueNumber: 113 });

    const r = await reconcileJson();
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(rowFor(payload, 112)).toMatchObject({
      outcome: 'refused',
      reason: 'missing-pr-identity',
      prUrl: '<path>',
      prNumber: null,
    });
    expect(rowFor(payload, 113)).toMatchObject({
      outcome: 'refused',
      reason: 'identity-mismatch',
      prUrl: '<path>',
      prNumber: 21,
    });
    expect(r.stdout).not.toContain(repoRoot);

    const human = await reconcile();
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain(repoRoot);

    // Redaction is a reporting concern only: the recorded value the contract
    // compares against the provider is untouched.
    expect((await getTask(113)).context.prUrl).toBe(join(repoRoot, 'pull', '21'));
  });

  test('a provider read failure fails the run (exit 1) and never reads as not-merged', async () => {
    await seed(107, { status: 'queued', pr: 27 }); // no fixture written

    const r = await reconcileJson('--issue-number', '107', '--yes');
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.ok).toBe(false);
    expect(rowFor(payload, 107)).toMatchObject({ outcome: 'refused', reason: 'pr-lookup-failed' });
    expect((await getTask(107)).status).toBe('queued');
    // The provider's stderr is surfaced, but no local path leaks with it.
    expect(r.stdout).not.toContain(tmpDir);
  });

  test('a provider that answers about a different PR is an identity mismatch', async () => {
    await seed(108, { status: 'queued', pr: 28 });
    writePr(28, { issueNumber: 108, number: 999 });

    const payload = parse(await reconcileJson('--issue-number', '108', '--yes'));
    expect(rowFor(payload, 108)).toMatchObject({ outcome: 'refused', reason: 'identity-mismatch' });
    expect((await getTask(108)).status).toBe('queued');
  });

  test('an unresolved Tool Request is refused even though the PR is merged', async () => {
    await seed(109, {
      status: 'ready_for_human',
      pr: 29,
      context: { toolRequest: { command: 'npm install left-pad' } },
    });
    writePr(29, { issueNumber: 109 });

    const payload = parse(await reconcileJson('--issue-number', '109', '--yes'));
    expect(rowFor(payload, 109)).toMatchObject({ outcome: 'refused', reason: 'tool-request-unresolved' });
    expect(ghCalls()).toHaveLength(0);
    expect((await getTask(109)).status).toBe('ready_for_human');
  });

  test('a malformed reconciliation history is refused, never repaired', async () => {
    await seed(110, { status: 'queued', pr: 30, context: { mergedPrReconciliations: 'nonsense' } });
    writePr(30, { issueNumber: 110 });

    const payload = parse(await reconcileJson('--issue-number', '110', '--yes'));
    expect(rowFor(payload, 110)).toMatchObject({
      outcome: 'refused',
      reason: 'malformed-disposition-history',
    });
    expect((await getTask(110)).context.mergedPrReconciliations).toBe('nonsense');
  });

  test('a missing task in single-Issue mode fails the run', async () => {
    const r = await reconcileJson('--issue-number', '999');
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.ok).toBe(false);
    expect(payload.notFound).toBe(1);
    expect(rowFor(payload, 999)).toMatchObject({ outcome: 'task-not-found', applied: false });
  });
});

// ---------------------------------------------------------------------------
// Active execution is never converted
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — active execution', () => {
  test('a claimed task with a valid lease is reported active, not reconciled', async () => {
    await seed(111, { status: 'claimed', pr: 31 });
    writePr(31, { issueNumber: 111 });

    const r = await reconcileJson('--issue-number', '111', '--yes');
    expect(r.code).toBe(0);
    expect(rowFor(parse(r), 111)).toMatchObject({
      outcome: 'active',
      reason: 'valid-claim',
      taskStatus: 'claimed',
      applied: false,
    });
    expect(ghCalls()).toHaveLength(0);
    expect((await getTask(111)).status).toBe('claimed');
  });

  test('a running task with an expired lease is routed to `admin recover`', async () => {
    await seed(112, {
      status: 'running',
      pr: 32,
      ownerRunId: 'run-dead',
      leaseExpiresAt: '2020-01-01T00:00:00.000Z',
    });
    writePr(32, { issueNumber: 112 });

    const payload = parse(await reconcileJson('--issue-number', '112', '--yes'));
    expect(rowFor(payload, 112)).toMatchObject({ outcome: 'refused', reason: 'active-recovery-required' });
    expect(rowFor(payload, 112).message).toContain('admin recover');
    expect((await getTask(112)).status).toBe('running');
  });

  test('a live Issue lock withholds every writing outcome', async () => {
    await seed(113, { status: 'queued', pr: 33 });
    writePr(33, { issueNumber: 113 });
    const lock = new IssueWorktreeLock(lockDir);
    expect(lock.acquire('ctx-live', SESSION, 113).locked).toBe(true);

    const r = await reconcileJson('--issue-number', '113', '--yes');
    expect(r.code).toBe(0);
    expect(rowFor(parse(r), 113)).toMatchObject({ outcome: 'active', reason: 'issue-lock', applied: false });
    expect((await getTask(113)).status).toBe('queued');

    // The lock itself is never released by reconciliation.
    expect(lock.inspect(SESSION, 113).locked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stale state: the row moved between the read and the write
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — stale state', () => {
  test('a concurrent write during the provider read loses the CAS and refuses', async () => {
    await seed(114, { status: 'queued', pr: 34 });
    writePr(34, { issueNumber: 114 });

    // Runs inside the fake `gh` — i.e. after the command read the task row and
    // before it writes — and moves the row out from under the decision.
    writeFileSync(
      join(tmpDir, 'mutate.mjs'),
      [
        `import { SqliteTaskStore } from ${sh(new URL('../dist/index.js', import.meta.url).pathname)};`,
        `const store = new SqliteTaskStore(${sh(dbPath)});`,
        `await store.transitionTask({ sessionId: ${sh(SESSION)}, issueNumber: 114 },`,
        `  { status: 'queued' }, { status: 'blocked', lastError: 'moved by another writer' });`,
        'store.close();',
      ].join('\n'),
      'utf8',
    );

    const r = await reconcileJson('--issue-number', '114', '--yes');
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.ok).toBe(false);
    expect(rowFor(payload, 114)).toMatchObject({ outcome: 'refused', reason: 'stale-state' });

    // The concurrent write stands; reconciliation wrote nothing on top of it.
    const task = await getTask(114);
    expect(task.status).toBe('blocked');
    expect(task.context.mergedPrReconciliations).toBeUndefined();
    expect(await getOutbox()).toHaveLength(0);

    // Re-running against the fresh row succeeds: `blocked` is an eligible status.
    const retry = await reconcileJson('--issue-number', '114', '--yes');
    expect(retry.code).toBe(0);
    expect(rowFor(parse(retry), 114)).toMatchObject({ outcome: 'reconciled', applied: true });
    expect((await getTask(114)).status).toBe('done');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Unsupported repo hosts refuse the whole invocation (§12.4)
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — unsupported provider', () => {
  test('a gitea session refuses before any task is read', async () => {
    writeSession({
      repoHostProvider: {
        provider: 'gitea',
        auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { baseUrl: 'https://gitea.example', owner: 'o', repo: 'r' },
      },
    });
    await seed(115, { status: 'queued', pr: 35 });
    writePr(35, { issueNumber: 115 });

    const r = await reconcileJson('--yes');
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload).toMatchObject({ ok: false, reasonCode: 'unsupported_provider', scanned: 0 });
    expect(payload.results).toEqual([]);
    expect(payload.error).toContain('merged');
    expect(ghCalls()).toHaveLength(0);
    expect((await getTask(115)).status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// Bulk mode across statuses
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — bulk mode', () => {
  test('scans every non-done task and reports one row per candidate', async () => {
    await seed(101, { status: 'queued', pr: 21 });
    await seed(102, { status: 'ready_for_human', phase: 'review', pr: 22 });
    await seed(103, { status: 'failed', pr: 23 });
    await seed(105, { status: 'blocked', pr: 25 });
    await seed(106, { status: 'queued' });
    await seed(120, { status: 'done', pr: 40 });
    writePr(21, { issueNumber: 101 });
    writePr(22, { issueNumber: 102, state: 'OPEN' });
    writePr(23, { issueNumber: 103 });
    writePr(25, { issueNumber: 105 });

    const r = await reconcileJson('--yes');
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.results.map((row) => row.issueNumber)).toEqual([101, 102, 103, 105, 106]);
    expect(payload).toMatchObject({
      scanned: 5,
      reconciled: 2,
      recordedTerminal: 1,
      refused: 2,
      noopDone: 0,
    });

    expect((await getTask(101)).status).toBe('done');
    expect((await getTask(105)).status).toBe('done');
    expect((await getTask(102)).status).toBe('ready_for_human');
    expect((await getTask(103)).status).toBe('failed');
    expect((await getTask(120)).status).toBe('done');
    // One comment per writing outcome, and none for the refusals.
    expect(await getOutbox()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Composition with the unchanged `worktree cleanup` (§14)
// ---------------------------------------------------------------------------

describe('admin task reconcile-merged — composition with worktree cleanup', () => {
  function cleanup(...extra) {
    return run(
      'worktree', 'cleanup',
      '--session-id', SESSION,
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--lock-dir', lockDir,
      '--json',
      ...extra,
    );
  }

  test('cleanup preserves the worktree before reconciliation and prunes it after', async () => {
    await seed(130, { status: 'ready_for_human', phase: 'review', pr: 50 });
    writePr(50, { issueNumber: 130 });
    const wt = resolveIssueWorktree({
      repoRoot,
      sessionId: SESSION,
      issueNumber: 130,
      branch: 'ai/issue-130',
      baseRef: 'main',
      worktreeRoot,
    });
    expect(existsSync(wt.path)).toBe(true);

    // Stage 1: ordinary cleanup. The task is active, so the worktree stays —
    // and cleanup makes no provider call and prints no merged-PR advisory.
    const before = await cleanup('--yes');
    expect(before.code).toBe(0);
    const beforePayload = JSON.parse(before.stdout.trim());
    expect(beforePayload.removed).toEqual([]);
    expect(JSON.stringify(withoutPaths(beforePayload))).not.toContain('merged');
    expect(existsSync(wt.path)).toBe(true);
    expect(ghCalls()).toHaveLength(0);

    // Stage 2: reconcile the externally merged PR.
    const reconciled = await reconcileJson('--issue-number', '130', '--yes');
    expect(reconciled.code).toBe(0);
    expect((await getTask(130)).status).toBe('done');
    expect(existsSync(wt.path)).toBe(true); // reconciliation touches no filesystem

    // Stage 3: the same, unchanged cleanup now sees an ordinary terminal task.
    const after = await cleanup('--yes');
    expect(after.code).toBe(0);
    const afterPayload = JSON.parse(after.stdout.trim());
    expect(afterPayload.removed.map((entry) => entry.issueNumber)).toContain(130);
    expect(existsSync(wt.path)).toBe(false);
  }, 30_000);
});
