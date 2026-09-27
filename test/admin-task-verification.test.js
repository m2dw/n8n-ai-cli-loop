/**
 * `admin task-verification show | amend | refresh-from-issue | reset` — the
 * operator surface of docs/verification-amendment-contract.md §11 (issue
 * #1042).
 *
 * The decision logic is pinned by test/verification-amend.test.js; these cases
 * pin what the COMMANDS do with it: the order-sensitive `amend` flag grammar
 * and its fail-closed bar (§11 rule 2), the mandatory `--reason` and the
 * `--op-reason` binding (§11 rule 3), preview-by-default with `--yes` applying
 * (§11 rule 1), the stable JSON payload machine callers read, the
 * human-readable rendering an operator reads, and the exit-code split (§11 rule
 * 5).
 */
import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore, VERIFICATION_AMENDMENTS_CONTEXT_KEY, deriveRequirementCommandId } from '../dist/index.js';
import { runAdmin } from './helpers/admin-cli.js';

// Every case opens a real SQLite database; give the suite the headroom the
// other store-touching admin suites use rather than Jest's 5s default.
jest.setTimeout(30_000);

const SESSION = 'addon-dev';
const ISSUE = 42;
const E2E = 'npm run e2e';
const REQ_E2E = deriveRequirementCommandId(E2E);

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;

function writeSession(overrides = {}) {
  writeFileSync(
    sessionsPath,
    JSON.stringify({
      sessions: [
        {
          sessionId: SESSION,
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

/** A task pinned at intake to a body requiring `npm run e2e`. */
async function seedTask({ status = 'ready_for_human', phase = 'review', ownerRunId, context = {} } = {}) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase,
      context: { body: ['## Verification', `- \`${E2E}\``].join('\n'), title: 'Amend me', ...context },
    });
    const patch = { status, phase };
    if (ownerRunId !== undefined) patch.ownerRunId = ownerRunId;
    if (status !== 'queued') {
      const moved = await store.transitionTask({ sessionId: SESSION, issueNumber: ISSUE }, {}, patch);
      if (!moved.ok) throw new Error(`seed failed: ${moved.code}`);
    }
  } finally {
    store.close();
  }
}

async function readTask() {
  const store = new SqliteTaskStore(dbPath);
  try {
    return await store.getTask({ sessionId: SESSION, issueNumber: ISSUE });
  } finally {
    store.close();
  }
}

async function amendmentBlock() {
  return (await readTask()).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
}

function run(action, ...args) {
  return runAdmin([
    'task-verification',
    action,
    '--session-id',
    SESSION,
    '--issue-number',
    String(ISSUE),
    '--db-path',
    dbPath,
    '--sessions-path',
    sessionsPath,
    ...args,
  ]);
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-task-verification-'));
  dbPath = join(tmpDir, 'tasks.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  writeSession();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin task-verification — discoverability', () => {
  test('all four actions appear in help with their options', async () => {
    const all = await runAdmin(['help']);
    expect(all.code).toBe(0);
    for (const name of ['task-verification show', 'task-verification amend', 'task-verification refresh-from-issue', 'task-verification reset']) {
      expect(all.stdout).toContain(name);
      const one = await runAdmin(['help', ...name.split(' ')]);
      expect(one.code).toBe(0);
      expect(one.stdout).toContain('--session-id <id>');
      expect(one.stdout).toContain('human-readable by default');
    }
    const amendHelp = await runAdmin(['help', 'task-verification', 'amend']);
    expect(amendHelp.stdout).toContain('--add-requirement');
    expect(amendHelp.stdout).toContain('--op-reason <text>');
    expect(amendHelp.stdout).toContain('--expect-plan-digest <digest>');
  });

  test('an unknown action exits non-zero and names the expected ones', async () => {
    const result = await runAdmin(['task-verification', 'plan']);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('show | amend | refresh-from-issue | reset');
  });
});

describe('admin task-verification show', () => {
  test('reports the effective plan, both layers, and the digest as JSON', async () => {
    await seedTask();
    const result = await run('show', '--json');
    expect(result.code).toBe(0);
    const payload = parse(result);
    expect(payload.ok).toBe(true);
    expect(payload.outcome).toBe('ok');
    expect(payload.taskStatus).toBe('ready_for_human');
    expect(payload.reconciliation).toBe('unamended');
    expect(payload.amendable).toBe(true);
    expect(payload.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.execution).toHaveLength(1);
    expect(payload.execution[0]).toMatchObject({ commandId: 'exec:test', state: 'active', origin: 'session-default' });
    expect(payload.requirement).toHaveLength(1);
    expect(payload.requirement[0]).toMatchObject({
      commandId: REQ_E2E,
      state: 'active',
      origin: 'issue-requirement',
      status: 'not_run',
    });
    expect(payload.revisions).toEqual([]);
  });

  test('renders human-readable text by default and writes nothing', async () => {
    await seedTask();
    const result = await run('show');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`task-verification show — issue #${ISSUE} (session ${SESSION})`);
    expect(result.stdout).toContain('execution: 1');
    expect(result.stdout).toContain('exec:test [active] npm test (session-default)');
    expect(result.stdout).toContain(`${REQ_E2E} [active] ${E2E} (issue-requirement) — not_run`);
    expect(await amendmentBlock()).toBeUndefined();
  });

  test('a claimed task is shown, with the refusal an amendment would produce', async () => {
    await seedTask({ status: 'claimed', ownerRunId: 'run-5' });
    const payload = parse(await run('show', '--json'));
    expect(payload.amendable).toBe(false);
    expect(payload.amendmentRefusal.reason).toBe('task_active');
    expect(payload.amendmentRefusal.detail).toContain('run-5');
  });

  test('an unknown task exits non-zero', async () => {
    const result = await run('show', '--json');
    expect(result.code).toBe(1);
    expect(parse(result)).toMatchObject({ ok: false, reasonCode: 'task_not_found' });
  });

  // Issue #1107 (#1094 §10 rule 6): the stage view is ADDITIVE — absent for a
  // session that has not opted in, so existing JSON consumers see no new key.
  test('a session without staged verification shows no stage view', async () => {
    await seedTask();
    const payload = parse(await run('show', '--json'));
    expect(payload.stagedVerification).toBeUndefined();
    expect((await run('show')).stdout).not.toContain('staged verification:');
  });

  test('an opted-in session with no final stage reads as not yet verified', async () => {
    writeSession({ stagedVerification: { enabled: true, testSuite: { test: { adapter: 'jest' } } } });
    await seedTask();
    const payload = parse(await run('show', '--json'));
    expect(payload.stagedVerification).toMatchObject({
      enabled: true,
      progress: 'no-final-evidence',
      state: 'absent',
      requiredChecks: 2,
      // Issue #1155 removed the regression set and the loop pin set from the
      // view with the selection policy they narrowed.
      retainedTestFiles: [],
    });
    expect(payload.stagedVerification.regressionSet).toBeUndefined();
    expect(payload.stagedVerification.loopPinSet).toBeUndefined();
    const text = (await run('show')).stdout;
    expect(text).toContain('staged verification: enabled — no-final-evidence');
    expect(text).toContain('required checks (what a final stage runs): 2');
  });

  test('a pending approval and a withheld final record are distinguishable from completed evidence', async () => {
    writeSession({ stagedVerification: { enabled: true, testSuite: { test: { adapter: 'jest' } } } });
    await seedTask({
      context: { finalStageApproval: { headSha: 'b'.repeat(40), approval: { result: 'success' } } },
    });
    const payload = parse(await run('show', '--json'));
    expect(payload.stagedVerification.progress).toBe('final-pending');
    expect(payload.stagedVerification.pendingApprovalHeadSha).toBe('b'.repeat(40));
    expect((await run('show')).stdout).toContain(`pending final verification of approved head ${'b'.repeat(40)}`);
  });
});

describe('admin task-verification amend', () => {
  test('previews an added requirement and writes nothing without --yes', async () => {
    await seedTask();
    const result = await run(
      'amend',
      '--add-requirement',
      '--command',
      'npm run lint',
      '--reason',
      'the Issue omitted the lint gate',
      '--json',
    );
    expect(result.code).toBe(0);
    const payload = parse(result);
    expect(payload.outcome).toBe('preview');
    expect(payload.applied).toBe(false);
    expect(payload.operationKinds).toEqual(['add']);
    expect(payload.operations[0]).toContain('add requirement: npm run lint');
    expect(payload.basePlanDigest).not.toBe(payload.planDigest);
    expect(payload.resultingPlan.some((line) => line.includes('npm run lint'))).toBe(true);
    expect(payload.currentPlan.some((line) => line.includes('npm run lint'))).toBe(false);
    expect(await amendmentBlock()).toBeUndefined();
  });

  test('--yes applies one revision and the resulting plan is what the preview showed', async () => {
    await seedTask();
    const args = [
      '--add-requirement',
      '--command',
      'npm run lint',
      '--reason',
      'the Issue omitted the lint gate',
      '--json',
    ];
    const preview = parse(await run('amend', ...args));
    const applied = parse(await run('amend', ...args, '--yes'));
    expect(applied.outcome).toBe('applied');
    expect(applied.applied).toBe(true);
    expect(applied.revisionOrdinal).toBe(1);
    expect(applied.planDigest).toBe(preview.planDigest);

    const block = await amendmentBlock();
    expect(block.revisions).toHaveLength(1);
    expect(block.revisions[0].source).toBe('admin-cli');
    expect(block.revisions[0].operations[0].reason).toBe('the Issue omitted the lint gate');
    expect(block.checkpoint.planDigest).toBe(applied.planDigest);
    // Issue #1043: the applied revision took the §9.2 row default and
    // re-queued the review-lane park; the intake context is untouched.
    const task = await readTask();
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
    expect(task.context.title).toBe('Amend me');
  });

  test('a routed apply retracts the stack-ready marker atomically with the re-queue', async () => {
    // Issue #1043 review: a ready_for_human/review park that came from a
    // passing review still carries the success-only stack-ready marker —
    // dependency-plan.ts accepts it as implementation-complete on its own —
    // so the re-queue must enqueue its removal in the same transaction.
    await seedTask();
    const applied = parse(
      await run(
        'amend',
        '--add-requirement',
        '--command',
        'npm run lint',
        '--reason',
        'the Issue omitted the lint gate',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');
    expect((await readTask()).status).toBe('queued');

    const outbox = new SqliteOutboxStore(dbPath);
    try {
      const rows = (await outbox.listPending())
        .filter((entry) => entry.topic.startsWith('gh:label:'))
        .map((entry) => `${entry.topic} ${entry.payload.label}`);
      expect(rows).toContain('gh:label:remove status:stack-ready');
      expect(rows).toContain('gh:label:remove ai:ready-for-human');
    } finally {
      outbox.close();
    }
  });

  test('several operations in one invocation compose in order, with --op-reason binding to its own', async () => {
    await seedTask();
    const applied = parse(
      await run(
        'amend',
        '--replace',
        REQ_E2E,
        '--command',
        'npm run e2e -- --ci',
        '--op-reason',
        'the flag was missing',
        '--add-execution',
        'lint',
        '--command',
        'npm run lint',
        '--retire',
        'exec:test',
        '--reason',
        'correcting the plan after intake',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');
    expect(applied.operationKinds).toEqual(['replace', 'add', 'retire']);

    const [revision] = (await amendmentBlock()).revisions;
    expect(revision.operations[0]).toMatchObject({
      kind: 'replace',
      commandId: REQ_E2E,
      command: 'npm run e2e -- --ci',
      reason: 'the flag was missing',
    });
    // §5.2 rule 1: the revision-level reason is materialized onto every
    // operation that carries none of its own.
    expect(revision.operations[1].reason).toBe('correcting the plan after intake');
    expect(revision.operations[2].reason).toBe('correcting the plan after intake');

    const shown = parse(await run('show', '--json'));
    expect(shown.execution.map((slot) => [slot.commandId, slot.state])).toEqual([
      ['exec:test', 'retired'],
      ['exec:lint', 'active'],
    ]);
    expect(shown.requirement[0].command).toBe('npm run e2e -- --ci');
    expect(shown.requirement[0].amended).toBe(true);
  });

  test('padded --command bytes are end-trimmed before identity is derived, interior whitespace kept', async () => {
    await seedTask();
    const padded = [
      '--replace',
      REQ_E2E,
      '--command',
      '  npm run e2e -- --ci\t',
      '--add-requirement',
      '--command',
      '\n npm run lint -- --format "a  b" ',
      '--reason',
      'correcting the plan after intake',
      '--json',
    ];
    const trimmed = [
      '--replace',
      REQ_E2E,
      '--command',
      'npm run e2e -- --ci',
      '--add-requirement',
      '--command',
      'npm run lint -- --format "a  b"',
      '--reason',
      'correcting the plan after intake',
      '--json',
    ];
    const paddedPreview = parse(await run('amend', ...padded));
    const trimmedPreview = parse(await run('amend', ...trimmed));
    expect(paddedPreview.outcome).toBe('preview');
    // §2: the CLI authors the bytes, so padding never reaches identity — the
    // two invocations are the same revision, request key and digest included.
    expect(paddedPreview.revisionId).toBe(trimmedPreview.revisionId);
    expect(paddedPreview.requestKey).toBe(trimmedPreview.requestKey);
    expect(paddedPreview.planDigest).toBe(trimmedPreview.planDigest);
    expect(paddedPreview.operations).toEqual(trimmedPreview.operations);

    const applied = parse(await run('amend', ...padded, '--yes'));
    expect(applied.outcome).toBe('applied');
    const [revision] = (await amendmentBlock()).revisions;
    expect(revision.operations.map((operation) => operation.command)).toEqual([
      'npm run e2e -- --ci',
      // Interior whitespace is data (§2) and survives verbatim.
      'npm run lint -- --format "a  b"',
    ]);
    const shown = parse(await run('show', '--json'));
    expect(shown.requirement.map((slot) => slot.command)).toEqual([
      'npm run e2e -- --ci',
      'npm run lint -- --format "a  b"',
    ]);
  });

  test('unknown, abbreviated, malformed, and reasonless invocations exit non-zero and mutate nothing', async () => {
    await seedTask();
    const cases = [
      // Unknown and abbreviated flags (§11 rule 2).
      ['--add-requirement', '--command', 'npm run lint', '--reason', 'r', '--ye'],
      ['--add-requirement', '--command', 'npm run lint', '--reaso', 'r'],
      ['--add-requirement', '--command', 'npm run lint', '--reason', 'r', '--op-reaso', 'x'],
      ['--add-requirement', '--command', 'npm run lint', '--reason', 'r', '--expect-plan-diges', 'a'],
      // A mandatory, non-empty reason (§11 rule 3).
      ['--add-requirement', '--command', 'npm run lint', '--yes'],
      ['--add-requirement', '--command', 'npm run lint', '--reason', '   ', '--yes'],
      // An operation clause that is not complete.
      ['--add-requirement', '--reason', 'r', '--yes'],
      ['--replace', REQ_E2E, '--reason', 'r', '--yes'],
      ['--command', 'npm run lint', '--reason', 'r', '--yes'],
      // A `--command` the operation does not accept, and a doubled one.
      ['--retire', REQ_E2E, '--command', 'npm test', '--reason', 'r', '--yes'],
      ['--add-requirement', '--command', 'a', '--command', 'b', '--reason', 'r', '--yes'],
      // A `--command` that is empty once end-trimmed (§2) is not command bytes.
      ['--add-requirement', '--command', '  \t ', '--reason', 'r', '--yes'],
      // An `--op-reason` that binds to nothing, is doubled, or is empty.
      ['--op-reason', 'x', '--add-requirement', '--command', 'a', '--reason', 'r', '--yes'],
      ['--add-requirement', '--command', 'a', '--op-reason', 'x', '--op-reason', 'y', '--reason', 'r', '--yes'],
      ['--add-requirement', '--command', 'a', '--op-reason', '  ', '--reason', 'r', '--yes'],
      // No operation at all, an unrecognized continuation, and a bad request key.
      ['--reason', 'r', '--yes'],
      ['--add-requirement', '--command', 'a', '--reason', 'r', '--continue', 'requeue', '--yes'],
      ['--add-requirement', '--command', 'a', '--reason', 'r', '--request-key', 'not a key!', '--yes'],
    ];
    for (const args of cases) {
      const result = await run('amend', ...args, '--json');
      expect({ args, code: result.code }).toMatchObject({ args, code: 1 });
    }
    expect(await amendmentBlock()).toBeUndefined();
  });

  test('a claimed task refuses the apply and previews without writing', async () => {
    await seedTask({ status: 'claimed', ownerRunId: 'run-8' });
    const refused = await run(
      'amend',
      '--add-requirement',
      '--command',
      'npm run lint',
      '--reason',
      'r',
      '--yes',
      '--json',
    );
    expect(refused.code).toBe(1);
    const payload = parse(refused);
    expect(payload.reasonCode).toBe('task_active');
    expect(payload.error).toContain('run-8');
    expect(await amendmentBlock()).toBeUndefined();

    const preview = await run('amend', '--add-requirement', '--command', 'npm run lint', '--reason', 'r', '--json');
    expect(preview.code).toBe(0);
    expect(parse(preview).outcome).toBe('preview');
  });

  test('--expect-plan-digest refuses a plan that moved and applies the one it named', async () => {
    await seedTask();
    const preview = parse(
      await run('amend', '--add-requirement', '--command', 'npm run lint', '--reason', 'r', '--json'),
    );

    const stale = await run(
      'amend',
      '--add-requirement',
      '--command',
      'npm run lint',
      '--reason',
      'r',
      '--expect-plan-digest',
      'a'.repeat(64),
      '--yes',
      '--json',
    );
    expect(stale.code).toBe(1);
    expect(parse(stale).reasonCode).toBe('plan_digest_mismatch');
    expect(await amendmentBlock()).toBeUndefined();

    const ok = await run(
      'amend',
      '--add-requirement',
      '--command',
      'npm run lint',
      '--reason',
      'r',
      '--expect-plan-digest',
      preview.basePlanDigest,
      '--yes',
      '--json',
    );
    expect(ok.code).toBe(0);
    expect(parse(ok).outcome).toBe('applied');
  });

  test('a rerun of the same applied command line is reported as a replay of its revision', async () => {
    await seedTask();
    const args = ['--add-requirement', '--command', 'npm run lint', '--reason', 'r', '--yes', '--json'];
    const first = parse(await run('amend', ...args));
    expect(first.outcome).toBe('applied');

    const second = await run('amend', ...args);
    expect(second.code).toBe(0);
    const payload = parse(second);
    expect(payload.outcome).toBe('replay');
    expect(payload.applied).toBe(false);
    expect(payload.revisionId).toBe(first.revisionId);
    expect((await amendmentBlock()).revisions).toHaveLength(1);
  });

  test('the human rendering names both digests and the continuation it recorded', async () => {
    await seedTask();
    const result = await run('amend', '--add-requirement', '--command', 'npm run lint', '--reason', 'r');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`task-verification amend — issue #${ISSUE} (session ${SESSION})`);
    expect(result.stdout).toContain('operations: 1');
    expect(result.stdout).toContain('add requirement: npm run lint');
    expect(result.stdout).toMatch(/plan digest: [0-9a-f]{64} -> [0-9a-f]{64}/);
    // Issue #1043: the preview names the §9.2 route `--yes` would take.
    expect(result.stdout).toContain('continuation (on --yes): review — would re-queue {queued, review}');
    expect(result.stdout).toContain('Preview only.');
  });
});

describe('admin task-verification reset', () => {
  test('reverts a replacement and restores a retirement, back to the baseline digest', async () => {
    await seedTask();
    const baseline = parse(await run('show', '--json')).planDigest;
    const amended = parse(
      await run(
        'amend',
        '--replace',
        REQ_E2E,
        '--command',
        'npm run e2e -- --ci',
        '--retire',
        'exec:test',
        '--reason',
        'a correction that turned out to be wrong',
        '--yes',
        '--json',
      ),
    );
    expect(amended.planDigest).not.toBe(baseline);

    const preview = parse(await run('reset', '--reason', 'undo the amendments', '--json'));
    expect(preview.outcome).toBe('preview');
    expect(preview.restores).toHaveLength(1);
    expect(preview.reverts).toHaveLength(1);
    expect(preview.planDigest).toBe(baseline);
    expect((await amendmentBlock()).revisions).toHaveLength(1);

    const applied = parse(await run('reset', '--reason', 'undo the amendments', '--yes', '--json'));
    expect(applied.outcome).toBe('applied');
    expect(applied.operationKinds).toEqual(['restore', 'replace']);
    expect(applied.planDigest).toBe(baseline);
    // Append-only: the reversal is a second revision, not an erasure.
    expect((await amendmentBlock()).revisions).toHaveLength(2);
  });

  test('a task-local addition is withheld without --allow-retire and retired with it', async () => {
    await seedTask();
    await run('amend', '--add-requirement', '--command', 'npm run lint', '--reason', 'added', '--yes', '--json');

    const withheld = await run('reset', '--reason', 'undo it', '--yes', '--json');
    expect(withheld.code).toBe(0);
    const payload = parse(withheld);
    expect(payload.outcome).toBe('no_change');
    expect(payload.withheldRetirements).toHaveLength(1);
    expect(payload.message).toContain('--allow-retire');
    expect((await amendmentBlock()).revisions).toHaveLength(1);

    const applied = parse(await run('reset', '--reason', 'undo it', '--allow-retire', '--yes', '--json'));
    expect(applied.outcome).toBe('applied');
    expect(applied.operationKinds).toEqual(['retire']);

    const shown = parse(await run('show', '--json'));
    const slot = shown.requirement.find((entry) => entry.command === 'npm run lint');
    expect(slot.state).toBe('retired');
    expect(slot.status).toBe('retired');
  });

  test('the preview names the request key that makes a lost-response rerun a replay', async () => {
    await seedTask();
    await run('amend', '--replace', REQ_E2E, '--command', 'npm run e2e -- --ci', '--reason', 'r', '--yes', '--json');

    const preview = parse(await run('reset', '--reason', 'undo the amendment', '--json'));
    expect(preview.outcome).toBe('preview');
    const human = await run('reset', '--reason', 'undo the amendment');
    expect(human.stdout).toContain(
      `Re-run with --yes --expect-plan-digest ${preview.basePlanDigest} --request-key ${preview.requestKey}`,
    );

    const args = [
      'reset',
      '--reason',
      'undo the amendment',
      '--expect-plan-digest',
      preview.basePlanDigest,
      '--request-key',
      preview.requestKey,
      '--yes',
      '--json',
    ];
    const applied = parse(await run(...args));
    expect(applied.outcome).toBe('applied');

    // The rerun still carries the digest the preview named, which the apply has
    // already moved: a replay, exit zero, and no second revision.
    const rerun = await run(...args);
    expect(rerun.code).toBe(0);
    const payload = parse(rerun);
    expect(payload.outcome).toBe('replay');
    expect(payload.applied).toBe(false);
    expect(payload.revisionId).toBe(applied.revisionId);
    expect((await amendmentBlock()).revisions).toHaveLength(2);
  });

  test('an unamended plan resets to nothing and exits zero; an active task still refuses', async () => {
    await seedTask();
    const quiet = await run('reset', '--reason', 'nothing to undo', '--yes', '--json');
    expect(quiet.code).toBe(0);
    expect(parse(quiet).outcome).toBe('no_change');
    expect(await amendmentBlock()).toBeUndefined();

    const store = new SqliteTaskStore(dbPath);
    try {
      await store.transitionTask({ sessionId: SESSION, issueNumber: ISSUE }, {}, { status: 'claimed', ownerRunId: 'run-2' });
    } finally {
      store.close();
    }
    const refused = await run('reset', '--reason', 'nothing to undo', '--yes', '--json');
    expect(refused.code).toBe(1);
    expect(parse(refused).reasonCode).toBe('task_active');
  });

  test('a malformed request key or an overlong reason refuses even when there is nothing to undo', async () => {
    // Both invocations resolve to zero operations, so neither reaches the amend
    // the reset composes; the input rules still hold on that path.
    await seedTask();
    const badKey = await run('reset', '--reason', 'nothing to undo', '--request-key', 'bad key', '--yes', '--json');
    expect(badKey.code).toBe(1);
    expect(parse(badKey).reasonCode).toBe('invalid_request_key');

    const longReason = await run('reset', '--reason', 'x'.repeat(2001), '--yes', '--json');
    expect(longReason.code).toBe(1);
    expect(parse(longReason).reasonCode).toBe('invalid_reason');
    expect(await amendmentBlock()).toBeUndefined();
  });

  test('unknown and abbreviated flags exit non-zero', async () => {
    await seedTask();
    for (const args of [['--reason', 'r', '--allow-retir'], ['--reason', 'r', '--ye'], ['--yes']]) {
      const result = await run('reset', ...args, '--json');
      expect(result.code).toBe(1);
    }
  });
});

describe('admin task-verification refresh-from-issue', () => {
  test('reports itself under the resource-oriented name and refuses an unsupported provider', async () => {
    writeSession({
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { baseUrl: 'https://gitea.example', owner: 'm2dw', repo: 'some-repo' },
      },
    });
    await seedTask();
    const result = await run('refresh-from-issue', '--reason', 'the Issue was corrected', '--yes', '--json');
    expect(result.code).toBe(1);
    const payload = parse(result);
    expect(payload.reasonCode).toBe('unsupported_provider');
    expect(payload.command).toBe('task-verification refresh-from-issue');
    expect(await amendmentBlock()).toBeUndefined();
  });

  test('inherits the refresh flag bar (an abbreviated --allow-retire is refused)', async () => {
    await seedTask();
    const result = await run('refresh-from-issue', '--reason', 'r', '--allow-retir', '--json');
    expect(result.code).toBe(1);
  });
});
