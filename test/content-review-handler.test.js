import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createContentReviewHandler } from '../dist/handlers/content-review.js';
import { SqliteTaskStore } from '../dist/index.js';
import { runNextPhase } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let artifactRoot;
let draftArtifactDir;
let researchArtifactDir;

const SESSION = (overrides = {}) => ({
  sessionId: 'content-dev',
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
  ...overrides,
});

const CONTEXT = (overrides = {}) => ({
  session: SESSION(),
  runId: 'run-review-1',
  workerId: 'worker-review',
  ...overrides,
});

// Write draft artifacts that content_review will read.
function writeDraftArtifacts(dir, {
  outcome = 'draft_complete',
  success = true,
  content = 'Draft article: this is the article body.\n\n## Self-Review\nNo issues noted.',
  issueNumber = 77,
  sessionId = 'content-dev',
} = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'content-draft-result.json'),
    JSON.stringify({ outcome, success, issueNumber, sessionId, runId: 'run-draft-1' }),
    'utf8',
  );
  writeFileSync(join(dir, 'content-draft-output.md'), content, 'utf8');
}

// Write research artifacts that content_review can optionally read.
function writeResearchArtifacts(dir, { content = 'Research findings: performance tuning tips.' } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'content-research-result.json'),
    JSON.stringify({ outcome: 'valid', success: true, issueNumber: 77, sessionId: 'content-dev', runId: 'run-research-1' }),
    'utf8',
  );
  writeFileSync(join(dir, 'content-research-validated-brief.md'), content, 'utf8');
}

const PASS_STDOUT = 'Analysis complete.\n\n## Editorial Findings\nNo blocking issues found.\n\n## Review Outcome: PASS\nThe draft is ready for publication.';
const NEEDS_FIX_STDOUT = 'Analysis complete.\n\n## Editorial Findings\n- BLOCKING: The claim "X is 10x faster" is unsupported by the research brief.\n- BLOCKING: Possible local path leakage: /home/user/draft.md detected in body.\n\n## Review Outcome: NEEDS_FIX\nRevisions required before publication.';
const LEAKAGE_STDOUT = 'Analysis complete.\n\n## Editorial Findings\n- BLOCKING: Private path leakage detected: /Users/moto/.ssh/config referenced in draft.\n- BLOCKING: Internal credential pattern found.\n\n## Review Outcome: NEEDS_FIX\nRevisions required: remove all private references.';

const fakePass = () => ({
  run: (_cmd, _args, opts) => ({
    stdout: PASS_STDOUT,
    stderr: '',
    exitCode: 0,
    calledWith: { cwd: opts.cwd },
  }),
});

const fakeNeedsFix = () => ({
  run: (_cmd, _args, opts) => ({
    stdout: NEEDS_FIX_STDOUT,
    stderr: '',
    exitCode: 0,
    calledWith: { cwd: opts.cwd },
  }),
});

const fakeLeakage = () => ({
  run: (_cmd, _args, opts) => ({
    stdout: LEAKAGE_STDOUT,
    stderr: '',
    exitCode: 0,
    calledWith: { cwd: opts.cwd },
  }),
});

const fakeFail = (stderr = 'agy: command not found') => ({
  run: (_cmd, _args, opts) => ({
    stdout: '',
    stderr,
    exitCode: 127,
    calledWith: { cwd: opts.cwd },
  }),
});

function spyRunner(result = { stdout: PASS_STDOUT, stderr: '', exitCode: 0 }) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return result;
    },
  };
}

function makeTask(overrides = {}) {
  return {
    sessionId: 'content-dev',
    issueNumber: 77,
    status: 'running',
    phase: 'content_review',
    priority: 'normal',
    researchAgent: 'gemini',
    attempts: {},
    context: {
      title: 'Write a blog post about performance tuning',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:gemini', 'status:content-needed'],
      artifactDir: draftArtifactDir,
      researchArtifactDir,
    },
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'content-review-handler-test-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  draftArtifactDir = join(artifactRoot, 'runs', 'run-draft-1');
  researchArtifactDir = join(artifactRoot, 'runs', 'run-research-1');
  writeDraftArtifacts(draftArtifactDir);
  writeResearchArtifacts(researchArtifactDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Artifact paths
// ---------------------------------------------------------------------------

describe('content-review handler — artifacts', () => {
  test('creates artifact dir under artifactRoot/runs/<runId>', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    await handler(makeTask());
    expect(existsSync(join(artifactRoot, 'runs', 'run-review-1'))).toBe(true);
  });

  test('writes content-review-prompt.md, content-review-findings.md, content-review-result.json', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-review-1');
    expect(existsSync(join(dir, 'content-review-prompt.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-review-findings.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-review-result.json'))).toBe(true);
  });

  test('writes content-review-context.json (pre-run audit)', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-review-1');
    expect(existsSync(join(dir, 'content-review-context.json'))).toBe(true);
  });

  test('content-review-context.json contains resolvedProfile with phase content_review', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    await handler(makeTask());
    const ctx = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-context.json'), 'utf8'));
    expect(ctx.resolvedProfile).toMatchObject({ phase: 'content_review', agentId: 'gemini' });
  });

  test('artifacts written even on agent failure', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    const dir = join(artifactRoot, 'runs', 'run-review-1');
    expect(existsSync(join(dir, 'content-review-findings.md'))).toBe(true);
    expect(existsSync(join(dir, 'content-review-result.json'))).toBe(true);
  });

  test('content-review-findings.md contains agent stdout', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    await handler(makeTask());
    const findings = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-findings.md'), 'utf8');
    expect(findings).toContain('Review Outcome: PASS');
  });
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe('content-review handler — prompt construction', () => {
  test('prompt includes issue number and title', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).toContain('77');
    expect(prompt).toContain('Write a blog post about performance tuning');
  });

  test('prompt includes draft content delimited section', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).toMatch(/begin:draft-content-input/);
    expect(prompt).toMatch(/end:draft-content-input/);
    expect(prompt).toContain('Draft article: this is the article body.');
  });

  test('prompt includes research brief when researchArtifactDir is set', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).toMatch(/begin:research-brief-input/);
    expect(prompt).toContain('Research findings: performance tuning tips.');
  });

  test('prompt succeeds without research brief when researchArtifactDir absent', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask({ context: { title: 'T', artifactDir: draftArtifactDir } }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).toContain('Content Review Task');
    expect(prompt).not.toMatch(/begin:research-brief-input/);
  });

  test('prompt excludes research brief when content-research-result.json is missing (unvalidated research)', async () => {
    // researchArtifactDir points at a dir with only the brief file, no result
    // record — simulates a stale/manually recovered task context.
    const unvalidatedDir = join(artifactRoot, 'runs', 'run-research-unvalidated');
    mkdirSync(unvalidatedDir, { recursive: true });
    writeFileSync(join(unvalidatedDir, 'content-research-validated-brief.md'), 'Unvalidated research content.', 'utf8');
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask({ context: { title: 'T', artifactDir: draftArtifactDir, researchArtifactDir: unvalidatedDir } }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).not.toMatch(/begin:research-brief-input/);
    expect(prompt).not.toContain('Unvalidated research content.');
  });

  test('prompt excludes research brief when the result record is for a different issue (stale provenance)', async () => {
    const staleDir = join(artifactRoot, 'runs', 'run-research-stale');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(
      join(staleDir, 'content-research-result.json'),
      JSON.stringify({ outcome: 'valid', success: true, issueNumber: 999, sessionId: 'content-dev', runId: 'run-research-stale' }),
      'utf8',
    );
    writeFileSync(join(staleDir, 'content-research-validated-brief.md'), 'Research for a different issue.', 'utf8');
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask({ context: { title: 'T', artifactDir: draftArtifactDir, researchArtifactDir: staleDir } }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).not.toMatch(/begin:research-brief-input/);
    expect(prompt).not.toContain('Research for a different issue.');
  });

  test('prompt excludes research brief when the result record outcome is not valid', async () => {
    const invalidDir = join(artifactRoot, 'runs', 'run-research-invalid');
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(
      join(invalidDir, 'content-research-result.json'),
      JSON.stringify({ outcome: 'invalid', success: false, issueNumber: 77, sessionId: 'content-dev', runId: 'run-research-invalid' }),
      'utf8',
    );
    writeFileSync(join(invalidDir, 'content-research-validated-brief.md'), 'Research that failed validation.', 'utf8');
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask({ context: { title: 'T', artifactDir: draftArtifactDir, researchArtifactDir: invalidDir } }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).not.toMatch(/begin:research-brief-input/);
    expect(prompt).not.toContain('Research that failed validation.');
  });

  test('prompt includes all editorial review criteria', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).toContain('Factual accuracy');
    expect(prompt).toContain('Private information or local path leakage');
    expect(prompt).toContain('Overclaiming');
    expect(prompt).toContain('Reader fit');
    expect(prompt).toContain('Missing caveats');
    expect(prompt).toContain('Title/body mismatch');
  });

  test('prompt includes guardrails (Do NOT modify, no paths)', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).toContain('Do NOT modify any files');
    expect(prompt).toContain('Do NOT reference local filesystem paths');
  });

  test('prompt includes issue body as bounded delimited input', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask({
      context: {
        title: 'T',
        body: 'The issue body text for review context.',
        artifactDir: draftArtifactDir,
        researchArtifactDir,
      },
    }));
    const prompt = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-prompt.md'), 'utf8');
    expect(prompt).toContain('The issue body text for review context.');
    expect(prompt).toMatch(/begin:issue-body-input/);
  });
});

// ---------------------------------------------------------------------------
// Pass case — "success" outcome
// ---------------------------------------------------------------------------

describe('content-review handler — pass case', () => {
  test('returns success when agent output contains ## Review Outcome: PASS', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
  });

  test('content-review-result.json has outcome success and readyForHuman true', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    await handler(makeTask());
    const artifact = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-result.json'), 'utf8'));
    expect(artifact.outcome).toBe('success');
    expect(artifact.success).toBe(true);
    expect(artifact.readyForHuman).toBe(true);
  });

  test('success result includes reviewArtifactKey in context', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(result.context?.reviewArtifactKey).toBeDefined();
  });

  test('success result includes readyForHuman: true in context', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask());
    expect(result.result).toBe('success');
    expect(result.context?.readyForHuman).toBe(true);
  });

  test('success result does not include raw findings in context', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask());
    // findings are local-only; the context blob must not carry them
    const contextStr = JSON.stringify(result.context ?? {});
    expect(contextStr).not.toContain('Editorial Findings');
  });
});

// ---------------------------------------------------------------------------
// Needs-fix case — "needs_fix" outcome
// ---------------------------------------------------------------------------

describe('content-review handler — needs-fix case', () => {
  test('returns needs_fix when agent output contains ## Review Outcome: NEEDS_FIX', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeNeedsFix());
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
  });

  test('content-review-result.json has outcome needs_fix and success false', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeNeedsFix());
    await handler(makeTask());
    const artifact = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-result.json'), 'utf8'));
    expect(artifact.outcome).toBe('needs_fix');
    expect(artifact.success).toBe(false);
    expect(artifact.readyForHuman).toBe(false);
  });

  test('needs_fix result stores reviewFixFeedback in context', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeNeedsFix());
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(typeof result.context?.reviewFixFeedback).toBe('string');
    expect(result.context?.reviewFixFeedback.length).toBeGreaterThan(0);
  });

  test('reviewFixFeedback contains a normalized BLOCKING count, not finding text', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeNeedsFix());
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewFixFeedback).toContain('BLOCKING');
    // Context is not a local artifact — the verbatim finding text (including the
    // quoted claim and local path from NEEDS_FIX_STDOUT) must not appear here.
    expect(result.context?.reviewFixFeedback).not.toContain('X is 10x faster');
    expect(result.context?.reviewFixFeedback).not.toContain('/home/user/draft.md');
  });

  test('needs_fix result preserves draft artifact dir in context', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeNeedsFix());
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
    // Context must not carry the raw findings verbatim (findings belong in local artifact)
    expect(result.context?.reviewFixFeedback).not.toContain('## Review Outcome');
  });

  test('needs_fix result leaves context.artifactDir pointing at the draft dir, not the research dir', async () => {
    // The handler itself does not know whether nextPhaseAfter will loop this
    // back to content_draft or escalate to ready_for_human on a capped cycle;
    // only the latter reads context.artifactDir as the human handoff target,
    // so the handler must leave it as the draft dir and let nextPhaseAfter
    // swap in the research dir when (and only when) it continues the cycle.
    const handler = createContentReviewHandler(CONTEXT(), fakeNeedsFix());
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.artifactDir).toBe(draftArtifactDir);
    expect(result.context?.reviewRunArtifactDir).toBe(join(artifactRoot, 'runs', 'run-review-1'));
  });

  test('full findings text is stored in local content-review-findings.md only', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeNeedsFix());
    await handler(makeTask());
    const findings = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-findings.md'), 'utf8');
    expect(findings).toContain('NEEDS_FIX');
    expect(findings).toContain('unsupported by the research brief');
  });

  test('recognizes a numbered BLOCKING label (e.g. "1. BLOCKING: ...")', async () => {
    const stdout =
      '## Editorial Findings\n1. BLOCKING: The claim is unsupported by the research brief.\n\n## Review Outcome: NEEDS_FIX\nRevisions required.';
    const runner = { run: () => ({ stdout, stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
  });

  test('recognizes a Markdown-emphasized BLOCKING label (e.g. "- **BLOCKING**: ...")', async () => {
    const stdout =
      '## Editorial Findings\n- **BLOCKING**: The claim is unsupported by the research brief.\n\n## Review Outcome: NEEDS_FIX\nRevisions required.';
    const runner = { run: () => ({ stdout, stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
  });

  test('reviewFixFeedback falls back to the "other" category and never quotes the source line', async () => {
    // "incorrect publish date" does not contain any of the known category keywords
    // (accuracy, leakage, overclaiming, structure, gaps, title_mismatch), so it must
    // fall back to the generic "other" category rather than leaking the raw finding
    // text (including any private path or draft detail it might contain) into task
    // context, which is not a local-only artifact.
    const stdout =
      '## Editorial Findings\n- BLOCKING: The article states the release happened on 2024-03-01, but it actually happened on 2024-05-14.\n\n## Review Outcome: NEEDS_FIX\nRevisions required.';
    const runner = { run: () => ({ stdout, stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
    expect(result.context?.reviewFixFeedback).toContain('other (1)');
    expect(result.context?.reviewFixFeedback).not.toContain('2024-03-01');
    expect(result.context?.reviewFixFeedback).not.toContain('2024-05-14');
  });
});

// ---------------------------------------------------------------------------
// Leakage-risk case — private path/credential detected in draft
// ---------------------------------------------------------------------------

describe('content-review handler — leakage-risk case', () => {
  test('returns needs_fix when review detects private path leakage', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeLeakage());
    const result = await handler(makeTask());
    expect(result.result).toBe('needs_fix');
  });

  test('leakage finding stored in local findings artifact', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeLeakage());
    await handler(makeTask());
    const findings = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-findings.md'), 'utf8');
    expect(findings).toContain('Private path leakage detected');
  });

  test('leakage findings do NOT appear in result.error or GitHub-visible fields', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeLeakage());
    const result = await handler(makeTask());
    // The result is needs_fix (not failed), so there is no result.error
    expect(result.result).toBe('needs_fix');
    expect('error' in result).toBe(false);
  });

  test('fix feedback from leakage case reaches reviewFixFeedback in context without the leaked path', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeLeakage());
    const result = await handler(makeTask());
    expect(typeof result.context?.reviewFixFeedback).toBe('string');
    expect(result.context?.reviewFixFeedback).toContain('BLOCKING');
    // The private path from LEAKAGE_STDOUT must not be copied into task context.
    expect(result.context?.reviewFixFeedback).not.toContain('/Users/moto/.ssh/config');
  });
});

// ---------------------------------------------------------------------------
// Blocked case — agent failure or missing input
// ---------------------------------------------------------------------------

describe('content-review handler — blocked case', () => {
  test('returns blocked when agent exits non-zero', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeFail());
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('returns blocked when agent produces no output', async () => {
    const runner = { run: () => ({ stdout: '', stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('returns blocked when agent output has no recognizable outcome marker', async () => {
    const runner = { run: () => ({ stdout: 'The draft looks fine but I cannot decide.', stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('returns blocked when agent output contains both PASS and NEEDS_FIX markers (ambiguous)', async () => {
    const ambiguousStdout =
      'Example of a passing review:\n## Review Outcome: PASS\nBut the actual finding is:\n## Review Outcome: NEEDS_FIX\nRevisions required.';
    const runner = { run: () => ({ stdout: ambiguousStdout, stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('returns blocked when PASS marker appears without an Editorial Findings section (truncated/malformed output)', async () => {
    const runner = { run: () => ({ stdout: '## Review Outcome: PASS', stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('returns blocked when PASS marker appears with an empty Editorial Findings section', async () => {
    const stdout = '## Editorial Findings\n\n## Review Outcome: PASS';
    const runner = { run: () => ({ stdout, stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('returns blocked when PASS marker contradicts a BLOCKING finding in the Editorial Findings section', async () => {
    const stdout =
      '## Editorial Findings\n- BLOCKING: unsupported claim about performance.\n\n## Review Outcome: PASS';
    const runner = { run: () => ({ stdout, stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('returns blocked when NEEDS_FIX marker appears without an Editorial Findings section (truncated/malformed output)', async () => {
    const runner = { run: () => ({ stdout: '## Review Outcome: NEEDS_FIX', stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('returns blocked when NEEDS_FIX marker appears with an Editorial Findings section containing no BLOCKING finding', async () => {
    const stdout = '## Editorial Findings\nNo blocking issues found.\n\n## Review Outcome: NEEDS_FIX';
    const runner = { run: () => ({ stdout, stderr: '', exitCode: 0 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
  });

  test('content-review-result.json has outcome blocked and success false', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakeFail());
    await handler(makeTask());
    const artifact = JSON.parse(readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-result.json'), 'utf8'));
    expect(artifact.outcome).toBe('blocked');
    expect(artifact.success).toBe(false);
    expect(artifact.readyForHuman).toBe(false);
  });

  test('blocked result keeps context.artifactDir pointing at the draft dir for the human handoff', async () => {
    // A blocked outcome hands the task straight to ready_for_human, so the
    // documented artifact lookup (context.artifactDir) must still resolve to
    // the draft containing content-draft-output.md, not this review run's dir.
    const handler = createContentReviewHandler(CONTEXT(), fakeFail());
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.context?.artifactDir).toBe(draftArtifactDir);
    expect(result.context?.reviewRunArtifactDir).toBe(join(artifactRoot, 'runs', 'run-review-1'));
  });

  test('blocked result.message is public-safe (no raw stderr)', async () => {
    const secretStderr = 'internal error token=ghp_SECRET at /home/user/secret';
    const runner = { run: () => ({ stdout: '', stderr: secretStderr, exitCode: 1 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
    // blocked uses message not error; neither should contain secrets
    expect(result.message ?? '').not.toContain('ghp_SECRET');
    expect(result.message ?? '').not.toContain('/home/user/secret');
  });

  test('raw stderr is retained in local content-review-findings.md only', async () => {
    const secretStderr = 'token: ghp_ABCDEF12345 at /private/runs/xyz';
    const runner = { run: () => ({ stdout: '', stderr: secretStderr, exitCode: 1 }) };
    const handler = createContentReviewHandler(CONTEXT(), runner);
    await handler(makeTask());
    const findings = readFileSync(join(artifactRoot, 'runs', 'run-review-1', 'content-review-findings.md'), 'utf8');
    expect(findings).toContain(secretStderr);
  });
});

// ---------------------------------------------------------------------------
// Draft input validation
// ---------------------------------------------------------------------------

describe('content-review handler — draft input validation', () => {
  test('returns blocked when task has no artifactDir in context', async () => {
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask({ context: { title: 'T', labels: [] } }));
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/input_invalid/);
  });

  test('returns blocked when draft result artifact is missing', async () => {
    rmSync(join(draftArtifactDir, 'content-draft-result.json'));
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/input_invalid/);
  });

  test('returns blocked when draft outcome is not draft_complete', async () => {
    writeFileSync(
      join(draftArtifactDir, 'content-draft-result.json'),
      JSON.stringify({ outcome: 'draft_failed', success: false, issueNumber: 77, sessionId: 'content-dev', runId: 'run-draft-1' }),
      'utf8',
    );
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/input_invalid/);
  });

  test('returns blocked when draft output artifact is missing', async () => {
    rmSync(join(draftArtifactDir, 'content-draft-output.md'));
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/input_invalid/);
  });

  test('returns blocked when draft output artifact is empty', async () => {
    writeFileSync(join(draftArtifactDir, 'content-draft-output.md'), '   ', 'utf8');
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    const result = await handler(makeTask());
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/input_invalid/);
  });

  test('agent is NOT invoked when draft input is invalid', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask({ context: { title: 'T', labels: [] } }));
    expect(spy.calls).toHaveLength(0);
  });

  test('writes content-review-result.json with blocked outcome on draft validation failure', async () => {
    rmSync(join(draftArtifactDir, 'content-draft-output.md'));
    const handler = createContentReviewHandler(CONTEXT(), fakePass());
    await handler(makeTask());
    const resultPath = join(artifactRoot, 'runs', 'run-review-1', 'content-review-result.json');
    expect(existsSync(resultPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(artifact.outcome).toBe('blocked');
    expect(artifact.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolated cwd
// ---------------------------------------------------------------------------

describe('content-review handler — isolated execution cwd', () => {
  test('does NOT use session.repoRoot as agent cwd', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].opts.cwd).not.toBe(repoRoot);
  });

  test('uses the per-run artifact directory as the agent cwd', async () => {
    const spy = spyRunner();
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    const expected = join(artifactRoot, 'runs', 'run-review-1');
    expect(spy.calls[0].opts.cwd).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

describe('content-review handler — command execution', () => {
  test('uses ANTIGRAVITY_BIN env var when set', async () => {
    const spy = spyRunner();
    process.env['ANTIGRAVITY_BIN'] = '/usr/local/bin/custom-agy';
    try {
      const handler = createContentReviewHandler(CONTEXT(), spy);
      await handler(makeTask());
      expect(spy.calls[0].cmd).toBe('/usr/local/bin/custom-agy');
    } finally {
      delete process.env['ANTIGRAVITY_BIN'];
    }
  });

  test('falls back to "agy" when ANTIGRAVITY_BIN is not set', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].cmd).toBe('agy');
  });

  test('passes --print as first arg', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].args[0]).toBe('--print');
  });

  test('passes the prompt as the final positional arg and via stdin', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const handler = createContentReviewHandler(CONTEXT(), spy);
    await handler(makeTask());
    expect(spy.calls[0].args[1]).toContain('Content Review Task');
    expect(spy.calls[0].opts.stdin).toContain('Content Review Task');
  });

  test('configured model: passes --model before --print', async () => {
    const spy = spyRunner();
    delete process.env['ANTIGRAVITY_BIN'];
    const session = SESSION({ research: { antigravity: { model: 'Gemini 3.1 Pro (Low)' } } });
    const handler = createContentReviewHandler(CONTEXT({ session }), spy);
    await handler(makeTask());
    expect(spy.calls[0].args[0]).toBe('--model');
    expect(spy.calls[0].args[1]).toBe('Gemini 3.1 Pro (Low)');
    expect(spy.calls[0].args[2]).toBe('--print');
  });

  test('returns failed for unsupported agent', async () => {
    const spy = spyRunner();
    const ctx = CONTEXT({
      session: SESSION({ defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'claude' } }),
    });
    const handler = createContentReviewHandler(ctx, spy);
    const result = await handler(makeTask({ researchAgent: 'claude' }));
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/Unsupported content review agent/);
  });
});

// ---------------------------------------------------------------------------
// Quota delay
// ---------------------------------------------------------------------------

describe('content-review handler — quota delay', () => {
  test('returns delayed for quota/rate-limit signal', async () => {
    const quotaRunner = {
      run: () => ({
        stdout: '',
        stderr: 'Error: Resource exhausted: Quota exceeded for quota',
        exitCode: 1,
      }),
    };
    const handler = createContentReviewHandler(CONTEXT(), quotaRunner);
    const result = await handler(makeTask());
    expect(result.result).toBe('delayed');
    // Category and retry metadata survive onto the handler result (issue #672).
    expect(result.category).toBe('usage_quota');
    expect(result.context.category).toBe('usage_quota');
  });

  test('delayed context preserves draft artifactDir', async () => {
    const quotaRunner = {
      run: () => ({
        stdout: '',
        stderr: 'Error: Resource exhausted: Quota exceeded for quota',
        exitCode: 1,
      }),
    };
    const handler = createContentReviewHandler(CONTEXT(), quotaRunner);
    const result = await handler(makeTask());
    expect(result.result).toBe('delayed');
    // draft artifactDir must survive so the retry can still read the draft
    expect(result.context?.artifactDir).toBe(draftArtifactDir);
  });
});

// ---------------------------------------------------------------------------
// Phase transitions through runNextPhase
// ---------------------------------------------------------------------------

describe('content-review handler — phase transitions', () => {
  let store;
  let storePath;

  beforeEach(() => {
    storePath = join(tmpDir, 'test.db');
    store = new SqliteTaskStore(storePath);
  });

  afterEach(() => {
    store.close();
  });

  test('content_review pass transitions task to ready_for_human', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_review',
      researchAgent: 'gemini',
      context: { artifactDir: draftArtifactDir, researchArtifactDir },
      now: '2026-07-16T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-review-1', now: '2026-07-16T00:01:00.000Z' },
      handlers: {
        content_review: createContentReviewHandler(CONTEXT(), fakePass()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');
    expect(outcome.task.phase).toBe('content_review');
  });

  test('content_review needs_fix transitions task to queued/content_draft', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_review',
      researchAgent: 'gemini',
      context: { artifactDir: draftArtifactDir, researchArtifactDir },
      now: '2026-07-16T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-review-1', now: '2026-07-16T00:01:00.000Z' },
      handlers: {
        content_review: createContentReviewHandler(CONTEXT(), fakeNeedsFix()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('queued');
    expect(outcome.task.phase).toBe('content_draft');
  });

  test('content_review blocked transitions task to ready_for_human (human escalation)', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_review',
      researchAgent: 'gemini',
      context: { artifactDir: draftArtifactDir, researchArtifactDir },
      now: '2026-07-16T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-review-1', now: '2026-07-16T00:01:00.000Z' },
      handlers: {
        content_review: createContentReviewHandler(CONTEXT(), fakeFail('agent error')),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');
    expect(outcome.task.phase).toBe('content_review');
  });

  test('content_review needs_fix restores artifactDir to research dir so next content_draft can find research brief', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_review',
      researchAgent: 'gemini',
      context: { artifactDir: draftArtifactDir, researchArtifactDir },
      now: '2026-07-16T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-review-1', now: '2026-07-16T00:01:00.000Z' },
      handlers: {
        content_review: createContentReviewHandler(CONTEXT(), fakeNeedsFix()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('queued');
    // artifactDir must point to research dir (not draft dir) so the re-queued
    // content_draft can resolve content-research-result.json
    expect(outcome.task.context?.artifactDir).toBe(researchArtifactDir);
    expect(outcome.task.context?.artifactDir).not.toBe(draftArtifactDir);
  });

  test('content_review needs_fix at the cycle cap escalates to ready_for_human with artifactDir pointing at the draft dir', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_review',
      researchAgent: 'gemini',
      // Two real needs_fix cycles already completed — this third one hits
      // DEFAULT_MAX_CONTENT_REVIEW_CYCLES (3) and must escalate to a human.
      context: { artifactDir: draftArtifactDir, researchArtifactDir, contentReviewNeedsFixCycles: 2 },
      now: '2026-07-16T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-review-1', now: '2026-07-16T00:01:00.000Z' },
      handlers: {
        content_review: createContentReviewHandler(CONTEXT(), fakeNeedsFix()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');
    expect(outcome.task.phase).toBe('content_review');
    // artifactDir must still point at the draft dir (content-draft-output.md)
    // for the human handoff, not the research dir or this review run's dir.
    expect(outcome.task.context?.artifactDir).toBe(draftArtifactDir);
  });

  test('content_review needs_fix stores reviewFixFeedback in task context for next draft run', async () => {
    await store.enqueueTask({
      sessionId: 'content-dev',
      issueNumber: 77,
      phase: 'content_review',
      researchAgent: 'gemini',
      context: { artifactDir: draftArtifactDir, researchArtifactDir },
      now: '2026-07-16T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: { sessionId: 'content-dev', workerId: 'w1', runId: 'run-review-1', now: '2026-07-16T00:01:00.000Z' },
      handlers: {
        content_review: createContentReviewHandler(CONTEXT(), fakeNeedsFix()),
      },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('queued');
    // fix feedback must be in context so content_draft can use it on retry
    expect(typeof outcome.task.context?.reviewFixFeedback).toBe('string');
    expect(outcome.task.context?.reviewFixFeedback.length).toBeGreaterThan(0);
  });
});
