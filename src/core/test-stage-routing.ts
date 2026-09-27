/**
 * Changed-file / full-suite verification, routing side (issue #1154,
 * `docs/changed-file-verification-contract.md` §3, §5 and §6 rule 2).
 *
 * #1152 shipped the execution boundary and #1153 the selection, retained set
 * and persisted record. What was left for the lanes is the part this module
 * owns, all of it pure:
 *
 * - **Which test entry is the suite** ({@link resolveTestSuiteSlot}, §6 rules 2
 *   and 5). The operator's binding names a key; the effective plan's active
 *   slot for that key supplies the bytes. A retired or absent slot, or a second
 *   active slot whose command is equivalent to the suite's, refuses the stage
 *   at launch instead of letting a duplicate full run slip into Stage 1.
 * - **Which §3 row a run records** ({@link classifyTestStageResult}). The first
 *   row that applies wins; every run records exactly one row, including a
 *   complete Stage 1 whose selected files are all `skipped`, which is `empty`
 *   (decision D6).
 * - **Where a result routes** ({@link routeStage1TestResult},
 *   {@link routeStage2TestResult}, §5) in the lanes' shipped vocabulary.
 * - **The unconfirmed-termination guard** ({@link openStageRunGuard}, §5 rule 3,
 *   §10.1 D1). The shipped stage-run ledger records no launch or cleanup
 *   evidence, so every started run with no recorded result parks rather than
 *   being superseded and re-run.
 *
 * Nothing here executes, reads a store or decides a grant: the handlers in
 * `src/handlers/test-stage-verification.ts` do the effects, and the stack-ready
 * decision stays in `src/core/final-stage-gate.ts`.
 */

import {
  STAGE1_SELECTION_NOT_READ_UNATTESTED,
  type Stage1ExecutionPlan,
  type TestStageRecord,
  type TestStageResult,
} from "./changed-test-file-selection.js";
import type { VerificationCommands } from "./session.js";
import {
  resolveStagedVerificationSettings,
  type ResolvedTestSuiteBinding,
  type StagedVerificationConfig,
} from "./staged-verification-config.js";
import type { AiTask } from "./task.js";
import type { TestFileRunResult } from "./test-file-execution.js";
import { matchesConfiguredVerificationCommand } from "./tool-request-continuation.js";
import { VERIFICATION_AMENDMENTS_CONTEXT_KEY } from "./verification-amendment.js";
import {
  reconcileVerificationPlan,
  type EffectiveVerificationPlan,
  type EffectiveVerificationSlot,
  type FullSuiteRequirementDeclaration,
} from "./verification-plan.js";
import { boundVerificationOutput } from "./verification-output.js";
import {
  matchIdentityComponent,
  stageRunKey,
  STAGE_IDENTITY_COMPONENTS,
  type StageEvidenceIdentity,
  type StageOutcome,
  type StagedVerificationState,
} from "./staged-verification-state.js";

// ---------------------------------------------------------------------------
// The suite slot (§6 rules 2 and 5)
// ---------------------------------------------------------------------------

export type TestSuiteSlotResolution =
  | {
      readonly status: "bound";
      /** The active execution slot the bound key resolves to. */
      readonly slot: EffectiveVerificationSlot & { readonly name: string };
      /** Every other active execution slot, in plan order: the non-test checks. */
      readonly nonTestSlots: readonly (EffectiveVerificationSlot & { readonly name: string })[];
    }
  | {
      readonly status: "unbound";
      /**
       * `no-active-slot`: the plan holds no active slot for the bound key (absent
       * or retired). `duplicate-suite-command`: another active slot's command is
       * equivalent to the suite's, so the suite to run is ambiguous.
       * `declared-requirement-collision`: another active slot runs a command the
       * operator declared this entry's Issue requirement, so that slot would
       * execute the full suite outside the stages (issue #1166 review, P1).
       */
      readonly reason: "no-active-slot" | "duplicate-suite-command" | "declared-requirement-collision";
      readonly detail: string;
    };

function namedActive(slot: EffectiveVerificationSlot): slot is EffectiveVerificationSlot & { readonly name: string } {
  return slot.state === "active" && slot.name !== undefined;
}

/**
 * The launch-time plan check of §3 R2: the bound key's active slot, or why the
 * stage has no unambiguous suite to run. The duplicate is detected by command
 * under the shipped configured-command equivalence, never by slot identity,
 * and a duplicate slot is never returned as a non-test check.
 *
 * `declaration` (issue #1166 review, P1) is the operator's declared
 * Issue-requirement alias for `boundKey`. `session.verification` is checked for
 * the same collision at load, but that check sees only the STATIC map: an
 * amendment can later add or replace another active execution slot with a
 * declared command — `exec:lint` becoming `npm test` while the bound slot runs
 * `npm run test:files` — and that slot is not a duplicate of the suite's own
 * bytes, so nothing above would catch it. Left admitted it would execute the
 * full suite as a non-test check, before approval in Stage 1 and again beside
 * Stage 2 in the final stage. Rechecking the declaration against the EFFECTIVE
 * plan here routes the collision the same way an ambiguous suite is routed: the
 * stage records `unavailable` (§3 R2) and the colliding slot, like a duplicate,
 * is never returned as a non-test check.
 */
export function resolveTestSuiteSlot(
  plan: EffectiveVerificationPlan,
  boundKey: string,
  declaration?: FullSuiteRequirementDeclaration,
): TestSuiteSlotResolution {
  const active = plan.execution.filter(namedActive);
  const slot = active.find((candidate) => candidate.name === boundKey);
  if (slot === undefined) {
    return {
      status: "unbound",
      reason: "no-active-slot",
      detail: `the effective verification plan holds no active slot for the bound test suite key "${boundKey}"`,
    };
  }
  const duplicates = active.filter(
    (candidate) =>
      candidate.name !== boundKey
      && (matchesConfiguredVerificationCommand(candidate.command, slot.command)
        || matchesConfiguredVerificationCommand(slot.command, candidate.command)),
  );
  if (duplicates.length > 0) {
    return {
      status: "unbound",
      reason: "duplicate-suite-command",
      detail:
        `verification ${duplicates.map((entry) => `"${entry.name}"`).join(", ")} runs the same command as the bound `
        + `test suite "${boundKey}", so the suite to run is ambiguous`,
    };
  }
  const collisions = active.filter(
    (candidate) =>
      candidate.name !== boundKey && declaresBoundTestSuiteCommand(candidate.command, boundKey, declaration),
  );
  if (collisions.length > 0) {
    return {
      status: "unbound",
      reason: "declared-requirement-collision",
      detail:
        `verification ${collisions.map((entry) => `"${entry.name}"`).join(", ")} runs a command declared as the `
        + `Issue requirement of the bound test suite "${boundKey}", so that check would run the full suite outside `
        + "the stages",
    };
  }
  return { status: "bound", slot, nonTestSlots: active.filter((candidate) => candidate.name !== boundKey) };
}

/**
 * Issue #1166 review, P1 (§6 rule 5): does `command` run what the operator
 * declared as the Issue requirement of the bound test suite `boundKey`?
 *
 * The declaration half of {@link resolveTestSuiteSlot}'s collision check,
 * factored out because it holds *without* a suite slot to compare against: an
 * amendment can retire the bound key and, in the same breath, give another
 * active slot a declared command. By the operator's own declaration that slot
 * runs the full suite, so it must stay out of Stage 1 whether or not the bound
 * key still has an active slot to call it a collision with.
 *
 * Only the declaration written for THIS entry applies; a declaration naming
 * another key says nothing about this suite (§6 rule 5, "only to the bound
 * entry"). The match is the shipped configured-command equivalence in both
 * directions — never a guess at alias equivalence.
 */
export function declaresBoundTestSuiteCommand(
  command: string,
  boundKey: string,
  declaration?: FullSuiteRequirementDeclaration,
): boolean {
  if (declaration === undefined || declaration.boundKey !== boundKey) return false;
  return declaration.requirementCommands.some(
    (declared) =>
      matchesConfiguredVerificationCommand(command, declared)
      || matchesConfiguredVerificationCommand(declared, command),
  );
}

/**
 * Issue #1166 (§6 rule 5): one binding's declaration as the plain
 * {@link FullSuiteRequirementDeclaration}, or `undefined` when the operator
 * declared nothing. The single derivation every surface goes through, so the
 * declaration that resolves the suite slot is the declaration a bundle,
 * selection and review gate read.
 */
export function testSuiteRequirementDeclaration(
  binding: Pick<ResolvedTestSuiteBinding, "key" | "requirementCommands">,
): FullSuiteRequirementDeclaration | undefined {
  const requirementCommands = binding.requirementCommands ?? [];
  return requirementCommands.length === 0 ? undefined : { boundKey: binding.key, requirementCommands };
}

/**
 * Issue #1166 (§6 rule 5): the session's declared full-suite requirement alias,
 * or `undefined` when staged verification is off, no suite is bound, or the
 * operator declared nothing.
 *
 * It is the one place a session's staged block becomes the plain
 * {@link FullSuiteRequirementDeclaration} the plan-level relation consumes —
 * through {@link testSuiteRequirementDeclaration}, the single derivation — so
 * every surface that asks "does the bound suite discharge this requirement?"
 * asks it about the same declaration.
 */
export function fullSuiteRequirementDeclaration(session: {
  readonly stagedVerification?: StagedVerificationConfig | undefined;
}): FullSuiteRequirementDeclaration | undefined {
  const settings = resolveStagedVerificationSettings(session.stagedVerification);
  const binding = settings.testSuite;
  if (!settings.enabled || binding === undefined) return undefined;
  return testSuiteRequirementDeclaration(binding);
}

/**
 * §6 rule 2 on the tool-request continuation lane: the bound suite key when a
 * granted Tool Request command runs the bound test suite, else `undefined`.
 *
 * With a suite binding the suite runs only through the stages, so such a
 * command must not execute verbatim before review approval. The match uses the
 * shipped configured-command equivalence in both directions, over the command
 * the stages would run: the bound key's active slot in the task's reconciled
 * effective plan, so an operator `replace` is matched by its new bytes and a
 * superseded or retired command is not the suite. A plan that does not
 * reconcile runs no stage either; the session's configured bytes are matched
 * then, so the suite still cannot run before approval.
 *
 * The Issue-body extractor is injected (the Execution layer owns it), so this
 * Orchestration module keeps no runtime dependency on `src/handlers/`.
 */
export function toolRequestTestSuiteKey(
  session: {
    readonly verification?: VerificationCommands | undefined;
    readonly stagedVerification?: StagedVerificationConfig | undefined;
  },
  task: Pick<AiTask, "context">,
  command: string,
  extractIssueVerificationCommands: (body: string) => readonly string[],
): string | undefined {
  const settings = resolveStagedVerificationSettings(session.stagedVerification);
  const binding = settings.testSuite;
  if (!settings.enabled || binding === undefined) return undefined;
  const ctx = (task.context ?? {}) as Record<string, unknown>;
  const body = typeof ctx.body === "string" ? ctx.body : "";
  const reconciliation = reconcileVerificationPlan({
    sessionVerification: session.verification,
    issueRequirements: body ? extractIssueVerificationCommands(body) : [],
    amendments: ctx[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  });
  let suiteCommands: readonly string[];
  if (reconciliation.status === "invalid" || reconciliation.status === "unreconciled") {
    const configured = session.verification?.[binding.key];
    suiteCommands = typeof configured === "string" ? [configured] : [];
  } else {
    suiteCommands = reconciliation.plan.execution
      .filter((slot) => namedActive(slot) && slot.name === binding.key)
      .map((slot) => slot.command);
  }
  // Issue #1166: a command the operator declared as this entry's Issue
  // requirement IS the full suite by that declaration, so granting it verbatim
  // would be the accidental full run rule 2 forbids. It is consulted only
  // alongside a resolvable suite command — with no suite to run there is no
  // full run for the declaration to describe.
  const candidates = suiteCommands.some((suiteCommand) => suiteCommand.trim() !== "")
    ? [...suiteCommands, ...(binding.requirementCommands ?? [])]
    : suiteCommands;
  return candidates.some(
    (suiteCommand) =>
      suiteCommand.trim() !== ""
      && (matchesConfiguredVerificationCommand(suiteCommand, command)
        || matchesConfiguredVerificationCommand(command, suiteCommand)),
  )
    ? binding.key
    : undefined;
}

// ---------------------------------------------------------------------------
// §3 — one result per run
// ---------------------------------------------------------------------------

/** What the stage could hand to execution. Stage 2 is `execute` or `unavailable`. */
export type TestStagePlanKind = Stage1ExecutionPlan["kind"];

export interface TestStageIdentityAttestation {
  readonly launch: StageEvidenceIdentity;
  /** Re-derived when the run ended. */
  readonly end: StageEvidenceIdentity;
  /** Re-derived inside the recording completion, from the live task and session. */
  readonly recheck: StageEvidenceIdentity;
}

export interface ClassifyTestStageResultInput {
  readonly stage: "loop" | "final";
  readonly plan: TestStagePlanKind;
  /** The assembled run, when the plan was `execute` and the run launched. */
  readonly run?: TestFileRunResult;
  readonly identity: TestStageIdentityAttestation;
  /** The shipped host-failure classification of the run's nonzero exit (§3 R6). */
  readonly hostFailure: boolean;
  /** Stage 2 only: the revision under test is not the approved revision (§3 R5). */
  readonly approvedRevisionDiffers?: boolean;
}

/**
 * Every run classifies. Decision D6 settled §3's last unclassified run — a
 * complete Stage 1 whose selected files are all `skipped` — as `empty`, so the
 * union has one member and no caller has an unclassified branch to route.
 */
export type TestStageClassification = { readonly kind: "result"; readonly result: TestStageResult };

function identityUnattested(identity: StageEvidenceIdentity): boolean {
  return STAGE_IDENTITY_COMPONENTS.some((component) => identity[component]?.state === "unknown");
}

function identityMoved(from: StageEvidenceIdentity, to: StageEvidenceIdentity): boolean {
  return STAGE_IDENTITY_COMPONENTS.some((component) => !matchIdentityComponent(from[component], to[component]));
}

/**
 * §3: the first row that applies wins.
 *
 * R1 (unconfirmed termination) and R2 (an unreadable input or a launch-time
 * plan refusal) come first; then the identity rows R4 and R5, which pre-empt
 * every execution outcome including a nonzero exit — and R3, whose own
 * condition requires both identities attested and unchanged, only after them;
 * then R10 for an empty selection and R6–R13 over the run's facts. A known
 * nonzero process result is `infrastructure` or `failed` whatever the outcome
 * trust; a deadline is `timed-out`; any other untrusted or partial run is
 * `incomplete`.
 *
 * A complete run with no `failed` and no `passed` file closes the table: in
 * Stage 2 it is `no-evidence` (R12), and in Stage 1 — every selected file
 * reached and skipped, so no test ran — it is `empty` (R10, decision D6).
 */
export function classifyTestStageResult(input: ClassifyTestStageResultInput): TestStageClassification {
  const result = (value: TestStageResult): TestStageClassification => ({ kind: "result", result: value });
  const { run } = input;
  if (run?.termination === "unconfirmed") return result("termination-unknown");
  if (input.plan === "unavailable") return result("unavailable");
  const { launch, end, recheck } = input.identity;
  if (identityUnattested(launch) || identityUnattested(end) || identityUnattested(recheck)) {
    return result("identity-unknown");
  }
  if (identityMoved(launch, end) || identityMoved(launch, recheck) || input.approvedRevisionDiffers === true) {
    return result("stale");
  }
  if (input.plan === "retained-unresolved") return result("retained-unresolved");
  if (input.plan === "empty") return result("empty");
  // `execute` with no run: nothing proves what happened, so it never passes.
  if (run === undefined) return result("termination-unknown");
  if (run.processResult === "failed") return result(input.hostFailure ? "infrastructure" : "failed");
  if (run.trust.status === "untrusted") {
    return result(run.trust.reason === "deadline" ? "timed-out" : "incomplete");
  }
  if (run.failedFiles.length > 0) return result("failed");
  if (run.completeness.status !== "complete") return result("incomplete");
  const passed = run.files.filter((entry) => entry.outcome === "passed").length;
  if (passed > 0) return result("passed");
  return result(input.stage === "final" ? "no-evidence" : "empty");
}

// ---------------------------------------------------------------------------
// §5 — routes
// ---------------------------------------------------------------------------

/**
 * Stage 1 routes. `continue`: commit/push, or review. `repair`: the shipped
 * repair and `needs_fix` requeue under the existing cap. `rerun` and
 * `host-retry`: the shipped bounded non-code retry, no agent turn. `park`: the
 * shipped human handoff.
 */
export type Stage1TestRoute = "continue" | "repair" | "rerun" | "host-retry" | "park";

export function routeStage1TestResult(classification: TestStageClassification): Stage1TestRoute {
  switch (classification.result) {
    case "passed":
    case "empty":
      return "continue";
    case "failed":
    case "timed-out":
      return "repair";
    case "incomplete":
    case "unavailable":
    case "identity-unknown":
    case "stale":
      return "rerun";
    case "infrastructure":
      return "host-retry";
    default:
      // `retained-unresolved`, `termination-unknown`, and anything Stage 1 never records.
      return "park";
  }
}

/**
 * Stage 2 routes. `checks`: the full suite passed, so the required non-test
 * checks decide (D3). `review-again`: a `stale` Stage 2 returns through Stage 1
 * and review at the live revision, never re-running Stage 2 at an unapproved
 * one.
 */
export type Stage2TestRoute = "checks" | "repair" | "rerun" | "host-retry" | "review-again" | "park";

export function routeStage2TestResult(classification: TestStageClassification): Stage2TestRoute {
  switch (classification.result) {
    case "passed":
      return "checks";
    case "failed":
    case "timed-out":
      return "repair";
    case "incomplete":
    case "identity-unknown":
      return "rerun";
    case "infrastructure":
      return "host-retry";
    case "stale":
      return "review-again";
    default:
      // `no-evidence`, `unavailable`, `termination-unknown`.
      return "park";
  }
}

/**
 * The shipped loop-stage recovery vocabulary (`decideLoopStageRecovery`) for a
 * Stage 1 route, so the lanes' existing bounded streak counts test-stage
 * non-code results: `rerun` is an interruption and `host-retry` a host failure;
 * a verdict resets the streak.
 */
export function stage1RecoveryOutcome(route: Stage1TestRoute): StageOutcome {
  switch (route) {
    case "rerun":
      return "interrupted";
    case "host-retry":
      return "infrastructure";
    case "repair":
      return "code-failed";
    default:
      return "passed";
  }
}

// ---------------------------------------------------------------------------
// §5 rule 3 — the unconfirmed-termination guard (D1)
// ---------------------------------------------------------------------------

export type OpenStageRunGuard =
  | { readonly kind: "clear" }
  | {
      readonly kind: "park";
      readonly stageRunKey: string;
      readonly allocatedAt: string;
      /**
       * The state with every open allocation closed as `interrupted`, for the
       * parking completion to commit: the operator's requeue after the handoff
       * then launches once instead of parking again on the same allocation.
       */
      readonly closedState: StagedVerificationState;
    };

/**
 * A stage run that was allocated and never recorded a result. The shipped
 * ledger holds no launch or cleanup evidence, so nothing can prove that run
 * launched no process or that its processes ended: it parks instead of being
 * superseded by a new launch (§5 rule 3). A dead worker, a superseded
 * allocation or the absence of a visible process is never that proof.
 */
export function openStageRunGuard(state: StagedVerificationState | undefined, now: string): OpenStageRunGuard {
  const open = state?.runs.find((entry) => entry.state === "allocated");
  if (state === undefined || open === undefined) return { kind: "clear" };
  return {
    kind: "park",
    stageRunKey: stageRunKey(open.stageRunId),
    allocatedAt: open.allocatedAt,
    closedState: {
      ...state,
      runs: state.runs.map((entry) =>
        entry.state === "allocated" ? { ...entry, state: "interrupted" as const, interruptedAt: now } : entry,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Fix input and handoff text
// ---------------------------------------------------------------------------

const MAX_LISTED_FILES = 50;

function listFiles(files: readonly string[]): string {
  const shown = files.slice(0, MAX_LISTED_FILES);
  const rest = files.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` (and ${rest} more)` : ""}`;
}

/**
 * The bounded text a repair turn or a handoff receives for one test-stage
 * record: the stage, the result, the failing files or the suite-level failure,
 * the deadline, and the shipped bounded output tail. It never claims a file
 * passed, and Stage 1 is never described as a suite pass.
 */
export function describeTestStageRecord(record: TestStageRecord, stage: "loop" | "final", suiteKey: string): string {
  const stageName = stage === "loop" ? "Stage 1 (changed and retained test files)" : "Stage 2 (full test suite)";
  const lines = [`${stageName} of '${suiteKey}' recorded \`${record.result}\`.`];
  if (record.selection.status === "known") {
    const advanced = record.selection.issueBase.advancedFrom;
    if (advanced !== undefined) {
      lines.push(
        `The Issue base advanced to the accepted predecessor head ${record.selection.issueBase.sha} `
        + `(it was ${advanced.source} ${advanced.sha}); the predecessor's own test files are no longer this Issue's `
        + "changes, and earlier stage and review evidence no longer applies.",
      );
    }
    const files = record.selection.files.map((entry) => entry.file);
    if (files.length > 0) lines.push(`Selected test files: ${listFiles(files)}.`);
    if (record.selection.unresolvedRetained.length > 0) {
      lines.push(
        `Retained failing test files that are no longer runnable (an unresolved obligation): ${listFiles(record.selection.unresolvedRetained)}.`,
      );
    }
  } else if (record.selection.status === "unavailable" && record.selection.reason === STAGE1_SELECTION_NOT_READ_UNATTESTED) {
    lines.push("The runnable-file report was not read: the launch identity is unattested, so no test tooling was launched.");
  } else if (record.selection.status === "unavailable") {
    lines.push(`The selection is unavailable: ${record.selection.reason}.`);
  }
  // A Stage 1 run with no known selection ran only the suite's setup or discovery.
  const preTestRun = record.selection.status === "unavailable" && record.mode !== undefined;
  if (preTestRun) {
    lines.push("The suite's setup or runnable-file discovery did not succeed, so no selected test file was launched.");
  }
  if (record.failedFiles.length > 0) {
    lines.push(`Failing test files: ${listFiles(record.failedFiles)}${record.failedFilesTruncated === true ? " (truncated)" : ""}.`);
  } else if (record.result === "failed") {
    lines.push(
      preTestRun
        ? "The setup or discovery command exited nonzero (a suite-level failure)."
        : "The test command exited nonzero with no failing test file (a suite-level failure).",
    );
  }
  if (record.result === "empty" && record.mode !== undefined) {
    // Decision D6: reached every selected file and executed none of them.
    lines.push(
      "Every selected test file was reached and skipped, so no test executed. Stage 1 is `empty`: it permits review "
      + "and Stage 2, and it never counts as a suite pass.",
    );
  }
  if (record.trust === "deadline") {
    lines.push("The run exceeded its configured deadline; no file outcome is credited.");
  } else if (record.trust !== undefined && record.trust !== "trusted") {
    lines.push(`File outcomes are untrusted (${record.trust}) and credit nothing.`);
  }
  if (record.outputTail !== undefined) lines.push("", record.outputTail);
  return boundVerificationOutput(lines.join("\n"));
}
