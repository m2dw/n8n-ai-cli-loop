import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  JsonSessionRegistry,
  resolveSessionRef,
  SessionReferenceError,
  SessionRegistryFatalError,
} from '../dist/index.js';
import { resolvePublicationPolicy } from '../dist/core/research-publication.js';

const SESSION_A = {
  sessionId: 'addon-dev',
  repoKey: 'thunderbird-auth-results-filter',
  repoRoot: '/Users/moto/git/thunderbird-auth-results-filter',
  githubRepo: 'm2dw/thunderbird-auth-results-filter',
  artifactDir: '.n8n-artifacts',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test', package: 'npm run package' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
};

const SESSION_B = {
  sessionId: 'workflow-dev',
  repoKey: 'n8n-ai-cli-loop',
  repoRoot: '/Users/moto/git/n8n-ai-cli-loop',
  githubRepo: 'm2dw/n8n-ai-cli-loop',
  artifactDir: '.n8n-artifacts',
  defaults: { implementationAgent: 'codex', reviewAgent: 'claude' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
};

let tmpDir;
let jsonPath;

function writeSessions(...sessions) {
  writeFileSync(jsonPath, JSON.stringify({ sessions }), 'utf8');
}

/**
 * Construct a registry over the sessions.json just written and assert that the
 * entry at `index` (default 0 — every helper call site in this file writes a
 * single offending entry) was quarantined as `invalid_entry` with a message
 * matching `pattern`, rather than the whole registry failing to construct
 * (issue #823). Returns the diagnostic message so callers can also assert on
 * what it does NOT contain (e.g. a secret value).
 */
function expectInvalidEntry(pattern, { index = 0 } = {}) {
  const registry = new JsonSessionRegistry(jsonPath);
  const diagnostics = registry.getDiagnostics();
  const match = diagnostics.find((d) => d.kind === 'invalid_entry' && d.indices.includes(index));
  expect(match).toBeDefined();
  expect(match.message).toMatch(pattern);
  return match.message;
}

/**
 * Construct a registry over the sessions.json just written and assert that
 * some `ambiguous_reference` diagnostic matches `pattern` and quarantines
 * exactly entries [0, 1] (every collision test in this file writes exactly two
 * colliding entries). Returns the diagnostic message.
 */
function expectAmbiguous(pattern) {
  const registry = new JsonSessionRegistry(jsonPath);
  const diagnostics = registry.getDiagnostics();
  const match = diagnostics.find((d) => d.kind === 'ambiguous_reference' && pattern.test(d.message));
  expect(match).toBeDefined();
  expect([...match.indices].sort((a, b) => a - b)).toEqual([0, 1]);
  return match.message;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'json-session-registry-test-'));
  jsonPath = join(tmpDir, 'sessions.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('JsonSessionRegistry', () => {
  test('loads two sessions and returns them via listSessions', async () => {
    writeSessions(SESSION_A, SESSION_B);
    const registry = new JsonSessionRegistry(jsonPath);
    const sessions = await registry.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId)).toEqual(
      expect.arrayContaining(['addon-dev', 'workflow-dev']),
    );
  });

  test('getSessionById returns the matching session', async () => {
    writeSessions(SESSION_A, SESSION_B);
    const registry = new JsonSessionRegistry(jsonPath);
    const session = await registry.getSessionById('addon-dev');

    expect(session).toMatchObject({
      sessionId: 'addon-dev',
      githubOwner: 'm2dw',
      githubName: 'thunderbird-auth-results-filter',
      artifactRoot: '/Users/moto/git/thunderbird-auth-results-filter/.n8n-artifacts',
    });
  });

  test('getSessionById returns undefined for unknown id', async () => {
    writeSessions(SESSION_A);
    const registry = new JsonSessionRegistry(jsonPath);
    expect(await registry.getSessionById('no-such-session')).toBeUndefined();
  });

  test('getSessionByRepoKey returns the matching session', async () => {
    writeSessions(SESSION_A, SESSION_B);
    const registry = new JsonSessionRegistry(jsonPath);
    const session = await registry.getSessionByRepoKey('n8n-ai-cli-loop');

    expect(session).toMatchObject({ sessionId: 'workflow-dev', repoKey: 'n8n-ai-cli-loop' });
  });

  test('getSessionByRepoKey returns undefined for unknown key', async () => {
    writeSessions(SESSION_A);
    const registry = new JsonSessionRegistry(jsonPath);
    expect(await registry.getSessionByRepoKey('no-such-repo')).toBeUndefined();
  });

  test('ResolvedSession includes derived fields', async () => {
    writeSessions(SESSION_A);
    const registry = new JsonSessionRegistry(jsonPath);
    const session = await registry.getSessionById('addon-dev');

    expect(session).toMatchObject({
      githubOwner: 'm2dw',
      githubName: 'thunderbird-auth-results-filter',
      artifactRoot: '/Users/moto/git/thunderbird-auth-results-filter/.n8n-artifacts',
    });
  });

  test('a session that omits the worktrees block resolves worktrees to undefined', async () => {
    writeSessions(SESSION_A);
    const registry = new JsonSessionRegistry(jsonPath);
    const session = await registry.getSessionById('addon-dev');

    expect(session.worktrees).toBeUndefined();
  });

  test('a session with an explicit worktrees.root override is unchanged', async () => {
    writeSessions({ ...SESSION_A, worktrees: { root: '/custom/worktree/root' } });
    const registry = new JsonSessionRegistry(jsonPath);
    const session = await registry.getSessionById('addon-dev');

    expect(session.worktrees).toEqual({ root: '/custom/worktree/root' });
  });

  test('rejects legacy worktrees.enabled with an actionable error (issue #731)', () => {
    writeSessions({ ...SESSION_A, worktrees: { enabled: false } });
    expectInvalidEntry(/worktrees\.enabled is no longer supported/);
  });

  test('rejects legacy worktrees.enabled: true too', () => {
    writeSessions({ ...SESSION_A, worktrees: { enabled: true, root: '/custom/worktree/root' } });
    expectInvalidEntry(/worktrees\.enabled is no longer supported/);
  });

  test('rejects relative repoRoot', () => {
    writeSessions({ ...SESSION_A, repoRoot: 'relative/path' });
    expectInvalidEntry(/absolute/);
  });

  test('quarantines both entries on a duplicate sessionId (issue #823)', () => {
    writeSessions(SESSION_A, { ...SESSION_B, sessionId: SESSION_A.sessionId });
    expectAmbiguous(new RegExp(`Ambiguous session reference "${SESSION_A.sessionId}"`));
  });

  test('quarantines both entries on a duplicate repoKey (issue #823)', () => {
    writeSessions(SESSION_A, { ...SESSION_B, repoKey: SESSION_A.repoKey });
    expectAmbiguous(new RegExp(`Ambiguous repoKey reference "${SESSION_A.repoKey}"`));
  });

  test('rejects missing sessions.json with explicit error', () => {
    expect(() => new JsonSessionRegistry(join(tmpDir, 'nonexistent.json'))).toThrow(
      /does not exist/,
    );
  });

  test('rejects githubRepo not in owner/name format', () => {
    writeSessions({ ...SESSION_A, githubRepo: 'nodomain' });
    expectInvalidEntry(/owner\/name/);
  });

  test('accepts optional baseBranch and exposes it on resolved session', async () => {
    writeSessions({ ...SESSION_A, baseBranch: 'develop' });
    const registry = new JsonSessionRegistry(jsonPath);
    const session = await registry.getSessionById('addon-dev');
    expect(session.baseBranch).toBe('develop');
  });

  test('baseBranch is undefined when not set in config', async () => {
    writeSessions(SESSION_A);
    const registry = new JsonSessionRegistry(jsonPath);
    const session = await registry.getSessionById('addon-dev');
    expect(session.baseBranch).toBeUndefined();
  });

  test('rejects empty string baseBranch', () => {
    writeSessions({ ...SESSION_A, baseBranch: '' });
    expectInvalidEntry(/baseBranch/);
  });

  test('listSessions returns independent copies (no aliasing)', async () => {
    writeSessions(SESSION_A);
    const registry = new JsonSessionRegistry(jsonPath);
    const [s1] = await registry.listSessions();
    s1.defaults.implementationAgent = 'gemini';
    const [s2] = await registry.listSessions();
    expect(s2.defaults.implementationAgent).toBe('claude');
  });

  describe('reviewDispute configuration (docs/review-dispute-contract.md §6.1)', () => {
    test('is absent by default', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.reviewDispute).toBeUndefined();
    });

    test('accepts an enabled protocol with lowered limits and an arbiter policy', async () => {
      writeSessions({
        ...SESSION_A,
        reviewDispute: {
          enabled: true,
          limits: { maxVersionsPerLineage: 1, maxReconsiderationsPerLineage: 0, maxEvidenceRoundsPerLineage: 0 },
          arbiter: { providers: ['gemini'], minConfidence: 0.8 },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.reviewDispute).toEqual({
        enabled: true,
        limits: { maxVersionsPerLineage: 1, maxReconsiderationsPerLineage: 0, maxEvidenceRoundsPerLineage: 0 },
        arbiter: { providers: ['gemini'], minConfidence: 0.8 },
      });
    });

    test('returned sessions do not alias the stored limits or arbiter providers', async () => {
      writeSessions({
        ...SESSION_A,
        reviewDispute: {
          enabled: true,
          limits: { maxVersionsPerLineage: 1 },
          arbiter: { providers: ['gemini'] },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);

      const byId = await registry.getSessionById('addon-dev');
      byId.reviewDispute.limits.maxVersionsPerLineage = 99;
      byId.reviewDispute.arbiter.providers.push('claude');

      const byRepoKey = await registry.getSessionByRepoKey('thunderbird-auth-results-filter');
      expect(byRepoKey.reviewDispute.limits.maxVersionsPerLineage).toBe(1);
      expect(byRepoKey.reviewDispute.arbiter.providers).toEqual(['gemini']);

      byRepoKey.reviewDispute.limits.maxVersionsPerLineage = 42;
      byRepoKey.reviewDispute.arbiter.providers.length = 0;

      const [listed] = await registry.listSessions();
      expect(listed.reviewDispute.limits.maxVersionsPerLineage).toBe(1);
      expect(listed.reviewDispute.arbiter.providers).toEqual(['gemini']);
    });

    test('rejects at session load a limit that would leave a state with no next action', () => {
      // §6.1: fail closed — the protocol never starts half-enabled. A session
      // that wants it off says `enabled: false`.
      for (const key of [
        'maxRebuttalsPerVersion',
        'maxVersionsPerLineage',
        'maxArbitrationPassesPerLineage',
        'maxMalformedArbiterAttemptsPerLineage',
      ]) {
        writeSessions({ ...SESSION_A, reviewDispute: { enabled: true, limits: { [key]: 0 } } });
        expectInvalidEntry(/must not be lower than 1/);
      }
    });

    test('rejects a raised limit, an unknown limit, and a bad arbiter threshold', () => {
      writeSessions({ ...SESSION_A, reviewDispute: { limits: { maxVersionsPerLineage: 3 } } });
      expectInvalidEntry(/may only be lowered/);

      writeSessions({ ...SESSION_A, reviewDispute: { limits: { maxDebateRounds: 5 } } });
      expectInvalidEntry(/is not a review-dispute limit/);

      writeSessions({ ...SESSION_A, reviewDispute: { arbiter: { minConfidence: 2 } } });
      expectInvalidEntry(/minConfidence must be within \[0, 1\]/);

      writeSessions({ ...SESSION_A, reviewDispute: { arbiter: { model: 'x' } } });
      expectInvalidEntry(/is not a known arbiter setting/);

      writeSessions({ ...SESSION_A, reviewDispute: { enabled: 'yes' } });
      expectInvalidEntry(/enabled must be a boolean/);
    });

    test('rejects an unknown top-level review-dispute key instead of silently disabling', () => {
      // A misspelled `enabled` would otherwise resolve to "protocol off" —
      // the safeguards would be configured and inert.
      writeSessions({ ...SESSION_A, reviewDispute: { enable: true } });
      expectInvalidEntry(/reviewDispute\.enable is not a known review-dispute setting/);

      writeSessions({
        ...SESSION_A,
        reviewDispute: { enabled: true, limit: { maxVersionsPerLineage: 1 } },
      });
      expectInvalidEntry(/reviewDispute\.limit is not a known review-dispute setting/);
    });
  });

  describe('dependencySync configuration', () => {
    const DEP_SYNC = {
      enabled: true,
      triggerPaths: ['package.json'],
      expectedOutputs: ['package-lock.json'],
      command: 'npm install --package-lock-only --ignore-scripts',
      timeoutMs: 120000,
    };

    test('accepts a valid dependencySync block and exposes it on the resolved session', async () => {
      writeSessions({ ...SESSION_A, dependencySync: DEP_SYNC });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.dependencySync).toEqual(DEP_SYNC);
    });

    test('dependencySync is undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.dependencySync).toBeUndefined();
    });

    test('accepts optional allowLifecycleScripts', async () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, allowLifecycleScripts: true } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.dependencySync.allowLifecycleScripts).toBe(true);
    });

    test('timeoutMs is optional', async () => {
      const { timeoutMs, ...withoutTimeout } = DEP_SYNC;
      writeSessions({ ...SESSION_A, dependencySync: withoutTimeout });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.dependencySync.timeoutMs).toBeUndefined();
    });

    test('accepts a minimal { enabled: false } block (master switch off)', async () => {
      writeSessions({ ...SESSION_A, dependencySync: { enabled: false } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.dependencySync.enabled).toBe(false);
      expect(session.dependencySync.triggerPaths).toEqual([]);
      expect(session.dependencySync.expectedOutputs).toEqual([]);
      expect(session.dependencySync.command).toBe('');
    });

    test('still validates execution fields that ARE supplied on a disabled block', () => {
      writeSessions({ ...SESSION_A, dependencySync: { enabled: false, triggerPaths: [123] } });
      expectInvalidEntry(/triggerPaths\[0\] must be a non-empty string/);
    });

    test('rejects non-boolean enabled', () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, enabled: 'yes' } });
      expectInvalidEntry(/dependencySync.enabled must be a boolean/);
    });

    test('rejects empty triggerPaths', () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, triggerPaths: [] } });
      expectInvalidEntry(/triggerPaths must be a non-empty array/);
    });

    test('rejects missing command', () => {
      const { command, ...withoutCommand } = DEP_SYNC;
      writeSessions({ ...SESSION_A, dependencySync: withoutCommand });
      expectInvalidEntry(/dependencySync.command must be a non-empty string/);
    });

    test('rejects non-integer timeoutMs', () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, timeoutMs: 0 } });
      expectInvalidEntry(/timeoutMs must be a positive integer/);
    });

    test('rejects non-string entries in expectedOutputs', () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, expectedOutputs: [123] } });
      expectInvalidEntry(/expectedOutputs\[0\] must be a non-empty string/);
    });

    test('resolved dependencySync arrays are independent copies (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, dependencySync: DEP_SYNC });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.dependencySync.triggerPaths.push('mutated');
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.dependencySync.triggerPaths).toEqual(['package.json']);
    });
  });

  describe('environmentPrepare configuration (issue #510)', () => {
    const ENV_PREPARE = {
      enabled: true,
      command: 'npm ci',
      cacheKeyFiles: ['package-lock.json'],
      timeoutMs: 120000,
    };

    test('accepts a valid environmentPrepare block and exposes it on the resolved session', async () => {
      writeSessions({ ...SESSION_A, environmentPrepare: ENV_PREPARE });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.environmentPrepare).toEqual(ENV_PREPARE);
    });

    test('environmentPrepare is undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.environmentPrepare).toBeUndefined();
    });

    test('accepts optional allowLifecycleScripts', async () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, allowLifecycleScripts: true } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.environmentPrepare.allowLifecycleScripts).toBe(true);
    });

    test('cacheKeyFiles is optional', async () => {
      const { cacheKeyFiles, ...withoutCacheKeyFiles } = ENV_PREPARE;
      writeSessions({ ...SESSION_A, environmentPrepare: withoutCacheKeyFiles });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.environmentPrepare.cacheKeyFiles).toBeUndefined();
    });

    test('timeoutMs is optional', async () => {
      const { timeoutMs, ...withoutTimeout } = ENV_PREPARE;
      writeSessions({ ...SESSION_A, environmentPrepare: withoutTimeout });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.environmentPrepare.timeoutMs).toBeUndefined();
    });

    test('accepts a minimal { enabled: false } block (master switch off)', async () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { enabled: false } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.environmentPrepare.enabled).toBe(false);
      expect(session.environmentPrepare.command).toBe('');
    });

    test('still validates execution fields that ARE supplied on a disabled block', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { enabled: false, cacheKeyFiles: [123] } });
      expectInvalidEntry(/cacheKeyFiles\[0\] must be a non-empty string/);
    });

    test('rejects non-boolean enabled', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, enabled: 'yes' } });
      expectInvalidEntry(/environmentPrepare.enabled must be a boolean/);
    });

    test('rejects missing command when enabled', () => {
      const { command, ...withoutCommand } = ENV_PREPARE;
      writeSessions({ ...SESSION_A, environmentPrepare: withoutCommand });
      expectInvalidEntry(/environmentPrepare.command must be a non-empty string/);
    });

    test('rejects non-boolean allowLifecycleScripts', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, allowLifecycleScripts: 'yes' } });
      expectInvalidEntry(/allowLifecycleScripts must be a boolean/);
    });

    test('rejects non-integer timeoutMs', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, timeoutMs: 0 } });
      expectInvalidEntry(/timeoutMs must be a positive integer/);
    });

    test('rejects non-string entries in cacheKeyFiles', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, cacheKeyFiles: [123] } });
      expectInvalidEntry(/cacheKeyFiles\[0\] must be a non-empty string/);
    });

    test('resolved environmentPrepare cacheKeyFiles is an independent copy (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, environmentPrepare: ENV_PREPARE });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.environmentPrepare.cacheKeyFiles.push('mutated');
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.environmentPrepare.cacheKeyFiles).toEqual(['package-lock.json']);
    });
  });

  describe('codex context-mode configuration (issue #376)', () => {
    test('codex is undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.codex).toBeUndefined();
    });

    test('accepts a config-override context-mode block', async () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: true, config: ['context_mode=on'] } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.codex.contextMode).toEqual({ enabled: true, config: ['context_mode=on'] });
    });

    test('accepts a profile-only context-mode block', async () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: true, profile: 'ctx' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.codex.contextMode).toEqual({ enabled: true, profile: 'ctx' });
    });

    test('accepts a disabled block without an invocation form', async () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: false } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.codex.contextMode).toEqual({ enabled: false });
    });

    test('rejects non-boolean enabled', () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: 'yes', config: ['context_mode=on'] } } });
      expectInvalidEntry(/contextMode.enabled must be a boolean/);
    });

    test('rejects enabled block with no invocation form', () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: true } } });
      expectInvalidEntry(/no invocation form is configured/);
    });

    test('rejects a config entry that is not key=value', () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: true, config: ['bogus'] } } });
      expectInvalidEntry(/config\[0\] must be a key=value override/);
    });

    test('resolved codex config arrays are independent copies (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: true, config: ['context_mode=on'] } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.codex.contextMode.config.push('mutated');
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.codex.contextMode.config).toEqual(['context_mode=on']);
    });
  });

  describe('codex model configuration (issue #609)', () => {
    test('codex.model is undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.codex).toBeUndefined();
    });

    test('accepts an explicit model string', async () => {
      writeSessions({ ...SESSION_A, codex: { model: 'gpt-5-codex' } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.codex.model).toBe('gpt-5-codex');
    });

    test('rejects a non-string model', () => {
      writeSessions({ ...SESSION_A, codex: { model: 42 } });
      expectInvalidEntry(/model must be a non-empty string/);
    });

    test('rejects an empty-string model', () => {
      writeSessions({ ...SESSION_A, codex: { model: '   ' } });
      expectInvalidEntry(/model must be a non-empty string/);
    });

    test('coexists with contextMode in the same block', async () => {
      writeSessions({
        ...SESSION_A,
        codex: { model: 'gpt-5-codex', contextMode: { enabled: true, profile: 'ctx' } },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.codex).toEqual({ model: 'gpt-5-codex', contextMode: { enabled: true, profile: 'ctx' } });
    });
  });

  describe('research configuration (issue #493)', () => {
    test('research is undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toBeUndefined();
    });

    test('accepts a research.antigravity.model config', async () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { model: 'Gemini 3.1 Pro (Low)' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({ antigravity: { model: 'Gemini 3.1 Pro (Low)' } });
    });

    test('accepts research.antigravity without model (empty antigravity block)', async () => {
      writeSessions({ ...SESSION_A, research: { antigravity: {} } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({ antigravity: {} });
    });

    test('accepts research block with no antigravity key', async () => {
      writeSessions({ ...SESSION_A, research: {} });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({});
    });

    test('rejects research.antigravity.model that is an empty string', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { model: '' } } });
      expectInvalidEntry(/research\.antigravity\.model must be a non-empty string/);
    });

    test('rejects research.antigravity.model that is not a string', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { model: 42 } } });
      expectInvalidEntry(/research\.antigravity\.model must be a non-empty string/);
    });

    test('rejects research.antigravity that is not an object', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: 'Gemini 3.1 Pro (Low)' } });
      expectInvalidEntry(/research\.antigravity must be an object/);
    });

    test('rejects research that is not an object', () => {
      writeSessions({ ...SESSION_A, research: 'Gemini 3.1 Pro (Low)' });
      expectInvalidEntry(/research must be an object/);
    });

    test('resolved research config is an independent copy (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { model: 'Gemini 3.1 Pro (Low)' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.research.antigravity.model = 'mutated';
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.research.antigravity.model).toBe('Gemini 3.1 Pro (Low)');
    });
  });

  describe('research.antigravity.printTimeout configuration (issue #861)', () => {
    test('accepts a research.antigravity.printTimeout config', async () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '20m' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({ antigravity: { printTimeout: '20m' } });
    });

    test('accepts model and printTimeout together', async () => {
      writeSessions({
        ...SESSION_A,
        research: { antigravity: { model: 'Gemini 3.1 Pro (Low)', printTimeout: '30m' } },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({
        antigravity: { model: 'Gemini 3.1 Pro (Low)', printTimeout: '30m' },
      });
    });

    test('accepts a compound duration (minutes and seconds)', async () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '45m20s' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research.antigravity.printTimeout).toBe('45m20s');
    });

    test('accepts exactly the 60-minute bound', async () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '1h' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research.antigravity.printTimeout).toBe('1h');
    });

    test('rejects an empty string', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '' } } });
      expectInvalidEntry(/research\.antigravity\.printTimeout must be a non-empty string/);
    });

    test('rejects a malformed duration', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: 'fifteen minutes' } } });
      expectInvalidEntry(/research\.antigravity\.printTimeout is not a valid duration/);
    });

    test('rejects a value with no recognized unit', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '900' } } });
      expectInvalidEntry(/research\.antigravity\.printTimeout is not a valid duration/);
    });

    test('rejects a zero duration', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '0m' } } });
      expectInvalidEntry(/research\.antigravity\.printTimeout must be greater than zero/);
    });

    test('rejects a negative duration', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '-15m' } } });
      expectInvalidEntry(/research\.antigravity\.printTimeout is not a valid duration/);
    });

    test('rejects an excessively large duration', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '10h' } } });
      expectInvalidEntry(/research\.antigravity\.printTimeout must not exceed 60 minutes/);
    });

    test('rejects a non-string value', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: 900 } } });
      expectInvalidEntry(/research\.antigravity\.printTimeout must be a non-empty string/);
    });

    test('resolved research config is an independent copy (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { printTimeout: '20m' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.research.antigravity.printTimeout = 'mutated';
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.research.antigravity.printTimeout).toBe('20m');
    });
  });

  describe('research evidence configuration (issue #806)', () => {
    test('preserves a full research.evidence block', async () => {
      writeSessions({
        ...SESSION_A,
        research: {
          evidence: {
            enabled: true,
            denyGlobs: ['secrets/**'],
            generatedGlobs: ['dist/**'],
            maxTurns: 3,
          },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({
        evidence: {
          enabled: true,
          denyGlobs: ['secrets/**'],
          generatedGlobs: ['dist/**'],
          maxTurns: 3,
        },
      });
    });

    test('accepts an empty research.evidence block', async () => {
      writeSessions({ ...SESSION_A, research: { evidence: {} } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({ evidence: {} });
    });

    test('rejects research.evidence that is not an object', () => {
      writeSessions({ ...SESSION_A, research: { evidence: true } });
      expectInvalidEntry(/research\.evidence must be an object/);
    });

    test('rejects research.evidence.enabled that is not a boolean', () => {
      writeSessions({ ...SESSION_A, research: { evidence: { enabled: 'yes' } } });
      expectInvalidEntry(/research\.evidence\.enabled must be a boolean/);
    });

    test('rejects research.evidence.denyGlobs that is not an array of strings', () => {
      writeSessions({ ...SESSION_A, research: { evidence: { denyGlobs: 'secrets/**' } } });
      expectInvalidEntry(/research\.evidence\.denyGlobs must be an array of strings/);
    });

    test('rejects research.evidence.generatedGlobs entries that are not strings', () => {
      writeSessions({ ...SESSION_A, research: { evidence: { generatedGlobs: [42] } } });
      expectInvalidEntry(/research\.evidence\.generatedGlobs\[0\] must be a non-empty string/);
    });

    test('rejects research.evidence.maxTurns that is not a positive integer', () => {
      writeSessions({ ...SESSION_A, research: { evidence: { maxTurns: 0 } } });
      expectInvalidEntry(/research\.evidence\.maxTurns must be a positive integer/);
    });

    test('resolved evidence config is an independent copy (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, research: { evidence: { enabled: true, denyGlobs: ['secrets/**'] } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.research.evidence.enabled = false;
      s1.research.evidence.denyGlobs.push('mutated/**');
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.research.evidence).toEqual({ enabled: true, denyGlobs: ['secrets/**'] });
    });
  });

  describe('research publication configuration (issue #834)', () => {
    test('preserves a full research.publication block', async () => {
      writeSessions({
        ...SESSION_A,
        research: { publication: { mode: 'sanitized_summary', maxChars: 8000 } },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({
        publication: { mode: 'sanitized_summary', maxChars: 8000 },
      });
    });

    test('a configured sanitized_summary session actually resolves out of local_only', async () => {
      writeSessions({ ...SESSION_A, research: { publication: { mode: 'sanitized_summary' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(resolvePublicationPolicy(session.research?.publication).mode).toBe('sanitized_summary');
    });

    test('publication survives alongside the other research blocks', async () => {
      writeSessions({
        ...SESSION_A,
        research: {
          antigravity: { model: 'Gemini 3.1 Pro (Low)' },
          evidence: { enabled: true },
          publication: { mode: 'sanitized_summary' },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({
        antigravity: { model: 'Gemini 3.1 Pro (Low)' },
        evidence: { enabled: true },
        publication: { mode: 'sanitized_summary' },
      });
    });

    test('accepts an empty research.publication block', async () => {
      writeSessions({ ...SESSION_A, research: { publication: {} } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({ publication: {} });
    });

    test('rejects research.publication that is not an object', () => {
      writeSessions({ ...SESSION_A, research: { publication: 'sanitized_summary' } });
      expectInvalidEntry(/research\.publication must be an object/);
    });

    test('rejects an unrecognized research.publication.mode rather than silently withholding', () => {
      writeSessions({ ...SESSION_A, research: { publication: { mode: 'sanitised_summary' } } });
      expectInvalidEntry(/research\.publication\.mode must be one of: local_only, sanitized_summary/);
    });

    test('preserves the untrusted-inputs acknowledgment', async () => {
      writeSessions({
        ...SESSION_A,
        research: { publication: { mode: 'sanitized_summary', allowUntrustedInputs: true } },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.research).toEqual({
        publication: { mode: 'sanitized_summary', allowUntrustedInputs: true },
      });
      expect(resolvePublicationPolicy(session.research.publication).allowUntrustedInputs).toBe(true);
    });

    test('rejects a non-boolean allowUntrustedInputs rather than coercing it', () => {
      // `"false"` is truthy; a coerced acknowledgment would publish reports from
      // runs the operator meant to keep local.
      writeSessions({ ...SESSION_A, research: { publication: { allowUntrustedInputs: 'false' } } });
      expectInvalidEntry(/research\.publication\.allowUntrustedInputs must be a boolean/);
    });

    test('rejects research.publication.maxChars that is not a positive integer', () => {
      writeSessions({ ...SESSION_A, research: { publication: { mode: 'sanitized_summary', maxChars: 0 } } });
      expectInvalidEntry(/research\.publication\.maxChars must be a positive integer/);
    });

    test('resolved publication config is an independent copy (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, research: { publication: { mode: 'sanitized_summary', maxChars: 8000 } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.research.publication.mode = 'local_only';
      s1.research.publication.maxChars = 1;
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.research.publication).toEqual({ mode: 'sanitized_summary', maxChars: 8000 });
    });
  });

  describe('claude complexity-profile overrides (issue #748)', () => {
    test('claude is undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.claude).toBeUndefined();
    });

    test('accepts a claude.complexityProfiles.xhigh model override', async () => {
      writeSessions({ ...SESSION_A, claude: { complexityProfiles: { xhigh: { model: 'claude-fable-5' } } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.claude).toEqual({ complexityProfiles: { xhigh: { model: 'claude-fable-5' } } });
    });

    test('accepts overrides for multiple tiers and fields', async () => {
      writeSessions({
        ...SESSION_A,
        claude: {
          complexityProfiles: {
            xhigh: { model: 'claude-fable-5', effort: 'high', budget: '25' },
            low: { model: 'haiku' },
          },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.claude.complexityProfiles).toEqual({
        xhigh: { model: 'claude-fable-5', effort: 'high', budget: '25' },
        low: { model: 'haiku' },
      });
    });

    test('accepts claude block with no complexityProfiles key', async () => {
      writeSessions({ ...SESSION_A, claude: {} });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.claude).toEqual({});
    });

    test('rejects claude.complexityProfiles.xhigh.model that is an empty string', () => {
      writeSessions({ ...SESSION_A, claude: { complexityProfiles: { xhigh: { model: '' } } } });
      expectInvalidEntry(/claude\.complexityProfiles\.xhigh\.model must be a non-empty string/);
    });

    test('rejects claude.complexityProfiles.xhigh that is not an object', () => {
      writeSessions({ ...SESSION_A, claude: { complexityProfiles: { xhigh: 'fable' } } });
      expectInvalidEntry(/claude\.complexityProfiles\.xhigh must be an object/);
    });

    test('rejects claude that is not an object', () => {
      writeSessions({ ...SESSION_A, claude: 'fable' });
      expectInvalidEntry(/claude must be an object/);
    });

    test('resolved claude config is an independent copy (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, claude: { complexityProfiles: { xhigh: { model: 'claude-fable-5' } } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.claude.complexityProfiles.xhigh.model = 'mutated';
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.claude.complexityProfiles.xhigh.model).toBe('claude-fable-5');
    });
  });

  describe('provider configuration', () => {
    test('defaults to GitHub Issues + GitHub via gh when no provider config is present', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');

      expect(session.workItemProvider).toEqual({ provider: 'github-issues', auth: { mode: 'gh' } });
      expect(session.repoHostProvider).toEqual({ provider: 'github', auth: { mode: 'gh' } });
      // An omitted repoHostProvider must report as not operator-configured so
      // outbox dispatch keeps repo-host rows on the work-item runner (single-auth).
      expect(session.repoHostProviderConfigured).toBe(false);
    });

    test('parses explicit gh provider config', async () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
        repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');

      expect(session.workItemProvider).toEqual({ provider: 'github-issues', auth: { mode: 'gh' } });
      expect(session.repoHostProvider).toEqual({ provider: 'github', auth: { mode: 'gh' } });
      // An EXPLICIT repoHostProvider must report as operator-configured even though
      // its value is byte-identical to the registry default — this is the bit a
      // value-only comparison cannot recover, and what lets outbox dispatch route
      // repo-host rows under the operator `gh` identity in a split-auth session.
      expect(session.repoHostProviderConfigured).toBe(true);
    });

    test('parses GitHub App auth referencing secrets by env var name', async () => {
      const auth = {
        mode: 'github-app',
        appIdEnv: 'N8N_AI_GITHUB_APP_ID',
        installationIdEnv: 'N8N_AI_GITHUB_INSTALLATION_ID',
        privateKeyPathEnv: 'N8N_AI_GITHUB_APP_PRIVATE_KEY_PATH',
      };
      writeSessions({
        ...SESSION_A,
        workItemProvider: { provider: 'github-issues', auth },
        repoHostProvider: { provider: 'github', auth },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');

      expect(session.workItemProvider.auth).toEqual(auth);
      expect(session.repoHostProvider.auth).toEqual(auth);
    });

    test('rejects GitHub App auth referencing secrets by credential key (no resolver yet)', () => {
      const auth = {
        mode: 'github-app',
        appIdKey: 'n8n-ai/github/app-id',
        installationIdKey: 'n8n-ai/github/installation-id',
        privateKeyPathKey: 'n8n-ai/github/private-key-path',
      };
      writeSessions({
        ...SESSION_A,
        workItemProvider: { provider: 'github-issues', auth },
        repoHostProvider: { provider: 'github', auth },
      });
      // `*Key` references are not yet wired to a runtime resolver for github-app
      // auth, so the validator rejects them in favor of the `*Env` form.
      expectInvalidEntry(/appIdKey is not supported yet/);
    });

    test('parses api-token auth referencing secrets by credential key', async () => {
      const auth = {
        mode: 'api-token',
        tokenKey: 'n8n-ai/jira/api-token',
        emailEnv: 'N8N_AI_JIRA_EMAIL',
      };
      writeSessions({
        ...SESSION_A,
        workItemProvider: { provider: 'jira', auth },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');

      expect(session.workItemProvider.auth).toEqual(auth);
    });

    test('rejects referencing the same secret by both env and key', () => {
      // Uses api-token, whose `*Key` form is still accepted, to exercise the
      // mutual-exclusivity check (github-app rejects `*Key` outright).
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'jira',
          auth: {
            mode: 'api-token',
            tokenEnv: 'JIRA_TOKEN',
            tokenKey: 'n8n-ai/jira/api-token',
          },
        },
      });
      expectInvalidEntry(/tokenEnv and .*tokenKey are mutually exclusive/);
    });

    test('rejects credential key that is not a valid reference', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'jira',
          auth: {
            mode: 'api-token',
            tokenKey: 'has spaces',
          },
        },
      });
      expectInvalidEntry(/tokenKey must be a credential key reference/);
    });

    test('parses a gitea-issues work-item provider with non-secret connection config', async () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: {
            baseUrl: 'https://gitea.example.com',
            owner: 'acme',
            repo: 'acme-private',
            apiPath: '/api/v1',
            labelMapping: 'labels',
          },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');

      expect(session.workItemProvider).toEqual({
        provider: 'gitea-issues',
        gitea: {
          baseUrl: 'https://gitea.example.com',
          owner: 'acme',
          repo: 'acme-private',
          apiPath: '/api/v1',
          labelMapping: 'labels',
        },
        auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
      });
    });

    test('parses a minimal gitea-issues provider, omitting optional fields', async () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'acme-private' },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');

      expect(session.workItemProvider.gitea).toEqual({
        baseUrl: 'https://gitea.example.com',
        owner: 'acme',
        repo: 'acme-private',
      });
    });

    test('rejects a gitea-issues provider that references the token by credential key', () => {
      // The `tokenKey` credential-key form is validator-accepted for other
      // `api-token` providers (e.g. jira), but no production resolver is wired for
      // Gitea, so a `tokenKey` session would validate yet fail at intake /
      // dependency-check / outbox-dispatch time. The validator rejects it for
      // gitea-issues (mirroring the github-app `*Key` rejection) until a resolver
      // lands. The rejection must not echo the credential-key value.
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'acme-private' },
          auth: { mode: 'api-token', tokenKey: 'n8n-ai/gitea/api-token' },
        },
      });
      const message = expectInvalidEntry(/tokenKey is not supported yet for the gitea-issues provider/);
      expect(message).not.toMatch(/n8n-ai\/gitea\/api-token/);
    });

    test('gitea config is an independent copy (no aliasing)', async () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'acme-private' },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.workItemProvider.gitea.owner = 'mutated';
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.workItemProvider.gitea.owner).toBe('acme');
    });

    test('rejects a gitea-issues provider missing the gitea block', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      expectInvalidEntry(/gitea is required for the gitea-issues provider/);
    });

    test('rejects a gitea-issues provider that does not use api-token auth', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'acme-private' },
          auth: { mode: 'gh' },
        },
      });
      expectInvalidEntry(/auth\.mode must be "api-token" for the gitea-issues provider/);
    });

    test('rejects a gitea block on a non-gitea provider', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'github-issues',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'acme-private' },
          auth: { mode: 'gh' },
        },
      });
      expectInvalidEntry(/gitea is only valid for the gitea-issues provider/);
    });

    test('rejects a raw token inlined in gitea-issues auth', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'acme-private' },
          auth: { mode: 'api-token', token: 'g1tea-r4w-t0ken' },
        },
      });
      // The raw key is rejected, and the error must not echo the token value.
      const message = expectInvalidEntry(/token must not be set/);
      expect(message).not.toMatch(/g1tea-r4w-t0ken/);
    });

    test('rejects a gitea baseUrl that embeds credentials without echoing them', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: {
            baseUrl: 'https://bob:s3cr3t-p4ss@gitea.example.com',
            owner: 'acme',
            repo: 'acme-private',
          },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      const message = expectInvalidEntry(/must not embed credentials/);
      expect(message).not.toMatch(/s3cr3t-p4ss/);
    });

    test('rejects a gitea baseUrl that is not an http(s) URL', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: { baseUrl: 'ftp://gitea.example.com', owner: 'acme', repo: 'acme-private' },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      expectInvalidEntry(/baseUrl must be an http\(s\) URL/);
    });

    test('rejects a gitea apiPath that is not an absolute path', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: {
            baseUrl: 'https://gitea.example.com',
            owner: 'acme',
            repo: 'acme-private',
            apiPath: 'api/v1',
          },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      expectInvalidEntry(/apiPath must be an absolute path/);
    });

    test('rejects an unknown gitea labelMapping strategy', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: {
          provider: 'gitea-issues',
          gitea: {
            baseUrl: 'https://gitea.example.com',
            owner: 'acme',
            repo: 'acme-private',
            labelMapping: 'native-status',
          },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      expectInvalidEntry(/labelMapping must be one of/);
    });

    test('parses a gitea repo-host provider with non-secret connection config', async () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'gitea',
          gitea: {
            baseUrl: 'https://gitea.example.com',
            owner: 'acme',
            repo: 'code',
            apiPath: '/api/v1',
          },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');

      expect(session.repoHostProvider).toEqual({
        provider: 'gitea',
        gitea: {
          baseUrl: 'https://gitea.example.com',
          owner: 'acme',
          repo: 'code',
          apiPath: '/api/v1',
        },
        auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
      });
      // An explicit repoHostProvider must report as operator-configured.
      expect(session.repoHostProviderConfigured).toBe(true);
    });

    test('parses a minimal gitea repo-host provider, omitting optional fields', async () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'gitea',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');

      expect(session.repoHostProvider.gitea).toEqual({
        baseUrl: 'https://gitea.example.com',
        owner: 'acme',
        repo: 'code',
      });
    });

    test('rejects a gitea repo-host provider that references the API token by credential key', () => {
      // The production CLI/handler paths build `defaultGiteaClientBuilder()` with
      // no credential-key resolver, so a `tokenKey` reference would validate and
      // then fail at runtime with "no credential-key resolver configured". The
      // validator rejects it up front, mirroring the GitHub App `*Key` path.
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'gitea',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' },
          auth: { mode: 'api-token', tokenKey: 'n8n-ai/gitea/api-token' },
        },
      });
      expectInvalidEntry(/tokenKey is not supported yet/);
    });

    test('gitea repo-host config is an independent copy (no aliasing)', async () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'gitea',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.repoHostProvider.gitea.owner = 'mutated';
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.repoHostProvider.gitea.owner).toBe('acme');
    });

    test('rejects a gitea repo-host provider missing the gitea block', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'gitea',
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      expectInvalidEntry(/gitea is required for the gitea provider/);
    });

    test('rejects a gitea repo-host provider that does not use api-token auth', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'gitea',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' },
          auth: { mode: 'gh' },
        },
      });
      expectInvalidEntry(/auth\.mode must be "api-token" for the gitea provider/);
    });

    test('rejects a gitea block on a non-gitea repo-host provider', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'github',
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' },
          auth: { mode: 'gh' },
        },
      });
      expectInvalidEntry(/gitea is only valid for the gitea provider/);
    });

    test('rejects a gitea repo-host baseUrl that embeds credentials without echoing them', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'gitea',
          gitea: {
            baseUrl: 'https://bob:s3cr3t-p4ss@gitea.example.com',
            owner: 'acme',
            repo: 'code',
          },
          auth: { mode: 'api-token', tokenEnv: 'N8N_AI_GITEA_API_TOKEN' },
        },
      });
      const message = expectInvalidEntry(/must not embed credentials/);
      expect(message).not.toMatch(/s3cr3t-p4ss/);
    });

    test('rejects GitHub App auth that references a secret by credential key', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'github',
          auth: {
            mode: 'github-app',
            appIdEnv: 'APP_ID',
            installationIdKey: 'n8n-ai/github/installation-id',
            privateKeyPathEnv: 'KEY_PATH',
          },
        },
      });
      expectInvalidEntry(/installationIdKey is not supported yet/);
    });

    test('rejects unknown work-item provider', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: { provider: 'trello', auth: { mode: 'gh' } },
      });
      expectInvalidEntry(/workItemProvider\.provider must be one of/);
    });

    test('rejects unknown repo-host provider', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: { provider: 'gitlab', auth: { mode: 'gh' } },
      });
      expectInvalidEntry(/repoHostProvider\.provider must be one of/);
    });

    test('rejects unknown auth mode', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: { provider: 'github-issues', auth: { mode: 'oauth' } },
      });
      expectInvalidEntry(/auth\.mode must be one of/);
    });

    test('rejects github-app auth missing required env fields', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: { provider: 'github', auth: { mode: 'github-app', appIdEnv: 'APP_ID' } },
      });
      expectInvalidEntry(/installationIdEnv/);
    });

    test('rejects inlined raw secret material in auth', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'github',
          auth: {
            mode: 'github-app',
            appIdEnv: 'APP_ID',
            installationIdEnv: 'INSTALL_ID',
            privateKeyPathEnv: 'KEY_PATH',
            privateKey: '-----BEGIN PRIVATE KEY-----',
          },
        },
      });
      expectInvalidEntry(/privateKey must not be set/);
    });

    test('rejects env field that is not a valid environment variable name', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: {
          provider: 'github',
          auth: {
            mode: 'github-app',
            appIdEnv: 'has spaces',
            installationIdEnv: 'INSTALL_ID',
            privateKeyPathEnv: 'KEY_PATH',
          },
        },
      });
      expectInvalidEntry(/appIdEnv must be an environment variable name/);
    });

    test('provider config is an independent copy (no aliasing)', async () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.repoHostProvider.auth.mode = 'github-app';
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.repoHostProvider.auth.mode).toBe('gh');
    });
  });

  // -------------------------------------------------------------------------
  // Short session references: sessionNo + aliases + resolver
  // -------------------------------------------------------------------------

  describe('session references', () => {
    const A = { ...SESSION_A, sessionId: 'thunderbird-auth-results', sessionNo: 2, aliases: ['addon', 'tar'] };
    const B = { ...SESSION_B, sessionId: 'workflow-dev', sessionNo: 1, aliases: ['wf'] };

    test('parses and exposes optional sessionNo and aliases', async () => {
      writeSessions(A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('thunderbird-auth-results');
      expect(session.sessionNo).toBe(2);
      expect(session.aliases).toEqual(['addon', 'tar']);
    });

    test('sessionNo and aliases are undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.sessionNo).toBeUndefined();
      expect(session.aliases).toBeUndefined();
    });

    test('resolveSessionRef resolves an exact sessionId', async () => {
      writeSessions(A, B);
      const registry = new JsonSessionRegistry(jsonPath);
      expect(await registry.resolveSessionRef('thunderbird-auth-results')).toBe('thunderbird-auth-results');
    });

    test('resolveSessionRef resolves a numeric sessionNo', async () => {
      writeSessions(A, B);
      const registry = new JsonSessionRegistry(jsonPath);
      expect(await registry.resolveSessionRef('2')).toBe('thunderbird-auth-results');
      expect(await registry.resolveSessionRef('1')).toBe('workflow-dev');
    });

    test('resolveSessionRef resolves a string alias', async () => {
      writeSessions(A, B);
      const registry = new JsonSessionRegistry(jsonPath);
      expect(await registry.resolveSessionRef('addon')).toBe('thunderbird-auth-results');
      expect(await registry.resolveSessionRef('tar')).toBe('thunderbird-auth-results');
      expect(await registry.resolveSessionRef('wf')).toBe('workflow-dev');
    });

    test('resolveSessionRef fails closed on an unknown reference', async () => {
      writeSessions(A, B);
      const registry = new JsonSessionRegistry(jsonPath);
      await expect(registry.resolveSessionRef('nope')).rejects.toThrow(/Unknown session reference/);
    });

    test('standalone resolveSessionRef resolves by sessionId, sessionNo, and alias', () => {
      writeSessions(A, B);
      expect(resolveSessionRef(jsonPath, 'workflow-dev')).toBe('workflow-dev');
      expect(resolveSessionRef(jsonPath, '2')).toBe('thunderbird-auth-results');
      expect(resolveSessionRef(jsonPath, 'addon')).toBe('thunderbird-auth-results');
    });

    test('standalone resolveSessionRef throws on unknown reference', () => {
      writeSessions(A);
      expect(() => resolveSessionRef(jsonPath, 'missing')).toThrow(/Unknown session reference/);
    });

    test('rejects non-integer sessionNo', () => {
      writeSessions({ ...SESSION_A, sessionNo: 1.5 });
      expectInvalidEntry(/sessionNo must be a positive integer/);
    });

    test('rejects sessionNo less than 1', () => {
      writeSessions({ ...SESSION_A, sessionNo: 0 });
      expectInvalidEntry(/sessionNo must be a positive integer/);
    });

    test('rejects aliases that are not an array', () => {
      writeSessions({ ...SESSION_A, aliases: 'addon' });
      expectInvalidEntry(/aliases must be an array/);
    });

    test('rejects empty-string alias', () => {
      writeSessions({ ...SESSION_A, aliases: [''] });
      expectInvalidEntry(/aliases\[0\]/);
    });

    test('quarantines both entries on a duplicate sessionNo across sessions (issue #823)', () => {
      writeSessions({ ...A, sessionNo: 2, aliases: undefined }, { ...B, sessionNo: 2, aliases: undefined });
      expectAmbiguous(/Ambiguous session reference "2".*sessionNo/s);
    });

    test('quarantines both entries on a duplicate alias across sessions (issue #823)', () => {
      writeSessions({ ...A, aliases: ['dup'] }, { ...B, aliases: ['dup'] });
      expectAmbiguous(/Ambiguous session reference "dup".*alias/s);
    });

    test('quarantines both entries when an alias collides with another sessionId (issue #823)', () => {
      writeSessions(A, { ...B, aliases: ['thunderbird-auth-results'] });
      expectAmbiguous(/Ambiguous session reference "thunderbird-auth-results".*sessionId/s);
    });

    test('quarantines both entries when a numeric alias collides with another sessionNo (issue #823)', () => {
      // B.sessionNo is 1; giving A the alias "1" makes the reference "1" ambiguous.
      writeSessions({ ...A, aliases: ['1'] }, B);
      expectAmbiguous(/Ambiguous session reference "1"/);
    });

    test('an alias equal to the session\'s own sessionId is harmless', async () => {
      writeSessions({ ...A, aliases: ['thunderbird-auth-results', 'addon'] });
      const registry = new JsonSessionRegistry(jsonPath);
      expect(await registry.resolveSessionRef('thunderbird-auth-results')).toBe('thunderbird-auth-results');
      expect(await registry.resolveSessionRef('addon')).toBe('thunderbird-auth-results');
    });

    test('aliases are an independent copy (no aliasing)', async () => {
      writeSessions(A);
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('thunderbird-auth-results');
      s1.aliases.push('mutated');
      const s2 = await registry.getSessionById('thunderbird-auth-results');
      expect(s2.aliases).toEqual(['addon', 'tar']);
    });
  });

  describe('reportOnly configuration (issue #532)', () => {
    test('accepts { enabled: true } and exposes it on the resolved session', async () => {
      writeSessions({ ...SESSION_A, reportOnly: { enabled: true } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.reportOnly).toEqual({ enabled: true });
    });

    test('accepts { enabled: false } (master switch off)', async () => {
      writeSessions({ ...SESSION_A, reportOnly: { enabled: false } });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.reportOnly).toEqual({ enabled: false });
    });

    test('reportOnly is undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.reportOnly).toBeUndefined();
    });

    test('rejects a missing enabled field', () => {
      writeSessions({ ...SESSION_A, reportOnly: {} });
      expectInvalidEntry(/reportOnly.enabled must be a boolean/);
    });

    test('rejects non-boolean enabled', () => {
      writeSessions({ ...SESSION_A, reportOnly: { enabled: 'yes' } });
      expectInvalidEntry(/reportOnly.enabled must be a boolean/);
    });

    test('resolved reportOnly is an independent copy (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, reportOnly: { enabled: true } });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.reportOnly.enabled = false;
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.reportOnly).toEqual({ enabled: true });
    });
  });

  describe('audit configuration (issue #533)', () => {
    test('accepts acknowledge entries and exposes them on the resolved session', async () => {
      writeSessions({
        ...SESSION_A,
        audit: { acknowledge: { 'verification-commands': 'docs-only repo' } },
      });
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.audit).toEqual({ acknowledge: { 'verification-commands': 'docs-only repo' } });
    });

    test('audit is undefined when not configured', async () => {
      writeSessions(SESSION_A);
      const registry = new JsonSessionRegistry(jsonPath);
      const session = await registry.getSessionById('addon-dev');
      expect(session.audit).toBeUndefined();
    });

    test('rejects a blank acknowledgement reason', () => {
      // An acknowledgement exists to record WHY a finding is accepted; a blank
      // one would silently suppress the finding with no rationale.
      writeSessions({ ...SESSION_A, audit: { acknowledge: { 'verification-commands': '' } } });
      expectInvalidEntry(/audit\.acknowledge\.verification-commands must be a non-empty string/);
    });

    test('rejects a non-string acknowledgement reason', () => {
      writeSessions({ ...SESSION_A, audit: { acknowledge: { 'verification-commands': true } } });
      expectInvalidEntry(/audit\.acknowledge\.verification-commands must be a non-empty string/);
    });

    test('resolved audit block is an independent copy (no aliasing)', async () => {
      writeSessions({ ...SESSION_A, audit: { acknowledge: { 'verification-commands': 'why' } } });
      const registry = new JsonSessionRegistry(jsonPath);
      const s1 = await registry.getSessionById('addon-dev');
      s1.audit.acknowledge['verification-commands'] = 'mutated';
      const s2 = await registry.getSessionById('addon-dev');
      expect(s2.audit.acknowledge).toEqual({ 'verification-commands': 'why' });
    });
  });
});

// ---------------------------------------------------------------------------
// Registry-level isolation and diagnostics (issue #823)
//
// One malformed or ambiguous entry must not prevent the rest of the registry
// from loading. Only invalid JSON and an invalid top-level shape stay fatal.
// ---------------------------------------------------------------------------

describe('registry isolation and diagnostics (issue #823)', () => {
  test('a registry with one valid and one invalid entry still loads the valid session', async () => {
    writeSessions(SESSION_A, { ...SESSION_B, githubRepo: 'nodomain' });
    const registry = new JsonSessionRegistry(jsonPath);

    const sessions = await registry.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['addon-dev']);

    const diagnostics = registry.getDiagnostics();
    expect(diagnostics).toEqual([
      expect.objectContaining({ kind: 'invalid_entry', indices: [1], sessionIds: ['workflow-dev'] }),
    ]);
    expect(diagnostics[0].message).toMatch(/owner\/name/);
  });

  test('an entry with no usable safe identifier is quarantined with sessionIds: [undefined]', () => {
    writeSessions(SESSION_A, { repoRoot: 42 });
    const registry = new JsonSessionRegistry(jsonPath);
    const diagnostics = registry.getDiagnostics();
    expect(diagnostics).toEqual([
      expect.objectContaining({ kind: 'invalid_entry', indices: [1], sessionIds: [undefined] }),
    ]);
  });

  test('a non-object entry (e.g. a bare string) is quarantined rather than crashing the load', async () => {
    writeSessions(SESSION_A, 'not-a-session-object');
    const registry = new JsonSessionRegistry(jsonPath);
    expect((await registry.listSessions()).map((s) => s.sessionId)).toEqual(['addon-dev']);
    expect(registry.getDiagnostics()).toEqual([
      expect.objectContaining({ kind: 'invalid_entry', indices: [1], sessionIds: [undefined] }),
    ]);
  });

  test('a clean registry has no diagnostics', async () => {
    writeSessions(SESSION_A, SESSION_B);
    const registry = new JsonSessionRegistry(jsonPath);
    expect(registry.getDiagnostics()).toEqual([]);
    expect(await registry.listSessions()).toHaveLength(2);
  });

  test('getDiagnostics returns independent copies (no aliasing)', () => {
    writeSessions({ ...SESSION_A, githubRepo: 'nodomain' });
    const registry = new JsonSessionRegistry(jsonPath);
    const d1 = registry.getDiagnostics();
    d1[0].indices.push(99);
    d1[0].message = 'mutated';
    const d2 = registry.getDiagnostics();
    expect(d2[0].indices).toEqual([0]);
    expect(d2[0].message).not.toBe('mutated');
  });

  test('every collision axis (sessionId, repoKey, sessionNo, alias) quarantines both entries and excludes them from listSessions', async () => {
    const A = { ...SESSION_A, sessionId: 'thunderbird-auth-results', sessionNo: 2, aliases: ['addon'] };
    const B = { ...SESSION_B, sessionId: 'workflow-dev', sessionNo: 1, aliases: ['wf'] };

    writeSessions(A, { ...B, sessionId: A.sessionId });
    expect(await new JsonSessionRegistry(jsonPath).listSessions()).toEqual([]);

    writeSessions(A, { ...B, repoKey: A.repoKey });
    expect(await new JsonSessionRegistry(jsonPath).listSessions()).toEqual([]);

    writeSessions({ ...A, sessionNo: 2 }, { ...B, sessionNo: 2 });
    expect(await new JsonSessionRegistry(jsonPath).listSessions()).toEqual([]);

    writeSessions({ ...A, aliases: ['dup'] }, { ...B, aliases: ['dup'] });
    expect(await new JsonSessionRegistry(jsonPath).listSessions()).toEqual([]);
  });

  test('a session unrelated to a collision elsewhere in the file still loads', async () => {
    writeSessions(SESSION_A, { ...SESSION_B, sessionId: SESSION_A.sessionId }, {
      ...SESSION_B,
      sessionId: 'third-session',
      repoKey: 'third-repo',
    });
    const registry = new JsonSessionRegistry(jsonPath);
    const sessions = await registry.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['third-session']);
    const diagnostics = registry.getDiagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].kind).toBe('ambiguous_reference');
    expect([...diagnostics[0].indices].sort()).toEqual([0, 1]);
  });

  test('invalid JSON syntax is fatal to the whole registry', () => {
    writeFileSync(jsonPath, '{ not valid json', 'utf8');
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(SessionRegistryFatalError);
  });

  test('a top-level document that is not an object is fatal', () => {
    writeFileSync(jsonPath, '[]', 'utf8');
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(SessionRegistryFatalError);
  });

  test('a missing sessions array is fatal', () => {
    writeFileSync(jsonPath, JSON.stringify({ notSessions: [] }), 'utf8');
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/sessions array/);
  });

  async function resolveSessionRefError(registry, ref) {
    try {
      await registry.resolveSessionRef(ref);
      throw new Error(`expected resolveSessionRef(${JSON.stringify(ref)}) to throw`);
    } catch (err) {
      return err;
    }
  }

  test('resolveSessionRef throws SessionReferenceError with kind invalid_entry for a quarantined entry sessionId', async () => {
    writeSessions({ ...SESSION_A, githubRepo: 'nodomain' });
    const registry = new JsonSessionRegistry(jsonPath);
    const err = await resolveSessionRefError(registry, 'addon-dev');
    expect(err).toBeInstanceOf(SessionReferenceError);
    expect(err.kind).toBe('invalid_entry');
  });

  test('resolveSessionRef throws SessionReferenceError with kind ambiguous_reference for a colliding sessionId', async () => {
    writeSessions(SESSION_A, { ...SESSION_B, sessionId: SESSION_A.sessionId });
    const registry = new JsonSessionRegistry(jsonPath);
    const err = await resolveSessionRefError(registry, SESSION_A.sessionId);
    expect(err).toBeInstanceOf(SessionReferenceError);
    expect(err.kind).toBe('ambiguous_reference');
  });

  test('resolveSessionRef throws SessionReferenceError with kind ambiguous_reference for a non-colliding sessionId of an entry quarantined by a sessionNo collision', async () => {
    writeSessions({ ...SESSION_A, sessionNo: 1 }, { ...SESSION_B, sessionNo: 1 });
    const registry = new JsonSessionRegistry(jsonPath);

    const bySessionNo = await resolveSessionRefError(registry, '1');
    expect(bySessionNo.kind).toBe('ambiguous_reference');

    const byA = await resolveSessionRefError(registry, SESSION_A.sessionId);
    expect(byA.kind).toBe('ambiguous_reference');

    const byB = await resolveSessionRefError(registry, SESSION_B.sessionId);
    expect(byB.kind).toBe('ambiguous_reference');
  });

  test('resolveSessionRef throws SessionReferenceError with kind unknown_reference for a reference matching nothing', async () => {
    writeSessions(SESSION_A);
    const registry = new JsonSessionRegistry(jsonPath);
    const err = await resolveSessionRefError(registry, 'nope');
    expect(err).toBeInstanceOf(SessionReferenceError);
    expect(err.kind).toBe('unknown_reference');
  });

  test('standalone resolveSessionRef also throws SessionReferenceError with a diagnostic kind', () => {
    writeSessions({ ...SESSION_A, githubRepo: 'nodomain' });
    expect(() => resolveSessionRef(jsonPath, 'addon-dev')).toThrow(SessionReferenceError);
    try {
      resolveSessionRef(jsonPath, 'addon-dev');
      throw new Error('expected resolveSessionRef to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReferenceError);
      expect(err.kind).toBe('invalid_entry');
    }
  });

  test('getSessionById returns undefined (not a throw) for a quarantined invalid entry', async () => {
    writeSessions({ ...SESSION_A, githubRepo: 'nodomain' });
    const registry = new JsonSessionRegistry(jsonPath);
    expect(await registry.getSessionById('addon-dev')).toBeUndefined();
  });

  test('getSessionByRepoKey returns undefined for both entries in a repoKey collision', async () => {
    writeSessions(SESSION_A, { ...SESSION_B, repoKey: SESSION_A.repoKey });
    const registry = new JsonSessionRegistry(jsonPath);
    expect(await registry.getSessionByRepoKey(SESSION_A.repoKey)).toBeUndefined();
  });
});
