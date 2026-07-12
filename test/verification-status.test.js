import { buildIssueVerificationStatus } from '../dist/handlers/verification.js';

describe('buildIssueVerificationStatus', () => {
  test('exact match marks command as passed', () => {
    const result = buildIssueVerificationStatus(
      ['npm test'],
      { test: 'npm test' },
    );
    expect(result).toEqual([{ command: 'npm test', status: 'passed' }]);
  });

  test('unmatched command is marked not_run', () => {
    const result = buildIssueVerificationStatus(
      ['npm run e2e'],
      { test: 'npm test' },
    );
    expect(result).toEqual([{ command: 'npm run e2e', status: 'not_run' }]);
  });

  test('shell-wrapped bash -lc equivalent matches the required compound command', () => {
    // The extractor records `cd frontend && npm test` but the session runner
    // may store a shell-wrapped form such as `bash -lc 'cd frontend && npm test'`
    // to allow `cd` to work via execFile.  Both must be treated as equivalent.
    const result = buildIssueVerificationStatus(
      ['cd frontend && npm test'],
      { e2e: "bash -lc 'cd frontend && npm test'" },
    );
    expect(result).toEqual([{ command: 'cd frontend && npm test', status: 'passed' }]);
  });

  test('bash -c double-quoted wrapper also matches', () => {
    const result = buildIssueVerificationStatus(
      ['cd packages/api && npm test'],
      { api: 'bash -c "cd packages/api && npm test"' },
    );
    expect(result).toEqual([{ command: 'cd packages/api && npm test', status: 'passed' }]);
  });

  test('sh -c wrapper matches', () => {
    const result = buildIssueVerificationStatus(
      ['cd backend && npm run test:e2e'],
      { e2e: "sh -c 'cd backend && npm run test:e2e'" },
    );
    expect(result).toEqual([{ command: 'cd backend && npm run test:e2e', status: 'passed' }]);
  });

  test('shell-wrapped command with combined flags (bash -lc) matches', () => {
    const result = buildIssueVerificationStatus(
      ['npm run test:e2e'],
      { e2e: "bash -lc 'npm run test:e2e'" },
    );
    expect(result).toEqual([{ command: 'npm run test:e2e', status: 'passed' }]);
  });

  test('shell wrapper with different inner command does not match', () => {
    const result = buildIssueVerificationStatus(
      ['cd frontend && npm test'],
      { e2e: "bash -lc 'cd backend && npm test'" },
    );
    expect(result).toEqual([{ command: 'cd frontend && npm test', status: 'not_run' }]);
  });

  test('multiple commands: some matched, some not', () => {
    const result = buildIssueVerificationStatus(
      ['npm run build', 'npm run test:e2e'],
      { build: 'npm run build' },
    );
    expect(result).toEqual([
      { command: 'npm run build', status: 'passed' },
      { command: 'npm run test:e2e', status: 'not_run' },
    ]);
  });

  test('whitespace trimming: match succeeds when values have surrounding spaces', () => {
    const result = buildIssueVerificationStatus(
      [' npm test '],
      { test: '  npm test  ' },
    );
    expect(result).toEqual([{ command: ' npm test ', status: 'passed' }]);
  });
});

describe('buildIssueVerificationStatus — manual evidence', () => {
  const passingEvidence = (command) => ({
    command,
    exitCode: 0,
    output: 'all tests passed',
    recordedAt: '2026-01-01T00:00:00.000Z',
    source: 'operator_input',
  });

  const failingEvidence = (command) => ({
    command,
    exitCode: 1,
    output: 'error: test failed',
    recordedAt: '2026-01-01T00:00:00.000Z',
    source: 'operator_input',
  });

  test('passing manual evidence satisfies a not_run required command', () => {
    const result = buildIssueVerificationStatus(
      ['npm run export -- --dry-run'],
      {},
      [passingEvidence('npm run export -- --dry-run')],
    );
    expect(result).toEqual([{ command: 'npm run export -- --dry-run', status: 'passed' }]);
  });

  test('failing manual evidence (exitCode != 0) does NOT satisfy a not_run command', () => {
    const result = buildIssueVerificationStatus(
      ['npm run export -- --dry-run'],
      {},
      [failingEvidence('npm run export -- --dry-run')],
    );
    expect(result).toEqual([{ command: 'npm run export -- --dry-run', status: 'not_run' }]);
  });

  test('session verification takes precedence over manual evidence', () => {
    const result = buildIssueVerificationStatus(
      ['npm test'],
      { test: 'npm test' },
      [passingEvidence('npm test')],
    );
    expect(result).toEqual([{ command: 'npm test', status: 'passed' }]);
  });

  test('manual evidence for one command does not affect other commands', () => {
    const result = buildIssueVerificationStatus(
      ['npm run build', 'npm run export -- --dry-run'],
      { build: 'npm run build' },
      [passingEvidence('npm run export -- --dry-run')],
    );
    expect(result).toEqual([
      { command: 'npm run build', status: 'passed' },
      { command: 'npm run export -- --dry-run', status: 'passed' },
    ]);
  });

  test('empty manual evidence leaves not_run commands unchanged', () => {
    const result = buildIssueVerificationStatus(
      ['npm run export -- --dry-run'],
      {},
      [],
    );
    expect(result).toEqual([{ command: 'npm run export -- --dry-run', status: 'not_run' }]);
  });

  test('undefined manual evidence leaves not_run commands unchanged', () => {
    const result = buildIssueVerificationStatus(
      ['npm run export -- --dry-run'],
      {},
      undefined,
    );
    expect(result).toEqual([{ command: 'npm run export -- --dry-run', status: 'not_run' }]);
  });
});
