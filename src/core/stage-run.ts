/**
 * Staged verification: one stage run's aggregate judgment and its evidence
 * bundle (issue #1102 — the rest of `docs/staged-verification-contract.md`
 * §13's S1, and the requirement half of S4).
 *
 * Everything before this module answered a question about *one* thing: what a
 * single command execution proves (#1098), where a bundle goes (#1099), whether
 * an existing bundle may be used (#1100), which checks a run should execute
 * (#1101). This module answers the question about the run as a whole:
 *
 * - {@link aggregateStageOutcome} — §6.1's closed outcome vocabulary and its
 *   precedence, including the accounted-absence table that decides what a
 *   selected check with *no* verdict contributes. This is the piece §7's table
 *   routes on, and the reason it exists as a separate function from the
 *   executor is that every one of its rules is a rule about recorded verdicts,
 *   not about processes.
 * - {@link provenExecutionProjection} and
 *   {@link deriveStageRequirementRecords} — §4.3's proven projection: a
 *   `req:<hex>` slot's verdict for *this run* comes from the shipped
 *   `buildEffectiveRequirementStatus` applied to a plan whose execution layer
 *   is narrowed to the checks this run actually proved green. The shipped
 *   plan-level call keeps its shipped plan-level meaning everywhere else
 *   (§4.3, §10 rule 6); what a stage changes is that call's *input*.
 * - {@link buildStageRunResultInput} — the assembly: selection + execution
 *   records + derived requirement records → the caller-supplied half of
 *   #1099's {@link StageRunResultInput}, with `complete` derived rather than
 *   asserted.
 * - {@link summarizeStageRun} — §10 rule 5's bounded public projection: stage,
 *   check names, verdicts, counts and `selection.full`, and nothing else.
 *
 * Three properties this module is built to keep:
 *
 * 1. **No second classifier.** The per-check verdict is #1098's, derived from
 *    the shipped `classifyVerificationFailure` / `classifyVerificationEnvironmentFailure`
 *    path. Nothing here reads command output, and the one host-versus-change
 *    judgment it consumes ({@link StageCheckOutcome.hostFailure}) is the
 *    caller's reading of those same shipped classifiers — see
 *    {@link stageCheckHostFailure}.
 * 2. **An accounted absence is never evidence loss, and never a pass** (§6.1,
 *    invariant 16). A fail-fast skip routes by the failure that caused it; an
 *    absence nobody accounted for is `interrupted` or `unknown`. Either way the
 *    check is unproven and the bundle is incomplete.
 * 3. **A mandatory requirement is never reported as passed without the evidence
 *    of a check that ran** (invariant 17). The projection is the mechanism, and
 *    it is narrowing-only: it never adds an execution slot, never changes a
 *    slot's bytes or state, and never touches `planDigest`.
 */

import {
  CHECK_NOT_RUN_KINDS,
  deriveCheckCommandDigest,
  isExecutionCheckId,
  type CheckExecutionClassification,
  type CheckExecutionRecord,
  type CheckNotRunKind,
  type CheckVerdict,
} from "./verification-result.js";
import {
  MAX_STAGE_TEXT_CHARS,
  deriveStageBundleCompleteness,
  deriveStageSelectionDigest,
  type StageId,
  type StageOutcome,
  type StageRunId,
  type StageRunResult,
  type StageRunResultInput,
  type StageSelectionRecord,
} from "./staged-verification-state.js";
import {
  buildEffectiveRequirementStatus,
  executionSatisfiesRequirement,
  type EffectiveRequirementEvidenceExpectations,
  type EffectiveVerificationPlan,
  type EffectiveVerificationSlot,
  type FullSuiteRequirementDeclaration,
  type ManualVerificationEvidenceLike,
} from "./verification-plan.js";

// ---------------------------------------------------------------------------
// §6.1 — the stage outcome vocabulary and its precedence
// ---------------------------------------------------------------------------

/**
 * §6.1: "Precedence, first row that matches any selected check wins."
 *
 * Ordered strongest-claim-first, and read in exactly this order: a run with
 * both a lost verdict and a failing check is `unknown`, because the failing
 * check is a fact about the change while the lost verdict is a fact about the
 * run's own integrity, and the second has to be fixed before the first can be
 * trusted.
 */
export const STAGE_OUTCOME_PRECEDENCE = [
  "interrupted",
  "unknown",
  "infrastructure",
  "code-failed",
  "timed-out",
] as const satisfies readonly StageOutcome[];

/**
 * What one selected check contributes to the stage outcome. `none` is the
 * accounted absence that §6.1's table maps to "Nothing": the verdict that
 * *caused* the absence is what decides the row.
 */
export type StageOutcomeContribution = (typeof STAGE_OUTCOME_PRECEDENCE)[number] | "none";

export interface StageCheckOutcome {
  readonly record: CheckExecutionRecord;
  /**
   * True when the shipped #934/#897 classification of this check's own run
   * reads its failure as being about the host or the environment rather than
   * about the change (§6.1's `infrastructure` row).
   *
   * Supplied by the caller because the *classification* is the shipped one and
   * this module must not become a second classifier (§9, "No second classifier
   * exists"). {@link stageCheckHostFailure} is the one derivation over
   * #1098's `CheckExecutionClassification`, so every caller that has one gets
   * the same answer without restating the rule.
   */
  readonly hostFailure?: boolean;
  /**
   * True when the runner had to kill this check and its process-tree cleanup
   * could not confirm the group is gone (issue #1106 — #1096 §4.5 rule 3, §5
   * rule 3): descendants may still be running in the worktree.
   *
   * Such a check has a verdict about the command and none about the run: the
   * worktree now holds a process nobody accounted for, so the check contributes
   * `unknown` — which outranks the `timed-out` or `infrastructure` the same
   * termination would otherwise take — and the run parks or re-runs rather than
   * producing evidence about that worktree. {@link stageCheckTerminationUnconfirmed}
   * is the one derivation over the runner's typed cleanup record.
   */
  readonly terminationUnconfirmed?: boolean;
}

/**
 * The runner's post-kill sweep record, structurally (`ProcessTreeCleanup` in
 * `src/handlers/command-runner.ts`; core never imports `handlers/`).
 */
export interface StageProcessTreeCleanupObservation {
  readonly processTreeCleanup?: {
    readonly processGroupTerminated: boolean;
    readonly processGroupSignalError?: string;
    readonly terminationUnconfirmed?: boolean;
  };
}

/**
 * #1096 §4.5 rule 3: a cleanup "could not confirm termination" exactly when the
 * sweep reports it so — the typed `terminationUnconfirmed` flag, which also
 * covers a Windows `taskkill` that failed or could not be launched (no errno
 * there), or a live POSIX group it was refused permission to signal. An absent
 * record (no kill happened) and `processGroupTerminated: false` with neither
 * (no group was left to signal — the benign case the runner documents) both
 * confirm nothing is left. Typed facts only; no output is read (§5 rule 1).
 */
export function stageCheckTerminationUnconfirmed(run: StageProcessTreeCleanupObservation): boolean {
  const cleanup = run.processTreeCleanup;
  if (cleanup === undefined || cleanup.processGroupTerminated === true) return false;
  return cleanup.terminationUnconfirmed === true
    || (typeof cleanup.processGroupSignalError === "string" && cleanup.processGroupSignalError.length > 0);
}

/**
 * The single rule that turns #1098's classification into §6.1's
 * host-versus-change judgment: either shipped classifier having recognized the
 * failure is what makes it infrastructure.
 *
 * A caller that instead holds the #934 *disposition* may pass its own boolean;
 * this exists so the common case has one implementation rather than one per
 * lane.
 */
export function stageCheckHostFailure(
  classification: Pick<CheckExecutionClassification, "environmentSignal" | "transientSignal">,
): boolean {
  return classification.environmentSignal !== undefined
    || classification.transientSignal !== undefined;
}

export interface StageCheckContribution {
  readonly checkId: string;
  /** `absent` is a selected check with no record at all — never a pass (§6.2 rule 3). */
  readonly verdict: CheckVerdict | "absent";
  readonly notRunKind?: CheckNotRunKind;
  /** The cause as it was *read*, after §6.1's fail-closed admissibility. */
  readonly admittedNotRunKind?: CheckNotRunKind;
  readonly contributes: StageOutcomeContribution;
}

export interface StageOutcomeAggregation {
  readonly outcome: StageOutcome;
  /** One entry per selected check, in selection order. */
  readonly contributions: readonly StageCheckContribution[];
  /**
   * Every selected check this run did not record a `passed` verdict for —
   * §6.3 R6's loop pin set, and §6.3 R2's regression set for a final run.
   */
  readonly unprovenCheckIds: readonly string[];
  /**
   * The selected checks with no admissible verdict at all. §7 rows 5 and 12
   * name exactly these to the operator.
   */
  readonly noVerdictCheckIds: readonly string[];
}

export interface AggregateStageOutcomeInput {
  /** The selection, in executed order. Every id is judged, present or not. */
  readonly selectedCheckIds: readonly string[];
  readonly checks: readonly StageCheckOutcome[];
  /**
   * False when the stage run itself did not finish — a cancellation, a lock
   * loss, a discarded worktree, a host or process loss mid-run. It is what
   * separates §6.1's `interrupted` from its `unknown`: the same lost verdict
   * is an interruption when the run ended early and an integrity failure when
   * it ran to the end.
   */
  readonly runCompleted: boolean;
  /**
   * `req:<hex>` check id → the active execution check ids whose command
   * satisfies it. {@link deriveStageRequirementRecords} produces this beside
   * the records, and {@link buildStageRunResultInput} threads it through.
   *
   * Absent, a `requirement-unproven` cause is inadmissible and reads
   * `evidence-lost`: the cause's whole admissibility condition is a statement
   * about the satisfying check, and a caller that cannot name one has not
   * established it (§6.1, "Fail closed on the cause").
   */
  readonly requirementSatisfiers?: ReadonlyMap<string, readonly string[]>;
}

/**
 * §6.1: aggregate one stage run's verdicts onto one of the six outcomes.
 *
 * The two absences that contribute nothing are admissible only where the run
 * itself already says why:
 *
 * - `first-failure-stop` needs a `failed` or `timed-out` verdict *somewhere in
 *   this run* — the stop it names. A run that skipped checks with nothing to
 *   blame lost evidence and says so.
 * - `requirement-unproven` needs the check to be a `req:<hex>` one whose
 *   satisfying execution check carries a `failed` or `timed-out` verdict *in
 *   this same bundle* (§6.2 rule 6).
 *
 * Anything else with no recorded, admissible cause is `evidence-lost`, which
 * is `interrupted` or `unknown` by {@link AggregateStageOutcomeInput.runCompleted}.
 */
export function aggregateStageOutcome(
  input: AggregateStageOutcomeInput,
): StageOutcomeAggregation {
  const records = new Map(input.checks.map((check) => [check.record.checkId, check]));
  const verdicts = new Map(input.checks.map((check) => [check.record.checkId, check.record.verdict]));
  // The `first-failure-stop` admissibility condition, evaluated once over the
  // whole run rather than per absence: "the same stage run carries at least one
  // `failed` or `timed-out` verdict".
  const runHasBlame = input.checks.some(
    (check) => check.record.verdict === "failed" || check.record.verdict === "timed-out",
  );

  const contributions: StageCheckContribution[] = [];
  const unprovenCheckIds: string[] = [];
  const noVerdictCheckIds: string[] = [];

  for (const checkId of input.selectedCheckIds) {
    const entry = records.get(checkId);
    if (entry === undefined) {
      // §6.2 rule 3: every selected check appears in the bundle. One that does
      // not is an absence with no cause, which is precisely evidence loss.
      contributions.push({
        checkId,
        verdict: "absent",
        admittedNotRunKind: "evidence-lost",
        contributes: input.runCompleted ? "unknown" : "interrupted",
      });
      unprovenCheckIds.push(checkId);
      noVerdictCheckIds.push(checkId);
      continue;
    }
    const record = entry.record;
    if (entry.terminationUnconfirmed === true) {
      // #1096 §4.5 rule 3: whatever the command's own verdict, the run cannot
      // vouch for the worktree it leaves behind. Never a pass, never blame.
      contributions.push({ checkId, verdict: record.verdict, contributes: "unknown" });
      unprovenCheckIds.push(checkId);
      noVerdictCheckIds.push(checkId);
      continue;
    }
    if (record.verdict === "passed") {
      contributions.push({ checkId, verdict: "passed", contributes: "none" });
      continue;
    }
    unprovenCheckIds.push(checkId);
    if (record.verdict === "failed") {
      contributions.push({
        checkId,
        verdict: "failed",
        contributes: entry.hostFailure === true ? "infrastructure" : "code-failed",
      });
      continue;
    }
    if (record.verdict === "timed-out") {
      contributions.push({ checkId, verdict: "timed-out", contributes: "timed-out" });
      continue;
    }
    if (record.verdict === "unknown") {
      // A result the shipped classifier cannot map: the run has a record but no
      // admissible claim in it.
      contributions.push({
        checkId,
        verdict: "unknown",
        contributes: "unknown",
      });
      noVerdictCheckIds.push(checkId);
      continue;
    }
    const admitted = admitNotRunKind(checkId, record.notRunKind, {
      runHasBlame,
      verdicts,
      requirementSatisfiers: input.requirementSatisfiers,
    });
    const contributes = notRunContribution(admitted, input.runCompleted);
    contributions.push({
      checkId,
      verdict: "not-run",
      ...(record.notRunKind !== undefined ? { notRunKind: record.notRunKind } : {}),
      admittedNotRunKind: admitted,
      contributes,
    });
    if (admitted === "evidence-lost") noVerdictCheckIds.push(checkId);
  }

  const present = new Set(contributions.map((contribution) => contribution.contributes));
  const outcome = STAGE_OUTCOME_PRECEDENCE.find((candidate) => present.has(candidate)) ?? "passed";
  return { outcome, contributions, unprovenCheckIds, noVerdictCheckIds };
}

/**
 * §6.1's fail-closed read of a recorded cause: an unrecognized or missing
 * cause, and a cause whose admissibility condition does not hold, are
 * `evidence-lost`.
 */
function admitNotRunKind(
  checkId: string,
  kind: CheckNotRunKind | undefined,
  ctx: {
    readonly runHasBlame: boolean;
    readonly verdicts: ReadonlyMap<string, CheckVerdict>;
    readonly requirementSatisfiers?: ReadonlyMap<string, readonly string[]>;
  },
): CheckNotRunKind {
  if (kind === undefined || !(CHECK_NOT_RUN_KINDS as readonly string[]).includes(kind)) {
    return "evidence-lost";
  }
  if (kind === "first-failure-stop") {
    return ctx.runHasBlame ? kind : "evidence-lost";
  }
  if (kind === "requirement-unproven") {
    // Admissible only on a `req:<hex>` check, and only when the execution check
    // that would satisfy it carries a `failed` or `timed-out` verdict in this
    // same bundle.
    if (isExecutionCheckId(checkId)) return "evidence-lost";
    const satisfiers = ctx.requirementSatisfiers?.get(checkId) ?? [];
    const blamed = satisfiers.some((satisfier) => {
      const verdict = ctx.verdicts.get(satisfier);
      return verdict === "failed" || verdict === "timed-out";
    });
    return blamed ? kind : "evidence-lost";
  }
  return kind;
}

/** §6.1's table: what each admitted cause contributes to the precedence. */
function notRunContribution(
  kind: CheckNotRunKind,
  runCompleted: boolean,
): StageOutcomeContribution {
  switch (kind) {
    case "first-failure-stop":
    case "requirement-unproven":
      return "none";
    case "set-budget-exhausted":
      return "timed-out";
    case "infrastructure-stop":
    case "sandbox-policy-stop":
      return "infrastructure";
    case "cancellation-stop":
      return "interrupted";
    case "evidence-lost":
      return runCompleted ? "unknown" : "interrupted";
  }
}

// ---------------------------------------------------------------------------
// §4.3 — the proven projection and the requirement layer's own verdicts
// ---------------------------------------------------------------------------

/**
 * §4.3: the resolved plan with its execution layer narrowed to exactly the
 * execution slots *this stage run recorded a `passed` verdict for*.
 *
 * Nothing else about the plan changes — retired slots stay retired, requirement
 * bytes stay the slot's current bytes, `planDigest` and `appliedThroughOrdinal`
 * stay the resolved plan's own, and the matching rule is untouched. The result
 * is an *input* to the shipped `buildEffectiveRequirementStatus`, never a plan
 * revision and never a plan an operator surface reports on: the plan-level
 * question keeps its shipped plan-level answer (§10 rule 6).
 */
export function provenExecutionProjection(
  plan: EffectiveVerificationPlan,
  checks: readonly Pick<CheckExecutionRecord, "checkId" | "verdict">[],
): EffectiveVerificationPlan {
  const proven = new Set(
    checks.filter((check) => check.verdict === "passed").map((check) => check.checkId),
  );
  return {
    ...plan,
    execution: plan.execution.filter((slot) => proven.has(slot.commandId)),
  };
}

/**
 * §4.2 step 5's relation, read in the other direction: for each active
 * requirement slot, the active execution slots that satisfy it under
 * {@link executionSatisfiesRequirement} — the shipped
 * `matchesConfiguredVerificationCommand` rule over the slot's own bytes.
 *
 * Every matching slot is listed, selected or not: "an active-but-unselected
 * execution slot leaves the requirement `not-run`" is a case §6.2 rule 6
 * resolves by finding no cause at all for it, which it can only do if the
 * unselected satisfier is visible here.
 *
 * `fullSuite` (issue #1166) is the operator's declared alias for the bound test
 * suite entry, applied through the one shared relation so a requirement the
 * suite discharges names the suite's check as its satisfier — and therefore
 * reports that check's own cause when it did not pass, instead of the
 * `evidence-lost` of a requirement nothing runs.
 */
export function requirementSatisfierMap(
  plan: EffectiveVerificationPlan,
  fullSuite?: FullSuiteRequirementDeclaration,
): ReadonlyMap<string, readonly string[]> {
  const executions = plan.execution.filter((slot) => slot.state === "active");
  const satisfiers = new Map<string, readonly string[]>();
  for (const slot of plan.requirement) {
    if (slot.state !== "active") continue;
    satisfiers.set(
      slot.commandId,
      executions
        .filter((execution) => executionSatisfiesRequirement(execution, slot.command, fullSuite))
        .map((execution) => execution.commandId),
    );
  }
  return satisfiers;
}

export interface StageRequirementDerivationInput {
  /** The plan as resolved for this run — NOT the projection. */
  readonly plan: EffectiveVerificationPlan;
  /** The required `req:<hex>` checks this run covers. */
  readonly selected: readonly { readonly checkId: string }[];
  /** This run's execution-layer records. The only evidence a requirement reads. */
  readonly executionRecords: readonly CheckExecutionRecord[];
  /** #1040 binding admits operator-attested evidence unchanged (§4.3). */
  readonly manualEvidence?: readonly ManualVerificationEvidenceLike[];
  readonly evidenceExpectations?: EffectiveRequirementEvidenceExpectations;
  /** Issue #1166: the operator's declared alias for the bound test suite entry. */
  readonly fullSuite?: FullSuiteRequirementDeclaration;
}

export interface StageRequirementDerivation {
  /** One record per selected requirement check, in the order they were selected. */
  readonly records: readonly CheckExecutionRecord[];
  readonly satisfiers: ReadonlyMap<string, readonly string[]>;
}

/**
 * §6.2 rule 6: derive each selected `req:<hex>` check's verdict from the run's
 * evidence rather than from the plan's shape.
 *
 * `passed` only when §4.3's proven projection makes it so — an execution check
 * this run recorded `passed` for satisfies it, or admissible #1040 manual
 * evidence does. Otherwise `not-run`, with the cause this same bundle already
 * states about the satisfying execution check, in the order the rule fixes:
 *
 * 1. `requirement-unproven` when that check ran and recorded `failed` or
 *    `timed-out`;
 * 2. that check's own `notRunKind` when it too is `not-run`;
 * 3. `evidence-lost` when no such cause was recorded — an unselected
 *    satisfier, a satisfier whose own verdict is `unknown`, or none at all.
 *
 * A retired slot is never selected (it is not in the required set), so nothing
 * here reports one.
 */
export function deriveStageRequirementRecords(
  input: StageRequirementDerivationInput,
): StageRequirementDerivation {
  const satisfiers = requirementSatisfierMap(input.plan, input.fullSuite);
  const projection = provenExecutionProjection(input.plan, input.executionRecords);
  const statuses = new Map(
    buildEffectiveRequirementStatus(
      projection,
      input.manualEvidence,
      input.evidenceExpectations,
      input.fullSuite,
    ).map((status) => [status.commandId, status]),
  );
  const slots = new Map(input.plan.requirement.map((slot) => [slot.commandId, slot]));
  const executionRecords = new Map(
    input.executionRecords.map((record) => [record.checkId, record]),
  );

  const records = input.selected.map((selection): CheckExecutionRecord => {
    const slot = slots.get(selection.checkId);
    const status = statuses.get(selection.checkId);
    const base = {
      checkId: selection.checkId,
      // §6.1 rule 3: a requirement slot has no name of its own.
      commandDigest: deriveCheckCommandDigest(slot?.command ?? selection.checkId),
    };
    if (status?.status === "passed") {
      return { ...base, verdict: "passed" };
    }
    const cause = requirementNotRunCause(
      satisfiers.get(selection.checkId) ?? [],
      executionRecords,
    );
    return {
      ...base,
      verdict: "not-run",
      notRunKind: cause.kind,
      ...(cause.reason !== undefined ? { notRunReason: cause.reason } : {}),
    };
  });

  return { records, satisfiers };
}

function requirementNotRunCause(
  satisfierIds: readonly string[],
  executionRecords: ReadonlyMap<string, CheckExecutionRecord>,
): { readonly kind: CheckNotRunKind; readonly reason?: string } {
  const satisfiers = satisfierIds
    .map((id) => executionRecords.get(id))
    .filter((record): record is CheckExecutionRecord => record !== undefined);
  const blamed = satisfiers.find(
    (record) => record.verdict === "failed" || record.verdict === "timed-out",
  );
  if (blamed !== undefined) {
    return {
      kind: "requirement-unproven",
      reason: boundedStageText(
        `the satisfying check ${blamed.checkId} recorded ${blamed.verdict}`,
      ),
    };
  }
  const skipped = satisfiers.find((record) => record.verdict === "not-run");
  if (skipped !== undefined) {
    return {
      kind: skipped.notRunKind ?? "evidence-lost",
      reason: boundedStageText(
        `the satisfying check ${skipped.checkId} was not run (${skipped.notRunKind ?? "evidence-lost"})`,
      ),
    };
  }
  return {
    kind: "evidence-lost",
    reason: boundedStageText(
      satisfierIds.length === 0
        ? "no active execution check in this plan satisfies this requirement"
        : "no satisfying execution check recorded a verdict in this run",
    ),
  };
}

function boundedStageText(text: string): string {
  return text.length <= MAX_STAGE_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_STAGE_TEXT_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// Assembly — the caller-supplied half of #1099's bundle
// ---------------------------------------------------------------------------

export interface BuildStageRunResultInput {
  readonly stageRunId: StageRunId;
  readonly plan: EffectiveVerificationPlan;
  readonly selection: StageSelectionRecord;
  /** The required checks this run covers, in plan order. */
  readonly selected: readonly { readonly checkId: string }[];
  /** The execution-layer records this run produced, in executed order. */
  readonly executionChecks: readonly StageCheckOutcome[];
  readonly runCompleted: boolean;
  readonly manualEvidence?: readonly ManualVerificationEvidenceLike[];
  readonly evidenceExpectations?: EffectiveRequirementEvidenceExpectations;
  /** Issue #1166: the operator's declared alias for the bound test suite entry. */
  readonly fullSuite?: FullSuiteRequirementDeclaration;
  readonly headSha?: string;
  readonly durationMs?: number;
}

export interface StageRunAssembly {
  /** Exactly what {@link recordStageRun} consumes; the identity is stamped there. */
  readonly bundle: StageRunResultInput;
  readonly aggregation: StageOutcomeAggregation;
  /**
   * §7 row 8's defensive case: the aggregation said `passed` while some
   * selected check has no terminal verdict. Impossible by construction, so its
   * presence is a runner defect — the outcome is forced to `unknown` so the
   * bundle can never claim a completeness its verdicts contradict, and routing
   * takes row 12's operator handoff rather than row 9's repair path.
   */
  readonly integrityDefect?: true;
}

/**
 * Assemble one stage run's bundle: the execution records this run produced, the
 * requirement records §6.2 rule 6 derives from them, the §6.1 outcome over both,
 * and the §6.2 rule 1 completeness derived from the verdicts.
 */
export function buildStageRunResultInput(
  input: BuildStageRunResultInput,
): StageRunAssembly {
  const executionRecords = input.executionChecks.map((check) => check.record);
  const requirementSelections = input.selected.filter(
    (selection) => !isExecutionCheckId(selection.checkId),
  );
  const derivation = deriveStageRequirementRecords({
    plan: input.plan,
    selected: requirementSelections,
    executionRecords,
    ...(input.manualEvidence !== undefined ? { manualEvidence: input.manualEvidence } : {}),
    ...(input.evidenceExpectations !== undefined
      ? { evidenceExpectations: input.evidenceExpectations }
      : {}),
    ...(input.fullSuite !== undefined ? { fullSuite: input.fullSuite } : {}),
  });
  const checks: StageCheckOutcome[] = [
    ...input.executionChecks,
    ...derivation.records.map((record) => ({ record })),
  ];
  const aggregation = aggregateStageOutcome({
    selectedCheckIds: input.selection.checkIds,
    checks,
    runCompleted: input.runCompleted,
    requirementSatisfiers: derivation.satisfiers,
  });
  const records = checks.map((check) => check.record);
  const complete = deriveStageBundleCompleteness(input.selection.checkIds, records);
  const integrityDefect = aggregation.outcome === "passed" && !complete;
  return {
    bundle: {
      stageRunId: input.stageRunId,
      planDigest: input.plan.planDigest,
      ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
      selection: input.selection,
      outcome: integrityDefect ? "unknown" : aggregation.outcome,
      complete,
      checks: records,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    },
    aggregation,
    ...(integrityDefect ? { integrityDefect: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// §10 rule 5 — the bounded public projection
// ---------------------------------------------------------------------------

export interface StageRunSummaryCheck {
  /** The operator-authored name of an `exec:` check; the id for a `req:` one. */
  readonly label: string;
  readonly verdict: CheckVerdict;
  readonly notRunKind?: CheckNotRunKind;
}

export interface StageRunSummary {
  readonly stage: StageId;
  readonly outcome: StageOutcome;
  /** Deliberately public: "verification passed" must say whether that was the whole set. */
  readonly full: boolean;
  readonly complete: boolean;
  readonly counts: {
    readonly selected: number;
    readonly passed: number;
    readonly failed: number;
    readonly timedOut: number;
    readonly notRun: number;
    readonly unknown: number;
  };
  readonly checks: readonly StageRunSummaryCheck[];
}

/**
 * §10 rule 5: the only projection of a bundle that may reach a PR summary, a
 * human-gate summary or a ChatOps acknowledgement — "stage, check names,
 * verdicts, counts, and the `selection.full` flag only".
 *
 * No output bytes, no paths, no command bytes beyond the operator-authored
 * name, and no digests. Building it here rather than at each surface is what
 * makes that posture mechanical instead of a matter of care per call site.
 */
export function summarizeStageRun(
  bundle: Pick<StageRunResult, "stageRunId" | "outcome" | "complete" | "selection" | "checks">,
): StageRunSummary {
  const counts = {
    selected: bundle.selection.checkIds.length,
    passed: bundle.checks.filter((check) => check.verdict === "passed").length,
    failed: bundle.checks.filter((check) => check.verdict === "failed").length,
    timedOut: bundle.checks.filter((check) => check.verdict === "timed-out").length,
    notRun: bundle.checks.filter((check) => check.verdict === "not-run").length,
    unknown: bundle.checks.filter((check) => check.verdict === "unknown").length,
  };
  return {
    stage: bundle.stageRunId.stage,
    outcome: bundle.outcome,
    full: bundle.selection.full,
    complete: bundle.complete,
    counts,
    checks: bundle.checks.map((check): StageRunSummaryCheck => ({
      label: check.name ?? check.checkId,
      verdict: check.verdict,
      ...(check.notRunKind !== undefined ? { notRunKind: check.notRunKind } : {}),
    })),
  };
}

/**
 * The operator-authored names of the checks a bundle recorded a `passed`
 * verdict for, in bundle order.
 *
 * The one thing a "verification ✓" surface may legitimately claim: a check that
 * this run proved green. A surface that instead lists the configured commands
 * reports omitted checks as passed, which §6.2 rule 1 and the §10 rule 5
 * posture both forbid.
 */
export function passedStageCheckNames(
  bundle: Pick<StageRunResult, "checks">,
): readonly string[] {
  return bundle.checks
    .filter((check) => check.verdict === "passed" && check.name !== undefined)
    .map((check) => check.name as string);
}

/** Slots of the required set, keyed by the check id a selection names them with. */
export function requiredSlotsByCheckId(
  plan: EffectiveVerificationPlan,
): ReadonlyMap<string, EffectiveVerificationSlot> {
  const slots = new Map<string, EffectiveVerificationSlot>();
  for (const slot of [...plan.execution, ...plan.requirement]) {
    if (slot.state !== "active") continue;
    slots.set(slot.commandId, slot);
  }
  return slots;
}

// ---------------------------------------------------------------------------
// The required set (issue #1155)
// ---------------------------------------------------------------------------

/**
 * The required set — every `active` slot of the resolved plan, the execution
 * layer first and then the requirement layer, each in plan order. `retired`
 * slots are not in the required set.
 *
 * Relocated here from the deleted `core/stage-selection.ts` (issue #1155): with
 * the group-selection policy retired, this is the whole of what a stage runs,
 * so it belongs beside the assembly that records it rather than behind a
 * selection module that no longer exists.
 */
export function requiredStageChecks(
  plan: EffectiveVerificationPlan,
): readonly EffectiveVerificationSlot[] {
  return [
    ...plan.execution.filter((slot) => slot.state === "active"),
    ...plan.requirement.filter((slot) => slot.state === "active"),
  ];
}

export interface StageCheckSelection {
  readonly checkId: string;
  /** The operator-authored name of an `exec:` check; absent for `req:`. */
  readonly name?: string;
}

/**
 * The checks a stage run covers and the record of that coverage.
 *
 * Issue #1155 retired the five-set union, the `selectable` / `finalOnly`
 * membership and the selection port outright: a stage runs the **entire
 * required set**, deterministically, with nothing consulted and nothing
 * omitted. The only thing that ever leaves it is the bound test suite entry,
 * which the changed-file stages replace
 * (`docs/changed-file-verification-contract.md` §6 rule 2) — and a caller that
 * drops it says so by recording `full: false`.
 */
export interface RequiredStageSelection {
  readonly selection: StageSelectionRecord;
  /** The required checks, in required-set order. */
  readonly checks: readonly StageCheckSelection[];
}

export function requiredStageSelection(plan: EffectiveVerificationPlan): RequiredStageSelection {
  const checks = requiredStageChecks(plan).map((slot): StageCheckSelection => ({
    checkId: slot.commandId,
    ...(slot.name !== undefined ? { name: slot.name } : {}),
  }));
  const checkIds = checks.map((check) => check.checkId);
  return {
    selection: {
      checkIds,
      selectionDigest: deriveStageSelectionDigest(checkIds),
      full: true,
    },
    checks,
  };
}
