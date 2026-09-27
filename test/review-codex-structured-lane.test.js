/**
 * The §17.11 routed lane (issue #1069): an enabled session's Codex review runs
 * the runner-authored `codex exec` invocation, and its envelope is admitted into
 * the ordinary lineage/fix-disposition protocol.
 *
 * Everything here goes through the REAL review handler and the REAL adapter. The
 * only thing swapped is the binary NAME: the profile resolves `codex`, and the
 * test's runner spawns a `/bin/sh` fixture instead — asserting on the way through
 * that the command it was asked to run was `codex`, and that the argv it was
 * handed is the one the production path constructs. Resolving the real binary
 * from PATH would risk a genuinely billed turn on a host that has Codex
 * installed, which no test may do.
 *
 * What is deliberately NOT stubbed: the profile resolution, the argv, the prompt
 * (brief + diff + envelope contract), the run-owned temp directory, the bounded
 * read of `--output-last-message`, envelope admission, lineage derivation,
 * evidence resolution against the reviewed checkout, the §10.2 artifact, and the
 * persisted §10.1 block. An injected result would prove none of them.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReviewHandler as _createReviewHandler } from '../dist/handlers/review.js';
import { bothStreamsCommandRunner } from '../dist/handlers/command-runner.js';
import {
  REVIEW_FINDINGS_END_MARKER,
  REVIEW_FINDINGS_MARKER,
} from '../dist/core/review-finding-envelope.js';
import {
  buildFixDispositionPromptSection,
  parseFindingsArtifact,
  resolveFixPromptFindings,
} from '../dist/core/review-fix-disposition-prompt.js';

let tmpDir;
let repoRoot;
let artifactRoot;
let fixtureSeq = 0;

const worktreePath = () => join(tmpDir, 'worktrees', 'addon-dev', 'issue-77');
const runDir = () => join(artifactRoot, 'runs', 'run-review-1');

function fakeWorktreeResolver(path) {
  return (input) => ({
    ok: true,
    path,
    worktreeId: `${input.sessionId}/issue-${input.issueNumber}`,
    branch: input.branch,
    created: false,
    branchReused: true,
  });
}

function fakeLock() {
  return {
    acquire: () => ({ ok: true, locked: true, contextId: 'run-review-1', sessionId: 'addon-dev' }),
    release: () => ({ ok: true, released: true }),
  };
}

// ---------------------------------------------------------------------------
// The subprocess fixture — a `/bin/sh` stand-in for `codex`
// ---------------------------------------------------------------------------

/**
 * Drains stdin before anything else: the prompt is delivered through
 * `spawnSync`'s `input`, and a child that exits without reading it can race
 * Node's pipe write into a spurious EPIPE on an otherwise-successful run.
 */
function makeFakeCodex({ exitCode = 0, writeOutput = true, response = null, stderrText = '' } = {}) {
  const dir = join(tmpDir, `fake-codex-${fixtureSeq++}`);
  mkdirSync(dir, { recursive: true });
  if (response !== null) writeFileSync(join(dir, 'response.txt'), response, 'utf8');
  if (stderrText !== '') writeFileSync(join(dir, 'stderr.txt'), stderrText, 'utf8');
  const lines = [
    '#!/bin/sh',
    `DIR='${dir}'`,
    "out=''",
    "prev=''",
    'for a in "$@"; do',
    '  case "$prev" in',
    '    --output-last-message) out="$a" ;;',
    '  esac',
    '  prev="$a"',
    'done',
    `printf '%s\\n' "$@" > "$DIR/argv.txt"`,
    'cat > "$DIR/stdin.txt"',
    'if [ -f "$DIR/stderr.txt" ]; then cat "$DIR/stderr.txt" >&2; fi',
    ...(writeOutput
      ? ['if [ -f "$DIR/response.txt" ] && [ -n "$out" ]; then cat "$DIR/response.txt" > "$out"; fi']
      : []),
    `exit ${exitCode}`,
  ];
  const bin = join(dir, 'codex-fixture');
  writeFileSync(bin, `${lines.join('\n')}\n`, 'utf8');
  chmodSync(bin, 0o755);
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
  return {
    bin,
    stdin: () => read('stdin.txt'),
    argv: () => {
      const raw = read('argv.txt');
      return raw === null ? null : raw.split('\n').filter((line) => line !== '');
    },
  };
}

/**
 * The handler's structured-review seam, spawning the fixture through the REAL
 * default runner the adapter would otherwise use.
 */
function spawningRunner(fake, calls) {
  return {
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return bothStreamsCommandRunner.run(fake.bin, args, opts);
    },
  };
}

/** Records every call and never spawns — for the paths that must NOT reach a CLI. */
function neverRuns(calls) {
  return {
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      throw new Error('the structured Codex lane must not have been invoked here');
    },
  };
}

// ---------------------------------------------------------------------------
// Session / task / runner fixtures
// ---------------------------------------------------------------------------

const SESSION = (overrides = {}) => ({
  sessionId: 'addon-dev',
  repoKey: 'test-repo',
  repoRoot,
  githubRepo: 'm2dw/test-repo',
  artifactDir: '.n8n-artifacts',
  artifactRoot,
  githubOwner: 'm2dw',
  githubName: 'test-repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  reviewDispute: { enabled: true },
  ...overrides,
});

const CONTEXT = (session = SESSION()) => ({ session, runId: 'run-review-1', workerId: 'worker-test' });

function makeTask(contextOverrides = {}) {
  return {
    sessionId: 'addon-dev',
    issueNumber: 77,
    status: 'running',
    phase: 'review',
    priority: 'normal',
    reviewAgent: 'codex',
    attempts: {},
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      prUrl: 'https://github.com/m2dw/test-repo/pull/99',
      branch: 'ai/issue-77-run-impl-1',
      labels: ['agent:codex', 'status:needs-review'],
      ...contextOverrides,
    },
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  };
}

function sequenceRunner(steps) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(cmd, args, opts) {
      const result = steps[i] ?? { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      calls.push({ cmd, args, opts });
      i++;
      return result;
    },
  };
}

const PR_VIEW = {
  stdout: JSON.stringify({
    number: 99,
    url: 'https://github.com/m2dw/test-repo/pull/99',
    headRefName: 'ai/issue-77-run-impl-1',
    baseRefName: 'main',
    state: 'OPEN',
    isCrossRepository: false,
  }),
  stderr: '',
  exitCode: 0,
};

const DIFF = 'diff --git a/src/handlers/review.ts b/src/handlers/review.ts\n+// changed\n';

/** One tracked regular file, in `git ls-files -s` format. */
const LS_FILES = {
  stdout: '100644 0000000000000000000000000000000000000000 0\tsrc/handlers/review.ts\n',
  stderr: '',
  exitCode: 0,
};

/**
 * The git/gh/npm calls the handler itself issues, in order. The review agent is
 * NOT among them on this lane — the adapter owns that subprocess.
 */
function gitRunner({ diff = DIFF, promptDiff, verification, promptDiffExit = 0, tail = [] } = {}) {
  return sequenceRunner([
    PR_VIEW,                                                          // gh pr view
    { stdout: '', stderr: '', exitCode: 0 },                          // git fetch
    { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 },     // git rev-parse
    { stdout: '', stderr: '', exitCode: 0 },                          // git pull --ff-only
    { stdout: '0', stderr: '', exitCode: 0 },                         // git rev-list --count
    { stdout: '', stderr: '', exitCode: 0 },                          // git status (preflight)
    { stdout: diff, stderr: '', exitCode: 0 },                        // git diff (classification)
    verification ?? { stdout: 'All tests passed.', stderr: '', exitCode: 0 }, // npm test
    { stdout: promptDiffExit === 0 ? (promptDiff ?? diff) : '', stderr: promptDiffExit === 0 ? '' : 'fatal: bad revision', exitCode: promptDiffExit }, // git diff (prompt)
    { stdout: '', stderr: '', exitCode: 0 },                          // git status (post-review)
    ...tail,
  ]);
}

const envelope = (body) => `${REVIEW_FINDINGS_MARKER}\n${JSON.stringify(body)}\n${REVIEW_FINDINGS_END_MARKER}\n`;

const FINDING = {
  version: 1,
  severity: 'P1',
  violatedContract: 'Acceptance criterion: the fix must reject an unauthenticated caller',
  preconditions: 'A request arrives with no session cookie',
  failureScenario: 'The handler returns 200 and the caller reads another tenant rate-limit state',
  affectedBoundary: 'src/handlers/review.ts',
  requiredOutcome: 'An unauthenticated request must be rejected with 401 before any state read',
  evidenceRefs: [{ kind: 'file', path: 'src/handlers/review.ts', startLine: 10, endLine: 20 }],
};

function runReview({ runner, structuredReviewRunner, session = SESSION(), task = makeTask() }) {
  return _createReviewHandler(
    CONTEXT(session),
    runner,
    fakeWorktreeResolver(worktreePath()),
    fakeLock(),
    undefined,
    undefined,
    structuredReviewRunner === undefined ? {} : { structuredReviewRunner },
  )(task);
}

// The lane resolves its model and effort from the environment first (§17.7), so
// an operator variable on the host running the suite would otherwise decide what
// the argv assertions below see. Cleared and restored per test.
const CODEX_ENV_KEYS = ['CODEX_MODEL', 'CODEX_EFFORT'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(CODEX_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of CODEX_ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'review-codex-lane-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  // A `file` reference names lines INSIDE a document, so the resolver reads the
  // reviewed checkout to check them: the cited path has to exist there, with the
  // cited range inside it.
  mkdirSync(join(worktreePath(), 'src', 'handlers'), { recursive: true });
  writeFileSync(
    join(worktreePath(), 'src', 'handlers', 'review.ts'),
    `${Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`,
    'utf8',
  );
});

afterEach(() => {
  for (const k of CODEX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Command construction — the default path, not a stub of it
// ---------------------------------------------------------------------------

describe('§17.11 — the invocation the enabled lane actually constructs', () => {
  test('spawns `codex exec` with the pinned flags, and never `codex review`', async () => {
    const fake = makeFakeCodex({ response: envelope({ version: 1, status: 'success' }) });
    const calls = [];
    const runner = gitRunner();
    const result = await runReview({ runner, structuredReviewRunner: spawningRunner(fake, calls) });

    expect(result.result).toBe('success');
    // The command the handler ASKED for is `codex`; only the test's runner
    // redirected it, so the profile's own resolution is what is under test.
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('codex');
    const argv = fake.argv();
    // Anchored on the subcommand: `--model` and `--profile` are GLOBAL Codex
    // options and precede it when they are resolved at all.
    expect(argv.indexOf('exec')).toBe(0);
    expect(argv.slice(0, 6)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--json',
    ]);
    expect(argv).toContain('--output-last-message');
    // §17.7's effort row: an unlabelled review resolves to `high`, and the model
    // stays absent when the session configures none.
    expect(argv).toContain('model_reasoning_effort=high');
    expect(argv).not.toContain('--model');
    // C6 is still `vendor-documented`, so the schema flag stays off by default.
    expect(argv).not.toContain('--output-schema');
    // Never the native review subcommand, and never a bypass.
    expect(argv).not.toContain('review');
    expect(argv.join(' ')).not.toContain('--dangerously');
    expect(runner.calls.some((c) => c.cmd === 'codex')).toBe(false);
  }, 30_000);

  test('the prompt travels on stdin and carries the brief, the diff and the §2.1 contract exactly once', async () => {
    const fake = makeFakeCodex({ response: envelope({ version: 1, status: 'success' }) });
    const calls = [];
    await runReview({ runner: gitRunner(), structuredReviewRunner: spawningRunner(fake, calls) });

    const stdin = fake.stdin();
    // Authoritative Issue context and the review base's diff.
    expect(stdin).toContain('Issue #77: Add login rate limiting');
    expect(stdin).toContain('## PR Diff');
    expect(stdin).toContain('+// changed');
    expect(stdin).toContain('## Verification Results');
    // The output contract, once — the brief builder must not add a second copy.
    expect(stdin.split('## Structured Finding Output (required)')).toHaveLength(2);
    expect(stdin).toContain(REVIEW_FINDINGS_MARKER);
    // And none of it in argv, where it would be visible in a process listing.
    expect(fake.argv().join(' ')).not.toContain('Structured Finding Output');
  }, 30_000);

  test('the run records which lane produced the verdict', async () => {
    const fake = makeFakeCodex({ response: envelope({ version: 1, status: 'success' }) });
    await runReview({ runner: gitRunner(), structuredReviewRunner: spawningRunner(fake, []) });
    const record = JSON.parse(readFileSync(join(runDir(), 'review-result.json'), 'utf8'));
    expect(record.reviewInvocation).toBe('codex-structured');
    // The adapter's own summary is preserved beside it, argv and all.
    const summary = JSON.parse(readFileSync(join(runDir(), 'codex-structured-review.json'), 'utf8'));
    expect(summary.profile.role).toBe('structured-review');
    expect(summary.profile.toolPolicy).toBe('read-bounded');
    expect(summary.envelope).toMatchObject({ status: 'success', findings: 0 });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Admission — the envelope reaching lineage state and the fix prompt
// ---------------------------------------------------------------------------

describe('§17.11 — admission into the existing protocol', () => {
  test('a `success` envelope with no findings passes and opens no lineage', async () => {
    const fake = makeFakeCodex({ response: envelope({ version: 1, status: 'success' }) });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('success');
    expect(result.context.reviewFindings).toMatchObject({
      mode: 'admitted',
      agentId: 'codex',
      invocation: 'codex-structured',
      status: 'success',
      admitted: 0,
    });
    expect(Object.keys(result.context.reviewDispute.lineages)).toHaveLength(0);
    // Admission succeeded, so the §10.2 artifact is written exactly as on any
    // other admitted review — and it carries no records, because this envelope
    // raised none. An empty records file and a missing one are different facts:
    // the first says the lane ran and found nothing.
    expect(parseFindingsArtifact(readFileSync(join(runDir(), 'review-findings.json'), 'utf8'))).toEqual([]);
  }, 30_000);

  test('a finding reaches the persisted lineage, the records artifact, and the Claude fix prompt', async () => {
    const fake = makeFakeCodex({
      response: envelope({ version: 1, status: 'findings', findings: [FINDING] }),
    });
    const result = await runReview({
      runner: gitRunner({ tail: [LS_FILES] }),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('needs_fix');
    expect(result.context.reviewFindings).toMatchObject({
      mode: 'admitted',
      agentId: 'codex',
      invocation: 'codex-structured',
      status: 'findings',
      admitted: 1,
    });

    // §10.1: one open lineage, minted from the finding's own identity tuple.
    const lineages = Object.values(result.context.reviewDispute.lineages);
    expect(lineages).toHaveLength(1);
    expect(lineages[0]).toMatchObject({ state: 'open', version: 1, severity: 'P1' });
    expect(result.context.reviewArtifactDir).toBe(runDir());

    // §10.2: the full record, written as a pair with the lineage.
    const artifact = readFileSync(join(runDir(), 'review-findings.json'), 'utf8');
    const parsed = parseFindingsArtifact(artifact);
    expect(parsed.map((f) => f.lineageId)).toEqual([lineages[0].lineageId]);

    // And the next implementation run's fix prompt carries it, disposition
    // vocabulary and all — the §3.1 contract, unchanged by which reviewer raised it.
    const section = buildFixDispositionPromptSection(
      resolveFixPromptFindings(result.context.reviewDispute, parsed),
    );
    expect(section).not.toBeNull();
    const rendered = [...section.header, ...section.dataBlock, ...section.footer].join('\n');
    expect(rendered).toContain(lineages[0].lineageId);
    expect(rendered).toContain('Acceptance criterion: the fix must reject an unauthenticated caller');
    expect(rendered).toContain('review_disputed');
  }, 30_000);

  test('a re-raise of an open lineage attaches to it instead of opening a second', async () => {
    // First cycle: the finding opens a lineage.
    const first = await runReview({
      runner: gitRunner({ tail: [LS_FILES] }),
      structuredReviewRunner: spawningRunner(
        makeFakeCodex({ response: envelope({ version: 1, status: 'findings', findings: [FINDING] }) }),
        [],
      ),
    });
    const lineageId = Object.keys(first.context.reviewDispute.lineages)[0];

    // Second cycle: the same defect, echoing the id it belongs to (§2.2).
    const fake = makeFakeCodex({
      response: envelope({
        version: 1,
        status: 'findings',
        findings: [{ ...FINDING, lineageId }],
      }),
    });
    const second = await runReview({
      runner: gitRunner({ tail: [LS_FILES] }),
      structuredReviewRunner: spawningRunner(fake, []),
      task: makeTask({ reviewDispute: first.context.reviewDispute }),
    });

    expect(second.result).toBe('needs_fix');
    expect(second.context.reviewFindings).toMatchObject({
      mode: 'admitted',
      admitted: 0,
      attachedLineages: [lineageId],
    });
    expect(Object.keys(second.context.reviewDispute.lineages)).toEqual([lineageId]);
    // The reviewer was SHOWN the id: an echo of an id it was never shown is
    // rejected, so the prompt has to carry the live lineage.
    expect(fake.stdin()).toContain(lineageId);
  }, 30_000);

  test('an unknown lineage id is rejected, and nothing is persisted', async () => {
    const fake = makeFakeCodex({
      response: envelope({
        version: 1,
        status: 'findings',
        findings: [{ ...FINDING, lineageId: 'ln-aaaaaaaaaaaa' }],
      }),
    });
    const result = await runReview({
      runner: gitRunner({ tail: [LS_FILES] }),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    // Rejected, and a rejection can never read as a clean pass.
    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings).toMatchObject({
      mode: 'rejected',
      invocation: 'codex-structured',
      rejection: { reason: 'unknown-lineage' },
    });
    expect(result.context.reviewDispute).toBeUndefined();
    expect(existsSync(join(runDir(), 'review-findings.json'))).toBe(false);
  }, 30_000);

  test('evidence that does not resolve against the reviewed head takes the whole envelope with it', async () => {
    // The cited range is past the end of the file in the checkout under review —
    // a stale citation, and exactly what a reviewer reading an older head emits.
    const fake = makeFakeCodex({
      response: envelope({
        version: 1,
        status: 'findings',
        findings: [
          { ...FINDING, evidenceRefs: [{ kind: 'file', path: 'src/handlers/review.ts', startLine: 900, endLine: 920 }] },
        ],
      }),
    });
    const result = await runReview({
      runner: gitRunner({ tail: [LS_FILES] }),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings.rejection.reason).toBe('unresolvable-evidence');
    expect(result.context.reviewDispute).toBeUndefined();
    expect(existsSync(join(runDir(), 'review-findings.json'))).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The three refusals: no certification on a partial or uncertified review
// ---------------------------------------------------------------------------

describe('§17.11 — what the lane may not certify', () => {
  test('a diff that could not be captured fails the run without spawning the CLI', async () => {
    const calls = [];
    const result = await runReview({
      runner: gitRunner({ promptDiffExit: 1 }),
      structuredReviewRunner: neverRuns(calls),
    });

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Failed to capture PR diff for codex review/);
    expect(calls).toHaveLength(0);
  }, 30_000);

  test('a clean envelope over a TRUNCATED diff escalates instead of promoting', async () => {
    const huge = `diff --git a/src/big.ts b/src/big.ts\n${'+// padding\n'.repeat(40_000)}`;
    expect(huge.length).toBeGreaterThan(400_000);
    const fake = makeFakeCodex({ response: envelope({ version: 1, status: 'success' }) });
    const result = await runReview({
      runner: gitRunner({ promptDiff: huge }),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/truncated before review/);
    // The reviewer really was shown a cut diff, and the record says so.
    expect(fake.stdin()).toContain('…(diff truncated)');
    expect(result.context.reviewFindings.structuredInvocation.diffTruncated).toBe(true);
  }, 30_000);

  test('a prose-only answer cannot pass cleanly, because this lane asked for an envelope', async () => {
    const fake = makeFakeCodex({ response: 'Looks good to me. Nothing blocking.\n' });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/no finding envelope/);
    expect(result.context.reviewFindings).toMatchObject({
      mode: 'rejected',
      invocation: 'codex-structured',
    });
    expect(result.context.reviewDispute).toBeUndefined();
  }, 30_000);

  test('a prose review that names a [P1] still routes to fix, envelope or not', async () => {
    // §13 keeps reading the prose: the fail-closed rule refuses a clean pass, it
    // does not overrule a blocking finding the reviewer plainly stated.
    const fake = makeFakeCodex({ response: '[P1] The auth handler still crashes on a null session.\n' });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('needs_fix');
    expect(result.context.reviewFindings.mode).toBe('rejected');
  }, 30_000);

  test('a malformed envelope is rejected as one, with the §12 reason recorded', async () => {
    const fake = makeFakeCodex({
      response: `${REVIEW_FINDINGS_MARKER}\n{"version": 1, "status": "not-a-status"}\n${REVIEW_FINDINGS_END_MARKER}\n`,
    });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('blocked');
    expect(result.context.reviewFindings).toMatchObject({
      mode: 'rejected',
      invocation: 'codex-structured',
      rejection: { reason: 'unknown-enum' },
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Invocation failures are incidents, never verdicts
// ---------------------------------------------------------------------------

describe('§17.11 — invocation failures', () => {
  test('a CLI that refuses a pinned flag is an unsupported capability, not a review', async () => {
    const fake = makeFakeCodex({
      exitCode: 2,
      writeOutput: false,
      stderrText: "error: unexpected argument '--output-last-message' found\n",
    });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/unsupported-capability/);
    expect(result.error).toMatch(/--output-last-message/);
    expect(result.context.reviewFindings.structuredInvocation.failure).toMatchObject({
      kind: 'unsupported-capability',
    });
    expect(result.context.reviewDispute).toBeUndefined();
  }, 30_000);

  test('a run that exits zero without writing the final message produced no review', async () => {
    const fake = makeFakeCodex({ writeOutput: false });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/missing-output/);
    expect(result.context.reviewFindings.structuredInvocation.failure).toMatchObject({
      kind: 'missing-output',
    });
  }, 30_000);

  test('a blank final message is not a review that found nothing', async () => {
    const fake = makeFakeCodex({ response: '   \n' });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/empty-output/);
  }, 30_000);

  test('a nonzero exit with an ordinary diagnostic fails the phase', async () => {
    const fake = makeFakeCodex({ exitCode: 1, writeOutput: false, stderrText: 'internal error\n' });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/agent-failed/);
  }, 30_000);

  test('a quota diagnostic delays the retry rather than failing the task', async () => {
    const fake = makeFakeCodex({
      exitCode: 1,
      writeOutput: false,
      stderrText: 'stream error: You have hit your usage limit. Try again later.\n',
    });
    const result = await runReview({
      runner: gitRunner(),
      structuredReviewRunner: spawningRunner(fake, []),
    });

    expect(result.result).toBe('delayed');
    // The signal travels on the phase context, as every other handler's quota
    // delay does — the retry reads it from there.
    expect(result.context.quotaSignal).toBeDefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Verification, and the default-off bound
// ---------------------------------------------------------------------------

describe('§17.11 — the gates before the lane, and the sessions it does not touch', () => {
  test('a failed session verification blocks before any Codex turn is spent', async () => {
    const calls = [];
    const result = await runReview({
      runner: gitRunner({ verification: { stdout: '', stderr: '3 tests failed', exitCode: 1 } }),
      structuredReviewRunner: neverRuns(calls),
    });

    expect(result.result).toBe('needs_fix');
    expect(calls).toHaveLength(0);
  }, 30_000);

  test('an issue-required command that was never run blocks before any Codex turn is spent', async () => {
    const calls = [];
    const result = await runReview({
      // The issue body requires a command `session.verification` does not run, so
      // the §5 gate blocks: nothing may certify a branch whose stated checks
      // never executed, least of all a review that costs a billed turn.
      runner: gitRunner(),
      structuredReviewRunner: neverRuns(calls),
      task: makeTask({ body: '## Verification\n\n- `npm run test:e2e`\n' }),
    });

    expect(result.result).toBe('blocked');
    expect(result.context.missingVerificationCommands).toContain('npm run test:e2e');
    expect(calls).toHaveLength(0);
  }, 30_000);

  test('with the protocol DISABLED the same session runs `codex review`, untouched', async () => {
    const calls = [];
    const runner = sequenceRunner([
      PR_VIEW,
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'ai/issue-77-run-impl-1', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '0', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: DIFF, stderr: '', exitCode: 0 },
      { stdout: 'All tests passed.', stderr: '', exitCode: 0 },
      { stdout: 'No P1/P2 findings.', stderr: '', exitCode: 0 },  // codex review
      { stdout: '', stderr: '', exitCode: 0 },
    ]);
    const result = await runReview({
      runner,
      structuredReviewRunner: neverRuns(calls),
      session: SESSION({ reviewDispute: { enabled: false } }),
    });

    expect(result.result).toBe('success');
    expect(calls).toHaveLength(0);
    const agentCall = runner.calls.find((c) => c.cmd === 'codex');
    expect(agentCall.args.slice(0, 3)).toEqual(['review', '--base', 'origin/main']);
    // The brief rides stdin since issue #912 (§7.3's one prompt channel for
    // every Codex lane) — never a `--title` argv element.
    expect(agentCall.args).not.toContain('--title');
    expect(agentCall.opts.stdin).toContain('Review Instructions');
    // No structured state at all: §13's default-off guarantee.
    expect(result.context.reviewFindings).toBeUndefined();
    expect(result.context.reviewDispute).toBeUndefined();
    expect(existsSync(join(runDir(), 'codex-structured-review.json'))).toBe(false);
  }, 30_000);
});
