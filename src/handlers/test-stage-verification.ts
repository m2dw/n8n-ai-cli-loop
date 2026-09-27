/**
 * Changed-file / full-suite verification, lane side (issue #1154,
 * `docs/changed-file-verification-contract.md` §5 and §6).
 *
 * This module wires #1152's execution boundary and #1153's selection, retained
 * set and record into the lanes. It decides nothing itself: the §3 row, the §5
 * route and the suite slot are `src/core/test-stage-routing.ts`'s, the selection
 * and retention are `src/core/changed-test-file-selection.ts`'s, and every write
 * goes through the shipped `allocateStageRun` / `recordStageRun`.
 *
 * - **Stage 1** ({@link runStage1TestVerification}) replaces the bound test
 *   suite entry in every lane that runs verification during the loop: the
 *   changed test files of the Issue's cumulative diff, union its retained
 *   failing files, run through the bound adapter. The run is allocated before
 *   anything launches and recorded with its identity re-checked from the live
 *   task and session, so the review lane's final stage can require a passing
 *   Stage 1 at the approved revision.
 * - **Stage 2** runs inside the review lane's final stage
 *   (`runFinalStageVerification`), through {@link runStage2Tests}.
 * - **Non-test checks** ({@link nonTestVerificationCommands}) keep their shipped
 *   execution; only the suite entry, and any duplicate of it, is removed.
 *
 * Applicability is the operator's suite binding: a session whose
 * `stagedVerification` is enabled must declare `testSuite` to load at all
 * (#1152), so {@link resolveTestStageContext} reports `not-applicable` only for a
 * disabled session.
 */

import type { CommandRunner } from "./command-runner.js";
import { readCumulativeChange, readIssueBranchStart } from "./cumulative-test-change.js";
import { readCurrentPrepareStamp } from "./environment-prepare.js";
import { extractIssueVerificationCommands } from "./issue-verification-extractor.js";
import {
  contextOnlyStagedVerificationStore,
  readWorkingTreeListing,
  resolveStageVerificationPlan,
} from "./stage-verification.js";
import {
  discoverTestFiles,
  runTestFiles,
  runTestSuiteSetup,
  type TestFileCommandOptions,
  type TestSuiteSetupResult,
} from "./test-file-runner.js";
import type { VerificationFailure } from "./verification.js";
import type { AiTask } from "../core/task.js";
import type { PhaseHandlerResult } from "../core/phase-runner.js";
import type { ResolvedSession, VerificationCommands } from "../core/session.js";
import {
  resolveStagedVerificationSettings,
  type ResolvedStagedVerificationSettings,
  type ResolvedTestSuiteBinding,
} from "../core/staged-verification-config.js";
import {
  buildTestStageRecord,
  deriveTestSuiteBindingDigest,
  resolveIssueBase,
  selectStage1TestFiles,
  STAGE1_SELECTION_NOT_READ_UNATTESTED,
  stage1ExecutionPlan,
  type CumulativeChangeRead,
  type Stage1TestSelection,
  type TestStageRecord,
  type TestStageResult,
  type TestStageSelectionRecord,
} from "../core/changed-test-file-selection.js";
import {
  assembleTestFileRun,
  testFileStepAbnormalEnd,
  type TestFileInventoryRead,
  type TestFileRunResult,
  type TestFileRunStepObservation,
  type TestRunTermination,
} from "../core/test-file-execution.js";
import {
  allocateStageRun,
  deriveStageSelectionDigest,
  recordStageRun,
  retainedTestFilesRead,
  stageRunKey,
  unknownIdentityComponent,
  validateStagedVerificationState,
  STAGED_VERIFICATION_CONTEXT_KEY,
  STAGE_IDENTITY_COMPONENTS,
  type StageEvidenceIdentity,
  type StageOutcome,
  type StageRunId,
  type StageRunResult,
  type StageRunResultInput,
  type StagedVerificationState,
  type StagedVerificationStore,
  type VerificationLane,
} from "../core/staged-verification-state.js";
import {
  deriveAmendmentIdentityComponents,
  deriveEnvironmentIdentityComponent,
  deriveTestedRevisionComponent,
  deriveWorkingTreeStateComponent,
  type WorkingTreeListing,
} from "../core/stage-evidence-validity.js";
import {
  classifyTestStageResult,
  declaresBoundTestSuiteCommand,
  describeTestStageRecord,
  openStageRunGuard,
  resolveTestSuiteSlot,
  routeStage1TestResult,
  testSuiteRequirementDeclaration,
  type Stage1TestRoute,
  type TestStageClassification,
  type TestStagePlanKind,
  type TestSuiteSlotResolution,
} from "../core/test-stage-routing.js";
import { resolveDependencyReviewBase } from "../core/review-admission.js";
import { stageCheckHostFailure } from "../core/stage-run.js";
import { classifyCheckExecution } from "../core/verification-result.js";
import {
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  validateVerificationAmendmentState,
} from "../core/verification-amendment.js";
import { normalizeCommitSha } from "../core/verification-evidence.js";
import {
  buildVerificationSessionBaseline,
  reconcileVerificationPlan,
  type EffectiveVerificationPlan,
  type EffectiveVerificationSlot,
  type FullSuiteRequirementDeclaration,
} from "../core/verification-plan.js";

// ---------------------------------------------------------------------------
// Applicability and the suite binding
// ---------------------------------------------------------------------------

/** The session layer a test stage reads. */
export type TestStageSession = Pick<
  ResolvedSession,
  "verification" | "stagedVerification" | "environmentPrepare" | "artifactRoot"
>;

export interface ReadyTestStageContext {
  readonly status: "ready";
  readonly plan: EffectiveVerificationPlan;
  readonly settings: ResolvedStagedVerificationSettings;
  readonly binding: ResolvedTestSuiteBinding;
  readonly suite: TestSuiteSlotResolution;
  /** `deriveTestSuiteBindingDigest` over the key, the plan's suite bytes and the adapter binding. */
  readonly suiteBindingDigest: string;
}

export type TestStageContext =
  /** Staged verification is off, or carries no suite binding: the lane's shipped verification runs. */
  | { readonly status: "not-applicable" }
  /** The effective plan does not reconcile, so no suite can be resolved from it. */
  | { readonly status: "plan-unresolvable"; readonly detail: string }
  | ReadyTestStageContext;

export function resolveTestStageContext(input: {
  readonly session: Pick<ResolvedSession, "verification" | "stagedVerification">;
  readonly task: Pick<AiTask, "context">;
}): TestStageContext {
  const settings = resolveStagedVerificationSettings(input.session.stagedVerification);
  const binding = settings.testSuite;
  if (!settings.enabled || binding === undefined) return { status: "not-applicable" };
  // A plan whose only execution slot was the retired bound suite still resolves:
  // the unbound suite is what Stage 1 and Stage 2 record `unavailable` for (§6 rule 1).
  const stage = resolveStageVerificationPlan(input);
  if (stage.status !== "ready") {
    return {
      status: "plan-unresolvable",
      detail: stage.detail !== undefined ? `${stage.reason}: ${stage.detail}` : stage.reason,
    };
  }
  // Issue #1166 review, P1: the declaration is rechecked against the effective
  // plan here, not only against the static `session.verification` map at load,
  // so an amendment that gives another active slot a declared command routes as
  // an ambiguous suite instead of running the full suite as a non-test check.
  const suite = resolveTestSuiteSlot(stage.plan, binding.key, testSuiteRequirementDeclaration(binding));
  return {
    status: "ready",
    plan: stage.plan,
    settings: stage.settings,
    binding,
    suite,
    suiteBindingDigest: deriveTestSuiteBindingDigest({
      key: binding.key,
      command: suite.status === "bound" ? suite.slot.command : "",
      adapter: binding.adapter,
      ...(binding.setupCommand !== undefined ? { setupCommand: binding.setupCommand } : {}),
      ...(binding.argumentSeparator !== undefined ? { argumentSeparator: binding.argumentSeparator } : {}),
      ...(binding.requirementCommands !== undefined
        ? { requirementCommands: binding.requirementCommands }
        : {}),
    }),
  };
}

/**
 * Issue #1166 (§6 rule 5): this context's declared full-suite requirement
 * alias, or `undefined` when the operator declared none.
 *
 * A lane reads it here so the declaration a stage run records its bundle under
 * is the one the same context resolved the binding from.
 */
export function testStageFullSuiteRequirement(
  context: TestStageContext,
): FullSuiteRequirementDeclaration | undefined {
  if (context.status !== "ready") return undefined;
  return testSuiteRequirementDeclaration(context.binding);
}

/**
 * The verification commands a lane still runs directly while the test stages
 * apply: every active execution slot of the effective plan except the bound
 * suite entry, with the plan's bytes (§6 rules 2 and 5). An unbound suite — a
 * retired slot, a duplicate, or a slot an amendment gave a declared
 * Issue-requirement command (issue #1166 review, P1) — leaves the colliding
 * slots out too, because an ambiguous suite is never executed as a non-test
 * check. A declared command is excluded even when the bound key itself was
 * retired: one revision can do both, and the declaration alone already says
 * that slot runs the full suite.
 */
export function nonTestVerificationCommands(context: ReadyTestStageContext): VerificationCommands {
  const commands: VerificationCommands = {};
  const boundKey = context.binding.key;
  const suite = context.suite;
  if (suite.status === "bound") {
    for (const slot of suite.nonTestSlots) commands[slot.name] = slot.command;
    return commands;
  }
  const declaration = testStageFullSuiteRequirement(context);
  const active = context.plan.execution.filter(
    (slot): slot is EffectiveVerificationSlot & { name: string } => slot.state === "active" && slot.name !== undefined,
  );
  const suiteSlot = active.find((slot) => slot.name === boundKey);
  for (const slot of active) {
    if (slot.name === boundKey) continue;
    // A declared Issue-requirement command runs the full suite by the
    // operator's own declaration, so it is excluded even when the bound key has
    // no active slot left to compare it against (issue #1166 review, P1).
    if (declaresBoundTestSuiteCommand(slot.command, boundKey, declaration)) continue;
    if (
      suiteSlot !== undefined
      && resolveTestSuiteSlot({ ...context.plan, execution: [suiteSlot, slot] }, boundKey, declaration).status
        !== "bound"
    ) {
      continue;
    }
    commands[slot.name] = slot.command;
  }
  return commands;
}

/**
 * The complement of {@link nonTestVerificationCommands} as a slot predicate:
 * true for the bound suite entry, any active slot that duplicates it, and any
 * slot an amendment gave a declared Issue-requirement command of that entry
 * (issue #1166 review, P1) — that slot runs the full suite, so Stage 1 must
 * never execute it before approval, including when the same revision retired
 * the bound slot and left nothing to compare it against. A lane that runs the
 * shipped loop
 * selection hands this to `runLoopStageVerification` so only those slots leave
 * the selection (§6 rules 2 and 5), and every other check keeps its
 * adapter-selected execution.
 */
export function testStageReplacedCheck(
  context: ReadyTestStageContext,
): (slot: Pick<EffectiveVerificationSlot, "name" | "command">) => boolean {
  const boundKey = context.binding.key;
  const declaration = testStageFullSuiteRequirement(context);
  const suiteSlot = context.plan.execution.find((slot) => slot.state === "active" && slot.name === boundKey);
  return (slot) =>
    slot.name === boundKey
    // Excluded with or without an active bound slot (issue #1166 review, P1).
    || declaresBoundTestSuiteCommand(slot.command, boundKey, declaration)
    || (suiteSlot !== undefined
      && slot.name !== undefined
      && resolveTestSuiteSlot(
        { ...context.plan, execution: [suiteSlot, { ...suiteSlot, name: slot.name, command: slot.command }] },
        boundKey,
        declaration,
      ).status !== "bound");
}

// ---------------------------------------------------------------------------
// Identity (§8 invariant 1)
// ---------------------------------------------------------------------------

function resolveHead(runner: CommandRunner, cwd: string): string | undefined {
  try {
    const probe = runner.run("git", ["rev-parse", "HEAD"], { cwd });
    return probe.exitCode === 0 ? normalizeCommitSha(probe.stdout) : undefined;
  } catch {
    return undefined;
  }
}

export interface TestStageIdentityInput {
  readonly session: TestStageSession;
  readonly task: Pick<AiTask, "context">;
  readonly settings: ResolvedStagedVerificationSettings;
  readonly suiteBindingDigest: string;
  readonly cwd: string;
  readonly head: string | undefined;
  readonly listing: WorkingTreeListing;
}

/**
 * The seven identity components of a test-stage run. The configuration
 * identity carries the suite binding as `selectionPolicyDigest`, which is what
 * `recordStageRun` requires of a bundle with a test-file record.
 */
export function deriveTestStageIdentity(input: TestStageIdentityInput): StageEvidenceIdentity {
  const ctx = (input.task.context ?? {}) as Record<string, unknown>;
  const body = typeof ctx.body === "string" ? ctx.body : "";
  const reconciliation = reconcileVerificationPlan({
    sessionVerification: input.session.verification,
    issueRequirements: body ? extractIssueVerificationCommands(body) : [],
    amendments: ctx[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  });
  const amendmentState = validateVerificationAmendmentState(ctx[VERIFICATION_AMENDMENTS_CONTEXT_KEY]);
  const checkpoint = amendmentState.valid ? amendmentState.state?.checkpoint : undefined;
  const baseline = buildVerificationSessionBaseline(input.session.verification);
  return {
    testedRevision: deriveTestedRevisionComponent(input.head),
    workingTreeState: deriveWorkingTreeStateComponent(input.listing),
    ...deriveAmendmentIdentityComponents({
      reconciliation,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      liveSessionBaseline:
        baseline.status === "ok"
          ? { state: "declared", entries: baseline.sessionBaseline }
          : { state: "unreadable", reason: "session.verification does not normalize" },
    }),
    selectionPolicyDigest: { state: "value", value: input.suiteBindingDigest },
    environmentIdentity: deriveEnvironmentIdentityComponent({
      prepareStamp: readCurrentPrepareStamp({
        config: input.session.environmentPrepare,
        cwd: input.cwd,
        worktreeIdentity: input.cwd,
        artifactRoot: input.session.artifactRoot,
      }),
      ...(input.settings.environmentIdentity !== undefined
        ? { operatorToken: { state: "declared", value: input.settings.environmentIdentity } }
        : {}),
    }),
  };
}

export function testStageIdentityUnattested(identity: StageEvidenceIdentity): boolean {
  return STAGE_IDENTITY_COMPONENTS.some((component) => identity[component]?.state === "unknown");
}

export interface TestStageRecheckInput {
  readonly session: TestStageSession;
  readonly task: AiTask;
  readonly cwd: string;
  readonly store?: StagedVerificationStore;
  readonly readLiveSession?: () => Promise<TestStageSession | undefined>;
}

/**
 * The completion re-check (§8 invariant 1): the identity derived again from the
 * LIVE task row and session configuration. A live layer that cannot be read, or
 * no longer resolves a suite binding, leaves the configuration components
 * `unknown`; a changed binding moves `selectionPolicyDigest`.
 */
export async function recheckTestStageIdentity(
  input: TestStageRecheckInput,
  head: string | undefined,
  listing: WorkingTreeListing,
): Promise<StageEvidenceIdentity> {
  let live: TestStageSession | undefined = input.session;
  let unresolved: string | undefined;
  if (input.readLiveSession !== undefined) {
    try {
      live = await input.readLiveSession();
      if (live === undefined) unresolved = "live_session_unresolvable";
    } catch {
      live = undefined;
      unresolved = "live_session_unreadable";
    }
  }
  let liveTask: AiTask | undefined = input.task;
  if (input.store !== undefined) {
    try {
      liveTask = (await input.store.getTask({ sessionId: input.task.sessionId, issueNumber: input.task.issueNumber })) ?? undefined;
      if (liveTask === undefined) unresolved ??= "live_task_unresolvable";
    } catch {
      liveTask = undefined;
      unresolved ??= "live_task_unreadable";
    }
  }
  const liveContext = live !== undefined && liveTask !== undefined
    ? resolveTestStageContext({ session: live, task: liveTask })
    : undefined;
  if (live === undefined || liveTask === undefined || liveContext === undefined || liveContext.status !== "ready") {
    const unknown = unknownIdentityComponent(unresolved ?? `live_test_stage_${liveContext?.status ?? "unavailable"}`);
    const identity = Object.fromEntries(
      STAGE_IDENTITY_COMPONENTS.map((name) => [name, unknown]),
    ) as unknown as StageEvidenceIdentity;
    return {
      ...identity,
      testedRevision: deriveTestedRevisionComponent(head),
      workingTreeState: deriveWorkingTreeStateComponent(listing),
    };
  }
  return deriveTestStageIdentity({
    session: live,
    task: liveTask,
    settings: liveContext.settings,
    suiteBindingDigest: liveContext.suiteBindingDigest,
    cwd: input.cwd,
    head,
    listing,
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** Whether the shipped host-failure classification reads the run's nonzero exit as the host's. */
export function testRunHostFailure(run: TestFileRunResult | undefined, suiteKey: string): boolean {
  if (run === undefined || run.processResult !== "failed") return false;
  const last = run.steps[run.steps.length - 1];
  return stageCheckHostFailure(
    classifyCheckExecution(suiteKey, { exitCode: last?.exitCode ?? 1, stdout: run.outputTail ?? "" }),
  );
}

export interface Stage1SelectionAndRun {
  readonly selection: Stage1TestSelection;
  readonly plan: TestStagePlanKind;
  readonly run?: TestFileRunResult;
  /** The setup's and discovery's own cleanup: a process of either nobody saw end is §3 R1. */
  readonly discoveryTermination: TestRunTermination;
  /** Why a planned run could not launch (the suite command cannot take the adapter's arguments). */
  readonly launchRefusal?: string;
  /**
   * The runnable-file report is unread only because the launch identity is
   * unattested and discovery was not launched; every other input was readable.
   * The run is §3 R4 `identity-unknown`, not an R2 unavailable input.
   */
  readonly launchUnattested?: true;
}

/**
 * §6 rule 3 for the commands Stage 1 launches before any selected file: a
 * setup or discovery that did not succeed decides the run as its known process
 * outcome — a deadline, a nonzero exit or a spawn failure — so the unread report
 * it leaves behind is never an R2 input to re-run. `undefined` when both ended
 * on their own with exit 0, or discovery never launched.
 *
 * A failed setup whose discovery then ended on its own keeps the setup's exit as
 * the process result, exactly as {@link runTestFiles} does for a failed setup.
 * The request only labels the assembly: no file list is ever sent.
 */
function stage1PreTestRun(
  setup: TestSuiteSetupResult,
  discovery: TestFileRunStepObservation | undefined,
): TestFileRunResult | undefined {
  if (discovery === undefined) return undefined;
  const discoveryEnded = testFileStepAbnormalEnd(discovery) === undefined;
  if (setup.succeeded && discoveryEnded && discovery.exitCode === 0) return undefined;
  const steps = !setup.succeeded && discoveryEnded ? setup.steps : [...setup.steps, discovery];
  return assembleTestFileRun({ request: { mode: "files", files: [] }, steps });
}

interface SelectAndRunStage1Input {
  readonly runner: CommandRunner;
  /** The parsed `dependencyBase` the Issue base resolves against (§4.1 rule 1). */
  readonly dependencyBase: ReturnType<typeof resolveDependencyReviewBase>;
  readonly state: StagedVerificationState | undefined;
  readonly slotCommand: string;
  readonly binding: ResolvedTestSuiteBinding;
  readonly cwd: string;
  readonly baseBranch: string;
  /** False when the launch identity is unattested: nothing is executed (§3 R4). */
  readonly execute: boolean;
  readonly options: Omit<TestFileCommandOptions, "cwd" | "suiteCommand" | "binding">;
}

/** §4: base → cumulative change → setup → runnable-file report → retained set, then the selected files. */
function selectAndRunStage1(input: SelectAndRunStage1Input): Stage1SelectionAndRun {
  const { runner, cwd } = input;
  const options: TestFileCommandOptions = {
    ...input.options,
    cwd,
    suiteCommand: input.slotCommand,
    binding: input.binding,
  };
  const issueBase = resolveIssueBase({
    ...(input.state?.issueBase !== undefined ? { recorded: input.state.issueBase } : {}),
    dependencyBase: input.dependencyBase,
    readBranchStart: () => readIssueBranchStart(runner, { cwd, baseBranch: input.baseBranch }),
  });
  const change: CumulativeChangeRead = issueBase.status === "resolved"
    ? readCumulativeChange(runner, { cwd, base: issueBase.base.sha })
    : { kind: "unreadable", reason: "the Issue base is unavailable" };
  // Discovery launches the suite's own tooling, so an unattested launch
  // identity (§3 R4) runs it no more than it runs the selected files. The
  // runnable-file report then stays unread by choice, not as an R2 input.
  let inventory: TestFileInventoryRead = {
    kind: "unreadable",
    reason: input.execute
      ? "not read: an earlier selection input is unavailable"
      : "not read: the launch identity is unattested, so discovery was not launched",
  };
  let discoveryTermination: TestRunTermination = "confirmed";
  let launchRefusal: string | undefined;
  let setup: TestSuiteSetupResult | undefined;
  let discoveryStep: TestFileRunStepObservation | undefined;
  if (input.execute && issueBase.status === "resolved" && change.kind === "readable") {
    try {
      // The binding's setup may build or generate what discovery reads, so it
      // runs first, once: the selected run reuses it instead of launching it
      // again. A setup whose processes nobody saw end launches nothing more
      // (§3 R1). A setup that ended with a failure still lets discovery try,
      // so a broken build over selected files is the run's known nonzero
      // process result (§3 R6/R7) rather than an unreadable input to re-run.
      setup = runTestSuiteSetup(runner, options);
      discoveryTermination = setup.termination;
      if (setup.termination === "unconfirmed") {
        inventory = { kind: "unreadable", reason: "not read: the setup command's termination is unconfirmed" };
      } else {
        const discovered = discoverTestFiles(runner, options);
        inventory = discovered.inventory;
        discoveryTermination = discovered.termination;
        discoveryStep = discovered.observation;
      }
    } catch (err) {
      launchRefusal = errorMessage(err);
      inventory = { kind: "unreadable", reason: `discovery could not launch: ${launchRefusal}` };
    }
  }
  const retained = retainedTestFilesRead(input.state);
  let selection = selectStage1TestFiles({ issueBase, change, inventory, retained });
  if (
    !input.execute
    && selection.status === "unavailable"
    && selection.reason === "runnable-file-report"
    && retained.kind === "readable"
  ) {
    // Only the deliberately skipped report is unread: an unreadable base, change
    // or retained set is still R2, which precedes R4.
    return { selection, plan: "unavailable", discoveryTermination, launchUnattested: true };
  }
  let executionPlan = stage1ExecutionPlan(selection);
  if (setup !== undefined && !setup.succeeded && (executionPlan.kind === "empty" || executionPlan.kind === "retained-unresolved")) {
    // A report read without the setup it depends on may omit generated test
    // files, so it establishes neither an empty selection nor an unrunnable
    // retained file.
    selection = selectStage1TestFiles({
      issueBase,
      change,
      inventory: { kind: "unreadable", reason: "the suite setup command did not succeed, so the runnable-file report is not trusted" },
      retained,
    });
    executionPlan = stage1ExecutionPlan(selection);
  }
  if (
    setup !== undefined
    && discoveryTermination === "confirmed"
    && selection.status === "unavailable"
    && selection.reason === "runnable-file-report"
    && retained.kind === "readable"
  ) {
    // Only the report is unread, and the process outcome that left it unread
    // is known: it decides the run (§3 R6–R9) before the report could be R2.
    const preTestRun = stage1PreTestRun(setup, discoveryStep);
    if (preTestRun !== undefined) {
      return { selection, plan: "execute", run: preTestRun, discoveryTermination };
    }
  }
  if (executionPlan.kind !== "execute" || !input.execute || discoveryTermination === "unconfirmed") {
    return {
      selection,
      plan: executionPlan.kind,
      discoveryTermination,
      ...(launchRefusal !== undefined ? { launchRefusal } : {}),
    };
  }
  try {
    return {
      selection,
      plan: "execute",
      run: runTestFiles(runner, executionPlan.request, options, setup),
      discoveryTermination,
    };
  } catch (err) {
    return { selection, plan: "unavailable", discoveryTermination, launchRefusal: errorMessage(err) };
  }
}

/** The selection a Stage 1 record carries for what was selected and whether it could launch. */
function stage1SelectionRecord(outcome: Stage1SelectionAndRun): TestStageSelectionRecord {
  const { selection } = outcome;
  if (outcome.launchUnattested === true && selection.status === "unavailable") {
    return {
      status: "unavailable",
      reason: STAGE1_SELECTION_NOT_READ_UNATTESTED,
      ...(selection.issueBase !== undefined ? { issueBase: selection.issueBase } : {}),
    };
  }
  if (selection.status === "unavailable") {
    return {
      status: "unavailable",
      reason: selection.reason,
      ...(selection.issueBase !== undefined ? { issueBase: selection.issueBase } : {}),
    };
  }
  if (outcome.plan === "unavailable") {
    return { status: "unavailable", reason: "suite-command-refused", issueBase: selection.issueBase };
  }
  return selection;
}

/** The legacy bundle outcome a test-stage bundle carries beside its test result. */
export function testStageBundleOutcome(result: TestStageResult): StageOutcome {
  switch (result) {
    case "passed":
    case "empty":
      return "passed";
    case "failed":
      return "code-failed";
    case "timed-out":
      return "timed-out";
    case "infrastructure":
      return "infrastructure";
    default:
      return "unknown";
  }
}

function closeAllocation(state: StagedVerificationState, stageRunId: StageRunId, now: string): StagedVerificationState {
  const key = stageRunKey(stageRunId);
  return {
    ...state,
    runs: state.runs.map((entry) =>
      stageRunKey(entry.stageRunId) === key && entry.state === "allocated"
        ? { ...entry, state: "interrupted" as const, interruptedAt: now }
        : entry,
    ),
  };
}

// ---------------------------------------------------------------------------
// Stage 1
// ---------------------------------------------------------------------------

/**
 * The explicit "this run resolved a dependency plan and it names no predecessor"
 * value for {@link RunStage1TestsInput.dependencyBase} (issue #1165 review, P1).
 *
 * It reads exactly like a task that was never dependency-started — the same
 * `resolveDependencyReviewBase` answer — so a task with a recorded
 * `dependency-base` reports `issue_base_changed` here instead of passing Stage 1
 * against a predecessor the same run's completion is about to erase.
 */
export const NO_DEPENDENCY_BASE = null;

export interface RunStage1TestsInput {
  readonly runner: CommandRunner;
  readonly session: TestStageSession;
  readonly task: AiTask;
  /** The lane's worktree, at the revision under test. */
  readonly cwd: string;
  readonly lane: VerificationLane;
  readonly taskAttempt: number;
  readonly runId: string;
  /** The session base branch, read for the branch start only when no Issue base is recorded. */
  readonly baseBranch: string;
  /**
   * The `dependencyBase` THIS run resolved, for the selection to read instead of
   * the one the stored task still carries (issue #1165 D5).
   *
   * The implementation lane resolves the predecessor head — and the acceptance
   * of that exact commit — while it materializes the branch, and persists it
   * only in its final completion. Stage 1 runs in between, over a worktree that
   * already contains the new predecessor commits, so reading the stored
   * `dependencyBase` would select against the base the run has already left:
   * an inherited predecessor test would count as this Issue's change, and a
   * failure in it would repeat forever, since the run exits before the accepted
   * head is ever persisted. A lane with no base of its own passes nothing and
   * the stored one is used, exactly as before.
   *
   * Never an acceptance by itself: it is parsed by the same
   * `resolveDependencyReviewBase` as the stored value, so an unattested head
   * advances no base — it makes the selection `unavailable` instead (§4.1 rule 1).
   *
   * {@link NO_DEPENDENCY_BASE} is the third answer, and is not the same as
   * omitting the field (issue #1165 review, P1): a lane that resolved a plan
   * and found no open blocker states that outcome, exactly as its completion
   * writes it back. Omitting it there would select against the stored
   * predecessor the completion is about to clear — a base that would pass here
   * and then be unresolvable for every later run.
   */
  readonly dependencyBase?: unknown;
  readonly artifactDir?: string;
  readonly logPrefix?: string;
  /** The lane's per-command deadline, when it bounds commands. */
  readonly commandTimeoutMs?: number;
  /** The durable store: the allocation commits before launch and the record right after the run. */
  readonly store?: StagedVerificationStore;
  readonly readLiveSession?: () => Promise<TestStageSession | undefined>;
  readonly now?: () => string;
}

export interface Stage1TestRun {
  readonly classification: TestStageClassification;
  readonly route: Stage1TestRoute;
  /** The recorded test-stage record; absent when nothing was recorded. */
  readonly record?: TestStageRecord;
  readonly bundle?: StageRunResult;
  /**
   * The `stagedVerification` block this run left, for the lane's completion to
   * carry: a delayed release replaces the task context, and a lane without a
   * durable store has no other path to persist it.
   */
  readonly contextPatch: Record<string, unknown>;
  /** Bounded fix input or handoff text. Never describes Stage 1 as a suite pass. */
  readonly detail: string;
}

/** A Stage 1 outcome as the lane's shipped {@link VerificationFailure}, named for the suite entry. */
export function stage1VerificationFailure(run: Stage1TestRun, suiteKey: string): VerificationFailure {
  return { name: suiteKey, exitCode: 1, output: run.detail };
}

/**
 * A lane with no durable store keeps Stage 1's allocation, result and Issue base
 * only in {@link Stage1TestRun.contextPatch} (`PhaseHandlerContext.taskStore`),
 * so every completion after the run carries it, not just the exits that spread
 * it themselves (issue #1154 review, P2). A result that already holds a newer
 * state than the task was claimed with — a final stage's record — keeps it; one
 * that holds nothing or the claimed state takes the patch. A delayed release
 * replaces the task context, so one without a context carries the claimed one.
 */
export function withStage1ContextPatch(
  task: AiTask,
  result: PhaseHandlerResult,
  patch: Record<string, unknown>,
): PhaseHandlerResult {
  if (!(STAGED_VERIFICATION_CONTEXT_KEY in patch)) return result;
  const claimed = (task.context as Record<string, unknown> | undefined)?.[STAGED_VERIFICATION_CONTEXT_KEY];
  const carried = result.context?.[STAGED_VERIFICATION_CONTEXT_KEY];
  if (carried !== undefined && carried !== claimed) return result;
  const base = result.context ?? (result.result === "delayed" ? { ...task.context } : {});
  return { ...result, context: { ...base, ...patch } } as PhaseHandlerResult;
}

function unrecordedStage1(
  result: TestStageResult,
  detail: string,
  contextPatch: Record<string, unknown> = {},
): Stage1TestRun {
  const classification: TestStageClassification = { kind: "result", result };
  return { classification, route: routeStage1TestResult(classification), contextPatch, detail };
}

/**
 * Run Stage 1 in one lane (§4.2, §5): allocate, select, execute the selected
 * files (never an empty list, never the full suite), re-attest the identity and
 * record exactly one §3 result.
 *
 * - An allocated run that never recorded a result parks before anything
 *   launches (§5 rule 3), and the parking completion closes it.
 * - A launch identity that cannot be attested executes nothing (§3 R4).
 * - A complete run whose selected files are all skipped executed no test, so it
 *   records `empty` and continues to review and a mandatory Stage 2 without
 *   ever claiming a pass (decision D6).
 * - A selection whose dependency flow advanced the Issue base to an accepted
 *   predecessor head records that advance, which the completion applies while
 *   invalidating the stage and review evidence of the old base (decision D5).
 */
export async function runStage1TestVerification(input: RunStage1TestsInput): Promise<Stage1TestRun> {
  const { runner, cwd } = input;
  const now = () => input.now?.() ?? new Date().toISOString();
  const key = { sessionId: input.task.sessionId, issueNumber: input.task.issueNumber };
  const baseTask = input.store !== undefined ? await input.store.getTask(key) : input.task;
  if (!baseTask) return unrecordedStage1("unavailable", "Stage 1 could not read the task from the store.");
  const context = resolveTestStageContext({ session: input.session, task: baseTask });
  if (context.status !== "ready") {
    return unrecordedStage1(
      "unavailable",
      context.status === "plan-unresolvable"
        ? `Stage 1 has no effective verification plan to resolve the test suite from (${context.detail}).`
        : "Stage 1 has no test suite binding.",
    );
  }
  const suiteKey = context.binding.key;
  const stored = validateStagedVerificationState(baseTask.context?.[STAGED_VERIFICATION_CONTEXT_KEY]);
  if (!stored.valid) {
    return unrecordedStage1("unavailable", `Stage 1 cannot read the Issue's retained test files: ${stored.detail}`);
  }
  const guard = openStageRunGuard(stored.state, now());
  if (guard.kind === "park") {
    return unrecordedStage1(
      "termination-unknown",
      `Stage run ${guard.stageRunKey} (allocated ${guard.allocatedAt}) recorded no result, and nothing recorded proves `
        + "its processes ended; parking instead of launching overlapping test work (termination-unknown).",
      { [STAGED_VERIFICATION_CONTEXT_KEY]: guard.closedState },
    );
  }
  // §3 R2: a plan that is unbound as the stage launches — the bound slot retired,
  // or another active slot duplicating its command — is a launch-time refusal.
  // It is allocated and recorded `unavailable` like any other R2 input, and
  // nothing launches.
  const suite = context.suite;

  const head = resolveHead(runner, cwd);
  const listing = readWorkingTreeListing(runner, cwd);
  const identity = deriveTestStageIdentity({
    session: input.session,
    task: baseTask,
    settings: context.settings,
    suiteBindingDigest: context.suiteBindingDigest,
    cwd,
    head,
    listing,
  });
  const cursor = stored.state?.ordinals.find(
    (entry) => entry.taskAttempt === input.taskAttempt && entry.lane === input.lane && entry.stage === "loop",
  );
  const allocated = await allocateStageRun({
    store: input.store ?? contextOnlyStagedVerificationStore(baseTask).store,
    key,
    observedTaskRevision: baseTask.revision,
    requestKey: `${input.runId}:${input.lane}:loop:${input.taskAttempt}:${(cursor?.lastOrdinal ?? -1) + 1}`,
    taskAttempt: input.taskAttempt,
    lane: input.lane,
    stage: "loop",
    identity,
    runId: input.runId,
    now: now(),
  });
  if (allocated.status !== "allocated") {
    return unrecordedStage1(
      "unavailable",
      `Stage 1 could not allocate its run (${allocated.status === "refused" ? `${allocated.reason}: ${allocated.detail}` : allocated.status}).`,
    );
  }
  const stageRunId = allocated.entry.stageRunId;
  const logPrefix = input.logPrefix ?? "verification";
  const startedAtMs = Date.now();
  const outcome: Stage1SelectionAndRun | undefined = suite.status === "bound"
    ? selectAndRunStage1({
        runner,
        // The lane's own resolved base wins over the stored one (D5): the run
        // that is incorporating a predecessor holds the accepted head before it
        // ever persists it. Parsed through the same reader either way, so an
        // unattested head still advances nothing — and `NO_DEPENDENCY_BASE`,
        // which is not `undefined`, states a resolved absence rather than
        // falling back to the stored value.
        dependencyBase: resolveDependencyReviewBase(
          input.dependencyBase !== undefined
            ? { dependencyBase: input.dependencyBase }
            : baseTask.context,
        ),
        state: allocated.state,
        slotCommand: suite.slot.command,
        binding: context.binding,
        cwd,
        baseBranch: input.baseBranch,
        execute: !testStageIdentityUnattested(identity),
        options: {
          ...(input.artifactDir !== undefined ? { artifactDir: input.artifactDir } : {}),
          artifactPrefix: `${logPrefix}-stage1-${input.lane}-${stageRunId.taskAttempt}-${stageRunId.stageOrdinal}`,
          ...(input.commandTimeoutMs !== undefined ? { timeoutMs: input.commandTimeoutMs } : {}),
        },
      })
    : undefined;
  const headAfter = resolveHead(runner, cwd);
  const listingAfter = readWorkingTreeListing(runner, cwd);
  const end = deriveTestStageIdentity({
    session: input.session,
    task: baseTask,
    settings: context.settings,
    suiteBindingDigest: context.suiteBindingDigest,
    cwd,
    head: headAfter,
    listing: listingAfter,
  });
  const recheck = await recheckTestStageIdentity(
    {
      session: input.session,
      task: baseTask,
      cwd,
      ...(input.store !== undefined ? { store: input.store } : {}),
      ...(input.readLiveSession !== undefined ? { readLiveSession: input.readLiveSession } : {}),
    },
    headAfter,
    listingAfter,
  );
  const classification: TestStageClassification = outcome?.discoveryTermination === "unconfirmed"
    ? { kind: "result", result: "termination-unknown" }
    : outcome?.launchUnattested === true
    ? { kind: "result", result: "identity-unknown" }
    : classifyTestStageResult({
        stage: "loop",
        plan: outcome?.plan ?? "unavailable",
        ...(outcome?.run !== undefined ? { run: outcome.run } : {}),
        identity: { launch: identity, end, recheck },
        hostFailure: testRunHostFailure(outcome?.run, suiteKey),
      });
  const route = routeStage1TestResult(classification);
  const result = classification.result;
  const record = buildTestStageRecord({
    result,
    suiteBindingDigest: context.suiteBindingDigest,
    selection: outcome !== undefined
      ? stage1SelectionRecord(outcome)
      : { status: "unavailable", reason: suite.status === "bound" ? "suite-command-refused" : suite.reason },
    ...(outcome?.run !== undefined && result !== "unavailable" ? { run: outcome.run } : {}),
  });
  const bundle: StageRunResultInput = {
    stageRunId,
    planDigest: context.plan.planDigest,
    ...(head !== undefined ? { headSha: head } : {}),
    selection: { checkIds: [], selectionDigest: deriveStageSelectionDigest([]), full: false },
    outcome: testStageBundleOutcome(result),
    complete: true,
    checks: [],
    identityRecheck: recheck,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    testFiles: record,
  };
  const shim = input.store === undefined ? contextOnlyStagedVerificationStore(allocated.task) : undefined;
  const latest = input.store !== undefined ? await input.store.getTask(key) : shim?.current();
  const recorded = await recordStageRun({
    store: input.store ?? (shim as { store: StagedVerificationStore }).store,
    key,
    observedTaskRevision: latest?.revision ?? allocated.task.revision,
    bundle,
    runId: input.runId,
    now: now(),
  });
  const unavailableSelection = outcome !== undefined && outcome.selection.status === "unavailable"
    ? outcome.selection
    : undefined;
  const refusalDetail = suite.status !== "bound"
    ? ` Stage 1 cannot run '${suiteKey}': ${suite.detail}.`
    : outcome?.launchRefusal !== undefined
    ? ` The suite command could not launch: ${outcome.launchRefusal}`
    : outcome?.launchUnattested === true
    ? `\nUnattested at launch: ${STAGE_IDENTITY_COMPONENTS.filter((name) => identity[name]?.state === "unknown").join(", ")}.`
    // Issue #1174: the record keeps only the unavailable input's name, so the
    // reason — an adapter's refusal of an unsupported configuration — rides here.
    : unavailableSelection !== undefined
    ? `\nWhy the ${unavailableSelection.reason} is unavailable: ${unavailableSelection.detail}`
    : "";
  if (recorded.status !== "recorded") {
    return {
      classification,
      route: "park",
      record,
      contextPatch: { [STAGED_VERIFICATION_CONTEXT_KEY]: closeAllocation(allocated.state, stageRunId, now()) },
      detail:
        `Stage 1 of '${suiteKey}' recorded \`${result}\` but the record was refused `
        + `(${recorded.status === "refused" ? `${recorded.reason}: ${recorded.detail}` : recorded.status}).`,
    };
  }
  return {
    classification,
    route,
    record,
    bundle: recorded.bundle,
    // The write's own patch, not just its state: a D5 advance also evicts the
    // pending review approval, and a lane with no durable store persists this
    // patch as its completion context — half an advance is not an advance.
    contextPatch: { ...recorded.contextPatch },
    detail: `${describeTestStageRecord(record, "loop", suiteKey)}${refusalDetail}`,
  };
}

// ---------------------------------------------------------------------------
// Stage 2
// ---------------------------------------------------------------------------

export interface Stage2TestExecution {
  readonly plan: Extract<TestStagePlanKind, "execute" | "unavailable">;
  readonly run?: TestFileRunResult;
  /** The runnable-file report could not be read (§3 R2 for Stage 2). */
  readonly inventoryUnreadable: boolean;
  readonly detail?: string;
}

/**
 * Stage 2's test half: the bound suite command in `full` mode through the
 * adapter (§6 rule 1). A suite command that cannot take the adapter's arguments
 * launches nothing and is `unavailable`; a discovery that exited 0 with an
 * unreadable report is `unavailable` too, never a run that passed.
 */
export function runStage2Tests(input: {
  readonly runner: CommandRunner;
  readonly context: ReadyTestStageContext;
  readonly cwd: string;
  readonly artifactDir?: string;
  readonly artifactPrefix: string;
  readonly commandTimeoutMs?: number;
}): Stage2TestExecution {
  if (input.context.suite.status !== "bound") {
    return { plan: "unavailable", inventoryUnreadable: false, detail: input.context.suite.detail };
  }
  let run: TestFileRunResult;
  try {
    run = runTestFiles(input.runner, { mode: "full" }, {
      cwd: input.cwd,
      suiteCommand: input.context.suite.slot.command,
      binding: input.context.binding,
      ...(input.artifactDir !== undefined ? { artifactDir: input.artifactDir } : {}),
      artifactPrefix: input.artifactPrefix,
      ...(input.commandTimeoutMs !== undefined ? { timeoutMs: input.commandTimeoutMs } : {}),
    });
  } catch (err) {
    return { plan: "unavailable", inventoryUnreadable: false, detail: errorMessage(err) };
  }
  const last = run.steps[run.steps.length - 1];
  const inventoryUnreadable =
    run.termination === "confirmed"
    && last?.step === "discovery"
    && run.processResult === "succeeded"
    && run.trust.status === "untrusted"
    && run.trust.reason === "unreadable-result";
  return inventoryUnreadable
    ? { plan: "unavailable", run, inventoryUnreadable: true, detail: run.trust.status === "untrusted" ? run.trust.detail : undefined }
    : { plan: "execute", run, inventoryUnreadable: false };
}
