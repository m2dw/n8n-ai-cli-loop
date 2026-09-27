/**
 * A fake agent CLI, spawned as a REAL subprocess (issue #1072).
 *
 * The dispute suites that came before this one replaced the agent invocation
 * with an in-process seam: a function that returns what the CLI would have
 * said. That proves the protocol layers compose, and it cannot prove that the
 * argv, the stdin prompt, the isolated environment, the temp-file handshake and
 * the output capture the shipping invocation actually performs reach a process
 * at all. This module is the other half — an executable that is put on `PATH`
 * under the real command name (`claude`, `codex`), so the production dispatch
 * path runs end to end and only the model behind it is fake.
 *
 * Two files per CLI: a `#!/bin/sh` wrapper that pins `AI_FAKE_CLI_DIR` and
 * `exec`s this script under the node binary running the test. The wrapper is
 * what makes the fake independent of whatever environment the invocation is
 * spawned with — the reconsideration turn deliberately strips and rewrites most
 * of it — and the pinned directory is where the fake reads its script and
 * records what it was asked to do.
 *
 * ## Protocol
 *
 * `<dir>/<cli>.queue.json` holds an ARRAY of responses. Each invocation shifts
 * the first entry and rewrites the remainder, so a scenario queues one entry per
 * expected call, in order. An invocation with an empty queue exits 3 with a
 * diagnostic rather than answering: an unexpected agent run must fail the test
 * that did not expect it, never pass silently.
 *
 * A response may carry:
 *
 * | Field | Effect |
 * | --- | --- |
 * | `stdout` / `stderr` | written to the stream, synchronously (see below) |
 * | `exitCode` | the exit status (default 0) |
 * | `finalMessage` | written to the `--output-last-message` path from argv; the run fails if argv names none |
 * | `writeFiles` | `[{path, content}]` written relative to the process cwd, for a fix run that must edit the checkout |
 * | `signal` | the process kills ITSELF with this signal after writing — a reviewer that died mid-turn |
 * | `hang` | the process never answers at all — it blocks forever and ignores `SIGTERM`, so only a `SIGKILL` (issue #1060's escalation watchdog) ends it (issue #1089) |
 *
 * `hang` exists to give the bounded-deadline harness (issue #1089) something
 * deterministic to fail against: a scenario that queues it is asserting "the
 * harness recovers from a fake CLI that never returns", not reproducing the
 * original intermittent stdin stall, which this file does not attempt to
 * simulate — see that issue for why.
 *
 * Every invocation, `hang` or not, drops `<dir>/<cli>.sigterm-armed` the
 * instant its `SIGTERM` listener is installed — proof that a deadline
 * expiring afterwards was truly ignored rather than having simply arrived
 * before this process finished starting up.
 *
 * Every invocation is appended to `<dir>/calls.jsonl` first, whatever it then
 * does, so a call that exits 3 or dies by signal is still on record.
 *
 * Both streams are written with `writeFileSync` on the raw descriptors rather
 * than `process.stdout.write`: on macOS a pipe is asynchronous, and a
 * `process.exit()` immediately after a `write()` truncates it. A fake CLI that
 * loses the tail of its own answer would surface as a malformed-response test
 * failure with no cause visible anywhere.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';

// Registered before any of the stdin/fs work below, rather than only once a
// queued `hang: true` response is known: on a loaded host that setup work —
// reading stdin, parsing the queue file — can itself eat into the deadline's
// own budget, and a `SIGTERM` that arrives before this listener is attached
// falls back to the default (terminate) action, killing the process before
// the escalation watchdog ever gets to run. Removed again as soon as the
// response turns out NOT to be a hang (below): every other response has no
// escalation watchdog armed for it, so it must stay killable by an ordinary
// `SIGTERM` for the rest of its (brief) run.
function ignoreTerm() {}
process.on('SIGTERM', ignoreTerm);

// Proof that the line above ran: everything before it — fork, exec, the
// engine's own startup and module resolution — is outside this process's
// control and runs with the DEFAULT disposition, so a deadline that expires
// inside that window kills it with the very signal this file exists to
// ignore. A harness racing that window against a real escalation needs a way
// to tell the two apart (issue #1089); see `sigterm-armed` in
// `review-dispute-default-path-e2e.test.js`'s hang coverage for the read side.
try {
  const armedDir = process.env.AI_FAKE_CLI_DIR;
  if (armedDir) writeFileSync(join(armedDir, `${process.argv[2] ?? 'unknown'}.sigterm-armed`), '', 'utf8');
} catch {
  // Best-effort: nothing useful to do if even this write fails.
}

const cli = process.argv[2] ?? 'unknown';
const argv = process.argv.slice(3);
const dir = process.env.AI_FAKE_CLI_DIR;

/** Refuse loudly: exit 3 is not a status any fixture response may ask for. */
function refuse(message) {
  try {
    writeFileSync(2, `fake-agent-cli(${cli}): ${message}\n`);
  } catch {
    // Nothing better to do than the exit status if even stderr is gone.
  }
  process.exit(3);
}

if (dir === undefined || dir === '') refuse('AI_FAKE_CLI_DIR is unset');

// The prompt. `stdio[0]` is `ignore` for the invocations that pass no stdin, in
// which case descriptor 0 is /dev/null and this reads empty.
let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {
  stdin = '';
}

// Recorded BEFORE the response is applied: a refusal below is exactly the case a
// scenario needs the record for.
appendFileSync(
  join(dir, 'calls.jsonl'),
  `${JSON.stringify({
    cli,
    argv,
    stdin,
    cwd: process.cwd(),
    env: {
      HOME: process.env.HOME ?? null,
      PWD: process.env.PWD ?? null,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? null,
      // Presence only, never the value: the point of the assertion is that no
      // repository-mutating credential survived the isolation.
      hasGithubToken: process.env.GH_TOKEN !== undefined || process.env.GITHUB_TOKEN !== undefined,
    },
  })}\n`,
  'utf8',
);

const queuePath = join(dir, `${cli}.queue.json`);
let queue = [];
if (existsSync(queuePath)) {
  try {
    queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  } catch {
    refuse(`unreadable response queue at ${queuePath}`);
  }
}
if (!Array.isArray(queue) || queue.length === 0) {
  refuse('no queued response for this invocation (an agent ran that the scenario did not expect)');
}
const response = queue[0];
writeFileSync(queuePath, JSON.stringify(queue.slice(1)), 'utf8');

if (response.hang !== true) process.removeListener('SIGTERM', ignoreTerm);

if (response.hang === true) {
  // The `SIGTERM` listener registered at the top of the file covers the brief
  // window before this line, but a JS listener only runs once the event loop
  // gets to service it — not a guarantee while the only thing left to do is
  // wait. `SIGSTOP` sidesteps that entirely: it suspends the process at the
  // kernel level, where `SIGTERM` (unlike `SIGKILL`) cannot even be delivered
  // until something resumes it, and nothing here ever sends `SIGCONT`. Only
  // the escalation `SIGKILL` (issue #1060's watchdog) can end this process —
  // `SIGKILL` terminates a stopped process same as a running one.
  process.kill(process.pid, 'SIGSTOP');
}

for (const file of response.writeFiles ?? []) {
  const target = isAbsolute(file.path) ? file.path : resolve(process.cwd(), file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.content, 'utf8');
}

if (response.finalMessage !== undefined) {
  const at = argv.indexOf('--output-last-message');
  const path = at === -1 ? undefined : argv[at + 1];
  if (path === undefined) {
    refuse('the queued response carries a final message but the argv names no --output-last-message path');
  }
  writeFileSync(path, response.finalMessage, 'utf8');
}

if (typeof response.stdout === 'string' && response.stdout !== '') writeFileSync(1, response.stdout);
if (typeof response.stderr === 'string' && response.stderr !== '') writeFileSync(2, response.stderr);

if (typeof response.signal === 'string' && response.signal !== '') {
  process.kill(process.pid, response.signal);
}

process.exit(typeof response.exitCode === 'number' ? response.exitCode : 0);
