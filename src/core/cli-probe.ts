/**
 * Typed outcomes for "is this CLI usable on this host?" probes (issue #897).
 *
 * The pre-#897 probe reduced every failure to `{ ok: false }`, so a genuinely
 * missing executable and a host that momentarily could not fork were reported
 * identically — as a missing CLI. That misdiagnosis is not cosmetic: it flows
 * into `admin session-doctor`'s findings and into the review-dispute arbiter
 * candidate resolver, where it turns machine load into a permanent-looking
 * configuration error and, through review verification, into a spurious
 * "the implementation is wrong" verdict.
 *
 * Everything here is pure: no process is ever spawned from this module. The
 * caller does the spawning and hands the thrown error to
 * {@link classifyProbeFailure}, which is why every classification branch is
 * testable from a synthetic error object rather than from real host contention.
 */

import type { AgentId } from "./task.js";

/**
 * What a probe actually established.
 *
 * `not-found` and `non-zero-exit` are DETERMINATE — the OS resolved the command
 * name (or failed to) and answered. `timeout` and `spawn-error` say nothing
 * about the command at all; they describe this host, at this moment.
 */
export const CLI_PROBE_STATUSES = [
  /** The command ran and exited 0. */
  "available",
  /** The OS could not resolve the executable (ENOENT). */
  "not-found",
  /** The command ran and exited non-zero. */
  "non-zero-exit",
  /** The child was killed for exceeding the probe's time budget. */
  "timeout",
  /** The child never started: the OS refused to create the process. */
  "spawn-error",
] as const;
export type CliProbeStatus = (typeof CLI_PROBE_STATUSES)[number];

/**
 * Errno codes for "the OS refused to create the process", as opposed to "the
 * process ran and said no". They say nothing about the command being probed —
 * a loaded host that is out of process slots or file descriptors fails these
 * the same way whether the binary is healthy or missing.
 *
 * `EACCES` is deliberately NOT here: a file that exists but is not executable
 * is a real, persistent misconfiguration, and retrying it forever would hide
 * the one thing the operator has to fix. It still classifies as `spawn-error`
 * (the child never started), just not as a transient one.
 */
export const TRANSIENT_SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAGAIN",
  "ENOMEM",
  "EMFILE",
  "ENFILE",
]);

/** Bound on the diagnostic text carried out of a probe. */
export const MAX_PROBE_DETAIL_CHARS = 300;

/**
 * The token every indeterminate probe diagnostic carries.
 *
 * Bracketed so it is a structural marker rather than a phrase: downstream
 * consumers (review verification, issue #897) match on it exactly, and prose
 * that merely discusses probe transience does not trip them.
 */
export const CLI_PROBE_INDETERMINATE_MARKER = "[cli-probe-indeterminate]";

export interface CliProbeOutcome {
  /** True only for {@link CliProbeStatus} `"available"`. */
  ok: boolean;
  status: CliProbeStatus;
  /**
   * Whether the outcome is about the HOST rather than the command — a later
   * probe on a quieter machine could answer differently. Callers must not
   * report a transient outcome as a property of the CLI.
   */
  transient: boolean;
  /** Bounded operator-facing detail: the command's own stderr, or the errno. */
  output: string;
  /** The preserved OS error code (`ENOENT`, `EAGAIN`, `ETIMEDOUT`, …). */
  code?: string;
  /** The child's exit status, when it ran and exited non-zero. */
  exitCode?: number;
  /** The signal that killed the child, when one did. */
  signal?: string;
  /** Set when the outcome came from a test seam rather than a real spawn. */
  stubbed?: boolean;
}

/** The signal `child_process` uses to kill a child that outran its timeout. */
const TIMEOUT_KILL_SIGNAL = "SIGTERM";

function boundedDetail(value: string): string {
  return value.trim().slice(0, MAX_PROBE_DETAIL_CHARS);
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

/** A successful probe, carrying the command's own (bounded) stdout. */
export function probeSucceeded(stdout: string): CliProbeOutcome {
  return { ok: true, status: "available", transient: false, output: stdout.trim() };
}

/**
 * Classify a thrown `execFileSync`/`spawnSync` error into a typed outcome.
 *
 * Order matters and is the diagnostic order, most-determinate first:
 *
 *  1. A numeric exit status means the child RAN. Whatever errno rides along
 *     (Node attaches `ENOENT` to the error object in some shapes even when the
 *     command itself exited), a command that ran and said no is reported as the
 *     failure it is — never as a missing binary and never as transient.
 *  2. `ENOENT` with no exit status is the one determinate absence signal.
 *  3. A timeout kill is indeterminate: the command may be perfectly healthy and
 *     merely starved of CPU.
 *  4. Any remaining errno means the process never started.
 */
export function classifyProbeFailure(err: unknown): CliProbeOutcome {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown;
    status?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const code = typeof e.code === "string" ? e.code : undefined;
  const signal = typeof e.signal === "string" && e.signal !== "" ? e.signal : undefined;
  const exitCode = typeof e.status === "number" ? e.status : undefined;
  const detail = boundedDetail(firstNonEmpty(e.stderr, e.stdout) || String(err));

  if (exitCode !== undefined && exitCode !== 0) {
    return {
      ok: false,
      status: "non-zero-exit",
      transient: false,
      output: detail,
      exitCode,
      ...(code === undefined ? {} : { code }),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  if (code === "ENOENT") {
    return { ok: false, status: "not-found", transient: false, output: detail, code: "ENOENT" };
  }

  // Node reports the timeout kill as ETIMEDOUT on current releases; older
  // shapes surface only the SIGTERM that `child_process` sent. Accept either,
  // but only when no exit status was recorded — a child that exited on its own
  // was already classified above.
  if (code === "ETIMEDOUT" || (exitCode === undefined && signal === TIMEOUT_KILL_SIGNAL)) {
    return {
      ok: false,
      status: "timeout",
      transient: true,
      output: detail,
      code: code ?? "ETIMEDOUT",
      ...(signal === undefined ? {} : { signal }),
    };
  }

  return {
    ok: false,
    status: "spawn-error",
    transient: code !== undefined && TRANSIENT_SPAWN_ERROR_CODES.has(code),
    output: detail,
    ...(code === undefined ? {} : { code }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Whether a probe failure is worth retrying in-process before reporting it.
 *
 * Narrower than {@link CliProbeOutcome.transient}: a timeout already consumed
 * the full time budget, so retrying it immediately would only spend the budget
 * again. Only a refused fork is retried, and only after a backoff.
 */
export function isRetryableProbeFailure(outcome: CliProbeOutcome): boolean {
  return outcome.status === "spawn-error" && outcome.transient;
}

/**
 * The operator-facing sentence for a failed probe.
 *
 * A transient outcome always leads with {@link CLI_PROBE_INDETERMINATE_MARKER}
 * and says, in words, that it is not a statement about the CLI — the whole
 * point of #897 is that this text is what an operator (and the review loop)
 * reads instead of "cli unavailable".
 */
export function describeProbeOutcome(command: string, outcome: CliProbeOutcome): string {
  const suffix = outcome.stubbed ? " [stubbed probe]" : "";
  const detail = outcome.output === "" ? "" : `: ${outcome.output}`;
  switch (outcome.status) {
    case "available":
      return `${command} responded${detail}${suffix}`;
    case "not-found":
      return `${command} was not found on PATH (ENOENT)${detail}${suffix}`;
    case "non-zero-exit":
      return `${command} exited ${outcome.exitCode ?? "non-zero"}${detail}${suffix}`;
    case "timeout":
      return (
        `${CLI_PROBE_INDETERMINATE_MARKER} ${command} did not finish before the probe timeout `
        + `(${outcome.code ?? "ETIMEDOUT"}). This says nothing about whether ${command} is installed — `
        + `the host was too loaded to answer. Re-run when the machine is quieter${detail}${suffix}`
      );
    case "spawn-error":
      return outcome.transient
        ? `${CLI_PROBE_INDETERMINATE_MARKER} the host refused to start ${command} `
          + `(${outcome.code ?? "spawn error"}). This says nothing about whether ${command} is installed — `
          + `the machine was out of process resources. Re-run when it is quieter${detail}${suffix}`
        : `${command} could not be started (${outcome.code ?? "spawn error"})${detail}${suffix}`;
  }
}

/**
 * Whether some captured output carries an indeterminate-probe diagnostic.
 *
 * Matches the bracketed marker verbatim and nothing else. Verification output
 * routinely quotes the words "timeout" and "EAGAIN" for entirely unrelated
 * reasons, so only the structural token counts as evidence.
 */
export function hasIndeterminateProbeSignal(text: string): boolean {
  return text.includes(CLI_PROBE_INDETERMINATE_MARKER);
}

// ---------------------------------------------------------------------------
// Deterministic test seam
// ---------------------------------------------------------------------------

/**
 * Environment variable holding stubbed agent-CLI probe outcomes.
 *
 * Selection-policy behaviour (which arbiter candidate wins, and why) is pure,
 * but before #897 the only way to reach it through `admin session-doctor` was
 * to write throwaway shell scripts onto PATH and hope the host could fork them
 * promptly — which is exactly the nondeterminism this issue exists to remove.
 * With this set, agent-CLI probes are answered from the map instead of from a
 * spawn.
 *
 * Never silent: an outcome that came from here is flagged `stubbed`, and every
 * rendering of it carries "[stubbed probe]", so a stub can never be mistaken
 * for a real availability fact in an operator's diagnostic output.
 */
export const CLI_PROBE_STUB_ENV = "AI_LOOP_CLI_PROBE_STUB";

export type CliProbeStubParse =
  | { ok: true; stub: Map<string, CliProbeOutcome> }
  | { ok: false; error: string };

/**
 * The only keys the stub may name.
 *
 * `session-doctor` looks the stub up by agent id, so a key that is not one —
 * `{"claud": "available"}` — would parse, stub nothing, and let the real
 * `claude` check fall back to a real spawn: exactly the nondeterminism this
 * seam exists to remove, and invisible because the run still "succeeded".
 * Enumerated rather than derived so an unstubbable probe (git, gh) is refused
 * here instead of silently accepted and never consulted.
 */
export const CLI_PROBE_STUB_AGENTS: readonly AgentId[] = ["claude", "codex", "gemini"];

/** Synthesize the outcome a stubbed status stands for. */
function stubOutcome(status: CliProbeStatus): CliProbeOutcome {
  switch (status) {
    case "available":
      return { ...probeSucceeded("stubbed 0.0.0"), stubbed: true };
    case "not-found":
      return { ok: false, status, transient: false, output: "stubbed ENOENT", code: "ENOENT", stubbed: true };
    case "non-zero-exit":
      return { ok: false, status, transient: false, output: "stubbed non-zero exit", exitCode: 1, stubbed: true };
    case "timeout":
      return {
        ok: false, status, transient: true, output: "stubbed timeout",
        code: "ETIMEDOUT", signal: TIMEOUT_KILL_SIGNAL, stubbed: true,
      };
    case "spawn-error":
      return { ok: false, status, transient: true, output: "stubbed spawn failure", code: "EAGAIN", stubbed: true };
  }
}

/**
 * Parse the stub map. Refuses anything it does not fully understand rather than
 * ignoring it: a typo'd stub that silently fell back to real spawns would
 * reintroduce the nondeterminism the seam exists to remove.
 */
export function parseCliProbeStub(raw: string | undefined): CliProbeStubParse {
  if (raw === undefined || raw.trim() === "") return { ok: true, stub: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${CLI_PROBE_STUB_ENV} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${CLI_PROBE_STUB_ENV} must be a JSON object of {"<agent>": "<status>"}` };
  }
  const stub = new Map<string, CliProbeOutcome>();
  for (const [agent, status] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(CLI_PROBE_STUB_AGENTS as readonly string[]).includes(agent)) {
      return {
        ok: false,
        error:
          `${CLI_PROBE_STUB_ENV} names unknown CLI "${agent}" — no probe reads that key, so it would `
          + `silently fall back to a real spawn. Stubbable CLIs: ${CLI_PROBE_STUB_AGENTS.join(", ")}`,
      };
    }
    if (typeof status !== "string" || !(CLI_PROBE_STATUSES as readonly string[]).includes(status)) {
      return {
        ok: false,
        error:
          `${CLI_PROBE_STUB_ENV}["${agent}"] must be one of: ${CLI_PROBE_STATUSES.join(", ")}`,
      };
    }
    stub.set(agent, stubOutcome(status as CliProbeStatus));
  }
  return { ok: true, stub };
}
