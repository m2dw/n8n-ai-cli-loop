import { parseToolRequest, redactCommand, toolRequestPromptSection, toolRequestResolutionPromptSection, normalizeToolRequestCommand, TOOL_REQUEST_OPEN, TOOL_REQUEST_CLOSE } from '../dist/index.js';

// ---------------------------------------------------------------------------
// parseToolRequest — detection of the disallowed-command Tool Request block
// ---------------------------------------------------------------------------

function block(lines) {
  return [TOOL_REQUEST_OPEN, ...lines, TOOL_REQUEST_CLOSE].join('\n');
}

test('returns undefined when there is no Tool Request block', () => {
  expect(parseToolRequest('I edited the files and finished.')).toBeUndefined();
  expect(parseToolRequest('')).toBeUndefined();
});

test('parses a complete Tool Request block', () => {
  const out = [
    'Some preamble from the agent.',
    block([
      'command: npm install left-pad',
      'reason: The fix depends on left-pad which is not a dependency yet.',
      'expected_files: package.json, package-lock.json',
      'suggested_action: dependencySync',
    ]),
  ].join('\n');

  const tr = parseToolRequest(out);
  expect(tr).toEqual({
    command: 'npm install left-pad',
    displayCommand: 'npm install left-pad',
    reason: 'The fix depends on left-pad which is not a dependency yet.',
    expectedFiles: ['package.json', 'package-lock.json'],
    necessity: 'required',
    suggestedAction: 'dependencySync',
  });
});

test('parses necessity and defaults it to required when absent or invalid', () => {
  const optional = parseToolRequest(block(['command: npm run lint', 'necessity: optional']));
  expect(optional.necessity).toBe('optional');
  const bogus = parseToolRequest(block(['command: npm run lint', 'necessity: maybe']));
  expect(bogus.necessity).toBe('required');
  const absent = parseToolRequest(block(['command: npm run lint']));
  expect(absent.necessity).toBe('required');
});

test('exposes a redacted displayCommand for public display', () => {
  const tr = parseToolRequest(block(['command: deploy --token=SECRET123 /Users/me/repo']));
  expect(tr.command).toBe('deploy --token=SECRET123 /Users/me/repo');
  expect(tr.displayCommand).not.toContain('SECRET123');
  expect(tr.displayCommand).not.toContain('/Users/me/repo');
  expect(tr.displayCommand).toContain('***');
});

test('redactCommand masks secret-bearing flags and absolute paths', () => {
  expect(redactCommand('npm install')).toBe('npm install');
  expect(redactCommand('curl --password hunter2 https://x')).toContain('***');
  expect(redactCommand('cat /etc/shadow')).toContain('<path>');
});

test('redactCommand fully redacts absolute paths containing spaces', () => {
  // Quoted path with spaces: the suffix after the space must not leak.
  const dq = redactCommand('cat "/Users/alice/Secret Project/file"');
  expect(dq).not.toContain('Secret');
  expect(dq).not.toContain('Project');
  expect(dq).toBe('cat "<path>"');

  const sq = redactCommand("cat '/Users/alice/Secret Project/file'");
  expect(sq).not.toContain('Project');
  expect(sq).toBe("cat '<path>'");

  // Backslash-escaped space is part of the same path.
  const escaped = redactCommand('cat /Users/alice/Secret\\ Project/file');
  expect(escaped).not.toContain('Project');
  expect(escaped).toBe('cat <path>');
});

test('redactCommand masks credential-bearing environment assignments', () => {
  const out = redactCommand('GITHUB_TOKEN=SECRET npm install');
  expect(out).not.toContain('SECRET');
  expect(out).toContain('GITHUB_TOKEN=***');
  expect(out).toContain('npm install');
  // The variable name is preserved for operator context, only the value masked.
  const pwd = redactCommand('MYSQL_PWD=hunter2 mysql -u root');
  expect(pwd).not.toContain('hunter2');
  expect(pwd).toContain('MYSQL_PWD=***');
});

test('redactCommand masks quoted environment assignment values containing whitespace', () => {
  const dq = redactCommand('API_TOKEN="my secret token" npm install');
  expect(dq).not.toContain('my secret token');
  expect(dq).not.toContain('secret token"');
  expect(dq).toContain('API_TOKEN=***');
  expect(dq).toContain('npm install');

  const sq = redactCommand("API_TOKEN='my secret token' npm install");
  expect(sq).not.toContain('my secret token');
  expect(sq).toContain('API_TOKEN=***');

  // Unterminated quote must still be masked through to end of value.
  const unterminated = redactCommand('API_TOKEN="my secret token');
  expect(unterminated).not.toContain('my secret token');
  expect(unterminated).toContain('API_TOKEN=***');
});

test('redactCommand masks short password flags', () => {
  expect(redactCommand('mysql -p hunter2')).not.toContain('hunter2');
  expect(redactCommand('mysql -p hunter2')).toContain('***');
  expect(redactCommand('mysql -phunter2')).not.toContain('hunter2');
});

test('redactCommand masks quoted secret flag values containing whitespace', () => {
  const dq = redactCommand('deploy --password "my secret"');
  expect(dq).not.toContain('my secret');
  expect(dq).not.toContain('secret"');
  expect(dq).toContain('***');

  const sq = redactCommand("deploy --token 'my secret token' --to prod");
  expect(sq).not.toContain('my secret token');
  expect(sq).not.toContain("token'");
  expect(sq).toContain('***');
  expect(sq).toContain('--to prod');

  // Unterminated quote must still be masked through to end of value.
  const unterminated = redactCommand('deploy --password "my secret');
  expect(unterminated).not.toContain('my secret');
  expect(unterminated).toContain('***');

  // Short -p flag with a quoted value containing whitespace.
  const shortFlag = redactCommand('mysql -p "hunter two"');
  expect(shortFlag).not.toContain('hunter two');
  expect(shortFlag).not.toContain('two"');
  expect(shortFlag).toContain('***');
});

test('redactCommand masks underscore-style secret flags', () => {
  const space = redactCommand('deploy --api_key SECRETVALUE');
  expect(space).not.toContain('SECRETVALUE');
  expect(space).toContain('***');

  const eq = redactCommand('deploy --client_secret=SECRETVALUE');
  expect(eq).not.toContain('SECRETVALUE');
  expect(eq).toContain('***');

  // Underscore segments around the secret keyword are masked too.
  const compound = redactCommand('deploy --aws_secret_access_key SECRETVALUE');
  expect(compound).not.toContain('SECRETVALUE');
  expect(compound).toContain('***');
});

test('redactCommand masks credentials embedded in URL userinfo', () => {
  const clone = redactCommand('git clone https://user:ghp_SECRETTOKEN@github.com/org/repo.git');
  expect(clone).not.toContain('ghp_SECRETTOKEN');
  expect(clone).not.toContain('user:');
  expect(clone).toContain('***@github.com');
  // A bare-token userinfo form is masked too.
  const bare = redactCommand('git clone https://ghp_SECRETTOKEN@github.com/org/repo.git');
  expect(bare).not.toContain('ghp_SECRETTOKEN');
  expect(bare).toContain('***@');
});

test('redactCommand masks credential-bearing HTTP headers and auth schemes', () => {
  const bearer = redactCommand("curl -H 'Authorization: Bearer ghp_SECRETTOKEN' https://api.github.com");
  expect(bearer).not.toContain('ghp_SECRETTOKEN');
  expect(bearer).toContain('***');
  const basic = redactCommand('curl --header "Authorization: Basic dXNlcjpwYXNzd29yZA==" https://x');
  expect(basic).not.toContain('dXNlcjpwYXNzd29yZA==');
  expect(basic).toContain('***');
  const apiKey = redactCommand("curl -H 'X-Api-Key: SUPERSECRET' https://x");
  expect(apiKey).not.toContain('SUPERSECRET');
  expect(apiKey).toContain('***');
});

test('redactCommand masks --user/-u basic-auth credentials', () => {
  // Long flag with space-separated value.
  const longSpace = redactCommand('curl --user alice:s3cr3t https://x');
  expect(longSpace).not.toContain('s3cr3t');
  expect(longSpace).toContain('alice:***');
  expect(longSpace).toContain('https://x');
  // Long flag with `=`.
  const longEq = redactCommand('curl --user=alice:s3cr3t https://x');
  expect(longEq).not.toContain('s3cr3t');
  expect(longEq).toContain('alice:***');
  // Short flag, space-separated and glued.
  const shortSpace = redactCommand('curl -u alice:s3cr3t https://x');
  expect(shortSpace).not.toContain('s3cr3t');
  expect(shortSpace).toContain('alice:***');
  const shortGlued = redactCommand('curl -ualice:s3cr3t https://x');
  expect(shortGlued).not.toContain('s3cr3t');
  expect(shortGlued).toContain('alice:***');
  // Quoted value containing the credential.
  const quoted = redactCommand('curl -u "alice:s3cr3t" https://x');
  expect(quoted).not.toContain('s3cr3t');
  expect(quoted).toContain('alice:***');
  // A bare username with no password component carries no secret.
  expect(redactCommand('mysql -u root')).toBe('mysql -u root');
});

test('redactCommand masks a bare token-format positional argument', () => {
  const out = redactCommand('deploy --to prod ghp_SECRETTOKENVALUE123');
  expect(out).not.toContain('ghp_SECRETTOKENVALUE123');
  expect(out).toContain('***');
});

test('parseToolRequest redacts credentials in displayCommand', () => {
  const tr = parseToolRequest(block(['command: GITHUB_TOKEN=SECRET123 npm install left-pad']));
  expect(tr.command).toBe('GITHUB_TOKEN=SECRET123 npm install left-pad');
  expect(tr.displayCommand).not.toContain('SECRET123');
  expect(tr.displayCommand).toContain('***');
});

test('command is required; a block without one is not a request', () => {
  const out = block(['reason: I want something', 'expected_files: a.ts']);
  expect(parseToolRequest(out)).toBeUndefined();
});

test('reason defaults when omitted, and unknown/none files are dropped', () => {
  const out = block([
    'command: npm run build',
    'expected_files: unknown',
  ]);
  const tr = parseToolRequest(out);
  expect(tr.command).toBe('npm run build');
  expect(tr.reason).toBe('(no reason provided)');
  expect(tr.expectedFiles).toEqual([]);
  expect(tr.suggestedAction).toBeUndefined();
});

test('accepts alternate key spellings (expected changed files / suggested next action)', () => {
  const out = block([
    'command: pip install requests',
    'reason: needed for the http client',
    'expected changed files: requirements.txt',
    'suggested next action: manual-review',
  ]);
  const tr = parseToolRequest(out);
  expect(tr.expectedFiles).toEqual(['requirements.txt']);
  expect(tr.suggestedAction).toBe('manual-review');
});

test('the LAST complete block wins when the prompt format is echoed first', () => {
  const echoed = block(['command: <the exact command you need to run>', 'reason: <why>']);
  const real = block(['command: npm install real-pkg', 'reason: actually needed']);
  const tr = parseToolRequest(`${echoed}\nblah blah\n${real}`);
  expect(tr.command).toBe('npm install real-pkg');
});

test('an echoed template block with only placeholder values is not a request', () => {
  // An agent that echoes the prompt's example block without filling it in must
  // NOT be treated as a real Tool Request — otherwise its edits would be
  // discarded and the task wrongly escalated to a human.
  const echoed = block([
    'command: <the exact command you need to run>',
    'reason: <why it is required to complete this issue>',
    'expected_files: <comma-separated files you expect it to change, or unknown>',
    'necessity: <required if the task cannot be completed without it, otherwise optional>',
    'suggested_action: <one of: dependencySync, run-and-requeue, grant-permission, manual-review>',
  ]);
  expect(parseToolRequest(echoed)).toBeUndefined();
});

test('an unterminated block is ignored', () => {
  const out = `${TOOL_REQUEST_OPEN}\ncommand: rm -rf /\nreason: nope`;
  expect(parseToolRequest(out)).toBeUndefined();
});

test('command and reason are length-bounded', () => {
  const out = block([
    `command: ${'a'.repeat(2000)}`,
    `reason: ${'b'.repeat(5000)}`,
  ]);
  const tr = parseToolRequest(out);
  expect(tr.command.length).toBeLessThanOrEqual(500);
  expect(tr.reason.length).toBeLessThanOrEqual(1000);
});

// ---------------------------------------------------------------------------
// normalizeToolRequestCommand — duplicate detection normalization
// ---------------------------------------------------------------------------

test('normalizeToolRequestCommand trims leading and trailing whitespace', () => {
  expect(normalizeToolRequestCommand('  npm install  ')).toBe('npm install');
  expect(normalizeToolRequestCommand('\tnpm install\n')).toBe('npm install');
});

test('normalizeToolRequestCommand preserves internal whitespace', () => {
  // Commands with different internal spacing must NOT be treated as duplicates.
  const a = normalizeToolRequestCommand("printf 'a  b' > file");
  const b = normalizeToolRequestCommand("printf 'a b' > file");
  expect(a).toBe("printf 'a  b' > file");
  expect(b).toBe("printf 'a b' > file");
  expect(a).not.toBe(b);
});

test('normalizeToolRequestCommand treats identical commands as equal', () => {
  const cmd = 'npm install left-pad';
  expect(normalizeToolRequestCommand(cmd)).toBe(normalizeToolRequestCommand(cmd));
  // Leading/trailing whitespace variants are still equivalent.
  expect(normalizeToolRequestCommand('  npm install left-pad')).toBe(
    normalizeToolRequestCommand('npm install left-pad  '),
  );
});

test('toolRequestPromptSection documents the exact block format', () => {
  const section = toolRequestPromptSection().join('\n');
  expect(section).toContain(TOOL_REQUEST_OPEN);
  expect(section).toContain(TOOL_REQUEST_CLOSE);
  expect(section).toContain('command:');
  expect(section).toContain('suggested_action:');
});

// ---------------------------------------------------------------------------
// toolRequestResolutionPromptSection (issue #422): replays the operator's
// response to a prior Tool Request as conversational continuation in the next
// implementation prompt.
// ---------------------------------------------------------------------------

const resolvedRequest = (resolution, overrides = {}) => ({
  command: 'npm run typecheck && npm test && npm run build',
  displayCommand: 'npm run typecheck && npm test && npm run build',
  reason: 'Verify the change before opening a PR.',
  expectedFiles: ['dist/index.js'],
  necessity: 'required',
  requestedBy: 'worker-1',
  mode: 'new',
  requestedAt: '2026-06-07T00:00:00.000Z',
  resolved: true,
  resolution,
  ...overrides,
});

test('no previous Tool Request -> resolution section is empty', () => {
  expect(toolRequestResolutionPromptSection(undefined)).toEqual([]);
  expect(toolRequestResolutionPromptSection(null)).toEqual([]);
  expect(toolRequestResolutionPromptSection({})).toEqual([]);
});

test('unresolved Tool Request -> no misleading resolved response section', () => {
  const unresolved = resolvedRequest(undefined, { resolved: false, resolution: undefined });
  expect(toolRequestResolutionPromptSection(unresolved)).toEqual([]);
  // resolved:true but missing resolution detail is also not surfaced.
  expect(toolRequestResolutionPromptSection({ ...unresolved, resolved: true })).toEqual([]);
});

test('resolved manual-done -> operator response section appears with request detail', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({ action: 'manual-done', resolvedAt: '2026-06-08T01:00:00.000Z' }),
  ).join('\n');
  expect(section).toContain('## Operator Response To Previous Tool Request');
  expect(section).toContain('npm run typecheck && npm test && npm run build');
  expect(section).toContain('Verify the change before opening a PR.');
  expect(section).toContain('Expected files:');
  expect(section).toContain('dist/index.js');
  expect(section).toContain('The operator responded: manual-done');
  expect(section).toContain('Resolved at: 2026-06-08T01:00:00.000Z');
  // It must steer the agent away from blindly repeating the request.
  expect(section).toContain('Do not repeat the same Tool Request');
  expect(section).toContain('inspect');
});

test('resolved reject with message -> rejection feedback appears', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({
      action: 'reject',
      message: 'We do not run the build here; assume it is green.',
      resolvedAt: '2026-06-08T02:00:00.000Z',
    }),
  ).join('\n');
  expect(section).toContain('The operator responded: reject');
  expect(section).toContain('Operator note:');
  expect(section).toContain('We do not run the build here; assume it is green.');
  expect(section).toContain('feedback from the human');
  expect(section).toContain('Do not repeat the same Tool Request');
});

test('grant resolution is treated as the command having been run', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({ action: 'grant', resolvedAt: '2026-06-08T03:00:00.000Z' }),
  ).join('\n');
  expect(section).toContain('The operator responded: grant');
  expect(section).toContain('The command has been run.');
});

test('resolution section omits optional fields that are absent', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest(
      { action: 'manual-done', resolvedAt: '2026-06-08T01:00:00.000Z' },
      { reason: '', expectedFiles: [] },
    ),
  ).join('\n');
  expect(section).not.toContain('Reason:');
  expect(section).not.toContain('Expected files:');
  expect(section).not.toContain('Operator note:');
});

// ---------------------------------------------------------------------------
// Guided run (issue #430): the operator response carries a disposition and the
// captured command output, both folded into the next prompt as continuation
// context. The no-op verification case is the load-bearing fix — the captured
// output is the answer the agent was missing, so it MUST reach the next prompt.
// ---------------------------------------------------------------------------

test('no-op verification guided run replays the captured output as continuation context', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({
      action: 'guided-run',
      resolvedAt: '2026-06-08T04:00:00.000Z',
      commandHash: 'abc123',
      disposition: 'no-op',
      capturedResult: { exitCode: 0, stdout: 'Test Suites: 12 passed\nTests: 48 passed', stderr: '' },
    }),
  ).join('\n');
  expect(section).toContain('The operator responded: guided-run (no repo changes)');
  expect(section).toContain('Captured command output (exit code 0):');
  expect(section).toContain('Test Suites: 12 passed');
  // The captured output is the deliverable, so the guidance must point at it.
  expect(section).toContain('the captured output above is the answer you were missing');
  expect(section).toContain('do not repeat the same verification request');
});

test('committed guided run reports the disposition and that the command was run', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({
      action: 'guided-run',
      resolvedAt: '2026-06-08T05:00:00.000Z',
      commandHash: 'def456',
      disposition: 'committed',
      capturedResult: { exitCode: 0, stdout: 'added 1 package', stderr: '' },
    }),
  ).join('\n');
  expect(section).toContain('The operator responded: guided-run (changes committed)');
  expect(section).toContain('added 1 package');
  expect(section).toContain('The command has been run.');
});

test('discarded guided run steers the agent to a different approach', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({
      action: 'guided-run',
      resolvedAt: '2026-06-08T06:00:00.000Z',
      commandHash: 'ghi789',
      disposition: 'discarded',
      capturedResult: { exitCode: 0, stdout: 'rewrote 30 files', stderr: '' },
    }),
  ).join('\n');
  expect(section).toContain('The operator responded: guided-run (changes discarded)');
  expect(section).toContain('discarded the changes it produced');
  expect(section).toContain('take a different approach');
});

test('captured stderr is replayed and oversized output is truncated', () => {
  const big = 'x'.repeat(5000);
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({
      action: 'guided-run',
      resolvedAt: '2026-06-08T07:00:00.000Z',
      disposition: 'no-op',
      capturedResult: { exitCode: 1, stdout: '', stderr: big },
    }),
  ).join('\n');
  expect(section).toContain('Captured command output (exit code 1):');
  expect(section).toContain('stderr:');
  expect(section).toContain('…(output truncated)');
  // Bounded: the replayed stderr must not contain the full 5000-char blob.
  expect(section).not.toContain(big);
});

test('failed guided run replays the captured failure output and tells the agent to diagnose it (issue #678)', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({
      action: 'guided-run',
      resolvedAt: '2026-06-08T09:00:00.000Z',
      commandHash: 'jkl012',
      disposition: 'failed',
      capturedResult: { exitCode: 1, stdout: 'Tests: 128 passed, 1 failed', stderr: 'AssertionError: expected 1 option, got 3' },
    }),
  ).join('\n');
  expect(section).toContain('The operator responded: guided-run (command failed)');
  expect(section).toContain('Captured command output (exit code 1):');
  expect(section).toContain('Tests: 128 passed, 1 failed');
  expect(section).toContain('AssertionError: expected 1 option, got 3');
  // A non-zero exit is diagnostic information, not a reason to stop: the agent
  // must be told to diagnose and continue, not that "the command has been run"
  // (the generic phrasing used for success dispositions, which would misread a
  // failure as a green light to proceed unchanged).
  expect(section).toContain('FAILED');
  expect(section).toContain('Diagnose the failure');
  expect(section).not.toContain('The command has been run.');
});

test('no captured result (manual-done) -> no captured-output block', () => {
  const section = toolRequestResolutionPromptSection(
    resolvedRequest({ action: 'manual-done', resolvedAt: '2026-06-08T08:00:00.000Z' }),
  ).join('\n');
  expect(section).not.toContain('Captured command output');
});
