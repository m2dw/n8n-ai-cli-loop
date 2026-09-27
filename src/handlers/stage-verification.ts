/**
 * Staged verification, lane side: resolving a `loop` stage run and recording
 * what it proved (issue #1102 — `docs/staged-verification-contract.md` §13
 * slices S3 and S7, over the pure modules #1097–#1101 shipped).
 *
 * The split this module keeps is the contract's own: every *decision* lives in
 * core and every *effect* lives here. It resolves the effective plan, runs the
 * required checks with the lane's own `CommandRunner`, and writes the bundle
 * artifact. It decides nothing: the required set is `requiredStageSelection`'s,
 * the verdicts are `buildCheckExecutionRecord`'s (#1098), the outcome is
 * `aggregateStageOutcome`'s and the requirement layer's verdicts are
 * `deriveStageRequirementRecords`'s (#1102 core).
 *
 * **Issue #1155 retired the group-selection policy this module used to drive.**
 * There is no selection port, no change descriptor, no selection adapter, no
 * five-set union and no `selectable` / `finalOnly` membership: a stage runs the
 * **entire required set** of non-test checks. The only entry that ever leaves
 * it is the bound test suite, which Stage 1 and Stage 2 replace
 * (`docs/changed-file-verification-contract.md` §6 rule 2).
 *
 * Two postures worth stating once:
 *
 * - **Fail open to today, never to less.** Every way resolving a stage can go
 *   wrong — the feature off, a plan that will not resolve, a session whose
 *   `stagedVerification` block cannot be read — returns
 *   {@link StageVerificationUnavailable}, and the lane then runs the shipped
 *   full `session.verification` pass it would have run anyway. Nothing narrows
 *   a run, so no failure mode can narrow one either.
 * - **The stage is not the router.** This slice records what a loop stage
 *   proved; the lane keeps routing on the shipped `VerificationOutcome` and the
 *   shipped #934 classification. §7 rows 1–6 derive nothing new here.
 *
 * The `final` stage (issue #1103, slices S9/S10) is the exception to the second
 * posture, because it is the one place a stage decides something the lane did
 * not already decide: {@link runFinalStageVerification} runs the entire required
 * set at the approved review head and returns the §7 row 7–13 route plus the
 * context patch — the recorded bundle and, on row 7 only, the grant declaration —
 * that the review completion commits in ONE transaction with its label effects.
 */

import { createHash } from "crypto";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "fs";
import { join } from "path";

import type { CommandRunner } from "./command-runner.js";
import { readCurrentPrepareStamp } from "./environment-prepare.js";
import {
  runVerification,
  type StageExecutionCheck,
  type StageVerificationExecution,
  type VerificationOutcome,
} from "./verification.js";
import { extractIssueVerificationCommands } from "./issue-verification-extractor.js";
import type { AiTask } from "../core/task.js";
import type { ResolvedSession } from "../core/session.js";
import {
  resolveStagedVerificationSettings,
  type ResolvedStagedVerificationSettings,
} from "../core/staged-verification-config.js";
import {
  buildStageRunResultInput,
  requiredSlotsByCheckId,
  requiredStageSelection,
  summarizeStageRun,
  type RequiredStageSelection,
  type StageCheckOutcome,
  type StageRunAssembly,
  type StageRunSummary,
} from "../core/stage-run.js";
import { buildCheckExecutionRecord, isExecutionCheckId } from "../core/verification-result.js";
import {
  resolveTestStageContext,
  runStage2Tests,
  testRunHostFailure,
  type ReadyTestStageContext,
  type Stage2TestExecution,
} from "./test-stage-verification.js";
import {
  classifyTestStageResult,
  describeTestStageRecord,
  fullSuiteRequirementDeclaration,
  openStageRunGuard,
  routeStage2TestResult,
} from "../core/test-stage-routing.js";
import { matchesConfiguredVerificationCommand } from "../core/tool-request-continuation.js";
import { buildTestStageRecord, type TestStageRecord, type TestStageResult } from "../core/changed-test-file-selection.js";
import { stageEvidenceIdentityMatches } from "../core/stage-evidence-validity.js";
import {
  allocateStageRun,
  deriveStageSelectionDigest,
  pendingStageRunInterruption,
  recordStageRun,
  stageRunKey,
  unknownIdentityComponent,
  validateStagedVerificationState,
  STAGED_VERIFICATION_CONTEXT_KEY,
  STAGE_IDENTITY_COMPONENTS,
  type StageEvidenceIdentity,
  type StageId,
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
  deriveTestSuitePolicyComponent,
  deriveWorkingTreeStateComponent,
  evaluateFinalGrantBinding,
  evaluateFinalStageReuse,
  finalStageWorktreeIsClean,
  type StageEvidenceRefusal,
  type WorkingTreeEntry,
  type WorkingTreeEntryContent,
  type WorkingTreeListing,
} from "../core/stage-evidence-validity.js";
import {
  FINAL_STAGE_APPROVAL_CONTEXT_KEY,
  FINAL_STAGE_GRANT_CONTEXT_KEY,
  FINAL_STAGE_VERIFICATION_CONTEXT_KEY,
  routeFinalStageBundle,
  type FinalStageDisposition,
  type FinalStageGrantMarker,
  type FinalStageRoute,
} from "../core/final-stage-gate.js";
import {
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  validateVerificationAmendmentState,
} from "../core/verification-amendment.js";
import { normalizeCommitSha } from "../core/verification-evidence.js";
import {
  buildVerificationSessionBaseline,
  executionSatisfiesRequirement,
  reconcileVerificationPlan,
  type EffectiveRequirementEvidenceExpectations,
  type EffectiveVerificationPlan,
  type EffectiveVerificationSlot,
  type FullSuiteRequirementDeclaration,
  type ManualVerificationEvidenceLike,
} from "../core/verification-plan.js";

// ---------------------------------------------------------------------------
// Resolving the stage
// ---------------------------------------------------------------------------

/** Why a lane ran the shipped full pass instead of a stage. Recorded, never parsed. */
export type StageVerificationUnavailableReason =
  /** §10 rule 1: `stagedVerification.enabled` absent or false — today's behavior. */
  | "disabled"
  /** The effective plan could not be resolved or reconciled; the lane's own gates own that. */
  | "plan-unresolvable"
  /** The resolved plan has no active execution slot for the stage to run. */
  | "no-execution-checks";

export interface StageVerificationUnavailable {
  readonly status: "unavailable";
  readonly reason: StageVerificationUnavailableReason;
  readonly detail?: string;
}

export interface StageVerificationReady {
  readonly status: "ready";
  readonly plan: EffectiveVerificationPlan;
  readonly settings: ResolvedStagedVerificationSettings;
}

export type StageVerificationContext = StageVerificationReady | StageVerificationUnavailable;

/**
 * Resolve the plan a stage would run over, or say why this lane has no stage.
 *
 * The plan is the RECONCILED one, for the reason the review gate reconciles
 * (issue #1043): structural validation never recomputes the stored checkpoint
 * digest, so a chain written outside the amendment surfaces would read as
 * resolvable while its replace/retire operations suppress required checks. A
 * plan that will not reconcile is not a plan a stage may narrow against, so the
 * stage steps aside and the lane runs the full configured set.
 */
export function resolveStageVerificationContext(input: {
  readonly session: Pick<ResolvedSession, "verification" | "stagedVerification">;
  readonly task: Pick<AiTask, "context">;
}): StageVerificationContext {
  const resolved = resolveStageVerificationPlan(input);
  if (resolved.status === "ready" && !resolved.plan.execution.some((slot) => slot.state === "active")) {
    return { status: "unavailable", reason: "no-execution-checks" };
  }
  return resolved;
}

/**
 * {@link resolveStageVerificationContext} without the active-slot requirement.
 * Issue #1154 (`docs/changed-file-verification-contract.md` §6 rule 1): a
 * suite binding whose bound slot was the plan's only execution slot and is
 * retired still has a stage — one that records `unavailable` — so the test
 * stages resolve their suite from the reconciled plan even when nothing in it
 * is active.
 */
export function resolveStageVerificationPlan(input: {
  readonly session: Pick<ResolvedSession, "verification" | "stagedVerification">;
  readonly task: Pick<AiTask, "context">;
}): StageVerificationContext {
  const settings = resolveStagedVerificationSettings(input.session.stagedVerification);
  if (!settings.enabled) return { status: "unavailable", reason: "disabled" };
  const ctx = (input.task.context ?? {}) as Record<string, unknown>;
  const body = typeof ctx.body === "string" ? ctx.body : "";
  const reconciliation = reconcileVerificationPlan({
    sessionVerification: input.session.verification,
    issueRequirements: body ? extractIssueVerificationCommands(body) : [],
    amendments: ctx[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  });
  if (reconciliation.status === "invalid" || reconciliation.status === "unreconciled") {
    return {
      status: "unavailable",
      reason: "plan-unresolvable",
      detail: reconciliation.status === "invalid" ? reconciliation.reason : "unreconciled",
    };
  }
  return { status: "ready", plan: reconciliation.plan, settings };
}

// ---------------------------------------------------------------------------
// The execution input (issue #1155: the entire required set)
// ---------------------------------------------------------------------------

/**
 * The stage's checks and the execution input they produce.
 *
 * Issue #1155 retired the selection port, the five-set union and the
 * `selectable` / `finalOnly` membership outright, so there is nothing to ask
 * and nothing to compute: a stage runs the **entire required set**
 * ({@link requiredStageSelection}). The one thing that ever leaves it is the
 * bound test suite entry, which the changed-file stages replace
 * (`docs/changed-file-verification-contract.md` §6 rule 2).
 */
export interface ResolvedStageSelection {
  readonly outcome: RequiredStageSelection;
  /** The execution-layer half of the required set, ready for {@link runVerification}. */
  readonly execution: StageVerificationExecution;
}

export function resolveStageSelection(plan: EffectiveVerificationPlan): ResolvedStageSelection {
  const outcome = requiredStageSelection(plan);
  return { outcome, execution: stageExecutionInput(plan, outcome) };
}

/** The required EXECUTION checks, in plan order, with the plan's own command bytes. */
export function stageExecutionInput(
  plan: EffectiveVerificationPlan,
  selection: RequiredStageSelection,
): StageVerificationExecution {
  const slots = requiredSlotsByCheckId(plan);
  const checks: StageExecutionCheck[] = [];
  for (const check of selection.checks) {
    if (!isExecutionCheckId(check.checkId)) continue;
    const slot = slots.get(check.checkId);
    if (slot === undefined || slot.name === undefined) continue;
    checks.push({ checkId: check.checkId, name: slot.name, command: slot.command });
  }
  return { checks };
}

// ---------------------------------------------------------------------------
// Recording the run
// ---------------------------------------------------------------------------

/**
 * The bundle artifact (§10 rule 4: "Stage bundles are new files alongside
 * them, never replacements").
 *
 * The identity (#1096 §4.2) and both timestamps are deliberately absent: they
 * are stamped by `recordStageRun` from the allocation the store slice owns, and
 * inventing them here would put an unattested identity on evidence. What this
 * file holds is exactly the caller-supplied half of the bundle —
 * `StageRunResultInput` — which is what that write consumes unchanged.
 */
export function stageBundleArtifactName(
  logPrefix: string,
  stage: StageId,
  ordinal: number,
): string {
  return `${logPrefix}-stage-${stage}-${ordinal}.json`;
}

export interface FinalizeStageRunInput {
  readonly stageRunId: StageRunId;
  readonly plan: EffectiveVerificationPlan;
  readonly selection: RequiredStageSelection;
  readonly stageChecks: readonly StageCheckOutcome[];
  readonly runCompleted: boolean;
  /** #1040 operator attestations, admitted only under `evidenceExpectations`' binding. */
  readonly manualEvidence?: readonly ManualVerificationEvidenceLike[];
  readonly evidenceExpectations?: EffectiveRequirementEvidenceExpectations;
  /** Issue #1166: the operator's declared alias for the bound test suite entry. */
  readonly fullSuite?: FullSuiteRequirementDeclaration;
  readonly headSha?: string;
  readonly durationMs?: number;
  readonly artifactDir?: string;
  readonly logPrefix?: string;
}

/**
 * Assemble the bundle for one stage run and write its artifact.
 *
 * Assembly is core's; this only decides where the bytes land. A write failure
 * is swallowed on purpose: an artifact this slice writes is evidence *for an
 * operator*, and losing it must not turn a verified run into a failed phase —
 * the durable record is the store write a later slice owns.
 */
export function finalizeStageRun(input: FinalizeStageRunInput): StageRunAssembly {
  const assembly = buildStageRunResultInput({
    stageRunId: input.stageRunId,
    plan: input.plan,
    selection: input.selection.selection,
    selected: input.selection.checks,
    executionChecks: input.stageChecks,
    runCompleted: input.runCompleted,
    ...(input.manualEvidence !== undefined ? { manualEvidence: input.manualEvidence } : {}),
    ...(input.evidenceExpectations !== undefined
      ? { evidenceExpectations: input.evidenceExpectations }
      : {}),
    ...(input.fullSuite !== undefined ? { fullSuite: input.fullSuite } : {}),
    ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  });
  if (input.artifactDir) {
    writeStageBundleArtifact(input.artifactDir, input.logPrefix ?? "verification", assembly.bundle);
  }
  return assembly;
}

/**
 * Write one stage bundle to its artifact. A write failure is swallowed for the
 * reason {@link finalizeStageRun} gives: evidence for an operator, never a
 * phase outcome.
 */
function writeStageBundleArtifact(artifactDir: string, logPrefix: string, bundle: StageRunResultInput): void {
  try {
    writeFileSync(
      join(artifactDir, stageBundleArtifactName(logPrefix, bundle.stageRunId.stage, bundle.stageRunId.stageOrdinal)),
      JSON.stringify(bundle, null, 2),
      "utf8",
    );
  } catch {
    // See finalizeStageRun: evidence for an operator, never a phase outcome.
  }
}

// ---------------------------------------------------------------------------
// The one call a lane makes
// ---------------------------------------------------------------------------

export interface RunLoopStageInput {
  readonly runner: CommandRunner;
  readonly session: Pick<ResolvedSession, "verification" | "stagedVerification">;
  readonly task: Pick<AiTask, "context">;
  readonly cwd: string;
  readonly lane: VerificationLane;
  readonly taskAttempt: number;
  /** #1094 §2: starts at 0 per attempt, lane and stage. */
  readonly stageOrdinal: number;
  readonly artifactDir?: string;
  readonly logPrefix?: string;
  /**
   * Issue #1154 (`docs/changed-file-verification-contract.md` §6 rules 1–2):
   * the execution slots a test stage replaces in this lane — the bound suite
   * entry and any duplicate of it. They leave the selection after it is
   * computed, together with every requirement check they would satisfy, so the
   * remaining non-test checks keep the shipped loop selection and the suite
   * never runs here.
   */
  readonly replacedByTestStage?: (slot: Pick<EffectiveVerificationSlot, "name" | "command">) => boolean;
}

/**
 * Drop the checks a test stage replaces from the required set (issue #1154).
 *
 * The required set is filtered, not the plan: the suite stays a slot of the
 * plan and keeps its requirement closure — it is simply run by Stage 1 / Stage
 * 2 instead of here. A requirement the suite satisfies gates as the suite
 * (§6 rule 2), so it leaves with it.
 */
function withoutTestStageChecks(
  plan: EffectiveVerificationPlan,
  outcome: RequiredStageSelection,
  replaced: (slot: Pick<EffectiveVerificationSlot, "name" | "command">) => boolean,
  fullSuite?: FullSuiteRequirementDeclaration,
): RequiredStageSelection {
  const replacedExecution = plan.execution.filter((slot) => slot.state === "active" && replaced(slot));
  // The slots that answer "is this requirement the suite's?": every entry this
  // stage replaces, whatever its state. An amendment may have RETIRED the bound
  // slot (`docs/changed-file-verification-contract.md` §6 rule 5, the
  // retired-slot path) — alone, or in the same revision that gave another slot
  // a declared command. The suite is still what discharges its requirements,
  // and the stages record `unavailable` for it and hand off to the operator;
  // left in this selection, such a requirement would be classified
  // `evidence-lost` here and end the run before Stage 1 records that result.
  // Reading the retired slot unconditionally keeps that closure whether or not
  // an active replaced slot exists beside it. A retired slot is read for the
  // requirement closure only: it is never a selected check itself, because only
  // `replacedExecution` feeds `dropped` below.
  const suiteSlots = plan.execution.filter((slot) => replaced(slot));
  if (suiteSlots.length === 0) return outcome;
  const dropped = new Set(replacedExecution.map((slot) => slot.commandId));
  for (const slot of plan.requirement) {
    if (
      slot.state === "active"
      // Issue #1166: a requirement the operator declared the suite discharges
      // leaves the loop selection with the suite itself. Left in, it would sit
      // in every Stage 1 bundle as a requirement nothing this stage runs can
      // prove — which is exactly what only Stage 2 is allowed to prove (O4).
      && suiteSlots.some((suite) => executionSatisfiesRequirement(suite, slot.command, fullSuite))
    ) {
      dropped.add(slot.commandId);
    }
  }
  const checks = outcome.checks.filter((check) => !dropped.has(check.checkId));
  if (checks.length === outcome.checks.length) return outcome;
  const checkIds = checks.map((check) => check.checkId);
  return {
    ...outcome,
    selection: {
      ...outcome.selection,
      checkIds,
      selectionDigest: deriveStageSelectionDigest(checkIds),
      // The suite is part of the required set, so a selection without it is never the whole set.
      full: false,
    },
    checks,
  };
}

export interface LoopStageRun {
  /** What the lane routes on — the shipped outcome, unchanged in shape. */
  readonly verification: VerificationOutcome;
  /** Absent when no stage ran: the lane executed the shipped full pass. */
  readonly stage?: {
    readonly assembly: StageRunAssembly;
    readonly selection: RequiredStageSelection;
  };
  /** Present when no stage ran, saying why (recorded, never parsed). */
  readonly unavailable?: StageVerificationUnavailable;
}

/**
 * Run one `loop` stage in this lane, or — when no stage applies — the shipped
 * full `session.verification` pass.
 *
 * The returned {@link VerificationOutcome} is the shipped one in both cases, so
 * a lane's existing routing, repair loop and #934 classification consume it
 * unchanged. What a stage adds is the bundle beside it.
 */
export async function runLoopStageVerification(
  input: RunLoopStageInput,
): Promise<LoopStageRun> {
  const context = resolveStageVerificationContext({ session: input.session, task: input.task });
  const logPrefix = input.logPrefix ?? "verification";
  if (context.status === "unavailable") {
    // The shipped full pass, minus any entry a test stage replaces: the suite
    // never runs in full here, whatever the plan could not resolve.
    const replaced = input.replacedByTestStage;
    return {
      verification: runVerification(
        input.runner,
        replaced === undefined
          ? input.session.verification
          : Object.fromEntries(
              Object.entries(input.session.verification).filter(
                ([name, command]) => !replaced({ name, command }),
              ),
            ),
        input.cwd,
        input.artifactDir,
        logPrefix,
      ),
      unavailable: context,
    };
  }
  const resolvedSelection = resolveStageSelection(context.plan);
  // Issue #1166: the same declaration decides which requirement leaves the loop
  // selection with the suite and which one a bundle can credit to it.
  const fullSuite = fullSuiteRequirementDeclaration(input.session);
  const selectionOutcome = input.replacedByTestStage === undefined
    ? resolvedSelection.outcome
    : withoutTestStageChecks(context.plan, resolvedSelection.outcome, input.replacedByTestStage, fullSuite);
  const selection = selectionOutcome === resolvedSelection.outcome
    ? resolvedSelection
    : {
        ...resolvedSelection,
        outcome: selectionOutcome,
        execution: stageExecutionInput(context.plan, selectionOutcome),
      };
  const startedAtMs = Date.now();
  const verification = runVerification(
    input.runner,
    input.session.verification,
    input.cwd,
    input.artifactDir,
    logPrefix,
    {
      ...selection.execution,
      logSnapshotPrefix: stageBundleArtifactName(logPrefix, "loop", input.stageOrdinal).replace(
        /\.json$/,
        "",
      ),
    },
  );
  // #1040 manual evidence, admitted under the same binding the review gate
  // applies: the current plan and slot identity (checked in core against
  // `context.plan`) and the HEAD this run verified. The HEAD probe runs only
  // when there is evidence to bind, and an unresolvable HEAD stays absent so
  // every bound entry fails closed rather than passing unchecked.
  const ctx = (input.task.context ?? {}) as Record<string, unknown>;
  const rawManualEvidence = ctx.manualVerificationEvidence;
  const manualEvidence =
    Array.isArray(rawManualEvidence) && rawManualEvidence.length > 0
      ? (rawManualEvidence as ManualVerificationEvidenceLike[])
      : undefined;
  let evidenceExpectations: EffectiveRequirementEvidenceExpectations | undefined;
  if (manualEvidence !== undefined) {
    let headSha: string | undefined;
    try {
      const headProbe = input.runner.run("git", ["rev-parse", "HEAD"], { cwd: input.cwd });
      headSha = headProbe.exitCode === 0 ? normalizeCommitSha(headProbe.stdout) : undefined;
    } catch {
      headSha = undefined;
    }
    evidenceExpectations = headSha !== undefined ? { headSha } : {};
  }
  const assembly = finalizeStageRun({
    stageRunId: {
      taskAttempt: input.taskAttempt,
      lane: input.lane,
      stage: "loop",
      stageOrdinal: input.stageOrdinal,
    },
    plan: context.plan,
    selection: selection.outcome,
    stageChecks: verification.stageChecks ?? [],
    // The site returned, so the run itself completed: an absence here is an
    // integrity failure (`unknown`), not an interruption (§6.1).
    runCompleted: true,
    ...(manualEvidence !== undefined ? { manualEvidence } : {}),
    ...(evidenceExpectations !== undefined ? { evidenceExpectations } : {}),
    ...(fullSuite !== undefined ? { fullSuite } : {}),
    durationMs: Date.now() - startedAtMs,
    ...(input.artifactDir !== undefined ? { artifactDir: input.artifactDir } : {}),
    logPrefix,
  });
  return { verification, stage: { assembly, selection: selection.outcome } };
}

// ---------------------------------------------------------------------------
// The final stage (issue #1103 — §4.3, §4.4, §7 rows 7–13, §8)
// ---------------------------------------------------------------------------

/**
 * #1096 §4.5 rule 5's listing: the porcelain status of the stage worktree with
 * every listed path fingerprinted by its current bytes.
 *
 * A path that cannot be fingerprinted is `unreadable` with a fixed reason that
 * never names the path (#1096 §8 rule 10), which makes the component `unknown`
 * rather than silently skipping the path.
 */
export function readWorkingTreeListing(runner: CommandRunner, cwd: string): WorkingTreeListing {
  let result: { exitCode: number; stdout: string };
  try {
    result = runner.run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd });
  } catch {
    return { state: "unreadable", reason: "git status failed" };
  }
  if (result.exitCode !== 0) {
    return { state: "unreadable", reason: `git status exited ${result.exitCode}` };
  }
  const tokens = result.stdout.split("\0");
  const entries: WorkingTreeEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index++] as string;
    if (token.length < 4) continue;
    const statusCode = token.slice(0, 2);
    const path = token.slice(3);
    entries.push({ statusCode, path, content: fingerprintWorktreePath(cwd, path) });
    // Porcelain v1 `-z` pairs a rename or copy with a second, BARE
    // NUL-terminated field holding the source path; it is listed too.
    if (statusCode[0] === "R" || statusCode[0] === "C" || statusCode[1] === "R" || statusCode[1] === "C") {
      const oldPath = tokens[index++] ?? "";
      if (oldPath.length > 0) {
        entries.push({ statusCode, path: oldPath, content: fingerprintWorktreePath(cwd, oldPath) });
      }
    }
  }
  return { state: "listed", entries };
}

function fingerprintWorktreePath(cwd: string, path: string): WorkingTreeEntryContent {
  const absolute = join(cwd, path);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return {
        state: "fingerprint",
        fingerprint: createHash("sha256").update(readlinkSync(absolute)).digest("hex"),
      };
    }
    if (!stat.isFile()) return { state: "unreadable", reason: "not-a-regular-file" };
    return {
      state: "fingerprint",
      fingerprint: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: "unreadable" };
  }
}

function resolveHead(runner: CommandRunner, cwd: string): string | undefined {
  try {
    const probe = runner.run("git", ["rev-parse", "HEAD"], { cwd });
    return probe.exitCode === 0 ? normalizeCommitSha(probe.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commit a remote ref points at, read with `git ls-remote` (issue #1103
 * review, P1). `ref` must be fully qualified (`refs/heads/<branch>`,
 * `refs/pull/<n>/head`); only an exact ref match counts, so a pattern that also
 * matches a tag or another namespace never stands in for the PR head.
 */
export function readRemoteRefHead(
  runner: CommandRunner,
  cwd: string,
  remote: string,
  ref: string,
): string | undefined {
  try {
    const probe = runner.run("git", ["ls-remote", remote, ref], { cwd });
    if (probe.exitCode !== 0) return undefined;
    const matches = probe.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length === 2 && fields[1] === ref);
    return matches.length === 1 ? normalizeCommitSha(matches[0][0]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The head a final-stage grant binds to: the worktree head, confirmed against
 * the live PR head when the caller can read it. Only when both agree is that
 * head returned. When they disagree, a head other than `launchHead` is returned
 * — the moved worktree head, else the moved PR head — so the binding sees a
 * moved head whichever side changed (issue #1103 review, P2): the PR head never
 * stands in for a worktree head that moved under the run. An unreadable live
 * head is `undefined` (so `testedRevision` is `unknown` and matches nothing).
 */
function bindLivePrHead(
  input: RunFinalStageInput,
  localHead: string | undefined,
  launchHead: string | undefined,
): string | undefined {
  if (input.readLivePrHead === undefined || localHead === undefined) return localHead;
  let live: string | undefined;
  try {
    live = normalizeCommitSha(input.readLivePrHead());
  } catch {
    return undefined;
  }
  if (!live) return undefined;
  if (live === localHead) return localHead;
  if (localHead !== launchHead) return localHead;
  return launchHead === undefined ? undefined : live;
}

/**
 * A {@link StagedVerificationStore} over one task's context, in memory.
 *
 * The review handler's completion — transition, label effects and context — is
 * committed by the phase runner in one `completePhaseWithEffects` call. Running
 * the shipped `recordStageRun` against this shim reuses its validation, R1/R4
 * retention and streak rules verbatim (no second implementation), and the state
 * it produces is handed back as the completion's context patch. That is what
 * makes §8's one-transaction rule hold for the grant: the bundle and the grant
 * are durable only in the completion that publishes (or withholds) the grant.
 *
 * The allocation is the one write that precedes that completion (#1096 §7.1 rule
 * 2): with a durable store it commits before any check launches, so a crash
 * mid-stage leaves the detectable "allocated, no bundle" state that the next
 * allocation records `interrupted` and counts (issue #1103 review, P2). Without
 * one — a direct caller or a test — the allocation rides the shim too.
 */
export function contextOnlyStagedVerificationStore(task: AiTask): {
  readonly store: StagedVerificationStore;
  readonly current: () => AiTask;
} {
  let current = task;
  return {
    current: () => current,
    store: {
      getTask: async () => current,
      completePhaseWithEffects: async (transition) => {
        current = {
          ...current,
          revision: current.revision + 1,
          context: { ...(current.context ?? {}), ...(transition.patch.context ?? {}) },
        };
        return { ok: true as const, value: current };
      },
    },
  };
}

/** Why no final bundle was recorded for an opted-in session. Recorded, never parsed. */
export type FinalStageWithheldReason =
  | Exclude<StageVerificationUnavailableReason, "disabled">
  /** #1096 §4.3 rule 4: a component resolved `unknown`, so nothing launches. */
  | "identity-unresolvable"
  /** #1096 §4.3 rule 6: a tracked modification in the approved worktree. */
  | "worktree-not-clean"
  /** The stored `stagedVerification` block is malformed; fail closed. */
  | "state-unreadable"
  /** `allocateStageRun` / `recordStageRun` refused the run. */
  | "record-refused"
  /**
   * #1096 §7.3 rule 5: the allocation superseded an interrupted final run and the
   * consecutive non-code streak is past `maxStageRecoveryAttempts`, so nothing
   * launches again.
   */
  | "recovery-budget-exhausted"
  /**
   * Issue #1154 (§5 rule 3, D1): an allocated stage run recorded no result and
   * nothing proves its processes ended, so no Stage 2 launches over it.
   */
  | "termination-unknown"
  /**
   * Issue #1154 (§0.1 O2, §5 rule 1): no recorded passing Stage 1 of this exact
   * revision and configuration, so Stage 2 is not entered.
   */
  | "stage1-evidence-missing";

export type FinalStageVerification =
  /** §10 rule 1: nothing staged runs; the shipped review-success grant applies. */
  | { readonly status: "disabled" }
  | {
      readonly status: "withheld";
      /**
       * `withhold-only`: there is no required set a stage could run, so the review
       * still hands off but the grant is withheld. `operator`: the stage could not
       * establish evidence and parks for a human (§7 row 12's posture).
       */
      readonly disposition: "withhold-only" | "operator";
      readonly reason: FinalStageWithheldReason;
      readonly detail?: string;
      readonly context: Record<string, unknown>;
    }
  | {
      readonly status: "recorded";
      readonly route: FinalStageRoute;
      /**
       * The route's disposition, except that a row-7 bundle whose grant does not
       * bind at enqueue (a head that moved under the run) re-runs the final stage
       * instead of granting (§8 "head binding at enqueue").
       */
      readonly disposition: FinalStageDisposition;
      readonly granted: boolean;
      /** §4.4: satisfied by this approval's own recorded final bundle; nothing ran. */
      readonly reused: boolean;
      readonly bundle: StageRunResult;
      readonly bindingRefusals: readonly StageEvidenceRefusal[];
      readonly summary: StageRunSummary;
      /** The completion's context patch: the recorded state, the declaration, the public record. */
      readonly context: Record<string, unknown>;
      /**
       * Issue #1154: the Stage 2 test result, when the session binds a test
       * suite — the record and its bounded fix/handoff text.
       */
      readonly testStage?: { readonly result: TestStageResult; readonly record: TestStageRecord; readonly detail: string };
      /**
       * Issue #1154 (§5, Stage 2 `stale`): the revision moved, so the approval is
       * spent — the task returns through Stage 1 and review at the live revision
       * rather than re-running Stage 2 at a revision nobody approved.
       */
      readonly restartReview?: boolean;
    };

export interface RunFinalStageInput {
  readonly runner: CommandRunner;
  readonly session: FinalStageSession;
  readonly task: AiTask;
  /** The review worktree, at the approved head. */
  readonly cwd: string;
  readonly runId: string;
  /** The review lane's attempt for this run. */
  readonly taskAttempt: number;
  readonly artifactDir?: string;
  /** #1090: the review lane's per-command deadline. */
  readonly commandTimeoutMs?: number;
  readonly now?: () => string;
  /**
   * The durable task store (#1096 §7.1 rule 2). When given, the stage run's
   * allocation commits here BEFORE any check launches, so an interrupted run is
   * detectable and counts toward `maxStageRecoveryAttempts`. The bundle and the
   * grant still ride the returned context patch. Absent, the allocation rides the
   * patch as well.
   */
  readonly store?: StagedVerificationStore;
  /**
   * Re-reads the live session configuration for the end-of-run re-check (#1096
   * §7.2 rule 2): an operator editing `sessions.json` mid-run moves the recheck's
   * plan, baseline and policy components so the grant does not bind. A throw or
   * an unresolvable session makes those components `unknown`. Absent, the launch
   * session is re-derived.
   */
  readonly readLiveSession?: () => Promise<FinalStageSession | undefined>;
  /**
   * Reads the PR's authoritative head from the host (issue #1103 review, P1). A
   * push to the PR branch while the checks run leaves the review worktree's `HEAD`
   * untouched, so the local head alone would grant stack-ready for a revision the
   * PR no longer points at. When given, the grant binds only if this live head
   * equals the verified head; a throw or an unresolvable head never grants.
   * Absent, the worktree `HEAD` stands for the PR head.
   */
  readonly readLivePrHead?: () => string | undefined;
  /**
   * The review approval this final stage verifies (issue #1106). With a durable
   * `store` it is persisted — bound to the head being verified — in the same
   * write as the allocation, BEFORE any check launches: a run that dies
   * mid-stage (process loss, host restart, a lease an operator recovers) then
   * leaves the continuation #1103's delayed release would have written, and the
   * next claim at that head re-runs only the final stage rather than the review
   * agent (§7 rule 3). Every outcome this function returns clears it; the
   * review lane re-records it on the rows that re-run.
   */
  readonly approval?: object;
}

const FINAL_STAGE_LOG_PREFIX = "review-final-verification";

function withheld(
  disposition: "withhold-only" | "operator",
  reason: FinalStageWithheldReason,
  detail?: string,
  extraContext: Record<string, unknown> = {},
): FinalStageVerification {
  return {
    status: "withheld",
    disposition,
    reason,
    ...(detail !== undefined ? { detail } : {}),
    context: {
      ...extraContext,
      // A withheld run declares no grant; `null` overwrites a declaration an
      // earlier run left in the task context.
      [FINAL_STAGE_GRANT_CONTEXT_KEY]: null,
      [FINAL_STAGE_VERIFICATION_CONTEXT_KEY]: { status: "withheld", disposition, reason },
    },
  };
}

/** The session layer a final stage reads: its checks, its policy and its declared prepare. */
type FinalStageSession = Pick<
  ResolvedSession,
  "verification" | "stagedVerification" | "environmentPrepare" | "artifactRoot"
>;

interface FinalStageIdentityInput {
  readonly session: FinalStageSession;
  readonly task: AiTask;
  readonly plan: EffectiveVerificationPlan;
  readonly settings: ResolvedStagedVerificationSettings;
  readonly cwd: string;
  readonly head: string | undefined;
  readonly listing: WorkingTreeListing;
  /**
   * Issue #1154: a session with a test suite binding carries the binding's digest
   * as the configuration identity's `selectionPolicyDigest` (§6 rule 5), exactly
   * as every Stage 1 run of the Issue does. Absent either because the session
   * declares no binding — a configuration fact, so the component is `none` — or
   * because a declared binding no longer resolves, which is `unknown`.
   */
  readonly suiteBindingDigest?: string;
}

/**
 * The seven identity components of a final stage run over one session layer,
 * head and working-tree listing (#1096 §4.3), plus the required set the run
 * executes. Shared by the launch resolution and the end-of-run re-check, so the
 * re-check derives every component again rather than carrying any from launch.
 */
function resolveFinalStageIdentity(
  input: FinalStageIdentityInput,
): { identity: StageEvidenceIdentity; selection: ResolvedStageSelection } {
  const { plan, settings } = input;
  const ctx = (input.task.context ?? {}) as Record<string, unknown>;
  const selection = resolveStageSelection(plan);
  const body = typeof ctx.body === "string" ? ctx.body : "";
  const reconciliation = reconcileVerificationPlan({
    sessionVerification: input.session.verification,
    issueRequirements: body ? extractIssueVerificationCommands(body) : [],
    amendments: ctx[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  });
  const amendmentState = validateVerificationAmendmentState(ctx[VERIFICATION_AMENDMENTS_CONTEXT_KEY]);
  const checkpoint = amendmentState.valid ? amendmentState.state?.checkpoint : undefined;
  const baseline = buildVerificationSessionBaseline(input.session.verification);
  const identity: StageEvidenceIdentity = {
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
    // Issue #1155: the suite binding is the only configuration a stage run has
    // left to attest. A session that binds no suite declares nothing here, and
    // #1096 §4.1 rule 2 makes that `none` — stable across runs — while a
    // declared binding this run could not resolve is `unknown`.
    selectionPolicyDigest: input.suiteBindingDigest !== undefined
      ? { state: "value", value: input.suiteBindingDigest }
      : deriveTestSuitePolicyComponent(
          settings.testSuite === undefined
            ? { state: "undeclared" }
            : { state: "unreadable", reason: "the declared test suite binding does not resolve" },
        ),
    // Both declared sources, read at each boundary (issue #1103 review, P2): the
    // worktree's current prepare stamp and the operator token. A declared prepare
    // whose stamp is missing or stale is `unknown`, and a re-prepare between launch
    // and re-check moves the component.
    environmentIdentity: deriveEnvironmentIdentityComponent({
      prepareStamp: readCurrentPrepareStamp({
        config: input.session.environmentPrepare,
        cwd: input.cwd,
        worktreeIdentity: input.cwd,
        artifactRoot: input.session.artifactRoot,
      }),
      ...(settings.environmentIdentity !== undefined
        ? { operatorToken: { state: "declared", value: settings.environmentIdentity } }
        : {}),
    }),
  };
  return { identity, selection };
}

/**
 * #1096 §4.3 rule 3 with §7.2 rule 2: the end-of-run identity, with the session
 * configuration read LIVE again. A `sessions.json` edit that landed while the
 * checks ran moves the plan, baseline or policy component away from its launch
 * value, and a live session that cannot be read or no longer resolves a stage
 * leaves those components `unknown` — either way the grant does not bind.
 */
async function recheckFinalStageIdentity(
  input: RunFinalStageInput,
  head: string | undefined,
  listing: WorkingTreeListing,
  terminationUnconfirmed: boolean,
  testFlow = false,
): Promise<StageEvidenceIdentity> {
  let live: FinalStageSession | undefined = input.session;
  let unresolvedReason: string | undefined;
  if (input.readLiveSession !== undefined) {
    try {
      live = await input.readLiveSession();
      if (live === undefined) unresolvedReason = "live_session_unresolvable";
    } catch {
      live = undefined;
      unresolvedReason = "live_session_unreadable";
    }
  }
  // Issue #1106 (#1096 §7.2 rules 2 and 5): the plan the checks ran against is
  // re-read from the durable task row, not carried from launch. The amendment
  // surface refuses an active task, but an operator who recovered a lease this
  // run still holds, or an Issue refresh that landed through another writer,
  // moves the amendment chain or the body underneath the run — and the grant
  // must not bind to a plan the task no longer carries.
  let liveTask: AiTask | undefined = input.task;
  if (input.store !== undefined) {
    try {
      liveTask = (await input.store.getTask({
        sessionId: input.task.sessionId,
        issueNumber: input.task.issueNumber,
      })) ?? undefined;
      if (liveTask === undefined) unresolvedReason ??= "live_task_unresolvable";
    } catch {
      liveTask = undefined;
      unresolvedReason ??= "live_task_unreadable";
    }
  }
  // #1096 §4.5 rule 3: a check whose kill could not be confirmed leaves an
  // unaccounted process in this worktree, so the environment the run ends in
  // cannot be attested.
  const withCleanupTaint = (identity: StageEvidenceIdentity): StageEvidenceIdentity =>
    terminationUnconfirmed
      ? { ...identity, environmentIdentity: unknownIdentityComponent("process_tree_cleanup_unconfirmed") }
      : identity;
  // Under a suite binding a retirement of the plan's only slot after launch is a
  // plan change (§3 R5 `stale`), so the live plan is resolved without an active slot.
  const liveContext = live !== undefined && liveTask !== undefined
    ? (testFlow ? resolveStageVerificationPlan : resolveStageVerificationContext)({ session: live, task: liveTask })
    : undefined;
  if (
    live === undefined
    || liveTask === undefined
    || liveContext === undefined
    || liveContext.status !== "ready"
  ) {
    const unknown = unknownIdentityComponent(
      unresolvedReason ?? `live_stage_${liveContext?.status === "unavailable" ? liveContext.reason : "unavailable"}`,
    );
    const identity = Object.fromEntries(
      STAGE_IDENTITY_COMPONENTS.map((name) => [name, unknown]),
    ) as unknown as StageEvidenceIdentity;
    return withCleanupTaint({
      ...identity,
      testedRevision: deriveTestedRevisionComponent(head),
      workingTreeState: deriveWorkingTreeStateComponent(listing),
    });
  }
  // Issue #1154: a run launched under a suite binding re-derives the binding from
  // the live layers; one that no longer resolves leaves the component unknown.
  const liveTestStage = resolveTestStageContext({ session: live, task: liveTask });
  const { identity } = resolveFinalStageIdentity({
    session: live,
    task: liveTask,
    plan: liveContext.plan,
    settings: liveContext.settings,
    cwd: input.cwd,
    head,
    listing,
    ...(liveTestStage.status === "ready" ? { suiteBindingDigest: liveTestStage.suiteBindingDigest } : {}),
  });
  // A live session whose declared suite binding no longer resolves already
  // leaves `selectionPolicyDigest` unknown above, and one that dropped the
  // binding outright moves it from a value to `none` — either way the grant
  // cannot bind.
  return withCleanupTaint(identity);
}

/**
 * Run the `final` stage for an approved review, or say why none ran.
 *
 * Called only after the review agent returned `success` (§4.1 rule 2), in the
 * review worktree at the approved head. The selection is the entire required set
 * and the port is never consulted (§4.3). The run's identity is resolved before
 * anything launches and re-resolved after, so a head that moves under the run
 * never publishes a grant (§8). The returned context patch holds the recorded
 * state and — on row 7 with a binding grant only — the per-run grant declaration
 * {@link decideStackReadyPublication} requires; the caller commits it in the
 * completion that carries the label effects.
 */
export async function runFinalStageVerification(
  input: RunFinalStageInput,
): Promise<FinalStageVerification> {
  const outcome = await runFinalStage(input);
  if (input.approval === undefined || outcome.status === "disabled") return outcome;
  // Issue #1106: the approval the allocation persisted is consumed by whatever
  // this run concluded. `null` goes first so nothing the outcome carries is
  // overwritten, and the review lane re-records it on the rows that re-run.
  const context = { [FINAL_STAGE_APPROVAL_CONTEXT_KEY]: null, ...outcome.context };
  return outcome.status === "withheld" ? { ...outcome, context } : { ...outcome, context };
}

async function runFinalStage(
  input: RunFinalStageInput,
): Promise<FinalStageVerification> {
  const stageContext = resolveStageVerificationContext({ session: input.session, task: input.task });
  // Issue #1154: with the operator's suite binding this is Stage 2 — the full
  // test suite through the adapter, then the required non-test checks (D3).
  const testStage = resolveTestStageContext({ session: input.session, task: input.task });
  const testFlow: ReadyTestStageContext | undefined = testStage.status === "ready" ? testStage : undefined;
  if (stageContext.status === "unavailable" && testFlow === undefined) {
    if (stageContext.reason === "disabled") return { status: "disabled" };
    // No reconciled plan, or nothing to execute: there is no full required run
    // that could stand behind a grant, so the grant is withheld (§7 rule 1).
    return withheld("withhold-only", stageContext.reason, stageContext.detail);
  }
  // A suite binding over a plan with no active slot (the bound slot retired) is
  // still Stage 2: it records `unavailable` and parks (§6 rule 1), never withholds.
  const { plan, settings } = testFlow ?? (stageContext as StageVerificationReady);
  const ctx = (input.task.context ?? {}) as Record<string, unknown>;
  const now = () => input.now?.() ?? new Date().toISOString();

  const stored = validateStagedVerificationState(ctx[STAGED_VERIFICATION_CONTEXT_KEY]);
  if (!stored.valid) return withheld("operator", "state-unreadable", stored.detail);

  // Identity before launch (#1096 §4.3 rule 1).
  const head = resolveHead(input.runner, input.cwd);
  const listing = readWorkingTreeListing(input.runner, input.cwd);
  if (listing.state === "listed" && !finalStageWorktreeIsClean(listing)) {
    return withheld("operator", "worktree-not-clean");
  }
  const { identity, selection } = resolveFinalStageIdentity({
    session: input.session,
    task: input.task,
    plan,
    settings,
    cwd: input.cwd,
    head,
    listing,
    ...(testFlow !== undefined ? { suiteBindingDigest: testFlow.suiteBindingDigest } : {}),
  });
  const unresolved = STAGE_IDENTITY_COMPONENTS.filter((name) => identity[name].state === "unknown");
  const launchUnattested = unresolved.length > 0;
  if (launchUnattested && testFlow === undefined) {
    // #1096 §4.3 rule 4: an unattestable run costs no execution and grants
    // nothing; the operator handoff names the components, never their values.
    return withheld("operator", "identity-unresolvable", unresolved.join(", "));
  }
  // Issue #1154 (§3 R2, R4; §5): under a suite binding an unattested launch
  // identity or an unbound suite still allocates and records its Stage 2 result
  // — `identity-unknown` re-runs under `maxStageRecoveryAttempts`, `unavailable`
  // parks — and launches nothing.
  const stage2Launches = testFlow !== undefined && testFlow.suite.status === "bound" && !launchUnattested;
  const expectation = {
    taskAttempt: input.taskAttempt,
    lane: "review" as const,
    planDigest: plan.planDigest,
    ...(head !== undefined ? { headSha: head } : {}),
    identity,
  };

  // §4.4: this approval's own granting bundle satisfies the stage without a
  // re-run — the repeated delivery of a completion that already published. A
  // passing bundle that never granted is re-run instead: only a recording moves
  // the R1 pointer, and a recording needs a fresh run.
  const state = stored.state;
  // A reused grant binds to the live PR head too (issue #1103 review, P1): after a
  // push to the PR branch the earlier bundle no longer describes the PR.
  if (state?.grantingStageRunKey !== undefined && bindLivePrHead(input, head, head) === head) {
    const reuse = evaluateFinalStageReuse({
      bundles: state.finalBundles,
      expectation,
      ledger: state.runs,
    });
    if (reuse.reusable && stageRunKey(reuse.bundle.stageRunId) === state.grantingStageRunKey) {
      const marker: FinalStageGrantMarker = {
        runId: input.runId,
        stageRunKey: state.grantingStageRunKey,
        headSha: head as string,
      };
      // Issue #1154: the reused bundle's Stage 2 record is the pass this grant
      // stands on, reported exactly as the run that recorded it reported it.
      const reusedTestFiles = reuse.bundle.testFiles;
      const reusedSuiteName = testFlow === undefined
        ? "test-suite"
        : testFlow.suite.status === "bound" ? testFlow.suite.slot.name : testFlow.binding.key;
      return recordedOutcome({
        route: routeFinalStageBundle(reuse.bundle),
        disposition: "grant",
        granted: true,
        reused: true,
        bundle: reuse.bundle,
        bindingRefusals: [],
        state,
        marker,
        ...(reusedTestFiles !== undefined
          ? {
              testStage: {
                result: reusedTestFiles.result,
                record: reusedTestFiles,
                detail: describeTestStageRecord(reusedTestFiles, "final", reusedSuiteName),
              },
            }
          : {}),
      });
    }
  }

  // #1096 §7.1 rule 2 (issue #1103 review, P2): the ordinal is allocated before
  // launch, in the durable store when there is one, so a crash mid-stage leaves
  // an open allocation the next claim records `interrupted` and counts.
  const key = { sessionId: input.task.sessionId, issueNumber: input.task.issueNumber };
  const baseTask = input.store !== undefined ? await input.store.getTask(key) : input.task;
  if (!baseTask) return withheld("operator", "record-refused", "not_found: the task is not in the store");
  const baseState = input.store !== undefined
    ? validateStagedVerificationState(baseTask.context?.[STAGED_VERIFICATION_CONTEXT_KEY])
    : stored;
  if (!baseState.valid) return withheld("operator", "state-unreadable", baseState.detail);
  if (testFlow !== undefined) {
    // §5 rule 3 (D1): an allocated run with no recorded result is never
    // superseded by a new launch; the parking completion closes it.
    const guard = openStageRunGuard(baseState.state, now());
    if (guard.kind === "park") {
      return withheld(
        "operator",
        "termination-unknown",
        `stage run ${guard.stageRunKey} (allocated ${guard.allocatedAt}) recorded no result and nothing proves its processes ended`,
        { [STAGED_VERIFICATION_CONTEXT_KEY]: guard.closedState },
      );
    }
    // §0.1 O2, §5 rule 1: Stage 2 is entered only over a recorded passing Stage 1
    // (`passed` or `empty`) whose launch and re-checked identity are this run's —
    // the same revision, working tree, plan, suite binding and environment the
    // reviewer approved. A failed, partial, stale or missing Stage 1 never
    // reaches the full suite. A run that launches nothing records its non-granting
    // result without this check; its re-run is checked again at a live identity.
    const stage1 = !stage2Launches ? undefined : [...(baseState.state?.loopBundles ?? [])].reverse().find((bundle) => {
      const result = bundle.testFiles?.result;
      const entry = baseState.state?.runs.find((run) => stageRunKey(run.stageRunId) === stageRunKey(bundle.stageRunId));
      return (result === "passed" || result === "empty")
        && (entry === undefined || entry.state === "recorded")
        && bundle.identityRecheck !== undefined
        && stageEvidenceIdentityMatches(bundle.identity, bundle.identityRecheck)
        && stageEvidenceIdentityMatches(identity, bundle.identity);
    });
    if (stage2Launches && stage1 === undefined) {
      return withheld(
        "operator",
        "stage1-evidence-missing",
        "no recorded passing Stage 1 matches the approved revision and configuration",
      );
    }
  }
  // #1096 §7.1 rule 4: an interruption is recorded by the next claim's
  // allocation, counts toward the recovery budget, and is re-run from the
  // beginning. That rule is the evidence-validity contract's, not the retired
  // selection policy's, so issue #1155 leaves it exactly as it stands.
  const openRun = pendingStageRunInterruption(baseState.state);
  const supersedesFinalRun = openRun?.stageRunId.lane === "review" && openRun.stageRunId.stage === "final";
  const allocated = await allocateStageRun({
    store: input.store ?? contextOnlyStagedVerificationStore(baseTask).store,
    key,
    observedTaskRevision: baseTask.revision,
    requestKey: `${input.runId}:review:final:${input.taskAttempt}`,
    taskAttempt: input.taskAttempt,
    lane: "review",
    stage: "final",
    identity,
    // Issue #1106: the approval rides the pre-launch write, bound to this head.
    ...(input.approval !== undefined && head !== undefined
      ? { contextPatch: { [FINAL_STAGE_APPROVAL_CONTEXT_KEY]: { headSha: head, approval: input.approval } } }
      : {}),
    runId: input.runId,
    now: now(),
  });
  if (allocated.status !== "allocated") {
    return withheld(
      "operator",
      "record-refused",
      allocated.status === "refused" ? `${allocated.reason}: ${allocated.detail}` : allocated.status,
    );
  }
  const stageRunId = allocated.entry.stageRunId;
  const streakAtLaunch = allocated.state.finalRecoveryStreak ?? 0;
  if (supersedesFinalRun && streakAtLaunch > settings.maxStageRecoveryAttempts) {
    // #1096 §7.3 rules 4–5: interruptions are non-code terminations too, and a
    // run that keeps dying never reaches the recorded-run check below. Park
    // without launching, and close this allocation in the parking completion so
    // the operator's re-queue launches once instead of parking again.
    const closedAt = now();
    const parkedState: StagedVerificationState = {
      ...allocated.state,
      runs: allocated.state.runs.map((entry) =>
        stageRunKey(entry.stageRunId) === stageRunKey(stageRunId)
          ? { ...entry, state: "interrupted" as const, interruptedAt: closedAt }
          : entry,
      ),
    };
    return withheld(
      "operator",
      "recovery-budget-exhausted",
      `${streakAtLaunch} consecutive non-code final-stage terminations`,
      { [STAGED_VERIFICATION_CONTEXT_KEY]: parkedState },
    );
  }
  const shim = contextOnlyStagedVerificationStore(allocated.task);
  const logSnapshotPrefix = stageBundleArtifactName(
    FINAL_STAGE_LOG_PREFIX,
    "final",
    stageRunId.stageOrdinal,
  ).replace(/\.json$/, "");
  const startedAtMs = Date.now();
  // Issue #1154: Stage 2's full suite runs first, through the adapter; the
  // required non-test checks then run at the same approved revision exactly as
  // the shipped final stage runs them (D3) — only over a full-suite pass, since
  // any other suite result decides the route on its own.
  const suiteResolution = testFlow !== undefined ? testFlow.suite : undefined;
  const suiteCheckId = suiteResolution !== undefined && suiteResolution.status === "bound"
    ? suiteResolution.slot.commandId
    : undefined;
  const stage2: Stage2TestExecution | undefined = testFlow === undefined
    ? undefined
    : launchUnattested && testFlow.suite.status === "bound"
    // §3 R4: nothing is executed; the classification records `identity-unknown`.
    ? { plan: "execute", inventoryUnreadable: false }
    : runStage2Tests({
        runner: input.runner,
        context: testFlow,
        cwd: input.cwd,
        ...(input.artifactDir !== undefined ? { artifactDir: input.artifactDir } : {}),
        artifactPrefix: `${logSnapshotPrefix}-tests`,
        ...(input.commandTimeoutMs !== undefined ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
      });
  // Issue #1154 (§3): Stage 2 is attested when the suite ends, BEFORE any
  // non-test check launches. A head push or a live configuration change while
  // the suite ran makes the result `stale` or `identity-unknown`, and neither
  // launches the non-test checks; the completion re-check below stays separate
  // and is what the recorded result and any grant bind to.
  const stage2SuiteName = testFlow === undefined
    ? undefined
    : testFlow.suite.status === "bound" ? testFlow.suite.slot.name : testFlow.binding.key;
  const stage2EndIdentity = testFlow !== undefined && stage2 !== undefined
    ? await recheckFinalStageIdentity(
        input,
        bindLivePrHead(input, resolveHead(input.runner, input.cwd), head),
        readWorkingTreeListing(input.runner, input.cwd),
        false,
        true,
      )
    : undefined;
  const classifyStage2 = (end: StageEvidenceIdentity, recheck: StageEvidenceIdentity): TestStageResult => {
    if (stage2 === undefined) return "no-evidence";
    const classification = classifyTestStageResult({
      stage: "final",
      plan: stage2.plan,
      ...(stage2.run !== undefined ? { run: stage2.run } : {}),
      identity: { launch: identity, end, recheck },
      hostFailure: testRunHostFailure(stage2.run, stage2SuiteName ?? ""),
    });
    // `no-evidence` is Stage 2's all-skipped row (R12); D6's `empty` is Stage 1's.
    return classification.result;
  };
  const stage2SuitePassed = stage2EndIdentity !== undefined
    && routeStage2TestResult({ kind: "result", result: classifyStage2(stage2EndIdentity, stage2EndIdentity) }) === "checks";
  // The suite runs only through the adapter above (§6 rule 1). A selected check
  // is excluded by command equivalence as well as by slot, so nothing that runs
  // the suite's command is ever executed again as a non-test check; a
  // requirement it satisfies is credited from the synthesized suite record.
  const suiteCommand = suiteResolution !== undefined && suiteResolution.status === "bound"
    ? suiteResolution.slot.command
    : undefined;
  const nonTestExecution = {
    ...selection.execution,
    checks: selection.execution.checks.filter((check) =>
      check.checkId !== suiteCheckId
      && (suiteCommand === undefined
        || (!matchesConfiguredVerificationCommand(check.command, suiteCommand)
          && !matchesConfiguredVerificationCommand(suiteCommand, check.command)))),
  };
  const verification: VerificationOutcome = stage2 === undefined || stage2SuitePassed
    ? runVerification(
        input.runner,
        input.session.verification,
        input.cwd,
        input.artifactDir,
        FINAL_STAGE_LOG_PREFIX,
        {
          ...nonTestExecution,
          logSnapshotPrefix,
          ...(input.commandTimeoutMs !== undefined ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
        },
      )
    : {
        passed: false,
        results: [],
        stageChecks: nonTestExecution.checks.map((check) => ({
          record: buildCheckExecutionRecord({
            checkId: check.checkId,
            name: check.name,
            command: check.command,
            notRunKind: "first-failure-stop",
            notRunReason: "the full test suite did not pass, so the stage stopped before the non-test checks",
          }),
        })),
      };

  // Identity after the run (#1096 §4.3 rule 3), derived from the end-state
  // listing. Untracked paths do not block a final launch (§4.3 rule 6) but are
  // content-fingerprinted into `workingTreeState`, so a check that rewrites an
  // untracked input — or a moved head, or a tracked modification — unbinds the
  // run rather than inheriting the launch fingerprint (issue #1103 review, P1).
  // Every other component is derived again from the LIVE session configuration
  // (§7.2 rule 2), so a `sessions.json` edit mid-run unbinds it too. The head is
  // the PR's live head when readable (issue #1103 review, P1): a push to the PR
  // branch mid-run leaves the worktree `HEAD` unchanged but unbinds the grant,
  // and a worktree `HEAD` that moved while the PR head did not unbinds it too.
  const headAfter = bindLivePrHead(input, resolveHead(input.runner, input.cwd), head);
  const listingAfter = readWorkingTreeListing(input.runner, input.cwd);
  const identityRecheck = await recheckFinalStageIdentity(
    input,
    headAfter,
    listingAfter,
    (verification.stageChecks ?? []).some((check) => check.terminationUnconfirmed === true),
    testFlow !== undefined,
  );

  // Issue #1154 (§3): the Stage 2 test result, and the suite entry's check
  // record derived from it so the bundle keeps its shipped shape. A result that
  // credits no outcome records the suite check `not-run`, so the bundle stays
  // incomplete and can never read as granting-shaped.
  let testStageOutcome: { result: TestStageResult; record: TestStageRecord; detail: string } | undefined;
  let suiteCheckOutcomes: StageCheckOutcome[] = [];
  let testBundleOutcome: StageRunResult["outcome"] | undefined;
  let restartReview = false;
  if (testFlow !== undefined && stage2 !== undefined) {
    // An unbound suite has no slot: its launch-time refusal (§3 R2) records under
    // the bound key, and no suite check record is synthesized for it.
    const suiteSlot = testFlow.suite.status === "bound" ? testFlow.suite.slot : undefined;
    const suiteName = suiteSlot?.name ?? testFlow.binding.key;
    // Ended at the suite's end; re-checked inside this completion.
    const result = classifyStage2(stage2EndIdentity ?? identityRecheck, identityRecheck);
    const record = buildTestStageRecord({
      result,
      suiteBindingDigest: testFlow.suiteBindingDigest,
      selection: result === "unavailable"
        ? {
            status: "unavailable",
            reason: stage2.inventoryUnreadable
              ? "runnable-file-report"
              : testFlow.suite.status !== "bound" ? testFlow.suite.reason : "suite-command-refused",
          }
        : { status: "full" },
      ...(stage2.run !== undefined && result !== "unavailable" ? { run: stage2.run } : {}),
    });
    const detail = `${describeTestStageRecord(record, "final", suiteName)}${
      stage2.detail !== undefined && result === "unavailable" ? `\n${stage2.detail}` : ""}${
      result === "identity-unknown" && launchUnattested ? `\nUnattested at launch: ${unresolved.join(", ")}.` : ""}`;
    testStageOutcome = { result, record, detail };
    const route2 = routeStage2TestResult({ kind: "result", result });
    restartReview = route2 === "review-again";
    const selected = suiteSlot !== undefined
      ? selection.execution.checks.find((check) => check.checkId === suiteSlot.commandId)
      : undefined;
    const steps = stage2.run !== undefined ? stage2.run.steps : [];
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : undefined;
    const lastDuration: number | undefined = lastStep !== undefined ? lastStep.durationMs : undefined;
    const lastExit: number | undefined = lastStep !== undefined ? lastStep.exitCode : undefined;
    const suiteRun = route2 === "checks"
      ? { exitCode: 0, ...(lastDuration !== undefined ? { durationMs: lastDuration } : {}) }
      : route2 === "repair" || route2 === "host-retry"
        ? {
            exitCode: lastExit !== undefined && lastExit !== 0 ? lastExit : 1,
            stdout: stage2.run?.outputTail ?? detail,
            ...(result === "timed-out" ? { timedOut: true } : {}),
          }
        : undefined;
    if (selected !== undefined) {
      suiteCheckOutcomes = [{
        record: buildCheckExecutionRecord({
          checkId: selected.checkId,
          name: selected.name,
          command: selected.command,
          ...(suiteRun !== undefined
            ? { run: suiteRun }
            : { notRunKind: "evidence-lost" as const, notRunReason: `Stage 2 recorded \`${result}\`, which credits no file outcome` }),
        }),
        ...(route2 === "host-retry" ? { hostFailure: true } : {}),
      }];
    }
    testBundleOutcome = route2 === "repair"
      ? (result === "timed-out" ? "timed-out" : "code-failed")
      : route2 === "host-retry"
        ? "infrastructure"
        : route2 === "rerun" || route2 === "review-again"
          ? "interrupted"
          : route2 === "park" ? "unknown" : undefined;
  }

  const rawManualEvidence = ctx.manualVerificationEvidence;
  const manualEvidence =
    Array.isArray(rawManualEvidence) && rawManualEvidence.length > 0
      ? (rawManualEvidence as ManualVerificationEvidenceLike[])
      : undefined;
  // Issue #1154 (§6): the suite runs before every non-test check, so the bundle
  // records its check — and the selection names it — first, in executed order.
  const suiteRecordCheckId = suiteCheckOutcomes[0]?.record.checkId;
  const selectedCheckIds = selection.outcome.selection.checkIds;
  const executedSelection = suiteRecordCheckId !== undefined && selectedCheckIds.includes(suiteRecordCheckId)
    ? {
        ...selection.outcome,
        selection: {
          ...selection.outcome.selection,
          checkIds: [suiteRecordCheckId, ...selectedCheckIds.filter((checkId) => checkId !== suiteRecordCheckId)],
        },
      }
    : selection.outcome;
  // Issue #1166: only this bundle's own Stage 2 record can credit a declared
  // full-suite requirement — the record is synthesized above from the suite run
  // this stage performed, so a requirement matched through the declaration is
  // credited by the same evidence the suite command's own would be.
  const fullSuite = fullSuiteRequirementDeclaration(input.session);
  const assembly = finalizeStageRun({
    stageRunId,
    plan,
    selection: executedSelection,
    stageChecks: [...suiteCheckOutcomes, ...(verification.stageChecks ?? [])],
    runCompleted: true,
    ...(manualEvidence !== undefined
      ? { manualEvidence, evidenceExpectations: head !== undefined ? { headSha: head } : {} }
      : {}),
    ...(fullSuite !== undefined ? { fullSuite } : {}),
    ...(head !== undefined ? { headSha: head } : {}),
    durationMs: Date.now() - startedAtMs,
  });
  const bundleInput = {
    ...assembly.bundle,
    ...(testBundleOutcome !== undefined ? { outcome: testBundleOutcome } : {}),
    ...(testStageOutcome !== undefined ? { testFiles: testStageOutcome.record } : {}),
    identityRecheck,
  };
  // Issue #1154: the artifact holds the bundle the store records — its Stage 2
  // record and outcome included — so it is written only once that bundle exists.
  if (input.artifactDir) {
    writeStageBundleArtifact(input.artifactDir, FINAL_STAGE_LOG_PREFIX, bundleInput);
  }
  const route = routeFinalStageBundle(bundleInput);

  // §8 step 5: the grant binds at enqueue, re-resolved rather than carried from
  // launch. The bundle is admitted exactly as the publication would admit it.
  let bindingRefusals: readonly StageEvidenceRefusal[] = [];
  let granted = false;
  if (route.disposition === "grant") {
    const binding = evaluateFinalGrantBinding({
      bundle: {
        ...bundleInput,
        identity,
        startedAt: allocated.entry.allocatedAt,
        recordedAt: allocated.entry.allocatedAt,
      },
      expectation: {
        taskAttempt: expectation.taskAttempt,
        lane: expectation.lane,
        planDigest: expectation.planDigest,
        ...(headAfter !== undefined ? { headSha: headAfter } : {}),
        identity: identityRecheck,
      },
    });
    granted = binding.granted;
    if (!binding.granted) bindingRefusals = binding.refusals;
  }

  const recorded = await recordStageRun({
    store: shim.store,
    key,
    observedTaskRevision: shim.current().revision,
    bundle: bundleInput,
    grantsStackReady: granted,
    runId: input.runId,
    now: now(),
  });
  if (recorded.status !== "recorded") {
    return withheld(
      "operator",
      "record-refused",
      recorded.status === "refused" ? `${recorded.reason}: ${recorded.detail}` : recorded.status,
    );
  }
  let disposition: FinalStageDisposition = granted
    ? "grant"
    : route.disposition === "grant" ? "rerun" : route.disposition;
  if (disposition === "rerun" || disposition === "host-retry") {
    // #1096 §7.3 rule 5: consecutive non-code terminations of this Issue's final
    // stage are bounded by `maxStageRecoveryAttempts`, so a host that keeps
    // failing or a head that keeps moving parks for an operator instead of
    // re-running forever. A code verdict or a grant ends the streak; no repair
    // cap is touched. The count is the persisted one: the pruned run ledger
    // cannot hold a streak longer than its own window.
    const streak = recorded.state.finalRecoveryStreak ?? 0;
    if (streak > settings.maxStageRecoveryAttempts) disposition = "operator";
  }
  return recordedOutcome({
    route,
    disposition,
    granted,
    reused: false,
    bundle: recorded.bundle,
    bindingRefusals,
    state: recorded.state,
    ...(testStageOutcome !== undefined ? { testStage: testStageOutcome } : {}),
    ...(restartReview ? { restartReview: true } : {}),
    ...(granted && head !== undefined
      ? {
          marker: {
            runId: input.runId,
            stageRunKey: stageRunKey(stageRunId),
            headSha: head,
          },
        }
      : {}),
  });
}

function recordedOutcome(input: {
  route: FinalStageRoute;
  disposition: FinalStageDisposition;
  granted: boolean;
  reused: boolean;
  bundle: StageRunResult;
  bindingRefusals: readonly StageEvidenceRefusal[];
  state: unknown;
  marker?: FinalStageGrantMarker;
  testStage?: { result: TestStageResult; record: TestStageRecord; detail: string };
  restartReview?: boolean;
}): FinalStageVerification {
  const summary = summarizeStageRun(input.bundle);
  return {
    status: "recorded",
    route: input.route,
    disposition: input.disposition,
    granted: input.granted,
    reused: input.reused,
    bundle: input.bundle,
    bindingRefusals: input.bindingRefusals,
    summary,
    ...(input.testStage !== undefined ? { testStage: input.testStage } : {}),
    ...(input.restartReview === true ? { restartReview: true } : {}),
    context: {
      [STAGED_VERIFICATION_CONTEXT_KEY]: input.state,
      [FINAL_STAGE_GRANT_CONTEXT_KEY]: input.marker ?? null,
      // §10 rule 5: stage, names, verdicts, counts and `full` only.
      [FINAL_STAGE_VERIFICATION_CONTEXT_KEY]: {
        status: "recorded",
        row: input.route.row,
        disposition: input.disposition,
        granted: input.granted,
        reused: input.reused,
        stageRunKey: stageRunKey(input.bundle.stageRunId),
        summary,
        // Issue #1154: the Stage 2 test result and counts — never file output.
        ...(input.testStage !== undefined
          ? {
              testStage: {
                result: input.testStage.result,
                failedFileCount: input.testStage.record.failedFiles.length,
                ...(input.testStage.record.outcomeCounts !== undefined
                  ? { outcomeCounts: input.testStage.record.outcomeCounts }
                  : {}),
              },
            }
          : {}),
        ...(input.bindingRefusals.length > 0
          ? { bindingRefusals: input.bindingRefusals.map((refusal) => refusal.reason) }
          : {}),
      },
    },
  };
}
