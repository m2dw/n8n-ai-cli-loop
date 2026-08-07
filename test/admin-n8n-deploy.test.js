import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  CHILD_ARTIFACT_FILE_NAME,
  CHILD_WORKFLOW_ID,
  CHILD_WORKFLOW_NAME,
  LOCAL_WORKFLOW_ARTIFACT_DIR,
  deriveParentWorkflowId,
  deriveParentWorkflowName,
  parentArtifactFileName,
} from '../scripts/build-parent-child-workflow.mjs';

// Issue #822 — the `admin n8n deploy` operator surface: preview by default,
// `--yes` to apply, `--publish` only with apply. The n8n binary is faked with a
// tiny shell script that records its argv, so command ordering and the
// verification/publish gates are observable without an n8n installation.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'dist', 'cli', 'admin.js');
const ARTIFACT_DIR = join(REPO_ROOT, LOCAL_WORKFLOW_ARTIFACT_DIR);

// A session that only exists for this test file, so its generated parent
// artifact cannot collide with a real deployment's.
const SESSION_ID = 'admin-n8n-deploy-test-session';
const PARENT_ID = deriveParentWorkflowId(SESSION_ID);
const PARENT_NAME = deriveParentWorkflowName(SESSION_ID);
const PARENT_FILE = parentArtifactFileName(SESSION_ID);

let tmpDir;
let sessionsPath;
let fakeN8n;
let logPath;
let listPath;
let activeListPath;
let lockDir;

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** argv of each fake-n8n invocation, in call order. */
function fakeN8nCalls() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n---\n')
    .filter((block) => block.trim() !== '')
    .map((block) => block.split('\n').filter((line) => line !== ''));
}

function writeListOutput(rows) {
  writeFileSync(listPath, rows.length === 0 ? '' : rows.join('\n') + '\n');
}

/** What `n8n list:workflow --active=true` answers — nothing active by default. */
function writeActiveListOutput(rows) {
  writeFileSync(activeListPath, rows.length === 0 ? '' : rows.join('\n') + '\n');
}

function deployEnv() {
  return {
    FAKE_N8N_LOG: logPath,
    FAKE_N8N_LIST: listPath,
    FAKE_N8N_ACTIVE_LIST: activeListPath,
    SESSIONS_PATH: sessionsPath,
  };
}

const baseArgs = ['n8n', 'deploy', '--session-ref', SESSION_ID, '--sessions-path'];

/**
 * The lock this session's deploy takes, kept in the test's own directory so a
 * run never touches the operator's real lock state.
 */
function deployLockPath() {
  return join(lockDir, `${encodeURIComponent(`n8n-deploy:${PARENT_ID}`)}.lock`);
}

/**
 * The install-wide lock on the shared child, taken by every session's deploy
 * across generation and the child import.
 */
function childLockPath() {
  return join(lockDir, `${encodeURIComponent(`n8n-deploy-child:${CHILD_WORKFLOW_ID}`)}.lock`);
}

function args(...extra) {
  return [...baseArgs, sessionsPath, '--n8n-bin', fakeN8n, '--lock-dir', lockDir, ...extra];
}

beforeEach(() => {
  // The apply tests generate this file; removing it up front keeps the
  // "preview generates nothing" assertion honest whatever ran before.
  rmSync(join(ARTIFACT_DIR, PARENT_FILE), { force: true });
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-n8n-deploy-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  writeFileSync(
    sessionsPath,
    JSON.stringify({
      sessions: [
        {
          sessionId: SESSION_ID,
          repoKey: 'deploy-test',
          repoRoot: tmpDir,
          githubRepo: 'm2dw/deploy-test',
          artifactDir: '.n8n-artifacts',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: {},
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        },
      ],
    }),
  );
  lockDir = join(tmpDir, 'locks');
  logPath = join(tmpDir, 'n8n-calls.log');
  listPath = join(tmpDir, 'n8n-list.txt');
  activeListPath = join(tmpDir, 'n8n-active-list.txt');
  writeListOutput([`${CHILD_WORKFLOW_ID}|${CHILD_WORKFLOW_NAME}`, `${PARENT_ID}|${PARENT_NAME}`]);
  writeActiveListOutput([]);
  fakeN8n = join(tmpDir, 'fake-n8n');
  writeFileSync(
    fakeN8n,
    [
      '#!/bin/sh',
      'for a in "$@"; do printf "%s\\n" "$a" >> "$FAKE_N8N_LOG"; done',
      'printf -- "---\\n" >> "$FAKE_N8N_LOG"',
      // `list:workflow --active=true` lists only the active workflows, which is
      // how the deploy learns what it must not deactivate.
      'if [ "$1" = "list:workflow" ] && [ "$2" = "--active=true" ]; then cat "$FAKE_N8N_ACTIVE_LIST";',
      'elif [ "$1" = "list:workflow" ]; then cat "$FAKE_N8N_LIST"; fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  // The apply tests really run the generator, which writes this session's
  // parent artifact into the (gitignored) local artifact directory.
  rmSync(join(ARTIFACT_DIR, PARENT_FILE), { force: true });
});

// ---------------------------------------------------------------------------
// Help and option validation
// ---------------------------------------------------------------------------

describe('admin help n8n deploy', () => {
  test('documents the deployment options and the human-readable default', () => {
    const result = run(['help', 'n8n', 'deploy']);
    expect(result.code).toBe(0);
    for (const flag of ['--session-ref', '--project-id', '--n8n-bin', '--yes', '--publish', '--lock-dir']) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain('human-readable by default');
  });
});

describe('option validation', () => {
  test('rejects an unknown flag rather than silently ignoring it', () => {
    const result = run([...args('--ye')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--ye');
  });

  test('requires a session', () => {
    const result = run(['n8n', 'deploy']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--session-id or --session-ref is required');
  });

  test('rejects --publish without --yes', () => {
    const result = run([...args('--publish')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--publish requires --yes');
    expect(fakeN8nCalls()).toEqual([]);
  });

  test('rejects an empty --project-id', () => {
    const result = run([...args('--project-id', '')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--project-id must not be empty');
  });

  test('rejects an unknown n8n action', () => {
    // `n8n <unknown>` has no human default, so the error follows the JSON
    // machine contract on stdout rather than the human one on stderr.
    const result = run(['n8n', 'wat']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      ok: false,
      error: 'Unknown n8n action: wat. Expected: deploy',
    });
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe('preview (no --yes)', () => {
  test('describes the plan and imports nothing', () => {
    const result = run(args(), deployEnv());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('n8n deploy preview');
    expect(result.stdout).toContain('Nothing was generated, imported, or published.');
    expect(result.stdout).toContain('Re-run with --yes to apply.');
    expect(result.stdout).toContain(CHILD_WORKFLOW_ID);
    expect(result.stdout).toContain(PARENT_ID);
    // The child is listed before the parent: that is the import order.
    expect(result.stdout.indexOf('import-child')).toBeLessThan(result.stdout.indexOf('import-parent'));
    expect(fakeN8nCalls()).toEqual([]);
    expect(existsSync(join(ARTIFACT_DIR, PARENT_FILE))).toBe(false);
  }, 30_000);

  test('states that applying the plan will not deactivate a running parent', () => {
    const result = run(args(), deployEnv());
    expect(result.stdout).toContain('check-parent-active');
    expect(result.stdout).toContain('never deactivates a running workflow');
  }, 30_000);

  test('redacts local filesystem paths from the output', () => {
    const result = run(args(), deployEnv());
    expect(result.stdout).not.toContain(REPO_ROOT);
    expect(result.stdout).not.toContain(tmpDir);
    expect(result.stdout).toContain('<path>');
    // The artifact filenames survive — they are what identifies the deployment.
    expect(result.stdout).toContain(PARENT_FILE);
    expect(result.stdout).toContain(CHILD_ARTIFACT_FILE_NAME);
  }, 30_000);

  test('redacts an --n8n-bin outside the sanitizer\'s built-in roots', () => {
    // `/secret-install` is none of the conventional roots the sanitizer knows,
    // so this path is redacted only because the command names it explicitly.
    // A preview runs nothing, so the binary need not exist.
    const result = run(
      [...baseArgs, sessionsPath, '--n8n-bin', '/secret-install/bin/n8n', '--json'],
      deployEnv(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('/secret-install');
    const payload = JSON.parse(result.stdout.trim());
    for (const step of payload.steps) {
      if (step.commandLine === undefined) continue;
      expect(step.commandLine).not.toContain('secret-install');
    }
    expect(payload.steps.find((step) => step.id === 'import-child').commandLine).toBe(
      '<path> import:workflow --input=<path>',
    );
  }, 30_000);

  test('warns that a running n8n must be restarted for the plan to take effect', () => {
    const result = run(args(), deployEnv());
    expect(result.stdout).toContain('restart it');
    expect(result.stdout).toContain('Schedule Trigger does not fire');
  }, 30_000);

  test('--json emits the planned steps in order without applying', () => {
    const result = run([...args(), '--json'], deployEnv());
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBe(false);
    expect(payload.published).toBe(false);
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.steps.map((step) => step.id)).toEqual([
      'generate',
      'check-parent-active',
      'import-child',
      'import-parent',
      'verify-workflows',
      'verify-parent-config',
      'restore-parent-active',
    ]);
    expect(payload.child.workflowId).toBe(CHILD_WORKFLOW_ID);
    expect(payload.parent.workflowId).toBe(PARENT_ID);
    expect(payload.parent.artifactFile).toBe(PARENT_FILE);
    expect(JSON.stringify(payload)).not.toContain(REPO_ROOT);
  }, 30_000);

  test('a requested project appears in both import commands', () => {
    const result = run([...args('--project-id', 'proj-42'), '--json'], deployEnv());
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.projectId).toBe('proj-42');
    const imports = payload.steps.filter((step) => step.id.startsWith('import-'));
    expect(imports).toHaveLength(2);
    for (const step of imports) expect(step.commandLine).toContain('--projectId=proj-42');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

describe('apply (--yes)', () => {
  test('generates, imports the child then the parent, verifies, and does not publish', () => {
    // Deploying writes the gitignored artifacts it imports — never the tracked
    // docs/ templates.
    const trackedTemplate = join(REPO_ROOT, 'docs', 'n8n-thin-parent-workflow.json');
    const templateMtime = statSync(trackedTemplate).mtimeMs;

    const result = run([...args('--yes'), '--json'], deployEnv());
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBe(true);
    expect(payload.published).toBe(false);
    expect(payload.steps.map((step) => step.outcome)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      // Nothing was active before this deploy, so there is nothing to restore.
      'skipped',
    ]);
    expect(payload.parentWasActive).toBe(false);
    expect(payload.parentActiveRestored).toBe(false);
    expect(payload.verification.ok).toBe(true);
    expect(result.code).toBe(0);

    const calls = fakeN8nCalls();
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual(['list:workflow', '--active=true']);
    expect(calls[1][0]).toBe('import:workflow');
    expect(calls[1][1]).toBe(`--input=${join(ARTIFACT_DIR, CHILD_ARTIFACT_FILE_NAME)}`);
    expect(calls[2][0]).toBe('import:workflow');
    expect(calls[2][1]).toBe(`--input=${join(ARTIFACT_DIR, PARENT_FILE)}`);
    expect(calls[3]).toEqual(['list:workflow']);

    // The generated parent really drives this session and calls the shared child.
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, PARENT_FILE), 'utf8'));
    expect(artifact.id).toBe(PARENT_ID);
    expect(artifact.name).toBe(PARENT_NAME);
    expect(artifact.nodes.find((node) => node.name === 'Call Phase Runner').parameters.workflowId).toBe(
      CHILD_WORKFLOW_ID,
    );
    expect(statSync(trackedTemplate).mtimeMs).toBe(templateMtime);
  }, 60_000);

  test('a second deploy repeats the same two imports rather than creating duplicates', () => {
    run([...args('--yes'), '--json'], deployEnv());
    const firstCalls = fakeN8nCalls();
    rmSync(logPath, { force: true });
    const result = run([...args('--yes'), '--json'], deployEnv());
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(fakeN8nCalls()).toEqual(firstCalls);
    expect(payload.verification.matched.parent).toEqual({ id: PARENT_ID, name: PARENT_NAME });
    expect(payload.verification.matched.child).toEqual({ id: CHILD_WORKFLOW_ID, name: CHILD_WORKFLOW_NAME });
  }, 60_000);

  test('--publish activates the parent after verification passes', () => {
    const result = run([...args('--yes', '--publish'), '--json'], deployEnv());
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.published).toBe(true);
    const calls = fakeN8nCalls();
    expect(calls[calls.length - 1]).toEqual(['update:workflow', `--id=${PARENT_ID}`, '--active=true']);
  }, 60_000);

  test('--publish does not claim an activation a running n8n has not picked up', () => {
    // `update:workflow` wrote the database from a separate process; an n8n that
    // was already running still serves what it loaded at startup, so the
    // Schedule Trigger is not firing until it restarts.
    const result = run(args('--yes', '--publish'), deployEnv());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('marked active in the n8n database');
    expect(result.stdout).toContain('restart it');
    const json = JSON.parse(run([...args('--yes', '--publish'), '--json'], deployEnv()).stdout.trim());
    expect(json.restartRequired).toBe(true);
    expect(json.hint).toContain('restart it');
  }, 60_000);

  test('a deploy that imported nothing reports no restart requirement', () => {
    // The activation probe fails before the first import, so n8n's database is
    // untouched and there is nothing for a restart to pick up.
    const result = run(
      [...baseArgs, sessionsPath, '--n8n-bin', join(tmpDir, 'not-installed'), '--lock-dir', lockDir, '--yes', '--json'],
      deployEnv(),
    );
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.restartRequired).toBe(false);
    expect(payload.hint).not.toContain('restart it');
  }, 60_000);

  test('a --publish deploy whose n8n never started reports no restart requirement', () => {
    // --publish skips the activation probe, so the first n8n call is the child
    // import — and it fails with a negative status because the binary does not
    // exist, not because an import went wrong. A database no process ever opened
    // has nothing for a restart to pick up, and saying otherwise would send the
    // operator to restart n8n over a write that never happened.
    const result = run(
      [
        ...baseArgs,
        sessionsPath,
        '--n8n-bin',
        join(tmpDir, 'not-installed'),
        '--lock-dir',
        lockDir,
        '--yes',
        '--publish',
        '--json',
      ],
      deployEnv(),
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.failure.step).toBe('import-child');
    expect(payload.restartRequired).toBe(false);
    expect(payload.hint).toContain('--n8n-bin');
    expect(payload.hint).not.toContain('restart');
  }, 60_000);

  test('a verification failure fails the command before publishing', () => {
    // n8n reports only the child: the parent import did not land.
    writeListOutput([`${CHILD_WORKFLOW_ID}|${CHILD_WORKFLOW_NAME}`]);
    const result = run([...args('--yes', '--publish'), '--json'], deployEnv());
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.published).toBe(false);
    expect(payload.failure.step).toBe('verify-workflows');
    expect(payload.steps.find((step) => step.id === 'publish-parent').outcome).toBe('skipped');
    expect(fakeN8nCalls().some((call) => call[0] === 'update:workflow')).toBe(false);
  }, 60_000);

  test('a duplicate workflow under a second ID fails verification', () => {
    writeListOutput([
      `${CHILD_WORKFLOW_ID}|${CHILD_WORKFLOW_NAME}`,
      `${PARENT_ID}|${PARENT_NAME}`,
      `stale-duplicate|${PARENT_NAME}`,
    ]);
    const result = run([...args('--yes'), '--json'], deployEnv());
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.failure.detail).toContain('stale-duplicate');
  }, 60_000);

  test('human output reports each step and the unpublished parent', () => {
    const result = run([...args('--yes')], deployEnv());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ok      generate');
    expect(result.stdout).toContain('ok      import-child');
    expect(result.stdout).toContain('Parent workflow imported but not published');
    expect(result.stdout).not.toContain(REPO_ROOT);
  }, 60_000);

  test('an already active parent is re-activated instead of being left disabled', () => {
    // The generated artifact carries `active: false`, and import:workflow upserts
    // the whole record — so without the restore this plain re-deploy would stop
    // the schedule trigger of a session that was running.
    writeActiveListOutput([`${PARENT_ID}|${PARENT_NAME}`]);
    const result = run([...args('--yes'), '--json'], deployEnv());
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.parentWasActive).toBe(true);
    expect(payload.parentActiveRestored).toBe(true);
    // Restoring is not publishing: --publish was never passed.
    expect(payload.published).toBe(false);
    expect(payload.publishRequested).toBe(false);
    const calls = fakeN8nCalls();
    expect(calls[calls.length - 1]).toEqual(['update:workflow', `--id=${PARENT_ID}`, '--active=true']);
  }, 60_000);

  test('human output says the parent stayed active', () => {
    writeActiveListOutput([`${PARENT_ID}|${PARENT_NAME}`]);
    const result = run([...args('--yes')], deployEnv());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ok      restore-parent-active');
    expect(result.stdout).toContain('re-activated after the import');
    expect(result.stdout).not.toContain('Parent workflow imported but not published');
  }, 60_000);

  test('a failed deploy warns that a previously active parent is now inactive', () => {
    writeActiveListOutput([`${PARENT_ID}|${PARENT_NAME}`]);
    // n8n reports only the child: the parent import did not land.
    writeListOutput([`${CHILD_WORKFLOW_ID}|${CHILD_WORKFLOW_NAME}`]);
    const result = run([...args('--yes'), '--json'], deployEnv());
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.parentWasActive).toBe(true);
    expect(payload.parentActiveRestored).toBe(false);
    expect(payload.hint).toContain('INACTIVE');
    expect(payload.steps.find((step) => step.id === 'restore-parent-active').outcome).toBe('skipped');
    expect(fakeN8nCalls().some((call) => call[0] === 'update:workflow')).toBe(false);
  }, 60_000);

  test('--publish activates outright, without probing the prior state', () => {
    writeActiveListOutput([`${PARENT_ID}|${PARENT_NAME}`]);
    const result = run([...args('--yes', '--publish'), '--json'], deployEnv());
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.published).toBe(true);
    expect(payload.parentWasActive).toBeUndefined();
    expect(payload.parentActiveRestored).toBe(false);
    expect(fakeN8nCalls().some((call) => call[1] === '--active=true' && call[0] === 'list:workflow')).toBe(
      false,
    );
  }, 60_000);

  test('a missing n8n binary is reported with a usable hint', () => {
    const result = run(
      [...baseArgs, sessionsPath, '--n8n-bin', join(tmpDir, 'not-installed'), '--lock-dir', lockDir, '--yes', '--json'],
      deployEnv(),
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    // The first n8n call is the pre-import activation probe.
    expect(payload.failure.step).toBe('check-parent-active');
    expect(payload.hint).toContain('--n8n-bin');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Concurrent deploys of the same parent
// ---------------------------------------------------------------------------

describe('the per-parent deployment lock', () => {
  /** Pre-seed the lock the way a deploy already in flight would hold it. */
  function holdDeployLock(contextId = 'n8n-deploy-4242') {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      deployLockPath(),
      JSON.stringify({
        contextId,
        sessionId: `n8n-deploy:${PARENT_ID}`,
        startedAt: new Date().toISOString(),
      }),
    );
  }

  test('a deploy already running for this parent refuses the second one outright', () => {
    // The activation the deploy restores is read before the import, so two
    // deploys of the same parent must not interleave: a --publish run landing
    // between the other's probe and its import would be silently undone by that
    // run's `active: false` artifact.
    holdDeployLock();
    const result = run([...args('--yes', '--publish'), '--json'], deployEnv());
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.published).toBe(false);
    // No step failed, because no step started.
    expect(payload.failure.step).toBeUndefined();
    expect(payload.failure.reason).toContain(PARENT_ID);
    expect(payload.failure.detail).toContain('n8n-deploy-4242');
    expect(payload.steps.every((step) => step.outcome === 'skipped')).toBe(true);
    expect(payload.restartRequired).toBe(false);
    // Nothing generated, nothing imported, nothing published.
    expect(fakeN8nCalls()).toEqual([]);
    expect(existsSync(join(ARTIFACT_DIR, PARENT_FILE))).toBe(false);
  }, 60_000);

  test('human output names the contention rather than an unknown step', () => {
    holdDeployLock();
    const result = run(args('--yes'), deployEnv());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Deployment did not start');
    expect(result.stdout).toContain('already running');
    expect(result.stdout).not.toContain('unknown step');
    expect(result.stdout).not.toContain(REPO_ROOT);
  }, 60_000);

  test('the lock is released when the deploy finishes, so the next one runs', () => {
    const first = run([...args('--yes'), '--json'], deployEnv());
    expect(JSON.parse(first.stdout.trim()).ok).toBe(true);
    expect(existsSync(deployLockPath())).toBe(false);
    const second = run([...args('--yes'), '--json'], deployEnv());
    expect(JSON.parse(second.stdout.trim()).ok).toBe(true);
  }, 90_000);

  test('the lock is released after a failed deploy too', () => {
    // n8n reports only the child, so verification fails after both imports.
    writeListOutput([`${CHILD_WORKFLOW_ID}|${CHILD_WORKFLOW_NAME}`]);
    const result = run([...args('--yes'), '--json'], deployEnv());
    expect(result.code).toBe(1);
    expect(existsSync(deployLockPath())).toBe(false);
  }, 60_000);

  test('rejects an empty --lock-dir', () => {
    const result = run([...baseArgs, sessionsPath, '--lock-dir', '']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--lock-dir must not be empty');
  });
});

// ---------------------------------------------------------------------------
// Concurrent deploys of different sessions, through the shared child
// ---------------------------------------------------------------------------

describe('the shared-child deployment lock', () => {
  /** Pre-seed the child lock the way another session's deploy would hold it. */
  function holdChildLock(contextId = 'n8n-deploy-777') {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      childLockPath(),
      JSON.stringify({
        contextId,
        sessionId: `n8n-deploy-child:${CHILD_WORKFLOW_ID}`,
        startedAt: new Date().toISOString(),
      }),
    );
  }

  test('another session mid-deploy of the shared child refuses this one outright', () => {
    // Generation rewrites the one shared child artifact with this run's
    // CLI_BASE and the import reads it straight back, so a deploy of another
    // session in that window would have one run import the other's child.
    holdChildLock();
    const result = run([...args('--yes', '--publish'), '--json'], deployEnv());
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.published).toBe(false);
    // No step failed, because no step started.
    expect(payload.failure.step).toBeUndefined();
    expect(payload.failure.reason).toContain(CHILD_WORKFLOW_ID);
    expect(payload.failure.detail).toContain('n8n-deploy-777');
    expect(payload.steps.every((step) => step.outcome === 'skipped')).toBe(true);
    expect(payload.restartRequired).toBe(false);
    // Nothing generated, nothing imported, nothing published.
    expect(fakeN8nCalls()).toEqual([]);
    expect(existsSync(join(ARTIFACT_DIR, PARENT_FILE))).toBe(false);
    // The refused run must not leave its own session locked on the way out.
    expect(existsSync(deployLockPath())).toBe(false);
  }, 60_000);

  test('both locks are released when the deploy finishes, so the next one runs', () => {
    const first = run([...args('--yes'), '--json'], deployEnv());
    expect(JSON.parse(first.stdout.trim()).ok).toBe(true);
    expect(existsSync(childLockPath())).toBe(false);
    expect(existsSync(deployLockPath())).toBe(false);
    const second = run([...args('--yes'), '--json'], deployEnv());
    expect(JSON.parse(second.stdout.trim()).ok).toBe(true);
  }, 90_000);

  test('the child lock is released after a failed deploy too', () => {
    // n8n reports only the child, so verification fails after both imports —
    // well past the shared-child window, which must already have been handed
    // back rather than held to the end of the run.
    writeListOutput([`${CHILD_WORKFLOW_ID}|${CHILD_WORKFLOW_NAME}`]);
    const result = run([...args('--yes'), '--json'], deployEnv());
    expect(result.code).toBe(1);
    expect(existsSync(childLockPath())).toBe(false);
  }, 60_000);
});
