/**
 * Run a project's test suite through its bound test adapter (issue #1152,
 * `docs/changed-file-verification-contract.md` §6).
 *
 * This is plumbing, not policy. It launches up to three commands with the
 * shipped {@link CommandRunner} — the operator's optional setup (build) command,
 * the adapter's runnable-file discovery (full mode) or, for an adapter that
 * selects files by filter, its selection check (files mode, issue #1174), and
 * the suite command with the adapter's selection arguments — each with the same
 * deadline, process-group isolation, output buffer and per-command log the
 * verification runner uses.
 * The machine result is written under the run's artifact directory. What those
 * observations mean is assembled in core by `assembleTestFileRun`.
 *
 * The caller supplies the suite command bytes. Resolving them from the effective
 * verification plan, choosing the files, recording the result and routing are
 * the stage's work (#1153, #1154), not this module's.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { CommandRunner } from "./command-runner.js";
import { jestTestFileAdapter } from "./jest-test-adapter.js";
import { vitestTestFileAdapter } from "./vitest-test-adapter.js";
import { MAX_VERIFICATION_BUFFER_BYTES, parseShellTokens } from "./verification.js";
import type { TestSuiteAdapterBinding } from "../core/staged-verification-config.js";
import {
  assembleTestFileRun,
  testFileStepAbnormalEnd,
  validateTestExecutionRequest,
  type AssembleTestFileRunInput,
  type TestAdapterRunReport,
  type TestExecutionRequest,
  type TestFileAdapter,
  type TestFileInventoryRead,
  type TestFileRoot,
  type TestFileRunResult,
  type TestFileRunStepKind,
  type TestFileRunStepObservation,
  type TestFileRunStepRecord,
  type TestRunTermination,
} from "../core/test-file-execution.js";

/**
 * The largest machine result the runner reads. A bigger file is
 * `unreadable-result`, never partially read.
 */
export const MAX_TEST_FILE_RESULT_BYTES = 64 * 1024 * 1024;

const ADAPTERS: Readonly<Record<string, TestFileAdapter>> = {
  jest: jestTestFileAdapter,
  vitest: vitestTestFileAdapter,
};

/** The implementation for a binding's `adapter` value, if one exists. */
export function testFileAdapterFor(kind: string): TestFileAdapter | undefined {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, kind) ? ADAPTERS[kind] : undefined;
}

export interface TestFileCommandOptions {
  /** The repository root (worktree) the suite runs in. File ids are relative to it. */
  readonly cwd: string;
  /** The test suite entry's command bytes, as the caller resolved them. */
  readonly suiteCommand: string;
  /** The operator's binding for that entry. */
  readonly binding: TestSuiteAdapterBinding;
  /**
   * Where logs and the machine result are written. Absent, the machine result
   * goes to a private temporary directory that is removed afterwards and no
   * log is written.
   */
  readonly artifactDir?: string;
  /** Artifact file name prefix. Default `test-files`. */
  readonly artifactPrefix?: string;
  /** Per-command deadline in milliseconds. Absent means no deadline. */
  readonly timeoutMs?: number;
}

export interface TestFileDiscoveryResult {
  /** The runnable-file report; `unreadable` whenever the command did not exit 0. */
  readonly inventory: TestFileInventoryRead;
  readonly steps: readonly TestFileRunStepRecord[];
  readonly termination: TestRunTermination;
  /**
   * The discovery command as launched, so a caller can assemble a run from its
   * process outcome (§6 rule 3); absent when nothing launched.
   */
  readonly observation?: TestFileRunStepObservation;
}

function rootFor(cwd: string): TestFileRoot {
  let real: string | undefined;
  try {
    real = realpathSync(cwd);
  } catch {
    real = undefined;
  }
  // The real path first: test tooling commonly reports and matches real paths.
  return { directories: real === undefined || real === cwd ? [cwd] : [real, cwd] };
}

function adapterOrThrow(binding: TestSuiteAdapterBinding): TestFileAdapter {
  const adapter = testFileAdapterFor(binding.adapter);
  if (adapter === undefined) {
    throw new Error(`no test adapter implements "${binding.adapter}"`);
  }
  return adapter;
}

type Launch = (
  step: TestFileRunStepKind,
  argv: readonly string[],
  logName?: string,
) => TestFileRunStepObservation | undefined;

/**
 * A launcher that runs one command per call with the shipped runner, logs it,
 * and records every observation in `steps`. It returns `undefined`, launching
 * nothing, for a command with no executable token. The log is named after the
 * step unless `logName` says otherwise.
 */
function stepLauncher(
  runner: CommandRunner,
  options: TestFileCommandOptions,
): { steps: TestFileRunStepObservation[]; launch: Launch } {
  const steps: TestFileRunStepObservation[] = [];
  const launch: Launch = (step, argv, logName = step) => {
    const [cmd, ...args] = argv;
    if (cmd === undefined || cmd === "") return undefined;
    const run = runner.run(cmd, args, {
      cwd: options.cwd,
      maxBuffer: MAX_VERIFICATION_BUFFER_BYTES,
      isolateProcessGroup: true,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    let logArtifact: string | undefined;
    if (options.artifactDir !== undefined) {
      const name = `${options.artifactPrefix ?? "test-files"}-${logName}.log`;
      try {
        writeFileSync(join(options.artifactDir, name), `${run.stdout}${run.stderr}`, "utf8");
        logArtifact = name;
      } catch {
        logArtifact = undefined;
      }
    }
    const observation: TestFileRunStepObservation = {
      ...run,
      step,
      ...(logArtifact !== undefined ? { logArtifact } : {}),
    };
    steps.push(observation);
    return observation;
  };
  return { steps, launch };
}

/** The command ended on its own with exit 0. */
function endedCleanly(step: TestFileRunStepObservation): boolean {
  return testFileStepAbnormalEnd(step) === undefined && step.exitCode === 0;
}

const WRAPPER_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** One argument quoted for a POSIX shell command string. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\-.,/:=@%+]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * A single-dash letter cluster that includes `c` (`-c`, `-lc`, `-euc`). Checked
 * as "letters only" plus "contains c" rather than `/^-[A-Za-z]*c[A-Za-z]*$/`,
 * whose two ambiguous letter runs make a long cluster without a `c` quadratic
 * (issue #1200).
 */
function isCommandStringOption(token: string): boolean {
  return /^-[A-Za-z]+$/.test(token) && token.includes("c");
}

function isWrapperShell(token: string | undefined): boolean {
  const shell = token?.split("/").pop();
  return shell !== undefined && WRAPPER_SHELLS.has(shell);
}

/**
 * Where the command string of a shell wrapper starting at `tokens[start]` sits
 * (`bash -lc '<script>'`), or `undefined` when no `-c` shell starts there.
 */
function wrappedScriptIndex(tokens: readonly string[], start = 0): number | undefined {
  if (!isWrapperShell(tokens[start])) return undefined;
  let commandString = false;
  let i = start + 1;
  while (i < tokens.length && /^[-+]/.test(tokens[i] as string)) {
    const token = tokens[i] as string;
    if (isCommandStringOption(token)) commandString = true;
    // `-o <option>` and `-O <shopt>` (also clustered, as in `-euo pipefail`),
    // `--rcfile <file>` and `--init-file <file>` consume the next word.
    const consumesOperand = /^[-+][A-Za-z]*[oO]$/.test(token) || token === "--rcfile" || token === "--init-file";
    i += consumesOperand ? 2 : 1;
  }
  return commandString ? i : undefined;
}

/**
 * Whether any of `tokens`, from `from` on, is a shell followed anywhere by a
 * `-c` option. That covers every recognized wrapper and, conservatively, any
 * layout {@link wrappedScriptIndex} does not recognize, so an unrecognized
 * wrapper is refused rather than handed arguments it takes as positional
 * parameters.
 */
function hasCommandStringShell(tokens: readonly string[], from: number): boolean {
  for (let i = from; i < tokens.length; i += 1) {
    if (isWrapperShell(tokens[i]) && tokens.slice(i + 1).some(isCommandStringOption)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether words appended to a wrapper's command string provably reach its
 * suite command: the script is a single simple command, optionally after
 * `cd <dir> &&` steps. Any other unquoted list, pipeline, background,
 * subshell, substitution or redirection operator — `npm test | tee test.log`,
 * `npm test && echo done` — could hand the words to a different command, so
 * such a script is not. Neither is one with an unterminated quote or a
 * trailing escape, which would absorb them.
 */
function scriptForwardsToSuite(script: string): boolean {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
    } else if (ch === "\\") {
      if (i + 1 >= script.length) return false;
      current += ch;
      i += 1;
      current += script[i] as string;
      continue;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch === "'" ? "'" : '"';
    } else if (ch === "&" && script[i + 1] === "&") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    } else if (/[;&|()<>`]/.test(ch)) {
      return false;
    }
    current += ch;
  }
  if (quote !== undefined) return false;
  const suite = parseShellTokens(current);
  return (
    suite.length > 0 &&
    !hasCommandStringShell(suite, 0) &&
    segments.every((segment) => {
      const words = parseShellTokens(segment);
      return words.length === 2 && words[0] === "cd";
    })
  );
}

/**
 * Whether npm would take words appended to `tokens` as its own options. npm
 * reads every option after a subcommand (`npm test`, `npm run <script>`,
 * `npm exec`) as its configuration unless a `--` precedes it, so
 * `npm test --listTests --json` runs the whole suite with no adapter
 * arguments. Any `npm` word — also one behind a launcher — with no later `--`
 * and no `--` separator ahead of the arguments counts, since forwarding cannot
 * be proven for it.
 */
function npmConsumesArguments(tokens: readonly string[], forwarded: readonly string[]): boolean {
  const npm = tokens.findIndex((token) => /^npm(\.cmd)?$/.test(token.split(/[\\/]/).pop() ?? ""));
  return npm !== -1 && forwarded[0] !== "--" && !tokens.slice(npm + 1).includes("--");
}

/**
 * The suite command followed by the separator and the adapter's arguments.
 *
 * A `-c` shell wrapper takes words after its command string as positional
 * parameters, not as arguments to the wrapped command, so they would silently
 * never reach the tooling — discovery and a selected run would both run the
 * whole suite. For a wrapper, the arguments are appended, quoted, to the
 * command string instead. A wrapper whose command string cannot provably take
 * them at its end (explicit positional parameters, a command after the suite
 * in a list or pipeline, several lines or a comment) is refused before
 * anything launches rather than guessed.
 *
 * Only a wrapper that is the command itself, in a recognized layout, is
 * forwarded into. A `-c` shell anywhere else — behind a launcher
 * (`env NODE_ENV=test sh -c 'jest'`), after shell options this module does not
 * recognize, or inside a wrapper's command string — would take the arguments
 * as positional parameters just the same, so such a command is refused too.
 *
 * An npm command, bare or wrapped, is refused unless a `--` forwards the
 * arguments ({@link npmConsumesArguments}). Last, an adapter that declares
 * `suiteCommandRefusal` (issue #1174) refuses a command its own tooling could
 * not take the arguments through — for a wrapper, judged on its command string.
 */
function suiteArgv(
  adapter: TestFileAdapter,
  options: TestFileCommandOptions,
  adapterArgs: readonly string[],
): string[] {
  const separator = options.binding.argumentSeparator;
  const forwarded = [...(separator !== undefined ? [separator] : []), ...adapterArgs];
  const tokens = parseShellTokens(options.suiteCommand);
  const refuse = (): never => {
    throw new Error(
      `the suite command ${JSON.stringify(options.suiteCommand)} is a shell wrapper that cannot forward ` +
        "the test adapter's arguments to the wrapped command",
    );
  };
  const refuseNpm = (): never => {
    throw new Error(
      `the suite command ${JSON.stringify(options.suiteCommand)} runs npm, which cannot forward ` +
        'the test adapter\'s arguments without a "--" argument separator',
    );
  };
  const refuseForAdapter = (suiteTokens: readonly string[], inShellScript: boolean): void => {
    const refusal = adapter.suiteCommandRefusal?.(suiteTokens, separator, inShellScript);
    if (refusal !== undefined) {
      throw new Error(`the suite command ${JSON.stringify(options.suiteCommand)} is refused: ${refusal}`);
    }
  };
  const scriptIndex = wrappedScriptIndex(tokens);
  if (scriptIndex === undefined) {
    if (hasCommandStringShell(tokens, 0)) refuse();
    if (npmConsumesArguments(tokens, forwarded)) refuseNpm();
    refuseForAdapter(tokens, false);
    return [...tokens, ...forwarded];
  }
  const script = tokens[scriptIndex]?.trim() ?? "";
  if (
    script === "" ||
    scriptIndex !== tokens.length - 1 ||
    /[\r\n#]/.test(script) ||
    !scriptForwardsToSuite(script)
  ) {
    refuse();
  }
  const scriptTokens = parseShellTokens(script);
  if (npmConsumesArguments(scriptTokens, forwarded)) refuseNpm();
  refuseForAdapter(scriptTokens, true);
  return [...tokens.slice(0, scriptIndex), [script, ...forwarded.map(shellQuote)].join(" ")];
}

/** A bounded text file the tooling wrote, or why it cannot be read. */
function readBoundedFile(path: string, what: string): { text: string } | { unreadable: string } {
  if (!existsSync(path)) return { unreadable: `the ${what} was not written` };
  try {
    const size = statSync(path).size;
    if (size > MAX_TEST_FILE_RESULT_BYTES) {
      return { unreadable: `the ${what} is over the ${MAX_TEST_FILE_RESULT_BYTES}-byte bound` };
    }
    return { text: readFileSync(path, "utf8") };
  } catch (err) {
    return { unreadable: `the ${what} could not be read (${(err as Error).message})` };
  }
}

function readResultFile(adapter: TestFileAdapter, path: string, root: TestFileRoot): TestAdapterRunReport {
  if (!existsSync(path)) {
    return { kind: "unreadable", reason: "the test run wrote no machine result" };
  }
  const read = readBoundedFile(path, "machine result");
  if ("unreadable" in read) return { kind: "unreadable", reason: read.unreadable };
  try {
    return adapter.readRunResult(read.text, root);
  } catch (err) {
    return { kind: "unreadable", reason: `the machine result could not be read (${(err as Error).message})` };
  }
}

/**
 * The runnable-file report of a discovery-format command that exited 0: its
 * stdout, or — for an adapter whose `discoveryReport` is `file` — the report
 * file it wrote.
 */
function readDiscoveryReport(
  adapter: TestFileAdapter,
  step: TestFileRunStepObservation,
  reportPath: string,
  root: TestFileRoot,
): TestFileInventoryRead {
  if (adapter.discoveryReport !== "file") return adapter.readDiscovery(step.stdout ?? "", root);
  const read = readBoundedFile(reportPath, "runnable-file report");
  return "unreadable" in read ? { kind: "unreadable", reason: read.unreadable } : adapter.readDiscovery(read.text, root);
}

/**
 * Where one run's tooling files go: the artifact directory, or a private
 * temporary directory the caller removes with `dispose`.
 */
function outputDirectory(options: TestFileCommandOptions): { directory: string; dispose: () => void } {
  if (options.artifactDir !== undefined) return { directory: options.artifactDir, dispose: () => undefined };
  const directory = mkdtempSync(join(tmpdir(), "test-file-run-"));
  return { directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * Ask the project's tooling for its runnable test files at the current
 * worktree content. Runs only the discovery command — no setup, no tests.
 */
export function discoverTestFiles(runner: CommandRunner, options: TestFileCommandOptions): TestFileDiscoveryResult {
  const adapter = adapterOrThrow(options.binding);
  const root = rootFor(options.cwd);
  const { directory, dispose } = outputDirectory(options);
  try {
    const reportPath = join(directory, `${options.artifactPrefix ?? "test-files"}-discovery.json`);
    const argv = suiteArgv(adapter, options, adapter.discoveryArguments(reportPath));
    // A report left by an earlier discovery must never be read as this one's.
    rmSync(reportPath, { force: true });
    const { steps, launch } = stepLauncher(runner, options);
    const step = launch("discovery", argv);
    const assembled = assembleTestFileRun({ request: { mode: "full" }, steps });
    let inventory: TestFileInventoryRead;
    if (step === undefined) {
      inventory = { kind: "unreadable", reason: "the suite command has no executable token" };
    } else if (endedCleanly(step)) {
      inventory = readDiscoveryReport(adapter, step, reportPath, root);
    } else {
      const abnormal = testFileStepAbnormalEnd(step);
      inventory = {
        kind: "unreadable",
        reason: abnormal !== undefined
          ? `the discovery command did not end on its own (${abnormal})`
          : `the discovery command exited ${step.exitCode}`,
      };
    }
    return {
      inventory,
      steps: assembled.steps,
      termination: assembled.termination,
      ...(step !== undefined ? { observation: step } : {}),
    };
  } finally {
    dispose();
  }
}

/**
 * Issue #1174: compare the files a filter-selecting adapter's selection check
 * reported with the request. `undefined` when they are exactly the requested
 * files; otherwise why the tests must not launch.
 */
function selectionMismatch(
  requested: readonly string[],
  selected: TestFileInventoryRead,
): NonNullable<AssembleTestFileRunInput["selectionRefusal"]> | undefined {
  if (selected.kind === "unreadable") {
    return { reason: "unreadable-result", detail: `the selection check report is unreadable: ${selected.reason}` };
  }
  const wanted = new Set(requested);
  const extra = selected.files.filter((file) => !wanted.has(file));
  const got = new Set(selected.files);
  const missing = requested.filter((file) => !got.has(file));
  if (extra.length === 0 && missing.length === 0) return undefined;
  const parts = [
    ...(extra.length > 0
      ? [`the requested file filters would also run ${extra.join(", ")} (similarly named files)`]
      : []),
    ...(missing.length > 0 ? [`the test tooling does not select ${missing.join(", ")} as a test file`] : []),
  ];
  return { reason: "mismatched-files", detail: `refused before any test ran: ${parts.join("; ")}` };
}

/** The binding's setup step, launched ahead of discovery by {@link runTestSuiteSetup}. */
export interface TestSuiteSetupResult {
  /** The setup observation; empty when no `setupCommand` is declared. */
  readonly steps: readonly TestFileRunStepObservation[];
  /** No setup is declared, or it ended on its own with exit 0. */
  readonly succeeded: boolean;
  readonly termination: TestRunTermination;
}

/**
 * Launch the binding's `setupCommand`, when declared, for a caller that must
 * discover runnable files after the build: a setup that builds or generates
 * test files has to run before discovery, not only before the tests. Hand the
 * result to {@link runTestFiles} so the setup is not launched a second time.
 *
 * A suite command that cannot take the adapter's discovery arguments is
 * refused before the setup launches, as {@link runTestFiles} refuses it.
 */
export function runTestSuiteSetup(runner: CommandRunner, options: TestFileCommandOptions): TestSuiteSetupResult {
  const adapter = adapterOrThrow(options.binding);
  // Built only to refuse a suite command early; the report path is never used.
  suiteArgv(adapter, options, adapter.discoveryArguments(join(tmpdir(), "test-files-discovery.json")));
  const { steps, launch } = stepLauncher(runner, options);
  if (options.binding.setupCommand === undefined) return { steps, succeeded: true, termination: "confirmed" };
  const setup = launch("setup", parseShellTokens(options.binding.setupCommand));
  return {
    steps,
    succeeded: setup !== undefined && endedCleanly(setup),
    termination: assembleTestFileRun({ request: { mode: "full" }, steps }).termination,
  };
}

/**
 * Run exactly `request`: the listed files in `files` mode, the configured suite
 * in `full` mode (§6 rule 1).
 *
 * The request is guarded before anything launches, so an empty file list
 * throws instead of running, and so does a suite command that could not pass
 * the adapter's arguments on. Then, in order, each step only after the previous
 * one exited 0:
 *
 * 1. the binding's `setupCommand`, when declared — the build that must happen
 *    before tests consume changed sources, kept apart from the selection. When
 *    `setup` is given, the caller already launched it: it is not launched
 *    again, and its observation leads the run's steps;
 * 2. in `full` mode, discovery, so the run knows every file it must account
 *    for; an empty report launches no tests;
 * 3. in `files` mode, for an adapter that selects files by filter rather than
 *    by exact path (issue #1174), the selection check: the tooling reports
 *    which files the run's filters select, and no test launches unless that is
 *    exactly the request — a similarly named file is refused, never run;
 * 4. the suite command with the adapter's arguments, writing the machine
 *    result to a path whose stale copy is removed before anything launches.
 */
export function runTestFiles(
  runner: CommandRunner,
  request: TestExecutionRequest,
  options: TestFileCommandOptions,
  setup?: TestSuiteSetupResult,
): TestFileRunResult {
  const guarded = validateTestExecutionRequest(request);
  const adapter = adapterOrThrow(options.binding);
  const root = rootFor(options.cwd);
  const { steps, launch } = stepLauncher(runner, options);
  if (setup !== undefined) steps.push(...setup.steps);

  const { directory, dispose } = outputDirectory(options);
  const prefix = options.artifactPrefix ?? "test-files";
  const resultName = `${prefix}-result.json`;
  const resultPath = join(directory, resultName);
  const discoveryPath = join(directory, `${prefix}-discovery.json`);
  const selectionPath = join(directory, `${prefix}-selection.json`);
  try {
    // Every suite invocation is built first, so a suite command that cannot
    // take the adapter's arguments is refused before the setup launches.
    const discoveryArgv = guarded.mode === "full"
      ? suiteArgv(adapter, options, adapter.discoveryArguments(discoveryPath))
      : undefined;
    const selectionArgv = guarded.mode === "files" && adapter.selectionCheckArguments !== undefined
      ? suiteArgv(adapter, options, adapter.selectionCheckArguments(guarded, selectionPath, root))
      : undefined;
    const testsArgv = suiteArgv(adapter, options, adapter.runArguments(guarded, resultPath, root));

    // A result or report left by an earlier run must never be read as this run's.
    rmSync(resultPath, { force: true });
    if (discoveryArgv !== undefined) rmSync(discoveryPath, { force: true });
    if (selectionArgv !== undefined) rmSync(selectionPath, { force: true });

    if (setup !== undefined) {
      if (!setup.succeeded) return assembleTestFileRun({ request: guarded, steps });
    } else if (options.binding.setupCommand !== undefined) {
      const launched = launch("setup", parseShellTokens(options.binding.setupCommand));
      if (launched === undefined || !endedCleanly(launched)) {
        return assembleTestFileRun({ request: guarded, steps });
      }
    }

    let inventory: TestFileInventoryRead | undefined;
    if (discoveryArgv !== undefined) {
      const discovery = launch("discovery", discoveryArgv);
      if (discovery === undefined || !endedCleanly(discovery)) {
        return assembleTestFileRun({ request: guarded, steps });
      }
      inventory = readDiscoveryReport(adapter, discovery, discoveryPath, root);
      if (inventory.kind === "unreadable" || inventory.files.length === 0) {
        return assembleTestFileRun({ request: guarded, steps, inventory });
      }
    }

    if (selectionArgv !== undefined && guarded.mode === "files") {
      const check = launch("discovery", selectionArgv, "selection");
      if (check === undefined || !endedCleanly(check)) {
        return assembleTestFileRun({ request: guarded, steps });
      }
      const selectionRefusal = selectionMismatch(
        guarded.files,
        readDiscoveryReport(adapter, check, selectionPath, root),
      );
      if (selectionRefusal !== undefined) {
        return assembleTestFileRun({ request: guarded, steps, selectionRefusal });
      }
    }

    const tests = launch("tests", testsArgv);
    const report =
      tests !== undefined && testFileStepAbnormalEnd(tests) === undefined
        ? readResultFile(adapter, resultPath, root)
        : undefined;
    return assembleTestFileRun({
      request: guarded,
      steps,
      ...(inventory !== undefined ? { inventory } : {}),
      ...(report !== undefined ? { report } : {}),
      ...(options.artifactDir !== undefined && existsSync(resultPath) ? { resultArtifact: resultName } : {}),
    });
  } finally {
    dispose();
  }
}
