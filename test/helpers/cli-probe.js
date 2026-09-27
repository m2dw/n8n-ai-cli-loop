/**
 * Test-side handling of an indeterminate CLI probe (issue #897).
 *
 * `session-doctor` answers its `git`/`gh` checks by forking a real child with a
 * time budget. That budget is generous, but it is still a budget: on a host that
 * is thrashing — several full Jest runs at once, each forking worktrees — even a
 * two-line `#!/bin/sh` stub can miss it, and the check then reports the errno
 * (`ETIMEDOUT`) instead of the stub's own output.
 *
 * #897's whole point is that such an outcome is a statement about the HOST, not
 * about the command: it must not be read as a fact either way. A case whose
 * subject is what a probe *found* (which executable PATH resolved, which labels
 * the repo has) therefore cannot conclude anything from it — the honest move is
 * to ask again, and to say out loud when the host never answered rather than
 * failing as if the CLI had misbehaved.
 *
 * These helpers exist so the handful of cases that read probe CONTENT do that
 * the same way instead of each inventing a tolerance. They are NOT for cases
 * whose subject is the probe classification itself (`cli-probe.test.js`, the
 * `AI_LOOP_CLI_PROBE_STUB` cases): those are deterministic by construction and
 * must keep failing when they break.
 */
import { CLI_PROBE_INDETERMINATE_MARKER } from '../../dist/core/cli-probe.js';

/**
 * Errnos that mean the host refused or starved the fork. Matched as whole words
 * so an unrelated message that merely quotes one cannot trip the check.
 *
 * `EACCES` is deliberately absent for the same reason it is absent from the
 * runtime's transient set: a file that exists and is not executable is a real,
 * persistent fault, and re-running it forever would hide it.
 */
const INDETERMINATE_ERRNO = /\b(ETIMEDOUT|EAGAIN|ENOMEM|EMFILE|ENFILE|ETXTBSY)\b/;

/**
 * Does this check error describe the host rather than the command?
 *
 * Accepts both renderings a caller can see: the operator sentence (which leads
 * with {@link CLI_PROBE_INDETERMINATE_MARKER}) and the bare errno text that
 * `session-doctor` carries through from the failed spawn.
 */
export function isIndeterminateProbeError(error) {
  if (typeof error !== 'string' || error.trim() === '') return false;
  return error.includes(CLI_PROBE_INDETERMINATE_MARKER) || INDETERMINATE_ERRNO.test(error);
}

/**
 * Run `runOnce` until the probe error it exposes is a real answer.
 *
 * @param {() => Promise<any>} runOnce performs one full run.
 * @param {(result: any) => string|undefined} readProbeError pulls the probe-derived
 *   error text out of that run — concatenate every check that could have been
 *   starved, so a cascade ("skipped: see <earlier check>") is not mistaken for a
 *   determinate answer.
 * @param {{attempts?: number}} [options]
 * @returns {Promise<{result: any, answered: boolean}>} `answered` is false only
 *   when every attempt was indeterminate; the caller must then decline to assert
 *   on the content rather than treat the starved run as evidence.
 */
export async function runUntilProbeAnswers(runOnce, readProbeError, options = {}) {
  const attempts = options.attempts ?? 3;
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await runOnce();
    const error = readProbeError(result);
    if (!isIndeterminateProbeError(error)) return { result, answered: true };
    // Loud on purpose: a case that stops asserting has to be visible in the run
    // it happened in, not discovered later as coverage that quietly went away.
    console.warn(
      `indeterminate CLI probe on attempt ${attempt}/${attempts} — the host did not run the child in time: ${error}`,
    );
  }
  return { result, answered: false };
}
