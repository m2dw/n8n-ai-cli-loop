import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildContextModeStatus } from '../dist/cli/context-mode-status.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let sessionsPath;

// Minimal resolved-session-shaped object. buildContextModeStatus only reads
// sessionId, defaults, codex, assignmentProfiles, and flowRules, so a plain
// object is sufficient for the pure-builder unit tests.
function session(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    ...overrides,
  };
}

// ---- Pure builder unit tests ------------------------------------------------

describe('buildContextModeStatus (pure)', () => {
  test('disabled: Codex assigned to a phase but no contextMode config', () => {
    const p = buildContextModeStatus(session(), {});
    expect(p.status).toBe('disabled');
    expect(p.codexPhases).toEqual(['review']);
    // No context-mode resolved, so the per-phase argv additions are empty.
    expect(p.phaseArgv).toEqual([
      { phase: 'review', subcommand: 'review', globalArgs: [], appendedArgs: [] },
    ]);
    const review = p.phases.find((x) => x.phase === 'review');
    expect(review.agent).toBe('codex');
    expect(review.supportsContextMode).toBe(true);
    const impl = p.phases.find((x) => x.phase === 'implementation');
    expect(impl.contextMode).toBe('n/a');
    expect(p.guidance).toMatch(/context-mode is off/);
  });

  test('not_applicable: no Codex phase at all', () => {
    const p = buildContextModeStatus(
      session({ defaults: { implementationAgent: 'claude', reviewAgent: 'claude' } }),
      {},
    );
    expect(p.status).toBe('not_applicable');
    expect(p.codexPhases).toEqual([]);
    expect(p.phases.every((x) => x.contextMode === 'n/a')).toBe(true);
  });

  test('enabled: review phase places --profile before the review subcommand', () => {
    const p = buildContextModeStatus(
      session({
        codex: { contextMode: { enabled: true, config: ['context_mode=on'], profile: 'ctx' } },
      }),
      {},
    );
    expect(p.status).toBe('enabled');
    expect(p.resolution.status).toBe('enabled');
    expect(p.resolution.source).toBe('session');
    // `--profile` is a GLOBAL Codex option the review handler places BEFORE the
    // `review` subcommand (`codex --profile ctx review …`); `-c` overrides follow.
    expect(p.phaseArgv).toEqual([
      {
        phase: 'review',
        subcommand: 'review',
        globalArgs: ['--profile', 'ctx'],
        appendedArgs: ['-c', 'context_mode=on'],
      },
    ]);
    expect(p.configured).toEqual({ enabled: true, config: ['context_mode=on'], profile: 'ctx' });
  });

  test('enabled: implementation phase appends --profile after codex exec', () => {
    const p = buildContextModeStatus(
      session({
        defaults: { implementationAgent: 'codex', reviewAgent: 'claude' },
        codex: { contextMode: { enabled: true, config: ['context_mode=on'], profile: 'ctx' } },
      }),
      {},
    );
    expect(p.status).toBe('enabled');
    // The implementation handler appends `--profile`+`-c` after `codex exec`, so
    // both land in appendedArgs (no global option precedes the subcommand here).
    expect(p.phaseArgv).toEqual([
      {
        phase: 'implementation',
        subcommand: 'exec',
        globalArgs: [],
        appendedArgs: ['--profile', 'ctx', '-c', 'context_mode=on'],
      },
    ]);
  });

  test('env override off forces disabled even when session enables it', () => {
    const p = buildContextModeStatus(
      session({ codex: { contextMode: { enabled: true, config: ['context_mode=on'] } } }),
      { CODEX_CONTEXT_MODE: 'off' },
    );
    expect(p.status).toBe('disabled');
    expect(p.resolution.status).toBe('unset');
    expect(p.resolution.source).toBe('env');
    expect(p.envOverride).toBe('off');
  });

  test('invalid: CODEX_CONTEXT_MODE bogus value surfaces actionable guidance', () => {
    const p = buildContextModeStatus(session(), { CODEX_CONTEXT_MODE: 'maybe' });
    expect(p.status).toBe('invalid');
    expect(p.resolution.status).toBe('error');
    expect(p.guidance).toMatch(/Invalid CODEX_CONTEXT_MODE/);
  });

  test('invalid: env on with no configured form is an error, not a guess', () => {
    const p = buildContextModeStatus(session(), { CODEX_CONTEXT_MODE: 'on' });
    expect(p.status).toBe('invalid');
    expect(p.guidance).toMatch(/no invocation form is configured/);
  });

  test('Codex on research (Gemini-only handler) is unsupported, not context-mode-ready', () => {
    const p = buildContextModeStatus(
      session({
        defaults: { implementationAgent: 'claude', reviewAgent: 'claude', researchAgent: 'codex' },
        codex: { contextMode: { enabled: true, config: ['context_mode=on'] } },
      }),
      {},
    );
    // The research handler never runs Codex, so this must NOT flip the verdict to
    // enabled/disabled off context-mode settings.
    expect(p.status).toBe('not_applicable');
    expect(p.codexPhases).toEqual([]);
    const research = p.phases.find((x) => x.phase === 'research');
    expect(research.agent).toBe('codex');
    expect(research.supportsContextMode).toBe(false);
    expect(research.contextMode).toBe('unsupported');
    expect(p.guidance).toMatch(/Unsupported .* agent: codex/);
  });

  test('explicit unsupported conflict_resolution: codex is reported, not thrown', () => {
    // resolveAssignment fail-closes when an assignment profile explicitly sets
    // conflict_resolution to an unsupported agent (codex). The readiness command
    // must still build a payload and mark that phase unsupported (issue #399).
    const p = buildContextModeStatus(
      session({
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        assignmentProfiles: {
          code: { implementation: 'claude', review: 'codex', conflict_resolution: 'codex' },
        },
      }),
      {},
    );
    expect(p.ok).toBe(true);
    const conflict = p.phases.find((x) => x.phase === 'conflict_resolution');
    expect(conflict.agent).toBe('codex');
    expect(conflict.supportsContextMode).toBe(false);
    expect(conflict.contextMode).toBe('unsupported');
    // The unsupported phase is not a Codex-capable phase, so it never appears here.
    expect(p.codexPhases).toEqual(['review']);
    // The verdict still reflects the review phase (off, no config) ...
    expect(p.status).toBe('disabled');
    // ... and the guidance surfaces the broken conflict_resolution assignment.
    expect(p.guidance).toMatch(/conflict_resolution/);
    expect(p.guidance).toMatch(/Unsupported .* agent: codex/);
  });

  test('not_applicable but configured: warns the config will not be used', () => {
    const p = buildContextModeStatus(
      session({
        defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
        codex: { contextMode: { enabled: true, config: ['context_mode=on'] } },
      }),
      {},
    );
    expect(p.status).toBe('not_applicable');
    expect(p.guidance).toMatch(/no assigned agent .* is Codex/);
  });
});

// ---- CLI integration --------------------------------------------------------

function writeSessions(extra = {}) {
  const sessions = {
    sessions: [
      {
        sessionId: 'addon-dev',
        repoKey: 'test-repo',
        repoRoot: join(tmpDir, 'repo'),
        githubRepo: 'm2dw/test-repo',
        artifactDir: '.n8n-artifacts',
        baseBranch: 'main',
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        verification: { test: 'true' },
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        ...extra,
      },
    ],
  };
  writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-ctxmode-test-'));
  sessionsPath = join(tmpDir, 'sessions.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin context-mode status (CLI)', () => {
  test('--json emits a stable disabled payload for an unconfigured Codex phase', () => {
    writeSessions();
    const r = run(['context-mode', 'status', '--json', '--session-id', 'addon-dev', '--sessions-path', sessionsPath]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.sessionId).toBe('addon-dev');
    expect(payload.status).toBe('disabled');
    expect(payload.codexPhases).toEqual(['review']);
  });

  test('--json reports enabled with exact argv when configured', () => {
    writeSessions({ codex: { contextMode: { enabled: true, config: ['context_mode=on'] } } });
    const r = run(['context-mode', 'status', '--json', '--session-id', 'addon-dev', '--sessions-path', sessionsPath]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.status).toBe('enabled');
    expect(payload.phaseArgv).toEqual([
      { phase: 'review', subcommand: 'review', globalArgs: [], appendedArgs: ['-c', 'context_mode=on'] },
    ]);
  });

  test('--json reports a stable payload (not {ok:false}) for unsupported conflict_resolution', () => {
    writeSessions({
      assignmentProfiles: {
        code: { implementation: 'claude', review: 'codex', conflict_resolution: 'codex' },
      },
    });
    const r = run(['context-mode', 'status', '--json', '--session-id', 'addon-dev', '--sessions-path', sessionsPath]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.ok).toBe(true);
    const conflict = payload.phases.find((x) => x.phase === 'conflict_resolution');
    expect(conflict.agent).toBe('codex');
    expect(conflict.contextMode).toBe('unsupported');
  });

  test('invalid CODEX_CONTEXT_MODE exits 0 with an invalid verdict (diagnostic, not a run)', () => {
    writeSessions();
    const r = run(
      ['context-mode', 'status', '--json', '--session-id', 'addon-dev', '--sessions-path', sessionsPath],
      { CODEX_CONTEXT_MODE: 'sometimes' },
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.status).toBe('invalid');
    expect(payload.guidance).toMatch(/Invalid CODEX_CONTEXT_MODE/);
  });

  test('human-readable output (no --json) shows the verdict and assigned agents', () => {
    writeSessions();
    const r = run(['context-mode', 'status', '--session-id', 'addon-dev', '--sessions-path', sessionsPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/status: DISABLED/);
    expect(r.stdout).toMatch(/review\s+codex/);
  });

  test('an enabled-but-empty session config is rejected at load time before a run', () => {
    writeSessions({ codex: { contextMode: { enabled: true } } });
    const r = run(['context-mode', 'status', '--json', '--session-id', 'addon-dev', '--sessions-path', sessionsPath]);
    expect(r.code).not.toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/no invocation form is configured/);
  });

  test('unknown action is rejected', () => {
    writeSessions();
    const r = run(['context-mode', 'bogus', '--session-id', 'addon-dev', '--sessions-path', sessionsPath]);
    expect(r.code).not.toBe(0);
  });
});
