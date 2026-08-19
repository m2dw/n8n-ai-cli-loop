/**
 * Unit tests for typed CLI probe outcomes (issue #897).
 *
 * The property under test is a single distinction the pre-#897 probe could not
 * make: a command that is genuinely absent versus a host that momentarily could
 * not run it. Every case is driven from a synthetic `execFileSync` error object,
 * so none of these assertions depend on process scheduling — which is the whole
 * point, since the bug they cover only ever reproduced under host contention.
 */
import {
  CLI_PROBE_INDETERMINATE_MARKER,
  CLI_PROBE_STATUSES,
  CLI_PROBE_STUB_AGENTS,
  CLI_PROBE_STUB_ENV,
  MAX_PROBE_DETAIL_CHARS,
  TRANSIENT_SPAWN_ERROR_CODES,
  classifyProbeFailure,
  describeProbeOutcome,
  hasIndeterminateProbeSignal,
  isRetryableProbeFailure,
  parseCliProbeStub,
  probeSucceeded,
} from '../dist/core/cli-probe.js';

/** The shape `child_process` throws: status/signal/code plus captured streams. */
function spawnError({ code, status = null, signal = null, stderr = null, stdout = null, message }) {
  const err = new Error(message ?? `spawnSync claude ${code ?? 'failed'}`);
  if (code !== undefined) err.code = code;
  err.status = status;
  err.signal = signal;
  err.stderr = stderr;
  err.stdout = stdout;
  return err;
}

describe('cli-probe — status classification', () => {
  test('a successful probe is available, determinate, and carries its stdout', () => {
    expect(probeSucceeded('  claude 1.2.3\n')).toEqual({
      ok: true, status: 'available', transient: false, output: 'claude 1.2.3',
    });
  });

  test('ENOENT is the one determinate absence signal', () => {
    const outcome = classifyProbeFailure(spawnError({ code: 'ENOENT' }));
    expect(outcome).toMatchObject({ ok: false, status: 'not-found', transient: false, code: 'ENOENT' });
    // A missing executable must stay actionable — never "try again later".
    expect(isRetryableProbeFailure(outcome)).toBe(false);
  });

  test('a command that ran and exited non-zero is reported as that, not as missing', () => {
    const outcome = classifyProbeFailure(spawnError({ status: 2, stderr: 'unknown flag --version' }));
    expect(outcome).toMatchObject({
      ok: false, status: 'non-zero-exit', transient: false, exitCode: 2, output: 'unknown flag --version',
    });
  });

  test('an exit status wins over any errno riding along on the same error', () => {
    // The child RAN. Whatever `code` the error object happens to carry, calling
    // this "not found" would blame the wrong thing entirely.
    const outcome = classifyProbeFailure(spawnError({ code: 'ENOENT', status: 1, stderr: 'boom' }));
    expect(outcome.status).toBe('non-zero-exit');
    expect(outcome.transient).toBe(false);
  });

  test('a timeout is indeterminate: it describes the host, not the CLI', () => {
    const outcome = classifyProbeFailure(spawnError({ code: 'ETIMEDOUT', signal: 'SIGTERM' }));
    expect(outcome).toMatchObject({ ok: false, status: 'timeout', transient: true, code: 'ETIMEDOUT' });
  });

  test('a bare SIGTERM kill with no exit status is read as the timeout it is', () => {
    // Older `child_process` shapes surface only the signal the timeout sent.
    const outcome = classifyProbeFailure(spawnError({ signal: 'SIGTERM' }));
    expect(outcome).toMatchObject({ status: 'timeout', transient: true, code: 'ETIMEDOUT' });
  });

  test('a refused fork is a transient spawn error, and is the only retryable case', () => {
    for (const code of TRANSIENT_SPAWN_ERROR_CODES) {
      const outcome = classifyProbeFailure(spawnError({ code }));
      expect(outcome).toMatchObject({ ok: false, status: 'spawn-error', transient: true, code });
      expect(isRetryableProbeFailure(outcome)).toBe(true);
    }
    // A timeout already spent the whole time budget, so re-spending it in-process
    // would only stall the probe again.
    expect(isRetryableProbeFailure(classifyProbeFailure(spawnError({ code: 'ETIMEDOUT' })))).toBe(false);
  });

  test('a non-executable file is a spawn error but NOT a transient one', () => {
    // EACCES is a real, persistent misconfiguration; retrying it forever would
    // hide the one thing the operator has to fix.
    const outcome = classifyProbeFailure(spawnError({ code: 'EACCES' }));
    expect(outcome).toMatchObject({ status: 'spawn-error', transient: false, code: 'EACCES' });
    expect(isRetryableProbeFailure(outcome)).toBe(false);
  });

  test('an unrecognized failure is never reported as a missing CLI', () => {
    const outcome = classifyProbeFailure(new Error('something else went wrong'));
    expect(outcome.status).toBe('spawn-error');
    expect(outcome.transient).toBe(false);
    expect(outcome.output).toContain('something else went wrong');
  });

  test('diagnostic detail prefers stderr, falls back to stdout, then to the error', () => {
    expect(classifyProbeFailure(spawnError({ status: 1, stderr: 'from-stderr', stdout: 'from-stdout' })).output)
      .toBe('from-stderr');
    expect(classifyProbeFailure(spawnError({ status: 1, stderr: '   ', stdout: 'from-stdout' })).output)
      .toBe('from-stdout');
    expect(classifyProbeFailure(spawnError({ code: 'ENOENT', message: 'spawnSync claude ENOENT' })).output)
      .toContain('ENOENT');
  });

  test('diagnostic detail is bounded', () => {
    const outcome = classifyProbeFailure(spawnError({ status: 1, stderr: 'x'.repeat(5000) }));
    expect(outcome.output).toHaveLength(MAX_PROBE_DETAIL_CHARS);
  });

  test('the status set is closed and every member is distinct', () => {
    expect(new Set(CLI_PROBE_STATUSES).size).toBe(CLI_PROBE_STATUSES.length);
    expect([...CLI_PROBE_STATUSES]).toEqual([
      'available', 'not-found', 'non-zero-exit', 'timeout', 'spawn-error',
    ]);
  });
});

describe('cli-probe — operator-facing diagnostics', () => {
  test('only indeterminate outcomes carry the marker, and they say what it means', () => {
    const transient = [
      classifyProbeFailure(spawnError({ code: 'ETIMEDOUT', signal: 'SIGTERM' })),
      classifyProbeFailure(spawnError({ code: 'EAGAIN' })),
    ];
    for (const outcome of transient) {
      const text = describeProbeOutcome('claude', outcome);
      expect(hasIndeterminateProbeSignal(text)).toBe(true);
      expect(text).toMatch(/says nothing about whether claude is installed/);
    }
    const determinate = [
      classifyProbeFailure(spawnError({ code: 'ENOENT' })),
      classifyProbeFailure(spawnError({ status: 3 })),
      classifyProbeFailure(spawnError({ code: 'EACCES' })),
    ];
    for (const outcome of determinate) {
      expect(hasIndeterminateProbeSignal(describeProbeOutcome('claude', outcome))).toBe(false);
    }
  });

  test('a missing executable still reads as a missing executable', () => {
    expect(describeProbeOutcome('claude', classifyProbeFailure(spawnError({ code: 'ENOENT' }))))
      .toMatch(/claude was not found on PATH \(ENOENT\)/);
  });

  test('the marker is structural, so prose about probe transience does not trip it', () => {
    expect(hasIndeterminateProbeSignal('the cli probe was indeterminate and timed out (EAGAIN)')).toBe(false);
    expect(hasIndeterminateProbeSignal(`prefix ${CLI_PROBE_INDETERMINATE_MARKER} suffix`)).toBe(true);
  });
});

describe('cli-probe — deterministic stub seam', () => {
  test('an absent or empty stub yields an empty map, so real probes still run', () => {
    for (const raw of [undefined, '', '   ']) {
      const parsed = parseCliProbeStub(raw);
      expect(parsed.ok).toBe(true);
      expect(parsed.stub.size).toBe(0);
    }
  });

  test('each status maps to the outcome it names, flagged as stubbed', () => {
    const parsed = parseCliProbeStub(JSON.stringify({
      claude: 'available', codex: 'timeout', gemini: 'not-found',
    }));
    expect(parsed.ok).toBe(true);
    expect(parsed.stub.get('claude')).toMatchObject({ ok: true, status: 'available', stubbed: true });
    expect(parsed.stub.get('codex')).toMatchObject({ status: 'timeout', transient: true, stubbed: true });
    expect(parsed.stub.get('gemini')).toMatchObject({ status: 'not-found', transient: false, stubbed: true });
  });

  test('a stubbed outcome can never be rendered as a real availability fact', () => {
    const { stub } = parseCliProbeStub(JSON.stringify({ claude: 'not-found' }));
    expect(describeProbeOutcome('claude', stub.get('claude'))).toContain('[stubbed probe]');
  });

  test('a key no probe reads is refused, not quietly ignored', () => {
    // session-doctor looks the stub up by agent id, so `claud` would stub
    // nothing and let the real `claude` check fall back to a real spawn — the
    // nondeterminism the seam exists to remove, hidden behind a passing parse.
    for (const raw of [
      JSON.stringify({ claud: 'available' }),
      JSON.stringify({ git: 'available' }),
      JSON.stringify({ claude: 'available', gh: 'not-found' }),
    ]) {
      const parsed = parseCliProbeStub(raw);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(CLI_PROBE_STUB_ENV);
    }
    expect(parseCliProbeStub(JSON.stringify({ claud: 'available' })).error).toContain('claud');
  });

  test('every stubbable agent is one session-doctor actually probes', () => {
    const parsed = parseCliProbeStub(
      JSON.stringify(Object.fromEntries(CLI_PROBE_STUB_AGENTS.map((a) => [a, 'available']))),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.stub.size).toBe(CLI_PROBE_STUB_AGENTS.length);
  });

  test('anything not fully understood is refused rather than silently ignored', () => {
    // A typo'd stub that fell back to real spawns would quietly reintroduce the
    // nondeterminism the seam exists to remove.
    for (const raw of ['{', '[]', '"claude"', JSON.stringify({ claude: 'availble' }), JSON.stringify({ claude: 3 })]) {
      const parsed = parseCliProbeStub(raw);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(CLI_PROBE_STUB_ENV);
    }
  });
});
