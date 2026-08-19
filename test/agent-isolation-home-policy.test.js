/**
 * Unit tests for the per-provider home policy of the shared isolated no-tool
 * invocation (issue #935, src/handlers/agent-isolation.ts).
 *
 * Claude Code's subscription login is not reachable from a throwaway HOME —
 * `CLAUDE_CONFIG_DIR` pointed at the real HOME, at `$HOME/.claude`, or at a copy
 * of the visible config files all report "Not logged in" — so the anthropic
 * no-tool invocation runs with the operator's real home. That is one
 * provider-scoped relaxation with compensating controls, and these tests are
 * where "scoped" is checkable rather than merely documented:
 *
 *  - anthropic + no-tools inherits the real home, and NOTHING else changes:
 *    GitHub config dir, write tokens, cwd, cwd-bearing vars, cross-provider
 *    credential strip, and temp-dir cleanup are what they were;
 *  - anthropic + tool-capable, every other provider, and an unknown provider
 *    still get the throwaway home;
 *  - an inherit provider with no real home to inherit gets the throwaway home,
 *    never an unset one.
 *
 * See docs/agent-isolation-policy.md.
 */
import { existsSync, rmSync, statSync } from 'fs';

import {
  buildIsolatedInvocation,
  resolveHomePolicy,
} from '../dist/handlers/agent-isolation.js';

/** A caller environment that carries everything the strip is supposed to see. */
function callerEnv(overrides = {}) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/real',
    PWD: '/Users/real/checkout',
    OLDPWD: '/Users/real',
    INIT_CWD: '/Users/real/checkout',
    XDG_CONFIG_HOME: '/Users/real/.config',
    GH_TOKEN: 'gh-secret',
    GITHUB_TOKEN: 'github-secret',
    ACTIONS_RUNTIME_TOKEN: 'actions-secret',
    ANTHROPIC_API_KEY: 'anthropic-key',
    OPENAI_API_KEY: 'openai-key',
    GEMINI_API_KEY: 'gemini-key',
    ...overrides,
  };
}

/** Build an invocation and always remove its temp dirs, whatever the assertions do. */
function withInvocation(options, assertions) {
  const invocation = buildIsolatedInvocation(options.source ?? callerEnv(), {
    prefix: 'ai-isolation-test',
    provider: options.provider,
    toolPolicy: options.toolPolicy,
  });
  try {
    assertions(invocation);
  } finally {
    for (const dir of invocation.cleanup) rmSync(dir, { recursive: true, force: true });
  }
  return invocation;
}

describe('agent-isolation — the anthropic home policy', () => {
  test('a no-tools anthropic invocation runs with the caller real home', () => {
    withInvocation({ provider: 'anthropic', toolPolicy: 'no-tools' }, (inv) => {
      expect(inv.homePolicy).toBe('inherit');
      expect(inv.env.HOME).toBe('/Users/real');
    });
  });

  test('the real home does not become reachable as a GitHub credential store', () => {
    withInvocation({ provider: 'anthropic', toolPolicy: 'no-tools' }, (inv) => {
      // The control is GH_CONFIG_DIR, not a faked HOME: it is an empty temp dir
      // that exists for the run, and it is NOT the home the agent sees.
      expect(inv.env.GH_CONFIG_DIR).not.toBe('/Users/real');
      expect(inv.env.GH_CONFIG_DIR).not.toBe(inv.env.HOME);
      expect(existsSync(inv.env.GH_CONFIG_DIR)).toBe(true);
      expect(statSync(inv.env.GH_CONFIG_DIR).isDirectory()).toBe(true);
      // The secondary store path stays closed too.
      expect(inv.env.XDG_CONFIG_HOME).toBeUndefined();
      // And no token can authenticate a write regardless of where gh looks.
      expect(inv.env.GH_TOKEN).toBeUndefined();
      expect(inv.env.GITHUB_TOKEN).toBeUndefined();
      expect(inv.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
    });
  });

  test('the rest of the isolation is unchanged by the inherited home', () => {
    withInvocation({ provider: 'anthropic', toolPolicy: 'no-tools' }, (inv) => {
      // Not the checkout, and no var that names it.
      expect(inv.cwd).not.toBe('/Users/real/checkout');
      expect(inv.env.PWD).toBe(inv.cwd);
      expect(inv.env.OLDPWD).toBeUndefined();
      expect(inv.env.INIT_CWD).toBeUndefined();
      // Only the SELECTED provider's own credentials survive.
      expect(inv.env.ANTHROPIC_API_KEY).toBe('anthropic-key');
      expect(inv.env.OPENAI_API_KEY).toBeUndefined();
      expect(inv.env.GEMINI_API_KEY).toBeUndefined();
    });
  });

  test('CLAUDE_CONFIG_DIR is honored when set and never synthesized from the home', () => {
    withInvocation({ provider: 'anthropic', toolPolicy: 'no-tools' }, (inv) => {
      // The passthrough that never worked is not left behind as a misleading
      // override of a default the CLI now resolves for itself.
      expect(inv.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
    withInvocation(
      {
        provider: 'anthropic',
        toolPolicy: 'no-tools',
        source: callerEnv({ CLAUDE_CONFIG_DIR: '/Users/real/custom-claude' }),
      },
      (inv) => {
        expect(inv.env.CLAUDE_CONFIG_DIR).toBe('/Users/real/custom-claude');
      },
    );
  });

  test('both temp dirs are still the caller cleanup, and the real home is not', () => {
    const inv = withInvocation({ provider: 'anthropic', toolPolicy: 'no-tools' }, (built) => {
      expect(built.cleanup).toHaveLength(2);
      expect(built.cleanup).toContain(built.cwd);
      expect(built.cleanup).toContain(built.env.GH_CONFIG_DIR);
      expect(built.cleanup).not.toContain('/Users/real');
      expect(built.cleanup).not.toContain(built.env.HOME);
      for (const dir of built.cleanup) expect(existsSync(dir)).toBe(true);
    });
    for (const dir of inv.cleanup) expect(existsSync(dir)).toBe(false);
  });

  test('an inherit provider with no home to inherit gets the throwaway home', () => {
    // Fail closed rather than hand the CLI an unset HOME, which some tools
    // resolve to `/` or to the process owner passwd entry — a directory nobody
    // chose. A genuinely logged-out claude then fails as it should.
    const source = callerEnv();
    delete source.HOME;
    withInvocation({ provider: 'anthropic', toolPolicy: 'no-tools', source }, (inv) => {
      expect(inv.env.HOME).toBe(inv.env.GH_CONFIG_DIR);
      expect(existsSync(inv.env.HOME)).toBe(true);
    });
  });
});

describe('agent-isolation — the boundaries the policy does not move', () => {
  test('a tool-capable anthropic invocation still gets a throwaway home', () => {
    // The compensating controls are properties of the no-tools argv (empty tool
    // set, --strict-mcp-config, --safe-mode, --no-session-persistence). Without
    // them there is nothing to stop the operator own hooks and MCP servers, so
    // the relaxation does not apply.
    withInvocation({ provider: 'anthropic', toolPolicy: 'tool-capable' }, (inv) => {
      expect(inv.homePolicy).toBe('throwaway');
      expect(inv.env.HOME).not.toBe('/Users/real');
      expect(inv.env.GH_CONFIG_DIR).toBe(inv.env.HOME);
    });
  });

  test('openai isolation is unchanged, including its CODEX_HOME passthrough', () => {
    withInvocation({ provider: 'openai', toolPolicy: 'no-tools' }, (inv) => {
      expect(inv.homePolicy).toBe('throwaway');
      expect(inv.env.HOME).not.toBe('/Users/real');
      expect(inv.env.GH_CONFIG_DIR).toBe(inv.env.HOME);
      // A hidden home is what needs its config dir named back.
      expect(inv.env.CODEX_HOME).toBe('/Users/real');
      expect(inv.env.OPENAI_API_KEY).toBe('openai-key');
      expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });

  test('a provider with no config dir key keeps its own credentials and a throwaway home', () => {
    withInvocation({ provider: 'google', toolPolicy: 'no-tools' }, (inv) => {
      expect(inv.homePolicy).toBe('throwaway');
      expect(inv.env.HOME).not.toBe('/Users/real');
      expect(inv.env.GEMINI_API_KEY).toBe('gemini-key');
      expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });

  test('an unknown or prototype-shaped provider carries nothing and inherits nothing', () => {
    for (const provider of ['mystery', 'constructor', 'toString']) {
      withInvocation({ provider, toolPolicy: 'no-tools' }, (inv) => {
        expect(inv.homePolicy).toBe('throwaway');
        expect(inv.env.HOME).not.toBe('/Users/real');
        expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(inv.env.OPENAI_API_KEY).toBeUndefined();
        expect(inv.env.GEMINI_API_KEY).toBeUndefined();
        expect(inv.env.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(inv.env.CODEX_HOME).toBeUndefined();
      });
    }
  });
});

describe('agent-isolation — resolveHomePolicy', () => {
  test('states the policy without building an invocation', () => {
    expect(resolveHomePolicy('anthropic', 'no-tools')).toBe('inherit');
    expect(resolveHomePolicy('anthropic', 'tool-capable')).toBe('throwaway');
    expect(resolveHomePolicy('openai', 'no-tools')).toBe('throwaway');
    expect(resolveHomePolicy('google', 'no-tools')).toBe('throwaway');
    expect(resolveHomePolicy('mystery', 'no-tools')).toBe('throwaway');
    expect(resolveHomePolicy('constructor', 'no-tools')).toBe('throwaway');
  });
});
