/**
 * The Vitest test-file adapter (issue #1174): the second implementation of the
 * language-neutral {@link TestFileAdapter} port in
 * `src/core/test-file-execution.ts`, behind the same boundary as the Jest
 * adapter (`docs/changed-file-verification-contract.md` §6 rule 6).
 *
 * Everything Vitest-specific lives here and nowhere in core:
 *
 * - **Supported range** is {@link VITEST_SUPPORTED_RANGE}. Nothing probes the
 *   installed version: every report is read against the exact shape that line
 *   writes, and any other shape is unreadable rather than guessed.
 * - **The adapter owns the subcommand.** Discovery is
 *   `vitest list --filesOnly --json=<file>`, which lists files without
 *   collecting or running a test, and a run is `vitest run`. Neither is watch
 *   mode, so every launch is finite. The bound command must therefore invoke
 *   the Vitest executable itself ({@link vitestSuiteCommandRefusal}).
 * - **Explicit files are checked, not trusted.** Vitest has no exact-path
 *   facility: a file argument selects every runnable file whose path contains
 *   it. Files are passed as absolute paths, and the adapter declares
 *   {@link TestFileAdapter.selectionCheckArguments} so the runner asks
 *   `vitest list` which files those same arguments select before any test
 *   launches; a similarly named file is refused, never run.
 * - **Full mode** passes no file at all, so Vitest runs the configured suite.
 * - **The machine result** is Vitest's JSON reporter. A run replaces the
 *   configured reporters with `default` and `json`, because Vitest has no way
 *   to add one beside them. Per-file `status` and test statuses are the only
 *   inputs; failure messages are never parsed.
 * - **Identity is the repository path.** Vitest's JSON result names a file by
 *   path alone, so a file two project instances both run cannot be told apart:
 *   discovery refuses such a configuration, naming the file and the projects,
 *   and a run result that names one path twice is never collapsed.
 */

import { basename, join } from "path";

import {
  toTestFileId,
  type ReportedTestFileOutcome,
  type TestAdapterRunReport,
  type TestExecutionRequest,
  type TestFileAdapter,
  type TestFileInventoryRead,
  type TestFileRoot,
} from "../core/test-file-execution.js";

/** The Vitest line whose CLI and report shapes this adapter reads. */
export const VITEST_SUPPORTED_RANGE = ">=3.2.0 <4.0.0";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absolute file arguments, anchored on the root Vitest runs in. */
function absoluteFiles(files: readonly string[], root: TestFileRoot): string[] {
  const directory = root.directories[0];
  if (directory === undefined) {
    throw new Error("the Vitest adapter needs the repository root to pass files by absolute path");
  }
  return files.map((file) => join(directory, ...file.split("/")));
}

function refuseEmptyFiles(files: readonly string[]): void {
  if (files.length === 0) {
    // §6 rule 1: Vitest given no file runs everything, so an empty list is
    // refused here too, not only at the boundary.
    throw new Error("the Vitest adapter refuses an empty file list; it never turns one into a full run");
  }
}

// ---------------------------------------------------------------------------
// The suite command
// ---------------------------------------------------------------------------

/**
 * Launchers that run the Vitest executable named next. `node` is handled on its
 * own: it runs a script path, after its own options.
 */
const LAUNCHERS: readonly (readonly string[])[] = [
  [],
  ["npx"],
  ["npx", "--no-install"],
  ["pnpm"],
  ["pnpm", "exec"],
  ["yarn"],
  ["yarn", "exec"],
  ["npm", "exec"],
  ["npm", "exec", "--"],
];

/**
 * Options the adapter supplies itself, or that would make a launch unending,
 * partial or unreadable: watch mode and the UI never finish, `--changed`,
 * `--shard` and a test-name filter run less than the request, and the
 * reporter and output options are the adapter's.
 */
const REFUSED_OPTIONS = new Set([
  "watch",
  "ui",
  "open",
  "api",
  "standalone",
  "changed",
  "shard",
  "related",
  "testNamePattern",
  "reporter",
  "reporters",
  "outputFile",
  "json",
  "filesOnly",
  "mergeReports",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

/**
 * Why the suite command cannot take this adapter's arguments, or `undefined`
 * when it can.
 *
 * The command must invoke the Vitest executable itself — `vitest`,
 * `npx vitest`, `pnpm exec vitest`, `npm exec -- vitest`,
 * `node node_modules/vitest/vitest.mjs` — optionally after `env` and
 * environment assignments, followed only by `--name=value` or `--no-name`
 * options. The adapter appends the subcommand (`list` or `run`), so:
 *
 * - `cd <dir> &&` steps and bare assignments (`NODE_ENV=test npx vitest`) are
 *   shell syntax, so they are accepted only in a wrapper's command string
 *   (`inShellScript`); the runner launches any other command without a shell,
 *   which would try to execute `cd` or the assignment itself. `env NODE_ENV=test`
 *   is accepted either way;
 * - a package script (`npm test`, `npm run test:unit --`) is refused, because
 *   its body might already name one;
 * - a bare word after the executable is refused, because Vitest would read it
 *   as a subcommand or a file filter, and so is an option without `=`, which
 *   could take the next word as its value;
 * - watch mode, the UI, `--changed`, `--shard`, a test-name filter and the
 *   reporter options the adapter supplies are refused.
 *
 * A `--` separator reaches Vitest itself, which would then read the
 * subcommand as a file filter, so `argumentSeparator` is refused unless npm
 * consumes it (`npm exec vitest`, which in turn takes no options of its own
 * before that `--`).
 */
export function vitestSuiteCommandRefusal(
  tokens: readonly string[],
  separator: string | undefined,
  inShellScript: boolean,
): string | undefined {
  const shellOnly =
    "is shell syntax, but the runner launches a suite command without a shell; put it in a wrapper's " +
    "command string (sh -c '…') or use env NAME=value";
  // `cd <dir> && …` steps in a wrapper's command string; the runner has
  // already proved the words reach the last segment.
  const lastList = tokens.lastIndexOf("&&");
  if (lastList !== -1 && !inShellScript) return `"&&" ${shellOnly}`;
  let words = tokens.slice(lastList + 1);
  if (words[0] !== undefined && ENV_ASSIGNMENT.test(words[0]) && !inShellScript) {
    return `the environment assignment ${JSON.stringify(words[0])} ${shellOnly}`;
  }
  if (words[0] === "env") words = words.slice(1);
  while (words[0] !== undefined && ENV_ASSIGNMENT.test(words[0])) words = words.slice(1);
  if (words.length === 0) return "it names no command";

  let executable: number;
  let launcher: readonly string[];
  if (basename(words[0] as string) === "node") {
    executable = words.findIndex((word, i) => i > 0 && !word.startsWith("-"));
    const script = executable === -1 ? undefined : basename(words[executable] as string);
    if (script !== "vitest.mjs" && script !== "vitest") {
      return "a node command must run the Vitest executable script (node node_modules/vitest/vitest.mjs)";
    }
    launcher = ["node"];
  } else {
    executable = words.findIndex((word) => basename(word) === "vitest");
    launcher = executable === -1 ? [] : words.slice(0, executable);
    if (executable === -1 || !LAUNCHERS.some((known) => sameWords(known, launcher))) {
      return (
        "the Vitest adapter supplies the subcommand, so the suite command must invoke the Vitest executable " +
        "itself (npx vitest, pnpm exec vitest, npm exec -- vitest, node node_modules/vitest/vitest.mjs); " +
        "a package script such as npm test is refused because it may already name one"
      );
    }
  }

  const npmExec = launcher[0] === "npm";
  const npmSeparated = npmExec && launcher.includes("--");
  const options = words.slice(executable + 1);
  if (npmExec && !npmSeparated) {
    if (separator !== "--") return 'npm exec needs a "--" argumentSeparator to forward the adapter\'s arguments';
    if (options.length > 0) {
      return 'npm exec reads options before its "--" as its own configuration; write npm exec -- vitest instead';
    }
  } else if (separator !== undefined) {
    return `an argumentSeparator ${JSON.stringify(separator)} would reach Vitest itself, which reads the subcommand after it as a file filter`;
  }

  for (const option of options) {
    const match = /^--(?:no-)?([A-Za-z][A-Za-z0-9-]*)(?:\.[A-Za-z0-9.-]+)?(=.*)?$/.exec(option);
    const name = match?.[1];
    if (match === null || name === undefined || (!option.startsWith("--no-") && match[2] === undefined)) {
      return (
        `${JSON.stringify(option)} is not a --name=value or --no-name option; the adapter supplies the ` +
        "subcommand and the files, and any other word could be read as one of them"
      );
    }
    const camel = name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
    if (REFUSED_OPTIONS.has(camel)) {
      return `${JSON.stringify(option)} is refused: it would make a stage launch unending, partial or read another report`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Read the runnable-file report `vitest list --filesOnly --json=<file>` wrote:
 * a JSON array of `{ file, projectName? }` entries, one per project instance of
 * each file.
 *
 * A file two instances list (two configured projects, or a test and a
 * typecheck instance) is refused rather than collapsed: the run result names a
 * file by path alone, so those instances' outcomes could not be told apart. A
 * report that is not that array, or names a file outside the repository, is
 * unreadable rather than partially used.
 */
export function readVitestDiscovery(text: string, root: TestFileRoot): TestFileInventoryRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { kind: "unreadable", reason: "the vitest list report is not valid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { kind: "unreadable", reason: "the vitest list report is not a JSON array" };
  }
  const projects = new Map<string, string[]>();
  for (const entry of parsed as unknown[]) {
    if (!isPlainObject(entry) || typeof entry.file !== "string") {
      return { kind: "unreadable", reason: `the vitest list report has an entry with no file: ${JSON.stringify(entry)}` };
    }
    const projectName = entry.projectName;
    if (projectName !== undefined && typeof projectName !== "string") {
      return { kind: "unreadable", reason: `the vitest list report names an unrecognized project for ${entry.file}` };
    }
    const id = toTestFileId(entry.file, root);
    if (id === undefined) {
      return {
        kind: "unreadable",
        reason: `vitest list reported ${JSON.stringify(entry.file)}, which is not a file inside the repository`,
      };
    }
    projects.set(id, [...(projects.get(id) ?? []), projectName ?? "(unnamed project)"]);
  }
  for (const [id, names] of projects) {
    if (names.length > 1) {
      return {
        kind: "unreadable",
        reason:
          `${id} is run by ${names.length} Vitest project instances (${names.join(", ")}); the JSON result names ` +
          "a file by path alone, so the adapter refuses a configuration in which a test file belongs to more " +
          "than one project rather than collapse its results",
      };
    }
  }
  return { kind: "readable", files: [...projects.keys()].sort() };
}

// ---------------------------------------------------------------------------
// The run result
// ---------------------------------------------------------------------------

const TEST_STATUSES = new Set(["passed", "failed", "skipped", "todo", "pending"]);

/**
 * One file's outcome from Vitest's JSON reporter, or why it credits nothing.
 *
 * Vitest writes `failed` when the file itself failed — it did not collect, or a
 * suite hook threw — or any of its tests failed, and `passed` otherwise. A file
 * counts as `passed` only when at least one test passed, and `skipped` when it
 * executed none (skipped and todo tests only). A test still `pending` means the
 * report was written before the run finished, and a file with no test result
 * at all was never reached.
 */
function vitestFileOutcome(
  entry: Record<string, unknown>,
  file: string,
): { outcome: ReportedTestFileOutcome; tests: number } | { unreadable: string } {
  if (entry.status !== "passed" && entry.status !== "failed") {
    return { unreadable: `the Vitest result reports an unrecognized status ${JSON.stringify(entry.status)} for ${file}` };
  }
  if (!Array.isArray(entry.assertionResults)) return { unreadable: `the Vitest result has no test list for ${file}` };
  const statuses: string[] = [];
  for (const test of entry.assertionResults as unknown[]) {
    const status = isPlainObject(test) ? test.status : undefined;
    if (typeof status !== "string" || !TEST_STATUSES.has(status)) {
      return { unreadable: `the Vitest result reports an unrecognized test status ${JSON.stringify(status)} in ${file}` };
    }
    statuses.push(status);
  }
  const tests = statuses.length;
  if (statuses.includes("pending")) return { unreadable: `the Vitest result reports a test in ${file} still pending` };
  if (entry.status === "failed" || statuses.includes("failed")) return { outcome: "failed", tests };
  if (tests === 0) return { unreadable: `the Vitest result reports no test result for ${file}` };
  return { outcome: statuses.includes("passed") ? "passed" : "skipped", tests };
}

/**
 * Read the report Vitest's JSON reporter wrote to `--outputFile.json`.
 *
 * The report has no scheduled-file count, so `totalFiles` is the number of
 * file results; a file the run never reached is missing from it, and the
 * boundary reads it as `not-run`. The per-file test lists must add up to
 * `numTotalTests`, and one path reported twice is left for the boundary to
 * refuse rather than collapsed. Vitest has no interruption flag: a cancelled
 * run leaves tests pending, which credits nothing.
 */
export function readVitestRunResult(text: string, root: TestFileRoot): TestAdapterRunReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { kind: "unreadable", reason: "the Vitest result file is not valid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { kind: "unreadable", reason: "the Vitest result file is not a JSON object" };
  }
  const totalTests = parsed.numTotalTests;
  if (typeof totalTests !== "number" || !Number.isInteger(totalTests) || totalTests < 0) {
    return { kind: "unreadable", reason: "the Vitest result has no numTotalTests count" };
  }
  if (!Array.isArray(parsed.testResults)) {
    return { kind: "unreadable", reason: "the Vitest result has no testResults list" };
  }
  const testResults: unknown[] = parsed.testResults;
  const files: { file: string; outcome: ReportedTestFileOutcome }[] = [];
  let countedTests = 0;
  for (const entry of testResults) {
    if (!isPlainObject(entry) || typeof entry.name !== "string") {
      return { kind: "unreadable", reason: "a Vitest test result has no file name" };
    }
    const file = toTestFileId(entry.name, root);
    if (file === undefined) {
      return {
        kind: "unreadable",
        reason: `the Vitest result reports ${JSON.stringify(entry.name)}, which is not a file inside the repository`,
      };
    }
    const read = vitestFileOutcome(entry, file);
    if ("unreadable" in read) return { kind: "unreadable", reason: read.unreadable };
    countedTests += read.tests;
    files.push({ file, outcome: read.outcome });
  }
  if (countedTests !== totalTests) {
    return {
      kind: "unreadable",
      reason: `the Vitest result lists ${countedTests} test(s) but numTotalTests counts ${totalTests}`,
    };
  }
  return { kind: "readable", files, totalFiles: testResults.length, interrupted: false };
}

export const vitestTestFileAdapter: TestFileAdapter = {
  kind: "vitest",
  discoveryReport: "file",
  discoveryArguments(reportPath: string) {
    return ["list", "--filesOnly", `--json=${reportPath}`];
  },
  readDiscovery: readVitestDiscovery,
  selectionCheckArguments(request, reportPath: string, root: TestFileRoot) {
    refuseEmptyFiles(request.files);
    return ["list", "--filesOnly", `--json=${reportPath}`, ...absoluteFiles(request.files, root)];
  },
  runArguments(request: TestExecutionRequest, resultPath: string, root: TestFileRoot) {
    const output = ["run", "--reporter=default", "--reporter=json", `--outputFile.json=${resultPath}`];
    if (request.mode === "full") return output;
    refuseEmptyFiles(request.files);
    return [...output, ...absoluteFiles(request.files, root)];
  },
  readRunResult: readVitestRunResult,
  suiteCommandRefusal: vitestSuiteCommandRefusal,
};
