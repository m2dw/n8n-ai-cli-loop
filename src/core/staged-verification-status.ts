/**
 * Staged verification, operator side: the stage view `admin task-verification
 * show` prints (issue #1107 — `docs/staged-verification-contract.md` §10 rule 6
 * and §13 slice S11).
 *
 * One pure projection over what the runner already persisted — the
 * `stagedVerification` task-context block (#1099), the final stage's public
 * record and approval continuation (#1103/#1106), and the loop-stage recovery
 * counter (#1106) — against the task's current effective plan. It reads and
 * never writes, runs nothing, and invents no second notion of a stage outcome:
 * rows come from {@link routeFinalStageBundle}, identity disagreements from
 * {@link compareStageEvidenceIdentity}, and the required set from
 * {@link requiredStageChecks}.
 *
 * The answer to the one question an operator most often asks — "is this Issue
 * merely review-approved, still waiting for its full verification, or does it
 * carry completed final evidence?" — is {@link StagedVerificationProgress}.
 *
 * Redaction posture (#1096 §8 rule 10): check ids, operator-authored check names,
 * verdicts, counts, durations, digests, SHAs and fixed reason codes only. No
 * output tail, no log path, no command bytes. `unknown` reasons are bounded
 * runner text; the CLI still passes them through its sanitizer.
 */

import {
  FINAL_STAGE_APPROVAL_CONTEXT_KEY,
  FINAL_STAGE_VERIFICATION_CONTEXT_KEY,
  routeFinalStageBundle,
  type FinalStageDisposition,
  type FinalStageRow,
} from "./final-stage-gate.js";
import { compareStageEvidenceIdentity } from "./stage-evidence-validity.js";
import { readLoopStageRecovery } from "./stage-recovery.js";
import { requiredStageChecks } from "./stage-run.js";
import {
  resolveStagedVerificationSettings,
  type StagedVerificationConfig,
} from "./staged-verification-config.js";
import {
  STAGED_VERIFICATION_CONTEXT_KEY,
  STAGE_IDENTITY_COMPONENTS,
  grantingFinalBundle,
  latestStageBundle,
  pendingStageRunInterruption,
  stageRunKey,
  validateStagedVerificationState,
  type StageOutcome,
  type StageRunResult,
  type StagedVerificationState,
  type VerificationLane,
} from "./staged-verification-state.js";
import type { EffectiveVerificationPlan } from "./verification-plan.js";

/**
 * Where one Issue stands between review approval and a stack-ready grant.
 *
 * - `disabled` — the session has not opted in and no stage state exists.
 * - `no-final-evidence` — no final stage has run for this task yet. A review
 *   approval, if any, is not yet verified.
 * - `final-running` — a final stage run is allocated and has recorded no bundle:
 *   it is in flight, or it was interrupted and the next claim re-runs it.
 * - `final-pending` — the review approved a head and the approval waits only on
 *   its final stage (a delayed re-run or a resume after interruption).
 * - `final-withheld` — the most recent final stage did not earn the grant.
 * - `final-passed` — completed final evidence: the most recent final bundle is
 *   the granting one and it is bound to the current plan.
 * - `final-invalidated` — a granting bundle exists but the plan moved since it
 *   was recorded, so it is evidence for a plan the task no longer has.
 */
export type StagedVerificationProgress =
  | "disabled"
  | "no-final-evidence"
  | "final-running"
  | "final-pending"
  | "final-withheld"
  | "final-passed"
  | "final-invalidated";

/** One fixed sentence per progress state, for the human-readable surface. */
export const STAGED_VERIFICATION_PROGRESS_MEANING: Readonly<Record<StagedVerificationProgress, string>> = {
  disabled: "staged verification is off for this session; the shipped verification applies",
  "no-final-evidence": "no final stage has run; a review approval is not yet verified",
  "final-running": "a final stage run is allocated with no recorded bundle (in flight, or interrupted and re-run on the next claim)",
  "final-pending": "review approved; waiting on the full required set at the approved head",
  "final-withheld": "the latest final stage did not earn stack-ready",
  "final-passed": "completed final evidence: full required set passed at the approved head",
  "final-invalidated": "a granting final bundle exists but the plan changed since; it no longer binds",
};

export interface StageCheckView {
  readonly checkId: string;
  readonly name?: string;
  readonly verdict: string;
  readonly notRunKind?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

export interface StageBundleView {
  readonly stageRunKey: string;
  readonly lane: VerificationLane;
  readonly stage: "loop" | "final";
  readonly outcome: StageOutcome;
  readonly complete: boolean;
  readonly full: boolean;
  readonly selected: number;
  /** Size of the CURRENT plan's required set; absent without a plan. */
  readonly required?: number;
  /** Current required ids this run did not select. Absent without a plan. */
  readonly notSelected?: readonly string[];
  readonly counts: {
    readonly passed: number;
    readonly failed: number;
    readonly timedOut: number;
    readonly notRun: number;
    readonly unknown: number;
  };
  readonly planDigest: string;
  readonly headSha?: string;
  readonly startedAt: string;
  readonly recordedAt: string;
  readonly durationMs?: number;
  readonly checks: readonly StageCheckView[];
  /**
   * Why this bundle is not (or no longer) evidence for the current task, as
   * fixed codes: `plan-digest-changed`, `launch-identity-unknown:<component>`,
   * `recheck-<kind>:<component>`. Empty means nothing observable invalidated it.
   */
  readonly invalidations: readonly string[];
  /** Final bundles only: the §7 row the bundle alone routes to. */
  readonly row?: FinalStageRow;
  /** Final bundles only: the disposition the bundle alone routes to (§7 rows 7–13). */
  readonly routedDisposition?: FinalStageDisposition;
  /**
   * What the runner actually did with this bundle, from the matching persisted
   * final-stage record. It can differ from `routedDisposition`: a passing bundle
   * whose head moved is a `rerun`, and an exhausted recovery budget is `operator`.
   * Absent when no persisted record names this bundle.
   */
  readonly disposition?: FinalStageDisposition;
  readonly granting?: boolean;
  /**
   * Issue #1154: the test-file half — Stage 1 for a loop bundle, Stage 2 for a
   * final one. File ids are repository paths the project tooling reported;
   * `skipped` is never counted as passed.
   */
  readonly testFiles?: StageTestFilesView;
}

export interface StageTestFilesView {
  readonly result: string;
  /** `known`, `full` or `unavailable`. */
  readonly selection: string;
  readonly selectionReason?: string;
  /** Stage 1: the selected files, each with why (`changed`, `retained`). */
  readonly selectedFiles?: readonly { readonly file: string; readonly reasons: readonly string[] }[];
  readonly unresolvedRetained?: readonly string[];
  readonly mode?: string;
  readonly trust?: string;
  readonly outcomeCounts?: { readonly passed: number; readonly failed: number; readonly skipped: number; readonly notRun: number };
  readonly failedFiles: readonly string[];
}

export interface StagedVerificationStatusView {
  readonly enabled: boolean;
  readonly progress: StagedVerificationProgress;
  readonly meaning: string;
  /** `unreadable` when the stored block fails validation; nothing below is shown then. */
  readonly state: "absent" | "ok" | "unreadable";
  readonly stateDetail?: string;
  readonly currentPlanDigest?: string;
  /** Size of the current plan's required set (what a final stage runs). */
  readonly requiredChecks?: number;
  readonly loop: readonly StageBundleView[];
  readonly lastFinal?: StageBundleView;
  readonly grantingStageRunKey?: string;
  /** The final stage's last public record: `recorded` or `withheld` with its reason. */
  readonly lastFinalRecord?: {
    readonly status: string;
    readonly reason?: string;
    readonly bindingRefusals?: readonly string[];
    readonly reused?: boolean;
  };
  /** The head an approval is waiting to verify, when one is persisted. */
  readonly pendingApprovalHeadSha?: string;
  /** An allocated stage run with no bundle. */
  readonly openRun?: { readonly stageRunKey: string; readonly allocatedAt: string };
  /** Issue #1154: the Issue base Stage 1 diffs from, once recorded. */
  readonly issueBase?: { readonly sha: string; readonly source: string };
  /** Issue #1154: files a failed Stage 2 retained; each stays selected until the Issue completes. */
  readonly retainedTestFiles: readonly { readonly file: string; readonly addedBy: string }[];
  readonly retainedTestFilesOverflowed: boolean;
  readonly recovery: {
    readonly maxStageRecoveryAttempts: number;
    readonly finalStreak: number;
    readonly loopStreak?: number;
    readonly loopLastOutcome?: string;
    readonly loopUnreadable?: boolean;
  };
}

export interface DescribeStagedVerificationStatusInput {
  readonly stagedVerification: StagedVerificationConfig | undefined;
  readonly context: Record<string, unknown> | undefined;
  /** The task's current effective plan; absent when it could not be resolved. */
  readonly plan?: EffectiveVerificationPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bundleInvalidations(bundle: StageRunResult, plan: EffectiveVerificationPlan | undefined): string[] {
  const reasons: string[] = [];
  if (plan !== undefined && bundle.planDigest !== plan.planDigest) reasons.push("plan-digest-changed");
  for (const component of STAGE_IDENTITY_COMPONENTS) {
    if (bundle.identity[component]?.state === "unknown") {
      reasons.push(`launch-identity-unknown:${component}`);
    }
  }
  if (bundle.identityRecheck !== undefined) {
    const comparison = compareStageEvidenceIdentity(bundle.identity, bundle.identityRecheck);
    if (!comparison.matches) {
      for (const mismatch of comparison.mismatches) {
        reasons.push(`recheck-${mismatch.kind}:${mismatch.component}`);
      }
    }
  }
  return reasons;
}

const FINAL_STAGE_DISPOSITIONS: ReadonlySet<string> = new Set<FinalStageDisposition>([
  "grant",
  "repair",
  "operator",
  "rerun",
  "host-retry",
]);

interface RecordedFinalDisposition {
  readonly stageRunKey: string;
  readonly disposition: FinalStageDisposition;
}

/** The disposition the runner persisted for one recorded final bundle, if readable. */
function recordedFinalDispositionOf(context: Record<string, unknown>): RecordedFinalDisposition | undefined {
  const record = context[FINAL_STAGE_VERIFICATION_CONTEXT_KEY];
  if (
    !isRecord(record)
    || record.status !== "recorded"
    || typeof record.stageRunKey !== "string"
    || typeof record.disposition !== "string"
    || !FINAL_STAGE_DISPOSITIONS.has(record.disposition)
  ) {
    return undefined;
  }
  return { stageRunKey: record.stageRunKey, disposition: record.disposition as FinalStageDisposition };
}

function bundleView(
  bundle: StageRunResult,
  plan: EffectiveVerificationPlan | undefined,
  grantingKey: string | undefined,
  recorded?: RecordedFinalDisposition,
): StageBundleView {
  const key = stageRunKey(bundle.stageRunId);
  const requiredIds = plan !== undefined ? requiredStageChecks(plan).map((slot) => slot.commandId) : undefined;
  const selected = new Set(bundle.selection.checkIds);
  const count = (verdict: string): number => bundle.checks.filter((check) => check.verdict === verdict).length;
  const route = bundle.stageRunId.stage === "final" ? routeFinalStageBundle(bundle) : undefined;
  return {
    stageRunKey: key,
    lane: bundle.stageRunId.lane,
    stage: bundle.stageRunId.stage,
    outcome: bundle.outcome,
    complete: bundle.complete,
    full: bundle.selection.full,
    selected: bundle.selection.checkIds.length,
    ...(requiredIds !== undefined
      ? { required: requiredIds.length, notSelected: requiredIds.filter((id) => !selected.has(id)) }
      : {}),
    counts: {
      passed: count("passed"),
      failed: count("failed"),
      timedOut: count("timed-out"),
      notRun: count("not-run"),
      unknown: count("unknown"),
    },
    planDigest: bundle.planDigest,
    ...(bundle.headSha !== undefined ? { headSha: bundle.headSha } : {}),
    startedAt: bundle.startedAt,
    recordedAt: bundle.recordedAt,
    ...(bundle.durationMs !== undefined ? { durationMs: bundle.durationMs } : {}),
    checks: bundle.checks.map((check): StageCheckView => ({
      checkId: check.checkId,
      ...(check.name !== undefined ? { name: check.name } : {}),
      verdict: check.verdict,
      ...(check.notRunKind !== undefined ? { notRunKind: check.notRunKind } : {}),
      ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
      ...(check.durationMs !== undefined ? { durationMs: check.durationMs } : {}),
    })),
    invalidations: bundleInvalidations(bundle, plan),
    ...(bundle.testFiles !== undefined ? { testFiles: testFilesView(bundle.testFiles) } : {}),
    ...(route !== undefined
      ? {
          row: route.row,
          routedDisposition: route.disposition,
          ...(recorded !== undefined && recorded.stageRunKey === key ? { disposition: recorded.disposition } : {}),
          granting: grantingKey === key,
        }
      : {}),
  };
}

function testFilesView(record: NonNullable<StageRunResult["testFiles"]>): StageTestFilesView {
  const selection = record.selection;
  return {
    result: record.result,
    selection: selection.status,
    ...(selection.status === "unavailable" ? { selectionReason: selection.reason } : {}),
    ...(selection.status === "known"
      ? {
          selectedFiles: selection.files.map((entry) => ({ file: entry.file, reasons: [...entry.reasons] })),
          unresolvedRetained: [...selection.unresolvedRetained],
        }
      : {}),
    ...(record.mode !== undefined ? { mode: record.mode } : {}),
    ...(record.trust !== undefined ? { trust: record.trust } : {}),
    ...(record.outcomeCounts !== undefined ? { outcomeCounts: { ...record.outcomeCounts } } : {}),
    failedFiles: [...record.failedFiles],
  };
}

function lastFinalRecordOf(context: Record<string, unknown>): StagedVerificationStatusView["lastFinalRecord"] {
  const record = context[FINAL_STAGE_VERIFICATION_CONTEXT_KEY];
  if (!isRecord(record) || typeof record.status !== "string") return undefined;
  const refusals = Array.isArray(record.bindingRefusals)
    ? record.bindingRefusals.filter((reason): reason is string => typeof reason === "string")
    : [];
  return {
    status: record.status,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(refusals.length > 0 ? { bindingRefusals: refusals } : {}),
    ...(typeof record.reused === "boolean" ? { reused: record.reused } : {}),
  };
}

/**
 * The stage view for one task. Total: an unreadable stored block is reported as
 * such rather than thrown, because the view exists to explain a stuck task.
 */
export function describeStagedVerificationStatus(
  input: DescribeStagedVerificationStatusInput,
): StagedVerificationStatusView {
  const settings = resolveStagedVerificationSettings(input.stagedVerification);
  const context = input.context ?? {};
  const plan = input.plan;
  const validation = validateStagedVerificationState(context[STAGED_VERIFICATION_CONTEXT_KEY]);
  const loopRecovery = readLoopStageRecovery(context);
  const recovery = {
    maxStageRecoveryAttempts: settings.maxStageRecoveryAttempts,
    finalStreak: validation.valid ? (validation.state?.finalRecoveryStreak ?? 0) : 0,
    ...(loopRecovery.readable
      ? {
          loopStreak: loopRecovery.streak,
          ...(loopRecovery.record !== undefined ? { loopLastOutcome: loopRecovery.record.lastOutcome } : {}),
        }
      : { loopUnreadable: true }),
  };
  const planFields = plan !== undefined
    ? { currentPlanDigest: plan.planDigest, requiredChecks: requiredStageChecks(plan).length }
    : {};

  if (!validation.valid) {
    return {
      enabled: settings.enabled,
      // An unreadable block credits nothing: it is never `final-passed`.
      progress: "no-final-evidence",
      meaning: STAGED_VERIFICATION_PROGRESS_MEANING["no-final-evidence"],
      state: "unreadable",
      stateDetail: validation.detail,
      ...planFields,
      loop: [],
      retainedTestFiles: [],
      retainedTestFilesOverflowed: false,
      recovery,
    };
  }

  const state = validation.state;
  const grantingKey = state?.grantingStageRunKey;
  const lastFinalBundle = latestStageBundle(state, "final");
  const lastFinal = lastFinalBundle !== undefined ? bundleView(lastFinalBundle, plan, grantingKey, recordedFinalDispositionOf(context))
    : undefined;
  const lastFinalRecord = lastFinalRecordOf(context);
  const openEntry = pendingStageRunInterruption(state);
  const approval = context[FINAL_STAGE_APPROVAL_CONTEXT_KEY];
  const pendingApprovalHeadSha =
    isRecord(approval) && typeof approval.headSha === "string" ? approval.headSha : undefined;

  let progress: StagedVerificationProgress;
  if (!settings.enabled && state === undefined) {
    progress = "disabled";
  } else if (openEntry !== undefined && openEntry.stageRunId.stage === "final") {
    progress = "final-running";
  } else if (pendingApprovalHeadSha !== undefined) {
    progress = "final-pending";
  } else if (lastFinalRecord?.status === "withheld") {
    // The public record is rewritten by every final run, so a withheld record
    // is newer than any bundle an earlier run left behind.
    progress = "final-withheld";
  } else if (lastFinal === undefined) {
    progress = "no-final-evidence";
  } else if (lastFinal.granting === true && grantingFinalBundle(state) !== undefined) {
    progress = lastFinal.invalidations.includes("plan-digest-changed") ? "final-invalidated" : "final-passed";
  } else {
    progress = "final-withheld";
  }

  return {
    enabled: settings.enabled,
    progress,
    meaning: STAGED_VERIFICATION_PROGRESS_MEANING[progress],
    state: state === undefined ? "absent" : "ok",
    ...planFields,
    loop: (state?.loopBundles ?? []).map((bundle) => bundleView(bundle, plan, grantingKey)),
    ...(lastFinal !== undefined ? { lastFinal } : {}),
    ...(grantingKey !== undefined ? { grantingStageRunKey: grantingKey } : {}),
    ...(lastFinalRecord !== undefined ? { lastFinalRecord } : {}),
    ...(pendingApprovalHeadSha !== undefined ? { pendingApprovalHeadSha } : {}),
    ...(openEntry !== undefined
      ? { openRun: { stageRunKey: stageRunKey(openEntry.stageRunId), allocatedAt: openEntry.allocatedAt } }
      : {}),
    ...(state?.issueBase !== undefined ? { issueBase: { sha: state.issueBase.sha, source: state.issueBase.source } } : {}),
    retainedTestFiles: (state?.retainedTestFiles ?? []).map((entry) => ({ file: entry.file, addedBy: entry.addedBy })),
    retainedTestFilesOverflowed: state?.retainedTestFilesOverflowed === true,
    recovery,
  };
}

/** Whether a task has anything staged to show: an opted-in session or retained state. */
export function hasStagedVerificationSurface(
  stagedVerification: StagedVerificationConfig | undefined,
  context: Record<string, unknown> | undefined,
): boolean {
  return (
    resolveStagedVerificationSettings(stagedVerification).enabled
    || context?.[STAGED_VERIFICATION_CONTEXT_KEY] !== undefined
  );
}
