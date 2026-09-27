/**
 * Unit tests for the issue #962 per-party evidence-collection runner
 * (src/handlers/review-evidence-collection.ts).
 *
 * The module runs ONE of §7.1's two evidence-collection runs and normalizes what
 * came back. Everything below is asserted against that contract:
 *
 *  - either party runs independently through the one typed entry point, and the
 *    implementation party runs as the assigned implementation agent while the
 *    reviewer party runs as the assigned review agent — resolved from the task's
 *    own assignment and recorded provenance, never from a label;
 *  - #957's prompt and parser are the only protocol implementations in the path:
 *    the bundle is `buildEvidencePromptSection`'s and the admitted/dropped/ignored
 *    answer is `parseEvidenceCollectionResponse`'s, unchanged;
 *  - the agent is invoked with no tools, outside the checkout, with no GitHub
 *    credentials, and the checkout is byte-identical afterwards;
 *  - a valid empty answer is a SUCCESS, while a transient failure, a permanent
 *    configuration failure, a timeout, and an unreadable answer are four distinct
 *    typed outcomes;
 *  - output is bounded before it is written and only literals, counters, and safe
 *    artifact references travel in the summary;
 *  - nothing outside the run's own artifact directory is written.
 *
 * The agent is injected, so no test spawns a subprocess: the case that must
 * observe the REAL spawn contract (isolation) asserts on the command runner's
 * arguments instead.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_EVIDENCE_COLLECTION_TIMEOUT_MS,
  MAX_EVIDENCE_COLLECTION_RAW_BYTES,
  createEvidenceCollectionAgentRunner,
  resolveEvidencePartyAgent,
  runEvidenceCollection,
} from '../dist/handlers/review-evidence-collection.js';
import {
  buildEvidencePromptSection,
  evidenceBundleDigest,
} from '../dist/core/review-evidence-prompt.js';
import {
  evidenceArtifactName,
  evidencePartyRunKey,
} from '../dist/core/review-dispute-evidence-state.js';
import { ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const OTHER_LINEAGE = 'ln-bbbbbbbbbbbb';
const ISSUE_BODY = 'The handler must never dereference a null session.';
const MIDDLEWARE_REF = { kind: 'file', path: 'src/auth/middleware.ts', startLine: 4, endLine: 9 };
const UNTRACKED_REF = { kind: 'file', path: 'src/auth/nowhere.ts', startLine: 1, endLine: 2 };

let tmpRoot;
let repoCwd;
let artifactDir;

function line(n) {
  return `const line${n} = ${n};`;
}

function makeRepo() {
  mkdirSync(join(repoCwd, 'src', 'auth'), { recursive: true });
  for (const name of ['handler.ts', 'middleware.ts', 'dispatch.ts']) {
    writeFileSync(
      join(repoCwd, 'src', 'auth', name),
      Array.from({ length: 40 }, (_, i) => line(i + 1)).join('\n') + '\n',
      'utf8',
    );
  }
}

/** A command runner that answers `git ls-files -s` from the fixture repository. */
function trackedFilesRunner(calls = []) {
  return {
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      if (cmd === 'git') {
        return {
          stdout:
            '100644 aaaaaaa 0\tsrc/auth/handler.ts\n' +
            '100644 bbbbbbb 0\tsrc/auth/middleware.ts\n' +
            '100644 ccccccc 0\tsrc/auth/dispatch.ts\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

function body(overrides = {}) {
  return {
    severity: 'P1',
    violatedContract: 'The handler must reject a null session before dereferencing it.',
    preconditions: 'A request reaches the handler without passing the middleware.',
    failureScenario: 'The direct-dispatch path skips the middleware and dereferences a null session.',
    affectedBoundary: 'src/auth/handler.ts',
    requiredOutcome: 'The handler rejects a null session on every entry path.',
    evidenceRefs: [{ kind: 'file', path: 'src/auth/dispatch.ts', startLine: 12, endLine: 20 }],
    ...overrides,
  };
}

function dispute(overrides = {}) {
  return {
    challenged: { lineageId: LINEAGE, version: 1 },
    rebuttalReason: 'false_premise',
    argument: 'The middleware guard runs before every dispatch path, including the direct one.',
    evidenceRefs: [MIDDLEWARE_REF],
    whyNoChange: 'Adding a second guard would duplicate the middleware check.',
    ...overrides,
  };
}

function verdict(overrides = {}) {
  return {
    lineageId: LINEAGE,
    version: 1,
    verdict: 'insufficient_evidence',
    confidence: 0.4,
    rationale: 'Neither party showed the router registration order, which decides the question.',
    ...overrides,
  };
}

function brief(overrides = {}) {
  return {
    lineageId: LINEAGE,
    version: 1,
    severity: 'P1',
    affectedBoundary: 'src/auth/handler.ts',
    humanGate: false,
    counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
    versions: [{ version: 1, severity: 'P1', affectedBoundary: 'src/auth/handler.ts', humanGate: false, body: body() }],
    dispute: dispute(),
    verdict: verdict(),
    evidence: [],
    ...overrides,
  };
}

function bundle(overrides = {}) {
  return {
    lineages: [brief()],
    issueContract: ISSUE_BODY,
    resolvableEvidenceKinds: ['file', 'doc_section', 'issue_quote'],
    ...overrides,
  };
}

function lineage(overrides = {}) {
  return {
    lineageId: LINEAGE,
    state: 'evidence_requested',
    version: 1,
    counters: {
      rebuttals: 1,
      reconsiderations: 1,
      arbitrationPasses: 1,
      malformedArbiterAttempts: 0,
      evidenceRoundsUsed: 0,
    },
    rebuttedVersions: [1],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: 'src/auth/handler.ts',
    ...overrides,
  };
}

function fenced(value) {
  return `Here is what I found.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

const ATTACHMENT = [{ lineageId: LINEAGE, evidenceRefs: [MIDDLEWARE_REF] }];

/** An agent that answers with `response` and records the invocation it was given. */
function fakeAgent(response, seen = [], extra = {}) {
  return (invocation) => {
    seen.push(invocation);
    return { stdout: response, stderr: '', exitCode: 0, ...extra };
  };
}

/** A clock that advances 600ms across the agent invocation. */
function clock(ticks = [1_000, 1_600]) {
  const queue = [...ticks];
  let last = queue[queue.length - 1];
  return () => {
    if (queue.length === 0) return last;
    last = queue.shift();
    return last;
  };
}

function invoke(overrides = {}) {
  return runEvidenceCollection({
    party: 'implementer',
    bundle: bundle(),
    agent: { assignment: { implementationAgent: 'claude', reviewAgent: 'claude' } },
    lineages: { [LINEAGE]: lineage() },
    run: { runId: 'run-review-9', attempt: 1, round: 1, timestamp: '2026-08-20T02:00:00.000Z' },
    artifactDir,
    artifactRoot: tmpRoot,
    repoCwd,
    runner: trackedFilesRunner(),
    agentInvoke: fakeAgent(fenced(ATTACHMENT)),
    now: clock(),
    ...overrides,
  });
}

/** A stable snapshot of the checkout, so a mutation of any kind is visible. */
function snapshotRepo(dir = repoCwd, prefix = '') {
  const entries = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      entries.push(...snapshotRepo(path, `${prefix}${entry}/`));
      continue;
    }
    entries.push(`${prefix}${entry}:${readFileSync(path, 'utf8')}`);
  }
  return entries;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'evidence-run-test-'));
  repoCwd = join(tmpRoot, 'repo');
  artifactDir = join(tmpRoot, 'artifacts');
  for (const dir of [repoCwd, artifactDir]) mkdirSync(dir, { recursive: true });
  makeRepo();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Either party, one contract
// ---------------------------------------------------------------------------

describe('either party runs independently through one runner contract', () => {
  test('the implementer run admits what §3.3 resolves and reports it as completed', () => {
    const result = invoke();
    expect(result.outcome).toBe('completed');
    expect(result.failure).toBeNull();
    expect(result.collection.party).toBe('implementer');
    expect(result.collection.attachments[LINEAGE]).toBe(1);
    expect(result.collection.references[LINEAGE]).toEqual([MIDDLEWARE_REF]);
    expect(result.summary.party).toBe('implementer');
    expect(result.summary.evidence.admitted).toBe(1);
  });

  test('the reviewer run is the same call with the other party', () => {
    const result = invoke({ party: 'reviewer' });
    expect(result.outcome).toBe('completed');
    expect(result.collection.party).toBe('reviewer');
    expect(result.summary.party).toBe('reviewer');
  });

  test('the two parties are shown the same bundle and differ only in framing', () => {
    const seenImpl = [];
    const seenReviewer = [];
    const impl = invoke({ agentInvoke: fakeAgent(fenced(ATTACHMENT), seenImpl) });
    const reviewer = invoke({ party: 'reviewer', agentInvoke: fakeAgent(fenced(ATTACHMENT), seenReviewer) });
    expect(impl.summary.bundleDigest).toBe(reviewer.summary.bundleDigest);
    expect(seenImpl[0].prompt).toContain('You are the IMPLEMENTER');
    expect(seenReviewer[0].prompt).toContain('You are the REVIEWER');
  });

  test('neither party overwrites the other party\'s artifacts', () => {
    invoke();
    invoke({ party: 'reviewer' });
    const written = readdirSync(artifactDir).sort();
    expect(written).toContain(evidenceArtifactName('implementer', LINEAGE, 'record'));
    expect(written).toContain(evidenceArtifactName('reviewer', LINEAGE, 'record'));
    expect(written).toContain(evidenceArtifactName('implementer', LINEAGE, 'raw'));
    expect(written).toContain(evidenceArtifactName('reviewer', LINEAGE, 'raw'));
  });

  test('one run covers every lineage the round asked about', () => {
    const second = brief({ lineageId: OTHER_LINEAGE, dispute: dispute({ challenged: { lineageId: OTHER_LINEAGE, version: 1 } }), verdict: verdict({ lineageId: OTHER_LINEAGE }) });
    const seen = [];
    const result = invoke({
      bundle: bundle({ lineages: [brief(), second] }),
      lineages: { [LINEAGE]: lineage(), [OTHER_LINEAGE]: lineage({ lineageId: OTHER_LINEAGE }) },
      agentInvoke: fakeAgent(
        fenced([
          { lineageId: LINEAGE, evidenceRefs: [MIDDLEWARE_REF] },
          { lineageId: OTHER_LINEAGE, evidenceRefs: [MIDDLEWARE_REF] },
        ]),
        seen,
      ),
    });
    expect(seen).toHaveLength(1);
    expect(result.summary.askedLineageIds).toEqual([LINEAGE, OTHER_LINEAGE]);
    expect(result.collection.attachments[OTHER_LINEAGE]).toBe(1);
    // Each lineage's round record references its own complete artifact set.
    for (const id of [LINEAGE, OTHER_LINEAGE]) {
      expect(result.summary.artifacts[id].map((ref) => ref.name).sort()).toEqual(
        [evidenceArtifactName('implementer', id, 'raw'), evidenceArtifactName('implementer', id, 'record')].sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Which agent is which party
// ---------------------------------------------------------------------------

describe('the party agent comes from assignment and recorded provenance, never a label', () => {
  function stubResolver(seen) {
    return (agentId) => {
      seen.push(agentId);
      return {
        ok: true,
        profile: {
          agentId,
          provider: 'anthropic',
          cmd: 'claude',
          argv: ['-p'],
          model: 'opus',
          modelSource: 'default',
          effort: 'high',
          effortSource: 'default',
          budgetSource: 'default',
          toolPolicy: 'no-tools',
        },
      };
    };
  }

  test('the implementer runs as the assigned implementation agent', () => {
    const seen = [];
    invoke({
      agent: { assignment: { implementationAgent: 'codex', reviewAgent: 'claude' } },
      resolveProfile: stubResolver(seen),
    });
    expect(seen).toEqual(['codex']);
  });

  test('the reviewer runs as the assigned review agent', () => {
    const seen = [];
    invoke({
      party: 'reviewer',
      agent: { assignment: { implementationAgent: 'codex', reviewAgent: 'gemini' } },
      resolveProfile: stubResolver(seen),
    });
    expect(seen).toEqual(['gemini']);
  });

  test('the recorded provenance of the run that happened supersedes the assignment', () => {
    const seen = [];
    const result = invoke({
      agent: {
        parties: { implementation: { agentId: 'gemini' }, review: { agentId: 'codex' } },
        assignment: { implementationAgent: 'claude', reviewAgent: 'claude' },
      },
      resolveProfile: stubResolver(seen),
    });
    expect(seen).toEqual(['gemini']);
    expect(result.summary.profile.agentSource).toBe('provenance');
  });

  test('a persisted provider or model is not believed; the provider is derived', () => {
    const result = invoke({
      agent: {
        parties: { implementation: { agentId: 'claude', provider: 'openai', model: 'not-a-model' } },
        assignment: { implementationAgent: 'claude', reviewAgent: 'claude' },
      },
    });
    expect(result.summary.profile.provider).toBe('anthropic');
    expect(result.summary.profile.model).not.toBe('not-a-model');
  });

  test('an unrecognized recorded agent falls back to the assignment', () => {
    const seen = [];
    const result = invoke({
      agent: {
        parties: { implementation: { agentId: 'not-an-agent' } },
        assignment: { implementationAgent: 'claude', reviewAgent: 'claude' },
      },
      resolveProfile: stubResolver(seen),
    });
    expect(seen).toEqual(['claude']);
    expect(result.summary.profile.agentSource).toBe('assignment');
  });

  test('a party no source names fails closed, and no agent is invoked', () => {
    const seen = [];
    const result = invoke({ agent: {}, agentInvoke: fakeAgent(fenced(ATTACHMENT), seen) });
    expect(result.outcome).toBe('permanent_failure');
    expect(result.failure).toEqual({ kind: 'party-agent-unresolved', detail: 'implementation:unresolved' });
    expect(seen).toEqual([]);
    expect(result.collection).toBeNull();
  });

  test('resolveEvidencePartyAgent maps each party to its own role', () => {
    const sources = { assignment: { implementationAgent: 'codex', reviewAgent: 'claude' } };
    expect(resolveEvidencePartyAgent('implementer', sources)).toEqual({ ok: true, agentId: 'codex', source: 'assignment' });
    expect(resolveEvidencePartyAgent('reviewer', sources)).toEqual({ ok: true, agentId: 'claude', source: 'assignment' });
    expect(resolveEvidencePartyAgent('nobody', sources).ok).toBe(false);
  });

  test('an agent with no no-tools invocation gets no turn at all', () => {
    const seen = [];
    // The §8.2 capability table is the runner's own (core/review-arbiter-profile.ts):
    // an agent this runner cannot invoke WITHOUT tools cannot be given an evidence
    // turn, and that is a permanent configuration fact rather than a retry.
    const result = invoke({
      agent: { assignment: { implementationAgent: 'codex', reviewAgent: 'claude' } },
      agentInvoke: fakeAgent(fenced(ATTACHMENT), seen),
    });
    expect(result.outcome).toBe('permanent_failure');
    expect(result.failure.kind).toBe('unsupported-agent');
    expect(seen).toEqual([]);
  });

  test('the configured claude adapter resolves to a real no-tools profile', () => {
    const result = invoke({ env: { ...process.env, CLAUDE_MODEL: 'sonnet', CLAUDE_EFFORT: 'medium' } });
    expect(result.summary.profile).toMatchObject({
      agentId: 'claude',
      provider: 'anthropic',
      model: 'sonnet',
      modelSource: 'env',
      effort: 'medium',
      effortSource: 'env',
      toolPolicy: 'no-tools',
    });
  });
});

// ---------------------------------------------------------------------------
// #957 owns the protocol
// ---------------------------------------------------------------------------

describe('#957 is the only prompt and the only parser in the path', () => {
  test('the prompt is buildEvidencePromptSection\'s bundle, fenced by a per-run nonce', () => {
    const seen = [];
    const result = invoke({ agentInvoke: fakeAgent(fenced(ATTACHMENT), seen) });
    const section = buildEvidencePromptSection({ ...bundle(), party: 'implementer' });
    expect(seen[0].prompt).toContain(section.header[0]);
    expect(seen[0].prompt).toContain(section.dataBlock.join('\n'));
    expect(seen[0].prompt).toMatch(/--- BEGIN EVIDENCE BUNDLE [0-9a-f]{24} ---/);
    expect(result.summary.bundleDigest).toBe(evidenceBundleDigest(section.dataBlock));
    expect(result.summary.promptBytes).toBe(Buffer.byteLength(seen[0].prompt, 'utf8'));
  });

  test('an unresolvable reference is dropped and logged, never a run failure', () => {
    const result = invoke({
      agentInvoke: fakeAgent(fenced([{ lineageId: LINEAGE, evidenceRefs: [UNTRACKED_REF, MIDDLEWARE_REF] }])),
    });
    expect(result.outcome).toBe('completed');
    expect(result.collection.attachments[LINEAGE]).toBe(1);
    expect(result.collection.droppedRefs).toEqual([
      { lineageId: LINEAGE, refIndex: 0, reason: 'unresolvable', detail: null },
    ]);
  });

  test('out-of-schema content is ignored and logged, exactly as #957 defines it', () => {
    const result = invoke({
      agentInvoke: fakeAgent(
        fenced([{ lineageId: LINEAGE, evidenceRefs: [MIDDLEWARE_REF], argument: 'I still think I am right.' }]),
      ),
    });
    expect(result.outcome).toBe('completed');
    expect(result.collection.ignored.map((entry) => entry.field)).toEqual(['argument']);
    expect(result.summary.evidence.ignoredFields).toBe(1);
  });

  test('a lineage outside the round is rejected by #957, not by this layer', () => {
    const result = invoke({
      agentInvoke: fakeAgent(fenced([{ lineageId: OTHER_LINEAGE, evidenceRefs: [MIDDLEWARE_REF] }])),
    });
    expect(result.outcome).toBe('completed');
    expect(result.collection.attachments).toEqual({});
    expect(result.collection.rejected).toHaveLength(1);
    expect(result.summary.evidence.unansweredLineageIds).toEqual([LINEAGE]);
  });
});

// ---------------------------------------------------------------------------
// The read-only boundary
// ---------------------------------------------------------------------------

describe('the read-only boundary', () => {
  test('the agent is invoked with no tool surface, outside the checkout, without GitHub credentials', () => {
    const calls = [];
    const agentRunner = {
      run(cmd, args, opts) {
        // The sandbox directories are removed as the invocation returns, so what
        // the agent could actually see is observed from INSIDE the run.
        calls.push({
          cmd,
          args,
          opts,
          cwdEntries: readdirSync(opts.cwd),
          ghConfigEntries: readdirSync(opts.env.GH_CONFIG_DIR),
        });
        return { stdout: fenced(ATTACHMENT), stderr: '', exitCode: 0 };
      },
    };
    const result = invoke({
      agentInvoke: undefined,
      agentRunner,
      env: { ...process.env, GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', ACTIONS_RUNTIME_TOKEN: 'secret' },
    });
    expect(result.outcome).toBe('completed');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.cmd).toBe('claude');
    expect(call.args).toEqual(expect.arrayContaining(['--tools', '--allowedTools', '--strict-mcp-config', '--safe-mode', '--no-session-persistence']));
    const denied = call.args[call.args.indexOf('--disallowedTools') + 1];
    for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'Task']) {
      expect(denied.split(',')).toContain(tool);
    }
    // No checkout to write to, and no path back to it.
    expect(call.opts.cwd).not.toBe(repoCwd);
    expect(call.opts.cwd.startsWith(repoCwd)).toBe(false);
    expect(call.cwdEntries).toEqual([]);
    // No credential a `gh` invocation could authenticate with.
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN']) {
      expect(call.opts.env[key]).toBeUndefined();
    }
    expect(call.opts.env.GH_CONFIG_DIR).toBeDefined();
    expect(call.ghConfigEntries).toEqual([]);
    // The bundle travels on stdin, never in a process listing.
    expect(call.opts.stdin).toContain('Evidence collection for a disputed review finding');
    expect(call.args.join(' ')).not.toContain('Evidence collection');
    expect(call.opts.timeout).toBe(DEFAULT_EVIDENCE_COLLECTION_TIMEOUT_MS);
  });

  test('the isolated runner removes its temp directories on the way out', () => {
    const seen = [];
    const runner = {
      run(cmd, args, opts) {
        seen.push(opts);
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    };
    const agent = createEvidenceCollectionAgentRunner(
      { agentId: 'claude', provider: 'anthropic', cmd: 'claude', argv: ['-p'], modelSource: 'default', effortSource: 'default', budgetSource: 'default', toolPolicy: 'no-tools' },
      runner,
      process.env,
    );
    agent({ prompt: 'hello', timeoutMs: 1_000 });
    expect(seen).toHaveLength(1);
    expect(() => statSync(seen[0].cwd)).toThrow();
    expect(() => statSync(seen[0].env.GH_CONFIG_DIR)).toThrow();
  });

  test('the checkout is byte-identical after a run', () => {
    const before = snapshotRepo();
    invoke();
    expect(snapshotRepo()).toEqual(before);
  });

  test('nothing is written outside the run\'s own artifact directory', () => {
    invoke();
    expect(readdirSync(tmpRoot).sort()).toEqual(['artifacts', 'repo']);
    for (const name of readdirSync(artifactDir)) {
      expect(name.startsWith('evidence-')).toBe(true);
    }
  });

  test('a bundle with no lineage to attach evidence to spends no invocation', () => {
    const seen = [];
    const result = invoke({
      bundle: bundle({ lineages: [] }),
      lineages: {},
      agentInvoke: fakeAgent(fenced(ATTACHMENT), seen),
    });
    expect(result.outcome).toBe('permanent_failure');
    expect(result.failure).toEqual({ kind: 'invalid-bundle', detail: 'askedLineageIds:empty' });
    expect(seen).toEqual([]);
    expect(readdirSync(artifactDir)).toEqual([]);
  });

  test('an artifact directory outside the session root is refused before the agent runs', () => {
    const seen = [];
    const elsewhere = mkdtempSync(join(tmpdir(), 'evidence-elsewhere-'));
    try {
      const result = invoke({ artifactDir: elsewhere, agentInvoke: fakeAgent(fenced(ATTACHMENT), seen) });
      expect(result.outcome).toBe('permanent_failure');
      expect(result.failure).toEqual({ kind: 'unsafe-artifact-dir', detail: 'artifactDir' });
      expect(seen).toEqual([]);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('the artifact directory is revalidated before EVERY write, not once before the loop', () => {
    const second = brief({
      lineageId: OTHER_LINEAGE,
      dispute: dispute({ challenged: { lineageId: OTHER_LINEAGE, version: 1 } }),
      verdict: verdict({ lineageId: OTHER_LINEAGE }),
    });
    const safeDir = artifactDir;
    const escape = mkdtempSync(join(tmpdir(), 'evidence-escape-'));
    const firstArtifact = evidenceArtifactName('implementer', LINEAGE, 'raw');
    const input = {
      party: 'implementer',
      bundle: bundle({ lineages: [brief(), second] }),
      agent: { assignment: { implementationAgent: 'claude', reviewAgent: 'claude' } },
      lineages: { [LINEAGE]: lineage(), [OTHER_LINEAGE]: lineage({ lineageId: OTHER_LINEAGE }) },
      run: { runId: 'run-review-9', attempt: 1, round: 1, timestamp: '2026-08-20T02:00:00.000Z' },
      artifactRoot: tmpRoot,
      repoCwd,
      runner: trackedFilesRunner(),
      agentInvoke: fakeAgent(fenced(ATTACHMENT)),
      now: clock(),
    };
    // Stands in for a local actor replacing `artifactDir` with a link out of the
    // session root while the run sits BETWEEN two of its writes: the directory
    // the path names changes the moment the first transcript has landed. Only a
    // check that runs before each write can see it — `writeArtifactFile` guards
    // the leaf, so a replaced parent would carry the rest of the loop out.
    Object.defineProperty(input, 'artifactDir', {
      enumerable: true,
      get: () => (existsSync(join(safeDir, firstArtifact)) ? escape : safeDir),
    });
    try {
      const result = runEvidenceCollection(input);
      expect(result.outcome).toBe('permanent_failure');
      expect(result.failure).toEqual({ kind: 'unsafe-artifact-dir', detail: 'artifactDir' });
      expect(readdirSync(escape)).toEqual([]);
    } finally {
      rmSync(escape, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

describe('the returned result is provider-neutral and bounded', () => {
  test('it carries the coordinates, the profile, the duration, and the exit status', () => {
    const result = invoke();
    expect(result.summary).toMatchObject({
      party: 'implementer',
      runId: 'run-review-9',
      attempt: 1,
      round: 1,
      exitCode: 0,
      timedOut: false,
      durationMs: 600,
    });
    expect(result.summary.runKeys[LINEAGE]).toBe(
      evidencePartyRunKey({ lineageId: LINEAGE, version: 1, party: 'implementer', attempt: 1, runId: 'run-review-9', round: 1 }),
    );
    expect(result.summary.profile.toolPolicy).toBe('no-tools');
    expect(result.summary.profile.provider).toBe('anthropic');
  });

  test('artifact metadata is a name, a digest, and a byte count — never a path or bytes', () => {
    const result = invoke();
    const refs = result.summary.artifacts[LINEAGE];
    expect(refs.map((ref) => ref.name).sort()).toEqual(
      [evidenceArtifactName('implementer', LINEAGE, 'raw'), evidenceArtifactName('implementer', LINEAGE, 'record')].sort(),
    );
    for (const ref of refs) {
      expect(ref.digest).toMatch(/^[0-9a-f]{12}$/);
      expect(ref.bytes).toBeGreaterThan(0);
      expect(Object.keys(ref).sort()).toEqual(['bytes', 'digest', 'name']);
    }
    expect(JSON.stringify(result.summary)).not.toContain(artifactDir);
  });

  test('the record artifact holds what the party returned, what resolved, and what was dropped', () => {
    invoke({
      agentInvoke: fakeAgent(fenced([{ lineageId: LINEAGE, evidenceRefs: [UNTRACKED_REF, MIDDLEWARE_REF] }])),
    });
    const record = JSON.parse(
      readFileSync(join(artifactDir, evidenceArtifactName('implementer', LINEAGE, 'record')), 'utf8'),
    );
    expect(record).toMatchObject({
      party: 'implementer',
      lineageId: LINEAGE,
      version: 1,
      round: 1,
      attempt: 1,
      answered: true,
      attachments: 1,
      references: [MIDDLEWARE_REF],
    });
    expect(record.dropped).toEqual([{ refIndex: 0, reason: 'unresolvable', detail: null }]);
    expect(record.run.runId).toBe('run-review-9');
    expect(record.profile.toolPolicy).toBe('no-tools');
  });

  test('an asked lineage the party said nothing about still gets a record', () => {
    invoke({ agentInvoke: fakeAgent(fenced([])) });
    const record = JSON.parse(
      readFileSync(join(artifactDir, evidenceArtifactName('implementer', LINEAGE, 'record')), 'utf8'),
    );
    expect(record).toMatchObject({ answered: false, attachments: 0, references: [] });
  });

  test('the raw transcript is bounded before it is written', () => {
    const huge = 'x'.repeat(MAX_EVIDENCE_COLLECTION_RAW_BYTES * 2);
    const result = invoke({ agentInvoke: fakeAgent(`${huge}\n${fenced(ATTACHMENT)}`) });
    const raw = readFileSync(join(artifactDir, evidenceArtifactName('implementer', LINEAGE, 'raw')), 'utf8');
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(MAX_EVIDENCE_COLLECTION_RAW_BYTES + 200);
    // The summary reports what the agent produced, before the bound.
    expect(result.summary.rawOutputBytes).toBeGreaterThan(MAX_EVIDENCE_COLLECTION_RAW_BYTES);
  });

  test('the summary carries no evidence content and no agent prose', () => {
    const result = invoke({
      agentInvoke: fakeAgent(
        fenced([{ lineageId: LINEAGE, evidenceRefs: [MIDDLEWARE_REF], argument: 'The guard is on every path.' }]),
      ),
    });
    const serialized = JSON.stringify(result.summary);
    expect(serialized).not.toContain('The guard is on every path.');
    expect(serialized).not.toContain(ISSUE_BODY);
    expect(serialized).not.toContain('src/auth/middleware.ts');
  });

  test('both streams are preserved when the agent wrote to both', () => {
    const result = invoke({
      agentInvoke: () => ({ stdout: fenced(ATTACHMENT), stderr: 'warming up\n', exitCode: 0 }),
    });
    expect(result.outcome).toBe('completed');
    expect(readFileSync(join(artifactDir, evidenceArtifactName('implementer', LINEAGE, 'stderr')), 'utf8')).toBe('warming up\n');
  });

  test('a runner diagnostic is never persisted as the party\'s own words', () => {
    const diagnostic = 'Error: spawnSync claude ETIMEDOUT';
    const result = invoke({
      agentInvoke: () => ({ stdout: '', stderr: `partial output\n${diagnostic}`, exitCode: 1, spawnError: diagnostic, timedOut: true }),
    });
    expect(result.outcome).toBe('timeout');
    expect(readFileSync(join(artifactDir, evidenceArtifactName('implementer', LINEAGE, 'raw')), 'utf8')).toBe('partial output\n');
    expect(readFileSync(join(artifactDir, evidenceArtifactName('implementer', LINEAGE, 'runner_error')), 'utf8')).toBe(diagnostic);
  });
});

// ---------------------------------------------------------------------------
// Typed outcomes
// ---------------------------------------------------------------------------

describe('the five outcomes are distinct', () => {
  test('an empty valid answer is a success', () => {
    const result = invoke({ agentInvoke: fakeAgent(fenced([{ lineageId: LINEAGE, evidenceRefs: [] }])) });
    expect(result.outcome).toBe('completed');
    expect(result.failure).toBeNull();
    expect(result.collection.attachments[LINEAGE]).toBe(0);
    expect(result.summary.evidence.admitted).toBe(0);
  });

  test('an empty array is a success with nothing answered', () => {
    const result = invoke({ agentInvoke: fakeAgent(fenced([])) });
    expect(result.outcome).toBe('completed');
    expect(result.collection.attachments).toEqual({});
    expect(result.summary.evidence.unansweredLineageIds).toEqual([LINEAGE]);
  });

  test('an unreadable answer is its own outcome, and #957\'s advisory result still travels', () => {
    const result = invoke({ agentInvoke: fakeAgent('I could not find anything useful, sorry.') });
    expect(result.outcome).toBe('invalid_response');
    expect(result.failure.kind).toBe('invalid-response');
    expect(result.collection).not.toBeNull();
    expect(result.collection.envelopeFailure).not.toBeNull();
    expect(result.summary.evidence.failure).not.toBeNull();
    // The transcript and the per-lineage record are still on disk for the audit.
    expect(readdirSync(artifactDir)).toContain(evidenceArtifactName('implementer', LINEAGE, 'record'));
  });

  test('an agent that exits zero saying nothing is an invalid response, not an empty answer', () => {
    const result = invoke({ agentInvoke: () => ({ stdout: '', stderr: '', exitCode: 0 }) });
    expect(result.outcome).toBe('invalid_response');
    expect(result.failure).toEqual({ kind: 'empty-output', detail: null });
    expect(result.collection).toBeNull();
  });

  test('a nonzero exit is transient: the host and the command were both fine', () => {
    const result = invoke({ agentInvoke: () => ({ stdout: '', stderr: 'model overloaded', exitCode: 3 }) });
    expect(result.outcome).toBe('transient_failure');
    expect(result.failure).toEqual({ kind: 'agent-failed', detail: 'exit:3' });
    expect(result.summary.exitCode).toBe(3);
    expect(readFileSync(join(artifactDir, evidenceArtifactName('implementer', LINEAGE, 'raw')), 'utf8')).toBe('model overloaded');
  });

  test('a deadline is a timeout, not a run that failed', () => {
    const result = invoke({
      agentInvoke: () => ({ stdout: '', stderr: 'Error: spawnSync claude ETIMEDOUT', exitCode: 1, spawnError: 'Error: spawnSync claude ETIMEDOUT', timedOut: true }),
    });
    expect(result.outcome).toBe('timeout');
    expect(result.failure.kind).toBe('agent-timeout');
    expect(result.summary.timedOut).toBe(true);
  });

  test('a missing CLI is permanent; a host that could not fork is transient', () => {
    const missing = invoke({
      agentInvoke: () => ({ stdout: '', stderr: 'Error: spawnSync claude ENOENT', exitCode: 1, spawnError: 'Error: spawnSync claude ENOENT' }),
    });
    expect(missing.outcome).toBe('permanent_failure');
    expect(missing.failure).toEqual({ kind: 'cli-unavailable', detail: 'ENOENT' });
    const busy = invoke({
      agentInvoke: () => ({ stdout: '', stderr: 'Error: spawnSync claude EAGAIN', exitCode: 1, spawnError: 'Error: spawnSync claude EAGAIN' }),
    });
    expect(busy.outcome).toBe('transient_failure');
    expect(busy.failure).toEqual({ kind: 'agent-setup-failed', detail: 'EAGAIN' });
  });

  test('an invocation that could not be set up comes back typed, never thrown', () => {
    const result = invoke({
      agentInvoke: () => {
        const err = new Error('mkdtemp failed');
        err.code = 'EAGAIN';
        throw err;
      },
    });
    expect(result.outcome).toBe('transient_failure');
    expect(result.failure.kind).toBe('agent-setup-failed');
    expect(result.summary.exitCode).toBeNull();
  });

  test('an unexpected exception is permanent, and still a value', () => {
    const result = invoke({
      agentInvoke: () => {
        throw new TypeError('bad wiring');
      },
    });
    expect(result.outcome).toBe('permanent_failure');
    expect(result.failure.kind).toBe('agent-setup-failed');
  });
});

// ---------------------------------------------------------------------------
// The layer mutates nothing
// ---------------------------------------------------------------------------

describe('this layer changes no protocol state', () => {
  test('the result is values only: no context patch, no transition, no store', () => {
    const result = invoke();
    expect(Object.keys(result).sort()).toEqual(['artifacts', 'collection', 'failure', 'outcome', 'summary']);
    expect(result.artifacts.every((artifact) => typeof artifact.name === 'string' && typeof artifact.content === 'string')).toBe(true);
    for (const artifact of result.artifacts) {
      expect(artifact.name.includes('/')).toBe(false);
    }
  });

  test('the records travel as bytes; the transcripts travel as references only', () => {
    const result = invoke({ agentInvoke: () => ({ stdout: fenced(ATTACHMENT), stderr: 'warming up\n', exitCode: 0 }) });
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      evidenceArtifactName('implementer', LINEAGE, 'record'),
    ]);
    expect(result.summary.artifacts[LINEAGE].map((ref) => ref.name).sort()).toEqual(
      [
        evidenceArtifactName('implementer', LINEAGE, 'raw'),
        evidenceArtifactName('implementer', LINEAGE, 'record'),
        evidenceArtifactName('implementer', LINEAGE, 'stderr'),
      ].sort(),
    );
  });

  test('the persisted lineages handed in are not modified', () => {
    const lineages = { [LINEAGE]: lineage() };
    const before = JSON.stringify(lineages);
    invoke({ lineages });
    expect(JSON.stringify(lineages)).toBe(before);
  });

  test('re-running the same party with the same inputs is shown the same bundle', () => {
    const first = invoke();
    const second = invoke();
    expect(second.summary.bundleDigest).toBe(first.summary.bundleDigest);
    expect(second.summary.runKeys).toEqual(first.summary.runKeys);
  });
});
