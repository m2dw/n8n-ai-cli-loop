/**
 * Unit tests for the headless permission-denial classifier (issue #804, first
 * implementation slice of #802).
 *
 * Guarantees under test:
 *   - a soft-denied read/search and a soft-denied command are distinguished;
 *   - a run with no denial evidence is never classified as denied;
 *   - classification consumes only a provider-vetted diagnostic (no raw stdout);
 *   - retained evidence is bounded and carries no text copied out of the
 *     diagnostic (no command bodies, arguments, paths, tokens, or prompt lines).
 */
import {
  classifyPermissionDenial,
  describeDeniedOperation,
  extractGeminiDiagnostic,
  MAX_DENIAL_EVIDENCE_LINES,
  MAX_DENIAL_OPERATION_TOKENS,
} from '../dist/index.js';

const diagnostic = (text, overrides = {}) => ({
  agentId: 'gemini',
  source: 'stderr',
  text,
  exitCode: 0,
  ...overrides,
});

describe('classifyPermissionDenial — detection', () => {
  test('no diagnostic is not a denial', () => {
    expect(classifyPermissionDenial(undefined).isPermissionDenied).toBe(false);
  });

  test('an empty diagnostic is not a denial', () => {
    expect(classifyPermissionDenial(diagnostic('   \n  ')).isPermissionDenied).toBe(false);
  });

  test('ordinary diagnostic chatter is not a denial', () => {
    const result = classifyPermissionDenial(
      diagnostic('Loaded 3 extensions.\nModel: antigravity-pro\nDone in 12s.'),
    );
    expect(result.isPermissionDenied).toBe(false);
    expect(result.evidence).toEqual([]);
  });

  test('a denied read/search operation classifies as read', () => {
    const result = classifyPermissionDenial(
      diagnostic('Tool call read_file: permission denied (no matching permission rule)'),
    );
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('read');
    expect(result.signal).toBe('permission denied');
  });

  test('a denied command/process operation classifies as command', () => {
    const result = classifyPermissionDenial(
      diagnostic('run_shell_command was denied by policy in non-interactive mode'),
    );
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('command');
  });

  test('the operation token may appear on the line above the denial', () => {
    const result = classifyPermissionDenial(
      diagnostic('Requesting tool: list_directory\npermission denied\nAborting tool call.'),
    );
    expect(result.operation).toBe('read');
  });

  test('a denial with no operation token stays unspecified rather than guessing', () => {
    const result = classifyPermissionDenial(diagnostic('Access denied; approval required.'));
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('unspecified');
  });

  test('read and command denied in the same run resolves to unspecified', () => {
    const result = classifyPermissionDenial(
      diagnostic('read_file: permission denied\n---\nrun_shell_command: permission denied'),
    );
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('unspecified');
  });

  test('one decisive class plus a tokenless denial keeps the decisive class', () => {
    const result = classifyPermissionDenial(
      diagnostic('grep: permission denied\n---\napproval required'),
    );
    expect(result.operation).toBe('read');
  });

  // The rejected tool's identifier outranks words quoted from its arguments:
  // a diagnostic may echo the denied command body, and weighing those tokens
  // equally would collapse a plainly actionable class into `unspecified`.
  test('a read word inside a denied command body does not blur the command class', () => {
    const result = classifyPermissionDenial(
      diagnostic('run_shell_command "grep -rn TODO src/": permission denied'),
    );
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('command');
  });

  test('a command word inside a denied read path does not blur the read class', () => {
    const result = classifyPermissionDenial(
      diagnostic('read_file "scripts/bash/spawn-worker.sh": permission denied'),
    );
    expect(result.operation).toBe('read');
  });

  test('two opposing tool identifiers in one window are still ambiguous', () => {
    const result = classifyPermissionDenial(
      diagnostic('tools read_file, run_shell_command: permission denied'),
    );
    expect(result.operation).toBe('unspecified');
  });

  test('a structured provider code is inspected alongside the text', () => {
    const result = classifyPermissionDenial(
      diagnostic('tool: run_shell_command', { source: 'structured', code: 'PERMISSION_DENIED' }),
    );
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('command');
    expect(result.source).toBe('structured');
  });

  // issue #814: reproduced by yoda-form-js#449 — the current Jetski
  // (Antigravity/Gemini headless launcher) diagnostic for an auto-denied
  // repository read was previously unrecognized and fell through to the
  // generic `empty-output` classification.
  test('the current Jetski auto-denied read_file diagnostic classifies as read', () => {
    const result = classifyPermissionDenial(
      diagnostic(
        'jetski: no output produced — a tool required the "read_file" permission that headless '
        + 'mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow '
        + 'in settings.json (e.g. read_file(<target>)). Alternatively, re-run with '
        + '--dangerously-skip-permissions to auto-approve all tools.',
      ),
    );
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('read');
    expect(result.signal).toBe('auto-denied');
    expect(result.evidence).toEqual([
      { channel: 'text', line: 1, signal: 'auto-denied', operation: 'read', operationTokens: ['read_file'] },
    ]);
    // Quoted `read_file` is normalized to the fixed vocabulary — the record
    // carries the token literal, never the surrounding quotes, prompt text,
    // or the diagnostic's own help-text sentences.
    const serialized = JSON.stringify(result.evidence);
    expect(serialized).not.toContain('jetski');
    expect(serialized).not.toContain('settings.json');
    expect(serialized).not.toContain('dangerously-skip-permissions');
    expect(serialized).not.toContain('<target>');
  });

  // issue #832: the same launcher names the permission *class* rather than the
  // tool when the refusal is not tool-specific — the exact form the post-#830
  // acceptance run produced. Without it the actionable class collapses to
  // `unspecified`, which reads as "look at the read profile" for a run that
  // actually reached for a shell.
  test('the Jetski auto-denied command-class diagnostic classifies as command', () => {
    const result = classifyPermissionDenial(
      diagnostic(
        'jetski: no output produced - a tool required the "command" permission that headless mode '
        + 'cannot prompt for, so it was auto-denied.',
      ),
    );
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('command');
    expect(result.evidence[0].operationTokens).toEqual(['"command" permission']);
    expect(JSON.stringify(result.evidence)).not.toContain('jetski');
  });

  test('the quoted class token does not match a quoted tool name that ends in the same word', () => {
    // `"run_shell_command" permission` is the tool identifier's case, not the
    // class token's: both quotes belong to the token, so the two forms cannot
    // be confused into a double match.
    const result = classifyPermissionDenial(
      diagnostic('a tool required the "run_shell_command" permission ... so it was auto-denied.'),
    );
    expect(result.operation).toBe('command');
    expect(result.evidence[0].operationTokens).toEqual(['run_shell_command']);
  });

  test('the read class is named the same way', () => {
    const result = classifyPermissionDenial(
      diagnostic('a tool required the "read" permission ... so it was auto-denied.'),
    );
    expect(result.operation).toBe('read');
    expect(result.evidence[0].operationTokens).toEqual(['"read" permission']);
  });

  test('unrelated empty-output diagnostic chatter mentioning permissions in passing is not a denial', () => {
    // Help text that merely mentions "permission" without stating a refusal
    // (no signal phrase from the fixed list) must not be relabeled.
    const result = classifyPermissionDenial(
      diagnostic('jetski: add an allow-rule under permissions.allow in settings.json to grant tool access.'),
    );
    expect(result.isPermissionDenied).toBe(false);
  });
});

describe('classifyPermissionDenial — provenance', () => {
  test('an operator-overridden binary yields no diagnostic, so no denial', () => {
    // extractGeminiDiagnostic withholds trust when ANTIGRAVITY_BIN was
    // overridden (issue #671); the classifier must then stay silent rather
    // than text-matching the untrusted capture.
    const untrusted = extractGeminiDiagnostic(
      { stdout: '', stderr: 'read_file: permission denied', exitCode: 0 },
      { cmdSource: 'env' },
    );
    expect(untrusted).toBeUndefined();
    expect(classifyPermissionDenial(untrusted).isPermissionDenied).toBe(false);
  });

  test('raw stdout is never a denial source', () => {
    // A transcript that quotes a denial message reaches the adapter as stdout,
    // which produces no diagnostic at all.
    const fromStdout = extractGeminiDiagnostic(
      { stdout: 'The log said: run_shell_command: permission denied', stderr: '', exitCode: 0 },
      { cmdSource: 'cli-default' },
    );
    expect(fromStdout).toBeUndefined();
    expect(classifyPermissionDenial(fromStdout).isPermissionDenied).toBe(false);
  });
});

describe('classifyPermissionDenial — bounded content-free evidence', () => {
  test('evidence records carry only the matched signal, tokens, and a location', () => {
    const result = classifyPermissionDenial(diagnostic('run_shell_command: permission denied'));
    expect(result.evidence).toEqual([
      {
        channel: 'text',
        line: 1,
        signal: 'permission denied',
        operation: 'command',
        operationTokens: ['run_shell_command'],
      },
    ]);
  });

  test('a denied command body on the denial line is not retained', () => {
    const result = classifyPermissionDenial(
      diagnostic('run_shell_command "echo $SECRET_TOKEN > /Users/someone/repo/leak.txt": permission denied'),
    );
    expect(result.isPermissionDenied).toBe(true);
    expect(result.operation).toBe('command');
    const serialized = JSON.stringify(result.evidence);
    expect(serialized).not.toContain('SECRET_TOKEN');
    expect(serialized).not.toContain('echo');
    expect(serialized).not.toContain('leak.txt');
    expect(serialized).not.toMatch(/\/Users\//);
  });

  test('neighbouring diagnostic content is used for classification but never retained', () => {
    const result = classifyPermissionDenial(
      diagnostic(
        [
          'prompt echo: # Research Task — Issue #42 (do not leak this)',
          'Requesting tool: read_file /Users/someone/repo/src/secret.ts',
          'permission denied (headless mode)',
          'token ghp_abcdefghijklmnopqrstuvwxyz012345 rejected',
        ].join('\n'),
      ),
    );
    // The neighbouring line still decides the operation class...
    expect(result.operation).toBe('read');
    // ...but none of its content is carried into the record.
    const serialized = JSON.stringify(result.evidence);
    expect(serialized).not.toContain('Research Task');
    expect(serialized).not.toContain('secret.ts');
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(serialized).not.toMatch(/\/Users\//);
    expect(result.evidence[0].operationTokens).toEqual(['read_file']);
  });

  test('an arbitrarily long denial line adds no unbounded text', () => {
    const long = `permission denied: ${'x'.repeat(5000)}`;
    const result = classifyPermissionDenial(diagnostic(long));
    expect(result.evidence).toHaveLength(1);
    expect(JSON.stringify(result.evidence)).not.toContain('xxx');
  });

  test('retained operation tokens are bounded', () => {
    const result = classifyPermissionDenial(
      diagnostic('read_file read_many_files glob grep list_directory search_file view file file read: permission denied'),
    );
    expect(result.evidence[0].operationTokens.length).toBeLessThanOrEqual(MAX_DENIAL_OPERATION_TOKENS);
  });

  test('evidence record count is bounded but the denial count is kept', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}: permission denied`).join('\n');
    const result = classifyPermissionDenial(diagnostic(many));
    expect(result.evidence.length).toBeLessThanOrEqual(MAX_DENIAL_EVIDENCE_LINES);
    expect(result.evidenceTruncated).toBe(true);
    expect(result.denialCount).toBe(40);
  });

  test('a record locates the denial by channel and 1-based line', () => {
    const result = classifyPermissionDenial(
      diagnostic('starting\nloading tools\nread_file: permission denied', { source: 'structured', code: 'TOOL_ERROR' }),
    );
    expect(result.evidence).toEqual([
      { channel: 'text', line: 3, signal: 'permission denied', operation: 'read', operationTokens: ['read_file'] },
    ]);
  });

  test('a denial in the structured code channel is located there', () => {
    const result = classifyPermissionDenial(
      diagnostic('tool: run_shell_command', { source: 'structured', code: 'PERMISSION_DENIED' }),
    );
    expect(result.evidence[0].channel).toBe('code');
    expect(result.evidence[0].line).toBe(1);
  });
});

describe('describeDeniedOperation', () => {
  test('names only the operation class', () => {
    expect(describeDeniedOperation('read')).toBe('repository read/search operation');
    expect(describeDeniedOperation('command')).toBe('command/process operation');
    expect(describeDeniedOperation('unspecified')).toBe('tool operation');
  });
});
