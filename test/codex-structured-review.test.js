/**
 * Unit tests for the issue #1068 structured Codex review invocation
 * (src/handlers/codex-structured-review.ts).
 *
 * The adapter builds the argv/stdin/output contract for the supported
 * `codex exec` path, hands the CLI a JSON Schema for the §2.1 envelope, runs it
 * under the shared isolation boundary, and returns one validated envelope or one
 * typed failure. Nothing is wired into review routing.
 *
 * Most of the file spawns a REAL child process. That is deliberate and is what
 * the Issue's acceptance asks for: an injected `invoke` that returns a canned
 * result proves nothing about the command actually constructed, the streams
 * actually separated, the files actually written, or the environment the child
 * actually saw. The subprocess fixture is a `/bin/sh` script that records its
 * argv, stdin, cwd and environment, honors `--output-last-message` and
 * `--output-schema`, and can be told to be noisy, slow, or hostile.
 *
 * The one thing swapped is the binary NAME: the profile resolves `codex`, and
 * the test's runner spawns the fixture instead — asserting on the way through
 * that the command it was asked to run was `codex`. Resolving the real binary
 * from PATH would risk a genuinely billed turn on a host that has Codex
 * installed, which no test may do.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  CODEX_REVIEW_EVENTS_ARTIFACT,
  CODEX_REVIEW_PROMPT_ARTIFACT,
  CODEX_REVIEW_RESPONSE_ARTIFACT,
  CODEX_REVIEW_RUNNER_ERROR_ARTIFACT,
  CODEX_REVIEW_SCHEMA_ARTIFACT,
  CODEX_REVIEW_STDERR_ARTIFACT,
  CODEX_STRUCTURED_REVIEW_EXEC_ARGS,
  admitCodexReviewEnvelope,
  buildCodexStructuredReviewArgv,
  buildCodexStructuredReviewPrompt,
  resolveCodexStructuredReviewProfile,
  runCodexStructuredReview,
} from '../dist/handlers/codex-structured-review.js';
import { resolveAgentPhaseRuntime } from '../dist/handlers/agent-runtime.js';
import { bothStreamsCommandRunner } from '../dist/handlers/command-runner.js';
import {
  REVIEW_FINDINGS_END_MARKER,
  REVIEW_FINDINGS_ENVELOPE_MAX_BYTES,
  REVIEW_FINDINGS_MARKER,
  structuredFindingsSupport,
} from '../dist/core/review-finding-envelope.js';
import { stripNullEnvelopeMembers } from '../dist/core/review-findings-schema.js';
import { isIndeterminateProbeError } from './helpers/cli-probe.js';

const BRIEF = 'Review the diff on this branch against the Issue contract.';
const LINEAGE = 'ln-aaaaaaaaaaaa';

const FINDING = {
  version: 1,
  severity: 'P1',
  violatedContract: 'The endpoint must never return 500 for an unauthenticated request.',
  preconditions: 'A request arrives with no Authorization header.',
  failureScenario: 'GET /orders with no header returns 500 instead of 401.',
  affectedBoundary: 'src/auth/handler.ts',
  requiredOutcome: 'Unauthenticated requests receive 401.',
  evidenceRefs: [{ kind: 'file', path: 'src/auth/handler.ts', startLine: 10, endLine: 12 }],
};

/** What a build that HONORED `--output-schema` returns: the bare, strict object. */
const STRICT_FINDINGS = JSON.stringify(
  { version: 1, status: 'findings', blockedReason: null, findings: [{ lineageId: null, ...FINDING }] },
  null,
  2,
);
const STRICT_SUCCESS = JSON.stringify({ version: 1, status: 'success', blockedReason: null, findings: null });

/** What a build that IGNORED it returns: a prose report with the marker envelope. */
const MARKER_SUCCESS = [
  '# Review',
  '',
  'Nothing blocking. Here is a snippet I considered:',
  '',
  '```json',
  '{ "not": "the envelope" }',
  '```',
  '',
  REVIEW_FINDINGS_MARKER,
  '{"version": 1, "status": "success"}',
  REVIEW_FINDINGS_END_MARKER,
  '',
].join('\n');

let tmpRoot;
let repoCwd;
let artifactDir;
let operatorHome;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'codex-structured-review-'));
  repoCwd = join(tmpRoot, 'checkout');
  artifactDir = join(tmpRoot, 'run');
  operatorHome = join(tmpRoot, 'operator-home');
  mkdirSync(join(repoCwd, 'src', 'auth'), { recursive: true });
  writeFileSync(join(repoCwd, 'src', 'auth', 'handler.ts'), 'export const handler = 1;\n', 'utf8');
  mkdirSync(artifactDir, { recursive: true });
  // A stand-in for the operator's home: the test owns it, and no run may write
  // to it or hand it to a child as `HOME`. The suite-wide isolated HOME (issue
  // #1063) keeps the REAL one off the machine's operator; this one makes the
  // adapter's own promise checkable.
  mkdirSync(join(operatorHome, '.codex'), { recursive: true });
  writeFileSync(join(operatorHome, '.codex', 'auth.json'), '{"token":"operator"}', 'utf8');
  writeFileSync(join(operatorHome, 'sentinel.txt'), 'untouched', 'utf8');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The subprocess fixture
// ---------------------------------------------------------------------------

/**
 * Written by an `ignoreSigterm` fixture the instant its `trap` is installed.
 *
 * The fixture is only SIGTERM-proof from that line onwards: everything before it
 * — `fork`, `execve`, the shell's own startup — runs with the default
 * disposition, and a host loaded enough to spend the deadline inside that window
 * gets a fixture killed by the deadline signal it was written to ignore. That is
 * a statement about the host, not about the runner, and the marker is what tells
 * the two apart (see {@link isHostStarvedReview} for the same rule on the other
 * cases).
 */
const TRAP_ARMED_MARKER = 'trap-armed';

/**
 * Written by every fixture as its LAST act before `exit`, and only if every line
 * before it succeeded (the fixture runs under `set -e`).
 *
 * A timeout or a spawn errno is not the only shape a starved host takes: a `cat`
 * the shell could not fork, or a fixture the OS killed mid-script, exits with a
 * status or leaves out a file the fixture never meant to — and the adapter then
 * truthfully reports an agent failure or a missing final message the case did
 * not stage. The marker keeps such a run from being read as the case's answer;
 * {@link invokeUntilAnswered} retries it once and fails the case if it recurs,
 * because a regression stops the fixture short in exactly the same way.
 */
const FIXTURE_COMPLETED_MARKER = 'fixture-completed';

/**
 * A `/bin/sh` stand-in for `codex`.
 *
 * It drains stdin before doing anything else: the prompt is delivered through
 * `spawnSync`'s `input`, and a child that exits without reading it can race
 * Node's pipe write into a spurious EPIPE on an otherwise-successful run
 * (issue #1027).
 */
function makeFakeCodex(name, opts = {}) {
  const { exitCode = 0, writeOutput = true, sleepSeconds = 0, ignoreSigterm = false } = opts;
  const dir = join(tmpRoot, `fake-${name}`);
  mkdirSync(dir, { recursive: true });
  const lines = [
    '#!/bin/sh',
    // IGNORED rather than handled, so the disposition is inherited by the `sleep`
    // below and neither the fixture nor its child can be stopped by the deadline's
    // own `SIGTERM`. This is the shape a synchronous child API's `timeout` cannot
    // enforce on its own — it sends that signal and then keeps waiting.
    // The marker is written IMMEDIATELY after the trap and before anything else,
    // so its presence is proof that the disposition was in place — see
    // {@link TRAP_ARMED_MARKER}. `DIR` is not set yet, so it is spelled out.
    ...(ignoreSigterm ? ["trap '' TERM", `: > '${join(dir, TRAP_ARMED_MARKER)}'`] : []),
    // Any line the host could not run stops the fixture short of
    // FIXTURE_COMPLETED_MARKER instead of carrying on without its effect.
    'set -e',
    `DIR='${dir}'`,
    "out=''",
    "prev=''",
    'for a in "$@"; do',
    '  case "$prev" in',
    '    --output-last-message) out="$a" ;;',
    '    --output-schema) cp "$a" "$DIR/schema-seen.json" ;;',
    '  esac',
    '  prev="$a"',
    'done',
    `printf '%s\\n' "$@" > "$DIR/argv.txt"`,
    'cat > "$DIR/stdin.txt"',
    'pwd > "$DIR/cwd.txt"',
    'env > "$DIR/env.txt"',
    ...(sleepSeconds > 0 ? [`sleep ${sleepSeconds}`] : []),
    'if [ -f "$DIR/events.txt" ]; then cat "$DIR/events.txt"; fi',
    'if [ -f "$DIR/stderr.txt" ]; then cat "$DIR/stderr.txt" >&2; fi',
    ...(writeOutput
      ? ['if [ -f "$DIR/response.txt" ] && [ -n "$out" ]; then cat "$DIR/response.txt" > "$out"; fi']
      : []),
    `: > "$DIR/${FIXTURE_COMPLETED_MARKER}"`,
    `exit ${exitCode}`,
  ];
  const bin = join(dir, 'codex-fixture');
  writeFileSync(bin, `${lines.join('\n')}\n`, 'utf8');
  chmodSync(bin, 0o755);
  return {
    bin,
    dir,
    response(text) {
      writeFileSync(join(dir, 'response.txt'), text, 'utf8');
      return this;
    },
    events(text) {
      writeFileSync(join(dir, 'events.txt'), text, 'utf8');
      return this;
    },
    stderr(text) {
      writeFileSync(join(dir, 'stderr.txt'), text, 'utf8');
      return this;
    },
    read(file) {
      const path = join(dir, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
    /** Did this attempt's fixture get as far as ignoring `SIGTERM`? */
    trapArmed() {
      return existsSync(join(dir, TRAP_ARMED_MARKER));
    },
    /** Forget it, so the NEXT attempt's marker answers for that attempt only. */
    forgetTrapArmed() {
      rmSync(join(dir, TRAP_ARMED_MARKER), { force: true });
      return this;
    },
    /** Did this attempt's fixture run every line through to its `exit`? */
    completed() {
      return existsSync(join(dir, FIXTURE_COMPLETED_MARKER));
    },
    /** Forget it, so the NEXT attempt's marker answers for that attempt only. */
    forgetCompleted() {
      rmSync(join(dir, FIXTURE_COMPLETED_MARKER), { force: true });
      return this;
    },
    argv() {
      const raw = this.read('argv.txt');
      return raw === null ? null : raw.split('\n').filter((line) => line !== '');
    },
    env() {
      const raw = this.read('env.txt') ?? '';
      const out = {};
      for (const line of raw.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
      }
      return out;
    },
  };
}

/**
 * The subprocess seam, spawning the fixture through the REAL default runner.
 *
 * Everything else on the path is production: the profile, the prompt, the schema,
 * the argv, the isolated environment, the run-owned temp directory, the bounded
 * read of the final message.
 */
function spawningRunner(fake, calls) {
  return {
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return bothStreamsCommandRunner.run(fake.bin, args, opts);
    },
  };
}

/**
 * Resolve a real `structured_exec` runtime through the boundary (issue #912):
 * model, effort, and binary reach the adapter exactly as production resolves
 * them — the built-in catalog plus the §8.1 break-glass variables in `env`.
 */
function structuredRuntime({ env = {}, labels = [] } = {}) {
  const resolution = resolveAgentPhaseRuntime({
    task: {
      sessionId: 'codex-review-test',
      issueNumber: 1,
      status: 'running',
      phase: 'review',
      priority: 'normal',
      attempts: {},
      context: { labels },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    session: {},
    phase: 'review',
    lane: 'structured_exec',
    agentId: 'codex',
    env,
  });
  if ('error' in resolution) throw new Error(resolution.error);
  return resolution.runtime;
}

function invoke(fake, overrides = {}) {
  const calls = [];
  const result = runCodexStructuredReview({
    brief: BRIEF,
    runtime: structuredRuntime(),
    repoCwd,
    artifactDir,
    artifactRoot: tmpRoot,
    timeoutMs: 20_000,
    env: {
      PATH: process.env.PATH,
      HOME: operatorHome,
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      XDG_CONFIG_HOME: join(operatorHome, '.config'),
      PWD: repoCwd,
    },
    agentRunner: spawningRunner(fake, calls),
    ...overrides,
  });
  return { result, calls };
}

/**
 * Is this failure a statement about the HOST rather than about the review?
 *
 * The fixture is a handful of `/bin/sh` lines, so nothing it does can spend the
 * deadline {@link invoke} sets or make a fork fail. A full parallel Jest run —
 * suites forking thousands of children — can do both, and the adapter then
 * reports exactly what it should: `timeout` for a deadline it enforced,
 * `agent-failed` carrying the spawn errno for a fork the host refused. Issue
 * #897 draws this line for CLI probes and its errno test is reused here rather
 * than restated; a deadline needs no errno, since a stub that cannot finish in
 * twenty seconds never finished for a reason of its own.
 */
function isHostStarvedReview(result) {
  if (result.ok) return false;
  if (result.failure.kind === 'timeout') return true;
  return result.failure.kind === 'agent-failed' && isIndeterminateProbeError(result.failure.detail ?? '');
}

/**
 * Invoke, asking again when the host starved the fixture instead of answering.
 *
 * Every case below reads either an admitted envelope or the specific refusal it
 * is about, and a starved run is neither: it would report a thrashing machine as
 * a review that timed out, an envelope that would not parse, or a refusal at the
 * wrong step. Re-running is safe — the adapter writes only into the artifact
 * directory and a run-owned temp directory it removes — and the artifact
 * directory is emptied between attempts so a starved attempt's stderr or runner
 * diagnostic cannot be read as the answering attempt's.
 *
 * Only {@link isHostStarvedReview}'s known transient failures — a deadline or a
 * spawn errno — can excuse a case from asserting. A fixture that stopped short of
 * {@link FIXTURE_COMPLETED_MARKER} with no such signal is retried once, since a
 * host may kill a script mid-line, but it never excuses the case: an adapter or
 * runner regression (a bad `--output-schema` path failing a `cp` under `set -e`,
 * say) stops the fixture the same way on every attempt, and the helper then
 * throws rather than let the case pass without an assertion.
 *
 * `calls` and the fixture's recordings belong to the LAST attempt, which is the
 * one every assertion is about. `answered` is false only when every attempt was
 * a known transient failure; the caller then declines to assert rather than
 * report the host as a defect in the adapter.
 */
function invokeUntilAnswered(fake, overrides = {}, attempts = 2) {
  let attempted;
  const incomplete = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      rmSync(artifactDir, { recursive: true, force: true });
      mkdirSync(artifactDir, { recursive: true });
    }
    fake.forgetCompleted();
    attempted = invoke(fake, overrides);
    const completed = fake.completed();
    const starved = isHostStarvedReview(attempted.result);
    if (completed && !starved) return { ...attempted, answered: true };
    const observed = JSON.stringify({ fixtureCompleted: completed, failure: attempted.result.failure ?? null });
    if (!starved) incomplete.push(observed);
    // Loud on purpose: a case that stops asserting has to be visible in the run
    // it happened in, not discovered later as coverage that quietly went away.
    console.warn(`codex structured review did not answer on attempt ${attempt}/${attempts}: ${observed}`);
  }
  if (incomplete.length > 0) {
    throw new Error(
      `the codex fixture stopped short with no deadline or spawn errno on ${incomplete.length} of ${attempts} ` +
        `attempt(s), which a host cannot excuse: ${incomplete.join('; ')}`,
    );
  }
  return { ...attempted, answered: false };
}

/**
 * The Jest budget for a case that may run {@link invokeUntilAnswered} twice: two
 * 20s deadlines plus the slack a host that earned them needs for everything
 * else. The default 30s would turn a tolerated retry into an untolerated Jest
 * timeout, which is the failure this helper exists to avoid.
 */
const STARVATION_TOLERANT_TIMEOUT_MS = 120_000;

/**
 * Windows has no `SIGTERM` a child can trap — `kill()` there is
 * `TerminateProcess` — so the deadline always returns on its own and there is
 * nothing to escalate. Mirrors `command-runner-process-tree.test.js`.
 */
const posixTest = process.platform === 'win32' ? test.skip : test;

/** A content snapshot of a directory tree, for "nothing was touched" assertions. */
function snapshot(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(path, rel);
      } else {
        out[rel] = readFileSync(path, 'utf8');
      }
    }
  };
  walk(root, '');
  return out;
}

function artifact(name) {
  const path = join(artifactDir, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

describe('the resolved invocation', () => {
  test('is the §17.7 `codex exec` shape, with no bypass flag anywhere', () => {
    const { profile } = resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} });
    expect(profile.cmd).toBe('codex');
    expect(profile.agentId).toBe('codex');
    expect(profile.role).toBe('structured-review');
    expect(profile.provider).toBe('openai');
    // §17.5 refuses the `no-tools` literal for Codex: `--sandbox read-only`
    // bounds writes and network but leaves reads available.
    expect(profile.toolPolicy).toBe('read-bounded');
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
    const joined = profile.argv.join(' ');
    expect(joined).not.toContain('--dangerously');
    expect(joined).not.toContain('bypass');
    expect(joined).not.toContain('--full-auto');
    expect(joined).not.toContain('danger-full-access');
    expect(CODEX_STRUCTURED_REVIEW_EXEC_ARGS[0]).toBe('exec');
    // Never the vendor's own diff-review pipeline: a dispute-protocol review is
    // runner-prompted by definition (§17.4 C1/C9).
    expect(profile.argv).not.toContain('review');
  });

  test('an unset model stays absent rather than guessed', () => {
    const { profile } = resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} });
    expect(profile.model).toBeUndefined();
    expect(profile.modelSource).toBe('cli-default');
    expect(profile.argv).not.toContain('--model');
  });

  test('session.codex.model is no longer read; CODEX_MODEL still precedes the subcommand (issue #912)', () => {
    // Pre-cutover the session model spliced --model before exec; the read-only
    // cutover deleted the per-lane chain, so the model comes from an openai
    // profile in agent-profiles.json or the CODEX_MODEL break-glass variable.
    const fromSession = resolveCodexStructuredReviewProfile({
      runtime: structuredRuntime(),
      codex: { model: 'gpt-5-codex' },
      env: {},
    }).profile;
    expect(fromSession.model).toBeUndefined();
    expect(fromSession.modelSource).toBe('cli-default');
    expect(fromSession.argv).not.toContain('--model');

    const fromEnv = resolveCodexStructuredReviewProfile({
      runtime: structuredRuntime({ env: { CODEX_MODEL: 'o4' } }),
      codex: { model: 'gpt-5-codex' },
      env: {},
    }).profile;
    expect(fromEnv.model).toBe('o4');
    expect(fromEnv.modelSource).toBe('env');
    expect(fromEnv.argv.slice(0, 3)).toEqual(['--model', 'o4', 'exec']);
  });

  test('effort comes from the boundary resolution: env wins over the quality binding (issue #912)', () => {
    // No label resolves `normal`, whose built-in openai binding is codex-high.
    const byDefault = resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} }).profile;
    expect(byDefault.effort).toBe('high');
    expect(byDefault.effortSource).toBe('default');
    expect(byDefault.argv).toContain('model_reasoning_effort=high');

    // review:low maps to `light` -> codex-light -> low, attributed to the label.
    const fromLabel = resolveCodexStructuredReviewProfile({
      runtime: structuredRuntime({ labels: ['review:low'] }),
      env: {},
    }).profile;
    expect(fromLabel.effort).toBe('low');
    expect(fromLabel.effortSource).toBe('label');
    expect(fromLabel.argv).toContain('model_reasoning_effort=low');

    // CODEX_EFFORT breaks the glass over the binding (§8.1 layer 1).
    const fromEnv = resolveCodexStructuredReviewProfile({
      runtime: structuredRuntime({ env: { CODEX_EFFORT: 'medium' }, labels: ['review:low'] }),
      env: {},
    }).profile;
    expect(fromEnv.effort).toBe('medium');
    expect(fromEnv.effortSource).toBe('env');
  });

  test('a CODEX_EFFORT the provider does not declare refuses before any run (never clamped)', () => {
    // Pre-cutover `xhigh`/`max` were silently mapped to `high`; §12.3 forbids
    // that substitution, so the boundary refuses the override outright.
    expect(() => structuredRuntime({ env: { CODEX_EFFORT: 'xhigh' } })).toThrow(/CODEX_EFFORT|effort/);
    expect(() => structuredRuntime({ env: { CODEX_EFFORT: 'max' } })).toThrow(/CODEX_EFFORT|effort/);
  });

  test('a further tier the catalog DECLARES runs instead of being re-refused (issue #912 review)', () => {
    // §6.2/§14.3: an installation whose Codex/model combination accepts a
    // fourth tier declares it in `agent-profiles.json` — a data edit. The
    // boundary validates `xhigh` against the widened descriptor, so this lane
    // must consume that validated string rather than impose a second
    // low/medium/high ceiling of its own.
    const profilesPath = join(tmpRoot, 'agent-profiles.json');
    writeFileSync(
      profilesPath,
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          openai: {
            capabilities: { model: 'free', effort: ['low', 'medium', 'high', 'xhigh'] },
            profiles: { 'codex-high': { effort: 'xhigh' } },
          },
        },
      }),
      'utf8',
    );
    const { profile } = resolveCodexStructuredReviewProfile({
      runtime: structuredRuntime({ env: { AGENT_PROFILES_FILE: profilesPath } }),
      env: {},
    });
    expect(profile.effort).toBe('xhigh');
    expect(profile.effortSource).toBe('catalog-overlay');
    expect(profile.argv).toContain('model_reasoning_effort=xhigh');
  });

  test('context-mode keeps the positioning rule the ordinary lane follows', () => {
    const { profile } = resolveCodexStructuredReviewProfile({
      runtime: structuredRuntime(),
      codex: { contextMode: { enabled: true, profile: 'ctx', config: ['context_mode=on'] } },
      env: {},
    });
    expect(profile.contextMode).toBe('enabled');
    // `--profile` is global and precedes `exec`; `-c` overrides follow it.
    expect(profile.argv.slice(0, 3)).toEqual(['--profile', 'ctx', 'exec']);
    expect(profile.argv.slice(-2)).toEqual(['-c', 'context_mode=on']);
  });

  test('an unresolvable context-mode configuration fails before any run', () => {
    const resolution = resolveCodexStructuredReviewProfile({
      runtime: structuredRuntime(),
      codex: { contextMode: { enabled: true } },
      env: {},
    });
    expect(resolution.kind).toBe('configuration-error');
    expect(resolution.error).toContain('no invocation form is configured');
  });

  test('an agent with no structured-review invocation fails closed', () => {
    const resolution = resolveCodexStructuredReviewProfile({
      agentId: 'claude',
      runtime: structuredRuntime(),
      env: {},
    });
    expect(resolution.kind).toBe('unsupported-agent');
    expect(resolution.error).toContain('Supported: codex');
  });

  test('the run-owned file paths are spliced in only at invocation time', () => {
    const { profile } = resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} });
    // The sanitized argv carries neither path: a local temp path is not a fact
    // about the review and does not belong in run metadata.
    expect(profile.argv).not.toContain('--output-last-message');
    expect(profile.argv).not.toContain('--output-schema');

    const full = buildCodexStructuredReviewArgv(profile, {
      lastMessagePath: '/tmp/x/final-message.txt',
      schemaPath: '/tmp/x/output-schema.json',
    });
    expect(full).toContain('--output-last-message');
    expect(full[full.indexOf('--output-last-message') + 1]).toBe('/tmp/x/final-message.txt');
  });

  test('`--output-schema` is opt-in, because §17.7 admits it only once C6 is verified', () => {
    const byDefault = resolveCodexStructuredReviewProfile({ runtime: structuredRuntime(), env: {} }).profile;
    expect(byDefault.capabilities.outputSchema).toBe(false);
    expect(
      buildCodexStructuredReviewArgv(byDefault, {
        lastMessagePath: '/tmp/x/final-message.txt',
        schemaPath: '/tmp/x/output-schema.json',
      }),
    ).not.toContain('--output-schema');

    const optedIn = resolveCodexStructuredReviewProfile({
      runtime: structuredRuntime(),
      outputSchema: true,
      env: {},
    }).profile;
    expect(optedIn.capabilities.outputSchema).toBe(true);
    const argv = buildCodexStructuredReviewArgv(optedIn, {
      lastMessagePath: '/tmp/x/final-message.txt',
      schemaPath: '/tmp/x/output-schema.json',
    });
    expect(argv[argv.indexOf('--output-schema') + 1]).toBe('/tmp/x/output-schema.json');
    // The `--json` progress separation is not gated on it: the final message is
    // read from its own file whether or not a schema constrained it.
    expect(argv).toContain('--json');
    expect(argv).toContain('--output-last-message');
  });
});

describe('the runner-authored prompt', () => {
  test('carries the brief and the shared §2.1 envelope instruction', () => {
    const prompt = buildCodexStructuredReviewPrompt({ brief: BRIEF });
    expect(prompt.startsWith(BRIEF)).toBe(true);
    expect(prompt).toContain(REVIEW_FINDINGS_MARKER);
    expect(prompt).toContain('Structured Finding Output (required)');
    expect(prompt).toContain('FINAL message');
    // With no Issue body captured, `issue_quote` is not resolvable and is not offered.
    expect(prompt).not.toContain('issue_quote');
  });

  test('offers `issue_quote` and the open lineages when the run has them', () => {
    const prompt = buildCodexStructuredReviewPrompt({
      brief: BRIEF,
      issueBodyAvailable: true,
      liveLineages: [{ lineageId: LINEAGE, version: 1, severity: 'P1', affectedBoundary: 'src/auth/handler.ts' }],
    });
    expect(prompt).toContain('issue_quote');
    expect(prompt).toContain(LINEAGE);
  });
});

// ---------------------------------------------------------------------------
// Subprocess fixtures
// ---------------------------------------------------------------------------

describe('a real `codex exec` invocation', () => {
  test(
    'valid findings admit, and the command actually constructed is the resolved one',
    () => {
      const fake = makeFakeCodex('findings').response(STRICT_FINDINGS);
      const { result, calls, answered } = invokeUntilAnswered(fake);
      if (!answered) return;

      expect(result.failure ?? null).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.envelope.status).toBe('findings');
      expect(result.envelope.candidates).toHaveLength(1);
      expect(result.envelope.candidates[0].severity).toBe('P1');
      expect(result.envelope.candidates[0].affectedBoundary).toBe('src/auth/handler.ts');
      // The strict encoding's `lineageId: null` never reaches the domain.
      expect(result.envelope.candidates[0].lineageId).toBeUndefined();

      // The runner was asked for `codex`, not for the fixture: the binary name is
      // the only thing this harness substitutes.
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('codex');

      const argv = fake.argv();
      expect(argv.slice(0, 6)).toEqual([
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--json',
      ]);
      expect(argv).toContain('--output-last-message');
      expect(argv).toContain('model_reasoning_effort=high');
      // Off by default under §17.7's C6 rule, and the review admits regardless:
      // the schema is assistance, the domain parser is the contract.
      expect(argv).not.toContain('--output-schema');
      expect(artifact(CODEX_REVIEW_SCHEMA_ARTIFACT)).toBeNull();
      expect(result.summary.artifacts.schema).toBeNull();
      expect(result.summary.schemaBytes).toBe(0);
      // The prompt travels on stdin and never appears in the argument list.
      expect(argv.some((arg) => arg.includes(BRIEF))).toBe(false);
      expect(fake.read('stdin.txt')).toBe(artifact(CODEX_REVIEW_PROMPT_ARTIFACT));
      expect(fake.read('stdin.txt')).toContain(BRIEF);
      // The review runs IN the checkout — that is what makes it a review.
      expect(statSync(fake.read('cwd.txt').trim()).ino).toBe(statSync(repoCwd).ino);

      expect(result.summary.envelope).toEqual({
        status: 'findings',
        findings: 1,
        ignoredRunnerOwnedFields: 0,
      });
      expect(result.summary.exitCode).toBe(0);
      expect(result.summary.timedOut).toBe(false);
      expect(result.summary.failure).toBeNull();
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a review that found nothing is an admitted `success`, not an empty result',
    () => {
      const fake = makeFakeCodex('success').response(STRICT_SUCCESS);
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.failure ?? null).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.envelope.status).toBe('success');
      expect(result.envelope.candidates).toEqual([]);
      expect(result.summary.envelope.findings).toBe(0);
      expect(artifact(CODEX_REVIEW_RESPONSE_ARTIFACT)).toBe(STRICT_SUCCESS);
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a build that ignored the schema still admits through the marker envelope',
    () => {
      const fake = makeFakeCodex('markers').response(MARKER_SUCCESS);
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.failure ?? null).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.envelope.status).toBe('success');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a lone fenced JSON final message is unwrapped',
    () => {
      const fake = makeFakeCodex('fenced').response(`\`\`\`json\n${STRICT_SUCCESS}\n\`\`\`\n`);
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.failure ?? null).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.envelope.status).toBe('success');
      // The whole message WAS the envelope, so there is no reviewer prose beside
      // it — an empty residual, not "prose the extractor could not find".
      expect(result.residual).toBe('');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'the run returns its own prose and stderr for a caller that must classify them',
    () => {
      // The §13 classifier reads the reviewer's residual prose, and a nonzero exit
      // is diagnosed from the CLI's stderr. Both are run-local text the literals-only
      // summary deliberately excludes, so the run hands them back directly rather
      // than making the caller re-read its own artifacts (issue #1069).
      const fake = makeFakeCodex('residual').response(MARKER_SUCCESS).stderr('warning: read-only sandbox\n');
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.ok).toBe(true);
      expect(result.streams.finalMessage).toBe(MARKER_SUCCESS);
      expect(result.streams.stderr).toBe('warning: read-only sandbox\n');
      // The report, without the envelope or its markers.
      expect(result.residual).toContain('Nothing blocking.');
      expect(result.residual).not.toContain(REVIEW_FINDINGS_MARKER);
      expect(result.residual).not.toContain('"status": "success"');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a failed run returns the same streams, so the failure can be diagnosed',
    () => {
      const fake = makeFakeCodex('failed-streams', { exitCode: 1, writeOutput: false }).stderr('boom\n');
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.ok).toBe(false);
      expect(result.failure.kind).toBe('agent-failed');
      expect(result.streams.finalMessage).toBeNull();
      expect(result.streams.stderr).toBe('boom\n');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'noisy progress and diagnostics cannot corrupt a clean review',
    () => {
      const events = [
        '{"type":"thread.started","thread_id":"t-1"}',
        '{"type":"item.completed","item":{"type":"reasoning"}}',
        '',
      ].join('\n');
      const noise = 'warning: could not read ~/.codex/config.toml\nwarning: sandbox policy resolved to read-only\n';
      const fake = makeFakeCodex('noisy').response(STRICT_FINDINGS).events(events).stderr(noise);
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;

      expect(result.failure ?? null).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.envelope.candidates).toHaveLength(1);
      // Three destinations, three files. The response holds the final message and
      // nothing else; the events file holds the JSONL and nothing else.
      expect(artifact(CODEX_REVIEW_RESPONSE_ARTIFACT)).toBe(STRICT_FINDINGS);
      expect(artifact(CODEX_REVIEW_EVENTS_ARTIFACT)).toBe(events);
      expect(artifact(CODEX_REVIEW_STDERR_ARTIFACT)).toBe(noise);
      expect(artifact(CODEX_REVIEW_RESPONSE_ARTIFACT)).not.toContain('thread.started');
      expect(artifact(CODEX_REVIEW_RESPONSE_ARTIFACT)).not.toContain('warning:');
      // No spawn-level failure happened, so no runner diagnostic is claimed.
      expect(artifact(CODEX_REVIEW_RUNNER_ERROR_ARTIFACT)).toBeNull();
      expect(result.summary.artifacts.runnerError).toBeNull();
      expect(result.summary.eventBytes).toBe(Buffer.byteLength(events, 'utf8'));
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'malformed output is refused with the §12 reason that refused it',
    () => {
      const fake = makeFakeCodex('malformed').response('{"version": 1, "status": "definitely-not-a-status"}');
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.ok).toBe(false);
      expect(result.failure.kind).toBe('malformed-response');
      expect(result.failure.protocol).toEqual({ reason: 'unknown-enum', detail: 'envelope.status' });
      // The raw response is still preserved: it is what an operator reads to see why.
      expect(artifact(CODEX_REVIEW_RESPONSE_ARTIFACT)).toContain('definitely-not-a-status');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a truncated final message is refused, not half-read',
    () => {
      // A response cut off mid-object is the shape a dropped connection or a
      // token ceiling produces, and it is exactly the one that must not be
      // salvaged into a partial verdict.
      const fake = makeFakeCodex('truncated').response(STRICT_FINDINGS.slice(0, STRICT_FINDINGS.length - 40));
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.ok).toBe(false);
      expect(result.failure.kind).toBe('malformed-response');
      expect(result.failure.protocol.reason).toBe('unparseable');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a prose-only response is a legacy review, not a malformed envelope',
    () => {
      const fake = makeFakeCodex('prose').response('Looks fine to me.\n');
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.ok).toBe(false);
      expect(result.failure.kind).toBe('envelope-absent');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a deadline is reported as a timeout, never as a review that failed',
    () => {
      // Long enough to outlive the deadline below, short enough that the `sleep`
      // orphaned by the shell's own SIGTERM is gone before the suite is.
      const fake = makeFakeCodex('slow', { sleepSeconds: 5 }).response(STRICT_SUCCESS);
      const { result, calls } = invoke(fake, { timeoutMs: 750 });
      expect(result.ok).toBe(false);
      expect(result.failure.kind).toBe('timeout');
      expect(result.summary.timedOut).toBe(true);
      // The runner's own diagnostic is preserved under a name that says who wrote
      // it, and is kept out of the CLI's stderr transcript.
      expect(artifact(CODEX_REVIEW_RUNNER_ERROR_ARTIFACT)).not.toBeNull();
      expect(result.summary.artifacts.runnerError).toBe(CODEX_REVIEW_RUNNER_ERROR_ARTIFACT);
      // The deadline is enforceable rather than merely requested: the runner is
      // asked for a process group, which is what arms issue #1060's escalation
      // (and what gives the tree sweep a group to sweep).
      expect(calls[0].opts.isolateProcessGroup).toBe(true);
    },
    30_000,
  );

  posixTest(
    'a CLI that ignores the deadline signal is force-killed, not waited out',
    () => {
      // The fixture traps `SIGTERM` and then sleeps far past every budget here.
      // `spawnSync`'s own `timeout` sends that signal and goes on blocking this
      // thread until the child chooses to exit — so without the process group,
      // `timeoutMs` is unenforceable and the phase waits out the agent instead of
      // the deadline. The sleep is bounded rather than infinite because that block
      // is synchronous: an unbounded one would hang the worker instead of failing.
      // The response is staged so the fixture is one a clean run WOULD have
      // reviewed: it never gets that far, and a killed run is not a review.
      const fake = makeFakeCodex('sigterm-proof', { sleepSeconds: 45, ignoreSigterm: true }).response(STRICT_SUCCESS);
      // The deadline is also the window the fixture has to fork, exec `/bin/sh`
      // and reach its `trap` line — everything before that line runs with the
      // DEFAULT disposition, so a deadline that expires inside process startup
      // kills the fixture with the very signal it was written to ignore and
      // proves nothing about the runner. Matches the budget the same technique
      // uses in `command-runner-process-tree.test.js`; a few hundred
      // milliseconds does not survive a loaded host, and widening it costs
      // nothing here because escalation lands at the deadline plus its grace.
      const deadlineMs = 1_500;
      let attempted;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt > 1) {
          // Fresh state per attempt, exactly as invokeUntilAnswered does it: a
          // starved attempt's marker or artifacts must not answer for this one.
          fake.forgetTrapArmed();
          rmSync(artifactDir, { recursive: true, force: true });
          mkdirSync(artifactDir, { recursive: true });
        }
        const startedAt = Date.now();
        attempted = { ...invoke(fake, { timeoutMs: deadlineMs }), elapsedMs: Date.now() - startedAt };
        if (fake.trapArmed()) break;
        // Loud on purpose: a case that stops asserting has to be visible in the
        // run it happened in. The host never got the fixture to the line that
        // makes it SIGTERM-proof, so the deadline signal simply killed it and
        // there was nothing for the watchdog to escalate against.
        console.warn(
          `codex structured review escalation starved on attempt ${attempt}/2 — the host did not reach the ` +
            `fixture's trap inside ${deadlineMs}ms (returned in ${attempted.elapsedMs}ms)`,
        );
        attempted = undefined;
      }
      // Every attempt was starved: report the host as a host, not as a runner
      // that failed to escalate.
      if (attempted === undefined) return;
      const { result, calls, elapsedMs } = attempted;

      expect(calls[0].opts.isolateProcessGroup).toBe(true);
      // The whole point: the call RETURNED, and said what happened.
      expect(result.ok).toBe(false);
      expect(result.failure.kind).toBe('timeout');
      expect(result.summary.timedOut).toBe(true);
      // Escalation waits out the deadline plus its grace period, so this cannot
      // be the fixture having honoured the signal after all...
      expect(elapsedMs).toBeGreaterThanOrEqual(5_000);
      // ...and it is nowhere near the 45s it would have taken to wait it out. The
      // margin is deliberately wide on the healthy side (escalation lands around
      // 6s) so a loaded host cannot fail this, while a runner that merely asked
      // for a deadline blocks for the fixture's whole sleep and cannot pass it.
      expect(elapsedMs).toBeLessThan(35_000);
      // A killed run is not a review, whatever the fixture managed to print.
      expect(result.summary.envelope).toBeNull();
    },
    120_000,
  );

  test(
    'a nonzero exit is an agent failure, with the status it actually reported',
    () => {
      const fake = makeFakeCodex('failed', { exitCode: 3 })
        .stderr('stream error: connection reset\n')
        .response(STRICT_SUCCESS);
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.ok).toBe(false);
      expect(result.failure).toEqual({ kind: 'agent-failed', detail: 'exit:3' });
      expect(result.summary.exitCode).toBe(3);
      // Both streams are preserved whatever the exit code.
      expect(artifact(CODEX_REVIEW_STDERR_ARTIFACT)).toContain('connection reset');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a build that refuses a pinned flag is an unsupported capability, not a review',
    () => {
      const fake = makeFakeCodex('unsupported', { exitCode: 2, writeOutput: false }).stderr(
        [
          "error: unexpected argument '--output-schema' found",
          '',
          'Usage: codex exec [OPTIONS] [PROMPT]',
          '',
          'For more information, try --help.',
          '',
        ].join('\n'),
      );
      const { result, answered } = invokeUntilAnswered(fake, { outputSchema: true });
      if (!answered) return;
      expect(result.ok).toBe(false);
      // The flag the build refused, taken from the line that refused it rather
      // than from the usage block that follows.
      expect(result.failure).toEqual({ kind: 'unsupported-capability', detail: '--output-schema' });
      // Not an agent failure and not an empty review: argument parsing fails
      // before a turn is billed, and grading C6 up is what would fix it.
      expect(result.summary.envelope).toBeNull();
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a clean exit that wrote no final message is not a clean review',
    () => {
      const fake = makeFakeCodex('no-output', { writeOutput: false }).events('{"type":"thread.started"}\n');
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.ok).toBe(false);
      expect(result.failure).toEqual({ kind: 'missing-output', detail: '--output-last-message' });
      expect(result.summary.artifacts.response).toBeNull();
      expect(result.summary.responseBytes).toBe(0);
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a blank final message is not a clean review either',
    () => {
      const fake = makeFakeCodex('blank').response('   \n\n');
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.ok).toBe(false);
      expect(result.failure.kind).toBe('empty-output');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'a final message that predates the invocation is refused before the CLI runs',
    () => {
      // The run directory is freshly created per invocation in production, so a
      // leftover cannot occur; the seam is what makes the refusal itself testable.
      const planted = join(tmpRoot, 'planted-run-dir');
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, 'final-message.txt'), STRICT_SUCCESS, 'utf8');
      const fake = makeFakeCodex('stale').response(STRICT_SUCCESS);
      const { result, calls } = invoke(fake, { makeRunDir: () => planted });
      expect(result.ok).toBe(false);
      expect(result.failure.kind).toBe('stale-output');
      // Nothing was spawned: reading that file would have reported another run's
      // verdict as this one's.
      expect(calls).toHaveLength(0);
      expect(fake.argv()).toBeNull();
    },
    30_000,
  );

  test(
    'the opted-in schema reaches the CLI byte-identically, and changes no judgement',
    () => {
      const fake = makeFakeCodex('schema').response(STRICT_FINDINGS);
      const { result, answered } = invokeUntilAnswered(fake, { outputSchema: true });
      if (!answered) return;
      expect(result.failure ?? null).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.envelope.candidates).toHaveLength(1);

      const argv = fake.argv();
      expect(argv).toContain('--output-schema');
      const schemaPath = argv[argv.indexOf('--output-schema') + 1];
      // The schema file is the runner's own, in a temp directory — never in the
      // checkout and never under the operator's home.
      expect(schemaPath.startsWith(repoCwd)).toBe(false);
      expect(schemaPath.startsWith(operatorHome)).toBe(false);
      expect(existsSync(schemaPath)).toBe(false);

      // What the CLI actually read is byte-identical to the preserved copy.
      expect(fake.read('schema-seen.json')).toBe(artifact(CODEX_REVIEW_SCHEMA_ARTIFACT));
      const schema = JSON.parse(fake.read('schema-seen.json'));
      expect(schema.title).toBe('review_findings_envelope');
      expect(schema.properties.status.enum).toContain('findings');
      expect(result.summary.artifacts.schema).toBe(CODEX_REVIEW_SCHEMA_ARTIFACT);
      expect(result.summary.schemaBytes).toBeGreaterThan(0);
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe('the isolation boundary', () => {
  test(
    'the child sees no GitHub credentials, no operator home, and its own Codex login',
    () => {
      const fake = makeFakeCodex('isolation').response(STRICT_SUCCESS);
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.failure ?? null).toBeNull();
      expect(result.ok).toBe(true);
      const childEnv = fake.env();

      expect(childEnv.GH_TOKEN).toBeUndefined();
      expect(childEnv.GITHUB_TOKEN).toBeUndefined();
      expect(childEnv.XDG_CONFIG_HOME).toBeUndefined();
      // A Codex review has a reachable command tool, so it gets the throwaway
      // home every tool-capable invocation gets — never the operator's, whatever
      // the profile's `read-bounded` label says.
      expect(childEnv.HOME).not.toBe(operatorHome);
      expect(result.summary.homePolicy).toBe('throwaway');
      // The CLI's own login is still reachable, which is why `--ignore-user-config`
      // is load-bearing rather than decorative (§17.4 C5).
      expect(childEnv.CODEX_HOME).toBe(join(operatorHome, '.codex'));
      expect(fake.argv()).toContain('--ignore-user-config');
      // Another provider's credentials do not survive the strip.
      expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(childEnv.OPENAI_API_KEY).toBe('openai-secret');
      // `PWD` names the directory the child is actually in.
      expect(statSync(childEnv.PWD).ino).toBe(statSync(repoCwd).ino);

      // Every temp directory the invocation created is gone.
      expect(existsSync(childEnv.GH_CONFIG_DIR)).toBe(false);
      const lastMessage = fake.argv()[fake.argv().indexOf('--output-last-message') + 1];
      expect(existsSync(dirname(lastMessage))).toBe(false);
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'the checkout and the operator home are byte-identical after a run',
    () => {
      const repoBefore = snapshot(repoCwd);
      const homeBefore = snapshot(operatorHome);
      const fake = makeFakeCodex('clean').response(STRICT_FINDINGS).stderr('noise\n');
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.failure ?? null).toBeNull();
      expect(result.ok).toBe(true);
      expect(snapshot(repoCwd)).toEqual(repoBefore);
      expect(snapshot(operatorHome)).toEqual(homeBefore);
      // The schema and the final message live in a run-owned temp directory and
      // in the artifact directory, never in the working branch.
      expect(existsSync(join(repoCwd, 'output-schema.json'))).toBe(false);
      expect(existsSync(join(repoCwd, 'final-message.txt'))).toBe(false);
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test(
    'the bounded summary carries literals only',
    () => {
      const fake = makeFakeCodex('summary').response(STRICT_FINDINGS);
      const { result, answered } = invokeUntilAnswered(fake);
      if (!answered) return;
      expect(result.failure ?? null).toBeNull();
      const serialized = JSON.stringify(result.summary);
      // No temp path, no artifact directory, no reviewer prose.
      expect(serialized).not.toContain(tmpdir());
      expect(serialized).not.toContain(artifactDir);
      expect(serialized).not.toContain(FINDING.failureScenario);
      // Artifact BASE names, not paths.
      expect(result.summary.artifacts.prompt).toBe(CODEX_REVIEW_PROMPT_ARTIFACT);
      expect(result.summary.artifacts.response).toBe(CODEX_REVIEW_RESPONSE_ARTIFACT);
      expect(result.summary.profile.toolPolicy).toBe('read-bounded');
    },
    STARVATION_TOLERANT_TIMEOUT_MS,
  );

  test('an artifact directory outside the session root is refused before anything runs', () => {
    const outside = mkdtempSync(join(tmpdir(), 'codex-review-outside-'));
    try {
      const result = runCodexStructuredReview({
        brief: BRIEF,
        runtime: structuredRuntime(),
        repoCwd,
        artifactDir: outside,
        artifactRoot: tmpRoot,
        agent: () => {
          throw new Error('the agent must not be reached');
        },
      });
      expect(result.ok).toBe(false);
      expect(result.failure).toEqual({ kind: 'unsafe-artifact-dir', detail: 'artifactDir' });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('the directory that is checked is the directory that is written', () => {
    const outside = mkdtempSync(join(tmpdir(), 'codex-review-escape-'));
    const swapped = join(tmpRoot, 'swapped-run');
    try {
      writeFileSync(join(outside, 'sentinel.txt'), 'untouched', 'utf8');
      symlinkSync(outside, swapped, 'dir');
      // The TOCTOU window, made deterministic. A safety check that reads
      // `input.artifactDir` and a write that reads it AGAIN is a window in which
      // the directory can be replaced with a symlink pointing anywhere the runner
      // can write — and a path-based write then follows it, with the review still
      // reporting success. A getter is that window without a scheduler: `input` is
      // the caller's object, so the only defence is to read the path once and
      // write through a descriptor pinned to what was checked.
      let reads = 0;
      const result = runCodexStructuredReview({
        brief: BRIEF,
        runtime: structuredRuntime(),
        repoCwd,
        artifactRoot: tmpRoot,
        get artifactDir() {
          reads += 1;
          return reads === 1 ? artifactDir : swapped;
        },
        agent: () => {
          throw new Error('the agent must not be reached');
        },
      });

      expect(result.ok).toBe(false);
      expect(result.failure).toEqual({ kind: 'unsafe-artifact-dir', detail: 'artifactDir' });
      // Nothing at all reached the swapped-in directory: not the prompt, and not
      // an emptied version of the file that was already there.
      expect(readdirSync(outside)).toEqual(['sentinel.txt']);
      expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched');
      // The refusal is a containment fact, so it names the directory rather than
      // whichever artifact happened to be next.
      expect(result.summary.artifacts.prompt).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a run directory replaced while the agent runs takes no post-run write', () => {
    const outside = mkdtempSync(join(tmpdir(), 'codex-review-midrun-'));
    try {
      writeFileSync(join(outside, 'sentinel.txt'), 'untouched', 'utf8');
      const result = runCodexStructuredReview({
        brief: BRIEF,
        runtime: structuredRuntime(),
        repoCwd,
        artifactDir,
        artifactRoot: tmpRoot,
        // The agent's runtime is the window the (1) check cannot cover: this is a
        // real swap of the admitted directory for a symlink out of the session
        // root, performed exactly where a prompt-injected agent could perform it.
        agent: () => {
          rmSync(artifactDir, { recursive: true, force: true });
          symlinkSync(outside, artifactDir, 'dir');
          return {
            stdout: '{"type":"thread.started"}\n',
            stderr: 'codex: done\n',
            exitCode: 0,
            finalMessage: STRICT_SUCCESS,
            finalMessageFailure: null,
            argv: [],
            schema: null,
            homePolicy: 'throwaway',
          };
        },
      });

      expect(result.ok).toBe(false);
      expect(result.failure).toEqual({ kind: 'unsafe-artifact-dir', detail: 'artifactDir' });
      // Neither the events nor the response — a review that cannot record itself
      // where it was admitted to is not a review that succeeded.
      expect(readdirSync(outside)).toEqual(['sentinel.txt']);
      expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched');
      expect(result.summary.artifacts.events).toBeNull();
      expect(result.summary.artifacts.response).toBeNull();
    } finally {
      rmSync(join(tmpRoot, 'run'), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('an agent that throws is a typed failure, not a throw', () => {
    const setupFailure = new Error("ENOSPC: no space left on device, mkdtemp '/tmp/ai-codex-review-io-XXXXXX'");
    setupFailure.code = 'ENOSPC';
    const result = runCodexStructuredReview({
      brief: BRIEF,
      runtime: structuredRuntime(),
      repoCwd,
      artifactDir,
      artifactRoot: tmpRoot,
      agent: () => {
        throw setupFailure;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ kind: 'agent-failed', detail: 'spawn:ENOSPC' });
    // The locator says only which errno it was; the message carries a TMPDIR path
    // and `detail` reaches a task's public summary.
    expect(JSON.stringify(result.summary)).not.toContain('no space left');
  });

  test('a run directory that cannot be created leaves no isolation directories behind', () => {
    // `buildIsolatedInvocation` creates its two directories before the run-owned
    // one exists, so a `makeRunDir` that fails is the setup path that can strand
    // them — and a host that fails it once (a full or unwritable TMPDIR) fails it
    // for every subsequent review too.
    // `tmpdir()` is shared with every other jest worker, and a concurrent review
    // elsewhere both creates and removes `ai-codex-review-*` directories while
    // this test runs. Only entries that appear are attributable to this call, so
    // the leak check is "nothing new", never "the exact same set".
    const isolationDirs = () =>
      new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('ai-codex-review-')));
    const before = isolationDirs();
    const setupFailure = new Error("ENOSPC: no space left on device, mkdtemp '/tmp/ai-codex-review-io-XXXXXX'");
    setupFailure.code = 'ENOSPC';
    const { result } = invoke(null, {
      makeRunDir: () => {
        throw setupFailure;
      },
      // The CLI is never reached: there is nowhere for it to write its answer.
      agentRunner: {
        run() {
          throw new Error('the CLI must not be spawned without a run directory');
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ kind: 'agent-failed', detail: 'spawn:ENOSPC' });
    const leaked = [...isolationDirs()].filter((name) => !before.has(name)).sort();
    expect(leaked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

describe('the response is validated, never repaired', () => {
  test('a bare envelope past the byte bound is refused exactly as a marked one is', () => {
    // Whitespace BETWEEN tokens: `JSON.parse` accepts it, and dropping the strict
    // encoding's `null`s re-serializes it away. Normalizing before the bound is
    // checked would therefore admit through the bare and fenced encodings a
    // payload every other encoding refuses.
    const padding = ' '.repeat(REVIEW_FINDINGS_ENVELOPE_MAX_BYTES + 1);
    const bloated = `{"version": 1,${padding}"status": "success", "blockedReason": null, "findings": null}`;
    expect(Buffer.byteLength(bloated, 'utf8')).toBeGreaterThan(REVIEW_FINDINGS_ENVELOPE_MAX_BYTES);

    const bare = admitCodexReviewEnvelope(bloated);
    expect(bare.ok).toBe(false);
    expect(bare.failure.kind).toBe('malformed-response');
    expect(bare.failure.protocol.reason).toBe('payload-too-large');

    // The same bytes through the fenced and the marker-delimited encodings: one
    // response, one verdict, whichever way the build wrote it.
    const fenced = admitCodexReviewEnvelope(`\`\`\`json\n${bloated}\n\`\`\``);
    expect(fenced.failure.protocol.reason).toBe('payload-too-large');
    const marked = admitCodexReviewEnvelope(
      `${REVIEW_FINDINGS_MARKER}\n${bloated}\n${REVIEW_FINDINGS_END_MARKER}\n`,
    );
    expect(marked.failure.protocol.reason).toBe('payload-too-large');
  });

  test('a response that cannot be re-serialized is a typed failure, not a throw', () => {
    // `JSON.parse` accepts nesting depths `JSON.stringify` cannot re-emit, so
    // dropping the strict encoding's `null`s can throw on a payload that parsed
    // cleanly. Normalization has no failure vocabulary, so it owes the caller the
    // agent's own bytes and the domain parser's own verdict.
    const depth = 10_000;
    const deep = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const payload = `{"version": 1, "status": "success", "blockedReason": null, "findings": null, "notes": ${deep}}`;
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(REVIEW_FINDINGS_ENVELOPE_MAX_BYTES);
    expect(() => stripNullEnvelopeMembers(payload)).not.toThrow();

    const admitted = admitCodexReviewEnvelope(payload);
    expect(admitted.ok).toBe(false);
    expect(admitted.failure.kind).toBe('malformed-response');
    // `unknown-field` when the depth only defeats serialization, `unparseable`
    // when it defeats this host's parser too. Never a review, and never a throw.
    expect(['unknown-field', 'unparseable']).toContain(admitted.failure.protocol.reason);
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('nothing outside this adapter moved', () => {
  test('`codex` is still an unsupported structured-findings review agent', () => {
    // §13's compatibility table is what makes a Codex reviewer run the legacy
    // prose path today, and flipping it is decision D1 of §17.6 — an operator's
    // to record, not this adapter's to assume (§17.9).
    const support = structuredFindingsSupport('codex');
    expect(support.supported).toBe(false);
  });
});
