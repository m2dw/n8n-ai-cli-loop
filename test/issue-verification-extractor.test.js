import { extractIssueVerificationCommands } from '../dist/handlers/issue-verification-extractor.js';

describe('extractIssueVerificationCommands', () => {
  test('returns empty array when body has no verification section', () => {
    const body = '## Background\nSome background text.\n\n## Implementation\nDo the thing.';
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('extracts commands from fenced code block in Verification section', () => {
    const body = [
      '## Description',
      'Fix the login form.',
      '',
      '## Verification',
      '```',
      'npm run build:demo',
      'npm run test:e2e',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual([
      'npm run build:demo',
      'npm run test:e2e',
    ]);
  });

  test('extracts inline backtick commands from Verification section', () => {
    const body = [
      '## Verification',
      '- Run `npm test`',
      '- Also run `npm run lint`',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test', 'npm run lint']);
  });

  test('extracts commands from Test Plan section', () => {
    const body = [
      '## Test Plan',
      '```bash',
      'npm run test:e2e',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm run test:e2e']);
  });

  test('extracts commands from Acceptance Criteria section', () => {
    const body = [
      '## Acceptance Criteria',
      '- [ ] `npm test` passes',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test']);
  });

  test('stops collecting at next same-level heading', () => {
    const body = [
      '## Verification',
      '- `npm test`',
      '',
      '## Other Section',
      '- `npm run unrelated`',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test']);
  });

  test('stops collecting at higher-level heading inside section', () => {
    const body = [
      '### Verification',
      '- `npm test`',
      '',
      '## Top Level',
      '- `npm run unrelated`',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test']);
  });

  test('does not extract bare words without spaces as inline code (non-command)', () => {
    const body = [
      '## Verification',
      'See `README` for details.',
    ].join('\n');
    // "README" doesn't look like a shell command
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('deduplicates commands across fenced and inline occurrences', () => {
    const body = [
      '## Verification',
      '```',
      'npm test',
      '```',
      '- Run `npm test` to check',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test']);
  });

  test('ignores comment lines inside fenced blocks', () => {
    const body = [
      '## Verification',
      '```bash',
      '# Install deps first',
      'npm install',
      'npm test',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm install', 'npm test']);
  });

  test('collects from multiple verification-like sections', () => {
    const body = [
      '## Verification',
      '- `npm test`',
      '',
      '## Test Plan',
      '```',
      'npm run e2e',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test', 'npm run e2e']);
  });

  test('real-world example matching the issue bug report', () => {
    const body = [
      '## Background',
      'The demo page shows the form.',
      '',
      '## Verification',
      '',
      'npm run build:demo',
      'npm run test:e2e',
      '',
      '## Acceptance Criteria',
      '- [ ] Build passes',
    ].join('\n');
    // Commands in plain text (not in code fences or backticks) are not extracted
    // — only fenced/inline code is extracted to avoid false positives.
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('unlabeled fence with expected output/config is not extracted as commands', () => {
    const body = [
      '## Verification',
      'Run the build and confirm the output matches:',
      '```',
      '{ "status": "ok", "built": true }',
      'Build succeeded in 1.2s',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('unlabeled fence: shell commands are extracted but non-command lines are not', () => {
    const body = [
      '## Verification',
      '```',
      'npm run build',
      'expected output: success',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm run build']);
  });

  test('real-world: commands in backticks within list items', () => {
    const body = [
      '## Verification',
      '',
      '- `npm run build:demo`',
      '- `npm run test:e2e`',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual([
      'npm run build:demo',
      'npm run test:e2e',
    ]);
  });

  test('console fence: $ prompt lines extracted, npm output lines ignored', () => {
    const body = [
      '## Verification',
      '```console',
      '$ npm test',
      '',
      '> package@ test /home/user/project',
      '> jest --coverage',
      '',
      'PASS src/foo.test.js',
      'Tests: 5 passed',
      '```',
    ].join('\n');
    // Only the '$ npm test' line should be extracted; npm echo lines (>) and
    // plain output lines must not be treated as verification commands.
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test']);
  });

  test('terminal fence: npm output lines starting with > are not extracted', () => {
    const body = [
      '## Verification',
      '```terminal',
      '$ npm run build:demo',
      '> mypackage@ build:demo',
      '> webpack --mode production',
      'Build complete.',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm run build:demo']);
  });

  test('bash fence: $ prompt is stripped from command lines', () => {
    const body = [
      '## Verification',
      '```bash',
      '$ npm test',
      '$ npm run build',
      '```',
    ].join('\n');
    // $ prefix must be stripped so commands match session.verification values
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test', 'npm run build']);
  });

  test('sh fence: % prompt is stripped from command lines', () => {
    const body = [
      '## Verification',
      '```sh',
      '% npm run test:e2e',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm run test:e2e']);
  });

  test('console fence: > npm run <cmd> prompt IS extracted (recognisable shell command)', () => {
    const body = [
      '## Verification',
      '```console',
      '> npm run test:e2e',
      '> package@ test:e2e',
      '> cypress run',
      '```',
    ].join('\n');
    // '> npm run test:e2e' passes looksLikeShellCommand; '> package@ test:e2e'
    // and '> cypress run' do not (neither 'package@' nor 'cypress' is a prefix).
    expect(extractIssueVerificationCommands(body)).toEqual(['npm run test:e2e']);
  });

  test('uv run pytest extracted from unlabeled fence', () => {
    const body = [
      '## Verification',
      '```',
      'uv run pytest',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['uv run pytest']);
  });

  test('vendor/bin/phpunit extracted from unlabeled fence', () => {
    const body = [
      '## Verification',
      '```',
      'vendor/bin/phpunit',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['vendor/bin/phpunit']);
  });

  test('composer test extracted from inline backtick', () => {
    const body = [
      '## Verification',
      '- Run `composer test` to confirm',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['composer test']);
  });

  test('git diff --check extracted from inline backtick', () => {
    const body = [
      '## Verification',
      '- `git diff --check` must exit 0',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['git diff --check']);
  });

  test('env-prefixed command CI=1 npm test extracted from inline backtick', () => {
    const body = [
      '## Verification',
      '- `CI=1 npm test`',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['CI=1 npm test']);
  });

  test('env-prefixed command extracted from bash fence', () => {
    const body = [
      '## Verification',
      '```bash',
      'CI=1 npm test',
      'NODE_ENV=test npm run e2e',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual([
      'CI=1 npm test',
      'NODE_ENV=test npm run e2e',
    ]);
  });

  test('bare env assignment without trailing command is not extracted', () => {
    const body = [
      '## Verification',
      '```bash',
      'CI=1',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('cd line before real command is prepended to preserve execution context', () => {
    const body = [
      '## Verification',
      '```bash',
      'cd frontend',
      'npm test',
      '```',
    ].join('\n');
    // `cd frontend` is stateful setup; it must be joined to the following command
    // so a root-level `npm test` does not falsely satisfy this requirement.
    expect(extractIssueVerificationCommands(body)).toEqual(['cd frontend && npm test']);
  });

  test('export VAR= line before real command is prepended to preserve context', () => {
    const body = [
      '## Verification',
      '```bash',
      'export FOO=bar',
      'npm run test:e2e',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['export FOO=bar && npm run test:e2e']);
  });

  test('source line before real command is prepended to preserve context', () => {
    const body = [
      '## Verification',
      '```sh',
      'source .env',
      'npm test',
      '```',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['source .env && npm test']);
  });

  test('set -e line is prepended to the first command only; pending setup resets after consumption', () => {
    const body = [
      '## Verification',
      '```bash',
      'set -e',
      'npm run build',
      'npm test',
      '```',
    ].join('\n');
    // set -e is consumed by `npm run build`; `npm test` has no pending setup.
    expect(extractIssueVerificationCommands(body)).toEqual(['set -e && npm run build', 'npm test']);
  });

  test('multi-line setup script: setup lines chained onto first command only', () => {
    const body = [
      '## Verification',
      '```bash',
      'cd frontend',
      'export NODE_ENV=test',
      'npm run build',
      'npm run test:e2e',
      '```',
    ].join('\n');
    // Both setup lines accumulate and are prepended to `npm run build`;
    // `npm run test:e2e` follows with no pending setup.
    expect(extractIssueVerificationCommands(body)).toEqual([
      'cd frontend && export NODE_ENV=test && npm run build',
      'npm run test:e2e',
    ]);
  });

  test('single-line compound: cd frontend && npm test is emitted as-is, not dropped', () => {
    const body = [
      '## Verification',
      '```bash',
      'cd frontend && npm test',
      '```',
    ].join('\n');
    // A single compound command starting with `cd` is already self-contained and
    // must not be deferred as setup — it should be emitted verbatim.
    expect(extractIssueVerificationCommands(body)).toEqual(['cd frontend && npm test']);
  });

  test('single-line compound with source prefix: source .env && npm test is emitted as-is', () => {
    const body = [
      '## Verification',
      '```bash',
      'source .env && npm test',
      '```',
    ].join('\n');
    // `source .env && npm test` starts with `source` (a setup keyword) but the
    // compound form is self-contained and must be emitted rather than deferred.
    expect(extractIssueVerificationCommands(body)).toEqual(['source .env && npm test']);
  });
});
