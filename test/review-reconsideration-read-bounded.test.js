/**
 * The `read-bounded` reviewer reconsideration (issue #1085;
 * docs/review-dispute-contract.md §17.6 D2, §17.7, §17.16).
 *
 * Issue #1070 refused this turn because §8.2's posture cannot be enforced for a
 * CLI whose tool surface cannot be emptied, and §17.6's D2 was unrecorded. D2 is
 * now recorded, and what it admitted is a SECOND, weaker, separately named
 * posture — not a relabelling of the first. So every test here is one of four
 * shapes:
 *
 *  1. **the default is the old refusal.** A session that has not written the
 *     opt-in down gets §17.12's answer, byte for byte, and spawns nothing.
 *  2. **the opt-in admits an invocation, and it is the one §17.7 pins.** The
 *     argv, the stdin delivery, the cwd, the environment, the deadline and the
 *     output-file handshake are asserted against the invocation the production
 *     runner actually builds, never against a copy of it written here.
 *  3. **the posture is carried, never defaulted.** `read-bounded` reaches the
 *     resolved profile, the §10.2 record and the run summary; `no-tools` reaches
 *     none of them for this lane, and a Claude turn is unaffected by the opt-in.
 *  4. **the boundary is described honestly.** What this posture bounds is
 *     asserted (no writes to the checkout or the operator's config, no GitHub
 *     credential, no operator HOME, a cwd that is not the worktree); what it does
 *     NOT bound — reads outside the bundle — is stated and never asserted away.
 *
 * The agent is a `CommandRunner` stub rather than an injected agent function, so
 * the module under test builds its own isolation, its own argv and its own
 * temp-file handshake: an injected agent would report whatever it was told to and
 * would prove none of that. No real `codex` is ever resolved — a test that
 * spawned one could bill a turn.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_RECONSIDERATION_TIMEOUT_MS,
  MAX_RECONSIDERATION_RESPONSE_BYTES,
  RECONSIDERATION_READ_BOUNDED_AGENTS,
  RECONSIDERATION_READ_BOUNDED_ARGS,
  RECONSIDERATION_SUPPORTED_AGENTS,
  buildReconsiderationArgv,
  reconsiderationAgentSupport,
  resolveReconsiderationProfile,
  runReviewReconsideration,
} from '../dist/handlers/review-reconsideration.js';
import {
  disputeArtifactName,
  reconsiderationArtifactName,
  reconsiderationEventsArtifactName,
  reconsiderationRawArtifactName,
  reconsiderationStderrArtifactName,
  REVIEW_FINDINGS_ARTIFACT,
} from '../dist/core/review-dispute-lineage.js';
import { CODEX_STRUCTURED_REVIEW_EXEC_ARGS } from '../dist/handlers/codex-structured-review.js';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const RATIONALE = 'The middleware guard cited by the rebuttal runs on every entry path, so the finding does not hold.';
const ISSUE_BODY = 'The endpoint must never return 500 for an unauthenticated request.';
/** What an operator's own Codex configuration holds before any run. */
const OPERATOR_CONFIG = 'model = "operator-choice"\n';

let tmpRoot;
let repoCwd;
let artifactDir;
let disputeDir;
let reviewDir;
let homeDir;

function line(n) {
  return `const line${n} = ${n};`;
}

function makeRepo() {
  mkdirSync(join(repoCwd, 'src', 'auth'), { recursive: true });
  writeFileSync(
    join(repoCwd, 'src', 'auth', 'handler.ts'),
    Array.from({ length: 40 }, (_, i) => line(i + 1)).join('\n') + '\n',
    'utf8',
  );
  writeFileSync(
    join(repoCwd, 'src', 'auth', 'middleware.ts'),
    Array.from({ length: 20 }, (_, i) => line(i + 1)).join('\n') + '\n',
    'utf8',
  );
}

/** A snapshot of every file under one directory, for an "untouched" assertion. */
function snapshot(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const name of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, name.name);
      if (name.isDirectory()) walk(path, `${prefix}${name.name}/`);
      else out.push([`${prefix}${name.name}`, readFileSync(path, 'utf8')]);
    }
  };
  walk(dir, '');
  return out;
}

/** Answers `git ls-files -s` for the fixture repository; never reaches the agent. */
function trackedFilesRunner(calls = []) {
  return {
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      if (cmd === 'git') {
        return {
          stdout: '100644 aaaaaaa 0\tsrc/auth/handler.ts\n100644 bbbbbbb 0\tsrc/auth/middleware.ts\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

function findingRecord() {
  return {
    lineageId: LINEAGE,
    version: 1,
    severity: 'P1',
    violatedContract: 'The handler must reject a null session before dereferencing it.',
    preconditions: 'A request arrives with no session cookie.',
    failureScenario: 'The handler dereferences session.userId and throws a 500.',
    affectedBoundary: 'src/auth/handler.ts',
    requiredOutcome: 'A null session is rejected with 401 before any dereference.',
    evidenceRefs: [{ kind: 'file', path: 'src/auth/handler.ts', startLine: 30, endLine: 32 }],
    humanGate: false,
    reviewerMeta: { agentId: 'codex', reviewRunId: 'run-review-1', timestamp: '2026-09-05T00:00:00.000Z' },
  };
}

function disputeRecord() {
  return {
    lineageId: LINEAGE,
    version: 1,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId: LINEAGE, version: 1 },
      rebuttalReason: 'false_premise',
      argument: 'The middleware rejects a null session before the handler is reached.',
      evidenceRefs: [{ kind: 'file', path: 'src/auth/middleware.ts', startLine: 10, endLine: 12 }],
      testEvidence: ['test/auth.test.js > rejects a null session'],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
  };
}

function writeArtifacts() {
  writeFileSync(
    join(disputeDir, disputeArtifactName(LINEAGE)),
    JSON.stringify({
      lineageId: LINEAGE,
      version: 1,
      severity: 'P1',
      affectedBoundary: 'src/auth/handler.ts',
      humanGate: false,
      state: 'disputed',
      disposition: 'review_disputed',
      run: { runId: 'run-impl-1', agentId: 'claude', timestamp: '2026-09-05T01:00:00.000Z' },
      record: disputeRecord(),
    }),
    'utf8',
  );
  writeFileSync(join(reviewDir, REVIEW_FINDINGS_ARTIFACT), JSON.stringify({ findings: [findingRecord()] }), 'utf8');
}

function context() {
  return {
    version: 1,
    reviewStructure: 'structured',
    lineages: {
      [LINEAGE]: {
        lineageId: LINEAGE,
        state: 'disputed',
        version: 1,
        counters: {
          rebuttals: 1,
          reconsiderations: 0,
          arbitrationPasses: 0,
          malformedArbiterAttempts: 0,
          evidenceRoundsUsed: 0,
        },
        rebuttedVersions: [1],
        disputeRuns: [{ version: 1, runId: 'run-impl-1' }],
        humanGate: false,
        severity: 'P1',
        affectedBoundary: 'src/auth/handler.ts',
      },
    },
  };
}

function routing() {
  return {
    kind: 'pending_reconsideration',
    lineages: [{ lineageId: LINEAGE, version: 1 }],
    escalatedLineageIds: [],
    pendingReReview: false,
  };
}

function reconsideration(overrides = {}) {
  return { lineageId: LINEAGE, version: 1, reconsideration: 'uphold', rationale: RATIONALE, ...overrides };
}

function fenced(value) {
  return `Reconsidered.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/** `codex exec --json` progress: never the verdict, always on stdout. */
const EVENTS = '{"type":"item.started"}\n{"type":"item.completed"}\n';

/**
 * A command runner standing in for the `codex` CLI.
 *
 * It writes `finalMessage` to whatever path the argv named, which is the whole
 * handshake under test: a fixture that returned the answer on stdout would pass
 * a lane that never looked at the file.
 */
function codexRunner(options = {}) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts, cwdExisted: existsSync(opts.cwd) });
      if (options.writeSentinel === true) {
        // An agent-owned write into its own cwd: the point is that the cwd is a
        // throwaway directory, so this can never land in the checkout.
        writeFileSync(join(opts.cwd, 'agent-wrote-here.txt'), 'x', 'utf8');
      }
      const at = args.indexOf('--output-last-message');
      if (at !== -1 && options.finalMessage !== undefined) {
        writeFileSync(args[at + 1], options.finalMessage, 'utf8');
      }
      return {
        stdout: options.stdout ?? EVENTS,
        stderr: options.stderr ?? '',
        exitCode: options.exitCode ?? 0,
        ...(options.spawnError === undefined ? {} : { spawnError: options.spawnError }),
        ...(options.timedOut === undefined ? {} : { timedOut: options.timedOut }),
      };
    },
  };
}

function invoke(overrides = {}) {
  const { runnerOptions, ...rest } = overrides;
  const agentRunner = overrides.agentRunner ?? codexRunner({ finalMessage: fenced(reconsideration()), ...runnerOptions });
  return {
    agentRunner,
    result: runReviewReconsideration({
      routing: routing(),
      pending: { lineageId: LINEAGE, version: 1 },
      context: context(),
      issueBody: ISSUE_BODY,
      disputeArtifactDir: disputeDir,
      reviewArtifactDir: reviewDir,
      artifactDir,
      repoCwd,
      run: { runId: 'run-review-2', agentId: 'codex', timestamp: '2026-09-07T02:00:00.000Z' },
      runner: trackedFilesRunner(),
      agentId: 'codex',
      readBounded: true,
      env: { HOME: homeDir, PATH: '/usr/bin', GH_TOKEN: 'ghp_secret', CODEX_API_KEY: 'sk-test' },
      agentRunner,
      ...rest,
    }),
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'reconsider-rb-'));
  repoCwd = join(tmpRoot, 'repo');
  artifactDir = join(tmpRoot, 'artifacts');
  disputeDir = join(tmpRoot, 'dispute-artifacts');
  reviewDir = join(tmpRoot, 'review-artifacts');
  homeDir = join(tmpRoot, 'home');
  for (const dir of [repoCwd, artifactDir, disputeDir, reviewDir, join(homeDir, '.codex')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(homeDir, '.codex', 'config.toml'), OPERATOR_CONFIG, 'utf8');
  makeRepo();
  writeArtifacts();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The default is the refusal §17.12 recorded
// ---------------------------------------------------------------------------

describe('without the opt-in, nothing changed', () => {
  test('the capability answer is the §17.12 refusal, and it names the setting that would change it', () => {
    const support = reconsiderationAgentSupport('codex');
    expect(support.supported).toBe(false);
    expect(support.toolPolicy).toBeUndefined();
    expect(support.blocker).toBe('B2');
    expect(support.pendingDecision).toBe('D2');
    // An operator reading this must be told there IS a decision to make, and
    // what accepting it costs — not left to infer either.
    expect(support.optIn).toBe('reviewDispute.reconsideration.readBounded');
    expect(support.reason).toMatch(/Unsupported reconsideration agent: codex/);
    expect(support.reason).toMatch(/no tool surface/);
    expect(support.reason).toMatch(/reads\s+are NOT bounded/);
    expect(resolveReconsiderationProfile('codex', {}).profile).toBeUndefined();
    expect(resolveReconsiderationProfile('codex', {}).error).toBe(support.reason);
    // Explicitly false is the same as absent: the opt-in is opt-IN.
    expect(resolveReconsiderationProfile('codex', {}, { readBounded: false }).profile).toBeUndefined();
  });

  test('the invocation refuses before anything is read, spawned or written', () => {
    const runner = codexRunner({ finalMessage: fenced(reconsideration()) });
    const repoCalls = [];
    const { result } = invoke({
      readBounded: false,
      agentRunner: runner,
      runner: trackedFilesRunner(repoCalls),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ kind: 'unsupported-agent', detail: 'codex' });
    expect(runner.calls).toEqual([]);
    expect(repoCalls).toEqual([]);
    expect(readdirSync(artifactDir)).toEqual([]);
    expect(result.summary.profile).toBeNull();
  });

  test('an agent with no invocation at all is refused whatever the opt-in says', () => {
    for (const agentId of ['gemini', 'cursor-agent', 'CODEX', '']) {
      const support = reconsiderationAgentSupport(agentId, { readBounded: true });
      expect(support.supported).toBe(false);
      expect(support.optIn).toBeUndefined();
      expect(resolveReconsiderationProfile(agentId, {}, { readBounded: true }).profile).toBeUndefined();
    }
  });

  test('the two capability lists stay separate: the opt-in adds no agent to the §8.2 one', () => {
    expect([...RECONSIDERATION_SUPPORTED_AGENTS]).toEqual(['claude']);
    expect([...RECONSIDERATION_READ_BOUNDED_AGENTS]).toEqual(['codex']);
    // The §8.2 list is what "has a verified no-tools invocation" means, and D2
    // did not grade C7 (§17.16). Merging the two is the failure this pins.
    for (const agentId of RECONSIDERATION_READ_BOUNDED_AGENTS) {
      expect(RECONSIDERATION_SUPPORTED_AGENTS).not.toContain(agentId);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The opted-in profile is §17.7's, and only §17.7's
// ---------------------------------------------------------------------------

describe('the resolved read-bounded profile', () => {
  test('records the posture under its own name and reads its answer from a file', () => {
    const { profile } = resolveReconsiderationProfile('codex', {}, { readBounded: true });
    expect(profile.toolPolicy).toBe('read-bounded');
    expect(profile.responseChannel).toBe('final-message');
    expect(profile.agentId).toBe('codex');
    expect(profile.cmd).toBe('codex');
    expect(profile.provider).toBe('openai');
    expect(profile.role).toBe('reconsideration');
    expect(profile.phase).toBe('review');
    // The literal §17.5 refuses for a Codex dispute turn must not appear anywhere
    // on this profile, under any key.
    expect(JSON.stringify(profile)).not.toContain('no-tools');
  });

  test('pins §17.7’s argv, shared with the review lane rather than copied', () => {
    const { profile } = resolveReconsiderationProfile('codex', {}, { readBounded: true });
    // One contract, one constant: a second literal list is how two lanes end up
    // pinning different boundaries under the same section number.
    expect([...RECONSIDERATION_READ_BOUNDED_ARGS]).toEqual([...CODEX_STRUCTURED_REVIEW_EXEC_ARGS]);
    expect(profile.argv).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--json',
      '-c',
      'model_reasoning_effort=high',
    ]);
    // The run-owned path is spliced at invocation time and is not protocol state.
    expect(profile.argv).not.toContain('--output-last-message');
    expect(buildReconsiderationArgv(profile, { lastMessagePath: '/tmp/x/final-message.txt' })).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--json',
      '--output-last-message',
      '/tmp/x/final-message.txt',
      '-c',
      'model_reasoning_effort=high',
    ]);
  });

  test('no bypass flag exists to be set, and no schema flag is pinned', () => {
    for (const env of [{}, { CODEX_MODEL: 'o9' }, { CODEX_EFFORT: 'low' }]) {
      const argv = buildReconsiderationArgv(
        resolveReconsiderationProfile('codex', env, { readBounded: true }).profile,
        { lastMessagePath: '/tmp/x' },
      ).join(' ');
      for (const forbidden of [
        '--dangerously',
        'bypass',
        '--full-auto',
        'danger-full-access',
        '--yolo',
        // A §4.1 record is not the §2.1 envelope `--output-schema` describes,
        // and C6 is `vendor-documented` regardless (§17.16).
        '--output-schema',
      ]) {
        expect(argv).not.toContain(forbidden);
      }
      expect(argv).toContain('--sandbox read-only');
    }
  });

  test('model and effort follow §17.7’s rows, and an unset model stays absent', () => {
    const unset = resolveReconsiderationProfile('codex', {}, { readBounded: true }).profile;
    expect(unset.model).toBeUndefined();
    expect(unset.modelSource).toBe('cli-default');
    expect(unset.argv).not.toContain('--model');

    const fromSession = resolveReconsiderationProfile('codex', {}, {
      readBounded: true,
      codex: { model: 'gpt-session' },
    }).profile;
    expect(fromSession.model).toBe('gpt-session');
    expect(fromSession.modelSource).toBe('session-config');
    // A global option, so it precedes the subcommand.
    expect(fromSession.argv.slice(0, 3)).toEqual(['--model', 'gpt-session', 'exec']);

    const fromEnv = resolveReconsiderationProfile('codex', { CODEX_MODEL: 'gpt-env' }, {
      readBounded: true,
      codex: { model: 'gpt-session' },
    }).profile;
    expect(fromEnv.model).toBe('gpt-env');
    expect(fromEnv.modelSource).toBe('env');

    expect(resolveReconsiderationProfile('codex', { CODEX_EFFORT: 'low' }, { readBounded: true }).profile).toMatchObject(
      { effort: 'low', effortSource: 'env' },
    );
    // C3: Codex accepts three levels, so a Claude-only tier maps to `high`.
    for (const tier of ['xhigh', 'max', 'nonsense']) {
      expect(
        resolveReconsiderationProfile('codex', { CODEX_EFFORT: tier }, { readBounded: true }).profile.effort,
      ).toBe('high');
    }
    // The Claude lane's own env vars have no effect on this one.
    expect(
      resolveReconsiderationProfile('codex', { CLAUDE_MODEL: 'opus', CLAUDE_EFFORT: 'low' }, { readBounded: true })
        .profile,
    ).toMatchObject({ modelSource: 'cli-default', effort: 'high' });
  });

  test('the claude lane is untouched by the opt-in, in both directions', () => {
    for (const options of [{}, { readBounded: true }]) {
      const { profile } = resolveReconsiderationProfile('claude', {}, options);
      expect(profile.toolPolicy).toBe('no-tools');
      expect(profile.responseChannel).toBe('stdout');
      expect(profile.cmd).toBe('claude');
      expect(profile.model).toBe('opus');
      expect(profile.argv).toContain('--tools');
      expect(profile.argv.join(' ')).not.toContain('--sandbox');
    }
    expect(reconsiderationAgentSupport('claude', { readBounded: true })).toEqual({
      supported: true,
      toolPolicy: 'no-tools',
      reason: expect.stringContaining('no-tools invocation'),
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The invocation the production runner actually makes
// ---------------------------------------------------------------------------

describe('the isolated invocation', () => {
  test('spawns codex exec with the bundle on stdin, outside the checkout, with no credential', () => {
    const { result, agentRunner } = invoke({ runnerOptions: { writeSentinel: true } });
    expect(result.ok).toBe(true);
    expect(agentRunner.calls).toHaveLength(1);
    const [call] = agentRunner.calls;
    expect(call.cmd).toBe('codex');
    for (const flag of ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--json']) {
      expect(call.args).toContain(flag);
    }
    // The answer's channel, and a path this run owns.
    const at = call.args.indexOf('--output-last-message');
    expect(at).toBeGreaterThan(-1);
    const outputPath = call.args[at + 1];
    expect(outputPath.startsWith(repoCwd)).toBe(false);
    expect(outputPath.startsWith(artifactDir)).toBe(false);
    // §17.7's prompt row: the bundle travels on stdin and never in argv.
    expect(call.opts.stdin).toContain(ISSUE_BODY);
    expect(call.opts.stdin).toContain('The middleware rejects a null session before the handler is reached.');
    expect(call.args.join(' ')).not.toContain(ISSUE_BODY);
    // §17.7's cwd row: a throwaway directory, never the worktree.
    expect(call.opts.cwd).not.toBe(repoCwd);
    expect(call.opts.cwd.startsWith(repoCwd)).toBe(false);
    expect(call.cwdExisted).toBe(true);
    // ...and it is removed on the way out, so nothing survives it.
    expect(existsSync(call.opts.cwd)).toBe(false);
    // §17.7's environment row.
    expect(call.opts.env.GH_TOKEN).toBeUndefined();
    expect(call.opts.env.HOME).not.toBe(homeDir);
    expect(call.opts.env.GH_CONFIG_DIR).not.toBe(homeDir);
    expect(call.opts.env.CODEX_HOME).toBe(join(homeDir, '.codex'));
    expect(call.opts.env.PWD).toBe(call.opts.cwd);
    // §17.7's timeout/cancellation rows: the runner's deadline, and a process
    // group so it is enforceable rather than requested.
    expect(call.opts.timeout).toBe(DEFAULT_RECONSIDERATION_TIMEOUT_MS);
    expect(call.opts.isolateProcessGroup).toBe(true);
  });

  test('leaves the checkout, the run artifacts and the operator’s own config untouched', () => {
    const repoBefore = snapshot(repoCwd);
    const disputeBefore = snapshot(disputeDir);
    const { result, agentRunner } = invoke({ runnerOptions: { writeSentinel: true } });
    expect(result.ok).toBe(true);
    // The agent wrote a file into its cwd, and that cwd was not the checkout.
    expect(snapshot(repoCwd)).toEqual(repoBefore);
    expect(snapshot(disputeDir)).toEqual(disputeBefore);
    expect(existsSync(join(repoCwd, 'agent-wrote-here.txt'))).toBe(false);
    expect(existsSync(join(agentRunner.calls[0].opts.cwd, 'agent-wrote-here.txt'))).toBe(false);
    // The operator's own Codex configuration is byte-identical, and the run
    // refused to READ it as well (`--ignore-user-config`), which is the flag
    // that makes `CODEX_HOME` pointing at it safe.
    expect(readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8')).toBe(OPERATOR_CONFIG);
    expect(agentRunner.calls[0].args).toContain('--ignore-user-config');
    // This run's own directory holds exactly the §10.2 files and nothing else.
    expect(readdirSync(artifactDir).sort()).toEqual(
      [
        reconsiderationArtifactName(LINEAGE),
        reconsiderationEventsArtifactName(LINEAGE),
        reconsiderationRawArtifactName(LINEAGE),
      ].sort(),
    );
  });

  test('reads outside the bundle are NOT prevented, and nothing here claims they are', () => {
    // The honest statement of §17.6's third row, pinned so a later change cannot
    // quietly start claiming the stronger property: this lane passes no flag that
    // removes a read tool, and it has no tool denylist at all. The Claude lane's
    // triple is what that would look like, and it is not here.
    const { profile } = resolveReconsiderationProfile('codex', {}, { readBounded: true });
    const argv = buildReconsiderationArgv(profile, { lastMessagePath: '/tmp/x' }).join(' ');
    for (const absent of ['--tools', '--allowedTools', '--disallowedTools', '--strict-mcp-config']) {
      expect(argv).not.toContain(absent);
    }
    // What IS enforced is the sandbox, and the profile says so under a name that
    // does not promise the missing property.
    expect(argv).toContain('--sandbox read-only');
    expect(profile.toolPolicy).toBe('read-bounded');
  });
});

// ---------------------------------------------------------------------------
// 4. The answer, and where it comes from
// ---------------------------------------------------------------------------

describe('the final-message handshake', () => {
  test('the verdict is the output file, never the progress stream', () => {
    // A decoy on stdout: a lane that scraped its answer from the progress stream
    // would admit a `withdraw` nobody issued.
    const { result } = invoke({
      runnerOptions: {
        finalMessage: fenced(reconsideration({ reconsideration: 'uphold' })),
        stdout: `${EVENTS}${fenced(reconsideration({ reconsideration: 'withdraw' }))}`,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.admitted.record.reconsideration).toBe('uphold');
    // The progress stream is preserved under a name that says what it is, and it
    // is not the raw transcript.
    const events = readFileSync(join(artifactDir, reconsiderationEventsArtifactName(LINEAGE)), 'utf8');
    expect(events).toContain('item.completed');
    const raw = readFileSync(join(artifactDir, reconsiderationRawArtifactName(LINEAGE)), 'utf8');
    expect(raw).toContain(RATIONALE);
    expect(raw).not.toContain('item.completed');
    expect(result.summary.eventsArtifact).toBe(reconsiderationEventsArtifactName(LINEAGE));
    expect(result.summary.rawArtifact).toBe(reconsiderationRawArtifactName(LINEAGE));
  });

  test('all three outcomes are admitted by the ordinary §12 parser', () => {
    for (const outcome of ['uphold', 'withdraw']) {
      rmSync(artifactDir, { recursive: true, force: true });
      mkdirSync(artifactDir, { recursive: true });
      const { result } = invoke({ runnerOptions: { finalMessage: fenced(reconsideration({ reconsideration: outcome })) } });
      expect(result.ok).toBe(true);
      expect(result.admitted.record.reconsideration).toBe(outcome);
    }
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
    const revise = reconsideration({
      reconsideration: 'revise',
      revision: {
        predecessorVersion: 1,
        changedFields: ['failureScenario'],
        revisionKind: 'narrowed_scope',
        materialityClaim: true,
        successor: {
          lineageId: LINEAGE,
          version: 2,
          severity: 'P1',
          violatedContract: 'The handler must reject a null session before dereferencing it.',
          preconditions: 'A request reaches the handler on the direct-dispatch path.',
          failureScenario: 'Only the direct-dispatch path skips the middleware and dereferences a null session.',
          affectedBoundary: 'src/auth/handler.ts',
          requiredOutcome: 'The handler rejects a null session on every entry path.',
          evidenceRefs: [{ kind: 'file', path: 'src/auth/middleware.ts', startLine: 10, endLine: 12 }],
        },
      },
    });
    const { result } = invoke({ runnerOptions: { finalMessage: fenced(revise) } });
    expect(result.ok).toBe(true);
    expect(result.summary.record).toMatchObject({ reconsideration: 'revise', successorVersion: 2 });
  });

  test('the §10.2 record carries the posture that actually decided the lineage', () => {
    const { result } = invoke();
    const written = JSON.parse(readFileSync(join(artifactDir, reconsiderationArtifactName(LINEAGE)), 'utf8'));
    expect(written.profile).toMatchObject({ agentId: 'codex', provider: 'openai', toolPolicy: 'read-bounded' });
    expect(written.profile.model).toBeUndefined();
    expect(result.summary.profile.toolPolicy).toBe('read-bounded');
    // A historical `no-tools` record is never reinterpreted, and this one is
    // never read as the stronger posture: the two files differ where it matters.
    const claudeDir = join(tmpRoot, 'claude-artifacts');
    mkdirSync(claudeDir, { recursive: true });
    const claude = runReviewReconsideration({
      routing: routing(),
      pending: { lineageId: LINEAGE, version: 1 },
      context: context(),
      issueBody: ISSUE_BODY,
      disputeArtifactDir: disputeDir,
      reviewArtifactDir: reviewDir,
      artifactDir: claudeDir,
      repoCwd,
      run: { runId: 'run-review-3', agentId: 'claude', timestamp: '2026-09-07T03:00:00.000Z' },
      runner: trackedFilesRunner(),
      agentId: 'claude',
      // The same opted-in session: the flag admits an agent, it does not relabel one.
      readBounded: true,
      env: { HOME: homeDir },
      agent: () => ({ stdout: fenced(reconsideration()), stderr: '', exitCode: 0 }),
    });
    expect(claude.ok).toBe(true);
    expect(
      JSON.parse(readFileSync(join(claudeDir, reconsiderationArtifactName(LINEAGE)), 'utf8')).profile.toolPolicy,
    ).toBe('no-tools');
    expect(claude.summary.eventsArtifact).toBeNull();
  });

  test('a retry of the same run is shown the same bundle and keys the same way', () => {
    const first = invoke().result;
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
    const second = invoke().result;
    expect(second.summary.runKey).toBe(first.summary.runKey);
    expect(second.summary.bundleDigest).toBe(first.summary.bundleDigest);
    expect(second.summary.promptBytes).toBe(first.summary.promptBytes);
    expect(readFileSync(join(artifactDir, reconsiderationArtifactName(LINEAGE)), 'utf8')).toBe(
      first.artifacts[0].content,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Failure modes: every one of them parks, none of them decides
// ---------------------------------------------------------------------------

describe('failures are operational facts, never verdicts', () => {
  test('a run that wrote no final message is missing-output, not a reviewer that said nothing useful', () => {
    const { result } = invoke({ runnerOptions: { finalMessage: undefined } });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ kind: 'missing-output', detail: '--output-last-message' });
    // The progress stream is still preserved: it is all an operator has to read.
    expect(readFileSync(join(artifactDir, reconsiderationEventsArtifactName(LINEAGE)), 'utf8')).toContain('item.started');
    expect(existsSync(join(artifactDir, reconsiderationArtifactName(LINEAGE)))).toBe(false);
  });

  test('a blank final message is empty-output', () => {
    const { result } = invoke({ runnerOptions: { finalMessage: '   \n' } });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ kind: 'empty-output', detail: null });
  });

  test('an output file that predates the run is refused rather than read', () => {
    // The run directory is fresh in production, so this is only reachable through
    // the seam — which is exactly why the seam exists: the refusal must be
    // testable, and a stale file must never be reported as this run's verdict.
    const staleDir = join(tmpRoot, 'stale-run-dir');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'final-message.txt'), fenced(reconsideration({ reconsideration: 'withdraw' })), 'utf8');
    const runner = codexRunner({ finalMessage: fenced(reconsideration()) });
    const { result } = invoke({ agentRunner: runner, makeRunDir: () => staleDir });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ kind: 'stale-output', detail: null });
    // Refused BEFORE the CLI was spawned: no turn was billed to learn this.
    expect(runner.calls).toEqual([]);
  });

  test('a final message past the read bound is refused as oversized', () => {
    const { result } = invoke({
      runnerOptions: { finalMessage: 'x'.repeat(MAX_RECONSIDERATION_RESPONSE_BYTES + 1) },
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      kind: 'oversized-output',
      detail: `bound:${MAX_RECONSIDERATION_RESPONSE_BYTES}`,
    });
  });

  test('a build that refuses a pinned flag is a capability answer, not an agent failure', () => {
    for (const [stderr, expected] of [
      ["error: unexpected argument '--output-last-message' found\n", '--output-last-message'],
      ['error: unrecognized option --ignore-user-config\n', '--ignore-user-config'],
      ['error: unknown flag: --nonsense\n', 'unknown-flag'],
    ]) {
      rmSync(artifactDir, { recursive: true, force: true });
      mkdirSync(artifactDir, { recursive: true });
      const { result } = invoke({ runnerOptions: { exitCode: 2, stderr, finalMessage: undefined } });
      expect(result.failure).toEqual({ kind: 'unsupported-capability', detail: expected });
    }
  });

  test('an ordinary nonzero exit is still an agent failure', () => {
    const { result } = invoke({
      runnerOptions: { exitCode: 1, stderr: 'quota exhausted\n', finalMessage: undefined },
    });
    expect(result.failure).toEqual({ kind: 'agent-failed', detail: 'exit:1' });
    expect(readFileSync(join(artifactDir, reconsiderationStderrArtifactName(LINEAGE)), 'utf8')).toBe('quota exhausted\n');
  });

  test('a deadline is reported as a deadline, and never as a refused flag', () => {
    const { result } = invoke({
      runnerOptions: {
        exitCode: 143,
        // A killed child can leave anything on stderr, including text that looks
        // like an argument-parser complaint. The deadline is the fact that was
        // observed, and only the layer that held it can say so (issue #953).
        stderr: "timed out\nerror: unexpected argument '--json'\n",
        spawnError: "error: unexpected argument '--json'\n",
        timedOut: true,
        finalMessage: undefined,
      },
    });
    expect(result.failure.kind).toBe('agent-failed');
    expect(result.summary.timedOut).toBe(true);
  });

  test('a final message that will not admit changes no state and keeps the transcript', () => {
    const { result } = invoke({ runnerOptions: { finalMessage: 'I am not persuaded, but here is prose instead.' } });
    expect(result.ok).toBe(false);
    expect(result.failure.kind).toBe('malformed-response');
    expect(result.artifacts).toEqual([]);
    expect(readFileSync(join(artifactDir, reconsiderationRawArtifactName(LINEAGE)), 'utf8')).toContain(
      'I am not persuaded',
    );
    expect(existsSync(join(artifactDir, reconsiderationArtifactName(LINEAGE)))).toBe(false);
  });

  test('a lineage whose evidence no longer resolves never reaches the CLI', () => {
    writeFileSync(join(repoCwd, 'src', 'auth', 'middleware.ts'), '// truncated\n', 'utf8');
    const runner = codexRunner({ finalMessage: fenced(reconsideration()) });
    const { result } = invoke({ agentRunner: runner });
    expect(result.ok).toBe(false);
    expect(result.failure.kind).toBe('malformed-dispute-artifact');
    expect(runner.calls).toEqual([]);
  });

  test('a spent §6.1 budget refuses the turn before the profile is resolved', () => {
    const spent = context();
    spent.lineages[LINEAGE].counters.reconsiderations = 1;
    const runner = codexRunner({ finalMessage: fenced(reconsideration()) });
    const { result } = invoke({ context: spent, agentRunner: runner });
    expect(result.failure.kind).toBe('reconsideration-slot-consumed');
    expect(runner.calls).toEqual([]);
    expect(result.summary.profile).toBeNull();
  });
});
