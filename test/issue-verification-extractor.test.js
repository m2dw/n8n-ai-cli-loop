import {
  extractIssueVerificationCommands,
  extractIssueVerificationSections,
} from '../dist/handlers/issue-verification-extractor.js';

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

  describe('assignment-only detection is linear-time (issue #1190)', () => {
    // The former assignment-only regex let each repetition end inside a
    // whitespace-free run, so `A=A=…A= x` backtracked exponentially: ~320 ms
    // at 24 repetitions, and hours at the 40 used here. The bound is generous
    // so host load cannot flake it; a regression does not finish at all.
    const MAX_MS = 2000;

    function timed(fn) {
      const start = Date.now();
      const result = fn();
      return { result, elapsed: Date.now() - start };
    }

    test('repeated A= assignments with a trailing malformed token in a bash fence', () => {
      const adversarial = 'A='.repeat(40) + ' x';
      const body = ['## Verification', '```bash', adversarial, 'npm test', '```'].join('\n');
      const { result, elapsed } = timed(() => extractIssueVerificationCommands(body));
      // Not assignment-only, so a tagged shell fence records it as a command.
      expect(result).toEqual([adversarial, 'npm test']);
      expect(elapsed).toBeLessThan(MAX_MS);
    });

    test('repeated A= assignments with a trailing malformed token in an untagged fence', () => {
      const adversarial = 'A='.repeat(40) + ' !';
      const body = ['## Verification', '```', 'npm test', adversarial, 'npm run build', '```'].join('\n');
      const { result, elapsed } = timed(() => extractIssueVerificationCommands(body));
      // Not assignment-only and not a recognisable command: dropped, and it
      // does not attach itself as setup to the following command.
      expect(result).toEqual(['npm test', 'npm run build']);
      expect(elapsed).toBeLessThan(MAX_MS);
    });

    test('repeated A= assignments behind a transcript prompt', () => {
      const adversarial = 'A='.repeat(40) + ' x';
      const body = ['## Verification', '```console', `$ ${adversarial}`, '```'].join('\n');
      const { result, elapsed } = timed(() => extractIssueVerificationCommands(body));
      expect(result).toEqual([adversarial]);
      expect(elapsed).toBeLessThan(MAX_MS);
    });

    test('very long lines stay fast', () => {
      const malformed = 'A='.repeat(50_000) + ' x';
      const assignmentsOnly = 'A=1 '.repeat(20_000) + 'B=A=A=';
      const prefixed = 'A=1 '.repeat(20_000) + 'npm test';
      const body = ['## Verification', '```', malformed, assignmentsOnly, 'npm test', prefixed, '```'].join('\n');
      const { result, elapsed } = timed(() => extractIssueVerificationCommands(body));
      expect(result).toEqual([`${assignmentsOnly} && npm test`, prefixed]);
      expect(elapsed).toBeLessThan(MAX_MS);
    });

    test('assignment-only lines are deferred as setup, including chained and empty values', () => {
      const body = [
        '## Verification',
        '```bash',
        'A=1 B= C=x=y',
        'npm test',
        '```',
      ].join('\n');
      expect(extractIssueVerificationCommands(body)).toEqual(['A=1 B= C=x=y && npm test']);
    });

    test('a trailing non-assignment token makes the line a command, not setup', () => {
      const body = [
        '## Verification',
        '```bash',
        'A=1 B=2 npm test',
        'A=1 1B=2',
        '```',
      ].join('\n');
      // `1B=2` is not a valid assignment name, so the second line is an
      // ordinary line of a tagged shell fence rather than deferred setup.
      expect(extractIssueVerificationCommands(body)).toEqual(['A=1 B=2 npm test', 'A=1 1B=2']);
    });

    test('assignment-prefixed inline commands are still extracted', () => {
      const body = [
        '## Verification',
        '- `CI=1 NODE_ENV=test npm test`',
        '- `CI=1`',
        '- `' + 'A='.repeat(40) + ' x`',
      ].join('\n');
      expect(extractIssueVerificationCommands(body)).toEqual(['CI=1 NODE_ENV=test npm test']);
    });
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

  test('issue #569/#993 regression: command marked "not required" in a trailing caveat is excluded', () => {
    const body = [
      '## Verification',
      '',
      '- `npm run typecheck`',
      '- `npm test`',
      '- `npm run validate`',
      '- `npm run build`',
      '- `node internal/qa/gen-workbook.mjs` when QA data is updated',
      '',
      '`npm run validate:release` may remain blocked by unresolved production data and is not required by this Issue.',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual([
      'npm run typecheck',
      'npm test',
      'npm run validate',
      'npm run build',
      'node internal/qa/gen-workbook.mjs',
    ]);
  });

  test('"out of scope" marker also excludes a caveat command from the required list', () => {
    const body = [
      '## Verification',
      '- `npm test`',
      '',
      '`npm run e2e:prod` is out of scope for this Issue.',
    ].join('\n');
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test']);
  });

  test('a command marked "not required" does not suppress the same command required elsewhere', () => {
    const body = [
      '## Verification',
      '- `npm test`',
      '',
      '`npm test` is not required to be re-run manually here.',
    ].join('\n');
    // The marker line still wins: an author who wants a command required must
    // not also describe it with "not required" elsewhere in the section.
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('issue #993 follow-up: a fenced Markdown sample quoting "## Verification" inside a non-verification section extracts nothing', () => {
    const body = [
      '## Regression fixture',
      '',
      'Use the #569 shape:',
      '',
      '```md',
      '## Verification',
      '',
      '- `npm run typecheck`',
      '- `npm test`',
      '- `npm run validate`',
      '- `npm run build`',
      '- `node internal/qa/gen-workbook.mjs` when QA data is updated',
      '',
      '`npm run validate:release` may remain blocked by unresolved production data and is not required by this Issue.',
      '```',
      '',
      '## Acceptance criteria',
      '- A regression test reproduces the #569 false positive.',
    ].join('\n');
    // The fenced sample is illustrative content inside "Regression fixture", not
    // a real task-level Verification section — none of its commands (required
    // or excluded) may be extracted for the enclosing Issue.
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('issue #993 review follow-up: a nested ```md fence inside a four-backtick sample does not leak commands', () => {
    const body = [
      '## Regression fixture',
      '',
      'Use the #569 shape, quoted here as a four-backtick sample so it can',
      'itself contain a fenced ```md block:',
      '',
      '````md',
      'This is what the Issue body looks like:',
      '',
      '```md',
      '## Verification',
      '',
      '- `npm test`',
      '```',
      '````',
      '',
      '## Acceptance criteria',
      '- A regression test reproduces the nested-fence false positive.',
    ].join('\n');
    // The inner ```md fence must not be read as closing the outer four-backtick
    // fence — the ## Verification heading and `npm test` command it contains
    // are illustrative content, not a real task-level Verification section.
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('issue #993 review follow-up: an inner "```md" line with an info string does not close an already-open same-length fence', () => {
    const body = [
      '## Regression fixture',
      '',
      'Use the #569 shape, quoted here:',
      '',
      '```',
      'This is what the Issue body looks like:',
      '',
      '```md',
      '## Verification',
      '',
      '- `npm test`',
      '```',
      '```',
      '',
      '## Acceptance criteria',
      '- A regression test reproduces the false-close false positive.',
    ].join('\n');
    // A closing fence delimiter may only have whitespace after its backtick
    // run (CommonMark). The nested "```md" line has an info string ("md"), so
    // it must NOT close the already-open outer fence — the "## Verification"
    // heading and `npm test` command inside it are illustrative content, not
    // a real task-level Verification section.
    expect(extractIssueVerificationCommands(body)).toEqual([]);
  });

  test('review feedback: a required command sharing a line with an unrelated caveat is still extracted', () => {
    const body = [
      '## Verification',
      'Run `npm test` and `npm run lint`; `npm run e2e` is not required.',
    ].join('\n');
    // The not-required marker must be scoped to its own clause (after the
    // `;`) so it does not sweep up the required commands earlier on the line.
    expect(extractIssueVerificationCommands(body)).toEqual(['npm test', 'npm run lint']);
  });

  test('review feedback: an inline required command containing a semicolon is extracted intact', () => {
    const body = [
      '## Verification',
      '- `npm run lint; npm test`',
      '',
      '`npm run validate:release` is not required by this Issue.',
    ].join('\n');
    // Clause splitting must not land inside the backtick span: the `;` inside
    // `npm run lint; npm test` must not be treated as a clause boundary, or
    // the command's opening and closing backticks end up in separate clauses
    // and neither fragment matches the inline-code regex.
    expect(extractIssueVerificationCommands(body)).toEqual(['npm run lint; npm test']);
  });
});

// Issue #1041: the same scan, reporting whether a supported section existed.
// A live refresh needs to tell "this Issue requires nothing" apart from "this
// body has no verification section", because only the first is a removal.
describe('extractIssueVerificationSections', () => {
  test('returns the same commands as the command-only entry point', () => {
    const body = ['## Verification', '- `npm test`', '- `npm run lint`'].join('\n');
    const extraction = extractIssueVerificationSections(body);
    expect(extraction.commands).toEqual(extractIssueVerificationCommands(body));
    expect(extraction.sectionFound).toBe(true);
  });

  test('reports a section that lists no command as found', () => {
    const body = ['## Verification', 'Nothing is required for this change.'].join('\n');
    expect(extractIssueVerificationSections(body)).toEqual({ commands: [], sectionFound: true });
  });

  test('reports a body with no supported section as not found', () => {
    const body = ['## Background', 'prose about `npm test` outside any section.'].join('\n');
    expect(extractIssueVerificationSections(body)).toEqual({ commands: [], sectionFound: false });
  });

  test('a heading inside a fenced sample does not count as a section', () => {
    const body = [
      '## Background',
      '```md',
      '## Verification',
      '- `npm test`',
      '```',
    ].join('\n');
    expect(extractIssueVerificationSections(body).sectionFound).toBe(false);
  });
});
