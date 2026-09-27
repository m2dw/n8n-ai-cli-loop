/**
 * The Jest test-file adapter (issue #1152): this repository's first
 * implementation of the language-neutral {@link TestFileAdapter} port in
 * `src/core/test-file-execution.ts`.
 *
 * Everything Jest-specific lives here and nowhere in core:
 *
 * - **Discovery** is Jest's own `--listTests --json`, so the runnable files
 *   are whatever the project's Jest configuration (`testMatch`, `roots`,
 *   `testPathIgnorePatterns`, projects, …) reports — never a hand-maintained
 *   list.
 * - **Explicit files** go through `--runTestsByPath`, Jest's exact-path
 *   facility, with absolute paths. They are never test-path patterns, so a
 *   file name that happens to be a regular expression cannot widen the run,
 *   and an empty list is refused here as well as at the boundary.
 * - **Full mode** passes no path at all, so Jest runs the configured suite.
 * - **The machine result** is Jest's `--json --outputFile` report. Its per-file
 *   `status` and assertion statuses are the only inputs; failure messages are
 *   never parsed.
 * - **Configured behavior is kept.** The adapter never passes `--no-bail`, so
 *   a `bail` in the configuration or the suite command still stops the run
 *   where the operator asked it to. Jest 29 exits on bail without writing the
 *   `--outputFile` report, and the only hook it calls first is the reporters,
 *   so a bailed run has no machine result: it reads as `unreadable-result`
 *   with a failed process result, never as a pass, and credits no outcome.
 *   The adapter never passes `--reporters` to capture one either: that flag
 *   replaces the project's configured reporters — and with them a reporter
 *   error (`getLastError`) that makes the project's own run exit nonzero.
 */

import { join } from "path";

import {
  toTestFileId,
  type ReportedTestFileOutcome,
  type TestAdapterRunReport,
  type TestExecutionRequest,
  type TestFileAdapter,
  type TestFileInventoryRead,
  type TestFileRoot,
} from "../core/test-file-execution.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absolute paths for `--runTestsByPath`, anchored on the root Jest runs in. */
function absoluteFiles(files: readonly string[], root: TestFileRoot): string[] {
  const directory = root.directories[0];
  if (directory === undefined) {
    throw new Error("the Jest adapter needs the repository root to pass files by exact path");
  }
  return files.map((file) => join(directory, ...file.split("/")));
}

/**
 * Read the runnable-file report `jest --listTests --json` prints.
 *
 * Jest prints the list as one JSON array line. When the suite command is an npm
 * script, lifecycle output can surround it on either side (a `pretest` build
 * log before, a `posttest` banner and output after), so the report is the one
 * stdout line that is a JSON array, wherever it sits. No such line, or more
 * than one, is unreadable rather than guessed. A report that is not an array
 * of absolute paths inside the repository is unreadable rather than partially
 * used.
 */
export function readJestDiscovery(stdout: string, root: TestFileRoot): TestFileInventoryRead {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) {
    return { kind: "unreadable", reason: "jest --listTests wrote nothing on stdout" };
  }
  const arrays: unknown[][] = [];
  for (const line of lines) {
    if (!line.startsWith("[")) continue;
    try {
      const candidate = JSON.parse(line) as unknown;
      if (Array.isArray(candidate)) arrays.push(candidate);
    } catch {
      // Not the report: lifecycle output may start with a bracket too.
    }
  }
  const [parsed] = arrays;
  if (parsed === undefined || arrays.length > 1) {
    return {
      kind: "unreadable",
      reason:
        parsed === undefined
          ? "jest --listTests wrote no JSON array line on stdout"
          : `jest --listTests wrote ${arrays.length} JSON array lines on stdout, so the report is ambiguous`,
    };
  }
  const files = new Set<string>();
  for (const entry of parsed) {
    const id = typeof entry === "string" ? toTestFileId(entry, root) : undefined;
    if (id === undefined) {
      return {
        kind: "unreadable",
        reason: `jest --listTests reported ${JSON.stringify(entry)}, which is not a file inside the repository`,
      };
    }
    files.add(id);
  }
  return { kind: "readable", files: [...files].sort() };
}

/**
 * One file's outcome from Jest's formatted result.
 *
 * Jest reports `failed`, `skipped` (every test pending), `passed`, or `focused`
 * (no failure, some tests pending). A file counts as `passed` only when at
 * least one of its assertions actually passed; a file that executed no test is
 * `skipped`, never `passed`.
 */
function jestFileOutcome(entry: Record<string, unknown>): ReportedTestFileOutcome | undefined {
  const status = entry.status;
  const assertions = Array.isArray(entry.assertionResults) ? entry.assertionResults : [];
  const anyAssertion = (wanted: string) =>
    assertions.some((assertion) => isPlainObject(assertion) && assertion.status === wanted);
  if (status === "failed") return "failed";
  if (status === "skipped") return anyAssertion("failed") ? "failed" : "skipped";
  if (status === "passed" || status === "focused") {
    if (anyAssertion("failed")) return "failed";
    return anyAssertion("passed") ? "passed" : "skipped";
  }
  return undefined;
}

const OUTCOME_SEVERITY: Record<ReportedTestFileOutcome, number> = { skipped: 0, passed: 1, failed: 2 };

/** One path's outcome across the Jest projects that ran it. */
function worseOutcome(a: ReportedTestFileOutcome, b: ReportedTestFileOutcome): ReportedTestFileOutcome {
  return OUTCOME_SEVERITY[a] >= OUTCOME_SEVERITY[b] ? a : b;
}

/**
 * Read the report `jest --json --outputFile` wrote.
 *
 * `numTotalTestSuites` is the number of test suites Jest scheduled for this
 * run, reached or not, which is what lets the boundary tell a literal path Jest
 * dropped, or a partial run, from a complete one.
 *
 * When several Jest projects match the same path, Jest runs (and counts) it
 * once per project while `--listTests` names it once. Results are therefore
 * aggregated by repository-relative path — `failed` if any instance failed,
 * else `passed` if any passed, else `skipped` — and each collapsed instance is
 * taken off the total. That keeps the count sound: a file with an instance
 * Jest never reached cannot be balanced out, so a partial run still disagrees
 * with the expected set.
 */
export function readJestRunResult(text: string, root: TestFileRoot): TestAdapterRunReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { kind: "unreadable", reason: "the Jest result file is not valid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { kind: "unreadable", reason: "the Jest result file is not a JSON object" };
  }
  const total = parsed.numTotalTestSuites;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    return { kind: "unreadable", reason: "the Jest result has no numTotalTestSuites count" };
  }
  if (!Array.isArray(parsed.testResults)) {
    return { kind: "unreadable", reason: "the Jest result has no testResults list" };
  }
  const interrupted = parsed.wasInterrupted;
  if (typeof interrupted !== "boolean") {
    return { kind: "unreadable", reason: "the Jest result does not say whether the run was interrupted" };
  }
  const testResults: unknown[] = parsed.testResults;
  if (testResults.length > total) {
    return { kind: "unreadable", reason: "the Jest result lists more test results than numTotalTestSuites counts" };
  }
  const outcomes = new Map<string, ReportedTestFileOutcome>();
  for (const entry of testResults) {
    if (!isPlainObject(entry) || typeof entry.name !== "string") {
      return { kind: "unreadable", reason: "a Jest test result has no file name" };
    }
    const file = toTestFileId(entry.name, root);
    if (file === undefined) {
      return {
        kind: "unreadable",
        reason: `the Jest result reports ${JSON.stringify(entry.name)}, which is not a file inside the repository`,
      };
    }
    const outcome = jestFileOutcome(entry);
    if (outcome === undefined) {
      return {
        kind: "unreadable",
        reason: `the Jest result reports an unrecognized status ${JSON.stringify(entry.status)} for ${file}`,
      };
    }
    const previous = outcomes.get(file);
    outcomes.set(file, previous === undefined ? outcome : worseOutcome(previous, outcome));
  }
  const collapsed = testResults.length - outcomes.size;
  const files = [...outcomes].map(([file, outcome]) => ({ file, outcome }));
  return { kind: "readable", files, totalFiles: total - collapsed, interrupted };
}

export const jestTestFileAdapter: TestFileAdapter = {
  kind: "jest",
  discoveryArguments() {
    return ["--listTests", "--json"];
  },
  readDiscovery: readJestDiscovery,
  runArguments(request: TestExecutionRequest, resultPath: string, root: TestFileRoot) {
    // No `--no-bail`: a configured `bail` is the operator's, and is kept.
    const output = ["--json", `--outputFile=${resultPath}`];
    if (request.mode === "full") return output;
    if (request.files.length === 0) {
      // §6 rule 1: Jest given no path runs everything, so an empty list is
      // refused here too, not only at the boundary.
      throw new Error("the Jest adapter refuses an empty file list; it never turns one into a full run");
    }
    return [...output, "--runTestsByPath", ...absoluteFiles(request.files, root)];
  },
  readRunResult: readJestRunResult,
};
