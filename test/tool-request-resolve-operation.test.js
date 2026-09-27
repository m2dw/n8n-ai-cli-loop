/**
 * `tool-request.resolve` as a callable operation core (issue #1030).
 *
 * `docs/operation-dispatch-port-contract.md` §11.2 point 6 asks for exactly
 * this: the CLI's existing tests keep passing (test/admin-tool-request.test.js
 * drives the real binary), PLUS a test that invokes the core through the port
 * and asserts the same decisions — with no argv, no subprocess, no stdout
 * capture, and no exit codes.
 *
 * Everything the core touches is injected here, so these cases run against
 * hand-written stores and a scripted git.
 */
import {
  createToolRequestResolveDescriptor,
  parseToolRequestResolveParams,
  runToolRequestResolve,
  TOOL_REQUEST_RESOLVE_OPERATION_ID,
} from '../dist/core/tool-request-resolve.js';
import { createOperationRegistry, invokeOperation } from '../dist/core/operation-port.js';
import { CHATOPS_OPERATION_MAPPINGS } from '../dist/core/chatops-operation-mapping.js';
import { toolRequestResolutionPromptSection } from '../dist/core/tool-request.js';

const SESSION_ID = 'addon-dev';
const ISSUE = 7;
const BRANCH = `ai/issue-${ISSUE}`;
// The exact command is what the agent asked for; `DISPLAY_COMMAND` is the
// redacted form recorded alongside it (core/tool-request.ts `redactCommand`
// masks the token flag). They deliberately differ so the public-comment
// assertions below can tell which of the two reaches the issue.
const COMMAND = 'npm install left-pad@^1.3.0 --registry-token=hunter2';
const DISPLAY_COMMAND = 'npm install left-pad@^1.3.0 --registry-token=***';

function session(overrides = {}) {
  return {
    id: SESSION_ID,
    repoRoot: '/repo',
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

function toolRequest(overrides = {}) {
  return {
    command: COMMAND,
    displayCommand: DISPLAY_COMMAND,
    requestedAt: '2026-01-01T00:00:00.000Z',
    expectedFiles: ['package.json', 'package-lock.json'],
    resolved: false,
    ...overrides,
  };
}

function task(overrides = {}) {
  const { toolRequest: tr, context, ...rest } = overrides;
  return {
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    status: 'ready_for_human',
    phase: 'implementation',
    priority: 'normal',
    attempts: {},
    context: context ?? { toolRequest: tr ?? toolRequest() },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    ...rest,
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
    appendEvent: async (event) => {
      if (options.appendEventThrows) throw new Error('event store is down');
      events.push(event);
    },
  };
}

function outboxStore({ throwsOn } = {}) {
  const entries = [];
  return {
    entries,
    enqueue: async (input) => {
      if (throwsOn !== undefined && input.topic === throwsOn) {
        throw new Error('outbox is locked for maintenance');
      }
      entries.push(input);
    },
  };
}

/**
 * A scripted git. Answers the way a healthy checkout with a pushed issue branch
 * would; `probeOverrides` is keyed on the joined argument list.
 */
function execPort({ probeOverrides = {}, remote = 'yes' } = {}) {
  const calls = [];
  return {
    calls,
    probe(cmd, args) {
      const key = args.join(' ');
      calls.push([cmd, ...args].join(' '));
      if (Object.prototype.hasOwnProperty.call(probeOverrides, key)) return probeOverrides[key];
      if (args[0] === 'status') return { ok: true, output: '' };
      if (args[0] === 'rev-list') return { ok: true, output: '0' };
      return { ok: true, output: '' };
    },
    remoteHasBranch: () => remote,
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
    exec: parts.exec ?? execPort(),
    worktree: parts.worktree ?? { resolveDirtyCheckCwd: () => ({ ok: true, cwd: '/repo' }) },
    now: () => '2026-02-02T00:00:00.000Z',
    runIdFor: (now) => `admin-tool-request-resolve-${now}`,
  };
}

const manualDone = { action: 'manual-done' };
const reject = { action: 'reject', message: 'Avoid this dependency change.' };

describe('tool-request.resolve core — recorded decisions', () => {
  test('manual-done resolves the request and re-queues implementation', async () => {
    const tasks = taskStore(task());
    const outbox = outboxStore();
    const ctx = context({ tasks, outbox });

    const result = await runToolRequestResolve({ request: manualDone, context: ctx });

    expect(result.status).toBe('executed');
    expect(result.effect).toBe('applied');
    expect(result.data.outcome).toBe('manual_done');
    expect(result.data.requeued).toBe(true);
    expect(result.data.action).toBe('manual-done');
    expect(result.data.previousStatus).toBe('ready_for_human');

    const transition = tasks.transitions.at(-1);
    // The compare-and-swap is on the status this invocation observed, so a
    // concurrent writer loses the race instead of double-applying the decision.
    expect(transition.expected).toEqual({ status: 'ready_for_human' });
    expect(transition.patch.status).toBe('queued');
    expect(transition.patch.phase).toBe('implementation');
    expect(transition.patch.context.toolRequest.resolved).toBe(true);
    expect(transition.patch.context.toolRequest.resolution).toEqual({
      action: 'manual-done',
      resolvedAt: '2026-02-02T00:00:00.000Z',
    });
    // The pushed issue branch is the continuation point the requeued run resumes
    // from, instead of branching fresh from base.
    expect(transition.patch.context.toolRequestResumeBranch).toBe(BRANCH);

    // Public surface: the lane labels and one redacted comment.
    const topics = outbox.entries.map((e) => e.topic);
    expect(topics).toContain('gh:label:remove');
    expect(topics).toContain('gh:label:add');
    expect(topics).toContain('gh:comment');
    const added = outbox.entries.filter((e) => e.topic === 'gh:label:add').map((e) => e.payload.label);
    expect(added).toEqual(['status:needs-implementation', 'agent:claude']);
    const comment = outbox.entries.find((e) => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain(DISPLAY_COMMAND);
    expect(comment.payload.body).not.toContain(COMMAND);

    const event = tasks.events.at(-1);
    expect(event.type).toBe('tool_request_resolved');
    expect(event.data).toMatchObject({ action: 'manual-done', outcome: 'manual_done', requeued: true });
  });

  test('reject records the decision, requeues, and carries the operator message', async () => {
    const tasks = taskStore(task());
    const outbox = outboxStore();
    const ctx = context({ tasks, outbox });

    const result = await runToolRequestResolve({ request: reject, context: ctx });

    expect(result.status).toBe('executed');
    expect(result.data.outcome).toBe('rejected');
    expect(result.data.requeued).toBe(true);
    expect(result.data.message).toBe('Avoid this dependency change.');

    const transition = tasks.transitions.at(-1);
    expect(transition.patch.context.toolRequest.resolution).toEqual({
      action: 'reject',
      message: 'Avoid this dependency change.',
      resolvedAt: '2026-02-02T00:00:00.000Z',
    });
    // The operator's answer must reach the next implementation continuation, so
    // it is both stored on the request and published.
    const comment = outbox.entries.find((e) => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('Avoid this dependency change.');
    expect(comment.payload.body).toContain('re-queued for implementation');
  });

  test('the persisted resolution is what the next implementation prompt reads', async () => {
    // The whole point of recording a decision is the continuation: the
    // requeued implementation run renders `context.toolRequest` through
    // `toolRequestResolutionPromptSection`, so the operator's answer has to
    // survive in exactly the shape that reader expects (action + message).
    const tasks = taskStore(task());
    await runToolRequestResolve({ request: reject, context: context({ tasks }) });
    const persisted = tasks.transitions.at(-1).patch.context.toolRequest;

    const section = toolRequestResolutionPromptSection(persisted).join('\n');
    expect(section).toContain('The operator responded: reject');
    expect(section).toContain('Operator note:');
    expect(section).toContain('Avoid this dependency change.');
    expect(section).toContain('Treat this as feedback from the human.');
  });

  test('a fix-mode request requeues under the fix lane label', async () => {
    const tasks = taskStore(task({ toolRequest: toolRequest({ mode: 'fix' }) }));
    const outbox = outboxStore();
    await runToolRequestResolve({ request: manualDone, context: context({ tasks, outbox }) });
    const added = outbox.entries.filter((e) => e.topic === 'gh:label:add').map((e) => e.payload.label);
    expect(added).toContain('status:needs-fix');
    expect(added).not.toContain('status:needs-implementation');
  });

  test('an unconfirmed invocation previews and reports no effect', async () => {
    const tasks = taskStore(task());
    const outbox = outboxStore();
    const exec = execPort();
    const ctx = context({ tasks, outbox, exec, confirmed: false });

    const result = await runToolRequestResolve({ request: manualDone, context: ctx });

    expect(result.status).toBe('executed');
    expect(result.effect).toBe('none');
    expect(result.data.dryRun).toBe(true);
    expect(result.data.wouldRequeue).toEqual({ status: 'queued', phase: 'implementation' });
    expect(tasks.transitions).toHaveLength(0);
    expect(outbox.entries).toHaveLength(0);
    // The preview never touches the network/auth layer: no fetch is issued.
    expect(exec.calls.some((c) => c.startsWith('git fetch'))).toBe(false);
  });
});

describe('tool-request.resolve core — the one-shot post-rejection recovery (#674)', () => {
  const rejectedRequest = toolRequest({
    resolved: true,
    resolution: { action: 'reject', message: 'No.', resolvedAt: '2026-01-02T00:00:00.000Z' },
  });

  test('manual-done after a plain reject resumes the branch without rewriting history', async () => {
    const tasks = taskStore(task({ toolRequest: rejectedRequest }));
    const outbox = outboxStore();

    const result = await runToolRequestResolve({
      request: manualDone,
      context: context({ tasks, outbox }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.outcome).toBe('requeued_after_rejection');
    const stored = tasks.transitions.at(-1).patch.context.toolRequest;
    // The original rejection is preserved — reporting it as a manual-done would
    // tell the resumed agent the command ran, which it never did.
    expect(stored.resolution.action).toBe('reject');
    expect(stored.rejectRecoveryConsumed).toBe(true);
    const comment = outbox.entries.find((e) => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('never run');
  });

  test('the exemption is one-shot: a second manual-done is refused', async () => {
    const tasks = taskStore(
      task({ toolRequest: { ...rejectedRequest, rejectRecoveryConsumed: true } }),
    );
    const result = await runToolRequestResolve({
      request: manualDone,
      context: context({ tasks }),
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('precondition-failed');
    expect(result.summary).toMatch(/already resolved/);
    expect(tasks.transitions).toHaveLength(0);
  });

  test('a stale rejected request cannot requeue a task parked in another phase', async () => {
    const tasks = taskStore(task({ toolRequest: rejectedRequest, phase: 'review' }));
    const result = await runToolRequestResolve({
      request: manualDone,
      context: context({ tasks }),
    });
    expect(result.status).toBe('rejected');
    expect(result.summary).toMatch(/already resolved/);
    expect(tasks.transitions).toHaveLength(0);
  });
});

describe('tool-request.resolve core — definite refusals (nothing was written)', () => {
  const refusalCases = [
    {
      name: 'no task',
      build: () => ({ ctx: context({ tasks: taskStore(undefined) }), request: manualDone }),
      reason: 'precondition-failed',
      match: /Task not found/,
    },
    {
      name: 'no Tool Request on the task',
      build: () => ({ ctx: context({ tasks: taskStore(task({ context: {} })) }), request: manualDone }),
      reason: 'precondition-failed',
      match: /has no Tool Request to resolve/,
    },
    {
      name: 'a replayed decision against an already-resolved request',
      build: () => ({
        ctx: context({
          tasks: taskStore(
            task({
              toolRequest: toolRequest({
                resolved: true,
                resolution: { action: 'manual-done', resolvedAt: '2026-01-02T00:00:00.000Z' },
              }),
            }),
          ),
        }),
        request: manualDone,
      }),
      reason: 'precondition-failed',
      match: /is already resolved/,
    },
    {
      name: 'an active task',
      build: () => ({
        ctx: context({ tasks: taskStore(task({ status: 'running', ownerRunId: 'run-9' })) }),
        request: manualDone,
      }),
      reason: 'conflict',
      match: /Refusing to resolve an active task/,
    },
    {
      name: 'a dirty checkout under manual-done',
      build: () => ({
        ctx: context({
          exec: execPort({ probeOverrides: { 'status --porcelain': { ok: true, output: ' M package.json' } } }),
        }),
        request: manualDone,
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
        request: manualDone,
      }),
      reason: 'precondition-failed',
      match: /ahead of origin\/main/,
    },
    {
      name: 'an unpushed local issue branch',
      build: () => ({
        ctx: context({
          exec: execPort({
            probeOverrides: { [`rev-list --count FETCH_HEAD..${BRANCH}`]: { ok: true, output: '3' } },
          }),
        }),
        request: manualDone,
      }),
      reason: 'precondition-failed',
      match: /not yet pushed/,
    },
    {
      name: 'an origin lookup that could not answer',
      build: () => ({
        ctx: context({ exec: execPort({ remote: 'unknown' }) }),
        request: manualDone,
      }),
      reason: 'precondition-failed',
      match: /could not .*determine whether origin has the issue branch/s,
    },
    {
      name: 'no usable continuation point',
      build: () => ({
        ctx: context({
          exec: execPort({
            remote: 'no',
            probeOverrides: {
              [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: { ok: false, output: '' },
            },
          }),
        }),
        request: manualDone,
      }),
      reason: 'precondition-failed',
      match: /left no usable continuation point/,
    },
    {
      name: 'a misconfigured worktree root',
      build: () => ({
        ctx: context({
          worktree: { resolveDirtyCheckCwd: () => ({ ok: false, error: 'root is relative' }) },
        }),
        request: manualDone,
      }),
      reason: 'precondition-failed',
      match: /worktree root is misconfigured/,
    },
    {
      name: 'an unknown action',
      build: () => ({ ctx: context(), request: { action: 'delete-everything' } }),
      reason: 'invalid-request',
      match: /--action must be one of: manual-done, reject/,
    },
    {
      name: 'a reject with no operator message',
      build: () => ({ ctx: context(), request: { action: 'reject' } }),
      reason: 'invalid-request',
      match: /--message is required when --action reject is used/,
    },
    {
      name: 'a reject whose message is only whitespace',
      build: () => ({ ctx: context(), request: { action: 'reject', message: '   ' } }),
      reason: 'invalid-request',
      match: /--message is required/,
    },
    {
      name: 'a session-scoped invocation',
      build: () => ({
        ctx: context({ invocation: { issueNumber: null } }),
        request: manualDone,
      }),
      reason: 'invalid-context',
      match: /requires a work item in context/,
    },
  ];

  for (const testCase of refusalCases) {
    test(`${testCase.name} → ${testCase.reason}, effect none`, async () => {
      const { ctx, request } = testCase.build();
      const result = await runToolRequestResolve({ request, context: ctx });
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe(testCase.reason);
      expect(result.effect).toBe('none');
      expect(result.summary).toMatch(testCase.match);
      expect(ctx.tasks.transitions).toHaveLength(0);
      expect(ctx.outbox.entries).toHaveLength(0);
    });
  }

  test('a failed transition is a definite, retry-safe conflict', async () => {
    const tasks = taskStore(task(), {
      transitionResult: { ok: false, code: 'expectation_failed', current: { status: 'queued' } },
    });
    const outbox = outboxStore();

    const result = await runToolRequestResolve({
      request: manualDone,
      context: context({ tasks, outbox }),
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('conflict');
    expect(result.effect).toBe('none');
    expect(result.summary).toMatch(/Failed to resolve Tool Request: expectation_failed \(current status: queued\)/);
    // Nothing is published for a resolution that never committed.
    expect(outbox.entries).toHaveLength(0);
    expect(tasks.events).toHaveLength(0);
  });
});

describe('tool-request.resolve core — a blocked requeue still records the rejection', () => {
  test('reject downgrades to a human handoff and publishes the blocking reason', async () => {
    const tasks = taskStore(task());
    const outbox = outboxStore();
    const exec = execPort({
      probeOverrides: { 'status --porcelain': { ok: true, output: ' M package.json' } },
    });

    const result = await runToolRequestResolve({
      request: reject,
      context: context({ tasks, outbox, exec }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.requeued).toBe(false);
    expect(result.data.outcome).toBe('rejected');
    expect(result.data.requeueBlockedReason).toMatch(/is dirty/);
    // The task keeps its human-handoff status and phase…
    const transition = tasks.transitions.at(-1);
    expect(transition.patch.status).toBe('ready_for_human');
    expect(transition.patch.phase).toBe('implementation');
    expect(transition.patch.context.toolRequest.resolved).toBe(true);
    // …and its ready-for-human labelling is left untouched.
    expect(outbox.entries.map((e) => e.topic)).toEqual(['gh:comment']);
    const comment = outbox.entries[0];
    expect(comment.payload.body).toContain('remains parked for human review');
    expect(comment.payload.body).toContain('Blocking reason');
  });

  test('a blocked fetch keeps raw git stderr out of the public comment', async () => {
    const tasks = taskStore(task());
    const outbox = outboxStore();
    const exec = execPort({
      probeOverrides: {
        [`fetch origin ${BRANCH}`]: { ok: false, output: 'https://user:hunter2@example.invalid rejected' },
      },
    });

    const result = await runToolRequestResolve({
      request: reject,
      context: context({ tasks, outbox, exec }),
    });

    expect(result.status).toBe('executed');
    expect(result.data.requeued).toBe(false);
    // The audit surface keeps the diagnostic…
    expect(result.data.requeueBlockedReason).toContain('hunter2');
    // …the public comment never does.
    const comment = outbox.entries.find((e) => e.topic === 'gh:comment');
    expect(comment.payload.body).not.toContain('hunter2');
    expect(comment.payload.body).toContain('could not fetch');
  });
});

describe('tool-request.resolve core — publication failures are indeterminate', () => {
  test('a failed label enqueue reports failed/unknown after a durable resolution', async () => {
    const tasks = taskStore(task());
    const outbox = outboxStore({ throwsOn: 'gh:label:remove' });

    const result = await runToolRequestResolve({
      request: manualDone,
      context: context({ tasks, outbox }),
    });

    expect(result.status).toBe('failed');
    // The decision is already persisted, so a retry is NOT safe: it would be
    // refused as already-resolved while the publication stays half-applied.
    expect(result.effect).toBe('unknown');
    expect(result.reason).toBe('internal');
    expect(result.summary).toMatch(/publishing the outcome failed/);
    expect(tasks.transitions).toHaveLength(1);
    expect(tasks.transitions[0].patch.context.toolRequest.resolved).toBe(true);
  });

  test('a failed audit event is reported the same way', async () => {
    const tasks = taskStore(task(), { appendEventThrows: true });
    const result = await runToolRequestResolve({
      request: manualDone,
      context: context({ tasks }),
    });
    expect(result.status).toBe('failed');
    expect(result.effect).toBe('unknown');
    expect(result.summary).toMatch(/event store is down/);
  });

  test('a replay after a publication failure is refused, not re-applied', async () => {
    // The state the failed run left behind: the request is resolved.
    const resolvedTask = task({
      toolRequest: toolRequest({
        resolved: true,
        resolution: { action: 'manual-done', resolvedAt: '2026-02-02T00:00:00.000Z' },
      }),
      status: 'queued',
      phase: 'implementation',
    });
    const tasks = taskStore(resolvedTask);
    const outbox = outboxStore();

    const result = await runToolRequestResolve({
      request: manualDone,
      context: context({ tasks, outbox }),
    });

    expect(result.status).toBe('rejected');
    expect(result.summary).toMatch(/is already resolved/);
    expect(tasks.transitions).toHaveLength(0);
    expect(outbox.entries).toHaveLength(0);
  });
});

describe('tool-request.resolve — the port binding', () => {
  function registry(ctx) {
    return createOperationRegistry([createToolRequestResolveDescriptor(() => ctx)]);
  }

  function invocationContext(overrides = {}) {
    return {
      surface: 'chatops',
      actor: { kind: 'human', id: 'operator' },
      sessionId: SESSION_ID,
      issueNumber: ISSUE,
      requestId: 'gh:acme/widgets#7#c1#1',
      confirmed: true,
      deadlineMs: null,
      ...overrides,
    };
  }

  test('the descriptor matches what the ChatOps mapping already declares', () => {
    const descriptor = createToolRequestResolveDescriptor(() => context());
    const mapping = CHATOPS_OPERATION_MAPPINGS.find((m) => m.verb === 'resolve');
    // The mapping declared this row before any core existed
    // (docs/chatops-operation-mapping-contract.md §12 leaves the reconciliation
    // to whichever issue registers it); a drift here would surface as a
    // contradiction at registration time instead of now.
    expect(descriptor.id).toBe(mapping.operationId);
    expect(descriptor.scope).toBe(mapping.scope);
    expect(descriptor.mutating).toBe(mapping.mutating);
    expect(descriptor.summary).toBe(mapping.summary);
    expect(descriptor.params.map((p) => [p.name, p.type, p.required === true])).toEqual([
      ['action', 'string', true],
      ['message', 'string', false],
    ]);
    // Registration itself is still the final integration issue's (§11.3).
    expect(createOperationRegistry([descriptor]).get(TOOL_REQUEST_RESOLVE_OPERATION_ID)).toBeDefined();
  });

  test('a confirmed invocation reaches the core and reports applied effects', async () => {
    const tasks = taskStore(task());
    const ctx = context({ tasks });

    const result = await invokeOperation(
      registry(ctx),
      { operationId: TOOL_REQUEST_RESOLVE_OPERATION_ID, params: { action: 'manual-done' } },
      invocationContext(),
    );

    expect(result.status).toBe('executed');
    expect(result.effect).toBe('applied');
    expect(tasks.transitions).toHaveLength(1);
  });

  test('the port refuses a missing required action before any handler runs', async () => {
    const tasks = taskStore(task());
    const result = await invokeOperation(
      registry(context({ tasks })),
      { operationId: TOOL_REQUEST_RESOLVE_OPERATION_ID, params: {} },
      invocationContext(),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('invalid-request');
    expect(result.summary).toMatch(/missing required parameter "action"/);
    expect(tasks.transitions).toHaveLength(0);
  });

  test('the port refuses an unknown parameter', async () => {
    const result = await invokeOperation(
      registry(context()),
      {
        operationId: TOOL_REQUEST_RESOLVE_OPERATION_ID,
        params: { action: 'manual-done', 'session-id': 'other' },
      },
      invocationContext(),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('invalid-request');
    expect(result.summary).toMatch(/reserved for trusted context/);
  });

  test('the operation is issue-scoped', async () => {
    const result = await invokeOperation(
      registry(context()),
      { operationId: TOOL_REQUEST_RESOLVE_OPERATION_ID, params: { action: 'manual-done' } },
      invocationContext({ issueNumber: null }),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('invalid-context');
    expect(result.summary).toMatch(/issue-scoped/);
  });

  test('an unconfirmed port invocation previews without applying', async () => {
    const tasks = taskStore(task());
    const result = await invokeOperation(
      registry(context({ tasks, confirmed: false })),
      { operationId: TOOL_REQUEST_RESOLVE_OPERATION_ID, params: { action: 'manual-done' } },
      invocationContext({ confirmed: false }),
    );
    expect(result.status).toBe('executed');
    expect(result.effect).toBe('none');
    expect(tasks.transitions).toHaveLength(0);
  });

  test('parameter parsing rejects the operation vocabulary, not just the port types', () => {
    expect(parseToolRequestResolveParams({ action: 'nope' })).toEqual({
      error: '--action must be one of: manual-done, reject, got: nope',
    });
    expect(parseToolRequestResolveParams({ action: 'reject' })).toEqual({
      error: '--message is required when --action reject is used',
    });
    expect(parseToolRequestResolveParams({ action: 'manual-done' })).toEqual({
      request: { action: 'manual-done' },
    });
    expect(parseToolRequestResolveParams({ action: 'reject', message: 'no' })).toEqual({
      request: { action: 'reject', message: 'no' },
    });
  });
});
