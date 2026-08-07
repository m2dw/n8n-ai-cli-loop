import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  JsonSessionRegistry,
  resolveAssignment,
  agentForPhase,
  readResolvedAssignment,
  ASSIGNMENT_CONTEXT_KEY,
} from '../dist/index.js';
import { createImplementationHandler } from '../dist/handlers/implementation.js';

const NOW = '2026-06-17T00:00:00.000Z';

// A resolved-session shape sufficient for resolveAssignment / agentForPhase.
const SESSION = (overrides = {}) => ({
  sessionId: 'addon-dev',
  repoKey: 'test-repo',
  repoRoot: '/tmp/test-repo',
  githubRepo: 'm2dw/test-repo',
  artifactDir: '.n8n-artifacts',
  artifactRoot: '/tmp/test-repo/.n8n-artifacts',
  githubOwner: 'm2dw',
  githubName: 'test-repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  ...overrides,
});

const makeTask = (overrides = {}) => ({
  sessionId: 'addon-dev',
  issueNumber: 77,
  status: 'running',
  phase: 'implementation',
  priority: 'normal',
  attempts: {},
  context: {},
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

// ---------------------------------------------------------------------------
// resolveAssignment
// ---------------------------------------------------------------------------

describe('resolveAssignment', () => {
  test('no assignment config preserves current defaults (built-in code flow)', () => {
    const a = resolveAssignment(SESSION(), ['agent:claude', 'status:needs-implementation'], NOW);
    expect(a).toMatchObject({
      flow: 'code',
      implementationAgent: 'claude',
      reviewAgent: 'codex',
      conflictResolutionAgent: 'claude',
      researchAgent: 'gemini',
      source: 'default',
      resolvedAt: NOW,
    });
  });

  test('omits researchAgent when no research default exists', () => {
    const session = SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'codex' } });
    const a = resolveAssignment(session, [], NOW);
    expect(a.researchAgent).toBeUndefined();
    expect(a).toMatchObject({ implementationAgent: 'claude', reviewAgent: 'codex', conflictResolutionAgent: 'claude' });
  });

  test('documentation label selects the configured docs flow', () => {
    const session = SESSION({
      assignmentProfiles: {
        code: { implementation: 'claude', review: 'codex', conflict_resolution: 'claude' },
        docs: { implementation: 'claude', review: 'claude' },
      },
      flowRules: [
        { flow: 'docs', labels: ['documentation'] },
        { flow: 'code', default: true },
      ],
      defaultFlow: 'code',
    });
    const a = resolveAssignment(session, ['documentation'], NOW);
    expect(a).toMatchObject({
      flow: 'docs',
      reviewAgent: 'claude', // overridden by the docs profile
      implementationAgent: 'claude',
      conflictResolutionAgent: 'claude', // omitted in docs profile -> session default
      source: 'session-config',
    });
  });

  test('first matching rule wins; no match falls back to the default rule', () => {
    const session = SESSION({
      assignmentProfiles: {
        docs: { implementation: 'claude', review: 'claude' },
        code: { implementation: 'claude', review: 'codex' },
      },
      flowRules: [
        { flow: 'docs', labels: ['documentation'] },
        { flow: 'code', default: true },
      ],
    });
    expect(resolveAssignment(session, ['enhancement', 'documentation'], NOW).flow).toBe('docs');
    expect(resolveAssignment(session, ['bug'], NOW).flow).toBe('code');
  });

  test('a labels rule matches only when ALL its labels are present', () => {
    const session = SESSION({
      assignmentProfiles: {
        special: { implementation: 'codex', review: 'codex' },
        code: { implementation: 'claude', review: 'codex' },
      },
      flowRules: [
        { flow: 'special', labels: ['documentation', 'priority:high'] },
        { flow: 'code', default: true },
      ],
    });
    expect(resolveAssignment(session, ['documentation'], NOW).flow).toBe('code');
    expect(resolveAssignment(session, ['documentation', 'priority:high'], NOW).flow).toBe('special');
  });

  test('label override wins over session default for implementationAgent (agent:codex label)', () => {
    // Default session has implementationAgent: 'claude'. A label-derived override
    // (from labelsToPhase mapping agent:codex) must take priority so that the
    // persisted assignment reflects the explicit label, not the session default.
    // conflictResolutionAgent stays on Claude — label overrides for implementation
    // do NOT propagate to conflict resolution because only Claude is supported there.
    const a = resolveAssignment(
      SESSION(),
      ['agent:codex', 'status:needs-implementation'],
      NOW,
      { implementationAgent: 'codex' },
    );
    expect(a).toMatchObject({
      flow: 'code',
      implementationAgent: 'codex',
      conflictResolutionAgent: 'claude',
      reviewAgent: 'codex',   // session default reviewAgent
      source: 'default',
    });
  });

  test('label override for implementationAgent does NOT propagate to conflictResolutionAgent', () => {
    // Only conflict-resolution-supported agents (claude) should appear as conflictResolutionAgent.
    // A Codex label override routes implementation to Codex but leaves conflict resolution on Claude.
    const a = resolveAssignment(SESSION(), [], NOW, { implementationAgent: 'codex' });
    expect(a.implementationAgent).toBe('codex');
    expect(a.conflictResolutionAgent).toBe('claude');
  });

  test('session with codex as default implementationAgent clamps conflictResolutionAgent to claude', () => {
    // When the session default implementation agent is Codex (no assignment profiles),
    // the built-in code profile sets conflict_resolution from the implementation default.
    // resolveAssignment must clamp it to Claude — the only supported conflict-resolution agent.
    const codexDefaultSession = SESSION({
      defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
    });
    const a = resolveAssignment(codexDefaultSession, [], NOW);
    expect(a.implementationAgent).toBe('codex');
    expect(a.conflictResolutionAgent).toBe('claude');
  });

  test('label override does not affect slots not explicitly overridden', () => {
    // Only implementationAgent is overridden; reviewAgent follows the profile.
    const a = resolveAssignment(SESSION(), [], NOW, { implementationAgent: 'codex' });
    expect(a.reviewAgent).toBe('codex'); // SESSION default reviewAgent is 'codex'
  });

  test('no labelOverrides argument preserves existing behavior', () => {
    const a = resolveAssignment(SESSION(), ['agent:codex', 'status:needs-implementation'], NOW);
    // Without overrides the session default still wins (backward-compatible).
    expect(a.implementationAgent).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// agentForPhase — task/session boundary
// ---------------------------------------------------------------------------

describe('agentForPhase', () => {
  test('reads the persisted assignment in preference to session defaults', () => {
    const session = SESSION();
    const task = makeTask({
      context: {
        [ASSIGNMENT_CONTEXT_KEY]: {
          flow: 'docs',
          implementationAgent: 'codex',
          reviewAgent: 'claude',
          conflictResolutionAgent: 'codex',
          source: 'session-config',
          resolvedAt: NOW,
        },
      },
    });
    expect(agentForPhase(task, session, 'implementation')).toBe('codex');
    expect(agentForPhase(task, session, 'review')).toBe('claude');
    expect(agentForPhase(task, session, 'conflictResolution')).toBe('codex');
  });

  test('falls back to per-task column then session default when no assignment persisted', () => {
    const session = SESSION();
    expect(agentForPhase(makeTask(), session, 'implementation')).toBe('claude');
    expect(agentForPhase(makeTask(), session, 'review')).toBe('codex');
    expect(agentForPhase(makeTask({ implementationAgent: 'gemini' }), session, 'implementation')).toBe('gemini');
    // conflict resolution historically follows the implementation slot
    expect(agentForPhase(makeTask({ implementationAgent: 'gemini' }), session, 'conflictResolution')).toBe('gemini');
  });

  test('editing session config does not change a task with a persisted assignment', () => {
    const persisted = {
      flow: 'code',
      implementationAgent: 'claude',
      reviewAgent: 'codex',
      conflictResolutionAgent: 'claude',
      source: 'default',
      resolvedAt: NOW,
    };
    const task = makeTask({ context: { [ASSIGNMENT_CONTEXT_KEY]: persisted } });
    // Session edited later to flip the implementation default to codex.
    const editedSession = SESSION({ defaults: { implementationAgent: 'codex', reviewAgent: 'codex' } });
    expect(agentForPhase(task, editedSession, 'implementation')).toBe('claude');
  });

  test('readResolvedAssignment ignores malformed context', () => {
    expect(readResolvedAssignment(makeTask())).toBeUndefined();
    expect(readResolvedAssignment(makeTask({ context: { [ASSIGNMENT_CONTEXT_KEY]: 'nope' } }))).toBeUndefined();
    expect(readResolvedAssignment(makeTask({ context: { [ASSIGNMENT_CONTEXT_KEY]: { flow: 'x' } } }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JSON config validation
// ---------------------------------------------------------------------------

describe('JsonSessionRegistry assignment validation', () => {
  let tmpDir;
  let jsonPath;

  const BASE = {
    sessionId: 'addon-dev',
    repoKey: 'test-repo',
    repoRoot: '/Users/moto/git/test-repo',
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  };

  const write = (fields) =>
    writeFileSync(jsonPath, JSON.stringify({ sessions: [{ ...BASE, ...fields }] }), 'utf8');

  // A single malformed entry is quarantined rather than failing registry
  // construction (issue #823) — assert the diagnostic instead of a throw.
  function expectInvalidEntry(pattern) {
    const registry = new JsonSessionRegistry(jsonPath);
    const diagnostics = registry.getDiagnostics();
    const match = diagnostics.find((d) => d.kind === 'invalid_entry' && d.indices.includes(0));
    expect(match).toBeDefined();
    expect(match.message).toMatch(pattern);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'assignment-test-'));
    jsonPath = join(tmpDir, 'sessions.json');
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('loads a docs flow with rules and a synthesized defaultFlow', async () => {
    write({
      assignmentProfiles: {
        code: { implementation: 'claude', review: 'codex', conflict_resolution: 'claude' },
        docs: { implementation: 'claude', review: 'claude' },
      },
      flowRules: [
        { flow: 'docs', labels: ['documentation'] },
        { flow: 'code', default: true },
      ],
    });
    const session = await new JsonSessionRegistry(jsonPath).getSessionById('addon-dev');
    expect(session.defaultFlow).toBe('code');
    expect(session.assignmentProfiles.docs).toEqual({ implementation: 'claude', review: 'claude' });
    expect(session.flowRules).toEqual([
      { flow: 'docs', labels: ['documentation'] },
      { flow: 'code', default: true },
    ]);
  });

  test('synthesizes a code default rule when flowRules are omitted', async () => {
    write({ assignmentProfiles: { code: { implementation: 'claude', review: 'codex' } } });
    const session = await new JsonSessionRegistry(jsonPath).getSessionById('addon-dev');
    expect(session.defaultFlow).toBe('code');
    expect(session.flowRules).toEqual([{ flow: 'code', default: true }]);
  });

  test('accepts a codex-only implementation profile (execution fails closed later)', async () => {
    write({
      assignmentProfiles: { code: { implementation: 'codex', review: 'codex', conflict_resolution: 'codex' } },
    });
    const session = await new JsonSessionRegistry(jsonPath).getSessionById('addon-dev');
    expect(session.assignmentProfiles.code.implementation).toBe('codex');
  });

  test('rejects an unknown agent id', () => {
    write({ assignmentProfiles: { code: { implementation: 'not-an-agent', review: 'codex' } } });
    expectInvalidEntry(/must be one of/);
  });

  test('rejects a profile missing the required review role', () => {
    write({ assignmentProfiles: { code: { implementation: 'claude' } } });
    expectInvalidEntry(/review/);
  });

  test('rejects a flow rule referencing an undefined profile', () => {
    write({
      assignmentProfiles: { code: { implementation: 'claude', review: 'codex' } },
      flowRules: [
        { flow: 'docs', labels: ['documentation'] },
        { flow: 'code', default: true },
      ],
    });
    expectInvalidEntry(/no entry in assignmentProfiles/);
  });

  test('rejects zero default flow rules', () => {
    write({
      assignmentProfiles: { code: { implementation: 'claude', review: 'codex' } },
      flowRules: [{ flow: 'code', labels: ['documentation'] }],
    });
    expectInvalidEntry(/exactly one rule with "default": true/);
  });

  test('rejects multiple default flow rules', () => {
    write({
      assignmentProfiles: { code: { implementation: 'claude', review: 'codex' } },
      flowRules: [
        { flow: 'code', default: true },
        { flow: 'code', default: true },
      ],
    });
    expectInvalidEntry(/exactly one rule with "default": true/);
  });

  test('rejects a defaultFlow that disagrees with the default rule', () => {
    write({
      assignmentProfiles: {
        code: { implementation: 'claude', review: 'codex' },
        docs: { implementation: 'claude', review: 'claude' },
      },
      flowRules: [{ flow: 'code', default: true }],
      defaultFlow: 'docs',
    });
    expectInvalidEntry(/must agree with the default flow rule/);
  });

  test('a session without assignment config leaves the fields undefined', async () => {
    writeFileSync(jsonPath, JSON.stringify({ sessions: [BASE] }), 'utf8');
    const session = await new JsonSessionRegistry(jsonPath).getSessionById('addon-dev');
    expect(session.assignmentProfiles).toBeUndefined();
    expect(session.flowRules).toBeUndefined();
    expect(session.defaultFlow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: unsupported phase/agent pair
// ---------------------------------------------------------------------------

describe('phase handler fails closed for an unsupported agent', () => {
  let tmpDir;
  let artifactRoot;
  afterEach(() => tmpDir && rmSync(tmpDir, { recursive: true, force: true }));

  test('implementation handler rejects an unknown agent assignment with a clear error and artifact', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'assignment-handler-'));
    artifactRoot = join(tmpDir, '.n8n-artifacts');
    const runId = 'run-fail-closed';
    const session = SESSION({ repoRoot: tmpDir, artifactRoot });
    const handler = createImplementationHandler({ session, runId, workerId: 'w' });
    const task = makeTask({
      context: {
        labels: ['agent:claude', 'status:needs-implementation'],
        [ASSIGNMENT_CONTEXT_KEY]: {
          flow: 'customFlow',
          implementationAgent: 'gpt4',
          reviewAgent: 'gpt4',
          conflictResolutionAgent: 'gpt4',
          source: 'session-config',
          resolvedAt: NOW,
        },
      },
    });

    const result = await handler(task);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Unsupported implementation agent: gpt4/);

    const artifact = join(artifactRoot, 'runs', runId, 'assignment-error.json');
    expect(existsSync(artifact)).toBe(true);
    const parsed = JSON.parse(readFileSync(artifact, 'utf8'));
    expect(parsed).toMatchObject({ success: false, phase: 'implementation', agentId: 'gpt4' });
  });
});
