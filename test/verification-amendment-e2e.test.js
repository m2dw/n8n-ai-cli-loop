/**
 * End-to-end lifecycle of an operator-owned verification amendment (issue
 * #1044, docs/verification-amendment-contract.md §15 slice A7).
 *
 * Every case below drives the SHIPPED commands against a real SQLite task
 * store and a real outbox, and asserts what an operator and a reader of the
 * work item actually get: the corrected plan, the transition it produced, the
 * one bounded comment it published, and the refusals that write nothing. The
 * scenarios are the ones the issue enumerates —
 *
 *   1. an Issue typo corrected and refreshed from the live Issue;
 *   2. a task-local replacement;
 *   3. a removal with a reason;
 *   4. a stale preview;
 *   5. a claimed/running rejection;
 *   6. evidence invalidation (and the §13.1 orphaned-command refusal);
 *   7. direct review continuation;
 *   8. crash/retry and duplicate publication;
 *   9. reset to baseline
 *
 * — plus the two cross-surface claims: that `admin ui` builds the same commands
 * the CLI takes, and that no published comment carries a local path.
 */
import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteTaskStore,
  SqliteOutboxStore,
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  deriveRequirementCommandId,
  verificationAmendmentCommentIdempotencyKey,
} from '../dist/index.js';
import {
  buildTaskVerificationAmendArgv,
  buildTaskVerificationResetArgv,
  buildTaskVerificationShowArgv,
  newVerificationRequestKey,
  parseVerificationPlanView,
  formatVerificationPlanDetail,
  previousAmendmentReason,
  verificationContinuationChoices,
  buildTaskMenuActions,
  hasVerificationAmendments,
} from '../dist/cli/admin-ui.js';
import { runAdmin } from './helpers/admin-cli.js';

// Real SQLite plus a spawned `gh` for the refresh case: well past Jest's 5s.
jest.setTimeout(60_000);

const SESSION = 'addon-dev';
const ISSUE = 42;
/** The typo the Issue was filed with, and the command it should have named. */
const TYPO = 'npm run e2e-tets';
const FIXED = 'npm run e2e';
const REQ_TYPO = deriveRequirementCommandId(TYPO);

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;
let fakeGhDir;

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

/** A fake `gh` whose `issue view` returns a body listing `commands`. */
function writeFakeGh(commands) {
  const payload = JSON.stringify({
    number: ISSUE,
    state: 'OPEN',
    title: 'Amend me',
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

async function seedTask({
  status = 'ready_for_human',
  phase = 'review',
  ownerRunId,
  requirements = [TYPO],
  context = {},
} = {}) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase,
      context: {
        body: ['## Verification', ...requirements.map((c) => `- \`${c}\``)].join('\n'),
        title: 'Amend me',
        ...context,
      },
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

/** Every pending comment row, in insertion order. */
async function commentRows() {
  const outbox = new SqliteOutboxStore(dbPath);
  try {
    return (await outbox.listPending()).filter((entry) => entry.topic === 'gh:comment');
  } finally {
    outbox.close();
  }
}

/** Every pending sticky PR-summary row (the human-gate comment lives here). */
async function prSummaryRows() {
  const outbox = new SqliteOutboxStore(dbPath);
  try {
    return (await outbox.listPending()).filter((entry) => entry.topic === 'repohost:pr-summary');
  } finally {
    outbox.close();
  }
}

/** The amendment comments only — the label rows and any other topic excluded. */
async function amendmentComments() {
  return (await commentRows()).filter((entry) =>
    entry.idempotencyKey.includes(':verification-amendment:'),
  );
}

function run(action, ...args) {
  return runAdmin(
    [
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
    ],
    { env: { PATH: `${fakeGhDir}:${process.env.PATH}` } },
  );
}

function runArgv(argv) {
  return runAdmin(argv, { env: { PATH: `${fakeGhDir}:${process.env.PATH}` } });
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

/** A task as the UI builders take it. */
function uiTask(overrides = {}) {
  return { sessionId: SESSION, issueNumber: ISSUE, status: 'ready_for_human', phase: 'review', ...overrides };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'verification-amendment-e2e-'));
  dbPath = join(tmpDir, 'tasks.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
  fakeGhDir = join(tmpDir, 'bin');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(fakeGhDir, { recursive: true });
  writeSession();
  writeFakeGh([FIXED]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The Issue typo, corrected and refreshed
// ---------------------------------------------------------------------------

describe('an Issue typo corrected and refreshed', () => {
  test('the live Issue replaces the typo, the plan follows, and one comment reports it', async () => {
    await seedTask();

    const preview = parse(await run('refresh-from-issue', '--reason', 'the Issue was corrected', '--json'));
    expect(preview.outcome).toBe('preview');
    // Nothing was written by a preview — no revision, and no comment.
    expect(await amendmentBlock()).toBeUndefined();
    expect(await amendmentComments()).toHaveLength(0);

    const applied = parse(
      await run(
        'refresh-from-issue',
        '--reason',
        'the Issue was corrected',
        '--allow-retire',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');

    const shown = parse(await run('show', '--json'));
    const active = shown.requirement.filter((slot) => slot.state === 'active').map((s) => s.command);
    const retired = shown.requirement.filter((slot) => slot.state === 'retired').map((s) => s.command);
    expect(active).toContain(FIXED);
    expect(retired).toContain(TYPO);

    const [comment] = await amendmentComments();
    expect(comment).toBeDefined();
    expect(comment.payload.issueNumber).toBe(ISSUE);
    expect(comment.payload.body).toContain('Verification plan amended — revision 1');
    expect(comment.payload.body).toContain('re-read of this Issue');
    expect(comment.payload.body).toContain(FIXED);
    // A removal a reader of the Issue cannot see is the failure this contract
    // exists to prevent.
    expect(comment.payload.body).toContain(TYPO);
    expect(comment.payload.body).toContain('not** a passing result');
  });
});

// ---------------------------------------------------------------------------
// 2. A task-local replacement
// ---------------------------------------------------------------------------

describe('a task-local replacement', () => {
  test('the slot keeps its identity, the plan carries the new bytes, and the comment names both', async () => {
    await seedTask();
    const applied = parse(
      await run(
        'amend',
        '--replace',
        REQ_TYPO,
        '--command',
        FIXED,
        '--reason',
        'correcting the command the Issue mistyped',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');
    expect(applied.operationKinds).toEqual(['replace']);

    const shown = parse(await run('show', '--json'));
    const slot = shown.requirement.find((s) => s.commandId === REQ_TYPO);
    expect(slot).toMatchObject({ command: FIXED, state: 'active', amended: true });

    const [comment] = await amendmentComments();
    expect(comment.payload.body).toContain('`replace` — requirement');
    expect(comment.payload.body).toContain(FIXED);
    expect(comment.payload.body).toContain('correcting the command the Issue mistyped');
    // The comment names what the task checks NOW; nothing claims the retired or
    // superseded bytes passed.
    expect(comment.payload.body).not.toContain('not** a passing result');
  });
});

// ---------------------------------------------------------------------------
// 3. A removal, with its reason
// ---------------------------------------------------------------------------

describe('a removal with a reason', () => {
  test('the retirement is published explicitly and never reads as a pass', async () => {
    await seedTask();
    const applied = parse(
      await run(
        'amend',
        '--retire',
        REQ_TYPO,
        '--reason',
        'the e2e suite cannot run in this environment',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');

    const shown = parse(await run('show', '--json'));
    const slot = shown.requirement.find((s) => s.commandId === REQ_TYPO);
    expect(slot.state).toBe('retired');
    // §8.4 rule 1: a retired slot is reported `retired`, never `passed`.
    expect(slot.status).toBe('retired');

    const [comment] = await amendmentComments();
    expect(comment.payload.body).toContain('This revision removed 1 check(s):');
    expect(comment.payload.body).toContain('the e2e suite cannot run in this environment');
    expect(comment.payload.body).toContain('not** a passing result');
  });
});

// ---------------------------------------------------------------------------
// 4. A stale preview
// ---------------------------------------------------------------------------

describe('a stale preview', () => {
  test('an apply guarded on a digest the plan has moved past refuses and writes nothing', async () => {
    await seedTask();
    const preview = parse(await run('amend', '--retire', REQ_TYPO, '--reason', 'previewing', '--json'));
    const staleDigest = preview.basePlanDigest;

    // Somebody else amends in between, moving the plan the preview read.
    const other = parse(
      await run('amend', '--add-requirement', '--command', 'npm run lint', '--reason', 'a competing correction', '--yes', '--json'),
    );
    expect(other.outcome).toBe('applied');

    const stale = await run(
      'amend',
      '--retire',
      REQ_TYPO,
      '--reason',
      'previewing',
      '--expect-plan-digest',
      staleDigest,
      '--yes',
      '--json',
    );
    expect(stale.code).not.toBe(0);
    const payload = parse(stale);
    expect(payload.applied).toBe(false);
    expect(payload.reasonCode).toBe('plan_digest_mismatch');

    // One revision, one comment: the refusal consumed no ordinal and posted
    // nothing.
    expect((await amendmentBlock()).revisions).toHaveLength(1);
    expect(await amendmentComments()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. A claimed/running task
// ---------------------------------------------------------------------------

describe('a claimed or running task', () => {
  test.each(['claimed', 'running'])(
    'a %s task refuses unconditionally, writes nothing, and publishes nothing',
    async (status) => {
      await seedTask({ status, ownerRunId: 'run-77' });
      const refused = await run(
        'amend',
        '--retire',
        REQ_TYPO,
        '--reason',
        'trying anyway',
        '--yes',
        '--json',
      );
      expect(refused.code).not.toBe(0);
      const payload = parse(refused);
      expect(payload.reasonCode).toBe('task_active');
      expect(payload.applied).toBe(false);
      expect(await amendmentBlock()).toBeUndefined();
      expect(await amendmentComments()).toHaveLength(0);

      // The READ still works and explains why the mutation would not.
      const shown = parse(await run('show', '--json'));
      expect(shown.amendable).toBe(false);
      expect(shown.amendmentRefusal.reason).toBe('task_active');
    },
  );
});

// ---------------------------------------------------------------------------
// 6. Evidence invalidation, and the §13.1 orphaned-command refusal
// ---------------------------------------------------------------------------

describe('evidence invalidation', () => {
  test('a requirement replacement supersedes the evidence its old bytes admitted, and resolve refuses the orphan', async () => {
    await seedTask({
      context: {
        missingVerificationCommands: [TYPO],
        manualVerificationEvidence: [
          {
            command: TYPO,
            exitCode: 0,
            output: 'ok',
            recordedAt: '2026-01-01T00:00:00.000Z',
            source: 'operator_input',
            headSha: 'a'.repeat(40),
            commandId: REQ_TYPO,
            planDigest: 'unchecked',
            planRevisionOrdinal: 0,
          },
        ],
      },
    });

    const applied = parse(
      await run(
        'amend',
        '--replace',
        REQ_TYPO,
        '--command',
        FIXED,
        '--reason',
        'the evidence attests the wrong command',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');

    // §8.1/§8.3: the entry is preserved, and marked superseded for the slot
    // whose bytes it no longer attests — never deleted.
    const task = await readTask();
    const [evidence] = task.context.manualVerificationEvidence;
    expect(evidence.command).toBe(TYPO);
    expect(JSON.stringify(evidence)).toContain(applied.revisionId);

    // §13.1: the missing list still names the command the amendment orphaned;
    // recording evidence for it would attest a requirement the plan no longer
    // carries.
    const resolved = await runAdmin([
      'review-verification',
      'resolve',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--command',
      TYPO,
      '--exit-code',
      '0',
      '--output',
      'ok',
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
    ]);
    expect(resolved.code).not.toBe(0);
    expect(`${resolved.stdout}${resolved.stderr}`).toContain('no longer an active requirement');
  });

  // The refusal exists to send the operator to the revision that MOVED their
  // command. An `annotate` records a note against a slot and changes neither
  // its bytes nor its state, so naming it would point at an audit record that
  // removed nothing (issue #1044 review, P2).
  test('the §13.1 refusal names the retiring revision, not a later annotation of the same slot', async () => {
    await seedTask({ context: { missingVerificationCommands: [TYPO] } });

    const retired = parse(
      await run(
        'amend',
        '--retire',
        REQ_TYPO,
        '--reason',
        'this runner cannot host the suite',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(retired.outcome).toBe('applied');

    const annotated = parse(
      await run(
        'amend',
        '--annotate',
        REQ_TYPO,
        '--reason',
        'tracking the runner capacity ticket',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(annotated.outcome).toBe('applied');
    expect(annotated.revisionOrdinal).toBe(retired.revisionOrdinal + 1);

    const resolved = await runAdmin([
      'review-verification',
      'resolve',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--command',
      TYPO,
      '--exit-code',
      '0',
      '--output',
      'ok',
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
    ]);
    expect(resolved.code).not.toBe(0);
    const output = `${resolved.stdout}${resolved.stderr}`;
    expect(output).toContain('no longer an active requirement');
    expect(output).toContain(`revision ${retired.revisionOrdinal} (${retired.revisionId})`);
    expect(output).toContain('this runner cannot host the suite');
    expect(output).not.toContain('tracking the runner capacity ticket');
  });

  // A slot a `replace` already moved keeps the identity derived from its
  // ORIGINAL bytes, while the escalation records the REPLACEMENT bytes in the
  // missing list. Re-deriving an identity from those displayed bytes would mint
  // one no revision names, and the refusal would silently omit the revision that
  // moved the slot — the §13.1 contract's whole point (issue #1044 review, P2).
  test('the §13.1 refusal recovers the slot identity for bytes a previous revision installed', async () => {
    await seedTask({ context: { missingVerificationCommands: [FIXED] } });

    const replaced = parse(
      await run(
        'amend',
        '--replace',
        REQ_TYPO,
        '--command',
        FIXED,
        '--reason',
        'the Issue mistyped it',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(replaced.outcome).toBe('applied');

    const retired = parse(
      await run(
        'amend',
        '--retire',
        REQ_TYPO,
        '--reason',
        'this runner cannot host the suite',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(retired.outcome).toBe('applied');

    const resolved = await runAdmin([
      'review-verification',
      'resolve',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--command',
      FIXED,
      '--exit-code',
      '0',
      '--output',
      'ok',
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
    ]);
    expect(resolved.code).not.toBe(0);
    const output = `${resolved.stdout}${resolved.stderr}`;
    expect(output).toContain('no longer an active requirement');
    // The STABLE identity, not a hash of the bytes the missing list displayed.
    expect(output).toContain(REQ_TYPO);
    expect(output).not.toContain(deriveRequirementCommandId(FIXED));
    expect(output).toContain(`revision ${retired.revisionOrdinal} (${retired.revisionId})`);
    expect(output).toContain('this runner cannot host the suite');
  });

  test('the §13.1 refusal leaves the #1040 binding refusal standing for a command the plan still carries', async () => {
    // The new refusal sits in front of the shipped binding refusal, so pin
    // that a command the amended plan DOES carry still reaches it: under an
    // amendment chain a slot's identity can differ from its bytes, so with no
    // binding block recorded the resolve refuses rather than deriving an
    // identity it would only be guessing at.
    await seedTask({
      requirements: [FIXED],
      context: { missingVerificationCommands: [FIXED] },
    });

    const applied = parse(
      await run(
        'amend',
        '--add-requirement',
        '--command',
        'npm run lint',
        '--reason',
        'one more check',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');

    const unbound = await runAdmin([
      'review-verification',
      'resolve',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--command',
      FIXED,
      '--exit-code',
      '0',
      '--output',
      'ok',
      '--head-sha',
      'b'.repeat(40),
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
    ]);
    expect(unbound.code).not.toBe(0);
    expect(`${unbound.stdout}${unbound.stderr}`).toContain('no usable evidence-binding block');
  });

  // §13.1 proves only that the displayed bytes are STILL required. It says
  // nothing about the plan they now belong to: an amendment applied after the
  // escalation moves the digest and the ordinal, and stamping the escalation's
  // snapshot would attest the evidence against a plan revision it never ran
  // under (issue #1044 review, P2).
  test('evidence carries the provenance of the plan it is recorded under, not the escalation snapshot', async () => {
    const reqFixed = deriveRequirementCommandId(FIXED);
    const reviewedHead = 'b'.repeat(40);
    await seedTask({
      requirements: [FIXED],
      context: {
        missingVerificationCommands: [FIXED],
        verificationEvidenceBinding: {
          headSha: reviewedHead,
          planDigest: 'c'.repeat(64),
          planRevisionOrdinal: 0,
          commandIds: { [FIXED]: reqFixed },
        },
      },
    });

    const applied = parse(
      await run(
        'amend',
        '--add-requirement',
        '--command',
        'npm run lint',
        '--reason',
        'one more check',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');

    const resolved = await runArgv([
      'review-verification',
      'resolve',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--command',
      FIXED,
      '--exit-code',
      '0',
      '--output',
      'ok',
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
    ]);
    expect(resolved.code).toBe(0);

    // The identity and the reviewed commit come from the escalation; the plan
    // provenance is rebuilt from the plan as it now stands.
    const { binding } = parse(resolved);
    expect(binding.commandId).toBe(reqFixed);
    expect(binding.headSha).toBe(reviewedHead);
    expect(binding.planDigest).toBe(applied.planDigest);
    expect(binding.planRevisionOrdinal).toBe(applied.revisionOrdinal);

    const [evidence] = (await readTask()).context.manualVerificationEvidence;
    expect(evidence.planDigest).toBe(applied.planDigest);
    expect(evidence.planDigest).not.toBe('c'.repeat(64));
  });

  // The same staleness, where it produces a WRONG identity rather than a stale
  // digest: the escalation bound these bytes to the slot a `replace` had moved
  // them into, and a later retire-plus-add put a different slot under them.
  // Recording the escalation's identity would leave the next review rejecting
  // the evidence as bound to a slot the amended plan no longer evaluates, with
  // the command still reported missing (issue #1044 review, P2).
  test('a slot the amendment moved under the displayed bytes refuses rather than binding a stale identity', async () => {
    await seedTask({
      context: {
        missingVerificationCommands: [FIXED],
        verificationEvidenceBinding: {
          headSha: 'b'.repeat(40),
          planDigest: 'c'.repeat(64),
          planRevisionOrdinal: 0,
          // What the escalation resolved: the typo slot, carrying the bytes a
          // replacement had already put into it.
          commandIds: { [FIXED]: REQ_TYPO },
        },
      },
    });

    for (const argv of [
      ['amend', '--replace', REQ_TYPO, '--command', FIXED, '--reason', 'the Issue mistyped it'],
      ['amend', '--retire', REQ_TYPO, '--reason', 'superseded by a task-local requirement'],
      ['amend', '--add-requirement', '--command', FIXED, '--reason', 'restated as its own slot'],
    ]) {
      const step = parse(await run(...argv, '--continue', 'none', '--yes', '--json'));
      expect(step.outcome).toBe('applied');
    }

    const resolved = await runArgv([
      'review-verification',
      'resolve',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--command',
      FIXED,
      '--exit-code',
      '0',
      '--output',
      'ok',
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
    ]);
    expect(resolved.code).not.toBe(0);
    const output = `${resolved.stdout}${resolved.stderr}`;
    expect(output).toContain('moved the requirement slot');
    expect(output).toContain(REQ_TYPO);
    expect(output).toContain(deriveRequirementCommandId(FIXED));
    // Nothing recorded: the operator requeues the review for a fresh binding.
    expect((await readTask()).context.manualVerificationEvidence).toBeUndefined();
  });

  // §13.1 asks whether the displayed bytes still name an active requirement,
  // and the requirement gate answers that under `matchesConfiguredVerification
  // Command` — evidence recorded for `bash -lc '<cmd>'` is credited to a
  // requirement of `<cmd>`. So an amendment that unwraps the slot leaves the
  // escalation's displayed command perfectly resolvable, and refusing it on an
  // exact-bytes comparison would send the operator to requeue a review that has
  // nothing to fix (issue #1044 review, P2).
  test('a slot an amendment unwrapped still accepts the wrapper form the escalation displayed', async () => {
    const wrapped = `bash -lc '${FIXED}'`;
    const reqWrapped = deriveRequirementCommandId(wrapped);
    const reviewedHead = 'b'.repeat(40);
    await seedTask({
      requirements: [wrapped],
      context: {
        missingVerificationCommands: [wrapped],
        verificationEvidenceBinding: {
          headSha: reviewedHead,
          planDigest: 'c'.repeat(64),
          planRevisionOrdinal: 0,
          commandIds: { [wrapped]: reqWrapped },
        },
      },
    });

    // The replacement keeps the slot's §5.1 identity and changes only its bytes.
    const applied = parse(
      await run(
        'amend',
        '--replace',
        reqWrapped,
        '--command',
        FIXED,
        '--reason',
        'the wrapper is not needed on this runner',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');

    const resolved = await runArgv([
      'review-verification',
      'resolve',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--command',
      wrapped,
      '--exit-code',
      '0',
      '--output',
      'ok',
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
    ]);
    expect(resolved.code).toBe(0);
    const { binding } = parse(resolved);
    // Bound to the surviving slot, under the plan the amendment produced.
    expect(binding.commandId).toBe(reqWrapped);
    expect(binding.headSha).toBe(reviewedHead);
    expect(binding.planDigest).toBe(applied.planDigest);

    const [evidence] = (await readTask()).context.manualVerificationEvidence;
    expect(evidence.command).toBe(wrapped);
    expect(evidence.commandId).toBe(reqWrapped);
  });

  // The #1043-P2 ambiguity refusal, decided on the plan as it stands: the
  // duplicate can be created AFTER the escalation, and the block it recorded
  // then lists no ambiguity at all.
  test('duplicate bytes created after the escalation still refuse with the disambiguation repair', async () => {
    await seedTask({
      context: {
        missingVerificationCommands: [FIXED],
        verificationEvidenceBinding: {
          headSha: 'b'.repeat(40),
          planDigest: 'c'.repeat(64),
          planRevisionOrdinal: 0,
          commandIds: { [FIXED]: REQ_TYPO },
        },
      },
    });

    for (const argv of [
      ['amend', '--replace', REQ_TYPO, '--command', FIXED, '--reason', 'the Issue mistyped it'],
      ['amend', '--add-requirement', '--command', FIXED, '--reason', 'restated as its own slot'],
    ]) {
      const step = parse(await run(...argv, '--continue', 'none', '--yes', '--json'));
      expect(step.outcome).toBe('applied');
    }

    const resolved = await runArgv([
      'review-verification',
      'resolve',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--command',
      FIXED,
      '--exit-code',
      '0',
      '--output',
      'ok',
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
    ]);
    expect(resolved.code).not.toBe(0);
    expect(`${resolved.stdout}${resolved.stderr}`).toContain('more than one active requirement slot');
    expect((await readTask()).context.manualVerificationEvidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Direct review continuation
// ---------------------------------------------------------------------------

describe('direct review continuation', () => {
  test('a review-lane park is re-queued to review in the same write, with the stale park state cleared', async () => {
    await seedTask({
      context: { missingVerificationCommands: [TYPO], issueRequiredVerifications: [{ command: TYPO, status: 'not_run' }] },
    });
    const applied = parse(
      await run('amend', '--replace', REQ_TYPO, '--command', FIXED, '--reason', 'typo', '--yes', '--json'),
    );
    expect(applied.outcome).toBe('applied');
    expect(applied.continuation).toBe('review');
    expect(applied.requeued).toEqual({ status: 'queued', phase: 'review' });

    const task = await readTask();
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
    expect(task.context.missingVerificationCommands).toBeUndefined();
    // The publication rides the same transaction as the re-queue.
    expect(await amendmentComments()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7b. The record-only continuation under a human gate (issue #1044 review, P1)
// ---------------------------------------------------------------------------

describe('a record-only amendment on a ready_for_human review task', () => {
  const PR_URL = 'https://github.com/m2dw/some-repo/pull/7';

  test('supersedes the sticky Human Gate summary so the PR cannot be merged on the pre-amendment pass', async () => {
    await seedTask({ context: { prUrl: PR_URL, branch: 'ai/issue-42' } });
    const applied = parse(
      await run(
        'amend',
        '--retire',
        REQ_TYPO,
        '--reason',
        'the e2e suite cannot run in this environment',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');
    // The record-only continuation moves nothing: the handoff is still live,
    // which is exactly why the summary beside the merge button must not keep
    // reporting the plan this revision replaced.
    const task = await readTask();
    expect(task.status).toBe('ready_for_human');

    const [gate] = await prSummaryRows();
    expect(gate).toBeDefined();
    expect(gate.payload.prNumber).toBe(7);
    expect(gate.payload.marker).toBe('<!-- n8n-ai-human-gate -->');
    expect(gate.payload.body).toContain('superseded by a verification amendment');
    expect(gate.payload.body).toContain('Retired — not run, not passed (1)');
    expect(gate.payload.body).toContain('the e2e suite cannot run in this environment');
    // The stale pass is gone from the body, not merely qualified further down.
    expect(gate.payload.body).not.toContain('✅ passed');
    // Keyed on the revision and on no run, like the §12.2 comment itself: a
    // re-derived enqueue after a crash dedupes instead of posting twice.
    expect(gate.idempotencyKey).toContain(applied.revisionId);
    expect(gate.idempotencyKey).toContain('repohost:human-gate:superseded');
  });

  test('a routing continuation retracts the handoff itself, so it supersedes nothing', async () => {
    await seedTask({
      context: {
        prUrl: PR_URL,
        missingVerificationCommands: [TYPO],
        issueRequiredVerifications: [{ command: TYPO, status: 'not_run' }],
      },
    });
    const applied = parse(
      await run('amend', '--replace', REQ_TYPO, '--command', FIXED, '--reason', 'typo', '--yes', '--json'),
    );
    expect(applied.continuation).toBe('review');
    expect((await readTask()).status).toBe('queued');
    // The re-queue swaps the labels and a fresh review renders the summary
    // again; a superseded body here would be overwritten moments later.
    expect(await prSummaryRows()).toHaveLength(0);
  });

  test('an annotate-only revision leaves the gate summary standing', async () => {
    await seedTask({ context: { prUrl: PR_URL, branch: 'ai/issue-42' } });
    const applied = parse(
      await run(
        'amend',
        '--annotate',
        REQ_TYPO,
        '--reason',
        'flaky on the shared runner; watch it',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');
    // An annotate changes neither bytes, state, nor position, so the plan the
    // gate summary reported on IS still the effective plan (§6.1 step 2) —
    // superseding it would claim a change that did not happen.
    expect(applied.planDigest).toBe(applied.basePlanDigest);
    expect(await prSummaryRows()).toHaveLength(0);
    // The revision is still recorded publicly on the work item.
    expect(await amendmentComments()).toHaveLength(1);
  });

  test('a task with no pull request has no gate to supersede', async () => {
    await seedTask();
    const applied = parse(
      await run('amend', '--retire', REQ_TYPO, '--reason', 'removing it', '--continue', 'none', '--yes', '--json'),
    );
    expect(applied.outcome).toBe('applied');
    expect(await prSummaryRows()).toHaveLength(0);
    // The work-item comment is still published — that reader is not the PR.
    expect(await amendmentComments()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Crash/retry and duplicate publication
// ---------------------------------------------------------------------------

describe('a retried apply', () => {
  test('is recognized as a replay: no second revision, no second comment, exit zero', async () => {
    await seedTask();
    const args = [
      'amend',
      '--replace',
      REQ_TYPO,
      '--command',
      FIXED,
      '--reason',
      'the command was mistyped',
      '--continue',
      'none',
      '--yes',
      '--json',
    ];
    const first = parse(await run(...args));
    expect(first.outcome).toBe('applied');

    // The operator lost the response and ran exactly the same line again.
    const retry = await run(...args);
    expect(retry.code).toBe(0);
    const replay = parse(retry);
    expect(replay.outcome).toBe('replay');
    expect(replay.revisionId).toBe(first.revisionId);

    expect((await amendmentBlock()).revisions).toHaveLength(1);
    const comments = await amendmentComments();
    expect(comments).toHaveLength(1);
    // The row is keyed on the revision, never on the invocation or a run.
    expect(comments[0].idempotencyKey).toBe(
      verificationAmendmentCommentIdempotencyKey({
        sessionId: SESSION,
        issueNumber: ISSUE,
        revisionId: first.revisionId,
      }),
    );
  });

  test('a re-enqueued identical row deduplicates in the outbox rather than posting twice', async () => {
    await seedTask();
    const applied = parse(
      await run('amend', '--retire', REQ_TYPO, '--reason', 'removing it', '--continue', 'none', '--yes', '--json'),
    );
    const key = verificationAmendmentCommentIdempotencyKey({
      sessionId: SESSION,
      issueNumber: ISSUE,
      revisionId: applied.revisionId,
    });
    const [row] = await amendmentComments();

    // Simulate the delivery-side retry: the same key enqueued again, as a
    // re-derived effect after a crash would.
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      await outbox.enqueue({
        idempotencyKey: key,
        topic: row.topic,
        payload: row.payload,
        now: new Date().toISOString(),
      });
    } finally {
      outbox.close();
    }
    expect(await amendmentComments()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Reset to baseline
// ---------------------------------------------------------------------------

describe('reset to baseline', () => {
  test('returns the plan to its unamended digest as one more append-only revision', async () => {
    await seedTask();
    const baselineDigest = parse(await run('show', '--json')).planDigest;

    const amended = parse(
      await run('amend', '--retire', REQ_TYPO, '--reason', 'removing it', '--continue', 'none', '--yes', '--json'),
    );
    expect(amended.outcome).toBe('applied');
    expect(parse(await run('show', '--json')).planDigest).not.toBe(baselineDigest);

    const reset = parse(
      await run('reset', '--reason', 'the removal was a mistake', '--allow-retire', '--yes', '--json'),
    );
    expect(reset.outcome).toBe('applied');

    const shown = parse(await run('show', '--json'));
    expect(shown.planDigest).toBe(baselineDigest);
    expect(shown.requirement.find((s) => s.commandId === REQ_TYPO).state).toBe('active');
    // Nothing was deleted: both revisions are still on the chain.
    expect((await amendmentBlock()).revisions).toHaveLength(2);
    // And both were published — the restoration is as reportable as the removal.
    const comments = await amendmentComments();
    expect(comments).toHaveLength(2);
    expect(comments[1].payload.body).toContain('This revision restored 1 check(s):');
  });
});

// ---------------------------------------------------------------------------
// Redaction, and the UI/CLI equivalence
// ---------------------------------------------------------------------------

describe('publication bounds', () => {
  test('a command carrying a local path is redacted before it is published', async () => {
    await seedTask({ requirements: ['bash /Users/someone/checkouts/repo/scripts/check.sh'] });
    const applied = parse(
      await run(
        'amend',
        '--add-requirement',
        '--command',
        `bash ${repoRoot}/scripts/other.sh`,
        '--reason',
        'adding the other check',
        '--continue',
        'none',
        '--yes',
        '--json',
      ),
    );
    expect(applied.outcome).toBe('applied');
    const [comment] = await amendmentComments();
    expect(comment.payload.body).not.toContain('/Users/someone');
    expect(comment.payload.body).not.toContain(repoRoot);
    expect(comment.payload.body).toContain('<path>');
  });
});

describe('admin ui and the CLI', () => {
  test('the UI builds the same commands, reads the same plan, and produces the same outcome', async () => {
    await seedTask();

    // The view the UI renders is the command's own --json payload.
    const showArgv = buildTaskVerificationShowArgv(uiTask(), dbPath, sessionsPath, { json: true });
    const shown = await runArgv(showArgv);
    const view = parseVerificationPlanView(shown.stdout);
    expect(view).not.toBeNull();
    expect(view.amendable).toBe(true);
    expect(view.defaultContinuation).toBe('review');
    expect(view.requirement.map((s) => s.commandId)).toContain(REQ_TYPO);
    expect(formatVerificationPlanDetail(view).join('\n')).toContain(REQ_TYPO);
    expect(previousAmendmentReason(view)).toBeUndefined();

    // The UI's preview is the CLI's preview, guarded on the digest it displayed.
    const options = {
      operations: [{ flag: '--replace', value: REQ_TYPO, command: FIXED }],
      reason: 'corrected from the UI',
      expectPlanDigest: view.planDigest,
    };
    const previewArgv = buildTaskVerificationAmendArgv(uiTask(), options, dbPath, sessionsPath);
    const preview = await runArgv([...previewArgv, '--json']);
    expect(preview.code).toBe(0);
    expect(parse(preview).outcome).toBe('preview');
    expect(await amendmentBlock()).toBeUndefined();

    const applyArgv = buildTaskVerificationAmendArgv(
      uiTask(),
      { ...options, yes: true, json: true },
      dbPath,
      sessionsPath,
    );
    const applied = parse(await runArgv(applyArgv));
    expect(applied.outcome).toBe('applied');
    expect(applied.operationKinds).toEqual(['replace']);
    expect(applied.requeued).toEqual({ status: 'queued', phase: 'review' });
    expect(await amendmentComments()).toHaveLength(1);

    // After the amendment the plan view carries the revision and its reason,
    // which is what the next correction is prefilled with.
    const after = parseVerificationPlanView((await runArgv(showArgv)).stdout);
    expect(after.revisions).toHaveLength(1);
    expect(previousAmendmentReason(after)).toBe('corrected from the UI');
    const task = await readTask();
    expect(hasVerificationAmendments(task)).toBe(true);
    expect(buildTaskMenuActions(task, new Date().toISOString()).map((a) => a.action)).toContain(
      'verification',
    );
  });

  // Issue #1044 review (P2): "the same corrections" has to mean ALL of them.
  // An annotation — the one operation that records a reason without touching a
  // slot's bytes or its state — and the §9.2 lane the revision routes to are
  // both expressible from the UI's own builders, and the CLI takes them as
  // typed: the annotated slot is unchanged and the task lands in the lane the
  // operator chose rather than the row's default.
  test('the UI can annotate a slot and choose the amendment continuation', async () => {
    await seedTask();
    const showArgv = buildTaskVerificationShowArgv(uiTask(), dbPath, sessionsPath, { json: true });
    const view = parseVerificationPlanView((await runArgv(showArgv)).stdout);
    // A `ready_for_human` + `review` row is one the §9.2 table re-queues, so
    // all three lanes are offered and `implementation` is a real choice.
    expect(verificationContinuationChoices(view).map((c) => c.value)).toEqual([
      'review',
      'implementation',
      'none',
    ]);

    const applied = parse(
      await runArgv(
        buildTaskVerificationAmendArgv(
          uiTask(),
          {
            operations: [{ flag: '--annotate', value: REQ_TYPO }],
            reason: 'kept as filed; the fix belongs in the code',
            continueMode: 'implementation',
            expectPlanDigest: view.planDigest,
            requestKey: newVerificationRequestKey(),
            yes: true,
            json: true,
          },
          dbPath,
          sessionsPath,
        ),
      ),
    );
    expect(applied.outcome).toBe('applied');
    expect(applied.operationKinds).toEqual(['annotate']);
    // The chosen lane, not the row's `review` default.
    expect(applied.requeued).toEqual({ status: 'queued', phase: 'implementation' });

    // The annotation is recorded against the slot and changes nothing about it.
    const after = parseVerificationPlanView((await runArgv(showArgv)).stdout);
    const slot = after.requirement.find((s) => s.commandId === REQ_TYPO);
    expect(slot.state).toBe('active');
    expect(slot.command).toBe(TYPO);
    expect(after.revisions).toHaveLength(1);
    expect(after.revisions[0].operations).toEqual(['annotate']);
    expect(after.revisions[0].continuation).toBe('implementation');
  });

  // Issue #1044 review (P1): retire, restore, retire again. The third
  // correction's argv is byte-identical to the first's, so the content-derived
  // request key is the first retirement's key — and §5.3 rule 1 looks a replay
  // up BEFORE any plan comparison. The preview shows the retirement going
  // through (previews perform no replay lookup), and the apply would then answer
  // with a superseded revision while the slot stayed active. A key minted for
  // each UI flow is what tells the core these are three requests, not two.
  test('a correction repeated after its reversal is a new revision, not a replay', async () => {
    await seedTask();
    const retire = { flag: '--retire', value: REQ_TYPO };
    const REASON = 'the suite cannot run here';
    const planDigest = async () =>
      parseVerificationPlanView(
        (await runArgv(buildTaskVerificationShowArgv(uiTask(), dbPath, sessionsPath, { json: true })))
          .stdout,
      ).planDigest;
    const slotState = async () =>
      parseVerificationPlanView(
        (await runArgv(buildTaskVerificationShowArgv(uiTask(), dbPath, sessionsPath, { json: true })))
          .stdout,
      ).requirement.find((slot) => slot.commandId === REQ_TYPO).state;
    const amend = async (operations, reason, requestKey) =>
      parse(
        await runArgv(
          buildTaskVerificationAmendArgv(
            uiTask(),
            {
              operations,
              reason,
              expectPlanDigest: await planDigest(),
              ...(requestKey !== undefined ? { requestKey } : {}),
              yes: true,
              json: true,
            },
            dbPath,
            sessionsPath,
          ),
        ),
      );

    // The first two corrections are sent the way this flow used to send them —
    // keyless — so the chain carries the CONTENT-derived key the repeat below
    // would collide with.
    const first = await amend([retire], REASON);
    expect(first.outcome).toBe('applied');
    expect(first.revisionOrdinal).toBe(1);
    const restored = await amend([{ flag: '--restore', value: REQ_TYPO }], 'it can run again');
    expect(restored.outcome).toBe('applied');
    expect(restored.revisionOrdinal).toBe(2);
    expect(await slotState()).toBe('active');

    // Keyless, the repeat is answered as the FIRST retirement: nothing is
    // written and the slot stays ACTIVE, which is the failure the minted key
    // exists to prevent.
    const keyless = await amend([retire], REASON);
    expect(keyless.outcome).toBe('replay');
    expect(keyless.revisionOrdinal).toBe(1);
    expect((await amendmentBlock()).revisions).toHaveLength(2);
    expect(await slotState()).toBe('active');

    // With a key minted for this flow the same correction is the third request
    // it is: applied, recorded, and the slot the operator confirmed is retired.
    const again = await amend([retire], REASON, newVerificationRequestKey());
    expect(again.outcome).toBe('applied');
    expect(again.revisionOrdinal).toBe(3);
    expect(again.operationKinds).toEqual(['retire']);
    expect(await slotState()).toBe('retired');
    expect((await amendmentBlock()).revisions).toHaveLength(3);
  });

  test('a reset built by the UI carries the digest and the retire opt-in it displayed', async () => {
    await seedTask();
    const argv = buildTaskVerificationResetArgv(
      uiTask(),
      { reason: 'undoing', allowRetire: true, expectPlanDigest: 'deadbeef', yes: true },
      dbPath,
      sessionsPath,
    );
    expect(argv).toEqual([
      'task-verification',
      'reset',
      '--session-id',
      SESSION,
      '--issue-number',
      String(ISSUE),
      '--db-path',
      dbPath,
      '--sessions-path',
      sessionsPath,
      '--reason',
      'undoing',
      '--allow-retire',
      '--expect-plan-digest',
      'deadbeef',
      '--yes',
    ]);
    // And the shipped command accepts exactly it (refusing on the digest guard,
    // which is the point: the UI never invents a flag the CLI does not take).
    const result = await runArgv([...argv, '--json']);
    expect(result.code).not.toBe(0);
    expect(parse(result).reasonCode).toBe('plan_digest_mismatch');
  });
});
