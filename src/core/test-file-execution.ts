/**
 * The language-neutral test-file execution boundary (issue #1152,
 * `docs/changed-file-verification-contract.md` §2 and §6).
 *
 * A stage asks a project's test tooling for one of exactly two things — run
 * these explicit files, or run the full configured suite — and gets back one
 * outcome per file plus the run-level facts the contract's result table reads:
 * outcome trust, the process result, completeness and termination. This module
 * owns the vocabulary, the request guard and the pure assembly of those facts
 * from what the runner observed and what an adapter read.
 *
 * What it deliberately is not:
 *
 * - **Not a test framework, and not aware of one.** A file id is an opaque
 *   repository-relative path; what counts as a runnable test file, how files
 *   are passed literally and how a machine result is read are the adapter's
 *   (`src/handlers/jest-test-adapter.ts` and, issue #1174,
 *   `src/handlers/vitest-test-adapter.ts`). Core never decides what a test
 *   file is.
 * - **Not a process manager.** Every command runs through the shipped
 *   `CommandRunner` with its deadline, process-group isolation and cleanup
 *   report (`src/handlers/test-file-runner.ts`). {@link TestFileRunStepObservation}
 *   is a structural subset of `CommandRunResult`, as #1098's observation is.
 * - **Not selection, result classification or routing.** Which files a stage
 *   selects, which §3 row a run records and where it routes are #1153's and
 *   #1154's. Nothing here reads a verdict into a transition.
 *
 * The rules every function below serves (§2 boundary invariants 1 and 2): an
 * empty file list is never a full run, per-file outcomes are credited only when
 * they are trusted, and a missing fact is never read as passed.
 */

import { isAbsolute, relative, sep } from "path";

import { isTestFileId } from "./test-file-id.js";
import { checkOutputTail, type CommandExecutionObservation } from "./verification-result.js";
import { stageCheckTerminationUnconfirmed, type StageProcessTreeCleanupObservation } from "./stage-run.js";

export { isTestFileId };

// ---------------------------------------------------------------------------
// Vocabulary (§2)
// ---------------------------------------------------------------------------

/** §6 rule 1: the two explicit modes. */
export type TestExecutionMode = "files" | "full";

/**
 * What a stage asks the tooling to run. `full` carries no list at all, so an
 * empty or absent list can never be read as "everything" (§2 invariant 1).
 */
export type TestExecutionRequest =
  | { readonly mode: "files"; readonly files: readonly string[] }
  | { readonly mode: "full" };

/**
 * §2 per-file outcome. `skipped` means the file was reached and executed no
 * test; `not-run` means it was never reached. Neither is ever merged with
 * `passed` or with each other.
 */
export type TestFileOutcome = "passed" | "failed" | "skipped" | "not-run";

/** §2 outcome trust: why a run's per-file outcomes cannot be credited. */
export const TEST_OUTCOME_UNTRUSTED_REASONS = [
  "deadline",
  "interrupted",
  "spawn-failure",
  "unreadable-result",
  "mismatched-files",
] as const;

export type TestOutcomeUntrustedReason = (typeof TEST_OUTCOME_UNTRUSTED_REASONS)[number];

export type TestOutcomeTrust =
  | { readonly status: "trusted" }
  | {
      readonly status: "untrusted";
      readonly reason: TestOutcomeUntrustedReason;
      /** Bounded operator-facing text. Recorded, never parsed. */
      readonly detail: string;
    };

/** §2 process result: recorded only for a run that ended on its own. */
export type TestProcessResult = "succeeded" | "failed";

/** Why a run is not complete, in the order the reasons are checked. */
export type TestRunIncompleteReason = "untrusted" | "process-failed" | "not-run";

export type TestRunCompleteness =
  | { readonly status: "complete" }
  | { readonly status: "incomplete"; readonly reason: TestRunIncompleteReason };

/** §2 termination, over every process the run launched. */
export type TestRunTermination = "confirmed" | "unconfirmed";

/**
 * The commands one run may launch, in launch order. `setup` is the operator's
 * build step and `discovery` the tooling's runnable-file report; both stay
 * distinct from the `tests` invocation that receives the selection.
 */
export type TestFileRunStepKind = "setup" | "discovery" | "tests";

// ---------------------------------------------------------------------------
// File ids and the request guard (§6 rule 1)
// ---------------------------------------------------------------------------

export type TestExecutionRequestRefusal =
  | "invalid_mode"
  | "empty_selection"
  | "invalid_file_id"
  | "duplicate_file_id"
  | "full_mode_with_files";

/** A request the boundary refuses before anything launches. */
export class TestExecutionRequestError extends Error {
  readonly refusal: TestExecutionRequestRefusal;

  constructor(refusal: TestExecutionRequestRefusal, message: string) {
    super(message);
    this.name = "TestExecutionRequestError";
    this.refusal = refusal;
  }
}

/**
 * Guard a request before any command launches (§6 rule 1): a `files` request
 * needs a non-empty list of distinct file ids, and a `full` request carries no
 * list. Throws {@link TestExecutionRequestError}; returns a copy.
 */
export function validateTestExecutionRequest(request: unknown): TestExecutionRequest {
  const raw = (request ?? {}) as { mode?: unknown; files?: unknown };
  if (raw.mode === "full") {
    if (raw.files !== undefined) {
      throw new TestExecutionRequestError(
        "full_mode_with_files",
        "a full test run carries no file list; send a files request to run explicit files",
      );
    }
    return { mode: "full" };
  }
  if (raw.mode !== "files") {
    throw new TestExecutionRequestError("invalid_mode", 'a test run request must be mode "files" or "full"');
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    throw new TestExecutionRequestError(
      "empty_selection",
      "a files test run needs at least one file; an empty selection never means the full suite",
    );
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const file of raw.files as unknown[]) {
    if (!isTestFileId(file)) {
      throw new TestExecutionRequestError(
        "invalid_file_id",
        `${JSON.stringify(file)} is not a repository-relative test file path`,
      );
    }
    if (seen.has(file)) {
      throw new TestExecutionRequestError("duplicate_file_id", `${file} is selected twice`);
    }
    seen.add(file);
    files.push(file);
  }
  return { mode: "files", files };
}

/**
 * The directory spellings an adapter may see the repository root under. Test
 * tooling commonly reports real paths, so a caller passes both the resolved
 * real path (first) and the working directory as given.
 */
export interface TestFileRoot {
  readonly directories: readonly string[];
}

/**
 * Turn an absolute path the tooling reported into a {@link isTestFileId} id,
 * or `undefined` when it lies outside every spelling of the root.
 */
export function toTestFileId(absolutePath: string, root: TestFileRoot): string | undefined {
  if (!isAbsolute(absolutePath)) return undefined;
  for (const directory of root.directories) {
    const rel = relative(directory, absolutePath);
    if (rel === "" || isAbsolute(rel)) continue;
    const id = rel.split(sep).join("/");
    if (isTestFileId(id)) return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The adapter port
// ---------------------------------------------------------------------------

/** What discovery produced: the runnable-file report, or why it cannot be read. */
export type TestFileInventoryRead =
  | { readonly kind: "readable"; readonly files: readonly string[] }
  | { readonly kind: "unreadable"; readonly reason: string };

/** An outcome the tooling itself reported; `not-run` is derived, never read. */
export type ReportedTestFileOutcome = Exclude<TestFileOutcome, "not-run">;

/** What an adapter read from the tooling's machine result for one run. */
export type TestAdapterRunReport =
  | {
      readonly kind: "readable";
      readonly files: readonly { readonly file: string; readonly outcome: ReportedTestFileOutcome }[];
      /** How many files the tooling itself says this run covered, reached or not. */
      readonly totalFiles: number;
      /** The tooling says the run stopped before finishing. */
      readonly interrupted: boolean;
    }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * A project test tool, as the boundary needs it. Pure: every method builds an
 * argument list or reads text, and nothing here spawns. The runner appends the
 * arguments to the operator's suite command and runs it with the shipped
 * `CommandRunner`.
 */
export interface TestFileAdapter {
  /** The binding's `adapter` value this implementation answers to. */
  readonly kind: string;
  /**
   * Where discovery leaves its runnable-file report: on stdout (the default),
   * or in the file at the `reportPath` {@link discoveryArguments} receives.
   * Issue #1174: a report printed across several lines cannot be told apart
   * from lifecycle output around it, so such tooling writes a file instead.
   */
  readonly discoveryReport?: "stdout" | "file";
  /** Arguments that make the suite command report its runnable files. */
  discoveryArguments(reportPath: string): readonly string[];
  /** Read the runnable-file report from a discovery command that exited 0. */
  readDiscovery(text: string, root: TestFileRoot): TestFileInventoryRead;
  /**
   * Arguments that run exactly `request` and write the machine result to
   * `resultPath`. MUST refuse an empty `files` list rather than run everything
   * (§6 rule 1). Files are passed literally, never as patterns — or, for
   * tooling that has no exact-path facility, the adapter declares
   * {@link selectionCheckArguments} so nothing runs until the tooling itself
   * confirms the arguments select exactly the requested files.
   */
  runArguments(request: TestExecutionRequest, resultPath: string, root: TestFileRoot): readonly string[];
  /** Read the machine result a finished run wrote. */
  readRunResult(text: string, root: TestFileRoot): TestAdapterRunReport;
  /**
   * Issue #1174. Present only for tooling that selects explicit files by filter
   * rather than by exact path, so a requested file can also select a similarly
   * named one. Arguments that make the suite command report — in the
   * {@link discoveryReport} format, running no test — every file the `files`
   * request's run arguments would select. The runner launches this before the
   * tests and launches no test unless the report names exactly the requested
   * files.
   */
  selectionCheckArguments?(
    request: Extract<TestExecutionRequest, { mode: "files" }>,
    reportPath: string,
    root: TestFileRoot,
  ): readonly string[];
  /**
   * Issue #1174. Why the suite command cannot take this adapter's arguments,
   * or `undefined` when it can. `tokens` are the words of the command the
   * arguments would follow — a `-c` wrapper's command string, not the wrapper —
   * `separator` the binding's `argumentSeparator`, and `inShellScript` whether
   * `tokens` are that command string, which a shell interprets, rather than an
   * argv the runner launches without one. The runner refuses a refused command
   * before anything launches.
   */
  suiteCommandRefusal?(
    tokens: readonly string[],
    separator: string | undefined,
    inShellScript: boolean,
  ): string | undefined;
}

// ---------------------------------------------------------------------------
// Assembly (§2)
// ---------------------------------------------------------------------------

/** One command the run launched, as the runner observed it. */
export interface TestFileRunStepObservation
  extends CommandExecutionObservation, StageProcessTreeCleanupObservation {
  readonly step: TestFileRunStepKind;
  /** Run-artifact-relative path of this command's log. */
  readonly logArtifact?: string;
}

/** One launched command, as recorded. No output bytes are copied here. */
export interface TestFileRunStepRecord {
  readonly step: TestFileRunStepKind;
  /** Present only when the child reported a status of its own. */
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut?: true;
  readonly spawnErrorCode?: string;
  readonly durationMs?: number;
  readonly logArtifact?: string;
  readonly terminationUnconfirmed?: true;
}

export interface TestFileRunResult {
  readonly mode: TestExecutionMode;
  /**
   * The files this run had to account for: the request's list in `files` mode,
   * the runnable-file report in `full` mode (empty when it was never read).
   */
  readonly expectedFiles: readonly string[];
  /**
   * One outcome per expected file, sorted by id — present only when outcome
   * trust is `trusted`. Untrusted outcomes are never credited, so none is kept.
   */
  readonly files: readonly { readonly file: string; readonly outcome: TestFileOutcome }[];
  /** The genuine failing files: trusted `failed` outcomes only, sorted. */
  readonly failedFiles: readonly string[];
  readonly trust: TestOutcomeTrust;
  /** Absent when any launched command did not end on its own. */
  readonly processResult?: TestProcessResult;
  readonly completeness: TestRunCompleteness;
  readonly termination: TestRunTermination;
  readonly steps: readonly TestFileRunStepRecord[];
  /** Bounded output of the command that decided an incomplete run. */
  readonly outputTail?: string;
  /** Run-artifact-relative path of the machine result, when one was kept. */
  readonly resultArtifact?: string;
}

export interface AssembleTestFileRunInput {
  /** Already guarded by {@link validateTestExecutionRequest}. */
  readonly request: TestExecutionRequest;
  /** Every command launched, in launch order. */
  readonly steps: readonly TestFileRunStepObservation[];
  /** `full` mode: the discovery read, when discovery exited 0. */
  readonly inventory?: TestFileInventoryRead;
  /** The adapter's read of the machine result, when the tests command ended on its own. */
  readonly report?: TestAdapterRunReport;
  /**
   * `files` mode, issue #1174: why the selection check that ended on its own
   * with exit 0 kept the tests from launching — its report was unreadable, or
   * named other files than the request.
   */
  readonly selectionRefusal?: {
    readonly reason: Extract<TestOutcomeUntrustedReason, "unreadable-result" | "mismatched-files">;
    readonly detail: string;
  };
  readonly resultArtifact?: string;
}

const MAX_DETAIL_CHARS = 512;

function boundedDetail(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/**
 * Why a command did not end on its own, or `undefined` when it did — read from
 * the runner's typed facts only, deadline first.
 */
export function testFileStepAbnormalEnd(
  step: CommandExecutionObservation,
): Extract<TestOutcomeUntrustedReason, "deadline" | "spawn-failure" | "interrupted"> | undefined {
  if (step.timedOut === true || step.deadlineEscalated === true) return "deadline";
  if (step.spawnErrorCode !== undefined || step.spawnError !== undefined) return "spawn-failure";
  if (step.signal !== undefined) return "interrupted";
  return undefined;
}

function stepRecord(step: TestFileRunStepObservation): TestFileRunStepRecord {
  const launched = step.spawnErrorCode === undefined && step.spawnError === undefined;
  return {
    step: step.step,
    ...(step.signal === undefined && launched ? { exitCode: step.exitCode } : {}),
    ...(step.signal !== undefined ? { signal: step.signal } : {}),
    ...(step.timedOut === true || step.deadlineEscalated === true ? { timedOut: true as const } : {}),
    ...(step.spawnErrorCode !== undefined ? { spawnErrorCode: step.spawnErrorCode } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    ...(step.logArtifact !== undefined ? { logArtifact: step.logArtifact } : {}),
    ...(stageCheckTerminationUnconfirmed(step) ? { terminationUnconfirmed: true as const } : {}),
  };
}

const untrusted = (reason: TestOutcomeUntrustedReason, detail: string): TestOutcomeTrust => ({
  status: "untrusted",
  reason,
  detail: boundedDetail(detail),
});

/**
 * Match a readable report against the files the run had to account for. Every
 * mismatch is `mismatched-files`: a file nobody asked for, a file reported
 * twice, or a tooling total that disagrees with the expected set (a literal
 * path the tooling silently dropped shows up exactly there).
 */
function matchReport(
  expected: readonly string[],
  report: Extract<TestAdapterRunReport, { kind: "readable" }>,
): { trust: TestOutcomeTrust; outcomes?: Map<string, TestFileOutcome> } {
  if (report.interrupted) {
    return { trust: untrusted("interrupted", "the test tooling reports the run was interrupted") };
  }
  const expectedSet = new Set(expected);
  const outcomes = new Map<string, TestFileOutcome>();
  for (const { file, outcome } of report.files) {
    if (!expectedSet.has(file)) {
      return { trust: untrusted("mismatched-files", `the result reports ${file}, which this run did not request`) };
    }
    if (outcomes.has(file)) {
      return { trust: untrusted("mismatched-files", `the result reports ${file} twice`) };
    }
    outcomes.set(file, outcome);
  }
  if (report.totalFiles !== expected.length) {
    return {
      trust: untrusted(
        "mismatched-files",
        `the tooling covered ${report.totalFiles} file(s) but this run expected ${expected.length}`,
      ),
    };
  }
  for (const file of expected) {
    if (!outcomes.has(file)) outcomes.set(file, "not-run");
  }
  return { trust: { status: "trusted" }, outcomes };
}

/**
 * Assemble one run's facts (§2). Pure.
 *
 * 1. **Process outcome first** (§6 rule 3). A command that hit its deadline,
 *    failed to spawn or was killed by a signal decides trust before any result
 *    is read, and leaves the run with no process result.
 * 2. **The process result** is the last launched command's exit. A setup or
 *    discovery command that exited nonzero is the run's failure, and no test
 *    result exists for it.
 * 3. **Outcomes are trusted** only when the machine result is readable, not
 *    interrupted, and names exactly the files the run had to account for;
 *    expected files it does not name are `not-run`.
 * 4. **Complete** means trusted, `succeeded` and nothing `not-run`. Anything
 *    else is incomplete, so a timeout, an interruption, a missing or malformed
 *    result or a partial full run can never read as an all-pass.
 */
export function assembleTestFileRun(input: AssembleTestFileRunInput): TestFileRunResult {
  const { request, steps, inventory, report } = input;
  const inventoryFiles =
    request.mode === "full" && inventory !== undefined && inventory.kind === "readable"
      ? [...inventory.files]
      : undefined;
  const expectedFiles = request.mode === "files" ? [...request.files] : (inventoryFiles ?? []);
  const termination: TestRunTermination = steps.some((step) => stageCheckTerminationUnconfirmed(step))
    ? "unconfirmed"
    : "confirmed";
  const last = steps[steps.length - 1];

  let trust: TestOutcomeTrust;
  let processResult: TestProcessResult | undefined;
  let outcomes: Map<string, TestFileOutcome> | undefined;
  let decidingStep: TestFileRunStepObservation | undefined;
  let refusalNote: string | undefined;

  const abnormal = steps.find((step) => testFileStepAbnormalEnd(step) !== undefined);
  if (last === undefined) {
    trust = untrusted("unreadable-result", "no command was launched, so no test result exists");
  } else if (abnormal !== undefined) {
    const reason = testFileStepAbnormalEnd(abnormal) as TestOutcomeUntrustedReason;
    trust = untrusted(reason, `the ${abnormal.step} command did not end on its own (${reason})`);
    decidingStep = abnormal;
  } else {
    processResult = last.exitCode === 0 ? "succeeded" : "failed";
    if (last.exitCode !== 0 && last.step !== "tests") {
      trust = untrusted(
        "unreadable-result",
        `the ${last.step} command exited ${last.exitCode}, so no test result exists`,
      );
      decidingStep = last;
    } else if (request.mode === "full" && inventory !== undefined && inventory.kind === "unreadable") {
      trust = untrusted("unreadable-result", `the runnable-file report is unreadable: ${inventory.reason}`);
    } else if (request.mode === "full" && inventoryFiles === undefined) {
      trust = untrusted("unreadable-result", "no runnable-file report was read for a full run");
    } else if (request.mode === "files" && input.selectionRefusal !== undefined && last.step !== "tests") {
      trust = untrusted(input.selectionRefusal.reason, input.selectionRefusal.detail);
      refusalNote = boundedDetail(input.selectionRefusal.detail);
    } else if (last.step !== "tests") {
      // Only an empty runnable-file report legitimately launches no tests.
      if (request.mode === "full" && expectedFiles.length === 0 && last.step === "discovery") {
        trust = { status: "trusted" };
        outcomes = new Map();
      } else {
        trust = untrusted("unreadable-result", "the tests command was never launched");
      }
    } else if (report === undefined) {
      trust = untrusted("unreadable-result", "no machine result was read");
    } else if (report.kind === "unreadable") {
      trust = untrusted("unreadable-result", report.reason);
    } else {
      const matched = matchReport(expectedFiles, report);
      trust = matched.trust;
      outcomes = matched.outcomes;
    }
    if (decidingStep === undefined && processResult === "failed") decidingStep = last;
  }

  const files =
    trust.status === "trusted" && outcomes !== undefined
      ? [...outcomes.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([file, outcome]) => ({ file, outcome }))
      : [];
  const failedFiles = files.filter((entry) => entry.outcome === "failed").map((entry) => entry.file);

  let completeness: TestRunCompleteness;
  if (trust.status !== "trusted") {
    completeness = { status: "incomplete", reason: "untrusted" };
  } else if (processResult !== "succeeded") {
    completeness = { status: "incomplete", reason: "process-failed" };
  } else if (files.some((entry) => entry.outcome === "not-run")) {
    completeness = { status: "incomplete", reason: "not-run" };
  } else {
    completeness = { status: "complete" };
  }

  const tailSource = decidingStep ?? (completeness.status === "incomplete" ? last : undefined);
  const stepTail = tailSource === undefined ? undefined : checkOutputTail(tailSource);
  // A refused selection is decided by the runner, not by any command's output,
  // and a record keeps only the trust reason: the refusal's detail leads the tail.
  const outputTail = refusalNote === undefined
    ? stepTail
    : [refusalNote, stepTail ?? ""].filter((text) => text !== "").join("\n");

  return {
    mode: request.mode,
    expectedFiles,
    files,
    failedFiles,
    trust,
    ...(processResult !== undefined ? { processResult } : {}),
    completeness,
    termination,
    steps: steps.map(stepRecord),
    ...(outputTail !== undefined && outputTail !== "" ? { outputTail } : {}),
    ...(input.resultArtifact !== undefined ? { resultArtifact: input.resultArtifact } : {}),
  };
}
