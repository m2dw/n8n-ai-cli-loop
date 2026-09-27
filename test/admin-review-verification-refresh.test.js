// Issue #1041 — `admin review-verification refresh`, the operator surface of
// docs/verification-amendment-contract.md §10 (§15 slice A6).
//
// Drives the shipped CLI against a fake `gh` so the GitHub work-item path is
// covered end to end: preview by default, `--yes` to apply, the §11 rule 2
// fail-closed flag bar, the withheld-retirement report, the concurrent-edit
// guard, and the unsupported-provider refusal.
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, VERIFICATION_AMENDMENTS_CONTEXT_KEY } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;
let fakeGhDir;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}` },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function refresh(...args) {
  return run(
    'review-verification', 'refresh',
    '--session-id', 'addon-dev',
    '--issue-number', '41',
    '--db-path', dbPath,
    '--sessions-path', sessionsPath,
    '--json',
    ...args,
  );
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

/** A fake `gh` whose `issue view` returns a body listing `commands`. */
function writeFakeGh(commands) {
  const payload = JSON.stringify({
    number: 41,
    state: 'OPEN',
    title: 'Refresh me',
    body: ['## Background', 'prose', '', '## Verification', ...commands.map((c) => `- \`${c}\``)].join('\n'),
    labels: [],
  });
  const script =
    '#!/bin/sh\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then\n' +
    `  cat <<'JSON'\n${payload}\nJSON\n` +
    '  exit 0\n' +
    'fi\n' +
    'exit 1\n';
  const path = join(fakeGhDir, 'gh');
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
}

function writeSession(overrides = {}) {
  writeFileSync(
    sessionsPath,
    JSON.stringify({
      sessions: [
        {
          sessionId: 'addon-dev',
          repoKey: 'some-repo',
          repoRoot,
          githubRepo: 'm2dw/some-repo',
          artifactDir: '.n8n-artifacts',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: { test: 'npm test' },
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
          ...overrides,
        },
      ],
    }),
    'utf8',
  );
}

/** The task, pinned at intake to a body requiring `npm test` alone. */
async function seedTask(pinnedCommands = ['npm test']) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 41,
      phase: 'review',
      context: {
        body: ['## Verification', ...pinnedCommands.map((c) => `- \`${c}\``)].join('\n'),
        title: 'Refresh me',
      },
    });
    await store.transitionTask({ sessionId: 'addon-dev', issueNumber: 41 }, {}, { status: 'ready_for_human' });
  } finally {
    store.close();
  }
}

async function readTask() {
  const store = new SqliteTaskStore(dbPath);
  try {
    return await store.getTask({ sessionId: 'addon-dev', issueNumber: 41 });
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-refresh-test-'));
  dbPath = join(tmpDir, 'tasks.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
  fakeGhDir = join(tmpDir, 'bin');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(fakeGhDir, { recursive: true });
  writeSession();
  writeFakeGh(['npm test']);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin review-verification refresh', () => {
  test('previews an added requirement and writes nothing without --yes', async () => {
    await seedTask();
    writeFakeGh(['npm test', 'npm run e2e']);

    const result = refresh('--reason', 'the Issue verification section was corrected');
    expect(result.code).toBe(0);
    const payload = parse(result);
    expect(payload.outcome).toBe('preview');
    expect(payload.applied).toBe(false);
    expect(payload.adds).toHaveLength(1);
    expect(payload.adds[0]).toContain('npm run e2e');
    expect(payload.replacements).toEqual([]);
    expect(payload.issueBodyDigest).toMatch(/^[0-9a-f]{64}$/);

    const task = await readTask();
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);

  test('--yes applies the difference as one revision and leaves the task body pinned', async () => {
    await seedTask();
    writeFakeGh(['npm test', 'npm run e2e']);

    const result = refresh('--reason', 'the Issue verification section was corrected', '--yes');
    expect(result.code).toBe(0);
    const payload = parse(result);
    expect(payload.outcome).toBe('applied');
    expect(payload.revisionOrdinal).toBe(1);
    expect(payload.operations).toEqual(['add']);

    const task = await readTask();
    const block = task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(block.revisions).toHaveLength(1);
    expect(block.revisions[0].source).toBe('issue-refresh');
    expect(block.revisions[0].issueBodyDigest).toBe(payload.issueBodyDigest);
    // §10 rule 1: the intake snapshot is never refreshed. Issue #1043: the
    // §9.2 default re-queued the review-lane park to {queued, review}.
    expect(task.context.body).not.toContain('npm run e2e');
    expect(task.context.title).toBe('Refresh me');
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
  }, 30_000);

  test('a retirement is withheld and reported without --allow-retire', async () => {
    await seedTask(['npm test', 'npm run e2e']);
    writeFakeGh(['npm test']);

    const withheld = parse(refresh('--reason', 'the Issue dropped a requirement', '--yes'));
    expect(withheld.outcome).toBe('no_change');
    expect(withheld.withheldRetirements).toHaveLength(1);
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();

    const applied = parse(
      refresh('--reason', 'the Issue dropped a requirement', '--yes', '--allow-retire'),
    );
    expect(applied.outcome).toBe('applied');
    expect(applied.operations).toEqual(['retire']);
  }, 30_000);

  test('--expect-issue-digest refuses when the Issue moved, and applies when it did not', async () => {
    await seedTask();
    writeFakeGh(['npm test', 'npm run e2e']);
    const preview = parse(refresh('--reason', 'corrected'));

    writeFakeGh(['npm test', 'npm run e2e', 'npm run lint']);
    const stale = refresh('--reason', 'corrected', '--yes', '--expect-issue-digest', preview.issueBodyDigest);
    expect(stale.code).toBe(1);
    expect(parse(stale).reasonCode).toBe('stale_preview');
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();

    writeFakeGh(['npm test', 'npm run e2e']);
    const ok = refresh('--reason', 'corrected', '--yes', '--expect-issue-digest', preview.issueBodyDigest);
    expect(ok.code).toBe(0);
    expect(parse(ok).outcome).toBe('applied');
  }, 30_000);

  // Issue #1044 review (P2): a refresh diffs the live Issue against the TASK's
  // effective plan, so an amendment applied between the preview and the apply
  // changes the difference while the Issue body — and therefore its digest —
  // stays byte-identical. The Issue guard alone cannot see that.
  test('--expect-plan-digest refuses when another amendment moved the plan under an unchanged Issue', async () => {
    await seedTask();
    writeFakeGh(['npm test', 'npm run e2e']);
    const preview = parse(refresh('--reason', 'corrected'));
    expect(preview.outcome).toBe('preview');

    // A concurrent operator correction, on the same task, touching no Issue.
    const amended = run(
      'task-verification', 'amend',
      '--session-id', 'addon-dev',
      '--issue-number', '41',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--json',
      '--add-requirement', '--command', 'npm run lint',
      '--reason', 'the lint gate is required too',
      '--yes',
    );
    expect(amended.code).toBe(0);
    const movedPlanDigest = parse(amended).planDigest;
    expect(movedPlanDigest).not.toBe(preview.basePlanDigest);

    const stale = refresh(
      '--reason', 'corrected', '--yes',
      '--expect-issue-digest', preview.issueBodyDigest,
      '--expect-plan-digest', preview.basePlanDigest,
    );
    expect(stale.code).toBe(1);
    const refusal = parse(stale);
    expect(refusal.reasonCode).toBe('stale_preview');
    expect(refusal.error).toContain(preview.basePlanDigest);
    // Nothing was written: the chain still carries only the concurrent amend.
    const afterRefusal = (await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(afterRefusal.revisions).toHaveLength(1);

    // Re-previewed against the plan as it now stands, the same apply lands.
    const ok = refresh(
      '--reason', 'corrected', '--yes',
      '--expect-issue-digest', preview.issueBodyDigest,
      '--expect-plan-digest', movedPlanDigest,
    );
    expect(ok.code).toBe(0);
    expect(parse(ok).outcome).toBe('applied');
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(2);

    // A retry of that same apply — the lost-response case — reruns into the
    // plan it itself produced, so its digest has necessarily moved. The §10
    // rule 7 no-op recognition comes first, so the retry is reported as the
    // repeat it is rather than as a concurrent-edit conflict, and still writes
    // nothing.
    const retried = refresh(
      '--reason', 'corrected', '--yes',
      '--expect-issue-digest', preview.issueBodyDigest,
      '--expect-plan-digest', movedPlanDigest,
    );
    expect(retried.code).toBe(0);
    expect(['no_change', 'replay']).toContain(parse(retried).outcome);
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(2);
  }, 30_000);

  // The guard cannot be skipped just because the diff came out empty: the
  // concurrent amendment that emptied it is exactly the change the operator
  // never previewed, and exiting zero there would report success against a plan
  // that moved (issue #1044 review, P2).
  test('--expect-plan-digest refuses when a concurrent amendment left the refresh nothing to do', async () => {
    await seedTask();
    writeFakeGh(['npm test', 'npm run e2e']);
    const preview = parse(refresh('--reason', 'corrected'));
    expect(preview.outcome).toBe('preview');
    expect(preview.operations).toHaveLength(1);

    // The same correction, applied task-locally by someone else: the live Issue
    // and the effective plan now agree, so the refresh has nothing left to do.
    const amended = run(
      'task-verification', 'amend',
      '--session-id', 'addon-dev',
      '--issue-number', '41',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--json',
      '--add-requirement', '--command', 'npm run e2e',
      '--reason', 'corrected here instead',
      '--yes',
    );
    expect(amended.code).toBe(0);

    const stale = refresh(
      '--reason', 'corrected', '--yes',
      '--expect-issue-digest', preview.issueBodyDigest,
      '--expect-plan-digest', preview.basePlanDigest,
    );
    expect(stale.code).toBe(1);
    expect(parse(stale).reasonCode).toBe('stale_preview');
    // Still just the concurrent amend: the refusal wrote nothing.
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);

    // Unguarded, the same invocation is the §10 rule 7 no-op it always was.
    const unguarded = refresh('--reason', 'corrected', '--yes');
    expect(unguarded.code).toBe(0);
    expect(parse(unguarded).outcome).toBe('no_change');
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
  }, 30_000);

  test('a no-difference refresh exits zero and records nothing', async () => {
    await seedTask();
    const result = refresh('--reason', 'nothing changed', '--yes');
    expect(result.code).toBe(0);
    expect(parse(result).outcome).toBe('no_change');
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);

  // A `no_change` names no revision, so it prints no `base -> new` pair — but it
  // did resolve a plan, and a caller carrying this preview into an apply has no
  // other honest source for the digest to guard on (issue #1044 review, P1).
  test('a no-difference refresh reports the plan digest it resolved', async () => {
    await seedTask();
    const payload = parse(refresh('--reason', 'nothing changed'));
    expect(payload.outcome).toBe('no_change');
    expect(payload.planDigest).toMatch(/^[0-9a-f]{64}$/);

    const rendered = run(
      'review-verification', 'refresh',
      '--session-id', 'addon-dev',
      '--issue-number', '41',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--reason', 'nothing changed',
    );
    expect(rendered.code).toBe(0);
    // Same words as the amend/reset renderer's own no-change line, so one
    // parser reads both surfaces.
    expect(rendered.stdout).toContain(`  plan digest: ${payload.planDigest} (unchanged)`);
    expect(rendered.stdout).toContain('No difference to apply. No revision was recorded.');
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);

  test('a no-difference refresh on an active task refuses non-zero (§7.2 rules 1 and 4)', async () => {
    await seedTask();
    const store = new SqliteTaskStore(dbPath);
    try {
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 41 },
        {},
        { status: 'claimed', ownerRunId: 'run-1' },
      );
    } finally {
      store.close();
    }

    // Exit zero here is the §11 rule 5 no-change case only for a task that may
    // be amended; on a `claimed` task the §7.1 refusal comes first, so scripted
    // use cannot read an active-task apply as an allowed no-op.
    const result = refresh('--reason', 'nothing changed', '--yes');
    expect(result.code).toBe(1);
    const payload = parse(result);
    expect(payload.reasonCode).toBe('task_active');
    expect(payload.error).toContain('run-1');
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);

  test('a non-GitHub work-item provider refuses as unsupported and never calls the provider', async () => {
    writeSession({
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { baseUrl: 'https://gitea.example', owner: 'm2dw', repo: 'some-repo' },
      },
    });
    await seedTask();
    const result = refresh('--reason', 'corrected', '--yes');
    expect(result.code).toBe(1);
    expect(parse(result).reasonCode).toBe('unsupported_provider');
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);

  test('unknown, abbreviated, and empty flags exit non-zero and mutate nothing', async () => {
    await seedTask();
    writeFakeGh(['npm test', 'npm run e2e']);

    for (const args of [
      ['--reason', 'corrected', '--ye'],
      ['--reason', 'corrected', '--allow-retir'],
      ['--reaso', 'corrected'],
      ['--reason', '   ', '--yes'],
      ['--reason', 'corrected', '--request-key', 'not a key!', '--yes'],
    ]) {
      const result = refresh(...args);
      expect(result.code).not.toBe(0);
    }
    expect((await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);

  test('a rerun of the same applied command line is reported as a replay of its revision', async () => {
    await seedTask();
    writeFakeGh(['npm test', 'npm run e2e']);
    const first = parse(refresh('--reason', 'corrected', '--yes'));
    expect(first.outcome).toBe('applied');

    // §5.3 rules 1 and 3: a rerun after a lost response reads what its own first
    // attempt already applied, and gets that revision named back — exit zero, no
    // second revision, and an answer the operator can tell apart from a refresh
    // that never applied anything.
    const second = refresh('--reason', 'corrected', '--yes');
    expect(second.code).toBe(0);
    const payload = parse(second);
    expect(payload.outcome).toBe('replay');
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBe(false);
    expect(payload.revisionId).toBe(first.revisionId);
    expect(payload.revisionOrdinal).toBe(1);
    expect(payload.requestKey).toBe(first.requestKey);

    const task = await readTask();
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
  }, 30_000);

  test('a rerun carrying the same --request-key replays without calling the provider', async () => {
    await seedTask();
    writeFakeGh(['npm test', 'npm run e2e']);
    const first = parse(refresh('--reason', 'corrected', '--yes', '--request-key', 'ops-1'));
    expect(first.outcome).toBe('applied');
    expect(first.requestKey).toBe('ops-1');

    // The chain lookup precedes the live read, so a `gh` that can no longer
    // answer cannot turn the retry into a provider refusal.
    writeFileSync(join(fakeGhDir, 'gh'), '#!/bin/sh\nexit 3\n', 'utf8');
    chmodSync(join(fakeGhDir, 'gh'), 0o755);

    const second = refresh('--reason', 'corrected', '--yes', '--request-key', 'ops-1');
    expect(second.code).toBe(0);
    expect(parse(second).outcome).toBe('replay');
    expect(parse(second).revisionId).toBe(first.revisionId);

    const task = await readTask();
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
  }, 30_000);
});
