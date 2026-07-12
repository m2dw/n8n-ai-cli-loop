import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseIssuePlanArgs,
  runIssuePlanPreview,
  analyzeIssuePlan,
} from '../dist/cli/issue-plan.js';

const ADMIN_CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let repoRoot;
let sessionsPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'issue-plan-test-'));
  repoRoot = join(tmpDir, 'repo');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeFileSync(sessionsPath, JSON.stringify({
    sessions: [{
      sessionId: 'addon-dev',
      repoKey: 'demo-repo',
      repoRoot,
      githubRepo: 'm2dw/demo-repo',
      artifactDir: '.n8n-artifacts',
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
      verification: {},
      labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    }],
  }));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Read-only fake provider: exposes only readIssue (no write surface).
function makeReader(issue) {
  const calls = [];
  return {
    calls,
    readIssue(repo, issueNumber) {
      calls.push({ method: 'readIssue', repo, issueNumber });
      return { number: issueNumber, ...issue };
    },
  };
}

const SMALL_CLEAR_ISSUE = {
  title: 'Fix typo in README',
  body: [
    'The install section has a typo.',
    '',
    '## Acceptance Criteria',
    '',
    '- The typo is corrected.',
    '- `npm test` passes.',
  ].join('\n'),
  state: 'OPEN',
  labels: ['enhancement'],
  comments: [],
};

async function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(chunks.join('').trim());
}

function runAdmin(...args) {
  try {
    const stdout = execFileSync(process.execPath, [ADMIN_CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe('issue-plan preview — argument parsing', () => {
  test('missing --session-id is rejected', () => {
    expect(parseIssuePlanArgs(['--issue-number', '5'])).toMatchObject({ error: expect.stringContaining('session-id') });
  });

  test('missing --issue-number is rejected', () => {
    expect(parseIssuePlanArgs(['--session-id', 'addon-dev'])).toMatchObject({ error: expect.stringContaining('issue-number') });
  });

  test('non-numeric --issue-number is rejected', () => {
    expect(parseIssuePlanArgs(['--session-id', 'a', '--issue-number', 'x'])).toMatchObject({ error: expect.stringContaining('issue-number') });
  });

  test('valid args parse with default comment limit', () => {
    expect(parseIssuePlanArgs(['--session-id', 'addon-dev', '--issue-number', '5'])).toMatchObject({ sessionId: 'addon-dev', issueNumber: 5, commentLimit: 10 });
  });

  test('--comment-limit is clamped to the max', () => {
    expect(parseIssuePlanArgs(['--session-id', 'a', '--issue-number', '5', '--comment-limit', '999']).commentLimit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Deterministic analyzer
// ---------------------------------------------------------------------------

describe('analyzeIssuePlan — deterministic classification', () => {
  test('small, clear issue with acceptance criteria is ready for implementation', () => {
    const plan = analyzeIssuePlan({
      number: 1,
      title: SMALL_CLEAR_ISSUE.title,
      body: SMALL_CLEAR_ISSUE.body,
      labels: SMALL_CLEAR_ISSUE.labels,
      comments: [],
    });
    expect(plan.decision).toBe('ready');
    expect(plan.readyForImplementation).toBe(true);
    expect(plan.complexity).toBe('low');
    expect(plan.recommendedImplementationEffort).toBe('low');
    expect(plan.recommendedReviewEffort).toBe('low');
    expect(plan.acceptanceCriteria).toEqual(['The typo is corrected.', '`npm test` passes.']);
    expect(plan.source).toBe('heuristic');
  });

  test('identical input yields identical output (reproducible)', () => {
    const input = { number: 1, title: 't', body: SMALL_CLEAR_ISSUE.body, labels: [], comments: [] };
    expect(analyzeIssuePlan(input)).toEqual(analyzeIssuePlan(input));
  });

  test('missing acceptance criteria → needs_clarification', () => {
    const plan = analyzeIssuePlan({ number: 2, title: 'Do a thing', body: 'Please do the thing.', labels: [], comments: [] });
    expect(plan.decision).toBe('needs_clarification');
    expect(plan.readyForImplementation).toBe(false);
    expect(plan.risks.some((r) => /acceptance criteria/i.test(r))).toBe(true);
  });

  test('ambiguous wording → needs_clarification', () => {
    const body = '## Acceptance Criteria\n\n- It works.\n\nThe exact behavior is TBD and somewhat ambiguous.';
    const plan = analyzeIssuePlan({ number: 3, title: 'Thing', body, labels: [], comments: [] });
    expect(plan.decision).toBe('needs_clarification');
  });

  test('blocked by dependency → blocked', () => {
    const body = 'This is blocked by #200.\n\n## Acceptance Criteria\n\n- done';
    const plan = analyzeIssuePlan({ number: 4, title: 'Dependent work', body, labels: [], comments: [] });
    expect(plan.decision).toBe('blocked');
    expect(plan.readyForImplementation).toBe(false);
    expect(plan.risks.some((r) => r.includes('#200'))).toBe(true);
  });

  test('explicit split request → split_required with suggested children', () => {
    const body = [
      'This should be split into smaller pieces.',
      '',
      '## Child Issues',
      '',
      '- Add the data model',
      '- Add the API endpoint',
      '- Add the UI',
      '',
      '## Acceptance Criteria',
      '',
      '- everything works',
    ].join('\n');
    const plan = analyzeIssuePlan({ number: 5, title: 'Big feature', body, labels: [], comments: [] });
    expect(plan.decision).toBe('split_required');
    expect(plan.suggestedChildIssues).toEqual(['Add the data model', 'Add the API endpoint', 'Add the UI']);
  });

  test('workflow-semantics keyword raises risk and flags high_risk', () => {
    const body = 'This changes workflow semantics across the engine.\n\n## Acceptance Criteria\n\n- works';
    const plan = analyzeIssuePlan({ number: 6, title: 'Policy change', body, labels: [], comments: [] });
    expect(plan.decision).toBe('high_risk');
    expect(plan.complexity === 'high' || plan.complexity === 'xhigh').toBe(true);
    expect(plan.risks.some((r) => /workflow semantics/i.test(r))).toBe(true);
  });

  // Calibrated breaking-change negation/affirmation set (issue #341). Only the
  // fixed examples below are in scope; other natural-language variants are
  // follow-up candidates, not asserted here.
  const hasBreakingRisk = (text) =>
    analyzeIssuePlan({ number: 13, title: 'Change', body: `${text}\n\n## Acceptance Criteria\n\n- ok`, labels: [], comments: [] })
      .risks.some((r) => /breaking changes or require a migration/i.test(r));

  test.each([
    'not merely a breaking change',
    'not simply a breaking change',
    'could not be done without a breaking change',
    'not possible to avoid a breaking change',
    // A preceding negation flips the "avoid/without introducing" disclaimer
    // into an assertion that a breaking change is unavoidable (issue #341 review).
    'not possible to avoid introducing a breaking change',
    'could not be done without introducing a breaking change',
  ])('breaking-change risk: %s', (phrase) => {
    expect(hasBreakingRisk(phrase)).toBe(true);
  });

  test.each([
    'does not introduce any breaking change',
    'avoid introducing any breaking change',
    'without introducing a breaking change',
    'non-breaking change',
  ])('not a breaking-change risk: %s', (phrase) => {
    expect(hasBreakingRisk(phrase)).toBe(false);
  });

  // Calibrated auth/token disclaimer set (issue #349). Only the fixed examples
  // below are in scope; other natural-language variants are follow-up
  // candidates, not asserted here.
  const hasSecurityRisk = (text) =>
    analyzeIssuePlan({ number: 14, title: 'Change', body: `${text}\n\n## Acceptance Criteria\n\n- ok`, labels: [], comments: [] })
      .risks.some((r) => /security boundaries or handles untrusted\/credential/i.test(r));

  test.each([
    'OAuth token changes are required',
    'auth work is needed',
    // "not required to be <x>" qualifies the change; it still happens.
    'API key updates are not required to be reversible',
    'OAuth token changes are not required to be backward-compatible',
    // Same "required to be <x>" qualifier in the leading-"no" form.
    'No OAuth token changes are required to be backward-compatible',
  ])('auth/token security signal: %s', (phrase) => {
    expect(hasSecurityRisk(phrase)).toBe(true);
  });

  test.each([
    'OAuth access token changes are not required',
    'no OAuth access token changes are required',
    'auth token changes are not required',
    'no authentication token changes are required',
    'Not in scope: no auth work is needed',
    'This is not a security issue; OAuth access token changes are not required',
  ])('auth/token disclaimer (no security signal): %s', (phrase) => {
    expect(hasSecurityRisk(phrase)).toBe(false);
  });

  // Calibrated security prohibition set (issue #350). Only the fixed examples
  // below are in scope; new natural-language variants are follow-up candidates,
  // not asserted here. Migration-related wording is explicitly out of scope.
  test.each([
    'do not log access tokens',
    'without exposing API keys',
    'no secrets should be exposed',
    'do not store OAuth tokens in plaintext',
    'API keys must not be written to logs',
  ])('security prohibition signal: %s', (phrase) => {
    expect(hasSecurityRisk(phrase)).toBe(true);
  });

  test.each([
    'Document that access tokens should not be logged; no code changes',
    'Update docs for API key handling policy only',
    'No auth work is needed; document current behavior',
  ])('docs-only security prohibition (no security signal): %s', (phrase) => {
    expect(hasSecurityRisk(phrase)).toBe(false);
  });

  // A docs verb that ALSO asks for code work in the same clause is not
  // docs-only; the security implementation signal must survive (issue #350).
  test.each([
    'Document and implement that access tokens should not be logged',
    'Update docs and add code so API keys must not be written to logs',
    'Documentation: implement that OAuth tokens are not stored in plaintext',
  ])('docs verb with implementation work keeps security signal: %s', (phrase) => {
    expect(hasSecurityRisk(phrase)).toBe(true);
  });

  // A docs clause followed by a SEPARATE implementation request keeps the
  // security signal even though the credential keyword sits only in the docs
  // clause (issue #350 review). The "no code changes" form must still suppress.
  test.each([
    'Document that access tokens should not be logged; implement this in the logger',
    'Update docs for API key handling policy only. Then add the redaction code.',
  ])('docs clause with following implementation clause keeps security signal: %s', (phrase) => {
    expect(hasSecurityRisk(phrase)).toBe(true);
  });

  // Calibrated migration required/not-required set (issue #342). Only the fixed
  // examples below are in scope; other natural-language variants are follow-up
  // candidates, not asserted here. Reuses the shared breaking/migration risk row.
  const hasMigrationRisk = (text) =>
    analyzeIssuePlan({ number: 14, title: 'Change', body: `${text}\n\n## Acceptance Criteria\n\n- ok`, labels: [], comments: [] })
      .risks.some((r) => /breaking changes or require a migration/i.test(r));

  test.each([
    'requires a migration',
    'the migration is required',
    'run the migration',
    'apply the migration',
    'schema-migration',
    'data_migration',
    'schema_migration',
    'db_migration',
  ])('migration risk: %s', (phrase) => {
    expect(hasMigrationRisk(phrase)).toBe(true);
  });

  test.each([
    'no schema/data migration is required',
    'A migration is not required',
    'This is not a data migration',
    'does not need to migrate existing data',
    'no need to migrate data',
    'without requiring a migration',
    'no need for a migration',
  ])('not a migration risk: %s', (phrase) => {
    expect(hasMigrationRisk(phrase)).toBe(false);
  });

  // Calibrated missing-migration set (issue #343). Only the fixed examples below
  // are in scope; other natural-language variants are follow-up candidates, not
  // asserted here. Phrasing that reports a migration is missing and asks to add
  // one stays a risk signal; phrasing that disclaims any migration does not.
  test.each([
    'No schema migration exists yet; add one for the new column',
    'No migration file exists; add one',
    'No schema migration is in place; add one',
  ])('missing-migration risk: %s', (phrase) => {
    expect(hasMigrationRisk(phrase)).toBe(true);
  });

  test.each([
    'No migration is required',
    'No schema migration is needed',
    'No migration will be created',
  ])('not a missing-migration risk: %s', (phrase) => {
    expect(hasMigrationRisk(phrase)).toBe(false);
  });

  // Regression (issue #342 review): a `No ...` line must not suppress a real
  // migration requirement on a separate, later line — suppression stays within
  // the same line/clause.
  test('No ... line does not suppress a migration requirement on a later line', () => {
    expect(hasMigrationRisk('No UI changes\nRequires a migration')).toBe(true);
    expect(hasMigrationRisk('No UI changes\nThe migration is required')).toBe(true);
    expect(hasMigrationRisk('Without touching the API\nRun the migration')).toBe(true);
  });

  // Regression (issue #342 review): a disclaimer must bind to the migration
  // clause. An unrelated negated no-need/without-requiring clause earlier on the
  // same line must not consume the intervening words and strip a real same-line
  // migration requirement.
  test('unrelated negated clause does not suppress a same-line migration requirement', () => {
    expect(hasMigrationRisk('No need to update docs but requires a migration')).toBe(true);
    expect(hasMigrationRisk('without requiring UI changes but requires a migration')).toBe(true);
  });

  // Regression (issue #342 review): an affirmative migration requirement that
  // merely contains "no"/"without" must stay a risk signal. A negated "without"
  // disclaimer ("cannot be done without requiring a migration") asserts a
  // migration is unavoidable, and "no downtime migration" uses "no" to modify
  // the noun phrase rather than the requirement.
  test('affirmative migration phrasing containing no/without stays a risk', () => {
    expect(hasMigrationRisk('cannot be done without requiring a migration')).toBe(true);
    expect(hasMigrationRisk('no downtime migration')).toBe(true);
    // The suppression alternatives must not strip affirmative requirements that
    // merely resemble a disclaimer: an adjective-qualified noun phrase, a "not
    // optional" assertion, or a "fail without" condition.
    expect(hasMigrationRisk('no downtime migration is required')).toBe(true);
    expect(hasMigrationRisk('the migration is not optional')).toBe(true);
    expect(hasMigrationRisk('will fail without a migration')).toBe(true);
  });

  // Regression (issue #343 review): the "not a [...] migration" suppression must
  // only strip schema/data migration-type qualifiers. An arbitrary adjective
  // ("not a reversible migration", "not an optional migration") describes
  // required migration work, so it must stay a risk rather than have its only
  // `migration` token suppressed.
  test('adjective-qualified "not a ... migration" stays a risk', () => {
    expect(hasMigrationRisk('this is not a reversible migration')).toBe(true);
    expect(hasMigrationRisk('not an optional migration')).toBe(true);
  });

  // Regression (issue #343 review): the negation that flips a "without ..."
  // disclaimer into an unavoidable-migration assertion must be detected across
  // the whole clause, not just a fixed lookback window. A long intervening
  // clause between the negation and the disclaimer must not drop the migration
  // risk.
  test('negation far before the without-disclaimer still keeps a migration risk', () => {
    expect(
      hasMigrationRisk(
        'cannot safely be completed in the current production environment without requiring a migration',
      ),
    ).toBe(true);
  });

  test('complexity:* label raises but never lowers complexity', () => {
    const raised = analyzeIssuePlan({ number: 7, title: 'Tiny', body: 'small.\n\n## Acceptance Criteria\n\n- ok', labels: ['complexity:xhigh'], comments: [] });
    expect(raised.complexity).toBe('xhigh');
    expect(raised.recommendedImplementationEffort).toBe('xhigh');
    // A low label on a structurally-large issue does not lower it.
    const bigBody = ('x'.repeat(7000)) + '\n\n## Acceptance Criteria\n\n- ok';
    const notLowered = analyzeIssuePlan({ number: 8, title: 'Big', body: bigBody, labels: ['complexity:low'], comments: [] });
    expect(notLowered.complexity).not.toBe('low');
  });

  test('review:* label raises review effort (compatibility hint)', () => {
    const plan = analyzeIssuePlan({ number: 9, title: 'Tiny', body: 'small.\n\n## Acceptance Criteria\n\n- ok', labels: ['review:high'], comments: [] });
    expect(plan.recommendedReviewEffort).toBe('high');
  });

  test('security-sensitive change records a security risk', () => {
    const body = 'Handle untrusted input and rotate the credential token.\n\n## Acceptance Criteria\n\n- ok';
    const plan = analyzeIssuePlan({ number: 10, title: 'Secure it', body, labels: [], comments: [] });
    expect(plan.risks.some((r) => /security|untrusted|credential/i.test(r))).toBe(true);
  });

  test('docs-only issue recommends the docs flow', () => {
    const plan = analyzeIssuePlan({ number: 11, title: 'Docs: clarify setup', body: 'Update docs.\n\n## Acceptance Criteria\n\n- ok', labels: ['documentation'], comments: [] });
    expect(plan.recommendedFlow).toBe('docs');
  });

  test('lists are bounded against hostile input (item count + length)', () => {
    const items = Array.from({ length: 100 }, (_, i) => `- item ${i} ${'y'.repeat(1000)}`).join('\n');
    const body = `## Acceptance Criteria\n\n${items}`;
    const plan = analyzeIssuePlan({ number: 12, title: 'Many', body, labels: [], comments: [] });
    expect(plan.acceptanceCriteria.length).toBeLessThanOrEqual(20);
    for (const it of plan.acceptanceCriteria) expect(it.length).toBeLessThanOrEqual(300);
    expect(plan.risks.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Preview — local artifact contract
// ---------------------------------------------------------------------------

describe('issue-plan preview — local artifact contract', () => {
  test('writes prompt + context artifacts and emits the structured plan inline', async () => {
    const reader = makeReader(SMALL_CLEAR_ISSUE);
    const args = parseIssuePlanArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssuePlanPreview(args, reader));

    expect(out).toMatchObject({
      ok: true,
      sessionId: 'addon-dev',
      repo: 'm2dw/demo-repo',
      issueNumber: 42,
      issueState: 'OPEN',
      posted: false,
      decision: 'ready',
      readyForImplementation: true,
    });
    // The emitted result identifies the required fields.
    expect(out.plan).toMatchObject({
      decision: 'ready',
      complexity: 'low',
      recommendedImplementationEffort: 'low',
      recommendedReviewEffort: 'low',
      recommendedFlow: 'code',
    });
    expect(Array.isArray(out.plan.risks)).toBe(true);
    expect(Array.isArray(out.plan.suggestedChildIssues)).toBe(true);
    expect(existsSync(out.artifacts.prompt)).toBe(true);
    expect(existsSync(out.artifacts.context)).toBe(true);
    expect(out.artifactDir).toContain('issue-42');
  });

  test('context JSON embeds the plan, fingerprint, and isolation metadata', async () => {
    const reader = makeReader(SMALL_CLEAR_ISSUE);
    const args = parseIssuePlanArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssuePlanPreview(args, reader));
    const context = JSON.parse(readFileSync(out.artifacts.context, 'utf8'));

    expect(context.plan).toMatchObject({ decision: 'ready', source: 'heuristic' });
    expect(typeof context.fingerprint).toBe('string');
    expect(context.fingerprint).toHaveLength(64);
    expect(context.isolation.analysis).toBe('deterministic-heuristic-no-agent');
    expect(context.isolation.posted).toBe(false);
    expect(context.isolation.writeEnvKeysStripped).toContain('GH_TOKEN');
  });

  test('the prompt embeds the heuristic baseline and a preview-only instruction', async () => {
    const reader = makeReader(SMALL_CLEAR_ISSUE);
    const args = parseIssuePlanArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssuePlanPreview(args, reader));
    const prompt = readFileSync(out.artifacts.prompt, 'utf8');
    expect(prompt).toContain('Heuristic Baseline');
    expect(prompt).toContain('PREVIEW ONLY');
    expect(prompt).toContain('UNTRUSTED');
  });

  test('the reader is only ever asked to read — no write surface exists', async () => {
    const reader = makeReader(SMALL_CLEAR_ISSUE);
    const args = parseIssuePlanArgs(['--session-id', 'addon-dev', '--issue-number', '42', '--sessions-path', sessionsPath]);
    await capture(() => runIssuePlanPreview(args, reader));
    expect(reader.calls).toEqual([{ method: 'readIssue', repo: 'm2dw/demo-repo', issueNumber: 42 }]);
    expect(Object.keys(reader).filter((k) => k !== 'calls')).toEqual(['readIssue']);
  });

  test('a long body is truncated to a bounded size', async () => {
    const reader = makeReader({ ...SMALL_CLEAR_ISSUE, body: 'x'.repeat(20000) });
    const args = parseIssuePlanArgs(['--session-id', 'addon-dev', '--issue-number', '7', '--sessions-path', sessionsPath]);
    const out = await capture(() => runIssuePlanPreview(args, reader));
    const context = JSON.parse(readFileSync(out.artifacts.context, 'utf8'));
    expect(out.bodyTruncated).toBe(true);
    expect(context.body.length).toBeLessThan(20000);
  });

  test('failure to read issue is fail-closed and reported as JSON', async () => {
    const throwingReader = { readIssue() { throw new Error('simulated network failure'); } };
    const args = parseIssuePlanArgs(['--session-id', 'addon-dev', '--issue-number', '7', '--sessions-path', sessionsPath]);

    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
    let exitCode = null;
    const origExit = process.exit.bind(process);
    process.exit = (code) => { exitCode = code; throw new Error('process.exit intercepted'); };
    try {
      await runIssuePlanPreview(args, throwingReader);
    } catch {
      // expected — we intercepted process.exit
    } finally {
      process.stdout.write = orig;
      process.exit = origExit;
    }
    const output = JSON.parse(chunks.join('').trim());
    expect(output.ok).toBe(false);
    expect(output.error).toContain('simulated network failure');
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Admin CLI integration
// ---------------------------------------------------------------------------

describe('issue-plan preview — admin CLI integration', () => {
  test('appears in admin help output', () => {
    const r = runAdmin('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('issue-plan preview');
  });

  test('"help issue-plan preview" documents required flags', () => {
    const r = runAdmin('help', 'issue-plan', 'preview');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--session-id');
    expect(r.stdout).toContain('--issue-number');
  });

  test('missing --session-id exits non-zero', () => {
    const r = runAdmin('issue-plan', 'preview', '--issue-number', '5', '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('unknown issue-plan action exits non-zero', () => {
    const r = runAdmin('issue-plan', 'bogus');
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });
});
