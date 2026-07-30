import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonSessionRegistry, resolveSessionRef } from '../dist/index.js';

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
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/worktrees\.enabled is no longer supported/);
  });

  test('rejects legacy worktrees.enabled: true too', () => {
    writeSessions({ ...SESSION_A, worktrees: { enabled: true, root: '/custom/worktree/root' } });
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/worktrees\.enabled is no longer supported/);
  });

  test('rejects relative repoRoot', () => {
    writeSessions({ ...SESSION_A, repoRoot: 'relative/path' });
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/absolute/);
  });

  test('rejects duplicate sessionId', () => {
    writeSessions(SESSION_A, { ...SESSION_B, sessionId: SESSION_A.sessionId });
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/Duplicate sessionId/);
  });

  test('rejects duplicate repoKey', () => {
    writeSessions(SESSION_A, { ...SESSION_B, repoKey: SESSION_A.repoKey });
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/Duplicate repoKey/);
  });

  test('rejects missing sessions.json with explicit error', () => {
    expect(() => new JsonSessionRegistry(join(tmpDir, 'nonexistent.json'))).toThrow(
      /does not exist/,
    );
  });

  test('rejects githubRepo not in owner/name format', () => {
    writeSessions({ ...SESSION_A, githubRepo: 'nodomain' });
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/owner\/name/);
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
    expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/baseBranch/);
  });

  test('listSessions returns independent copies (no aliasing)', async () => {
    writeSessions(SESSION_A);
    const registry = new JsonSessionRegistry(jsonPath);
    const [s1] = await registry.listSessions();
    s1.defaults.implementationAgent = 'gemini';
    const [s2] = await registry.listSessions();
    expect(s2.defaults.implementationAgent).toBe('claude');
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/triggerPaths\[0\] must be a non-empty string/);
    });

    test('rejects non-boolean enabled', () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, enabled: 'yes' } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/dependencySync.enabled must be a boolean/);
    });

    test('rejects empty triggerPaths', () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, triggerPaths: [] } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/triggerPaths must be a non-empty array/);
    });

    test('rejects missing command', () => {
      const { command, ...withoutCommand } = DEP_SYNC;
      writeSessions({ ...SESSION_A, dependencySync: withoutCommand });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/dependencySync.command must be a non-empty string/);
    });

    test('rejects non-integer timeoutMs', () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, timeoutMs: 0 } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/timeoutMs must be a positive integer/);
    });

    test('rejects non-string entries in expectedOutputs', () => {
      writeSessions({ ...SESSION_A, dependencySync: { ...DEP_SYNC, expectedOutputs: [123] } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/expectedOutputs\[0\] must be a non-empty string/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/cacheKeyFiles\[0\] must be a non-empty string/);
    });

    test('rejects non-boolean enabled', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, enabled: 'yes' } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/environmentPrepare.enabled must be a boolean/);
    });

    test('rejects missing command when enabled', () => {
      const { command, ...withoutCommand } = ENV_PREPARE;
      writeSessions({ ...SESSION_A, environmentPrepare: withoutCommand });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/environmentPrepare.command must be a non-empty string/);
    });

    test('rejects non-boolean allowLifecycleScripts', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, allowLifecycleScripts: 'yes' } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/allowLifecycleScripts must be a boolean/);
    });

    test('rejects non-integer timeoutMs', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, timeoutMs: 0 } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/timeoutMs must be a positive integer/);
    });

    test('rejects non-string entries in cacheKeyFiles', () => {
      writeSessions({ ...SESSION_A, environmentPrepare: { ...ENV_PREPARE, cacheKeyFiles: [123] } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/cacheKeyFiles\[0\] must be a non-empty string/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/contextMode.enabled must be a boolean/);
    });

    test('rejects enabled block with no invocation form', () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: true } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/no invocation form is configured/);
    });

    test('rejects a config entry that is not key=value', () => {
      writeSessions({ ...SESSION_A, codex: { contextMode: { enabled: true, config: ['bogus'] } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/config\[0\] must be a key=value override/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/model must be a non-empty string/);
    });

    test('rejects an empty-string model', () => {
      writeSessions({ ...SESSION_A, codex: { model: '   ' } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/model must be a non-empty string/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research\.antigravity\.model must be a non-empty string/);
    });

    test('rejects research.antigravity.model that is not a string', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: { model: 42 } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research\.antigravity\.model must be a non-empty string/);
    });

    test('rejects research.antigravity that is not an object', () => {
      writeSessions({ ...SESSION_A, research: { antigravity: 'Gemini 3.1 Pro (Low)' } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research\.antigravity must be an object/);
    });

    test('rejects research that is not an object', () => {
      writeSessions({ ...SESSION_A, research: 'Gemini 3.1 Pro (Low)' });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research must be an object/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research\.evidence must be an object/);
    });

    test('rejects research.evidence.enabled that is not a boolean', () => {
      writeSessions({ ...SESSION_A, research: { evidence: { enabled: 'yes' } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research\.evidence\.enabled must be a boolean/);
    });

    test('rejects research.evidence.denyGlobs that is not an array of strings', () => {
      writeSessions({ ...SESSION_A, research: { evidence: { denyGlobs: 'secrets/**' } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research\.evidence\.denyGlobs must be an array of strings/);
    });

    test('rejects research.evidence.generatedGlobs entries that are not strings', () => {
      writeSessions({ ...SESSION_A, research: { evidence: { generatedGlobs: [42] } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research\.evidence\.generatedGlobs\[0\] must be a non-empty string/);
    });

    test('rejects research.evidence.maxTurns that is not a positive integer', () => {
      writeSessions({ ...SESSION_A, research: { evidence: { maxTurns: 0 } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/research\.evidence\.maxTurns must be a positive integer/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/claude\.complexityProfiles\.xhigh\.model must be a non-empty string/);
    });

    test('rejects claude.complexityProfiles.xhigh that is not an object', () => {
      writeSessions({ ...SESSION_A, claude: { complexityProfiles: { xhigh: 'fable' } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/claude\.complexityProfiles\.xhigh must be an object/);
    });

    test('rejects claude that is not an object', () => {
      writeSessions({ ...SESSION_A, claude: 'fable' });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/claude must be an object/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/appIdKey is not supported yet/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/tokenEnv and .*tokenKey are mutually exclusive/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/tokenKey must be a credential key reference/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /tokenKey is not supported yet for the gitea-issues provider/,
      );
      expect(() => new JsonSessionRegistry(jsonPath)).not.toThrow(/n8n-ai\/gitea\/api-token/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /gitea is required for the gitea-issues provider/,
      );
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /auth\.mode must be "api-token" for the gitea-issues provider/,
      );
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /gitea is only valid for the gitea-issues provider/,
      );
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
      let message = '';
      try {
        new JsonSessionRegistry(jsonPath);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/token must not be set/);
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
      let message = '';
      try {
        new JsonSessionRegistry(jsonPath);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/must not embed credentials/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/baseUrl must be an http\(s\) URL/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/apiPath must be an absolute path/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/labelMapping must be one of/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/tokenKey is not supported yet/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /gitea is required for the gitea provider/,
      );
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /auth\.mode must be "api-token" for the gitea provider/,
      );
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /gitea is only valid for the gitea provider/,
      );
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
      let message = '';
      try {
        new JsonSessionRegistry(jsonPath);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/must not embed credentials/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/installationIdKey is not supported yet/);
    });

    test('rejects unknown work-item provider', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: { provider: 'trello', auth: { mode: 'gh' } },
      });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/workItemProvider\.provider must be one of/);
    });

    test('rejects unknown repo-host provider', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: { provider: 'gitlab', auth: { mode: 'gh' } },
      });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/repoHostProvider\.provider must be one of/);
    });

    test('rejects unknown auth mode', () => {
      writeSessions({
        ...SESSION_A,
        workItemProvider: { provider: 'github-issues', auth: { mode: 'oauth' } },
      });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/auth\.mode must be one of/);
    });

    test('rejects github-app auth missing required env fields', () => {
      writeSessions({
        ...SESSION_A,
        repoHostProvider: { provider: 'github', auth: { mode: 'github-app', appIdEnv: 'APP_ID' } },
      });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/installationIdEnv/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/privateKey must not be set/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/appIdEnv must be an environment variable name/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/sessionNo must be a positive integer/);
    });

    test('rejects sessionNo less than 1', () => {
      writeSessions({ ...SESSION_A, sessionNo: 0 });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/sessionNo must be a positive integer/);
    });

    test('rejects aliases that are not an array', () => {
      writeSessions({ ...SESSION_A, aliases: 'addon' });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/aliases must be an array/);
    });

    test('rejects empty-string alias', () => {
      writeSessions({ ...SESSION_A, aliases: [''] });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/aliases\[0\]/);
    });

    test('rejects duplicate sessionNo across sessions', () => {
      writeSessions({ ...A, sessionNo: 2, aliases: undefined }, { ...B, sessionNo: 2, aliases: undefined });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/Ambiguous session reference "2".*sessionNo/s);
    });

    test('rejects duplicate alias across sessions', () => {
      writeSessions({ ...A, aliases: ['dup'] }, { ...B, aliases: ['dup'] });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/Ambiguous session reference "dup".*alias/s);
    });

    test('rejects an alias that collides with another sessionId', () => {
      writeSessions(A, { ...B, aliases: ['thunderbird-auth-results'] });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /Ambiguous session reference "thunderbird-auth-results".*sessionId/s,
      );
    });

    test('rejects a numeric alias that collides with another sessionNo', () => {
      // B.sessionNo is 1; giving A the alias "1" makes the reference "1" ambiguous.
      writeSessions({ ...A, aliases: ['1'] }, B);
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/Ambiguous session reference "1"/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/reportOnly.enabled must be a boolean/);
    });

    test('rejects non-boolean enabled', () => {
      writeSessions({ ...SESSION_A, reportOnly: { enabled: 'yes' } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(/reportOnly.enabled must be a boolean/);
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
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /audit\.acknowledge\.verification-commands must be a non-empty string/,
      );
    });

    test('rejects a non-string acknowledgement reason', () => {
      writeSessions({ ...SESSION_A, audit: { acknowledge: { 'verification-commands': true } } });
      expect(() => new JsonSessionRegistry(jsonPath)).toThrow(
        /audit\.acknowledge\.verification-commands must be a non-empty string/,
      );
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
