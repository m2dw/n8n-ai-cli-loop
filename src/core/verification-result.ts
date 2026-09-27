/**
 * Common verification results: what one non-test check's command execution
 * produced (issue #1098, retained by `docs/changed-file-verification-contract.md`
 * §3's "Non-test check records").
 *
 * One command ran, or did not. This module turns that into the one shape every
 * stage reads — {@link CheckExecutionRecord} — so "what happened to this
 * command" stops being a mixture of exit codes, errnos and signals and becomes
 * a verdict plus evidence detail.
 *
 * What it deliberately is not:
 *
 * - **Not a test framework, and not aware of one.** A check is an opaque
 *   operator-authored command: `make verify`, `npm run typecheck`, `go vet
 *   ./...`, all the same code path. Nothing here reads a file name, an
 *   extension, a framework's output, or a report format. Per-file test outcomes
 *   are the test adapter's (`core/test-file-execution.ts`, issue #1152) and
 *   never come from here.
 * - **Not a second classifier.** The verdict is derived from the shipped
 *   #934 path — `classifyVerificationFailure` and
 *   `classifyVerificationEnvironmentFailure` — which stays the only place a
 *   failure is read as transient or as operator-actionable setup.
 * - **Not a subprocess supervisor.** Process invocation, the deadline, the
 *   deadline watchdog and the process-tree sweep are `CommandRunner`'s
 *   (issues #1060, #1089) and are reused unchanged: a caller runs the command
 *   with the runner it already has and hands the result here.
 *   {@link CommandExecutionObservation} is deliberately a structural subset of
 *   `CommandRunResult` so no adaptation is needed and core still imports
 *   nothing from `handlers/`.
 * - **Not selection, not aggregation, not routing.** Issue #1155 retired the
 *   group-selection policy outright: a stage runs the entire required set of
 *   non-test checks, so no check is chosen here, no stage outcome is
 *   aggregated, no transition is derived, and no grant is reached.
 *
 * Retired with that policy (issue #1155): the per-check `membership` and
 * `selectedBy` metadata, which only ever described `selectable` / `finalOnly`
 * group membership and the five-set union that picked a check, and the
 * opaque-command **result adapter** with its structured result envelope, whose
 * only consumer was the deleted project verification file.
 */

import { createHash } from "crypto";

import {
  classifyVerificationEnvironmentFailure,
  type VerificationEnvironmentSignal,
} from "./implementation-verification.js";
import { classifyVerificationFailure } from "./review-classifier.js";
import { boundVerificationOutput } from "./verification-output.js";

// ---------------------------------------------------------------------------
// The closed vocabularies (#1094 §6.2, #1095 §6.1)
// ---------------------------------------------------------------------------

/** #1094 §6.2: one check's verdict in one stage run. Closed. */
export type CheckVerdict = "passed" | "failed" | "timed-out" | "not-run" | "unknown";

/**
 * #1094 §6.1: why a selected check has no verdict. Closed, and read fail-closed
 * — an absent or unrecognized cause is `evidence-lost`, because a run that
 * cannot say why a check went unproven has lost the evidence either way.
 */
export const CHECK_NOT_RUN_KINDS = [
  "first-failure-stop",
  "requirement-unproven",
  "set-budget-exhausted",
  "infrastructure-stop",
  "sandbox-policy-stop",
  "cancellation-stop",
  "evidence-lost",
] as const;

export type CheckNotRunKind = (typeof CHECK_NOT_RUN_KINDS)[number];

/**
 * The per-check execution record — one entry of a stage bundle's `checks[]`,
 * with its metadata fixed.
 *
 * Every field is runner-produced: no value here is supplied by, defaulted from,
 * or corrected by anything outside the runner, including `durationMs`.
 */
export interface CheckExecutionRecord {
  /** #1037 §5.1 identity: `exec:<name>` or `req:<hex>`. Minted by the plan. */
  readonly checkId: string;
  /** The operator-authored name of an `exec:` check; absent for `req:`. */
  readonly name?: string;
  /** sha256 over the command bytes as resolved. The bytes are NOT copied here. */
  readonly commandDigest: string;
  readonly startedAtMs?: number;
  /** Runner-measured (§6.2). Absent for a check that never launched. */
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly verdict: CheckVerdict;
  readonly notRunKind?: CheckNotRunKind;
  /** Bounded operator-facing text. Recorded, never parsed. */
  readonly notRunReason?: string;
  /** Bounded combined output, failures only. */
  readonly outputTail?: string;
  /** Run-artifact-relative path of this check's own log. */
  readonly logArtifact?: string;
}

/** Bound on the operator-facing text this module records but never parses. */
export const MAX_CHECK_TEXT_CHARS = 512;

// ---------------------------------------------------------------------------
// What the runner observed
// ---------------------------------------------------------------------------

/**
 * What one command's execution produced, as `CommandRunner` already reports it
 * (`src/handlers/command-runner.ts`).
 *
 * Structural rather than an import: core never depends on `handlers/`, and a
 * `CommandRunResult` is assignable to this without adaptation — which is the
 * point. Every field below is one the shipped runner already fills, so
 * reporting a timeout, a signal kill or a failed spawn correctly here costs no
 * new execution machinery at all (#1060).
 */
export interface CommandExecutionObservation {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** The runner's own diagnostic for a spawn-level failure; bytes the child never wrote. */
  readonly spawnError?: string;
  /** The errno of that failure (`ENOENT`, `EACCES`, `ENOBUFS`, …). */
  readonly spawnErrorCode?: string;
  /** The runner's deadline expired. */
  readonly timedOut?: boolean;
  /** The deadline watchdog had to force-kill the process group. */
  readonly deadlineEscalated?: boolean;
  /** The signal that terminated the child, when one did. */
  readonly signal?: string;
  /** Runner-measured wall clock, spawn to reap. */
  readonly durationMs?: number;
}

/**
 * The verdict of one command execution, plus the shipped classifier's reading
 * of it.
 *
 * `environmentSignal` and `transientSignal` are carried beside the verdict, not
 * folded into it: #1094's verdict set is closed at five members and has no
 * `infrastructure` — that distinction belongs to the *stage outcome*, which a
 * later slice aggregates (#1094 §6.1). Deriving both here, from the shipped
 * #934/#897 classifiers, is what keeps that later aggregation from needing a
 * second classifier of its own.
 */
export interface CheckExecutionClassification {
  readonly verdict: "passed" | "failed" | "timed-out";
  /** Absent when the child reported no status of its own (see below). */
  readonly exitCode?: number;
  readonly signal?: string;
  /** #934: an operator-actionable setup failure, when the shipped rule sees one. */
  readonly environmentSignal?: VerificationEnvironmentSignal;
  /** #897/#934: a host-transient signal, when the shipped rule sees one. */
  readonly transientSignal?: string;
}

/** The combined output the shipped classifiers read, bounded as they receive it today. */
export function checkOutputTail(run: CommandExecutionObservation): string {
  return boundVerificationOutput([run.stdout, run.stderr].filter(Boolean).join("\n"));
}

/**
 * Classify one command execution (§6.3).
 *
 * The order is the order of how much the observation actually proves:
 *
 * 1. **The deadline expired** — `timed-out`. A check that overran the budget
 *    the operator set produced information, and #1094 §6.1 keeps that distinct
 *    from an absent verdict. `deadlineEscalated` is honored even without
 *    `timedOut`: the watchdog records itself only after finding the child alive
 *    past the deadline, so it is the stronger evidence of the two.
 * 2. **Exit 0, no signal, no spawn failure** — `passed`. All three, because a
 *    runner that had to synthesize a status must never read as a clean pass.
 * 3. **Everything else** — `failed`: a nonzero exit, a signal kill, or a spawn
 *    that never produced a child at all.
 *
 * `exitCode` is reported only when the child itself reported one. A signalled
 * child has no exit status, and a command that never launched has none either;
 * the runner's stand-in `1` is its own bookkeeping, and recording it here would
 * make "the suite returned 1" and "the binary is missing" indistinguishable in
 * evidence — which is exactly how a killed `npm ci` came to be read as a broken
 * package tree (#1060).
 *
 * A spawn failure is still `failed` and not some sixth verdict: the check did
 * not pass, and *why* it did not is the classifier's `environmentSignal`, which
 * the shipped #934 route already turns into an operator handoff rather than a
 * repair cycle. Inventing a verdict for it would widen a closed set (#1094
 * invariant 1) to say something the record already says.
 */
export function classifyCheckExecution(
  name: string,
  run: CommandExecutionObservation,
): CheckExecutionClassification {
  const launched = run.spawnErrorCode === undefined && run.spawnError === undefined;
  // A child that carries a signal, or that never launched, has no status of its
  // own — see the doc comment.
  const exitCode = run.signal === undefined && launched ? run.exitCode : undefined;

  if (run.timedOut === true || run.deadlineEscalated === true) {
    return {
      verdict: "timed-out",
      ...(run.signal !== undefined ? { signal: run.signal } : {}),
    };
  }

  if (run.exitCode === 0 && run.signal === undefined && launched) {
    return { verdict: "passed", exitCode: 0 };
  }

  // Only a failing run is classified, and only its bounded tail is read — the
  // same text the shipped #934 path receives today.
  const output = checkOutputTail(run);
  const transient = classifyVerificationFailure(output);
  const environment = classifyVerificationEnvironmentFailure({
    name,
    exitCode: run.exitCode,
    output,
  });
  return {
    verdict: "failed",
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(run.signal !== undefined ? { signal: run.signal } : {}),
    ...(environment !== undefined ? { environmentSignal: environment } : {}),
    ...(transient.transient ? { transientSignal: transient.signal ?? "transient" } : {}),
  };
}

// ---------------------------------------------------------------------------
// The execution record
// ---------------------------------------------------------------------------

/** #1037 §5.1: the execution layer owns the `exec:` prefix; everything else is a slot. */
export function isExecutionCheckId(checkId: string): boolean {
  return checkId.startsWith("exec:");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * §6.1 rule 1: the record binds to the command bytes by digest, and never
 * copies them. Keeping the bytes out of the record is what makes #1094 §10 rule
 * 5's redaction posture mechanical instead of a matter of care at each surface.
 */
export function deriveCheckCommandDigest(command: string): string {
  return sha256Hex(command);
}

export interface CheckExecutionRecordInput {
  readonly checkId: string;
  /** The operator-authored name. Ignored for a `req:<hex>` check (§6.1 rule 3). */
  readonly name?: string;
  /** The resolved command bytes. Digested, never copied into the record. */
  readonly command: string;
  /** What the runner observed. Absent means the check never launched. */
  readonly run?: CommandExecutionObservation;
  /** #1094 §6.1's recorded cause, for a check with no run. */
  readonly notRunKind?: CheckNotRunKind;
  readonly notRunReason?: string;
  readonly startedAtMs?: number;
  readonly logArtifact?: string;
}

function boundedText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= MAX_CHECK_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_CHECK_TEXT_CHARS - 1)}…`;
}

/**
 * Build one check's record (§6.1).
 *
 * Two absences are kept apart deliberately. A check with a `run` gets the
 * runner's measured `durationMs`; a check with none gets no duration at all,
 * because "ran instantly" and "never ran" must not be the same bytes in
 * evidence (§6.2). And a check with no run and no stated cause is
 * `evidence-lost`, never a quieter member of the set: #1094 §6.1's
 * accounted-absence table is admissible only where a cause was actually
 * recorded, and defaulting to anything else would let an unexplained gap route
 * as though someone had explained it.
 */
export function buildCheckExecutionRecord(
  input: CheckExecutionRecordInput,
): CheckExecutionRecord {
  const isExec = isExecutionCheckId(input.checkId);
  const base = {
    checkId: input.checkId,
    // §6.1 rule 3: a requirement slot has no name — it has no run of its own.
    ...(isExec && input.name !== undefined ? { name: input.name } : {}),
    commandDigest: deriveCheckCommandDigest(input.command),
    ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
    ...(input.logArtifact !== undefined ? { logArtifact: input.logArtifact } : {}),
  };

  if (input.run === undefined) {
    const notRunReason = boundedText(input.notRunReason);
    return {
      ...base,
      verdict: "not-run",
      notRunKind: input.notRunKind ?? "evidence-lost",
      ...(notRunReason !== undefined ? { notRunReason } : {}),
    };
  }

  const classification = classifyCheckExecution(input.name ?? input.checkId, input.run);
  return {
    ...base,
    verdict: classification.verdict,
    ...(classification.exitCode !== undefined ? { exitCode: classification.exitCode } : {}),
    ...(classification.signal !== undefined ? { signal: classification.signal } : {}),
    ...(input.run.durationMs !== undefined ? { durationMs: input.run.durationMs } : {}),
    // §6.1: the bounded tail is failure evidence; a passing check's log stays in
    // its artifact, where nothing has to carry it onto a summary surface.
    ...(classification.verdict === "passed"
      ? {}
      : { outputTail: checkOutputTail(input.run) }),
  };
}


