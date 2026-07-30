/**
 * Unit tests for provider-owned structured agent failure diagnostics
 * (issue #671, see docs/phase-contracts.md "Agent Diagnostic Provenance and
 * Retry Classification").
 *
 * The core guarantee under test: automatic retry classification consumes
 * only a bounded, provider-owned `AgentFailureDiagnostic` — raw stdout,
 * including an exact provider quota/capacity message quoted inside a
 * transcript, must never become trusted just because the text matches.
 */
import {
  extractClaudeDiagnostic,
  extractCodexDiagnostic,
  extractGeminiDiagnostic,
  extractAgentFailureDiagnostic,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  classifyQuotaExhaustion,
} from '../dist/index.js';

const AGENTS = [
  {
    agentId: 'claude',
    extract: extractClaudeDiagnostic,
    quotaText: 'Claude usage limit reached. Your limit will reset at 5pm.',
  },
  {
    agentId: 'codex',
    extract: extractCodexDiagnostic,
    quotaText: "You've hit your usage limit. Try again later.",
  },
  {
    agentId: 'gemini',
    extract: extractGeminiDiagnostic,
    quotaText: 'Error: Resource has been exhausted (e.g. check quota).',
  },
];

describe.each(AGENTS)('$agentId failure diagnostic adapter', ({ agentId, extract, quotaText }) => {
  test('a trusted stderr diagnostic is classifiable', () => {
    const diagnostic = extract({ stdout: '', stderr: quotaText, exitCode: 1 });
    expect(diagnostic).toBeDefined();
    expect(diagnostic.source).toBe('stderr');
    expect(diagnostic.agentId).toBe(agentId);
    expect(classifyQuotaExhaustion(diagnostic).isQuotaExhaustion).toBe(true);
  });

  test('an exact provider quota message quoted only in stdout (transcript) is NOT trusted', () => {
    // The agent's own transcript can quote the identical provider phrase
    // (e.g. explaining a prior failure, or a reviewed diff/log excerpt) while
    // the process itself did not actually fail with that diagnostic on
    // stderr. Text-only matching cannot tell these apart, so stdout must
    // never be read for classification at all.
    const diagnostic = extract({
      stdout: `The previous run failed with: "${quotaText}" — retrying now.`,
      stderr: '',
      exitCode: 1,
    });
    expect(diagnostic).toBeUndefined();
    expect(classifyQuotaExhaustion(diagnostic).isQuotaExhaustion).toBe(false);
  });

  test('a marker-prefixed line in stdout alone establishes no provenance', () => {
    // `ERROR:`/`fatal:`/`panic:` prefixes are formatting conventions an agent
    // can write or quote just as easily as a CLI can emit — not proof of
    // origin (docs/phase-contracts.md).
    const diagnostic = extract({ stdout: `ERROR: ${quotaText}`, stderr: '', exitCode: 1 });
    expect(diagnostic).toBeUndefined();
  });

  test('ambiguous markerless stdout produces no trusted retry classification', () => {
    const diagnostic = extract({ stdout: quotaText, stderr: '', exitCode: 1 });
    expect(diagnostic).toBeUndefined();
    expect(classifyQuotaExhaustion(diagnostic).category).toBe('ordinary_failure');
  });

  test('a trusted stderr diagnostic with no quota-shaped signal classifies as ordinary_failure', () => {
    const diagnostic = extract({ stdout: '', stderr: 'TypeError: cannot read property foo of undefined', exitCode: 1 });
    expect(diagnostic).toBeDefined();
    const result = classifyQuotaExhaustion(diagnostic);
    expect(result.isQuotaExhaustion).toBe(false);
    expect(result.category).toBe('ordinary_failure');
  });

  test('extractAgentFailureDiagnostic dispatches to the same adapter by agentId', () => {
    const diagnostic = extractAgentFailureDiagnostic(agentId, { stdout: '', stderr: quotaText, exitCode: 1 });
    expect(diagnostic.agentId).toBe(agentId);
    expect(classifyQuotaExhaustion(diagnostic).isQuotaExhaustion).toBe(true);
  });
});

describe('bounded diagnostic retention (issue #671)', () => {
  test('stderr diagnostic text is bounded to MAX_DIAGNOSTIC_TEXT_LENGTH', () => {
    const huge = 'x'.repeat(MAX_DIAGNOSTIC_TEXT_LENGTH * 3) + ' usage limit reached';
    const diagnostic = extractClaudeDiagnostic({ stdout: '', stderr: huge, exitCode: 1 });
    expect(diagnostic.text.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_TEXT_LENGTH);
    // The bounded window keeps the tail, so a trailing quota signal survives.
    expect(classifyQuotaExhaustion(diagnostic).isQuotaExhaustion).toBe(true);
  });

  test('empty stderr yields no diagnostic', () => {
    expect(extractClaudeDiagnostic({ stdout: 'usage limit reached', stderr: '', exitCode: 1 })).toBeUndefined();
    expect(extractClaudeDiagnostic({ stdout: '', stderr: '   ', exitCode: 1 })).toBeUndefined();
  });
});

describe('gemini stderr is untrusted when the binary was operator-overridden (issue #672 review)', () => {
  // ANTIGRAVITY_BIN lets an operator substitute an arbitrary executable for
  // the vetted `agy` binary. That process's stderr cannot be shown to be the
  // provider CLI's own diagnostic output — it could be a wrapper script's own
  // errors, or content the wrapper relays/echoes from a subprocess/tool run —
  // so the adapter must not extend automatic-retry trust to it, even though
  // it is quota/rate-limit-shaped text on the stderr stream.
  test('cmdSource "env" withholds trust from an otherwise-quota-shaped stderr diagnostic', () => {
    const diagnostic = extractGeminiDiagnostic(
      { stdout: '', stderr: 'rate limit exceeded', exitCode: 1 },
      { cmdSource: 'env' },
    );
    expect(diagnostic).toBeUndefined();
    expect(classifyQuotaExhaustion(diagnostic).isQuotaExhaustion).toBe(false);
    expect(classifyQuotaExhaustion(diagnostic).category).toBe('ordinary_failure');
  });

  test('extractAgentFailureDiagnostic propagates cmdSource to the gemini adapter', () => {
    const diagnostic = extractAgentFailureDiagnostic(
      'gemini',
      { stdout: '', stderr: 'usage limit reached', exitCode: 1 },
      { cmdSource: 'env' },
    );
    expect(diagnostic).toBeUndefined();
  });

  test('cmdSource "cli-default" (the vetted agy binary) still trusts stderr as before', () => {
    const diagnostic = extractGeminiDiagnostic(
      { stdout: '', stderr: 'rate limit exceeded', exitCode: 1 },
      { cmdSource: 'cli-default' },
    );
    expect(diagnostic).toBeDefined();
    expect(classifyQuotaExhaustion(diagnostic).isQuotaExhaustion).toBe(true);
  });

  test('omitting options entirely (no provenance info) still trusts stderr, matching pre-existing adapters', () => {
    const diagnostic = extractGeminiDiagnostic({ stdout: '', stderr: 'rate limit exceeded', exitCode: 1 });
    expect(diagnostic).toBeDefined();
  });
});

describe('an agent with no registered adapter yields no trusted diagnostic (issue #671 review)', () => {
  // Stderr is only a trusted channel once a provider-specific adapter has
  // explicitly declared it so (docs/phase-contracts.md "Boundary"). An
  // unregistered agent id has no adapter, so it must not fall back to
  // trusting arbitrary stderr — that would reintroduce the untrusted
  // text-matching problem this module closes off for every future agent
  // profile added without a corresponding adapter.
  test('an unrecognized agentId gets no diagnostic at all, even with quota-shaped stderr', () => {
    const diagnostic = extractAgentFailureDiagnostic('some-future-agent', {
      stdout: 'rate limit exceeded',
      stderr: 'rate limit exceeded',
      exitCode: 1,
    });
    expect(diagnostic).toBeUndefined();
    expect(classifyQuotaExhaustion(diagnostic).isQuotaExhaustion).toBe(false);

    const stdoutOnly = extractAgentFailureDiagnostic('some-future-agent', {
      stdout: 'rate limit exceeded',
      stderr: '',
      exitCode: 1,
    });
    expect(stdoutOnly).toBeUndefined();
  });

  test('a missing agentId gets no diagnostic at all, even with quota-shaped stderr', () => {
    const diagnostic = extractAgentFailureDiagnostic(undefined, { stdout: '', stderr: 'usage limit reached', exitCode: 1 });
    expect(diagnostic).toBeUndefined();
    expect(classifyQuotaExhaustion(diagnostic).isQuotaExhaustion).toBe(false);
  });
});
