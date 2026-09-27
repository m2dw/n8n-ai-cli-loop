/**
 * The registered Tool Request operations, driven through the real ChatOps pass
 * (issue #1031).
 *
 * `test/chatops-runtime.test.js` proves the transport with a stand-in operation;
 * `test/tool-request-run-operation.test.js` and
 * `test/tool-request-resolve-operation.test.js` prove each core in isolation.
 * What neither covers — and what this issue is — is the join: that
 * `CHATOPS_OPERATION_DESCRIPTORS` actually admits the two ids the §7 mapping
 * table names, that a `/grant` or `/resolve` comment reaches those cores through
 * `invokeOperation` with the trusted context the dispatcher built, and that the
 * at-most-once machinery still holds when the operation on the other side is the
 * real one rather than a one-line fake.
 *
 * Everything under the cores is injected — hand-written stores, a scripted git,
 * an in-memory artifact sink — so "the command ran" is observable as exactly one
 * `/bin/sh -c` call, which is the property every replay and crash case here is
 * about.
 */
import { runChatOpsPass } from '../dist/handlers/chatops-pass.js';
import { extractIssueVerificationCommands } from '../dist/handlers/issue-verification-extractor.js';
import { chatOpsIdentityKey } from '../dist/core/chatops-identity.js';
import {
  CHATOPS_OPERATION_DESCRIPTORS,
  createChatOpsOperationRegistry,
} from '../dist/core/chatops-operations.js';
import { CHATOPS_OPERATION_MAPPINGS } from '../dist/core/chatops-operation-mapping.js';
import {
  TOOL_REQUEST_RUN_LOCK_CONTEXT_ID,
  TOOL_REQUEST_RUN_OPERATION_ID,
} from '../dist/core/tool-request-run.js';
import { TOOL_REQUEST_RESOLVE_OPERATION_ID } from '../dist/core/tool-request-resolve.js';
import { invokeOperation } from '../dist/core/operation-port.js';
import { CHATOPS_SUMMARY_HEADER } from '../dist/core/chatops-result.js';
import {
  resolveIssueRunCwd,
  toolRequestRepoLockPort,
  toolRequestResolveOperationContext,
  toolRequestRunOperationContext,
} from '../dist/handlers/tool-request-operation-context.js';
import { RepoLockStore } from '../dist/stores/repo-lock-store.js';
import { createChatOpsHarness } from './helpers/chatops-harness.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const IDENTITY = {
  sessionId: 'chatops-test',
  provider: 'github-issues',
  providerEndpoint: 'github.com',
  providerOwner: 'm2dw',
  providerRepo: 'demo',
};
const IDENTITY_KEY = chatOpsIdentityKey(IDENTITY);
const ISSUE = 42;
const BRANCH = `ai/issue-${ISSUE}`;
const BASE_MS = Date.parse('2026-03-01T00:00:00Z');

// The exact command is what actually runs; the display form is the redacted one
// recorded beside it. They differ so an assertion can tell which of the two
// reaches a public comment.
const COMMAND = 'npm install left-pad@^1.3.0 --registry-token=hunter2';
const DISPLAY_COMMAND = 'npm install left-pad@^1.3.0 --registry-token=***';

const { createMemoryStore, comment, createFakePort } = createChatOpsHarness({
  identityKey: IDENTITY_KEY,
  issue: ISSUE,
  baseMs: BASE_MS,
});

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'chatops-tool-request-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function witnessPath() {
  return join(workspace, 'witness', 'epoch-witness.json');
}

// ---------------------------------------------------------------------------
// Session, task, and the injected runtime halves
// ---------------------------------------------------------------------------

function session(overrides = {}) {
  return {
    sessionId: IDENTITY.sessionId,
    id: IDENTITY.sessionId,
    repoKey: 'demo',
    repoRoot: '/repo',
    githubRepo: 'm2dw/demo',
    artifactDir: '.n8n-artifacts',
    artifactRoot: '/artifacts',
    baseBranch: 'main',
    githubOwner: 'm2dw',
    githubName: 'demo',
    labels: {
      readyForHuman: 'status:ready-for-human',
      needsImplementation: 'status:needs-implementation',
      needsFix: 'status:needs-fix',
      agentImplementation: 'agent:claude',
    },
    verification: {},
    defaults: { implementationAgent: 'claude' },
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    repoHostProviderConfigured: false,
    chatOps: { enabled: true, authorAllowlist: ['alice'], automationLogins: ['loop-bot'] },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    sessionId: IDENTITY.sessionId,
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
        resolved: false,
      },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    ...overrides,
  };
}

/** A task store that records what the core asked it to persist, and how often. */
function taskStore(stored) {
  const transitions = [];
  const events = [];
  const reads = [];
  const apply = (patch) => ({
    ...stored,
    status: patch.status ?? stored.status,
    phase: patch.phase ?? stored.phase,
    context: { ...stored.context, ...(patch.context ?? {}) },
  });
  return {
    transitions,
    events,
    reads,
    getTask: async (key) => {
      reads.push(key);
      return stored;
    },
    transitionTask: async (key, expected, patch) => {
      transitions.push({ key, expected, patch });
      return { ok: true, value: apply(patch) };
    },
    transitionTaskWithEffects: async (key, expected, patch, effects) => {
      transitions.push({ key, expected, patch, effects });
      return { ok: true, value: apply(patch) };
    },
    appendEvent: async (event) => void events.push(event),
  };
}

function outboxStore() {
  const entries = [];
  return { entries, enqueue: async (input) => void entries.push(input) };
}

/**
 * A scripted git plus the approved command itself.
 *
 * Answers the way a healthy checkout already on the issue branch, with the
 * branch pushed and the base in sync, would — the shape in which a guided run
 * takes its documented true-no-op path.
 */
function execPort() {
  const state = { porcelain: '', head: 'HEAD0', branch: BRANCH };
  const shellRuns = [];
  const answer = (args) => {
    const key = args.join(' ');
    if (args[0] === 'status') {
      const scoped = args.includes('--') && args[args.length - 1].startsWith('/artifacts');
      return { ok: true, output: scoped ? '' : state.porcelain.trim() };
    }
    if (key === 'rev-parse --abbrev-ref HEAD') return { ok: true, output: state.branch };
    if (key === 'rev-parse HEAD') return { ok: true, output: state.head };
    if (key === 'rev-parse main') return { ok: true, output: 'BASE0' };
    if (key === 'rev-parse origin/main') return { ok: true, output: 'ORIGINBASE0' };
    if (args[0] === 'rev-list') return { ok: true, output: '0' };
    return { ok: true, output: '' };
  };
  return {
    shellRuns,
    state,
    probe: (cmd, args) => answer(args),
    remoteHasBranch: () => 'yes',
    run(file, args) {
      if (file === '/bin/sh') {
        shellRuns.push(args[1]);
        return { exitCode: 0, stdout: 'ran\n', stderr: '' };
      }
      const probed = answer(args);
      return { exitCode: probed.ok ? 0 : 1, stdout: probed.output, stderr: '' };
    },
    rawPorcelainStatus: () => state.porcelain,
  };
}

function artifactPort() {
  const written = new Map();
  return {
    written,
    dirFor: (runId) => `/artifacts/runs/${runId}`,
    fileExists: (path) => written.has(path),
    writeFile: (path, contents) => void written.set(path, contents),
    removeDir: () => {},
  };
}

function lockPort() {
  const acquired = [];
  const released = [];
  return {
    acquired,
    released,
    acquire: (contextId) => {
      acquired.push(contextId);
      return { ok: true, locked: true };
    },
    release: (contextId) => void released.push(contextId),
  };
}

/**
 * The composition root's dependency bundle, exactly as `chatops-scan` builds it
 * — one resolver per registered operation, each handed the trusted context the
 * dispatcher derived from ledger-scope facts.
 */
function operationDeps(parts = {}) {
  const sess = parts.session ?? session();
  const tasks = parts.tasks ?? taskStore(task());
  const outbox = parts.outbox ?? outboxStore();
  const exec = parts.exec ?? execPort();
  const artifacts = parts.artifacts ?? artifactPort();
  const repoLock = parts.repoLock ?? lockPort();
  const invocations = [];
  return {
    tasks,
    outbox,
    exec,
    artifacts,
    repoLock,
    invocations,
    deps: {
      toolRequestRun: (invocation) => {
        invocations.push(invocation);
        return {
          invocation,
          session: sess,
          tasks,
          outbox,
          repoLock,
          exec,
          worktree: { resolveRunCwd: () => ({ ok: true, cwd: '/repo' }) },
          artifacts,
          now: () => '2026-03-01T00:00:10.000Z',
          runIdFor: (now) => `chatops-tool-request-run-${now}`,
          responseAction: 'guided-run',
          extractIssueVerificationCommands,
        };
      },
      toolRequestResolve: (invocation) => {
        invocations.push(invocation);
        return {
          invocation,
          session: sess,
          tasks,
          outbox,
          exec,
          worktree: { resolveDirtyCheckCwd: () => ({ ok: true, cwd: '/repo' }) },
          now: () => '2026-03-01T00:00:10.000Z',
          runIdFor: (now) => `chatops-tool-request-resolve-${now}`,
        };
      },
    },
  };
}

async function pass(store, port, extra = {}) {
  return runChatOpsPass({
    session: extra.session ?? session(),
    identity: IDENTITY,
    store,
    port,
    registry: extra.registry,
    issueNumbers: [ISSUE],
    witnessPath: witnessPath(),
    now: () => BASE_MS + (extra.nowOffsetMs ?? 0),
  });
}

/** The scope's first pass records pre-existing comments without running them. */
async function bootstrap(store, port, registry) {
  return pass(store, port, { registry });
}

const seed = () => [comment(1, 'alice', 'ordinary discussion, not a command', 1)];

function markerBodies(port) {
  return port.posted.map((entry) => entry.body);
}

function summaryEffects(store) {
  return store.effects().filter((effect) => effect.idempotencyKey.includes('chatops-summary'));
}

// ---------------------------------------------------------------------------
// The catalog itself
// ---------------------------------------------------------------------------

describe('chatops operation catalog', () => {
  test('registers exactly the two admitted Tool Request operations', () => {
    expect(CHATOPS_OPERATION_DESCRIPTORS.map((entry) => entry.id)).toEqual([
      TOOL_REQUEST_RUN_OPERATION_ID,
      TOOL_REQUEST_RESOLVE_OPERATION_ID,
    ]);
  });

  test('every mapped verb resolves to a registered descriptor that matches its declaration', () => {
    const { deps } = operationDeps();
    const registry = createChatOpsOperationRegistry(deps);
    // `docs/chatops-operation-mapping-contract.md` §12 leaves reconciling each
    // mapping's declared metadata against a real descriptor to whichever issue
    // registers it. This is that reconciliation.
    for (const mapping of CHATOPS_OPERATION_MAPPINGS) {
      const descriptor = registry.get(mapping.operationId);
      expect(descriptor).toBeDefined();
      expect(descriptor.scope).toBe(mapping.scope);
      expect(descriptor.mutating).toBe(mapping.mutating);
      expect(descriptor.summary).toBe(mapping.summary);
      // The verb's allowlist is a subset of what the operation declares: a
      // ChatOps-settable parameter the operation does not know would be refused
      // by the port as unknown, after the comment had already been claimed.
      const declared = new Map(descriptor.params.map((spec) => [spec.name, spec]));
      for (const spec of mapping.params) {
        expect(declared.get(spec.name)).toMatchObject({ name: spec.name, type: spec.type });
      }
    }
  });

  test('an operation with no injected runtime half stays unregistered and definite', async () => {
    // Not a degraded mode: the port answers `rejected`/`unknown-operation`,
    // which is effect-free, so a build (or a caller) without the stores behaves
    // exactly as it did before either core existed.
    const registry = createChatOpsOperationRegistry();
    expect(registry.list()).toHaveLength(0);
    const result = await invokeOperation(
      registry,
      { operationId: TOOL_REQUEST_RUN_OPERATION_ID, params: {} },
      {
        surface: 'chatops',
        actor: { kind: 'human', id: 'alice' },
        sessionId: IDENTITY.sessionId,
        issueNumber: ISSUE,
        requestId: 'req-1',
        confirmed: true,
        deadlineMs: null,
      },
    );
    expect(result).toMatchObject({ status: 'rejected', reason: 'unknown-operation', effect: 'none' });
  });

  test('only one of the two runtime halves may be supplied', () => {
    const { deps } = operationDeps();
    const registry = createChatOpsOperationRegistry({ toolRequestResolve: deps.toolRequestResolve });
    expect(registry.list().map((d) => d.id)).toEqual([TOOL_REQUEST_RESOLVE_OPERATION_ID]);
  });
});

// ---------------------------------------------------------------------------
// /grant → tool-request.run
// ---------------------------------------------------------------------------

describe('chatops /grant executes the guided run exactly once', () => {
  test('an authorized comment runs the approved command and publishes the outcome', async () => {
    const store = createMemoryStore();
    const port = createFakePort(seed());
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    await bootstrap(store, port, registry);
    port.comments.push(comment(2, 'alice', '/grant --disposition keep', 10));
    const result = await pass(store, port, { registry });

    expect(result.outcome).toBe('processed');
    // The one observable that matters: the approved command ran, once, verbatim.
    expect(wiring.exec.shellRuns).toEqual([COMMAND]);
    expect(wiring.repoLock.acquired).toHaveLength(1);
    expect(wiring.repoLock.released).toHaveLength(1);

    // The trusted half came from the ledger scope, never from the comment body.
    expect(wiring.invocations).toHaveLength(1);
    expect(wiring.invocations[0]).toMatchObject({
      surface: 'chatops',
      actor: { kind: 'human', id: 'alice' },
      sessionId: IDENTITY.sessionId,
      issueNumber: ISSUE,
      confirmed: true,
    });

    // The Tool Request itself was resolved and the task handed back to the
    // implementation lane — the existing continuation semantics, unchanged.
    const requeue = wiring.tasks.transitions.at(-1);
    expect(requeue.patch.status).toBe('queued');
    expect(requeue.patch.phase).toBe('implementation');
    expect(requeue.patch.context.toolRequest.resolved).toBe(true);
    expect(requeue.patch.context.toolRequest.resolution.disposition).toBe('no-op');
    expect(requeue.patch.context.toolRequest.resolution.action).toBe('guided-run');

    // Claim marker, then the acknowledgement marker carrying the outcome.
    expect(markerBodies(port)).toEqual([
      '<!-- chatops-claimed:2 -->',
      '<!-- chatops-ack:2:executed -->',
    ]);
    expect(store.row('2')).toMatchObject({ state: 'acknowledged', outcome: 'executed' });

    const summaries = summaryEffects(store);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload.body).toContain(CHATOPS_SUMMARY_HEADER);
    // The exact command never reaches a public comment; the redacted form may.
    expect(summaries[0].payload.body).not.toContain('hunter2');
  });

  test('replaying the same comment neither re-runs the command nor re-publishes', async () => {
    const store = createMemoryStore();
    const port = createFakePort(seed());
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    await bootstrap(store, port, registry);
    port.comments.push(comment(2, 'alice', '/grant --disposition keep', 10));
    await pass(store, port, { registry });
    const postsAfterFirst = port.posted.length;

    await pass(store, port, { registry, nowOffsetMs: 60_000 });
    await pass(store, port, { registry, nowOffsetMs: 120_000 });

    expect(wiring.exec.shellRuns).toEqual([COMMAND]);
    expect(port.posted).toHaveLength(postsAfterFirst);
    expect(summaryEffects(store)).toHaveLength(1);
  });

  test('a crash between dispatch and publication republishes without re-running', async () => {
    const store = createMemoryStore();
    // The acknowledgement post fails; the claim marker and the operation both
    // already happened. This is the crash-after-dispatch shape: the outcome is
    // committed, the marker is not.
    const port = createFakePort(seed(), {
      postFailure: (body) => (body.includes('chatops-ack:') ? 'network reset' : null),
    });
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    await bootstrap(store, port, registry);
    port.comments.push(comment(2, 'alice', '/grant --disposition keep', 10));
    await pass(store, port, { registry });
    expect(store.row('2')).toMatchObject({ state: 'awaiting_ack', ackPublication: 'pending' });

    port.postFailure = null;
    await pass(store, port, { registry, nowOffsetMs: 60_000 });

    // Republished from the row's own persisted outcome, and the operation was
    // never asked a second time.
    expect(wiring.exec.shellRuns).toEqual([COMMAND]);
    expect(markerBodies(port)).toContain('<!-- chatops-ack:2:executed -->');
    expect(store.row('2')).toMatchObject({ state: 'acknowledged', outcome: 'executed' });
  });

  test('a parameter outside the verb allowlist is refused before anything is dispatched', async () => {
    const store = createMemoryStore();
    const port = createFakePort(seed());
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    await bootstrap(store, port, registry);
    // `--command` is the free-form shell parameter the mapping contract withholds
    // unconditionally. It never becomes a request, so the core is never reached.
    port.comments.push(comment(2, 'alice', '/grant --command "rm -rf /"', 10));
    const result = await pass(store, port, { registry });

    expect(result.outcome).toBe('refused');
    expect(wiring.exec.shellRuns).toEqual([]);
    expect(wiring.tasks.reads).toEqual([]);
    expect(store.row('2')).toMatchObject({ state: 'rejected' });
    expect(port.posted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// /resolve → tool-request.resolve
// ---------------------------------------------------------------------------

describe('chatops /resolve records the operator decision', () => {
  test('manual-done resolves the request and resumes the existing continuation', async () => {
    const store = createMemoryStore();
    const port = createFakePort(seed());
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    await bootstrap(store, port, registry);
    port.comments.push(comment(2, 'alice', '/resolve --action manual-done', 10));
    const result = await pass(store, port, { registry });

    expect(result.outcome).toBe('processed');
    // No command is ever run by a resolution.
    expect(wiring.exec.shellRuns).toEqual([]);
    const patch = wiring.tasks.transitions.at(-1).patch;
    expect(patch.status).toBe('queued');
    expect(patch.phase).toBe('implementation');
    expect(patch.context.toolRequest.resolved).toBe(true);
    expect(patch.context.toolRequest.resolution.action).toBe('manual-done');
    // The pushed issue branch is the continuation point the requeued run
    // resumes from — the existing semantics, reached from a comment.
    expect(patch.context.toolRequestResumeBranch).toBe(BRANCH);
    expect(store.row('2')).toMatchObject({ state: 'acknowledged', outcome: 'executed' });
  });

  test('reject persists the bounded operator message and follows the rejection path', async () => {
    const store = createMemoryStore();
    const port = createFakePort(seed());
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    await bootstrap(store, port, registry);
    port.comments.push(
      comment(2, 'alice', '/resolve --action reject --message "use the bundled parser"', 10),
    );
    const result = await pass(store, port, { registry });

    expect(result.outcome).toBe('processed');
    const stored = wiring.tasks.transitions.at(-1).patch.context.toolRequest;
    expect(stored.resolved).toBe(true);
    expect(stored.resolution.action).toBe('reject');
    expect(stored.resolution.message).toBe('use the bundled parser');
    // The operator's answer is published as well as stored: it is the
    // continuation context the next implementation prompt reads.
    const published = wiring.outbox.entries.find((entry) => entry.topic === 'gh:comment');
    expect(published.payload.body).toContain('use the bundled parser');
    expect(store.row('2')).toMatchObject({ state: 'acknowledged', outcome: 'executed' });
  });

  test('a missing required parameter never reaches the core', async () => {
    const store = createMemoryStore();
    const port = createFakePort(seed());
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    await bootstrap(store, port, registry);
    port.comments.push(comment(2, 'alice', '/resolve', 10));
    const result = await pass(store, port, { registry });

    expect(result.outcome).toBe('refused');
    expect(wiring.tasks.reads).toEqual([]);
    expect(store.row('2')).toMatchObject({ state: 'rejected' });
    expect(port.posted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Everything that must stay effect-free now that the operations are real
// ---------------------------------------------------------------------------

describe('chatops refusals never reach a registered operation', () => {
  const cases = [
    ['an unallowlisted author', () => comment(2, 'mallory', '/grant --disposition keep', 10)],
    ['an edited comment', () => comment(2, 'alice', '/grant --disposition keep', 10, 20)],
    ['a flag with no value', () => comment(2, 'alice', '/grant --disposition', 10)],
    ['an unsupported verb', () => comment(2, 'alice', '/deploy --env prod', 10)],
    ['an automation marker', () => comment(2, 'loop-bot', '<!-- chatops-claimed:99 -->', 10)],
  ];

  test.each(cases)('%s is refused with no operation invoked', async (_label, build) => {
    const store = createMemoryStore();
    const port = createFakePort(seed());
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    await bootstrap(store, port, registry);
    port.comments.push(build());
    const result = await pass(store, port, { registry });

    expect(result.outcome).toBe('refused');
    expect(wiring.invocations).toEqual([]);
    expect(wiring.exec.shellRuns).toEqual([]);
    expect(wiring.tasks.transitions).toEqual([]);
    expect(port.posted).toHaveLength(0);
  });

  test('a pre-existing command in the bootstrap backlog is recorded, never run', async () => {
    const store = createMemoryStore();
    const port = createFakePort([...seed(), comment(2, 'alice', '/grant --disposition keep', 5)]);
    const wiring = operationDeps();
    const registry = createChatOpsOperationRegistry(wiring.deps);

    const result = await bootstrap(store, port, registry);

    expect(result.issues[0].bootstrapped).toBe(true);
    expect(result.issues[0].bootstrapSkipped).toBe(1);
    expect(wiring.exec.shellRuns).toEqual([]);
    expect(port.posted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The shared runtime builder both surfaces compose through
// ---------------------------------------------------------------------------

/** The repo-lock holder the generated parent workflow creates for one execution. */
const PARENT_CONTEXT = 'ctx-parent-42';

describe('tool-request operation runtime builder', () => {
  const invocation = {
    surface: 'chatops',
    actor: { kind: 'human', id: 'alice' },
    sessionId: IDENTITY.sessionId,
    issueNumber: ISSUE,
    requestId: 'req-1',
    confirmed: true,
    deadlineMs: null,
  };

  test('passes the trusted half through untouched and tags the surface run id', () => {
    const ctx = toolRequestRunOperationContext(invocation, {
      session: session(),
      tasks: taskStore(task()),
      outbox: outboxStore(),
      repoLock: { acquire: () => ({ locked: true }), release: () => {} },
      responseAction: 'guided-run',
      runIdPrefix: 'chatops-tool-request-run',
    });
    expect(ctx.invocation).toBe(invocation);
    expect(ctx.responseAction).toBe('guided-run');
    expect(ctx.runIdFor('2026-03-01T00:00:00.000Z')).toBe(
      'chatops-tool-request-run-2026-03-01T00:00:00.000Z',
    );
    // The seams the core takes by injection are real functions, not stubs the
    // builder forgot to fill in.
    for (const seam of ['probe', 'remoteHasBranch', 'run', 'rawPorcelainStatus']) {
      expect(typeof ctx.exec[seam]).toBe('function');
    }
  });

  test('the guided-run context takes the lock through the ambient holder the surface named', () => {
    const store = new RepoLockStore(join(workspace, 'locks'));
    // The holder the generated parent workflow creates before it calls the child.
    store.acquire(PARENT_CONTEXT, IDENTITY.sessionId);
    const build = (ambientLockContextId) =>
      toolRequestRunOperationContext(invocation, {
        session: session(),
        tasks: taskStore(task()),
        outbox: outboxStore(),
        repoLock: store,
        ambientLockContextId,
        responseAction: 'guided-run',
        runIdPrefix: 'chatops-tool-request-run',
      });

    // Named: the parent's lock is this pass's own critical section.
    expect(
      build(PARENT_CONTEXT).repoLock.acquire(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, IDENTITY.sessionId),
    ).toMatchObject({ locked: true });
    // Unnamed — the admin CLI's shape — is unchanged: a held lock is contention.
    expect(
      build(undefined).repoLock.acquire(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, IDENTITY.sessionId),
    ).toMatchObject({ locked: false, reason: 'lock_held', ownerContextId: PARENT_CONTEXT });
  });

  test('the resolution context resolves the same checkout the guided run uses', () => {
    const sess = session();
    const ctx = toolRequestResolveOperationContext(invocation, {
      session: sess,
      tasks: taskStore(task()),
      outbox: outboxStore(),
      runIdPrefix: 'chatops-tool-request-resolve',
    });
    // No per-issue worktree is registered for `/repo`, so both surfaces fall
    // back to the canonical checkout — the same answer, from the same function.
    expect(ctx.worktree.resolveDirtyCheckCwd()).toEqual(
      resolveIssueRunCwd(sess, IDENTITY.sessionId, ISSUE),
    );
  });
});

// ---------------------------------------------------------------------------
// The single-worker repo lock, seen from inside the execution that already holds
// it (P1 review follow-up)
//
// The generated n8n parent runs `admin repo-lock acquire --context-id <ctx>`
// before it calls the child and releases only after the child returns, and the
// ChatOps Scan node is a node *of that child*. Without the ambient-holder rule
// below, every `/grant` in the normal scheduled workflow answered `conflict`:
// the pass asked for the lock its own parent was holding for it.
// ---------------------------------------------------------------------------

describe('repo-lock port — an ambient holder is not contention', () => {
  const SESSION = IDENTITY.sessionId;
  const lockStore = () => new RepoLockStore(join(workspace, 'locks'));

  test('an unheld lock is taken and released for real', () => {
    const store = lockStore();
    const port = toolRequestRepoLockPort(store, { ambientContextId: PARENT_CONTEXT });

    expect(port.acquire(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, SESSION)).toMatchObject({ locked: true });
    expect(store.peek(SESSION)).toMatchObject({
      held: true,
      contextId: TOOL_REQUEST_RUN_LOCK_CONTEXT_ID,
    });

    port.release(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, SESSION);
    expect(store.peek(SESSION).held).toBe(false);
  });

  test("the caller's own lock counts as acquired and is left for the caller to release", () => {
    const store = lockStore();
    store.acquire(PARENT_CONTEXT, SESSION);
    const port = toolRequestRepoLockPort(store, { ambientContextId: PARENT_CONTEXT });

    expect(port.acquire(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, SESSION)).toMatchObject({ locked: true });
    // Not rewritten: the holder must still be able to release what it took, and
    // a crash here must not leave the section unowned.
    expect(store.peek(SESSION)).toMatchObject({ held: true, contextId: PARENT_CONTEXT });

    port.release(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, SESSION);
    expect(store.peek(SESSION)).toMatchObject({ held: true, contextId: PARENT_CONTEXT });
    expect(store.release(PARENT_CONTEXT, SESSION)).toMatchObject({ released: true });
  });

  test('a lock held by anyone else is still contention', () => {
    const store = lockStore();
    store.acquire('run-one-phase-9', SESSION);
    const port = toolRequestRepoLockPort(store, { ambientContextId: PARENT_CONTEXT });

    expect(port.acquire(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, SESSION)).toMatchObject({
      locked: false,
      reason: 'lock_held',
      ownerContextId: 'run-one-phase-9',
    });
    expect(store.peek(SESSION)).toMatchObject({ held: true, contextId: 'run-one-phase-9' });
  });

  test('naming no ambient holder keeps the admin CLI behavior exactly as it was', () => {
    const store = lockStore();
    store.acquire(PARENT_CONTEXT, SESSION);
    const port = toolRequestRepoLockPort(store);

    expect(port.acquire(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, SESSION)).toMatchObject({
      locked: false,
      reason: 'lock_held',
      ownerContextId: PARENT_CONTEXT,
    });
  });
});

describe('chatops-scan composition root', () => {
  // The ambient holder is only correct because it is *this pass's own*
  // `--context-id`: the parent takes the lock under the very id it then hands
  // the child. A composition root that stopped naming it, or named something
  // else, would restore the always-refused `/grant` this rule removes — and no
  // unit of either module can observe that, because the wiring is the fact.
  test('names its own --context-id as the ambient repo-lock holder', () => {
    const source = readFileSync(join(process.cwd(), 'src/cli/chatops-scan.ts'), 'utf8');
    expect(source).toMatch(/ambientLockContextId:\s*contextId\b/);
  });
});
