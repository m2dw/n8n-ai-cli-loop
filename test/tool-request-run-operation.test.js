/**
 * `tool-request.run` as a callable operation core (issue #1029).
 *
 * `docs/operation-dispatch-port-contract.md` §11.2 point 6 asks for exactly
 * this: the CLI's existing tests keep passing (test/admin-tool-request-run.test.js
 * and friends drive the real binary), PLUS a test that invokes the core through
 * the port and asserts the same decisions — with no argv, no subprocess, no
 * stdout capture, and no exit codes.
 *
 * Everything the core touches is injected here, so these cases run against
 * hand-written stores, a scripted git, and an in-memory artifact sink.
 */
import {
  createToolRequestRunDescriptor,
  parseToolRequestRunParams,
  runToolRequestRun,
  TOOL_REQUEST_RUN_OPERATION_ID,
  TOOL_REQUEST_RUN_LOCK_CONTEXT_ID,
} from '../dist/core/tool-request-run.js';
import { createOperationRegistry, invokeOperation } from '../dist/core/operation-port.js';
import { extractIssueVerificationCommands } from '../dist/handlers/issue-verification-extractor.js';

const SESSION_ID = 'addon-dev';
const ISSUE = 7;
const BRANCH = `ai/issue-${ISSUE}`;
// The exact command is what actually runs; `DISPLAY_COMMAND` is the redacted
// form recorded alongside it (core/tool-request.ts `redactCommand` masks the
// token flag). They deliberately differ so the public-comment assertions below
// can tell which of the two reaches the issue.
const COMMAND = 'npm install left-pad@^1.3.0 --registry-token=hunter2';
const DISPLAY_COMMAND = 'npm install left-pad@^1.3.0 --registry-token=***';

function session(overrides = {}) {
  return {
    id: SESSION_ID,
    repoRoot: '/repo',
    // Deliberately outside the repo so `artifactInsideRepo` is false and the
    // ignored-prefix set stays the conventional one.
    artifactRoot: '/artifacts',
    artifactDir: '.n8n-artifacts',
    baseBranch: 'main',
    githubOwner: 'acme',
    githubName: 'widgets',
    labels: {
      readyForHuman: 'status:ready-for-human',
      needsImplementation: 'status:needs-implementation',
      needsFix: 'status:needs-fix',
      agentImplementation: 'agent:claude',
    },
    verification: {},
    defaults: { implementationAgent: 'claude' },
    workItemProvider: { provider: 'github-issues' },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    status: 'ready_for_human',
    phase: 'implementation',
    priority: 'normal',
    attempts: {},
    context: {
      toolRequest: {
        command: COMMAND,
        displayCommand: DISPLAY_COMMAND,
        requestedAt: '2026-01-01T00:00:00.000Z',
        expectedFiles: ['package.json', 'package-lock.json'],
      },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    ...overrides,
  };
}

/** A task store that records what the core asked it to persist. */
function taskStore(stored, options = {}) {
  const transitions = [];
  const events = [];
  return {
    transitions,
    events,
    getTask: async () => (stored === undefined ? undefined : stored),
    transitionTask: async (key, expected, patch) => {
      transitions.push({ key, expected, patch });
      if (options.transitionResult) return options.transitionResult;
      return {
        ok: true,
        value: {
          ...stored,
          status: patch.status ?? stored.status,
          phase: patch.phase ?? stored.phase,
          context: { ...stored.context, ...(patch.context ?? {}) },
        },
      };
    },
    transitionTaskWithEffects: async (key, expected, patch, effects) => {
      transitions.push({ key, expected, patch, effects });
      if (options.transitionResult) return options.transitionResult;
      return {
        ok: true,
        value: {
          ...stored,
          status: patch.status ?? stored.status,
          phase: patch.phase ?? stored.phase,
          context: { ...stored.context, ...(patch.context ?? {}) },
        },
      };
    },
    appendEvent: async (event) => {
      events.push(event);
    },
  };
}

function outboxStore() {
  const entries = [];
  return { entries, enqueue: async (input) => void entries.push(input) };
}

/**
 * A scripted git plus the approved command itself.
 *
 * `produces` is the porcelain the approved command leaves behind; `exitCode`
 * is what it exits with. Everything else answers the way a healthy checkout
 * already on the issue branch would.
 */
function execPort({ exitCode = 0, produces = '', commitsOnBranch = false, probeOverrides = {} } = {}) {
  const state = { porcelain: '', head: 'HEAD0', branch: BRANCH };
  const calls = [];
  const answer = (args) => {
    const key = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(probeOverrides, key)) return probeOverrides[key];
    if (args[0] === 'status') {
      // The artifact-scoped probe (`status --porcelain -- <dir>`) must stay
      // empty: the run artifact is gitignored in this fixture.
      const scoped = args.includes('--') && args[args.length - 1].startsWith('/artifacts');
      return { ok: true, output: scoped ? '' : state.porcelain.trim() };
    }
    if (key === 'rev-parse --abbrev-ref HEAD') return { ok: true, output: state.branch };
    if (key === 'rev-parse HEAD') return { ok: true, output: state.head };
    if (key === 'rev-parse main') return { ok: true, output: 'BASE0' };
    if (key === 'rev-parse origin/main') return { ok: true, output: 'ORIGINBASE0' };
    if (args[0] === 'rev-list') return { ok: true, output: '0' };
    if (args[0] === 'diff') return { ok: true, output: 'diff --git a/x b/x\n' };
    if (args[0] === 'commit') {
      state.head = `${state.head}+`;
      state.porcelain = '';
      return { ok: true, output: '' };
    }
    if (key === 'reset --hard HEAD' || (args[0] === 'reset' && args[1] === '--hard')) {
      state.porcelain = '';
      return { ok: true, output: '' };
    }
    if (args[0] === 'clean') {
      state.porcelain = '';
      return { ok: true, output: '' };
    }
    return { ok: true, output: '' };
  };
  return {
    calls,
    state,
    probe(cmd, args) {
      calls.push([cmd, ...args].join(' '));
      return answer(args);
    },
    remoteHasBranch: () => 'yes',
    run(file, args) {
      calls.push([file, ...args].join(' '));
      if (file === '/bin/sh') {
        state.porcelain = produces;
        if (commitsOnBranch) state.head = 'HEAD1';
        return { exitCode, stdout: 'ran\n', stderr: '' };
      }
      const probed = answer(args);
      return { exitCode: probed.ok ? 0 : 1, stdout: probed.output, stderr: '' };
    },
    rawPorcelainStatus: () => state.porcelain,
  };
}

function artifactPort() {
  const written = new Map();
  const removed = [];
  return {
    written,
    removed,
    dirFor: (runId) => `/artifacts/runs/${runId}`,
    fileExists: (path) => written.has(path),
    writeFile: (path, contents) => void written.set(path, contents),
    removeDir: (path) => void removed.push(path),
  };
}

function lockPort({ locked = true } = {}) {
  const released = [];
  return {
    released,
    acquire: () =>
      locked
        ? { ok: true, locked: true }
        : { ok: true, locked: false, ownerContextId: 'phase-runner', ownerStartedAt: 'earlier' },
    release: (contextId, sessionId) => void released.push(`${contextId}:${sessionId}`),
  };
}

function context(parts = {}) {
  const store = parts.tasks ?? taskStore(task());
  return {
    invocation: {
      surface: 'admin-cli',
      actor: { kind: 'human', id: 'admin' },
      sessionId: SESSION_ID,
      issueNumber: ISSUE,
      requestId: 'req-1',
      confirmed: parts.confirmed ?? true,
      deadlineMs: null,
      ...(parts.invocation ?? {}),
    },
    session: parts.session ?? session(),
    tasks: store,
    outbox: parts.outbox ?? outboxStore(),
    repoLock: parts.repoLock ?? lockPort(),
    exec: parts.exec ?? execPort(),
    worktree: parts.worktree ?? { resolveRunCwd: () => ({ ok: true, cwd: '/repo' }) },
    artifacts: parts.artifacts ?? artifactPort(),
    now: () => '2026-02-02T00:00:00.000Z',
    runIdFor: (now) => `admin-tool-request-grant-${now}`,
    responseAction: parts.responseAction ?? 'guided-run',
    extractIssueVerificationCommands,
  };
}

function request(overrides = {}) {
  return {
    command: undefined,
    ttlSeconds: undefined,
    maxUses: undefined,
    disposition: 'keep',
    onChanges: undefined,
    confirmDiscard: false,
    allowUnexpected: false,
    ...overrides,
  };
}

describe('tool-request.run core — successful execution', () => {
  test('a true no-op resolves the request and re-queues implementation', async () => {
    const stored = task();
    const tasks = taskStore(stored);
    const outbox = outboxStore();
    const ctx = context({ tasks, outbox });

    const result = await runToolRequestRun({ request: request(), context: ctx });

    expect(result.status).toBe('executed');
    expect(result.effect).toBe('applied');
    expect(result.data.requeued).toBe(true);
    expect(result.data.exitCode).toBe(0);
    expect(result.data.action).toBe('guided-run');
    expect(result.data.branch).toBe(BRANCH);

    const requeue = tasks.transitions.at(-1);
    expect(requeue.patch.status).toBe('queued');
    expect(requeue.patch.phase).toBe('implementation');
    expect(requeue.patch.context.toolRequest.resolved).toBe(true);
    expect(requeue.patch.context.toolRequest.resolution.disposition).toBe('no-op');
    // The captured output is the deliverable for a verification-shaped request.
    expect(requeue.patch.context.toolRequest.resolution.capturedResult.stdout).toContain('ran');
    // Single-use: the grant is recorded as consumed.
    expect(requeue.patch.context.toolRequestGrant.uses).toBe(1);

    // Public surface: the lane labels and one redacted comment.
    const topics = outbox.entries.map((e) => e.topic);
    expect(topics).toContain('gh:label:remove');
    expect(topics).toContain('gh:label:add');
    expect(topics).toContain('gh:comment');
    const comment = outbox.entries.find((e) => e.topic === 'gh:comment');
    // The comment names the approved command in its redacted display form only —
    // the exact command (which carries the token here) never reaches the issue.
    expect(comment.payload.body).toContain(DISPLAY_COMMAND);
    expect(comment.payload.body).not.toContain(COMMAND);
  });

  test('the deprecated grant alias tags its response record as `grant`', async () => {
    const ctx = context({ responseAction: 'grant' });
    const result = await runToolRequestRun({ request: request(), context: ctx });
    expect(result.data.action).toBe('grant');
  });

  test('the repo lock is always released', async () => {
    const repoLock = lockPort();
    const ctx = context({ repoLock });
    await runToolRequestRun({ request: request(), context: ctx });
    expect(repoLock.released).toEqual([`${TOOL_REQUEST_RUN_LOCK_CONTEXT_ID}:${SESSION_ID}`]);
  });

  test('an unconfirmed invocation previews and reports no effect', async () => {
    const tasks = taskStore(task());
    const exec = execPort();
    const ctx = context({ tasks, exec, confirmed: false });

    const result = await runToolRequestRun({ request: request(), context: ctx });

    expect(result.status).toBe('executed');
    expect(result.effect).toBe('none');
    expect(result.data.dryRun).toBe(true);
    expect(result.data.wouldExecute).toBe(true);
    expect(tasks.transitions).toHaveLength(0);
    expect(exec.calls.some((c) => c.startsWith('/bin/sh'))).toBe(false);
  });
});

describe('tool-request.run core — definite refusals (retry is safe)', () => {
  const refusalCases = [
    {
      name: 'no task',
      build: () => ({ ctx: context({ tasks: taskStore(undefined) }), request: request() }),
      reason: 'precondition-failed',
      match: /Task not found/,
    },
    {
      name: 'no Tool Request on the task',
      build: () => ({
        ctx: context({ tasks: taskStore(task({ context: {} })) }),
        request: request(),
      }),
      reason: 'precondition-failed',
      match: /has no Tool Request to grant/,
    },
    {
      name: 'already-resolved Tool Request',
      build: () => ({
        ctx: context({
          tasks: taskStore(task({ context: { toolRequest: { command: COMMAND, resolved: true } } })),
        }),
        request: request(),
      }),
      reason: 'precondition-failed',
      match: /is already resolved/,
    },
    {
      name: 'an active task',
      build: () => ({
        ctx: context({ tasks: taskStore(task({ status: 'running', ownerRunId: 'run-9' })) }),
        request: request(),
      }),
      reason: 'conflict',
      match: /Refusing to grant against an active task/,
    },
    {
      name: 'a held repo lock',
      build: () => ({ ctx: context({ repoLock: lockPort({ locked: false }) }), request: request() }),
      reason: 'conflict',
      match: /repo lock for session/,
    },
    {
      name: 'a broadened --command',
      build: () => ({ ctx: context(), request: request({ command: 'npm install anything' }) }),
      reason: 'invalid-request',
      match: /Grants are exact-command only/,
    },
    {
      name: 'a dirty worktree',
      build: () => ({
        ctx: context({ exec: execPort({ probeOverrides: { 'status --porcelain': { ok: true, output: ' M src/x.ts' } } }) }),
        request: request(),
      }),
      reason: 'precondition-failed',
      match: /is dirty/,
    },
    {
      name: 'a local base branch ahead of origin',
      build: () => ({
        ctx: context({
          exec: execPort({
            probeOverrides: { 'rev-list --count origin/main..main': { ok: true, output: '2' } },
          }),
        }),
        request: request(),
      }),
      reason: 'precondition-failed',
      match: /ahead of origin\/main/,
    },
    {
      name: 'a misconfigured worktree root',
      build: () => ({
        ctx: context({ worktree: { resolveRunCwd: () => ({ ok: false, error: 'root is relative' }) } }),
        request: request(),
      }),
      reason: 'precondition-failed',
      match: /worktree root is misconfigured/,
    },
    {
      name: 'a lost pre-request partial diff',
      build: () => ({
        ctx: context({
          tasks: taskStore(
            task({
              context: {
                toolRequest: { command: COMMAND, partialDiffCaptureFailed: 'write failed' },
              },
            }),
          ),
        }),
        request: request(),
      }),
      reason: 'precondition-failed',
      match: /partial-diff capture failed/,
    },
  ];

  for (const c of refusalCases) {
    test(`${c.name} is rejected with no effect`, async () => {
      const { ctx, request: req } = c.build();
      const result = await runToolRequestRun({ request: req, context: ctx });
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe(c.reason);
      expect(result.effect).toBe('none');
      expect(result.summary).toMatch(c.match);
      // A definite refusal never runs the approved command.
      expect(ctx.exec.calls.some((call) => call.startsWith('/bin/sh'))).toBe(false);
      expect(ctx.tasks.transitions ?? []).toHaveLength(0);
    });
  }

  test('a consumed one-shot grant for the same command is not re-usable', async () => {
    const stored = task({
      context: {
        toolRequest: { command: COMMAND, requestedAt: '2026-01-01T00:00:00.000Z' },
        toolRequestGrant: {
          sessionId: SESSION_ID,
          issueNumber: ISSUE,
          phase: 'implementation',
          repoRoot: '/repo',
          // Same command hash the fresh candidate would produce.
          commandHash: null,
          grantedAt: '2026-01-02T00:00:00.000Z',
          expiresAt: '2026-01-02T00:10:00.000Z',
          maxUses: 1,
          uses: 1,
          grantedBy: 'admin',
        },
      },
    });
    // Give the stored grant the real hash by minting one through the core's own
    // happy path first, so this is a genuine reuse rather than a scope mismatch.
    const probe = context({ tasks: taskStore(task()) });
    const minted = await runToolRequestRun({ request: request(), context: probe });
    stored.context.toolRequestGrant.commandHash = minted.data.commandHash;

    const ctx = context({ tasks: taskStore(stored) });
    const result = await runToolRequestRun({ request: request(), context: ctx });

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('not-permitted');
    expect(result.summary).toMatch(/Grants are one-shot and cannot be reused/);
  });

  test('a NEWER Tool Request instance with the same command is admitted (issue #490)', async () => {
    const probe = context({ tasks: taskStore(task()) });
    const minted = await runToolRequestRun({ request: request(), context: probe });

    const stored = task({
      context: {
        // Requested AFTER the stored grant was issued → a distinct instance.
        toolRequest: { command: COMMAND, requestedAt: '2026-01-03T00:00:00.000Z' },
        toolRequestGrant: {
          sessionId: SESSION_ID,
          issueNumber: ISSUE,
          phase: 'implementation',
          repoRoot: '/repo',
          commandHash: minted.data.commandHash,
          grantedAt: '2026-01-02T00:00:00.000Z',
          expiresAt: '2026-01-02T00:10:00.000Z',
          maxUses: 1,
          uses: 1,
          grantedBy: 'admin',
        },
      },
    });

    const result = await runToolRequestRun({ request: request(), context: context({ tasks: taskStore(stored) }) });
    expect(result.status).toBe('executed');
  });
});

describe('tool-request.run core — dispositions', () => {
  test('commit lands the produced changes on the issue branch and re-queues', async () => {
    const tasks = taskStore(task());
    const exec = execPort({ produces: ' M package.json\n' });
    const result = await runToolRequestRun({
      request: request({ disposition: 'commit' }),
      context: context({ tasks, exec }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.disposition).toBe('committed');
    expect(result.data.requeued).toBe(true);
    // The commit message carries the redacted display form, not the exact command.
    expect(exec.calls).toContain(`git commit --no-verify -m Tool Request guided run: ${DISPLAY_COMMAND}`);
    expect(exec.calls).toContain(`git push origin ${BRANCH}`);

    const requeue = tasks.transitions.at(-1);
    expect(requeue.patch.status).toBe('queued');
    expect(requeue.patch.context.toolRequestResumeBranch).toBe(BRANCH);
  });

  test('discard reverts the produced changes and stays a human handoff', async () => {
    const tasks = taskStore(task());
    const exec = execPort({ produces: ' M package.json\n' });
    const artifacts = artifactPort();
    const result = await runToolRequestRun({
      request: request({ disposition: 'discard' }),
      context: context({ tasks, exec, artifacts }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.disposition).toBe('discarded');
    expect(result.data.requeued).toBe(false);
    // The partial-diff safeguard: a snapshot patch is kept before reverting.
    expect(result.data.discardPatch).toBe('discarded-changes.patch');
    expect([...artifacts.written.keys()].some((p) => p.endsWith('discarded-changes.patch'))).toBe(true);
    expect(exec.calls.some((c) => c.startsWith('git reset --hard'))).toBe(true);
    // Not re-queued: the produced changes were rejected, so nothing is landed.
    expect(tasks.transitions.at(-1).patch.status).toBe('ready_for_human');
  });

  test('keep leaves the changes for the operator and does not re-queue', async () => {
    const tasks = taskStore(task());
    const exec = execPort({ produces: ' M package.json\n' });
    const result = await runToolRequestRun({
      request: request({ disposition: 'keep' }),
      context: context({ tasks, exec }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.requeued).toBe(false);
    expect(result.data.dirtyAfter).toBe(true);
    expect(exec.calls.some((c) => c.startsWith('git commit'))).toBe(false);
    // The consumed grant is still recorded, so the command cannot run twice.
    expect(tasks.transitions.at(-1).patch.context.toolRequestGrant.uses).toBe(1);
  });

  test('a discard that cannot be verified clean is an indeterminate failure', async () => {
    const exec = execPort({ produces: ' M package.json\n' });
    // The revert leaves the tree dirty: `git clean -fd` will not recurse into a
    // nested repository, so the core must refuse to claim a discard.
    const original = exec.probe;
    exec.probe = (cmd, args) => {
      const out = original(cmd, args);
      if (args[0] === 'status' && args.includes(':(exclude).n8n-artifacts') && exec.state.head === 'HEAD0') {
        return { ok: true, output: ' M package.json' };
      }
      return out;
    };
    const result = await runToolRequestRun({
      request: request({ disposition: 'discard' }),
      context: context({ exec }),
    });

    expect(result.status).toBe('failed');
    expect(result.effect).toBe('unknown');
    expect(result.summary).toMatch(/Refusing to record discard/);
  });
});

describe('tool-request.run core — guided change handling (--on-changes)', () => {
  test('commit stages exactly the expected files', async () => {
    const exec = execPort({ produces: ' M package.json\n' });
    const result = await runToolRequestRun({
      request: request({ onChanges: 'commit' }),
      context: context({ exec }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.changeOutcome).toBe('committed');
    // Historically this path tags its payload `grant` regardless of the surface.
    expect(result.data.action).toBe('grant');
    expect(exec.calls).toContain('git add -- package.json');
  });

  test('an unexpected file is refused correctably, without touching the tree', async () => {
    const exec = execPort({ produces: ' M src/secret.ts\n' });
    const tasks = taskStore(task());
    const result = await runToolRequestRun({
      request: request({ onChanges: 'commit' }),
      context: context({ exec, tasks }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.changeOutcome).toBe('refused');
    expect(result.data.refusalCode).toBe('unexpected-files');
    const recorded = tasks.transitions.at(-1).patch.context.toolRequestChangeAction;
    expect(recorded.correctable).toBe(true);
    expect(exec.calls.some((c) => c.startsWith('git commit'))).toBe(false);
  });

  test('discard without confirmation is refused correctably', async () => {
    const exec = execPort({ produces: ' M package.json\n' });
    const result = await runToolRequestRun({
      request: request({ onChanges: 'discard', confirmDiscard: false }),
      context: context({ exec }),
    });
    expect(result.data.changeOutcome).toBe('refused');
    expect(result.data.refusalCode).toBe('needs-confirmation');
  });
});

describe('tool-request.run core — command failure', () => {
  test('a failing command with a clean tree returns its output to the agent', async () => {
    const tasks = taskStore(task());
    const result = await runToolRequestRun({
      request: request(),
      context: context({ tasks, exec: execPort({ exitCode: 2 }) }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.success).toBe(false);
    expect(result.data.exitCode).toBe(2);
    expect(result.data.requeued).toBe(true);
    const requeue = tasks.transitions.at(-1);
    expect(requeue.patch.phase).toBe('implementation');
    expect(requeue.patch.context.toolRequest.resolution.disposition).toBe('failed');
    expect(requeue.patch.context.toolRequest.resolution.capturedResult.exitCode).toBe(2);
  });

  test('a failing command that left changes stays a human handoff', async () => {
    const tasks = taskStore(task());
    const result = await runToolRequestRun({
      request: request(),
      context: context({ tasks, exec: execPort({ exitCode: 1, produces: ' M package.json\n' }) }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.success).toBe(false);
    expect(result.data.requeued).toBe(false);
    expect(result.data.dirtyAfter).toBe(true);
    expect(tasks.transitions.at(-1).patch.status).toBe('ready_for_human');
  });
});

describe('tool-request.run core — retry-safe result mapping', () => {
  test('a store conflict AFTER the command ran is failed/unknown, never rejected', async () => {
    const tasks = taskStore(task(), { transitionResult: { ok: false, code: 'conflict' } });
    const result = await runToolRequestRun({ request: request(), context: context({ tasks }) });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('internal');
    // The approved command already ran: its effects exist and cannot be
    // characterized, so a retry is NOT safe (contract §9.2's `unknown` row).
    expect(result.effect).toBe('unknown');
    expect(result.summary).toMatch(/Failed to record grant: conflict/);
  });

  test('every definite refusal reports effect "none" so a caller may retry', async () => {
    const result = await runToolRequestRun({
      request: request(),
      context: context({ tasks: taskStore(undefined) }),
    });
    expect(result.effect).toBe('none');
    expect(result.status).toBe('rejected');
  });
});

describe('tool-request.run through the operation-dispatch port', () => {
  function registryFor(ctx) {
    return createOperationRegistry([createToolRequestRunDescriptor(() => ctx)]);
  }

  function portContext(overrides = {}) {
    return {
      surface: 'chatops',
      actor: { kind: 'human', id: 'alice' },
      sessionId: SESSION_ID,
      issueNumber: ISSUE,
      requestId: 'chatops#1',
      confirmed: true,
      deadlineMs: null,
      ...overrides,
    };
  }

  test('the descriptor registers and is issue-scoped and mutating', () => {
    const registry = registryFor(context());
    const descriptor = registry.get(TOOL_REQUEST_RUN_OPERATION_ID);
    expect(descriptor).toBeDefined();
    expect(descriptor.scope).toBe('issue');
    expect(descriptor.mutating).toBe(true);
    expect(descriptor.params.map((p) => p.name)).toEqual([
      'command',
      'ttl-seconds',
      'max-uses',
      'disposition',
      'on-changes',
      'confirm-discard',
      'allow-unexpected',
    ]);
  });

  test('an invocation through the port reaches the same decision as a direct call', async () => {
    const tasks = taskStore(task());
    const ctx = context({ tasks });
    const result = await invokeOperation(
      registryFor(ctx),
      { operationId: TOOL_REQUEST_RUN_OPERATION_ID, params: {} },
      portContext(),
    );

    expect(result.status).toBe('executed');
    expect(result.effect).toBe('applied');
    expect(result.data.requeued).toBe(true);
    expect(tasks.transitions.at(-1).patch.phase).toBe('implementation');
  });

  test('an unconfirmed port invocation previews and reports no effect', async () => {
    const tasks = taskStore(task());
    const result = await invokeOperation(
      registryFor(context({ tasks, confirmed: false })),
      { operationId: TOOL_REQUEST_RUN_OPERATION_ID, params: { disposition: 'commit' } },
      portContext({ confirmed: false }),
    );
    expect(result.status).toBe('executed');
    expect(result.effect).toBe('none');
    expect(tasks.transitions).toHaveLength(0);
  });

  test('a bad disposition is an invalid-request rejection, never an execution', async () => {
    const exec = execPort();
    const result = await invokeOperation(
      registryFor(context({ exec })),
      { operationId: TOOL_REQUEST_RUN_OPERATION_ID, params: { disposition: 'bogus' } },
      portContext(),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('invalid-request');
    expect(result.summary).toMatch(/--disposition must be one of: keep, commit, discard/);
    expect(exec.calls).toHaveLength(0);
  });

  test('a trusted-context field supplied as a parameter is refused by the port', async () => {
    const exec = execPort();
    const result = await invokeOperation(
      registryFor(context({ exec })),
      { operationId: TOOL_REQUEST_RUN_OPERATION_ID, params: { 'session-id': 'other-session' } },
      portContext(),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('invalid-request');
    expect(exec.calls).toHaveLength(0);
  });

  test('an issue-scoped operation without a work item is refused', async () => {
    const result = await invokeOperation(
      registryFor(context()),
      { operationId: TOOL_REQUEST_RUN_OPERATION_ID, params: {} },
      portContext({ issueNumber: null }),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('invalid-context');
  });

  test('summaries reaching the port are bounded even when the core returns full detail', async () => {
    const longPath = `/very/long/path/${'x'.repeat(600)}`;
    const result = await invokeOperation(
      registryFor(context({ worktree: { resolveRunCwd: () => ({ ok: false, error: longPath }) } })),
      { operationId: TOOL_REQUEST_RUN_OPERATION_ID, params: {} },
      portContext(),
    );
    expect(result.status).toBe('rejected');
    expect(result.summary.length).toBeLessThanOrEqual(500);
    expect(result.summary.endsWith('… (truncated)')).toBe(true);
  });
});

describe('tool-request.run parameter parsing', () => {
  test('defaults match the CLI defaults', () => {
    const parsed = parseToolRequestRunParams({});
    expect(parsed.request).toEqual({
      command: undefined,
      ttlSeconds: undefined,
      maxUses: undefined,
      disposition: 'keep',
      onChanges: undefined,
      confirmDiscard: false,
      allowUnexpected: false,
    });
  });

  test('the confirmation flags are only valid alongside the action they guard', () => {
    expect(parseToolRequestRunParams({ 'confirm-discard': true }).error).toMatch(
      /only valid with --on-changes discard/,
    );
    expect(parseToolRequestRunParams({ 'allow-unexpected': true, 'on-changes': 'keep' }).error).toMatch(
      /only valid with --on-changes commit/,
    );
  });

  test('non-positive ttl/max-uses are refused', () => {
    expect(parseToolRequestRunParams({ 'ttl-seconds': 0 }).error).toMatch(/positive number/);
    expect(parseToolRequestRunParams({ 'max-uses': 1.5 }).error).toMatch(/positive integer/);
  });

  test('an unknown --on-changes value is refused', () => {
    expect(parseToolRequestRunParams({ 'on-changes': 'nope' }).error).toMatch(/--on-changes must be one of/);
  });
});
