import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore } from '../dist/index.js';

// Issue #430 — `admin tool-request run`: the redesigned guided run. It executes
// the exact approved command (handler-owned, outside the agent tool surface),
// captures the result, and takes an explicit disposition for any produced
// changes. The no-op verification case folds the captured output into the next
// implementation prompt as continuation context; commit/discard let the
// orchestrator perform the git plumbing instead of the operator doing it by hand.

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;
let lockDir;

function run(...args) {
  // The guided run takes the repo lock around its preflight + execution; keep it
  // hermetic to the test's tmp dir (the default lock dir is global state).
  if (args[0] === 'tool-request' && (args[1] === 'run' || args[1] === 'grant') && !args.includes('--lock-dir')) {
    args = [...args, '--lock-dir', lockDir];
  }
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

function writeSession(overrides = {}) {
  const session = {
    sessionId: 'addon-dev',
    repoKey: 'some-repo',
    repoRoot,
    githubRepo: 'm2dw/some-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
}

async function seedToolRequestTask(issueNumber, { command = 'true', ...extra } = {}) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'implementation', implementationAgent: 'claude' });
  await store.transitionTask(
    { sessionId: 'addon-dev', issueNumber },
    { status: 'queued' },
    {
      status: 'ready_for_human',
      phase: 'implementation',
      context: {
        labels: ['ai:ready-for-human', 'status:needs-implementation', 'agent:claude'],
        toolRequest: {
          command,
          displayCommand: command,
          reason: 'Needs the approved command.',
          expectedFiles: ['package.json'],
          necessity: 'required',
          suggestedAction: 'guided-run',
          requestedBy: 'claude',
          mode: 'new',
          requestedAt: '2026-06-07T00:00:00.000Z',
          resolved: false,
          ...extra,
        },
      },
    },
  );
  store.close();
}

function initRepo({ withRemote, ignoreArtifacts = true } = {}) {
  mkdirSync(repoRoot, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"x"}\n', 'utf8');
  // Most repos gitignore the artifact dir; pass ignoreArtifacts:false to exercise
  // the case where they don't (the guided-run staging/clean must still keep the
  // local run artifact out of commits and preserve the discard snapshot).
  writeFileSync(join(repoRoot, '.gitignore'), ignoreArtifacts ? '.n8n-artifacts/\n' : '', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('branch', '-M', 'main');
  if (withRemote) {
    const remotePath = join(tmpDir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', remotePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('remote', 'add', 'origin', remotePath);
    git('push', '-q', '-u', 'origin', 'main');
  }
}

async function getTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  const tasks = store.listTasks('addon-dev', issueNumber);
  store.close();
  return tasks[0];
}

async function getOutbox() {
  const store = new SqliteOutboxStore(dbPath);
  const entries = await store.listPending();
  store.close();
  return entries;
}

function gitOut(...a) {
  return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-trr-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
  lockDir = join(tmpDir, 'locks');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discoverability
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request run: discoverability', () => {
  test('help lists the guided run', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tool-request run');
  });

  test('"help tool-request run" documents the disposition flag', () => {
    const r = run('help', 'tool-request run');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--disposition');
    expect(r.stdout).toContain('commit');
    expect(r.stdout).toContain('discard');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request run: validation', () => {
  test('rejects an unknown disposition', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'true' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'bogus', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    // Nothing executed; request untouched.
    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(task.context.toolRequestGrant).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No-op verification command → captured output becomes continuation context
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request run: no-op verification', () => {
  test('captures the output and re-queues with it as continuation context', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'echo verifying-output' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'guided-run',
      executed: true,
      exitCode: 0,
      success: true,
      status: 'queued',
      phase: 'implementation',
      requeued: true,
    });

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.context.toolRequest.resolved).toBe(true);
    const resolution = task.context.toolRequest.resolution;
    expect(resolution.action).toBe('guided-run');
    expect(resolution.disposition).toBe('no-op');
    // The captured output is the deliverable folded into the next prompt.
    expect(resolution.capturedResult.exitCode).toBe(0);
    expect(resolution.capturedResult.stdout).toContain('verifying-output');
  });

  test('an artifact-only dirty tree (artifact dir not gitignored) still takes the no-op requeue path under --disposition commit', async () => {
    // Finding (issue #430 review): the local run artifact (`tool-request-grant.json`)
    // is written before the dirtiness probe. When the repo does not gitignore the
    // session artifact dir, that artifact alone makes a genuine no-op command look
    // like it produced changes — routing it into the commit disposition, where the
    // commit then fails for having no real changes. The dirtiness check must exclude
    // the artifact dir so a no-op verification command requeues regardless of the
    // requested disposition.
    writeSession();
    initRepo({ ignoreArtifacts: false });
    await seedToolRequestTask(123, { command: 'true' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'commit', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'guided-run',
      executed: true,
      exitCode: 0,
      success: true,
      status: 'queued',
      requeued: true,
    });

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.context.toolRequest.resolved).toBe(true);
    // The no-op path was taken — not the commit disposition (which would have
    // failed to commit an artifact-only tree).
    expect(task.context.toolRequest.resolution.disposition).toBe('no-op');
  });

  test('leaves a clean working tree on requeue when the artifact dir is not gitignored', async () => {
    // Finding (issue #430 review): the no-op path excludes the artifact dir from
    // its OWN dirtiness probe, but the local run artifact still sits in the tree
    // as an untracked file when the repo does not gitignore it. The next
    // implementation phase's plain `git status --porcelain` preflight would then
    // abort as dirty and strand the just-requeued Tool Request. The artifact must
    // be cleared before requeueing so that preflight sees a clean tree.
    writeSession();
    initRepo({ ignoreArtifacts: false });
    await seedToolRequestTask(123, { command: 'true' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, requeued: true, status: 'queued' });

    const task = await getTask(123);
    expect(task.context.toolRequest.resolution.disposition).toBe('no-op');
    // Simulate the next implementation preflight: a plain porcelain status must be
    // clean so the requeued task is not immediately stranded.
    expect(gitOut('status', '--porcelain')).toBe('');
  });

  test('preserves the local run artifact on requeue when the artifact dir is gitignored', async () => {
    // The removal is gated on the artifact actually showing up as a working-tree
    // change. In the normal (gitignored) case the artifact never pollutes the
    // tree, so the local audit record is kept intact as before.
    writeSession();
    initRepo({ ignoreArtifacts: true });
    await seedToolRequestTask(123, { command: 'true' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, requeued: true });

    const runsDir = join(repoRoot, '.n8n-artifacts', 'runs');
    const kept = existsSync(runsDir)
      ? readdirSync(runsDir).some(d => existsSync(join(runsDir, d, 'tool-request-grant.json')))
      : false;
    expect(kept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Repo-changing command: commit disposition
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request run: --disposition commit', () => {
  test('commits and pushes the produced changes on the issue branch, then re-queues', async () => {
    writeSession();
    initRepo({ withRemote: true });
    await seedToolRequestTask(123, { command: 'touch generated.txt' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'commit', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'guided-run',
      executed: true,
      success: true,
      requeued: true,
      disposition: 'committed',
      branch: 'ai/issue-123',
    });

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequest.resolution.disposition).toBe('committed');
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');

    // The change is committed on the issue branch (not the base) and pushed.
    expect(gitOut('rev-parse', '--abbrev-ref', 'HEAD')).toBe('ai/issue-123');
    expect(gitOut('ls-files', 'generated.txt')).toBe('generated.txt');
    const remoteRefs = gitOut('ls-remote', 'origin', 'ai/issue-123');
    expect(remoteRefs).toContain('refs/heads/ai/issue-123');
    // Base branch untouched (issue #316): commit must not land on main.
    expect(gitOut('rev-list', '--count', 'origin/main..main')).toBe('0');

    const outbox = await getOutbox();
    const added = outbox.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).toContain('status:needs-implementation');
    const comment = outbox.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('committed');
    expect(comment.payload.body).not.toContain(repoRoot);
  });

  test('does not stage/commit the local run artifact when the artifact dir is not gitignored', async () => {
    writeSession();
    initRepo({ withRemote: true, ignoreArtifacts: false });
    await seedToolRequestTask(123, { command: 'touch generated.txt' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'commit', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, disposition: 'committed', requeued: true });

    // The command's change landed, but the local run artifact (which embeds the
    // exact command + stdout/stderr) must NOT be committed or pushed.
    expect(gitOut('ls-files', 'generated.txt')).toBe('generated.txt');
    expect(gitOut('ls-files', '.n8n-artifacts')).toBe('');
    // The working tree must be clean after the requeue: when the artifact dir is
    // not gitignored, leaving the just-written `tool-request-grant.json` as an
    // untracked file would make the next implementation phase's plain
    // `git status --porcelain` preflight abort as dirty and strand the requeued
    // Tool Request (issue #430 review). The artifact is cleared before requeueing.
    expect(gitOut('status', '--porcelain')).toBe('');
    // The run's artifact subtree was removed, so no `tool-request-grant.json`
    // lingers under the (non-ignored) artifact dir.
    const runsDir = join(repoRoot, '.n8n-artifacts', 'runs');
    const lingering = existsSync(runsDir)
      ? readdirSync(runsDir).some(d => existsSync(join(runsDir, d, 'tool-request-grant.json')))
      : false;
    expect(lingering).toBe(false);
  });

  test('records the consumed grant when the post-commit push fails (issue #430 review)', async () => {
    // Finding (issue #430 review): with --disposition commit the command runs and a
    // local commit is created before `git push`. If the push fails, the grant must
    // already be persisted as consumed — otherwise the task looks as if the one-shot
    // authorization was never used and the exact command could be granted and run
    // again. Reject the push with an origin pre-receive hook so it fails only after
    // the command has run and the commit has landed locally.
    writeSession();
    initRepo({ withRemote: true });
    const hookPath = join(tmpDir, 'origin.git', 'hooks', 'pre-receive');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await seedToolRequestTask(123, { command: 'touch generated.txt' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'commit', '--db-path', dbPath, '--sessions-path', sessionsPath);
    // The push failure fails the guided run closed; it does not re-queue.
    expect(r.code).not.toBe(0);

    const task = await getTask(123);
    // The grant is persisted as consumed so the exact command cannot be re-run.
    expect(task.context.toolRequestGrant).toBeDefined();
    expect(task.context.toolRequestGrant.uses).toBe(1);
    // Not re-queued: the request stays open for the operator to push manually.
    expect(task.context.toolRequest.resolved).toBe(false);
    // The commit was created locally on the issue branch before the failed push.
    expect(gitOut('rev-parse', '--abbrev-ref', 'HEAD')).toBe('ai/issue-123');
    expect(gitOut('ls-files', 'generated.txt')).toBe('generated.txt');
  });
});

// ---------------------------------------------------------------------------
// Repo-changing command: discard disposition
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request run: --disposition discard', () => {
  test('reverts the produced changes, snapshots them, and stays a human handoff', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'touch generated.txt' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'discard', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'guided-run',
      executed: true,
      success: true,
      requeued: false,
      disposition: 'discarded',
    });

    const task = await getTask(123);
    // Discard does not re-queue; the request stays a human handoff.
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    // The authorization is consumed (one-shot) so the exact command can't re-run.
    expect(task.context.toolRequestGrant.uses).toBe(1);
    // The produced change was reverted.
    expect(existsSync(join(repoRoot, 'generated.txt'))).toBe(false);

    // A snapshot patch of the discarded change was preserved.
    const runsDir = join(repoRoot, '.n8n-artifacts', 'runs');
    const runDirs = readdirSync(runsDir);
    const patch = runDirs
      .map(d => join(runsDir, d, 'discarded-changes.patch'))
      .find(p => existsSync(p));
    expect(patch).toBeTruthy();
    expect(readFileSync(patch, 'utf8')).toContain('generated.txt');
  });

  test('preserves the discard snapshot when the artifact dir is not gitignored', async () => {
    writeSession();
    initRepo({ ignoreArtifacts: false });
    await seedToolRequestTask(123, { command: 'touch generated.txt' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'discard', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, disposition: 'discarded', requeued: false });

    // The produced change was reverted.
    expect(existsSync(join(repoRoot, 'generated.txt'))).toBe(false);
    // The snapshot survives the post-revert `git clean` even though the artifact
    // dir is not ignored (the clean excludes it), so the safeguard is not lost.
    const runsDir = join(repoRoot, '.n8n-artifacts', 'runs');
    const patch = readdirSync(runsDir)
      .map(d => join(runsDir, d, 'discarded-changes.patch'))
      .find(p => existsSync(p));
    expect(patch).toBeTruthy();
    expect(readFileSync(patch, 'utf8')).toContain('generated.txt');
    // The snapshot is a faithful partial-diff of the produced change only — it
    // must not embed the local run artifact (and its command/output).
    expect(readFileSync(patch, 'utf8')).not.toContain('tool-request-grant.json');
  });

  test('fails closed when the revert leaves generated files behind (nested git repo)', async () => {
    // Finding (issue #430 review): `git clean -fd` will not recurse into a nested
    // git repository, so a command that creates one leaves the file behind after
    // the revert. Recording `disposition: discarded` and telling the operator the
    // branch was reverted would be a false claim. The guided run must verify the
    // tree is clean and fail closed otherwise.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'git init -q nested && touch nested/payload.txt' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'discard', '--db-path', dbPath, '--sessions-path', sessionsPath);

    // Fail closed: non-zero exit, no discard recorded.
    expect(r.code).not.toBe(0);

    const task = await getTask(123);
    // The grant was NOT consumed, so the operator can retry after cleaning up.
    expect(task.context.toolRequestGrant).toBeUndefined();
    // The request is still an unresolved human handoff (not falsely discarded).
    expect(task.context.toolRequest.resolved).toBe(false);
    // The command's nested repo is still in the checkout — surfaced, not hidden.
    expect(existsSync(join(repoRoot, 'nested'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// keep (default) disposition: parity with the legacy grant hand-back
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request run: --disposition keep (default)', () => {
  test('leaves produced changes on the issue branch for the operator', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'touch generated.txt' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'guided-run',
      requeued: false,
      dirtyAfter: true,
      status: 'ready_for_human',
    });

    const task = await getTask(123);
    expect(task.context.toolRequest.resolved).toBe(false);
    expect(existsSync(join(repoRoot, 'generated.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Execution failure (issue #678): a non-zero exit is diagnostic information for
// the implementation agent, not by itself a reason to stop at a human handoff.
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request run: execution failure', () => {
  test('a non-zero exit that leaves the tree clean requeues automatically with the failure delivered to the agent', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'false' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      action: 'guided-run',
      executed: true,
      success: false,
      requeued: true,
      status: 'queued',
      phase: 'implementation',
    });

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.context.toolRequest.resolved).toBe(true);
    const resolution = task.context.toolRequest.resolution;
    expect(resolution.action).toBe('guided-run');
    expect(resolution.disposition).toBe('failed');
    expect(resolution.capturedResult.exitCode).not.toBe(0);
  });

  test('a non-zero exit that leaves changes behind stays a human handoff', async () => {
    writeSession();
    initRepo();
    await seedToolRequestTask(123, { command: 'sh -c "echo dirty > leftover.txt; exit 1"' });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      executed: true,
      success: false,
      requeued: false,
      status: 'ready_for_human',
    });

    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #629 — ignored .n8n-artifacts/** must not break pre-request capture;
// capture failure must be fail-closed; disposition commit must restore source
// edits from the captured patch before running the command.
// ---------------------------------------------------------------------------

describe('admin CLI — tool-request run: issue #629 pre-request capture and fail-closed', () => {
  test('refuses to execute when partialDiffCaptureFailed is set (fail-closed, issue #629)', async () => {
    // Scenario: the implementation handoff could not capture the source edits as
    // a patch (e.g. because git add -A failed on a gitignored artifact path).
    // Running the command now would execute against old source and requeueing
    // would restart implementation from the pre-edit state, causing an infinite
    // loop. The guided run must refuse instead.
    writeSession();
    initRepo();
    await seedToolRequestTask(123, {
      command: 'node internal/qa/gen-workbook.mjs',
      partialDiffCaptureFailed: 'git add -A -- . :(exclude).n8n-artifacts failed (exit 128): The following paths are ignored by one of your .gitignore files:\n.n8n-artifacts',
    });
    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--db-path', dbPath, '--sessions-path', sessionsPath);

    // Must refuse — non-zero exit and the error explains the capture failure.
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.error).toContain('partial-diff capture failed');
    expect(out.error).toContain('.n8n-artifacts');

    // The task is unchanged: unresolved, not requeued.
    const task = await getTask(123);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.toolRequest.resolved).toBe(false);
    // No grant was issued (command was never run).
    expect(task.context.toolRequestGrant).toBeUndefined();
  });

  test('--disposition commit applies the captured source-edit patch before running the command, then commits both (issue #629)', async () => {
    // Scenario: the implementation handler captured source edits in a partial-diff
    // patch (shared-checkout mode). The guided run must apply that patch before
    // running the command so the command sees the edited source; with
    // --disposition commit both the restored edits and the command output must
    // land on the issue branch in a single commit.
    writeSession();
    initRepo({ withRemote: true });

    // Simulate a handoff artifact dir containing the captured partial-diff patch.
    // The patch adds a new source file 'src/gen.mjs' that the generator command
    // relies on (it's the output of the agent's source edits).
    const handoffRunId = 'run-impl-629';
    const handoffArtifactDir = join(repoRoot, '.n8n-artifacts', 'runs', handoffRunId);
    mkdirSync(handoffArtifactDir, { recursive: true });

    // Create the patch: adds src/gen.mjs with a known marker.
    // We build a real git patch so `git apply` accepts it.
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // Stage a file, diff it, then unstage — purely to build a valid patch string.
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'gen.mjs'), '// GEN_MARKER\n', 'utf8');
    git('add', 'src/gen.mjs');
    const patchContent = execFileSync('git', ['diff', '--cached', '--binary', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    git('reset', '-q', '--', 'src/gen.mjs');
    // Clean up the file so the repo is back to the original state for the grant.
    rmSync(join(repoRoot, 'src', 'gen.mjs'));

    writeFileSync(join(handoffArtifactDir, 'partial-implementation.patch'), patchContent, 'utf8');

    // The generator command reads the source file and produces an output.
    const generatorCommand = 'cat src/gen.mjs > generated-output.txt';

    await seedToolRequestTask(123, {
      command: generatorCommand,
      partialDiffArtifact: 'partial-implementation.patch',
      // No preservedBranch: shared-checkout mode, patch is the only copy of the edits.
    });

    // Store the handoff artifactDir on the task context so the guided run can
    // locate the patch (mirrors what the implementation handler records).
    const store = new SqliteTaskStore(dbPath);
    const tasks = store.listTasks('addon-dev', 123);
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 123 },
      { status: tasks[0].status },
      { status: tasks[0].status, phase: tasks[0].phase, context: { ...tasks[0].context, artifactDir: handoffArtifactDir } },
    );
    store.close();

    const r = run('tool-request', 'run', '--session-id', 'addon-dev', '--issue-number', '123', '--disposition', 'commit', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      executed: true,
      success: true,
      requeued: true,
      disposition: 'committed',
      branch: 'ai/issue-123',
    });

    // Both the source edit (from the patch) and the command output must be on
    // the issue branch — the next implementation run must see both.
    expect(gitOut('rev-parse', '--abbrev-ref', 'HEAD')).toBe('ai/issue-123');
    // The source file restored from the patch is on the branch.
    expect(gitOut('ls-files', 'src/gen.mjs')).toBe('src/gen.mjs');
    // The command produced output using that source file.
    expect(gitOut('ls-files', 'generated-output.txt')).toBe('generated-output.txt');
    // The output contains the content from the restored source file.
    const outputContent = readFileSync(join(repoRoot, 'generated-output.txt'), 'utf8');
    expect(outputContent).toContain('GEN_MARKER');

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.context.toolRequest.resolution.disposition).toBe('committed');
    expect(task.context.toolRequestResumeBranch).toBe('ai/issue-123');
  });
});
