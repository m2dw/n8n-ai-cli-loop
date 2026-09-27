/**
 * The default Claude/Codex dispute path, through PRODUCTION CLI dispatch and
 * across persistent phase runs (issue #1072; docs/review-dispute-contract.md
 * §3.4, §4, §5, §7.1, §8.2, §9, §10.2, §11, §12, §13, §17.11–§17.14).
 *
 * ## What this suite adds to the ones before it
 *
 * Issue #965 drove the real handlers with both parties on `claude`; issue #1071
 * drove the mixed Claude/Codex round trip across real phase boundaries. Both
 * replaced each §7.1 agent invocation with an in-process seam — a function that
 * returns what the CLI would have said. That proves the protocol layers compose.
 * It cannot prove that the argv, the stdin prompt, the isolated environment, the
 * temp-file handshake and the two-stream capture the SHIPPING invocation
 * performs ever reach a process.
 *
 * So here nothing is seamed at the agent boundary. `createReviewHandler` is
 * built with no `ReviewDisputeSubTurnSeams` at all, which means:
 *
 *  - the §17.11 review lane resolves its own `codex exec` invocation and spawns
 *    it through `bothStreamsCommandRunner`;
 *  - the §4.1 reconsideration resolves its own no-tools `claude` invocation,
 *    builds its own isolated environment, and spawns that;
 *  - the §8.3 arbiter is resolved by the shipping candidate resolver.
 *
 * What is fake is the model behind the CLI: `test/helpers/fake-agent-cli.mjs` is
 * installed on `PATH` under the real command names, answers from a queue the
 * scenario writes, and records every argv, prompt, cwd and environment it was
 * spawned with. A run that spawns an agent no scenario queued exits 3 and fails
 * the test rather than passing quietly.
 *
 * ## What is still deterministic, and why that is not the boundary under test
 *
 * `git` and `gh` are answered by an in-process responder (issue #1071's,
 * unchanged), and the `git` answers it gives are captured from the REAL
 * disposable repository this suite builds: a base commit, an issue commit on
 * `ai/issue-1072`, and the tracked index and diff that git itself produced for
 * them. Every §3.3 evidence resolution therefore reads real tracked files out of
 * a real checkout, and a scenario can assert against the checkout directly —
 * "the rebuttal edited nothing" is checked with `git status`, not inferred.
 * The substrate is not what this milestone integrated; the agent dispatch is.
 *
 * No network, no credential and no GitHub write is reachable: the isolated home
 * is this test's own, the fake CLIs record that no `GH_TOKEN` survived to them,
 * and every public comment is an outbox row in the test's own SQLite file.
 *
 * ## Where the Claude/Codex round trip stops, and why that is not a defect
 *
 * Until issue #1085 a Codex reconsideration was blocked outright on operator
 * decision D2 (§17.6, §17.12): C7 — removal of the tool surface — is `unknown`,
 * and §17.2 reads unknown as absent, so §8.2's "the bundle is the entire input"
 * cannot be enforced for that CLI. D2 has since been recorded (§17.16), and what
 * it admitted is a separately named, weaker posture behind an explicit,
 * default-off session opt-in — **not** a relabelling of §8.2's. So this suite
 * pins three pictures rather than two, all through the same dispatch:
 *
 *  - **without the opt-in**, the Codex-reviewed default path runs through real
 *    CLI dispatch up to that turn and then produces ONE bounded, actionable
 *    handoff — no counter spent, no row written, no process spawned, and a
 *    recovery that re-parks;
 *  - **with the opt-in**, the identical task reaches a real `codex exec`
 *    reconsideration subprocess and completes: a withdrawal, a material revision
 *    and an upheld dispute that escalates exactly once, each recording
 *    `toolPolicy: "read-bounded"` where the record and the operator surface will
 *    keep it. C7 has not moved and the argv says so: this lane passes no flag
 *    that removes a read tool, and nothing here claims one;
 *  - **on the lane whose reviewer of record has a §8.2 invocation**, the same
 *    round trips complete under `no-tools`, unchanged by any of the above.
 *
 * ## Bounded dispatch, and what issue #1089 found (and did not find)
 *
 * Two runs of #904's own verification stalled for hours with a Jest worker
 * blocked inside a synchronous spawn of exactly this suite's fake CLI, reading
 * its own stdin. The reconsideration and structured-review lanes above already
 * call `bothStreamsCommandRunner` directly with their OWN `timeout` and
 * `isolateProcessGroup` (see `review-reconsideration.ts`,
 * `codex-structured-review.ts`) — those were never the exposure. The ordinary
 * review dispatch (`review.ts`'s native lane) and the implementation agent's
 * own invocation (`implementation.ts`, both the first run and the bounded
 * repair) call the HANDLER-INJECTED runner with no `timeout` at all, and that
 * injected runner is exactly `hybridRunner` below for every case in this file.
 * That gap — confirmed by reading both call sites, not by reproducing the
 * stall — is closed here, at the harness boundary, rather than by adding a
 * timeout to those call sites: this suite's job is to bound what IT spawns,
 * not to decide the production deadline policy those handlers should carry
 * (that is the named successor repair's job, per the issue).
 *
 * A bound alone is not enough, though: a starved dispatch that returns is still
 * a starved dispatch, and handing its empty answer to the handler makes the
 * host's contention look like an agent that raised no finding or rebutted
 * nothing. So a production-shaped call the host never ran — one of #897's
 * host-starvation errnos (the deadline's own `ETIMEDOUT`, or an `EAGAIN`-class
 * refusal to fork at all), or a child killed from outside before it could even
 * reach the fixture's own call record — is re-attempted over a rewound queue
 * and call record (`isHostStarvedAgentDispatch`, `rewindAgentLedger`), loudly,
 * instead of being read as an answer. Each of those is POSITIVE evidence about
 * the host; a fixture that merely failed to start says nothing about one, and
 * keeps failing its case (see `isHostStarvedAgentDispatch`).
 *
 * And a retry cap is not a guarantee either. When every attempt is starved the
 * case DECLINES — `runPhase` raises `HostStarvedDispatch` and `dispatchTest`
 * warns and stops — rather than asserting against a run that reached its
 * conclusion without ever hearing from an agent. That is the same disposition
 * `runUntilProbeAnswers` gives a starved probe (`test/helpers/cli-probe.js`):
 * an unscheduled fork is a fact about the host and must not be read as a fact
 * about the protocol either way. That budget is spent once per RUN, not once
 * per dispatch — a handler keeps going after a starved dispatch, and letting
 * each of its later calls buy the full attempts × deadline again is what turns
 * a case that means to decline into a Jest timeout.
 *
 * What issue #1089 could NOT confirm: why the child's `readFileSync(0)` itself
 * blocked. Sixty standalone stdin probes and an isolated run of this suite's
 * 18 cases both passed; the stall reproduced only inside #904's own
 * verification run, twice, with no queued response ever consumed. Whether that
 * is host contention during a wider parallel run, a libuv/`spawnSync`
 * interaction under load, or something else remains open — this suite does not
 * claim to have reproduced or fixed that trigger, only to make sure it can no
 * longer hang a Jest worker indefinitely.
 */
import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, runNextPhase } from '../dist/index.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { createReviewHandler } from '../dist/handlers/review.js';
import { createImplementationHandler } from '../dist/handlers/implementation.js';
import { bothStreamsCommandRunner } from '../dist/handlers/command-runner.js';
import {
  REVIEW_FINDINGS_END_MARKER,
  REVIEW_FINDINGS_MARKER,
} from '../dist/core/review-finding-envelope.js';
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
} from '../dist/core/review-dispute-commit.js';
import {
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
  REVIEW_DISPUTE_SUB_TURN_EVENT,
} from '../dist/core/review-dispute-dispatch.js';
import { REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY } from '../dist/handlers/review-reconsideration-turn.js';
import { isIndeterminateProbeError } from './helpers/cli-probe.js';
import {
  disputeArtifactName,
  reconsiderationArtifactName,
  reconsiderationEventsArtifactName,
  reconsiderationRawArtifactName,
} from '../dist/core/review-dispute-lineage.js';
import { RECONSIDERATION_READ_BOUNDED_ARGS } from '../dist/handlers/review-reconsideration.js';
import { REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD } from '../dist/core/review-dispute-parties.js';
import { summarizeDisputeStatus } from '../dist/core/review-dispute-status.js';
import {
  CODEX_REVIEW_RESPONSE_ARTIFACT,
  CODEX_STRUCTURED_REVIEW_EXEC_ARGS,
} from '../dist/handlers/codex-structured-review.js';

// Every case runs two to four real phase runs against a real SQLite store, and
// each of those spawns real subprocesses (git, and the fake agent CLIs). Jest's
// 5s default is not close.
jest.setTimeout(180_000);

const SESSION_ID = 'default-path';
const ISSUE = 1072;
const KEY = { sessionId: SESSION_ID, issueNumber: ISSUE };
const BRANCH = `ai/issue-${ISSUE}`;
const PR_URL = 'https://github.com/m2dw/test-repo/pull/72';
const BOUNDARY = 'src/auth/handler.ts';
const SECOND_BOUNDARY = 'src/auth/session.ts';
const ISSUE_BODY =
  'The auth handler must reject a request with no session before it reads any tenant state.';
const RATIONALE =
  'RECONSIDERATION-PROSE: the cited middleware guard runs before the handler on every entry path.';
const ARGUMENT =
  'REBUTTAL-PROSE: the null session is already rejected by the middleware, so the cited crash cannot occur.';
const NOW = '2026-09-07T09:00:00.000Z';

/** The fake CLI body, spawned under the real command names. */
const FAKE_CLI = new URL('./helpers/fake-agent-cli.mjs', import.meta.url).pathname;

let tmpDir;
let repoRoot;
let artifactRoot;
let worktree;
let binDir;
let cliDir;
let homeDir;
let dbPath;
let store;
let outboxStore;
let trackedIndex;
let diffText;
let savedEnv;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/** 80 numbered lines: every `file` evidence reference below cites a range inside one. */
function filler() {
  return `${Array.from({ length: 80 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`;
}

/**
 * Install one fake CLI on `PATH` under its real name.
 *
 * A `#!/bin/sh` wrapper rather than the script itself: it pins `AI_FAKE_CLI_DIR`
 * into the process regardless of the environment the invocation was spawned
 * with — the reconsideration turn deliberately strips and rewrites most of it —
 * and it re-enters node by absolute path, so nothing depends on how `node`
 * happens to be resolved on the host.
 */
function installFakeCli(name) {
  const path = join(binDir, name);
  writeFileSync(
    path,
    `#!/bin/sh\n`
      + `AI_FAKE_CLI_DIR='${cliDir}'\n`
      + `export AI_FAKE_CLI_DIR\n`
      + `exec '${process.execPath}' '${FAKE_CLI}' '${name}' "$@"\n`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dispute-default-path-'));
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  worktree = join(tmpDir, 'wt', SESSION_ID, `issue-${ISSUE}`);
  binDir = join(tmpDir, 'bin');
  cliDir = join(tmpDir, 'cli');
  homeDir = join(tmpDir, 'home');
  dbPath = join(tmpDir, 'tasks.db');
  for (const dir of [repoRoot, artifactRoot, binDir, cliDir, homeDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // The disposable repository: a base commit on `main`, then the issue commit on
  // the PR branch. Real commits, because the substrate answers below are git's
  // own output for them and every §3.3 resolution reads these tracked files.
  mkdirSync(join(worktree, 'src', 'auth'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', worktree]);
  for (const path of [BOUNDARY, SECOND_BOUNDARY]) {
    writeFileSync(join(worktree, path), filler(), 'utf8');
  }
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', 'base'], worktree);
  git(['checkout', '-q', '-b', BRANCH], worktree);
  appendFileSync(join(worktree, BOUNDARY), '// issue work\n', 'utf8');
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', `issue #${ISSUE}`], worktree);
  trackedIndex = git(['ls-files', '-s'], worktree);
  diffText = git(['diff', 'main...HEAD'], worktree);

  for (const name of ['claude', 'codex', 'gemini']) installFakeCli(name);

  // The isolated home and the fake CLIs, for this test only. `process.env` is
  // the Jest sandbox's copy, and it is what `spawnEnv()` hands every child — so
  // this is both how the fakes are reached and how the agents' own home policy
  // (`agent-isolation.ts`) is observed: an Anthropic no-tools turn inherits THIS
  // home, and everything else gets a throwaway one.
  savedEnv = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  store = new SqliteTaskStore(dbPath);
  // The same file, so the §11 effects commit inside the completion's own
  // transaction rather than through the cross-backend fallback.
  outboxStore = new SqliteOutboxStore(dbPath);
  clock = 0;
});

afterEach(() => {
  outboxStore.close();
  store.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fake agents: queue in, recorded calls out
// ---------------------------------------------------------------------------

/** Queue the responses one CLI will give, in order. */
function queueAgent(cli, responses) {
  writeFileSync(join(cliDir, `${cli}.queue.json`), JSON.stringify(responses), 'utf8');
}

/** Every real subprocess invocation of the fake CLIs so far. */
function agentCalls(cli) {
  const path = join(cliDir, 'calls.jsonl');
  if (!existsSync(path)) return [];
  const all = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
  return cli === undefined ? all : all.filter((call) => call.cli === cli);
}

/** The §17.11 lane's answer: the envelope goes to `--output-last-message`. */
function codexFindings(findings) {
  return {
    finalMessage: findingsOutput(findings),
    // `--json` progress events, which the lane captures and never parses for a
    // verdict.
    stdout: '{"type":"item.started"}\n{"type":"item.completed"}\n',
  };
}

/** A plain answer on stdout, which is where the review, fix and reviewer lanes read. */
function saysOnStdout(text) {
  return { stdout: text };
}

function fencedJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

// ---------------------------------------------------------------------------
// Session, worktree and lock fixtures (issue #1071's, unchanged)
// ---------------------------------------------------------------------------

function baseSession({ reviewAgent = 'codex', ...overrides } = {}) {
  return {
    sessionId: SESSION_ID,
    repoKey: 'test-repo',
    repoRoot,
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    artifactRoot,
    githubOwner: 'm2dw',
    githubName: 'test-repo',
    defaults: { implementationAgent: 'claude', reviewAgent, researchAgent: 'gemini' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    ...overrides,
  };
}

function enabledSession(overrides = {}) {
  const { reviewDispute, ...rest } = overrides;
  return baseSession({
    ...rest,
    reviewDispute: { enabled: true, ...reviewDispute },
  });
}

function fakeResolveWorktree(input) {
  return {
    ok: true,
    path: worktree,
    worktreeId: `${input.sessionId}/issue-${input.issueNumber}`,
    branch: input.branch,
    created: false,
    branchReused: true,
  };
}

function fakeLock() {
  return {
    acquire: (ownerId, sessionId, issueNumber) => ({
      ok: true,
      locked: true,
      contextId: ownerId,
      sessionId,
      issueNumber,
    }),
    release: () => ({ ok: true, released: true }),
  };
}

// ---------------------------------------------------------------------------
// The runner: the substrate is answered in process, every agent is a subprocess
// ---------------------------------------------------------------------------

const PR_VIEW_JSON = JSON.stringify({
  number: 72,
  url: PR_URL,
  headRefName: BRANCH,
  baseRefName: 'main',
  state: 'OPEN',
  isCrossRepository: false,
});
const PR_LIST_JSON = JSON.stringify([{ number: 72, url: PR_URL, headRefName: BRANCH }]);

/** The commands that ARE the boundary under test; everything else is substrate. */
const AGENT_CMDS = new Set(['claude', 'codex', 'gemini']);

/**
 * Ceiling on a fake-agent subprocess call made through the injected runner
 * (issue #1089). A real one answers in milliseconds; this is generous enough
 * to absorb a loaded CI host forking under contention (see `probe()`'s 60s
 * network-tolerant budget in `command-runner.ts` for the same philosophy)
 * while still being a FINITE bound — a Jest `test.setTimeout` alone cannot
 * recover a worker blocked inside a synchronous spawn, only prevent one from
 * ever being armed.
 *
 * A caller-supplied `opts.timeout` narrower than this is honored, not
 * overridden: this is a ceiling, not a fixed value, so the deterministic hang
 * coverage below can ask for a short one without changing what real dispatch
 * gets.
 */
const FAKE_AGENT_DEADLINE_MS = 30_000;

/**
 * Bounded, secret-safe diagnostics for a fake-agent invocation that did not
 * return an ordinary answer (issue #1089): which stage of the driver was
 * running, which CLI, the OS pid, how long it ran and how it failed. Never the
 * prompt (`stdin`), never an absolute path — this is printed to the test's own
 * stdout, which can end up quoted in a verification-failure comment, and stdin
 * carries the finding/rebuttal prose while a path can carry this host's temp
 * layout.
 */
function recordAgentDiagnostic(stage, cli, result) {
  if (result.timedOut !== true && result.spawnError === undefined) return;
  console.error(
    `[fake-agent-cli #1089] stage=${stage} cli=${cli} pid=${result.pid ?? 'unknown'} ` +
      `elapsedMs=${result.durationMs ?? 'unknown'} timedOut=${result.timedOut === true} ` +
      `deadlineEscalated=${result.deadlineEscalated === true} spawnErrorCode=${result.spawnErrorCode ?? 'unknown'}`,
  );
}

/**
 * Is this failed dispatch a statement about the HOST rather than about dispatch
 * (issue #1089, reusing #897's errno line rather than restating it)?
 *
 * `fake-agent-cli.mjs` keeps its `SIGTERM`-ignoring listener attached for the
 * whole window from process start through the queue-file read — including the
 * `readFileSync(0)` that #904's own verification run twice found blocked for
 * hours — precisely because that window has to survive a slow host without a
 * deadline killing it before it can even decide whether the queued response is
 * a deliberate `hang`. The corollary: a call that genuinely stalls somewhere in
 * that window (fork/exec/module-load/stdin under contention, never asked for
 * `hang`) is just as `SIGTERM`-immune as the deliberate one, so only the
 * deadline's numeric `timedOut` — not "did the caller ask for a hang" — can
 * tell the two apart from here.
 *
 * A deadline is not the only way a thrashing host refuses to run this fixture,
 * though, and reading it as the only one is what let a starved run reach the
 * handler as if the agent had answered badly. `spawnSync` itself fails with
 * `EAGAIN`/`ENOMEM`/`EMFILE`/`ENFILE` when the host cannot fork at all — no
 * child, no deadline, no `timedOut` — and #897's whole point is that those
 * errnos are facts about the host either way. So a spawn-level failure is
 * classified by the SAME errno line, and by that line alone: `ENOENT` (nothing
 * on `PATH`) and `ENOBUFS` (an answer too large to capture) are absent from it,
 * stay determinate, and keep failing the case that produced them.
 *
 * Two failures name no errno at all, though, and both were still being handed
 * to the handler as answers:
 *
 *  - A child killed from outside — an OOM reaper, a supervisor sweeping a
 *    thrashing host — is reported as a plain non-zero status with no
 *    `spawnError` and no `timedOut`, but never with no evidence: `spawnSync`
 *    carries the killing signal through as {@link CommandRunResult.signal},
 *    and that IS the positive statement about the host this classification
 *    needs. It is read only together with the fixture's own marker —
 *    `fake-agent-cli.mjs` appends to `calls.jsonl` before it reads its queue or
 *    applies any response (the same read `sigterm-armed` gives the hang
 *    coverage below, and the convention `test/helpers/cli-probe.js` documents)
 *    — because the fixture can also kill ITSELF on a queued `signal` response,
 *    and that one is a scenario, not a host. No new record and a signal: nobody
 *    in this suite asked for that death. A record, signal or not: determinate,
 *    and it keeps failing.
 *  - Exit 3 with the fixture's "no queued response" refusal, but only for an
 *    attempt made over a REWOUND ledger: that is the one race
 *    {@link rewindAgentLedger} cannot close from the parent side — the starved
 *    predecessor ran to completion behind the rewind and re-consumed the entry
 *    this attempt restored. Left unclassified it surfaces as an unexpected
 *    agent run, which is a statement about the previous attempt's killer, not
 *    about the scenario. A first attempt's exit 3 keeps failing, as it must.
 *
 * Missing from that list, deliberately: "exited non-zero without recording a
 * call". A fixture that cannot start is not a host that would not start it, and
 * reading the two as one turns every deterministic startup failure into three
 * retries and a decline — `fake-agent-cli.mjs` exits 3 the moment
 * `AI_FAKE_CLI_DIR` is unset, node exits non-zero on a syntax error in it, and
 * both used to reach {@link dispatchTest} as "the host never ran it" and pass
 * the case without running a single assertion. The only starvation such an exit
 * can name is one it names OUT LOUD: an `EAGAIN`-class errno on its own stderr
 * (node's own `EMFILE`/`ENOMEM` failures say so), matched by the same #897 line
 * as everything above. Anything else is the fixture speaking, and stays a
 * failure.
 */
function isHostStarvedAgentDispatch(result, { callsBefore, rewound }) {
  if (result.timedOut === true) return isIndeterminateProbeError(result.spawnErrorCode ?? 'ETIMEDOUT');
  if (result.spawnError !== undefined) {
    return isIndeterminateProbeError(result.spawnErrorCode ?? result.spawnError);
  }
  if (result.exitCode === 0) return false;
  const stderr = String(result.stderr ?? '');
  if (recordedAgentCallCount() === callsBefore) {
    const killedFromOutside = typeof result.signal === 'string' && result.signal !== '';
    return killedFromOutside || isIndeterminateProbeError(stderr);
  }
  return rewound && stderr.includes('no queued response for this invocation');
}

/**
 * How many invocations the fake CLIs have recorded so far.
 *
 * Read as a marker rather than as content: every invocation appends exactly one
 * record before it can do anything else, so a rise in this count is the
 * fixture's own proof that a child got as far as the protocol under test.
 */
function recordedAgentCallCount() {
  const path = join(cliDir, 'calls.jsonl');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;
}

/**
 * How many times a production-shaped agent dispatch (no caller-narrowed
 * `timeout`) is attempted before its result is handed to the handler under
 * test. Same argv/stdin/cwd/env every time, over a ledger state rewound to what
 * the starved attempt found (see {@link rewindAgentLedger}), so a retry is the
 * same call rather than the next one.
 *
 * Three, matching `runUntilProbeAnswers`'s default rather than inventing a
 * second tolerance: the contention that starves this fixture arrives in windows
 * long enough to swallow adjacent cases — two consecutive ones failed that way
 * under a 280-suite run — and a single retry inside such a window is one draw
 * from the same bad distribution.
 *
 * A cap is not a guarantee, though, and `runUntilProbeAnswers` is explicit about
 * the other half: when every attempt is starved the caller must DECLINE rather
 * than read the last starved attempt as evidence. Exhausting these attempts
 * therefore raises {@link HostStarvedDispatch} out of {@link runPhase} instead
 * of handing the handler an empty answer to park on — see {@link dispatchTest}
 * for the read side.
 *
 * Spent once per RUN, not once per dispatch: a handler keeps going after a
 * starved dispatch, so a per-dispatch cap bounds nothing a case can budget
 * against. See the short-circuit in {@link hybridRunner}.
 */
const AGENT_DISPATCH_STARVATION_ATTEMPTS = 3;

/**
 * The other half of that cap: the wall clock one run may spend on starved
 * attempts before it stops asking, whatever the count says.
 *
 * A count alone bounds nothing a case can budget against, because the two ways a
 * host refuses a fork cost completely different amounts of time. An
 * `EAGAIN`-class refusal comes back in milliseconds, and three of those are
 * cheap enough to be worth asking for. A stall that eats the whole
 * {@link FAKE_AGENT_DEADLINE_MS} does not: three of THOSE are 90s, more than
 * half this suite's 180s per-case budget, spent to re-ask a question the host
 * has already failed to answer twice.
 *
 * 60s, i.e. two full deadlines: the point at which the remaining budget stops
 * being enough for the case to finish its own work and report the decline. The
 * count still governs the cheap refusals — this only ever cuts the expensive
 * ones short.
 */
const AGENT_DISPATCH_STARVATION_BUDGET_MS = 60_000;

/**
 * Raised when a production-shaped dispatch was starved on every attempt.
 *
 * Carries what the attempts looked like, so the declining case says out loud in
 * its own run WHICH stage the host never ran — coverage that stops asserting has
 * to be visible where it happened.
 */
class HostStarvedDispatch extends Error {
  constructor(dispatches) {
    super(
      `the host never ran ${dispatches.length} agent dispatch(es): ${dispatches
        .map((d) =>
          d.attempts === 0
            ? `stage=${d.stage} cli=${d.cli} not attempted (an earlier dispatch in this run was starved)`
            : `stage=${d.stage} cli=${d.cli} attempts=${d.attempts} timedOut=${d.timedOut} ` +
              `exitCode=${d.exitCode ?? 'unknown'} spawnErrorCode=${d.spawnErrorCode ?? 'unknown'}`,
        )
        .join('; ')}`,
    );
    this.name = 'HostStarvedDispatch';
    this.dispatches = dispatches;
  }
}

/**
 * Declare a case that DECLINES — warns and stops — when the host never ran one
 * of its agent subprocesses, instead of failing as if the agent had answered.
 *
 * The same disposition `runUntilProbeAnswers` gives a starved probe, applied at
 * the only place this suite can apply it: every case here drives real
 * subprocesses through {@link runPhase}, and a starved one leaves the run with
 * no verdict of its own to assert against. Anything else thrown — a real
 * assertion failure, a protocol regression — propagates untouched.
 */
function dispatchTest(name, body, timeout) {
  return test(
    name,
    async () => {
      try {
        await body();
      } catch (err) {
        if (!(err instanceof HostStarvedDispatch)) throw err;
        console.warn(`[fake-agent-cli #1089] declining "${name}": ${err.message}`);
      }
    },
    timeout,
  );
}

/**
 * The two files a fake-agent invocation writes: the queue it consumes its
 * response from and the call record every invocation appends to.
 *
 * Snapshotted before a production-shaped dispatch so a starved attempt can be
 * rewound out of both (see {@link rewindAgentLedger}).
 */
function agentLedgerSnapshot(cli) {
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  return {
    queue: read(join(cliDir, `${cli}.queue.json`)),
    calls: read(join(cliDir, 'calls.jsonl')),
  };
}

/**
 * Undo whatever a starved attempt managed to write before it was killed.
 *
 * The retry above is only honest if it re-attempts the SAME call, and an
 * attempt the parent never got an answer out of can still have moved both
 * ledgers on its way to being killed: `fake-agent-cli.mjs` appends to
 * `calls.jsonl` and shifts its queue as soon as it has read stdin, and — since
 * it ignores `SIGTERM` for exactly that window — a child the deadline gave up
 * on may run to completion anyway, consuming its response into a pipe nobody is
 * reading. Left in place, that turns the retry into a second, unqueued call:
 * the fixture exits 3 ("an agent ran that the scenario did not expect") and the
 * handler under test is handed a refusal the scenario never wrote.
 *
 * Rewinding both files together keeps the retry indistinguishable from a first
 * attempt for the response queue AND for the exact-spawn-count assertions this
 * suite makes, while the `console.warn` below keeps the starved attempt visible
 * in the run it happened in. Safe to do from here because the runner has
 * already swept the child's process group by the time it returns
 * (`terminateProcessTree`, issue #1060) — a child that survived even that could
 * still race this, and would then fail the case rather than pass it quietly.
 */
function rewindAgentLedger(cli, snapshot) {
  const restore = (path, contents) => {
    if (contents === undefined) rmSync(path, { force: true });
    else writeFileSync(path, contents, 'utf8');
  };
  restore(join(cliDir, `${cli}.queue.json`), snapshot.queue);
  restore(join(cliDir, 'calls.jsonl'), snapshot.calls);
}

function substrate({ diffStat = '1 file changed', stageable = '', verificationExit = 0 } = {}) {
  return (cmd, args) => {
    const ok = (stdout) => ({ stdout, stderr: '', exitCode: 0 });
    if (cmd === 'npm') {
      return verificationExit === 0
        ? ok('All tests passed.')
        : { stdout: '', stderr: '1 test failed', exitCode: verificationExit };
    }
    if (cmd === 'gh') {
      if (args.includes('view')) return ok(PR_VIEW_JSON);
      if (args.includes('list')) return ok(PR_LIST_JSON);
      return ok('');
    }
    if (cmd === 'git') {
      switch (args[0]) {
        case 'rev-list':
          return ok('0');
        case 'rev-parse':
          return ok(`refs/heads/${BRANCH}`);
        case 'diff':
          return ok(args.includes('--stat') ? diffStat : diffText);
        case 'ls-files':
          if (args.includes('-z')) return ok(stageable);
          if (args.includes('--others')) return ok('');
          // Captured from the real checkout, so the §3.3 index is git's own.
          return ok(trackedIndex);
        default:
          return ok('');
      }
    }
    return ok('');
  };
}

/**
 * The hybrid the handlers are driven with.
 *
 * An agent command is forwarded VERBATIM to the production
 * `bothStreamsCommandRunner` — same argv, same cwd, same stdin, same
 * environment, same two-stream capture — so the fake executable on `PATH` is
 * reached exactly as the installed CLI would be. Everything else is the
 * deterministic substrate above.
 */
function hybridRunner(options = {}, { stage = 'unknown' } = {}) {
  const respond = substrate(options);
  const calls = [];
  /** Dispatches the host starved on every attempt; see {@link dispatchTest}. */
  const starvedDispatches = [];
  /** Wall clock this run has already spent on starved attempts; see the budget above. */
  let starvedMs = 0;
  return {
    calls,
    starvedDispatches,
    run(cmd, args, opts) {
      const argv = args ?? [];
      calls.push({ cmd, args: argv, opts });
      if (AGENT_CMDS.has(cmd)) {
        // The production caller (review.ts's native lane, implementation.ts's
        // agent/repair invocations) passes no `timeout` at all — confirmed by
        // reading both call sites (see the file header) — so bounding it here
        // is what stands between a hung fake CLI and an indefinitely blocked
        // Jest worker.
        //
        // `isolateProcessGroup` is armed for every call, not only the
        // caller-narrowed ones: `fake-agent-cli.mjs` keeps a `SIGTERM`-ignoring
        // listener attached through its whole stdin/queue-read window (see
        // `isHostStarvedAgentDispatch`), so a plain deadline signal cannot be
        // trusted to end an ordinary stall there — only issue #1060's
        // escalation `SIGKILL` can, and only a call this runner armed the
        // watchdog for gets one. Scoping it to narrowed-timeout callers only
        // (the original shape here) is exactly what let #904's own
        // verification run leak the two fake-CLI processes this issue's
        // diagnostics caught pid-and-all: the deadline fired, `timedOut` came
        // back true, and nothing then killed the child.
        const narrowedByCaller = opts.timeout !== undefined;
        // A dispatch in this run was already starved on every attempt, so the
        // run is going to be DECLINED whatever anything else in it returns (see
        // {@link runPhase}). Attempting the next one anyway is what turns that
        // decline into a failure: the handler under test keeps going after a
        // starved dispatch — a review run dispatches its reviewer and then its
        // reconsideration turn, an implementation run its agent and then its
        // repair — so a second starved dispatch spends another full
        // AGENT_DISPATCH_STARVATION_ATTEMPTS × FAKE_AGENT_DEADLINE_MS, and two
        // of them exhaust this suite's whole 180s per-case budget on their own.
        // Jest then reports the declining case as a timeout, which is the exact
        // reading — "the protocol under test misbehaved" — this classification
        // exists to prevent.
        //
        // So the cap is per RUN, not per dispatch: once the host has refused
        // AGENT_DISPATCH_STARVATION_ATTEMPTS consecutive forks, the rest of that
        // run is not asked again. Recorded rather than silently skipped, and
        // named in the decline, so the case still says which dispatches it never
        // got an answer for. Caller-narrowed calls are exempt for the same
        // reason they are exempt from the retry: they are the deadline's own
        // coverage, not production-shaped dispatch.
        if (!narrowedByCaller && starvedDispatches.length > 0) {
          starvedDispatches.push({ stage, cli: cmd, attempts: 0, timedOut: false });
          return {
            stdout: '',
            stderr:
              'fake-agent-cli #1089: not dispatched — an earlier dispatch in this run was starved on every attempt',
            exitCode: 1,
            durationMs: 0,
          };
        }
        const bounded = {
          ...opts,
          timeout: narrowedByCaller ? Math.min(opts.timeout, FAKE_AGENT_DEADLINE_MS) : FAKE_AGENT_DEADLINE_MS,
          isolateProcessGroup: true,
        };
        // Taken before the attempt, so a starved one can be rewound out of both
        // ledgers and the retry can be the same call rather than the next one.
        // Not taken for a caller-narrowed call: that one is never retried here.
        const ledger = narrowedByCaller ? undefined : agentLedgerSnapshot(cmd);
        // The fixture's own "I reached the protocol" marker, read either side of
        // the attempt (see `isHostStarvedAgentDispatch`). Restored along with the
        // ledger, so it is the same number every attempt sees.
        let callsBefore = recordedAgentCallCount();
        let rewound = false;
        let attempt = 1;
        let result = bothStreamsCommandRunner.run(cmd, argv, bounded);
        recordAgentDiagnostic(stage, cmd, result);
        // Retried only for the production-shaped call (no caller-narrowed
        // timeout): a narrowed timeout means a scenario is deliberately
        // exercising the deadline itself (the hang-coverage test below), and
        // that one already runs its own outer starved/retry loop across a
        // freshly armed marker rather than this classification.
        while (!narrowedByCaller && isHostStarvedAgentDispatch(result, { callsBefore, rewound })) {
          starvedMs += result.durationMs ?? 0;
          const exhausted =
            attempt >= AGENT_DISPATCH_STARVATION_ATTEMPTS || starvedMs >= AGENT_DISPATCH_STARVATION_BUDGET_MS;
          console.warn(
            `[fake-agent-cli #1089] stage=${stage} cli=${cmd} starved on attempt ${attempt}/${AGENT_DISPATCH_STARVATION_ATTEMPTS} ` +
              `(elapsedMs=${result.durationMs ?? 'unknown'}, starvedMs=${starvedMs}, ` +
              `exitCode=${result.exitCode ?? 'unknown'}, ` +
              `spawnErrorCode=${result.spawnErrorCode ?? 'unknown'}) — ` +
              (exhausted
                ? 'out of budget; this case will decline rather than assert against a run the host never fed'
                : 'retrying the same argv/stdin/cwd before treating it as a real failure'),
          );
          if (exhausted) {
            // Out of attempts: this result is not an answer and must not be read
            // as one. Recorded rather than thrown from here — the handler under
            // test is between this runner and the case, and an exception raised
            // inside it would be reported as the handler failing rather than as
            // the host never running the agent.
            starvedDispatches.push({
              stage,
              cli: cmd,
              attempts: attempt,
              timedOut: result.timedOut === true,
              exitCode: result.exitCode,
              spawnErrorCode: result.spawnErrorCode,
            });
            break;
          }
          attempt += 1;
          rewindAgentLedger(cmd, ledger);
          rewound = true;
          callsBefore = recordedAgentCallCount();
          result = bothStreamsCommandRunner.run(cmd, argv, bounded);
          recordAgentDiagnostic(stage, cmd, result);
        }
        return result;
      }
      return respond(cmd, argv);
    },
    agentCalls: () => calls.filter((call) => AGENT_CMDS.has(call.cmd)),
    gitCalls: (sub) => calls.filter((call) => call.cmd === 'git' && call.args[0] === sub),
    npmCalls: () => calls.filter((call) => call.cmd === 'npm'),
  };
}

// ---------------------------------------------------------------------------
// Findings, dispositions and reconsiderations
// ---------------------------------------------------------------------------

const FINDING_A = {
  version: 1,
  severity: 'P1',
  violatedContract: 'Acceptance criterion: the handler must reject a request with no session',
  preconditions: 'A request arrives with no session cookie',
  failureScenario: 'FINDING-A-PROSE: the handler dereferences a null session and crashes the process',
  affectedBoundary: BOUNDARY,
  requiredOutcome: 'An unauthenticated request is rejected with 401 before any state read',
  evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 40, endLine: 44 }],
};

/** A second, unrelated blocking finding: a different contract on a different boundary. */
const FINDING_B = {
  version: 1,
  severity: 'P1',
  violatedContract: 'Acceptance criterion: session lookup must not widen the tenant scope',
  preconditions: 'A session is resolved for a tenant the caller does not belong to',
  failureScenario: 'FINDING-B-PROSE: the session store returns a cross-tenant record to the caller',
  affectedBoundary: SECOND_BOUNDARY,
  requiredOutcome: 'A cross-tenant session lookup is refused before any record is returned',
  evidenceRefs: [{ kind: 'file', path: SECOND_BOUNDARY, startLine: 10, endLine: 14 }],
};

function envelope(body) {
  return `${REVIEW_FINDINGS_MARKER}\n${JSON.stringify(body)}\n${REVIEW_FINDINGS_END_MARKER}`;
}

function findingsOutput(findings) {
  return envelope({ version: 1, status: 'findings', findings });
}

const CLEAN_OUTPUT = envelope({ version: 1, status: 'success' });

function dispositionBlock(records) {
  return `Here are my dispositions.\n\n${fencedJson(records)}`;
}

function disputeDisposition(lineageId, { version = 1, boundary = BOUNDARY } = {}) {
  return {
    lineageId,
    version,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId, version },
      rebuttalReason: 'false_premise',
      argument: ARGUMENT,
      evidenceRefs: [{ kind: 'file', path: boundary, startLine: 30, endLine: 36 }],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
  };
}

/** §3.1: a `fixed` disposition is only admissible from a run that changed files. */
function fixedDisposition(lineageId, version = 1) {
  return {
    lineageId,
    version,
    disposition: 'fixed',
    note: 'Added the missing null-session rejection on the direct-dispatch path.',
  };
}

function reconsiderationOutput(lineageId, record, version = 1) {
  return `Here is my reconsideration.\n\n${fencedJson({
    lineageId,
    version,
    rationale: RATIONALE,
    ...record,
  })}`;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

let clock = 0;
function nextNow() {
  clock += 1;
  return `2026-09-07T09:${String(clock).padStart(2, '0')}:00.000Z`;
}

async function enqueueReview() {
  await store.enqueueTask({
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    phase: 'review',
    priority: 'normal',
    context: {
      title: 'Reject unauthenticated requests before any tenant read',
      url: `https://github.com/m2dw/test-repo/issues/${ISSUE}`,
      body: ISSUE_BODY,
      prUrl: PR_URL,
      branch: BRANCH,
      labels: ['agent:claude', 'status:needs-review'],
    },
    now: NOW,
  });
}

/**
 * One REAL phase run: the actual handler, the actual phase runner, the actual
 * store and outbox — and, deliberately, NO `disputeSubTurns` argument, so every
 * §7.1 turn resolves and spawns its own production invocation.
 */
async function runPhase(phase, { runId, session = enabledSession(), ...runnerOptions } = {}) {
  const runner = hybridRunner(runnerOptions, { stage: `${phase}:${runId}` });
  const context = { session, runId, workerId: 'worker-test' };
  const handler =
    phase === 'review'
      ? createReviewHandler(context, runner, fakeResolveWorktree, fakeLock())
      : createImplementationHandler(context, runner, undefined, fakeResolveWorktree);
  const outcome = await runNextPhase({
    store,
    outboxStore,
    session,
    request: {
      sessionId: SESSION_ID,
      workerId: 'worker-test',
      runId,
      supportedPhases: [phase],
      now: nextNow(),
    },
    handlers: { [phase]: handler },
    now: nextNow(),
  });
  // Raised after the run rather than during it, and before anything reads the
  // outcome: whatever this run concluded, it concluded it without an agent, so
  // there is nothing here for a case to assert against.
  if (runner.starvedDispatches.length > 0) throw new HostStarvedDispatch(runner.starvedDispatches);
  const result =
    outcome.status === 'completed' || outcome.status === 'delayed' ? outcome.result.result : outcome.status;
  return { outcome, runner, result, task: await store.getTask(KEY) };
}

function blockOf(task) {
  return task.context[REVIEW_DISPUTE_CONTEXT_KEY];
}

function onlyLineageId(task) {
  const ids = Object.keys(blockOf(task).lineages);
  expect(ids).toHaveLength(1);
  return ids[0];
}

/**
 * Which lineage covers which boundary — the only stable key with two findings.
 * Suffix-matched because the persisted value is the admission-normalized path.
 */
function lineageIdForBoundary(task, boundary) {
  const found = Object.values(blockOf(task).lineages).filter((l) => l.affectedBoundary.endsWith(boundary));
  expect(found).toHaveLength(1);
  return found[0].lineageId;
}

async function transitionEvents() {
  const events = await store.listEvents(KEY);
  return events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
}

async function subTurnEvents() {
  const events = await store.listEvents(KEY);
  return events.filter((e) => e.type === REVIEW_DISPUTE_SUB_TURN_EVENT);
}

/** The §11 comments this task has published, whatever surface they went to. */
async function disputeComments() {
  const pending = await outboxStore.listPending();
  return pending.filter((entry) => String(entry.payload?.body ?? '').includes('Review dispute outcome'));
}

/** The supported operator continuation, and only after the park is asserted. */
async function recover(phase) {
  const before = await store.getTask(KEY);
  expect(before.status).toBe('ready_for_human');
  const result = await store.recoverHandoff(KEY, { fromStatus: 'ready_for_human', phase, now: nextNow() });
  expect(result.ok).toBe(true);
  return result.value;
}

/**
 * Re-queue the task at `review` from wherever the previous completion left it.
 *
 * A property of THIS driver, not of the protocol: a scenario that wants to run
 * one more review over a task the last run finished with (a resolved debate that
 * ended at the ordinary review handoff, or a turn §7.1 routed on its own) says so
 * through the same store port `admin recover` uses, rather than editing a row.
 * The park cases above deliberately use {@link recover}, which asserts the park
 * first.
 */
async function resumeReview() {
  const before = await store.getTask(KEY);
  if (before.status === 'queued' && before.phase === 'review') return before;
  const result = await store.recoverHandoff(KEY, {
    fromStatus: before.status,
    phase: 'review',
    now: nextNow(),
  });
  expect(result.ok).toBe(true);
  return result.value;
}

/** The run directory a phase run's artifacts land in. */
function runArtifacts(runId) {
  return join(artifactRoot, 'runs', runId);
}

/** What the real checkout looks like right now — not what the substrate claims. */
function checkoutStatus() {
  return git(['status', '--porcelain'], worktree).trim();
}

/**
 * Compare a path a CHILD reported with one this test built.
 *
 * `process.cwd()` in the child is resolved, and the system temp directory is a
 * symlink on macOS (`/var/folders/…` → `/private/var/folders/…`), so the two
 * spellings of the same directory are not the same string.
 */
function samePath(reported, expected) {
  return realpathSync(reported) === realpathSync(expected);
}

// ---------------------------------------------------------------------------
// Composite stages, each of them REAL runs against REAL subprocesses
// ---------------------------------------------------------------------------

/** Stage 1: the §17.11 Codex lane raises the given findings. */
async function raiseCodexFindings(findings, { session = enabledSession(), runId = 'run-review-1' } = {}) {
  await enqueueReview();
  queueAgent('codex', [codexFindings(findings)]);
  const run = await runPhase('review', { runId, session });
  expect(run.outcome.status).toBe('completed');
  expect(run.task.phase).toBe('implementation');
  return run;
}

/** Stage 1, Claude-reviewed: the ordinary structured review lane. */
async function raiseClaudeFindings(
  findings,
  { session = enabledSession({ reviewAgent: 'claude' }), runId = 'run-review-1' } = {},
) {
  await enqueueReview();
  queueAgent('claude', [saysOnStdout(findingsOutput(findings))]);
  const run = await runPhase('review', { runId, session });
  expect(run.outcome.status).toBe('completed');
  expect(run.task.phase).toBe('implementation');
  return run;
}

/** Stage 2: the fix agent answers with a disposition set. */
async function fixRunAnswers(records, { runId = 'run-impl-2', session = enabledSession(), ...runnerOptions } = {}) {
  queueAgent('claude', [saysOnStdout(dispositionBlock(records))]);
  return runPhase('implementation', { runId, session, ...runnerOptions });
}

/**
 * Stages 1–2 for one finding on the Claude-reviewed lane, ending with a
 * `disputed` lineage the implementer rebutted without editing anything.
 */
async function openClaudeReviewedDispute() {
  const session = enabledSession({ reviewAgent: 'claude' });
  const raised = await raiseClaudeFindings([FINDING_A], { session });
  const lineageId = onlyLineageId(raised.task);
  const rebutted = await fixRunAnswers([disputeDisposition(lineageId)], {
    session,
    diffStat: '',
    stageable: '',
  });
  expect(blockOf(rebutted.task).lineages[lineageId].state).toBe('disputed');
  expect(rebutted.task).toMatchObject({ status: 'queued', phase: 'review' });
  return { ...rebutted, session, lineageId };
}

// ===========================================================================
// 1. The default Claude/Codex path, dispatched to real CLI processes
// ===========================================================================

describe('the default Claude/Codex path, through production CLI dispatch', () => {
  dispatchTest('a Codex finding and a Claude rebuttal are real subprocesses, and the reviewer turn stops for D2', async () => {
    const raised = await raiseCodexFindings([FINDING_A]);
    const lineageId = onlyLineageId(raised.task);

    // --- the review: `codex exec`, spawned, with the §17.7 argv it pins ------
    const codex = agentCalls('codex');
    expect(codex).toHaveLength(1);
    for (const flag of CODEX_STRUCTURED_REVIEW_EXEC_ARGS) expect(codex[0].argv).toContain(flag);
    expect(codex[0].argv).toContain('--output-last-message');
    // §17.11: the routed lane, never the native `codex review` subcommand.
    expect(codex[0].argv).not.toContain('review');
    // The checkout under review is the cwd, and the runner-authored prompt —
    // the §2.1 envelope instruction included — travelled on stdin.
    expect(samePath(codex[0].cwd, worktree)).toBe(true);
    expect(codex[0].stdin).toContain(REVIEW_FINDINGS_MARKER);
    // §17.7's environment row: a throwaway home, and no GitHub credential.
    expect(codex[0].env.HOME).not.toBe(homeDir);
    expect(codex[0].env.hasGithubToken).toBe(false);
    // The lane's own artifacts are on disk, holding what the process produced.
    const reviewArtifacts = runArtifacts('run-review-1');
    expect(readFileSync(join(reviewArtifacts, CODEX_REVIEW_RESPONSE_ARTIFACT), 'utf8')).toContain(
      'FINDING-A-PROSE',
    );
    // The finding opened, and the party recorded beside it is the agent that
    // actually raised it.
    expect(blockOf(raised.task).lineages[lineageId].state).toBe('open');
    expect(raised.task.context[REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD]).toEqual({
      review: { agentId: 'codex' },
    });

    // --- the rebuttal: `claude`, spawned, and it edits nothing --------------
    const rebutted = await fixRunAnswers([disputeDisposition(lineageId)], { diffStat: '', stageable: '' });
    const claude = agentCalls('claude');
    expect(claude).toHaveLength(1);
    expect(samePath(claude[0].cwd, worktree)).toBe(true);
    expect(claude[0].stdin).toContain(lineageId);
    expect(claude[0].env.hasGithubToken).toBe(false);
    // §3.4: a validated rebuttal is protocol progress, so a zero-change run is a
    // SUCCESS — and the real checkout confirms it really was zero-change.
    expect(rebutted.result).toBe('success');
    expect(checkoutStatus()).toBe('');
    expect(rebutted.runner.gitCalls('commit')).toHaveLength(0);
    expect(rebutted.runner.gitCalls('push')).toHaveLength(0);
    // §3.4 relaxes the diff check and nothing else: the configured verification
    // still ran over the branch this run left behind.
    expect(rebutted.runner.npmCalls()).not.toHaveLength(0);
    expect(blockOf(rebutted.task).lineages[lineageId]).toMatchObject({
      state: 'disputed',
      rebuttedVersions: [1],
      counters: { rebuttals: 1, reconsiderations: 0 },
    });
    expect(rebutted.task.context[REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD]).toEqual({
      implementation: { agentId: 'claude' },
      review: { agentId: 'codex' },
    });
    expect(rebutted.task).toMatchObject({ status: 'queued', phase: 'review' });
    // The §10.2 rebuttal record the reviewer's turn would read is really on disk.
    expect(existsSync(join(runArtifacts('run-impl-2'), disputeArtifactName(lineageId)))).toBe(true);

    // --- the reviewer's turn: refused, and nothing runs ---------------------
    const before = JSON.parse(JSON.stringify(blockOf(rebutted.task)));
    const transitionsBefore = (await transitionEvents()).length;
    const spawnedBefore = agentCalls().length;

    const reviewed = await runPhase('review', { runId: 'run-review-3' });
    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.status).toBe('ready_for_human');
    // Nothing was spawned at all: not the review lane, not the reviewer's turn.
    // §17.12's refusal is a capability answer, taken before any process exists.
    expect(agentCalls()).toHaveLength(spawnedBefore);
    expect(reviewed.runner.agentCalls()).toHaveLength(0);
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      taskTurn: 'reviewer',
      lineageIds: [lineageId],
      disposition: 'parked',
      failure: 'profile_unavailable',
    });
    // The debate is byte-identical, no §7 row was written, and nothing public
    // was said about a dispute that has not resolved.
    expect(blockOf(reviewed.task)).toEqual(before);
    expect(blockOf(reviewed.task).lineages[lineageId].counters.reconsiderations).toBe(0);
    expect(await transitionEvents()).toHaveLength(transitionsBefore);
    expect(await subTurnEvents()).toHaveLength(1);
    expect(await disputeComments()).toHaveLength(0);
  });

  dispatchTest('the D2 park is the whole handoff: a recovery re-parks and consumes nothing', async () => {
    const raised = await raiseCodexFindings([FINDING_A]);
    const lineageId = onlyLineageId(raised.task);
    await fixRunAnswers([disputeDisposition(lineageId)], { diffStat: '', stageable: '' });
    const transitionsAfterRebuttal = (await transitionEvents()).length;

    const first = await runPhase('review', { runId: 'run-review-3' });
    expect(first.task.status).toBe('ready_for_human');
    const parked = JSON.parse(JSON.stringify(blockOf(first.task)));
    const spawnedAtPark = agentCalls().length;

    await recover('review');
    const second = await runPhase('review', { runId: 'run-review-4' });
    expect(second.result).toBe('blocked');
    expect(second.task.status).toBe('ready_for_human');
    expect(blockOf(second.task)).toEqual(parked);
    expect(agentCalls()).toHaveLength(spawnedAtPark);
    // §6.1: the rebuttal slot was consumed exactly once, by the fix run.
    expect(blockOf(second.task).lineages[lineageId]).toMatchObject({
      state: 'disputed',
      version: 1,
      rebuttedVersions: [1],
      counters: { rebuttals: 1, reconsiderations: 0, arbitrationPasses: 0 },
    });
    expect(await transitionEvents()).toHaveLength(transitionsAfterRebuttal);
    // One audit line per attempt: a park with an unchanged block would otherwise
    // be indistinguishable from a task nothing ever tried to run.
    expect(await subTurnEvents()).toHaveLength(2);
  });

  dispatchTest('an unrelated finding fixed in the same run keeps its terminal state while the dispute waits', async () => {
    const raised = await raiseCodexFindings([FINDING_A, FINDING_B]);
    const disputedId = lineageIdForBoundary(raised.task, BOUNDARY);
    const fixedId = lineageIdForBoundary(raised.task, SECOND_BOUNDARY);
    expect(disputedId).not.toBe(fixedId);

    const answered = await fixRunAnswers([disputeDisposition(disputedId), fixedDisposition(fixedId)], {
      diffStat: '1 file changed',
      stageable: `${SECOND_BOUNDARY}\0`,
    });
    expect(answered.result).toBe('success');
    expect(blockOf(answered.task).lineages[disputedId].state).toBe('disputed');
    expect(blockOf(answered.task).lineages[fixedId].state).toBe('resolved_fixed');

    // The review phase owes the reviewer's turn and cannot take it, so it parks
    // — and must NOT fall through to an ordinary review that could report a
    // clean pass over an open debate.
    const reviewed = await runPhase('review', { runId: 'run-review-3' });
    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      lineageIds: [disputedId],
      disposition: 'parked',
    });
    expect(blockOf(reviewed.task).lineages[fixedId].state).toBe('resolved_fixed');
    expect(blockOf(reviewed.task).lineages[disputedId].state).toBe('disputed');
  });

  dispatchTest('a disabled session runs the native `codex review` binary and leaves the debate where it is', async () => {
    const raised = await raiseCodexFindings([FINDING_A]);
    const lineageId = onlyLineageId(raised.task);
    const rebutted = await fixRunAnswers([disputeDisposition(lineageId)], { diffStat: '', stageable: '' });
    const before = JSON.parse(JSON.stringify(blockOf(rebutted.task)));
    const transitionsBefore = (await transitionEvents()).length;

    // The rollback an operator performs: the protocol is switched off with a
    // debate on file. §13's default-off guarantee is the NATIVE command, and
    // here that is asserted of the process actually spawned.
    queueAgent('codex', [saysOnStdout('No blocking issues.')]);
    const disabled = await runPhase('review', {
      runId: 'run-review-3',
      session: baseSession({ reviewDispute: { enabled: false } }),
    });
    const codex = agentCalls('codex');
    expect(codex).toHaveLength(2);
    expect(codex[1].argv).toContain('review');
    expect(codex[1].argv).not.toContain('exec');
    expect(codex[1].argv).not.toContain('--output-last-message');
    expect(blockOf(disabled.task)).toEqual(before);
    expect(disabled.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toBeUndefined();
    expect(await transitionEvents()).toHaveLength(transitionsBefore);
  });
});

// ===========================================================================
// 1b. The Codex reviewer's own reconsideration, under the §17.6 D2 opt-in
// ===========================================================================

/**
 * The same session, with the one operator decision that admits the turn.
 *
 * Everything else is identical to the block above — same reviewer, same
 * implementer, same dispatch, same task — so the opt-in is demonstrably what
 * makes the difference between the D2 park and a completed debate.
 */
function optedInSession(overrides = {}) {
  const { reviewDispute, ...rest } = overrides;
  return enabledSession({
    ...rest,
    reviewDispute: { ...reviewDispute, reconsideration: { readBounded: true } },
  });
}

/** The `read-bounded` lane's answer: the record goes to `--output-last-message`. */
function codexReconsideration(lineageId, record, version = 1) {
  return {
    finalMessage: reconsiderationOutput(lineageId, record, version),
    // `--json` progress events. Never the verdict, and never parsed for one.
    stdout: '{"type":"item.started"}\n{"type":"item.completed"}\n',
  };
}

/** Stages 1–2 on the opted-in session, ending with a `disputed` lineage. */
async function openCodexReviewedDispute(session = optedInSession()) {
  const raised = await raiseCodexFindings([FINDING_A], { session });
  const lineageId = onlyLineageId(raised.task);
  const rebutted = await fixRunAnswers([disputeDisposition(lineageId)], {
    session,
    diffStat: '',
    stageable: '',
  });
  expect(blockOf(rebutted.task).lineages[lineageId].state).toBe('disputed');
  expect(rebutted.task).toMatchObject({ status: 'queued', phase: 'review' });
  return { ...rebutted, session, lineageId };
}

describe('the Codex reviewer reconsiders its own finding under the read-bounded posture', () => {
  dispatchTest('a withdrawal is decided by a real `codex exec` process and needs no operator step', async () => {
    const { lineageId, session } = await openCodexReviewedDispute();
    const spawnedBefore = agentCalls().length;

    queueAgent('codex', [codexReconsideration(lineageId, { reconsideration: 'withdraw' })]);
    const reviewed = await runPhase('review', { runId: 'run-review-3', session });

    // --- the invocation §17.7/§17.16 pin, as it was actually spawned ---------
    const spawned = agentCalls('codex').slice(-1)[0];
    expect(agentCalls()).toHaveLength(spawnedBefore + 1);
    expect(spawned.cli).toBe('codex');
    for (const flag of RECONSIDERATION_READ_BOUNDED_ARGS) expect(spawned.argv).toContain(flag);
    expect(spawned.argv).toContain('--output-last-message');
    // The reviewer of record answered: no substitution to Claude, and no second
    // process took the turn on its behalf.
    expect(agentCalls('claude')).toHaveLength(1);
    // The posture is `read-bounded`, so the Claude no-tools triple is absent —
    // this lane does not claim a boundary it cannot enforce.
    for (const absent of ['--tools', '--allowedTools', '--disallowedTools', '--output-schema']) {
      expect(spawned.argv).not.toContain(absent);
    }
    // The bundle travelled on stdin: the finding, the rebuttal, the Issue
    // contract. The agent still is not pointed at the checkout — §17.7's cwd row
    // holds for a dispute turn even though reads are not bounded.
    expect(spawned.stdin).toContain('FINDING-A-PROSE');
    expect(spawned.stdin).toContain(ARGUMENT);
    expect(spawned.stdin).toContain(ISSUE_BODY);
    expect(spawned.cwd.startsWith(realpathSync(worktree))).toBe(false);
    // A throwaway home and no GitHub credential; the CLI's own login is the one
    // thing left reachable, which is why `--ignore-user-config` is pinned.
    expect(spawned.env.HOME).not.toBe(homeDir);
    expect(spawned.env.hasGithubToken).toBe(false);
    expect(spawned.argv).toContain('--ignore-user-config');
    // The checkout is byte-identical: this turn wrote nothing to it.
    expect(checkoutStatus()).toBe('');

    // --- the outcome, without a human --------------------------------------
    expect(reviewed.result).toBe('success');
    expect(blockOf(reviewed.task).lineages[lineageId]).toMatchObject({
      state: 'resolved_withdrawn',
      counters: { rebuttals: 1, reconsiderations: 1 },
    });
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      disposition: 'applied',
    });
    expect(await transitionEvents()).not.toHaveLength(0);

    // --- the posture, carried into the record and the operator surface ------
    const dir = runArtifacts('run-review-3');
    const record = JSON.parse(readFileSync(join(dir, reconsiderationArtifactName(lineageId)), 'utf8'));
    expect(record.profile).toMatchObject({ agentId: 'codex', provider: 'openai', toolPolicy: 'read-bounded' });
    expect(JSON.stringify(record)).toContain('withdraw');
    // The raw transcript is the reviewer's answer, and the progress stream is a
    // separate file that is never mistaken for it.
    expect(readFileSync(join(dir, reconsiderationRawArtifactName(lineageId)), 'utf8')).toContain(RATIONALE);
    expect(readFileSync(join(dir, reconsiderationEventsArtifactName(lineageId)), 'utf8')).toContain('item.completed');
    expect(reviewed.task.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY]).toMatchObject({
      lineageId,
      exitCode: 0,
      timedOut: false,
      failure: null,
      profile: { agentId: 'codex', provider: 'openai', toolPolicy: 'read-bounded' },
    });
    const status = summarizeDisputeStatus(reviewed.task, await store.listEvents(KEY));
    expect(status.lastReconsideration).toMatchObject({
      lineageId,
      agentId: 'codex',
      toolPolicy: 'read-bounded',
    });
    // The posture is a PER-LINEAGE fact, not just the task's most recent one
    // (issue #1085 review, P2). Two places carry the association, and neither is
    // the run directory: the §10.3 sub-turn event names the posture beside the
    // lineage ids it decided, and the per-lineage record the projection reads
    // keeps it after a later reviewer run rewrites the single-valued summary.
    const reconsiderationEvents = (await subTurnEvents()).filter(
      (e) => e.data.turn === 'reviewer_reconsideration',
    );
    expect(reconsiderationEvents).toHaveLength(1);
    expect(reconsiderationEvents[0].data).toMatchObject({
      lineageIds: [lineageId],
      toolPolicy: 'read-bounded',
    });
    expect(status.reconsiderationsByLineage).toEqual([
      { lineageId, version: 1, agentId: 'codex', toolPolicy: 'read-bounded' },
    ]);

    // §11: one bounded comment announcing a resolution, with no prose in it.
    const comments = await disputeComments();
    expect(comments).toHaveLength(1);
    expect(comments[0].payload.body).toContain('resolved_withdrawn');
    expect(comments[0].payload.body).not.toContain(RATIONALE);

    // The permissible continuation: the debate is resolved, so the next review
    // run is an ORDINARY Codex review again rather than a second reviewer turn.
    await resumeReview();
    const spawnedBeforeRereview = agentCalls().length;
    queueAgent('codex', [{ finalMessage: CLEAN_OUTPUT, stdout: '{"type":"item.completed"}\n' }]);
    const rereview = await runPhase('review', { runId: 'run-review-4', session });
    expect(rereview.result).toBe('success');
    // Counted from the recorded PROCESS list rather than the injected runner:
    // the §17.11 review lane spawns through the production both-streams runner
    // (it needs the two streams and the output file), so the injected runner
    // never sees it. One process ran, it was the reviewer's own CLI, and it was
    // an ordinary review rather than a second reconsideration.
    expect(agentCalls().slice(spawnedBeforeRereview)).toHaveLength(1);
    expect(agentCalls().slice(-1)[0].cli).toBe('codex');
    expect(blockOf(rereview.task).lineages[lineageId].state).toBe('resolved_withdrawn');
  });

  dispatchTest('a material revision reopens version 2 and bounds the debate to one further response', async () => {
    const { lineageId, session } = await openCodexReviewedDispute();
    queueAgent('codex', [
      codexReconsideration(lineageId, {
        reconsideration: 'revise',
        revision: {
          predecessorVersion: 1,
          changedFields: ['preconditions'],
          revisionKind: 'corrected_premise',
          materialityClaim: true,
          successor: {
            ...FINDING_A,
            version: 2,
            preconditions: 'Any caller may reach the handler directly, bypassing the middleware.',
          },
        },
      }),
    ]);
    const revised = await runPhase('review', { runId: 'run-review-3', session });

    expect(revised.result).toBe('success');
    expect(blockOf(revised.task).lineages[lineageId]).toMatchObject({ state: 'open', version: 2 });
    expect(revised.task.phase).toBe('implementation');
    expect(revised.task.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY]).toMatchObject({
      revision: { row: 11, implementationResponsesGranted: 1, materiality: { classification: 'material' } },
      profile: { agentId: 'codex', toolPolicy: 'read-bounded' },
    });
    // A reopened version is not a resolution (§11).
    expect(await disputeComments()).toHaveLength(0);

    // The bounded new response closes the lineage, and the counter is spent once.
    const answered = await fixRunAnswers([fixedDisposition(lineageId, 2)], {
      runId: 'run-impl-4',
      session,
      stageable: `${BOUNDARY}\0`,
    });
    expect(blockOf(answered.task).lineages[lineageId]).toMatchObject({
      state: 'resolved_fixed',
      version: 2,
      counters: { reconsiderations: 1 },
    });
  });

  dispatchTest('an upheld dispute with no eligible arbiter reaches exactly one bounded handoff', async () => {
    // §8.3 is untouched by D2: the arbiter candidate resolver still refuses
    // `codex`, so an upheld Codex-raised dispute escalates rather than being
    // adjudicated by a party's own provider.
    const session = optedInSession({ reviewDispute: { arbiter: { providers: [] } } });
    const { lineageId } = await openCodexReviewedDispute(session);

    queueAgent('codex', [codexReconsideration(lineageId, { reconsideration: 'uphold' })]);
    const upheld = await runPhase('review', { runId: 'run-review-3', session });
    expect(blockOf(upheld.task).lineages[lineageId].state).toBe('arbitration_pending');
    const spawnedBeforeArbitration = agentCalls().length;

    const arbitrated = await runPhase('review', { runId: 'run-review-4', session });
    // No arbiter was invoked and no counter was spent buying one.
    expect(agentCalls()).toHaveLength(spawnedBeforeArbitration);
    expect(blockOf(arbitrated.task).lineages[lineageId].state).toBe('escalated_human');
    expect(arbitrated.task.status).toBe('ready_for_human');
    const comments = await disputeComments();
    expect(comments).toHaveLength(1);
    expect(comments[0].payload.body).toContain('escalated_human');
    const status = summarizeDisputeStatus(arbitrated.task, await store.listEvents(KEY));
    expect(status.nextAction.authorized).toBe(false);
    // The one reviewer run that did happen is still attributed honestly.
    expect(status.lastReconsideration).toMatchObject({ agentId: 'codex', toolPolicy: 'read-bounded' });
  });

  dispatchTest('the opt-in is what changed: the same task without it parks and spawns nothing', async () => {
    const { lineageId, task } = await openCodexReviewedDispute();
    const before = JSON.parse(JSON.stringify(blockOf(task)));
    const spawnedBefore = agentCalls().length;
    const transitionsBefore = (await transitionEvents()).length;

    // The identical task, the identical reviewer of record, the identical
    // dispatch — with `reconsideration.readBounded` absent.
    const withoutOptIn = await runPhase('review', { runId: 'run-review-3', session: enabledSession() });
    expect(withoutOptIn.result).toBe('blocked');
    expect(withoutOptIn.task.status).toBe('ready_for_human');
    expect(agentCalls()).toHaveLength(spawnedBefore);
    expect(withoutOptIn.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      disposition: 'parked',
      failure: 'profile_unavailable',
    });
    expect(blockOf(withoutOptIn.task)).toEqual(before);
    expect(blockOf(withoutOptIn.task).lineages[lineageId].counters.reconsiderations).toBe(0);
    expect(await transitionEvents()).toHaveLength(transitionsBefore);

    // And with the opt-in restored, the SAME parked task completes: the park
    // consumed nothing, so the decision is still available to be made.
    await recover('review');
    queueAgent('codex', [codexReconsideration(lineageId, { reconsideration: 'withdraw' })]);
    const resumed = await runPhase('review', { runId: 'run-review-4', session: optedInSession() });
    expect(resumed.result).toBe('success');
    expect(blockOf(resumed.task).lineages[lineageId]).toMatchObject({
      state: 'resolved_withdrawn',
      counters: { rebuttals: 1, reconsiderations: 1 },
    });
  });

  dispatchTest('a redelivered run neither re-invokes the reviewer nor re-spends its slot', async () => {
    const session = optedInSession({ reviewDispute: { arbiter: { providers: [] } } });
    const { lineageId } = await openCodexReviewedDispute(session);

    queueAgent('codex', [codexReconsideration(lineageId, { reconsideration: 'uphold' })]);
    const first = await runPhase('review', { runId: 'run-review-3', session });
    expect(blockOf(first.task).lineages[lineageId].state).toBe('arbitration_pending');
    const counters = JSON.parse(JSON.stringify(blockOf(first.task).lineages[lineageId].counters));
    const spawnedAfterFirst = agentCalls().length;

    // The identical delivery with nothing queued: a re-taken reviewer sub-turn
    // would spawn a process that exits 3 and fail this test.
    await store.recoverHandoff(KEY, { fromStatus: 'queued', phase: 'review', now: nextNow() });
    const second = await runPhase('review', { runId: 'run-review-3', session });

    expect(agentCalls()).toHaveLength(spawnedAfterFirst);
    expect(blockOf(second.task).lineages[lineageId].counters.reconsiderations).toBe(counters.reconsiderations);
    expect(blockOf(second.task).lineages[lineageId].state).not.toBe('disputed');
    expect(await disputeComments()).toHaveLength(1);
  });

  dispatchTest('a malformed Codex answer parks with the transcript on file and the debate untouched', async () => {
    const { lineageId, session, task } = await openCodexReviewedDispute();
    const before = JSON.parse(JSON.stringify(blockOf(task)));
    const transitionsBefore = (await transitionEvents()).length;

    // A reviewer that answered in prose: §12's effect is no protocol state
    // change at all, and the posture does not soften that.
    queueAgent('codex', [
      { finalMessage: 'I considered the rebuttal and I am not persuaded by it.', stdout: '{"type":"item.completed"}\n' },
    ]);
    const reviewed = await runPhase('review', { runId: 'run-review-3', session });

    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.status).toBe('ready_for_human');
    expect(blockOf(reviewed.task)).toEqual(before);
    expect(blockOf(reviewed.task).lineages[lineageId].counters.reconsiderations).toBe(0);
    expect(await transitionEvents()).toHaveLength(transitionsBefore);
    expect(await disputeComments()).toHaveLength(0);
    // The unusable answer is retained locally and is NOT mistaken for a record.
    const dir = runArtifacts('run-review-3');
    expect(readFileSync(join(dir, reconsiderationRawArtifactName(lineageId)), 'utf8')).toContain(
      'I considered the rebuttal',
    );
    expect(existsSync(join(dir, reconsiderationArtifactName(lineageId)))).toBe(false);
    // The park is a §12 outcome, not the D2 refusal: the process really ran.
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].failure).not.toBe('profile_unavailable');
  });

  dispatchTest('a build that refuses a pinned flag is reported as a capability, never as a verdict', async () => {
    const { lineageId, session, task } = await openCodexReviewedDispute();
    const before = JSON.parse(JSON.stringify(blockOf(task)));

    // Argument parsing fails before any turn is billed. That is a fact about the
    // build in front of us (§17.4), not a reviewer that found nothing.
    queueAgent('codex', [
      { exitCode: 2, stderr: "error: unexpected argument '--output-last-message' found\n" },
    ]);
    const reviewed = await runPhase('review', { runId: 'run-review-3', session });

    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      disposition: 'parked',
      failure: 'profile_unavailable',
      failureDetail: '--output-last-message',
    });
    expect(blockOf(reviewed.task)).toEqual(before);
    expect(blockOf(reviewed.task).lineages[lineageId].counters.reconsiderations).toBe(0);
  });
});

// ===========================================================================
// 2. The round trip the reviewer of record can finish
// ===========================================================================

describe('the round trip the reviewer of record can finish', () => {
  dispatchTest('a withdrawal is decided by a real no-tools process and needs no operator step', async () => {
    const { lineageId, session } = await openClaudeReviewedDispute();
    const spawnedBefore = agentCalls().length;

    queueAgent('claude', [saysOnStdout(reconsiderationOutput(lineageId, { reconsideration: 'withdraw' }))]);
    const reviewed = await runPhase('review', { runId: 'run-review-3', session });

    // --- the invocation §8.2 pins, as it was actually spawned ---------------
    const spawned = agentCalls('claude').slice(-1)[0];
    expect(agentCalls()).toHaveLength(spawnedBefore + 1);
    for (const flag of ['--tools', '--allowedTools', '--disallowedTools', '--strict-mcp-config', '--safe-mode', '--no-session-persistence']) {
      expect(spawned.argv).toContain(flag);
    }
    // The bundle IS the input: the prompt carries the finding, the rebuttal and
    // the Issue contract, and the process never sees the checkout — its cwd is a
    // throwaway directory, not the worktree.
    expect(spawned.stdin).toContain('FINDING-A-PROSE');
    expect(spawned.stdin).toContain(ARGUMENT);
    expect(spawned.stdin).toContain(ISSUE_BODY);
    // The reported cwd is already resolved (the child read `process.cwd()`), and
    // the throwaway directory itself is removed on the invocation's way out — so
    // this compares strings and never stats a path that no longer exists.
    expect(spawned.cwd.startsWith(realpathSync(worktree))).toBe(false);
    // An Anthropic no-tools turn inherits the real home (agent-isolation.ts),
    // which here is the test's own, and carries no GitHub credential.
    expect(spawned.env.HOME).toBe(homeDir);
    expect(spawned.env.hasGithubToken).toBe(false);

    // --- the outcome, without a human -------------------------------------
    expect(reviewed.result).toBe('success');
    expect(blockOf(reviewed.task).lineages[lineageId]).toMatchObject({
      state: 'resolved_withdrawn',
      counters: { rebuttals: 1, reconsiderations: 1 },
    });
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      disposition: 'applied',
    });
    expect(await transitionEvents()).not.toHaveLength(0);

    // The §10.2 records this run wrote: the validated record and the raw bytes.
    const dir = runArtifacts('run-review-3');
    const record = JSON.parse(readFileSync(join(dir, reconsiderationArtifactName(lineageId)), 'utf8'));
    expect(JSON.stringify(record)).toContain('withdraw');
    expect(readFileSync(join(dir, reconsiderationRawArtifactName(lineageId)), 'utf8')).toContain(RATIONALE);
    // The bounded summary the operator surfaces read, from a real subprocess.
    expect(reviewed.task.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY]).toMatchObject({
      lineageId,
      version: 1,
      exitCode: 0,
      timedOut: false,
      failure: null,
      profile: { agentId: 'claude', provider: 'anthropic', toolPolicy: 'no-tools' },
    });

    // §11: exactly one bounded comment, and it announces a resolution rather
    // than a handoff. No prose, no run id, no local path.
    const comments = await disputeComments();
    expect(comments).toHaveLength(1);
    expect(comments[0].payload.body).toContain('resolved_withdrawn');
    expect(comments[0].payload.body).not.toContain(ARGUMENT);
    expect(comments[0].payload.body).not.toContain(RATIONALE);
    expect(comments[0].payload.body).not.toContain('run-review-3');

    // The permissible continuation: with the debate resolved and no unreviewed
    // diff, the next review run is an ORDINARY review again — the reviewer's
    // turn is not owed a second time.
    await resumeReview();
    queueAgent('claude', [saysOnStdout(CLEAN_OUTPUT)]);
    const rereview = await runPhase('review', { runId: 'run-review-4', session });
    expect(rereview.result).toBe('success');
    expect(rereview.runner.agentCalls()).toHaveLength(1);
    expect(blockOf(rereview.task).lineages[lineageId].state).toBe('resolved_withdrawn');
  });

  dispatchTest('a material revision opens version 2 and bounds the debate to one further response', async () => {
    const { lineageId, session } = await openClaudeReviewedDispute();
    queueAgent('claude', [
      saysOnStdout(
        reconsiderationOutput(lineageId, {
          reconsideration: 'revise',
          revision: {
            predecessorVersion: 1,
            changedFields: ['preconditions'],
            revisionKind: 'corrected_premise',
            materialityClaim: true,
            successor: {
              ...FINDING_A,
              version: 2,
              preconditions: 'Any caller may reach the handler directly, bypassing the middleware.',
            },
          },
        }),
      ),
    ]);
    const revised = await runPhase('review', { runId: 'run-review-3', session });
    expect(revised.result).toBe('success');
    // Row 11: a material revision with version budget opens version 2 and hands
    // the finding back for ONE further response.
    expect(blockOf(revised.task).lineages[lineageId]).toMatchObject({ state: 'open', version: 2 });
    expect(revised.task.phase).toBe('implementation');
    expect(revised.task.context[REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY]).toMatchObject({
      revision: {
        row: 11,
        implementationResponsesGranted: 1,
        materiality: { classification: 'material' },
      },
    });
    // Nothing public yet: a reopened version is not a resolution (§11).
    expect(await disputeComments()).toHaveLength(0);

    // The bounded new response: the implementer answers version 2, and that
    // closes the lineage.
    const answered = await fixRunAnswers([fixedDisposition(lineageId, 2)], {
      runId: 'run-impl-4',
      session,
      stageable: `${BOUNDARY}\0`,
    });
    expect(blockOf(answered.task).lineages[lineageId]).toMatchObject({
      state: 'resolved_fixed',
      version: 2,
      counters: { reconsiderations: 1 },
    });
  });

  dispatchTest('an upheld dispute with no eligible arbiter reaches exactly one bounded handoff', async () => {
    // §8.3: an empty candidate list is a real setting, and its consequence is
    // that every arbitration escalates (row 19) rather than substituting a party
    // for an arbiter.
    const session = enabledSession({ reviewAgent: 'claude', reviewDispute: { arbiter: { providers: [] } } });
    const raised = await raiseClaudeFindings([FINDING_A], { session });
    const lineageId = onlyLineageId(raised.task);
    await fixRunAnswers([disputeDisposition(lineageId)], { session, diffStat: '', stageable: '' });

    queueAgent('claude', [saysOnStdout(reconsiderationOutput(lineageId, { reconsideration: 'uphold' }))]);
    const upheld = await runPhase('review', { runId: 'run-review-3', session });
    expect(blockOf(upheld.task).lineages[lineageId].state).toBe('arbitration_pending');
    const spawnedBeforeArbitration = agentCalls().length;

    const arbitrated = await runPhase('review', { runId: 'run-review-4', session });
    // No arbiter was invoked and no counter was spent buying one.
    expect(agentCalls()).toHaveLength(spawnedBeforeArbitration);
    expect(blockOf(arbitrated.task).lineages[lineageId].state).toBe('escalated_human');
    expect(arbitrated.task.status).toBe('ready_for_human');
    // One escalation, announced once, and the operator surface authorizes no
    // automated way back (§15 G1).
    const comments = await disputeComments();
    expect(comments).toHaveLength(1);
    expect(comments[0].payload.body).toContain('escalated_human');
    const status = summarizeDisputeStatus(arbitrated.task, await store.listEvents(KEY));
    expect(status.nextAction.authorized).toBe(false);
  });
});

// ===========================================================================
// 3. Negative paths: nothing is decided, nothing is spent
// ===========================================================================

describe('negative paths through the same production dispatch', () => {
  dispatchTest('a malformed reconsideration parks with the transcript on file and the debate untouched', async () => {
    const { lineageId, session, task } = await openClaudeReviewedDispute();
    const before = JSON.parse(JSON.stringify(blockOf(task)));
    const transitionsBefore = (await transitionEvents()).length;

    // A reviewer that answered in prose: §12's malformed output changes no
    // protocol state at all.
    queueAgent('claude', [saysOnStdout('I considered the rebuttal and I am not persuaded by it.')]);
    const reviewed = await runPhase('review', { runId: 'run-review-3', session });

    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.status).toBe('ready_for_human');
    expect(blockOf(reviewed.task)).toEqual(before);
    expect(blockOf(reviewed.task).lineages[lineageId].counters.reconsiderations).toBe(0);
    expect(await transitionEvents()).toHaveLength(transitionsBefore);
    expect(await disputeComments()).toHaveLength(0);
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'reviewer_reconsideration',
      disposition: 'parked',
    });
    // §10.2: the unusable answer is still retained locally, verbatim, so an
    // operator can see what the reviewer actually said.
    const raw = join(runArtifacts('run-review-3'), reconsiderationRawArtifactName(lineageId));
    expect(readFileSync(raw, 'utf8')).toContain('I considered the rebuttal');
    // ...and it is NOT mistaken for a record.
    expect(existsSync(join(runArtifacts('run-review-3'), reconsiderationArtifactName(lineageId)))).toBe(false);
  });

  dispatchTest('a reviewer killed mid-turn is an operational failure, never a decision', async () => {
    const { lineageId, session, task } = await openClaudeReviewedDispute();
    const before = JSON.parse(JSON.stringify(blockOf(task)));
    // The rebuttal wrote a §7 row of its own; this park must add none.
    const transitionsBefore = (await transitionEvents()).length;

    // The process dies on a signal, exactly as a cancelled or OOM-killed agent
    // does: no exit status of its own, and nothing on stdout to admit. §12's
    // effect is the same as any other unusable answer — no protocol state moves.
    queueAgent('claude', [{ signal: 'SIGKILL' }]);
    const reviewed = await runPhase('review', { runId: 'run-review-3', session });

    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.status).toBe('ready_for_human');
    expect(blockOf(reviewed.task)).toEqual(before);
    expect(blockOf(reviewed.task).lineages[lineageId].counters.reconsiderations).toBe(0);
    expect(await transitionEvents()).toHaveLength(transitionsBefore);
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      disposition: 'parked',
    });
    // The turn was reached and the process ran: this is not the D2 refusal.
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].failure).not.toBe('profile_unavailable');
    expect(agentCalls('claude').slice(-1)[0].argv).toContain('--no-session-persistence');
  });

  dispatchTest('a rebuttal whose evidence no longer resolves in this checkout never reaches the reviewer', async () => {
    const { lineageId, session, task } = await openClaudeReviewedDispute();
    const before = JSON.parse(JSON.stringify(blockOf(task)));
    const spawnedBefore = agentCalls().length;
    const transitionsBefore = (await transitionEvents()).length;

    // The head moved under the debate: the file the rebuttal cites at lines
    // 30–36 is now five lines long, so §3.3 cannot verify the reference in THIS
    // checkout. The reference is checked on content, so the turn fails closed
    // before an agent is spawned rather than asking a reviewer to decide on
    // evidence nobody can see.
    writeFileSync(join(worktree, BOUNDARY), '// truncated\n// 2\n// 3\n// 4\n// 5\n', 'utf8');

    const reviewed = await runPhase('review', { runId: 'run-review-3', session });
    expect(reviewed.result).toBe('blocked');
    expect(reviewed.task.status).toBe('ready_for_human');
    expect(agentCalls()).toHaveLength(spawnedBefore);
    expect(blockOf(reviewed.task)).toEqual(before);
    expect(await transitionEvents()).toHaveLength(transitionsBefore);
    expect(reviewed.task.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      disposition: 'parked',
    });
  });

  dispatchTest('a restarted delivery of the same run neither re-invokes the reviewer nor re-spends its slot', async () => {
    // The upheld path, because it is the one that leaves the task queued at
    // `review` with a turn still owed: §7.1 now names the RUNNER's turn, so a
    // redelivered run must not select a second reviewer sub-turn.
    const session = enabledSession({ reviewAgent: 'claude', reviewDispute: { arbiter: { providers: [] } } });
    const raised = await raiseClaudeFindings([FINDING_A], { session });
    const lineageId = onlyLineageId(raised.task);
    await fixRunAnswers([disputeDisposition(lineageId)], { session, diffStat: '', stageable: '' });

    queueAgent('claude', [saysOnStdout(reconsiderationOutput(lineageId, { reconsideration: 'uphold' }))]);
    const first = await runPhase('review', { runId: 'run-review-3', session });
    expect(blockOf(first.task).lineages[lineageId].state).toBe('arbitration_pending');
    expect(first.task).toMatchObject({ status: 'queued', phase: 'review' });
    const counters = JSON.parse(JSON.stringify(blockOf(first.task).lineages[lineageId].counters));
    const spawnedAfterFirst = agentCalls().length;

    // The identical delivery: same phase, same run id, and no queued response
    // for anything — a reviewer sub-turn re-taken here would spawn a process
    // that exits 3, and an arbiter would need one too.
    await store.recoverHandoff(KEY, { fromStatus: 'queued', phase: 'review', now: nextNow() });
    const second = await runPhase('review', { runId: 'run-review-3', session });

    // Nothing was re-bought and nothing was re-decided: the reviewer's answer
    // stands, its slot is still spent exactly once, and the lineage never
    // returns to `disputed` to be argued again.
    expect(agentCalls()).toHaveLength(spawnedAfterFirst);
    expect(blockOf(second.task).lineages[lineageId].counters.reconsiderations).toBe(
      counters.reconsiderations,
    );
    expect(blockOf(second.task).lineages[lineageId].state).not.toBe('disputed');
    // The debate is over on this configuration (§8.3 has no candidate), and it
    // ended in exactly one announced outcome — not two.
    expect(await disputeComments()).toHaveLength(1);
  });
});

// ===========================================================================
// 4. Bounded dispatch: a non-completing fake process (issue #1089)
// ===========================================================================

/** `process.kill(pid, 0)` as a liveness probe, same as `command-runner-process-tree.test.js`. */
function stillAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, but not ours to signal
  }
}

async function waitUntilNoLongerAlive(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !stillAlive(pid);
}

// Windows' `kill()` is `TerminateProcess`, which a child cannot trap — the
// `hang` fixture's `SIGTERM` handler would never get the chance to matter, and
// this suite's other 18 cases already cover that platform's ordinary path.
const posixTest = process.platform === 'win32' ? test.skip : test;

describe('a fake agent that never answers is bounded by the harness, not by Jest alone', () => {
  posixTest(
    'a hung invocation fails within a finite deadline, leaves diagnostics, and no leftover process',
    async () => {
      // Narrower than FAKE_AGENT_DEADLINE_MS: `hybridRunner` honors the
      // tighter of the two, so this stays fast without weakening the ceiling
      // real dispatch gets. Wider than the shell-fixture equivalent in
      // `command-runner-process-tree.test.js` because this fixture has to
      // fork, exec and finish a full Node/ESM startup before it can even
      // install the `SIGTERM` listener that makes it ignorable — a bigger
      // window for a loaded host to spend the deadline inside than a `/bin/sh`
      // fixture ever has.
      const deadlineMs = 2_000;
      const armedMarker = join(cliDir, 'claude.sigterm-armed');

      // A deadline that expires before the fixture reaches its
      // `process.on('SIGTERM', ...)` line kills it with the DEFAULT
      // disposition — the ordinary deadline signal, not the watchdog's
      // escalation — which is a statement about a thrashing host, not about
      // the runner under test (see `fake-agent-cli.mjs`'s `sigterm-armed`
      // marker and the same convention in
      // `codex-structured-review.test.js`). Retried, with loud diagnostics,
      // rather than asserted against blindly.
      let result;
      let loggedLines;
      let started;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        rmSync(armedMarker, { force: true });
        queueAgent('claude', [{ hang: true }]);
        const runner = hybridRunner({}, { stage: 'test:hang-coverage' });
        const diagnostics = jest.spyOn(console, 'error').mockImplementation(() => {});
        started = Date.now();

        result = runner.run('claude', ['--print'], {
          cwd: worktree,
          stdin: 'PROMPT-MARKER: never meant to be answered',
          timeout: deadlineMs,
        });
        loggedLines = diagnostics.mock.calls.map((call) => call.join(' ')).join('\n');
        diagnostics.mockRestore();

        if (existsSync(armedMarker)) break;
        console.warn(
          `fake-agent-cli #1089 hang coverage starved on attempt ${attempt}/2 — the host did not reach the ` +
            `SIGTERM-ignoring disposition inside ${deadlineMs}ms (returned in ${Date.now() - started}ms)`,
        );
        result = undefined;
      }
      // Every attempt was starved: report the host as a host, not as a
      // watchdog that failed to escalate.
      if (result === undefined) return;

      // --- the call returned, bounded, rather than hanging Jest itself -----
      // Before issue #1060's escalation watchdog (armed here via
      // `isolateProcessGroup`) this call would still be blocked inside
      // `spawnSync`, deadline or no deadline: the fixture ignores the
      // deadline's own SIGTERM, so only the watchdog's SIGKILL can end it.
      expect(result.timedOut).toBe(true);
      expect(result.deadlineEscalated).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);

      // --- actionable, and free of prompt text or local paths --------------
      expect(loggedLines).toContain('stage=test:hang-coverage');
      expect(loggedLines).toContain('cli=claude');
      expect(loggedLines).toContain(`pid=${result.pid}`);
      expect(loggedLines).toContain('timedOut=true');
      expect(loggedLines).not.toContain('PROMPT-MARKER');
      expect(loggedLines).not.toContain(tmpDir);

      // --- no leftover child process -----------------------------------------
      expect(typeof result.pid).toBe('number');
      expect(await waitUntilNoLongerAlive(result.pid)).toBe(true);

      // The invocation is still on the same protocol record every other one
      // is, even though it never answered.
      expect(agentCalls('claude')).toHaveLength(1);
    },
    40_000,
  );
});

// ===========================================================================
// 5. What the starvation classification may and may not swallow
//
// `dispatchTest` turns a starved dispatch into a decline: warn, stop, assert
// nothing. That is the right disposition for a host that never ran the fork and
// the wrong one for everything else — a case that declines runs none of its
// remaining assertions, so anything misread as starvation is coverage that
// silently went away. These cases pin the boundary from BOTH sides, against
// real subprocesses rather than synthetic result objects, because the facts
// being classified (`signal`, the fixture's call record, the child's own
// stderr) are produced by the runner and the fixture, not by this file.
// ===========================================================================

/**
 * Replace one fake CLI's wrapper with a `#!/bin/sh` body of our own, keeping the
 * name it is reached under on `PATH`.
 *
 * Every wrapper installed here records its own invocation in
 * `<cliDir>/wrapper-attempts` FIRST, so a case can count what the harness
 * actually did with it: `fake-agent-cli.mjs`'s `calls.jsonl` record is exactly
 * what these fixtures never get far enough to write.
 */
function installBrokenCli(name, body) {
  const path = join(binDir, name);
  writeFileSync(
    path,
    `#!/bin/sh\n` + `printf '%s\\n' '${name}' >> '${join(cliDir, 'wrapper-attempts')}'\n` + `${body}\n`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

/** How many times a wrapper installed by {@link installBrokenCli} was reached. */
function wrapperAttempts() {
  const path = join(cliDir, 'wrapper-attempts');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;
}

/**
 * Run one production-shaped agent dispatch (no caller `timeout`, so the retry
 * and classification path above is the one under test) and collect what it
 * warned.
 *
 * No `stdin`, deliberately, though every real dispatch here carries one: these
 * fixtures die before reading it, and a prompt written into a pipe whose reader
 * is already gone can surface as an `EPIPE` spawn error — a fourth outcome that
 * would classify these cases by luck rather than by the fact each one is about.
 */
function dispatchOnce(runner) {
  const warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = runner.run('claude', ['--print'], { cwd: worktree });
    return { result, warned: warnings.mock.calls.map((call) => call.join(' ')).join('\n') };
  } finally {
    warnings.mockRestore();
  }
}

/**
 * The one terminal result these broken-fixture cases cannot read: the
 * deadline's own artifact, produced because the host starved the dispatch of
 * the BROKEN FIXTURE itself. Each case below installs a wrapper whose point is
 * to fail fast with evidence of its own — a `SIGKILL`, an exit 1 with an errno
 * on stderr — and every assertion reads that evidence. But a host loaded
 * enough can spend the whole {@link FAKE_AGENT_DEADLINE_MS} inside the fork of
 * a two-line `#!/bin/sh` (observed under a full parallel run: 30s each, four
 * times), and when the retry loop exhausts on such an attempt it hands back
 * `timedOut` and the deadline's `SIGTERM` — a result its own contract says "is
 * not an answer and must not be read as one" — rather than anything the
 * wrapper produced. The same goes for a fork the host refused outright, whose
 * `spawnError` names a #897 errno and whose result carries no fixture evidence
 * either. Both are statements about the host, so a case that meets one
 * declines — warn and stop, the disposition everything else in this suite
 * gives a starved dispatch — instead of asserting the fixture's shape against
 * a run the host never fed. A determinate terminal result still reaches every
 * assertion, including after starved MIDDLE attempts the retry absorbed.
 */
function hostStarvedBrokenFixtureDispatch(result) {
  if (result.timedOut === true) return true;
  if (result.spawnError !== undefined) {
    return isIndeterminateProbeError(result.spawnErrorCode ?? result.spawnError);
  }
  return false;
}

/** Warn-and-decline read side of {@link hostStarvedBrokenFixtureDispatch}: true when the case must stop. */
function declinedStarvedBrokenFixtureCase(name, result) {
  if (!hostStarvedBrokenFixtureDispatch(result)) return false;
  console.warn(
    `[fake-agent-cli #1089] declining "${name}": the host starved the broken-fixture dispatch itself ` +
      `(timedOut=${result.timedOut === true}, exitCode=${result.exitCode ?? 'unknown'}, ` +
      `signal=${result.signal ?? 'none'}, spawnErrorCode=${result.spawnErrorCode ?? 'unknown'})`,
  );
  return true;
}

describe('a starved dispatch is declined; a broken fixture still fails the case', () => {
  posixTest('a fixture that cannot start is a test failure, not a host to retry', () => {
    // The review's own example: `fake-agent-cli.mjs` exits 3 the moment
    // `AI_FAKE_CLI_DIR` is unset, which is what this wrapper does by dropping
    // the `export` the real one pins. Deterministic, reproducible, and about
    // the fixture — nothing about this host would change on a second attempt.
    installBrokenCli('claude', `exec '${process.execPath}' '${FAKE_CLI}' 'claude' "$@"`);
    const runner = hybridRunner({}, { stage: 'test:broken-fixture' });

    const { result, warned } = dispatchOnce(runner);

    const name = 'a fixture that cannot start is a test failure, not a host to retry';
    if (declinedStarvedBrokenFixtureCase(name, result)) return;
    // A starved attempt is disqualifying here even when a LATER one produced
    // the deterministic exit 3: this case pins the single-attempt, no-warning
    // shape, and a retry the host forced has already moved both of those.
    if (warned.includes('starved on attempt')) {
      console.warn(
        `[fake-agent-cli #1089] declining "${name}": the host starved an attempt, so the ` +
          `single-attempt shape this case pins is not this run's fact`,
      );
      return;
    }

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('AI_FAKE_CLI_DIR is unset');
    // Attempted exactly once and handed back as the failure it is: not retried,
    // not recorded as starved, so the case that asked for it sees the exit 3
    // and fails instead of declining with its assertions unrun.
    expect(wrapperAttempts()).toBe(1);
    expect(runner.starvedDispatches).toHaveLength(0);
    expect(warned).toBe('');
    // And it never reached the protocol under test, which is precisely why the
    // absent call record cannot be read as evidence about the host.
    expect(agentCalls()).toHaveLength(0);
  });

  posixTest('a child killed from outside before it recorded anything is still declined', () => {
    // What an OOM reaper or a supervisor sweeping a thrashing host leaves
    // behind: no `spawnError`, no `timedOut`, no call record — and a signal,
    // which is the positive evidence the classification now requires.
    installBrokenCli('claude', 'kill -KILL $$');
    const runner = hybridRunner({}, { stage: 'test:external-kill' });

    const { result, warned } = dispatchOnce(runner);

    if (declinedStarvedBrokenFixtureCase('a child killed from outside before it recorded anything is still declined', result)) {
      return;
    }

    expect(result.signal).toBe('SIGKILL');
    expect(result.timedOut).toBeUndefined();
    // Attempted until the cap and never past it. A bound rather than an
    // equality on the wrapper's own count: the retries are the parent's fact
    // (`attempts` below, one `run` call each), while a host that refused one of
    // those forks outright never reached the wrapper to record it — the same
    // starvation under a different errno, not a retry that failed to happen.
    expect(wrapperAttempts()).toBeGreaterThanOrEqual(1);
    expect(wrapperAttempts()).toBeLessThanOrEqual(AGENT_DISPATCH_STARVATION_ATTEMPTS);
    expect(warned).toContain('stage=test:external-kill');
    expect(runner.starvedDispatches).toEqual([
      expect.objectContaining({
        stage: 'test:external-kill',
        cli: 'claude',
        attempts: AGENT_DISPATCH_STARVATION_ATTEMPTS,
        timedOut: false,
      }),
    ]);
  });

  posixTest('a non-zero exit that names a starvation errno is declined on that evidence', () => {
    // The one startup failure that IS about the host: node's own `EMFILE`/
    // `ENOMEM` failures say so on stderr, and #897's errno line reads it there
    // the same way it reads a `spawnError` code.
    installBrokenCli('claude', 'printf "%s\\n" "Error: spawn EMFILE" >&2\nexit 1');
    const runner = hybridRunner({}, { stage: 'test:errno-on-stderr' });

    const { result } = dispatchOnce(runner);

    if (declinedStarvedBrokenFixtureCase('a non-zero exit that names a starvation errno is declined on that evidence', result)) {
      return;
    }

    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeUndefined();
    expect(wrapperAttempts()).toBeGreaterThanOrEqual(1);
    expect(wrapperAttempts()).toBeLessThanOrEqual(AGENT_DISPATCH_STARVATION_ATTEMPTS);
    expect(runner.starvedDispatches).toEqual([
      expect.objectContaining({ cli: 'claude', attempts: AGENT_DISPATCH_STARVATION_ATTEMPTS }),
    ]);
  });

  posixTest('the retry budget is spent once per run, not once per dispatch', () => {
    // The failure mode this bounds: a handler does not stop when a dispatch is
    // starved, so the run reaches its NEXT agent call — and a per-dispatch cap
    // lets each of those spend the full attempts × deadline again. Two are
    // already this suite's whole per-case budget, which would report a case that
    // means to DECLINE as a Jest timeout instead.
    installBrokenCli('claude', 'kill -KILL $$');
    const runner = hybridRunner({}, { stage: 'test:budget-per-run' });

    const first = dispatchOnce(runner);
    if (declinedStarvedBrokenFixtureCase('the retry budget is spent once per run, not once per dispatch', first.result)) {
      return;
    }
    const spentByFirst = wrapperAttempts();
    const second = dispatchOnce(runner);

    expect(first.result.signal).toBe('SIGKILL');
    // The second call was never handed to the host at all: the wrapper count is
    // unchanged, so this dispatch cost no deadline. Read as a delta rather than
    // against the cap — what this case is about is the SECOND dispatch, and a
    // host that refused one of the first dispatch's forks outright (`EAGAIN`,
    // never reaching the wrapper) is still a first dispatch that was starved.
    expect(wrapperAttempts()).toBe(spentByFirst);
    expect(second.result.exitCode).toBe(1);
    expect(second.result.stderr).toContain('not dispatched');
    // And it is still counted and named, so the decline reports what the run
    // never got an answer for rather than quietly dropping it.
    expect(runner.starvedDispatches).toEqual([
      expect.objectContaining({ cli: 'claude', attempts: AGENT_DISPATCH_STARVATION_ATTEMPTS }),
      expect.objectContaining({ cli: 'claude', attempts: 0 }),
    ]);
    expect(new HostStarvedDispatch(runner.starvedDispatches).message).toContain(
      'not attempted (an earlier dispatch in this run was starved)',
    );
  });
});
